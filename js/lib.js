(()=>{
 if(window.__fb)return;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const clean=s=>(s||'').replace(/[͏​-‏⁠﻿]/g,'').replace(/[ \t ]+/g,' ').replace(/ *\n */g,'\n').trim();
 const vtext=(root,visibleOnly=false,includeAriaHidden=false,preserveSpace=false)=>{
  const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),o=[];let n;
  while(n=w.nextNode()){
   const t=n.nodeValue,p=n.parentElement;if(!t||(!preserveSpace&&!t.trim())||(!visibleOnly&&t.includes('͏'))||!p||!visibleOnly&&p.closest('blockquote'))continue;
   if(visibleOnly){
    if(p.closest('[hidden]')||!includeAriaHidden&&p.closest('[aria-hidden="true"]'))continue;
    const shown=p.checkVisibility?p.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}):p.getClientRects().length&&getComputedStyle(p).visibility==='visible';
    if(!shown){
     if(getComputedStyle(p).display!=='contents')continue;
     let hidden=false;for(let e=p;e;e=e.parentElement){const s=getComputedStyle(e);if(s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0){hidden=true;break}}
     if(hidden)continue;const r=document.createRange();r.selectNodeContents(n);if(!r.getClientRects().length)continue;
    }
   }
   const c=t.replace(/[͏​-‏⁠﻿]/g,'').replace(/ /g,' ');if(preserveSpace?c:c.trim())o.push(preserveSpace?c:c.trim());
  }
  return o;
 };
 const waitFor=async(f,ms=10000,step=60)=>{const t=Date.now();for(;;){let v;try{v=await f()}catch(e){}if(v)return v;if(Date.now()-t>ms)return null;await sleep(step);}};
 const visible=e=>e.isConnected&&e.getClientRects().length&&getComputedStyle(e).visibility==='visible';
 const enabled=e=>!e.matches(':disabled')&&e.closest('[aria-disabled="true" i],[aria-disabled="false" i]')?.getAttribute('aria-disabled').toLowerCase()!=='true';
 // Use application buttons: removing a modal leaves React's focus trap and state alive.
 const dismissRestore=async()=>{
  const deadline=Date.now()+5000,clicked=new WeakSet();let acted=false,quiet=0;
  while(true){
   const ds=[...document.querySelectorAll('[role=dialog]')];
   const d=ds.find(d=>/PIN/i.test(d.innerText)&&/restore|khôi phục|restaur/i.test(d.innerText)&&d.querySelector('input,[role=textbox]'));
   const confirm=ds.find(d=>/Continue without restoring|Tiếp tục mà không khôi phục|Continuer sans restaurer/i.test(d.innerText));
   if(!d&&!confirm){
    if(!acted)return true;
    if(!quiet)quiet=Date.now();
    if(Date.now()-quiet>=250)return true;
    await sleep(50);continue;
   }
   quiet=0;
   const root=confirm||d;
   const re=confirm?/^(Don't restore messages|Do not restore(?: messages)?|Không khôi phục tin nhắn|Ne pas restaurer(?: les messages)?|Continuer sans restaurer)$/i:/^(Close|Đóng|Fermer)$/i;
   const b=[...root.querySelectorAll('button,[role=button]')].find(b=>visible(b)&&re.test(clean(b.getAttribute('aria-label')||b.innerText)));
   if(Date.now()>deadline)throw Error('Messenger history prompt blocked input; use `fb unlock` or inspect with `fb page`');
   if(b&&!clicked.has(b)){b.click();clicked.add(b);acted=true;}
   await sleep(60);
  }
 };
 const postText=e=>{
  if(!e)return '';
  const text=clean(e.innerText);
  for(const b of e.querySelectorAll('[role=button],button')){
   const label=clean(b.innerText);
   if(!/^(See less|Thu gọn|Afficher moins|Réduire)$/i.test(label)||!visible(b)||!text.endsWith(label))continue;
   const tail=document.createRange();tail.selectNodeContents(e);tail.setStartAfter(b);
   if(!clean(tail.toString()))return clean(text.slice(0,-label.length));
  }
  return text;
 };
 const postCards=()=>{
  const marker='[data-ad-rendering-role=profile_name]';
  const cards=[...document.querySelectorAll('[aria-posinset]')].filter(u=>u.querySelector(marker));
  for(const name of document.querySelectorAll(marker)){
   if(cards.some(u=>u.contains(name))||name.closest('blockquote'))continue;
   for(let u=name.parentElement;u&&u!==document.body;u=u.parentElement){
    if(u.matches('[role=main]')||u.querySelector(marker)!==name)break;
    if(u.querySelector('[data-ad-rendering-role=story_message],[data-ad-rendering-role=like_button]')){cards.push(u);break;}
   }
  }
  return cards;
 };
 const canon=h=>{try{const u=new URL(h,location.href);const KEEP=['fbid','story_fbid','id','v','set','idorvanity','q'];const mp=u.searchParams.get('multi_permalinks');if(mp&&/^\/groups\/\d+\/?$/.test(u.pathname))return u.pathname.replace(/\/?$/,'/posts/'+mp);for(const p of [...u.searchParams.keys()])if(!KEEP.includes(p))u.searchParams.delete(p);return u.pathname+u.search;}catch(e){return ''}};
 const groupPath=h=>{try{const u=new URL(h,location.href);const m=u.pathname.match(/^\/groups\/([^/]+)\/?$/);if(!m)return null;if(/^(feed|discover|joins|create|search)$/.test(m[1]))return null;return '/groups/'+m[1];}catch(e){return null}};
 /* a group's name is the first line of its first link; the other lines of all its links are details */
 const addGroup=(m,p,lines)=>{const cur=m.get(p);if(!cur){m.set(p,{name:lines[0],info:lines.slice(1)});return}for(const l of lines)if(l!==cur.name&&!cur.info.includes(l))cur.info.push(l)};
 const TIME=/^(\d+\s*(giây|phút|giờ|ngày|tuần|tháng|năm)(\s*trước)?|Hôm qua.*|Vừa xong|Yesterday.*|Just now|\d+\s*(s|m|h|d|w|y|hr|hrs|min|mins)|\d+\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)(\s+ago)?|\d{1,2}\s+tháng\s+\d{1,2}.*|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}.*|il y a .*|hier.*|\d{1,2} (janv|févr|mars|avr|mai|juin|juil|août|sept|oct|nov|déc).*)$/i;
 const SPON=/^(Được tài trợ|Sponsored|Sponsorisé|Gesponsert|Patrocinado)/i;
 const ACT=/^(Thích|Like|J'aime|Trả lời|Reply|Répondre|Chia sẻ|Share|Partager|Đã chỉnh sửa|Edited|Modifié|Dịch|See translation|Xem bản dịch)$/i;
 const trunc=(s,n)=>{if(!s)return s;const a=Array.from(s);return a.length>n?a.slice(0,n).join('')+'…':s;};
 const scrollerOf=el=>{let p=el;while(p&&p!==document.body&&p!==document.documentElement){if(p.scrollHeight>p.clientHeight+20&&/auto|scroll/.test(getComputedStyle(p).overflowY))return p;p=p.parentElement;}return null;};
 const num=e=>{const g=e&&e.parentElement&&e.parentElement.parentElement;const t=g?g.innerText.trim():'';return /^[\d.,]+[KMkmN]?$/.test(t)?t:'0';};
 const press=(el,{events=['pointerover','mouseover','pointerdown','mousedown','pointerup','mouseup','click'],valid=()=>true}={})=>{
  const identity=()=>[location.href,el.getAttribute('role'),el.getAttribute('aria-label')||clean(el.innerText),el.getAttribute('href')].join('\n');
  const key=identity();
  for(const t of events){
   if(!visible(el)||!enabled(el)||identity()!==key||!valid())throw Error('action target changed; nothing further was dispatched');
   const rc=el.getBoundingClientRect();const o={bubbles:true,cancelable:true,view:window,clientX:rc.x+rc.width/2,clientY:rc.y+rc.height/2,button:0,pointerId:1,pointerType:'mouse',isPrimary:true};
   const C=t.startsWith('pointer')?PointerEvent:MouseEvent;
   el.dispatchEvent(new C(t,{...o,buttons:t.endsWith('down')?1:0}));
  }
 };
 // Join two snapshots of a virtualized list: `older` was captured after scrolling up, `newer` before.
 // Rows that were unmounted in between are recovered from `newer`; messages that arrived meanwhile
 // extend it. Alignment is found on the MESSAGES only (date separators may differ) by id when present.
 const mergeChunks=(older,newer,key=m=>m&&m.id?'id:'+m.id:JSON.stringify(m))=>{
  const isMsg=m=>!(m&&m.d!==undefined);
  const om=older.map((m,i)=>[i,m]).filter(([,m])=>isMsg(m)),nm=newer.map((m,i)=>[i,m]).filter(([,m])=>isMsg(m));
  const a=om.map(([,m])=>key(m)),b=nm.map(([,m])=>key(m));
  // a separator that repeats the date already in effect adds nothing
  const tidy=l=>{let cur=null;return l.filter(m=>{if(isMsg(m))return true;if(m.d===cur)return false;cur=m.d;return true;});};
  if(!a.length||!b.length)return tidy(older.concat(newer));
  // Real message rows always carry an id. Without ids equal-looking messages are indistinguishable, so
  // only trust a long, varied suffix/prefix overlap (2+ rows that are not all the same message).
  if(a.some(k=>!k.startsWith('id:'))||b.some(k=>!k.startsWith('id:'))){
   if(a.join('\n')===b.join('\n'))return older;
   for(let k=Math.min(a.length,b.length);k>=2;k--){
    const ov=b.slice(0,k);
    if(new Set(ov).size<2)continue;
    if(a.slice(a.length-k).join('\n')===ov.join('\n'))return tidy(older.concat(newer.slice(nm[k-1][0]+1)));
   }
   return tidy(older.concat(newer));
  }
  // Anchor on the ids both snapshots share: everything of `newer` up to its last shared message is
  // already represented in `older` (a message missing from older's contiguous window was unsent, not
  // lost), whatever follows that point is newer than older's window and is appended.
  const inA=new Set(a);
  let last=-1;for(let i=0;i<b.length;i++)if(inA.has(b[i]))last=i;
  if(last>=0){
   // newer's tail is only newer than older's window if older ends at the last shared message;
   // otherwise it conflicts with what older saw (e.g. a message removed while another arrived)
   if(a.lastIndexOf(b[last])<a.length-1)return older;
   return tidy(older.concat(newer.slice(nm[last][0]+1)));
  }
  return tidy(older.concat(newer));                      // no overlap: a gap we cannot fill
 };
 // The per-message accessibility labels look like "<prefix> <time>, <sender>: <text>" in every locale and
 // with weekday/date/AM-PM variations ("Lúc Thứ bảy 23:45ch, Bạn: hi", "At 4:05 PM, Alice: hi",
 // "Lúc 15:33 12 Tháng 12, 2024, Bạn: hi"); the other label ("Nhập, Tin nhắn do ... gửi lúc ...") has its
 // comma BEFORE the time. Colon+space separates sender from text (the time's own colon has no space).
 const TIMERE=/\d{1,2}[:h.]\d{2}(?:\s?[AaPp]\.?[Mm]\.?)?/;
 const parseLabel=labels=>{
  const lab=labels.find(l=>{const tm=TIMERE.exec(l),c=l.indexOf(', ');return tm&&c>tm.index;})||'';
  const tm=TIMERE.exec(lab);
  const colon=lab.indexOf(': ');
  const before=colon>=0?lab.slice(0,colon):lab;
  const comma=before.lastIndexOf(', ');
  return {t:tm?tm[0]:'',sender:comma>=0?before.slice(comma+2).trim():'',text:colon>=0?clean(lab.slice(colon+2)):''};
 };
 window.__fb={parseLabel,mergeChunks,press,sleep,clean,vtext,waitFor,visible,enabled,dismissRestore,postCards,postText,canon,groupPath,addGroup,TIME,SPON,ACT,trunc,scrollerOf,num};
})();
