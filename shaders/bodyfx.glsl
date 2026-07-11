#ifndef BODYFX_GLSL
#define BODYFX_GLSL
#include "common.glsl"
#include "bodykit.glsl"
// ── shared BODY-PASS SCAFFOLDING ────────────────────────────────────────────────
// Everything every body-group fragment shader needs around its sprites: the varyings,
// the gait odometer, team paint, battle damage, the wreck husk + death bursts (multiple
// groups draw them), the dying warp/tint pair, and body_finish — the tail (blast
// rim-light, high-beams, building occlusion, premultiplied output) each main runs last.
// The sprites themselves live where they're used: bodyspiders/bodyrigs (shared) or
// inline in the one group frag that draws them.
// Vertex → fragment interface (must match body.vert's `out`s) + the pass output.
layout(location = 0) in vec2      v_local; // body-frame px
layout(location = 1) in flat uint v_id;
layout(location = 0) out vec4 o_color;
// the CITY CACHE (Img.CityC) — sampled for building occlusion (body_finish), replacing a
// duplicated 8-step house_at march; the BODY ATLAS (Img.BodyA) — the baked horde chassis.
layout(set = 0, binding = 1) uniform sampler2D TEXS[];

// GAIT ODOMETER: leg phase advances with actual TRAVEL, not time·speed — a time·speed
// phase re-scales its whole history whenever the velocity changes (contact shoves do,
// every frame), which teleports the legs into a jitter. The horde marches radially
// (in toward the pit, allies out from it), so distance-to-center IS the path odometer:
// legs freeze when a bot is blocked, backpedal when it's flung, never jitter. The rate
// is sized so feet approximately PLANT (sweep-back speed ≈ body speed), capped so the
// tiny fast classes don't strobe. The player's walkers carry a true CPU-integrated
// odometer in b.life instead (their motion isn't radial).
float gait_ph(Body b) {
	float k = min(5.0 / b.radius, 0.22);
	float d = distance(b.pos, vec2(WORLD * 0.5));
	return (v_id >= ALLY_LO || v_id == 0u ? d : -d) * k + hash1(v_id * 7919u) * TAU;
}

// team paint: YOUR army (and its dying/limping bodies) burns green, never red
void body_paint() {
	if (v_id >= ALLY_LO) { gMark = vec3(0.20, 0.44, 0.18); gEye = RIG_GRN * 0.9; }
	// the HORDE (every enemy slot, dying ones included): dusty RUST-TONED steel — the
	// same warm desaturated family as the city's roofs and facades, one notch more
	// saturated so the machines read as machines — wearing RED unit paint and
	// RED-burning sensor eyes: a field of red eyes on the night ground.
	else if (v_id >= ENEMY_LO && v_id < BULLET_LO) {
		gPlateA = vec3(0.120, 0.121, 0.136); // SLIGHTLY cool steel — a faint blue cast lifts the horde off the warm city
		gPlateB = vec3(0.063, 0.064, 0.075);
		gBrush  = 2.6; // the most worked-over, filthiest metal on the field
		gGrime  = 1.2;
		gEye    = vec3(1.60, 0.16, 0.06); // HDR red — the eyes BLOOM like the player's green
		gMark   = vec3(0.85, 0.13, 0.04);    // BRIGHT red unit paint — the enemy's language
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

void wreck(vec2 p, Body b) {
	// Unmistakably DEAD: a flattened charcoal husk under settling ash — none of the
	// living paint and NO red (red is the language of live threats). Drones haul it.
	float r = b.radius;
	float fade = clamp(b.life / 3.0, 0.0, 1.0);
	uint s = v_id * 613u;
	if (b.variant == 1u) { p *= 0.72; } // AIRBORNE, hoisted by a drone: closer to camera = bigger
	else { p *= 0.82; }                 // collapsed flat on the ground
	lay(vec3(0.016, 0.015, 0.014), 0.6 * fade * soft(length(p) - r * 1.25)); // scorch bed
	for (float i = 0.0; i < 4.0; i += 1.0) { // dead legs, splayed
		float aa = (i + 0.5) * (TAU / 4.0) + hash1(s + uint(i)) * 0.8 - 0.4;
		vec2 tip = rot2(aa) * vec2(r * (1.5 + 0.5 * hash1(s + 9u + uint(i))), 0.0);
		lay(vec3(0.030, 0.029, 0.028), soft(sd_seg(p, vec2(0.0), tip) - r * 0.10) * fade);
	}
	// buckled hull: bare cold-steel plates with the faintest BLUE cast — dead metal
	lay(vec3(0.046, 0.049, 0.058), soft(sd_box(rot2(0.4) * p, vec2(r * 0.62, r * 0.46)) - r * 0.10) * fade);
	lay(vec3(0.034, 0.037, 0.044), soft(sd_box(p - vec2(r * 0.2, r * 0.1), vec2(r * 0.32, r * 0.22)) - r * 0.05) * fade);
	// pale ash dusting settling over the top — DEAD reads pale, flat, cool
	float ash = hash21(floor(p / 4.0) + float(v_id));
	base = mix(base, vec3(0.104, 0.107, 0.115), step(0.62, ash) * 0.65 * cov);
	// metal SPARKLE: tiny sparse glints with the faintest cool cast — extremely subtle
	vec2 gc2 = floor(p / 6.0);
	vec2 gd2 = (fract(p / 6.0) - vec2(hash21(gc2 + float(v_id)), hash21(gc2 + float(v_id) + 7.0))) * 6.0;
	float glint = exp(-dot(gd2, gd2) / 0.8) * step(0.86, hash21(gc2 + 3.1));
	add += vec3(0.26, 0.29, 0.34) * glint * fade * cov * 0.45;
	base *= 0.4 + 0.6 * fade; // crumbles away if left to rot
	if (b.variant != 1u) { cov *= 0.55; } // on the ground: faded but clearly THERE
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
	if (b.variant == VAR_SPARK) { // ── PIT SINK: the shaft takes its due, QUIETLY.
		// No blast, no splash: the husk slides for the throat, then rides the pit's
		// mirrored fake-3D lean straight DOWN-screen — shrinking, turning slowly, going
		// to black silhouette against the furnace under-glow — and a few draft embers
		// ride the heat back up the shaft. The quad is rotated by b.angle, so work in a
		// screen-aligned frame (+y = down-screen) for the descent.
		vec2 pw = rot2(b.angle) * p;
		vec2 toC = normalize(vec2(WORLD * 0.5) - b.pos + vec2(0.0001));
		float slide = smoothstep(0.0, 0.6, prog);   // drift the last stretch to the hole
		float drop  = smoothstep(0.2, 0.9, prog);   // then go under
		vec2 hc = toC * slide * 26.0 + vec2(0.0, LEAN * 0.80 * drop * drop); // down to the crucible floor
		float hs = max(1.0 - 0.82 * drop, 0.12);
		vec2 hq = rot2(prog * 2.6) * (pw - hc) / hs;
		float husk = soft(sd_box(hq, vec2(b.radius * 0.62, b.radius * 0.45)) * hs - 2.0);
		float dd = dot(pw - hc, pw - hc);
		add += (PAL_EMBER * 1.2 + vec3(0.10)) * exp(-dd / (b.radius * b.radius * 1.6))
		     * drop * (1.0 - drop) * 1.1;                    // melt light closing over it — soft, no flare
		lay(mix(vec3(0.046, 0.041, 0.037), vec3(0.010, 0.007, 0.005), drop), husk * (1.0 - drop * drop * 0.85));
		add += PAL_EMBER * husk * drop * (1.0 - drop) * 0.8; // heat licking its plates on the way down
		for (float i = 0.0; i < 4.0; i += 1.0) { // draft embers climbing back out, cooling
			uint si = s + uint(i) * 29u;
			float em = fract(prog * 1.4 + hash1(si));
			vec2 c = hc + vec2((hash1(si + 1u) - 0.5) * b.radius * 1.3, -em * 44.0 - 4.0);
			float sz = 1.5 + 1.3 * hash1(si + 2u);
			add += PAL_EMBER * exp(-dot(pw - c, pw - c) / (sz * sz)) * (1.0 - em) * (1.0 - em) * drop * fade * 1.4;
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

// The dying wrap around a chassis sprite, split in two so each group keeps its own
// dispatch between them: warp the body frame first, paint the sprite, then tint it.
// hp < -50 = blast-stamped (the exact circle): a slow smolder that SNAPS red, then the
// body slumps and COOLS into the husk. Otherwise the machine dies in place and POPS.
vec2 dying_warp(vec2 p, Body b) {
	if (b.hp < -50.0) {
		float pr = 1.0 - clamp(b.life / 0.4, 0.0, 1.0); // 1 → 0 over the stamp death
		return p * (1.0 + smoothstep(0.75, 1.0, pr) * 0.30); // it slumps down at the end
	}
	float prog = 1.0 - clamp(b.life / DEATH_T, 0.0, 1.0);
	float pop = exp(-prog * 9.0);
	p /= 1.0 + 0.25 * pop; // squash-and-stretch: an instant puff, deflating fast
	return p + vec2(sin(pc.time * 47.0 + float(v_id)), cos(pc.time * 53.0 + float(v_id))) * 2.2 * (1.0 - prog);
}

void dying_tint(vec2 p, Body b) {
	if (b.hp < -50.0) {
		float pr = 1.0 - clamp(b.life / 0.4, 0.0, 1.0);
		float flash = pr * pr * (1.0 - smoothstep(0.88, 1.0, pr) * 0.8); // ease-in, then it cools
		base = mix(base, vec3(1.35, 0.40, 0.14), flash * 0.95);          // RED-hot, not white
		base *= 1.0 - smoothstep(0.8, 1.0, pr) * 0.6;                    // charring toward the husk
		add *= 1.0 - pr;
		add += PAL_ACCENT * flash * 0.5 * cov; // and it glows as it goes
		return;
	}
	// the POP: a HARD white-hot silhouette (pure base — no bloom, so it's a crisp comic
	// pop, not a blur) and short radial burst streaks snapping outward. Then it shudders
	// and chars down toward the husk. The effect wears the mech — no circles, no orbs.
	float prog = 1.0 - clamp(b.life / DEATH_T, 0.0, 1.0);
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
	base *= 1.0 - 0.72 * prog; // charring down — hands off near the husk's darkness
	add *= 1.0 - prog;         // every light dies with it: the husk emits NOTHING
	burst(p, b);
}

// The shared tail every group runs after its sprite: blast rim-light, the truck's
// high-beams, fake-3D building occlusion, and the premultiplied output.
void body_finish(vec2 p, Body b) {
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
	// caught in the truck's high-beams: a gentle pick-out, not a whitewash — the paint
	// (and the camo) must survive the light
	if (b.kind != KIND_PLAYER) {
		vec2 relb = b.pos - pc.player;
		vec2 fdir = vec2(cos(pc.angle), sin(pc.angle));
		float alongb = dot(relb, fdir);
		if (alongb > 0.0) {
			float latb = abs(dot(relb, vec2(-fdir.y, fdir.x)));
			float spread = 24.0 + alongb * 0.40; // matches the ground beam in city.frag
			float beam = exp(-latb * latb / (spread * spread)) * smoothstep(760.0, 30.0, alongb)
			           * smoothstep(40.0, 260.0, alongb);
			base += (base * 1.4 + vec3(0.055, 0.050, 0.040)) * beam * cov; // lifts the paint, keeps its hue
			add += vec3(1.0, 0.92, 0.75) * beam * 0.06 * cov;
		}
	}
	// fake-3D occlusion: bodies live ON THE GROUND — march the same city silhouettes
	// city.frag draws, and if a building covers this pixel the building is in front (a
	// bot on the street behind a tower must NOT be painted onto its roof). This also
	// clips legs/sparks poking into facades at ground level. Salvage drones, artillery
	// shells, hoisted wrecks (variant flag), the airborne ally classes (suicide drones,
	// bombers) and the player's WING fly ABOVE it all and skip the test.
	if (b.kind != KIND_HELPER && b.kind != KIND_BULLET
	    && !(b.kind == KIND_WRECK && b.variant == 1u)
	    && !(b.kind == KIND_ALLY && (b.variant == VAR_SUICIDE || b.variant == VAR_BOMBER))
	    && !(b.kind == KIND_PLAYER && b.variant == RIDE_WING)
	    && (cov > 0.003 || dot(add, add) > 0.00001)) {
		// building occlusion: a bot behind a building must not paint onto its roof. This
		// used to re-march house_at 8× here; now it's one fetch of the SAME baked cache
		// city.frag reads. Alpha > 0.75 = a HOUSE hit (0.5 plinth doesn't occlude — bots
		// stand on the plinth yard), byte-identical to the old house-only test.
		vec2 g0 = pc.cam + (gl_FragCoord.xy - pc.screen * 0.5) * ZOOM;
		ivec2 tx = ivec2(floor((g0 - vec2(CACHE_ORIGIN)) / ZOOM));
		if (all(greaterThanEqual(tx, ivec2(0))) && all(lessThan(tx, ivec2(int(CACHE_DIM))))
		    && texelFetch(TEXS[IMG_CITYC], tx, 0).a > 0.75) { discard; }
	}
	o_color = vec4(base * cov + add, cov); // premultiplied; `add` is pure emissive
}

#endif // BODYFX_GLSL
