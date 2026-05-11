import { Composio } from "@composio/core";
import type { ComposioPlusConfig } from "./types.js";
import { customTools, customToolkits } from "./custom-tools/index.js";

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

  log.debug(
    `[composio-plus] session.create userId=${config.userId} ${modeLabel} customTools=${customTools.length} customToolkits=${customToolkits.length} authConfigs=${Object.keys(authConfigs).length}`,
  );

  const session = await composio.create(
    config.userId,
    opts as Parameters<Composio["create"]>[1],
  );

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
