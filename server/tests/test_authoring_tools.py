"""Authoring tools (PLAN 9.2) — condition evaluation, publish preview, persona playground,
fact-check queue, usage dashboard. Every LLM-touching path is stubbed: the unit suite never
reaches the network."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.usage import estimate_cost

TOKEN = "test-admin-token"


@pytest.fixture()
def tools_env(tmp_path: Path, content_dir: Path) -> tuple[TestClient, Path, Path]:
    shutil = pytest.importorskip("shutil")
    pack = tmp_path / "content"
    shutil.copytree(content_dir, pack)  # copytree creates the destination itself
    data = tmp_path / "data"
    data.mkdir()
    client = TestClient(create_app(Settings(
        openrouter_api_key="x", admin_token=TOKEN, content_dir=pack, admin_data_dir=data,
    )))
    return client, pack, data


def auth() -> dict:
    return {"Authorization": f"Bearer {TOKEN}"}


def _load_npc(pack: Path) -> dict:
    return json.loads((pack / "npcs" / "npc_ch01_wai.json").read_text())


def test_evaluate_condition_true_and_false(tools_env) -> None:
    client, _pack, _data = tools_env
    passed = client.post("/v1/admin/evaluate_condition", headers=auth(), json={
        "condition": {"all": [{"flag": "a"}, {"has_item": "k"}]},
        "state": {"flags": {"a": True}, "inventory": {"k": 1}},
    }).json()
    assert passed == {"pass": True}
    failed = client.post("/v1/admin/evaluate_condition", headers=auth(), json={
        "condition": {"flag": "a"}, "state": {},
    }).json()
    assert failed == {"pass": False}


def test_evaluate_condition_rejects_garbage(tools_env) -> None:
    client, _pack, _data = tools_env
    assert client.post("/v1/admin/evaluate_condition", headers=auth(),
                       json="not an object").status_code == 422


def test_publish_preview_lists_added_and_changed(tools_env) -> None:
    client, pack, _data = tools_env
    assert client.get("/v1/admin/publish_preview", headers=auth()).json() == {"added": [], "changed": []}

    base = _load_npc(pack)
    new = {**base, "id": "npc_preview_new"}
    changed = {**base, "persona": {**base["persona"], "role": "rewritten"}}
    assert client.put("/v1/admin/drafts/npcs/npc_preview_new", json=new, headers=auth()).status_code == 200
    assert client.put("/v1/admin/drafts/npcs/npc_ch01_wai", json=changed, headers=auth()).status_code == 200

    preview = client.get("/v1/admin/publish_preview", headers=auth()).json()
    assert {"kind": "npcs", "id": "npc_preview_new"} in preview["added"]
    assert {"kind": "npcs", "id": "npc_ch01_wai"} in preview["changed"]


def test_playground_surfaces_usage_and_rejections(
    tools_env, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.routers.admin as admin_mod
    from app.llm import openrouter

    client, pack, _data = tools_env
    npc = _load_npc(pack)

    async def fake_complete(settings, *, messages, mode=None, max_tokens=None, temperature=None):
        assert isinstance(messages, list) and messages[0]["role"] == "system"
        return openrouter.PlaygroundResult(
            say="後生仔，執嘢啊？", mood="gruff",
            actions=[{"type": "give", "item": "item_nope"}], raw="x", truncated=False,
            prompt_tokens=1900, completion_tokens=200, cached_tokens=1700, cost_usd=0.00045,
        )

    monkeypatch.setattr(admin_mod.openrouter, "complete_chat", fake_complete)
    body = client.post("/v1/admin/playground", headers=auth(), json={
        "npc": npc, "state": {"flags": {}}, "lang": "zh_HK", "input": "你好",
    }).json()
    assert body["say"] == "後生仔，執嘢啊？"
    assert body["usage"]["cached_tokens"] == 1700
    assert 0 < body["usage"]["cache_ratio"] < 1
    # wai's allowlist is reveal_secret only, so a give is refused at the type level.
    assert [r["reason"] for r in body["rejected"]] == ["type_not_allowed"]
    assert body["latency_ms"] >= 0


def test_playground_needs_a_key(tmp_path: Path) -> None:
    pack = tmp_path / "content"
    pack.mkdir()
    (pack / "manifest.json").write_text(
        json.dumps({"manifest_schema": 1, "version": 1, "content_hash": "x", "files": []}),
        encoding="utf-8",
    )
    data = tmp_path / "data"
    data.mkdir()
    client = TestClient(create_app(Settings(
        admin_token=TOKEN, content_dir=pack, admin_data_dir=data,
    )))
    assert client.post("/v1/admin/playground", headers=auth(),
                       json={"npc": {"id": "x"}, "input": "hi"}).status_code == 503


def test_factcheck_queue_roundtrip(
    tools_env, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.factcheck as factcheck_module

    client, pack, _data = tools_env
    npc = _load_npc(pack)

    def stub_result():
        raw = '{"verdict": "contradiction", "reason": "lore says nothing about planes"}'
        from app.llm.openrouter import PlaygroundResult
        return PlaygroundResult(
            say=raw, mood="neutral", actions=[], raw=raw, truncated=False,
            prompt_tokens=120, completion_tokens=24, cached_tokens=0, cost_usd=0.00002,
        )

    async def fake_complete(settings, **kwargs):
        return stub_result()

    monkeypatch.setattr(factcheck_module, "complete_chat", fake_complete)

    entry = client.post("/v1/admin/factcheck/check", headers=auth(), json={
        "npc": npc, "player_input": "讲下飞机", "reply": "1970年有好多飞机",
    }).json()
    assert entry["verdict"] == "contradiction"
    assert entry["status"] == "open"

    listed = client.get("/v1/admin/factcheck", headers=auth()).json()
    assert [e["id"] for e in listed] == [entry["id"]]

    resolved = client.post(f"/v1/admin/factcheck/{entry['id']}/resolve",
                           headers=auth(), json={"status": "confirmed"}).json()
    assert resolved["status"] == "confirmed"
    assert client.post(f"/v1/admin/factcheck/{entry['id']}/resolve",
                       headers=auth(), json={"status": "burn"}).status_code == 422
    assert client.post("/v1/admin/factcheck/fc_unknown/resolve",
                       headers=auth(), json={"status": "confirmed"}).status_code == 404


def test_usage_dashboard_aggregates_the_log(
    tools_env, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.routers.admin as admin_mod
    from app.llm import openrouter

    client, pack, _data = tools_env
    npc = _load_npc(pack)

    async def fake_complete(settings, *, messages, mode=None, max_tokens=None, temperature=None):
        return openrouter.PlaygroundResult(
            say="好", mood="neutral", actions=[], raw="x", truncated=False,
            prompt_tokens=1000, completion_tokens=100, cached_tokens=0, cost_usd=0.0002,
        )

    monkeypatch.setattr(admin_mod.openrouter, "complete_chat", fake_complete)
    client.post("/v1/admin/playground", headers=auth(), json={
        "npc": npc, "state": {}, "lang": "en", "input": "hi",
    })

    summary = client.get("/v1/admin/usage", headers=auth()).json()
    assert summary["turns"] == 1
    assert summary["tokens"] == 1100
    assert summary["chat_cost_usd"] == pytest.approx(0.0002)  # the playground's logged cost
    assert summary["p95_latency_ms"] >= 0

    # The price model (PLAN 7.5): fresh tokens only — cached reads are 50x cheaper.
    assert estimate_cost(1000, 900, 100) < estimate_cost(1000, 0, 100)