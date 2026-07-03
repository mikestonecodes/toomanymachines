#version 460
#include "common.glsl"

// Final composite → swapchain, ported from fishlab post.wgsl (fs_composite): scene +
// bloom, ACES tonemap, animated film grain, vignette, and a mild warm-shadow grade so
// the frame sits in the palette.

layout(set = 0, binding = 1) uniform sampler2D TEXS[];
layout(location = 0) out vec4 o_color;

const float BLOOM_INTENSITY = 3.2;

// fishlab grain_post: two-hash animated film grain
float grain(vec2 px, float t) {
	float n1 = hash21(px + t * 10.0);
	float n2 = hash21(px * 1.5 + t * 7.0 + 100.0);
	return ((n1 + n2) * 0.5 - 0.5) * 0.085;
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
		duv += dir * exp(-x * x / 700.0) * 22.0 * fade;                    // compression shove out
		duv -= dir * exp(-pow(x + 30.0, 2.0) / 2400.0) * 10.0 * fade;      // rarefaction pull back
		float inside = smoothstep(0.0, -Rpx * 0.7, x);
		duv += vec2(sin(rel.y * 0.13 + pc.time * 33.0 + bp.x),
		            sin(rel.x * 0.11 - pc.time * 29.0 + bp.y)) * inside * 3.0 * fade;
		shimmer += inside * fade;
	}
	vec3 col;
	if (dot(duv, duv) > 0.0001) {
		col.r = texture(TEXS[IMG_SCENE], uv - duv * 1.15 / pc.screen).r;
		col.g = texture(TEXS[IMG_SCENE], uv - duv / pc.screen).g;
		col.b = texture(TEXS[IMG_SCENE], uv - duv * 0.85 / pc.screen).b;
		col *= 1.0 + shimmer * 0.08; // superheated air glows faintly
	} else {
		col = texture(TEXS[IMG_SCENE], uv).rgb;
	}
	col += texture(TEXS[IMG_BLOOMB], uv).rgb * BLOOM_INTENSITY;

	// ACES tonemap, then sRGB-encode (the swapchain is UNORM — the display decodes ~2.2)
	col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), vec3(0.0), vec3(1.0));
	col = pow(col, vec3(1.0 / 2.2));

	// warm-shadow grade: cool channels roll off a touch faster
	col = pow(col, vec3(1.0, 1.06, 1.12));

	col += vec3(grain(gl_FragCoord.xy, pc.time));

	// vignette
	float aspect = pc.screen.x / max(pc.screen.y, 1.0);
	float rn = length((uv - 0.5) * vec2(aspect, 1.0)) / 0.5;
	float vig = pow(smoothstep(1.35, 0.55, rn), 1.2);
	col *= 0.45 + 0.55 * vig; // heavy — the frame lives in the dark

	o_color = vec4(clamp(col, 0.0, 1.0), 1.0);
}
