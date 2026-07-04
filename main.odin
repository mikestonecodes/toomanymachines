package main

import "base:runtime"
import "core:fmt"
import "core:os"
import "core:time"
import SDL "vendor:sdl3"

// Window + loop. Renderer is raw Vulkan (vk.odin); GPU resources are data-driven
// (pipelines.odin); the game is CPU player + GPU sim (car.odin + shaders/).

window:       ^SDL.Window
win_w, win_h: u32
mouse_scale:  f32 = 1
should_quit:  bool
sim_time:     f32
gpuav_mode:   bool // `gpuav` build-step pass: enable GPU-Assisted validation (see vk.odin)
shot_mode:    bool // `shot` headless pass: drive + screenshot + exit (see debug.odin)
g_ctx:        runtime.Context // for "system"-convention Vulkan callbacks

main :: proc() {
	g_ctx = context
	for a in os.args[1:] {
		switch a {
		case "gpuav": gpuav_mode = true
		case "shot":  shot_mode = true
		}
	}
	if !SDL.Init({.VIDEO}) { fmt.panicf("SDL_Init: %s", SDL.GetError()) }
	if !SDL.Vulkan_LoadLibrary(nil) { fmt.panicf("Vulkan_LoadLibrary: %s", SDL.GetError()) }
	// The gpuav + shot passes drive the sim off-screen — hidden window, no flash on the desktop.
	flags := SDL.WindowFlags{.VULKAN, .RESIZABLE, .HIGH_PIXEL_DENSITY}
	if gpuav_mode || shot_mode { flags += {.HIDDEN} }
	window = SDL.CreateWindow("toomanymachines", 960, 600, flags)
	if window == nil { fmt.panicf("CreateWindow: %s", SDL.GetError()) }
	_ = SDL.HideCursor() // the game draws its own reticle (composite.frag)
	update_size()

	vk_init()
	render_init()
	game_init()

	last := time.tick_now()
	frame_n := 0
	resized := false
	for !should_quit {
		// Block FIRST: the previous frame's fence + swapchain acquire is where the loop waits
		// out the display. Sampling input AFTER it means the frame is recorded from input
		// microseconds old instead of a whole refresh stale.
		when ODIN_DEBUG { dbg_t2 := time.tick_now() }
		cmd, img, frame_ok := frame_begin()
		when ODIN_DEBUG { dbg_acq_ms = time.duration_milliseconds(time.tick_diff(dbg_t2, time.tick_now())) }

		ev: SDL.Event
		for SDL.PollEvent(&ev) {
			#partial switch ev.type {
			case .QUIT:
				should_quit = true
			case .WINDOW_RESIZED, .WINDOW_PIXEL_SIZE_CHANGED:
				resized = true // an image is already acquired — recreate only after it presents
			case .KEY_DOWN:
				#partial switch ev.key.scancode {
				case .ESCAPE:    should_quit = true
				case .BACKSPACE: game_init() // restart (R is a weapon key now)
				case .TAB:       ride = (ride + 1) % len(RIDES) // cycle the garage
				case .W:      input.up = true
				case .S:      input.down = true
				case .A:      input.left = true
				case .D:      input.right = true
				case .LSHIFT: input.boost = true
				case .SPACE:  input.ebrake = true
				// the GARAGE: 1-9 pick the ride
				case ._1: ride = 0
				case ._2: ride = 1
				case ._3: ride = 2
				case ._4: ride = 3
				case ._5: ride = 4
				case ._6: ride = 5
				case ._7: ride = 6
				case ._8: ride = 7
				case ._9: ride = 8
				// weapons: shell patterns on the QWERTY row (W drives, so it's skipped)…
				case .Q: weapon = .Cannon
				case .E: weapon = .Auto
				case .R: weapon = .Burst
				case .T: weapon = .Rail
				case .Y: weapon = .Mortar
				case .U: weapon = .Lance
				case .I: weapon = .Nova
				case .O: weapon = .Wall
				case .P: weapon = .Airstrike
				// …and the MOUNTED hardware on the bottom row (hold LMB to hose)
				case .Z: weapon = .Sing
				case .X: weapon = .Beams
				case .C: weapon = .Scythe
				case .V: weapon = .Flamer
				case .B: weapon = .Arc
				case .N: weapon = .Vortex
				case .M: weapon = .Mines
				// builds on the home row (A/S/D steer, so F..L carry the variants)
				case .F: style = 0
				case .G: style = 1
				case .H: style = 2
				case .J: style = 3
				case .K: style = 4
				case .L: style = 5
				}
			case .KEY_UP:
				#partial switch ev.key.scancode {
				case .W: input.up = false
				case .S: input.down = false
				case .A: input.left = false
				case .D: input.right = false
				case .LSHIFT: input.boost = false
				case .SPACE:  input.ebrake = false
				}
			}
		}

		now := time.tick_now()
		dt := clamp(f32(time.duration_seconds(time.tick_diff(last, now))), 0, 1.0 / 30.0)
		last = now
		sim_time += dt

		mx, my: f32
		btn := SDL.GetMouseState(&mx, &my)
		input.mouse = {mx * mouse_scale, my * mouse_scale}
		input.fire = .LEFT in btn
		input.laser = .RIGHT in btn

		// Headless drive + test injection override the live input (debug.odin). Always
		// compiled — the game is built -debug, so ODIN_DEBUG holds; a no-op interactively.
		when ODIN_DEBUG { dbg_drive_frame(frame_n) }

		when ODIN_DEBUG { dbg_t := time.tick_now() }
		game_update(dt)
		when ODIN_DEBUG { dbg_upd_ms = time.duration_milliseconds(time.tick_diff(dbg_t, time.tick_now())); dbg_t = time.tick_now() }
		if frame_ok { render(dt, cmd, img) }
		when ODIN_DEBUG { dbg_rnd_ms = time.duration_milliseconds(time.tick_diff(dbg_t, time.tick_now())) }

		if resized { resized = false; update_size(); vk_resize() }
		frame_n += 1
		// Shader hot reload: pick up .spv the watcher recompiled (the human's watch loop runs the
		// release build, so this can't be ODIN_DEBUG-gated). Skipped for BOTH headless passes:
		// they capture/validate exactly what their own build just produced, and a live watch
		// session recompiling alongside must not yank the pipelines mid-drive (a reload racing
		// the screenshot copy was intermittently killing the capture).
		if frame_n % 30 == 0 && !gpuav_mode && !shot_mode { hot_reload_poll() }
		free_all(context.temp_allocator)
	}
	// Headless passes exit HERE, deterministically. The game never tears its Vulkan
	// objects down (process exit is the cleanup), so past this point only driver/SDL
	// atexit handlers would run — and those intermittently crash when another game
	// process (the human's watch session) holds the GPU, failing the build step with
	// a bogus non-zero exit AFTER validation already passed clean. Nothing validated
	// is skipped: the debug callback aborts the instant anything is wrong mid-run.
	if gpuav_mode { fmt.println("GPU-AV pass: clean (no runtime validation errors)"); os.exit(0) }
	if shot_mode { // exit 0 ONLY with a capture on disk — a quit without one must fail LOUD
		if shot.path == "" || shot.want { fmt.eprintln("shot: exited without a capture"); os.exit(1) }
		os.exit(0)
	}
}

update_size :: proc() {
	pw, ph, lw: i32
	SDL.GetWindowSizeInPixels(window, &pw, &ph)
	SDL.GetWindowSize(window, &lw, nil)
	if pw > 0 && ph > 0 {
		win_w, win_h = u32(pw), u32(ph)
		if lw > 0 { mouse_scale = f32(pw) / f32(lw) }
	}
}
