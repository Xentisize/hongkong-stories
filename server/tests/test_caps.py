"""Per-IP daily caps and error telemetry (PLAN 7.5 guards, P6).

Counts and gates only — nothing here touches the network, and no test asserts on anything
that could be PII.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.caps import DailyCaps, best_client_ip
from app.config import Settings
from app.errors import ErrorCounts
from app.main import create_app


def test_session_gate_blocks_at_limit() -> None:
    caps = DailyCaps(max_sessions=2, max_cost_usd=10.0)
    assert caps.session_allowed("1.2.3.4")
    caps.add_session("1.2.3.4")
    caps.add_session("1.2.3.4")
    assert not caps.session_allowed("1.2.3.4")
    assert caps.session_allowed("5.6.7.8")  # another address is unaffected


def test_cost_cap_reached_and_not_unwindable() -> None:
    caps = DailyCaps(max_sessions=10, max_cost_usd=2.0)
    caps.add_cost("1.2.3.4", 1.5)
    assert not caps.cost_cap_reached("1.2.3.4")
    caps.add_cost("1.2.3.4", 1.0)
    assert caps.cost_cap_reached("1.2.3.4")
    caps.add_cost("1.2.3.4", -5.0)  # negative cost cannot unwind the cap
    assert caps.cost_cap_reached("1.2.3.4")


def test_best_client_ip_prefers_proxies() -> None:
    headers = {"x-forwarded-for": "9.9.9.9, 10.0.0.1", "fly-client-ip": "8.8.4.4"}
    assert best_client_ip(headers, "127.0.0.1") == "9.9.9.9"
    assert best_client_ip({"fly-client-ip": "8.8.4.4"}, "127.0.0.1") == "8.8.4.4"
    assert best_client_ip({}, "127.0.0.1") == "127.0.0.1"


def test_error_counts_summary_is_counts_only() -> None:
    counts = ErrorCounts()
    counts.record("upstream_error")
    counts.record("upstream_error")
    counts.record("daily_cap")
    summary = counts.summary()
    assert summary["total"] == 3
    top = {item["code"]: item["count"] for item in summary["top"]}
    assert top["upstream_error"] == 2
    assert top["daily_cap"] == 1


def test_healthz_exposes_caps_and_error_counts(tmp_path: Path) -> None:
    pack = tmp_path / "content"
    pack.mkdir()
    (pack / "manifest.json").write_text(
        json.dumps({"manifest_schema": 1, "version": 1, "content_hash": "x", "files": []}),
        encoding="utf-8",
    )
    client = TestClient(create_app(Settings(
        openrouter_api_key="x", content_dir=pack, admin_data_dir=tmp_path / "data",
    )))
    health = client.get("/healthz").json()
    assert health["caps"]["date"]
    assert health["caps"]["sessions_cap_per_ip"] > 0
    assert "errors" in health and "total" in health["errors"]


def test_router_refuses_when_the_daily_session_cap_is_hit(tmp_path: Path) -> None:
    pack = tmp_path / "content"
    (pack / "npcs").mkdir(parents=True)
    (pack / "manifest.json").write_text(
        json.dumps({"manifest_schema": 1, "version": 1, "content_hash": "x", "files": []}),
        encoding="utf-8",
    )
    settings = Settings(
        openrouter_api_key="x", content_dir=pack, admin_data_dir=tmp_path / "data",
        per_ip_daily_sessions=2,
    )
    client = TestClient(create_app(settings))
    for _ in range(2):
        assert client.post("/v1/session").status_code == 200
    refused = client.post("/v1/session")
    assert refused.status_code == 429
    assert refused.json()["detail"]["code"] == "daily_cap"