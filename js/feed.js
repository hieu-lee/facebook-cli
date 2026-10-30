(()=>{
 const {TIME,SPON,vtext,num,postCards,postText,canon,waitFor,clean}=window.__fb;
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
 const more=msg=>msg?[...msg.querySelectorAll('[role=button],button')].filter(b=>window.__fb.visible(b)&&/^(See more|Xem thêm|Voir plus|Afficher la suite)$/i.test(clean(b.innerText))):[];
 const render=u=>[u.getAttribute('aria-posinset')||'',g(u,'profile_name')?.innerText||'',g(u,'profile_name')?.querySelector('a')?.getAttribute('href')||'',postText(g(u,'story_message')),attached(u),timeLink(u)?.innerText||''].join('\0');
 const POST=/\/posts\/|pfbid|\/permalink|story_fbid|multi_permalinks|\/videos\/|\/reel\/|\/photo\/?\?fbid/;
 /* which post a card shows: position, author and text; its time and links fill in later and would
    make the same post look new, while the position tells a recycled card's new post from the old */
 const key=u=>{const a=g(u,'profile_name')?.querySelector('a');let p='';try{const l=a&&new URL(a.getAttribute('href'),location.href);p=l?l.pathname+(l.searchParams.get('id')||''):''}catch(e){}return (u.getAttribute('aria-posinset')||'')+'\0'+p+'\0'+postText(g(u,'story_message'))};
 /* the permalink a timestamp link has revealed, else '' */
 const permalink=a=>{const h=a?.getAttribute('href')||'';return !/^\?/.test(h)&&POST.test(h)&&!/comment_id/.test(h)?canon(h):''};
 /* a card is read again when its content changed or its revealed permalink became another one:
    cards without a position (profiles, groups) can be recycled for another post with the same
    author and caption. A link that was not revealed yet is no identity, and revealing one is not a change. */
 const linkId=u=>permalink(timeLink(u));
 const unread=u=>{const s=seen.get(u);if(!s)return true;const l=linkId(u);if(s.k!==key(u)||(s.l&&s.l!==l))return true;s.l=l;return false};
 const mark=u=>seen.set(u,{k:key(u),l:linkId(u)});
 /* a share or reel without a message of its own: its attachment title, else a photo description.
    Attachment fields can hold scrambled single-word tokens instead of text, so require a space. */
 const attached=u=>{
  const t=['title','description'].map(r=>clean(g(u,r)?.innerText)).filter(s=>/\s/.test(s));
  if(t.length)return t.join(' ');
  const alt=[...u.querySelectorAll('img')].find(i=>i.width>=100&&i.alt&&!/^No photo description/i.test(i.alt))?.alt;
  return alt?'Photo: '+clean(alt):'';
 };
 window.__fbFeed={
  /* returns every new post that needs no hover, then at most one that does: the caller must
     hover that last one before the page scrolls again */
  async step(){
   await this.expand();
   const out=[];
   for(const u of postCards()){
    const name=g(u,'profile_name');
    if(!name)continue;
    if(more(g(u,'story_message')).length)continue;
    /* skip read cards before any waiting: ads never reveal, so waiting on every mounted card
       each step made one page of posts take a minute */
    if(!unread(u))continue;
    /* Facebook leaves the timestamp link as ?__cft__ until it is hovered or focused; focus needs no
       coordinates. It fills the href in asynchronously, so wait for it before reading the link. */
    const hidden=timeLink(u);
    if(hidden&&/^\?/.test(hidden.getAttribute('href'))){
     const was=key(u)+'\0'+attached(u);
     hidden.focus({preventScroll:true});
     await waitFor(()=>!/^\?/.test(hidden.getAttribute('href')||''),400,30);
     hidden.blur();
     /* the card may have been recycled for another post while we waited: read it again next step */
     if(!u.contains(hidden)||key(u)+'\0'+attached(u)!==was)continue;
    }
    const url=permalink(hidden);
    mark(u);
    const pos=++seq;
    const ch=vtext(u);
    let ti=ch.findIndex((c,i)=>i<10&&TIME.test(c));
    const dot=ch.indexOf('·');
    const head=ch.slice(0,ti>=0?ti:(dot>0?dot:1)).filter(c=>c!=='·'&&c.length>1);
    /* Shared-source headers follow the first timestamp; comments follow the post's reactions. */
    const reactions=g(u,'like_button');
    for(const profile of u.querySelectorAll('[data-ad-rendering-role=profile_name]')){
     if(!window.__fb.visible(profile)||profile.closest('blockquote')||(reactions&&!(profile.compareDocumentPosition(reactions)&Node.DOCUMENT_POSITION_FOLLOWING)))continue;
     const author=clean(profile.innerText);if(author&&!head.includes(author))head.push(author);
    }
    const msg=g(u,'story_message');
    /* an unfilled card has no author or text yet: read it again once Facebook renders it */
    if(!head.length&&!postText(msg)){seen.delete(u);continue}
    let hover=null,dt=null;
    const tlk=timeLink(u);
    if(tlk){if(!url)tlk.scrollIntoView({block:'center'});dt=decode(tlk);if(dt)hover=[dt.x,dt.y];}
    if(url)hover=null;
    else if(!hover){const tn=ti<0?null:timeNode(u,ch[ti]);if(tn){tn.parentElement.scrollIntoView({block:'center'});const rg=document.createRange();rg.selectNodeContents(tn);const r=rg.getBoundingClientRect();if(r.width>0)hover=[r.x+r.width/2,r.y+r.height/2];}}
    const alt=[...u.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).find(h=>POST.test(h)&&!/comment_id/.test(h));
    out.push({pos,url,alt:alt?canon(alt):'',author:head.join(' / '),time:dt&&dt.text?dt.text:(ti<0?'':ch[ti]),text:postText(msg)||attached(u),
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
   mark(u);
   return a&&u&&u.contains(a)?canon(a.href):'';
  },
  async expand(){
   const pending=[];
   for(const card of postCards()){
    const msg=g(card,'story_message');if(!msg)continue;
    for(const b of more(msg)){
     pending.push(msg);window.__fb.press(b);
    }
   }
   // Expand the whole batch together; never cache a card while its text is still collapsed.
   if(pending.length)await waitFor(()=>pending.every(msg=>!more(msg).length),1500,30);
  },
  scroll(){window.scrollBy(0,innerHeight*0.7)},
  /* the feed sometimes stops loading at the bottom; leaving and re-entering it starts it again */
  async nudge(){scrollBy(0,-innerHeight*2);await new Promise(r=>setTimeout(r,400));scrollTo(0,document.body.scrollHeight);return 1}
 };
 return 1;
})()
