package main

import "base:runtime"
import SDL "vendor:sdl3"

// Shared platform state — the window + the globals every subsystem reads. Lives apart from
// main.odin (which is now just `main -> run_game`) so the offline baker (tools/citybake) and
// the headless dev harness (tools/devharness) can reuse all of this while supplying their
// OWN main: the build copies every game .odin file EXCEPT main.odin into each harness.

window:       ^SDL.Window
win_w, win_h: u32
mouse_scale:  f32 = 1
should_quit:  bool
sim_time:     f32
g_ctx:        runtime.Context // for "system"-convention Vulkan callbacks

// The ONE dev seam in the game loop. nil in the shipped game; the headless harness
// (tools/devharness) sets it to override input (its canned drive), save a requested
// screenshot, and decide when to quit. Called once per frame, after live input is sampled.
// Returns true to stop the loop. Everything headless/profiling lives behind this — the game
// source carries no shot/gpuav/test/timing code.
dev_tick: proc(frame_n: int) -> bool

// Initial window sizing, overridable by the harness (headless passes render off-screen at a
// target resolution). The game uses the defaults.
dev_win:    [2]i32 = {960, 600}
dev_hidden: bool

update_size :: proc() {
	pw, ph, lw: i32
	SDL.GetWindowSizeInPixels(window, &pw, &ph)
	SDL.GetWindowSize(window, &lw, nil)
	if pw > 0 && ph > 0 {
		win_w, win_h = u32(pw), u32(ph)
		if lw > 0 { mouse_scale = f32(pw) / f32(lw) }
	}
}
