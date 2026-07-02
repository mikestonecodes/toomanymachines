#version 460
#include "common.glsl"

// Every body as a procedural SDF sprite in its own body frame (+x = facing): the truck
// with its turret/flash/thrusters, three bot variants, bullet tracers, death bursts.
// Output is premultiplied; `add` is pure emissive (HDR > 1) that feeds the bloom pass.

// Vertex → fragment interface (must match body.vert's `out`s).
layout(location = 0) in vec2      v_local;
layout(location = 1) in flat uint v_id;
layout(location = 0) out vec4 o_color;

// painter state: alpha-composited base + emissive add
vec3  base = vec3(0.0);
float cov  = 0.0;
vec3  add  = vec3(0.0);

void lay(vec3 c, float a) {
	a = clamp(a, 0.0, 1.0);
	base = mix(base, c, a);
	cov = max(cov, a);
}

float soft(float d) { return 1.0 - smoothstep(-1.2, 1.2, d); } // sdf → coverage

// n leg pairs anchored on the body rim, feet striding with the gait phase `t`.
void legs(vec2 p, float r, float n, float t, float w, vec3 c) {
	for (float i = 0.0; i < n; i += 1.0) {
		for (float s = -1.0; s <= 1.0; s += 2.0) {
			float aa = s * (0.55 + i * (2.1 / n));
			float g = sin(t + i * 1.9 + s * 0.7);
			vec2 root = rot2(aa) * vec2(r * 0.55, 0.0);
			vec2 foot = rot2(aa + g * 0.22) * vec2(r * 1.95, 0.0);
			foot.x += g * r * 0.3; // stride along the facing
			lay(c * (0.8 + 0.2 * sin(i * 2.1)), soft(sd_seg(p, root, foot) - w));
			lay(c * 1.7, soft(length(p - foot) - w * 1.15)); // foot tip
		}
	}
}

void truck(vec2 p, Body b) {
	vec2 L = rot2(-b.angle) * normalize(vec2(-0.6, -0.8)); // screen light → body frame
	// wheels, slightly proud of the hull
	for (float sx = -1.0; sx <= 1.0; sx += 2.0) {
		for (float sy = -1.0; sy <= 1.0; sy += 2.0) {
			lay(PAL_BASE * 0.7, soft(sd_box(p - vec2(sx * 13.5, sy * 12.5), vec2(6.5, 3.2)) - 2.0));
		}
	}
	// hull: long rounded slab, beveled edges catching the light
	float hull = sd_box(p, vec2(23.0, 11.0)) - 4.0;
	float rim = clamp(dot(normalize(p + 0.0001), L), 0.0, 1.0);
	vec3 mc = PAL_MID * (0.55 + 0.18 * sin(p.x * 0.9));
	mc = mix(mc, PAL_MID * (0.9 + rim * 1.2), smoothstep(-5.0, 0.0, hull));
	lay(mc, soft(hull));
	// panel seams
	float seamx = min(abs(p.x - 4.0), abs(p.x + 12.0));
	lay(PAL_BASE * 0.85, soft(hull) * smoothstep(1.2, 0.4, seamx) * 0.6);
	// cab + windshield up front
	lay(PAL_MID * 0.8, soft(sd_box(p - vec2(11.0, 0.0), vec2(7.0, 8.6)) - 2.5));
	float glass = sd_box(p - vec2(13.5, 0.0), vec2(3.4, 7.2)) - 2.0;
	lay(vec3(0.02, 0.025, 0.04), soft(glass));
	add += vec3(0.10, 0.12, 0.16) * soft(glass) * pow(clamp(dot(normalize(p - vec2(13.5, 0.0) + 0.0001), L), 0.0, 1.0), 3.0);
	// amber running strips along the bed sides + tail lights
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += PAL_EMBER * 1.3 * soft(sd_box(p - vec2(-8.0, s * 10.2), vec2(11.0, 0.9)));
		add += PAL_ACCENT * 1.6 * soft(sd_box(p - vec2(-25.5, s * 8.0), vec2(1.2, 2.2)));
	}
	// headlights + short cones
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		vec2 hl = vec2(22.5, s * 6.5);
		add += vec3(1.0, 0.85, 0.6) * 2.4 * soft(length(p - hl) - 1.8);
		vec2 q = p - hl;
		float cone = smoothstep(0.45, 0.1, abs(atan(q.y, q.x))) * smoothstep(58.0, 4.0, q.x) * step(0.0, q.x);
		add += vec3(1.0, 0.8, 0.5) * cone * 0.14;
	}
	// rear thrusters glow with the throttle
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		float g2 = soft(length(p - vec2(-24.0, s * 6.0)) - 2.6);
		add += PAL_EMBER * g2 * (0.35 + pc.throttle * (2.2 + 0.6 * sin(pc.time * 43.0 + s)));
	}
	// turret: mount + barrel toward the mouse, with recoil + muzzle flash
	float ta = atan(pc.aim.y - b.pos.y, pc.aim.x - b.pos.x) - b.angle;
	vec2 td = vec2(cos(ta), sin(ta));
	vec2 tm = vec2(-2.0, 0.0);
	float blen = 21.0 - pc.muzzle * 4.5; // recoil
	lay(PAL_MID * 1.15, soft(sd_seg(p, tm, tm + td * blen) - 2.2));
	lay(PAL_MID * 0.5, soft(length(p - tm) - 6.2));
	lay(PAL_MID * 1.35, soft(length(p - tm) - 4.0));
	if (pc.muzzle > 0.02) { // hot star at the tip
		vec2 tip = tm + td * (blen + 3.0);
		float md = length(p - tip);
		float star = 1.0 + 0.5 * cos(atan(p.y - tip.y, p.x - tip.x) * 6.0 + pc.time * 90.0);
		float fl = exp(-md * md / (9.0 * star * pc.muzzle + 3.0)) * pc.muzzle;
		add += (PAL_EMBER * 2.2 + vec3(1.2)) * fl * 2.0;
	}
}

void spider(vec2 p, Body b, float t) {
	// A MACHINE that walks like a spider, not a spider: two-segment strut legs with
	// servo knees on a chamfered chassis plate, one hard red sensor visor up front.
	float r = b.radius;
	float gt = t * (4.0 + length(b.vel) * 0.045);
	for (float i = 0.0; i < 4.0; i += 1.0) {
		for (float s = -1.0; s <= 1.0; s += 2.0) {
			float aa = s * (0.6 + i * 0.55);
			float ph = gt + i * 1.57 + s * 0.5;
			float stp = sign(sin(ph)) * pow(abs(sin(ph)), 0.6); // snappy piston stride
			vec2 root = rot2(aa) * vec2(r * 0.5, 0.0);
			vec2 foot = rot2(aa + stp * 0.18) * vec2(r * 2.0, 0.0);
			foot.x += stp * r * 0.28;
			vec2 dirL = normalize(foot - root + 0.0001);
			vec2 knee = mix(root, foot, 0.5) + vec2(-dirL.y, dirL.x) * s * r * 0.38; // elbow juts outward
			lay(PAL_MID * 0.55, soft(sd_seg(p, root, knee) - 1.5)); // upper strut
			lay(PAL_MID * 0.78, soft(sd_seg(p, knee, foot) - 1.0)); // lower strut
			lay(PAL_MID * 1.15, soft(length(p - knee) - 2.0));      // knee servo
		}
	}
	vec2 L = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	float sh = clamp(dot(normalize(p + 0.0001), L), 0.0, 1.0);
	// chamfered chassis plate + inset top deck with a center seam and corner bolts
	lay(PAL_MID * (0.45 + 0.25 * sh), soft(sd_box(p, vec2(r * 0.72, r * 0.55)) - r * 0.12));
	float deck = sd_box(p - vec2(-r * 0.08, 0.0), vec2(r * 0.42, r * 0.34)) - r * 0.08;
	lay(PAL_MID * (0.62 + 0.30 * sh), soft(deck));
	lay(PAL_BASE * 0.9, soft(deck) * smoothstep(1.0, 0.3, abs(p.y)) * 0.5);
	for (float sx = -1.0; sx <= 1.0; sx += 2.0) {
		for (float sy = -1.0; sy <= 1.0; sy += 2.0) {
			lay(PAL_MID * 1.3, soft(length(p - vec2(sx * r * 0.5, sy * r * 0.38)) - r * 0.06));
		}
	}
	// front sensor visor: a single hard glowing bar
	add += PAL_ACCENT * 2.4 * soft(sd_box(p - vec2(r * 0.62, 0.0), vec2(r * 0.07, r * 0.30)));
	add += PAL_ACCENT * 0.22 * exp(-length(p - vec2(r * 0.62, 0.0)) / (r * 0.6));
}

void skitter(vec2 p, Body b, float t) {
	float r = b.radius;
	legs(p, r, 3.0, t * 14.0, 1.1, PAL_MID * 0.5);
	// dart body: squashed ellipse
	lay(PAL_MID * 0.6, soft(length(p * vec2(0.75, 1.8)) - r));
	add += PAL_ACCENT * 2.2 * soft(length(p - vec2(r * 0.9, 0.0)) - r * 0.16); // single eye
	// hot trail behind when lunging
	float tr = soft(sd_seg(p, vec2(-r, 0.0), vec2(-r * 2.2, 0.0)) - r * 0.25);
	add += PAL_ACCENT * tr * length(b.vel) * 0.004;
}

void brute(vec2 p, Body b, float t) {
	float r = b.radius;
	legs(p, r, 3.0, t * 5.0, 3.0, PAL_MID * 0.45);
	float ang = atan(p.y, p.x);
	vec2 L = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	float sh = clamp(dot(normalize(p + 0.0001), L), 0.0, 1.0);
	// hex-ish armored shell with a groove ring
	float hex = length(p) * (1.0 + 0.08 * cos(ang * 6.0)) - r * 0.92;
	lay(PAL_MID * (0.40 + 0.28 * sh) * (0.85 + 0.15 * sin(ang * 6.0 + 0.5)), soft(hex));
	lay(PAL_MID * 0.30, soft(abs(length(p) - r * 0.62) - r * 0.05));
	// molten core
	float pulse = 0.75 + 0.25 * sin(pc.time * 3.0 + float(v_id));
	add += PAL_ACCENT * 2.8 * pulse * soft(length(p) - r * 0.34);
	add += PAL_ACCENT * 0.5 * pulse * exp(-length(p) / (r * 0.55));
}

void bullet(vec2 p) {
	// razor bolt: a thin hard line of light, no blob
	float d = sd_seg(p, vec2(7.0, 0.0), vec2(-13.0, 0.0));
	add += vec3(1.2, 1.05, 0.8) * 1.5 * exp(-d * d / 2.0); // core — kept just past the bloom knee so it stays a LINE
	add += PAL_EMBER * 0.35 * exp(-d * d / 22.0);          // slim halo
}

void burst(vec2 p, Body b) {
	// Mechanical breakup — no fireballs, no shockwave rings: the bot flies apart into
	// tumbling scrap shards with cooling ember edges, over a brief hot pinpoint.
	float total = b.variant == VAR_SPARK ? SPARK_T : DEATH_T;
	float prog = 1.0 - clamp(b.life / total, 0.0, 1.0);
	float fade = 1.0 - prog;
	uint s = v_id * 977u;
	if (b.variant == VAR_SPARK) { // bullet impact: pinpoint glint + a few spark streaks
		add += vec3(1.1, 0.95, 0.7) * exp(-dot(p, p) / 9.0) * fade * 1.6;
		for (float i = 0.0; i < 3.0; i += 1.0) {
			uint si = s + uint(i);
			vec2 q = rot2(hash1(si) * TAU) * p;
			float dst = 3.0 + prog * (10.0 + hash1(si + 7u) * 12.0);
			add += PAL_EMBER * 1.2 * exp(-sd_seg(q, vec2(dst - 3.0, 0.0), vec2(dst, 0.0)) * 2.0) * fade;
		}
		return;
	}
	float n = b.variant == VAR_BRUTE ? 9.0 : 6.0;
	float spread = b.variant == VAR_BRUTE ? 95.0 : 60.0;
	for (float i = 0.0; i < n; i += 1.0) {
		uint si = s + uint(i) * 13u;
		float a = (i + hash1(si)) * (TAU / n);
		float dst = (0.25 + 0.75 * hash1(si + 1u)) * prog * spread + b.radius * 0.3;
		vec2 c = rot2(a) * vec2(dst, 0.0);
		float spin = a * 3.0 + prog * (2.0 + hash1(si + 2u) * 6.0);
		vec2 q = rot2(-spin) * (p - c);
		float m = soft(sd_box(q, vec2(2.0 + hash1(si + 3u) * 3.0, 1.2)));
		lay(PAL_MID * 0.5, m * fade);                                 // the metal chunk
		add += PAL_EMBER * m * fade * fade * (0.5 + hash1(si + 4u)); // its cooling glow
	}
	add += vec3(1.15, 1.0, 0.8) * exp(-dot(p, p) / (b.radius * b.radius * 1.2)) * exp(-prog * 12.0) * 2.2; // brief pop
	lay(vec3(0.028, 0.025, 0.03), 0.35 * fade * exp(-dot(p, p) / (spread * spread * 0.4 * (0.2 + prog)))); // smoke wisp
}

void main() {
	Body b = BODIES[v_id];
	if (b.kind == KIND_DEAD) { discard; }
	vec2 p = v_local;
	float t = pc.time + hash1(v_id * 7919u) * TAU;
	if      (b.kind == KIND_PLAYER) { truck(p, b); }
	else if (b.kind == KIND_BULLET) { bullet(p); }
	else if (b.kind == KIND_DYING)  { burst(p, b); }
	else {
		if      (b.variant == VAR_SPIDER)  { spider(p, b, t); }
		else if (b.variant == VAR_SKITTER) { skitter(p, b, t); }
		else                               { brute(p, b, t); }
		if (b.life > 0.0) { base = mix(base, vec3(1.4, 1.3, 1.2), b.life * 0.85); } // hit/spawn flash
	}
	o_color = vec4(base * cov + add, cov); // premultiplied; `add` is pure emissive
}
