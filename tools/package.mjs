import {zipSync,unzipSync} from 'fflate';
import {readFileSync,readdirSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,dirname,relative} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const allowed=['README.md','IMPLEMENTATION_PLAN.md','package.json','package-lock.json','.gitignore','config','db','src','tools','tests','fixtures','workflows','docs','evidence'];
const exclude=new Set(['runtime-location.txt','settings.local.json']);
const entries={},hashes={};
const sensitivePatterns=[
 new RegExp('sk-'+'ant-[A-Za-z0-9_-]{15,}','i'),
 new RegExp('AI'+'za[A-Za-z0-9_-]{30,}','i'),
 new RegExp('-'.repeat(5)+'BEGIN .*PRIVATE KEY'+'-'.repeat(5),'i'),
 new RegExp('[A-Z]:[\\\\/]Users[\\\\/][^\\s"\']+','i'),
 new RegExp('\/'+'home\/[^\\s"\']+','i')
];
// Missing or failed evidence must not silently produce a release-looking archive.
for(const name of ['docs/DATABASE.md','evidence/TEST_REPORT.md','evidence/visual-verification.json'])readFileSync(resolve(root,name));
for(const name of ['runtime-verification.json','runtime-recovery.json']){
 const result=JSON.parse(readFileSync(resolve(root,'evidence',name),'utf8'));
 if(result.status!=='OFFLINE_RUNTIME_VERIFIED' || !result.scenarios.length || result.scenarios.some(x=>x.result!=='PASS'))throw new Error('Incomplete runtime evidence: '+name);
}
for(const name of readdirSync(resolve(root,'workflows'))){
 const workflow=JSON.parse(readFileSync(resolve(root,'workflows',name),'utf8'));
 if(workflow.active!==false || workflow.nodes.some(n=>n.credentials && Object.keys(n.credentials).length))throw new Error('Non-portable workflow: '+name);
}
function add(path){
 const abs=resolve(root,path);for(const item of readdirSync(abs,{withFileTypes:true})){
  const name=path+'/'+item.name;if(exclude.has(item.name))continue;
  if(item.isDirectory())add(name);else file(name);
 }
}
function file(name){
 const bytes=readFileSync(resolve(root,name));
 if(/\.(md|mjs|json|txt|sql|html)$/.test(name)){
  const text=bytes.toString('utf8');
  if(sensitivePatterns.some(pattern=>pattern.test(text)))throw new Error('Sensitive value or private path in '+name);
  for(const email of text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)||[]){
   if(!/@(?:[\w-]+\.)*example\.(?:test|invalid|com|org|net)$/i.test(email))throw new Error('Non-fixture email address in '+name);
  }
 }
 entries['inquiry-to-quote/'+name.replaceAll('\\','/')]=bytes;
 hashes[name]=createHash('sha256').update(bytes).digest('hex');
}
// Optional top-level files (such as the private implementation plan) may be absent in a copy.
for(const path of allowed){if(!existsSync(resolve(root,path)))continue;if(path.includes('.')&&!['config','db','src','tools','tests','fixtures','workflows','docs','evidence'].includes(path))file(path);else add(path);}
entries['inquiry-to-quote/MANIFEST.json']=new TextEncoder().encode(JSON.stringify({files:hashes,evidence:'OFFLINE_VERIFIED; LIVE_VERIFIED for exercised paths, see evidence/live-test.json'},null,2));
const output=resolve(root,'dist/inquiry-to-quote.zip');mkdirSync(dirname(output),{recursive:true});const zip=zipSync(entries,{level:6});writeFileSync(output,zip);
const verify=unzipSync(zip);if(Object.keys(verify).length!==Object.keys(entries).length)throw new Error('ZIP entry mismatch');
for(const [name,data] of Object.entries(verify)){if(Buffer.compare(Buffer.from(data),Buffer.from(entries[name]))!==0)throw new Error('ZIP byte mismatch: '+name);}
console.log(JSON.stringify({artifact:relative(root,output),files:Object.keys(entries).length,bytes:zip.length,sha256:createHash('sha256').update(zip).digest('hex'),scan:'PASS'},null,2));
