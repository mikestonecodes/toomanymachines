#version 460
#include "bodylib.glsl"

// ── body group: the SHIP (instance 0, drawn last, over the crowd) ──────────────
// The player's current garage ride — ship() dispatches the ride variant across the
// same chassis sprites the army wears (tank/raider/gunner/bomber) plus the player-only
// walkers and the sport wedge, with the giant laser and every mounted weapon's beam
// geometry. The heaviest single sprite in the game, compiling alone in parallel with
// the other groups. See bodylib.glsl.

void main() {
	Body b = BODIES[v_id];
	if (b.kind == KIND_DEAD) { discard; }
	body_paint();
	vec2 p = v_local;
	ship(p, b);
	body_finish(p, b);
}
