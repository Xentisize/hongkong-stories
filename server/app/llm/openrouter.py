"""OpenRouter streaming client (PLAN 7.1, 7.3).

Two output modes, both implemented so the §7.3 spike is a config flip rather than a rewrite:

  json  — `response_format: json_schema` with incremental extraction of the `say` field, so the
          typewriter starts before the JSON object closes. Verified live against
          deepseek-v4.1-flash-1017 (11 delta frames, clean parse).
  prose — plain text stream with a trailing ```actions block that is parsed and stripped.
          The documented fallback if structured streaming ever regresses.

Token counts are estimated, not reported: asking for streaming usage adds a request parameter
that providers may reject, and a budget guard needs to be conservative rather than exact.
CJK counts as ~1 token/char, Latin as ~1/4 — the same asymmetry §7.7 notes for max_tokens.
"""

from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

import httpx

from ..config import Settings
from .schema import NPC_REPLY_RESPONSE_FORMAT

ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
ACTION_BLOCK_RE = re.compile(r"```(?:actions)?\s*(\[.*?\])\s*```", re.DOTALL)


class UpstreamError(RuntimeError):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


@dataclass
class ChatResult:
    say: str = ""
    mood: str = "neutral"
    actions: list[dict] = field(default_factory=list)
    raw: str = ""
    truncated: bool = False


def estimate_tokens(text: str) -> int:
    cjk = sum(1 for ch in text if "\u3400" <= ch <= "\u9fff" or "\uf900" <= ch <= "\ufaff")
    return cjk + ((len(text) - cjk) // 4) + 1


class SayExtractor:
    """Emits the growing value of `say` from a partially received JSON object.

    Holds back an incomplete escape at the buffer edge rather than guessing: a half-received
    ``\\u`` sequence rendered early would print a replacement character into the dialogue box.
    """

    _ESCAPES = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/"}

    def __init__(self) -> None:
        self._buffer = ""
        self._scan: int | None = None
        self._finished = False

    def feed(self, chunk: str) -> str:
        if self._finished or not chunk:
            return ""
        self._buffer += chunk
        if self._scan is None and not self._locate():
            return ""
        return self._decode()

    def _locate(self) -> bool:
        key = self._buffer.find('"say"')
        if key < 0:
            return False
        colon = self._buffer.find(":", key + 5)
        if colon < 0:
            return False
        quote = self._buffer.find('"', colon + 1)
        if quote < 0:
            return False
        self._scan = quote + 1
        return True

    def _decode(self) -> str:
        assert self._scan is not None
        out: list[str] = []
        index = self._scan
        buffer = self._buffer
        while index < len(buffer):
            char = buffer[index]
            if char == '"':
                self._finished = True
                index += 1
                break
            if char == "\\":
                if index + 1 >= len(buffer):
                    break  # incomplete escape: wait for the next chunk
                marker = buffer[index + 1]
                if marker == "u":
                    if index + 6 > len(buffer):
                        break  # incomplete \uXXXX
                    try:
                        out.append(chr(int(buffer[index + 2 : index + 6], 16)))
                    except ValueError:
                        pass
                    index += 6
                    continue
                out.append(self._ESCAPES.get(marker, marker))
                index += 2
                continue
            out.append(char)
            index += 1
        self._scan = index
        return "".join(out)


class ProseExtractor:
    """Emits prose while holding back anything from the first action fence onwards."""

    def __init__(self) -> None:
        self._buffer = ""
        self._emitted = 0
        self._fenced = False

    def feed(self, chunk: str) -> str:
        if self._fenced or not chunk:
            return ""
        self._buffer += chunk
        fence = self._buffer.find("```")
        if fence >= 0:
            self._fenced = True
            limit = fence
        else:
            limit = len(self._buffer)
            # Hold back a partial fence at the buffer edge: emitting "``" and only then
            # discovering the fence would leak markup into the dialogue box.
            held = 0
            while (
                held < 2
                and limit - held - 1 >= self._emitted
                and self._buffer[limit - held - 1] == "`"
            ):
                held += 1
            limit -= held
        delta = self._buffer[self._emitted : limit]
        self._emitted = max(self._emitted, limit)
        return delta


async def stream_chat(
    *,
    settings: Settings,
    messages: list[dict],
    mode: str | None = None,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> AsyncIterator[tuple[str, object]]:
    """Yield ("token", str) as text arrives, then ("final", ChatResult)."""
    output_mode = (mode or settings.chat_output_mode).lower()
    payload: dict = {
        "model": settings.chat_model,
        "messages": messages,
        "stream": True,
        "max_tokens": max_tokens or settings.max_tokens,
        "temperature": settings.temperature if temperature is None else temperature,
    }
    if output_mode == "json":
        payload["response_format"] = NPC_REPLY_RESPONSE_FORMAT

    extractor = SayExtractor() if output_mode == "json" else ProseExtractor()
    raw_parts: list[str] = []
    result = ChatResult()

    headers = {
        "Authorization": f"Bearer {settings.openrouter_api_key}",
        "Content-Type": "application/json",
        # OpenRouter attribution headers; harmless and useful in their dashboard.
        "HTTP-Referer": "https://github.com/hongkong-stories",
        "X-Title": "Hong Kong Stories",
    }

    timeout = httpx.Timeout(settings.upstream_timeout_sec, connect=10.0)
    async with httpx.AsyncClient(timeout=timeout) as client:
        async with client.stream("POST", ENDPOINT, headers=headers, json=payload) as response:
            if response.status_code != httpx.codes.OK:
                body = (await response.aread()).decode("utf-8", "replace")
                raise UpstreamError(f"upstream_http_{response.status_code}", body[:300])

            async for line in response.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                if isinstance(chunk.get("error"), dict):
                    raise UpstreamError("upstream_error", str(chunk["error"])[:300])

                for choice in chunk.get("choices", []):
                    delta = choice.get("delta") or {}
                    piece = delta.get("content")
                    if not isinstance(piece, str) or not piece:
                        continue
                    raw_parts.append(piece)
                    text = extractor.feed(piece)
                    if text:
                        yield ("token", text)
                    if choice.get("finish_reason") == "length":
                        result.truncated = True

    result.raw = "".join(raw_parts)
    if output_mode == "json":
        try:
            parsed = json.loads(result.raw)
        except json.JSONDecodeError:
            raise UpstreamError("malformed_json", result.raw[:300]) from None
        result.say = str(parsed.get("say", "")).strip()
        result.mood = str(parsed.get("mood", "neutral")) or "neutral"
        raw_actions = parsed.get("actions", [])
        result.actions = [a for a in raw_actions if isinstance(a, dict)] if isinstance(raw_actions, list) else []
    else:
        match = ACTION_BLOCK_RE.search(result.raw)
        prose = result.raw
        if match:
            prose = prose[: match.start()]
            try:
                parsed_actions = json.loads(match.group(1))
                if isinstance(parsed_actions, list):
                    result.actions = [a for a in parsed_actions if isinstance(a, dict)]
            except json.JSONDecodeError:
                result.actions = []
        result.say = prose.strip()
        result.mood = "neutral"

    if not result.say:
        raise UpstreamError("empty_response", result.raw[:300])

    yield ("final", result)
