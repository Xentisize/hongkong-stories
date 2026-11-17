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
	_test_shared_condition_fixtures(c)
	_test_font_coverage(c)
	_test_dialogue_fallback(c)
	_test_save_round_trip(c)
	await _test_door_gating(c, tree)

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


## Runs the SAME fixture table as server/tests/test_conditions.py (§5.5, §11). The two
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
		Game.vars = state.get("vars", {})
		Game.visited = state.get("visited", {})
		Game.talk_counts = state.get("talk_counts", {})

		var got := Conditions.evaluate(case.get("condition"), {})
		c.check("fixture: %s" % String(case.get("label", "?")), got == bool(case.get("expected", false)))


## Font coverage (§6.5, §11), the GDScript twin of tools/check_font_coverage.py. Without this a
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
