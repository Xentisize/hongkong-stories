"""Public hot-pack endpoints (PLAN 5.7) — the interface the client boots against."""

from __future__ import annotations

from fastapi.testclient import TestClient


def test_manifest_serves_the_real_file(client: TestClient) -> None:
    data = client.get("/v1/content/manifest.json").json()
    assert data["manifest_schema"] == 1
    assert data["version"] >= 1
    assert isinstance(data["files"], list) and data["files"]


def test_manifest_is_no_cache(client: TestClient) -> None:
    headers = client.get("/v1/content/manifest.json").headers
    assert "no-cache" in (headers.get("cache-control") or "")


def test_file_endpoint_serves_an_entity(client: TestClient) -> None:
    response = client.get("/v1/content/file/npcs/npc_ch01_wai.json")
    assert response.status_code == 200
    assert response.json()["id"] == "npc_ch01_wai"


def test_traversal_is_404(client: TestClient) -> None:
    assert client.get("/v1/content/file/../../.gitignore").status_code == 404
    assert client.get("/v1/content/file/nope.json").status_code == 404