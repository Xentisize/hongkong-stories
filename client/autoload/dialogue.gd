extends Node
## Conversation owner (docs/PLAN.md §7).
##
## One place decides what a conversation looks like: streaming text from the backend, the
## scripted fallback ladder when it is unavailable, memory, and the hand-off of validated
## actions to Effects. The UI subscribes to signals and never calls the network itself.
##
## The fallback is not an error path bolted on the side — it is the guarantee that the game is
## playable with the backend switched off (§7.4), so both paths emit the same signals.

signal conversation_opened(npc_id: String, display_name: String)
signal conversation_closed(npc_id: String)
signal line_started(npc_id: String)
signal line_chunk(text: String)
signal line_finished(text: String)

const MAX_HISTORY_TURNS := 12

var active_npc: String = ""
var is_streaming: bool = false
var using_fallback: bool = false

var _pending_input: String = ""
var _scripted_index: int = 0
var _stream_buffer: String = ""
var _turn_count: int = 0


func _ready() -> void:
	Net.chat_token.connect(_on_token)
	Net.chat_done.connect(_on_done)
	Net.chat_error.connect(_on_error)


func is_active() -> bool:
	return not active_npc.is_empty()


func open(npc_id: String) -> void:
	if is_active():
		close()

	var npc := ContentDB.get_entity("npcs", npc_id)
	if npc.is_empty():
		push_error("Dialogue: unknown npc '%s'" % npc_id)
		return

	active_npc = npc_id
	_scripted_index = 0
	_turn_count = 0
	using_fallback = false

	Game.talk_counts[npc_id] = int(Game.talk_counts.get(npc_id, 0)) + 1
	var display_name := ContentDB.localize(npc.get("display_name", npc_id), Settings.locale)

	conversation_opened.emit(npc_id, display_name)
	Bus.dialogue_started.emit(npc_id)

	# Greeting prefetch (§7.4): the worst perceived-latency moment is the empty box, so the
	# first line is requested the instant the conversation opens rather than on first input.
	_request("", true)


## Player line. Returns false when a turn is already in flight.
func say(player_input: String) -> bool:
	if not is_active() or is_streaming:
		return false
	_request(player_input, false)
	return true


func close() -> void:
	if not is_active():
		return
	var closed_npc := active_npc
	active_npc = ""
	is_streaming = false
	using_fallback = false
	_stream_buffer = ""
	conversation_closed.emit(closed_npc)
	Bus.dialogue_finished.emit(closed_npc)


func history_for(npc_id: String) -> Array:
	var memory: Dictionary = Game.npc_memory.get(npc_id, {})
	var turns: Array = memory.get("turns", [])
	if turns.size() <= MAX_HISTORY_TURNS:
		return turns
	return turns.slice(turns.size() - MAX_HISTORY_TURNS)


func _request(input: String, prefetch: bool) -> void:
	is_streaming = true
	_pending_input = input
	_stream_buffer = ""
	line_started.emit(active_npc)

	if Net.session_token.is_empty():
		await Net.start_session()

	Net.request_turn({
		"type": "start",
		"session_token": Net.session_token,
		"npc_id": active_npc,
		"lang": Settings.locale,
		"state": state_projection(),
		"history": history_for(active_npc),
		"input": input,
		"prefetch": prefetch,
	})


## The sanatised state the backend is allowed to see (§7.1). Everything here is small and
## non-identifying; P3 can narrow it per NPC once NPCs know things they should not share.
func state_projection() -> Dictionary:
	return {
		"flags": Game.flags,
		"vars": Game.vars,
		"inventory": Game.inventory,
		"talk_counts": Game.talk_counts,
		"visited": Game.visited,
		"quests": Game.quests,
		"time_of_day": Game.time_of_day,
	}


func _on_token(text: String) -> void:
	if text.is_empty():
		return
	_stream_buffer += text
	line_chunk.emit(text)


func _on_done(frame: Dictionary) -> void:
	is_streaming = false
	using_fallback = false
	_turn_count += 1

	var say := String(frame.get("say", ""))
	if say.is_empty():
		say = _stream_buffer

	_remember("user", _pending_input)
	_remember("assistant", say)

	# The server has already validated these against the NPC's declared allowlist (§5.1);
	# Effects is still the single funnel that mutates state (§5.6). The npc context tells
	# `reveal_secret` which character is speaking — the model's action carries only the id.
	var actions: Array = frame.get("actions", [])
	if not actions.is_empty():
		Effects.apply(actions, {"npc": active_npc})

	var rejected: Array = frame.get("rejected", [])
	if not rejected.is_empty():
		print("[Dialogue] server-rejected actions: ", rejected)

	var remaining := int((frame.get("usage", {}) as Dictionary).get("remaining", Net.remaining))
	Net.remaining = remaining

	line_finished.emit(say)
	Bus.npc_spoke.emit(active_npc, say)
	# Logged unconditionally (not just debug builds) because tools/web_smoke.mjs asserts on it:
	# the browser test needs to tell "the model answered" apart from "the fallback answered".
	print("[Dialogue] %s: %s" % [active_npc, say])


func _on_error(code: String) -> void:
	is_streaming = false
	push_warning("Dialogue: chat failed (%s) — falling back to scripted lines" % code)
	_fallback_line()


func _fallback_line() -> void:
	using_fallback = true
	var npc := ContentDB.get_entity("npcs", active_npc)
	var fallback: Dictionary = npc.get("scripted_fallback", {})
	var text := ""

	if _pending_input.is_empty():
		text = ContentDB.localize(fallback.get("greeting", ""), Settings.locale)
	else:
		var lines: Array = fallback.get("lines", [])
		if not lines.is_empty():
			var line: Variant = lines[_scripted_index % lines.size()]
			if typeof(line) == TYPE_DICTIONARY:
				# A structured line is { text, requires?, actions? }: the offline path can drive
				# the quest, not just talk (§7.4 — the game never dead-ends). A gated line stays
				# put and shows "…" until its condition passes, so a reward cannot be handed
				# out on the wrong turn.
				var structured: Dictionary = line
				var gate: Variant = structured.get("requires")
				if gate == null or Conditions.evaluate(gate):
					text = ContentDB.localize(structured.get("text", ""), Settings.locale)
					_scripted_index += 1
					var line_actions: Array = structured.get("actions", [])
					if not line_actions.is_empty():
						Effects.apply(line_actions, {"npc": active_npc})
			else:
				text = ContentDB.localize(line, Settings.locale)
				_scripted_index += 1

	if text.is_empty():
		text = "…"

	_remember("user", _pending_input)
	_remember("assistant", text)
	_turn_count += 1

	line_chunk.emit(text)
	line_finished.emit(text)
	Bus.npc_spoke.emit(active_npc, text)
	print("[Dialogue] %s: %s (fallback)" % [active_npc, text])


func _remember(role: String, content: String) -> void:
	if content.strip_edges().is_empty():
		return
	var memory: Dictionary = Game.npc_memory.get(active_npc, {"turns": []})
	var turns: Array = memory.get("turns", [])
	turns.append({"role": role, "content": content})
	while turns.size() > MAX_HISTORY_TURNS:
		turns.pop_front()
	memory["turns"] = turns
	Game.npc_memory[active_npc] = memory
