extends Node
## Backend proxy client (docs/PLAN.md §7.1).
##
## The client NEVER talks to OpenRouter directly — there is no API key in this build and
## there never will be (§3). This node only knows the URL of our own server.

const DEFAULT_BASE_URL := "http://127.0.0.1:8000"

var base_url: String = DEFAULT_BASE_URL
var session_token: String = ""
var is_online: bool = false


func _ready() -> void:
	base_url = String(ProjectSettings.get_setting("hk_stories/api_base_url", DEFAULT_BASE_URL))
	# Desktop convenience; a web build cannot read env vars and takes the project setting.
	if OS.has_environment("HK_STORIES_API"):
		base_url = OS.get_environment("HK_STORIES_API")


## P2: create an anonymous session and open the chat WebSocket.
func start_session() -> bool:
	# TODO(P2): POST /v1/session, store session_token and budget.
	return false


func is_configured() -> bool:
	return not base_url.is_empty()
