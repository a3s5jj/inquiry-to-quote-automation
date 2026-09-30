import { PGlite } from '@electric-sql/pglite';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {normalizeGmail,parseClaudeResponse,renderReview} from '../src/core.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(readFileSync(resolve(root,'config/settings.json'),'utf8'));
const db=await PGlite.create();await db.exec(readFileSync(resolve(root,'db/001_schema.sql'),'utf8'));
const api=async request=>{
 const r=(await db.query('SELECT inquiry_to_quote.api($1::jsonb) AS result',[JSON.stringify(request)])).rows[0].result;
 assert.equal(r.ok,true,JSON.stringify(r));return r;
};
const dates=new Date(Date.now()+30*86400000).toISOString().slice(0,10);
const fields={location:'BGC',area_sqm:200,frequency_per_week:3,preferred_hours:'6pm to 9pm',requested_start_date:dates};
const proof={location:'BGC',area_sqm:'200 sqm',frequency_per_week:'three times a week',preferred_hours:'6pm to 9pm',requested_start_date:dates};
const nulls=()=>Object.fromEntries(Object.keys(fields).map(k=>[k,null]));
const trace=[];
async function receive(id,thread,text,intent,values,evidence){
 const message=normalizeGmail({id,threadId:thread,from:'facilities@example.test',subject:'Recurring office cleaning',date:new Date().toISOString(),text});
 const context=await api({action:'ingest',message});
 const result=parseClaudeResponse({stop_reason:'tool_use',content:[{type:'tool_use',name:'analyze_inquiry',input:{intent,fields:values,evidence,summary:'Synthetic recurring cleaning request.',reply_draft:intent==='new_inquiry'?'You would like your office cleaned on a regular schedule.':''}}],usage:{input_tokens:100,output_tokens:60}},context);
 await api({action:'analyze',message_id:message.id,claim_token:context.claim_token,...result});
 trace.push({step:'receive_and_analyze',message_id:id,intent,claude:'SIMULATED'});return context;
}
function savePage(filename,data){
 let html=renderReview(data,{actionUrl:'https://offline-demo.example.invalid/action',refreshUrl:'https://offline-demo.example.invalid/',followUpTotal:config.followUpAfterMinutes.length});
 html=html.replace('<main>','<main><div class="card warn"><strong>OFFLINE DEMONSTRATION: synthetic data only.</strong> Claude and Gmail responses were simulated. Forms are disabled in this saved preview.</div>').replaceAll('<button','<button disabled');
 writeFileSync(resolve(root,'evidence',filename),html);
}
try{
 const initial=await receive('demo-message-1','demo-thread-1',`Hello, please quote our office in BGC: 200 sqm, three times a week, 6pm to 9pm, starting ${dates}.`,'new_inquiry',fields,proof);
 await api({action:'prepare',business_name:config.businessName});
 const partial={...nulls(),location:'Makati'},partialProof={...nulls(),location:'Makati'};
 await receive('demo-message-2','demo-thread-2','Can you clean our office in Makati?','new_inquiry',partial,partialProof);
 const quick={...nulls(),location:'Quezon City',area_sqm:120,frequency_per_week:2,requested_start_date:'next Monday'};
 const quickProof={...nulls(),location:'Quezon City',area_sqm:'120 sqm',frequency_per_week:'twice a week',requested_start_date:'start next Monday'};
 const fast=await receive('demo-message-4','demo-thread-3','Please quote our 120 sqm office in Quezon City, twice a week. We would like to start next Monday.','new_inquiry',quick,quickProof);
 await api({action:'prepare',business_name:config.businessName});
 let review=await api({action:'review'});savePage('demo-review.html',review);
 const fastDraft=review.drafts.find(d=>d.inquiry_id===fast.inquiry.id);
 assert.equal(fastDraft.kind,'quote');assert.match(fastDraft.body,/Preferred hours: to confirm/);assert.match(fastDraft.body,/\(you said "next Monday"\)/);
 trace.push({step:'quote_without_hours_and_casual_start_date',start_date_words:'next Monday',preferred_hours:'to confirm'});
 const draft=review.drafts.find(d=>d.inquiry_id===initial.inquiry.id);
 assert.equal(Number(draft.amount_centavos),240000);
 await api({action:'decide',draft_id:draft.id,token:draft.approval_token,decision:'approve',reviewer:'demo-staff'});
 const claimed=(await api({action:'claim_send'})).sends[0];assert.ok(claimed);
 await api({action:'mark_sent',draft_id:claimed.id,send_token:claimed.send_token,provider_message_id:'synthetic-gmail-message-1'});
 trace.push({step:'quote_approved_and_delivery_confirmed',gmail:'SIMULATED',price_per_visit_php:2400,weekly_php:7200});
 await receive('demo-message-3','demo-thread-1','I accept the latest quote. Please confirm the available start date.','acceptance',nulls(),nulls());
 review=await api({action:'review'});const acceptance=review.inquiries.find(i=>i.id===initial.inquiry.id);
 assert.equal(acceptance.status,'acceptance_review');assert.equal(review.jobs.length,0);
 await api({action:'confirm_acceptance',inquiry_id:acceptance.id,revision:acceptance.revision,review_token:review.review_token,reviewer:'demo-staff'});
 review=await api({action:'review'});assert.equal(review.jobs.length,1);assert.equal(review.jobs[0].schedule_status,'UNCONFIRMED');
 // The quick quote goes out, the customer stays quiet, and day 2 brings a follow-up draft.
 await api({action:'decide',draft_id:fastDraft.id,token:fastDraft.approval_token,decision:'approve',reviewer:'demo-staff'});
 const fastSend=(await api({action:'claim_send'})).sends[0];assert.equal(fastSend.id,fastDraft.id);
 await api({action:'mark_sent',draft_id:fastSend.id,send_token:fastSend.send_token,provider_message_id:'synthetic-gmail-message-2'});
 await db.query("UPDATE inquiry_to_quote.quotes SET sent_at=now()-interval '49 hours' WHERE id=$1",[fastDraft.quote_id]);
 const nudge=(await api({action:'prepare',business_name:config.businessName,follow_up_after_minutes:config.followUpAfterMinutes})).drafts.find(d=>d.kind==='follow_up');
 assert.ok(nudge);assert.equal(nudge.follow_up_number,1);
 trace.push({step:'follow_up_draft_after_two_quiet_days',follow_up:'1 of '+config.followUpAfterMinutes.length,claude:'NOT_USED'});
 review=await api({action:'review'});
 savePage('demo-handoff.html',review);
 trace.push({step:'staff_confirmed_acceptance',jobs:1,schedule_status:'UNCONFIRMED'});
 writeFileSync(resolve(root,'evidence/demo-result.json'),JSON.stringify({status:'OFFLINE_VERIFIED',external_integrations:'NOT_LIVE_TESTED',synthetic:true,generated_at:new Date().toISOString(),trace,job_brief:review.jobs[0].brief},null,2)+'\n');
 console.log('PASS: inquiry, clarification, quote without hours from a casual start date, exact quote approval, simulated delivery, acceptance, one operations handoff and a day-2 follow-up draft. Static previews saved to evidence/.');
}finally{await db.close();}
