class_name LocationExit
extends Area2D
## A walk-into exit region (docs/PLAN.md §5.3 `exits`). When the player's body enters and the
## optional condition passes, navigation is requested through Bus.goto_requested; Main owns
## the actual swap and defers it. A failed condition is not an error — the exit simply stays
## shut, showing the definition's optional `blocked` line once per entry.

var _to: String = ""
var _spawn: String = "default"
var _requires: Variant = null
var _blocked: Dictionary = {}


func configure(definition: Dictionary, tile_size: int) -> void:
	_to = String(definition.get("to", ""))
	_spawn = String(definition.get("spawn", "default"))
	_requires = definition.get("requires")
	var blocked_raw: Variant = definition.get("blocked")
	_blocked = blocked_raw if typeof(blocked_raw) == TYPE_DICTIONARY else {}

	var rect: Array = definition.get("rect", [0, 0, 1, 1])
	var size_tiles := Vector2(float(rect[2]), float(rect[3]))
	# Rects are in tile units like `collision`; the area sits on the rect's centre.
	position = (Vector2(float(rect[0]), float(rect[1])) + size_tiles * 0.5) * tile_size

	var shape := CollisionShape2D.new()
	var rectangle := RectangleShape2D.new()
	rectangle.size = size_tiles * tile_size
	shape.shape = rectangle
	add_child(shape)
	body_entered.connect(_on_body_entered)


func _on_body_entered(body: Node2D) -> void:
	if not body.is_in_group("player") or _to.is_empty():
		return
	if _requires != null and not Conditions.evaluate(_requires):
		var text := ContentDB.localize(_blocked, Settings.locale)
		if not text.is_empty():
			Bus.message_shown.emit(text)
		return
	Bus.goto_requested.emit(_to, _spawn)
