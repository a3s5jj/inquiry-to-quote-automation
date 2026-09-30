import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root=new URL('../',import.meta.url);
const files=readdirSync(new URL('workflows/',root)).filter(f=>f.endsWith('.json'));
const layouts=JSON.parse(readFileSync(new URL('tools/workflow_layouts.json',root),'utf8'));
const workflows=files.map(f=>JSON.parse(readFileSync(new URL('workflows/'+f,root),'utf8')));
test('four portable workflows cover distinct product responsibilities',()=>{
 assert.equal(workflows.length,4);
 assert.deepEqual(workflows.map(w=>w.id).sort(),['ITQ01Inbox','ITQ02Prepare','ITQ03Review','ITQ04Maintenance']);
});
for(const w of workflows){
 test(`${w.id}: inactive, credential-free, parameterized and valid graph`,()=>{
  assert.equal(w.active,false);assert.deepEqual(w.pinData,{});
  const names=new Set(w.nodes.map(n=>n.name));assert.equal(names.size,w.nodes.length);
  for(const n of w.nodes){
   assert.ok(!n.credentials);assert.ok(!n.retryOnFail);
   if(n.type.endsWith('.postgres')){
    assert.equal(n.parameters.query,'SELECT inquiry_to_quote.api($1::jsonb) AS result');
    assert.match(n.parameters.options.queryReplacement,/JSON.stringify/);
   }
   if(n.type.endsWith('.code'))assert.doesNotThrow(()=>new Function('$json','$input','$',n.parameters.jsCode));
  }
  for(const [source,groups] of Object.entries(w.connections)){
   assert.ok(names.has(source));
   for(const outputs of Object.values(groups))for(const list of outputs)for(const edge of list)assert.ok(names.has(edge.node));
  }
  const seeds=w.nodes.filter(n=>/Trigger$|\.webhook$/.test(n.type)).map(n=>n.name);
  const visited=new Set(seeds),queue=[...seeds];
  while(queue.length){for(const branch of w.connections[queue.shift()]?.main||[])for(const {node}of branch)if(!visited.has(node)){visited.add(node);queue.push(node);}}
  assert.equal(visited.size,w.nodes.length,'Every node must be reachable from a trigger');
 });
 test(`${w.id}: complete fixed seven-dot layout with no rectangle collisions`,()=>{
  const l=layouts.WORKFLOW_LAYOUTS[w.id];assert.equal(l.nodeCount,w.nodes.length);
  assert.deepEqual(Object.keys(l.positions).sort(),w.nodes.map(n=>n.name).sort());
  const coords=new Set();
  for(const n of w.nodes){assert.deepEqual(n.position,l.positions[n.name]);const [x,y]=n.position;assert.equal(x%208,0);assert.equal(y%208,0);assert.ok(!coords.has(`${x},${y}`));coords.add(`${x},${y}`);}
  for(const group of l.spacingGroups){for(let i=1;i<group.names.length;i++){const a=l.positions[group.names[i-1]],b=l.positions[group.names[i]];assert.equal(b[group.axis==='x'?0:1]-a[group.axis==='x'?0:1],208);}}
  for(let i=0;i<w.nodes.length;i++)for(let j=i+1;j<w.nodes.length;j++){
   const a=w.nodes[i],b=w.nodes[j],ar=l.rectangles[a.name],br=l.rectangles[b.name];
   assert.ok(a.position[0]+ar.width<=b.position[0]||b.position[0]+br.width<=a.position[0]||a.position[1]+ar.height<=b.position[1]||b.position[1]+br.height<=a.position[1]);
  }
 });
}
test('customer sending requires enable flag, atomic claim, sender-only reply, and confirmation recording',()=>{
 const w=workflows.find(w=>w.id==='ITQ03Review');const find=n=>w.nodes.find(x=>x.name===n);
 assert.equal(find('Reply with approved message').parameters.options.replyToSenderOnly,true);
 assert.equal(find('Reply with approved message').parameters.options.appendAttribution,false);
 assert.match(find('Delivery configuration').parameters.jsCode,/"enableCustomerSending":false/);
 assert.equal(w.connections['Customer sending enabled'].main[0][0].node,'Claim approved send');
 assert.equal(w.connections['Reply with approved message'].main[0][0].node,'Classify send result');
 assert.match(find('Classify send result').parameters.jsCode,/send_uncertain/);
 for(const n of w.nodes.filter(n=>n.type.endsWith('.webhook'))){assert.equal(n.parameters.authentication,'basicAuth');assert.equal(n.parameters.responseMode,'responseNode');}
});
test('Claude HTTP is fixed to Anthropic, uses credential auth and bounded timeout',()=>{
 const n=workflows[0].nodes.find(n=>n.name==='Claude analyze');
 assert.equal(n.parameters.url,'https://api.anthropic.com/v1/messages');
 assert.equal(n.parameters.genericAuthType,'httpHeaderAuth');assert.equal(n.parameters.options.timeout,60000);
});
test('intake and preparation controls are explicit on the canvas',()=>{
 const intake=workflows.find(w=>w.id==='ITQ01Inbox');
 const prepare=workflows.find(w=>w.id==='ITQ02Prepare');
 const intakeNames=new Set(intake.nodes.map(n=>n.name));
 const prepareNames=new Set(prepare.nodes.map(n=>n.name));
 for(const name of ['Sender and message safety checks','Validate extracted evidence','Store validated facts','Duplicate or no analysis work'])assert.ok(intakeNames.has(name),name);
 for(const name of ['Validate scope, calculate price, and version draft','Quote draft generated?','Quote awaiting staff review','Clarification draft generated?','Clarification awaiting staff review'])assert.ok(prepareNames.has(name),name);
 assert.equal(prepare.connections['Quote draft generated?'].main[0][0].node,'Quote awaiting staff review');
 assert.equal(prepare.connections['Quote draft generated?'].main[1][0].node,'Clarification draft generated?');
 assert.equal(prepare.connections['Clarification draft generated?'].main[0][0].node,'Clarification awaiting staff review');
 const settings=JSON.parse(readFileSync(new URL('config/settings.json',root),'utf8'));
 assert.ok(prepare.nodes.find(n=>n.name==='Request draft preparation').parameters.jsCode.includes(`business_name:${JSON.stringify(settings.businessName)}`),'Emails are signed with the configured business name');
 assert.ok(prepare.nodes.find(n=>n.name==='Request draft preparation').parameters.jsCode.includes(`follow_up_after_minutes:${JSON.stringify(settings.followUpAfterMinutes)}`),'Follow-up delays come from settings');
 assert.equal(prepare.connections['Clarification draft generated?'].main[1][0].node,'Follow-up draft generated?');
 assert.equal(prepare.connections['Follow-up draft generated?'].main[0][0].node,'Follow-up awaiting staff review');
 assert.equal(prepare.connections['Follow-up draft generated?'].main[1][0].node,'Question awaiting staff review');
 assert.match(prepare.nodes.find(n=>n.name==='Follow-up awaiting staff review').parameters.jsCode,/quote_id[\s\S]*follow_up_number[\s\S]*AWAITING_STAFF_REVIEW/);
 const quote=prepare.nodes.find(n=>n.name==='Quote awaiting staff review');
 for(const field of ['source_revision','rate_version','scope','price_per_visit_centavos','weekly_price_centavos','quote_valid_until','UNCONFIRMED','AWAITING_STAFF_REVIEW'])assert.match(quote.parameters.jsCode,new RegExp(field));
});
test('private live-test build binds credentials by ID and leaves canonical exports untouched',async()=>{
 const { execFileSync } = await import('node:child_process');
 const { mkdtempSync, writeFileSync: write, rmSync } = await import('node:fs');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const dir=mkdtempSync(join(tmpdir(),'itq-private-'));
 try{
  const example=JSON.parse(readFileSync(new URL('config/settings.local.example.json',root),'utf8'));
  const tool=fileURLToPath(new URL('tools/build_workflows.mjs',root));
  const run=settings=>{write(join(dir,'settings.json'),JSON.stringify(settings));return execFileSync(process.execPath,[tool,'--private'],{env:{...process.env,ITQ_PRIVATE_SETTINGS:join(dir,'settings.json'),ITQ_PRIVATE_OUT:join(dir,'out')},stdio:'pipe'}).toString();};
  assert.throws(()=>run(example),/REPLACE_/,'Placeholders are refused');
  const before=files.map(f=>readFileSync(new URL('workflows/'+f,root),'utf8'));
  const credentials=Object.fromEntries(Object.keys(example.credentials).map(k=>[k,{id:'cred'+k,name:'Test '+k}]));
  assert.match(run({...example,credentials}),/18 credential bindings/);
  assert.deepEqual(files.map(f=>readFileSync(new URL('workflows/'+f,root),'utf8')),before,'Canonical exports unchanged');
  const built=files.map(f=>JSON.parse(readFileSync(join(dir,'out',f),'utf8')));
  assert.deepEqual(built.map(w=>w.id).sort(),['ITQLive01Inbox','ITQLive02Prepare','ITQLive03Review','ITQLive04Maintenance']);
  for(const w of built){
   assert.equal(w.active,false);assert.match(w.name,/^\[LIVE TEST\] /);
   if(w.settings.errorWorkflow)assert.equal(w.settings.errorWorkflow,'ITQLive04Maintenance');
   for(const n of w.nodes)if(/\.(postgres|gmail|gmailTrigger|httpRequest|webhook)$/.test(n.type))assert.equal(Object.keys(n.credentials||{}).length,1,n.name);
   for(const n of w.nodes)if(n.type.endsWith('.code'))assert.doesNotMatch(n.parameters.jsCode,/credpostgres|"credentials"/,'Credential IDs never reach Code nodes');
  }
  assert.match(built[1].nodes.find(n=>n.name==='Request draft preparation').parameters.jsCode,/follow_up_after_minutes:\[3,6\]/);
  assert.match(run({...example,credentials:{...credentials,anthropic:{id:'credA',name:'Test A',type:'anthropicApi'}}}),/18 credential bindings/);
  const claude=files.flatMap(f=>JSON.parse(readFileSync(join(dir,'out',f),'utf8')).nodes).filter(n=>n.type.endsWith('.httpRequest'));
  assert.equal(claude.length,1);assert.equal(claude[0].parameters.authentication,'predefinedCredentialType');assert.equal(claude[0].parameters.nodeCredentialType,'anthropicApi');
  assert.equal(claude[0].parameters.genericAuthType,undefined);assert.deepEqual(claude[0].credentials,{anthropicApi:{id:'credA',name:'Test A'}});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
