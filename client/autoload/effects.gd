extends Node
## Effect interpreter (docs/PLAN.md §5.6).
##
## The ONLY way game state changes. The same effect list drives interactables, doors, item
## hooks, quest nodes and — from P2 — LLM-validated actions. That single funnel is what makes
## the per-NPC allowlist in §5.1 meaningful: there is exactly one door into the state.
##
## Implemented in P1: set_flag / give / take / var / say.
## Added in P3: quest / goto / reveal_secret / open_shop / play_sfx / shake / fade.


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

		"quest":
			return _apply_quest(effect)

		"goto":
			Bus.goto_requested.emit(
				String(effect.get("location", "")), String(effect.get("spawn", "default")))
			return true

		"reveal_secret":
			return _apply_reveal_secret(effect, context)

		"open_shop":
			var shop_npc := String(effect.get("npc", context.get("npc", "")))
			if shop_npc.is_empty():
				push_warning("Effects: 'open_shop' has no npc")
				return false
			Bus.shop_opened.emit(shop_npc)
			return true

		"play_sfx":
			# Presentation only (§5.6); there is no audio pipeline yet, so this surfaces as a
			# bus signal a future audio layer can consume.
			Bus.sfx_requested.emit(String(effect.get("name", "")))
			return true

		"shake":
			Bus.shake_requested.emit(float(effect.get("strength", 4.0)), float(effect.get("time", 0.25)))
			return true

		"fade":
			var direction := String(effect.get("to", "out"))
			if direction != "out" and direction != "in":
				push_warning("Effects: 'fade' direction must be 'out' or 'in', got '%s'" % direction)
				return false
			Bus.fade_requested.emit(direction, float(effect.get("time", 0.4)))
			return true

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


func _quest_record(quest_id: String) -> Dictionary:
	return Game.quest_record(quest_id)


## `{"type":"quest","quest":<id>,"op":"start|advance|complete","node":<id>}` (§5.6).
## Quest state lives in Game.quests; the node machine (Quests.gd) listens to the emitted
## signals and drives complete_when / on_complete from there.
func _apply_quest(effect: Dictionary) -> bool:
	var quest_id := String(effect.get("quest", ""))
	var op := String(effect.get("op", "start"))
	var definition := ContentDB.get_entity("quests", quest_id)
	if definition.is_empty():
		push_warning("Effects: unknown quest '%s'" % quest_id)
		return false

	if op == "start":
		if Game.quests.has(quest_id):
			return true  # already started; starting twice is a no-op
		var entry: Variant = definition.get("entry_requires")
		if entry != null and not Conditions.evaluate(entry):
			push_warning("Effects: quest '%s' entry requirements not met" % quest_id)
			return false
		var nodes: Array = definition.get("nodes", [])
		var first := String(nodes[0].get("id", "")) if not nodes.is_empty() else ""
		if first.is_empty():
			push_warning("Effects: quest '%s' has no nodes" % quest_id)
			return false
		Game.quests[quest_id] = {"node": first, "done": false}
		Bus.quest_updated.emit(quest_id, first)
		return true

	if op == "advance":
		var record := _quest_record(quest_id)
		if record.is_empty() or bool(record.get("done", false)):
			push_warning("Effects: cannot advance quest '%s'" % quest_id)
			return false
		var node := String(effect.get("node", ""))
		if node.is_empty():
			push_warning("Effects: 'advance' needs a node id")
			return false
		record["node"] = node
		Bus.quest_updated.emit(quest_id, node)
		return true

	if op == "complete":
		var record := _quest_record(quest_id)
		if record.is_empty():
			push_warning("Effects: cannot complete unstarted quest '%s'" % quest_id)
			return false
		if bool(record.get("done", false)):
			return true  # idempotent
		record["done"] = true
		Bus.quest_updated.emit(quest_id, String(record.get("node", "")))
		Bus.quest_completed.emit(quest_id)
		return true

	push_warning("Effects: unknown quest op '%s'" % op)
	return false


## `{"type":"reveal_secret","npc":<id>,"secret":<id>}`. From a validated model action the npc
## is the speaking character, passed through `context` by Dialogue (the model's action carries
## only the secret id); scripted content names the npc explicitly. The reveal is recorded as
## `secret_<id>` so it survives a save and can gate later conditions (§5.6 observability).
func _apply_reveal_secret(effect: Dictionary, context: Dictionary) -> bool:
	var npc_id := String(effect.get("npc", context.get("npc", "")))
	var secret_id := String(effect.get("secret", ""))
	if npc_id.is_empty() or secret_id.is_empty():
		push_warning("Effects: 'reveal_secret' needs an npc and a secret id")
		return false
	var npc := ContentDB.get_entity("npcs", npc_id)
	var secret: Dictionary = {}
	for entry in npc.get("secrets", []):
		var candidate: Dictionary = entry
		if String(candidate.get("id", "")) == secret_id:
			secret = candidate
			break
	if secret.is_empty():
		push_warning("Effects: npc '%s' has no secret '%s'" % [npc_id, secret_id])
		return false
	var text := ContentDB.localize(secret.get("text", ""), Settings.locale)
	Game.set_flag("secret_" + secret_id, true)
	Bus.secret_revealed.emit(npc_id, secret_id, text)
	Bus.message_shown.emit(text)
	return true
