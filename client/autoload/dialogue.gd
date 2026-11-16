extends Node
## Conversation owner (docs/PLAN.md §7).
##
## P0 stub. In P2 this holds the active NPC conversation, the streaming display, the
## scripted fallback ladder, and the hand-off of validated actions to Effects.
##
## Deliberately empty of logic until the backend exists: the fallback path is what makes the
## game playable offline (§7.4), and it is designed together with the streaming path.


func start_conversation(_npc_id: String) -> void:
	# TODO(P2)
	pass


func end_conversation() -> void:
	# TODO(P2)
	pass
