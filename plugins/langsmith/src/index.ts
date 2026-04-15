import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseConfig } from "./config.js";
import { initLogger, log } from "./logger.js";
import { LangSmithClient } from "./client.js";
import { Tracer } from "./tracer.js";
import type { LlmInputEvent, LlmOutputEvent, TokenUsage } from "./types.js";

/**
 * Extract token usage by summing ALL assistant messages in the turn.
 *
 * Note: individual LLM child runs also carry per-call token counts. The parent
 * agent_turn total will equal the sum of its children — LangSmith displays the
 * parent's tokens in the run list, so this gives an accurate per-turn total
 * without requiring users to sum child runs manually.
 */
function extractUsageFromMessages(messages: unknown): TokenUsage | undefined {
  if (!Array.isArray(messages)) return undefined;

  let totalInput = 0;
  let totalOutput = 0;
  let found = false;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant") continue;

    const usage = m.usage as Record<string, unknown> | undefined;
    if (!usage) continue;

    const input = typeof usage.input === "number" ? usage.input : 0;
    const output = typeof usage.output === "number" ? usage.output : 0;
    const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
    const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;

    totalInput += input + cacheRead + cacheWrite;
    totalOutput += output;
    found = true;
  }

  if (!found) return undefined;

  return {
    input_tokens: totalInput,
    output_tokens: totalOutput,
    total_tokens: totalInput + totalOutput,
  };
}

export default {
  id: "copilotai-openclaw-langsmith",
  name: "LangSmith Tracing",
  description: "Automatic LangSmith tracing for OpenClaw agent turns, tool calls, and LLM calls.",
  kind: "utility" as const,

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    initLogger(api.logger, cfg.debug);

    if (!cfg.langsmithApiKey) {
      log.warn("no LangSmith API key — tracing disabled");
      return;
    }

    const client = new LangSmithClient(cfg);
    const tracer = new Tracer(client, cfg);

    // Session lifecycle hooks
    api.on("session_start", (_event: Record<string, unknown>, ctx: Record<string, unknown>) => {
      const sessionKey = (ctx?.sessionKey as string) ?? "default";
      tracer.onSessionStart(sessionKey);
    });

    api.on("session_end", (_event: Record<string, unknown>, ctx: Record<string, unknown>) => {
      const sessionKey = (ctx?.sessionKey as string) ?? "default";
      tracer.onSessionEnd(sessionKey);
    });

    // Hook: before_model_resolve — Start a chain run (replaces legacy before_agent_start)
    if (cfg.traceAgentTurns) {
      log.info("registering before_model_resolve hook");
      api.on("before_model_resolve", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const sessionKey = (ctx?.sessionKey as string) ?? "default";
        const prompt = event.prompt as string | undefined;
        if (prompt) {
          tracer.startAgentRun(sessionKey, prompt);
        }
      });
    }

    // Hook: before_prompt_build — Capture assembled prompt with injected memory/context
    if (cfg.traceAgentTurns) {
      api.on("before_prompt_build", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const sessionKey = (ctx?.sessionKey as string) ?? "default";
        tracer.capturePromptBuild(sessionKey, event);
      });
    }

    // Hook: agent_end — Close the chain run
    if (cfg.traceAgentTurns) {
      log.info("registering agent_end hook");
      api.on("agent_end", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const sessionKey = (ctx?.sessionKey as string) ?? "default";
        const durationMs = event.durationMs as number | undefined;
        const usage = extractUsageFromMessages(event.messages);
        tracer.endAgentRun(sessionKey, event.messages, !!event.success, usage, durationMs);
      });
    }

    // Hook: subagent_ended — Track subagent runs as child chains
    if (cfg.traceAgentTurns) {
      api.on("subagent_ended", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const sessionKey = (ctx?.sessionKey as string) ?? "default";
        tracer.onSubagentEnded(sessionKey, event);
      });
    }

    // Hook: before_tool_call — Start a tool run
    if (cfg.traceToolCalls) {
      api.on("before_tool_call", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const sessionKey = (ctx?.sessionKey as string) ?? "default";
        const toolName = event.toolName as string;
        const toolCallId = event.toolCallId as string;
        tracer.startToolRun(sessionKey, toolName, toolCallId, event.params);
      });
    }

    // Hook: after_tool_call — Close the tool run
    if (cfg.traceToolCalls) {
      api.on("after_tool_call", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const toolCallId = (event.toolCallId as string | undefined) ?? (ctx?.toolCallId as string | undefined);
        if (toolCallId) {
          tracer.endToolRun(toolCallId, event.result, event.error as string | undefined);
        } else {
          log.debug("after_tool_call: no toolCallId on event or ctx");
        }
      });
    }

    // Hook: llm_input/llm_output — LLM child runs are parented under agent runs,
    // so they only make sense when agent turn tracing is enabled.
    if (cfg.traceAgentTurns) {
      api.on("llm_input", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const sessionKey = (ctx?.sessionKey as string) ?? "default";
        tracer.startMainLlmRun(sessionKey, event as unknown as LlmInputEvent);
      });

      api.on("llm_output", (event: Record<string, unknown>, ctx: Record<string, unknown>) => {
        const sessionKey = (ctx?.sessionKey as string) ?? "default";
        const model = (event.model as string) ?? "unknown";
        const provider = (event.provider as string | undefined) ?? (ctx?.provider as string | undefined);
        tracer.recordLlmCall(sessionKey, model, provider);
        tracer.endMainLlmRun(sessionKey, event as unknown as LlmOutputEvent);
      });
    }

    // Register service with graceful shutdown
    api.registerService({
      id: "copilotai-openclaw-langsmith",
      start: () => {
        log.info("langsmith tracing active");
      },
      stop: async () => {
        tracer.shutdown();
        await client.flush();
        client.close();
        log.info("langsmith tracing stopped");
      },
    });
  },
};
