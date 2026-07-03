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
const vec3 PAL_EMBER  = vec3(1.00, 0.62, 0.18);
const vec3 PAL_WINDOW = vec3(1.00, 0.55, 0.20); // lit windows / sodium lamps

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

// Ring band kb / sector jb of p, and whether a block can stand here (z = 1) —
// z = 0 means plaza, the pit core, or open ground outside the city.
vec3 city_block(vec2 p) {
	vec2 q = p - vec2(WORLD * 0.5);
	float r = length(q);
	float kb = floor(r / RING_SP);
	if (kb < 1.0 || r > pc.city_r - 60.0) { return vec3(kb, 0.0, 0.0); }
	float ns = kb * RING_SP >= SPOKE2_R ? SPOKES : SPOKES * 0.5;
	float jb = floor((atan(q.y, q.x) - SPIRAL * r) / (TAU / ns));
	if (hash21(vec2(kb, jb) * 1.13 + 4.7) < PLAZA_P) { return vec3(kb, jb, 0.0); }
	return vec3(kb, jb, 1.0);
}

// How deep p sits inside a building (negative on streets/plazas/open ground).
float bldg_pen(vec2 p) {
	if (city_block(p).z < 0.5) { return -1e9; }
	return street_d(p) - BLDG_EDGE;
}

#endif
