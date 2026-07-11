// ── body group: the SHIP (instance 0, drawn last, over the crowd) ──────────────
// The player's current garage ride — ship() dispatches the ride variant across the
// same war-rig chassis the army wears (bodyrigs.glsl) plus the player-only walkers
// and the sport wedge below, with the giant laser and every mounted weapon's beam
// geometry. The heaviest single sprite in the game, compiling alone in parallel
// with the other groups.

void player_mech(vec2 p, Body b) {
	// ── the player's walkers (rides 7+8): HUGE mechs in the player's unmissable gloss
	// clean STAINLESS — NO red anywhere (red is the damage language); the light budget is the
	// player's amber + its own deck lights. Twin shoulder guns track the mouse and pound
	// out the shells. Everything parameterizes on radius, so the COLOSSUS (r≈66) is
	// simply TITANIC — and past r>52 it gains a third leg pair + a burning reactor crown.
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = 4.5;
	lay(vec3(0.012, 0.010, 0.010), 0.5 * soft(length(p - vec2(6.0, 10.0)) - r * 1.15)); // ground shadow
	// heavy legs on the CPU-integrated gait odometer (b.life): feet PLANT while the hull
	// advances, freeze at a standstill — a metachronal wave ripples front→back down each
	// side, the sides half a cycle apart
	float gt = b.life;
	float wUp = r * 0.20, wLo = r * 0.075;
	mech_leg(p, r,  0.80, gt,                    wUp, wLo);
	mech_leg(p, r, -0.80, gt + 3.14159,          wUp, wLo);
	mech_leg(p, r,  2.35, gt + 2.09,             wUp, wLo);
	mech_leg(p, r, -2.35, gt + 3.14159 + 2.09,   wUp, wLo);
	if (r > 52.0) { // the COLOSSUS walks on SIX — the mid pair completes the wave
		mech_leg(p, r,  1.57, gt + 4.19,           wUp, wLo);
		mech_leg(p, r, -1.57, gt + 3.14159 + 4.19, wUp, wLo);
	}
	// the hull WALKS: weight rocks onto each planted side and surges with the stride
	p += vec2(cos(gt * 2.0) * r * 0.020, sin(gt) * r * 0.045);
	// torso: broad deck + chest glacis + engine block — clean faceted stainless, cel-shaded
	plate(p, vec2(0.0), sd_box(p, vec2(r * 0.72, r * 0.55)) - r * 0.14, RIG_STEEL, 1.0);
	plate(p, vec2(r * 0.5, 0.0), sd_box(p - vec2(r * 0.5, 0.0), vec2(r * 0.24, r * 0.40)) - r * 0.08, RIG_STEEL * 0.55, 2.0);
	plate(p, vec2(-r * 0.55, 0.0), sd_box(p - vec2(-r * 0.55, 0.0), vec2(r * 0.18, r * 0.34)) - r * 0.06, RIG_STEEL * 0.40, 3.0);
	// cockpit slit, glowing faint warm — the pilot's window
	float glass = sd_box(p - vec2(r * 0.62, 0.0), vec2(r * 0.07, r * 0.22)) - r * 0.03;
	lay(vec3(0.020, 0.021, 0.024), soft(glass));
	add += vec3(0.12, 0.38, 0.14) * soft(glass) * 0.8; // the cabin glows team green
	// LIGHTS: amber running strips down the flanks, a row of deck marker lamps, big
	// headlamps at the chest (the long beam on the ground lives in city.frag, same as
	// the truck) — the rig reads as ITS OWN light source in the dark
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += RIG_GRN * 1.25 * soft(sd_box(p - vec2(-r * 0.15, s * r * 0.50), vec2(r * 0.34, 1.4)));
		add += vec3(1.0, 0.90, 0.70) * 1.8 * soft(length(p - vec2(r * 0.78, s * r * 0.26)) - 3.2);
		for (float i = -1.0; i <= 1.0; i += 1.0) { // steady deck markers along the shoulders
			add += RIG_GRN * 1.1 * soft(length(p - vec2(i * r * 0.30, s * r * 0.60)) - r * 0.035);
		}
	}
	// engine vents aft, breathing with the throttle
	float th = pc.throttle * 0.8 + pc.boost * 1.6;
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += PAL_EMBER * soft(length(p - vec2(-r * 0.70, s * r * 0.20)) - r * 0.07) * (0.04 + th * (1.6 + 0.5 * sin(pc.time * 43.0 + s))); // heat only — no idle yellow
	}
	if (r > 52.0) { // the reactor crown, burning amber over the deck
		plate(p, vec2(-r * 0.08, 0.0), length(p - vec2(-r * 0.08, 0.0)) - r * 0.20, RIG_STEEL * 0.9, 11.0);
		add += RIG_GRN * 0.8 * soft(length(p - vec2(-r * 0.08, 0.0)) - r * 0.09) * (0.85 + 0.15 * sin(pc.time * 2.2)); // the reactor burns team green
	}
	// twin SHOULDER guns: the MOUNTS are bolted to the shoulders — fixed in the body
	// frame, they never orbit with the aim; only the barrels slew to the mouse. The
	// hardware is SOLID: it masks the deck lights under it, nothing glows through.
	float ta = atan(pc.aim.y - b.pos.y, pc.aim.x - b.pos.x) - b.angle;
	vec2 td = vec2(cos(ta), sin(ta));
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		vec2 mnt = vec2(-r * 0.04, s * r * 0.50); // the shoulder hardpoint
		float blen = r * 0.95 - pc.muzzle * 5.0;
		float bw = max(2.4, r * 0.05);
		float gcov = max(soft(sd_seg(p, mnt, mnt + td * blen) - bw),
		                 soft(length(p - mnt) - r * 0.18));
		add *= 1.0 - gcov * 0.92; // solid steel over the lights
		lay(BOT_LINE * 2.2, soft(sd_seg(p, mnt, mnt + td * blen) - bw));
		plate(p, mnt, length(p - mnt) - r * 0.18, gPlateB * 1.1, s + 7.0);
		if (pc.muzzle > 0.02) {
			vec2 tip = mnt + td * (blen + 4.0);
			float md = length(p - tip);
			add += (PAL_EMBER * 2.2 + vec3(1.2)) * exp(-md * md / (10.0 * pc.muzzle + 3.0)) * pc.muzzle * 1.6;
		}
	}
}

void sportcar(vec2 p, Body b) {
	// the SPORT: a low drift wedge — wide stance, glass canopy, twin lamps, a hot
	// diffuser strip that flares with the throttle. Drawn in classic px, scaled by chassis.
	float r = b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = 3.0;
	p *= 16.0 / r;
	float lean = clamp(b.life, -1.0, 1.0);
	lay(vec3(0.012, 0.010, 0.010), 0.5 * soft(sd_box(p - vec2(5.0, 8.0), vec2(20.0, 7.0)) - 4.0)); // shadow
	p.y += lean * 1.8; // it rolls hard against the slide
	for (float sx = -1.0; sx <= 1.0; sx += 2.0) { // wide fat tires
		for (float sy = -1.0; sy <= 1.0; sy += 2.0) {
			lay(PAL_BASE * 0.7, soft(sd_box(p - vec2(sx * 11.0, sy * 11.5), vec2(6.0, 3.4)) - 1.6));
		}
	}
	float hull = sd_box(p, vec2(19.0, 8.4)) - 4.0; // low wedge body — clean faceted stainless
	float rim = clamp(dot(normalize(p + 0.0001), gL), 0.0, 1.0);
	vec3 mc = RIG_STEEL * (0.6 + 0.2 * sin(p.x * 0.7));
	mc = mix(mc, RIG_STEEL * (0.9 + rim * 1.3), smoothstep(-4.0, 0.0, hull));
	float brh = 0.65 * vnoise(vec2(p.x * 0.55, p.y * 3.4) + 3.0)   // brushed steel, deep two-octave
	          + 0.35 * vnoise(vec2(p.x * 1.10, p.y * 8.0) + 9.0);  //   grinding streaks
	mc *= 1.0 + (brh - 0.5) * 0.55;
	mc *= 0.93 + 0.11 * vnoise(p * 0.16 + 7.0);
	mc *= 1.0 - smoothstep(0.60, 0.25, vnoise(p * 0.13 + 13.0) + brh * 0.35) * 0.50; // oily grunge
	lay(mc, soft(hull));
	lay(RIG_STEEL * 0.65, soft(sd_box(p - vec2(15.5, 0.0), vec2(4.5, 5.0)) - 2.0)); // nose splitter
	float glass = sd_box(p - vec2(4.0, 0.0), vec2(6.0, 5.6)) - 2.2; // canopy
	lay(vec3(0.020, 0.021, 0.024), soft(glass));
	add += vec3(0.10, 0.105, 0.115) * soft(glass) * pow(clamp(dot(normalize(p - vec2(4.0, 0.0) + 0.0001), gL), 0.0, 1.0), 3.0);
	lay(PAL_BASE * 0.9, soft(sd_box(p - vec2(-16.0, 0.0), vec2(1.0, 9.5)))); // rear wing
	for (float s = -1.0; s <= 1.0; s += 2.0) { // lamps + red tails
		add += vec3(1.0, 0.90, 0.70) * 1.2 * soft(length(p - vec2(19.0, s * 5.0)) - 2.0);
		add += RIG_GRN * 1.6 * soft(sd_box(p - vec2(-18.5, s * 6.0), vec2(0.9, 1.8))); // green tails
	}
	float th = pc.throttle * 0.8 + pc.boost * 1.6; // diffuser strip breathing with throttle
	add += PAL_EMBER * (0.04 + th * 1.4) * soft(sd_box(p - vec2(-18.0, 0.0), vec2(1.0, 4.0))); // heat only
}

void ship(vec2 p, Body b) {
	// ── the giant laser first: it reaches far outside the hull, so the quad is huge
	// while burning — bail to beam-only past the hull's reach. The COLOSSUS (laser_k)
	// burns a beam scaled up in every dimension.
	float lk = laser_k();
	if (pc.laser > 0.02) {
		float ta = atan(pc.aim.y - b.pos.y, pc.aim.x - b.pos.x) - b.angle;
		vec2 td = vec2(cos(ta), sin(ta));
		vec2 a0 = td * (b.radius * 1.2 + 6.0);
		vec2 a1 = td * (b.radius * 1.2 + 6.0 + LASER_LEN * lk);
		float bd = sd_seg(p, a0, a1);
		float flick = 0.85 + 0.30 * sin(pc.time * 61.0 + dot(p, td) * 0.05)
		            + 0.10 * sin(pc.time * 173.0);
		float wCore = 3.0 * lk * pc.laser * flick;
		float wHalo = LASER_W * lk * pc.laser;
		add += (vec3(1.3, 1.0, 0.7) + PAL_EMBER * 0.5) * exp(-bd * bd / (wCore * wCore * 2.0)) * 1.3 * pc.laser;
		add += PAL_ACCENT * exp(-bd * bd / (wHalo * wHalo)) * 0.30 * pc.laser;
		// wide veil MUST reach zero inside the quad — an exp(-d/k) tail never does, and
		// its cutoff at the huge beam quad's edge reads as a giant transparent rectangle
		add += PAL_EMBER * exp(-bd * bd / (wHalo * wHalo * 4.0)) * 0.08 * pc.laser;
		// hot star at the emitter
		float ed = length(p - a0);
		add += (PAL_EMBER * 1.5 + vec3(0.7)) * exp(-ed * ed / (50.0 * lk * pc.laser + 8.0)) * pc.laser;
	}

	// ── the MOUNTED weapons (Z..N), held via pc.pfire — each machine draws its own
	// fire, geometry mirroring physics.comp EXACTLY (pure time+push-constant functions).
	if (pc.pfire > 0.03) {
		float f = pc.pfire;
		float aima = atan(pc.aim.y - b.pos.y, pc.aim.x - b.pos.x) - b.angle;
		vec2 wad = vec2(cos(aima), sin(aima));
		vec2 wap = vec2(-wad.y, wad.x);
		if (pc.pweap == WEAP_SING) {
			// ── the SINGULARITY: a quiet gravity WELL at the cursor, visibly FED from
			// your emitter. A charge filament wavers out of the rig with packets flowing
			// well-ward; at the far end a thin accretion RING tightens and heats as the
			// charge builds, ember motes spiral down onto it dragging arc tails, and the
			// space inside goes DARK (the lens). Everything gathers SMOOTHLY toward
			// top-out — no strobe, just accumulating weight.
			vec2 vp = rot2(-b.angle) * (pc.aim - b.pos); // the well, body frame
			vec2 q2 = p - vp;
			float dv = max(length(q2), 1.0);
			float ringR = mix(150.0, 46.0, f); // the ring closes its fist as it charges
			// the FEED: a wavering filament rig → well, pinned at both ends
			float vl = max(length(vp), 1.0);
			vec2 vd = vp / vl;
			float alongF = clamp(dot(p, vd), 0.0, vl - ringR * 0.7);
			float ends = smoothstep(0.0, vl * 0.35, alongF) * smoothstep(vl, vl * 0.6, alongF);
			vec2 axisP = vd * alongF + vec2(-vd.y, vd.x) * sin(alongF * 0.030 - pc.time * 7.0) * 7.0 * ends;
			float fd = length(p - axisP);
			add += (PAL_EMBER * 0.8 + vec3(0.10)) * exp(-fd * fd / 14.0) * 0.45 * f;
			float pk = fract(alongF / 90.0 - pc.time * 3.2); // charge packets flowing OUT of you
			add += (PAL_EMBER * 1.2 + vec3(0.30)) * exp(-pow((pk - 0.5) * 5.0, 2.0)) * exp(-fd * fd / 8.0) * 0.9 * f;
			// the emitter mouth on the hull — the well clearly drinks from HERE
			vec2 mzS = vd * (b.radius * 1.05);
			add += (PAL_EMBER * 1.2 + vec3(0.30)) * exp(-dot(p - mzS, p - mzS) / (60.0 + 50.0 * f)) * 0.7 * f;
			if (dv < 520.0) {
				// the LENS: space inside the ring darkens, deeper with charge
				lay(vec3(0.012, 0.010, 0.012), smoothstep(ringR * 1.15, ringR * 0.4, dv) * 0.8 * f);
				// the accretion RING: thin, hot, tightening — the one bright line
				float rr = dv - ringR;
				add += (PAL_EMBER * 1.4 + vec3(0.35, 0.18, 0.08)) * exp(-rr * rr / (30.0 + 130.0 * (1.0 - f))) * (0.30 + 0.80 * f * f);
				// infalling MOTES on decaying spirals, arc tails trailing (respawn at the rim)
				for (float i = 0.0; i < 10.0; i += 1.0) {
					float rate = 0.55 + 0.30 * fract(i * 0.71);
					float ph = fract(pc.time * rate + i * 0.317); // this mote's fall, 0 → 1
					uint sk = uint(floor(pc.time * rate + i * 0.317)) * 47u + uint(i) * 13u;
					float orad = mix(470.0, ringR, ph * ph);
					float oang = hash1(sk) * TAU - pc.time * mix(1.2, 7.0, ph); // spinning up as it falls
					vec2 mp = vec2(cos(oang), sin(oang)) * orad;
					float dd = dot(q2 - mp, q2 - mp);
					add += (PAL_EMBER * 0.9 + vec3(0.18)) * exp(-dd / 20.0) * (0.25 + 0.75 * ph) * f;
					vec2 tang = vec2(-sin(oang), cos(oang)); // its arc tail
					float tl = sd_seg(q2, mp, mp + tang * (14.0 + 40.0 * ph));
					add += PAL_EMBER * exp(-tl * tl / 7.0) * 0.30 * ph * f;
				}
				// the heart: small and quiet until the charge is nearly full
				add += (vec3(1.2, 1.0, 0.8) + PAL_EMBER) * exp(-dv * dv / (140.0 + 900.0 * f * f)) * 0.55 * f * f * f;
			}
		} else if (pc.pweap == WEAP_BEAMS) { // twin GIANT lasers off the flanks
			for (float s = -1.0; s <= 1.0; s += 2.0) {
				vec2 org = wap * (s * (b.radius * 0.9 + 8.0));
				float bd = sd_seg(p, org, org + wad * 900.0);
				float flick = 0.9 + 0.2 * sin(pc.time * 71.0 + s * 2.0);
				add += (vec3(1.3, 1.0, 0.7) + PAL_EMBER * 0.5) * exp(-bd * bd / (14.0 * flick)) * 1.2 * f;
				add += PAL_ACCENT * exp(-bd * bd / (18.0 * 18.0)) * 0.28 * f;
				add += PAL_EMBER * exp(-bd * bd / (18.0 * 18.0 * 5.0)) * 0.07 * f; // veil dies inside the quad
				add += (PAL_EMBER * 1.4 + vec3(0.5)) * exp(-dot(p - org, p - org) / 40.0) * f; // emitter star
			}
		} else if (pc.pweap == WEAP_SCYTHE) { // the sweeping laser blade
			float ang = aima + sin(pc.time * 1.9) * 1.05;
			vec2 sdir = vec2(cos(ang), sin(ang));
			float bd = sd_seg(p, sdir * 20.0, sdir * 820.0);
			float flick = 0.85 + 0.30 * sin(pc.time * 53.0 + dot(p, sdir) * 0.04);
			add += (vec3(1.3, 1.0, 0.7) + PAL_EMBER * 0.5) * exp(-bd * bd / (20.0 * flick)) * 1.3 * f;
			add += PAL_ACCENT * exp(-bd * bd / (22.0 * 22.0)) * 0.30 * f;
			add += PAL_EMBER * exp(-bd * bd / (22.0 * 22.0 * 5.0)) * 0.08 * f;
			add += (PAL_EMBER * 1.5 + vec3(0.6)) * exp(-dot(p, p) / 60.0) * f;
		} else if (pc.pweap == WEAP_FLAMER) {
			// FLAMER: not a sheet — a THROW of discrete fire GLOBS. Each one spits off
			// the muzzle, rides the cone on its own hashed spread, swells as it slows,
			// burns white-hot → ember → red, and dies into a curl of dark smoke at the
			// end of its arc. Purely time-derived (like the drift sparks); the cone
			// burn physics applies is unchanged.
			for (float i = 0.0; i < 18.0; i += 1.0) {
				float rate = 2.1 + 0.8 * fract(i * 0.53);
				float ph = fract(pc.time * rate + i * 0.617); // this glob's life, 0 → 1
				uint sk = uint(floor(pc.time * rate + i * 0.617)) * 89u + uint(i) * 31u;
				vec2 gd = rot2((hash1(sk) - 0.5) * 0.60) * wad;   // its lane in the cone
				float reach = 200.0 + 230.0 * hash1(sk + 1u);
				float s2 = 1.0 - (1.0 - ph) * (1.0 - ph);         // decelerating flight
				vec2 gp = wad * (b.radius * 0.9) + gd * (reach * s2);
				gp += vec2(-gd.y, gd.x) * sin(ph * 9.0 + i * 1.7) * 10.0 * ph; // tumbling drift
				float sz = 6.0 + 30.0 * ph;                        // swells as it slows
				float dd = dot(p - gp, p - gp);
				float core = exp(-dd / (sz * sz * 0.35));
				float shell = exp(-dd / (sz * sz));
				vec3 fc = mix(vec3(1.5, 1.2, 0.7), PAL_ACCENT * 1.2, smoothstep(0.15, 0.75, ph));
				add += fc * (core * 1.5 + shell * 0.5) * (1.0 - ph * ph) * f;
				// past mid-life the shell goes DARK: the glob smokes out where it lands
				lay(vec3(0.05, 0.045, 0.042), shell * smoothstep(0.55, 0.95, ph) * 0.65 * f);
			}
			// the spitting tongue at the muzzle, licking with the throttle of fire
			vec2 mz = wad * (b.radius + 4.0);
			float md = sd_seg(p, mz, mz + wad * (26.0 + 14.0 * sin(pc.time * 37.0 + 1.7)));
			add += (vec3(1.4, 1.05, 0.5) + PAL_EMBER) * exp(-md * md / 30.0) * f;
		} else if (pc.pweap == WEAP_ARC) { // crackling discharge: jagged bolts, re-rolled fast
			for (float i = 0.0; i < 5.0; i += 1.0) {
				uint si = uint(pc.time * 14.0) * 13u + uint(i) * 101u;
				float a2 = hash1(si) * TAU;
				vec2 tip = vec2(cos(a2), sin(a2)) * (120.0 + hash1(si + 1u) * 240.0);
				vec2 mid = tip * 0.5 + vec2(hash1(si + 2u) - 0.5, hash1(si + 3u) - 0.5) * 90.0;
				float bd = min(sd_seg(p, vec2(0.0), mid), sd_seg(p, mid, tip));
				add += (vec3(1.1) + PAL_EMBER * 0.6) * exp(-bd * bd / 3.0) * f * (0.4 + 0.6 * hash1(si + 4u));
				add += PAL_EMBER * exp(-dot(p - tip, p - tip) / 30.0) * f * 0.8; // ground strike
			}
			add += PAL_EMBER * exp(-dot(p, p) / (140.0 * 140.0)) * 0.10 * f; // charged air
		} else if (pc.pweap == WEAP_VORTEX) {
			// VORTEX: a whirlpool of ember MOTES on decaying orbits — each circles the
			// cursor faster as it falls inward, drags an arc tail, and vanishes down
			// the throat (a fresh one spawns at the rim); contracting pressure rings
			// pulse through them, and a dark LENS with a thin lit rim marks the eye.
			// The drag physics applies to the horde is unchanged.
			vec2 vp = rot2(-b.angle) * (pc.aim - b.pos); // aim point, body frame
			vec2 q2 = p - vp;
			float dv = max(length(q2), 1.0);
			if (dv < 540.0) {
				lay(vec3(0.015, 0.014, 0.016), soft(dv - 34.0) * 0.85 * f);          // the lens
				add += PAL_EMBER * 1.2 * exp(-pow(dv - 38.0, 2.0) / 40.0) * f;       // its lit rim
				for (float k = 0.0; k < 3.0; k += 1.0) { // pressure rings, contracting
					float rr = (1.0 - fract(pc.time * 0.9 + k / 3.0)) * 500.0 + 20.0;
					add += (PAL_EMBER * 0.5 + vec3(0.12)) * exp(-pow(dv - rr, 2.0) / 180.0) * 0.35 * f
					     * smoothstep(500.0, 120.0, rr);
				}
				for (float i = 0.0; i < 14.0; i += 1.0) { // the orbiters
					float rate = 0.35 + 0.2 * fract(i * 0.71);
					float ph = fract(pc.time * rate + i * 0.37);          // orbit decay, 0 → 1
					uint sk = uint(floor(pc.time * rate + i * 0.37)) * 61u + uint(i) * 17u;
					float orad = mix(500.0, 26.0, ph * ph);               // falling in, accelerating
					float oang = hash1(sk) * TAU + pc.time * mix(2.0, 11.0, ph); // spinning up
					vec2 mp = vec2(cos(oang), sin(oang)) * orad;
					float dd = dot(q2 - mp, q2 - mp);
					add += (PAL_EMBER * 1.1 + vec3(0.25)) * exp(-dd / 26.0) * (0.35 + 0.65 * ph) * f;
					vec2 tang = vec2(-sin(oang), cos(oang));              // its arc tail, trailing
					float tl = sd_seg(q2, mp, mp - tang * (18.0 + 30.0 * ph));
					add += PAL_EMBER * exp(-tl * tl / 9.0) * 0.4 * ph * f;
				}
			}
		}
	}
	if (length(p) > b.radius * 3.2 + 60.0) { return; } // beyond the hull: beam only

	// ── the GARAGE (1-9): every ride reuses a chassis sprite in the player's paint —
	// bright clean STAINLESS panels, amber markings/eyes/lights, never red: YOUR machine
	// is the one polished thing on the field. Guns track the mouse; LMB
	// fires the REAL shells, so
	// no tracer stream is drawn (shoot = 0) — just the shared muzzle flash below.
	gMark = vec3(0.20, 0.44, 0.18);
	gEye = RIG_GRN;
	gPlateA = RIG_STEEL;
	gPlateB = RIG_STEEL * 0.48;
	gBrush = 2.2; // deeply worked steel — the brushing must READ (grime stays HEAVY: no showroom)
	if (b.variant != RIDE_TRUCK && b.variant != RIDE_SPORT) {
		vec2 aimd = rot2(-b.angle) * normalize(pc.aim - b.pos + 0.0001);
		if      (b.variant == RIDE_BUGGY)  { raider(p, b, pc.time, aimd, 0.0); }
		else if (b.variant == RIDE_APC
		      || b.variant == RIDE_TANK)   { tank(p, b, pc.time, aimd, 0.0); }
		else if (b.variant == RIDE_GUNNER) { gunner(p, b, pc.time, aimd, 0.0); }
		else if (b.variant == RIDE_WING)   { bomber(p, b, pc.time); }
		else                               { player_mech(p, b); return; } // MECH + COLOSSUS flash their own guns
		if (pc.muzzle > 0.02) { // the shot flash at the gun tip
			vec2 tip = aimd * (b.radius * 1.6);
			float md = length(p - tip);
			add += (PAL_EMBER * 2.2 + vec3(1.2)) * exp(-md * md / (10.0 * pc.muzzle + 3.0)) * pc.muzzle * 1.6;
		}
		return;
	}
	if (b.variant == RIDE_SPORT) { // the drift wedge + the truck's shared turret below
		sportcar(p, b);
		p *= 16.0 / b.radius;
	} else {
		// ── the TRUCK: long slab hull on proud wheels, cab + windshield up front, amber
		// running strips, red tails and BIG headlights throwing real cones down the
		// street. Drawn in classic px, scaled by the chassis (styles resize it).
		p *= CAR_RADIUS / b.radius;
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8)); // screen light → body frame
	gCS = 3.2;
	float lean = clamp(b.life, -1.0, 1.0); // CPU packs drift slip here
	lay(vec3(0.012, 0.010, 0.010), 0.5 * soft(sd_box(p - vec2(7.0, 10.0), vec2(24.0, 8.0)) - 5.0)); // ground shadow
	p.y += lean * 1.4; // the body rolls a touch against the drift
	// wheels, slightly proud of the hull
	for (float sx = -1.0; sx <= 1.0; sx += 2.0) {
		for (float sy = -1.0; sy <= 1.0; sy += 2.0) {
			lay(PAL_BASE * 0.7, soft(sd_box(p - vec2(sx * 13.5, sy * 12.5), vec2(6.5, 3.2)) - 2.0));
		}
	}
	// hull: long rounded slab, beveled edges catching the light — clean stainless
	float hull = sd_box(p, vec2(23.0, 11.0)) - 4.0;
	float rim = clamp(dot(normalize(p + 0.0001), gL), 0.0, 1.0);
	vec3 mc = RIG_STEEL * (0.55 + 0.18 * sin(p.x * 0.9));
	mc = mix(mc, RIG_STEEL * (0.9 + rim * 1.2), smoothstep(-5.0, 0.0, hull));
	float brh = 0.65 * vnoise(vec2(p.x * 0.55, p.y * 3.4) + 3.0)   // brushed steel, deep two-octave
	          + 0.35 * vnoise(vec2(p.x * 1.10, p.y * 8.0) + 9.0);  //   grinding streaks
	mc *= 1.0 + (brh - 0.5) * 0.55;
	mc *= 0.93 + 0.11 * vnoise(p * 0.16 + 7.0);
	mc *= 1.0 - smoothstep(0.60, 0.25, vnoise(p * 0.13 + 13.0) + brh * 0.35) * 0.50; // oily grunge
	lay(mc, soft(hull));
	// panel seams
	float seamx = min(abs(p.x - 4.0), abs(p.x + 12.0));
	lay(PAL_BASE * 0.85, soft(hull) * smoothstep(1.2, 0.4, seamx) * 0.6);
	// cab + windshield up front
	lay(RIG_STEEL * 0.7, soft(sd_box(p - vec2(11.0, 0.0), vec2(7.0, 8.6)) - 2.5));
	add += RIG_GRN * 1.4 * soft(sd_box(p - vec2(8.2, 0.0), vec2(1.1, 6.2))); // green roof light-bar
	float glass = sd_box(p - vec2(13.5, 0.0), vec2(3.4, 7.2)) - 2.0;
	lay(vec3(0.020, 0.021, 0.024), soft(glass));
	add += vec3(0.10, 0.105, 0.115) * soft(glass) * pow(clamp(dot(normalize(p - vec2(13.5, 0.0) + 0.0001), gL), 0.0, 1.0), 3.0);
	// amber running strips along the bed sides + red tail lights
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += RIG_GRN * 1.5 * soft(sd_box(p - vec2(-8.0, s * 10.2), vec2(11.0, 0.9)));
		add += RIG_GRN * 1.6 * soft(sd_box(p - vec2(-25.5, s * 8.0), vec2(1.2, 2.2))); // green tails — red is the enemy's
	}
	// headlight lamps — small hot points; the LONG beam on the ground lives in
	// city.frag and ramps up down-range, so there's no blinding pool at the car
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += vec3(1.0, 0.90, 0.70) * 1.2 * soft(length(p - vec2(22.5, s * 6.5)) - 2.4);
	}
	// rear thrusters: glow with the throttle, flame under boost
	float th = pc.throttle * 0.8 + pc.boost * 1.6;
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		vec2 en = vec2(-24.0, s * 6.0);
		add += PAL_EMBER * soft(length(p - en) - 2.6) * (0.04 + th * (1.8 + 0.5 * sin(pc.time * 43.0 + s))); // heat only — no idle yellow
		if (pc.boost > 0.03) {
			float fl = sd_seg(p, en, en - vec2(12.0 + 10.0 * pc.boost * (0.7 + 0.3 * sin(pc.time * 57.0 + s * 2.0)), 0.0));
			add += (PAL_EMBER * 1.6 + vec3(0.4)) * exp(-fl * fl / 6.0) * pc.boost;
		}
	}
	// drift SMOKE + SPARKS off the rear wheels while the tail is loose — big and
	// readable, and SIDE-LOADED: the drift throws the car's weight onto the outside
	// wheel (the same side the body rolls toward, sign of `lean`), so that tire does
	// nearly all the smoking and grinding; the unloaded side just wisps.
	float slip = clamp(abs(lean) * 1.5, 0.0, 1.0);
	if (slip > 0.2) {
		for (float s = -1.0; s <= 1.0; s += 2.0) {
			float sw = clamp(0.5 + s * lean * 1.6, 0.06, 1.0); // this wheel's share of the load
			vec2 wp = vec2(-13.5, s * 12.5);
			for (float i = 0.0; i < 4.0; i += 1.0) { // fat tire smoke billowing behind
				float ph3 = fract(pc.time * 1.6 + i * 0.25 + s * 0.17);
				vec2 sp3 = wp + vec2(-8.0 - ph3 * 40.0, s * (2.0 + ph3 * 9.0) * sin(pc.time * 2.6 + i));
				lay(vec3(0.21, 0.205, 0.20), slip * sw * (1.0 - ph3) * 0.7 * soft(length(p - sp3) - (4.0 + ph3 * 13.0)));
			}
			// PARTICLE sparks: discrete embers torn off the contact patch, each flying a
			// decelerating arc backward, curling to the drift side, cooling white-hot →
			// red as it dies. Purely time-derived (respawn cycles re-roll a hash), no
			// state; the loaded wheel sheds nearly all of them. Dim into the bloom feed.
			for (float i = 0.0; i < 7.0; i += 1.0) {
				float rate = 4.6 + 1.3 * fract(i * 0.61 + s * 0.5);
				float ph4 = fract(pc.time * rate + i * 0.37); // this ember's life, 0 → 1
				uint sk = uint(floor(pc.time * rate + i * 0.37)) * 97u + uint(i) * 13u + uint(s + 1.0) * 7u;
				if (hash1(sk) > slip * sw) { continue; }      // the load gates how many fly
				vec2 dir3 = normalize(vec2(-1.0, s * (hash1(sk + 1u) * 0.9 - 0.15)));
				float v0 = 30.0 + 60.0 * hash1(sk + 2u);
				vec2 pp = wp + dir3 * v0 * ph4 * (1.0 - 0.45 * ph4); // decelerating flight
				pp.y += s * ph4 * ph4 * 6.0;                          // curling out with the slide
				float dd = dot(p - pp, p - pp);
				vec3 emb = mix(PAL_EMBER * 1.3 + vec3(0.45), PAL_ACCENT * 0.8, ph4); // white-hot → red
				add += emb * exp(-dd / (1.6 + 2.2 * ph4)) * (1.0 - ph4);
			}
		}
	}
	}
	// turret: mount + barrel toward the mouse, with recoil + muzzle flash (TRUCK + SPORT)
	float ta = atan(pc.aim.y - b.pos.y, pc.aim.x - b.pos.x) - b.angle;
	vec2 td = vec2(cos(ta), sin(ta));
	vec2 tm = vec2(-2.0, 0.0);
	float blen = 22.0 - pc.muzzle * 4.5; // recoil
	lay(BOT_LINE * 2.2, soft(sd_seg(p, tm, tm + td * blen) - 2.0));
	lay(PAL_MID * 0.5, soft(length(p - tm) - 6.0));
	lay(PAL_MID * 1.35, soft(length(p - tm) - 3.8));
	if (pc.muzzle > 0.02) { // hot star at the tip
		vec2 tip = tm + td * (blen + 3.0);
		float md = length(p - tip);
		float star = 1.0 + 0.5 * cos(atan(p.y - tip.y, p.x - tip.x) * 6.0 + pc.time * 90.0);
		float fl = exp(-md * md / (9.0 * star * pc.muzzle + 3.0)) * pc.muzzle;
		add += (PAL_EMBER * 2.2 + vec3(1.2)) * fl * 2.0;
	}
}

void main() {
	Body b = BODIES[v_id];
	if (b.kind == KIND_DEAD) { discard; }
	body_paint();
	vec2 p = v_local;
	ship(p, b);
	body_finish(p, b);
}
