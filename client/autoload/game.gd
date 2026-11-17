extends Node
## Serializable game state (docs/PLAN.md §6.2).
##
## Everything that must survive a save/load lives here and nowhere else. If a new
## subsystem needs persistent state, it adds a field here and a line in to_dict/from_dict
## — not its own save file.

const SCHEMA_VERSION := 1

var flags: Dictionary = {}          ## String -> bool
var vars: Dictionary = {}           ## String -> float
var inventory: Dictionary = {}      ## item_id -> count
var held_item: String = ""          ## the item currently carried in hand; "" = empty hands
var quests: Dictionary = {}         ## quest_id -> {"node": String, "done": bool}
var talk_counts: Dictionary = {}    ## npc_id -> int
var visited: Dictionary = {}        ## location_id -> true
var npc_memory: Dictionary = {}     ## npc_id -> {"summary": String, "turns": Array}

## Read by the `time_of_day` condition verb (§5.5). There is no day/night cycle (§13.1) —
## content or the dev console may set it; conditions only read it. Defaults to "day".
var time_of_day: String = "day"

var content_version: int = 0
var current_location: String = ""
var player_position: Vector2 = Vector2.ZERO
var playtime_sec: float = 0.0


func new_game() -> void:
	flags.clear()
	vars.clear()
	inventory.clear()
	held_item = ""
	quests.clear()
	talk_counts.clear()
	visited.clear()
	npc_memory.clear()
	time_of_day = "day"
	content_version = 0
	current_location = ""
	player_position = Vector2.ZERO
	playtime_sec = 0.0


## Marks the item the player carries in hand ("" puts it away). Holding something you do
## not own is refused — the item screen only offers owned items, so this is a guard against
## save corruption, not a UX flow.
func set_held(item_id: String) -> void:
	if not item_id.is_empty() and not has_item(item_id):
		return
	held_item = item_id
	Bus.held_changed.emit(item_id)


## Convenience accessors — marked thinking in P1 when the effect interpreter lands (§5.6).
func get_flag(flag: String) -> bool:
	return bool(flags.get(flag, false))


func set_flag(flag: String, value: bool) -> void:
	flags[flag] = value
	Bus.flag_set.emit(flag, value)


func get_var(var_name: String, fallback: float = 0.0) -> float:
	return float(vars.get(var_name, fallback))


## Typed accessor for one quest's save record; {} when the quest is unknown or corrupt.
## Effects and the Quests machine both go through here so a malformed save cannot crash them.
func quest_record(quest_id: String) -> Dictionary:
	var raw: Variant = quests.get(quest_id, {})
	return raw if typeof(raw) == TYPE_DICTIONARY else {}


func has_item(item_id: String, count: int = 1) -> bool:
	return int(inventory.get(item_id, 0)) >= count


func item_count(item_id: String) -> int:
	return int(inventory.get(item_id, 0))


## Returns how many were actually added (respects the item's stack_max, §5.2).
func add_item(item_id: String, count: int = 1) -> int:
	if item_id.is_empty() or count <= 0:
		return 0
	var current := item_count(item_id)
	var cap := _max_stack(item_id)
	var added := mini(count, cap - current)
	if added <= 0:
		return 0
	inventory[item_id] = current + added
	Bus.item_gained.emit(item_id, added)
	Bus.inventory_changed.emit()
	return added


func remove_item(item_id: String, count: int = 1) -> int:
	var current := item_count(item_id)
	var removed := mini(count, current)
	if removed <= 0:
		return 0
	if current - removed <= 0:
		inventory.erase(item_id)
	else:
		inventory[item_id] = current - removed
	Bus.item_lost.emit(item_id, removed)
	Bus.inventory_changed.emit()
	return removed


func _max_stack(item_id: String) -> int:
	var definition := ContentDB.get_entity("items", item_id)
	var stack_max := int(definition.get("stack_max", 0))
	return stack_max if stack_max > 0 else 999


func add_var(var_name: String, delta: float) -> void:
	set_var(var_name, get_var(var_name) + delta)


func set_var(var_name: String, value: float) -> void:
	vars[var_name] = value
	Bus.var_changed.emit(var_name, value)


func to_dict() -> Dictionary:
	return {
		"schema_version": SCHEMA_VERSION,
		"content_version": content_version,
		"flags": flags.duplicate(true),
		"vars": vars.duplicate(true),
		"inventory": inventory.duplicate(true),
		"held_item": held_item,
		"quests": quests.duplicate(true),
		"talk_counts": talk_counts.duplicate(true),
		"visited": visited.duplicate(true),
		"npc_memory": npc_memory.duplicate(true),
		"time_of_day": time_of_day,
		"current_location": current_location,
		"player_position": [player_position.x, player_position.y],
		"playtime_sec": playtime_sec,
	}


## Returns false if the payload is a schema this build cannot read (§5.7 migrations).
func from_dict(data: Dictionary) -> bool:
	var version := int(data.get("schema_version", 0))
	if version > SCHEMA_VERSION:
		push_error("Save schema %d is newer than this build (%d)" % [version, SCHEMA_VERSION])
		return false

	content_version = int(data.get("content_version", 0))
	flags = data.get("flags", {})
	vars = data.get("vars", {})
	inventory = data.get("inventory", {})
	quests = data.get("quests", {})
	talk_counts = data.get("talk_counts", {})
	visited = data.get("visited", {})
	npc_memory = data.get("npc_memory", {})
	time_of_day = String(data.get("time_of_day", "day"))
	current_location = String(data.get("current_location", ""))
	playtime_sec = float(data.get("playtime_sec", 0.0))
	# A save that lost the held item (or an older schema) starts with empty hands.
	held_item = String(data.get("held_item", ""))
	if not held_item.is_empty() and not has_item(held_item):
		held_item = ""

	var pos: Array = data.get("player_position", [0.0, 0.0])
	player_position = Vector2(float(pos[0]), float(pos[1]))
	return true


func _process(delta: float) -> void:
	playtime_sec += delta
