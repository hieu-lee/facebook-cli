async (storyId,ownerId,limit,startAtTarget=false,bucketId=null) => {
 const seen=new WeakMap();
 const url=m=>m?.__typename==='Video'?m.playable_url:m?.__typename==='Photo'?m.image?.uri:null;
 const sameUrl=(a,b)=>{try{const x=new URL(a),y=new URL(b);return x.protocol===y.protocol&&x.host===y.host&&x.pathname===y.pathname}catch{return a===b}};
 const copy=o=>{const s=o.unified_stories_with_notes;return {unified_stories_with_notes:{count:s.count,page_info:s.page_info,edges:s.edges.map(e=>e?.node?{node:{id:e.node.id,attachments:Array.isArray(e.node.attachments)?e.node.attachments.slice():e.node.attachments}}:null)}}};
 return await window.__fb.waitFor(()=>{
  let candidate=null,conflict=false,foundStory=false,knownOwner=ownerId||null;const mediaConflicts=new Set();
  for(const script of document.querySelectorAll('script[type="application/json"]')){
   const text=script.textContent;if(!text.includes('unified_stories_with_notes'))continue;if(text.length>8*1024*1024)return {error:'story metadata incomplete'};
   let cached=seen.get(script);
   if(!cached||cached.text!==text){
    let root;try{root=JSON.parse(text)}catch{return null}
    const fragments=[],stack=[root];let visited=0;
    while(stack.length&&visited++<100000){
     const o=stack.pop();if(!o||typeof o!=='object')continue;
     const edges=o.unified_stories_with_notes?.edges,contains=Array.isArray(edges)&&edges.some(e=>e?.node?.id===storyId);
     if(Array.isArray(edges)&&(contains&&o.owner?.id||bucketId&&String(o.id)===bucketId))fragments.push({o,contains});
     for(const v of Object.values(o))if(v&&typeof v==='object')stack.push(v);
    }
    if(stack.length)return {error:'story metadata incomplete'};
    cached={text,fragments};seen.set(script,cached);
   }
   for(const {o,contains} of cached.fragments){
    const stories=o.unified_stories_with_notes,edges=stories.edges,owner=o.owner?.id;
    if(owner&&knownOwner&&owner!==knownOwner)return {error:ownerId?'story owner mismatch':'conflicting story data'};
    if(owner)knownOwner=owner;
    if(contains){if(bucketId&&String(o.id)!==bucketId)return {error:'story bucket mismatch'};foundStory=true}
    if(!candidate){candidate=copy(o);continue}
    const previous=candidate.unified_stories_with_notes,old=previous.edges;
    for(let i=0;i<Math.min(old.length,edges.length);i++)if(old[i]?.node?.id!==edges[i]?.node?.id)return {error:'conflicting story data'};
    if(old.length!==edges.length||typeof previous.page_info?.has_next_page==='boolean'&&typeof stories.page_info?.has_next_page==='boolean'&&previous.page_info.has_next_page!==stories.page_info.has_next_page||typeof previous.count==='number'&&typeof stories.count==='number'&&previous.count!==stories.count)conflict=true;
    const longer=edges.length>old.length,selected=longer?copy(o):candidate,other=longer?candidate:o;
    const chosen=selected.unified_stories_with_notes.edges,donor=other.unified_stories_with_notes.edges;
    for(let i=0;i<Math.min(chosen.length,donor.length);i++){
     const node=chosen[i]?.node,alt=donor[i]?.node;if(!node||!alt)continue;
     let a=Array.isArray(node.attachments)?node.attachments:[],b=Array.isArray(alt.attachments)?alt.attachments:[];
     if(a.length&&b.length&&a.length!==b.length)mediaConflicts.add(node.id);
     if(b.length>a.length){node.attachments=b.slice();[a,b]=[node.attachments,a]}
     for(let j=0;j<Math.min(a.length,b.length);j++){
      const x=a[j]?.media,y=b[j]?.media,ux=url(x),uy=url(y);
      if(x&&y&&(x.__typename&&y.__typename&&x.__typename!==y.__typename||x.id&&y.id&&x.id!==y.id||ux&&uy&&(!x.id||!y.id)&&!sameUrl(ux,uy)))mediaConflicts.add(node.id);
      if((typeof ux!=='string'||!ux.trim())&&typeof uy==='string'&&uy.trim())a[j]=b[j];
     }
    }
    candidate=selected;
   }
  }
  if(candidate&&foundStory){
   const stories=candidate.unified_stories_with_notes,edges=stories.edges;
   const selected=startAtTarget?edges.slice(edges.findIndex(e=>e?.node?.id===storyId)):edges;
   const chosen=limit?selected.slice(0,limit):selected,items=[],missing=[];
   if(chosen.some(e=>mediaConflicts.has(e?.node?.id)))return {error:'conflicting story media'};
   chosen.forEach((e,i)=>{
    const attachments=e?.node?.attachments;
    if(!Array.isArray(attachments)||!attachments.length){missing.push(i+1);return}
    attachments.forEach((a,j)=>{
     const m=a?.media,kind=m?.__typename,media=url(m);
     if(typeof media!=='string'||!media){missing.push(i+1);return}
     items.push({story:i+1,part:j+1,kind,url:media});
    });
   });
   const hasNext=stories.page_info?.has_next_page,count=stories.count;
   const validCount=Number.isSafeInteger(count)&&count>=0;
   const complete=hasNext!==true&&(hasNext===false||validCount&&count===edges.length)&&(!validCount||count===edges.length);
   return {items,missing,more:(!limit||selected.length<limit)&&(!complete||conflict)};
  }
  return null;
 },10000,100);
}
