import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const files={'/':'evidence/demo-review.html','/handoff':'evidence/demo-handoff.html'};
createServer((req,res)=>{
 const file=files[req.url];if(!file){res.writeHead(404);res.end('Not found');return;}
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(readFileSync(resolve(root,file)));
}).listen(5894,'127.0.0.1',()=>console.log('Static synthetic preview: http://127.0.0.1:5894 (no forms execute)'));
