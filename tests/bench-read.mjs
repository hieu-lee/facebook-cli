// Time the injected read-command scripts (friends, notifs, search, feed step) on synthetic DOMs in a
// local headless Chrome. No network. Usage: node tests/bench-read.mjs [js-dir] [runs]
// Set CHROME to a Chrome/headless-shell binary. setTimeout delays are zeroed, so the numbers are compute only.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const jsDir=path.resolve(process.argv[2]||path.join(root,'js')),runs=Number(process.argv[3]||7);
const chrome=process.env.CHROME||'google-chrome';
const temp=await mkdtemp(path.join(process.env.TMPDIR||tmpdir(),'fb-bench-read-'));
const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+temp,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let socket,id=0;const pending=new Map();
const call=(method,params={},sessionId)=>new Promise((res,rej)=>{const n=++id;pending.set(n,{res,rej});socket.send(JSON.stringify({id:n,method,params,sessionId}))});
try{
 let info;for(let i=0;i<150&&!info;i++){try{info=await readFile(path.join(temp,'DevToolsActivePort'),'utf8')}catch{await sleep(100)}}
 const [port,wsPath]=info.trim().split('\n');
 socket=new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);await new Promise((a,b)=>{socket.onopen=a;socket.onerror=b});
 // https://www.facebook.com/* is answered locally with an empty page: relative links resolve against a facebook.com URL
 socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.method==='Fetch.requestPaused'){call('Fetch.fulfillRequest',{requestId:m.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'text/html'}],body:Buffer.from('<!doctype html><body></body>').toString('base64')},m.sessionId);return}const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.rej(Error(m.error.message)):p.res(m.result)}};
 const {targetId}=await call('Target.createTarget',{url:'about:blank'});
 const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
 await call('Fetch.enable',{patterns:[{urlPattern:'*'}]},sessionId);
 const ev=async(expression,awaitPromise=true)=>{const r=await call('Runtime.evaluate',{expression,awaitPromise,returnByValue:true},sessionId);if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 const scripts=(await Promise.all(['lib.js','feed.js','ops.js'].map(f=>readFile(path.join(jsDir,f),'utf8')))).join('\n;');
 const setup=`(()=>{
  const st=window.setTimeout;window.setTimeout=(f,ms,...a)=>st(f,0,...a);
  document.body.innerHTML='<div role=main></div>';
  ${scripts}
  window.__timeit=async(fn)=>{const t=performance.now();const r=await fn();return {ms:performance.now()-t,r}};
 })()`;
 const main=html=>`document.querySelector('[role=main]').innerHTML=${JSON.stringify(html)}`;
 // every 5th friend uses profile.php (the mutual link then has the profile's own key), every 7th has an image-only link first, every 11th has no named link at all
 const friends=(N,edge)=>'<div role=tablist></div>'+Array.from({length:N},(_,i)=>{const p=!edge||i%5?`/user.${i}/`:`/profile.php?id=${i}`,mu=!edge||i%5?`/user.${i}/friends_mutual`:`/profile.php?id=${i}&sk=friends_mutual`;return `<div>${!edge||i%7?'':`<a href="${p}"><img width=5 height=5></a>`}${!edge||i%11?`<a href="${p}">Friend ${i}</a>`:''}<a href="${mu}">${i%9} mutual friends</a></div>`}).join('');
 const notifs=N=>'<div role=list>'+Array.from({length:N},(_,i)=>`<div role=listitem><a href="/groups/1/posts/${i}/"><span>Alice B</span><span> commented on your post number ${i}</span><span>${i%50+1}h</span><div role=button>x</div></a></div>`).join('')+'</div>';
 const search=N=>'<div role=feed>'+Array.from({length:N},(_,i)=>`<div role=article><h3><a href="/user.${i}"><span>Alice ${i}</span></a></h3><a href="/user.${i}"><img alt="Alice ${i}" width=10 height=10></a><span>Paris</span><span>Lives in Lyon</span><span role=button>Add friend</span></div>`).join('')+'</div>';
 const post=i=>`<div aria-posinset="${i+1}"><div data-ad-rendering-role="profile_name"><a href="/page${i%7}">Page ${i%7}</a></div><div><a href="/page${i%7}/posts/pfbid0${i}?__cft__[0]=abc">${i+1}h</a></div><div data-ad-rendering-role="story_message">Hello world post number ${i} with some text to read here <div role=button>See less</div></div><div data-ad-rendering-role="like_button"><span><span>12</span></span></div><div data-ad-rendering-role="comment_button"><span><span>3</span></span></div></div>`;
 const feed=N=>Array.from({length:N},(_,i)=>post(i)).join('');
 const cases=[
  ['friends(400)',friends(400),'window.__fb.friends(400).then(r=>JSON.stringify(r))'],
  ['friends(400) edge cases (see gen)',friends(400,true),'window.__fb.friends(400).then(r=>JSON.stringify(r))'],
  ['notifs(300)',notifs(300),'window.__fb.notifs(300).then(r=>JSON.stringify(r))'],
  ['search(200)',search(200),'window.__fb.search(200).then(r=>JSON.stringify(r))'],
  ['feed step: 1 cold pass + 9 already-seen (40 posts)',feed(40),'(async()=>{let n=0;for(let k=0;k<10;k++)n+=(await window.__fbFeed.step()).length;return n})()'],
  ['feed step warm (40 posts, x100)',feed(40),'(async()=>{await window.__fbFeed.step();const t=performance.now();for(let k=0;k<100;k++)await window.__fbFeed.step();return performance.now()-t})()',true],
 ];
 const med=a=>[...a].sort((x,y)=>x-y)[a.length>>1];
 for(const [name,html,expr,byResult] of cases){
  const ms=[];let last;
  for(let i=0;i<runs+1;i++){
   await call('Page.navigate',{url:'https://www.facebook.com/bench'},sessionId);for(let w=0;w<100&&!await ev("location.href.startsWith('https://www.facebook.com/')&&document.readyState==='complete'&&!!document.body").catch(()=>false);w++)await sleep(50);
   await ev(setup,false);await ev(main(html),false);
   const prof=process.env.PROFILE&&name.includes(process.env.PROFILE);if(prof){await call('Profiler.enable',{},sessionId);await call('Profiler.start',{},sessionId)}
   const r=await ev(`window.__timeit(()=>${expr})`);
   if(prof){const {profile}=await call('Profiler.stop',{},sessionId),self=new Map(),dt=profile.timeDeltas,byId=new Map(profile.nodes.map(n=>[n.id,n]));profile.samples.forEach((s,k)=>{const f=byId.get(s).callFrame,key=`${f.functionName||'(anon)'}:${f.lineNumber+1}:${f.columnNumber+1}`;self.set(key,(self.get(key)||0)+dt[k])});console.log([...self].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([k,v])=>(v/1000).toFixed(1)+'ms '+k).join('\n'))}
   if(i)ms.push(+(byResult?r.r:r.ms).toFixed(1));last=byResult?'':typeof r.r==='string'?createHash('sha1').update(r.r).digest('hex').slice(0,10):r.r;
  }
  console.log(name.padEnd(34),'result',String(last).padStart(10),'median ms',String(med(ms)).padStart(8),' runs',JSON.stringify(ms));
 }
}finally{child.kill();await rm(temp,{recursive:true,force:true})}
