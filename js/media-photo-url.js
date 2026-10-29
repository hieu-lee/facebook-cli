async id => {
 const seen=new WeakMap();
 return await window.__fb.waitFor(()=>{
  if(!['/photo.php','/photo/'].includes(location.pathname)||new URL(location.href).searchParams.get('fbid')!==id)return null;
  for(const script of document.querySelectorAll('script[type="application/json"]')){
   const text=script.textContent;if(!text.includes('currMedia')||!text.includes(id)||text.length>8*1024*1024||seen.get(script)===text)continue;
   let root;try{root=JSON.parse(text)}catch{continue}seen.set(script,text);
   const stack=[root];let visited=0;
   while(stack.length&&visited++<100000){
    const o=stack.pop();if(!o||typeof o!=='object')continue;
    const media=o.currMedia;
    if(media?.__typename==='Photo'&&media.id===id&&typeof media.image?.uri==='string')return media.image.uri;
    for(const v of Object.values(o))if(v&&typeof v==='object')stack.push(v);
   }
  }
  return null;
 },10000,100);
}
