// Pure-function checks for the injected page scripts. Run: node tests/js.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.window = { };
global.document = { querySelectorAll: () => [], querySelector: () => null };
global.location = { href: 'https://www.facebook.com/' };
global.URL = URL;
// A loader Facebook draws on screen; pageLoading ignores 0x0 ones.
const LOADER = { getBoundingClientRect: () => ({ width: 24, height: 24 }) };

const src = fs.readFileSync(path.join(__dirname, '../js/lib.js'), 'utf8');
new Function(src).call(global.window);
const F = global.window.__fb;

// A redirect must never turn a requested group post into a profile post.
{
  const vm = require('vm');
  const G = {};
  const location = { pathname: '/groups/111/' };
  const ctx = vm.createContext({ window: { __fb: G }, location });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/act.js'), 'utf8'), ctx);
  assert.strictEqual(G.composeGroupCheck('/groups/111'), true);
  location.pathname = '/fixture';
  assert.match(G.composeGroupCheck('/groups/111'), /selected group.*nothing was posted/);
  location.pathname = '/groups/222';
  assert.match(G.composeGroupCheck('/groups/111'), /selected group.*nothing was posted/);
  const hidden={querySelector:()=>({}),closest:()=>({})},visible={querySelector:()=>({}),closest:()=>null};
  ctx.document={querySelectorAll:()=>[hidden,visible]};
  ctx.window.__fbPostGroup='/groups/111';
  G.visible=()=>true;
  assert.strictEqual(G.composeDialog(),visible,'all group composer steps ignore retained hidden dialogs');
}

// A scan resumes after its time budget even when earlier rows were virtualized away.
(async () => {
  const vm = require('vm');
  let now=0, batch=1;
  const anchor=()=>({innerText:'Group '+batch,getAttribute:()=>'/groups/'+batch,getClientRects:()=>[{}]});
  const G={pageLoading:()=>false,clean:s=>String(s||'').trim(),groupPath:s=>s,addGroup:(m,k,lines)=>m.set(k,{name:lines[0],info:[]}),trunc:s=>s,
    waitFor:async f=>f(),sleep:async ms=>{if(ms===220)now+=15000;}};
  const ctx=vm.createContext({window:{__fb:G,scrollY:0,innerHeight:800,scrollBy:()=>batch++},document:{documentElement:{scrollHeight:100000},querySelector:()=>({}),querySelectorAll:()=>[anchor()]},
    Date:{now:()=>now},innerHeight:800,getComputedStyle:()=>({visibility:'visible',display:'block'})});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../js/ops.js'),'utf8'),ctx);
  const first=await G.groups(10,true),second=await G.groups(10,true);
  assert(second.rows.length>first.rows.length,'Load more advances beyond the per-call time budget');
  assert.deepStrictEqual(Array.from(second.rows.slice(0,first.rows.length),r=>r[1]),Array.from(first.rows,r=>r[1]),'keep rows virtualized out of the DOM');
})().catch(e=>{console.error(e);process.exitCode=1;});



// Facebook can replace the composer node while mounting the audience picker.
// Only the picker's explicit Done action may be pressed, never the Post button.
(async () => {
  const vm = require('vm');
  async function choose(hasDone, hidden = false, nested = false) {
    let opened = false, finished = false, selected = false, posted = false, donePressed = false;
    const audience = { get innerText() { return finished ? 'Public' : 'Friends'; },
      getAttribute: () => 'Edit privacy. Sharing with friends.', click: () => { opened = true; } };
    const post = { innerText: 'Post', getAttribute: () => 'Post', click: () => { posted = true; } };
    const done = { innerText: 'Done', getAttribute: () => 'Done', click: () => { assert(selected); donePressed = true; finished = true; } };
    const option = { innerText: 'Public\nAnyone on or off Facebook', visible: true, closest: () => hidden ? {} : null,
      getAttribute: () => null, contains: () => false, click: () => { selected = true; } };
    const old = { querySelector: () => null, querySelectorAll: s => s === '[role=button]' ? [audience, post] : [] };
    const wrapper = { innerText: option.innerText, contains: e => e === option };
    const picker = { querySelector: () => null, querySelectorAll: s => s.includes('[role=button]') ? hasDone ? [done, post] : [post] : nested ? [wrapper, option] : [option] };
    const G = { clean: s => String(s || '').trim(), vtext: () => [], visible: e => e.visible !== false,
      enabled: () => true, sleep: async () => {}, waitFor: async f => f() };
    const ctx = vm.createContext({ window: { __fb: G }, document: { querySelectorAll: () => opened && !finished ? [picker] : [old] } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/act.js'), 'utf8'), ctx);
    G.composeDialog = () => old;
    const result = await G.composeAudience('public');
    assert.strictEqual(posted, false, 'audience selection must never publish');
    assert.strictEqual(donePressed, hasDone && !hidden);
    return result;
  }
  assert.strictEqual(await choose(true), true, 'find Public in the replacement picker');
  assert.strictEqual(await choose(true, false, true), true, 'one nested radio and label is one audience option');
  assert.notStrictEqual(await choose(false), true, 'missing Done must fail safely');
  assert.notStrictEqual(await choose(true, true), true, 'ignore a hidden audience option');
  console.log('js audience replacement dialog ok');
})().catch(e => { console.error(e); process.exit(1); });

// A picker language the label sets miss: Public is first, Friends second, Only me the
// choice without a description line, and the audience button must show the pick.
(async () => {
  const vm = require('vm');
  async function pick(kind, shown) {
    let opened = false, finished = false, picked = null;
    const labels = ['Публично\nВсеки', 'Приятели\nВашите приятели', 'Близки приятели\nСписък', 'Само аз'];
    const options = labels.map(t => ({ innerText: t, closest: () => null, getAttribute: () => null,
      contains: () => false, click() { picked = t.split('\n')[0]; } }));
    const audience = { get innerText() { return finished ? (shown || picked) : 'Нещо'; },
      getAttribute: () => 'Edit privacy.', click: () => { opened = true; } };
    const done = { innerText: 'Готово', getAttribute: () => null, click: () => { finished = true; } };
    const old = { querySelector: () => null, querySelectorAll: s => s === '[role=button]' ? [audience] : [] };
    const picker = { querySelector: () => null, querySelectorAll: s => s.includes('[role=button]') ? [done] : options };
    const G = { clean: s => String(s || '').trim(), vtext: () => [], visible: () => true,
      enabled: () => true, sleep: async () => {}, waitFor: async f => f() };
    const ctx = vm.createContext({ window: { __fb: G }, document: { querySelectorAll: () => opened && !finished ? [picker] : [old] } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/act.js'), 'utf8'), ctx);
    G.composeDialog = () => old;
    return [await G.composeAudience(kind), picked];
  }
  assert.deepStrictEqual(await pick('public'), [true, 'Публично']);
  assert.deepStrictEqual(await pick('friends'), [true, 'Приятели']);
  assert.deepStrictEqual(await pick('me'), [true, 'Само аз']);
  assert.notStrictEqual((await pick('friends', 'Публично'))[0], true, 'a button that does not show the pick must fail');
  console.log('js audience unknown language ok');
})().catch(e => { console.error(e); process.exit(1); });


// Relationship menus may mount before their items. Preparation must never follow
// anyone: the caller checks cancellation before the separate synchronous press.
(async () => {
  const vm = require('vm');
  let now = 0, openedAt = 0, opened = false, pressed = 0, pendingLabel = 'Follow', cards = [];
  const item = { get innerText() { return pendingLabel; }, isConnected: true };
  const menu = { querySelectorAll: () => now - openedAt >= 100 ? [item] : [] };
  const options = { innerText: 'Options', closest: () => null };
  const header = { contains: () => true, querySelector: () => null };
  const tabs = { parentElement: header, contains: () => false, compareDocumentPosition: () => 4 };
  const main = { querySelector: () => tabs, querySelectorAll: () => [options] };
  const G = {
    clean: s => s.trim(), vtext: () => [], visible: () => true, enabled: () => true,
    postCards: () => cards, sleep: async ms => { now += ms; },
    waitFor: async (f, ms, step = 100) => {
      for (const end = now + ms; now <= end; now += step) { const v = await f(); if (v) return v; }
      return null;
    },
    press: b => { if (b === options) { opened = true; openedAt = now; } else { assert.strictEqual(b, item); pressed++; } },
  };
  const body = { dispatchEvent: () => { opened = false; } };
  const ctx = vm.createContext({ window: { __fb: G },
    document: { body, querySelector: () => main, querySelectorAll: () => opened ? [menu] : [] },
    Node: { DOCUMENT_POSITION_PRECEDING: 2 }, KeyboardEvent: class {}, Date: { now: () => now },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/act.js'), 'utf8'), ctx);
  assert.strictEqual(await G.followState(), 'can-follow', 'wait for a delayed Follow item');
  assert.strictEqual(pressed, 0, 'reading state changes no relationship');
  assert.strictEqual(await G.followPrepare(true), 'ready');
  assert.strictEqual(pressed, 0, 'cancel after preparation by omitting the press');
  pendingLabel = 'Unfollow';
  assert.notStrictEqual(G.followPress(), 'pressed', 'reject a changed prepared action');
  assert.strictEqual(pressed, 0);
  pendingLabel = 'Follow';
  assert.strictEqual(await G.followPrepare(true), 'ready');
  assert.strictEqual(G.followPress(), 'pressed');
  assert.strictEqual(pressed, 1);
  assert.notStrictEqual(G.followPress(), 'pressed', 'consume the prepared action once');
  opened = false;
  cards = [{}];
  assert.strictEqual(await G.followState(), 'no-follow', 'exclude menus beside role-less posts');
  assert.strictEqual(opened, false, 'never open a post menu as a relationship menu');
  console.log('js follow preparation ok');
})().catch(e => { console.error(e); process.exit(1); });

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
  // post-menu (#56 review): a card Facebook reuses for another post during the press's
  // pointer events fails the walk's identity check, so the click never reaches it.
  {
    let same = true;
    const actions = button('div', 'Actions for this post');
    actions.onEvent = type => { if (type === 'pointerover') same = false; };
    assert.throws(() => G.press(actions, { valid: () => same }), /action target changed/);
    assert.deepEqual(actions.events, ['pointerover']);
  }
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
  // a control wrapping an editor names no draft text in the diagnostics
  const wrapper = Object.assign(button('div', 'Public action PRIVATE_NESTED_DRAFT'), {
    getAttribute(name) { return name === 'role' ? 'button' : null; },
    querySelector: sel => (sel.includes('contenteditable') ? {} : null),
  });
  buttons = [button('div', 'Share note'), wrapper];
  const nested = await G.composePrepare();
  assert.match(nested, /Share note/);
  assert(!nested.includes('PRIVATE_NESTED_DRAFT'), 'diagnostics must not expose a nested draft: ' + nested);
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
  // Audience labels for every language the Post button list knows
  // (BlindFB #20: a Czech/Slovak interface matched none of them).
  for (const t of ['Public', 'Publique', 'Veřejné', 'Verejné', 'Publiczne', 'Öffentlich', 'Público', 'Доступно всем'])
    assert(G.AUD.public.test(t), 'AUD public should match: ' + t);
  for (const t of ['Friends', 'Amis', 'Přátelé', 'Priatelia', 'Znajomi', 'Freunde', 'Друзья', 'Kaverit'])
    assert(G.AUD.friends.test(t), 'AUD friends should match: ' + t);
  for (const t of ['Only me', 'Moi uniquement', 'Jen já', 'Len ja', 'Iba ja', 'Tylko ja', 'Nur ich', 'Только я', 'Vain minä'])
    assert(G.AUD.me.test(t), 'AUD me should match: ' + t);
  assert(!G.AUD.friends.test('Friends except…'), 'AUD must not match a different audience');
  assert(!G.AUD.public.test('Friends'), 'AUD public must not match Friends');
  console.log('js audience labels ok');
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
assert.strictEqual(F.clean('AH.FM Accounts with a verified badge have been authenticated and can be Meta Verified subscribers or notable persons or brands. is with Tiësto'), 'AH.FM Verified is with Tiësto');
// a group post's profile_name: the poster, then a Follow button
const follow = { innerText: 'Follow' };
assert.strictEqual(F.profileName({ innerText: 'Parker Hankins\n \n·\nFollow', querySelectorAll: () => [follow] }), 'Parker Hankins');
assert.strictEqual(F.profileName({ innerText: 'Fixture User', querySelectorAll: () => [] }), 'Fixture User');
assert.strictEqual(F.groupPath('https://www.facebook.com/groups/123456/'), '/groups/123456');
assert.strictEqual(F.groupPath('/groups/hikers.uk?__cft__[0]=x'), '/groups/hikers.uk');
assert.strictEqual(F.groupPath('https://www.facebook.com/groups/123/posts/456'), null);
assert.strictEqual(F.groupPath('https://www.facebook.com/groups/feed/'), null);
assert.strictEqual(F.groupPath('https://www.facebook.com/groups/joins'), null);
assert.strictEqual(F.groupPath('https://www.facebook.com/somepage'), null);
console.log('js groupPath ok');
assert.strictEqual(F.profilePath('https://www.facebook.com/some.user'), '/some.user');
assert.strictEqual(F.profilePath('/profile.php?id=123&sk=about'), '/profile.php?id=123');
assert.strictEqual(F.profilePath('https://www.facebook.com/groups/123456'), null);
assert.strictEqual(F.profilePath('https://www.facebook.com/groups/123456/user/789/'), '/profile.php?id=789');
assert.strictEqual(F.profilePath('https://www.facebook.com/some.user/posts/456'), null);
assert.strictEqual(F.profilePath('https://www.facebook.com/watch?v=1'), null);
assert.strictEqual(F.profilePath('https://www.facebook.com/photo.php?fbid=1'), null);
console.log('js profilePath ok');
// Comment links: unwrap the redirect, drop people/permalinks/hashtags and
// unrevealed targets, strip trackers, dedupe (BlindFB comment link browsing).
assert.deepStrictEqual(F.commentLinks([
  {href: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com%2Fstory%3Fa%3D1&h=xyz', raw: 'https://l.facebook.com/l.php?u=x', text: 'example.com/story'},
  {href: 'https://othersite.org/page?fbclid=zz&keep=1', raw: 'https://othersite.org/page?fbclid=zz&keep=1', text: 'Other Site'},
  {href: 'https://othersite.org/page?keep=1', raw: 'https://othersite.org/page?keep=1', text: 'dupe'},
  {href: 'https://www.facebook.com/some.user', raw: '/some.user', text: 'Some User'},
  {href: 'https://www.facebook.com/fixture/posts/100?comment_id=555', raw: '/fixture/posts/100?comment_id=555', text: '2h'},
  {href: 'https://www.facebook.com/hashtag/news', raw: '/hashtag/news', text: '#news'},
  {href: 'https://www.facebook.com/fixture/posts/100?__cft__[0]=q', raw: '?__cft__[0]=q', text: 'unrevealed'},
  {href: 'https://www.facebook.com/photo/?fbid=99&__cft__[0]=z', raw: '/photo/?fbid=99', text: ''},
]), [
  {label: 'example.com/story', url: 'https://example.com/story?a=1'},
  {label: 'Other Site', url: 'https://othersite.org/page?keep=1'},
  {label: 'www.facebook.com', url: 'https://www.facebook.com/photo/?fbid=99'},
]);
console.log('js commentLinks ok');
assert.strictEqual(F.trunc('abcdef', 3), 'abc…');
assert(F.ACT.test('Thích') && F.ACT.test('Reply') && !F.ACT.test('Hello'));
// A French Facebook account (labels seen live, see BlindFB docs/fr-labels.md).
for (const t of ['il y a 10 heures', '8 h', '1 j', '1 sem.', '7 sem.', '2 ans', 'À l’instant', 'Aujourd’hui à 14:05', 'Hier à 9:00', 'lundi à 10:00', '1er janv.', '12 mars 2024'])
  assert(F.TIME.test(t), 'TIME should match: ' + t);
for (const t of ['J’aime', "J'aime", 'Répondre', 'Partager', 'Modifié', 'Voir la traduction'])
  assert(F.ACT.test(t), 'ACT should match: ' + t);
assert.strictEqual(F.clean('Oh My Mag Les comptes avec un badge Vérifié ont été authentifiés. Il peut s’agir d’abonnés Meta Verified ou de personnes ou de marques notables.'), 'Oh My Mag Verified');
assert.strictEqual(F.clean('4\u202f890\u00a0€'), '4 890 €');
const count = text => F.num({parentElement: {parentElement: {innerText: text}}});
// a newline or tab inside a counter would split TSV records: not a count
for (const t of ['1,9\nK', '4\t890']) assert.strictEqual(count(t), '0', 'count ' + JSON.stringify(t));
// an author named like a weekday or "today" is not a timestamp
for (const t of ['Lundi Matin', 'Aujourd’hui en France', 'Dimanche soir']) assert(!F.TIME.test(t), 'TIME must not match: ' + t);
for (const t of ['lundi à 10:00', 'Aujourd’hui à 14:05']) assert(F.TIME.test(t), 'TIME should match: ' + t);
// comment-link UI filters apply to Facebook only: external pages keep these shapes
assert.deepStrictEqual(F.commentLinks([
  {href: 'https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.org%2Fstory%3Fcomment_id%3D42&h=x', raw: 'https://l.facebook.com/l.php?u=x', text: 'story'},
  {href: 'https://www.tiktok.com/hashtag/cats', raw: 'https://www.tiktok.com/hashtag/cats', text: '#cats on TikTok'},
  {href: 'https://www.facebook.com/hashtag/news', raw: '/hashtag/news', text: '#news'},
]), [
  {label: 'story', url: 'https://example.org/story?comment_id=42'},
  {label: '#cats on TikTok', url: 'https://www.tiktok.com/hashtag/cats'},
]);
for (const t of ['28', '1.2K', '1,9 K', '40,1\u00a0K', '4\u202f890']) assert.strictEqual(count(t), t, 'count ' + t);
assert.strictEqual(count('28 réactions'), '0');
console.log('js french ok');
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
})().then(async () => {
  // pageLoading: Facebook's three in-flight markers, and only those
  const spinRoot = { querySelectorAll: s => (s.includes('progressbar') ? [LOADER] : []) };
  const busyRoot = { querySelectorAll: s => (s.includes('aria-busy') ? [LOADER] : []) };
  const calmRoot = { querySelectorAll: () => [] };
  // Facebook keeps a 0x0 progressbar mounted on finished pages (notifications):
  // counting it held every list read to its full time cap.
  const idleRoot = { querySelectorAll: () => [{ getBoundingClientRect: () => ({ width: 0, height: 0 }) }] };
  assert.strictEqual(F.pageLoading(spinRoot), true);
  assert.strictEqual(F.pageLoading(busyRoot), true);
  assert.strictEqual(F.pageLoading(calmRoot), false);
  assert.strictEqual(F.pageLoading(idleRoot), false);
  console.log('js pageLoading ok');

  const opsSrc = fs.readFileSync(path.join(__dirname, '../js/ops.js'), 'utf8');
  const F2 = { ...F };
  global.window = { __fb: F2 };
  new Function(opsSrc).call(global.window);

  // places: the directory's city links (href shapes verified live
  // 2026-11-08) become rows; the directory root and other hubs do not
  assert.strictEqual(F2.placePath('https://www.facebook.com/places/Things-to-do-in-Toronto-Ontario/110941395597405/'), '/places/Things-to-do-in-Toronto-Ontario/110941395597405');
  assert.strictEqual(F2.placePath('/places/Things-to-do-in-St-Catharines/108098952555359'), '/places/Things-to-do-in-St-Catharines/108098952555359');
  assert.strictEqual(F2.placePath('https://www.facebook.com/places/'), null);
  assert.strictEqual(F2.placePath('https://www.facebook.com/events/123/'), null);
  console.log('js places ok');

  // gather() (via F.friends): pagination that lands 1.2 s after the
  // scroller reaches the bottom, with a progressbar up the whole time,
  // belongs in the result. The settled-bottom exit must not fire while
  // the page is loading, and neither may the stall tail.
  const mkList = (total, lazyDelay) => {
    let mounted = Math.min(total, 10), pending = null;
    const state = { loading: false };
    const anchor = (href, text) => ({ href, innerText: text, getAttribute: k => (k === 'href' ? href : null) });
    const docEl = { get scrollHeight() { return mounted * 100; } };
    const doc = {
      documentElement: docEl, body: {},
      querySelector: sel => {
        if (sel.includes('progressbar')) return state.loading ? {} : null;
        if (sel.includes('friends_mutual')) return anchor('https://www.facebook.com/friend0/friends_mutual', 'x');
        return null;
      },
      querySelectorAll: sel => {
        if (sel.includes('progressbar')) return state.loading ? [LOADER] : [];
        if (sel.includes('friends_mutual')) return Array.from({ length: mounted }, (_, i) => anchor('https://www.facebook.com/friend' + i + '/friends_mutual', '3 mutual friends'));
        if (sel.includes('a[href]')) return Array.from({ length: mounted }, (_, i) => anchor('https://www.facebook.com/friend' + i, 'Friend ' + i));
        return [];
      },
    };
    const win = { __fb: F2, scrollY: 0, innerHeight: 500 };
    win.scrollBy = (x, dy) => {
      win.scrollY = Math.min(win.scrollY + dy, Math.max(0, docEl.scrollHeight - 500));
      if (lazyDelay && win.scrollY + 500 >= docEl.scrollHeight - 2 && mounted < total && !pending) {
        state.loading = true;
        pending = setTimeout(() => { mounted = total; state.loading = false; pending = null; }, lazyDelay);
      }
    };
    return { doc, win };
  };
  const runFriends = async (total, lazyDelay) => {
    const { doc, win } = mkList(total, lazyDelay);
    global.document = doc; global.window = win; global.innerHeight = 500;
    const t0 = Date.now();
    const r = await F2.friends(400);
    return { rows: r.rows.length, elapsed: Date.now() - t0 };
  };
  const lazy = await runFriends(25, 1200);
  assert.strictEqual(lazy.rows, 25, 'delayed pagination was truncated: ' + JSON.stringify(lazy));
  const settled = await runFriends(10, 0);
  assert.strictEqual(settled.rows, 10);
  assert(settled.elapsed < 3000, 'a settled list should exit on the bottom test, not the stall tail: ' + settled.elapsed);
  console.log('js gather loading ok');

  // searchFriends: the chip reports aria-pressed the moment it is tapped,
  // 1.2 s before the filtered results land. The read must wait for the
  // results themselves; F.search is stubbed to record whether the
  // stranger row was still on the page when the read started.
  let stranger = true, chipLoading = false, pressed = false;
  const chip = {
    innerText: 'Friends',
    getAttribute: k => (k === 'aria-pressed' ? (pressed ? 'true' : 'false') : null),
    click: () => { pressed = true; chipLoading = true; setTimeout(() => { stranger = false; chipLoading = false; }, 1200); },
  };
  const feedEl = { querySelector: () => null, querySelectorAll: () => [] };
  global.document = {
    querySelectorAll: sel => (sel.includes('[role=button]') ? [chip] : sel.includes('progressbar') && chipLoading ? [LOADER] : []),
    querySelector: sel => {
      if (sel.includes('progressbar')) return chipLoading ? {} : null;
      if (sel.includes('[data-stranger]')) return stranger ? {} : null;
      if (sel.includes('[role=feed]')) return feedEl;
      return null;
    },
  };
  global.window = { __fb: F2 };
  F2.search = async () => ({ rows: [], strangerAtRead: stranger });
  const t0 = Date.now();
  const sr = await F2.searchFriends(5);
  assert.strictEqual(sr.strangerAtRead, false, 'search read results before the friends filter applied');
  assert(Date.now() - t0 >= 1000, 'searchFriends returned before the delayed filter landed');
  console.log('js searchFriends ok');

  // atEnd: a pinned window is only the end when nothing is loading
  let feedLoading = false;
  global.document = {
    documentElement: { scrollHeight: 2000 }, body: { scrollHeight: 2000 },
    querySelector: sel => (sel.includes('progressbar') ? (feedLoading ? {} : null) : null),
    querySelectorAll: sel => (sel.includes('progressbar') && feedLoading ? [LOADER] : []),
  };
  global.window = { __fb: F, scrollY: 1500, innerHeight: 500 };
  new Function(fs.readFileSync(path.join(__dirname, '../js/feed.js'), 'utf8')).call(global.window);
  assert.deepStrictEqual(global.window.__fbFeed.atEnd(), { bottom: true, h: 2000, loading: false });
  feedLoading = true;
  assert.strictEqual(global.window.__fbFeed.atEnd().loading, true);
  console.log('js atEnd ok');

  // feed step: a group post's author ref is the poster's profile path, not
  // the group link, and not the group name merged into the author name
  global.Node = { DOCUMENT_POSITION_FOLLOWING: 4 };
  const anchor = (href, position = 4) => ({ getAttribute: n => (n === 'href' ? href : null), compareDocumentPosition: () => position });
  const userAnchor = anchor('https://www.facebook.com/groups/123/user/456/');
  const profileEl = { innerText: 'Michal Suchy', querySelector: sel => (sel === 'a' ? userAnchor : null), closest: () => null };
  const msgEl = { querySelectorAll: () => [] };
  const card = {
    querySelector: sel => (sel.includes('profile_name') ? profileEl : sel.includes('story_message') ? msgEl : null),
    querySelectorAll: sel => (sel === 'a[href]'
      ? [anchor('https://www.facebook.com/groups/123'), userAnchor, anchor('https://www.facebook.com/groups/123/posts/999')]
      : sel.includes('profile_name') ? [profileEl] : []),
    getAttribute: () => null,
  };
  const F3 = { ...F, postCards: () => [card], postText: () => 'Hello group', vtext: () => ['Michal Suchy', 'Odyssey Group', '2h'], num: () => '0', visible: () => true };
  global.document = { createTreeWalker: () => ({ nextNode: () => null }), querySelectorAll: () => [], querySelector: () => null };
  global.NodeFilter = { SHOW_TEXT: 4 };
  global.window = { __fb: F3 };
  new Function(fs.readFileSync(path.join(__dirname, '../js/feed.js'), 'utf8')).call(global.window);
  const stepped = await global.window.__fbFeed.step();
  assert.strictEqual(stepped.length, 1);
  assert.strictEqual(stepped[0].author, 'Michal Suchy / Odyssey Group');
  assert.strictEqual(stepped[0].aref, '/profile.php?id=456');

  // a profile mentioned in the message is not the author: an unlinked author has no ref
  const mentionEl = { innerText: 'Michal Suchy', querySelector: () => null, closest: () => null };
  const mentionCard = {
    querySelector: sel => (sel.includes('profile_name') ? mentionEl : sel.includes('story_message') ? msgEl : null),
    querySelectorAll: sel => (sel === 'a[href]'
      ? [anchor('https://www.facebook.com/groups/123'), anchor('https://www.facebook.com/bob', 2)]
      : sel.includes('profile_name') ? [mentionEl] : []),
    getAttribute: () => null,
  };
  global.window = { __fb: { ...F3, postCards: () => [mentionCard] } };
  new Function(fs.readFileSync(path.join(__dirname, '../js/feed.js'), 'utf8')).call(global.window);
  assert.strictEqual((await global.window.__fbFeed.step())[0].aref, '');
  console.log('js feed author ref ok');

  // feed step: when neither the scrambled-span decode nor the visible
  // chunks carry a time, the timestamp link's own text is the time
  // (BlindFB issue #16: the details pane's Time line came out empty)
  const timeAnchor = {
    getAttribute: n => (n === 'href' ? 'https://www.facebook.com/alice/posts/999' : null),
    innerText: 'November 3 at 5:30 PM', focus() {}, blur() {}, compareDocumentPosition: () => 4,
  };
  const profileEl2 = { innerText: 'Alice', querySelector: () => null, closest: () => null };
  const card2 = {
    querySelector: sel => (sel.includes('profile_name') ? profileEl2 : sel.includes('story_message') ? msgEl : null),
    querySelectorAll: sel => (sel === 'a[href]' ? [timeAnchor] : sel.includes('profile_name') ? [profileEl2] : []),
    getAttribute: () => null,
  };
  const F4 = { ...F, postCards: () => [card2], postText: () => 'Hello world', vtext: () => ['Alice', 'Hello world'], num: () => '0', visible: () => true };
  global.window = { __fb: F4 };
  new Function(fs.readFileSync(path.join(__dirname, '../js/feed.js'), 'utf8')).call(global.window);
  const stepped2 = await global.window.__fbFeed.step();
  assert.strictEqual(stepped2.length, 1);
  assert.strictEqual(stepped2[0].time, 'November 3 at 5:30 PM');
  console.log('js feed time fallback ok');

  // feed step: a shared post's original author heads an unmarked linked
  // heading, and an ad's label is SVG text behind a chain of <use> references
  const use = id => ({ getAttribute: n => (n === 'href' ? '#' + id : null) });
  const svgAnchor = { ...timeAnchor, innerText: '⁠', querySelector: sel => (sel === 'svg use' ? use('S1') : null) };
  const sharedAnchor = { innerText: 'Tanya Warner', getAttribute: n => (n === 'href' ? 'https://www.facebook.com/tanya' : null), compareDocumentPosition: () => 4 };
  const heading = { querySelector: sel => (sel === 'a[href]' ? sharedAnchor : null), closest: () => null, compareDocumentPosition: () => 4 };
  const profileEl3 = { innerText: 'Brandon Bracey', querySelector: () => null, closest: () => null };
  const card3 = {
    querySelector: sel => (sel.includes('profile_name') ? profileEl3 : sel.includes('story_message') ? msgEl : null),
    querySelectorAll: sel => (sel === 'a[href]' ? [svgAnchor] : sel.includes('profile_name') ? [profileEl3] : sel === 'h2,h3,h4' ? [heading] : []),
    getAttribute: () => null,
  };
  global.document.getElementById = id => ({ S1: { tagName: 'svg', querySelector: () => use('S2') }, S2: { tagName: 'text', textContent: 'Ad', querySelector: () => null } })[id] || null;
  global.window = { __fb: { ...F4, postCards: () => [card3], vtext: () => ['Brandon Bracey', 'Hello world'] } };
  new Function(fs.readFileSync(path.join(__dirname, '../js/feed.js'), 'utf8')).call(global.window);
  const stepped3 = await global.window.__fbFeed.step();
  assert.strictEqual(stepped3[0].author, 'Brandon Bracey / Tanya Warner');
  assert.strictEqual(stepped3[0].time, 'Ad');
  assert.strictEqual(stepped3[0].ad, true);
  delete global.document.getElementById;
  console.log('js feed shared author and svg ad label ok');

  // focusComposer: a mounted-but-hidden dialog (closed Notifications panel) must not block; a shown one must
  const tb = { focus() { global.document.activeElement = tb; } };
  const dlg = { isConnected: true, rects: 0, getClientRects() { return { length: this.rects }; }, innerText: 'Notifications', querySelector: () => null, querySelectorAll: () => [] };
  global.getComputedStyle = () => ({ visibility: 'visible' });
  global.document = { querySelectorAll: s => (s === '[role=dialog]' ? [dlg] : []), querySelector: s => (s.includes('textbox') ? tb : s === '[role=dialog]' ? dlg : null) };
  const F5 = { ...F, sleep: async () => {}, waitFor: async fn => fn(), dismissRestore: async () => true };
  global.window = { __fb: F5 };
  new Function(fs.readFileSync(path.join(__dirname, '../js/msg.js'), 'utf8')).call(global.window);
  assert.strictEqual(await F5.focusComposer(), true);
  dlg.rects = 1;
  await assert.rejects(F5.focusComposer(), /dialog blocks input/);
  console.log('js focusComposer hidden dialog ok');
}).catch(e => { console.error(e); process.exit(1); });

// events: hidden links never count toward n, a labelled action link is no detail, a name split across spans stays whole,
// a second link's first line is a detail, and details that render later are merged in
(async () => {
  const vm = require('vm');
  const link = (href, lines, hidden = false) => ({ href, lines, hidden,
    getAttribute: k => (k === 'href' ? href : null),
    get innerText() { return this.lines.join('\n'); },
    getClientRects() { return this.hidden ? [] : [{}]; } });
  const anchors = [
    link('/events/999/', ['Hidden Item'], true),
    link('/events/111/', ['City Library']),
    Object.assign(link('/events/111/', ['View']), { getAttribute: k => (k === 'href' ? '/events/111/' : k === 'aria-label' ? 'View' : null) }),
    link('/events/222/', ['Jazz Night']),
  ];
  let pass = 0;
  const scroll = () => {
    pass++;
    if (pass === 1) anchors.push(link('/events/222/', ['Sat, Nov 14', 'Town Hall']));
    if (pass === 2) anchors[1].lines.push('Library · 1K followers');
  };
  const doc = { querySelector: () => anchors[0], querySelectorAll: sel => (sel.includes('a[href]') ? anchors : []), documentElement: { scrollHeight: 800 } };
  const ctx = vm.createContext({ window: { scrollBy: scroll }, document: doc, location: { href: 'https://www.facebook.com/' }, URL, setTimeout, Date, innerHeight: 800,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) });
  vm.runInContext(src, ctx);
  const G = ctx.window.__fb;
  Object.assign(G, { sleep: async () => {}, waitFor: async f => f() });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ops.js'), 'utf8'), ctx);
  const one = JSON.parse(JSON.stringify((await G.events(1)).rows));
  assert.strictEqual(one[0][0], 'City Library', 'a hidden link must not fill -n 1: ' + JSON.stringify(one));
  const rows = JSON.parse(JSON.stringify((await G.events(10)).rows));
  assert.deepStrictEqual(rows.map(r => r[0]), ['City Library', 'Jazz Night']);
  assert.strictEqual(rows[0][2], 'Library · 1K followers', 'later details merge in');
  assert.strictEqual(rows[1][2], 'Sat, Nov 14 · Town Hall', 'a second link keeps its first line');
  console.log('js events hub ok');
})().catch(e => { console.error(e); process.exit(1); });

// groups: hidden links never count toward n, a labelled action link is no detail, a name split across spans stays whole,
// a second link's first line is a detail, and details that render later are merged in
(async () => {
  const vm = require('vm');
  const link = (href, lines, hidden = false) => ({ href, lines, hidden,
    getAttribute: k => (k === 'href' ? href : null),
    get innerText() { return this.lines.join('\n'); },
    getClientRects() { return this.hidden ? [] : [{}]; } });
  const anchors = [
    link('/groups/999', ['Hidden Item'], true),
    link('/groups/111', ['City Library']),
    Object.assign(link('/groups/111', ['View']), { getAttribute: k => (k === 'href' ? '/groups/111' : k === 'aria-label' ? 'View' : null) }),
    link('/groups/222', ['Jazz Night']),
  ];
  let pass = 0;
  const scroll = () => {
    pass++;
    if (pass === 1) anchors.push(link('/groups/222', ['Sat, Nov 14', 'Town Hall']));
    if (pass === 2) anchors[1].lines.push('Library · 1K followers');
  };
  const doc = { querySelector: () => anchors[0], querySelectorAll: sel => (sel.includes('a[href]') ? anchors : []), documentElement: { scrollHeight: 800 } };
  const ctx = vm.createContext({ window: { scrollBy: scroll }, document: doc, location: { href: 'https://www.facebook.com/' }, URL, setTimeout, Date, innerHeight: 800,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }) });
  vm.runInContext(src, ctx);
  const G = ctx.window.__fb;
  Object.assign(G, { sleep: async () => {}, waitFor: async f => f() });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/ops.js'), 'utf8'), ctx);
  const one = JSON.parse(JSON.stringify((await G.groups(1)).rows));
  assert.strictEqual(one[0][0], 'City Library', 'a hidden link must not fill -n 1: ' + JSON.stringify(one));
  const rows = JSON.parse(JSON.stringify((await G.groups(10)).rows));
  assert.deepStrictEqual(rows.map(r => r[0]), ['City Library', 'Jazz Night']);
  assert.strictEqual(rows[0][2], 'Library · 1K followers', 'later details merge in');
  assert.strictEqual(rows[1][2], 'Sat, Nov 14 · Town Hall', 'a second link keeps its first line');
  console.log('js groups hub ok');
})().catch(e => { console.error(e); process.exit(1); });
