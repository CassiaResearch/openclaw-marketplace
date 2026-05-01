import { z } from "zod";
import type { ComposioPlusConfig } from "./types.js";

// openclaw resolves secret refs ({source, provider?, id}) before plugin load
// in gateway mode, but NOT in CLI mode. Accept both shapes so register() can
// run in CLI mode without the zod parse blowing up; CLI subcommands inspect
// the raw entry directly when they need to detect a ref.
const secretRefSchema = z
  .object({
    source: z.string(),
    provider: z.string().optional(),
    id: z.string(),
  })
  .passthrough();

export const composioPlusConfigSchema = z.object({
  enabled: z.boolean().optional(),
  apiKey: z.union([z.string(), secretRefSchema]).optional(),
  userId: z.string().optional(),
  baseURL: z.string().optional(),
  toolkits: z.array(z.string()).optional(),
  authConfigs: z.record(z.string()).optional(),
});

export function parseComposioPlusConfig(
  pluginConfig: Record<string, unknown> | undefined,
): ComposioPlusConfig {
  const raw = composioPlusConfigSchema.parse(pluginConfig ?? {});

  // If apiKey is still a ref object, the resolver hasn't run (CLI mode).
  // Surface "" so hasRequiredCredentials() reports missing and register()
  // bails cleanly without trying to build a session.
  let apiKey: string;
  if (typeof raw.apiKey === "string") {
    apiKey = raw.apiKey;
  } else if (raw.apiKey === undefined) {
    apiKey = process.env.COMPOSIO_API_KEY ?? "";
  } else {
    apiKey = "";
  }

  // Lowercase toolkit keys for consistent lookup; ac_... ids stay as-is.
  const authConfigs: Record<string, string> = {};
  for (const [toolkit, id] of Object.entries(raw.authConfigs ?? {})) {
    authConfigs[toolkit.toLowerCase()] = id;
  }
  return {
    enabled: raw.enabled ?? true,
    apiKey,
    userId: raw.userId ?? process.env.COMPOSIO_USER_ID ?? "",
    baseURL: raw.baseURL ?? process.env.COMPOSIO_BASE_URL ?? "https://backend.composio.dev",
    toolkits: raw.toolkits ?? [],
    authConfigs,
  };
}

export function hasRequiredCredentials(config: ComposioPlusConfig): boolean {
  return Boolean(config.apiKey) && Boolean(config.userId);
}
