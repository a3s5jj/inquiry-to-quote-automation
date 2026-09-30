# Case study: a reviewed inquiry-to-quote handoff

## The problem

A cleaning inquiry can arrive as an incomplete email. Preparing a useful response
requires extracting the request, asking for missing details, using the right price,
following up, and passing the accepted scope to operations. This project demonstrates
that process with a fictional business and synthetic customer data.

It does not claim that an actual cleaning company has deployed the system or that
email is the dominant inquiry channel across the industry.

## What was built

A portable n8n package with Gmail intake, Claude message analysis, a Supabase-backed
state machine, a staff approval portal, approved Gmail delivery, approved follow-ups
for quiet quotes, and an operations brief after staff confirms acceptance.

The inquiry channel feeds a common internal record. The main work is moving that
record through complete requirements, a calculated quote, an explicit decision, and
a traceable handoff.

## Engineering decisions

**Keep interpretation separate from authority.** Claude can extract and draft.
Versioned rate cards determine prices. Staff approves outgoing content and confirms
acceptance. A convincing model response cannot skip those gates.

**Approve a specific version.** A quote is a snapshot of scope and pricing. Revisions
invalidate stale approval so an old decision cannot send a changed offer.

**Treat delivery uncertainty as a state.** A network error can leave the sender unsure
whether a provider accepted a message. The workflow records that uncertainty instead
of automatically sending again and risking a duplicate.

**Use transactions for shared state.** Scheduled runs and repeated clicks can overlap.
Database decisions and unique constraints control record creation and claims, rather
than assuming n8n executions always happen one at a time.

**Record the handoff.** Confirmed acceptance creates an operations brief with the agreed
scope and outstanding requirements. The brief is not evidence of crew availability or
a completed booking.

**Quote on what sets the price.** Location, floor area and visits per week decide the
price, so they are all a quote needs. Hours and a start date are asked for alongside
the quote. When they arrive later, the customer gets an updated quote at the same
price instead of a cancelled one.

**Let code do the date math.** Claude copies the customer's words ("next Monday");
deterministic code turns them into a date from the day the email arrived, echoes the
words back in the quote, and leaves vague wording ("ASAP", "early October") to be
confirmed. Language models are unreliable at calendar arithmetic, and a date that is
one day off is worse than no date.

**Follow up without automating the relationship.** A quiet quote gets two
template-based follow-up drafts, on day 2 and day 5. Staff still approve each one, and
any reply, rejection or expiry ends the sequence.

## Evidence and limits

See [the test report](../evidence/TEST_REPORT.md) for the completed verification layers,
commands, and results. Offline fixtures test code and database behavior. Import checks
test whether n8n accepts the exports. Neither proves real Gmail delivery, hosted
Supabase operation, or Claude accuracy on customer emails.

The delivered exports are inactive. On 29 September 2026 a controlled live test ran
all 8 runbook scenarios on real Gmail, Claude Haiku 4.5 and hosted Supabase, and all
8 passed, so those exercised paths are **LIVE_VERIFIED**. Paths it did not exercise
remain **NOT_LIVE_TESTED**, and eight scenarios do not measure Claude accuracy across
many customer emails. See [the live test record](../evidence/live-test.json).

Review [the saved staff board](../evidence/demo-review.html),
[the offline journey result](../evidence/demo-result.json), and
[the n8n verification record](../evidence/runtime-verification.json) alongside the
report. The saved page is a generated snapshot, not a live connected demonstration.

## Honest assessment

The work it removes is real but modest: copying details out of an email, one price
calculation, typing a quote, and remembering which quotes need a nudge. A person
still approves every outgoing email and every acceptance. That is the right default
for a first deployment, but it means the portal replaces Gmail as the place staff
work rather than taking the work away. Many commercial cleaning jobs are priced
after a site visit, so a real business would likely use this for standard recurring
jobs or pair it with visit booking.

The larger gains would come from trusting it more, for example sending simple,
complete quotes without approval or replying instantly, which is a riskier product.
As built, its strongest value is as a demonstration of safe AI design: the model
never sets a price or sends a message, and every failure path has a recorded,
recoverable state.

## What to measure after connecting a pilot

| Measurement | How to collect it |
|---|---|
| Extraction quality | Compare model fields with a human-labeled sample of real inquiries |
| Price correctness | Compare stored quote calculations with independently checked expected prices |
| Staff preparation time | Time the same task manually and with the workflow, including review and corrections |
| Follow-up completion | Compare deadlines with recorded staff actions |
| Duplicate prevention | Replay the same event and verify that no extra quote, send, or job is created |
| Recovery quality | Record whether failures are detected and resolved without losing or repeating work |
| Model cost | Record provider usage and billed cost separately from estimates |

No measured improvement is claimed before those observations exist.

## Short portfolio description

> I built an n8n workflow that turns email inquiries into reviewed quotes, approved
> follow-ups and operations handoffs. Claude interprets the request; fixed pricing
> rules, code-based date reading, versioned approvals, and delivery reconciliation
> control what happens next. The portable package includes 71 automated tests,
> 26 verified n8n runs with simulated providers, and a runbook for the live account test.
