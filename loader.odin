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
// pipelines built / total). The bar only exists when the runtime cache didn't
// (pipe_cache_seeded): a seeded cache builds in ~1ms and goes straight to the game.
// (If a driver/GPU swap invalidates the seeded blob, that one launch compiles slow
// with no bar — the save after the build refreshes the file, so it self-heals.)
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
	if !pipe_cache_seeded {
		bar = make_graphics_pipeline("shaders/spv/fs_tri.vert.spv", "shaders/spv/loader.frag.spv", .None, false)
		if bar == 0 { fmt.panicf("loader shader missing — run ./run.sh") }
	}
	for !sync.atomic_load(&build_done) {
		if bar == 0 { time.sleep(time.Millisecond); continue } // seeded cache: just wait out the ~1ms build
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
