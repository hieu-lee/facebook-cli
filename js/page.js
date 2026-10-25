(()=>{
 const F=window.__fb;
 const refs=new Map();let seq=0;
 const invalidate=()=>refs.clear();
 if(window.navigation)window.navigation.addEventListener('currententrychange',invalidate);
 else for(const method of ['pushState','replaceState']){const original=history[method];history[method]=function(...args){const result=Reflect.apply(original,this,args);invalidate();return result}}
 addEventListener('popstate',invalidate);addEventListener('hashchange',invalidate);
 const epoch=[...crypto.getRandomValues(new Uint32Array(2))].map(x=>x.toString(36)).join('');
 const line=s=>F.clean(s).replace(/[\uD800-\uDFFF]/gu,'�').replace(/[\t\r\n]/g,' ');
 const cut=(s,n)=>{let end=0;for(const c of s){if(n--<=0)break;end+=c.length}return s.slice(0,end)};
 const {visible,enabled}=F;
 const role=e=>e.getAttribute('role')||({A:'link',BUTTON:'button',TEXTAREA:'textbox',SELECT:'combobox',INPUT:e.type==='file'?'file':e.type==='checkbox'?'checkbox':e.type==='radio'?'radio':'textbox'}[e.tagName]||(e.isContentEditable?'textbox':'control'));
 const editor=e=>e.matches('input,textarea,select,[role=textbox]')||e.isContentEditable;
 const editorContents=e=>{for(let p=e;p;p=p.parentElement)if(editor(p))return true;return false;};
 const labelText=e=>e.nodeType===Node.TEXT_NODE?e.nodeValue:e.nodeType===Node.ELEMENT_NODE?(e.getAttribute('aria-label')||e.getAttribute('alt')||(editorContents(e)?'':[...e.childNodes].map(labelText).join(''))):'';
 const labelNames=els=>line([...els].filter(Boolean).map(labelText).join(' '));
 const name=e=>line(labelNames((e.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>document.getElementById(id)))||e.getAttribute('aria-label')||labelNames(e.labels||[])||e.getAttribute('placeholder')||labelText(e)||e.title||'');
 const fingerprint=e=>role(e)+'\t'+name(e)+'\t'+(e.getAttribute('href')||'')+'\t'+(e.type||'');
 const get=ref=>{const r=refs.get(ref);if(!r||r.url!==location.href||!visible(r.e)||fingerprint(r.e)!==r.key)throw Error('stale element ref; take a new snapshot');if(!enabled(r.e))throw Error('element disabled');return r.e;};
 F.pageSnapshot=(filter='')=>{
  refs.clear();const rows=['url\t'+line(location.href)];
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);const text=[];let node,size=0;
  while((node=walker.nextNode())&&size<1800){const p=node.parentElement;if(!visible(p)||editorContents(p)||p.closest('script,style'))continue;const s=cut(line(node.nodeValue),1800-size);if(s){text.push(s);size+=Array.from(s).length+1}}
  rows.push('text\t'+cut(text.join(' '),1800));
  const selector='a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=textbox],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=combobox]';
  const controls=[...document.querySelectorAll(selector+',[contenteditable]')].filter(e=>e.matches(selector)||e.isContentEditable&&!e.parentElement?.isContentEditable);
  let count=0;
  for(const e of controls){
   if(!visible(e)||filter&&!name(e).toLowerCase().includes(filter.toLowerCase()))continue;
   if(count++>=80){rows.push('more\tuse snapshot <filter> or eval for a targeted read');break;}
   const ref='e'+epoch+(++seq).toString(36);refs.set(ref,{e,key:fingerprint(e),url:location.href});
   rows.push([ref,line(role(e)),cut(name(e),160),editor(e)?'[redacted]':''].join('\t'));
  }
  return rows.join('\n');
 };
 F.pageTarget=(ref,action,commit=true)=>{
  const e=get(ref);if(!commit)e.scrollIntoView({block:'center',inline:'center'});
  get(ref);const r=e.getBoundingClientRect();
  if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('element is covered; inspect the blocking dialog');
  if(action==='fill'){
   if(!(e instanceof HTMLTextAreaElement||e.isContentEditable||e instanceof HTMLInputElement&&/^(text|search|email|url|tel|password|number)$/.test(e.type))||e.readOnly)throw Error('element is not editable');
   if(!commit){e.focus();if(document.activeElement!==e)throw Error('element could not be focused');if(e.isContentEditable){const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r)}else e.select()}
  }
  if(action==='upload'&&!(e instanceof HTMLInputElement&&e.type==='file'))throw Error('element is not a file input');
  get(ref);if(action==='fill'&&document.activeElement!==e)throw Error('element lost focus');
  if(action==='fill'&&commit){
   let full;
   if(e.isContentEditable){const expected=document.createRange();expected.selectNodeContents(e);const s=getSelection(),actual=s.rangeCount===1?s.getRangeAt(0):null;full=actual&&actual.compareBoundaryPoints(Range.START_TO_START,expected)===0&&actual.compareBoundaryPoints(Range.END_TO_END,expected)===0}
   else full=e.selectionStart===null?String(getSelection())===e.value:e.selectionStart===0&&e.selectionEnd===e.value.length;
   if(!full)throw Error('replacement selection changed; take a new snapshot');
  }
  const final=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(final.x+final.width/2,final.y+final.height/2)))throw Error('element became covered');
  // Final commit is a separate, side-effect-free check after hover/focus microtasks.
  if(commit){refs.clear();window.__fbPageTarget=e}
  return {x:final.x+final.width/2,y:final.y+final.height/2};
 };
})();
