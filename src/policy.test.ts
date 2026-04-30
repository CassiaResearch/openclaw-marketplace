import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkSend, recordExternalEvent, recordSend } from "./policy.js";
import { loadLedger, type StoreOptions } from "./store.js";
import type { PluginConfig } from "./types.js";

function baseConfig(overrides: Partial<PluginConfig> = {}): PluginConfig {
  return {
    enabled: true,
    stateDir: "email-warden",
    mailboxes: {
      default: {
        timezone: "UTC",
        workingHours: { start: "00:00", end: "23:59" },
        workingDays: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
        limits: {
          send: { perDay: 3, perHour: 2, minGapSeconds: 0 },
          perRecipientDomainPerHour: 10,
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
    retention: { maxEvents: 1000, dailyRetentionDays: 90, perDomainRetentionDays: 14 },
    alerts: { onPause: true, onDailyRollup: true },
    ingestion: { adapters: [] },
    ...overrides,
  };
}

describe("checkSend", () => {
  let dir: string;
  let store: StoreOptions;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "email-warden-policy-"));
    store = { rootDir: dir };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("allows a clean send", async () => {
    const decision = await checkSend(
      { mailbox: "emma@example.com", recipient: "x@acme.com", trafficClass: "cold_outbound" },
      baseConfig(),
      store,
    );
    expect(decision.decision).toBe("allow");
    if (decision.decision === "allow") expect(decision.class).toBe("cold_outbound");
  });

  it("fails closed to cold_outbound when trafficClass is missing", async () => {
    const decision = await checkSend(
      { mailbox: "emma@example.com", recipient: "x@acme.com" },
      baseConfig(),
      store,
    );
    expect(decision.decision).toBe("allow");
    if (decision.decision === "allow") expect(decision.class).toBe("cold_outbound");
  });

  it("fails closed to cold_outbound when trafficClass is unknown", async () => {
    const decision = await checkSend(
      { mailbox: "emma@example.com", recipient: "x@acme.com", trafficClass: "bogus" },
      baseConfig(),
      store,
    );
    expect(decision.decision).toBe("allow");
    if (decision.decision === "allow") expect(decision.class).toBe("cold_outbound");
  });

  it("campaignContext overrides the caller-supplied class", async () => {
    const decision = await checkSend(
      {
        mailbox: "emma@example.com",
        recipient: "x@acme.com",
        trafficClass: "personal",
        campaignContext: true,
      },
      baseConfig(),
      store,
    );
    expect(decision.decision).toBe("allow");
    if (decision.decision === "allow") expect(decision.class).toBe("cold_outbound");
  });

  it("denies when a recipient is on the suppression list", async () => {
    const cfg = baseConfig();
    await recordExternalEvent(
      {
        mailbox: "emma@example.com",
        cat: "unsubscribe",
        class: "cold_outbound",
        recipient: "optout@example.com",
      },
      cfg,
      store,
    );
    const decision = await checkSend(
      { mailbox: "emma@example.com", recipient: "optout@example.com", trafficClass: "cold_outbound" },
      cfg,
      store,
    );
    expect(decision.decision).toBe("suppressed");
  });

  it("denies when the daily cap is reached", async () => {
    const cfg = baseConfig();
    for (let i = 0; i < 3; i++) {
      await recordSend(
        {
          mailbox: "emma@example.com",
          recipient: `rcpt${i}@acme.com`,
          class: "cold_outbound",
          result: "ok",
        },
        cfg,
        store,
      );
    }
    const decision = await checkSend(
      { mailbox: "emma@example.com", recipient: "new@acme.com", trafficClass: "cold_outbound" },
      cfg,
      store,
    );
    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") expect(decision.reason).toMatch(/daily/);
  });

  it("defers when jitter is enabled and last-send was too recent", async () => {
    const cfg = baseConfig({
      jitter: {
        enabled: true,
        distribution: "uniform",
        uniform: { minSeconds: 60, maxSeconds: 60 },
        clampSeconds: { min: 60, max: 60 },
        microPause: { probability: 0, durationSeconds: { min: 0, max: 1 } },
        sendOutsideWorkingHours: "allow",
      },
    });
    await recordSend(
      { mailbox: "emma@example.com", recipient: "first@acme.com", class: "cold_outbound", result: "ok" },
      cfg,
      store,
    );
    const decision = await checkSend(
      { mailbox: "emma@example.com", recipient: "second@acme.com", trafficClass: "cold_outbound" },
      cfg,
      store,
    );
    expect(decision.decision).toBe("defer");
    if (decision.decision === "defer") {
      expect(new Date(decision.sendAfter).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("does not apply working-hours gate to replies", async () => {
    // Saturday 18:00 UTC — outside normal working hours in a weekday-only policy
    const saturday = new Date("2026-04-25T18:00:00Z");
    const cfg = baseConfig({
      mailboxes: {
        default: {
          timezone: "UTC",
          workingHours: { start: "09:00", end: "17:00" },
          workingDays: ["mon", "tue", "wed", "thu", "fri"],
          limits: {
            send: { perDay: 40, perHour: 8, minGapSeconds: 0 },
            perRecipientDomainPerHour: 10,
          },
          warmup: { enabled: false, startPerDay: 15, rampPerDay: 3, plateauPerDay: 40 },
        },
      },
      jitter: {
        enabled: true,
        distribution: "uniform",
        uniform: { minSeconds: 0, maxSeconds: 0 },
        clampSeconds: { min: 0, max: 0 },
        microPause: { probability: 0, durationSeconds: { min: 0, max: 1 } },
        sendOutsideWorkingHours: "defer",
      },
    });

    const replyDecision = await checkSend(
      { mailbox: "emma@example.com", recipient: "boss@example.com", trafficClass: "reply" },
      cfg,
      store,
      saturday,
    );
    expect(replyDecision.decision).toBe("allow");

    const coldDecision = await checkSend(
      { mailbox: "emma@example.com", recipient: "prospect@example.com", trafficClass: "cold_outbound" },
      cfg,
      store,
      saturday,
    );
    expect(coldDecision.decision).toBe("defer");
  });
});

describe("recordExternalEvent", () => {
  let dir: string;
  let store: StoreOptions;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "email-warden-event-"));
    store = { rootDir: dir };
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("suppresses the recipient on a hard bounce", async () => {
    const cfg = baseConfig();
    await recordExternalEvent(
      { mailbox: "emma@example.com", cat: "bounce", class: "cold_outbound", recipient: "gone@example.com" },
      cfg,
      store,
    );
    const ledger = await loadLedger(store, "emma@example.com", cfg);
    expect(ledger.suppressed.some((s) => s.recipient === "gone@example.com")).toBe(true);
  });

  it("does not suppress on a reply", async () => {
    const cfg = baseConfig();
    await recordExternalEvent(
      { mailbox: "emma@example.com", cat: "reply", class: "cold_outbound", recipient: "ceo@bigco.com" },
      cfg,
      store,
    );
    const ledger = await loadLedger(store, "emma@example.com", cfg);
    expect(ledger.suppressed).toEqual([]);
    expect(ledger.events[0]?.cat).toBe("reply");
  });
});
