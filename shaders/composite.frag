// Final composite → swapchain, ported from fishlab post.wgsl (fs_composite): scene +
// bloom, ACES tonemap, animated film grain, vignette, and a mild warm-shadow grade so
// the frame sits in the palette.


const float BLOOM_INTENSITY = 3.6;

// FILM GRAIN: two-hash animated, slightly coarse — silver-halide clumps, not 1px hiss.
// Returns ±0.5; the caller weights it by luminance like real stock (shadows/mids grain
// hard, highlights stay clean).
float grain(vec2 px, float t) {
	vec2 gp = floor(px * 0.7); // ~1.4px clumps
	float n1 = hash21(gp + fract(t * 24.0) * vec2(310.0, 170.0));
	float n2 = hash21(gp * 1.7 + fract(t * 19.0) * vec2(150.0, 260.0) + 100.0);
	return (n1 + n2) * 0.5 - 0.5;
}

void main() {
	vec2 uv = gl_FragCoord.xy / pc.screen;

	// ── shockwave refraction: pure screen-space violence, no drawn ring anywhere.
	// physics publishes this frame's live shell blasts into STATS[2..]; each bends the
	// scene sampling with a RAGGED decelerating pressure front (the radius wobbles with
	// angle so it never reads as a circle), a rarefaction sucking back in behind it, and
	// turbulent heat shimmer filling the blast bubble — split chromatically.
	vec2 duv = vec2(0.0);
	float shimmer = 0.0;
	float heat = 0.0;
	uint nb = min(STATS[2], 8u);
	for (uint i = 0u; i < nb; i++) {
		vec2 bp = vec2(uintBitsToFloat(STATS[3u + i * 3u]), uintBitsToFloat(STATS[4u + i * 3u]));
		float prog = uintBitsToFloat(STATS[5u + i * 3u]);
		vec2 sp = (bp - pc.cam) / ZOOM + pc.screen * 0.5;
		vec2 rel = gl_FragCoord.xy - sp;
		float d = max(length(rel), 1.0);
		vec2 dir = rel / d;
		float ang = atan(rel.y, rel.x);
		float fade = (1.0 - prog) * (1.0 - prog);
		float Rpx = mix(10.0, BOOM_R, pow(prog, 0.6)) / ZOOM;
		float rag = 1.0 + 0.14 * sin(ang * 7.0 + bp.x * 0.13) + 0.10 * sin(ang * 13.0 - bp.y * 0.17 + prog * 6.0);
		float x = d - Rpx * rag;
		duv += dir * exp(-x * x / 700.0) * 26.0 * fade;                    // compression shove out
		duv -= dir * exp(-pow(x + 30.0, 2.0) / 2400.0) * 12.0 * fade;      // rarefaction pull back
		float inside = smoothstep(0.0, -Rpx * 0.7, x);
		duv += vec2(sin(rel.y * 0.13 + pc.time * 33.0 + bp.x),
		            sin(rel.x * 0.11 - pc.time * 29.0 + bp.y)) * inside * 3.0 * fade;
		shimmer += inside * fade;
		heat += exp(-x * x / 1400.0) * fade; // the front runs HOT
	}
	vec3 col;
	if (dot(duv, duv) > 0.0001) {
		col.r = texture(TEXS[IMG_SCENE], uv - duv * 1.15 / pc.screen).r;
		col.g = texture(TEXS[IMG_SCENE], uv - duv / pc.screen).g;
		col.b = texture(TEXS[IMG_SCENE], uv - duv * 0.85 / pc.screen).b;
		col *= 1.0 + shimmer * 0.08;                                  // superheated air glows faintly
		col *= vec3(1.0 + heat * 0.55, 1.0 + heat * 0.10, 1.0);       // the wavefront tints RED-hot
	} else {
		col = texture(TEXS[IMG_SCENE], uv).rgb;
	}
	vec3 bloom = texture(TEXS[IMG_BLOOMB], uv).rgb;
	col += bloom * BLOOM_INTENSITY;

	// ── ground fog: dust sheets drifting over the whole battlefield, world-anchored.
	// Lights SCATTER through them (the bloom term), so the frame reads gritty and
	// glowing at once — fog dims the dark, but everything bright shines through it.
	{
		// octaves rotated against each other — a shared axis-aligned value-noise lattice
		// at this contrast prints a faint square-blob GRID over the open desert
		vec2 wf = pc.cam + (gl_FragCoord.xy - pc.screen * 0.5) * ZOOM;
		float fn = vnoise(rot2(0.62) * wf * 0.0033 + vec2(pc.time * 22.0, -pc.time * 14.0) * 0.006) * 0.55
		         + vnoise(rot2(-1.21) * wf * 0.0011 + vec2(-pc.time * 9.0, pc.time * 7.0) * 0.006) * 0.45;
		float fog = smoothstep(0.32, 0.95, fn) * 0.24;
		col = mix(col, vec3(0.085, 0.080, 0.075), fog);
		col += bloom * fog * 1.8; // light scattered in the dust
	}

	// ACES tonemap, then sRGB-encode (the swapchain is UNORM — the display decodes ~2.2)
	col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), vec3(0.0), vec3(1.0));
	col = pow(col, vec3(1.0 / 2.2));

	// warm-shadow grade: cool channels roll off a touch faster
	col = pow(col, vec3(1.0, 1.06, 1.12));

	// vignette
	float aspect = pc.screen.x / max(pc.screen.y, 1.0);
	float rn = length((uv - 0.5) * vec2(aspect, 1.0)) / 0.5;
	float vig = pow(smoothstep(1.35, 0.55, rn), 1.2);
	col *= 0.45 + 0.55 * vig; // heavy — the frame lives in the dark

	{ // the RETICLE: ring + cross ticks at the aim point (the OS cursor is hidden)
		vec2 cp = (pc.aim - pc.cam) / ZOOM + pc.screen * 0.5;
		vec2 rp = gl_FragCoord.xy - cp;
		float rd = length(rp);
		float ring = 1.0 - smoothstep(1.1, 2.0, abs(rd - 9.0));
		float ticks = (1.0 - smoothstep(0.7, 1.5, min(abs(rp.x), abs(rp.y)))) * step(rd, 15.0) * step(4.5, rd);
		float dotc = 1.0 - smoothstep(0.5, 1.4, rd);
		float ret = max(max(ring, ticks), dotc);
		col = mix(col, vec3(1.0, 0.32, 0.12), ret * 0.9);
	}

	// film grain rides on top of everything, vignette included — luminance-weighted so
	// the dark battlefield grains hard while the lights stay clean
	float lum = dot(col, vec3(0.30, 0.55, 0.15));
	col += grain(gl_FragCoord.xy, pc.time) * mix(0.20, 0.05, smoothstep(0.0, 0.85, lum));

	o_color = vec4(clamp(col, 0.0, 1.0), 1.0);
}
