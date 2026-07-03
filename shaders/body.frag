#version 460
#include "common.glsl"

// Every body as a procedural SDF sprite in its own body frame (+x = facing): the hover
// ship with its turret/flash/boost flame/giant laser, the invading mechs, gate pylons,
// towable wrecks, bullet bolts, death breakups. Output is premultiplied; `add` is pure
// emissive (HDR > 1) that feeds the bloom pass.
//
// The BOTS are painted like flat military-illustration mechs, not shiny metal: matte
// khaki/olive armor plates with hard two-tone cel shading, chipped paint speckles and
// small orange unit markings. Red glow is reserved for sensors/cores — on the night
// ground the horde reads as a field of red eyes. Battle damage shows: below half HP the
// paint chars and embers gutter out of the hull.

// Vertex → fragment interface (must match body.vert's `out`s).
layout(location = 0) in vec2      v_local;
layout(location = 1) in flat uint v_id;
layout(location = 0) out vec4 o_color;

// the invaders' paint (linear; the composite sRGB-encodes) — dusty greys, red markings:
// everything lives in the 60/30/10 palette, hue is reserved for the accents
const vec3 BOT_KHAKI  = vec3(0.30, 0.28, 0.25);  // dust-grey plate
const vec3 BOT_OLIVE  = vec3(0.17, 0.16, 0.145); // darker grey plate
const vec3 BOT_ORANGE = vec3(0.72, 0.14, 0.05);  // red unit marking
const vec3 BOT_LINE   = vec3(0.045, 0.045, 0.040); // panel lining / lower struts

const vec3 SHIP_CHROME = vec3(0.40, 0.41, 0.44); // polished trim (helper dome)

// painter state: alpha-composited base + emissive add
vec3  base = vec3(0.0);
float cov  = 0.0;
vec3  add  = vec3(0.0);
vec2  gL   = vec2(-0.7, -0.7); // light dir in body frame, set per bot
float gCS  = 3.0;              // paint-chip cell size, scaled to the bot

void lay(vec3 c, float a) {
	a = clamp(a, 0.0, 1.0);
	base = mix(base, c, a);
	cov = max(cov, a);
}

float soft(float d) { return 1.0 - smoothstep(-1.2, 1.2, d); } // sdf → coverage

// One armor plate: hard two-tone cel shade split across the plate center along the
// light, chipped paint, dark lining at the edge — and a crisp specular bevel on the
// lit side, so every plate reads as machined METAL.
void plate(vec2 p, vec2 ctr, float d, vec3 c, float seed) {
	float litSide = step(0.0, dot(p - ctr, gL));
	float shade = mix(0.66, 1.08, litSide);
	vec3 col = c * shade;
	float ch = hash21(floor(p / gCS) + seed * 17.0);
	col = mix(col, c * 0.42, step(0.93, ch) * 0.75);     // chipped paint
	float bevel = smoothstep(-3.6, -2.4, d) * (1.0 - smoothstep(-2.4, -1.6, d));
	col += vec3(0.30, 0.31, 0.34) * bevel * litSide;     // specular bevel glint
	col = mix(col, BOT_LINE, smoothstep(-2.4, -1.1, d)); // panel lining
	lay(col, soft(d));
}

// One mech leg, Citadel-style: chunky armored upper-leg plate → knee cap → thin dark
// lower strut → foot pad. `aa` = hip bearing, `ph` = gait phase.
void mech_leg(vec2 p, float r, float aa, float ph, float wUp, float wLo) {
	float stp = sign(sin(ph)) * pow(abs(sin(ph)), 0.55); // piston stride
	vec2 hip  = rot2(aa) * vec2(r * 0.52, 0.0);
	vec2 knee = rot2(aa + stp * 0.10) * vec2(r * 1.35, 0.0);
	vec2 foot = rot2(aa + stp * 0.20) * vec2(r * 1.85, 0.0);
	knee.x += stp * r * 0.12;
	foot.x += stp * r * 0.26;
	// lower leg: short thick strut ending in a boxy foot pad, oriented along the leg
	vec2 dirLo = normalize(foot - knee + 0.0001);
	float angLo = atan(dirLo.y, dirLo.x);
	lay(BOT_LINE * 1.5, soft(sd_seg(p, knee, foot - dirLo * r * 0.12) - wLo * 1.4));
	vec2 qf = rot2(-angLo) * (p - foot);
	plate(p, foot, sd_box(qf, vec2(r * 0.13, r * 0.10)) - r * 0.04, BOT_OLIVE, aa + 3.0);
	// upper-leg armor plate, oriented hip→knee
	float ang = atan(knee.y - hip.y, knee.x - hip.x);
	vec2 q = rot2(-ang) * (p - hip);
	float lenU = length(knee - hip);
	float dU = sd_box(q - vec2(lenU * 0.5, 0.0), vec2(lenU * 0.55, wUp)) - wUp * 0.4;
	plate(p, mix(hip, knee, 0.5), dU, BOT_KHAKI, aa);
	// knee cap
	plate(p, knee, length(p - knee) - wUp * 0.75, BOT_OLIVE, aa + 9.0);
}

void ship(vec2 p, Body b) {
	// ── the giant laser first: it reaches far outside the hull, so the quad is huge
	// while burning — bail to beam-only past the hull's reach.
	if (pc.laser > 0.02) {
		float ta = atan(pc.aim.y - b.pos.y, pc.aim.x - b.pos.x) - b.angle;
		vec2 td = vec2(cos(ta), sin(ta));
		vec2 a0 = td * 26.0;
		vec2 a1 = td * (26.0 + LASER_LEN);
		float bd = sd_seg(p, a0, a1);
		float flick = 0.85 + 0.30 * sin(pc.time * 61.0 + dot(p, td) * 0.05)
		            + 0.10 * sin(pc.time * 173.0);
		float wCore = 3.0 * pc.laser * flick;
		float wHalo = LASER_W * pc.laser;
		add += (vec3(1.3, 1.0, 0.7) + PAL_EMBER * 0.5) * exp(-bd * bd / (wCore * wCore * 2.0)) * 1.3 * pc.laser;
		add += PAL_ACCENT * exp(-bd * bd / (wHalo * wHalo)) * 0.30 * pc.laser;
		add += PAL_EMBER * exp(-bd / (wHalo * 2.0)) * 0.08 * pc.laser;
		// hot star at the emitter
		float ed = length(p - a0);
		add += (PAL_EMBER * 1.5 + vec3(0.7)) * exp(-ed * ed / (50.0 * pc.laser + 8.0)) * pc.laser;
	}
	if (length(p) > 150.0) { return; } // beyond the hull: beam only

	// ── the TRUCK: long slab hull on proud wheels, cab + windshield up front, amber
	// running strips, red tails and BIG headlights throwing real cones down the street.
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8)); // screen light → body frame
	gCS = 3.2;
	float lean = clamp(b.life, -1.0, 1.0); // CPU packs drift slip here
	lay(vec3(0.012, 0.010, 0.010), 0.5 * soft(sd_box(p - vec2(7.0, 10.0), vec2(24.0, 8.0)) - 5.0)); // ground shadow
	p.y += lean * 1.4; // the body rolls a touch against the drift
	// wheels, slightly proud of the hull
	for (float sx = -1.0; sx <= 1.0; sx += 2.0) {
		for (float sy = -1.0; sy <= 1.0; sy += 2.0) {
			lay(PAL_BASE * 0.7, soft(sd_box(p - vec2(sx * 13.5, sy * 12.5), vec2(6.5, 3.2)) - 2.0));
		}
	}
	// hull: long rounded slab, beveled edges catching the light
	float hull = sd_box(p, vec2(23.0, 11.0)) - 4.0;
	float rim = clamp(dot(normalize(p + 0.0001), gL), 0.0, 1.0);
	vec3 mc = PAL_MID * (0.55 + 0.18 * sin(p.x * 0.9));
	mc = mix(mc, PAL_MID * (0.9 + rim * 1.2), smoothstep(-5.0, 0.0, hull));
	lay(mc, soft(hull));
	// panel seams
	float seamx = min(abs(p.x - 4.0), abs(p.x + 12.0));
	lay(PAL_BASE * 0.85, soft(hull) * smoothstep(1.2, 0.4, seamx) * 0.6);
	// cab + windshield up front
	lay(PAL_MID * 0.8, soft(sd_box(p - vec2(11.0, 0.0), vec2(7.0, 8.6)) - 2.5));
	float glass = sd_box(p - vec2(13.5, 0.0), vec2(3.4, 7.2)) - 2.0;
	lay(vec3(0.020, 0.021, 0.024), soft(glass));
	add += vec3(0.10, 0.105, 0.115) * soft(glass) * pow(clamp(dot(normalize(p - vec2(13.5, 0.0) + 0.0001), gL), 0.0, 1.0), 3.0);
	// amber running strips along the bed sides + red tail lights
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += PAL_EMBER * 1.3 * soft(sd_box(p - vec2(-8.0, s * 10.2), vec2(11.0, 0.9)));
		add += PAL_ACCENT * 1.6 * soft(sd_box(p - vec2(-25.5, s * 8.0), vec2(1.2, 2.2)));
	}
	// BIG headlights + long cones — the truck's lights carry the player's light budget
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		vec2 hl = vec2(22.5, s * 6.5);
		add += vec3(1.0, 0.90, 0.70) * 3.0 * soft(length(p - hl) - 2.6);
		vec2 hq = p - hl;
		float cone = smoothstep(0.50, 0.12, abs(atan(hq.y, hq.x))) * smoothstep(115.0, 5.0, hq.x) * step(0.0, hq.x);
		add += vec3(1.0, 0.90, 0.65) * cone * 0.30;
	}
	// rear thrusters: glow with the throttle, flame under boost
	float th = pc.throttle * 0.8 + pc.boost * 1.6;
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		vec2 en = vec2(-24.0, s * 6.0);
		add += PAL_EMBER * soft(length(p - en) - 2.6) * (0.35 + th * (1.8 + 0.5 * sin(pc.time * 43.0 + s)));
		if (pc.boost > 0.03) {
			float fl = sd_seg(p, en, en - vec2(12.0 + 10.0 * pc.boost * (0.7 + 0.3 * sin(pc.time * 57.0 + s * 2.0)), 0.0));
			add += (PAL_EMBER * 1.6 + vec3(0.4)) * exp(-fl * fl / 6.0) * pc.boost;
		}
	}
	// turret: mount + barrel toward the mouse, with recoil + muzzle flash
	float ta = atan(pc.aim.y - b.pos.y, pc.aim.x - b.pos.x) - b.angle;
	vec2 td = vec2(cos(ta), sin(ta));
	vec2 tm = vec2(-2.0, 0.0);
	float blen = 22.0 - pc.muzzle * 4.5; // recoil
	lay(BOT_LINE * 2.2, soft(sd_seg(p, tm, tm + td * blen) - 2.0));
	lay(PAL_MID * 0.5, soft(length(p - tm) - 6.0));
	lay(PAL_MID * 1.35, soft(length(p - tm) - 3.8));
	if (pc.muzzle > 0.02) { // hot star at the tip
		vec2 tip = tm + td * (blen + 3.0);
		float md = length(p - tip);
		float star = 1.0 + 0.5 * cos(atan(p.y - tip.y, p.x - tip.x) * 6.0 + pc.time * 90.0);
		float fl = exp(-md * md / (9.0 * star * pc.muzzle + 3.0)) * pc.muzzle;
		add += (PAL_EMBER * 2.2 + vec3(1.2)) * fl * 2.0;
	}
}

// Battle damage overlay: STAGED ruin — the paint scorches, then whole plates blow off
// over a glowing under-frame, panel seams run molten, electric shorts arc blue-white,
// embers gutter and smoke pours. A hurt bot should LOOK hurt long before it dies.
void battle_damage(vec2 p, Body b, float maxhp) {
	// fresh-hit spray: white-hot sparks fly while the flash is hot (beams keep this alive)
	if (b.life > 0.4) {
		float sp2 = hash21(floor(p / 4.0) + floor(pc.time * 24.0) * vec2(7.0, -9.0) + float(v_id));
		add += (PAL_EMBER + vec3(0.5)) * step(0.978, sp2) * b.life * 2.6 * cov;
	}
	float dmg = 1.0 - clamp(b.hp / maxhp, 0.0, 1.0);
	if (dmg < 0.10) { return; }
	float m = (dmg - 0.10) * 1.30;
	float cell = max(gCS * 1.6, 3.0);
	vec2 cid = floor(p / cell);
	float ch = hash21(cid + float(v_id));
	float throb = 0.7 + 0.3 * sin(pc.time * 7.0 + ch * 40.0 + float(v_id));
	// stage 1: scorch — the paint blisters and blackens patch by patch
	base = mix(base, vec3(0.030, 0.024, 0.020), m * smoothstep(0.30, 0.85, ch) * 0.8 * cov);
	// stage 2: plates blown clean off — the red-hot under-frame shows through the holes
	float gone = step(1.0 - m * 0.40, ch);
	base = mix(base, vec3(0.16, 0.03, 0.01), gone * cov);
	add += PAL_ACCENT * gone * m * 1.8 * throb * cov;
	// panel seams running molten between the wounds
	vec2 lc2 = fract(p / cell) - 0.5;
	float web = 1.0 - smoothstep(0.06, 0.16, min(abs(lc2.x), abs(lc2.y)));
	add += PAL_ACCENT * web * smoothstep(0.9 - m * 0.5, 0.95, ch) * m * 1.4 * throb * cov;
	// the whole armor heat-soaks red from inside as hp drains
	add += vec3(1.0, 0.10, 0.02) * m * m * 0.45 * cov * (0.75 + 0.25 * sin(pc.time * 6.0 + float(v_id)));
	// electric shorts: blue-white arcs snapping across heavy damage
	if (m > 0.45) {
		float az = hash21(cid + floor(pc.time * 18.0) + float(v_id) * 0.7);
		add += vec3(1.0, 1.0, 1.05) * step(0.965, az) * (m - 0.45) * 4.0 * cov;
	}
	// gutter sparks streaming off
	float sp = hash21(floor(p / 5.0) + pc.time * vec2(0.0, 3.0) + float(v_id));
	add += PAL_EMBER * step(0.982 - m * 0.03, sp) * m * 2.6 * cov;
	for (float i = 0.0; i < 2.0; i += 1.0) { // black smoke curling off the wounds
		float ph2 = fract(pc.time * 0.55 + hash1(v_id + uint(i) * 7u));
		vec2 sp2 = vec2(sin(pc.time * 1.3 + i * 2.6) * 6.0, -b.radius * 0.3 - ph2 * 22.0);
		lay(vec3(0.016, 0.015, 0.015), m * (1.0 - ph2) * 0.60 * soft(length(p - sp2) - (3.0 + ph2 * 8.0)));
	}
}

void spider(vec2 p, Body b, float t) {
	// Quad-leg spider mech: four chunky armored legs on a boxy painted hull with an
	// olive glacis, orange chevron marking, rear engine block and a red sensor slit.
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = max(r * 0.22, 2.8);
	lay(vec3(0.015), 0.35 * soft(length(p - vec2(4.0, 6.0)) - r * 0.95));
	float gt = t * (3.2 + length(b.vel) * 0.04);
	float wUp = r * 0.22, wLo = r * 0.075;
	mech_leg(p, r,  0.78, gt,           wUp, wLo); // diagonal gait: FL+RR, FR+RL
	mech_leg(p, r, -0.78, gt + 3.14159, wUp, wLo);
	mech_leg(p, r,  2.36, gt + 3.14159, wUp, wLo);
	mech_leg(p, r, -2.36, gt,           wUp, wLo);
	// hull: main deck + front glacis + rear engine block
	plate(p, vec2(0.0), sd_box(p, vec2(r * 0.72, r * 0.56)) - r * 0.14, BOT_KHAKI, 1.0);
	plate(p, vec2(r * 0.5, 0.0), sd_box(p - vec2(r * 0.5, 0.0), vec2(r * 0.26, r * 0.42)) - r * 0.08, BOT_OLIVE, 2.0);
	plate(p, vec2(-r * 0.55, 0.0), sd_box(p - vec2(-r * 0.55, 0.0), vec2(r * 0.20, r * 0.34)) - r * 0.06, BOT_OLIVE * 0.75, 3.0);
	// orange chevron unit marking on the deck
	float chv = min(sd_seg(p, vec2(r * 0.15, 0.0), vec2(-r * 0.20,  r * 0.30)),
	                sd_seg(p, vec2(r * 0.15, 0.0), vec2(-r * 0.20, -r * 0.30))) - r * 0.045;
	lay(BOT_ORANGE, soft(chv) * 0.75);
	// rear exhausts, faintly hot
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += PAL_EMBER * 0.5 * soft(length(p - vec2(-r * 0.72, s * r * 0.18)) - r * 0.07);
	}
	// sensor slit: dark housing, thin red glow — the eye in the dark
	lay(BOT_LINE, soft(sd_box(p - vec2(r * 0.62, 0.0), vec2(r * 0.07, r * 0.24))));
	add += PAL_ACCENT * 1.8 * soft(sd_box(p - vec2(r * 0.62, 0.0), vec2(r * 0.035, r * 0.17)));
	battle_damage(p, b, HP_SPIDER);
}

void skitter(vec2 p, Body b, float t) {
	// Light scout mech: narrow wedge hull on four thin quick legs, orange nose stripe.
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = max(r * 0.30, 2.8);
	lay(vec3(0.015), 0.30 * soft(length(p - vec2(3.0, 5.0)) - r * 0.9));
	float wUp = r * 0.16, wLo = r * 0.07;
	mech_leg(p, r,  0.95, t * 10.0,           wUp, wLo);
	mech_leg(p, r, -0.95, t * 10.0 + 3.14159, wUp, wLo);
	mech_leg(p, r,  2.25, t * 10.0 + 3.14159, wUp, wLo);
	mech_leg(p, r, -2.25, t * 10.0,           wUp, wLo);
	plate(p, vec2(0.0), sd_box(p, vec2(r * 1.02, r * 0.38)) - r * 0.18, BOT_OLIVE, 1.0);
	plate(p, vec2(r * 0.55, 0.0), sd_box(p - vec2(r * 0.58, 0.0), vec2(r * 0.30, r * 0.26)) - r * 0.10, BOT_KHAKI, 2.0);
	lay(BOT_ORANGE, soft(sd_box(p - vec2(-r * 0.25, 0.0), vec2(r * 0.48, r * 0.055))) * 0.85);
	add += PAL_ACCENT * 2.2 * soft(length(p - vec2(r * 0.95, 0.0)) - r * 0.11); // sensor
	battle_damage(p, b, HP_SKITTER);
}

void brute(vec2 p, Body b, float t) {
	// Super-heavy: six wide-plated legs under a massive deck with side missile pods,
	// a big chevron and hot core vents.
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = max(r * 0.18, 2.8);
	lay(vec3(0.015), 0.38 * soft(length(p - vec2(5.0, 7.0)) - r * 1.05));
	float gt = t * 2.2;
	float wUp = r * 0.20, wLo = r * 0.07;
	for (float i = 0.0; i < 3.0; i += 1.0) {
		for (float s = -1.0; s <= 1.0; s += 2.0) {
			float aa = s * (0.62 + i * 0.94);
			mech_leg(p, r, aa, gt + i * 2.09 + s * 0.5, wUp, wLo);
		}
	}
	plate(p, vec2(0.0), sd_box(p, vec2(r * 0.80, r * 0.64)) - r * 0.14, BOT_KHAKI, 1.0);
	// side missile pods with tube holes
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		vec2 pod = vec2(r * 0.08, s * r * 0.52);
		plate(p, pod, sd_box(p - pod, vec2(r * 0.34, r * 0.16)) - r * 0.05, BOT_OLIVE, s + 4.0);
		for (float k = -1.0; k <= 1.0; k += 1.0) {
			lay(BOT_LINE, soft(length(p - pod - vec2(k * r * 0.2, 0.0)) - r * 0.055));
		}
	}
	// forward glacis + big chevron
	plate(p, vec2(r * 0.55, 0.0), sd_box(p - vec2(r * 0.56, 0.0), vec2(r * 0.22, r * 0.34)) - r * 0.06, BOT_OLIVE, 6.0);
	float chv = min(sd_seg(p, vec2(r * 0.30, 0.0), vec2(-r * 0.10,  r * 0.34)),
	                sd_seg(p, vec2(r * 0.30, 0.0), vec2(-r * 0.10, -r * 0.34))) - r * 0.06;
	lay(BOT_ORANGE, soft(chv) * 0.9);
	// core vents: two hot slits, pulsing
	float pulse = 1.3 + 0.5 * sin(pc.time * 3.0 + float(v_id));
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += PAL_ACCENT * pulse * soft(sd_box(p - vec2(-r * 0.30, s * r * 0.14), vec2(r * 0.17, r * 0.028)));
	}
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += PAL_EMBER * 0.6 * soft(length(p - vec2(-r * 0.72, s * r * 0.22)) - r * 0.06); // exhausts
	}
	battle_damage(p, b, HP_BRUTE);
}

void turret(vec2 p, Body b) {
	// Defense tower: a heavy fortress ring with a rotating emitter. Perimeter giants
	// (outside the city) scythe slow massive laser bars; inner crossings mount MACHINE
	// GUNS hosing tracer streams that ricochet off the horde. Duty/sweep MUST match
	// physics.comp (hash1(v_id*77u) / hash1(v_id*913u)).
	float r = b.radius;
	bool mg = distance(b.pos, vec2(WORLD * 0.5)) < pc.city_r;
	float duty = mg ? 0.70 : 0.30;
	float rate = mg ? 0.90 : 0.14;
	float len  = mg ? MG_LEN : TWR_LEN;
	float phase = fract(pc.time * rate + hash1(v_id * 77u));
	bool firing = phase < duty;
	float env = smoothstep(0.0, 0.03, phase) * smoothstep(duty, duty - 0.04, phase); // ramp in/out
	float angW = hash1(v_id * 913u) * TAU + pc.time * (mg ? 2.6 : 0.22); // sweep, world frame
	vec2 bd2 = rot2(angW - b.angle) * vec2(1.0, 0.0);                    // fire dir, body frame
	if (mg) { // ── MACHINE GUN: real BULLETS. Each round flies straight at the barrel
		// angle it LEFT with — rewind the sweep by time-of-flight (MG_V) — so the stream
		// curls across the district like AA fire. physics.comp rewinds identically.
		float dpx = length(p);
		if (dpx > r * 0.45 && dpx < len) {
			float te = pc.time - dpx / MG_V; // when the round now at this range fired
			float ph2 = fract(te * rate + hash1(v_id * 77u));
			float envE = smoothstep(0.0, 0.03, ph2) * smoothstep(duty, duty - 0.04, ph2) * step(ph2, duty);
			float burstE = step(0.30, fract(te * 3.3 + hash1(v_id * 55u))); // the belt runs in bursts
			float angE = hash1(v_id * 913u) * TAU + te * 2.6;
			vec2 dir = rot2(angE - b.angle) * vec2(1.0, 0.0);
			if (dot(p, dir) > 0.0) {
				float perp = dot(p, vec2(-dir.y, dir.x));
				float u = te * 30.0; // 30 rounds/s off the belt
				float off = (hash21(vec2(floor(u), float(v_id))) - 0.5) * 10.0; // per-round spray
				float lat = exp(-pow(perp - off, 2.0) / 3.5);
				float cyc = fract(u);
				float slug = exp(-pow((cyc - 0.5) * 9.0, 2.0));               // the round itself
				float trail = exp(-(cyc - 0.5) * 6.0) * step(0.5, cyc) * 0.3; // its ember wake
				add += (vec3(1.45, 1.1, 0.7) * slug + PAL_EMBER * trail) * lat * envE * burstE * 2.4;
			}
		}
		if (firing) {
			float burst = step(0.30, fract(pc.time * 3.3 + hash1(v_id * 55u)));
			for (float i = 0.0; i < 3.0; i += 1.0) { // ricochets sparking off where rounds land
				uint si = v_id * 131u + uint(pc.time * 11.0) * 17u + uint(i) * 7u;
				float rng = len * (0.25 + 0.65 * hash1(si));
				float th = pc.time - rng / MG_V;
				vec2 hitp = rot2(hash1(v_id * 913u) * TAU + th * 2.6 - b.angle) * vec2(rng, 0.0);
				vec2 rq = rot2(hash1(si + 3u) * 2.4 - 1.2) * (p - hitp);
				add += PAL_EMBER * 2.2 * exp(-sd_seg(rq, vec2(0.0), vec2(26.0, 0.0)) * 1.5) * env * burst * hash1(si + 5u);
			}
			// hot brass spray at the mount
			float sp2 = hash1(uint(pc.time * 30.0) * 13u + v_id + uint(atan(p.y, p.x) * 3.0));
			add += PAL_EMBER * step(0.9, sp2) * exp(-dot(p, p) / (r * r * 2.0)) * env * burst;
		}
	} else if (firing) { // ── the giant laser: a two-sided lighthouse bar
		float bd = sd_seg(p, -bd2 * len, bd2 * len);
		float flick = 0.85 + 0.30 * sin(pc.time * 47.0 + dot(p, bd2) * 0.03);
		add += (vec3(1.3, 1.0, 0.7) + PAL_EMBER * 0.5) * exp(-bd * bd / (30.0 * flick)) * 1.5 * env;
		add += PAL_ACCENT * exp(-bd * bd / (TWR_W * TWR_W)) * 0.35 * env;
		add += PAL_EMBER * exp(-bd / (TWR_W * 2.5)) * 0.10 * env;
	}
	if (length(p) > r * 3.5) { return; } // beyond the fortress: fire only
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = 4.0;
	lay(vec3(0.012), 0.45 * soft(length(p - vec2(5.0, 7.0)) - r * 1.6));
	plate(p, vec2(0.0), length(p) - r * 1.5, BOT_LINE * 3.0, 1.0);  // apron ring
	plate(p, vec2(0.0), length(p) - r * 1.05, BOT_OLIVE, 2.0);      // armored drum
	for (float i = 0.0; i < 6.0; i += 1.0) {                        // buttresses
		vec2 bp = rot2(i * TAU / 6.0 + 0.4) * vec2(r * 1.25, 0.0);
		plate(p, bp, sd_box(rot2(-i * TAU / 6.0 - 0.4) * (p - bp), vec2(r * 0.28, r * 0.14)), BOT_KHAKI, i + 3.0);
	}
	// rotating emitter head, aimed along the sweep
	vec2 hq = rot2(-(angW - b.angle)) * p;
	plate(p, vec2(0.0), sd_box(hq - vec2(r * 0.20, 0.0), vec2(r * 0.55, r * 0.28)) - r * 0.1, BOT_KHAKI, 9.0);
	lay(BOT_LINE * 2.0, soft(sd_box(hq - vec2(r * 0.62, 0.0), vec2(r * 0.30, r * 0.10))));
	// the eye: idle ember + a wide warning pool — a lighthouse in the dust
	float idle = 0.9 + 0.4 * sin(pc.time * 1.7 + float(v_id));
	add += PAL_ACCENT * soft(length(p) - r * 0.30) * (firing ? 1.0 : idle);
	add += PAL_ACCENT * 0.20 * exp(-dot(p, p) / (r * r * 4.0)) * idle;
	if (firing) {
		float muzz = mg ? (0.3 + 1.4 * hash1(uint(pc.time * 40.0) + v_id)) * step(0.30, fract(pc.time * 3.3 + hash1(v_id * 55u))) : 1.0;
		add += (PAL_EMBER * 2.0 + vec3(1.0)) * exp(-dot(p, p) / (r * r * 0.8)) * env * 2.0 * muzz;
	}
}

void helper(vec2 p, Body b) {
	// Salvage drone: a little twin-rotor lifter. Amber work light, teal shell, a hoist
	// beam down to whatever wreck it's hauling (target slot lives in gen).
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = 2.6;
	float bob = sin(pc.time * 3.1 + float(v_id)) * 1.2;
	lay(vec3(0.012), 0.4 * soft(length(p - vec2(5.0, 8.0 + bob)) - 9.0)); // it flies HIGH
	p.y -= bob * 0.4;
	if (b.gen != 0u) { // hoist beam to the carried wreck
		Body t = BODIES[b.gen - 1u];
		vec2 lp = rot2(-b.angle) * (t.pos - b.pos);
		if (dot(lp, lp) < 110.0 * 110.0) {
			float bd = sd_seg(p, vec2(0.0), lp);
			add += PAL_EMBER * 1.1 * exp(-bd * bd / 3.0) * (0.7 + 0.3 * sin(pc.time * 31.0));
		}
	}
	for (float s = -1.0; s <= 1.0; s += 2.0) { // rotor pods, spinning shimmer
		vec2 rp = vec2(-4.0, s * 12.0);
		lay(BOT_LINE * 2.0, soft(length(p - rp) - 6.0));
		add += vec3(0.30, 0.33, 0.36) * soft(length(p - rp) - 8.5) * (0.4 + 0.35 * sin(pc.time * 51.0 + s + float(v_id)));
	}
	plate(p, vec2(0.0), sd_box(p, vec2(11.0, 6.5)) - 3.0, vec3(0.155, 0.160, 0.170), 1.0); // grey shell
	plate(p, vec2(7.0, 0.0), length(p - vec2(7.0, 0.0)) - 4.0, SHIP_CHROME * 0.7, 2.0);  // sensor dome
	add += PAL_EMBER * 2.4 * soft(length(p - vec2(-9.5, 0.0)) - 2.0) * (0.6 + 0.4 * sin(pc.time * 4.0 + float(v_id))); // work light
	add += PAL_ACCENT * 1.2 * soft(length(p - vec2(2.0, 0.0)) - 1.2) * step(0.5, fract(pc.time * 1.6 + hash1(v_id))); // status blinker
}

void wreck(vec2 p, Body b) {
	// A shot-down mech: scorched splayed husk. Near the ship it lights up with the tow
	// beam and gets dragged; it fades out over its last seconds if left to rot.
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = max(r * 0.22, 2.8);
	float fade = clamp(b.life / 3.0, 0.0, 1.0);
	uint s = v_id * 613u;
	// tow beam back to the ship
	vec2 lp = rot2(-b.angle) * (pc.player - b.pos);
	float pd = length(lp);
	if (pd < TOW_D) {
		float bd = sd_seg(p, vec2(0.0), lp);
		float dash = 0.6 + 0.4 * sin(dot(p, lp / pd) * 0.5 - pc.time * 26.0);
		add += PAL_EMBER * exp(-bd * bd / 6.0) * dash * 1.3 * fade;
	}
	// scorch ring
	lay(vec3(0.020, 0.018, 0.016), 0.5 * fade * soft(length(p) - r * 1.15));
	// dead legs, splayed
	for (float i = 0.0; i < 4.0; i += 1.0) {
		float aa = (i + 0.5) * (TAU / 4.0) + hash1(s + uint(i)) * 0.8 - 0.4;
		vec2 tip = rot2(aa) * vec2(r * (1.5 + 0.5 * hash1(s + 9u + uint(i))), 0.0);
		lay(BOT_LINE * 1.4, soft(sd_seg(p, vec2(0.0), tip) - r * 0.09) * fade);
		lay(mix(BOT_KHAKI, BOT_OLIVE, hash1(s + 3u + uint(i))) * 0.45, soft(sd_seg(p, tip * 0.3, tip * 0.75) - r * 0.16) * fade);
	}
	// broken hull plates, charred paint
	plate(p, vec2(0.0), sd_box(rot2(0.4) * p, vec2(r * 0.60, r * 0.45)) - r * 0.10, BOT_KHAKI * 0.5, 1.0);
	plate(p, vec2(r * 0.2, r * 0.1), sd_box(p - vec2(r * 0.2, r * 0.1), vec2(r * 0.30, r * 0.20)) - r * 0.05, BOT_OLIVE * 0.5, 2.0);
	base *= 0.35 + 0.65 * fade; // char everything down as it rots
	// cooling ember in the core
	add += PAL_EMBER * 0.35 * fade * soft(length(p - vec2(r * 0.15)) - r * 0.12) * (0.5 + 0.5 * sin(pc.time * 3.0 + float(v_id)));
}

void bullet(vec2 p) {
	// artillery shell: a hard bright slug with a thin tracer tail — a crisp POINT of
	// light racing over the ground, not a bloom blob
	float d = sd_seg(p, vec2(5.0, 0.0), vec2(-12.0, 0.0));
	add += PAL_EMBER * 1.1 * exp(-d * d / 1.8);                              // thin tail
	float dh2 = dot(p - vec2(5.0, 0.0), p - vec2(5.0, 0.0));
	add += vec3(1.35, 1.05, 0.75) * 2.6 * exp(-dh2 / 5.0);                   // the slug
}

// smooth value noise — the blast cloud must ROLL, not show hash-cell pixels
float vnoise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
	           mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}

void burst(vec2 p, Body b) {
	// Mechanical breakup — no fireballs, no shockwave rings: the mech flies apart into
	// tumbling painted-armor shards with cooling ember edges, over a brief hot pinpoint.
	float total = b.variant == VAR_SPARK ? SPARK_T : (b.variant == VAR_BOOM ? BOOM_T : DEATH_T);
	float prog = 1.0 - clamp(b.life / total, 0.0, 1.0);
	float fade = 1.0 - prog;
	uint s = v_id * 977u;
	if (b.variant == VAR_BOOM) { // shell detonation: flash + flung fire — NO drawn ring;
		// the blast wave itself is invisible here, the composite warps the screen for it
		float prog2 = pow(prog, 0.6); // decelerating front — matches physics + composite
		float R = mix(10.0, BOOM_R, prog2);
		float rr = length(p);
		// hot detonation flash — ember-red, tight, gone in the first instants (a huge
		// white orb reads as a camera flare, not a shell)
		float aStar = 1.0 + 0.6 * cos(atan(p.y, p.x) * 8.0 + hash1(s) * TAU);
		add += (PAL_EMBER * 1.3 + vec3(0.4)) * exp(-rr * rr / (240.0 * aStar)) * exp(-prog * 12.0) * 2.8;
		// rolling fire cloud thrown outward with the front — SMOOTH turbulence, never
		// circular, never pixel squares
		float vn = vnoise(p * 0.045 + hash1(s) * 40.0) * 0.65
		         + vnoise(p * 0.11 - vec2(0.0, prog * 5.0) + hash1(s + 3u) * 20.0) * 0.35;
		float cloud = smoothstep(R, R * 0.2, rr) * smoothstep(0.38, 0.78, vn + 0.30 * fade);
		add += (PAL_EMBER * 1.6 + PAL_ACCENT * 0.6) * cloud * fade * fade * 2.4;
		// radial debris spears
		for (float i = 0.0; i < 9.0; i += 1.0) {
			uint si = s + uint(i) * 29u;
			vec2 q = rot2(hash1(si) * TAU) * p;
			float dst = R * (0.70 + 0.40 * hash1(si + 3u));
			add += PAL_EMBER * 2.0 * exp(-sd_seg(q, vec2(dst - 26.0 * fade, 0.0), vec2(dst, 0.0)) * 1.5) * fade;
		}
		// round ember sparks tumbling past the front (dots, not cells)
		vec2 cc = floor(p / 13.0);
		vec2 dp = (fract(p / 13.0) - vec2(hash21(cc + hash1(s) * 9.0), hash21(cc + hash1(s) * 9.0 + 7.0))) * 13.0;
		float spark = exp(-dot(dp, dp) / 2.5) * step(0.45, hash21(cc + 3.3));
		add += PAL_EMBER * spark * smoothstep(R * 1.15, R * 0.35, rr) * fade * 3.0;
		return;
	}
	if (b.variant == VAR_SPARK) { // pit sink: glint + a few spark streaks
		add += vec3(1.1, 0.95, 0.7) * exp(-dot(p, p) / 9.0) * fade * 1.6;
		for (float i = 0.0; i < 3.0; i += 1.0) {
			uint si = s + uint(i);
			vec2 q = rot2(hash1(si) * TAU) * p;
			float dst = 3.0 + prog * (10.0 + hash1(si + 7u) * 12.0);
			add += PAL_EMBER * 1.2 * exp(-sd_seg(q, vec2(dst - 3.0, 0.0), vec2(dst, 0.0)) * 2.0) * fade;
		}
		return;
	}
	float n = b.variant == VAR_BRUTE ? 9.0 : 6.0;
	float spread = b.variant == VAR_BRUTE ? 95.0 : 60.0;
	for (float i = 0.0; i < n; i += 1.0) {
		uint si = s + uint(i) * 13u;
		float a = (i + hash1(si)) * (TAU / n);
		float dst = (0.25 + 0.75 * hash1(si + 1u)) * prog * spread + b.radius * 0.3;
		vec2 c = rot2(a) * vec2(dst, 0.0);
		float spin = a * 3.0 + prog * (2.0 + hash1(si + 2u) * 6.0);
		vec2 q = rot2(-spin) * (p - c);
		float m = soft(sd_box(q, vec2(2.0 + hash1(si + 3u) * 3.0, 1.2)));
		lay(mix(BOT_KHAKI, BOT_OLIVE, hash1(si + 5u)) * 0.55, m * fade); // painted armor chunk
		add += PAL_EMBER * m * fade * fade * (0.5 + hash1(si + 4u));     // its cooling glow
	}
	add += vec3(1.15, 1.0, 0.8) * exp(-dot(p, p) / (b.radius * b.radius * 1.2)) * exp(-prog * 12.0) * 2.2; // brief pop
	lay(vec3(0.028, 0.025, 0.03), 0.35 * fade * exp(-dot(p, p) / (spread * spread * 0.4 * (0.2 + prog)))); // smoke wisp
}

void main() {
	Body b = BODIES[v_id];
	if (b.kind == KIND_DEAD) { discard; }
	vec2 p = v_local;
	float t = pc.time + hash1(v_id * 7919u) * TAU;
	if      (b.kind == KIND_PLAYER) { ship(p, b); }
	else if (b.kind == KIND_BULLET) { bullet(p); }
	else if (b.kind == KIND_WRECK)  { wreck(p, b); }
	else if (b.kind == KIND_TURRET) { turret(p, b); }
	else if (b.kind == KIND_HELPER) { helper(p, b); }
	else if (b.kind == KIND_DYING)  { burst(p, b); }
	else {
		float mh = b.variant == VAR_SPIDER ? HP_SPIDER : (b.variant == VAR_SKITTER ? HP_SKITTER : HP_BRUTE);
		float dmgJ = 1.0 - clamp(b.hp / mh, 0.0, 1.0);
		if (dmgJ > 0.3) { // crippled machines STAGGER — servos failing
			p += vec2(sin(pc.time * 37.0 + float(v_id)), cos(pc.time * 41.0 + float(v_id))) * (dmgJ - 0.3) * 2.6;
		}
		if      (b.variant == VAR_SPIDER)  { spider(p, b, t); }
		else if (b.variant == VAR_SKITTER) { skitter(p, b, t); }
		else                               { brute(p, b, t); }
		if (b.life > 0.0) { base = mix(base, vec3(1.5, 0.62, 0.28), b.life * 0.85); } // hit flash: hot metal, not white
	}
	// fake-3D occlusion: bodies live ON THE GROUND — march the same city silhouettes
	// city.frag draws, and if a building covers this pixel the building is in front (a
	// bot on the street behind a tower must NOT be painted onto its roof). This also
	// clips legs/sparks poking into facades at ground level. Salvage drones fly above
	// it all and skip the test.
	if (b.kind != KIND_HELPER && (cov > 0.003 || dot(add, add) > 0.00001)) {
		vec2 sq = (gl_FragCoord.xy - pc.screen * 0.5) * ZOOM;
		for (int i = 0; i < 8; i++) {
			float tq = 1.0 - float(i) / 7.0;
			House hs = house_at(pc.cam + sq / (1.0 + PERSP * tq));
			if (hs.ok && hs.sd <= 0.0 && house_h(hs) >= tq) { discard; }
		}
	}
	o_color = vec4(base * cov + add, cov); // premultiplied; `add` is pure emissive
}
