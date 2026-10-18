from types import SimpleNamespace

import pytest

from lead_miner import db
from lead_miner.draft import DraftError, generate_draft, render_prompt, write_draft_file


class FakeMessages:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


def fake_client(text="Business: Smile\nSubject: hi", stop_reason="end_turn"):
    content = [SimpleNamespace(type="thinking", thinking=""), SimpleNamespace(type="text", text=text)]
    messages = FakeMessages(SimpleNamespace(content=content, stop_reason=stop_reason))
    return SimpleNamespace(beta=SimpleNamespace(messages=messages))


@pytest.fixture
def lead(conn):
    db.insert_queries(conn, [{"query": "q", "niche": "dentist", "location": "Leeds", "country": "United Kingdom",
                              "tier": "1", "pattern": "outdated_copyright"}])
    db.insert_result(conn, 1, "https://smile.example/", "Smile Dental", "Leeds dentist")
    conn.commit()
    db.save_site(conn, 1, {"status": "ok", "builder": "Wix", "copyright_year": 2016, "has_booking": False,
                           "has_contact_form": True, "emails": ["a@smile.example"], "text_excerpt": "Welcome"})
    return db.leads(conn)[0]


def test_render_prompt_fills_known_placeholders_only(lead):
    template = "From {sender_name} ({sender_role}) to {niche} in {location}, {country}.\n{site_data}\nKeep {braces}."
    out = render_prompt(template, lead, "Ada", "Founder")
    assert out.startswith("From Ada (Founder) to dentist in Leeds, United Kingdom.")
    assert "Site builder: Wix" in out and "Latest copyright year on page: 2016" in out
    assert "Online booking detected: no" in out and "Welcome" in out
    assert out.endswith("Keep {braces}.")


def test_generate_draft_request_and_text():
    client = fake_client()
    assert generate_draft(client, "prompt", "claude-opus-5-5") == "Business: Smile\nSubject: hi"
    call = client.beta.messages.calls[0]
    assert call["model"] == "claude-opus-5-5"
    assert call["messages"] == [{"role": "user", "content": "prompt"}]
    assert call["fallbacks"] == "default" and call["betas"] == ["server-side-fallback-2026-07-01"]
    client2 = fake_client()
    generate_draft(client2, "p", "m", fallbacks=False)
    assert "fallbacks" not in client2.beta.messages.calls[0]


def test_refusal_raises():
    with pytest.raises(DraftError):
        generate_draft(fake_client(stop_reason="refusal"), "p", "m")


def test_write_draft_file(tmp_path, lead):
    path = write_draft_file(tmp_path, lead, "Subject: hello")
    body = path.read_text()
    assert path.name == "00001-smile-example.txt"
    assert body.startswith("DRAFT ONLY") and "Source URL: https://smile.example/" in body


def test_no_sending_code_anywhere():
    import pathlib
    src = pathlib.Path(__file__).resolve().parent.parent / "lead_miner"
    text = "".join(p.read_text() for p in src.glob("*.py"))
    assert "smtplib" not in text and "sendmail" not in text
