((allowedName, allowedId, allowedKeys) => {
  function unavailable() { throw new Error('unavailable in a story page'); }
  const maxBody = 1024 * 1024;
  const photoPages=new Map(),photoFailures=new Set(),photoPending=new Map(),photoSealed=new Set();let photoUnknownFailure=false,photoItemCount=0,photoPageCount=0,photoReads=0,photoPreparing=0;
  const photoVars=body=>{try{const value=JSON.parse(new URLSearchParams(body).get('variables')||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{}}catch{return {}}};
  const failPhoto=id=>{if(typeof id==='string'&&id.length<=4096&&photoFailures.size<1000)photoFailures.add(id);else photoUnknownFailure=true};
  const blocked=id=>photoUnknownFailure||photoFailures.has(id);
  Object.defineProperty(window, '__fbPhotoPage', {value: (id,cursor) => ({page:photoPages.get(id)?.get(cursor)||null,blocked:blocked(id),pending:!!photoPending.get(id)?.get(cursor)||photoPreparing>0,pendingAny:!!photoPending.get(id)?.size||photoPreparing>0}), configurable: false});
  Object.defineProperty(window, '__fbPhotoSeal', {value: (id,visited) => {if(blocked(id))return {blocked:true};if(photoPending.get(id)?.size||photoPreparing)return {pending:true};if(!photoSealed.has(id)&&photoSealed.size>=1000){failPhoto(id);return {blocked:true}}photoSealed.add(id);let incomplete=false;for(const cursor of photoPages.get(id)?.keys()||[])if(!visited?.has(cursor)){incomplete=true;break}return {incomplete}}, configurable: false});
  const beginPhoto=vars=>{
    if(typeof vars?.id!=='string'||vars.id.length>4096||typeof vars.cursor!=='string'||vars.cursor.length>4096){failPhoto(vars?.id);return null}
    if(photoSealed.has(vars.id))return null;
    let cursors=photoPending.get(vars.id);if(!cursors){cursors=new Map();photoPending.set(vars.id,cursors)}
    cursors.set(vars.cursor,(cursors.get(vars.cursor)||0)+1);let active=true;
    return ()=>{if(!active)return;active=false;const n=cursors.get(vars.cursor)-1;if(n)cursors.set(vars.cursor,n);else cursors.delete(vars.cursor);if(!cursors.size)photoPending.delete(vars.id)};
  };
  const savePhotoData = (status,text,vars) => {
    try {
      if(status!==200||typeof vars.id!=='string'||vars.id.length>4096||typeof vars.cursor!=='string'||vars.cursor.length>4096||text.length>8*1024*1024)return failPhoto(vars.id);
      const node=JSON.parse(text).data?.node,connection=node?.pageItems,info=connection?.page_info;
      if(node?.id!==vars.id||!Array.isArray(connection?.edges)||connection.edges.length>1001||typeof info?.has_next_page!=='boolean'||(info.end_cursor!=null&&(typeof info.end_cursor!=='string'||info.end_cursor.length>4096))||(info.has_next_page&&!info.end_cursor))return failPhoto(vars.id);
      const items=connection.edges.map(edge=>{
        const photo=edge?.node?.node,ready=edge?.node?.__typename==='TimelineAppCollectionItem'&&photo?.__typename==='Photo';
        return photo&&typeof photo.id==='string'&&photo.id.length<=32&&/^\d+$/.test(photo.id)?{id:photo.id,url:ready&&typeof photo.viewer_image?.uri==='string'&&photo.viewer_image.uri.trim()&&photo.viewer_image.uri.length<=8192?photo.viewer_image.uri:null,...(ready?{}:{ready:false})}:null;
      });
      let pages=photoPages.get(vars.id);const old=pages?.get(vars.cursor);
      if(old){
        if(old.items.length!==items.length||old.more!==info.has_next_page||old.cursor!==(info.end_cursor??null))return failPhoto(vars.id);
        for(let i=0;i<items.length;i++){
          const a=old.items[i],b=items[i];if(a&&b&&a.id!==b.id)return failPhoto(vars.id);
          if(!a&&b||a?.ready===false&&b&&b.ready!==false)old.items[i]=b;else if(a&&b&&a.ready!==false&&b.url)a.url=b.url;
        }
        return;
      }
      if(photoItemCount+items.length>2000||photoPageCount>=1000)return failPhoto(vars.id);photoPageCount++;
      if(!pages){pages=new Map();photoPages.set(vars.id,pages)}
      photoItemCount+=items.length;
      pages.set(vars.cursor,{items,more:info.has_next_page,cursor:info.end_cursor??null});
    } catch { failPhoto(vars?.id); }
  };
  const savePhotoPage = (request,vars) => {try{if(request.status!==200)return failPhoto(vars?.id);savePhotoData(request.status,request.responseText,vars)}catch{failPhoto(vars?.id)}};
  const watchPhotoXhr = (request,vars) => {
    const end=beginPhoto(vars);if(!end)return null;
    if(photoReads>=4){end();failPhoto(vars?.id);return null}
    photoReads++;let active=true;
    const progress=e=>{if(e.loaded>8*1024*1024){failPhoto(vars?.id);request.abort()}};
    const release=()=>{if(!active)return;active=false;photoReads--;end();request.removeEventListener('progress',progress);request.removeEventListener('loadend',done)};
    const done=()=>{savePhotoPage(request,vars);release()};
    request.addEventListener('progress',progress);
    request.addEventListener('loadend',done,{once:true});return release;
  };
  const savePhotoResponse = async (response,vars) => {
    let reader,timer;try{
      reader=response.clone().body?.getReader();if(!reader)return failPhoto(vars?.id);
      let size=0,chunks=0,timedOut=false;const parts=[],decoder=new TextDecoder();
      timer=setTimeout(()=>{timedOut=true;void reader.cancel().catch(()=>{})},10000);
      for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024||++chunks>4096){void reader.cancel().catch(()=>{});return failPhoto(vars?.id)}parts.push(decoder.decode(value,{stream:true}));}
      if(timedOut)return failPhoto(vars?.id);parts.push(decoder.decode());savePhotoData(response.status,parts.join(''),vars);
    }catch{failPhoto(vars?.id)}finally{clearTimeout(timer);reader?.releaseLock()}
  };
  const rejectQuery = body => {
    try { if (allowedName === 'ProfileCometAppCollectionPhotosRendererPaginationQuery' && new URLSearchParams(body).get('fb_api_req_friendly_name') === allowedName) failPhoto(photoVars(body).id); } catch {}
    unavailable();
  };
  const queryTarget = (u, type) => u.protocol === 'https:' && /(^|\.)facebook\.com$/i.test(u.hostname) && u.pathname === '/api/graphql/' && type.toLowerCase().startsWith('application/x-www-form-urlencoded');
  const readOnlyQuery = (url, type, body) => {
    try {
      const u = new URL(url, location.href);
      if (!queryTarget(u, type) || body.length > maxBody ||
          body.split('&').some(part => !part.includes('=') || !allowedKeys.includes(part.split('=')[0]))) return false;
      const params = new URLSearchParams(body), names = params.getAll('fb_api_req_friendly_name'), ids = params.getAll('doc_id');
      return names.length === 1 && names[0] === allowedName && ids.length === 1 && ids[0] === allowedId;
    } catch { return false; }
  };
  const readBody = async request => {
    const reader = request.clone().body?.getReader();
    if (!reader) return '';
    let bytes = new Uint8Array(0);
    let size = 0, chunks = 0, timedOut = false;
    const cancel = () => { void reader.cancel().catch(() => {}); void request.body.cancel().catch(() => {}); };
    const timer = setTimeout(() => { timedOut = true; cancel(); }, 5000);
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) { if (timedOut) unavailable(); return new TextDecoder().decode(bytes.subarray(0, size)); }
        const nextSize = size + value.byteLength;
        if (nextSize > maxBody || ++chunks > 4096) {
          cancel();
          unavailable();
        }
        if (nextSize > bytes.length) {
          const grown = new Uint8Array(Math.min(maxBody, Math.max(4096, bytes.length * 2, nextSize)));
          grown.set(bytes);
          bytes = grown;
        }
        bytes.set(value, size);
        size = nextSize;
      }
    } finally { clearTimeout(timer); reader.releaseLock(); }
  };
  const nativeFetch = window.fetch;
  Object.defineProperty(window, 'fetch', {configurable: false, value: async (input, init) => {
    const request = new Request(input, init);
    const u = new URL(request.url);
    let vars=null,reserved=false,preparing=false,end=null;
    try{if (request.method === 'GET' || request.method === 'HEAD') {
      if (/(^|\.)facebook\.com$/i.test(u.hostname) && /^\/api\/graphql\/?$/.test(u.pathname) && !readOnlyQuery(request.url, 'application/x-www-form-urlencoded', u.search.slice(1))) rejectQuery(u.search.slice(1));
      if(allowedName==='ProfileCometAppCollectionPhotosRendererPaginationQuery'&&queryTarget(u,'application/x-www-form-urlencoded')){if(request.method==='GET')vars=photoVars(u.search.slice(1));else failPhoto(photoVars(u.search.slice(1)).id)}
    } else {
      const type = request.headers.get('content-type') || '';
      if (request.method !== 'POST' || u.search || !queryTarget(u, type)) unavailable();
      if(allowedName==='ProfileCometAppCollectionPhotosRendererPaginationQuery'){
        if(photoReads>=4){photoUnknownFailure=true;unavailable()}
        photoReads++;photoPreparing++;reserved=true;preparing=true;
      }
      let body;try{body=await readBody(request)}catch(error){if(preparing)photoUnknownFailure=true;throw error}
      if (!readOnlyQuery(request.url, type, body)) rejectQuery(body);
      if(allowedName==='ProfileCometAppCollectionPhotosRendererPaginationQuery')vars=photoVars(body);
    }
    if(vars){
      end=beginPhoto(vars);if(!end)unavailable();
      if(!reserved){if(photoReads>=4){failPhoto(vars.id);unavailable()}photoReads++;reserved=true}
      if(preparing){photoPreparing--;preparing=false}
      const response=await nativeFetch(request),release=end;end=null;reserved=false;
      void savePhotoResponse(response,vars).finally(()=>{photoReads--;release()});return response;
    }
    return await nativeFetch(request);
    }catch(error){if(preparing)photoPreparing--;if(reserved)photoReads--;if(end){failPhoto(vars?.id);end()}throw error}
  }});
  const open = XMLHttpRequest.prototype.open, header = XMLHttpRequest.prototype.setRequestHeader, send = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    requests.set(this, {method: String(method).toUpperCase(), url, type: ''});
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (String(name).toLowerCase() === 'content-type') requests.get(this).type = String(value);
    return header.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function(body) {
    const request = requests.get(this);
    let release=null,captureId=null;
    const type = request?.type || (body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : '');
    if (!request) unavailable();
    const u = new URL(request.url, location.href);
    if (['GET', 'HEAD'].includes(request.method)) {
      if (/(^|\.)facebook\.com$/i.test(u.hostname) && /^\/api\/graphql\/?$/.test(u.pathname) && !readOnlyQuery(u.href, 'application/x-www-form-urlencoded', u.search.slice(1))) rejectQuery(u.search.slice(1));
      if(allowedName==='ProfileCometAppCollectionPhotosRendererPaginationQuery'&&queryTarget(u,'application/x-www-form-urlencoded')){const vars=photoVars(u.search.slice(1));if(request.method==='GET'){captureId=vars.id;release=watchPhotoXhr(this,vars);if(!release)unavailable()}else failPhoto(vars.id)}
    } else {
      if (request.method !== 'POST' || u.search || !queryTarget(u, type) || !(typeof body === 'string' || body instanceof URLSearchParams)) unavailable();
      if (body instanceof URLSearchParams) {
        let size = 0;
        for (const [key, value] of body) { size += key.length + value.length + 2; if (size > maxBody) unavailable(); }
      }
      if (!readOnlyQuery(request.url, type, String(body))) rejectQuery(String(body));
      if (allowedName === 'ProfileCometAppCollectionPhotosRendererPaginationQuery') {const vars=photoVars(String(body));captureId=vars.id;release=watchPhotoXhr(this,vars);if(!release)unavailable()}
    }
    try{return send.call(this, body)}catch(error){if(release){failPhoto(captureId);release()}throw error}
  };
  Object.defineProperty(navigator, 'sendBeacon', {value: () => false, configurable: false});
  for (const name of ['Worker', 'SharedWorker', 'WebSocket', 'EventSource']) {
    Object.defineProperty(window, name, {value: unavailable, configurable: false});
  }
  Object.defineProperty(window, 'open', {value: () => null, configurable: false});
  Object.defineProperty(HTMLFormElement.prototype, 'submit', {value: unavailable, configurable: false});
  if (navigator.serviceWorker) {
    navigator.serviceWorker.register = () => Promise.reject(new Error('unavailable in a story page'));
    if (window.ServiceWorker) ServiceWorker.prototype.postMessage = unavailable;
  }
  addEventListener('click', e => {
    const link = e.target instanceof Element && e.target.closest('a[href],area[href]');
    if (!link) return;
    e.preventDefault();
    const u = new URL(link.href, location.href);
    if (u.protocol === 'https:' && /(^|\.)facebook\.com$/i.test(u.hostname) && u.pathname.startsWith('/stories/')) {
      e.stopImmediatePropagation();
      location.assign(u.href);
    }
  }, true);
  addEventListener('submit', e => { e.preventDefault(); e.stopImmediatePropagation(); }, true);
})
