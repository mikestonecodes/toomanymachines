package main

import "core:fmt"
import "core:sync"
import "core:thread"
import "core:time"
import SDL "vendor:sdl3"
import vk "vendor:vulkan"

// ── the LOADING SCREEN (bar ported from ../fishlab loader.odin) ────────────────
// The first launch on a machine pays the driver's SPIR-V→ISA compile — per-device,
// so it can't ship pre-built. build_pipelines (vk.odin) fans the shaders out one
// thread each while this thread pumps events and draws loader.frag's bar (progress =
// pipelines built / total). The bar is LAZY: it only appears if the build outlives a
// 100ms grace, so a warm runtime cache (~1ms) goes straight to the game with no flash.
// The profiler drive (dev_dt_override >= 0, gpuprof's frozen sim) builds without
// presents instead — Nsight counts PRESENTED frames for its capture window.

loading_screen :: proc() {
	if dev_dt_override >= 0 { render_init(); return }
	alloc_buffers()
	build_ok, build_done: bool
	worker := thread.create_and_start_with_poly_data2(&build_ok, &build_done, proc(ok, done: ^bool) {
		ok^ = build_pipelines(&pipelines)
		sync.atomic_store(done, true)
	})
	bar: vk.Pipeline
	t0 := time.tick_now()
	for !sync.atomic_load(&build_done) {
		if time.duration_milliseconds(time.tick_diff(t0, time.tick_now())) < 100 {
			time.sleep(5 * time.Millisecond) // the grace window — a warm cache never gets past here
			continue
		}
		if bar == 0 {
			bar = make_graphics_pipeline("shaders/spv/fs_tri.vert.spv", "shaders/spv/loader.frag.spv", .None, false)
			if bar == 0 { fmt.panicf("loader shader missing — run ./run.sh") }
		}
		// drain events: quit is honored right after the load (the compile can't be cancelled),
		// and a resize (the WM tiles the fresh window immediately) must NOT be swallowed —
		// win_w/win_h feed every viewport, and the main loop will never see this event. No
		// image is acquired here, so recreating the swapchain immediately is safe.
		ev: SDL.Event
		for SDL.PollEvent(&ev) {
			#partial switch ev.type {
			case .QUIT: should_quit = true
			case .WINDOW_RESIZED, .WINDOW_PIXEL_SIZE_CHANGED: update_size(); vk_resize()
			}
		}
		pc := Push{screen = {f32(win_w), f32(win_h)}, pfire = f32(sync.atomic_load(&pipes_built)) / f32(len(PIPE_SPECS))}
		cmd, img, frame_ok := frame_begin()
		if frame_ok {
			pass_begin(cmd, img)
			vk.CmdBindPipeline(cmd, .GRAPHICS, bar)
			vk.CmdPushConstants(cmd, vkc.pipe_layout, {.COMPUTE, .VERTEX, .FRAGMENT}, 0, size_of(Push), &pc)
			vk.CmdDraw(cmd, 3, 1, 0, 0)
			pass_end(cmd, img)
			frame_end(cmd, img)
		}
	}
	thread.destroy(worker)
	if !build_ok { fmt.panicf("shader compilation failed at startup — run ./run.sh") }
	if bar != 0 {
		vk.DeviceWaitIdle(vkc.device) // loader frames drained before the pipeline goes away
		vk.DestroyPipeline(vkc.device, bar, nil)
	}
}
