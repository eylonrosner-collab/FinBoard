#!/usr/bin/env node
/** Drives the real pages against a mock Gist. Does not call api.github.com. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from '/tmp/ppt/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = '/tmp/finboard-shots';
fs.mkdirSync(shots, { recursive: true });

const fin = {
  investments: [{ id: 'i1', name: 'קופת בדיקה', cat: 'cash', track: 'כספית', owner: 'בדיקה', accNum: '999111', bal: 12345, notes: '' }],
  loans: [], slog: [], tracks: [{ id: 'money', name: 'כספית', rate: 4.5, note: '' }],
  set: { retAge: 67, birthYear: 1980, tax: 25, daily: 0 },
  lastUpdated: '2026-01-02T00:00:00.000Z'
};
const tasks = { v: 1, updatedAt: '2026-01-02T00:00:00.000Z', items: [{ id: 't1', text: 'משימת בדיקה', done: false, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }] };
const shares = { links: [{ id: 'share-public', snap: { v: 1, fin: 1 } }] };

const gist = {
  updated_at: '2026-01-02T00:00:00Z',
  files: {
    'finance_data.json': { content: JSON.stringify(fin) },
    'tasks.json': { content: JSON.stringify(tasks) },
    'tzofik_shares.json': { content: JSON.stringify(shares) }
  }
};
const patches = [];

function mime(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.json')) return 'application/json';
  if (p.endsWith('.png')) return 'image/png';
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
const base = `http://127.0.0.1:${port}`;

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
    if (u.startsWith('https://api.github.com/gists/')) {
      if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: cors }); return; }
      if (req.method() === 'PATCH') {
        const body = JSON.parse(req.postData() || '{}');
        patches.push(body);
        const files = body.files || {};
        for (const [name, spec] of Object.entries(files)) {
          if (spec && typeof spec.content === 'string') gist.files[name] = { content: spec.content };
        }
        req.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ updated_at: new Date().toISOString() }) });
        return;
      }
      req.respond({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(gist) });
      return;
    }
    if (u.includes('api.github.com') || u.includes('coingecko') || u.includes('er-api') || u.includes('finnhub') || u.includes('spoo.me') || u.includes('data.gov.il')) {
      if (req.method() === 'OPTIONS') { req.respond({ status: 204, headers: cors }); return; }
      req.respond({ status: 404, headers: cors, body: '{}' });
      return;
    }
    req.continue();
  });
}

async function shot(page, name) {
  const file = path.join(shots, name + '.png');
  await page.screenshot({ path: file, fullPage: false });
  console.log('shot', file);
  return file;
}

const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
const client = await page.createCDPSession();
await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: shots, eventsEnabled: true });
await mockPage(page);

// --- v2 migration from plaintext ---
await page.goto(base + '/v2/index.html', { waitUntil: 'domcontentloaded' });
await page.evaluate((payload) => {
  localStorage.clear();
  localStorage.setItem('fin26_token', 'test-token-not-real');
  localStorage.setItem('fin26_gist', 'abc123def4567890');
  localStorage.setItem('fin26', payload);
}, JSON.stringify(fin));
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('#lockSetup:not([hidden])', { timeout: 20000 });
const setupTxt = await page.$eval('#lockTitle', el => el.textContent);
check(/הצפנ/.test(setupTxt), 'setup screen title: ' + setupTxt);
await shot(page, '01-setup');
await page.type('#lockPass', 'test-pass-123');
await page.type('#lockPass2', 'test-pass-123');
await page.click('#lockSetupBtn');
await page.waitForSelector('#lockRecovery:not([hidden])', { timeout: 30000 });
const recovery = (await page.$eval('#lockRecKey', el => el.textContent)).trim();
check(/^fbk1-[0-9a-f-]+$/.test(recovery), 'recovery key shown');
const warn = await page.$eval('.lock-warn', el => el.textContent);
check(/אין שחזור/.test(warn), 'recovery warning');
await shot(page, '02-recovery');
await page.click('#lockSaved');
await page.click('#lockGoBtn');
await page.waitForFunction(() => document.getElementById('lockGate').hidden, { timeout: 30000 });
await page.waitForFunction(() => document.body.innerText.includes('קופת בדיקה'), { timeout: 20000 });
check(true, 'app opened after migration');
const patch = patches[patches.length - 1];
check(patch && patch.files['finance_data.json'] && !patch.files['tzofik_shares.json'], 'patch skips tzofik_shares');
const sealed = JSON.parse(patch.files['finance_data.json'].content);
check(sealed.finboard === 1 && !patch.files['finance_data.json'].content.includes('קופת בדיקה'), 'finance payload encrypted');
check(patch.files['tasks.json'] && JSON.parse(patch.files['tasks.json'].content).finboard === 1, 'tasks encrypted');
check(!patch.files['finance_data.json'].content.includes('999111'), 'account number not in ciphertext');
const sharesStill = JSON.parse(gist.files['tzofik_shares.json'].content);
check(sharesStill.links[0].id === 'share-public', 'tzofik_shares untouched');

// backup button visible
await page.waitForSelector('#backupBtn');
await shot(page, '03-backup-button');
const before = fs.readdirSync(shots);
await page.click('#backupBtn');
await new Promise(r => setTimeout(r, 800));
const downloaded = fs.readdirSync(shots).filter(f => f.startsWith('finboard-backup-') && f.endsWith('.json'));
check(downloaded.length >= 1, 'backup file downloaded ' + downloaded.join(','));
if (downloaded.length) {
  const bak = JSON.parse(fs.readFileSync(path.join(shots, downloaded[0]), 'utf8'));
  check(bak.files['finance_data.json'].investments[0].name === 'קופת בדיקה', 'backup is decrypted');
  check(bak.files['tzofik_shares.json'].links[0].id === 'share-public', 'backup includes clear tzofik_shares');
  check(bak.files['tasks.json'].items[0].text === 'משימת בדיקה', 'backup includes tasks');
}

// wrong password then recovery unlock
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('#lockUnlock:not([hidden])', { timeout: 20000 });
await shot(page, '04-unlock');
await page.type('#lockSecret', 'nope-nope-nope');
await page.click('#lockOpenBtn');
await page.waitForFunction(() => document.getElementById('lockErr').textContent.includes('שגוי'), { timeout: 20000 });
check(true, 'wrong password rejected');
await page.click('#lockSecret', { clickCount: 3 });
await page.evaluate(() => { document.getElementById('lockSecret').value = ''; });
await page.type('#lockSecret', recovery);
await page.click('#lockOpenBtn');
await page.waitForFunction(() => document.getElementById('lockGate').hidden, { timeout: 30000 });
await page.waitForFunction(() => document.body.innerText.includes('קופת בדיקה'), { timeout: 20000 });
check(true, 'recovery key unlocks');

// change passphrase
await page.evaluate(() => { location.hash = 'settings'; });
await page.waitForSelector('#np1', { timeout: 10000 });
await page.type('#np1', 'new-pass-4567');
await page.type('#np2', 'new-pass-4567');
await page.click('#npBtn');
await page.waitForFunction(() => document.getElementById('npMsg').textContent.includes('הוחלפה'), { timeout: 20000 });
check(true, 'passphrase changed');
await page.reload({ waitUntil: 'networkidle0' });
await page.waitForSelector('#lockSecret', { timeout: 15000 });
await page.type('#lockSecret', 'test-pass-123');
await page.click('#lockOpenBtn');
await page.waitForFunction(() => document.getElementById('lockErr').textContent.includes('שגוי'), { timeout: 20000 });
check(true, 'old passphrase rejected after change');
await page.evaluate(() => { document.getElementById('lockSecret').value = ''; });
await page.type('#lockSecret', 'new-pass-4567');
await page.click('#lockOpenBtn');
await page.waitForFunction(() => document.getElementById('lockGate').hidden, { timeout: 30000 });
check(true, 'new passphrase unlocks');

// tzofik share link without a password — fresh page, no vault in this profile would still have vault.
// The share hash must skip the gate even if a vault exists.
const snap = { v: 1, fin: 4242, liq: 1000, locked: 200, debt: 0, yr: 2026, yNet: 10, lyNet: 5, pctS: 50, pctE: 50, pctO: 0, fcD: '2030-01-01', fcExp: 5000, fcM: 100, fcR: 3, fcN: 12, fcP0: 1000 };
const b64 = Buffer.from(JSON.stringify(snap)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
await page.goto(base + '/v2/index.html#tzofik&s=j' + b64, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => document.body.innerText.includes('4,242') || document.body.innerText.includes('4242') || document.body.innerText.includes('₪'), { timeout: 15000 });
const gateHidden = await page.$eval('#lockGate', el => el.hidden);
check(gateHidden, 'tzofik link does not ask for a passphrase');
check((await page.evaluate(() => document.body.innerText)).includes('4242') || (await page.evaluate(() => document.body.innerText)).includes('4,242'), 'tzofik snapshot rendered');

// root site: plaintext gist prompts for a passphrase, and does not embed a token link
const rootPage = await browser.newPage();
await rootPage.setViewport({ width: 1100, height: 800 });
await mockPage(rootPage);
// reset gist to plaintext for the root test
gist.files['finance_data.json'] = { content: JSON.stringify(fin) };
gist.files['tasks.json'] = { content: JSON.stringify(tasks) };
await rootPage.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
await rootPage.evaluate((payload) => {
  localStorage.clear();
  localStorage.setItem('fin26_token', 'test-token-not-real');
  localStorage.setItem('fin26_gist', 'abc123def4567890');
  localStorage.setItem('fin26', payload);
}, JSON.stringify(fin));
await rootPage.reload({ waitUntil: 'networkidle0' });
await rootPage.waitForSelector('#lockSetup', { timeout: 20000 });
const rootShown = await rootPage.$eval('#lockSetup', el => el.style.display !== 'none');
check(rootShown, 'root site asks to encrypt plaintext');
const rootHtml = await rootPage.content();
check(!rootHtml.includes('CORRECT_PIN') && !rootHtml.includes('showQR') && !rootHtml.includes('buildAccessLink'), 'root DOM has no PIN lock or token QR');
await rootPage.close();

await browser.close();
server.close();
console.log(fails.length ? fails.length + ' FAILED' : 'UI FLOW PASSED');
process.exit(fails.length ? 1 : 0);
