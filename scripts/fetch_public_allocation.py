#!/usr/bin/env python3
"""Fetch the latest public asset-exposure rows from data.gov.il into v2/public-allocation.json.

Sources: Gemel-Net, Pensia-Net, Bituach-Net (Capital Market Authority), via the CKAN datastore API.
Writes fund-level stock / foreign / FX exposure only. No personal holdings or account numbers.
"""
from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "v2" / "public-allocation.json"
API = "https://data.gov.il/api/3/action/"
UA = "FinBoard-public-allocation/1.0"

# package name on data.gov.il, and the columns that exist on that resource.
SOURCES = [
    {
        "id": "gemelnet",
        "package": "gemelnet",
        "title": "גמל-נט",
        "dataset": "https://data.gov.il/dataset/gemelnet",
        "fields": [
            "FUND_ID", "FUND_NAME", "MANAGING_CORPORATION", "FUND_CLASSIFICATION",
            "SPECIALIZATION", "SUB_SPECIALIZATION", "REPORT_PERIOD", "TOTAL_ASSETS",
            "STOCK_MARKET_EXPOSURE", "FOREIGN_EXPOSURE", "FOREIGN_CURRENCY_EXPOSURE",
            "LIQUID_ASSETS_PERCENT",
        ],
    },
    {
        "id": "pensia",
        "package": "pensia-net",
        "title": "פנסיה-נט",
        "dataset": "https://data.gov.il/dataset/pensia-net",
        "fields": [
            "FUND_ID", "FUND_NAME", "MANAGING_CORPORATION", "FUND_CLASSIFICATION",
            "REPORT_PERIOD", "TOTAL_ASSETS", "STOCK_MARKET_EXPOSURE", "FOREIGN_EXPOSURE",
            "FOREIGN_CURRENCY_EXPOSURE", "LIQUID_ASSETS_PERCENT",
        ],
    },
    {
        "id": "bituach",
        "package": "insurance",
        "title": "ביטוח-נט",
        "dataset": "https://data.gov.il/dataset/insurance",
        "fields": [
            "FUND_ID", "FUND_NAME", "PARENT_COMPANY_NAME", "FUND_CLASSIFICATION",
            "REPORT_PERIOD", "TOTAL_ASSETS", "STOCK_MARKET_EXPOSURE", "FOREIGN_EXPOSURE",
            "FOREIGN_CURRENCY_EXPOSURE", "LIQUID_ASSETS_PERCENT",
        ],
    },
]


def get(action: str, params: dict) -> dict:
    url = API + action + "?" + urllib.parse.urlencode(params)
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=90) as res:
                payload = json.load(res)
            if not payload.get("success"):
                raise RuntimeError(f"{action} success=false")
            return payload["result"]
        except Exception as exc:  # noqa: BLE001 — retry network and CKAN glitches
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"{action} failed: {last}")


def latest_resource(package: str) -> dict:
    pkg = get("package_show", {"id": package})
    resources = [r for r in pkg.get("resources", []) if r.get("datastore_active") and str(r.get("format", "")).upper() == "CSV"]
    if not resources:
        raise RuntimeError(f"no datastore CSV on {package}")
    today = [r for r in resources if "היום" in (r.get("name") or "")]
    chosen = today[-1] if today else resources[-1]
    return {"id": chosen["id"], "name": chosen.get("name") or ""}


def latest_period(resource_id: str) -> int:
    result = get("datastore_search", {
        "resource_id": resource_id,
        "limit": 1,
        "sort": "REPORT_PERIOD desc",
        "fields": "REPORT_PERIOD",
    })
    rows = result.get("records") or []
    if not rows:
        raise RuntimeError(f"no rows in {resource_id}")
    return int(rows[0]["REPORT_PERIOD"])


def page_period(resource_id: str, period: int, fields: list[str]) -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        result = get("datastore_search", {
            "resource_id": resource_id,
            "filters": json.dumps({"REPORT_PERIOD": period}, ensure_ascii=False),
            "fields": ",".join(fields),
            "limit": 1000,
            "offset": offset,
        })
        batch = result.get("records") or []
        rows.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return rows


def ratio(num, den) -> float:
    den = float(den or 0)
    if den <= 0:
        return 0.0
    return float(num or 0) / den


def normalize(source_id: str, row: dict, period: int) -> dict | None:
    assets = float(row.get("TOTAL_ASSETS") or 0)
    if assets <= 0 or row.get("FUND_ID") in (None, ""):
        return None
    fund = {
        "source": source_id,
        "fundId": int(float(row["FUND_ID"])),
        "name": row.get("FUND_NAME") or "",
        "manager": row.get("MANAGING_CORPORATION") or row.get("PARENT_COMPANY_NAME") or "",
        "classification": row.get("FUND_CLASSIFICATION") or "",
        "specialization": row.get("SPECIALIZATION") or "",
        "sub": row.get("SUB_SPECIALIZATION") or "",
        "period": int(row.get("REPORT_PERIOD") or period),
        "stock": round(ratio(row.get("STOCK_MARKET_EXPOSURE"), assets), 4),
        "foreign": round(ratio(row.get("FOREIGN_EXPOSURE"), assets), 4),
        "fx": round(ratio(row.get("FOREIGN_CURRENCY_EXPOSURE"), assets), 4),
        "liquid": round(float(row.get("LIQUID_ASSETS_PERCENT") or 0) / 100, 4),
    }
    return fund


def main() -> int:
    sources_meta = []
    funds = []
    for src in SOURCES:
        resource = latest_resource(src["package"])
        period = latest_period(resource["id"])
        raw = page_period(resource["id"], period, src["fields"])
        kept = []
        for row in raw:
            fund = normalize(src["id"], row, period)
            if fund:
                kept.append(fund)
        kept.sort(key=lambda f: (f["fundId"], f["name"]))
        funds.extend(kept)
        sources_meta.append({
            "id": src["id"],
            "title": src["title"],
            "package": src["package"],
            "dataset": src["dataset"],
            "resource_id": resource["id"],
            "resource_name": resource["name"],
            "period": period,
            "funds": len(kept),
        })
        print(f"{src['id']}: period {period} resource {resource['id']} funds {len(kept)}", file=sys.stderr)

    funds.sort(key=lambda f: (f["source"], f["fundId"]))
    doc = {
        "schema": 1,
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": "Public fund exposures from data.gov.il. No personal holdings, balances, or account numbers. stock/foreign/fx are fractions of TOTAL_ASSETS (may exceed 1 when the reported exposure is leveraged).",
        "sources": sources_meta,
        "funds": funds,
    }
    OUT.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes, {len(funds)} funds)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
