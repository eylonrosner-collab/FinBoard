/* Recognizes the fictional demo / example portfolio totals.
   makeExample() in v2/index.html builds 36 month-end-ish points on the 8th
   plus "today", with a fixed RNG seed. Those points must never be stored in
   fin26_snaps or uploaded to snaps.json. The value sequence does not depend
   on the calendar month; the dates do. This rebuilds every month the demo
   could have been opened and the constant demo total (sum of the example balances). */
(function (g) {
  'use strict';
  var SPEC = [
    [486000, 0.72], [214500, 0.84], [612000, 0.66], [278400, 0.86], [195800, 0.81],
    [340000, 0.74], [168200, 0.90], [247600, 0.78], [470000, 0.67], [280000, 0.80],
    [88000, 0.94], [48700, 0.97], [31400, 0.88], [22800, 0.58], [11250, 1.15]
  ];
  var TOTAL = 0;
  for (var i = 0; i < SPEC.length; i++) TOTAL += SPEC[i][0];

  function rng(seed) {
    return function () {
      seed |= 0;
      seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function iso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function addMonths(d, m) {
    var x = new Date(d.getTime());
    x.setMonth(x.getMonth() + m);
    return x;
  }
  /* Values are identical for every as-of date; only the dates move. */
  function values() {
    var R = rng(20261107);
    var n = 37;
    var cols = [];
    for (var h = 0; h < SPEC.length; h++) {
      var bal = SPEC[h][0], start = Math.round(bal * SPEC[h][1]);
      var col = [];
      for (var i = 0; i < n; i++) {
        var t = i / (n - 1);
        var curve = start + (bal - start) * (0.15 * t + 0.85 * t * t);
        var wobble = i === n - 1 ? 0 : Math.round((R() - 0.5) * bal * 0.018);
        col.push(Math.max(0, Math.round(curve + wobble)));
      }
      col[n - 1] = bal;
      cols.push(col);
    }
    var out = [];
    for (var k = 0; k < n; k++) {
      var s = 0;
      for (var c = 0; c < cols.length; c++) s += cols[c][k];
      out.push(s);
    }
    return out;
  }
  var VALUES = values();

  function datesFor(asOf) {
    var base = new Date(asOf.getTime());
    base.setHours(12, 0, 0, 0);
    var dates = [];
    for (var k = 36; k >= 1; k--) {
      var d = addMonths(base, -k);
      d.setDate(8);
      dates.push(iso(d));
    }
    dates.push(iso(base));
    return dates;
  }
  function series(asOf) {
    var dates = datesFor(asOf);
    var rows = [];
    for (var i = 0; i < dates.length; i++) rows.push({ d: dates[i], v: VALUES[i] });
    return rows;
  }

  var KEYS = null;
  function keys() {
    if (KEYS) return KEYS;
    KEYS = new Set();
    /* Demo shipped in 2026. Cover every month a browser could have built the series. */
    for (var y = 2026; y <= 2027; y++) {
      for (var m = 0; m < 12; m++) {
        var rows = series(new Date(y, m, 15, 12, 0, 0, 0));
        for (var i = 0; i < rows.length; i++) KEYS.add(rows[i].d + '|' + rows[i].v);
      }
    }
    return KEYS;
  }
  function isDemoPoint(d, v) {
    var n = Math.round(+v);
    if (!isFinite(n)) return false;
    if (n === TOTAL) return true;
    var day = String(d || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
    return keys().has(day + '|' + n);
  }
  function strip(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s || s.d == null || !isFinite(+s.v)) continue;
      if (isDemoPoint(String(s.d).slice(0, 10), s.v)) continue;
      out.push(s);
    }
    return out;
  }

  /* Hard guard for every page that loads this file, including the original site.
     Safari keeps setItem as an own property, so the instance method is replaced
     too. Demo pages cannot touch real keys. Any other page that writes
     fin26_snaps as a JSON array has demo points removed before they hit disk. */
  var REAL_KEYS = { fin26: 1, fin26_snaps: 1, fin26_gemini: 1, fin26_v2: 1, fin26_token: 1, fin26_gist: 1, fin26_vault: 1, fin26_bio: 1 };
  function demoPage() {
    try {
      var loc = g.location;
      if (!loc) return false;
      return /[?&]demo=1(?:&|$)/.test(loc.search || '') || /\/demo\/?(?:index\.html)?$/.test(loc.pathname || '');
    } catch (e) { return false; }
  }
  function guardValue(key, value) {
    if (key !== 'fin26_snaps' || typeof value !== 'string') return value;
    try {
      var parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) return value;
      var cleaned = strip(parsed);
      if (cleaned.length === parsed.length) return value;
      return JSON.stringify(cleaned);
    } catch (e) { return value; }
  }
  function guardedSet(storage, nativeSet, key, value) {
    var k = String(key);
    if (demoPage() && REAL_KEYS[k]) return;
    return nativeSet.call(storage, k, guardValue(k, value));
  }
  function wrapStorage(storage) {
    if (!storage || storage.__finSnapGuard) return;
    var nativeSet = storage.setItem;
    if (typeof nativeSet !== 'function') return;
    try {
      storage.setItem = function (key, value) { return guardedSet(storage, nativeSet, key, value); };
      storage.__finSnapGuard = 1;
    } catch (e) {}
  }
  try { wrapStorage(g.localStorage); } catch (e) {}
  try { wrapStorage(g.sessionStorage); } catch (e) {}
  try {
    var proto = g.Storage && g.Storage.prototype;
    if (proto && !proto.__finSnapGuard && typeof proto.setItem === 'function') {
      var protoSet = proto.setItem;
      proto.setItem = function (key, value) { return guardedSet(this, protoSet, key, value); };
      proto.__finSnapGuard = 1;
    }
  } catch (e) {}

  g.FinDemoGuard = {
    TOTAL: TOTAL,
    isDemoPoint: isDemoPoint,
    strip: strip,
    series: series,
    values: function () { return VALUES.slice(); }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
