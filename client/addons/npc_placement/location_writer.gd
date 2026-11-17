extends RefCounted
class_name NpcPlacementWriter
## The JSON write-back core for the NPC-placement plugin (docs/PLAN.md §9.1).
##
## Kept as a plain RefCounted with no editor dependencies so the headless selftest can
## exercise the exact code the dock uses: merge placements into a location JSON's `npcs`
## array (matched by npc id) and write the file back. The @tool dock only supplies UI.

## Merge `placements` ({npc, tile, facing}) into the location JSON at `json_path` — an
## authoring copy may live anywhere (the selftest uses user://), while the dock passes the
## pack path under client/content/. Returns {"written": n, "added": n, "path": path}.
static func write_npc_placements(json_path: String, placements: Array) -> Dictionary:
	var file := FileAccess.open(json_path, FileAccess.READ)
	if file == null:
		return {"error": "cannot read %s" % json_path}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	if typeof(parsed) != TYPE_DICTIONARY:
		return {"error": "not a JSON object: %s" % json_path}

	var data: Dictionary = parsed
	var existing: Array = data.get("npcs", [])
	var by_id: Dictionary = {}
	for placement in existing:
		if typeof(placement) == TYPE_DICTIONARY:
			by_id[String(placement.get("npc", ""))] = placement

	var written := 0
	var added := 0
	for raw in placements:
		if typeof(raw) != TYPE_DICTIONARY:
			continue
		var npc_id := String(raw.get("npc", ""))
		if npc_id.is_empty():
			continue
		var placement: Dictionary = {
			"npc": npc_id,
			"tile": [int(raw.get("tile_x", 0)), int(raw.get("tile_y", 0))],
			"facing": String(raw.get("facing", "down")),
		}
		if by_id.has(npc_id):
			var target: Dictionary = by_id[npc_id]
			target["tile"] = placement["tile"]
			target["facing"] = placement["facing"]
			written += 1
		else:
			existing.append(placement)
			by_id[npc_id] = placement
			added += 1
	data["npcs"] = existing

	var out := FileAccess.open(json_path, FileAccess.WRITE)
	if out == null:
		return {"error": "cannot write %s" % json_path}
	out.store_string(JSON.stringify(data, "\t") + "\n")
	out.close()
	return {"written": written, "added": added, "path": json_path}


## Full-location write-back for the map editor (RPG Maker lessons, #1): tiles, NPC
## placements and interactable placements are replaced wholesale from the editor state —
## the editor loaded the file first, so it is the source of truth for everything it shows.
## Doors are preserved untouched: the grid editor cannot express rect doors faithfully yet.
static func write_location(json_path: String, tilemap: Array, npcs: Array, interactables: Array) -> Dictionary:
	var file := FileAccess.open(json_path, FileAccess.READ)
	if file == null:
		return {"error": "cannot read %s" % json_path}
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	file.close()
	if typeof(parsed) != TYPE_DICTIONARY:
		return {"error": "not a JSON object: %s" % json_path}

	var data: Dictionary = parsed
	data["tilemap"] = tilemap
	data["npcs"] = npcs
	data["interactables"] = interactables

	var out := FileAccess.open(json_path, FileAccess.WRITE)
	if out == null:
		return {"error": "cannot write %s" % json_path}
	out.store_string(JSON.stringify(data, "\t") + "\n")
	out.close()
	return {"written": true, "path": json_path}