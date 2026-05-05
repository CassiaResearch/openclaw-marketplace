import { z } from "openclaw/plugin-sdk/zod";

const FlexibleBoolean = z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes") return true;
    if (s === "false" || s === "0" || s === "no") return false;
  }
  return v;
}, z.boolean());

/**
 * Credential field that accepts a plain string, an unresolved SecretRef
 * (host resolves these before the plugin sees them on openclaw >= 2026.4.26 —
 * if one slips through we treat it as missing), or undefined / null. Falls
 * back to the named env var so local dev can use a `.env` file.
 */
function credentialField(envVar: string) {
  const SecretRefShape = z.looseObject({
    source: z.string(),
    provider: z.string(),
    id: z.string(),
  });

  return z
    .union([z.string(), SecretRefShape, z.null(), z.undefined()])
    .optional()
    .transform((v) => {
      if (typeof v === "string") {
        const trimmed = v.trim();
        if (trimmed) return trimmed;
      }
      return process.env[envVar]?.trim() ?? "";
    });
}

export const ExploriumConfigSchema = z.object({
  enabled: FlexibleBoolean.default(true),
  apiKey: credentialField("EXPLORIUM_API_KEY"),
  mcpUrl: z
    .string()
    .trim()
    .min(1)
    .default("https://mcp.explorium.ai/mcp")
    .transform((s) => s.replace(/\/+$/, "")),
  authHeader: z.string().trim().min(1).default("api_key"),
  authValuePrefix: z.string().default(""),
  debug: FlexibleBoolean.default(false),
});
