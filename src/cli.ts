import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseComposioPlusConfig } from "./config.js";
import { readMetaToolCache, metaToolCachePath } from "./metaToolCache.js";

const PLUGIN_ID = "composio-plus";
const TOOLS_ALSO_ALLOW_KEY = "composio-plus";
const META_TOOL_NAMES = [
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_REMOTE_WORKBENCH",
  "COMPOSIO_REMOTE_BASH_TOOL",
];

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
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, resolve));
}

function maskKey(k: string): string {
  return k.length > 12 ? `${k.slice(0, 6)}...${k.slice(-4)}` : `${k.slice(0, 3)}...`;
}

function getPluginConfigEntry(): Record<string, unknown> {
  const config = readConfig();
  const plugins = config.plugins as Record<string, unknown> | undefined;
  const entries = plugins?.entries as Record<string, unknown> | undefined;
  const entry = entries?.[PLUGIN_ID] as Record<string, unknown> | undefined;
  return (entry?.config as Record<string, unknown> | undefined) ?? {};
}

// Detect openclaw secret-reference shape so setup can refuse to overwrite a
// reference with a plain string. The runtime in `register()` always sees a
// resolved string (openclaw dereferences before plugin load), so this only
// matters for CLI commands that read the config file directly.
function isSecretRef(value: unknown): value is { source: string; provider?: string; id: string } {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.source === "string" && typeof obj.id === "string";
}

function setPluginConfigEntry(updates: Record<string, unknown>): void {
  const config = readConfig();
  if (!config.plugins) config.plugins = {};
  const plugins = config.plugins as Record<string, unknown>;
  if (!Array.isArray(plugins.allow)) plugins.allow = [];
  const allow = plugins.allow as string[];
  if (!allow.includes(PLUGIN_ID)) allow.push(PLUGIN_ID);

  if (!plugins.entries) plugins.entries = {};
  const entries = plugins.entries as Record<string, unknown>;
  const existing = (entries[PLUGIN_ID] as Record<string, unknown>) ?? {};
  const existingConfig = (existing.config as Record<string, unknown>) ?? {};
  entries[PLUGIN_ID] = {
    ...existing,
    enabled: true,
    config: { ...existingConfig, ...updates },
  };

  if (!config.tools) config.tools = {};
  const tools = config.tools as Record<string, unknown>;
  if (!Array.isArray(tools.alsoAllow)) tools.alsoAllow = [];
  const alsoAllow = tools.alsoAllow as string[];
  for (const meta of [...META_TOOL_NAMES, TOOLS_ALSO_ALLOW_KEY]) {
    if (!alsoAllow.includes(meta)) alsoAllow.push(meta);
  }

  writeConfig(config);
}

export function registerCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program }: { program: any }) => {
      const cmd = program
        .command("composio")
        .description("Composio Plus — per-user Composio access via TS SDK");

      // ── setup ─────────────────────────────────────────────────────
      // Saves credentials to plugin config. The plugin's cache-refresh
      // service handles tool registration & cache priming on every gateway
      // start — setup does NOT touch the cache.
      cmd
        .command("setup")
        .description("Configure credentials in plugin config (local dev)")
        .option("--api-key <apiKey>", "Composio ak_... project key")
        .option("--user-id <userId>", "Per-user Composio identity")
        .option("--no-prompt", "Skip interactive prompts (requires --api-key and --user-id)")
        .option("--force", "Allow overwriting an existing secret reference with a plain string")
        .action(async (opts: { apiKey?: string; userId?: string; prompt?: boolean; force?: boolean }) => {
          const rawEntry = getPluginConfigEntry();

          // On managed deploys, apiKey is a {source, provider, id} reference
          // resolved by openclaw at gateway startup. Refuse to clobber it with
          // a plain string unless --force is given.
          if (isSecretRef(rawEntry.apiKey) && !opts.force) {
            console.log(
              "\nExisting config.apiKey is a secret reference — refusing to overwrite with a plain string.\n" +
                "On managed deploys, edit ~/.openclaw/openclaw.json directly.\n" +
                "Pass --force to replace the reference with a plain key (local dev only).\n",
            );
            return;
          }

          // If --force was given over a ref, drop it before parseConfig (the
          // zod schema in src/config.ts expects apiKey: string, would throw).
          const sanitized = isSecretRef(rawEntry.apiKey)
            ? { ...rawEntry, apiKey: undefined }
            : rawEntry;
          const existing = parseComposioPlusConfig(sanitized);
          let apiKey = opts.apiKey?.trim() || existing.apiKey;
          let userId = opts.userId?.trim() || existing.userId;
          const wantPrompt = opts.prompt !== false && (!apiKey || !userId);

          if (wantPrompt) {
            console.log("\nComposio Plus Setup\n");
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            if (!apiKey) apiKey = (await ask(rl, "Composio API key (ak_...): ")).trim();
            if (!userId) userId = (await ask(rl, "User ID (per-user Composio identity): ")).trim();
            rl.close();
          }

          if (!apiKey || !userId) {
            console.log("\nMissing apiKey or userId. Setup cancelled.");
            return;
          }
          if (!apiKey.startsWith("ak_")) {
            console.log("Warning: API key should start with 'ak_'");
          }

          setPluginConfigEntry({ apiKey, userId });
          console.log(`Saved credentials to ${CONFIG_PATH}`);
          console.log("\nRestart the gateway to load tools: openclaw gateway restart");
          console.log(
            "(The cache-refresh service fetches the meta-tool surface on every gateway start.)\n",
          );
        });

      // ── status ────────────────────────────────────────────────────
      cmd
        .command("status")
        .description("Show plugin configuration and cache state")
        .action(() => {
          const rawEntry = getPluginConfigEntry();
          const apiKeyRef = isSecretRef(rawEntry.apiKey) ? rawEntry.apiKey : null;

          // Strip any ref before parsing so the zod schema (apiKey: string)
          // doesn't throw on a managed-deploy config. The resolved key only
          // exists at gateway runtime; the CLI sees the raw file.
          const sanitized = apiKeyRef ? { ...rawEntry, apiKey: undefined } : rawEntry;
          const config = parseComposioPlusConfig(sanitized);

          console.log("\nComposio Plus Status\n");
          console.log(`  Enabled:        ${config.enabled}`);
          if (apiKeyRef) {
            const provider = apiKeyRef.provider ?? "(default)";
            console.log(`  API key:        <secret ref: ${apiKeyRef.source}/${provider}/${apiKeyRef.id}>`);
          } else {
            console.log(`  API key:        ${config.apiKey ? maskKey(config.apiKey) : "(not set)"}`);
          }
          console.log(`  User ID:        ${config.userId || "(not set)"}`);
          console.log(`  Base URL:       ${config.baseURL}`);
          console.log(`  Toolkits:       ${config.toolkits.length === 0 ? "(none)" : config.toolkits.join(", ")}`);
          const authBindings = Object.entries(config.authConfigs);
          if (authBindings.length === 0) {
            console.log(`  Auth configs:   (none)`);
          } else {
            console.log(`  Auth configs:   ${authBindings.length}`);
            for (const [toolkit, id] of authBindings) {
              console.log(`    ${toolkit} → ${id}`);
            }
          }

          const cached = readMetaToolCache(config.baseURL);
          if (!cached) {
            console.log(`  Meta-tool cache: NOT PRIMED — first gateway start populates it`);
            console.log(`  Cache path:     ${metaToolCachePath(config.baseURL)}`);
          } else {
            const ageS = Math.round(cached.ageMs / 1000);
            console.log(`  Meta-tool cache: ${cached.tools.length} tools (age ${ageS}s)`);
            console.log(`  Cache path:     ${metaToolCachePath(config.baseURL)}`);
          }
          console.log("");
        });
    },
    { commands: ["composio"] },
  );
}
