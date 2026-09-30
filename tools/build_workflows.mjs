import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// --private builds the live-test copy from the gitignored config/settings.local.json:
// separate workflow IDs, credentials bound by n8n credential ID, successful executions
// kept for inspection. It never touches the canonical exports or the layout registry.
const isPrivate = process.argv.includes('--private');
const settingsPath = isPrivate ? resolve(process.env.ITQ_PRIVATE_SETTINGS || resolve(root, 'config/settings.local.json')) : resolve(root, 'config/settings.json');
const config = JSON.parse(readFileSync(settingsPath, 'utf8'));
if (isPrivate) {
  const problems = [];
  if (/REPLACE_/.test(JSON.stringify(config))) problems.push('replace every REPLACE_ placeholder');
  if (!/^https?:\/\/[^\s/]+$/.test(config.publicBaseUrl || '')) problems.push('publicBaseUrl must be an origin such as http://localhost:5678');
  for (const kind of ['postgres', 'gmail', 'anthropic', 'staffPortal']) if (!config.credentials?.[kind]?.id || !config.credentials?.[kind]?.name) problems.push(`credentials.${kind} needs the n8n credential id and name`);
  if (problems.length) { console.error('Private build refused:\n- ' + problems.join('\n- ')); process.exit(1); }
}
const { credentials, ...runtimeConfig } = config;
const core = readFileSync(resolve(root, 'src/core.mjs'), 'utf8').replace(/^export\s+/gm, '');
const bundle = `const CONFIG = ${JSON.stringify(runtimeConfig)};\n${core}\n`;
const id = (s) => createHash('sha256').update(s).digest('hex').slice(0, 24);
const node = (name, type, parameters, version=1, extra={}) => ({id:id(name), name, type:`n8n-nodes-base.${type}`,typeVersion:version,parameters,position:[0,0],...extra});
const code = (name, js, lib=false, each=true) => node(name,'code',{mode:each?'runOnceForEachItem':'runOnceForAllItems',jsCode:(lib?bundle:'')+js},2);
const schedule = (name, minutes) => node(name,'scheduleTrigger',{rule:{interval:[{field:'minutes',minutesInterval:minutes}]}},1.2);
const db = (name, expression='$json.request') => node(name,'postgres',{operation:'executeQuery',query:'SELECT inquiry_to_quote.api($1::jsonb) AS result',options:{queryReplacement:`={{ [JSON.stringify(${expression})] }}`,queryBatching:'independently'}},2.6);
const request = (name, action) => code(name,`return {json:{request:{action:${JSON.stringify(action)}}}};`);
const check = (name, expression) => node(name,'if',{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:id(name+'condition'),leftValue:`={{ ${expression} }}`,rightValue:true,operator:{type:'boolean',operation:'true',singleValue:true}}],combinator:'and'},options:{}},2.2);
const assert = name => code(name,"const r=$json.result; if(!r || r.ok===false) throw new Error(r?.error || 'Database operation failed'); return {json:r};");
const webhook = (name,path,method) => node(name,'webhook',{httpMethod:method,path,authentication:'basicAuth',responseMode:'responseNode',options:{}},2.1,{webhookId:id(path)});
const respond = name => node(name,'respondToWebhook',{respondWith:'text',responseBody:'={{ $json.html }}',options:{responseCode:200,responseHeaders:{entries:[{name:'Content-Type',value:'text/html; charset=utf-8'},{name:'Cache-Control',value:'no-store'},{name:'Referrer-Policy',value:'no-referrer'},{name:'X-Content-Type-Options',value:'nosniff'}]}}},1.4);
const gmail = (name, parameters) => node(name,'gmail',parameters,2.2,{onError:'continueRegularOutput',retryOnFail:false});
const out=[]; const registry={};
function workflow(key,name,filename,nodes,edges,lanes) {
  const connections={};
  for(const [from,to,branch=0] of edges) {
    connections[from]??={main:[]};
    while(connections[from].main.length<=branch)connections[from].main.push([]);
    connections[from].main[branch].push({node:to,type:'main',index:0});
  }
  const positions={},groups=[];
  for(const [row,names,startCol=0] of lanes) {
    names.forEach((name,col)=>{positions[name]=[(col+startCol)*208,row*208];});
    if(names.length>1) groups.push({axis:'x',names});
  }
  for(const n of nodes) {if(!positions[n.name])throw new Error('No layout '+n.name); n.position=positions[n.name];}
  const data={id:key,name,active:false,nodes,connections,settings:{executionOrder:'v1',timezone:config.timezone,saveDataSuccessExecution:'none',saveDataErrorExecution:'all',saveManualExecutions:false,executionTimeout:180,errorWorkflow:'ITQ04Maintenance'},pinData:{},tags:[]};
  // Errors in the error handler remain in n8n's execution list; avoid recursive handling.
  if(key==='ITQ04Maintenance')delete data.settings.errorWorkflow;
  registry[key]={filename,nodeCount:nodes.length,positions,spacingGroups:groups,rectangles:Object.fromEntries(nodes.map(n=>[n.name,{width:96,height:96}]))};
  out.push({filename,data});
}

workflow('ITQ01Inbox','ITQ 01 - Gmail intake and Claude analysis','01-gmail-intake.json',[
 node('Gmail inquiry','gmailTrigger',{pollTimes:{item:[{mode:'everyMinute'}]},simple:false,maxResults:10,filters:{q:config.gmailQuery,readStatus:'both',includeSpamTrash:false,includeDrafts:false},options:{downloadAttachments:false}},1.4),
 code('Sender and message safety checks',"return {json:{request:{action:'ingest',message:normalizeGmail($json)}}};",true),
 db('Lease inquiry'),
 schedule('Retry queue tick',2),request('Claim requested retry','claim_analysis'),db('Lease requested retry'),
 check('Analysis claimed','$json.result?.ok !== false && $json.result?.process === true'),
 code('Prepare Claude request',"const context=$json.result; return {json:{context,body:buildClaudeRequest(context,{model:CONFIG.model})}};",true),
 node('Claude analyze','httpRequest',{method:'POST',url:'https://api.anthropic.com/v1/messages',authentication:'genericCredentialType',genericAuthType:'httpHeaderAuth',sendHeaders:true,headerParameters:{parameters:[{name:'anthropic-version',value:'2023-06-01'}]},sendBody:true,specifyBody:'json',jsonBody:'={{ JSON.stringify($json.body) }}',options:{timeout:60000}},4.2,{onError:'continueRegularOutput',retryOnFail:false}),
 code('Validate extracted evidence',"const context=$('Prepare Claude request').item.json.context; try { const parsed=parseClaudeResponse($json,context); return {json:{request:{action:'analyze',message_id:context.message.id,claim_token:context.claim_token,...parsed}}}; } catch(e) { return {json:{request:{action:'fail_analysis',message_id:context.message.id,claim_token:context.claim_token,error:String(e.message).slice(0,600)}}}; }",true),
 db('Store validated facts'),assert('Intake and evidence recorded'),
 code('Duplicate or no analysis work',"const r=$json.result; if(r?.ok===false)throw new Error(r.error||'Intake rejected'); return {json:r};")
],[['Gmail inquiry','Sender and message safety checks'],['Sender and message safety checks','Lease inquiry'],['Lease inquiry','Analysis claimed'],['Retry queue tick','Claim requested retry'],['Claim requested retry','Lease requested retry'],['Lease requested retry','Analysis claimed'],['Analysis claimed','Prepare Claude request'],['Analysis claimed','Duplicate or no analysis work',1],['Prepare Claude request','Claude analyze'],['Claude analyze','Validate extracted evidence'],['Validate extracted evidence','Store validated facts'],['Store validated facts','Intake and evidence recorded']],
 [[0,['Gmail inquiry','Sender and message safety checks','Lease inquiry','Analysis claimed','Prepare Claude request','Claude analyze','Validate extracted evidence','Store validated facts','Intake and evidence recorded']],[2,['Retry queue tick','Claim requested retry','Lease requested retry']],[4,['Duplicate or no analysis work']]]);

workflow('ITQ02Prepare','ITQ 02 - Prepare clarification and quote drafts','02-quote-preparation.json',[
 schedule('Prepare tick',1),code('Request draft preparation',`return {json:{request:{action:'prepare',business_name:${JSON.stringify(config.businessName)},follow_up_after_minutes:${JSON.stringify(config.followUpAfterMinutes)}}}};`),db('Validate scope, calculate price, and version draft'),assert('Preparation transaction completed'),
 code('Expose prepared drafts',"const result=$input.first().json; return (result.drafts||[]).map(d=>({json:d}));",false,false),
 check('Quote draft generated?','$json.kind === \'quote\''),
 code('Quote awaiting staff review',"const required=['source_revision','rate_version','scope','price_per_visit_centavos','weekly_price_centavos','quote_valid_until'];for(const key of required){if($json[key]===undefined||$json[key]===null)throw new Error('Missing frozen quote control: '+key);}if($json.schedule_status!=='UNCONFIRMED'||$json.review_status!=='AWAITING_STAFF_REVIEW')throw new Error('Quote is not safely staged for review');return {json:{...$json,next_stage:'STAFF_REVIEW'}};"),
 check('Clarification draft generated?','$json.kind === \'clarification\''),
 code('Clarification awaiting staff review',"return {json:{...$json,next_stage:'STAFF_REVIEW_THEN_CUSTOMER_REPLY_TO_GMAIL_INTAKE'}};"),
 check('Follow-up draft generated?','$json.kind === \'follow_up\''),
 code('Follow-up awaiting staff review',"if(!$json.quote_id||!(Number($json.follow_up_number)>=1)||$json.review_status!=='AWAITING_STAFF_REVIEW')throw new Error('Follow-up is not safely staged for review');return {json:{...$json,next_stage:'STAFF_REVIEW_THEN_CUSTOMER_REPLY_TO_GMAIL_INTAKE'}};"),
 code('Question awaiting staff review',"return {json:{...$json,next_stage:'STAFF_REVIEW_THEN_CUSTOMER_REPLY_TO_GMAIL_INTAKE'}};")
],[['Prepare tick','Request draft preparation'],['Request draft preparation','Validate scope, calculate price, and version draft'],['Validate scope, calculate price, and version draft','Preparation transaction completed'],['Preparation transaction completed','Expose prepared drafts'],['Expose prepared drafts','Quote draft generated?'],['Quote draft generated?','Quote awaiting staff review'],['Quote draft generated?','Clarification draft generated?',1],['Clarification draft generated?','Clarification awaiting staff review'],['Clarification draft generated?','Follow-up draft generated?',1],['Follow-up draft generated?','Follow-up awaiting staff review'],['Follow-up draft generated?','Question awaiting staff review',1]],
 [[0,['Prepare tick','Request draft preparation','Validate scope, calculate price, and version draft','Preparation transaction completed','Expose prepared drafts','Quote draft generated?','Quote awaiting staff review']],[2,['Clarification draft generated?','Clarification awaiting staff review'],5],[4,['Follow-up draft generated?','Follow-up awaiting staff review'],5],[6,['Question awaiting staff review'],6]]);

workflow('ITQ03Review','ITQ 03 - Staff review and approved delivery','03-review-and-delivery.json',[
 webhook('Open staff review','itq-review','GET'),request('Read review queue','review'),db('Load staff queue'),
 code('Render staff page',"if($json.result?.ok===false)throw new Error($json.result.error);return {json:{html:renderReview($json.result,{actionUrl:CONFIG.publicBaseUrl+'/webhook/itq-review-action',refreshUrl:CONFIG.publicBaseUrl+'/webhook/itq-review',followUpTotal:CONFIG.followUpAfterMinutes.length})}};",true),respond('Show staff page'),
 webhook('Submit staff decision','itq-review-action','POST'),
 code('Validate staff action',"try{return {json:{request:parseReviewAction($json.body||{}),valid:true}};}catch(e){return {json:{valid:false,result:{ok:false,error:String(e.message)}}};}",true),
 check('Valid staff action','$json.valid === true'),db('Apply staff decision'),
 code('Render action result',"return {json:{html:renderActionResult($json.result,{refreshUrl:CONFIG.publicBaseUrl+'/webhook/itq-review'})}};",true),respond('Show action result'),
 schedule('Delivery tick',1),
 code('Delivery configuration',"return {json:{enabled:CONFIG.enableCustomerSending===true,request:{action:'claim_send'}}};",true),
 check('Customer sending enabled','$json.enabled === true'),db('Claim approved send'),
 code('One claimed send',"if($json.result?.ok===false)throw new Error($json.result.error);return ($json.result?.sends||[]).map(s=>({json:s}));",false,false),
 gmail('Reply with approved message',{resource:'message',operation:'reply',messageId:'={{ $json.reply_message_id }}',emailType:'text',message:'={{ $json.body }}',options:{replyToSenderOnly:true,appendAttribution:false}}),
 code('Classify send result',"const s=$('One claimed send').item.json; const response=$json; const request=response.id && !response.error ? {action:'mark_sent',draft_id:s.id,send_token:s.send_token,provider_message_id:response.id} : {action:'send_uncertain',draft_id:s.id,send_token:s.send_token,error:'Gmail reply returned no confirmed message ID. Check Sent before retry.'}; return {json:{request}};"),
 db('Record delivery outcome'),assert('Delivery recorded')
],[['Open staff review','Read review queue'],['Read review queue','Load staff queue'],['Load staff queue','Render staff page'],['Render staff page','Show staff page'],['Submit staff decision','Validate staff action'],['Validate staff action','Valid staff action'],['Valid staff action','Apply staff decision'],['Valid staff action','Render action result',1],['Apply staff decision','Render action result'],['Render action result','Show action result'],['Delivery tick','Delivery configuration'],['Delivery configuration','Customer sending enabled'],['Customer sending enabled','Claim approved send'],['Claim approved send','One claimed send'],['One claimed send','Reply with approved message'],['Reply with approved message','Classify send result'],['Classify send result','Record delivery outcome'],['Record delivery outcome','Delivery recorded']],
 [[0,['Open staff review','Read review queue','Load staff queue','Render staff page','Show staff page']],[2,['Submit staff decision','Validate staff action','Valid staff action','Apply staff decision','Render action result','Show action result']],[4,['Delivery tick','Delivery configuration','Customer sending enabled','Claim approved send','One claimed send','Reply with approved message','Classify send result','Record delivery outcome','Delivery recorded']]]);

workflow('ITQ04Maintenance','ITQ 04 - Follow-up reminders and exceptions','04-maintenance.json',[
 schedule('Maintenance tick',15),request('Maintain deadlines','maintenance'),db('Record overdue and uncertain'),assert('Maintenance recorded'),
 code('Staff notification configuration',"if(CONFIG.enableStaffNotifications && (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(CONFIG.staffEmail)||CONFIG.staffEmail.endsWith('.invalid')))throw new Error('Set staffEmail before enabling notifications');return {json:{enabled:CONFIG.enableStaffNotifications===true,request:{action:'claim_notifications'}}};",true),
 check('Staff notifications enabled','$json.enabled === true'),db('Claim staff notifications'),
 code('One staff digest',"if($json.result?.ok===false)throw new Error($json.result.error);return ($json.result?.notifications||[]).map(n=>({json:{...n,staff_email:CONFIG.staffEmail,body:n.body+'\\n\\nReview: '+CONFIG.publicBaseUrl+'/webhook/itq-review'}}));",true,false),
 gmail('Email staff digest',{resource:'message',operation:'send',sendTo:'={{ $json.staff_email }}',subject:'={{ $json.subject }}',emailType:'text',message:'={{ $json.body }}',options:{appendAttribution:false}}),
 code('Staff notification result',"const n=$('One staff digest').item.json;return {json:{request:{action:'notification_result',id:n.id,...($json.id && !$json.error?{provider_message_id:$json.id}:{error:'Notification delivery unconfirmed; inspect n8n and Gmail Sent.'})}}};"),
 db('Record staff notification'),assert('Notification recorded'),
 node('Workflow failure','errorTrigger',{}),
 code('Sanitize execution error',"return {json:{request:{action:'report_error',source:String($json.workflow?.name||'n8n'),execution_id:String($json.execution?.id||''),message:'Workflow failed at '+String($json.execution?.lastNodeExecuted||'unknown node')+'. Inspect the private n8n execution log.'}}};"),db('Record workflow exception'),assert('Exception recorded')
],[['Maintenance tick','Maintain deadlines'],['Maintain deadlines','Record overdue and uncertain'],['Record overdue and uncertain','Maintenance recorded'],['Maintenance recorded','Staff notification configuration'],['Staff notification configuration','Staff notifications enabled'],['Staff notifications enabled','Claim staff notifications'],['Claim staff notifications','One staff digest'],['One staff digest','Email staff digest'],['Email staff digest','Staff notification result'],['Staff notification result','Record staff notification'],['Record staff notification','Notification recorded'],['Workflow failure','Sanitize execution error'],['Sanitize execution error','Record workflow exception'],['Record workflow exception','Exception recorded']],
 [[0,['Maintenance tick','Maintain deadlines','Record overdue and uncertain','Maintenance recorded','Staff notification configuration','Staff notifications enabled','Claim staff notifications','One staff digest','Email staff digest','Staff notification result','Record staff notification','Notification recorded']],[2,['Workflow failure','Sanitize execution error','Record workflow exception','Exception recorded']]]);

if(isPrivate){
 const liveId=key=>key.replace(/^ITQ/,'ITQLive');
 const bind={postgres:['postgres','postgres'],gmail:['gmailOAuth2','gmail'],gmailTrigger:['gmailOAuth2','gmail'],httpRequest:['httpHeaderAuth','anthropic'],webhook:['httpBasicAuth','staffPortal']};
 const dir=resolve(process.env.ITQ_PRIVATE_OUT||resolve(root,'private/workflows'));mkdirSync(dir,{recursive:true});
 let bound=0;
 for(const {filename,data} of out){
  data.id=liveId(data.id);data.name='[LIVE TEST] '+data.name;
  if(data.settings.errorWorkflow)data.settings.errorWorkflow=liveId(data.settings.errorWorkflow);
  data.settings.saveDataSuccessExecution='all';
  for(const n of data.nodes){
   const t=n.type.replace('n8n-nodes-base.',''),b=bind[t];if(!b)continue;
   // credentials.anthropic.type "anthropicApi" reuses an existing n8n Anthropic credential instead of Header Auth.
   if(t==='httpRequest'&&credentials.anthropic.type==='anthropicApi'){delete n.parameters.genericAuthType;Object.assign(n.parameters,{authentication:'predefinedCredentialType',nodeCredentialType:'anthropicApi'});n.credentials={anthropicApi:{id:credentials.anthropic.id,name:credentials.anthropic.name}};}
   else n.credentials={[b[0]]:{id:credentials[b[1]].id,name:credentials[b[1]].name}};
   bound++;
  }
  writeFileSync(resolve(dir,filename),JSON.stringify(data,null,2)+'\n');
 }
 console.log(`Built ${out.length} PRIVATE live-test workflows (inactive, ${bound} credential bindings) in ${dir}. Never commit or share them.`);
}else{
 mkdirSync(resolve(root,'workflows'),{recursive:true});
 for(const {filename,data} of out)writeFileSync(resolve(root,'workflows',filename),JSON.stringify(data,null,2)+'\n');
 writeFileSync(resolve(root,'tools/workflow_layouts.json'),JSON.stringify({grid:208,dot:16,node:96,edgeGap:112,WORKFLOW_LAYOUTS:registry},null,2)+'\n');
 console.log(`Built ${out.length} inactive workflows (${out.reduce((n,w)=>n+w.data.nodes.length,0)} nodes).`);
}
