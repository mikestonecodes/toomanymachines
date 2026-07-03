package main

import "core:math"
import "core:math/linalg"
import "core:math/rand"

// CPU side of the game: the hover ship (drifty thrust-vector physics + boost + the
// giant tow laser), firing, the chase camera, and the city RADIUS. The city itself is
// fully ANALYTIC — curved ring/spoke streets carve blocks out of hash space (street_dist
// / bldg_pen below, mirrored in common.glsl) — so "the city" on the CPU is just city_r.
// The horde + bullets + wrecks + gate pylons simulate on the GPU (physics.comp); the CPU
// writes the player body + bullet spawns straight into the host-visible buffers. The ONE
// readback is the tiny Stats buffer: the GPU counts wrecks dumped into the central pit,
// the CPU polls that counter and pushes city_r outward for every corpse fed to it.
// Body layout: [0] player, [ENEMY_LO..) enemies, [BULLET_LO..) bullets, [TURRET_LO..) pylons.

// Shared gameplay constants — tools/build.odin generates these into GLSL (u32 → `const
// uint`, f32 → `const float`). No hand-kept "MUST match": this IS the source.
// @glsl
KIND_PLAYER :: u32(0)
KIND_ENEMY  :: u32(1)
KIND_BULLET :: u32(2)
KIND_DEAD   :: u32(3)
KIND_DYING  :: u32(4) // death-burst animation, then WRECK (enemies) or DEAD
KIND_WRECK  :: u32(5) // shot-down mech husk: towable, feed it to the pit
KIND_TURRET :: u32(6) // static defense tower (perimeter laser / inner machine gun)
KIND_HELPER :: u32(7) // friendly salvage drone: hauls wrecks to the pit on its own
VAR_SPIDER  :: u32(0)
VAR_SKITTER :: u32(1)
VAR_BRUTE   :: u32(2)
VAR_SPARK   :: u32(3) // pit-sink burst (small, fast)
VAR_BOOM    :: u32(4) // bullet detonation: an expanding shockwave that flings the horde
MAX_ENEMIES :: 80000
MAX_BULLETS :: 384
MAX_TURRETS :: 64
MAX_HELPERS :: 24
ENEMY_LO    :: 1
BULLET_LO   :: 1 + MAX_ENEMIES
TURRET_LO   :: BULLET_LO + MAX_BULLETS
HELPER_LO   :: TURRET_LO + MAX_TURRETS
CAR_RADIUS  :: f32(20)
WORLD       :: f32(18800) // world is [0,WORLD]²; the city grows from the center, wasteland everywhere else
PIT_R       :: f32(230)          // the corpse pit at the world center
RING_SP     :: f32(560)          // ring-road spacing (curved streets: wobbled rings + spiral spokes)
SPOKES      :: f32(10)           // radial avenue count (only half run all the way to the core)
SPOKE2_R    :: RING_SP * 4       // the staggered second half of the avenues starts out here
SPIRAL      :: f32(0.00035)      // rad/px twist — avenues curve as they run outward
STREET_HW   :: f32(105)          // street half-width (the paved part) — wide boulevards
BLDG_EDGE   :: STREET_HW + 14    // building facades rise at this distance from the centerline
PLAZA_P     :: f32(0.40)         // chance a block is an open plaza — the city breathes
SPAWN_MIN_D :: f32(680)  // spawns avoid appearing this close to the ship
AGGRO_D     :: f32(560)  // bots divert from their invasion onto the ship inside this range
TOW_D       :: f32(180)  // wrecks within this range magnet-tow behind the ship
WRECK_T     :: f32(90)   // a wreck rots away after this long if not fed to the pit
LASER_LEN   :: f32(1400) // the ship's giant laser: reach,
LASER_W     :: f32(30)   //   half-width,
LASER_DPS   :: f32(9)    //   damage per second at full burn
TWR_LEN     :: f32(2400) // perimeter laser towers: beam reach,
TWR_W       :: f32(46)   //   beam half-width,
TWR_DPS     :: f32(30)   //   damage per second — a sweep exterminates whole streams
MG_LEN      :: f32(800)  // inner machine-gun turrets: tracer reach,
MG_W        :: f32(26)   //   corridor half-width,
MG_DPS      :: f32(10)   //   chip damage + ricochet
MG_V        :: f32(1400) //   muzzle velocity — rounds are REAL bullets (time-of-flight rewind)
R_TURRET    :: f32(40)
R_HELPER    :: f32(14)
BOOM_R      :: f32(170)  // every bullet detonates: shockwave reach
BOOM_T      :: f32(0.5)  //   and expansion time
DEATH_T     :: f32(0.55)
SPARK_T     :: f32(0.22)
SPD_SPIDER  :: f32(130)
SPD_SKITTER :: f32(235)
SPD_BRUTE   :: f32(80)
R_SPIDER    :: f32(15)
R_SKITTER   :: f32(9)
R_BRUTE     :: f32(27)
HP_SPIDER   :: f32(3)
HP_SKITTER  :: f32(1)
HP_BRUTE    :: f32(10)
KNOCKBACK   :: f32(90)
ZOOM        :: f32(1.35) // world px per screen px — pulled back so the horde reads
PERSP       :: f32(0.11) // GTA2 fake-3D: rooftop parallax per unit height — SUBTLE: strong skew on curved footprints reads as warping
// @glsl-end

// CPU-only tuning.
SHIP_ACCEL     :: f32(1600)
SHIP_REV       :: f32(900)
SHIP_MAX       :: f32(760)
SHIP_BOOST_MAX :: f32(1150)
SHIP_DRAG      :: f32(0.95) // 1/s forward decay — floaty, but it does stop eventually
SHIP_GRIP      :: f32(2.2)  // 1/s lateral bleed — low: it DRIFTS
SHIP_TURN      :: f32(3.4)  // rad/s max yaw
BULLET_SPEED   :: f32(1050)
BULLET_RADIUS  :: f32(7)
BULLET_LIFE    :: f32(0.9)
FIRE_INTERVAL  :: f32(0.17) // slow, heavy — every shell is an artillery hit
CITY_R0        :: f32(5200) // starting city radius — BIG for now, to test the city itself
CITY_RMAX      :: f32(8200) // sprawl limit (grid edge is at 9400)
DEPOSIT_GROW   :: f32(60)   // city radius gained per corpse fed to the pit
CENTER         :: [2]f32{WORLD * 0.5, WORLD * 0.5}

car_pos, car_vel: [2]f32
car_angle:   f32
aim_world:   [2]f32
cam:         [2]f32 // smoothed camera center (shake is added on top in render())
cam_shake:   f32
muzzle:      f32 // firing flash/recoil envelope: 1 on shot → decays to 0
throttle_v:  f32 // smoothed |throttle| for the engine glow
boost_v:     f32 // smoothed boost for the flame
laser_v:     f32 // smoothed laser burn: RMB held → 1
fire_timer:  f32
bullet_head: int
barrel:      f32 // the two barrels alternate: ±1
run_seed:      u32 // per-run salt for the warband cluster hash
city_r:        f32 // current city radius — grows as the pit is fed (pushed to the GPU)
deposits_seen: u32 // last pit-counter value read from the Stats buffer
input:       struct { up, down, left, right, fire, boost, laser: bool, mouse: [2]f32 }

// Pointers into the mapped GPU buffers.
body_at :: proc(i: int) -> ^Body { return (^Body)(uintptr(buf_map[.Body]) + uintptr(i * size_of(Body))) }
stats_at :: proc(i: int) -> ^u32 { return (^u32)(uintptr(buf_map[.Stats]) + uintptr(i * 4)) }

// ── the curved street layout ──────────────────────────────────────────────────
// Streets are analytic: clean ring roads every RING_SP px around the pit + spiral
// spoke avenues (5 reach the core, the staggered 5 only exist beyond SPOKE2_R). The
// rings are perfect circles — wobble made the blocks read as warped under the fake 3D.
// Distance to the nearest street centerline. MUST mirror street_d in common.glsl —
// the GPU uses the same function for enemy/bullet collision AND drawing.
street_dist :: proc(p: [2]f32) -> f32 {
	q := p - CENTER
	r := linalg.length(q)
	d := abs(r - max(math.round(r / RING_SP), 1) * RING_SP)
	sa := math.atan2(q.y, q.x) - SPIRAL * r
	stp := f32(math.TAU) / (SPOKES * 0.5)
	da := sa - math.round(sa / stp) * stp
	d = min(d, abs(da) * r)
	if r > SPOKE2_R {
		sa2 := sa + stp * 0.5
		da2 := sa2 - math.round(sa2 / stp) * stp
		d = min(d, abs(da2) * r)
	}
	return d
}

// The shaders' hash21 — block/plaza picks must agree bit-for-bit-ish across CPU and GPU
// (inputs are small integers, so f32 rounding matches).
hash21o :: proc(p: [2]f32) -> f32 {
	q := linalg.fract(p * [2]f32{123.34, 456.21})
	q += linalg.dot(q, q + 45.32)
	return math.mod(q.x * q.y, 1)
}

sd_box2 :: proc(p, b: [2]f32) -> f32 {
	d := [2]f32{abs(p.x) - b.x, abs(p.y) - b.y}
	return linalg.length(linalg.max(d, [2]f32{0, 0})) + min(max(d.x, d.y), 0)
}

// The house rect under p: signed distance to it (huge when the cell holds no house)
// plus its outward face normal. Courtyards, terrace gaps and plazas are open ground.
// MUST mirror house_at in common.glsl — the GPU collides every body on the same rects.
house_pen :: proc(p: [2]f32) -> (sd: f32, n: [2]f32) {
	sd = 1e9
	q := p - CENTER
	r := linalg.length(q)
	kb := math.floor(r / RING_SP)
	if kb < 1 || r > city_r - 60 { return }
	ns := kb * RING_SP >= SPOKE2_R ? SPOKES : SPOKES * 0.5
	sa := math.atan2(q.y, q.x) - SPIRAL * r
	jb := math.floor(sa / (f32(math.TAU) / ns))
	if hash21o([2]f32{kb, jb} * 1.13 + 4.7) < PLAZA_P { return } // plaza
	rB0 := kb * RING_SP + BLDG_EDGE
	rB1 := (kb + 1) * RING_SP - BLDG_EDGE
	rowDepth := (rB1 - rB0) * 0.40
	outer := r > (rB0 + rB1) * 0.5
	rRow := outer ? rB1 - rowDepth * 0.5 : rB0 + rowDepth * 0.5
	S := 130 + math.floor(hash21o([2]f32{kb, outer ? 1 : 0} * 3.9 + 6.1) * 3) * 65
	ci := math.floor(sa * rRow / S)
	seed := hash21o({ci, kb * 13 + jb * 3 + (outer ? 7 : 0)})
	if seed < 0.16 { return } // gap in the terrace
	aC := (ci + 0.5) * S / rRow + SPIRAL * rRow
	cdir := [2]f32{math.cos(aC), math.sin(aC)}
	c := CENTER + cdir * rRow
	if street_dist_spokes(c) < BLDG_EDGE + S * 0.5 { return } // clear of the avenues
	d2 := p - c
	lc := [2]f32{linalg.dot(d2, cdir), linalg.dot(d2, [2]f32{-cdir.y, cdir.x})}
	ext := [2]f32{rowDepth * 0.5 - 4 - 14 * math.mod(seed * 3.3, 1), S * 0.5 - (8 + 26 * math.mod(seed * 5.7, 1))}
	sd = sd_box2(lc, ext)
	eu := ext.x - abs(lc.x)
	ev := ext.y - abs(lc.y)
	n = eu < ev ? cdir * math.sign(lc.x) : [2]f32{-cdir.y, cdir.x} * math.sign(lc.y)
	return
}

// Just the spoke part of street_dist (house trimming needs it without the rings).
street_dist_spokes :: proc(p: [2]f32) -> f32 {
	q := p - CENTER
	r := linalg.length(q)
	sa := math.atan2(q.y, q.x) - SPIRAL * r
	stp := f32(math.TAU) / (SPOKES * 0.5)
	da := sa - math.round(sa / stp) * stp
	d := abs(da) * r
	if r > SPOKE2_R {
		sa2 := sa + stp * 0.5
		da2 := sa2 - math.round(sa2 / stp) * stp
		d = min(d, abs(da2) * r)
	}
	return d
}

game_init :: proc() {
	car_pos = CENTER + {0, -(PIT_R + 170)} // hovering just off the pit plaza
	car_vel = {}
	car_angle = 0
	cam = car_pos
	cam_shake, muzzle, throttle_v, boost_v, laser_v, fire_timer = 0, 0, 0, 0, 0, 0
	bullet_head = 0
	barrel = 1
	input = {}
	deposits_seen = 0
	for i in 0 ..< 64 { stats_at(i)^ = 0 }
	city_r = CITY_R0

	body_at(0)^ = {pos = car_pos, radius = CAR_RADIUS, kind = KIND_PLAYER}
	// The full 80k horde is alive from t=0 — warbands scattered across the wasteland,
	// all marching in. physics.comp owns everything after this (kills → wrecks → pit →
	// respawn at the frontier).
	run_seed = rand.uint32()
	for i in 0 ..< MAX_ENEMIES { body_at(ENEMY_LO + i)^ = spawn_initial(i) }
	for i in 0 ..< MAX_BULLETS { body_at(BULLET_LO + i)^ = {kind = KIND_DEAD} }

	// Defense laser towers EVERYWHERE: one per avenue gate, a field of them across the
	// wasteland, and plaza towers on the inner crossings. Each periodically fires a
	// two-sided sweeping TWR_LEN beam that exterminates whole streams (physics.comp
	// reads all tower slots directly; timing/sweep derive from time + slot id).
	for i in 0 ..< MAX_TURRETS { body_at(TURRET_LO + i)^ = {kind = KIND_DEAD} }
	n := 0
	spawn_tower :: proc(n: ^int, pos: [2]f32, a: f32) {
		if n^ >= MAX_TURRETS { return }
		body_at(TURRET_LO + n^)^ = {pos = pos, radius = R_TURRET, angle = a, hp = 100, kind = KIND_TURRET}
		n^ += 1
	}
	r_g := city_r + 420
	for j in 0 ..< int(SPOKES) { // the gates
		a := f32(j) * f32(math.TAU) / SPOKES + SPIRAL * r_g
		base := CENTER + [2]f32{math.cos(a), math.sin(a)} * r_g
		spawn_tower(&n, base + {rand.float32_range(-60, 60), rand.float32_range(-60, 60)}, a)
	}
	for _ in 0 ..< 24 { // the wasteland field
		pos: [2]f32
		for _ in 0 ..< 12 {
			pos = {rand.float32_range(500, WORLD - 500), rand.float32_range(500, WORLD - 500)}
			if linalg.length(pos - CENTER) > city_r + 700 { break }
		}
		spawn_tower(&n, pos, rand.float32_range(0, math.TAU))
	}
	for m in 0 ..< 10 { // machine-gun turrets on the inner crossings (lasers stay outside)
		k := f32(2 + m % 4)
		a := f32((m * 2) % 5) * f32(math.TAU) / (SPOKES * 0.5) + SPIRAL * (k * RING_SP)
		spawn_tower(&n, CENTER + [2]f32{math.cos(a), math.sin(a)} * (k * RING_SP), a)
	}

	// Salvage drones: a flight of helpers that seek wrecks and haul them to the pit.
	for i in 0 ..< MAX_HELPERS {
		a := f32(i) * f32(math.TAU) / MAX_HELPERS
		body_at(HELPER_LO + i)^ = {pos = CENTER + [2]f32{math.cos(a), math.sin(a)} * (PIT_R + 140), radius = R_HELPER, angle = a, kind = KIND_HELPER}
	}
}

// The same integer hash the shaders use (hash1 in common.glsl) — cluster centers need
// to be deterministic per warband, not per bot.
hashf :: proc(n: u32) -> f32 {
	x := n * 747796405 + 2891336453
	x = ((x >> ((x >> 28) + 4)) ~ x) * 277803737
	x = (x >> 22) ~ x
	return f32(x) / 4294967296.0
}

CLUSTER_SIZE :: 40 // bots per warband

// An enemy already mid-march at game start: warbands of CLUSTER_SIZE dotted around the
// wasteland (a uniform 80k scatter is a wall-to-wall carpet — packs leave readable
// ground). Variant mix 60/30/10 — matches spawn_enemy in physics.comp.
spawn_initial :: proc(i: int) -> (b: Body) {
	rv := rand.float32()
	switch {
	case rv < 0.6: b.variant = VAR_SPIDER; b.radius = R_SPIDER * rand.float32_range(0.85, 1.15); b.hp = HP_SPIDER
	case rv < 0.9: b.variant = VAR_SKITTER; b.radius = R_SKITTER * rand.float32_range(0.85, 1.15); b.hp = HP_SKITTER
	case:          b.variant = VAR_BRUTE; b.radius = R_BRUTE * rand.float32_range(0.9, 1.1); b.hp = HP_BRUTE
	}
	ci := u32(i / CLUSTER_SIZE) * 7919 + run_seed
	ctr: [2]f32
	if hashf(ci + 99) < 0.04 {
		// a rare warband is already IN the city on a street crossing — the horde lives
		// OUTSIDE; the city only crawls where the streams have broken through
		maxk := math.floor(city_r / RING_SP) - 1
		k := 2 + math.floor(hashf(ci + 101) * max(maxk - 1, 1)) // k≥2 keeps them off the spawn plaza
		rt := k * RING_SP
		ns := rt >= SPOKE2_R ? SPOKES : SPOKES * 0.5
		at := math.floor(hashf(ci + 102) * ns) * (f32(math.TAU) / ns) + SPIRAL * rt
		ctr = CENTER + [2]f32{math.cos(at), math.sin(at)} * rt
		b.pos = ctr + {rand.float32_range(-150, 150), rand.float32_range(-150, 150)}
	} else {
		for k in u32(0) ..< 12 {
			ctr = {hashf(ci + k * 3) * (WORLD - 400) + 200, hashf(ci + k * 3 + 1) * (WORLD - 400) + 200}
			if linalg.length(ctr - CENTER) > city_r + 650 && linalg.length(ctr - car_pos) > SPAWN_MIN_D + 400 { break }
		}
		b.pos = ctr + {rand.float32_range(-260, 260), rand.float32_range(-260, 260)}
		if d := linalg.length(b.pos - CENTER); d < city_r + 380 { // stragglers stay off the streets
			b.pos = CENTER + (b.pos - CENTER) * ((city_r + 380) / d)
		}
	}
	b.pos = linalg.clamp(b.pos, [2]f32{80, 80}, [2]f32{WORLD - 80, WORLD - 80})
	to := CENTER - b.pos
	b.angle = math.atan2(to.y, to.x)
	b.kind = KIND_ENEMY
	return
}

game_update :: proc(dt: f32) {
	w, h := f32(win_w), f32(win_h)
	aim_world = cam + (input.mouse - [2]f32{w, h} * 0.5) * ZOOM

	// ── the pit feeds the city: poll the GPU's deposit counter, push the radius out.
	// The city is analytic, so growth is just the number — no grid to regenerate.
	if dep := stats_at(0)^; dep != deposits_seen {
		city_r = min(city_r + f32(dep - deposits_seen) * DEPOSIT_GROW, CITY_RMAX)
		deposits_seen = dep
	}

	// ── hover ship: thrust along the nose, low grip so momentum carries sideways
	// (drift!), Space dumps boost into the mains. Yaw works even at a standstill.
	throttle: f32 = 0
	if input.up { throttle += 1 }
	if input.down { throttle -= 0.6 }
	steer: f32 = 0
	if input.right { steer += 1 }
	if input.left { steer -= 1 }
	boosting := input.boost && throttle > 0

	sp := linalg.length(car_vel)
	car_angle += steer * SHIP_TURN * dt * (0.55 + 0.45 * clamp(sp / 420, 0, 1))
	fwd := [2]f32{math.cos(car_angle), math.sin(car_angle)}
	accel := throttle > 0 ? f32(SHIP_ACCEL) : f32(SHIP_REV)
	if boosting { accel *= 1.9 }
	car_vel += fwd * throttle * accel * dt
	vf := linalg.dot(car_vel, fwd)
	side := car_vel - fwd * vf
	vf *= math.exp(-SHIP_DRAG * dt)
	side *= math.exp(-SHIP_GRIP * dt)
	car_vel = fwd * vf + side
	maxsp := boosting ? f32(SHIP_BOOST_MAX) : f32(SHIP_MAX)
	if sp = linalg.length(car_vel); sp > maxsp {
		car_vel *= 1 - (1 - maxsp / sp) * (1 - math.exp(-3 * dt)) // soft cap: boost bleeds off, no jerk
	}
	car_pos += car_vel * dt
	collide_city(&car_pos, &car_vel, CAR_RADIUS)
	for a in 0 ..< 2 {
		if car_pos[a] < CAR_RADIUS + 4 { car_pos[a] = CAR_RADIUS + 4; car_vel[a] = max(car_vel[a], 0) }
		if car_pos[a] > WORLD - CAR_RADIUS - 4 { car_pos[a] = WORLD - CAR_RADIUS - 4; car_vel[a] = min(car_vel[a], 0) }
	}
	throttle_v += (abs(throttle) - throttle_v) * (1 - math.exp(-8 * dt))
	boost_v += ((boosting ? f32(1) : 0) - boost_v) * (1 - math.exp(-7 * dt))
	laser_v += ((input.laser ? f32(1) : 0) - laser_v) * (1 - math.exp(-9 * dt))
	perp := [2]f32{-fwd.y, fwd.x}
	lean := clamp(linalg.dot(car_vel, perp) / 520, -1, 1) // drift slip → banking, read by body.frag
	body_at(0)^ = {pos = car_pos, vel = car_vel, radius = CAR_RADIUS, life = lean, angle = car_angle, kind = KIND_PLAYER}

	// ── chase camera: lead toward the aim and along the velocity, exp-smoothed.
	lead := aim_world - car_pos
	if l := linalg.length(lead); l > 260 { lead *= 260 / l }
	target := car_pos + lead * 0.32 + car_vel * 0.28
	cam += (target - cam) * (1 - math.exp(-4.5 * dt))
	cam = linalg.clamp(cam, [2]f32{w, h} * (0.35 * ZOOM), [2]f32{WORLD, WORLD} - [2]f32{w, h} * (0.35 * ZOOM))
	cam_shake *= math.exp(-6.5 * dt)
	muzzle *= math.exp(-13 * dt)

	// ── giant laser (RMB): pure GPU interaction — the beam itself lives in the push
	// constants; here it just rattles the camera and leans the ship back off the thrust.
	if laser_v > 0.05 {
		if off := aim_world - car_pos; linalg.length(off) > 0.001 {
			car_vel -= linalg.normalize(off) * 300 * laser_v * dt
		}
		cam_shake = min(cam_shake + laser_v * 7 * dt, 4)
	}

	// ── fire: dual alternating barrels toward the mouse, with recoil + shake.
	fire_timer -= dt
	if input.fire && fire_timer <= 0 {
		if off := aim_world - car_pos; linalg.length(off) > 0.001 {
			a := linalg.normalize(off)
			ap := [2]f32{-a.y, a.x}
			body_at(BULLET_LO + bullet_head)^ = {
				pos    = car_pos + a * (CAR_RADIUS + 14) + ap * (barrel * 5),
				vel    = a * BULLET_SPEED + car_vel * 0.45,
				radius = BULLET_RADIUS, life = BULLET_LIFE, hp = 1,
				angle  = math.atan2(a.y, a.x), kind = KIND_BULLET, variant = VAR_BOOM,
			}
			bullet_head = (bullet_head + 1) % MAX_BULLETS
			fire_timer = FIRE_INTERVAL
			barrel = -barrel
			muzzle = 1
			cam_shake = min(cam_shake + 3.2, 8) // artillery, not a rifle
			car_vel -= a * 42                   // heavy recoil
		}
	}
}

// Push the ship out of the house rect under it (analytic face normal), kill velocity
// into the facade. Anywhere without a building — streets, plazas, courtyards, terrace
// gaps — is open to fly. Mirrors building_push in physics.comp.
collide_city :: proc(pos: ^[2]f32, vel: ^[2]f32, r: f32) {
	sd, n := house_pen(pos^)
	if sd >= r { return }
	pos^ += n * (r - sd)
	if vn := linalg.dot(vel^, n); vn < 0 { vel^ -= n * vn * 1.2 } // cancel + a small bounce
	// never let wall bounces add net energy (a corner wedge would slingshot the ship)
	if sp := linalg.length(vel^); sp > SHIP_BOOST_MAX { vel^ *= SHIP_BOOST_MAX / sp }
}
