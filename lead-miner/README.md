# lead-miner

Finds small businesses with weak or no websites, enriches each site politely,
and (optionally) drafts a personalised outreach email for a human to review.

**lead-miner never sends email.** Drafts are saved to the database and to text
files. Reviewing, verifying and sending them is a manual step.

```
generate  ->  run  ->  enrich  ->  draft (optional)  ->  export
 queries     search    fetch site    Anthropic API        CSV
```

## Install

```bash
cd lead-miner
python -m venv .venv && source .venv/bin/activate
pip install -e ".[draft]"      # drop [draft] if you will not use the draft step
cp .env.example .env           # then fill in your keys
```

Requires Python 3.10+.

## Configuration (`.env`)

| Variable | Default | Purpose |
|---|---|---|
| `SEARCH_PROVIDER` | `serper` | `serper`, `brave` or `serpapi` |
| `SERPER_API_KEY` / `BRAVE_API_KEY` / `SERPAPI_API_KEY` | | Key for the chosen provider |
| `SEARCH_MIN_INTERVAL` | `1.0` | Seconds between search API calls |
| `SEARCH_MAX_RETRIES` | `4` | Retries on 429, 5xx, timeouts (exponential backoff, honours `Retry-After`) |
| `DAILY_QUERY_BUDGET` | `100` | Max search API calls per UTC day (every attempt counts) |
| `USER_AGENT` | `LeadMinerBot/0.1 (+https://rantidevs.org)` | Sent on every site fetch |
| `DOMAIN_MIN_INTERVAL` | `1.0` | Seconds between requests to the same host |
| `FETCH_TIMEOUT` | `15` | Seconds per site request |
| `ANTHROPIC_API_KEY` | | Only needed for `draft` |
| `ANTHROPIC_MODEL` | `claude-opus-5-5` | Model used for drafts |
| `ANTHROPIC_EFFORT` | `medium` | `low` / `medium` / `high`; lower is cheaper |
| `ANTHROPIC_FALLBACKS` | `1` | Server-side refusal fallback; set `0` if your platform rejects it |
| `SENDER_NAME`, `SENDER_ROLE` | | Filled into the prompt |
| `LEAD_MINER_DB` | `lead_miner.db` | SQLite file (or pass `--db`) |
| `LEAD_MINER_LOG` | `lead_miner.log` | Every search request and site fetch is logged here |

## Input files

`data/platforms.csv` (column `platform`), `data/niches.csv` (`niche`, `tier`),
`data/locations.csv` (`location`, `country`). They ship with the platform
footprints, the tiered niche list and the top cities from the RantiDevs Scout
pattern library. Add rows freely; extra columns are ignored.

Each combination becomes:

```
site:{platform} "{niche}" "{location}"
```

### Pattern files (weakness signals)

Extra pattern files add queries such as outdated copyright or free email
addresses. One pattern per line; `{niche}`, `{location}` and optionally
`{platform}` are substituted; text after ` #` is a label stored with the query
and shown in exports:

```
"© 2016" "{niche}" "{location}"  # outdated_copyright
"{niche}" "{location}" "contact us" "@gmail.com"  # free_email
site:{platform} "{niche}" "{location}" "book now"  # platform_booking
```

Patterns without `{platform}` are not multiplied by the platform list.
Shipped files: `data/patterns/weakness.txt`, `data/patterns/no_website.txt`.
A CSV with a `pattern` column (and optional `signal`) also works.

## Usage

```bash
# 1. Queue queries (idempotent; re-running only adds new ones)
lead-miner generate --country "United Kingdom" --tier 1 --niche dentist,plumber \
    --patterns data/patterns/weakness.txt --exclude "-template -demo"
lead-miner generate --country Canada --dry-run | head   # preview without storing

# 2. Run them through the search API (stops at the daily budget; resumable)
lead-miner run --limit 50
lead-miner run --budget 20 --pages 2 --provider brave
lead-miner run --retry-failed

# 3. Enrich each site found
lead-miner enrich --limit 100

# 4. Optional: draft emails for leads with a public email (saved, never sent)
lead-miner draft --limit 10 --country "United Kingdom"

# 5. Export
lead-miner export -o exports/uk-tier1.csv --country "United Kingdom" --tier 1 --with-email

lead-miner status
```

Every command prints a progress counter (`[12/340] ...`). Add `-v` to also see
each request in the console.

### Resuming

Query state lives in SQLite (`queries.status`: `pending`, `running`, `done`,
`failed`; `ran_at` records when it ran). Stop `run` at any time (Ctrl-C, crash,
budget): the next `run` re-queues anything left `running` and continues with
pending queries. `enrich` skips sites already enriched (use `--refetch` to
redo), and `draft` skips leads that already have a draft (`--redraft`).

### Deduplication

Results are unique on a site key: the hostname without `www.`. For hosts that
serve many businesses (`sites.google.com`, `linktr.ee`, `facebook.com`,
`instagram.com` and others listed in `db.SHARED_HOSTS`) the first path
segment(s) are part of the key, so different businesses are kept apart. The
first query to find a site is the one it is attributed to.

## What enrichment detects

For each result, `enrich` fetches the homepage and, if one is linked on the
same host, the contact page:

* **robots.txt** is read first and obeyed for the configured User-Agent
  (a 5xx or 401/403 on robots.txt is treated as "do not crawl").
* At most **one request per second per host**, page bodies capped at 2 MB.
* **Site builder**: `<meta name="generator">`, then hostnames, CDNs and
  markup fingerprints (Wix, Squarespace, Weebly, GoDaddy, Jimdo, Webflow,
  WordPress, Shopify, Duda, Google Sites and more).
* **Copyright year**: the latest year in a `©`/`Copyright` notice (the end
  of a range such as `© 2012 - 2016`).
* **Booking**: known booking widgets (Calendly, Acuity, Fresha, Booksy,
  Zocdoc, OpenTable...) or "book now / book an appointment" links.
* **Contact form**: a form with a textarea or email field (search forms
  ignored), or an embedded form service.
* **Emails**: `mailto:` links, Cloudflare-protected addresses and addresses in
  visible text, with placeholders and builder/tracking addresses removed.

## Drafting

`draft` fills `prompt.txt` with the sender, niche, location and the collected
site data (`{sender_name}`, `{sender_role}`, `{niche}`, `{location}`,
`{country}`, `{url}`, `{site_data}`) and sends it to the Anthropic API. The
model cannot open the site itself, so the prompt tells it to rely only on the
supplied data and never invent a problem. Output is stored in the `drafts`
table and written to `drafts/NNNNN-domain.txt` with the source URL and date.

## Export columns

`business, url, domain, emails, contact_url, niche, tier, location, country,
platform, builder, copyright_year, has_booking, has_contact_form, pattern,
query, fetch_status, found_at, has_draft`. `found_at` and `url` give the
source and date record for each contact.

## Tests

```bash
pip install -e ".[dev]"
pytest
```

The tests use a fake HTTP adapter and a fake Anthropic client; they make no
network calls and need no keys.

## Compliance notes

* Use a licensed search API (the three supported providers) rather than
  scraping Google results directly.
* Only publicly published business addresses are collected. Cold email rules
  differ by country (CAN-SPAM, UK/EU PECR and GDPR, Canada's CASL, Australia's
  Spam Act); check them before sending, include a real sender identity and an
  opt out, and honour every "stop".
* Ambiguous city names exist across countries (for example Hamilton, London,
  Newcastle). The shipped list disambiguates the Canadian and Australian ones
  (`London Ontario`, `Newcastle NSW`); do the same for any you add.
