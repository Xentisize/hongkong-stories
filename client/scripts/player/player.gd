extends CharacterBody2D
## P1 player: 4-direction movement with walk animation state, plus interaction targeting.
##
## Animation is a state machine (idle/walk + facing + frame) driving drawn placeholder art.
## When real sprite sheets arrive the state stays and only `_draw` is replaced by an
## AnimatedSprite2D frame lookup — the movement and targeting code does not change.
##
## Interaction targets are found by the "interactable" group and distance rather than by an
## Area2D probe: fewer nodes, no physics cost per prop, and ordering is deterministic.

const INTERACT_RANGE := 28.0

@export var speed: float = 72.0

var facing: Vector2 = Vector2.DOWN
var is_walking: bool = false
var current_target: Node2D = null

var _anim_time: float = 0.0
var _frame: int = 0


func _ready() -> void:
	add_to_group("player")


func _physics_process(delta: float) -> void:
	# Input polling bypasses GUI focus, so a focused console LineEdit or dialogue box would
	# still walk the player around behind the text without this gate.
	if Dev.console_open or Dialogue.is_active() or _cutscene_showing() or _title_showing():
		velocity = Vector2.ZERO
		current_target = null
		return

	var direction := Input.get_vector("move_left", "move_right", "move_up", "move_down")
	velocity = direction * speed
	move_and_slide()

	is_walking = direction != Vector2.ZERO
	if is_walking:
		Game.player_position = global_position
		var normalized := direction.normalized()
		if normalized != facing:
			facing = normalized
			queue_redraw()

	_advance_animation(delta)
	current_target = _find_target()


func _unhandled_input(event: InputEvent) -> void:
	if not event.is_action_pressed("ui_interact"):
		return
	if current_target == null:
		return
	if global_position.distance_to(current_target.global_position) > INTERACT_RANGE:
		return
	current_target.call("interact")
	get_viewport().set_input_as_handled()


## HUD reads this every frame; empty string means "show nothing".
func get_prompt_text() -> String:
	if current_target == null or not current_target.has_method("get_prompt"):
		return ""
	var prompt := String(current_target.call("get_prompt"))
	if prompt.is_empty():
		return ""
	return "E  %s" % prompt


func _find_target() -> Node2D:
	var best: Node2D = null
	var best_distance := INTERACT_RANGE
	for node in get_tree().get_nodes_in_group("interactable"):
		var target := node as Node2D
		if target == null or not target.has_method("interact"):
			continue
		if target.has_method("is_available") and not bool(target.call("is_available")):
			continue
		var distance := global_position.distance_to(target.global_position)
		if distance <= best_distance:
			best_distance = distance
			best = target
	return best


func _advance_animation(delta: float) -> void:
	_anim_time += delta
	# 8 steps/second across a 4-frame cycle, and idle always rests on frame 0.
	var next_frame := int(_anim_time * 8.0) % 4 if is_walking else 0
	if next_frame != _frame:
		_frame = next_frame
		queue_redraw()


## The cutscene overlay handles its own input; movement and targeting stop while it is up.
func _cutscene_showing() -> bool:
	var cutscene := get_tree().get_first_node_in_group("cutscene")
	return cutscene != null and bool(cutscene.call("is_showing"))


## Same gate for the title screen (the cover at boot; Esc reopens it as settings).
func _title_showing() -> bool:
	var title := get_tree().get_first_node_in_group("title")
	return title != null and bool(title.call("is_showing"))


var _sprite_tex: Texture2D = null
var _sprite_checked: bool = false


## The generated walk sheet (bundled or hot-pack), attempted once; nearest-filtered for
## crisp pixels. Cells: 4 columns (down, right, left, up) x 2 rows (stand, step). The
## placeholder rectangles below remain the fallback when art is missing.
func _player_sprite() -> Texture2D:
	if not _sprite_checked:
		_sprite_checked = true
		_sprite_tex = ContentDB.art_texture("art/npcs/player_walk.png")
		texture_filter = CanvasItem.TEXTURE_FILTER_NEAREST
	return _sprite_tex


## Sheet column by facing: down, right, left, up.
func _facing_column() -> int:
	if facing.y > 0.5:
		return 0
	if facing.x > 0.5:
		return 1
	if facing.x < -0.5:
		return 2
	if facing.y < -0.5:
		return 3
	return 0


func _draw() -> void:
	var sprite := _player_sprite()
	if sprite != null:
		# Two-frame directional walk: row 0 stands, row 1 steps, alternating at walk cadence.
		var cell := Vector2(26.0, 34.0)
		var col := _facing_column()
		var row := 0
		if is_walking:
			row = _frame % 2
		var region := Rect2(col * cell.x, row * cell.y, cell.x, cell.y)
		var dest := Rect2(-cell.x / 2.0, -cell.y + 1.0, cell.x, cell.y)
		draw_rect(Rect2(-7, -1, 14, 2), Color(0, 0, 0, 0.25))   # ground shadow
		draw_texture_rect_region(sprite, dest, region)
		return
	# Scene 1 of the placeholder art: 12x26 body at 24px tile scale, drawn up from the feet.
	var bob := -1.0 if (is_walking and _frame % 2 == 1) else 0.0
	var step := 0.0
	if is_walking:
		step = 1.0 if _frame % 2 == 0 else -1.0

	draw_rect(Rect2(-7, -3, 14, 3), Color(0, 0, 0, 0.25))   # ground shadow

	# Legs alternate to sell the walk without a sprite sheet.
	draw_rect(Rect2(-5 + step, -7, 4, 7), Color("#3b3f4a"))
	draw_rect(Rect2(1 - step, -7, 4, 7), Color("#3b3f4a"))

	draw_rect(Rect2(-6, -18 + bob, 12, 13), Color("#c9564e"))   # coat
	draw_rect(Rect2(-6, -18 + bob, 12, 2), Color("#e58f86"))    # collar highlight
	draw_rect(Rect2(-5, -26 + bob, 10, 8), Color("#f2d3ab"))    # head
	draw_rect(Rect2(-5, -26 + bob, 10, 2), Color("#3a2a22"))    # hair

	# One 2px eye block offset toward the direction of travel.
	var eye := Vector2(facing.x * 2.5, -22.0 + facing.y + bob)
	draw_rect(Rect2(eye, Vector2(2, 2)), Color("#2a1f1a"))
