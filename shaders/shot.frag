// ── body group: SHOTS (bullet slots BULLET_LO..TURRET_LO) ──────────────────────
// Plasma bolts with their trails, settled mines, and the detonation flash of dying
// shells (VAR_BOOM — the shockwave itself is the composite's distortion).

void bullet(vec2 p, Body b) {
	if (b.variant == VAR_MINE) {
		// ── proximity mine: a squat armored puck. The blinker quickens once armed —
		// a live warhead everyone should respect (it kicks the car too).
		float rr = length(p);
		lay(vec3(0.015), 0.5 * soft(rr - 11.0));               // seat shadow
		lay(PAL_MID * 0.85, soft(rr - 8.0));                    // the puck
		lay(BOT_LINE * 2.0, soft(abs(rr - 5.5) - 1.1));         // armor ring
		float armed = step(0.7, b.hp - b.life);
		float blink = step(0.5, fract(pc.time * mix(0.8, 2.6, armed) + hash1(v_id)));
		add += PAL_ACCENT * 1.4 * blink * soft(rr - 2.2);       // the fuse light
		return;
	}
	// JUICY PLASMA ORB: a squishy living ball — the rim wobbles with two rolling
	// harmonics and the molten core breathes inside it. Behind it, the trail it has
	// actually LEFT: length = distance flown (hp packs total flight time), a dark
	// cooling ember body with a hot line down its core and ripples travelling back
	// down it. All crisp BASE color; the bloom pass gets only a whisper.
	float t = pc.time * 8.0 + float(v_id) * 1.7;
	vec2 q = p - vec2(2.0, 0.0);
	float r = length(q);
	float ang = atan(q.y, q.x);
	float wob = 1.0 + 0.15 * sin(ang * 3.0 + t) + 0.09 * sin(ang * 5.0 - t * 1.3); // living rim
	float d = r - 6.8 * wob;
	float tlen = clamp((b.hp - b.life) * BULLET_SPEED - 4.0, 12.0, 204.0); // what it has flown
	float x2 = clamp(p.x, -tlen, -2.0);
	float tt = (-2.0 - x2) / tlen; // 0 at the orb → 1 at the tail tip
	float tw = mix(5.6, 0.7, tt) * (1.0 + 0.20 * sin(tt * 16.0 + t * 2.2)); // ripples run back down it
	float td = length(p - vec2(x2, 0.0)) - tw;
	lay(mix(vec3(0.95, 0.34, 0.08), vec3(0.24, 0.04, 0.02), smoothstep(0.0, 0.8, tt)), soft(td) * (1.0 - tt * tt));
	lay(mix(vec3(1.40, 0.85, 0.35), vec3(0.70, 0.16, 0.04), tt), soft(td + tw * 0.55) * (1.0 - tt)); // hot core line
	add += PAL_EMBER * exp(-td * td / 40.0) * 0.12 * (1.0 - tt); // whisper of heat down the trail
	lay(vec3(0.02), soft(d - 2.4));            // ink rim seats it on any ground
	lay(vec3(1.22, 0.46, 0.11), soft(d));      // hot shell, wobbling
	lay(vec3(1.55, 1.48, 1.30), soft(r - 3.9 * (1.0 + 0.14 * sin(t * 2.3)) * wob)); // breathing core
	add += vec3(1.10, 0.80, 0.50) * exp(-r * r / 42.0) * 0.18; // the merest halo
}

void main() {
	Body b = BODIES[v_id];
	if (b.kind == KIND_DEAD) { discard; }
	body_paint();
	vec2 p = v_local;
	if      (b.kind == KIND_BULLET) { bullet(p, b); }
	else if (b.kind == KIND_DYING && (b.variant == VAR_BOOM || b.variant == VAR_SPARK)) { burst(p, b); }
	body_finish(p, b);
}
