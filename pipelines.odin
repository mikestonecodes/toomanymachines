package main

import vk "vendor:vulkan"

// Data-driven GPU resources (like the old render.odin): list buffers in BUF_SPECS
// and pipelines in PIPE_SPECS; gpu_init creates + bindlessly registers each buffer
// and builds each pipeline. Adding a buffer = one row (it auto-gets a bindless slot
// in buf_index, which you pass to shaders via push constants). Constants MUST match
// shaders/common.glsl.

GRID_SIZE  :: 32
GRID_CELLS :: GRID_SIZE * GRID_SIZE
CELL_CAP   :: 32
MODE_COUNT :: 3
BODY_COUNT :: 1 + MAX_ENEMIES + MAX_BULLETS

// GPU structs — injected into GLSL via shaders/gen.glsl (see GLSL_STRUCTS).
Body :: struct { pos, vel: [2]f32, radius, life: f32, kind: u32 }
Push :: struct { screen, player: [2]f32, dt, time, cell_size: f32, mode, body_i, gcount_i, gitem_i: u32 }

GLSL_STRUCTS := [?]GlslStruct{{type_info_of(Body), "Body"}, {type_info_of(Push), "Push"}}

// ── buffer table ──
Res :: enum { Body, GridCount, GridItem }
BufSpec :: struct { size: u64, host_visible: bool }
BUF_SPECS := [Res]BufSpec{
	.Body      = {u64(size_of(Body) * BODY_COUNT), true}, // host-visible: CPU writes player + bullets
	.GridCount = {u64(4 * GRID_CELLS), false},
	.GridItem  = {u64(4 * GRID_CELLS * CELL_CAP), false},
}
buffers:   [Res]vk.Buffer
buf_mem:   [Res]vk.DeviceMemory
buf_map:   [Res]rawptr
buf_index: [Res]u32 // slot in the bindless array

// ── pipeline table ──
Pipe :: enum { Physics, Circle }
PipeSpec :: struct { compute: bool, shaders: []string }
PIPE_SPECS := [Pipe]PipeSpec{
	.Physics = {true, {"shaders/physics.comp"}},
	.Circle  = {false, {"shaders/circle.vert", "shaders/circle.frag"}},
}
pipelines: [Pipe]vk.Pipeline

gpu_init :: proc() {
	write_gen_glsl() // Odin structs → shaders/gen.glsl
	for spec, r in BUF_SPECS {
		buffers[r], buf_mem[r], buf_map[r] = create_buffer(vk.DeviceSize(spec.size), spec.host_visible)
		buf_index[r] = bindless_register(buffers[r], vk.DeviceSize(spec.size))
	}
	if !build_pipelines(&pipelines) { panic("shader compilation failed at startup — see .shadercache/build.log") }
}

build_pipelines :: proc(out: ^[Pipe]vk.Pipeline) -> (ok: bool) {
	ok = true
	for spec, p in PIPE_SPECS {
		out[p] = spec.compute ? make_compute_pipeline(spec.shaders[0]) : make_graphics_pipeline(spec.shaders[0], spec.shaders[1])
		if out[p] == 0 { ok = false }
	}
	return
}

// Rebuild all pipelines in place (hot reload). On a shader compile error, keep the
// running pipelines.
rebuild_pipelines :: proc() {
	vk.DeviceWaitIdle(vkc.device)
	newp: [Pipe]vk.Pipeline
	if !build_pipelines(&newp) {
		for p in Pipe { if newp[p] != 0 { vk.DestroyPipeline(vkc.device, newp[p], nil) } }
		return
	}
	for p in Pipe { vk.DestroyPipeline(vkc.device, pipelines[p], nil) }
	pipelines = newp
}
