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
	float sx = hs.lc.x / hs.ext.x; // -1..1 across the house (radial)
	float sy = hs.lc.y / hs.ext.y; // -1..1 along it
	// weathered greys per house — neighbors contrast in VALUE, never in hue
	vec3 base = mix(vec3(0.112, 0.108, 0.103), vec3(0.150, 0.140, 0.128), step(0.6, fract(hs.seed * 7.7)));
	base = mix(base, vec3(0.085, 0.083, 0.082), step(0.75, fract(hs.seed * 13.1)));
	base = mix(base, vec3(0.195, 0.186, 0.174), step(0.85, fract(hs.seed * 23.9))); // pale concrete
	base = mix(base, vec3(0.052, 0.050, 0.052), step(0.92, fract(hs.seed * 41.3))); // near-black slate
	vec3 col = base * (0.70 + 0.60 * hs.h);
	col *= 0.93 + 0.07 * hash21(floor(g / 9.0)); // grit

	float edge = sd_box(hs.lc, hs.ext); // ≤ 0 inside
	if (hs.h > 0.55) { // ── a TALL one, whatever the district: stepped setback tiers
		vec2 pg = fract(hs.lc / 30.0) * 30.0;
		float seam = min(min(pg.x, 30.0 - pg.x), min(pg.y, 30.0 - pg.y));
		col *= 0.80 + 0.20 * smoothstep(0.0, 2.0, seam);
		float t1 = sd_box(hs.lc, hs.ext * 0.62); // matches the house_h setback geometry
		float t2 = sd_box(hs.lc, hs.ext * 0.34);
		col = mix(col, base * 1.35, 1.0 - smoothstep(-1.5, 1.0, t1));
		col = mix(col, base * 1.7, 1.0 - smoothstep(-1.5, 1.0, t2));
		col = mix(col, vec3(0.03), (1.0 - smoothstep(0.0, 2.2, abs(t1))) * 0.8);
		col = mix(col, vec3(0.03), (1.0 - smoothstep(0.0, 2.2, abs(t2))) * 0.8);
		float md = length(hs.lc); // antenna mast + steady service light
		col = mix(col, vec3(0.04), 1.0 - smoothstep(2.0, 4.0, md));
		col += PAL_LAMP * 1.3 * exp(-md * md / 16.0);
		col += vec3(0.35, 0.36, 0.4) * (1.0 - smoothstep(0.0, 1.6, abs(md - 8.0))) * 0.5; // guy ring
	} else if (fract(hs.seed * 7.3) < 0.22) { // ── domed hall
		float dd2 = length(hs.lc / hs.ext);
		float dome = 1.0 - smoothstep(0.55, 0.72, dd2);
		vec3 dc = base * (1.1 + 0.9 * smoothstep(0.4, -0.5, dot(hs.lc, normalize(SUN)) / max(hs.ext.x, 1.0)));
		col = mix(col, dc, dome);
		col = mix(col, vec3(0.03), (1.0 - smoothstep(0.0, 0.08, abs(dd2 - 0.64))) * 0.7);
		col += vec3(0.30, 0.32, 0.36) * exp(-dot(hs.lc + hs.ext * 0.25, hs.lc + hs.ext * 0.25) / (hs.ext.x * hs.ext.x * 0.08)) * dome; // moon glint
	} else if (hs.dis < 0.5) { // residential: pitched roof, ridge along the row
		float lit = dot(hs.u, normalize(SUN));
		col *= 0.80 + 0.38 * sign(sx) * lit;                                  // two slopes
		col *= 0.82 + 0.18 * smoothstep(0.0, 1.8, abs(fract(hs.lc.y / 12.0) - 0.5) * 12.0); // tile rows
		col *= 1.0 - (1.0 - smoothstep(0.5, 2.5, abs(hs.lc.x))) * 0.45;       // dark ridge line
		if (fract(hs.seed * 29.3) < 0.6 && abs(sy - 0.55) < 0.10 && abs(sx) > 0.25 && abs(sx) < 0.55) {
			col = vec3(0.05); // chimney stack
		}
		if (fract(hs.seed * 17.9) < 0.5 && abs(sy + 0.35) < 0.12 && sx > 0.15 && sx < 0.65) {
			col += PAL_LAMP * 1.3; // lit attic skylight
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
			col += PAL_LAMP * 0.9 * (1.0 - smoothstep(0.0, 3.0, abs(hs.lc.x - hs.ext.x * 0.55))); // work-light slit
		}
	} else { // tower block: panel grid, vents, aircraft beacon
		vec2 pg = fract(hs.lc / 38.0) * 38.0;
		float seam = min(min(pg.x, 38.0 - pg.x), min(pg.y, 38.0 - pg.y));
		col *= 0.82 + 0.18 * smoothstep(0.0, 2.2, seam);
		float vv = hash21(floor(hs.lc / 38.0) + hs.seed * 40.0);
		if (vv > 0.80) { col *= 0.55 + 0.30 * sin(pg.y * 1.4); } // vent grille
		if (hs.h > 0.40 && fract(hs.seed * 37.7) < 0.6) {
			col += PAL_LAMP * 1.0 * exp(-dot(hs.lc, hs.lc) / 30.0); // steady roof lamp
		}
	}
	// eaves: ink outline + a pale parapet lip — the rim sells the height as it parallaxes
	col *= smoothstep(-0.5, 4.0, -edge) * 0.55 + 0.45;
	col += vec3(0.085, 0.082, 0.080) * (1.0 - smoothstep(3.0, 10.0, -edge)) * smoothstep(-1.5, -3.0, edge);
	// a rooftop service lamp on some houses — the skyline sparkles at night
	if (fract(hs.seed * 61.3) < 0.40) {
		vec2 lp = hs.lc - vec2(hs.ext.x * 0.6, -hs.ext.y * 0.6);
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
	vec3 col = vec3(0.062, 0.054, 0.050) * lit * (0.6 + 0.5 * t);
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
	vec3 dirt = vec3(0.060, 0.056, 0.050) * (0.66 + 0.34 * hash21(floor(w / 148.0)));
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
	dirt = mix(dirt, vec3(0.130, 0.122, 0.110), dustM * 0.30); // the dust sheets themselves
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
			dirt = mix(dirt, vec3(0.105, 0.102, 0.100), 1.0 - smoothstep(-1.0, 2.0, cd));
			dirt += PAL_LAMP * 0.28 * exp(-max(cd, 0.0) * 0.05) * (0.5 + dustM);
			dirt += PAL_LAMP * 0.9 * (1.0 - smoothstep(-4.0, 1.0, cd));
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
		// ── courtyard between the terrace rows: packed grit, junk, a faint light spill
		col = vec3(0.028, 0.027, 0.026) * (0.75 + 0.25 * hash21(floor(w / 33.0)));
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
			col = vec3(0.060, 0.057, 0.054) * (0.82 + 0.18 * hash21(floor(vec2(hd, ang2 * hd) / 24.0)));
			col *= 0.88 + 0.12 * smoothstep(0.0, 2.0, abs(fract(hd / 42.0) - 0.5) * 42.0); // courses
			float dd = hd - 40.0; // monument dais
			col = mix(col, vec3(0.078, 0.073, 0.068), 1.0 - smoothstep(-1.5, 1.0, dd));
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
	vec3 road = vec3(0.030, 0.028, 0.030) * (0.85 + 0.15 * hash21(floor(w / 31.0)));
	road *= 0.90 + 0.10 * hash21(floor(w / 8.0));
	road = mix(road, road * 0.5, smoothstep(0.8, 0.98, hash21(floor(w / 39.0))) * 0.7); // scorch/oil
	col = mix(col, road, rmask);
	col += vec3(0.10, 0.09, 0.09) * (1.0 - smoothstep(1.0, 2.6, abs(sd - (STREET_HW - 4.0)))) * roadMix; // curb
	{ // lane paint down the middle — pale worn dashes, not a light show
		float ringd = abs(cr - max(round(cr / RING_SP), 1.0) * RING_SP);
		float along = ringd < spoke_dist(w) ? a * cr : cr;
		float dash = step(fract(along / 120.0), 0.5);
		col += vec3(0.135, 0.130, 0.122) * (1.0 - smoothstep(1.2, 3.0, sd)) * dash * roadMix;
	}

	// contact shadow hugging every block — camera-independent, anchors the footprints
	col *= 1.0 - smoothstep(-90.0, -2.0, pen) * 0.5 * step(pen, 0.0);

	// ── the defense grid's light playing over the ground, through the dust: perimeter
	// giants sweep their two-sided laser bars; inner MACHINE-GUN turrets strobe a hot
	// muzzle pool + tracer flicker down their one-sided corridor. Timing MUST match
	// physics.comp / body.frag (duty/rate/sweep from time + slot id).
	for (uint ti = 0u; ti < MAX_TURRETS; ti++) {
		Body tw = BODIES[TURRET_LO + ti];
		if (tw.kind != KIND_TURRET) { continue; }
		vec2 dvec = w - tw.pos;
		float d2 = dot(dvec, dvec);
		if (d2 > TWR_LEN * TWR_LEN) { continue; }
		bool mg = distance(tw.pos, ctr) < pc.city_r;
		float duty = mg ? 0.70 : 0.30;
		float rate = mg ? 0.90 : 0.14;
		float phase = fract(pc.time * rate + hash1((TURRET_LO + ti) * 77u));
		if (mg) { // the bullet stream's glow tracks the rounds (time-of-flight rewind)
			float dw = sqrt(d2);
			float te = pc.time - dw / MG_V;
			float ph = fract(te * rate + hash1((TURRET_LO + ti) * 77u));
			if (ph < duty && dw < MG_LEN) {
				float envE = smoothstep(0.0, 0.03, ph) * smoothstep(duty, duty - 0.04, ph);
				float burstE = step(0.30, fract(te * 3.3 + hash1((TURRET_LO + ti) * 55u)));
				float angE = hash1((TURRET_LO + ti) * 913u) * TAU + te * 2.6;
				vec2 rp = tw.pos + vec2(cos(angE), sin(angE)) * dw;
				float lat2 = dot(w - rp, w - rp);
				col += PAL_EMBER * exp(-lat2 / 1600.0) * 0.25 * envE * burstE * (0.5 + dustM);
			}
		} else if (phase < duty) {
			float env = smoothstep(0.0, 0.03, phase) * smoothstep(duty, duty - 0.04, phase);
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
		if (hs.ok && hs.sd <= 0.0) {
			col = tHit > house_h(hs) - 0.04 ? roof_col(gh, hs) : wall_col(gh, hs, tHit);
		} else { // the block PLINTH — its rim IS the collision face
			float pen = bldg_pen(gh);
			if (tHit > 0.04) { // slab top: packed yard grit between the houses
				col = vec3(0.042, 0.039, 0.036) * (0.75 + 0.25 * hash21(floor(gh / 33.0)));
				col *= 0.90 + 0.10 * hash21(floor(gh / 7.0));
				col = mix(col, vec3(0.02), step(0.97, hash21(floor(gh / 13.0))) * 0.6); // junk
				col *= 0.70 + 0.30 * smoothstep(0.0, 30.0, pen); // dark edging at the rim
			} else { // slab wall face — the wall you bump into
				col = vec3(0.058, 0.055, 0.052) * (0.65 + 0.35 * smoothstep(0.0, 0.07, tHit));
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
