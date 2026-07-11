#version 460
#include "common.glsl"

// ── the LOADING BAR (ported from ../fishlab loader.odin/loader.wgsl, re-skinned to the
// 60/30/10 palette) ──────────────────────────────────────────────────────────────────
// Drawn straight to the swapchain while the worker thread compiles the game pipelines
// (loop.odin) — the first launch on any machine pays the driver's SPIR-V→ISA compile
// (the runtime pipeline cache makes every later launch instant). The compile gives no
// progress signal and its duration varies wildly per machine, so the bar is INDETERMINATE:
// an ember segment ping-ponging along the track — "working", never a fake percentage.
// One fullscreen triangle, elapsed seconds in pc.pfire; palette rules hold: near-black
// ground, a value-grey track, the accent spent ONLY on the information — the ember.

layout(location = 0) out vec4 o_color;

void main() {
	vec2 px = gl_FragCoord.xy;
	vec2 c  = pc.screen * 0.5;
	// near-black asphalt ground with a gentle vignette — darker than the battlefield floor
	vec3 col = PAL_BASE * (0.55 - 0.30 * length((px - c) / pc.screen.y));

	float halfw = pc.screen.x * 0.17;                 // 34% of the screen, centered
	float r     = max(2.0, pc.screen.y * 0.004);      // bar half-thickness, rounded ends
	vec2  a     = c - vec2(halfw, 0.0);
	vec2  b     = c + vec2(halfw, 0.0);

	// track: dusty grey, value contrast only
	float dtr = sd_seg(px, a, b) - r;
	col = mix(col, vec3(0.085, 0.080, 0.088), smoothstep(1.0, -1.0, dtr));

	// the ember: a hot red-orange segment (~1/4 of the track) sweeping back and forth,
	// ember-tipped toward its direction of travel like everything that burns in the game
	float ph   = fract(pc.pfire / 1.4) * 2.0;          // one full sweep ≈ 1.4s
	float pos  = 1.0 - abs(1.0 - ph);                  // ping-pong 0→1→0
	float seg  = halfw * 0.24;
	float ex   = a.x + 2.0 * halfw * pos;              // ember center
	vec2  e0   = vec2(clamp(ex - seg, a.x, b.x), c.y);
	vec2  e1   = vec2(clamp(ex + seg, a.x, b.x), c.y);
	float df   = sd_seg(px, e0, e1) - (r - 1.0);
	float lead = clamp((px.x - ex) * (ph < 1.0 ? 1.0 : -1.0) / seg, 0.0, 1.0); // hotter on the leading edge
	col = mix(col, mix(PAL_ACCENT, PAL_EMBER, lead * 0.65), smoothstep(1.0, -1.0, df));
	col += PAL_ACCENT * 0.028 * exp(-max(df, 0.0) * 0.04); // a faint under-glow riding the ember

	o_color = vec4(col, 1.0);
}
