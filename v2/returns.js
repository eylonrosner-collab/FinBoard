/* YTD and trailing-12-month returns.
   Gemel-Net / Bituach-Net store MONTHLY_YIELD and YEAR_TO_DATE_YIELD as percent
   points (8.11 means 8.11%). There is no trailing-12-month field, so 12m is the
   compound of the last 12 monthly values. This module returns decimals (0.0811).
   No personal holdings, balances, or account numbers. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FinReturns = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function num(v) {
    if (v == null || v === '') return null;
    const n = +v;
    return isFinite(n) ? n : null;
  }

  function compoundPct(monthlyPct) {
    let acc = 1;
    for (let i = 0; i < monthlyPct.length; i++) {
      const m = num(monthlyPct[i]);
      if (m == null) return null;
      acc *= (1 + m / 100);
    }
    return acc - 1;
  }

  function periodYear(p) { return Math.floor(+p / 100); }
  function periodMonth(p) { return +p % 100; }

  function rowsFrom(records) {
    const out = [];
    (records || []).forEach(r => {
      const period = +r.REPORT_PERIOD;
      if (!isFinite(period) || period < 190001) return;
      out.push({
        period: period,
        monthly: num(r.MONTHLY_YIELD),
        ytd: num(r.YEAR_TO_DATE_YIELD),
        name: r.FUND_NAME || ''
      });
    });
    out.sort((a, b) => b.period - a.period);
    return out;
  }

  /* Official YTD is the newest row's YEAR_TO_DATE_YIELD when that report is in
     `year`. Otherwise null — a prior December is not "since Jan 1" of this year.
     Trailing 12m compounds the 12 newest numeric MONTHLY_YIELD values. */
  function fromRecords(records, year) {
    const rows = rowsFrom(records);
    if (!rows.length) return null;
    const latest = rows[0];
    let ytd = null;
    if (periodYear(latest.period) === year && latest.ytd != null) ytd = latest.ytd / 100;
    else if (periodYear(latest.period) === year) {
      const inYear = rows.filter(r => periodYear(r.period) === year && r.monthly != null)
        .sort((a, b) => a.period - b.period);
      if (inYear.length && periodMonth(inYear[0].period) === 1) ytd = compoundPct(inYear.map(r => r.monthly));
    }
    const monthly = [];
    for (let i = 0; i < rows.length && monthly.length < 12; i++) {
      if (rows[i].monthly != null) monthly.push(rows[i].monthly);
    }
    const t12 = monthly.length === 12 ? compoundPct(monthly.slice().reverse()) : null;
    return {ytd: ytd, t12: t12, period: latest.period, months: monthly.length, name: latest.name || ''};
  }

  function covered(records, ids) {
    const counts = {};
    (records || []).forEach(r => {
      if (num(r.MONTHLY_YIELD) == null) return;
      const id = +r.FUND_ID;
      counts[id] = (counts[id] || 0) + 1;
    });
    return (ids || []).every(id => (counts[+id] || 0) >= 12);
  }

  function isoDate(d) {
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
    const x = (d instanceof Date) ? d : new Date(d);
    if (!isFinite(x.getTime())) return '';
    return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
  }
  function parseISO(s) {
    return new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), 12);
  }
  function daysBetween(a, b) { return (parseISO(b) - parseISO(a)) / 864e5; }
  function addMonths(iso, m) {
    const x = parseISO(iso);
    x.setMonth(x.getMonth() + m);
    return isoDate(x);
  }

  function pointsOf(history, bal, today) {
    const pts = [];
    (history || []).forEach(h => {
      if (!h || !h.date) return;
      const date = isoDate(h.date);
      const b = +h.bal;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !isFinite(b)) return;
      pts.push({date: date, bal: b});
    });
    pts.sort((a, b) => a.date.localeCompare(b.date));
    const dedup = [];
    pts.forEach(p => {
      if (dedup.length && dedup[dedup.length - 1].date === p.date) dedup[dedup.length - 1] = p;
      else dedup.push(p);
    });
    const todayIso = isoDate(today);
    const last = dedup[dedup.length - 1];
    if (isFinite(+bal) && todayIso && (!last || Math.abs(last.bal - (+bal)) > 0.49)) {
      if (!last || todayIso >= last.date) dedup.push({date: todayIso, bal: +bal});
    }
    return dedup;
  }

  /* Modified Dietz. Needs a balance on or before the window start and a later one.
     Flows are external deposits (positive) and withdrawals (negative). */
  function windowReturn(points, flows, startIso, endIso) {
    if (!points || !points.length) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startIso) || !/^\d{4}-\d{2}-\d{2}$/.test(endIso)) return null;
    let start = null;
    for (let i = 0; i < points.length; i++) if (points[i].date <= startIso) start = points[i];
    if (!start) return null;
    let end = null;
    for (let i = 0; i < points.length; i++) if (points[i].date <= endIso) end = points[i];
    if (!end || end.date <= start.date) return null;
    const v0 = +start.bal, v1 = +end.bal;
    if (!isFinite(v0) || !isFinite(v1)) return null;
    const T = Math.max(1, daysBetween(start.date, end.date));
    const fl = (flows || []).filter(s => s && s.date > start.date && s.date <= end.date && isFinite(+s.amount));
    let C = 0, Cw = 0;
    fl.forEach(s => {
      const a = +s.amount;
      C += a;
      Cw += a * (daysBetween(s.date, end.date) / T);
    });
    const denom = v0 + Cw;
    if (!isFinite(denom) || Math.abs(denom) < 1e-9) return null;
    return {r: (v1 - v0 - C) / denom, from: start.date, to: end.date, flows: fl.length};
  }

  function historyReturns(history, bal, flows, today) {
    const todayIso = isoDate(today);
    if (!todayIso) return {ytd: null, t12: null};
    const points = pointsOf(history, bal, todayIso);
    const year = +todayIso.slice(0, 4);
    const ytd = windowReturn(points, flows, year + '-01-01', todayIso);
    const t12 = windowReturn(points, flows, addMonths(todayIso, -12), todayIso);
    return {ytd: ytd ? ytd.r : null, t12: t12 ? t12.r : null};
  }

  function periodLabel(period) {
    const p = String(period || '');
    if (/^\d{6}$/.test(p)) return p.slice(4, 6) + '/' + p.slice(0, 4);
    return p;
  }

  return {
    compoundPct, fromRecords, covered, pointsOf, windowReturn, historyReturns, periodLabel
  };
});
