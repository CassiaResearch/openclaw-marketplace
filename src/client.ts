import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Log } from "./log.js";
import type { ExploriumConfig, McpClientLike } from "./types.js";

let cached: McpClientLike | null = null;

export async function getMcpClient(
  cfg: ExploriumConfig,
  log: Log,
): Promise<McpClientLike | null> {
  if (cached) return cached;

  const client = new Client({ name: "openclaw-explorium", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(cfg.mcpUrl), {
    requestInit: {
      headers: {
        [cfg.authHeader]: `${cfg.authValuePrefix}${cfg.apiKey}`,
      },
    },
  });

  try {
    await client.connect(transport);
    log.debug("MCP client connected");
    cached = client as unknown as McpClientLike;
    return cached;
  } catch (err) {
    log.error(`MCP client connect failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function resetMcpClient(): Promise<void> {
  const c = cached;
  cached = null;
  await c?.close?.();
}
