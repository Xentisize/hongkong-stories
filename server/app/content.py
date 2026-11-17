"""Content access for the backend (PLAN 5, 5.7).

Reads the same `client/content/` tree the game ships, through the same manifest the client
uses — one source of truth for NPC personas, allowlists and scripted fallbacks, so an author
cannot edit the game's copy and the model's copy into disagreement.

Deliberately plain `json.load`: the backend must not duplicate the Godot import pipeline, only
the data contract.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class ContentStore:
    content_dir: Path
    tables: dict[str, dict[str, dict]] = field(default_factory=dict)
    content_hash: str = ""
    version: int = 0
    # The raw manifest as read from disk — served verbatim by /v1/content/manifest.json
    # for the client's hot-pack check (PLAN 5.7).
    manifest: dict = field(default_factory=dict)

    @classmethod
    def load(cls, content_dir: Path) -> ContentStore:
        manifest_path = content_dir / "manifest.json"
        if not manifest_path.is_file():
            raise FileNotFoundError(
                f"content manifest missing at {manifest_path} — run tools/gen_content_manifest.py"
            )
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        store = cls(
            content_dir=content_dir,
            content_hash=str(manifest.get("content_hash", "")),
            version=int(manifest.get("version", 0)),
            manifest=manifest,
        )
        for entry in manifest.get("files", []):
            kind, _, _name = str(entry).partition("/")
            entity = json.loads((content_dir / entry).read_text(encoding="utf-8"))
            entity_id = str(entity.get("id", ""))
            if not entity_id:
                continue
            store.tables.setdefault(kind, {})[entity_id] = entity
        return store

    def npc(self, npc_id: str) -> dict:
        return self.tables.get("npcs", {}).get(npc_id, {})

    def item(self, item_id: str) -> dict:
        return self.tables.get("items", {}).get(item_id, {})

    def location(self, location_id: str) -> dict:
        return self.tables.get("locations", {}).get(location_id, {})

    def counts(self) -> dict[str, int]:
        return {kind: len(rows) for kind, rows in self.tables.items()}

    @staticmethod
    def localize(value: object, lang: str = "zh_HK") -> str:
        """Mirror of ContentDB.localize: requested locale, then zh_HK, zh_CN, en."""
        if isinstance(value, str):
            return value
        if not isinstance(value, dict):
            return ""
        for candidate in (lang, "zh_HK", "zh_CN", "en"):
            text = value.get(candidate)
            if isinstance(text, str) and text:
                return text
        for text in value.values():
            if isinstance(text, str) and text:
                return text
        return ""
