(()=>{
 const {TIME,SPON,vtext,num}=window.__fb;
 const seen=new Set();
 const timeNode=(u,tt)=>{const w=document.createTreeWalker(u,NodeFilter.SHOW_TEXT);let n;while(n=w.nextNode()){const t=n.nodeValue;if(!t||t.includes('\u034f')||n.parentElement.closest('blockquote'))continue;if(t.replace(/[\u200b-\u200f\u2060\ufeff]/g,'').trim()===tt)return n;}return null;};
 const decode=a=>{
  const cs=[];const w=document.createTreeWalker(a,NodeFilter.SHOW_TEXT);let n;
  while(n=w.nextNode()){const p=n.parentElement;if(getComputedStyle(p).position!=='relative')continue;const rg=document.createRange();rg.selectNodeContents(n);const r=rg.getBoundingClientRect();if(r.width>0)cs.push({t:n.nodeValue,r});}
  cs.sort((x,y)=>x.r.left-y.r.left);
  if(!cs.length)return null;
  const L=Math.min(...cs.map(c=>c.r.left)),R=Math.max(...cs.map(c=>c.r.right)),T=Math.min(...cs.map(c=>c.r.top)),B=Math.max(...cs.map(c=>c.r.bottom));
  return {text:cs.map(c=>c.t).join('').trim(),x:(L+R)/2,y:(T+B)/2};
 };
 const timeLink=u=>[...u.querySelectorAll('a[href]')].find(a=>a.getAttribute('href').startsWith('?'));
 const KEEP=['fbid','story_fbid','id','v','set','idorvanity'];
 const canon=h=>{try{const u=new URL(h,location.href);const mp=u.searchParams.get('multi_permalinks');if(mp&&/^\/groups\/\d+\/?$/.test(u.pathname))return u.pathname.replace(/\/?$/,'/posts/'+mp);for(const p of [...u.searchParams.keys()])if(!KEEP.includes(p))u.searchParams.delete(p);return u.pathname+u.search;}catch(e){return ''}};
 const g=(u,r)=>u.querySelector('[data-ad-rendering-role='+r+']');
 window.__fbFeed={
  /* returns at most one new post: the caller must hover it before the page scrolls again */
  step(){
   const out=[];
   for(const u of document.querySelectorAll('[aria-posinset]')){
    const name=g(u,'profile_name');
    if(!name)continue;
    const pos=+u.getAttribute('aria-posinset');
    if(seen.has(pos))continue;
    seen.add(pos);
    const ch=vtext(u);
    let ti=ch.findIndex((c,i)=>i<10&&TIME.test(c));
    const dot=ch.indexOf('·');
    const head=ch.slice(0,ti>=0?ti:(dot>0?dot:1)).filter(c=>c!=='·'&&c.length>1);
    const msg=g(u,'story_message');
    const al=name.querySelector('a')||name.closest('a');
    let hover=null,dt=null;
    const tlk=timeLink(u);
    if(tlk){tlk.scrollIntoView({block:'center'});dt=decode(tlk);if(dt)hover=[dt.x,dt.y];}
    if(!hover){const tn=ti<0?null:timeNode(u,ch[ti]);if(tn){tn.parentElement.scrollIntoView({block:'center'});const rg=document.createRange();rg.selectNodeContents(tn);const r=rg.getBoundingClientRect();if(r.width>0)hover=[r.x+r.width/2,r.y+r.height/2];}}
    const alt=[...u.querySelectorAll('a[href]')].map(a=>a.getAttribute('href')).find(h=>/\/posts\/|pfbid|\/permalink|story_fbid|\/videos\/|\/reel\/|\/photo\/?\?fbid/.test(h)&&!/comment_id/.test(h));
    out.push({pos,alt:alt?canon(alt):'',author:head.join(' / '),time:dt&&dt.text?dt.text:(ti<0?'':ch[ti]),text:msg?vtext(msg).join('\n'):'',
      r:num(g(u,'like_button')),c:num(g(u,'comment_button')),s:num(g(u,'share_button')),
      ad:ch.slice(0,12).some(c=>SPON.test(c)),hover});
    break;
   }
   return out;
  },
  href(x,y,pos){
   const e=document.elementFromPoint(x,y);
   const a=e&&e.closest('a[href]');
   const u=document.querySelector('[aria-posinset="'+pos+'"]');
   return a&&u&&u.contains(a)?canon(a.href):'';
  },
  scroll(){window.scrollBy(0,innerHeight*0.7)}
 };
 return 1;
})()
