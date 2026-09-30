-- AI Inquiry-to-Quote, schema version 1. DEMONSTRATION PRICING ONLY.
-- Run once as the database owner in a NEW Supabase project/database.
-- No grants are given to anon/authenticated/public. See docs/DATABASE.md.
BEGIN;
CREATE SCHEMA IF NOT EXISTS inquiry_to_quote;
REVOKE ALL ON SCHEMA inquiry_to_quote FROM PUBLIC;

CREATE TABLE IF NOT EXISTS inquiry_to_quote.rate_cards (
  version text PRIMARY KEY,
  label text NOT NULL,
  currency text NOT NULL CHECK (currency = 'PHP'),
  centavos_per_sqm bigint NOT NULL CHECK (centavos_per_sqm > 0),
  minimum_visit_centavos bigint NOT NULL CHECK (minimum_visit_centavos > 0),
  active boolean NOT NULL DEFAULT false,
  demonstration_only boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_rate_card ON inquiry_to_quote.rate_cards (active) WHERE active;
INSERT INTO inquiry_to_quote.rate_cards(version,label,currency,centavos_per_sqm,minimum_visit_centavos,active)
VALUES ('DEMO-PHP-1','DEMONSTRATION ONLY: recurring office cleaning','PHP',1200,150000,true)
ON CONFLICT (version) DO NOTHING;

CREATE TABLE IF NOT EXISTS inquiry_to_quote.inquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id text NOT NULL UNIQUE,
  from_email text NOT NULL,
  subject text NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  analyzed_revision integer NOT NULL DEFAULT 0,
  requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'analyzing',
  last_intent text,
  last_summary text,
  last_reply_draft text,
  last_message_id text,
  last_inbound_at timestamptz NOT NULL DEFAULT now(),
  next_action_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inquiry_to_quote.messages (
  id text PRIMARY KEY,
  inquiry_id uuid NOT NULL REFERENCES inquiry_to_quote.inquiries(id),
  inbound_revision integer NOT NULL,
  thread_id text NOT NULL,
  from_email text NOT NULL,
  subject text NOT NULL,
  text text NOT NULL,
  received_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('analyzing','analyzed','failed','retry_requested','quarantined')),
  claim_token uuid,
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts <= 3),
  analysis jsonb,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_inquiry_state ON inquiry_to_quote.messages(inquiry_id,state,inbound_revision);
CREATE TABLE IF NOT EXISTS inquiry_to_quote.quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id uuid NOT NULL REFERENCES inquiry_to_quote.inquiries(id),
  revision integer NOT NULL,
  rate_version text NOT NULL REFERENCES inquiry_to_quote.rate_cards(version),
  scope jsonb NOT NULL,
  currency text NOT NULL DEFAULT 'PHP',
  visit_centavos bigint NOT NULL CHECK (visit_centavos > 0),
  weekly_centavos bigint NOT NULL CHECK (weekly_centavos > 0),
  valid_until timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'prepared',
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inquiry_id,revision)
);
CREATE TABLE IF NOT EXISTS inquiry_to_quote.drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id uuid NOT NULL REFERENCES inquiry_to_quote.inquiries(id),
  revision integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('clarification','quote','question','follow_up')),
  follow_up_number integer NOT NULL DEFAULT 0 CHECK (follow_up_number BETWEEN 0 AND 3),
  recipient text NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  quote_id uuid REFERENCES inquiry_to_quote.quotes(id),
  amount_centavos bigint,
  approval_token uuid NOT NULL DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','stale','expired','sending','sent','uncertain')),
  reply_message_id text NOT NULL REFERENCES inquiry_to_quote.messages(id),
  thread_id text NOT NULL,
  approved_by text,
  approved_at timestamptz,
  send_token uuid,
  send_started_at timestamptz,
  provider_message_id text,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inquiry_id,revision,follow_up_number)
);
CREATE UNIQUE INDEX IF NOT EXISTS unique_provider_message ON inquiry_to_quote.drafts(provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS inquiry_to_quote.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inquiry_id uuid NOT NULL UNIQUE REFERENCES inquiry_to_quote.inquiries(id),
  quote_id uuid NOT NULL UNIQUE REFERENCES inquiry_to_quote.quotes(id),
  confirmed_by text NOT NULL,
  brief jsonb NOT NULL,
  schedule_status text NOT NULL DEFAULT 'UNCONFIRMED',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inquiry_to_quote.events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  inquiry_id uuid REFERENCES inquiry_to_quote.inquiries(id),
  action text NOT NULL,
  actor text NOT NULL DEFAULT 'workflow',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  notification_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS inquiry_to_quote.review_sessions (
  token uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '30 minutes')
);
CREATE TABLE IF NOT EXISTS inquiry_to_quote.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_ids bigint[] NOT NULL,
  subject text NOT NULL,
  body text NOT NULL,
  state text NOT NULL DEFAULT 'attempting' CHECK (state IN ('attempting','sent','uncertain')),
  provider_message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Row-level security is deny-by-default. The narrowly granted SECURITY DEFINER
-- API is the only application access path, owned by the schema/table owner.
ALTER TABLE inquiry_to_quote.rate_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiry_to_quote.inquiries ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiry_to_quote.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiry_to_quote.quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiry_to_quote.drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiry_to_quote.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiry_to_quote.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiry_to_quote.review_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiry_to_quote.notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA inquiry_to_quote FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA inquiry_to_quote FROM PUBLIC;

-- Only these details set the price. Hours and start date are schedule details:
-- changing them never cancels a sent quote or changes its price.
CREATE OR REPLACE FUNCTION inquiry_to_quote.price_scope(scope jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT jsonb_build_object('location',scope->'location','area_sqm',scope->'area_sqm','frequency_per_week',scope->'frequency_per_week') $$;
REVOKE ALL ON FUNCTION inquiry_to_quote.price_scope(jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION inquiry_to_quote.api(p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, inquiry_to_quote, pg_temp
AS $$
DECLARE
  a text := p->>'action';
  i inquiry_to_quote.inquiries%ROWTYPE;
  m inquiry_to_quote.messages%ROWTYPE;
  d inquiry_to_quote.drafts%ROWTYPE;
  q inquiry_to_quote.quotes%ROWTYPE;
  r inquiry_to_quote.rate_cards%ROWTYPE;
  j inquiry_to_quote.jobs%ROWTYPE;
  v jsonb;
  f jsonb;
  evidence jsonb;
  fields jsonb;
  requirement_keys text[] := ARRAY['location','area_sqm','frequency_per_week','preferred_hours','requested_start_date'];
  price_keys text[] := ARRAY['location','area_sqm','frequency_per_week'];
  price_changed boolean;
  prior inquiry_to_quote.quotes%ROWTYPE;
  updated_quote boolean;
  quote_rate text;
  quote_demo boolean;
  quote_valid timestamptz;
  words text;
  start_text text;
  schedule_missing text[];
  delays integer[];
  sent_count integer;
  k text;
  val text;
  proof text;
  missing text[];
  details_changed boolean;
  intent text;
  body_text text;
  draft_kind text;
  visit_amount bigint;
  weekly_amount bigint;
  actor text := coalesce(nullif(p->>'reviewer',''),'workflow');
  token uuid;
  result jsonb;
  draft_list jsonb := '[]'::jsonb;
  alerts jsonb := '[]'::jsonb;
  local_today date := (now() AT TIME ZONE 'Asia/Manila')::date;
  day_requested date;
  business text;
  opener text;
  signoff text;
  found_existing boolean;
  event_ids bigint[];
  notification inquiry_to_quote.notifications%ROWTYPE;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' OR a IS NULL THEN
    RAISE EXCEPTION 'INVALID_REQUEST';
  END IF;
  IF a IN ('decide','confirm_acceptance','close_lost','reconcile','retry_analysis','revise')
     AND (actor = 'workflow' OR length(actor) > 120) THEN
    RAISE EXCEPTION 'STAFF_REVIEWER_REQUIRED';
  END IF;
  IF a IN ('confirm_acceptance','close_lost','reconcile','retry_analysis','revise') THEN
    DELETE FROM inquiry_to_quote.review_sessions rs WHERE rs.token::text=coalesce(p->>'review_token','') AND rs.expires_at>now() RETURNING rs.token INTO token;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_OR_EXPIRED_REVIEW_TOKEN'; END IF;
  END IF;

  IF a = 'ingest' THEN
    v := p->'message';
    IF coalesce(v->>'id','') = '' OR coalesce(v->>'thread_id','') = ''
       OR coalesce(v->>'from_email','') !~ '^[^[:space:]@<>]+@[^[:space:]@<>]+\.[^[:space:]@<>]+$'
       OR coalesce(v->>'text','') = '' OR length(v->>'text') > 100000
       OR length(coalesce(v->>'subject','')) > 998 OR length(v->>'id') > 300
       OR length(v->>'thread_id') > 300 THEN
      RAISE EXCEPTION 'INVALID_MESSAGE';
    END IF;
    -- Serialize ingest per Gmail thread, including first-insert races.
    PERFORM pg_advisory_xact_lock(hashtextextended(v->>'thread_id',0));
    SELECT * INTO m FROM inquiry_to_quote.messages WHERE id = v->>'id';
    IF FOUND THEN
      RETURN jsonb_build_object('ok',true,'process',false,'duplicate',true,'message_id',m.id);
    END IF;
    INSERT INTO inquiry_to_quote.inquiries(thread_id,from_email,subject)
    VALUES(v->>'thread_id',lower(v->>'from_email'),coalesce(v->>'subject','Cleaning inquiry'))
    ON CONFLICT (thread_id) DO NOTHING;
    SELECT * INTO i FROM inquiry_to_quote.inquiries WHERE thread_id = v->>'thread_id' FOR UPDATE;
    IF lower(v->>'from_email') <> i.from_email THEN
      INSERT INTO inquiry_to_quote.messages(id,inquiry_id,inbound_revision,thread_id,from_email,subject,text,received_at,state,error)
      VALUES(v->>'id',i.id,i.revision,v->>'thread_id',lower(v->>'from_email'),coalesce(v->>'subject',''),v->>'text',coalesce((v->>'received_at')::timestamptz,now()),'quarantined','SENDER_MISMATCH');
      INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,'sender_quarantined',jsonb_build_object('message_id',v->>'id'));
      RETURN jsonb_build_object('ok',false,'error','SENDER_MISMATCH','process',false,'inquiry_id',i.id);
    END IF;
    token := gen_random_uuid();
    UPDATE inquiry_to_quote.inquiries SET revision=revision+1,status=CASE WHEN closed_at IS NULL THEN 'analyzing' ELSE 'manual_review' END,
      last_message_id=v->>'id',last_inbound_at=now(),updated_at=now(),next_action_at=now()+interval '1 day'
      WHERE id=i.id RETURNING * INTO i;
    UPDATE inquiry_to_quote.drafts SET state='stale',approval_token=gen_random_uuid(),updated_at=now(),last_error='NEW_INBOUND_MESSAGE'
      WHERE inquiry_id=i.id AND state IN ('pending','approved');
    INSERT INTO inquiry_to_quote.messages(id,inquiry_id,inbound_revision,thread_id,from_email,subject,text,received_at,state,claim_token,lease_until,attempts)
    VALUES(v->>'id',i.id,i.revision,i.thread_id,i.from_email,coalesce(v->>'subject',''),v->>'text',coalesce((v->>'received_at')::timestamptz,now()),'analyzing',token,now()+interval '15 minutes',1)
    RETURNING * INTO m;
    INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,'ingested',jsonb_build_object('message_id',m.id,'revision',i.revision));
    RETURN jsonb_build_object('ok',true,'process',true,'message',jsonb_build_object('id',m.id,'thread_id',m.thread_id,'from_email',m.from_email,'subject',m.subject,'text',m.text,'received_at',m.received_at),
      'inquiry',to_jsonb(i),'claim_token',token);

  ELSIF a = 'analyze' THEN
    SELECT * INTO m FROM inquiry_to_quote.messages WHERE id=p->>'message_id';
    IF NOT FOUND THEN RAISE EXCEPTION 'MESSAGE_NOT_FOUND'; END IF;
    SELECT * INTO i FROM inquiry_to_quote.inquiries WHERE id=m.inquiry_id FOR UPDATE;
    SELECT * INTO m FROM inquiry_to_quote.messages WHERE id=p->>'message_id' FOR UPDATE;
    IF m.state <> 'analyzing' OR m.claim_token::text <> coalesce(p->>'claim_token','') OR m.lease_until <= now() THEN RAISE EXCEPTION 'INVALID_ANALYSIS_LEASE'; END IF;
    IF EXISTS(SELECT 1 FROM inquiry_to_quote.messages WHERE inquiry_id=i.id AND inbound_revision<m.inbound_revision AND state IN ('analyzing','failed','retry_requested')) THEN
      RAISE EXCEPTION 'ANALYSIS_ORDER_BLOCKED';
    END IF;
    v := p->'analysis'; fields := v->'fields'; evidence := v->'evidence'; intent := v->>'intent';
    IF intent IS NULL OR intent NOT IN ('new_inquiry','details','question','change','acceptance','rejection','other')
       OR jsonb_typeof(fields) IS DISTINCT FROM 'object' OR jsonb_typeof(evidence) IS DISTINCT FROM 'object'
       OR length(coalesce(v->>'summary','')) > 4000 OR length(coalesce(v->>'reply_draft','')) > 10000 THEN
      RAISE EXCEPTION 'INVALID_ANALYSIS';
    END IF;
    f := i.requirements;
    FOREACH k IN ARRAY requirement_keys LOOP
      IF fields ? k AND fields->k <> 'null'::jsonb THEN
        val := trim(fields->>k); proof := evidence->>k;
        IF val = '' OR proof IS NULL OR proof = '' OR length(proof) > 2000 OR position(proof IN m.text) = 0 THEN RAISE EXCEPTION 'UNSUPPORTED_EVIDENCE_%',upper(k); END IF;
        IF k = 'area_sqm' THEN
          IF val !~ '^[0-9]+([.][0-9]{1,2})?$' OR val::numeric <= 0 OR val::numeric > 10000 THEN RAISE EXCEPTION 'INVALID_AREA'; END IF;
          IF replace(proof,',','') !~ ('(^|[^0-9])' || replace(val,'.','[.]') || '([^0-9]|$)') THEN RAISE EXCEPTION 'UNSUPPORTED_AREA_VALUE'; END IF;
          f := jsonb_set(f,ARRAY[k],to_jsonb(val::numeric));
        ELSIF k = 'frequency_per_week' THEN
          IF val !~ '^[1-7]$' THEN RAISE EXCEPTION 'INVALID_FREQUENCY'; END IF;
          IF lower(proof) !~ ('(^|[^0-9a-z])('||val||'|'||(ARRAY['one','two','three','four','five','six','seven'])[val::integer]||')([^0-9a-z]|$)')
             AND NOT(val='1' AND lower(proof) ~ '(once|weekly)')
             AND NOT(val='2' AND lower(proof) ~ 'twice')
             AND NOT(val='7' AND lower(proof) ~ 'daily') THEN RAISE EXCEPTION 'UNSUPPORTED_FREQUENCY_VALUE'; END IF;
          f := jsonb_set(f,ARRAY[k],to_jsonb(val::integer));
        ELSIF k = 'requested_start_date' THEN
          IF val !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'INVALID_START_DATE'; END IF;
          day_requested := val::date;
          IF to_char(day_requested,'YYYY-MM-DD') <> val THEN RAISE EXCEPTION 'INVALID_START_DATE'; END IF;
          f := jsonb_set(f,ARRAY[k],to_jsonb(val));
        ELSE
          IF length(val)>500 OR position(lower(val) IN lower(proof))=0 THEN RAISE EXCEPTION 'UNSUPPORTED_TEXT_VALUE_%',upper(k); END IF;
          f := jsonb_set(f,ARRAY[k],to_jsonb(val));
        END IF;
      END IF;
    END LOOP;
    -- start_date_words holds the customer's own words when code interpreted the
    -- date or could not work one out; an explicit date clears them.
    IF (fields->'requested_start_date') IS NOT NULL AND fields->'requested_start_date' <> 'null'::jsonb OR coalesce(v->>'start_date_words','') <> '' THEN
      words := nullif(btrim(coalesce(v->>'start_date_words','')),'');
      IF words IS NOT NULL AND (length(words) > 300 OR position(words IN m.text) = 0) THEN RAISE EXCEPTION 'UNSUPPORTED_START_DATE_WORDS'; END IF;
      IF words IS NULL THEN f := f - 'start_date_words'; ELSE f := jsonb_set(f,'{start_date_words}',to_jsonb(words)); END IF;
      IF (fields->'requested_start_date') IS NULL OR fields->'requested_start_date' = 'null'::jsonb THEN f := f - 'requested_start_date'; END IF;
    END IF;
    details_changed := f IS DISTINCT FROM i.requirements;
    price_changed := inquiry_to_quote.price_scope(f) IS DISTINCT FROM inquiry_to_quote.price_scope(i.requirements);
    UPDATE inquiry_to_quote.quotes SET state='superseded'
      WHERE inquiry_id=i.id AND (state='prepared' AND details_changed OR state='sent' AND price_changed);
    UPDATE inquiry_to_quote.messages SET state='analyzed',analysis=v,lease_until=NULL,error=NULL,
      input_tokens=greatest(0,coalesce((p#>>'{usage,input_tokens}')::integer,0)),output_tokens=greatest(0,coalesce((p#>>'{usage,output_tokens}')::integer,0)),updated_at=now()
      WHERE id=m.id;
    SELECT * INTO q FROM inquiry_to_quote.quotes WHERE inquiry_id=i.id AND state='sent' ORDER BY sent_at DESC,created_at DESC LIMIT 1;
    val := CASE
      WHEN i.closed_at IS NOT NULL THEN 'manual_review'
      WHEN intent='other' THEN 'manual_review'
      WHEN intent='change' AND NOT details_changed THEN 'manual_review'
      WHEN intent='acceptance' AND q.id IS NOT NULL AND q.valid_until>now() AND inquiry_to_quote.price_scope(q.scope)=inquiry_to_quote.price_scope(f) THEN 'acceptance_review'
      WHEN intent='acceptance' THEN 'manual_review'
      WHEN intent='rejection' THEN 'rejection_review'
      ELSE 'ready' END;
    IF EXISTS(SELECT 1 FROM inquiry_to_quote.messages WHERE inquiry_id=i.id AND state IN ('analyzing','failed','retry_requested')) THEN val := 'analysis_pending'; END IF;
    UPDATE inquiry_to_quote.inquiries SET requirements=f,analyzed_revision=m.inbound_revision,last_intent=intent,last_summary=coalesce(v->>'summary',''),
      last_reply_draft=coalesce(v->>'reply_draft',''),status=val,updated_at=now(),next_action_at=now()+interval '1 day'
      WHERE id=i.id RETURNING * INTO i;
    INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,'analyzed',jsonb_build_object('message_id',m.id,'intent',intent,'details_changed',details_changed,'input_tokens',p#>'{usage,input_tokens}','output_tokens',p#>'{usage,output_tokens}'));
    IF val IN ('acceptance_review','rejection_review','manual_review') THEN
      INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,val,jsonb_build_object('message_id',m.id));
    END IF;
    RETURN jsonb_build_object('ok',true,'inquiry',to_jsonb(i));

  ELSIF a = 'fail_analysis' THEN
    SELECT * INTO m FROM inquiry_to_quote.messages WHERE id=p->>'message_id';
    IF NOT FOUND THEN RAISE EXCEPTION 'MESSAGE_NOT_FOUND'; END IF;
    SELECT * INTO i FROM inquiry_to_quote.inquiries WHERE id=m.inquiry_id FOR UPDATE;
    UPDATE inquiry_to_quote.messages SET state='failed',lease_until=NULL,error=left(coalesce(p->>'error','ANALYSIS_FAILED'),2000),updated_at=now()
      WHERE id=m.id AND state='analyzing' AND claim_token::text=coalesce(p->>'claim_token','') RETURNING * INTO m;
    IF NOT FOUND THEN RAISE EXCEPTION 'INVALID_ANALYSIS_LEASE'; END IF;
    UPDATE inquiry_to_quote.inquiries SET status='analysis_failed',updated_at=now() WHERE id=i.id;
    INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,'analysis_failed',jsonb_build_object('message_id',m.id,'error',m.error));
    RETURN jsonb_build_object('ok',true,'message_id',m.id,'state','failed');

  ELSIF a = 'retry_analysis' THEN
    SELECT * INTO m FROM inquiry_to_quote.messages WHERE id=p->>'message_id';
    IF NOT FOUND THEN RAISE EXCEPTION 'MESSAGE_NOT_FOUND'; END IF;
    SELECT * INTO i FROM inquiry_to_quote.inquiries WHERE id=m.inquiry_id FOR UPDATE;
    UPDATE inquiry_to_quote.messages SET state='retry_requested',claim_token=NULL,lease_until=NULL,updated_at=now()
      WHERE id=m.id AND state='failed' AND attempts<3 RETURNING * INTO m;
    IF NOT FOUND THEN RAISE EXCEPTION 'RETRY_UNAVAILABLE_OR_LIMIT_REACHED'; END IF;
    UPDATE inquiry_to_quote.inquiries SET status='analysis_pending',updated_at=now() WHERE id=i.id;
    INSERT INTO inquiry_to_quote.events(inquiry_id,action,actor,detail) VALUES(i.id,'analysis_retry_requested',actor,jsonb_build_object('message_id',m.id));
    RETURN jsonb_build_object('ok',true,'queued',true,'process',false,'message_id',m.id);

  ELSIF a = 'claim_analysis' THEN
    SELECT ii.* INTO i FROM inquiry_to_quote.inquiries ii WHERE EXISTS(
      SELECT 1 FROM inquiry_to_quote.messages mm WHERE mm.inquiry_id=ii.id AND mm.state='retry_requested' AND mm.attempts<3
       AND NOT EXISTS(SELECT 1 FROM inquiry_to_quote.messages older WHERE older.inquiry_id=ii.id AND older.inbound_revision<mm.inbound_revision AND older.state IN ('analyzing','failed','retry_requested')))
      ORDER BY ii.created_at FOR UPDATE OF ii SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'process',false); END IF;
    SELECT * INTO m FROM inquiry_to_quote.messages WHERE inquiry_id=i.id AND state='retry_requested' ORDER BY inbound_revision FOR UPDATE LIMIT 1;
    token := gen_random_uuid();
    UPDATE inquiry_to_quote.messages SET state='analyzing',claim_token=token,lease_until=now()+interval '15 minutes',attempts=attempts+1,updated_at=now() WHERE id=m.id RETURNING * INTO m;
    RETURN jsonb_build_object('ok',true,'process',true,'message',jsonb_build_object('id',m.id,'thread_id',m.thread_id,'from_email',m.from_email,'subject',m.subject,'text',m.text,'received_at',m.received_at),'inquiry',to_jsonb(i),'claim_token',token);

  ELSIF a = 'revise' THEN
    SELECT * INTO i FROM inquiry_to_quote.inquiries WHERE id=(p->>'inquiry_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INQUIRY_NOT_FOUND'; END IF;
    IF (p->>'revision')::integer IS DISTINCT FROM i.revision THEN RAISE EXCEPTION 'STALE_INQUIRY_REVISION'; END IF;
    IF i.closed_at IS NOT NULL THEN RAISE EXCEPTION 'INQUIRY_CLOSED'; END IF;
    -- A staff correction may resolve failed extraction only after an explicit
    -- acknowledgement. Active leases and queued work must finish first.
    IF EXISTS(SELECT 1 FROM inquiry_to_quote.messages WHERE inquiry_id=i.id AND state IN ('analyzing','retry_requested'))
       OR (EXISTS(SELECT 1 FROM inquiry_to_quote.messages WHERE inquiry_id=i.id AND state='failed')
           AND (p->'resolve_failed') IS DISTINCT FROM 'true'::jsonb) THEN RAISE EXCEPTION 'UNPROCESSED_INBOUND'; END IF;
    IF EXISTS(SELECT 1 FROM inquiry_to_quote.drafts WHERE inquiry_id=i.id AND state IN ('sending','uncertain')) THEN RAISE EXCEPTION 'UNRESOLVED_DELIVERY'; END IF;
    fields:=p->'requirements'; f:='{}'::jsonb;
    IF fields IS NULL OR jsonb_typeof(fields)<>'object' OR length(coalesce(p->>'reply_draft',''))>10000 THEN RAISE EXCEPTION 'INVALID_REQUIREMENTS'; END IF;
    FOREACH k IN ARRAY requirement_keys LOOP
      IF NOT fields ? k THEN RAISE EXCEPTION 'ALL_REQUIREMENT_KEYS_REQUIRED'; END IF;
      val:=nullif(trim(fields->>k),'');
      IF val IS NOT NULL THEN
        IF k='area_sqm' THEN
          IF val !~ '^[0-9]+([.][0-9]{1,2})?$' OR val::numeric<=0 OR val::numeric>10000 THEN RAISE EXCEPTION 'INVALID_AREA'; END IF;
          f:=jsonb_set(f,ARRAY[k],to_jsonb(val::numeric));
        ELSIF k='frequency_per_week' THEN
          IF val !~ '^[1-7]$' THEN RAISE EXCEPTION 'INVALID_FREQUENCY'; END IF;
          f:=jsonb_set(f,ARRAY[k],to_jsonb(val::integer));
        ELSIF k='requested_start_date' THEN
          IF val !~ '^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'INVALID_START_DATE'; END IF;
          day_requested:=val::date;
          IF to_char(day_requested,'YYYY-MM-DD')<>val THEN RAISE EXCEPTION 'INVALID_START_DATE'; END IF;
          f:=jsonb_set(f,ARRAY[k],to_jsonb(val));
        ELSE
          IF length(val)>500 THEN RAISE EXCEPTION 'INVALID_TEXT_REQUIREMENT'; END IF;
          f:=jsonb_set(f,ARRAY[k],to_jsonb(val));
        END IF;
      END IF;
    END LOOP;
    -- Applied in the same transaction as the complete staff-supplied replacement
    -- requirements. Preserve failed attempts/error provenance; do not claim Claude
    -- successfully analyzed these records. Quarantined senders stay quarantined.
    IF (p->'resolve_failed') = 'true'::jsonb THEN
      FOR m IN UPDATE inquiry_to_quote.messages SET state='analyzed',claim_token=NULL,lease_until=NULL,
        analysis=jsonb_build_object('method','staff_manual_resolution','reviewer',actor,'resolved_at',now(),'previous_error',error),
        updated_at=now() WHERE inquiry_id=i.id AND state='failed' RETURNING * LOOP
        INSERT INTO inquiry_to_quote.events(inquiry_id,action,actor,detail)
          VALUES(i.id,'analysis_manually_resolved',actor,jsonb_build_object('message_id',m.id,'attempts',m.attempts,'previous_error',m.error,'source_revision',m.inbound_revision));
      END LOOP;
    END IF;
    UPDATE inquiry_to_quote.drafts SET state='stale',approval_token=gen_random_uuid(),updated_at=now(),last_error='STAFF_REVISED' WHERE inquiry_id=i.id AND state IN ('pending','approved','expired','rejected');
    UPDATE inquiry_to_quote.quotes SET state='superseded' WHERE inquiry_id=i.id AND state IN ('sent','prepared');
    UPDATE inquiry_to_quote.inquiries SET revision=revision+1,analyzed_revision=revision+1,requirements=f,last_reply_draft=coalesce(p->>'reply_draft',''),last_intent='details',status='ready',updated_at=now(),next_action_at=now()+interval '1 day'
      WHERE id=i.id RETURNING * INTO i;
    INSERT INTO inquiry_to_quote.events(inquiry_id,action,actor,detail) VALUES(i.id,'staff_revised',actor,jsonb_build_object('revision',i.revision,'requirements',f));
    RETURN jsonb_build_object('ok',true,'inquiry',to_jsonb(i));

  ELSIF a = 'prepare' THEN
    SELECT * INTO r FROM inquiry_to_quote.rate_cards WHERE active;
    IF NOT FOUND THEN RAISE EXCEPTION 'NO_ACTIVE_RATE_CARD'; END IF;
    -- The business name signs every customer email. It comes from the build
    -- configuration, never from customer or model text.
    business := coalesce(nullif(btrim(p->>'business_name'),''),'The office cleaning team');
    IF length(business)>120 OR business ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'INVALID_BUSINESS_NAME'; END IF;
    signoff := E'\n\nKind regards,\n'||business;
    -- Follow-up delays in minutes after a quote is sent: day 2 and day 5 unless
    -- the build configuration says otherwise. An empty list turns follow-ups off.
    IF p ? 'follow_up_after_minutes' THEN
      IF jsonb_typeof(p->'follow_up_after_minutes')<>'array' OR jsonb_array_length(p->'follow_up_after_minutes')>3 THEN RAISE EXCEPTION 'INVALID_FOLLOW_UP_DELAYS'; END IF;
      SELECT coalesce(array_agg(x.value::integer ORDER BY x.ordinality),ARRAY[]::integer[]) INTO delays FROM jsonb_array_elements_text(p->'follow_up_after_minutes') WITH ORDINALITY AS x(value,ordinality);
    ELSE
      delays := ARRAY[2880,7200];
    END IF;
    IF EXISTS(SELECT 1 FROM unnest(delays) WITH ORDINALITY AS x(minutes,n) WHERE x.minutes<1 OR x.minutes>20160 OR (x.n>1 AND x.minutes<=delays[(x.n-1)::integer])) THEN RAISE EXCEPTION 'INVALID_FOLLOW_UP_DELAYS'; END IF;
    FOR i IN SELECT ii.* FROM inquiry_to_quote.inquiries ii
      WHERE ii.status='ready' AND ii.closed_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM inquiry_to_quote.messages mm WHERE mm.inquiry_id=ii.id AND mm.state IN ('analyzing','failed','retry_requested'))
        AND NOT EXISTS(SELECT 1 FROM inquiry_to_quote.drafts dd WHERE dd.inquiry_id=ii.id AND dd.revision=ii.revision)
      ORDER BY ii.created_at FOR UPDATE OF ii SKIP LOCKED LIMIT 50 LOOP
      -- Only price details are required for a quote. Hours and a start date are
      -- asked for alongside the quote instead of holding it back.
      missing := ARRAY[]::text[];
      FOREACH k IN ARRAY price_keys LOOP
        IF coalesce(i.requirements->>k,'')='' THEN missing:=array_append(missing,CASE k
          WHEN 'location' THEN 'your office location'
          WHEN 'area_sqm' THEN 'the floor area in square metres'
          WHEN 'frequency_per_week' THEN 'how many cleaning visits you need each week' END); END IF;
      END LOOP;
      words := nullif(i.requirements->>'start_date_words','');
      day_requested := NULL;
      IF coalesce(i.requirements->>'requested_start_date','')<>'' THEN day_requested:=(i.requirements->>'requested_start_date')::date; END IF;
      IF day_requested < local_today THEN
        missing:=array_append(missing,'a new start date, because '||to_char(day_requested,'FMDay, FMDD FMMonth YYYY')||' has already passed');
      ELSIF day_requested = local_today THEN
        missing:=array_append(missing,'a start date from tomorrow onward, because today is too soon for us to arrange');
      END IF;
      schedule_missing := ARRAY[]::text[];
      IF coalesce(i.requirements->>'preferred_hours','')='' THEN schedule_missing:=array_append(schedule_missing,'your preferred cleaning hours'); END IF;
      IF day_requested IS NULL THEN schedule_missing:=array_append(schedule_missing,CASE WHEN words IS NULL THEN 'when you would like us to start' ELSE 'the exact date you would like us to start' END); END IF;
      -- One greeting and one sign-off per email. AI or staff wording is only the
      -- short opening sentence; it never replaces the fixed parts below.
      opener := 'Hello,'||E'\n\n'||CASE WHEN i.last_intent='question' AND cardinality(missing)=0 THEN 'Thanks for your question.' ELSE 'Thanks for your message.' END
        ||coalesce(' '||nullif(btrim(i.last_reply_draft),''),'');
      q := NULL;
      IF cardinality(missing)>0 THEN
        draft_kind:='clarification';
        body_text:=opener||E'\n\nTo prepare your quote, could you tell us:\n- '||array_to_string(missing,E'\n- ')
          ||CASE WHEN cardinality(schedule_missing)>0 THEN E'\n\nIf you already know '||CASE WHEN cardinality(schedule_missing)=1 THEN 'it' ELSE 'them' END||', please also share '||array_to_string(schedule_missing,' and ')||'.' ELSE '' END
          ||CASE WHEN day_requested > local_today THEN E'\n\nWe will confirm availability for your start date before booking anything.' ELSE '' END
          ||signoff;
      ELSIF i.last_intent='question' THEN
        draft_kind:='question';
        body_text:=opener||E'\n\nWe will check the details and get back to you shortly.'||signoff;
      ELSE
        draft_kind:='quote';
        -- A still-valid sent quote for the same price details keeps its price,
        -- rate card and expiry; only the schedule details are refreshed.
        SELECT * INTO prior FROM inquiry_to_quote.quotes WHERE inquiry_id=i.id AND state='sent' AND valid_until>now() ORDER BY sent_at DESC,created_at DESC LIMIT 1;
        updated_quote := FOUND AND inquiry_to_quote.price_scope(prior.scope)=inquiry_to_quote.price_scope(i.requirements);
        IF updated_quote THEN
          visit_amount:=prior.visit_centavos; weekly_amount:=prior.weekly_centavos; quote_rate:=prior.rate_version; quote_valid:=prior.valid_until;
          SELECT demonstration_only INTO quote_demo FROM inquiry_to_quote.rate_cards WHERE version=prior.rate_version;
        ELSE
          visit_amount:=greatest(r.minimum_visit_centavos,round((i.requirements->>'area_sqm')::numeric*r.centavos_per_sqm)::bigint);
          weekly_amount:=visit_amount*(i.requirements->>'frequency_per_week')::integer;
          quote_rate:=r.version; quote_demo:=r.demonstration_only;
          -- Valid to the end of the seventh Manila calendar day, so the date in the
          -- email is the whole last day the customer can accept.
          quote_valid:=((local_today+8)::timestamp AT TIME ZONE 'Asia/Manila');
        END IF;
        INSERT INTO inquiry_to_quote.quotes(inquiry_id,revision,rate_version,scope,visit_centavos,weekly_centavos,valid_until)
          VALUES(i.id,i.revision,quote_rate,i.requirements,visit_amount,weekly_amount,quote_valid) RETURNING * INTO q;
        start_text := CASE
          WHEN day_requested IS NOT NULL AND words IS NOT NULL THEN to_char(day_requested,'FMDay, FMDD FMMonth YYYY')||' (you said "'||words||'")'
          WHEN day_requested IS NOT NULL THEN to_char(day_requested,'FMDay, FMDD FMMonth YYYY')
          WHEN words IS NOT NULL THEN 'to confirm (you said "'||words||'")'
          ELSE 'to confirm' END;
        body_text:=opener||E'\n\n'||CASE WHEN updated_quote THEN 'Here is your updated quote with the details you sent. The price has not changed.' ELSE 'Here is your quote for recurring office cleaning:' END
          ||E'\n\nLocation: '||(i.requirements->>'location')
          ||E'\nFloor area: '||rtrim(to_char((i.requirements->>'area_sqm')::numeric,'FM999,999,990.99'),'.')||' sqm'
          ||E'\nVisits per week: '||(i.requirements->>'frequency_per_week')
          ||E'\nPreferred hours: '||coalesce(nullif(i.requirements->>'preferred_hours',''),'to confirm')
          ||E'\nStart date: '||start_text
          ||E'\n\nPrice per visit: PHP '||to_char(visit_amount::numeric/100,'FM999,999,990.00')
          ||E'\nWeekly total: PHP '||to_char(weekly_amount::numeric/100,'FM999,999,990.00')
          ||' (about PHP '||to_char(round(weekly_amount::numeric*52/1200),'FM999,999,990')||' per month)'
          ||E'\n\nThis price is valid until '||to_char((q.valid_until AT TIME ZONE 'Asia/Manila')-interval '1 second','FMDay, FMDD FMMonth YYYY')||'. It covers standard recurring office cleaning. Taxes, special cleaning, supplies and building access are agreed separately.'
          ||CASE WHEN cardinality(schedule_missing)>0 THEN E'\n\nCould you also tell us '||array_to_string(schedule_missing,' and ')||'? The price above stays the same.' ELSE '' END
          ||CASE WHEN day_requested IS NOT NULL AND words IS NOT NULL THEN E'\n\nIf we read your start date wrong, just reply with the right one.' ELSE '' END
          ||E'\n\nTo go ahead, just reply to this email. We will confirm availability and the schedule with you before the first visit.'
          ||signoff
          ||CASE WHEN quote_demo IS NOT FALSE THEN E'\n\nNote: this quote uses sample pricing for a demonstration and is not a binding offer.' ELSE '' END;
        -- Monetary amounts and canonical scope above are generated only here;
        -- a human approves the exact body before anything is sent.
      END IF;
      INSERT INTO inquiry_to_quote.drafts(inquiry_id,revision,kind,recipient,subject,body,quote_id,amount_centavos,reply_message_id,thread_id)
        VALUES(i.id,i.revision,draft_kind,i.from_email,(SELECT subject FROM inquiry_to_quote.messages WHERE id=i.last_message_id),body_text,q.id,q.visit_centavos,i.last_message_id,i.thread_id) RETURNING * INTO d;
      UPDATE inquiry_to_quote.inquiries SET status='awaiting_approval',next_action_at=now()+interval '1 day',updated_at=now() WHERE id=i.id;
      INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,'draft_prepared',jsonb_build_object('draft_id',d.id,'kind',draft_kind,'revision',i.revision,'rate_version',q.rate_version));
      draft_list:=draft_list||(
        to_jsonb(d)-'send_token'||jsonb_build_object(
          'source_revision',i.revision,
          'review_status','AWAITING_STAFF_REVIEW'
        )||CASE WHEN q.id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object(
          'rate_version',q.rate_version,
          'scope',q.scope,
          'price_per_visit_centavos',q.visit_centavos,
          'weekly_price_centavos',q.weekly_centavos,
          'quote_valid_until',q.valid_until,
          'schedule_status','UNCONFIRMED'
        ) END
      );
    END LOOP;
    -- Follow-up drafts use a fixed template (no AI) and only nudge a sent, still
    -- valid quote with no customer reply since it went out. A follow-up that did
    -- not go out (rejected, expired or replaced) ends the sequence for that quote.
    FOR i IN SELECT ii.* FROM inquiry_to_quote.inquiries ii
      WHERE ii.status='quoted' AND ii.closed_at IS NULL AND cardinality(delays)>0
        AND NOT EXISTS(SELECT 1 FROM inquiry_to_quote.messages mm WHERE mm.inquiry_id=ii.id AND mm.state IN ('analyzing','failed','retry_requested'))
      ORDER BY ii.created_at FOR UPDATE OF ii SKIP LOCKED LIMIT 50 LOOP
      SELECT * INTO q FROM inquiry_to_quote.quotes WHERE inquiry_id=i.id AND state='sent' AND valid_until>now() ORDER BY sent_at DESC,created_at DESC LIMIT 1;
      -- Any customer email or staff correction since the quote raises the revision.
      CONTINUE WHEN NOT FOUND OR q.revision<>i.revision;
      CONTINUE WHEN EXISTS(SELECT 1 FROM inquiry_to_quote.drafts WHERE quote_id=q.id AND kind='follow_up' AND state<>'sent');
      SELECT count(*) INTO sent_count FROM inquiry_to_quote.drafts WHERE quote_id=q.id AND kind='follow_up';
      CONTINUE WHEN sent_count>=cardinality(delays) OR q.sent_at+make_interval(mins=>delays[sent_count+1])>now();
      SELECT demonstration_only INTO quote_demo FROM inquiry_to_quote.rate_cards WHERE version=q.rate_version;
      body_text:='Hello,'||E'\n\n'||CASE WHEN sent_count+1<cardinality(delays) THEN 'Just following up on' ELSE 'A last quick reminder about' END
        ||' the quote we sent on '||to_char(q.sent_at AT TIME ZONE 'Asia/Manila','FMDay, FMDD FMMonth')||' for recurring office cleaning in '||(q.scope->>'location')
        ||': PHP '||to_char(q.visit_centavos::numeric/100,'FM999,999,990.00')||' per visit, '||(q.scope->>'frequency_per_week')
        ||CASE WHEN (q.scope->>'frequency_per_week')='1' THEN ' visit' ELSE ' visits' END||' per week. It is valid until '
        ||to_char((q.valid_until AT TIME ZONE 'Asia/Manila')-interval '1 second','FMDay, FMDD FMMonth YYYY')||'.'
        ||E'\n\n'||CASE WHEN sent_count+1<cardinality(delays)
          THEN 'If you have any questions or would like to change anything, just reply to this email. When you are ready to go ahead, a quick yes is all we need.'
          ELSE 'If you would like to go ahead or change anything, just reply to this email. If now is not the right time, no problem at all.' END
        ||signoff
        ||CASE WHEN quote_demo IS NOT FALSE THEN E'\n\nNote: this quote uses sample pricing for a demonstration and is not a binding offer.' ELSE '' END;
      INSERT INTO inquiry_to_quote.drafts(inquiry_id,revision,kind,follow_up_number,recipient,subject,body,quote_id,amount_centavos,reply_message_id,thread_id)
        VALUES(i.id,i.revision,'follow_up',sent_count+1,i.from_email,(SELECT subject FROM inquiry_to_quote.messages WHERE id=i.last_message_id),body_text,q.id,NULL,i.last_message_id,i.thread_id) RETURNING * INTO d;
      UPDATE inquiry_to_quote.inquiries SET status='awaiting_approval',updated_at=now() WHERE id=i.id;
      INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,'draft_prepared',jsonb_build_object('draft_id',d.id,'kind','follow_up','follow_up_number',d.follow_up_number,'quote_id',q.id));
      draft_list:=draft_list||(to_jsonb(d)-'send_token'||jsonb_build_object('source_revision',i.revision,'review_status','AWAITING_STAFF_REVIEW',
        'follow_up_total',cardinality(delays),'quote_sent_at',q.sent_at,'quote_valid_until',q.valid_until));
    END LOOP;
    RETURN jsonb_build_object('ok',true,'drafts',draft_list);

  ELSIF a = 'review' THEN
    DELETE FROM inquiry_to_quote.review_sessions WHERE expires_at<=now();
    INSERT INTO inquiry_to_quote.review_sessions DEFAULT VALUES RETURNING review_sessions.token INTO token;
    RETURN jsonb_build_object('ok',true,
      'review_token',token,
      'drafts',coalesce((SELECT jsonb_agg(to_jsonb(dd)-'send_token' ORDER BY dd.created_at DESC) FROM (SELECT * FROM inquiry_to_quote.drafts ORDER BY created_at DESC LIMIT 200) dd),'[]'::jsonb),
      'inquiries',coalesce((SELECT jsonb_agg(to_jsonb(ii)||jsonb_build_object(
         'analysis_errors',coalesce((SELECT jsonb_agg(jsonb_build_object('message_id',mm.id,'error',mm.error,'attempts',mm.attempts,'state',mm.state,'text',mm.text,'received_at',mm.received_at)) FROM inquiry_to_quote.messages mm WHERE mm.inquiry_id=ii.id AND mm.state IN ('failed','retry_requested','quarantined')),'[]'::jsonb),
         'latest_message',(SELECT jsonb_build_object('id',mm.id,'text',mm.text,'received_at',mm.received_at,'evidence',mm.analysis->'evidence') FROM inquiry_to_quote.messages mm WHERE mm.id=ii.last_message_id),
         'latest_quote',(SELECT to_jsonb(qq) FROM inquiry_to_quote.quotes qq WHERE qq.inquiry_id=ii.id AND qq.state='sent' ORDER BY qq.sent_at DESC LIMIT 1)) ORDER BY ii.updated_at DESC)
         FROM (SELECT * FROM inquiry_to_quote.inquiries ORDER BY updated_at DESC LIMIT 200) ii),'[]'::jsonb),
      'jobs',coalesce((SELECT jsonb_agg(to_jsonb(jj) ORDER BY jj.created_at DESC) FROM (SELECT * FROM inquiry_to_quote.jobs ORDER BY created_at DESC LIMIT 100) jj),'[]'::jsonb),
      'notifications',coalesce((SELECT jsonb_agg(to_jsonb(nn) ORDER BY nn.created_at DESC) FROM (SELECT * FROM inquiry_to_quote.notifications ORDER BY created_at DESC LIMIT 30) nn),'[]'::jsonb),
      'alerts',coalesce((SELECT jsonb_agg(jsonb_build_object('type','analysis_'||mm.state,'message_id',mm.id,'inquiry_id',mm.inquiry_id,'error',mm.error)) FROM inquiry_to_quote.messages mm WHERE mm.state IN ('failed','quarantined')),'[]'::jsonb)
        ||coalesce((SELECT jsonb_agg(jsonb_build_object('type',ee.action,'inquiry_id',ee.inquiry_id,'detail',ee.detail,'created_at',ee.created_at)) FROM (SELECT * FROM inquiry_to_quote.events WHERE action IN ('execution_error','overdue') ORDER BY created_at DESC LIMIT 50) ee),'[]'::jsonb)
        ||coalesce((SELECT jsonb_agg(jsonb_build_object('type','notification_uncertain','notification_id',nn.id,'error',nn.error)) FROM inquiry_to_quote.notifications nn WHERE nn.state='uncertain'),'[]'::jsonb));

  ELSIF a = 'decide' THEN
    SELECT * INTO d FROM inquiry_to_quote.drafts WHERE id=(p->>'draft_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND'; END IF;
    SELECT * INTO i FROM inquiry_to_quote.inquiries WHERE id=d.inquiry_id FOR UPDATE;
    SELECT * INTO d FROM inquiry_to_quote.drafts WHERE id=(p->>'draft_id')::uuid FOR UPDATE;
    IF d.state <> 'pending' OR d.approval_token::text <> coalesce(p->>'token','') THEN RAISE EXCEPTION 'INVALID_OR_USED_APPROVAL'; END IF;
    IF d.expires_at<=now() THEN RAISE EXCEPTION 'APPROVAL_EXPIRED'; END IF;
    IF d.revision<>i.revision OR i.closed_at IS NOT NULL THEN RAISE EXCEPTION 'STALE_QUOTE_REVISION'; END IF;
    IF EXISTS(SELECT 1 FROM inquiry_to_quote.messages WHERE inquiry_id=i.id AND state IN ('analyzing','failed','retry_requested')) THEN RAISE EXCEPTION 'UNPROCESSED_INBOUND'; END IF;
    IF p->>'decision' NOT IN ('approve','reject') OR p->>'decision' IS NULL THEN RAISE EXCEPTION 'INVALID_DECISION'; END IF;
    UPDATE inquiry_to_quote.drafts SET state=CASE WHEN p->>'decision'='approve' THEN 'approved' ELSE 'rejected' END,
      approved_by=actor,approved_at=now(),approval_token=gen_random_uuid(),updated_at=now() WHERE id=d.id RETURNING * INTO d;
    UPDATE inquiry_to_quote.inquiries SET status=CASE WHEN d.state='approved' THEN 'approved' WHEN d.kind='follow_up' THEN 'quoted' ELSE 'manual_review' END,updated_at=now() WHERE id=i.id;
    INSERT INTO inquiry_to_quote.events(inquiry_id,action,actor,detail) VALUES(i.id,'draft_'||d.state,actor,jsonb_build_object('draft_id',d.id,'revision',d.revision));
    RETURN jsonb_build_object('ok',true,'draft',to_jsonb(d)-'send_token');

  ELSIF a = 'claim_send' THEN
    SELECT ii.* INTO i FROM inquiry_to_quote.inquiries ii
      WHERE ii.closed_at IS NULL AND EXISTS(SELECT 1 FROM inquiry_to_quote.drafts dd WHERE dd.inquiry_id=ii.id AND dd.revision=ii.revision AND dd.state='approved' AND dd.expires_at>now())
      AND NOT EXISTS(SELECT 1 FROM inquiry_to_quote.messages mm WHERE mm.inquiry_id=ii.id AND mm.state IN ('analyzing','failed','retry_requested'))
      AND NOT EXISTS(SELECT 1 FROM inquiry_to_quote.drafts dd WHERE dd.inquiry_id=ii.id AND dd.state IN ('sending','uncertain'))
      ORDER BY ii.updated_at FOR UPDATE OF ii SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'sends','[]'::jsonb); END IF;
    SELECT * INTO d FROM inquiry_to_quote.drafts WHERE inquiry_id=i.id AND revision=i.revision AND state='approved' AND expires_at>now() ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('ok',true,'sends','[]'::jsonb); END IF;
    IF d.quote_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inquiry_to_quote.quotes WHERE id=d.quote_id AND valid_until>now()) THEN RAISE EXCEPTION 'QUOTE_EXPIRED'; END IF;
    IF d.kind='quote' AND (i.requirements->>'requested_start_date')::date<=local_today THEN RAISE EXCEPTION 'START_DATE_NEEDS_REVIEW'; END IF;
    token:=gen_random_uuid();
    UPDATE inquiry_to_quote.drafts SET state='sending',send_token=token,send_started_at=now(),updated_at=now() WHERE id=d.id RETURNING * INTO d;
    INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,'send_claimed',jsonb_build_object('draft_id',d.id));
    RETURN jsonb_build_object('ok',true,'sends',jsonb_build_array(to_jsonb(d)));

  ELSIF a IN ('mark_sent','send_uncertain') THEN
    SELECT * INTO d FROM inquiry_to_quote.drafts WHERE id=(p->>'draft_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND'; END IF;
    SELECT * INTO i FROM inquiry_to_quote.inquiries WHERE id=d.inquiry_id FOR UPDATE;
    SELECT * INTO d FROM inquiry_to_quote.drafts WHERE id=(p->>'draft_id')::uuid FOR UPDATE;
    IF a='mark_sent' AND d.state='sent' AND d.send_token::text=coalesce(p->>'send_token','') AND d.provider_message_id=p->>'provider_message_id' THEN
      RETURN jsonb_build_object('ok',true,'duplicate',true,'draft_id',d.id,'state','sent');
    END IF;
    IF d.state NOT IN ('sending','uncertain') OR d.send_token::text<>coalesce(p->>'send_token','') THEN RAISE EXCEPTION 'INVALID_SEND_LEASE'; END IF;
    IF a='send_uncertain' THEN
      UPDATE inquiry_to_quote.drafts SET state='uncertain',last_error=left(coalesce(p->>'error','DELIVERY_UNCERTAIN'),2000),updated_at=now() WHERE id=d.id;
      UPDATE inquiry_to_quote.inquiries SET status=CASE WHEN revision=d.revision THEN 'delivery_uncertain' ELSE status END,updated_at=now() WHERE id=i.id;
      INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,'send_uncertain',jsonb_build_object('draft_id',d.id));
      RETURN jsonb_build_object('ok',true,'draft_id',d.id,'state','uncertain');
    END IF;
    IF coalesce(p->>'provider_message_id','')='' THEN RAISE EXCEPTION 'PROVIDER_MESSAGE_ID_REQUIRED'; END IF;
    UPDATE inquiry_to_quote.drafts SET state='sent',provider_message_id=p->>'provider_message_id',sent_at=now(),last_error=NULL,updated_at=now() WHERE id=d.id;
    -- One current sent quote per inquiry: a newly sent quote retires the older one.
    UPDATE inquiry_to_quote.quotes SET state='superseded' WHERE inquiry_id=i.id AND state='sent' AND d.kind='quote' AND id<>d.quote_id;
    UPDATE inquiry_to_quote.quotes SET state='sent',sent_at=now() WHERE id=d.quote_id AND d.kind='quote';
    UPDATE inquiry_to_quote.inquiries SET status=CASE WHEN revision=d.revision THEN CASE WHEN d.kind IN ('quote','follow_up') THEN 'quoted' ELSE 'awaiting_customer' END ELSE status END,next_action_at=now()+interval '2 days',updated_at=now() WHERE id=i.id;
    INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,'sent',jsonb_build_object('draft_id',d.id,'provider_message_id',p->>'provider_message_id','revision',d.revision));
    RETURN jsonb_build_object('ok',true,'draft_id',d.id,'state','sent');

  ELSIF a = 'reconcile' THEN
    SELECT * INTO d FROM inquiry_to_quote.drafts WHERE id=(p->>'draft_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'DRAFT_NOT_FOUND'; END IF;
    SELECT * INTO i FROM inquiry_to_quote.inquiries WHERE id=d.inquiry_id FOR UPDATE;
    SELECT * INTO d FROM inquiry_to_quote.drafts WHERE id=(p->>'draft_id')::uuid FOR UPDATE;
    IF d.state<>'uncertain' THEN RAISE EXCEPTION 'NOT_UNCERTAIN'; END IF;
    IF p ? 'token' AND d.approval_token::text<>coalesce(p->>'token','') THEN RAISE EXCEPTION 'INVALID_RECONCILE_TOKEN'; END IF;
    val:=coalesce(p->>'decision',p->>'outcome');
    IF val='confirmed_sent' THEN
      IF coalesce(p->>'provider_message_id','')='' THEN RAISE EXCEPTION 'PROVIDER_MESSAGE_ID_REQUIRED'; END IF;
      UPDATE inquiry_to_quote.drafts SET state='sent',provider_message_id=p->>'provider_message_id',sent_at=now(),last_error=NULL,approval_token=gen_random_uuid(),updated_at=now() WHERE id=d.id;
      UPDATE inquiry_to_quote.quotes SET state='superseded' WHERE inquiry_id=i.id AND state='sent' AND d.kind='quote' AND id<>d.quote_id;
      UPDATE inquiry_to_quote.quotes SET state='sent',sent_at=now() WHERE id=d.quote_id AND d.kind='quote';
      UPDATE inquiry_to_quote.inquiries SET status=CASE WHEN revision=d.revision THEN CASE WHEN d.kind IN ('quote','follow_up') THEN 'quoted' ELSE 'awaiting_customer' END ELSE status END,next_action_at=now()+interval '2 days',updated_at=now() WHERE id=i.id;
    ELSIF val='confirmed_not_sent' THEN
      UPDATE inquiry_to_quote.drafts SET state=CASE WHEN d.revision=i.revision AND i.closed_at IS NULL THEN 'pending' ELSE 'stale' END,
        approval_token=gen_random_uuid(),expires_at=now()+interval '24 hours',approved_by=NULL,approved_at=NULL,send_token=NULL,send_started_at=NULL,last_error='Confirmed not sent; fresh approval required.',updated_at=now() WHERE id=d.id;
      UPDATE inquiry_to_quote.inquiries SET status=CASE WHEN revision=d.revision AND closed_at IS NULL THEN 'awaiting_approval' ELSE status END,updated_at=now() WHERE id=i.id;
    ELSE RAISE EXCEPTION 'INVALID_RECONCILIATION'; END IF;
    INSERT INTO inquiry_to_quote.events(inquiry_id,action,actor,detail) VALUES(i.id,'reconciled',actor,jsonb_build_object('draft_id',d.id,'decision',val,'provider_message_id',p->>'provider_message_id'));
    RETURN jsonb_build_object('ok',true,'draft_id',d.id,'decision',val);

  ELSIF a IN ('confirm_acceptance','close_lost') THEN
    SELECT * INTO i FROM inquiry_to_quote.inquiries WHERE id=(p->>'inquiry_id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'INQUIRY_NOT_FOUND'; END IF;
    IF (p->>'revision')::integer IS DISTINCT FROM i.revision THEN RAISE EXCEPTION 'STALE_INQUIRY_REVISION'; END IF;
    IF EXISTS(SELECT 1 FROM inquiry_to_quote.messages WHERE inquiry_id=i.id AND state IN ('analyzing','failed','retry_requested')) THEN RAISE EXCEPTION 'UNPROCESSED_INBOUND'; END IF;
    IF a='close_lost' THEN
      IF i.status<>'rejection_review' OR i.closed_at IS NOT NULL THEN RAISE EXCEPTION 'NOT_REJECTION_REVIEW'; END IF;
      UPDATE inquiry_to_quote.inquiries SET status='closed_lost',closed_at=now(),next_action_at=NULL,updated_at=now() WHERE id=i.id;
      UPDATE inquiry_to_quote.drafts SET state='stale',approval_token=gen_random_uuid(),updated_at=now() WHERE inquiry_id=i.id AND state IN ('pending','approved');
      INSERT INTO inquiry_to_quote.events(inquiry_id,action,actor) VALUES(i.id,'closed_lost',actor);
      RETURN jsonb_build_object('ok',true,'inquiry_id',i.id,'state','closed_lost');
    END IF;
    SELECT * INTO j FROM inquiry_to_quote.jobs WHERE inquiry_id=i.id;
    IF FOUND THEN RETURN jsonb_build_object('ok',true,'duplicate',true,'job',to_jsonb(j)); END IF;
    IF i.status<>'acceptance_review' OR i.closed_at IS NOT NULL THEN RAISE EXCEPTION 'NOT_ACCEPTANCE_REVIEW'; END IF;
    IF EXISTS(SELECT 1 FROM inquiry_to_quote.drafts WHERE inquiry_id=i.id AND state IN ('sending','uncertain')) THEN RAISE EXCEPTION 'UNRESOLVED_DELIVERY'; END IF;
    SELECT * INTO q FROM inquiry_to_quote.quotes WHERE inquiry_id=i.id AND state='sent' ORDER BY sent_at DESC,created_at DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND OR q.valid_until<=now() OR inquiry_to_quote.price_scope(q.scope)<>inquiry_to_quote.price_scope(i.requirements) THEN RAISE EXCEPTION 'NO_MATCHING_VALID_SENT_QUOTE'; END IF;
    -- The price comes from the sent quote; hours and start date may have arrived
    -- with the acceptance, so the brief carries the latest schedule details.
    words := nullif(i.requirements->>'start_date_words','');
    INSERT INTO inquiry_to_quote.jobs(inquiry_id,quote_id,confirmed_by,brief) VALUES(i.id,q.id,actor,
      jsonb_build_object('service','Recurring office cleaning','customer_email',i.from_email,'scope',i.requirements,'quoted_scope',q.scope,'currency',q.currency,
       'price_per_visit_centavos',q.visit_centavos,'weekly_price_centavos',q.weekly_centavos,'rate_version',q.rate_version,
       'quote_id',q.id,'acceptance_message_id',i.last_message_id,'schedule_status','UNCONFIRMED',
       'outstanding_requirements',jsonb_build_array('Staff must confirm service area and site access.','Staff must confirm schedule and crew availability.','Review supplies, taxes, special cleaning, and commercial terms before work.','Demonstration pricing is not a binding commercial offer.')
         ||CASE WHEN coalesce(i.requirements->>'preferred_hours','')='' THEN jsonb_build_array('Agree the cleaning hours with the customer.') ELSE '[]'::jsonb END
         ||CASE WHEN coalesce(i.requirements->>'requested_start_date','')='' THEN jsonb_build_array('Agree a start date with the customer.')
                WHEN words IS NOT NULL THEN jsonb_build_array('Confirm the start date read from "'||words||'".') ELSE '[]'::jsonb END))
      RETURNING * INTO j;
    UPDATE inquiry_to_quote.inquiries SET status='handed_off',closed_at=now(),next_action_at=NULL,updated_at=now() WHERE id=i.id;
    INSERT INTO inquiry_to_quote.events(inquiry_id,action,actor,detail) VALUES(i.id,'handoff_created',actor,jsonb_build_object('job_id',j.id,'quote_id',q.id,'revision',i.revision));
    RETURN jsonb_build_object('ok',true,'job',to_jsonb(j));

  ELSIF a = 'report_error' THEN
    val:=left(regexp_replace(coalesce(p->>'message','Execution failed'),'(?i)(sk-ant-[a-z0-9_-]+|Bearer\s+[^\s]+|postgres(ql)?://[^\s]+)','[REDACTED]','g'),1000);
    INSERT INTO inquiry_to_quote.events(action,detail) VALUES('execution_error',jsonb_build_object('source',left(coalesce(p->>'source','n8n'),150),'message',val,'execution_id',left(coalesce(p->>'execution_id',''),100)));
    RETURN jsonb_build_object('ok',true);

  ELSIF a = 'claim_notifications' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('inquiry_to_quote.notifications',0));
    SELECT array_agg(ee.id) INTO event_ids FROM (
      SELECT id FROM inquiry_to_quote.events WHERE notification_id IS NULL AND action IN
      ('draft_prepared','acceptance_review','rejection_review','manual_review','handoff_created','analysis_failed','analysis_lease_expired','sender_quarantined','send_uncertain','send_lease_expired','approval_expired','overdue','execution_error')
      ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100) ee;
    IF event_ids IS NULL THEN RETURN jsonb_build_object('ok',true,'notifications','[]'::jsonb); END IF;
    SELECT string_agg(ee.action||' | inquiry '||coalesce(ee.inquiry_id::text,'system')||' | '||to_char(ee.created_at AT TIME ZONE 'Asia/Manila','YYYY-MM-DD HH24:MI'),E'\n' ORDER BY ee.id)
      INTO body_text FROM inquiry_to_quote.events ee WHERE ee.id=ANY(event_ids);
    INSERT INTO inquiry_to_quote.notifications(event_ids,subject,body) VALUES(event_ids,'Inquiry-to-Quote: staff review needed',
      'Open the private staff review portal for details and actions.'||E'\n\n'||body_text||E'\n\nThis digest is an at-most-once delivery attempt. The staff portal remains the authoritative work queue.') RETURNING * INTO notification;
    UPDATE inquiry_to_quote.events SET notification_id=notification.id WHERE id=ANY(event_ids);
    RETURN jsonb_build_object('ok',true,'notifications',jsonb_build_array(to_jsonb(notification)));

  ELSIF a = 'notification_result' THEN
    SELECT * INTO notification FROM inquiry_to_quote.notifications WHERE id=(p->>'id')::uuid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NOTIFICATION_NOT_FOUND'; END IF;
    IF notification.state='sent' THEN RETURN jsonb_build_object('ok',true,'duplicate',true); END IF;
    IF coalesce(p->>'provider_message_id','')<>'' THEN
      UPDATE inquiry_to_quote.notifications SET state='sent',provider_message_id=p->>'provider_message_id',error=NULL,updated_at=now() WHERE id=notification.id;
    ELSE
      UPDATE inquiry_to_quote.notifications SET state='uncertain',error=left(coalesce(p->>'error','NOTIFICATION_DELIVERY_UNCERTAIN'),1000),updated_at=now() WHERE id=notification.id;
    END IF;
    RETURN jsonb_build_object('ok',true);

  ELSIF a = 'maintenance' THEN
    UPDATE inquiry_to_quote.notifications SET state='uncertain',error='NOTIFICATION_ATTEMPT_EXPIRED: inspect staff mailbox; no automatic resend.',updated_at=now()
      WHERE state='attempting' AND created_at<now()-interval '15 minutes';
    -- Consistent lock order: inquiry, then its messages/drafts. No outbound work.
    FOR i IN SELECT * FROM inquiry_to_quote.inquiries ORDER BY created_at FOR UPDATE SKIP LOCKED LOOP
      FOR m IN UPDATE inquiry_to_quote.messages SET state='failed',lease_until=NULL,error='ANALYSIS_LEASE_EXPIRED',updated_at=now()
        WHERE inquiry_id=i.id AND state='analyzing' AND lease_until<=now() RETURNING * LOOP
        UPDATE inquiry_to_quote.inquiries SET status='analysis_failed',updated_at=now() WHERE id=i.id;
        alerts:=alerts||jsonb_build_object('type','analysis_failed','inquiry_id',i.id,'message_id',m.id,'error',m.error);
        INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,'analysis_lease_expired',jsonb_build_object('message_id',m.id));
      END LOOP;
      FOR d IN UPDATE inquiry_to_quote.drafts SET state='uncertain',last_error='SEND_LEASE_EXPIRED: inspect Gmail Sent before reconciliation.',updated_at=now()
        WHERE inquiry_id=i.id AND state='sending' AND send_started_at<=now()-interval '15 minutes' RETURNING * LOOP
        alerts:=alerts||jsonb_build_object('type','delivery_uncertain','inquiry_id',i.id,'draft_id',d.id);
        INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,'send_lease_expired',jsonb_build_object('draft_id',d.id));
      END LOOP;
      FOR d IN UPDATE inquiry_to_quote.drafts SET state='expired',approval_token=gen_random_uuid(),last_error='APPROVAL_EXPIRED',updated_at=now()
        WHERE inquiry_id=i.id AND state IN ('pending','approved') AND expires_at<=now() RETURNING * LOOP
        UPDATE inquiry_to_quote.inquiries SET status=CASE WHEN revision=d.revision AND d.kind='follow_up' THEN 'quoted' WHEN revision=d.revision THEN 'manual_review' ELSE status END,updated_at=now() WHERE id=i.id;
        alerts:=alerts||jsonb_build_object('type','approval_expired','inquiry_id',i.id,'draft_id',d.id);
        INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,'approval_expired',jsonb_build_object('draft_id',d.id));
      END LOOP;
      IF i.closed_at IS NULL AND i.next_action_at<=now() THEN
        alerts:=alerts||jsonb_build_object('type','overdue','inquiry_id',i.id,'status',i.status,'next_action_at',i.next_action_at);
        IF NOT EXISTS(SELECT 1 FROM inquiry_to_quote.events WHERE inquiry_id=i.id AND action='overdue' AND created_at>now()-interval '1 day') THEN
          INSERT INTO inquiry_to_quote.events(inquiry_id,action,detail) VALUES(i.id,'overdue',jsonb_build_object('status',i.status,'next_action_at',i.next_action_at));
        END IF;
      END IF;
    END LOOP;
    RETURN jsonb_build_object('ok',true,'alerts',alerts);
  ELSE
    RAISE EXCEPTION 'UNKNOWN_ACTION';
  END IF;
EXCEPTION
  WHEN SQLSTATE 'P0001' THEN RETURN jsonb_build_object('ok',false,'error',SQLERRM);
  WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range OR not_null_violation OR check_violation THEN
    RETURN jsonb_build_object('ok',false,'error','INVALID_REQUEST_VALUE');
  WHEN unique_violation THEN RETURN jsonb_build_object('ok',false,'error','DUPLICATE_CONFLICT');
END;
$$;
REVOKE ALL ON FUNCTION inquiry_to_quote.api(jsonb) FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA inquiry_to_quote REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA inquiry_to_quote REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA inquiry_to_quote REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
COMMIT;
