#version 460
#include "common.glsl"
#include "bodykit.glsl" // shared painter state + machined-metal primitives + enemy chassis (baked into the atlas)

// Every body as a procedural SDF sprite in its own body frame (+x = facing): the hover
// ship with its turret/flash/boost flame/giant laser, the invading mechs, gate pylons,
// towable wrecks, bullet bolts, death breakups. Output is premultiplied; `add` is pure
// emissive (HDR > 1) that feeds the bloom pass.
//
// The BOTS are machined-metal war machines: hard two-tone cel shading over BRUSHED
// metal plates (directional grinding streaks + wear, smooth noise — never a grid) with
// a broad sheen — and no outlines. Chrome leg pistons + joint bearings + deck hardware
// keep them reading as BOTS, not creatures. The horde is dusty rust-toned steel (the city's own warm family, a notch
// more saturated) with red unit paint and RED-burning
// sensor eyes (a field of red eyes in the dark); YOUR team burns bright GREEN
// (RIG_GRN): the army's dusty grey and the player's bright stainless both wear green
// lights/markings — red enemy, green friend, at a glance.
// Red is reserved for damage/blast heat. Battle damage: below half HP the paint chars
// and embers gutter out of the hull.

// Vertex → fragment interface (must match body.vert's `out`s).
layout(location = 0) in vec2      v_local;
layout(location = 1) in flat uint v_id;
layout(location = 0) out vec4 o_color;
// the CITY CACHE (Img.CityC) — sampled for building occlusion (see the occlusion test in
// main), replacing a duplicated 8-step house_at march.
layout(set = 0, binding = 1) uniform sampler2D TEXS[];
// painter state (base/cov/add), the g* paint globals, lay/soft/plate/mech_leg and the enemy
// chassis all live in bodykit.glsl now (shared with the atlas baker). Only the v_id/time-
// dependent bits — the gait odometer, the emissive, battle damage — stay here.

// GAIT ODOMETER: leg phase advances with actual TRAVEL, not time·speed — a time·speed
// phase re-scales its whole history whenever the velocity changes (contact shoves do,
// every frame), which teleports the legs into a jitter. The horde marches radially
// (in toward the pit, allies out from it), so distance-to-center IS the path odometer:
// legs freeze when a bot is blocked, backpedal when it's flung, never jitter. The rate
// is sized so feet approximately PLANT (sweep-back speed ≈ body speed), capped so the
// tiny fast classes don't strobe. The player's walkers carry a true CPU-integrated
// odometer in b.life instead (their motion isn't radial).
float gait_ph(Body b) {
	float k = min(5.0 / b.radius, 0.22);
	float d = distance(b.pos, vec2(WORLD * 0.5));
	return (v_id >= ALLY_LO || v_id == 0u ? d : -d) * k + hash1(v_id * 7919u) * TAU;
}

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

// the chassis sprites double as garage rides (defined below, with the horde art)
void tank(vec2 p, Body b, float t, vec2 aimd, float shoot);
void raider(vec2 p, Body b, float t, vec2 aimd, float shoot);
void gunner(vec2 p, Body b, float t, vec2 aimd, float shoot);
void bomber(vec2 p, Body b, float t);

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

// Battle damage overlay: soot creeps smoothly over the armor; the red is the hit
// wearing off on ONE smooth shared envelope — no flicker, no per-bot random phases.
// b.life is stamped when the wave reaches the bot, so across a crowd the animation
// radiates outward through the bodies with the blast, staggered only by distance.
void battle_damage(vec2 p, Body b, float maxhp) {
	if (b.hp < -50.0) { return; } // blast-stamped: no damage glow — it walks, whitens, dies
	float dmg = 1.0 - clamp(b.hp / maxhp, 0.0, 1.0);
	if (dmg < 0.10) { return; }
	float m = (dmg - 0.10) * 1.30;
	// soot: a smooth noise front creeping over the paint — persistent WEAR is dark
	float n = vnoise(p * 0.5 + float(v_id % 977u));
	base = mix(base, vec3(0.028, 0.024, 0.020), smoothstep(1.05 - m * 1.2, 1.35 - m * 1.2, n) * 0.85 * cov);
	float hot = clamp(b.life, 0.0, 1.0); // decays linearly — a clean cool-down, never a blink
	if (hot > 0.02) {
		add += PAL_ACCENT * hot * (0.3 + m * 0.5) * exp(-dot(p, p) / (b.radius * b.radius * 1.4)) * cov;
		vec2 q = rot2(hash1(v_id * 337u) * TAU) * p; // a fissure glows while the metal is hot
		float crack = abs(q.y - sin(q.x * 0.5 + hash1(v_id * 337u + 1u) * 6.0) * b.radius * 0.2);
		add += PAL_ACCENT * exp(-crack * crack / 1.4) * hot * (0.3 + m) * 1.1 * cov
		     * smoothstep(b.radius, b.radius * 0.5, length(p));
	}
	for (float i = 0.0; i < 2.0; i += 1.0) { // black smoke curling off the wounds
		float ph2 = fract(pc.time * 0.55 + hash1(v_id + uint(i) * 7u));
		vec2 sp2 = vec2(sin(pc.time * 1.3 + i * 2.6) * 6.0, -b.radius * 0.3 - ph2 * 22.0);
		lay(vec3(0.016, 0.015, 0.015), m * (1.0 - ph2) * 0.55 * soft(length(p - sp2) - (3.0 + ph2 * 8.0)));
	}
}

// ── the enemy sprites: baked DIFFUSE chassis (bodykit) + the LIVE emissive ──────
// The chassis (plates/legs/bolts/sockets) is baked once per <kind × gait-frame> into the atlas;
// enemy_atlas() fetches it. The EMISSIVE (pulsing eyes, exhaust embers) is id/time-dependent so
// it can't be baked — it's re-added live here, cheap (a few soft() calls), on top of the fetched
// chassis. The procedural wrappers spider()/skitter()/brute() reproduce the OLD full sprite for
// the low-count dying/limping paths (bot_sprite falls back to them when a body isn't a live
// KIND_ENEMY), so those keep the exact same look.

void spider_emissive(vec2 p, Body b) {
	float r = b.radius;
	for (float s = -1.0; s <= 1.0; s += 2.0) { // rear exhausts, faintly hot
		add += PAL_EMBER * 0.5 * soft(length(p - vec2(-r * 0.72, s * r * 0.18)) - r * 0.07);
	}
	float beat = 0.7 + 0.5 * sin(pc.time * 2.8 + float(v_id) * 0.7); // eyes PULSE like a heartbeat — alive
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += gEye * 1.1 * beat * soft(length(p - vec2(r * 0.58, s * r * 0.28)) - r * 0.08);
	}
}
void spider(vec2 p, Body b, float t) { spider_chassis(p, b, gait_ph(b)); spider_emissive(p, b); battle_damage(p, b, HP_SPIDER); }

void skitter_emissive(vec2 p, Body b) {
	float r = b.radius;
	float beat = 0.7 + 0.5 * sin(pc.time * 3.4 + float(v_id) * 0.9); // pulsing eye — alive
	add += gEye * 1.3 * beat * soft(length(p - vec2(r * 0.95, 0.0)) - r * 0.11);
}
void skitter(vec2 p, Body b, float t) { skitter_chassis(p, b, gait_ph(b)); skitter_emissive(p, b); battle_damage(p, b, HP_SKITTER); }

void brute_emissive(vec2 p, Body b) {
	float r = b.radius;
	float pulse = 0.8 + 0.3 * sin(pc.time * 3.0 + float(v_id)); // core vents: two hot slits, pulsing
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += gEye * pulse * soft(sd_box(p - vec2(-r * 0.30, s * r * 0.14), vec2(r * 0.17, r * 0.028)));
	}
	for (float s = -1.0; s <= 1.0; s += 2.0) {
		add += PAL_EMBER * 0.6 * soft(length(p - vec2(-r * 0.72, s * r * 0.22)) - r * 0.06); // exhausts
	}
}
void brute(vec2 p, Body b, float t) { brute_chassis(p, b, gait_ph(b)); brute_emissive(p, b); battle_damage(p, b, HP_BRUTE); }

// map the horde variant → atlas kind row
uint atlas_kind(uint variant) { return variant == VAR_SKITTER ? 1u : (variant == VAR_BRUTE ? 2u : 0u); }

// fetch one atlas tile (kind, frame) at in-tile uv (clamped a half-texel in so bilinear can't
// bleed across tiles). Tiles are laid out row-major: tile = kind*ATLAS_FRAMES + frame.
vec4 atlas_tile(uint kind, uint frame, vec2 uv_in) {
	uint tile = kind * ATLAS_FRAMES + frame;
	vec2 cell = vec2(float(tile % ATLAS_COLS), float(tile / ATLAS_COLS));
	float inset = 0.5 / float(ATLAS_TILE);
	vec2 uv = (cell + clamp(uv_in, inset, 1.0 - inset)) * (float(ATLAS_TILE) / float(ATLAS_DIM));
	return texture(TEXS[IMG_BODYA], uv);
}

// the alive-horde FAST PATH: sample the baked DIFFUSE chassis (base in rgb, cov in a) — two gait
// frames cross-faded — then re-add the live emissive + battle damage. Replaces ~45 vnoise + 6
// procedural legs per fragment with two texture fetches.
void enemy_atlas(vec2 p, Body b) {
	uint kind = atlas_kind(b.variant);
	vec2 uv_in = clamp((p / (b.radius * ATLAS_EXTK)) * 0.5 + 0.5, 0.0, 1.0); // p → in-tile uv (ext matches body.vert)
	// NEAREST gait frame (no cross-fade): blending two leg poses ghosts the legs and softens the
	// whole machine. ATLAS_FRAMES is dense enough that the discrete step reads as motion, not chop.
	uint frame = uint(fract(gait_ph(b) / TAU) * float(ATLAS_FRAMES) + 0.5) % ATLAS_FRAMES;
	vec4 s = atlas_tile(kind, frame, uv_in);
	base = s.rgb; cov = s.a;
	if      (kind == 0u) spider_emissive(p, b);
	else if (kind == 1u) skitter_emissive(p, b);
	else                 brute_emissive(p, b);
	battle_damage(p, b, max_hp(b.variant));
}

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

// One dispatch for every live/dying chassis sprite. Allies carry their locked target
// in gen — that gives the gun sprites their tracer reach (and the drones their arming
// ramp); the ally BODY faces the target, so the gun line is +x in the body frame.
void bot_sprite(vec2 p, Body b, float t) {
	// the LIVE HORDE (spider/skitter/brute) samples the baked chassis atlas instead of running
	// the full procedural sprite — the big bodies win. Dying/limping enemies (KIND_DYING) and the
	// ally classes below fall through to the procedural path, which stays byte-identical.
	if (b.kind == KIND_ENEMY) { enemy_atlas(p, b); return; }
	vec2 aimd = vec2(1.0, 0.0);
	float shoot = 0.0, arm = 0.0;
	if (b.kind == KIND_ALLY && b.gen != 0u) {
		shoot = distance(BODIES[b.gen - 1u].pos, b.pos);
		arm = clamp(1.0 - shoot / 900.0, 0.0, 1.0);
	}
	if      (b.variant == VAR_SKITTER) { skitter(p, b, t); }
	else if (b.variant == VAR_BRUTE)   { brute(p, b, t); }
	else if (b.variant == VAR_TANK)    { tank(p, b, t, aimd, shoot); }
	else if (b.variant == VAR_RAIDER)  { raider(p, b, t, aimd, shoot); }
	else if (b.variant == VAR_SUICIDE) { suicide(p, b, t, arm); }
	else if (b.variant == VAR_GUNNER)  { gunner(p, b, t, aimd, shoot); }
	else if (b.variant == VAR_BOMBER)  { bomber(p, b, t); }
	else                               { spider(p, b, t); }
}

void turret(vec2 p, Body b) {
	// Defense tower: a heavy fortress ring with a rotating emitter. Perimeter giants
	// (outside the city) scythe slow massive laser bars; inner crossings mount MACHINE
	// GUNS hosing tracer streams that ricochet off the horde. Duty/sweep MUST match
	// physics.comp (hash1(v_id*77u) / hash1(v_id*913u)).
	float r = b.radius;
	bool mg = distance(b.pos, vec2(WORLD * 0.5)) < pc.city_r;
	float duty = mg ? 0.70 : 0.30;
	float rate = mg ? 0.90 : 0.14;
	float len  = mg ? MG_LEN : TWR_LEN;
	float phase = fract(pc.time * rate + hash1(v_id * 77u));
	bool firing = phase < duty;
	float env = smoothstep(0.0, 0.03, phase) * smoothstep(duty, duty - 0.04, phase); // ramp in/out
	float angW;
	if (mg) { angW = hash1(v_id * 913u) * TAU + pc.time * 2.6; } // gun: spinning sweep
	else { // perimeter laser: always OUTWARD, sweeping a cone away from the city
		vec2 outw = b.pos - vec2(WORLD * 0.5);
		angW = atan(outw.y, outw.x) + sin(pc.time * 0.35 + hash1(v_id * 913u) * TAU) * 1.1;
	}
	vec2 bd2 = rot2(angW - b.angle) * vec2(1.0, 0.0); // fire dir, body frame
	if (mg) { // ── MACHINE GUN: real BULLETS. Each round flies straight at the barrel
		// angle it LEFT with — rewind the sweep by time-of-flight (MG_V) — so the stream
		// curls across the district like AA fire. physics.comp rewinds identically.
		float dpx = length(p);
		if (dpx > r * 0.45 && dpx < len) {
			float te = pc.time - dpx / MG_V; // when the round now at this range fired
			float ph2 = fract(te * rate + hash1(v_id * 77u));
			float envE = smoothstep(0.0, 0.03, ph2) * smoothstep(duty, duty - 0.04, ph2) * step(ph2, duty);
			float burstE = step(0.30, fract(te * 3.3 + hash1(v_id * 55u))); // the belt runs in bursts
			float angE = hash1(v_id * 913u) * TAU + te * 2.6;
			vec2 dir = rot2(angE - b.angle) * vec2(1.0, 0.0);
			if (dot(p, dir) > 0.0) {
				float perp = dot(p, vec2(-dir.y, dir.x));
				float u = te * 30.0; // 30 rounds/s off the belt
				float off = (hash21(vec2(floor(u), float(v_id))) - 0.5) * 10.0; // per-round spray
				float lat = exp(-pow(perp - off, 2.0) / 3.5);
				float cyc = fract(u);
				float slug = exp(-pow((cyc - 0.5) * 9.0, 2.0));               // the round itself
				float trail = exp(-(cyc - 0.5) * 6.0) * step(0.5, cyc) * 0.3; // its ember wake
				add += (vec3(1.45, 1.1, 0.7) * slug + PAL_EMBER * trail) * lat * envE * burstE * 2.4;
			}
		}
		if (firing) {
			float burst = step(0.30, fract(pc.time * 3.3 + hash1(v_id * 55u)));
			for (float i = 0.0; i < 3.0; i += 1.0) { // ricochets sparking off where rounds land
				uint si = v_id * 131u + uint(pc.time * 11.0) * 17u + uint(i) * 7u;
				float rng = len * (0.25 + 0.65 * hash1(si));
				float th = pc.time - rng / MG_V;
				vec2 hitp = rot2(hash1(v_id * 913u) * TAU + th * 2.6 - b.angle) * vec2(rng, 0.0);
				vec2 rq = rot2(hash1(si + 3u) * 2.4 - 1.2) * (p - hitp);
				add += PAL_EMBER * 2.2 * exp(-sd_seg(rq, vec2(0.0), vec2(26.0, 0.0)) * 1.5) * env * burst * hash1(si + 5u);
			}
		}
	} else if (firing) { // ── the giant laser: a one-sided bar burning OUT into the wasteland
		float bd = sd_seg(p, vec2(0.0), bd2 * len);
		float flick = 0.85 + 0.30 * sin(pc.time * 47.0 + dot(p, bd2) * 0.03);
		add += (vec3(1.3, 1.0, 0.7) + PAL_EMBER * 0.5) * exp(-bd * bd / (30.0 * flick)) * 1.5 * env;
		add += PAL_ACCENT * exp(-bd * bd / (TWR_W * TWR_W)) * 0.35 * env;
		add += PAL_EMBER * exp(-bd * bd / (TWR_W * TWR_W * 6.25)) * 0.10 * env; // veil: gaussian, dies inside the quad
	}
	if (length(p) > r * 3.5) { return; } // beyond the fortress: fire only
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = 4.0;
	lay(vec3(0.012), 0.45 * soft(length(p - vec2(5.0, 7.0)) - r * 1.6));
	plate(p, vec2(0.0), length(p) - r * 1.5, BOT_LINE * 3.0, 1.0);  // apron ring
	plate(p, vec2(0.0), length(p) - r * 1.05, gPlateB, 2.0);      // armored drum
	for (float i = 0.0; i < 6.0; i += 1.0) {                        // buttresses
		vec2 bp = rot2(i * TAU / 6.0 + 0.4) * vec2(r * 1.25, 0.0);
		plate(p, bp, sd_box(rot2(-i * TAU / 6.0 - 0.4) * (p - bp), vec2(r * 0.28, r * 0.14)), gPlateA, i + 3.0);
	}
	// rotating emitter head, aimed along the sweep
	vec2 hq = rot2(-(angW - b.angle)) * p;
	plate(p, vec2(0.0), sd_box(hq - vec2(r * 0.20, 0.0), vec2(r * 0.55, r * 0.28)) - r * 0.1, gPlateA, 9.0);
	lay(BOT_LINE * 2.0, soft(sd_box(hq - vec2(r * 0.62, 0.0), vec2(r * 0.30, r * 0.10))));
	// the eye on top: steady TEAM GREEN (defense is your side — red is the enemy's);
	// the tower itself NEVER flashes, only its rounds and ricochets move
	add += RIG_GRN * 0.8 * soft(length(p) - r * 0.30);
}

void helper(vec2 p, Body b) {
	// Salvage drone: a twin-rotor lifter, sized to READ as the fleet. Amber work light,
	// grey shell, a hoist beam down to the wreck it's fetching (target slot in gen).
	gL = rot2(-b.angle) * normalize(vec2(-0.6, -0.8));
	gCS = 2.6;
	float sc = 14.0 / max(b.radius, 8.0); // sprite drawn in classic proportions, scaled up by radius
	p *= sc;
	// ALTITUDE faked by scale: cruising high = closer to the camera = BIGGER; it swoops
	// small as it descends onto a wreck, and hauls home a bit lower under the load
	float alt = 1.0;
	if (b.gen == 0x80000000u) { alt = 0.75; } // hauling: heavy, riding lower
	else if (b.gen != 0u) {
		Body tw2 = BODIES[b.gen - 1u];
		alt = clamp(distance(b.pos, tw2.pos) / 160.0, 0.18, 1.0); // swooping down to grab
	}
	p /= 0.55 + 0.55 * alt; // cruise reads modest (1.10×); it shrinks well down for ground pickups (0.65×)
	float bob = sin(pc.time * 3.1 + float(v_id)) * 1.2;
	lay(vec3(0.012), 0.4 * soft(length(p - vec2(5.0, 8.0 + bob + alt * 9.0)) - 9.0)); // shadow drifts with height
	p.y -= bob * 0.4;
	if (b.gen != 0u && b.gen != 0x80000000u) { // hoist beam to the target wreck
		Body t = BODIES[b.gen - 1u];
		vec2 lp = rot2(-b.angle) * (t.pos - b.pos) * sc;
		if (dot(lp, lp) < 110.0 * 110.0) {
			float bd = sd_seg(p, vec2(0.0), lp);
			add += PAL_EMBER * 1.1 * exp(-bd * bd / 3.0) * (0.7 + 0.3 * sin(pc.time * 31.0));
		}
	}
	for (float s = -1.0; s <= 1.0; s += 2.0) { // rotor pods, spinning shimmer
		vec2 rp = vec2(-4.0, s * 12.0);
		lay(BOT_LINE * 2.0, soft(length(p - rp) - 6.0));
		add += vec3(0.30, 0.33, 0.36) * soft(length(p - rp) - 8.5) * (0.4 + 0.35 * sin(pc.time * 51.0 + s + float(v_id)));
	}
	plate(p, vec2(0.0), sd_box(p, vec2(11.0, 6.5)) - 3.0, vec3(0.155, 0.160, 0.170), 1.0); // grey shell
	plate(p, vec2(7.0, 0.0), length(p - vec2(7.0, 0.0)) - 4.0, SHIP_CHROME * 0.7, 2.0);  // sensor dome
	add += RIG_GRN * 1.6 * soft(length(p - vec2(-9.5, 0.0)) - 2.0) * (0.6 + 0.4 * sin(pc.time * 4.0 + float(v_id))); // work light — team green
	add += RIG_GRN * 1.0 * soft(length(p - vec2(2.0, 0.0)) - 1.2) * step(0.5, fract(pc.time * 1.6 + hash1(v_id))); // status blinker — team green
}

void wreck(vec2 p, Body b) {
	// Unmistakably DEAD: a flattened charcoal husk under settling ash — none of the
	// living paint and NO red (red is the language of live threats). Drones haul it.
	float r = b.radius;
	float fade = clamp(b.life / 3.0, 0.0, 1.0);
	uint s = v_id * 613u;
	if (b.variant == 1u) { p *= 0.72; } // AIRBORNE, hoisted by a drone: closer to camera = bigger
	else { p *= 0.82; }                 // collapsed flat on the ground
	lay(vec3(0.016, 0.015, 0.014), 0.6 * fade * soft(length(p) - r * 1.25)); // scorch bed
	for (float i = 0.0; i < 4.0; i += 1.0) { // dead legs, splayed
		float aa = (i + 0.5) * (TAU / 4.0) + hash1(s + uint(i)) * 0.8 - 0.4;
		vec2 tip = rot2(aa) * vec2(r * (1.5 + 0.5 * hash1(s + 9u + uint(i))), 0.0);
		lay(vec3(0.030, 0.029, 0.028), soft(sd_seg(p, vec2(0.0), tip) - r * 0.10) * fade);
	}
	// buckled hull: bare cold-steel plates with the faintest BLUE cast — dead metal
	lay(vec3(0.046, 0.049, 0.058), soft(sd_box(rot2(0.4) * p, vec2(r * 0.62, r * 0.46)) - r * 0.10) * fade);
	lay(vec3(0.034, 0.037, 0.044), soft(sd_box(p - vec2(r * 0.2, r * 0.1), vec2(r * 0.32, r * 0.22)) - r * 0.05) * fade);
	// pale ash dusting settling over the top — DEAD reads pale, flat, cool
	float ash = hash21(floor(p / 4.0) + float(v_id));
	base = mix(base, vec3(0.104, 0.107, 0.115), step(0.62, ash) * 0.65 * cov);
	// metal SPARKLE: tiny sparse glints with the faintest cool cast — extremely subtle
	vec2 gc2 = floor(p / 6.0);
	vec2 gd2 = (fract(p / 6.0) - vec2(hash21(gc2 + float(v_id)), hash21(gc2 + float(v_id) + 7.0))) * 6.0;
	float glint = exp(-dot(gd2, gd2) / 0.8) * step(0.86, hash21(gc2 + 3.1));
	add += vec3(0.26, 0.29, 0.34) * glint * fade * cov * 0.45;
	base *= 0.4 + 0.6 * fade; // crumbles away if left to rot
	if (b.variant != 1u) { cov *= 0.55; } // on the ground: faded but clearly THERE
}

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

void burst(vec2 p, Body b) {
	// Mechanical breakup — no fireballs, no shockwave rings: the mech flies apart into
	// tumbling painted-armor shards with cooling ember edges, over a brief hot pinpoint.
	float total = b.variant == VAR_SPARK ? SPARK_T : (b.variant == VAR_BOOM ? BOOM_T : DEATH_T);
	float prog = 1.0 - clamp(b.life / total, 0.0, 1.0);
	float fade = 1.0 - prog;
	uint s = v_id * 977u;
	if (b.variant == VAR_BOOM) {
		// detonation: one brief flash at the point of impact — the wave itself is the
		// composite's distortion + the reaction radiating THROUGH the bots
		float rr = length(p);
		float flash = exp(-prog * 9.0);
		lay(vec3(1.3, 1.1, 0.8), soft(rr - mix(6.0, 30.0, 1.0 - flash)) * flash);
		add += (PAL_EMBER * 1.3 + vec3(0.4)) * exp(-rr * rr / 700.0) * flash;
		return;
	}
	if (b.variant == VAR_SPARK) { // ── PIT SINK: the shaft takes its due, QUIETLY.
		// No blast, no splash: the husk slides for the throat, then rides the pit's
		// mirrored fake-3D lean straight DOWN-screen — shrinking, turning slowly, going
		// to black silhouette against the furnace under-glow — and a few draft embers
		// ride the heat back up the shaft. The quad is rotated by b.angle, so work in a
		// screen-aligned frame (+y = down-screen) for the descent.
		vec2 pw = rot2(b.angle) * p;
		vec2 toC = normalize(vec2(WORLD * 0.5) - b.pos + vec2(0.0001));
		float slide = smoothstep(0.0, 0.6, prog);   // drift the last stretch to the hole
		float drop  = smoothstep(0.2, 0.9, prog);   // then go under
		vec2 hc = toC * slide * 26.0 + vec2(0.0, LEAN * 0.80 * drop * drop); // down to the crucible floor
		float hs = max(1.0 - 0.82 * drop, 0.12);
		vec2 hq = rot2(prog * 2.6) * (pw - hc) / hs;
		float husk = soft(sd_box(hq, vec2(b.radius * 0.62, b.radius * 0.45)) * hs - 2.0);
		float dd = dot(pw - hc, pw - hc);
		add += (PAL_EMBER * 1.2 + vec3(0.10)) * exp(-dd / (b.radius * b.radius * 1.6))
		     * drop * (1.0 - drop) * 1.1;                    // melt light closing over it — soft, no flare
		lay(mix(vec3(0.046, 0.041, 0.037), vec3(0.010, 0.007, 0.005), drop), husk * (1.0 - drop * drop * 0.85));
		add += PAL_EMBER * husk * drop * (1.0 - drop) * 0.8; // heat licking its plates on the way down
		for (float i = 0.0; i < 4.0; i += 1.0) { // draft embers climbing back out, cooling
			uint si = s + uint(i) * 29u;
			float em = fract(prog * 1.4 + hash1(si));
			vec2 c = hc + vec2((hash1(si + 1u) - 0.5) * b.radius * 1.3, -em * 44.0 - 4.0);
			float sz = 1.5 + 1.3 * hash1(si + 2u);
			add += PAL_EMBER * exp(-dot(pw - c, pw - c) / (sz * sz)) * (1.0 - em) * (1.0 - em) * drop * fade * 1.4;
		}
		return;
	}
	// death: the machine buckles — a brief hot flash, a few embers arcing out, oily
	// smoke. The husk (KIND_WRECK) takes over from here, so keep the hand-off QUIET.
	float spread = (b.variant == VAR_BRUTE ? 1.5 : 1.0) * b.radius * 2.4;
	add += (PAL_EMBER * 1.3 + vec3(0.3)) * exp(-dot(p, p) / (b.radius * b.radius * 1.2)) * exp(-prog * 8.0) * 1.8;
	for (float i = 0.0; i < 5.0; i += 1.0) { // round ember dots flung outward, cooling
		uint si = s + uint(i) * 13u;
		float a = hash1(si) * TAU;
		float dst = (0.3 + 0.7 * hash1(si + 1u)) * prog * spread + b.radius * 0.3;
		vec2 c = rot2(a) * vec2(dst, 0.0);
		add += PAL_EMBER * exp(-dot(p - c, p - c) / 2.2) * fade * (0.6 + hash1(si + 4u));
	}
	lay(vec3(0.020, 0.019, 0.019), 0.5 * fade * exp(-dot(p, p) / (spread * spread * 0.5 * (0.15 + prog)))); // smoke blot
}

void main() {
	Body b = BODIES[v_id];
	if (b.kind == KIND_DEAD) { discard; }
	vec2 p = v_local;
	float t = pc.time + hash1(v_id * 7919u) * TAU;
	// team paint: YOUR army (and its dying/limping bodies) burns green, never red
	if (v_id >= ALLY_LO) { gMark = vec3(0.20, 0.44, 0.18); gEye = RIG_GRN * 0.9; }
	// the HORDE (every enemy slot, dying ones included): dusty RUST-TONED steel — the
	// same warm desaturated family as the city's roofs and facades, one notch more
	// saturated so the machines read as machines — wearing RED unit paint and
	// RED-burning sensor eyes: a field of red eyes on the night ground.
	else if (v_id >= ENEMY_LO && v_id < BULLET_LO) {
		gPlateA = vec3(0.120, 0.121, 0.136); // SLIGHTLY cool steel — a faint blue cast lifts the horde off the warm city
		gPlateB = vec3(0.063, 0.064, 0.075);
		gBrush  = 2.6; // the most worked-over, filthiest metal on the field
		gGrime  = 1.2;
		gEye    = vec3(1.60, 0.16, 0.06); // HDR red — the eyes BLOOM like the player's green
		gMark   = vec3(0.85, 0.13, 0.04);    // BRIGHT red unit paint — the enemy's language
	}
	if      (b.kind == KIND_PLAYER) { ship(p, b); }
	else if (b.kind == KIND_BULLET) { bullet(p, b); }
	else if (b.kind == KIND_WRECK)  { wreck(p, b); }
	else if (b.kind == KIND_TURRET) { turret(p, b); }
	else if (b.kind == KIND_HELPER) { helper(p, b); }
	else if (b.kind == KIND_ALLY)   { bot_sprite(p, b, t); }
	else if (b.kind == KIND_DYING && (b.variant == VAR_BOOM || b.variant == VAR_SPARK)) { burst(p, b); }
	else if (b.kind == KIND_DYING && b.hp < -50.0) {
		// blast-stamped (the exact circle): a slow smolder that SNAPS red, then the
		// body slumps and COOLS into the husk — no hard swap at the end
		float lf = clamp(b.life / 0.4, 0.0, 1.0); // 1 → 0 over the stamp death
		float pr = 1.0 - lf;
		p *= 1.0 + smoothstep(0.75, 1.0, pr) * 0.30; // it slumps down at the end
		bot_sprite(p, b, t);
		float flash = pr * pr * (1.0 - smoothstep(0.88, 1.0, pr) * 0.8); // ease-in, then it cools
		base = mix(base, vec3(1.35, 0.40, 0.14), flash * 0.95);          // RED-hot, not white
		base *= 1.0 - smoothstep(0.8, 1.0, pr) * 0.6;                    // charring toward the husk
		add *= 1.0 - pr;
		add += PAL_ACCENT * flash * 0.5 * cov; // and it glows as it goes
	}
	else if (b.kind == KIND_DYING) {
		// the machine dies in place and POPS: an instant puff, a HARD white-hot
		// silhouette (pure base — no bloom, so it's a crisp comic pop, not a blur) and
		// short radial burst streaks snapping outward. Then it shudders and chars down
		// toward the husk. The effect wears the mech — no circles, no orbs.
		float prog = 1.0 - clamp(b.life / DEATH_T, 0.0, 1.0);
		float pop = exp(-prog * 9.0);
		p /= 1.0 + 0.25 * pop; // squash-and-stretch: an instant puff, deflating fast
		p += vec2(sin(pc.time * 47.0 + float(v_id)), cos(pc.time * 53.0 + float(v_id))) * 2.2 * (1.0 - prog);
		bot_sprite(p, b, t);
		base = mix(base, vec3(1.05, 0.85, 0.62), smoothstep(0.16, 0.04, prog) * 0.9); // the hard flash
		if (prog < 0.30) { // comic burst streaks — crisp lines, expanding then gone
			float bp = prog / 0.30;
			for (float i = 0.0; i < 5.0; i += 1.0) {
				float a = (i + 0.5) * (TAU / 5.0) + hash1(v_id * 77u) * TAU;
				vec2 q = rot2(a) * p;
				float r0 = b.radius * (1.3 + 1.8 * bp);
				float r1 = r0 + b.radius * (0.9 - 0.6 * bp);
				lay(vec3(0.95, 0.82, 0.65), soft(sd_seg(q, vec2(r0, 0.0), vec2(r1, 0.0)) - 1.3) * (1.0 - bp * bp));
			}
		}
		base *= 1.0 - 0.72 * prog; // charring down — hands off near the husk's darkness
		add *= 1.0 - prog;         // every light dies with it: the husk emits NOTHING
		burst(p, b);
	}
	else {
		float dmgJ = 1.0 - clamp(b.hp / max_hp(b.variant), 0.0, 1.0);
		if (dmgJ > 0.3) { // crippled machines LIMP — a slow heavy sway, not a vibration
			p += vec2(sin(pc.time * 6.0 + float(v_id)), cos(pc.time * 7.0 + float(v_id))) * (dmgJ - 0.3) * 2.2;
		}
		bot_sprite(p, b, t);
		if (b.life > 0.0 && b.hp > -50.0) { base = mix(base, vec3(1.5, 0.62, 0.28), min(b.life, 1.0) * 0.85); } // hit flash (never on stamped bots)
	}
	// the LIVE shockwaves reach into this shader: physics publishes each blast's center
	// + front progress (STATS[2..] — the same list the composite warps the screen with),
	// and as a front sweeps a bot's distance it rim-lights it FROM the blast point. The
	// radial effect reads on the bodies themselves, perfectly synced with the wave.
	if (b.kind == KIND_ENEMY || (b.kind == KIND_DYING && b.variant != VAR_BOOM && b.variant != VAR_SPARK)) {
		uint nb = min(STATS[2], 8u);
		for (uint i = 0u; i < nb; i++) {
			vec2 bpos = vec2(uintBitsToFloat(STATS[3u + i * 3u]), uintBitsToFloat(STATS[4u + i * 3u]));
			float bprog = uintBitsToFloat(STATS[5u + i * 3u]);
			vec2 relb = b.pos - bpos;
			float d = max(length(relb), 0.001);
			float R = mix(10.0, BOOM_R, pow(bprog, 0.6));
			// a bot lights up exactly when the front passes through it — a NARROW band,
			// so it's strictly one by one, travelling outward with the wave
			float eff = exp(-pow(d - R, 2.0) / 700.0) * (1.0 - bprog);
			if (eff < 0.02) { continue; }
			vec2 toBlast = rot2(-b.angle) * (-relb / d); // direction to the blast, body frame
			float facing = clamp(dot(p, toBlast) / max(b.radius, 1.0), 0.0, 1.0); // lit on the blast side
			base = mix(base, vec3(1.2, 0.45, 0.15), eff * facing * 0.40 * cov);
			add += PAL_ACCENT * eff * facing * 0.15 * cov;
		}
	}
	// caught in the truck's high-beams: a gentle pick-out, not a whitewash — the paint
	// (and the camo) must survive the light
	if (b.kind != KIND_PLAYER) {
		vec2 relb = b.pos - pc.player;
		vec2 fdir = vec2(cos(pc.angle), sin(pc.angle));
		float alongb = dot(relb, fdir);
		if (alongb > 0.0) {
			float latb = abs(dot(relb, vec2(-fdir.y, fdir.x)));
			float spread = 24.0 + alongb * 0.40; // matches the ground beam in city.frag
			float beam = exp(-latb * latb / (spread * spread)) * smoothstep(760.0, 30.0, alongb)
			           * smoothstep(40.0, 260.0, alongb);
			base += (base * 1.4 + vec3(0.055, 0.050, 0.040)) * beam * cov; // lifts the paint, keeps its hue
			add += vec3(1.0, 0.92, 0.75) * beam * 0.06 * cov;
		}
	}
	// fake-3D occlusion: bodies live ON THE GROUND — march the same city silhouettes
	// city.frag draws, and if a building covers this pixel the building is in front (a
	// bot on the street behind a tower must NOT be painted onto its roof). This also
	// clips legs/sparks poking into facades at ground level. Salvage drones, artillery
	// shells, hoisted wrecks (variant flag), the airborne ally classes (suicide drones,
	// bombers) and the player's WING fly ABOVE it all and skip the test.
	if (b.kind != KIND_HELPER && b.kind != KIND_BULLET
	    && !(b.kind == KIND_WRECK && b.variant == 1u)
	    && !(b.kind == KIND_ALLY && (b.variant == VAR_SUICIDE || b.variant == VAR_BOMBER))
	    && !(b.kind == KIND_PLAYER && b.variant == RIDE_WING)
	    && (cov > 0.003 || dot(add, add) > 0.00001)) {
		// building occlusion: a bot behind a building must not paint onto its roof. This
		// used to re-march house_at 8× here; now it's one fetch of the SAME baked cache
		// city.frag reads. Alpha > 0.75 = a HOUSE hit (0.5 plinth doesn't occlude — bots
		// stand on the plinth yard), byte-identical to the old house-only test.
		vec2 g0 = pc.cam + (gl_FragCoord.xy - pc.screen * 0.5) * ZOOM;
		ivec2 tx = ivec2(floor((g0 - vec2(CACHE_ORIGIN)) / ZOOM));
		if (all(greaterThanEqual(tx, ivec2(0))) && all(lessThan(tx, ivec2(int(CACHE_DIM))))
		    && texelFetch(TEXS[IMG_CITYC], tx, 0).a > 0.75) { discard; }
	}
	o_color = vec4(base * cov + add, cov); // premultiplied; `add` is pure emissive
}
