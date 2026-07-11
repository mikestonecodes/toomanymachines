// ── the LOADING BAR (ported from ../fishlab loader.odin/loader.wgsl, re-skinned to the
// 60/30/10 palette) ──────────────────────────────────────────────────────────────────
// Drawn straight to the swapchain while the worker threads compile the game pipelines
// (loading_screen, loader.odin) — only on a first launch: a warm runtime pipeline cache
// skips the loading screen entirely. One fullscreen triangle, progress (pipelines built
// / total) in pc.pfire; palette rules hold: near-black ground, a value-grey track, the
// accent spent ONLY on the information — the fill. Nothing blinks.

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

	// fill: the hot red-orange accent sweeps left → right, ember-tipped at the front
	// like everything that burns in the game
	float p  = clamp(pc.pfire, 0.0, 1.0);
	vec2  f  = a + vec2(2.0 * halfw * p, 0.0);
	float df = sd_seg(px, a, f) - (r - 1.0);
	float tip = smoothstep(halfw * 0.35, 0.0, distance(px, f)); // the leading edge runs hotter
	col = mix(col, mix(PAL_ACCENT, PAL_EMBER, tip * 0.65), smoothstep(1.0, -1.0, df));
	col += PAL_ACCENT * 0.028 * exp(-max(df, 0.0) * 0.04) * p; // a faint steady under-glow

	o_color = vec4(col, 1.0);
}
