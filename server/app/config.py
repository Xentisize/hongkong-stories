"""Server configuration (PLAN 10.6 for the toolchain, PLAN 3 for the secret boundary).

The OpenRouter key is read from the environment (or the repo-root `.env`) and never leaves
this process: no endpoint echoes it, no log line includes it, and the client bundle has no
mechanism to receive it.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
CLIENT_CONTENT = REPO_ROOT / "client" / "content"
DOTENV_PATH = REPO_ROOT / ".env"


def load_env_file(path: Path = DOTENV_PATH) -> dict[str, str]:
    """Parse KEY=VALUE lines. Never logs values."""
    values: dict[str, str] = {}
    if not path.is_file():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


@dataclass(frozen=True)
class Settings:
    openrouter_api_key: str = ""
    chat_model: str = "deepseek/deepseek-v4.1-flash-1017"
    image_model: str = "bytedance-seed/seedream-5-0-flash"
    # json = response_format json_schema + incremental `say` extraction (verified live).
    # prose = plain text stream with a trailing ```actions block. Both are implemented so the
    # choice is a config flip, not a rewrite (PLAN 7.3).
    chat_output_mode: str = "json"
    max_tokens: int = 320
    temperature: float = 0.85
    session_token_budget: int = 60_000
    upstream_timeout_sec: float = 30.0
    content_dir: Path = CLIENT_CONTENT
    allowed_origins: tuple[str, ...] = (
        "http://localhost:8099",
        "http://127.0.0.1:8099",
        "http://localhost:5173",
    )

    @property
    def has_key(self) -> bool:
        return bool(self.openrouter_api_key)

    @classmethod
    def from_env(cls) -> Settings:
        # Real environment variables win over .env, so container deploys and CI work unchanged.
        env = {**load_env_file(), **os.environ}
        origins = env.get("HKS_ALLOWED_ORIGINS", "")
        return cls(
            openrouter_api_key=env.get("OPENROUTER_API_KEY", ""),
            chat_model=env.get("HKS_CHAT_MODEL", cls.chat_model),
            image_model=env.get("HKS_IMAGE_MODEL", cls.image_model),
            chat_output_mode=env.get("HKS_CHAT_OUTPUT_MODE", cls.chat_output_mode),
            max_tokens=int(env.get("HKS_MAX_TOKENS", cls.max_tokens)),
            temperature=float(env.get("HKS_TEMPERATURE", cls.temperature)),
            session_token_budget=int(env.get("HKS_SESSION_BUDGET", cls.session_token_budget)),
            upstream_timeout_sec=float(env.get("HKS_UPSTREAM_TIMEOUT", cls.upstream_timeout_sec)),
            content_dir=Path(env.get("HKS_CONTENT_DIR", cls.content_dir)),
            allowed_origins=tuple(o.strip() for o in origins.split(",") if o.strip()) or cls.allowed_origins,
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.from_env()
