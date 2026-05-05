# Explorium webhooks / enrollments — investigation notes

Status: **research, not implemented in v1**.

## Update from live MCP probe (2026-04-30)

A live `tools/list` against `https://mcp.explorium.ai/mcp` returned **12 tools**, none of
which are enrollment management:

```
match-business, fetch-businesses, fetch-businesses-statistics, fetch-businesses-events,
enrich-business, match-prospects, fetch-prospects, fetch-prospects-statistics,
fetch-prospects-events, enrich-prospects, autocomplete, web-search
```

So enrollment CRUD (`add_businesses_enrollments`, etc.) is **not exposed via MCP** — it
only lives in the REST API today. This changes the v1 picture: enrollment management is
no longer a free side-effect of MCP discovery.

`fetch-businesses-events` and `fetch-prospects-events` *are* exposed, so polling-based
event retrieval is fully covered through the plugin without any extra work.

## Open questions

1. **Subscription flow.** Confirm the exact request/response shape from
   <https://developers.explorium.ai/reference/businesses/events/add_businesses_enrollments>:
   - Required fields (business id list, event types, callback URL?).
   - Whether the callback URL is set per-enrollment or globally on the Explorium account.
   - Event-type catalog and delivery semantics (at-least-once? ordering? retries?).

2. **Callback registration.** Where is the webhook callback URL configured —
   Explorium dashboard, account-level API call, or per-enrollment? Affects whether the
   plugin can self-provision endpoints or whether an operator must set it up once.

3. **Inbound auth.** What signing scheme does Explorium use on the webhook payload?
   HMAC header? Shared secret? Mutual TLS? We need to validate before trusting events.

4. **Backfill.** `fetch-businesses-events` covers the gap between subscription creation
   and first delivery — confirm the lookback window and whether dedupe-by-event-id is
   the caller's responsibility.

5. **Where the callback lives.** OpenClaw plugins don't expose inbound HTTP today.
   Options:
   - A dedicated webhook relay (e.g. small Vercel function) that forwards verified
     events into a queue the agent polls or subscribes to.
   - An OpenClaw host-level webhook receiver, if/when one exists.
   - Skip webhooks entirely and have the agent poll `fetch-businesses-events` on a
     schedule for the enrolled business ids.

6. **Rate / cost.** Confirm whether enrollments themselves consume credits, and the
   per-account enrollment cap (Explorium docs cite limits in the rate-limit section).

## Recommendation for v1

- **Event retrieval:** ship as-is — `fetch-businesses-events` and
  `fetch-prospects-events` are auto-discovered MCP tools, no extra code.
- **Enrollment CRUD:** out of scope until either (a) Explorium adds these to MCP, or
  (b) we add a small REST-wrapped tool set in this plugin. Recommend deferring until a
  user actually needs subscription-based events.
- **Receiving webhook callbacks:** out of scope. Requires standing up a relay; revisit
  once the plugin host supports inbound HTTP, or when a use case justifies the relay.
