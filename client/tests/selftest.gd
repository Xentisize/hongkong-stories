extends RefCounted
## P1 self-test harness (docs/PLAN.md §11).
##
##   godot --headless --path client -- --selftest      (exit code = number of failures)
##
## Why not gdUnit4 yet: what P1 needs to prove is a chain of state transitions (effect → save →
## reload → condition → door), and a harness with a real exit code proves that today. Adopting
## a framework is a P2 decision, and this file's assertions port over directly when it lands.

const ITEM := "item_rusty_key"
const LOCATION := "loc_p1_shop"
const SAVE_SLOT := 9
const DOOR_TILE := Vector2i(9, 11)
const ATLAS_DOOR := Vector2i(3, 0)
const ATLAS_FLOOR := Vector2i(0, 0)


class Checker:
	var count: int = 0
	var failures: int = 0

	func check(label: String, condition: bool) -> void:
		count += 1
		if condition:
			print("  ok    %s" % label)
		else:
			failures += 1
			print("  FAIL  %s" % label)


static func run(tree: SceneTree) -> int:
	print("[selftest] P1 core loop")
	var c := Checker.new()
	var original_locale := Settings.locale

	_test_content(c)
	_test_localization(c, original_locale)
	_test_effects_and_conditions(c)
	_test_p3_effects(c)
	_test_quest_machine(c)
	_test_shared_condition_fixtures(c)
	_test_font_coverage(c)
	_test_dialogue_fallback(c)
	_test_budget_ux(c)
	_test_npc_states(c)
	_test_audio(c)
	_test_touch(c, tree)
	_test_save_round_trip(c)
	_test_save_code(c)
	await _test_door_gating(c, tree)
	_test_interactable_gating(c, tree)

	Settings.set_locale(original_locale)
	print("[selftest] %d checks, %d failures" % [c.count, c.failures])
	return c.failures


static func _test_content(c: Checker) -> void:
	var item := ContentDB.get_entity("items", ITEM)
	c.check("content: item loaded from res://content", not item.is_empty())
	var location := ContentDB.get_entity("locations", LOCATION)
	c.check("content: location loaded from res://content", not location.is_empty())

	var names: Dictionary = item.get("name", {})
	c.check("content: item carries all three locales",
		names.has("zh_HK") and names.has("zh_CN") and names.has("en"))


static func _test_localization(c: Checker, _original: String) -> void:
	var item := ContentDB.get_entity("items", ITEM)
	var names: Variant = item.get("name", {})

	Settings.set_locale("en")
	c.check("locale: en resolves", ContentDB.localize(names) == "Rusty Key")
	Settings.set_locale("zh_CN")
	c.check("locale: zh_CN resolves (simplified glyphs)", ContentDB.localize(names) == "生锈钥匙")
	Settings.set_locale("zh_HK")
	c.check("locale: zh_HK resolves (cantonese form)", ContentDB.localize(names) == "生鏽鎖匙")


static func _test_effects_and_conditions(c: Checker) -> void:
	Game.new_game()

	var gained := {"count": 0}
	Bus.item_gained.connect(func(_id: String, n: int) -> void: gained["count"] += n)
	Effects.apply([{"type": "give", "item": ITEM, "count": 1}])
	c.check("effects: give puts the item in the inventory", Game.item_count(ITEM) == 1)
	c.check("effects: give emits item_gained", int(gained["count"]) == 1)

	Effects.apply([{"type": "give", "item": ITEM, "count": 1}])
	c.check("effects: stack_max clamps a second copy", Game.item_count(ITEM) == 1)

	var messages: Array[String] = []
	Bus.message_shown.connect(func(text: String) -> void: messages.append(text))
	Effects.apply([{"type": "say", "text": {"zh_HK": "粵文", "zh_CN": "简体", "en": "English"}}])
	c.check("effects: say localizes to the active locale",
		messages.size() == 1 and messages[0] == "粵文")

	c.check("effects: unknown effect is rejected, not applied",
		Effects.apply([{"type": "no_such_effect"}]) == 0)

	Game.set_flag("door_open", false)
	c.check("cond: flag false", not Conditions.evaluate({"flag": "door_open"}))
	Game.set_flag("door_open", true)
	c.check("cond: flag true", Conditions.evaluate({"flag": "door_open"}))
	c.check("cond: has_item", Conditions.evaluate({"has_item": ITEM}))
	c.check("cond: any() short-circuits true",
		Conditions.evaluate({"any": [{"flag": "absent"}, {"has_item": ITEM}]}))
	c.check("cond: all() fails on one false branch",
		not Conditions.evaluate({"all": [{"flag": "door_open"}, {"flag": "absent"}]}))
	c.check("cond: not()", Conditions.evaluate({"not": {"flag": "absent"}}))

	Game.set_var("trust", 3.0)
	c.check("cond: var >=", Conditions.evaluate({"var": "trust", "op": ">=", "value": 3}))
	c.check("cond: var < is false", not Conditions.evaluate({"var": "trust", "op": "<", "value": 3}))
	Game.visited[LOCATION] = true
	c.check("cond: visited", Conditions.evaluate({"visited": LOCATION}))
	Game.talk_counts["npc_x"] = 2
	c.check("cond: talked min 2", Conditions.evaluate({"talked": "npc_x", "min": 2}))
	c.check("cond: talked min 3 is false", not Conditions.evaluate({"talked": "npc_x", "min": 3}))


## P3 effects: navigation, secrets, shop, presentation. The bus signals prove the §5.6
## contract (every applied effect is observable); nobody is listening in headless mode,
## which is exactly what makes these assertions possible.
static func _test_p3_effects(c: Checker) -> void:
	Game.new_game()

	var gotos: Array = []
	Bus.goto_requested.connect(func(location: String, spawn: String) -> void:
		gotos.append([location, spawn]))
	c.check("effects: goto emits a navigation request",
		Effects.apply([{"type": "goto", "location": "loc_somewhere", "spawn": "south"}]) == 1
			and gotos.size() == 1 and gotos[0][0] == "loc_somewhere" and gotos[0][1] == "south")

	var secrets: Array = []
	Bus.secret_revealed.connect(func(_npc: String, secret_id: String, _text: String) -> void:
		secrets.append(secret_id))
	c.check("effects: reveal_secret applies with npc context",
		Effects.apply([{"type": "reveal_secret", "secret": "s_crate"}],
			{"npc": "npc_p2_shopkeeper"}) == 1
			and secrets.size() == 1 and Game.get_flag("secret_s_crate"))
	c.check("effects: reveal_secret without an npc is refused",
		Effects.apply([{"type": "reveal_secret", "secret": "s_crate"}]) == 0)

	c.check("effects: open_shop / play_sfx / shake / fade apply",
		Effects.apply([
			{"type": "open_shop", "npc": "npc_x"},
			{"type": "play_sfx", "name": "chime"},
			{"type": "shake"},
			{"type": "fade", "to": "out"},
		]) == 4)
	c.check("effects: fade rejects a bogus direction",
		Effects.apply([{"type": "fade", "to": "sideways"}]) == 0)


## The P3 exit criterion in miniature: start -> condition-gated advance -> cutscene pause ->
## dismissal -> completion, plus entry_requirements gating a second quest (§5.4). The node
## machine re-evaluates synchronously on the signals that change state, so no frame awaits.
static func _test_quest_machine(c: Checker) -> void:
	Game.new_game()

	var cutscenes: Array = []
	Bus.cutscene_started.connect(func(quest_id: String, node_id: String) -> void:
		cutscenes.append([quest_id, node_id]))
	var completions: Array = []
	Bus.quest_completed.connect(func(quest_id: String) -> void: completions.append(quest_id))

	c.check("quest: advance on an unstarted quest is refused",
		Effects.apply([{"type": "quest", "quest": "q_test_nope", "op": "advance", "node": "n2"}]) == 0)
	c.check("quest: the gated quest refuses to start early",
		Effects.apply([{"type": "quest", "quest": "q_test_gated", "op": "start"}]) == 0)

	c.check("quest: the chain starts on its first node",
		Effects.apply([{"type": "quest", "quest": "q_test_chain", "op": "start"}]) == 1
			and String(Game.quest_record("q_test_chain").get("node", "")) == "n1")
	c.check("quest: starting a started quest is a no-op",
		Effects.apply([{"type": "quest", "quest": "q_test_chain", "op": "start"}]) == 1)

	Game.set_flag("test_gate", true)
	c.check("quest: passing n1's condition advances to n2",
		String(Game.quest_record("q_test_chain").get("node", "")) == "n2")

	Effects.apply([{"type": "give", "item": ITEM, "count": 1}])
	c.check("quest: the item condition completes n2 and runs its effects",
		String(Game.quest_record("q_test_chain").get("node", "")) == "n3"
			and Game.get_flag("test_n2_done"))
	c.check("quest: the cutscene node opened the overlay request",
		cutscenes.size() == 1 and cutscenes[0][0] == "q_test_chain" and cutscenes[0][1] == "n3")
	c.check("quest: a cutscene node does not auto-advance",
		String(Game.quest_record("q_test_chain").get("node", "")) == "n3")

	Quests.cutscene_dismissed()
	c.check("quest: dismissal applies on_complete and moves to n4",
		String(Game.quest_record("q_test_chain").get("node", "")) == "n4"
			and Game.get_flag("test_n3_done"))

	Game.set_flag("test_final", true)
	c.check("quest: the last node completes the quest",
		bool(Game.quest_record("q_test_chain").get("done", false)) and completions.size() == 1)

	c.check("quest: the gated quest starts once its requirement is done",
		Effects.apply([{"type": "quest", "quest": "q_test_gated", "op": "start"}]) == 1)
	Game.set_flag("test_gate2", true)
	c.check("quest: the gated quest completes",
		bool(Game.quest_record("q_test_gated").get("done", false)))


static func _test_save_round_trip(c: Checker) -> void:
	Game.new_game()
	Effects.apply([{"type": "give", "item": ITEM, "count": 1}])
	Game.set_flag("round_trip_flag", true)
	Game.current_location = LOCATION
	Game.player_position = Vector2(228, 228)

	c.check("save: writes slot %d" % SAVE_SLOT, Save.save_game(SAVE_SLOT))
	Game.new_game()
	c.check("save: new_game clears the inventory", Game.item_count(ITEM) == 0)
	c.check("save: reads slot %d" % SAVE_SLOT, Save.load_game(SAVE_SLOT))
	c.check("save: item survived the reload", Game.item_count(ITEM) == 1)
	c.check("save: flag survived the reload", Game.get_flag("round_trip_flag"))
	c.check("save: player position survived the reload",
		Game.player_position.is_equal_approx(Vector2(228, 228)))
	Save.delete_save(SAVE_SLOT)


## Audio (§5.3, §5.6): no assets exist yet, so the contract is graceful silence — a missing
## name is counted once, never spammed, and nothing errors. When OGG files land this test
## stays green and the game simply starts sounding.
static func _test_audio(c: Checker) -> void:
	c.check("audio: autoload carries music + sfx players", Audio.get_child_count() == 2)
	var before := Audio.missing_count
	Bus.sfx_requested.emit("selftest_no_such_sfx")
	c.check("audio: missing sfx counted", Audio.missing_count == before + 1)
	Bus.sfx_requested.emit("selftest_no_such_sfx")
	c.check("audio: missing name warned once, not per call", Audio.missing_count == before + 1)
	Bus.sfx_requested.emit("")
	c.check("audio: empty name is a no-op", Audio.missing_count == before + 1)
	# The synthesized ambience is real now: a location with `music` must resolve to a
	# looping stream, and switching locations must swap it.
	Audio._on_location("loc_ssp_market_street")
	c.check("audio: location music resolves to a stream", Audio.current_music_stream() != null)
	c.check("audio: ambience loops for a seamless bed",
		Audio.current_music_stream() is AudioStreamWAV
		and (Audio.current_music_stream() as AudioStreamWAV).loop_mode == AudioStreamWAV.LOOP_FORWARD)
	Audio._on_location("loc_ssp_flat")
	c.check("audio: switching locations swaps the stream", Audio.current_music_stream() != null)


## Interactable gating (§5.5): a prop whose `requires` fails stays hidden until the story
## reaches it — driven here by flipping a flag directly, the same signal path the bus uses.
static func _test_interactable_gating(c: Checker, tree: SceneTree) -> void:
	Game.new_game()
	var location := LocationRoot.new()
	tree.root.add_child(location)
	location.build(ContentDB.get_entity("locations", LOCATION))

	c.check("gating: props built", location.interactables.size() >= 1)
	if location.interactables.is_empty():
		location.queue_free()
		return
	var prop := location.interactables[0] as LocationInteractable
	prop._requires = {"flag": "selftest_gate"}
	prop.call("refresh_availability")
	c.check("gating: prop hidden while its condition fails",
		not prop.is_available() and not prop.visible)
	Game.set_flag("selftest_gate", true)
	prop.call("refresh_availability")
	c.check("gating: prop appears when its condition passes",
		prop.is_available() and prop.visible)
	location.queue_free()


## NPC event pages (RPG Maker lessons, §5.1): the offline ladder follows the active state —
## base lines until a state's condition passes, that state's lines after.
static func _test_npc_states(c: Checker) -> void:
	var npc := {
		"scripted_fallback": {"lines": [ {"text": {"en": "base line"}} ]},
		"states": [
			{"requires": {"flag": "selftest_state"}, "fallback_lines": [ {"text": {"en": "state line"}} ]},
		],
	}
	var base: Array = Dialogue._fallback_lines_for(npc)
	c.check("states: base ladder while no condition passes",
		String((base[0] as Dictionary).get("text", {}).get("en", "")) == "base line")
	Game.set_flag("selftest_state", true)
	var paged: Array = Dialogue._fallback_lines_for(npc)
	c.check("states: state ladder once its condition passes",
		String((paged[0] as Dictionary).get("text", {}).get("en", "")) == "state line")
	Game.set_flag("selftest_state", false)


## P6 budget UX: a spent budget (session or per-IP day) announces itself exactly once —
## localized toast via message_shown — then the scripted ladder keeps playing.
static func _test_budget_ux(c: Checker) -> void:
	Dialogue.active_npc = "npc_p2_shopkeeper"
	Dialogue.using_fallback = false
	# Counted through an Array on purpose: GDScript lambdas capture scalars BY VALUE, so an
	# int counter inside the lambda would never reach the outer scope.
	var toasts: Array = []
	var listener := func(text: String) -> void: toasts.append(text)
	Bus.message_shown.connect(listener)
	Net.chat_error.emit("budget_exceeded")
	Net.chat_error.emit("budget_exceeded")
	Bus.message_shown.disconnect(listener)
	c.check("budget: exhausted notice shown exactly once", toasts.size() == 1)
	c.check("budget: one-time flag set", Dialogue._exhausted_notified)
	Dialogue._exhausted_notified = false
	Dialogue.active_npc = ""


## Touch controls (§12 P5): built only on touch devices — desktop and headless runs get an
## empty layer, so the assertion tracks whatever the running display reports.
static func _test_touch(c: Checker, tree: SceneTree) -> void:
	var scene := tree.current_scene
	var controls := scene.find_child("TouchControls", true, false) if scene != null else null
	c.check("touch: layer exists under Main", controls != null)
	if controls != null:
		var expected := 6 if DisplayServer.is_touchscreen_available() else 0
		c.check("touch: buttons match the display type", controls.get_child_count() == expected)


## Save-code round trip (§6.4): the copyable code must carry the FULL payload — flags,
## items, quest records — and refuse mangled input without corrupting anything.
static func _test_save_code(c: Checker) -> void:
	Game.new_game()
	Effects.apply([{"type": "give", "item": ITEM, "count": 1}])
	Game.set_flag("code_flag", true)
	Game.current_location = LOCATION
	Game.quests["q_test_chain"] = {"node": "n2", "done": false}

	var code := Save.export_code(1)
	c.check("save code: produced", not code.is_empty())

	Game.new_game()
	c.check("save code: new_game cleared the flag", not Game.get_flag("code_flag"))
	c.check("save code: import applies", Save.import_code(code))
	c.check("save code: flag survived", Game.get_flag("code_flag"))
	c.check("save code: item survived", Game.item_count(ITEM) == 1)
	c.check("save code: quest record survived",
		String(Game.quest_record("q_test_chain").get("node", "")) == "n2")
	c.check("save code: location survived", Game.current_location == LOCATION)
	c.check("save code: mangled text refuses", not Save.import_code("!!!not-base64!!!"))
	c.check("save code: truncated code refuses", not Save.import_code(code.substr(0, 8)))


static func _test_door_gating(c: Checker, tree: SceneTree) -> void:
	Game.new_game()
	var location := LocationRoot.new()
	tree.root.add_child(location)
	location.build(ContentDB.get_entity("locations", LOCATION))
	await tree.process_frame

	c.check("door: built with the location", location.doors.size() == 1)
	if location.doors.is_empty():
		location.queue_free()
		return

	var door := location.doors[0] as LocationDoor
	c.check("door: blocked initially", door.is_available())
	c.check("door: shows door art before opening",
		location.get_tile_at(DOOR_TILE) == ATLAS_DOOR)

	door.interact()
	c.check("door: stays shut with neither key nor flag",
		door.is_available() and location.get_tile_at(DOOR_TILE) == ATLAS_DOOR)

	# The P1 exit criterion: a flag set elsewhere (dev console) opens the door.
	Game.set_flag("door_open", true)
	door.interact()
	c.check("door: opens when its condition passes", not door.is_available())
	c.check("door: tile swapped to floor art",
		location.get_tile_at(DOOR_TILE) == ATLAS_FLOOR)
	c.check("door: recorded its open flag", Game.get_flag("shop_door_opened"))

	# Reloading the location must not resurrect a door the player already opened.
	var rebuilt := LocationRoot.new()
	tree.root.add_child(rebuilt)
	rebuilt.build(ContentDB.get_entity("locations", LOCATION))
	await tree.process_frame
	c.check("door: stays open after a location rebuild",
		rebuilt.get_tile_at(DOOR_TILE) == ATLAS_FLOOR)

	location.queue_free()
	rebuilt.queue_free()


## Runs the SAME fixture table as packages/core's condition test (§5.5, §11). The two
## evaluators are only trustworthy while they agree, so this table is the contract.
static func _test_shared_condition_fixtures(c: Checker) -> void:
	var fixture := _read_json("res://tests/fixtures/conditions.json")
	var cases: Array = fixture.get("cases", [])
	c.check("fixtures: table loaded", not cases.is_empty())

	for entry in cases:
		var case: Dictionary = entry
		var state: Dictionary = case.get("state", {})

		Game.new_game()
		Game.flags = state.get("flags", {})
		Game.inventory = state.get("inventory", {})
		Game.held_item = String(state.get("held_item", ""))
		Game.vars = state.get("vars", {})
		Game.visited = state.get("visited", {})
		Game.talk_counts = state.get("talk_counts", {})
		Game.quests = state.get("quests", {})
		Game.time_of_day = String(state.get("time_of_day", "day"))

		var got := Conditions.evaluate(case.get("condition"), {})
		c.check("fixture: %s" % String(case.get("label", "?")), got == bool(case.get("expected", false)))


## Font coverage (§6.5, §11), the GDScript twin of tools/check_font_coverage.ts. Without this a
## missing glyph ships as a blank box, the game looks broken, and nobody notices until a player
## screenshots it.
static func _test_font_coverage(c: Checker) -> void:
	var fonts: Array[Font] = []
	for path in [Settings.FONT_HK, Settings.FONT_HANS]:
		var font := load(path) as Font
		if font != null:
			fonts.append(font)
	c.check("font: both CJK faces load", fonts.size() == 2)
	if fonts.is_empty():
		return

	# A font that loads but is never applied is exactly the bug the player saw: every Chinese
	# string rendered as boxes. So assert the theme is on the root window too.
	var root_theme: Theme = (Engine.get_main_loop() as SceneTree).root.theme
	c.check("font: theme installed on the root window",
		root_theme != null and root_theme.default_font != null)
	if root_theme != null and root_theme.default_font != null:
		c.check("font: active theme face is the CJK font",
			root_theme.default_font.resource_path.contains("fusion-pixel"))
		c.check("font: active size is the 12px design grid",
			root_theme.default_font_size >= 12)

	var missing: Dictionary = {}
	for text in _content_strings():
		for index in text.length():
			var code := text.unicode_at(index)
			if code < 0x80:
				continue
			var found := false
			for font in fonts:
				if font.has_char(code):
					found = true
					break
			if not found:
				missing[code] = text[index]

	c.check("font: every authored character is renderable", missing.is_empty())
	if not missing.is_empty():
		print("  missing codepoints: ", missing.keys())

	# Generated dialogue is open-vocabulary, so the Cantonese particle set matters most.
	var probe := "嘅咗喺哋嗰冇嘢嚟咁佢哋唔係"
	var probe_missing := ""
	for index in probe.length():
		var code := probe.unicode_at(index)
		var found := false
		for font in fonts:
			if font.has_char(code):
				found = true
				break
		if not found:
			probe_missing += probe[index]
	c.check("font: cantonese particles covered", probe_missing.is_empty())
	if not probe_missing.is_empty():
		print("  probe missing: ", probe_missing)


static func _content_strings() -> Array[String]:
	var out: Array[String] = []
	for kind in ["npcs", "items", "locations", "quests"]:
		for entity in ContentDB.all_of(kind):
			_collect_strings(entity, out)
	return out


static func _collect_strings(node: Variant, out: Array[String]) -> void:
	match typeof(node):
		TYPE_DICTIONARY:
			var dictionary: Dictionary = node
			for key in dictionary.keys():
				_collect_strings(dictionary[key], out)
		TYPE_ARRAY:
			for item in node:
				_collect_strings(item, out)
		TYPE_STRING:
			out.append(String(node))
		_:
			pass


## The offline path (§7.4): with the backend unreachable the game must still talk. This drives
## the ladder directly rather than through a socket, so it cannot go green by accident when a
## local server happens to be running.
static func _test_dialogue_fallback(c: Checker) -> void:
	var spoken: Array[String] = []
	Bus.npc_spoke.connect(func(_npc: String, text: String) -> void: spoken.append(text))

	Dialogue.active_npc = "npc_p2_shopkeeper"
	Dialogue._pending_input = ""
	Dialogue._fallback_line()
	c.check("fallback: greeting is used before any input",
		spoken.size() == 1 and not spoken[0].is_empty())

	Dialogue._pending_input = "你好"
	Dialogue._fallback_line()
	c.check("fallback: a later turn moves to the next scripted line",
		spoken.size() == 2 and spoken[1] != spoken[0])
	c.check("fallback: is flagged as fallback", Dialogue.using_fallback)

	# Every locale must produce text, or a player switching language loses the NPC entirely.
	for locale in ["zh_HK", "zh_CN", "en"]:
		Settings.set_locale(locale)
		var before := spoken.size()
		Dialogue._pending_input = ""
		Dialogue._fallback_line()
		c.check("fallback: greeting exists in %s" % locale,
			spoken.size() == before + 1 and not spoken[before].is_empty())

	Settings.set_locale("zh_HK")
	Dialogue.close()
	Dialogue.using_fallback = false


## Live mode: `--live-chat`. Needs the backend; excluded from the default run so the suite
## stays hermetic.
static func run_live_chat(tree: SceneTree) -> int:
	print("[selftest] live chat against %s" % Net.base_url)
	var c := Checker.new()

	var chunks: Array[String] = []
	var finished := {"text": ""}
	Dialogue.line_chunk.connect(func(text: String) -> void: chunks.append(text))
	Dialogue.line_finished.connect(func(text: String) -> void: finished["text"] = text)

	await Net.start_session()
	c.check("live: session acquired", not Net.session_token.is_empty())
	c.check("live: budget granted", Net.budget > 0)

	var started := Time.get_ticks_msec()
	Dialogue.open("npc_p2_shopkeeper")

	while finished["text"].is_empty() and Time.get_ticks_msec() - started < 20000:
		await tree.process_frame

	var elapsed := float(Time.get_ticks_msec() - started) / 1000.0
	c.check("live: reply received", not finished["text"].is_empty())
	c.check("live: arrived as chunks, not one blob", chunks.size() >= 1)
	c.check("live: used the model, not the scripted fallback", not Dialogue.using_fallback)
	c.check("live: budget was charged", Net.remaining < Net.budget or Net.remaining == 0)

	print("  reply in %.2fs: %s" % [elapsed, finished["text"]])
	Dialogue.close()
	print("[selftest] live chat: %d checks, %d failures" % [c.count, c.failures])
	return c.failures


## Dual-path JSON read, matching ContentDB: an exported build may keep `.json` as an imported
## resource rather than a raw file.
static func _read_json(path: String) -> Dictionary:
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
