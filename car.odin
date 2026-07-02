package main

import "core:math/linalg"
import "core:math/rand"

// CPU side of the game. The horde + bullets simulate on the GPU (physics.comp); the
// CPU only drives the player and spawns bullets, writing those bodies directly into
// the host-visible GPU body buffer (buf_map[.Body]). Layout: [0] player, [1..) enemies,
// [rest] bullets.

// Constants the shaders also need — tools/build.odin generates these into GLSL (u32 → `const
// uint`, f32 → `const float`). No hand-kept "MUST match": this IS the source.
// @glsl
KIND_PLAYER :: u32(0)
KIND_ENEMY  :: u32(1)
KIND_BULLET :: u32(2)
KIND_DEAD   :: u32(3)
MAX_ENEMIES :: 150
MAX_BULLETS :: 128
CAR_RADIUS  :: f32(18)
ENEMY_R_MIN :: f32(9)
ENEMY_R_MAX :: f32(20)
// @glsl-end

// CPU-only.
ENEMY_LO      :: 1
BULLET_LO     :: 1 + MAX_ENEMIES
CAR_SPEED     :: f32(380)
BULLET_SPEED  :: f32(780)
BULLET_RADIUS :: f32(5)
BULLET_LIFE   :: f32(1.5)
FIRE_INTERVAL :: f32(0.11)

player_pos:  [2]f32
input:       struct { up, down, left, right, fire: bool, aim: [2]f32 }
fire_timer:  f32
bullet_head: int

// Pointer into the mapped body buffer for body slot i.
body_at :: proc(i: int) -> ^Body { return (^Body)(uintptr(buf_map[.Body]) + uintptr(i * size_of(Body))) }

game_init :: proc() {
	player_pos = {f32(win_w) * 0.5, f32(win_h) * 0.5}
	input = {}
	fire_timer = 0
	bullet_head = 0
	body_at(0)^ = {pos = player_pos, radius = CAR_RADIUS, kind = KIND_PLAYER}
	for i in 0 ..< MAX_ENEMIES {
		r := rand.float32_range(ENEMY_R_MIN, ENEMY_R_MAX)
		body_at(ENEMY_LO + i)^ = {pos = random_edge(r), radius = r, kind = KIND_ENEMY}
	}
	for i in 0 ..< MAX_BULLETS { body_at(BULLET_LO + i)^ = {kind = KIND_DEAD} }
}

random_edge :: proc(r: f32) -> [2]f32 {
	w, h := f32(win_w), f32(win_h)
	switch rand.int_max(4) {
	case 0:  return {rand.float32_range(0, w), -r}
	case 1:  return {rand.float32_range(0, w), h + r}
	case 2:  return {-r, rand.float32_range(0, h)}
	case:    return {w + r, rand.float32_range(0, h)}
	}
}

game_update :: proc(dt: f32) {
	w, h := f32(win_w), f32(win_h)

	dir: [2]f32
	if input.left  { dir.x -= 1 }
	if input.right { dir.x += 1 }
	if input.up    { dir.y -= 1 }
	if input.down  { dir.y += 1 }
	if dir.x != 0 || dir.y != 0 { player_pos += linalg.normalize(dir) * CAR_SPEED * dt }
	player_pos = linalg.clamp(player_pos, [2]f32{CAR_RADIUS, CAR_RADIUS}, [2]f32{w - CAR_RADIUS, h - CAR_RADIUS})
	body_at(0)^ = {pos = player_pos, radius = CAR_RADIUS, kind = KIND_PLAYER}

	fire_timer -= dt
	if input.fire && fire_timer <= 0 {
		off := input.aim - player_pos
		if d := linalg.length(off); d > 0.001 {
			a := off / d
			body_at(BULLET_LO + bullet_head)^ = {pos = player_pos + a * (CAR_RADIUS + 2), vel = a * BULLET_SPEED, radius = BULLET_RADIUS, life = BULLET_LIFE, kind = KIND_BULLET}
			bullet_head = (bullet_head + 1) % MAX_BULLETS
			fire_timer = FIRE_INTERVAL
		}
	}
}
