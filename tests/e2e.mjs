// Real Chrome + real fb process. Facebook requests are fulfilled locally; never uses real credentials.
import assert from 'node:assert/strict';
import {proxy} from './cdp-proxy.mjs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,mkdir,rm,readdir,access,symlink,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createServer} from 'node:net';
const exec=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.resolve(process.env.E2E_OUTPUT||path.join(root,'target/e2e'));
await mkdir(out,{recursive:true});
const temp=await mkdtemp(path.join(tmpdir(),'fb-e2e-'));
const chrome=process.env.CHROME||({'darwin':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','win32':'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'}[process.platform]||'google-chrome');
const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+path.join(temp,'chrome'),'about:blank'],{stdio:'ignore'});
let socket,env,cancelHoverStarted=false,closed=false,storySeenRequests=0,photoQueryRequests=0,photoDetailRequests=0,mediaStallRequests=0;const report=[];let id=0;const pending=new Map(),detached=new Set(),targetSessions=new Map();
class TargetClosed extends Error {}
async function call(method,params={},sessionId){if(closed||detached.has(sessionId))throw new TargetClosed(method+' target closed');const n=++id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(n);reject(Error(method+' timed out in '+(sessionId||'browser')))},15000);pending.set(n,{method,sessionId,resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});socket.send(JSON.stringify({id:n,method,params,sessionId}))})}
function cancelCalls(sessionId){const methods=[];for(const [n,p] of pending){if(sessionId&&p.sessionId!==sessionId)continue;pending.delete(n);methods.push(p.method);p.reject(new TargetClosed(p.method+' target closed'))}if(methods.length)report.push({targetClosed:sessionId||'browser',cancelledMethods:methods})}
const binary=path.resolve(process.env.FB||path.join(root,'target/release/fb'+(process.platform==='win32'?'.exe':'')));
async function fb(...args){const t=performance.now();try{const r=await exec(binary,args,{env,timeout:45000,maxBuffer:1024*1024});report.push({args,ms:Math.round(performance.now()-t),stdout:r.stdout,stderr:r.stderr});return r.stdout.trim()}catch(e){report.push({args,ms:Math.round(performance.now()-t),stdout:e.stdout,stderr:e.stderr,error:e.message});throw e}}
const recordFlags=process.env.STORY_BENCH_LEGACY?[]:['--force'];
const record=(name,file,...args)=>fb('page',name,'record',file,...args,...recordFlags);
async function evaluate(js){return JSON.parse(await fb('eval','https://www.facebook.com/fixture',js))}
async function recordedPixel(bytes){await fb('page','media-check','open','https://www.facebook.com/fixture');try{return JSON.parse(await fb('page','media-check','eval',`(async()=>{const v=document.createElement('video');v.muted=true;v.src='data:video/webm;base64,${bytes.toString('base64')}';document.body.append(v);await new Promise((ok,bad)=>{v.onloadeddata=ok;v.onerror=bad});await v.play();await new Promise(ok=>v.requestVideoFrameCallback(ok));const c=document.createElement('canvas');c.width=1;c.height=1;const g=c.getContext('2d');g.drawImage(v,0,0,1,1);return [...g.getImageData(0,0,1,1).data]})()`))}finally{await fb('page','media-check','close')}}
try{
 let portInfo;for(let i=0;i<150;i++){try{portInfo=await readFile(path.join(temp,'chrome/DevToolsActivePort'),'utf8');break}catch{await new Promise(r=>setTimeout(r,100))}}
 assert(portInfo,'Chrome started');const [port,wsPath]=portInfo.trim().split('\n');
 socket=new WebSocket('ws://127.0.0.1:'+port+wsPath);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
 socket.onclose=()=>{closed=true;cancelCalls()};
 const fixture=await readFile(path.join(root,'tests/fixture.html'),'utf8');
 const storyVideo=await readFile(path.join(root,'tests/story-fixture.webm'));
 socket.onmessage=async ev=>{const m=JSON.parse(ev.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}return}try{
  if(m.method==='Target.detachedFromTarget'){detached.add(m.params.sessionId);cancelCalls(m.params.sessionId)}
  if(m.method==='Target.attachedToTarget'){const s=m.params.sessionId;targetSessions.set(m.params.targetInfo.targetId,s);report.push({attachedTarget:{type:m.params.targetInfo.type,url:m.params.targetInfo.url,waitingForDebugger:m.params.waitingForDebugger}});await call('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]},s);if(m.params.waitingForDebugger)await call('Runtime.runIfWaitingForDebugger',{},s)}
  if(m.method==='Fetch.requestPaused'){const u=new URL(m.params.request.url);if(u.pathname==='/media-stall')mediaStallRequests++;if(u.pathname==='/photo.php'&&u.searchParams.has('fbid'))photoDetailRequests++;if(u.pathname==='/fixture/story.webm'||u.pathname==='/fixture/cross-origin.webm'){const range=Object.entries(m.params.request.headers).find(([k])=>k.toLowerCase()==='range')?.[1]?.match(/^bytes=(\d+)-(\d*)$/);const start=range?Number(range[1]):0,end=range?.[2]?Math.min(Number(range[2]),storyVideo.length-1):storyVideo.length-1;const headers=[{name:'Content-Type',value:'video/webm'},{name:'Accept-Ranges',value:'bytes'}];if(range)headers.push({name:'Content-Range',value:`bytes ${start}-${end}/${storyVideo.length}`});await call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:range?206:200,responseHeaders:headers,body:storyVideo.subarray(start,end+1).toString('base64')},m.sessionId);return}if(u.pathname==='/fixture/redirect-away'||u.pathname==='/stories/login'){await call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:302,responseHeaders:[{name:'Location',value:u.pathname==='/stories/login'?'https://www.facebook.com/login':'https://example.test/login'}]},m.sessionId);return}if(u.pathname==='/fixture/cancel-start')cancelHoverStarted=true;const page=u.pathname.startsWith('/stories/fixture')?fixture.replace('const main=',`window.__serverStorySeen=${storySeenRequests>0};const main=`):fixture;let body=Buffer.from(['www.facebook.com','example.test'].includes(u.hostname)?page:'').toString('base64');if(u.pathname==='/api/graphql/'){const form=m.params.request.method==='GET'?u.searchParams:new URLSearchParams(m.params.request.postData);const docId=u.searchParams.get('doc_id')||form.get('doc_id');if(form.get('__crn')==='duplicate-b')await new Promise(resolve=>setTimeout(resolve,800));if(docId==='111')storySeenRequests++;if(docId==='27028962643386672')photoQueryRequests++;const p=JSON.parse(form.get('variables'));const mode=p?.receiptMode;body=Buffer.from(docId==='27028962643386672'?JSON.stringify({padding:form.get('__crn')==='large'?'x'.repeat(8*1024*1024+1):'',data:{node:{id:'collection',pageItems:{edges:[{node:{__typename:'TimelineAppCollectionItem',node:{__typename:'Photo',id:['ranked','missing-page','three'].includes(form.get('__crn'))?'1':form.get('__crn')==='extra-b'?'3':'2',viewer_image:{uri:form.get('__crn')==='empty'?'':form.get('__crn')==='rehydrate'?'https://fixture.fbcdn.net/media':form.get('__crn')==='ranked'?'https://top.fbcdn.net/media':form.get('__crn')==='expired'?'https://fresh.fbcdn.net/media':form.get('__crn')==='missing-page'?'https://late.fbcdn.net/media':form.get('__crn')==='invalid-later'?'https://allowed.fbcdn.net/media':form.get('__crn')==='three'?'https://third.fbcdn.net/media':'https://invalid.example/2.jpg'}}}},...(form.get('__crn')==='duplicate-a'?[{node:{__typename:'TimelineAppCollectionItem',node:{__typename:'Photo',id:'3',viewer_image:{uri:'https://invalid.example/3.jpg'}}}}]:[])],page_info:form.get('__crn')==='oversize'?{end_cursor:'x'.repeat(4097),has_next_page:true}:{end_cursor:'cursor2',has_next_page:false}}}}}):mode==='malformed'?'not json':JSON.stringify(p?{data:{story_create:{story:{url:mode==='external'?'https://example.test/fixture/posts/'+p.id:'https://www.facebook.com/fixture/posts/'+p.id,default_actor:{id:mode==='wrongActor'?'999':'12345'}}}}}:{errors:[{message:'fixture publish failed'}]})).toString('base64')}await call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body},m.sessionId)}
 }catch(e){if(!(e instanceof TargetClosed)&&!e.message.includes('Session with given id not found'))report.push({harnessError:e.message,event:m.method,sessionId:m.sessionId||m.params.sessionId})}};
 report.push({runtime:{node:process.version,platform:process.platform,browser:await call('Browser.getVersion')}});
 await call('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});
 await call('Storage.setCookies',{cookies:[{name:'c_user',value:'12345',domain:'.facebook.com',path:'/'},{name:'story_fixture',value:'primary',domain:'.facebook.com',path:'/',secure:true},{name:'story_fixture',value:'partitioned',domain:'.facebook.com',path:'/',secure:true,sameSite:'None',partitionKey:{topLevelSite:'https://example.test',hasCrossSiteAncestor:true}}]});
 env={...process.env,FB_STATE:path.join(temp,'state'),FB_CDP:'ws://127.0.0.1:'+port+wsPath,FB_TIMEOUT:'40'};delete env.FB_SOCK;
 assert.match(await fb('status'),/logged in as 12345/);
 const failures=[];
 async function check(name,fn){if(process.env.E2E_ONLY&&!name.includes(process.env.E2E_ONLY))return;try{await fn();report.push({check:name,pass:true})}catch(e){failures.push(name);report.push({check:name,pass:false,error:e.message})}finally{if(name.startsWith('recipient nickname'))await evaluate('for(const key of Object.keys(localStorage))if(key.startsWith("recipient"))localStorage.removeItem(key);JSON.stringify(true)')}}
 await check('recipient nickname bridge: friend name, profile ref, handle and URL',async()=>{
  await evaluate('localStorage.recipientMode="true";localStorage.restored="true";JSON.stringify(true)');
  const text='recipient identity check';
  assert.match(await fb('send','Alice Nguyễn',text),/^sent\tAlice Nguyễn$/);
  assert.equal(await evaluate('JSON.stringify(localStorage.sentThread&&JSON.parse(localStorage.sentThread))'),'/messages/e2ee/t/900/');
  assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.messages).filter(x=>x==="recipient identity check").length)'),1);
  const row=(await fb('friends','me','-n','10')).split('\n').find(x=>x.startsWith('Alice Nguyễn\t')),ref=row.split('\t')[1];
  const before=await evaluate('JSON.stringify(JSON.parse(localStorage.messages).length)');
  for(const spec of [ref,'@friend-test','https://www.facebook.com/friend-test']){
   const result=await fb('send',spec,'not sent','--dry');assert.match(result,/^dry: .*not sent/);
  }
  assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.messages).length)'),before);
  assert.match(await fb('read','Alice Nguyễn','-n','1'),/me: recipient identity check/);
  assert.match(await fb('send','Moon (Work)','nickname still works','--dry'),/^dry: .*nickname still works/);
  await fb('page','recipient-proof','open','https://www.facebook.com/messages/e2ee/t/900/');
  const snap=await fb('page','recipient-proof','snapshot');assert.match(snap,/Moon \(Work\)/);
  await fb('page','recipient-proof','shot',path.join(out,'recipient-nickname.png'));await fb('page','recipient-proof','close');
 });
 await check('recipient nickname bridge: ambiguous or incomplete friends fail closed',async()=>{
  await evaluate('localStorage.recipientMode="true";localStorage.restored="true";JSON.stringify(true)');
  const before=await evaluate('JSON.stringify(JSON.parse(localStorage.messages||"[]"))');
  await evaluate('localStorage.recipientFriends=JSON.stringify([{name:"Alice Nguyễn",path:"/friend-test"},{name:"Alice Nguyễn",path:"/other-friend"}]);JSON.stringify(true)');
  await assert.rejects(()=>fb('send','Alice Nguyễn','must not send'),/ambiguous.*Alice Nguyễn/);
  await evaluate('localStorage.recipientFriends=JSON.stringify([{name:"Alice Nguyễn",path:"/friend-test"},{name:"Alice Nguyễn",path:"/other-friend",mutual:false}]);JSON.stringify(true)');
  await assert.rejects(()=>fb('send','Alice Nguyễn','must not send'),/ambiguous.*Alice Nguyễn/);
  await evaluate('localStorage.recipientFriends=JSON.stringify([{name:"Alice Nguyễn",path:"/friend-test"},{name:"Alice Nguyễn",path:"/other-friend",unavailable:true}]);JSON.stringify(true)');
  await assert.rejects(()=>fb('send','Alice Nguyễn','must not send'),/ambiguous.*Alice Nguyễn/);
  await evaluate('localStorage.removeItem("recipientFriends");localStorage.recipientUnparsed="true";JSON.stringify(true)');
  await assert.rejects(()=>fb('send','Alice Nguyễn','must not send'),/could not finish.*friend/);
  await evaluate('localStorage.removeItem("recipientUnparsed");localStorage.recipientIncomplete="true";JSON.stringify(true)');
  await assert.rejects(()=>fb('send','Alice Nguyễn','must not send'),/could not finish.*friend/);
  await evaluate('localStorage.removeItem("recipientIncomplete");JSON.stringify(true)');
  await assert.rejects(()=>fb('send','Alice','must not send'),/no chat.*exact friend/);
  assert.deepEqual(await evaluate('JSON.stringify(JSON.parse(localStorage.messages||"[]"))'),before);
 });
 await check('recipient nickname bridge: unverified menu or foreign thread never sends',async()=>{
  await evaluate('localStorage.recipientMode="true";localStorage.restored="true";JSON.stringify(true)');
  const before=await evaluate('JSON.stringify(JSON.parse(localStorage.messages||"[]"))');
  for(const flag of ['recipientWrongMenu','recipientForeignLink']){
   await evaluate(`localStorage.${flag}="true";JSON.stringify(true)`);
   try{await assert.rejects(()=>fb('send','@friend-test','must not send'),/could not resolve a verified Messenger thread from this profile/)}finally{await evaluate(`localStorage.removeItem("${flag}");JSON.stringify(true)`)}
  }
  for(const spec of ['@Alice Nguyễn','@..','https://www.facebook.com/fixture/posts/100'])await assert.rejects(()=>fb('send',spec,'must not send'),/profile|handle|person/);
  assert.deepEqual(await evaluate('JSON.stringify(JSON.parse(localStorage.messages||"[]"))'),before);
 });
 await check('recipient nickname bridge: lazy grouped duplicate fails closed',async()=>{
  await evaluate('localStorage.recipientMode="true";localStorage.recipientGrouped="true";localStorage.restored="true";JSON.stringify(true)');
  const before=await evaluate('JSON.stringify(JSON.parse(localStorage.messages||"[]"))');
  await assert.rejects(()=>fb('send','Alice Nguyễn','must not type into first row','--dry'),/ambiguous.*Alice Nguyễn/);
  assert.deepEqual(await evaluate('JSON.stringify(JSON.parse(localStorage.messages||"[]"))'),before);
 });
 await check('recipient nickname bridge: incomplete chats never fall through to friends',async()=>{
  await evaluate('localStorage.recipientMode="true";localStorage.recipientChatIncomplete="true";localStorage.restored="true";JSON.stringify(true)');
  await fb('chats','-n','5000');
  const before=await evaluate('JSON.stringify(JSON.parse(localStorage.messages||"[]"))');
  await assert.rejects(()=>fb('send','Alice Nguyễn','must not fall through','--dry'),/could not finish scanning your chat list/);
  assert.deepEqual(await evaluate('JSON.stringify(JSON.parse(localStorage.messages||"[]"))'),before);
 });
 await check('recipient nickname bridge: replaced friend section never certifies stale rows',async()=>{
  await evaluate('localStorage.recipientMode="true";localStorage.recipientReplace="true";localStorage.restored="true";JSON.stringify(true)');
  const before=await evaluate('JSON.stringify(JSON.parse(localStorage.messages||"[]"))');
  await assert.rejects(()=>fb('send','Alice Nguyễn','stale section must not type','--dry'),/could not finish scanning your friend list|ambiguous/);
  assert.deepEqual(await evaluate('JSON.stringify(JSON.parse(localStorage.messages||"[]"))'),before);
 });
 await check('search arbitrary clues and limit',async()=>{
  const result=(await fb('search','Alice','--match',' paris ','--match','dai hoc','-n','1')).split('\n');
  assert.equal(result.length,1);assert.match(result[0],/^Alice One\tu[a-z0-9]+\t.*Paris.*Đại học NEOMA$/);
  await assert.rejects(()=>fb('stories',result[0].split('\t')[1]),/unsupported media host/);
  assert.match(await fb('search','Alice','--match','Science Academy','-n','1'),/^Alice One\t/);
  assert.match(await fb('search','Alice','--match','Mira','-n','1'),/^Mira\t/);
  assert.match(await fb('search','Alice','--match','Visible College','-n','1'),/^Alice Three\t/);
  const both=(await fb('search','Alice','--match','PARIS','--match','NEOMA','-n','2')).split('\n');
  assert.deepEqual(both.map(row=>row.split('\t')[0]),['Alice One','Alice Two']);
  assert.equal(await fb('search','Alice','--match','Secret University','-n','1'),'');
  assert.equal(await fb('search','Alice','--match','Hidden College','-n','1'),'');
  assert.equal(await fb('search','Alice','--match','Ghost College','-n','1'),'');
  assert.match(await fb('search','Sparse','--match','Rare University','-n','1'),/^Sparse 16\tu[a-z0-9]+\tRare University$/);
  assert.match(await fb('search','Recycled','--match','Rare University','-n','1'),/^Recycled 16\tu[a-z0-9]+\t/);
  assert.match(await fb('search','Reveal','--match','Paris','-n','1'),/^Earlier\t/);
  assert.match(await fb('search','Delayed','--match','Paris','-n','1'),/^Delayed\t/);
  assert.match(await fb('search','Alias','--match','Paris','-n','1'),/^Marc\t/);
  assert.match(await fb('search','Alias','--match','Academy','-n','1'),/^Marc\t/);
  const emptyStart=performance.now();assert.equal(await fb('search','Empty','-n','1'),'');assert(performance.now()-emptyStart<10000);
  assert.equal(await fb('search','Ambiguous','--match','Alice','-n','1'),'');
  const start=performance.now();assert.equal(await fb('search','Ticker','--match','Missing','-n','1'),'');assert(performance.now()-start<18000);
  const postRef=(await fb('search','Alice','--type','posts','-n','1')).split('\t')[1];await assert.rejects(()=>fb('stories',postRef),/need a profile URL or ref/);
  await assert.rejects(()=>fb('stories','Alice Person'),/search.*profile ref/);
  await assert.rejects(()=>fb('stories','Alice'),/search.*profile ref/);
 });
 await check('account story download remains protected',async()=>{
  storySeenRequests=0;const dir=path.join(out,'account-stories');await mkdir(dir,{recursive:true});
  await assert.rejects(()=>fb('stories','/media-user','--out',dir),/unsupported media host/);
  assert.equal(storySeenRequests,0);assert.deepEqual(await readdir(dir),[]);
  await assert.rejects(()=>fb('stories','/media-no-story','--out',dir),/no story visible/);
  assert.equal(storySeenRequests,0);
 });
 await check('account photo pagination remains protected',async()=>{
  storySeenRequests=0;photoQueryRequests=0;photoDetailRequests=0;const dir=path.join(out,'account-photos');await mkdir(dir,{recursive:true});
  await assert.rejects(()=>fb('photos','/media-user','--out',dir,'-n','2'),/invalid media (?:URL|host)|unsupported media host/);
  assert(photoQueryRequests>=1&&photoQueryRequests<=2);assert.equal(photoDetailRequests,0);assert.equal(storySeenRequests,0);assert.deepEqual(await readdir(dir),[]);
  photoQueryRequests=0;
  await assert.rejects(()=>fb('photos','/media-fetch','--out',dir,'-n','1'),/invalid media (?:URL|host)|unsupported media host/);
  assert(photoQueryRequests>=1&&photoQueryRequests<=2);assert.equal(photoDetailRequests,0);assert.equal(storySeenRequests,0);
  for(const route of ['/media-get-xhr','/media-get-fetch']){photoQueryRequests=0;await assert.rejects(()=>fb('photos',route,'--out',dir,'-n','1'),/invalid media (?:URL|host)|unsupported media host/);assert(photoQueryRequests>=1&&photoQueryRequests<=2)}
  assert.equal(photoDetailRequests,0);assert.equal(storySeenRequests,0);photoQueryRequests=0;
  await assert.rejects(()=>fb('photos','/media-overcursor','--all','--out',dir),/photo pagination blocked/);
  assert.equal(photoQueryRequests,1);assert.equal(storySeenRequests,0);photoQueryRequests=0;
  await assert.rejects(()=>fb('photos','/media-large','--all','--out',dir),/photo pagination blocked/);
  assert.equal(photoQueryRequests,1);assert.equal(storySeenRequests,0);photoQueryRequests=0;
  await assert.rejects(()=>fb('photos','/media-empty','--out',dir,'-n','1'),/invalid media (?:URL|host)|unsupported media host/);
  assert(photoQueryRequests>=1&&photoQueryRequests<=2);assert.equal(photoDetailRequests,1);assert.equal(storySeenRequests,0);photoQueryRequests=0;
  await assert.rejects(()=>fb('photos','/media-parallel','--all','--out',dir),/photo pagination blocked/);
  assert.equal(photoQueryRequests,4);assert.equal(storySeenRequests,0);photoQueryRequests=0;
  await assert.rejects(()=>fb('photos','/media-parallel-fetch','--all','--out',dir),/photo pagination blocked/);
  assert.equal(photoQueryRequests,4);assert.equal(storySeenRequests,0);photoQueryRequests=0;
  await assert.rejects(()=>fb('photos','/media-duplicate','--all','--out',dir),/photo pagination blocked/);
  assert.equal(photoQueryRequests,2);assert.equal(storySeenRequests,0);photoQueryRequests=0;
  await assert.rejects(()=>fb('photos','/media-extra','--all','--out',dir),/photo list incomplete/);
  assert(photoQueryRequests>=2&&photoQueryRequests<=4);assert.equal(storySeenRequests,0);photoQueryRequests=0;
  await assert.rejects(()=>fb('photos','/media-initial-extra','--all','--out',dir),/photo list incomplete/);
  assert(photoQueryRequests>=1&&photoQueryRequests<=2);assert.equal(storySeenRequests,0);photoQueryRequests=0;
  const preparingStart=performance.now();await assert.rejects(()=>fb('photos','/media-preparing','--all','--out',dir),/photo pagination blocked/);
  assert(performance.now()-preparingStart>=600);assert(photoQueryRequests>=1&&photoQueryRequests<=2);assert.equal(storySeenRequests,0);
  const beforeSlow=photoQueryRequests;await assert.rejects(()=>fb('photos','/media-slowlimit','--all','--out',dir),/photo pagination blocked/);
  assert(photoQueryRequests-beforeSlow<=4);const afterSlow=photoQueryRequests;
  for(const route of ['/media-null-vars','/media-null-fetch','/media-null-get'])await assert.rejects(()=>fb('photos',route,'--all','--out',dir),/photo pagination blocked/);
  assert.equal(photoQueryRequests,afterSlow);
  await assert.rejects(()=>fb('photos','/media-rotated','--all','--out',dir),/photo pagination blocked/);
  assert.equal(photoQueryRequests,afterSlow);assert.equal(storySeenRequests,0);
 });
 await check('account media respects timeout',async()=>{
  const previous=env;env={...env,FB_STATE:path.join(temp,'to'),FB_TIMEOUT:'2'};mediaStallRequests=0;
  try{await fb('status');const start=performance.now();await assert.rejects(()=>fb('stories','/media-stall'),/timed out after 2s/);assert(mediaStallRequests>0);assert(performance.now()-start<8000)}finally{await fb('stop').catch(()=>{});env=previous}
 });
 await check('account media batch respects tab limit',async()=>{
  const previous=env;env={...env,FB_STATE:path.join(temp,'slots'),FB_TABS:'1'};photoDetailRequests=0;
  let maxContexts=0,sampling=null;const timer=setInterval(()=>{if(!sampling)sampling=call('Target.getBrowserContexts').then(r=>{maxContexts=Math.max(maxContexts,r.browserContextIds.length)}).finally(()=>sampling=null)},25);
  try{
   await fb('status');
   const one=JSON.stringify(path.join(temp,'media-one')),two=JSON.stringify(path.join(temp,'media-two'));
   await assert.rejects(()=>fb('batch',`photos /media-empty --out ${one} -n 1`,`photos /media-empty --out ${two} -n 1`),e=>{assert.equal((e.stdout.match(/! error:/g)||[]).length,2);return true});
   assert.equal(photoDetailRequests,2);assert(maxContexts<=1,'protected contexts exceeded FB_TABS: '+maxContexts);
  }finally{clearInterval(timer);if(sampling)await sampling;await fb('stop').catch(()=>{});env=previous}
 });
 await check('account photo uses later direct URL',async()=>{
  const previous=env,connects=[];const proxy=createServer(socket=>{socket.once('data',data=>{const match=data.toString().match(/^CONNECT ([^ ]+) /);if(match)connects.push(match[1]);socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n')})});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));const address=proxy.address();const proxyUrl='http://127.0.0.1:'+address.port;
  env={...env,FB_STATE:path.join(temp,'hydrate'),FB_TABS:'1',HTTPS_PROXY:proxyUrl,https_proxy:proxyUrl,ALL_PROXY:'',all_proxy:'',NO_PROXY:'',no_proxy:''};photoDetailRequests=0;
  try{await fb('status');await assert.rejects(()=>fb('photos','/media-rehydrate','--out',path.join(temp,'hydrate-out'),'-n','2'),/unsupported media host/);assert.deepEqual(connects,['fixture.fbcdn.net:443']);assert.equal(photoDetailRequests,1);
   await assert.rejects(()=>fb('photos','/media-ranked','--out',path.join(temp,'ranked-out'),'-n','1'),/unsupported media host/);assert.deepEqual(connects,['fixture.fbcdn.net:443','top.fbcdn.net:443']);assert.equal(photoDetailRequests,2);
   await assert.rejects(()=>fb('photos','/media-expired','--out',path.join(temp,'expired-out'),'-n','2'),/unsupported media host/);assert.deepEqual(connects,['fixture.fbcdn.net:443','top.fbcdn.net:443','expired.fbcdn.net:443','fresh.fbcdn.net:443']);assert.equal(photoDetailRequests,3);
   await assert.rejects(()=>fb('photos','/media-initial-expired','--out',path.join(temp,'initial-expired-out'),'-n','1'),/media request failed/);assert.deepEqual(connects.slice(-2),['expired.fbcdn.net:443','fresh.fbcdn.net:443']);assert.equal(photoDetailRequests,4);
   await assert.rejects(()=>fb('photos','/media-missing-page','--out',path.join(temp,'missing-page-out'),'-n','1'),/media request failed/);assert.equal(connects.at(-1),'late.fbcdn.net:443');assert.equal(photoDetailRequests,5);
   await assert.rejects(()=>fb('photos','/media-invalid-later','--out',path.join(temp,'invalid-later-out'),'-n','2'),/unsupported media host/);assert.equal(connects.at(-1),'allowed.fbcdn.net:443');assert.equal(photoDetailRequests,6);
   await assert.rejects(()=>fb('photos','/media-three-urls','--out',path.join(temp,'three-urls-out'),'-n','1'),/media request failed/);assert.deepEqual(connects.slice(-3),['first.fbcdn.net:443','second.fbcdn.net:443','third.fbcdn.net:443']);assert.equal(photoDetailRequests,7)}
  finally{await fb('stop').catch(()=>{});env=previous;await new Promise(resolve=>proxy.close(resolve))}
 });
 await check('protected story receipt and unread indicator',async()=>{
  const create=async(name,action)=>{const prior=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));const snap=await fb('page',name,action,'https://www.facebook.com/stories/fixture');const target=(await call('Target.getTargets')).targetInfos.find(t=>!prior.has(t.targetId)&&t.url==='https://www.facebook.com/stories/fixture');assert(target,'story target exists');const session=targetSessions.get(target.targetId);assert(session,'fixture attached');return {snap,session,context:target.browserContextId}};
  const read=async(session,expression)=>(await call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session)).result.value;
  const watch=async(name,action)=>{const page=await create(name,action),row=page.snap.split('\n').find(l=>/^e/.test(l)&&l.includes('Watch fixture story'));assert(row,'story button visible');await fb('page',name,'click',row.split('\t')[0]);return read(page.session,'window.__fb.waitFor(()=>localStorage.storyResult,10000).then(()=>JSON.parse(localStorage.storyResult))')};
  assert.deepEqual(await watch('story-normal','open'),{queried:true,viewed:true,xhrViewed:true,spoofViewed:true,getViewed:true,urlSpoofViewed:true});await fb('page','story-normal','close');assert.equal(storySeenRequests,5);
  const normalAgain=await create('story-normal','open');assert.equal(await read(normalAgain.session,'getComputedStyle(document.querySelector("#avatar")).borderTopColor'),'rgb(128, 128, 128)');await fb('page','story-normal','close');
  storySeenRequests=0;
  assert.deepEqual(await watch('story-protected','stories'),{queried:true,viewed:false,xhrViewed:false,spoofViewed:false,getViewed:false,urlSpoofViewed:false});assert.equal(storySeenRequests,0);
  const storySnapshot=await fb('page','story-protected','snapshot');assert.match(storySnapshot,/Story frame/);assert.match(storySnapshot,/Story caption/);await assert.rejects(()=>fb('page','story-protected','cdp','Fetch.disable','{}'),/action unavailable/);
  const recording=path.join(out,'story-fixture.webm');assert.equal(await record('story-protected',recording,'1'),recording);
  assert.match(report.findLast(x=>x.args?.includes(recording)).stderr,/captions.*screenshot/i);
  const bytes=await readFile(recording);assert.deepEqual([...bytes.subarray(0,4)],[0x1a,0x45,0xdf,0xa3]);assert(bytes.length>100,'recording contains video');
  const pixel=await recordedPixel(bytes);assert(pixel[1]<80&&(pixel[0]>150||pixel[2]>150),'recorded the foreground story, not the green background video: '+JSON.stringify(pixel));
  const protectedAgain=await create('story-protected','stories');assert.equal(await read(protectedAgain.session,'getComputedStyle(document.querySelector("#avatar")).borderTopColor'),'rgb(0, 0, 255)');
  const cookies=(await call('Storage.getCookies',{browserContextId:protectedAgain.context})).cookies.filter(c=>c.name==='story_fixture');assert.deepEqual(cookies.map(c=>({value:c.value,partitioned:!!c.partitionKey})),[{value:'primary',partitioned:false}]);
  for(const [label,flag] of [['Open popup form','formPressed'],['Programmatic popup form','programmaticBlocked']]){const s=await fb('page','story-protected','snapshot',label),ref=s.split('\n').find(l=>/^e/.test(l)).split('\t')[0];await fb('page','story-protected','click',ref);assert.equal(await read(protectedAgain.session,`window.__fb.waitFor(()=>window.${flag},10000).then(()=>!!window.${flag})`),true);assert(!(await call('Target.getTargets')).targetInfos.some(t=>t.url.includes('/stories/fixture/unprotected')),'no unprotected popup opened')}
  const base=await fb('page','story-protected','snapshot','Base target story'),baseRef=base.split('\n').find(l=>/^e/.test(l)).split('\t')[0];await fb('page','story-protected','click',baseRef);let baseNavigated=false;for(let i=0;i<100;i++){try{if((await fb('page','story-protected','snapshot')).includes('/stories/fixture/base')){baseNavigated=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,50))}assert(baseNavigated,'inherited base target stays in the protected page');
  const next=await fb('page','story-protected','snapshot','Next fixture story'),nextRef=next.split('\n').find(l=>/^e/.test(l)).split('\t')[0];await fb('page','story-protected','click',nextRef);let navigated=false;for(let i=0;i<100;i++){try{if((await fb('page','story-protected','snapshot')).includes('/stories/fixture/next')){navigated=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,50))}assert(navigated,'new-tab story link stays in the protected page');await fb('page','story-protected','close');
 });
 await check('protected story disconnect closes the target',async()=>{
  const original=env,relay=await proxy(env.FB_CDP);let relayClosed=false;env={...env,FB_STATE:path.join(temp,'story-disconnect-state'),FB_CDP:relay.url};
  const targets=async()=>((await call('Target.getTargets')).targetInfos||[]);
  try{
   const before=new Set((await targets()).map(t=>t.targetId));await fb('page','story-disconnect','stories','https://www.facebook.com/stories/fixture');
   const target=(await targets()).find(t=>!before.has(t.targetId)&&t.url==='https://www.facebook.com/stories/fixture');assert(target,'protected target exists');
   await relay.close();relayClosed=true;const stale=assert.rejects(()=>fb('page','story-disconnect','snapshot'));let closed=false;for(let i=0;i<100;i++){if(!(await targets()).some(t=>t.targetId===target.targetId)){closed=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(closed,'disconnected story target is closed even when reconnect is unavailable');await stale;
  }finally{try{await fb('stop')}finally{if(!relayClosed)await relay.close();env=original}}
 });
 await check('protected story main connection loss closes its separate context',async()=>{
  const original=env,relay=await proxy(env.FB_CDP);env={...env,FB_STATE:path.join(temp,'story-main-loss-state'),FB_CDP:relay.url};
  try{const before=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));await fb('page','story-main-loss','stories','https://www.facebook.com/stories/fixture');const target=(await call('Target.getTargets')).targetInfos.find(t=>!before.has(t.targetId)&&t.url==='https://www.facebook.com/stories/fixture');assert(target);relay.disconnectFirst();let closed=false;for(let i=0;i<100;i++){if(!(await call('Target.getTargets')).targetInfos.some(t=>t.targetId===target.targetId)){closed=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(closed,'context closes when the main CDP connection dies')}
  finally{try{await fb('stop')}finally{await relay.close();env=original}}
 });
 await check('protected story session detach closes its separate context',async()=>{
  const original=env,relay=await proxy(env.FB_CDP);env={...env,FB_STATE:path.join(temp,'story-detach-state'),FB_CDP:relay.url};
  try{const before=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));await fb('page','story-detach','stories','https://www.facebook.com/stories/fixture');const target=(await call('Target.getTargets')).targetInfos.find(t=>!before.has(t.targetId)&&t.url==='https://www.facebook.com/stories/fixture');assert(target);relay.detachLast();let closed=false;for(let i=0;i<100;i++){if(!(await call('Target.getTargets')).targetInfos.some(t=>t.targetId===target.targetId)){closed=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(closed,'context closes when the protected session detaches')}
  finally{try{await fb('stop')}finally{await relay.close();env=original}}
 });
 await check('protected story login challenge leaves normal session usable',async()=>{
  await assert.rejects(()=>fb('page','story-login','stories','https://www.facebook.com/stories/login'),/story session.*rejected|challenged/i);await fb('page','story-login','close');assert.match(await fb('page','normal-after-challenge','open','https://www.facebook.com/fixture'),/What is on your mind/);await fb('page','normal-after-challenge','close');
 });
 await check('protected story opening keeps output compact with full snapshot available',async()=>{
  const opening=await fb('page','story-many','stories','https://www.facebook.com/stories/many-controls'),full=await fb('page','story-many','snapshot');
  assert.equal(opening.split('\n').filter(l=>/^e\w+\t/.test(l)).length,30);assert.match(opening,/more\tuse page snapshot/);assert(opening.split('\n').find(l=>l.startsWith('text\t')).length<=327);
  assert.equal(full.split('\n').filter(l=>/^e\w+\t/.test(l)).length,60);assert(full.includes('Story control 59'));await fb('page','story-many','close');
 });
 await check('protected story stalled setup disposes its context',async()=>{
  const original=env,relay=await proxy(env.FB_CDP),gate=relay.hold('Storage.setCookies');env={...env,FB_STATE:path.join(temp,'story-setup-state'),FB_CDP:relay.url};
  const contexts=async()=>((await call('Target.getBrowserContexts')).browserContextIds||[]);
  const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('setup signal timed out')),8000)})])}finally{clearTimeout(timer)}};
  try{const before=new Set(await contexts());const request=fb('page','story-setup','stories','https://www.facebook.com/stories/fixture');request.catch(()=>{});await bounded(gate.held);const context=(await contexts()).find(id=>!before.has(id));assert(context,'temporary context exists');await assert.rejects(()=>request,/preparing story session timed out/);let removed=false;for(let i=0;i<100;i++){if(!(await contexts()).includes(context)){removed=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(removed,'timed-out context is disposed')}
  finally{gate.release();try{await fb('stop')}finally{await relay.close();env=original}}
 });
 for(const [method,error,state] of [['Target.createBrowserContext',/creating story session timed out/,'ctx'],['Target.createTarget',/creating story tab timed out/,'tab']])await check('protected story stalled '+method+' disposes its context',async()=>{
  const original=env,relay=await proxy(env.FB_CDP),gate=relay.hold(method);env={...env,FB_STATE:path.join(temp,state),FB_CDP:relay.url};
  const contexts=async()=>(await call('Target.getBrowserContexts')).browserContextIds||[];
  let timer;
  try{const before=new Set(await contexts()),request=fb('page','story-stalled','stories','https://www.facebook.com/stories/fixture');request.catch(()=>{});await Promise.race([gate.held,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('setup signal timed out')),8000)})]);const context=(await contexts()).find(id=>!before.has(id));assert(context,'temporary context exists');await assert.rejects(()=>request,error);let removed=false;for(let i=0;i<100;i++){if(!(await contexts()).includes(context)){removed=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(removed,'timed-out context is disposed')}
  finally{clearTimeout(timer);gate.release();try{await fb('stop')}finally{await relay.close();env=original}}
 });
 await check('protected story stalled disposal finishes and closes its context',async()=>{
  const original=env,relay=await proxy(env.FB_CDP);env={...env,FB_STATE:path.join(temp,'story-disposal-state'),FB_CDP:relay.url};let gate,timer,resume;
  try{const before=new Set((await call('Target.getBrowserContexts')).browserContextIds);await fb('page','story-disposal','stories','https://www.facebook.com/stories/fixture');const context=(await call('Target.getBrowserContexts')).browserContextIds.find(id=>!before.has(id));assert(context,'temporary context exists');resume=relay.blockEvents('Target.detachedFromTarget');gate=relay.hold('Target.disposeBrowserContext');const request=fb('page','story-disposal','close');request.catch(()=>{});await Promise.race([gate.held,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('disposal signal timed out')),8000)})]);assert.match(await request,/closed/i);assert(!(await call('Target.getBrowserContexts')).browserContextIds.includes(context),'context is disposed')}
  finally{clearTimeout(timer);gate?.release();resume?.();try{await fb('stop')}finally{await relay.close();env=original}}
 });
 await check('protected story stalled protection releases its context and page',async()=>{
  const original=env,relay=await proxy(env.FB_CDP),gate=relay.hold('Fetch.enable');env={...env,FB_STATE:path.join(temp,'story-protection-state'),FB_CDP:relay.url};let timer;
  try{const before=new Set((await call('Target.getBrowserContexts')).browserContextIds),request=fb('page','story-protection','stories','https://www.facebook.com/stories/fixture');request.catch(()=>{});await Promise.race([gate.held,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('protection signal timed out')),8000)})]);const context=(await call('Target.getBrowserContexts')).browserContextIds.find(id=>!before.has(id));assert(context);await assert.rejects(()=>request,/protecting story session timed out/);let removed=false;for(let i=0;i<100;i++){if(!(await call('Target.getBrowserContexts')).browserContextIds.includes(context)){removed=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(removed,'timed-out context is disposed');assert.equal(await fb('page','story-protection','close'),'closed')}
  finally{clearTimeout(timer);gate.release();try{await fb('stop')}finally{await relay.close();env=original}}
 });
 await check('protected story daemon death closes the target',async()=>{
  const original=env,state=path.join(temp,'story-crash-state');env={...env,FB_STATE:state};
  const daemon=spawn(binary,['__daemon'],{env,stdio:'ignore'}),exited=new Promise(resolve=>daemon.once('close',resolve));
  try{
   const endpoint=path.join(state,process.platform==='win32'?'daemon.json':'fb.sock');let ready=false;for(let i=0;i<100;i++){try{await access(endpoint);ready=true;break}catch{await new Promise(resolve=>setTimeout(resolve,50))}}assert(ready,'test daemon is ready');
   const before=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));await fb('page','story-crash','stories','https://www.facebook.com/stories/fixture');
   const target=(await call('Target.getTargets')).targetInfos.find(t=>!before.has(t.targetId)&&t.url==='https://www.facebook.com/stories/fixture');assert(target,'protected target exists');
   daemon.kill('SIGKILL');await exited;let closed=false;for(let i=0;i<100;i++){if(!(await call('Target.getTargets')).targetInfos.some(t=>t.targetId===target.targetId)){closed=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(closed,'story context closes when daemon dies');
  }finally{daemon.kill('SIGKILL');await exited;env=original}
 });
 await check('protected story cancelled recording preserves the file',async()=>{
  const prior=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));const snap=await fb('page','story-cancel','stories','https://www.facebook.com/stories/fixture'),row=snap.split('\n').find(l=>/^e/.test(l)&&l.includes('Watch fixture story'));assert(row);const target=(await call('Target.getTargets')).targetInfos.find(t=>!prior.has(t.targetId)&&t.url==='https://www.facebook.com/stories/fixture');assert(target);const session=targetSessions.get(target.targetId);assert(session);await fb('page','story-cancel','click',row.split('\t')[0]);
  await call('Runtime.evaluate',{expression:'window.__fb.waitFor(()=>localStorage.storyResult,10000)',awaitPromise:true},session);
  const file=path.join(out,'story-cancel.webm');await writeFile(file,'untouched');const client=spawn(binary,['page','story-cancel','record',file,'2',...recordFlags],{env,stdio:'ignore'}),closed=new Promise(resolve=>client.once('close',resolve));
  try{const started=await call('Runtime.evaluate',{expression:'window.__fb.waitFor(()=>localStorage.storyRecordStarted,10000).then(()=>!!localStorage.storyRecordStarted)',awaitPromise:true,returnByValue:true},session);assert.equal(started.result.value,true);client.kill('SIGKILL');await closed;await assert.rejects(()=>fb('page','story-cancel','snapshot'));assert.equal(await readFile(file,'utf8'),'untouched')}
  finally{client.kill('SIGKILL');await closed;await fb('page','story-cancel','close')}
 });
 await check('protected story cancellation closes context even if disposal is blocked',async()=>{
  const original=env,relay=await proxy(env.FB_CDP);env={...env,FB_STATE:path.join(temp,'story-cancel-disposal-state'),FB_CDP:relay.url};let client,exited,resume;
  try{const before=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));const snap=await fb('page','cancel-disposal','stories','https://www.facebook.com/stories/fixture'),row=snap.split('\n').find(l=>/^e/.test(l)&&l.includes('Watch fixture story'));assert(row);const target=(await call('Target.getTargets')).targetInfos.find(t=>!before.has(t.targetId)&&t.url==='https://www.facebook.com/stories/fixture'),session=targetSessions.get(target.targetId);assert(session);await fb('page','cancel-disposal','click',row.split('\t')[0]);await call('Runtime.evaluate',{expression:'window.__fb.waitFor(()=>localStorage.storyResult,10000)',awaitPromise:true},session);resume=relay.blockCommands('Target.disposeBrowserContext');client=spawn(binary,['page','cancel-disposal','record',path.join(out,'cancel-disposal.webm'),'2',...recordFlags],{env,stdio:'ignore'});exited=new Promise(resolve=>client.once('close',resolve));const started=await call('Runtime.evaluate',{expression:'window.__fb.waitFor(()=>localStorage.storyRecordStarted,10000).then(()=>!!localStorage.storyRecordStarted)',awaitPromise:true,returnByValue:true},session);assert(started.result.value);client.kill('SIGKILL');await exited;await assert.rejects(()=>fb('page','cancel-disposal','snapshot'));relay.detachLast();let closed=false;for(let i=0;i<40;i++){if(!(await call('Target.getTargets')).targetInfos.some(t=>t.targetId===target.targetId)){closed=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(closed,'cancelled story context closes without waiting for disposal')}
  finally{client?.kill('SIGKILL');if(exited)await exited;resume?.();try{await fb('stop')}finally{await relay.close();env=original}}
 });
 await check('protected story stalled playback releases a cancelled page',async()=>{
  const prior=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));await fb('page','story-stall','stories','https://www.facebook.com/stories/play-stall');const target=(await call('Target.getTargets')).targetInfos.find(t=>!prior.has(t.targetId)&&t.url==='https://www.facebook.com/stories/play-stall'),session=targetSessions.get(target.targetId);assert(session);const ready=await call('Runtime.evaluate',{expression:'window.__fb.waitFor(()=>document.body.textContent.includes("Video ready"),10000)',awaitPromise:true,returnByValue:true},session);assert(ready.result.value);
  const client=spawn(binary,['page','story-stall','record',path.join(out,'story-stall.webm'),'1',...recordFlags],{env,stdio:'ignore'}),closed=new Promise(resolve=>client.once('close',resolve));
  try{const started=await call('Runtime.evaluate',{expression:'window.__fb.waitFor(()=>window.playRequested,10000).then(()=>!!window.playRequested)',awaitPromise:true,returnByValue:true},session);assert(started.result.value);client.kill('SIGKILL');await closed;const start=Date.now();await assert.rejects(()=>fb('page','story-stall','snapshot'));assert(Date.now()-start<10000,'cancelled playback releases the page');}
  finally{client.kill('SIGKILL');await closed;await fb('page','story-stall','close')}
 });
 if(process.platform==='linux'&&process.env.FB_TEST_SLOW_FSYNC_LIB)await check('protected story slow recording does not block another page',async()=>{
  const original=env,marker=path.join(temp,'sync-started'),release=path.join(temp,'sync-release');env={...env,FB_STATE:path.join(temp,'slow-sync-state'),TOKIO_WORKER_THREADS:'1',LD_PRELOAD:process.env.FB_TEST_SLOW_FSYNC_LIB,FB_TEST_SYNC_MARKER:marker,FB_TEST_SYNC_RELEASE:release};let save,other;
  try{await fb('page','slow-sync','stories','https://www.facebook.com/stories/seekable');let ready=false;for(let i=0;i<100;i++){if((await fb('page','slow-sync','snapshot')).includes('Video ready')){ready=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(ready);await fb('page','independent','open','https://www.facebook.com/fixture');save=record('slow-sync',path.join(out,'slow-sync.webm'),'1','0');save.catch(()=>{});let started=false;for(let i=0;i<200;i++){try{await access(marker);started=true;break}catch{await new Promise(resolve=>setTimeout(resolve,50))}}assert(started,'filesystem sync started');other=fb('page','independent','snapshot');other.catch(()=>{});const responsive=await Promise.race([other.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),1500))]);await writeFile(release,'release');await save;await other;assert(responsive,'another page remains responsive while disk sync is stalled')}
  finally{await writeFile(release,'release');await Promise.allSettled([save,other].filter(Boolean));try{await fb('stop')}finally{env=original}}
 });
 if(process.platform==='linux'&&process.env.FB_TEST_SLOW_FSYNC_LIB)await check('protected story timed out disk sync preserves destination',async()=>{
  const original=env,marker=path.join(temp,'timeout-sync-started'),release=path.join(temp,'timeout-sync-release'),file=path.join(out,'timeout-sync.webm');env={...env,FB_STATE:path.join(temp,'timeout-sync-state'),FB_TIMEOUT:'3',TOKIO_WORKER_THREADS:'1',LD_PRELOAD:process.env.FB_TEST_SLOW_FSYNC_LIB,FB_TEST_SYNC_MARKER:marker,FB_TEST_SYNC_RELEASE:release};let save;
  try{await writeFile(file,'untouched');await fb('page','timeout-sync','stories','https://www.facebook.com/stories/seekable');let ready=false;for(let i=0;i<100;i++){if((await fb('page','timeout-sync','snapshot')).includes('Video ready')){ready=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(ready);const start=performance.now();save=record('timeout-sync',file,'1','0');save.catch(()=>{});let started=false;for(let i=0;i<100;i++){try{await access(marker);started=true;break}catch{await new Promise(resolve=>setTimeout(resolve,50))}}assert(started,'filesystem sync started');await new Promise(resolve=>setTimeout(resolve,Math.max(0,3500-(performance.now()-start))));await writeFile(release,'release');await assert.rejects(()=>save,/timed out after 3s/);assert((await readFile(file)).equals(Buffer.from('untouched')),'existing destination is unchanged');let clean=false;for(let i=0;i<100;i++){if(!(await readdir(out)).some(n=>n.startsWith('.fb-record-'))){clean=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(clean,'temporary recording is removed')}
  finally{await writeFile(release,'release');await Promise.allSettled([save].filter(Boolean));try{await fb('stop')}finally{env=original}}
 });
 if(process.platform==='linux'&&process.env.FB_TEST_SLOW_FSYNC_LIB)await check('protected story slow cleanup does not block another page',async()=>{
  const original=env,relay=await proxy(env.FB_CDP),marker=path.join(temp,'unlink-started'),release=path.join(temp,'unlink-release');env={...env,FB_STATE:path.join(temp,'slow-unlink-state'),FB_CDP:relay.url,TOKIO_WORKER_THREADS:'1',LD_PRELOAD:process.env.FB_TEST_SLOW_FSYNC_LIB,FB_TEST_UNLINK_MARKER:marker,FB_TEST_UNLINK_RELEASE:release};let save,other,sizeGate,chunkGate;
  const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('cleanup signal timed out')),8000)})])}finally{clearTimeout(timer)}};
  try{await fb('page','slow-unlink','stories','https://www.facebook.com/stories/seekable');let ready=false;for(let i=0;i<100;i++){if((await fb('page','slow-unlink','snapshot')).includes('Video ready')){ready=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(ready);await fb('page','unlink-other','open','https://www.facebook.com/fixture');sizeGate=relay.hold('Runtime.callFunctionOn');save=record('slow-unlink',path.join(out,'slow-unlink.webm'),'1','0');save.catch(()=>{});await bounded(sizeGate.held);chunkGate=relay.hold('Runtime.callFunctionOn');sizeGate.release();await bounded(chunkGate.held);chunkGate.fail();let started=false;for(let i=0;i<100;i++){try{await access(marker);started=true;break}catch{await new Promise(resolve=>setTimeout(resolve,50))}}assert(started,'temporary-file removal started');other=fb('page','unlink-other','snapshot');other.catch(()=>{});const responsive=await Promise.race([other.then(()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),1500))]);await writeFile(release,'release');await assert.rejects(()=>save,/fixture chunk failure/);await other;assert(responsive,'another page remains responsive while cleanup is stalled')}
  finally{sizeGate?.release();chunkGate?.release();await writeFile(release,'release');await Promise.allSettled([save,other].filter(Boolean));try{await fb('stop')}finally{await relay.close();env=original}}
 });
 if(process.platform==='linux'&&process.env.FB_TEST_SLOW_FSYNC_LIB)await check('protected story guard failure during disk sync preserves destination',async()=>{
  const original=env,relay=await proxy(env.FB_CDP),marker=path.join(temp,'guard-sync-started'),release=path.join(temp,'guard-sync-release'),file=path.join(out,'guard-sync.webm');env={...env,FB_STATE:path.join(temp,'guard-sync-state'),FB_CDP:relay.url,TOKIO_WORKER_THREADS:'1',LD_PRELOAD:process.env.FB_TEST_SLOW_FSYNC_LIB,FB_TEST_SYNC_MARKER:marker,FB_TEST_SYNC_RELEASE:release};let save;
  try{await writeFile(file,'untouched');const before=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));await fb('page','guard-sync','stories','https://www.facebook.com/stories/seekable');let ready=false;for(let i=0;i<100;i++){if((await fb('page','guard-sync','snapshot')).includes('Video ready')){ready=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(ready);const target=(await call('Target.getTargets')).targetInfos.find(t=>!before.has(t.targetId)&&t.url==='https://www.facebook.com/stories/seekable');assert(target);save=record('guard-sync',file,'1','0');save.catch(()=>{});let started=false;for(let i=0;i<100;i++){try{await access(marker);started=true;break}catch{await new Promise(resolve=>setTimeout(resolve,50))}}assert(started,'filesystem sync started');relay.disconnectFirst();let closed=false;for(let i=0;i<100;i++){if(!(await call('Target.getTargets')).targetInfos.some(t=>t.targetId===target.targetId)){closed=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(closed,'story context closed');await writeFile(release,'release');await assert.rejects(()=>save,/story protection stopped|chrome connection closed/);assert((await readFile(file)).equals(Buffer.from('untouched')),'existing destination is unchanged')}
  finally{await writeFile(release,'release');await Promise.allSettled([save].filter(Boolean));try{await fb('stop')}finally{await relay.close();env=original}}
 });
 if(process.platform==='linux'&&process.env.FB_TEST_SLOW_FSYNC_LIB)await check('protected story guard failure during commit reports saved file',async()=>{
  const original=env,relay=await proxy(env.FB_CDP),marker=path.join(temp,'guard-rename-started'),release=path.join(temp,'guard-rename-release'),file=path.join(out,'guard-rename.webm');env={...env,FB_STATE:path.join(temp,'guard-rename-state'),FB_CDP:relay.url,TOKIO_WORKER_THREADS:'1',LD_PRELOAD:process.env.FB_TEST_SLOW_FSYNC_LIB,FB_TEST_RENAME_TARGET:file,FB_TEST_RENAME_MARKER:marker,FB_TEST_RENAME_RELEASE:release};let save;
  try{await writeFile(file,'untouched');const before=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));await fb('page','guard-rename','stories','https://www.facebook.com/stories/seekable');let ready=false;for(let i=0;i<100;i++){if((await fb('page','guard-rename','snapshot')).includes('Video ready')){ready=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(ready);const target=(await call('Target.getTargets')).targetInfos.find(t=>!before.has(t.targetId)&&t.url==='https://www.facebook.com/stories/seekable');assert(target);save=record('guard-rename',file,'1','0');save.catch(()=>{});let started=false;for(let i=0;i<100;i++){try{await access(marker);started=true;break}catch{await new Promise(resolve=>setTimeout(resolve,50))}}assert(started,'destination replacement started');relay.disconnectFirst();let closed=false;for(let i=0;i<100;i++){if(!(await call('Target.getTargets')).targetInfos.some(t=>t.targetId===target.targetId)){closed=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(closed,'story context closed');await writeFile(release,'release');assert.equal(await save,file);assert.match(report.findLast(x=>x.args?.includes(file)).stderr,/story protection stopped/);assert.deepEqual([...(await readFile(file)).subarray(0,4)],[0x1a,0x45,0xdf,0xa3])}
  finally{await writeFile(release,'release');await Promise.allSettled([save].filter(Boolean));try{await fb('stop')}finally{await relay.close();env=original}}
 });
 if(process.platform==='linux'&&process.env.FB_TEST_SLOW_FSYNC_LIB)await check('protected story guard failure during metadata preserves destination',async()=>{
  const original=env,relay=await proxy(env.FB_CDP),marker=path.join(temp,'guard-metadata-started'),release=path.join(temp,'guard-metadata-release'),file=path.join(out,'guard-metadata.webm');env={...env,FB_STATE:path.join(temp,'guard-metadata-state'),FB_CDP:relay.url,TOKIO_WORKER_THREADS:'1',LD_PRELOAD:process.env.FB_TEST_SLOW_FSYNC_LIB,FB_TEST_METADATA_TARGET:file,FB_TEST_METADATA_INDEX:'3',FB_TEST_METADATA_MARKER:marker,FB_TEST_METADATA_RELEASE:release};let save;
  try{await writeFile(file,'untouched');const before=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));await fb('page','guard-metadata','stories','https://www.facebook.com/stories/seekable');let ready=false;for(let i=0;i<100;i++){if((await fb('page','guard-metadata','snapshot')).includes('Video ready')){ready=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(ready);const target=(await call('Target.getTargets')).targetInfos.find(t=>!before.has(t.targetId)&&t.url==='https://www.facebook.com/stories/seekable');assert(target);save=record('guard-metadata',file,'1','0');save.catch(()=>{});let started=false;for(let i=0;i<150;i++){try{await access(marker);started=true;break}catch{await new Promise(resolve=>setTimeout(resolve,50))}}assert(started,'final metadata check started');relay.disconnectFirst();let closed=false;for(let i=0;i<100;i++){if(!(await call('Target.getTargets')).targetInfos.some(t=>t.targetId===target.targetId)){closed=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(closed,'story context closed');await writeFile(release,'release');await assert.rejects(()=>save,/story protection stopped|chrome connection closed/);assert((await readFile(file)).equals(Buffer.from('untouched')),'existing destination is unchanged')}
  finally{await writeFile(release,'release');await Promise.allSettled([save].filter(Boolean));try{await fb('stop')}finally{await relay.close();env=original}}
 });
 if(process.platform==='linux'&&process.env.FB_TEST_SLOW_FSYNC_LIB)await check('protected story cancellation during metadata preserves destination',async()=>{
  const original=env,marker=path.join(temp,'cancel-metadata-started'),release=path.join(temp,'cancel-metadata-release'),file=path.join(out,'cancel-metadata.webm');env={...env,FB_STATE:path.join(temp,'cancel-metadata-state'),TOKIO_WORKER_THREADS:'1',LD_PRELOAD:process.env.FB_TEST_SLOW_FSYNC_LIB,FB_TEST_METADATA_TARGET:file,FB_TEST_METADATA_INDEX:'3',FB_TEST_METADATA_MARKER:marker,FB_TEST_METADATA_RELEASE:release};let client,exited;
  try{await writeFile(file,'untouched');await fb('page','cancel-metadata','stories','https://www.facebook.com/stories/seekable');let ready=false;for(let i=0;i<100;i++){if((await fb('page','cancel-metadata','snapshot')).includes('Video ready')){ready=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(ready);await fb('page','cancel-other','open','https://www.facebook.com/fixture');client=spawn(binary,['page','cancel-metadata','record',file,'1','0',...recordFlags],{env,stdio:'ignore'});exited=new Promise(resolve=>client.once('close',resolve));let started=false;for(let i=0;i<150;i++){try{await access(marker);started=true;break}catch{await new Promise(resolve=>setTimeout(resolve,50))}}assert(started,'final metadata check started');client.kill('SIGKILL');await exited;await fb('page','cancel-other','snapshot');await fb('page','cancel-other','snapshot');await writeFile(release,'release');let clean=false;for(let i=0;i<100;i++){if(!(await readdir(out)).some(n=>n.startsWith('.fb-record-'))){clean=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(clean,'temporary recording is removed');assert((await readFile(file)).equals(Buffer.from('untouched')),'existing destination is unchanged')}
  finally{client?.kill('SIGKILL');await writeFile(release,'release');if(exited)await exited;try{await fb('stop')}finally{env=original}}
 });
 if(process.platform==='linux'&&process.env.FB_TEST_SLOW_FSYNC_LIB)await check('protected story guard failure during screenshot write preserves destination',async()=>{
  const original=env,relay=await proxy(env.FB_CDP),marker=path.join(temp,'shot-write-started'),release=path.join(temp,'shot-write-release'),file=path.join(out,'guard-shot.jpg');env={...env,FB_STATE:path.join(temp,'guard-shot-state'),FB_CDP:relay.url,TOKIO_WORKER_THREADS:'2',LD_PRELOAD:process.env.FB_TEST_SLOW_FSYNC_LIB,FB_TEST_WRITE_TARGET:file,FB_TEST_WRITE_MARKER:marker,FB_TEST_WRITE_RELEASE:release};let save;
  try{await writeFile(file,'untouched');const before=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));await fb('page','guard-shot','stories','https://www.facebook.com/stories/fixture');const target=(await call('Target.getTargets')).targetInfos.find(t=>!before.has(t.targetId)&&t.url==='https://www.facebook.com/stories/fixture');assert(target);save=fb('page','guard-shot','shot',file);save.catch(()=>{});let started=false;for(let i=0;i<150;i++){try{await access(marker);started=true;break}catch{await new Promise(resolve=>setTimeout(resolve,50))}}assert(started,'screenshot write started');relay.disconnectFirst();let closed=false;for(let i=0;i<100;i++){if(!(await call('Target.getTargets')).targetInfos.some(t=>t.targetId===target.targetId)){closed=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(closed,'story context closed');await writeFile(release,'release');await assert.rejects(()=>save,/story protection stopped|chrome connection closed/);assert((await readFile(file)).equals(Buffer.from('untouched')),'existing destination is unchanged')}
  finally{await writeFile(release,'release');await Promise.allSettled([save].filter(Boolean));try{await fb('stop')}finally{await relay.close();env=original}}
 });
 if(process.platform==='linux'&&process.env.FB_TEST_SLOW_FSYNC_LIB)await check('protected story guard failure during screenshot commit reports saved file',async()=>{
  const original=env,relay=await proxy(env.FB_CDP),marker=path.join(temp,'shot-rename-started'),release=path.join(temp,'shot-rename-release'),file=path.join(out,'guard-shot-rename.jpg');env={...env,FB_STATE:path.join(temp,'guard-shot-rename-state'),FB_CDP:relay.url,TOKIO_WORKER_THREADS:'1',LD_PRELOAD:process.env.FB_TEST_SLOW_FSYNC_LIB,FB_TEST_RENAME_TARGET:file,FB_TEST_RENAME_MARKER:marker,FB_TEST_RENAME_RELEASE:release};let save;
  try{await writeFile(file,'untouched');const before=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));await fb('page','guard-shot-rename','stories','https://www.facebook.com/stories/fixture');const target=(await call('Target.getTargets')).targetInfos.find(t=>!before.has(t.targetId)&&t.url==='https://www.facebook.com/stories/fixture');assert(target);save=fb('page','guard-shot-rename','shot',file);save.catch(()=>{});let started=false;for(let i=0;i<150;i++){try{await access(marker);started=true;break}catch{await new Promise(resolve=>setTimeout(resolve,50))}}assert(started,'screenshot replacement started');relay.disconnectFirst();let closed=false;for(let i=0;i<100;i++){if(!(await call('Target.getTargets')).targetInfos.some(t=>t.targetId===target.targetId)){closed=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(closed,'story context closed');await writeFile(release,'release');assert.equal(await save,file);assert.match(report.findLast(x=>x.args?.includes(file)).stderr,/story protection stopped/);assert.deepEqual([...(await readFile(file)).subarray(0,2)],[0xff,0xd8])}
  finally{await writeFile(release,'release');await Promise.allSettled([save].filter(Boolean));try{await fb('stop')}finally{await relay.close();env=original}}
 });
 await check('protected story recording offsets and cross-origin safety',async()=>{
  const ready=async(name,pathName)=>{await fb('page',name,'stories','https://www.facebook.com/stories/'+pathName);for(let i=0;i<100;i++){if((await fb('page',name,'snapshot')).includes('Video ready'))return;await new Promise(resolve=>setTimeout(resolve,50))}throw Error('fixture video did not load')};
  await ready('story-seek','seekable');const first=path.join(out,'story-first.webm'),second=path.join(out,'story-second.webm');
  await record('story-seek',first,'1','0');await record('story-seek',second,'1','2');
  const a=await recordedPixel(await readFile(first)),b=await recordedPixel(await readFile(second));assert(a[0]>150&&a[2]<80,'first offset starts in red: '+JSON.stringify(a));assert(b[2]>150&&b[0]<80,'second offset starts in blue: '+JSON.stringify(b));
  if(process.platform!=='win32'){const link=path.join(out,'story-link.webm'),target=path.join(out,'story-link-target');await rm(link,{force:true});await writeFile(target,'untouched');await symlink(target,link);await assert.rejects(()=>record('story-seek',link,'1','0'),/symlink/);assert((await lstat(link)).isSymbolicLink());assert.equal(await readFile(target,'utf8'),'untouched')}
  const existing=path.join(out,'story-directory');await mkdir(existing,{recursive:true});await writeFile(path.join(existing,'keep'),'untouched');await assert.rejects(()=>record('story-seek',existing,'1','0'));assert.equal(await readFile(path.join(existing,'keep'),'utf8'),'untouched');assert(!(await readdir(out)).some(n=>n.startsWith('.fb-record-')));await fb('page','story-seek','close');
  await ready('story-cross','cross-origin');await assert.rejects(()=>record('story-cross',path.join(out,'story-cross.webm'),'1'),/cross-origin|muted|unavailable|security/i);await fb('page','story-cross','close');
  await ready('story-replace','replace');await assert.rejects(()=>record('story-replace',path.join(out,'story-replace.webm'),'2'),/muted|unavailable/i);await fb('page','story-replace','close');
  await ready('story-replace-node','replace-node');await assert.rejects(()=>record('story-replace-node',path.join(out,'story-replace-node.webm'),'2'),/muted|unavailable/i);await fb('page','story-replace-node','close');
  const before=new Set((await call('Target.getTargets')).targetInfos.map(t=>t.targetId));await ready('story-start-error','start-error');const startTarget=(await call('Target.getTargets')).targetInfos.find(t=>!before.has(t.targetId)&&t.url==='https://www.facebook.com/stories/start-error'),startSession=targetSessions.get(startTarget.targetId);assert(startSession);await assert.rejects(()=>record('story-start-error',path.join(out,'story-start-error.webm'),'1'),/fixture start failure/);const active=await call('Runtime.evaluate',{expression:'window.activeFixtureObservers',returnByValue:true},startSession);assert.equal(active.result.value,0);await record('story-start-error',path.join(out,'story-start-ok.webm'),'1');await fb('page','story-start-error','close');
  await fb('page','story-photo','stories','https://www.facebook.com/stories/photo');await assert.rejects(()=>fb('page','story-photo','record',path.join(out,'story-photo.webm'),'1'),/shot.*--force/i);const photo=path.join(out,'story-photo.jpg');await fb('page','story-photo','shot',photo);assert((await readFile(photo)).length>0);await fb('page','story-photo','close');
  await fb('page','story-clipped','stories','https://www.facebook.com/stories/clipped');await assert.rejects(()=>record('story-clipped',path.join(out,'story-clipped.webm'),'1'),/no visible video/i);await fb('page','story-clipped','close');
 });
 for(const fixture of ['pseudo-cover','clip-path-hidden'])await check('protected story recording requires confirmation '+fixture,async()=>{
  const name='s-'+fixture,file=path.join(out,name+'.webm');await writeFile(file,'untouched');await fb('page',name,'stories','https://www.facebook.com/stories/'+fixture);try{await assert.rejects(()=>fb('page',name,'record',file,'1'),/shot.*--force/i);const shot=path.join(out,name+'.jpg');await fb('page',name,'shot',shot);assert((await readFile(shot)).length>0);assert.equal(await readFile(file,'utf8'),'untouched')}finally{await fb('page',name,'close')}
 });
 for(const fixture of ['transparent-sticker','sticker-multi','force-ambiguous'])await check('protected story confirmed video selection '+fixture,async()=>{
  const name='s-'+fixture,url='https://www.facebook.com/stories/'+fixture;await fb('page',name,'stories',url);let ready=false;for(let i=0;i<100;i++){if((await fb('page',name,'snapshot')).includes('Video ready')){ready=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(ready);const target=(await call('Target.getTargets')).targetInfos.find(t=>t.url===url),session=targetSessions.get(target.targetId);assert(session);const style=async()=>(await call('Runtime.evaluate',{expression:'JSON.stringify([document.adoptedStyleSheets.length,getComputedStyle(document.querySelector("video")).pointerEvents])',returnByValue:true},session)).result.value;
  try{const before=await style(),file=path.join(out,name+'.webm');if(fixture==='force-ambiguous')await assert.rejects(()=>record(name,file,'1','0'),/cannot identify/i);else{const shot=path.join(out,name+'.jpg');await fb('page',name,'shot',shot);assert((await readFile(shot)).length>0);await record(name,file,'1','0');const pixel=await recordedPixel(await readFile(file));assert(pixel[0]>150&&pixel[2]<80,'recorded the foreground video: '+JSON.stringify(pixel))}assert.equal(await style(),before,'hit-test styles were restored')}finally{await fb('page',name,'close')}
 });
 await check('protected story failed seeks release listeners',async()=>{
  for(const fixture of ['seek-stall','seek-throw']){
   const name='story-'+fixture,url='https://www.facebook.com/stories/'+fixture;await fb('page',name,'stories',url);let ready=false;for(let i=0;i<100;i++){if((await fb('page',name,'snapshot')).includes('Video ready')){ready=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(ready,'fixture video loaded');const target=(await call('Target.getTargets')).targetInfos.find(t=>t.url===url),session=targetSessions.get(target.targetId);assert(session);
   try{for(let i=0;i<2;i++){await assert.rejects(()=>record(name,path.join(out,name+'.webm'),'1','1'),/seek timed out|fixture seek setter failed/);const listeners=await call('Runtime.evaluate',{expression:'window.fixtureSeekListeners',returnByValue:true},session);assert.equal(listeners.result.value,0,'no seek listener remains')}}finally{await fb('page',name,'close')}
  }
 });
 for(const fixture of ['preload-none','preload-delayed'])await check('protected story records a video that loads on play '+fixture,async()=>{
  const name='story-'+fixture,url='https://www.facebook.com/stories/'+fixture;await fb('page',name,'stories',url);const target=(await call('Target.getTargets')).targetInfos.find(t=>t.url===url),session=targetSessions.get(target.targetId);assert(session);const initial=await call('Runtime.evaluate',{expression:'[document.querySelector("video").currentSrc,document.querySelector("video").readyState]',returnByValue:true},session);if(fixture==='preload-delayed')assert.equal(initial.result.value[0],'');try{const file=path.join(out,name+'.webm');await record(name,file,'1');const pixel=await recordedPixel(await readFile(file));assert(pixel[0]>150&&pixel[2]<80,'recorded loaded red video')}finally{await fb('page',name,'close')}
 });
 await check('protected story bounds rejected POST streams',async()=>{
  const name='story-large-body',url='https://www.facebook.com/stories/many-controls';await fb('page',name,'stories',url);const target=(await call('Target.getTargets')).targetInfos.find(t=>t.url===url),session=targetSessions.get(target.targetId);assert(session);
  try{const result=await call('Runtime.evaluate',{expression:`(async()=>{const probe=async url=>{let pulls=0;const body=new ReadableStream({pull(c){pulls++;c.enqueue(new Uint8Array(65536));if(pulls===64)c.close()}});try{await fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,duplex:'half'})}catch{}return pulls};const unrelated=await probe('https://example.test/upload'),graphql=await probe('/api/graphql/');let emptyPulls=0;try{await fetch('/api/graphql/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new ReadableStream({pull(c){emptyPulls++;c.enqueue(new Uint8Array(0));if(emptyPulls===6000)c.close()}}),duplex:'half'})}catch{}const start=performance.now();try{await fetch('/api/graphql/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new ReadableStream({pull(){return new Promise(()=>{})}}),duplex:'half'})}catch{}return [unrelated,graphql,emptyPulls,performance.now()-start]})()`,awaitPromise:true,returnByValue:true},session);const pulls=result.result.value;assert(pulls[0]<=2,'unrelated POST body is not consumed: '+pulls);assert(pulls[1]<=24,'GraphQL body is bounded: '+pulls);assert(pulls[2]<=4100,'empty chunks are bounded: '+pulls);assert(pulls[3]<8000,'stalled GraphQL body is bounded in time: '+pulls)}finally{await fb('page',name,'close')}
 });
 for(const fixture of ['change-seek','change-play','change-source-child'])await check('protected story source change during setup '+fixture,async()=>{
   const name='story-'+fixture,url='https://www.facebook.com/stories/'+fixture;await fb('page',name,'stories',url);let ready=false;for(let i=0;i<100;i++){if((await fb('page',name,'snapshot')).includes('Video ready')){ready=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(ready,'fixture video loaded');
   try{const file=path.join(out,name+'.webm');await rm(file,{force:true});await assert.rejects(()=>record(name,file,'1',...(fixture==='change-seek'?['1']:[])),/capture became unavailable/);await assert.rejects(()=>access(file))}finally{await fb('page',name,'close')}
 });
 if(process.env.STORY_BENCH)await check('story transfer benchmark',async()=>{
  if(process.platform!=='linux')throw Error('benchmark requires Linux process metrics');
  const original=env,state=path.join(temp,'story-bench-state'),delay=Number(process.env.STORY_BENCH_DELAY_MS||0),relay=delay?await proxy(env.FB_CDP,delay):null;env={...env,FB_STATE:state,FB_CDP:relay?.url||env.FB_CDP};
  const daemon=spawn(binary,['__daemon'],{env,stdio:'ignore'}),exited=new Promise(resolve=>daemon.once('close',resolve));
  try{
   let ready=false;for(let i=0;i<100;i++){try{await access(path.join(state,'fb.sock'));ready=true;break}catch{await new Promise(resolve=>setTimeout(resolve,50))}}assert(ready,'benchmark daemon is ready');
   const dom=process.env.STORY_BENCH_MODE==='dom',blocks=dom?1:512;const opening=performance.now();await fb('page','story-bench','stories','https://www.facebook.com/stories/'+(dom?'benchmark-dom':'benchmark'));const openMs=Math.round(performance.now()-opening);let loaded=false;for(let i=0;i<100;i++){if((await fb('page','story-bench','snapshot')).includes('Video ready')){loaded=true;break}await new Promise(resolve=>setTimeout(resolve,50))}assert(loaded,'benchmark video is ready');
   const ticks=async()=>{const stat=await readFile(`/proc/${daemon.pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');return Number(fields[11])+Number(fields[12])};
   const browserTicks=async()=>{const pending=[child.pid],result=new Map();while(pending.length){const pid=pending.pop();try{const stat=await readFile(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');result.set(pid,Number(fields[11])+Number(fields[12]));const children=await readFile(`/proc/${pid}/task/${pid}/children`,'utf8');pending.push(...children.trim().split(/\s+/).filter(Boolean).map(Number))}catch{}}return result};
   const file=path.join(temp,'bench.webm'),cpuBefore=await ticks(),browserBefore=await browserTicks(),start=performance.now();await record('story-bench',file,'1');const elapsed=performance.now()-start,cpuTicks=(await ticks())-cpuBefore,browserAfter=await browserTicks();
   const status=await readFile(`/proc/${daemon.pid}/status`,'utf8'),rss=Number(status.match(/^VmHWM:\s+(\d+) kB/m)?.[1]);assert(rss,'daemon peak memory available');
   const bytes=await readFile(file),chunk=Buffer.alloc(65536);for(let i=0;i<chunk.length;i++)chunk[i]=i%251;const expected=createHash('sha256');for(let i=0;i<blocks;i++){expected.update(Buffer.from([i>>8,i&255]));expected.update(chunk)}assert.equal(bytes.length,blocks*(65536+2));assert.equal(createHash('sha256').update(bytes).digest('hex'),expected.digest('hex'));
   const browserCpuComplete=[...browserBefore.keys()].every(pid=>browserAfter.has(pid))&&[...browserAfter.keys()].every(pid=>browserBefore.has(pid));const browserCpuTicks=browserCpuComplete?[...browserBefore].reduce((n,[pid,cpu])=>n+browserAfter.get(pid)-cpu,0):null;
   report.push({benchmark:{bytes:bytes.length,openMs,elapsedMs:Math.round(elapsed),daemonPeakKiB:rss,daemonCpuTicks:cpuTicks,browserCpuTicks,browserCpuComplete}});await fb('page','story-bench','close');await fb('stop');await exited;
  }finally{daemon.kill('SIGKILL');await exited;if(relay)await relay.close();env=original}
 });
 await check('profile extraction and obfuscated timestamp',async()=>{const posts=await fb('posts','me','-n','1');assert.match(posts,/^p\w+\t.*Existing profile post/m)});
 await check('feed authors include shared sources before reactions',async()=>{
  await fb('page','authors','open','https://www.facebook.com/fixture');
  try{
   await fb('page','authors','eval',`(()=>{const card=document.querySelector('section'),time=card.querySelector('.time'),likes=card.querySelector('[data-ad-rendering-role=like_button]');card.setAttribute('aria-posinset','1');time.href='/fixture/posts/100';card.querySelector('h3').insertAdjacentHTML('beforebegin','<b>Fixture Group</b>');likes.insertAdjacentHTML('beforebegin','<h3 data-ad-rendering-role="profile_name">Doughnut Love</h3><h3 data-ad-rendering-role="profile_name">Doughnut Love</h3><h3 style="display:none" data-ad-rendering-role="profile_name">Hidden template</h3><blockquote><h3 data-ad-rendering-role="profile_name">Quoted commenter</h3></blockquote>');likes.insertAdjacentHTML('afterend','<h3 data-ad-rendering-role="profile_name">Comment author</h3>');})()`);
   const posts=JSON.parse(await fb('page','authors','eval','window.__fbFeed.step().then(JSON.stringify)'));
   assert.equal(posts[0].author,'Fixture Group / Fixture User / Doughnut Love');
   assert.equal(posts[0].url,'/fixture/posts/100');
   assert.equal(posts[0].text,'Existing profile post');
  }finally{await fb('page','authors','close')}
 });
 await check('post text omits only actual trailing collapse controls',async()=>{
  await fb('page','posttext','open','https://www.facebook.com/fixture');
  for(const label of ['See less','Thu gọn','Afficher moins','Réduire']){
   const text=await fb('page','posttext','eval',`(()=>{const msg=document.createElement('div');msg.style.whiteSpace='pre-wrap';msg.textContent='First paragraph\\n\\nFinal paragraph ';const b=document.createElement('span');b.role='button';b.textContent=${JSON.stringify(label)};msg.append(b);document.body.append(msg);return window.__fb.postText(msg)})()`);
   assert.equal(text,'First paragraph\n\nFinal paragraph');
  }
  for(const html of ['Real prose ending See less','Real prose ending Thu gọn','Real prose ending Afficher moins','Real prose ending Réduire','Collapsed… <span role="button">See more</span>','Full story <button>Translate</button>','<button>See less</button> Real prose ending See less']){
   const result=JSON.parse(await fb('page','posttext','eval',`(()=>{const msg=document.createElement('div');msg.innerHTML=${JSON.stringify(html)};document.body.append(msg);return JSON.stringify({actual:window.__fb.postText(msg),expected:window.__fb.clean(msg.innerText)})})()`));
   assert.equal(result.actual,result.expected,'preserve prose, other actions, and unresolved collapsed text');
  }
  await fb('page','posttext','close');
 });
 await check('feed and post lists expand full text before deduplication',async()=>{
  const saved=await evaluate('JSON.stringify(JSON.parse(localStorage.posts||"null"))');
  const stories=Array.from({length:3},(_,i)=>({id:String(900+i),text:('Full story '+i+' ').repeat(60)+'END '+i,aud:'me'}));
  try{
   await evaluate(`localStorage.posts=JSON.stringify(${JSON.stringify(stories)});localStorage.collapsedBody="true";localStorage.expandDelay="120";JSON.stringify(true)`);
   for(const label of ['See more','Xem thêm','Voir plus','Afficher la suite']){
    await evaluate(`localStorage.expandLabel=JSON.stringify(${JSON.stringify(label)});JSON.stringify(true)`);
    const output=await fb('posts','me','-n','3');
    for(const story of stories)assert(output.includes(story.text),'complete post text including ending');
    assert(!output.includes(label),'expansion control is not post text');
   }
   const output=await fb('feed','--refresh','-n','3');for(const story of stories)assert(output.includes(story.text),'home feed keeps full text');
   await fb('page','expanded','open','https://www.facebook.com/fixture');
   await fb('page','expanded','eval',`for(const a of document.querySelectorAll('.time'))a.href='/fixture/posts/'+a.closest('section').dataset.post`);
   const first=JSON.parse(await fb('page','expanded','eval','window.__fbFeed.step().then(JSON.stringify)'));
   assert.equal(first.length,3);for(let i=0;i<3;i++)assert.equal(first[i].text,stories[i].text);
   assert.deepEqual(JSON.parse(await fb('page','expanded','eval','window.__fbFeed.step().then(JSON.stringify)')),[],'async expansion cannot emit duplicate cards');
   await fb('page','expanded','close');
  }finally{await evaluate(`localStorage.posts=JSON.stringify(${JSON.stringify(saved)});for(const k of ['collapsedBody','expandDelay','expandLabel'])localStorage.removeItem(k);JSON.stringify(true)`)}
 });
 await check('PIN modal send is single and confirmed in three locales',async()=>{for(const locale of ['en','vi','fr']){
  await evaluate(`localStorage.restored="false";localStorage.locale=JSON.stringify("${locale}");JSON.stringify(true)`);
  assert.match(await fb('send','42','fixture send '+locale),/^sent/);
  assert.match(await fb('read','42','-n','3'),new RegExp('me: fixture send '+locale));
  assert.equal(await evaluate(`JSON.stringify(JSON.parse(localStorage.messages).filter(x=>x==="fixture send ${locale}").length)`),1);
 }});
 await check('delayed PIN and changed drafts never send partial text',async()=>{
  await evaluate('localStorage.messages=localStorage.messages||JSON.stringify(["Earlier message"]);JSON.stringify(true)');
  const before=await evaluate('JSON.stringify(JSON.parse(localStorage.messages))');
  await evaluate('localStorage.restored="false";localStorage.pinAutofocus="true";JSON.stringify(true)');
  const text=Array.from({length:1000},(_,i)=>'line '+i).join('\n');let sent=true;
  try{await fb('send','42',text)}catch{sent=false}
  const after=await evaluate('JSON.stringify(JSON.parse(localStorage.messages||"[]"))'),added=after.slice(before.length);
  assert.deepEqual(added,sent?[text]:[],'only an exact full message or no message is allowed');
  await evaluate('localStorage.removeItem("pinAutofocus");localStorage.truncateDraft="true";JSON.stringify(true)');
  const count=after.length;await assert.rejects(()=>fb('send','42','draft must remain complete'),/draft changed.*no text was sent/);
  assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.messages||"[]").length)'),count);
  await evaluate('localStorage.removeItem("truncateDraft");JSON.stringify(true)');
 });
 await check('post receipt, Only me, view and delete',async()=>{const result=await fb('post','fixture private post','--to','me');assert.match(result,/^posted\tp\w+\t\/.*posts\//);const ref=result.split('\t')[1];assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.posts)[0].aud)'),'me');assert.match(await fb('view',ref),/fixture private post/);assert.match(await fb('delete',ref),/^deleted/);assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.posts).some(x=>x.text==="fixture private post"))'),false)});
 await check('post uploads an image in chunks and the page receives every byte',async()=>{
  const image=Buffer.alloc(7*1024*1024+1);for(let i=0;i<image.length;i++)image[i]=(i*31+i%251)&255;
  const file=path.join(temp,'upload.png');await writeFile(file,image);let sum=0;for(const x of image)sum=(sum*31+x)%1000003;
  const result=await fb('post','fixture image post','--img',file,'--to','me');assert.match(result,/^posted\tp\w+\t\//);
  assert.deepEqual(await evaluate('JSON.stringify(JSON.parse(localStorage.posts)[0].attached)'),{name:'upload.png',type:'image/png',size:image.length,sum});
  assert.match(await fb('delete',result.split('\t')[1]),/^deleted/);
 });
 await check('retained audience panes never become publish targets',async()=>{
  for(const label of ['Post','Đăng','Publier']){
   await evaluate(`localStorage.retainedAudience="true";localStorage.trailingControl="true";localStorage.postLabel=JSON.stringify(${JSON.stringify(label)});localStorage.wrongPublishTarget="false";JSON.stringify(true)`);
   const result=await fb('post','retained audience '+label,'--to','me');assert.match(result,/^posted\tp\w+\t/);assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.posts)[0].aud)'),'me');assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.wrongPublishTarget))'),false);await fb('delete',result.split('\t')[1]);
  }
  await evaluate('localStorage.removeItem("retainedAudience");localStorage.removeItem("trailingControl");localStorage.removeItem("postLabel");JSON.stringify(true)');
  await fb('page','publish','open','https://www.facebook.com/fixture');await fb('page','publish','eval','window.__fb.composeOpen()');await fb('page','publish','cdp','Input.insertText','{"text":"do not publish changed target"}');await fb('page','publish','eval','window.__fb.composePrepare()');assert.match(await fb('page','publish','eval','window.__fbPostBtn.textContent="Other action";window.__fbPostBtn.setAttribute("aria-label","Other action");window.__fb.composePress()'),/post button changed/);assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.posts).some(p=>p.text==="do not publish changed target"))'),false);await fb('page','publish','close');
 });
 await check('collapsed publish control never dispatches',async()=>{
  const original=env,before=await evaluate('JSON.stringify(JSON.parse(localStorage.posts||"[]").length)');await evaluate('localStorage.collapsedPublish="true";JSON.stringify(true)');env={...env,FB_STATE:path.join(temp,'collapsed-state'),FB_TIMEOUT:'5'};
  try{await assert.rejects(()=>fb('post','never publish collapsed control','--to','me'));assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.posts||"[]").length)'),before)}finally{try{await fb('stop')}finally{env=original;await evaluate('localStorage.removeItem("collapsedPublish");JSON.stringify(true)')}}
 });
 await check('publish inherits disabled state but permits explicit false override',async()=>{
  const original=env,before=await evaluate('JSON.stringify(JSON.parse(localStorage.posts||"[]").length)');await evaluate('localStorage.publishDisabled=JSON.stringify("inherited");JSON.stringify(true)');env={...env,FB_STATE:path.join(temp,'publish-disabled-state'),FB_TIMEOUT:'5'};
  try{await assert.rejects(()=>fb('post','never publish ancestor disabled','--to','me'));assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.posts||"[]").length)'),before)}finally{try{await fb('stop')}finally{env=original;await evaluate('localStorage.removeItem("publishDisabled");JSON.stringify(true)')}}
  await evaluate('localStorage.publishDisabled=JSON.stringify("override");JSON.stringify(true)');try{const result=await fb('post','explicit enabled override','--to','me');assert.match(result,/^posted\t/);await fb('delete',result.split('\t')[1])}finally{await evaluate('localStorage.removeItem("publishDisabled");JSON.stringify(true)')}
 });
 await check('publish revalidates after hover and every synthetic input event',async()=>{
  const before=await evaluate('JSON.stringify(JSON.parse(localStorage.posts||"[]").length)');
  try{for(const mutation of [
   ...['hide','disable','rename','detach','replace'].map(kind=>({event:'pointerover',kind})),
   {event:'mouseover',kind:'hide',queued:true},
   {event:'pointerdown',kind:'rename'},
   {event:'mousedown',kind:'disable'},
   {event:'pointerup',kind:'detach'},
   {event:'mouseup',kind:'hide'}
  ]){
   await evaluate(`localStorage.publishMutation=JSON.stringify(${JSON.stringify(mutation)});JSON.stringify(true)`);
   await assert.rejects(()=>fb('post','never publish mutated target','--to','me'));
   assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.posts||"[]").length)'),before);
  }}finally{await evaluate('localStorage.removeItem("publishMutation");JSON.stringify(true)')}
 });
 await check('snapshot omits CSS collapsed and hidden content',async()=>{
  await fb('page','visibility','open','https://www.facebook.com/fixture');await fb('page','visibility','eval',`document.body.innerHTML='<p style="visibility:collapse">COLLAPSED_TEXT</p><button style="visibility:collapse">COLLAPSED_CONTROL</button><p style="visibility:hidden">HIDDEN_TEXT</p><button>Visible action</button>'`);const snap=await fb('page','visibility','snapshot');assert(!snap.includes('COLLAPSED'));assert(!snap.includes('HIDDEN_TEXT'));assert(snap.includes('Visible action'));await fb('page','visibility','close');
 });
 await check('receipt variants: hydration, inline markup and collapsed long text',async()=>{
  for(const flag of ['delayedBody','inlineBody','collapsedBody']){
   await evaluate(`localStorage.${flag}="true";JSON.stringify(true)`);
   const text=flag==='collapsedBody'?'long post '+ 'x'.repeat(200):'fixture '+flag+' exact body';
   const receipt=await fb('post',text,'--to','me');assert.match(receipt,/^posted\tp[a-z0-9]+\t/);
   await fb('delete',receipt.split('\t')[1]);
   await evaluate(`localStorage.removeItem("${flag}");JSON.stringify(true)`);
  }
 });
 await check('explicit unlock opens persisted Enter PIN banner',async()=>{
  assert.match(await fb('unlock','1234'),/^unlocked/);
  assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.unlocked))'),true);
 });
 await check('unlock types a segmented PIN and presses Continue',async()=>{
  await evaluate('localStorage.restored="false";localStorage.pinStyle=JSON.stringify("segmented");localStorage.removeItem("unlocked");JSON.stringify(true)');
  assert.match(await fb('unlock','1234'),/^unlocked/);
  assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.unlocked))'),true);
 });
 await check('unlock walks a staged restore flow to the PIN field',async()=>{
  await evaluate('localStorage.restored="false";localStorage.pinStyle=JSON.stringify("staged");localStorage.removeItem("unlocked");JSON.stringify(true)');
  assert.match(await fb('unlock','1234'),/^unlocked/);
  assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.unlocked))'),true);
  await evaluate('localStorage.removeItem("pinStyle");localStorage.restored="true";JSON.stringify(true)');
 });
 await check('a wrong segmented PIN reports what Facebook said',async()=>{
  await evaluate('localStorage.restored="false";localStorage.removeItem("unlocked");JSON.stringify(true)');
  await assert.rejects(()=>fb('unlock','9999'),/PIN was not accepted/);
  await evaluate('localStorage.removeItem("pinStyle");localStorage.restored="true";JSON.stringify(true)');
 });
 await check('HTTP named page initializes outside a secure context',async()=>{
  assert.match(await fb('page','http','open','http://example.test/'),/^url\thttp:\/\/example.test\//);
  await fb('page','http','close');
 });
 await check('external pages never poison Facebook login state by URL substring',async()=>{
  const original=env;env={...env,FB_STATE:path.join(temp,'external-state')};
  try{
   for(const url of ['https://example.test/login?return=https://facebook.com','https://notfacebook.com/login','https://facebook.com.example.test/login','https://www.facebook.com/fixture/redirect-away','https://www.facebook.com/login-page/posts/100','https://www.facebook.com/checkpoint-story']){
    const snap=await fb('page','external','open',url);assert.match(snap,/^url\thttps:\/\//);
    if(url.endsWith('redirect-away'))assert.match(snap,/^url\thttps:\/\/example.test\/login/);
    await fb('page','normal','open','https://www.facebook.com/fixture');await fb('page','normal','close');
   }
   await fb('page','external','close');await assert.rejects(()=>fb('page','login','open','https://www.facebook.com/login'),/not logged in/);
   await assert.rejects(()=>fb('page','normal','open','https://www.facebook.com/fixture'),/session expired/);
  }finally{try{await fb('stop')}finally{env=original}}
 });
 await check('failed publish never produces a receipt or a retry',async()=>{await evaluate('localStorage.failPublish="true";JSON.stringify(true)');await assert.rejects(()=>fb('post','Existing profile post','--to','me'));await evaluate('localStorage.removeItem("failPublish");JSON.stringify(true)')});
 await check('old posts never confirm a failed creation at any hydration state',async()=>{
  for(const flag of ['oldUrlDeferred','oldHeaderPartial','oldUnmounted']){
   await evaluate(`localStorage.${flag}="true";localStorage.failPublish="true";localStorage.publishAttempted="false";JSON.stringify(true)`);
   await assert.rejects(()=>fb('post','Existing profile post','--to','me'));
   assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.posts).filter(x=>x.id==="100").length)'),1);
   await evaluate(`localStorage.removeItem("${flag}");localStorage.removeItem("failPublish");JSON.stringify(true)`);
  }
 });
 await check('invalid creation evidence never returns a post receipt',async()=>{
  for(const mode of ['wrongActor','external','malformed']){
   await evaluate(`localStorage.receiptMode=JSON.stringify("${mode}");JSON.stringify(true)`);
   await assert.rejects(()=>fb('post','invalid receipt '+mode,'--to','me'));
   await evaluate(`localStorage.posts=JSON.stringify(JSON.parse(localStorage.posts).filter(p=>p.text!=="invalid receipt ${mode}"));localStorage.removeItem("receiptMode");JSON.stringify(true)`);
  }
 });
 await check('fill rejects covered and non-text controls before editing',async()=>{
  await fb('page','fill','open','https://www.facebook.com/fixture');
  await fb('page','fill','eval','document.body.insertAdjacentHTML("beforeend",`<input aria-label="Guarded input" value="before"><input type="checkbox" aria-label="Check me">`)');
  let snap=await fb('page','fill','snapshot');const field=snap.split('\n').find(l=>/^e/.test(l)&&l.includes('Guarded input')).split('\t')[0];
  await fb('page','fill','eval','document.body.insertAdjacentHTML("beforeend",`<div id="overlay" role="dialog" style="position:fixed;inset:0;z-index:9999">Confirm?</div>`)');
  await assert.rejects(()=>fb('page','fill','fill',field,'behind modal'));
  assert.equal(await fb('page','fill','eval','document.querySelector("input").value'),'before');
  await fb('page','fill','eval','document.querySelector("#overlay").remove()');
  snap=await fb('page','fill','snapshot');const checkbox=snap.split('\n').find(l=>/^e/.test(l)&&l.includes('Check me')).split('\t')[0];
  await assert.rejects(()=>fb('page','fill','fill',checkbox,'yes'));
  assert.equal(await fb('page','fill','eval','document.querySelector("[type=checkbox]").checked'),'false');
  for(const type of ['text','search','email','url','tel','password','number']){
   const before=type==='number'?'5':'before',after=type==='number'?'42':'replacement';
   await fb('page','fill','eval',`document.querySelector("input").outerHTML='<input type="${type}" aria-label="Typed input" value="${before}">'`);
   const fresh=await fb('page','fill','snapshot','Typed input'),ref=fresh.split('\n').find(l=>/^e/.test(l)).split('\t')[0];
   await fb('page','fill','fill',ref,after);assert.equal(await fb('page','fill','eval','document.querySelector("input").value'),after);
  }
  // Lexical keeps an empty editor's caret inside its own <p><br></p>, not around the editor
  await fb('page','fill','eval',`document.body.insertAdjacentHTML("beforeend",'<div role="textbox" contenteditable="true" aria-label="Rich editor"><p><br></p></div>');const ed=document.querySelector('[aria-label="Rich editor"]');document.addEventListener('selectionchange',()=>{const s=getSelection();if(s.anchorNode===ed){const r=document.createRange();r.setStart(ed.firstChild,0);s.removeAllRanges();s.addRange(r)}});1`);
  const rich=(await fb('page','fill','snapshot','Rich editor')).split('\n').find(l=>/^e/.test(l)).split('\t')[0];
  await fb('page','fill','fill',rich,'shared text');
  assert.equal(await fb('page','fill','eval',`document.querySelector('[aria-label="Rich editor"]').textContent`),'shared text');
  await fb('page','fill','close');
 });
 await check('ARIA referenced labels redact secrets and invalidate renamed refs',async()=>{
  await fb('page','labels','open','https://www.facebook.com/fixture');
  for(const html of [
   '<span id="pinlabel">Messenger PIN</span><input aria-labelledby="pinlabel" value="654321">',
   '<span id="pinlabel" hidden>Messenger PIN</span><input aria-labelledby="pinlabel" value="654321">',
   '<span id="secure">Messenger</span><span id="pinlabel">PIN</span><input aria-label="Search" aria-labelledby="secure pinlabel" value="654321">',
   '<span id="pinlabel" aria-label="Messenger PIN">Security</span><input aria-labelledby="pinlabel" value="654321">',
   '<span id="pinlabel">Messenger <span aria-label="PIN"></span></span><input aria-labelledby="pinlabel" value="654321">',
   '<label for="pin">Messenger</label><label for="pin">PIN</label><input id="pin" value="654321">',
   '<label for="pin"><img alt="Messenger PIN"></label><input id="pin" value="654321">'
  ]){
   await fb('page','labels','eval',`document.body.innerHTML=${JSON.stringify(html)}`);
   const snap=await fb('page','labels','snapshot');assert(!snap.includes('654321'));assert(snap.includes('[redacted]'));assert.match(snap,/Messenger PIN/);
  }
  await fb('page','labels','eval',`document.body.innerHTML='<span id="title">Archive item</span><button aria-labelledby="title"></button><span id="draft">Draft</span><input aria-labelledby="draft" value="normal draft">';window.labelClicks=0;document.querySelector('button').onclick=()=>window.labelClicks++`);
  const snap=await fb('page','labels','snapshot');assert(!snap.includes('normal draft'));assert.equal(await fb('page','labels','eval','document.querySelector("input").value'),'normal draft');const ref=snap.split('\n').find(l=>l.split('\t')[2]==='Archive item').split('\t')[0];
  await fb('page','labels','eval','document.querySelector("#title").textContent="Delete item"');await assert.rejects(()=>fb('page','labels','click',ref),/stale element ref/);assert.equal(await fb('page','labels','eval','window.labelClicks'),'0');await fb('page','labels','close');
 });
 await check('snapshot form values require explicit access regardless of label',async()=>{
  await fb('page','private','open','https://www.facebook.com/fixture');
  for(const html of [
   '<input aria-label="Ordinary field" value="654321">','<textarea>654321</textarea>',
   '<div role="textbox" contenteditable="true">654321</div>','<select><option selected>654321</option></select>',
   '<label for="pin"><img alt="Messenger PIN"></label><input id="pin" value="654321">'
  ]){
   await fb('page','private','eval',`document.body.innerHTML=${JSON.stringify(html)}`);const snap=await fb('page','private','snapshot');assert(!snap.includes('654321'));assert(snap.includes('[redacted]'));
  }
  assert.equal(await fb('page','private','eval','document.querySelector("input").value'),'654321');await fb('page','private','close');
 });
 await check('snapshot uses effective contenteditable modes and omits whole drafts',async()=>{
  await fb('page','editable','open','https://www.facebook.com/fixture');
  for(const token of ['', 'plaintext-only', 'TRUE', 'true']){
   const html=`<div contenteditable="${token}" aria-label="Draft"><span>SECRET_DRAFT</span><span contenteditable="false">PRIVATE_ISLAND</span></div><div contenteditable="false">ordinary false</div><div contenteditable="invalid">ordinary invalid</div>`;
   await fb('page','editable','eval',`document.body.innerHTML=${JSON.stringify(html)}`);
   const snap=await fb('page','editable','snapshot');assert(!snap.includes('SECRET_DRAFT'));assert(!snap.includes('PRIVATE_ISLAND'));assert(snap.includes('ordinary false ordinary invalid'));
   const rows=snap.split('\n').filter(l=>/^e/.test(l));assert.equal(rows.length,1);assert.match(rows[0],/\ttextbox\tDraft\t\[redacted\]$/);
   await fb('page','editable','fill',rows[0].split('\t')[0],'replacement draft');assert.equal(await fb('page','editable','eval','document.querySelector("div").innerText'),'replacement draft');
  }
  await fb('page','editable','eval',`document.body.innerHTML='<div contenteditable="plaintext-only" aria-label="Inherited draft"><div contenteditable="invalid">SECRET_INHERITED</div></div>'`);
  const snap=await fb('page','editable','snapshot');assert(!snap.includes('SECRET_INHERITED'));const rows=snap.split('\n').filter(l=>/^e/.test(l));assert.equal(rows.length,1);await fb('page','editable','fill',rows[0].split('\t')[0],'inherited replacement');assert.equal(await fb('page','editable','eval','document.querySelector("[aria-label]").innerText'),'inherited replacement');await fb('page','editable','close');
 });
 await check('snapshot ancestor control names never promote nested drafts',async()=>{
  await fb('page','nested','open','https://www.facebook.com/fixture');
  for(const html of [
   '<div role="button">Public action<div contenteditable="true">PRIVATE_NESTED_DRAFT</div></div>',
   '<a href="#action">Public action<div contenteditable="plaintext-only">PRIVATE_NESTED_DRAFT</div></a>',
   '<div role="button">Public action<textarea>PRIVATE_NESTED_DRAFT</textarea></div>',
   '<div role="button">Public action<div contenteditable="">PRIVATE_NESTED_DRAFT</div></div>',
   '<p>Public action</p><div contenteditable="true"><button contenteditable="false">PRIVATE_NESTED_DRAFT</button></div>'
  ]){
   await fb('page','nested','eval',`document.body.innerHTML=${JSON.stringify(html)}`);const snap=await fb('page','nested','snapshot');assert(!snap.includes('PRIVATE_NESTED_DRAFT'));assert(snap.includes('Public action'));assert(snap.includes('[redacted]'));
  }
  await fb('page','nested','close');
 });
 await check('native disabled fieldsets reject children but preserve first legend',async()=>{
  await fb('page','disabled','open','https://www.facebook.com/fixture');
  await fb('page','disabled','eval',`window.disabledClicks=0;document.body.insertAdjacentHTML('beforeend','<fieldset disabled><legend><button id="legend">Allowed legend</button></legend><button id="blocked">Disabled child</button><input aria-label="Disabled draft" value="original"></fieldset>');document.querySelector('#legend').onclick=()=>window.disabledClicks++;document.querySelector('#blocked').onclick=()=>window.disabledClicks+=100`);
  const ref=async label=>(await fb('page','disabled','snapshot',label)).split('\n').find(l=>/^e/.test(l)).split('\t')[0];
  await assert.rejects(()=>ref('Disabled child').then(r=>fb('page','disabled','click',r)),/element disabled/);
  await assert.rejects(()=>ref('Disabled draft').then(r=>fb('page','disabled','fill',r,'replacement')),/element disabled/);
  assert.equal(await fb('page','disabled','eval','document.querySelector("input").value'),'original');
  await fb('page','disabled','click',await ref('Allowed legend'));assert.equal(await fb('page','disabled','eval','window.disabledClicks'),'1');await fb('page','disabled','close');
 });
 await check('ARIA disabled inheritance respects valid overrides and native state',async()=>{
  for(const [outer,inner,child,native,disabled] of [
   ['true','','',false,true],['true','','false',false,false],['true','false','',false,false],['true','invalid','',false,true],
   ['true','','FALSE',false,false],['TRUE','','',false,true],['false','','TRUE',false,true],['false','','false',true,true]
  ]){
   await fb('page','aria','open','https://www.facebook.com/fixture');
   await fb('page','aria','eval',`window.ariaClicks=0;document.body.insertAdjacentHTML('beforeend','<fieldset ${native?'disabled':''}><div role="group" aria-disabled="${outer}"><div role="group" aria-disabled="${inner}"><button id="aria" aria-disabled="${child}">Action</button><input aria-label="Draft" aria-disabled="${child}" value="original"></div></div></fieldset>');document.querySelector('#aria').onclick=()=>window.ariaClicks++`);
   const ref=async label=>(await fb('page','aria','snapshot',label)).split('\n').find(l=>/^e/.test(l)&&l.split('\t')[2]===label).split('\t')[0];
   const click=()=>ref('Action').then(r=>fb('page','aria','click',r)),fill=()=>ref('Draft').then(r=>fb('page','aria','fill',r,'replacement'));
   if(disabled){await assert.rejects(click,/element disabled/);await assert.rejects(fill,/element disabled/)}else{await click();await fill()}
   assert.equal(await fb('page','aria','eval','window.ariaClicks'),disabled?'0':'1');assert.equal(await fb('page','aria','eval','document.querySelector("input").value'),disabled?'original':'replacement');
  }
  await fb('page','aria','close');
 });
 await check('SPA navigation expires refs including roundtrips and same-URL replace',async()=>{
  await fb('page','spa','open','https://www.facebook.com/fixture');
  await fb('page','spa','eval',`window.deleted=0;document.body.insertAdjacentHTML('beforeend','<button id="context">Delete selected item</button><a id="route" href="/fixture/other">Other</a>');document.querySelector('#context').onclick=()=>window.deleted++;document.querySelector('#route').onclick=e=>{e.preventDefault();history.pushState({},'', '/fixture/other')}`);
  const refFrom=s=>s.split('\n').find(l=>/^e/.test(l)&&l.includes('Delete selected item')).split('\t')[0];
  const old=refFrom(await fb('page','spa','snapshot'));
  await fb('page','spa','eval','document.querySelector("#route").focus()');await fb('page','spa','key','Enter');
  assert.equal(await fb('page','spa','eval','location.pathname'),'/fixture/other');await assert.rejects(()=>fb('page','spa','click',old));
  await fb('page','spa','eval',`new Promise(resolve=>{addEventListener('popstate',()=>resolve(location.pathname),{once:true});history.back()})`);
  await assert.rejects(()=>fb('page','spa','click',old));
  let ref=refFrom(await fb('page','spa','snapshot'));await fb('page','spa','eval','history.replaceState({changed:true},"",location.href)');await assert.rejects(()=>fb('page','spa','click',ref));
  ref=refFrom(await fb('page','spa','snapshot'));await fb('page','spa','eval','location.hash="other"');await assert.rejects(()=>fb('page','spa','click',ref));
  assert.equal(await fb('page','spa','eval','window.deleted'),'0');await fb('page','spa','close');
 });
 await check('trusted keyboard preserves shifted text, newlines and shortcuts',async()=>{
  await fb('page','keys','open','https://www.facebook.com/fixture');await fb('page','keys','eval',`document.body.insertAdjacentHTML('beforeend','<textarea id="keys">A</textarea>');const t=document.querySelector('#keys');t.focus();t.setSelectionRange(1,1)`);
  await fb('page','keys','key','Shift+Enter');assert.equal(await fb('page','keys','eval','JSON.stringify(document.querySelector("#keys").value)'),JSON.stringify('A\n'));
  await fb('page','keys','key','Shift+a');await fb('page','keys','key','Shift+1');assert.equal(await fb('page','keys','eval','JSON.stringify(document.querySelector("#keys").value)'),JSON.stringify('A\nA!'));
  await fb('page','keys','key',process.platform==='darwin'?'Meta+a':'Ctrl+a');await fb('page','keys','key','b');assert.equal(await fb('page','keys','eval','document.querySelector("#keys").value'),'b');await fb('page','keys','close');
  const text='multiline first\nsecond line';const receipt=await fb('post',text,'--to','me');assert.match(receipt,/^posted\tp[a-z0-9]+\t/);assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.posts)[0].text)'),text);await fb('delete',receipt.split('\t')[1]);
  assert.match(await fb('send','42',text),/^sent/);assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.messages).filter(x=>x==="multiline first\\nsecond line").length)'),1);
 });
 await check('snapshot Unicode boundaries remain valid and bounded',async()=>{
  await fb('page','unicode','open','https://www.facebook.com/fixture');
  await fb('page','unicode','eval',`document.body.replaceChildren();const t=document.createElement('div');t.textContent='x'.repeat(1799)+'😀';const b=document.createElement('button');b.setAttribute('aria-label','x'.repeat(159)+'😀');const input=document.createElement('input');input.value='x'.repeat(119)+'😀';document.body.append(t,b,input);true`);
  const snap=await fb('page','unicode','snapshot');const rows=snap.split('\n');assert.equal([...rows.find(l=>l.startsWith('text\t')).split('\t')[1]].length,1800);assert(rows.find(l=>l.includes('\tbutton\t')).includes('😀'));assert(rows.find(l=>l.includes('\ttextbox\t')).includes('[redacted]'));
  await fb('page','unicode','eval','document.querySelector("button").setAttribute("aria-label",String.fromCharCode(0xd83d));true');assert((await fb('page','unicode','snapshot')).includes('�'));await fb('page','unicode','close');
 });
 await check('recycled virtualized root is read as a new story',async()=>{
  for(const mode of ['aria','fallback']){
   await evaluate(`localStorage.recycle=JSON.stringify("${mode}");JSON.stringify(true)`);
   const posts=await fb('posts','me','-n','2');assert.match(posts,/Existing profile post/);assert.match(posts,/Recycled DOM second post/);
   await evaluate('localStorage.removeItem("recycle");JSON.stringify(true)');
  }
 });
 await check('recycled root with an identical caption is read by its new permalink',async()=>{
  for(const mode of ['fallbackSame','fallbackHidden']){
   await evaluate(`localStorage.recycle=JSON.stringify("${mode}");JSON.stringify(true)`);
   const posts=await fb('posts','me','-n','2','--urls');assert.match(posts,/\/fixture\/posts\/200\t/);assert.equal(posts.match(/Existing profile post/g).length,2);
   await evaluate('localStorage.removeItem("recycle");JSON.stringify(true)');
  }
 });
 await check('groups lists visible joined groups once with details',async()=>{
  assert.equal(await fb('groups','--urls'),'Paris Hikers\thttps://www.facebook.com/groups/1\tPrivate group · 2K members\nSolo\thttps://www.facebook.com/groups/2');
 });
 await check('native editing commands cut and undo redo instead of silent no-op',async()=>{
  const mod=process.platform==='darwin'?'Meta':'Ctrl';await fb('page','edit','open','https://www.facebook.com/fixture');
  await fb('page','edit','eval',`document.body.insertAdjacentHTML('beforeend','<textarea id="edit">before</textarea>');const t=document.querySelector('#edit');t.focus();t.select()`);
  await fb('page','edit','key','a');assert.equal(await fb('page','edit','eval','document.querySelector("#edit").value'),'a');
  await fb('page','edit','key',mod+'+z');assert.equal(await fb('page','edit','eval','document.querySelector("#edit").value'),'before');
  await fb('page','edit','key',mod+'+Shift+z');assert.equal(await fb('page','edit','eval','document.querySelector("#edit").value'),'a');
  await fb('page','edit','key',mod+'+a');await fb('page','edit','key',mod+'+x');assert.equal(await fb('page','edit','eval','document.querySelector("#edit").value'),'');await fb('page','edit','close');
 });
 await check('native caret selection word and deletion bindings work',async()=>{
  const mac=process.platform==='darwin';await fb('page','nav','open','https://www.facebook.com/fixture');
  const reset=async()=>fb('page','nav','eval',`(()=>{let t=document.querySelector('#nav');if(!t){t=document.createElement('textarea');t.id='nav';document.body.append(t)}t.value='hello world';t.focus();t.setSelectionRange(11,11)})()`);
  await reset();await fb('page','nav','key',mac?'Meta+ArrowLeft':'Home');assert.equal(await fb('page','nav','eval','document.querySelector("#nav").selectionStart'),'0');
  await reset();await fb('page','nav','key',mac?'Meta+Shift+ArrowLeft':'Shift+Home');assert.equal(await fb('page','nav','eval','document.querySelector("#nav").selectionStart'),'0');await fb('page','nav','key','x');assert.equal(await fb('page','nav','eval','document.querySelector("#nav").value'),'x');
  await reset();await fb('page','nav','key',mac?'Alt+ArrowLeft':'Ctrl+ArrowLeft');assert.equal(await fb('page','nav','eval','document.querySelector("#nav").selectionStart'),'6');
  await reset();await fb('page','nav','key',mac?'Alt+Backspace':'Ctrl+Backspace');assert.equal(await fb('page','nav','eval','JSON.stringify(document.querySelector("#nav").value)'),JSON.stringify('hello '));
  await reset();await fb('page','nav','key','ArrowLeft');assert.equal(await fb('page','nav','eval','document.querySelector("#nav").selectionStart'),'10');await fb('page','nav','close');
 });
 await check('unsupported native insertion chords fail without partial edits',async()=>{
  if(process.platform!=='darwin')return;
  await fb('page','native','open','https://www.facebook.com/fixture');
  await fb('page','native','eval',`document.body.insertAdjacentHTML('beforeend','<textarea id="native">ab</textarea>');const t=document.querySelector('#native');t.focus();t.setSelectionRange(1,1)`);
  for(const chord of ['Ctrl+o','Ctrl+Enter','Ctrl+Shift+Enter','Alt+Enter','Alt+Shift+Enter']){
   await assert.rejects(()=>fb('page','native','key',chord),/native insertion chord is unsupported/);
   assert.equal(await fb('page','native','eval','JSON.stringify({value:document.querySelector("#native").value,caret:document.querySelector("#native").selectionStart})'),JSON.stringify({value:'ab',caret:1}));
  }
  await fb('page','native','close');
 });
 await check('hover recycling never associates old body with replacement URL',async()=>{
  await evaluate('localStorage.recycleHover="true";JSON.stringify(true)');const posts=await fb('posts','me','-n','1','--urls');assert.match(posts,/\/fixture\/posts\/200\t/);assert.match(posts,/Hover recycled second post/);assert(!posts.includes('Existing profile post'));await evaluate('localStorage.removeItem("recycleHover");JSON.stringify(true)');
 });
 await check('hover and focus changes cannot retarget a referenced action',async()=>{
  await fb('page','action','open','https://www.facebook.com/fixture');
  await fb('page','action','eval',`window.clicked='none';const b=document.createElement('button');b.style='position:fixed;left:200px;top:200px;z-index:9999';b.textContent='Archive selected chat';b.onmouseenter=()=>{const next=b.cloneNode(true);next.textContent='Delete selected chat';next.onclick=()=>window.clicked='replacement';b.replaceWith(next)};document.body.append(b)`);
  const snap=await fb('page','action','snapshot','Archive selected chat'),ref=snap.split('\n').find(l=>/^e/.test(l)).split('\t')[0];await assert.rejects(()=>fb('page','action','click',ref));assert.equal(await fb('page','action','eval','window.clicked'),'none');
  await fb('page','action','eval',`const input=document.createElement('input');input.setAttribute('aria-label','Safe draft');input.onfocus=()=>input.setAttribute('aria-label','Other recipient');document.body.append(input)`);
  const form=await fb('page','action','snapshot','Safe draft'),field=form.split('\n').find(l=>/^e/.test(l)).split('\t')[0];await assert.rejects(()=>fb('page','action','fill',field,'private draft'));assert.equal(await fb('page','action','eval','JSON.stringify(document.querySelector("input").value)'),JSON.stringify(''));
  await fb('page','action','eval',`(()=>{document.querySelector('input').remove();const a=document.createElement('input'),b=document.createElement('input');a.id='first';a.setAttribute('aria-label','First input');a.value='original';b.id='second';b.value='leave alone';a.onfocus=()=>queueMicrotask(()=>b.focus());document.body.append(a,b)})()`);
  const queued=await fb('page','action','snapshot','First input'),first=queued.split('\n').find(l=>/^e/.test(l)).split('\t')[0];await assert.rejects(()=>fb('page','action','fill',first,'wrong routing'));assert.equal(await fb('page','action','eval','JSON.stringify([document.querySelector("#first").value,document.querySelector("#second").value])'),JSON.stringify(['original','leave alone']));await fb('page','action','close');
 });
 await check('fill rejects selection drift before replacing text',async()=>{
  for(const tag of ['input','textarea','div']){
   await fb('page','selection','open','https://www.facebook.com/fixture');
   await fb('page','selection','eval',`const e=document.createElement('${tag}');e.id='draft';e.setAttribute('aria-label','Draft');${tag==='div'?"e.contentEditable='true';e.innerHTML='<b>original</b> draft'":"e.value='original draft'"};e.onfocus=()=>queueMicrotask(()=>{${tag==='div'?"const r=document.createRange();r.selectNodeContents(e);r.collapse(true);const s=getSelection();s.removeAllRanges();s.addRange(r)":"e.setSelectionRange(0,0)"}});document.body.append(e)`);
   const snap=await fb('page','selection','snapshot','Draft'),ref=snap.split('\n').find(l=>/^e/.test(l)).split('\t')[0];
   await assert.rejects(()=>fb('page','selection','fill',ref,'replacement'));
   assert.equal(await fb('page','selection','eval',`document.querySelector('#draft').${tag==='div'?'textContent':'value'}`),'original draft');
   await fb('page','selection','close');
  }
 });
 await check('cancelled client never dispatches delayed target input',async()=>{
  await fb('page','cancel','open','https://www.facebook.com/fixture');
  await fb('page','cancel','eval',`localStorage.cancelClicks='0';const b=document.createElement('button');b.textContent='Confirm action';b.style='position:fixed;left:400px;top:200px;z-index:9999';b.onmouseenter=()=>{fetch('/fixture/cancel-start',{method:'POST'});const end=Date.now()+2500;while(Date.now()<end){}};b.onclick=()=>localStorage.cancelClicks=String(Number(localStorage.cancelClicks)+1);document.body.append(b)`);
  const snap=await fb('page','cancel','snapshot','Confirm action'),ref=snap.split('\n').find(l=>/^e/.test(l)).split('\t')[0];
  const client=spawn(binary,['page','cancel','click',ref],{env,stdio:'ignore'}),closed=new Promise(resolve=>client.once('close',resolve));
  try{for(let i=0;i<100&&!cancelHoverStarted;i++)await new Promise(resolve=>setTimeout(resolve,50));assert(cancelHoverStarted,'trusted hover started before cancellation');client.kill('SIGKILL');await closed;
   await assert.rejects(()=>fb('page','cancel','snapshot'));assert.equal(await evaluate('JSON.stringify(localStorage.cancelClicks)'),'0');
  }finally{client.kill('SIGKILL');await closed;await fb('page','cancel','close')}
 });
 await check('cancelled post never publishes after delayed capture setup',async()=>{
  const original=env,relay=await proxy(env.FB_CDP);env={...env,FB_STATE:path.join(temp,'cancel-post-state'),FB_CDP:relay.url};
  const gate=relay.hold('Network.enable'),disabled=relay.after('Network.disable');let client,closed;
  const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('capture setup signal timed out')),10000)})])}finally{clearTimeout(timer)}};
  try{
   client=spawn(binary,['post','cancelled fixture post','--to','me'],{env,stdio:'ignore'});closed=new Promise(resolve=>client.once('close',resolve));
   await bounded(gate.held);client.kill('SIGKILL');await closed;await new Promise(resolve=>setTimeout(resolve,100));gate.release();await bounded(disabled);
   assert.equal(await evaluate('JSON.stringify(JSON.parse(localStorage.posts||"[]").filter(x=>x.text==="cancelled fixture post").length)'),0);
  }finally{if(client){client.kill('SIGKILL');await closed}gate.release();try{await fb('stop')}finally{await relay.close();env=original}}
 });
 await check('named page fallback, stale refs, isolation and cleanup',async()=>{
  const snap=await fb('page','a','open','https://www.facebook.com/fixture');assert.match(snap,/e[a-z0-9]+\t.*What is on your mind/);const ref=snap.split('\n').find(l=>/^e/.test(l)&&l.includes('What is on your mind')).split('\t')[0];
  assert.equal(await fb('page','a','click',ref),'ok');const s=await fb('page','a','snapshot');const box=s.split('\n').find(l=>l.includes('\ttextbox\t')).split('\t')[0];assert.equal(await fb('page','a','fill',box,'draft only'),'ok');
  assert.match(await fb('page','a','eval','document.querySelector("[role=textbox]").innerText'),/draft only/);
  await fb('page','b','open','https://www.facebook.com/fixture');assert.equal(await fb('page','b','eval','!!document.querySelector("[role=dialog]")'),'false');
  await fb('page','a','open','https://www.facebook.com/fixture');await assert.rejects(()=>fb('page','a','click',ref));
  await fb('page','a','shot',path.join(out,'browser-fallback.jpg'));
  assert.match(await fb('page','a','cdp','Runtime.evaluate','{"expression":"6*7","returnByValue":true}'),/42/);
  await fb('page','a','eval','document.body.insertAdjacentHTML("beforeend",`<input type="password" aria-label="Password" value="fixture-secret"><input type="file" aria-label="Upload"><button id="change">Before</button>`)');
  const privateSnap=await fb('page','a','snapshot');assert(!privateSnap.includes('fixture-secret'));assert(privateSnap.includes('[redacted]'));
  const upload=privateSnap.split('\n').find(l=>/^e/.test(l)&&l.includes('\tfile\tUpload')).split('\t')[0];
  await fb('page','a','upload',upload,path.join(root,'tests/fixture.html'));assert.equal(await fb('page','a','eval','document.querySelector("input[type=file]").files[0].name'),'fixture.html');
  const changed=await fb('page','a','snapshot','Before');const changedRef=changed.split('\n').find(l=>/^e/.test(l)).split('\t')[0];
  await fb('page','a','eval','document.querySelector("#change").textContent="After"');await assert.rejects(()=>fb('page','a','click',changedRef));
  await fb('page','a','eval','document.body.insertAdjacentHTML("beforeend",`<div role="dialog" id="unrelated">Delete account?</div>`)');
  assert.equal(await fb('page','a','eval','window.__fb.dismissRestore().then(()=>!!document.querySelector("#unrelated"))'),'true');
  await fb('page','a','key','Escape');await fb('page','a','scroll','0','100');await fb('page','a','close');await fb('page','b','close');await assert.rejects(()=>fb('page','a','snapshot'));
  await fb('page','restart','open','https://www.facebook.com/fixture');await fb('stop');await assert.rejects(()=>fb('page','restart','snapshot'));
 });
 await check('timeout drops uncertain page and close frees its name',async()=>{
  const original=env;env={...env,FB_STATE:path.join(temp,'timeout-state'),FB_TIMEOUT:'1'};
  try{await fb('page','slow','open','https://www.facebook.com/fixture');await assert.rejects(()=>fb('page','slow','eval','new Promise(()=>{})'));await assert.rejects(()=>fb('page','slow','snapshot'));assert.equal(await fb('page','slow','close'),'closed');await fb('stop')}finally{env=original}
 });
 assert.deepEqual(failures,[],'E2E failures');
 assert.deepEqual(report.filter(x=>x.harnessError),[],'network interception errors');
}finally{
 if(env)try{await exec(binary,['stop'],{env,timeout:10000})}catch{}
 if(socket){try{await call('Browser.close')}catch{}socket.close()}
 child.kill();await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}
console.log('E2E passed; evidence: '+out);
