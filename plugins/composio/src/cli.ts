import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ComposioConfig } from "./types.js";
import { refreshToolCache } from "./tools.js";

const CONFIG_DIR = path.join(os.homedir(), ".openclaw");
const CONFIG_PATH = path.join(CONFIG_DIR, "openclaw.json");

// Manifest id from openclaw.plugin.json — this is the key OpenClaw's loader uses
// in plugins.allow and plugins.entries (config-state.ts:254 matches against the
// plugin's manifest id, not the npm package name).
const PLUGIN_ID = "copilotai-composio";
// Tool-allowlist key under tools.alsoAllow. Kept distinct from PLUGIN_ID for now
// because existing user configs reference "composio" here and the matching
// semantics for alsoAllow accept either plugin ids or tool names — changing it
// risks breaking working setups. Revisit once we've confirmed the resolution path.
const TOOLS_ALSO_ALLOW_KEY = "composio";

function readConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, unknown>): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

type PluginConfigView = {
  consumerKey?: string;
  apiKey?: string;
  userId?: string;
  mcpUrl: string;
  enabled?: boolean;
};

function getPluginConfig(): PluginConfigView {
  const config = readConfig();
  const plugins = config.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  const entry = entries?.[PLUGIN_ID] as Record<string, unknown> | undefined;
  const cfg = entry?.config as Record<string, unknown> | undefined;
  return {
    consumerKey: (cfg?.consumerKey as string) || process.env.COMPOSIO_CONSUMER_KEY || undefined,
    apiKey: (cfg?.apiKey as string) || process.env.COMPOSIO_API_KEY || undefined,
    userId: (cfg?.userId as string) || process.env.COMPOSIO_USER_ID || undefined,
    mcpUrl: (cfg?.mcpUrl as string) || process.env.COMPOSIO_MCP_URL || "https://connect.composio.dev/mcp",
    enabled: (entry?.enabled as boolean) ?? true,
  };
}

function toComposioConfig(view: PluginConfigView): ComposioConfig {
  return {
    enabled: view.enabled ?? true,
    consumerKey: view.consumerKey ?? "",
    apiKey: view.apiKey ?? "",
    userId: view.userId ?? "",
    mcpUrl: view.mcpUrl,
  };
}

// Console-backed logger that satisfies the subset of OpenClawPluginApi["logger"]
// that refreshToolCache uses. CLI commands run outside the gateway process and
// don't have access to the plugin runtime's logger.
const cliLogger = {
  debug: (msg: string) => { if (process.env.DEBUG) console.error(msg); },
  info: (msg: string) => console.error(msg),
  warn: (msg: string) => console.error(msg),
  error: (msg: string) => console.error(msg),
} as unknown as OpenClawPluginApi["logger"];

function maskKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 6)}...${key.slice(-4)}` : `${key.slice(0, 3)}...`;
}

// Direct equivalent of `openclaw plugins enable <id>`: ensures the plugin appears
// in plugins.allow and that its entries.<id>.enabled flag is true. Implemented
// via JSON edits so the file does not need to spawn subprocesses.
function ensurePluginEnabled(config: Record<string, unknown>, pluginId: string): void {
  if (!config.plugins) config.plugins = {};
  const plugins = config.plugins as Record<string, unknown>;

  if (!Array.isArray(plugins.allow)) plugins.allow = [];
  const allow = plugins.allow as string[];
  if (!allow.includes(pluginId)) allow.push(pluginId);

  if (!plugins.entries) plugins.entries = {};
  const entries = plugins.entries as Record<string, unknown>;
  const existing = (entries[pluginId] as Record<string, unknown>) ?? {};
  entries[pluginId] = { ...existing, enabled: true };
}

// ── Commands ────────────────────────────────────────────────────────

export function registerCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program }: { program: any }) => {
      const cmd = program
        .command("composio")
        .description("Composio third-party tool integration");

      cmd
        .command("setup")
        .description("Configure Composio credentials")
        .option("--key <consumerKey>", "Consumer key (ck_...) — skips interactive prompt")
        .option("--api-key <apiKey>", "API key (ak_...) for per-user sessions")
        .option("--user-id <userId>", "User ID for per-user Composio sessions")
        .action(async (opts: { key?: string; apiKey?: string; userId?: string }) => {
          let consumerKey = opts.key?.trim();
          let apiKey = opts.apiKey?.trim();
          const userId = opts.userId?.trim();

          if (!consumerKey && !apiKey) {
            console.log("\nComposio Setup\n");
            console.log("Choose your credential type:");
            console.log("  1. Consumer key (ck_...) — shared identity via dashboard.composio.dev");
            console.log("  2. API key (ak_...) — per-user sessions via app.composio.dev/developers\n");

            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const choice = (await ask(rl, "Enter 1 or 2: ")).trim();

            if (choice === "2") {
              apiKey = (await ask(rl, "Enter your API key (ak_...): ")).trim();
              rl.close();
              if (!apiKey) {
                console.log("\nNo key provided. Setup cancelled.");
                return;
              }
            } else {
              consumerKey = (await ask(rl, "Enter your consumer key (ck_...): ")).trim();
              rl.close();
              if (!consumerKey) {
                console.log("\nNo key provided. Setup cancelled.");
                return;
              }
            }
          }

          if (consumerKey && !consumerKey.startsWith("ck_")) {
            console.log("\nWarning: Consumer key should start with 'ck_'");
          }
          if (apiKey && !apiKey.startsWith("ak_")) {
            console.log("\nWarning: API key should start with 'ak_'");
          }

          const configData: Record<string, unknown> = {};
          if (consumerKey) configData.consumerKey = consumerKey;
          if (apiKey) configData.apiKey = apiKey;
          if (userId) configData.userId = userId;

          const config = readConfig();
          if (!config.plugins) config.plugins = {};
          const plugins = config.plugins as Record<string, unknown>;
          if (!plugins.entries) plugins.entries = {};
          const entries = plugins.entries as Record<string, unknown>;
          const existing = (entries[PLUGIN_ID] as Record<string, unknown>) ?? {};
          const existingConfig = (existing.config as Record<string, unknown>) ?? {};
          entries[PLUGIN_ID] = {
            ...existing,
            enabled: true,
            config: { ...existingConfig, ...configData },
          };

          if (!config.tools) config.tools = {};
          const tools = config.tools as Record<string, unknown>;
          if (!Array.isArray(tools.alsoAllow)) tools.alsoAllow = [];
          const alsoAllow = tools.alsoAllow as string[];
          if (!alsoAllow.includes(TOOLS_ALSO_ALLOW_KEY)) alsoAllow.push(TOOLS_ALSO_ALLOW_KEY);

          ensurePluginEnabled(config, PLUGIN_ID);
          writeConfig(config);

          console.log("\nDone. Saved to ~/.openclaw/openclaw.json");
          if (consumerKey) console.log("  - Consumer key set");
          if (apiKey) console.log("  - API key set");
          if (userId) console.log("  - User ID set");
          console.log(`  - Plugin "${PLUGIN_ID}" added to plugins.allow`);
          console.log(`  - Plugin "${PLUGIN_ID}" enabled`);
          console.log(`  - Added "${TOOLS_ALSO_ALLOW_KEY}" to tools.alsoAllow`);

          // Pre-warm the tool cache so the first gateway start has tools immediately.
          console.log("\nFetching tool list...");
          const result = await refreshToolCache(toComposioConfig(getPluginConfig()), cliLogger);
          if (result.error) {
            console.log(`  Warning: tool fetch failed (${result.error})`);
            console.log("  Tools will be fetched in the background on gateway start.");
          } else {
            console.log(`  Cached ${result.tools.length} tools`);
          }

          console.log("\nRestart to apply: openclaw gateway restart\n");
        });

      cmd
        .command("status")
        .description("Show Composio plugin configuration")
        .action(async () => {
          const cfg = getPluginConfig();

          console.log("\nComposio Status\n");

          if (!cfg.consumerKey && !cfg.apiKey) {
            console.log("  Credentials:   not configured");
            console.log("\n  Run: openclaw composio setup\n");
            return;
          }

          if (cfg.consumerKey) {
            const source = process.env.COMPOSIO_CONSUMER_KEY ? "environment" : "config";
            console.log(`  Consumer key:  ${maskKey(cfg.consumerKey)} (from ${source})`);
          }
          if (cfg.apiKey) {
            const source = process.env.COMPOSIO_API_KEY ? "environment" : "config";
            console.log(`  API key:       ${maskKey(cfg.apiKey)} (from ${source})`);
          }
          if (cfg.userId) console.log(`  User ID:       ${cfg.userId}`);
          console.log(`  Enabled:       ${cfg.enabled}`);
          console.log(`  MCP URL:       ${cfg.mcpUrl}`);
          console.log("");
        });

      cmd
        .command("doctor")
        .description("Test Composio connection and list available tools")
        .action(async () => {
          const view = getPluginConfig();

          console.log("\nComposio Doctor\n");

          if (!view.consumerKey && !view.apiKey) {
            console.log("  Credentials:   not configured");
            console.log("\n  Run: openclaw composio setup\n");
            return;
          }

          if (view.consumerKey) console.log(`  Consumer key:  ${maskKey(view.consumerKey)}`);
          if (view.apiKey) console.log(`  API key:       ${maskKey(view.apiKey)}`);
          if (view.userId) console.log(`  User ID:       ${view.userId}`);
          console.log(`  MCP URL:       ${view.mcpUrl}`);

          console.log("\n  Fetching tools...");
          const result = await refreshToolCache(toComposioConfig(view), cliLogger);
          if (result.error) {
            console.log(`\n  Connection failed: ${result.error}`);
            console.log("\n  Possible causes:");
            console.log("    - Invalid credentials (consumer key or API key)");
            console.log("    - Network issue reaching connect.composio.dev");
            console.log("    - The MCP server returned an error\n");
            return;
          }

          console.log(`  Found ${result.tools.length} tools (cached for next gateway start)\n`);
          if (result.tools.length > 0) {
            console.log("  Available tools:");
            for (const tool of result.tools) {
              const desc = tool.description ? ` — ${tool.description.slice(0, 60)}` : "";
              console.log(`    ${tool.name}${desc}`);
            }
            console.log("");
          }

          console.log("  Status: healthy\n");
        });

      cmd
        .command("refresh")
        .description("Force a refresh of the tool cache without restarting the gateway")
        .action(async () => {
          const view = getPluginConfig();
          if (!view.consumerKey && !view.apiKey) {
            console.log("\nNot configured. Run: openclaw composio setup\n");
            return;
          }
          console.log("\nRefreshing Composio tool cache...");
          const result = await refreshToolCache(toComposioConfig(view), cliLogger);
          if (result.error) {
            console.log(`  Failed: ${result.error}\n`);
            process.exitCode = 1;
            return;
          }
          console.log(`  Cached ${result.tools.length} tools.`);
          console.log("  The running gateway will pick up new tools on the next agent turn.\n");
        });
    },
    { commands: ["composio"] },
  );
}
