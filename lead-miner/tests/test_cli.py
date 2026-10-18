import csv

from click.testing import CliRunner

from lead_miner import cli as cli_mod
from lead_miner import db
from lead_miner.search import SearchHit


class FakeClient:
    """Stands in for SearchClient; records calls and goes through the budget/log hooks."""

    def __init__(self, provider, on_request=None, budget_check=None, **kwargs):
        self.provider = provider
        self.on_request = on_request
        self.budget_check = budget_check

    def search(self, query, page=1):
        self.budget_check()
        self.on_request(self.provider.name, query, page, 1, 200, True, 5, None)
        slug = abs(hash(query)) % 10_000
        return [SearchHit(f"https://site{slug}.example/", f"Biz {slug}", query),
                SearchHit("https://shared.example/", "Shared", query)]


def write_data(tmp_path):
    d = tmp_path / "data"
    d.mkdir()
    (d / "platforms.csv").write_text("platform\nwixsite.com\n")
    (d / "niches.csv").write_text("niche,tier\ndentist,1\nflorist,2\n")
    (d / "locations.csv").write_text("location,country\nLeeds,United Kingdom\nToronto,Canada\n")
    return d


def invoke(runner, dbfile, *args, env=None):
    base = {"LEAD_MINER_LOG": str(dbfile) + ".log", "SEARCH_PROVIDER": "serper", "SERPER_API_KEY": "k",
            "DAILY_QUERY_BUDGET": "100", "SEARCH_MIN_INTERVAL": "0"}
    base.update(env or {})
    return runner.invoke(cli_mod.cli, ["--env-file", "", "--db", str(dbfile), *args], env=base,
                         catch_exceptions=False)


def test_generate_run_resume_budget_export(tmp_path, monkeypatch):
    monkeypatch.setattr(cli_mod, "SearchClient", FakeClient)
    runner = CliRunner()
    dbfile = tmp_path / "leads.db"
    data = write_data(tmp_path)

    r = invoke(runner, dbfile, "generate", "--data-dir", str(data))
    assert "Generated 4 queries, 4 new" in r.output
    r = invoke(runner, dbfile, "generate", "--data-dir", str(data))
    assert "0 new" in r.output

    # Budget of 2 calls: two queries run, then it stops and leaves the rest pending.
    r = invoke(runner, dbfile, "run", "--budget", "2")
    assert "[1/4]" in r.output and "[2/4]" in r.output and "budget of 2" in r.output
    conn = db.connect(str(dbfile))
    assert db.stats(conn)["queries_done"] == 2 and db.stats(conn)["queries_pending"] == 2

    r = invoke(runner, dbfile, "run", "--budget", "2")
    assert r.exit_code != 0 and "Daily budget reached" in r.output

    # Resume tomorrow (simulate by raising the budget): only the remaining 2 run.
    r = invoke(runner, dbfile, "run", "--budget", "10")
    assert "Running 2 queries" in r.output
    s = db.stats(conn)
    assert s["queries_done"] == 4
    assert s["results"] == 5  # 4 unique sites + 1 shared site deduped on domain

    out = tmp_path / "uk.csv"
    r = invoke(runner, dbfile, "export", "-o", str(out), "--country", "united kingdom", "--tier", "1")
    rows = list(csv.DictReader(out.open()))
    assert rows and all(row["country"] == "United Kingdom" and row["tier"] == "1" for row in rows)
    assert {"business", "url", "emails", "builder", "copyright_year"} <= set(rows[0])


def test_run_requires_api_key(tmp_path):
    r = CliRunner().invoke(cli_mod.cli, ["--env-file", "", "--db", str(tmp_path / "x.db"), "run"],
                           env={"SEARCH_PROVIDER": "brave", "BRAVE_API_KEY": "",
                                "LEAD_MINER_LOG": str(tmp_path / "x.log")})
    assert r.exit_code != 0 and "No API key" in r.output


def test_enrich_and_draft_commands(tmp_path, monkeypatch):
    dbfile = tmp_path / "leads.db"
    conn = db.connect(str(dbfile))
    db.insert_queries(conn, [{"query": "q", "niche": "dentist", "location": "Leeds", "country": "United Kingdom"}])
    db.insert_result(conn, 1, "https://smile.example/", "Smile", "")
    conn.commit()

    monkeypatch.setattr(cli_mod, "enrich_url", lambda fetcher, url: {
        "status": "ok", "builder": "Wix", "emails": ["hi@smile.example"], "has_booking": False,
        "has_contact_form": True, "copyright_year": 2015})
    runner = CliRunner()
    r = invoke(runner, dbfile, "enrich")
    assert "[1/1] smile.example  builder=Wix" in r.output

    seen = {}

    def fake_generate(client, prompt, model, effort, fallbacks):
        seen["prompt"] = prompt
        return "Subject: quick idea"

    monkeypatch.setattr(cli_mod, "make_client", lambda: object())
    monkeypatch.setattr(cli_mod, "generate_draft", fake_generate)
    prompt = tmp_path / "prompt.txt"
    prompt.write_text("Write for {niche} in {location}.\n{site_data}")
    r = invoke(runner, dbfile, "draft", "--prompt", str(prompt), "--out-dir", str(tmp_path / "drafts"),
               env={"SENDER_NAME": "Ada", "SENDER_ROLE": "Founder"})
    assert "never sends email" in r.output
    assert "Write for dentist in Leeds." in seen["prompt"]
    assert db.stats(conn)["drafts"] == 1
    assert len(list((tmp_path / "drafts").glob("*.txt"))) == 1
    # Already drafted leads are skipped by default.
    r = invoke(runner, dbfile, "draft", "--prompt", str(prompt), "--out-dir", str(tmp_path / "drafts"))
    assert "No enriched leads" in r.output
