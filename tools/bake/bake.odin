package main

import "core:fmt"
import "core:mem"
import "core:os"
import SDL "vendor:sdl3"
import vk "vendor:vulkan"

// ── the offline GENERIC BAKER ─────────────────────────────────────────────────
// A wholly SEPARATE harness — the shipped game contains none of this. tools/build.odin copies
// every game .odin file EXCEPT main.odin next to this one (into tools/bake/gen) and compiles
// them together, so each bake reuses the game's REAL vk_init + game_init (which generates the
// Res.City block layout the city march reads) + the same @glsl contract. Every bake JOB is a
// row in BAKE_SPECS (bake_cache.odin): this loops them, renders each job's fullscreen-triangle
// shader into its fixed image, reads it back, and writes assets/<job>.cache — the asset the
// game just loads (bake_load_all) and samples. Zero CPU/GPU divergence.

main :: proc() {
	g_ctx = context
	if !SDL.Init({.VIDEO}) { fmt.panicf("SDL_Init: %s", SDL.GetError()) }
	if !SDL.Vulkan_LoadLibrary(nil) { fmt.panicf("Vulkan_LoadLibrary: %s", SDL.GetError()) }
	// a tiny hidden window: the bakes render to their fixed images, not the swapchain, so the
	// window size is irrelevant — it only gives vk_init a surface.
	window = SDL.CreateWindow("bake", 64, 64, {.VULKAN, .HIDDEN})
	if window == nil { fmt.panicf("CreateWindow: %s", SDL.GetError()) }
	update_size()
	vk_init()
	render_init() // buffers + the bindless set (house_at reads the CITY buffer through it) — also
	              // warms this machine's runtime pipeline cache as a side effect (build_pipelines
	              // saves it), so the game launch after a rebake skips the ISA recompile.
	game_init()   // generates the Res.City block layout the city march consumes
	for job in Bake { bake_run(job) }
	os.exit(0)
}

// Render one job's shader into its fixed image, copy it back, write assets/<job>.cache.
bake_run :: proc(job: Bake) {
	s := BAKE_SPECS[job]
	bake_setup_image(job) // the fixed rgba16f target (shared game code: bake_cache.odin)
	dim := bake_dim(job)
	// the bake pipeline is created HERE, standalone — its shader lives in this harness, NOT in
	// the game's PIPE_SPECS. Same bindless layout as every game pipe.
	pipe := make_graphics_pipeline("shaders/spv/fs_tri.vert.spv", s.frag, .None, true)
	if pipe == 0 { fmt.panicf("bake(%v): pipeline %s failed to build", job, s.frag) }

	payload := bake_payload(job)
	stage, stage_mem, stage_ptr := create_buffer(vk.DeviceSize(payload), true)

	cmd := oneshot_begin()
	vk.CmdBindDescriptorSets(cmd, .GRAPHICS, vkc.pipe_layout, 0, 1, &vkc.desc_set, 0, nil)
	image_barrier(cmd, vkc.imgs[s.img], .UNDEFINED, .COLOR_ATTACHMENT_OPTIMAL, {}, {.COLOR_ATTACHMENT_WRITE}, {.TOP_OF_PIPE}, {.COLOR_ATTACHMENT_OUTPUT})
	color := vk.RenderingAttachmentInfo{sType = .RENDERING_ATTACHMENT_INFO, imageView = vkc.img_views[s.img], imageLayout = .COLOR_ATTACHMENT_OPTIMAL, loadOp = .CLEAR, storeOp = .STORE}
	ri := vk.RenderingInfo{sType = .RENDERING_INFO, renderArea = {extent = {dim, dim}}, layerCount = 1, colorAttachmentCount = 1, pColorAttachments = &color}
	vk.CmdBeginRendering(cmd, &ri)
	vp := vk.Viewport{width = f32(dim), height = f32(dim), maxDepth = 1}
	sc := vk.Rect2D{extent = {dim, dim}}
	vk.CmdSetViewport(cmd, 0, 1, &vp)
	vk.CmdSetScissor(cmd, 0, 1, &sc)
	vk.CmdBindPipeline(cmd, .GRAPHICS, pipe)
	pc := Push{city_r = CITY_R0} // the city march reads city_r + the Res.City buffer; other jobs derive their tile from gl_FragCoord
	vk.CmdPushConstants(cmd, vkc.pipe_layout, {.COMPUTE, .VERTEX, .FRAGMENT}, 0, size_of(Push), &pc)
	vk.CmdDraw(cmd, 3, 1, 0, 0)
	vk.CmdEndRendering(cmd)
	image_barrier(cmd, vkc.imgs[s.img], .COLOR_ATTACHMENT_OPTIMAL, .TRANSFER_SRC_OPTIMAL, {.COLOR_ATTACHMENT_WRITE}, {.TRANSFER_READ}, {.COLOR_ATTACHMENT_OUTPUT}, {.COPY})
	region := vk.BufferImageCopy{imageSubresource = {aspectMask = {.COLOR}, layerCount = 1}, imageExtent = {dim, dim, 1}}
	vk.CmdCopyImageToBuffer(cmd, vkc.imgs[s.img], .TRANSFER_SRC_OPTIMAL, stage, 1, &region)
	oneshot_end(cmd)

	hdr := Bake_Hdr{magic = BAKE_MAGIC, version = BAKE_VER, job = u32(job), dim = dim, params = s.params}
	out := make([]u8, size_of(Bake_Hdr) + payload)
	mem.copy(raw_data(out), &hdr, size_of(Bake_Hdr))
	mem.copy(rawptr(uintptr(raw_data(out)) + size_of(Bake_Hdr)), stage_ptr, payload)
	os.make_directory("assets")
	if werr := os.write_entire_file(s.cache, out); werr != nil { fmt.panicf("bake(%v): write %s: %v", job, s.cache, werr) }
	fmt.printfln("baked %s (%d MiB, %dx%d)", s.cache, (size_of(Bake_Hdr) + payload) / (1024 * 1024), dim, dim)
	vk.DestroyBuffer(vkc.device, stage, nil)
	vk.FreeMemory(vkc.device, stage_mem, nil)
}
