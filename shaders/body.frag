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

// the invaders' paint (linear; the composite sRGB-encodes)
const vec3 BOT_KHAKI  = vec3(0.45, 0.38, 0.22);
const vec3 BOT_OLIVE  = vec3(0.22, 0.25, 0.11);
const vec3 BOT_ORANGE = vec3(0.85, 0.28, 0.05);
const vec3 BOT_LINE   = vec3(0.045, 0.045, 0.040); // panel lining / lower struts

const vec3 SHIP_YEL    = vec3(0.82, 0.55, 0.09); // the skiff's paint
const vec3 SHIP_ORANGE = vec3(0.85, 0.28, 0.05);

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

// One flat armor plate: hard two-tone cel shade split across the plate center along the
// light, chipped-paint speckles, dark lining at the edge.
void plate(vec2 p, vec2 ctr, float d, vec3 c, float seed) {
	float shade = mix(0.68, 1.05, step(0.0, dot(p - ctr, gL)));
	vec3 col = c * shade;
	float ch = hash21(floor(p / gCS) + seed * 17.0);
	col = mix(col, c * 0.42, step(0.93, ch) * 0.75);     // chipped paint
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

	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8)); // screen light → body frame
	gCS = 3.2;
	float bob = sin(pc.time * 2.4) * 1.6 + sin(pc.time * 3.7) * 0.7; // hover sway
	float lean = clamp(b.life, -1.0, 1.0);                           // CPU packs drift slip here
	// ground shadow: offset drifts with the bob so the hull visibly FLOATS above it
	vec2 shOff = vec2(9.0 + bob * 0.9, 14.0 + bob * 1.4);
	lay(vec3(0.012, 0.010, 0.010), 0.55 * soft(sd_box(p - shOff, vec2(23.0, 7.0)) - 6.0));
	p.y += lean * 2.6 - bob * 0.35; // hull slides against the drift: banking
	// hover skirt glow beneath the rails — the thing it hovers ON
	add += PAL_EMBER * 0.45 * soft(sd_box(p - vec2(-1.0, 6.5), vec2(17.0, 1.2)) - 2.0) * (0.7 + 0.3 * sin(pc.time * 9.0));
	add += PAL_EMBER * 0.35 * soft(sd_box(p - vec2(-1.0, -6.5), vec2(17.0, 1.2)) - 2.0) * (0.7 + 0.3 * sin(pc.time * 9.0 + 2.0));
	// rear fins, orange, angled with the bank
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		vec2 fq = rot2(s * (0.55 + lean * 0.12)) * (p - vec2(-21.0, s * 7.0));
		plate(p, vec2(-21.0, s * 7.0), sd_box(fq, vec2(7.5, 2.0)) - 1.5, SHIP_ORANGE, 3.0 + s);
	}
	// hull: long rounded slab + nose wedge
	plate(p, vec2(2.0, 0.0), sd_box(p, vec2(25.0, 8.2)) - 5.0, SHIP_YEL, 1.0);
	plate(p, vec2(24.0, 0.0), sd_box(p - vec2(24.0, 0.0), vec2(6.0, 4.2)) - 3.0, SHIP_YEL, 5.0);
	// dark side skirt
	lay(BOT_LINE * 1.8, soft(sd_box(p - vec2(-2.0, 6.0), vec2(19.0, 1.5))) * 0.8);
	// white roundel + red dot (unit marking)
	lay(vec3(0.75, 0.70, 0.60), soft(length(p - vec2(-10.0, -3.0)) - 4.6));
	lay(vec3(0.55, 0.08, 0.05), soft(length(p - vec2(-10.0, -3.0)) - 2.0) * 0.9);
	// canopy + pilot
	lay(vec3(0.030, 0.032, 0.040), soft(sd_box(p - vec2(7.0, 0.0), vec2(6.5, 4.0)) - 2.5));
	lay(BOT_LINE * 2.4, soft(length(p - vec2(4.0, 0.0)) - 2.6));
	// rear engine block
	plate(p, vec2(-24.0, 0.0), sd_box(p - vec2(-24.0, 0.0), vec2(4.0, 5.2)) - 2.0, BOT_OLIVE, 7.0);
	// mains: glow with throttle, flame under boost
	float th = pc.throttle * 0.8 + pc.boost * 1.6;
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		vec2 en = vec2(-28.5, s * 3.4);
		add += PAL_EMBER * soft(length(p - en) - 2.2) * (0.5 + th * (1.6 + 0.5 * sin(pc.time * 47.0 + s)));
		if (pc.boost > 0.03) {
			float fl = sd_seg(p, en, en - vec2(13.0 + 11.0 * pc.boost * (0.7 + 0.3 * sin(pc.time * 57.0 + s * 2.0)), 0.0));
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

// Battle damage overlay: charred paint, molten seams, guttering embers — a hurt bot
// should LOOK hurt long before it dies.
void battle_damage(vec2 p, Body b, float maxhp) {
	// fresh-hit spray: sparks fly while the flash is hot (beams keep this alive)
	if (b.life > 0.4) {
		float sp2 = hash21(floor(p / 4.0) + floor(pc.time * 24.0) * vec2(7.0, -9.0) + float(v_id));
		add += PAL_EMBER * step(0.982, sp2) * b.life * 2.2 * cov;
	}
	float dmg = 1.0 - clamp(b.hp / maxhp, 0.0, 1.0);
	if (dmg < 0.12) { return; }
	float m = (dmg - 0.12) * 1.35;
	float ch = hash21(floor(p / max(gCS * 1.6, 3.0)) + float(v_id));
	base = mix(base, vec3(0.03, 0.028, 0.025), step(1.0 - m * 0.8, ch) * cov);        // char
	float seam = smoothstep(0.90 - m * 0.25, 0.90, ch) * (1.0 - step(0.90, ch));       // molten cracks
	add += PAL_ACCENT * seam * m * 1.4 * cov * (0.7 + 0.3 * sin(pc.time * 7.0 + ch * 40.0));
	float sp = hash21(floor(p / 5.0) + pc.time * vec2(0.0, 3.0) + float(v_id));        // gutter sparks
	add += PAL_EMBER * step(0.985 - m * 0.03, sp) * m * 2.4 * cov;
	add += PAL_ACCENT * 0.3 * m * soft(length(p) - b.radius * 0.3);                    // core burning through
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
	// scythe slow massive bars; inner plaza turrets whip short fast beams almost
	// non-stop. Duty/sweep MUST match physics.comp (hash1(v_id*77u) / hash1(v_id*913u)).
	float r = b.radius;
	bool inner = distance(b.pos, vec2(WORLD * 0.5)) < pc.city_r;
	float duty = inner ? 0.55 : 0.30;
	float rate = inner ? 0.55 : 0.14;
	float len  = inner ? 700.0 : TWR_LEN;
	float phase = fract(pc.time * rate + hash1(v_id * 77u));
	bool firing = phase < duty;
	float env = smoothstep(0.0, 0.03, phase) * smoothstep(duty, duty - 0.04, phase); // ramp in/out
	float angW = hash1(v_id * 913u) * TAU + pc.time * (inner ? 1.9 : 0.22); // sweep, world frame
	vec2 bd2 = rot2(angW - b.angle) * vec2(1.0, 0.0);                       // beam dir, body frame
	if (firing) { // the beam first — a two-sided lighthouse bar; the quad is huge while firing
		float bd = sd_seg(p, -bd2 * len, bd2 * len);
		float wHalo = inner ? TWR_W * 0.6 : TWR_W;
		float flick = 0.85 + 0.30 * sin(pc.time * (inner ? 90.0 : 47.0) + dot(p, bd2) * 0.03);
		add += (vec3(1.3, 1.0, 0.7) + PAL_EMBER * 0.5) * exp(-bd * bd / (30.0 * flick)) * 1.5 * env;
		add += PAL_ACCENT * exp(-bd * bd / (wHalo * wHalo)) * 0.35 * env;
		add += PAL_EMBER * exp(-bd / (wHalo * 2.5)) * 0.10 * env;
	}
	if (length(p) > r * 3.5) { return; } // beyond the fortress: beam only
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
	if (firing) { add += (PAL_EMBER * 2.0 + vec3(1.0)) * exp(-dot(p, p) / (r * r * 0.8)) * env * 2.0; }
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
	// artillery shell: a heavy bolt with a hot head and a long ember wake
	float d = sd_seg(p, vec2(8.0, 0.0), vec2(-16.0, 0.0));
	add += vec3(1.25, 1.05, 0.8) * 1.8 * exp(-d * d / 5.0);       // fat core
	add += PAL_EMBER * 0.55 * exp(-d * d / 40.0);                 // wake halo
	add += (PAL_EMBER + vec3(0.6)) * exp(-dot(p - vec2(8.0, 0.0), p - vec2(8.0, 0.0)) / 14.0); // hot head
}

void burst(vec2 p, Body b) {
	// Mechanical breakup — no fireballs, no shockwave rings: the mech flies apart into
	// tumbling painted-armor shards with cooling ember edges, over a brief hot pinpoint.
	float total = b.variant == VAR_SPARK ? SPARK_T : (b.variant == VAR_BOOM ? BOOM_T : DEATH_T);
	float prog = 1.0 - clamp(b.life / total, 0.0, 1.0);
	float fade = 1.0 - prog;
	uint s = v_id * 977u;
	if (b.variant == VAR_BOOM) { // shell detonation: an EPIC expanding shockwave
		float R = mix(24.0, BOOM_R, prog);
		float rr = length(p);
		float rd = abs(rr - R);
		float shim = 0.75 + 0.5 * hash21(floor(p / 6.0) + floor(pc.time * 40.0)); // heat shimmer on the front
		add += (PAL_EMBER * 1.6 + vec3(0.8)) * exp(-rd * rd / (60.0 + 500.0 * prog)) * fade * 2.4 * shim; // wavefront
		lay(vec3(0.012, 0.010, 0.010), 0.6 * fade * (1.0 - smoothstep(0.0, 20.0, abs(rr - (R - 18.0))))); // refraction band riding inside it
		add += vec3(1.35, 1.1, 0.8) * exp(-dot(p, p) / (600.0 * (0.15 + prog))) * fade * 2.2;             // core flash
		add += PAL_ACCENT * exp(-rd * rd / 3000.0) * fade * fade * 0.8;                                   // trailing heat
		lay(vec3(0.075, 0.062, 0.050), 0.45 * fade * smoothstep(R, R * 0.25, rr));                        // dust punched up
		for (float i = 0.0; i < 5.0; i += 1.0) { // shrapnel streaks riding the wave
			uint si = s + uint(i) * 11u;
			vec2 q = rot2(hash1(si) * TAU) * p;
			float dst = R * (0.8 + 0.3 * hash1(si + 7u));
			add += PAL_EMBER * 1.4 * exp(-sd_seg(q, vec2(dst - 14.0, 0.0), vec2(dst, 0.0)) * 1.2) * fade;
		}
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
	else if (b.kind == KIND_DYING)  { burst(p, b); }
	else {
		if      (b.variant == VAR_SPIDER)  { spider(p, b, t); }
		else if (b.variant == VAR_SKITTER) { skitter(p, b, t); }
		else                               { brute(p, b, t); }
		if (b.life > 0.0) { base = mix(base, vec3(1.4, 1.3, 1.2), b.life * 0.85); } // hit/spawn flash
	}
	o_color = vec4(base * cov + add, cov); // premultiplied; `add` is pure emissive
}
