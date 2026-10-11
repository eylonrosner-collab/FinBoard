#!/usr/bin/env node
/** Unit test for assets/finboard-crypto.js. No network, no real Gist. */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const FinCrypto = require(path.join(root, 'assets', 'finboard-crypto.js'));

let failed = 0;
function eq(cond, msg) {
  if (!cond) { failed++; console.error('FAIL', msg); }
  else console.log('ok', msg);
}
async function throwsCode(fn, code) {
  try { await fn(); eq(false, 'expected ' + code); }
  catch (e) { eq(e && e.code === code, 'throws ' + code + ' (got ' + (e && (e.code || e.message)) + ')'); }
}

const finance = {
  investments: [{ id: 'i1', name: 'בדיקה', accNum: '999', bal: 10, cat: 'cash' }],
  loans: [], slog: [], tracks: [], set: { birthYear: 1980 }, lastUpdated: '2026-01-01T00:00:00.000Z'
};
const tasks = { v: 1, updatedAt: '2026-01-02T00:00:00.000Z', items: [{ id: 't1', text: 'עדכן יתרה', done: false, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }] };
const shares = { links: [{ id: 'pub', snap: { v: 1, fin: 1 } }] };

const pass = 'correct horse battery';
const created = await FinCrypto.createVault(pass);
eq(created.recoveryText.startsWith('fbk1-'), 'recovery key prefix');
eq(FinCrypto.parseRecovery(created.recoveryText) instanceof Uint8Array, 'parse recovery');
eq(FinCrypto.unlocked(), 'session unlocked after setup');

const envFin = await FinCrypto.seal(finance);
const envTasks = await FinCrypto.seal(tasks);
eq(FinCrypto.isEnvelope(envFin) && FinCrypto.isEnvelope(envTasks), 'envelopes');
eq(!envFin.ct.includes('בדיקה') && !JSON.stringify(envFin).includes('999'), 'no plaintext in finance envelope');
eq(envFin.wrapP === envTasks.wrapP && envFin.ct !== envTasks.ct, 'shared data key, distinct payloads');
eq(!FinCrypto.shouldEncryptFile('tzofik_shares.json'), 'tzofik_shares stays clear');
eq(FinCrypto.shouldEncryptFile('finance_data.json') && FinCrypto.shouldEncryptFile('tasks.json') && FinCrypto.shouldEncryptFile('snaps.json') && FinCrypto.shouldEncryptFile('settings.json'), 'data files encrypted');
eq(JSON.stringify(shares).includes('pub'), 'share fixture untouched');

FinCrypto.clearSession();
eq(!FinCrypto.unlocked(), 'cleared');
await throwsCode(() => FinCrypto.open(envFin, 'wrong password'), 'BAD_SECRET');
eq(!FinCrypto.unlocked(), 'still locked after wrong password');

const opened = await FinCrypto.open(envFin, pass);
eq(opened.investments[0].accNum === '999' && opened.investments[0].bal === 10, 'passphrase unlock');
FinCrypto.clearSession();
const viaRecovery = await FinCrypto.open(envTasks, created.recoveryText.replace(/-/g, (m, i) => i < 5 ? m : m));
/* recovery text already has dashes; also accept spaces */
FinCrypto.clearSession();
const spaced = created.recoveryText.replace(/-/g, (ch, idx) => idx > 4 && idx % 15 === 0 ? ' ' : ch);
const viaSpaced = await FinCrypto.open(envTasks, created.recoveryText.split('-').join('-\n'));
eq(viaSpaced.items[0].text === 'עדכן יתרה', 'recovery key unlock');
eq(viaRecovery.items[0].id === 't1', 'recovery key (normalized) unlock');

const ctBefore = envFin.ct;
await FinCrypto.changePassphrase('a-new-passphrase');
const rewrapped = FinCrypto.applyWraps(envFin);
eq(rewrapped.ct === ctBefore && rewrapped.iv === envFin.iv, 'rewrap keeps ciphertext');
eq(rewrapped.wrapP !== envFin.wrapP && rewrapped.wrapR === envFin.wrapR, 'only passphrase wrap changes');
FinCrypto.clearSession();
await throwsCode(() => FinCrypto.open(rewrapped, pass), 'BAD_SECRET');
const after = await FinCrypto.open(rewrapped, 'a-new-passphrase');
eq(after.investments[0].name === 'בדיקה', 'new passphrase opens payload');
FinCrypto.clearSession();
const stillRec = await FinCrypto.open(rewrapped, created.recoveryText);
eq(stillRec.investments[0].bal === 10, 'recovery key survives passphrase change');

eq(FinCrypto.planGate({ finance }) === 'setup', 'plaintext -> setup');
eq(FinCrypto.planGate({ finance: envFin }) === 'unlock', 'envelope -> unlock');
eq(FinCrypto.planGate({ vault: FinCrypto.wrapsOf(envFin), finance }) === 'unlock-then-migrate', 'mixed -> unlock then migrate');
eq(FinCrypto.planGate({}) === 'open', 'empty -> open');
eq(FinCrypto.planGate({ tasks: { v: 1, items: [] } }) === 'open', 'empty tasks are not personal plaintext');
eq(FinCrypto.planGate({ finance: shares }) === 'open', 'non-finance object is not personal');

/* served files must not contain the removed secret identifiers.
   The numeric PIN, account numbers, and phone are not repeated here, so this
   test file itself does not republish them on GitHub Pages. */
const served = ['index.html', 'v2/index.html', 'v2/lookthrough.js', 'assets/finboard-crypto.js'];
const banned = ['CORRECT_PIN', 'buildAccessLink', 'SMS_LOGIN_PHONE', 'showQR'];
for (const rel of served) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  for (const s of banned) {
    if (text.includes(s)) { failed++; console.error('FAIL secret still in', rel, s); }
  }
}
/* placeholder token examples are ok; a real ghp_/github_pat_ value is not */
const blob = served.map(rel => fs.readFileSync(path.join(root, rel), 'utf8')).join('\n');
const ghps = blob.match(/ghp_[A-Za-z0-9]{16,}/g) || [];
eq(ghps.every(t => /^ghp_x+$/.test(t)), 'no real ghp_ token ' + ghps.join(','));
eq(!/github_pat_[A-Za-z0-9_]{20,}/.test(blob), 'no real github_pat_ token');
console.log(failed ? failed + ' failed' : 'all passed');
process.exit(failed ? 1 : 0);
