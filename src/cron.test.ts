import { describe, it, expect } from "vitest";
import {
  reconcileSelfLearnCron,
  MANAGED_NAME,
  MANAGED_TAG,
  REVIEW_PROMPT,
  buildDesired,
  diffPatch,
  isManaged,
  type CronAddInput,
  type CronJob,
  type CronService,
  type CronUpdateInput,
} from "./cron.js";

type Call =
  | { kind: "list"; opts?: { includeDisabled?: boolean } }
  | { kind: "add"; input: CronAddInput }
  | { kind: "update"; id: string; patch: CronUpdateInput }
  | { kind: "remove"; id: string };

function makeFakeCron(jobs: CronJob[]): { cron: CronService; calls: Call[] } {
  const calls: Call[] = [];
  let store = [...jobs];
  let nextId = 1000;
  const cron: CronService = {
    async list(opts) {
      calls.push({ kind: "list", opts });
      return [...store];
    },
    async add(input) {
      calls.push({ kind: "add", input });
      const id = `job-${nextId++}`;
      const job: CronJob = {
        id,
        name: input.name,
        description: input.description,
        enabled: input.enabled,
        schedule: input.schedule,
        sessionTarget: input.sessionTarget,
        wakeMode: input.wakeMode,
        payload: input.payload,
        delivery: input.delivery,
        createdAtMs: Date.now(),
      };
      store.push(job);
      return job;
    },
    async update(id, patch) {
      calls.push({ kind: "update", id, patch });
      const idx = store.findIndex((j) => j.id === id);
      if (idx < 0) throw new Error(`job not found: ${id}`);
      store[idx] = { ...store[idx], ...patch } as CronJob;
      return store[idx];
    },
    async remove(id) {
      calls.push({ kind: "remove", id });
      const before = store.length;
      store = store.filter((j) => j.id !== id);
      return { ok: true, removed: store.length < before };
    },
  };
  return { cron, calls };
}

const silentLogger = { info() {}, warn() {}, error() {} };

function makeManagedJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "j1",
    name: MANAGED_NAME,
    description: `${MANAGED_TAG} Periodic self-learned skill review`,
    enabled: true,
    schedule: { kind: "cron", expr: "0 */6 * * *" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: REVIEW_PROMPT },
    delivery: {
      mode: "announce",
      channel: "slack",
      to: "#emma-skills",
      bestEffort: true,
    },
    createdAtMs: 1_000,
    ...overrides,
  };
}

describe("reconcileSelfLearnCron", () => {
  it("returns 'unavailable' when cron service is null", async () => {
    const result = await reconcileSelfLearnCron({
      cron: null,
      config: { enabled: true, expr: "0 */6 * * *", slackChannel: "#emma-skills" },
      logger: silentLogger,
    });
    expect(result).toEqual({ status: "unavailable" });
  });

  it("adds the managed job when none exists", async () => {
    const { cron, calls } = makeFakeCron([]);
    const result = await reconcileSelfLearnCron({
      cron,
      config: { enabled: true, expr: "0 */6 * * *", slackChannel: "#emma-skills" },
      logger: silentLogger,
    });
    expect(result).toEqual({ status: "added" });
    const adds = calls.filter((c) => c.kind === "add");
    expect(adds).toHaveLength(1);
    const addCall = adds[0] as Extract<Call, { kind: "add" }>;
    expect(addCall.input.name).toBe(MANAGED_NAME);
    expect(addCall.input.sessionTarget).toBe("isolated");
    expect(addCall.input.wakeMode).toBe("now");
    expect(addCall.input.schedule).toEqual({ kind: "cron", expr: "0 */6 * * *" });
    expect(addCall.input.payload).toEqual({ kind: "agentTurn", message: REVIEW_PROMPT });
    expect(addCall.input.delivery).toEqual({
      mode: "announce",
      channel: "slack",
      to: "#emma-skills",
      bestEffort: true,
    });
  });

  it("does nothing when an up-to-date managed job already exists", async () => {
    const { cron, calls } = makeFakeCron([makeManagedJob()]);
    const result = await reconcileSelfLearnCron({
      cron,
      config: { enabled: true, expr: "0 */6 * * *", slackChannel: "#emma-skills" },
      logger: silentLogger,
    });
    expect(result).toEqual({ status: "noop" });
    expect(calls.some((c) => c.kind === "update")).toBe(false);
    expect(calls.some((c) => c.kind === "add")).toBe(false);
    expect(calls.some((c) => c.kind === "remove")).toBe(false);
  });

  it("updates the schedule when the cron expression drifts", async () => {
    const { cron, calls } = makeFakeCron([
      makeManagedJob({ schedule: { kind: "cron", expr: "0 */6 * * *" } }),
    ]);
    const result = await reconcileSelfLearnCron({
      cron,
      config: { enabled: true, expr: "*/2 * * * *" },
      logger: silentLogger,
    });
    expect(result).toEqual({ status: "updated" });
    const updates = calls.filter((c) => c.kind === "update");
    expect(updates).toHaveLength(1);
    const updateCall = updates[0] as Extract<Call, { kind: "update" }>;
    expect(updateCall.patch.schedule).toEqual({ kind: "cron", expr: "*/2 * * * *" });
    expect(updateCall.patch.payload).toBeUndefined();
    expect(updateCall.patch.sessionTarget).toBeUndefined();
  });

  it("removes duplicate managed jobs, keeping the oldest", async () => {
    const older = makeManagedJob({ id: "j-old", createdAtMs: 1_000 });
    const newer = makeManagedJob({ id: "j-new", createdAtMs: 5_000 });
    const { cron, calls } = makeFakeCron([newer, older]);
    const result = await reconcileSelfLearnCron({
      cron,
      config: { enabled: true, expr: "0 */6 * * *", slackChannel: "#emma-skills" },
      logger: silentLogger,
    });
    expect(result).toEqual({ status: "noop" });
    const removes = calls.filter((c) => c.kind === "remove") as Extract<Call, { kind: "remove" }>[];
    expect(removes).toHaveLength(1);
    expect(removes[0].id).toBe("j-new");
  });

  it("removes all managed jobs when enableCron is false", async () => {
    const a = makeManagedJob({ id: "j-a", createdAtMs: 1 });
    const b = makeManagedJob({ id: "j-b", createdAtMs: 2 });
    const { cron, calls } = makeFakeCron([a, b]);
    const result = await reconcileSelfLearnCron({
      cron,
      config: { enabled: false, expr: "0 */6 * * *" },
      logger: silentLogger,
    });
    expect(result).toEqual({ status: "disabled", removed: 2 });
    const removes = calls.filter((c) => c.kind === "remove") as Extract<Call, { kind: "remove" }>[];
    expect(new Set(removes.map((r) => r.id))).toEqual(new Set(["j-a", "j-b"]));
    expect(calls.some((c) => c.kind === "add")).toBe(false);
    expect(calls.some((c) => c.kind === "update")).toBe(false);
  });

  it("ignores non-managed jobs when reconciling", async () => {
    const foreign: CronJob = {
      id: "other",
      name: "some-other-job",
      description: "[other-plugin] something",
      enabled: true,
      schedule: { kind: "cron", expr: "0 0 * * *" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "..." },
      createdAtMs: 1,
    };
    const { cron, calls } = makeFakeCron([foreign]);
    const result = await reconcileSelfLearnCron({
      cron,
      config: { enabled: true, expr: "0 */6 * * *", slackChannel: "#emma-skills" },
      logger: silentLogger,
    });
    expect(result).toEqual({ status: "added" });
    expect(calls.some((c) => c.kind === "remove")).toBe(false);
  });

  it("matches managed jobs by name when description is missing the tag", async () => {
    const renamed = makeManagedJob({ description: undefined });
    expect(isManaged(renamed)).toBe(true);
  });

  it("buildDesired omits tz when undefined", () => {
    const desired = buildDesired({ expr: "0 */6 * * *" });
    expect(desired.schedule).toEqual({ kind: "cron", expr: "0 */6 * * *" });
    expect((desired.schedule as { tz?: string }).tz).toBeUndefined();
  });

  it("buildDesired includes tz when provided", () => {
    const desired = buildDesired({ expr: "0 */6 * * *", tz: "America/Vancouver" });
    expect(desired.schedule).toEqual({
      kind: "cron",
      expr: "0 */6 * * *",
      tz: "America/Vancouver",
    });
  });

  it("buildDesired omits delivery when slackChannel is unset", () => {
    const desired = buildDesired({ expr: "0 */6 * * *" });
    expect(desired.delivery).toBeUndefined();
  });

  it("buildDesired sets Slack announce delivery when slackChannel is provided", () => {
    const desired = buildDesired({ expr: "0 */6 * * *", slackChannel: "#emma-skills" });
    expect(desired.delivery).toEqual({
      mode: "announce",
      channel: "slack",
      to: "#emma-skills",
      bestEffort: true,
    });
  });

  it("diffPatch detects payload drift", () => {
    const desired = buildDesired({ expr: "0 */6 * * *", slackChannel: "#emma-skills" });
    const job = makeManagedJob({
      payload: { kind: "agentTurn", message: "stale prompt" },
    });
    const patch = diffPatch(job, desired);
    expect(patch?.payload).toEqual({ kind: "agentTurn", message: REVIEW_PROMPT });
  });

  it("diffPatch detects delivery destination drift", () => {
    const desired = buildDesired({ expr: "0 */6 * * *", slackChannel: "#emma-skills" });
    const job = makeManagedJob({
      delivery: {
        mode: "announce",
        channel: "slack",
        to: "#old-channel",
        bestEffort: true,
      },
    });
    const patch = diffPatch(job, desired);
    expect(patch?.delivery).toEqual({
      mode: "announce",
      channel: "slack",
      to: "#emma-skills",
      bestEffort: true,
    });
  });
});
