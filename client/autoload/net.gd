extends Node
## Backend proxy client (docs/PLAN.md §3, §7.1).
##
## The client never talks to OpenRouter. A wasm bundle is fully inspectable, so a key in it is
## a published key — this node only knows the URL of our own server, which owns the key, the
## prompts, the budget and the action allowlists.
##
## Streaming uses WebSocketPeer because Godot's HTTPRequest cannot stream; that constraint is
## the reason the chat protocol is a socket at all (§7.1).
##
## Timeouts are measured, not guessed: a real end-to-end turn returned its first token in
## 3.11s (zh_HK, json mode, cold). PLAN §7.4's original 2.5s budget would have fired the
## fallback on a perfectly healthy cold start, so first-token is 9s here and the *connect*
## deadline stays tight at 4s — a dead backend must still degrade fast.

signal session_ready(budget: int, model: String)
signal session_failed(code: String)
signal chat_token(text: String)
signal chat_done(result: Dictionary)
signal chat_error(code: String)

const DEFAULT_BASE_URL := "http://127.0.0.1:8000"
const CONNECT_TIMEOUT_SEC := 4.0
const FIRST_TOKEN_TIMEOUT_SEC := 9.0
const TURN_TIMEOUT_SEC := 30.0

var base_url: String = DEFAULT_BASE_URL
var session_token: String = ""
var budget: int = 0
var remaining: int = 0
var last_error: String = ""

var _http: HTTPRequest = null
var _pack_http: HTTPRequest = null
var _ws: WebSocketPeer = null
var _pending_frame: Dictionary = {}
var _frame_sent: bool = false
var _first_token_seen: bool = false
var _finished: bool = false
var _elapsed: float = 0.0


func _ready() -> void:
	base_url = String(ProjectSettings.get_setting("hk_stories/api_base_url", DEFAULT_BASE_URL))
	# Desktop-only convenience; a web build cannot read env vars and uses the project setting.
	if OS.has_environment("HK_STORIES_API"):
		base_url = OS.get_environment("HK_STORIES_API")

	_http = HTTPRequest.new()
	_http.name = "SessionHTTP"
	_http.timeout = 10.0
	add_child(_http)

	_pack_http = HTTPRequest.new()
	_pack_http.name = "ContentPackHTTP"
	_pack_http.timeout = 10.0
	add_child(_pack_http)


func chat_url() -> String:
	var url := base_url
	if url.begins_with("https://"):
		url = "wss://" + url.substr(8)
	elif url.begins_with("http://"):
		url = "ws://" + url.substr(7)
	return url + "/v1/chat"


func is_busy() -> bool:
	return _ws != null


## Creates an anonymous session and its token budget. Safe to call repeatedly.
func start_session() -> void:
	if not session_token.is_empty():
		return

	var err := _http.request(
		base_url + "/v1/session",
		["Content-Type: application/json"],
		HTTPClient.METHOD_POST,
		"{}",
	)
	if err != OK:
		_fail_session("http_%d" % err)
		return

	var response: Array = await _http.request_completed
	var result_code := int(response[0])
	var status := int(response[1])
	var body: PackedByteArray = response[3]

	if result_code != HTTPRequest.RESULT_SUCCESS or status != 200:
		_fail_session("session_%d_%d" % [result_code, status])
		return

	var parsed: Variant = JSON.parse_string(body.get_string_from_utf8())
	if typeof(parsed) != TYPE_DICTIONARY:
		_fail_session("session_bad_json")
		return

	var session: Dictionary = parsed
	session_token = String(session.get("session_token", ""))
	budget = int(session.get("budget", 0))
	remaining = int(session.get("remaining", budget))
	if session_token.is_empty():
		_fail_session("session_empty_token")
		return
	session_ready.emit(budget, String(session.get("model", "")))


## Opens a socket, sends the start frame, and streams the reply through signals.
func request_turn(frame: Dictionary) -> void:
	if is_busy():
		return
	_pending_frame = frame
	_frame_sent = false
	_first_token_seen = false
	_finished = false
	_elapsed = 0.0

	_ws = WebSocketPeer.new()
	var err := _ws.connect_to_url(chat_url())
	if err != OK:
		_fail("ws_connect_%d" % err)


func _process(delta: float) -> void:
	if _ws == null:
		return

	_elapsed += delta
	_ws.poll()
	var state := _ws.get_ready_state()

	# Drain BEFORE judging the state. The server sends the `done` frame and closes the socket
	# in the same tick, so payload and close frame arrive between two polls: checking
	# STATE_CLOSED first threw away successful replies and turned every turn into a fallback.
	if state == WebSocketPeer.STATE_OPEN and not _frame_sent:
		_frame_sent = true
		_ws.send_text(JSON.stringify(_pending_frame))

	while _ws != null and _ws.get_available_packet_count() > 0:
		_handle_packet(_ws.get_packet().get_string_from_utf8())
	if _ws == null:
		return

	match state:
		WebSocketPeer.STATE_CLOSED:
			if not _finished:
				_fail("ws_closed_early")
			else:
				_cleanup()
			return
		WebSocketPeer.STATE_CONNECTING:
			if _elapsed > CONNECT_TIMEOUT_SEC:
				_fail("connect_timeout")
			return
		_:
			pass

	var deadline := TURN_TIMEOUT_SEC
	if not _frame_sent:
		deadline = CONNECT_TIMEOUT_SEC
	elif not _first_token_seen:
		deadline = FIRST_TOKEN_TIMEOUT_SEC
	if _elapsed > deadline:
		_fail("timeout")


func _handle_packet(text: String) -> void:
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		return
	var frame: Dictionary = parsed

	match String(frame.get("type", "")):
		"token":
			_first_token_seen = true
			chat_token.emit(String(frame.get("t", "")))
		"done":
			_finished = true
			var usage: Dictionary = frame.get("usage", {}) if typeof(frame.get("usage")) == TYPE_DICTIONARY else {}
			remaining = int(usage.get("remaining", remaining))
			chat_done.emit(frame)
			_cleanup()
		"error":
			_fail(String(frame.get("code", "unknown")))
		_:
			push_warning("Net: unknown frame type %s" % frame.get("type"))


func _fail(code: String) -> void:
	_finished = true
	last_error = code
	chat_error.emit(code)
	_cleanup()


func _fail_session(code: String) -> void:
	last_error = code
	session_failed.emit(code)


func _cleanup() -> void:
	if _ws != null:
		_ws.close()
		_ws = null
	_pending_frame = {}


func is_configured() -> bool:
	return not base_url.is_empty()


## Hot-pack check (§5.7): on boot, ask the backend whether the content pack is newer than the
## bundled baseline and pull the newer entity files plus any referenced art bytes. Silent on
## any failure — the baseline keeps the game playable offline. Skipped in headless runs so CI
## stays hermetic (no backend there by design).
func fetch_content_pack() -> void:
	if DisplayServer.get_name() == "headless":
		return
	var manifest := await _get_json("/v1/content/manifest.json")
	if manifest.is_empty():
		return
	var server_version := int(manifest.get("version", 0))
	if server_version <= ContentDB.version:
		return

	var entities: Array = []
	var art_paths: Dictionary = {}
	for rel in manifest.get("files", []):
		var entity := await _get_json("/v1/content/file/" + String(rel))
		if entity.is_empty():
			continue
		entities.append([String(rel), entity])
		_collect_art_paths(entity, art_paths)

	var art: Dictionary = {}
	for path in art_paths.keys():
		var texture := await _get_texture("/v1/content/file/" + String(path))
		if texture != null:
			art[String(path)] = texture

	ContentDB.apply_hotpack(manifest, entities, art)
	Game.content_version = server_version


func _get_json(path: String) -> Dictionary:
	var err := _pack_http.request(base_url + path, [], HTTPClient.METHOD_GET)
	if err != OK:
		return {}
	var response: Array = await _pack_http.request_completed
	if int(response[0]) != HTTPRequest.RESULT_SUCCESS or int(response[1]) != 200:
		return {}
	var parsed: Variant = JSON.parse_string((response[3] as PackedByteArray).get_string_from_utf8())
	return parsed if typeof(parsed) == TYPE_DICTIONARY else {}


func _get_texture(path: String) -> Texture2D:
	var err := _pack_http.request(base_url + path, [], HTTPClient.METHOD_GET)
	if err != OK:
		return null
	var response: Array = await _pack_http.request_completed
	if int(response[0]) != HTTPRequest.RESULT_SUCCESS or int(response[1]) != 200:
		return null
	var image := Image.new()
	if image.load_png_from_buffer(response[3]) != OK:
		return null
	return ImageTexture.create_from_image(image)


## Pack-relative art paths (e.g. "art/npcs/x.png") are fetched as bytes and decoded at
## runtime (§5.7); res:// paths are bundled and need no fetch.
func _collect_art_paths(entity: Dictionary, out: Dictionary) -> void:
	var stack: Array = [entity]
	while not stack.is_empty():
		var node: Variant = stack.pop_back()
		match typeof(node):
			TYPE_DICTIONARY:
				for value in (node as Dictionary).values():
					stack.append(value)
			TYPE_ARRAY:
				for value in node as Array:
					stack.append(value)
			TYPE_STRING:
				var text := String(node)
				if text.ends_with(".png") and not text.begins_with("res://"):
					out[text] = true
