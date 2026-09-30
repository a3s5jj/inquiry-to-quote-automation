import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

let db;
let sequence = 0;
const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
const scope = { location: 'BGC', area_sqm: 200, frequency_per_week: 3, preferred_hours: 'after 6 pm', requested_start_date: future };
const nullFields = () => Object.fromEntries(Object.keys(scope).map(k => [k, null]));
const source = `Please clean our BGC office, 200 sqm, three times per week, after 6 pm, starting ${future}.`;
const evidence = { location: 'BGC', area_sqm: '200 sqm', frequency_per_week: 'three times per week', preferred_hours: 'after 6 pm', requested_start_date: future };
before(async () => {
  db = new PGlite();
  await db.exec(await readFile(new URL('../db/001_schema.sql', import.meta.url), 'utf8'));
});
after(async () => { await db.close(); });
async function api(request) { return (await db.query('SELECT inquiry_to_quote.api($1::jsonb) AS result', [JSON.stringify(request)])).rows[0].result; }
async function must(request) { const result = await api(request); assert.equal(result.ok, true, JSON.stringify({ request, result })); return result; }
async function reviewToken() { return (await must({ action: 'review' })).review_token; }
async function staff(request) { return api({ ...request, reviewer: 'test-staff', review_token: await reviewToken() }); }
async function incoming(text = source, thread) {
  sequence++;
  const message = { id: `message-${sequence}`, thread_id: thread ?? `thread-${sequence}`, from_email: 'customer@example.test', subject: 'Office cleaning', text, received_at: new Date().toISOString() };
  return must({ action: 'ingest', message });
}
async function analyze(item, intent = 'new_inquiry', fields = scope, proof = evidence, extra = {}) {
  return api({ action: 'analyze', message_id: item.message.id, claim_token: item.claim_token,
    analysis: { intent, fields, evidence: proof, summary: 'Office cleaning request.', reply_draft: 'You would like your BGC office cleaned three times a week.', ...extra }, usage: { input_tokens: 101, output_tokens: 42 } });
}
async function prepared() {
  const item = await incoming();
  assert.equal((await analyze(item)).ok, true);
  const result = await must({ action: 'prepare' });
  const draft = result.drafts.find(d => d.inquiry_id === item.inquiry.id);
  assert.ok(draft);
  return { item, draft };
}
async function approve(draft) { return must({ action: 'decide', draft_id: draft.id, token: draft.approval_token, decision: 'approve', reviewer: 'test-staff' }); }
async function sentQuote() {
  const data = await prepared();
  await approve(data.draft);
  const send = (await must({ action: 'claim_send' })).sends[0];
  assert.equal(send.id, data.draft.id);
  await must({ action: 'mark_sent', draft_id: send.id, send_token: send.send_token, provider_message_id: `gmail-${send.id}` });
  return { ...data, send };
}

test('SQL installs actual tables with deny-by-default RLS and no public API execute', async () => {
  const tables = await db.query("SELECT relname,relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='inquiry_to_quote' AND c.relkind='r'");
  assert.equal(tables.rows.length, 9);
  assert.ok(tables.rows.every(row => row.relrowsecurity));
  await db.exec('CREATE ROLE itq_test_workflow; GRANT USAGE ON SCHEMA inquiry_to_quote TO itq_test_workflow; GRANT EXECUTE ON FUNCTION inquiry_to_quote.api(jsonb) TO itq_test_workflow; SET ROLE itq_test_workflow;');
  assert.equal((await must({ action: 'review' })).drafts.length, 0);
  await assert.rejects(db.query('SELECT * FROM inquiry_to_quote.messages'), /permission denied/);
  await db.exec('RESET ROLE;');
  const acl = (await db.query("SELECT proacl::text acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='inquiry_to_quote' AND proname='api'")).rows[0].acl;
  assert.ok(!acl.includes(',=X') && !acl.startsWith('{=X'));
});

test('complete inquiry produces deterministic PHP visit and weekly quote, exact subject, no duplicate draft', async () => {
  const { item, draft } = await prepared();
  assert.equal(draft.kind, 'quote');
  assert.equal(draft.amount_centavos, 240000);
  assert.equal(draft.source_revision, item.inquiry.revision);
  assert.equal(draft.rate_version, 'DEMO-PHP-1');
  assert.deepEqual(draft.scope, scope);
  assert.equal(draft.price_per_visit_centavos, 240000);
  assert.equal(draft.weekly_price_centavos, 720000);
  assert.ok(draft.quote_valid_until);
  assert.equal(draft.schedule_status, 'UNCONFIRMED');
  assert.equal(draft.review_status, 'AWAITING_STAFF_REVIEW');
  assert.equal(draft.subject, item.message.subject);
  assert.match(draft.body, /Price per visit: PHP 2,400\.00/);
  assert.match(draft.body, /Weekly total: PHP 7,200\.00 \(about PHP 31,200 per month\)/);
  assert.match(draft.body, /sample pricing for a demonstration/);
  assert.match(draft.body, /We will confirm availability and the schedule with you before the first visit\./);
  assert.ok(!(await must({ action: 'prepare' })).drafts.some(d => d.inquiry_id === item.inquiry.id));
  assert.equal((await must({ action: 'claim_send' })).sends.length, 0);
});

test('duplicate inbound is a no-op and sender mismatch is quarantined without changing revision', async () => {
  const item = await incoming();
  const duplicate = await must({ action: 'ingest', message: item.message });
  assert.equal(duplicate.process, false);
  assert.equal(duplicate.duplicate, true);
  const wrong = await api({ action: 'ingest', message: { ...item.message, id: 'wrong-sender', from_email: 'attacker@example.test' } });
  assert.equal(wrong.error, 'SENDER_MISMATCH');
  const board = await must({ action: 'review' });
  assert.equal(board.inquiries.find(i => i.id === item.inquiry.id).revision, 1);
  assert.ok(board.alerts.some(a => a.message_id === 'wrong-sender'));
  await must({ action: 'fail_analysis', message_id: item.message.id, claim_token: item.claim_token, error: 'Test cleanup' });
});

test('missing details generate clarification with no invented price', async () => {
  const item = await incoming('We need office cleaning in BGC.');
  const fields = { ...nullFields(), location: 'BGC' };
  assert.equal((await analyze(item, 'new_inquiry', fields, { ...nullFields(), location: 'BGC' })).ok, true);
  const draft = (await must({ action: 'prepare' })).drafts.find(d => d.inquiry_id === item.inquiry.id);
  assert.equal(draft.kind, 'clarification');
  assert.equal(draft.quote_id, null);
  assert.equal(draft.review_status, 'AWAITING_STAFF_REVIEW');
  assert.equal(draft.rate_version, undefined);
  assert.match(draft.body, /floor area in square metres/);
  assert.doesNotMatch(draft.body, /Price per visit/);
});

test('date in the past remains visible and blocks quote calculation', async () => {
  const item = await incoming(source.replace(future, '2000-01-01'));
  const fields = { ...scope, requested_start_date: '2000-01-01' };
  assert.equal((await analyze(item, 'new_inquiry', fields, { ...evidence, requested_start_date: '2000-01-01' })).ok, true);
  const draft = (await must({ action: 'prepare' })).drafts.find(d => d.inquiry_id === item.inquiry.id);
  assert.equal(draft.kind, 'clarification');
  assert.match(draft.body, /a new start date, because Saturday, 1 January 2000 has already passed/);
});

test('unsupported model evidence and altered number fail without committing facts', async () => {
  const item = await incoming();
  let result = await analyze(item, 'new_inquiry', { ...scope, area_sqm: 9999 }, evidence);
  assert.equal(result.error, 'UNSUPPORTED_AREA_VALUE');
  result = await analyze(item, 'new_inquiry', { ...scope, location: 'Makati' }, { ...evidence, location: 'Makati' });
  assert.equal(result.error, 'UNSUPPORTED_EVIDENCE_LOCATION');
  result = await api({ action: 'analyze', message_id: item.message.id, claim_token: item.claim_token, analysis: { intent: 'new_inquiry' } });
  assert.equal(result.error, 'INVALID_ANALYSIS');
  assert.equal((await analyze(item)).ok, true);
});

test('approval token is exact and one-use; claimed send cannot be claimed twice', async () => {
  const { draft } = await prepared();
  assert.equal((await api({ action: 'decide', draft_id: draft.id, token: 'bad', decision: 'approve', reviewer: 'test-staff' })).error, 'INVALID_OR_USED_APPROVAL');
  await approve(draft);
  assert.equal((await api({ action: 'decide', draft_id: draft.id, token: draft.approval_token, decision: 'approve', reviewer: 'test-staff' })).error, 'INVALID_OR_USED_APPROVAL');
  const claimed = await Promise.all([must({ action: 'claim_send' }), must({ action: 'claim_send' })]);
  assert.equal(claimed.flatMap(r => r.sends).length, 1);
  const send = claimed.flatMap(r => r.sends)[0];
  assert.equal((await api({ action: 'mark_sent', draft_id: send.id, send_token: 'wrong', provider_message_id: 'not-sent' })).error, 'INVALID_SEND_LEASE');
  await must({ action: 'mark_sent', draft_id: send.id, send_token: send.send_token, provider_message_id: `gmail-${send.id}` });
  assert.equal((await must({ action: 'mark_sent', draft_id: send.id, send_token: send.send_token, provider_message_id: `gmail-${send.id}` })).duplicate, true);
});

test('new inbound invalidates an approved draft and pending analysis blocks sending', async () => {
  const { item, draft } = await prepared();
  await approve(draft);
  const next = await incoming('Actually our office is 300 sqm.', item.message.thread_id);
  assert.equal((await must({ action: 'claim_send' })).sends.length, 0);
  const board = await must({ action: 'review' });
  assert.equal(board.drafts.find(d => d.id === draft.id).state, 'stale');
  assert.equal((await analyze(next, 'change', { ...nullFields(), area_sqm: 300 }, { ...nullFields(), area_sqm: '300 sqm' })).ok, true);
  const newDraft = (await must({ action: 'prepare' })).drafts.find(d => d.inquiry_id === item.inquiry.id);
  assert.equal(newDraft.amount_centavos, 360000);
  assert.equal(newDraft.revision, 2);
});

test('ambiguous acceptance does not hand off an unsent quote', async () => {
  const { item } = await prepared();
  const reply = await incoming('We accept, please proceed.', item.message.thread_id);
  const result = await analyze(reply, 'acceptance', nullFields(), nullFields());
  assert.equal(result.inquiry.status, 'manual_review');
  assert.equal((await staff({ action: 'confirm_acceptance', inquiry_id: item.inquiry.id, revision: 2 })).error, 'NOT_ACCEPTANCE_REVIEW');
});

test('sent quote acceptance requires staff confirmation and creates exactly one unscheduled job', async () => {
  const { item } = await sentQuote();
  const reply = await incoming('We accept that quotation.', item.message.thread_id);
  const analysis = await analyze(reply, 'acceptance', nullFields(), nullFields());
  assert.equal(analysis.inquiry.status, 'acceptance_review');
  assert.equal((await api({ action: 'confirm_acceptance', inquiry_id: item.inquiry.id, revision: 2, reviewer: 'test-staff' })).error, 'INVALID_OR_EXPIRED_REVIEW_TOKEN');
  const result = await staff({ action: 'confirm_acceptance', inquiry_id: item.inquiry.id, revision: 2 });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.job.schedule_status, 'UNCONFIRMED');
  assert.equal(result.job.brief.price_per_visit_centavos, 240000);
  assert.equal((await staff({ action: 'confirm_acceptance', inquiry_id: item.inquiry.id, revision: 2 })).duplicate, true);
});

test('acceptance combined with scope change routes to manual review', async () => {
  const { item } = await sentQuote();
  const reply = await incoming('We accept, but make it 300 sqm.', item.message.thread_id);
  const result = await analyze(reply, 'acceptance', { ...nullFields(), area_sqm: 300 }, { ...nullFields(), area_sqm: '300 sqm' });
  assert.equal(result.inquiry.status, 'manual_review');
  assert.equal((await staff({ action: 'confirm_acceptance', inquiry_id: item.inquiry.id, revision: 2 })).error, 'NOT_ACCEPTANCE_REVIEW');
});

test('uncertain delivery requires reconciliation and fresh approval before a retry', async () => {
  const { draft } = await prepared();
  await approve(draft);
  const send = (await must({ action: 'claim_send' })).sends[0];
  await must({ action: 'send_uncertain', draft_id: send.id, send_token: send.send_token, error: 'Network timeout after send request' });
  assert.equal((await must({ action: 'claim_send' })).sends.length, 0);
  assert.equal((await staff({ action: 'reconcile', draft_id: send.id, decision: 'confirmed_sent' })).error, 'PROVIDER_MESSAGE_ID_REQUIRED');
  assert.equal((await staff({ action: 'reconcile', draft_id: send.id, decision: 'confirmed_not_sent' })).ok, true);
  const fresh = (await must({ action: 'review' })).drafts.find(d => d.id === send.id);
  assert.equal(fresh.state, 'pending');
  assert.notEqual(fresh.approval_token, draft.approval_token);
  assert.equal((await must({ action: 'claim_send' })).sends.length, 0);
});

test('confirmed-sent reconciliation is audited and prevents retry', async () => {
  const { draft } = await prepared();
  await approve(draft);
  const send = (await must({ action: 'claim_send' })).sends[0];
  await must({ action: 'send_uncertain', draft_id: send.id, send_token: send.send_token });
  assert.equal((await staff({ action: 'reconcile', draft_id: send.id, decision: 'confirmed_sent', provider_message_id: `confirmed-${send.id}` })).ok, true);
  assert.equal((await must({ action: 'claim_send' })).sends.length, 0);
  assert.equal((await must({ action: 'review' })).drafts.find(d => d.id === send.id).state, 'sent');
});

test('failed analysis is queued only by staff; attempts capped at three', async () => {
  let item = await incoming();
  const id = item.message.id;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await must({ action: 'fail_analysis', message_id: id, claim_token: item.claim_token, error: 'Synthetic failure' });
    assert.equal((await must({ action: 'claim_analysis' })).process, false);
    const queued = await staff({ action: 'retry_analysis', message_id: id });
    if (attempt === 3) { assert.equal(queued.error, 'RETRY_UNAVAILABLE_OR_LIMIT_REACHED'); }
    else { assert.equal(queued.queued, true); item = await must({ action: 'claim_analysis' }); assert.equal(item.message.id, id); }
  }
});

test('analysis cannot merge a later message before the older pending message', async () => {
  const older = await incoming();
  const newer = await incoming('Actually use 300 sqm.', older.message.thread_id);
  assert.equal((await analyze(newer, 'change', { ...nullFields(), area_sqm: 300 }, { ...nullFields(), area_sqm: '300 sqm' })).error, 'ANALYSIS_ORDER_BLOCKED');
  assert.equal((await analyze(older)).ok, true);
  const result = await analyze(newer, 'change', { ...nullFields(), area_sqm: 300 }, { ...nullFields(), area_sqm: '300 sqm' });
  assert.equal(result.inquiry.requirements.area_sqm, 300);
  assert.equal(result.inquiry.status, 'ready');
});

test('staff revision refreshes expired/rejected work, preserves history, consumes review token', async () => {
  const { item, draft } = await prepared();
  await must({ action: 'decide', draft_id: draft.id, token: draft.approval_token, decision: 'reject', reviewer: 'test-staff' });
  const token = await reviewToken();
  const request = { action: 'revise', inquiry_id: item.inquiry.id, revision: 1, review_token: token, reviewer: 'test-staff', requirements: { ...scope, area_sqm: 100 }, reply_draft: 'Updated following staff review.' };
  assert.equal((await must(request)).inquiry.revision, 2);
  assert.equal((await api(request)).error, 'INVALID_OR_EXPIRED_REVIEW_TOKEN');
  const fresh = (await must({ action: 'prepare' })).drafts.find(d => d.inquiry_id === item.inquiry.id);
  assert.equal(fresh.amount_centavos, 150000, 'Minimum per visit applies');
  assert.match(fresh.body, /Updated following staff review/);
  assert.equal((await must({ action: 'review' })).drafts.find(d => d.id === draft.id).state, 'stale');
});

test('manual failure resolution requires explicit boolean and complete reviewed replacement; preserves provenance', async () => {
  const { item, draft } = await prepared();
  const failed = await incoming('Our office is now 300 sqm.', item.message.thread_id);
  await must({ action: 'fail_analysis', message_id: failed.message.id, claim_token: failed.claim_token, error: 'Synthetic model timeout' });
  const base = { action: 'revise', inquiry_id: item.inquiry.id, revision: 2, requirements: { ...scope, area_sqm: 300 }, reply_draft: 'Staff checked the revised area.' };
  assert.equal((await staff(base)).error, 'UNPROCESSED_INBOUND');
  assert.equal((await staff({ ...base, resolve_failed: 'true' })).error, 'UNPROCESSED_INBOUND');
  assert.equal((await staff({ ...base, resolve_failed: true, requirements: { area_sqm: 300 } })).error, 'ALL_REQUIREMENT_KEYS_REQUIRED');
  assert.equal((await db.query('SELECT state FROM inquiry_to_quote.messages WHERE id=$1', [failed.message.id])).rows[0].state, 'failed', 'Invalid revision is atomic and cannot consume failed work');
  const token = await reviewToken();
  const request = { ...base, resolve_failed: true, review_token: token, reviewer: 'test-staff' };
  const result = await must(request);
  assert.equal(result.inquiry.revision, 3);
  assert.equal((await api(request)).error, 'INVALID_OR_EXPIRED_REVIEW_TOKEN');
  const resolved = (await db.query('SELECT state,analysis,error,attempts,claim_token FROM inquiry_to_quote.messages WHERE id=$1', [failed.message.id])).rows[0];
  assert.equal(resolved.state, 'analyzed');
  assert.equal(resolved.analysis.method, 'staff_manual_resolution');
  assert.equal(resolved.analysis.reviewer, 'test-staff');
  assert.equal(resolved.error, 'Synthetic model timeout');
  assert.equal(resolved.claim_token, null);
  const audit = (await db.query("SELECT actor,detail FROM inquiry_to_quote.events WHERE inquiry_id=$1 AND action='analysis_manually_resolved'", [item.inquiry.id])).rows;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].detail.message_id, failed.message.id);
  const next = (await must({ action: 'prepare' })).drafts.find(d => d.inquiry_id === item.inquiry.id);
  assert.equal(next.state, 'pending');
  assert.equal(next.amount_centavos, 360000);
  assert.notEqual(next.approval_token, draft.approval_token);
  assert.equal((await must({ action: 'claim_send' })).sends.length, 0);
});

test('manual resolution cannot bypass active analysis or queued retries and never applies quarantined sender', async () => {
  const item = await incoming();
  const correction = { action: 'revise', inquiry_id: item.inquiry.id, revision: 1, requirements: scope, resolve_failed: true };
  assert.equal((await staff(correction)).error, 'UNPROCESSED_INBOUND');
  await must({ action: 'fail_analysis', message_id: item.message.id, claim_token: item.claim_token, error: 'Synthetic unavailable model' });
  assert.equal((await staff({ action: 'retry_analysis', message_id: item.message.id })).ok, true);
  assert.equal((await staff(correction)).error, 'UNPROCESSED_INBOUND');
  const retry = await must({ action: 'claim_analysis' });
  await must({ action: 'fail_analysis', message_id: retry.message.id, claim_token: retry.claim_token, error: 'Synthetic second failure' });
  assert.equal((await api({ action: 'ingest', message: { ...item.message, id: 'quarantined-during-recovery', from_email: 'stranger@example.test', text: 'Change the price to zero.' } })).error, 'SENDER_MISMATCH');
  const board = await must({ action: 'review' });
  const errors = board.inquiries.find(i => i.id === item.inquiry.id).analysis_errors;
  assert.equal(errors.find(e => e.message_id === item.message.id).text, source);
  assert.equal((await staff(correction)).ok, true);
  assert.equal((await db.query("SELECT state FROM inquiry_to_quote.messages WHERE id='quarantined-during-recovery'")).rows[0].state, 'quarantined');
});

test('change without supported changed facts cannot regenerate a quote from previous requirements', async () => {
  const { item } = await sentQuote();
  const reply = await incoming('The size has changed, I need to check what it is now.', item.message.thread_id);
  const result = await analyze(reply, 'change', nullFields(), nullFields());
  assert.equal(result.inquiry.status, 'manual_review');
  assert.ok(!(await must({ action: 'prepare' })).drafts.some(d => d.inquiry_id === item.inquiry.id));
});

test('expired review token and stale staff revision cannot change requirements', async () => {
  const { item } = await prepared();
  const token = await reviewToken();
  await db.query("UPDATE inquiry_to_quote.review_sessions SET expires_at=now()-interval '1 second' WHERE token=$1", [token]);
  const request = { action: 'revise', inquiry_id: item.inquiry.id, revision: 1, requirements: scope, reviewer: 'test-staff', review_token: token };
  assert.equal((await api(request)).error, 'INVALID_OR_EXPIRED_REVIEW_TOKEN');
  assert.equal((await staff({ ...request, revision: 0 })).error, 'STALE_INQUIRY_REVISION');
  assert.equal((await must({ action: 'review' })).inquiries.find(i => i.id === item.inquiry.id).revision, 1);
});

test('expired quote cannot be accepted even after a customer acceptance', async () => {
  const { item, draft } = await sentQuote();
  const reply = await incoming('We accept the quotation.', item.message.thread_id);
  assert.equal((await analyze(reply, 'acceptance', nullFields(), nullFields())).inquiry.status, 'acceptance_review');
  await db.query("UPDATE inquiry_to_quote.quotes SET valid_until=now()-interval '1 second' WHERE id=$1", [draft.quote_id]);
  assert.equal((await staff({ action: 'confirm_acceptance', inquiry_id: item.inquiry.id, revision: 2 })).error, 'NO_MATCHING_VALID_SENT_QUOTE');
  assert.equal((await db.query('SELECT count(*)::integer AS n FROM inquiry_to_quote.jobs WHERE inquiry_id=$1', [item.inquiry.id])).rows[0].n, 0);
});

test('new pending inbound prevents handoff, and delivery uncertainty prevents staff corrections', async () => {
  const { item, draft } = await prepared();
  await approve(draft);
  const send = (await must({ action: 'claim_send' })).sends[0];
  await must({ action: 'send_uncertain', draft_id: send.id, send_token: send.send_token });
  assert.equal((await staff({ action: 'revise', inquiry_id: item.inquiry.id, revision: 1, requirements: scope })).error, 'UNRESOLVED_DELIVERY');
  await staff({ action: 'reconcile', draft_id: send.id, decision: 'confirmed_sent', provider_message_id: `late-${send.id}` });
  const acceptance = await incoming('We accept the quotation.', item.message.thread_id);
  assert.equal((await analyze(acceptance, 'acceptance', nullFields(), nullFields())).inquiry.status, 'acceptance_review');
  const pending = await incoming('Wait, please hold for another update.', item.message.thread_id);
  assert.equal((await staff({ action: 'confirm_acceptance', inquiry_id: item.inquiry.id, revision: 3 })).error, 'UNPROCESSED_INBOUND');
  await must({ action: 'fail_analysis', message_id: pending.message.id, claim_token: pending.claim_token, error: 'Test cleanup' });
});

test('maintenance expires stale leases, approvals, and creates overdue alerts without sending', async () => {
  const { item, draft } = await prepared();
  await db.query("UPDATE inquiry_to_quote.drafts SET expires_at=now()-interval '1 minute' WHERE id=$1", [draft.id]);
  await db.query("UPDATE inquiry_to_quote.inquiries SET next_action_at=now()-interval '1 day' WHERE id=$1", [item.inquiry.id]);
  const pending = await incoming();
  await db.query("UPDATE inquiry_to_quote.messages SET lease_until=now()-interval '1 minute' WHERE id=$1", [pending.message.id]);
  const result = await must({ action: 'maintenance' });
  assert.ok(result.alerts.some(a => a.type === 'approval_expired' && a.draft_id === draft.id));
  assert.ok(result.alerts.some(a => a.type === 'analysis_failed' && a.message_id === pending.message.id));
  assert.ok(result.alerts.some(a => a.type === 'overdue' && a.inquiry_id === item.inquiry.id));
  assert.equal((await must({ action: 'claim_send' })).sends.length, 0);
});

test('staff digest has at-most-once attempts and failure stays visible in portal', async () => {
  await must({ action: 'report_error', source: 'test', message: 'Synthetic failure Bearer abc.secret', execution_id: 'offline-only' });
  let claimed = await must({ action: 'claim_notifications' });
  assert.equal(claimed.notifications.length, 1);
  const notification = claimed.notifications[0];
  assert.ok(notification.body.includes('\n'));
  assert.ok(!notification.body.includes('\\n'), 'Digest rows use actual line breaks');
  await must({ action: 'notification_result', id: notification.id, error: 'Synthetic uncertain provider result' });
  const board = await must({ action: 'review' });
  assert.ok(board.alerts.some(a => a.type === 'notification_uncertain' && a.notification_id === notification.id));
  assert.ok(board.alerts.some(a => a.type === 'execution_error' && a.detail.message.includes('[REDACTED]')));
  for (let n = 0; n < 10; n++) {
    claimed = await must({ action: 'claim_notifications' });
    if (!claimed.notifications.length) break;
    assert.notEqual(claimed.notifications[0].id, notification.id);
    await must({ action: 'notification_result', id: claimed.notifications[0].id, provider_message_id: 'staff-' + claimed.notifications[0].id });
  }
  assert.equal((await must({ action: 'claim_notifications' })).notifications.length, 0);
});

test('unknown actions and invalid identifiers return structured guarded failures', async () => {
  assert.equal((await api({ action: 'not-an-action' })).error, 'UNKNOWN_ACTION');
  assert.equal((await api({ action: 'decide', draft_id: 'not-a-uuid', token: 'bad', reviewer: 'staff' })).error, 'INVALID_REQUEST_VALUE');
});

test('customer emails have one greeting, one signed sign-off and readable money and dates', async () => {
  const item = await incoming();
  assert.equal((await analyze(item)).ok, true);
  const draft = (await must({ action: 'prepare', business_name: 'Sparkle Offices' })).drafts.find(d => d.inquiry_id === item.inquiry.id);
  const lines = draft.body.split('\n');
  assert.equal(lines[0], 'Hello,');
  assert.equal(lines[2], 'Thanks for your message. You would like your BGC office cleaned three times a week.');
  assert.equal(draft.body.match(/Hello,/g).length, 1);
  assert.equal(draft.body.match(/Kind regards,/g).length, 1);
  assert.match(draft.body, /Kind regards,\nSparkle Offices\n\nNote: this quote uses sample pricing for a demonstration and is not a binding offer\.$/);
  assert.match(draft.body, /Floor area: 200 sqm\nVisits per week: 3\n/);
  const start = new Date(`${future}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).replace(/^(\w+) /, '$1, ');
  assert.ok(draft.body.includes(`Start date: ${start}\n`), start);
  assert.match(draft.body, /This price is valid until \w+, \d{1,2} \w+ \d{4}\./);
  assert.doesNotMatch(draft.body, /DEMO-PHP-1|YYYY|Asia\/Manila|\d{4}-\d{2}-\d{2}/);
  const validUntil = (await db.query("SELECT (valid_until AT TIME ZONE 'Asia/Manila')::text AS local FROM inquiry_to_quote.quotes WHERE id=$1", [draft.quote_id])).rows[0].local;
  assert.match(validUntil, /^\d{4}-\d{2}-\d{2} 00:00:00$/, 'Quotes stay valid to the end of the last Manila day');
});

test('clarification asks in plain words, never for a date format, and only mentions dates the customer gave', async () => {
  const item = await incoming('We need office cleaning in BGC.');
  const fields = { ...nullFields(), location: 'BGC' };
  assert.equal((await analyze(item, 'new_inquiry', fields, { ...nullFields(), location: 'BGC' }, { reply_draft: '' })).ok, true);
  const draft = (await must({ action: 'prepare' })).drafts.find(d => d.inquiry_id === item.inquiry.id);
  assert.equal(draft.body, 'Hello,\n\nThanks for your message.\n\nTo prepare your quote, could you tell us:\n- the floor area in square metres\n- how many cleaning visits you need each week\n\nIf you already know them, please also share your preferred cleaning hours and when you would like us to start.\n\nKind regards,\nThe office cleaning team');
  assert.equal((await api({ action: 'prepare', business_name: 'Bad\nName' })).error, 'INVALID_BUSINESS_NAME');
});

test('the demonstration note disappears once a real rate card is active', async () => {
  await db.exec("UPDATE inquiry_to_quote.rate_cards SET active=false; INSERT INTO inquiry_to_quote.rate_cards(version,label,currency,centavos_per_sqm,minimum_visit_centavos,active,demonstration_only) VALUES ('REAL-TEST-1','Test real card','PHP',1200,150000,true,false);");
  try {
    const { draft } = await prepared();
    assert.equal(draft.rate_version, 'REAL-TEST-1');
    assert.doesNotMatch(draft.body, /demonstration|sample pricing/i);
    assert.match(draft.body, /Kind regards,\nThe office cleaning team$/);
  } finally {
    await db.exec("UPDATE inquiry_to_quote.rate_cards SET active=false; UPDATE inquiry_to_quote.rate_cards SET active=true WHERE version='DEMO-PHP-1';");
  }
});

const priceOnly = { ...nullFields(), location: 'BGC', area_sqm: 200, frequency_per_week: 3 };
const priceProof = { ...nullFields(), location: 'BGC', area_sqm: '200 sqm', frequency_per_week: 'three times per week' };
const priceSource = 'Please clean our BGC office, 200 sqm, three times per week.';
async function sendDraft(draft) {
  await approve(draft);
  const send = (await must({ action: 'claim_send' })).sends[0];
  assert.equal(send.id, draft.id);
  await must({ action: 'mark_sent', draft_id: send.id, send_token: send.send_token, provider_message_id: `gmail-${send.id}` });
}
async function priceOnlyQuote() {
  const item = await incoming(priceSource);
  assert.equal((await analyze(item, 'new_inquiry', priceOnly, priceProof)).ok, true);
  const draft = (await must({ action: 'prepare' })).drafts.find(d => d.inquiry_id === item.inquiry.id);
  return { item, draft };
}
const quoteState = async id => (await db.query('SELECT state FROM inquiry_to_quote.quotes WHERE id=$1', [id])).rows[0].state;

test('location, floor area and visits are enough for a quote; hours and start date are asked alongside it', async () => {
  const { draft } = await priceOnlyQuote();
  assert.equal(draft.kind, 'quote');
  assert.equal(draft.amount_centavos, 240000);
  assert.match(draft.body, /Preferred hours: to confirm\nStart date: to confirm\n/);
  assert.match(draft.body, /Could you also tell us your preferred cleaning hours and when you would like us to start\? The price above stays the same\./);
  assert.doesNotMatch(draft.body, /you said|read your start date/);
});

test('an interpreted start date is echoed back with the words the customer used', async () => {
  const item = await incoming(`${priceSource} After 6 pm, starting next Monday.`);
  const fields = { ...priceOnly, preferred_hours: 'After 6 pm', requested_start_date: future };
  const proof = { ...priceProof, preferred_hours: 'After 6 pm', requested_start_date: 'starting next Monday' };
  assert.equal((await analyze(item, 'new_inquiry', fields, proof, { start_date_words: 'next Monday' })).ok, true);
  const draft = (await must({ action: 'prepare' })).drafts.find(d => d.inquiry_id === item.inquiry.id);
  assert.match(draft.body, /Start date: \w+, \d{1,2} \w+ \d{4} \(you said "next Monday"\)\n/);
  assert.match(draft.body, /If we read your start date wrong, just reply with the right one\./);
  assert.doesNotMatch(draft.body, /Could you also tell us/);
  const board = await must({ action: 'review' });
  assert.equal(board.inquiries.find(i => i.id === item.inquiry.id).requirements.start_date_words, 'next Monday');
});

test('unclear start words keep the quote moving and the words must come from the email', async () => {
  const item = await incoming(`${priceSource} We need you to start ASAP.`);
  const proof = { ...priceProof, requested_start_date: 'start ASAP' };
  assert.equal((await analyze(item, 'new_inquiry', priceOnly, proof, { start_date_words: 'yesterday afternoon' })).error, 'UNSUPPORTED_START_DATE_WORDS');
  assert.equal((await analyze(item, 'new_inquiry', priceOnly, proof, { start_date_words: 'ASAP' })).ok, true);
  const draft = (await must({ action: 'prepare' })).drafts.find(d => d.inquiry_id === item.inquiry.id);
  assert.equal(draft.kind, 'quote');
  assert.match(draft.body, /Start date: to confirm \(you said "ASAP"\)\n/);
  assert.match(draft.body, /Could you also tell us your preferred cleaning hours and the exact date you would like us to start\?/);
});

test('hours or a start date sent after the quote give an updated quote at the same price without cancelling the sent one', async () => {
  const { item, draft } = await priceOnlyQuote();
  await sendDraft(draft);
  const reply = await incoming(`Evenings after 6 pm please, starting ${future}.`, item.message.thread_id);
  const fields = { ...nullFields(), preferred_hours: 'Evenings after 6 pm', requested_start_date: future };
  const proof = { ...nullFields(), preferred_hours: 'Evenings after 6 pm', requested_start_date: future };
  assert.equal((await analyze(reply, 'details', fields, proof, { reply_draft: '' })).inquiry.status, 'ready');
  assert.equal(await quoteState(draft.quote_id), 'sent', 'Schedule details never cancel a sent quote');
  await db.exec("UPDATE inquiry_to_quote.rate_cards SET centavos_per_sqm=5000 WHERE version='DEMO-PHP-1';");
  try {
    const updated = (await must({ action: 'prepare' })).drafts.find(d => d.inquiry_id === item.inquiry.id);
    assert.equal(updated.kind, 'quote');
    assert.equal(updated.price_per_visit_centavos, 240000, 'Same price even if the rate card changed since');
    assert.equal(updated.weekly_price_centavos, 720000);
    assert.equal(updated.quote_valid_until, draft.quote_valid_until, 'The original expiry still applies');
    assert.match(updated.body, /Here is your updated quote with the details you sent\. The price has not changed\./);
    assert.match(updated.body, /Preferred hours: Evenings after 6 pm\n/);
    assert.doesNotMatch(updated.body, /Could you also tell us/);
    await sendDraft(updated);
    assert.equal(await quoteState(draft.quote_id), 'superseded', 'The newly sent quote replaces the older one');
    assert.equal(await quoteState(updated.quote_id), 'sent');
  } finally {
    await db.exec("UPDATE inquiry_to_quote.rate_cards SET centavos_per_sqm=1200 WHERE version='DEMO-PHP-1';");
  }
});

test('"yes, start next Monday" goes straight to acceptance review and into the operations brief', async () => {
  const { item, draft } = await priceOnlyQuote();
  await sendDraft(draft);
  const reply = await incoming('Yes, we accept. Please start next Monday.', item.message.thread_id);
  const fields = { ...nullFields(), requested_start_date: future };
  const proof = { ...nullFields(), requested_start_date: 'start next Monday' };
  assert.equal((await analyze(reply, 'acceptance', fields, proof, { start_date_words: 'next Monday' })).inquiry.status, 'acceptance_review');
  assert.ok(!(await must({ action: 'prepare' })).drafts.some(d => d.inquiry_id === item.inquiry.id), 'No new quote for an acceptance');
  const job = (await staff({ action: 'confirm_acceptance', inquiry_id: item.inquiry.id, revision: 2 })).job;
  assert.equal(job.brief.scope.requested_start_date, future);
  assert.equal(job.brief.quoted_scope.requested_start_date, undefined);
  assert.equal(job.brief.price_per_visit_centavos, 240000);
  assert.ok(job.brief.outstanding_requirements.includes('Agree the cleaning hours with the customer.'));
  assert.ok(job.brief.outstanding_requirements.includes('Confirm the start date read from "next Monday".'));
});

test('a price detail change still cancels the sent quote, even inside an acceptance', async () => {
  const { item, draft } = await priceOnlyQuote();
  await sendDraft(draft);
  const reply = await incoming('Yes, but please make it 300 sqm.', item.message.thread_id);
  const fields = { ...nullFields(), area_sqm: 300 };
  const proof = { ...nullFields(), area_sqm: '300 sqm' };
  assert.equal((await analyze(reply, 'acceptance', fields, proof)).inquiry.status, 'manual_review');
  assert.equal(await quoteState(draft.quote_id), 'superseded');
});

const ageQuote = (quoteId, hours) => db.query(`UPDATE inquiry_to_quote.quotes SET sent_at=now()-interval '${Number(hours)} hours' WHERE id=$1`, [quoteId]);
const followUps = async inquiryId => (await must({ action: 'review' })).drafts.filter(d => d.inquiry_id === inquiryId && d.kind === 'follow_up');
const preparedFor = async (inquiryId, request = {}) => (await must({ action: 'prepare', ...request })).drafts.filter(d => d.inquiry_id === inquiryId);

test('a quiet quote gets follow-up 1 on day 2 and a last one on day 5, then nothing more', async () => {
  const { item, draft } = await priceOnlyQuote();
  await sendDraft(draft);
  assert.equal((await preparedFor(item.inquiry.id)).length, 0, 'Nothing before the delay');
  await ageQuote(draft.quote_id, 49);
  const sentAt = (await db.query('SELECT sent_at FROM inquiry_to_quote.quotes WHERE id=$1', [draft.quote_id])).rows[0].sent_at;
  const [first] = await preparedFor(item.inquiry.id);
  assert.equal(first.kind, 'follow_up');
  assert.equal(first.follow_up_number, 1);
  assert.equal(first.follow_up_total, 2);
  assert.equal(first.quote_id, draft.quote_id);
  assert.equal(first.amount_centavos, null, 'A follow-up restates the sent quote; it is not a new price');
  assert.match(first.body, /^Hello,\n\nJust following up on the quote we sent on \w+, \d{1,2} \w+ for recurring office cleaning in BGC: PHP 2,400\.00 per visit, 3 visits per week\. It is valid until \w+, \d{1,2} \w+ \d{4}\./);
  assert.match(first.body, /a quick yes is all we need\.\n\nKind regards,\nThe office cleaning team\n\nNote: this quote uses sample pricing/);
  assert.equal((await must({ action: 'review' })).inquiries.find(i => i.id === item.inquiry.id).status, 'awaiting_approval');
  await sendDraft(first);
  const quote = (await db.query('SELECT state,sent_at FROM inquiry_to_quote.quotes WHERE id=$1', [draft.quote_id])).rows[0];
  assert.equal(quote.state, 'sent', 'Sending a follow-up never changes the quote');
  assert.equal(quote.sent_at.getTime(), sentAt.getTime(), 'Follow-up timing keeps counting from the original quote');
  assert.equal((await must({ action: 'review' })).inquiries.find(i => i.id === item.inquiry.id).status, 'quoted');
  assert.equal((await preparedFor(item.inquiry.id)).length, 0, 'Follow-up 2 waits for day 5');
  await ageQuote(draft.quote_id, 121);
  const [last] = await preparedFor(item.inquiry.id);
  assert.equal(last.follow_up_number, 2);
  assert.match(last.body, /^Hello,\n\nA last quick reminder about the quote we sent on/);
  assert.match(last.body, /If now is not the right time, no problem at all\./);
  await sendDraft(last);
  await ageQuote(draft.quote_id, 160);
  assert.equal((await preparedFor(item.inquiry.id)).length, 0, 'Never more than the configured follow-ups');
  const reply = await incoming('Yes, we accept the quote.', item.message.thread_id);
  assert.equal((await analyze(reply, 'acceptance', nullFields(), nullFields())).inquiry.status, 'acceptance_review', 'Acceptance still works after follow-ups');
});

test('a customer reply, a rejected follow-up or an expired quote stops the follow-ups', async () => {
  const replied = await priceOnlyQuote();
  await sendDraft(replied.draft);
  const question = await incoming('Do you bring your own supplies?', replied.item.message.thread_id);
  assert.equal((await analyze(question, 'question', nullFields(), nullFields())).ok, true);
  await ageQuote(replied.draft.quote_id, 49);
  assert.ok(!(await preparedFor(replied.item.inquiry.id)).some(d => d.kind === 'follow_up'), 'A reply since the quote means no nudge');

  const rejected = await priceOnlyQuote();
  await sendDraft(rejected.draft);
  await ageQuote(rejected.draft.quote_id, 49);
  const [nudge] = await preparedFor(rejected.item.inquiry.id);
  await must({ action: 'decide', draft_id: nudge.id, token: nudge.approval_token, decision: 'reject', reviewer: 'test-staff' });
  assert.equal((await must({ action: 'review' })).inquiries.find(i => i.id === rejected.item.inquiry.id).status, 'quoted', 'Rejecting a nudge leaves the quote standing');
  await ageQuote(rejected.draft.quote_id, 121);
  assert.equal((await preparedFor(rejected.item.inquiry.id)).length, 0, 'A rejected follow-up ends the sequence');

  const expired = await priceOnlyQuote();
  await sendDraft(expired.draft);
  await ageQuote(expired.draft.quote_id, 49);
  await db.query("UPDATE inquiry_to_quote.quotes SET valid_until=now()-interval '1 minute' WHERE id=$1", [expired.draft.quote_id]);
  assert.equal((await preparedFor(expired.item.inquiry.id)).length, 0, 'No nudge for an expired quote');
  assert.equal((await followUps(expired.item.inquiry.id)).length, 0);
});

test('follow-up delays come from settings and are validated', async () => {
  const { item, draft } = await priceOnlyQuote();
  await sendDraft(draft);
  assert.equal((await api({ action: 'prepare', follow_up_after_minutes: [30, 10] })).error, 'INVALID_FOLLOW_UP_DELAYS');
  assert.equal((await api({ action: 'prepare', follow_up_after_minutes: [0] })).error, 'INVALID_FOLLOW_UP_DELAYS');
  assert.equal((await api({ action: 'prepare', follow_up_after_minutes: 5 })).error, 'INVALID_FOLLOW_UP_DELAYS');
  await db.query("UPDATE inquiry_to_quote.quotes SET sent_at=now()-interval '3 minutes' WHERE id=$1", [draft.quote_id]);
  assert.equal((await preparedFor(item.inquiry.id, { follow_up_after_minutes: [] })).length, 0, 'An empty list turns follow-ups off');
  const [only] = await preparedFor(item.inquiry.id, { follow_up_after_minutes: [2] });
  assert.equal(only.follow_up_number, 1);
  assert.equal(only.follow_up_total, 1);
  assert.match(only.body, /A last quick reminder/, 'With one follow-up configured, it is the last one');
});
