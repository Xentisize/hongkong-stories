extends CanvasLayer
## Minimal cutscene overlay for quest nodes of type "cutscene" (docs/PLAN.md §5.4): a
## full-screen dark panel with the node's localized text, advanced with the interact or
## accept key. Progression is owned by the Quests machine — dismissing simply reports back,
## which is when the node's on_complete effects apply and the quest advances.

var _panel: ColorRect
var _label: Label


func _ready() -> void:
	add_to_group("cutscene")
	layer = 90  # above the world and HUD chrome, below the dev console (100)
	Bus.cutscene_started.connect(_on_started)

	_panel = ColorRect.new()
	_panel.color = Color(0.02, 0.02, 0.03, 0.96)
	_panel.set_anchors_preset(Control.PRESET_FULL_RECT)
	_panel.visible = false
	add_child(_panel)

	var margin := MarginContainer.new()
	margin.set_anchors_preset(Control.PRESET_FULL_RECT)
	margin.add_theme_constant_override("margin_left", 24)
	margin.add_theme_constant_override("margin_right", 24)
	margin.add_theme_constant_override("margin_top", 24)
	margin.add_theme_constant_override("margin_bottom", 24)
	_panel.add_child(margin)

	_label = Label.new()
	_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	margin.add_child(_label)


func is_showing() -> bool:
	return _panel != null and _panel.visible


func _on_started(quest_id: String, node_id: String) -> void:
	_label.text = _node_text(quest_id, node_id)
	_panel.visible = true


func _unhandled_input(event: InputEvent) -> void:
	if not is_showing():
		return
	if event.is_action_pressed("ui_interact") or event.is_action_pressed("ui_accept"):
		_panel.visible = false
		get_viewport().set_input_as_handled()
		Quests.cutscene_dismissed()


func _node_text(quest_id: String, node_id: String) -> String:
	for raw in ContentDB.get_entity("quests", quest_id).get("nodes", []):
		var node: Dictionary = raw
		if String(node.get("id", "")) == node_id:
			var raw_text: Variant = node.get("text", "")
			var lines: Array = raw_text if typeof(raw_text) == TYPE_ARRAY else [raw_text]
			var parts: PackedStringArray = []
			for line in lines:
				var localized := ContentDB.localize(line, Settings.locale)
				if not localized.is_empty():
					parts.append(localized)
			return "\n\n".join(parts)
	return ""
