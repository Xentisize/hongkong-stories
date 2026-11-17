"""Streaming extractors (PLAN 7.3).

The `say` extractor is what lets the typewriter start before the JSON object closes. Its edge
cases are exactly where a naive implementation prints mojibake into the dialogue box: an escape
split across two SSE chunks, a ``\\u`` sequence incomplete at the buffer edge, and a quote
inside the sentence.
"""

from __future__ import annotations

from app.llm.openrouter import ProseExtractor, SayExtractor, estimate_tokens


def _feed_all(extractor, chunks: list[str]) -> str:
    return "".join(extractor.feed(chunk) for chunk in chunks)


def test_say_extractor_streams_across_chunks() -> None:
    chunks = ['{"say": "你有', "冇鎖匙", '？", "mood": "warm", "actions": []}']
    assert _feed_all(SayExtractor(), chunks) == "你有冇鎖匙？"


def test_say_extractor_holds_back_split_escape() -> None:
    extractor = SayExtractor()
    first = extractor.feed('{"say": "line one\\')
    assert first == "line one"  # the dangling backslash is not printed
    assert extractor.feed('nline two"}') == "\nline two"


def test_say_extractor_decodes_unicode_escapes() -> None:
    assert _feed_all(SayExtractor(), ['{"say": "\\u4f60\\u597d"}']) == "你好"


def test_say_extractor_holds_back_incomplete_unicode_escape() -> None:
    extractor = SayExtractor()
    assert extractor.feed('{"say": "a\\u4f') == "a"
    assert extractor.feed('60b"}') == "你b"


def test_say_extractor_handles_escaped_quote() -> None:
    assert _feed_all(SayExtractor(), ['{"say": "he said \\"hi\\" quietly"}']) == 'he said "hi" quietly'


def test_say_extractor_ignores_content_before_the_field() -> None:
    assert _feed_all(SayExtractor(), ['{"mood": "warm", "say": "later"}']) == "later"


def test_say_extractor_stops_at_closing_quote() -> None:
    extractor = SayExtractor()
    assert extractor.feed('{"say": "done", "actions": [{"type":"give"}]}') == "done"
    assert extractor.feed(" more garbage") == ""


def test_prose_extractor_strips_trailing_action_fence() -> None:
    text = 'Hello there.\n```actions\n[{"type":"give","item":"x"}]\n```'
    assert _feed_all(ProseExtractor(), [text]) == "Hello there.\n"


def test_prose_extractor_holds_back_once_fence_appears_across_chunks() -> None:
    extractor = ProseExtractor()
    assert extractor.feed("Hello ") == "Hello "
    assert extractor.feed("there.``") == "there."
    assert extractor.feed('`actions []\n```') == ""


def test_estimate_tokens_weights_cjk_heavier() -> None:
    # Chinese is ~1 token/char, English ~1 token/4 chars; the guard must not under-charge.
    assert estimate_tokens("你好世界") > estimate_tokens("hello world")
