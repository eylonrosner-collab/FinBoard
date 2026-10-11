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
    return name === 'finance_data.json' || name === 'tasks.json' || name === 'snaps.json' || name === 'settings.json';
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
    invalidateBio(true);
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
    invalidateBio(true);
    return session.wraps;
  }

  /* Device biometric wrap. The passphrase is never an input and is never stored.
     A platform passkey's PRF output (32 bytes) is the HKDF IKM. The derived
     AES-GCM key wraps the raw data key. Only credId, the PRF salt, and that
     wrap live in localStorage['fin26_bio'] — per device, real book only. */
  var BIO_LS = 'fin26_bio';
  var BIO_HKDF_SALT = new TextEncoder().encode('finboard-bio-hkdf-v1');
  var BIO_HKDF_INFO = new TextEncoder().encode('finboard-data-key-wrap');

  function readBioStore() {
    try {
      if (typeof localStorage === 'undefined') return null;
      var o = JSON.parse(localStorage.getItem(BIO_LS) || 'null');
      if (!o || o.v !== 1 || typeof o !== 'object') return null;
      return o;
    } catch (e) { return null; }
  }
  function writeBioStore(o) {
    try {
      if (typeof localStorage === 'undefined') return;
      if (!o) localStorage.removeItem(BIO_LS);
      else localStorage.setItem(BIO_LS, JSON.stringify(o));
    } catch (e) {}
  }
  function bioRecord() {
    var o = readBioStore();
    if (!o) return null;
    if (typeof o.credId !== 'string' || typeof o.salt !== 'string' || typeof o.iv !== 'string' || typeof o.ct !== 'string' || typeof o.fp !== 'string') return null;
    if (!o.credId || !o.salt || !o.iv || !o.ct || !o.fp) return null;
    return { credId: o.credId, salt: o.salt, fp: o.fp };
  }
  function bioPrompt() {
    var o = readBioStore() || {};
    return { ask: !!o.ask, dismissedFp: typeof o.dismissedFp === 'string' ? o.dismissedFp : '' };
  }
  function invalidateBio(ask) {
    var prev = readBioStore();
    var had = !!(prev && typeof prev.credId === 'string' && prev.credId);
    if (!had) return;
    if (ask) writeBioStore({ v: 1, ask: true });
    else writeBioStore(null);
  }
  async function wrapsFingerprint(wraps) {
    var w = wrapsOf(wraps);
    if (!w) return '';
    var text = [w.saltP, w.ivP, w.wrapP, w.saltR, w.ivR, w.wrapR].join('\n');
    var dig = await subtle().digest('SHA-256', new TextEncoder().encode(text));
    return b64e(new Uint8Array(dig));
  }
  async function prfKek(prfBytes) {
    if (!(prfBytes instanceof Uint8Array) || prfBytes.length !== 32) {
      throw Object.assign(new Error('BAD_BIO'), { code: 'BAD_BIO' });
    }
    var ikm = await subtle().importKey('raw', prfBytes, 'HKDF', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: BIO_HKDF_SALT, info: BIO_HKDF_INFO },
      ikm,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }
  async function enrollBio(prfBytes, credId, salt) {
    if (!session) throw Object.assign(new Error('LOCKED'), { code: 'LOCKED' });
    if (typeof credId !== 'string' || !credId || typeof salt !== 'string' || !salt) {
      throw Object.assign(new Error('BAD_BIO'), { code: 'BAD_BIO' });
    }
    var raw = new Uint8Array(await subtle().exportKey('raw', session.dataKey));
    try {
      var kek = await prfKek(prfBytes);
      var iv = g.crypto.getRandomValues(new Uint8Array(12));
      var ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv }, kek, raw));
      var fp = await wrapsFingerprint(session.wraps);
      writeBioStore({ v: 1, credId: credId, salt: salt, iv: b64e(iv), ct: b64e(ct), fp: fp });
    } finally {
      raw.fill(0);
    }
  }
  async function unlockRaw(raw, wraps) {
    var w = wrapsOf(wraps);
    if (!w) throw Object.assign(new Error('NO_WRAPS'), { code: 'NO_WRAPS' });
    if (!(raw instanceof Uint8Array) || raw.length !== 32) {
      throw Object.assign(new Error('BAD_BIO'), { code: 'BAD_BIO' });
    }
    var dataKey = await subtle().importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
    session = { dataKey: dataKey, wraps: w };
    persistVault(w);
    return dataKey;
  }
  async function unlockFromBio(prfBytes, wraps) {
    var rec = readBioStore();
    if (!rec || !rec.credId || !rec.iv || !rec.ct || !rec.fp) {
      throw Object.assign(new Error('NO_BIO'), { code: 'NO_BIO' });
    }
    var fp = await wrapsFingerprint(wraps);
    if (!fp || fp !== rec.fp) {
      invalidateBio(true);
      throw Object.assign(new Error('STALE_BIO'), { code: 'STALE_BIO' });
    }
    var raw;
    try {
      var kek = await prfKek(prfBytes);
      raw = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: b64d(rec.iv) }, kek, b64d(rec.ct)));
    } catch (e) {
      invalidateBio(true);
      throw Object.assign(new Error('BAD_BIO'), { code: 'BAD_BIO' });
    }
    try {
      await unlockRaw(raw, wraps);
    } finally {
      if (raw) raw.fill(0);
    }
  }
  async function bioReady(wraps) {
    var rec = bioRecord();
    if (!rec) return false;
    var fp = await wrapsFingerprint(wraps);
    if (!fp || fp !== rec.fp) {
      invalidateBio(true);
      return false;
    }
    return true;
  }
  async function forgetBio(wrapsOrFp) {
    var fp = '';
    if (typeof wrapsOrFp === 'string') fp = wrapsOrFp;
    else if (wrapsOrFp) fp = await wrapsFingerprint(wrapsOrFp);
    if (fp) writeBioStore({ v: 1, dismissedFp: fp });
    else writeBioStore(null);
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
    var enc = !!(probe.vault || isEnvelope(probe.local) || isEnvelope(probe.finance) || isEnvelope(probe.tasks) || isEnvelope(probe.snaps) || isEnvelope(probe.settings));
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
    BIO_LS: BIO_LS,
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
    wrapsFingerprint: wrapsFingerprint,
    bioRecord: bioRecord,
    bioPrompt: bioPrompt,
    bioReady: bioReady,
    enrollBio: enrollBio,
    unlockFromBio: unlockFromBio,
    forgetBio: forgetBio,
    dropBio: invalidateBio,
    unlocked: unlocked,
    wraps: currentWraps,
    planGate: planGate,
    downloadJson: downloadJson,
    datedName: datedName
  };
  g.FinCrypto = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
