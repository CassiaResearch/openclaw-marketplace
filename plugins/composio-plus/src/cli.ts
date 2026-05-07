import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/runtime-secret-resolution";
import { parseComposioPlusConfig } from "./config.js";
import { readMetaToolCache, metaToolCachePath, writeMetaToolCache } from "./metaToolCache.js";
import { buildSessionFromConfig } from "./session.js";
import { fetchMetaToolsFromSession } from "./refresh.js";
import type { ComposioPlusConfig } from "./types.js";

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
// reference with a plain string and can pass it to the SDK resolver. Mirrors
// the runtime SecretRef type from openclaw — source is one of three known
// transports and provider is required.
type SecretRefShape = { source: "env" | "file" | "exec"; provider: string; id: string };
function isSecretRef(value: unknown): value is SecretRefShape {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.source !== "env" && obj.source !== "file" && obj.source !== "exec") return false;
  return typeof obj.provider === "string" && typeof obj.id === "string";
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
      // Configures credentials and pre-seeds the meta-tool disk cache.
      // The cache is the sole source of tools at gateway start (register()
      // reads it synchronously); cache-refresh keeps it fresh thereafter.
      // Without a pre-seeded cache, a fresh install boots with zero tools.
      //
      // Three credential paths are supported:
      //   1. Plain config or first-time setup → save creds + seed.
      //   2. Existing secret-ref + no --api-key → don't touch config; resolve
      //      the ref via the plugin SDK and seed using the resolved value.
      //   3. Existing secret-ref + --api-key + --force → overwrite + seed.
      cmd
        .command("setup")
        .description("Configure credentials and pre-seed the meta-tool cache")
        .option("--api-key <apiKey>", "Composio ak_... project key")
        .option("--user-id <userId>", "Per-user Composio identity")
        .option("--no-prompt", "Skip interactive prompts (requires --api-key and --user-id)")
        .option("--force", "Allow overwriting an existing secret reference with a plain string")
        .action(async (opts: { apiKey?: string; userId?: string; prompt?: boolean; force?: boolean }) => {
          const rawEntry = getPluginConfigEntry();
          const existingRef = isSecretRef(rawEntry.apiKey) ? rawEntry.apiKey : null;

          // Refuse to clobber a managed-deploy ref with a plain string unless
          // --force is given. (Only matters when --api-key is also provided.)
          if (existingRef && opts.apiKey && !opts.force) {
            console.log(
              "\nExisting config.apiKey is a secret reference — refusing to overwrite with a plain string.\n" +
                "To re-seed the cache without changing config, omit --api-key.\n" +
                "Pass --force to replace the reference with a plain key (local dev only).\n",
            );
            return;
          }

          let effectiveApiKey: string | undefined;
          let effectiveUserId: string | undefined;
          let saveToConfig = true;

          if (existingRef && !opts.apiKey) {
            // Path 2: managed deploy. Keep the ref in config; resolve it
            // here only to call the SDK for cache seeding. Single ref in,
            // single value out — pull it directly from the result map.
            try {
              const resolved = await resolveSecretRefValues([existingRef], {
                config: api.config,
                env: process.env,
              });
              const [value] = resolved.values();
              if (typeof value !== "string" || !value) {
                const refLabel = `${existingRef.source}:${existingRef.provider}:${existingRef.id}`;
                console.log(`\nFailed to resolve apiKey ref (${refLabel}). Cache not seeded.\n`);
                return;
              }
              effectiveApiKey = value;
            } catch (err) {
              console.log(
                `\nFailed to resolve apiKey ref: ${err instanceof Error ? err.message : String(err)}\n`,
              );
              return;
            }
            effectiveUserId =
              opts.userId?.trim() ||
              (typeof rawEntry.userId === "string" ? rawEntry.userId : undefined) ||
              process.env.COMPOSIO_USER_ID;
            saveToConfig = false;
          } else {
            // Paths 1 & 3: plain string or --force overwrite. Drop the ref
            // before parseConfig (zod schema expects string; would throw).
            const sanitized = existingRef ? { ...rawEntry, apiKey: undefined } : rawEntry;
            const existing = parseComposioPlusConfig(sanitized);
            effectiveApiKey = opts.apiKey?.trim() || existing.apiKey;
            effectiveUserId = opts.userId?.trim() || existing.userId;

            const wantPrompt =
              opts.prompt !== false && (!effectiveApiKey || !effectiveUserId);
            if (wantPrompt) {
              console.log("\nComposio Plus Setup\n");
              const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
              if (!effectiveApiKey) effectiveApiKey = (await ask(rl, "Composio API key (ak_...): ")).trim();
              if (!effectiveUserId) effectiveUserId = (await ask(rl, "User ID (per-user Composio identity): ")).trim();
              rl.close();
            }
          }

          if (!effectiveApiKey || !effectiveUserId) {
            console.log("\nMissing apiKey or userId. Setup cancelled.");
            return;
          }
          if (!effectiveApiKey.startsWith("ak_")) {
            console.log("Warning: API key should start with 'ak_'");
          }

          if (saveToConfig) {
            setPluginConfigEntry({ apiKey: effectiveApiKey, userId: effectiveUserId });
            console.log(`Saved credentials to ${CONFIG_PATH}`);
          } else {
            console.log("Using existing config (apiKey is a secret reference; not modified).");
          }

          // Pre-seed the disk cache. The fetched tool surface reflects
          // the operator's actual toolkits/authConfigs/customTools, so this
          // is more accurate than any baked-in default could be.
          const seedConfig: ComposioPlusConfig = parseComposioPlusConfig({
            ...rawEntry,
            apiKey: effectiveApiKey,
            userId: effectiveUserId,
          });
          try {
            const { session } = await buildSessionFromConfig(seedConfig);
            const tools = await fetchMetaToolsFromSession(session);
            const cachePath = writeMetaToolCache(seedConfig.baseURL, tools);
            console.log(`Pre-seeded ${tools.length} meta-tool(s) → ${cachePath}`);
          } catch (err) {
            console.log(
              `\nCache pre-seed failed: ${err instanceof Error ? err.message : String(err)}\n` +
                "Credentials were saved (if requested) but the cache was not written.\n" +
                "Fix the credentials/network and re-run `openclaw composio setup`.\n",
            );
            return;
          }

          console.log("\nRestart the gateway to load tools: openclaw gateway restart\n");
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
