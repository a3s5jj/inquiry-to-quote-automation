# Setup

Connect a private copy of the package when you are ready to run it. The delivered
exports stay inactive and do not include credentials. No live account setup was
performed as part of the portable build.

## Requirements

- An n8n instance compatible with the verified version in the test report. Development
  targets n8n 2.27.4.
- A Gmail account intended for the cleaning inquiry workflow.
- A Supabase PostgreSQL project that you administer.
- An Anthropic API key with access to the configured Claude model.
- A private staff reviewer login for the review portal.
- HTTPS for the deployed review portal and a stable n8n webhook address.

Node.js 22.22 or later is needed to rebuild and test this repository, not to replace
the n8n runtime. All examples use a new product-local database schema; this package
does not need credentials or tables from any other product.

## 1. Inspect and verify the portable package

From the product directory:

```powershell
npm ci
npm run build
npm test
npm run demo
```

Read [the test report](../evidence/TEST_REPORT.md). Those checks use synthetic data and
a local PostgreSQL-compatible engine. They make no paid Claude requests and do not
send mail.

## 2. Prepare Supabase

Follow [the database setup instructions](DATABASE.md) to apply the included SQL files
to your intended Supabase project. Review the schema and sample rate card first.
Use a new dedicated project or the dedicated `inquiry_to_quote` schema described there.

Create the restricted database login described in that document. It should execute
the workflow API functions without having general access to unrelated business data.
The n8n connection uses PostgreSQL database credentials, not the Supabase anonymous
key or an HTTP service-role key.

Create an n8n **Postgres** credential with the intended project's connection host,
port, database, restricted username, password, and provider-required SSL settings.
Use the database connection information for that project and the connection mode
supported by your n8n host. Keep certificate verification enabled where the provider
configuration supports it; do not solve a certificate problem by silently disabling
verification.

The SQL files are not automatically applied by importing a workflow. Applying them
is an operator setup step.

## 3. Add credentials in n8n

| Credential type | Used by | Required configuration |
|---|---|---|
| Gmail OAuth2 | `Gmail inquiry`, `Reply with approved message`, `Email staff digest` | Authorize the same intended mailbox through n8n's OAuth flow |
| Postgres | Every Postgres node across all four workflows | Restricted PostgreSQL account for this product |
| Header Auth | `Claude analyze` | Header name `x-api-key`; value is your Anthropic API key |
| HTTP Basic Auth | `Open staff review` and `Submit staff decision` | The same reviewer username and password for both webhooks |

Store secrets only in n8n credentials. Do not paste API keys into Code nodes, workflow
JSON, SQL examples, screenshots, or chat. Do not reuse a credential from an unrelated
product merely because it already exists in the n8n instance.

The Claude request uses `POST https://api.anthropic.com/v1/messages` and the
`anthropic-version: 2023-06-01` header. The model default is
`claude-haiku-4-5-20251001`; the workflow configuration allows changing it. Verify
availability in your Anthropic account before the first paid call. Provider behavior
is documented in [the Anthropic Messages API reference](https://platform.claude.com/docs/en/api/messages/create).

## 4. Import the four inactive workflows

Import each JSON file under `workflows/` into the intended n8n instance:

| File | Workflow name |
|---|---|
| `01-gmail-intake.json` | ITQ 01 - Gmail intake and Claude analysis |
| `02-quote-preparation.json` | ITQ 02 - Prepare clarification and quote drafts |
| `03-review-and-delivery.json` | ITQ 03 - Staff review and approved delivery |
| `04-maintenance.json` | ITQ 04 - Follow-up reminders and exceptions |

CLI example:

```powershell
n8n import:workflow --input="<absolute path to one workflow JSON>"
```

Repeat for the other three exports. The importable files contain no credential
bindings. Assign the credentials above to each matching node in a separate private
configured copy. Keep the canonical exports unchanged. Do not save over an imported
verification copy from the editor after a round-trip check.

To bind a credential, open the matching node in the private copy, select or create
its required credential, then save that private workflow while leaving it inactive.
Repeat for every node of that credential type; binding a Postgres credential on one
node does not configure the other database nodes. The `Claude analyze` node already
uses Generic Credential Type / Header Auth. Both portal webhooks already require
Basic Auth; keep that authentication setting in place.

Check that workflows 01, 02, and 03 select **ITQ 04 - Follow-up reminders and exceptions**
as their error workflow. The exports refer to the canonical ID `ITQ04Maintenance`;
if your import or duplication changes workflow IDs, reselect the actual maintenance
workflow in each private copy's settings. The maintenance workflow deliberately does
not point its own errors back to itself.

Keep the workflows inactive while you check the configuration. A manual execution of
an HTTP or Gmail node can still make a paid request or send a message even when its
workflow is inactive.

## 5. Configure the business and portal

Edit `config/settings.json` in a private copy of the package, run `npm run build`, then
import the rebuilt workflows. Build-time configuration is embedded in Code nodes;
changing the JSON file alone does not update workflows already imported into n8n.
Recheck credential bindings after importing a replacement.

| Setting | Default | Operator action |
|---|---|---|
| `businessName` | `Demo Office Cleaning` | Signs every customer email ("Kind regards, ..."); the rest of the wording is the SQL template |
| `model` | `claude-haiku-4-5-20251001` | Use a model available to the intended Anthropic account |
| `publicBaseUrl` | `https://n8n.example.invalid` | Set the HTTPS n8n base URL without a trailing slash |
| `staffEmail` | `reviewer@example.invalid` | Set the fixed staff digest recipient |
| `enableCustomerSending` | `false` | Keep off until the controlled live send test is authorized |
| `enableStaffNotifications` | `false` | Enable only when the staff address and delivery are ready |
| `followUpAfterMinutes` | `[2880, 7200]` | When follow-up drafts are prepared after a quote is sent (day 2 and day 5); up to three ascending values, `[]` turns them off |
| `gmailQuery` | `label:ITQ -in:sent -in:drafts -in:spam -in:trash` | Retain a deliberately scoped inquiry filter |
| `timezone` | `Asia/Manila` | Keep this for version one; database date checks and displayed quote validity also use Asia/Manila |

Also review the database settings in [DATABASE.md](DATABASE.md). Replace demonstration
rules before a real pilot. The database remains the authoritative source for pricing.
The business timezone is fixed to Asia/Manila in both sample SQL and workflow
configuration; changing only `timezone` does not relocate the date rules.

Create an `ITQ` label in the intended Gmail account and a filter that applies it to
the designated inquiry messages, including subsequent customer replies. A dedicated
inquiry mailbox makes that filter easier to reason about. Verify the scope with
synthetic messages before relying on it; messages without the label are not polled.

The Gmail trigger polls each minute, uses full message bodies, includes both read and
unread matching mail, and requests at most ten results per poll. Initial polling is
for new arrivals; it does **not** automatically backfill existing labeled email. An
old-message import requires a separate, deliberate intake procedure. This package is
not a high-volume inbox ingestion service, and its polling limit should be load-tested
before using a busy mailbox.

The seed rate card `DEMO-PHP-1` uses PHP 12.00 per square metre per visit, with a
PHP 1,500.00 minimum per visit. Weekly price is per-visit price multiplied by visits
per week. For 200 square metres three times weekly, this produces PHP 2,400.00 per
visit and PHP 7,200.00 weekly. These are invented **demonstration amounts**, not
researched commercial prices.

The delivered quote template adds a short note at the bottom saying the pricing is a
nonbinding demonstration; the note disappears once the active rate card is marked
`demonstration_only = false`. It leaves taxes, special cleaning, supplies, site access, and commercial
terms for staff agreement. A real commercial pilot therefore needs reviewed pricing
and quote terms in the SQL template as well as connected accounts. Enabling sending
alone does not turn this into a commercial quoting policy. A requested start date
does not confirm crew availability.

Bind the **same HTTP Basic Auth credential** to the portal GET and POST webhooks:

- `GET <publicBaseUrl>/webhook/itq-review` opens the board.
- `POST <publicBaseUrl>/webhook/itq-review-action` accepts supported staff decisions.

Each approval uses the draft's one-use token and checks its revision and expiry.
Corrections, retry requests, acceptance, rejection, and reconciliation additionally
use a one-use review-session token that expires after thirty minutes. Refresh the
board after each decision; the displayed forms are not reusable automation links.

Use the production webhook URLs displayed by n8n for the private configured copy.
The page uses absolute form and refresh URLs because n8n serves webhook HTML in a
sandboxed context. Check the host, base path, and protocol rather than assuming that
a local test URL will work after deployment. The production webhook requires the
private workflow to be active; an n8n test webhook has a different lifecycle and URL.

The GET route displays information; decisions use POST. Do not convert an approval
into a GET link: email scanners and browser prefetch can follow links automatically.
Serve the portal over HTTPS and restrict its access to the intended reviewer. The
portable package does not provide hosting or multi-user identity management.

Optional staff notification delivery is off by default. If enabled, configure a fixed
staff recipient, not a customer-supplied address. These notifications report pending
work; they do not approve or send customer messages.

## 6. Run a controlled live acceptance test

Follow [LIVE_TEST.md](LIVE_TEST.md). It uses a separate private copy built by
`npm run build:private` from the gitignored `config/settings.local.json`: workflow
IDs start with `ITQLive`, credentials are bound by their n8n IDs, and follow-ups are
set to minutes so the whole test fits in one sitting. The operator sends every test
email and clicks every approval; the portable build performs none of it.

Do not mark a path `LIVE_VERIFIED` until that path has actually been exercised against
the real provider and its outcome inspected. Import success alone is insufficient.
The 29 September 2026 run passed all 8 scenarios; the paths it exercised are
`LIVE_VERIFIED`, and the rest stay `NOT_LIVE_TESTED` (see
[the test report](../evidence/TEST_REPORT.md#live-test-29-september-2026)).

## Before operating with real inquiries

Complete the account connection test, replace sample pricing, confirm the monitored
mailbox scope, select the staff reviewer, verify the portal's authentication, and
agree on who handles the exception queue. Set n8n execution retention appropriate to
the emails it processes and keep customer evidence private.

Use [Operations](OPERATIONS.md) for the ongoing review and recovery procedure.
