"""Fixed project palette (PLAN 8.2) — what visually binds images made minutes apart.

Every generated asset is snapped to `HK_PALETTE_V1` after downscaling, so a 2027 delivery
rider and a 1955 hawker read as one world. The palette is muted-urban Hong Kong: concrete,
tong-lau brick, awning green, signage red, warm paper. Treat it as a content asset with an
id; record it in every provenance file and do not edit entries in place (add v2 instead).
"""

from __future__ import annotations

PALETTE_NAME = "hk_palette_v1"

# (r, g, b) tuples, ordered dark to light within each hue family.
HK_PALETTE_V1: list[tuple[int, int, int]] = [
    (26, 28, 34),      # near-black
    (42, 31, 26),      # hair black (warm)
    (46, 49, 56),      # dark grey
    (74, 79, 88),      # mid grey
    (92, 96, 88),      # shadow concrete
    (110, 74, 50),     # dark wood
    (110, 47, 38),     # dark brick
    (43, 58, 103),     # navy
    (42, 74, 56),      # awning green (dark)
    (58, 124, 124),    # teal
    (138, 90, 46),     # rust
    (160, 74, 58),     # brick red
    (70, 89, 138),     # denim
    (70, 107, 79),     # awning green
    (139, 142, 133),   # concrete
    (110, 82, 50),     # mid wood
    (201, 163, 124),   # skin shadow
    (194, 59, 46),     # signage red
    (176, 82, 104),    # signage magenta
    (217, 164, 65),    # signage yellow
    (127, 168, 201),   # sky blue
    (232, 192, 106),   # amber
    (232, 201, 160),   # skin
    (168, 120, 62),    # light wood
    (184, 208, 222),   # pale sky
    (154, 160, 168),   # light grey
    (229, 213, 176),   # warm paper
    (216, 213, 200),   # off-white
    (238, 233, 220),   # white
]

# The 1px outline colour forced around subjects (PLAN 8 step 4).
OUTLINE_COLOR = (26, 28, 34, 255)