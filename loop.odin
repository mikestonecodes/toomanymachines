package main

import "core:fmt"
import "core:os"
import "core:time"
import SDL "vendor:sdl3"

// The game loop — shared by the game (main.odin: `main -> run_game`) and the headless dev
// harness (tools/devharness supplies its own main that sets dev_tick, then calls run_game).
// Everything headless/profiling is behind the single `dev_tick` seam (app.odin); the loop
// itself is pure game.
run_game :: proc() {
	g_ctx = context
	if !SDL.Init({.VIDEO}) { fmt.panicf("SDL_Init: %s", SDL.GetError()) }
	when ODIN_OS == .Darwin {
		// The mac dist ships MoltenVK (Vulkan-on-Metal) inside the .app: point SDL at it, and force
		// Metal tier-2 argument buffers — the renderer is bindless (unsized runtime descriptor
		// arrays + update-after-bind), which MoltenVK can only honor through argument buffers. Set
		// in-process (not just the .app Info.plist) so it holds whether the app is launched from
		// Finder or a terminal — LSEnvironment only applies to Finder/`open`. overwrite=false leaves
		// any value the user set. @executable_path is expanded by dyld when SDL dlopens the driver.
		_ = SDL.SetHint(SDL.HINT_VULKAN_LIBRARY, "@executable_path/../Frameworks/libMoltenVK.dylib")
		_ = SDL.setenv_unsafe("MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS", "1", b32(false))
	}
	// A dist build ships the binary beside its data (shaders/spv + assets/); a macOS .app keeps
	// them in Contents/Resources. Run from that dir so the relative asset paths resolve however
	// the app was launched (Finder starts a .app with cwd = /). SDL_GetBasePath is the executable
	// dir on Windows/Linux and the .app Resources dir on macOS; in a dev build the binary sits at
	// the repo root, so this is a no-op.
	if base := SDL.GetBasePath(); base != nil { _ = os.change_directory(string(base)) }
	if !SDL.Vulkan_LoadLibrary(nil) { fmt.panicf("Vulkan_LoadLibrary: %s", SDL.GetError()) } // reads SDL_VULKAN_LIBRARY (mac dist: bundled MoltenVK)
	flags := SDL.WindowFlags{.VULKAN, .RESIZABLE, .HIGH_PIXEL_DENSITY}
	if dev_hidden { flags += {.HIDDEN} } // headless harness renders off-screen
	window = SDL.CreateWindow("toomanymachines", dev_win.x, dev_win.y, flags)
	if window == nil { fmt.panicf("CreateWindow: %s", SDL.GetError()) }
	_ = SDL.HideCursor() // the game draws its own reticle (composite.frag)
	update_size()

	vk_init()
	render_init()
	game_init()
	city_cache_load() // the static building layer, pre-baked → sampled by city.frag/body.frag

	last := time.tick_now()
	frame_n := 0
	resized := false
	for !should_quit {
		// Block FIRST: the previous frame's fence + swapchain acquire is where the loop waits
		// out the display. Sampling input AFTER it means the frame is recorded from input
		// microseconds old instead of a whole refresh stale.
		cmd, img, frame_ok := frame_begin()

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

		// the ONE dev seam: the headless harness overrides input with its canned drive,
		// saves a pending screenshot, and returns true when its run is done. nil in the game.
		if dev_tick != nil && dev_tick(frame_n) { should_quit = true }

		game_update(dt)
		if frame_ok { render(dt, cmd, img) }

		if resized { resized = false; update_size(); vk_resize() }
		frame_n += 1
		// Shader hot reload: pick up .spv the watcher recompiled (the human's watch loop runs the
		// release build, so this can't be ODIN_DEBUG-gated). Skipped under a dev drive — a reload
		// racing a headless capture/validation pass must not yank the pipelines mid-run.
		if dev_tick == nil && frame_n % 30 == 0 { hot_reload_poll() }
		free_all(context.temp_allocator)
	}
}
