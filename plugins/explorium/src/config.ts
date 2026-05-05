import { ExploriumConfigSchema } from "./configSchema.js";
import type { Log } from "./log.js";
import type { ExploriumConfig } from "./types.js";

export function parseExploriumConfig(value: unknown, log: Log): ExploriumConfig {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = ExploriumConfigSchema.safeParse(input);
  if (result.success) return result.data;

  for (const issue of result.error.issues) {
    log.warn(`config: ${issue.path.join(".") || "(root)"} ${issue.message} — using default`);
  }
  return ExploriumConfigSchema.parse({});
}

export function missingCredential(cfg: ExploriumConfig): string | null {
  if (!cfg.apiKey) return "apiKey (set EXPLORIUM_API_KEY or config.apiKey)";
  return null;
}
