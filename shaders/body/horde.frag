// ── body group: the HORDE (enemy slots ENEMY_LO..BULLET_LO) ────────────────────
// The 80k live machines off the baked atlas, their dying bodies on the procedural
// spider-family path (bodyspiders.glsl, byte-identical to the pre-split monolith),
// hoisted husks riding drones, and the pit-sink sparks. Enemy slots only ever hold
// the spider family, so the war rigs (bodyrigs.glsl) never compile into this build.

// map the horde variant → atlas kind row
uint atlas_kind(uint variant) { return variant == VAR_SKITTER ? 1u : (variant == VAR_BRUTE ? 2u : 0u); }

// fetch one atlas tile (kind, frame) at in-tile uv (clamped a half-texel in so bilinear can't
// bleed across tiles). Tiles are laid out row-major: tile = kind*ATLAS_FRAMES + frame.
vec4 atlas_tile(uint kind, uint frame, vec2 uv_in) {
	uint tile = kind * ATLAS_FRAMES + frame;
	vec2 cell = vec2(float(tile % ATLAS_COLS), float(tile / ATLAS_COLS));
	float inset = 0.5 / float(ATLAS_TILE);
	vec2 uv = (cell + clamp(uv_in, inset, 1.0 - inset)) * (float(ATLAS_TILE) / float(ATLAS_DIM));
	return texture(TEXS[IMG_BODYA], uv);
}

// the alive-horde FAST PATH: sample the baked DIFFUSE chassis (base in rgb, cov in a) at the
// nearest gait frame, then re-add the live emissive + battle damage. Replaces ~45 vnoise + 6
// procedural legs per fragment with one texture fetch.
void enemy_atlas(vec2 p, Body b) {
	uint kind = atlas_kind(b.variant);
	vec2 uv_in = clamp((p / (b.radius * ATLAS_EXTK)) * 0.5 + 0.5, 0.0, 1.0); // p → in-tile uv (ext matches body.vert)
	// NEAREST gait frame (no cross-fade): blending two leg poses ghosts the legs and softens the
	// whole machine. ATLAS_FRAMES is dense enough that the discrete step reads as motion, not chop.
	uint frame = uint(fract(gait_ph(b) / TAU) * float(ATLAS_FRAMES) + 0.5) % ATLAS_FRAMES;
	vec4 s = atlas_tile(kind, frame, uv_in);
	base = s.rgb; cov = s.a;
	if      (kind == 0u) spider_emissive(p, b);
	else if (kind == 1u) skitter_emissive(p, b);
	else                 brute_emissive(p, b);
	battle_damage(p, b, max_hp(b.variant));
}

// the enemy-slot chassis dispatch: spider / skitter / brute (the ally classes live
// in crew.frag's dispatch)
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
