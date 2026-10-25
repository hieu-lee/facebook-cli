(()=>{
 if(window.__fb)return;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const clean=s=>(s||'').replace(/[͏​-‏⁠﻿]/g,'').replace(/[ \t ]+/g,' ').replace(/ *\n */g,'\n').trim();
 const vtext=root=>{const w=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const o=[];let n;while(n=w.nextNode()){const t=n.nodeValue;if(!t||!t.trim()||t.includes('͏'))continue;const p=n.parentElement;if(!p||p.closest('blockquote'))continue;const c=t.replace(/[​-‏⁠﻿]/g,'').replace(/ /g,' ').trim();if(c)o.push(c);}return o;};
 const waitFor=async(f,ms=10000,step=60)=>{const t=Date.now();for(;;){let v;try{v=f()}catch(e){}if(v)return v;if(Date.now()-t>ms)return null;await sleep(step);}};
 const killDialogs=()=>{document.querySelectorAll('[role=dialog]').forEach(d=>{if(/PIN|khôi phục|restore|chat history/i.test(d.innerText)||d.querySelector('[aria-label=Mã\\ PIN],[aria-label=PIN]'))d.remove();});};
 const canon=h=>{try{const u=new URL(h,location.href);const KEEP=['fbid','story_fbid','id','v','set','idorvanity','q'];const mp=u.searchParams.get('multi_permalinks');if(mp&&/^\/groups\/\d+\/?$/.test(u.pathname))return u.pathname.replace(/\/?$/,'/posts/'+mp);for(const p of [...u.searchParams.keys()])if(!KEEP.includes(p))u.searchParams.delete(p);return u.pathname+u.search;}catch(e){return ''}};
 const TIME=/^(\d+\s*(giây|phút|giờ|ngày|tuần|tháng|năm)(\s*trước)?|Hôm qua.*|Vừa xong|Yesterday.*|Just now|\d+\s*(s|m|h|d|w|y|hr|hrs|min|mins)|\d+\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)(\s+ago)?|\d{1,2}\s+tháng\s+\d{1,2}.*|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}.*|il y a .*|hier.*|\d{1,2} (janv|févr|mars|avr|mai|juin|juil|août|sept|oct|nov|déc).*)$/i;
 const SPON=/^(Được tài trợ|Sponsored|Sponsorisé|Gesponsert|Patrocinado)/i;
 const ACT=/^(Thích|Like|J'aime|Trả lời|Reply|Répondre|Chia sẻ|Share|Partager|Đã chỉnh sửa|Edited|Modifié|Dịch|See translation|Xem bản dịch)$/i;
 const trunc=(s,n)=>{if(!s)return s;const a=Array.from(s);return a.length>n?a.slice(0,n).join('')+'…':s;};
 const scrollerOf=el=>{let p=el;while(p&&p!==document.body&&p!==document.documentElement){if(p.scrollHeight>p.clientHeight+20&&/auto|scroll/.test(getComputedStyle(p).overflowY))return p;p=p.parentElement;}return null;};
 const num=e=>{const g=e&&e.parentElement&&e.parentElement.parentElement;const t=g?g.innerText.trim():'';return /^[\d.,]+[KMkmN]?$/.test(t)?t:'0';};
 const press=el=>{
  const rc=el.getBoundingClientRect();const o={bubbles:true,cancelable:true,view:window,clientX:rc.x+rc.width/2,clientY:rc.y+rc.height/2,button:0,pointerId:1,pointerType:'mouse',isPrimary:true};
  for(const t of ['pointerover','mouseover','pointerdown','mousedown','pointerup','mouseup','click']){
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
 window.__fb={parseLabel,mergeChunks,press,sleep,clean,vtext,waitFor,killDialogs,canon,TIME,SPON,ACT,trunc,scrollerOf,num};
})();
