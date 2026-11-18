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
var _walk_tex: Texture2D = null
var _facing: String = "down"
var _wander_radius: float = 0.0
var _wander_home: Vector2 = Vector2.ZERO
var _wander_target: Vector2 = Vector2.ZERO
var _wander_wait: float = 1.0
var _moving: bool = false
var _anim_time: float = 0.0
var _frame: int = 0
var _walkable: Callable = Callable()


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
	_walk_tex = _load_walk_texture(definition)
	_facing = String(placement.get("facing", "down"))
	_wander_radius = float(placement.get("wander", 0.0))
	_wander_home = position
	_wander_wait = randf_range(1.0, 3.0)
	# The display name is localized at configure time; follow locale switches live so the
	# interaction prompt never shows a stale language.
	if not _locale_connected:
		_locale_connected = true
		Bus.locale_changed.connect(_on_locale_changed)
	queue_redraw()


func set_walkable_query(query: Callable) -> void:
	_walkable = query


func _load_walk_texture(definition: Dictionary) -> Texture2D:
	var sprite: Variant = definition.get("sprite")
	if typeof(sprite) != TYPE_DICTIONARY:
		return null
	var sheet := String((sprite as Dictionary).get("sheet_walk", ""))
	return ContentDB.art_texture(sheet)


## Wander (RPG Maker's NPC shuffle): every few seconds pick a random walkable tile within
## the placement's `wander` radius and glide there. radius 0 = a fixture that never moves.
func _process(delta: float) -> void:
	if _wander_radius <= 0.0 or not _requires_pass:
		return
	_anim_time += delta
	_frame = int(_anim_time * 6.0) % 2
	if _moving:
		position += (_wander_target - position).normalized() * 20.0 * delta
		if position.distance_to(_wander_target) < 1.5:
			position = _wander_target
			_moving = false
			_wander_wait = randf_range(2.0, 5.0)
		queue_redraw()
		return
	_wander_wait -= delta
	if _wander_wait <= 0.0:
		_pick_wander_target()


func _pick_wander_target() -> void:
	if not _walkable.is_valid():
		return
	var home_tile := Vector2i(int(_wander_home.x / _tile_size), int(_wander_home.y / _tile_size))
	for attempt in 8:
		var dx := randi_range(-int(_wander_radius), int(_wander_radius))
		var dy := randi_range(-int(_wander_radius), int(_wander_radius))
		if dx == 0 and dy == 0:
			continue
		var tile := home_tile + Vector2i(dx, dy)
		if _walkable.call(tile.x, tile.y):
			_wander_target = (Vector2(tile) + Vector2(0.5, 0.5)) * _tile_size
			_moving = true
			_facing = _direction_name(_wander_target - _wander_home)
			return
	_wander_wait = randf_range(2.0, 4.0)


func _direction_name(delta: Vector2) -> String:
	if absf(delta.x) > absf(delta.y):
		return "right" if delta.x > 0 else "left"
	return "down" if delta.y > 0 else "up"


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
	# The walk sheet (4 columns by facing x 2 rows stand/step) when the character has one;
	# otherwise the single pose, then the placeholder rectangles.
	if _walk_tex != null:
		var cell := Vector2(26.0, 34.0)
		var col: int = ["down", "right", "left", "up"].find(_facing)
		var row := _frame % 2 if _moving else 0
		var region := Rect2(col * cell.x, row * cell.y, cell.x, cell.y)
		var dest := Rect2(-cell.x / 2.0, -cell.y + 1.0, cell.x, cell.y)
		draw_rect(Rect2(-7, -1, 14, 2), Color(0, 0, 0, 0.25))   # ground shadow
		draw_texture_rect_region(_walk_tex, dest, region)
		return
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