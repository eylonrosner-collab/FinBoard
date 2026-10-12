// node scripts/test_pension.cjs — checks the pension normalizer on the fictitious demo doc.
const assert = require('node:assert');
const P = require('../v2/pension.js');
const n = P.normalize(P.demoDoc());
assert.strictEqual(P.validate(P.demoDoc()), '');
assert.strictEqual(n.excluded, 2, 'hishtalmut/gemel are excluded');
assert.strictEqual(n.joint.length, 1, 'joint mortgage life counted once');
const dani = n.people.find(p => p.key === 'dani');
assert.ok(dani.products.some(p => p.kind === 'manager_insurance'), 'savings policy "למנהלים" becomes manager insurance');
const titles = n.alerts.map(a => a.title).join('\n');
assert.match(titles, /מיכל: תביעה פתוחה/);
assert.match(titles, /דני: ייתכן כפל ביטוח/);
assert.doesNotMatch(titles, /מיכל: ייתכן כפל ביטוח/, 'no over-insurance nudge while a claim is open');
assert.match(titles, /אין מוטבים/);
assert.match(titles, /מיכל: מצב משפחתי/);
assert.ok(P.validate({ people: { a: { products: [{ x: '123456789' }] } } }), 'unmasked 9-digit numbers are rejected');
console.log('pension ok');
