package main

import "core:fmt"
import "core:os"
import SDL "vendor:sdl3"
import vk "vendor:vulkan"

// ─────────────────────────────────────────────────────────────────────────────
// Modern Vulkan backend: 1.3 dynamic rendering + synchronization2 (no render
// passes / framebuffers) and a single BINDLESS descriptor set — one array of
// storage buffers, indexed from push constants. Every pipeline shares one layout;
// registering a buffer is one descriptor write. Data lives in the tables in
// pipelines.odin; this file is the machinery.
// ─────────────────────────────────────────────────────────────────────────────

FRAMES_IN_FLIGHT :: 2
BINDLESS_MAX     :: 64
HDR_FORMAT       :: vk.Format.R16G16B16A16_SFLOAT // offscreen scene/bloom targets
VALIDATION_LAYER :: "VK_LAYER_KHRONOS_validation"

// Validation config knobs, set (only) by the headless dev harness before vk_init:
//   vk_gpuav — swap best-practices+sync for GPU-Assisted validation (runtime descriptor/OOB).
//   dev_present — an optional per-frame present hook (the harness records a screenshot copy
//     + owns the swapchain's final layout transition). nil in the game → plain present.
// The shipped game never touches either: it validates normally (debug builds) and presents.
vk_gpuav:    bool
dev_present: proc(cmd: vk.CommandBuffer, img: u32)

vkc: struct {
	instance:  vk.Instance,
	debug:     vk.DebugUtilsMessengerEXT,
	surface:   vk.SurfaceKHR,
	phys:      vk.PhysicalDevice,
	device:    vk.Device,
	queue:     vk.Queue,
	qfamily:   u32,
	validated: bool,

	// swapchain
	swapchain: vk.SwapchainKHR,
	format:    vk.Format,
	extent:    vk.Extent2D,
	images:    [dynamic]vk.Image,
	views:     [dynamic]vk.ImageView,

	// bindless
	set_layout:  vk.DescriptorSetLayout,
	desc_pool:   vk.DescriptorPool,
	desc_set:    vk.DescriptorSet,
	pipe_layout: vk.PipelineLayout,
	buf_next:    u32,

	// offscreen HDR targets (IMG_SPECS in render.odin) + the one shared sampler
	sampler:   vk.Sampler,
	imgs:      [Img]vk.Image,
	img_views: [Img]vk.ImageView,
	img_mem:   vk.DeviceMemory,

	// per-frame-in-flight
	cmd_pool:    vk.CommandPool,
	cmds:        [FRAMES_IN_FLIGHT]vk.CommandBuffer,
	img_avail:   [FRAMES_IN_FLIGHT]vk.Semaphore,
	in_flight:   [FRAMES_IN_FLIGHT]vk.Fence,
	render_done: [dynamic]vk.Semaphore, // one per swapchain image
	frame:       u32,

	// GPU profiler: per-pass timestamps (one pool per in-flight slot)
	qpools:    [FRAMES_IN_FLIGHT]vk.QueryPool,
	ts_period: f32, // ns per timestamp tick
}

// Last completed frame's per-pass GPU times, milliseconds:
// [0] physics  [1] city  [2] bodies  [3] bloom  [4] composite  [5] whole frame
gpu_ms: [6]f64

vkok :: proc(r: vk.Result, what: string, loc := #caller_location) {
	if r != .SUCCESS { fmt.panicf("vulkan: %s failed: %v", what, r, loc = loc) }
}

// ── init ─────────────────────────────────────────────────────────────────────

vk_init :: proc() {
	vk.load_proc_addresses_global(rawptr(SDL.Vulkan_GetVkGetInstanceProcAddr()))

	ext_count: u32
	sdl_exts := SDL.Vulkan_GetInstanceExtensions(&ext_count)
	exts: [dynamic]cstring
	for i in 0 ..< ext_count { append(&exts, sdl_exts[i]) }

	layers: [dynamic]cstring
	// Validation is a BUILD property, not a runtime flag: debug builds validate (./run.sh, shot,
	// gpuav, test), the release build (the watch loop's play launch) has this whole block compiled
	// out. Zero-tolerance — when on, the debug callback aborts on any error (see debug_callback).
	when ODIN_DEBUG {
		if has_layer(VALIDATION_LAYER) {
			append(&layers, cstring(VALIDATION_LAYER))
			append(&exts, vk.EXT_DEBUG_UTILS_EXTENSION_NAME)
			append(&exts, vk.EXT_VALIDATION_FEATURES_EXTENSION_NAME)
			append(&exts, vk.EXT_LAYER_SETTINGS_EXTENSION_NAME)
			vkc.validated = true
		} else {
			fmt.println("vulkan: validation layer not installed (sudo pacman -S vulkan-validation-layers)")
		}
	}

	// MoltenVK and other portability ICDs are HIDDEN from vkEnumeratePhysicalDevices unless the
	// instance opts in with VK_KHR_portability_enumeration + the ENUMERATE_PORTABILITY flag (spec
	// requirement since the extension shipped). Native Linux/Windows drivers don't advertise it, so
	// this whole thing no-ops there — but without it the app finds zero GPUs on macOS.
	portability := has_instance_ext(vk.KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME)
	if portability { append(&exts, vk.KHR_PORTABILITY_ENUMERATION_EXTENSION_NAME) }

	app := vk.ApplicationInfo{sType = .APPLICATION_INFO, pApplicationName = "toomanymachines", apiVersion = vk.API_VERSION_1_3}
	// Two distinct validation configs. Normal launch: best-practices + synchronization2 on top
	// of the core checks. `gpuav` build-step pass: GPU-Assisted (runtime descriptor/OOB) ALONE —
	// the layer is (correctly) slow and noisy if core checks run alongside GPU-AV, so we disable
	// core checks for that pass; the normal launch still does them. DEBUG_PRINTF is never enabled
	// (mutually exclusive with GPU_ASSISTED — we prefer GPU-AV's OOB checks over shader printf).
	F :: vk.ValidationFeatureEnableEXT
	FD :: vk.ValidationFeatureDisableEXT
	val_enables: [dynamic]F
	val_disables: [dynamic]FD
	if vk_gpuav {
		append(&val_enables, F.GPU_ASSISTED, F.GPU_ASSISTED_RESERVE_BINDING_SLOT)
		append(&val_disables, FD.CORE_CHECKS)
	} else {
		append(&val_enables, F.BEST_PRACTICES, F.SYNCHRONIZATION_VALIDATION)
	}
	val_features := vk.ValidationFeaturesEXT{
		sType                          = .VALIDATION_FEATURES_EXT,
		enabledValidationFeatureCount  = u32(len(val_enables)),
		pEnabledValidationFeatures     = raw_data(val_enables),
		disabledValidationFeatureCount = u32(len(val_disables)),
		pDisabledValidationFeatures    = raw_data(val_disables),
	}
	// GPU-AV defaults to validating ray-query/trace-ray/mesh-shading; this device has none of
	// those, so the layer would warn that it's disabling each. Turn them off up front instead.
	ls_off := b32(false)
	ls_layer := cstring(VALIDATION_LAYER)
	ls_settings := [?]vk.LayerSettingEXT{
		{pLayerName = ls_layer, pSettingName = "gpuav_validate_ray_query", type = .BOOL32, valueCount = 1, pValues = &ls_off},
		{pLayerName = ls_layer, pSettingName = "gpuav_validate_trace_ray", type = .BOOL32, valueCount = 1, pValues = &ls_off},
		{pLayerName = ls_layer, pSettingName = "gpuav_mesh_shading", type = .BOOL32, valueCount = 1, pValues = &ls_off},
	}
	ls_ci := vk.LayerSettingsCreateInfoEXT{sType = .LAYER_SETTINGS_CREATE_INFO_EXT, settingCount = len(ls_settings), pSettings = raw_data(ls_settings[:])}
	if vk_gpuav { val_features.pNext = &ls_ci }
	dbg_ci := debug_messenger_ci()
	dbg_ci.pNext = &val_features
	ici := vk.InstanceCreateInfo{
		sType                   = .INSTANCE_CREATE_INFO,
		pApplicationInfo        = &app,
		enabledExtensionCount   = u32(len(exts)),
		ppEnabledExtensionNames = raw_data(exts),
		enabledLayerCount       = u32(len(layers)),
		ppEnabledLayerNames     = raw_data(layers),
		flags                   = portability ? {.ENUMERATE_PORTABILITY_KHR} : {},
		pNext                   = vkc.validated ? &dbg_ci : nil,
	}
	vkok(vk.CreateInstance(&ici, nil, &vkc.instance), "CreateInstance")
	vk.load_proc_addresses_instance(vkc.instance)
	if vkc.validated { vkok(vk.CreateDebugUtilsMessengerEXT(vkc.instance, &dbg_ci, nil, &vkc.debug), "CreateDebugUtilsMessenger") }

	if !SDL.Vulkan_CreateSurface(window, vkc.instance, nil, &vkc.surface) { fmt.panicf("Vulkan_CreateSurface: %s", SDL.GetError()) }
	pick_physical_device()

	feat13 := vk.PhysicalDeviceVulkan13Features{sType = .PHYSICAL_DEVICE_VULKAN_1_3_FEATURES, dynamicRendering = true, synchronization2 = true, shaderDemoteToHelperInvocation = true}
	feat11 := vk.PhysicalDeviceVulkan11Features{sType = .PHYSICAL_DEVICE_VULKAN_1_1_FEATURES, pNext = &feat13}
	feat12 := vk.PhysicalDeviceVulkan12Features{
		sType                                         = .PHYSICAL_DEVICE_VULKAN_1_2_FEATURES,
		pNext                                         = &feat11,
		descriptorIndexing                            = true,
		runtimeDescriptorArray                        = true,
		descriptorBindingPartiallyBound               = true,
		descriptorBindingStorageBufferUpdateAfterBind = true,
		hostQueryReset                                = true, // prime the profiler query pools from the host
		descriptorBindingSampledImageUpdateAfterBind  = true,
		shaderStorageBufferArrayNonUniformIndexing    = true,
		scalarBlockLayout                             = true,
	}
	feat2 := vk.PhysicalDeviceFeatures2{
		sType = .PHYSICAL_DEVICE_FEATURES_2,
		pNext = &feat12,
		// fragment stores: the frag shaders read the (writable-declared) bindless storage buffers;
		// sampled-image dynamic indexing: bloom.frag picks its source texture from a push constant.
		features = {vertexPipelineStoresAndAtomics = true, fragmentStoresAndAtomics = true, shaderSampledImageArrayDynamicIndexing = true},
	}
	if vk_gpuav {
		// Enable exactly the features GPU-Assisted validation instruments with, so it doesn't
		// force-adjust the device on create (which the layer warns about). Only for the pass.
		feat2.features.fragmentStoresAndAtomics = true
		feat2.features.shaderInt64 = true
		feat2.features.shaderInt16 = true
		feat12.timelineSemaphore = true
		feat12.vulkanMemoryModel = true
		feat12.vulkanMemoryModelDeviceScope = true
		feat12.bufferDeviceAddress = true
		feat12.storageBuffer8BitAccess = true
		feat12.shaderInt8 = true
		feat11.storageBuffer16BitAccess = true
	}
	prio: f32 = 1
	qci := vk.DeviceQueueCreateInfo{sType = .DEVICE_QUEUE_CREATE_INFO, queueFamilyIndex = vkc.qfamily, queueCount = 1, pQueuePriorities = &prio}
	dev_exts: [dynamic]cstring
	append(&dev_exts, vk.KHR_SWAPCHAIN_EXTENSION_NAME)
	// If the device advertises VK_KHR_portability_subset (MoltenVK always does), the spec REQUIRES
	// enabling it — vkCreateDevice fails otherwise. It carries no features we depend on, so just
	// enabling it is enough; native drivers never advertise it, so this no-ops off-macOS.
	if has_device_ext(vkc.phys, vk.KHR_PORTABILITY_SUBSET_EXTENSION_NAME) { append(&dev_exts, vk.KHR_PORTABILITY_SUBSET_EXTENSION_NAME) }
	dci := vk.DeviceCreateInfo{
		sType                   = .DEVICE_CREATE_INFO,
		pNext                   = &feat2,
		queueCreateInfoCount    = 1,
		pQueueCreateInfos       = &qci,
		enabledExtensionCount   = u32(len(dev_exts)),
		ppEnabledExtensionNames = raw_data(dev_exts),
	}
	vkok(vk.CreateDevice(vkc.phys, &dci, nil, &vkc.device), "CreateDevice")
	vk.load_proc_addresses_device(vkc.device)
	vk.GetDeviceQueue(vkc.device, vkc.qfamily, 0, &vkc.queue)

	create_swapchain()

	pci := vk.CommandPoolCreateInfo{sType = .COMMAND_POOL_CREATE_INFO, flags = {.RESET_COMMAND_BUFFER}, queueFamilyIndex = vkc.qfamily}
	vkok(vk.CreateCommandPool(vkc.device, &pci, nil, &vkc.cmd_pool), "CreateCommandPool")
	cbai := vk.CommandBufferAllocateInfo{sType = .COMMAND_BUFFER_ALLOCATE_INFO, commandPool = vkc.cmd_pool, level = .PRIMARY, commandBufferCount = FRAMES_IN_FLIGHT}
	vkok(vk.AllocateCommandBuffers(vkc.device, &cbai, &vkc.cmds[0]), "AllocateCommandBuffers")
	sci := vk.SemaphoreCreateInfo{sType = .SEMAPHORE_CREATE_INFO}
	fci := vk.FenceCreateInfo{sType = .FENCE_CREATE_INFO, flags = {.SIGNALED}}
	for i in 0 ..< FRAMES_IN_FLIGHT {
		vkok(vk.CreateSemaphore(vkc.device, &sci, nil, &vkc.img_avail[i]), "CreateSemaphore")
		vkok(vk.CreateFence(vkc.device, &fci, nil, &vkc.in_flight[i]), "CreateFence")
	}

	qpci := vk.QueryPoolCreateInfo{sType = .QUERY_POOL_CREATE_INFO, queryType = .TIMESTAMP, queryCount = 8}
	for i in 0 ..< FRAMES_IN_FLIGHT {
		vkok(vk.CreateQueryPool(vkc.device, &qpci, nil, &vkc.qpools[i]), "CreateQueryPool")
		vk.ResetQueryPool(vkc.device, vkc.qpools[i], 0, 8) // host-prime: queries must be reset before first use
	}

	bindless_init()
	create_images()
	fmt.println("vulkan: initialized", vkc.validated ? "(validation ON)" : "(no validation)")
}

// One descriptor set, two bindings: 0 = an array of storage buffers, 1 = the offscreen HDR
// targets as combined image samplers (one immutable linear-clamp sampler for all of them).
// Both partially-bound + update-after-bind.
bindless_init :: proc() {
	smp := vk.SamplerCreateInfo{
		sType = .SAMPLER_CREATE_INFO, magFilter = .LINEAR, minFilter = .LINEAR, mipmapMode = .NEAREST,
		addressModeU = .CLAMP_TO_EDGE, addressModeV = .CLAMP_TO_EDGE, addressModeW = .CLAMP_TO_EDGE,
	}
	vkok(vk.CreateSampler(vkc.device, &smp, nil, &vkc.sampler), "CreateSampler")
	samplers: [len(Img)]vk.Sampler
	for &s in samplers { s = vkc.sampler }

	bindings := [2]vk.DescriptorSetLayoutBinding{
		{binding = 0, descriptorType = .STORAGE_BUFFER, descriptorCount = BINDLESS_MAX, stageFlags = {.COMPUTE, .VERTEX, .FRAGMENT}},
		{binding = 1, descriptorType = .COMBINED_IMAGE_SAMPLER, descriptorCount = len(Img), stageFlags = {.FRAGMENT}, pImmutableSamplers = &samplers[0]},
	}
	bflags := [2]vk.DescriptorBindingFlags{{.PARTIALLY_BOUND, .UPDATE_AFTER_BIND}, {.PARTIALLY_BOUND, .UPDATE_AFTER_BIND}}
	fci := vk.DescriptorSetLayoutBindingFlagsCreateInfo{sType = .DESCRIPTOR_SET_LAYOUT_BINDING_FLAGS_CREATE_INFO, bindingCount = 2, pBindingFlags = &bflags[0]}
	lci := vk.DescriptorSetLayoutCreateInfo{sType = .DESCRIPTOR_SET_LAYOUT_CREATE_INFO, pNext = &fci, flags = {.UPDATE_AFTER_BIND_POOL}, bindingCount = 2, pBindings = &bindings[0]}
	vkok(vk.CreateDescriptorSetLayout(vkc.device, &lci, nil, &vkc.set_layout), "CreateDescriptorSetLayout")

	psizes := [2]vk.DescriptorPoolSize{
		{type = .STORAGE_BUFFER, descriptorCount = BINDLESS_MAX},
		{type = .COMBINED_IMAGE_SAMPLER, descriptorCount = len(Img)},
	}
	pci := vk.DescriptorPoolCreateInfo{sType = .DESCRIPTOR_POOL_CREATE_INFO, flags = {.UPDATE_AFTER_BIND}, maxSets = 1, poolSizeCount = 2, pPoolSizes = &psizes[0]}
	vkok(vk.CreateDescriptorPool(vkc.device, &pci, nil, &vkc.desc_pool), "CreateDescriptorPool")

	dai := vk.DescriptorSetAllocateInfo{sType = .DESCRIPTOR_SET_ALLOCATE_INFO, descriptorPool = vkc.desc_pool, descriptorSetCount = 1, pSetLayouts = &vkc.set_layout}
	vkok(vk.AllocateDescriptorSets(vkc.device, &dai, &vkc.desc_set), "AllocateDescriptorSets")

	pcr := vk.PushConstantRange{stageFlags = {.COMPUTE, .VERTEX, .FRAGMENT}, offset = 0, size = size_of(Push)}
	pli := vk.PipelineLayoutCreateInfo{sType = .PIPELINE_LAYOUT_CREATE_INFO, setLayoutCount = 1, pSetLayouts = &vkc.set_layout, pushConstantRangeCount = 1, pPushConstantRanges = &pcr}
	vkok(vk.CreatePipelineLayout(vkc.device, &pli, nil, &vkc.pipe_layout), "CreatePipelineLayout")
}

// ── buffers ──────────────────────────────────────────────────────────────────

create_buffer :: proc(size: vk.DeviceSize, host_visible: bool) -> (buf: vk.Buffer, mem: vk.DeviceMemory, mapped: rawptr) {
	bci := vk.BufferCreateInfo{sType = .BUFFER_CREATE_INFO, size = size, usage = {.STORAGE_BUFFER, .TRANSFER_DST, .TRANSFER_SRC}, sharingMode = .EXCLUSIVE}
	vkok(vk.CreateBuffer(vkc.device, &bci, nil, &buf), "CreateBuffer")
	req: vk.MemoryRequirements
	vk.GetBufferMemoryRequirements(vkc.device, buf, &req)
	props: vk.MemoryPropertyFlags = host_visible ? {.HOST_VISIBLE, .HOST_COHERENT} : {.DEVICE_LOCAL}
	mai := vk.MemoryAllocateInfo{sType = .MEMORY_ALLOCATE_INFO, allocationSize = req.size, memoryTypeIndex = find_mem_type(req.memoryTypeBits, props)}
	vkok(vk.AllocateMemory(vkc.device, &mai, nil, &mem), "AllocateMemory")
	vk.BindBufferMemory(vkc.device, buf, mem, 0)
	if host_visible { vk.MapMemory(vkc.device, mem, 0, size, {}, &mapped) }
	return
}

find_mem_type :: proc(bits: u32, props: vk.MemoryPropertyFlags) -> u32 {
	mp: vk.PhysicalDeviceMemoryProperties
	vk.GetPhysicalDeviceMemoryProperties(vkc.phys, &mp)
	for i in 0 ..< mp.memoryTypeCount {
		if bits & (1 << i) != 0 && props <= mp.memoryTypes[i].propertyFlags { return i }
	}
	panic("vulkan: no suitable memory type")
}

// Register a buffer into the bindless array; returns its index (for push constants).
bindless_register :: proc(buf: vk.Buffer, size: vk.DeviceSize) -> u32 {
	idx := vkc.buf_next
	vkc.buf_next += 1
	info := vk.DescriptorBufferInfo{buffer = buf, offset = 0, range = size}
	w := vk.WriteDescriptorSet{sType = .WRITE_DESCRIPTOR_SET, dstSet = vkc.desc_set, dstBinding = 0, dstArrayElement = idx, descriptorCount = 1, descriptorType = .STORAGE_BUFFER, pBufferInfo = &info}
	vk.UpdateDescriptorSets(vkc.device, 1, &w, 0, nil)
	return idx
}

// Backs the BUF_SPECS list in render.odin (indexed by Res). `glsl`/`elem` are read only by the
// shader generator (tools/build.odin parses them out of render.odin); the game just needs size +
// host-visibility. Buffers register in Res order, so a buffer's bindless slot IS its Res ordinal —
// which is why shaders can address them by a literal slot (tools/gen bakes it into the macros).
BufSpec :: struct { glsl: string, elem: typeid, size: u64, host_visible: bool }
buffers: [Res]vk.Buffer
buf_mem: [Res]vk.DeviceMemory
buf_map: [Res]rawptr

// Create every BUF_SPECS buffer, then back all buffers of a memory class (host-visible vs
// device-local) from ONE allocation, sub-allocated at aligned offsets — avoids the per-buffer
// dedicated allocations that best-practices validation flags — and register each bindlessly.
alloc_buffers :: proc() {
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
	for spec, r in BUF_SPECS {
		slot := bindless_register(buffers[r], vk.DeviceSize(spec.size))
		assert(int(slot) == int(r)) // shaders address buffers by literal slot = Res ordinal
	}
}

align_up :: proc(v, a: vk.DeviceSize) -> vk.DeviceSize { return (v + a - 1) & ~(a - 1) }

// ── offscreen images ─────────────────────────────────────────────────────────
// Backs the IMG_SPECS list in render.odin (indexed by Img). All targets are HDR_FORMAT
// color-attachment + sampled, sub-allocated from ONE memory block, and registered into
// binding 1 at their enum ordinal — shaders address them by the IMG_* constants.

// div != 0: extent = swapchain extent / div (recreated with the swapchain).
// fixed != 0: an absolute fixed-size, world-anchored target (the city cache) — owned by
// city_cache.odin, skipped by the swapchain create/resize path.
ImgSpec :: struct { div, fixed: u32 }

img_extent :: proc(im: Img) -> vk.Extent2D {
	s := IMG_SPECS[im]
	if s.fixed != 0 { return {s.fixed, s.fixed} }
	return {max(vkc.extent.width / s.div, 1), max(vkc.extent.height / s.div, 1)}
}

// Swapchain-relative HDR targets only (div != 0). Fixed world-anchored targets (the city
// cache) are skipped here — city_cache.odin owns their image/memory/view/descriptor, and
// they must survive swapchain resize untouched.
create_images :: proc() {
	reqs: [Img]vk.MemoryRequirements
	for im in Img {
		if IMG_SPECS[im].fixed != 0 { continue }
		e := img_extent(im)
		ici := vk.ImageCreateInfo{
			sType = .IMAGE_CREATE_INFO, imageType = .D2, format = HDR_FORMAT,
			extent = {e.width, e.height, 1}, mipLevels = 1, arrayLayers = 1, samples = {._1},
			tiling = .OPTIMAL, usage = {.COLOR_ATTACHMENT, .SAMPLED}, sharingMode = .EXCLUSIVE, initialLayout = .UNDEFINED,
		}
		vkok(vk.CreateImage(vkc.device, &ici, nil, &vkc.imgs[im]), "CreateImage")
		vk.GetImageMemoryRequirements(vkc.device, vkc.imgs[im], &reqs[im])
	}
	total: vk.DeviceSize
	bits: u32 = 0xFFFFFFFF
	for im in Img { if IMG_SPECS[im].fixed != 0 { continue }; total = align_up(total, reqs[im].alignment) + reqs[im].size; bits &= reqs[im].memoryTypeBits }
	mai := vk.MemoryAllocateInfo{sType = .MEMORY_ALLOCATE_INFO, allocationSize = total, memoryTypeIndex = find_mem_type(bits, {.DEVICE_LOCAL})}
	vkok(vk.AllocateMemory(vkc.device, &mai, nil, &vkc.img_mem), "AllocateMemory(images)")
	off: vk.DeviceSize
	for im in Img {
		if IMG_SPECS[im].fixed != 0 { continue }
		off = align_up(off, reqs[im].alignment)
		vk.BindImageMemory(vkc.device, vkc.imgs[im], vkc.img_mem, off)
		off += reqs[im].size
	}
	for im in Img {
		if IMG_SPECS[im].fixed != 0 { continue }
		ivci := vk.ImageViewCreateInfo{sType = .IMAGE_VIEW_CREATE_INFO, image = vkc.imgs[im], viewType = .D2, format = HDR_FORMAT, subresourceRange = {aspectMask = {.COLOR}, levelCount = 1, layerCount = 1}}
		vkok(vk.CreateImageView(vkc.device, &ivci, nil, &vkc.img_views[im]), "CreateImageView(offscreen)")
		info := vk.DescriptorImageInfo{imageView = vkc.img_views[im], imageLayout = .SHADER_READ_ONLY_OPTIMAL}
		w := vk.WriteDescriptorSet{sType = .WRITE_DESCRIPTOR_SET, dstSet = vkc.desc_set, dstBinding = 1, dstArrayElement = u32(im), descriptorCount = 1, descriptorType = .COMBINED_IMAGE_SAMPLER, pImageInfo = &info}
		vk.UpdateDescriptorSets(vkc.device, 1, &w, 0, nil)
	}
}

destroy_images :: proc() {
	for im in Img {
		if IMG_SPECS[im].fixed != 0 { continue }
		vk.DestroyImageView(vkc.device, vkc.img_views[im], nil)
		vk.DestroyImage(vkc.device, vkc.imgs[im], nil)
	}
	vk.FreeMemory(vkc.device, vkc.img_mem, nil)
}

// Open dynamic rendering onto an offscreen HDR target. Contents are discarded (every pass
// starts with an opaque fullscreen draw), so the UNDEFINED transition only needs the
// execution dependency against last frame's sampling of this image.
img_pass_begin :: proc(cmd: vk.CommandBuffer, im: Img) {
	image_barrier(cmd, vkc.imgs[im], .UNDEFINED, .COLOR_ATTACHMENT_OPTIMAL, {}, {.COLOR_ATTACHMENT_WRITE}, {.FRAGMENT_SHADER}, {.COLOR_ATTACHMENT_OUTPUT})
	e := img_extent(im)
	color := vk.RenderingAttachmentInfo{sType = .RENDERING_ATTACHMENT_INFO, imageView = vkc.img_views[im], imageLayout = .COLOR_ATTACHMENT_OPTIMAL, loadOp = .DONT_CARE, storeOp = .STORE}
	ri := vk.RenderingInfo{sType = .RENDERING_INFO, renderArea = {extent = e}, layerCount = 1, colorAttachmentCount = 1, pColorAttachments = &color}
	vk.CmdBeginRendering(cmd, &ri)
	vp := vk.Viewport{width = f32(e.width), height = f32(e.height), maxDepth = 1}
	sc := vk.Rect2D{extent = e}
	vk.CmdSetViewport(cmd, 0, 1, &vp)
	vk.CmdSetScissor(cmd, 0, 1, &sc)
}

// Close the offscreen pass and hand the image to fragment sampling.
img_pass_end :: proc(cmd: vk.CommandBuffer, im: Img) {
	vk.CmdEndRendering(cmd)
	image_barrier(cmd, vkc.imgs[im], .COLOR_ATTACHMENT_OPTIMAL, .SHADER_READ_ONLY_OPTIMAL, {.COLOR_ATTACHMENT_WRITE}, {.SHADER_SAMPLED_READ}, {.COLOR_ATTACHMENT_OUTPUT}, {.FRAGMENT_SHADER})
}

// ── pipelines ────────────────────────────────────────────────────────────────

make_compute_pipeline :: proc(path: string) -> vk.Pipeline {
	mod := load_spv(path)
	if mod == 0 { return 0 }
	defer vk.DestroyShaderModule(vkc.device, mod, nil)
	ci := vk.ComputePipelineCreateInfo{
		sType  = .COMPUTE_PIPELINE_CREATE_INFO,
		stage  = {sType = .PIPELINE_SHADER_STAGE_CREATE_INFO, stage = {.COMPUTE}, module = mod, pName = "main"},
		layout = vkc.pipe_layout,
	}
	p: vk.Pipeline
	vkok(vk.CreateComputePipelines(vkc.device, 0, 1, &ci, nil, &p), "CreateComputePipelines")
	return p
}

make_graphics_pipeline :: proc(vert, frag: string, blend: Blend, hdr: bool) -> vk.Pipeline {
	vmod := load_spv(vert)
	if vmod == 0 { return 0 }
	fmod := load_spv(frag)
	if fmod == 0 { vk.DestroyShaderModule(vkc.device, vmod, nil); return 0 }
	defer vk.DestroyShaderModule(vkc.device, vmod, nil)
	defer vk.DestroyShaderModule(vkc.device, fmod, nil)

	stages := [2]vk.PipelineShaderStageCreateInfo{
		{sType = .PIPELINE_SHADER_STAGE_CREATE_INFO, stage = {.VERTEX}, module = vmod, pName = "main"},
		{sType = .PIPELINE_SHADER_STAGE_CREATE_INFO, stage = {.FRAGMENT}, module = fmod, pName = "main"},
	}
	vin := vk.PipelineVertexInputStateCreateInfo{sType = .PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO}
	ia := vk.PipelineInputAssemblyStateCreateInfo{sType = .PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO, topology = .TRIANGLE_LIST}
	vp := vk.PipelineViewportStateCreateInfo{sType = .PIPELINE_VIEWPORT_STATE_CREATE_INFO, viewportCount = 1, scissorCount = 1}
	rs := vk.PipelineRasterizationStateCreateInfo{sType = .PIPELINE_RASTERIZATION_STATE_CREATE_INFO, polygonMode = .FILL, frontFace = .COUNTER_CLOCKWISE, lineWidth = 1}
	ms := vk.PipelineMultisampleStateCreateInfo{sType = .PIPELINE_MULTISAMPLE_STATE_CREATE_INFO, rasterizationSamples = {._1}}
	// src/dst color+alpha factors per blend mode (all .ADD). None → opaque.
	att := vk.PipelineColorBlendAttachmentState{colorWriteMask = {.R, .G, .B, .A}, blendEnable = blend != .None, colorBlendOp = .ADD, alphaBlendOp = .ADD, srcAlphaBlendFactor = .ONE}
	switch blend {
	case .None:
	case .Alpha:  att.srcColorBlendFactor = .SRC_ALPHA; att.dstColorBlendFactor = .ONE_MINUS_SRC_ALPHA; att.dstAlphaBlendFactor = .ONE_MINUS_SRC_ALPHA
	case .Premul: att.srcColorBlendFactor = .ONE;       att.dstColorBlendFactor = .ONE_MINUS_SRC_ALPHA; att.dstAlphaBlendFactor = .ONE_MINUS_SRC_ALPHA
	case .Add:    att.srcColorBlendFactor = .ONE;       att.dstColorBlendFactor = .ONE;                 att.dstAlphaBlendFactor = .ONE
	}
	cb := vk.PipelineColorBlendStateCreateInfo{sType = .PIPELINE_COLOR_BLEND_STATE_CREATE_INFO, attachmentCount = 1, pAttachments = &att}
	dyns := [?]vk.DynamicState{.VIEWPORT, .SCISSOR}
	dyn := vk.PipelineDynamicStateCreateInfo{sType = .PIPELINE_DYNAMIC_STATE_CREATE_INFO, dynamicStateCount = len(dyns), pDynamicStates = raw_data(dyns[:])}
	color_fmt := hdr ? HDR_FORMAT : vkc.format
	pr := vk.PipelineRenderingCreateInfo{sType = .PIPELINE_RENDERING_CREATE_INFO, colorAttachmentCount = 1, pColorAttachmentFormats = &color_fmt}

	ci := vk.GraphicsPipelineCreateInfo{
		sType               = .GRAPHICS_PIPELINE_CREATE_INFO,
		pNext               = &pr,
		stageCount          = 2,
		pStages             = &stages[0],
		pVertexInputState   = &vin,
		pInputAssemblyState = &ia,
		pViewportState      = &vp,
		pRasterizationState = &rs,
		pMultisampleState   = &ms,
		pColorBlendState    = &cb,
		pDynamicState       = &dyn,
		layout              = vkc.pipe_layout,
	}
	p: vk.Pipeline
	vkok(vk.CreateGraphicsPipelines(vkc.device, 0, 1, &ci, nil, &p), "CreateGraphicsPipelines")
	return p
}

// Schema + storage for the PIPE_SPECS list in render.odin (indexed by the Pipe enum there).
// hdr: render into the HDR offscreen format instead of the swapchain format.
Blend :: enum { None, Alpha, Premul, Add }
PipeSpec :: struct { compute: bool, shaders: []string, blend: Blend, hdr: bool }
pipelines: [Pipe]vk.Pipeline

// Build every PIPE_SPECS pipeline into `out`; ok=false if any shader failed to compile.
build_pipelines :: proc(out: ^[Pipe]vk.Pipeline) -> (ok: bool) {
	ok = true
	for spec, p in PIPE_SPECS {
		out[p] = spec.compute ? make_compute_pipeline(spec.shaders[0]) : make_graphics_pipeline(spec.shaders[0], spec.shaders[1], spec.blend, spec.hdr)
		if out[p] == 0 { ok = false }
	}
	return
}

// Rebuild all pipelines in place (hot reload). On a shader compile error, keep the running set.
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

// ── frame scaffolding: acquire → record → submit → present ────────────────────
// render() (render.odin) records the actual sim/draw between frame_begin and frame_end.

// Wait the frame fence, acquire the next swapchain image, open the command buffer and bind the
// bindless set. ok=false means the swapchain went out of date (recreated) — skip this frame.
frame_begin :: proc() -> (cmd: vk.CommandBuffer, img: u32, ok: bool) {
	fence := vkc.in_flight[vkc.frame]
	vk.WaitForFences(vkc.device, 1, &fence, true, max(u64))
	acq := vk.AcquireNextImageKHR(vkc.device, vkc.swapchain, max(u64), vkc.img_avail[vkc.frame], 0, &img)
	if acq == .ERROR_OUT_OF_DATE_KHR { recreate_swapchain(); return }
	if acq != .SUCCESS && acq != .SUBOPTIMAL_KHR { vkok(acq, "AcquireNextImage") }
	vk.ResetFences(vkc.device, 1, &fence)

	// GPU profiler: the fence guarantees this slot's previous frame finished — harvest
	// its timestamps into gpu_ms before the pool is reset and re-recorded below.
	ts: [6]u64
	if vk.GetQueryPoolResults(vkc.device, vkc.qpools[vkc.frame], 0, 6, size_of(ts), &ts[0], 8, {._64}) == .SUCCESS {
		for i in 0 ..< 5 { gpu_ms[i] = f64(ts[i + 1] - ts[i]) * f64(vkc.ts_period) / 1e6 }
		gpu_ms[5] = f64(ts[5] - ts[0]) * f64(vkc.ts_period) / 1e6
	}

	cmd = vkc.cmds[vkc.frame]
	vk.ResetCommandBuffer(cmd, {})
	begin := vk.CommandBufferBeginInfo{sType = .COMMAND_BUFFER_BEGIN_INFO, flags = {.ONE_TIME_SUBMIT}}
	vk.BeginCommandBuffer(cmd, &begin)
	vk.CmdResetQueryPool(cmd, vkc.qpools[vkc.frame], 0, 8)
	gpu_stamp(cmd, 0)
	vk.CmdBindDescriptorSets(cmd, .COMPUTE, vkc.pipe_layout, 0, 1, &vkc.desc_set, 0, nil)
	vk.CmdBindDescriptorSets(cmd, .GRAPHICS, vkc.pipe_layout, 0, 1, &vkc.desc_set, 0, nil)
	ok = true
	return
}

// Write profiler timestamp i (render.odin brackets each pass with these).
gpu_stamp :: proc(cmd: vk.CommandBuffer, i: u32) {
	vk.CmdWriteTimestamp(cmd, {.BOTTOM_OF_PIPE}, vkc.qpools[vkc.frame], i)
}

// Transition the swapchain image to a color target and open dynamic rendering (clear + viewport).
pass_begin :: proc(cmd: vk.CommandBuffer, img: u32) {
	// srcStage = COLOR_ATTACHMENT_OUTPUT (not TOP_OF_PIPE) so the layout transition is ordered
	// after the acquire semaphore's wait stage — else sync-val flags WAR on the image.
	image_barrier(cmd, vkc.images[img], .UNDEFINED, .COLOR_ATTACHMENT_OPTIMAL, {}, {.COLOR_ATTACHMENT_WRITE}, {.COLOR_ATTACHMENT_OUTPUT}, {.COLOR_ATTACHMENT_OUTPUT})
	color := vk.RenderingAttachmentInfo{sType = .RENDERING_ATTACHMENT_INFO, imageView = vkc.views[img], imageLayout = .COLOR_ATTACHMENT_OPTIMAL, loadOp = .CLEAR, storeOp = .STORE, clearValue = {color = {float32 = {0.05, 0.06, 0.09, 1}}}}
	ri := vk.RenderingInfo{sType = .RENDERING_INFO, renderArea = {extent = vkc.extent}, layerCount = 1, colorAttachmentCount = 1, pColorAttachments = &color}
	vk.CmdBeginRendering(cmd, &ri)
	vp := vk.Viewport{width = f32(win_w), height = f32(win_h), maxDepth = 1}
	sc := vk.Rect2D{extent = vkc.extent}
	vk.CmdSetViewport(cmd, 0, 1, &vp)
	vk.CmdSetScissor(cmd, 0, 1, &sc)
}

// Close rendering and transition the swapchain image to present. The headless harness may
// override this via dev_present (to also copy the frame out for a screenshot); nil = plain.
pass_end :: proc(cmd: vk.CommandBuffer, img: u32) {
	vk.CmdEndRendering(cmd)
	if dev_present != nil { dev_present(cmd, img); return } // harness owns the final transition
	image_barrier(cmd, vkc.images[img], .COLOR_ATTACHMENT_OPTIMAL, .PRESENT_SRC_KHR, {.COLOR_ATTACHMENT_WRITE}, {}, {.COLOR_ATTACHMENT_OUTPUT}, {.BOTTOM_OF_PIPE})
}

// Submit the command buffer and present.
frame_end :: proc(cmd: vk.CommandBuffer, img: u32) {
	img := img
	vk.EndCommandBuffer(cmd)
	fence := vkc.in_flight[vkc.frame]
	wait := vk.SemaphoreSubmitInfo{sType = .SEMAPHORE_SUBMIT_INFO, semaphore = vkc.img_avail[vkc.frame], stageMask = {.COLOR_ATTACHMENT_OUTPUT}}
	signal := vk.SemaphoreSubmitInfo{sType = .SEMAPHORE_SUBMIT_INFO, semaphore = vkc.render_done[img], stageMask = {.ALL_COMMANDS}}
	ci := vk.CommandBufferSubmitInfo{sType = .COMMAND_BUFFER_SUBMIT_INFO, commandBuffer = cmd}
	submit := vk.SubmitInfo2{sType = .SUBMIT_INFO_2, waitSemaphoreInfoCount = 1, pWaitSemaphoreInfos = &wait, commandBufferInfoCount = 1, pCommandBufferInfos = &ci, signalSemaphoreInfoCount = 1, pSignalSemaphoreInfos = &signal}
	vkok(vk.QueueSubmit2(vkc.queue, 1, &submit, fence), "QueueSubmit2")

	present := vk.PresentInfoKHR{sType = .PRESENT_INFO_KHR, waitSemaphoreCount = 1, pWaitSemaphores = &vkc.render_done[img], swapchainCount = 1, pSwapchains = &vkc.swapchain, pImageIndices = &img}
	pres := vk.QueuePresentKHR(vkc.queue, &present)
	if pres == .ERROR_OUT_OF_DATE_KHR || pres == .SUBOPTIMAL_KHR { recreate_swapchain() }

	vkc.frame = (vkc.frame + 1) % FRAMES_IN_FLIGHT
}

vk_resize :: proc() { recreate_swapchain() }

// ── device / swapchain / helpers ─────────────────────────────────────────────

has_layer :: proc(name: string) -> bool {
	n: u32
	vk.EnumerateInstanceLayerProperties(&n, nil)
	props := make([]vk.LayerProperties, n, context.temp_allocator)
	vk.EnumerateInstanceLayerProperties(&n, raw_data(props))
	for &p in props { if name == string(cstring(&p.layerName[0])) { return true } }
	return false
}

has_instance_ext :: proc(name: cstring) -> bool {
	n: u32
	vk.EnumerateInstanceExtensionProperties(nil, &n, nil)
	props := make([]vk.ExtensionProperties, n, context.temp_allocator)
	vk.EnumerateInstanceExtensionProperties(nil, &n, raw_data(props))
	for &p in props { if string(name) == string(cstring(&p.extensionName[0])) { return true } }
	return false
}

has_device_ext :: proc(dev: vk.PhysicalDevice, name: cstring) -> bool {
	n: u32
	vk.EnumerateDeviceExtensionProperties(dev, nil, &n, nil)
	props := make([]vk.ExtensionProperties, n, context.temp_allocator)
	vk.EnumerateDeviceExtensionProperties(dev, nil, &n, raw_data(props))
	for &p in props { if string(name) == string(cstring(&p.extensionName[0])) { return true } }
	return false
}

pick_physical_device :: proc() {
	n: u32
	vk.EnumeratePhysicalDevices(vkc.instance, &n, nil)
	devs := make([]vk.PhysicalDevice, n, context.temp_allocator)
	vk.EnumeratePhysicalDevices(vkc.instance, &n, raw_data(devs))
	best: vk.PhysicalDevice
	best_discrete := false
	for d in devs {
		qf := find_queue_family(d) or_continue
		props: vk.PhysicalDeviceProperties
		vk.GetPhysicalDeviceProperties(d, &props)
		discrete := props.deviceType == .DISCRETE_GPU
		if best == nil || (discrete && !best_discrete) { best, best_discrete, vkc.qfamily = d, discrete, qf }
	}
	if best == nil { panic("vulkan: no GPU with graphics+compute+present") }
	vkc.phys = best
	props: vk.PhysicalDeviceProperties
	vk.GetPhysicalDeviceProperties(best, &props)
	vkc.ts_period = props.limits.timestampPeriod
	fmt.println("vulkan: GPU:", string(cstring(&props.deviceName[0])))
}

find_queue_family :: proc(d: vk.PhysicalDevice) -> (u32, bool) {
	n: u32
	vk.GetPhysicalDeviceQueueFamilyProperties(d, &n, nil)
	qfs := make([]vk.QueueFamilyProperties, n, context.temp_allocator)
	vk.GetPhysicalDeviceQueueFamilyProperties(d, &n, raw_data(qfs))
	for qf, i in qfs {
		present: b32
		vk.GetPhysicalDeviceSurfaceSupportKHR(d, u32(i), vkc.surface, &present)
		if .GRAPHICS in qf.queueFlags && .COMPUTE in qf.queueFlags && present { return u32(i), true }
	}
	return 0, false
}

create_swapchain :: proc() {
	caps: vk.SurfaceCapabilitiesKHR
	vk.GetPhysicalDeviceSurfaceCapabilitiesKHR(vkc.phys, vkc.surface, &caps)

	// Query supported surface formats (best practice) and pick BGRA8-UNORM, else the first.
	fn: u32
	vk.GetPhysicalDeviceSurfaceFormatsKHR(vkc.phys, vkc.surface, &fn, nil)
	formats := make([]vk.SurfaceFormatKHR, fn, context.temp_allocator)
	vk.GetPhysicalDeviceSurfaceFormatsKHR(vkc.phys, vkc.surface, &fn, raw_data(formats))
	chosen := formats[0]
	for f in formats { if f.format == .B8G8R8A8_UNORM && f.colorSpace == .COLORSPACE_SRGB_NONLINEAR { chosen = f; break } }
	vkc.format = chosen.format

	vkc.extent = caps.currentExtent
	if vkc.extent.width == max(u32) { vkc.extent = {win_w, win_h} }
	count := caps.minImageCount + 1
	if caps.maxImageCount > 0 && count > caps.maxImageCount { count = caps.maxImageCount }

	// Prefer MAILBOX: FIFO quantizes any frame that slips past a vblank into a 33ms
	// double-frame — visible stutter when the frame cost rides the 16.7ms edge.
	// MAILBOX always presents the newest image, so a slow frame costs only itself.
	pmode := vk.PresentModeKHR.FIFO
	pmn: u32
	vk.GetPhysicalDeviceSurfacePresentModesKHR(vkc.phys, vkc.surface, &pmn, nil)
	pmodes := make([]vk.PresentModeKHR, pmn, context.temp_allocator)
	vk.GetPhysicalDeviceSurfacePresentModesKHR(vkc.phys, vkc.surface, &pmn, raw_data(pmodes))
	for m in pmodes { if m == .MAILBOX { pmode = .MAILBOX; break } }

	sci := vk.SwapchainCreateInfoKHR{
		sType            = .SWAPCHAIN_CREATE_INFO_KHR,
		surface          = vkc.surface,
		minImageCount    = count,
		imageFormat      = vkc.format,
		imageColorSpace  = chosen.colorSpace,
		imageExtent      = vkc.extent,
		imageArrayLayers = 1,
		imageUsage       = {.COLOR_ATTACHMENT, .TRANSFER_DST, .TRANSFER_SRC},
		imageSharingMode = .EXCLUSIVE,
		preTransform     = caps.currentTransform,
		compositeAlpha   = {.OPAQUE},
		presentMode      = pmode,
		clipped          = true,
	}
	vkok(vk.CreateSwapchainKHR(vkc.device, &sci, nil, &vkc.swapchain), "CreateSwapchain")

	n: u32
	vk.GetSwapchainImagesKHR(vkc.device, vkc.swapchain, &n, nil)
	resize(&vkc.images, int(n))
	vk.GetSwapchainImagesKHR(vkc.device, vkc.swapchain, &n, raw_data(vkc.images))
	resize(&vkc.views, int(n))
	resize(&vkc.render_done, int(n))
	sem := vk.SemaphoreCreateInfo{sType = .SEMAPHORE_CREATE_INFO}
	for i in 0 ..< int(n) {
		ivci := vk.ImageViewCreateInfo{sType = .IMAGE_VIEW_CREATE_INFO, image = vkc.images[i], viewType = .D2, format = vkc.format, subresourceRange = {aspectMask = {.COLOR}, levelCount = 1, layerCount = 1}}
		vkok(vk.CreateImageView(vkc.device, &ivci, nil, &vkc.views[i]), "CreateImageView")
		vkok(vk.CreateSemaphore(vkc.device, &sem, nil, &vkc.render_done[i]), "CreateSemaphore(render_done)")
	}
}

recreate_swapchain :: proc() {
	vk.DeviceWaitIdle(vkc.device)
	for v in vkc.views { vk.DestroyImageView(vkc.device, v, nil) }
	for s in vkc.render_done { vk.DestroySemaphore(vkc.device, s, nil) }
	vk.DestroySwapchainKHR(vkc.device, vkc.swapchain, nil)
	create_swapchain()
	destroy_images() // offscreen targets track the swapchain extent
	create_images()
}

image_barrier :: proc(cmd: vk.CommandBuffer, image: vk.Image, old, new: vk.ImageLayout, src_access, dst_access: vk.AccessFlags2, src_stage, dst_stage: vk.PipelineStageFlags2) {
	b := vk.ImageMemoryBarrier2{sType = .IMAGE_MEMORY_BARRIER_2, srcStageMask = src_stage, srcAccessMask = src_access, dstStageMask = dst_stage, dstAccessMask = dst_access, oldLayout = old, newLayout = new, image = image, subresourceRange = {aspectMask = {.COLOR}, levelCount = 1, layerCount = 1}}
	dep := vk.DependencyInfo{sType = .DEPENDENCY_INFO, imageMemoryBarrierCount = 1, pImageMemoryBarriers = &b}
	vk.CmdPipelineBarrier2(cmd, &dep)
}

mem_barrier :: proc(cmd: vk.CommandBuffer, src_stage: vk.PipelineStageFlags2, src_access: vk.AccessFlags2, dst_stage: vk.PipelineStageFlags2, dst_access: vk.AccessFlags2) {
	b := vk.MemoryBarrier2{sType = .MEMORY_BARRIER_2, srcStageMask = src_stage, srcAccessMask = src_access, dstStageMask = dst_stage, dstAccessMask = dst_access}
	dep := vk.DependencyInfo{sType = .DEPENDENCY_INFO, memoryBarrierCount = 1, pMemoryBarriers = &b}
	vk.CmdPipelineBarrier2(cmd, &dep)
}

debug_messenger_ci :: proc() -> vk.DebugUtilsMessengerCreateInfoEXT {
	return {
		sType           = .DEBUG_UTILS_MESSENGER_CREATE_INFO_EXT,
		messageSeverity = {.WARNING, .ERROR},
		messageType     = {.GENERAL, .VALIDATION, .PERFORMANCE},
		pfnUserCallback = proc "system" (severity: vk.DebugUtilsMessageSeverityFlagsEXT, types: vk.DebugUtilsMessageTypeFlagsEXT, data: ^vk.DebugUtilsMessengerCallbackDataEXT, user: rawptr) -> b32 {
			context = g_ctx
			fmt.eprintln("VK:", data.pMessage)
			// Zero tolerance: abort on any error or core/sync validation message. Nothing is
			// allowlisted — the GPU-AV pass is configured (vk_init) so the layer has no setup
			// notes to emit. If a new message appears, fix the root cause, don't silence it here.
			if .ERROR in severity || .VALIDATION in types { os.exit(1) }
			return false
		},
	}
}
