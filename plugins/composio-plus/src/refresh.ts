import type { ComposioSession } from "./session.js";
import type { CachedMetaTool } from "./types.js";

type ChatCompletionToolWrapper = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

/**
 * Pull the meta-tool definitions out of a live Composio session and unwrap
 * the OpenAI ChatCompletionTool envelope so the result is registry-ready
 * (`{name, description, inputSchema}`). The session must already exist —
 * callers (currently the cache-refresh service) build it with
 * `buildSessionFromConfig` and pass it in.
 *
 * Composio's default `session.tools()` shape is OpenAI even with no provider
 * configured. `getRawToolRouterMetaTools(sessionId)` would also work but
 * requires a sessionId that v0.8.x doesn't expose.
 */
export async function fetchMetaToolsFromSession(
  session: ComposioSession,
): Promise<CachedMetaTool[]> {
  const wrapped = (await session.tools()) as ChatCompletionToolWrapper[];
  return wrapped.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    inputSchema: t.function.parameters ?? { type: "object", properties: {} },
  }));
}
