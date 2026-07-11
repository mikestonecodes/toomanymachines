package main

import "core:fmt"
import "core:math"
import SDL "vendor:sdl3"
import vk "vendor:vulkan"

// The high-level render description — nothing but the buffer/image/pipeline lists, init,
// and the per-frame render(). Every bit of Vulkan mechanics (allocation, pipeline building,
// the frame's acquire/barrier/submit/present scaffolding) lives in vk.odin behind the
// helpers called below.

// ── GPU types → GLSL ──────────────────────────────────────────────────────────
// The CPU↔GPU contract: tools/build.odin copies the block between the @glsl markers verbatim into
// the shader-gen step (tools/gen), which reflects it into shaders/gen.glsl — each struct → a GLSL
// `struct`; the one named `Push` → the push-constant block. (Buffers come from BUF_SPECS; gameplay
// constants from other files' @glsl blocks. Vertex↔fragment varyings are NOT here — they're purely
// shader-side, declared in the graphics pipeline's own .vert/.frag.) Keep the block self-contained
// (builtins only), one struct per line. Scalar layout — Odin default alignment matches GLSL `scalar`.
// @glsl
Push :: struct { screen, cam, player, aim: [2]f32, dt, time, muzzle, throttle, boost, laser, pfire, city_r, angle: f32, mode, pweap: u32 }
Body :: struct { pos, vel: [2]f32, radius, life, hp, angle: f32, kind, variant, gen: u32 }
// @glsl-end

// Grid / layout constants shared with the shaders — generated into GLSL (see the @glsl note above).
// @glsl
GRID_SIZE  :: 192
GRID_CELLS :: GRID_SIZE * GRID_SIZE
CELL_CAP   :: 64
CELL_SIZE  :: WORLD / f32(GRID_SIZE)
BODY_COUNT :: 1 + MAX_ENEMIES + MAX_BULLETS + MAX_TURRETS + MAX_HELPERS + MAX_ALLIES
CITY_KMAX  :: u32(16) // block layout table: rings ×
CITY_JMAX  :: u32(10) //   sectors — the CPU generates it ONCE (game_init), both sides read Res.City
SKID_RES   :: u32(4700) // rubber decal grid: 1 byte per 4×4 world px — the CPU stamps wheel
                        // marks in, city.frag darkens the ground with them (persistent!)
IMG_SCENE  :: u32(0)
IMG_BLOOMA :: u32(1)
IMG_BLOOMB :: u32(2)
IMG_CITYC  :: u32(3)  // the CITY CACHE: the whole static building layer pre-marched once
// (offline bake → assets/city.cache), loaded as a texture the game just SAMPLES instead of
// ray-marching every pixel. 1 texel = ZOOM world px = 1 screen px, so a texel-snapped camera
// makes the NEAREST (texelFetch) fetch byte-identical to the live march it replaced.
IMG_BODYA  :: u32(4)  // the BODY ATLAS: the enemy chassis sprites (spider/skitter/brute) baked
// once (→ assets/body.cache) into a grid of [kind × gait-frame] tiles, so the horde's fragment
// shader (body.frag) samples a tile instead of running ~45 vnoise across 6 procedural legs.
CACHE_DIM    :: u32(8192)   // covers the city disk (CITY_R0 + LEAN·HMAX projection) at full res
CACHE_ORIGIN :: 2867 * ZOOM // world px of texel (0,0); 2867 chosen so ORIGIN/ZOOM is integer
                            // AND ORIGIN + CACHE_DIM·ZOOM/2 ≈ WORLD·0.5 (centered on the city)
// body atlas layout — the baker writes tiles, body.frag reads them (see bake_body.frag):
ATLAS_DIM    :: u32(2048) // square rgba16f atlas
ATLAS_TILE   :: u32(128)  // px per tile
ATLAS_COLS   :: u32(16)   // ATLAS_DIM/ATLAS_TILE — tiles per row
ATLAS_FRAMES :: u32(24)   // gait-phase keyframes per kind (sampled + cross-faded at runtime)
ATLAS_KINDS  :: u32(3)    // 0 spider, 1 skitter, 2 brute (atlas_kind() maps the variant)
ATLAS_RAD    :: f32(15)   // reference body radius the tiles are baked at (proportions are radius-
                          // relative so this cancels at runtime; only the grunge frequency rides it)
ATLAS_EXTK   :: f32(2.6)  // tile half-extent = ATLAS_RAD*ATLAS_EXTK (matches body.vert's enemy quad ext)
// @glsl-end
MODE_COUNT :: 3 // CPU-only: number of compute passes per frame

// ── buffers ── the single source of truth. Each row: GLSL accessor macro, element type (its
// bindless view), byte size, host-visible. WRITE IN ENUM ORDER — the row order is the bindless
// slot. tools/gen emits the views + a `<macro>` for each (BODIES = bodyBuf[0].v, …), so shaders
// just say BODIES/GCOUNT/GITEM/CITY. Add a buffer = add a row here and nothing else.
Res :: enum { Body, GridCount, GridItem, Stats, City, Skid }
BUF_SPECS := [Res]BufSpec{
	.Body      = { "BODIES", Body, u64(size_of(Body) * BODY_COUNT), true  }, // host-visible: CPU writes player + bullets
	.GridCount = { "GCOUNT", u32,  u64(4 * GRID_CELLS),             false },
	.GridItem  = { "GITEM",  u32,  u64(4 * GRID_CELLS * CELL_CAP),  false },
	.Stats     = { "STATS",  u32,  u64(4 * 64),                     true  }, // host-visible: pit counters + per-frame shockwave list (composite distortion)
	.City      = { "CITY",   u32,  u64(4 * CITY_KMAX * CITY_JMAX),  true  }, // host-visible: THE block layout (1 = built, 0 = hosts a carved plaza) — one source, both sides read it
	.Skid      = { "SKID",   u32,  u64(SKID_RES * SKID_RES),        true  }, // host-visible: the rubber decal bytes (CPU stamps, city.frag reads)
}

// ── offscreen images ── HDR render targets for the post chain, (re)created with the swapchain.
// Row order is the binding-1 bindless slot (IMG_* constants above index them from shaders).
Img :: enum { Scene, BloomA, BloomB, CityC, BodyA }
IMG_SPECS := [Img]ImgSpec{
	.Scene  = {div = 1}, // full-res HDR scene (city + bodies)
	.BloomA = {div = 2}, // half-res bloom ping (bright-extract + horizontal blur)
	.BloomB = {div = 2}, // half-res bloom pong (vertical blur)
	// the baked caches are FIXED-size (not swapchain-relative), so they live outside the
	// swapchain create/resize path — bake_cache.odin owns their images + memory.
	.CityC  = {fixed = CACHE_DIM},  // world-anchored static building layer
	.BodyA  = {fixed = ATLAS_DIM},  // [kind × gait-frame] enemy-chassis sprite atlas
}

// ── pipelines ── add one = one row + its compiled .spv stages. `compute` picks the type;
// graphics pipelines pick a `blend` mode and render into the HDR scene format (`hdr`) or the
// swapchain. Every pipeline shares the one bindless descriptor set + push-constant layout.
Pipe :: enum { Physics, City, Body, Bloom, Composite }
PIPE_SPECS := [Pipe]PipeSpec{
	.Physics   = {compute = true, shaders = {"shaders/spv/physics.comp.spv"}},
	.City      = {shaders = {"shaders/spv/fs_tri.vert.spv", "shaders/spv/city.frag.spv"}, hdr = true},
	.Body      = {shaders = {"shaders/spv/body.vert.spv", "shaders/spv/body.frag.spv"}, blend = .Premul, hdr = true},
	.Bloom     = {shaders = {"shaders/spv/fs_tri.vert.spv", "shaders/spv/bloom.frag.spv"}, hdr = true},
	.Composite = {shaders = {"shaders/spv/fs_tri.vert.spv", "shaders/spv/composite.frag.spv"}},
}

// The synchronous init path: the offline baker (tools/bake) and the frozen-sim profiler drive.
render_init :: proc() {
	alloc_buffers()
	if !build_pipelines(&pipelines) { panic("shader compilation failed at startup — run ./run.sh") }
}

// The LOADING SCREEN — fishlab's loader pattern, no threads: draw the bar, compile one
// pipeline, repeat. The first launch on a machine pays the driver's SPIR-V→ISA compile
// (~7s, nearly all in body.frag's ubershader — per-device, so it can't ship pre-built);
// pipeline_cache_save at the end warms the runtime cache (vk.odin), so every later launch
// is instant and the bar just flashes. Progress is real (pipelines built / total); the bar
// sits still through the Body step — accepted, dumb beats smooth here. The profiler drive
// (dev_dt_override >= 0, gpuprof's frozen sim) builds without presents instead: Nsight
// counts PRESENTED frames for its capture window, and loader frames would shift it.
loading_screen :: proc() {
	if dev_dt_override >= 0 { render_init(); return }
	alloc_buffers()
	loader_pipe := make_graphics_pipeline("shaders/spv/fs_tri.vert.spv", "shaders/spv/loader.frag.spv", .None, false)
	if loader_pipe == 0 { fmt.panicf("loader shader missing — run ./run.sh") }
	for spec, p in PIPE_SPECS {
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
		pc := Push{screen = {f32(win_w), f32(win_h)}, pfire = f32(int(p)) / f32(len(PIPE_SPECS))}
		cmd, img, frame_ok := frame_begin()
		if frame_ok {
			pass_begin(cmd, img)
			vk.CmdBindPipeline(cmd, .GRAPHICS, loader_pipe)
			vk.CmdPushConstants(cmd, vkc.pipe_layout, {.COMPUTE, .VERTEX, .FRAGMENT}, 0, size_of(Push), &pc)
			vk.CmdDraw(cmd, 3, 1, 0, 0)
			pass_end(cmd, img)
			frame_end(cmd, img)
		}
		pipelines[p] = spec.compute ? make_compute_pipeline(spec.shaders[0]) : make_graphics_pipeline(spec.shaders[0], spec.shaders[1], spec.blend, spec.hdr)
		if pipelines[p] == 0 { fmt.panicf("shader compilation failed at startup — run ./run.sh") }
	}
	pipeline_cache_save() // warm this machine's ISA cache — the next launch skips the compile
	vk.DeviceWaitIdle(vkc.device) // loader frames drained before the pipeline goes away
	vk.DestroyPipeline(vkc.device, loader_pipe, nil)
}

// One frame: GPU sim (clear → scatter → step), draw city + bodies into the HDR scene,
// bloom it down (bright-extract+H at half res, then V), composite to the swapchain.
render :: proc(dt: f32, cmd: vk.CommandBuffer, img: u32) {
	// frame_begin already ran at the top of the main loop — the fence+acquire block sits
	// BEFORE input sampling so the frame is recorded from fresh input (main.odin).
	w, h := f32(win_w), f32(win_h)
	// camera shake: a firm low-frequency RUMBLE, not a jitter. The old 143/119 rad/s (~22Hz)
	// aliased on a 60fps display into near-random per-frame jumps that read as LAG, especially
	// under rapid fire (Auto) + a wall of blasts pinning cam_shake at its cap. ~9Hz + trimmed
	// amplitude reads as impact without the nausea.
	shake := [2]f32{math.sin(sim_time * 58), math.cos(sim_time * 49)} * cam_shake * 0.6
	// SNAP the view to whole city-cache texels (1 texel = ZOOM world px). Every layer reads
	// pc.cam, so this quantizes the whole frame's pan by ≤1 screen px coherently (no inter-
	// layer shimmer) — and makes each pixel's g0 land on a texel CENTER, so the cache's
	// NEAREST fetch reproduces the old per-pixel march byte-for-byte. Aim/physics keep the
	// unsnapped cam (a ≤1px reticle offset, invisible).
	cs := cam + shake
	scam := [2]f32{math.round(cs.x / ZOOM), math.round(cs.y / ZOOM)} * ZOOM
	// pfire: the mounted weapons' hold envelope — for the SINGULARITY it IS the charge
	pc := Push{screen = {w, h}, cam = scam, player = car_pos, aim = aim_world, dt = dt, time = sim_time, muzzle = muzzle, throttle = throttle_v, boost = boost_v, laser = laser_v, pfire = weapon == .Sing ? sing_charge : fire_v, city_r = city_r, angle = car_angle, pweap = u32(weapon)}

	gpu_label(cmd, "physics")
	vk.CmdBindPipeline(cmd, .COMPUTE, pipelines[.Physics])
	groups := (u32(max(GRID_CELLS, BODY_COUNT)) + 63) / 64
	for m in 0 ..< MODE_COUNT {
		pc.mode = u32(m)
		vk.CmdPushConstants(cmd, vkc.pipe_layout, {.COMPUTE, .VERTEX, .FRAGMENT}, 0, size_of(Push), &pc)
		vk.CmdDispatch(cmd, groups, 1, 1)
		// clear → scatter → step: each pass reads the grid the previous one wrote (RAW). The
		// final pass has no compute reader — its body writes are ordered by the barrier below.
		if m < MODE_COUNT - 1 { mem_barrier(cmd, {.COMPUTE_SHADER}, {.SHADER_WRITE, .SHADER_READ}, {.COMPUTE_SHADER}, {.SHADER_WRITE, .SHADER_READ}) }
	}
	// step → the draw stages read bodies (body.vert/.frag fetch Body, city.frag reads the truck angle)
	mem_barrier(cmd, {.COMPUTE_SHADER}, {.SHADER_WRITE}, {.VERTEX_SHADER, .FRAGMENT_SHADER}, {.SHADER_READ})
	gpu_stamp(cmd, 1) // physics done
	gpu_label_end(cmd)

	// HDR scene: procedural city backdrop, then every body as an instanced SDF sprite.
	img_pass_begin(cmd, .Scene)
	pc.mode = 0
	vk.CmdPushConstants(cmd, vkc.pipe_layout, {.COMPUTE, .VERTEX, .FRAGMENT}, 0, size_of(Push), &pc)
	gpu_label(cmd, "city")
	vk.CmdBindPipeline(cmd, .GRAPHICS, pipelines[.City])
	vk.CmdDraw(cmd, 3, 1, 0, 0)
	gpu_stamp(cmd, 2) // city done
	gpu_label_end(cmd)
	gpu_label(cmd, "bodies")
	vk.CmdBindPipeline(cmd, .GRAPHICS, pipelines[.Body])
	vk.CmdDraw(cmd, 6, u32(BODY_COUNT - 1), 0, 1) // layer 0 (mode=0): ground wrecks, under everything
	pc.mode = 1
	vk.CmdPushConstants(cmd, vkc.pipe_layout, {.COMPUTE, .VERTEX, .FRAGMENT}, 0, size_of(Push), &pc)
	vk.CmdDraw(cmd, 6, u32(BODY_COUNT - 1), 0, 1) // layer 1: the living horde, bullets, pylons…
	vk.CmdDraw(cmd, 6, 1, 0, 0)                   // …then the ship, always on top of the crowd
	img_pass_end(cmd, .Scene)
	gpu_stamp(cmd, 3) // bodies done
	gpu_label_end(cmd)

	// Bloom (fishlab's chain): mode 0 = bright-extract + horizontal gaussian (Scene→BloomA),
	// mode 1 = vertical gaussian (BloomA→BloomB). Both at half res.
	gpu_label(cmd, "bloom")
	vk.CmdBindPipeline(cmd, .GRAPHICS, pipelines[.Bloom])
	for m in 0 ..< 2 {
		pc.mode = u32(m)
		img_pass_begin(cmd, m == 0 ? Img.BloomA : Img.BloomB)
		vk.CmdPushConstants(cmd, vkc.pipe_layout, {.COMPUTE, .VERTEX, .FRAGMENT}, 0, size_of(Push), &pc)
		vk.CmdDraw(cmd, 3, 1, 0, 0)
		img_pass_end(cmd, m == 0 ? Img.BloomA : Img.BloomB)
	}
	gpu_stamp(cmd, 4) // bloom done
	gpu_label_end(cmd)

	// Composite → swapchain: scene + bloom, ACES tonemap, film grain, vignette.
	gpu_label(cmd, "composite")
	pass_begin(cmd, img)
	vk.CmdBindPipeline(cmd, .GRAPHICS, pipelines[.Composite])
	vk.CmdDraw(cmd, 3, 1, 0, 0)
	pass_end(cmd, img)
	gpu_stamp(cmd, 5) // composite done — whole GPU frame
	gpu_label_end(cmd)
	frame_end(cmd, img)
}
