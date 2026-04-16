import type { PluginConfig } from "./types.js";

function resolveEnvVars(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
}

export function parseConfig(raw: Record<string, unknown> | undefined): PluginConfig {
  const r = raw ?? {};
  const apiKey = resolveEnvVars(r.langsmithApiKey as string | undefined) || process.env.LANGSMITH_API_KEY;

  return {
    langsmithApiKey: apiKey || undefined,
    langsmithEndpoint: (r.langsmithEndpoint as string) || "https://api.smith.langchain.com",
    projectName: (r.projectName as string) || "openclaw",
    traceAgentTurns: r.traceAgentTurns !== false,
    traceToolCalls: r.traceToolCalls !== false,
    batchIntervalMs: Math.max(100, (r.batchIntervalMs as number) || 1000),
    batchMaxSize: Math.max(1, (r.batchMaxSize as number) || 20),
    debug: !!r.debug,
  };
}
