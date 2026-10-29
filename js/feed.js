(()=>{
 const {TIME,SPON,vtext,num,postCards,postText,canon,waitFor}=window.__fb;
 let seen=new WeakMap();let seq=0,current=null;
 const timeNode=(u,tt)=>{const w=document.createTreeWalker(u,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const t=n.nodeValue;if(!t||t.includes('\u034f')||n.parentElement.closest('blockquote'))continue;if(t.replace(/[\u200b-\u200f\u2060\ufeff]/g,'').trim()===tt)return n;}return null;};
 const decode=a=>{
  const cs=[];const w=document.createTreeWalker(a,NodeFilter.SHOW_TEXT);let n;
  while(n=w.nextNode()){const p=n.parentElement;if(getComputedStyle(p).position!=='relative')continue;const rg=document.createRange();rg.selectNodeContents(n);const r=rg.getBoundingClientRect();if(r.width>0)cs.push({t:n.nodeValue,r});}
  cs.sort((x,y)=>x.r.left-y.r.left);
  if(!cs.length)return null;
  const L=Math.min(...cs.map(c=>c.r.left)),R=Math.max(...cs.map(c=>c.r.right)),T=Math.min(...cs.map(c=>c.r.top)),B=Math.max(...cs.map(c=>c.r.bottom));
  return {text:cs.map(c=>c.t).join('').trim(),x:(L+R)/2,y:(T+B)/2};
 };
 const timeLink=u=>[...u.querySelectorAll('a[href]')].find(a=>/^(\?|.*(?:\/posts\/|story_fbid|\/permalink))/.test(a.getAttribute('href')));
 const g=(u,r)=>u.querySelector('[data-ad-rendering-role='+r+']');
 const render=u=>[u.getAttribute('aria-posinset')||'',g(u,'profile_name')?.innerText||'',g(u,'profile_name')?.querySelector('a')?.getAttribute('href')||'',postText(g(u,'story_message')),timeLink(u)?.innerText||''].join('\0');
 const POST=/\/posts\/|pfbid|\/permalink|story_fbid|multi_permalinks|\/videos\/|\/reel\/|\/photo\/?\?fbid/;
 /* a card is remembered under every rendering it had, since revealing its link can change it */
 const mark=(u,...rs)=>{const s=seen.get(u)||new Set();rs.forEach(r=>s.add(r));seen.set(u,s);};
 window.__fbFeed={
  /* returns every new post that needs no hover, then at most one that does: the caller must
     hover that last one before the page scrolls again */
  async step(){
   const out=[];
   for(const u of postCards()){
    const name=g(u,'profile_name');
    if(!name)continue;
    /* skip read cards before any waiting: ads never reveal, so waiting on every mounted card
       each step made one page of posts take a minute */
    const before=render(u);
    if(seen.get(u)?.has(before))continue;
    /* Facebook leaves the timestamp link as ?__cft__ until it is hovered or focused; focus needs no
       coordinates. It fills the href in asynchronously, so wait for it before keying the card,
       or the revealed href makes the same card look like a new post on the next step. */
    const hidden=timeLink(u);
    if(hidden&&/^\?/.test(hidden.getAttribute('href'))){
     hidden.focus({preventScroll:true});
     await waitFor(()=>!/^\?/.test(hidden.getAttribute('href')||''),400,30);
     hidden.blur();
    }
    mark(u,before,render(u));
    const real=hidden?.getAttribute('href')||'';
    const url=!/^\?/.test(real)&&POST.test(real)&&!/comment_id/.test(real)?canon(real):'';
    const pos=++seq;
    const ch=vtext(u);
    let ti=ch.findIndex((c,i)=>i<10&&TIME.test(c));
    const dot=ch.indexOf('·');
    const head=ch.slice(0,ti>=0?ti:(dot>0?dot:1)).filter(c=>c!=='·'&&c.length>1);
    const msg=g(u,'story_message');
    let hover=null,dt=null;
    const tlk=timeLink(u);
    if(tlk){if(!url)tlk.scrollIntoView({block:'center'});dt=decode(tlk);if(dt)hover=[dt.x,dt.y];}
    if(url)hover=null;
    else if(!hover){const tn=ti<0?null:timeNode(u,ch[ti]);if(tn){tn.parentElement.scrollIntoView({block:'center'});const rg=document.createRange();rg.selectNodeContents(tn);const r=rg.getBoundingClientRect();if(r.width>0)hover=[r.x+r.width/2,r.y+r.height/2];}}
    const alt=[...u.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).find(h=>POST.test(h)&&!/comment_id/.test(h));
    out.push({pos,url,alt:alt?canon(alt):'',author:head.join(' / '),time:dt&&dt.text?dt.text:(ti<0?'':ch[ti]),text:postText(msg),
      r:num(g(u,'like_button')),c:num(g(u,'comment_button')),s:num(g(u,'share_button')),
      ad:ch.slice(0,12).some(c=>SPON.test(c)),hover});
    if(url||!hover)continue;
    current={pos,u,render:render(u),name,msg};
    break;
   }
   return out;
  },
  href(x,y,pos){
   const e=document.elementFromPoint(x,y);
   const a=e&&e.closest('a[href]');
   const pending=current&&current.pos===pos?current:null;current=null;const u=pending&&pending.u;
   if(!u||pending.render!==render(u)||pending.name!==g(u,'profile_name')||pending.msg!==g(u,'story_message')){if(u)seen.delete(u);return null}
   mark(u,render(u));
   return a&&u&&u.contains(a)?canon(a.href):'';
  },
  expand(){
   for(const card of postCards()){
    const msg=g(card,'story_message');if(!msg)continue;
    for(const b of msg.querySelectorAll('[role=button],button')){
     if(/^(See more|Xem thêm|Voir plus|Afficher la suite)$/i.test(window.__fb.clean(b.innerText)))window.__fb.press(b);
    }
   }
  },
  scroll(){window.scrollBy(0,innerHeight*0.7)}
 };
 return 1;
})()
