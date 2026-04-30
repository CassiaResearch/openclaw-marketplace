import { Type } from "@sinclair/typebox";
import { jsonResult } from "openclaw/plugin-sdk/provider-web-search";
import { checkSend, recordExternalEvent, recordSend } from "./policy.js";
import type { StoreOptions } from "./store.js";
import { KNOWN_TRAFFIC_CLASSES, type PluginConfig } from "./types.js";

const TrafficClassEnum = Type.Union(KNOWN_TRAFFIC_CLASSES.map((c) => Type.Literal(c)));

/**
 * Build the `email_warden_check_send` agent tool. Wraps `checkSend` so the
 * agent can ask the warden whether a proposed send is permitted; the tool
 * returns the raw `Decision` (`allow` | `defer` | `deny` | `suppressed`)
 * as JSON. `config` and `store` are captured at registration time.
 */
export function createCheckSendTool(config: PluginConfig, store: StoreOptions) {
  return {
    name: "email_warden_check_send",
    label: "Email Warden — Check Send",
    description:
      "Ask the warden whether a proposed email send is permitted. Returns allow, defer (with sendAfter), deny, or suppressed. Caller MUST pass trafficClass; missing or unknown values are treated as cold_outbound (fail-closed).",
    parameters: Type.Object(
      {
        mailbox: Type.String({ description: "The sending mailbox address (e.g. emma@example.com)." }),
        recipient: Type.String({ description: "The recipient email address." }),
        trafficClass: Type.Optional(TrafficClassEnum),
        cost: Type.Optional(Type.Integer({ minimum: 1, description: "How many 'send' units this burns. Defaults to 1." })),
        campaignContext: Type.Optional(Type.Boolean({
          description: "True when invoked from a campaign-runner flow. Locks class to cold_outbound.",
        })),
      },
      { additionalProperties: false },
    ),
    execute: async (_id: string, raw: Record<string, unknown>) => {
      const decision = await checkSend(
        {
          mailbox: String(raw.mailbox),
          recipient: String(raw.recipient),
          trafficClass: typeof raw.trafficClass === "string" ? raw.trafficClass : undefined,
          cost: typeof raw.cost === "number" ? raw.cost : undefined,
          campaignContext: raw.campaignContext === true,
        },
        config,
        store,
      );
      return jsonResult(decision);
    },
  };
}

/**
 * Build the `email_warden_record_send` agent tool. Wraps `recordSend` and
 * is intended to be called immediately after the underlying send tool
 * resolves (success or error), with the `class` returned by the prior
 * `check_send` decision so aggregates and tripwires stay consistent.
 */
export function createRecordSendTool(config: PluginConfig, store: StoreOptions) {
  return {
    name: "email_warden_record_send",
    label: "Email Warden — Record Send",
    description:
      "Record the outcome of a send that went through. Call this immediately after the underlying send tool completes (success or error), passing the final traffic class the warden returned.",
    parameters: Type.Object(
      {
        mailbox: Type.String(),
        recipient: Type.String(),
        class: TrafficClassEnum,
        cost: Type.Optional(Type.Integer({ minimum: 1 })),
        result: Type.Union([
          Type.Literal("ok"),
          Type.Literal("error"),
        ]),
        messageId: Type.Optional(Type.String()),
        errorStatus: Type.Optional(Type.Integer()),
        reason: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    execute: async (_id: string, raw: Record<string, unknown>) => {
      await recordSend(
        {
          mailbox: String(raw.mailbox),
          recipient: String(raw.recipient),
          class: raw.class as never,
          cost: typeof raw.cost === "number" ? raw.cost : undefined,
          result: raw.result as never,
          messageId: typeof raw.messageId === "string" ? raw.messageId : undefined,
          errorStatus: typeof raw.errorStatus === "number" ? raw.errorStatus : undefined,
          reason: typeof raw.reason === "string" ? raw.reason : undefined,
        },
        config,
        store,
      );
      return jsonResult({ ok: true });
    },
  };
}

/**
 * Build the `email_warden_record_event` agent tool. Wraps
 * `recordExternalEvent` for inbound events (bounce, reply, complaint,
 * unsubscribe). Typically driven by the Gmail Pub/Sub ingestion adapter,
 * not by the agent directly.
 */
export function createRecordEventTool(config: PluginConfig, store: StoreOptions) {
  return {
    name: "email_warden_record_event",
    label: "Email Warden — Record External Event",
    description:
      "Record an inbound event (bounce / reply / complaint / unsubscribe) observed for a previously-sent message. Typically invoked by the Gmail Pub/Sub ingestion hook, not by the agent directly.",
    parameters: Type.Object(
      {
        mailbox: Type.String(),
        cat: Type.Union([
          Type.Literal("bounce"),
          Type.Literal("reply"),
          Type.Literal("complaint"),
          Type.Literal("unsubscribe"),
        ]),
        class: TrafficClassEnum,
        recipient: Type.String(),
        reason: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    execute: async (_id: string, raw: Record<string, unknown>) => {
      await recordExternalEvent(
        {
          mailbox: String(raw.mailbox),
          cat: raw.cat as never,
          class: raw.class as never,
          recipient: String(raw.recipient),
          reason: typeof raw.reason === "string" ? raw.reason : undefined,
        },
        config,
        store,
      );
      return jsonResult({ ok: true });
    },
  };
}
