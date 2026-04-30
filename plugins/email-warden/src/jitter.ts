import type { JitterConfig, MailboxPolicy } from "./types.js";

export function sampleJitterSeconds(jitter: JitterConfig, rng: () => number = Math.random): number {
  if (!jitter.enabled) return 0;
  const raw =
    jitter.distribution === "lognormal"
      ? sampleLognormal(jitter.lognormal!.medianSeconds, jitter.lognormal!.sigma, rng)
      : sampleUniform(jitter.uniform!.minSeconds, jitter.uniform!.maxSeconds, rng);
  return clamp(raw, jitter.clampSeconds.min, jitter.clampSeconds.max);
}

export function maybeMicroPauseSeconds(jitter: JitterConfig, rng: () => number = Math.random): number {
  if (!jitter.enabled) return 0;
  if (rng() >= jitter.microPause.probability) return 0;
  const { min, max } = jitter.microPause.durationSeconds;
  return sampleUniform(min, max, rng);
}

function sampleLognormal(medianSeconds: number, sigma: number, rng: () => number): number {
  const mu = Math.log(medianSeconds);
  const u1 = Math.max(rng(), Number.EPSILON);
  const u2 = rng();
  const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.exp(mu + sigma * normal);
}

function sampleUniform(min: number, max: number, rng: () => number): number {
  return min + rng() * (max - min);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const DAY_TO_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export function nextOpenWorkingInstant(
  after: Date,
  policy: Pick<MailboxPolicy, "timezone" | "workingHours" | "workingDays">,
): Date {
  const { timezone, workingHours, workingDays } = policy;
  const workingDayIndices = new Set(workingDays.map((d) => DAY_TO_INDEX[d]));
  const [startH, startM] = parseHm(workingHours.start);
  const [endH, endM] = parseHm(workingHours.end);

  for (let offset = 0; offset < 14; offset++) {
    const candidate = addDays(after, offset);
    const parts = zonedParts(candidate, timezone);
    if (!workingDayIndices.has(parts.weekday)) continue;

    const startInstant = instantFromZonedParts(
      { year: parts.year, month: parts.month, day: parts.day, hour: startH, minute: startM },
      timezone,
    );
    const endInstant = instantFromZonedParts(
      { year: parts.year, month: parts.month, day: parts.day, hour: endH, minute: endM },
      timezone,
    );

    if (offset === 0 && after.getTime() < endInstant.getTime()) {
      return new Date(Math.max(after.getTime(), startInstant.getTime()));
    }
    if (offset > 0) {
      return startInstant;
    }
  }
  return after;
}

export function isWithinWorkingHours(
  at: Date,
  policy: Pick<MailboxPolicy, "timezone" | "workingHours" | "workingDays">,
): boolean {
  const next = nextOpenWorkingInstant(at, policy);
  return next.getTime() === at.getTime() || Math.abs(next.getTime() - at.getTime()) < 1000;
}

function parseHm(hm: string): [number, number] {
  const [h, m] = hm.split(":").map(Number) as [number, number];
  return [h, m];
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}

type ZonedParts = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

function zonedParts(d: Date, timezone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
    weekday: "short",
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdayMap[parts.weekday ?? "Sun"] ?? 0,
  };
}

function instantFromZonedParts(
  p: { year: number; month: number; day: number; hour: number; minute: number },
  timezone: string,
): Date {
  const utcGuess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
  const offsetMs = timezoneOffsetMs(new Date(utcGuess), timezone);
  return new Date(utcGuess - offsetMs);
}

function timezoneOffsetMs(d: Date, timezone: string): number {
  const zoned = zonedParts(d, timezone);
  const asUtcLocal = Date.UTC(zoned.year, zoned.month - 1, zoned.day, zoned.hour, zoned.minute);
  return asUtcLocal - d.getTime();
}
