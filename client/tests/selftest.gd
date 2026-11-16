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
