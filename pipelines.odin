package main

import gpu "gpu"
import vk "vendor:vulkan"

// GPU structs come from the shared gpu package (also read by the shader build step).
Body :: gpu.Body
Push :: gpu.Push

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
	// Create the buffers, then back all buffers of a memory class (host-visible vs
	// device-local) from ONE allocation, sub-allocated at aligned offsets — avoids the
	// per-buffer dedicated allocations that best-practices validation flags.
	reqs: [Res]vk.MemoryRequirements
	for spec, r in BUF_SPECS {
		bci := vk.BufferCreateInfo{sType = .BUFFER_CREATE_INFO, size = vk.DeviceSize(spec.size), usage = {.STORAGE_BUFFER, .TRANSFER_DST, .TRANSFER_SRC}, sharingMode = .EXCLUSIVE}
		vkok(vk.CreateBuffer(vkc.device, &bci, nil, &buffers[r]), "CreateBuffer")
		vk.GetBufferMemoryRequirements(vkc.device, buffers[r], &reqs[r])
	}
	classes := [2]bool{true, false}
	for host in classes {
		total: vk.DeviceSize
		type_bits: u32 = 0xFFFFFFFF
		for spec, r in BUF_SPECS { if spec.host_visible == host { total = align_up(total, reqs[r].alignment) + reqs[r].size; type_bits &= reqs[r].memoryTypeBits } }
		if total == 0 { continue }
		props: vk.MemoryPropertyFlags = host ? {.HOST_VISIBLE, .HOST_COHERENT} : {.DEVICE_LOCAL}
		mai := vk.MemoryAllocateInfo{sType = .MEMORY_ALLOCATE_INFO, allocationSize = total, memoryTypeIndex = find_mem_type(type_bits, props)}
		block: vk.DeviceMemory
		vkok(vk.AllocateMemory(vkc.device, &mai, nil, &block), "AllocateMemory")
		mapped: rawptr
		if host { vk.MapMemory(vkc.device, block, 0, total, {}, &mapped) }
		off: vk.DeviceSize
		for spec, r in BUF_SPECS {
			if spec.host_visible != host { continue }
			off = align_up(off, reqs[r].alignment)
			vk.BindBufferMemory(vkc.device, buffers[r], block, off)
			buf_mem[r] = block
			if host { buf_map[r] = rawptr(uintptr(mapped) + uintptr(off)) }
			off += reqs[r].size
		}
	}
	for r in Res { buf_index[r] = bindless_register(buffers[r], vk.DeviceSize(BUF_SPECS[r].size)) }
	if !build_pipelines(&pipelines) { panic("shader compilation failed at startup — see .shadercache/build.log") }
}

align_up :: proc(v, a: vk.DeviceSize) -> vk.DeviceSize { return (v + a - 1) & ~(a - 1) }

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
