#version 460
#include "bodylib.glsl"

// ── body group: the HORDE (enemy slots ENEMY_LO..BULLET_LO) ────────────────────
// The 80k live machines off the baked atlas, their dying bodies on the procedural
// spider-family path (byte-identical to the old monolith), hoisted husks riding
// drones, and the pit-sink sparks. Enemy slots only ever hold the spider family, so
// the war-machine classes never compile into this build. See bodylib.glsl.

// the enemy-slot chassis dispatch: spider / skitter / brute (bot_sprite minus the
// ally classes — those live in body_crew.frag's build)
void horde_sprite(vec2 p, Body b, float t) {
	if      (b.variant == VAR_SKITTER) { skitter(p, b, t); }
	else if (b.variant == VAR_BRUTE)   { brute(p, b, t); }
	else                               { spider(p, b, t); }
}

void main() {
	Body b = BODIES[v_id];
	if (b.kind == KIND_DEAD) { discard; }
	body_paint();
	vec2 p = v_local;
	float t = pc.time + hash1(v_id * 7919u) * TAU;
	if      (b.kind == KIND_WRECK) { wreck(p, b); } // hoisted husk, hauled by a drone
	else if (b.kind == KIND_DYING && (b.variant == VAR_BOOM || b.variant == VAR_SPARK)) { burst(p, b); }
	else if (b.kind == KIND_DYING) { p = dying_warp(p, b); horde_sprite(p, b, t); dying_tint(p, b); }
	else {
		float dmgJ = 1.0 - clamp(b.hp / max_hp(b.variant), 0.0, 1.0);
		if (dmgJ > 0.3) { // crippled machines LIMP — a slow heavy sway, not a vibration
			p += vec2(sin(pc.time * 6.0 + float(v_id)), cos(pc.time * 7.0 + float(v_id))) * (dmgJ - 0.3) * 2.2;
		}
		enemy_atlas(p, b); // the live horde: two texture fetches, not ~45 vnoise
		if (b.life > 0.0 && b.hp > -50.0) { base = mix(base, vec3(1.5, 0.62, 0.28), min(b.life, 1.0) * 0.85); } // hit flash (never on stamped bots)
	}
	body_finish(p, b);
}
