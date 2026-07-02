#version 460
#include "common.glsl"

// Vertex → fragment interface (must match circle.vert's `out`s).
layout(location = 0) in vec2      v_local;
layout(location = 1) in float     v_radius;
layout(location = 2) in flat uint v_kind;
layout(location = 0) out vec4 o_color;

vec3 color_of(uint k) {
	if (k == KIND_PLAYER) return vec3(0.89, 0.13, 0.13); // red car
	if (k == KIND_BULLET) return vec3(1.0, 0.9, 0.38);   // yellow bullet
	return vec3(0.29, 0.47, 0.94);                        // blue enemy
}

void main() {
	if (v_kind == KIND_DEAD) discard; // spent bullets
	float d = length(v_local) - v_radius;
	if (d > 1.5) discard;
	float a = 1.0 - smoothstep(-1.5, 1.5, d);
	o_color = vec4(color_of(v_kind) * a, a); // premultiplied alpha
}
