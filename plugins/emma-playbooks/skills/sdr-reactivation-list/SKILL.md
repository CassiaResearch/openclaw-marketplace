---
name: sdr-reactivation-list
description: "Build a prioritized reactivation list for an AE by analyzing their closed-won deals and finding stale pipeline deals that match their winning patterns. Use when asked to find leads to reactivate, identify stale deals for an AE, revive dead pipeline, or re-engage prospects that went cold. Triggers: reactivation list, stale leads, dead pipeline, revive leads, re-engage prospects, warm up old leads, pipeline reactivation, lost deals."
---

# SDR Reactivation List

Build a prioritized list of deals to reactivate for a specific AE, based on patterns from their recent closed-won deals. Includes *all* non-customer deals — stale pipeline, closed-lost, disqualified, and leads that never progressed.

## Workflow

### Step 1 — Identify the AE

Get the AE's name from the request. Look up their HubSpot owner ID:

```
HUBSPOT_RETRIEVE_OWNERS → find owner by name → extract owner ID
```

### Step 2 — Get Pipeline Metadata

Pull deal pipeline stages to understand closed-won stage IDs across all pipelines:

```
HUBSPOT_RETRIEVE_ALL_PIPELINES_FOR_SPECIFIED_OBJECT_TYPE (deals)
```

Map stage IDs to labels. Identify all "closed-won" equivalent stages across pipelines (e.g., `closedwon`, `43339310` for Teams won, etc.).

### Step 3 — Pull Closed-Won Deals (Last 2 Months)

Search for the AE's recently closed deals:

```
HUBSPOT_SEARCH_DEALS
  filterGroups:
    - hubspot_owner_id = {owner_id}
    - dealstage IN {all closed-won stage IDs}
    - closedate GTE {2 months ago in epoch ms}
  properties: dealname, dealstage, pipeline, closedate, amount, hubspot_owner_id
  sorts: closedate DESCENDING
  limit: 100
```

Paginate if needed using `paging.next.after`.

### Step 4 — Analyze Winning Patterns

From the closed-won deals, extract:
- **Average deal size** and range
- **Pipeline distribution** (which pipelines they close in)
- **Plan types** (parse from deal names — Guided, Core, Teams, White-label, etc.)
- **Industry signals** (from deal names and associated contacts)
- **Volume vs. value** (many small deals vs. few large ones)

Present a summary of the AE's closing profile.

### Step 5 — Pull All Non-Customer Deals (Reactivation Universe)

Search for *all* of the AE's deals that are NOT closed-won. This captures the full reactivation universe:
- Open/stale pipeline deals
- Closed-lost deals
- Disqualified deals
- Leads that never progressed past early stages

```
HUBSPOT_SEARCH_DEALS
  filterGroups:
    - hubspot_owner_id = {owner_id}
    - dealstage NOT_IN {all closed-won stage IDs}
  properties: dealname, dealstage, pipeline, createdate, amount, hs_lastmodifieddate, closedate
  sorts: createdate ASCENDING
  limit: 100
```

Paginate if needed. This is intentionally broad — scoring in Step 7 handles prioritization.

### Step 6 — Enrich Deals with Contact Info

For each reactivation-candidate deal, get associated contacts:

```
HUBSPOT_READ_ASSOCIATIONS_BATCH (deals → contacts)
```

Then hydrate contacts with:

```
HUBSPOT_READ_CRM_OBJECT_BY_ID (contacts)
  properties: firstname, lastname, email, company, jobtitle, phone,
              lifecyclestage, hs_lead_status, industry, hs_analytics_source
```

### Step 7 — Score and Prioritize

Rank all non-customer deals by fit with the AE's winning patterns:

**Priority 1 — Best pattern match (warm pipeline):**
- Same pipeline as most closed-won deals
- Similar deal size to AE's average
- Similar industry/plan type
- Still in an active pipeline stage (not closed-lost)
- Most likely to convert with a nudge

**Priority 2 — Closed-lost / disqualified with good fit:**
- Was in the right pipeline/plan type but lost
- Deal size in range
- Worth re-engaging — circumstances may have changed
- Check closedate recency: more recent losses are warmer

**Priority 3 — Early-stage leads that never progressed:**
- Entered pipeline but stalled before meaningful engagement
- Weaker signal but large volume
- Best for batch outreach (email sequences, LinkedIn touches)

**Priority 4 — Existing customers (expansion):**
- Lifecycle = customer with a non-won deal still open
- Suggests upsell/cross-sell opportunity
- Already paying → warm conversation

### Step 8 — Present Results

Deliver as a structured Slack message with:
1. AE's closed-won profile summary (deal count, avg size, top patterns)
2. Prioritized reactivation list with contact details
3. For each deal: name, amount, stage, contact name/email/title, why it's a fit
4. Recommended next action (call, email, etc.)

## Key Details

- **Time windows:** Closed-won = last 2 months. Reactivation universe = ALL non-customer deals (no time filter — scoring handles recency). Adjust if requested.
- **Epoch milliseconds:** HubSpot date filters use epoch ms strings. Calculate from current UTC time.
- **Deal name parsing:** CoPilot AI deal names often follow the format `Company | Plan | Contact Name`. Split on `|` to extract company name.
- **Stage ID mapping:** Always fetch fresh pipeline metadata — stage IDs are portal-specific.
- **Pagination:** HubSpot search caps at 10,000 results. Use `paging.next.after` for multi-page results.

## References

- See `references/hubspot-stage-ids.md` for CoPilot AI's current pipeline/stage mapping (may need refreshing).
