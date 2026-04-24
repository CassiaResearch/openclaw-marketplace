# openclaw-instantly

OpenClaw plugin for Instantly.ai integrations. Receives inbound webhook events, verifies a custom auth header, dedupes, and creates a **TaskFlow per event** for downstream agent handling.

## Architecture

The plugin stands in for openclaw's builtin `webhooks` extension at the HTTP layer — because Instantly's payload shape (`{event_type, campaign_id, email_account, ...}`) doesn't conform to the builtin's required TaskFlow action schema (`{action: "create_flow", goal, ...}`). Everything downstream of the HTTP layer is identical to the builtin: we call `api.runtime.tasks.flow.bindSession(...).createManaged(...)` the same way.

```
Instantly  →  POST /plugins/instantly/webhook  →  [this plugin]
                                                      │
                                                      │ rate limit per IP
                                                      │ verify custom auth header
                                                      │ read + parse JSON (max 1 MB)
                                                      │ warn on missing required fields
                                                      │ dedup by synthetic key
                                                      ▼
                                        taskFlow.createManaged({
                                          goal, controllerId,
                                          status: "queued",
                                          notifyPolicy,
                                          stateJson: { ...event },
                                        })
                                                      │
                                                      ▼
                                  Emma's session TaskFlow queue
                                  (drained by Program 10 or similar)
```

## Why this shape (alternatives evaluated)

Several openclaw-native paths could handle inbound Instantly webhooks. Each was evaluated and rejected:

| Alternative | Why not |
|---|---|
| **Builtin `webhooks` plugin** | Requires body shape `{action: "create_flow", ...}` and `Authorization: Bearer` auth. Instantly sends `{event_type, ...}` with a custom auth header. Fixed mismatch on both dimensions. |
| **`hooks.mappings` → `/hooks/wake`** | Actively supported and zero-custom-code — but auth is Bearer-only (no custom-header name), has no place for per-event dedup, and batching is opportunistic (relies on short wake-coalesce windows that can't be tuned per-event-type). |
| **`hooks.mappings` → `/hooks/agent`** | Each event fires an isolated agent turn. No batching. Fragments Oriana's Slack thread across isolated sessions. |
| **Plugin + `subagent.run` / `runEmbeddedAgent`** | Direct-fire per event. Loses queue/audit/batch properties and diverges from openclaw's builtin webhooks pattern. |
| **External shim** (Zapier / n8n / Cloudflare Worker) | Platform dependency + extra hop for no benefit at current volume. Worth reconsidering if multiple third-party integrations share the bridge later. |
| **Composio triggers / custom tools** | Composio's Instantly toolkit ships with `Triggers: 0`, and user-defined custom tools are not visible over the MCP surface Emma uses. |

**Chosen: custom plugin + TaskFlow + drainer.** Rationale:

- **Deterministic batching.** The drainer picks its own window (every 2-5 min) and sees all pending events at once — handle 5 bounces as one "deliverability alert" DM instead of 5 interruptions.
- **Decoupled ingestion.** Plugin accepts events while Emma is busy, asleep, or processing a long turn. No dropped events from agent-side backpressure.
- **Auditable.** `list_flows` + the `stateJson` blob preserves full event history queryable by time, campaign, status.
- **Failure resilience.** A failed drain turn leaves the flow in `queued`/`running`; retried next drain. With direct-fire, a failed agent turn silently loses the event.
- **Matches openclaw convention.** The builtin webhooks plugin uses the same `api.runtime.tasks.flow.bindSession(...).createManaged(...)` path.
- **Scales with volume.** At 10 events/day we could do without; at 100+/day TaskFlow starts earning its keep. Shape chosen to avoid a future refactor.
- **Multi-step extensibility.** If future event types need orchestration (reply → enrich → draft → approve → send → log), each step can be a child `runTask` under the same flow.

**Trade-offs accepted:**

- `createManaged` is on the deprecated `api.runtime.tasks.flow` path. The new `tasks.flows` DTO API is read-only and has no create method yet. We'll migrate when openclaw ships create on the new API — deprecated ≠ removed.
- The plugin is **live-but-inert** until the drainer lands. Events are persisted as TaskFlows but no downstream consumer acts on them yet. See "Open gap" below.
- No HMAC verification. Instantly doesn't sign webhooks per their docs. If they add signing, the plugin will need to be extended.

## Auth model

Instantly doesn't do HMAC signing ([help.instantly.ai/6261906](https://help.instantly.ai/en/articles/6261906)). Its webhook API exposes a `headers` field for custom HTTP headers attached to every POST. The plugin compares one configured header (e.g. `X-Emma-Webhook-Secret`) against a stored secret via constant-time comparison.

## Config (`openclaw.json` → `plugins.entries.openclaw-instantly.config`)

| Key | Required | Default | Notes |
|---|---|---|---|
| `routePath` | no | `/plugins/instantly/webhook` | Gateway path |
| `authHeader.name` | yes | — | Header Instantly attaches, e.g. `X-Emma-Webhook-Secret` |
| `authHeader.secret` | yes | — | SecretRef: `{source:"env", provider:"default", id:"INSTANTLY_WEBHOOK_SECRET"}` |
| `sessionKey` | no | `agent:main:main` | TaskFlow session to bind |
| `controllerId` | no | `openclaw-instantly/webhook` | Stamped on created flows |
| `notifyPolicy` | no | `state_changes` | TaskFlow notify policy |
| `dedupCapacity` | no | `10000` | LRU size for synthetic dedup key |
| `paused` | no | `false` | When `true`, authenticated requests still return 200 but no TaskFlow is created and the event is logged as dropped. See note below on hot-reload. |

### Pausing ingestion

Set `paused: true` to drop events without unmounting the route. Useful for draining a backlog or during Instantly-side incidents. The plugin re-reads `api.pluginConfig` on every request, so **in theory** toggling is live — but openclaw's plugin-config hot-reload behavior is unverified. **Safe play: restart the gateway after flipping `paused`.** When paused, requests still go through method/config/rate-limit/auth/body checks (so anomalies still surface in logs); dedup and TaskFlow creation are skipped. Paused requests return `200 {"ok": true, "paused": true}`.

### Rate limiting

Built-in: 120 requests / 60 seconds / client IP (openclaw SDK default). Exceeding the window returns `429` with `Retry-After: 60`. This is a safety net for secret leaks, Instantly misconfig, or bursty retries — not a primary defense. If you need a different window, swap `WEBHOOK_RATE_LIMIT_DEFAULTS` in `index.ts` for an explicit config.

## Example config

```json
{
  "plugins": {
    "entries": {
      "openclaw-instantly": {
        "enabled": true,
        "config": {
          "authHeader": {
            "name": "X-Emma-Webhook-Secret",
            "secret": { "source": "env", "provider": "default", "id": "INSTANTLY_WEBHOOK_SECRET" }
          }
        }
      }
    }
  }
}
```

## Setup

1. Generate the shared secret and expose it to the gateway env:
   ```bash
   openssl rand -hex 32
   # add INSTANTLY_WEBHOOK_SECRET=<hex> to gateway env
   ```
2. Enable the plugin in `openclaw.json` per the example above.
3. Restart the gateway.
4. In Instantly's UI create a webhook subscription:
   - URL: `https://<gateway-public-url>/plugins/instantly/webhook`
   - Event type: any subset (or `all_events`)
   - Custom header: name `X-Emma-Webhook-Secret`, value matching the env var
5. Trigger a test and watch gateway logs for `[openclaw-instantly] recv event=...`.

## Dedup

Instantly payloads have no `event_id`. The plugin builds a synthetic key by joining the following with colons:

1. `event_type`
2. `timestamp` (or the literal `"no-ts"` if absent — shouldn't happen per Instantly's docs)
3. `campaign_id`
4. `email_id` (for email-scoped events) OR `lead_email` (otherwise)

Example: `reply_received:2026-04-22T22:08:19Z:d13a2178-...:019db20d-...`

Stored in a bounded in-memory LRU (FIFO eviction). Resets on gateway restart. Dedup only kicks in AFTER auth and rate-limit succeed, so unauthorized attempts don't consume dedup slots.

## Missing-field warnings

Instantly's docs say `timestamp`, `event_type`, `workspace`, `campaign_id`, and `campaign_name` are always present in webhook payloads. The plugin logs a warning if any are missing from a received event — either Instantly changed their payload shape or the request is malformed. The event is still processed (using `"unknown"` fallbacks for the missing fields); the warning is informational.

## TaskFlow state

Each event creates a flow with `stateJson` containing the full Instantly payload plus normalized top-level fields:

```json
{
  "source": "instantly",
  "event_type": "reply_received",
  "lead_email": "...",
  "campaign_id": "...",
  "campaign_name": "...",
  "email_account": "...",
  "email_id": "...",
  "reply_text_snippet": "...",
  "reply_subject": "...",
  "reply_text": "...",
  "unibox_url": "...",
  "timestamp": "...",
  "raw": { /* original Instantly payload */ }
}
```

Downstream handlers (a standing order, a cron drain, or an agent turn) read `stateJson` to decide what to do — DM Oriana, draft a reply, log to HubSpot, trigger the `sdr-instantly-reply` skill, etc.

## Open gap: the drainer

This plugin only **produces** TaskFlows. A downstream system has to drain them (same constraint as the builtin webhooks extension). Options:

- Extend Program 10 ("Prospect Reply Alert") to list and process `controllerId=openclaw-instantly/webhook` flows during Emma's heartbeat
- Add a dedicated cron job that polls the flow queue and fires an agent turn per new flow
- Subscribe a standing order directly to TaskFlow state-change events (if the runtime supports that — unconfirmed)

Without a drainer, TaskFlows queue up and are never acted on. Phase 3 of the Instantly integration plan covers adding the drainer.
