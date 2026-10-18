import json

import pytest
import requests

from lead_miner.search import (BraveProvider, BudgetExceeded, RateLimiter, SearchClient, SearchError,
                               SerpApiProvider, SerperProvider, make_provider)

SERPER = "https://google.serper.dev/search"


def ok(payload):
    return (200, json.dumps(payload), {"Content-Type": "application/json"})


def test_parsers():
    assert SerperProvider("k").parse({"organic": [{"link": "https://a.com", "title": "A", "snippet": "s"}]})[0].url == "https://a.com"
    hit = BraveProvider("k").parse({"web": {"results": [{"url": "https://b.com", "title": "B", "description": "d"}]}})[0]
    assert (hit.url, hit.snippet) == ("https://b.com", "d")
    assert SerpApiProvider("k").parse({"organic_results": [{"link": "https://c.com"}]})[0].url == "https://c.com"
    assert BraveProvider("k").parse({}) == []


def test_request_shapes():
    r = SerperProvider("KEY").build_request("q", 2)
    assert r["headers"]["X-API-KEY"] == "KEY" and r["json"] == {"q": "q", "num": 10, "page": 2}
    r = BraveProvider("KEY").build_request("q", 3)
    assert r["headers"]["X-Subscription-Token"] == "KEY" and r["params"]["offset"] == 2
    r = SerpApiProvider("KEY").build_request("q", 2)
    assert r["params"]["api_key"] == "KEY" and r["params"]["start"] == 10


def test_make_provider_validation():
    with pytest.raises(ValueError):
        make_provider("google", "k")
    with pytest.raises(ValueError):
        make_provider("serper", "")


def test_retry_with_backoff_then_success(fake_session):
    session = fake_session({SERPER: [(429, "slow down", {"Retry-After": "7"}), (503, "oops"),
                                     ok({"organic": [{"link": "https://a.com"}]})]})
    sleeps, log = [], []
    client = SearchClient(SerperProvider("k"), min_interval=0, session=session, sleep=sleeps.append,
                          on_request=lambda *a: log.append(a))
    hits = client.search("dentist")
    assert [h.url for h in hits] == ["https://a.com"]
    assert len(session.adapter.calls) == 3
    assert sleeps[0] == 7  # Retry-After honoured
    assert 4 <= sleeps[1] <= 4.5  # 2**2 plus jitter
    assert [(entry[4], entry[5]) for entry in log] == [(429, False), (503, False), (200, True)]  # every request logged


def test_gives_up_after_max_retries(fake_session):
    session = fake_session({SERPER: [requests.ConnectionError("down")]})
    client = SearchClient(SerperProvider("k"), min_interval=0, max_retries=2, session=session, sleep=lambda s: None)
    with pytest.raises(SearchError):
        client.search("x")
    assert len(session.adapter.calls) == 3


def test_non_retryable_error_fails_fast(fake_session):
    session = fake_session({SERPER: (401, "bad key")})
    client = SearchClient(SerperProvider("k"), min_interval=0, session=session, sleep=lambda s: None)
    with pytest.raises(SearchError, match="401"):
        client.search("x")
    assert len(session.adapter.calls) == 1


def test_budget_check_stops_before_request(fake_session):
    session = fake_session({SERPER: ok({"organic": []})})

    def check():
        raise BudgetExceeded()

    client = SearchClient(SerperProvider("k"), min_interval=0, session=session, budget_check=check)
    with pytest.raises(BudgetExceeded):
        client.search("x")
    assert session.adapter.calls == []


def test_rate_limiter():
    t = [100.0]
    sleeps = []
    rl = RateLimiter(1.0, clock=lambda: t[0], sleep=lambda s: (sleeps.append(s), t.__setitem__(0, t[0] + s)))
    rl.wait()
    t[0] += 0.25
    rl.wait()
    assert sleeps == [0.75]
