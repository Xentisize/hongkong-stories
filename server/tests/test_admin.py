"""Admin API flow (PLAN 9.2, 9.3) — auth, drafts, validate, publish.

Everything runs on an isolated copy of the content pack (tmp_path): a publish here must
never touch the real client/content tree.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

TOKEN = "test-admin-token"


@pytest.fixture()
def admin_env(tmp_path: Path, content_dir: Path) -> tuple[Path, Path]:
    pack = tmp_path / "content"
    shutil.copytree(content_dir, pack)
    data = tmp_path / "data"
    data.mkdir()
    return pack, data


def admin_client(pack: Path, data: Path, token: str = TOKEN) -> TestClient:
    return TestClient(create_app(Settings(
        openrouter_api_key="x", admin_token=token, content_dir=pack, admin_data_dir=data,
    )))


def auth(token: str = TOKEN) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_admin_disabled_is_503_never_open(admin_env) -> None:
    pack, data = admin_env
    assert admin_client(pack, data, token="").get("/v1/admin/meta").status_code == 503


def test_wrong_token_is_401(admin_env) -> None:
    pack, data = admin_env
    assert admin_client(pack, data).get("/v1/admin/meta", headers=auth("nope")).status_code == 401


def test_meta_with_token(admin_env) -> None:
    pack, data = admin_env
    body = admin_client(pack, data).get("/v1/admin/meta", headers=auth()).json()
    assert body["content_version"] >= 1


def test_draft_roundtrip_and_publish(admin_env) -> None:
    pack, data = admin_env
    c = admin_client(pack, data)
    base = json.loads((pack / "npcs" / "npc_ch01_wai.json").read_text())
    base["id"] = "npc_draft_test"

    assert c.put("/v1/admin/drafts/npcs/npc_draft_test", json=base, headers=auth()).status_code == 200
    assert c.put("/v1/admin/drafts/npcs/npc_draft_test",
                 json={**base, "id": "mismatch"}, headers=auth()).status_code == 422
    assert c.get("/v1/admin/drafts/npcs/npc_draft_test", headers=auth()).json()["id"] == "npc_draft_test"
    assert len(c.get("/v1/admin/drafts", headers=auth()).json()) == 1
    assert c.post("/v1/admin/validate", headers=auth()).json()["ok"] is True

    before = c.get("/v1/content/manifest.json").json()["version"]
    result = c.post("/v1/admin/publish", headers=auth()).json()
    assert result["version"] == before + 1
    assert (pack / "npcs" / "npc_draft_test.json").is_file()
    assert c.get("/v1/admin/drafts", headers=auth()).json() == []  # drafts cleared once shipped

    served = c.get("/v1/content/manifest.json").json()
    assert any("npc_draft_test" in f for f in served["files"])


def test_publish_refuses_an_invalid_draft_and_keeps_it(admin_env) -> None:
    pack, data = admin_env
    c = admin_client(pack, data)
    broken = json.loads((pack / "npcs" / "npc_ch01_wai.json").read_text())
    broken["id"] = "npc_bad_ref"
    broken["llm"]["items_may_give"] = ["item_nope"]

    assert c.put("/v1/admin/drafts/npcs/npc_bad_ref", json=broken, headers=auth()).status_code == 200
    assert c.post("/v1/admin/validate", headers=auth()).json()["ok"] is False

    response = c.post("/v1/admin/publish", headers=auth())
    assert response.status_code == 422
    assert any("item_nope" in json.dumps(response.json()["detail"]["issues"]) for _ in [0])

    assert not (pack / "npcs" / "npc_bad_ref.json").exists()  # nothing shipped
    assert len(c.get("/v1/admin/drafts", headers=auth()).json()) == 1  # draft kept for fixing


def test_publish_without_drafts_is_400(admin_env) -> None:
    pack, data = admin_env
    assert admin_client(pack, data).post("/v1/admin/publish", headers=auth()).status_code == 400