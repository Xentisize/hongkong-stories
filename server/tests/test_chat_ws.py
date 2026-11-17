"""WS /v1/chat protocol (PLAN 7.1, 7.4).

Every failure path must produce an `error` frame, because the client's fallback ladder keys on
it — a silent close would leave the player staring at a thinking indicator forever.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient

from app.config import Settings
from app.llm import openrouter
from app.main import create_app
from app.llm.openrouter import ChatResult, UpstreamError


def _frame(app, **overrides) -> dict:
    session = app.state.sessions.create()
    frame = {
        "type": "start",
        "session_token": session.token,
        "npc_id": "npc_p2_shopkeeper",
        "lang": "zh_HK",
        "state": {},
        "history": [],
        "input": "你好",
    }
    frame.update(overrides)
    return frame


def _drain(websocket) -> tuple[list[str], dict]:
    tokens: list[str] = []
    while True:
        message = json.loads(websocket.receive_text())
        if message["type"] == "token":
            tokens.append(message["t"])
            continue
        return tokens, message


def test_happy_path_streams_tokens_then_done(app, client: TestClient, monkeypatch) -> None:
    async def fake_stream(**_kwargs):
        yield ("token", "你好")
        yield ("token", "，有咩事？")
        yield (
            "final",
            ChatResult(
                say="你好，有咩事？",
                mood="warm",
                actions=[{"type": "give", "item": "item_rusty_key"}],
            ),
        )

    monkeypatch.setattr(openrouter, "stream_chat", fake_stream)

    with client.websocket_connect("/v1/chat") as websocket:
        websocket.send_text(json.dumps(_frame(app)))
        tokens, done = _drain(websocket)

    assert tokens == ["你好", "，有咩事？"]
    assert done["type"] == "done"
    assert done["say"] == "你好，有咩事？"
    assert done["mood"] == "warm"
    assert [a["item"] for a in done["actions"]] == ["item_rusty_key"]
    assert done["usage"]["tokens"] > 0
    # The session was charged exactly once, against its declared budget.
    assert done["usage"]["remaining"] == app.state.settings.session_token_budget - done["usage"]["tokens"]


def test_done_actions_are_filtered_by_the_allowlist(app, client: TestClient, monkeypatch) -> None:
    async def fake_stream(**_kwargs):
        yield (
            "final",
            ChatResult(
                say="攞住啦。",
                actions=[
                    {"type": "give", "item": "item_rusty_key"},
                    {"type": "give", "item": "item_forbidden"},
                ],
            ),
        )

    monkeypatch.setattr(openrouter, "stream_chat", fake_stream)

    with client.websocket_connect("/v1/chat") as websocket:
        websocket.send_text(json.dumps(_frame(app)))
        _, done = _drain(websocket)

    assert [a["item"] for a in done["actions"]] == ["item_rusty_key"]
    assert done["rejected"][0]["action"]["item"] == "item_forbidden"
    assert done["rejected"][0]["reason"] == "item_not_allowed"


def test_upstream_failure_becomes_an_error_frame(app, client: TestClient, monkeypatch) -> None:
    async def fake_stream(**_kwargs):
        raise UpstreamError("upstream_timeout", "no first byte")
        yield  # pragma: no cover - makes this an async generator

    monkeypatch.setattr(openrouter, "stream_chat", fake_stream)

    with client.websocket_connect("/v1/chat") as websocket:
        websocket.send_text(json.dumps(_frame(app)))
        _, message = _drain(websocket)

    assert message["type"] == "error"
    assert message["code"] == "upstream_timeout"


def test_unexpected_exception_degrades_instead_of_dropping(app, client: TestClient, monkeypatch) -> None:
    async def fake_stream(**_kwargs):
        raise RuntimeError("boom")
        yield  # pragma: no cover

    monkeypatch.setattr(openrouter, "stream_chat", fake_stream)

    with client.websocket_connect("/v1/chat") as websocket:
        websocket.send_text(json.dumps(_frame(app)))
        _, message = _drain(websocket)

    assert message["type"] == "error"
    assert message["code"] == "upstream_error"


def test_unknown_session_is_refused(app, client: TestClient) -> None:
    with client.websocket_connect("/v1/chat") as websocket:
        websocket.send_text(json.dumps(_frame(app, session_token="nope")))
        _, message = _drain(websocket)
    assert message["code"] == "unknown_session"


def test_unknown_npc_is_refused(app, client: TestClient) -> None:
    with client.websocket_connect("/v1/chat") as websocket:
        websocket.send_text(json.dumps(_frame(app, npc_id="npc_missing")))
        _, message = _drain(websocket)
    assert message["code"] == "unknown_npc"


def test_bad_start_frame_is_refused(app, client: TestClient) -> None:
    with client.websocket_connect("/v1/chat") as websocket:
        websocket.send_text(json.dumps({"type": "hello"}))
        _, message = _drain(websocket)
    assert message["code"] == "bad_request"


def test_budget_exhaustion_is_refused_before_spending(content_dir) -> None:
    app = create_app(Settings(openrouter_api_key="k", session_token_budget=1, content_dir=content_dir))
    with TestClient(app) as client:
        with client.websocket_connect("/v1/chat") as websocket:
            websocket.send_text(json.dumps(_frame(app)))
            _, message = _drain(websocket)
    assert message["type"] == "error"
    assert message["code"] == "budget_exceeded"


def test_missing_key_is_refused_without_calling_out(content_dir, monkeypatch) -> None:
    app = create_app(Settings(openrouter_api_key="", content_dir=content_dir))

    called = {"count": 0}

    async def fake_stream(**_kwargs):
        called["count"] += 1
        yield ("final", ChatResult(say="should not happen"))

    monkeypatch.setattr(openrouter, "stream_chat", fake_stream)

    with TestClient(app) as client:
        with client.websocket_connect("/v1/chat") as websocket:
            websocket.send_text(json.dumps(_frame(app)))
            _, message = _drain(websocket)

    assert message["code"] == "no_api_key"
    assert called["count"] == 0


def test_session_endpoint_and_health(client: TestClient) -> None:
    response = client.post("/v1/session")
    assert response.status_code == 200
    body = response.json()
    assert body["session_token"] and body["budget"] > 0
    assert body["model"] and body["output_mode"] in {"json", "prose"}

    health = client.get("/healthz").json()
    assert health["status"] == "ok"
    assert health["content"]["npcs"] >= 1
    # The key itself must never appear in any response payload.
    assert "sk-or-" not in json.dumps(health)
    assert isinstance(health["key_present"], bool)
