async (seconds, offset) => {
  const visibleBounds = element => {
    const r = element.getBoundingClientRect();
    let left = Math.max(r.left, 0), top = Math.max(r.top, 0), right = Math.min(r.right, innerWidth), bottom = Math.min(r.bottom, innerHeight);
    const ownStyle = getComputedStyle(element);
    if (ownStyle.visibility !== 'visible') return null;
    for (let e = element; e; e = e.parentElement) {
      const style = e === element ? ownStyle : getComputedStyle(e);
      if (style.display === 'none' || Number(style.opacity) === 0) return null;
      if (e !== element && e !== document.body && e !== document.documentElement && /^(auto|scroll|hidden|clip)$/.test(style.overflowX)) { const box = e.getBoundingClientRect(); left = Math.max(left, box.left); right = Math.min(right, box.right); }
      if (e !== element && e !== document.body && e !== document.documentElement && /^(auto|scroll|hidden|clip)$/.test(style.overflowY)) { const box = e.getBoundingClientRect(); top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
    }
    return r.width && r.height && right > left && bottom > top ? {left, top, right, bottom} : null;
  };
  const candidates = [...document.querySelectorAll('video')].filter(v => visibleBounds(v));
  if (!candidates.length) throw Error('no visible video to record');
  let video = candidates[0];
  if (candidates.length > 1) {
    const sheets = [...document.adoptedStyleSheets], hitTestSheet = new CSSStyleSheet();
    hitTestSheet.replaceSync('video { pointer-events: auto !important; }');
    document.adoptedStyleSheets = [...sheets, hitTestSheet];
    try {
      const stack = document.elementsFromPoint(innerWidth / 2, innerHeight / 2);
      const ranked = candidates.map(v => ({v, rank: stack.indexOf(v)})).sort((a, b) => a.rank - b.rank);
      if (ranked.some(x => x.rank < 0)) throw Error('cannot identify the foreground video');
      video = ranked[0].v;
    } finally { document.adoptedStyleSheets = sheets; }
  }
  if (!video.captureStream) throw Error('video capture is unavailable');
  let source = video.currentSrc;
  const sourceUrl = video.src, sourceObject = video.srcObject;
  const sources = [...video.querySelectorAll(':scope > source')].map(s => [s, s.src, s.type, s.media]);
  const changed = () => {
    const current = video.srcObject, children = video.querySelectorAll(':scope > source');
    return source && video.currentSrc !== source || video.src !== sourceUrl ||
      !(current === sourceObject || current instanceof MediaStream && sourceObject instanceof MediaStream && current.id === sourceObject.id) ||
      children.length !== sources.length || sources.some(([s, src, type, media], i) => children[i] !== s || s.src !== src || s.type !== type || s.media !== media);
  };
  const checkSource = () => { if (!video.isConnected || changed()) throw Error('video capture became unavailable'); if (!source) source = video.currentSrc; };
  if (offset !== null) {
    if (!Number.isFinite(video.duration) || offset >= video.duration) throw Error('video cannot seek to that offset');
    if (Math.abs(video.currentTime - offset) > 0.01) {
      await new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); video.removeEventListener('seeked', onSeeked); };
        const onSeeked = () => { cleanup(); resolve(); };
        const timer = setTimeout(() => { cleanup(); reject(Error('video seek timed out')); }, 5000);
        video.addEventListener('seeked', onSeeked);
        try { video.currentTime = offset; } catch (error) { cleanup(); reject(error); }
      });
      checkSource();
    }
  }
  let playTimer;
  try { await Promise.race([video.play(), new Promise((_, reject) => { playTimer = setTimeout(() => reject(Error('video playback timed out')), 5000); })]); }
  finally { clearTimeout(playTimer); }
  checkSource();
  const stream = video.captureStream();
  const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  try {
    if (!mimeType) throw Error('WebM recording is unavailable');
    const tracks = stream.getTracks();
    if (!stream.getVideoTracks().length) throw Error('video capture is unavailable');
    if (tracks.some(track => track.muted || track.readyState !== 'live')) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { cleanup(); reject(Error('video capture is muted or unavailable')); }, 3000);
        const check = () => { if (tracks.every(track => !track.muted && track.readyState === 'live')) { cleanup(); resolve(); } };
        const cleanup = () => { clearTimeout(timer); tracks.forEach(track => track.removeEventListener('unmute', check)); };
        tracks.forEach(track => track.addEventListener('unmute', check));
        check();
      });
    }
    const recorder = new MediaRecorder(stream, {mimeType});
    const chunks = [];
    let size = 0, tooLarge = false, lost = false;
    const stop = () => { if (recorder.state !== 'inactive') recorder.stop(); };
    const onMute = () => { if (!video.ended) { lost = true; stop(); } };
    const onEnd = () => { if (!video.ended || changed()) { lost = true; stop(); } };
    const watchAncestors = () => { observer.disconnect(); for (let p = video.parentNode; p; p = p.parentNode) observer.observe(p, {childList: true}); };
    const observer = new MutationObserver(() => { if (!video.isConnected) { lost = true; stop(); } else watchAncestors(); });
    watchAncestors();
    tracks.forEach(track => track.addEventListener('mute', onMute));
    tracks.forEach(track => track.addEventListener('ended', onEnd));
    video.addEventListener('emptied', onEnd);
    const done = new Promise((resolve, reject) => {
      recorder.ondataavailable = event => {
        size += event.data.size;
        if (size > 64 * 1024 * 1024) { tooLarge = true; if (recorder.state !== 'inactive') recorder.stop(); }
        else chunks.push(event.data);
      };
      recorder.onerror = event => reject(event.error || Error('recording failed'));
      recorder.onstop = resolve;
    });
    video.addEventListener('ended', stop, {once: true});
    const timer = setTimeout(stop, seconds * 1000);
    try { recorder.start(1000); await done; } finally { clearTimeout(timer); observer.disconnect(); video.removeEventListener('ended', stop); video.removeEventListener('emptied', onEnd); tracks.forEach(track => { track.removeEventListener('mute', onMute); track.removeEventListener('ended', onEnd); }); }
    if (!video.isConnected || changed() || !video.ended && tracks.some(track => track.readyState === 'ended')) lost = true;
    if (lost || tooLarge || !size) throw Error(lost ? 'video capture became unavailable' : tooLarge ? 'recording exceeded 64 MB' : 'recording was empty');
    return new Blob(chunks, {type: 'video/webm'});
  } finally {
    stream.getTracks().forEach(track => track.stop());
  }
}
