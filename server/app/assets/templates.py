"""Prompt templates (PLAN 8.3) and the pixel target for each art kind.

Negative-style instructions live in the prompt text itself (the images endpoint takes no
negative_prompt param); the post-processor enforces the rest mechanically. Stored as data so
the admin UI can show them verbatim and a later increment can make them editable.
"""

from __future__ import annotations

# kind -> (aspect_ratio, (target_w, target_h), background)
# 24x32 and 96x128 are both 3:4, so the render is downscaled without distortion; the plan's
# 1:1 row is kept for square props. Backgrounds follow a live-verified constraint (2026-11-17):
# seedream-5-0-flash makes transparent images ONLY from a reference image — full-bleed scenes
# are opaque anyway (alpha trim is a no-op on them), and reference-less transparent subjects
# route to the newer model in config instead.
TARGETS: dict[str, tuple[str, tuple[int, int], str]] = {
    "sprite": ("3:4", (24, 32), "transparent"),
    "portrait": ("3:4", (96, 128), "transparent"),
    "prop": ("1:1", (24, 24), "transparent"),
    "backdrop": ("16:9", (256, 144), "opaque"),
    "stylebible": ("16:9", (256, 144), "opaque"),
    "tile": ("1:1", (24, 24), "opaque"),
    "icon": ("1:1", (24, 24), "transparent"),
}

# Only cut-out subjects get the 1px outline; a full-bleed scene or a map tile has no
# silhouette (an outlined floor tile would grow a border and stop tiling).
OUTLINED = {"sprite", "portrait", "prop", "icon"}

TEMPLATES: dict[str, str] = {
    "sprite": (
        "pixel art sprite of {desc}, hk_palette_v1 palette, 24px tile scale, "
        "side/front view, T-pose-adjacent stance, flat cel shading, no outline glow, "
        "no text, plain transparent background, posterized 4 shades per hue"
    ),
    "portrait": (
        "pixel art bust portrait of {desc}, facing viewer, transparent background, "
        "hk_palette_v1 palette, 96x128 framing, flat cel shading, no text"
    ),
    "prop": (
        "pixel art {desc}, isometric-free flat top-down-RPG style, hk_palette_v1 palette, "
        "24px scale, single object, transparent background, no shadow baked in, no text"
    ),
    "backdrop": (
        "pixel art top-down street scene of {desc}, 16:9, muted hk_palette_v1 palette, "
        "walkable ground plane, no characters, no text, no UI"
    ),
    "tile": (
        "pixel art {desc}, hk_palette_v1 palette, fills the entire square edge to edge, "
        "tileable texture, flat shading, no border, no outline, no text, no drop shadow"
    ),
    "icon": (
        "cute pixel-art game icon of {desc}, hk_palette_v1 palette, centered on a clear "
        "transparent background, chunky readable shapes at 24px, no text, no drop shadow"
    ),
    "stylebible": (
        # §8.2: the style bible is a street scene WITH three cast characters at final
        # palette — it is what every later generation references for style consistency.
        "pixel art style bible: a 2027 Sham Shui Po street scene, top-down view, three "
        "characters in the street (a cha chaan teng owner in an apron, a retiree with a "
        "bird cage, a delivery rider with a helmet), {desc}, hk_palette_v1 palette, "
        "24px tile scale, flat cel shading, no text, plain transparent background"
    ),
}


def build_prompt(kind: str, desc: str) -> str:
    return TEMPLATES[kind].format(desc=desc.strip())


def pack_path(kind: str, subject_id: str) -> str:
    """Pack-relative path the generated PNG is served at (client hot-pack reads it)."""
    if subject_id == "stylebible":
        # The style bible's path is part of the §8.2 contract — input_references[0] on every
        # later generation points at art/stylebible.png.
        return "art/stylebible.png"
    if kind == "tile":
        return f"art/tiles/{subject_id}.png"
    if kind == "icon":
        return f"art/items/{subject_id}.png"
    if kind == "sprite":
        return f"art/npcs/{subject_id}.png"
    if kind == "portrait":
        return f"art/npcs/{subject_id}_portrait.png"
    if kind == "backdrop":
        return f"art/backdrops/{subject_id}.png"
    return f"art/props/{subject_id}.png"