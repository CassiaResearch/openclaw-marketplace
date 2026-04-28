import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  composioPluginConfigSchema,
  parseComposioConfig,
} from "./src/config.js";
import { getSharedMcpClient } from "./src/client.js";
import { getCachedTools, refreshToolCache, registerTools } from "./src/tools.js";
import { getSystemPrompt } from "./src/prompt.js";
import { registerCli } from "./src/cli.js";

const composioPlugin = {
  id: "copilotai-composio",
  name: "Composio",
  description:
    "Access 1000+ third-party tools via Composio (Gmail, Slack, GitHub, Notion, and more).",
  configSchema: composioPluginConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = parseComposioConfig(api.pluginConfig);

    registerCli(api);

    if (!config.enabled) {
      api.logger.debug?.("[composio] Plugin disabled");
      return;
    }

    if (!config.consumerKey && !config.apiKey) {
      api.logger.warn(
        "[composio] No credentials configured. Set COMPOSIO_CONSUMER_KEY (ck_...) or COMPOSIO_API_KEY (ak_...) env var, or run 'openclaw composio setup'.",
      );
      return;
    }

    const promptState = { toolCount: 0, connectError: "", ready: false };

    api.on("before_prompt_build", () => ({
      prependSystemContext: getSystemPrompt(promptState),
    }));

    const mcpReady = getSharedMcpClient(config, api.logger);
    const cached = getCachedTools(config, api.logger);
    const registeredNames = new Set<string>();

    registerTools(api, cached.tools, mcpReady, registeredNames);

    promptState.toolCount = cached.tools.length;

    if (cached.tools.length > 0) {
      promptState.ready = true;
      api.logger.info(`[composio] Ready from cache — ${cached.tools.length} tools registered`);
    } else {
      // Stay !ready until the background refresh resolves; the prompt enters
      // its "loading" branch and tells the agent to wait briefly.
      api.logger.info(`[composio] No cached tools — fetching in background; tools will register live without restart`);
    }

    // Fire-and-forget background refresh. register() must be sync (loader.ts:1339
    // ignores any returned Promise), so the work drifts past register's return.
    // When it completes, late api.registerTool() calls push into the same
    // registry.tools[] that resolvePluginTools reads per agent build — so new tools
    // appear on the next agent turn, no gateway restart required.
    refreshToolCache(config, api.logger)
      .then((result) => {
        if (result.error) {
          promptState.connectError = result.error;
          promptState.ready = true;
          return;
        }
        const { newlyRegistered } = registerTools(api, result.tools, mcpReady, registeredNames);
        const liveNames = new Set(result.tools.map((t) => t.name));
        const stale = [...registeredNames].filter((n) => !liveNames.has(n));

        promptState.toolCount = registeredNames.size;
        promptState.connectError = "";
        promptState.ready = true;

        if (newlyRegistered > 0) {
          api.logger.info(
            `[composio] Live-registered ${newlyRegistered} new tools (${registeredNames.size} total active for next agent turn)`,
          );
        }
        if (stale.length > 0) {
          api.logger.warn(
            `[composio] ${stale.length} previously-registered tools are no longer in the upstream catalog; they will fail at call time until next gateway restart`,
          );
        }
      })
      .catch(() => { /* refreshToolCache already logs */ });
  },
};

export default composioPlugin;
