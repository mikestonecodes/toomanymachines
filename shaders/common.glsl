// Shared shader contract. Included by every shader via `#include "common.glsl"`
// (glslc resolves it with -I shaders). The GPU structs (Body, Push) are injected
// from the Odin definitions (render.odin @glsl block) → shaders/gen.glsl, below.
#ifndef COMMON_GLSL
#define COMMON_GLSL

#extension GL_EXT_nonuniform_qualifier : require
#extension GL_EXT_scalar_block_layout  : require

// Odin-generated (from the @glsl blocks + BUF_SPECS): the Body/Push structs, gameplay constants,
// the bindless storage-buffer arrays (bodyBuf[], uintBuf[], floatBuf[]) + accessor macros, and the
// push block. Varyings are NOT here — a graphics pipeline declares its own in its .vert/.frag.
#include "gen.glsl"

// ── the 60/30/10 palette ─────────────────────────────────────────────────────
// 60% near-black asphalt/plate, 30% warm grey metal, 10% hot red-orange accents
// (amber is the player's slice of the accent budget; enemies burn pure red).
const vec3 PAL_BASE   = vec3(0.052, 0.048, 0.056);
const vec3 PAL_MID    = vec3(0.165, 0.150, 0.160);
const vec3 PAL_ACCENT = vec3(1.00, 0.155, 0.06);
const vec3 PAL_EMBER  = vec3(1.00, 0.62, 0.18);

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

#endif
