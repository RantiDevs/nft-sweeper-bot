import pytest
import requests
from requests.adapters import BaseAdapter

from lead_miner import db


class FakeAdapter(BaseAdapter):
    """Serves canned responses keyed by URL (query string ignored).

    A route value is either (status, body[, headers]) or a list of those,
    consumed in order. An Exception instance in place of a response is raised.
    """

    def __init__(self, routes):
        super().__init__()
        self.routes = routes
        self.calls = []

    def send(self, request, **kwargs):
        self.calls.append(request)
        key = request.url.split("?")[0]
        route = self.routes.get(key)
        if route is None:
            spec = (404, "not found")
        elif isinstance(route, list):
            spec = route.pop(0) if len(route) > 1 else route[0]
        else:
            spec = route
        if isinstance(spec, Exception):
            raise spec
        status, body = spec[0], spec[1]
        headers = spec[2] if len(spec) > 2 else {"Content-Type": "text/html; charset=utf-8"}
        resp = requests.Response()
        resp.status_code = status
        resp._content = body.encode() if isinstance(body, str) else body
        resp.headers.update(headers)
        resp.url = request.url
        resp.request = request
        resp.encoding = "utf-8"
        import io
        resp.raw = io.BytesIO(resp._content)
        return resp

    def close(self):
        pass


@pytest.fixture
def fake_session():
    def make(routes):
        s = requests.Session()
        adapter = FakeAdapter(routes)
        s.mount("http://", adapter)
        s.mount("https://", adapter)
        s.adapter = adapter
        return s
    return make


@pytest.fixture
def conn():
    c = db.connect(":memory:")
    yield c
    c.close()
