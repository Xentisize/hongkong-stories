extends CanvasLayer
## Title screen (docs/PLAN.md §6.5 locale offer, §12): the cover — identity, locale choice,
## start. Shown at boot and reopened with Esc whenever no conversation is open, which makes
## it the settings surface: locale switching lives here and persists through Settings.
##
## The player's movement gate reads is_showing() via the "title" group, exactly like the
## cutscene overlay — nothing walks behind the cover.

const LOCALES := [
	["zh_HK", "粵語"],
	["zh_CN", "简体中文"],
	["en", "English"],
]

const UI_TEXT := {
	"tagline": {
		"zh_HK": "2027年出發，行返過去。",
		"zh_CN": "从2027年出发，走回过去。",
		"en": "Start in 2027. Walk backward.",
	},
	"start": { "zh_HK": "開始", "zh_CN": "开始", "en": "Start" },
	"resume": { "zh_HK": "繼續", "zh_CN": "继续", "en": "Resume" },
	"locale_hint": {
		"zh_HK": "語言：隨時喺呢度轉。",
		"zh_CN": "语言：随时在这里切换。",
		"en": "Language: switch here any time.",
	},
}

var _panel: ColorRect
var _tagline: Label
var _start: Button
var _locale_buttons: Array[Button] = []


func _ready() -> void:
	add_to_group("title")
	layer = 110  # covers everything, including the dev console, while it is up
	_build()
	Bus.locale_changed.connect(func(_locale: String) -> void: _refresh_texts())
	_refresh_texts()


func is_showing() -> bool:
	return _panel != null and _panel.visible


func open() -> void:
	_refresh_texts()
	_panel.visible = true


func close() -> void:
	_panel.visible = false


func _build() -> void:
	_panel = ColorRect.new()
	_panel.color = Color(0.04, 0.045, 0.055, 0.98)
	_panel.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(_panel)

	# The cute cover: a generated chibi street corner behind a soft dim — the scene sells
	# the game's warmth while the text stays readable.
	var backdrop := TextureRect.new()
	backdrop.texture = ContentDB.art_texture("art/backdrops/title_cute.png")
	if backdrop.texture != null:
		backdrop.texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
		backdrop.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		backdrop.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED
		backdrop.set_anchors_preset(Control.PRESET_FULL_RECT)
		_panel.add_child(backdrop)
		var dim := ColorRect.new()
		dim.color = Color(0.04, 0.045, 0.055, 0.55)
		dim.set_anchors_preset(Control.PRESET_FULL_RECT)
		_panel.add_child(dim)

	var column := VBoxContainer.new()
	column.set_anchors_preset(Control.PRESET_FULL_RECT)
	column.alignment = BoxContainer.ALIGNMENT_CENTER
	column.add_theme_constant_override("separation", 10)
	_panel.add_child(column)

	var title := Label.new()
	title.text = "香港故事"
	title.add_theme_font_size_override("font_size", 24)  # exact 2x of the 12px design grid
	title.add_theme_color_override("font_color", Color(0.99, 0.93, 0.8))
	title.add_theme_color_override("font_shadow_color", Color(0.55, 0.25, 0.2, 0.85))
	title.add_theme_constant_override("shadow_offset_x", 2)
	title.add_theme_constant_override("shadow_offset_y", 2)
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	column.add_child(title)

	var subtitle := Label.new()
	subtitle.text = "HONG KONG STORIES"
	subtitle.add_theme_font_size_override("font_size", 12)
	subtitle.add_theme_color_override("font_color", Color(0.72, 0.66, 0.52))
	subtitle.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	column.add_child(subtitle)

	_tagline = Label.new()
	_tagline.add_theme_font_size_override("font_size", 12)
	_tagline.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	column.add_child(_tagline)

	var spacer := Control.new()
	spacer.custom_minimum_size = Vector2(0, 6)
	column.add_child(spacer)

	var locale_hint := Label.new()
	locale_hint.add_theme_font_size_override("font_size", 10)
	locale_hint.add_theme_color_override("font_color", Color(0.62, 0.60, 0.56))
	locale_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	locale_hint.text = _t("locale_hint")
	column.add_child(locale_hint)

	var locale_row := HBoxContainer.new()
	locale_row.alignment = BoxContainer.ALIGNMENT_CENTER
	locale_row.add_theme_constant_override("separation", 6)
	for entry in LOCALES:
		var button := Button.new()
		button.text = entry[1]
		button.focus_mode = Control.FOCUS_NONE
		_style_cute(button, false)
		button.pressed.connect(_on_locale.bind(entry[0]))
		locale_row.add_child(button)
		_locale_buttons.append(button)
	column.add_child(locale_row)

	var start_wrap := CenterContainer.new()
	_start = Button.new()
	_start.custom_minimum_size = Vector2(150, 24)
	_start.focus_mode = Control.FOCUS_NONE
	_style_cute(_start, true)
	_start.pressed.connect(close)
	start_wrap.add_child(_start)
	column.add_child(start_wrap)


## Rounded, warm buttons — the cute register in one place: soft cream fill, warm border,
## a slightly lifted hover.
func _style_cute(button: Button, primary: bool) -> void:
	var normal := _cute_style(Color(0.16, 0.17, 0.2, 0.92) if not primary else Color(0.47, 0.3, 0.24, 0.95))
	var hover := _cute_style(Color(0.24, 0.26, 0.31, 0.95) if not primary else Color(0.58, 0.38, 0.3, 0.98))
	var pressed := _cute_style(Color(0.11, 0.12, 0.14, 1.0) if not primary else Color(0.4, 0.25, 0.2, 1.0))
	button.add_theme_stylebox_override("normal", normal)
	button.add_theme_stylebox_override("hover", hover)
	button.add_theme_stylebox_override("pressed", pressed)
	button.add_theme_color_override("font_color", Color(0.95, 0.92, 0.85))


func _cute_style(bg: Color) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = bg
	style.set_corner_radius_all(6)
	style.set_border_width_all(1)
	style.border_color = Color(0.72, 0.66, 0.52, 0.9)
	style.content_margin_left = 10
	style.content_margin_right = 10
	style.content_margin_top = 4
	style.content_margin_bottom = 4
	return style


func _t(key: String) -> String:
	return ContentDB.localize(UI_TEXT.get(key, key), Settings.locale)


func _refresh_texts() -> void:
	_tagline.text = _t("tagline")
	_start.text = _t("start")
	_mark_active()


func _mark_active() -> void:
	for i in _locale_buttons.size():
		var active: bool = String(LOCALES[i][0]) == Settings.locale
		_locale_buttons[i].add_theme_color_override(
			"font_color",
			Color(0.48, 0.79, 0.50) if active else Color(0.85, 0.83, 0.78),
		)


func _on_locale(locale: String) -> void:
	Settings.set_locale(locale)  # persists (user://settings.cfg) + emits locale_changed


func _unhandled_input(event: InputEvent) -> void:
	if not event.is_action_pressed("ui_cancel"):
		return
	if Dialogue.is_active():
		return  # the dialogue box owns Esc while a conversation is open
	if is_showing():
		close()
	else:
		open()
	get_viewport().set_input_as_handled()