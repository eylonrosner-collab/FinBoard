/* FinBoard v2 — Pension tab (כרטסת פנסיה).
   Pure helpers: normalize the Mislaka-derived pension document, derive alerts,
   and build fictitious demo data. Rendering lives in index.html (renderPension).
   No real data ships in this file. Real data is read only from the encrypted
   Gist file pension.json. */
(function (root) {
  'use strict';
  const INCLUDE = new Set(['pension_fund', 'manager_insurance', 'risk_policy', 'collective_risk', 'mortgage_life']);
  const EXCLUDE = new Set(['hishtalmut', 'gemel', 'gemel_lehashkaa']); // already tracked as savings channels in FinBoard
  const DISPLAY = { eylon: 'אילון', sharon: 'שרון', dani: 'דני', michal: 'מיכל' };
  const num = v => (v == null || v === '' || !isFinite(+v)) ? null : +v;
  const sumOf = (arr, f) => arr.reduce((a, x) => a + (num(f(x)) || 0), 0);

  function kindOf(p) {
    const t = String(p.product_type || '');
    if (t === 'savings_policy' && /מנהלים/.test(String(p.plan_name || ''))) return 'manager_insurance';
    return t;
  }
  function isActive(p) { return !/cancel|מבוטל/i.test(String(p.status || '')); }
  function coverages(p) { return (p.insurance && Array.isArray(p.insurance.coverages)) ? p.insurance.coverages : []; }
  function deathSum(p) {
    const c = coverages(p);
    const basic = c.find(x => x.coverage_type_code === 'death_basic');
    if (basic && num(basic.sum_insured)) return num(basic.sum_insured);
    return sumOf(c.filter(x => /death|מוות/i.test(String(x.coverage_type || ''))), x => x.sum_insured);
  }
  function lossOfWork(p) { // אכ"ע monthly benefit from a private/collective policy
    return sumOf(coverages(p).filter(x => /אכ"ע|work capacity|collective_5/i.test(String(x.coverage_type || x.coverage_type_code || '')) && !/rider/i.test(String(x.coverage_type || ''))), x => x.sum_insured);
  }
  function premium(p) { return sumOf(coverages(p), x => x.premium_monthly); }

  /* Returns {people:[{key,name,birth,marital,products:[…]}], joint:[…], excluded:n, notes:[]} */
  function normalize(doc) {
    const out = { people: [], joint: [], excluded: 0, notes: [], asOf: null, alerts: [] };
    if (!doc || typeof doc !== 'object' || !doc.people) return out;
    const seenJoint = new Set();
    for (const key of Object.keys(doc.people)) {
      const src = doc.people[key] || {};
      const person = { key, name: src.display_name || DISPLAY[key] || src.name || key, birth: src.birth_date || null,
        gender: src.gender || null, marital: src.marital_status_code_in_pension_fund || null, products: [] };
      for (const raw of (src.products || [])) {
        const kind = kindOf(raw);
        if (EXCLUDE.has(kind) || !INCLUDE.has(kind)) { out.excluded++; continue; }
        if (raw.report_date && (!out.asOf || raw.report_date > out.asOf)) out.asOf = raw.report_date;
        const p = Object.assign({}, raw, { kind, owner: key, ownerName: person.name, active: isActive(raw),
          death: deathSum(raw), lossOfWork: lossOfWork(raw), premium: premium(raw) });
        if (kind === 'mortgage_life' || raw.joint_policy) {
          const id = raw.account_masked || JSON.stringify(raw.insurance || {});
          if (seenJoint.has(id)) continue;
          seenJoint.add(id); out.joint.push(p); continue;
        }
        person.products.push(p);
      }
      out.people.push(person);
    }
    out.notes = Array.isArray(doc.household_notes) ? doc.household_notes.slice() : [];
    out.alerts = deriveAlerts(out).concat((doc.alerts || []).map(a => Object.assign({ level: 'warn' }, a)));
    return out;
  }

  function personStats(person) {
    const ps = person.products;
    const funds = ps.filter(p => p.kind === 'pension_fund');
    const mgr = ps.filter(p => p.kind === 'manager_insurance');
    const pf = funds.map(p => (p.insurance && p.insurance.pension_fund) || {});
    return {
      balance: sumOf(funds.concat(mgr), p => p.balance),
      fundBalance: sumOf(funds, p => p.balance), mgrBalance: sumOf(mgr, p => p.balance),
      withDep: sumOf(ps, p => p.projection && p.projection.monthly_pension_with_deposits),
      noDep: sumOf(ps, p => p.projection && p.projection.monthly_pension_no_deposits),
      disabilityFund: sumOf(pf, x => x.disability_monthly),
      insuredSalary: sumOf(pf, x => x.insured_salary),
      lossOfWork: sumOf(ps.filter(p => p.active && p.kind !== 'pension_fund'), p => p.lossOfWork),
      spouse: sumOf(pf, x => x.survivors_spouse_monthly), orphan: sumOf(pf, x => x.survivors_orphan_monthly),
      parent: sumOf(pf, x => x.survivors_parent_monthly),
      death: sumOf(ps.filter(p => p.active && p.kind !== 'pension_fund'), p => p.death),
      fundInsCost: sumOf(pf, x => (num(x.disability_cost_monthly) || 0) + (num(x.survivors_cost_monthly) || 0) + (num(x.waiver_of_premium_cost_monthly) || 0)),
      policyPremium: sumOf(ps.filter(p => p.active), p => p.premium),
      claims: ps.reduce((a, p) => a.concat((p.claims || []).map(c => Object.assign({ product: p }, c))), [])
    };
  }

  function deriveAlerts(n) {
    const A = [];
    for (const person of n.people) {
      const st = personStats(person);
      if (st.claims.length) {
        const accs = [...new Set(st.claims.map(c => c.product.account_masked).filter(Boolean))].join(', ');
        A.push({ level: 'err', who: person.key, title: `${person.name}: תביעה פתוחה — לא להעביר ולא לבטל`,
          body: `יש תביעה פעילה במוצרים ${accs}. העברה, ביטול או הקפאה של המוצרים האלה עלולים לפגוע בתביעה ובתשלום החודשי. כל שינוי רק אחרי בירור מול הגוף המנהל.` });
      }
      if (st.disabilityFund > 0 && st.lossOfWork > 0 && !st.claims.length) { // never nudge cancelling cover that is paying a claim
        const tot = st.disabilityFund + st.lossOfWork;
        A.push({ level: 'warn', who: person.key, title: `${person.name}: ייתכן כפל ביטוח אובדן כושר עבודה`,
          body: `קרן הפנסיה מבטחת נכות בכ-₪${Math.round(st.disabilityFund).toLocaleString('he-IL')} לחודש, ופוליסת אכ"ע נוספת מוסיפה ₪${Math.round(st.lossOfWork).toLocaleString('he-IL')}. יחד כ-₪${Math.round(tot).toLocaleString('he-IL')}${st.insuredSalary ? `, מול שכר מבוטח של כ-₪${Math.round(st.insuredSalary).toLocaleString('he-IL')}` : ''}. מבטחים בדרך כלל מקזזים מעל 75%–100% מההכנסה. כדאי לבדוק סעיף קיזוז בפוליסה לפני שממשיכים לשלם עליה.` });
      }
      for (const p of person.products) {
        if (p.active && p.kind === 'risk_policy' && p.death > 0 && !(p.beneficiaries && p.beneficiaries.count > 0)) {
          A.push({ level: 'warn', who: person.key, title: `${person.name}: אין מוטבים בפוליסת ריסק ${p.account_masked || ''}`,
            body: `בפוליסה (${p.manager || ''}) סכום ביטוח של כ-₪${Math.round(p.death).toLocaleString('he-IL')}, אבל בן/בת הזוג והילדים רשומים ב-0%, כך שהכסף ישולם ליורשים על פי דין. כדאי לרשום מוטבים במפורש.` });
        }
      }
    }
    const codes = n.people.filter(p => p.marital);
    if (codes.length > 1 && new Set(codes.map(p => p.marital)).size > 1) {
      const odd = codes.filter(p => p.marital === '1');
      for (const p of odd) A.push({ level: 'warn', who: p.key, title: `${p.name}: מצב משפחתי בקרן הפנסיה לא תואם`,
        body: `בקרן של ${p.name} רשום קוד מצב משפחתי ${p.marital} (כנראה רווק/ה), ואצל בן/בת הזוג רשום ${codes.find(x => x !== p).marital} (נשוי/אה). אם אתם נשואים או ידועים בציבור, צריך לעדכן את הקרן — אחרת קצבת השאירים לבן/בת הזוג עלולה לא להשתלם.` });
    }
    return A;
  }

  /* Plain-Hebrew explanations, shown next to each coverage */
  const EXPLAIN = {
    disability: 'נכות / אובדן כושר עבודה: אם לא תוכל/י לעבוד בגלל מחלה או תאונה, תשולם קצבה חודשית עד גיל הפרישה, וגם ההפקדות לפנסיה ממשיכות. בקרן הפנסיה זה עד 75% מהשכר המבוטח.',
    lossOfWork: 'ביטוח אובדן כושר עבודה (אכ"ע) פרטי או קבוצתי: מוסיף קצבה חודשית מעבר לקרן הפנסיה. בדרך כלל יש תקרה כוללת של 75%–100% מההכנסה, ולכן ביטוח כפול לא תמיד משלם פעמיים.',
    spouse: 'קצבת שאירים לבן/בת זוג: אם המבוטח/ת נפטר/ת לפני הפרישה, בן/בת הזוג יקבל/תקבל קצבה חודשית לכל החיים.',
    orphan: 'קצבת יתומים: קצבה חודשית לילדים עד גיל 21 (לילד נכה — לכל החיים).',
    parent: 'קצבת הורה נתמך: להורה שהיה תלוי כלכלית במבוטח/ת.',
    death: 'סכום ביטוח במוות (ריסק): תשלום חד-פעמי למוטבים אם המבוטח/ת נפטר/ת בתקופת הביטוח.',
    waiver: 'שחרור מתשלום פרמיה: אם לא ניתן לעבוד, חברת הביטוח ממשיכה להפקיד במקומך, כך שהחיסכון והכיסויים נשמרים.',
    mortgage: 'ביטוח חיים למשכנתא: אם אחד מבני הזוג נפטר, הביטוח מסלק את יתרת המשכנתא לבנק. הפוליסה משותפת ומוצגת פעם אחת.',
    projection: 'קצבה חזויה: לפי ההנחות של הגוף המנהל (תשואה ומקדם המרה). "עם הפקדות" מניח שההפקדות נמשכות עד הפרישה; "בלי הפקדות" — רק מה שכבר נצבר. הסכומים ברוטו, לפני מס.',
    fees: 'דמי ניהול: אחוז מהצבירה בשנה ואחוז מכל הפקדה. בקרן פנסיה טוב: עד כ-0.2% מצבירה ועד כ-1.5% מהפקדה.'
  };

  function demoDoc() {
    const pf = (o) => Object.assign({ track: 'מסלול בסיסי', disability_pct_salary: 75, membership_months: 120 }, o);
    return {
      generated_from: 'נתוני הדגמה בדויים',
      people: {
        dani: { display_name: 'דני', birth_date: '1980-05-10', gender: 'M', marital_status_code_in_pension_fund: '2', products: [
          { product_type: 'pension_fund', product_type_he: 'קרן פנסיה חדשה', manager: 'קרן הדגמה א׳', plan_name: 'פנסיה מקיפה (דמו)', account_masked: '****1111', status: 'active', balance: 640000, report_date: '2026-09-30',
            fees: { balance_pct: 0.12, deposit_pct: 1.4 }, projection: { retirement_age: 67, monthly_pension_with_deposits: 14200, monthly_pension_no_deposits: 6100, assumed_return_pct: 3.7 },
            insurance: { pension_fund: pf({ insured_salary: 22000, disability_monthly: 16500, survivors_spouse_monthly: 9900, survivors_orphan_monthly: 6600, survivors_parent_monthly: 3300, disability_cost_monthly: 310, survivors_cost_monthly: 95, waiver_of_premium_cost_monthly: 60 }), coverages: [] }, claims: [], beneficiaries: { count: 0 } },
          { product_type: 'savings_policy', product_type_he: 'פוליסת חיסכון', manager: 'מבטח הדגמה', plan_name: 'פרופיל למנהלים (דמו)', account_masked: '****2222', status: 'active', balance: 210000, report_date: '2026-09-30',
            fees: { balance_pct: 0.5, deposit_pct: 1.5 }, insurance: { coverages: [{ coverage_type_code: 'death_basic', coverage_type: 'death_basic', sum_insured: 210000 }] }, claims: [], beneficiaries: { count: 1 } },
          { product_type: 'risk_policy', product_type_he: 'ריסק טהור', manager: 'מבטח הדגמה', plan_name: 'ריסק (דמו)', account_masked: '****3333', status: 'active', report_date: '2026-09-30',
            insurance: { coverages: [{ coverage_type: 'death (ריסק מוות)', premium_monthly: 120, sum_insured: 0 }, { coverage_type_code: 'death_basic', coverage_type: 'death_basic', sum_insured: 900000 }] }, claims: [], beneficiaries: { count: 0 } },
          { product_type: 'collective_risk', product_type_he: 'ריסק קולקטיב', manager: 'מבטח הדגמה', plan_name: 'אכ"ע קבוצתי (דמו)', account_masked: '****4444', status: 'not_applicable (collective)',
            insurance: { coverages: [{ coverage_type_code: 'collective_5', coverage_type: 'collective_5', sum_insured: 12000, premium_monthly: 210 }] }, claims: [] },
          { product_type: 'mortgage_life', product_type_he: 'ביטוח חיים משכנתא', manager: 'מבטח הדגמה', plan_name: 'ביטוח משכנתא (דמו)', account_masked: '****5555', status: 'active', joint_policy: true,
            insurance: { coverages: [{ coverage_type_code: 'death_basic', coverage_type: 'death_basic', sum_insured: 480000 }, { coverage_type: 'death (ריסק מוות)', premium_monthly: 140, sum_insured: 0 }] } },
          { product_type: 'hishtalmut', plan_name: 'לא מוצג — כבר באתר', balance: 1 }
        ] },
        michal: { display_name: 'מיכל', birth_date: '1982-08-22', gender: 'F', marital_status_code_in_pension_fund: '1', products: [
          { product_type: 'pension_fund', product_type_he: 'קרן פנסיה חדשה', manager: 'קרן הדגמה ב׳', plan_name: 'פנסיה מקיפה (דמו)', account_masked: '****6666', status: 'active', balance: 410000, report_date: '2026-09-30',
            fees: { balance_pct: 0.2, deposit_pct: 1.7 }, projection: { retirement_age: 67, monthly_pension_with_deposits: 9100, monthly_pension_no_deposits: 4300, assumed_return_pct: 3.7 },
            insurance: { pension_fund: pf({ insured_salary: 15000, disability_monthly: 11250, survivors_spouse_monthly: 6000, survivors_orphan_monthly: 4000, survivors_parent_monthly: 2000, disability_cost_monthly: 180, survivors_cost_monthly: 70, waiver_of_premium_cost_monthly: 40 }), coverages: [] },
            claims: [{ claim_type_code: '3', status_code: '1', payment_start: '2026-02-01', coverage_name: 'שחרור מתשלום (דמו)' }], beneficiaries: { count: 0 } },
          { product_type: 'manager_insurance', product_type_he: 'ביטוח מנהלים', manager: 'מבטח הדגמה', plan_name: 'מנהלים (דמו)', account_masked: '****7777', status: 'active', balance: 35000, report_date: '2026-09-30',
            fees: { balance_pct: 1.05, deposit_pct: 2 }, projection: { retirement_age: 67, monthly_pension_with_deposits: 300, monthly_pension_no_deposits: 180 },
            insurance: { coverages: [{ coverage_type: 'loss of work capacity (אכ"ע)', sum_insured: 9000, premium_monthly: 260 }, { coverage_type_code: 'death_basic', coverage_type: 'death_basic', sum_insured: 35000 }] },
            claims: [{ claim_type_code: '3', status_code: '1', payment_start: '2026-02-15', approved_amount: 4500, disability_pct: 50, coverage_name: 'אובדן כושר עבודה (דמו)' }], beneficiaries: { count: 1 } },
          { product_type: 'mortgage_life', product_type_he: 'ביטוח חיים משכנתא', manager: 'מבטח הדגמה', plan_name: 'ביטוח משכנתא (דמו)', account_masked: '****5555', status: 'active', joint_policy: true,
            insurance: { coverages: [{ coverage_type_code: 'death_basic', coverage_type: 'death_basic', sum_insured: 480000 }] } },
          { product_type: 'gemel', plan_name: 'לא מוצג — כבר באתר', balance: 1 }
        ] }
      },
      household_notes: ['נתוני הדגמה בדויים — לא קשורים לאדם אמיתי.']
    };
  }

  function validate(doc) {
    if (!doc || typeof doc !== 'object' || !doc.people || typeof doc.people !== 'object') return 'הקובץ לא במבנה של pension.json (חסר people)';
    const keys = Object.keys(doc.people);
    if (!keys.length) return 'אין אנשים בקובץ';
    if (keys.some(k => !Array.isArray((doc.people[k] || {}).products))) return 'לכל אדם צריך להיות products';
    if (/"\d{9}"/.test(JSON.stringify(doc).replace(/"(manager_id|employer_no)":"\d{9}"/g, ''))) return 'נראה שבקובץ יש מספר זהות או חשבון מלא (9 ספרות). העלו את הגרסה הממוסכת.';
    return '';
  }

  const api = { normalize, personStats, deriveAlerts, demoDoc, validate, EXPLAIN, INCLUDE, EXCLUDE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.FinPension = api;
})(typeof window !== 'undefined' ? window : globalThis);
