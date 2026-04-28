import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { McpClientLike } from "./types.js";
import { mcpClientCache, cacheKey } from "./state.js";

export function getSharedMcpClient(mcpUrl: string, consumerKey: string, logger: OpenClawPluginApi["logger"]): Promise<McpClientLike | null> {
  const key = cacheKey(mcpUrl, consumerKey);
  const existing = mcpClientCache.get(key);
  if (existing) {
    logger.debug?.("[composio] Reusing shared MCP client connection");
    return existing;
  }

  const promise = (async (): Promise<McpClientLike | null> => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const client = new Client({ name: "openclaw", version: "1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: {
          headers: { "x-consumer-api-key": consumerKey },
        },
      })
    );
    logger.debug?.("[composio] MCP client connected");
    return client;
  })().catch((err) => {
    logger.error(`[composio] MCP client connection failed: ${err instanceof Error ? err.message : String(err)}`);
    mcpClientCache.delete(key);
    return null;
  });

  mcpClientCache.set(key, promise);
  return promise;
}
