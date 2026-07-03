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
	col += vec3(0.44, 0.45, 0.49) * bevel * litSide;     // specular bevel glint — machined METAL
	col = mix(col, BOT_LINE, smoothstep(-2.4, -1.1, d)); // panel lining
	lay(col, soft(d));
}

// One mech leg with a real GAIT: the foot sweeps back through stance (planted while
// the body advances), then snaps forward in a quick swing with the leg tucked in —
// insect STEPPING, not wobble. Chunky armored upper-leg plate → knee cap → thin dark
// lower strut → foot pad. `aa` = hip bearing, `ph` = gait phase (radians).
void mech_leg(vec2 p, float r, float aa, float ph, float wUp, float wLo) {
	float cyc = fract(ph / TAU);
	float stride, tuck = 0.0;
	if (cyc < 0.72) { stride = 1.0 - 2.0 * (cyc / 0.72); }            // stance: planted, sweeping back
	else {
		float sw = (cyc - 0.72) / 0.28;
		stride = -1.0 + 2.0 * sw;                                     // swing: quick snap forward
		tuck = sin(sw * 3.14159);                                     // leg pulls in = the lift
	}
	vec2 hip  = rot2(aa) * vec2(r * 0.52, 0.0);
	vec2 foot = rot2(aa + stride * 0.14) * vec2(r * (1.88 - tuck * 0.42), 0.0);
	foot.x += stride * r * 0.34;
	vec2 dirH = foot - hip;
	vec2 knee = hip + dirH * 0.5 + normalize(vec2(-dirH.y, dirH.x) + 0.0001) * sign(aa) * r * 0.22; // knee bows out
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
	// headlight lamps — small hot points; the LONG beam on the ground lives in
	// city.frag and ramps up down-range, so there's no blinding pool at the car
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += vec3(1.0, 0.90, 0.70) * 1.2 * soft(length(p - vec2(22.5, s * 6.5)) - 2.4);
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

// Battle damage overlay: soot creeps smoothly over the armor; the red is the hit
// wearing off on ONE smooth shared envelope — no flicker, no per-bot random phases.
// b.life is stamped when the wave reaches the bot, so across a crowd the animation
// radiates outward through the bodies with the blast, staggered only by distance.
void battle_damage(vec2 p, Body b, float maxhp) {
	if (b.hp < -50.0) { return; } // blast-stamped: no damage glow — it walks, whitens, dies
	float dmg = 1.0 - clamp(b.hp / maxhp, 0.0, 1.0);
	if (dmg < 0.10) { return; }
	float m = (dmg - 0.10) * 1.30;
	// soot: a smooth noise front creeping over the paint — persistent WEAR is dark
	float n = vnoise(p * 0.5 + float(v_id % 977u));
	base = mix(base, vec3(0.028, 0.024, 0.020), smoothstep(1.05 - m * 1.2, 1.35 - m * 1.2, n) * 0.85 * cov);
	float hot = clamp(b.life, 0.0, 1.0); // decays linearly — a clean cool-down, never a blink
	if (hot > 0.02) {
		add += PAL_ACCENT * hot * (0.3 + m * 0.5) * exp(-dot(p, p) / (b.radius * b.radius * 1.4)) * cov;
		vec2 q = rot2(hash1(v_id * 337u) * TAU) * p; // a fissure glows while the metal is hot
		float crack = abs(q.y - sin(q.x * 0.5 + hash1(v_id * 337u + 1u) * 6.0) * b.radius * 0.2);
		add += PAL_ACCENT * exp(-crack * crack / 1.4) * hot * (0.3 + m) * 1.1 * cov
		     * smoothstep(b.radius, b.radius * 0.5, length(p));
	}
	for (float i = 0.0; i < 2.0; i += 1.0) { // black smoke curling off the wounds
		float ph2 = fract(pc.time * 0.55 + hash1(v_id + uint(i) * 7u));
		vec2 sp2 = vec2(sin(pc.time * 1.3 + i * 2.6) * 6.0, -b.radius * 0.3 - ph2 * 22.0);
		lay(vec3(0.016, 0.015, 0.015), m * (1.0 - ph2) * 0.55 * soft(length(p - sp2) - (3.0 + ph2 * 8.0)));
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
	// sensor slit: dark housing, thin red glow PULSING like a heartbeat — alive
	lay(BOT_LINE, soft(sd_box(p - vec2(r * 0.62, 0.0), vec2(r * 0.07, r * 0.24))));
	float beat = 0.7 + 0.5 * sin(pc.time * 2.8 + float(v_id) * 0.7);
	add += PAL_ACCENT * 1.1 * beat * soft(sd_box(p - vec2(r * 0.62, 0.0), vec2(r * 0.035, r * 0.17)));
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
	float beat = 0.7 + 0.5 * sin(pc.time * 3.4 + float(v_id) * 0.9); // pulsing eye — alive
	add += PAL_ACCENT * 1.3 * beat * soft(length(p - vec2(r * 0.95, 0.0)) - r * 0.11);
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
	float pulse = 0.8 + 0.3 * sin(pc.time * 3.0 + float(v_id));
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
	// the eye: steady ember + a wide warning pool — the tower itself NEVER flashes;
	// only its rounds and ricochets move
	add += PAL_ACCENT * soft(length(p) - r * 0.30);
	add += PAL_ACCENT * 0.20 * exp(-dot(p, p) / (r * r * 4.0));
}

void helper(vec2 p, Body b) {
	// Salvage drone: a twin-rotor lifter, sized to READ as the fleet. Amber work light,
	// grey shell, a hoist beam down to the wreck it's fetching (target slot in gen).
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = 2.6;
	float sc = 14.0 / max(b.radius, 8.0); // sprite drawn in classic proportions, scaled up by radius
	p *= sc;
	float bob = sin(pc.time * 3.1 + float(v_id)) * 1.2;
	lay(vec3(0.012), 0.4 * soft(length(p - vec2(5.0, 8.0 + bob)) - 9.0)); // it flies HIGH
	p.y -= bob * 0.4;
	if (b.gen != 0u && b.gen != 0x80000000u) { // hoist beam to the target wreck
		Body t = BODIES[b.gen - 1u];
		vec2 lp = rot2(-b.angle) * (t.pos - b.pos) * sc;
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
	// Unmistakably DEAD: a flattened charcoal husk under settling ash — none of the
	// living paint and NO red (red is the language of live threats). Drones haul it.
	float r = b.radius;
	float fade = clamp(b.life / 3.0, 0.0, 1.0);
	uint s = v_id * 613u;
	p *= 0.82; // collapsed: the husk lies wider and flatter than the machine stood
	lay(vec3(0.016, 0.015, 0.014), 0.6 * fade * soft(length(p) - r * 1.25)); // scorch bed
	for (float i = 0.0; i < 4.0; i += 1.0) { // dead legs, splayed
		float aa = (i + 0.5) * (TAU / 4.0) + hash1(s + uint(i)) * 0.8 - 0.4;
		vec2 tip = rot2(aa) * vec2(r * (1.5 + 0.5 * hash1(s + 9u + uint(i))), 0.0);
		lay(vec3(0.030, 0.029, 0.028), soft(sd_seg(p, vec2(0.0), tip) - r * 0.10) * fade);
	}
	// buckled hull: bare charcoal plates, every trace of paint burnt off
	lay(vec3(0.048, 0.046, 0.044), soft(sd_box(rot2(0.4) * p, vec2(r * 0.62, r * 0.46)) - r * 0.10) * fade);
	lay(vec3(0.036, 0.035, 0.034), soft(sd_box(p - vec2(r * 0.2, r * 0.1), vec2(r * 0.32, r * 0.22)) - r * 0.05) * fade);
	// heavy pale ash dusting settling over the top — DEAD reads pale and flat, and a
	// wreck emits NO light at all (light is the language of the living)
	float ash = hash21(floor(p / 4.0) + float(v_id));
	base = mix(base, vec3(0.105, 0.102, 0.098), step(0.62, ash) * 0.65 * cov);
	base *= 0.4 + 0.6 * fade; // crumbles away if left to rot
}

void bullet(vec2 p) {
	// a molten SHELL: a crisp solid orb (base — no bloom mush), molten rim, hot heart.
	// It flies ABOVE everything, so it reads as a definite object, not a glow.
	float d = length(p);
	float br = 1.0 + 0.08 * sin(pc.time * 23.0);
	lay(vec3(0.9, 0.28, 0.08), soft(d - 8.5 * br));  // molten rim
	lay(vec3(1.25, 0.85, 0.45), soft(d - 6.0 * br)); // fire body
	lay(vec3(1.4, 1.25, 1.0), soft(d - 2.8));        // white-hot heart
	add += (PAL_EMBER + vec3(0.4)) * 0.8 * exp(-d * d / 30.0); // a tight gleam
	add += PAL_EMBER * 0.3 * exp(-d * d / 260.0);               // modest halo
}

void burst(vec2 p, Body b) {
	// Mechanical breakup — no fireballs, no shockwave rings: the mech flies apart into
	// tumbling painted-armor shards with cooling ember edges, over a brief hot pinpoint.
	float total = b.variant == VAR_SPARK ? SPARK_T : (b.variant == VAR_BOOM ? BOOM_T : DEATH_T);
	float prog = 1.0 - clamp(b.life / total, 0.0, 1.0);
	float fade = 1.0 - prog;
	uint s = v_id * 977u;
	if (b.variant == VAR_BOOM) {
		// detonation: one brief flash at the point of impact — the wave itself is the
		// composite's distortion + the reaction radiating THROUGH the bots
		float rr = length(p);
		float flash = exp(-prog * 9.0);
		lay(vec3(1.3, 1.1, 0.8), soft(rr - mix(6.0, 30.0, 1.0 - flash)) * flash);
		add += (PAL_EMBER * 1.3 + vec3(0.4)) * exp(-rr * rr / 700.0) * flash;
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
	// death: the machine buckles — a brief hot flash, a few embers arcing out, oily
	// smoke. The husk (KIND_WRECK) takes over from here, so keep the hand-off QUIET.
	float spread = (b.variant == VAR_BRUTE ? 1.5 : 1.0) * b.radius * 2.4;
	add += (PAL_EMBER * 1.3 + vec3(0.3)) * exp(-dot(p, p) / (b.radius * b.radius * 1.2)) * exp(-prog * 8.0) * 1.8;
	for (float i = 0.0; i < 5.0; i += 1.0) { // round ember dots flung outward, cooling
		uint si = s + uint(i) * 13u;
		float a = hash1(si) * TAU;
		float dst = (0.3 + 0.7 * hash1(si + 1u)) * prog * spread + b.radius * 0.3;
		vec2 c = rot2(a) * vec2(dst, 0.0);
		add += PAL_EMBER * exp(-dot(p - c, p - c) / 2.2) * fade * (0.6 + hash1(si + 4u));
	}
	lay(vec3(0.020, 0.019, 0.019), 0.5 * fade * exp(-dot(p, p) / (spread * spread * 0.5 * (0.15 + prog)))); // smoke blot
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
	else if (b.kind == KIND_DYING && (b.variant == VAR_BOOM || b.variant == VAR_SPARK)) { burst(p, b); }
	else if (b.kind == KIND_DYING && b.hp < -50.0) {
		// blast-stamped (the exact circle): the bot starts NORMAL, animates to full
		// WHITE, then dies
		float lf = clamp(b.life / 0.4, 0.0, 1.0); // 1 → 0 over the stamp death
		if      (b.variant == VAR_SPIDER)  { spider(p, b, t); }
		else if (b.variant == VAR_SKITTER) { skitter(p, b, t); }
		else                               { brute(p, b, t); }
		// a faint pale build-up, then one brief FLASH at the very end — the bot is gone
		// at the flash's peak, never sitting fully white
		float pre = smoothstep(1.0, 0.3, lf) * 0.18;  // subtle warning tint
		float flash = smoothstep(0.30, 0.10, lf);     // the end flash (~0.08s)
		base = mix(base, vec3(1.0), min(pre + flash, 1.0) * 0.95);
		add *= 1.0 - flash;
		cov *= smoothstep(0.02, 0.10, lf);            // vanishes AT the peak
	}
	else if (b.kind == KIND_DYING) {
		// the machine dies in place and POPS: an instant puff, a HARD white-hot
		// silhouette (pure base — no bloom, so it's a crisp comic pop, not a blur) and
		// short radial burst streaks snapping outward. Then it shudders and chars down
		// toward the husk. The effect wears the mech — no circles, no orbs.
		float prog = 1.0 - clamp(b.life / DEATH_T, 0.0, 1.0);
		float pop = exp(-prog * 9.0);
		p /= 1.0 + 0.25 * pop;          // squash-and-stretch: an instant puff...
		p *= 1.0 + prog * prog * 2.4;   // ...then it collapses into itself
		p += vec2(sin(pc.time * 47.0 + float(v_id)), cos(pc.time * 53.0 + float(v_id))) * 2.2 * (1.0 - prog);
		if      (b.variant == VAR_SPIDER)  { spider(p, b, t); }
		else if (b.variant == VAR_SKITTER) { skitter(p, b, t); }
		else                               { brute(p, b, t); }
		base = mix(base, vec3(1.05, 0.85, 0.62), smoothstep(0.16, 0.04, prog) * 0.9); // the hard flash
		if (prog < 0.30) { // comic burst streaks — crisp lines, expanding then gone
			float bp = prog / 0.30;
			for (float i = 0.0; i < 5.0; i += 1.0) {
				float a = (i + 0.5) * (TAU / 5.0) + hash1(v_id * 77u) * TAU;
				vec2 q = rot2(a) * p;
				float r0 = b.radius * (1.3 + 1.8 * bp);
				float r1 = r0 + b.radius * (0.9 - 0.6 * bp);
				lay(vec3(0.95, 0.82, 0.65), soft(sd_seg(q, vec2(r0, 0.0), vec2(r1, 0.0)) - 1.3) * (1.0 - bp * bp));
			}
		}
		base *= 1.0 - 0.72 * prog; // charring down as it goes
		float vanish = 1.0 - smoothstep(0.5, 0.95, prog); // then it's GONE — nothing stays
		cov *= vanish;
		add *= vanish * (1.0 - prog * 0.7);
		burst(p, b);
	}
	else {
		float mh = b.variant == VAR_SPIDER ? HP_SPIDER : (b.variant == VAR_SKITTER ? HP_SKITTER : HP_BRUTE);
		float dmgJ = 1.0 - clamp(b.hp / mh, 0.0, 1.0);
		if (dmgJ > 0.3) { // crippled machines LIMP — a slow heavy sway, not a vibration
			p += vec2(sin(pc.time * 6.0 + float(v_id)), cos(pc.time * 7.0 + float(v_id))) * (dmgJ - 0.3) * 2.2;
		}
		if      (b.variant == VAR_SPIDER)  { spider(p, b, t); }
		else if (b.variant == VAR_SKITTER) { skitter(p, b, t); }
		else                               { brute(p, b, t); }
		if (b.life > 0.0 && b.hp > -50.0) { base = mix(base, vec3(1.5, 0.62, 0.28), min(b.life, 1.0) * 0.85); } // hit flash (never on stamped bots)
	}
	// the LIVE shockwaves reach into this shader: physics publishes each blast's center
	// + front progress (STATS[2..] — the same list the composite warps the screen with),
	// and as a front sweeps a bot's distance it rim-lights it FROM the blast point. The
	// radial effect reads on the bodies themselves, perfectly synced with the wave.
	if (b.kind == KIND_ENEMY || (b.kind == KIND_DYING && b.variant != VAR_BOOM && b.variant != VAR_SPARK)) {
		uint nb = min(STATS[2], 8u);
		for (uint i = 0u; i < nb; i++) {
			vec2 bpos = vec2(uintBitsToFloat(STATS[3u + i * 3u]), uintBitsToFloat(STATS[4u + i * 3u]));
			float bprog = uintBitsToFloat(STATS[5u + i * 3u]);
			vec2 relb = b.pos - bpos;
			float d = max(length(relb), 0.001);
			float R = mix(10.0, BOOM_R, pow(bprog, 0.6));
			// a bot lights up exactly when the front passes through it — a NARROW band,
			// so it's strictly one by one, travelling outward with the wave
			float eff = exp(-pow(d - R, 2.0) / 700.0) * (1.0 - bprog);
			if (eff < 0.02) { continue; }
			vec2 toBlast = rot2(-b.angle) * (-relb / d); // direction to the blast, body frame
			float facing = clamp(dot(p, toBlast) / max(b.radius, 1.0), 0.0, 1.0); // lit on the blast side
			base = mix(base, vec3(1.2, 0.45, 0.15), eff * facing * 0.40 * cov);
			add += PAL_ACCENT * eff * facing * 0.15 * cov;
		}
	}
	// caught in the truck's high-beams: machines SHINE back out of the dark
	if (b.kind != KIND_PLAYER) {
		vec2 relb = b.pos - pc.player;
		vec2 fdir = vec2(cos(pc.angle), sin(pc.angle));
		float alongb = dot(relb, fdir);
		if (alongb > 0.0) {
			float latb = abs(dot(relb, vec2(-fdir.y, fdir.x)));
			float spread = 24.0 + alongb * 0.40; // matches the ground beam in city.frag
			float beam = exp(-latb * latb / (spread * spread)) * smoothstep(760.0, 30.0, alongb)
			           * smoothstep(40.0, 260.0, alongb);
			base += vec3(0.9, 0.85, 0.72) * beam * 0.55 * cov;
			add += vec3(1.0, 0.92, 0.75) * beam * 0.18 * cov;
		}
	}
	// fake-3D occlusion: bodies live ON THE GROUND — march the same city silhouettes
	// city.frag draws, and if a building covers this pixel the building is in front (a
	// bot on the street behind a tower must NOT be painted onto its roof). This also
	// clips legs/sparks poking into facades at ground level. Salvage drones and the
	// artillery shells fly ABOVE it all and skip the test.
	if (b.kind != KIND_HELPER && b.kind != KIND_BULLET && (cov > 0.003 || dot(add, add) > 0.00001)) {
		vec2 sq = (gl_FragCoord.xy - pc.screen * 0.5) * ZOOM;
		for (int i = 0; i < 8; i++) {
			float tq = 1.0 - float(i) / 7.0;
			House hs = house_at(pc.cam + sq / (1.0 + PERSP * tq));
			if (hs.ok && hs.sd <= 0.0 && house_h(hs) >= tq) { discard; }
		}
	}
	o_color = vec4(base * cov + add, cov); // premultiplied; `add` is pure emissive
}
