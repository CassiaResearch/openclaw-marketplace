# Explorium Filter Cheatsheet for Lookalike Lists

Common filter combinations based on CoPilot AI's ICP and AE patterns.

## Industry Categories (linkedin_category)

These are the autocomplete-verified values most relevant to CoPilot AI's customer base:

**Financial Services:** `financial services`, `investment banking`, `banking`
**Legal:** `law practice`, `legal services`
**Marketing/Advertising:** `marketing services`, `advertising services`, `market research`
**Consulting:** `business consulting and services`, `operations consulting`
**Technology:** `information technology & services`, `technology, information and internet`

## Company Size Values
- `1-10` — Solopreneurs, micro businesses
- `11-50` — Small businesses (CoPilot AI sweet spot)
- `51-200` — Growing SMBs
- `201-500` — Mid-market

## Job Title Values (autocomplete-verified)
- `owner` — Most common for small biz
- `founder` — Startups and owner-operators
- `president` — Traditional small business
- `managing partner` — Law firms, consulting
- `ceo` — Broad match
- `principal` — Financial advisors, consultants

## Buying Intent Topics (autocomplete-verified)
- `sales: sales prospecting`
- `sales: outbound sales`
- `sales: sales development`
- `sales: cold calling`
- `sales: sales leads`
- `social: linkedin outreach`
- `sales: sales automation`

## Common Filter Combinations

### "Andrew DiBiase Profile" (Generalist, Small Biz)
```json
{
  "linkedin_category": {"values": ["financial services", "law practice", "legal services", "marketing services", "advertising services", "business consulting and services"]},
  "company_size": {"values": ["1-10", "11-50"]},
  "country_code": {"values": ["us", "ca"]},
  "job_title": {"values": ["owner", "founder", "president", "managing partner", "ceo", "principal"]}
}
```
Universe: ~210K prospects

### Financial Advisors (Niche)
```json
{
  "linkedin_category": {"values": ["financial services", "investment banking"]},
  "company_size": {"values": ["1-10", "11-50"]},
  "country_code": {"values": ["us", "ca"]},
  "job_title": {"values": ["owner", "founder", "president", "managing partner", "principal"]}
}
```

### Marketing Agencies
```json
{
  "linkedin_category": {"values": ["marketing services", "advertising services"]},
  "company_size": {"values": ["1-10", "11-50"]},
  "country_code": {"values": ["us", "ca"]},
  "job_title": {"values": ["owner", "founder", "ceo", "president"]}
}
```
