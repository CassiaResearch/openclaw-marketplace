import type { ComposioSession } from "./session.js";

type ToolItem = { tool_slug?: string; arguments?: Record<string, unknown> };
type SessionExecuteResult = {
  data?: unknown;
  error?: string | null;
  successful?: boolean;
  logId?: string;
};

type ResultEntry = {
  index: number;
  tool_slug: string;
  response: { successful: boolean; data: unknown; error?: string };
  error?: string;
};

/**
 * Replicates Composio's `routeMultiExecute` for the openclaw direct-dispatch
 * path: splits the tools[] array into local custom tools and remote catalog
 * tools, runs locals in parallel via session.execute(slug, args), sends
 * remotes as ONE batched COMPOSIO_MULTI_EXECUTE_TOOL call, and merges results
 * preserving the original order.
 *
 * Why we need this: the SDK's `routeMultiExecute` only fires when wrapped
 * tools are dispatched through an agentic provider (Vercel AI SDK / LangChain).
 * Calling `session.execute("COMPOSIO_MULTI_EXECUTE_TOOL", ...)` directly skips
 * routing — Composio's backend rejects local custom-tool slugs with
 * "cannot be executed remotely". This helper does the splitting on our side.
 */
export async function routeMultiExecute(
  session: ComposioSession,
  localSlugs: Set<string>,
  params: Record<string, unknown>,
): Promise<string> {
  const items = Array.isArray(params.tools) ? (params.tools as ToolItem[]) : [];
  if (items.length === 0) {
    // Nothing to split; pass through to backend.
    const result = (await session.execute(
      "COMPOSIO_MULTI_EXECUTE_TOOL",
      params,
    )) as SessionExecuteResult;
    return JSON.stringify({
      data: result.data ?? null,
      successful: result.successful ?? !result.error,
      ...(result.error ? { error: result.error } : {}),
    });
  }

  const localBuckets: Array<{ index: number; slug: string; args: Record<string, unknown> }> = [];
  const remoteBuckets: Array<{ index: number; raw: ToolItem }> = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const slug = String(item.tool_slug ?? "");
    if (slug && localSlugs.has(slug.toUpperCase())) {
      localBuckets.push({ index: i, slug, args: item.arguments ?? {} });
    } else {
      remoteBuckets.push({ index: i, raw: item });
    }
  }

  const localPromise = Promise.all(
    localBuckets.map(async (b) => {
      try {
        const r = (await session.execute(b.slug, b.args)) as SessionExecuteResult;
        return { ...b, result: r };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ...b, errorMessage: msg };
      }
    }),
  );

  let remotePromise: Promise<unknown> | null = null;
  if (remoteBuckets.length > 0) {
    const remoteParams = { ...params, tools: remoteBuckets.map((b) => b.raw) };
    remotePromise = session.execute("COMPOSIO_MULTI_EXECUTE_TOOL", remoteParams);
  }

  const [localResults, remoteRaw] = await Promise.all([localPromise, remotePromise]);

  const merged: ResultEntry[] = new Array(items.length);

  for (const lr of localResults) {
    if ("errorMessage" in lr) {
      merged[lr.index] = {
        index: lr.index,
        tool_slug: lr.slug,
        response: { successful: false, data: null, error: lr.errorMessage },
        error: lr.errorMessage,
      };
      continue;
    }
    const r = lr.result;
    const successful = r.successful ?? !r.error;
    const errorString = r.error ?? undefined;
    merged[lr.index] = {
      index: lr.index,
      tool_slug: lr.slug,
      response: {
        successful,
        data: r.data ?? null,
        ...(errorString ? { error: errorString } : {}),
      },
      ...(errorString ? { error: errorString } : {}),
    };
  }

  if (remoteRaw && remoteBuckets.length > 0) {
    const rr = remoteRaw as { data?: { results?: unknown[] } };
    const remoteResults = Array.isArray(rr.data?.results) ? rr.data.results : [];
    for (let i = 0; i < remoteResults.length; i++) {
      const originalIndex = remoteBuckets[i]?.index;
      if (typeof originalIndex === "number") {
        merged[originalIndex] = remoteResults[i] as ResultEntry;
      }
    }
  }

  // Renumber indices so they're 0..N-1 in the merged output (matches SDK).
  const finalResults = merged.map((entry, i) => ({ ...entry, index: i }));
  const errorCount = finalResults.filter((r) => r.error).length;

  return JSON.stringify({
    data: {
      results: finalResults,
      total_count: finalResults.length,
      success_count: finalResults.length - errorCount,
      error_count: errorCount,
    },
    successful: errorCount === 0,
    ...(errorCount > 0
      ? { error: errorCount + " out of " + finalResults.length + " tools failed" }
      : {}),
  });
}
