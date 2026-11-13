#!/usr/bin/env python3
"""Build v2/tase-prices.json from the Tel Aviv Stock Exchange site.

The browser on GitHub Pages cannot call these endpoints: the exchange firewall
only answers when Origin and Referer are the TASE site, which page JavaScript
cannot set. This script runs in GitHub Actions (or locally) and writes a
public snapshot of the whole market. It is not a list of anyone's holdings.

Traded securities (stocks, ETFs, bonds) use the adjusted closing price
(שער נעילה מתואם) from api.tase.co.il. Mutual funds use the redemption price
(מחיר פדיון) from maya.tase.co.il. The page computes YTD and 12-month returns
from the prices kept here.
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'v2' / 'tase-prices.json'
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
EXAMPLES = ('1159250', '5112628')


def http_post(url, payload, origin, timeout=45):
    body = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='POST', headers={
        'User-Agent': UA,
        'Origin': origin,
        'Referer': origin + '/',
        'Accept': 'text/csv,application/json,*/*',
        'Accept-Language': 'he-IL',
        'Content-Type': 'application/json',
    })
    with urllib.request.urlopen(req, timeout=timeout) as res:
        raw = res.read()
        ctype = res.headers.get('content-type', '')
    return raw, ctype


def http_get(url, origin, timeout=45):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA,
        'Origin': origin,
        'Referer': origin + '/',
        'Accept': 'application/json',
        'Accept-Language': 'he-IL',
    })
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


def parse_date(text):
    s = (text or '').strip()[:10]
    for fmt in ('%d/%m/%Y', '%d.%m.%Y', '%Y-%m-%d'):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def parse_price(text):
    s = (text or '').strip().replace(',', '')
    if not s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    if not math.isfinite(v) or v <= 0:
        return None
    return v


def parse_series(text, kind):
    """Return [(date, price), ...] from a TASE history CSV.

    kind 'c' reads שער נעילה מתואם. kind 'r' reads מחיר פדיון.
    Column order differs between stocks and ETFs, so names are matched.
    """
    if isinstance(text, bytes):
        text = text.decode('utf-8-sig', errors='replace')
    lines = text.splitlines()
    header_i = None
    for i, line in enumerate(lines):
        if 'תאריך' in line and ('פדיון' in line or 'נעילה' in line or 'מתואם' in line):
            header_i = i
            break
    if header_i is None:
        return []
    header = next(csv.reader([lines[header_i]]))

    def col(pred):
        for i, cell in enumerate(header):
            if pred(cell.strip()):
                return i
        return None

    i_date = col(lambda h: h.startswith('תאריך'))
    if kind == 'r':
        i_px = col(lambda h: 'מחיר פדיון' in h)
    else:
        i_px = col(lambda h: h.startswith('שער נעילה מתואם'))
        if i_px is None:
            i_px = col(lambda h: h.startswith('שער נעילה') and 'אגורות' not in h)
    if i_date is None or i_px is None:
        return []
    out = []
    for line in lines[header_i + 1:]:
        if not line.strip():
            continue
        cells = next(csv.reader([line]))
        if len(cells) <= max(i_date, i_px):
            continue
        d = parse_date(cells[i_date])
        px = parse_price(cells[i_px])
        if d and px is not None:
            out.append((d, px))
    out.sort(key=lambda r: r[0])
    return out


def pack_price(v):
    if abs(v - round(v)) < 1e-6:
        return int(round(v))
    return round(v, 4)


def ymd(d):
    return d.year * 10000 + d.month * 100 + d.day


def shift_year(d, years):
    try:
        return d.replace(year=d.year + years)
    except ValueError:
        return d.replace(year=d.year + years, day=28)


def keep_points(points):
    """Keep the closes the page needs: the latest print, the last sessions of
    the previous December, and the sessions around one year before the latest
    print. The page applies the same selection rules as v2/returns.js."""
    if not points:
        return []
    last = points[-1][0]
    target = shift_year(last, -1)
    december = [p for p in points if p[0].year == last.year - 1 and p[0].month == 12]
    window = [p for p in points if target - timedelta(days=18) <= p[0] <= target]
    recent = points[-3:]
    chosen = {}
    for p in december[-6:] + window + recent:
        chosen[p[0]] = p[1]
    return [[ymd(d), pack_price(chosen[d])] for d in sorted(chosen)]


def clean_name(name):
    s = ' '.join(str(name or '').split())
    return s[:80]


def universe(rows):
    """Type 1 is a traded security. Type 4 is a mutual fund. Ids do not overlap."""
    out = {}
    for row in rows:
        kind_n = row.get('Type')
        if kind_n not in (1, 4):
            continue
        sid = str(row.get('Id') or '').strip()
        if not sid.isdigit():
            continue
        sid = str(int(sid))
        name = clean_name(row.get('Name'))
        if not name:
            continue
        out[sid] = {'n': name, 'k': 'r' if kind_n == 4 else 'c'}
    return out


def parse_security_json(raw):
    data = json.loads(raw)
    rows = data.get('Data') if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return []
    out = []
    for row in rows:
        d = parse_date(str(row.get('TradeDate') or ''))
        px = row.get('AdjustmentRate')
        if not isinstance(px, (int, float)) or px <= 0:
            px = row.get('CloseRate')
        if d and isinstance(px, (int, float)) and px > 0 and math.isfinite(px):
            out.append((d, float(px)))
    out.sort(key=lambda r: r[0])
    return out


def fetch_one(sid, kind, today):
    if kind == 'r':
        start = today - timedelta(days=450)
        raw, _ = http_post(
            f'https://maya.tase.co.il/api/v1/funds/mutual/{sid}/history/file',
            {
                'pageSize': 30,
                'pageNumber': 1,
                'period': 4,
                'fromDate': start.isoformat() + 'T00:00:00.000Z',
                'toDate': today.isoformat() + 'T00:00:00.000Z',
            },
            'https://maya.tase.co.il',
        )
    else:
        raw, _ = http_post(
            'https://api.tase.co.il/api/export/securityhistoryeod',
            {
                'FilterData': {
                    'pType': '5',
                    'TotalRec': 1,
                    'pageNum': 1,
                    'oId': sid.zfill(8),
                    'lang': '0',
                },
                'isAdd': False,
                'callerName': 'security-history-eod',
            },
            'https://market.tase.co.il',
        )
    if raw[:1] == b'<':
        raise RuntimeError('html from the exchange')
    if raw[:1] == b'{':
        series = parse_security_json(raw) if kind == 'c' else []
        if series:
            return series
        raise RuntimeError('price file had no rows')
    return parse_series(raw, kind)


def load_old(path):
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}
    items = data.get('items') if isinstance(data, dict) else None
    return items if isinstance(items, dict) else {}


def write_book(path, items):
    book = {
        'v': 1,
        'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'about': 'Public TASE adjusted closes and mutual-fund redemption prices. Not a portfolio.',
        'items': items,
    }
    text = json.dumps(book, ensure_ascii=False, separators=(',', ':'))
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.json.tmp')
    tmp.write_text(text, encoding='utf-8')
    tmp.replace(path)


def self_test():
    stock = (
        'נתונים היסטוריים - סוף יום דוגמה\r\n'
        'מתאריך 14/11/2024  עד תאריך 13/11/2026\r\n'
        'תאריך,שער נעילה מתואם,סוג שער מתואם,שער נעילה (באגורות)\r\n'
        '13/11/2026,121.0000,שער נעילה,121.0000\r\n'
        '31/12/2025,110.0000,שער נעילה,110.0000\r\n'
        '13/11/2025,100.0000,שער נעילה,100.0000\r\n'
    )
    etf = (
        'כותרת\r\n'
        'תאריך,סטטוס מצב ני\'\'ע ליום מסחר,שער נעילה מתואם,סוג שער מתואם,שער נעילה (באגורות)\r\n'
        '13/11/2026,,263500.0000,שער נעילה,263500.0000\r\n'
        '31/12/2025,,250000.0000,שער נעילה,250000.0000\r\n'
    )
    fund = (
        'מס\' קרן,תאריך,מחיר קניה,מחיר פדיון\r\n'
        '05112628,12.11.2026,418.27,418.27\r\n'
        '05112628,31.12.2025,400.00,390.50\r\n'
        '05112628,12.11.2025,370.00,360.00\r\n'
    )
    s = parse_series(stock, 'c')
    assert s == [(date(2025, 11, 13), 100.0), (date(2025, 12, 31), 110.0), (date(2026, 11, 13), 121.0)], s
    e = parse_series(etf, 'c')
    assert e[0] == (date(2025, 12, 31), 250000.0) and e[-1][1] == 263500.0, e
    f = parse_series(fund, 'r')
    assert f[-1] == (date(2026, 11, 12), 418.27), f
    assert f[1][1] == 390.5
    kept = keep_points(s)
    assert [20251113, 20251231, 20261113] == [p[0] for p in kept], kept
    rows = [
        {'Id': '01159250', 'Name': '  איישרס   ', 'Type': 1},
        {'Id': '5112628', 'Name': 'איביאי', 'Type': 4},
        {'Id': '100', 'Name': 'חברה', 'Type': 5},
        {'Id': '9', 'Name': 'נמחק', 'Type': 14},
    ]
    uni = universe(rows)
    assert uni['1159250']['k'] == 'c' and uni['1159250']['n'] == 'איישרס', uni
    assert uni['5112628']['k'] == 'r'
    assert set(uni) == {'1159250', '5112628'}
    js = parse_security_json(json.dumps({
        'Data': [
            {'TradeDate': '13/11/2026', 'AdjustmentRate': 121, 'CloseRate': 121},
            {'TradeDate': '31/12/2025', 'AdjustmentRate': None, 'CloseRate': 110},
            {'TradeDate': '13/11/2025', 'AdjustmentRate': 0, 'CloseRate': 100},
        ]
    }).encode())
    assert js == [(date(2025, 11, 13), 100.0), (date(2025, 12, 31), 110.0), (date(2026, 11, 13), 121.0)], js
    print('ok fetch_tase_prices self-test')


def main():
    parser = argparse.ArgumentParser(description='Refresh the public TASE price snapshot')
    parser.add_argument('--self-test', action='store_true')
    parser.add_argument('--limit', type=int, default=0, help='fetch only this many ids (debug)')
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--out', type=Path, default=OUT)
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return

    today = datetime.now(timezone.utc).date()
    print('listing securities', flush=True)
    raw = http_get('https://api.tase.co.il/api/content/searchentities?lang=0', 'https://market.tase.co.il')
    listed = universe(json.loads(raw.decode('utf-8')))
    ids = sorted(listed, key=lambda s: int(s))
    if args.limit:
        prefer = [i for i in EXAMPLES if i in listed]
        rest = [i for i in ids if i not in prefer]
        ids = (prefer + rest)[:args.limit]
    print(f'universe {len(listed)} fetching {len(ids)}', flush=True)
    old = load_old(args.out)
    items = {}
    failed = []
    lock = threading.Lock()
    done = {'n': 0}
    started = time.time()

    def job(sid):
        meta = listed[sid]
        last_err = None
        for attempt in range(4):
            try:
                series = fetch_one(sid, meta['k'], today)
                points = keep_points(series)
                if not points:
                    raise RuntimeError('no prices')
                return sid, {'n': meta['n'], 'k': meta['k'], 'p': points}, None
            except Exception as exc:
                last_err = exc
                time.sleep(0.6 * (attempt + 1))
        return sid, None, last_err

    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        futures = [pool.submit(job, sid) for sid in ids]
        for fut in as_completed(futures):
            sid, row, err = fut.result()
            with lock:
                done['n'] += 1
                n = done['n']
                if row:
                    items[sid] = row
                elif sid in old and isinstance(old[sid], dict) and old[sid].get('p'):
                    items[sid] = old[sid]
                else:
                    failed.append(sid)
                if n % 100 == 0 or n == len(ids):
                    elapsed = time.time() - started
                    rate = n / elapsed if elapsed else 0
                    print(f'{n}/{len(ids)} ok {len(items)} failed {len(failed)} {rate:.1f}/s', flush=True)

    ordered = {sid: items[sid] for sid in sorted(items, key=lambda s: int(s))}
    missing_examples = [sid for sid in EXAMPLES if sid not in ordered and (not args.limit or sid in ids)]
    coverage = len(ordered) / len(ids) if ids else 0
    if missing_examples or coverage < 0.7:
        print(f'refusing to publish coverage {coverage:.2%} missing {missing_examples} failed {len(failed)}', file=sys.stderr)
        sys.exit(1)
    write_book(args.out, ordered)
    print(f'wrote {args.out} items {len(ordered)} failed {len(failed)} bytes {args.out.stat().st_size}')


if __name__ == '__main__':
    main()
