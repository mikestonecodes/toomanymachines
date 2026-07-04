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
// lamps, tower beams, desert marker lamps, the pit furnace — carried on heavy bloom,
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
	// the dust field: two soft noise sheets sliding against each other. The octaves are
	// ROTATED against each other and kept gentle — value noise lives on an axis-aligned
	// lattice, and at high contrast that lattice prints a faint GRID of square blobs
	// over the open sand.
	float dustM = smoothstep(0.35, 0.90,
		vnoise(rot2(0.55) * w * 0.0031 + vec2(pc.time * 0.13, -pc.time * 0.08)) * 0.55
		+ vnoise(rot2(-1.13) * w * 0.0009 + vec2(-pc.time * 0.06, pc.time * 0.05)) * 0.45);

	if (cr < PIT_R) { // ── the PIT: a terraced foundry shaft sunk below grade — the towers'
		// oblique lean MIRRORED: a surface at depth d draws shifted DOWN-screen by LEAN·d
		// (a pure translation, same as the roofs, so nothing shears). Concentric ledges
		// step down to a slag crucible. Ledges are tested shallow → deep; the first whose
		// annulus holds the unprojected sample is the visible surface. Anything unclaimed
		// is shaft wall between two ledges — exactly the up-screen crescent a translated
		// hole leaves showing, so the walls fall out of the same test.
		const float PDEPTH = 0.85; // total depth, in LEAN units
		const float NSTEP  = 4.0;  // ledge count, rim → crucible
		float heatK = 1.0 + 1.1 * pulse; // the melt swells when a corpse drops in — deposits
		// are near-continuous, so the flare must stay a breath, not a strobe
		vec3 col = vec3(0.012, 0.010, 0.009); // fallback: unlit depth
		for (float k = 1.0; k <= NSTEP; k += 1.0) {
			float f    = k / NSTEP;
			float dk   = PDEPTH * f;
			// funnel taper: upper ledges wide, lower ones tight against the crucible
			float Rout = mix(PIT_R, PIT_R * 0.52, pow((k - 1.0) / NSTEP, 1.35));
			float Rin  = k > NSTEP - 0.5 ? 0.0 : mix(PIT_R, PIT_R * 0.52, pow(f, 1.35));
			vec2 pk  = w - vec2(0.0, LEAN * dk); // unproject at this ledge's depth
			float rk = distance(pk, ctr);
			if (rk > Rout) {
				// off this ledge's outer edge — the wall dropping from circle Rout
				// (spanning the depths above this ledge) may own the pixel instead
				vec2 q = w - ctr;
				float s2 = Rout * Rout - q.x * q.x;
				if (s2 > 0.0) {
					float t = (q.y + sqrt(s2)) / LEAN; // the up-screen interior face
					float dk0 = PDEPTH * (k - 1.0) / NSTEP;
					if (t >= dk0 && t <= dk) { // ── shaft wall between ledges
						float ff = t / PDEPTH;
						float within = (t - dk0) / (dk - dk0); // 0 at the lip → 1 at the foot
						col = vec3(0.026, 0.023, 0.021) * (1.0 - 0.5 * ff);
						col *= 0.80 + 0.20 * hash21(vec2(floor(asin(clamp(q.x / Rout, -1.0, 1.0)) * 40.0), k * 7.0)); // vertical streaks
						col += PAL_EMBER * (0.06 + 0.30 * ff) * within * within * heatK; // lit from below
						return col;
					}
				}
				continue; // a deeper surface will claim it
			}
			if (rk >= Rin) {
				if (k > NSTEP - 0.5) { // ── the crucible floor: slag crust over live melt.
					// Cracks come off summed ROTATED octaves — a single value-noise
					// sheet's iso-lines print an axis-aligned circuit-board maze.
					vec2 fp = pk - ctr;
					float n1 = 0.60 * vnoise(rot2(0.6) * fp * 0.024 + 3.0)
					         + 0.40 * vnoise(rot2(2.1) * fp * 0.055 + 11.0);
					col = vec3(0.020, 0.016, 0.013) * (0.62 + 0.38 * vnoise(rot2(-1.2) * fp * 0.075)); // cooled slag
					float crack = smoothstep(0.035, 0.006, abs(n1 - 0.5));
					crack *= 0.35 + 0.65 * vnoise(fp * 0.09 + pc.time * 0.05); // uneven heat along the vein
					float breathe = 0.82 + 0.18 * sin(pc.time * 0.8 + n1 * 9.0);
					col += PAL_EMBER * crack * (0.12 + 0.9 * exp(-rk / (Rout * 0.55))) * breathe * heatK; // vein web, dying toward the rim
					float poolR = Rout * 0.34; // the live pool at the heart
					float mn = vnoise(rot2(pc.time * 0.06) * fp * 0.05 + vec2(0.0, pc.time * 0.10));
					vec3 melt = mix(PAL_ACCENT * 0.85, PAL_EMBER * 1.25, smoothstep(0.35, 0.75, mn));
					col = mix(col, melt * breathe, smoothstep(poolR, poolR * 0.35, rk));
					col += (PAL_EMBER * 1.1 + vec3(0.16, 0.05, 0.015)) * exp(-rk * rk / (poolR * poolR * 0.30)) * breathe * heatK; // white-hot only at the very eye
				} else { // ── a machined ledge: dark plating, furnace rim-light on its inner edge
					float aa = atan(pk.y - ctr.y, pk.x - ctr.x);
					float seg = min(fract(aa * 20.0 / TAU), 1.0 - fract(aa * 20.0 / TAU)) * TAU / 20.0 * rk;
					col = vec3(0.044, 0.040, 0.037) * (1.0 - 0.70 * f);
					col *= 0.90 + 0.10 * hash21(floor(pk / 11.0));
					col *= 0.72 + 0.28 * smoothstep(0.8, 2.4, seg); // radial plate seams
					col += PAL_EMBER * (0.02 + 0.16 * f * f) * exp(-(rk - Rin) / 4.0); // a thin hot line where the lip catches the melt
					col += PAL_EMBER * 0.008 * f * f; // the faintest rising heat wash
				}
				return col;
			}
			// rk < Rin: the pixel sits over the hole in this ledge — a deeper surface
			// (or the wall under this ledge's inner lip) claims it next iteration
		}
		return col;
	}

	vec3 col;
	if (cr < PIT_R + 130.0) { // ── machined apron: calm concentric plate rings, value-stepped,
		// a pale collar on the mouth, furnace light spilling out through the dust.
		// Nothing blinks, nothing radiates — the drama stays down the shaft.
		float ri = floor((cr - PIT_R) / 34.0);
		float rf = fract((cr - PIT_R) / 34.0);
		col = vec3(0.046, 0.043, 0.041) * (0.85 + 0.15 * hash1(uint(ri) * 17u + 5u)); // plate value steps
		col *= 0.92 + 0.08 * hash21(floor(w / 9.0));
		col *= 1.0 - 0.35 * (1.0 - smoothstep(0.0, 2.2, min(rf, 1.0 - rf) * 34.0)); // seam groove between rings
		float aseg = fract(a * 18.0 / TAU + hash1(uint(ri) * 13u + 2u));
		col *= 1.0 - 0.28 * (1.0 - smoothstep(0.6, 1.8, min(aseg, 1.0 - aseg) * TAU / 18.0 * cr)); // offset radial seams
		col += PAL_EMBER * (0.06 + 0.18 * pulse) * (0.4 + 0.6 * dustM) * exp(-(cr - PIT_R) / 45.0); // furnace spill in the dust
		col = mix(col, vec3(0.095, 0.090, 0.084), smoothstep(14.0, 6.0, cr - PIT_R)); // pale machined collar on the lip
		return col;
	}

	float sd = street_d(w);
	float cityMix = smoothstep(pc.city_r + 240.0, pc.city_r - 60.0, cr);
	vec3 blk = city_block(w);
	float pen = bldg_pen(w);

	// ── the DESERT: dark rolling sand under drifting dust, clay pans in the lows.
	// Warm sand only; smooth noise only.
	// ── calm rolling night sand: NOTHING periodic. Every wave/band system tried here
	// (crossed sines, parallel dunes, ripple stitching) read as artificial LINES from
	// the straight-down camera. The ground is pure rotated-octave noise — broad basins,
	// rolling swells, small hummocks, grain — so no direction and no stripe can print.
	vec3 dirt = vec3(0.076, 0.060, 0.043) * (0.74 + 0.26 * vnoise(rot2(-0.4) * w * 0.0004 + 7.0)); // broad basins
	dirt *= 0.88 + 0.12 * vnoise(rot2(0.9) * w * 0.0013 + 3.0);  // rolling swells
	dirt *= 0.93 + 0.07 * vnoise(rot2(1.7) * w * 0.006 + 11.0);  // hummocks
	dirt *= 0.962 + 0.038 * vnoise(rot2(0.3) * w * 0.07);        // grain — smooth
	{ // CLAY PANS in the low basins — broad pale dry-mud sheets, only faintly veined:
		// no crater rings, no rock blobs — the desert is dunes and pans, nothing stamped
		// a WIDE mask ramp + a fine contour warp: a steep threshold draws its own
		// iso-contour as a hard edge across the sand
		float pan = smoothstep(0.52, 0.86, vnoise(rot2(-1.0) * w * 0.00055 + 91.0)
		                                 + (vnoise(rot2(0.35) * w * 0.0026) - 0.5) * 0.22);
		if (pan > 0.001) {
			vec3 clay = vec3(0.087, 0.073, 0.056) * (0.92 + 0.08 * vnoise(rot2(0.8) * w * 0.005 + 3.0));
			clay *= 0.89 + 0.11 * smoothstep(0.0, 0.06, abs(vnoise(rot2(-0.6) * w * 0.021) - 0.5)); // faint vein shading
			dirt = mix(dirt, clay, pan);
		}
	}
	dirt = mix(dirt, vec3(0.118, 0.098, 0.074), dustM * 0.20); // wind-borne sand sheets — a WHISPER,
	// not a milk wash: the desert stays dark night ground
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

	// ── city ground: worn concrete field with expansion joints, patches, manholes
	vec3 pave = vec3(0.047, 0.044, 0.040) * (0.84 + 0.28 * hash21(floor(w / 124.0)));
	vec2 jl = fract(w / 124.0) * 124.0;
	float joint = min(min(jl.x, 124.0 - jl.x), min(jl.y, 124.0 - jl.y));
	pave *= 0.72 + 0.28 * smoothstep(0.0, 2.8, joint);
	pave *= 0.92 + 0.08 * vnoise(w * 0.14);                                               // fine grain — smooth
	pave = mix(pave, pave * vec3(1.30, 0.94, 0.70), vnoise(w * 0.006 + 31.0) * 0.35);     // old rust bleed
	pave = mix(pave, pave * 0.55, smoothstep(0.58, 0.82, vnoise(w * 0.012 + 17.0)) * 0.6); // worn stains — no cell squares
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
	vec3 road = vec3(0.027, 0.025, 0.024) * (0.85 + 0.15 * vnoise(w * 0.030)); // dark warm asphalt — never blue
	road *= 0.92 + 0.08 * vnoise(w * 0.15);                                    // fine grain — smooth
	road = mix(road, road * 0.55, smoothstep(0.55, 0.85, vnoise(w * 0.016 + 5.0)) * 0.65); // oil bleeds — no cell squares
	col = mix(col, road, rmask);
	col += vec3(0.105, 0.092, 0.079) * (1.0 - smoothstep(1.0, 2.6, abs(sd - (STREET_HW - 4.0)))) * roadMix; // warm stone curb
	{ // lane paint: EURO single centerline — one continuous worn line down the middle,
		// broken CLEAN of every crossing (paint never runs through an intersection).
		// The MAIN STREET (the j=0 avenue) is a monumental double carriageway: twin
		// lane lines flanking a lit MEDIAN spine of steady lamps marching to the pit.
		float ringd = abs(cr - max(round(cr / RING_SP), 1.0) * RING_SP);
		float sa = a - SPIRAL * cr;
		float stp = TAU / (SPOKES * 0.5);
		float jn = round(sa / stp);
		float dm = abs(sa - jn * stp) * cr; // RAW arc distance to the nearest primary spoke
		bool onMain = jn == 0.0;
		float rawsp = dm;                                // raw: the centerline paint
		float spoked = onMain ? dm - MAIN_XW : dm;       // adjusted: crossing-gap logic
		if (cr > SPOKE2_R) {
			float sa2 = sa + stp * 0.5;
			float d2 = abs(sa2 - round(sa2 / stp) * stp) * cr;
			rawsp = min(rawsp, d2);
			spoked = min(spoked, d2);
		}
		float other = ringd < spoked ? spoked : ringd; // distance to the CROSSING street's centerline
		float gap = smoothstep(STREET_HW + 14.0, STREET_HW + 58.0, other);
		float wear = 0.75 + 0.25 * vnoise(w * 0.02 + 7.0); // scuffed, not stenciled
		float lane = min(ringd, rawsp);
		col += vec3(0.152, 0.138, 0.106) * (1.0 - smoothstep(0.9, 2.2, lane)) * gap * wear * roadMix;
		if (onMain && dm < STREET_HW + MAIN_XW && cr > PIT_R + 130.0) {
			// twin carriageway lines splitting the huge roadbed into lanes
			float lane2 = abs(dm - (STREET_HW + MAIN_XW) * 0.5);
			col += vec3(0.152, 0.138, 0.106) * (1.0 - smoothstep(1.2, 2.8, lane2)) * gap * wear * roadMix;
			// the median lamps — steady PAL_LAMP practicals (decoration never blinks)
			vec2 lampL = vec2(dm, fract(cr / 300.0) * 300.0 - 150.0);
			float ld = dot(lampL, lampL);
			col += PAL_LAMP * 1.4 * exp(-ld / 40.0) * gap * roadMix;
			col += PAL_LAMP * 0.14 * exp(-ld / 6000.0) * gap * roadMix; // the lit pool
		}
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
		// (no red muzzle strobe on the ground — the car flashing red on every shot read
		// as the car being HIT; the barrel's own flash is enough)
		if (pc.laser > 0.05) {
			float lk = laser_k(); // the COLOSSUS scorches a far bigger line
			vec2 off = pc.aim - pc.player;
			float ol = max(length(off), 0.001);
			vec2 ad = off / ol;
			float bd = sd_seg(g0, pc.player + ad * 40.0, pc.player + ad * (40.0 + LASER_LEN * lk));
			col += PAL_EMBER * exp(-bd * bd / (14000.0 * lk * lk)) * 0.45 * pc.laser * onGround;
		}
	}

	o_color = vec4(col, 1.0);
}
