async (profile,limit,all=false) => {
 let state=window.__fbPhotoScan;
 if(!state){
  const identity=await profile();if(identity?.error)return identity;if(!identity||identity.owner?.length>32||!/^\d+$/.test(identity.owner||''))return {error:'profile metadata unavailable'};
  const seenScripts=new WeakMap(),collections=new Map();let conflicting=false;
  const collection=await window.__fb.waitFor(()=>{
   for(const script of document.querySelectorAll('script[type="application/json"]')){
    const text=script.textContent;if(!text.includes('all_collections'))continue;if(text.length>8*1024*1024)return {error:'photo metadata incomplete'};if(seenScripts.get(script)===text)continue;
    let root;try{root=JSON.parse(text)}catch{return null}seenScripts.set(script,text);
    const stack=[root];let visited=0;
    while(stack.length&&visited++<100000){
     const o=stack.pop();if(!o||typeof o!=='object')continue;
     if(o.__typename==='TimelineAppSection'&&typeof o.id==='string'){
      let section='';try{section=atob(o.id.replace(/-/g,'+').replace(/_/g,'/'))}catch{}
      const nodes=o.all_collections?.nodes;
      if(section.startsWith('app_section:'+identity.owner+':')&&Array.isArray(nodes))for(const entry of nodes){
       const renderer=entry?.style_renderer,c=renderer?.collection;
       if(renderer?.__typename==='TimelineAppCollectionPhotosRenderer'&&typeof c?.id==='string'&&c.id.length<=4096&&Array.isArray(c.pageItems?.edges)){
        const page=c.pageItems,prior=collections.get(c.id);
        if(!prior)collections.set(c.id,{page,conflict:false});else{
         const old=prior.page.edges,edges=page.edges;
         for(let i=0;i<Math.min(old.length,edges.length,1001);i++){const x=old[i]?.node?.node?.id,y=edges[i]?.node?.node?.id;if(x!=null&&y!=null&&x!==y)conflicting=true}
         const a=prior.page.page_info,b=page.page_info;
         if(old.length!==edges.length||typeof a?.has_next_page==='boolean'&&typeof b?.has_next_page==='boolean'&&a.has_next_page!==b.has_next_page||typeof a?.end_cursor==='string'&&typeof b?.end_cursor==='string'&&a.end_cursor!==b.end_cursor)prior.conflict=true;
         const selected=edges.length>old.length||edges.length===old.length&&typeof a?.has_next_page!=='boolean'&&typeof b?.has_next_page==='boolean'?page:prior.page;
         const other=selected===page?prior.page:page;
         const valid=e=>e?.node?.__typename==='TimelineAppCollectionItem'&&e.node.node?.__typename==='Photo'&&typeof e.node.node.id==='string';
         for(let i=0;i<Math.min(selected.edges.length,other.edges.length,1001);i++){
          if(!valid(selected.edges[i])&&valid(other.edges[i])){selected.edges[i]=other.edges[i];continue}
          const photo=selected.edges[i]?.node?.node,alt=other.edges[i]?.node?.node,from=alt?.viewer_image?.uri,current=photo?.viewer_image?.uri;
          if(photo&&typeof photo==='object'&&(typeof current!=='string'||!current.trim())&&typeof from==='string'&&from.trim()&&from.length<=8192){if(!photo.viewer_image||typeof photo.viewer_image!=='object')photo.viewer_image={};photo.viewer_image.uri=from}
         }
         prior.page=selected;
        }
       }
      }
     }
     for(const v of Object.values(o))if(v&&typeof v==='object')stack.push(v);
    }
    if(stack.length)return {error:'photo metadata incomplete'};
   }
   if(collections.size>1||conflicting)return {error:'ambiguous photo collection'};
   if(collections.size===1){const [id,entry]=collections.entries().next().value;return {id,...entry}}
   return null;
  },10000,100);
  if(!collection)return {error:'photo collection unavailable'};
  if(collection.error)return collection;
  const cursor=collection.page.page_info?.end_cursor;
  if(cursor!=null&&(typeof cursor!=='string'||cursor.length>4096))return {error:'invalid photo cursor'};
  const maxEntries=Math.min(limit+1,1001),records=[],initialIds=new Map(),unready=new Set();let initialMissing=false,truncated=false,readyCount=0,prefixReady=0;
  const edges=collection.page.edges;
  for(let position=0;position<edges.length;position++){
   const edge=edges[position];
   const photo=edge?.node?.node,id=photo?.id,ready=edge?.node?.__typename==='TimelineAppCollectionItem'&&photo?.__typename==='Photo';
   if(typeof id!=='string'||id.length>32||!/^\d+$/.test(id)){if(all||readyCount<limit)initialMissing=true;continue}
   let item=initialIds.get(id);
   if(!item){
    let index=records.length;
    if(index>=maxEntries){truncated=true;if(!ready||!unready.size)continue;index=-1;for(const slot of unready)if(slot>=limit){index=slot;break}if(index<0)continue;unready.delete(index);const removed=records[index];initialIds.delete(removed.id);if(all)initialMissing=true}
    item={id,url:null,ready:false,index};initialIds.set(id,item);records[index]=item;unready.add(index);
   }
   if(ready){if(!item.ready){item.ready=true;readyCount++;unready.delete(item.index)}const uri=photo.viewer_image?.uri;if(typeof uri==='string'&&uri.trim()&&uri.length<=8192)item.url=uri}
   while(prefixReady<limit&&records[prefixReady]?.ready&&records[prefixReady].url)prefixReady++;
   if(!all&&!initialMissing&&prefixReady>=limit){if(position+1<edges.length)truncated=true;break}
  }
  const items=records.map(item=>({id:item.id,url:item.url,...(item.ready?{}:{ready:false})}));
  state={id:collection.id,pending:items,offset:0,seen:new Map(),order:[],head:0,needUrls:new Set(),cursors:new Set(),usedPage:false,lastCursor:null,emitted:0,missing:initialMissing,uncertain:collection.conflict,truncated,more:collection.page.page_info?.has_next_page,cursor:collection.page.page_info?.end_cursor??null};
  Object.defineProperty(window,'__fbPhotoScan',{value:state,configurable:false});
 }
 const items=[],updates=[],deadline=Date.now()+10000,maxEntries=Math.min(limit+1,1001);
 const emit=()=>{
  while(state.head<state.order.length&&state.emitted<limit&&items.length+updates.length<8){
   const item=state.order[state.head];if(!item.ready)break;state.head++;item.index=++state.emitted;
   if(!item.url)state.needUrls.add(item.id);items.push({id:item.id,url:item.url,index:item.index});
  }
 };
 for(;;){
  if(state.usedPage){
   const status=window.__fbPhotoPage(state.id,state.lastCursor);if(status.blocked)return {error:'photo pagination blocked'};
   if(status.pending){if(Date.now()>=deadline)return {error:'photo pagination incomplete'};await window.__fb.sleep(100);continue}
  }
  emit();if(items.length)return {items,done:false,complete:false,missing:state.missing};
  while(state.offset<state.pending.length&&(state.emitted<limit||state.needUrls.size)){
   const item=state.pending[state.offset++];
   if(!item){if(all||state.emitted<limit)state.missing=true;continue}
   let entry=state.seen.get(item.id);
   if(!entry){
    if(state.emitted>=limit){state.truncated=true;continue}
    let slot=state.order.length;
    if(state.seen.size>=maxEntries){
     state.truncated=true;slot=-1;
     if(item.ready!==false)for(let i=state.order.length-1;i>=state.head;i--)if(!state.order[i].ready&&state.emitted+i-state.head>=limit){slot=i;break}
     if(slot<0)continue;state.seen.delete(state.order[slot].id);if(all)state.missing=true;
    }
    entry={id:item.id,url:null,ready:false,index:0};state.seen.set(item.id,entry);state.order[slot]=entry;
   }
   if(item.ready!==false){
    entry.ready=true;
    if(item.url&&entry.url!==item.url){entry.url=item.url;if(entry.index){state.needUrls.delete(item.id);const local=items.find(x=>x.id===item.id);if(local)local.url=item.url;else updates.push({id:item.id,index:entry.index,url:item.url})}}
   }
   emit();
   if(items.length+updates.length>=8)break;
  }
  if(items.length||updates.length)return {items,...(updates.length?{updates}:{}),done:false,complete:false,missing:state.missing};
  if(state.emitted>=limit){
   if(state.usedPage||all){const status=window.__fbPhotoSeal(state.id,state.cursors);if(status.blocked)return {error:'photo pagination blocked'};if(status.pending){if(Date.now()>=deadline)return {error:'photo pagination incomplete'};await window.__fb.sleep(100);continue}if(status.incomplete)state.uncertain=true}
   const extra=state.truncated||state.head<state.order.length||state.pending.slice(state.offset).some(x=>!x||!state.seen.has(x.id));
   return {items:[],done:true,complete:!state.missing&&!state.uncertain&&!extra&&state.more===false,missing:state.missing};
  }
  if(state.offset<state.pending.length)continue;
  if(state.more!==true||typeof state.cursor!=='string'){
   while(state.head<state.order.length&&state.emitted<limit&&items.length+updates.length<8){if(!state.order[state.head].ready){state.missing=true;state.head++}else emit()}
   if(items.length||updates.length)return {items,...(updates.length?{updates}:{}),done:false,complete:false,missing:state.missing};
   if(state.more===false){const status=window.__fbPhotoSeal(state.id,state.cursors);if(status.blocked)return {error:'photo pagination blocked'};if(status.pending){if(Date.now()>=deadline)return {error:'photo pagination incomplete'};await window.__fb.sleep(100);continue}if(status.incomplete)state.uncertain=true;return {items:[],done:true,complete:!state.missing&&!state.uncertain&&!state.truncated,missing:state.missing};}
   return {items:[],done:true,complete:false,missing:state.missing};
  }
  const status=window.__fbPhotoPage(state.id,state.cursor);
  if(status.blocked)return {error:'photo pagination blocked'};
  if(status.pending){if(Date.now()>=deadline)return {error:'photo pagination incomplete'};await window.__fb.sleep(100);continue}
  if(status.page){
   const page=status.page;if(state.cursors.has(state.cursor)||!Array.isArray(page.items)||typeof page.more!=='boolean'||(page.more&&(!page.cursor||page.cursor===state.cursor)))return {error:'invalid photo cursor'};
   state.cursors.add(state.cursor);state.usedPage=true;state.lastCursor=state.cursor;
   state.pending=page.items;state.offset=0;state.more=page.more;state.cursor=page.cursor;continue;
  }
  if(Date.now()>=deadline)return {error:'photo pagination incomplete'};
  window.scrollBy(0,innerHeight*.8);await window.__fb.sleep(220);
 }
}
