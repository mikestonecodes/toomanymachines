#version 460
#include "bodyspiders.glsl"
#include "bodyrigs.glsl"

// ── body group: the CREW (turret/helper/ally slots, TURRET_LO..) ───────────────
// Defense towers with their sweeping fire, the salvage-drone fleet, YOUR army's war
// rigs (bodyrigs.glsl — the same chassis double as garage rides in ship.frag), their
// deaths, and hoisted ally husks.

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
	float angW;
	if (mg) { angW = hash1(v_id * 913u) * TAU + pc.time * 2.6; } // gun: spinning sweep
	else { // perimeter laser: always OUTWARD, sweeping a cone away from the city
		vec2 outw = b.pos - vec2(WORLD * 0.5);
		angW = atan(outw.y, outw.x) + sin(pc.time * 0.35 + hash1(v_id * 913u) * TAU) * 1.1;
	}
	vec2 bd2 = rot2(angW - b.angle) * vec2(1.0, 0.0); // fire dir, body frame
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
	} else if (firing) { // ── the giant laser: a one-sided bar burning OUT into the wasteland
		float bd = sd_seg(p, vec2(0.0), bd2 * len);
		float flick = 0.85 + 0.30 * sin(pc.time * 47.0 + dot(p, bd2) * 0.03);
		add += (vec3(1.3, 1.0, 0.7) + PAL_EMBER * 0.5) * exp(-bd * bd / (30.0 * flick)) * 1.5 * env;
		add += PAL_ACCENT * exp(-bd * bd / (TWR_W * TWR_W)) * 0.35 * env;
		add += PAL_EMBER * exp(-bd * bd / (TWR_W * TWR_W * 6.25)) * 0.10 * env; // veil: gaussian, dies inside the quad
	}
	if (length(p) > r * 3.5) { return; } // beyond the fortress: fire only
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = 4.0;
	lay(vec3(0.012), 0.45 * soft(length(p - vec2(5.0, 7.0)) - r * 1.6));
	plate(p, vec2(0.0), length(p) - r * 1.5, BOT_LINE * 3.0, 1.0);  // apron ring
	plate(p, vec2(0.0), length(p) - r * 1.05, gPlateB, 2.0);      // armored drum
	for (float i = 0.0; i < 6.0; i += 1.0) {                        // buttresses
		vec2 bp = rot2(i * TAU / 6.0 + 0.4) * vec2(r * 1.25, 0.0);
		plate(p, bp, sd_box(rot2(-i * TAU / 6.0 - 0.4) * (p - bp), vec2(r * 0.28, r * 0.14)), gPlateA, i + 3.0);
	}
	// rotating emitter head, aimed along the sweep
	vec2 hq = rot2(-(angW - b.angle)) * p;
	plate(p, vec2(0.0), sd_box(hq - vec2(r * 0.20, 0.0), vec2(r * 0.55, r * 0.28)) - r * 0.1, gPlateA, 9.0);
	lay(BOT_LINE * 2.0, soft(sd_box(hq - vec2(r * 0.62, 0.0), vec2(r * 0.30, r * 0.10))));
	// the eye on top: steady TEAM GREEN (defense is your side — red is the enemy's);
	// the tower itself NEVER flashes, only its rounds and ricochets move
	add += RIG_GRN * 0.8 * soft(length(p) - r * 0.30);
}

void helper(vec2 p, Body b) {
	// Salvage drone: a twin-rotor lifter, sized to READ as the fleet. Amber work light,
	// grey shell, a hoist beam down to the wreck it's fetching (target slot in gen).
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = 2.6;
	float sc = 14.0 / max(b.radius, 8.0); // sprite drawn in classic proportions, scaled up by radius
	p *= sc;
	// ALTITUDE faked by scale: cruising high = closer to the camera = BIGGER; it swoops
	// small as it descends onto a wreck, and hauls home a bit lower under the load
	float alt = 1.0;
	if (b.gen == 0x80000000u) { alt = 0.75; } // hauling: heavy, riding lower
	else if (b.gen != 0u) {
		Body tw2 = BODIES[b.gen - 1u];
		alt = clamp(distance(b.pos, tw2.pos) / 160.0, 0.18, 1.0); // swooping down to grab
	}
	p /= 0.55 + 0.55 * alt; // cruise reads modest (1.10×); it shrinks well down for ground pickups (0.65×)
	float bob = sin(pc.time * 3.1 + float(v_id)) * 1.2;
	lay(vec3(0.012), 0.4 * soft(length(p - vec2(5.0, 8.0 + bob + alt * 9.0)) - 9.0)); // shadow drifts with height
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
	add += RIG_GRN * 1.6 * soft(length(p - vec2(-9.5, 0.0)) - 2.0) * (0.6 + 0.4 * sin(pc.time * 4.0 + float(v_id))); // work light — team green
	add += RIG_GRN * 1.0 * soft(length(p - vec2(2.0, 0.0)) - 1.2) * step(0.5, fract(pc.time * 1.6 + hash1(v_id))); // status blinker — team green
}

// One dispatch for every live/dying chassis sprite. Allies carry their locked target
// in gen — that gives the gun sprites their tracer reach (and the drones their arming
// ramp); the ally BODY faces the target, so the gun line is +x in the body frame.
void bot_sprite(vec2 p, Body b, float t) {
	vec2 aimd = vec2(1.0, 0.0);
	float shoot = 0.0, arm = 0.0;
	if (b.kind == KIND_ALLY && b.gen != 0u) {
		shoot = distance(BODIES[b.gen - 1u].pos, b.pos);
		arm = clamp(1.0 - shoot / 900.0, 0.0, 1.0);
	}
	if      (b.variant == VAR_SKITTER) { skitter(p, b, t); }
	else if (b.variant == VAR_BRUTE)   { brute(p, b, t); }
	else if (b.variant == VAR_TANK)    { tank(p, b, t, aimd, shoot); }
	else if (b.variant == VAR_RAIDER)  { raider(p, b, t, aimd, shoot); }
	else if (b.variant == VAR_SUICIDE) { suicide(p, b, t, arm); }
	else if (b.variant == VAR_GUNNER)  { gunner(p, b, t, aimd, shoot); }
	else if (b.variant == VAR_BOMBER)  { bomber(p, b, t); }
	else                               { spider(p, b, t); }
}

void main() {
	Body b = BODIES[v_id];
	if (b.kind == KIND_DEAD) { discard; }
	body_paint();
	vec2 p = v_local;
	float t = pc.time + hash1(v_id * 7919u) * TAU;
	if      (b.kind == KIND_WRECK)  { wreck(p, b); } // hoisted ally husk
	else if (b.kind == KIND_TURRET) { turret(p, b); }
	else if (b.kind == KIND_HELPER) { helper(p, b); }
	else if (b.kind == KIND_ALLY)   { bot_sprite(p, b, t); }
	else if (b.kind == KIND_DYING && (b.variant == VAR_BOOM || b.variant == VAR_SPARK)) { burst(p, b); }
	else if (b.kind == KIND_DYING)  { p = dying_warp(p, b); bot_sprite(p, b, t); dying_tint(p, b); }
	body_finish(p, b);
}
