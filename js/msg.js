(()=>{
 const F=window.__fb;
 const {sleep,clean,vtext,waitFor,dismissRestore}=F;
 const parseArticle=(a,log)=>{
  const labels=[...a.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label'));
  const {t,sender,text}=F.parseLabel(labels);
  const ar=a.getBoundingClientRect();
  const probe=[...a.querySelectorAll('[dir=auto],img,video')].map(e=>e.getBoundingClientRect()).find(r=>r.width>=3&&r.height>=6);
  // null = could not tell from layout (e.g. no visible bubble)
  const mine=probe?(probe.right>=ar.right-25&&probe.left>ar.left+ar.width*0.2):null;
  const att=[];
  for(const i of a.querySelectorAll('img')){if(i.clientWidth>=80&&!/emoji\.php/.test(i.src))att.push('img');}
  if(a.querySelector('video'))att.push('video');
  if(!att.length)for(const l of a.querySelectorAll('a[href*="/messenger_media"],a[download],a[href*="attachment"]'))att.push('file');
  const re=[];
  for(const l of labels){const r=/^(\d+)[^;]*?(\S+);/.exec(l);if(r&&/emoji|cảm xúc|reaction|réaction/i.test(l))re.push(r[2]+(+r[1]>1?r[1]:''));}
  const idEl=a.querySelector('[data-message-id]');
  return {id:idEl?idEl.getAttribute('data-message-id'):'',t,from:mine===true?'me':sender,sender,mine,text,att:[...new Set(att)].join(','),re:re.join('')};
 };
 window.__fb.parseMessage=parseArticle;
 const scroller=log=>{let p=log;while(p&&p!==document.body){if(p.scrollHeight>p.clientHeight+20&&/auto|scroll/.test(getComputedStyle(p).overflowY))return p;p=p.parentElement;}return null;};
 window.__fb.scroller=scroller;
 // Scroll a (virtualized) log to its newest rows and wait until its last row stops changing, so the
 // caller never works on rows that were mounted before the jump.
 window.__fb.settleBottom=async(log,checks,gap)=>{
  const sc=scroller(log);
  let lastEl=null,stable=0;
  for(let i=0;i<30&&stable<checks;i++){
   if(sc)sc.scrollTop=sc.scrollHeight;else window.scrollTo(0,document.body.scrollHeight);
   await window.__fb.sleep(gap);
   const cur=[...log.querySelectorAll('[role=article]')].pop();
   if(cur&&cur===lastEl)stable++;else{stable=0;lastEl=cur;}
  }
  return stable>=checks;
 };
 F.threadReady=async()=>{
  await dismissRestore();
  const t0=Date.now();
  // ready once messages render, or (empty/new conversation) once the composer has been there a moment
  const ok=await waitFor(async()=>{await dismissRestore();return document.querySelector('[role=log] [role=article] [aria-label]')||(location.pathname.startsWith('/messages')&&document.querySelector('[role=textbox][contenteditable=true]')&&Date.now()-t0>2500)},15000);
  return !!ok;
 };
 const snapshot=log=>{
  const out=[];
  for(const e of log.querySelectorAll('[role=article],[data-scope=date_break]')){
   if(e.getAttribute('data-scope')==='date_break'){out.push({d:clean(e.innerText)});continue;}
   if(e.closest('[role=article]')!==e)continue;
   out.push(parseArticle(e,log));
  }
  return out;
 };
 F.read=async n=>{
  const log=document.querySelector('[role=log]');
  if(!log)return {msgs:[]};
  const sc=scroller(log);
  const toBottom=()=>{if(sc)sc.scrollTop=sc.scrollHeight;else window.scrollTo(0,document.body.scrollHeight);};
  const labelled=()=>[...log.querySelectorAll('[role=article]')].slice(-4).every(a=>a.querySelector('[aria-label]'));
  // a reused tab may still be scrolled up from an earlier history read: capture the newest rows
  await F.settleBottom(log,2,200);
  await waitFor(labelled,6000,100);
  const msgCount=l=>l.filter(m=>!m.d).length;
  let acc=snapshot(log);
  let prev=-1,stable=0;
  // scroll up until enough history is mounted; rows that get unmounted on the way stay in `acc`
  for(let i=0;i<60&&msgCount(acc)<n+3;i++){
   await dismissRestore();
   const have=msgCount(acc);
   if(have===prev){if(++stable>=4)break;}else stable=0; // ~1s without growth = start of the conversation
   prev=have;
   if(sc)sc.scrollTop=0;else window.scrollTo(0,0);
   await sleep(250);
   await waitFor(labelled,3000,100);
   acc=F.mergeChunks(snapshot(log),acc);
  }
  toBottom(); // leave the thread where `send` and the next `read` expect it
  const out=acc;
  // layout is authoritative; the sender name only decides messages whose layout was unreadable
  const selfNames=new Set(out.filter(m=>m.mine===true&&m.sender).map(m=>m.sender));
  for(const m of out)if(!m.d&&m.mine===null&&selfNames.has(m.sender))m.from='me';
  let msgs=0;const res=[];
  let first=0;
  for(let i=out.length-1;i>=0;i--){first=i;res.push(out[i]);if(!out[i].d&&++msgs>=n)break;}
  // keep the nearest date header above the oldest returned message
  for(let j=first-1;j>=0;j--)if(out[j].d){if(j!==first)res.push(out[j]);break;}
  return {msgs:res.reverse()};
 };
 F.chats=async n=>{
  await dismissRestore();
  const g=await waitFor(async()=>{await dismissRestore();const g=document.querySelector('[role=grid]');return g&&g.querySelector('[role=row] a[href*="/t/"]')&&g},15000);
  if(!g)return {err:'no chat list'};
  const sc=scroller(g)||g.parentElement;
  if(sc){sc.scrollTop=0;await sleep(400);}
  const atBottom=()=>!sc||sc.scrollTop+sc.clientHeight>=sc.scrollHeight-2;
  const seen=new Map();
  let stall=0,prevSeen=-1,prevTop=-1,complete=false,bottomSeen=-1,bottomH=-1;
  const t0=Date.now();
  // time-budgeted, not iteration-budgeted: a large account must actually be scanned, not truncated early
  while(Date.now()-t0<20000){
   for(const row of g.querySelectorAll('[role=row]')){
    const a=row.querySelector('a[href*="/t/"]');if(!a)continue;
    const href=a.getAttribute('href');if(seen.has(href))continue;
    const ch=vtext(row);
    const dot=ch.lastIndexOf('·');
    const time=dot>=0?ch[dot+1]||'':'';
    // presence text ("Active now", "Active 5m ago") renders as its own chunk
    // ahead of the title on some rows; it is not part of the chat's name
    const PRES=/^Active (now|\d+\s*[smhd]\s*ago|today|yesterday)$/i;
    const body=ch.slice(0,dot>=0?dot:ch.length).filter(c=>!PRES.test(c));
    const bold=+getComputedStyle(row.querySelector('span')||row).fontWeight>=600;
    seen.set(href,{href,name:body[0]||'',preview:body.slice(1).join(' '),time,unread:bold,group:/\/t\/\d+\/?$/.test(href)&&!!a.getAttribute('aria-label')&&/:/.test(a.getAttribute('aria-label'))});
   }
   // genuine exhaustion, checked BEFORE consulting `n`: a cap must never get mislabelled as the real end
   if(atBottom()){
    // bottom of what is mounted so far: lazy pagination may still be fetching, so require one settled recheck
    if(!sc||(seen.size===bottomSeen&&sc.scrollHeight===bottomH)){complete=true;break;}
    bottomSeen=seen.size;bottomH=sc.scrollHeight;
    await sleep(700);continue;
   }
   if(seen.size>=n)break;                 // enough for the caller; completeness stays unproven (false)
   // stuck = nothing new AND the list did not move: scrolling that still advances is progress, not a stall
   const top=sc?sc.scrollTop:0;
   if(seen.size===prevSeen&&top===prevTop){if(++stall>=8)break;}else stall=0; // stuck short of the bottom: give up, unproven
   prevSeen=seen.size;prevTop=top;
   // step by (less than) a viewport: a virtualized list unmounts rows it was scrolled past
   sc.scrollTop=Math.min(sc.scrollTop+Math.max(sc.clientHeight*0.7,100),sc.scrollHeight);
   await sleep(300);
  }
  // a list cut to n rows is not the whole list, however far the scan got
  return {chats:[...seen.values()].slice(0,n),complete:complete&&seen.size<=n};
 };
 F.focusComposer=async()=>{
  await dismissRestore();
  if(document.querySelector('[role=dialog]'))throw Error('Messenger dialog blocks input; inspect with `fb page`');
  const tb=await waitFor(()=>document.querySelector('[role=textbox][contenteditable=true]'),8000,100);
  if(!tb)return false;
  tb.focus();
  return document.activeElement===tb;
 };
 F.composerMatches=text=>{const tb=document.querySelector('[role=textbox][contenteditable=true]');return !!tb&&document.activeElement===tb&&!document.querySelector('[role=dialog]')&&clean(tb.innerText)===clean(text)};
 // `markSent` remembers the mounted messages and which one is the newest; `sentSince` is true once a NEW
 // message that is ours (by layout) shows up BELOW that newest one. Ids, not content: identical repeated
 // messages and recycled rows are handled; "below" matters because a virtualized log mounts older rows
 // while it re-renders, and those are not new. The text check keeps a concurrent send from confirming this one.
 const norm=t=>clean(t||'').toLowerCase();
 const idOf=a=>{const e=a.querySelector('[data-message-id]');return e?e.getAttribute('data-message-id'):'';};
 F.markSent=async()=>{
  const getLog=()=>document.querySelector('[role=log]');
  const articles=l=>l?[...l.querySelectorAll('[role=article]')]:[];
  // history may still be loading: only a conversation that stays empty after a grace period counts as empty
  await waitFor(()=>articles(getLog()).length>0,4000,200);
  const log=getLog();
  // the newest rows must be mounted before we remember what is already there; if that cannot be
  // established, confirming a send would be a guess
  if(articles(log).length&&!await F.settleBottom(log,2,200))return false;
  if(getLog()!==log)return false;
  const arts=articles(log),last=arts[arts.length-1];
  window.__fbBefore={ids:new Set([...(log?log.querySelectorAll('[data-message-id]'):[])].map(e=>e.getAttribute('data-message-id'))),els:new WeakSet(arts),last:last||null,lastId:last?idOf(last):''};
  return true;
 };
 // `file` set: a NEW outgoing message of ours that carries an attachment and, unless `loose` (images, videos:
 // their bubbles show no name), has a leaf label that is exactly the file name. Otherwise a new outgoing
 // message with exactly our text. Nothing to look for never counts as sent.
 F.sentSince=(text,file,loose)=>{
  const log=document.querySelector('[role=log]');if(!log||!window.__fbBefore)return false;
  const want=norm(text),key=file?norm(file):'',before=window.__fbBefore;
  if(!want&&!file)return false;
  const arts=[...log.querySelectorAll('[role=article]')];
  let from=0;
  if(before.last){
   // the newest message at the moment of marking is the anchor (by id when it has one: elements get
   // recycled); if it is gone we cannot place anything
   const k=before.lastId?arts.findIndex(x=>idOf(x)===before.lastId):arts.indexOf(before.last);
   if(k<0)return false;
   from=k+1;
  }
  const named=a=>!!key&&[...a.querySelectorAll('span,a,div')].some(e=>!e.children.length&&norm(e.textContent)===key);
  return arts.slice(from).some(a=>{
   const m=parseArticle(a,log);
   // new = unknown id; rows without an id fall back to element identity
   if(m.id?before.ids.has(m.id):before.els.has(a))return false;
   if(m.mine!==true)return false;
   return file?(!!m.att&&(!!loose||named(a))):norm(m.text)===want;
  });
 };
 F.lastCount=()=>{const log=document.querySelector('[role=log]');return log?log.querySelectorAll('[role=article]').length:-1;};
 F.lastMsg=()=>{const log=document.querySelector('[role=log]');if(!log)return null;const a=[...log.querySelectorAll('[role=article]')].pop();return a?parseArticle(a,log):null;};
})();
(()=>{
 const F=window.__fb;
 // The file arrives in chunks (each a base64 string that decodes on its own): one huge CDP call would be slow.
 F.upBegin=()=>{window.__fbUp=[];return true;};
 F.upChunk=s=>{(window.__fbUp||(window.__fbUp=[])).push(s);return true;};
 // previews of a draft live in the composer; the log may hold blob images of its own
 const blobs=()=>[...document.querySelectorAll('[role=main] img[src^="blob:"],[role=main] video[src^="blob:"]')].filter(e=>!e.closest('[role=log]')).length;
 // the attachment chip in the composer shows the file name; sent messages (in the log) do not count
 const chips=name=>[...document.querySelectorAll('[role=main] span,[role=main] div')].filter(e=>!e.children.length&&e.textContent===name&&!e.closest('[role=log]')).length;
 // still waiting in the composer: Enter was ignored (e.g. the upload had not finished), nothing was sent
 F.pendingFile=name=>chips(name)>0||blobs()>0;
 F.attach=async(name,mime)=>{
  const parts=window.__fbUp||[];window.__fbUp=null;
  if(!parts.length)return 'no data';
  const image=/^image\//.test(mime);
  // images are pasted so that Messenger shows them as photos; the file input would send them as files
  const inp=image?await F.waitFor(()=>document.querySelector('[role=textbox][contenteditable=true]'),8000,100):await F.waitFor(()=>document.querySelector('input[type=file]'),8000,100);
  if(!inp)return image?'no composer':'no file input (is this a chat you can write to?)';
  const bytes=parts.map(p=>{const bin=atob(p);const u8=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);return u8;});
  const dt=new DataTransfer();dt.items.add(new File(bytes,name,{type:mime}));
  const b0=blobs(),c0=chips(name);
  if(image){inp.focus();inp.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}
  else{inp.files=dt.files;inp.dispatchEvent(new Event('change',{bubbles:true}));}
  const ok=await F.waitFor(()=>blobs()>b0||chips(name)>c0,15000,100);
  const tb=document.querySelector('[role=textbox][contenteditable=true]');if(tb)tb.focus();
  return !!ok||'attachment did not show up in the composer';
 };
})();
(()=>{
 const F=window.__fb;
 F.draft=()=>{const tb=document.querySelector('[role=textbox][contenteditable=true]');const imgs=document.querySelectorAll('[role=main] img[src^="blob:"]').length;return JSON.stringify({text:tb?tb.innerText.trim():null,blobs:imgs});};
 F.clearDraft=async()=>{
  const tb=document.querySelector('[role=textbox][contenteditable=true]');
  if(tb){tb.focus();document.execCommand('selectAll');document.execCommand('delete');}
  for(const b of document.querySelectorAll('[role=main] [role=button][aria-label]')){if(/^(Xóa|Remove|Supprimer)/i.test(b.getAttribute('aria-label')))b.click();}
 };
})();
;(()=>{
 const F=window.__fb;
 const pinDialog=()=>[...document.querySelectorAll('[role=dialog]')].find(d=>d.querySelector('input,[role=textbox]')&&/PIN/i.test((d.innerText||'')+[...d.querySelectorAll('[aria-label]')].map(e=>e.getAttribute('aria-label')).join(' ')));
 F.pinFocus=async()=>{
  let d=pinDialog();
  if(!d){
   const target=await F.waitFor(()=>pinDialog()||[...document.querySelectorAll('button,[role=button]')].find(b=>/^(Enter PIN|Nhập mã PIN|Saisir (?:le |votre )?code PIN|Saisissez (?:le |votre )?code PIN)$/i.test(F.clean(b.innerText||b.getAttribute('aria-label')))),10000);
   if(target&&target.getAttribute('role')!=='dialog')F.press(target);
   d=await F.waitFor(pinDialog,5000);
  }
  if(!d)return 'PIN restore dialog not found; open Messenger history restoration with `fb page`';
  const inp=d.querySelector('input:not([type=hidden]),[role=textbox]');
  if(!inp)return 'no PIN input';
  inp.focus();return true;
 };
 F.pinDone=async()=>{
  const gone=await F.waitFor(()=>!pinDialog(),15000,150);
  if(!gone)return 'PIN rejected or dialog still open';
  return true;
 };
})();

;(()=>{
 const F=window.__fb;
 const norm=p=>p.replace(/\/$/,'');
 F.spaOpen=async path=>{
  if(!location.pathname.startsWith('/messages'))return false;
  await F.dismissRestore();
  const id=norm(path);
  if(norm(location.pathname)===id)return await F.threadReady();
  const a=[...document.querySelectorAll('[role=grid] a[href]')].find(a=>norm(a.getAttribute('href'))===id);
  if(!a)return false;
  const oldFirst=(document.querySelector('[role=log]')||document).querySelector('[role=article]');
  F.press(a);
  if(!await F.waitFor(()=>norm(location.pathname)===id,5000,30))return false;
  // the old conversation must be replaced; otherwise report failure so the caller navigates for real
  const swapped=await F.waitFor(()=>{const l=document.querySelector('[role=log]');const f=l&&l.querySelector('[role=article]');return f&&f!==oldFirst},12000,50);
  if(!swapped)return false;
  return await F.threadReady();
 };
})();
;(()=>{
 const F=window.__fb;
 const {sleep,clean,waitFor}=F;
 // "unsend" (for everyone) -- NOT "remove" (Gỡ / Remove), which only hides it for me
 const UNSEND=/^(Thu hồi|Unsend|Annuler l.envoi)/i;
 const EVERYONE=/(mọi người|everyone|tout le monde)/i;
 const dialogs=()=>[...document.querySelectorAll('[role=dialog]')];
 // Step 1: find our latest message (optionally containing `match`), focus it (that renders its action
 // toolbar, no hover needed), open "more", pick "unsend", choose "for everyone". Stops before the confirm.
 F.unsendOpen=async match=>{
  const log=document.querySelector('[role=log]');
  if(!log)return 'no thread';
  // a reused tab may be scrolled up (virtualized log): start from the newest messages
  const sc=F.scroller(log);
  if(sc)sc.scrollTop=sc.scrollHeight;else window.scrollTo(0,document.body.scrollHeight);
  await sleep(250);
  // never choose among half-rendered rows: the newest message might be the unreadable one
  const ready=await waitFor(()=>[...log.querySelectorAll('[role=article]')].slice(-4).every(a=>a.querySelector('[aria-label]')),5000,100);
  if(!ready)return 'messages are still loading; try again';
  // the newest rows must have mounted before we choose among them
  if(!await F.settleBottom(log,3,300))return 'could not reach the newest messages; nothing was changed';
  let target=null,text='';
  for(const a of [...log.querySelectorAll('[role=article]')].reverse()){
   const m=F.parseMessage(a,log);
   // a newer message we cannot classify might be ours: never fall back to an older one
   if(m.mine===null)return 'cannot tell which of the newest messages are yours; nothing was changed';
   if(m.mine!==true)continue;
   if(match&&!(m.text||'').toLowerCase().includes(match.toLowerCase()))continue;
   // an already-unsent message leaves an empty row of ours behind: nothing to unsend there
   if(!m.text&&!m.att&&!a.querySelector('audio,video,img,canvas,svg,a[href],[role=img],[role=slider]'))continue;
   target=a;text=m.text||(m.att?'['+m.att+']':'');break;
  }
  if(!target)return match?'no recent message of yours contains that text':'no message of yours found';
  target.scrollIntoView({block:'center'});
  const focusable=target.querySelector('[tabindex="0"]');
  if(!focusable)return 'message cannot be focused';
  focusable.focus();
  // only a toolbar inside the chosen message counts
  const more=await waitFor(()=>{
   const b=[...target.querySelectorAll('[role=toolbar] [role=button],[role=toolbar] [aria-label]')].filter(e=>e.getBoundingClientRect().width>0);
   return b.length>=2?b[b.length-1]:null;
  },3000,100);
  if(!more)return 'message actions not available';
  window.__fbUnsend={target,text};
  F.press(more);
  const item=await waitFor(()=>[...document.querySelectorAll('[role=menuitem]')].find(i=>UNSEND.test(clean(i.innerText))),5000);
  if(!item)return 'unsend is not offered for this message (too old?); menu: '+JSON.stringify([...document.querySelectorAll('[role=menuitem]')].map(i=>clean(i.innerText)));
  F.press(item);
  const d=await waitFor(()=>dialogs().find(d=>d.querySelector('[role=radio],input[type=radio]')),6000);
  if(!d)return 'unsend dialog did not open';
  // the "for everyone" option; refuse anything else (remove-for-me must never pass as unsend)
  const labels=[...d.querySelectorAll('label')];
  const lab=labels.find(l=>EVERYONE.test(clean(l.innerText)))||labels[0];
  if(!lab||!EVERYONE.test(clean(lab.innerText)))return 'could not find the "unsend for everyone" option';
  F.press(lab);
  await sleep(300);
  const btn=[...d.querySelectorAll('[role=button]')].filter(b=>clean(b.innerText)).pop();
  if(!btn)return 'confirm button not found';
  window.__fbUnsend.btn=btn;
  return {text,option:clean(lab.innerText).slice(0,60)};
 };
 // Step 2: the irreversible click
 F.unsendConfirm=async()=>{
  const u=window.__fbUnsend;if(!u||!u.btn)return 'nothing to confirm';
  F.press(u.btn);
  const gone=await waitFor(()=>!u.target.isConnected||!dialogs().some(d=>d.contains(u.btn)),10000,150);
  await sleep(600);
  return gone?true:'not confirmed by messenger';
 };
})();
