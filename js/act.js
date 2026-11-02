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
 const setVal=(el,v)=>{const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(proto,'value').set;set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
 // ---- group join / leave: the header button cycles Join group -> Requested
 // (private, approval needed) or Joined; leaving goes through the Joined menu
 const G_JOIN=/^(Join group|Join|Tham gia nhóm|Rejoindre le groupe|Rejoindre)$/i;
 const G_JOINED=/^(Joined|Đã tham gia|Membre)$/i;
 const G_PENDING=/^(Requested|Pending|Cancel request|Đã yêu cầu|Demande envoyée|Annuler la demande)$/i;
 const G_LEAVE=/^(Leave group|Rời khỏi nhóm|Quitter le groupe)$/i;
 // a membership question is a text field or a radio group; one answer per question, in displayed order
 const Q_SEL='textarea,[role=textbox],input[type=text],[role=radiogroup]';
 const qDialog=()=>dialogs().find(d=>d.querySelector(Q_SEL));
 const questionControls=d=>[...d.querySelectorAll(Q_SEL)].filter(e=>F.visible(e)&&!e.parentElement?.closest('[role=radiogroup]'));
 // a prompt is the nearest text block before the control that holds no control itself
 const promptOf=(c,d)=>{for(let n=c;n&&n!==d;n=n.parentElement)for(let s=n.previousElementSibling;s;s=s.previousElementSibling){if(s.matches(Q_SEL)||s.querySelector(Q_SEL))return '';const t=clean(s.innerText||'');if(t)return t.split('\n')[0].slice(0,200)}return ''};
 const groupButton=()=>{const m=main();if(!m)return null;const bs=[...m.querySelectorAll('[role=button]')].filter(b=>!b.closest('[role=feed],[role=article],[role=list],[role=dialog]')).map(b=>({b,t:clean(b.innerText||'').split('\n')[0].trim()}));const j=bs.find(x=>G_JOINED.test(x.t));if(j)return j.b;const p=bs.find(x=>G_PENDING.test(x.t));if(p)return p.b;const a=bs.find(x=>G_JOIN.test(x.t));return a?a.b:null;};
 F.groupState=()=>{const b=groupButton();if(!b)return 'none';const t=clean(b.innerText||'').split('\n')[0].trim();if(G_JOINED.test(t))return 'joined';if(G_PENDING.test(t))return 'pending';if(G_JOIN.test(t))return 'can-join';return 'none';};
 // the header mounts after DOMContentLoaded: wait for a membership control before concluding there is none
 F.groupWait=async()=>(await waitFor(()=>{const s=F.groupState();return s!=='none'?s:null},15000,200))||'none';
 F.groupJoin=async()=>{
  const st=F.groupState();if(st!=='can-join')return st;
  const b=groupButton();if(!b)return 'none';b.click();
  const out=await waitFor(()=>{
   if(qDialog())return 'questions';
   const s=F.groupState();return s==='joined'||s==='pending'?s:null;
  },10000,250);
  if(out==='questions'){
   // membership questions: report them and back out; answering is the user's
   // call. One prompt per answerable control, in the order group-apply answers.
   const d=qDialog();
   const qs=questionControls(d).map((c,i)=>promptOf(c,d)||'question '+(i+1));
   const cancel=[...d.querySelectorAll('[role=button]')].find(x=>/^(Cancel|Hủy|Annuler|Close|Đóng|Fermer)$/i.test(clean(x.innerText||'')));
   if(cancel)cancel.click();
   return 'questions:'+JSON.stringify(qs);
  }
  return out||'unconfirmed';
 };
 // leaving is two steps so the caller can still cancel once the confirm button is showing
 let leaveConfirm=null;
 F.groupLeaveOpen=async()=>{
  leaveConfirm=null;
  const st=F.groupState();if(st!=='joined')return st;
  const b=groupButton();if(!b)return 'none';b.click();
  const item=await waitFor(()=>[...document.querySelectorAll('[role=menuitem],[role=menu] [role=button]')].find(i=>G_LEAVE.test(clean(i.innerText||'').split('\n')[0].trim())),6000);
  if(!item)return 'no-leave-item';
  item.click();
  leaveConfirm=await waitFor(()=>{for(const d of dialogs()){const c=[...d.querySelectorAll('[role=button]')].find(x=>G_LEAVE.test(clean(x.innerText||'').split('\n')[0].trim()));if(c)return c;}return null;},6000);
  return leaveConfirm?'ready':'no-confirm';
 };
 F.groupLeaveConfirm=async()=>{
  const c=leaveConfirm;leaveConfirm=null;
  if(!c||!c.isConnected)return 'no-confirm';
  c.click();
  return (await waitFor(()=>F.groupState()==='can-join'?'left':null,10000,250))||'unconfirmed';
 };
 // answer a group's membership questions and submit: choice questions
 // (radio groups) take the answer whose text matches an option; the rest
 // are text fields filled in order. Nothing is invented — a missing answer
 // leaves its field empty and Facebook's own validation complains.
 // two steps so the caller can still cancel once the answers are filled in
 let applySubmit=null;
 F.groupApplyFill=async(answers)=>{
  applySubmit=null;
  let st=F.groupState();
  if(st==='joined')return 'joined';if(st==='pending')return 'pending';
  if(st==='can-join'){const b=groupButton();if(!b)return 'none';b.click();}
  const d=await waitFor(qDialog,10000);
  if(!d){
   const s=await waitFor(()=>{const x=F.groupState();return x==='joined'||x==='pending'?x:null;},4000,250);
   return s||'no-questions';
  }
  const controls=questionControls(d);
  const label=o=>clean(o.innerText||o.getAttribute('aria-label')||'').toLowerCase();
  for(const [i,c] of controls.entries()){
   const want=answers[i];if(want==null)break;
   if(c.getAttribute('role')==='radiogroup'){
    const opts=[...c.querySelectorAll('[role=radio],[role=checkbox],label')],w=want.toLowerCase();
    const opt=w?opts.find(o=>label(o)===w)||opts.find(o=>label(o).includes(w)):null;
    if(!opt)return 'no-option:'+want;
    opt.click();
   }else if(c.tagName==='TEXTAREA'||c.tagName==='INPUT')setVal(c,want);
   else{c.focus();document.execCommand('selectAll',false,null);document.execCommand('insertText',false,want);}
  }
  applySubmit=[...d.querySelectorAll('[role=button]')].find(x=>/^(Submit|Submit answers|Send|Gửi|Envoyer|Soumettre)$/i.test(clean(x.innerText||'')));
  return applySubmit?'ready':'no-submit';
 };
 F.groupApplySubmit=async()=>{
  const submit=applySubmit;applySubmit=null;
  if(!submit||!submit.isConnected)return 'no-submit';
  submit.click();
  const done=await waitFor(()=>{if(qDialog())return null;const s=F.groupState();return s==='joined'||s==='pending'?s:'submitted';},10000,250);
  return done||'unconfirmed';
 };
 const FRIEND_ADD=/^(Add friend|Thêm bạn bè|Ajouter un ami|Ajouter)$/i;
 const FRIEND_SENT=/^(Friend request sent|Cancel request|Đã gửi lời mời kết bạn|Demande envoyée|Annuler la demande)$/i;
 const FRIEND_IS=/^(Friends|Bạn bè|Amis)$/i;
 // Only controls in the profile header (above the tab strip, outside feed/list/article/dialog regions) belong to the requested profile; recommendations and feed cards live elsewhere.
 const friendControls=()=>{const m=main();const tl=m&&m.querySelector('[role=tablist]');if(!tl)return [];return [...m.querySelectorAll('[role=button]')].filter(x=>!x.closest('[role=tablist],[role=feed],[role=list],[role=article],[role=dialog]')&&(tl.compareDocumentPosition(x)&Node.DOCUMENT_POSITION_PRECEDING)&&F.visible(x)).filter(x=>{const t=btnText(x).split('\n')[0].trim();return FRIEND_ADD.test(t)||FRIEND_SENT.test(t)||FRIEND_IS.test(t);});};
 const friendButton=()=>{const bs=friendControls();return bs.length===1?bs[0]:null;};
 F.friendState=()=>{const bs=friendControls();if(!bs.length)return 'no-button';if(bs.length>1)return 'ambiguous';const t=btnText(bs[0]).split('\n')[0].trim();if(FRIEND_IS.test(t))return 'friends';if(FRIEND_SENT.test(t))return 'requested';if(!F.enabled(bs[0]))return 'no-button';return 'can-add';};
 // The profile header mounts after DOMContentLoaded: wait for the tab strip, then for the relationship control, before concluding there is none.
 F.friendWait=async()=>{const m=await waitFor(()=>{const m=main();return m&&m.querySelector('[role=tablist]')&&m},15000);if(!m)return 'no-profile';const st=await waitFor(()=>{const s=F.friendState();return s!=='no-button'?s:null},5000,200);return st||'no-button';};
 F.friendAdd=async()=>{const st=F.friendState();if(st!=='can-add')return st;const b=friendButton();if(!b)return 'no-button';b.click();const ok=await waitFor(()=>{const s=F.friendState();return s==='requested'||s==='friends'?s:null;},8000,200);return ok||'unconfirmed';};
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
 // Tag every toolbar already on the page. The reaction picker is the
 // toolbar that APPEARS after the hover; page furniture (the comment
 // composer, comment rows) can hold as many buttons and must never be
 // mistaken for it, however long the picker takes to open.
 F.markToolbars=()=>{document.querySelectorAll('[role=toolbar]').forEach(t=>t.setAttribute('data-fb-seen','1'));return true};
 F.reactionPick=(idx,x,y)=>{
  const r=F.postRoot();if(!r)return null;
  const cands=[...document.querySelectorAll('[role=dialog] [role=toolbar],[role=toolbar]')]
   .filter(t=>!t.hasAttribute('data-fb-seen'))
   .map(tb=>({tb,items:[...tb.querySelectorAll('[role=button]')].filter(b=>b.getBoundingClientRect().width>10)}))
   .filter(c=>c.items.length>=6);
  if(!cands.length)return null;
  // The picker opens right at the Like button. Other toolbars on the page
  // (the comment composer, comment rows) can hold as many buttons and are
  // often later in the document — the old last-in-document pick clicked
  // those instead, some of the time. Nearest to the button wins.
  let chosen=cands[cands.length-1];
  if(typeof x==='number'&&typeof y==='number'){
   let best=Infinity;
   for(const c of cands){
    const rc=c.tb.getBoundingClientRect();
    const dx=Math.max(rc.left-x,0,x-rc.right),dy=Math.max(rc.top-y,0,y-rc.bottom);
    const d=dx*dx+dy*dy;
    if(d<=best){best=d;chosen=c}
   }
  }
  const it=chosen.items[idx];if(!it)return null;
  const rc=it.getBoundingClientRect();
  return {x:rc.x+rc.width/2,y:rc.y+rc.height/2,labels:chosen.items.map(b=>b.getAttribute('aria-label')||'')};
 };
})();
