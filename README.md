# openclaw-email-warden

OpenClaw plugin that keeps track of your inbox, and adds a layer of protection for sending cold emails so that your account doesn't get banned or blacklisted.

> **Status:** v0.1.0. The decision engine, ledger, jitter, working-hours gate, suppression, retention, and the `send-email-safe` skill are implemented and unit-tested. Ingestion adapters and a few rate-window features are partial — see [Implementation status](#implementation-status) before relying on a specific tripwire firing.

## What it does

email-warden is an internal capability plugin (no vendor prefix) that sits between an agent's "send email" intent and the actual SMTP / Gmail API call. It owns two halves of the same ledger:

- **Outbound governance.** A `checkSend` decision is issued for every proposed send. The plugin returns `allow`, `defer` (with a `sendAfter` timestamp), `deny`, or `suppressed`, based on daily/hourly caps, working-hours gates, jitter, and tripwire state for that mailbox.
- **Inbound telemetry.** Delivery failures, replies, spam complaints, and unsubscribe requests are recorded against the same per-mailbox ledger via `email_warden_record_event`. Tripwires are evaluated against that ledger on every `checkSend`.

The plugin does not send email. It decides.

## Implementation status

| Area | Status | Notes |
|---|---|---|
| `email_warden_check_send` decision tool | ✅ shipped | Emits `allow` / `defer` / `deny` / `suppressed` |
| `email_warden_record_send` outcome tool | ✅ shipped | Bumps daily aggregates and per-recipient-domain counts |
| `email_warden_record_event` ingestion tool | ✅ shipped | Auto-adds to suppression on `bounce` / `unsubscribe` |
| Per-mailbox JSON ledger + atomic writes | ✅ shipped | `<root>/plugins/<stateDir>/<mailbox>/usage.json` |
| Retention / compaction (events cap, daily→monthly roll) | ✅ shipped | Runs inline on every event append |
| Lognormal jitter + micro-pauses | ✅ shipped | Uniform distribution also supported |
| Working-hours gate (`defer` outside hours) | ✅ shipped | Per-mailbox timezone, working days, working hours |
| Daily and hourly send caps | ✅ shipped | Counts calls (not weighted cost — see below) |
| Suppression list (global per mailbox) | ✅ shipped | Cross-mailbox suppression is not yet implemented |
| Manual mailbox pause (`pausedUntil`) | ✅ shipped | Set by tripwire `pause-mailbox` action |
| Tripwires — `{ hours, minSends }` window | ✅ shipped | Used by `bounceRateSlowRot` |
| Tripwires — `{ sends: N }` window | ✅ shipped | Outcomes attributed to the most recent prior send to the same recipient |
| `send-email-safe` skill | ✅ shipped | Bundled in `skills/`, referenced from `openclaw.plugin.json` |
| Ingestion adapters (Gmail Pub/Sub, Gmail polling) | ❌ not yet | Config schema and types exist; `index.ts` logs "not yet implemented" per configured adapter and no events flow in. Until adapters land, call `email_warden_record_event` from your own bridge. |
| `cost` weighting in caps | ❌ not yet | `cost` parameter is accepted and stored on the event but caps are evaluated by call count |
| Per-recipient-domain throttle | ❌ not yet | Counts are tracked in the ledger; `checkSend` doesn't gate on them yet |
| Warmup ramp logic | ❌ not yet | `warmup.stage` exists in the ledger but no code increments or reads it for limits |
| `pause-warmup`, `pause-campaign`, `suppress-recipient` actions | ❌ not yet | Tripwire evaluator emits them; `checkSend` only short-circuits on `pause-mailbox` |
| Slack alert delivery | ❌ not yet | `alerts.slackChannel` is config-only; no message is sent |

## Design principles

1. **Cooperative enforcement.** openclaw does not expose a tool-call interceptor today, so the `send-email-safe` skill must call `email_warden_check_send` before calling the underlying GWS send tool. A misbehaving skill could bypass the plugin, so the skill's contract is load-bearing: if `checkSend` errors or times out, the skill fails closed (returns `denied`).
2. **Persist raw events; derive windows.** The ledger stores every decision as an event with timestamp, category, cost, and result. Daily aggregates are cached for speed; any other window (hourly, last-100-sends) is computed at decision time from the event log. This matches the pattern in `openclaw-unipile` and avoids the class of bugs where cached counters drift from ground truth.
3. **Categories over raw tool names.** Sends are grouped into categories (`send`, `warmup_send`, `reply`, `follow_up`). Limits and tripwires attach to categories so new send tools can be added without reconfiguring policy.
4. **Cost is not always 1.** A send to multiple recipients, or one with a tracking pixel, can in principle cost more than a plain one-to-one — the parameter is plumbed end-to-end and persisted. Caps don't yet read it; that's the next step.
5. **Humans aren't uniform.** Jitter uses a lognormal distribution by default, not a uniform window. Working-hours gates and occasional micro-pauses round out the "this was typed by a person" pacing signature.

## Traffic classes

Not all outbound email carries the same risk. A cold prospect email needs every guardrail; a reply to a human who emailed an hour ago needs essentially none. Every send declares a `trafficClass` that determines which rules apply:

| Class | Global caps | Min-gap | Jitter / working-hours | Category tripwires | Purpose |
|---|---|---|---|---|---|
| `cold_outbound` | Yes | Yes | Full (lognormal + working hours + microPause) | Yes (bounce / reply floor / complaint) | Cold prospect first touch |
| `follow_up` | Yes | Yes | Full | Bounce / complaint only | Follow-up to a cold prospect |
| `warmup_send` | Yes | Yes | Full | Warmup-specific | Inter-mailbox / known-good during ramp |
| `reply` | Yes | Yes | None | None | Reply to a human who wrote in |
| `personal` | Yes | Yes | None | None | Ad-hoc personal correspondence |
| `transactional` | Yes | Yes | None | None | Booking confirmations, meeting invites |

The current implementation applies full pacing (jitter + micro-pause + working-hours) to `cold_outbound`, `warmup_send`, and `follow_up`. The short min-gap from `limits.send.minGapSeconds` applies to every class.

**Two concerns, two separate policies.** Gmail's view of the mailbox doesn't care about category labels — it sees total volume and pacing. So global limits (daily cap, hourly cap, min gap) apply to *every* send regardless of class. Category tripwires (bounce rate, reply rate floor) read only events tagged with the matching class — a personal email with 0% reply rate doesn't starve a campaign into an alert.

**Classification is the caller's responsibility.** The `send-email-safe` skill takes `trafficClass` as an argument; the plugin doesn't heuristically classify message bodies. Two safeguards keep classification honest:

1. **Fail closed on ambiguity.** Missing or unrecognized `trafficClass` → the plugin defaults to `cold_outbound`. Over-guarding is cheap; under-guarding gets you blacklisted.
2. **Campaign-context override.** When the caller passes `campaignContext: true`, the plugin locks class to `cold_outbound` regardless of what was declared. Campaign runners have no legitimate reason to send `personal` or `reply`.

## Tools

The plugin registers three tools when enabled:

### `email_warden_check_send`

Ask the warden whether a proposed send is permitted.

| Parameter | Type | Notes |
|---|---|---|
| `mailbox` | string | Sending address |
| `recipient` | string | Recipient address |
| `trafficClass` | enum (optional) | Defaults to `cold_outbound` if missing or unknown |
| `cost` | integer ≥ 1 (optional) | Currently stored but not yet consumed by caps |
| `campaignContext` | boolean (optional) | Locks class to `cold_outbound` |

Returns one of:

- `{ decision: "allow", class }`
- `{ decision: "defer", class, sendAfter, reason }` — `sendAfter` is ISO 8601; `reason` is one of `min-gap` / `jitter` / `micro-pause` / `working-hours`
- `{ decision: "deny", reason }` — paused mailbox, hard-pause tripwire, or daily/hourly cap reached
- `{ decision: "suppressed", reason }` — recipient is on the suppression list

### `email_warden_record_send`

Record the outcome of a send. Call this immediately after the underlying send completes (success or error).

| Parameter | Type | Notes |
|---|---|---|
| `mailbox` | string | |
| `recipient` | string | |
| `class` | enum | The class returned by `email_warden_check_send` |
| `cost` | integer ≥ 1 (optional) | Defaults to 1; bumps `aggregates.daily.send.calls` by 1 regardless of cost in v0.1 |
| `result` | `"ok"` \| `"error"` | |
| `messageId` | string (optional) | |
| `errorStatus` | integer (optional) | |
| `reason` | string (optional) | |

### `email_warden_record_event`

Record an inbound event observed for a previously-sent message. Called by an ingestion bridge (Gmail Pub/Sub, vendor webhook, etc.). When `cat` is `bounce` or `unsubscribe`, the recipient is added to the mailbox's suppression list automatically.

| Parameter | Type | Notes |
|---|---|---|
| `mailbox` | string | |
| `cat` | `"bounce"` \| `"reply"` \| `"complaint"` \| `"unsubscribe"` | |
| `class` | enum | Class of the original send |
| `recipient` | string | |
| `reason` | string (optional) | |

## Ledger format

Mirrors the shape used by `openclaw-unipile` at `unipile/<accountId>/usage.json`. email-warden persists to:

```
<openclaw-root>/plugins/email-warden/<mailboxAddress>/usage.json
```

Daily aggregates are keyed by `EventCategory` (`send`, `bounce`, `reply`, `complaint`, `unsubscribe`) — *not* by traffic class. The class is recorded on each event in `events[]`, so per-class rates are computed from the event log.

Example:

```json
{
  "version": 1,
  "mailbox": "emma@copilotai.com",
  "tier": "gws-standard",
  "timezone": "America/Vancouver",
  "createdAt": "2026-04-24T00:00:00Z",
  "updatedAt": "2026-04-24T14:22:18Z",
  "warmup": { "stage": 0, "plateauReachedAt": null },
  "aggregates": {
    "daily": {
      "2026-04-24": {
        "send":        { "calls": 18, "penalty": 0 },
        "bounce":      { "calls": 0,  "penalty": 0 },
        "reply":       { "calls": 2,  "penalty": 0 },
        "complaint":   { "calls": 0,  "penalty": 0 },
        "unsubscribe": { "calls": 0,  "penalty": 0 }
      }
    },
    "monthly": {},
    "perRecipientDomain": {
      "2026-04-24": { "acme.com": 3, "example.org": 1 }
    }
  },
  "lastCallAt": { "send": "2026-04-24T14:21:02Z" },
  "lastCooldownAt": {},
  "suppressed": [
    { "recipient": "leads@example.com", "reason": "hard-bounce", "at": "2026-04-22T10:00:00Z" }
  ],
  "events": [
    { "t": "2026-04-24T14:21:02Z", "cat": "send",   "class": "cold_outbound", "cost": 1, "result": "ok",       "recipient": "x@acme.com",    "messageId": "CAF..." },
    { "t": "2026-04-24T14:05:11Z", "cat": "send",   "class": "reply",         "cost": 1, "result": "ok",       "recipient": "ceo@bigco.com", "messageId": "CAG..." },
    { "t": "2026-04-24T13:40:22Z", "cat": "bounce", "class": "cold_outbound", "cost": 0, "result": "observed", "recipient": "noone@acme.com" }
  ]
}
```

`penalty` is incremented when an event has `result: "error"` — it's a per-day failed-send counter. `calls` is incremented for every event in that category regardless of outcome.

Writes are atomic (`tmp` file + rename), so a partial write can never corrupt the ledger.

## Storage and retention

The ledger is hot-path state — `checkSend` reads it on every decision and `recordSend` writes it on every send. Without retention discipline it grows unbounded (a mailbox doing 40 sends/day produces ~15k events/year), and atomic rewrites get progressively slower. The plugin enforces these caps so the file stays ~200KB/mailbox indefinitely:

| Field | Retention | Rationale |
|---|---|---|
| `events` | Last `retention.maxEvents` entries (default **1000**) | Largest tripwire window is 500 sends; 1000 leaves headroom + keeps enough history for post-incident review |
| `aggregates.daily` | Last `retention.dailyRetentionDays` (default **90**); older entries roll into `aggregates.monthly` | 90 days covers any rolling window we'd reasonably report on |
| `aggregates.monthly` | Indefinite | ~12 entries/year is effectively free |
| `aggregates.perRecipientDomain` | Last `retention.perDomainRetentionDays` (default **14**) | Per-domain throttle rules don't look back farther |
| `suppressed` | Indefinite | Small, load-bearing — a recipient who unsubscribed must stay suppressed forever |
| `lastCallAt`, `lastCooldownAt` | Current values only | Overwritten, not appended |

Compaction runs inline on every `appendEvent` call (cheap: check length, slice, update daily→monthly roll). No background job needed at this scale.

**Migration path.** If a mailbox routinely exceeds ~500 sends/day and per-decision parse cost becomes noticeable, migrate the store to SQLite. openclaw already ships SQLite (`cron/registry.sqlite`) so it's not a new dependency. The plugin's external API (`email_warden_check_send`, `email_warden_record_send`, `email_warden_record_event`) stays identical — only the persistence layer changes. Don't pre-migrate; the JSON approach is inspectable-by-humans, which is worth a lot during the first few months of tuning tripwires.

## Config shape

Goes under `plugins.entries.email-warden` in `openclaw.json`. Validated against `openclaw.plugin.json#configSchema` (AJV). Defaults are filled in by `normalizeConfig` in `index.ts`, so most fields are optional.

```json
"email-warden": {
  "enabled": true,
  "config": {
    "stateDir": "email-warden",
    "mailboxes": {
      "default": {
        "timezone": "America/Vancouver",
        "workingHours": { "start": "08:30", "end": "17:15" },
        "workingDays": ["mon", "tue", "wed", "thu", "fri"],
        "limits": {
          "send":        { "perDay": 40, "perHour": 8, "minGapSeconds": 90 },
          "perRecipientDomainPerHour": 3
        },
        "warmup": {
          "enabled": true,
          "startPerDay": 15,
          "rampPerDay": 3,
          "plateauPerDay": 40
        }
      },
      "overrides": {
        "emma@copilotai.com": {
          "limits": { "send": { "perDay": 50, "perHour": 10, "minGapSeconds": 60 } }
        }
      }
    },
    "jitter": {
      "enabled": true,
      "distribution": "lognormal",
      "lognormal": { "medianSeconds": 140, "sigma": 0.6 },
      "clampSeconds": { "min": 45, "max": 900 },
      "microPause": {
        "probability": 0.04,
        "durationSeconds": { "min": 600, "max": 2400 }
      },
      "sendOutsideWorkingHours": "defer"
    },
    "tripwires": {
      "bounceRateSlowRot": { "classes": ["cold_outbound", "follow_up"], "window": { "hours": 48, "minSends": 20 }, "maxRate": 0.03,  "action": "alert" },
      "bounceRate":        { "classes": ["cold_outbound", "follow_up"], "window": { "sends": 100 },                "maxRate": 0.02,  "action": "pause-mailbox" },
      "spamComplaint":     { "classes": ["cold_outbound", "follow_up"], "window": { "sends": 500 },                "maxRate": 0.001, "action": "pause-mailbox" },
      "replyRateFloor":    { "classes": ["cold_outbound"],              "window": { "sends": 200 },                "minRate": 0.01,  "action": "alert" },
      "warmupBounce":      { "classes": ["warmup_send"],                "window": { "sends": 50 },                 "maxRate": 0.03,  "action": "pause-warmup" }
    },
    "suppression": {
      "scope": "global",
      "honorUnsubscribeWithinHours": 48
    },
    "retention": {
      "maxEvents": 1000,
      "dailyRetentionDays": 90,
      "perDomainRetentionDays": 14
    },
    "ingestion": {
      "adapters": [
        {
          "kind": "gmail-pubsub",
          "enabled": true,
          "mode": "push",
          "topic": "projects/copilotai/topics/gmail-warden",
          "pushPath": "/email-warden/gmail-pubsub",
          "secretEnv": "EMAIL_WARDEN_PUBSUB_SECRET",
          "mailboxes": ["emma@copilotai.com"]
        }
      ]
    },
    "alerts": {
      "slackChannel": "C0AU7LPARL7",
      "onPause": true,
      "onDailyRollup": true
    }
  }
}
```

Defaults worth highlighting:

- **`perDay: 40`** applies to *all* classes combined (Gmail sees the total). Well under Nylas's 700/grant threshold; room to grow per mailbox reputation.
- **Tripwires are scoped by `classes`.** Each tripwire reads only events in the listed classes. Bounce/complaint rules cover both `cold_outbound` and `follow_up` (same risk profile). Reply-rate floor is `cold_outbound`-only — a follow-up's reply rate is mechanically higher and would confuse the metric.
- **Tripwires come in two window shapes.** `{ sends: N }` evaluates against the last N sends of the matching class. `{ hours: H, minSends: M }` evaluates against all matching sends in the last H hours, but only fires if at least M landed in that window. Send-count catches bursts; time-window catches slow rot at low volume.
- **`sendOutsideWorkingHours: "defer"`** applies to the classes with full pacing (`cold_outbound`, `warmup_send`, `follow_up`). Replies and personal sends bypass the gate — humans reply at odd hours, and holding a personal email until Monday morning is the opposite of the human-pacing signal we want.

Configuring an ingestion adapter today is a no-op aside from validation: the plugin logs `ingestion adapter "<kind>" is configured but not yet implemented` at startup and continues. Until adapters ship, feed events through `email_warden_record_event` from your own bridge.

## Jitter and human-pacing

Pacing is layered by traffic class, not applied uniformly:

| Mechanism | `cold_outbound`, `warmup_send`, `follow_up` | `reply`, `personal`, `transactional` |
|---|---|---|
| Lognormal inter-send gap (median ~140s, σ ~0.6, clamped `[45s, 15min]`) | Yes | No |
| Working-hours gate (defer outside window) | Yes | No |
| Micro-pause (~4% chance, 10–40min) | Yes | No |
| Short safety gap (`minGapSeconds` from global limits) | Yes | Yes |

**Why the class-aware pacing.** Lognormal over uniform because uniform jitter leaves a rectangular fingerprint in timestamps; lognormal's long right tail matches how humans actually batch work. Micro-pauses simulate someone stepping away — they break up the otherwise-detectable "steady cadence" signature of a bot, which is exactly the signal Gmail's classifier looks for in cold traffic. For replies and personal sends, deferring to the next working hour would make the mailbox visibly *less* human, not more. The short global min-gap still applies to everything so the mailbox doesn't accidentally burst-send in a way that looks like script-wrapped API calls.

`email_warden_check_send` returns `sendAfter` rather than sleeping — enqueueing the actual send at that time is the caller's job. Keeps the plugin non-blocking and makes the queue inspectable.

## Integration

### `send-email-safe` skill

Bundled in `skills/send-email-safe/`. The plugin exposes it through the `skills` entry in `openclaw.plugin.json` so it loads automatically when the plugin is enabled.

The skill wraps every outbound send. Procedure:

1. `gws_get_account` (or equivalent) → get the sending mailbox.
2. `email_warden_check_send({ mailbox, recipient, trafficClass, cost: 1 })`.
   - Caller MUST pass `trafficClass`. If omitted or unrecognized, the plugin defaults to `cold_outbound` (fail-closed).
   - Pass `campaignContext: true` from a campaign runner; the plugin overrides class to `cold_outbound`.
3. Branch on the decision:
   - `allow` → call `gws_send_email`, then `email_warden_record_send(...)` with the final `class` the plugin returned.
   - `defer` → return `{ status: "deferred", sendAfter }`. The caller re-invokes after `sendAfter`.
   - `deny` or `suppressed` → return the reason; do not retry.
4. On any send error, `email_warden_record_send({ result: "error", errorStatus })` so the failure counter bumps.

Hard rules enforced in the skill prompt:

- **If `email_warden_check_send` is unreachable, fail closed** — return `denied`. Never send without a decision.
- **The agent must label `trafficClass` truthfully.** A cold prospect email sent from a campaign context is `cold_outbound`, not `personal`, even if the agent thinks the content is friendly. The plugin's `campaignContext` override is a backstop, not an excuse to be loose with labels elsewhere.

### Inbound ingestion (today)

Ingestion adapters (Gmail Pub/Sub, Gmail polling) are scaffolded but not implemented. To feed bounces / replies / complaints / unsubscribes into the ledger today, call `email_warden_record_event` from whatever code observes the event — a webhook handler, a polling worker, or a hook on the `hooks.gmail` stream.

## Known limitations

- **Outcome→send linking is by `(recipient, time)`, not `messageId`.** The tripwire evaluator attributes each bounce/reply/complaint to the most recent prior send to the same recipient. That works correctly when an ingestion bridge writes outcomes with the recipient address, but if a bounce arrives for a recipient with no prior send in the events log (e.g. the originating send was evicted by the 1000-event retention cap, or the bridge passes a different recipient form), the outcome is silently dropped. If we end up wanting stricter correctness, the path is to thread `messageId` through `email_warden_record_event` and link by ID.
- **`cost` doesn't gate caps.** The cost parameter is plumbed through and stored, but `checkGlobalLimits` counts call rows, not summed cost. A `cost: 5` send still consumes 1 budget unit toward `perDay` and `perHour`.
- **Per-recipient-domain throttle is data-only.** Counts are tracked in `aggregates.perRecipientDomain` but `checkSend` doesn't gate on `policy.limits.perRecipientDomainPerHour` yet.
- **Suppression is per-mailbox.** A recipient who unsubscribed from mailbox A can still be emailed from mailbox B. If you're rotating multiple GWS accounts in a campaign, dedupe at the campaign-runner level until cross-mailbox suppression lands.
- **Tripwire actions other than `pause-mailbox` are emitted but not enforced.** `pause-warmup`, `pause-campaign`, and `suppress-recipient` are in the schema and the evaluator returns them, but `checkSend` only short-circuits on `pause-mailbox`. Treat the others as alerting-only for now.
- **No Slack delivery.** `alerts.slackChannel`, `alerts.onPause`, `alerts.onDailyRollup` are config-only — nothing posts to Slack yet. To get notified, watch the per-mailbox `usage.json` or wrap the tools.

## Open questions

These weren't resolved during design and remain open:

1. **Does openclaw expose a true tool-call interceptor?** If yes, enforcement could be moved from cooperative (skill calls plugin) to runtime-enforced. Until then, skills have to opt in via `send-email-safe`.
2. **Cross-mailbox suppression schema.** When campaigns rotate across multiple GWS accounts, the suppression list must be global (unsubscribed from A → never email from B), but tripwire state should remain per-mailbox. The asymmetry needs a deliberate schema before building.
3. **Outcome-to-send linking — strict correctness.** v0.1 attributes by `(recipient, most-recent-prior-send)`. If we hit a case where retention or recipient-form differences cause meaningful drift in observed rates, switch to `messageId`-based linking — but that requires the ingestion bridge to thread the original send's message ID through `email_warden_record_event`.

## References

- [Nylas — Improving email delivery](https://developer.nylas.com/docs/dev-guide/best-practices/improving-email-delivery/) — source for the 700/day grant threshold, 5k/day Gmail auth requirement, and the 2-day unsubscribe window.
- `openclaw-unipile` — ledger-format reference. See `unipile/<accountId>/usage.json` in any openclaw deployment for a concrete example of the `aggregates` / `lastCallAt` / `events` shape this plugin imitates.
