import { Composio } from "@composio/core";
import type { ComposioPlusConfig } from "./types.js";
import { customTools, customToolkits } from "./custom-tools/index.js";
import {
  clearSessionIdCache,
  hashUpdatePayload,
  readSessionIdCache,
  writeSessionIdCache,
} from "./sessionIdCache.js";

export type ComposioSession = Awaited<ReturnType<Composio["create"]>>;

export type SessionBundle = {
  composio: Composio;
  session: ComposioSession;
  /**
   * Slugs registered by the SDK as in-process custom tools — both original
   * (e.g. `REPLY_TO_EMAIL`) and final (`LOCAL_INSTANTLY_REPLY_TO_EMAIL`) forms,
   * uppercased. Used by routeMultiExecute to split items into local-vs-remote
   * without inspecting `LOCAL_` prefixes by hand.
   */
  localSlugs: Set<string>;
};

type Logger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
};

const noopLog = () => {};
const fallbackLogger: Required<Logger> = {
  info: (m) => console.error(m),
  warn: (m) => console.error(m),
  error: (m) => console.error(m),
  debug: process.env.COMPOSIO_PLUS_DEBUG ? (m) => console.error(m) : noopLog,
};

function asLogger(logger?: Logger): Required<Logger> {
  if (!logger) return fallbackLogger;
  return {
    info: logger.info ?? fallbackLogger.info,
    warn: logger.warn ?? fallbackLogger.warn,
    error: logger.error ?? fallbackLogger.error,
    debug: logger.debug ?? fallbackLogger.debug,
  };
}

// composio.use() throws raw APIError from @composio/client when the session is
// gone. We duck-type on `status` so we don't need to import the SDK error class
// (and stay decoupled from its version), and fall back to a message match for
// SDKs that surface the status only in the error string.
function isSessionMissingError(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (status === 404) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b|not[\s_-]*found/i.test(msg);
}

export async function buildSessionFromConfig(
  config: ComposioPlusConfig,
  logger?: Logger,
): Promise<SessionBundle> {
  const log = asLogger(logger);

  const composio = new Composio({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  // Pin custom auth configs to their toolkits so COMPOSIO_MANAGE_CONNECTIONS
  // uses the user's branded OAuth app instead of Composio's managed default.
  // See docs.composio.dev/docs/white-labeling-authentication.
  const authConfigs = config.authConfigs;

  // Toolkit scope. Three cases:
  //   - config.disabledToolkits set → pass { disable: [...] }, everything else
  //     in the catalog is callable.
  //   - config.toolkits set → pass [...] as literal allowlist.
  //   - neither set → omit `toolkits` entirely; SDK exposes the full catalog.
  const opts: Record<string, unknown> = {
    experimental: { customTools, customToolkits },
  };
  if (Object.keys(authConfigs).length > 0) opts.authConfigs = authConfigs;

  let modeLabel: string;
  if (config.disabledToolkits.length > 0) {
    if (config.toolkits.length > 0) {
      log.warn(
        `[composio-plus] both 'toolkits' and 'disabledToolkits' are set — disabledToolkits wins (the SDK accepts only one form). Ignoring toolkits=[${config.toolkits.join(", ")}].`,
      );
    }
    opts.toolkits = { disable: config.disabledToolkits };
    modeLabel = `mode=disable disable=[${config.disabledToolkits.join(", ")}]`;
  } else if (config.toolkits.length > 0) {
    opts.toolkits = config.toolkits;
    modeLabel = `mode=allow toolkits=[${config.toolkits.join(", ")}]`;
  } else {
    modeLabel = "mode=open (full catalog)";
  }

  // Build the partial update payload that re-applies the operator's current
  // toolkit scope + authConfigs to a reused session. session.update() is
  // partial — omitted fields are preserved server-side — so an empty
  // authConfigs map or an unset toolkit allowlist can't reset the session
  // back to "no restrictions"; flipping those off requires nuking the cache.
  const updatePayload: Record<string, unknown> = {};
  if (opts.toolkits !== undefined) updatePayload.toolkits = opts.toolkits;
  if (Object.keys(authConfigs).length > 0) updatePayload.authConfigs = authConfigs;
  const hasUpdatePayload = Object.keys(updatePayload).length > 0;
  const currentConfigHash = hasUpdatePayload ? hashUpdatePayload(updatePayload) : null;

  // Try to reuse a cached session first. composio.use() re-attaches custom
  // tools/toolkits, then session.update() re-applies the toolkit allowlist
  // and authConfigs — but only when the config has changed since the last
  // write (detected via configHash) to avoid a redundant HTTP round-trip.
  let session: ComposioSession | null = null;
  const cached = readSessionIdCache(config.baseURL, config.userId);
  if (cached) {
    try {
      log.debug(
        `[composio-plus] session.use sessionId=${cached.sessionId} userId=${config.userId} customTools=${customTools.length} customToolkits=${customToolkits.length}`,
      );
      session = await composio.use(cached.sessionId, { customTools, customToolkits });
      log.info(
        `[composio-plus] reused composio session ${cached.sessionId} for ${config.userId}`,
      );

      const configChanged = hasUpdatePayload && currentConfigHash !== cached.configHash;
      if (configChanged) {
        try {
          await (session as unknown as {
            update: (cfg: Record<string, unknown>) => Promise<void>;
          }).update(updatePayload);
          writeSessionIdCache(config.baseURL, config.userId, cached.sessionId, currentConfigHash!);
          log.info(
            `[composio-plus] session.update applied (config changed): ${Object.keys(updatePayload).join(", ")}`,
          );
        } catch (err) {
          // Best-effort — keep serving from the reused session even if
          // re-applying scope failed. Don't write the new hash so the next
          // restart retries the update.
          const msg = err instanceof Error ? err.message : String(err);
          log.warn(
            `[composio-plus] session.update failed on reused session ${cached.sessionId}: ${msg} — continuing with previous scope`,
          );
        }
      } else if (hasUpdatePayload) {
        log.debug(`[composio-plus] session.update skipped — config unchanged (hash=${currentConfigHash})`);
      }
    } catch (err) {
      if (isSessionMissingError(err)) {
        log.warn(
          `[composio-plus] cached session ${cached.sessionId} not found — creating a new one.`,
        );
        clearSessionIdCache(config.baseURL, config.userId);
        session = null;
      } else {
        // Auth/network/etc. — keep the cache (the id may still be valid next
        // attempt) and surface the error so caller decides how to react.
        throw err;
      }
    }
  }

  if (!session) {
    log.debug(
      `[composio-plus] session.create userId=${config.userId} ${modeLabel} customTools=${customTools.length} customToolkits=${customToolkits.length} authConfigs=${Object.keys(authConfigs).length}`,
    );
    session = await composio.create(
      config.userId,
      opts as Parameters<Composio["create"]>[1],
    );
    const newId = (session as { sessionId?: unknown }).sessionId;
    if (typeof newId === "string" && newId.length > 0) {
      writeSessionIdCache(config.baseURL, config.userId, newId, currentConfigHash ?? undefined);
      log.info(
        `[composio-plus] created composio session ${newId} for ${config.userId}`,
      );
    } else {
      // The SDK is expected to populate session.sessionId; if it ever doesn't,
      // we'd silently keep creating new sessions every restart. Loud warn so
      // the regression is visible.
      log.warn(
        `[composio-plus] composio.create returned session without sessionId — session reuse disabled until SDK is fixed.`,
      );
    }
  }

  // Per docs.composio.dev/docs/toolkits/custom-tools-and-toolkits#verifying-registration,
  // session.customTools() returns the SDK's view of registered custom tools.
  // We collect both original and final slugs (LOCAL_<TOOLKIT>_<SLUG>) so the
  // dispatch router can identify locals via either spelling.
  const localSlugs = new Set<string>();
  try {
    const registered = await (
      session as unknown as { customTools: () => Promise<unknown[]> }
    ).customTools();
    for (const raw of registered as Array<Record<string, unknown>>) {
      const finalSlug = typeof raw.slug === "string" ? raw.slug : null;
      const originalSlug = typeof raw.originalSlug === "string" ? raw.originalSlug : null;
      if (finalSlug) localSlugs.add(finalSlug.toUpperCase());
      if (originalSlug) localSlugs.add(originalSlug.toUpperCase());
    }
    if (customTools.length > 0) {
      log.info(
        `[composio-plus] ${customTools.length} custom tool(s) registered in-process: [${[...localSlugs].join(", ")}]`,
      );
    }
  } catch (err) {
    // Fallback: derive originals from the in-process customTools array.
    // session.execute() accepts originals too, so we lose only the LOCAL_*
    // alias (and may miss multi-execute splitting if the agent uses LOCAL_*).
    for (const t of customTools) {
      const slug = (t as { slug?: string }).slug;
      if (slug) localSlugs.add(slug.toUpperCase());
    }
    log.warn(
      `[composio-plus] session.customTools() unavailable, using ${localSlugs.size} fallback slugs: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { composio, session, localSlugs };
}
