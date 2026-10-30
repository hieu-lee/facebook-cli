(()=>{
 const F=window.__fb;
 const {sleep,clean,vtext,waitFor}=F;
 const main=()=>document.querySelector('[role=main]');
 const dialogs=()=>[...document.querySelectorAll('[role=dialog]')];
 const btnText=b=>clean(b.innerText||'');
 // ---- post composer
 F.composeOpen=async()=>{
  const m=await waitFor(()=>main(),15000);
  if(!m)return 'no main';
  const trigger=await waitFor(()=>{
   const regs=[...m.querySelectorAll('[role=region]')];
   for(const r of regs){const h=r.querySelector('h1,h2,h3,h4');if(!h)continue;const b=[...r.querySelectorAll('[role=button]')].find(b=>btnText(b).length>6);if(b)return b;}
   return [...m.querySelectorAll('[role=button]')].find(b=>/^(What.s on your mind|Bạn đang nghĩ gì|Exprimez-vous|Que voulez-vous dire)/i.test(btnText(b)))||null;
  },15000);
  if(!trigger)return 'no composer button';
  trigger.click();
  const d=await waitFor(()=>dialogs().find(d=>d.querySelector('[role=textbox]')),10000);
  if(!d)return 'composer did not open';
  const tb=d.querySelector('[role=textbox]');tb.focus();
  return true;
 };
 F.composeDialog=()=>dialogs().find(d=>d.querySelector('[role=textbox]'));
 F.composeFocus=()=>{const d=F.composeDialog();const tb=d&&d.querySelector('[role=textbox]');if(!tb)return false;tb.focus();return true;};
 // the bytes arrive beforehand as base64 chunks (upBegin/upChunk in msg.js), one CDP call each
 F.composeAttach=async(name,mime)=>{
  const parts=window.__fbUp;window.__fbUp=null;
  const d=F.composeDialog();const inp=d&&d.querySelector('input[type=file]');
  if(!inp)return 'no file input';
  if(!parts)return 'no data';
  const bytes=parts.map(p=>{const bin=atob(p);const u8=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);return u8;});
  const dt=new DataTransfer();dt.items.add(new File(bytes,name,{type:mime}));
  const before=d.querySelectorAll('img[src^="blob:"],video').length;
  inp.files=dt.files;inp.dispatchEvent(new Event('change',{bubbles:true}));
  const ok=await waitFor(()=>d.querySelectorAll('img[src^="blob:"],video').length>before||d.querySelectorAll('img[src^="data:"]').length>0,15000,150);
  return ok?true:'no preview';
 };
 // matched against the first line only: "Friends except..." is a different audience from "Friends"
 const AUD={public:/^(Công khai|Public|Publique)$/i,friends:/^(Bạn bè|Friends|Amis)$/i,me:/^(Chỉ mình tôi|Only me|Moi uniquement)$/i};
 const first=t=>clean(t).split('\n')[0].trim();
 F.composeAudience=async(kind)=>{
  const d=F.composeDialog();if(!d)return 'no composer';
  const audienceButton=()=>{const dialog=F.composeDialog();return dialog&&[...dialog.querySelectorAll('[role=button]')].find(e=>/\./.test(e.getAttribute('aria-label')||'')&&btnText(e).length>0&&btnText(e).length<30);};
  const ab=audienceButton();
  if(!ab)return 'no audience button';
  if(AUD[kind].test(first(ab.innerText)))return true;
  ab.click();
  const lab=await waitFor(()=>[...d.querySelectorAll('label')].find(l=>AUD[kind].test(first(l.innerText))),6000);
  if(!lab)return 'audience option not found';
  lab.click();
  await sleep(300);
  const done=[...d.querySelectorAll('[role=button]')].filter(b=>btnText(b)).pop();
  if(done)done.click();
  await sleep(200);
  const current=await waitFor(()=>{const b=audienceButton();return b&&AUD[kind].test(first(b.innerText))},3000);
  return current?true:'audience change not confirmed; nothing was posted';
 };
 const postButton=()=>{const d=F.composeDialog();const bs=d?[...d.querySelectorAll('[role=button]')].filter(b=>F.visible(b)&&/^(Post|Đăng|Publier)$/i.test(clean(b.getAttribute('aria-label')||btnText(b)))):[];return bs.length===1?bs[0]:null;};
 // Retained audience panes can put Done after Post; order is not action identity.
 F.composePrepare=async()=>{
  if(!F.composeDialog())return 'no composer';
  const post=await waitFor(()=>{const b=postButton();return b&&F.enabled(b)?b:null},60000,150);
  if(!post)return 'Post button never became enabled (upload still running?)';
  F.press(post,{events:['pointerover','mouseover'],valid:()=>post===postButton()&&F.enabled(post)});
  await sleep(0);
  if(post!==postButton()||!F.enabled(post))return 'post button changed; nothing was posted';
  window.__fbPostBtn=post;
  return true;
 };
 F.composePress=async()=>{
  const post=window.__fbPostBtn;if(!post||post!==postButton()||!F.enabled(post))return 'post button changed; nothing was posted';
  F.press(post,{events:['pointerdown','mousedown','pointerup','mouseup','click'],valid:()=>post===postButton()&&F.enabled(post)});
  const closed=await waitFor(()=>!F.composeDialog(),90000,200);
  return closed?true:'post dialog still open (upload slow?)';
 };
 // ---- post-level actions (root = dialog showing the post, or main)
 const postRoot=()=>{for(const d of dialogs())if(d.querySelector('[data-ad-rendering-role=profile_name]'))return d;const m=main();return m&&m.querySelector('[data-ad-rendering-role=profile_name]')&&m;};
 F.postRoot=postRoot;
 F.postReady=async()=>{const r=await waitFor(postRoot,15000);if(r)await sleep(600);return !!r;};
 const MENU_RE={del:/Chuyển vào thùng rác|Move to trash|Move to Recycle|Xóa bài viết|Delete post|Supprimer|Déplacer vers la corbeille|Xóa/i};
 // two steps so the caller can still abort before the irreversible click
 F.postDeleteOpen=async()=>{
  const r=postRoot();if(!r)return 'no post';
  const cards=F.postCards();const card=cards.find(c=>r.contains(c))||r;
  const act=[...card.querySelectorAll('[role=button][aria-haspopup]')].find(b=>b.getAttribute('aria-label'));
  if(!act)return 'no actions menu (not your post?)';
  act.click();
  const item=await waitFor(()=>[...document.querySelectorAll('[role=menuitem]')].find(i=>MENU_RE.del.test(clean(i.innerText))),5000);
  if(!item)return 'delete not available (not your post?)';
  window.__fbDeleteAct=act;
  item.click();
  const confirm=await waitFor(()=>{for(const d of dialogs()){const b=[...d.querySelectorAll('[role=button]')].find(b=>/^(Di chuyển|Move|Xóa|Delete|Supprimer|Déplacer|Remove)/i.test(clean(b.innerText)||b.getAttribute('aria-label')||''));if(b)return b;}return null;},6000);
  if(!confirm)return 'delete confirmation dialog not found';
  window.__fbDeleteConfirm=confirm;
  return true;
 };
 F.postDeleteConfirm=async()=>{
  const act=window.__fbDeleteAct,confirm=window.__fbDeleteConfirm;
  if(!act||!confirm)return 'nothing to confirm';
  F.press(confirm);
  // success = the post view that held the actions button is gone (dialog closed or page re-rendered)
  const gone=await waitFor(()=>!act.isConnected,10000,200);
  return gone?true:'delete not confirmed by facebook';
 };
 F.commentFocus=()=>{
  const r=postRoot();if(!r)return 'no post';
  const tbs=[...r.querySelectorAll('[role=textbox][contenteditable=true]')];
  const tb=tbs[tbs.length-1];
  if(!tb)return 'no comment box';
  tb.scrollIntoView({block:'center'});tb.focus();return true;
 };
 // remember the comments already there; `commentSent` is true once a NEW one carries our text
 F.commentMark=()=>{const r=postRoot();window.__fbCmtBefore=new WeakSet(r?r.querySelectorAll('[role=article][aria-label]'):[]);return true;};
 F.commentSent=text=>{
  const r=postRoot();if(!r||!window.__fbCmtBefore)return false;
  const want=clean(text).toLowerCase();
  // our submit empties the comment box; a box still holding text means ours is pending or failed, so a
  // matching comment that appeared is somebody else's
  const tbs=[...r.querySelectorAll('[role=textbox][contenteditable=true]')];
  const box=tbs[tbs.length-1];
  if(box&&clean(box.innerText||''))return false;
  // a chunk that IS our text ("ok" must not match someone else's "this looks okay"); multi-line text falls back to containment
  const multi=want.includes('\n');
  return [...r.querySelectorAll('[role=article][aria-label]')].some(a=>{
   if(window.__fbCmtBefore.has(a))return false;
   if(multi)return clean(a.innerText||'').toLowerCase().includes(want);
   return vtext(a).some(c=>clean(c).toLowerCase()===want);
  });
 };
 F.likeInfo=async()=>{
  const m=await waitFor(()=>{const r=postRoot();return r&&r.querySelector('[data-ad-rendering-role=like_button]')},8000,100);
  if(!m)return null;
  const l=m.closest('[role=button]')||m;
  l.scrollIntoView({block:'center'});
  const rc=l.getBoundingClientRect();
  const label=l.getAttribute('aria-label')||'';
  return {x:rc.x+rc.width/2,y:rc.y+rc.height/2,label};
 };
 F.likePress=()=>{const r=postRoot();const m=r&&r.querySelector('[data-ad-rendering-role=like_button]');const l=m&&(m.closest('[role=button]')||m);if(!l)return false;F.press(l);return true;};
})();
(()=>{
 const F=window.__fb;
 F.reactionPick=idx=>{
  const r=F.postRoot();if(!r)return null;
  const cands=[...document.querySelectorAll('[role=dialog] [role=toolbar],[role=toolbar]')].filter(t=>t.querySelectorAll('[role=button],[aria-label]').length>=6);
  const tb=cands[cands.length-1];
  if(!tb)return null;
  const items=[...tb.querySelectorAll('[role=button]')].filter(b=>b.getBoundingClientRect().width>10);
  const it=items[idx];if(!it)return null;
  const rc=it.getBoundingClientRect();
  return {x:rc.x+rc.width/2,y:rc.y+rc.height/2,labels:items.map(b=>b.getAttribute('aria-label')||'')};
 };
})();
