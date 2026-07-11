package main

import "core:fmt"
import "core:mem"
import "core:os"
import vk "vendor:vulkan"

// ── the GENERIC OFFLINE BAKER (game side: LOAD + SAMPLE only) ──────────────────
// Some layers are STATIC and view-independent — the same shader evaluated for the same input
// always returns the same pixels, with no per-frame/time term. Marching them live every frame
// is pure waste. So each such layer is a BAKE JOB: rendered ONCE, offline, into a world/atlas-
// anchored rgba16f texture the shipped game just SAMPLES.
//
// Jobs are data-driven (BAKE_SPECS) — add one row + a baker fragment and nothing else:
//   .City      — the whole static building layer, pre-marched over a world-anchored 8192² texture
//                (RGB = baked HDR color, A = coverage class: 0 none / 0.5 plinth / 1 house).
//   .BodyAtlas — the enemy chassis sprites (spider/skitter/brute), pre-rendered over a grid of
//                [kind × gait-phase] tiles so the horde's fragment shader is a texture fetch, not
//                ~45 vnoise + 6 procedural legs (see bodylib.glsl). ALU→texture, the big bodies win.
//
// The BAKER is a wholly separate harness (tools/bake — its own main), assembled at build time
// from the game sources so the bake reuses the game's REAL vk_init/game_init + the SAME @glsl
// contract. The shipped game carries NO bake code: it LOADS assets/*.cache here and SAMPLES
// (NEAREST for City's texel-snapped march-replacement; LINEAR for the atlas). tools/build.odin
// rebakes any job whose sources changed. This file's Bake_Hdr / bake_setup_image / oneshot_* are
// shared with the baker (copied in with the rest of the game).

BAKE_MAGIC :: u32(0x4B424D54) // "TMBK"
BAKE_VER   :: u32(2)          // bump if the on-disk layout changes

// Which layers get baked. img = the fixed-size bindless target (IMG_SPECS row, created here not
// in the swapchain path); frag = the baker's fullscreen-triangle shader; params = header stamps
// the loader checks so a cache baked against different constants is rejected (→ rebake).
Bake :: enum { City, BodyAtlas }
BakeSpec :: struct { img: Img, frag, cache: string, params: [4]f32 }
BAKE_SPECS := [Bake]BakeSpec{
	.City      = {img = .CityC, frag = "shaders/spv/bake_city.frag.spv", cache = "assets/city.cache", params = {ZOOM, CITY_R0, CACHE_ORIGIN, 0}},
	.BodyAtlas = {img = .BodyA, frag = "shaders/spv/bake_body.frag.spv", cache = "assets/body.cache", params = {f32(ATLAS_TILE), f32(ATLAS_FRAMES), ATLAS_RAD, 0}},
}

// 32-byte header (Odin scalar layout == on-disk bytes).
Bake_Hdr :: struct { magic, version, job, dim: u32, params: [4]f32 }

@(private = "file") bake_mem: [Bake]vk.DeviceMemory // each target's dedicated allocation (process lifetime)

bake_dim     :: proc(job: Bake) -> u32 { return IMG_SPECS[BAKE_SPECS[job].img].fixed }
bake_payload :: proc(job: Bake) -> int { d := int(bake_dim(job)); return d * d * 8 } // rgba16f

// Create a bake target's fixed rgba16f image (its own device-local allocation + view). Shared by
// both paths: the baker renders into it then copies OUT; the game copies the file INTO it then
// samples. Usage covers every role. dim comes from the IMG_SPECS `fixed` size.
bake_setup_image :: proc(job: Bake) {
	img := BAKE_SPECS[job].img
	dim := bake_dim(job)
	fp: vk.FormatProperties
	vk.GetPhysicalDeviceFormatProperties(vkc.phys, HDR_FORMAT, &fp)
	if .SAMPLED_IMAGE not_in fp.optimalTilingFeatures || .COLOR_ATTACHMENT not_in fp.optimalTilingFeatures {
		fmt.panicf("bake: HDR_FORMAT lacks SAMPLED+COLOR_ATTACHMENT")
	}
	ici := vk.ImageCreateInfo{
		sType = .IMAGE_CREATE_INFO, imageType = .D2, format = HDR_FORMAT,
		extent = {dim, dim, 1}, mipLevels = 1, arrayLayers = 1, samples = {._1},
		tiling = .OPTIMAL, usage = {.COLOR_ATTACHMENT, .SAMPLED, .TRANSFER_SRC, .TRANSFER_DST},
		sharingMode = .EXCLUSIVE, initialLayout = .UNDEFINED,
	}
	vkok(vk.CreateImage(vkc.device, &ici, nil, &vkc.imgs[img]), "CreateImage(bake)")
	req: vk.MemoryRequirements
	vk.GetImageMemoryRequirements(vkc.device, vkc.imgs[img], &req)
	mai := vk.MemoryAllocateInfo{sType = .MEMORY_ALLOCATE_INFO, allocationSize = req.size, memoryTypeIndex = find_mem_type(req.memoryTypeBits, {.DEVICE_LOCAL})}
	vkok(vk.AllocateMemory(vkc.device, &mai, nil, &bake_mem[job]), "AllocateMemory(bake)")
	vk.BindImageMemory(vkc.device, vkc.imgs[img], bake_mem[job], 0)
	ivci := vk.ImageViewCreateInfo{sType = .IMAGE_VIEW_CREATE_INFO, image = vkc.imgs[img], viewType = .D2, format = HDR_FORMAT, subresourceRange = {aspectMask = {.COLOR}, levelCount = 1, layerCount = 1}}
	vkok(vk.CreateImageView(vkc.device, &ivci, nil, &vkc.img_views[img]), "CreateImageView(bake)")
}

// A one-time command buffer: allocate + begin. Record inline, then oneshot_end. Package-level so
// the copied-in baker harness (tools/bake) can reuse them for its render.
oneshot_begin :: proc() -> vk.CommandBuffer {
	cbai := vk.CommandBufferAllocateInfo{sType = .COMMAND_BUFFER_ALLOCATE_INFO, commandPool = vkc.cmd_pool, level = .PRIMARY, commandBufferCount = 1}
	cmd: vk.CommandBuffer
	vkok(vk.AllocateCommandBuffers(vkc.device, &cbai, &cmd), "AllocateCommandBuffers(oneshot)")
	begin := vk.CommandBufferBeginInfo{sType = .COMMAND_BUFFER_BEGIN_INFO, flags = {.ONE_TIME_SUBMIT}}
	vk.BeginCommandBuffer(cmd, &begin)
	return cmd
}
oneshot_end :: proc(cmd: vk.CommandBuffer) {
	cmd := cmd
	vk.EndCommandBuffer(cmd)
	ci := vk.CommandBufferSubmitInfo{sType = .COMMAND_BUFFER_SUBMIT_INFO, commandBuffer = cmd}
	submit := vk.SubmitInfo2{sType = .SUBMIT_INFO_2, commandBufferInfoCount = 1, pCommandBufferInfos = &ci}
	vkok(vk.QueueSubmit2(vkc.queue, 1, &submit, 0), "QueueSubmit2(oneshot)")
	vk.QueueWaitIdle(vkc.queue)
	vk.FreeCommandBuffers(vkc.device, vkc.cmd_pool, 1, &cmd)
}

// ── game path: load every baked cache → its texture, sampled every frame ───────
bake_load_all :: proc() { for job in Bake { bake_load(job) } }

bake_load :: proc(job: Bake) {
	s := BAKE_SPECS[job]
	data, rerr := os.read_entire_file(s.cache, context.allocator)
	if rerr != nil || len(data) < size_of(Bake_Hdr) {
		fmt.panicf("bake cache missing/short (%s) — run ./run.sh (it bakes): %v", s.cache, rerr)
	}
	hdr := (^Bake_Hdr)(raw_data(data))^
	if hdr.magic != BAKE_MAGIC || hdr.version != BAKE_VER || hdr.job != u32(job) || hdr.dim != bake_dim(job) || hdr.params != s.params {
		fmt.panicf("bake cache %s: baked against different constants — run ./run.sh (rebakes)", s.cache)
	}
	payload := bake_payload(job)
	if len(data) != size_of(Bake_Hdr) + payload { fmt.panicf("bake cache %s: truncated payload — run ./run.sh", s.cache) }

	bake_setup_image(job)
	stage, stage_mem, stage_ptr := create_buffer(vk.DeviceSize(payload), true)
	mem.copy(stage_ptr, rawptr(uintptr(raw_data(data)) + size_of(Bake_Hdr)), payload)
	delete(data)

	dim := bake_dim(job)
	cmd := oneshot_begin()
	image_barrier(cmd, vkc.imgs[s.img], .UNDEFINED, .TRANSFER_DST_OPTIMAL, {}, {.TRANSFER_WRITE}, {.TOP_OF_PIPE}, {.COPY})
	region := vk.BufferImageCopy{imageSubresource = {aspectMask = {.COLOR}, layerCount = 1}, imageExtent = {dim, dim, 1}}
	vk.CmdCopyBufferToImage(cmd, stage, vkc.imgs[s.img], .TRANSFER_DST_OPTIMAL, 1, &region)
	image_barrier(cmd, vkc.imgs[s.img], .TRANSFER_DST_OPTIMAL, .SHADER_READ_ONLY_OPTIMAL, {.TRANSFER_WRITE}, {.SHADER_SAMPLED_READ}, {.COPY}, {.FRAGMENT_SHADER})
	oneshot_end(cmd)

	vk.DestroyBuffer(vkc.device, stage, nil)
	vk.FreeMemory(vkc.device, stage_mem, nil)

	// bind into descriptor binding 1 at the target's bindless slot (= its Img ordinal; shaders
	// address it by the IMG_* constant, e.g. TEXS[IMG_CITYC] / TEXS[IMG_BODYA]).
	info := vk.DescriptorImageInfo{imageView = vkc.img_views[s.img], imageLayout = .SHADER_READ_ONLY_OPTIMAL}
	w := vk.WriteDescriptorSet{sType = .WRITE_DESCRIPTOR_SET, dstSet = vkc.desc_set, dstBinding = 1, dstArrayElement = u32(s.img), descriptorCount = 1, descriptorType = .COMBINED_IMAGE_SAMPLER, pImageInfo = &info}
	vk.UpdateDescriptorSets(vkc.device, 1, &w, 0, nil)
}
