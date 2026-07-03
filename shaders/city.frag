#version 460
#include "common.glsl"

// The city, drawn per-pixel — GTA2-style fake 3D: a point at height t over ground pos g
// appears where the ray g(t) = cam + s/(1 + PERSP*t) lands, so we march t from the sky
// down through scene_h() and bisect the first hit.
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

// district of a block: 0 residential rows, 1 industrial yards, 2 tower blocks
float district(vec3 blk) { return floor(hash21(vec2(blk.x, floor(blk.y / 3.0)) * 2.7 + 13.0) * 2.999); }

// distance to the nearest spoke centerline only (houses must clear the avenues)
float spoke_dist(vec2 p) {
	vec2 q = p - vec2(WORLD * 0.5);
	float r = length(q);
	float sa = atan(q.y, q.x) - SPIRAL * r;
	float stp = TAU / (SPOKES * 0.5);
	float da = sa - round(sa / stp) * stp;
	float d = abs(da) * r;
	if (r > SPOKE2_R) {
		float sa2 = sa + stp * 0.5;
		float da2 = sa2 - round(sa2 / stp) * stp;
		d = min(d, abs(da2) * r);
	}
	return d;
}

// One discrete rect house under p, or h == 0. lc = house-local px (x = radial,
// y = along the row), ext = rect half-sizes, u = the house's radial axis in world.
struct House { float h; vec2 lc; vec2 ext; float seed; float dis; vec2 u; };

House house_at(vec2 p) {
	House hs;
	hs.h = 0.0;
	vec3 blk = city_block(p);
	if (blk.z < 0.5) { return hs; }
	vec2 q = p - vec2(WORLD * 0.5);
	float r = length(q);
	float rB0 = blk.x * RING_SP + BLDG_EDGE;
	float rB1 = (blk.x + 1.0) * RING_SP - BLDG_EDGE;
	float rowDepth = (rB1 - rB0) * 0.40; // two rows hug the streets, courtyard between
	bool outer = r > (rB0 + rB1) * 0.5;
	float rRow = outer ? rB1 - rowDepth * 0.5 : rB0 + rowDepth * 0.5;
	float sa = atan(q.y, q.x) - SPIRAL * r;
	const float S = 190.0; // house pitch along the row
	float ci = floor(sa * rRow / S);
	float seed = hash21(vec2(ci, blk.x * 13.0 + blk.y * 3.0 + (outer ? 7.0 : 0.0)));
	if (seed < 0.16) { return hs; } // missing house → gap in the terrace
	// house center + straight local frame, tangent-aligned at ITS angle
	float aC = (ci + 0.5) * S / rRow + SPIRAL * rRow;
	vec2 cdir = vec2(cos(aC), sin(aC));
	vec2 c = vec2(WORLD * 0.5) + cdir * rRow;
	if (spoke_dist(c) < BLDG_EDGE + S * 0.5) { return hs; } // clear of the avenues
	vec2 d2 = p - c;
	hs.lc = vec2(dot(d2, cdir), dot(d2, vec2(-cdir.y, cdir.x)));
	hs.ext = vec2(rowDepth * 0.5 - 4.0 - 10.0 * fract(seed * 3.3),
	              S * 0.5 - (14.0 + 22.0 * fract(seed * 5.7)));
	if (sd_box(vec2(hs.lc.x, hs.lc.y), vec2(hs.ext.x, hs.ext.y)) > 0.0) { return hs; }
	hs.seed = seed;
	hs.dis = district(blk);
	hs.u = cdir;
	float hh = fract(seed * 9.1);
	float hb = hs.dis < 0.5 ? 0.22 + 0.16 * hh : (hs.dis < 1.5 ? 0.15 + 0.11 * hh : 0.32 + 0.30 * hh);
	hb *= clamp(1.25 - blk.x * 0.055, 0.6, 1.2); // downtown rises
	hs.h = clamp(hb, 0.12, 0.62);
	return hs;
}

float scene_h(vec2 p) { return house_at(p).h; }

// Rooftops, straight and readable, per district.
vec3 roof_col(vec2 g, House hs) {
	float sx = hs.lc.x / hs.ext.x; // -1..1 across the house (radial)
	float sy = hs.lc.y / hs.ext.y; // -1..1 along it
	// weathered paint per house — bright enough to stand off the near-black ground
	vec3 base = mix(vec3(0.135, 0.120, 0.112), vec3(0.185, 0.105, 0.070), step(0.6, fract(hs.seed * 7.7)));
	base = mix(base, vec3(0.095, 0.130, 0.128), step(0.75, fract(hs.seed * 13.1)));
	vec3 col = base * (0.70 + 0.60 * hs.h);
	col *= 0.93 + 0.07 * hash21(floor(g / 9.0)); // grit

	float edge = sd_box(hs.lc, hs.ext); // ≤ 0 inside
	if (hs.dis < 0.5) { // residential: pitched roof, ridge along the row
		float lit = dot(hs.u, normalize(SUN));
		col *= 0.80 + 0.38 * sign(sx) * lit;                                  // two slopes
		col *= 0.82 + 0.18 * smoothstep(0.0, 1.8, abs(fract(hs.lc.y / 12.0) - 0.5) * 12.0); // tile rows
		col *= 1.0 - (1.0 - smoothstep(0.5, 2.5, abs(hs.lc.x))) * 0.45;       // dark ridge line
		if (fract(hs.seed * 29.3) < 0.6 && abs(sy - 0.55) < 0.10 && abs(sx) > 0.25 && abs(sx) < 0.55) {
			col = vec3(0.05); // chimney stack
			col += PAL_EMBER * 0.5 * step(fract(hs.seed * 51.7), 0.3);
		}
		if (fract(hs.seed * 17.9) < 0.5 && abs(sy + 0.35) < 0.12 && sx > 0.15 && sx < 0.65) {
			col += PAL_WINDOW * 2.2; // lit attic skylight
		}
	} else if (hs.dis < 1.5) { // industrial: flat gravel, pipes along the shed, a tank
		col *= 0.9 + 0.1 * hash21(floor(hs.lc / 7.0));
		float py = abs(fract(sx * 3.0) - 0.5) * 2.0;
		col = mix(col, base * 0.55, smoothstep(0.55, 0.30, py));
		col = mix(col, base * 1.55, smoothstep(0.22, 0.05, py));
		if (fract(hs.seed * 23.9) > 0.5) { // storage tank
			vec2 tp = hs.lc - vec2(0.0, hs.ext.y * 0.4);
			float td = length(tp) - min(hs.ext.x, hs.ext.y) * 0.5;
			col = mix(col, base * 1.7 * (0.6 + 0.5 * smoothstep(14.0, -14.0, tp.x + tp.y)), 1.0 - smoothstep(-2.0, 1.0, td));
			col = mix(col, vec3(0.03), (1.0 - smoothstep(0.0, 2.5, abs(td))) * 0.8);
		}
		if (fract(hs.seed * 43.1) < 0.4 && abs(sy) < 0.5) {
			col += PAL_WINDOW * 1.5 * (1.0 - smoothstep(0.0, 3.0, abs(hs.lc.x - hs.ext.x * 0.55))); // sodium slit
		}
	} else { // tower block: panel grid, vents, aircraft beacon
		vec2 pg = fract(hs.lc / 38.0) * 38.0;
		float seam = min(min(pg.x, 38.0 - pg.x), min(pg.y, 38.0 - pg.y));
		col *= 0.82 + 0.18 * smoothstep(0.0, 2.2, seam);
		float vv = hash21(floor(hs.lc / 38.0) + hs.seed * 40.0);
		if (vv > 0.80) { col *= 0.55 + 0.30 * sin(pg.y * 1.4); } // vent grille
		if (hs.h > 0.40 && fract(hs.seed * 37.7) < 0.6) {
			float blink = smoothstep(0.6, 0.95, sin(pc.time * 2.3 + hs.seed * 60.0) * 0.5 + 0.5);
			col += PAL_ACCENT * 3.0 * exp(-dot(hs.lc, hs.lc) / 30.0) * blink;
		}
	}
	// eaves: ink outline + a lit parapet lip — the rim sells the height as it parallaxes
	col *= smoothstep(-0.5, 4.0, -edge) * 0.55 + 0.45;
	col += vec3(0.14, 0.115, 0.08) * (1.0 - smoothstep(3.0, 10.0, -edge)) * smoothstep(-1.5, -3.0, edge);
	// a rooftop service lamp on some houses — the skyline sparkles at night
	if (fract(hs.seed * 61.3) < 0.40) {
		vec2 lp = hs.lc - vec2(hs.ext.x * 0.6, -hs.ext.y * 0.6);
		col += PAL_WINDOW * 2.0 * exp(-dot(lp, lp) / 18.0);
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
	vec3 col = vec3(0.062, 0.054, 0.050) * lit * (0.6 + 0.5 * t);
	col *= 0.90 + 0.10 * hash21(floor(g / 7.0)); // grime
	float fl = fract(t / 0.12); // floor bands
	col *= 0.80 + 0.25 * smoothstep(0.06, 0.22, fl) * smoothstep(0.95, 0.80, fl);
	// windows — most lit warm, a few cold, many dark
	float wc = fract(along / 26.0);
	float win = step(0.22, wc) * step(wc, 0.75) * step(0.25, fl) * step(fl, 0.72) * step(t, hs.h - 0.035);
	float wh = hash21(vec2(floor(along / 26.0), floor(t / 0.12)) + hs.seed * 31.0);
	vec3 glow = wh < 0.40 ? PAL_WINDOW * (0.8 + 1.6 * fract(wh * 17.0)) :
	            (wh < 0.48 ? vec3(0.5, 0.7, 0.9) * 0.8 : vec3(0.015, 0.02, 0.03));
	col = mix(col, glow, win * 0.9);
	col *= mix(0.45, 1.10, smoothstep(0.0, max(hs.h, 0.25), t));    // dark base → lit crown
	col += PAL_EMBER * 0.22 * (1.0 - smoothstep(0.0, 0.20, t));     // street-lamp uplight
	col += vec3(0.10, 0.085, 0.06) * smoothstep(hs.h - 0.05, hs.h, t); // lit lip at the roofline
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

	if (cr < PIT_R) { // ── the pit: parallaxed floor below grade, a furnace at the heart
		vec2 gf = pc.cam + s / (1.0 - 0.55 * PERSP);
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

	// ── wasteland: layered sediment, ripples, craters, scrap — all under drifting dust
	vec3 dirt = vec3(0.066, 0.054, 0.040) * (0.66 + 0.34 * hash21(floor(w / 148.0)));
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
			if (fract(chh * 5.0) > 0.7) { dirt += PAL_EMBER * 0.35 * exp(-max(cd + 60.0, 0.0) * 0.03) * (0.5 + dustM); } // fresh one, still hot
		}
	}
	dirt = mix(dirt, vec3(0.155, 0.125, 0.088), dustM * 0.30); // the dust sheets themselves
	{ // scattered marker lamps blinking in the dust
		vec2 lc = floor(w / 340.0);
		float lh = hash21(lc * 5.1 + 2.2);
		if (lh > 0.90) {
			vec2 lpos = (lc + 0.5 + (vec2(hash21(lc + 3.0), hash21(lc + 7.0)) - 0.5) * 0.7) * 340.0;
			float ld2 = dot(w - lpos, w - lpos);
			float blink = 0.6 + 0.4 * sin(pc.time * 2.0 + lh * 50.0);
			dirt += PAL_ACCENT * 1.8 * exp(-ld2 / 16.0) * blink;
			dirt += PAL_ACCENT * 0.25 * exp(-ld2 / 2600.0) * blink * (0.5 + dustM); // pool lit through dust
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
			dirt = mix(dirt, vec3(0.12, 0.02, 0.02), 1.0 - smoothstep(-1.0, 2.0, cd));
			dirt += PAL_ACCENT * (0.9 + 0.3 * sin(pc.time * 1.3 + ch * 40.0)) * exp(-max(cd, 0.0) * 0.05) * 0.35 * (0.5 + dustM);
			dirt += PAL_ACCENT * 1.6 * (1.0 - smoothstep(-4.0, 1.0, cd));
		}
	}

	// ── city ground: worn concrete field with expansion joints, patches, manholes
	vec3 pave = vec3(0.046, 0.044, 0.045) * (0.84 + 0.28 * hash21(floor(w / 124.0)));
	vec2 jl = fract(w / 124.0) * 124.0;
	float joint = min(min(jl.x, 124.0 - jl.x), min(jl.y, 124.0 - jl.y));
	pave *= 0.72 + 0.28 * smoothstep(0.0, 2.8, joint);
	pave *= 0.90 + 0.10 * hash21(floor(w / 8.0));
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
		// ── courtyard between the terrace rows: packed soil, junk, window light spill
		col = vec3(0.030, 0.025, 0.020) * (0.75 + 0.25 * hash21(floor(w / 33.0)));
		col *= 0.90 + 0.10 * hash21(floor(w / 7.0));
		col = mix(col, vec3(0.02), step(0.97, hash21(floor(w / 13.0))) * 0.6); // junk piles
		float spill = hash21(floor(w / 90.0) + 3.3);
		if (spill > 0.72) { col += PAL_WINDOW * 0.16 * (0.5 + dustM); } // lit rooms spilling out
	} else if (blk.z < 0.5 && blk.x >= 1.0 && cr < pc.city_r - 60.0 && sd > BLDG_EDGE) {
		// ── plaza: radial pavement, a monument dais glowing at its heart, corner lamps
		float ns = blk.x * RING_SP >= SPOKE2_R ? SPOKES : SPOKES * 0.5;
		float rc = (blk.x + 0.5) * RING_SP;
		float ac = (blk.y + 0.5) * TAU / ns + SPIRAL * rc;
		vec2 heart = ctr + vec2(cos(ac), sin(ac)) * rc;
		vec2 hq = w - heart;
		float hd = length(hq);
		col = vec3(0.052, 0.048, 0.046) * (0.82 + 0.18 * hash21(floor(vec2(hd, atan(hq.y, hq.x) * hd) / 24.0)));
		col *= 0.90 + 0.10 * smoothstep(0.0, 2.0, abs(fract(hd / 46.0) - 0.5) * 46.0); // ring courses
		float dd = hd - 42.0; // monument dais
		col = mix(col, vec3(0.075, 0.068, 0.062), 1.0 - smoothstep(-1.5, 1.0, dd));
		col = mix(col, vec3(0.02), (1.0 - smoothstep(0.0, 2.0, abs(dd))) * 0.8);
		col += PAL_EMBER * 1.6 * exp(-hd * hd / 220.0) * (0.8 + 0.2 * sin(pc.time * 1.4)); // the flame
		col += PAL_EMBER * 0.30 * exp(-hd * hd / 22000.0) * (0.5 + dustM);
		for (float i = 0.0; i < 4.0; i += 1.0) { // corner lamps
			vec2 lp = heart + rot2(i * TAU / 4.0 + 0.785) * vec2(150.0, 0.0);
			float ld2 = dot(w - lp, w - lp);
			col += PAL_WINDOW * 2.2 * exp(-ld2 / 60.0);
			col += PAL_WINDOW * 0.25 * exp(-ld2 / 7000.0) * (0.5 + dustM);
		}
	}

	// ── streets: scarred asphalt + emissive lane strips + curbs + crossing lamps
	float roadMix = smoothstep(pc.city_r + 420.0, pc.city_r, cr);
	float rmask = smoothstep(STREET_HW, STREET_HW - 6.0, sd) * roadMix;
	vec3 road = vec3(0.030, 0.028, 0.030) * (0.85 + 0.15 * hash21(floor(w / 31.0)));
	road *= 0.90 + 0.10 * hash21(floor(w / 8.0));
	road = mix(road, road * 0.5, smoothstep(0.8, 0.98, hash21(floor(w / 39.0))) * 0.7); // scorch/oil
	col = mix(col, road, rmask);
	col += vec3(0.10, 0.09, 0.09) * (1.0 - smoothstep(1.0, 2.6, abs(sd - (STREET_HW - 4.0)))) * roadMix; // curb
	{ // lane light down the middle — dashes of hot red-orange
		float ringd = abs(cr - max(round(cr / RING_SP), 1.0) * RING_SP);
		float along = ringd < spoke_dist(w) ? a * cr : cr;
		float dash = step(fract(along / 120.0), 0.5);
		col += PAL_ACCENT * (1.0 - smoothstep(1.2, 3.0, sd)) * dash * roadMix * 0.9;
	}

	// contact shadow hugging every block — camera-independent, anchors the footprints
	col *= 1.0 - smoothstep(-90.0, -2.0, pen) * 0.5 * step(pen, 0.0);

	// ── the defense towers' light playing over the ground, through the dust
	for (uint ti = 0u; ti < MAX_TURRETS; ti++) {
		Body tw = BODIES[TURRET_LO + ti];
		if (tw.kind != KIND_TURRET) { continue; }
		vec2 dvec = w - tw.pos;
		float d2 = dot(dvec, dvec);
		if (d2 > TWR_LEN * TWR_LEN) { continue; }
		float phase = fract(pc.time * 0.14 + hash1((TURRET_LO + ti) * 77u));
		if (phase < 0.30) {
			float env = smoothstep(0.0, 0.03, phase) * smoothstep(0.30, 0.26, phase);
			float ang = hash1((TURRET_LO + ti) * 913u) * TAU + pc.time * 0.22;
			vec2 ad = vec2(cos(ang), sin(ang));
			float bd = sd_seg(w, tw.pos - ad * TWR_LEN, tw.pos + ad * TWR_LEN);
			col += PAL_EMBER * exp(-bd * bd / 9000.0) * 0.35 * env * (0.5 + dustM);
		}
		col += PAL_ACCENT * exp(-d2 / 26000.0) * 0.08 * (0.5 + dustM); // idle warning pool
	}

	// world edge: a thin hazard line, then haze out into the void
	float ed = min(min(w.x, w.y), min(WORLD - w.x, WORLD - w.y));
	col = mix(col, vec3(0.4, 0.05, 0.03), (1.0 - smoothstep(3.0, 8.0, abs(ed))) * 0.8);
	col *= 1.0 - smoothstep(0.0, -500.0, ed) * 0.35;
	return col;
}

void main() {
	vec2 s = (gl_FragCoord.xy - pc.screen * 0.5) * ZOOM; // ground offset from cam, world px
	vec2 g0 = pc.cam + s;

	// ── fake-3D march: top down through the skyline, bisect the first hit
	float tHit = -1.0;
	{
		const int N = 8;
		const float STEP = 1.0 / float(N - 1);
		for (int i = 0; i < N; i++) {
			float t = 1.0 - float(i) * STEP;
			float sh = scene_h(pc.cam + s / (1.0 + PERSP * t));
			if (sh > 0.0 && sh >= t) {
				float aT = t, bT = min(t + STEP, 1.0);
				for (int k = 0; k < 4; k++) {
					float m = (aT + bT) * 0.5;
					float mh = scene_h(pc.cam + s / (1.0 + PERSP * m));
					if (mh > 0.0 && mh >= m) { aT = m; } else { bT = m; }
				}
				tHit = aT;
				break;
			}
		}
	}

	vec3 col;
	if (tHit >= 0.0) {
		vec2 gh = pc.cam + s / (1.0 + PERSP * tHit);
		House hs = house_at(gh);
		col = tHit > hs.h - 0.04 ? roof_col(gh, hs) : wall_col(gh, hs, tHit);
	} else {
		col = ground_col(g0, s);
	}

	// the ship's light on the ground: hover underglow, muzzle strobe, the laser's burn line
	{
		vec2 rel = g0 - pc.player;
		float r2 = dot(rel, rel);
		float onGround = tHit >= 0.0 ? 0.15 : 1.0;
		col += PAL_EMBER * exp(-r2 / 5200.0) * (0.30 + 0.06 * sin(pc.time * 9.0)) * onGround;
		col += PAL_ACCENT * pc.muzzle * exp(-r2 / 12000.0) * 0.5 * onGround;
		if (pc.laser > 0.05) {
			vec2 off = pc.aim - pc.player;
			float ol = max(length(off), 0.001);
			vec2 ad = off / ol;
			float bd = sd_seg(g0, pc.player + ad * 40.0, pc.player + ad * (40.0 + LASER_LEN));
			col += PAL_EMBER * exp(-bd * bd / 14000.0) * 0.5 * pc.laser * onGround;
		}
	}

	o_color = vec4(col, 1.0);
}
