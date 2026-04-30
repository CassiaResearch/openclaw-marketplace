import fs from "node:fs/promises";
import path from "node:path";
import type { EventCategory, LedgerEvent, MailboxLedger, PluginConfig } from "./types.js";

export type StoreOptions = {
  rootDir: string;
};

export async function loadLedger(
  opts: StoreOptions,
  mailbox: string,
  config: PluginConfig,
): Promise<MailboxLedger> {
  const file = ledgerFilePath(opts.rootDir, mailbox);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as MailboxLedger;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return newLedger(mailbox, config);
    }
    throw err;
  }
}

export async function saveLedger(opts: StoreOptions, ledger: MailboxLedger): Promise<void> {
  const file = ledgerFilePath(opts.rootDir, ledger.mailbox);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, JSON.stringify(ledger, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export function appendEvent(ledger: MailboxLedger, event: LedgerEvent, config: PluginConfig): void {
  ledger.events.unshift(event);
  if (ledger.events.length > config.retention.maxEvents) {
    ledger.events.length = config.retention.maxEvents;
  }
  bumpAggregate(ledger, event);
  if (event.cat === "send" && event.result === "ok" && event.recipient) {
    bumpRecipientDomain(ledger, event.recipient, event.t);
  }
  ledger.lastCallAt[event.cat] = event.t;
  ledger.updatedAt = event.t;
  compact(ledger, config);
}

function bumpAggregate(ledger: MailboxLedger, event: LedgerEvent): void {
  const day = event.t.slice(0, 10);
  const bucket = (ledger.aggregates.daily[day] ??= emptyDailyBuckets());
  bucket[event.cat].calls += 1;
  if (event.result === "error") bucket[event.cat].penalty += 1;
}

function bumpRecipientDomain(ledger: MailboxLedger, recipient: string, ts: string): void {
  const domain = recipient.split("@")[1]?.toLowerCase();
  if (!domain) return;
  const day = ts.slice(0, 10);
  const dayBucket = (ledger.aggregates.perRecipientDomain[day] ??= {});
  dayBucket[domain] = (dayBucket[domain] ?? 0) + 1;
}

function compact(ledger: MailboxLedger, config: PluginConfig): void {
  const now = Date.now();
  const dailyCutoff = now - config.retention.dailyRetentionDays * 86400_000;
  const domainCutoff = now - config.retention.perDomainRetentionDays * 86400_000;

  for (const day of Object.keys(ledger.aggregates.daily)) {
    if (Date.parse(`${day}T00:00:00Z`) < dailyCutoff) {
      const month = day.slice(0, 7);
      const monthly = (ledger.aggregates.monthly[month] ??= emptyDailyBuckets());
      for (const cat of Object.keys(ledger.aggregates.daily[day]!) as EventCategory[]) {
        const src = ledger.aggregates.daily[day]![cat];
        monthly[cat].calls += src.calls;
        monthly[cat].penalty += src.penalty;
      }
      delete ledger.aggregates.daily[day];
    }
  }

  for (const day of Object.keys(ledger.aggregates.perRecipientDomain)) {
    if (Date.parse(`${day}T00:00:00Z`) < domainCutoff) {
      delete ledger.aggregates.perRecipientDomain[day];
    }
  }
}

function emptyDailyBuckets(): Record<EventCategory, { calls: number; penalty: number }> {
  return {
    send:        { calls: 0, penalty: 0 },
    bounce:      { calls: 0, penalty: 0 },
    reply:       { calls: 0, penalty: 0 },
    complaint:   { calls: 0, penalty: 0 },
    unsubscribe: { calls: 0, penalty: 0 },
  };
}

function newLedger(mailbox: string, config: PluginConfig): MailboxLedger {
  const now = new Date().toISOString();
  const tz = config.mailboxes.overrides?.[mailbox]?.timezone ?? config.mailboxes.default.timezone;
  return {
    version: 1,
    mailbox,
    tier: "gws-standard",
    timezone: tz,
    createdAt: now,
    updatedAt: now,
    warmup: { stage: 0, plateauReachedAt: null },
    aggregates: { daily: {}, monthly: {}, perRecipientDomain: {} },
    lastCallAt: {},
    lastCooldownAt: {},
    suppressed: [],
    events: [],
  };
}

function ledgerFilePath(rootDir: string, mailbox: string): string {
  return path.join(rootDir, sanitizeMailbox(mailbox), "usage.json");
}

function sanitizeMailbox(mailbox: string): string {
  return mailbox.toLowerCase().replace(/[^a-z0-9@._-]/g, "_");
}
