"""Optional step: draft outreach emails with the Anthropic API.

Drafts are only stored (database + text files) for a human to review.
This module never sends email, and nothing in lead-miner does.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

log = logging.getLogger("lead_miner.draft")

PLACEHOLDERS = ("sender_name", "sender_role", "niche", "location", "country", "site_data", "url")


class DraftError(Exception):
    pass


def site_data_block(lead) -> str:
    def yes_no(v):
        return "unknown" if v is None else ("yes" if v else "no")

    lines = [
        f"URL: {lead['url']}",
        f"Search result title: {lead['title'] or ''}",
        f"Search result snippet: {lead['snippet'] or ''}",
        f"Page title: {lead['page_title'] or ''}",
        f"Site builder: {lead['builder'] or 'not detected'}",
        f"Latest copyright year on page: {lead['copyright_year'] or 'not found'}",
        f"Online booking detected: {yes_no(lead['has_booking'])}",
        f"Contact form detected: {yes_no(lead['has_contact_form'])}",
        f"Public emails found: {lead['emails'] or 'none'}",
        f"Contact page: {lead['contact_url'] or 'not found'}",
        f"Found via search pattern: {lead['pattern'] or 'base platform search'}",
        "",
        "Homepage text excerpt:",
        lead["text_excerpt"] or "(no text extracted)",
    ]
    return "\n".join(lines)


def render_prompt(template: str, lead, sender_name: str, sender_role: str) -> str:
    values = {
        "sender_name": sender_name or "[sender name]",
        "sender_role": sender_role or "[role]",
        "niche": lead["niche"] or "",
        "location": lead["location"] or "",
        "country": lead["country"] or "",
        "url": lead["url"],
        "site_data": site_data_block(lead),
    }
    # Replace only known placeholders so other braces in the prompt stay intact.
    return re.sub(r"\{(" + "|".join(PLACEHOLDERS) + r")\}", lambda m: values[m.group(1)], template)


def make_client():
    try:
        import anthropic
    except ImportError as exc:  # pragma: no cover - depends on install
        raise DraftError("The draft step needs the anthropic package: pip install 'lead-miner[draft]'") from exc
    return anthropic.Anthropic()


def generate_draft(client, prompt: str, model: str, effort: str = "medium", fallbacks: bool = True) -> str:
    kwargs = dict(
        model=model,
        max_tokens=16000,
        output_config={"effort": effort},
        messages=[{"role": "user", "content": prompt}],
    )
    if fallbacks:
        # Server-side refusal fallback: the API re-runs a declined request on a
        # recommended fallback model instead of returning the refusal.
        kwargs.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")
    response = client.beta.messages.create(**kwargs)
    if response.stop_reason == "refusal":
        raise DraftError("The model declined to write this draft")
    text = "".join(block.text for block in response.content if block.type == "text").strip()
    if not text:
        raise DraftError(f"Empty response (stop_reason={response.stop_reason})")
    return text


def write_draft_file(out_dir: str | Path, lead, draft: str) -> Path:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^a-z0-9]+", "-", lead["domain"].lower()).strip("-")[:80]
    path = out_dir / f"{lead['result_id']:05d}-{slug}.txt"
    path.write_text(
        f"DRAFT ONLY. Review, verify, and send manually if appropriate.\n"
        f"Source URL: {lead['url']}\nFound: {lead['found_at']}\nEmails: {lead['emails'] or ''}\n\n{draft}\n",
        encoding="utf-8",
    )
    return path
