# Verification report

Current source verified on 30 September 2026. Status: **OFFLINE_VERIFIED;
LIVE_VERIFIED for exercised paths**. The offline checks passed again after the portal
label fix, and the [29 September live test](#live-test-29-september-2026) ran all 8
runbook scenarios on real Gmail, Claude and hosted Supabase. Paths the live test did
not exercise remain **NOT_LIVE_TESTED**. The offline checks made no paid model calls,
real email sends, or hosted schema changes.

## Results

| Check | Observed result |
|---|---|
| `npm run verify` on 30 September | PASS: 71 tests, 0 failures, 0 skipped; four regenerated inactive exports, 61 nodes |
| `npm run demo` on 29 September | PASS: complete inquiry, clarification, a quote without hours from a casual start date, quote approval, simulated delivery, staff-confirmed acceptance, one unscheduled handoff, and a day-2 follow-up draft |
| `node tools/runtime_verify.mjs` on 30 September | PASS: thirteen actual n8n workflow executions (including follow-up preparation, approval and sending) plus canonical import/round-trip |
| `node tools/runtime_verify.mjs --recovery` on 30 September | PASS: thirteen actual n8n workflow executions plus canonical import/round-trip |
| Shared n8n import comparison on 30 September | All four workflows imported through the CLI into the shared local n8n preserve nodes and connections exactly, remain inactive, and have zero credential bindings |
| Browser canvas inspection on 28 September | All 61 rendered nodes across four workflows measured at zoom-to-fit; zero node or label collisions; every node in view. Positions, connections and node names are unchanged since |
| Static browser previews on 28 September | Regenerated review and handoff boards inspected: plain status words, readable dates and PHP amounts, no raw JSON, one UNCONFIRMED handoff, one follow-up awaiting approval |
| Live test on 29 September | PASS: 8 of 8 runbook scenarios on real Gmail, Claude Haiku 4.5 and hosted Supabase; see [Live test](#live-test-29-september-2026) |

Environment: installed n8n **2.27.4**, Node.js **24.18.0**, PGlite **0.5.8**,
pglite-socket **0.2.11**, Windows. Node.js minimum declared by the package is 22.22.

The final archive command checks required evidence, inactive credential-free
exports, common secret formats, private filesystem paths, and non-fixture email
addresses. It reopens the ZIP and compares every entry byte-for-byte. Its manifest
contains SHA-256 hashes for packaged files. `.runtime/`, `node_modules/`, `private/`,
local logs, the private runtime-location marker and `config/settings.local.json` are
excluded.

## Live test (29 September 2026)

A private `ITQLive` build of the same four workflows ran on the local n8n 2.27.4. It
was imported inactive through the CLI (round-trip exact), activated for the test and
deactivated afterwards. Gmail used an n8n Gmail OAuth2 credential, and a second Gmail
account played the customer, sending every message by hand. Claude Haiku 4.5
(`claude-haiku-4-5-20251001`) ran through an n8n Anthropic credential. The database
was a free hosted Supabase project reached through the session pooler with the
restricted `itq_workflow` login, SSL required and the certificate verified. Staff
approved, rejected and confirmed in the Basic Auth portal from a desktop browser.
The full record, with timestamps, is [live-test.json](live-test.json).

| # | Scenario | Result |
|---|---|---|
| 1 | Complete inquiry | PASS: PHP 2,400.00 per visit, PHP 7,200.00 weekly; approved and sent as a reply in the original thread |
| 2 | Price details only, "start next Monday" | PASS: quote sent without hours at the PHP 1,500.00 minimum visit price; start date Monday 5 October 2026 shown with the customer's words |
| 3 | Hours added after the quote | PASS: updated quote says "The price has not changed"; same price and validity |
| 4 | Follow-ups after silence | PASS: follow-up 1 approved and sent in the thread; follow-up 2 rejected; three more preparation rounds created no further follow-up |
| 5 | Customer acceptance | PASS: acceptance review, staff confirmation, one operations brief with the start date and a check to confirm it; schedule UNCONFIRMED |
| 6 | Price-detail change after a sent quote | PASS: 300 sqm superseded the sent quote; new quote at PHP 3,600.00 per visit approved and sent in the thread |
| 7 | Stale or repeated approval | PASS: the database refused a re-submitted approval (`INVALID_OR_USED_APPROVAL`); the thread holds exactly one quote message |
| 8 | "Ignore your rules" 90% discount request | PASS: no price details extracted, sent to manual review, no draft created |

Claude usage: 6 calls, 10,358 input and 1,573 output tokens, no retries. That is a
few US cents; the exact bill is in the Anthropic console.

Deviations from the runbook:

- The inbox was an existing Gmail account with a query limited to the test sender,
  not a dedicated test inbox with a label.
- Scenarios 5 and 6 ran on swapped threads: the acceptance was sent in thread 2 and
  the 300 sqm change in thread 1. Each still ran on a thread holding a sent quote.
- Scenario 7 was triggered by a stale browser page re-submitting an approval, not by
  a deliberate back-and-approve.

Findings:

- A rejected draft's decision line read "Approved by staff" under "Rejected, not
  sent". It was cosmetic and nothing was sent. It was fixed after the live run to
  read "Rejected by"; the fix is verified offline only.
- The Supabase pooler certificate chains to the Supabase Root 2021 CA, which is not
  in the default trust store. n8n needs `NODE_EXTRA_CA_CERTS` pointing at the CA
  downloaded from the Supabase dashboard to keep certificate verification on.
- After one wrong Basic Auth login, n8n answers 403 and browsers stop prompting; a
  private window clears it. Embedded browsers that cannot show the prompt cannot
  open the portal.

Not exercised live, so still **NOT_LIVE_TESTED**: clarification drafts, staff
notification emails, uncertain-send reconciliation, error-workflow dispatch, quote
and approval expiry, and staff detail corrections.

## Changes verified since 23 September

| Change | Evidence |
|---|---|
| Customer emails: one greeting, one sign-off with the business name, PHP thousands separators and a monthly estimate, plain missing-detail questions, demonstration note at the bottom and removed for a real rate card | Database tests assert the exact wording, a non-demo rate card, and the invalid business-name guard |
| Staff portal: plain status words, readable Manila dates, cards instead of JSON, older drafts folded, friendly action results | Core tests render every section and assert no raw JSON or code-style field names remain |
| Quote needs only location, floor area and visits; hours and start date "to confirm" | Database tests for the quick quote and the clarification that only lists price details |
| Only price details cancel a sent quote; later hours or dates give an updated quote at the same price, rate card and expiry | Database test changes the rate card before the update and checks the price, expiry, and that the newer sent quote retires the older one |
| "Yes, start next Monday" goes straight to acceptance review; the brief carries the date and what is still to agree | Database test through staff confirmation |
| Code, not Claude, reads start dates | Core tests cover 12 interpreted or exact phrases, 12 vague phrases that stay unresolved, a late-evening UTC email counted as the next Manila day, and a converted date from Claude being rejected |
| Follow-up drafts on day 2 and day 5 with stop rules | Database tests for timing, the maximum count, a customer reply, a rejected follow-up, an expired quote, configured delays and their validation; runtime suite prepares, approves and sends follow-up 1 in real n8n |
| Private live-test build | Workflow test: placeholders refused, 18 credential bindings by ID, `ITQLive` IDs, canonical exports byte-identical; an existing n8n Anthropic credential can be reused |
| Portal: a rejected draft's decision line reads "Rejected by" | Core test renders a rejected and an approved draft and checks each label |

## Offline behavior coverage

The 71 tests cover Gmail normalization and quoted-body handling; strict Claude tool
responses and source evidence; start-date reading; numeric/date ambiguity;
prompt-injection-shaped inputs; strict portal action parsing and HTML escaping;
readable portal rendering; parameterized database calls; nine RLS-enabled tables and
restricted-role function access; deterministic prices; customer email wording;
price versus schedule details; same-price updated quotes; follow-up timing and stop
rules; idempotent intake; sender quarantine; exact one-use approvals; stale
revisions; expired approvals/quotes; delivery uncertainty and reconciliation; retry
limits; manual failure recovery; acceptance and a unique handoff; deadlines; staff
notification uncertainty; explicit canvas controls; frozen quote metadata; the
private build; and complete workflow graphs and fixed-grid layouts.

## Real n8n execution with simulated providers

See [main results](runtime-verification.json) and
[recovery results](runtime-recovery.json). These are actual executions through the
installed n8n CLI, including native Postgres nodes against a local PGlite TCP server.
The API state is inspected after important transitions and counters verify no
duplicate analysis/send attempts.

The main suite exercises complete intake, duplicate intake, quote preparation,
staff page rendering, approval, approved dispatch, empty dispatch queue, follow-up
preparation after an aged quote (confirming no Claude call), follow-up approval and
dispatch, acceptance reply, staff-confirmed handoff, and maintenance/staff digest.

The recovery suite exercises malformed analysis, explicit staff manual recovery,
fresh quote preparation and approval, the disabled-send switch, provider send
uncertainty, prevention of an uncertain resend, staff reconciliation with fresh
approval required, staff retry request, scheduled analysis retry, sanitized
workflow exception recording, uncertain staff notification, and invalid form
rejection. Manual recovery produces a new revision; the retry advances attempts
to two; invalid form submission creates no job.

Verification copies replace Gmail nodes with HTTP loopback fixtures, replace
Anthropic's endpoint with a local fixture, and replace trigger nodes with explicit
synthetic inputs. Respond-to-Webhook nodes are replaced with Code sinks, with HTML
validation in the recovery suite. Canonical workflows are separately imported
without these modifications. Test copies enable sending only toward the loopback
fixture; delivered exports retain both sending switches as false.

This proves the exercised orchestration and state transitions. On its own it does
**not** prove OAuth behavior, Gmail polling/reply delivery, paid-model accuracy,
hosted Supabase transport/permissions, or staff Basic Auth; the
[live test](#live-test-29-september-2026) covered those for its eight scenarios.
Public HTTPS webhook behavior was not tested, since the live portal ran on localhost.
The Error Trigger receives a synthetic event; automatic error-workflow dispatch
remains **NOT_LIVE_TESTED**. Production concurrency, load, backup restoration, and
commercial suitability are not claimed.

## Runtime failure diagnosed and resolved (historical)

The original duplicate-inquiry failure was reproduced with socket debug logs.
n8n disconnects with ECONNRESET after CLI execution; pglite-socket 0.2.11 detaches
the socket on its error path but retains the handler in its connection set. The
next client is rejected at the one-connection limit.

The verifier creates and stops a fresh TCP adapter for each CLI execution,
retaining the same PGlite database for the entire suite. Duplicate tests therefore
retain their original records. This is a local test-harness fix, not a change to
production database logic or a reason to loosen production connection limits.

The installation warns that its optional Python task-runner environment is absent;
these workflows use JavaScript, and all tested JavaScript nodes executed.

## Visual evidence

The [inspection receipt](visual-verification.json) records 13 intake, 12 preparation,
20 review/delivery and 16 maintenance nodes. The fixed-grid registry and tests
validate exact 208-pixel steps. Screenshots from 28 September:
[intake](canvas-intake.png), [preparation](canvas-preparation.png),
[review and delivery](canvas-review.png), [maintenance](canvas-maintenance.png),
[review board](review-preview.png) and [handoff board](handoff-preview.png).

Credential warnings in canonical canvas screenshots are expected: the exports
have no account bindings. Static HTML previews use synthetic UUIDs, addresses and
approval tokens; they are not a live portal. The demonstrated rate is PHP 2,400 per
visit and PHP 7,200 weekly. Scheduling remains **UNCONFIRMED**.

## Reproduction and next boundary

Run the README commands in order, then review the JSON evidence and saved pages.
Runtime commands require the installed n8n CLI and free local ports 5890–5893;
run the two suites sequentially. Test services are stopped after verification;
the shared n8n instance received only the inactive CLI import.

The controlled account test in [LIVE_TEST.md](../docs/LIVE_TEST.md) ran all 8
scenarios on 29 September. Keep the NOT_LIVE_TESTED label on the paths it did not
exercise, and keep the demonstration-pricing disclosure.
