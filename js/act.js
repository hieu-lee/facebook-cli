(()=>{
 const F=window.__fb;
 const {sleep,clean,vtext,waitFor}=F;
 const main=()=>document.querySelector('[role=main]');
 const dialogs=()=>[...document.querySelectorAll('[role=dialog]')];
 const btnText=b=>clean(b.innerText||'');
 // ---- post composer
 const POST=/^(Post|Đăng|Publier|Publicar|Posten|Veröffentlichen|Pubblica|Plaatsen|Opublikuj|Přidat|Zveřejnit|Pridať|Uverejniť|Paylaş|Опубликовать|Опублікувати|Publicera|Publiser|Julkaise|Postita|Postitus)$/i;
 const NEXT=/^(Next|Tiếp|Tiếp tục|Suivant|Siguiente|Próximo|Seguinte|Weiter|Avanti|Volgende|Dalej|Další|Ďalej|İleri|Далее|Далі|Nästa|Næste|Neste|Seuraava|Järgmine|Edasi)$/i;
 const actionLabel=b=>clean(b.getAttribute('aria-label')||btnText(b));
 const actionControls=d=>[...d.querySelectorAll('[role=button],button')];
 // What the screen shows when a step fails: labels only, never draft text.
 // A control in or around an editor keeps only its aria-label: its innerText would carry the draft.
 const EDITABLE='[contenteditable]:not([contenteditable=false]),textarea,[role=textbox]';
 const safeLabel=b=>clean(b.getAttribute('aria-label')||(b.closest(EDITABLE)||b.querySelector?.(EDITABLE)?'':btnText(b)));
 const composerState=d=>{
  const labels=d?[...new Set(actionControls(d).filter(F.visible).map(b=>safeLabel(b).slice(0,40)).filter(Boolean))].slice(0,14).join(' | '):'';
  const title=d?clean(d.querySelector('[role=heading],h2')?.innerText).slice(0,50):'';
  return ` (dialog "${title}", page language ${document.documentElement?.lang||'unknown'}, buttons: ${labels||'none'})`;
 };
 // In any language the composer card is its text button followed by labelled
 // shortcuts (Live video, Photo/video, ...). Menu buttons such as a profile's
 // "Share a thought..." note are not it.
 const isComposerTrigger=b=>{
  if(window.__fbPostGroup&&(!F.visible(b)||b.closest('[aria-hidden=true],[hidden],[inert]')))return false;
  if(b.getAttribute('aria-label')||b.getAttribute('aria-haspopup')||btnText(b).length<=6)return false;
  let card=b.parentElement;
  while(card&&card.querySelectorAll('[role=button]').length<2)card=card.parentElement;
  const buttons=card?[...card.querySelectorAll('[role=button]')]:[];
  return buttons[0]===b&&buttons.length>=3&&buttons.length<=5&&buttons.slice(1).every(x=>x.getAttribute('aria-label'));
 };
 F.composeGroupCheck=group=>location.pathname.replace(/\/$/,'')===group?true:'the selected group is no longer open; nothing was posted';
 F.composeOpen=async(group=null)=>{
  window.__fbPostGroup=group;
  if(group){const checked=F.composeGroupCheck(group);if(checked!==true)return checked;}
  const m=await waitFor(()=>main(),15000);
  if(!m)return 'no main';
  const trigger=await waitFor(()=>{
   const all=[...m.querySelectorAll('[role=button]')];
   if(group)return all.find(isComposerTrigger)||null;
   const named=all.find(b=>/^(What.s on your mind|Bạn đang nghĩ gì|Exprimez-vous|Que voulez-vous dire|Что у вас нового|О чём вы думаете|Що у вас нового|Mida sa mõtled)/i.test(btnText(b)))||all.find(isComposerTrigger);
   if(named)return named;
   const regs=[...m.querySelectorAll('[role=region]')];
   for(const r of regs){const h=r.querySelector('h1,h2,h3,h4');if(!h)continue;const b=[...r.querySelectorAll('[role=button]')].find(b=>btnText(b).length>6&&!b.getAttribute('aria-haspopup'));if(b)return b;}
   return null;
  },15000);
  if(!trigger)return 'no composer button';
  // Facebook loads the composer on first use: on a slow connection that takes well over
  // 10 seconds, and a click made before the page is ready does nothing. Click once more.
  const composer=()=>dialogs().find(d=>(!group||F.visible(d)&&!d.closest('[aria-hidden=true],[hidden],[inert]'))&&d.querySelector('[role=textbox]'));
  trigger.click();
  let d=await waitFor(composer,12000);
  if(!d&&trigger.isConnected){trigger.click();d=await waitFor(composer,20000);}
  if(!d)return 'composer did not open'+composerState(dialogs().filter(F.visible).pop());
  // Notes and profile editors also hold a textbox, but only the post composer takes files.
  if(!await waitFor(()=>d.querySelector('input[type=file]'),3000,100))return 'opened the wrong dialog instead of the post composer'+composerState(d)+'; nothing was posted';
  // The publish control is the one action an empty composer disables, whatever its language.
  const off=actionControls(d).filter(b=>F.visible(b)&&!F.enabled(b)&&actionLabel(b)&&!NEXT.test(actionLabel(b)));
  window.__fbPublishLabel=off.length===1?actionLabel(off[0]):null;
  const tb=d.querySelector('[role=textbox]');tb.focus();
  return true;
 };
 F.composeDialog=()=>{const exposed=d=>!window.__fbPostGroup||F.visible(d)&&!d.closest('[aria-hidden=true],[hidden],[inert]');const k=window.__fbComposer;return k&&k.isConnected&&exposed(k)?k:dialogs().find(d=>exposed(d)&&d.querySelector('[role=textbox]'));};
 F.composeFocus=()=>{const d=F.composeDialog();const tb=d&&d.querySelector('[role=textbox]');if(!tb)return false;tb.focus();return true;};
 F.composeCheck=text=>{if(window.__fbPostGroup){const checked=F.composeGroupCheck(window.__fbPostGroup);if(checked!==true)return checked;}const d=F.composeDialog();if(!d)return 'no composer; nothing was posted';const tb=d.querySelector('[role=textbox]');if(!tb&&window.__fbComposer)return true;const draft=clean(tb.innerText);return draft===clean(text)?true:!draft?'composer text is empty; nothing was posted':'composer text does not match the requested text; nothing was posted';};
 F.composeAttach=async(name,mime,b64)=>{
  const d=F.composeDialog();const inp=d&&d.querySelector('input[type=file]');
  if(!inp)return 'no file input';
  const bin=atob(b64);const u8=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);
  const dt=new DataTransfer();dt.items.add(new File([u8],name,{type:mime}));
  const before=d.querySelectorAll('img[src^="blob:"],video').length;
  inp.files=dt.files;inp.dispatchEvent(new Event('change',{bubbles:true}));
  const ok=await waitFor(()=>d.querySelectorAll('img[src^="blob:"],video').length>before||d.querySelectorAll('img[src^="data:"]').length>0,15000,150);
  return ok?true:'no preview';
 };
 // matched against the first line only: "Friends except..." is a different audience from "Friends".
 // The label sets cover every language the POST list below recognizes (BlindFB #20 was filed from a
 // Czech or Slovak interface, which the original English/French/Vietnamese set missed entirely).
 const AUD={public:/^(Công khai|Public|Publique|Público|Veřejné|Verejné|Publiczne|Öffentlich|Tutti|Openbaar|Herkese Açık|Доступно всем|Публічно|Offentligt|Offentlig|Julkinen|Avalik)$/i,friends:/^(Bạn bè|Friends|Amis|Amigos|Přátelé|Priatelia|Znajomi|Freunde|Amici|Vrienden|Arkadaşlar|Друзья|Друзі|Vänner|Venner|Kaverit|Sõbrad)$/i,me:/^(Chỉ mình tôi|Only me|Moi uniquement|Sólo yo|Solo yo|Somente eu|Jen já|Len ja|Iba ja|Tylko ja|Nur ich|Solo io|Alleen ik|Sadece ben|Только я|Тільки я|Bara jag|Bare meg|Kun mig|Vain minä|Ainult mina)$/i};
F.AUD=AUD;
 const first=t=>clean(t).split('\n')[0].trim();
 F.composeAudience=async(kind)=>{
  const d=F.composeDialog();if(!d)return 'no composer';
  const visible=e=>F.visible(e)&&!e.closest?.('[aria-hidden=true],[hidden],[inert]');
  const audienceButton=()=>{const dialog=F.composeDialog();return dialog&&[...dialog.querySelectorAll('[role=button]')].find(e=>visible(e)&&/\./.test(e.getAttribute('aria-label')||'')&&btnText(e).length>0&&btnText(e).length<30);};
  const ab=audienceButton();
  if(!ab)return 'no audience button';
  if(AUD[kind].test(first(ab.innerText)))return true;
  ab.click();
  const visibleDialogs=()=>dialogs().filter(visible);
  const text=l=>first(l.innerText||l.getAttribute('aria-label')||'');
  // The picker's choices in screen order, innermost element of each (one choice can be a
  // label wrapping a role=radio).
  const choices=()=>{
   const all=[...new Set(visibleDialogs().flatMap(p=>[...p.querySelectorAll('label,[role=radio],[role=option]')]))].filter(l=>visible(l)&&text(l));
   return all.filter(l=>!all.some(other=>other!==l&&l.contains(other)));
  };
  const named=()=>{const m=choices().filter(l=>AUD[kind].test(text(l)));return m.length===1?m[0]:null;};
  // A language the label sets miss: Facebook lists Public first and Friends second, and
  // Only me is the one choice without a description line. The audience button must show
  // the picked choice afterwards, or nothing is posted.
  const placed=()=>{
   const c=choices();if(c.length<3)return null;
   if(kind==='public')return c[0];
   if(kind==='friends')return c[1];
   const bare=c.filter(l=>!clean(l.innerText||'').includes('\n'));
   return bare.length===1?bare[0]:null;
  };
  // The picker loads on first use too: allow a slow connection.
  const lab=await waitFor(named,8000)||await waitFor(()=>named()||placed(),12000);
  if(!lab)return 'audience option not found'+composerState(visibleDialogs().pop()||d);
  const want=text(lab);
  lab.click();
  await sleep(300);
  const done=await waitFor(()=>{
   const buttons=[...new Set(visibleDialogs().flatMap(p=>[...p.querySelectorAll('[role=button],button')]))].filter(b=>visible(b)&&F.enabled(b)&&/^(Done|Xong|Terminé|Hotovo|Готово|Valmis|Listo|Concluir|Fertig|Fine|Klaar|Bitti|Gotowe|Klar|Færdig|Ferdig)$/i.test(first(b.innerText||b.getAttribute('aria-label'))));
   return buttons.length===1?buttons[0]:null;
  },10000);
  if(!done)return 'audience confirmation button not found; nothing was posted'+composerState(visibleDialogs().pop());
  done.click();
  await sleep(200);
  const current=await waitFor(()=>{const b=audienceButton();return b&&(AUD[kind].test(first(b.innerText))||first(b.innerText)===want)},5000);
  return current?true:'audience change not confirmed; nothing was posted';
 };
 const FRIEND_ADD=/^(Add friend|Thêm bạn bè|Ajouter un ami|Ajouter)$/i;
 const FRIEND_SENT=/^(Friend request sent|Cancel request|Đã gửi lời mời kết bạn|Demande envoyée|Annuler la demande)$/i;
 const FRIEND_IS=/^(Friends|Bạn bè|Amis)$/i;
 const friendButton=()=>{const m=main();if(!m)return null;return [...m.querySelectorAll('[role=button]')].find(x=>{const t=btnText(x).split('\n')[0].trim();return FRIEND_ADD.test(t)||FRIEND_SENT.test(t)||FRIEND_IS.test(t);})||null;};
 F.friendState=()=>{const b=friendButton();if(!b)return 'no-button';const t=btnText(b).split('\n')[0].trim();if(FRIEND_IS.test(t))return 'friends';if(FRIEND_SENT.test(t))return 'requested';if(FRIEND_ADD.test(t))return 'can-add';return 'no-button';};
 F.friendAdd=async()=>{const st=F.friendState();if(st!=='can-add')return st;const b=friendButton();if(!b)return 'no-button';b.click();const ok=await waitFor(()=>{const s=F.friendState();return s==='requested'||s==='friends'?s:null;},8000,200);return ok||'unconfirmed';};
 // ---- group join / leave: the header button cycles Join group -> Requested
 // (private, approval needed) or Joined; leaving goes through the Joined menu
 const G_JOIN=/^(Join group|Join|Tham gia nhóm|Rejoindre le groupe|Rejoindre)$/i;
 const G_JOINED=/^(Joined|Đã tham gia|Membre)$/i;
 const G_PENDING=/^(Requested|Pending|Cancel request|Đã yêu cầu|Demande envoyée|Annuler la demande)$/i;
 const G_LEAVE=/^(Leave group|Rời khỏi nhóm|Quitter le groupe)$/i;
 const groupButton=()=>{const m=main();if(!m)return null;const bs=[...m.querySelectorAll('[role=button]')].map(b=>({b,t:clean(b.innerText||'').split('\n')[0].trim()}));const j=bs.find(x=>G_JOINED.test(x.t));if(j)return j.b;const p=bs.find(x=>G_PENDING.test(x.t));if(p)return p.b;const a=bs.find(x=>G_JOIN.test(x.t));return a?a.b:null;};
 F.groupState=()=>{const b=groupButton();if(!b)return 'none';const t=clean(b.innerText||'').split('\n')[0].trim();if(G_JOINED.test(t))return 'joined';if(G_PENDING.test(t))return 'pending';if(G_JOIN.test(t))return 'can-join';return 'none';};
 // a membership-question dialog: a text field or a choice; a form of choices only has no text field
 const QUESTION='textarea,[role=textbox],input[type=text],[role=radiogroup],[role=radio],input[type=radio]';
 const questionDialog=()=>dialogs().find(d=>d.querySelector(QUESTION));
 F.groupJoin=async()=>{
  const st=F.groupState();if(st!=='can-join')return st;
  const b=groupButton();if(!b)return 'none';b.click();
  const out=await waitFor(()=>{
   const s=F.groupState();if(s==='joined')return 'joined';if(s==='pending')return 'pending';
   if(questionDialog())return 'questions';
   return null;
  },10000,250);
  if(out==='questions'){
   // membership questions: report them and back out; answering is the user's
   // call. Prompts are labels, headings or plain spans — never button text,
   // and a wrapper that repeats a prompt verbatim is dropped.
   const d=questionDialog();
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
  const dlg=questionDialog;
  const d=await waitFor(dlg,10000);
  if(!d){
   const s=await waitFor(()=>{const x=F.groupState();return x==='joined'||x==='pending'?x:null;},4000,250);
   return s||'no-questions';
  }
  // one answer per question, in the order the form shows them (choices and text fields mixed)
  let ai=0;
  const questions=[...d.querySelectorAll('[role=radiogroup],textarea,input[type=text],[role=textbox]')].filter(e=>F.visible(e)&&(e.matches('[role=radiogroup]')||!e.closest('[role=radiogroup]')));
  for(const q of questions){
   const want=answers[ai++];if(want==null)break;
   if(q.matches('[role=radiogroup]')){
    const w=want.toLowerCase();if(!w)continue;
    const opt=[...q.querySelectorAll('[role=radio],[role=checkbox],label')].find(o=>clean(o.innerText||o.getAttribute('aria-label')||'').toLowerCase().includes(w));
    if(opt)opt.click();
   }
   else if(q.tagName==='TEXTAREA'||q.tagName==='INPUT')setVal(q,want);
   else{q.focus();document.execCommand('selectAll',false,null);document.execCommand('insertText',false,want);}
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
  window.__fbListingBox=box;
  return true;
 };
 // copies of `text` in the open chat: counted before the send, so a copy already in the
 // conversation is never taken for the new message
 const listingCopies=text=>{const want=clean(text).toLowerCase();return [...document.querySelectorAll('[role=dialog] [role=log] *,[role=dialog] [role=article]')].filter(e=>clean(e.innerText||'').toLowerCase()===want&&![...e.children].some(c=>clean(c.innerText||'').toLowerCase()===want)).length};
 F.listingMessageCount=listingCopies;
 // sent = one more copy than before, and Facebook emptied the composer (a blocked send keeps it)
 F.listingMessageSent=(text,before=0)=>{
  const box=window.__fbListingBox;
  return listingCopies(text)>before&&!(box&&box.isConnected&&clean(box.innerText||''));
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
 F.sellAttach=async(name,mime,b64)=>{
  const inp=document.querySelector('[role=main] input[type=file],input[type=file]');
  if(!inp)return 'no file input';
  const bin=atob(b64);const u8=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)u8[i]=bin.charCodeAt(i);
  const dt=new DataTransfer();dt.items.add(new File([u8],name,{type:mime}));
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
 const postButtons=()=>{const d=F.composeDialog();return d?actionControls(d).filter(b=>{if(!F.visible(b))return false;const l=actionLabel(b);return POST.test(l)||l===window.__fbPublishLabel;}):[];};
 // ---- follow: a public figure shows Follow / Following in the profile header; a person who
 // also takes friend requests keeps Follow / Unfollow in the header's "…" menu. Only controls
 // above the tab strip belong to the requested profile (as for friend-add).
 const FOLLOW=/^(Follow|Suivre|Theo dõi|Sledovat|Sledovať|Подписаться|Jälgi)$/i;
 const FOLLOWING=/^(Following|Abonné|Abonnée|Abonné\(e\)|Đang theo dõi|Sledujete|Вы подписаны|Jälgid)$/i;
 const UNFOLLOW=/^(Unfollow|Ne plus suivre|Se désabonner|Bỏ theo dõi|Přestat sledovat|Prestať sledovať|Отписаться|Отменить подписку|Lõpeta jälgimine)$/i;
 const headerButtons=()=>{const m=main();const tl=m&&m.querySelector('[role=tablist]');if(!tl)return [];return [...m.querySelectorAll('[role=button]')].filter(x=>!x.closest('[role=tablist],[role=feed],[role=list],[role=article],[role=dialog]')&&(tl.compareDocumentPosition(x)&Node.DOCUMENT_POSITION_PRECEDING)&&F.visible(x));};
 const followButtons=()=>headerButtons().filter(x=>FOLLOW.test(first(btnText(x)))||FOLLOWING.test(first(btnText(x))));
 const openMenu=()=>[...document.querySelectorAll('[role=menu]')].filter(F.visible).pop()||null;
 const closeMenu=async()=>{if(!openMenu())return;(document.activeElement||document.body).dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',keyCode:27,bubbles:true}));await waitFor(()=>!openMenu(),1500,100);};
 const menuItem=(m,re)=>m&&[...m.querySelectorAll('[role=menuitem]')].find(i=>F.visible(i)&&re.test(first(btnText(i))))||null;
 // open each header "…" menu until one holds Follow or Unfollow; that menu stays open
 // the header's "…" menu button sits beside the tab strip, after it in the page: it counts when
 // it is nearer the tab strip than the first post is (posts and footers have menus too)
 const headerMenus=()=>{
  const m=main();const tl=m&&m.querySelector('[role=tablist]');if(!tl)return [];
  // a menu beside the tab strip shares a container with it that holds no post: posts, with or
  // without an article role, are found the way the feed finds them
  const cards=F.postCards?F.postCards():[];
  const header=x=>{let a=tl;while(a&&!a.contains(x))a=a.parentElement;return !!a&&!a.querySelector('[role=article],[role=feed]')&&!cards.some(c=>a.contains(c))};
  const before=x=>tl.compareDocumentPosition(x)&Node.DOCUMENT_POSITION_PRECEDING;
  // a friend's Unfollow is in the menu of the header's own Friends button
  const friends=headerButtons().filter(x=>FRIEND_IS.test(first(btnText(x))));
  return [...friends,...[...m.querySelectorAll('[aria-haspopup=menu][role=button]')].filter(x=>F.visible(x)&&!x.closest('[role=tablist],[role=feed],[role=list],[role=article],[role=dialog]')&&(before(x)||header(x)))];
 };
 const followMenu=async()=>{
  for(const b of headerMenus()){
   F.press(b);
   const m=await waitFor(()=>{const m=openMenu();return menuItem(m,FOLLOW)||menuItem(m,UNFOLLOW)?m:null;},3000,100);
   if(menuItem(m,FOLLOW)||menuItem(m,UNFOLLOW))return m;
   await closeMenu();
  }
  return null;
 };
 // 'following', 'can-follow', 'no-follow' (this profile offers neither), 'ambiguous' or 'no-profile'
 F.followState=async()=>{
  if(!await waitFor(()=>main()&&main().querySelector('[role=tablist]'),15000))return 'no-profile';
  // the header's controls mount after the tab strip, and another header menu can be there
  // before the Follow control is: look again until the deadline
  const until=Date.now()+5000;
  for(;;){
   const hb=followButtons();
   if(hb.length>1)return 'ambiguous';
   if(hb.length)return FOLLOWING.test(first(btnText(hb[0])))?'following':'can-follow';
   const m=await followMenu();
   if(m){const st=menuItem(m,UNFOLLOW)?'following':'can-follow';await closeMenu();return st;}
   if(Date.now()>=until)return 'no-follow';
   await sleep(500);
  }
 };
 // follow (on) or unfollow (!on), then read the state back; already there = nothing pressed
 let followAction=null;
 F.followPrepare=async on=>{
  followAction=null;
  const st=await F.followState();
  if(st!=='following'&&st!=='can-follow')return st;
  if((st==='following')===on)return st;
  const hb=followButtons()[0];
  if(hb&&on){followAction={button:hb,on};return 'ready';}
  else{
   // a header "Following" opens its own menu with Unfollow; otherwise the "…" menu holds the item
   let m;
   if(hb){F.press(hb);m=await waitFor(()=>{const m=openMenu();return menuItem(m,UNFOLLOW)?m:null;},3000,100);}else m=await followMenu();
   const it=menuItem(m,on?FOLLOW:UNFOLLOW);
   if(!it){await closeMenu();return 'no-item';}
   followAction={button:it,on};return 'ready';
  }
 };
 // No awaits between validation and the relationship press: the caller checks cancellation first.
 F.followPress=()=>{
  const action=followAction;followAction=null;
  if(!action)return 'no-item';
  const {button,on}=action;
  if(!button.isConnected||!F.visible(button)||!F.enabled(button)||!(on?FOLLOW:UNFOLLOW).test(first(btnText(button))))return 'no-item';
  F.press(button);return 'pressed';
 };
 F.followConfirm=async on=>{
  await sleep(1500);
  await closeMenu();
  const want=on?'following':'can-follow';
  let after='';
  for(let i=0;i<4&&after!==want;i++){if(i)await sleep(1000);after=await F.followState();}
  return after;
 }; const postButton=()=>{const bs=postButtons();return bs.length===1?bs[0]:null;};
 const nextButton=()=>{const d=F.composeDialog();const bs=d?actionControls(d).filter(b=>F.visible(b)&&NEXT.test(actionLabel(b))):[];return bs.length===1?bs[0]:null;};
 // Retained audience panes can put Done after Post; order is not action identity.
 F.composePrepare=async text=>{
  if(!F.composeDialog())return 'no composer';
  const post=await waitFor(()=>{
   const b=postButton();if(b&&F.enabled(b))return b;
   // Some accounts get Next, then a settings pane holding Post. Next publishes nothing,
   // but it can remove the editor, so this is the last chance to compare the draft.
   // ponytail: a settings pane's Post is found by the POST list only. Guessing among its
   // unlabelled toggles could press the wrong one; an unknown word fails and names the buttons.
   const n=!window.__fbComposer&&nextButton();
   if(n&&F.enabled(n)&&F.composeCheck(text)===true){
    const d=F.composeDialog();
    F.press(n,{valid:()=>n===nextButton()&&F.enabled(n)&&F.composeCheck(text)===true});
    window.__fbComposer=d;
   }
   return null;
  },60000,150);
  if(!post){
   const d=F.composeDialog();if(!d)return 'composer disappeared before Post became ready; nothing was posted';
   const bs=postButtons();
   const tb=d.querySelector('[role=textbox]');
   const reason=tb&&!clean(tb.innerText)&&!d.querySelector('img[src^="blob:"],img[src^="data:"],video')?'composer text is empty and no attachments were found':!bs.length?'Post button not found':bs.length>1?'multiple visible Post buttons found':'Post button is disabled';
   const progress=[...d.querySelectorAll('[role=progressbar]')].some(F.visible)?'; progress indicator visible':'';
   return reason+progress+composerState(d)+'; nothing was posted';
  }
  F.press(post,{events:['pointerover','mouseover'],valid:()=>post===postButton()&&F.enabled(post)});
  await sleep(0);
  if(post!==postButton()||!F.enabled(post))return 'post button changed; nothing was posted';
  window.__fbPostBtn=post;
  return true;
 };
 F.composePress=async text=>{
  const post=window.__fbPostBtn;if(!post||post!==postButton()||!F.enabled(post))return 'post button changed; nothing was posted';
  const checked=F.composeCheck(text);if(checked!==true)return checked;
  F.press(post,{events:['pointerdown','mousedown','pointerup','mouseup','click'],valid:()=>post===postButton()&&F.enabled(post)&&F.composeCheck(text)===true});
  const closed=await waitFor(()=>!F.composeDialog(),90000,200);
  return closed?true:'post dialog still open (upload slow?)'+composerState(dialogs().filter(F.visible).pop());
 };
 // ---- post-level actions (root = dialog showing the post, or main)
 const postRoot=()=>{for(const d of dialogs())if(d.querySelector('[data-ad-rendering-role=profile_name]'))return d;const m=main();return m&&m.querySelector('[data-ad-rendering-role=profile_name]')&&m;};
 F.postRoot=postRoot;
 F.postReady=async()=>{const r=await waitFor(postRoot,15000);if(r)await sleep(600);return !!r;};
 const MENU_RE={del:/Chuyển vào thùng rác|Move to trash|Move to Recycle|Xóa bài viết|Delete post|Supprimer|Déplacer vers la corbeille|Xóa|Удалить публикацию|Переместить в корзину|Kustuta postitus|Teisalda prügikasti/i};
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
  const confirm=await waitFor(()=>{for(const d of dialogs()){const b=[...d.querySelectorAll('[role=button]')].find(b=>/^(Di chuyển|Move|Xóa|Delete|Supprimer|Déplacer|Remove|Удалить|Переместить|Kustuta|Teisalda)/i.test(clean(b.innerText)||b.getAttribute('aria-label')||''));if(b)return b;}return null;},6000);
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
