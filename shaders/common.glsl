// Shared shader contract. Included by every shader via `#include "common.glsl"`
// (glslc resolves it with -I shaders). The GPU structs (Body, Push) are injected
// from the Odin definitions (render.odin @glsl block) → shaders/gen.glsl, below.
#ifndef COMMON_GLSL
#define COMMON_GLSL

#extension GL_EXT_nonuniform_qualifier : require
#extension GL_EXT_scalar_block_layout  : require

// Odin-generated (from the @glsl blocks + BUF_SPECS): the Body/Push structs, gameplay constants,
// the bindless storage-buffer arrays (bodyBuf[], uintBuf[]) + accessor macros, and the push
// block. Varyings are NOT here — a graphics pipeline declares its own in its .vert/.frag.
#include "gen.glsl"

// ── the 60/30/10 palette: night battlefield, hot red-orange lights ───────────
// 60% near-black asphalt/dirt, 30% dark warm metal, 10% hot red-orange emissives
// (amber is the player's slice of the light budget; enemies burn pure red).
const vec3 PAL_BASE   = vec3(0.052, 0.048, 0.056);
const vec3 PAL_MID    = vec3(0.165, 0.150, 0.160);
const vec3 PAL_ACCENT = vec3(1.00, 0.155, 0.06);
const vec3 PAL_EMBER  = vec3(1.00, 0.46, 0.12);  // hot metal — a shade of the accent, not gold
const vec3 PAL_WINDOW = vec3(1.00, 0.42, 0.13);  // reserved: gameplay-relevant warm lights only
const vec3 PAL_LAMP   = vec3(0.55, 0.53, 0.50);  // neutral practicals — windows, lamps, beacons:
                                                 // decoration NEVER spends the accent budget

const float TAU = 6.2831853;

// ── shared helpers ───────────────────────────────────────────────────────────
float hash1(uint n) {
	uint x = n * 747796405u + 2891336453u;
	x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
	x = (x >> 22u) ^ x;
	return float(x) / 4294967296.0;
}

float hash21(vec2 p) {
	p = fract(p * vec2(123.34, 456.21));
	p += dot(p, p + 45.32);
	return fract(p.x * p.y);
}

mat2 rot2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }

// smooth value noise — effects must ROLL, not show hash-cell pixels
float vnoise(vec2 p) {
	vec2 i = floor(p), f = fract(p);
	f = f * f * (3.0 - 2.0 * f);
	return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
	           mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}

float sd_box(vec2 p, vec2 b) {
	vec2 d = abs(p) - b;
	return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float sd_seg(vec2 p, vec2 a, vec2 b) {
	vec2 pa = p - a, ba = b - a;
	float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
	return length(pa - ba * h);
}

// ── the city structure ───────────────────────────────────────────────────────
// The city is ANALYTIC: curved streets (wobbled rings + spiral spokes) carve building
// blocks out of hash space. street_d + bldg_pen MUST mirror street_dist + bldg_pen in
// car.odin (the ship collides on the CPU); physics.comp constrains every body with them
// and city.frag draws from them.

// Distance to the nearest street centerline. Rings are perfect circles (wobble made
// the blocks read as warped under the fake 3D); the spiral spokes carry the curves.
float street_d(vec2 p) {
	vec2 q = p - vec2(WORLD * 0.5);
	float r = length(q);
	float d = abs(r - max(round(r / RING_SP), 1.0) * RING_SP);
	// 5 main avenues reach the core; the staggered 5 only exist beyond SPOKE2_R
	float sa = atan(q.y, q.x) - SPIRAL * r;
	float stp = TAU / (SPOKES * 0.5);
	float da = sa - round(sa / stp) * stp;
	d = min(d, abs(da) * r);
	if (r > SPOKE2_R) {
		float sa2 = sa + stp * 0.5;
		float da2 = sa2 - round(sa2 / stp) * stp;
		d = min(d, abs(da2) * r);
	}
	return d;
}

// Ring band kb / sector jb of p, and whether a block band exists here (z = 1) —
// z = 0 means the pit core or open ground outside the city. Nearly everything in the
// city is BUILT; some blocks host a circular plaza (block_plaza below).
vec3 city_block(vec2 p) {
	vec2 q = p - vec2(WORLD * 0.5);
	float r = length(q);
	float kb = floor(r / RING_SP);
	if (kb < 1.0 || r > pc.city_r - 60.0) { return vec3(kb, 0.0, 0.0); }
	float ns = kb * RING_SP >= SPOKE2_R ? SPOKES : SPOKES * 0.5;
	float jb = floor((atan(q.y, q.x) - SPIRAL * r) / (TAU / ns));
	return vec3(kb, jb, 1.0);
}

// The circular PLAZA carved into a plaza block: xy = center, z = radius (0 = fully
// built block). Which blocks host one comes from the CITY table the CPU generated in
// game_init — physics, the drawing AND the CPU's block_pen all read that one buffer,
// so the layout can never drift between them.
vec3 block_plaza(vec2 blkxy) {
	float kb = blkxy.x;
	if (kb < 1.0 || kb >= float(CITY_KMAX)) { return vec3(0.0); }
	float ns = kb * RING_SP >= SPOKE2_R ? SPOKES : SPOKES * 0.5;
	float jw = blkxy.y - ns * floor(blkxy.y / ns); // wrap the seam
	if (CITY[uint(kb) * CITY_JMAX + uint(jw)] != 0u) { return vec3(0.0); }
	float rc = (kb + 0.5) * RING_SP;
	float ac = (jw + 0.5) * TAU / ns + SPIRAL * rc;
	return vec3(vec2(WORLD * 0.5) + vec2(cos(ac), sin(ac)) * rc, PLAZA_R);
}

// How deep p sits inside a block's solid band (negative on streets, inside plazas and
// on open ground). This is the SAME solid region collision enforces (building_push /
// block_pen mirror it); city.frag draws its rim as the raised block plinth.
float bldg_pen(vec2 p) {
	vec3 blk = city_block(p);
	if (blk.z < 0.5) { return -1e9; }
	float pen = street_d(p) - BLDG_EDGE;
	vec3 pz = block_plaza(blk.xy);
	if (pz.z > 0.0) { pen = min(pen, length(p - pz.xy) - pz.z); }
	return pen;
}

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

// district of a block: 0 residential rows, 1 industrial yards, 2 tower blocks
float district(vec3 blk) { return floor(hash21(vec2(blk.x, floor(blk.y / 3.0)) * 2.7 + 13.0) * 2.999); }

// ── the houses ────────────────────────────────────────────────────────────────
// Every block holds two terrace rows of discrete tangent-aligned RECT houses hugging
// its ring streets, courtyard between. ok = this row cell holds a house (p may still be
// outside its rect — sd tells); lc/ext = house-local coords + half-sizes (x radial,
// y along the row); u = the house's radial axis in world. Row pitch varies per ring so
// blocks differ in rhythm; rare cells are landmarks (taller, slimmer).
// MUST mirror house_pen in car.odin (ship collision runs on the CPU).
struct House { bool ok; float h; float sd; vec2 lc; vec2 ext; float seed; float dis; vec2 u; };

House house_at(vec2 p) {
	House hs;
	hs.ok = false;
	hs.h = 0.0;
	hs.sd = 1e9;
	vec3 blk = city_block(p);
	if (blk.z < 0.5) { return hs; }
	vec2 q = p - vec2(WORLD * 0.5);
	float r = length(q);
	float rB0 = blk.x * RING_SP + BLDG_EDGE;
	float rB1 = (blk.x + 1.0) * RING_SP - BLDG_EDGE;
	float rowDepth = (rB1 - rB0) * 0.40;
	bool outer = r > (rB0 + rB1) * 0.5;
	float rRow = outer ? rB1 - rowDepth * 0.5 : rB0 + rowDepth * 0.5;
	// row pitch: each ring row has its own rhythm — small shops to long halls
	float S = 130.0 + floor(hash21(vec2(blk.x, outer ? 1.0 : 0.0) * 3.9 + 6.1) * 3.0) * 65.0;
	float sa = atan(q.y, q.x) - SPIRAL * r;
	float ci = floor(sa * rRow / S);
	float seed = hash21(vec2(ci, blk.x * 13.0 + blk.y * 3.0 + (outer ? 7.0 : 0.0)));
	if (seed < 0.16) { return hs; } // missing house → gap in the terrace
	float aC = (ci + 0.5) * S / rRow + SPIRAL * rRow;
	vec2 cdir = vec2(cos(aC), sin(aC));
	vec2 c = vec2(WORLD * 0.5) + cdir * rRow;
	if (spoke_dist(c) < BLDG_EDGE + S * 0.5) { return hs; } // clear of the avenues
	vec3 pz = block_plaza(blk.xy);
	if (pz.z > 0.0 && distance(c, pz.xy) < pz.z + S * 0.5) { return hs; } // houses RING the plaza
	vec2 d2 = p - c;
	hs.lc = vec2(dot(d2, cdir), dot(d2, vec2(-cdir.y, cdir.x)));
	hs.ext = vec2(rowDepth * 0.5 - 4.0 - 14.0 * fract(seed * 3.3),
	              S * 0.5 - (8.0 + 26.0 * fract(seed * 5.7))); // CHUNKY — no sliver houses
	hs.seed = seed;
	hs.dis = district(blk);
	hs.u = cdir;
	// height CLASSES, not a smooth ramp — neighbors JUMP between squat sheds, rowhouses,
	// mid-rises, slabs and true towers, so the skyline reads as a bar chart, not a blur.
	// Districts tilt the draw: residential stays low, tower blocks pull tall.
	float hh = fract(seed * 9.1);
	float cls = fract(seed * 31.7) + (hs.dis > 1.5 ? 0.22 : 0.0) - (hs.dis < 0.5 ? 0.08 : 0.0);
	float hb = cls < 0.34 ? 0.10 + 0.08 * hh   // squat shed
	         : cls < 0.62 ? 0.20 + 0.12 * hh   // rowhouse
	         : cls < 0.82 ? 0.36 + 0.16 * hh   // mid-rise
	         : cls < 0.95 ? 0.56 + 0.18 * hh   // slab
	         :              0.78 + 0.22 * hh;  // tower
	hb *= clamp(1.25 - blk.x * 0.055, 0.6, 1.2); // downtown rises
	float chunky = min(hs.ext.x, hs.ext.y);
	hb = min(hb, 0.22 + chunky * 0.011); // small footprints stay LOW — no toothpick towers
	if (fract(seed * 97.3) > 0.93 && chunky > 44.0) { // landmark tower: big footprints only
		hb = max(hb, 0.80 + 0.20 * fract(seed * 53.0));
	}
	hs.h = clamp(hb, 0.10, 1.0);
	hs.ok = true;
	hs.sd = sd_box(hs.lc, hs.ext);
	return hs;
}

// Per-pixel height ACROSS a house footprint — the silhouettes differ for real under the
// fake 3D: pitched ridges + chimney stacks, sawtooth shed roofs, water tanks, domed
// caps, wedding-cake tower setbacks and spire masts. Purely visual (city.frag geometry
// + body.frag occlusion); collision keeps the flat rect. Branch order mirrors roof_col.
float house_h(House hs) {
	float h = hs.h;
	float sx = hs.lc.x / hs.ext.x;
	float sy = hs.lc.y / hs.ext.y;
	if (hs.h > 0.55) { // tall: stepped setbacks, some crowned with a spire mast
		h *= 0.66;
		if (sd_box(hs.lc, hs.ext * 0.62) < 0.0) { h = hs.h * 0.84; }
		if (sd_box(hs.lc, hs.ext * 0.34) < 0.0) { h = hs.h; }
		if (fract(hs.seed * 71.7) < 0.45 && length(hs.lc) < 5.0) { h = min(hs.h + 0.22, 1.0); }
	} else if (fract(hs.seed * 7.3) < 0.22) { // domed hall: a real curved cap
		float dd2 = length(hs.lc / hs.ext);
		h *= 0.70 + 0.30 * sqrt(max(1.0 - dd2 * dd2 * 1.6, 0.0));
	} else if (hs.dis < 0.5) { // residential: pitched ridge along the row + chimneys
		h *= 1.0 - 0.32 * abs(sx);
		if (fract(hs.seed * 29.3) < 0.6 && abs(sy - 0.55) < 0.10 && abs(sx) > 0.25 && abs(sx) < 0.55) { h += 0.05; }
	} else if (hs.dis < 1.5) { // industrial: sawtooth shed roof + the storage tank
		h *= 0.80 + 0.20 * fract(sx * 1.5 + 0.5);
		if (fract(hs.seed * 23.9) > 0.5 && length(hs.lc - vec2(0.0, hs.ext.y * 0.4)) < min(hs.ext.x, hs.ext.y) * 0.5) { h += 0.07; }
	} else { // tower block: rooftop plant boxes stud the flat top
		if (hash21(floor(hs.lc / 38.0) + hs.seed * 40.0) > 0.86) { h += 0.045; }
	}
	return h;
}

#endif
