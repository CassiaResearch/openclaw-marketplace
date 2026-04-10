import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ComposioConfig, McpClientLike } from "./types.js";
import { mcpClientCache, cacheKey } from "./state.js";

export function getAuthHeaders(config: ComposioConfig): Record<string, string> {
  if (config.apiKey) {
    return { "x-api-key": config.apiKey };
  }
  return { "x-consumer-api-key": config.consumerKey };
}

export function getEffectiveMcpUrl(config: ComposioConfig): string {
  if (!config.userId) return config.mcpUrl;
  const url = new URL(config.mcpUrl);
  url.searchParams.set("user_id", config.userId);
  return url.toString();
}

export function getSharedMcpClient(config: ComposioConfig, logger: OpenClawPluginApi["logger"]): Promise<McpClientLike | null> {
  const key = cacheKey(config.mcpUrl, config.consumerKey, config.apiKey, config.userId);
  const existing = mcpClientCache.get(key);
  if (existing) {
    logger.debug?.("[composio] Reusing shared MCP client connection");
    return existing;
  }

  const effectiveUrl = getEffectiveMcpUrl(config);
  const headers = getAuthHeaders(config);

  const promise = (async (): Promise<McpClientLike | null> => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    const client = new Client({ name: "openclaw", version: "1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(effectiveUrl), {
        requestInit: { headers },
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
