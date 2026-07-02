package main

import gpu "gpu"
import vk "vendor:vulkan"

// The high-level render description — nothing but the buffer list, the pipeline list, init,
// and the per-frame render(). Every bit of Vulkan mechanics (allocation, pipeline building,
// the frame's acquire/barrier/submit/present scaffolding) lives in vk.odin behind the helpers
// called below. Constants MUST match shaders/common.glsl.

// GPU structs come from the shared gpu package (also read by the shader build step).
Body :: gpu.Body
Push :: gpu.Push

GRID_SIZE  :: 32
GRID_CELLS :: GRID_SIZE * GRID_SIZE
CELL_CAP   :: 32
MODE_COUNT :: 3
BODY_COUNT :: 1 + MAX_ENEMIES + MAX_BULLETS

// ── buffers ── add one = one row; alloc_buffers creates it and hands it a bindless slot in
// buf_index, which you pass to shaders via push constants. (BufSpec + storage live in vk.odin.)
Res :: enum { Body, GridCount, GridItem }
BUF_SPECS := [Res]BufSpec{
	.Body      = {u64(size_of(Body) * BODY_COUNT), true}, // host-visible: CPU writes player + bullets
	.GridCount = {u64(4 * GRID_CELLS), false},
	.GridItem  = {u64(4 * GRID_CELLS * CELL_CAP), false},
}

// ── pipelines ── add one = one row + its compiled .spv stages. `compute` picks the type;
// graphics pipelines pick a `blend` mode (ignored for compute). The game loads and hot-watches
// these .spv files; tools/build.odin produces them. (PipeSpec + Blend live in vk.odin.)
Pipe :: enum { Physics, Circle }
PIPE_SPECS := [Pipe]PipeSpec{
	.Physics = {compute = true, shaders = {"shaders/spv/physics.comp.spv"}},
	.Circle  = {shaders = {"shaders/spv/circle.vert.spv", "shaders/spv/circle.frag.spv"}, blend = .Premul},
}

render_init :: proc() {
	alloc_buffers()
	if !build_pipelines(&pipelines) { panic("shader compilation failed at startup — run ./run.sh") }
}

// One frame: GPU sim (clear → scatter → step) then draw one instanced quad per body.
render :: proc(dt: f32) {
	cmd, img, ok := frame_begin()
	if !ok { return } // swapchain out of date; recreated for next frame

	w, h := f32(win_w), f32(win_h)
	cell := max(f32(2 * ENEMY_R_MAX + 2), max(w, h) / f32(GRID_SIZE))
	pc := Push{
		screen = {w, h}, player = player_pos, dt = dt, time = sim_time, cell_size = cell,
		body_i = buf_index[.Body], gcount_i = buf_index[.GridCount], gitem_i = buf_index[.GridItem],
	}

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
	mem_barrier(cmd, {.COMPUTE_SHADER}, {.SHADER_WRITE}, {.VERTEX_SHADER}, {.SHADER_READ}) // step → vertex reads bodies

	pass_begin(cmd, img)
	vk.CmdBindPipeline(cmd, .GRAPHICS, pipelines[.Circle])
	vk.CmdDraw(cmd, 6, u32(BODY_COUNT), 0, 0)
	pass_end(cmd, img)

	frame_end(cmd, img)
}
