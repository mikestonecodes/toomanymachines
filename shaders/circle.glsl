#version 460
#include "common.glsl"

// Instanced circle-SDF, vertex + fragment in one file. tools/build.odin compiles it twice:
// -DVERTEX → shaders/spv/circle.vert.spv, -DFRAGMENT → shaders/spv/circle.frag.spv.

#ifdef VERTEX
	#define VARYING out
#else
	#define VARYING in
#endif
layout(location = 0) VARYING vec2      v_local;
layout(location = 1) VARYING float     v_radius;
layout(location = 2) VARYING flat uint v_kind;

#ifdef VERTEX
// One instanced quad per body, read straight from the bindless body buffer.
const vec2 CORNERS[6] = vec2[6](
	vec2(-1, -1), vec2(1, -1), vec2(-1, 1),
	vec2(-1,  1), vec2(1, -1), vec2( 1, 1)
);
void main() {
	Body b = BODIES[gl_InstanceIndex];
	vec2 local = CORNERS[gl_VertexIndex] * (b.radius + 2.0);
	vec2 px = b.pos + local;
	// Vulkan clip space is Y-down, so no flip: px.y=0 (top pixel) → ndc.y=-1 (top).
	gl_Position = vec4((px.x / pc.screen.x) * 2.0 - 1.0, (px.y / pc.screen.y) * 2.0 - 1.0, 0.0, 1.0);
	v_local  = local;
	v_radius = b.radius;
	v_kind   = b.kind;
}
#endif

#ifdef FRAGMENT
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
#endif
