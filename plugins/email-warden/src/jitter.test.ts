import { describe, expect, it } from "vitest";
import {
  isWithinWorkingHours,
  maybeMicroPauseSeconds,
  nextOpenWorkingInstant,
  sampleJitterSeconds,
} from "./jitter.js";
import { median, mulberry32 } from "./test-util.js";
import type { JitterConfig, MailboxPolicy } from "./types.js";

const baseJitter: JitterConfig = {
  enabled: true,
  distribution: "lognormal",
  lognormal: { medianSeconds: 140, sigma: 0.6 },
  clampSeconds: { min: 45, max: 900 },
  microPause: { probability: 0.04, durationSeconds: { min: 600, max: 2400 } },
  sendOutsideWorkingHours: "defer",
};

describe("sampleJitterSeconds", () => {
  it("returns 0 when disabled", () => {
    expect(sampleJitterSeconds({ ...baseJitter, enabled: false })).toBe(0);
  });

  it("clamps to [min, max]", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 500; i++) {
      const s = sampleJitterSeconds(baseJitter, rng);
      expect(s).toBeGreaterThanOrEqual(45);
      expect(s).toBeLessThanOrEqual(900);
    }
  });

  it("produces a sample median near the configured median for lognormal", () => {
    const rng = mulberry32(1337);
    const samples = Array.from({ length: 2000 }, () => sampleJitterSeconds(baseJitter, rng));
    const m = median(samples);
    // Median of a clamped lognormal with medianSeconds=140 should land well within
    // the [45, 900] clamp; tolerate ±30% for sampling noise.
    expect(m).toBeGreaterThan(140 * 0.7);
    expect(m).toBeLessThan(140 * 1.3);
  });

  it("produces a wider spread than uniform would at the same clamp", () => {
    const rng = mulberry32(7);
    const samples = Array.from({ length: 1000 }, () => sampleJitterSeconds(baseJitter, rng));
    const hi = samples.filter((s) => s > 300).length;
    const lo = samples.filter((s) => s < 100).length;
    // Lognormal's long right tail should put a non-trivial share above 300s
    // even though the median is 140s; a uniform [45,900] would land half above 472.
    // Expected ~10% above 300 and ~30% below 100 analytically; thresholds give
    // headroom for seed variance across any mulberry32 seed.
    expect(hi).toBeGreaterThan(60);
    expect(lo).toBeGreaterThan(150);
  });
});

describe("maybeMicroPauseSeconds", () => {
  it("returns 0 when disabled", () => {
    expect(maybeMicroPauseSeconds({ ...baseJitter, enabled: false })).toBe(0);
  });

  it("fires at approximately the configured probability", () => {
    const rng = mulberry32(99);
    let fired = 0;
    const N = 5000;
    for (let i = 0; i < N; i++) {
      if (maybeMicroPauseSeconds(baseJitter, rng) > 0) fired += 1;
    }
    const rate = fired / N;
    expect(rate).toBeGreaterThan(0.025);
    expect(rate).toBeLessThan(0.055);
  });

  it("stays within the configured duration range when it fires", () => {
    const rng = mulberry32(2);
    for (let i = 0; i < 1000; i++) {
      const s = maybeMicroPauseSeconds(baseJitter, rng);
      if (s === 0) continue;
      expect(s).toBeGreaterThanOrEqual(600);
      expect(s).toBeLessThanOrEqual(2400);
    }
  });
});

const vancouverPolicy: Pick<MailboxPolicy, "timezone" | "workingHours" | "workingDays"> = {
  timezone: "America/Vancouver",
  workingHours: { start: "09:00", end: "17:00" },
  workingDays: ["mon", "tue", "wed", "thu", "fri"],
};

describe("working-hours resolver", () => {
  it("returns the same instant when called during working hours", () => {
    // Tuesday 2026-04-28 14:00 Vancouver = 21:00 UTC (PDT, UTC-7)
    const at = new Date("2026-04-28T21:00:00Z");
    const next = nextOpenWorkingInstant(at, vancouverPolicy);
    expect(next.getTime()).toBe(at.getTime());
    expect(isWithinWorkingHours(at, vancouverPolicy)).toBe(true);
  });

  it("advances a Friday evening to the following Monday morning", () => {
    // Friday 2026-04-24 18:00 Vancouver = 2026-04-25T01:00:00Z
    const fridayEvening = new Date("2026-04-25T01:00:00Z");
    const next = nextOpenWorkingInstant(fridayEvening, vancouverPolicy);
    // Expect Monday 2026-04-27 09:00 Vancouver = 2026-04-27T16:00:00Z
    expect(next.toISOString()).toBe("2026-04-27T16:00:00.000Z");
  });

  it("advances a Saturday to Monday", () => {
    const saturday = new Date("2026-04-25T18:00:00Z");
    const next = nextOpenWorkingInstant(saturday, vancouverPolicy);
    expect(next.toISOString()).toBe("2026-04-27T16:00:00.000Z");
  });

  it("bumps pre-opening calls to today's opening", () => {
    // Tuesday 06:00 Vancouver = 13:00 UTC (before 09:00 open)
    const earlyTuesday = new Date("2026-04-28T13:00:00Z");
    const next = nextOpenWorkingInstant(earlyTuesday, vancouverPolicy);
    expect(next.toISOString()).toBe("2026-04-28T16:00:00.000Z");
  });

  it("rejects outside-hours as not within working hours", () => {
    const saturday = new Date("2026-04-25T18:00:00Z");
    expect(isWithinWorkingHours(saturday, vancouverPolicy)).toBe(false);
  });
});
