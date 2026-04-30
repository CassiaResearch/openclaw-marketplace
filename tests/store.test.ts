import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, loadLedger, saveLedger, type StoreOptions } from "../src/store.js";
import type { LedgerEvent, PluginConfig } from "../src/types.js";

function baseConfig(overrides: Partial<PluginConfig["retention"]> = {}): PluginConfig {
  return {
    enabled: true,
    stateDir: "email-warden",
    mailboxes: {
      default: {
        timezone: "UTC",
        workingHours: { start: "09:00", end: "17:00" },
        workingDays: ["mon", "tue", "wed", "thu", "fri"],
        limits: {
          send: { perDay: 40, perHour: 8, minGapSeconds: 90 },
          perRecipientDomainPerHour: 3,
        },
        warmup: { enabled: false, startPerDay: 15, rampPerDay: 3, plateauPerDay: 40 },
      },
    },
    jitter: {
      enabled: false,
      distribution: "uniform",
      uniform: { minSeconds: 0, maxSeconds: 1 },
      clampSeconds: { min: 0, max: 1 },
      microPause: { probability: 0, durationSeconds: { min: 0, max: 1 } },
      sendOutsideWorkingHours: "allow",
    },
    tripwires: {},
    suppression: { scope: "global", honorUnsubscribeWithinHours: 48 },
    retention: { maxEvents: 1000, dailyRetentionDays: 90, perDomainRetentionDays: 14, ...overrides },
    alerts: { onPause: true, onDailyRollup: true },
    ingestion: { adapters: [] },
  };
}

function sendEvent(iso: string, recipient = "x@acme.com"): LedgerEvent {
  return {
    t: iso,
    cat: "send",
    class: "cold_outbound",
    cost: 1,
    result: "ok",
    recipient,
    messageId: `msg-${iso}`,
  };
}

describe("store", () => {
  let dir: string;
  let store: StoreOptions;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "email-warden-"));
    store = { rootDir: dir };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("creates a new ledger on first load", async () => {
    const ledger = await loadLedger(store, "emma@example.com", baseConfig());
    expect(ledger.mailbox).toBe("emma@example.com");
    expect(ledger.events).toEqual([]);
    expect(ledger.aggregates.daily).toEqual({});
  });

  it("round-trips a ledger via save + load", async () => {
    const cfg = baseConfig();
    const ledger = await loadLedger(store, "emma@example.com", cfg);
    appendEvent(ledger, sendEvent("2026-04-24T10:00:00.000Z"), cfg);
    await saveLedger(store, ledger);
    const reloaded = await loadLedger(store, "emma@example.com", cfg);
    expect(reloaded.events).toHaveLength(1);
    expect(reloaded.aggregates.daily["2026-04-24"]?.send.calls).toBe(1);
  });

  it("caps events at retention.maxEvents", async () => {
    const cfg = baseConfig({ maxEvents: 10 });
    const ledger = await loadLedger(store, "emma@example.com", cfg);
    for (let i = 0; i < 25; i++) {
      const ts = new Date(Date.UTC(2026, 3, 24, 10, 0, i)).toISOString();
      appendEvent(ledger, sendEvent(ts), cfg);
    }
    expect(ledger.events).toHaveLength(10);
    // events are prepended; newest at index 0
    expect(ledger.events[0]?.t).toBe("2026-04-24T10:00:24.000Z");
  });

  it("rolls daily buckets older than retention into monthly", async () => {
    const cfg = baseConfig({ dailyRetentionDays: 30 });
    const ledger = await loadLedger(store, "emma@example.com", cfg);

    // Old event: 45 days ago
    const old = new Date(Date.UTC(2026, 2, 10, 12, 0, 0)).toISOString();
    // Recent event: 2 days before "now"
    const nowEvent = new Date(Date.UTC(2026, 3, 22, 12, 0, 0)).toISOString();
    appendEvent(ledger, sendEvent(old), cfg);
    appendEvent(ledger, sendEvent(nowEvent), cfg);

    // Force compaction against a "now" of 2026-04-24
    const cutoff = Date.UTC(2026, 3, 24);
    expect(Date.parse("2026-03-10T00:00:00Z") < cutoff - cfg.retention.dailyRetentionDays * 86400_000).toBe(true);

    // Trigger compaction via one more append
    const triggerTs = new Date(Date.UTC(2026, 3, 24, 12, 0, 0)).toISOString();
    appendEvent(ledger, sendEvent(triggerTs), cfg);

    // Old day should be rolled into monthly; recent day stays in daily
    expect(ledger.aggregates.daily["2026-03-10"]).toBeUndefined();
    expect(ledger.aggregates.monthly["2026-03"]?.send.calls).toBe(1);
    expect(ledger.aggregates.daily["2026-04-22"]?.send.calls).toBe(1);
    expect(ledger.aggregates.daily["2026-04-24"]?.send.calls).toBe(1);
  });

  it("drops per-recipient-domain entries past the retention window", async () => {
    const cfg = baseConfig({ perDomainRetentionDays: 7 });
    const ledger = await loadLedger(store, "emma@example.com", cfg);

    // Old: 20 days ago — should be dropped after compaction
    const old = new Date(Date.UTC(2026, 3, 4, 12, 0, 0)).toISOString();
    appendEvent(ledger, sendEvent(old, "a@acme.com"), cfg);

    // New: today — should survive
    const now = new Date(Date.UTC(2026, 3, 24, 12, 0, 0)).toISOString();
    appendEvent(ledger, sendEvent(now, "b@bigco.com"), cfg);

    expect(ledger.aggregates.perRecipientDomain["2026-04-04"]).toBeUndefined();
    expect(ledger.aggregates.perRecipientDomain["2026-04-24"]?.["bigco.com"]).toBe(1);
  });

  it("writes ledger atomically (no .tmp leftovers after save)", async () => {
    const cfg = baseConfig();
    const ledger = await loadLedger(store, "emma@example.com", cfg);
    appendEvent(ledger, sendEvent("2026-04-24T10:00:00.000Z"), cfg);
    await saveLedger(store, ledger);

    const mailboxDir = path.join(dir, "emma@example.com");
    const files = await fs.readdir(mailboxDir);
    expect(files).toContain("usage.json");
    expect(files.filter((f) => f.includes(".tmp."))).toEqual([]);
  });
});
