# Demonstration

## Present the evidence boundary first

Say: "This is a portable n8n inquiry-to-quote project using synthetic cleaning requests.
The local demonstration exercises the code and database rules. Gmail, Claude, and
hosted Supabase connections will be tested after the accounts are connected."

Keep canonical exports inactive. Do not start a paid model request or send a message
while giving an offline walkthrough.

## Reproduce the local demonstration

From the product directory with Node.js 22.22 or later:

```powershell
npm ci
npm run build
npm test
npm run demo
```

Inspect the actual generated output and [the test report](../evidence/TEST_REPORT.md).
Do not present prerecorded or generated artifacts as a live Gmail run. The demo uses
synthetic provider responses to exercise deterministic behavior; it does not measure
Claude's real-world extraction quality.

Open [the saved review board](../evidence/demo-review.html) in a browser and inspect
[the saved handoff board](../evidence/demo-handoff.html) and
[the machine-readable results](../evidence/demo-result.json). These are generated
offline artifacts. A form shown in a saved page is an interface example, not a
connection to a live approval endpoint. The live portal is served by workflow 03
after its accounts, URL, and authentication have been configured.

For the sample 200-square-metre office visited three times each week, the seeded
rate card produces PHP 2,400.00 per visit and PHP 7,200.00 weekly. The arithmetic is
`max(200 × PHP 12.00, PHP 1,500.00) × 3`. These are demonstration prices, and the
job's schedule remains `UNCONFIRMED` after acceptance.

The demo also includes a quick quote: "120 sqm in Quezon City, twice a week, start
next Monday" gets PHP 1,500.00 per visit (the minimum) with hours "to confirm" and the
start date shown with "you said "next Monday"". After that quote is sent and two
quiet days pass, the handoff board shows "Follow-up 1 of 2 on the sent quote"
waiting for approval.

## Two-minute walkthrough

| Time | Show | Talking cue |
|---|---|---|
| 0:00–0:20 | The original synthetic inquiry | "The customer describes the job informally. We need complete requirements before giving a price." |
| 0:20–0:40 | Extracted fields and supporting source text | "Claude interprets the message. Missing information stays missing." |
| 0:40–1:00 | The quote's scope, rate card, and calculated amount | "The price comes from fixed rules. The model cannot negotiate or invent a rate. Code, not the model, works out dates like next Monday." |
| 1:00–1:20 | The staff approval view | "A person approves this exact recipient and message. Changed requirements invalidate the approval." |
| 1:20–1:40 | A follow-up draft, a revision, or a delivery-uncertainty case | "Quiet quotes get an approved nudge. The interesting part is what happens when the normal path breaks." |
| 1:40–2:00 | The operations brief and audit history | "Acceptance is confirmed by staff before the job record is created. Scheduling remains a separate business step." |

Choose evidence that the current test report actually records. If the local demo does
not exercise a case, show its test evidence and label it accordingly.

## Useful review questions

- Which requirements came from the customer, and where is their supporting text?
- Which details must be known before a quote, and which can follow it?
- How is "next Monday" turned into a date, and what happens with "ASAP"?
- What happens if the customer changes the request after approval?
- What happens if the same Gmail message or approval is received twice?
- How is a send timeout different from a confirmed failed send?
- Who confirms customer acceptance, and what does the operations brief still leave open?

## What can be claimed

Use the exact evidence level for the artifact being shown:

- **Offline verified:** code and PostgreSQL rules exercised with synthetic data, as
  recorded in the test report.
- **Import verified:** n8n accepted and round-tripped the exported workflow structure,
  if recorded in the test report.
- **Live verified:** the 8 runbook scenarios run on 29 September 2026 on real Gmail,
  Claude Haiku 4.5 and hosted Supabase, as recorded in the test report. This applies
  to the connected workflows, not to these saved synthetic pages.
- **Not live tested:** clarification drafts, staff notification emails,
  uncertain-send reconciliation, error-workflow dispatch, quote and approval expiry,
  and staff detail corrections.

Do not infer business time savings, revenue, customer satisfaction, production scale,
or model accuracy from this demonstration. The [case study](CASE_STUDY.md) lists how a
future pilot could measure those outcomes.
