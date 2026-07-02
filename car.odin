package main

import "core:math"
import "core:math/linalg"
import "core:math/rand"

// CPU side of the game: the truck (arcade-real car physics), firing, the chase camera
// and the city layout. The horde + bullets simulate on the GPU (physics.comp); the CPU
// writes the player body + bullet spawns + the city height grid straight into the
// host-visible GPU buffers and never reads them back.
// Body layout: [0] player, [ENEMY_LO..) enemies, [BULLET_LO..) bullets.

// Shared gameplay constants — tools/build.odin generates these into GLSL (u32 → `const
// uint`, f32 → `const float`). No hand-kept "MUST match": this IS the source.
// @glsl
KIND_PLAYER :: u32(0)
KIND_ENEMY  :: u32(1)
KIND_BULLET :: u32(2)
KIND_DEAD   :: u32(3)
KIND_DYING  :: u32(4) // death-burst animation, then DEAD
VAR_SPIDER  :: u32(0)
VAR_SKITTER :: u32(1)
VAR_BRUTE   :: u32(2)
VAR_SPARK   :: u32(3) // bullet impact burst (small, fast)
MAX_ENEMIES :: 1536
MAX_BULLETS :: 256
ENEMY_LO    :: 1
BULLET_LO   :: 1 + MAX_ENEMIES
CAR_RADIUS  :: f32(20)
WORLD       :: f32(4200) // world is [0,WORLD]²; the camera follows the truck
CITY_N      :: 21        // city cells per axis; streets every 4th cell (edge ring included)
CITY_CELLS  :: CITY_N * CITY_N
CITY_CELL   :: WORLD / f32(CITY_N)
BLDG_INSET  :: f32(26) // building walls sit this far inside their cell
SPAWN_MIN_D :: f32(680) // spawns avoid appearing this close to the truck
OUTSKIRTS   :: f32(520) // drivable/walkable wasteland beyond the city border
AGGRO_D     :: f32(520) // bots divert from their invasion onto the truck inside this range
DEATH_T     :: f32(0.55)
SPARK_T     :: f32(0.22)
SPD_SPIDER  :: f32(105)
SPD_SKITTER :: f32(195)
SPD_BRUTE   :: f32(62)
R_SPIDER    :: f32(15)
R_SKITTER   :: f32(9)
R_BRUTE     :: f32(27)
HP_SPIDER   :: f32(2)
HP_SKITTER  :: f32(1)
HP_BRUTE    :: f32(7)
KNOCKBACK   :: f32(150)
// @glsl-end

// CPU-only tuning.
CAR_ACCEL     :: f32(950)
CAR_REV_ACCEL :: f32(700) // reverse gear is weaker (throttle is -0.5 in reverse)
CAR_MAX_SPEED :: f32(560)
CAR_DRAG      :: f32(1.1)  // 1/s forward-speed decay
CAR_GRIP      :: f32(7.5)  // 1/s lateral-velocity kill (lower = more drift)
CAR_WHEELBASE :: f32(42)
CAR_STEER     :: f32(0.62) // max steering angle, radians
BULLET_SPEED  :: f32(980)
BULLET_RADIUS :: f32(6)
BULLET_LIFE   :: f32(0.9)
FIRE_INTERVAL :: f32(0.085)

car_pos, car_vel: [2]f32
car_angle:   f32
aim_world:   [2]f32
cam:         [2]f32 // smoothed camera center (shake is added on top in render())
cam_shake:   f32
muzzle:      f32 // firing flash/recoil envelope: 1 on shot → decays to 0
throttle_v:  f32 // smoothed |throttle| for the engine glow
fire_timer:  f32
bullet_head: int
barrel:      f32 // the two barrels alternate: ±1
input:       struct { up, down, left, right, fire: bool, mouse: [2]f32 }

// Pointers into the mapped GPU buffers.
body_at :: proc(i: int) -> ^Body { return (^Body)(uintptr(buf_map[.Body]) + uintptr(i * size_of(Body))) }
city_at :: proc(i, j: int) -> ^f32 { return (^f32)(uintptr(buf_map[.City]) + uintptr((j * CITY_N + i) * 4)) }

game_init :: proc() {
	car_pos = {2500, 2500} // a street intersection near the middle (city cell 12,12)
	car_vel = {}
	car_angle = 0
	cam = car_pos
	cam_shake, muzzle, throttle_v, fire_timer = 0, 0, 0, 0
	bullet_head = 0
	barrel = 1
	input = {}

	// City height grid: streets every 4th cell (h = 0), buildings elsewhere (h drives
	// roof brightness / shadow length), the odd plaza carved out of a block.
	for j in 0 ..< CITY_N {
		for i in 0 ..< CITY_N {
			h: f32 = 0
			if i % 4 != 0 && j % 4 != 0 {
				h = rand.float32_range(0.35, 1)
				if rand.float32() < 0.10 { h = 0 } // plaza
			}
			city_at(i, j)^ = h
		}
	}

	body_at(0)^ = {pos = car_pos, radius = CAR_RADIUS, kind = KIND_PLAYER}
	// The assault is already mid-march at t=0: the first slots start alive on a ring
	// around the city; the rest start DEAD with a staggered respawn countdown (life) —
	// physics.comp then streams them in from beyond the border, forever.
	for i in 0 ..< MAX_ENEMIES {
		b := Body{kind = KIND_DEAD, life = rand.float32_range(0, 10)}
		if i < 400 { b = spawn_initial() }
		body_at(ENEMY_LO + i)^ = b
	}
	for i in 0 ..< MAX_BULLETS { body_at(BULLET_LO + i)^ = {kind = KIND_DEAD} }
}

// An enemy already en route at game start. Variant mix 60/30/10 — matches spawn_enemy
// in physics.comp (which owns all respawning after this).
spawn_initial :: proc() -> (b: Body) {
	rv := rand.float32()
	switch {
	case rv < 0.6: b.variant = VAR_SPIDER; b.radius = R_SPIDER * rand.float32_range(0.85, 1.15); b.hp = HP_SPIDER
	case rv < 0.9: b.variant = VAR_SKITTER; b.radius = R_SKITTER * rand.float32_range(0.85, 1.15); b.hp = HP_SKITTER
	case:          b.variant = VAR_BRUTE; b.radius = R_BRUTE * rand.float32_range(0.9, 1.1); b.hp = HP_BRUTE
	}
	ang := rand.float32_range(0, math.TAU)
	dist := rand.float32_range(900, 2900)
	ctr := [2]f32{WORLD, WORLD} * 0.5
	b.pos = linalg.clamp(ctr + [2]f32{math.cos(ang), math.sin(ang)} * dist, [2]f32{-450, -450}, [2]f32{WORLD + 450, WORLD + 450})
	to := car_pos - b.pos
	b.angle = math.atan2(to.y, to.x)
	b.kind = KIND_ENEMY
	return
}

game_update :: proc(dt: f32) {
	w, h := f32(win_w), f32(win_h)
	aim_world = cam + input.mouse - [2]f32{w, h} * 0.5

	// ── truck: bicycle model. Steering turns the heading at a rate ∝ forward speed,
	// grip bleeds lateral velocity (what survives is drift), drag bleeds forward speed.
	throttle: f32 = 0
	if input.up { throttle += 1 }
	if input.down { throttle -= 0.5 }
	steer: f32 = 0
	if input.right { steer += 1 }
	if input.left { steer -= 1 }

	fwd := [2]f32{math.cos(car_angle), math.sin(car_angle)}
	vf := linalg.dot(car_vel, fwd)
	car_angle += (vf / CAR_WHEELBASE) * math.tan(CAR_STEER * steer) * dt
	fwd = {math.cos(car_angle), math.sin(car_angle)}
	car_vel += fwd * throttle * (throttle > 0 ? CAR_ACCEL : CAR_REV_ACCEL) * dt
	vf = linalg.dot(car_vel, fwd)
	side := car_vel - fwd * vf
	vf *= 1 / (1 + CAR_DRAG * dt)
	side *= math.exp(-CAR_GRIP * dt)
	car_vel = fwd * vf + side
	if sp := linalg.length(car_vel); sp > CAR_MAX_SPEED { car_vel *= CAR_MAX_SPEED / sp }
	car_pos += car_vel * dt
	collide_city(&car_pos, &car_vel, CAR_RADIUS)
	for a in 0 ..< 2 { // the outskirts are drivable; the hard stop is out in the wasteland
		if car_pos[a] < CAR_RADIUS - OUTSKIRTS { car_pos[a] = CAR_RADIUS - OUTSKIRTS; car_vel[a] = max(car_vel[a], 0) }
		if car_pos[a] > WORLD + OUTSKIRTS - CAR_RADIUS { car_pos[a] = WORLD + OUTSKIRTS - CAR_RADIUS; car_vel[a] = min(car_vel[a], 0) }
	}
	throttle_v += (abs(throttle) - throttle_v) * (1 - math.exp(-8 * dt))
	body_at(0)^ = {pos = car_pos, vel = car_vel, radius = CAR_RADIUS, angle = car_angle, kind = KIND_PLAYER}

	// ── chase camera: lead toward the aim and along the velocity, exp-smoothed.
	lead := aim_world - car_pos
	if l := linalg.length(lead); l > 240 { lead *= 240 / l }
	target := car_pos + lead * 0.32 + car_vel * 0.22
	cam += (target - cam) * (1 - math.exp(-4.5 * dt))
	cam = linalg.clamp(cam, [2]f32{w, h} * 0.35 - OUTSKIRTS, [2]f32{WORLD, WORLD} + OUTSKIRTS - [2]f32{w, h} * 0.35)
	cam_shake *= math.exp(-6.5 * dt)
	muzzle *= math.exp(-13 * dt)

	// ── fire: dual alternating barrels toward the mouse, with recoil + shake.
	fire_timer -= dt
	if input.fire && fire_timer <= 0 {
		if off := aim_world - car_pos; linalg.length(off) > 0.001 {
			a := linalg.normalize(off)
			perp := [2]f32{-a.y, a.x}
			body_at(BULLET_LO + bullet_head)^ = {
				pos    = car_pos + a * (CAR_RADIUS + 14) + perp * (barrel * 5),
				vel    = a * BULLET_SPEED + car_vel * 0.35,
				radius = BULLET_RADIUS, life = BULLET_LIFE,
				angle  = math.atan2(a.y, a.x), kind = KIND_BULLET, variant = VAR_SPARK,
			}
			bullet_head = (bullet_head + 1) % MAX_BULLETS
			fire_timer = FIRE_INTERVAL
			barrel = -barrel
			muzzle = 1
			cam_shake = min(cam_shake + 1.6, 6)
			car_vel -= a * 9 // recoil
		}
	}
}

// Push a circle out of any building it overlaps and kill the velocity into the wall
// (with a little bounce). MUST mirror the building test in physics.comp (cell rect
// inset by BLDG_INSET) — the one CPU↔GPU duplication, kept tiny on purpose.
collide_city :: proc(pos: ^[2]f32, vel: ^[2]f32, r: f32) {
	i0, i1 := int((pos.x - r) / CITY_CELL), int((pos.x + r) / CITY_CELL)
	j0, j1 := int((pos.y - r) / CITY_CELL), int((pos.y + r) / CITY_CELL)
	for j in j0 ..= j1 {
		for i in i0 ..= i1 {
			if i < 0 || j < 0 || i >= CITY_N || j >= CITY_N { continue }
			if city_at(i, j)^ <= 0 { continue }
			lo := [2]f32{f32(i), f32(j)} * CITY_CELL + BLDG_INSET
			hi := [2]f32{f32(i + 1), f32(j + 1)} * CITY_CELL - BLDG_INSET
			q := linalg.clamp(pos^, lo, hi)
			d := pos^ - q
			dist := linalg.length(d)
			// dist≈0 (center inside the rect) can't happen: per-frame travel < radius.
			if dist >= r || dist < 0.0001 { continue }
			n := d / dist
			pos^ = q + n * r
			if vn := linalg.dot(vel^, n); vn < 0 { vel^ -= n * vn * 1.3 } // cancel + 30% bounce
		}
	}
}
