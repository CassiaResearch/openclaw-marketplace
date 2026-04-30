---
name: send-email-safe
description: Send an email through Google Workspace with the Email Warden plugin enforcing rate limits, jitter, working-hours gates, and bounce/reply/complaint tripwires. Use this for EVERY outbound email — never call the raw GWS send tool directly.
metadata:
  {
    "openclaw":
      {
        "emoji": "📬",
        "requires": { "config": ["plugins.entries.email-warden.enabled"] },
      },
  }
---

# send-email-safe

Wraps every outbound email so the Email Warden can enforce sending safety. The warden tracks send/bounce/reply rates per mailbox, applies pacing and working-hours gates, maintains a suppression list, and denies further sends from a mailbox when a tripwire (bounce / complaint rate, etc.) is firing.

**Hard rule: never call the raw GWS send tool directly.** All sends go through this skill so every message is counted, paced, and checked against the suppression list and tripwires.

## When to use which traffic class

Every call MUST declare a `trafficClass`. The warden uses it to decide which limits, jitter, and tripwires apply. Choose truthfully — classification is the caller's responsibility, and label-drift is audited.

| Class | Use for | Guardrails applied |
| --- | --- | --- |
| `cold_outbound` | First-touch to a prospect who has never replied | Full: daily/hourly caps, min-gap, lognormal jitter, working-hours gate, micro-pauses, bounce/complaint/reply-floor tripwires |
| `follow_up` | Follow-up to a prospect in an active cold thread | Full: daily/hourly caps, min-gap, lognormal jitter, working-hours gate, micro-pauses; bounce/complaint tripwires, no reply-floor |
| `warmup_send` | Inter-mailbox or known-good traffic during warm-up ramp | Full pacing, warmup-specific tripwires |
| `reply` | Reply to a human who wrote to the mailbox | Global caps only — no jitter, no working-hours gate |
| `personal` | Ad-hoc personal correspondence | Global caps only |
| `transactional` | Booking confirmations, meeting invites | Global caps only |

**If you are unsure, use `cold_outbound`.** The warden will also default to `cold_outbound` when `trafficClass` is missing or unrecognized (fail-closed).

## Procedure

### Step 1 — identify the sending mailbox

Call `gws_get_account` (or equivalent) to get the mailbox address the send will go from.

### Step 2 — ask the warden for permission

Call `email_warden_check_send`:

| Parameter | Description |
| --- | --- |
| `mailbox` | The sending address from step 1 |
| `recipient` | The recipient address |
| `trafficClass` | One of the values above |
| `cost` | Optional. Defaults to 1. Plumbed end-to-end and stored on the event, but not currently consumed by daily/hourly caps (they count call rows). Pass an honest value anyway — the field will start gating caps in a future version. |
| `campaignContext` | Pass `true` when invoked from a campaign-runner flow. The warden will lock class to `cold_outbound` regardless of what you pass above. |

The response is a decision object. Branch on `decision`:

- **`allow`** — proceed to step 3.
- **`defer`** — do NOT send now. The response includes `sendAfter` (ISO 8601). Return `{ status: "deferred", sendAfter }` to your caller so the campaign runner can re-invoke this skill at or after that timestamp; sleeping in-process until `sendAfter` and re-checking is also fine. Note that jitter and micro-pause delays are re-sampled on every `email_warden_check_send` call, so a re-check before `sendAfter` will return a new `sendAfter` (the min-gap component is stable, but the jitter atop it is freshly drawn). Don't poll in a tight loop — wait until the timestamp the warden gave you, then re-check.
- **`deny`** — the warden refused (rate cap, tripwire, paused mailbox). Return `{ status: "denied", reason }` to your caller. Do not retry automatically.
- **`suppressed`** — the recipient is on the suppression list (previously bounced or unsubscribed). Return `{ status: "suppressed", reason }`. Do NOT retry, ever, for this recipient.

> **Pacing is mailbox-scoped, not recipient-scoped.** The min-gap floor is read from the mailbox's `lastCallAt.send`, so any `cold_outbound` / `follow_up` / `warmup_send` check from that mailbox — even for a different recipient — will be deferred at least until min-gap elapses. This is intentional: the pacing protects the sending mailbox's reputation, which is per-sender, not per-(sender, recipient). Don't try to "shop around" by picking a different recipient to bypass pacing.

### Step 3 — send the email

On `allow`, call the underlying GWS send tool (e.g. `gws_send_email`) with the prepared message.

### Step 4 — record the outcome

Call `email_warden_record_send` **immediately** after the send completes (success or error):

| Parameter | Value |
| --- | --- |
| `mailbox` | Same as step 2 |
| `recipient` | Same as step 2 |
| `class` | The class returned by `email_warden_check_send` (which may differ from what you passed if `campaignContext` was true) |
| `result` | `"ok"` if the send succeeded, `"error"` if it threw |
| `messageId` | GWS message ID on success |
| `errorStatus` | HTTP / GWS error code on error |

## Hard rules

1. **Never bypass `email_warden_check_send`.** Even if the warden is slow, down, or returning unexpected decisions, do not fall back to calling GWS directly.
2. **If `email_warden_check_send` is unreachable or errors, fail closed.** Return `{ status: "denied", reason: "guardrails unavailable" }` to the caller. Never send without an approval.
3. **Record the outcome truthfully.** Call `email_warden_record_send` for every send, success or error. Missing records cause the warden to under-count and over-permit subsequent sends.
4. **Use the class the warden returned**, not the one you passed in. The warden's `campaignContext` override may have changed it.
5. **Do not alter the recipient, subject, or body in response to a `defer` or `deny`.** The decision is about *when* and *whether* to send the message as-is, not about reshaping the message.

## Example

```
user: Send a cold intro email to jane@acme.com about our new feature.

[agent prepares message in working memory]

[agent calls gws_get_account → { email: "emma@copilotai.com" }]

[agent calls email_warden_check_send with:
  mailbox: "emma@copilotai.com"
  recipient: "jane@acme.com"
  trafficClass: "cold_outbound"
]

[warden returns: { decision: "allow", class: "cold_outbound" }]

[agent calls gws_send_email with the prepared message]

[agent calls email_warden_record_send with:
  mailbox: "emma@copilotai.com"
  recipient: "jane@acme.com"
  class: "cold_outbound"
  result: "ok"
  messageId: "CAF..."
]

agent: Sent. Message ID: CAF...
```

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Every send returns `deferred` with `sendAfter` far in the future | Working-hours gate is deferring to next open window | Check the mailbox's `workingHours` / `workingDays` / `timezone` in the plugin config |
| Sends returning `denied` with a rate-detail reason like `"bounceRate: 3.50% > 2.00% over 100 sends"` | A tripwire with `action: "pause-mailbox"` is firing on the mailbox's recent events | Inspect `<openclaw-root>/plugins/<stateDir>/<sanitizedMailbox>/usage.json` (default `stateDir` is `email-warden`) to see the events driving the rate; the deny lifts automatically once the rule's window no longer matches |
| Sends returning `denied: "mailbox paused"` | An operator (or external process) set `pausedUntil` on the ledger | Inspect / clear `pausedUntil` and `pausedReason` in the mailbox's `usage.json` |
| `suppressed` on a recipient you thought was safe | Prior hard bounce or unsubscribe recorded for that address | Check the `suppressed` array in the mailbox's `usage.json`; removal is a deliberate operator action, not an agent decision |
| Hourly cap hit repeatedly | `limits.send.perHour` is too low for the campaign's pace | Raise the cap in config, or pace the campaign runner to respect the existing cap |
