extends Node
## Dev console (docs/PLAN.md §6.2). F1 toggles a command bar that operates on real game state.
##
## This exists to make P1's exit criterion testable by hand — "the dev console sets a flag and
## a door opens" — and it is the fastest way to reproduce a bug report. It is the only place
## that reaches across systems by group name, which is acceptable precisely because it is
## debug-only.
##
## P1 commands: flag / give / take / var / tp / loc / save / load / newgame / locale / dump / help

const HISTORY_MAX_LINES := 8
const SELFTEST := preload("res://tests/selftest.gd")

## Set while the command bar is open; the player reads it to stop moving (Input polling
## bypasses the GUI, so a focused LineEdit alone is not enough).
var console_open: bool = false

var _layer: CanvasLayer
var _input: LineEdit
var _output: Label
var _lines: Array[String] = []


func _ready() -> void:
	# `godot --headless --path client -- --selftest` runs the P1 harness and exits with the
	# failure count, so CI can gate on it without a test framework.
	if OS.get_cmdline_user_args().has("--selftest"):
		_run_selftest.call_deferred()
		return

	_build()
	_layer.visible = false
	if OS.is_debug_build():
		print("[Dev] F1 opens the dev console")


func _run_selftest() -> void:
	var failures: int = await SELFTEST.run(get_tree())
	get_tree().quit(failures)


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("dev_console"):
		_toggle()
		get_viewport().set_input_as_handled()


func _toggle() -> void:
	console_open = not console_open
	_layer.visible = console_open
	if console_open:
		_input.grab_focus()
	else:
		_input.release_focus()


func _build() -> void:
	_layer = CanvasLayer.new()
	_layer.name = "DevConsoleLayer"
	_layer.layer = 100
	add_child(_layer)

	var panel := PanelContainer.new()
	panel.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE)
	panel.offset_left = 4
	panel.offset_right = -4
	panel.offset_top = -84
	panel.offset_bottom = -4
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.02, 0.02, 0.03, 0.94)
	style.border_color = Color(0.35, 0.85, 0.55, 0.9)
	style.set_border_width_all(1)
	style.set_content_margin_all(4)
	panel.add_theme_stylebox_override("panel", style)
	_layer.add_child(panel)

	var column := VBoxContainer.new()
	column.add_theme_constant_override("separation", 2)
	panel.add_child(column)

	_output = Label.new()
	_output.add_theme_font_size_override("font_size", 8)
	_output.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_output.custom_minimum_size = Vector2(0, 58)
	_output.vertical_alignment = VERTICAL_ALIGNMENT_BOTTOM
	column.add_child(_output)

	_input = LineEdit.new()
	_input.add_theme_font_size_override("font_size", 9)
	_input.placeholder_text = "help"
	_input.text_submitted.connect(_on_submit)
	column.add_child(_input)

	_print("dev console ready — type 'help'")


func _on_submit(text: String) -> void:
	_input.clear()
	_print("> %s" % text)
	var parts := text.strip_edges().split(" ", false)
	if parts.is_empty():
		return
	_run(String(parts[0]).to_lower(), parts.slice(1))


func _run(command: String, args: PackedStringArray) -> void:
	match command:
		"help":
			_print("flag <name> [0|1] · give <item> [n] · take <item> [n] · var <name> <v> · " +
				"tp <x> <y> · loc <id> · save [slot] · load [slot] · newgame · " +
				"locale <zh_HK|zh_CN|en> · dump")

		"flag":
			if args.is_empty():
				_print("usage: flag <name> [0|1]")
				return
			var on := true
			if args.size() > 1:
				on = String(args[1]) != "0" and String(args[1]).to_lower() != "false"
			Game.set_flag(String(args[0]), on)
			_print("%s = %s" % [args[0], str(on)])

		"give", "take":
			if args.is_empty():
				_print("usage: %s <item_id> [count]" % command)
				return
			var count := int(args[1]) if args.size() > 1 else 1
			var applied := Effects.apply([{"type": command, "item": String(args[0]), "count": count}])
			_print("%s %s x%d → %d applied (now x%d)" % [
				command, args[0], count, applied, Game.item_count(String(args[0])),
			])

		"var":
			if args.size() < 2:
				_print("usage: var <name> <value>")
				return
			Game.set_var(String(args[0]), float(args[1]))
			_print("%s = %s" % [args[0], str(Game.get_var(String(args[0])))])

		"tp":
			if args.size() < 2:
				_print("usage: tp <x> <y>")
				return
			get_tree().call_group("main", "dev_teleport", float(args[0]), float(args[1]))
			_print("teleported to %s,%s" % [args[0], args[1]])

		"loc":
			if args.is_empty():
				_print("usage: loc <location_id>")
				return
			get_tree().call_group("main", "load_location", String(args[0]))
			_print("loading location %s" % args[0])

		"save":
			var save_slot := int(args[0]) if not args.is_empty() else 1
			_print("save slot %d: %s" % [save_slot, "ok" if Save.save_game(save_slot) else "failed"])

		"load":
			var load_slot := int(args[0]) if not args.is_empty() else 1
			_print("load slot %d: %s" % [load_slot, "ok" if Save.load_game(load_slot) else "failed"])

		"newgame":
			Game.new_game()
			get_tree().call_group("main", "load_location", "loc_p1_shop")
			_print("new game")

		"locale":
			if args.is_empty():
				_print("usage: locale <zh_HK|zh_CN|en>")
				return
			Settings.set_locale(String(args[0]))
			_print("locale = %s" % Settings.locale)

		"dump":
			dump_state()
			_print("state dumped to stdout")

		_:
			_print("unknown command '%s' — try 'help'" % command)


func _print(line: String) -> void:
	_lines.append(line)
	while _lines.size() > HISTORY_MAX_LINES:
		_lines.pop_front()
	if _output != null:
		_output.text = "\n".join(_lines)


func dump_state() -> void:
	print("=== Game state ===")
	print(JSON.stringify(Game.to_dict(), "  "))
	print("content entities loaded: %d | locale: %s | save durable: %s" % [
		ContentDB.loaded_count, Settings.locale, Save.is_persistence_durable(),
	])
