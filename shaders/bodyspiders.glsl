#ifndef BODYSPIDERS_GLSL
#define BODYSPIDERS_GLSL
#include "bodyfx.glsl"
// ── the SPIDER FAMILY: the horde's three walkers, procedural path ──────────────
// Chassis (plates/legs) come from bodykit.glsl (shared with the atlas baker); this adds
// the LIVE emissive (pulsing eyes, exhausts — id/time-dependent, unbakeable) and wraps
// them as full sprites for the low-count paths: dying/limping enemies (horde.frag) and
// the ally fallback (crew.frag). The live horde reads the baked atlas instead
// (enemy_atlas in horde.frag).
void spider_emissive(vec2 p, Body b) {
	float r = b.radius;
	for (float s = -1.0; s <= 1.0; s += 2.0) { // rear exhausts, faintly hot
		add += PAL_EMBER * 0.5 * soft(length(p - vec2(-r * 0.72, s * r * 0.18)) - r * 0.07);
	}
	float beat = 0.7 + 0.5 * sin(pc.time * 2.8 + float(v_id) * 0.7); // eyes PULSE like a heartbeat — alive
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += gEye * 1.1 * beat * soft(length(p - vec2(r * 0.58, s * r * 0.28)) - r * 0.08);
	}
}

void spider(vec2 p, Body b, float t) { spider_chassis(p, b, gait_ph(b)); spider_emissive(p, b); battle_damage(p, b, HP_SPIDER); }

void skitter_emissive(vec2 p, Body b) {
	float r = b.radius;
	float beat = 0.7 + 0.5 * sin(pc.time * 3.4 + float(v_id) * 0.9); // pulsing eye — alive
	add += gEye * 1.3 * beat * soft(length(p - vec2(r * 0.95, 0.0)) - r * 0.11);
}

void skitter(vec2 p, Body b, float t) { skitter_chassis(p, b, gait_ph(b)); skitter_emissive(p, b); battle_damage(p, b, HP_SKITTER); }

void brute_emissive(vec2 p, Body b) {
	float r = b.radius;
	float pulse = 0.8 + 0.3 * sin(pc.time * 3.0 + float(v_id)); // core vents: two hot slits, pulsing
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += gEye * pulse * soft(sd_box(p - vec2(-r * 0.30, s * r * 0.14), vec2(r * 0.17, r * 0.028)));
	}
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += PAL_EMBER * 0.6 * soft(length(p - vec2(-r * 0.72, s * r * 0.22)) - r * 0.06); // exhausts
	}
}

void brute(vec2 p, Body b, float t) { brute_chassis(p, b, gait_ph(b)); brute_emissive(p, b); battle_damage(p, b, HP_BRUTE); }

#endif // BODYSPIDERS_GLSL
