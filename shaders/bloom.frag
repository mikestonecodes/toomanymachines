#version 460
#include "common.glsl"

// Bloom blur pass, ported from fishlab post.wgsl (fs_blur + bloom_bright): mode 0 =
// bright-extract fused into the horizontal gaussian (Scene → BloomA), mode 1 = vertical
// gaussian (BloomA → BloomB). Runs at half res; taps 2 source-px apart for a wide halo.

layout(set = 0, binding = 1) uniform sampler2D TEXS[];
layout(location = 0) out vec4 o_color;

const float THRESH = 0.55; // the night ground sits far below this — every light blooms
const float KNEE   = 0.12;
const int   TAPS   = 13;  // wide halos: the lights glow THROUGH the dust
const float SIGMA  = 4.0;

// Soft-knee bright-pass: isolate the glowing part of a scene color.
vec3 bright(vec3 c) {
	float luma = dot(c, vec3(0.299, 0.587, 0.114));
	float knee = clamp(luma - THRESH + KNEE, 0.0, 2.0 * KNEE);
	knee = knee * knee / (4.0 * KNEE + 0.0001);
	return c * clamp(max(knee, luma - THRESH) / max(luma, 0.0001), 0.0, 1.0);
}

void main() {
	bool horiz = pc.mode == 0u;
	uint src = horiz ? IMG_SCENE : IMG_BLOOMA;
	vec2 uv = gl_FragCoord.xy / vec2(textureSize(TEXS[IMG_BLOOMA], 0)); // A and B share the target size
	vec2 stp = (horiz ? vec2(2.0, 0.0) : vec2(0.0, 2.0)) / vec2(textureSize(TEXS[src], 0));
	vec3 sum = vec3(0.0);
	float wsum = 0.0;
	for (int i = -TAPS / 2; i <= TAPS / 2; i++) {
		float g = exp(-float(i * i) / (2.0 * SIGMA * SIGMA));
		vec3 c = texture(TEXS[src], uv + stp * float(i)).rgb;
		if (horiz) { c = bright(c); } // extract fused into the first pass
		sum += c * g;
		wsum += g;
	}
	o_color = vec4(sum / wsum, 1.0);
}
