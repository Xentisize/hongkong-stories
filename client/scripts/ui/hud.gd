extends Control
## P1 HUD: interaction prompt, message toast, inventory panel, FPS (docs/PLAN.md §6.3).
##
## One node for now; it splits into PromptUI / InventoryUI / DialogueUI in P2 when the
## conversation UI lands, which is why the signal wiring is already separate from the layout.
##
## TODO(P2): the three UI strings below move into `content/i18n/ui.csv` and TranslationServer
## (§6.5). They are inline here only because CSV import is not wired yet — keeping them in one
## table at least means the move is mechanical.

const UI_TEXT := {
	"inventory_title": { "zh_HK": "物品", "zh_CN": "物品", "en": "Inventory" },
	"inventory_empty": { "zh_HK": "（袋裡面冇嘢）", "zh_CN": "（袋子是空的）", "en": "(nothing yet)" },
	"fps": { "zh_HK": "幀/秒", "zh_CN": "帧/秒", "en": "FPS" },
}

var _fps_label: Label
var _prompt_label: Label
var _message_label: Label
var _panel: PanelContainer
var _title_label: Label
var _list: VBoxContainer

var _message_timer: float = 0.0


func _ready() -> void:
	_build()
	Bus.message_shown.connect(_on_message)
	Bus.inventory_changed.connect(_refresh_inventory)
	Bus.locale_changed.connect(func(_locale: String) -> void: _refresh_texts())
	_refresh_texts()
	_refresh_inventory()


func _process(delta: float) -> void:
	_fps_label.text = "%d %s" % [Engine.get_frames_per_second(), _t("fps")]
	_update_prompt()
	if _message_timer > 0.0:
		_message_timer -= delta
		if _message_timer <= 0.0:
			_message_label.visible = false


func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("ui_inventory"):
		_panel.visible = not _panel.visible
		get_viewport().set_input_as_handled()


func _t(key: String) -> String:
	return ContentDB.localize(UI_TEXT.get(key, key), Settings.locale)


func _build() -> void:
	_fps_label = _make_label(9)
	_fps_label.set_anchors_and_offsets_preset(Control.PRESET_TOP_LEFT)
	_fps_label.offset_left = 4
	_fps_label.offset_top = 2
	_fps_label.offset_right = 120
	_fps_label.offset_bottom = 14
	add_child(_fps_label)

	_message_label = _make_label(10)
	_message_label.set_anchors_and_offsets_preset(Control.PRESET_TOP_WIDE)
	_message_label.offset_left = 10
	_message_label.offset_right = -10
	_message_label.offset_top = 18
	_message_label.offset_bottom = 52
	_message_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_message_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_message_label.vertical_alignment = VERTICAL_ALIGNMENT_TOP
	_message_label.visible = false
	add_child(_message_label)

	_prompt_label = _make_label(10)
	_prompt_label.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE)
	_prompt_label.offset_left = 8
	_prompt_label.offset_right = -8
	_prompt_label.offset_top = -20
	_prompt_label.offset_bottom = -4
	_prompt_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_prompt_label.visible = false
	add_child(_prompt_label)

	_panel = PanelContainer.new()
	_panel.set_anchors_and_offsets_preset(Control.PRESET_TOP_LEFT)
	_panel.offset_left = 4
	_panel.offset_top = 16
	_panel.custom_minimum_size = Vector2(150, 0)
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.055, 0.065, 0.08, 0.9)
	style.border_color = Color(0.46, 0.42, 0.35, 0.95)
	style.set_border_width_all(1)
	style.set_content_margin_all(4)
	_panel.add_theme_stylebox_override("panel", style)
	_panel.visible = false
	add_child(_panel)

	var column := VBoxContainer.new()
	column.add_theme_constant_override("separation", 3)
	_panel.add_child(column)

	_title_label = _make_label(10)
	column.add_child(_title_label)

	_list = VBoxContainer.new()
	_list.add_theme_constant_override("separation", 2)
	column.add_child(_list)


func _make_label(font_size: int) -> Label:
	var label := Label.new()
	label.add_theme_font_size_override("font_size", font_size)
	return label


func _update_prompt() -> void:
	var player := get_tree().get_first_node_in_group("player")
	var text := ""
	if player != null and player.has_method("get_prompt_text"):
		text = String(player.call("get_prompt_text"))
	_prompt_label.text = text
	_prompt_label.visible = not text.is_empty()


func _on_message(text: String) -> void:
	_message_label.text = text
	_message_label.visible = true
	# Long lines need longer on screen: ~15 chars/second plus a floor of 2s.
	_message_timer = maxf(2.0, float(text.length()) / 15.0) + 1.0


func _refresh_texts() -> void:
	_title_label.text = _t("inventory_title")
	_refresh_inventory()


func _refresh_inventory() -> void:
	if _list == null:
		return
	for child in _list.get_children():
		child.queue_free()

	if Game.inventory.is_empty():
		var empty_label := _make_label(9)
		empty_label.text = _t("inventory_empty")
		_list.add_child(empty_label)
		return

	var ids := Game.inventory.keys()
	ids.sort()
	for id in ids:
		_list.add_child(_make_row(String(id), int(Game.inventory[id])))


func _make_row(item_id: String, count: int) -> Control:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 4)

	var definition := ContentDB.get_entity("items", item_id)
	var icon_path := String(definition.get("icon", ""))
	if not icon_path.is_empty() and ResourceLoader.exists(icon_path):
		var icon := TextureRect.new()
		icon.texture = load(icon_path)
		icon.custom_minimum_size = Vector2(16, 16)
		icon.stretch_mode = TextureRect.STRETCH_KEEP_CENTERED
		row.add_child(icon)

	var label := _make_label(9)
	var item_name := ContentDB.localize(definition.get("name", item_id), Settings.locale)
	label.text = "%s  x%d" % [item_name if not item_name.is_empty() else item_id, count]
	row.add_child(label)
	return row
