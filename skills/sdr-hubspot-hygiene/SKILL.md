---
name: sdr-hubspot-hygiene
description: Execute HubSpot CRM data hygiene as an SDR at CoPilot AI. Covers post-call CRM updates, contact creation/updates, deal stage moves, meeting outcome logging, call activity logging, and lead status changes. Use when updating HubSpot after a call, logging a meeting outcome, moving a deal stage, creating a contact, DQ'ing a prospect, handling a no-show, or any CRM admin task. Also use when a post-call hook or standing order triggers CRM hygiene.
---

# SDR HubSpot Data Hygiene

Execute CRM updates correctly after any prospect interaction. Confluence is the canonical source for detailed procedures — fetch it when needed.

## Cardinal Rules (Always Apply)

1. **NEVER delete a meeting from HubSpot** — mark the outcome correctly.
2. **NEVER set Meeting Outcome to "Rescheduled"** — use "Cancelled" for the original, even if rescheduled.
3. **Deals only move FORWARD** — no skipping stages, no backwards movement.
4. **Use tracking booking links** for proper HubSpot attribution.
5. **Lifecycle stages auto-move** — do NOT manually change them. They're driven by HubSpot workflows.

## When to Fetch the Full Handbook

For detailed step-by-step procedures on specific scenarios (no-show sequences, cancellation flows, deal graveyard rules, AE closing admin), fetch the canonical source from Confluence:
- **Sales Ops | Data Hygiene Handbook** — Confluence page 2314928144 (space: GM)
- Use `COMPOSIO_MULTI_EXECUTE_TOOL` → `CONFLUENCE_GET_PAGE_BY_ID` with id `2314928144`.

Fetch it when:
- Handling a scenario you haven't encountered before
- Unsure which meeting outcome or lead status to set
- Dealing with deal graveyard or pipeline progression edge cases
- An AE asks about closing admin procedures

## Post-Call CRM Checklist

After every prospect call, execute these steps:

### 1. Contact Record
- Create contact if new (name, email, phone, title, company)
- Update existing contact with any new information from the call
- Set yourself as SDR owner if not already set
- Check contact ownership rules: if another active rep is listed, check for recent activity (3 months). If recent → it's their lead. If not → swap yourself in.

### 2. Log Call Activity
- Log call in HubSpot with:
  - Meeting type: Discovery
  - Outcome: Connected / Not Connected
  - Duration
  - Notes: call summary, key pain points, BANT qualification details

### 3. Meeting Outcome
Set based on what happened:

| Scenario | Meeting Outcome | Next Action |
|----------|----------------|-------------|
| Prospect attended, qualified | Completed | Book demo, handoff to AE |
| Prospect attended, not qualified | Completed | Set lead status (DQ + reason) |
| Prospect no-showed | No Show | Follow up: call → email (ad-hoc, personalized) |
| Prospect cancelled same day | Cancelled | Follow up or mark Demo Incomplete |
| Prospect asked to reschedule | Cancelled (original) | Book new meeting, create FU task |

### 4. Deal Stage Updates
- **Demo Booked:** Auto-created when demo is booked. Verify it exists.
- **Demo Incomplete:** Set when prospect can't be reached after no-show sequence (3+ emails, 3+ calls, texts).
- **Deal Disqualified:** When AE determines not qualified after brief conversation (NOT a full demo).

### 5. Lead Status Updates
- **Disqualified:** Set with appropriate DQ reason (fetch full list from Confluence if needed)
- **DNS:** Qualified but couldn't schedule demo. Stays for 3 months → Remarketing Potential.
- **No Contact:** Booked but never connected after full follow-up sequence.
- **Remarketing Potential:** Alignment on demo is 3+ months out. Marketing takes over.

## Deal Graveyard

- Deals with no external activity for 60+ days enter the graveyard.
- SDR can claim graveyard deals: call FIRST, then email with personalized sequence.
- To take over: change contact/SDR owner, close current deal (Demo Incomplete), create new deal when meeting is booked.
- See references/deal-graveyard.md for detailed process, or fetch from Confluence.

## Emma-Specific Adaptations

- **No Aircall** — use Twilio + ElevenLabs for calls/texts via `voice_call` tool.
- **No HubSpot sequences** — craft ad-hoc personalized follow-up emails via `gws` CLI (Jackson confirmed 2026-04-09).
- **HubSpot API via Composio** — use `COMPOSIO_MULTI_EXECUTE_TOOL` with HubSpot tools for all CRM operations instead of manual UI clicks.
- **Meeting booking links** — TBD, ask managers during onboarding.

## Tools Used

- **CRM:** HubSpot (via Composio — ~233 tools available)
- **Email:** Gmail (via `gws` CLI)
- **Voice:** Twilio + ElevenLabs (via `voice_call` tool)
- **Canonical procedures:** Confluence (via Composio) — fetch page 2314928144 for detailed steps
