extends Node
## Effect interpreter (docs/PLAN.md §5.6).
##
## The ONLY way game state changes. The same effect list drives interactables, doors, item
## hooks, quest nodes and — from P2 — LLM-validated actions. That single funnel is what makes
## the per-NPC allowlist in §5.1 meaningful: there is exactly one door into the state.
##
## Implemented in P1: set_flag / give / take / var / say.
## TODO(P3): quest / goto / reveal_secret / open_shop / play_sfx / shake / fade.


## Returns how many effects actually applied.
func apply(effects: Array, context: Dictionary = {}) -> int:
	var applied := 0
	for raw in effects:
		if typeof(raw) != TYPE_DICTIONARY:
			push_warning("Effects: skipping non-dictionary effect %s" % [raw])
			continue
		var effect: Dictionary = raw
		if _apply_one(effect, context):
			applied += 1
			Bus.effect_applied.emit(effect)
	return applied


func _apply_one(effect: Dictionary, context: Dictionary) -> bool:
	var kind := String(effect.get("type", ""))

	match kind:
		"set_flag":
			var flag := String(effect.get("flag", ""))
			if flag.is_empty() or not _allow(context, "flags", flag):
				push_warning("Effects: flag '%s' not permitted here" % flag)
				return false
			Game.set_flag(flag, bool(effect.get("value", true)))
			return true

		"give":
			var give_id := String(effect.get("item", ""))
			if not _allow(context, "items", give_id):
				push_warning("Effects: item '%s' not permitted here" % give_id)
				return false
			return Game.add_item(give_id, int(effect.get("count", 1))) > 0

		"take":
			var take_id := String(effect.get("item", ""))
			return Game.remove_item(take_id, int(effect.get("count", 1))) > 0

		"var":
			var var_name := String(effect.get("name", ""))
			if var_name.is_empty():
				return false
			if String(effect.get("op", "add")) == "set":
				Game.set_var(var_name, float(effect.get("value", 0.0)))
			else:
				Game.add_var(var_name, float(effect.get("value", 0.0)))
			return true

		"say":
			var text := ContentDB.localize(effect.get("text", ""), Settings.locale)
			if text.is_empty():
				push_warning("Effects: 'say' has no text for locale %s" % Settings.locale)
				return false
			Bus.message_shown.emit(text)
			return true

		"quest", "goto", "reveal_secret", "open_shop", "play_sfx", "shake", "fade":
			push_warning("Effects: '%s' is not implemented until P3" % kind)
			return false

		_:
			push_warning("Effects: unknown effect type '%s'" % kind)
			return false


## Allowlist hook (P2 will pass `allow_items` / `allow_flags` from the NPC definition).
## Absent key means unrestricted — scripted content is trusted, model output is not.
func _allow(context: Dictionary, kind: String, id: String) -> bool:
	var key := "allow_" + kind
	if not context.has(key):
		return true
	var allowed: Array = context[key]
	return allowed.is_empty() or allowed.has(id)
