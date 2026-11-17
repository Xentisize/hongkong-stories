extends Node
## Save slots (docs/PLAN.md §6.4).
##
## Real implementation already: one JSON file per slot under `user://saves`, plus the
## browser-persistence check that P1's UI will surface to the player.

const SAVE_DIR := "user://saves"


func _ready() -> void:
	DirAccess.make_dir_recursive_absolute(SAVE_DIR)


func slot_path(slot: int) -> String:
	return "%s/slot_%d.json" % [SAVE_DIR, slot]


func has_save(slot: int) -> bool:
	return FileAccess.file_exists(slot_path(slot))


func save_game(slot: int) -> bool:
	var file := FileAccess.open(slot_path(slot), FileAccess.WRITE)
	if file == null:
		push_error("Save: cannot write slot %d (%s)" % [slot, error_string(FileAccess.get_open_error())])
		return false
	file.store_string(JSON.stringify(Game.to_dict(), "\t"))
	file.close()
	Bus.save_written.emit(slot)
	return true


func load_game(slot: int) -> bool:
	if not has_save(slot):
		return false
	var text := FileAccess.get_file_as_string(slot_path(slot))
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_error("Save: slot %d is not a JSON object" % slot)
		return false
	if not Game.from_dict(parsed):
		return false
	Bus.save_loaded.emit(slot)
	return true


func delete_save(slot: int) -> void:
	if has_save(slot):
		DirAccess.remove_absolute(slot_path(slot))


## Autosave (§6.4): item and flag changes arrive in bursts (one pickup can fire three effects),
## so writes are debounced into a single slot-1 write 2s after the burst settles.
const AUTOSAVE_SLOT := 1
const AUTOSAVE_DEBOUNCE_SEC := 2.0

var _autosave_timer: Timer = null


func bind_autosave() -> void:
	if _autosave_timer != null:
		return
	_autosave_timer = Timer.new()
	_autosave_timer.name = "AutosaveTimer"
	_autosave_timer.one_shot = true
	_autosave_timer.wait_time = AUTOSAVE_DEBOUNCE_SEC
	_autosave_timer.timeout.connect(_on_autosave_timeout)
	add_child(_autosave_timer)

	Bus.item_gained.connect(func(_item_id: String, _count: int) -> void: _queue_autosave())
	Bus.item_lost.connect(func(_item_id: String, _count: int) -> void: _queue_autosave())
	Bus.flag_set.connect(func(_flag: String, _value: bool) -> void: _queue_autosave())
	Bus.location_entered.connect(func(_location_id: String) -> void: _queue_autosave())


func _queue_autosave() -> void:
	if _autosave_timer != null:
		_autosave_timer.start()


func _on_autosave_timeout() -> void:
	save_game(AUTOSAVE_SLOT)


## On the web this is IndexedDB. False means progress dies with site data (§6.4).
func is_persistence_durable() -> bool:
	if OS.has_method("is_userfs_persisted"):
		return bool(OS.call("is_userfs_persisted"))
	return true


## Save-code export (§6.4): base64+zlib of the save payload — free cloud-less backup, and the
## cheapest way for a playtester to send you a broken state. The zlib stream does not carry
## its decompressed length, so the code prefixes it: 4 bytes little-endian size + deflate body.
func export_code(slot: int = AUTOSAVE_SLOT) -> String:
	var text := JSON.stringify(Game.to_dict())
	var raw := text.to_utf8_buffer()
	var packed := raw.compress(FileAccess.COMPRESSION_DEFLATE)
	var sized := PackedByteArray()
	sized.resize(4)
	sized.encode_u32(0, raw.size())
	sized.append_array(packed)
	return Marshalls.raw_to_base64(sized)


## Applies a save code to the CURRENT session (callers then reload the location). Returns
## false for a mangled code or a schema this build cannot read — never corrupts the slot.
func import_code(code: String) -> bool:
	var sized := Marshalls.base64_to_raw(code.strip_edges())
	if sized.size() < 4:
		return false
	var size := sized.decode_u32(0)
	if size == 0 or size > 8_000_000:  # a sane ceiling: a save is a few KiB
		return false
	var raw := sized.slice(4).decompress(size, FileAccess.COMPRESSION_DEFLATE)
	var parsed: Variant = JSON.parse_string(raw.get_string_from_utf8())
	if typeof(parsed) != TYPE_DICTIONARY:
		return false
	return Game.from_dict(parsed)
