/* FinBoard vault — WebCrypto, no network.
   Format (finboard enc v1) is documented in scripts/FINBOARD_ENCRYPTION.md.
   Works in the browser (global FinCrypto) and in Node (module.exports).
   The data key lives only in this module's memory for the page session. */
(function (g) {
  'use strict';
  var ITER = 600000;
  var VAULT_LS = 'fin26_vault';
  var CLEARTEXT_FILES = { 'tzofik_shares.json': true };

  function subtle() {
    if (!g.crypto || !g.crypto.subtle) throw new Error('WebCrypto חסר בדפדפן הזה');
    return g.crypto.subtle;
  }
  function b64e(buf) {
    var bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return g.btoa(bin);
  }
  function b64d(s) {
    var bin = g.atob(String(s || ''));
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function isEnvelope(o) {
    return !!(o && o.finboard === 1 && typeof o.ct === 'string' && typeof o.wrapP === 'string' && typeof o.iv === 'string');
  }
  function isWraps(o) {
    return !!(o && typeof o.wrapP === 'string' && typeof o.wrapR === 'string' && typeof o.saltP === 'string' && typeof o.saltR === 'string');
  }
  function wrapsOf(o) {
    if (!isWraps(o)) return null;
    return {
      iter: o.iter || ITER,
      saltP: o.saltP, ivP: o.ivP, wrapP: o.wrapP,
      saltR: o.saltR, ivR: o.ivR, wrapR: o.wrapR
    };
  }
  function isPersonalFinance(o) {
    return !!(o && !o.finboard && Array.isArray(o.investments));
  }
  function isTaskDoc(o) {
    return !!(o && !o.finboard && Array.isArray(o.items) && o.items.length);
  }
  function shouldEncryptFile(name) {
    if (CLEARTEXT_FILES[name]) return false;
    return name === 'finance_data.json' || name === 'tasks.json';
  }
  function parseRecovery(text) {
    var s = String(text || '').trim().toLowerCase().replace(/\s+/g, '');
    var hex = '';
    var m = s.match(/^fbk1-([0-9a-f-]+)$/);
    if (!m) return null;
    hex = m[1].replace(/-/g, '');
    if (!/^[0-9a-f]{64}$/.test(hex)) return null;
    var out = new Uint8Array(32);
    for (var i = 0; i < 32; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }
  function formatRecovery(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    var groups = [];
    for (var j = 0; j < hex.length; j += 4) groups.push(hex.substr(j, 4));
    return 'fbk1-' + groups.join('-');
  }
  function deriveMaterial(secret) {
    if (secret instanceof Uint8Array) return secret;
    return new TextEncoder().encode(String(secret));
  }
  async function deriveKey(secret, salt, iter) {
    var base = await subtle().importKey('raw', deriveMaterial(secret), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async function wrapRaw(secret, raw) {
    var salt = g.crypto.getRandomValues(new Uint8Array(16));
    var iv = g.crypto.getRandomValues(new Uint8Array(12));
    var kek = await deriveKey(secret, salt, ITER);
    var ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv }, kek, raw));
    return { salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) };
  }
  var session = null;

  function persistVault(wraps) {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.setItem(VAULT_LS, JSON.stringify(wrapsOf(wraps)));
    } catch (e) {}
  }
  function readVault() {
    try {
      if (typeof localStorage === 'undefined') return null;
      var o = JSON.parse(localStorage.getItem(VAULT_LS) || 'null');
      return isWraps(o) ? wrapsOf(o) : null;
    } catch (e) { return null; }
  }
  function clearVaultStorage() {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(VAULT_LS); } catch (e) {}
  }

  async function unlockWith(secret, wraps) {
    var w = wrapsOf(wraps);
    if (!w) throw Object.assign(new Error('אין מעטפת הצפנה'), { code: 'NO_WRAPS' });
    var rec = secret instanceof Uint8Array ? secret : parseRecovery(secret);
    var useRec = secret instanceof Uint8Array || !!rec;
    var salt = b64d(useRec ? w.saltR : w.saltP);
    var iv = b64d(useRec ? w.ivR : w.ivP);
    var wrapped = b64d(useRec ? w.wrapR : w.wrapP);
    var kek = await deriveKey(useRec ? (secret instanceof Uint8Array ? secret : rec) : String(secret), salt, w.iter || ITER);
    var raw;
    try {
      raw = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: iv }, kek, wrapped));
    } catch (e) {
      throw Object.assign(new Error('BAD_SECRET'), { code: 'BAD_SECRET' });
    }
    var dataKey = await subtle().importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    session = { dataKey: dataKey, wraps: w };
    persistVault(w);
    return dataKey;
  }

  async function createVault(passphrase) {
    if (String(passphrase || '').length < 8) throw Object.assign(new Error('SHORT'), { code: 'SHORT' });
    var raw = g.crypto.getRandomValues(new Uint8Array(32));
    var dataKey = await subtle().importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    var recovery = g.crypto.getRandomValues(new Uint8Array(32));
    var p = await wrapRaw(String(passphrase), raw);
    var r = await wrapRaw(recovery, raw);
    var wraps = { iter: ITER, saltP: p.salt, ivP: p.iv, wrapP: p.ct, saltR: r.salt, ivR: r.iv, wrapR: r.ct };
    session = { dataKey: dataKey, wraps: wraps };
    persistVault(wraps);
    return { recoveryText: formatRecovery(recovery), wraps: wraps };
  }

  async function seal(obj) {
    if (!session) throw Object.assign(new Error('LOCKED'), { code: 'LOCKED' });
    var iv = g.crypto.getRandomValues(new Uint8Array(12));
    var pt = new TextEncoder().encode(JSON.stringify(obj));
    var ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv }, session.dataKey, pt));
    var w = session.wraps;
    return {
      finboard: 1, alg: 'A256GCM', kdf: 'PBKDF2-SHA256', iter: w.iter,
      saltP: w.saltP, ivP: w.ivP, wrapP: w.wrapP,
      saltR: w.saltR, ivR: w.ivR, wrapR: w.wrapR,
      iv: b64e(iv), ct: b64e(ct)
    };
  }

  async function openEnvelope(envelope, secret) {
    if (!isEnvelope(envelope)) throw Object.assign(new Error('NOT_ENVELOPE'), { code: 'NOT_ENVELOPE' });
    if (secret != null) await unlockWith(secret, envelope);
    if (!session) throw Object.assign(new Error('LOCKED'), { code: 'LOCKED' });
    var pt;
    try {
      pt = await subtle().decrypt({ name: 'AES-GCM', iv: b64d(envelope.iv) }, session.dataKey, b64d(envelope.ct));
    } catch (e) {
      throw Object.assign(new Error('BAD_SECRET'), { code: 'BAD_SECRET' });
    }
    return JSON.parse(new TextDecoder().decode(pt));
  }

  async function changePassphrase(newPass) {
    if (!session) throw Object.assign(new Error('LOCKED'), { code: 'LOCKED' });
    if (String(newPass || '').length < 8) throw Object.assign(new Error('SHORT'), { code: 'SHORT' });
    var raw = new Uint8Array(await subtle().exportKey('raw', session.dataKey));
    var p = await wrapRaw(String(newPass), raw);
    session.wraps = {
      iter: session.wraps.iter || ITER,
      saltP: p.salt, ivP: p.iv, wrapP: p.ct,
      saltR: session.wraps.saltR, ivR: session.wraps.ivR, wrapR: session.wraps.wrapR
    };
    persistVault(session.wraps);
    return session.wraps;
  }

  function applyWraps(envelope, wraps) {
    var w = wrapsOf(wraps || (session && session.wraps));
    if (!isEnvelope(envelope) || !w) return envelope;
    return {
      finboard: 1, alg: envelope.alg || 'A256GCM', kdf: envelope.kdf || 'PBKDF2-SHA256', iter: w.iter,
      saltP: w.saltP, ivP: w.ivP, wrapP: w.wrapP,
      saltR: w.saltR, ivR: w.ivR, wrapR: w.wrapR,
      iv: envelope.iv, ct: envelope.ct
    };
  }

  function clearSession() { session = null; }
  function unlocked() { return !!session; }
  function currentWraps() { return session ? session.wraps : null; }

  function planGate(probe) {
    probe = probe || {};
    var enc = !!(probe.vault || isEnvelope(probe.local) || isEnvelope(probe.finance) || isEnvelope(probe.tasks));
    var plain = !!(isPersonalFinance(probe.local) || isPersonalFinance(probe.finance) || isTaskDoc(probe.tasks));
    if (enc && plain) return 'unlock-then-migrate';
    if (enc) return 'unlock';
    if (plain) return 'setup';
    return 'open';
  }

  function downloadJson(filename, obj) {
    var json = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var a = g.document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    g.document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  function datedName(prefix) {
    var d = new Date();
    var iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return (prefix || 'finboard-backup') + '-' + iso + '.json';
  }

  var api = {
    ITER: ITER,
    VAULT_LS: VAULT_LS,
    CLEARTEXT_FILES: CLEARTEXT_FILES,
    isEnvelope: isEnvelope,
    isWraps: isWraps,
    wrapsOf: wrapsOf,
    isPersonalFinance: isPersonalFinance,
    isTaskDoc: isTaskDoc,
    shouldEncryptFile: shouldEncryptFile,
    parseRecovery: parseRecovery,
    formatRecovery: formatRecovery,
    readVault: readVault,
    persistVault: persistVault,
    clearVaultStorage: clearVaultStorage,
    createVault: createVault,
    unlock: unlockWith,
    seal: seal,
    open: openEnvelope,
    changePassphrase: changePassphrase,
    applyWraps: applyWraps,
    clearSession: clearSession,
    unlocked: unlocked,
    wraps: currentWraps,
    planGate: planGate,
    downloadJson: downloadJson,
    datedName: datedName
  };
  g.FinCrypto = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
