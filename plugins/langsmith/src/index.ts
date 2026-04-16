import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { parseConfig } from "./config.js";
import { initLogger, log } from "./logger.js";
import { LangSmithClient } from "./client.js";
import { Tracer, type AgentMessage } from "./tracer.js";

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

    // ── Session lifecycle ───────────────────────────────────────────────

    api.on("session_start", (_event, ctx) => {
      tracer.onSessionStart(ctx.sessionKey ?? "default");
    });

    api.on("session_end", (_event, ctx) => {
      tracer.onSessionEnd(ctx.sessionKey ?? "default");
    });

    // ── Turn boundary: llm_input starts the turn ────────────────────────
    // llm_input fires once per attempt, AFTER context-engine assemble().
    // historyMessages is the post-assemble session state — what the LLM sees.

    if (cfg.traceAgentTurns) {
      log.info("registering llm_input hook (turn start)");
      api.on("llm_input", (event, ctx) => {
        tracer.onTurnStart(ctx.sessionKey ?? "default", event, {
          runId: ctx.runId,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          messageProvider: ctx.messageProvider,
          trigger: ctx.trigger,
          channelId: ctx.channelId,
        });
      });
    }

    // ── Per-message write: drives per-LLM-call child runs ──────────────
    // before_message_write fires for every message written to the session
    // JSONL during the agent loop — assistant messages (inner LLM calls),
    // tool results, and user messages. This gives real-time, per-call
    // visibility into the tool-use loop.

    if (cfg.traceAgentTurns) {
      log.info("registering before_message_write hook (per-call tracing)");
      api.on("before_message_write", (event, ctx) => {
        tracer.onMessageWrite(ctx.sessionKey ?? "default", event.message as unknown as AgentMessage);
      });
    }

    // ── Turn end: agent_end closes the root chain ───────────────────────

    if (cfg.traceAgentTurns) {
      log.info("registering agent_end hook (turn end)");
      api.on("agent_end", (event, ctx) => {
        tracer.onTurnEnd(ctx.sessionKey ?? "default", event.success, event.durationMs, event.error);
      });
    }

    // ── Subagent tracing ────────────────────────────────────────────────

    if (cfg.traceAgentTurns) {
      api.on("subagent_ended", (event, ctx) => {
        tracer.onSubagentEnded(ctx.requesterSessionKey ?? "default", event);
      });
    }

    // ── Tool call tracing ───────────────────────────────────────────────
    // Tool runs are parented under the LLM call that invoked them, matching
    // LangGraph's nesting structure.

    if (cfg.traceToolCalls) {
      api.on("before_tool_call", (event, ctx) => {
        tracer.startToolRun(
          ctx.sessionKey ?? "default",
          event.toolName,
          event.toolCallId ?? ctx.toolCallId ?? "",
          event.params,
        );
      });
    }

    if (cfg.traceToolCalls) {
      api.on("after_tool_call", (event, ctx) => {
        const toolCallId = event.toolCallId ?? ctx.toolCallId;
        if (toolCallId) {
          tracer.endToolRun(ctx.sessionKey ?? "default", toolCallId, event.result, event.error, event.durationMs);
        } else {
          log.debug("after_tool_call: no toolCallId on event or ctx");
        }
      });
    }

    // ── Service registration with graceful shutdown ─────────────────────

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
