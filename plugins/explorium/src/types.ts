import type { z } from "openclaw/plugin-sdk/zod";
import type { ExploriumConfigSchema } from "./configSchema.js";

export type ExploriumConfig = z.infer<typeof ExploriumConfigSchema>;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Subset of `@modelcontextprotocol/sdk` Client we use. */
export interface McpClientLike {
  listTools(): Promise<{ tools: McpTool[] }>;
  callTool(args: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<{
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  }>;
  close?(): Promise<void> | void;
}
