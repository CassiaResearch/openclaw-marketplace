---
name: sdr-cold-call
description: Execute an outbound cold call workflow as an SDR at CoPilot AI. Covers the full loop from receiving a prospect list through live voice discovery, qualification, demo booking, SDR→AE handoff email, and AE prep briefing. Use when asked to make outbound calls, run a cold call campaign, do outbound prospecting calls, qualify a prospect by phone, or execute the outbound flow from the Tuesday demo scenarios. Also use when a cron or standing order triggers a daily outbound call block.
---

# SDR Cold Call Flow

Execute an end-to-end outbound cold call as a CoPilot AI SDR: call → qualify → CRM → book → handoff → prep.

## Before Calling

1. Fetch the latest qualification framework from Confluence:
   - **SDR Qualification Calls V2 2025** (space: RO, title: "Playbook: SDR Qualification Calls - V2 2025")
   - **Outbound 101** (space: RO, title: "Playbook: Outbound 101")
   - Use `COMPOSIO_MULTI_EXECUTE_TOOL` → `CONFLUENCE_SEARCH_CONTENT` or `CONFLUENCE_GET_PAGE_BY_ID` to fetch.
2. Load the prospect's context from HubSpot (contact record, any prior activity, associated deals).
3. Load enrichment data from Explorium if available (firmographics, tech stack, funding).
4. Review `reference/hubspot/lifecycle-lead-deal-stages.md` for CoPilot AI-specific stage nuances.

## Call Structure (~12 min)

See `references/cold-call-framework.md` for the 4-step call structure, objection handling, and voicemail scripts. Also follow the qualification playbook fetched from Confluence. High-level:

1. **Opening (1-3 min):** Warm greeting, icebreaker, thank for time, set agenda.
2. **Discovery (7 min):** Qualification questions, uncover BANT (Need, Timeline, Authority, Budget).
3. **About Us (1-2 min):** High-level CoPilot AI overview — Intelligence/Quality positioning. No feature specifics. No pricing unless asked ($300-$500 range).
4. **Next Steps (1-2 min):** If qualified → book AE demo. Confirm invite on call.

## Key Rules

- Stay high-level. Don't oversell features or give specific pricing unsolicited.
- Drive and control the call. Be warm, welcoming, SMILE.
- Push specifics to the AE demo: "The best way to see if it's worth it is the demo."
- This is a guide, not a script. Adapt to your style and personalize to each prospect.

## Disqualification Criteria

Fetch the full DQ list from the qualification playbook on Confluence. Quick reference:
- No clear ICP / no business
- No current need CPAI can solve
- No LinkedIn / <100 connections (still qualify if buying for team)
- Won't risk compliance (only DQ if they ASK AND decline AND firm explicitly forbids)
- 3+ no-shows
- Invalid contact info
- Cannot/will not use LinkedIn or Sales Nav
- Bad Fit: target not reachable on LinkedIn (<3K 2nd degree), deal size <$1K, international (outside US/CA/UK)

## After the Call

### If Qualified → Book Demo
1. Book demo with AE (Calendly or manual — see standing orders for current booking method).
2. Execute CRM hygiene — see `sdr-hubspot-hygiene` skill.
3. Send SDR→AE handoff email (see references/handoff-template.md).
4. Send AE prep briefing via Slack (see references/ae-prep-template.md).

### If Not Qualified → DQ
1. Set appropriate lead status and DQ reason in HubSpot.
2. Log call notes with DQ reasoning.
3. DQ/Bad Fit requires human confirmation before finalizing (standing order approval gate).

### If No Answer
1. Leave voicemail if possible.
2. Send follow-up email (ad-hoc, personalized — do NOT use HubSpot sequences).
3. Log call attempt in HubSpot.

## Escalation Rules

- Prospect raises pricing, legal, or enterprise concerns → pause and flag to AE.
- Retry fails twice → escalate to manager.

## Tools Used

- **Voice:** Twilio + ElevenLabs (via `voice_call` tool)
- **CRM:** HubSpot (via Composio)
- **Prospecting:** Explorium (via MCP)
- **Messaging:** Gmail (via `gws` CLI), Slack (native)
- **Playbooks:** Confluence (via Composio) — always fetch latest version
