import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import type { Log } from "../log.js";
import type { McpClientLike, McpTool } from "../types.js";

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: unknown;
  isError?: boolean;
}

function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((c) =>
      c && typeof c === "object" && (c as { type?: string }).type === "text"
        ? ((c as { text?: string }).text ?? "")
        : JSON.stringify(c),
    )
    .join("\n");
}

export function registerDiscoveredTools(
  api: OpenClawPluginApi,
  tools: McpTool[],
  client: McpClientLike,
  log: Log,
): number {
  for (const tool of tools) {
    api.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? "",
      parameters: (tool.inputSchema ?? { type: "object", properties: {} }) as unknown as Record<
        string,
        unknown
      >,

      async execute(_toolCallId: string, params: unknown): Promise<ToolResult> {
        try {
          const result = await client.callTool({
            name: tool.name,
            arguments: (params ?? {}) as Record<string, unknown>,
          });
          return {
            content: [
              {
                type: "text",
                text: wrapExternalContent(flattenContent(result.content), {
                  source: "api",
                  sender: `explorium (${tool.name})`,
                }),
              },
            ],
            details: null,
            isError: result.isError === true ? true : undefined,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(`${tool.name} failed: ${msg}`);
          return {
            content: [{ type: "text", text: `[explorium:${tool.name}] ${msg}` }],
            details: null,
            isError: true,
          };
        }
      },
    } satisfies Parameters<OpenClawPluginApi["registerTool"]>[0]);
  }
  return tools.length;
}
