@tool
extends EditorPlugin
## The three-panel map & asset editor (RPG Maker lessons, #1) — a dock that edits location
## JSONs the way RPG Maker edits maps:
##
##   LEFT      the location tree (grouped by era) + the tile palette below it
##   CENTER    the map canvas: a clickable grid of the location's tilemap
##   RIGHT     the inspector: the selected event's fields
##
## The MAP/EVENT toggle replicates RPG Maker's crucial switch: MAP mode paints tiles from
## the palette; EVENT mode shows N/I/D markers on the same grid, selects events to inspect,
## and places NPCs from the picker. Write-back goes through NpcPlacementWriter — the exact
## core the headless selftest exercises — so tiles and placements replace wholesale and
## doors are preserved untouched.
##
## Editor context only: no autoloads here — content is read with FileAccess/DirAccess.

const WRITER := preload("res://addons/npc_placement/location_writer.gd")
const CONTENT_DIR := "res://content/locations"
const NPCS_DIR := "res://content/npcs"
const CELL_PX := 26
const LEGEND_ORDER := [".", ",", "#", "D"]   # legend coords = atlas columns 0..3

var _root: Control
var _tree: Tree
var _palette: HBoxContainer
var _grid: GridContainer
var _grid_scroll: ScrollContainer
var _mode_button: Button
var _place_picker: OptionButton
var _inspector: VBoxContainer
var _status: Label

var _mode: int = 0                 # 0 = map paint, 1 = event edit
var _selected_tile: int = 0        # palette index
var _path: String = ""
var _data: Dictionary = {}
var _cells: Array = []             # Button per cell, row-major
var _npc_ids: Array = []           # for the place picker
var _selected: Variant = null      # {"kind": "npc"|"interactable", "index": int}


func _enter_tree() -> void:
	_root = _build_dock()
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, _root)


func _exit_tree() -> void:
	remove_control_from_docks(_root)
	_root.queue_free()


func _ready() -> void:
	_refresh_tree()
	_refresh_npc_ids()


func _status_msg(text: String) -> void:
	_status.text = text


func _build_dock() -> Control:
	var panel := PanelContainer.new()
	panel.name = "MapEditor"
	var column := VBoxContainer.new()
	column.add_theme_constant_override("separation", 4)
	panel.add_child(column)

	var top := HBoxContainer.new()
	column.add_child(top)
	_mode_button = Button.new()
	_mode_button.text = "模式：地图"
	_mode_button.toggle_mode = true
	_mode_button.button_pressed = true
	_mode_button.pressed.connect(_on_toggle_mode)
	top.add_child(_mode_button)
	_place_picker = OptionButton.new()
	_place_picker.visible = false
	top.add_child(_place_picker)
	var write := Button.new()
	write.text = "写回 JSON"
	write.pressed.connect(_on_write)
	top.add_child(write)
	var reload := Button.new()
	reload.text = "重载"
	reload.pressed.connect(func() -> void:
		_refresh_tree()
		_refresh_npc_ids()
		_status_msg("reloaded"))
	top.add_child(reload)

	var body := HBoxContainer.new()
	body.add_theme_constant_override("separation", 8)
	column.add_child(body)

	var left := VBoxContainer.new()
	left.custom_minimum_size = Vector2(190, 0)
	body.add_child(left)
	var tree_label := Label.new()
	tree_label.text = "Locations"
	left.add_child(tree_label)
	_tree = Tree.new()
	_tree.custom_minimum_size = Vector2(190, 220)
	_tree.item_selected.connect(_on_pick_location)
	left.add_child(_tree)
	var palette_label := Label.new()
	palette_label.text = "Tile palette"
	left.add_child(palette_label)
	_palette = HBoxContainer.new()
	_palette.add_theme_constant_override("separation", 2)
	left.add_child(_palette)

	var right := VBoxContainer.new()
	right.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	body.add_child(right)
	_grid_scroll = ScrollContainer.new()
	_grid_scroll.custom_minimum_size = Vector2(520, 300)
	right.add_child(_grid_scroll)
	_grid = GridContainer.new()
	_grid.add_theme_constant_override("h_separation", 0)
	_grid.add_theme_constant_override("v_separation", 0)
	_grid_scroll.add_child(_grid)
	var inspect_label := Label.new()
	inspect_label.text = "Inspector"
	right.add_child(inspect_label)
	_inspector = VBoxContainer.new()
	_inspector.add_theme_constant_override("separation", 3)
	right.add_child(_inspector)

	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	column.add_child(_status)
	return panel


# ---------- data loading ----------

func _location_files() -> Array:
	var files: Array = []
	var dir := DirAccess.open(CONTENT_DIR)
	if dir == null:
		return files
	dir.list_dir_begin()
	var file_name := dir.get_next()
	while file_name != "":
		if not dir.current_is_dir() and file_name.ends_with(".json"):
			files.append(file_name)
		file_name = dir.get_next()
	dir.list_dir_end()
	files.sort()
	return files


func _refresh_tree() -> void:
	_tree.clear()
	var root_item := _tree.create_item()
	root_item.set_text(0, "Hong Kong Stories")
	var by_era: Dictionary = {}
	for file_name in _location_files():
		var parsed: Variant = JSON.parse_string(
			FileAccess.get_file_as_string("%s/%s" % [CONTENT_DIR, file_name]))
		if typeof(parsed) != TYPE_DICTIONARY:
			continue
		var era := String((parsed as Dictionary).get("era", "unknown"))
		if not by_era.has(era):
			var era_item := _tree.create_item(root_item)
			era_item.set_text(0, era)
			by_era[era] = era_item
		var item := _tree.create_item(by_era[era])
		item.set_text(0, String((parsed as Dictionary).get("id", file_name)))
		item.set_metadata(0, file_name)


func _refresh_npc_ids() -> void:
	_place_picker.clear()
	_place_picker.add_item("放置…")
	_npc_ids = []
	var dir := DirAccess.open(NPCS_DIR)
	if dir == null:
		return
	dir.list_dir_begin()
	var file_name := dir.get_next()
	while file_name != "":
		if not dir.current_is_dir() and file_name.ends_with(".json"):
			_npc_ids.append(file_name.trim_suffix(".json"))
		file_name = dir.get_next()
	dir.list_dir_end()
	_npc_ids.sort()
	for id in _npc_ids:
		_place_picker.add_item(id)


func _on_pick_location() -> void:
	var item := _tree.get_selected()
	if item == null or item.get_metadata(0) == null:
		return
	_path = "%s/%s" % [CONTENT_DIR, String(item.get_metadata(0))]
	var parsed: Variant = JSON.parse_string(FileAccess.get_file_as_string(_path))
	if typeof(parsed) != TYPE_DICTIONARY:
		_status_msg("not a JSON object")
		return
	_data = parsed
	_selected = null
	_build_palette()
	_build_grid()
	_rebuild_inspector()
	_status_msg("loaded %s" % String(_data.get("id", "?")))


# ---------- palette & canvas ----------

func _atlas_for_tile(index: int) -> Texture2D:
	var atlas_path := String(_data.get("atlas", "res://assets/tiles/p1_tiles.png"))
	var texture := load(atlas_path) as Texture2D
	if texture == null:
		return null
	var piece := AtlasTexture.new()
	piece.atlas = texture
	piece.region = Rect2(index * 24, 0, 24, 24)
	return piece


func _build_palette() -> void:
	for child in _palette.get_children():
		child.queue_free()
	for index in LEGEND_ORDER.size():
		var button := Button.new()
		button.icon = _atlas_for_tile(index)
		button.custom_minimum_size = Vector2(28, 28)
		button.toggle_mode = true
		button.button_pressed = index == _selected_tile
		button.pressed.connect(_on_pick_tile.bind(index))
		_palette.add_child(button)


func _on_pick_tile(index: int) -> void:
	_selected_tile = index
	_mode = 0
	_mode_button.button_pressed = true
	_mode_button.text = "模式：地图"
	_place_picker.visible = false
	_refresh_cells()


func _on_toggle_mode() -> void:
	_mode = 1 - _mode
	_mode_button.text = "模式：地图" if _mode == 0 else "模式：事件"
	_place_picker.visible = _mode == 1
	_refresh_cells()
	_rebuild_inspector()


func _event_at(x: int, y: int) -> Variant:
	for index in (_data.get("npcs", []) as Array).size():
		var p: Dictionary = (_data.get("npcs", []) as Array)[index]
		var tile: Array = p.get("tile", [])
		if int(tile[0]) == x and int(tile[1]) == y:
			return {"kind": "npc", "index": index}
	for index in (_data.get("interactables", []) as Array).size():
		var p: Dictionary = (_data.get("interactables", []) as Array)[index]
		var tile: Array = p.get("tile", [])
		if int(tile[0]) == x and int(tile[1]) == y:
			return {"kind": "interactable", "index": index}
	return null


func _build_grid() -> void:
	for child in _grid.get_children():
		child.queue_free()
	_cells = []
	var rows: Array = _data.get("tilemap", [])
	if rows.is_empty():
		return
	_grid.columns = String(rows[0]).length()
	for y in rows.size():
		var row := String(rows[y])
		for x in row.length():
			var button := Button.new()
			button.custom_minimum_size = Vector2(CELL_PX, CELL_PX)
			button.focus_mode = Control.FOCUS_NONE
			button.clip_text = true
			button.pressed.connect(_on_cell.bind(x, y))
			_grid.add_child(button)
			_cells.append(button)
	_refresh_cells()


func _refresh_cells() -> void:
	var rows: Array = _data.get("tilemap", [])
	if _cells.is_empty():
		return
	var cell_index := 0
	for y in rows.size():
		var row := String(rows[y])
		for x in row.length():
			if cell_index >= _cells.size():
				break
			var button: Button = _cells[cell_index]
			var ch := row.substr(x, 1)
			var tile_index := LEGEND_ORDER.find(ch)
			button.icon = _atlas_for_tile(tile_index) if tile_index >= 0 else null
			button.tooltip_text = "%d,%d (%s)" % [x, y, ch]
			button.text = ""
			if _mode == 1:
				var event: Variant = _event_at(x, y)
				if event != null:
					button.text = "N" if event.kind == "npc" else "I"
			cell_index += 1


func _on_cell(x: int, y: int) -> void:
	if _path.is_empty():
		return
	if _mode == 0:
		var rows: Array = _data.get("tilemap", [])
		var row := String(rows[y])
		var key: String = LEGEND_ORDER[_selected_tile]
		rows[y] = row.substr(0, x) + key + row.substr(x + 1)
		_data["tilemap"] = rows
		_refresh_cells()
	else:
		var event: Variant = _event_at(x, y)
		if event != null:
			_selected = event
			_rebuild_inspector()
			_refresh_cells()
			return
		var pick := _place_picker.selected
		if pick <= 0:
			_status_msg("event mode: pick something to place, or click an existing N/I")
			return
		var npc_id := _place_picker.get_item_text(pick)
		(_data.get("npcs", []) as Array).append({
			"npc": npc_id, "tile": [x, y], "facing": "down",
		})
		_selected = {"kind": "npc", "index": (_data.get("npcs", []) as Array).size() - 1}
		_rebuild_inspector()
		_refresh_cells()


# ---------- inspector ----------

func _rebuild_inspector() -> void:
	for child in _inspector.get_children():
		child.queue_free()
	if _selected == null:
		var hint := Label.new()
		hint.text = "nothing selected"
		_inspector.add_child(hint)
		return
	var events: Array = _data.get("npcs" if _selected.kind == "npc" else "interactables", [])
	if _selected.index >= events.size():
		_selected = null
		return
	var event: Dictionary = events[_selected.index]
	var heading := Label.new()
	heading.text = "%s #%d — %s" % [_selected.kind, _selected.index, String(event.get("npc", event.get("id", "")))]
	_inspector.add_child(heading)

	if _selected.kind == "npc":
		_spin_field("tile_x", int((event.get("tile", [0, 0]) as Array)[0]), func(value: int) -> void:
			var tile: Array = event.get("tile", [0, 0])
			event["tile"] = [value, int(tile[1])]
			_refresh_cells())
		_spin_field("tile_y", int((event.get("tile", [0, 0]) as Array)[1]), func(value: int) -> void:
			var tile: Array = event.get("tile", [0, 0])
			event["tile"] = [int(tile[0]), value]
			_refresh_cells())
		_option_field("facing", ["down", "up", "left", "right"], String(event.get("facing", "down")), func(option: String) -> void:
			event["facing"] = option
			_refresh_cells())
	else:
		_text_field("id", String(event.get("id", "")), func(text: String) -> void: event["id"] = text)
		_text_field("art", String(event.get("art", "")), func(text: String) -> void: event["art"] = text)
		_spin_field("scale_x100", int(float(event.get("scale", 1.0)) * 100.0), func(value: int) -> void:
			event["scale"] = value / 100.0, 10, 200)
		_spin_field("tile_x", int((event.get("tile", [0, 0]) as Array)[0]), func(value: int) -> void:
			var tile: Array = event.get("tile", [0, 0])
			event["tile"] = [value, int(tile[1])]
			_refresh_cells())
		_spin_field("tile_y", int((event.get("tile", [0, 0]) as Array)[1]), func(value: int) -> void:
			var tile: Array = event.get("tile", [0, 0])
			event["tile"] = [int(tile[0]), value]
			_refresh_cells())

	var drop := Button.new()
	drop.text = "删除事件"
	drop.pressed.connect(func() -> void:
		events.remove_at(_selected.index)
		_selected = null
		_rebuild_inspector()
		_refresh_cells())
	_inspector.add_child(drop)
	var note := Label.new()
	note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	note.text = "NPC 的人设/状态页在 content/npcs/<id>.json 编辑；门保留原样（网格编辑器不表达矩形门）。"
	_inspector.add_child(note)


func _spin_field(label: String, value: int, on_change: Callable, min_v: int = 0, max_v: int = 200) -> void:
	var row := HBoxContainer.new()
	var name_label := Label.new()
	name_label.text = label
	name_label.custom_minimum_size = Vector2(80, 0)
	row.add_child(name_label)
	var spin := SpinBox.new()
	spin.min_value = min_v
	spin.max_value = max_v
	spin.value = value
	spin.value_changed.connect(func(new_value: float) -> void: on_change.call(int(new_value)))
	row.add_child(spin)
	_inspector.add_child(row)


func _text_field(label: String, value: String, on_change: Callable) -> void:
	var row := HBoxContainer.new()
	var name_label := Label.new()
	name_label.text = label
	name_label.custom_minimum_size = Vector2(80, 0)
	row.add_child(name_label)
	var edit := LineEdit.new()
	edit.text = value
	edit.text_changed.connect(on_change)
	row.add_child(edit)
	_inspector.add_child(row)


func _option_field(label: String, options: Array, value: String, on_change: Callable) -> void:
	var row := HBoxContainer.new()
	var name_label := Label.new()
	name_label.text = label
	name_label.custom_minimum_size = Vector2(80, 0)
	row.add_child(name_label)
	var picker := OptionButton.new()
	for option in options:
		picker.add_item(String(option))
	picker.select(options.find(value))
	picker.item_selected.connect(func(index: int) -> void: on_change.call(String(options[index])))
	row.add_child(picker)
	_inspector.add_child(row)


# ---------- write back ----------

func _on_write() -> void:
	if _path.is_empty():
		_status_msg("pick a location first")
		return
	var result: Dictionary = WRITER.write_location(
		_path, _data.get("tilemap", []), _data.get("npcs", []), _data.get("interactables", []))
	if result.has("error"):
		_status_msg(String(result["error"]))
	else:
		_status_msg("written: %s — regenerate the manifest before the next export." % _path)