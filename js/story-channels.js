((allowedName, allowedId, allowedKeys) => {
  function unavailable() { throw new Error('unavailable in a story page'); }
  const maxBody = 1024 * 1024;
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
    if (request.method === 'GET' || request.method === 'HEAD') {
      if (/(^|\.)facebook\.com$/i.test(u.hostname) && /^\/api\/graphql\/?$/.test(u.pathname) && !readOnlyQuery(request.url, 'application/x-www-form-urlencoded', u.search.slice(1))) unavailable();
    } else {
      const type = request.headers.get('content-type') || '';
      if (request.method !== 'POST' || u.search || !queryTarget(u, type) || !readOnlyQuery(request.url, type, await readBody(request))) unavailable();
    }
    return nativeFetch(request);
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
    const type = request?.type || (body instanceof URLSearchParams ? 'application/x-www-form-urlencoded' : '');
    if (!request) unavailable();
    const u = new URL(request.url, location.href);
    if (['GET', 'HEAD'].includes(request.method)) {
      if (/(^|\.)facebook\.com$/i.test(u.hostname) && /^\/api\/graphql\/?$/.test(u.pathname) && !readOnlyQuery(u.href, 'application/x-www-form-urlencoded', u.search.slice(1))) unavailable();
    } else {
      if (request.method !== 'POST' || u.search || !queryTarget(u, type) || !(typeof body === 'string' || body instanceof URLSearchParams)) unavailable();
      if (body instanceof URLSearchParams) {
        let size = 0;
        for (const [key, value] of body) { size += key.length + value.length + 2; if (size > maxBody) unavailable(); }
      }
      if (!readOnlyQuery(request.url, type, String(body))) unavailable();
    }
    return send.call(this, body);
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
