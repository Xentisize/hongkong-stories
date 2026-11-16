class_name LocationDoor
extends Node2D
## A condition-gated door (§5.3 `doors`).
##
## Blocker + tile swap + a persisted open flag. The door does not decide how it opens: it
## evaluates `requires` through the shared condition evaluator (§5.5), so "a key opens it" and
## "a debug flag opens it" are the same code path — which is what makes the P1 exit criterion
## ("dev console sets a flag and a door opens") a real test rather than a special case.

var data: Dictionary = {}
var _tile_size: int = 24
var _tiles: Array[Vector2i] = []
var _tilemap: TileMapLayer
var _floor_atlas: Vector2i = Vector2i.ZERO
var _blocker: StaticBody2D
var _is_open: bool = false


func configure(definition: Dictionary, tile_size: int, tilemap: TileMapLayer, floor_atlas: Vector2i) -> void:
	data = definition
	_tile_size = tile_size
	_tilemap = tilemap
	_floor_atlas = floor_atlas
	name = "Door_%s" % String(data.get("id", "door"))
	add_to_group("interactable")

	for raw in data.get("tiles", []):
		var entry: Array = raw
		_tiles.append(Vector2i(int(entry[0]), int(entry[1])))
	if _tiles.is_empty():
		push_error("Door %s has no tiles" % name)
		return

	position = _bounds_centre()
	_build_blocker()

	# A door opened in a previous session must come back open, silently.
	if not open_flag().is_empty() and Game.get_flag(open_flag()):
		_open_silently()


func open_flag() -> String:
	return String(data.get("open_flag", ""))


func get_prompt() -> String:
	if _is_open:
		return ""
	var key := "prompt"
	return ContentDB.localize(data.get(key, ""), Settings.locale)


func is_available() -> bool:
	return not _is_open


func interact() -> void:
	if _is_open:
		return
	if Conditions.evaluate(data.get("requires")):
		_open(true)
	else:
		var blocked := ContentDB.localize(data.get("blocked", ""), Settings.locale)
		if not blocked.is_empty():
			Bus.message_shown.emit(blocked)


func _open(announce: bool) -> void:
	if announce:
		var text := ContentDB.localize(data.get("opened", ""), Settings.locale)
		if not text.is_empty():
			Bus.message_shown.emit(text)
		Effects.apply([
			{"type": "set_flag", "flag": open_flag(), "value": true},
		])
	_open_silently()


## Swaps the door tiles for floor and removes the collider. Idempotent.
func _open_silently() -> void:
	if _is_open:
		return
	_is_open = true
	if _blocker != null and is_instance_valid(_blocker):
		_blocker.queue_free()
		_blocker = null
	if _tilemap != null:
		for tile in _tiles:
			_tilemap.set_cell(tile, 0, _floor_atlas)


func _bounds_centre() -> Vector2:
	var min_tile := _tiles[0]
	var max_tile := _tiles[0]
	for tile in _tiles:
		min_tile.x = mini(min_tile.x, tile.x)
		min_tile.y = mini(min_tile.y, tile.y)
		max_tile.x = maxi(max_tile.x, tile.x)
		max_tile.y = maxi(max_tile.y, tile.y)
	var size := max_tile - min_tile + Vector2i.ONE
	return (Vector2(min_tile) + Vector2(size) * 0.5) * _tile_size


func _build_blocker() -> void:
	var min_tile := _tiles[0]
	var max_tile := _tiles[0]
	for tile in _tiles:
		min_tile.x = mini(min_tile.x, tile.x)
		min_tile.y = mini(min_tile.y, tile.y)
		max_tile.x = maxi(max_tile.x, tile.x)
		max_tile.y = maxi(max_tile.y, tile.y)
	var size := max_tile - min_tile + Vector2i.ONE

	var shape := RectangleShape2D.new()
	shape.size = Vector2(size) * _tile_size
	var node := CollisionShape2D.new()
	node.shape = shape

	_blocker = StaticBody2D.new()
	_blocker.name = "Blocker"
	_blocker.add_child(node)
	add_child(_blocker)
	# The door node sits at the centre of its tiles, so the blocker needs no offset.
