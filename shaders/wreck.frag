// ── body group: GROUND WRECKS (the old mode-0 layer) ───────────────────────────
// Drawn first, under everything alive — dead husks never paint over live bots. The
// draw spans every slot (wrecks lie in enemy AND ally ranges); body.vert culls the
// rest (pc.mode 0 shows only grounded husks). One of the five per-kind-group body
// pipelines (render.odin) — small entry points = small parallel driver compiles.

void main() {
	Body b = BODIES[v_id];
	if (b.kind == KIND_DEAD) { discard; }
	body_paint();
	vec2 p = v_local;
	if (b.kind == KIND_FACTORY) { factory(p, b); } // the pads are ground too — the horde walks over them
	else { wreck(p, b); }
	body_finish(p, b);
}
