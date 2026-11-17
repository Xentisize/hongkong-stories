extends Node
## Player preferences and input registration (docs/PLAN.md §6.2, §6.5).

const SUPPORTED_LOCALES: PackedStringArray = ["zh_HK", "zh_CN", "en"]
const DEFAULT_LOCALE := "zh_HK"
const SETTINGS_PATH := "user://settings.cfg"

## Godot ships no CJK glyphs at all, so Chinese rendered with the default theme font is a wall
## of boxes. These are the OFL-1.1 Fusion Pixel faces (PLAN §6.5): zh_HK is default because
## written Cantonese needs Traditional + HKSCS, with zh_Hans as the fallback for Simplified.
## (Zpix was rejected: its licence is USD 1000 per commercial product.)
const FONT_HK := "res://assets/fonts/fusion-pixel-12px-monospaced-zh_hk.ttf"
const FONT_HANS := "res://assets/fonts/fusion-pixel-12px-monospaced-zh_hans.ttf"
const BASE_FONT_SIZE := 12

## Order matters: readable Chinese first, English last (§6.5).
const FALLBACK_ORDER: PackedStringArray = ["zh_HK", "zh_CN", "en"]

var locale: String = DEFAULT_LOCALE
var text_speed: float = 1.0
var master_volume: float = 1.0

var _config := ConfigFile.new()


func _ready() -> void:
	_install_theme()
	_load()
	register_input_actions()
	_apply_locale(resolve_locale(locale))


## Applies the CJK font chain to the whole UI at runtime, which is more explicit than a project
## setting and lets the pixel-specific TextServer flags be set in one place.
func _install_theme() -> void:
	var traditional := load(FONT_HK) as FontFile
	if traditional == null:
		push_error("Settings: CJK font missing at %s" % FONT_HK)
		return
	_harden_for_pixels(traditional)

	var simplified := load(FONT_HANS) as FontFile
	if simplified != null:
		_harden_for_pixels(simplified)
		# zh_HK first for Traditional/HKSCS, zh_Hans behind it for Simplified characters.
		traditional.fallbacks = [simplified]

	var theme := Theme.new()
	theme.default_font = traditional
	theme.default_font_size = BASE_FONT_SIZE
	get_tree().root.theme = theme


## A pixel font must not be smoothed: antialiasing and subpixel positioning turn 12px glyph
## edges into grey mush at 5x integer scale.
func _harden_for_pixels(font: FontFile) -> void:
	font.antialiasing = TextServer.FONT_ANTIALIASING_NONE
	font.hinting = TextServer.HINTING_NONE
	font.subpixel_positioning = TextServer.SUBPIXEL_POSITIONING_DISABLED
	font.multichannel_signed_distance_field = false


## Maps the OS/browser locale onto one of the three shipping locales (§6.5).
func resolve_locale(raw: String) -> String:
	var tag := raw.replace("-", "_")
	match tag:
		"zh_HK", "zh_MO", "zh_TW", "zh_Hant", "yue":
			return "zh_HK"
		"zh_CN", "zh_SG", "zh_Hans", "zh":
			return "zh_CN"
		"en", "en_US", "en_GB", "en_AU", "en_CA", "en_NZ":
			return "en"
	if SUPPORTED_LOCALES.has(tag):
		return tag
	# Anything unfamiliar falls back along the chain rather than guessing.
	for candidate in FALLBACK_ORDER:
		if tag.begins_with(candidate.split("_")[0]):
			return candidate
	return "en"


func set_locale(new_locale: String) -> void:
	if not SUPPORTED_LOCALES.has(new_locale):
		push_warning("Unsupported locale '%s'; ignoring." % new_locale)
		return
	_apply_locale(new_locale)
	_save()


func _apply_locale(new_locale: String) -> void:
	locale = new_locale
	TranslationServer.set_locale(new_locale)
	Bus.locale_changed.emit(new_locale)


## Movement actions are registered in code for P0 so the project boots without hand-edited
## InputEvent blocks in project.godot. Move these into the editor's Input Map once the
## project is open in the Godot editor (P1).
func register_input_actions() -> void:
	_add_action_with_keys("move_left", [KEY_A, KEY_LEFT])
	_add_action_with_keys("move_right", [KEY_D, KEY_RIGHT])
	_add_action_with_keys("move_up", [KEY_W, KEY_UP])
	_add_action_with_keys("move_down", [KEY_S, KEY_DOWN])
	_add_action_with_keys("ui_interact", [KEY_E, KEY_SPACE, KEY_ENTER])
	_add_action_with_keys("ui_inventory", [KEY_I, KEY_TAB])
	if not InputMap.has_action("dev_console"):
		InputMap.add_action("dev_console")
		var ev := InputEventKey.new()
		ev.physical_keycode = KEY_F1
		InputMap.action_add_event("dev_console", ev)


func _add_action_with_keys(action: String, keys: Array) -> void:
	if not InputMap.has_action(action):
		InputMap.add_action(action)
	for key in keys:
		var ev := InputEventKey.new()
		ev.physical_keycode = key
		# Avoid duplicates when the built-in action already binds this key (ui_left etc.).
		if not InputMap.action_has_event(action, ev):
			InputMap.action_add_event(action, ev)


func _load() -> void:
	if _config.load(SETTINGS_PATH) != OK:
		locale = resolve_locale(OS.get_locale())
		return
	locale = String(_config.get_value("general", "locale", DEFAULT_LOCALE))
	text_speed = float(_config.get_value("general", "text_speed", 1.0))
	master_volume = float(_config.get_value("audio", "master_volume", 1.0))


func _save() -> void:
	_config.set_value("general", "locale", locale)
	_config.set_value("general", "text_speed", text_speed)
	_config.set_value("audio", "master_volume", master_volume)
	_config.save(SETTINGS_PATH)
