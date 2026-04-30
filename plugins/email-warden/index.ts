import path from "node:path";
import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { createCheckSendTool, createRecordEventTool, createRecordSendTool } from "./src/tools.js";
import type { PluginConfig } from "./src/types.js";

const DEFAULT_STATE_DIR = "email-warden";

export default definePluginEntry({
  id: "copilotai-email-warden",
  name: "Email Warden",
  description:
    "Outbound email governance with per-mailbox rate limits, lognormal jitter, working-hours gates, traffic-class policy, and bounce/reply/complaint tripwires.",
  register(api) {
    const config = normalizeConfig(api.pluginConfig);
    if (!config.enabled) {
      api.logger.warn?.("email-warden: plugin disabled via config; tools will not be registered");
      return;
    }

    const rootDir = resolveStateRoot(api, config.stateDir);
    const store = { rootDir };

    api.registerTool(createCheckSendTool(config, store) as AnyAgentTool);
    api.registerTool(createRecordSendTool(config, store) as AnyAgentTool);
    api.registerTool(createRecordEventTool(config, store) as AnyAgentTool);

    for (const adapter of config.ingestion.adapters) {
      if (adapter.enabled === false) continue;
      api.logger.info?.(
        `email-warden: ingestion adapter "${adapter.kind}" is configured but not yet implemented; events from this source will not flow until the adapter ships`,
      );
    }
  },
});

function normalizeConfig(raw: unknown): PluginConfig {
  const cfg = (raw ?? {}) as Partial<PluginConfig>;
  return {
    enabled: cfg.enabled !== false,
    stateDir: cfg.stateDir ?? DEFAULT_STATE_DIR,
    mailboxes: cfg.mailboxes ?? {
      default: {
        timezone: "UTC",
        workingHours: { start: "09:00", end: "17:00" },
        workingDays: ["mon", "tue", "wed", "thu", "fri"],
        limits: {
          send: { perDay: 40, perHour: 8, minGapSeconds: 90 },
          perRecipientDomainPerHour: 3,
        },
        warmup: { enabled: true, startPerDay: 15, rampPerDay: 3, plateauPerDay: 40 },
      },
    },
    jitter: cfg.jitter ?? {
      enabled: true,
      distribution: "lognormal",
      lognormal: { medianSeconds: 140, sigma: 0.6 },
      clampSeconds: { min: 45, max: 900 },
      microPause: { probability: 0.04, durationSeconds: { min: 600, max: 2400 } },
      sendOutsideWorkingHours: "defer",
    },
    tripwires: cfg.tripwires ?? {},
    suppression: cfg.suppression ?? { scope: "global", honorUnsubscribeWithinHours: 48 },
    retention: cfg.retention ?? { maxEvents: 1000, dailyRetentionDays: 90, perDomainRetentionDays: 14 },
    alerts: cfg.alerts ?? { onPause: true, onDailyRollup: true },
    ingestion: cfg.ingestion ?? { adapters: [] },
  };
}

function resolveStateRoot(api: Parameters<Parameters<typeof definePluginEntry>[0]["register"]>[0], stateDir: string): string {
  const base = api.runtime?.state?.resolveStateDir?.() ?? process.cwd();
  return path.join(base, "plugins", stateDir);
}
