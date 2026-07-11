// ── the OFFLINE BODY-ATLAS BAKE ───────────────────────────────────────────────
// Renders the enemy CHASSIS (spider/skitter/brute) into assets/body.cache, once, as a grid of
// [kind × gait-frame] tiles. The runtime horde (horde.frag: enemy_atlas) then FETCHES a tile
// instead of running ~45 vnoise + 6 procedural legs per fragment — the big bodies win.
//
// Only the DETERMINISTIC diffuse chassis is baked: the plate grunge is vnoise(body-frame p) with
// per-plate constant seeds — NO v_id — so every enemy of a kind already shares it (baking is
// lossless, not a loss of variation). The gait cycle is the only per-body variable, sampled at
// ATLAS_FRAMES phases here and cross-faded at runtime. Everything id/time-dependent (pulsing
// eyes, exhaust embers, battle damage) is NOT baked — bodyspiders.glsl re-adds it live.
//
// Output per texel: RGB = diffuse base, A = coverage. gl_FragCoord picks the tile + the in-tile
// body-frame position, the exact inverse of horde.frag's p→uv mapping (ATLAS_EXTK · ATLAS_RAD).


void main() {
	uint col = uint(gl_FragCoord.x) / ATLAS_TILE;
	uint row = uint(gl_FragCoord.y) / ATLAS_TILE;
	uint tile = row * ATLAS_COLS + col;
	uint kind = tile / ATLAS_FRAMES;
	uint frame = tile % ATLAS_FRAMES;
	if (kind >= ATLAS_KINDS) { o_color = vec4(0.0); return; } // unused tiles → transparent

	// in-tile [0,1] → body-frame px at the reference radius (inverse of enemy_atlas's p→uv)
	vec2 inTile = (gl_FragCoord.xy - vec2(col, row) * float(ATLAS_TILE)) / float(ATLAS_TILE);
	vec2 p = (inTile - 0.5) * 2.0 * (ATLAS_RAD * ATLAS_EXTK);

	// the horde's paint (mirrors bodyfx.glsl body_paint()'s enemy branch) — the DIFFUSE values the
	// chassis reads. gEye is emissive-only (re-added live), set here just for parity.
	gPlateA = vec3(0.120, 0.121, 0.136); // slightly cool steel
	gPlateB = vec3(0.063, 0.064, 0.075);
	gBrush  = 2.6;
	gGrime  = 1.2;
	gEye    = vec3(1.60, 0.16, 0.06);
	gMark   = vec3(0.85, 0.13, 0.04);

	Body b;
	b.pos = vec2(0.0); b.vel = vec2(0.0); b.radius = ATLAS_RAD; b.life = 0.0;
	b.hp = 999.0; b.angle = 0.0; b.kind = KIND_ENEMY; b.variant = 0u; b.gen = 0u;
	float gt = float(frame) / float(ATLAS_FRAMES) * TAU;

	if      (kind == 0u) spider_chassis(p, b, gt);
	else if (kind == 1u) skitter_chassis(p, b, gt);
	else                 brute_chassis(p, b, gt);

	o_color = vec4(base, cov); // diffuse + coverage; emissive is re-added at runtime
}
