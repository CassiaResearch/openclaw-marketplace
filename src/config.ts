import { z } from "zod";
import type { ComposioConfig } from "./types.js";

export const ComposioConfigSchema = z.object({
  enabled: z.boolean().default(true),
  consumerKey: z.string().default(""),
  apiKey: z.string().default(""),
  userId: z.string().default(""),
  mcpUrl: z.string().default("https://connect.composio.dev/mcp"),
});

export function parseComposioConfig(value: unknown): ComposioConfig {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};

  const configObj = raw.config as Record<string, unknown> | undefined;

  const consumerKey =
    (typeof configObj?.consumerKey === "string" && configObj.consumerKey.trim()) ||
    (typeof raw.consumerKey === "string" && raw.consumerKey.trim()) ||
    process.env.COMPOSIO_CONSUMER_KEY ||
    "";

  const apiKey =
    (typeof configObj?.apiKey === "string" && configObj.apiKey.trim()) ||
    (typeof raw.apiKey === "string" && raw.apiKey.trim()) ||
    process.env.COMPOSIO_API_KEY ||
    "";

  const userId =
    (typeof configObj?.userId === "string" && configObj.userId.trim()) ||
    (typeof raw.userId === "string" && raw.userId.trim()) ||
    process.env.COMPOSIO_USER_ID ||
    "";

  const mcpUrl =
    (typeof configObj?.mcpUrl === "string" && configObj.mcpUrl.trim()) ||
    (typeof raw.mcpUrl === "string" && raw.mcpUrl.trim()) ||
    process.env.COMPOSIO_MCP_URL ||
    "https://connect.composio.dev/mcp";

  return ComposioConfigSchema.parse({ ...raw, consumerKey, apiKey, userId, mcpUrl });
}

export const composioPluginConfigSchema = {
  parse: parseComposioConfig,
  uiHints: {
    enabled: {
      label: "Enable Composio",
      help: "Enable or disable the Composio integration",
    },
    consumerKey: {
      label: "Consumer Key",
      help: "Your Composio consumer key (ck_...) from dashboard.composio.dev/~/org/connect/clients/openclaw",
      sensitive: true,
    },
    apiKey: {
      label: "API Key",
      help: "Your Composio API key (ak_...) from app.composio.dev/developers — enables per-user tool router sessions",
      sensitive: true,
    },
    userId: {
      label: "User ID",
      help: "Optional user ID for per-user Composio sessions (used with API key)",
    },
    mcpUrl: {
      label: "MCP Server URL",
      help: "Composio MCP server URL (default: https://connect.composio.dev/mcp)",
      advanced: true,
    },
  },
};
