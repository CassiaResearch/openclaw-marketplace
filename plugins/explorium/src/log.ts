import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

const TAG = "[explorium]";

export interface Log {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export function attachLog(host: PluginLogger, verbose: boolean): Log {
  const debugSink = host.debug?.bind(host);
  const tag = (msg: string): string => `${TAG} ${msg}`;
  return {
    info: (msg) => host.info(tag(msg)),
    warn: (msg) => host.warn(tag(msg)),
    error: (msg) => host.error(tag(msg)),
    debug: (msg) => {
      if (verbose && debugSink) debugSink(tag(msg));
    },
  };
}
