---
name: sdr-like-audience-list
description: "Build a lookalike prospect list by analyzing an AE's closed-won deals, extracting customer patterns, finding similar businesses and decision-makers via Explorium, enriching with contact info, and deduplicating against HubSpot. Use when asked to build a target list, find new leads like existing customers, create a lookalike audience, prospect list from closed-won patterns, or cold outreach list for an AE. Triggers: like audience, lookalike list, prospect list, target list, find leads like, build outreach list, new leads for AE, cold outreach list."
---

# SDR Like Audience List

Build a net-new prospect list for cold outreach by analyzing an AE's closed-won customer profile and finding lookalike decision-makers via Explorium.

## Prerequisites

- HubSpot connected (Composio) — for closed-won deal analysis and dedup
- Explorium AgentSource CLI — for prospect discovery and enrichment
- See the `vibe-prospecting` skill for full Explorium CLI reference

## Workflow

### Step 1 — Analyze Closed-Won Profile

Use the `sdr-reactivation-list` skill's Steps 1–4 to pull and analyze the AE's closed-won deals. Extract:

- Industry patterns (what types of businesses they close)
- Company size patterns (employee count range)
- Deal size patterns (price points they win at)
- Plan types (Guided, Core, Teams, White-label)
- Geography (US, Canada, etc.)
- Decision-maker titles (Owner, Founder, CEO, etc.)

This profile drives the Explorium search filters.

### Step 2 — Map Profile to Explorium Filters

Translate the AE's winning patterns into Explorium API filters. Key mappings:

| AE Pattern | Explorium Filter | Notes |
|-----------|-----------------|-------|
| Industry | `linkedin_category` | MUST autocomplete first |
| Company size | `company_size` | Values: `1-10`, `11-50`, `51-200`, etc. |
| Geography | `country_code` | Values: `us`, `ca`, etc. |
| Decision-maker title | `job_title` | MUST autocomplete first |
| Buying intent | `business_intent_topics` | Optional, autocomplete first |

**Always autocomplete** `linkedin_category`, `job_title`, and `business_intent_topics` before using them in filters. Use `--semantic` flag.

### Step 3 — Market Sizing (Free)

Run a statistics call to see the total addressable universe:

```bash
python3 "$CLI" statistics \
  --entity-type prospects \
  --filters '{...}' \
  --plan-id "$PLAN_ID"
```

If >50K results, consider narrowing. If <100, broaden filters. Present the count to the user.

### Step 4 — Fetch Prospects

Fetch a batch (default 50, adjust per request):

```bash
python3 "$CLI" fetch \
  --entity-type prospects \
  --filters '{...}' \
  --limit 50 \
  --plan-id "$PLAN_ID"
```

**Entity type decision:** Use `prospects` (not `businesses`) when the goal is a cold outreach list — prospects come with names, titles, and can be enriched with contact info.

### Step 5 — Enrich with Contact Info

Add emails and phone numbers:

```bash
python3 "$CLI" enrich \
  --input-file "$FETCH_RESULT" \
  --enrichments "contacts_information" \
  --plan-id "$PLAN_ID"
```

Contact data is nested under `contacts_information`:
- `contacts_information.professions_email` — best work email
- `contacts_information.emails[]` — all emails with types (`current_professional`, `personal`)
- `contacts_information.phone_numbers[]` — phone numbers
- `contacts_information.mobile_phone` — mobile number

**Email priority:** `professions_email` > `current_professional` type > first available email.

### Step 6 — Deduplicate Against HubSpot

Check all prospect emails against HubSpot contacts:

```
HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA
  filterGroups:
    - email IN {batch of 5 emails}
  properties: email, firstname, lastname, lifecyclestage, hs_lead_status
```

Batch in groups of 5 (HubSpot IN filter limit). Run batches in parallel (5 concurrent) for speed.

Remove any prospects whose email matches an existing HubSpot contact. Flag but don't remove leads with lifecycle = `lead` (they may be worth re-engaging differently than net-new outreach).

### Step 7 — Export and Present

Build the final list with:
- First Name, Last Name, Title, Company, Website, Email, Phone, City, Country, LinkedIn

Export to CSV: `{ae-name}-lookalike-leads.csv`

Present in Slack with:
1. Method summary (what profile drove the search)
2. Universe size (total matching in Explorium)
3. Fetch/enrich/dedup stats
4. Net-new count
5. Highlighted picks (3-5 strongest fits with reasoning)
6. Offer to pull larger batches or refine

## Overlap Detection (Multi-AE Runs)

When generating lookalike lists for multiple AEs in the same session or request:

1. **Track all prospect lists generated in the current workflow.** After each AE's list is built, hold the full set of prospect emails/names in memory.
2. **After each subsequent list, check for overlap** against all previously generated lists in this workflow. Compare on email (primary) and full name + company (fallback).
3. **If overlap is detected (any duplicates across AE lists), pause and flag it** before delivering. Tell the requester:
   - How many prospects overlap and between which AEs' lists
   - Suggest refinement options to minimize overlap, e.g.:
     - Pull larger batches (200+) and split/deduplicate across AEs
     - Differentiate filters per AE based on their closed-won profile (e.g., AE who closes more financial services gets financial services prospects; AE who's more diversified gets consulting/marketing)
     - Assign overlapping prospects to the AE whose closed-won profile is the strongest match
4. **Do not deliver overlapping lists without the requester confirming** how they want the overlap handled. Wait for their direction.
5. **This applies to any list-generation workflow** — not just when lists are requested together. If you're building a list and recall recently building one for a different AE (check daily notes / LCM), flag potential overlap proactively.

## Key Details

- **Credit cost:** ~1 Explorium credit per entity fetched. Enrichment costs additional credits. Always show the universe size and get confirmation before large fetches.
- **Autocomplete is mandatory** for `linkedin_category`, `job_title`, `business_intent_topics`, and `city` fields. Use exact values returned by autocomplete, not raw user input.
- **Filter mutual exclusions:** Never combine `linkedin_category` + `naics_category`. Never combine `country_code` + `region_country_code`. Never combine `job_title` + `job_level`/`job_department`.
- **Intent topics may return empty** when combined with narrow industry + size + geography filters. If stats return 0, drop intent and rely on industry + title targeting.
- **HubSpot dedup batching:** IN operator supports max ~5 values per filter. Parallelize batches with ThreadPoolExecutor.

## References

- See `references/explorium-filter-cheatsheet.md` for common filter combinations
- See the `vibe-prospecting` skill for full Explorium CLI documentation
- See the `sdr-reactivation-list` skill for the closed-won analysis workflow
