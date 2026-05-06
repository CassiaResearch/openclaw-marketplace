---
name: explorium
description: B2B research via Explorium — look up companies and people, enrich firmographic and contact data, fetch business and prospect events, and search by filter criteria. Use when the user wants to find companies matching a profile, enrich a list of companies or contacts, identify decision-makers at a target account, or pull intent / hiring / funding signals.
metadata:
  { "openclaw": { "emoji": "🔎" } }
allowed-tools:
  [
    "explorium__match-business",
    "explorium__fetch-businesses",
    "explorium__fetch-businesses-statistics",
    "explorium__fetch-businesses-events",
    "explorium__enrich-business",
    "explorium__match-prospects",
    "explorium__fetch-prospects",
    "explorium__fetch-prospects-statistics",
    "explorium__fetch-prospects-events",
    "explorium__enrich-prospects",
    "explorium__autocomplete",
    "explorium__web-search",
  ]
---

# Explorium

Use this skill to answer B2B research questions: find companies that match a profile, identify the right people inside a target account, enrich rows the user already has, or pull signals (funding, hiring, news) on a watchlist. Not for: outbound messaging, CRM writes, or general-purpose web research — `explorium__web-search` is here for *Explorium-context* lookups (resolving an ambiguous company name), not as a replacement for a real search tool.

The two core entity types are **businesses** (companies) and **prospects** (employees / contacts). Each has the same four-verb shape: `explorium__match-*` resolves a name/criteria to an Explorium id, `explorium__fetch-*` lists by filter, `explorium__fetch-*-statistics` aggregates, `explorium__enrich-*` returns rich detail by id. `explorium__autocomplete` returns the canonical values you must use in filter fields (industry, country, role, seniority, etc.). `explorium__web-search` is for free-text resolution.

## Always match before you fetch or enrich

Almost every workflow starts with a match call. `explorium__enrich-business` and `explorium__enrich-prospects` require Explorium business/prospect ids — they will not accept a free-text company name or email. The standard arc:

```
explorium__match-business   "Acme Inc, San Francisco"        → business_id
explorium__enrich-business  business_id                       → firmographics, tech stack, etc.
explorium__match-prospects  { business_id, role, seniority } → prospect_ids
explorium__enrich-prospects prospect_ids                      → emails, LinkedIn, phone
```

If the user already gave you a domain or LinkedIn URL, pass that directly to `explorium__match-business` — it disambiguates better than a bare company name.

## Filter values come from `explorium__autocomplete`

`explorium__fetch-businesses`, `explorium__fetch-prospects`, and the statistics tools take filters like `country`, `industry`, `seniority`, `role`, `linkedin_industry`, etc. Don't guess the value strings — call `explorium__autocomplete` first with the field name and a partial query to get the canonical list. Passing `industry: "tech"` will silently return zero matches; passing the autocomplete-resolved value works.

## Enrichments are billed; bulk when possible

`explorium__enrich-business` and `explorium__enrich-prospects` accept arrays of ids. Always batch. For ~5+ rows, a single bulk call is cheaper, faster, and keeps rate-limit headroom for the rest of the session. Don't loop one-id-at-a-time when the user hands you a list.

## Pagination

`explorium__fetch-*` endpoints take `page` and `size`. Default to `size: 25`. Only widen if the user explicitly asks for more — the response payloads are large and full pages can cost more than expected.

## Events

`explorium__fetch-businesses-events` and `explorium__fetch-prospects-events` return signal events (funding rounds, hires, job changes, etc.) for a list of ids over a time window. Use them when the user asks for "what's happening at" or "any signals from" a target list. They're polling-only — there's no webhook subscription.

## Errors

A failed call comes back with `isError: true` and the upstream message. Surface the message to the user verbatim and don't retry blindly — most failures are bad parameter values (use `explorium__autocomplete`) or rate limits (back off). A 401/403 means the API key is wrong; tell the user to check the `mcp.servers.explorium` config and stop.

## When NOT to use Explorium

- **Real-time news** — events lag and are categorised, not narrative. Use a news/web tool.
- **Sending messages or updating a CRM** — read-only data source.
- **Email verification on a single random address** — the data is firmographic, not validation.
