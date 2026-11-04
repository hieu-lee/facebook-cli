// Pure-function checks for the injected page scripts. Run: node tests/js.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = { };
global.document = { querySelectorAll: () => [], querySelector: () => null };
global.location = { href: 'https://www.facebook.com/' };
global.URL = URL;

const src = fs.readFileSync(path.join(__dirname, '../js/lib.js'), 'utf8');
new Function(src).call(global.window);
const F = global.window.__fb;

// Composer timeouts use an immediate waitFor so every failure state is checked without a minute's delay.
(async () => {
  const vm = require('vm');
  const textbox = { innerText: 'requested draft' };
  let buttons = [], present = true, attached = false, progress = false, afterWait = () => {};
  const dialog = {
    querySelector(sel) {
      if (sel === '[role=textbox]') return textbox;
      if (sel.includes('progressbar')) return progress ? {} : null;
      if (sel.includes('img') || sel.includes('video')) return attached ? {} : null;
      return null;
    },
    querySelectorAll(sel) { return sel === '[role=progressbar]' ? progress ? [button()] : [] : buttons.filter(b => sel.includes('[role=button]') && b.role === 'button' || sel.split(',').includes('button') && b.tag === 'button'); },
  };
  const ctx = vm.createContext({ window: {}, document: { querySelectorAll: () => present ? [dialog] : [] }, location: { href: 'https://www.facebook.com/' }, URL,
    getComputedStyle: e => ({ visibility: e.visibility }), MouseEvent: class { constructor(type) { this.type = type; } }, PointerEvent: class { constructor(type) { this.type = type; } } });
  vm.runInContext(src, ctx);
  const G = ctx.window.__fb;
  Object.assign(G, { sleep: async () => {}, waitFor: async (fn, ms) => { const result = fn(); if (ms === 60000) afterWait(); return result; } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/act.js'), 'utf8'), ctx);
  const button = (tag = 'div', label = 'Post') => ({ tag, role: tag === 'div' ? 'button' : null, innerText: label, visibility: 'visible', isConnected: true, disabled: false, events: [],
    getAttribute(name) { return name === 'role' ? this.role : name === 'aria-label' ? this.innerText : null; },
    getClientRects() { return [{}]; }, matches() { return this.disabled; }, closest() { return null; }, getBoundingClientRect() { return { x: 0, y: 0, width: 20, height: 20 }; },
    dispatchEvent(e) { this.events.push(e.type); this.onEvent?.(e.type); },
  });
  buttons = [button('button')];
  assert.strictEqual(await G.composePrepare(), true, 'native Post button is recognized');
  assert.strictEqual(G.composeCheck('requested draft'), true);
  textbox.innerText = ' requested\u00a0 draft\u200b ';
  assert.strictEqual(G.composeCheck('requested draft'), true, 'draft uses receipt normalization');
  textbox.innerText = '';
  assert.match(G.composeCheck('requested draft'), /text is empty/);
  assert.match(await G.composePress('requested draft'), /text is empty/);
  assert(!buttons[0].events.includes('click'), 'empty draft must not publish');
  textbox.innerText = 'private different draft';
  const mismatch = await G.composePress('requested draft');
  assert.match(mismatch, /does not match/);
  assert(!mismatch.includes('private different draft'), 'error must not expose draft');
  assert(!buttons[0].events.includes('click'), 'mismatched draft must not publish');
  textbox.innerText = '';
  buttons = [];
  assert.match(await G.composePrepare(), /text is empty.*no attachments/);
  attached = true;
  assert.match(await G.composePrepare(), /Post button not found/);
  buttons = [button('div', 'Share note')];
  assert.match(await G.composePrepare(), /Post button not found.*Share note.*nothing was posted/, 'the error names what is on screen');
  buttons = [];
  buttons = [button()]; buttons[0].disabled = true;
  assert.match(await G.composePrepare(), /Post button.*disabled/);
  progress = true;
  assert.match(await G.composePrepare(), /progress indicator/);
  progress = false; attached = false; textbox.innerText = 'requested draft';
  buttons = [button()]; buttons[0].visibility = 'hidden';
  assert.match(await G.composePrepare(), /Post button not found/);
  buttons = [button(), button('button')];
  assert.match(await G.composePrepare(), /multiple.*Post buttons/);
  buttons = [button()]; buttons[0].disabled = true;
  afterWait = () => { present = false; };
  assert.match(await G.composePrepare(), /composer.*closed|composer.*disappeared/);
  assert.strictEqual(G.composeCheck('requested draft'), 'no composer; nothing was posted');
  present = true; afterWait = () => {};
  buttons = [button()];
  assert.strictEqual(await G.composePrepare(), true);
  buttons[0].innerText = 'Other action';
  assert.match(await G.composePress('requested draft'), /post button changed/);
  buttons = [button()];
  assert.strictEqual(await G.composePrepare(), true);
  buttons[0].onEvent = event => { if (event === 'pointerdown') textbox.innerText = 'changed during press'; };
  await assert.rejects(() => G.composePress('requested draft'), /action target changed/);
  assert(!buttons[0].events.includes('click'), 'draft mutation during press must not publish');
  textbox.innerText = ''; attached = true; buttons = [button('button')];
  assert.strictEqual(await G.composePrepare(), true);
  buttons[0].onEvent = event => { if (event === 'click') present = false; };
  assert.strictEqual(await G.composePress(''), true, 'attachment-only posts remain supported');
  assert(buttons[0].events.includes('click'));
  // Next can remove the editor, so a changed draft must never pass it.
  present = true; attached = false; textbox.innerText = 'changed draft';
  const next = button('div', 'Next'); buttons = [next];
  await G.composePrepare('requested draft');
  assert.strictEqual(next.events.length, 0, 'a changed draft must not advance past the editor');
  textbox.innerText = 'requested draft';
  next.onEvent = event => { if (event === 'pointerdown') textbox.innerText = 'changed draft'; };
  await assert.rejects(() => G.composePrepare('requested draft'), /action target changed/);
  assert(!next.events.includes('click'), 'a draft changed while pressing Next must not advance');
  textbox.innerText = 'requested draft'; next.onEvent = null; next.events = [];
  const pane = button('div', 'Post'); pane.visibility = 'hidden'; buttons = [next, pane];
  next.onEvent = event => { if (event === 'click') { buttons = [pane]; pane.visibility = 'visible'; } };
  await G.composePrepare('requested draft');
  assert(next.events.includes('click'), 'the requested draft advances past Next');
  // An unknown label is never assumed to be Post, even when it is the only control.
  present = true; textbox.innerText = 'requested draft';
  const unknown = button('div', 'Tovább'); buttons = [unknown];
  assert.match(await G.composePrepare('requested draft'), /Post button not found.*Tovább.*nothing was posted/);
  assert.deepStrictEqual(unknown.events, [], 'an unrecognised control is never pressed');
  assert.strictEqual(await G.composePress('requested draft'), 'post button changed; nothing was posted');
  const known = button('div', 'Közzététel'); buttons = [known];
  assert.strictEqual(await G.composePrepare('requested draft'), true, 'a listed translated Post label is recognised');
  console.log('js composer ok');
})().catch(e => { console.error(e); process.exit(1); });

for (const t of ['3 giờ trước', '22 phút', 'Hôm qua lúc 14:00', '17 Tháng 6', '4 tháng 10 lúc 22:05', '2h', '5 minutes ago', 'Just now', 'il y a 3 jours', 'Oct 4 at 10:05 PM'])
  assert(F.TIME.test(t), 'TIME should match: ' + t);
for (const t of ['Thích', 'Hieu Lee', '22 bình luận', 'Trả lời'])
  assert(!F.TIME.test(t), 'TIME should not match: ' + t);

assert.strictEqual(F.canon('https://www.facebook.com/groups/123/?multi_permalinks=456&hoisted=1&__cft__[0]=abc'), '/groups/123/posts/456');
assert.strictEqual(F.canon('https://www.facebook.com/page/posts/pfbid0X?__cft__[0]=zz&__tn__=%2CO'), '/page/posts/pfbid0X');
assert.strictEqual(F.canon('https://www.facebook.com/photo/?fbid=99&set=a.1&__cft__[0]=z'), '/photo/?fbid=99&set=a.1');
assert.strictEqual(F.clean('a͏ ​b  c'), 'a b c');
assert.strictEqual(F.shortBadge('AH.FM Accounts with a verified badge have been authenticated and can be Meta Verified subscribers or notable persons or brands. is with Tiësto'), 'AH.FM Verified is with Tiësto');
// message text and drafts that quote the sentence are content, not metadata
assert.strictEqual(F.clean('Accounts with a verified badge have been authenticated and can be Meta Verified subscribers or notable persons or brands.'), 'Accounts with a verified badge have been authenticated and can be Meta Verified subscribers or notable persons or brands.');
assert.strictEqual(F.parseLabel(['At 10:00, You: Accounts with a verified badge have been authenticated and can be Meta Verified subscribers or notable persons or brands.']).text, 'Accounts with a verified badge have been authenticated and can be Meta Verified subscribers or notable persons or brands.');
assert.strictEqual(F.groupPath('https://www.facebook.com/groups/123456/'), '/groups/123456');
assert.strictEqual(F.groupPath('/groups/hikers.uk?__cft__[0]=x'), '/groups/hikers.uk');
assert.strictEqual(F.groupPath('https://www.facebook.com/groups/123/posts/456'), null);
assert.strictEqual(F.groupPath('https://www.facebook.com/groups/feed/'), null);
assert.strictEqual(F.groupPath('https://www.facebook.com/groups/joins'), null);
assert.strictEqual(F.profilePath('https://www.facebook.com/some.user'), '/some.user');
assert.strictEqual(F.profilePath('/profile.php?id=123&sk=about'), '/profile.php?id=123');
assert.strictEqual(F.profilePath('https://www.facebook.com/groups/123456'), null);
assert.strictEqual(F.profilePath('https://www.facebook.com/some.user/posts/456'), null);
assert.strictEqual(F.profilePath('https://www.facebook.com/watch?v=1'), null);
assert.strictEqual(F.profilePath('https://www.facebook.com/photo.php?fbid=1'), null);
assert.strictEqual(F.profilePath('/people/Alice-Smith/61512345678901/'), '/profile.php?id=61512345678901');
assert.strictEqual(F.profilePath('https://m.facebook.com/people/Alice-Smith/61512345678901'), '/profile.php?id=61512345678901');
assert.strictEqual(F.profilePath('/profile.php?id=abc'), null);
assert.strictEqual(F.profilePath('https://example.org/stranger'), null);
assert.strictEqual(F.profilePath('https://notfacebook.com/stranger'), null);
assert.strictEqual(F.profilePath('https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.org'), null);
assert.strictEqual(F.profilePath('https://www.facebook.com/l.php?u=x'), null);
console.log('js profilePath ok');
assert.strictEqual(F.groupPath('https://www.facebook.com/somepage'), null);
{const m=new Map();
 F.addGroup(m,'/groups/1',['Paris Hikers','Public group · 2K members']);
 F.addGroup(m,'/groups/1',['Paris Hikers']);
 F.addGroup(m,'/groups/1',['Private group','2K members']);
 F.addGroup(m,'/groups/2',['Solo']);
 assert.deepStrictEqual([...m],[['/groups/1',{name:'Paris Hikers',info:['Public group · 2K members','Private group','2K members']}],['/groups/2',{name:'Solo',info:[]}]]);}
console.log('js groupPath ok');
assert.strictEqual(F.trunc('abcdef', 3), 'abc…');
assert(F.ACT.test('Thích') && F.ACT.test('Reply') && !F.ACT.test('Hello'));
console.log('js ok');

// emoji must never be cut in half (a lone surrogate is invalid JSON for the Rust side)
const long = 'a'.repeat(159) + '😀😀';
assert.strictEqual(F.trunc(long, 160), 'a'.repeat(159) + '😀…');
assert.doesNotThrow(() => JSON.parse(JSON.stringify(F.trunc(long, 160))));
console.log('js trunc ok');

// virtualized logs: rows unmounted while scrolling up are recovered from the earlier snapshot
const m = (...ids) => ids.map(i => ({ id: String(i), t: String(i) }));
assert.deepStrictEqual(F.mergeChunks(m(1, 2, 3, 4, 5), m(6, 7, 8)), m(1, 2, 3, 4, 5, 6, 7, 8)); // no overlap: concat
assert.deepStrictEqual(F.mergeChunks(m(1, 2, 3, 4, 5, 6), m(5, 6, 7, 8)), m(1, 2, 3, 4, 5, 6, 7, 8)); // overlap 5,6
assert.deepStrictEqual(F.mergeChunks(m(1, 2), m(1, 2)), m(1, 2));
assert.deepStrictEqual(F.mergeChunks([], m(1)), m(1));
console.log('js merge ok');

// identical repeated messages stay distinct when they carry ids
const mm = (...ids) => ids.map(id => ({ id, t: '10:00', text: 'ok' }));
assert.deepStrictEqual(F.mergeChunks(mm('a', 'b', 'c'), mm('c', 'd')), mm('a', 'b', 'c', 'd'));
assert.deepStrictEqual(F.mergeChunks(mm('a', 'b'), mm('c', 'd')), mm('a', 'b', 'c', 'd')); // same text, different ids: no false overlap
console.log('js ids ok');

// date separators must not break overlap detection
const D = d => ({ d });
const withDates = [D('Today'), ...mm('a', 'b', 'c')];
assert.deepStrictEqual(
  F.mergeChunks([D('Today'), ...mm('a', 'b', 'c')], [D('Today'), ...mm('b', 'c', 'd')]).map(m => m.id || m.d),
  ['Today', 'a', 'b', 'c', 'd']
);
assert.strictEqual(F.mergeChunks(withDates, withDates).length, 4);
console.log('js dates ok');

// messages that arrive while history loads extend the list instead of duplicating it
assert.deepStrictEqual(F.mergeChunks(mm('1', '2', '3', '4', '5', '6'), mm('1', '2', '3', '4', '5')).map(m => m.id), ['1', '2', '3', '4', '5', '6']); // newer inside older
assert.deepStrictEqual(F.mergeChunks(mm('1', '2', '3'), mm('2', '3', '4', '5')).map(m => m.id), ['1', '2', '3', '4', '5']);
assert.deepStrictEqual(F.mergeChunks(mm('1', '2', '3', '4'), mm('3', '4')).map(m => m.id), ['1', '2', '3', '4']);
console.log('js arrivals ok');

// rows without ids are never aligned by content (identical messages would be fabricated)
const same = () => [{ t: '10:00', text: 'ok' }, { t: '10:00', text: 'ok' }];
assert.strictEqual(F.mergeChunks(same(), same()).length, 2);
console.log('js id-less ok');

// a message unsent while history loads must not duplicate or resurrect rows
assert.deepStrictEqual(F.mergeChunks(m('1', '2', '4', '5'), m('3', '4', '5', '6')).map(x => x.id), ['1', '2', '4', '5', '6']);
console.log('js unsent-gap ok');

// per-message labels in the formats Messenger really uses (weekday/date/AM-PM variants)
const L = (...labels) => F.parseLabel(labels);
assert.deepStrictEqual(L('Lúc 18:38, Bạn: hi there', 'Hành động', 'Nhập, Tin nhắn do Bạn gửi lúc 18:38: hi there'), { t: '18:38', sender: 'Bạn', text: 'hi there' });
assert.deepStrictEqual(L('Lúc Thứ bảy 23:45ch, Bạn: round cuối', 'Nhập, Tin nhắn do Bạn gửi lúc Thứ bảy 23:45ch: round cuối'), { t: '23:45', sender: 'Bạn', text: 'round cuối' });
assert.deepStrictEqual(L('Lúc 15:33 12 Tháng 12, 2024, Bạn: a: b'), { t: '15:33', sender: 'Bạn', text: 'a: b' });
assert.deepStrictEqual(L('At 4:05 PM, Alice Smith: hello', 'Nhập, x'), { t: '4:05 PM', sender: 'Alice Smith', text: 'hello' });
assert.deepStrictEqual(L('Lúc 18:43, Bạn', 'Nhập, Tin nhắn do Bạn gửi lúc 18:43'), { t: '18:43', sender: 'Bạn', text: '' }); // attachment: no text
assert.deepStrictEqual(L('Nhập, Tin nhắn do Bạn gửi lúc 18:43: x'), { t: '', sender: '', text: '' }); // only the secondary label
// The timestamp itself can carry a comma: "At September 5, 2026, 10:24 PM, You: ...".
// The sender separator is the LAST ", " before the colon, never the date's own comma.
assert.deepStrictEqual(L('At September 5, 2026, 10:24 PM, You: Hello everyone, and thanks'), { t: '10:24 PM', sender: 'You', text: 'Hello everyone, and thanks' });
assert.deepStrictEqual(L('At December 12, 2024, 3:05 PM, Alice: hi'), { t: '3:05 PM', sender: 'Alice', text: 'hi' });
// attachment-only rows keep their sender and have no text
assert.deepStrictEqual(L('At September 5, 2026, 10:24 PM, You'), { t: '10:24 PM', sender: 'You', text: '' });
console.log('js labels ok');

// id-less rows: long varied overlaps are merged, ambiguous ones are never guessed
const k = (...t) => t.map(x => ({ t: '10:00', text: x }));
assert.deepStrictEqual(F.mergeChunks(k('a', 'b', 'c', 'd'), k('c', 'd', 'e')).map(x => x.text), ['a', 'b', 'c', 'd', 'e']);
assert.strictEqual(F.mergeChunks(k('ok', 'ok'), k('ok', 'ok', 'ok')).length, 5); // identical rows: no alignment guess
console.log('js id-less overlap ok');

// the previous newest message was removed while a new one arrived: it must not come back last
assert.deepStrictEqual(F.mergeChunks(m('1', '2', '4'), m('1', '2', '3')).map(x => x.id), ['1', '2', '4']);
console.log('js removed-newest ok');

// F.chats completeness: only a settled bottom of an uncapped scan may claim "that is everything"
(async () => {
  const mk = (total, lazy) => {
    let mounted = Math.min(total, 10), top = 0, grown = null;
    const row = i => ({
      text: ['Chat ' + i, 'hi', '·', '1h'],
      querySelector: q => (q.includes('a[') ? { getAttribute: k => (k === 'href' ? '/t/' + (1000 + i) + '/' : null) } : null),
    });
    const g = {
      parentElement: null,
      get scrollHeight() { return mounted * 100; },
      clientHeight: 500,
      get scrollTop() { return top; },
      set scrollTop(v) {
        top = Math.min(v, this.scrollHeight - 500);
        if (lazy && top + 500 >= this.scrollHeight - 2 && mounted < total && !grown)
          grown = setTimeout(() => { mounted = total; grown = null; }, 500);
        else if (!lazy) mounted = Math.min(total, mounted + 10);
      },
      querySelector: () => true,
      querySelectorAll: () => Array.from({ length: mounted }, (_, i) => row(i)),
    };
    return g;
  };
  const run = async (g, n) => {
    const F2 = { ...F, vtext: r => r.text };
    global.window = { __fb: F2 };
    global.document = { body: {}, documentElement: {}, querySelectorAll: () => [], querySelector: () => g };
    global.getComputedStyle = () => ({ overflowY: 'auto', fontWeight: '400' });
    new Function(fs.readFileSync(path.join(__dirname, '../js/msg.js'), 'utf8')).call(global.window);
    return F2.chats(n);
  };
  const full = await run(mk(25, false), 400);
  assert.strictEqual(full.chats.length, 25);
  assert.strictEqual(full.complete, true);
  const capped = await run(mk(31, false), 30);
  assert.strictEqual(capped.chats.length, 30);
  assert.strictEqual(capped.complete, false); // 31st row dropped: not the whole list
  const lazy = await run(mk(40, true), 400);
  assert.strictEqual(lazy.chats.length, 40); // pagination that lands after reaching the bottom is awaited
  assert.strictEqual(lazy.complete, true);
  console.log('js chats ok');

  // composer focus: Facebook keeps a hidden notifications dialog mounted, which must not block input;
  // a visible dialog still does
  const load = (dialogs, focused = false) => {
    const box = { focus() { global.document.activeElement = box; }, innerText: 'hi' };
    const F2 = { ...F, dismissRestore: async () => true, waitFor: async f => f() };
    global.window = { __fb: F2 };
    global.document = {
      activeElement: focused ? box : null,
      querySelectorAll: sel => (sel === '[role=dialog]' ? dialogs : []),
      querySelector: sel => (sel === '[role=textbox][contenteditable=true]' ? box : null),
    };
    new Function(fs.readFileSync(path.join(__dirname, '../js/msg.js'), 'utf8')).call(global.window);
    return F2;
  };
  const hidden = { getClientRects: () => [], isConnected: true };
  const shown = { getClientRects: () => [{}], isConnected: true };
  global.getComputedStyle = () => ({ visibility: 'visible' });
  const ok = load([hidden]);
  assert.strictEqual(await ok.focusComposer(), true);
  assert.strictEqual(ok.composerMatches('hi'), true);
  const blocked = load([hidden, shown]);
  await assert.rejects(blocked.focusComposer(), /dialog blocks input/);
  // a dialog that opens while the composer already holds focus and the right text must still stop the send
  assert.strictEqual(load([hidden], true).composerMatches('hi'), true);
  assert.strictEqual(load([hidden, shown], true).composerMatches('hi'), false);
  console.log('js composer dialog ok');

  // profile -> verified thread: a settings menu whose links load late is already open and must not be
  // pressed again (that closes it); a Message press made before hydration is ignored and repeated
  const pt = fs.readFileSync(path.join(__dirname, '../js/profile-thread.js'), 'utf8');
  const lookup = ({ hydratedAt, linksAfter }) => {
    let clock = 0, dock = false, menuOpen = false, openedAt = 0, settingsPresses = 0;
    const el = (attrs, extra = {}) => ({
      isConnected: true, parentElement: null, innerText: '', getClientRects: () => [{}],
      getAttribute: k => attrs[k] ?? null, matches: () => true, closest: () => null,
      querySelectorAll: () => [], ...extra,
    });
    const person = el({ href: '/profile.php?id=42' });
    const trigger = el({ role: 'button', 'aria-label': 'Message' });
    const settings = el({ role: 'button', 'aria-label': 'Chat settings' }, {
      getAttribute: k => (k === 'aria-label' ? 'Chat settings' : k === 'role' ? 'button' : null),
    });
    const box = el({});
    const popup = el({}, {
      querySelectorAll: sel => (sel === '[role=textbox][contenteditable=true]' ? [box] : sel === 'a[href]' ? [person] : []),
    });
    settings.parentElement = popup;
    const link = el({ href: '/messages/e2ee/t/777/' });
    const menu = el({}, {
      querySelectorAll: () => (clock - openedAt >= linksAfter ? [person, link] : []),
    });
    const F2 = {
      ...F,
      sleep: async ms => { clock += ms; },
      waitFor: async (f, ms) => { const end = clock + ms; for (;;) { const v = f(); if (v) return v; if (clock >= end) return null; clock += 100; } },
      press: e => {
        if (e === trigger && clock >= hydratedAt) dock = true;
        if (e === settings) { settingsPresses++; menuOpen = !menuOpen; if (menuOpen) openedAt = clock; }
      },
    };
    global.window = { __fb: F2 };
    global.location = { href: 'https://www.facebook.com/someone' };
    global.getComputedStyle = () => ({ visibility: 'visible' });
    global.document = {
      body: {},
      querySelectorAll: sel => {
        if (sel.startsWith('[role=main]')) return [trigger];
        if (sel.startsWith('[role=button][aria-label]')) return dock ? [settings] : [];
        if (sel === '[role=menu]') return menuOpen ? [menu] : [];
        return [];
      },
    };
    return new Function('return ' + pt)()('42').then(r => ({ r, settingsPresses }));
  };
  assert.deepStrictEqual(await lookup({ hydratedAt: 0, linksAfter: 0 }), { r: '/messages/e2ee/t/777/', settingsPresses: 1 });
  assert.deepStrictEqual(await lookup({ hydratedAt: 3000, linksAfter: 0 }), { r: '/messages/e2ee/t/777/', settingsPresses: 1 });
  assert.deepStrictEqual(await lookup({ hydratedAt: 0, linksAfter: 4500 }), { r: '/messages/e2ee/t/777/', settingsPresses: 1 });
  console.log('js profile thread ok');
})().catch(e => { console.error(e); process.exit(1); });


// post view: each comment's author reference comes only from that comment's own author link
(async () => {
  const vm = require('vm');
  class El {
    constructor(attrs = {}, text = []) { this.attrs = attrs; this.text = text; this.children = []; this.parentElement = null; }
    add(c) { c.parentElement = this; this.children.push(c); return c; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    matches(sel) {
      if (sel === 'a[href]') return this.attrs.tag === 'a' && this.attrs.href !== undefined;
      if (sel === '[role=article][aria-label]') return this.attrs.role === 'article' && this.attrs['aria-label'] !== undefined;
      const m = /^\[([^=]+)=([^\]]+)\]$/.exec(sel);
      return !!m && this.attrs[m[1]] === m[2];
    }
    querySelectorAll(sel) { return this.children.flatMap(c => [...(c.matches(sel) ? [c] : []), ...c.querySelectorAll(sel)]); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) { return this.matches(sel) ? this : this.parentElement?.closest(sel) || null; }
    flat() { return [this, ...this.children.flatMap(c => c.flat())]; }
    compareDocumentPosition(o) { const all = this.top().flat(); return all.indexOf(o) > all.indexOf(this) ? 4 : 2; }
    top() { return this.parentElement ? this.parentElement.top() : this; }
  }
  const link = (href, name) => new El({ tag: 'a', href }, name ? [name] : []);
  const comment = (author, authorHref, bodyLinks = [], replies = []) => {
    const a = new El({ role: 'article', 'aria-label': 'Comment by ' + author }, [author, '1h', 'Hello Bob', 'Like', 'Reply']);
    const head = a.add(new El());
    if (authorHref) head.add(link(authorHref, author));
    head.add(link('/fixture/posts/1?comment_id=9', '1h'));
    const body = a.add(new El());
    for (const h of bodyLinks) body.add(link(h, 'Bob'));
    for (const r of replies) a.add(r);
    return a;
  };
  const view = async (comments, n = comments.length) => {
    const root = new El({ role: 'main' }, ['Fixture Author', '1h']);
    root.add(new El()).add(new El()).add(new El({ 'data-ad-rendering-role': 'profile_name' }));
    for (const c of comments) root.add(c);
    const doc = new El(); doc.add(root);
    const ctx = vm.createContext({ window: {}, document: doc, location: { href: 'https://www.facebook.com/fixture/posts/1' }, Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, URL, setTimeout });
    vm.runInContext(src, ctx);
    const G = ctx.window.__fb;
    Object.assign(G, { sleep: async () => {}, waitFor: async f => f(), vtext: e => e?.text || [], num: () => 0, scrollerOf: () => null });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ops.js'), 'utf8'), ctx);
    return Array.from((await G.postView(n)).lines).filter(l => /^cu?\t/.test(l));
  };
  assert.deepStrictEqual(await view([comment('Alice', '/alice', ['/bob'])]), ['cu\t/alice', 'c\tAlice\t1h\tHello Bob']);
  assert.deepStrictEqual(await view([comment('Alice', '/people/Alice-Smith/61512345678901/')]), ['cu\t/profile.php?id=61512345678901', 'c\tAlice\t1h\tHello Bob']);
  assert.deepStrictEqual(await view([comment('Anonymous participant', null, ['/bob', 'https://example.org/stranger'])]), ['c\tAnonymous participant\t1h\tHello Bob']);
  assert.deepStrictEqual(await view([comment('Anonymous participant', null, [], [comment('Bob', '/bob')])], 1), ['c\tAnonymous participant\t1h\tHello Bob']);
  {
    const parent = new El({ role: 'article', 'aria-label': 'Comment by Alice' }, ['Alice', '1h', 'Hello', 'Like', 'Reply']);
    parent.add(comment('Alice', '/other.alice'));
    assert.deepStrictEqual(await view([parent], 1), ['c\tAlice\t1h\tHello']);
  }
  assert.deepStrictEqual(await view([comment('Bob', null, ['/different.bob'])]), ['c\tBob\t1h\tHello Bob']);
  assert.deepStrictEqual(await view([comment('Anonymous participant', 'https://l.facebook.com/l.php?u=x')]), ['c\tAnonymous participant\t1h\tHello Bob']);
  console.log('js post view comment refs ok');
})().catch(e => { console.error(e); process.exit(1); });

// message actions: msgTarget readiness and msgReact's receipt, against stub Messenger logs
(async () => {
  const vm = require('vm');
  const setup = rows => {
    const log = { querySelectorAll: () => rows, contains: e => e === log };
    const document = { body: { scrollHeight: 0 }, querySelector: q => (q === '[role=log]' ? log : null), querySelectorAll: () => [] };
    const ctx = vm.createContext({ window: { scrollTo() {} }, document, location: { href: 'https://www.facebook.com/messages/t/1' }, URL, setTimeout });
    vm.runInContext(src, ctx);
    const G = ctx.window.__fb;
    Object.assign(G, {
      sleep: async () => {},
      waitFor: async f => { for (let i = 0; i < 3; i++) { const v = await f(); if (v) return v; } return null; },
      press: e => e.onpress && e.onpress(),
    });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/msg.js'), 'utf8'), ctx);
    G.parseMessage = a => a.parsed;
    return { G, document };
  };
  const row = parsed => ({ parsed: { id: '', t: '', sender: '', text: '', att: '', re: '', ...parsed }, isConnected: true, querySelector: q => (q === '[aria-label]' ? {} : null) });
  const older = row({ id: 'm1', t: '10:00', sender: 'You', text: 'older loaded message' });

  // a newest row that only shows a toolbar label has no readable message yet: never fall back to the older one
  {
    const { G } = setup([older, row({ id: 'm2' })]);
    assert.strictEqual((await G.msgTarget('')).err, 'messages are still loading; try again');
  }
  // once the rows are readable the newest (or the newest match) is chosen
  {
    const newest = row({ id: 'm3', t: '10:02', sender: 'Bob', text: 'newest' });
    const { G } = setup([older, newest]);
    const t = await G.msgTarget('');
    assert.strictEqual(t.a, newest);
    assert.strictEqual(t.m.text, 'newest');
    const found = await setup([older, newest]).G.msgTarget('older');
    assert.strictEqual(found.a, older);
  }

  // msgReact: a newer message with identical sender and text must not be what the receipt checks
  const dup = parsed => row({ t: '10:00', sender: 'You', text: 'same text', ...parsed });
  const react = async (rows, mutate, name = 'love', emoji = '❤️', between = () => {}) => {
    const { G, document } = setup(rows);
    const target = rows[0];
    G.msgTarget = async () => ({ a: target, m: { ...target.parsed } });
    G.msgToolbarBtn = async () => ({ onpress() {} });
    const emojiBtn = { textContent: emoji, getAttribute: () => '', onpress: () => mutate(rows) };
    const toned = { textContent: emoji + '🏻', getAttribute: () => '', onpress: () => { throw new Error('wrong variant'); } };
    const picker = { getBoundingClientRect: () => ({ width: 10 }), querySelector: () => null, querySelectorAll: () => [toned, emojiBtn] };
    document.querySelectorAll = () => [picker];
    const opened = await G.msgReactOpen('', name);
    if (opened !== true) return opened;
    between(rows);
    return G.msgReactConfirm();
  };
  {
    const m1 = dup({ id: 'm1' }), m2 = dup({ id: 'm2' });
    const rows = [m1];
    const r = await react(rows, rs => { rs.push(m2); m1.parsed.re = '❤️'; });
    assert.strictEqual(r.text, 'reacted ❤️ to You: same text');
  }
  // the reaction landed on the newer duplicate only: ours stayed bare
  {
    const rows2 = [dup({ id: 'm1' })];
    const r2 = await react(rows2, rs => { const n = dup({ id: 'm2', re: '❤️' }); rs.push(n); });
    assert.strictEqual(r2, 'the reaction did not land on the message');
  }
  // skin-tone variants are other emoji: 👍🏻 already there, our 👍 added
  {
    const r = await react([dup({ id: 'm1', re: '👍🏻' })], rs => { rs[0].parsed.re = '👍🏻👍'; }, 'like', '👍');
    assert.strictEqual(r.text, 'reacted 👍 to You: same text');
  }
  // the baseline is read right before the click: others reacting while the picker is open do not count as ours
  {
    const r = await react([dup({ id: 'm1', re: '❤️' })], rs => { rs[0].parsed.re = '❤️2'; }, 'love', '❤️', rs => { rs[0].parsed.re = '❤️3'; });
    assert.strictEqual(r, 'the reaction did not land on the message');
  }
  // the message unmounted while the picker was open: no click, no false baseline
  {
    let clicks = 0;
    const r = await react([dup({ id: 'm1', re: '❤️2' })], () => { clicks++; }, 'love', '❤️', rs => rs.splice(0, 1));
    assert.strictEqual(r, 'the message is no longer on screen; nothing was changed');
    assert.strictEqual(clicks, 0);
  }
  // a picker offering only a skin-tone variant has no button for our emoji: nothing is clicked
  {
    const { G, document } = setup([dup({ id: 'm1' })]);
    G.msgTarget = async () => ({ a: dup({ id: 'm1' }), m: dup({ id: 'm1' }).parsed });
    G.msgToolbarBtn = async () => ({ onpress() {} });
    const toned = { textContent: '👍🏻', getAttribute: () => '', onpress: () => { throw new Error('wrong variant'); } };
    document.querySelectorAll = () => [{ getBoundingClientRect: () => ({ width: 10 }), querySelector: () => null, querySelectorAll: () => [toned] }];
    assert.strictEqual(await G.msgReactOpen('', 'like'), 'the reaction picker did not open');
  }
  // a skin-tone button whose label says "like" does not stand in for the neutral emoji button
  {
    const { G, document } = setup([dup({ id: 'm1' })]);
    G.msgTarget = async () => ({ a: dup({ id: 'm1' }), m: dup({ id: 'm1' }).parsed });
    G.msgToolbarBtn = async () => ({ onpress() {} });
    let pressed = '';
    const btn = (text, label) => ({ textContent: text, getAttribute: () => label, onpress: () => { pressed = text; } });
    document.querySelectorAll = () => [{ getBoundingClientRect: () => ({ width: 10 }), querySelector: () => null, querySelectorAll: () => [btn('👍🏻', 'Like'), btn('👍', 'Like')] }];
    assert.strictEqual(await G.msgReactOpen('', 'like'), true);
    await G.msgReactConfirm().catch(() => {});
    assert.strictEqual(pressed, '👍');
  }
  // opening the picker applies nothing: only the confirm step clicks the emoji
  {
    let clicks = 0;
    const rows = [dup({ id: 'm1' })];
    await react(rows, () => { clicks++; });
    assert.strictEqual(clicks, 1, 'confirm clicks once');
    const { G } = setup(rows);
    assert.strictEqual(await G.msgReactConfirm(), 'no reaction picker is open');
  }
  // without ids the selected row itself is checked while it is still mounted
  {
    const rows = [dup({})];
    const r = await react(rows, rs => { rs.push(dup({})); rs[0].parsed.re = '❤️'; });
    assert.strictEqual(r.text, 'reacted ❤️ to You: same text');
  }
  // without ids and with the row gone, a newer identical message is never taken for it
  {
    const rows = [dup({})];
    const r = await react(rows, rs => { rs[0].isConnected = false; rs.splice(0, 1, dup({ re: '❤️' })); });
    assert.strictEqual(r, 'the reaction did not land on the message');
  }
  // someone else's identical emoji does not confirm ours: the reactions must change
  {
    const rows = [dup({ id: 'm1', re: '❤️' })];
    assert.strictEqual(await react(rows, () => {}), 'the reaction did not land on the message');
    const r = await react([dup({ id: 'm1', re: '❤️' })], rs => { rs[0].parsed.re = '❤️2'; });
    assert.strictEqual(r.text, 'reacted ❤️ to You: same text');
    // an unrelated reaction or our own removal (❤️2 -> ❤️) is not a landed reaction either
    assert.strictEqual(await react([dup({ id: 'm1', re: '❤️' })], rs => { rs[0].parsed.re = '❤️👍'; }), 'the reaction did not land on the message');
    assert.strictEqual(await react([dup({ id: 'm1', re: '❤️2' })], rs => { rs[0].parsed.re = '❤️'; }), 'the reaction did not land on the message');
  }
  // an image that mounted before its message label is not a readable row yet
  {
    const { G } = setup([older, row({ id: 'm8', att: 'img' })]);
    assert.strictEqual((await G.msgTarget('older')).err, 'messages are still loading; try again');
  }
  // a newest voice message (readable row, no text) is not skipped for an older text message
  {
    const voice = row({ id: 'm9', t: '10:05', sender: 'Bob' });
    const { G } = setup([older, voice]);
    assert.strictEqual((await G.msgTarget('')).err, 'the newest message has no readable text; nothing was changed');
    assert.strictEqual((await setup([older, voice]).G.msgTarget('older')).a, older);
  }
  // msgReplyOpen: only a quote that appears after the Reply click confirms it
  {
    const { G, document } = setup([older]);
    G.msgTarget = async () => ({ a: older, m: older.parsed });
    const el = (text, wraps) => ({ children: [], textContent: text, contains: () => wraps, getBoundingClientRect: () => ({ width: 5 }) });
    const reply = async (before, after) => {
      let clicked = false;
      G.msgToolbarBtn = async () => ({ onpress() { clicked = true; } });
      document.querySelectorAll = () => (clicked ? [...before, ...after] : before);
      return G.msgReplyOpen('');
    };
    const none = 'the reply quote did not appear above the message box';
    const preview = el('replying to the plan', false);
    // a wrapper around the log, or a sidebar preview that was already there, is not the composer quote
    assert.strictEqual(await reply([], [el('replying to the plan', true)]), none);
    assert.strictEqual(await reply([preview], []), none);
    assert.strictEqual((await reply([preview], [el('You are replying to: older loaded message', false)])).text, 'replying to You: older loaded message');
  }
  console.log('js message actions ok');
})().catch(e => { console.error(e); process.exit(1); });
// members: profile links go through profilePath, and details that render after the name are merged in
(async () => {
  const vm = require('vm');
  class El {
    constructor(attrs = {}, text = []) { this.attrs = attrs; this.text = text; this.children = []; this.parentElement = null; }
    add(c) { c.parentElement = this; this.children.push(c); return c; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    get innerText() { return this.text.filter(x => !x.hidden).join(' '); }
    getClientRects() { return this.attrs.hidden ? [] : [{}]; }
    closest(sel) { const m = /^\[([^=]+)=([^\]]+)\]$/.exec(sel); for (let e = this; e; e = e.parentElement) if (m && e.attrs[m[1]] === m[2]) return e; return null; }
    anchors() { return this.children.flatMap(c => [...(c.attrs.href !== undefined ? [c] : []), ...c.anchors()]); }
  }
  const run = async (build, n = 10) => {
    const main = new El({ role: 'main' });
    const scans = build(main);
    scans.next();
    const doc = { querySelector: () => (main.anchors()[0] || null), querySelectorAll: () => main.anchors() };
    const ctx = vm.createContext({ window: { scrollBy: () => scans.next() }, document: doc, location: { href: 'https://www.facebook.com/groups/1/members' }, URL, setTimeout, Date, innerHeight: 800, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) });
    vm.runInContext(src, ctx);
    const G = ctx.window.__fb;
    Object.assign(G, { sleep: async () => {}, waitFor: async f => f(), vtext: (e, visibleOnly) => e.text.filter(x => !(visibleOnly && x.hidden)).map(x => x.hidden ? x.t : x) });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ops.js'), 'utf8'), ctx);
    return JSON.parse(JSON.stringify((await G.groupMembers(n)).rows));
  };
  const item = (main, href, name, ...info) => { const li = main.add(new El({ role: 'listitem' }, [...name.split(' '), ...info])); li.add(new El({ href }, name.split(' '))); return li; };
  const rows = await run(function* (main) {
    main.add(new El({ href: '/ghost.user', hidden: true }, ['Ghost']));
    const alice = item(main, '/alice.smith', 'Alice Smith');
    alice.add(new El({ href: '/added.by' }, ['Added by Carol']));
    item(main, '/people/Bob-Jones/61512345678901/', 'Bob Jones', 'Member');
    item(main, '/groups/1/posts/5', 'Some Post');
    item(main, 'https://example.org/stranger', 'Stranger');
    yield;
    alice.text = ['Alice', 'Smith', { hidden: true, t: 'Ghost' }, 'Admin', 'Added by Carol'];
    while (true) yield;
  });
  assert.deepStrictEqual(rows, [
    ['Alice Smith', { r: 'u', v: '/alice.smith' }, 'Admin · Added by Carol'],
    ['Bob Jones', { r: 'u', v: '/profile.php?id=61512345678901' }, 'Member'],
  ]);
  // a virtualized list reuses a card element for the next member
  const recycled = await run(function* (main) {
    const li = item(main, '/alice.smith', 'Alice Smith');
    yield;
    li.children[0].attrs.href = '/bob.jones'; li.children[0].text = ['Bob', 'Jones']; li.text = ['Bob', 'Jones', 'Member'];
    while (true) yield;
  }, 2);
  assert.deepStrictEqual(recycled, [
    ['Alice Smith', { r: 'u', v: '/alice.smith' }, ''],
    ['Bob Jones', { r: 'u', v: '/bob.jones' }, 'Member'],
  ]);
  console.log('js members ok');
})().catch(e => { console.error(e); process.exit(1); });

// search result kinds: exact route segments and query keys decide, not substrings
(() => {
  const vm = require('vm');
  const ctx = vm.createContext({ window: {}, document: {}, location: { href: 'https://www.facebook.com/' }, URL, setTimeout });
  vm.runInContext(src, ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ops.js'), 'utf8'), ctx);
  const { kindOf } = ctx.window.__fb;
  for (const [href, kind] of [
    ['/photoshop', null],
    ['/watchmaker', null],
    ['/photo/?fbid=99&set=a.1', 'photo'],
    ['/photo.php?fbid=100', 'photo'],
    ['/alice/photos/a.1/2', 'photo'],
    ['/permalink.php?story_fbid=123&id=456', 'post'],
    ['/events/999/permalink/123/', 'post'],
    ['/alice/posts/pfbid0X', 'post'],
    ['/groups/1/posts/5', 'post'],
    ['/groups/hikers', 'group'],
    ['/groups/hikers/', 'group'],
    ['/watch/?v=654', 'video'],
    ['/alice/videos/77', 'video'],
    ['/reel/88', 'video'],
    ['/events/999', 'event'],
    ['/marketplace/item/555', 'listing'],
    ['/fixture-page', null],
  ]) assert.strictEqual(kindOf(href), kind, href);
  console.log('js search kinds ok');
})();
