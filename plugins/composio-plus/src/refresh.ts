import type { ComposioSession } from "./session.js";
import type { CachedMetaTool, SessionToolkitInfo } from "./types.js";

// session.toolkits() rejects limit>50 with HTTP 400.
const SESSION_TOOLKITS_PAGE_LIMIT = 50;

type ChatCompletionToolWrapper = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

/**
 * Unwrap the OpenAI ChatCompletionTool envelope session.tools() returns by
 * default. The raw-tool API (`getRawToolRouterMetaTools`) needs a sessionId
 * that v0.8.x doesn't expose, so we unwrap here instead.
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

/**
 * Enumerate this session's allowlist with connection status. The prompt
 * builder partitions by `isActive` into the connected vs not-yet-connected
 * buckets.
 */
export async function fetchSessionToolkits(
  session: ComposioSession,
): Promise<SessionToolkitInfo[]> {
  const items: SessionToolkitInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const response = await session.toolkits({
      limit: SESSION_TOOLKITS_PAGE_LIMIT,
      ...(cursor ? { cursor } : {}),
    });
    for (const item of response.items) {
      items.push({
        slug: item.slug.toLowerCase(),
        name: item.name,
        isActive: item.connection?.isActive === true,
      });
    }
    if (!response.cursor) break;
    cursor = response.cursor;
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}
