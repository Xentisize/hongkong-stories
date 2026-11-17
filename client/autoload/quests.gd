extends Node
## Quest node machine (docs/PLAN.md §5.4).
##
## Quest state lives in Game.quests and is only mutated through Effects' `quest` op, which
## emits Bus.quest_updated / quest_completed. This autoload is the listener that makes §5.6's
## "quests re-evaluate without polling" real: on any state change (flag, variable, item, talk
## count, location) the active quest's current node re-evaluates its complete_when, applies
## its on_complete effects, and advances to `next`. A cutscene node does not auto-complete —
## it waits for CutsceneUI to report the player's dismissal.
##
## Re-evaluation is synchronous with a re-entrancy guard: applying on_complete emits new
## signals, which mark the pass dirty instead of recursing; the pass loops until no node
## progresses (bounded, so a content cycle fails loudly instead of hanging).

const MAX_ROUNDS := 16

var _in_pass: bool = false
var _dirty: bool = false
var _awaiting_cutscene: Dictionary = {}  ## {"quest": String, "node": String}


func _ready() -> void:
	Bus.flag_set.connect(func(_f: String, _v: bool) -> void: _schedule())
	Bus.var_changed.connect(func(_n: String, _v: float) -> void: _schedule())
	Bus.item_gained.connect(func(_i: String, _c: int) -> void: _schedule())
	Bus.item_lost.connect(func(_i: String, _c: int) -> void: _schedule())
	Bus.location_entered.connect(func(_l: String) -> void: _schedule())
	# Dialogue.open bumps talk_counts before it emits this, so `talked` conditions re-run.
	Bus.dialogue_started.connect(func(_n: String) -> void: _schedule())
	Bus.quest_updated.connect(func(_q: String, _n: String) -> void: _schedule())


func _schedule() -> void:
	if _in_pass:
		_dirty = true
		return
	_run_pass()


## Called by CutsceneUI when the player finishes the current cutscene node.
func cutscene_dismissed() -> void:
	if _awaiting_cutscene.is_empty():
		return
	var quest_id := String(_awaiting_cutscene.get("quest", ""))
	var node_id := String(_awaiting_cutscene.get("node", ""))
	_awaiting_cutscene = {}
	var node := _node_def(quest_id, node_id)
	if not node.is_empty():
		_complete_node(quest_id, node)
	_run_pass()


func _run_pass() -> void:
	if _in_pass:
		_dirty = true
		return
	_in_pass = true
	_dirty = false
	var rounds := 0
	var progressed := true
	while progressed and rounds < MAX_ROUNDS:
		rounds += 1
		progressed = false
		for quest_id in Game.quests.keys():
			if _advance_quest(String(quest_id)):
				progressed = true
	_in_pass = false
	if _dirty:
		_run_pass()  # state changed mid-pass; one more bounded pass settles it


func _advance_quest(quest_id: String) -> bool:
	var record := Game.quest_record(quest_id)
	if record.is_empty() or bool(record.get("done", false)):
		return false
	var node := _node_def(quest_id, String(record.get("node", "")))
	if node.is_empty():
		push_warning("Quests: quest '%s' points at an unknown node" % quest_id)
		return false
	if String(node.get("type", "objective")) == "cutscene":
		return false  # waits for the player (CutsceneUI -> cutscene_dismissed)
	var gate: Variant = node.get("complete_when")
	if gate == null or typeof(gate) != TYPE_DICTIONARY or (gate as Dictionary).is_empty():
		return false  # no condition, no auto-advance — content must be explicit
	if not Conditions.evaluate(gate):
		return false
	_complete_node(quest_id, node)
	return true


func _complete_node(quest_id: String, node: Dictionary) -> void:
	var rewards: Variant = node.get("on_complete", [])
	if rewards == null:
		rewards = []
	if typeof(rewards) == TYPE_ARRAY:
		Effects.apply(rewards, {"quest": quest_id})
	# on_complete may itself have touched this quest — re-read before advancing.
	var record := Game.quest_record(quest_id)
	if record.is_empty() or bool(record.get("done", false)):
		return
	var next := String(node.get("next", ""))
	if next.is_empty():
		record["done"] = true
		Bus.quest_completed.emit(quest_id)
		return
	record["node"] = next
	Bus.quest_updated.emit(quest_id, next)
	var next_node := _node_def(quest_id, next)
	if not next_node.is_empty() and String(next_node.get("type", "")) == "cutscene":
		_awaiting_cutscene = {"quest": quest_id, "node": next}
		Bus.cutscene_started.emit(quest_id, next)


func _node_def(quest_id: String, node_id: String) -> Dictionary:
	for raw in ContentDB.get_entity("quests", quest_id).get("nodes", []):
		var node: Dictionary = raw
		if String(node.get("id", "")) == node_id:
			return node
	return {}
