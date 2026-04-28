import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { execFileSync } from "node:child_process";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const CONFIG_DIR = path.join(os.homedir(), ".openclaw");
const CONFIG_PATH = path.join(CONFIG_DIR, "openclaw.json");

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

function getPluginConfig(): { consumerKey?: string; mcpUrl?: string; enabled?: boolean } {
  const config = readConfig();
  const plugins = config.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  const entry = entries?.composio as Record<string, unknown> | undefined;
  const cfg = entry?.config as Record<string, unknown> | undefined;
  return {
    consumerKey: (cfg?.consumerKey as string) || process.env.COMPOSIO_CONSUMER_KEY || undefined,
    mcpUrl: (cfg?.mcpUrl as string) || "https://connect.composio.dev/mcp",
    enabled: (entry?.enabled as boolean) ?? true,
  };
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
        .description("Configure Composio consumer key")
        .option("--key <consumerKey>", "Consumer key (ck_...) — skips interactive prompt")
        .action(async (opts: { key?: string }) => {
          let consumerKey = opts.key?.trim();

          if (!consumerKey) {
            // Interactive mode
            console.log("\nComposio Setup\n");
            console.log("Get your consumer key from: https://dashboard.composio.dev/~/org/connect/clients/openclaw\n");

            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout,
            });

            consumerKey = (await ask(rl, "Enter your consumer key (ck_...): ")).trim();
            rl.close();

            if (!consumerKey) {
              console.log("\nNo key provided. Setup cancelled.");
              return;
            }
          }

          if (!consumerKey.startsWith("ck_")) {
            console.log("\nWarning: Consumer key should start with 'ck_'");
          }

          // Set consumer key
          const config = readConfig();
          if (!config.plugins) config.plugins = {};
          const plugins = config.plugins as Record<string, unknown>;
          if (!plugins.entries) plugins.entries = {};
          const entries = plugins.entries as Record<string, unknown>;
          entries.composio = {
            ...(entries.composio as Record<string, unknown> ?? {}),
            enabled: true,
            config: { consumerKey },
          };

          // Ensure tools.alsoAllow includes composio (safe to create — additive only)
          if (!config.tools) config.tools = {};
          const tools = config.tools as Record<string, unknown>;
          if (!Array.isArray(tools.alsoAllow)) tools.alsoAllow = [];
          const alsoAllow = tools.alsoAllow as string[];
          if (!alsoAllow.includes("composio")) alsoAllow.push("composio");

          writeConfig(config);

          // Use OpenClaw's safe enable path for plugins.allow
          try {
            execFileSync("openclaw", ["plugins", "enable", "composio"], { stdio: "ignore" });
          } catch {}

          // Warn if plugins.allow exists but composio isn't in it
          const updatedConfig = readConfig();
          const updatedPlugins = updatedConfig.plugins as Record<string, unknown> | undefined;
          const pluginsAllow = updatedPlugins?.allow;
          if (Array.isArray(pluginsAllow) && !pluginsAllow.includes("composio")) {
            const fixed = JSON.stringify([...pluginsAllow, "composio"]);
            console.log("\nWarning: plugins.allow is set but does not include 'composio'.");
            console.log("  The plugin will not load until you add it:");
            console.log(`  openclaw config set plugins.allow '${fixed}'`);
          }

          console.log("\nDone. Saved to ~/.openclaw/openclaw.json");
          console.log("  - Consumer key set");
          console.log("  - Plugin enabled");
          console.log("  - Added 'composio' to tools.alsoAllow");
          console.log("\nRestart to apply: openclaw gateway restart\n");
        });

      cmd
        .command("status")
        .description("Show Composio plugin configuration")
        .action(async () => {
          const cfg = getPluginConfig();
          const envKey = process.env.COMPOSIO_CONSUMER_KEY;

          console.log("\nComposio Status\n");

          if (!cfg.consumerKey) {
            console.log("  Consumer key:  not configured");
            console.log("\n  Run: openclaw composio setup\n");
            return;
          }

          const key = cfg.consumerKey;
          const source = envKey ? "environment" : "config";
          const masked = key.length > 12
            ? `${key.slice(0, 6)}...${key.slice(-4)}`
            : `${key.slice(0, 3)}...`;

          console.log(`  Consumer key:  ${masked} (from ${source})`);
          console.log(`  Enabled:       ${cfg.enabled}`);
          console.log(`  MCP URL:       ${cfg.mcpUrl}`);
          console.log("");
        });

      cmd
        .command("doctor")
        .description("Test Composio connection and list available tools")
        .action(async () => {
          const cfg = getPluginConfig();

          console.log("\nComposio Doctor\n");

          if (!cfg.consumerKey) {
            console.log("  Consumer key:  not configured");
            console.log("\n  Run: openclaw composio setup\n");
            return;
          }

          const key = cfg.consumerKey;
          const masked = key.length > 12
            ? `${key.slice(0, 6)}...${key.slice(-4)}`
            : `${key.slice(0, 3)}...`;
          console.log(`  Consumer key:  ${masked}`);
          console.log(`  MCP URL:       ${cfg.mcpUrl}`);

          // Test tool fetch
          console.log("\n  Fetching tools...");
          try {
            const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/list" });
            const raw = execFileSync("curl", [
              cfg.mcpUrl!, "-s", "-X", "POST",
              "-H", "Content-Type: application/json",
              "-H", "Accept: application/json, text/event-stream",
              "-H", `x-consumer-api-key: ${cfg.consumerKey}`,
              "-d", body,
            ], { encoding: "utf-8", timeout: 15_000 });

            let jsonStr = raw;
            const dataMatch = raw.match(/^data:\s*(.+)$/m);
            if (dataMatch) jsonStr = dataMatch[1];

            const parsed = JSON.parse(jsonStr);
            if (parsed.error) {
              console.log(`\n  Connection failed: ${parsed.error.message ?? JSON.stringify(parsed.error)}`);
              console.log("\n  Check your consumer key and try again.\n");
              return;
            }

            const tools = parsed.result?.tools ?? [];
            console.log(`  Found ${tools.length} tools\n`);

            if (tools.length > 0) {
              console.log("  Available tools:");
              for (const tool of tools) {
                const desc = tool.description ? ` — ${tool.description.slice(0, 60)}` : "";
                console.log(`    ${tool.name}${desc}`);
              }
              console.log("");
            }

            console.log("  Status: healthy\n");
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`\n  Connection failed: ${msg}`);
            console.log("\n  Possible causes:");
            console.log("    - Invalid consumer key");
            console.log("    - Network issue reaching connect.composio.dev");
            console.log("    - curl not available on PATH\n");
          }
        });
    },
    { commands: ["composio"] },
  );
}
