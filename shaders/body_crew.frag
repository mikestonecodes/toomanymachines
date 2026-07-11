#version 460
#include "bodylib.glsl"

// ── body group: the CREW (turret/helper/ally slots, TURRET_LO..) ───────────────
// Defense towers with their sweeping fire, the salvage-drone fleet, YOUR army's war
// machines (bot_sprite's full dispatch — the same chassis double as garage rides in
// body_ship.frag), their deaths, and hoisted ally husks. See bodylib.glsl.

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
