#!/usr/bin/env node
/** Biometric unlock against a Chrome virtual authenticator. Does not call api.github.com. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from '/tmp/ppt/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = '/tmp/finboard-bio-shots';
fs.mkdirSync(shots, { recursive: true });

const fin = {
  investments: [{ id: 'i1', name: 'קופת ביומטרית', cat: 'cash', track: 'כספית', owner: 'בדיקה', accNum: '999111', bal: 12345, notes: '' }],
  loans: [], slog: [], tracks: [{ id: 'money', name: 'כספית', rate: 4.5, note: '' }],
  set: { retAge: 67, birthYear: 1980, tax: 25, daily: 0 },
  lastUpdated: '2026-01-02T00:00:00.000Z'
};
const PASS = 'test-pass-123';
const PASS2 = 'new-pass-4567';

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.webmanifest')) return 'application/manifest+json';
  return 'text/plain';
}
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, u === '/' ? 'index.html' : u);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('no'); return;
  }
  res.writeHead(200, { 'content-type': mime(file), 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://localhost:${port}`;

const browser = await puppeteer.launch({
  executablePath: '/usr/local/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage']
});
const fails = [];
function check(cond, msg) { if (!cond) { fails.push(msg); console.error('FAIL', msg); } else console.log('ok', msg); }

async function mockPage(page) {
  await page.setRequestInterception(true);
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS' };
  page.on('request', req => {
    const u = req.url();
    if (u.startsWith('https://api.github.com/') || u.includes('coingecko') || u.includes('er-api') || u.includes('finnhub') || u.includes('spoo.me') || u.includes('data.gov.il') || u.includes('googleapis.com')) {
      if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: cors }); return; }
      req.respond({ status: 404, headers: cors, body: '{}' });
      return;
    }
    req.continue();
  });
  page.on('pageerror', err => console.log('PAGEERROR', err.message));
  page.on('console', msg => {
    const t = msg.text();
    if (/error|bio|prf|webauthn/i.test(t)) console.log('CONSOLE', msg.type(), t);
  });
}

async function shot(page, name) {
  const file = path.join(shots, name + '.png');
  await page.screenshot({ path: file });
  console.log('shot', file);
  return file;
}

const page = await browser.newPage();
page.setDefaultTimeout(90000);
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
await mockPage(page);
const client = await page.createCDPSession();
await client.send('WebAuthn.enable', { enableUI: false });
const added = await client.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
    automaticPresenceSimulation: true,
    hasPrf: true
  }
});
const authenticatorId = added.authenticatorId;
console.log('authenticator', authenticatorId);

await page.goto(base + '/v2/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.FinCrypto && document.getElementById('lockGate'), { timeout: 20000 });
const sentinel = JSON.stringify({ v: 1, credId: 'keep-me', salt: 'c2FsdA==', iv: 'aXY=', ct: 'Y3Q=', fp: 'abc' });
await page.evaluate(raw => localStorage.setItem('fin26_bio', raw), sentinel);

await page.goto(base + '/v2/index.html?demo=1', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#demoBanner:not([hidden])', { timeout: 20000 });
const demoSeen = await page.evaluate(async () => {
  let enroll = 'no-fn';
  try {
    if (window.FinCrypto && FinCrypto.enrollBio) {
      await FinCrypto.enrollBio(new Uint8Array(32), 'eA==', 'eA==');
      enroll = 'stored';
    }
  } catch (e) { enroll = e && (e.code || e.message) || 'threw'; }
  const read = localStorage.getItem('fin26_bio');
  localStorage.setItem('fin26_bio', 'hacked');
  localStorage.removeItem('fin26_bio');
  return {
    read,
    enroll,
    rec: window.FinCrypto && FinCrypto.bioRecord ? FinCrypto.bioRecord() : 'missing',
    vaultHidden: !!(document.getElementById('vaultCard') && document.getElementById('vaultCard').hidden),
    gateHidden: document.getElementById('lockGate').hidden
  };
});
check(demoSeen.read === null, 'demo read of fin26_bio is null');
check(demoSeen.rec == null, 'demo FinCrypto.bioRecord is null (' + JSON.stringify(demoSeen.rec) + ')');
check(demoSeen.enroll !== 'stored', 'demo enroll did not report success (' + demoSeen.enroll + ')');
check(demoSeen.vaultHidden && demoSeen.gateHidden, 'demo hides vault card and lock gate');
await page.goto(base + '/v2/lookthrough.js', { waitUntil: 'domcontentloaded' });
const afterDemo = await page.evaluate(() => localStorage.getItem('fin26_bio'));
check(afterDemo === sentinel, 'demo did not modify fin26_bio');

await page.goto(base + '/v2/index.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.FinCrypto, { timeout: 20000 });
await page.evaluate(async (payload, pass) => {
  localStorage.clear();
  const fin = JSON.parse(payload);
  await FinCrypto.createVault(pass);
  localStorage.setItem('fin26', JSON.stringify(await FinCrypto.seal(fin)));
  FinCrypto.clearSession();
}, JSON.stringify(fin), PASS);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#lockUnlock:not([hidden])', { timeout: 20000 });
await page.type('#lockSecret', PASS);
await page.click('#lockOpenBtn');
await page.waitForFunction(() => document.getElementById('lockGate').hidden, { timeout: 90000 });
await page.waitForFunction(() => document.body.innerText.includes('קופת ביומטרית'), { timeout: 20000 });
check(true, 'passphrase unlocks');
const support = await page.evaluate(async () => {
  const caps = window.PublicKeyCredential && PublicKeyCredential.getClientCapabilities
    ? await PublicKeyCredential.getClientCapabilities() : null;
  return caps;
});
console.log('capabilities', JSON.stringify(support));
check(support && (support.prf === true || support['extension:prf'] === true), 'client reports prf');

await page.waitForSelector('#bioPrompt:not([hidden])', { timeout: 10000 });
await shot(page, '01-prompt');
check(true, 'one-time biometric prompt');

await page.evaluate(() => { location.hash = 'settings'; });
await page.waitForSelector('#bioEnable', { timeout: 10000 });
await page.evaluate(() => document.getElementById('bioBox').scrollIntoView({ block: 'center' }));
await shot(page, '02-settings-off');
const enableText = await page.$eval('#bioEnable', el => el.textContent);
check(enableText.includes('הפעל כניסה ביומטרית במכשיר זה'), 'enable label');
await page.click('#bioEnable');
await page.waitForFunction(() => {
  const t = document.getElementById('bioMsg').textContent || '';
  return t.includes('הופעלה') || t.includes('לא זמינה') || t.includes('בוטלה') || t.includes('לא הצלחתי');
}, { timeout: 20000 });
const enableMsg = await page.$eval('#bioMsg', el => el.textContent);
console.log('enableMsg', enableMsg);
check(enableMsg.includes('הופעלה'), 'biometric enabled: ' + enableMsg);
const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('fin26_bio')));
check(stored && stored.credId && stored.salt && stored.iv && stored.ct && stored.fp, 'local wrap stored');
check(!JSON.stringify(stored).includes(PASS), 'passphrase not stored');
check(await page.$eval('#bioDisable', el => !el.hidden && el.textContent.includes('בטל כניסה ביומטרית במכשיר זה')), 'disable button shown');
await page.evaluate(() => document.getElementById('bioBox').scrollIntoView({ block: 'center' }));
await shot(page, '03-settings-on');

await page.type('#np1', PASS2);
await page.type('#np2', PASS2);
await page.click('#npBtn');
await page.waitForFunction(() => document.getElementById('npMsg').textContent.includes('הוחלפה'), { timeout: 90000 });
const npMsg = await page.$eval('#npMsg', el => el.textContent);
check(/בוטלה/.test(npMsg), 'passphrase change says biometric was cancelled: ' + npMsg);
const afterChange = JSON.parse(await page.evaluate(() => localStorage.getItem('fin26_bio') || 'null'));
check(afterChange && afterChange.ask === true && !afterChange.ct, 'wrap removed after passphrase change');
check(await page.$eval('#bioEnable', el => !el.hidden), 'enable offered again');
await page.evaluate(() => document.getElementById('bioPrompt').scrollIntoView({ block: 'center' }));
const promptText = await page.$eval('#bioPromptText', el => el.textContent);
check(/בוטלה/.test(promptText), 'prompt asks to re-enable');
await shot(page, '04-reenable-prompt');
await page.evaluate(() => document.getElementById('bioBox').scrollIntoView({ block: 'center' }));
await page.click('#bioEnable');
await page.waitForFunction(() => (document.getElementById('bioMsg').textContent || '').includes('הופעלה'), { timeout: 20000 });
check(true, 'biometric re-enabled after passphrase change');

await page.evaluate(() => { location.hash = 'overview'; });
await page.reload({ waitUntil: 'domcontentloaded' });
const openedBy = await Promise.race([
  page.waitForFunction(() => {
    const gate = document.getElementById('lockGate');
    const btn = document.getElementById('lockBioBtn');
    if (!gate || gate.hidden || !btn || btn.closest('[hidden]')) return false;
    const r = btn.getBoundingClientRect();
    return r.width > 20 && r.height > 20;
  }, { timeout: 15000 }).then(() => 'button').catch(() => null),
  page.waitForFunction(() => document.getElementById('lockGate').hidden && document.body.innerText.includes('קופת ביומטרית'), { timeout: 15000 }).then(() => 'open').catch(() => null)
]);
console.log('reload unlock state', openedBy);
if (openedBy === 'button') {
  const still = await page.evaluate(() => {
    const gate = document.getElementById('lockGate');
    const btn = document.getElementById('lockBioBtn');
    if (!gate || gate.hidden || !btn) return null;
    const r = btn.getBoundingClientRect();
    if (r.width < 20) return null;
    return { x: r.x, y: r.y, w: r.width, h: r.height, label: btn.textContent };
  });
  if (still) {
    await shot(page, '05-unlock-button');
    check(still.label.includes('פתיחה עם Face ID / טביעת אצבע'), 'unlock button label');
    console.log('bio button box', JSON.stringify(still));
    await page.mouse.click(still.x + still.w / 2, still.y + still.h / 2);
  } else console.log('auto unlock finished before the click');
}
await page.waitForFunction(() => document.getElementById('lockGate').hidden && document.body.innerText.includes('קופת ביומטרית'), { timeout: 20000 });
check(true, 'biometric unlock after reload (' + openedBy + ')');
await shot(page, '06-unlocked');

await client.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
await page.evaluate(() => { location.hash = 'overview'; });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => {
  const gate = document.getElementById('lockGate');
  const btn = document.getElementById('lockBioBtn');
  if (!gate || gate.hidden || !btn) return false;
  const r = btn.getBoundingClientRect();
  return r.width > 20 && r.height > 20;
}, { timeout: 20000 });
await shot(page, '07-unlock-button');
const cancelBox = await page.$eval('#lockBioBtn', el => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };
});
await page.mouse.click(cancelBox.x + cancelBox.w / 2, cancelBox.y + cancelBox.h / 2);
await page.waitForFunction(() => {
  const t = document.getElementById('lockErr').textContent || '';
  return t.includes('בוטלה') || t.includes('נכשלה') || t.includes('שחזור');
}, { timeout: 20000 });
const cancelMsg = await page.$eval('#lockErr', el => el.textContent);
check(/סיסמה|שחזור/.test(cancelMsg), 'cancel explains passphrase fallback: ' + cancelMsg);
const gateStill = await page.$eval('#lockGate', el => !el.hidden);
check(gateStill, 'still locked after biometric cancel');
await shot(page, '08-cancel-fallback');
await page.click('#lockSecret', { clickCount: 3 });
await page.evaluate(() => { document.getElementById('lockSecret').value = ''; });
await page.type('#lockSecret', PASS2);
await page.click('#lockOpenBtn');
await page.waitForFunction(() => document.getElementById('lockGate').hidden && document.body.innerText.includes('קופת ביומטרית'), { timeout: 90000 });
check(true, 'passphrase fallback after biometric cancel');

await page.evaluate(() => { location.hash = 'settings'; });
await page.waitForSelector('#bioDisable', { timeout: 10000 });
await page.evaluate(() => document.getElementById('bioDisable').scrollIntoView({ block: 'center' }));
await page.click('#bioDisable');
await page.waitForFunction(() => (document.getElementById('bioMsg').textContent || '').includes('בוטלה'), { timeout: 10000 });
const disabled = JSON.parse(await page.evaluate(() => localStorage.getItem('fin26_bio') || 'null'));
check(disabled && !disabled.ct && !disabled.credId, 'disable drops the wrap');
check(await page.$eval('#bioDisable', el => el.hidden), 'disable button hidden');
check(await page.$eval('#bioEnable', el => !el.hidden), 'enable still available from settings');
await page.evaluate(() => document.getElementById('bioBox').scrollIntoView({ block: 'center' }));
await shot(page, '09-settings-off');

await page.evaluate(() => { location.hash = 'overview'; });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#lockSecret', { timeout: 20000 });
const bioHidden = await page.$eval('#lockBio', el => el.hidden);
check(bioHidden, 'no biometric button after disable');
await page.type('#lockSecret', PASS2);
await page.click('#lockOpenBtn');
await page.waitForFunction(() => document.getElementById('lockGate').hidden && document.body.innerText.includes('קופת ביומטרית'), { timeout: 90000 });
check(true, 'passphrase still unlocks after disable');

await browser.close();
server.close();
console.log(fails.length ? fails.length + ' FAILED\n' + fails.join('\n') : 'BIO UI PASSED');
process.exit(fails.length ? 1 : 0);
