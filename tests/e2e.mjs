// Real Chrome + real fb process. Facebook requests are fulfilled locally; never uses real credentials.
import assert from 'node:assert/strict';
import {proxy} from './cdp-proxy.mjs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.resolve(process.env.E2E_OUTPUT||path.join(root,'target/e2e'));
await mkdir(out,{recursive:true});
const temp=await mkdtemp(path.join(tmpdir(),'fb-e2e-'));
const chrome=process.env.CHROME||({'darwin':'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','win32':'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'}[process.platform]||'google-chrome');
const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+path.join(temp,'chrome'),'about:blank'],{stdio:'ignore'});
let socket,env,cancelHoverStarted=false;const report=[];let id=0;const pending=new Map();
async function call(method,params={},sessionId){const n=++id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(n);reject(Error(method+' timed out'))},15000);pending.set(n,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});socket.send(JSON.stringify({id:n,method,params,sessionId}))})}
const binary=path.resolve(process.env.FB||path.join(root,'target/release/fb'+(process.platform==='win32'?'.exe':'')));
async function fb(...args){const t=performance.now();try{const r=await exec(binary,args,{env,timeout:45000,maxBuffer:1024*1024});report.push({args,ms:Math.round(performance.now()-t),stdout:r.stdout,stderr:r.stderr});return r.stdout.trim()}catch(e){report.push({args,ms:Math.round(performance.now()-t),stdout:e.stdout,stderr:e.stderr,error:e.message});throw e}}
async function evaluate(js){return JSON.parse(await fb('eval','https://www.facebook.com/fixture',js))}
try{
 let portInfo;for(let i=0;i<150;i++){try{portInfo=await readFile(path.join(temp,'chrome/DevToolsActivePort'),'utf8');break}catch{await new Promise(r=>setTimeout(r,100))}}
 assert(portInfo,'Chrome started');const [port,wsPath]=portInfo.trim().split('\n');
 socket=new WebSocket('ws://127.0.0.1:'+port+wsPath);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject});
 const fixture=await readFile(path.join(root,'tests/fixture.html'),'utf8');
 socket.onmessage=async ev=>{const m=JSON.parse(ev.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)}return}try{
  if(m.method==='Target.attachedToTarget'){const s=m.params.sessionId;await call('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]},s);await call('Runtime.runIfWaitingForDebugger',{},s)}
  if(m.method==='Fetch.requestPaused'){const u=new URL(m.params.request.url);if(u.pathname==='/fixture/redirect-away'){await call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:302,responseHeaders:[{name:'Location',value:'https://example.test/login'}]},m.sessionId);return}if(u.pathname==='/fixture/cancel-start')cancelHoverStarted=true;let body=Buffer.from(['www.facebook.com','example.test'].includes(u.hostname)?fixture:'').toString('base64');if(u.pathname==='/api/graphql/'){const p=JSON.parse(new URLSearchParams(m.params.request.postData).get('variables'));const mode=p?.receiptMode;body=Buffer.from(mode==='malformed'?'not json':JSON.stringify(p?{data:{story_create:{story:{url:mode==='external'?'https://example.test/fixture/posts/'+p.id:'https://www.facebook.com/fixture/posts/'+p.id,default_actor:{id:mode==='wrongActor'?'999':'12345'}}}}}:{errors:[{message:'fixture publish failed'}]})).toString('base64')}await call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html; charset=utf-8'}],body},m.sessionId)}
 }catch(e){if(!e.message.includes('Session with given id not found'))report.push({harnessError:e.message})}};
 await call('Target.setAutoAttach',{autoAttach:true,waitForDebuggerOnStart:true,flatten:true});
 await call('Storage.setCookies',{cookies:[{name:'c_user',value:'12345',domain:'.facebook.com',path:'/'}]});
 env={...process.env,FB_STATE:path.join(temp,'state'),FB_CDP:'ws://127.0.0.1:'+port+wsPath,FB_TIMEOUT:'40'};delete env.FB_SOCK;
 assert.match(await fb('status'),/logged in as 12345/);
 const failures=[];
 async function check(name,fn){if(process.env.E2E_ONLY&&!name.includes(process.env.E2E_ONLY))return;try{await fn();report.push({check:name,pass:true})}catch(e){failures.push(name);report.push({check:name,pass:false,error:e.message})}}
 await check('profile extraction and obfuscated timestamp',async()=>{const posts=await fb('posts','me','-n','1');assert.match(posts,/^p\w+\t.*Existing profile post/m)});
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
