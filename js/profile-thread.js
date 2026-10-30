async owner => {
 const F=window.__fb,{clean,waitFor}=F;
 const urlOf=a=>{try{const u=new URL(a.getAttribute('href'),location.href);return u.protocol==='https:'&&(u.hostname==='facebook.com'||u.hostname.endsWith('.facebook.com'))?u:null}catch{return null}};
 const person=a=>{const u=urlOf(a);return u&&(u.pathname.replace(/\/$/,'')==='/'+owner||(u.pathname==='/profile.php'&&u.searchParams.get('id')===owner))};
 const shown=e=>e.getClientRects().length&&getComputedStyle(e).visibility==='visible';
 const settings=e=>e.matches('[role=button],button')&&/^(Chat settings|Cài đặt đoạn chat|Paramètres (?:de la discussion|du chat))$/i.test(clean(e.getAttribute('aria-label')||''));
 const trigger=await waitFor(()=>[...document.querySelectorAll('[role=main] [role=button],[role=main] button')].find(e=>shown(e)&&/^(Message|Send message|Nhắn tin|Envoyer un message)$/i.test(clean(e.getAttribute('aria-label')||e.innerText))),8000);
 if(!trigger)return null;
 const at=location.href;F.press(trigger);
 const control=await waitFor(()=>{
  if(location.href!==at)return null;
  const matches=[];
  for(const b of [...document.querySelectorAll('[role=button][aria-label],button[aria-label]')].filter(e=>shown(e)&&settings(e))){
   for(let p=b.parentElement;p&&p!==document.body&&p.getAttribute('role')!=='main';p=p.parentElement){
    if(p.querySelectorAll('[role=textbox][contenteditable=true]').length!==1)continue;
    if([...p.querySelectorAll('a[href]')].some(person)){matches.push(b);break}
   }
  }
  return matches.length===1?matches[0]:null;
 },10000);
 if(!control)return null;
 F.press(control);
 return await waitFor(()=>{
  if(location.href!==at)return null;
  const paths=new Set();
  for(const menu of document.querySelectorAll('[role=menu]')){
   if(!shown(menu)||![...menu.querySelectorAll('a[href]')].some(person))continue;
   for(const a of menu.querySelectorAll('a[href]')){
    const u=urlOf(a);if(u&&/^\/messages\/(?:e2ee\/)?t\/\d+\/?$/.test(u.pathname))paths.add(u.pathname);
   }
  }
  return paths.size===1?[...paths][0]:null;
 },5000);
}
