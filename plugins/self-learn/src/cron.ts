/**
 * Reconciliation logic for the self-learn plugin's gateway-managed cron job.
 *
 * Replaces the prior HEARTBEAT.md-based approach. The plugin registers a single
 * managed cron job tagged with `[self-learn]` in its description; on every
 * gateway_start we re-list, dedupe, and patch the job to match desired config.
 *
 * Types are declared locally (matching the on-the-wire SDK shape) so this
 * file doesn't depend on which subpath the upgraded openclaw SDK exposes its
 * cron types under.
 */

export const MANAGED_NAME = "self-learn-review";
export const MANAGED_TAG = "[self-learn]";
export const DEFAULT_CRON_EXPR = "0 */6 * * *";
export const LEGACY_HEARTBEAT_MARKER = "# self-learn-plugin heartbeat task";

export const REVIEW_PROMPT = [
  "Periodic self-learn skill review. Run TWO checks and report findings:",
  "",
  "(1) CONFLICT CHECK — self-learned vs built-in skills.",
  "  - List self-learned skills: skill_manage(action='list').",
  "  - List the workspace skills directory contents (e.g. `ls skills/`) and identify",
  "    built-in / non-self-learned skill directories (those WITHOUT the 'self-learned-' prefix).",
  "  - For each self-learned skill, read its frontmatter description (skill_manage(action='view'))",
  "    and the built-in skill's description (read the skill's SKILL.md frontmatter directly).",
  "  - A conflict = both skills cover the same workflow / would plausibly be invoked for the same task.",
  "  - For each conflict, capture: <self-learned-name> vs <built-in-name>, the overlap in one line,",
  "    and a recommended action (merge into built-in, delete self-learned, rename, or scope-down).",
  "",
  "(2) IMPROVEMENT CHECK — incomplete or improvable self-learned skills.",
  "  - For each self-learned skill, use the memory tools available to you (e.g. memory_search) to",
  "    query recent session history for activity that touches the skill's topic.",
  "  - Identify gaps: missing steps the agent had to figure out, outdated commands, gotchas the",
  "    agent hit in recent sessions but aren't captured in the skill.",
  "  - For each improvable skill, capture: <skill-name>, the gap in one line, and a specific patch",
  "    recommendation (use skill_manage(action='patch') in a follow-up session if needed).",
  "",
  "OUTPUT RULES:",
  "  - If BOTH checks find zero issues → reply with exactly `HEARTBEAT_OK` and nothing else.",
  "    This suppresses delivery.",
  "  - Otherwise → reply with a concise summary structured as:",
  "      Self-learned skill review",
  "      Conflicts:",
  "      - <self-learned> vs <built-in> — <overlap>. Action: <merge|delete|rename|scope-down>.",
  "      Improvements:",
  "      - <skill-name> — <gap>. Patch: <specific suggestion>.",
  "    Omit a section entirely if it has no findings. Keep it terse.",
].join("\n");

// ---------------------------------------------------------------------------
// Minimal cron service types — match the SDK's on-the-wire shape.

export type CronSchedule = { kind: "cron"; expr: string; tz?: string };

export type CronPayloadAgentTurn = { kind: "agentTurn"; message: string };

export type CronDelivery = {
  mode: "announce" | "none" | "webhook";
  channel?: string;
  to?: string;
  bestEffort?: boolean;
};

export type CronJob = {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  schedule: { kind: string; expr?: string; tz?: string };
  sessionTarget?: string;
  wakeMode?: string;
  payload?: { kind: string; message?: string; text?: string };
  delivery?: CronDelivery;
  createdAtMs: number;
};

export type CronAddInput = {
  name: string;
  description?: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "isolated" | "main";
  wakeMode: "now" | "next-heartbeat";
  payload: CronPayloadAgentTurn;
  delivery?: CronDelivery;
};

export type CronUpdateInput = Partial<Omit<CronAddInput, "payload">> & {
  payload?: CronPayloadAgentTurn;
};

export interface CronService {
  list(opts?: { includeDisabled?: boolean }): Promise<CronJob[]>;
  add(input: CronAddInput): Promise<CronJob>;
  update(id: string, patch: CronUpdateInput): Promise<CronJob>;
  remove(id: string): Promise<{ ok: boolean; removed: boolean }>;
}

export interface ReconcileLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

// ---------------------------------------------------------------------------
// Pure helpers.

export type ReconcileConfig = {
  enabled: boolean;
  expr: string;
  tz?: string;
  /** Slack channel destination, e.g. "#emma-skills". When set, the cron's */
  /** reply is announced to this channel; the agent uses HEARTBEAT_OK to suppress. */
  slackChannel?: string;
};

export type ReconcileResult =
  | { status: "unavailable" }
  | { status: "disabled"; removed: number }
  | { status: "added" }
  | { status: "updated" }
  | { status: "noop" };

export function buildDesired(config: {
  expr: string;
  tz?: string;
  slackChannel?: string;
}): CronAddInput {
  const schedule: CronSchedule = { kind: "cron", expr: config.expr };
  if (config.tz) schedule.tz = config.tz;
  const input: CronAddInput = {
    name: MANAGED_NAME,
    description: `${MANAGED_TAG} Periodic self-learned skill review`,
    enabled: true,
    schedule,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: REVIEW_PROMPT },
  };
  if (config.slackChannel) {
    input.delivery = {
      mode: "announce",
      channel: "slack",
      to: config.slackChannel,
      bestEffort: true,
    };
  }
  return input;
}

export function isManaged(job: CronJob): boolean {
  if (
    typeof job.description === "string" &&
    job.description.includes(MANAGED_TAG)
  )
    return true;
  return job.name === MANAGED_NAME;
}

export function diffPatch(
  job: CronJob,
  desired: CronAddInput,
): CronUpdateInput | null {
  const patch: CronUpdateInput = {};

  if (job.enabled !== true) patch.enabled = true;
  if (job.description !== desired.description)
    patch.description = desired.description;
  if (job.name !== desired.name) patch.name = desired.name;

  const sameSchedule =
    job.schedule?.kind === "cron" &&
    job.schedule.expr === desired.schedule.expr &&
    (job.schedule.tz ?? undefined) === (desired.schedule.tz ?? undefined);
  if (!sameSchedule) patch.schedule = desired.schedule;

  if (job.sessionTarget !== desired.sessionTarget)
    patch.sessionTarget = desired.sessionTarget;
  if (job.wakeMode !== desired.wakeMode) patch.wakeMode = desired.wakeMode;

  const samePayload =
    job.payload?.kind === "agentTurn" &&
    job.payload.message === desired.payload.message;
  if (!samePayload) patch.payload = desired.payload;

  const desiredDelivery = desired.delivery;
  const jobDelivery = job.delivery;
  const sameDelivery =
    (!desiredDelivery && !jobDelivery) ||
    (!!desiredDelivery &&
      !!jobDelivery &&
      jobDelivery.mode === desiredDelivery.mode &&
      (jobDelivery.channel ?? undefined) === (desiredDelivery.channel ?? undefined) &&
      (jobDelivery.to ?? undefined) === (desiredDelivery.to ?? undefined) &&
      (jobDelivery.bestEffort ?? undefined) === (desiredDelivery.bestEffort ?? undefined));
  if (!sameDelivery) patch.delivery = desiredDelivery;

  return Object.keys(patch).length === 0 ? null : patch;
}

// ---------------------------------------------------------------------------
// Reconciler.

export async function reconcileSelfLearnCron(params: {
  cron: CronService | null;
  config: ReconcileConfig;
  logger: ReconcileLogger;
}): Promise<ReconcileResult> {
  const { cron, config, logger } = params;
  if (!cron) return { status: "unavailable" };

  const all = await cron.list({ includeDisabled: true });
  const mine = all.filter(isManaged);

  if (!config.enabled) {
    let removed = 0;
    for (const job of mine) {
      try {
        const res = await cron.remove(job.id);
        if (res.removed) removed++;
      } catch (err) {
        logger.warn(`failed to remove cron job ${job.id}: ${String(err)}`);
      }
    }
    return { status: "disabled", removed };
  }

  const desired = buildDesired(config);

  if (mine.length === 0) {
    await cron.add(desired);
    return { status: "added" };
  }

  const sorted = [...mine].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const [primary, ...dupes] = sorted;
  if (!primary) {
    logger.warn("no primary cron job found");
    return { status: "noop" };
  }
  for (const d of dupes) {
    try {
      await cron.remove(d.id);
    } catch (err) {
      logger.warn(
        `failed to remove duplicate cron job ${d.id}: ${String(err)}`,
      );
    }
  }

  const patch = diffPatch(primary, desired);
  if (!patch) return { status: "noop" };
  await cron.update(primary.id, patch);
  return { status: "updated" };
}
