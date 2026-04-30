import { describe, expect, it } from "vitest";
import { evaluateTripwires } from "./tripwires.js";
import type { LedgerEvent, MailboxLedger, PluginConfig, TrafficClass } from "./types.js";

function emptyLedger(): MailboxLedger {
  return {
    version: 1,
    mailbox: "emma@example.com",
    tier: "gws-standard",
    timezone: "UTC",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-24T12:00:00Z",
    warmup: { stage: 0, plateauReachedAt: null },
    aggregates: { daily: {}, monthly: {}, perRecipientDomain: {} },
    lastCallAt: {},
    lastCooldownAt: {},
    suppressed: [],
    events: [],
  };
}

function mkSend(t: string, cls: TrafficClass = "cold_outbound", recipient = "x@acme.com"): LedgerEvent {
  return { t, cat: "send", class: cls, cost: 1, result: "ok", recipient };
}

function mkBounce(t: string, cls: TrafficClass = "cold_outbound", recipient?: string): LedgerEvent {
  return { t, cat: "bounce", class: cls, cost: 0, result: "observed", recipient };
}

function mkOutcome(
  t: string,
  cat: "bounce" | "reply" | "complaint",
  recipient: string,
  cls: TrafficClass = "cold_outbound",
): LedgerEvent {
  return { t, cat, class: cls, cost: 0, result: "observed", recipient };
}

function cfgWith(tripwires: PluginConfig["tripwires"]): PluginConfig {
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
    tripwires,
    suppression: { scope: "global", honorUnsubscribeWithinHours: 48 },
    retention: { maxEvents: 1000, dailyRetentionDays: 90, perDomainRetentionDays: 14 },
    alerts: { onPause: true, onDailyRollup: true },
    ingestion: { adapters: [] },
  };
}

describe("evaluateTripwires — time-window", () => {
  const now = new Date("2026-04-24T15:00:00Z");

  it("does not fire when volume is below minSends", () => {
    const ledger = emptyLedger();
    for (let i = 0; i < 10; i++) {
      ledger.events.push(mkSend(new Date(now.getTime() - i * 60_000).toISOString()));
    }
    ledger.events.push(mkBounce(new Date(now.getTime() - 30 * 60_000).toISOString()));

    const hits = evaluateTripwires(
      ledger,
      cfgWith({
        bounceRate48h: {
          classes: ["cold_outbound"],
          window: { hours: 48, minSends: 20 },
          maxRate: 0.05,
          action: "pause-mailbox",
        },
      }),
      now,
    );
    expect(hits).toEqual([]);
  });

  it("fires when bounce rate exceeds maxRate over the window", () => {
    const ledger = emptyLedger();
    // 50 sends, 5 bounces = 10% (well above 5% threshold)
    for (let i = 0; i < 50; i++) {
      ledger.events.push(mkSend(new Date(now.getTime() - i * 60_000).toISOString()));
    }
    for (let i = 0; i < 5; i++) {
      ledger.events.push(mkBounce(new Date(now.getTime() - (i + 1) * 30 * 60_000).toISOString()));
    }

    const hits = evaluateTripwires(
      ledger,
      cfgWith({
        bounceRate48h: {
          classes: ["cold_outbound"],
          window: { hours: 48, minSends: 20 },
          maxRate: 0.05,
          action: "pause-mailbox",
        },
      }),
      now,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.action).toBe("pause-mailbox");
    expect(hits[0]?.name).toBe("bounceRate48h");
  });

  it("respects class filter — personal events don't trip a cold-only rule", () => {
    const ledger = emptyLedger();
    // All traffic is `personal`, not `cold_outbound`
    for (let i = 0; i < 50; i++) {
      ledger.events.push(mkSend(new Date(now.getTime() - i * 60_000).toISOString(), "personal"));
    }
    for (let i = 0; i < 10; i++) {
      ledger.events.push(mkBounce(new Date(now.getTime() - (i + 1) * 30 * 60_000).toISOString(), "personal"));
    }

    const hits = evaluateTripwires(
      ledger,
      cfgWith({
        bounceRate48h: {
          classes: ["cold_outbound"],
          window: { hours: 48, minSends: 20 },
          maxRate: 0.05,
          action: "pause-mailbox",
        },
      }),
      now,
    );
    expect(hits).toEqual([]);
  });

  it("fires a minRate violation (reply-rate floor alert)", () => {
    const ledger = emptyLedger();
    // 100 sends, 0 replies over the last hour — well below the 1% floor
    for (let i = 0; i < 100; i++) {
      ledger.events.push(mkSend(new Date(now.getTime() - i * 30_000).toISOString()));
    }
    const hits = evaluateTripwires(
      ledger,
      cfgWith({
        replyRateFloor: {
          classes: ["cold_outbound"],
          window: { hours: 24, minSends: 20 },
          minRate: 0.01,
          action: "alert",
        },
      }),
      now,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.action).toBe("alert");
  });
});

describe("evaluateTripwires — sends-window", () => {
  const now = new Date("2026-04-24T15:00:00Z");

  function ts(secondsAgo: number): string {
    return new Date(now.getTime() - secondsAgo * 1000).toISOString();
  }

  it("does not fire when fewer than N sends are present", () => {
    const ledger = emptyLedger();
    for (let i = 0; i < 30; i++) {
      ledger.events.push(mkSend(ts(i * 60), "cold_outbound", `r${i}@acme.com`));
    }
    const hits = evaluateTripwires(
      ledger,
      cfgWith({
        bounceRate: {
          classes: ["cold_outbound"],
          window: { sends: 100 },
          maxRate: 0.02,
          action: "pause-mailbox",
        },
      }),
      now,
    );
    expect(hits).toEqual([]);
  });

  it("attributes a bounce to the most recent prior send to the same recipient", () => {
    const ledger = emptyLedger();
    // 100 sends, each to a unique recipient. Recipients r0..r2 (the most recent
    // three) bounce — a 3% bounce rate, above the 2% cap.
    for (let i = 0; i < 100; i++) {
      ledger.events.push(mkSend(ts(i * 60), "cold_outbound", `r${i}@acme.com`));
    }
    // Bounces arrived shortly after their corresponding sends. Push them onto
    // the events array preserving descending-time order.
    ledger.events.unshift(mkOutcome(ts(0.5), "bounce", "r0@acme.com"));
    ledger.events.unshift(mkOutcome(ts(0.4), "bounce", "r1@acme.com"));
    ledger.events.unshift(mkOutcome(ts(0.3), "bounce", "r2@acme.com"));

    const hits = evaluateTripwires(
      ledger,
      cfgWith({
        bounceRate: {
          classes: ["cold_outbound"],
          window: { sends: 100 },
          maxRate: 0.02,
          action: "pause-mailbox",
        },
      }),
      now,
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]?.action).toBe("pause-mailbox");
    expect(hits[0]?.message).toMatch(/3\.00% > 2\.00% over 100 sends/);
  });

  it("does not double-attribute a single bounce when a recipient is sent to twice", () => {
    const ledger = emptyLedger();
    // Send to r@acme.com twice; only the most recent send owns the bounce.
    // Fill the rest of the window with bounce-free sends so we can read the rate.
    for (let i = 2; i < 100; i++) {
      ledger.events.push(mkSend(ts(i * 60), "cold_outbound", `clean${i}@acme.com`));
    }
    // Earliest send to r@acme.com (older).
    ledger.events.unshift(mkSend(ts(50 * 60), "cold_outbound", "r@acme.com"));
    // The bounce that arrived between the two sends.
    ledger.events.unshift(mkOutcome(ts(40 * 60), "bounce", "r@acme.com"));
    // Most recent send to r@acme.com — supersedes the earlier one for attribution.
    ledger.events.unshift(mkSend(ts(30 * 60), "cold_outbound", "r@acme.com"));

    // Window is now exactly 100 ok sends. No bounces should be attributed —
    // the bounce belongs to the older send (which is the *prior* send at the
    // moment the bounce arrived) but no further bounce arrived after the
    // re-send. Net: 1 bounce attributed across the 100-send window.
    const hits = evaluateTripwires(
      ledger,
      cfgWith({
        bounceRate: {
          classes: ["cold_outbound"],
          window: { sends: 100 },
          maxRate: 0.005, // 0.5% — 1/100 = 1% trips, would not double-trip on duplicate
          action: "pause-mailbox",
        },
      }),
      now,
    );

    expect(hits).toHaveLength(1);
    expect(hits[0]?.message).toMatch(/1\.00% > 0\.50% over 100 sends/);
  });

  it("does not fire when bounces are below the cap", () => {
    const ledger = emptyLedger();
    for (let i = 0; i < 100; i++) {
      ledger.events.push(mkSend(ts(i * 60), "cold_outbound", `r${i}@acme.com`));
    }
    // 1 bounce / 100 sends = 1%, below the 2% cap.
    ledger.events.unshift(mkOutcome(ts(0.5), "bounce", "r0@acme.com"));

    const hits = evaluateTripwires(
      ledger,
      cfgWith({
        bounceRate: {
          classes: ["cold_outbound"],
          window: { sends: 100 },
          maxRate: 0.02,
          action: "pause-mailbox",
        },
      }),
      now,
    );
    expect(hits).toEqual([]);
  });

  it("scopes outcomes to matching classes — a personal-class bounce doesn't trip a cold-only rule", () => {
    const ledger = emptyLedger();
    // 100 cold sends, 0 cold bounces.
    for (let i = 0; i < 100; i++) {
      ledger.events.push(mkSend(ts(i * 60), "cold_outbound", `cold${i}@acme.com`));
    }
    // A personal send to the same recipient followed by a bounce — outside the
    // cold class, must not count toward the cold tripwire.
    ledger.events.unshift(mkSend(ts(2), "personal", "p@acme.com"));
    ledger.events.unshift(mkOutcome(ts(1), "bounce", "p@acme.com", "personal"));

    const hits = evaluateTripwires(
      ledger,
      cfgWith({
        bounceRate: {
          classes: ["cold_outbound"],
          window: { sends: 100 },
          maxRate: 0.02,
          action: "pause-mailbox",
        },
      }),
      now,
    );
    expect(hits).toEqual([]);
  });

  it("counts replies for a reply-rate-floor tripwire", () => {
    const ledger = emptyLedger();
    // 200 sends, 1 reply = 0.5%, below the 1% floor → fires
    for (let i = 0; i < 200; i++) {
      ledger.events.push(mkSend(ts(i * 30), "cold_outbound", `r${i}@acme.com`));
    }
    ledger.events.unshift(mkOutcome(ts(0.5), "reply", "r0@acme.com"));

    const hits = evaluateTripwires(
      ledger,
      cfgWith({
        replyRateFloor: {
          classes: ["cold_outbound"],
          window: { sends: 200 },
          minRate: 0.01,
          action: "alert",
        },
      }),
      now,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.action).toBe("alert");
  });

  it("ignores outcomes whose originating send was evicted from the events log", () => {
    const ledger = emptyLedger();
    // 100 cold sends with no bounces.
    for (let i = 0; i < 100; i++) {
      ledger.events.push(mkSend(ts(i * 60), "cold_outbound", `r${i}@acme.com`));
    }
    // An orphan bounce: there's no prior send to ghost@acme.com in the window.
    ledger.events.unshift(mkOutcome(ts(0.5), "bounce", "ghost@acme.com"));

    const hits = evaluateTripwires(
      ledger,
      cfgWith({
        bounceRate: {
          classes: ["cold_outbound"],
          window: { sends: 100 },
          maxRate: 0.005,
          action: "pause-mailbox",
        },
      }),
      now,
    );
    expect(hits).toEqual([]);
  });
});
