package main

import "core:fmt"
import "core:mem"
import "core:os"
import SDL "vendor:sdl3"
import vk "vendor:vulkan"

// ── the offline CITY-CACHE BAKER ──────────────────────────────────────────────
// A wholly SEPARATE harness — the shipped game contains none of this. tools/build.odin
// copies every game .odin file EXCEPT main.odin next to this one (into tools/citybake/gen)
// and compiles them together, so the bake reuses the game's REAL vk_init + game_init (which
// generates the Res.City block layout the march reads) + the same shaders. It renders the
// whole static city into the CityC image, reads it back, and writes assets/city.cache — the
// asset the game just loads (city_cache.odin) and samples. One source of truth for the
// march (this dir's citybuild.frag), zero CPU/GPU divergence.

main :: proc() {
	g_ctx = context
	if !SDL.Init({.VIDEO}) { fmt.panicf("SDL_Init: %s", SDL.GetError()) }
	if !SDL.Vulkan_LoadLibrary(nil) { fmt.panicf("Vulkan_LoadLibrary: %s", SDL.GetError()) }
	// a tiny hidden window: the bake renders to the fixed 8192² cache, not the swapchain,
	// so the window size is irrelevant — it only gives vk_init a surface.
	window = SDL.CreateWindow("citybake", 64, 64, {.VULKAN, .HIDDEN})
	if window == nil { fmt.panicf("CreateWindow: %s", SDL.GetError()) }
	update_size()
	vk_init()
	render_init() // buffers + the bindless set (house_at reads the CITY buffer through it)
	game_init()   // generates the Res.City block layout the march consumes
	city_cache_bake()
	os.exit(0)
}

// Render the whole static city into CityC, copy it back, write assets/city.cache.
city_cache_bake :: proc() {
	city_cache_setup_image() // the fixed 8192² rgba16f target (shared game code: city_cache.odin)
	// the bake pipeline is created HERE, standalone — its shader (citybuild.frag) lives in
	// this harness, NOT in the game's PIPE_SPECS. Same bindless layout as every game pipe.
	pipe := make_graphics_pipeline("shaders/spv/fs_tri.vert.spv", "shaders/spv/citybuild.frag.spv", .None, true)
	if pipe == 0 { fmt.panicf("citybake: citybuild pipeline failed to build") }

	payload := cache_payload_bytes()
	stage, stage_mem, stage_ptr := create_buffer(vk.DeviceSize(payload), true)

	cmd := oneshot_begin()
	vk.CmdBindDescriptorSets(cmd, .GRAPHICS, vkc.pipe_layout, 0, 1, &vkc.desc_set, 0, nil)
	image_barrier(cmd, vkc.imgs[.CityC], .UNDEFINED, .COLOR_ATTACHMENT_OPTIMAL, {}, {.COLOR_ATTACHMENT_WRITE}, {.TOP_OF_PIPE}, {.COLOR_ATTACHMENT_OUTPUT})
	color := vk.RenderingAttachmentInfo{sType = .RENDERING_ATTACHMENT_INFO, imageView = vkc.img_views[.CityC], imageLayout = .COLOR_ATTACHMENT_OPTIMAL, loadOp = .DONT_CARE, storeOp = .STORE}
	ri := vk.RenderingInfo{sType = .RENDERING_INFO, renderArea = {extent = {CACHE_DIM, CACHE_DIM}}, layerCount = 1, colorAttachmentCount = 1, pColorAttachments = &color}
	vk.CmdBeginRendering(cmd, &ri)
	vp := vk.Viewport{width = f32(CACHE_DIM), height = f32(CACHE_DIM), maxDepth = 1}
	sc := vk.Rect2D{extent = {CACHE_DIM, CACHE_DIM}}
	vk.CmdSetViewport(cmd, 0, 1, &vp)
	vk.CmdSetScissor(cmd, 0, 1, &sc)
	vk.CmdBindPipeline(cmd, .GRAPHICS, pipe)
	pc := Push{city_r = CITY_R0} // the march reads only city_r + the Res.City buffer; g0 = gl_FragCoord
	vk.CmdPushConstants(cmd, vkc.pipe_layout, {.COMPUTE, .VERTEX, .FRAGMENT}, 0, size_of(Push), &pc)
	vk.CmdDraw(cmd, 3, 1, 0, 0)
	vk.CmdEndRendering(cmd)
	image_barrier(cmd, vkc.imgs[.CityC], .COLOR_ATTACHMENT_OPTIMAL, .TRANSFER_SRC_OPTIMAL, {.COLOR_ATTACHMENT_WRITE}, {.TRANSFER_READ}, {.COLOR_ATTACHMENT_OUTPUT}, {.COPY})
	region := vk.BufferImageCopy{imageSubresource = {aspectMask = {.COLOR}, layerCount = 1}, imageExtent = {CACHE_DIM, CACHE_DIM, 1}}
	vk.CmdCopyImageToBuffer(cmd, vkc.imgs[.CityC], .TRANSFER_SRC_OPTIMAL, stage, 1, &region)
	oneshot_end(cmd)

	hdr := Cache_Hdr{magic = CACHE_MAGIC, version = CACHE_VER, dim = CACHE_DIM, wpx = ZOOM, origin = CACHE_ORIGIN, city_r = CITY_R0}
	out := make([]u8, size_of(Cache_Hdr) + payload)
	mem.copy(raw_data(out), &hdr, size_of(Cache_Hdr))
	mem.copy(rawptr(uintptr(raw_data(out)) + size_of(Cache_Hdr)), stage_ptr, payload)
	os.make_directory("assets")
	if werr := os.write_entire_file(CACHE_PATH, out); werr != nil { fmt.panicf("citybake: write %s: %v", CACHE_PATH, werr) }
	fmt.printfln("baked %s (%d MiB, %dx%d)", CACHE_PATH, (size_of(Cache_Hdr) + payload) / (1024 * 1024), CACHE_DIM, CACHE_DIM)
	vk.DestroyBuffer(vkc.device, stage, nil)
	vk.FreeMemory(vkc.device, stage_mem, nil)
}
