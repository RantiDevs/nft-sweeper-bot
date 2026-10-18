"""SQLite storage: queries, results (deduped by site), enrichment, drafts, request log."""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from urllib.parse import urlsplit

SCHEMA = """
CREATE TABLE IF NOT EXISTS queries (
    id           INTEGER PRIMARY KEY,
    query        TEXT NOT NULL UNIQUE,
    platform     TEXT,
    niche        TEXT,
    tier         TEXT,
    location     TEXT,
    country      TEXT,
    pattern      TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed
    ran_at       TEXT,
    result_count INTEGER,
    error        TEXT,
    created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queries_status ON queries(status);

CREATE TABLE IF NOT EXISTS results (
    id         INTEGER PRIMARY KEY,
    query_id   INTEGER NOT NULL REFERENCES queries(id),
    url        TEXT NOT NULL,
    domain     TEXT NOT NULL UNIQUE,  -- site key, see site_key()
    title      TEXT,
    snippet    TEXT,
    found_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sites (
    result_id        INTEGER PRIMARY KEY REFERENCES results(id),
    status           TEXT NOT NULL,   -- ok | blocked_by_robots | error
    http_status      INTEGER,
    final_url        TEXT,
    builder          TEXT,
    copyright_year   INTEGER,
    has_booking      INTEGER,
    has_contact_form INTEGER,
    emails           TEXT,            -- comma separated
    contact_url      TEXT,
    page_title       TEXT,
    text_excerpt     TEXT,
    error            TEXT,
    fetched_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
    id         INTEGER PRIMARY KEY,
    result_id  INTEGER NOT NULL UNIQUE REFERENCES results(id),
    model      TEXT,
    draft      TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS request_log (
    id          INTEGER PRIMARY KEY,
    provider    TEXT NOT NULL,
    query       TEXT NOT NULL,
    page        INTEGER,
    attempt     INTEGER,
    status_code INTEGER,
    ok          INTEGER NOT NULL,
    elapsed_ms  INTEGER,
    error       TEXT,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_log_created ON request_log(created_at);
"""

# Hosts where many unrelated businesses share one hostname; the first path
# segment(s) identify the business, so they are part of the dedupe key.
SHARED_HOSTS = {
    "sites.google.com": 2,
    "linktr.ee": 1,
    "bio.link": 1,
    "beacons.ai": 1,
    "lnk.bio": 1,
    "facebook.com": 1,
    "m.facebook.com": 1,
    "instagram.com": 1,
    "carrd.co": 1,
    "wix.to": 1,
    "yelp.com": 2,
    "yell.com": 2,
    "thumbtack.com": 3,
    "houzz.com": 2,
}


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def today_utc() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def site_key(url: str) -> str:
    """Return the dedupe key for a URL: the hostname, plus leading path
    segments for platforms that host many businesses on one hostname."""
    parts = urlsplit(url if "://" in url else "http://" + url)
    host = (parts.hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    depth = SHARED_HOSTS.get(host)
    if depth:
        segments = [s for s in parts.path.lower().split("/") if s][:depth]
        if segments:
            return host + "/" + "/".join(segments)
    return host


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    if path != ":memory:":
        conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    return conn


def insert_queries(conn: sqlite3.Connection, rows: list[dict]) -> int:
    """Insert generated queries, ignoring ones already present. Returns new count."""
    before = conn.total_changes
    created = now_iso()
    conn.executemany(
        """INSERT OR IGNORE INTO queries
           (query, platform, niche, tier, location, country, pattern, created_at)
           VALUES (:query, :platform, :niche, :tier, :location, :country, :pattern, :created_at)""",
        [{**{"platform": None, "tier": None, "country": None, "pattern": None}, **r, "created_at": created} for r in rows],
    )
    conn.commit()
    return conn.total_changes - before


def reset_stale_running(conn: sqlite3.Connection) -> int:
    """Queries left 'running' by a crash or Ctrl-C go back to 'pending'."""
    cur = conn.execute("UPDATE queries SET status = 'pending' WHERE status = 'running'")
    conn.commit()
    return cur.rowcount


def pending_queries(conn: sqlite3.Connection, include_failed: bool = False, limit: int | None = None):
    statuses = ("pending", "failed") if include_failed else ("pending",)
    sql = f"SELECT * FROM queries WHERE status IN ({','.join('?' * len(statuses))}) ORDER BY id"
    params: list = list(statuses)
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
    return conn.execute(sql, params).fetchall()


def mark_query(conn, query_id: int, status: str, result_count: int | None = None, error: str | None = None) -> None:
    conn.execute(
        "UPDATE queries SET status = ?, ran_at = ?, result_count = ?, error = ? WHERE id = ?",
        (status, now_iso() if status != "running" else None, result_count, error, query_id),
    )
    conn.commit()


def insert_result(conn, query_id: int, url: str, title: str | None, snippet: str | None) -> bool:
    """Insert a search result. Returns False if its site was already stored."""
    key = site_key(url)
    if not key:
        return False
    cur = conn.execute(
        """INSERT OR IGNORE INTO results (query_id, url, domain, title, snippet, found_at)
           VALUES (?, ?, ?, ?, ?, ?)""",
        (query_id, url, key, title, snippet, now_iso()),
    )
    return cur.rowcount == 1


def log_request(conn, provider: str, query: str, page: int, attempt: int,
                status_code: int | None, ok: bool, elapsed_ms: int, error: str | None = None) -> None:
    conn.execute(
        """INSERT INTO request_log
           (provider, query, page, attempt, status_code, ok, elapsed_ms, error, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (provider, query, page, attempt, status_code, int(ok), elapsed_ms, error, now_iso()),
    )
    conn.commit()


def requests_today(conn) -> int:
    """Search API calls made today (UTC), every attempt counted, since each one may be billed."""
    row = conn.execute(
        "SELECT COUNT(*) FROM request_log WHERE substr(created_at, 1, 10) = ?", (today_utc(),)
    ).fetchone()
    return row[0]


def results_to_enrich(conn, refetch: bool = False, limit: int | None = None):
    sql = "SELECT r.* FROM results r LEFT JOIN sites s ON s.result_id = r.id"
    if not refetch:
        sql += " WHERE s.result_id IS NULL"
    sql += " ORDER BY r.id"
    params: list = []
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
    return conn.execute(sql, params).fetchall()


SITE_COLUMNS = ("status", "http_status", "final_url", "builder", "copyright_year", "has_booking",
                "has_contact_form", "emails", "contact_url", "page_title", "text_excerpt", "error")


def save_site(conn, result_id: int, data: dict) -> None:
    values = {c: data.get(c) for c in SITE_COLUMNS}
    if isinstance(values["emails"], (list, tuple)):
        values["emails"] = ",".join(values["emails"])
    for flag in ("has_booking", "has_contact_form"):
        if values[flag] is not None:
            values[flag] = int(bool(values[flag]))
    cols = ", ".join(("result_id",) + SITE_COLUMNS + ("fetched_at",))
    marks = ", ".join("?" * (len(SITE_COLUMNS) + 2))
    conn.execute(
        f"INSERT OR REPLACE INTO sites ({cols}) VALUES ({marks})",
        (result_id, *values.values(), now_iso()),
    )
    conn.commit()


LEAD_SELECT = """
SELECT r.id AS result_id, r.url, r.domain, r.title, r.snippet, r.found_at,
       q.query, q.platform, q.niche, q.tier, q.location, q.country, q.pattern,
       s.status AS fetch_status, s.builder, s.copyright_year, s.has_booking,
       s.has_contact_form, s.emails, s.contact_url, s.page_title, s.text_excerpt,
       d.draft
FROM results r
JOIN queries q ON q.id = r.query_id
LEFT JOIN sites s ON s.result_id = r.id
LEFT JOIN drafts d ON d.result_id = r.id
"""


def leads(conn, countries=(), niches=(), tiers=(), with_email: bool = False,
          enriched_only: bool = False, without_draft: bool = False, limit: int | None = None):
    where, params = [], []
    for col, values in (("q.country", countries), ("q.niche", niches), ("q.tier", tiers)):
        values = [str(v).lower() for v in values if str(v).strip()]
        if values:
            where.append(f"lower({col}) IN ({','.join('?' * len(values))})")
            params.extend(values)
    if with_email:
        where.append("s.emails IS NOT NULL AND s.emails != ''")
    if enriched_only:
        where.append("s.status = 'ok'")
    if without_draft:
        where.append("d.id IS NULL")
    sql = LEAD_SELECT + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY r.id"
    if limit is not None:
        sql += " LIMIT ?"
        params.append(limit)
    return conn.execute(sql, params).fetchall()


def save_draft(conn, result_id: int, model: str, draft: str) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO drafts (result_id, model, draft, created_at) VALUES (?, ?, ?, ?)",
        (result_id, model, draft, now_iso()),
    )
    conn.commit()


def stats(conn) -> dict:
    out = {}
    for status, n in conn.execute("SELECT status, COUNT(*) FROM queries GROUP BY status"):
        out[f"queries_{status}"] = n
    out["results"] = conn.execute("SELECT COUNT(*) FROM results").fetchone()[0]
    out["enriched"] = conn.execute("SELECT COUNT(*) FROM sites").fetchone()[0]
    out["with_email"] = conn.execute("SELECT COUNT(*) FROM sites WHERE emails != ''").fetchone()[0]
    out["drafts"] = conn.execute("SELECT COUNT(*) FROM drafts").fetchone()[0]
    out["search_calls_today"] = requests_today(conn)
    return out
