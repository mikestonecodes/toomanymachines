package main

import "core:fmt"
import "core:mem"
import "core:os"
import vk "vendor:vulkan"

// ── the CITY CACHE (game side: LOAD + SAMPLE only) ────────────────────────────
// The buildings are a STATIC, view-independent layer: for a world ground-position g0 the
// oblique march (house_at → roof_col/wall_col/plinth) always returns the same color, with
// NO time dependence. Marching it per-pixel every frame cost ~5ms at 4K.
//
// So it's baked ONCE, offline, into a world-anchored texture (Img.CityC, 8192² rgba16f):
//   RGB = the baked HDR building color (window/lamp values stay >1.0 for bloom)
//   A   = a 3-level coverage classifier: 0 = no building (fall through to live ground),
//         0.5 = the block PLINTH slab, 1.0 = a HOUSE. One channel serves city.frag's
//         composite + light-overlay AND body.frag's house-only occlusion.
//
// The BAKER is a wholly separate harness (tools/citybake — its own main + citybuild.frag);
// the build copies the game sources it needs into it. The shipped game carries NO bake
// code: it just LOADS assets/city.cache here and SAMPLES it (NEAREST, over a texel-snapped
// camera → byte-identical to the old live march). tools/build.odin rebakes on any march
// source change, so the file is never stale. The baker reuses this file's Cache_Hdr /
// city_cache_setup_image / oneshot_* (they're copied in with the rest of the game).

CACHE_PATH  :: "assets/city.cache"
CACHE_MAGIC :: u32(0x434D4D54) // "TMMC"
CACHE_VER   :: u32(1)          // bump if the on-disk layout changes

// 24-byte header (Odin scalar layout == on-disk bytes). origin/wpx/city_r/dim let the
// loader reject a cache baked against different constants (mismatch panics → ./run.sh).
Cache_Hdr :: struct {
	magic, version, dim: u32,
	wpx, origin, city_r: f32,
}

@(private = "file") cityc_mem: vk.DeviceMemory // the CityC image's dedicated allocation (process lifetime)

cache_payload_bytes :: proc() -> int { return int(CACHE_DIM) * int(CACHE_DIM) * 8 } // rgba16f

// Create the fixed 8192² rgba16f CityC image (its own device-local allocation + view).
// Shared by both paths: the baker renders into it then copies OUT; the game copies the
// file INTO it then samples. Usage covers every role.
city_cache_setup_image :: proc() {
	fp: vk.FormatProperties
	vk.GetPhysicalDeviceFormatProperties(vkc.phys, HDR_FORMAT, &fp)
	if .SAMPLED_IMAGE not_in fp.optimalTilingFeatures || .COLOR_ATTACHMENT not_in fp.optimalTilingFeatures {
		fmt.panicf("city cache: HDR_FORMAT lacks SAMPLED+COLOR_ATTACHMENT")
	}
	ici := vk.ImageCreateInfo{
		sType = .IMAGE_CREATE_INFO, imageType = .D2, format = HDR_FORMAT,
		extent = {CACHE_DIM, CACHE_DIM, 1}, mipLevels = 1, arrayLayers = 1, samples = {._1},
		tiling = .OPTIMAL, usage = {.COLOR_ATTACHMENT, .SAMPLED, .TRANSFER_SRC, .TRANSFER_DST},
		sharingMode = .EXCLUSIVE, initialLayout = .UNDEFINED,
	}
	vkok(vk.CreateImage(vkc.device, &ici, nil, &vkc.imgs[.CityC]), "CreateImage(CityC)")
	req: vk.MemoryRequirements
	vk.GetImageMemoryRequirements(vkc.device, vkc.imgs[.CityC], &req)
	mai := vk.MemoryAllocateInfo{sType = .MEMORY_ALLOCATE_INFO, allocationSize = req.size, memoryTypeIndex = find_mem_type(req.memoryTypeBits, {.DEVICE_LOCAL})}
	vkok(vk.AllocateMemory(vkc.device, &mai, nil, &cityc_mem), "AllocateMemory(CityC)")
	vk.BindImageMemory(vkc.device, vkc.imgs[.CityC], cityc_mem, 0)
	ivci := vk.ImageViewCreateInfo{sType = .IMAGE_VIEW_CREATE_INFO, image = vkc.imgs[.CityC], viewType = .D2, format = HDR_FORMAT, subresourceRange = {aspectMask = {.COLOR}, levelCount = 1, layerCount = 1}}
	vkok(vk.CreateImageView(vkc.device, &ivci, nil, &vkc.img_views[.CityC]), "CreateImageView(CityC)")
}

// A one-time command buffer: allocate + begin. Record inline, then oneshot_end. Package-
// level so the copied-in baker harness (tools/citybake) can reuse them for its render.
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

// ── game path: load assets/city.cache → CityC texture, sampled every frame ─────
city_cache_load :: proc() {
	data, rerr := os.read_entire_file(CACHE_PATH, context.allocator)
	if rerr != nil || len(data) < size_of(Cache_Hdr) {
		fmt.panicf("city cache missing/short (%s) — run ./run.sh (it bakes): %v", CACHE_PATH, rerr)
	}
	hdr := (^Cache_Hdr)(raw_data(data))^
	if hdr.magic != CACHE_MAGIC || hdr.version != CACHE_VER {
		fmt.panicf("city cache: bad magic/version — run ./run.sh")
	}
	if hdr.dim != CACHE_DIM || hdr.wpx != ZOOM || hdr.city_r != CITY_R0 || hdr.origin != CACHE_ORIGIN {
		fmt.panicf("city cache: baked against different constants — run ./run.sh (rebakes)")
	}
	payload := cache_payload_bytes()
	if len(data) != size_of(Cache_Hdr) + payload { fmt.panicf("city cache: truncated payload — run ./run.sh") }

	city_cache_setup_image()
	stage, stage_mem, stage_ptr := create_buffer(vk.DeviceSize(payload), true)
	mem.copy(stage_ptr, rawptr(uintptr(raw_data(data)) + size_of(Cache_Hdr)), payload)
	delete(data)

	cmd := oneshot_begin()
	image_barrier(cmd, vkc.imgs[.CityC], .UNDEFINED, .TRANSFER_DST_OPTIMAL, {}, {.TRANSFER_WRITE}, {.TOP_OF_PIPE}, {.COPY})
	region := vk.BufferImageCopy{imageSubresource = {aspectMask = {.COLOR}, layerCount = 1}, imageExtent = {CACHE_DIM, CACHE_DIM, 1}}
	vk.CmdCopyBufferToImage(cmd, stage, vkc.imgs[.CityC], .TRANSFER_DST_OPTIMAL, 1, &region)
	image_barrier(cmd, vkc.imgs[.CityC], .TRANSFER_DST_OPTIMAL, .SHADER_READ_ONLY_OPTIMAL, {.TRANSFER_WRITE}, {.SHADER_SAMPLED_READ}, {.COPY}, {.FRAGMENT_SHADER})
	oneshot_end(cmd)

	vk.DestroyBuffer(vkc.device, stage, nil)
	vk.FreeMemory(vkc.device, stage_mem, nil)

	// bind CityC into descriptor binding 1 at IMG_CITYC (shaders TEXS[IMG_CITYC])
	info := vk.DescriptorImageInfo{imageView = vkc.img_views[.CityC], imageLayout = .SHADER_READ_ONLY_OPTIMAL}
	w := vk.WriteDescriptorSet{sType = .WRITE_DESCRIPTOR_SET, dstSet = vkc.desc_set, dstBinding = 1, dstArrayElement = IMG_CITYC, descriptorCount = 1, descriptorType = .COMBINED_IMAGE_SAMPLER, pImageInfo = &info}
	vk.UpdateDescriptorSets(vkc.device, 1, &w, 0, nil)
}
