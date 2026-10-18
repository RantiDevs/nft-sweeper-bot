"""Build search queries from platform, niche and location CSV files."""

from __future__ import annotations

import csv
import itertools
from pathlib import Path

BASE_PATTERN = 'site:{platform} "{niche}" "{location}"'


def read_csv(path: str | Path, required: str) -> list[dict]:
    """Read a CSV into dicts. The `required` column must exist; blank rows and
    rows starting with '#' are skipped."""
    with open(path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        if not reader.fieldnames or required not in [h.strip() for h in reader.fieldnames]:
            raise ValueError(f"{path}: missing required column '{required}'")
        rows = []
        for row in reader:
            row = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
            value = row.get(required, "")
            if value and not value.startswith("#"):
                rows.append(row)
        return rows


def read_patterns(path: str | Path) -> list[dict]:
    """Read a pattern file: one pattern per line, '#' starts a comment line,
    and an inline ' #label' after the pattern becomes its label. A .csv file
    with a 'pattern' column (and optional 'signal') is also accepted."""
    path = Path(path)
    if path.suffix.lower() == ".csv":
        return read_csv(path, "pattern")
    patterns = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        pattern, _, label = line.partition(" #")
        patterns.append({"pattern": pattern.strip(), "signal": label.strip() or path.stem})
    return patterns


def _filter(rows: list[dict], column: str, allowed) -> list[dict]:
    allowed = {str(a).strip().lower() for a in allowed or () if str(a).strip()}
    if not allowed:
        return rows
    return [r for r in rows if r.get(column, "").lower() in allowed]


def render(pattern: str, platform: str, niche: str, location: str) -> str:
    # str.replace rather than str.format: patterns may legitimately contain braces.
    return (pattern.replace("{platform}", platform)
                   .replace("{niche}", niche)
                   .replace("{location}", location)).strip()


def build_queries(platforms: list[dict], niches: list[dict], locations: list[dict],
                  patterns: list[dict] | None = None, include_base: bool = True,
                  exclude: str = "") -> list[dict]:
    """Return one dict per query with its metadata.

    The base formula is crossed with every platform. Each extra pattern is
    crossed with niches and locations, and with platforms only if it contains
    a {platform} placeholder.
    """
    templates: list[tuple[str, str | None]] = []
    if include_base:
        templates.append((BASE_PATTERN, None))
    for p in patterns or []:
        templates.append((p["pattern"], p.get("signal") or p["pattern"]))

    out, seen = [], set()
    for template, label in templates:
        plats = platforms if "{platform}" in template else [{"platform": ""}]
        for plat, niche, loc in itertools.product(plats, niches, locations):
            q = render(template, plat["platform"], niche["niche"], loc["location"])
            if exclude:
                q = f"{q} {exclude.strip()}"
            if q in seen:
                continue
            seen.add(q)
            out.append({
                "query": q,
                "platform": plat["platform"] or None,
                "niche": niche["niche"],
                "tier": niche.get("tier") or None,
                "location": loc["location"],
                "country": loc.get("country") or None,
                "pattern": label,
            })
    return out


def load_and_build(data_dir: str | Path, pattern_files=(), include_base: bool = True,
                   countries=(), niches_filter=(), tiers=(), platforms_filter=(),
                   exclude: str = "") -> list[dict]:
    data_dir = Path(data_dir)
    platforms = _filter(read_csv(data_dir / "platforms.csv", "platform"), "platform", platforms_filter)
    niches = read_csv(data_dir / "niches.csv", "niche")
    niches = _filter(_filter(niches, "niche", niches_filter), "tier", tiers)
    locations = _filter(read_csv(data_dir / "locations.csv", "location"), "country", countries)
    patterns = []
    for pf in pattern_files:
        patterns.extend(read_patterns(pf))
    return build_queries(platforms, niches, locations, patterns, include_base, exclude)
