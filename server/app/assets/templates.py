"""Prompt templates (PLAN 8.3) and the pixel target for each art kind.

Negative-style instructions live in the prompt text itself (the images endpoint takes no
negative_prompt param); the post-processor enforces the rest mechanically. Stored as data so
the admin UI can show them verbatim and a later increment can make them editable.
"""

from __future__ import annotations

# kind -> (aspect_ratio, (target_w, target_h))
# 24x32 and 96x128 are both 3:4, so the render is downscaled without distortion; the plan's
# 1:1 row is kept for square props.
TARGETS: dict[str, tuple[str, tuple[int, int]]] = {
    "sprite": ("3:4", (24, 32)),
    "portrait": ("3:4", (96, 128)),
    "prop": ("1:1", (24, 24)),
}

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
}


def build_prompt(kind: str, desc: str) -> str:
    return TEMPLATES[kind].format(desc=desc.strip())


def pack_path(kind: str, subject_id: str) -> str:
    """Pack-relative path the generated PNG is served at (client hot-pack reads it)."""
    if kind == "sprite":
        return f"art/npcs/{subject_id}.png"
    if kind == "portrait":
        return f"art/npcs/{subject_id}_portrait.png"
    return f"art/props/{subject_id}.png"