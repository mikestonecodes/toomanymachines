#version 460
#include "common.glsl"

// The city, drawn per-pixel from the CITY height grid: dark plate streets with red lane
// strips, metallic rooftops with vents/panels, hot reactor cores on the tall towers, and
// the truck's lights splashed on the ground. Beyond the border lies the wasteland the
// horde marches in from — drivable, cracked ground behind a hot hazard line. Top-down;
// light nominally from screen top-left.

layout(location = 0) out vec4 o_color;

float city_h(ivec2 c) {
	if (any(lessThan(c, ivec2(0))) || any(greaterThanEqual(c, ivec2(int(CITY_N))))) { return 0.0; }
	return CITY[uint(c.y) * CITY_N + uint(c.x)];
}

// Signed distance to cell c's building rect (negative inside).
float bldg_sdf(vec2 w, ivec2 c) {
	vec2 ctr = (vec2(c) + 0.5) * CITY_CELL;
	return sd_box(w - ctr, vec2(CITY_CELL * 0.5 - BLDG_INSET));
}

void main() {
	vec2 w = pc.cam + gl_FragCoord.xy - pc.screen * 0.5;
	vec3 col;

	if (any(lessThan(w, vec2(0.0))) || any(greaterThan(w, vec2(WORLD)))) {
		// ── the wasteland: broken dark ground, faint drift, the perimeter hazard line
		vec2 dv = max(vec2(0.0) - w, w - vec2(WORLD));
		float dd = max(max(dv.x, dv.y), 0.0);
		col = PAL_BASE * (0.30 + 0.30 * hash21(floor(w / 64.0)));
		vec2 kl = fract(w / 64.0) * 64.0;
		float crack = min(min(kl.x, 64.0 - kl.x), min(kl.y, 64.0 - kl.y));
		col *= 0.72 + 0.28 * smoothstep(0.0, 2.2, crack);
		col *= 0.90 + 0.10 * hash21(floor(w * 0.5));
		col *= 0.92 + 0.08 * sin(w.x * 0.013 + sin(w.y * 0.011));
		col += PAL_ACCENT * 0.5 * exp(-dd * 0.05) * (0.7 + 0.3 * sin(pc.time * 2.0 + (w.x + w.y) * 0.01));
	} else {
		ivec2 c = ivec2(w / CITY_CELL);
		float h = city_h(c);
		vec2 lc = w - vec2(c) * CITY_CELL; // 0..CITY_CELL inside the cell
		float cellh = hash21(vec2(c) * 1.618 + 7.0);

		// ── ground: big dark slabs with seams, mottled grime, fine grain (the 60%)
		vec2 tile = floor(w / 84.0);
		col = PAL_BASE * (0.75 + 0.45 * hash21(tile));
		vec2 tl = fract(w / 84.0) * 84.0;
		float seam = min(min(tl.x, 84.0 - tl.x), min(tl.y, 84.0 - tl.y));
		col *= 0.62 + 0.38 * smoothstep(0.0, 3.0, seam);
		col *= 0.92 + 0.08 * sin(w.x * 0.021 + sin(w.y * 0.017)) * sin(w.y * 0.013);
		col *= 0.90 + 0.10 * hash21(floor(w * 0.5));

		bool vstreet = (c.x % 4) == 0;
		bool hstreet = (c.y % 4) == 0;
		if (h <= 0.0 && (vstreet != hstreet)) {
			// dashed lane light down the corridor middle + faint gutter strips at the curbs
			float across = vstreet ? lc.x : lc.y;
			float along  = vstreet ? w.y : w.x;
			float lane = smoothstep(2.6, 1.2, abs(across - CITY_CELL * 0.5));
			float dash = step(fract(along / 120.0), 0.55);
			col += PAL_ACCENT * lane * dash * 0.55;
			float gut = smoothstep(2.0, 0.8, abs(abs(across - CITY_CELL * 0.5) - (CITY_CELL * 0.5 - BLDG_INSET * 0.55)));
			col += PAL_ACCENT * gut * 0.10;
		}

		// ── building shadows on the ground (offset toward bottom-right of each tower)
		{
			vec2 sq = w - vec2(44.0, 60.0);
			ivec2 sc = ivec2(sq / CITY_CELL);
			float sh = city_h(sc);
			if (sh > h) {
				float d = bldg_sdf(sq, sc);
				col *= 1.0 - smoothstep(14.0, -10.0, d) * 0.5 * min(sh + 0.35, 1.0);
			}
		}

		// ── building: beveled wall lip → paneled metal roof (the 30%), red details (the 10%)
		if (h > 0.0) {
			float d = bldg_sdf(w, c);
			if (d < 0.0) {
				vec2 ctr = (vec2(c) + 0.5) * CITY_CELL;
				vec2 pn = normalize(w - ctr + 0.0001);
				float rim = dot(pn, normalize(vec2(-0.6, -0.8)));

				// roof panels
				vec2 rp = w / 37.0;
				float pv = hash21(floor(rp) + cellh * 31.0);
				vec3 roof = mix(PAL_BASE * 1.3, PAL_MID, 0.18 + 0.42 * pv) * (0.5 + 0.4 * h);
				vec2 rl = fract(rp) * 37.0;
				float rs = min(min(rl.x, 37.0 - rl.x), min(rl.y, 37.0 - rl.y));
				roof *= 0.75 + 0.25 * smoothstep(0.0, 2.0, rs);
				if (pv > 0.78) { // vent / AC unit
					float gd = sd_box(rl - 18.5, vec2(10.0, 7.0)) - 2.0;
					roof = mix(roof, PAL_BASE * 0.8 * (0.8 + 0.4 * sin(rl.y * 1.9)), 1.0 - smoothstep(-1.0, 1.0, gd));
				}
				if (pv < 0.05) { // blinking maintenance beacon
					float bl = length(rl - 18.5);
					float blink = smoothstep(0.55, 0.95, sin(pc.time * 1.7 + pv * 90.0) * 0.5 + 0.5);
					roof += PAL_ACCENT * 1.8 * exp(-bl * bl / 9.0) * blink;
				}
				// reactor core on some tall towers — pulsing hot, feeds the bloom
				if (cellh > 0.86 && h > 0.6) {
					float rr = length(lc - CITY_CELL * 0.5);
					float puls = 0.75 + 0.25 * sin(pc.time * 2.6 + cellh * 40.0);
					roof *= 0.9 + 0.1 * sin(atan(lc.y - CITY_CELL * 0.5, lc.x - CITY_CELL * 0.5) * 8.0); // strut spokes
					roof += PAL_ACCENT * 2.6 * exp(-rr * rr / 460.0) * puls;
					roof += PAL_ACCENT * 0.35 * exp(-rr / 46.0) * puls;
				}

				// wall band: dark flank with a bright beveled lip at the very edge
				vec3 wall = PAL_BASE * 0.9 * (1.0 + rim * 0.5);
				wall = mix(wall, PAL_MID * (0.7 + rim * 0.7), smoothstep(-3.5, -0.5, d));
				col = mix(roof, wall, smoothstep(-15.0, -11.0, d));
			}
		}
	}

	// ── the truck's light on the ground (city AND wasteland): headlight cones,
	// muzzle strobe, faint under-glow
	{
		float pa = BODIES[0].angle;
		vec2 rel = w - pc.player;
		vec2 f = vec2(cos(pa), sin(pa));
		float fwd = dot(rel, f);
		float lat = abs(dot(rel, vec2(-f.y, f.x)));
		float cone = smoothstep(0.0, 30.0, fwd) * smoothstep(320.0, 60.0, fwd) * smoothstep(fwd * 0.34 + 16.0, fwd * 0.10, lat);
		col += vec3(1.0, 0.82, 0.55) * cone * 0.16;
		float r2 = dot(rel, rel);
		col += PAL_EMBER * pc.muzzle * exp(-r2 / 15000.0) * 0.5; // muzzle strobe
		col += PAL_ACCENT * 0.05 * exp(-r2 / 4000.0);            // faint under-glow
	}

	o_color = vec4(col, 1.0);
}
