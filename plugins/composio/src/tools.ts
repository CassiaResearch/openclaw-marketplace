import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ComposioConfig, Tool, McpClientLike } from "./types.js";
import { toolsCache, cacheKey } from "./state.js";
import { getAuthHeaders, getEffectiveMcpUrl } from "./client.js";

const DISK_CACHE_TTL_MS = 86_400_000; // 24h — cache is now the primary source; refresh runs in background.
const FETCH_TIMEOUT_MS = 15_000;

function diskCachePath(config: ComposioConfig): string {
  const hash = createHash("sha256").update(`${config.mcpUrl}\0${config.consumerKey}\0${config.apiKey}\0${config.userId}`).digest("hex").slice(0, 16);
  return join(tmpdir(), `composio-tools-${hash}.json`);
}

function readDiskCache(filePath: string): { tools: Tool[]; fresh: boolean } | null {
  try {
    const stat = statSync(filePath);
    const fresh = Date.now() - stat.mtimeMs <= DISK_CACHE_TTL_MS;
    return { tools: JSON.parse(readFileSync(filePath, "utf-8")) as Tool[], fresh };
  } catch {
    return null;
  }
}

function writeDiskCache(filePath: string, tools: Tool[]): void {
  try { writeFileSync(filePath, JSON.stringify(tools)); } catch {}
}

async function fetchTools(config: ComposioConfig): Promise<Tool[]> {
  const effectiveUrl = getEffectiveMcpUrl(config);
  const authHeaders = getAuthHeaders(config);

  const res = await fetch(effectiveUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...authHeaders,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/list" }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  const raw = await res.text();
  let jsonStr = raw;
  const dataMatch = raw.match(/^data:\s*(.+)$/m);
  if (dataMatch) jsonStr = dataMatch[1]!;

  const parsed = JSON.parse(jsonStr);
  if (parsed.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
  return (parsed.result?.tools ?? []) as Tool[];
}

/**
 * Synchronously read the tools cache (memory → disk). Never makes a network call.
 *
 * The OpenClaw plugin loader requires `register()` to be synchronous (loader.ts:1339
 * ignores any returned Promise), so the live fetch is moved to {@link refreshToolCache}
 * which callers invoke from async contexts (CLI commands, fire-and-forget from register).
 */
export function getCachedTools(config: ComposioConfig, logger: OpenClawPluginApi["logger"]): { tools: Tool[]; error?: string } {
  const key = cacheKey(config.mcpUrl, config.consumerKey, config.apiKey, config.userId);

  const memCached = toolsCache.get(key);
  if (memCached) {
    logger.debug?.(`[composio] Using cached tool list (${memCached.tools.length} tools)`);
    return memCached;
  }

  const filePath = diskCachePath(config);
  const disk = readDiskCache(filePath);
  if (disk && disk.tools.length > 0) {
    const entry = { tools: disk.tools };
    toolsCache.set(key, entry);
    const ageNote = disk.fresh ? "" : " (stale; background refresh will update it)";
    logger.debug?.(`[composio] Using disk-cached tool list (${disk.tools.length} tools)${ageNote}`);
    return entry;
  }

  const entry = {
    tools: [] as Tool[],
    error: "Tool cache is empty. The plugin is fetching tools in the background; they will register live on the next agent turn. Run `openclaw composio doctor` to test the connection if tools never appear.",
  };
  toolsCache.set(key, entry);
  return entry;
}

/**
 * Asynchronously fetch tools from the Composio MCP server and write the result
 * to both the in-memory and on-disk caches. Safe to call from any async context.
 *
 * Returns the fetched tools on success, or an error message on failure. Never throws.
 */
export async function refreshToolCache(
  config: ComposioConfig,
  logger: OpenClawPluginApi["logger"],
): Promise<{ tools: Tool[]; error?: string }> {
  const key = cacheKey(config.mcpUrl, config.consumerKey, config.apiKey, config.userId);
  logger.debug?.(`[composio] Refreshing tool cache from ${config.mcpUrl}`);
  try {
    const tools = await fetchTools(config);
    const entry = { tools };
    toolsCache.set(key, entry);
    writeDiskCache(diskCachePath(config), tools);
    logger.debug?.(`[composio] Tool cache refreshed (${tools.length} tools)`);
    return entry;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error(`[composio] Tool refresh failed: ${error}`);
    const entry = { tools: [] as Tool[], error };
    toolsCache.set(key, entry);
    return entry;
  }
}

/**
 * Register tools with OpenClaw, skipping any whose name is already in `alreadyRegistered`.
 *
 * Safe to call multiple times across the gateway lifetime: the first call (during sync
 * `register()`) installs whatever the disk cache holds; later async calls (after a
 * background refresh) install only newly-discovered names. Late `api.registerTool` calls
 * push onto the same `registry.tools[]` that `resolvePluginTools` reads at use time, so
 * the new tools land in the registry without a gateway restart.
 *
 * IMPORTANT — limitation observed in practice: late-registered tools become visible
 * only to **new agent sessions**. Existing long-lived sessions (e.g. an open Discord
 * conversation) keep their snapshotted tool list and will not pick up tools added
 * after the session was formed, even across gateway restarts of the existing session.
 * Users who need the new tools must start a fresh chat / thread / DM.
 *
 * Caller-owned name tracking lets us cleanly handle dedup *and* compute the
 * "removed upstream" set after a refresh. There is no `unregister` path; tools that
 * Composio has dropped remain in the registry until restart and will fail at call time.
 */
export function registerTools(
  api: OpenClawPluginApi,
  tools: Tool[],
  mcpReady: Promise<McpClientLike | null>,
  alreadyRegistered: Set<string>,
): { newlyRegistered: number } {
  let newlyRegistered = 0;
  for (const tool of tools) {
    if (alreadyRegistered.has(tool.name)) continue;
    alreadyRegistered.add(tool.name);
    newlyRegistered++;
    api.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? "",
      parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,

      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const client = await mcpReady;
        if (!client) {
          return {
            content: [{ type: "text" as const, text: "Error: Composio MCP client failed to connect. Check your credentials and try restarting the gateway." }],
            details: null,
          };
        }

        try {
          const result = await client.callTool({ name: tool.name, arguments: params }) as {
            content?: Array<{ type: string; text?: string }>;
          };

          const text = Array.isArray(result.content)
            ? result.content
                .map((c) => c.type === "text" ? (c.text ?? "") : JSON.stringify(c))
                .join("\n")
            : JSON.stringify(result);

          return {
            content: [{ type: "text" as const, text }],
            details: null,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: `Error calling ${tool.name}: ${msg}` }],
            details: null,
          };
        }
      },
    });
  }
  return { newlyRegistered };
}
