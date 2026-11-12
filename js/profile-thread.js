async owner => {
 const F=window.__fb,{clean,waitFor}=F;
 const urlOf=a=>{try{const u=new URL(a.getAttribute('href'),location.href);return u.protocol==='https:'&&(u.hostname==='facebook.com'||u.hostname.endsWith('.facebook.com'))?u:null}catch{return null}};
 const person=a=>{const u=urlOf(a);return u&&(u.pathname.replace(/\/$/,'')==='/'+owner||(u.pathname==='/profile.php'&&u.searchParams.get('id')===owner))};
 const shown=e=>e.getClientRects().length&&getComputedStyle(e).visibility==='visible';
 const settings=e=>e.matches('[role=button],button')&&/^(Chat settings|Cài đặt đoạn chat|Paramètres (?:de la discussion|du chat))$/i.test(clean(e.getAttribute('aria-label')||''));
 const findTrigger=()=>[...document.querySelectorAll('[role=main] [role=button],[role=main] button')].find(e=>shown(e)&&/^(Message|Send message|Nhắn tin|Envoyer un message)$/i.test(clean(e.getAttribute('aria-label')||e.innerText)));
 const at=location.href;
 const findControl=()=>{
  if(location.href!==at)return null;
  const matches=[];
  for(const b of [...document.querySelectorAll('[role=button][aria-label],button[aria-label]')].filter(e=>shown(e)&&settings(e))){
   for(let p=b.parentElement;p&&p!==document.body&&p.getAttribute('role')!=='main';p=p.parentElement){
    if(p.querySelectorAll('[role=textbox][contenteditable=true]').length!==1)continue;
    if([...p.querySelectorAll('a[href]')].some(person)){matches.push(b);break}
   }
  }
  return matches.length===1?matches[0]:null;
 };
 // A press made before the profile hydrates is silently ignored, and a re-render can replace the button
 // mid-press. Opening the chat is idempotent, so press a freshly found button again until the chat opens.
 let control=null;
 for(let i=0;i<4&&!control;i++){
  const trigger=await waitFor(findTrigger,i?3000:8000);
  if(!trigger)break;
  try{F.press(trigger)}catch(e){if(!/action target changed/.test(String(e&&e.message)))throw e}
  control=await waitFor(findControl,5000);
 }
 if(!control)return null;
 const personMenus=()=>[...document.querySelectorAll('[role=menu]')].filter(m=>shown(m)&&[...m.querySelectorAll('a[href]')].some(person));
 // Openness is judged without the recipient check: a menu whose links are still loading is open, and a
 // second press would close it. The person link is still required before a thread path is accepted.
 const menuOpen=()=>control.getAttribute('aria-expanded')==='true'||[...document.querySelectorAll('[role=menu]')].some(shown);
 const findPath=()=>{
  if(location.href!==at)return null;
  const paths=new Set();
  for(const menu of personMenus()){
   for(const a of menu.querySelectorAll('a[href]')){
    const u=urlOf(a);if(u&&/^\/messages\/(?:e2ee\/)?t\/\d+\/?$/.test(u.pathname))paths.add(u.pathname);
   }
  }
  return paths.size===1?[...paths][0]:null;
 };
 // Same idempotence rule for the settings menu: a press that was ignored is repeated, but never while the
 // menu is already open (a second press would close it).
 for(let i=0;i<3;i++){
  if(!menuOpen()){
   try{F.press(control)}catch(e){if(!/action target changed/.test(String(e&&e.message)))throw e;control=findControl()||control;continue}
  }
  const path=await waitFor(findPath,4000);
  if(path)return path;
 }
 return null;
}
