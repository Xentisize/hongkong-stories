"""WSS /v1/chat — one streaming conversation turn with an LLM-driven NPC (PLAN 7.1).

Frame contract (server → client):
  {"type":"token","t":"..."}                     append to the typewriter
  {"type":"done", ...}                           final text, validated actions, usage
  {"type":"error","code":"..."}                  client must fall back to scripted lines

Every failure path ends in an `error` frame rather than a dropped socket, because the client's
fallback ladder keys on it: a silent close would leave the player staring at a "thinking"
indicator (§7.4).
"""

from __future__ import annotations

import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from ..llm import actions as action_rules
from ..llm import openrouter, prompts

router = APIRouter()


async def _error(websocket: WebSocket, code: str, detail: str = "") -> None:
    payload = {"type": "error", "code": code}
    if detail:
        payload["detail"] = detail[:200]
    try:
        await websocket.send_json(payload)
        await websocket.close()
    except RuntimeError:
        pass  # already closed by the peer


@router.websocket("/v1/chat")
async def chat(websocket: WebSocket) -> None:
    await websocket.accept()

    settings = websocket.app.state.settings
    sessions = websocket.app.state.sessions
    content = websocket.app.state.content

    try:
        start = json.loads(await websocket.receive_text())
    except (WebSocketDisconnect, json.JSONDecodeError):
        return

    if not isinstance(start, dict) or start.get("type") != "start":
        await _error(websocket, "bad_request", "expected a start frame")
        return

    session = sessions.get(str(start.get("session_token", "")))
    if session is None:
        await _error(websocket, "unknown_session")
        return
    if session.exhausted:
        await _error(websocket, "budget_exceeded")
        return
    if not settings.has_key:
        await _error(websocket, "no_api_key")
        return

    npc = content.npc(str(start.get("npc_id", "")))
    if not npc:
        await _error(websocket, "unknown_npc")
        return

    lang = str(start.get("lang") or "zh_HK")
    state = start.get("state") if isinstance(start.get("state"), dict) else {}
    history = start.get("history") if isinstance(start.get("history"), list) else []
    player_input = str(start.get("input") or "").strip()
    prefetch = bool(start.get("prefetch"))

    messages = prompts.build_messages(npc, state, lang, history, player_input)
    prompt_tokens = openrouter.estimate_tokens("".join(str(m.get("content", "")) for m in messages))

    # Refuse before spending money, not after.
    if prompt_tokens > session.remaining:
        await _error(websocket, "budget_exceeded")
        return

    result: openrouter.ChatResult | None = None
    try:
        async for kind, payload in openrouter.stream_chat(settings=settings, messages=messages):
            if kind == "token":
                await websocket.send_json({"type": "token", "t": payload})
            elif kind == "final":
                result = payload
    except openrouter.UpstreamError as exc:
        await _error(websocket, exc.code, exc.detail)
        return
    except WebSocketDisconnect:
        return
    except Exception:  # noqa: BLE001 - a transport surprise must degrade, never 500 the socket
        await _error(websocket, "upstream_error")
        return

    if result is None:
        await _error(websocket, "empty_response")
        return

    accepted, rejected = action_rules.validate_actions(result.actions, npc, state)
    used = prompt_tokens + openrouter.estimate_tokens(result.say)
    session.charge(used)

    try:
        await websocket.send_json(
            {
                "type": "done",
                "say": result.say,
                "mood": result.mood,
                "actions": accepted,
                "rejected": rejected,
                "prefetch": prefetch,
                "truncated": result.truncated,
                "usage": {"tokens": used, "remaining": session.remaining, "turn": session.turns},
            }
        )
        await websocket.close()
    except RuntimeError:
        return
