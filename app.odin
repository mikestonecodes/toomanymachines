package main

import "base:runtime"
import SDL "vendor:sdl3"

// Shared platform state — the window + the globals every subsystem reads. Lives apart from
// main.odin (the game loop) so the offline city-cache baker (tools/citybake) can reuse all
// of this while supplying its OWN main: the build copies every game .odin file EXCEPT
// main.odin into the baker, so exactly one `main` exists there.

// The debug harness (drive/screenshot/per-frame timers, debug.odin) compiles when the
// build is -debug OR built for profiling (-define:DEBUG_TEST=true). The latter lets
// profile.sh build a RELEASE binary (validation OFF — ngfx/nsys need it off) that still
// carries the auto-drive + gpu_ms timers.
DBG_BUILD :: ODIN_DEBUG || #config(DEBUG_TEST, false)

window:       ^SDL.Window
win_w, win_h: u32
mouse_scale:  f32 = 1
should_quit:  bool
sim_time:     f32
gpuav_mode:   bool // `gpuav` build-step pass: enable GPU-Assisted validation (see vk.odin)
shot_mode:    bool // `shot` headless pass: drive + screenshot + exit (see debug.odin)
g_ctx:        runtime.Context // for "system"-convention Vulkan callbacks

update_size :: proc() {
	pw, ph, lw: i32
	SDL.GetWindowSizeInPixels(window, &pw, &ph)
	SDL.GetWindowSize(window, &lw, nil)
	if pw > 0 && ph > 0 {
		win_w, win_h = u32(pw), u32(ph)
		if lw > 0 { mouse_scale = f32(pw) / f32(lw) }
	}
}
