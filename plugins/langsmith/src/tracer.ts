import type { PluginConfig, LangSmithRun } from "./types.js";
import type { LangSmithClient } from "./client.js";
import { log } from "./logger.js";

// ── Internal types ──────────────────────────────────────────────────────────

interface ModelInfo {
  model: string;
  provider: string;
}

/** Subset of OpenClaw's AgentMessage we rely on for tracing. */
export type AgentMessage = {
  role?: string;
  content?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    total?: number; // older field name — fallback
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
  };
  stopReason?: string;
  toolCallId?: string;
  toolUseId?: string;
}

/** Fields from PluginHookAgentContext we forward into traces. */
export interface AgentContext {
  runId?: string;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
}

/** Subset of OpenClaw's PluginHookLlmInputEvent we rely on. */
export interface LlmInput {
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
}

interface RunRef {
  runId: string;
  traceId: string;
  dottedOrder: string;
  startTime: string;
}

interface ActiveToolRun extends RunRef {
  parentRunId?: string;
}

/**
 * Per-session turn state. Tracks everything needed to build the LangGraph-style
 * trace for one user turn (root chain + N LLM children + tool children).
 */
interface TurnState {
  root: RunRef & { tags: string[] };

  // Message buffer mirrors session state incrementally. Each LLM child run's
  // `inputs.messages` is a snapshot of this buffer at the time the assistant
  // message arrives. Starts as [system?, ...history, {role:user, content:prompt}].
  //
  // Trade-off: each LLM child run gets messageBuffer.slice() — the full context
  // at that call. For turns with many inner calls (heavy tool use), this means
  // the growing buffer is serialized N times at batch flush. Without compaction
  // or summarization the history can be large, making bandwidth scale with
  // O(history_size × calls_per_turn). Sessions with compaction/lossless-claw
  // keep history bounded so this is typically fine. A future optimization could
  // send only turn-local deltas on children (initial context lives on the root).
  messageBuffer: unknown[];

  // Most recent LLM child run — tool calls are parented under this.
  lastLlm?: RunRef;
  // Timestamp for the next LLM child run's start_time (set when the previous
  // LLM child or tool run completes).
  nextLlmStartTime?: string;

  activeToolRuns: Map<string, ActiveToolRun>;
  aggregatedUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  aggregatedCost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  provider?: string;
  model?: string;
  llmCallCount: number;
  imagesCount: number;

  // Agent context from PluginHookAgentContext — forwarded into run metadata.
  ctx: AgentContext;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseModelInfo(model: string, provider?: string): ModelInfo {
  if (provider) return { provider, model };
  if (model.includes("/")) {
    const [prov, ...rest] = model.split("/");
    return { provider: prov, model: rest.join("/") };
  }
  let inferredProvider = "unknown";
  if (model.startsWith("claude")) inferredProvider = "anthropic";
  else if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) inferredProvider = "openai";
  else if (model.startsWith("gemini")) inferredProvider = "google";
  else if (model.startsWith("glm")) inferredProvider = "zai";
  else if (model.startsWith("kimi")) inferredProvider = "kimi";
  return { provider: inferredProvider, model };
}

/**
 * Build tags from authoritative context fields, falling back to sessionKey
 * parsing when context fields aren't available.
 */
function extractTags(ctx: AgentContext, sessionKey: string, prompt?: string): string[] {
  const tags: string[] = [];

  // Agent identity
  if (ctx.agentId) tags.push(`agent:${ctx.agentId}`);

  // Source: prefer authoritative trigger/messageProvider from context
  if (ctx.trigger) {
    tags.push(`trigger:${ctx.trigger}`);
  }
  if (ctx.messageProvider) {
    tags.push(ctx.messageProvider);
  }
  if (ctx.channelId) {
    tags.push(`channel:${ctx.channelId}`);
  }

  // Fall back to sessionKey parsing when context fields are missing
  if (!ctx.trigger && !ctx.messageProvider) {
    const parts = sessionKey.split(":");
    if (parts.includes("cron")) {
      tags.push("cron");
      const cronIdx = parts.indexOf("cron");
      if (parts[cronIdx + 1]) tags.push(`job:${parts[cronIdx + 1]}`);
    } else if (parts.includes("discord")) {
      tags.push("discord");
    } else if (parts.includes("telegram")) {
      tags.push("telegram");
    } else if (parts.includes("slack")) {
      tags.push("slack");
    }
  }

  // Extract job/guild names from prompt (only available via regex)
  if (prompt && (ctx.trigger === "cron" || tags.includes("cron"))) {
    const cronMatch = prompt.match(/\[cron:\S+\s+([^(]+)\s*\(/);
    if (cronMatch?.[1]) tags.push(`name:${cronMatch[1].trim()}`);
  }
  if (prompt && (ctx.messageProvider === "discord" || tags.includes("discord"))) {
    const guildMatch = prompt.match(/\[Discord Guild (#\S+)/);
    if (guildMatch?.[1]) tags.push(`guild:${guildMatch[1]}`);
  }

  return tags;
}

function formatDottedOrderTime(date: Date): string {
  const pad = (n: number, len = 2) => n.toString().padStart(len, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${pad(date.getUTCMilliseconds(), 3)}000Z`;
}

function makeDottedOrder(runId: string, parentDottedOrder?: string): string {
  const ts = formatDottedOrderTime(new Date());
  const cleanId = runId.replace(/-/g, "");
  return parentDottedOrder ? `${parentDottedOrder}.${ts}${cleanId}` : `${ts}${cleanId}`;
}

/** Extract tool calls from an assistant message's content blocks. */
function extractToolCalls(msg: AgentMessage): Array<{ id: string; name?: string }> {
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  const calls: Array<{ id: string; name?: string }> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id) continue;
    const type = rec.type as string | undefined;
    if (type === "toolCall" || type === "toolUse" || type === "functionCall") {
      calls.push({ id: rec.id, name: typeof rec.name === "string" ? rec.name : undefined });
    }
  }
  return calls;
}

interface ExtractedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** Extract per-call usage from a single assistant message. */
function extractMessageUsage(msg: AgentMessage): ExtractedUsage | undefined {
  const usage = msg.usage;
  if (!usage) return undefined;
  const input = typeof usage.input === "number" ? usage.input : 0;
  const output = typeof usage.output === "number" ? usage.output : 0;
  const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
  const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
  const total = typeof usage.totalTokens === "number" ? usage.totalTokens
    : typeof usage.total === "number" ? usage.total
    : (input + output + cacheRead + cacheWrite);
  if (total === 0 && input === 0 && output === 0) return undefined;

  const cost = usage.cost;
  const hasCost = cost && typeof cost.total === "number" && cost.total > 0;

  return {
    input, output, cacheRead, cacheWrite, total,
    ...(hasCost && {
      cost: {
        input: cost!.input ?? 0,
        output: cost!.output ?? 0,
        cacheRead: cost!.cacheRead ?? 0,
        cacheWrite: cost!.cacheWrite ?? 0,
        total: cost!.total ?? 0,
      },
    }),
  };
}

/** Build metadata object shared across all runs in a turn. */
function buildSharedMetadata(sessionKey: string, ctx: AgentContext): Record<string, unknown> {
  return {
    sessionKey,
    thread_id: sessionKey,
    ...(ctx.runId && { openclawRunId: ctx.runId }),
    ...(ctx.agentId && { agentId: ctx.agentId }),
    ...(ctx.sessionId && { sessionId: ctx.sessionId }),
    ...(ctx.channelId && { channelId: ctx.channelId }),
    ...(ctx.messageProvider && { messageProvider: ctx.messageProvider }),
    ...(ctx.trigger && { trigger: ctx.trigger }),
  };
}

// ── Tracer ──────────────────────────────────────────────────────────────────

export class Tracer {
  private activeTurns = new Map<string, TurnState>();

  constructor(
    private readonly client: LangSmithClient,
    private readonly config: PluginConfig,
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────

  shutdown(): void {
    const endTime = new Date().toISOString();
    for (const [sessionKey, turn] of this.activeTurns) {
      this.closeTurn(turn, endTime, "Gateway shutdown");
      log.debug(`closed turn for ${sessionKey} on shutdown`);
    }
    this.activeTurns.clear();
  }

  onSessionStart(sessionKey: string): void {
    log.debug(`session started: ${sessionKey}`);
  }

  onSessionEnd(sessionKey: string): void {
    const turn = this.activeTurns.get(sessionKey);
    if (turn) {
      this.closeTurn(turn, new Date().toISOString(), "Session ended");
      this.activeTurns.delete(sessionKey);
    }
    log.debug(`session ended: ${sessionKey}`);
  }

  // ── Turn start (from llm_input) ─────────────────────────────────────────

  onTurnStart(sessionKey: string, event: LlmInput, ctx: AgentContext): void {
    try {
      const existing = this.activeTurns.get(sessionKey);
      if (existing) {
        // Compaction retry: llm_input fires again after preemptive compaction.
        // Close the previous root and start fresh with the new (compacted) state.
        this.closeTurn(existing, new Date().toISOString(), "Compacted and retried");
        this.activeTurns.delete(sessionKey);
        log.debug(`closed previous turn for ${sessionKey} (compaction retry)`);
      }

      const runId = crypto.randomUUID();
      const startTime = new Date().toISOString();
      const dottedOrder = makeDottedOrder(runId);
      const tags = extractTags(ctx, sessionKey, event.prompt);

      const messageBuffer: unknown[] = [];
      if (event.systemPrompt) {
        messageBuffer.push({ role: "system", content: event.systemPrompt });
      }
      if (event.historyMessages?.length > 0) {
        messageBuffer.push(...event.historyMessages);
      }
      messageBuffer.push({ role: "user", content: event.prompt });

      const turn: TurnState = {
        root: { runId, traceId: runId, dottedOrder, startTime, tags },
        messageBuffer,
        activeToolRuns: new Map(),
        aggregatedUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        aggregatedCost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        provider: event.provider,
        model: event.model,
        llmCallCount: 0,
        imagesCount: event.imagesCount,
        ctx,
      };
      this.activeTurns.set(sessionKey, turn);

      // Root is a chain — tokens live on LLM children only.
      const run: LangSmithRun = {
        id: runId,
        trace_id: runId,
        dotted_order: dottedOrder,
        name: ctx.agentId ? `agent_turn:${ctx.agentId}` : "agent_turn",
        run_type: "chain",
        inputs: { messages: messageBuffer.slice() },
        start_time: startTime,
        session_name: this.config.projectName,
        tags: tags.length > 0 ? tags : undefined,
        extra: { metadata: buildSharedMetadata(sessionKey, ctx) },
      };

      this.client.createRun(run);
      log.debug(`started turn ${runId} for session ${sessionKey} tags=${tags.join(",")}`);
    } catch (err) {
      log.warn(`failed to start turn: ${err}`);
    }
  }

  // ── Message write (from before_message_write) ──────────────────────────
  //
  // Known limitation: if another plugin's before_message_write handler returns
  // { block: true }, OpenClaw drops the message — but we've already appended it
  // to our buffer and (for assistant messages) created an LLM child run. This
  // would produce a "ghost" trace entry. In practice, blocking assistant messages
  // is extremely rare and would cause broader issues in the agent loop.

  onMessageWrite(sessionKey: string, msg: AgentMessage): void {
    const turn = this.activeTurns.get(sessionKey);
    if (!turn) return;

    try {
      if (msg.role === "assistant") {
        this.handleAssistantMessage(sessionKey, turn, msg);
      }
      turn.messageBuffer.push(msg);
    } catch (err) {
      log.warn(`failed to handle message write (role=${msg.role}): ${err}`);
    }
  }

  private handleAssistantMessage(sessionKey: string, turn: TurnState, msg: AgentMessage): void {
    turn.llmCallCount += 1;
    const callNum = turn.llmCallCount;
    const endTime = new Date().toISOString();
    const startTime = turn.nextLlmStartTime ?? turn.root.startTime;

    const runId = crypto.randomUUID();
    const traceId = turn.root.traceId;
    const dottedOrder = makeDottedOrder(runId, turn.root.dottedOrder);

    const modelInfo = parseModelInfo(turn.model ?? "unknown", turn.provider);
    const runName = `${modelInfo.provider}/${modelInfo.model}`;

    const usage = extractMessageUsage(msg);
    const inputTokens = usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0;
    const outputTokens = usage?.output ?? 0;
    const totalTokens = usage?.total ?? 0;

    if (usage) {
      turn.aggregatedUsage.input += usage.input;
      turn.aggregatedUsage.output += usage.output;
      turn.aggregatedUsage.cacheRead += usage.cacheRead;
      turn.aggregatedUsage.cacheWrite += usage.cacheWrite;
      turn.aggregatedUsage.total += usage.total;
      if (usage.cost) {
        turn.aggregatedCost.input += usage.cost.input;
        turn.aggregatedCost.output += usage.cost.output;
        turn.aggregatedCost.cacheRead += usage.cost.cacheRead;
        turn.aggregatedCost.cacheWrite += usage.cost.cacheWrite;
        turn.aggregatedCost.total += usage.cost.total;
      }
    }

    const hasCacheDetail = (usage?.cacheRead ?? 0) > 0 || (usage?.cacheWrite ?? 0) > 0;
    const usageMetadata = totalTokens > 0 ? {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: totalTokens,
      ...(hasCacheDetail && {
        input_token_details: {
          ...(usage!.cacheRead > 0 && { cache_read: usage!.cacheRead }),
          ...(usage!.cacheWrite > 0 && { cache_creation: usage!.cacheWrite }),
        },
      }),
    } : undefined;

    const toolCalls = extractToolCalls(msg);

    const run: LangSmithRun = {
      id: runId,
      trace_id: traceId,
      dotted_order: dottedOrder,
      name: runName,
      run_type: "llm",
      inputs: { messages: turn.messageBuffer.slice() },
      outputs: {
        messages: [msg],
        ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
        ...(usageMetadata && { usage_metadata: usageMetadata }),
      },
      parent_run_id: turn.root.runId,
      start_time: startTime,
      end_time: endTime,
      session_name: this.config.projectName,
      ...(totalTokens > 0 && {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: totalTokens,
      }),
      extra: {
        metadata: {
          ...buildSharedMetadata(sessionKey, turn.ctx),
          provider: modelInfo.provider,
          model: modelInfo.model,
          llmCallNumber: callNum,
          ...(turn.imagesCount > 0 && { imagesCount: turn.imagesCount }),
        },
        ...(totalTokens > 0 && {
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: totalTokens,
            ...(hasCacheDetail && {
              cache_read_input_tokens: usage!.cacheRead,
              cache_creation_input_tokens: usage!.cacheWrite,
            }),
          },
        }),
        ...(usage?.cost && { cost: usage.cost }),
      },
      tags: [`provider:${modelInfo.provider}`, `model:${modelInfo.model}`],
    };

    this.client.createRun(run);

    turn.lastLlm = { runId, traceId, dottedOrder, startTime };
    turn.nextLlmStartTime = endTime;

    log.debug(
      `traced LLM call #${callNum} ${runId} (${runName}, tokens=${totalTokens}, tools=${toolCalls.length})`,
    );
  }

  // ── Tool calls ─────────────────────────────────────────────────────────

  startToolRun(sessionKey: string, toolName: string, toolCallId: string, params: unknown): void {
    const turn = this.activeTurns.get(sessionKey);
    if (!turn) {
      log.debug(`no active turn for ${sessionKey}, skipping tool run`);
      return;
    }

    try {
      const runId = crypto.randomUUID();
      const startTime = new Date().toISOString();

      // Parent under the LLM call that invoked this tool. Fall back to root
      // if we haven't seen an assistant message yet (shouldn't happen in practice).
      const parent = turn.lastLlm ?? turn.root;
      const traceId = turn.root.traceId;
      const dottedOrder = makeDottedOrder(runId, parent.dottedOrder);

      turn.activeToolRuns.set(toolCallId, {
        runId,
        traceId,
        dottedOrder,
        startTime,
        parentRunId: parent.runId,
      });

      const run: LangSmithRun = {
        id: runId,
        trace_id: traceId,
        dotted_order: dottedOrder,
        name: toolName,
        run_type: "tool",
        inputs: { params },
        parent_run_id: parent.runId,
        start_time: startTime,
        session_name: this.config.projectName,
        extra: { metadata: buildSharedMetadata(sessionKey, turn.ctx) },
      };

      this.client.createRun(run);
      log.debug(`started tool run ${runId} (${toolName}) for toolCallId=${toolCallId}`);
    } catch (err) {
      log.warn(`failed to start tool run: ${err}`);
    }
  }

  endToolRun(sessionKey: string, toolCallId: string, result: unknown, error?: string, durationMs?: number): void {
    const turn = this.activeTurns.get(sessionKey);
    if (!turn) return;

    try {
      const active = turn.activeToolRuns.get(toolCallId);
      if (!active) {
        log.debug(`no active tool run for toolCallId=${toolCallId}`);
        return;
      }
      turn.activeToolRuns.delete(toolCallId);

      const endTime = new Date().toISOString();
      turn.nextLlmStartTime = endTime;

      const patch: Partial<LangSmithRun> = {
        id: active.runId,
        trace_id: active.traceId,
        dotted_order: active.dottedOrder,
        end_time: endTime,
        outputs: { result },
        ...(durationMs != null && { extra: { metadata: { durationMs } } }),
      };
      if (error) patch.error = error;

      this.client.updateRun(active.runId, patch);
      log.debug(`ended tool run ${active.runId}`);
    } catch (err) {
      log.warn(`failed to end tool run: ${err}`);
    }
  }

  // ── Turn end (from agent_end) ──────────────────────────────────────────

  onTurnEnd(sessionKey: string, success: boolean, durationMs?: number, error?: string): void {
    const turn = this.activeTurns.get(sessionKey);
    if (!turn) {
      log.debug(`no active turn for session ${sessionKey} at agent_end`);
      return;
    }

    try {
      this.activeTurns.delete(sessionKey);

      const endTime = new Date().toISOString();
      const modelInfo = parseModelInfo(turn.model ?? "unknown", turn.provider);
      const agg = turn.aggregatedUsage;

      const patch: Partial<LangSmithRun> = {
        id: turn.root.runId,
        trace_id: turn.root.traceId,
        dotted_order: turn.root.dottedOrder,
        end_time: endTime,
        outputs: {
          success,
          llmCallCount: turn.llmCallCount,
          ...(modelInfo.provider !== "unknown" && { model: modelInfo.model, provider: modelInfo.provider }),
          ...(agg.total > 0 && {
            usage_summary: {
              input_tokens: agg.input + agg.cacheRead + agg.cacheWrite,
              output_tokens: agg.output,
              total_tokens: agg.total,
              ...(agg.cacheRead > 0 && { cache_read_input_tokens: agg.cacheRead }),
              ...(agg.cacheWrite > 0 && { cache_creation_input_tokens: agg.cacheWrite }),
            },
          }),
          ...(turn.aggregatedCost.total > 0 && {
            cost_summary: turn.aggregatedCost,
          }),
        },
        extra: {
          metadata: {
            ...buildSharedMetadata(sessionKey, turn.ctx),
            durationMs,
            llmCallCount: turn.llmCallCount,
            ...(modelInfo.provider !== "unknown" && { model: modelInfo.model, provider: modelInfo.provider }),
          },
        },
        tags: [
          ...turn.root.tags,
          ...(modelInfo.provider !== "unknown" ? [`provider:${modelInfo.provider}`, `model:${modelInfo.model}`] : []),
        ],
      };

      if (!success) patch.error = error ?? "Agent turn failed";

      this.client.updateRun(turn.root.runId, patch);
      log.debug(
        `ended turn ${turn.root.runId} (calls=${turn.llmCallCount}, tokens=${agg.total}, duration=${durationMs}ms)`,
      );
    } catch (err) {
      log.warn(`failed to end turn: ${err}`);
    }
  }

  // ── Subagent ───────────────────────────────────────────────────────────

  onSubagentEnded(sessionKey: string, event: {
    targetSessionKey: string;
    targetKind?: string;
    reason: string;
    runId?: string;
    endedAt?: number;
    outcome?: string;
    error?: string;
  }): void {
    const turn = this.activeTurns.get(sessionKey);
    if (!turn) return;

    try {
      const runId = crypto.randomUUID();
      const dottedOrder = makeDottedOrder(runId, turn.root.dottedOrder);
      const now = new Date().toISOString();
      const endTime = event.endedAt ? new Date(event.endedAt).toISOString() : now;

      const run: LangSmithRun = {
        id: runId,
        trace_id: turn.root.traceId,
        dotted_order: dottedOrder,
        name: `subagent:${event.targetSessionKey}`,
        run_type: "chain",
        inputs: { targetSessionKey: event.targetSessionKey, targetKind: event.targetKind },
        outputs: { outcome: event.outcome, reason: event.reason },
        parent_run_id: turn.root.runId,
        start_time: now,
        end_time: endTime,
        session_name: this.config.projectName,
        error: event.error,
        extra: { metadata: { ...buildSharedMetadata(sessionKey, turn.ctx), subagentRunId: event.runId } },
      };

      this.client.createRun(run);
      log.debug(`traced subagent run ${runId} for ${sessionKey}`);
    } catch (err) {
      log.warn(`failed to trace subagent: ${err}`);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────

  /** Close all open runs in a turn and clean up. */
  private closeTurn(turn: TurnState, endTime: string, reason: string): void {
    for (const [, active] of turn.activeToolRuns) {
      try {
        this.client.updateRun(active.runId, {
          id: active.runId,
          trace_id: active.traceId,
          dotted_order: active.dottedOrder,
          end_time: endTime,
          outputs: { interrupted: true },
          error: reason,
        });
      } catch (_) { /* best effort */ }
    }

    try {
      this.client.updateRun(turn.root.runId, {
        id: turn.root.runId,
        trace_id: turn.root.traceId,
        dotted_order: turn.root.dottedOrder,
        end_time: endTime,
        outputs: { interrupted: true, llmCallCount: turn.llmCallCount },
        error: reason,
      });
    } catch (_) { /* best effort */ }
  }
}
