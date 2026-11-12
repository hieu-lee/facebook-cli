// Friend-request controls of js/act.js, run against a synthetic profile DOM. Run: node tests/friend.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class El {
  constructor(attrs = {}, text = '', ...kids) {
    this.attrs = attrs; this.text = text; this.kids = []; this.parent = null; this.clicks = 0; this.root = null;
    kids.forEach(k => this.add(k));
  }
  add(k) { k.parent = this; this.kids.push(k); return k; }
  all() { return this.kids.flatMap(k => [k, ...k.all()]); }
  get isConnected() { return !!this.top().root; }
  top() { let e = this; while (e.parent) e = e.parent; return e; }
  get innerText() { return this.text; }
  getClientRects() { return this.attrs.hidden ? [] : [{}]; }
  getAttribute(n) { return n === 'role' ? (this.attrs.role ?? null) : (this.attrs[n] ?? null); }
  matches(sel) { return sel === ':disabled' ? !!this.attrs.disabled : this.test(sel); }
  test(sel) {
    return sel.split(',').some(s => {
      const m = s.trim().match(/^\[([\w-]+)=("?)([^"\]]*)\2(?: i)?\]$/);
      return m && String(this.attrs[m[1]] ?? '').toLowerCase() === m[3].toLowerCase();
    });
  }
  closest(sel) { for (let e = this; e; e = e.parent) if (e.test(sel)) return e; return null; }
  querySelectorAll(sel) { return this.all().filter(e => e.test(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  compareDocumentPosition(o) {
    const order = this.top().all(); const a = order.indexOf(this), b = order.indexOf(o);
    return b < a ? 2 : 4;
  }
  click() { this.clicks++; if (this.onclick) this.onclick(this); }
}
const btn = (label, extra = {}) => new El({ role: 'button', ...extra }, label);
const tabs = () => new El({ role: 'tablist' }, '', btn('Posts'), btn('About'));

function page(...content) {
  const main = new El({ role: 'main' }, '', ...content);
  const doc = new El({}, '', main);
  doc.root = true;
  const state = { main: doc.all()[0] };
  const context = vm.createContext({
    window: {}, Node: { DOCUMENT_POSITION_PRECEDING: 2 }, setTimeout, clearTimeout, Date,
    getComputedStyle: () => ({ visibility: 'visible' }),
    document: { querySelector: s => (s === '[role=main]' ? state.main : null), querySelectorAll: () => [] },
  });
  for (const f of ['lib.js', 'act.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', f), 'utf8'), context);
  return { F: context.window.__fb, main, doc, state };
}
const becomesRequested = b => { b.onclick = e => { e.text = 'Cancel request'; }; return b; };

(async () => {
  {
    const add = becomesRequested(btn('Add friend'));
    const p = page(new El({}, '', btn('Message'), add), tabs());
    assert.strictEqual(p.F.friendState(), 'can-add');
    assert.strictEqual(await p.F.friendAdd(), 'requested');
    assert.strictEqual(add.clicks, 1);
  }
  for (const [label, expected] of [['Friends', 'friends'], ['Cancel request', 'requested'], ['Amis', 'friends']]) {
    const b = btn(label);
    const p = page(new El({}, '', b), tabs());
    assert.strictEqual(await p.F.friendAdd(), expected);
    assert.strictEqual(b.clicks, 0);
  }
  // F1: the profile has no recognised control; other people's Add friend buttons must never be used
  {
    const feedCard = becomesRequested(btn('Add friend'));
    const listCard = becomesRequested(btn('Add friend'));
    const articleCard = becomesRequested(btn('Add friend'));
    const belowTabs = becomesRequested(btn('Add friend'));
    const p = page(
      new El({}, '', btn('Message')), tabs(),
      new El({ role: 'feed' }, '', feedCard),
      new El({ role: 'list' }, '', listCard),
      new El({ role: 'article' }, '', articleCard),
      new El({}, '', belowTabs),
    );
    assert.strictEqual(p.F.friendState(), 'no-button');
    assert.strictEqual(await p.F.friendAdd(), 'no-button');
    assert.deepStrictEqual([feedCard, listCard, articleCard, belowTabs].map(b => b.clicks), [0, 0, 0, 0]);
  }
  // above the tab strip, a control inside a dialog/list/feed/article or a hidden one is still not the profile's
  {
    const wrapped = ['dialog', 'list', 'feed', 'article'].map(role => becomesRequested(btn('Add friend')));
    const hidden = becomesRequested(btn('Add friend', { hidden: true }));
    const p = page(
      ...['dialog', 'list', 'feed', 'article'].map((role, i) => new El({ role }, '', wrapped[i])),
      new El({}, '', hidden), tabs(),
    );
    assert.strictEqual(p.F.friendState(), 'no-button');
    assert.strictEqual(await p.F.friendAdd(), 'no-button');
    assert.deepStrictEqual([...wrapped, hidden].map(b => b.clicks), [0, 0, 0, 0, 0]);
  }
  // not a profile (no tab strip): search results are not a target
  {
    const hit = becomesRequested(btn('Add friend'));
    const p = page(new El({}, '', hit));
    assert.strictEqual(p.F.friendState(), 'no-button');
    assert.strictEqual(await p.F.friendAdd(), 'no-button');
    assert.strictEqual(hit.clicks, 0);
  }
  // two candidate controls in the header: refuse rather than pick one
  {
    const a = becomesRequested(btn('Add friend')), b = becomesRequested(btn('Add friend'));
    const p = page(new El({}, '', a, b), tabs());
    assert.strictEqual(p.F.friendState(), 'ambiguous');
    assert.strictEqual(await p.F.friendAdd(), 'ambiguous');
    assert.deepStrictEqual([a.clicks, b.clicks], [0, 0]);
  }
  // a disabled control is not clicked
  {
    const b = becomesRequested(btn('Add friend', { 'aria-disabled': 'true' }));
    const p = page(new El({}, '', b), tabs());
    assert.strictEqual(await p.F.friendAdd(), 'no-button');
    assert.strictEqual(b.clicks, 0);
  }
  // a click that changes nothing is reported as unconfirmed
  {
    const b = btn('Add friend');
    const p = page(new El({}, '', b), tabs());
    assert.strictEqual(await p.F.friendAdd(), 'unconfirmed');
    assert.strictEqual(b.clicks, 1);
  }
  // F4: header controls that mount after the page loaded are waited for
  {
    const p = page();
    p.state.main = null;
    const header = new El({}, '');
    setTimeout(() => { p.state.main = p.main; p.main.add(header); p.main.add(tabs()); }, 300);
    setTimeout(() => header.add(btn('Add friend')), 900);
    assert.strictEqual(await p.F.friendWait(), 'can-add');
  }
  // a settled profile without any control reports no-button after a bounded wait
  {
    const p = page(new El({}, '', btn('Message')), tabs());
    const t = Date.now();
    assert.strictEqual(await p.F.friendWait(), 'no-button');
    assert(Date.now() - t >= 4500 && Date.now() - t < 8000);
  }
  console.log('js friend ok');
})().catch(e => { console.error(e); process.exit(1); });
