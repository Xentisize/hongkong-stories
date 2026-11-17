extends CanvasLayer
## Touch controls for phones (docs/PLAN.md §12 P5): a virtual d-pad plus E / I buttons.
##
## Built only when the device reports a touchscreen — desktop and headless runs get an empty
## layer. Movement goes through Input.action_press/release so the player's existing
## Input.get_vector read stays untouched; the action buttons synthesize InputEventAction
## events, which travel the same _unhandled_input path the keyboard uses.

const BUTTON_SIZE := Vector2(34, 30)

var _dpad_actions := {
	"up": ["上", Vector2(36, 166), "move_up"],
	"down": ["下", Vector2(36, 200), "move_down"],
	"left": ["左", Vector2(2, 183), "move_left"],
	"right": ["右", Vector2(70, 183), "move_right"],
}


func _ready() -> void:
	name = "TouchControls"
	add_to_group("touch")
	layer = 80  # above the HUD, below the cutscene overlay (90) and dev console (100)
	if not DisplayServer.is_touchscreen_available():
		return
	for key in _dpad_actions:
		var entry: Array = _dpad_actions[key]
		_add_move_button(String(entry[0]), entry[1], String(entry[2]))
	_add_action_button("E", Vector2(344, 174), "ui_interact")
	_add_action_button("I", Vector2(346, 138), "ui_inventory")


func _add_move_button(label_text: String, at: Vector2, action: String) -> void:
	var button := _make_button(label_text, at)
	button.button_down.connect(func() -> void: Input.action_press(action))
	button.button_up.connect(func() -> void: Input.action_release(action))


func _add_action_button(label_text: String, at: Vector2, action: String) -> void:
	var button := _make_button(label_text, at)
	button.button_down.connect(func() -> void: _fire(action, true))


func _fire(action: String, pressed: bool) -> void:
	var event := InputEventAction.new()
	event.action = action
	event.pressed = pressed
	Input.parse_input_event(event)


func _make_button(label_text: String, at: Vector2) -> Button:
	var button := Button.new()
	button.text = label_text
	button.position = at
	button.size = BUTTON_SIZE
	button.focus_mode = Control.FOCUS_NONE
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.05, 0.06, 0.08, 0.55)
	style.border_color = Color(0.46, 0.42, 0.35, 0.7)
	style.set_border_width_all(1)
	style.set_content_margin_all(2)
	button.add_theme_stylebox_override("normal", style)
	button.add_theme_stylebox_override("hover", style)
	button.add_theme_stylebox_override("pressed", style)
	button.add_theme_font_size_override("font_size", 10)
	add_child(button)
	return button