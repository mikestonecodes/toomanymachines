package main

import "core:math"
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
Push :: struct { screen, cam, player, aim: [2]f32, dt, time, muzzle, throttle, boost, laser, city_r: f32, mode: u32 }
Body :: struct { pos, vel: [2]f32, radius, life, hp, angle: f32, kind, variant, gen: u32 }
// @glsl-end

// Grid / layout constants shared with the shaders — generated into GLSL (see the @glsl note above).
// @glsl
GRID_SIZE  :: 192
GRID_CELLS :: GRID_SIZE * GRID_SIZE
CELL_CAP   :: 64
CELL_SIZE  :: WORLD / f32(GRID_SIZE)
BODY_COUNT :: 1 + MAX_ENEMIES + MAX_BULLETS + MAX_TURRETS
IMG_SCENE  :: u32(0)
IMG_BLOOMA :: u32(1)
IMG_BLOOMB :: u32(2)
// @glsl-end
MODE_COUNT :: 3 // CPU-only: number of compute passes per frame

// ── buffers ── the single source of truth. Each row: GLSL accessor macro, element type (its
// bindless view), byte size, host-visible. WRITE IN ENUM ORDER — the row order is the bindless
// slot. tools/gen emits the views + a `<macro>` for each (BODIES = bodyBuf[0].v, …), so shaders
// just say BODIES/GCOUNT/GITEM/CITY. Add a buffer = add a row here and nothing else.
Res :: enum { Body, GridCount, GridItem, Stats }
BUF_SPECS := [Res]BufSpec{
	.Body      = { "BODIES", Body, u64(size_of(Body) * BODY_COUNT), true  }, // host-visible: CPU writes player + bullets
	.GridCount = { "GCOUNT", u32,  u64(4 * GRID_CELLS),             false },
	.GridItem  = { "GITEM",  u32,  u64(4 * GRID_CELLS * CELL_CAP),  false },
	.Stats     = { "STATS",  u32,  u64(4 * 8),                      true  }, // host-visible: GPU counts pit deposits, CPU polls to grow the city
}

// ── offscreen images ── HDR render targets for the post chain, (re)created with the swapchain.
// Row order is the binding-1 bindless slot (IMG_* constants above index them from shaders).
Img :: enum { Scene, BloomA, BloomB }
IMG_SPECS := [Img]ImgSpec{
	.Scene  = {div = 1}, // full-res HDR scene (city + bodies)
	.BloomA = {div = 2}, // half-res bloom ping (bright-extract + horizontal blur)
	.BloomB = {div = 2}, // half-res bloom pong (vertical blur)
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

render_init :: proc() {
	alloc_buffers()
	if !build_pipelines(&pipelines) { panic("shader compilation failed at startup — run ./run.sh") }
}

// One frame: GPU sim (clear → scatter → step), draw city + bodies into the HDR scene,
// bloom it down (bright-extract+H at half res, then V), composite to the swapchain.
render :: proc(dt: f32) {
	cmd, img, ok := frame_begin()
	if !ok { return } // swapchain out of date; recreated for next frame

	w, h := f32(win_w), f32(win_h)
	shake := [2]f32{math.sin(sim_time * 143), math.cos(sim_time * 119)} * cam_shake
	pc := Push{screen = {w, h}, cam = cam + shake, player = car_pos, aim = aim_world, dt = dt, time = sim_time, muzzle = muzzle, throttle = throttle_v, boost = boost_v, laser = laser_v, city_r = city_r}

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

	// HDR scene: procedural city backdrop, then every body as an instanced SDF sprite.
	img_pass_begin(cmd, .Scene)
	pc.mode = 0
	vk.CmdPushConstants(cmd, vkc.pipe_layout, {.COMPUTE, .VERTEX, .FRAGMENT}, 0, size_of(Push), &pc)
	vk.CmdBindPipeline(cmd, .GRAPHICS, pipelines[.City])
	vk.CmdDraw(cmd, 3, 1, 0, 0)
	vk.CmdBindPipeline(cmd, .GRAPHICS, pipelines[.Body])
	vk.CmdDraw(cmd, 6, u32(BODY_COUNT - 1), 0, 1) // the horde, bullets, pylons…
	vk.CmdDraw(cmd, 6, 1, 0, 0)                   // …then the ship, always on top of the crowd
	img_pass_end(cmd, .Scene)

	// Bloom (fishlab's chain): mode 0 = bright-extract + horizontal gaussian (Scene→BloomA),
	// mode 1 = vertical gaussian (BloomA→BloomB). Both at half res.
	vk.CmdBindPipeline(cmd, .GRAPHICS, pipelines[.Bloom])
	for m in 0 ..< 2 {
		pc.mode = u32(m)
		img_pass_begin(cmd, m == 0 ? Img.BloomA : Img.BloomB)
		vk.CmdPushConstants(cmd, vkc.pipe_layout, {.COMPUTE, .VERTEX, .FRAGMENT}, 0, size_of(Push), &pc)
		vk.CmdDraw(cmd, 3, 1, 0, 0)
		img_pass_end(cmd, m == 0 ? Img.BloomA : Img.BloomB)
	}

	// Composite → swapchain: scene + bloom, ACES tonemap, film grain, vignette.
	pass_begin(cmd, img)
	vk.CmdBindPipeline(cmd, .GRAPHICS, pipelines[.Composite])
	vk.CmdDraw(cmd, 3, 1, 0, 0)
	pass_end(cmd, img)

	frame_end(cmd, img)
}
