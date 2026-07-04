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
	if (b.kind == KIND_ALLY && b.gen != 0u
	    && b.variant != VAR_SUICIDE && b.variant != VAR_BOMBER) {
		// an ally pouring fire: the quad must reach its locked target so the tracer +
		// impact can draw (target slot in gen, same state physics chews enemies with)
		ext = distance(b.pos, BODIES[b.gen - 1u].pos) + 90.0;
	}
	if (b.kind == KIND_PLAYER) { // any garage ride + its flash; the laser needs the whole reach
		ext = pc.laser > 0.02 ? LASER_LEN * laser_k() + 160.0 : max(120.0, b.radius * 3.2);
	}
	else if (b.kind == KIND_BULLET) { // the plasma orb + the trail it has LEFT behind so far
		ext = clamp((b.hp - b.life) * BULLET_SPEED + 24.0, 36.0, 224.0);
	}
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
	else if (b.kind == KIND_HELPER) {
		// only a FETCHING drone needs quad room for its hoist beam; the other 200+
		// idle escorts get tight quads (240 fat overlapping quads = fill-rate death)
		ext = (b.gen != 0u && b.gen != 0x80000000u) ? 190.0 : 66.0;
	}
	else if (b.kind == KIND_WRECK) { ext = b.radius * (b.variant == 1u ? 3.4 : 2.4); } // hoisted husks draw larger
	else if (b.kind == KIND_DYING) {
		float total = b.variant == VAR_SPARK ? SPARK_T : (b.variant == VAR_BOOM ? BOOM_T : DEATH_T);
		float prog = 1.0 - clamp(b.life / total, 0.0, 1.0);
		// dying mechs still draw their whole body + legs (briefly puffed up), + embers;
		// the pit swallow needs room for its splash arcs + the furnace belch
		ext = b.variant == VAR_SPARK ? b.radius + 10.0 + 115.0 * prog : b.radius * 3.0 + 60.0 * prog;
		if (b.variant == VAR_BOOM) { ext = 60.0 + b.radius; } // the brief impact flash (bigger for dying towers/bombers)
		if (b.variant == VAR_BRUTE) { ext *= 1.5; }
	}
	vec2 local = CORNERS[gl_VertexIndex] * ext;
	vec2 world = b.pos + rot2(b.angle) * local;
	vec2 px = (world - pc.cam) / ZOOM + pc.screen * 0.5;
	// Vulkan clip space is Y-down, so no flip: px.y=0 (top pixel) → ndc.y=-1 (top).
	gl_Position = vec4(px / pc.screen * 2.0 - 1.0, 0.0, 1.0);
	v_local = local;
}
