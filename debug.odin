package main

import "core:fmt"
import "core:math"
import "core:os"
import "core:time"

// Debug + test harness — headless drive, screenshots and input injection. Compiled
// only in debug builds; the game is ALWAYS built with -debug (tools/build.odin), and
// `gpuav`/`shot`/`test` all run that one binary, so `when ODIN_DEBUG` always holds.
//
// Input injection: the loop (main.odin) calls dbg_drive_frame() every frame, AFTER it
// has read the live keyboard/mouse, so a drive can override `input` (car.odin) — WASD =
// input.up/down/left/right, aim = input.mouse, LMB = input.fire. game_init() = the BACKSPACE key.
when DBG_BUILD {

// Screenshot: queue a capture of the next composited swapchain frame → JPEG at `path`.
// The fence-wait + save lives in vk.odin's frame_end; `shot.want` clears once it lands,
// which is what the drives below wait on before they quit.
dbg_screenshot :: proc(path: string) { vk_request_shot(path) }
dbg_shot_done  :: proc() -> bool { return !shot.want }
dbg_exit       :: proc() { should_quit = true }

// Test hook — set by @(init) ONLY when built with -define:DEBUG_TEST=true (run.sh's
// `test` mode). A normal/`shot`/`gpuav` build leaves it nil, so debug_test_run can never
// hijack those runs. Mirrors ../fishlab's harness.
dbg_test_fn: proc()
dbg_upd_ms, dbg_rnd_ms: f64 // per-frame CPU spans measured by the main loop (update, record)
dbg_acq_ms, dbg_sub_ms: f64 // fence+acquire (main loop, pre-input), submit+present (render)
when #config(DEBUG_TEST, false) {
	@(init)
	dbg_test_init :: proc "contextless" () { dbg_test_fn = debug_test_run }
}

// Dispatch by launch mode. `shot`/`gpuav` are the built-in canned drives (no define
// needed); a -define:DEBUG_TEST=true build additionally runs debug_test_run.
dbg_drive_frame :: proc(frame_n: int) {
	if gpuav_mode { gpuav_drive(frame_n); return }
	if shot_mode  { shot_drive(frame_n);  return }
	if dbg_test_fn != nil { dbg_test_fn() }
}

// ── `./run.sh shot`: circle-aim + hold-fire + drive forward so the GPU work is
// exercised, let the assault close in for a few seconds, screenshot the composited
// frame, then quit — but only AFTER the shot actually saves. The old code quit on a
// fixed timer whether or not a frame had captured, so a transient swapchain-recreate in
// that window silently exited 0 with no file. Now we wait for the save, and fail LOUD
// (non-zero) if it never comes rather than passing off an empty run.
@(private="file") shot_requested: bool
shot_drive :: proc(frame_n: int) {
	ang := f32(frame_n) * 0.05
	// park in the first block ring NE of the pit (spawn sits in the monumental plaza,
	// where no buildings are) and spin + fire — the shot should show terraces, streets,
	// turrets, horde, shells and the laser together
	if frame_n == 0 { car_pos = CENTER + {1100, -1100}; cam = car_pos }
	input.fire = true
	input.laser = sim_time >= 4.0
	input.mouse = {f32(win_w) * 0.5 + math.cos(ang) * 240, f32(win_h) * 0.5 + math.sin(ang) * 240}
	if sim_time >= 8.0 && !shot_requested { shot_requested = true; dbg_screenshot(".debug_screenshots/vk.jpg") }
	if shot_requested && dbg_shot_done() { should_quit = true }
	if sim_time >= 20 { fmt.eprintln("shot: no frame captured within the drive window"); os.exit(1) }
}

// ── `./toomanymachines gpuav` (build-step GPU-AV pass): the same drive to exercise the
// sim/fire/collision paths under GPU-Assisted validation — no screenshot, fixed length.
gpuav_drive :: proc(frame_n: int) {
	ang := f32(frame_n) * 0.05
	input.up, input.fire = true, true
	input.mouse = {f32(win_w) * 0.5 + math.cos(ang) * 240, f32(win_h) * 0.5 + math.sin(ang) * 240}
	if frame_n >= 90 { should_quit = true }
}

// === INJECT TEST CODE HERE ===  (run: `bash run.sh test`)
// Drive with input.up/down/left/right/fire + input.mouse, capture with
// dbg_screenshot("name"), finish with dbg_exit(). game_init() restarts (BACKSPACE).
debug_test_run :: proc() {
	@(static) step := 0
	@(static) t0, last: time.Tick
	@(static) worst: f64
	@(static) over16: int
	@(static) gsum: [6]f64
	step += 1
	now := time.tick_now()
	if step == 1 { t0 = now; last = now; car_pos = CENTER + {1100, -1100}; cam = car_pos }
	// profile.sh sets TMM_PROFILE=1: keep driving the same fight forever (aim sweeps + fire)
	// so an external profiler (ngfx multi-pass GPU Trace / nsys) owns the process lifetime —
	// no 600-frame report, no self-exit.
	@(static) profiling := -1
	if profiling < 0 { profiling = os.get_env("TMM_PROFILE", context.temp_allocator) == "1" ? 1 : 0 }
	if profiling == 1 {
		input.up, input.fire = true, true
		input.laser = sim_time >= 4.0
		ang := f32(step) * 0.05
		input.mouse = {f32(win_w) * 0.5 + math.cos(ang) * 240, f32(win_h) * 0.5 + math.sin(ang) * 240}
		return
	}
	ft := time.duration_milliseconds(time.tick_diff(last, now))
	last = now
	@(static) usum, rsum, asum, ssum: f64
	if step > 10 {
		if ft > worst { worst = ft }
		if ft > 16.9 { over16 += 1 }
		for i in 0 ..< 6 { gsum[i] += gpu_ms[i] }
		usum += dbg_upd_ms
		rsum += dbg_rnd_ms
		asum += dbg_acq_ms
		ssum += dbg_sub_ms
	}
	input.up = true
	if step == 600 {
		total := time.duration_milliseconds(time.tick_diff(t0, now))
		n := f64(step - 10)
		fmt.printfln("600 frames: avg %.2f ms, worst %.2f ms, %d over 16.9ms", total / 599.0, worst, over16)
		fmt.printfln("GPU avg ms — physics %.2f | city %.2f | bodies %.2f | bloom %.2f | composite %.2f | total %.2f",
			gsum[0] / n, gsum[1] / n, gsum[2] / n, gsum[3] / n, gsum[4] / n, gsum[5] / n)
		fmt.printfln("CPU avg ms — fence+acquire %.2f | update %.2f | record %.2f (submit+present %.2f)",
			asum / n, usum / n, rsum / n, ssum / n)
		dbg_exit()
	}
}

}
