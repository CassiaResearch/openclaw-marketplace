import { maybeMicroPauseSeconds, nextOpenWorkingInstant, sampleJitterSeconds } from "./jitter.js";
import { noopLog, type Log } from "./log.js";
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

/**
 * Decide whether a proposed send is permitted right now for `input.mailbox`.
 *
 * Resolves the traffic class (forced to `cold_outbound` if `campaignContext`
 * is set; falls back to `cold_outbound` for unknown values — fail-closed),
 * loads the per-mailbox ledger, and returns one of:
 *
 * - `suppressed` — recipient is on the suppression list.
 * - `deny`       — mailbox is paused, a tripwire pause has fired, or a
 *                  daily/hourly send cap is exhausted.
 * - `defer`      — pacing (min-gap, jitter, micro-pause, or working-hours
 *                  gate) pushes the next send into the future; `sendAfter`
 *                  is an ISO timestamp the caller should respect.
 * - `allow`      — caller may send immediately.
 *
 * Pure with respect to ledger state — does not record anything; pair with
 * `recordSend` after the underlying send completes.
 */
export async function checkSend(
  input: CheckSendInput,
  config: PluginConfig,
  store: StoreOptions,
  now: Date = new Date(),
  log: Log = noopLog(),
): Promise<Decision> {
  const resolvedClass = resolveTrafficClass(input);
  const ledger = await loadLedger(store, input.mailbox, config);
  const policy = resolveMailboxPolicy(input.mailbox, config);

  if (ledger.suppressed.some((s) => s.recipient.toLowerCase() === input.recipient.toLowerCase())) {
    log.debug(`checkSend mailbox=${input.mailbox} recipient=${input.recipient} → suppressed`);
    return { decision: "suppressed", reason: "recipient in suppression list" };
  }

  if (ledger.pausedUntil && Date.parse(ledger.pausedUntil) > now.getTime()) {
    log.warn(
      `checkSend mailbox=${input.mailbox} → deny (paused until ${ledger.pausedUntil}: ${ledger.pausedReason ?? "mailbox paused"})`,
    );
    return { decision: "deny", reason: ledger.pausedReason ?? "mailbox paused" };
  }

  const tripHits = evaluateTripwires(ledger, config, now);
  const hardPause = tripHits.find((h) => h.action === "pause-mailbox");
  if (hardPause) {
    log.warn(`checkSend mailbox=${input.mailbox} → deny (tripwire pause-mailbox: ${hardPause.message})`);
    return { decision: "deny", reason: hardPause.message };
  }

  const limitDeny = checkGlobalLimits(ledger, policy, now);
  if (limitDeny) {
    log.info(`checkSend mailbox=${input.mailbox} → deny (${limitDeny.reason})`);
    return limitDeny;
  }

  const paced = computeSendAfter(resolvedClass, policy, config, ledger, now);
  if (paced.persist) {
    ledger.pendingSendReservation = paced.reservation;
    await saveLedger(store, ledger);
  }
  if (paced.sendAfter.getTime() > now.getTime() + 1000) {
    log.debug(
      `checkSend mailbox=${input.mailbox} class=${resolvedClass} → defer sendAfter=${paced.sendAfter.toISOString()} reason=${paced.reason ?? "pacing"}`,
    );
    return {
      decision: "defer",
      class: resolvedClass,
      sendAfter: paced.sendAfter.toISOString(),
      reason: paced.reason ?? "pacing",
    };
  }

  log.debug(`checkSend mailbox=${input.mailbox} class=${resolvedClass} → allow`);
  return { decision: "allow", class: resolvedClass };
}

/**
 * Append a `send` event (success or error) to the mailbox ledger and persist.
 * Call this immediately after the underlying send completes, passing the
 * traffic class returned by `checkSend` so aggregates and tripwires stay
 * consistent. `cost` defaults to `1`.
 */
export async function recordSend(
  input: RecordSendInput,
  config: PluginConfig,
  store: StoreOptions,
  now: Date = new Date(),
  log: Log = noopLog(),
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
  delete ledger.pendingSendReservation;
  await saveLedger(store, ledger);
  log.debug(
    `recordSend mailbox=${input.mailbox} class=${input.class} result=${input.result}${input.messageId ? ` messageId=${input.messageId}` : ""}`,
  );
}

/**
 * Record an inbound event (`bounce`, `reply`, `complaint`, or
 * `unsubscribe`) observed for a previously-sent message. For `bounce` and
 * `unsubscribe` the recipient is added to the mailbox suppression list (if
 * not already present). Typically driven by an ingestion adapter (e.g.
 * Gmail Pub/Sub), not by the agent directly.
 */
export async function recordExternalEvent(
  input: RecordEventInput,
  config: PluginConfig,
  store: StoreOptions,
  now: Date = new Date(),
  log: Log = noopLog(),
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
      log.info(
        `suppressed recipient=${input.recipient} mailbox=${input.mailbox} cause=${input.cat}${input.reason ? ` reason=${input.reason}` : ""}`,
      );
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
  log.debug(
    `recordExternalEvent mailbox=${input.mailbox} cat=${input.cat} class=${input.class} recipient=${input.recipient}`,
  );
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
): Extract<Decision, { decision: "deny" }> | null {
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

type PacedDecision = {
  sendAfter: Date;
  reason?: string;
  persist: boolean;
  reservation?: NonNullable<MailboxLedger["pendingSendReservation"]>;
};

function computeSendAfter(
  cls: TrafficClass,
  policy: MailboxPolicy,
  config: PluginConfig,
  ledger: MailboxLedger,
  now: Date,
): PacedDecision {
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

  if (!CLASSES_WITH_FULL_PACING.has(cls)) {
    return { sendAfter: new Date(earliest), reason, persist: false };
  }

  const existing = ledger.pendingSendReservation;
  const fingerprint = lastSendIso ?? null;
  const reservationFresh = existing && (existing.afterLastSend ?? null) === fingerprint;

  if (reservationFresh) {
    const reservedMs = Date.parse(existing.sendAfter);
    if (reservedMs > earliest) {
      earliest = reservedMs;
      reason = existing.reason;
    }
    return { sendAfter: new Date(earliest), reason, persist: false };
  }

  const jitter = sampleJitterSeconds(config.jitter) * 1000;
  const micro = maybeMicroPauseSeconds(config.jitter) * 1000;
  if (jitter + micro > 0) {
    const candidate = now.getTime() + jitter + micro;
    if (candidate > earliest) {
      earliest = candidate;
      reason = micro > 0 ? "micro-pause" : "jitter";
    }
  }
  if (config.jitter.sendOutsideWorkingHours === "defer") {
    const openInstant = nextOpenWorkingInstant(new Date(earliest), policy);
    if (openInstant.getTime() > earliest) {
      earliest = openInstant.getTime();
      reason = "working-hours";
    }
  }

  const reservation = {
    sendAfter: new Date(earliest).toISOString(),
    reason: reason ?? "pacing",
    reservedAt: now.toISOString(),
    afterLastSend: fingerprint,
  };
  return { sendAfter: new Date(earliest), reason, persist: true, reservation };
}

