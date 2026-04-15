---
name: sdr-cold-email
description: Runs cold email outbound prospecting sequences for CoPilot AI SDRs. Covers a 7-email sequence over 11 days, reply handling, and demo booking. Use when asked to write a cold email, build a prospecting sequence, follow up with a prospect, handle a prospect reply, book a demo, or run email outbound. Also use when a prospect replies to an outbound email and needs immediate follow-up. Triggers on phrases like "cold email", "prospecting email", "outbound email", "follow up email", "prospect replied", "book a demo", "email sequence", "breakup email", "outbound sequence".
---

# SDR Cold Email Prospecting

Run cold email outbound sequences as a CoPilot AI SDR: research > personalize > email sequence > handle replies > book demos.

## Before Writing

1. Research the prospect:
   - Check HubSpot for existing contact record, prior activity, associated deals.
   - Check Explorium for firmographics, tech stack, funding, headcount signals.
2. Identify a trigger event: growth signal, new hire posting, funding round, tech adoption, or industry shift.
3. Determine the angle: connect the trigger to a pain CoPilot AI solves.

## Sequence Execution

Run a 7-email sequence over 11 days. See `references/sequence-templates.md` for full structure, templates, and best practices.

Adjust cadence to the prospect's engagement:
- Low engagement? Increase time between emails.
- Watch open rates. If late-stage emails aren't being opened, remove that touch.

Send emails using the `gws-gmail-send` skill.

## Non-Negotiable Email Rules

Full rules, examples, and banned patterns in `references/sequence-templates.md`. These guardrails apply to every email:

- Subject lines: 1-3 lowercase words only. No cliches, no salesy language.
- Under 100 words per email (breakup under 80). One CTA per email.
- NEVER use em dashes or en dashes. Restructure sentences instead.
- Lead with their pain, not your pitch. First two sentences must not be about CoPilot AI.
- No empty flattery, buzzword stacking, or soft-close filler.
- Do NOT follow Compliment > Problem > Solution > CTA > Soft Close. Break the AI pattern.
- Read it aloud. If it sounds like a LinkedIn post or ChatGPT output, rewrite.
- Max 1-2 reply emails per thread, then start a new thread with a new subject.
- Every email must ADD VALUE. No empty follow-ups.

## Reply Handling

When a prospect replies, the sequence stops immediately. See `references/reply-handling.md` for the full playbook.

Key rules:
- **Any positive/open-ended reply:** Reply immediately. Single goal is booking a call. Do NOT ask discovery questions or send async content.
- **Send the booking link.** Current: https://calendly.com/jchao-2/30-minutes (temporary, Jackson Chao). Permanent link TBD from manager onboarding.
- **After booking:** Immediately notify your manager in Slack with prospect details, trigger, and demo info. Then send AE prep brief (who, trigger, role, company context, intel).
- **Log everything** in HubSpot.

## Pattern Interruption

When standard emails aren't getting engagement, embed these in later touches:
- Short video (Loom or similar, under 1 min)
- Photos / screenshots showing relevant data
- Memes (industry-relevant, light humor)

## CoPilot AI Value Props (For Email Content)

Use these angles, adapted to the prospect's specific situation:
- Turn outbound into inbound pipeline
- AI targets top 10-20% of LinkedIn profiles most likely to convert
- Personalized sequences launched on autopilot
- Unified inbox across all accounts
- No extra hours added to reps' day
- Trusted by financial advisors, B2B sales teams, agencies, business services
