/* node scripts/test_liquidity.cjs — liquidity schedule, no personal data. */
const assert = require('node:assert');
const L = require('../v2/liquidity.js');

const AS = '2026-10-20';

assert.strictEqual(L.normalize(undefined), null);
assert.strictEqual(L.normalize([]), null);
assert.strictEqual(L.normalize('nope'), null);
assert.strictEqual(L.view({ bal: 100 }, AS), null, 'missing liq shows nothing');
assert.strictEqual(L.view({ bal: 100, liq: [] }, AS), null);
assert.strictEqual(L.view({ bal: 100, liq: [{ amt: 'bad', date: 'yesterday' }] }, AS), null);

const past = L.view({ bal: 612000, liq: [{ amt: null, date: '2021-03-01' }] }, AS);
assert.strictEqual(past.mode, 'liquid');
assert.strictEqual(past.now, 612000);

const today = L.view({ bal: 10, liq: [{ amt: null, date: AS }] }, AS);
assert.strictEqual(today.mode, 'liquid', 'date equal to today is liquid');

const tomorrow = L.view({ bal: 10, liq: [{ amt: null, date: '2026-10-21' }] }, AS);
assert.strictEqual(tomorrow.mode, 'future');
assert.strictEqual(tomorrow.now, 0);
assert.strictEqual(tomorrow.future[0].amt, 10);
assert.strictEqual(L.countdown('2026-10-21', AS), 'בעוד יום');

const flipped = L.view({ bal: 10, liq: [{ amt: null, date: '2026-10-21' }] }, '2026-10-21');
assert.strictEqual(flipped.mode, 'liquid', 'badge flips once the date arrives');

const future = L.view({ bal: 278400, liq: [{ amt: null, date: '2029-02-20' }] }, AS);
assert.strictEqual(future.mode, 'future');
assert.strictEqual(L.dmy(future.future[0].date), '20/02/2029');
assert.strictEqual(L.countdown('2029-02-20', AS), 'בעוד 28 חודשים');
assert.strictEqual(L.countdown('2026-11-20', AS), 'בעוד חודש');
assert.strictEqual(L.countdown('2026-10-22', AS), 'בעוד יומיים');
assert.strictEqual(L.countdown('2026-11-10', AS), 'בעוד 21 ימים');

const partial = L.view({
  id: 'e5', name: 'קרן הדגמה', bal: 195800,
  liq: [
    { amt: null, date: null, note: 'החלק שנפתח קודם' },
    { amt: 42800, date: '2027-02-20', note: 'חשבון מאוחר' }
  ]
}, AS);
assert.strictEqual(partial.mode, 'partial');
assert.strictEqual(partial.now, 153000);
assert.strictEqual(partial.future.length, 1);
assert.strictEqual(partial.future[0].amt, 42800);
assert.strictEqual(partial.future[0].date, '2027-02-20');
assert.strictEqual(partial.uncovered, 0);

const three = L.view({
  bal: 300,
  liq: [
    { amt: 100, date: '2020-01-01' },
    { amt: 80, date: '2028-01-31' },
    { amt: 120, date: '2029-06-01', note: 'ג' }
  ]
}, AS);
assert.strictEqual(three.mode, 'partial');
assert.strictEqual(three.now, 100);
assert.strictEqual(three.future.length, 2);
assert.strictEqual(three.future[0].amt, 80);
assert.strictEqual(three.future[1].amt, 120);

const scaled = L.parts(100, L.normalize([
  { amt: 80, date: null }, { amt: 80, date: '2027-01-01' }, { amt: 80, date: '2028-01-01' }
]), AS);
assert.strictEqual(scaled.now + scaled.future.reduce((s, f) => s + f.amt, 0), 100);
assert.ok(Math.abs(scaled.uncovered) < 0.01);

const oneOpen = L.normalize([
  { amt: null, date: '2028-01-01', note: 'ראשון' },
  { amt: null, date: null, note: 'שני נזרק' },
  { amt: -5, date: '2028-01-01' },
  { amt: 12.345, date: '2028-02-31' },
  { amt: 12.345, date: '2028-02-29', note: '  הערה  ' }
]);
assert.strictEqual(oneOpen.length, 2);
assert.strictEqual(oneOpen[0].note, 'ראשון');
assert.strictEqual(oneOpen[1].amt, 12.35);
assert.strictEqual(oneOpen[1].date, '2028-02-29');
assert.strictEqual(oneOpen[1].note, 'הערה');

const uncovered = L.view({ bal: 500, liq: [{ amt: 40, date: '2029-01-31' }] }, AS);
assert.strictEqual(uncovered.mode, 'partial');
assert.strictEqual(uncovered.now, 0);
assert.strictEqual(uncovered.future[0].amt, 40);
assert.strictEqual(uncovered.uncovered, 460, 'unlisted remainder is not treated as liquid');

const ev = L.events([
  { id: 'a', name: 'מאוחר', bal: 10, liq: [{ amt: null, date: '2029-01-01' }] },
  { id: 'b', name: 'מוקדם', bal: 10, liq: [{ amt: null, date: '2027-05-01' }] },
  { id: 'c', name: 'בלי', bal: 99 }
], AS);
assert.deepStrictEqual(ev.map(e => e.id), ['b', 'a']);
assert.strictEqual(ev[0].countdown, L.countdown('2027-05-01', AS));

assert.strictEqual(L.liquidNow({ bal: 50 }, AS, true), 50);
assert.strictEqual(L.liquidNow({ bal: 50 }, AS, false), 0);
assert.strictEqual(L.liquidNow({ bal: 50, liq: [{ amt: null, date: '2029-01-01' }] }, AS, true), 0);

assert.strictEqual(L.dmy('2029-01-31'), '31/01/2029');
console.log('liquidity ok');
