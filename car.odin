package main

import "core:math"
import "core:math/linalg"
import "core:math/rand"
import "core:mem"

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
KIND_ALLY   :: u32(8) // YOUR army: tanks/gun-cars/gunner mechs pushing out the avenues,
                      //   suicide drones + bombers staged at the CENTER, sortieing out
VAR_SPIDER  :: u32(0)
VAR_SKITTER :: u32(1)
VAR_BRUTE   :: u32(2)
VAR_SPARK   :: u32(3) // pit-sink burst (small, fast)
VAR_BOOM    :: u32(4) // detonation: an expanding shockwave that flings the horde
VAR_TANK    :: u32(5) // ally tracked tank: holds the line, shells the horde
VAR_RAIDER  :: u32(6) // ally gun-car: circles its prey, strafing
VAR_SUICIDE :: u32(7) // ally flying drone bomb: staged at the center, dives the horde
VAR_GUNNER  :: u32(8) // ally rifle mech: marches the avenues hosing autofire
VAR_BOMBER  :: u32(9) // ally high wing: patrols from the center, dive-bombs warbands
VAR_MINE    :: u32(10) // player proximity mine (a KIND_BULLET that waits, then BOOMs)
// mounted-weapon ids the shaders branch on — MUST equal the Weapon enum positions
WEAP_SING   :: u32(9)  // Z: the SINGULARITY — a charging well that reels the horde
                       //    into the cursor, then erupts into a massive ring bomb
WEAP_BEAMS  :: u32(10) // X: twin giant lasers off the flanks
WEAP_SCYTHE :: u32(11) // C: a laser blade sweeping an arc around the aim
WEAP_FLAMER :: u32(12) // V: rolling fire cone — burns + shoves the horde back
WEAP_ARC    :: u32(13) // B: crackling discharge field around the rig
WEAP_VORTEX :: u32(14) // N: drags the horde into the cursor (herding, no damage)
// the GARAGE — 1..9 pick what the PLAYER body is (player.variant = ride index)
RIDE_TRUCK    :: u32(0)
RIDE_BUGGY    :: u32(1)
RIDE_SPORT    :: u32(2)
RIDE_APC      :: u32(3)
RIDE_TANK     :: u32(4) // the huge tank
RIDE_GUNNER   :: u32(5)
RIDE_MECH     :: u32(6)
RIDE_COLOSSUS :: u32(7) // ABSOLUTELY MASSIVE mech — its laser scales up (laser_k)
RIDE_WING     :: u32(8) // you fly: no building collision, no contact
MAX_ENEMIES :: 80000
MAX_BULLETS :: 384
MAX_TURRETS :: 64
MAX_HELPERS :: 240 // a SWARM of salvage drones — they do all the hauling
MAX_ALLIES  :: 64  // the army (one shared-cache page: slots 0-17 tanks, 18-31 gun-cars,
                   //   32-43 gunner mechs, 44-55 suicide drones, 56-63 bombers)
ENEMY_LO    :: 1
BULLET_LO   :: 1 + MAX_ENEMIES
TURRET_LO   :: BULLET_LO + MAX_BULLETS
HELPER_LO   :: TURRET_LO + MAX_TURRETS
ALLY_LO     :: HELPER_LO + MAX_HELPERS
CAR_RADIUS  :: f32(20)
WORLD       :: f32(18800) // world is [0,WORLD]²; the city grows from the center, wasteland everywhere else
PIT_R       :: f32(230)          // the corpse pit at the world center
RING_SP     :: f32(560)          // ring-road spacing (curved streets: wobbled rings + spiral spokes)
SPOKES      :: f32(10)           // radial avenue count (only half run all the way to the core)
SPOKE2_R    :: RING_SP * 4       // the staggered second half of the avenues starts out here
SPIRAL      :: f32(0)            // avenues run STRAIGHT out — they cross the rings at right angles, so every block corner is square
STREET_HW   :: f32(105)          // street half-width (the paved part) — wide boulevards
BLDG_EDGE   :: STREET_HW + 14    // building facades rise at this distance from the centerline
PLAZA_P     :: f32(0.14)         // chance a block hosts a plaza — almost everything is BUILT
PLAZA_R     :: f32(215)          // the plaza: a CIRCLE carved out of its block, ringed by houses
MAIN_XW     :: f32(150)  // the MAIN STREET: the j=0 avenue (due east, straight to the pit) gets this much EXTRA half-width — a monumental boulevard
SPAWN_MIN_D :: f32(680)  // spawns avoid appearing this close to the ship
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
R_HELPER    :: f32(22) // big enough to READ as the salvage fleet
BOOM_R      :: f32(170)  // every bullet detonates: shockwave reach
BOOM_T      :: f32(0.65) //   and expansion time — slow enough to READ the front hit bots one by one
BULLET_SPEED :: f32(1650) // FAST — a slow shell reads mushy; shaders derive the trail length from it
DEATH_T     :: f32(0.5)  // pop → collapse → GONE
SPARK_T     :: f32(0.9)  // the pit sink: the husk rides the shaft down and goes under, quietly
SPD_SPIDER  :: f32(130)
SPD_SKITTER :: f32(235)
SPD_BRUTE   :: f32(80)
R_SPIDER    :: f32(15)
R_SKITTER   :: f32(9)
R_BRUTE     :: f32(27)
R_TANK      :: f32(28) // ally chassis sizes
R_RAIDER    :: f32(14)
R_SUICIDE   :: f32(12)
R_GUNNER    :: f32(17)
R_BOMBER    :: f32(30)
HP_SPIDER   :: f32(3)
HP_SKITTER  :: f32(1)
HP_BRUTE    :: f32(10)
HP_TANK     :: f32(40) // ally hit points (spawn_ally in physics.comp + battle_damage read these)
HP_RAIDER   :: f32(12)
HP_SUICIDE  :: f32(6)
HP_GUNNER   :: f32(16)
HP_BOMBER   :: f32(12)
TANK_RATE   :: f32(0.45) // ally tank cannon: volleys per second,
TANK_MV     :: f32(2000) //   shell muzzle velocity (px/s),
TANK_RNG    :: f32(950)  //   engagement range — enemies + body.frag derive the slug from time + slot id
RAID_RNG    :: f32(520)  // ally gun-car firing range (it orbits its prey at ~320)
GUN_RNG     :: f32(720)  // ally gunner mech stream range
KNOCKBACK   :: f32(90)
ZOOM        :: f32(1.35) // world px per screen px — pulled back so the horde reads
LEAN        :: f32(95)   // oblique fake-3D: world px of straight up-screen lean per unit height — a pure TRANSLATION, so buildings never shear. Tuned so towers read TALL while the view stays TOP-DOWN
HMAX        :: f32(3.0)  // height ceiling (march top): ordinary buildings live ≤ 1.0, SKYSCRAPERS/landmarks/giants climb WAY above it
// @glsl-end

// CPU-only tuning — the GARAGE. Keys 1-9 pick the ride, F/G/H/J/K/L pick its build,
// Q/E/R/T/Y/U/I/O/P pick the weapon (W/A/S/D keep driving; restart moved to BACKSPACE).
Ride_Def :: struct {
	r, accel, rev, max, boost, grip, drag, turn, fire: f32, // chassis + drive feel + cadence mult
	walker, airborne: bool, // walkers never drift; airborne skips buildings + contact
}
RIDES := [9]Ride_Def{
	{20, 1600,  900,  760, 1150,  9.0, 1.15, 3.4, 1.00, false, false}, // 1 TRUCK — the classic
	{14, 2100, 1100,  980, 1400,  7.0, 1.05, 4.2, 0.80, false, false}, // 2 BUGGY — light gun-car
	{16, 2400, 1000, 1150, 1550,  5.0, 0.90, 3.8, 0.95, false, false}, // 3 SPORT — loose-tail drift missile
	{27, 1300,  700,  540,  760, 11.0, 1.60, 2.6, 0.85, false, false}, // 4 APC — heavy plow
	{40, 1100,  600,  310,  420, 14.0, 2.20, 1.9, 2.30, true,  false}, // 5 TANK — huge, slow, heavy gun
	{24, 2200,  900,  400,  600, 12.0, 2.80, 3.0, 0.50, true,  false}, // 6 GUNMECH — nimble walker battery
	{36, 2400,  900,  340,  560, 12.0, 3.00, 2.6, 0.60, true,  false}, // 7 MECH — the big walker
	{66, 1600,  700,  210,  330, 14.0, 3.20, 1.5, 0.45, true,  false}, // 8 COLOSSUS — massive; HUGE laser
	{30, 2000, 1000, 1050, 1500,  2.2, 0.55, 3.2, 0.70, false, true},  // 9 WING — you FLY
}
STYLES := [6]struct { scale, speed, fire: f32 }{ // F G H J K L — the build of the ride
	{1.00, 1.00, 1.00}, // F standard
	{0.80, 1.30, 0.85}, // G scout — smaller, faster
	{1.30, 0.80, 1.20}, // H heavy — bigger, slower
	{0.90, 1.55, 1.00}, // J racer
	{1.60, 0.62, 1.45}, // K colossal
	{1.10, 1.10, 0.62}, // L prototype — rapid fire
}
// Q E R T Y U I O P = shell patterns; Z X C V B N M = MOUNTED hardware (the WEAP_* ids
// above must match this order — the shaders branch on pc.pweap for the held mounts).
Weapon :: enum {
	Cannon, Auto, Burst, Rail, Mortar, Lance, Nova, Wall, Airstrike, // shells
	Sing, Beams, Scythe, Flamer, Arc, Vortex,                        // held mounts (LMB hoses/charges)
	Mines,                                                           // M: drops off the tail
}
WEAPON_INT := [Weapon]f32{ // seconds between triggers, × ride.fire × style.fire
	.Cannon = 0.24, .Auto = 0.07, .Burst = 0.55, .Rail = 0.60, .Mortar = 0.95,
	.Lance = 0.10, .Nova = 1.60, .Wall = 1.60, .Airstrike = 3.00,
	.Sing = 0.1, .Beams = 0.1, .Scythe = 0.1, .Flamer = 0.1, .Arc = 0.1, .Vortex = 0.1, // held: no trigger cadence
	.Mines = 0.30,
}
BULLET_RADIUS  :: f32(11)
VEL_HARD_CAP   :: f32(1800) // wall bounces must never add net energy, whatever the ride
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
fire_v:      f32 // smoothed LMB hold for the MOUNTED weapons (Z..N) → pc.pfire
sing_charge: f32 // the SINGULARITY's charge 0..1 (drives its pull + core; pc.pfire while on Z)
fire_timer:  f32
bullet_head: int
barrel:      f32 // the two barrels alternate: ±1
gait_odo:    f32 // walker rides: integrated gait phase (rad) — packed into the player
                 //   body's `life` so body.frag plants the feet against real travel
run_seed:      u32 // per-run salt for the warband cluster hash
ride:          int // 1-9: which garage vehicle the player body is (index into RIDES)
style:         int // F/G/H/J/K/L: the ride's build (index into STYLES)
weapon:        Weapon // Q..P: what LMB does
city_r:        f32 // current city radius — grows as the pit is fed (pushed to the GPU)
deposits_seen: u32 // last pit-counter value read from the Stats buffer
input:       struct { up, down, left, right, fire, boost, ebrake, laser: bool, mouse: [2]f32 }

// Pointers into the mapped GPU buffers.
body_at :: proc(i: int) -> ^Body { return (^Body)(uintptr(buf_map[.Body]) + uintptr(i * size_of(Body))) }
stats_at :: proc(i: int) -> ^u32 { return (^u32)(uintptr(buf_map[.Stats]) + uintptr(i * 4)) }
city_at :: proc(i: int) -> ^u32 { return (^u32)(uintptr(buf_map[.City]) + uintptr(i * 4)) }
skid_at :: proc(i: int) -> ^u8 { return (^u8)(uintptr(buf_map[.Skid]) + uintptr(i)) }

skid_prev: [2][2]f32 // last frame's rear-wheel positions (skid stamping)

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
	jn := math.round(sa / stp)
	ds := abs(sa - jn * stp) * r
	if jn == 0 { ds -= MAIN_XW } // the j=0 avenue is the MAIN STREET — MAIN_XW wider, all the way to the pit
	d = min(d, ds)
	if r > SPOKE2_R {
		sa2 := sa + stp * 0.5
		da2 := sa2 - math.round(sa2 / stp) * stp
		d = min(d, abs(da2) * r)
	}
	return d
}

// CPU-only hash for GENERATING the block layout table (game_init) — the GPU never
// recomputes it, it reads the table, so no bit-matching is required anywhere.
hash21o :: proc(p: [2]f32) -> f32 {
	q := linalg.fract(p * [2]f32{123.34, 456.21})
	q += linalg.dot(q, q + 45.32)
	return math.mod(q.x * q.y, 1)
}

// The solid BLOCK under p — whole building blocks are hit area; the car and the horde
// live in the STREET corridor (plazas + wasteland stay open). Returns sd = BLDG_EDGE
// minus the distance to the nearest street (positive & large on open ground) + the
// normal TOWARD that street — analytic per boundary (inner ring / outer ring / nearest
// spoke), so there is no dead zone on the block's medial ridge and nothing can hide
// deep inside a block. MUST mirror building_push in physics.comp. The discrete houses
// (house_at in common.glsl) are visual + the shells' hit test only.
block_pen :: proc(p: [2]f32) -> (sd: f32, n: [2]f32) {
	sd = 1e9
	q := p - CENTER
	r := linalg.length(q)
	kb := math.floor(r / RING_SP)
	if kb < 1 || r > city_r - 60 { return }
	// the band only exists if it has DRAWABLE area: without this, a point on the
	// outermost ring street passes the r-gate and gets ejected off the facade of a
	// band that starts BEYOND the gate — an invisible wall at the city edge
	if kb * RING_SP + BLDG_EDGE >= city_r - 60 { return }
	ns := kb * RING_SP >= SPOKE2_R ? SPOKES : SPOKES * 0.5
	sa := math.atan2(q.y, q.x) - SPIRAL * r
	jb := math.floor(sa / (f32(math.TAU) / ns))
	di := r - kb * RING_SP        // to the inner ring centerline
	douter := (kb + 1) * RING_SP - r // to the outer ring centerline
	stp := f32(math.TAU) / (SPOKES * 0.5)
	jn := math.round(sa / stp)
	da := sa - jn * stp
	ds := abs(da) * r             // arc distance to the nearest spoke
	if jn == 0 { ds -= MAIN_XW }  // the MAIN STREET's faces sit MAIN_XW further back
	sgn := -math.sign(da)
	if r > SPOKE2_R {
		sa2 := sa + stp * 0.5
		da2 := sa2 - math.round(sa2 / stp) * stp
		if abs(da2) * r < ds { ds = abs(da2) * r; sgn = -math.sign(da2) }
	}
	rn := q / max(r, 0.001)
	if di <= douter && di <= ds { sd = BLDG_EDGE - di; n = -rn }
	else if douter <= ds { sd = BLDG_EDGE - douter; n = rn }
	else { sd = BLDG_EDGE - ds; n = [2]f32{-q.y, q.x} / max(r, 0.001) * sgn }
	// the carved plaza circle is open ground too — mirrors block_plaza in common.glsl
	jw := jb - ns * math.floor(jb / ns) // wrap the seam
	if int(kb) < int(CITY_KMAX) && city_at(int(kb) * int(CITY_JMAX) + int(jw))^ == 0 {
		rc := (kb + 0.5) * RING_SP
		ac := (jw + 0.5) * f32(math.TAU) / ns + SPIRAL * rc
		heart := CENTER + [2]f32{math.cos(ac), math.sin(ac)} * rc
		dc := max(linalg.length(p - heart), 0.001)
		if sdc := PLAZA_R - dc; sdc > sd { sd = sdc; n = (heart - p) / dc }
	}
	return
}

game_init :: proc() {
	car_pos = CENTER + {0, -(PIT_R + 170)} // hovering just off the pit plaza
	car_vel = {}
	car_angle = 0
	cam = car_pos
	cam_shake, muzzle, throttle_v, boost_v, laser_v, fire_v, sing_charge, fire_timer = 0, 0, 0, 0, 0, 0, 0, 0
	bullet_head = 0
	barrel = 1
	gait_odo = 0
	ride, style = 0, 0
	weapon = .Cannon
	input = {}
	deposits_seen = 0
	for i in 0 ..< 64 { stats_at(i)^ = 0 }
	city_r = CITY_R0
	mem.zero(buf_map[.Skid], int(SKID_RES * SKID_RES)) // a fresh road: no rubber yet
	for wi in 0 ..< 2 { skid_prev[wi] = car_pos }

	// THE block layout, generated once here and read by BOTH sides — physics.comp and
	// city.frag index this same buffer (CITY), the CPU collides off the same mapped
	// memory. One source of truth: no CPU/GPU hash drift can ever split the layout.
	for k in 0 ..< int(CITY_KMAX) {
		for j in 0 ..< int(CITY_JMAX) {
			city_at(k * int(CITY_JMAX) + j)^ = hash21o([2]f32{f32(k), f32(j)} * 1.13 + 4.7) < PLAZA_P ? 0 : 1
		}
	}

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
	r_g := city_r + 120 // right on the city's shoulder — the wall of lasers guards the edge
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

	// The ARMY assembles at the CENTER: seed the slots dead with an instant countdown —
	// physics.comp's spawn_ally (the ONE source of ally stats/roles) births them on the
	// pit apron the first frame, and the columns march out the avenues from there.
	for i in 0 ..< MAX_ALLIES {
		body_at(ALLY_LO + i)^ = {kind = KIND_DEAD, life = 0.01, radius = 1}
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
// ground). Variant mix 60/30/10 — matches spawn_enemy in physics.comp. The horde is
// walkers only; the armor classes are YOURS (KIND_ALLY).
spawn_initial :: proc(i: int) -> (b: Body) {
	rv := rand.float32()
	hr := rand.float32_range(0.85, 1.15)
	switch {
	case rv < 0.6: b.variant = VAR_SPIDER; b.radius = R_SPIDER * hr; b.hp = HP_SPIDER
	case rv < 0.9: b.variant = VAR_SKITTER; b.radius = R_SKITTER * hr; b.hp = HP_SKITTER
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

	// ── city growth is OFF for now: the pit still swallows scrap (the drones' loop
	// stays alive) but the radius holds at CITY_R0. Re-enable by bumping city_r by
	// DEPOSIT_GROW per new deposit here.
	deposits_seen = stats_at(0)^

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
	// e-brake (cars only): the rear breaks LOOSE — sharper steering, collapsed lateral
	// grip, hard speed bleed: yank the wheel + Space = handbrake drift. Walkers plant
	// and pound; the WING just banks through the air (no buildings, no contact).
	rd := RIDES[ride]
	st := STYLES[style]
	pr := rd.r * st.scale
	drift := !rd.walker && !rd.airborne
	ebrake := input.ebrake && drift
	turn := rd.turn * (ebrake ? 1.45 : 1.0)
	grip := ebrake ? f32(1.1) : rd.grip
	car_angle += steer * turn * dt * (0.55 + 0.45 * clamp(sp / 420, 0, 1))
	fwd := [2]f32{math.cos(car_angle), math.sin(car_angle)}
	accel := (throttle > 0 ? rd.accel : rd.rev) * st.speed
	if boosting { accel *= 1.9 }
	car_vel += fwd * throttle * accel * dt
	if ebrake { car_vel *= math.exp(-1.9 * dt) }
	vf := linalg.dot(car_vel, fwd)
	side := car_vel - fwd * vf
	vf *= math.exp(-rd.drag * dt)
	side *= math.exp(-grip * dt)
	car_vel = fwd * vf + side
	maxsp := (boosting ? rd.boost : rd.max) * st.speed
	if sp = linalg.length(car_vel); sp > maxsp {
		car_vel *= 1 - (1 - maxsp / sp) * (1 - math.exp(-3 * dt)) // soft cap: boost bleeds off, no jerk
	}
	car_pos += car_vel * dt
	if rd.walker {
		// gait odometer: phase advances with real travel (signed — reversing steps back)
		// plus turning in place (the legs must step through a pivot). Rate mirrors
		// gait_ph in body.frag: feet plant when it holds, freeze at a standstill.
		kg := min(5.0 / pr, 0.22)
		gait_odo += (linalg.dot(car_vel, fwd) + abs(steer) * turn * pr * 0.6) * dt * kg
		// wrap in exact TAU multiples — invisible to the legs, keeps f32 precision
		if gait_odo > 1e4 { gait_odo -= f32(math.TAU) * 1500 }
		if gait_odo < -1e4 { gait_odo += f32(math.TAU) * 1500 }
	}
	if !rd.airborne { collide_city(&car_pos, &car_vel, pr) }
	for a in 0 ..< 2 {
		if car_pos[a] < pr + 4 { car_pos[a] = pr + 4; car_vel[a] = max(car_vel[a], 0) }
		if car_pos[a] > WORLD - pr - 4 { car_pos[a] = WORLD - pr - 4; car_vel[a] = min(car_vel[a], 0) }
	}
	// the horde is PHYSICAL: bot contacts + incoming tank/raider/gunner fire accumulate
	// a shove on the GPU (STATS[30/31], summed int px/s²) — apply it to the car (and
	// rattle the camera in proportion: getting shot at FEELS like something)
	shx := transmute(i32)stats_at(30)^
	shy := transmute(i32)stats_at(31)^
	if shx != 0 || shy != 0 {
		acc := [2]f32{f32(shx), f32(shy)}
		if l := linalg.length(acc); l > 2600 { acc *= 2600 / l }
		car_vel += acc * dt
		cam_shake = min(cam_shake + linalg.length(acc) * dt * 0.003, 7)
		stats_at(30)^ = 0
		stats_at(31)^ = 0
	}
	throttle_v += (abs(throttle) - throttle_v) * (1 - math.exp(-8 * dt))
	boost_v += ((boosting ? f32(1) : 0) - boost_v) * (1 - math.exp(-7 * dt))
	// the LANCE weapon (U) fires the laser off LMB too — RMB always burns it
	las := input.laser || (weapon == .Lance && input.fire)
	laser_v += ((las ? f32(1) : 0) - laser_v) * (1 - math.exp(-9 * dt))
	// the MOUNTED weapons (Z..N) are HELD, not triggered: LMB hoses them via pc.pfire —
	// physics.comp applies the burn and body.frag draws it, all off this one envelope
	held := false
	#partial switch weapon {
	case .Sing, .Beams, .Scythe, .Flamer, .Arc, .Vortex: held = true
	}
	fire_v += ((input.fire && held ? f32(1) : 0) - fire_v) * (1 - math.exp(-12 * dt))
	if fire_v > 0.05 { // mount feel: hum, thrust-back
		#partial switch weapon {
		case .Flamer:
			if off := aim_world - car_pos; linalg.length(off) > 0.001 {
				car_vel -= linalg.normalize(off) * 240 * fire_v * dt // the cone pushes back
			}
			cam_shake = min(cam_shake + fire_v * 4 * dt, 3)
		case .Beams, .Scythe, .Arc: cam_shake = min(cam_shake + fire_v * 5 * dt, 3.5)
		}
	}
	// ── the SINGULARITY (Z): hold = the well charges and REELS the horde into the
	// cursor (physics pulls off pc.pfire = the charge); release — or top it out — and
	// the point ERUPTS: a heart shell plus a ring of overlapping detonations blooming
	// outward through the crowd the well just packed together.
	if weapon == .Sing {
		if input.fire { sing_charge = min(sing_charge + dt / 1.8, 1) }
		if sing_charge >= 1 || (!input.fire && sing_charge > 0.12) {
			spawn_shell(aim_world - {70, 0}, aim_world, BULLET_SPEED) // the heart goes first
			for i in 0 ..< 8 {
				d := [2]f32{math.cos(f32(i) * f32(math.TAU) / 8), math.sin(f32(i) * f32(math.TAU) / 8)}
				t := aim_world + d * 110
				spawn_shell(t - d * (90 + f32(i) * 16), t, BULLET_SPEED)
			}
			cam_shake = 8
			muzzle = 1
			sing_charge = 0
		} else if !input.fire {
			sing_charge = 0 // let go early: the well just collapses, no bomb
		}
		cam_shake = min(cam_shake + sing_charge * 9 * dt, 6) // the rumble builds with the charge
	} else {
		sing_charge = 0
	}
	perp := [2]f32{-fwd.y, fwd.x}
	// drift slip → banking, read by body.frag; walkers never bank — their `life` slot
	// carries the gait odometer instead (the legs stride against real travel)
	lean := drift ? clamp(linalg.dot(car_vel, perp) / 520, -1, 1) : 0
	// hp=999: battle_damage's soot/ember overlay must never touch the player's rig
	body_at(0)^ = {pos = car_pos, vel = car_vel, radius = pr, life = rd.walker ? gait_odo : lean, hp = 999, angle = car_angle, kind = KIND_PLAYER, variant = u32(ride), gen = u32(style)}

	// ── blast pressure: every detonation near the player SHOVES the ride and rattles
	// the camera — physics publishes the live blast list into STATS[2..] (the same list
	// the composite warps the screen with). Suicide drones hit HARD through this.
	nblast := min(int(stats_at(2)^), 8)
	for i in 0 ..< nblast {
		bp := [2]f32{transmute(f32)stats_at(3 + i * 3)^, transmute(f32)stats_at(4 + i * 3)^}
		prog := transmute(f32)stats_at(5 + i * 3)^
		off := car_pos - bp
		if l := linalg.length(off); l > 0.001 && l < BOOM_R * 1.4 {
			k := (1 - prog) * (1 - l / (BOOM_R * 1.4))
			car_vel += off / l * 2400 * k * dt
			cam_shake = min(cam_shake + 16 * k * dt, 8) // gentler ramp: a wall of blasts shouldn't pin the shake at max
		}
	}

	// ── skid marks: while the tail is loose, stamp rubber into the decal grid — REAL
	// persistent texture on the ground (city.frag samples it)
	slip := clamp(abs(lean) * 1.5, 0, 1)
	for wi in 0 ..< 2 {
		s := f32(wi) * 2 - 1
		wheel := car_pos + [2]f32{
			math.cos(car_angle) * -13.5 - math.sin(car_angle) * (s * 12.5),
			math.sin(car_angle) * -13.5 + math.cos(car_angle) * (s * 12.5),
		}
		if slip > 0.3 {
			d := wheel - skid_prev[wi]
			steps := int(linalg.length(d) / 3) + 1
			for k in 0 ..= steps {
				pt := skid_prev[wi] + d * (f32(k) / f32(steps))
				tx := int(clamp(pt.x / 4, 0, f32(SKID_RES - 1)))
				ty := int(clamp(pt.y / 4, 0, f32(SKID_RES - 1)))
				b := skid_at(ty * int(SKID_RES) + tx)
				b^ = max(b^, u8(110 + slip * 110))
			}
		}
		skid_prev[wi] = wheel
	}

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

	// ── fire (LMB): every weapon is a PATTERN of the same detonating shell — each one
	// flies STRAIGHT to its target point and booms exactly there (life = flight time;
	// physics booms on expiry). Q..P pick the pattern; cadence scales with the ride.
	fire_timer -= dt
	if input.fire && weapon != .Lance && !held && fire_timer <= 0 {
		if off := aim_world - car_pos; linalg.length(off) > 0.001 {
			a := linalg.normalize(off)
			ap := [2]f32{-a.y, a.x}
			// walkers fire from the shoulder hardpoints (fixed in the BODY frame, matching
			// player_mech's mounts) — cars from the hull turret
			muz: [2]f32
			if rd.walker {
				muz = car_pos + fwd * (-0.04 * pr) + perp * (barrel * pr * 0.50) + a * (pr * 0.95)
			} else {
				muz = car_pos + a * (pr + 14) + ap * (barrel * 5)
			}
			switch weapon {
			case .Cannon: spawn_shell(muz, aim_world, BULLET_SPEED)
			case .Auto:   spawn_shell(muz, aim_world + {rand.float32_range(-34, 34), rand.float32_range(-34, 34)}, BULLET_SPEED)
			case .Burst:  for i in -1 ..= 1 { spawn_shell(muz, aim_world + ap * (f32(i) * 90), BULLET_SPEED) }
			case .Rail:   spawn_shell(muz, aim_world, 4400) // near-hitscan slug
			case .Mortar: for _ in 0 ..< 5 { spawn_shell(muz, aim_world + {rand.float32_range(-150, 150), rand.float32_range(-150, 150)}, BULLET_SPEED) }
			case .Lance:  // handled above: LMB holds the laser
			case .Nova:   for i in 0 ..< 8 { // defensive ring blast around the rig
				d := [2]f32{math.cos(f32(i) * f32(math.TAU) / 8), math.sin(f32(i) * f32(math.TAU) / 8)}
				spawn_shell(car_pos + d * (pr + 12), car_pos + d * 320, BULLET_SPEED)
			}
			case .Wall: for i in -2 ..= 2 { spawn_shell(muz, aim_world + ap * (f32(i) * 130), BULLET_SPEED) } // area-denial line
			case .Airstrike: for i in 0 ..< 7 { // the strike: a stick of shells sweeping in
				// along the aim line, detonations marching down-range one after another
				t := aim_world + a * (f32(i - 3) * 105)
				fl := 0.22 + f32(i) * 0.055
				spawn_shell(t - a * (BULLET_SPEED * fl), t, BULLET_SPEED)
			}
			case .Mines: // a proximity mine dropped off the tail — it settles, arms, and
				// BOOMs when the horde steps close (physics owns the trip)
				body_at(BULLET_LO + bullet_head)^ = {
					pos    = car_pos - fwd * (pr + 12),
					vel    = car_vel * 0.2 - fwd * 60,
					radius = BULLET_RADIUS,
					hp     = 25, // total fuse — physics arms it a beat after (hp - life)
					life   = 25,
					angle  = car_angle, kind = KIND_BULLET, variant = VAR_MINE,
				}
				bullet_head = (bullet_head + 1) % MAX_BULLETS
			case .Sing, .Beams, .Scythe, .Flamer, .Arc, .Vortex: // held mounts — gated out above
			}
			fire_timer = WEAPON_INT[weapon] * rd.fire * st.fire
			barrel = -barrel
			muzzle = weapon == .Mines ? muzzle : 1
			heavy := weapon == .Rail || weapon == .Airstrike || ride == int(RIDE_TANK)
			cam_shake = min(cam_shake + (weapon == .Mines ? 0.5 : weapon == .Auto ? 0.5 : heavy ? 6.0 : rd.walker ? 2.6 : 4.2), 8) // Auto: rapid cadence → tiny per-shot kick so it doesn't saturate
			car_vel -= a * (rd.walker ? 16 : 58) * (weapon == .Auto ? 0.3 : weapon == .Mines ? 0 : 1) // recoil
		}
	}
}

// One detonating shell, flying straight from → to and booming exactly there.
spawn_shell :: proc(from, to: [2]f32, speed: f32) {
	off := to - from
	l := linalg.length(off)
	if l < 0.001 { return }
	a := off / l
	flight := max(l, 40) / speed
	body_at(BULLET_LO + bullet_head)^ = {
		pos    = from,
		vel    = a * speed,
		radius = BULLET_RADIUS,
		hp     = flight, // TOTAL flight time — shaders derive distance-travelled (the trail it leaves)
		life   = flight, // remaining flight time (physics booms on expiry)
		angle  = math.atan2(a.y, a.x), kind = KIND_BULLET, variant = VAR_BOOM,
	}
	bullet_head = (bullet_head + 1) % MAX_BULLETS
}

// Push the car out of the solid block under it, kill velocity into the block face.
// Streets, plazas and the wasteland are open to drive. Mirrors building_push in
// physics.comp.
collide_city :: proc(pos: ^[2]f32, vel: ^[2]f32, r: f32) {
	sd, n := block_pen(pos^)
	if sd >= r { return }
	pos^ += n * (r - sd)
	if vn := linalg.dot(vel^, n); vn < 0 { vel^ -= n * vn * 1.2 } // cancel + a small bounce
	// never let wall bounces add net energy (a corner wedge would slingshot the ship)
	if sp := linalg.length(vel^); sp > VEL_HARD_CAP { vel^ *= VEL_HARD_CAP / sp }
}
