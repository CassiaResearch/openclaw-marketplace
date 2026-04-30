import { maybeMicroPauseSeconds, nextOpenWorkingInstant, sampleJitterSeconds } from "./jitter.js";
import { appendEvent, loadLedger, saveLedger, type StoreOptions } from "./store.js";
import { evaluateTripwires } from "./tripwires.js";
import {
  KNOWN_TRAFFIC_CLASSES,
  type CheckSendInput,
  type Decision,
  type MailboxLedger,
  type MailboxPolicy,
  type PluginConfig,
  type RecordEventInput,
  type RecordSendInput,
  type TrafficClass,
} from "./types.js";

const CLASSES_WITH_FULL_PACING = new Set<TrafficClass>(["cold_outbound", "warmup_send", "follow_up"]);

export async function checkSend(
  input: CheckSendInput,
  config: PluginConfig,
  store: StoreOptions,
  now: Date = new Date(),
): Promise<Decision> {
  const resolvedClass = resolveTrafficClass(input);
  const ledger = await loadLedger(store, input.mailbox, config);
  const policy = resolveMailboxPolicy(input.mailbox, config);

  if (ledger.suppressed.some((s) => s.recipient.toLowerCase() === input.recipient.toLowerCase())) {
    return { decision: "suppressed", reason: "recipient in suppression list" };
  }

  if (ledger.pausedUntil && Date.parse(ledger.pausedUntil) > now.getTime()) {
    return { decision: "deny", reason: ledger.pausedReason ?? "mailbox paused" };
  }

  const tripHits = evaluateTripwires(ledger, config, now);
  const hardPause = tripHits.find((h) => h.action === "pause-mailbox");
  if (hardPause) {
    return { decision: "deny", reason: hardPause.message };
  }

  const limitDeny = checkGlobalLimits(ledger, policy, now);
  if (limitDeny) return limitDeny;

  const sendAfter = computeSendAfter(resolvedClass, policy, config, ledger, now);
  if (sendAfter.getTime() > now.getTime() + 1000) {
    return {
      decision: "defer",
      class: resolvedClass,
      sendAfter: sendAfter.toISOString(),
      reason: sendAfter.reason ?? "pacing",
    };
  }

  return { decision: "allow", class: resolvedClass };
}

export async function recordSend(
  input: RecordSendInput,
  config: PluginConfig,
  store: StoreOptions,
  now: Date = new Date(),
): Promise<void> {
  const ledger = await loadLedger(store, input.mailbox, config);
  appendEvent(
    ledger,
    {
      t: now.toISOString(),
      cat: "send",
      class: input.class,
      cost: input.cost ?? 1,
      result: input.result,
      recipient: input.recipient,
      messageId: input.messageId,
      errorStatus: input.errorStatus,
      reason: input.reason,
    },
    config,
  );
  await saveLedger(store, ledger);
}

export async function recordExternalEvent(
  input: RecordEventInput,
  config: PluginConfig,
  store: StoreOptions,
  now: Date = new Date(),
): Promise<void> {
  const ledger = await loadLedger(store, input.mailbox, config);

  if (input.cat === "bounce" || input.cat === "unsubscribe") {
    const already = ledger.suppressed.some((s) => s.recipient.toLowerCase() === input.recipient.toLowerCase());
    if (!already) {
      ledger.suppressed.push({
        recipient: input.recipient,
        reason: input.reason ?? input.cat,
        at: now.toISOString(),
      });
    }
  }

  appendEvent(
    ledger,
    {
      t: now.toISOString(),
      cat: input.cat,
      class: input.class,
      cost: 0,
      result: "observed",
      recipient: input.recipient,
      reason: input.reason,
    },
    config,
  );
  await saveLedger(store, ledger);
}

function resolveTrafficClass(input: CheckSendInput): TrafficClass {
  if (input.campaignContext) return "cold_outbound";
  const raw = input.trafficClass;
  if (raw && (KNOWN_TRAFFIC_CLASSES as readonly string[]).includes(raw)) {
    return raw as TrafficClass;
  }
  return "cold_outbound";
}

function resolveMailboxPolicy(mailbox: string, config: PluginConfig): MailboxPolicy {
  const override = config.mailboxes.overrides?.[mailbox];
  if (!override) return config.mailboxes.default;
  return {
    ...config.mailboxes.default,
    ...override,
    workingHours: override.workingHours ?? config.mailboxes.default.workingHours,
    workingDays: override.workingDays ?? config.mailboxes.default.workingDays,
    limits: {
      ...config.mailboxes.default.limits,
      ...override.limits,
      send: { ...config.mailboxes.default.limits.send, ...override.limits?.send },
    },
    warmup: { ...config.mailboxes.default.warmup, ...override.warmup },
  };
}

function checkGlobalLimits(
  ledger: MailboxLedger,
  policy: MailboxPolicy,
  now: Date,
): Decision | null {
  const today = now.toISOString().slice(0, 10);
  const todayBucket = ledger.aggregates.daily[today];
  const sentToday = todayBucket?.send.calls ?? 0;
  if (sentToday >= policy.limits.send.perDay) {
    return { decision: "deny", reason: `daily send cap reached (${sentToday}/${policy.limits.send.perDay})` };
  }

  const hourAgo = now.getTime() - 3600_000;
  const sentLastHour = ledger.events.filter(
    (e) => e.cat === "send" && e.result === "ok" && Date.parse(e.t) >= hourAgo,
  ).length;
  if (sentLastHour >= policy.limits.send.perHour) {
    return { decision: "deny", reason: `hourly send cap reached (${sentLastHour}/${policy.limits.send.perHour})` };
  }

  return null;
}

type AugmentedDate = Date & { reason?: string };

function computeSendAfter(
  cls: TrafficClass,
  policy: MailboxPolicy,
  config: PluginConfig,
  ledger: MailboxLedger,
  now: Date,
): AugmentedDate {
  const minGapSeconds = policy.limits.send.minGapSeconds;
  const lastSendIso = ledger.lastCallAt.send;
  let earliest = now.getTime();
  let reason: string | undefined;

  if (lastSendIso) {
    const minGapTarget = Date.parse(lastSendIso) + minGapSeconds * 1000;
    if (minGapTarget > earliest) {
      earliest = minGapTarget;
      reason = "min-gap";
    }
  }

  if (CLASSES_WITH_FULL_PACING.has(cls)) {
    const jitter = sampleJitterSeconds(config.jitter) * 1000;
    const micro = maybeMicroPauseSeconds(config.jitter) * 1000;
    if (jitter + micro > 0) {
      earliest = Math.max(earliest, now.getTime() + jitter + micro);
      reason = micro > 0 ? "micro-pause" : "jitter";
    }
    if (config.jitter.sendOutsideWorkingHours === "defer") {
      const openInstant = nextOpenWorkingInstant(new Date(earliest), policy);
      if (openInstant.getTime() > earliest) {
        earliest = openInstant.getTime();
        reason = "working-hours";
      }
    }
  }

  const result = new Date(earliest) as AugmentedDate;
  result.reason = reason;
  return result;
}

