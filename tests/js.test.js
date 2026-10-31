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

for (const t of ['3 giờ trước', '22 phút', 'Hôm qua lúc 14:00', '17 Tháng 6', '4 tháng 10 lúc 22:05', '2h', '5 minutes ago', 'Just now', 'il y a 3 jours', 'Oct 4 at 10:05 PM'])
  assert(F.TIME.test(t), 'TIME should match: ' + t);
for (const t of ['Thích', 'Hieu Lee', '22 bình luận', 'Trả lời'])
  assert(!F.TIME.test(t), 'TIME should not match: ' + t);

assert.strictEqual(F.canon('https://www.facebook.com/groups/123/?multi_permalinks=456&hoisted=1&__cft__[0]=abc'), '/groups/123/posts/456');
assert.strictEqual(F.canon('https://www.facebook.com/page/posts/pfbid0X?__cft__[0]=zz&__tn__=%2CO'), '/page/posts/pfbid0X');
assert.strictEqual(F.canon('https://www.facebook.com/photo/?fbid=99&set=a.1&__cft__[0]=z'), '/photo/?fbid=99&set=a.1');
assert.strictEqual(F.clean('a͏ ​b  c'), 'a b c');
assert.strictEqual(F.clean('AH.FM Accounts with a verified badge have been authenticated and can be Meta Verified subscribers or notable persons or brands. is with Tiësto'), 'AH.FM Verified is with Tiësto');
assert.strictEqual(F.groupPath('https://www.facebook.com/groups/123456/'), '/groups/123456');
assert.strictEqual(F.groupPath('/groups/hikers.uk?__cft__[0]=x'), '/groups/hikers.uk');
assert.strictEqual(F.groupPath('https://www.facebook.com/groups/123/posts/456'), null);
assert.strictEqual(F.groupPath('https://www.facebook.com/groups/feed/'), null);
assert.strictEqual(F.groupPath('https://www.facebook.com/groups/joins'), null);
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
})().catch(e => { console.error(e); process.exit(1); });
