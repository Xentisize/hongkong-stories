"""Shared fixtures for the backend test suite."""

from __future__ import annotations

import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTENT_DIR = REPO_ROOT / "client" / "content"
CONDITION_FIXTURES = REPO_ROOT / "client" / "tests" / "fixtures" / "conditions.json"


@pytest.fixture(scope="session")
def content_dir() -> Path:
    return CONTENT_DIR


@pytest.fixture(scope="session")
def condition_cases() -> list[dict]:
    return json.loads(CONDITION_FIXTURES.read_text(encoding="utf-8"))["cases"]


@pytest.fixture()
def settings(content_dir: Path) -> Settings:
    # A fake key: nothing in the unit suite may reach the network.
    return Settings(openrouter_api_key="test-key-not-real", content_dir=content_dir)


@pytest.fixture()
def app(settings: Settings):
    return create_app(settings)


@pytest.fixture()
def client(app) -> Iterator[TestClient]:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture(scope="session")
def npc(content_dir: Path) -> dict:
    from app.content import ContentStore

    return ContentStore.load(content_dir).npc("npc_p2_shopkeeper")
