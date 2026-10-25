// Run the real CLI/Chrome E2E with an outside daemon socket that must never be used.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import net from 'node:net';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.resolve(process.env.E2E_OUTPUT||path.join(root,'target/e2e'));
await mkdir(out,{recursive:true});
const temp=await mkdtemp(path.join(tmpdir(),'fb-outside-'));
const requests=[],env={...process.env};let server,result;
const frame=(tag,body)=>{const b=Buffer.from(body),h=Buffer.alloc(5);h[0]=tag.charCodeAt(0);h.writeUInt32BE(b.length,1);return Buffer.concat([h,b])};
try{
 if(process.platform!=='win32'){
  env.FB_SOCK=path.join(temp,'outside.sock');
  server=net.createServer(s=>{let input='';s.on('data',chunk=>{input+=chunk;if(!input.includes('\n'))return;const request=JSON.parse(input);requests.push(request.argv);s.write(frame('o','browser ok\nlogged in as 999\n'));s.end(frame('x',Buffer.from([0])))})});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(env.FB_SOCK,resolve)});
 }
 result=await promisify(execFile)(process.execPath,[path.join(root,'tests/e2e.mjs')],{env,maxBuffer:1024*1024});
 process.stdout.write(result.stdout);process.stderr.write(result.stderr);
 assert.deepEqual(requests,[],'fixture must not contact inherited daemon socket');
}finally{
 if(server)await new Promise(resolve=>server.close(resolve));
 await writeFile(path.join(out,'isolation.json'),JSON.stringify({requests,pass:!!result&&requests.length===0},null,2)+'\n');
 await rm(temp,{recursive:true,force:true});
}
