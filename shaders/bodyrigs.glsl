#ifndef BODYRIGS_GLSL
#define BODYRIGS_GLSL
#include "bodyfx.glsl"

// ── the WAR RIGS: tracked/wheeled/walking gun platforms ─────────────────────────
// YOUR army's five classes (crew.frag) — and the same chassis double as garage rides,
// aimed by the mouse instead of a target lock (ship() in ship.frag).

void tank(vec2 p, Body b, float t, vec2 aimd, float shoot) {
	// Tracked tank: rolling treads under a heavy casemate, a long cannon down `aimd`
	// (allies face their locked target so it's +x; the PLAYER's turret tracks the
	// mouse). `shoot` > 0 = an ally pouring fire: draw the fire_slug shell + impact
	// out to that reach — the identical slug physics chews enemies with.
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = max(r * 0.20, 2.8);
	lay(vec3(0.015), 0.38 * soft(sd_box(p - vec2(3.0, 5.0), vec2(r * 1.05, r * 0.85)) - r * 0.1));
	// treads roll with TRAVEL (odometer / k = px covered), never re-scale with speed;
	// the player's TANK ride carries the true CPU odometer in b.life
	float kg = min(5.0 / r, 0.22);
	float odo = (b.kind == KIND_PLAYER && b.variant == RIDE_TANK ? b.life : gait_ph(b)) / kg;
	float roll = odo * 0.14;
	for (float s = -1.0; s <= 1.0; s += 2.0) { // treads with running track links
		vec2 tp = p - vec2(0.0, s * r * 0.68);
		float tdd = sd_box(tp, vec2(r * 1.0, r * 0.24)) - r * 0.06;
		lay(BOT_LINE * 1.6, soft(tdd));
		lay(BOT_LINE * 3.0, soft(tdd + r * 0.12) * (0.45 + 0.55 * step(0.5, fract(tp.x / 9.0 - roll))));
	}
	plate(p, vec2(0.0), sd_box(p, vec2(r * 0.85, r * 0.5)) - r * 0.10, gPlateA, 1.0); // casemate
	plate(p, vec2(-r * 0.5, 0.0), sd_box(p - vec2(-r * 0.5, 0.0), vec2(r * 0.22, r * 0.38)) - r * 0.05, gPlateB * 0.8, 2.0); // engine deck
	lay(gMark, soft(sd_box(p - vec2(-r * 0.12, 0.0), vec2(r * 0.045, r * 0.42))) * 0.8); // unit band
	plate(p, vec2(r * 0.1, 0.0), length(p - vec2(r * 0.1, 0.0)) - r * 0.40, gPlateB, 3.0);  // turret drum
	vec2 sl = fire_slug(v_id, TANK_RATE, TANK_MV);
	float rec = shoot > 0.0 ? exp(-sl.y * 12.0) * r * 0.14 : 0.0; // recoil right off the shot
	vec2 hub = vec2(r * 0.1, 0.0);
	lay(BOT_LINE * 2.4, soft(sd_seg(p, hub, hub + aimd * (r * 1.55 - rec)) - r * 0.085));
	lay(BOT_LINE * 3.5, soft(sd_seg(p, hub + aimd * (r * 1.25 - rec), hub + aimd * (r * 1.55 - rec)) - r * 0.12)); // muzzle brake
	float beat = 0.7 + 0.5 * sin(pc.time * 2.4 + float(v_id) * 0.7);
	add += gEye * 1.1 * beat * soft(length(p - hub - aimd * r * 0.3) - r * 0.09); // gunsight eye
	if (shoot > 0.0) {
		float mz = exp(-sl.y * 9.0); // the shot just left: a hard flash off the brake
		vec2 muz = hub + aimd * r * 1.65;
		add += (PAL_EMBER * 2.2 + vec3(0.9)) * exp(-dot(p - muz, p - muz) / (60.0 * mz + 4.0)) * mz * 2.0;
		if (sl.x < shoot) { // the slug in flight down the gun line, dragging a hot wake
			vec2 sp2 = muz + aimd * sl.x;
			add += vec3(1.45, 1.1, 0.7) * exp(-dot(p - sp2, p - sp2) / 16.0) * 2.4;
			float wk = sd_seg(p, sp2 - aimd * min(sl.x, 90.0), sp2);
			add += PAL_EMBER * exp(-wk * wk / 14.0) * 0.5;
		} else if (sl.x - shoot < 120.0) { // ARRIVAL: sparks burst off the target
			vec2 hit = muz + aimd * shoot;
			add += (PAL_EMBER * 1.6 + vec3(0.5)) * exp(-dot(p - hit, p - hit) / 240.0) * exp(-(sl.x - shoot) * 0.03) * 1.6;
		}
	}
	battle_damage(p, b, HP_TANK);
}

void raider(vec2 p, Body b, float t, vec2 aimd, float shoot) {
	// Gun-car: a fast wheeled technical, pintle gun slung down `aimd` — as an ally it
	// circles its locked prey pouring a stream out to `shoot` reach; as the player's
	// BUGGY the gun just tracks the mouse (LMB fires the real shells).
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = max(r * 0.24, 2.6);
	lay(vec3(0.015), 0.32 * soft(sd_box(p - vec2(2.0, 4.0), vec2(r * 1.0, r * 0.7)) - r * 0.1));
	for (float sx = -1.0; sx <= 1.0; sx += 2.0) { // four proud wheels
		for (float sy = -1.0; sy <= 1.0; sy += 2.0) {
			lay(BOT_LINE * 1.8, soft(sd_box(p - vec2(sx * r * 0.62, sy * r * 0.58), vec2(r * 0.26, r * 0.14)) - r * 0.05));
		}
	}
	plate(p, vec2(0.0), sd_box(p, vec2(r * 0.92, r * 0.44)) - r * 0.14, gPlateB, 1.0); // hull wedge
	plate(p, vec2(r * 0.45, 0.0), sd_box(p - vec2(r * 0.48, 0.0), vec2(r * 0.28, r * 0.32)) - r * 0.08, gPlateA, 2.0); // cab
	lay(gMark, soft(sd_box(rot2(0.5) * (p - vec2(-r * 0.3, 0.0)), vec2(r * 0.30, r * 0.05))) * 0.85); // slash marking
	vec2 mnt = vec2(-r * 0.25, 0.0); // the pintle gun on a rear ring
	lay(BOT_LINE * 2.6, soft(sd_seg(p, mnt, mnt + aimd * r * 0.85) - r * 0.06));
	float beat = 0.7 + 0.5 * sin(pc.time * 3.8 + float(v_id) * 0.9);
	add += gEye * 1.2 * beat * soft(length(p - vec2(r * 0.72, 0.0)) - r * 0.10); // the eye
	if (shoot > 0.0) { // the stream: rounds flowing OUT down the gun line
		float alongp = dot(p - mnt, aimd);
		float perp = dot(p - mnt, vec2(-aimd.y, aimd.x));
		if (alongp > r * 0.9 && alongp < shoot) {
			float cycR = fract(alongp / 38.0 - pc.time * 34.0);
			float slug2 = exp(-pow((cycR - 0.5) * 6.0, 2.0));
			add += vec3(1.4, 1.05, 0.65) * slug2 * exp(-perp * perp / 3.0) * 1.8;
		}
		vec2 muz = mnt + aimd * r * 0.95;
		add += (PAL_EMBER * 1.8 + vec3(0.7)) * exp(-dot(p - muz, p - muz) / 9.0) * (0.6 + 0.4 * sin(pc.time * 91.0 + float(v_id)));
	}
	battle_damage(p, b, HP_RAIDER);
}

void suicide(vec2 p, Body b, float t, float arm) {
	// SUICIDE DRONE: a flying rotor bomb. Its whole light budget is the warhead — the
	// core pulses harder and FASTER as it closes on its prey (`arm` ramps 0→1): a
	// live-warhead light, so it's allowed to blink. Airborne: drawn a touch large,
	// its shadow adrift on the ground below.
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = 2.6;
	lay(vec3(0.012), 0.35 * soft(length(p - vec2(6.0, 14.0)) - r * 0.9)); // shadow far below
	p *= 0.80; // altitude: nearer the camera
	p.y -= sin(pc.time * 4.1 + float(v_id)) * 0.5;
	for (float s = -1.0; s <= 1.0; s += 2.0) { // rotor pods — a dark whisper of shimmer,
		// NO white glow: a swarm of these in bloom turns the field into milk
		vec2 rp = vec2(-r * 0.2, s * r * 0.75);
		lay(BOT_LINE * 2.0, soft(length(p - rp) - r * 0.34));
		lay(vec3(0.22, 0.23, 0.25), soft(length(p - rp) - r * 0.30) * (0.30 + 0.25 * sin(pc.time * 53.0 + s + float(v_id))));
	}
	plate(p, vec2(0.0), sd_box(p, vec2(r * 0.62, r * 0.40)) - r * 0.14, gPlateB * 0.9, 1.0); // shell
	plate(p, vec2(r * 0.4, 0.0), length(p - vec2(r * 0.4, 0.0)) - r * 0.26, BOT_LINE * 2.5, 2.0); // nose cap
	float beat = 0.55 + 0.45 * sin(pc.time * mix(3.0, 18.0, arm) + float(v_id));
	add += gEye * (0.9 + 1.8 * arm) * beat * soft(length(p) - r * 0.30); // the WARHEAD
	battle_damage(p, b, HP_SUICIDE);
}

void gunner(vec2 p, Body b, float t, vec2 aimd, float shoot) {
	// Rifle mech: a narrow spider chassis shouldering a LONG autogun down `aimd`; with
	// a lock (`shoot` > 0, allies) it hoses a stream of rounds out to that reach.
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = max(r * 0.26, 2.8);
	lay(vec3(0.015), 0.33 * soft(length(p - vec2(3.0, 5.0)) - r * 0.9));
	// travel-driven stride; the player's GUNMECH ride carries the CPU odometer in b.life
	float gt2 = b.kind == KIND_PLAYER ? b.life : gait_ph(b);
	float wUp = r * 0.18, wLo = r * 0.07;
	mech_leg(p, r,  0.90, gt2,           wUp, wLo);
	mech_leg(p, r, -0.90, gt2 + 3.14159, wUp, wLo);
	mech_leg(p, r,  2.30, gt2 + 3.14159, wUp, wLo);
	mech_leg(p, r, -2.30, gt2,           wUp, wLo);
	plate(p, vec2(0.0), sd_box(p, vec2(r * 0.70, r * 0.44)) - r * 0.12, gPlateA, 1.0);
	lay(gMark, soft(sd_box(p - vec2(-r * 0.2, 0.0), vec2(r * 0.05, r * 0.34))) * 0.8); // unit band
	lay(BOT_LINE * 2.6, soft(sd_seg(p, vec2(0.0), aimd * r * 1.45) - r * 0.07)); // the autogun
	float beat = 0.7 + 0.5 * sin(pc.time * 3.1 + float(v_id) * 0.8);
	add += gEye * 1.1 * beat * soft(length(p - vec2(r * 0.55, 0.0)) - r * 0.10); // eye
	if (shoot > 0.0) { // the stream of rounds flowing OUT down the gun line
		float alongp = dot(p, aimd);
		float perp = dot(p, vec2(-aimd.y, aimd.x));
		if (alongp > r * 1.45 && alongp < shoot) {
			float cycR = fract(alongp / 42.0 - pc.time * 30.0);
			float slug2 = exp(-pow((cycR - 0.5) * 6.0, 2.0));
			add += vec3(1.35, 1.0, 0.6) * slug2 * exp(-perp * perp / 2.5) * 1.8;
		}
		vec2 muz = aimd * r * 1.5;
		add += (PAL_EMBER * 1.6 + vec3(0.6)) * exp(-dot(p - muz, p - muz) / 10.0) * (0.6 + 0.4 * sin(pc.time * 87.0 + float(v_id)));
	}
	battle_damage(p, b, HP_GUNNER);
}

void bomber(vec2 p, Body b, float t) {
	// BOMBER: a big dark delta flying HIGH over everything (drawn large = near the
	// camera; its shadow runs the ground far below). Yours patrol from the center and
	// come down WITH the one heavy bomb — the belly load is the glowing tell.
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = max(r * 0.2, 3.0);
	lay(vec3(0.010), 0.30 * soft(sd_box(p - vec2(8.0, 26.0), vec2(r * 1.0, r * 0.6)) - r * 0.2)); // shadow far adrift
	p *= 0.62; // altitude: the biggest thing in the sky
	// delta wing: two swept panels meeting at the nose + a spine fuselage
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		vec2 q = rot2(s * 0.62) * (p - vec2(-r * 0.15, s * r * 0.42));
		plate(p, vec2(-r * 0.2, s * r * 0.45), sd_box(q, vec2(r * 0.78, r * 0.16)) - r * 0.05, gPlateB * 0.85, s + 3.0);
	}
	plate(p, vec2(0.0), sd_box(p, vec2(r * 0.85, r * 0.20)) - r * 0.10, gPlateA * 0.9, 1.0); // fuselage
	lay(gMark, soft(sd_box(p - vec2(r * 0.3, 0.0), vec2(r * 0.16, r * 0.045))) * 0.85);        // nose marking
	for (float s = -1.0; s <= 1.0; s += 2.0) { // twin engines, hot
		add += PAL_EMBER * 0.9 * soft(length(p - vec2(-r * 0.75, s * r * 0.30)) - r * 0.09) * (0.7 + 0.3 * sin(pc.time * 37.0 + s));
	}
	// the BOMB slung under the belly — the warhead band pulses: it's live
	lay(BOT_LINE * 3.0, soft(sd_box(p - vec2(-r * 0.05, 0.0), vec2(r * 0.22, r * 0.10)) - r * 0.05));
	float beat = 0.6 + 0.4 * sin(pc.time * 5.0 + float(v_id));
	add += gEye * 1.3 * beat * soft(sd_box(p - vec2(-r * 0.05, 0.0), vec2(r * 0.05, r * 0.08)));
	battle_damage(p, b, HP_BOMBER);
}

#endif // BODYRIGS_GLSL
