class_name LocationRoot
extends Node2D
## Builds a location from its JSON definition (docs/PLAN.md §5.3) into a live node tree.
##
## Deliberate, temporary deviation from §5.3: maps are described by `tilemap` / `legend` /
## `collision` JSON rather than authored as TileMapLayer scenes in the Godot editor. The
## editor is not in the loop yet (no real art, headless CI, no design pass), and this is
## exactly the format the admin pipeline in P4 will emit. When editor-authored maps land, the
## JSON contract for collision / doors / interactables stays as-is.
##
## Tiles are visual only; collision comes from the `collision` rect list. Keeping the two
## separate means a TileSet physics layer is not needed until art is final, and a mis-drawn
## tile cannot silently break movement.

var data: Dictionary = {}
var tile_size: int = 24
var size_tiles: Vector2i = Vector2i.ZERO

var _tiles: TileMapLayer
var _floor_atlas: Vector2i = Vector2i.ZERO
var doors: Array[Node2D] = []
var interactables: Array[Node2D] = []
var npcs: Array[Node2D] = []
var exits: Array[Node2D] = []


func build(location: Dictionary) -> void:
	data = location
	name = "Location_%s" % String(data.get("id", "unknown"))
	add_to_group("location")
	# Y-sort merges this location's entities into the player's depth ordering (WorldHost
	# is y-sorted too); the TileMapLayer's origin at (0,0) keeps the floor behind everyone.
	y_sort_enabled = true
	tile_size = int(data.get("tile_size", 24))
	_build_tiles()
	_build_collision()
	_build_decor()
	_build_doors()
	_build_interactables()
	_build_npcs()
	_build_exits()


## Decorative props from the `decor` array (§5.3 extension): {art, tile} entries rendered
## as sprites at tile centres, Y-sorted with everything else. Pure dressing — no collision,
## no interaction — so a room can be dressed without touching code.
func _build_decor() -> void:
	for raw in data.get("decor", []):
		var entry: Dictionary = raw
		var art_path := String(entry.get("art", ""))
		var texture := ContentDB.art_texture(art_path)
		if texture == null:
			push_warning("LocationRoot: decor art missing: %s" % art_path)
			continue
		var sprite := Sprite2D.new()
		sprite.texture = texture
		var tile: Array = entry.get("tile", [0, 0])
		sprite.position = Vector2(float(tile[0]) + 0.5, float(tile[1]) + 0.5) * tile_size
		add_child(sprite)


func _build_tiles() -> void:
	var rows: Array = data.get("tilemap", [])
	var legend: Dictionary = data.get("legend", {})
	var atlas_path := String(data.get("atlas", ""))
	if not ResourceLoader.exists(atlas_path):
		push_error("LocationRoot: atlas missing: %s" % atlas_path)
		return
	if legend.has("."):
		var floor_coords: Array = legend["."]
		_floor_atlas = Vector2i(int(floor_coords[0]), int(floor_coords[1]))

	var tileset := TileSet.new()
	tileset.tile_size = Vector2i(tile_size, tile_size)

	var source := TileSetAtlasSource.new()
	source.texture = load(atlas_path)
	source.texture_region_size = Vector2i(tile_size, tile_size)
	# Register every atlas coordinate the legend references, deduplicated.
	for key in legend.keys():
		var entry: Array = legend[key]
		var coords := Vector2i(int(entry[0]), int(entry[1]))
		if not source.has_tile(coords):
			source.create_tile(coords)
	tileset.add_source(source, 0)

	_tiles = TileMapLayer.new()
	_tiles.name = "Tiles"
	_tiles.tile_set = tileset
	add_child(_tiles)

	size_tiles = Vector2i(0, rows.size())
	for y in rows.size():
		var row := String(rows[y])
		size_tiles.x = maxi(size_tiles.x, row.length())
		for x in row.length():
			var ch := row[x]
			if not legend.has(ch):
				continue
			var coords: Array = legend[ch]
			_tiles.set_cell(Vector2i(x, y), 0, Vector2i(int(coords[0]), int(coords[1])))


func _build_collision() -> void:
	var body := StaticBody2D.new()
	body.name = "Collision"
	add_child(body)
	for raw in data.get("collision", []):
		var rect: Array = raw
		_add_rect_shape(body, Rect2i(int(rect[0]), int(rect[1]), int(rect[2]), int(rect[3])))


func _add_rect_shape(body: CollisionObject2D, rect_tiles: Rect2i) -> void:
	var shape := RectangleShape2D.new()
	shape.size = Vector2(rect_tiles.size) * tile_size
	var node := CollisionShape2D.new()
	node.shape = shape
	node.position = (Vector2(rect_tiles.position) + Vector2(rect_tiles.size) * 0.5) * tile_size
	body.add_child(node)


func _build_doors() -> void:
	for raw in data.get("doors", []):
		var definition: Dictionary = raw
		var door := LocationDoor.new()
		add_child(door)
		door.configure(definition, tile_size, _tiles, _floor_atlas)
		doors.append(door)


func _build_interactables() -> void:
	for raw in data.get("interactables", []):
		var definition: Dictionary = raw
		var node := LocationInteractable.new()
		add_child(node)
		node.configure(definition, tile_size)
		interactables.append(node)


func _build_npcs() -> void:
	for raw in data.get("npcs", []):
		var placement: Dictionary = raw
		var node := LocationNpc.new()
		add_child(node)
		node.configure(placement, tile_size)
		npcs.append(node)

	# NPC presence (§5.1) and prop gating (§5.5) are condition-driven: re-evaluate whenever
	# state changes or a conversation ends (talk counts). The connections die with this node
	# on a location swap.
	Bus.effect_applied.connect(func(_effect: Dictionary) -> void: _refresh_gated())
	Bus.dialogue_finished.connect(func(_npc_id: String) -> void: _refresh_gated())


func _refresh_gated() -> void:
	for npc in npcs:
		npc.call("refresh_availability")
	for prop in interactables:
		prop.call("refresh_availability")


func _build_exits() -> void:
	for raw in data.get("exits", []):
		var definition: Dictionary = raw
		var node := LocationExit.new()
		add_child(node)
		node.configure(definition, tile_size)
		exits.append(node)


## World position for a spawn point id ("default" if unknown/missing).
func get_spawn(spawn_id: String = "default") -> Vector2:
	var spawns: Dictionary = data.get("spawn_points", {})
	var entry: Array = spawns.get(spawn_id, spawns.get("default", []))
	if entry.size() < 2:
		return Vector2.ZERO
	# Spawn points are in tile units, measured to the tile centre.
	return Vector2(float(entry[0]), float(entry[1])) * tile_size


## Pixel bounds of the whole map, for camera limits.
func get_bounds() -> Rect2:
	return Rect2(Vector2.ZERO, Vector2(size_tiles) * tile_size)


## Used by the selftest and the dev console to prove a door flipped to floor.
func get_tile_at(tile: Vector2i) -> Vector2i:
	if _tiles == null:
		return Vector2i(-1, -1)
	return _tiles.get_cell_atlas_coords(tile)
