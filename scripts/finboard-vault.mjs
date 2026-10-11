#!/usr/bin/env node
/**
 * Decrypt / encrypt a FinBoard Gist payload
 * (finance_data.json, tasks.json, snaps.json, settings.json).
 *
 * The passphrase or recovery key is read from the environment, never from
 * source code and never from argv:
 *   FINBOARD_PASSPHRASE     — the passphrase
 *   FINBOARD_RECOVERY_KEY   — the fbk1-… recovery key (used if set)
 *   FINBOARD_NEW_PASSPHRASE — only for `rewrap`
 * If neither secret env var is set and stdin is a TTY, the secret is prompted
 * (not echoed). Do not pipe the secret on stdin; stdin is reserved for the file
 * only when --file is omitted.
 *
 *   node scripts/finboard-vault.mjs decrypt --file finance_data.json --out plain.json
 *   node scripts/finboard-vault.mjs encrypt --file plain.json --envelope finance_data.json --out finance_data.json
 *   node scripts/finboard-vault.mjs rewrap  --file finance_data.json --out finance_data.json
 *
 * `encrypt` reuses the data key wrapped inside --envelope, so the recovery key
 * and any other file sealed with that key keep working. Without --envelope a
 * brand-new vault is created and the recovery key is printed once to stderr.
 *
 * tzofik_shares.json must NOT be passed through this tool. See
 * scripts/FINBOARD_ENCRYPTION.md.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const FinCrypto = require(path.join(here, '..', 'assets', 'finboard-crypto.js'));

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || i + 1 >= process.argv.length) return '';
  return process.argv[i + 1];
}
function readText(file) {
  if (file) return fs.readFileSync(file, 'utf8');
  return fs.readFileSync(0, 'utf8');
}
function writeText(file, text) {
  if (file) fs.writeFileSync(file, text);
  else process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error('Set FINBOARD_PASSPHRASE or FINBOARD_RECOVERY_KEY (stdin is not a TTY).'));
      return;
    }
    process.stderr.write(question);
    const buf = [];
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const on = (c) => {
      if (c === '\n' || c === '\r' || c === '\u0004') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener('data', on);
        process.stderr.write('\n');
        resolve(buf.join(''));
      } else if (c === '\u0003') {
        process.stderr.write('\n');
        process.exit(130);
      } else if (c === '\u007f') buf.pop();
      else buf.push(c);
    };
    process.stdin.on('data', on);
  });
}
async function secretFromEnv() {
  if (process.env.FINBOARD_RECOVERY_KEY) return process.env.FINBOARD_RECOVERY_KEY;
  if (process.env.FINBOARD_PASSPHRASE) return process.env.FINBOARD_PASSPHRASE;
  return promptHidden('FinBoard passphrase or recovery key: ');
}

function usage() {
  process.stderr.write(`Usage:
  finboard-vault.mjs decrypt --file <envelope.json> [--out <plain.json>]
  finboard-vault.mjs encrypt --file <plain.json> [--envelope <existing.json>] [--out <envelope.json>]
  finboard-vault.mjs rewrap  --file <envelope.json> [--out <envelope.json>]
Secrets: FINBOARD_PASSPHRASE or FINBOARD_RECOVERY_KEY (or a hidden prompt).
rewrap also needs FINBOARD_NEW_PASSPHRASE.
`);
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === '-h' || cmd === '--help') { usage(); process.exit(cmd ? 0 : 1); }
  const file = arg('--file');
  const out = arg('--out');
  const secret = await secretFromEnv();
  if (!String(secret).trim()) throw new Error('Empty secret.');

  if (cmd === 'decrypt') {
    const env = JSON.parse(readText(file));
    if (!FinCrypto.isEnvelope(env)) throw new Error('File is not a finboard enc v1 envelope.');
    FinCrypto.clearSession();
    const plain = await FinCrypto.open(env, secret);
    writeText(out, JSON.stringify(plain, null, 2));
    return;
  }
  if (cmd === 'encrypt') {
    const plain = JSON.parse(readText(file));
    const envelopePath = arg('--envelope');
    FinCrypto.clearSession();
    if (envelopePath) {
      const existing = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
      if (!FinCrypto.isEnvelope(existing)) throw new Error('--envelope is not a finboard envelope.');
      await FinCrypto.unlock(secret, existing);
      const sealed = await FinCrypto.seal(plain);
      writeText(out, JSON.stringify(sealed, null, 2));
    } else {
      const created = await FinCrypto.createVault(secret);
      const sealed = await FinCrypto.seal(plain);
      process.stderr.write('\nNEW RECOVERY KEY (shown once — store it safely; there is no email recovery):\n' + created.recoveryText + '\n\n');
      writeText(out, JSON.stringify(sealed, null, 2));
    }
    return;
  }
  if (cmd === 'rewrap') {
    const next = process.env.FINBOARD_NEW_PASSPHRASE;
    if (!next) throw new Error('Set FINBOARD_NEW_PASSPHRASE.');
    const env = JSON.parse(readText(file));
    if (!FinCrypto.isEnvelope(env)) throw new Error('File is not a finboard enc v1 envelope.');
    FinCrypto.clearSession();
    await FinCrypto.unlock(secret, env);
    await FinCrypto.changePassphrase(next);
    const updated = FinCrypto.applyWraps(env);
    writeText(out, JSON.stringify(updated, null, 2));
    process.stderr.write('Rewrapped passphrase. Payload ciphertext was not changed.\n');
    return;
  }
  usage();
  process.exit(1);
}

main().catch((e) => {
  const msg = e && e.code === 'BAD_SECRET' ? 'Wrong passphrase or recovery key.' : (e && e.message ? e.message : String(e));
  process.stderr.write(msg + '\n');
  process.exit(1);
});
