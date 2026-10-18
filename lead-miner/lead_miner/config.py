"""Settings loaded from the environment (and a .env file, if present)."""

from __future__ import annotations

import os
from dataclasses import dataclass

from dotenv import load_dotenv

PROVIDER_KEY_VARS = {
    "serper": "SERPER_API_KEY",
    "brave": "BRAVE_API_KEY",
    "serpapi": "SERPAPI_API_KEY",
}


def _float(name: str, default: float) -> float:
    raw = os.getenv(name, "").split("#")[0].strip()
    return float(raw) if raw else default


def _int(name: str, default: int) -> int:
    raw = os.getenv(name, "").split("#")[0].strip()
    return int(raw) if raw else default


def _str(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip() or default


@dataclass
class Settings:
    db_path: str = "lead_miner.db"
    log_file: str = "lead_miner.log"

    search_provider: str = "serper"
    search_api_key: str = ""
    search_min_interval: float = 1.0
    search_max_retries: int = 4
    daily_query_budget: int = 100

    user_agent: str = "LeadMinerBot/0.1 (+https://rantidevs.org)"
    fetch_timeout: float = 15.0
    domain_min_interval: float = 1.0

    anthropic_model: str = "claude-opus-5-5"
    anthropic_effort: str = "medium"
    anthropic_fallbacks: bool = True
    sender_name: str = ""
    sender_role: str = ""

    @classmethod
    def from_env(cls, env_file: str | None = ".env") -> "Settings":
        if env_file:
            load_dotenv(env_file, override=False)
        provider = _str("SEARCH_PROVIDER", "serper").lower()
        return cls(
            db_path=_str("LEAD_MINER_DB", "lead_miner.db"),
            log_file=_str("LEAD_MINER_LOG", "lead_miner.log"),
            search_provider=provider,
            search_api_key=_str(PROVIDER_KEY_VARS.get(provider, "")),
            search_min_interval=_float("SEARCH_MIN_INTERVAL", 1.0),
            search_max_retries=_int("SEARCH_MAX_RETRIES", 4),
            daily_query_budget=_int("DAILY_QUERY_BUDGET", 100),
            user_agent=_str("USER_AGENT", cls.user_agent),
            fetch_timeout=_float("FETCH_TIMEOUT", 15.0),
            domain_min_interval=_float("DOMAIN_MIN_INTERVAL", 1.0),
            anthropic_model=_str("ANTHROPIC_MODEL", "claude-opus-5-5"),
            anthropic_effort=_str("ANTHROPIC_EFFORT", "medium"),
            anthropic_fallbacks=_str("ANTHROPIC_FALLBACKS", "1") not in ("0", "false", "no"),
            sender_name=_str("SENDER_NAME"),
            sender_role=_str("SENDER_ROLE"),
        )
