import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ComposioConfig, Tool, McpClientLike } from "./types.js";
import { toolsCache, cacheKey } from "./state.js";
import { getAuthHeaders, getEffectiveMcpUrl } from "./client.js";

const DISK_CACHE_TTL_MS = 300_000;

function diskCachePath(config: ComposioConfig): string {
  const hash = createHash("sha256").update(`${config.mcpUrl}\0${config.consumerKey}\0${config.apiKey}\0${config.userId}`).digest("hex").slice(0, 16);
  return join(tmpdir(), `composio-tools-${hash}.json`);
}

function readDiskCache(filePath: string): Tool[] | null {
  try {
    const stat = statSync(filePath);
    if (Date.now() - stat.mtimeMs > DISK_CACHE_TTL_MS) return null;
    return JSON.parse(readFileSync(filePath, "utf-8")) as Tool[];
  } catch {
    return null;
  }
}

function writeDiskCache(filePath: string, tools: Tool[]): void {
  try { writeFileSync(filePath, JSON.stringify(tools)); } catch {}
}

function fetchToolsSync(config: ComposioConfig): Tool[] {
  const effectiveUrl = getEffectiveMcpUrl(config);
  const authHeaders = getAuthHeaders(config);
  const headerArgs: string[] = [];
  for (const [key, value] of Object.entries(authHeaders)) {
    headerArgs.push("-H", `${key}: ${value}`);
  }

  const body = JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/list" });
  const raw = execFileSync("curl", [
    effectiveUrl, "-s", "-X", "POST",
    "-H", "Content-Type: application/json",
    "-H", "Accept: application/json, text/event-stream",
    ...headerArgs,
    "-d", body,
  ], { encoding: "utf-8", timeout: 15_000 });

  let jsonStr = raw;
  const dataMatch = raw.match(/^data:\s*(.+)$/m);
  if (dataMatch) jsonStr = dataMatch[1];

  const parsed = JSON.parse(jsonStr);
  if (parsed.error) throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
  return (parsed.result?.tools ?? []) as Tool[];
}

export function getCachedTools(config: ComposioConfig, logger: OpenClawPluginApi["logger"]): { tools: Tool[]; error?: string } {
  const key = cacheKey(config.mcpUrl, config.consumerKey, config.apiKey, config.userId);

  const memCached = toolsCache.get(key);
  if (memCached) {
    logger.debug?.(`[composio] Using cached tool list (${memCached.tools.length} tools)`);
    return memCached;
  }

  const filePath = diskCachePath(config);
  const diskTools = readDiskCache(filePath);
  if (diskTools) {
    const entry = { tools: diskTools };
    toolsCache.set(key, entry);
    logger.debug?.(`[composio] Using disk-cached tool list (${diskTools.length} tools)`);
    return entry;
  }

  logger.debug?.(`[composio] Fetching tools from ${config.mcpUrl}`);
  try {
    const tools = fetchToolsSync(config);
    const entry = { tools };
    toolsCache.set(key, entry);
    writeDiskCache(filePath, tools);
    return entry;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const entry = { tools: [] as Tool[], error };
    toolsCache.set(key, entry);
    return entry;
  }
}

export function registerTools(
  api: OpenClawPluginApi,
  tools: Tool[],
  mcpReady: Promise<McpClientLike | null>,
): void {
  for (const tool of tools) {
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
}
