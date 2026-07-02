#version 460
#include "common.glsl"

// One instanced quad per body, sized per kind (legs, tracers and death bursts all need
// margin beyond the collision radius), rotated into the body's facing (+x = forward).

// Vertex → fragment interface (must match body.frag's `in`s).
layout(location = 0) out vec2      v_local; // body-frame px
layout(location = 1) out flat uint v_id;

const vec2 CORNERS[6] = vec2[6](
	vec2(-1, -1), vec2(1, -1), vec2(-1, 1),
	vec2(-1,  1), vec2(1, -1), vec2( 1, 1)
);

void main() {
	uint id = uint(gl_InstanceIndex);
	Body b = BODIES[id];
	v_id = id;
	if (b.kind == KIND_DEAD) { // park the quad outside the clip volume
		gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
		v_local = vec2(0.0);
		return;
	}
	float ext = b.radius * 2.6; // enemies: room for legs + flash
	if (b.kind == KIND_PLAYER) { ext = 82.0; } // truck + turret flash + headlight cones
	else if (b.kind == KIND_BULLET) { ext = 34.0; } // tracer tail
	else if (b.kind == KIND_DYING) {
		float total = b.variant == VAR_SPARK ? SPARK_T : DEATH_T;
		float prog = 1.0 - clamp(b.life / total, 0.0, 1.0);
		ext = b.variant == VAR_SPARK ? b.radius + 26.0 * prog + 8.0 : b.radius * 1.4 + 85.0 * prog;
		if (b.variant == VAR_BRUTE) { ext *= 1.5; }
	}
	vec2 local = CORNERS[gl_VertexIndex] * ext;
	vec2 world = b.pos + rot2(b.angle) * local;
	vec2 px = world - pc.cam + pc.screen * 0.5;
	// Vulkan clip space is Y-down, so no flip: px.y=0 (top pixel) → ndc.y=-1 (top).
	gl_Position = vec4(px / pc.screen * 2.0 - 1.0, 0.0, 1.0);
	v_local = local;
}
