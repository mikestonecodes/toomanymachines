#version 460
#include "common.glsl"

// Vertex → fragment interface (must match circle.frag's `in`s).
layout(location = 0) out vec2      v_local;
layout(location = 1) out float     v_radius;
layout(location = 2) out flat uint v_kind;

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
