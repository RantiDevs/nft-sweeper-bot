"""CSV export of leads."""

from __future__ import annotations

import csv
from pathlib import Path

from . import db

COLUMNS = [
    "business", "url", "domain", "emails", "contact_url", "niche", "tier", "location", "country",
    "platform", "builder", "copyright_year", "has_booking", "has_contact_form", "pattern",
    "query", "fetch_status", "found_at", "has_draft",
]


def _flag(v):
    return "" if v is None else ("yes" if v else "no")


def export_csv(conn, out_path: str | Path, countries=(), niches=(), tiers=(),
               with_email: bool = False) -> int:
    rows = db.leads(conn, countries=countries, niches=niches, tiers=tiers, with_email=with_email)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        for r in rows:
            writer.writerow({
                "business": r["page_title"] or r["title"] or "",
                "url": r["url"],
                "domain": r["domain"],
                "emails": (r["emails"] or "").replace(",", "; "),
                "contact_url": r["contact_url"] or "",
                "niche": r["niche"],
                "tier": r["tier"] or "",
                "location": r["location"],
                "country": r["country"] or "",
                "platform": r["platform"] or "",
                "builder": r["builder"] or "",
                "copyright_year": r["copyright_year"] or "",
                "has_booking": _flag(r["has_booking"]),
                "has_contact_form": _flag(r["has_contact_form"]),
                "pattern": r["pattern"] or "",
                "query": r["query"],
                "fetch_status": r["fetch_status"] or "not_enriched",
                "found_at": r["found_at"],
                "has_draft": "yes" if r["draft"] else "no",
            })
    return len(rows)
