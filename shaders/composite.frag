#version 460
#include "common.glsl"

// Final composite → swapchain, ported from fishlab post.wgsl (fs_composite): scene +
// bloom, ACES tonemap, animated film grain, vignette, and a mild warm-shadow grade so
// the frame sits in the palette.

layout(set = 0, binding = 1) uniform sampler2D TEXS[];
layout(location = 0) out vec4 o_color;

const float BLOOM_INTENSITY = 2.2;

// fishlab grain_post: two-hash animated film grain
float grain(vec2 px, float t) {
	float n1 = hash21(px + t * 10.0);
	float n2 = hash21(px * 1.5 + t * 7.0 + 100.0);
	return ((n1 + n2) * 0.5 - 0.5) * 0.085;
}

void main() {
	vec2 uv = gl_FragCoord.xy / pc.screen;
	vec3 col = texture(TEXS[IMG_SCENE], uv).rgb;
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
	col *= 0.45 + 0.55 * vig;

	o_color = vec4(clamp(col, 0.0, 1.0), 1.0);
}
