import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  createFixedWindowRateLimiter,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  resolveRequestClientIp,
} from "openclaw/plugin-sdk/webhook-ingress";

/** Fields Instantly documents as always-present in webhook payloads. */
const INSTANTLY_REQUIRED_FIELDS = [
  "timestamp",
  "event_type",
  "workspace",
  "campaign_id",
  "campaign_name",
] as const;

/** Send a JSON response with the right Content-Type header. */
function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** Send a plain-text response (used for error codes that don't need structured bodies). */
function sendText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

type SecretRef = { source: "env"; provider: string; id: string };

interface PluginConfig {
  routePath?: string;
  authHeader?: { name: string; secret: SecretRef };
  sessionKey?: string;
  controllerId?: string;
  notifyPolicy?: "done_only" | "state_changes" | "silent";
  dedupCapacity?: number;
  paused?: boolean;
}

class LruSet {
  private readonly capacity: number;
  private readonly set = new Set<string>();
  constructor(capacity: number) {
    this.capacity = Math.max(1, capacity);
  }
  seen(key: string): boolean {
    if (this.set.has(key)) return true;
    if (this.set.size >= this.capacity) {
      const first = this.set.values().next().value;
      if (first !== undefined) this.set.delete(first);
    }
    this.set.add(key);
    return false;
  }
}

function resolveSecret(ref: SecretRef | undefined): string | undefined {
  if (ref?.source === "env") return process.env[ref.id];
  return undefined;
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  try {
    return timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

async function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default {
  id: "openclaw-instantly",
  name: "OpenClaw Instantly",
  description:
    "Receives Instantly.ai webhooks and creates a TaskFlow per event for downstream agent handling.",

  register(api: OpenClawPluginApi) {
    const cfg = (api.pluginConfig ?? {}) as PluginConfig;
    const routePath = cfg.routePath ?? "/plugins/instantly/webhook";
    const sessionKey = cfg.sessionKey ?? "agent:main:main";
    const controllerId = cfg.controllerId ?? "openclaw-instantly/webhook";
    const notifyPolicy = cfg.notifyPolicy ?? "state_changes";
    const dedupCapacity = cfg.dedupCapacity ?? 10000;
    const dedup = new LruSet(dedupCapacity);

    const authHeaderName = cfg.authHeader?.name?.toLowerCase();
    const expectedSecret = resolveSecret(cfg.authHeader?.secret);

    if (!authHeaderName) {
      api.logger.error?.(
        `[openclaw-instantly] authHeader config missing — route will reject everything`,
      );
    } else if (!expectedSecret) {
      api.logger.error?.(
        `[openclaw-instantly] auth header secret not resolved (env var ${cfg.authHeader?.secret.id} empty) — route will reject everything`,
      );
    }

    // Bind the TaskFlow handle at register time — same pattern as the builtin webhooks extension.
    // Note: api.runtime.tasks.flow is deprecated in favor of runtime.tasks.flows (DTO read API),
    // but flows has no create method today; createManaged only exists on the deprecated path.
    const taskFlow = api.runtime.tasks.flow.bindSession({ sessionKey });

    // Per-IP rate limiter. Defaults: 120 req/min/key, 4096 tracked keys.
    // Protects against secret leaks / Instantly bugs / misconfigured campaigns.
    const rateLimiter = createFixedWindowRateLimiter({ ...WEBHOOK_RATE_LIMIT_DEFAULTS });

    api.registerHttpRoute({
      path: routePath,
      auth: "plugin",
      match: "exact",
      replaceExisting: true,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== "POST") {
          sendText(res, 405, "Method Not Allowed");
          return true;
        }

        if (!authHeaderName || !expectedSecret) {
          sendText(res, 503, "Service Unavailable");
          return true;
        }

        // Per-IP rate limit. Applied before auth so brute-force secret attempts hit the wall.
        const clientIp = resolveRequestClientIp(req) ?? "unknown";
        if (rateLimiter.isRateLimited(clientIp)) {
          api.logger.warn?.(`[openclaw-instantly] rate limited ip=${clientIp}`);
          res.setHeader("Retry-After", "60");
          sendJson(res, 429, { error: "rate_limited" });
          return true;
        }

        const providedRaw = req.headers[authHeaderName];
        const provided = Array.isArray(providedRaw) ? providedRaw[0] : providedRaw;
        if (!provided || !safeEqual(provided, expectedSecret)) {
          api.logger.warn?.(`[openclaw-instantly] auth header mismatch on ${authHeaderName} ip=${clientIp}`);
          sendText(res, 401, "Unauthorized");
          return true;
        }

        let body: Buffer;
        try {
          body = await readBody(req);
        } catch {
          sendText(res, 413, "Body Too Large");
          return true;
        }

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(body.toString("utf8"));
        } catch {
          sendText(res, 400, "Invalid JSON");
          return true;
        }

        // Warn on missing required fields — Instantly's docs say these are always present,
        // so absence indicates a payload change or malformed request.
        const missingFields = INSTANTLY_REQUIRED_FIELDS.filter((f) => event[f] === undefined);
        if (missingFields.length > 0) {
          api.logger.warn?.(
            `[openclaw-instantly] payload missing expected fields: ${missingFields.join(", ")}`,
          );
        }

        const eventType = String(event.event_type ?? "unknown");
        const leadEmail = String(event.lead_email ?? "unknown");
        const campaignId = String(event.campaign_id ?? "unknown");
        const campaignName = String(event.campaign_name ?? campaignId);

        // Paused: ack politely, log the drop, skip dedup + flow creation.
        // Reads api.pluginConfig fresh on every request; whether openclaw hot-reloads
        // plugin config is unverified, so restart the gateway after toggling to be safe.
        if ((api.pluginConfig as PluginConfig | undefined)?.paused === true) {
          api.logger.info?.(
            `[openclaw-instantly] paused — dropped event=${eventType} lead=${leadEmail} cid=${campaignId}`,
          );
          sendJson(res, 200, { ok: true, paused: true });
          return true;
        }

        // Instantly payloads have no event_id — build a synthetic dedup key.
        // If timestamp is missing (shouldn't happen per Instantly docs), use a stable
        // sentinel so retries of the same payload still dedup.
        const dedupKey = [
          eventType,
          event.timestamp ?? "no-ts",
          campaignId,
          event.email_id ?? leadEmail,
        ].join(":");

        api.logger.info?.(
          `[openclaw-instantly] recv event=${eventType} lead=${leadEmail} cid=${campaignId}`,
        );

        if (dedup.seen(dedupKey)) {
          api.logger.info?.(`[openclaw-instantly] dedup hit ${dedupKey}, dropping`);
          sendJson(res, 200, { ok: true, deduped: true });
          return true;
        }

        // Ack fast — Instantly must not wait on the agent
        sendJson(res, 200, { ok: true });

        // Create a TaskFlow for downstream handling (matches builtin webhooks pattern).
        // createManaged is synchronous — returns ManagedTaskFlowRecord directly.
        try {
          const flow = taskFlow.createManaged({
            goal: `Handle Instantly ${eventType} event for lead ${leadEmail} on campaign ${campaignName}`,
            controllerId,
            status: "queued",
            notifyPolicy,
            stateJson: {
              source: "instantly",
              event_type: eventType,
              lead_email: leadEmail,
              campaign_id: campaignId,
              campaign_name: event.campaign_name,
              email_account: event.email_account,
              email_id: event.email_id,
              reply_text_snippet: event.reply_text_snippet,
              reply_subject: event.reply_subject,
              reply_text: event.reply_text,
              unibox_url: event.unibox_url,
              timestamp: event.timestamp,
              raw: event,
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any,
          });
          api.logger.info?.(
            `[openclaw-instantly] flow created id=${flow.flowId} event=${eventType} lead=${leadEmail}`,
          );
        } catch (e) {
          api.logger.error?.(
            `[openclaw-instantly] taskFlow.createManaged failed: ${(e as Error).message}`,
          );
        }

        return true;
      },
    });

    api.logger.info?.(
      `[openclaw-instantly] registered ${routePath} (sessionKey=${sessionKey}, controllerId=${controllerId})`,
    );
  },
};
