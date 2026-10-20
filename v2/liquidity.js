/* FinBoard — optional per-holding liquidity schedule.
   Stored on an investment as `liq` (additive; omitted means "no schedule").
   The original site and the vault round-trip the whole investment object,
   so this key survives Gist sync and encryption without a migration.

   Shape:
     liq: [{ amt: number|null, date: 'YYYY-MM-DD'|null, note?: string }]

   date null, missing, or on/before today → that slice is liquid now.
   amt null → the rest of the balance after the explicit amounts (at most one).
   A holding with no `liq` array is left alone. */
(function (root) {
  'use strict';

  function money(n) {
    return Math.round((+n) * 100) / 100;
  }

  function isIsoDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  /* null when there is nothing to show. Drops junk; keeps the first amt:null row. */
  function normalize(raw) {
    if (!Array.isArray(raw) || !raw.length) return null;
    const out = [];
    let sawOpen = false;
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      let amt = null;
      if (item.amt != null && item.amt !== '') {
        const n = +item.amt;
        if (!isFinite(n) || n <= 0) continue;
        amt = money(n);
      }
      let date = null;
      if (item.date != null && item.date !== '') {
        const s = String(item.date).trim().slice(0, 10);
        if (!isIsoDate(s)) continue;
        date = s;
      }
      const note = item.note == null ? '' : String(item.note).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80);
      if (amt == null && !date && !note) continue;
      if (amt == null) {
        if (sawOpen) continue;
        sawOpen = true;
      }
      const row = { amt: amt, date: date };
      if (note) row.note = note;
      out.push(row);
    }
    return out.length ? out : null;
  }

  /* Split a balance across the schedule as of an ISO date (local calendar day). */
  function parts(balance, rows, asOf) {
    const bal = Math.max(0, money(+balance || 0));
    const asOfIso = isIsoDate(asOf) ? asOf : '0000-01-01';
    const explicit = [];
    let rem = null;
    for (const r of rows) {
      if (r.amt == null) { if (!rem) rem = r; continue; }
      explicit.push(r);
    }
    const explicitSum = explicit.reduce((s, r) => s + r.amt, 0);
    const scale = explicitSum > bal + 0.009 && explicitSum > 0 ? bal / explicitSum : 1;
    const buckets = new Map();
    function add(amt, date, note) {
      amt = money(amt);
      if (!(amt > 0)) return 0;
      const liquid = !date || date <= asOfIso;
      const key = liquid ? '' : date;
      const b = buckets.get(key) || { amt: 0, date: liquid ? null : date, notes: [] };
      b.amt = money(b.amt + amt);
      if (note && b.notes.indexOf(note) < 0) b.notes.push(note);
      buckets.set(key, b);
      return amt;
    }
    let used = 0;
    explicit.forEach((r, i) => {
      let amt = money(r.amt * scale);
      if (scale < 1 && i === explicit.length - 1) amt = money(Math.max(0, bal - used));
      used = money(used + add(amt, r.date, r.note));
    });
    if (rem) used = money(used + add(money(Math.max(0, bal - used)), rem.date, rem.note));
    const nowB = buckets.get('');
    const now = nowB ? nowB.amt : 0;
    const future = [];
    buckets.forEach(b => { if (b.date) future.push(b); });
    future.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    const uncovered = money(Math.max(0, bal - used));
    const covers = uncovered < 0.5;
    let mode = 'partial';
    if (now <= 0 && !future.length) mode = 'empty';
    else if (!future.length && covers) mode = 'liquid';
    else if (now < 0.5 && future.length === 1 && covers) mode = 'future';
    return { mode: mode, now: now, future: future, uncovered: uncovered, bal: bal };
  }

  /* null = this holding has no schedule (caller shows nothing). */
  function view(holding, asOf) {
    const rows = normalize(holding && holding.liq);
    if (!rows) return null;
    const p = parts(holding.bal, rows, asOf);
    if (p.mode === 'empty') return null;
    return p;
  }

  function parseIso(s) {
    return { y: +s.slice(0, 4), m: +s.slice(5, 7), d: +s.slice(8, 10) };
  }

  function dmy(iso) {
    if (!isIsoDate(iso)) return '';
    return iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4);
  }

  /* 'בעוד X חודשים' once a full month remains; otherwise days. Empty when due. */
  function countdown(dateIso, asOf) {
    if (!isIsoDate(dateIso) || !isIsoDate(asOf) || dateIso <= asOf) return '';
    const a = parseIso(asOf), b = parseIso(dateIso);
    let months = (b.y - a.y) * 12 + (b.m - a.m);
    if (b.d < a.d) months -= 1;
    if (months >= 2) return 'בעוד ' + months + ' חודשים';
    if (months === 1) return 'בעוד חודש';
    const days = Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
    if (days <= 1) return 'בעוד יום';
    if (days === 2) return 'בעוד יומיים';
    return 'בעוד ' + days + ' ימים';
  }

  function events(holdings, asOf) {
    const out = [];
    (holdings || []).forEach(h => {
      const v = view(h, asOf);
      if (!v) return;
      v.future.forEach(f => {
        out.push({
          id: h.id, name: h.name || '', date: f.date, amt: f.amt,
          note: f.notes && f.notes[0] || '', countdown: countdown(f.date, asOf)
        });
      });
    });
    out.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : b.amt - a.amt);
    return out;
  }

  /* Scheduled liquid-now, or the whole balance when `fallback` is true and there is no schedule. */
  function liquidNow(holding, asOf, fallback) {
    const v = view(holding, asOf);
    if (v) return v.now;
    return fallback ? Math.max(0, money(+holding.bal || 0)) : 0;
  }

  const api = { normalize: normalize, parts: parts, view: view, dmy: dmy, countdown: countdown, events: events, liquidNow: liquidNow, isIsoDate: isIsoDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FinLiq = api;
})(typeof window !== 'undefined' ? window : globalThis);
