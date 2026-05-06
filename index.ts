import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseComposioPlusConfig, hasRequiredCredentials } from "./src/config.js";
import { readMetaToolCache, writeMetaToolCache } from "./src/metaToolCache.js";
import { buildSessionFromConfig, type SessionBundle } from "./src/session.js";
import { routeMultiExecute } from "./src/dispatch.js";
import { fetchMetaToolsFromSession } from "./src/refresh.js";
import { registerCli } from "./src/cli.js";
import { getSystemPrompt, type ComposioPlusPromptState } from "./src/prompt.js";
import type { CachedMetaTool } from "./src/types.js";

const COMPOSIO_MULTI_EXECUTE_TOOL = "COMPOSIO_MULTI_EXECUTE_TOOL";

/**
 * Register one meta-tool with openclaw. The execute callback awaits the shared
 * sessionPromise and dispatches to either routeMultiExecute (for the
 * MULTI_EXECUTE_TOOL meta) or session.execute (for the others).
 */
function registerMetaToolWithDispatch(
  api: OpenClawPluginApi,
  tool: CachedMetaTool,
  sessionPromise: Promise<SessionBundle>,
): void {
  api.registerTool({
    name: tool.name,
    label: tool.name,
    description: tool.description ?? "",
    parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,

    async execute(_toolCallId: string, params: Record<string, unknown>) {
      try {
        const { session, localSlugs } = await sessionPromise;

        if (tool.name === COMPOSIO_MULTI_EXECUTE_TOOL) {
          const text = await routeMultiExecute(session, localSlugs, params);
          return { content: [{ type: "text" as const, text }], details: null };
        }

        const result = (await session.execute(tool.name, params)) as {
          data?: unknown;
          error?: string | null;
          logId?: string;
        };
        if (result.error) {
          return {
            content: [{ type: "text" as const, text: `Error: ${result.error}` }],
            details: null,
          };
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.data ?? null) }],
          details: null,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        api.logger.error(`[composio-plus] ${tool.name} failed: ${msg}`);
        return {
          content: [{ type: "text" as const, text: `Error calling ${tool.name}: ${msg}` }],
          details: null,
        };
      }
    },
  });
}

const composioPlusPlugin = {
  id: "composio-plus",
  name: "Composio Plus",
  description:
    "Per-user Composio access via the TS SDK. Exposes the six Composio meta-tools and supports custom tools / toolkits / auth configs.",

  register(api: OpenClawPluginApi) {
    // Register CLI subcommands first so `composio setup` / `composio status`
    // remain usable even when config parsing fails downstream (e.g. an
    // unresolved secret ref in CLI mode where openclaw doesn't dereference).
    registerCli(api);

    const config = parseComposioPlusConfig(api.pluginConfig);

    if (!config.enabled) {
      api.logger.debug?.("[composio-plus] Plugin disabled");
      return;
    }

    // CLI loader runs register() too — without this gate, every
    // `openclaw composio …` invocation builds a session it never uses, and
    // the missing-credentials warning below would log noise every time the
    // user ran a CLI subcommand. CLI subcommands are already registered above.
    if (api.registrationMode !== "full") return;

    // Mutable state shared with the prompt hook below — updated as the
    // cache-fast-path completes and as the cache-refresh service runs.
    // Closure-captured by the on() callback, so subsequent prompt builds see
    // the latest state without re-registering the hook.
    const promptState: ComposioPlusPromptState = {
      ready: false,
      toolCount: 0,
      connectError: "",
    };

    api.on("before_prompt_build", () => ({
      prependSystemContext: getSystemPrompt(promptState),
    }));

    if (!hasRequiredCredentials(config)) {
      // apiKey is empty either because nothing is set or because a configured
      // secret reference resolved to empty (e.g. env var not exported into
      // the gateway's environment). Don't prescribe `composio setup` here —
      // on managed deploys that would clobber the ref.
      api.logger.warn(
        "[composio-plus] apiKey or userId is missing or unresolved. " +
          "On local dev: run 'openclaw composio setup'. " +
          "On managed deploys: verify the secret reference resolves at gateway startup.",
      );
      promptState.ready = true;
      promptState.connectError = "apiKey or userId is missing or unresolved";
      return;
    }

    // sessionPromise is built once and reused by:
    //   1. each registered tool's execute() (for live dispatch)
    //   2. the cache-refresh service (avoids a second composio.create call)
    const sessionPromise: Promise<SessionBundle> = buildSessionFromConfig(config, api.logger).catch(
      (err) => {
        api.logger.error(
          `[composio-plus] Session warmup failed: ${err instanceof Error ? err.message : String(err)}. Tool calls will retry on demand.`,
        );
        throw err;
      },
    );

    // Track names already registered, shared between the cache-fast-path and
    // service.start's late-registration. Both run in the same JS process, so
    // this Set is the source of truth for "is this tool already in the
    // openclaw registry."
    const registeredNames = new Set<string>();

    const cached = readMetaToolCache(config.baseURL);
    if (cached) {
      api.logger.info(
        `[composio-plus] Loading ${cached.tools.length} meta-tools from cache (age ${Math.round(cached.ageMs / 1000)}s)`,
      );
      for (const tool of cached.tools) {
        registerMetaToolWithDispatch(api, tool, sessionPromise);
        registeredNames.add(tool.name);
      }
      promptState.ready = true;
      promptState.toolCount = cached.tools.length;
      api.logger.info(`[composio-plus] Ready — ${cached.tools.length} meta-tools registered (cache fast-path)`);
    } else {
      api.logger.info(
        "[composio-plus] No cache yet — meta-tools will register via the cache-refresh service before the gateway accepts agent turns",
      );
    }

    // Cache-refresh service. Awaited by the gateway during boot
    // (`await startPluginServices(...)` in server-startup-post-attach.ts), so
    // any tools we late-register here ARE visible to the first agent turn.
    //
    //  - Cache hit: late-registers any meta-tools added upstream that aren't
    //    in our cache yet; logs warn about removed ones (no unregister API).
    //  - Cache miss (first run): registers all meta-tools fresh.
    //  - On error: keeps whatever's currently registered, doesn't overwrite
    //    cache (next gateway start retries from the last-known-good state).
    api.registerService({
      id: "composio-plus-cache-refresh",
      start: async () => {
        try {
          const { session } = await sessionPromise;
          const fresh = await fetchMetaToolsFromSession(session);

          let lateRegistered = 0;
          for (const tool of fresh) {
            if (registeredNames.has(tool.name)) continue;
            registerMetaToolWithDispatch(api, tool, sessionPromise);
            registeredNames.add(tool.name);
            lateRegistered++;
          }

          const freshNames = new Set(fresh.map((t) => t.name));
          const stale = [...registeredNames].filter((n) => !freshNames.has(n));

          writeMetaToolCache(config.baseURL, fresh);

          // Reaching here means the meta-tool surface is healthy. Even if the
          // cache fast-path already set ready=true, refresh confirms it and
          // clears any earlier connectError set by a previous failed start.
          promptState.ready = true;
          promptState.toolCount = registeredNames.size;
          promptState.connectError = "";

          if (lateRegistered > 0) {
            api.logger.info(
              `[composio-plus] cache-refresh: late-registered ${lateRegistered} meta-tool(s) (${registeredNames.size} total active)`,
            );
          } else {
            api.logger.debug?.(
              `[composio-plus] cache-refresh: cache up-to-date (${fresh.length} meta-tools, no diff)`,
            );
          }
          if (stale.length > 0) {
            api.logger.warn(
              `[composio-plus] cache-refresh: ${stale.length} meta-tool(s) removed upstream but stay registered until next gateway restart: ${stale.join(", ")}`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          api.logger.warn(
            `[composio-plus] cache-refresh failed: ${msg} — keeping ${registeredNames.size} cached tool(s) registered`,
          );
          // Mark ready so the prompt switches from "loading" to "errored" — but
          // preserve toolCount if the cache fast-path already populated it,
          // since those tools are still callable while the refresh is broken.
          promptState.ready = true;
          promptState.connectError = msg;
        }
      },
    });
  },
};

export default composioPlusPlugin;
