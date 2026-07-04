package main

import "core:fmt"
import "core:math"
import "core:os"
import "core:strings"
import "core:time"
import SDL "vendor:sdl3"
import "vendor:stb/image"
import vk "vendor:vulkan"

// ── the headless DEV HARNESS ──────────────────────────────────────────────────
// A wholly SEPARATE binary — the shipped game contains no headless/drive/profiling code.
// tools/build.odin copies every game .odin file EXCEPT main.odin next to this one (into
// tools/devharness/gen) and compiles them together, so the harness reuses the game's real
// run_game() loop, driving it through the single dev_tick seam (app.odin) + the dev_present
// seam (vk.odin). Modes (argv[1]):
//   gpuav — drive 90 frames under GPU-Assisted validation, exit 0 if clean (build gate).
//   shot  — drive + screenshot .debug_screenshots/vk.jpg, exit (visual verification).
//   test  — drive 600 frames, print the per-pass GPU profile (perf).
// TMM_W/TMM_H/TMM_HIDDEN size the off-screen render (profile.sh uses them for 4K).

Mode :: enum { Gpuav, Shot, Test }
h_mode: Mode
h_loop: bool // TMM_PROFILE_LOOP=1: `test` drives forever (an external profiler — ngfx/nsys — owns the lifetime)
h_shot_path := ".debug_screenshots/vk.jpg"

// screenshot state: dev_present records a swapchain→buffer copy when `want`, dev_tick saves
// it one frame later (after the copy's fence, via DeviceWaitIdle).
h_shot: struct { want, recorded, saved: bool, buf: vk.Buffer, mem: vk.DeviceMemory, mapped: rawptr, w, h: u32 }

main :: proc() {
	if len(os.args) > 1 {
		switch os.args[1] {
		case "gpuav": h_mode = .Gpuav
		case "shot":  h_mode = .Shot
		case "test":  h_mode = .Test
		case:         fmt.eprintln("devharness: unknown mode", os.args[1], "(gpuav|shot|test)"); os.exit(2)
		}
	}
	// off-screen for every mode (no desktop flash); size overridable for profiling.
	dev_hidden = true
	if s := os.get_env("TMM_W", context.temp_allocator); s != "" { if v, ok := parse_i32(s); ok { dev_win.x = v } }
	if s := os.get_env("TMM_H", context.temp_allocator); s != "" { if v, ok := parse_i32(s); ok { dev_win.y = v } }
	h_loop = os.get_env("TMM_PROFILE_LOOP", context.temp_allocator) == "1"

	vk_gpuav = h_mode == .Gpuav        // GPU-Assisted validation config (read by vk_init)
	dev_tick = harness_tick            // the per-frame drive + exit (app.odin seam)
	if h_mode == .Shot { dev_present = harness_present } // capture hook (vk.odin seam)

	run_game() // reuses the game's real loop; returns when a drive sets should_quit

	switch h_mode {
	case .Gpuav: fmt.println("GPU-AV pass: clean (no runtime validation errors)"); os.exit(0)
	case .Shot:  if !h_shot.saved { fmt.eprintln("shot: exited without a capture"); os.exit(1) }; os.exit(0)
	case .Test:  os.exit(0)
	}
}

parse_i32 :: proc(s: string) -> (i32, bool) {
	n: i32
	for c in s { if c < '0' || c > '9' { return 0, false }; n = n * 10 + i32(c - '0') }
	return n, len(s) > 0
}

// ── the per-frame seam (app.odin dev_tick): drive input, save a shot, decide to quit ──
harness_tick :: proc(frame_n: int) -> bool {
	// a screenshot copy recorded last frame has completed (its cmd submitted + drained here).
	if h_shot.recorded { vk.DeviceWaitIdle(vkc.device); save_shot(); h_shot.want = false; h_shot.recorded = false; h_shot.saved = true }
	switch h_mode {
	case .Gpuav: return gpuav_drive(frame_n)
	case .Shot:  return shot_drive(frame_n)
	case .Test:  return test_drive(frame_n)
	}
	return true
}

// ── `gpuav`: circle-aim + hold-fire + drive forward, 90 frames, then done ─────
gpuav_drive :: proc(frame_n: int) -> bool {
	ang := f32(frame_n) * 0.05
	input.up, input.fire = true, true
	input.mouse = {f32(win_w) * 0.5 + math.cos(ang) * 240, f32(win_h) * 0.5 + math.sin(ang) * 240}
	return frame_n >= 90
}

// ── `shot`: park in the first block ring NE of the pit, spin + fire + laser, capture ──
@(private = "file") shot_asked: bool
shot_drive :: proc(frame_n: int) -> bool {
	ang := f32(frame_n) * 0.05
	if frame_n == 0 { car_pos = CENTER + {1100, -1100}; cam = car_pos }
	input.fire = true
	input.laser = sim_time >= 4.0
	input.mouse = {f32(win_w) * 0.5 + math.cos(ang) * 240, f32(win_h) * 0.5 + math.sin(ang) * 240}
	if sim_time >= 8.0 && !shot_asked { shot_asked = true; h_shot.want = true } // record next present
	if sim_time >= 20 { fmt.eprintln("shot: no frame captured within the drive window"); os.exit(1) }
	return h_shot.saved
}

// ── `test`: drive forward 600 frames, print the per-pass GPU profile ──────────
@(private = "file") t0, t_last: time.Tick
@(private = "file") t_worst: f64
@(private = "file") t_over: int
@(private = "file") t_gsum: [6]f64
test_drive :: proc(frame_n: int) -> bool {
	now := time.tick_now()
	if frame_n == 0 { t0 = now; t_last = now; car_pos = CENTER + {1100, -1100}; cam = car_pos }
	ft := time.duration_milliseconds(time.tick_diff(t_last, now))
	t_last = now
	if frame_n > 10 {
		if ft > t_worst { t_worst = ft }
		if ft > 16.9 { t_over += 1 }
		for i in 0 ..< 6 { t_gsum[i] += gpu_ms[i] }
	}
	input.up = true
	if h_loop { return false } // external profiler owns the lifetime — never self-exit
	if frame_n == 600 {
		n := f64(frame_n - 10)
		total := time.duration_milliseconds(time.tick_diff(t0, now))
		fmt.printfln("600 frames: avg %.2f ms, worst %.2f ms, %d over 16.9ms", total / 599.0, t_worst, t_over)
		fmt.printfln("GPU avg ms — physics %.2f | city %.2f | bodies %.2f | bloom %.2f | composite %.2f | total %.2f",
			t_gsum[0] / n, t_gsum[1] / n, t_gsum[2] / n, t_gsum[3] / n, t_gsum[4] / n, t_gsum[5] / n)
		fmt.println("(CPU-side timing: run profile.sh --cpu for the nsys Vulkan-API breakdown)")
		return true
	}
	return false
}

// ── screenshot capture (vk.odin dev_present seam + save) ──────────────────────
// Owns the swapchain's final transition: copies it out when a shot is pending, else the
// plain COLOR→PRESENT the game normally does.
harness_present :: proc(cmd: vk.CommandBuffer, img: u32) {
	if h_shot.want {
		ensure_shot_buf(vkc.extent.width, vkc.extent.height)
		image_barrier(cmd, vkc.images[img], .COLOR_ATTACHMENT_OPTIMAL, .TRANSFER_SRC_OPTIMAL, {.COLOR_ATTACHMENT_WRITE}, {.TRANSFER_READ}, {.COLOR_ATTACHMENT_OUTPUT}, {.COPY})
		region := vk.BufferImageCopy{imageSubresource = {aspectMask = {.COLOR}, layerCount = 1}, imageExtent = {vkc.extent.width, vkc.extent.height, 1}}
		vk.CmdCopyImageToBuffer(cmd, vkc.images[img], .TRANSFER_SRC_OPTIMAL, h_shot.buf, 1, &region)
		image_barrier(cmd, vkc.images[img], .TRANSFER_SRC_OPTIMAL, .PRESENT_SRC_KHR, {.TRANSFER_READ}, {}, {.COPY}, {.BOTTOM_OF_PIPE})
		h_shot.recorded = true
	} else {
		image_barrier(cmd, vkc.images[img], .COLOR_ATTACHMENT_OPTIMAL, .PRESENT_SRC_KHR, {.COLOR_ATTACHMENT_WRITE}, {}, {.COLOR_ATTACHMENT_OUTPUT}, {.BOTTOM_OF_PIPE})
	}
}

ensure_shot_buf :: proc(w, h: u32) {
	if h_shot.buf != 0 && h_shot.w == w && h_shot.h == h { return }
	if h_shot.buf != 0 { vk.DestroyBuffer(vkc.device, h_shot.buf, nil); vk.FreeMemory(vkc.device, h_shot.mem, nil) }
	h_shot.w, h_shot.h = w, h
	h_shot.buf, h_shot.mem, h_shot.mapped = create_buffer(vk.DeviceSize(w * h * 4), true)
}

save_shot :: proc() {
	w, h := int(h_shot.w), int(h_shot.h)
	rgb := make([]u8, w * h * 3)
	defer delete(rgb)
	src := ([^]u8)(h_shot.mapped)
	for i in 0 ..< w * h { rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2] = src[i * 4 + 2], src[i * 4 + 1], src[i * 4] } // BGRA→RGB
	os.make_directory(".debug_screenshots")
	image.write_jpg(strings.clone_to_cstring(h_shot_path, context.temp_allocator), i32(w), i32(h), 3, raw_data(rgb), 90)
	fmt.println("saved", h_shot_path)
}
