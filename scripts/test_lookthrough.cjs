#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const FinLook = require('../v2/lookthrough.js');
const pub = JSON.parse(fs.readFileSync(path.join(__dirname, '../v2/public-allocation.json'), 'utf8'));

const LOOK = {
  'S&P 500': {cls:{equity:1}, geo:{US:1}, ccy:{USD:1}},
  'SP500,NASDAQ,AI': {cls:{equity:1}, geo:{US:1}, ccy:{USD:1}},
  'מניות': {cls:{equity:1}, geo:{US:.45, Global:.25, IL:.30}, ccy:{USD:.55, ILS:.30, EUR:.15}},
  'כללי': {cls:{equity:.45, bonds:.45, cash:.10}, geo:{IL:.55, US:.30, Global:.15}, ccy:{ILS:.60, USD:.32, EUR:.08}},
  '50% מניות + S&P 50%': {cls:{equity:.75, bonds:.20, cash:.05}, geo:{US:.55, IL:.30, Global:.15}, ccy:{USD:.60, ILS:.40}},
  'ת"א 35': {cls:{equity:1}, geo:{IL:1}, ccy:{ILS:1}},
  'אגח': {cls:{bonds:1}, geo:{IL:1}, ccy:{ILS:1}},
  'כספית': {cls:{cash:1}, geo:{IL:1}, ccy:{ILS:1}},
  'USD': {cls:{cash:1}, geo:{US:1}, ccy:{USD:1}},
  'Bitcoin': {cls:{crypto:1}, geo:{Crypto:1}, ccy:{USD:1}},
  'Ethereum': {cls:{crypto:1}, geo:{Crypto:1}, ccy:{USD:1}},
  'אחר': {cls:{other:1}, geo:{IL:1}, ccy:{ILS:1}}
};

function sum(o) { return Object.values(o).reduce((a, b) => a + b, 0); }
function near(a, b, eps) { assert.ok(Math.abs(a - b) <= (eps || 0.02), `${a} !~ ${b}`); }

/* Same track / manager / product shape as the app's holdings. No balances, names of people, or account numbers. */
const CASES = [
  {id:'sp', cat:'gamel', name:'גמל להשקעה', inst:'מור בית השקעות', track:'S&P 500', expect:'public', fundId:7958},
  {id:'klali-gi', cat:'gamel', name:'גמל להשקעה', inst:'מור בית השקעות', track:'כללי', expect:'public', fundId:12538},
  {id:'klali-h', cat:'kupa', name:'קה"ש חדשה', inst:'מור בית השקעות', track:'כללי', expect:'public', fundId:12535},
  {id:'stocks', cat:'kupa', name:'קופת גמל', inst:'ילין לפידות', track:'מניות', expect:'public', fundId:1036},
  {id:'blend-h', cat:'kupa', name:'קה"ש', inst:'ילין לפידות', track:'50% מניות + S&P 50%', expect:'assume', why:'no-track'},
  {id:'blend-g', cat:'kupa', name:'קופת גמל', inst:'ילין לפידות', track:'50% מניות + S&P 50%', expect:'assume', why:'no-track'},
  {id:'broker', cat:'forex', name:'תיק ברוקר', inst:'Schwab', track:'SP500,NASDAQ,AI', expect:'assume', why:'no-track'},
  {id:'usd', cat:'forex', name:'עו"ש מט"ח', inst:'מזרחי טפחות', track:'USD', expect:'assume', why:'no-track'},
  {id:'cash', cat:'cash', name:'עו"ש כספיות', inst:'מזרחי טפחות', track:'כספית', expect:'assume', why:'private'},
  {id:'safe', cat:'cash', name:'כספת', inst:'', track:'אחר', expect:'assume', why:'no-track'},
  {id:'btc', cat:'crypto', name:'Bitcoin', inst:'ארנק', track:'Bitcoin', expect:'assume', why:'no-track'},
  {id:'eth', cat:'crypto', name:'Ethereum', inst:'ארנק', track:'Ethereum', expect:'assume', why:'no-track'},
  {id:'ta35', cat:'kupa', name:'קופת גמל', inst:'ילין לפידות', track:'ת"א 35', expect:'assume', why:'no-fund'},
  {id:'bonds', cat:'kupa', name:'קופת גמל', inst:'ילין לפידות', track:'אגח', expect:'public'}
];

const report = [];
for (const c of CASES) {
  const hit = FinLook.matchFund(c, pub.funds);
  const base = LOOK[c.track];
  const composed = hit.fund ? FinLook.composePublic(base, hit.fund) : null;
  if (c.expect === 'public') {
    assert.ok(hit.fund, `${c.id} should match, got ${hit.why}`);
    if (c.fundId) assert.strictEqual(hit.fund.fundId, c.fundId, c.id);
    assert.ok(composed);
    near(sum(composed.cls), 1, 0.001);
    near(sum(composed.geo), 1, 0.001);
    near(sum(composed.ccy), 1, 0.001);
    const label = FinLook.sourceLabel({source: hit.fund.source, period: hit.fund.period});
    assert.strictEqual(label.kind, 'public');
    assert.ok(label.text.startsWith('מקור: נתונים ציבוריים ('), label.text);
  } else {
    assert.strictEqual(hit.fund, null, `${c.id} unexpectedly matched ${hit.fund && hit.fund.fundId}`);
    assert.strictEqual(hit.why, c.why, c.id);
    assert.strictEqual(FinLook.sourceLabel(null).text, 'מקור: הנחה במערכת');
  }
  report.push({
    id: c.id,
    track: c.track,
    product: FinLook.holdingProduct(c),
    result: hit.fund ? `public ${hit.fund.fundId} ${hit.fund.name} period ${hit.fund.period} stock ${hit.fund.stock} foreign ${hit.fund.foreign} fx ${hit.fund.fx}` : `assume ${hit.why}`,
    cls: composed && composed.cls,
    ccy: composed && composed.ccy,
    geo: composed && composed.geo
  });
}

const sp = FinLook.composePublic(LOOK['S&P 500'], pub.funds.find(f => f.fundId === 7958 && f.source === 'gemelnet'));
near(sp.cls.equity, 1, 0.001);
near(sp.geo.US, 1, 0.001);
near(sp.ccy.USD, 1, 0.001);

const klali = FinLook.composePublic(LOOK['כללי'], pub.funds.find(f => f.fundId === 12538 && f.source === 'gemelnet'));
assert.ok(klali.cls.equity > 0.5 && klali.cls.equity < 0.6, 'כללי equity should follow the published ~53%');
assert.ok(klali.cls.bonds > 0 && klali.cls.cash > 0, 'non-equity residual keeps bonds and cash');
assert.ok(klali.ccy.ILS > 0.75, 'published FX exposure is low, so ILS should rise above the 60% assumption');

const stocks = FinLook.composePublic(LOOK['מניות'], pub.funds.find(f => f.fundId === 1036 && f.source === 'gemelnet'));
near(stocks.cls.equity, 1, 0.02);
assert.ok(stocks.ccy.ILS > 0.65, 'Yelin מניות FX is about 27%, so most currency is ILS');
assert.ok(stocks.geo.IL > 0.25 && stocks.geo.US > 0, 'IL comes from foreign exposure; US/Global keep the assumption ratio');

/* A pension holding at More should be able to match Pensia-Net, separately from gemel.
   "מקיפה" picks the comprehensive fund; a bare name stays on the assumption. */
const pensia = FinLook.matchFund({cat:'pensia', name:'פנסיה מקיפה', inst:'מור גמל ופנסיה', track:'מניות'}, pub.funds);
assert.ok(pensia.fund && pensia.fund.source === 'pensia' && pensia.fund.fundId === 13912, JSON.stringify(pensia));
const pensiaAmb = FinLook.matchFund({cat:'pensia', name:'פנסיה', inst:'מור גמל ופנסיה', track:'מניות'}, pub.funds);
assert.strictEqual(pensiaAmb.fund, null);
assert.strictEqual(pensiaAmb.why, 'ambiguous');

/* Notes that mention פנסיה must not reclassify a gemel cup. */
assert.strictEqual(FinLook.holdingProduct({cat:'kupa', name:'קופת גמל', notes:'סגור לפנסיה'}), 'gemel-savings');

/* A long account-style number on the holding is not a fund id unless fundId is set. */
const notAcc = FinLook.matchFund({cat:'gamel', name:'גמל להשקעה', inst:'מור בית השקעות', track:'S&P 500', accNum:'100000001'}, pub.funds);
assert.strictEqual(notAcc.fund.fundId, 7958);

const periods = [...new Set(pub.sources.map(s => s.period))];
assert.ok(periods.every(p => p >= 202601), 'snapshot should be a 2026 report');
assert.ok(pub.funds.length > 1000);

console.log(JSON.stringify({periods, sources: pub.sources.map(s => ({id:s.id, period:s.period, funds:s.funds})), report}, null, 2));
console.log('ok', CASES.length, 'cases');
