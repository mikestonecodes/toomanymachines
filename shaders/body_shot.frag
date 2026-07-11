#version 460
#include "bodylib.glsl"

// ── body group: SHOTS (bullet slots BULLET_LO..TURRET_LO) ──────────────────────
// Plasma bolts with their trails, settled mines, and the detonation flash of dying
// shells (VAR_BOOM — the shockwave itself is the composite's distortion). See
// bodylib.glsl for the split story.

void main() {
	Body b = BODIES[v_id];
	if (b.kind == KIND_DEAD) { discard; }
	body_paint();
	vec2 p = v_local;
	if      (b.kind == KIND_BULLET) { bullet(p, b); }
	else if (b.kind == KIND_DYING && (b.variant == VAR_BOOM || b.variant == VAR_SPARK)) { burst(p, b); }
	body_finish(p, b);
}
