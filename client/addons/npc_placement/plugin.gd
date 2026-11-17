@tool
extends EditorPlugin
## NPC-placement dock (docs/PLAN.md §9.1): pick a location JSON, adjust each NPC's tile and
## facing, write back through NpcPlacementWriter. The runtime never loads this file — it is
## editor-only, which is why the testable logic lives in location_writer.gd instead.

const WRITER := preload("res://addons/npc_placement/location_writer.gd")
const CONTENT_DIR := "res://content/locations"

var _dock: Control
var _picker: OptionButton
var _rows: VBoxContainer
var _status: Label
var _placements: Array = []
var _path: String = ""


func _enter_tree() -> void:
	_dock = _build_dock()
	add_control_to_dock(DOCK_SLOT_RIGHT_UL, _dock)


func _exit_tree() -> void:
	remove_control_from_docks(_dock)
	_dock.queue_free()


func _build_dock() -> Control:
	var panel := PanelContainer.new()
	panel.name = "NpcPlacement"
	var column := VBoxContainer.new()
	panel.add_child(column)

	var picker_label := Label.new()
	picker_label.text = "Location JSON"
	column.add_child(picker_label)
	_picker = OptionButton.new()
	_picker.item_selected.connect(_on_pick)
	column.add_child(_picker)

	_rows = VBoxContainer.new()
	column.add_child(_rows)

	var apply := Button.new()
	apply.text = "写回 JSON / Write back"
	apply.pressed.connect(_on_apply)
	column.add_child(apply)

	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	column.add_child(_status)
	return panel


func _ready() -> void:
	_refresh_picker()


func _refresh_picker() -> void:
	_picker.clear()
	DirAccess.make_dir_recursive_absolute(CONTENT_DIR)
	var dir := DirAccess.open(CONTENT_DIR)
	if dir == null:
		return
	dir.list_dir_begin()
	var file_name := dir.get_next()
	while file_name != "":
		if not dir.current_is_dir() and file_name.ends_with(".json"):
			_picker.add_item(file_name)
		file_name = dir.get_next()
	dir.list_dir_end()


func _on_pick(_index: int) -> void:
	var file_name := _picker.get_item_text(_picker.selected)
	_path = "%s/%s" % [CONTENT_DIR, file_name]
	var file := FileAccess.open(_path, FileAccess.READ)
	if file == null:
		_status.text = "cannot read %s" % _path
		return
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	_placements = []
	_clear_rows()
	if typeof(parsed) != TYPE_DICTIONARY:
		_status.text = "not a JSON object"
		return
	for placement in parsed.get("npcs", []):
		if typeof(placement) == TYPE_DICTIONARY:
			_placements.append({
				"npc": String(placement.get("npc", "")),
				"tile_x": int((placement.get("tile", [0, 0]) as Array)[0]),
				"tile_y": int((placement.get("tile", [0, 0]) as Array)[1]),
				"facing": String(placement.get("facing", "down")),
			})
	_rebuild_rows()


func _clear_rows() -> void:
	for child in _rows.get_children():
		child.queue_free()


func _rebuild_rows() -> void:
	_clear_rows()
	for placement in _placements:
		var row := HBoxContainer.new()
		var name_label := Label.new()
		name_label.text = String(placement["npc"])
		name_label.custom_minimum_size = Vector2(130, 0)
		row.add_child(name_label)
		for key in ["tile_x", "tile_y"]:
			var spin := SpinBox.new()
			spin.value = int(placement[key])
			spin.min_value = 0
			spin.max_value = 200
			spin.custom_minimum_size = Vector2(70, 0)
			spin.value_changed.connect(func(value: float) -> void: placement[key] = int(value))
			row.add_child(spin)
		var facing := OptionButton.new()
		for option in ["down", "up", "left", "right"]:
			facing.add_item(option)
		facing.select(["down", "up", "left", "right"].find(String(placement["facing"])))
		facing.item_selected.connect(func(index: int) -> void:
			placement["facing"] = ["down", "up", "left", "right"][index])
		row.add_child(facing)
		_rows.add_child(row)


func _on_apply() -> void:
	var result: Dictionary = WRITER.write_npc_placements(_path, _placements)
	if result.has("error"):
		_status.text = String(result["error"])
	else:
		_status.text = "written %d, added %d — regenerate the manifest before the next export." % [
			int(result["written"]), int(result["added"]),
		]