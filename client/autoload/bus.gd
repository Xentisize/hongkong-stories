extends Node
## Signal-only event bus (docs/PLAN.md §6.2).
##
## No logic belongs in this file. Systems emit here and listen here instead of holding
## references to each other, which is what keeps the autoloads from becoming spaghetti.

signal flag_set(flag: String, value: bool)
signal var_changed(var_name: String, value: float)
signal item_gained(item_id: String, count: int)
signal item_lost(item_id: String, count: int)

## P6+ item screen: which item the player carries in hand ("" = empty hands). NPCs see it
## through the state projection and may react; the HUD shows it on the panel title.
signal held_changed(item_id: String)

signal quest_updated(quest_id: String, node_id: String)
signal quest_completed(quest_id: String)

signal location_entered(location_id: String)
signal player_interacted(target_name: String)

## P3 (§5.6): navigation and presentation-only effects. `goto_requested` is emitted by the
## `goto` effect and by location exits; Main owns the actual location swap and defers it.
signal goto_requested(location_id: String, spawn_id: String)
signal cutscene_started(quest_id: String, node_id: String)
signal secret_revealed(npc_id: String, secret_id: String, text: String)
signal shop_opened(npc_id: String)
signal sfx_requested(sfx_name: String)
signal shake_requested(strength: float, time: float)
signal fade_requested(direction: String, time: float)

signal dialogue_started(npc_id: String)
signal npc_spoke(npc_id: String, text: String)
signal dialogue_finished(npc_id: String)

signal effect_applied(effect: Dictionary)
signal message_shown(text: String)
signal inventory_changed()
signal save_written(slot: int)
signal save_loaded(slot: int)
signal locale_changed(locale: String)
