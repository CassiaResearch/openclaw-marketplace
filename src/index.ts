import {
  buildPluginConfigSchema,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { getMcpClient, resetMcpClient } from "./client.js";
import { missingCredential, parseExploriumConfig } from "./config.js";
import { ExploriumConfigSchema } from "./configSchema.js";
import { attachLog } from "./log.js";
import { discoverTools } from "./tools/discover.js";
import { registerDiscoveredTools } from "./tools/register.js";

const PLUGIN_ID = "openclaw-explorium";

const plugin: OpenClawPluginDefinition = {
  id: PLUGIN_ID,
  name: "Explorium",
  description:
    "B2B business and prospect data via Explorium's hosted MCP server. Tools are discovered dynamically.",

  configSchema: buildPluginConfigSchema(ExploriumConfigSchema),

  reload: {
    restartPrefixes: ["apiKey", "mcpUrl", "authHeader", "authValuePrefix", "enabled"],
    hotPrefixes: ["debug"],
  },

  register(api: OpenClawPluginApi): void {
    const cfg = parseExploriumConfig(api.pluginConfig, attachLog(api.logger, false));
    const log = attachLog(api.logger, cfg.debug);

    if (!cfg.enabled) {
      log.debug("plugin disabled");
      return;
    }

    const missing = missingCredential(cfg);
    if (missing) {
      log.warn(`missing ${missing} — Explorium tools will not be registered`);
      return;
    }

    api.registerService({
      id: PLUGIN_ID,
      // The host awaits service.start sequentially during plugin boot
      // (openclaw/dist/services-*.js: `await service.start(ctx)`), so it's
      // the right hook for async tool discovery — register() is sync.
      start: async () => {
        const client = await getMcpClient(cfg, log);
        if (!client) return;
        const tools = await discoverTools(client);
        if (tools.length === 0) {
          log.warn("MCP server returned 0 tools — verify endpoint and credentials");
          return;
        }
        const count = registerDiscoveredTools(api, tools, client, log);
        log.info(`ready — ${count} tools registered from ${cfg.mcpUrl}`);
      },
      stop: async () => {
        await resetMcpClient();
      },
    });
  },
};

export default plugin;
