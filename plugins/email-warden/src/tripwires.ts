import type { LedgerEvent, MailboxLedger, PluginConfig, Tripwire, TrafficClass } from "./types.js";

export type TripwireHit = {
  name: string;
  action: Tripwire["action"];
  message: string;
};

type OutcomeCounts = { bounces: number; complaints: number; replies: number };

export function evaluateTripwires(
  ledger: MailboxLedger,
  config: PluginConfig,
  now: Date = new Date(),
): TripwireHit[] {
  const attribution = buildSendAttribution(ledger);
  const hits: TripwireHit[] = [];
  for (const [name, rule] of Object.entries(config.tripwires)) {
    const hit = evaluateRule(name, rule, ledger, attribution, now);
    if (hit) hits.push(hit);
  }
  return hits;
}

function evaluateRule(
  name: string,
  rule: Tripwire,
  ledger: MailboxLedger,
  attribution: Map<string, OutcomeCounts>,
  now: Date,
): TripwireHit | null {
  if (!rule.window) return null;
  const classes = new Set<TrafficClass>(rule.classes ?? []);
  const hasClassFilter = classes.size > 0;

  let sends = 0;
  let bounces = 0;
  let complaints = 0;
  let replies = 0;

  if ("sends" in rule.window) {
    const need = rule.window.sends;
    for (const e of ledger.events) {
      if (e.cat !== "send" || e.result !== "ok") continue;
      if (hasClassFilter && !classes.has(e.class)) continue;
      if (sends >= need) break;
      sends += 1;
      const linked = attribution.get(sendAttributionKey(e));
      if (linked) {
        bounces += linked.bounces;
        complaints += linked.complaints;
        replies += linked.replies;
      }
    }
    if (sends < need) return null;
  } else {
    const cutoff = now.getTime() - rule.window.hours * 3600_000;
    const minSends = rule.window.minSends ?? 1;
    for (const e of ledger.events) {
      if (Date.parse(e.t) < cutoff) break;
      if (hasClassFilter && !classes.has(e.class)) continue;
      if (e.cat === "send" && e.result === "ok") sends += 1;
      else if (e.cat === "bounce") bounces += 1;
      else if (e.cat === "complaint") complaints += 1;
      else if (e.cat === "reply") replies += 1;
    }
    if (sends < minSends) return null;
  }

  if (sends === 0) return null;

  const matchedRate = matchRate(name, { bounces, complaints, replies }, sends);
  if (matchedRate === null) return null;

  if (rule.maxRate !== undefined && matchedRate > rule.maxRate) {
    return { name, action: rule.action, message: `${name}: ${(matchedRate * 100).toFixed(2)}% > ${(rule.maxRate * 100).toFixed(2)}% over ${sends} sends` };
  }
  if (rule.minRate !== undefined && matchedRate < rule.minRate) {
    return { name, action: rule.action, message: `${name}: ${(matchedRate * 100).toFixed(2)}% < ${(rule.minRate * 100).toFixed(2)}% over ${sends} sends` };
  }
  return null;
}

function matchRate(
  name: string,
  counts: { bounces: number; complaints: number; replies: number },
  sends: number,
): number | null {
  const lower = name.toLowerCase();
  if (lower.includes("bounce")) return counts.bounces / sends;
  if (lower.includes("complaint") || lower.includes("spam")) return counts.complaints / sends;
  if (lower.includes("reply")) return counts.replies / sends;
  return null;
}

function buildSendAttribution(ledger: MailboxLedger): Map<string, OutcomeCounts> {
  const result = new Map<string, OutcomeCounts>();
  const lastSendKeyByRecipient = new Map<string, string>();

  for (let i = ledger.events.length - 1; i >= 0; i--) {
    const e = ledger.events[i];
    if (!e || !e.recipient) continue;
    const recipient = e.recipient.toLowerCase();
    if (e.cat === "send" && e.result === "ok") {
      const key = sendAttributionKey(e);
      lastSendKeyByRecipient.set(recipient, key);
      if (!result.has(key)) result.set(key, { bounces: 0, complaints: 0, replies: 0 });
      continue;
    }
    if (e.cat !== "bounce" && e.cat !== "complaint" && e.cat !== "reply") continue;
    const sendKey = lastSendKeyByRecipient.get(recipient);
    if (!sendKey) continue;
    const counts = result.get(sendKey);
    if (!counts) continue;
    if (e.cat === "bounce") counts.bounces += 1;
    else if (e.cat === "complaint") counts.complaints += 1;
    else counts.replies += 1;
  }

  return result;
}

function sendAttributionKey(e: LedgerEvent): string {
  return `${e.t}|${(e.recipient ?? "").toLowerCase()}`;
}
