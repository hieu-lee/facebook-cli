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
 // ---- group join / leave: the header button cycles Join group -> Requested
 // (private, approval needed) or Joined; leaving goes through the Joined menu
 const G_JOIN=/^(Join group|Join|Tham gia nhóm|Rejoindre le groupe|Rejoindre)$/i;
 const G_JOINED=/^(Joined|Đã tham gia|Membre)$/i;
 const G_PENDING=/^(Requested|Pending|Cancel request|Đã yêu cầu|Demande envoyée|Annuler la demande)$/i;
 const G_LEAVE=/^(Leave group|Rời khỏi nhóm|Quitter le groupe)$/i;
 const groupButton=()=>{const m=main();if(!m)return null;const bs=[...m.querySelectorAll('[role=button]')].map(b=>({b,t:clean(b.innerText||'').split('\n')[0].trim()}));const j=bs.find(x=>G_JOINED.test(x.t));if(j)return j.b;const p=bs.find(x=>G_PENDING.test(x.t));if(p)return p.b;const a=bs.find(x=>G_JOIN.test(x.t));return a?a.b:null;};
 F.groupState=()=>{const b=groupButton();if(!b)return 'none';const t=clean(b.innerText||'').split('\n')[0].trim();if(G_JOINED.test(t))return 'joined';if(G_PENDING.test(t))return 'pending';if(G_JOIN.test(t))return 'can-join';return 'none';};
 F.groupJoin=async()=>{
  const st=F.groupState();if(st!=='can-join')return st;
  const b=groupButton();if(!b)return 'none';b.click();
  const out=await waitFor(()=>{
   const s=F.groupState();if(s==='joined')return 'joined';if(s==='pending')return 'pending';
   const d=dialogs().find(d=>d.querySelector('textarea,[role=textbox],input[type=text]'));
   if(d)return 'questions';
   return null;
  },10000,250);
  if(out==='questions'){
   // membership questions: report them and back out; answering is the user's
   // call. Prompts are labels, headings or plain spans — never button text,
   // and a wrapper that repeats a prompt verbatim is dropped.
   const d=dialogs().find(d=>d.querySelector('textarea,[role=textbox],input[type=text]'));
   let qs=[...d.querySelectorAll('label,[role=heading],span')].filter(e=>!e.closest('[role=button]')).map(e=>clean(e.innerText||'')).filter(t=>t&&t.length>3&&t.length<200);
   qs=[...new Set(qs)].filter(t=>!qs.some(o=>o!==t&&t.includes(o)));
   const cancel=[...d.querySelectorAll('[role=button]')].find(x=>/^(Cancel|Hủy|Annuler|Close|Đóng|Fermer)$/i.test(clean(x.innerText||'')));
   if(cancel)cancel.click();
   return 'questions:'+JSON.stringify(qs.slice(0,6));
  }
  return out||'unconfirmed';
 };
 F.groupLeave=async()=>{
  const st=F.groupState();if(st!=='joined')return st;
  const b=groupButton();if(!b)return 'none';b.click();
  const item=await waitFor(()=>[...document.querySelectorAll('[role=menuitem],[role=menu] [role=button]')].find(i=>G_LEAVE.test(clean(i.innerText||'').split('\n')[0].trim())),6000);
  if(!item)return 'no-leave-item';
  item.click();
  const confirm=await waitFor(()=>{for(const d of dialogs()){const c=[...d.querySelectorAll('[role=button]')].find(x=>G_LEAVE.test(clean(x.innerText||'').split('\n')[0].trim()));if(c)return c;}return null;},6000);
  if(!confirm)return 'no-confirm';
  confirm.click();
  const ok=await waitFor(()=>F.groupState()==='can-join'?'left':null,10000,250);
  return ok||'unconfirmed';
 };
 // answer a group's membership questions and submit: choice questions
 // (radio groups) take the answer whose text matches an option; the rest
 // are text fields filled in order. Nothing is invented — a missing answer
 // leaves its field empty and Facebook's own validation complains.
 F.groupApply=async(answers)=>{
  let st=F.groupState();
  if(st==='joined')return 'joined';if(st==='pending')return 'pending';
  if(st==='can-join'){const b=groupButton();if(!b)return 'none';b.click();}
  const dlg=()=>dialogs().find(x=>x.querySelector('textarea,[role=textbox],input[type=text]'));
  const d=await waitFor(dlg,10000);
  if(!d){
   const s=await waitFor(()=>{const x=F.groupState();return x==='joined'||x==='pending'?x:null;},4000,250);
   return s||'no-questions';
  }
  let ai=0;
  for(const g of [...d.querySelectorAll('[role=radiogroup]')].filter(e=>F.visible(e))){
   const want=(answers[ai++]||'').toLowerCase();if(!want)continue;
   const opt=[...g.querySelectorAll('[role=radio],[role=checkbox],label')].find(o=>clean(o.innerText||o.getAttribute('aria-label')||'').toLowerCase().includes(want));
   if(opt)opt.click();
  }
  for(const f of [...d.querySelectorAll('textarea,input[type=text],[role=textbox]')].filter(e=>F.visible(e))){
   const want=answers[ai++];if(want==null)break;
   if(f.tagName==='TEXTAREA'||f.tagName==='INPUT')setVal(f,want);
   else{f.focus();document.execCommand('selectAll',false,null);document.execCommand('insertText',false,want);}
  }
  const submit=[...d.querySelectorAll('[role=button]')].find(x=>/^(Submit|Submit answers|Send|Gửi|Envoyer|Soumettre)$/i.test(clean(x.innerText||'')));
  if(!submit)return 'no-submit';
  submit.click();
  const done=await waitFor(()=>{const s=F.groupState();if(s==='joined')return 'joined';if(s==='pending')return 'pending';if(!dlg())return 'submitted';return null;},10000,250);
  return done||'unconfirmed';
 };
 // ---- marketplace listing message: the listing's Message button opens a
 // chat popover; the text is typed by the caller, Enter sends it
 F.listingMessageOpen=async()=>{
  const btn=await waitFor(()=>[...document.querySelectorAll('[role=main] [role=button]')].find(b=>/^Message/i.test(clean(b.innerText||b.getAttribute('aria-label')||''))),12000);
  if(!btn)return 'no message button on this listing';
  btn.click();
  const box=await waitFor(()=>{for(const d of dialogs()){const tb=d.querySelector('[role=textbox][contenteditable=true]');if(tb)return tb;}return null;},10000);
  if(!box)return 'message composer did not open';
  box.focus();
  return true;
 };
 F.listingMessageSent=text=>{
  const want=clean(text).toLowerCase();
  return [...document.querySelectorAll('[role=dialog] [role=log] *,[role=dialog] [role=article]')].some(e=>clean(e.innerText||'').toLowerCase()===want);
 };
 // ---- marketplace listing form (/marketplace/create/item): labelled text
 // fields, Condition and Category pickers, one file input for photos/video
 const setVal=(el,v)=>{const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(proto,'value').set;set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
 const sellField=lab=>[...document.querySelectorAll('input,textarea')].find(e=>new RegExp('^'+lab+'$','i').test(e.getAttribute('aria-label')||'')||new RegExp('^'+lab,'i').test(e.getAttribute('placeholder')||''));
 F.sellSet=(field,value)=>{const el=sellField(field);if(!el)return 'no '+field+' field';setVal(el,value);return true;};
 const SELL_COND={new:/^(New|Mới|Neuf)$/i,'like-new':/^(Used\s*[-–]\s*like new|Đã qua sử dụng\s*[-–]\s*như mới|Occasion\s*[-–]\s*comme neuf)$/i,good:/^(Used\s*[-–]\s*good|Đã qua sử dụng\s*[-–]\s*tốt|Occasion\s*[-–]\s*bon état)$/i,fair:/^(Used\s*[-–]\s*fair|Đã qua sử dụng\s*[-–]\s*khá|Occasion\s*[-–]\s*état correct)$/i};
 F.sellPick=async(kind,name)=>{
  const btn=[...document.querySelectorAll('[role=button]')].find(b=>new RegExp('^'+kind,'i').test(b.getAttribute('aria-label')||clean(b.innerText||'')));
  if(!btn)return 'no '+kind+' picker';
  btn.click();
  const opts=()=>[...document.querySelectorAll('[role=option],[role=listbox] [role=button],[role=menuitem]')];
  let list=await waitFor(()=>opts().length?opts():null,6000);
  if(!list)return kind+' options never opened';
  if(kind==='category'){
   const search=document.querySelector('input[type=search],[role=listbox] input,[role=dialog] input');
   if(search&&name){setVal(search,name);await sleep(700);list=opts();}
   const want=name.toLowerCase();
   const hit=list.find(o=>clean(o.innerText||'').toLowerCase()===want)||list.find(o=>clean(o.innerText||'').toLowerCase().includes(want));
   if(!hit)return 'category not found; options: '+list.map(o=>clean(o.innerText||'')).filter(Boolean).slice(0,12).join(' | ');
   hit.click();await sleep(300);return true;
  }
  const re=SELL_COND[name];if(!re)return 'bad condition '+name;
  const hit=list.find(o=>re.test(clean(o.innerText||'')));
  if(!hit)return 'condition not found; options: '+list.map(o=>clean(o.innerText||'')).filter(Boolean).slice(0,8).join(' | ');
  hit.click();await sleep(300);return true;
 };
 // the bytes arrive beforehand as base64 chunks (upBegin/upChunk in msg.js), like the composer
 F.sellAttach=async(name,mime)=>{
  const parts=window.__fbUp;window.__fbUp=null;
  const inp=document.querySelector('[role=main] input[type=file],input[type=file]');
  if(!inp)return 'no file input';
  if(!parts)return 'no data';
  const bytes=parts.map(p=>{const bin=atob(p);const u8=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);return u8;});
  const dt=new DataTransfer();dt.items.add(new File(bytes,name,{type:mime}));
  const before=document.querySelectorAll('img[src^="blob:"]').length;
  inp.files=dt.files;inp.dispatchEvent(new Event('change',{bubbles:true}));
  const ok=await waitFor(()=>document.querySelectorAll('img[src^="blob:"]').length>before,20000,200);
  return ok?true:'no preview after attach';
 };
 const sellBtn=re=>[...document.querySelectorAll('[role=button]')].find(b=>re.test(clean(b.innerText||b.getAttribute('aria-label')||''))&&F.enabled(b));
 F.sellNext=async()=>{
  const nx=sellBtn(/^(Next|Tiếp|Suivant)$/i);if(!nx)return 'no Next button (a required field is missing?)';
  nx.click();
  const pub=await waitFor(()=>sellBtn(/^(Publish|Đăng|Publier)$/i),10000,200);
  return pub?true:'Publish step never appeared';
 };
 F.sellPublish=async()=>{
  const pub=sellBtn(/^(Publish|Đăng|Publier)$/i);if(!pub)return 'no Publish button';
  pub.click();
  const done=await waitFor(()=>{
   if(/\/marketplace\/item\//.test(location.pathname))return location.pathname;
   const t=clean(document.body.innerText||'');
   if(/listing is (now )?live|your listing has been published|đã đăng tin/i.test(t))return 'live';
   return null;
  },30000,300);
  return done||'publish not confirmed';
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
