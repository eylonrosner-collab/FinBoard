/* Public look-through for FinBoard v2.
   Matches a holding to a Gemel-Net / Pensia-Net / Bituach-Net fund and blends
   the published stock / foreign / FX exposures with the LOOK assumption for
   the splits those datasets do not publish (bonds vs cash, US vs rest of world).
   No personal holdings, balances, or account numbers. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FinLook = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SRC_HE = {gemelnet:'גמל-נט', pensia:'פנסיה-נט', bituach:'ביטוח-נט'};
  const STOP = new Set(['בית','השקעות','ניהול','קופות','גמל','חברה','לביטוח','ופנסיה','ישראל','מסלול','בעמ','פנסיה','ביטוח','עבור','מנוהל','באמצעות','תיקי','תיקים','בעמ']);

  function normHe(s) {
    return String(s || '').replace(/[״""“”]/g, '"').replace(/\s+/g, ' ').trim();
  }
  function fold(s) { return normHe(s).toLowerCase(); }

  function productOf(fund) {
    const c = normHe(fund && fund.classification);
    if (/חיסכון לילד|חסכון לילד/.test(c)) return 'child';
    if (/גמל להשקעה/.test(c)) return 'gemel-invest';
    if (/השתלמות/.test(c)) return 'hishtalmut';
    if (/מרכזית/.test(c)) return 'central-severance';
    if (/תגמולים|פיצויים/.test(c)) return 'gemel-savings';
    if ((fund && fund.source) === 'pensia' || /פנסיה|קרנות חדשות|קרנות כלליות|קרנות ותיקות/.test(c)) return 'pensia';
    if ((fund && fund.source) === 'bituach' || /פוליס/.test(c)) return 'policy';
    return 'other';
  }

  function holdingProduct(inv) {
    if (!inv) return null;
    const n = normHe(inv.name);
    const cat = inv.cat || '';
    if (cat === 'policy' || cat === 'bituach' || /פוליס|ביטוח מנהלים/.test(n)) return 'policy';
    if (cat === 'pensia' || (/פנסיה/.test(n) && !/גמל|השתלמות|קה"ש|קהש/.test(n))) return 'pensia';
    if (cat === 'gamel' || /גמל להשקעה/.test(n)) return 'gemel-invest';
    if (/השתלמות|קה"ש|קהש/.test(n)) return 'hishtalmut';
    if (cat === 'kupa' || /קופת גמל/.test(n)) return 'gemel-savings';
    return null;
  }

  function trackKindOfFund(fund) {
    const name = fold(fund && fund.name);
    const sub = fold(fund && fund.sub);
    const spec = fold(fund && fund.specialization);
    const blob = name + ' ' + sub + ' ' + spec;
    if (/s\s*&\s*p\s*500|s&p500|sp\s*500/.test(blob)) return 'sp500';
    if (/ת"א\s*35|ta\s*-?\s*35/.test(blob)) return 'ta35';
    if (/כספי/.test(sub) || /כספי/.test(name)) return 'cash';
    if (/מניות סחיר/.test(blob)) return 'stocks-tradable';
    if (sub === 'מניות' || /(?:מסלול|[-–])\s*מניות$/.test(name)) return 'stocks';
    if (sub === 'כללי' || /(?:מסלול|[-–])\s*כללי$/.test(name)) return 'klali';
    if (/אג"ח ממשלות/.test(blob) && !/מניות/.test(blob)) return 'bonds-gov';
    if ((sub === 'אג"ח' || /(?:מסלול|[-–])\s*אג"ח$/.test(name)) && !/מניות/.test(blob)) return 'bonds';
    return null;
  }

  function holdingTrackKind(track) {
    const t = normHe(track);
    if (t === 'S&P 500' || /^s\s*&\s*p\s*500$/i.test(t)) return 'sp500';
    if (t === 'ת"א 35') return 'ta35';
    if (t === 'מניות') return 'stocks';
    if (t === 'כללי') return 'klali';
    if (t === 'אגח' || t === 'אג"ח') return 'bonds';
    if (t === 'כספית' || t === 'כספי') return 'cash';
    return null;
  }

  function distinctive(inst) {
    return normHe(inst).split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4 && !STOP.has(fold(w)));
  }

  function tokens(s) {
    return normHe(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  }
  function hasToken(hay, token) {
    const t = fold(token);
    return tokens(hay).some(w => fold(w) === t);
  }
  /* Whole tokens only. "מור" is inside "למורים", and a substring match would
     attach the teachers' hishtalmut funds to a More holding. */
  function managerMatches(inst, fund) {
    const s = String(inst || '');
    const manager = (fund && fund.manager) || '';
    const name = (fund && fund.name) || '';
    const policy = fund && fund.source === 'bituach';
    const hay = policy ? manager + ' ' + name : manager;
    if (/מור|more/i.test(s)) return hasToken(hay, 'מור') || hasToken(hay, 'more');
    if (/ילין|לפידות/.test(s)) return hasToken(hay, 'ילין') || hasToken(hay, 'לפידות');
    const words = distinctive(s);
    if (!words.length) return false;
    return words.every(w => hasToken(manager, w));
  }

  function matchFund(inv, funds) {
    funds = funds || [];
    const product = holdingProduct(inv);
    const explicit = inv && inv.fundId != null && inv.fundId !== '' ? +inv.fundId : NaN;
    if (isFinite(explicit)) {
      let hits = funds.filter(f => +f.fundId === explicit);
      if (product) {
        const narrowed = hits.filter(f => productOf(f) === product);
        if (narrowed.length) hits = narrowed;
      }
      if (inv.inst) {
        const mgr = hits.filter(f => managerMatches(inv.inst, f));
        if (mgr.length) hits = mgr;
      }
      if (hits.length === 1) return {fund: hits[0], why: 'fundId'};
      if (hits.length > 1) return {fund: null, why: 'ambiguous'};
    }
    const kind = holdingTrackKind(inv && inv.track);
    if (!product || !kind) return {fund: null, why: !kind ? 'no-track' : 'private'};
    const mgrHits = funds.filter(f => productOf(f) === product && managerMatches(inv.inst, f));
    if (!mgrHits.length) return {fund: null, why: 'no-manager'};
    let kindHits;
    if (kind === 'bonds') {
      const gov = mgrHits.filter(f => trackKindOfFund(f) === 'bonds-gov');
      const plain = mgrHits.filter(f => trackKindOfFund(f) === 'bonds');
      kindHits = gov.length ? gov : plain;
    } else kindHits = mgrHits.filter(f => trackKindOfFund(f) === kind);
    if (kindHits.length > 1) kindHits = narrowByName(inv, kindHits);
    if (kindHits.length === 1) return {fund: kindHits[0], why: 'matched'};
    if (kindHits.length > 1) return {fund: null, why: 'ambiguous'};
    return {fund: null, why: 'no-fund'};
  }

  /* When one manager publishes two funds of the same kind (מקיפה vs כללית),
     keep the fund whose name shares a distinctive word with the holding name. */
  function narrowByName(inv, hits) {
    const skip = new Set(['מניות', 'כללי', 'כספית', 'כספי', 'אגח', 'אג"ח', normHe(inv && inv.track)]);
    const words = distinctive(inv && inv.name).filter(w => !skip.has(w) && !skip.has(fold(w)));
    if (!words.length) return hits;
    const scored = hits.map(f => ({f, n: words.filter(w => (f.name || '').includes(w)).length}));
    const best = Math.max(...scored.map(s => s.n));
    if (best <= 0) return hits;
    return scored.filter(s => s.n === best).map(s => s.f);
  }

  function clamp01(v) { v = +v || 0; return v < 0 ? 0 : v > 1 ? 1 : v; }

  function scaleInto(rest, bag, skip) {
    const parts = {};
    let s = 0;
    Object.entries(bag || {}).forEach(([k, v]) => {
      if (k === skip || !(v > 0)) return;
      parts[k] = v; s += v;
    });
    const out = {};
    if (!(rest > 0.015)) return out;
    if (!s) return null;
    Object.entries(parts).forEach(([k, v]) => { out[k] = rest * v / s; });
    return out;
  }

  function tidy(obj) {
    const out = {};
    let s = 0;
    Object.entries(obj).forEach(([k, v]) => { if (v > 0.005) { out[k] = v; s += v; } });
    if (!s) return {other: 1};
    Object.keys(out).forEach(k => { out[k] = out[k] / s; });
    return out;
  }

  /* Published fields override equity / Israel-vs-abroad / ILS-vs-FX.
     The residual (bonds vs cash vs other, and US vs Global, USD vs EUR)
     keeps the LOOK ratios, because the datasets do not publish that split. */
  function composePublic(base, fund) {
    base = base || {cls:{other:1}, geo:{IL:1}, ccy:{ILS:1}};
    const equity = clamp01(fund.stock);
    const rest = 1 - equity;
    let cls = {equity: equity};
    if (rest > 0.015) {
      const split = scaleInto(rest, base.cls, 'equity');
      if (split && Object.keys(split).length) Object.assign(cls, split);
      else cls.bonds = rest;
    }
    const abroad = clamp01(fund.foreign);
    const il = 1 - abroad;
    let geo = {IL: il};
    if (abroad > 0.015) {
      const split = scaleInto(abroad, base.geo, 'IL');
      if (split && Object.keys(split).length) Object.assign(geo, split);
      else geo.Global = abroad;
    }
    const fx = clamp01(fund.fx);
    const ils = 1 - fx;
    let ccy = {ILS: ils};
    if (fx > 0.015) {
      const split = scaleInto(fx, base.ccy, 'ILS');
      if (split && Object.keys(split).length) Object.assign(ccy, split);
      else ccy.USD = fx;
    }
    return {cls: tidy(cls), geo: tidy(geo), ccy: tidy(ccy)};
  }

  function periodLabel(period) {
    const p = String(period || '');
    if (/^\d{6}$/.test(p)) return p.slice(4, 6) + '/' + p.slice(0, 4);
    return p;
  }

  function sourceLabel(pub) {
    if (!pub) return {kind:'assume', text:'מקור: הנחה במערכת'};
    const src = SRC_HE[pub.source] || 'נתונים ציבוריים';
    return {kind:'public', text:'מקור: נתונים ציבוריים (' + periodLabel(pub.period) + ')', source: src};
  }

  function fromCkan(source, row) {
    const assets = +row.TOTAL_ASSETS || 0;
    if (!(assets > 0)) return null;
    const ratio = v => (+v || 0) / assets;
    return {
      source: source,
      fundId: +row.FUND_ID,
      name: row.FUND_NAME || '',
      manager: row.MANAGING_CORPORATION || row.PARENT_COMPANY_NAME || '',
      classification: row.FUND_CLASSIFICATION || '',
      specialization: row.SPECIALIZATION || '',
      sub: row.SUB_SPECIALIZATION || '',
      period: +row.REPORT_PERIOD || 0,
      stock: ratio(row.STOCK_MARKET_EXPOSURE),
      foreign: ratio(row.FOREIGN_EXPOSURE),
      fx: ratio(row.FOREIGN_CURRENCY_EXPOSURE),
      liquid: (+row.LIQUID_ASSETS_PERCENT || 0) / 100
    };
  }

  const WHY_HE = {
    'no-track': 'אין מסלול בשם הזה במאגר הציבורי',
    'private': 'אחזקה בלי מוצר מפורסם (ברוקר, בנק, קריפטו או מזומן)',
    'no-manager': 'הגוף המנהל לא נמצא במאגר לחודש הזה',
    'no-fund': 'לא נמצא מסלול מפורסם תואם אצל הגוף',
    'ambiguous': 'כמה מסלולים תואמים — נשארה ההנחה',
    'fundId': 'הותאם לפי מספר קופה'
  };

  return {
    SRC_HE, normHe, productOf, holdingProduct, trackKindOfFund, holdingTrackKind,
    managerMatches, matchFund, composePublic, periodLabel, sourceLabel, fromCkan, WHY_HE
  };
});
