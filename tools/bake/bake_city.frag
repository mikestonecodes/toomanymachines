// ── the OFFLINE CITY BAKE ─────────────────────────────────────────────────────
// Renders the whole STATIC building layer, once, into the world-anchored city cache
// (Img.CityC). This is the SAME oblique march city.frag used to run per-pixel every
// frame (12-step + 4-bisection over scene_h → house_at, then roof_col/wall_col/plinth) —
// moved here wholesale so it exists in exactly ONE place. Built only into the separate
// `citybake` binary (city_cache.odin / city_bake.odin). See render.odin CACHE_* consts.
//
// Output per texel: RGB = HDR building color; A = 3-level coverage {0 miss, 0.5 plinth,
// 1.0 house}. A miss (no building column) writes 0 so the game falls through to live
// ground. gl_FragCoord.xy = texel + 0.5, so g0 lands on the exact texel-center world
// position the runtime's NEAREST fetch will read back.

layout(location = 0) out vec4 o_color;

const vec2 SUN = vec2(-0.6, -0.8); // moon, really — key light from screen top-left

// The house system (house_at + house_h) lives in common.glsl. The whole solid block
// band is drawn as a raised PLINTH slab whose rim sits EXACTLY on the collision face
// (street_d == BLDG_EDGE, same test as building_push/block_pen) — what you see is the
// hitbox. Houses stand on top of the slab.
float scene_h(vec2 p) {
	House hs = house_at(p);
	if (hs.ok && hs.sd <= 0.0) { return house_h(hs); }
	return bldg_pen(p) > 0.0 ? 0.07 : 0.0;
}

// Rooftops, straight and readable, per district.
vec3 roof_col(vec2 g, House hs) {
	// segment-local frame: x across the wall, y within THIS 110px perimeter segment.
	// Repeating textures use WORLD coords (g) so they stay straight — nothing bends
	// around the block.
	vec2 lg = vec2(hs.lc.x, (fract(hs.lc.y / 110.0) - 0.5) * 110.0);
	float sx = hs.lc.x / hs.ext.x; // -1..1 across the wall band
	float sy = lg.y / 55.0;        // -1..1 within the segment
	// tints — GENTLE value steps with faint desaturated hues (dusty umber, taupe,
	// oxblood — NEVER anything blue-ish). A SOLID giant wears ONE paint over its whole
	// deck (one building, one color — detail comes from plating, not patches);
	// ordinary houses roll the tint per TERRACE RUN (~3 neighbors share a family, so
	// adjacent houses don't flip color), and each house only nudges the VALUE.
	bool solid = hs.ext.x > 70.0; // a full-plot giant: ONE building, ONE roof deck
	float hseed = hs.seed;
	vec2 qc = g - vec2(WORLD * 0.5);
	float rr = length(qc);
	float arc = (atan(qc.y, qc.x) - SPIRAL * rr) * rr;
	{
		vec3 blk = city_block(g);
		float ns = blk.x * RING_SP >= SPOKE2_R ? SPOKES : SPOKES * 0.5;
		float jw = blk.y - ns * floor(blk.y / ns);
		float bseed = hash21(vec2(blk.x, jw) * 3.1 + 9.2); // = house_at's bseed, per plot
		hseed = solid ? bseed : hash21(vec2(floor(hs.lc.y / 330.0), bseed * 91.0));
	}
	// tints per house — GENTLE value steps with faint desaturated hues, the whole
	// family leaning warm/reddish (NEVER anything blue-ish)
	vec3 base = mix(vec3(0.126, 0.110, 0.094), vec3(0.140, 0.130, 0.110), step(0.55, fract(hseed * 7.7)));
	base = mix(base, vec3(0.100, 0.094, 0.082), step(0.72, fract(hseed * 13.1))); // warm taupe
	base = mix(base, vec3(0.176, 0.156, 0.132), step(0.86, fract(hseed * 23.9))); // warm pale concrete
	base = mix(base, vec3(0.080, 0.061, 0.055), step(0.94, fract(hseed * 41.3))); // dark oxblood
	if (!solid) { base *= 0.94 + 0.12 * fract(hs.seed * 9.1); } // per-house VALUE nudge only
	vec3 col = base * (0.88 + 0.18 * hs.h);
	col *= 0.965 + 0.035 * vnoise(g * 0.18 + hseed * 40.0);   // fine grit — SMOOTH, no hash squares
	col *= 0.965 + 0.035 * vnoise(g * 0.05 + hs.seed * 30.0); // broad subtle sheen
	// party walls between the perimeter segments (110px pitch — matches house_at's
	// seed boundaries EXACTLY, so every tint/height step lands on a wall line).
	// A giant's deck instead shows machined PLATING in the block's polar frame
	// (concentric + radial → always street-parallel/perpendicular): coarse expansion
	// joints, a finer panel sub-grid, and a whisper of per-plate value wobble —
	// DETAIL without any color change.
	if (!solid) { col *= 0.86 + 0.14 * smoothstep(0.0, 1.6, (0.5 - abs(fract(hs.lc.y / 110.0) - 0.5)) * 110.0); }
	else {
		col *= 0.96 + 0.08 * hash21(vec2(floor(arc / 110.0), floor(rr / 96.0)) + fract(hseed * 17.0)); // plate wobble
		float sm = min((0.5 - abs(fract(arc / 110.0) - 0.5)) * 110.0,
		               (0.5 - abs(fract(rr / 96.0) - 0.5)) * 96.0);
		col *= 0.90 + 0.10 * smoothstep(0.0, 1.4, sm); // expansion joints
	}

	float edge = hs.sd; // ≤ 0 inside the building
	if (hs.h > 0.55) { // ── a TALL one: terraced setbacks PARALLEL to the street —
		// right angles only, matching house_h's depth bands exactly
		float dep = hs.lc.x + hs.ext.x;
		float wallD2 = hs.ext.x * 2.0;
		col = mix(col, base * 1.25, step(wallD2 * 0.38, dep));
		col = mix(col, base * 1.50, step(wallD2 * 0.70, dep));
		col = mix(col, vec3(0.03), (1.0 - smoothstep(0.0, 2.0, abs(dep - wallD2 * 0.38))) * 0.8);
		col = mix(col, vec3(0.03), (1.0 - smoothstep(0.0, 2.0, abs(dep - wallD2 * 0.70))) * 0.8);
		if (solid) { lg = hs.lc; } // the giant's crown features anchor at the block center
		if (!solid || length(hs.lc) < 200.0) { // ── antenna mast + steady service light
			float md = length(lg);
			col = mix(col, vec3(0.04), 1.0 - smoothstep(2.0, 4.0, md));
			col += PAL_LAMP * 1.3 * exp(-md * md / 16.0);
			col += vec3(0.35, 0.36, 0.4) * (1.0 - smoothstep(0.0, 1.6, abs(md - 8.0))) * 0.5; // guy ring
		}
	} else if (hs.dis < 0.5 && !solid && hs.ext.x < 48.0) { // residential: pitched roof (matches house_h)
		float lit = dot(hs.u, normalize(SUN));
		col *= vec3(1.12, 0.94, 0.80);                                        // faded terracotta tile
		col *= 0.86 + 0.22 * sign(sx) * lit;                                  // two slopes, gentle
		col *= 0.82 + 0.18 * smoothstep(0.0, 1.8, abs(fract(hs.lc.y / 12.0) - 0.5) * 12.0); // tile rows
		col *= 1.0 - (1.0 - smoothstep(0.5, 2.5, abs(hs.lc.x))) * 0.45;       // dark ridge line
		if (fract(hs.seed * 29.3) < 0.6 && abs(sy - 0.55) < 0.10 && abs(sx) > 0.25 && abs(sx) < 0.55) {
			col = vec3(0.05); // chimney stack
		}
		if (fract(hs.seed * 17.9) < 0.5 && abs(sy + 0.35) < 0.12 && sx > 0.15 && sx < 0.65) {
			col += PAL_LAMP * 1.3; // lit attic skylight
		}
	} else if (hs.dis < 1.5 && !solid) { // industrial: clean deck plate, pipes across the band, a tank
		col *= 0.96 + 0.04 * hash21(floor(g / 7.0));
		float py = abs(fract(sx * 3.0) - 0.5) * 2.0;
		col = mix(col, base * 0.55, smoothstep(0.55, 0.30, py));
		col = mix(col, base * 1.55, smoothstep(0.22, 0.05, py));
		if (fract(hs.seed * 23.9) > 0.5) { // storage tank (per segment, capped small)
			vec2 tp = lg - vec2(0.0, 20.0);
			float td = length(tp) - min(hs.ext.x * 0.5, 26.0);
			col = mix(col, base * 1.7 * (0.6 + 0.5 * smoothstep(14.0, -14.0, tp.x + tp.y)), 1.0 - smoothstep(-2.0, 1.0, td));
			col = mix(col, vec3(0.03), (1.0 - smoothstep(0.0, 2.5, abs(td))) * 0.8);
		}
		if (fract(hs.seed * 43.1) < 0.4 && abs(sy) < 0.5) {
			col += PAL_LAMP * 0.9 * (1.0 - smoothstep(0.0, 3.0, abs(hs.lc.x - hs.ext.x * 0.55))); // work-light slit
		}
	} else { // tower block: clean flat top, a steady roof lamp
		if (hs.h > 0.40 && fract(hs.seed * 37.7) < 0.6) {
			col += PAL_LAMP * 1.0 * exp(-dot(lg, lg) / 30.0); // steady roof lamp
		}
	}
	// long pipe runs striding the giant decks section to section (skirting the crown)
	if (solid && fract(hseed * 9.3) > 0.45 && length(hs.lc) > 205.0) {
		float pipe = abs(fract(rr / 96.0) * 96.0 - 22.0);
		col = mix(col, base * 0.5, smoothstep(2.8, 1.4, pipe));
		col = mix(col, base * 1.55, smoothstep(1.1, 0.2, pipe)); // lit crown of the pipe
	}
	// ── the DECK language — no scattered furniture: flat roofs are corrugated metal
	// sheeting laid WITH the street, broken by long mullioned skylight lanes, stitched
	// rows of round vent throats, and a rare service light. Everything is continuous
	// and architectural, one roll per 110×96 plate — nothing sits at a random angle.
	if (!(hs.dis < 0.5 && !solid && hs.ext.x < 48.0)) { // pitched roofs keep their tiles
		if (hs.sd < -12.0) {
			col *= 1.0 + 0.040 * sin(rr * TAU / 9.0); // corrugation ribs, street-parallel
			float rs = hash21(vec2(floor(arc / 110.0), floor(rr / 96.0)) + fract(hs.seed * 13.0));
			float rowy = fract(rr / 96.0) * 96.0;     // radial position within this plate row
			if (rs < 0.30) { // a SKYLIGHT LANE runs down the plate: dark glass, mullioned panes
				float ld = abs(rowy - 34.0) - 4.5;
				float pane = step(0.18, fract(arc / 26.0));
				col = mix(col, vec3(0.031, 0.029, 0.027) + vec3(0.05) * pane, 1.0 - smoothstep(-1.0, 1.0, ld));
				col = mix(col, vec3(0.02), (1.0 - smoothstep(0.0, 1.4, abs(ld))) * 0.7);
				if (fract(rs * 23.0) > 0.5) { col += PAL_LAMP * 0.22 * pane * (1.0 - smoothstep(-2.0, 0.5, ld)); } // lit from inside
			} else if (rs < 0.48) { // a VENT ROW stitched along the plate: round throats
				vec2 vp = vec2((fract(arc / 24.0) - 0.5) * 24.0, rowy - 62.0);
				float vd = length(vp) - 3.0;
				col = mix(col, base * 0.5, 1.0 - smoothstep(-1.0, 1.0, vd));
				col = mix(col, base * 1.45, (1.0 - smoothstep(0.0, 1.2, abs(vd))) * 0.8);
			} else if (rs < 0.56) { // a service light at the plate heart
				vec2 lp2 = vec2((fract(arc / 110.0) - 0.5) * 110.0, rowy - 48.0);
				col += PAL_LAMP * 0.8 * exp(-dot(lp2, lp2) / 7.0);
			}
		}
	}
	// eaves: ink outline + a pale parapet lip — the rim sells the height as it parallaxes
	col *= smoothstep(-0.5, 4.0, -edge) * 0.55 + 0.45;
	col += vec3(0.085, 0.082, 0.080) * (1.0 - smoothstep(3.0, 10.0, -edge)) * smoothstep(-1.5, -3.0, edge);
	// a rooftop service lamp on some houses — the skyline sparkles at night
	if (fract(hs.seed * 61.3) < 0.40) {
		vec2 lp = vec2(hs.lc.x, (fract(hs.lc.y / 110.0) - 0.5) * 110.0) - vec2(hs.ext.x * 0.6, -30.0);
		col += PAL_LAMP * 0.9 * exp(-dot(lp, lp) / 18.0);
	}
	return col;
}

// Facades: straight walls with clear normals, floor bands and WINDOWS — the city's light.
vec3 wall_col(vec2 g, House hs, float t) {
	// which face: the axis with the least slack to its edge
	float eu = hs.ext.x - abs(hs.lc.x);
	float ev = hs.ext.y - abs(hs.lc.y);
	vec2 v = vec2(-hs.u.y, hs.u.x);
	vec2 n = eu < ev ? hs.u * sign(hs.lc.x) : v * sign(hs.lc.y);
	float along = eu < ev ? hs.lc.y : hs.lc.x;
	float lit = 0.55 + 0.45 * clamp(dot(n, normalize(SUN)), -1.0, 1.0);
	// masonry per house: dusty brick or warm taupe render — faint desaturated hues, never blue
	vec3 mas = mix(vec3(0.069, 0.055, 0.044), vec3(0.058, 0.052, 0.044), step(0.55, fract(hs.seed * 11.3)));
	vec3 col = mas * lit * (0.6 + 0.5 * t);
	col *= 0.90 + 0.10 * hash21(floor(g / 7.0)); // grime
	float fl = fract(t / 0.12); // floor bands
	col *= 0.80 + 0.25 * smoothstep(0.06, 0.22, fl) * smoothstep(0.95, 0.80, fl);
	// windows — most lit warm, a few cold, many dark
	float wc = fract(along / 26.0);
	float win = step(0.22, wc) * step(wc, 0.75) * step(0.25, fl) * step(fl, 0.72) * step(t, hs.h - 0.035);
	float wh = hash21(vec2(floor(along / 26.0), floor(t / 0.12)) + hs.seed * 31.0);
	vec3 glow = wh < 0.40 ? PAL_LAMP * (0.7 + 1.1 * fract(wh * 17.0)) :
	            (wh < 0.48 ? vec3(0.30, 0.31, 0.33) : vec3(0.018, 0.018, 0.020));
	col = mix(col, glow, win * 0.9);
	col *= mix(0.45, 1.10, smoothstep(0.0, max(hs.h, 0.25), t));    // dark base → lit crown
	col += PAL_LAMP * 0.10 * (1.0 - smoothstep(0.0, 0.20, t));      // street-lamp uplight
	col += vec3(0.070, 0.068, 0.066) * smoothstep(hs.h - 0.05, hs.h, t); // pale lip at the roofline
	return col;
}

void main() {
	vec2 g0 = vec2(CACHE_ORIGIN) + gl_FragCoord.xy * ZOOM; // world pos of this texel's center

	// oblique fake-3D march: a point at height t appears shifted up-screen by LEAN·t —
	// march down from HMAX, bisect the first hit (identical to the old city.frag main).
	float tHit = -1.0;
	if (min(distance(g0, vec2(WORLD * 0.5)), distance(g0 + vec2(0.0, LEAN * HMAX), vec2(WORLD * 0.5))) < pc.city_r) {
		const int N = 12;
		const float STEP = HMAX / float(N - 1);
		for (int i = 0; i < N; i++) {
			float t = HMAX - float(i) * STEP;
			float sh = scene_h(g0 + vec2(0.0, LEAN) * t);
			if (sh > 0.0 && sh >= t) {
				float aT = t, bT = min(t + STEP, HMAX);
				for (int k = 0; k < 4; k++) {
					float m = (aT + bT) * 0.5;
					float mh = scene_h(g0 + vec2(0.0, LEAN) * m);
					if (mh > 0.0 && mh >= m) { aT = m; } else { bT = m; }
				}
				tHit = aT;
				break;
			}
		}
	}

	if (tHit < 0.0) { o_color = vec4(0.0); return; } // no building column → miss (live ground at runtime)
	vec2 gh = g0 + vec2(0.0, LEAN) * tHit;
	House hs = house_at(gh);
	if (hs.ok && hs.sd <= 0.0) { // a HOUSE
		vec3 col = tHit > house_h(hs) - 0.04 ? roof_col(gh, hs) : wall_col(gh, hs, tHit);
		o_color = vec4(col, 1.0);
	} else { // the block PLINTH — its rim IS the collision face
		float pen = bldg_pen(gh);
		vec3 col;
		if (tHit > 0.04) { // slab top: packed yard grit between the houses
			col = vec3(0.045, 0.041, 0.032) * (0.75 + 0.25 * hash21(floor(gh / 33.0)));
			col *= 0.90 + 0.10 * hash21(floor(gh / 7.0));
			col = mix(col, vec3(0.02), step(0.97, hash21(floor(gh / 13.0))) * 0.6); // junk
			col *= 0.70 + 0.30 * smoothstep(0.0, 30.0, pen); // dark edging at the rim
		} else { // slab wall face — the wall you bump into
			col = vec3(0.061, 0.056, 0.045) * (0.65 + 0.35 * smoothstep(0.0, 0.07, tHit));
			col += PAL_LAMP * 0.05;
		}
		o_color = vec4(col, 0.5);
	}
}
