extends Control
## Dialogue box (docs/PLAN.md §6.3, §7.4).
##
## Renders exactly what arrives on the wire: chunks are appended as they stream, so there is no
## fake per-character animation while waiting for the first token. The only thing shown before
## the first chunk is a thinking indicator, which is honest — the model really is thinking.
##
## The panel owns no conversation logic. Everything comes from Dialogue's signals, which is
## what lets the scripted fallback look identical to a streamed reply.

const UI_TEXT := {
	"thinking": { "zh_HK": "……", "zh_CN": "……", "en": "…" },
	"placeholder": {
		"zh_HK": "打字覆佢，Enter 送出",
		"zh_CN": "打字回复，Enter 送出",
		"en": "Type a reply, Enter to send",
	},
	"hint": { "zh_HK": "Esc 離開", "zh_CN": "Esc 离开", "en": "Esc to leave" },
}

var _panel: PanelContainer
var _avatar: TextureRect
var _name_label: Label
var _text_label: Label
var _input: LineEdit
var _hint_label: Label
var _busy: bool = false


func _ready() -> void:
	_build()
	Dialogue.conversation_opened.connect(_on_opened)
	Dialogue.line_started.connect(_on_line_started)
	Dialogue.line_chunk.connect(_on_chunk)
	Dialogue.line_finished.connect(_on_finished)
	Dialogue.conversation_closed.connect(_on_closed)
	Bus.locale_changed.connect(func(_locale: String) -> void: _refresh_texts())
	visible = false
	_refresh_texts()


func _unhandled_input(event: InputEvent) -> void:
	if not visible:
		return
	if event.is_action_pressed("ui_cancel"):
		Dialogue.close()
		get_viewport().set_input_as_handled()


func _t(key: String) -> String:
	return ContentDB.localize(UI_TEXT.get(key, key), Settings.locale)


func _build() -> void:
	_panel = PanelContainer.new()
	_panel.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_WIDE)
	_panel.offset_left = 4
	_panel.offset_right = -4
	# The content (name + text + input + hint) needs ~108px; sizing the panel to it and
	# growing UPWARD keeps the input on-screen — the old 80px panel overflowed past the
	# screen edge and cut the hint (reported).
	_panel.offset_top = -112
	_panel.offset_bottom = -4
	_panel.grow_vertical = Control.GROW_DIRECTION_BEGIN

	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.04, 0.045, 0.055, 0.94)
	style.border_color = Color(0.72, 0.66, 0.52, 0.95)
	style.set_border_width_all(1)
	style.set_content_margin_all(5)
	_panel.add_theme_stylebox_override("panel", style)
	add_child(_panel)

	# RPG Maker's classic framing (lessons, #3): the avatar sits LEFT of the text column.
	# Portraits are generated per NPC (art/npcs/<id>_portrait.png); NPCs without one hide
	# the slot and the layout collapses back to text-only.
	var body := HBoxContainer.new()
	body.add_theme_constant_override("separation", 6)
	_panel.add_child(body)

	_avatar = TextureRect.new()
	_avatar.custom_minimum_size = Vector2(64, 88)
	_avatar.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_avatar.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
	_avatar.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	_avatar.visible = false
	body.add_child(_avatar)

	var column := VBoxContainer.new()
	column.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	column.add_theme_constant_override("separation", 2)
	body.add_child(column)

	_name_label = Label.new()
	_name_label.add_theme_font_size_override("font_size", 12)
	_name_label.add_theme_color_override("font_color", Color(0.94, 0.86, 0.66))
	column.add_child(_name_label)

	# CJK needs 12px and a taller line; this label is the one place every generated character
	# appears, so it sets the panel's metrics (PLAN §6.5).
	_text_label = Label.new()
	_text_label.add_theme_font_size_override("font_size", 12)
	_text_label.autowrap_mode = TextServer.AUTOWRAP_ARBITRARY
	_text_label.custom_minimum_size = Vector2(0, 34)
	_text_label.vertical_alignment = VERTICAL_ALIGNMENT_TOP
	column.add_child(_text_label)

	_input = LineEdit.new()
	_input.add_theme_font_size_override("font_size", 12)
	_input.text_submitted.connect(_on_submitted)
	column.add_child(_input)

	_hint_label = Label.new()
	_hint_label.add_theme_font_size_override("font_size", 12)
	_hint_label.add_theme_color_override("font_color", Color(0.62, 0.60, 0.56))
	column.add_child(_hint_label)


func _refresh_texts() -> void:
	_input.placeholder_text = _t("placeholder")
	_hint_label.text = _t("hint")


func _on_opened(npc_id: String, display_name: String) -> void:
	_name_label.text = display_name
	_avatar.texture = ContentDB.art_texture("art/npcs/%s_portrait.png" % npc_id)
	_avatar.visible = _avatar.texture != null
	_text_label.text = _t("thinking")
	_input.text = ""
	_input.editable = false
	visible = true
	_input.grab_focus()


func _on_line_started(_npc_id: String) -> void:
	_busy = true
	_text_label.text = _t("thinking")
	_input.editable = false
	_input.grab_focus()


func _on_chunk(text: String) -> void:
	# First chunk replaces the indicator; later chunks append.
	if _busy and _text_label.text == _t("thinking"):
		_text_label.text = ""
	_text_label.text += text


func _on_finished(_text: String) -> void:
	_busy = false
	# Mood consumption (P6+): the model declares one of seven moods per reply; the avatar
	# tints subtly so the emotion is felt, not stated. Offline replies stay neutral.
	var moods := {
		"neutral": Color(1, 1, 1), "warm": Color(1.0, 0.93, 0.82),
		"gruff": Color(0.82, 0.82, 0.86), "wistful": Color(0.82, 0.87, 0.95),
		"amused": Color(1.0, 0.97, 0.85), "wary": Color(0.88, 0.95, 0.88),
		"sad": Color(0.78, 0.84, 0.95),
	}
	_avatar.modulate = moods.get(Dialogue.last_mood, Color(1, 1, 1))
	_input.editable = true
	_input.grab_focus()


func _on_closed(_npc_id: String) -> void:
	_busy = false
	visible = false
	_input.release_focus()


func _on_submitted(text: String) -> void:
	var line := text.strip_edges()
	if line.is_empty() or _busy:
		return
	_input.clear()
	# The player's own line is echoed so the exchange reads as a conversation rather than a
	# monologue; the backend receives the same text as `input`.
	_text_label.text = ""
	Dialogue.say(line)
