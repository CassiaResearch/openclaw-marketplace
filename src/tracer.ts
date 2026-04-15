import type { PluginConfig, LangSmithRun, LlmInputEvent, LlmOutputEvent, TokenUsage, ModelInfo } from "./types.js";
import type { LangSmithClient } from "./client.js";
import { log } from "./logger.js";

interface ActiveRun {
  runId: string;
  traceId: string;
  dottedOrder: string;
  parentRunId?: string;
  startTime: string;
  tags?: string[];
  sessionKey: string;
  assembledPrompt?: Record<string, unknown>;
}

/**
 * Parse model info from event data
 *
 * Priority:
 * 1. If provider is explicitly provided in the event, use it directly
 * 2. If model string contains "/" (e.g., "anthropic/claude-opus-4-5"), parse it
 * 3. Fallback: infer from model name patterns (last resort)
 */
function parseModelInfo(model: string, provider?: string): ModelInfo {
  if (provider) {
    return { provider, model };
  }

  if (model.includes("/")) {
    const [prov, ...rest] = model.split("/");
    return { provider: prov, model: rest.join("/") };
  }

  let inferredProvider = "unknown";
  if (model.startsWith("claude")) {
    inferredProvider = "anthropic";
  } else if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3")) {
    inferredProvider = "openai";
  } else if (model.startsWith("gemini")) {
    inferredProvider = "google";
  } else if (model.startsWith("glm")) {
    inferredProvider = "zai";
  } else if (model.startsWith("kimi")) {
    inferredProvider = "kimi";
  }

  return { provider: inferredProvider, model };
}

/** Extract tags from session key and prompt for LangSmith filtering */
function extractTags(sessionKey: string, prompt?: string): string[] {
  const tags: string[] = [];

  const parts = sessionKey.split(":");
  if (parts.includes("cron")) {
    tags.push("cron");
    const cronIdx = parts.indexOf("cron");
    if (parts[cronIdx + 1]) {
      tags.push(`job:${parts[cronIdx + 1]}`);
    }
  } else if (parts.includes("discord")) {
    tags.push("discord");
    const channelIdx = parts.indexOf("channel");
    if (channelIdx >= 0 && parts[channelIdx + 1]) {
      tags.push(`channel:${parts[channelIdx + 1]}`);
    }
  } else if (parts.includes("telegram")) {
    tags.push("telegram");
  } else if (parts.includes("slack")) {
    tags.push("slack");
  }

  if (prompt && tags.includes("cron")) {
    const cronMatch = prompt.match(/\[cron:[^\s]+\s+([^\(]+)\s*\(/);
    if (cronMatch?.[1]) {
      tags.push(`name:${cronMatch[1].trim()}`);
    }
  }

  if (prompt && tags.includes("discord")) {
    const guildMatch = prompt.match(/\[Discord Guild (#[^\s]+)/);
    if (guildMatch?.[1]) {
      tags.push(`guild:${guildMatch[1]}`);
    }
  }

  return tags;
}

/** Create dotted_order timestamp format: YYYYMMDDTHHMMSSssssssZ */
function formatDottedOrderTime(date: Date): string {
  const pad = (n: number, len = 2) => n.toString().padStart(len, "0");
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}${pad(date.getUTCMilliseconds(), 3)}000Z`;
}

/** Create dotted_order: for root runs it's timestamp+runId, for child runs it's parent.timestamp+runId */
function makeDottedOrder(runId: string, parentDottedOrder?: string): string {
  const ts = formatDottedOrderTime(new Date());
  const cleanId = runId.replace(/-/g, "");
  if (parentDottedOrder) {
    return `${parentDottedOrder}.${ts}${cleanId}`;
  }
  return `${ts}${cleanId}`;
}

export class Tracer {
  // All state is keyed by sessionKey — no singletons — so concurrent sessions never cross-pollinate.
  private activeAgentRuns = new Map<string, ActiveRun>();
  private activeToolRuns = new Map<string, ActiveRun>();
  // toolCallId → runId: OpenClaw creates fresh event objects per hook phase, so we track the mapping ourselves
  private pendingToolRuns = new Map<string, string>();
  // Keyed by OpenClaw runId so llm_input/llm_output pair by identity, not arrival order
  private pendingMainLlmRuns = new Map<string, ActiveRun & { llmInput: LlmInputEvent }>();
  private sessionModels = new Map<string, ModelInfo[]>();

  constructor(
    private readonly client: LangSmithClient,
    private readonly config: PluginConfig,
  ) {}

  /** Close all open runs and clear state. Called during graceful shutdown. */
  shutdown(): void {
    const endTime = new Date().toISOString();

    // End any in-flight agent runs so they don't appear as permanently "running"
    for (const [sessionKey, active] of this.activeAgentRuns) {
      try {
        this.client.updateRun(active.runId, {
          id: active.runId,
          trace_id: active.traceId,
          dotted_order: active.dottedOrder,
          end_time: endTime,
          outputs: { interrupted: true },
          error: "Gateway shutdown",
        });
        log.debug(`closed agent run ${active.runId} for ${sessionKey} on shutdown`);
      } catch (_) { /* best effort */ }
    }

    // End any in-flight tool runs
    for (const [, active] of this.activeToolRuns) {
      try {
        this.client.updateRun(active.runId, {
          id: active.runId,
          trace_id: active.traceId,
          dotted_order: active.dottedOrder,
          end_time: endTime,
          outputs: { interrupted: true },
          error: "Gateway shutdown",
        });
      } catch (_) { /* best effort */ }
    }

    this.activeAgentRuns.clear();
    this.activeToolRuns.clear();
    this.pendingToolRuns.clear();
    this.pendingMainLlmRuns.clear();
    this.sessionModels.clear();
  }

  onSessionStart(sessionKey: string): void {
    log.debug(`session started: ${sessionKey}`);
  }

  onSessionEnd(sessionKey: string): void {
    const endTime = new Date().toISOString();

    // Close any in-flight agent run so it doesn't appear permanently "running" in LangSmith
    const agentRun = this.activeAgentRuns.get(sessionKey);
    if (agentRun) {
      try {
        this.client.updateRun(agentRun.runId, {
          id: agentRun.runId,
          trace_id: agentRun.traceId,
          dotted_order: agentRun.dottedOrder,
          end_time: endTime,
          outputs: { interrupted: true },
          error: "Session ended",
        });
      } catch (_) { /* best effort */ }
      this.activeAgentRuns.delete(sessionKey);
    }

    // Close any in-flight tool runs belonging to this session
    const toolRunIds = [...this.activeToolRuns.entries()]
      .filter(([, run]) => run.sessionKey === sessionKey)
      .map(([id]) => id);
    for (const id of toolRunIds) {
      const run = this.activeToolRuns.get(id)!;
      try {
        this.client.updateRun(run.runId, {
          id: run.runId,
          trace_id: run.traceId,
          dotted_order: run.dottedOrder,
          end_time: endTime,
          outputs: { interrupted: true },
          error: "Session ended",
        });
      } catch (_) { /* best effort */ }
      this.activeToolRuns.delete(id);
    }

    // Clean up pending mappings for removed tool runs
    const staleToolCallIds = [...this.pendingToolRuns.entries()]
      .filter(([, runId]) => !this.activeToolRuns.has(runId))
      .map(([toolCallId]) => toolCallId);
    for (const id of staleToolCallIds) this.pendingToolRuns.delete(id);

    // Clean up pending LLM runs belonging to this session
    const staleLlmRunIds = [...this.pendingMainLlmRuns.entries()]
      .filter(([, run]) => run.sessionKey === sessionKey)
      .map(([id]) => id);
    for (const id of staleLlmRunIds) this.pendingMainLlmRuns.delete(id);

    this.sessionModels.delete(sessionKey);

    log.debug(`session ended: ${sessionKey}`);
  }

  capturePromptBuild(sessionKey: string, event: Record<string, unknown>): void {
    const active = this.activeAgentRuns.get(sessionKey);
    if (!active) return;
    active.assembledPrompt = event;
    log.debug(`captured prompt build for ${sessionKey}`);
  }

  onSubagentEnded(sessionKey: string, event: Record<string, unknown>): void {
    const parent = this.activeAgentRuns.get(sessionKey);
    if (!parent) return;

    try {
      const runId = crypto.randomUUID();
      const dottedOrder = makeDottedOrder(runId, parent.dottedOrder);

      const now = new Date().toISOString();
      const run: LangSmithRun = {
        id: runId,
        trace_id: parent.traceId,
        dotted_order: dottedOrder,
        name: `subagent:${(event.agentId as string) ?? "unknown"}`,
        run_type: "chain",
        inputs: { task: event.task },
        outputs: { result: event.result, success: event.success },
        parent_run_id: parent.runId,
        start_time: (event.startTime as string) ?? now,
        end_time: (event.endTime as string) ?? now,
        session_name: this.config.projectName,
        extra: { metadata: { sessionKey, thread_id: sessionKey } },
      };

      this.client.createRun(run);
      log.debug(`traced subagent run ${runId} for ${sessionKey}`);
    } catch (err) {
      log.warn(`failed to trace subagent: ${err}`);
    }
  }

  /** Record an LLM call for a session (called from llm_output hook) */
  recordLlmCall(sessionKey: string, model: string, provider?: string): void {
    const modelInfo = parseModelInfo(model, provider);
    const models = this.sessionModels.get(sessionKey) ?? [];
    models.push(modelInfo);
    this.sessionModels.set(sessionKey, models);
    log.debug(`recorded LLM call for ${sessionKey}: ${modelInfo.provider}/${modelInfo.model}`);
  }

  /** Start a main LLM run (called from llm_input hook) */
  startMainLlmRun(sessionKey: string, event: LlmInputEvent): void {
    try {
      const parent = this.activeAgentRuns.get(sessionKey);
      if (!parent) {
        log.debug(`no active agent run for ${sessionKey}, skipping LLM child run`);
        return;
      }
      const runId = crypto.randomUUID();
      const startTime = new Date().toISOString();
      const traceId = parent.traceId;
      const dottedOrder = makeDottedOrder(runId, parent.dottedOrder);

      this.pendingMainLlmRuns.set(event.runId, {
        runId,
        traceId,
        dottedOrder,
        parentRunId: parent.runId,
        startTime,
        sessionKey,
        llmInput: event,
      });

      log.debug(`started main LLM run ${runId} for openclaw runId=${event.runId} (${event.provider}/${event.model})`);
    } catch (err) {
      log.warn(`failed to start main LLM run: ${err}`);
    }
  }

  /** End a main LLM run (called from llm_output hook) */
  endMainLlmRun(sessionKey: string, event: LlmOutputEvent): void {
    try {
      // Match by OpenClaw runId — not FIFO — so concurrent/out-of-order calls pair correctly
      const pending = this.pendingMainLlmRuns.get(event.runId);
      if (pending) {
        this.pendingMainLlmRuns.delete(event.runId);
      }

      const endTime = new Date().toISOString();
      let runId: string;
      let traceId: string;
      let parentRunId: string | undefined;
      let startTime: string;
      let dottedOrder: string;
      const inputData: Record<string, unknown> = {};

      if (pending) {
        runId = pending.runId;
        traceId = pending.traceId;
        parentRunId = pending.parentRunId;
        startTime = pending.startTime;
        dottedOrder = pending.dottedOrder;
        if (pending.llmInput.systemPrompt) inputData.system = pending.llmInput.systemPrompt;
        inputData.prompt = pending.llmInput.prompt;
        if (pending.llmInput.historyMessages?.length > 0) inputData.history = pending.llmInput.historyMessages;
        if (pending.llmInput.imagesCount > 0) inputData.imagesCount = pending.llmInput.imagesCount;
      } else {
        // Orphan llm_output with no matching llm_input — create a zero-duration fallback run.
        // This can happen if the llm_input hook was skipped (e.g., tracing started mid-turn).
        const parent = this.activeAgentRuns.get(sessionKey);
        if (!parent) {
          log.debug(`no pending LLM run and no active agent for ${sessionKey}, skipping`);
          return;
        }
        runId = crypto.randomUUID();
        traceId = parent.traceId;
        parentRunId = parent.runId;
        startTime = endTime;
        dottedOrder = makeDottedOrder(runId, parent.dottedOrder);
      }

      const usage = event.usage;
      const inputTokens = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
      const outputTokens = usage?.output ?? 0;
      const totalTokens = usage?.total ?? (inputTokens + outputTokens);

      const usageMetadata = totalTokens > 0 ? {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        ...(usage?.cacheRead && { cache_read_tokens: usage.cacheRead }),
        ...(usage?.cacheWrite && { cache_write_tokens: usage.cacheWrite }),
      } : undefined;

      const run: LangSmithRun = {
        id: runId,
        trace_id: traceId,
        dotted_order: dottedOrder,
        name: `${event.provider}/${event.model}`,
        run_type: "llm",
        inputs: Object.keys(inputData).length > 0 ? inputData : { prompt: "(not captured)" },
        outputs: {
          ...(event.assistantTexts?.length > 0 ? { completion: event.assistantTexts.join("\n") } : {}),
          ...(event.lastAssistant ? { lastAssistant: event.lastAssistant } : {}),
          ...(usageMetadata ? { usage_metadata: usageMetadata } : {}),
        },
        parent_run_id: parentRunId,
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
            provider: event.provider,
            model: event.model,
            sessionKey,
            thread_id: sessionKey,
            openclawRunId: event.runId,
          },
          ...(usageMetadata && {
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: totalTokens,
            },
          }),
        },
        tags: [`provider:${event.provider}`, `model:${event.model}`],
      };

      this.client.createRun(run);
      log.debug(`traced main LLM run ${runId} (${event.provider}/${event.model}, tokens=${totalTokens})`);
    } catch (err) {
      log.warn(`failed to end main LLM run: ${err}`);
    }
  }

  private getSessionModelInfo(sessionKey: string): ModelInfo | undefined {
    const models = this.sessionModels.get(sessionKey);
    if (!models || models.length === 0) return undefined;
    return models[models.length - 1];
  }

  private getAllSessionModels(sessionKey: string): string[] {
    const models = this.sessionModels.get(sessionKey);
    if (!models || models.length === 0) return [];
    const seen = new Set<string>();
    return models
      .map((m) => `${m.provider}/${m.model}`)
      .filter((s) => {
        if (seen.has(s)) return false;
        seen.add(s);
        return true;
      });
  }

  startAgentRun(sessionKey: string, prompt: string): void {
    try {
      // Duplicate guard: before_model_resolve fires per LLM turn, not per user message.
      // If a run is already open for this session, skip — agent_end will close it.
      const existing = this.activeAgentRuns.get(sessionKey);
      if (existing) {
        log.debug(`agent run already open for ${sessionKey} (${existing.runId}), skipping duplicate`);
        return;
      }

      const runId = crypto.randomUUID();
      const startTime = new Date().toISOString();
      const dottedOrder = makeDottedOrder(runId);
      const tags = extractTags(sessionKey, prompt);

      const activeRun: ActiveRun = { runId, traceId: runId, dottedOrder, startTime, tags, sessionKey };
      this.activeAgentRuns.set(sessionKey, activeRun);

      const run: LangSmithRun = {
        id: runId,
        trace_id: runId,
        dotted_order: dottedOrder,
        name: "agent_turn",
        run_type: "llm", // Using llm type so LangSmith populates token columns
        inputs: { prompt },
        start_time: startTime,
        session_name: this.config.projectName,
        tags: tags.length > 0 ? tags : undefined,
        extra: { metadata: { sessionKey, thread_id: sessionKey } },
      };

      this.client.createRun(run);
      log.debug(`started agent run ${runId} for session ${sessionKey} tags=${tags.join(",")}`);
    } catch (err) {
      log.warn(`failed to start agent run: ${err}`);
    }
  }

  endAgentRun(sessionKey: string, messages: unknown, success: boolean, usage?: TokenUsage, durationMs?: number): void {
    try {
      const active = this.activeAgentRuns.get(sessionKey);
      if (!active) {
        log.debug(`no active agent run for session ${sessionKey}`);
        return;
      }

      this.activeAgentRuns.delete(sessionKey);

      const modelInfo = this.getSessionModelInfo(sessionKey);
      const allModels = this.getAllSessionModels(sessionKey);
      this.sessionModels.delete(sessionKey);

      const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
      const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
      const totalTokens = usage?.total_tokens ?? (promptTokens + completionTokens);

      log.debug(`endAgentRun: session=${sessionKey}, tokens=${totalTokens}, model=${modelInfo?.provider}/${modelInfo?.model}`);

      const usageMetadata = totalTokens > 0 ? {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
        total_tokens: totalTokens,
      } : undefined;

      const patch: Partial<LangSmithRun> = {
        id: active.runId,
        trace_id: active.traceId,
        dotted_order: active.dottedOrder,
        end_time: new Date().toISOString(),
        outputs: {
          messages,
          success,
          ...(modelInfo && { model: modelInfo.model, provider: modelInfo.provider }),
          ...(allModels.length > 1 && { all_models: allModels }),
          ...(usageMetadata && { usage_metadata: usageMetadata }),
          ...(active.assembledPrompt && { assembled_prompt: active.assembledPrompt }),
        },
        ...(totalTokens > 0 && {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: totalTokens,
        }),
        extra: {
          metadata: {
            sessionKey,
            thread_id: sessionKey,
            durationMs,
            ...(modelInfo && {
              model: modelInfo.model,
              provider: modelInfo.provider,
            }),
            ...(allModels.length > 0 && { models_used: allModels }),
          },
          ...(usageMetadata && {
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: totalTokens,
            },
          }),
        },
        // LangSmith PATCH replaces tags, so we must send the full set including original tags
        tags: [
          ...(active.tags ?? []),
          ...(modelInfo ? [`provider:${modelInfo.provider}`, `model:${modelInfo.model}`] : []),
        ],
      };

      if (!success) {
        patch.error = "Agent turn failed";
      }

      this.client.updateRun(active.runId, patch);
      log.debug(`ended agent run ${active.runId} (model: ${modelInfo?.provider}/${modelInfo?.model}, tokens: ${totalTokens}, duration: ${durationMs}ms)`);
    } catch (err) {
      log.warn(`failed to end agent run: ${err}`);
    }
  }

  startToolRun(sessionKey: string, toolName: string, toolCallId: string, params: unknown): string | undefined {
    try {
      const runId = crypto.randomUUID();
      const startTime = new Date().toISOString();

      const parentRun = this.activeAgentRuns.get(sessionKey);
      const parentRunId = parentRun?.runId;
      const traceId = parentRun?.traceId ?? runId;
      const dottedOrder = makeDottedOrder(runId, parentRun?.dottedOrder);

      this.activeToolRuns.set(runId, { runId, traceId, dottedOrder, parentRunId, startTime, sessionKey });
      this.pendingToolRuns.set(toolCallId, runId);

      const run: LangSmithRun = {
        id: runId,
        trace_id: traceId,
        dotted_order: dottedOrder,
        name: toolName,
        run_type: "tool",
        inputs: { params },
        parent_run_id: parentRunId,
        start_time: startTime,
        session_name: this.config.projectName,
        extra: { metadata: { sessionKey, thread_id: sessionKey } },
      };

      this.client.createRun(run);
      log.debug(`started tool run ${runId} (${toolName}) for toolCallId=${toolCallId}`);
      return runId;
    } catch (err) {
      log.warn(`failed to start tool run: ${err}`);
      return undefined;
    }
  }

  endToolRun(toolCallId: string, result: unknown, error?: string): void {
    try {
      const runId = this.pendingToolRuns.get(toolCallId);
      if (runId) {
        this.pendingToolRuns.delete(toolCallId);
      }
      const active = this.activeToolRuns.get(runId ?? toolCallId);
      if (!active) {
        log.debug(`no active tool run for toolCallId=${toolCallId} (runId=${runId})`);
        return;
      }

      this.activeToolRuns.delete(active.runId);

      const patch: Partial<LangSmithRun> = {
        id: active.runId,
        trace_id: active.traceId,
        dotted_order: active.dottedOrder,
        end_time: new Date().toISOString(),
        outputs: { result },
      };

      if (error) {
        patch.error = error;
      }

      this.client.updateRun(active.runId, patch);
      log.debug(`ended tool run ${active.runId}`);
    } catch (err) {
      log.warn(`failed to end tool run: ${err}`);
    }
  }
}
