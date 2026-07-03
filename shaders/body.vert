#version 460
#include "common.glsl"

// One instanced quad per body, sized per kind (legs, tracers, tow beams and death
// bursts all need margin beyond the collision radius), rotated into the body's facing
// (+x = forward). Screen mapping is world/ZOOM around the camera.

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
	if (b.kind == KIND_PLAYER) { // ship + turret flash + boost flame; the laser needs the whole reach
		ext = pc.laser > 0.02 ? LASER_LEN + 120.0 : 120.0;
	}
	else if (b.kind == KIND_BULLET) { ext = 34.0; } // tracer tail
	else if (b.kind == KIND_TURRET) { // defense tower; its fire needs the whole reach while shooting
		bool mg = distance(b.pos, vec2(WORLD * 0.5)) < pc.city_r;
		float duty = mg ? 0.70 : 0.30;
		float rate = mg ? 0.90 : 0.14;
		float len  = mg ? MG_LEN : TWR_LEN;
		bool hot = fract(pc.time * rate + hash1(id * 77u)) < duty;
		// mg rounds already in flight outlive the trigger (time-of-flight) — hold the quad
		if (mg && fract((pc.time - MG_LEN / MG_V) * rate + hash1(id * 77u)) < duty) { hot = true; }
		ext = hot ? len + 120.0 : b.radius * 4.0;
	}
	else if (b.kind == KIND_HELPER) { ext = 120.0; } // drone + its hoist beam
	else if (b.kind == KIND_WRECK) { ext = b.radius * 2.4; }
	else if (b.kind == KIND_DYING) {
		float total = b.variant == VAR_SPARK ? SPARK_T : (b.variant == VAR_BOOM ? BOOM_T : DEATH_T);
		float prog = 1.0 - clamp(b.life / total, 0.0, 1.0);
		// dying mechs still draw their whole body + legs, plus the ember spread
		ext = b.variant == VAR_SPARK ? b.radius + 26.0 * prog + 8.0 : b.radius * 2.6 + 60.0 * prog;
		if (b.variant == VAR_BOOM) { ext = mix(40.0, BOOM_R + 50.0, prog); } // the shockwave front
		if (b.variant == VAR_BRUTE) { ext *= 1.5; }
	}
	vec2 local = CORNERS[gl_VertexIndex] * ext;
	vec2 world = b.pos + rot2(b.angle) * local;
	vec2 px = (world - pc.cam) / ZOOM + pc.screen * 0.5;
	// Vulkan clip space is Y-down, so no flip: px.y=0 (top pixel) → ndc.y=-1 (top).
	gl_Position = vec4(px / pc.screen * 2.0 - 1.0, 0.0, 1.0);
	v_local = local;
}
