// ── the SHARED BODY SPRITE KIT ────────────────────────────────────────────────
// The v_id-free, time-free machined-metal primitives + the ENEMY CHASSIS sprites, factored out
// so BOTH consumers compile the exact same code with zero divergence:
//   • the game (bodylib.glsl) — draws every body live, and for the alive horde SAMPLES the baked
//     atlas instead of re-running the chassis per fragment (the big bodies win).
//   • the offline baker (tools/bake/bake_body.frag) — renders each <kind × gait-frame> tile of
//     assets/body.cache by calling these chassis functions directly.
// Everything here is a pure function of (p, body, gait phase, the g* paint globals) — NO v_id,
// NO pc.time, NO emissive. The time/id-dependent bits (eyes pulse, exhaust embers, battle damage,
// the gait odometer) live in bodylib.glsl: they can't be baked, and the baker has no v_id.
#ifndef BODYKIT_GLSL
#define BODYKIT_GLSL

const vec3 BOT_ORANGE = vec3(0.72, 0.14, 0.05);  // red unit marking
const vec3 BOT_LINE   = vec3(0.045, 0.045, 0.040); // panel lining / lower struts
const vec3 SHIP_CHROME = vec3(0.40, 0.41, 0.44); // polished trim (helper dome)
const vec3 RIG_STEEL  = vec3(0.29, 0.30, 0.33); // the player's hull: pale WORKED steel — still the brightest metal out here, never showroom
const vec3 RIG_GRN    = vec3(0.16, 1.35, 0.24); // YOUR TEAM's light: bright green — the horde burns red, you burn green

// painter state: alpha-composited base + emissive add
vec3  base = vec3(0.0);
float cov  = 0.0;
vec3  add  = vec3(0.0);
vec2  gL   = vec2(-0.7, -0.7); // light dir in body frame, set per bot
float gCS  = 3.0;              // paint-chip cell size, scaled to the bot
// team paint: the SAME chassis sprites serve the enemy horde, YOUR army and the garage rides —
// only the paint flips (main()/ship()/the baker set these per body before dispatch). Defaults
// here are the friendly grey.
vec3 gMark   = BOT_ORANGE;               // unit markings / bands
vec3 gEye    = PAL_ACCENT;               // sensor / warhead glow
vec3 gPlateA = vec3(0.305, 0.285, 0.232); // primary armor plate
vec3 gPlateB = vec3(0.168, 0.166, 0.128); // secondary / recessed plate
float gBrush = 1.7;                       // brushing depth — every machine here is worked metal
float gGrime = 0.80;                      // oily grime ground into the brushing — HEAVY on every machine, yours included

void lay(vec3 c, float a) {
	a = clamp(a, 0.0, 1.0);
	base = mix(base, c, a);
	cov = max(cov, a);
}

float soft(float d) { return 1.0 - smoothstep(-1.2, 1.2, d); } // sdf → coverage

// One armor plate: SMOOTH machined metal, NO outlines of any kind — just a hard two-tone cel
// shade split along the light, a broad polished SHEEN climbing toward the light, and a whisper of
// per-plate tint so adjacent panels read apart. Edges separate by value alone, like bare stamped
// facets.
void plate(vec2 p, vec2 ctr, float d, vec3 c, float seed) {
	float lit = dot(p - ctr, gL);
	float litSide = step(0.0, lit);
	vec3 col = c * mix(0.62, 1.12, litSide);
	col *= 0.95 + 0.10 * fract(seed * 61.7);             // per-PLATE tint
	// brushed-metal texture: two octaves of directional grinding streaks + broad wear mottling —
	// SMOOTH noise only, stretched along the body axis (no cells, no grid); gBrush scales the depth
	float brush = 0.65 * vnoise(vec2(p.x * 0.30, p.y * 2.6) + seed * 11.0)
	            + 0.35 * vnoise(vec2(p.x * 0.62, p.y * 6.5) + seed * 29.0);
	col *= 1.0 + (brush - 0.5) * 0.30 * gBrush;
	col *= 0.93 + 0.11 * vnoise(p * 0.16 + seed * 23.0);
	// the streaks COMB the gloss — anisotropic highlight, the actual "brushed" read
	float sheen = clamp(lit / (gCS * 5.0), 0.0, 1.0) * (1.0 + (brush - 0.5) * 0.9 * gBrush);
	col += (c * 1.3 + vec3(0.10)) * sheen * sheen * 0.5; // neutral term: even dark steel GLINTS
	// GRUNGE, after the gloss so dirt KILLS the shine: oily smudges ground into the metal,
	// collecting deepest in the streak valleys — filthy field machines
	float grime = vnoise(p * 0.13 + seed * 41.0);
	col *= 1.0 - smoothstep(0.66, 0.25, grime + brush * 0.35) * 0.62 * gGrime; // wide, filthy coverage
	lay(col, soft(d));
}

// One mech leg with a real GAIT: the foot sweeps back through stance (planted while the body
// advances), then snaps forward in a quick swing with the leg tucked in — insect STEPPING, not
// wobble. Chunky armored upper-leg plate → knee cap → thin dark lower strut → foot pad. `aa` =
// hip bearing, `ph` = gait phase (radians).
void mech_leg(vec2 p, float r, float aa, float ph, float wUp, float wLo) {
	float cyc = fract(ph / TAU);
	float stride, tuck = 0.0;
	if (cyc < 0.72) { stride = 1.0 - 2.0 * (cyc / 0.72); }            // stance: planted, sweeping back
	else {
		float sw = (cyc - 0.72) / 0.28;
		float e = sw * sw * (3.0 - 2.0 * sw);                         // eased: kick off hard, set down soft
		stride = -1.0 + 2.0 * e;                                      // swing: snap forward
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
	lay(gPlateB * 1.45, soft(sd_seg(p, knee, foot - dirLo * r * 0.12) - wLo * 1.4)); // team metal, bright enough to READ
	// chrome hydraulic piston riding the shin + a round hip bearing — MACHINE, not bug
	vec2 perpLo = vec2(-dirLo.y, dirLo.x);
	lay(SHIP_CHROME * 0.85, soft(sd_seg(p, knee + perpLo * wLo * 1.1, mix(knee, foot, 0.62) + perpLo * wLo * 1.1) - wLo * 0.55));
	lay(BOT_LINE * 2.2, soft(length(p - hip) - wUp * 0.55));
	vec2 qf = rot2(-angLo) * (p - foot);
	plate(p, foot, sd_box(qf, vec2(r * 0.13, r * 0.10)) - r * 0.04, gPlateB, aa + 3.0);
	// upper-leg armor plate, oriented hip→knee
	float ang = atan(knee.y - hip.y, knee.x - hip.x);
	vec2 q = rot2(-ang) * (p - hip);
	float lenU = length(knee - hip);
	float dU = sd_box(q - vec2(lenU * 0.5, 0.0), vec2(lenU * 0.55, wUp)) - wUp * 0.4;
	plate(p, mix(hip, knee, 0.5), dU, gPlateA, aa);
	// knee cap
	plate(p, knee, length(p - knee) - wUp * 0.75, gPlateB, aa + 9.0);
}

// ── the ENEMY CHASSIS: the DIFFUSE sprite only (base + coverage), gait phase explicit ─────────
// No eyes glow, no exhaust embers, no damage — those are emissive/id/time-dependent and are added
// live in bodylib.glsl (or, for the atlas path, re-added procedurally after the fetch). Baking these
// three is what turns the horde's fragment cost from ~45 vnoise + 6 legs into one texture fetch.

void spider_chassis(vec2 p, Body b, float gt) {
	// Quad-leg spider mech: four chunky armored legs on a boxy painted hull with an olive glacis,
	// rear engine block and a red sensor slit.
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = max(r * 0.22, 2.8);
	lay(vec3(0.015), 0.35 * soft(length(p - vec2(4.0, 6.0)) - r * 0.95));
	float wUp = r * 0.22, wLo = r * 0.075;
	mech_leg(p, r,  0.78, gt,           wUp, wLo); // diagonal gait: FL+RR, FR+RL
	mech_leg(p, r, -0.78, gt + 3.14159, wUp, wLo);
	mech_leg(p, r,  2.36, gt + 3.14159, wUp, wLo);
	mech_leg(p, r, -2.36, gt,           wUp, wLo);
	// hull: main deck + front glacis + rear engine block
	plate(p, vec2(0.0), sd_box(p, vec2(r * 0.72, r * 0.56)) - r * 0.14, gPlateA, 1.0);
	plate(p, vec2(r * 0.5, 0.0), sd_box(p - vec2(r * 0.5, 0.0), vec2(r * 0.26, r * 0.42)) - r * 0.08, gPlateB, 2.0);
	plate(p, vec2(-r * 0.55, 0.0), sd_box(p - vec2(-r * 0.55, 0.0), vec2(r * 0.20, r * 0.34)) - r * 0.06, gPlateB * 0.75, 3.0);
	// corner deck bolts — visible fasteners say MACHINE
	for (float sx = -1.0; sx <= 1.0; sx += 2.0) {
		for (float sy = -1.0; sy <= 1.0; sy += 2.0) {
			lay(BOT_LINE * 2.6, soft(length(p - vec2(sx * r * 0.48, sy * r * 0.36)) - r * 0.055));
		}
	}
	// paired sensor EYE SOCKETS on the front hull corners (the glow is emissive → bodylib.glsl)
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		lay(BOT_LINE, soft(length(p - vec2(r * 0.58, s * r * 0.28)) - r * 0.12));
	}
}

void skitter_chassis(vec2 p, Body b, float gt) {
	// Light scout mech: narrow wedge hull on four thin quick legs, orange nose stripe.
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = max(r * 0.30, 2.8);
	lay(vec3(0.015), 0.30 * soft(length(p - vec2(3.0, 5.0)) - r * 0.9));
	float wUp = r * 0.16, wLo = r * 0.07;
	mech_leg(p, r,  0.95, gt,           wUp, wLo);
	mech_leg(p, r, -0.95, gt + 3.14159, wUp, wLo);
	mech_leg(p, r,  2.25, gt + 3.14159, wUp, wLo);
	mech_leg(p, r, -2.25, gt,           wUp, wLo);
	plate(p, vec2(0.0), sd_box(p, vec2(r * 1.02, r * 0.38)) - r * 0.18, gPlateB, 1.0);
	plate(p, vec2(r * 0.55, 0.0), sd_box(p - vec2(r * 0.58, 0.0), vec2(r * 0.30, r * 0.26)) - r * 0.10, gPlateA, 2.0);
	lay(gMark, soft(sd_box(p - vec2(-r * 0.25, 0.0), vec2(r * 0.48, r * 0.055))) * 0.85);
}

void brute_chassis(vec2 p, Body b, float gt) {
	// Super-heavy: six wide-plated legs under a massive deck with side missile pods, a big chevron.
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = max(r * 0.18, 2.8);
	lay(vec3(0.015), 0.38 * soft(length(p - vec2(5.0, 7.0)) - r * 1.05));
	float wUp = r * 0.20, wLo = r * 0.07;
	for (float i = 0.0; i < 3.0; i += 1.0) {
		for (float s = -1.0; s <= 1.0; s += 2.0) {
			float aa = s * (0.62 + i * 0.94);
			mech_leg(p, r, aa, gt + i * 2.09 + s * 0.5, wUp, wLo);
		}
	}
	plate(p, vec2(0.0), sd_box(p, vec2(r * 0.80, r * 0.64)) - r * 0.14, gPlateA, 1.0);
	// side missile pods with tube holes
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		vec2 pod = vec2(r * 0.08, s * r * 0.52);
		plate(p, pod, sd_box(p - pod, vec2(r * 0.34, r * 0.16)) - r * 0.05, gPlateB, s + 4.0);
		for (float k = -1.0; k <= 1.0; k += 1.0) {
			lay(BOT_LINE, soft(length(p - pod - vec2(k * r * 0.2, 0.0)) - r * 0.055));
		}
	}
	// forward glacis — plain armor, NO marking (painted shapes all read as glyphs)
	plate(p, vec2(r * 0.55, 0.0), sd_box(p - vec2(r * 0.56, 0.0), vec2(r * 0.22, r * 0.34)) - r * 0.06, gPlateB, 6.0);
}

#endif
