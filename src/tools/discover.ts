import type { McpClientLike, McpTool } from "../types.js";

export async function discoverTools(client: {
  listTools(): Promise<{ tools: McpTool[] }>;
}): Promise<McpTool[]> {
  const result = await client.listTools();
  return result.tools ?? [];
}

export type { McpClientLike };
