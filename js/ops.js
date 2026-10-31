(()=>{
 const F=window.__fb;
 const {sleep,clean,vtext,waitFor,canon,groupPath,addGroup,TIME,SPON,ACT,trunc,scrollerOf,num}=F;
 const main=()=>document.querySelector('[role=main]');
 const tab=s=>String(s==null?'':s).replace(/[\t\r\n]+/g,' ');
 const abs=h=>{try{const u=new URL(h,location.href);return u.pathname+u.search}catch(e){return h}};
 // canonical path; keeps the query only where it identifies the target (profile.php?id=, permalink.php?story_fbid=&id=, photo?fbid=)
 const stripQ=h=>{const c=canon(h);return c.includes('?')?c:(c.replace(/\/$/,'')||'/');};
 // scroll the page until `collect()` yields n rows or growth stalls
 const gather=async(n,collect,ms=25000,sc=null,progress=null,finalize=null,order=null)=>{
  const t0=Date.now();let last=0,stall=0;const map=new Map();
  while(Date.now()-t0<ms){
   for(const r of collect(map))if(!map.has(r.k))map.set(r.k,r);
   if(map.size>=n)break;
   const current=progress?progress():map.size;
   if(current===last){if(++stall>=14)break;}else{stall=0;last=current;}
   const el=typeof sc==='function'?sc():sc;
   if(el)el.scrollTop+=el.clientHeight*0.8;else window.scrollBy(0,innerHeight*0.8);
   await sleep(220);
  }
  if(finalize?.())for(const r of collect(map,true))if(!map.has(r.k))map.set(r.k,r);
  const rows=[...map.values()];if(order)rows.sort(order);return rows.slice(0,n);
 };
 F.search=async(n,clues=[],type='people')=>{
  const normalize=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[đĐ]/g,'d').toLowerCase();
  clues=clues.map(c=>normalize(c.trim()));
  const exposed=e=>{for(;e;e=e.parentElement){const s=getComputedStyle(e);if(e.hidden||s.display==='none'||s.visibility!=='visible'||Number(s.opacity)===0)return false}return true};
  const state=await waitFor(()=>{
   const f=document.querySelector('[role=main] [role=feed]');if(f?.querySelector('[role=article]')&&exposed(f))return {feed:f};
   const m=main();if(m&&exposed(m)&&!m.querySelector('[role=article]')&&/không tìm thấy|no results|aucun résultat/i.test(m.innerText))return {empty:true};
   return null;
  },12000);
  if(!state?.feed)return {rows:[],note:state?.empty?'no results':'no results loaded'};
  const feed=state.feed;
  const pending=new Set(),dirty=new Set(),observed=new WeakSet(),signatures=new Set();let progress=0,signatureBytes=0,lastProgress=0,idle=0;
  const queue=a=>{if(!observed.has(a)){observed.add(a);progress++}pending.add(a)};
  const scan=node=>{if(node.nodeType!==1)return;if(node.matches('[role=article]'))queue(node);for(const a of node.querySelectorAll('[role=article]'))queue(a)};
  scan(feed);
  const observer=new MutationObserver(records=>{for(const record of records){
   const target=record.target.nodeType===1?record.target:record.target.parentElement,closest=target?.closest('[role=article]'),article=closest&&feed.contains(closest)?closest:null;
   if(article)queue(article);
   if(record.type==='childList')for(const node of record.addedNodes)scan(node);
   else if(record.type==='attributes'&&!article){
    const key=record.attributeName;
    if(key==='style'){
     const old=document.createElement('span');old.setAttribute('style',record.oldValue||'');
     if(['display','visibility','opacity','content-visibility'].some(p=>old.style.getPropertyValue(p)!==target.style.getPropertyValue(p)))dirty.add(feed.contains(target)?target:feed);
    }else if(['class','id','hidden','aria-hidden'].includes(key))dirty.add(feed.contains(target)?target:feed);
   }
  }});
  observer.observe(feed,{subtree:true,childList:true,characterData:true,attributes:true,attributeOldValue:true});
  for(let e=feed.parentElement;e;e=e.parentElement)observer.observe(e,{attributes:true,attributeOldValue:true});
  const shown=x=>x.checkVisibility?x.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}):x.getClientRects().length;
  const content=x=>{const u=new URL(x.href);return /\/posts\/|pfbid|\/permalink|\/videos?\/|\/reel\/|\/photos?(?:\/|$)|\/photo\.php$/i.test(u.pathname)||u.searchParams.has('fbid')};
  const person=x=>{const u=new URL(x.href);return (u.hostname==='facebook.com'||u.hostname.endsWith('.facebook.com'))&&/^\/(?:profile\.php|people\/[^/]+\/\d+|[a-z0-9.%_-]+)\/?$/i.test(u.pathname)&&!content(x)&&u.pathname!=='/search'};
  // what a result row IS, from its link, so callers can offer the right
  // actions; the tab is the fallback when the link alone does not say
  const kindOf=u=>{
   if(/\/groups\/[^/]+\/?$/.test(u))return 'group';
   if(/\/marketplace\/item\//.test(u))return 'listing';
   if(/\/events\/\d+/.test(u))return 'event';
   if(/\/photo|fbid=|\/photos\//.test(u))return 'photo';
   if(/\/watch|\/videos?\/|\/reel\//.test(u))return 'video';
   if(/\/posts\/|pfbid|\/permalink/.test(u))return 'post';
   return null;
  };
  const nameText=(link,parts)=>{const rendered=clean(link.innerText||'');return rendered&&normalize(rendered).replace(/\s+/g,'')===normalize(parts.join('')).replace(/\s+/g,'')?rendered:clean(parts.join(' '))};
  const compareNodes=(a,b)=>{const p=a.compareDocumentPosition(b);return p&Node.DOCUMENT_POSITION_DISCONNECTED?0:p&Node.DOCUMENT_POSITION_FOLLOWING?-1:p&Node.DOCUMENT_POSITION_PRECEDING?1:0};
  const order=(a,b)=>compareNodes(a.node,b.node);
  try{
   const rows=await gather(n,(seen,final=false)=>{
    if(progress===lastProgress)idle++;else{lastProgress=progress;idle=0}
    if(idle>=12&&dirty.size){for(const node of dirty)scan(node);dirty.clear()}
    const found=[],added=new Set(),cards=final?[...pending].sort(compareNodes):pending;for(const a of cards){
    pending.delete(a);if(!a.isConnected||!feed.contains(a))continue;
    const rawLinks=[...a.querySelectorAll('a[href]')];let signature='';for(const link of rawLinks){const url=stripQ(link.href);if(signature.length+url.length+1>8192){signature='';break}signature+=url+'\n'}
    if(signature&&signature.length<=8192&&signatureBytes+signature.length<=4*1024*1024&&!signatures.has(signature)){signatures.add(signature);signatureBytes+=signature.length;progress++}
    const all=vtext(a,true,true),label=all[0]||'';
    const visibleLinks=rawLinks.filter(x=>!x.closest('[hidden]')&&(shown(x)||getComputedStyle(x).display==='contents'&&(vtext(x,true,true).length||[...x.querySelectorAll('img,svg')].some(shown))));
    const links=visibleLinks.filter(x=>!x.closest('[aria-hidden="true"]'));
    let l,nameParts=[];if(type==='people'){
     const candidates=visibleLinks.filter(person),accessible=links.filter(person);
     const headed=candidates.filter(x=>x.closest('[role=heading],h1,h2,h3,h4,h5,h6')&&accessible.some(y=>stripQ(x.href)===stripQ(y.href)));
     const choices=headed.length?headed:accessible;if(new Set(choices.map(x=>stripQ(x.href))).size!==1)continue;
     const url=stripQ(choices[0].href),group=candidates.filter(x=>stripQ(x.href)===url),names=group.map(x=>({link:x,parts:vtext(x,true,true)})).filter(x=>x.parts.length);
     const paired=names.find(x=>x.link.closest('[aria-hidden="true"]')&&accessible.some(y=>{if(stripQ(y.href)!==url)return false;const label=normalize(clean(y.getAttribute('aria-label')||y.querySelector('img')?.alt||'')),name=normalize(nameText(x.link,x.parts));return label===name||label.endsWith(' '+name)}));
     const chosen=names.find(x=>headed.includes(x.link))||paired||names.find(x=>!x.link.closest('[aria-hidden="true"]'));
     if(chosen){l=chosen.link;nameParts=chosen.parts;if(l.closest('[aria-hidden="true"]')&&chosen!==paired)continue}
     else {l=choices[0];const alt=clean(l.querySelector('img')?.alt||'');if(alt)nameParts=[alt]}
     if(!nameParts.length||(!headed.length&&!paired&&!nameParts.some(t=>normalize(t)===normalize(label))))continue;
    }else l=visibleLinks.find(content)||links[0];
    if(!l)continue;
    const url=stripQ(l.href);if((seen.has(url)&&!final)||added.has(url))continue;
    const name=type==='people'?nameText(l,nameParts):(label||clean(l.querySelector('img')?.alt||''));
    if(clues.length){const text=normalize([name,...all].join(' '));if(!clues.every(c=>text.includes(c))){const raw=normalize(vtext(a,true,true,true).join(''));if(!clues.every(c=>text.includes(c)||raw.includes(c)))continue}}
    const btn=new Set([...a.querySelectorAll('[role=button]')].map(b=>clean(b.innerText)));
    const info=all.filter(c=>c!==name&&!nameParts.includes(c)&&!btn.has(c)&&c!=='·');
    const kind=kindOf(url)||({people:'profile',pages:'page',groups:'group',events:'event',photos:'photo',videos:'video',posts:'post',places:'place'})[type]||'profile';
    const target=['photo','video','event','place','listing'].includes(kind)?'https://www.facebook.com'+url:{r:'u',v:url};
    const row={k:url,node:a,v:[name,target,trunc(info.join(' · '),160),kind]};
    if(seen.has(url)){if(order(row,seen.get(url))<0)seen.set(url,row);continue}
    added.add(url);found.push(row);
    if((final?found.length:seen.size+found.length)>=n)break;
   }return found;},25000,null,()=>progress,()=>{for(const node of dirty)scan(node);dirty.clear();return pending.size>0},order);
   return {rows:rows.map(r=>r.v),...(!rows.length&&clues.length?{note:'no matching results'}:{})};
  }finally{observer.disconnect()}
 };
 // people search narrowed by the page's own Friends filter chip; when the
 // chip is not offered, fall back to plain people results and say so
 F.searchFriends=async(n,clues=[])=>{
  const chip=await waitFor(()=>[...document.querySelectorAll('[role=main] [role=button],[role=main] [role=switch],[role=main] [role=checkbox]')].find(b=>/^(Friends|Bạn bè|Amis)$/i.test(clean(b.innerText||b.getAttribute('aria-label')||''))),10000);
  let note;
  if(chip){chip.click();await sleep(1800);}else note='friends filter not offered by facebook here; showing all people';
  const r=await F.search(n,clues,'people');
  if(note&&!r.err)r.note=r.note?r.note+'; '+note:note;
  return r;
 };
 // marketplace search: listing cards link to /marketplace/item/<id>; the
 // card text is title, price and location in no guaranteed order, so the
 // price is the chunk that looks like money
 F.marketSearch=async(n)=>{
  const ok=await waitFor(()=>document.querySelector('[role=main] a[href*="/marketplace/item/"]'),12000);
  if(!ok)return {rows:[],note:'no listings loaded'};
  await sleep(500);
  const rows=await gather(n,()=>{
   const byPath=new Map();
   for(const a of document.querySelectorAll('[role=main] a[href*="/marketplace/item/"]')){
    const p=stripQ(a.getAttribute('href'));
    const chunks=vtext(a).map(clean).filter(Boolean);
    if(!chunks.length)continue;
    const price=chunks.find(c=>/^[$€£¥]|^(Free|Miễn phí)$/i.test(c))||'';
    const rest=chunks.filter(c=>c!==price);
    if(!byPath.has(p))byPath.set(p,{title:rest[0]||'',price,loc:rest.slice(1).join(' · ')});
   }
   return [...byPath.entries()].map(([p,g])=>({k:p,v:[g.title,'https://www.facebook.com'+p,trunc([g.price,g.loc].filter(Boolean).join(' · '),120),'listing']}));
  });
  return {rows:rows.map(r=>r.v)};
 };
 F.friends=async(n)=>{
  const ok=await waitFor(()=>document.querySelector('[role=main] a[href*="friends_mutual"]')||document.querySelector('[role=main] [role=tablist]'),12000);
  if(!ok)return {rows:[],complete:false,note:'no friends visible'};
  await sleep(600);
  const more=/^(?:More options for|Lựa chọn khác cho|Plus d.options pour) (.+)$/i;
  // Use the section's own heading, not a row/grid inferred from the number of cards.
  const friendRoot=()=>{
   const roots=new Set();
   for(const a of document.querySelectorAll('[role=main] a[href]')){
    if(!/\/friends\/?$/.test(new URL(a.href).pathname)||!/^(Friends|Bạn bè|Amis)$/i.test(clean(a.innerText)))continue;
    for(let p=a.parentElement;p&&p!==main();p=p.parentElement){if(p.querySelector('a[href*="friends_mutual"]')){roots.add(p);break}}
   }
   const inner=[...roots].filter(r=>![...roots].some(other=>other!==r&&r.contains(other)));
   return inner.length===1?inner[0]:null;
  };
  let bottomSince=null,lastSignature='',hasCards=false,listRoot=null;const unparsed=new Set();
  const rows=await gather(n,()=>{
   listRoot||=friendRoot();const scope=listRoot||main();
   const out=[];
   /* the first two named links per target (m itself can be one of them): one pass instead of a scan per row */
   const named=new Map();
   for(const a of scope.querySelectorAll('a[href]')){
    const text=clean(a.innerText);if(!text)continue;
    const k=stripQ(a.href),l=named.get(k);
    if(!l)named.set(k,[{a,text}]);else if(l.length<2)l.push({a,text});
   }
   for(const m of scope.querySelectorAll('a[href*="friends_mutual"]')){
    const base=stripQ(m.href.replace(/\/friends_mutual.*/,''));
    const link=named.get(base)?.find(x=>x.a!==m);
    if(!link)continue;
    out.push({k:base,v:[link.text,{r:'u',v:base},clean(m.innerText)]});
   }
   const have=new Set(out.map(r=>r.k));
   // Mutual-friend links are absent on some cards; their own options control still identifies them.
   for(const b of (listRoot||main()).querySelectorAll('[role=button][aria-label],button[aria-label]')){
    const match=more.exec(clean(b.getAttribute('aria-label')||''));if(!match)continue;
    const name=match[1];let found=false;
    for(let p=b.parentElement;p&&p!==main();p=p.parentElement){
     const navigation=[...p.querySelectorAll('a[href]')];
     if(navigation.length&&navigation.every(a=>/\/friends\/?$/.test(new URL(a.href).pathname))){found=true;break}
     if([...p.querySelectorAll('[aria-label]')].filter(e=>more.test(e.getAttribute('aria-label')||'')).length>1)break;
     if(!p.querySelector('a[href]')&&clean(p.innerText)===name){
      const k='unavailable:'+name;if(!have.has(k)){have.add(k);out.push({k,v:[name,null,'profile unavailable']})}
      hasCards=true;found=true;break;
     }
     const links=[...p.querySelectorAll('a[href]')].filter(a=>clean(a.innerText)===name),paths=new Set(links.map(a=>stripQ(a.href)));
     if(paths.size!==1)continue;
     const k=[...paths][0];
     if(!/\/friends(?:_all)?\/?$/.test(k.split('?')[0])){
      hasCards=true;if(!have.has(k)){have.add(k);out.push({k,v:[name,{r:'u',v:k},'']})}
     }
     found=true;break;
    }
    if(found)unparsed.delete(b);else unparsed.add(b);
   }
   if(listRoot)for(const b of unparsed)if(!listRoot.contains(b))unparsed.delete(b);
   const el=document.scrollingElement,signature=out.map(r=>r.k).join('\n')+'|'+(listRoot?.scrollHeight||el?.scrollHeight);
   const bottom=listRoot?listRoot.getBoundingClientRect().bottom<=innerHeight+2:el&&el.scrollTop+el.clientHeight>=el.scrollHeight-2;
   if(bottom&&signature===lastSignature)bottomSince??=Date.now();else bottomSince=null;
   lastSignature=signature;
   return out;
  });
  return {rows:rows.map(r=>r.v),complete:!!listRoot&&listRoot.isConnected&&main()?.contains(listRoot)&&friendRoot()===listRoot&&hasCards&&!unparsed.size&&rows.length<n&&bottomSince!==null&&Date.now()-bottomSince>=2500&&!(listRoot||main())?.querySelector('[aria-busy="true"],[role=progressbar]')};
 };
 F.groups=async(n)=>{
  const ok=await waitFor(()=>document.querySelector('[role=main] a[href*="/groups/"]'),12000);
  if(!ok)return {rows:[],note:'no groups visible'};
  await sleep(600);
  /* details can render on a later scroll pass than the name, so merge every pass into one entry per group */
  const acc=new Map();
  const shown=a=>{const s=getComputedStyle(a);return s.visibility==='visible'&&(a.getClientRects().length>0||s.display==='contents'&&!!clean(a.innerText))};
  const scan=()=>{
   for(const a of document.querySelectorAll('[role=main] a[href]')){
    const p=groupPath(a.getAttribute('href'));if(!p||!shown(a))continue;
    let lines=(a.innerText||'').split('\n').map(clean).filter(Boolean);
    if(!lines.length)lines=[clean(a.getAttribute('aria-label')||a.querySelector('img[alt]')?.alt||'')].filter(Boolean);
    if(lines.length)addGroup(acc,p,lines);
   }
   return [...acc.keys()].map(k=>({k}));
  };
  await gather(n,scan);
  /* the limit can be reached before the last link of a group renders: let it settle once */
  await sleep(300);scan();
  return {rows:[...acc].slice(0,n).map(([k,g])=>[g.name,k,trunc(g.info.join(' · '),120)])};
 };
 F.notifs=async(n)=>{
  const ok=await waitFor(()=>document.querySelector('[role=main] [role=list] [role=listitem] a[href]')||document.querySelector('[role=list] [role=listitem] a[href]'),12000);
  if(!ok)return {rows:[],note:'no notifications'};
  await sleep(500);
  const sc=document;
  const rows=await gather(n,()=>[...document.querySelectorAll('[role=list] [role=listitem]')].map(li=>{
   const a=li.querySelector('a[href]');if(!a)return null;
   const unread=!![...a.querySelectorAll('[role=button]')].length;
   const ch=vtext(a);
   const ti=ch.findIndex(c=>TIME.test(c));
   const time=ti>=0?ch[ti]:'';
   const body=ch.filter((c,i)=>i!==ti&&!/^(Chưa đọc|Unread|Non lu)$/i.test(c)).join(' ').replace(/ ([:,.!?])/g,'$1');
   const h=abs(a.href);
   return {k:h+body,v:[time,unread?'!':'-',trunc(body,140),{r:'p',v:h}]};
  }).filter(Boolean));
  return {rows:rows.map(r=>r.v)};
 };
 F.profile=async(n)=>{
  const m=await waitFor(()=>{const m=main();return m&&m.querySelector('[role=tablist]')&&m},15000);
  if(!m)return {err:'profile not found / not accessible'};
  await sleep(700);
  const lines=[];
  const big=[...m.querySelectorAll('h1,h2,span,div')].filter(e=>e.children.length<=3&&/\S/.test(e.innerText||'')&&e.innerText.length<70&&parseFloat(getComputedStyle(e).fontSize)>=26).sort((a,b)=>parseFloat(getComputedStyle(b).fontSize)-parseFloat(getComputedStyle(a).fontSize))[0];
  const name=clean(big?big.innerText:document.title.replace(/^\(\d+\)\s*/,'').replace(/\s*\|.*$/,''));
  lines.push('name\t'+tab(name));
  lines.push('url\t'+stripQ(location.href));
  const fr=[...m.querySelectorAll('a[href*="friends"]')].find(a=>/\d/.test(a.innerText));
  if(fr)lines.push('friends\t'+tab(clean(fr.innerText)));
  const fo=[...m.querySelectorAll('a[href*="followers"],a[href*="following"]')].filter(a=>/\d/.test(a.innerText)).map(a=>clean(a.innerText));
  if(fo.length)lines.push('follow\t'+tab(fo.join(' / ')));
  for(const l of m.querySelectorAll('[role=list]')){
   if(l.closest('[role=tablist]')||l.closest('[role=feed]'))continue;
   const items=[...l.children].map(c=>clean(vtext(c).join(' '))).filter(Boolean);
   if(!items.length||items.length>12)continue;
   const lab=l.getAttribute('aria-label')||'';
   lines.push(tab(lab?trunc(lab,24):'info')+'\t'+tab(items.join(' | ')));
  }
  const tl=m.querySelector('[role=tablist]');
  const btns=[...m.querySelectorAll('[role=button]')].filter(b=>!b.closest('[role=tablist],[role=feed],[role=list]')&&tl&&(tl.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_PRECEDING)&&/\S/.test(b.innerText)&&b.innerText.length<22&&!b.querySelector('img')&&clean(b.innerText)!==name&&!/\d/.test(b.innerText)).map(b=>clean(b.innerText));
  const bio=[...m.querySelectorAll('[data-pagelet*=ProfileTilesFeed],[data-pagelet*=Intro]')].map(e=>clean(vtext(e).join(' | '))).filter(Boolean);
  if(bio.length)lines.push('intro\t'+tab(trunc(bio[0],400)));
  lines.push('actions\t'+tab([...new Set(btns)].slice(0,12).join(' | ')));
  return {lines};
 };
 F.postView=async(n)=>{
  const find=()=>{for(const d of document.querySelectorAll('[role=dialog]'))if(d.querySelector('[data-ad-rendering-role=profile_name]'))return d;const m=main();return m&&m.querySelector('[data-ad-rendering-role=profile_name]')&&m;};
  const root=await waitFor(find,15000);
  if(!root)return {err:'post not found'};
  await sleep(800);
  const g=r=>root.querySelector('[data-ad-rendering-role='+r+']');
    const ch=vtext(g('profile_name').parentElement.parentElement.parentElement);
  const ti=ch.findIndex((c,i)=>i<12&&TIME.test(c));
  const head=ch.slice(0,ti<0?1:ti).filter(c=>c!=='·');
  const msg=g('story_message');
  const lines=[];
  lines.push('by\t'+tab(head.join(' / '))+(ti>=0?'\t'+tab(ch[ti]):''));
  lines.push('stats\t'+num(g('like_button'))+'/'+num(g('comment_button'))+'/'+num(g('share_button'))+'\t(react/comment/share)');
  if(msg)lines.push('text\t'+tab(F.postText(msg).replace(/\n/g,' ⏎ ')));
  const media=[...root.querySelectorAll('a[href*="/photo"] img,a[href*="/photo"],video')].length;
  if(media)lines.push('media\t'+media);
  const scEl=()=>{const a=root.querySelector('[role=article][aria-label]');return (a&&scrollerOf(a))||scrollerOf(root)||null;};
  const com=await gather(n,()=>[...root.querySelectorAll('[role=article][aria-label]')].map(a=>{
   const c=vtext(a).filter(x=>x!=='·');
   const ti=c.findIndex((x,i)=>i<6&&TIME.test(x));
   const end=c.findIndex((x,i)=>i>(ti<0?0:ti)&&ACT.test(x));
   const body=c.slice(ti<0?1:ti+1,end<0?c.length:end).filter(x=>!/^(của tác giả|Author|Auteur|Top fan|Người hâm mộ.*)$/i.test(x)).join(' ');
   const lab=a.getAttribute('aria-label')||'';
   const nested=!!a.parentElement.closest('[role=article][aria-label]');
   return {k:lab+body,v:[(nested?'  ↳':'')+c[0],ti>=0?c[ti]:'',trunc(body,300)]};
  }),20000,scEl);
  for(const c of com)lines.push('c\t'+c.v.map(tab).join('\t'));
  return {lines};
 };
})();
