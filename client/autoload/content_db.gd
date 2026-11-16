extends Node
## Content loader and index (docs/PLAN.md §5, §5.7).
##
## Discovery is manifest-driven, not directory-driven, for a concrete reason: an exported
## Godot build may store `.json` as an imported resource (leaving `x.json.remap` on disk),
## which a DirAccess scan lists under a different name and then cannot read. The manifest is
## also the exact interface the P4 hot-pack endpoint serves, so this is the real design rather
## than a workaround. Regenerate with `python3 tools/gen_content_manifest.py`.
##
## Reading is dual-path (imported JSON resource first, raw file second) so the same code works
## in the editor, headless CI, and a wasm build.

const BASELINE_DIR := "res://content/"
const MANIFEST_PATH := "res://content/manifest.json"
const KINDS: PackedStringArray = ["npcs", "items", "locations", "quests", "lore"]

## kind -> { id -> entity Dictionary }
var _tables: Dictionary = {}

var version: int = 0
var content_hash: String = ""
var loaded_count: int = 0


func _ready() -> void:
	load_baseline()


func load_baseline() -> void:
	_tables.clear()
	loaded_count = 0
	for kind in KINDS:
		_tables[kind] = {}

	var files := _manifest_entries()
	if files.is_empty():
		# Dev convenience only: a checkout without a generated manifest still runs.
		files = _scan_content_dirs()

	for entry in files:
		_ingest(String(entry))


func _manifest_entries() -> Array:
	var manifest := _read_json(MANIFEST_PATH)
	if manifest.is_empty():
		return []
	version = int(manifest.get("version", 0))
	content_hash = String(manifest.get("content_hash", ""))
	return manifest.get("files", [])


func _scan_content_dirs() -> Array:
	var found: Array = []
	for kind in KINDS:
		var dir_path: String = BASELINE_DIR + kind
		var dir := DirAccess.open(dir_path)
		if dir == null:
			continue
		dir.list_dir_begin()
		var file_name := dir.get_next()
		while file_name != "":
			if not dir.current_is_dir():
				if file_name.ends_with(".json"):
					found.append("%s/%s" % [kind, file_name])
				elif file_name.ends_with(".json.remap"):
					found.append("%s/%s" % [kind, file_name.trim_suffix(".remap")])
			file_name = dir.get_next()
		dir.list_dir_end()
	return found


func _ingest(relative_path: String) -> void:
	var parts := relative_path.split("/", false)
	if parts.size() != 2:
		push_error("ContentDB: bad manifest entry '%s'" % relative_path)
		return
	var kind := String(parts[0])
	if not _tables.has(kind):
		_tables[kind] = {}

	var path := BASELINE_DIR + relative_path
	var entity := _read_json(path)
	if entity.is_empty():
		push_error("ContentDB: cannot read %s" % path)
		return

	var id := String(entity.get("id", ""))
	if id.is_empty():
		push_error("ContentDB: %s has no id" % path)
		return

	_tables[kind][id] = entity
	loaded_count += 1


func _read_json(path: String) -> Dictionary:
	if ResourceLoader.exists(path):
		var resource := ResourceLoader.load(path)
		if resource is JSON:
			var data: Variant = (resource as JSON).data
			if typeof(data) == TYPE_DICTIONARY:
				return data
	var text := FileAccess.get_file_as_string(path)
	if text.is_empty():
		return {}
	var parsed: Variant = JSON.parse_string(text)
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}


func get_entity(kind: String, id: String) -> Dictionary:
	var table: Dictionary = _tables.get(kind, {})
	return table.get(id, {})


func has_entity(kind: String, id: String) -> bool:
	var table: Dictionary = _tables.get(kind, {})
	return table.has(id)


func all_of(kind: String) -> Array:
	var table: Dictionary = _tables.get(kind, {})
	return table.values()


## Localized string lookup with the §6.5 fallback chain: zh_HK -> zh_CN -> en.
func localize(field: Variant, requested_locale: String = "") -> String:
	if typeof(field) == TYPE_STRING:
		return field
	if typeof(field) != TYPE_DICTIONARY:
		return ""
	var table: Dictionary = field
	var order: Array[String] = [requested_locale, Settings.locale, "en"]
	for candidate in order:
		if table.has(candidate) and not String(table[candidate]).is_empty():
			return String(table[candidate])
	# Last resort: whatever locale is present, so nothing renders blank.
	for key in table.keys():
		return String(table[key])
	return ""
