package main

import "base:runtime"
import "core:fmt"
import "core:math"
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
g_ctx:        runtime.Context // for "system"-convention Vulkan callbacks

main :: proc() {
	g_ctx = context
	shot_mode: bool // headless: drive + screenshot + exit
	for a in os.args[1:] {
		switch a {
		case "gpuav": gpuav_mode = true
		case "shot":  shot_mode = true
		}
	}
	if !SDL.Init({.VIDEO}) { fmt.panicf("SDL_Init: %s", SDL.GetError()) }
	if !SDL.Vulkan_LoadLibrary(nil) { fmt.panicf("Vulkan_LoadLibrary: %s", SDL.GetError()) }
	window = SDL.CreateWindow("toomanymachines", 960, 600, {.VULKAN, .RESIZABLE, .HIGH_PIXEL_DENSITY})
	if window == nil { fmt.panicf("CreateWindow: %s", SDL.GetError()) }
	update_size()

	vk_init()
	gpu_init()
	game_init()

	last := time.tick_now()
	frame_n := 0
	for !should_quit {
		ev: SDL.Event
		for SDL.PollEvent(&ev) {
			#partial switch ev.type {
			case .QUIT:
				should_quit = true
			case .WINDOW_RESIZED, .WINDOW_PIXEL_SIZE_CHANGED:
				update_size()
				vk_resize()
			case .KEY_DOWN:
				#partial switch ev.key.scancode {
				case .ESCAPE: should_quit = true
				case .R:      game_init()
				case .W:      input.up = true
				case .S:      input.down = true
				case .A:      input.left = true
				case .D:      input.right = true
				}
			case .KEY_UP:
				#partial switch ev.key.scancode {
				case .W: input.up = false
				case .S: input.down = false
				case .A: input.left = false
				case .D: input.right = false
				}
			}
		}

		now := time.tick_now()
		dt := clamp(f32(time.duration_seconds(time.tick_diff(last, now))), 0, 1.0 / 30.0)
		last = now
		sim_time += dt

		mx, my: f32
		btn := SDL.GetMouseState(&mx, &my)
		input.aim = {mx * mouse_scale, my * mouse_scale}
		input.fire = .LEFT in btn

		if shot_mode || gpuav_mode { // headless drive: sweep-fire so the GPU work is exercised
			input.fire = true
			ang := f32(frame_n) * 0.06
			input.aim = player_pos + [2]f32{math.cos(ang), math.sin(ang)} * 400
			if shot_mode && frame_n == 100 { vk_request_shot(".debug_screenshots/vk.jpg") }
			if frame_n >= (shot_mode ? 115 : 90) { should_quit = true }
		}

		game_update(dt)
		vk_render(dt)

		frame_n += 1
		if frame_n % 30 == 0 && !gpuav_mode { hot_reload_poll() } // live .glsl reload
		free_all(context.temp_allocator)
	}
	if gpuav_mode { fmt.println("GPU-AV pass: clean (no runtime validation errors)") }
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
