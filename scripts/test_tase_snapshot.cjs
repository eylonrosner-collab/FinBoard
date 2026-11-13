#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const FinReturns = require('../v2/returns.js');

const file = path.join(__dirname, '../v2/tase-prices.json');
const book = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.strictEqual(book.v, 1);
assert.ok(book.items && typeof book.items === 'object');
const ids = Object.keys(book.items);
assert.ok(ids.length > 1000, ids.length);
assert.ok(ids.every(id => /^\d{1,9}$/.test(id)), 'snapshot keys are public security numbers');

function check(id, kind, nameRe) {
  const row = book.items[id];
  assert.ok(row, 'missing ' + id);
  assert.strictEqual(row.k, kind, id);
  assert.ok(nameRe.test(row.n), row.n);
  assert.ok(Array.isArray(row.p) && row.p.length >= 2, id);
  const calc = FinReturns.fromPrices(row.p, '2026-11-13');
  assert.ok(calc && calc.ytd != null && calc.t12 != null, JSON.stringify(calc));
  assert.ok(calc.asOf >= '2026-11-01' && calc.asOf <= '2026-11-13', calc.asOf);
  assert.ok(calc.ytd > -0.8 && calc.ytd < 3, calc.ytd);
  assert.ok(calc.t12 > -0.8 && calc.t12 < 3, calc.t12);
  return {id, name: row.n, asOf: calc.asOf, ytd: +calc.ytd.toFixed(4), t12: +calc.t12.toFixed(4)};
}

const etf = check('1159250', 'c', /איישרס|S&P|500/);
const fund = check('5112628', 'r', /איביאי|תא/);
console.log('ok tase snapshot', {n: ids.length, etf, fund});
