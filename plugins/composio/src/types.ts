export interface ComposioConfig {
  enabled: boolean;
  consumerKey: string;
  mcpUrl: string;
}

export type Tool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpClientLike = {
  callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<unknown>;
};
