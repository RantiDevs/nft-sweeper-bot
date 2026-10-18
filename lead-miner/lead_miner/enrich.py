"""Polite site fetching and detection of builder, copyright year, booking,
contact form and public contact emails."""

from __future__ import annotations

import logging
import re
import time
import urllib.robotparser
from datetime import date
from typing import Callable
from urllib.parse import urljoin, urlsplit

import requests
from bs4 import BeautifulSoup

log = logging.getLogger("lead_miner.enrich")

MAX_BYTES = 2_000_000

# ---------------------------------------------------------------- fetching


class PoliteFetcher:
    """HTTP fetcher that obeys robots.txt and spaces requests to the same host."""

    def __init__(self, user_agent: str, min_interval: float = 1.0, timeout: float = 15.0,
                 session: requests.Session | None = None,
                 clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        self.user_agent = user_agent
        self.min_interval = min_interval
        self.timeout = timeout
        self.session = session or requests.Session()
        self.session.headers.update({"User-Agent": user_agent,
                                     "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5"})
        self.clock = clock
        self.sleep = sleep
        self._last_hit: dict[str, float] = {}
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}

    def _throttle(self, host: str) -> None:
        last = self._last_hit.get(host)
        if last is not None:
            remaining = self.min_interval - (self.clock() - last)
            if remaining > 0:
                self.sleep(remaining)
        self._last_hit[host] = self.clock()

    def _get(self, url: str) -> requests.Response:
        self._throttle(urlsplit(url).netloc.lower())
        resp = self.session.get(url, timeout=self.timeout, stream=True, allow_redirects=True)
        try:
            body, size = [], 0
            for chunk in resp.iter_content(65536):
                body.append(chunk)
                size += len(chunk)
                if size >= MAX_BYTES:
                    break
            resp._content = b"".join(body)
        finally:
            resp.close()
        return resp

    def robots(self, url: str) -> urllib.robotparser.RobotFileParser | None:
        parts = urlsplit(url)
        base = f"{parts.scheme}://{parts.netloc}".lower()
        if base not in self._robots:
            parser = urllib.robotparser.RobotFileParser()
            try:
                resp = self._get(base + "/robots.txt")
                if resp.status_code in (401, 403) or resp.status_code >= 500:
                    parser.disallow_all = True  # be conservative, as major crawlers are
                elif resp.status_code >= 400:
                    parser.allow_all = True
                else:
                    parser.parse(resp.text.splitlines())
            except requests.RequestException as exc:
                log.info("robots.txt unavailable for %s (%s); treating as allowed", base, exc)
                parser.allow_all = True
            self._robots[base] = parser
        return self._robots[base]

    def allowed(self, url: str) -> bool:
        parser = self.robots(url)
        return parser is None or parser.can_fetch(self.user_agent, url)

    def fetch(self, url: str) -> requests.Response | None:
        """GET url if robots.txt allows it, else return None."""
        if not self.allowed(url):
            log.info("robots.txt disallows %s", url)
            return None
        resp = self._get(url)
        log.info("GET %s -> %s", url, resp.status_code)
        return resp


# --------------------------------------------------------------- detection

# (builder, regex over hostname + headers + html). Order matters: the first match wins,
# and explicit <meta name="generator"> values are checked before these.
BUILDER_SIGNATURES: list[tuple[str, str]] = [
    ("Wix", r"wixsite\.com|static\.wixstatic\.com|x-wix-request-id|wix\.com website builder"),
    ("Squarespace", r"static1\.squarespace\.com|squarespace\.com|squarespace-cdn"),
    ("Weebly", r"weebly\.com|editmysite\.com"),
    ("GoDaddy", r"godaddysites\.com|img1\.wsimg\.com|go daddy website builder|starfield technologies"),
    ("Jimdo", r"jimdosite\.com|jimdofree\.com|jimcdn\.com|jimdo"),
    ("Webflow", r"webflow\.io|data-wf-page|data-wf-site|website-files\.com"),
    ("Strikingly", r"mystrikingly\.com|strikingly"),
    ("Webnode", r"webnode\.(?:com|page)|webnode"),
    ("SITE123", r"site123\.me|site123"),
    ("Carrd", r"carrd\.co"),
    ("Google Sites", r"sites\.google\.com|gstatic\.com/atari"),
    ("Blogger", r"blogspot\.com|blogger\.com"),
    ("Yola", r"yolasite\.com|yola"),
    ("Tilda", r"tilda\.ws|tildacdn"),
    ("Duda", r"multiscreensite\.com|irp\.cdn-website\.com|dudaone|cdn-website\.com"),
    ("Mozello", r"mozello"),
    ("Shopify", r"myshopify\.com|cdn\.shopify\.com"),
    ("WordPress", r"wp-content/|wp-includes/|wordpress"),
    ("Joomla", r"/media/jui/|joomla"),
    ("Drupal", r"drupal-settings-json|/sites/default/files/|drupal"),
    ("Linktree", r"linktr\.ee"),
]

GENERATOR_MAP = [
    ("wix", "Wix"), ("weebly", "Weebly"), ("squarespace", "Squarespace"), ("jimdo", "Jimdo"),
    ("webflow", "Webflow"), ("go daddy", "GoDaddy"), ("godaddy", "GoDaddy"), ("starfield", "GoDaddy"),
    ("site123", "SITE123"), ("strikingly", "Strikingly"), ("webnode", "Webnode"),
    ("wordpress", "WordPress"), ("joomla", "Joomla"), ("drupal", "Drupal"), ("duda", "Duda"),
    ("tilda", "Tilda"), ("blogger", "Blogger"), ("hugo", "Hugo"), ("ghost", "Ghost"),
]


def detect_builder(html: str, url: str = "", headers: dict | None = None) -> str | None:
    soup = BeautifulSoup(html, "html.parser") if html else None
    if soup:
        gen = soup.find("meta", attrs={"name": re.compile("^generator$", re.I)})
        if gen and gen.get("content"):
            content = gen["content"].lower()
            for needle, name in GENERATOR_MAP:
                if needle in content:
                    return name
    haystack = " ".join([
        urlsplit(url).netloc.lower(),
        " ".join(f"{k}: {v}" for k, v in (headers or {}).items()).lower(),
        (html or "")[:400_000].lower(),
    ])
    for name, pattern in BUILDER_SIGNATURES:
        if re.search(pattern, haystack):
            return name
    return None


YEAR = r"((?:19|20)\d{2})"
COPYRIGHT_RE = re.compile(
    r"(?:©|&copy;|\(c\)|copyright)\s*(?:©|&copy;)?\s*[^0-9<>]{0,40}?" + YEAR
    + r"(?:\s*(?:-|–|—|to|&ndash;|&mdash;)\s*" + YEAR + r")?",
    re.I,
)


def detect_copyright_year(text: str, current_year: int | None = None) -> int | None:
    """Latest year that appears in a copyright notice (end of a range wins)."""
    current_year = current_year or date.today().year
    years = []
    for m in COPYRIGHT_RE.finditer(text or ""):
        for g in m.groups():
            if g and 1995 <= int(g) <= current_year:
                years.append(int(g))
    return max(years) if years else None


BOOKING_WIDGETS = re.compile(
    r"calendly\.com|acuityscheduling\.com|setmore\.com|simplybook\.|squareup\.com/appointments|"
    r"square\.site/book|booksy\.com|fresha\.com|vagaro\.com|mindbodyonline\.com|opentable\.|resy\.com|"
    r"zocdoc\.com|janeapp\.com|timely\.(?:com|app)|schedulicity\.com|booker\.com|appointy\.com|"
    r"youcanbook\.me|picktime\.com|10to8\.com|cliniko\.com|nexhealth\.com|localmed\.com|"
    r"wix-bookings|/book-online|bookings-checkout|tidycal\.com|hubspot\.com/meetings|cal\.com/",
    re.I,
)
BOOKING_TEXT = re.compile(
    r"\b(book (?:now|online|an? appointment|a consultation|your appointment|a table|a session)|"
    r"schedule (?:an? )?(?:appointment|consultation|online)|make (?:an|a) (?:appointment|reservation)|"
    r"request (?:an )?appointment|reserve (?:now|a table|online))\b",
    re.I,
)


def detect_booking(soup: BeautifulSoup, html: str) -> bool:
    if BOOKING_WIDGETS.search(html or ""):
        return True
    for el in soup.find_all(["a", "button"]):
        if BOOKING_TEXT.search(el.get_text(" ", strip=True)):
            return True
    return False


FORM_SERVICES = re.compile(
    r"wpcf7|wpforms|gform_|hs-form|hsforms|typeform\.com|jotform|formspree\.io|"
    r"docs\.google\.com/forms|forms\.gle|netlify-form|data-netlify|wixforms|wix-forms|"
    r"ninja-forms|formstack|cognitoforms|123formbuilder|elementor-form",
    re.I,
)


def detect_contact_form(soup: BeautifulSoup, html: str) -> bool:
    for form in soup.find_all("form"):
        role = " ".join([form.get("role", ""), form.get("action", ""), " ".join(form.get("class", [])),
                         form.get("id", "")]).lower()
        if "search" in role and not form.find("textarea"):
            continue
        has_email = form.find("input", attrs={"type": "email"}) or form.find(
            "input", attrs={"name": re.compile("mail", re.I)})
        if form.find("textarea") or has_email:
            return True
    return bool(FORM_SERVICES.search(html or ""))


EMAIL_RE = re.compile(r"[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}")
JUNK_EMAIL_DOMAINS = {
    "example.com", "example.org", "domain.com", "email.com", "yourdomain.com", "yoursite.com",
    "sentry.io", "sentry.wixpress.com", "sentry-next.wixpress.com", "wixpress.com", "wix.com",
    "godaddy.com", "squarespace.com", "weebly.com", "mysite.com", "company.com", "test.com",
}
JUNK_LOCAL_PARTS = {"name", "email", "your", "yourname", "user", "username", "john.doe", "johndoe", "info@example"}
ASSET_SUFFIX = re.compile(r"\.(png|jpe?g|gif|svg|webp|avif|css|js|ico|bmp|tiff?)$", re.I)


def decode_cfemail(encoded: str) -> str | None:
    """Decode a Cloudflare email-protection string."""
    try:
        key = int(encoded[:2], 16)
        return "".join(chr(int(encoded[i:i + 2], 16) ^ key) for i in range(2, len(encoded), 2))
    except (ValueError, IndexError):
        return None


def _clean_email(raw: str) -> str | None:
    email = raw.strip().strip(".,;:'\"()<>[]").lower()
    if email.startswith("mailto:"):
        email = email[7:]
    email = email.split("?")[0]
    if not EMAIL_RE.fullmatch(email):
        return None
    local, _, domain = email.rpartition("@")
    if ASSET_SUFFIX.search(email) or domain in JUNK_EMAIL_DOMAINS or local in JUNK_LOCAL_PARTS:
        return None
    if re.fullmatch(r"[0-9a-f]{16,}", local):  # tracking hashes
        return None
    return email


def extract_emails(soup: BeautifulSoup, html: str) -> list[str]:
    found: list[str] = []

    def add(raw):
        email = _clean_email(raw) if raw else None
        if email and email not in found:
            found.append(email)

    for a in soup.find_all("a", href=True):
        href = a["href"]
        if href.lower().startswith("mailto:"):
            add(href)
        elif "/cdn-cgi/l/email-protection#" in href:
            add(decode_cfemail(href.split("#", 1)[1]))
    for el in soup.find_all(attrs={"data-cfemail": True}):
        add(decode_cfemail(el["data-cfemail"]))
    text = soup.get_text(" ")
    for m in EMAIL_RE.finditer(text):
        add(m.group(0))
    return found


CONTACT_HINT = re.compile(r"contact|get-in-touch|get in touch|reach-us|kontakt|contacto|contatti|nous-joindre", re.I)


def find_contact_url(soup: BeautifulSoup, base_url: str) -> str | None:
    base_host = urlsplit(base_url).netloc.lower()
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.startswith(("mailto:", "tel:", "javascript:", "#")):
            continue
        if not (CONTACT_HINT.search(href) or CONTACT_HINT.search(a.get_text(" ", strip=True))):
            continue
        full = urljoin(base_url, href).split("#")[0]
        parts = urlsplit(full)
        if parts.scheme not in ("http", "https") or parts.netloc.lower() != base_host:
            continue
        if full.rstrip("/") == base_url.rstrip("/"):
            continue
        return full
    return None


def visible_text(soup: BeautifulSoup, limit: int = 4000) -> str:
    for tag in soup(["script", "style", "noscript", "svg", "template"]):
        tag.decompose()
    text = re.sub(r"\s+", " ", soup.get_text(" ")).strip()
    return text[:limit]


def analyse_page(html: str, url: str, headers: dict | None = None) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(strip=True) if soup.title else None
    return {
        "builder": detect_builder(html, url, headers),
        "copyright_year": detect_copyright_year(soup.get_text(" ") + " " + html[-20000:]),
        "has_booking": detect_booking(soup, html),
        "has_contact_form": detect_contact_form(soup, html),
        "emails": extract_emails(soup, html),
        "contact_url": find_contact_url(soup, url),
        "page_title": title,
        "text_excerpt": visible_text(soup),
    }


def _is_html(resp: requests.Response) -> bool:
    ctype = resp.headers.get("Content-Type", "text/html").lower()
    return "html" in ctype or "xml" in ctype


def enrich_url(fetcher: PoliteFetcher, url: str) -> dict:
    """Fetch the homepage and (if found) the contact page, and combine the signals."""
    if "://" not in url:
        url = "http://" + url
    try:
        resp = fetcher.fetch(url)
        if resp is None:
            return {"status": "blocked_by_robots"}
        if resp.status_code >= 400 or not _is_html(resp):
            return {"status": "error", "http_status": resp.status_code, "final_url": resp.url,
                    "error": f"HTTP {resp.status_code} {resp.headers.get('Content-Type', '')}".strip()}
        final_url = resp.url or url
        data = analyse_page(resp.text, final_url, dict(resp.headers))
        data.update(status="ok", http_status=resp.status_code, final_url=final_url)

        contact_url = data.get("contact_url")
        if contact_url:
            try:
                cresp = fetcher.fetch(contact_url)
                if cresp is not None and cresp.status_code < 400 and _is_html(cresp):
                    contact = analyse_page(cresp.text, cresp.url or contact_url)
                    data["has_contact_form"] = data["has_contact_form"] or contact["has_contact_form"]
                    data["has_booking"] = data["has_booking"] or contact["has_booking"]
                    data["emails"] = data["emails"] + [e for e in contact["emails"] if e not in data["emails"]]
                    if not data["copyright_year"]:
                        data["copyright_year"] = contact["copyright_year"]
            except requests.RequestException as exc:
                log.info("contact page failed for %s: %s", contact_url, exc)
        return data
    except requests.RequestException as exc:
        return {"status": "error", "error": f"{type(exc).__name__}: {exc}"[:500]}
