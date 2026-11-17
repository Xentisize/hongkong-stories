extends Node
## Audio (docs/PLAN.md §5.3 music, §5.6 play_sfx): looping location music + one-shot sfx.
##
## There are no audio assets yet — every lookup goes through ResourceLoader.exists and a miss
## is counted once per name instead of spammed, so the game runs fully silent until OGG files
## land in client/assets/audio/ and content starts referencing them. The contract: content
## `music` / sfx values are pack-relative names ("audio/kln_1955.ogg"); bundled files live
## under res://assets/audio/ with the same relative name.

const MUSIC_DB := -12.0
const SFX_DB := -6.0

var missing_count: int = 0

var _music: AudioStreamPlayer
var _sfx: AudioStreamPlayer
var _current_music: String = ""
var _warned: Dictionary = {}


func _ready() -> void:
	_music = AudioStreamPlayer.new()
	_music.name = "Music"
	_music.volume_db = MUSIC_DB
	add_child(_music)
	_sfx = AudioStreamPlayer.new()
	_sfx.name = "Sfx"
	_sfx.volume_db = SFX_DB
	add_child(_sfx)
	Bus.location_entered.connect(_on_location)
	Bus.sfx_requested.connect(_on_sfx)


func _resolve(path: String) -> AudioStream:
	for candidate in ["res://assets/%s" % path, "res://content/%s" % path]:
		if ResourceLoader.exists(candidate, "AudioStream"):
			return load(candidate)
	if not _warned.has(path):
		_warned[path] = true
		missing_count += 1
	return null


func _on_location(location_id: String) -> void:
	var definition := ContentDB.get_entity("locations", location_id)
	var music := String(definition.get("music", ""))
	if music.is_empty() or music == _current_music:
		return
	var stream := _resolve(music)
	if stream == null:
		return
	_current_music = music
	if stream is AudioStreamOggVorbis:
		stream.loop = true
	_music.stream = stream
	_music.play()


func _on_sfx(sfx_name: String) -> void:
	if sfx_name.is_empty():
		return
	var stream := _resolve(sfx_name)
	if stream == null:
		return
	_sfx.stream = stream
	_sfx.play()