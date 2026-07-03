#version 460
#include "common.glsl"

// The city, drawn per-pixel — OBLIQUE fake 3D: a point at height t over ground pos g
// appears shifted straight up-screen by LEAN*t (pure translation — no shear, roofs sit
// directly behind their facades), so we march t from the sky down through scene_h()
// and bisect the first hit.
//
// The buildings are STRAIGHT RECTANGLES — every block holds two terrace rows of
// discrete, tangent-aligned rect houses hugging its ring streets with a courtyard
// between. Straight edges keep the perspective legible; the CURVES live in the rows
// (each house rotates a little against its neighbor, so terraces sweep along the
// arcs like a crescent street). Collision stays the whole-block street constraint
// (bldg_pen in common.glsl) — courtyards are visual depth, not walkable space.
//
// The look is night: near-black grit, and LIGHT — lit windows, lane strips, plaza
// lamps, tower beams, wasteland crystals, the pit furnace — carried on heavy bloom,
// with dust sheets drifting through every big glow.

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

// Ground: pit + apron, streets, plazas, courtyards, and the dusty wasteland —
// every big glow is modulated by the drifting dust, so the light SHINES THROUGH it.
vec3 ground_col(vec2 w, vec2 s) {
	vec2 ctr = vec2(WORLD * 0.5);
	vec2 q = w - ctr;
	float cr = length(q);
	float a = atan(q.y, q.x);
	float lastDep = uintBitsToFloat(STATS[1]);
	float pulse = exp(-max(pc.time - lastDep, 0.0) * 2.2); // flares when a corpse drops in
	// the dust field: two wind sheets sliding against each other
	float dustM = (0.5 + 0.5 * sin((w.x * 0.55 + w.y * 0.45) * 0.004 + pc.time * 0.55))
	            * (0.5 + 0.5 * sin((w.x * 0.25 - w.y * 0.65) * 0.009 - pc.time * 0.85));

	if (cr < PIT_R) { // ── the pit: floor below grade (leans the other way), a furnace at the heart
		vec2 gf = w - vec2(0.0, LEAN) * 0.55;
		float fr = distance(gf, ctr);
		if (fr < PIT_R * 0.72) {
			vec3 col = vec3(0.028, 0.022, 0.020) * (0.5 + 0.5 * hash21(floor(gf / 23.0)));
			col *= 0.80 + 0.20 * sin(fr * 0.35); // rib rings of sunk plating
			float core = exp(-fr * fr / (PIT_R * PIT_R * 0.035));
			col += PAL_ACCENT * core * (0.8 + 3.5 * pulse) * (0.8 + 0.2 * sin(pc.time * 2.6));
			col += PAL_EMBER * 0.12 * exp(-fr / (PIT_R * 0.35));
			return col;
		}
		float ww = smoothstep(PIT_R, PIT_R * 0.4, cr); // shaft wall, darker with depth
		vec3 col = vec3(0.09, 0.08, 0.07) * (1.0 - 0.8 * ww);
		col *= 0.85 + 0.15 * sin(cr * 0.9);
		col += PAL_EMBER * 0.35 * (1.0 - ww) * pulse;
		return col;
	}

	vec3 col;
	if (cr < PIT_R + 130.0) { // ── machined apron: dark plating, breathing vents, beacons
		float slat = fract(a * 18.0 / TAU);
		col = vec3(0.048, 0.044, 0.042) * (0.84 + 0.16 * smoothstep(0.0, 0.12, abs(slat - 0.5)));
		col *= 0.92 + 0.08 * sin(cr * 0.5);
		col *= 0.90 + 0.10 * hash21(floor(w / 13.0));
		if (fract(slat * 3.0) < 0.16) {
			col += PAL_EMBER * (0.06 + 0.04 * sin(pc.time * 1.8 + a * 3.0)) * smoothstep(130.0, 20.0, cr - PIT_R) * (1.0 + 4.0 * pulse);
		}
		float bk = fract(a * 4.0 / TAU + 0.125);
		float blink = smoothstep(0.6, 0.95, sin(pc.time * 3.1) * 0.5 + 0.5);
		col += PAL_ACCENT * 2.0 * exp(-pow((bk - 0.5) * 500.0, 2.0)) * exp(-pow(cr - PIT_R - 20.0, 2.0) / 200.0) * blink;
		col += PAL_EMBER * 0.10 * (0.5 + dustM) * exp(-(cr - PIT_R) / 90.0); // furnace light in the dust
		return col;
	}

	float sd = street_d(w);
	float cityMix = smoothstep(pc.city_r + 240.0, pc.city_r - 60.0, cr);
	vec3 blk = city_block(w);
	float pen = bldg_pen(w);

	// ── wasteland: layered sediment, ripples, craters, scrap — all under drifting dust.
	// Broad hue drift between dry umber and cold sage-grey earth — desaturated COLOR
	// texture, value stays flat so nothing competes with the accents.
	vec3 dirt = mix(vec3(0.069, 0.058, 0.042), vec3(0.051, 0.058, 0.049), vnoise(w * 0.0016))
	          * (0.66 + 0.34 * hash21(floor(w / 148.0)));
	dirt *= 0.90 + 0.10 * sin((w.x * 0.35 + w.y * 0.85) * 0.0021 + 2.0 * sin(w.y * 0.0009)); // sediment bands
	dirt *= 0.94 + 0.06 * sin(dot(w, vec2(0.72, 0.69)) * 0.055 + sin(w.x * 0.013));          // wind ripples
	dirt *= 0.92 + 0.08 * hash21(floor(w / 9.0));                                            // grain
	dirt = mix(dirt, vec3(0.02), step(0.982, hash21(floor(w / 15.0))) * 0.7);                // scrap
	{ // craters
		vec2 cc = floor(w / 760.0);
		float chh = hash21(cc * 7.3 + 0.7);
		if (chh > 0.62) {
			vec2 cp = (cc + 0.5 + (vec2(hash21(cc + 4.0), hash21(cc + 11.0)) - 0.5) * 0.5) * 760.0;
			float cd = length(w - cp) - (90.0 + 140.0 * fract(chh * 9.0));
			dirt *= 1.0 - (1.0 - smoothstep(-60.0, 6.0, cd)) * 0.35;          // bowl shadow
			dirt *= 1.0 + (1.0 - smoothstep(0.0, 14.0, abs(cd))) * 0.55;      // bright rim
			if (fract(chh * 5.0) > 0.7) { dirt += vec3(0.085, 0.082, 0.078) * exp(-max(cd + 60.0, 0.0) * 0.03) * (0.5 + dustM); } // fresh one, still dusted
		}
	}
	dirt = mix(dirt, vec3(0.143, 0.127, 0.101), dustM * 0.30); // the dust sheets — warm tan
	{ // scattered marker lamps blinking in the dust
		vec2 lc = floor(w / 340.0);
		float lh = hash21(lc * 5.1 + 2.2);
		if (lh > 0.90) {
			vec2 lpos = (lc + 0.5 + (vec2(hash21(lc + 3.0), hash21(lc + 7.0)) - 0.5) * 0.7) * 340.0;
			float ld2 = dot(w - lpos, w - lpos);
			dirt += PAL_LAMP * 1.1 * exp(-ld2 / 16.0);
			dirt += PAL_LAMP * 0.12 * exp(-ld2 / 2600.0) * (0.5 + dustM); // pool lit through dust
		}
	}
	{ // crystal fields — red light growing out of the dirt
		vec2 cell = floor(w / 540.0);
		float ch = hash21(cell * 3.7 + 1.3);
		if (ch > 0.55) {
			vec2 cp = (cell + 0.5 + (vec2(hash21(cell + 9.0), hash21(cell + 17.0)) - 0.5) * 0.6) * 540.0;
			float cd = 1e9;
			for (float i = 0.0; i < 4.0; i += 1.0) {
				vec2 spike = cp + rot2(hash21(cell + i) * TAU) * vec2(20.0 + 30.0 * hash21(cell + i + 30.0), 0.0);
				cd = min(cd, sd_seg(w, cp, spike) - 6.0);
			}
			const vec3 CRYS = vec3(0.42, 0.50, 0.58); // pale glacier — cool, desaturated, never the accent
			dirt = mix(dirt, vec3(0.098, 0.103, 0.110), 1.0 - smoothstep(-1.0, 2.0, cd));
			dirt += CRYS * 0.28 * exp(-max(cd, 0.0) * 0.05) * (0.5 + dustM);
			dirt += CRYS * 0.9 * (1.0 - smoothstep(-4.0, 1.0, cd));
		}
	}

	// ── city ground: worn concrete field with expansion joints, patches, manholes
	vec3 pave = vec3(0.047, 0.044, 0.040) * (0.84 + 0.28 * hash21(floor(w / 124.0)));
	vec2 jl = fract(w / 124.0) * 124.0;
	float joint = min(min(jl.x, 124.0 - jl.x), min(jl.y, 124.0 - jl.y));
	pave *= 0.72 + 0.28 * smoothstep(0.0, 2.8, joint);
	pave *= 0.90 + 0.10 * hash21(floor(w / 8.0));
	pave = mix(pave, pave * vec3(1.30, 0.94, 0.70), vnoise(w * 0.006 + 31.0) * 0.35);     // old rust bleed
	pave = mix(pave, pave * 0.45, smoothstep(0.72, 0.98, hash21(floor(w / 51.0))) * 0.8); // patched scars
	{ // manholes
		vec2 mc = floor(w / 300.0);
		if (hash21(mc * 4.9 + 8.8) > 0.9) {
			vec2 mp = (mc + 0.5) * 300.0;
			float md = length(w - mp) - 16.0;
			pave = mix(pave, vec3(0.030, 0.028, 0.026), 1.0 - smoothstep(-1.0, 1.0, md));
			pave = mix(pave, vec3(0.09, 0.08, 0.07), (1.0 - smoothstep(0.0, 2.0, abs(md))) * 0.8);
		}
	}
	col = mix(dirt, pave, cityMix);

	if (pen > 0.0) {
		// ── courtyard between the terrace rows: packed grit, junk, a faint light spill
		col = vec3(0.031, 0.028, 0.022) * (0.75 + 0.25 * hash21(floor(w / 33.0)));
		col *= 0.90 + 0.10 * hash21(floor(w / 7.0));
		col = mix(col, vec3(0.02), step(0.97, hash21(floor(w / 13.0))) * 0.6); // junk piles
		float spill = hash21(floor(w / 90.0) + 3.3);
		if (spill > 0.85) { col += PAL_LAMP * 0.04 * (0.5 + dustM); } // a faint lit-room spill
	} else if (blk.z > 0.5) {
		vec3 pz = block_plaza(blk.xy);
		float hd = pz.z > 0.0 ? distance(w, pz.xy) : 1e9;
		if (hd < pz.z) {
			// ── PLAZA: a round paved square carved into its block, ringed by houses —
			// concentric paver courses, a monument dais at the heart, a lamp ring
			float ang2 = atan(w.y - pz.y, w.x - pz.x);
			col = vec3(0.066, 0.060, 0.049) * (0.82 + 0.18 * hash21(floor(vec2(hd, ang2 * hd) / 24.0))); // warm sandstone pavers
			col *= 0.88 + 0.12 * smoothstep(0.0, 2.0, abs(fract(hd / 42.0) - 0.5) * 42.0); // courses
			float dd = hd - 40.0; // monument dais
			col = mix(col, vec3(0.083, 0.074, 0.061), 1.0 - smoothstep(-1.5, 1.0, dd));
			col = mix(col, vec3(0.02), (1.0 - smoothstep(0.0, 2.0, abs(dd))) * 0.8);
			col += PAL_LAMP * 1.2 * exp(-hd * hd / 240.0); // the monument lantern
			for (float i = 0.0; i < 5.0; i += 1.0) { // lamp ring
				vec2 lp2 = pz.xy + rot2(i * TAU / 5.0 + 0.6) * vec2(pz.z * 0.62, 0.0);
				float ld2 = dot(w - lp2, w - lp2);
				col += PAL_LAMP * 1.0 * exp(-ld2 / 60.0);
			}
		}
	}

	// ── streets: scarred asphalt + emissive lane strips + curbs + crossing lamps
	float roadMix = smoothstep(pc.city_r + 420.0, pc.city_r, cr);
	float rmask = smoothstep(STREET_HW, STREET_HW - 6.0, sd) * roadMix;
	vec3 road = vec3(0.027, 0.025, 0.024) * (0.85 + 0.15 * hash21(floor(w / 31.0))); // dark warm asphalt — never blue
	road *= 0.90 + 0.10 * hash21(floor(w / 8.0));
	road = mix(road, road * 0.5, smoothstep(0.8, 0.98, hash21(floor(w / 39.0))) * 0.7); // scorch/oil
	col = mix(col, road, rmask);
	col += vec3(0.105, 0.092, 0.079) * (1.0 - smoothstep(1.0, 2.6, abs(sd - (STREET_HW - 4.0)))) * roadMix; // warm stone curb
	{ // lane paint down the middle — pale worn dashes, not a light show
		float ringd = abs(cr - max(round(cr / RING_SP), 1.0) * RING_SP);
		float along = ringd < spoke_dist(w) ? a * cr : cr;
		float dash = step(fract(along / 120.0), 0.5);
		col += vec3(0.152, 0.138, 0.106) * (1.0 - smoothstep(1.2, 3.0, sd)) * dash * roadMix; // worn cream paint
	}

	{ // rubber on the road: the persistent skid decal grid the CPU stamps (Res.Skid)
		uint sx2 = uint(clamp(w.x / 4.0, 0.0, float(SKID_RES) - 1.0));
		uint sy2 = uint(clamp(w.y / 4.0, 0.0, float(SKID_RES) - 1.0));
		uint sidx = sy2 * SKID_RES + sx2;
		float rub = float((SKID[sidx >> 2u] >> ((sidx & 3u) * 8u)) & 0xFFu) / 255.0;
		col *= 1.0 - rub * 0.55;
	}

	// contact shadow hugging every block — camera-independent, anchors the footprints
	col *= 1.0 - smoothstep(-90.0, -2.0, pen) * 0.5 * step(pen, 0.0);

	// (the turrets' own sprites carry their fire + warning light — a per-pixel loop
	// over all 64 towers here cost more than the whole rest of the ground)

	// world edge: a thin hazard line, then haze out into the void
	float ed = min(min(w.x, w.y), min(WORLD - w.x, WORLD - w.y));
	col = mix(col, vec3(0.4, 0.05, 0.03), (1.0 - smoothstep(3.0, 8.0, abs(ed))) * 0.8);
	col *= 1.0 - smoothstep(0.0, -500.0, ed) * 0.35;
	return col;
}

void main() {
	vec2 s = (gl_FragCoord.xy - pc.screen * 0.5) * ZOOM; // ground offset from cam, world px
	vec2 g0 = pc.cam + s;

	// ── fake-3D march: OBLIQUE projection — a point at height t appears shifted
	// straight up-screen by LEAN·t, a pure translation: buildings never shear, the
	// roof sits directly behind the street facade. March down, bisect the first hit.
	float tHit = -1.0;
	// buildings only exist inside the city — wasteland columns skip the march outright
	if (min(distance(g0, vec2(WORLD * 0.5)), distance(g0 + vec2(0.0, LEAN * HMAX), vec2(WORLD * 0.5))) < pc.city_r) {
		const int N = 12; // marches the full HMAX ceiling — skyscrapers poke way above 1.0
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

	vec3 col;
	if (tHit >= 0.0) {
		vec2 gh = g0 + vec2(0.0, LEAN) * tHit;
		House hs = house_at(gh);
		if (hs.ok && hs.sd <= 0.0) {
			col = tHit > house_h(hs) - 0.04 ? roof_col(gh, hs) : wall_col(gh, hs, tHit);
		} else { // the block PLINTH — its rim IS the collision face
			float pen = bldg_pen(gh);
			if (tHit > 0.04) { // slab top: packed yard grit between the houses
				col = vec3(0.045, 0.041, 0.032) * (0.75 + 0.25 * hash21(floor(gh / 33.0)));
				col *= 0.90 + 0.10 * hash21(floor(gh / 7.0));
				col = mix(col, vec3(0.02), step(0.97, hash21(floor(gh / 13.0))) * 0.6); // junk
				col *= 0.70 + 0.30 * smoothstep(0.0, 30.0, pen); // dark edging at the rim
			} else { // slab wall face — the wall you bump into
				col = vec3(0.061, 0.056, 0.045) * (0.65 + 0.35 * smoothstep(0.0, 0.07, tHit));
				col += PAL_LAMP * 0.05;
			}
		}
	} else {
		col = ground_col(g0, s);
	}

	// the truck's light on the ground: underglow, muzzle strobe, the laser's burn line —
	// and the BIG HEADLIGHTS thrown far down the facing, glittering off the wet grit so
	// everything they touch SHINES
	{
		vec2 rel = g0 - pc.player;
		float r2 = dot(rel, rel);
		float onGround = tHit >= 0.0 ? 0.15 : 1.0;
		vec2 fdir = vec2(cos(pc.angle), sin(pc.angle));
		float along = dot(rel, fdir);
		if (along > 0.0) { // the high-beams land DOWN-RANGE — the light ramps up away
			// from the car, so there's no blinding pool right at the bumper
			float lat = abs(dot(rel, vec2(-fdir.y, fdir.x)));
			float spread = 24.0 + along * 0.40; // widening high-beam
			float beam = exp(-lat * lat / (spread * spread)) * smoothstep(760.0, 30.0, along)
			           * smoothstep(40.0, 260.0, along);
			col += vec3(1.0, 0.92, 0.75) * beam * 0.34 * onGround;
			col += vec3(1.0, 0.92, 0.75) * beam * 0.06; // spill catches facades too
		}
		col += PAL_EMBER * exp(-r2 / 5200.0) * (0.14 + 0.03 * sin(pc.time * 9.0)) * onGround;
		col += PAL_ACCENT * pc.muzzle * exp(-r2 / 12000.0) * 0.5 * onGround;
		if (pc.laser > 0.05) {
			vec2 off = pc.aim - pc.player;
			float ol = max(length(off), 0.001);
			vec2 ad = off / ol;
			float bd = sd_seg(g0, pc.player + ad * 40.0, pc.player + ad * (40.0 + LASER_LEN));
			col += PAL_EMBER * exp(-bd * bd / 14000.0) * 0.45 * pc.laser * onGround;
		}
	}

	o_color = vec4(col, 1.0);
}
