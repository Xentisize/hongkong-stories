class_name LocationNpc
extends Node2D
## An NPC placed in a location (docs/PLAN.md §5.3 `npcs`).
##
## Shares the duck-typed interaction interface with Interactable and Door — get_prompt /
## is_available / interact — so the player's targeting code does not care what it is looking
## at. The conversation itself belongs to the Dialogue autoload; this node only starts it.

var npc_id: String = ""
var display_name: String = ""

var _tile_size: int = 24


func configure(placement: Dictionary, tile_size: int) -> void:
	npc_id = String(placement.get("npc", ""))
	_tile_size = tile_size

	var tile: Array = placement.get("tile", [0, 0])
	position = Vector2(float(tile[0]) + 0.5, float(tile[1]) + 0.5) * _tile_size
	add_to_group("interactable")

	var definition := ContentDB.get_entity("npcs", npc_id)
	display_name = ContentDB.localize(definition.get("display_name", npc_id), Settings.locale)
	name = "Npc_%s" % npc_id
	queue_redraw()


func get_prompt() -> String:
	return "%s %s" % [_talk_verb(), display_name]


func is_available() -> bool:
	# While a conversation is open the player should be typing, not re-targeting.
	return not Dialogue.is_active()


func interact() -> void:
	if npc_id.is_empty():
		return
	# The player's turn count is incremented by Dialogue.open, not here, so the value the
	# model sees always matches what the save file records.
	Dialogue.open(npc_id)


func _talk_verb() -> String:
	match Settings.locale:
		"zh_HK":
			return "傾偈"
		"zh_CN":
			return "交谈"
		_:
			return "Talk to"


func _draw() -> void:
	# Placeholder figure in the same proportions as the player, in apron grey so the two read
	# apart at 1x. Real sprite sheets arrive with the Seedream pipeline (PLAN §8).
	draw_rect(Rect2(-7, -3, 14, 3), Color(0, 0, 0, 0.25))   # shadow
	draw_rect(Rect2(-6, -18, 12, 15), Color("#5b6472"))      # apron
	draw_rect(Rect2(-6, -18, 12, 2), Color("#7b8492"))       # collar
	draw_rect(Rect2(-5, -26, 10, 8), Color("#e8c9a0"))       # head
	draw_rect(Rect2(-5, -26, 10, 2), Color("#584437"))       # hair
	draw_rect(Rect2(-2, -22, 2, 2), Color("#2a1f1a"))        # eyes (facing down)
	draw_rect(Rect2(1, -22, 2, 2), Color("#2a1f1a"))
