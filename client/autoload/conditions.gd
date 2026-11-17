extends Node
## Condition mini-language evaluator (docs/PLAN.md §5.5).
##
## One recursive evaluator, used for NPC triggers, doors/exits, quest objectives, secret
## reveals and interactables. Its Python twin (P4, for admin-side "would this pass?") must
## agree with this file on a shared fixture table (§11) — divergence silently corrupts quest
## progression, so anything added here needs a matching fixture.
##
## Implemented in P1: all / any / not / flag / has_item / var / visited / talked.
## Added in P3: quest_state / quest_done / time_of_day.

const COMPARISONS := ["==", "!=", ">", ">=", "<", "<="]


func evaluate(condition: Variant, _context: Dictionary = {}) -> bool:
	# Absent condition means "no requirement", which is the common case for doors and props.
	if condition == null:
		return true
	if typeof(condition) != TYPE_DICTIONARY:
		push_warning("Conditions: expected a Dictionary, got type %d" % typeof(condition))
		return false

	var cond: Dictionary = condition
	if cond.is_empty():
		return true

	if cond.has("all"):
		for sub in cond["all"]:
			if not evaluate(sub):
				return false
		return true

	if cond.has("any"):
		for sub in cond["any"]:
			if evaluate(sub):
				return true
		return false

	if cond.has("not"):
		return not evaluate(cond["not"])

	if cond.has("flag"):
		# `{"flag": "x"}` means "is set"; `{"flag": "x", "value": false}` means "is not set".
		var expected := bool(cond.get("value", true))
		return Game.get_flag(String(cond["flag"])) == expected

	if cond.has("has_item"):
		return Game.has_item(String(cond["has_item"]), int(cond.get("count", 1)))

	if cond.has("var"):
		return _compare(
			Game.get_var(String(cond["var"])),
			String(cond.get("op", ">=")),
			float(cond.get("value", 0.0)),
		)

	if cond.has("visited"):
		return bool(Game.visited.get(String(cond["visited"]), false))

	if cond.has("talked"):
		var count := int(Game.talk_counts.get(String(cond["talked"]), 0))
		return count >= int(cond.get("min", 1))

	if cond.has("quest_state"):
		# `{"quest_state": "ch01", "node": "n2"}` — started, not done, and sitting on n2.
		# Without `node`, it just asks whether the quest is active. NOTE: get() WITHOUT a
		# default — an unknown quest must be null, never an empty record that reads as
		# "active" (the shared fixture caught exactly that divergence).
		var qs_raw: Variant = Game.quests.get(String(cond["quest_state"]))
		if typeof(qs_raw) != TYPE_DICTIONARY:
			return false
		var qs_record: Dictionary = qs_raw
		if bool(qs_record.get("done", false)):
			return false
		var wanted_node := String(cond.get("node", ""))
		return wanted_node.is_empty() or String(qs_record.get("node", "")) == wanted_node

	if cond.has("quest_done"):
		var qd_raw: Variant = Game.quests.get(String(cond["quest_done"]))
		if typeof(qd_raw) != TYPE_DICTIONARY:
			return false
		return bool((qd_raw as Dictionary).get("done", false))

	if cond.has("time_of_day"):
		return Game.time_of_day == String(cond["time_of_day"])

	push_warning("Conditions: unknown condition %s" % [cond.keys()])
	return false


func _compare(left: float, op: String, right: float) -> bool:
	if not COMPARISONS.has(op):
		push_warning("Conditions: unknown comparison '%s'" % op)
		return false
	match op:
		"==":
			return is_equal_approx(left, right)
		"!=":
			return not is_equal_approx(left, right)
		">":
			return left > right
		">=":
			return left >= right
		"<":
			return left < right
		_:
			return left <= right
