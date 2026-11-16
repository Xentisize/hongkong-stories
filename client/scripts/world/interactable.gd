class_name LocationInteractable
extends Node2D
## A world object the player can interact with (§5.3 `interactables`).
##
## Duck-typed interaction interface shared with Door: `get_prompt()`, `is_available()`,
## `interact()`. The player finds targets by the "interactable" group and distance, so there
## is no Area2D wiring to keep in sync and no physics cost per prop.

var data: Dictionary = {}
var _tile_size: int = 24
var _used: bool = false


func configure(definition: Dictionary, tile_size: int) -> void:
	data = definition
	_tile_size = tile_size
	name = "Interactable_%s" % String(data.get("id", "unnamed"))
	add_to_group("interactable")

	var tile: Array = data.get("tile", [0, 0])
	position = Vector2(float(tile[0]) + 0.5, float(tile[1]) + 0.5) * _tile_size
	queue_redraw()


func get_prompt() -> String:
	return ContentDB.localize(data.get("prompt", ""), Settings.locale)


func is_available() -> bool:
	return not _used


func interact() -> void:
	if not is_available():
		return
	Effects.apply(data.get("on_interact", []))
	if bool(data.get("once", false)):
		_used = true
		visible = false


func _draw() -> void:
	# Placeholder props, drawn above the tile centre. No art files needed for P1 (§8 comes
	# later), but they must be legible at 1x so the interaction radius reads correctly.
	match String(data.get("kind", "crate")):
		"sign":
			draw_rect(Rect2(-1, -14, 2, 14), Color("#6b4a28"))          # post
			draw_rect(Rect2(-7, -22, 14, 9), Color("#a87a46"))           # board
			draw_rect(Rect2(-7, -22, 14, 1), Color("#c49a63"))           # lit edge
			draw_rect(Rect2(-5, -19, 10, 1), Color("#6b4a28"))           # "text" line
			draw_rect(Rect2(-5, -17, 7, 1), Color("#6b4a28"))
		_:
			draw_rect(Rect2(-7, -12, 14, 12), Color("#8a6237"))          # crate body
			draw_rect(Rect2(-7, -12, 14, 1), Color("#a87a46"))            # lit top
			draw_rect(Rect2(-1, -12, 1, 12), Color("#6b4a28"))            # centre seam
			draw_rect(Rect2(-7, -6, 14, 1), Color("#6b4a28"))             # band
