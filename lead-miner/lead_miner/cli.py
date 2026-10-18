"""Command line interface: generate, run, enrich, draft, export, status."""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

import click

from . import db
from .config import PROVIDER_KEY_VARS, Settings
from .draft import DraftError, generate_draft, make_client, render_prompt, write_draft_file
from .enrich import PoliteFetcher, enrich_url
from .export import export_csv
from .generate import load_and_build
from .search import BudgetExceeded, SearchClient, SearchError, make_provider


def setup_logging(log_file: str, verbose: bool) -> None:
    logger = logging.getLogger("lead_miner")
    logger.setLevel(logging.INFO)
    if logger.handlers:
        return
    fh = logging.FileHandler(log_file, encoding="utf-8")
    fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    logger.addHandler(fh)
    sh = logging.StreamHandler(sys.stderr)
    sh.setLevel(logging.INFO if verbose else logging.WARNING)
    sh.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    logger.addHandler(sh)


@click.group()
@click.option("--db", "db_path", envvar="LEAD_MINER_DB", help="SQLite database path.")
@click.option("--env-file", default=".env", show_default=True, help="Environment file to load.")
@click.option("-v", "--verbose", is_flag=True, help="Log every request to the console too.")
@click.pass_context
def cli(ctx, db_path, env_file, verbose):
    """lead-miner: find businesses with weak websites, enrich them, draft outreach.

    Emails are only ever drafted for human review. Nothing is sent.
    """
    settings = Settings.from_env(env_file)
    if db_path:
        settings.db_path = db_path
    setup_logging(settings.log_file, verbose)
    ctx.obj = settings


def _conn(settings: Settings):
    return db.connect(settings.db_path)


def _split(values):
    out = []
    for v in values:
        out.extend(x.strip() for x in v.split(",") if x.strip())
    return out


@cli.command()
@click.option("--data-dir", default="data", show_default=True, type=click.Path(file_okay=False, exists=True))
@click.option("--patterns", "pattern_files", multiple=True, type=click.Path(dir_okay=False, exists=True),
              help="Extra pattern file(s), e.g. data/patterns/weakness.txt. Repeatable.")
@click.option("--no-base", is_flag=True, help="Skip the site:{platform} base formula; only use pattern files.")
@click.option("--country", multiple=True, help="Only locations in these countries (repeatable or comma separated).")
@click.option("--niche", multiple=True, help="Only these niches.")
@click.option("--tier", multiple=True, help="Only niches in these tiers.")
@click.option("--platform", multiple=True, help="Only these platforms.")
@click.option("--exclude", default="", help='Appended to every query, e.g. "-template -demo".')
@click.option("--dry-run", is_flag=True, help="Print queries instead of storing them.")
@click.pass_obj
def generate(settings, data_dir, pattern_files, no_base, country, niche, tier, platform, exclude, dry_run):
    """Build queries from the CSV files and queue them in the database."""
    queries = load_and_build(data_dir, pattern_files, include_base=not no_base,
                             countries=_split(country), niches_filter=_split(niche),
                             tiers=_split(tier), platforms_filter=_split(platform), exclude=exclude)
    if dry_run:
        for q in queries:
            click.echo(q["query"])
        click.echo(f"{len(queries)} queries", err=True)
        return
    conn = _conn(settings)
    added = db.insert_queries(conn, queries)
    click.echo(f"Generated {len(queries)} queries, {added} new, {len(queries) - added} already queued.")


@cli.command()
@click.option("--limit", type=int, help="Run at most this many queries.")
@click.option("--budget", type=int, help="Daily cap on search API calls (default DAILY_QUERY_BUDGET).")
@click.option("--pages", type=int, default=1, show_default=True, help="Result pages per query.")
@click.option("--provider", help="Override SEARCH_PROVIDER (serper, brave, serpapi).")
@click.option("--retry-failed", is_flag=True, help="Also re-run queries that failed before.")
@click.pass_obj
def run(settings, limit, budget, pages, provider, retry_failed):
    """Run queued queries through the search API. Safe to stop and resume."""
    if provider:
        settings.search_provider = provider.lower()
        settings.search_api_key = os.getenv(PROVIDER_KEY_VARS.get(settings.search_provider, ""), "")
    try:
        prov = make_provider(settings.search_provider, settings.search_api_key)
    except ValueError as exc:
        raise click.ClickException(str(exc))

    conn = _conn(settings)
    reset = db.reset_stale_running(conn)
    if reset:
        click.echo(f"Resuming: {reset} interrupted queries re-queued.")
    budget = budget if budget is not None else settings.daily_query_budget
    used = db.requests_today(conn)
    if used >= budget:
        raise click.ClickException(f"Daily budget reached ({used}/{budget} search calls today).")

    def budget_check():
        if db.requests_today(conn) >= budget:
            raise BudgetExceeded()

    def on_request(*args):
        db.log_request(conn, *args)

    client = SearchClient(prov, min_interval=settings.search_min_interval,
                          max_retries=settings.search_max_retries,
                          on_request=on_request, budget_check=budget_check)
    todo = db.pending_queries(conn, include_failed=retry_failed, limit=limit)
    total = len(todo)
    if not total:
        click.echo("Nothing to run. Use `generate` to queue queries.")
        return
    click.echo(f"Running {total} queries with {prov.name} (budget {used}/{budget} used today).")

    done = new_total = 0
    for i, q in enumerate(todo, 1):
        db.mark_query(conn, q["id"], "running")
        hits_total = new = 0
        try:
            for page in range(1, pages + 1):
                hits = client.search(q["query"], page=page)
                hits_total += len(hits)
                for h in hits:
                    new += db.insert_result(conn, q["id"], h.url, h.title, h.snippet)
                conn.commit()
                if len(hits) < prov.page_size:
                    break
        except BudgetExceeded:
            db.mark_query(conn, q["id"], "pending")
            click.echo(f"Daily budget of {budget} search calls reached. Stopping; run again tomorrow to resume.")
            break
        except SearchError as exc:
            db.mark_query(conn, q["id"], "failed", hits_total, str(exc)[:500])
            click.echo(f"[{i}/{total}] FAILED {q['query']}: {exc}")
            continue
        except KeyboardInterrupt:
            conn.commit()
            db.mark_query(conn, q["id"], "pending")
            click.echo("\nInterrupted. Progress saved; run again to resume.")
            raise SystemExit(130)
        db.mark_query(conn, q["id"], "done", hits_total)
        done += 1
        new_total += new
        click.echo(f"[{i}/{total}] {q['query']}  ->  {hits_total} hits, {new} new sites "
                   f"(budget {db.requests_today(conn)}/{budget})")
    click.echo(f"Finished {done} queries, {new_total} new sites.")


@cli.command()
@click.option("--limit", type=int, help="Enrich at most this many sites.")
@click.option("--refetch", is_flag=True, help="Re-fetch sites that were already enriched.")
@click.pass_obj
def enrich(settings, limit, refetch):
    """Fetch each site politely and detect builder, copyright, booking, forms, emails."""
    conn = _conn(settings)
    rows = db.results_to_enrich(conn, refetch=refetch, limit=limit)
    total = len(rows)
    if not total:
        click.echo("Nothing to enrich.")
        return
    fetcher = PoliteFetcher(settings.user_agent, min_interval=settings.domain_min_interval,
                            timeout=settings.fetch_timeout)
    for i, r in enumerate(rows, 1):
        data = enrich_url(fetcher, r["url"])
        db.save_site(conn, r["id"], data)
        if data["status"] == "ok":
            summary = (f"builder={data.get('builder') or '?'} ©={data.get('copyright_year') or '?'} "
                       f"booking={'y' if data.get('has_booking') else 'n'} "
                       f"form={'y' if data.get('has_contact_form') else 'n'} "
                       f"emails={len(data.get('emails') or [])}")
        else:
            summary = data["status"] + (f" ({data.get('error')})" if data.get("error") else "")
        click.echo(f"[{i}/{total}] {r['domain']}  {summary}")


@cli.command()
@click.option("--limit", type=int, default=10, show_default=True, help="Draft at most this many emails.")
@click.option("--prompt", "prompt_file", default="prompt.txt", show_default=True,
              type=click.Path(dir_okay=False, exists=True))
@click.option("--out-dir", default="drafts", show_default=True, help="Where to write draft text files.")
@click.option("--country", multiple=True)
@click.option("--niche", multiple=True)
@click.option("--tier", multiple=True)
@click.option("--with-email/--any", default=True, show_default=True,
              help="Only draft for sites where a public email was found.")
@click.option("--redraft", is_flag=True, help="Also redraft sites that already have a draft.")
@click.pass_obj
def draft(settings, limit, prompt_file, out_dir, country, niche, tier, with_email, redraft):
    """Draft outreach emails with the Anthropic API. Drafts are saved, never sent."""
    conn = _conn(settings)
    rows = db.leads(conn, countries=_split(country), niches=_split(niche), tiers=_split(tier),
                    with_email=with_email, enriched_only=True, without_draft=not redraft, limit=limit)
    total = len(rows)
    if not total:
        click.echo("No enriched leads to draft for. Run `enrich` first.")
        return
    if not (settings.sender_name and settings.sender_role):
        click.echo("Warning: SENDER_NAME / SENDER_ROLE not set; drafts will contain placeholders.")
    template = Path(prompt_file).read_text(encoding="utf-8")
    try:
        client = make_client()
    except DraftError as exc:
        raise click.ClickException(str(exc))
    for i, lead in enumerate(rows, 1):
        prompt = render_prompt(template, lead, settings.sender_name, settings.sender_role)
        try:
            text = generate_draft(client, prompt, settings.anthropic_model,
                                  settings.anthropic_effort, settings.anthropic_fallbacks)
        except Exception as exc:  # keep going; one bad lead should not stop the batch
            logging.getLogger("lead_miner.draft").warning("draft failed for %s: %s", lead["url"], exc)
            click.echo(f"[{i}/{total}] {lead['domain']}  FAILED: {exc}")
            continue
        db.save_draft(conn, lead["result_id"], settings.anthropic_model, text)
        path = write_draft_file(out_dir, lead, text)
        click.echo(f"[{i}/{total}] {lead['domain']}  -> {path}")
    click.echo("Drafts saved for review. lead-miner never sends email.")


@cli.command()
@click.option("-o", "--out", default="exports/leads.csv", show_default=True)
@click.option("--country", multiple=True, help="Filter by country (repeatable or comma separated).")
@click.option("--niche", multiple=True, help="Filter by niche.")
@click.option("--tier", multiple=True, help="Filter by niche tier.")
@click.option("--with-email", is_flag=True, help="Only leads with a public email.")
@click.pass_obj
def export(settings, out, country, niche, tier, with_email):
    """Export leads to CSV, filtered by country, niche and tier."""
    conn = _conn(settings)
    n = export_csv(conn, out, countries=_split(country), niches=_split(niche),
                   tiers=_split(tier), with_email=with_email)
    click.echo(f"Exported {n} leads to {out}")


@cli.command()
@click.pass_obj
def status(settings):
    """Show queue, result, enrichment and budget counts."""
    conn = _conn(settings)
    for k, v in db.stats(conn).items():
        click.echo(f"{k:20} {v}")
    click.echo(f"{'daily_budget':20} {settings.daily_query_budget}")


def main():
    cli()


if __name__ == "__main__":
    main()
