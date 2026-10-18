from bs4 import BeautifulSoup

from lead_miner.enrich import (PoliteFetcher, decode_cfemail, detect_booking, detect_builder,
                               detect_contact_form, detect_copyright_year, enrich_url, extract_emails,
                               find_contact_url)

HOME = """<html><head><title>Smile Dental Leeds</title>
<meta name="generator" content="Wix.com Website Builder"></head>
<body><h1>Smile Dental</h1><p>Call to book: 0113 000 0000</p>
<a href="/contact-us">Contact</a><a href="mailto:Hello@SmileDental.co.uk?subject=hi">Email us</a>
<img src="logo@2x.png"><footer>© 2012 - 2016 Smile Dental. All rights reserved.</footer></body></html>"""

CONTACT = """<html><body><form action="/send"><input name="name"><input type="email" name="email">
<textarea name="msg"></textarea></form><p>Or write to smiledental@gmail.com</p>
<a href="/cdn-cgi/l/email-protection#{cf}">[email protected]</a></body></html>"""


def cf_encode(email, key=0x42):
    return f"{key:02x}" + "".join(f"{ord(c) ^ key:02x}" for c in email)


def soup(html):
    return BeautifulSoup(html, "html.parser")


def test_detect_builder():
    assert detect_builder(HOME) == "Wix"
    assert detect_builder('<link href="https://img1.wsimg.com/x.css">') == "GoDaddy"
    assert detect_builder('<script src="/wp-content/themes/x.js"></script>') == "WordPress"
    assert detect_builder("<p>hi</p>", url="https://joe.weebly.com/") == "Weebly"
    assert detect_builder('<html data-wf-page="1">') == "Webflow"
    assert detect_builder("<p>plain</p>", url="https://acme.com") is None


def test_copyright_year():
    assert detect_copyright_year("© 2012 - 2016 Acme", current_year=2026) == 2016
    assert detect_copyright_year("Copyright 2019 Acme. &copy; 2014", current_year=2026) == 2019
    assert detect_copyright_year("Copyright © Acme Ltd 2015", current_year=2026) == 2015
    assert detect_copyright_year("(c) 2099 future", current_year=2026) is None
    assert detect_copyright_year("Founded in 2010", current_year=2026) is None


def test_booking_detection():
    assert not detect_booking(soup(HOME), HOME)
    assert detect_booking(soup('<a href="/x">Book an appointment</a>'), "")
    html = '<iframe src="https://calendly.com/acme"></iframe>'
    assert detect_booking(soup(html), html)


def test_contact_form_detection():
    html = CONTACT.format(cf="")
    assert detect_contact_form(soup(html), html)
    search = '<form role="search"><input name="q"></form>'
    assert not detect_contact_form(soup(search), search)
    embed = '<script src="https://form.jotform.com/123.js"></script>'
    assert detect_contact_form(soup(embed), embed)


def test_email_extraction_filters_junk_and_decodes_cloudflare():
    assert decode_cfemail(cf_encode("info@acme.com")) == "info@acme.com"
    html = CONTACT.format(cf=cf_encode("office@smiledental.co.uk")) + "<p>you@example.com x@sentry.wixpress.com</p>"
    assert extract_emails(soup(html), html) == ["office@smiledental.co.uk", "smiledental@gmail.com"]
    assert extract_emails(soup(HOME), HOME) == ["hello@smiledental.co.uk"]


def test_find_contact_url():
    base = "https://smile.example/"
    assert find_contact_url(soup(HOME), base) == "https://smile.example/contact-us"
    external = '<a href="https://other.com/contact">Contact</a><a href="/">Home</a>'
    assert find_contact_url(soup(external), base) is None


def make_fetcher(fake_session, routes, sleeps=None):
    clock = [0.0]
    sleeps = sleeps if sleeps is not None else []

    def sleep(s):
        sleeps.append(s)
        clock[0] += s

    return PoliteFetcher("TestBot/1.0", min_interval=1.0, session=fake_session(routes),
                         clock=lambda: clock[0], sleep=sleep)


def test_enrich_url_combines_home_and_contact(fake_session):
    sleeps = []
    fetcher = make_fetcher(fake_session, {
        "https://smile.example/robots.txt": (200, "User-agent: *\nDisallow: /private\n", {"Content-Type": "text/plain"}),
        "https://smile.example/": (200, HOME),
        "https://smile.example/contact-us": (200, CONTACT.format(cf=cf_encode("office@smile.example"))),
    }, sleeps)
    data = enrich_url(fetcher, "https://smile.example/")
    assert data["status"] == "ok"
    assert data["builder"] == "Wix"
    assert data["copyright_year"] == 2016
    assert data["has_booking"] is False
    assert data["has_contact_form"] is True
    assert data["emails"] == ["hello@smiledental.co.uk", "office@smile.example", "smiledental@gmail.com"]
    assert data["page_title"] == "Smile Dental Leeds"
    # robots.txt, homepage, contact page: 3 requests to one host, at least 1s apart.
    assert len(fetcher.session.adapter.calls) == 3
    assert sleeps == [1.0, 1.0]
    assert all(c.headers["User-Agent"] == "TestBot/1.0" for c in fetcher.session.adapter.calls)


def test_robots_disallow_is_respected(fake_session):
    fetcher = make_fetcher(fake_session, {
        "https://shy.example/robots.txt": (200, "User-agent: *\nDisallow: /\n", {"Content-Type": "text/plain"}),
        "https://shy.example/": (200, HOME),
    })
    assert enrich_url(fetcher, "https://shy.example/") == {"status": "blocked_by_robots"}
    assert [c.url for c in fetcher.session.adapter.calls] == ["https://shy.example/robots.txt"]


def test_missing_robots_allows_and_errors_are_recorded(fake_session):
    fetcher = make_fetcher(fake_session, {"https://gone.example/": (500, "err")})
    data = enrich_url(fetcher, "https://gone.example/")
    assert data["status"] == "error" and data["http_status"] == 500


def test_robots_server_error_means_disallow(fake_session):
    fetcher = make_fetcher(fake_session, {"https://flaky.example/robots.txt": (503, "down")})
    assert enrich_url(fetcher, "https://flaky.example/") == {"status": "blocked_by_robots"}
