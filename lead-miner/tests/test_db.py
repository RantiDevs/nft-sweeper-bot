from lead_miner import db


def _q(text, **kw):
    return {"query": text, "niche": "dentist", "location": "Leeds", "country": "United Kingdom", "tier": "1", **kw}


def test_site_key():
    assert db.site_key("https://www.Example.co.uk/about") == "example.co.uk"
    assert db.site_key("https://joe.wixsite.com/dental") == "joe.wixsite.com"
    assert db.site_key("https://sites.google.com/view/smile-dental/home") == "sites.google.com/view/smile-dental"
    assert db.site_key("https://linktr.ee/glowspa?x=1") == "linktr.ee/glowspa"
    assert db.site_key("https://www.facebook.com/BobsPlumbing/") == "facebook.com/bobsplumbing"


def test_insert_queries_is_idempotent(conn):
    assert db.insert_queries(conn, [_q("a"), _q("b")]) == 2
    assert db.insert_queries(conn, [_q("a"), _q("c")]) == 1
    assert len(db.pending_queries(conn)) == 3


def test_results_dedupe_on_domain(conn):
    db.insert_queries(conn, [_q("a")])
    qid = db.pending_queries(conn)[0]["id"]
    assert db.insert_result(conn, qid, "https://acme.com/", "Acme", "")
    assert not db.insert_result(conn, qid, "http://www.acme.com/contact", "Acme contact", "")
    assert db.insert_result(conn, qid, "https://sites.google.com/view/one", "", "")
    assert db.insert_result(conn, qid, "https://sites.google.com/view/two", "", "")
    assert conn.execute("SELECT COUNT(*) FROM results").fetchone()[0] == 3


def test_resume_resets_running_and_skips_done(conn):
    db.insert_queries(conn, [_q("a"), _q("b"), _q("c")])
    a, b, c = db.pending_queries(conn)
    db.mark_query(conn, a["id"], "done", 5)
    db.mark_query(conn, b["id"], "running")
    db.mark_query(conn, c["id"], "failed", error="boom")
    assert [r["query"] for r in db.pending_queries(conn)] == []
    assert db.reset_stale_running(conn) == 1
    assert [r["query"] for r in db.pending_queries(conn)] == ["b"]
    assert [r["query"] for r in db.pending_queries(conn, include_failed=True)] == ["b", "c"]
    done = conn.execute("SELECT * FROM queries WHERE id = ?", (a["id"],)).fetchone()
    assert done["status"] == "done" and done["ran_at"] and done["result_count"] == 5


def test_requests_today_counts_log(conn):
    for i in range(3):
        db.log_request(conn, "serper", "q", 1, i + 1, 200, True, 10)
    conn.execute("UPDATE request_log SET created_at = '2000-01-01T00:00:00+00:00' WHERE id = 1")
    assert db.requests_today(conn) == 2


def test_leads_filters(conn):
    db.insert_queries(conn, [_q("a"), _q("b", niche="florist", tier="2", country="Canada")])
    qa, qb = db.pending_queries(conn)
    db.insert_result(conn, qa["id"], "https://a.com", "A", "")
    db.insert_result(conn, qb["id"], "https://b.com", "B", "")
    conn.commit()
    db.save_site(conn, 1, {"status": "ok", "emails": ["x@a.com"], "has_booking": False})
    assert len(db.leads(conn)) == 2
    assert [r["domain"] for r in db.leads(conn, countries=["canada"])] == ["b.com"]
    assert [r["domain"] for r in db.leads(conn, tiers=["1"])] == ["a.com"]
    assert [r["domain"] for r in db.leads(conn, niches=["Florist"])] == ["b.com"]
    assert [r["domain"] for r in db.leads(conn, with_email=True)] == ["a.com"]
    assert db.leads(conn)[0]["emails"] == "x@a.com"
