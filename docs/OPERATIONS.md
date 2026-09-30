# Operations

The staff reviewer owns the next action on each inquiry. n8n coordinates the work;
Claude extracts and drafts; neither can commit a customer to a price or create a
confirmed booking without the required decision.

## Review routine

Open the authenticated staff portal and check pending drafts, customer responses,
delivery uncertainty, and exceptions. Review the newest source email and the current
record before acting. An older notification or browser tab can refer to a superseded
revision; refresh when a decision is rejected as stale.

The production board is at `<publicBaseUrl>/webhook/itq-review`. Use the reviewer
Basic Auth login configured in n8n. The read-only GET page does not approve anything;
each decision submits a POST form. The portal is for one shared staff reviewer in
this version, not separate employee accounts or role-based assignment.

The board shows the latest inbound text and extraction evidence alongside the
requirements. Still inspect the Gmail thread when earlier context matters. The
review-session token expires after thirty minutes and is consumed by a successful
correction, retry, reconciliation, acceptance, or rejection action. Draft approvals
use a separate one-use token and a twenty-four-hour expiry. Refresh the board after
a decision or when returning to an old tab.

A quote needs the three **price details**. The two **schedule details** are asked for
alongside the quote instead of holding it back:

| Detail | Kind | Version-one rule |
|---|---|---|
| Location | Price | Customer-stated text; service coverage still needs staff review |
| Floor area | Price | More than zero and at most 10,000 square metres; up to two decimal places |
| Frequency | Price | One to seven visits per week, as a whole number |
| Preferred hours | Schedule | Customer-stated text; shown as "to confirm" when missing; does not establish crew availability |
| Requested start date | Schedule | Shown as "to confirm" when missing; a date today or earlier holds the quote back and asks for a new date |

Claude copies the customer's own words for the start date; code, not Claude, turns
them into a date, counting from the Manila day the email arrived. "today",
"tomorrow", weekday names (including "next Monday", which means the coming Monday)
and a day with a month but no year ("Oct 23", the next time that date comes round)
are interpreted. The quote repeats the customer's words, for example "Monday,
5 October 2026 (you said "next Monday")", and the portal marks the date
**interpreted**. Vague words such as "ASAP", "next month", "early October", "03/04",
ranges and "next week Monday" stay unresolved: the quote says "to confirm (you said
...)" and asks for the exact date. Saving a date in the correction form makes it a
confirmed date. Email text over 20,000 characters and attachments need manual
handling.

### Clarification

Check the extracted fields against the actual email. Missing details must stay
missing. Review the clarification draft, recipient, and thread before approving it.
If the message contains conflicting information or an unsupported request, resolve
that with the customer instead of inventing a value to make the record complete.

### Quote

Check the scope, quantity, frequency, rate-card version, amount, recipient, and exact
outgoing text. Approval is tied to that version.

Only a change to a price detail (location, floor area or visits per week) cancels a
sent quote and produces a newly calculated one. When the customer sends only hours
or a start date after a quote, the next draft is an **updated quote at the same
price**: it keeps the sent quote's amounts, rate card and expiry, says "The price has
not changed", and still needs your approval. Sending it retires the older quote.

Select **Reject draft** when the proposed scope is wrong. Expand **Correct the details
or the opening sentence** and submit the complete current requirement set, leaving unknown
fields blank. Select **Save correction and require fresh review**.
Corrections create a new revision, invalidate previous approvals, and let the next
preparation tick produce a fresh draft. A requested start date is not an availability
commitment. Confirm crew capacity through your normal operating process before
promising a service date.

The **Opening sentence for the next email** field replaces the one or two sentences
after "Thanks for your message." The greeting, missing-detail questions, prices and
the sign-off with the business name are added automatically. It does not change the
stored calculation or fixed financial terms. Check that the sentence does not
contradict those terms before approving the complete message. Active analysis
and an in-progress or uncertain send block corrections. Failed analysis can be
resolved explicitly with the manual procedure below.

### Customer reply

Treat the model's classification as a routing aid. Inspect questions, requested changes,
rejection, and possible acceptance in the original message. Ambiguous replies remain
staff work. A message such as "looks good, but can you lower the price?" does not give
the workflow authority to accept a different price or create a job. An acceptance
that also brings hours or a start date ("Yes, start next Monday") goes straight to
acceptance review; an acceptance that changes a price detail goes to a staff look.

### Acceptance and operations handoff

Confirm acceptance only when the customer has accepted the current sent offer and you
have reviewed the scope. Select **Confirm acceptance and create job** and acknowledge
the confirmation checkbox. The workflow creates a single job record with an operations
brief. Its schedule remains **UNCONFIRMED**. Review outstanding requirements and
arrange availability and scheduling separately.

The brief is a record of the agreed scope. It does not charge a customer, issue an
invoice, assign a crew, or confirm availability.

## Failure handling

| Situation | Operator response |
|---|---|
| Claude request fails or returns unusable content | Inspect the failure; fix the cause before requesting a retry, or review the source emails and use explicit manual recovery |
| Required details remain incomplete | Approve a clarification request and wait for a customer reply |
| Customer changes a price detail | Review the revised fields and a newly calculated quote; the previous approval is no longer sufficient |
| Customer adds hours or a start date | Review the updated same-price quote before it goes out |
| Browser decision is stale or expired | Refresh the portal and review the current version |
| Draft approval expired | Use the staff correction form to refresh the current requirements and prepare a new version for review |
| Gmail delivery result is uncertain | Reconcile against Gmail before requesting another send |
| Database or workflow execution fails | Inspect the n8n execution and database state; rerun only after identifying the saved state |
| A follow-up is overdue | Review the thread and decide the next customer action |
| The same event appears again | Confirm it maps to the existing record; do not create a replacement inquiry to bypass duplicate protection |

### Delivery reconciliation

A timeout can occur after Gmail has accepted a message. Check Sent mail and the relevant
thread for the exact recipient, subject, text, and time before deciding whether it was
sent. Preserve the provider message identifier when confirming delivery. If the message
cannot be established as sent or unsent, leave it uncertain and investigate.

Do not manually restart a Gmail send node just because a previous execution looks red.
Use the **I verified it was sent** or **I verified it was not sent** portal action,
with the required acknowledgment, so the database history and delivery state
match the decision. A fresh retry must be deliberate and apply to the current approved
content. **I verified it was not sent** returns a still-current draft to pending review
with a fresh approval requirement; it does not immediately resend it. If a newer
revision superseded the draft, it remains stale instead.

### Analysis retries

Analysis failures are recorded separately from completed extraction. After resolving
the cause, select **Queue analysis retry**. A two-minute schedule claims explicitly
requested retries; it does not silently retry every failed Claude call. The original
Gmail identity is preserved. A retry may consume another Claude request; check the
error and spending limit when resolving repeated provider failures.

The initial attempt plus requested retries are capped at three analysis attempts per
message. After the cap, no further model retry is available. Do not erase the saved
record to force a fresh paid attempt.

### Manual recovery from failed analysis

Open **Correct the details or the opening sentence**, inspect the source emails, and enter
the complete current requirements. Leave unconfirmed details blank. When a failed
analysis exists, select **I checked the source emails and am replacing failed AI
extraction with the requirements above**, then save the correction.

This records a staff recovery, resolves failed analysis for that inquiry, and creates
a fresh revision for draft preparation and approval. It works after the three-attempt
cap and makes no model call. It does not approve an email, waive missing requirements,
or bypass an active/queued analysis or uncertain delivery. Quarantined sender changes
remain separate; do not treat their content as verified customer requirements.

Normalization rejects unsupported text, oversized bodies, automated/list messages,
and a `Reply-To` address that differs from the original sender. Those failures need
manual handling in Gmail and inspection in n8n, rather than repeatedly queuing model
analysis. Replies are sent to the sender only; customer CC recipients are not included.

## Notifications and follow-up

Maintenance detects work that needs attention. Optional staff digests go only to the
configured staff recipient and are disabled by default. They do not replace checking
the portal or n8n execution errors, and a notification is not evidence that the
underlying action completed.

Each staff digest has at most one delivery attempt. If that attempt is uncertain,
inspect Gmail and the portal; it will not automatically send the same digest again.

When a customer goes quiet after a quote, preparation drafts **follow-up 1** on day 2
and a **last reminder** on day 5 after the quote was sent (`followUpAfterMinutes`).
They use a fixed template with the sent price and expiry, make no Claude call, and
appear in the portal as "Follow-up 1 of 2 on the sent quote" with the usual approve
and reject buttons. Nothing is sent without approval. Follow-ups stop when the
customer replies or staff correct the record, when the quote expires, or when a
follow-up is rejected, expires unapproved after twenty-four hours, or is replaced.
Rejecting a follow-up leaves the quote itself standing. Sending a follow-up never
changes the quote.

The board presents up to 200 recent inquiries, drafts, and jobs. This is a small-volume
staff workspace; older records remain in the database but the page does not provide
search or pagination. Check the database with an authorized operator when an older
record is needed.

Default schedule timing is one minute for inbox, preparation, and enabled customer
delivery; two minutes for requested analysis retries; and fifteen minutes for
maintenance. Approval queues work; the success page alone is not proof of email
delivery. `enableCustomerSending: false` leaves approved work unsent until the private
configured copy is deliberately enabled for delivery.

Approval expires after twenty-four hours; a prepared quote is valid until the end of
its seventh Manila calendar day, which is the date the email shows.
Analysis and send claims expire after fifteen minutes and are surfaced by maintenance.
The default next-action deadline is one day during intake/preparation and two days
after a confirmed send. Overdue alerts are recorded no more than once daily per open
inquiry; they do not move the deadline or contact the customer.

## Operating changes

- Add a new rate-card version instead of altering the price history of sent quotes.
- Change templates or prompts in a private working copy, rebuild, and run the free
  verification suite before replacing canonical exports.
- Keep the dedicated schema and credentials separate from other products.
- Preserve audit records and customer correspondence according to the business's
  retention policy. Do not include them in portfolio evidence.
- Stop affected schedules while diagnosing a repeated failure, and check pending
  claims and approvals before resuming.

See [DATABASE.md](DATABASE.md) for exact supported actions and state transitions, and
[SETUP.md](SETUP.md) for account configuration. See the test report before claiming any
failure path has been verified live.
