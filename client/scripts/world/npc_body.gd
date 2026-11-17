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
var _requires: Variant = null
var _requires_pass: bool = true
var _sprite_tex: Texture2D = null
var _locale_connected: bool = false


func configure(placement: Dictionary, tile_size: int) -> void:
	npc_id = String(placement.get("npc", ""))
	_tile_size = tile_size

	var tile: Array = placement.get("tile", [0, 0])
	position = Vector2(float(tile[0]) + 0.5, float(tile[1]) + 0.5) * _tile_size
	add_to_group("interactable")

	var definition := ContentDB.get_entity("npcs", npc_id)
	display_name = ContentDB.localize(definition.get("display_name", npc_id), Settings.locale)
	name = "Npc_%s" % npc_id
	# Presence gating (§5.1 trigger block): the placement may carry `requires`, else the NPC
	# definition's own trigger does. Auto-started trigger conversations (once_per_session)
	# are not built yet — this only gates whether the character is here at all.
	_requires = placement.get("requires")
	if _requires == null:
		var trigger: Dictionary = definition.get("trigger", {})
		_requires = trigger.get("requires")
	refresh_availability()
	_sprite_tex = _load_sprite_texture(definition)
	# The display name is localized at configure time; follow locale switches live so the
	# interaction prompt never shows a stale language.
	if not _locale_connected:
		_locale_connected = true
		Bus.locale_changed.connect(_on_locale_changed)
	queue_redraw()


func _on_locale_changed(_locale: String) -> void:
	var definition := ContentDB.get_entity("npcs", npc_id)
	if not definition.is_empty():
		display_name = ContentDB.localize(definition.get("display_name", npc_id), Settings.locale)
	queue_redraw()


## Generated art first (hot-pack decoded bytes), then bundled resources — the placeholder
## rectangles remain the fallback when an NPC has no sprite yet.
func _load_sprite_texture(definition: Dictionary) -> Texture2D:
	var sprite: Variant = definition.get("sprite")
	if typeof(sprite) != TYPE_DICTIONARY:
		return null
	var sheet := String((sprite as Dictionary).get("sheet", ""))
	return ContentDB.art_texture(sheet)


func get_prompt() -> String:
	return "%s %s" % [_talk_verb(), display_name]


func is_available() -> bool:
	# While a conversation is open the player should be typing, not re-targeting; a gated
	# NPC is simply not there until its condition passes.
	return not Dialogue.is_active() and _requires_pass


## Re-evaluated on state changes; LocationRoot fans the bus signals out to every placed NPC.
func refresh_availability() -> void:
	_requires_pass = _requires == null or Conditions.evaluate(_requires)
	visible = _requires_pass


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
	# Generated sprite (24x32 subject + 1px outline = 26x34): feet on the node origin so the
	# Y-sort depth line matches the placeholder. Placeholder rects stay as the fallback.
	if _sprite_tex != null:
		var size := _sprite_tex.get_size()
		draw_rect(Rect2(-7, -1, 14, 2), Color(0, 0, 0, 0.25))   # ground shadow
		draw_texture_rect(_sprite_tex, Rect2(-size.x / 2.0, -size.y + 1.0, size.x, size.y), false)
		return
	# Placeholder figure in the same proportions as the player, in apron grey so the two read
	# apart at 1x. Real sprite sheets arrive with the Seedream pipeline (PLAN §8).
	draw_rect(Rect2(-7, -3, 14, 3), Color(0, 0, 0, 0.25))   # shadow
	draw_rect(Rect2(-6, -18, 12, 15), Color("#5b6472"))      # apron
	draw_rect(Rect2(-6, -18, 12, 2), Color("#7b8492"))       # collar
	draw_rect(Rect2(-5, -26, 10, 8), Color("#e8c9a0"))       # head
	draw_rect(Rect2(-5, -26, 10, 2), Color("#584437"))       # hair
	draw_rect(Rect2(-2, -22, 2, 2), Color("#2a1f1a"))        # eyes (facing down)
	draw_rect(Rect2(1, -22, 2, 2), Color("#2a1f1a"))