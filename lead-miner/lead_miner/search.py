"""Search API providers with rate limiting, retry with backoff, and request logging."""

from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass
from typing import Callable

import requests

log = logging.getLogger("lead_miner.search")

RETRY_STATUSES = {408, 425, 429, 500, 502, 503, 504}


@dataclass
class SearchHit:
    url: str
    title: str
    snippet: str


class SearchError(Exception):
    """A search request failed permanently (after retries, or a non-retryable error)."""


class BudgetExceeded(Exception):
    """The daily search budget is used up."""


class Provider:
    name = ""
    page_size = 10

    def __init__(self, api_key: str):
        if not api_key:
            raise ValueError(f"No API key configured for search provider '{self.name}'")
        self.api_key = api_key

    def build_request(self, query: str, page: int) -> dict:
        """Return kwargs for requests.Session.request (page is 1-based)."""
        raise NotImplementedError

    def parse(self, data: dict) -> list[SearchHit]:
        raise NotImplementedError


class SerperProvider(Provider):
    name = "serper"

    def build_request(self, query, page):
        return {
            "method": "POST",
            "url": "https://google.serper.dev/search",
            "headers": {"X-API-KEY": self.api_key, "Content-Type": "application/json"},
            "json": {"q": query, "num": self.page_size, "page": page},
        }

    def parse(self, data):
        return [SearchHit(r.get("link", ""), r.get("title", ""), r.get("snippet", ""))
                for r in data.get("organic", []) if r.get("link")]


class BraveProvider(Provider):
    name = "brave"
    page_size = 20

    def build_request(self, query, page):
        return {
            "method": "GET",
            "url": "https://api.search.brave.com/res/v1/web/search",
            "headers": {"X-Subscription-Token": self.api_key, "Accept": "application/json"},
            "params": {"q": query, "count": self.page_size, "offset": page - 1},
        }

    def parse(self, data):
        return [SearchHit(r.get("url", ""), r.get("title", ""), r.get("description", ""))
                for r in (data.get("web") or {}).get("results", []) if r.get("url")]


class SerpApiProvider(Provider):
    name = "serpapi"

    def build_request(self, query, page):
        return {
            "method": "GET",
            "url": "https://serpapi.com/search.json",
            "params": {"engine": "google", "q": query, "api_key": self.api_key,
                       "num": self.page_size, "start": (page - 1) * self.page_size},
        }

    def parse(self, data):
        return [SearchHit(r.get("link", ""), r.get("title", ""), r.get("snippet", ""))
                for r in data.get("organic_results", []) if r.get("link")]


PROVIDERS = {p.name: p for p in (SerperProvider, BraveProvider, SerpApiProvider)}


def make_provider(name: str, api_key: str) -> Provider:
    try:
        return PROVIDERS[name.lower()](api_key)
    except KeyError:
        raise ValueError(f"Unknown search provider '{name}'. Choose from: {', '.join(PROVIDERS)}") from None


class RateLimiter:
    """Enforces a minimum interval between calls."""

    def __init__(self, min_interval: float, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        self.min_interval = min_interval
        self.clock = clock
        self.sleep = sleep
        self._last: float | None = None

    def wait(self) -> None:
        if self._last is not None:
            remaining = self.min_interval - (self.clock() - self._last)
            if remaining > 0:
                self.sleep(remaining)
        self._last = self.clock()


class SearchClient:
    """Runs queries against one provider.

    `on_request` is called after every HTTP attempt with
    (provider, query, page, attempt, status_code, ok, elapsed_ms, error), and
    `budget_check` before every attempt; it raises BudgetExceeded to stop.
    """

    def __init__(self, provider: Provider, min_interval: float = 1.0, max_retries: int = 4,
                 backoff_base: float = 2.0, backoff_max: float = 60.0, timeout: float = 30.0,
                 session: requests.Session | None = None, sleep: Callable[[float], None] = time.sleep,
                 on_request: Callable[..., None] | None = None,
                 budget_check: Callable[[], None] | None = None):
        self.provider = provider
        self.max_retries = max_retries
        self.backoff_base = backoff_base
        self.backoff_max = backoff_max
        self.timeout = timeout
        self.session = session or requests.Session()
        self.sleep = sleep
        self.limiter = RateLimiter(min_interval, sleep=sleep)
        self.on_request = on_request
        self.budget_check = budget_check

    def _backoff(self, attempt: int, retry_after: str | None) -> float:
        if retry_after and retry_after.strip().isdigit():
            return min(float(retry_after), self.backoff_max)
        delay = min(self.backoff_base ** attempt, self.backoff_max)
        return delay + random.uniform(0, delay * 0.1)

    def _record(self, *args) -> None:
        if self.on_request:
            self.on_request(self.provider.name, *args)

    def search(self, query: str, page: int = 1) -> list[SearchHit]:
        last_error = ""
        for attempt in range(1, self.max_retries + 2):
            if self.budget_check:
                self.budget_check()
            self.limiter.wait()
            started = time.monotonic()
            status = None
            retry_after = None
            try:
                resp = self.session.request(timeout=self.timeout, **self.provider.build_request(query, page))
                status = resp.status_code
                elapsed = int((time.monotonic() - started) * 1000)
                if resp.ok:
                    hits = self.provider.parse(resp.json())
                    log.info("%s page=%d attempt=%d status=%s hits=%d %dms q=%s",
                             self.provider.name, page, attempt, status, len(hits), elapsed, query)
                    self._record(query, page, attempt, status, True, elapsed, None)
                    return hits
                last_error = f"HTTP {status}: {resp.text[:200]}"
                retry_after = resp.headers.get("Retry-After")
                retryable = status in RETRY_STATUSES
            except (requests.ConnectionError, requests.Timeout) as exc:
                elapsed = int((time.monotonic() - started) * 1000)
                last_error = f"{type(exc).__name__}: {exc}"
                retryable = True
            except ValueError as exc:  # invalid JSON body
                elapsed = int((time.monotonic() - started) * 1000)
                last_error = f"Invalid JSON: {exc}"
                retryable = True

            log.warning("%s page=%d attempt=%d status=%s %dms q=%s error=%s",
                        self.provider.name, page, attempt, status, elapsed, query, last_error)
            self._record(query, page, attempt, status, False, elapsed, last_error)
            if not retryable or attempt > self.max_retries:
                break
            delay = self._backoff(attempt, retry_after)
            log.info("retrying in %.1fs", delay)
            self.sleep(delay)
        raise SearchError(last_error)
