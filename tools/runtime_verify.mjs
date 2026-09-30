// Real local n8n + Postgres-node verification. External Gmail/Claude endpoints are
// replaced with loopback fixtures. Never run against a live account.
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const runtime=resolve(root,'.runtime','verification-'+Date.now());mkdirSync(runtime,{recursive:true});
const cli=process.env.N8N_CLI_PATH||resolve(process.env.APPDATA||'', 'npm/node_modules/n8n/bin/n8n');
const env={...process.env,N8N_USER_FOLDER:runtime,N8N_PORT:'5890',N8N_RUNNERS_BROKER_PORT:'5891',N8N_DIAGNOSTICS_ENABLED:'false',N8N_VERSION_NOTIFICATIONS_ENABLED:'false',N8N_TEMPLATES_ENABLED:'false',N8N_PERSONALIZATION_ENABLED:'false',N8N_ENCRYPTION_KEY:'synthetic-offline-runtime-key-not-a-secret',N8N_LOG_LEVEL:'warn',N8N_RUNNERS_ENABLED:'true',N8N_RUNNERS_MAX_CONCURRENCY:'1',N8N_BLOCK_ENV_ACCESS_IN_NODE:'true',N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS:'false'};
const logs=[];
const recovery=process.argv.includes('--recovery');
async function run(args,label){
 return await new Promise((res,rej)=>{
  const child=spawn(process.execPath,[cli,...args],{env,windowsHide:true,cwd:root,stdio:['ignore','pipe','pipe']});let output='';
  const append=b=>{output+=b;writeFileSync(resolve(runtime,label+'.log'),output);};
  child.stdout.on('data',append);child.stderr.on('data',append);
  const timer=setTimeout(()=>{child.kill();rej(new Error(label+' timed out'));},90000);
  child.on('error',rej);child.on('exit',code=>{clearTimeout(timer);writeFileSync(resolve(runtime,label+'.log'),output);if(code)rej(new Error(label+' failed: '+output.slice(-5000)));else res(output);});
 });
}
const db=await PGlite.create();await db.exec(readFileSync(resolve(root,'db/001_schema.sql'),'utf8'));
const api=async req=>(await db.query('SELECT inquiry_to_quote.api($1::jsonb) AS result',[JSON.stringify(req)])).rows[0].result;
// pglite-socket 0.2.11 keeps a detached handler after n8n exits with ECONNRESET.
// Give each CLI execution a fresh TCP adapter; retain the SAME database for replay.
let socket;
const startSocket=async()=>{socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:5892,debug:process.env.ITQ_SOCKET_DEBUG==='1'});await socket.start();};
let response,sendCount=0,sendFail=false,claudeCalls=0;
const server=createServer(async(req,res)=>{
 let raw='';for await(const chunk of req)raw+=chunk;
 const body=raw?JSON.parse(raw):{};
 res.setHeader('Content-Type','application/json');
 if(req.url==='/claude'){claudeCalls++;assert.equal(body.tool_choice.name,'analyze_inquiry');res.end(JSON.stringify(response));}
 else if(req.url==='/gmail'){sendCount++;if(sendFail){res.statusCode=503;res.end(JSON.stringify({error:'SIMULATED_DELIVERY_UNKNOWN'}));}else res.end(JSON.stringify({id:'synthetic-send-'+sendCount,threadId:'synthetic-thread'}));}
 else {res.statusCode=404;res.end('{}');}
});await new Promise(r=>server.listen(5893,'127.0.0.1',r));
const files=['01-gmail-intake.json','02-quote-preparation.json','03-review-and-delivery.json','04-maintenance.json'];
const originals=files.map(f=>JSON.parse(readFileSync(resolve(root,'workflows',f),'utf8')));
const creds=[{id:'itqQaPostgres',name:'Synthetic local Postgres only',type:'postgres',data:{host:'127.0.0.1',database:'postgres',user:'postgres',password:'postgres',port:5892,ssl:'disable',allowUnauthorizedCerts:false,maxConnections:1}}];
writeFileSync(resolve(runtime,'credentials.json'),JSON.stringify(creds));
let sequence=0;
async function execute(windex,entry,input,label,{enableSending=true}={}){
 const w=structuredClone(originals[windex]);w.id='ITQQA'+(++sequence);w.name='QA '+label;delete w.settings.errorWorkflow;
 const names=new Set([entry]);const queue=[entry];while(queue.length)for(const branch of w.connections[queue.shift()]?.main||[])for(const e of branch)if(!names.has(e.node)){names.add(e.node);queue.push(e.node);}
 w.nodes=w.nodes.filter(n=>names.has(n.name));w.connections=Object.fromEntries(Object.entries(w.connections).filter(([k])=>names.has(k)));
 const source=w.nodes.find(n=>n.name===entry);source.type='n8n-nodes-base.manualTrigger';source.typeVersion=1;source.parameters={};delete source.webhookId;
 const edges=w.connections[entry];const fixture={id:'fixture'+sequence,name:'Synthetic fixture',type:'n8n-nodes-base.code',typeVersion:2,position:[0,208],parameters:{mode:'runOnceForAllItems',jsCode:`return [{json:${JSON.stringify(input||{})}}];`}};
 w.nodes.push(fixture);w.connections[entry]={main:[[{node:fixture.name,type:'main',index:0}]]};w.connections[fixture.name]=edges;
 for(const n of w.nodes){
  if(n.type.endsWith('.postgres'))n.credentials={postgres:{id:'itqQaPostgres',name:'Synthetic local Postgres only'}};
  if(n.type.endsWith('.code'))n.parameters.jsCode=n.parameters.jsCode.replaceAll('"enableCustomerSending":false','"enableCustomerSending":'+enableSending).replaceAll('"enableStaffNotifications":false','"enableStaffNotifications":true').replaceAll('reviewer@example.invalid','reviewer@example.test');
  if(n.name==='Claude analyze'){n.parameters.url='http://127.0.0.1:5893/claude';n.parameters.authentication='none';delete n.parameters.genericAuthType;}
  if(n.type.endsWith('.gmail')){n.type='n8n-nodes-base.httpRequest';n.typeVersion=4.2;n.parameters={method:'POST',url:'http://127.0.0.1:5893/gmail',sendBody:true,specifyBody:'json',jsonBody:'={{ JSON.stringify($json) }}',options:{timeout:5000}};}
  if(n.type.endsWith('.respondToWebhook')){n.type='n8n-nodes-base.code';n.typeVersion=2;n.parameters={mode:'runOnceForEachItem',jsCode:'if(typeof $json.html!=="string" || !$json.html.includes("</html>"))throw new Error("Expected complete rendered HTML"); return {json:{rendered:true,htmlLength:$json.html.length}};'};}
 }
 const path=resolve(runtime,w.id+'.json');writeFileSync(path,JSON.stringify(w));
 await run(['import:workflow','--input='+path],label+'-import');
 await startSocket();
 console.log('RUN '+label);
 let output;
 try {output=await run(['execute','--id='+w.id,'--rawOutput'],label+'-execute');}
 finally {await socket.stop();socket=null;}
 assert.ok(!/"status"\s*:\s*"error"|Error executing workflow|Execution error:/i.test(output),'n8n execution failed: '+output.slice(-4000));
 logs.push({scenario:label,result:'PASS',engine:'n8n 2.27.4',provider_calls:'loopback fixtures only'});console.log('PASS '+label);
}
const empty=()=>Object.fromEntries(['location','area_sqm','frequency_per_week','preferred_hours','requested_start_date'].map(k=>[k,null]));
const fields={location:'BGC',area_sqm:200,frequency_per_week:3,preferred_hours:'after 6 pm',requested_start_date:'2099-12-01'};
const evidence={location:'BGC',area_sqm:'200 sqm',frequency_per_week:'3 times per week',preferred_hours:'after 6 pm',requested_start_date:'2099-12-01'};
const message=(id,text)=>({id,threadId:'synthetic-thread',from:{value:[{address:'customer@example.test'}]},subject:'Office cleaning inquiry',text,date:new Date().toISOString()});
const setAnalysis=(intent,values,proof)=>{response={stop_reason:'tool_use',content:[{type:'tool_use',id:'synthetic-tool',name:'analyze_inquiry',input:{intent,fields:values,evidence:proof,summary:'Synthetic office cleaning inquiry for workflow testing.',reply_draft:'You would like your office cleaned on a regular schedule.'}}],usage:{input_tokens:100,output_tokens:60}};};
try{
 await run(['import:credentials','--input='+resolve(runtime,'credentials.json')],'credentials');
 // Import the canonical inactive exports unmodified and round-trip separately.
 writeFileSync(resolve(runtime,'canonical.json'),JSON.stringify(originals));await run(['import:workflow','--input='+resolve(runtime,'canonical.json')],'canonical-import');
 await run(['export:workflow','--all','--output='+resolve(runtime,'roundtrip.json')],'canonical-export');
 const rt=JSON.parse(readFileSync(resolve(runtime,'roundtrip.json'),'utf8'));
 for(const w of originals){const imported=rt.find(x=>x.id===w.id);assert.ok(imported);assert.equal(imported.active,false);assert.deepEqual(imported.nodes,w.nodes);assert.deepEqual(imported.connections,w.connections);}
 logs.push({scenario:'Canonical inactive import and round-trip',result:'PASS',workflows:4});console.log('PASS canonical import and round-trip');
 if(!recovery){
 setAnalysis('new_inquiry',fields,evidence);
 const inbound=message('synthetic-inbound-1','Please quote recurring office cleaning in BGC for 200 sqm, 3 times per week, after 6 pm, starting 2099-12-01.');
 await execute(0,'Gmail inquiry',inbound,'complete-inquiry');
 let review=await api({action:'review'});assert.equal(review.ok,true);
 await execute(0,'Gmail inquiry',inbound,'duplicate-inquiry');assert.equal(claudeCalls,1);
 await execute(1,'Prepare tick',{},'prepare-quote');
 review=await api({action:'review'});let draft=review.drafts.find(x=>x.state==='pending');assert.ok(draft,'Expected pending quote');assert.equal(Number(draft.amount_centavos),240000);
 await execute(2,'Open staff review',{},'render-staff-portal');
 await execute(2,'Submit staff decision',{body:{action:'decide',draft_id:draft.id,token:draft.approval_token,decision:'approve'}},'approve-quote');
 await execute(2,'Delivery tick',{},'send-approved-quote');assert.equal(sendCount,1);
 await execute(2,'Delivery tick',{},'no-duplicate-send');assert.equal(sendCount,1);
 // A quiet customer: age the sent quote past day 2 so the real prepare workflow drafts follow-up 1.
 await db.query("UPDATE inquiry_to_quote.quotes SET sent_at=now()-interval '49 hours' WHERE state='sent'");
 await execute(1,'Prepare tick',{},'prepare-follow-up');
 review=await api({action:'review'});const nudge=review.drafts.find(x=>x.kind==='follow_up'&&x.state==='pending');assert.ok(nudge,'Expected a follow-up draft');assert.equal(nudge.follow_up_number,1);assert.equal(claudeCalls,1,'Follow-ups never call Claude');
 await execute(2,'Submit staff decision',{body:{action:'decide',draft_id:nudge.id,token:nudge.approval_token,decision:'approve'}},'approve-follow-up');
 await execute(2,'Delivery tick',{},'send-approved-follow-up');assert.equal(sendCount,2);
 setAnalysis('acceptance',empty(),empty());await execute(0,'Gmail inquiry',message('synthetic-inbound-2','I accept the quote and scope you sent.'),'acceptance-reply');
 review=await api({action:'review'});let inquiry=review.inquiries.find(x=>x.status==='acceptance_review');assert.ok(inquiry);
 await execute(2,'Submit staff decision',{body:{action:'confirm_acceptance',inquiry_id:inquiry.id,revision:String(inquiry.revision),review_token:review.review_token,checked_acceptance:'yes'}},'confirm-operations-handoff');
 review=await api({action:'review'});assert.equal(review.jobs.length,1);assert.equal(review.jobs[0].schedule_status,'UNCONFIRMED');
 await execute(3,'Maintenance tick',{},'maintenance-and-staff-digest');
 } else {
  response={error:{message:'Synthetic malformed provider response'}};
  await execute(0,'Gmail inquiry',message('recovery-1','Please quote office cleaning.'),'malformed-analysis-held');
  let review=await api({action:'review'});let inquiry=review.inquiries[0];assert.equal(inquiry.status,'analysis_failed');
  await execute(2,'Submit staff decision',{body:{action:'revise',inquiry_id:inquiry.id,revision:String(inquiry.revision),review_token:review.review_token,resolve_failed:'yes',...Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,String(v)])),reply_draft:'Your confirmed details are below.'}},'staff-manual-recovery');
  review=await api({action:'review'});assert.equal(review.inquiries[0].status,'ready');assert.equal(review.inquiries[0].revision,2);
  await execute(1,'Prepare tick',{},'prepare-after-recovery');
  review=await api({action:'review'});let draft=review.drafts[0];assert.equal(draft.state,'pending');assert.equal(Number(draft.amount_centavos),240000);
  await execute(2,'Submit staff decision',{body:{action:'decide',draft_id:draft.id,token:draft.approval_token,decision:'approve'}},'approve-recovered-quote');
  assert.equal((await api({action:'review'})).drafts[0].state,'approved');
  await execute(2,'Delivery tick',{},'default-disabled-send',{enableSending:false});assert.equal(sendCount,0);assert.equal((await api({action:'review'})).drafts[0].state,'approved');
  sendFail=true;await execute(2,'Delivery tick',{},'uncertain-provider-delivery');assert.equal(sendCount,1);
  review=await api({action:'review'});draft=review.drafts[0];assert.equal(draft.state,'uncertain');
  await execute(2,'Delivery tick',{},'uncertain-not-retried');assert.equal(sendCount,1);
  await execute(2,'Submit staff decision',{body:{action:'reconcile',draft_id:draft.id,token:draft.approval_token,review_token:review.review_token,decision:'confirmed_not_sent',checked_sent_folder:'yes'}},'staff-reconciles-unsent');
  review=await api({action:'review'});assert.equal(review.drafts[0].state,'pending');assert.notEqual(review.drafts[0].approval_token,draft.approval_token);
  // Seed the already unit-tested failed state; exercise the retry scheduler itself.
  const seeded=await api({action:'ingest',message:{id:'retry-source',thread_id:'retry-thread',from_email:'customer@example.test',subject:'Cleaning',text:'Office in BGC, 200 sqm, 3 times per week, after 6 pm, starting 2099-12-01.',received_at:new Date().toISOString()}});assert.equal(seeded.ok,true);
  assert.equal((await api({action:'fail_analysis',message_id:'retry-source',claim_token:seeded.claim_token,error:'Synthetic failure'})).ok,true);
  review=await api({action:'review'});
  await execute(2,'Submit staff decision',{body:{action:'retry_analysis',message_id:'retry-source',review_token:review.review_token}},'staff-requests-analysis-retry');
  setAnalysis('new_inquiry',fields,evidence);await execute(0,'Retry queue tick',{},'queued-analysis-retry');
  assert.equal((await db.query("SELECT state,attempts FROM inquiry_to_quote.messages WHERE id='retry-source'")).rows[0].state,'analyzed');
  assert.equal((await db.query("SELECT attempts FROM inquiry_to_quote.messages WHERE id='retry-source'")).rows[0].attempts,2);
  await execute(3,'Workflow failure',{workflow:{name:'Synthetic failing workflow'},execution:{id:'synthetic-failure',lastNodeExecuted:'Synthetic node'}},'record-workflow-exception');
  assert.ok((await api({action:'review'})).alerts.some(x=>x.type==='execution_error'));
  await execute(3,'Maintenance tick',{},'uncertain-staff-notification');
  assert.ok((await api({action:'review'})).notifications.some(x=>x.state==='uncertain'));
  await execute(2,'Submit staff decision',{body:{action:'unsupported'}},'invalid-form-rejected');
  assert.equal((await api({action:'review'})).jobs.length,0);
 }
 const result={status:'OFFLINE_RUNTIME_VERIFIED',live_integrations:'NOT_LIVE_TESTED',runtime:'n8n 2.27.4; native Postgres node against PGlite TCP; Claude/Gmail loopback fixtures',scenarios:logs,synthetic_claude_calls:claudeCalls,synthetic_email_attempts:sendCount,observed_at:new Date().toISOString()};
 writeFileSync(resolve(root,recovery?'evidence/runtime-recovery.json':'evidence/runtime-verification.json'),JSON.stringify(result,null,2)+'\n');
 writeFileSync(resolve(root,'evidence/runtime-location.txt'),runtime+'\n');
 console.log('Runtime verification completed; no external provider calls.');
}finally{if(socket)await socket.stop();await db.close();await new Promise(r=>server.close(r));}
