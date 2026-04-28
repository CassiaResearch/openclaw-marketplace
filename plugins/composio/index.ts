import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { composioPluginConfigSchema, parseComposioConfig } from "./src/config.js";
import { getSharedMcpClient } from "./src/client.js";
import { getCachedTools, registerTools } from "./src/tools.js";
import { getSystemPrompt } from "./src/prompt.js";
import { registerCli } from "./src/cli.js";

const composioPlugin = {
  id: "copilotai-composio",
  name: "Composio",
  description: "Access 1000+ third-party tools via Composio (Gmail, Slack, GitHub, Notion, and more).",
  configSchema: composioPluginConfigSchema,

  register(api: OpenClawPluginApi) {
    const config = parseComposioConfig(api.pluginConfig);

    registerCli(api);

    if (!config.enabled) {
      api.logger.debug?.("[composio] Plugin disabled");
      return;
    }

    if (!config.consumerKey) {
      api.logger.warn(
        "[composio] No consumer key configured. Run 'openclaw composio setup' or set COMPOSIO_CONSUMER_KEY env var."
      );
      return;
    }

    const promptState = { toolCount: 0, connectError: "", ready: false };

    api.on("before_prompt_build", () => ({
      prependSystemContext: getSystemPrompt(promptState),
    }));

    const mcpReady = getSharedMcpClient(config.mcpUrl, config.consumerKey, api.logger);
    const { tools, error } = getCachedTools(config.mcpUrl, config.consumerKey, api.logger);

    if (error) {
      promptState.connectError = error;
      promptState.ready = true;
      api.logger.error(`[composio] Failed to connect: ${error}`);
      return;
    }

    registerTools(api, tools, mcpReady);

    promptState.toolCount = tools.length;
    promptState.ready = true;
    api.logger.info(`[composio] Ready — ${tools.length} tools registered`);
  },
};

export default composioPlugin;
