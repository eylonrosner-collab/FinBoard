#!/usr/bin/env node
'use strict';
const assert = require('assert');
const FinReturns = require('../v2/returns.js');

/* More gemel-invest S&P 500 (fund 7958), months ending 2026-09. Public sample, not a holding. */
const MORE_SP = [
  {FUND_ID:7958, FUND_NAME:'מור גמל להשקעה - עוקב מדד S&P500', REPORT_PERIOD:202609, MONTHLY_YIELD:2.4, YEAR_TO_DATE_YIELD:8.11},
  {FUND_ID:7958, REPORT_PERIOD:202608, MONTHLY_YIELD:1.11, YEAR_TO_DATE_YIELD:5.58},
  {FUND_ID:7958, REPORT_PERIOD:202607, MONTHLY_YIELD:2.08, YEAR_TO_DATE_YIELD:4.42},
  {FUND_ID:7958, REPORT_PERIOD:202606, MONTHLY_YIELD:4.69, YEAR_TO_DATE_YIELD:2.29},
  {FUND_ID:7958, REPORT_PERIOD:202605, MONTHLY_YIELD:0.59, YEAR_TO_DATE_YIELD:-2.29},
  {FUND_ID:7958, REPORT_PERIOD:202604, MONTHLY_YIELD:3.07, YEAR_TO_DATE_YIELD:-2.86},
  {FUND_ID:7958, REPORT_PERIOD:202603, MONTHLY_YIELD:-4.3, YEAR_TO_DATE_YIELD:-5.76},
  {FUND_ID:7958, REPORT_PERIOD:202602, MONTHLY_YIELD:0.18, YEAR_TO_DATE_YIELD:-1.52},
  {FUND_ID:7958, REPORT_PERIOD:202601, MONTHLY_YIELD:-1.7, YEAR_TO_DATE_YIELD:-1.7},
  {FUND_ID:7958, REPORT_PERIOD:202512, MONTHLY_YIELD:-1.74, YEAR_TO_DATE_YIELD:2.91},
  {FUND_ID:7958, REPORT_PERIOD:202511, MONTHLY_YIELD:0.4, YEAR_TO_DATE_YIELD:4.73},
  {FUND_ID:7958, REPORT_PERIOD:202510, MONTHLY_YIELD:0.83, YEAR_TO_DATE_YIELD:4.32}
];

const cur = FinReturns.fromRecords(MORE_SP, 2026);
assert.ok(cur);
assert.strictEqual(cur.period, 202609);
assert.ok(Math.abs(cur.ytd - 0.0811) < 1e-9, cur.ytd);
const manual = FinReturns.compoundPct(MORE_SP.map(r => r.MONTHLY_YIELD).reverse());
assert.ok(Math.abs(cur.t12 - manual) < 1e-12);
assert.ok(cur.t12 > 0.05 && cur.t12 < 0.12, cur.t12);
assert.strictEqual(FinReturns.periodLabel(cur.period), '09/2026');

/* A December print from last year is not this year's YTD. 12m still compounds. */
const stale = FinReturns.fromRecords(MORE_SP, 2027);
assert.strictEqual(stale.ytd, null);
assert.ok(Math.abs(stale.t12 - manual) < 1e-12);

const short = FinReturns.fromRecords(MORE_SP.slice(0, 11), 2026);
assert.strictEqual(short.t12, null);
assert.ok(Math.abs(short.ytd - 0.0811) < 1e-9);

assert.strictEqual(FinReturns.fromRecords([], 2026), null);
assert.strictEqual(FinReturns.covered(MORE_SP, [7958]), true);
assert.strictEqual(FinReturns.covered(MORE_SP.slice(0, 11), [7958]), false);

/* Deposit-adjusted history. A mid-window deposit must not be counted as return. */
const pts = [{date:'2026-01-01', bal:100}, {date:'2026-07-01', bal:160}];
const raw = FinReturns.windowReturn(pts, [], '2026-01-01', '2026-07-01');
assert.ok(Math.abs(raw.r - 0.6) < 1e-9);
const adj = FinReturns.windowReturn(pts, [{date:'2026-04-01', amount:50}], '2026-01-01', '2026-07-01');
assert.strictEqual(adj.flows, 1);
assert.ok(adj.r < 0.2 && adj.r > 0, adj.r);
assert.ok(adj.r < raw.r);

const hist = FinReturns.historyReturns(
  [{date:'2025-11-01', bal:200}, {date:'2026-11-01', bal:220}],
  220,
  [],
  '2026-11-13'
);
assert.ok(hist.ytd != null && Math.abs(hist.ytd - 0.1) < 1e-9, hist.ytd);
assert.ok(hist.t12 != null && Math.abs(hist.t12 - 0.1) < 1e-9);

const thin = FinReturns.historyReturns([{date:'2026-08-01', bal:50}], 50, [], '2026-11-13');
assert.strictEqual(thin.ytd, null);
assert.strictEqual(thin.t12, null);

/* No point on or before the window start. */
assert.strictEqual(FinReturns.windowReturn([{date:'2026-03-01', bal:10}], [], '2026-01-01', '2026-11-01'), null);

console.log('ok returns', {ytd: cur.ytd, t12: +cur.t12.toFixed(6), adj: +adj.r.toFixed(4)});
