extends Node
## Condition mini-language evaluator (docs/PLAN.md §5.5).
##
## One recursive evaluator, used for NPC triggers, doors/exits, quest objectives, secret
## reveals and interactables. Its Python twin (P4, for admin-side "would this pass?") must
## agree with this file on a shared fixture table (§11) — divergence silently corrupts quest
## progression, so anything added here needs a matching fixture.
##
## Implemented in P1: all / any / not / flag / has_item / var / visited / talked.
## TODO(P3): quest_state / quest_done / time_of_day.

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

	if cond.has("quest_state") or cond.has("quest_done") or cond.has("time_of_day"):
		push_warning("Conditions: verb not implemented until P3: %s" % [cond.keys()])
		return false

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
