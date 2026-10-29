async (requireBuckets=false) => {
 const seen=new WeakMap(),profiles=new Map();
 return await window.__fb.waitFor(()=>{
  for(const script of document.querySelectorAll('script[type="application/json"]')){
   const text=script.textContent;if(!text.includes('profile_header_renderer'))continue;if(text.length>8*1024*1024)return {error:'profile metadata incomplete'};if(seen.get(script)===text)continue;
   let root;try{root=JSON.parse(text)}catch{return null}seen.set(script,text);
   const stack=[root];let visited=0;
   while(stack.length&&visited++<100000){
    const o=stack.pop();if(!o||typeof o!=='object')continue;
    const header=o.profile_header_renderer?.user,user=header?.header_top_row?.profile_user;
    if(user&&typeof user.id==='string'&&o.id===user.id&&header.id===user.id){
     let url;try{url=new URL(header.url,location.href)}catch{continue}
     const buckets=Array.isArray(user.story_bucket?.nodes)?user.story_bucket.nodes:null,previous=profiles.get(user.id);
     if(url.protocol==='https:'&&(url.hostname==='facebook.com'||url.hostname.endsWith('.facebook.com'))&&(!previous||(!previous.buckets&&buckets)||(buckets?.length&&!previous.buckets?.length)))profiles.set(user.id,{owner:user.id,buckets,url});
    }
    for(const v of Object.values(o))if(v&&typeof v==='object')stack.push(v);
   }
   if(stack.length)return {error:'profile metadata incomplete'};
  }
  const loc=new URL(location.href),path=loc.pathname.replace(/\/photos\/?$/,'').replace(/\/$/,''),matches=[];
  for(const info of profiles.values()){
   const canonical=info.url.pathname.replace(/\/$/,'');
   const match=path==='/profile.php'?loc.searchParams.get('id')===info.owner:(path===canonical||(/^\/people\/[^/]+\/\d+$/.test(path)&&path.split('/').at(-1)===info.owner));
   if(match&&(!requireBuckets||info.buckets))matches.push({owner:info.owner,buckets:info.buckets||[]});
  }
  return matches.length===1?matches[0]:null;
 },10000,100);
}
