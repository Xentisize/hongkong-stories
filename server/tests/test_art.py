"""Art pipeline (PLAN 8) — the post-processor and the generate endpoint.

Skipped automatically where Pillow is absent (optional `art` dependency group, PLAN 10.6);
the Seedream call itself is stubbed — nothing in the unit suite may reach the network.
"""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.assets import pixelate, seedream
from app.assets.palette import HK_PALETTE_V1, OUTLINE_COLOR

pytest.importorskip("PIL")


def _blob_png() -> bytes:
    """A synthetic render: a hard-edged off-palette blob on transparency."""
    blob = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    pixels = blob.load()
    for y in range(128, 384):
        for x in range(160, 352):
            pixels[x, y] = [(250, 10, 10, 255), (10, 250, 10, 255),
                            (120, 120, 250, 255)][(x // 32 + y // 32) % 3]
    buffer = io.BytesIO()
    blob.save(buffer, format="PNG")
    return buffer.getvalue()


def test_post_processor_is_palette_pure_and_outlined() -> None:
    out = pixelate.process(_blob_png(), (24, 32), outline=True)
    img = Image.open(io.BytesIO(out))
    w, h = img.size
    palette = {colour for colour in HK_PALETTE_V1}
    opaque = sum(1 for y in range(h) for x in range(w) if img.getpixel((x, y))[3] == 255)
    outlined = sum(1 for y in range(h) for x in range(w)
                   if img.getpixel((x, y)) == OUTLINE_COLOR)
    assert img.size == (26, 34)          # target + 1px ring on every side
    assert opaque == w * h               # subject + ring, nothing faint
    assert outlined == w * h - 24 * 32   # the ring is exactly the border
    for y in range(h):
        for x in range(w):
            pixel = img.getpixel((x, y))
            assert (pixel[0], pixel[1], pixel[2]) in palette


def _minimal_pack(tmp_path: Path) -> tuple[Path, Path]:
    """A loadable empty pack: the manifest loader refuses a directory without a manifest."""
    pack = tmp_path / "content"
    (pack / "npcs").mkdir(parents=True)
    (pack / "manifest.json").write_text(
        json.dumps({"manifest_schema": 1, "version": 1, "content_hash": "x", "files": []}),
        encoding="utf-8",
    )
    data = tmp_path / "data"
    data.mkdir()
    return pack, data


def test_generate_endpoint_writes_pack_and_provenance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.config import Settings
    from app.main import create_app
    import app.routers.admin as admin_mod

    pack, data = _minimal_pack(tmp_path)

    async def fake_generate(settings, *, prompt, aspect_ratio, seed=None):
        assert "test caretaker" in prompt
        return seedream.GeneratedImage(png=_blob_png(), seed=424242, cost_usd=0.018)

    monkeypatch.setattr(admin_mod.seedream, "generate_image", fake_generate)
    client = TestClient(create_app(Settings(
        openrouter_api_key="x", admin_token="t",
        content_dir=pack, admin_data_dir=data,
    )))

    response = client.post("/v1/admin/art/generate", headers={"Authorization": "Bearer t"}, json={
        "kind": "sprite", "subject_id": "npc_art_test", "desc": "a test caretaker",
    })
    assert response.status_code == 200
    body = response.json()
    assert body["path"] == "art/npcs/npc_art_test.png"
    assert (pack / "art" / "npcs" / "npc_art_test.png").is_file()

    provenance = json.loads((pack / "art" / "npcs" / "npc_art_test.gen.json").read_text())
    assert provenance["model"] == "bytedance-seed/seedream-5-0-flash"
    assert provenance["seed"] == 424242
    assert provenance["post"]["palette"] == "hk_palette_v1"
    assert provenance["accepted_by"] == "admin"
    assert base64.b64decode(body["png_base64"])[:8] == b"\x89PNG\r\n\x1a\n"


def test_generate_endpoint_needs_a_key(tmp_path: Path) -> None:
    from app.config import Settings
    from app.main import create_app

    pack, data = _minimal_pack(tmp_path)
    client = TestClient(create_app(Settings(
        admin_token="t", content_dir=pack, admin_data_dir=data,
    )))
    assert client.post("/v1/admin/art/generate", headers={"Authorization": "Bearer t"}, json={
        "kind": "sprite", "subject_id": "x", "desc": "d",
    }).status_code == 503