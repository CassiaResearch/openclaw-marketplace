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

    // Snapshot of the tool names registered synchronously below. Read by
    // cache-refresh.start to diff against the live SDK output (added /
    // removed). Doesn't grow after register() returns.
    const registeredNames = new Set<string>();

    // Synchronous registration from the disk cache. The cache is the sole
    // source of truth: it's pre-seeded by `openclaw composio setup` and
    // refreshed on every gateway start by the cache-refresh service below.
    // Registration must happen inside register() so entries land in
    // registry.tools before the manifest snapshot freezes and the HTTP
    // listener binds. The descriptor cache memoizes factory output on the
    // first session resolution and openclaw exposes no invalidation API,
    // so late registrations from service.start would be silently shadowed.
    const cached = readMetaToolCache(config.baseURL);
    if (cached) {
      for (const tool of cached.tools) {
        registerMetaToolWithDispatch(api, tool, sessionPromise);
        registeredNames.add(tool.name);
      }
      promptState.ready = true;
      promptState.toolCount = cached.tools.length;
      api.logger.info(
        `[composio-plus] Ready — ${cached.tools.length} meta-tools registered from disk cache (age ${Math.round(cached.ageMs / 1000)}s)`,
      );
    } else {
      api.logger.warn(
        "[composio-plus] No disk cache — this gateway run has zero meta-tools. " +
          "Run `openclaw composio setup` to pre-seed the cache, then restart.",
      );
    }

    // Refreshes the disk cache and logs diffs against what's currently
    // registered. Tools added/removed upstream surface on the *next* gateway
    // start, not this one — service.start runs on a setImmediate after the
    // HTTP listener binds (server-startup-post-attach.ts:768), and the
    // descriptor cache is populated from registry.tools on the first session
    // resolution with no plugin-facing invalidation API
    // (tool-descriptor-cache.ts), so any late mutations to registry.tools
    // are silently shadowed. This service therefore never calls
    // registerMetaToolWithDispatch — it only writes to disk and logs.
    api.registerService({
      id: "composio-plus-cache-refresh",
      start: async () => {
        try {
          const { session } = await sessionPromise;
          const fresh = await fetchMetaToolsFromSession(session);
          const freshNames = new Set(fresh.map((t) => t.name));
          const added = fresh
            .filter((t) => !registeredNames.has(t.name))
            .map((t) => t.name);
          const removed = [...registeredNames].filter((n) => !freshNames.has(n));

          writeMetaToolCache(config.baseURL, fresh);

          // Reaching here means the meta-tool surface is healthy. Even if the
          // disk-cache or bundled-default path already set ready=true, refresh
          // confirms it and clears any earlier connectError.
          promptState.ready = true;
          promptState.connectError = "";

          if (added.length > 0) {
            api.logger.warn(
              `[composio-plus] cache-refresh: ${added.length} new meta-tool(s) detected upstream — they will register on next gateway start: ${added.join(", ")}`,
            );
          }
          if (removed.length > 0) {
            api.logger.warn(
              `[composio-plus] cache-refresh: ${removed.length} meta-tool(s) removed upstream but stay registered until next gateway restart (calls may 404): ${removed.join(", ")}`,
            );
          }
          if (added.length === 0 && removed.length === 0) {
            api.logger.debug?.(
              `[composio-plus] cache-refresh: cache up-to-date (${fresh.length} meta-tools, no diff)`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          api.logger.warn(
            `[composio-plus] cache-refresh failed: ${msg} — keeping ${registeredNames.size} registered tool(s) callable`,
          );
          // Mark ready so the prompt switches from "loading" to "errored" — but
          // preserve toolCount if the synchronous registration path already
          // populated it, since those tools are still callable while the
          // refresh is broken.
          promptState.ready = true;
          promptState.connectError = msg;
        }
      },
    });
  },
};

export default composioPlusPlugin;
