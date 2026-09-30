# Database contract and setup

The package uses nine tables and one transactional entry point:
`inquiry_to_quote.api(jsonb)`. n8n calls it through a parameterized Postgres
query. A small helper, `inquiry_to_quote.price_scope(jsonb)`, picks out the three
price details; it is used inside the API and granted to nobody. Installing workflows does not install this schema. Hosted Supabase
connectivity is **LIVE_VERIFIED** for the paths exercised in the
29 September 2026 live test: session pooler, restricted `itq_workflow` login, and SSL
with certificate verification.

## Install in a dedicated database

Use a new Supabase project for this demonstration. Review and run
`db/001_schema.sql` as its database owner. The script creates the dedicated schema,
tables, indexes, function, and `DEMO-PHP-1` rate card inside a transaction.
Do not treat `CREATE TABLE IF NOT EXISTS` as an upgrade migration: existing tables
are not automatically altered. Back up an existing installation before changing it.

Keep this schema out of the exposed Data API schemas. The application uses a
PostgreSQL login, not an anonymous key or service-role API key. Row-level security
is enabled on every table, with no application policies. The function is
`SECURITY DEFINER`, has a fixed search path, and must remain owned by the trusted
schema/table owner. Do not grant its ownership to the runtime login.

## Create a restricted runtime login

After installing the schema, run the following as the database administrator.
These examples are for a new role; do not overwrite an existing role blindly.

```sql
CREATE ROLE itq_workflow LOGIN NOINHERIT NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT CONNECT ON DATABASE postgres TO itq_workflow;
GRANT USAGE ON SCHEMA inquiry_to_quote TO itq_workflow;
GRANT EXECUTE ON FUNCTION inquiry_to_quote.api(jsonb) TO itq_workflow;
ALTER ROLE itq_workflow SET statement_timeout = '60s';
```

Assign a strong unique password privately using your database administrator tool
(for example, `\password itq_workflow` in an interactive psql session). Store that
password only in the private n8n Postgres credential. Do not save it in this package.
Supabase documents role creation and grants in its
[Postgres roles guide](https://supabase.com/docs/guides/database/postgres/roles).

The login receives no table or sequence grants and no membership in an owner role.
All product actions, including staff actions, are reachable through the function;
the database login is therefore a trusted backend credential. Portal Basic Auth,
strict form parsing, revision checks, and one-use tokens protect the staff route.
This is a single-reviewer design, not database-level separation of individual staff.

Check effective privileges after setup, including any pre-existing global default
grants. The portable installer revokes PUBLIC access in its schema but cannot
prove the permissions of a hosted project it has not inspected.

```sql
SELECT has_schema_privilege('itq_workflow','inquiry_to_quote','USAGE'); -- true
SELECT has_function_privilege('itq_workflow','inquiry_to_quote.api(jsonb)','EXECUTE'); -- true
SELECT has_table_privilege('itq_workflow','inquiry_to_quote.messages','SELECT'); -- false
SELECT has_table_privilege('itq_workflow','inquiry_to_quote.drafts','UPDATE'); -- false
```

Connect using the restricted credential and call:

```sql
SELECT inquiry_to_quote.api('{"action":"review"}'::jsonb);
```

Expect `ok: true` and an empty initial queue. A direct `SELECT * FROM
inquiry_to_quote.messages` must fail with permission denied. The local test suite
checks this function-access/table-denial boundary under a restricted role.

## Connection settings

Use the project's actual Connect information. A persistent n8n host can use a
direct connection when reachable; an IPv4-only host can use the session pooler.
For a custom role, the direct username is `itq_workflow`; the shared-pooler username
is `itq_workflow.<project-ref>`. Copy the host rather than constructing it.
See Supabase's [connection guide](https://supabase.com/docs/guides/database/connecting-to-postgres).

Bind that credential to every Postgres node. Use the provider's SSL requirements
and certificate verification. The local verifier's loopback/no-SSL fixture settings
are not deployment settings. Validate hosted connectivity and permissions before
enabling the private workflows.

## Stored records

| Table | Purpose |
|---|---|
| `rate_cards` | Versioned demonstration rates; one active card |
| `inquiries` | Gmail thread, original sender, requirements, revision and status |
| `messages` | Gmail message identity, source text, analysis lease, evidence and attempts |
| `quotes` | Immutable scope/rate snapshot, calculated amounts and validity to the end of the seventh Manila day |
| `drafts` | Exact recipient/body, approval expiry, send claim and provider evidence; kinds `quote`, `clarification`, `question` and `follow_up` (with `follow_up_number`) |
| `jobs` | One staff-confirmed operations handoff per inquiry and quote |
| `events` | Audit and exception records |
| `review_sessions` | One-use staff form tokens with thirty-minute expiry |
| `notifications` | Staff digest attempts and their recorded outcomes |

Amounts are integer centavos. The sample visit price is the greater of
`area_sqm × 1200` and `150000`; weekly price multiplies that by visits per week.
The sample is explicitly nonbinding. Replace pricing and commercial wording only
after reviewing the business policy; enabling mail does not make sample rates real.

## Actions and state transitions

| Actions | Contract |
|---|---|
| `ingest` | Serialize by thread, deduplicate message ID, quarantine sender mismatch, invalidate pending approvals |
| `analyze`, `fail_analysis` | Require the current analysis lease; save validated facts or visible failure. Only a price-detail change supersedes a sent quote. `start_date_words` keeps the customer's words when code interpreted the date or could not work one out |
| `retry_analysis`, `claim_analysis` | Staff requests retry, scheduler claims it; maximum three attempts |
| `revise` | Staff corrects requirements, creates a revision and invalidates previous approvals |
| `prepare` | Price details produce a quote (hours and start date may be "to confirm"); a missing price detail, or a start date today or earlier, produces a clarification. A still-valid sent quote with the same price details is reissued at the same price, rate card and expiry. Also drafts due follow-ups for quiet sent quotes. Takes `business_name` and `follow_up_after_minutes` from the build configuration |
| `review`, `decide` | Render queue and approve/reject one exact draft using its token and expiry |
| `claim_send`, `mark_sent`, `send_uncertain` | Atomically claim one approved draft; record provider ID or uncertain delivery. A newly sent quote retires the older sent quote; a sent follow-up never changes its quote |
| `reconcile` | Staff checks Sent, records evidence, and confirms outcome; a retry needs fresh approval |
| `confirm_acceptance`, `close_lost` | Staff confirms customer intent; acceptance requires a valid sent quote with unchanged price details. The brief carries the latest schedule details and lists what is still to agree |
| `maintenance`, `report_error` | Surface expired leases, approvals, overdue work and sanitized workflow errors |
| `claim_notifications`, `notification_result` | At-most-once staff digest attempt; failures stay in the portal |

Manual recovery applies only to failed analysis, with an explicit checkbox and a
complete replacement of reviewed requirements. It cannot bypass active analysis,
queued retries, sender quarantine, or uncertain delivery. An ambiguous change is
held for staff review instead of reusing old scope to quote silently.

New inbound messages block dispatch while analysis is pending. Approval expires
after twenty-four hours; quotes at the end of their seventh Manila day. Follow-ups
are only drafted while the inquiry is quoted, its latest sent quote is valid, the
revision is unchanged since that quote (no customer email or staff correction), and
no earlier follow-up for the quote ended without being sent. A send left in progress for
fifteen minutes becomes uncertain. There is no automatic resend of uncertain work.
Acceptance produces one job with `schedule_status: UNCONFIRMED`.

Each API call is one SQL statement/transaction. Expected guard failures return
`{ok:false,error:...}` and roll back changes in the function's exception block.
Unexpected database faults propagate to n8n. n8n and Gmail do not share a
transaction: provider success followed by a failed database write requires human
reconciliation, not a claim of exactly-once external delivery.

## Operations and retention

Treat messages, drafts, evidence and n8n execution records as private customer data.
Define retention and backup/restore policy before a real pilot. This version does
not automatically purge customer history. Back up the whole schema consistently;
do not restore individual tables independently across revisions. Use
[Operations](OPERATIONS.md) for routine recovery. Local PGlite checks demonstrate
the SQL behavior tested, not hosted availability, concurrent production load,
provider authentication or backup restoration.
