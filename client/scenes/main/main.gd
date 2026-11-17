extends Node2D
## P1 root: builds the active location from content, spawns the player, restores the save.
##
## The player is a child of WorldHost (not of the location), so swapping locations never
## destroys the player or its camera — the reason this indirection exists at all (§6.3).

const PLAYER_SCENE := preload("res://scenes/player/player.tscn")
const CUTSCENE_UI := preload("res://scripts/ui/cutscene_ui.gd")
const TOUCH_UI := preload("res://scripts/ui/touch_controls.gd")
const TITLE_UI := preload("res://scripts/ui/title_screen.gd")
const DEFAULT_LOCATION := "loc_ssp_market_street"

@onready var world_host: Node2D = $WorldHost

var location: LocationRoot = null
var player: CharacterBody2D = null
var cutscene: CanvasLayer = null
var touch: CanvasLayer = null
var title: CanvasLayer = null

var _restored_position: bool = false


func _ready() -> void:
	add_to_group("main")
	# Recursive Y-sort: locations (and the player) sort by their origins, so entities on
	# both sides of a location boundary overlap by depth, not by tree order.
	world_host.y_sort_enabled = true
	# P3: the `goto` effect and location exits both funnel through the bus; the swap is
	# deferred because the emitter may be mid-effects-loop or inside the exiting tree.
	Bus.goto_requested.connect(_on_goto_requested)
	cutscene = CUTSCENE_UI.new()
	add_child(cutscene)
	touch = TOUCH_UI.new()
	add_child(touch)
	title = TITLE_UI.new()
	add_child(title)
	var version := Engine.get_version_info()
	print("[Main] Godot %s | renderer=%s | viewport=%dx%d" % [
		version.get("string", "?"),
		ProjectSettings.get_setting("rendering/renderer/rendering_method", "?"),
		ProjectSettings.get_setting("display/window/size/viewport_width", 0),
		ProjectSettings.get_setting("display/window/size/viewport_height", 0),
	])
	print("[ContentDB] loaded %d entities | locale=%s" % [ContentDB.loaded_count, Settings.locale])

	if Save.has_save(1) and Save.load_game(1):
		_restored_position = Game.player_position != Vector2.ZERO
		print("[Main] restored save slot 1 (flags=%d, items=%d)" % [
			Game.flags.size(), Game.inventory.size(),
		])
	else:
		Game.new_game()

	var start := Game.current_location if not Game.current_location.is_empty() else DEFAULT_LOCATION
	load_location(start)
	Save.bind_autosave()
	# Fire-and-forget hot-pack check (§5.7): a newer published pack overrides the baseline in
	# memory; with the backend down this is a silent no-op and the baseline rules.
	Net.fetch_content_pack()


## Rebuilds the world for a location id. Safe to call at runtime (dev console `loc` command).
func load_location(location_id: String, spawn_id: String = "default") -> void:
	var definition := ContentDB.get_entity("locations", location_id)
	if definition.is_empty():
		push_error("Main: unknown location '%s'" % location_id)
		return

	if location != null and is_instance_valid(location):
		location.queue_free()

	location = LocationRoot.new()
	world_host.add_child(location)
	# Keep every location BEHIND the player: add_child appends, so a rebuilt location would
	# otherwise draw its tilemap over the player after the first transition (reported bug).
	world_host.move_child(location, 0)
	location.build(definition)

	if player == null:
		player = PLAYER_SCENE.instantiate()
		world_host.add_child(player)

	Game.current_location = location_id
	Game.visited[location_id] = true

	if _restored_position:
		player.global_position = Game.player_position
		_restored_position = false
	else:
		player.global_position = location.get_spawn(spawn_id)
	Game.player_position = player.global_position

	_apply_camera_limits()
	Bus.location_entered.emit(location_id)


## Called via Bus.goto_requested (Effects `goto`, location exits). Deferred so the swap never
## happens inside the effects loop or the exiting location's own signal handlers.
func _on_goto_requested(location_id: String, spawn_id: String) -> void:
	load_location.call_deferred(location_id, spawn_id)


func _apply_camera_limits() -> void:
	if player == null:
		return
	var camera := player.get_node_or_null("Camera2D") as Camera2D
	if camera == null:
		return
	var bounds: Rect2 = location.get_bounds()
	camera.limit_left = int(bounds.position.x)
	camera.limit_top = int(bounds.position.y)
	camera.limit_right = int(bounds.end.x)
	camera.limit_bottom = int(bounds.end.y)


## Called by the dev console via call_group("main", ...).
func dev_teleport(x: float, y: float) -> void:
	if player != null:
		player.global_position = Vector2(x, y)
		Game.player_position = player.global_position
