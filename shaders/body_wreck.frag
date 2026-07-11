#version 460
#include "bodylib.glsl"

// ── body group: GROUND WRECKS (the old mode-0 layer) ───────────────────────────
// Drawn first, under everything alive — dead husks never paint over live bots. The
// draw spans every slot (wrecks lie in enemy AND ally ranges); body.vert culls the
// rest (pc.mode 0 shows only grounded husks). See bodylib.glsl for the split story.

void main() {
	Body b = BODIES[v_id];
	if (b.kind == KIND_DEAD) { discard; }
	body_paint();
	vec2 p = v_local;
	wreck(p, b);
	body_finish(p, b);
}
