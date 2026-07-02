package main

import "core:fmt"
import "core:os"
import "core:time"
import vk "vendor:vulkan"

// The game only READS precompiled SPIR-V (shaders/spv/, produced by tools/build.odin). No shader
// compilation lives here. Hot reload watches the compiled .spv files (the ones listed in
// PIPE_SPECS) and rebuilds the pipelines when the watcher recompiles them — see tools/odin-watch.

// Load a precompiled SPIR-V file → VkShaderModule (0 on failure).
load_spv :: proc(path: string) -> vk.ShaderModule {
	data, err := os.read_entire_file(path, context.allocator)
	if err != nil { fmt.eprintln("missing compiled shader:", path, "— run ./run.sh"); return 0 }
	defer delete(data)
	ci := vk.ShaderModuleCreateInfo{sType = .SHADER_MODULE_CREATE_INFO, codeSize = len(data), pCode = cast(^u32)raw_data(data)}
	m: vk.ShaderModule
	vkok(vk.CreateShaderModule(vkc.device, &ci, nil, &m), "CreateShaderModule")
	return m
}

// ── Hot reload ───────────────────────────────────────────────────────────────
// Poll every pipeline's .spv; when the watcher recompiles them (mtime changes), rebuild the
// pipelines. Pure consumer — the watcher owns GLSL → SPIR-V (+ naga).
@(private = "file") hot_stamp: i64

hot_reload_poll :: proc() {
	sum: i64
	for spec in PIPE_SPECS {
		for spv in spec.shaders { t, _ := os.last_write_time_by_name(spv); sum += time.to_unix_nanoseconds(t) }
	}
	if hot_stamp == 0 { hot_stamp = sum; return }
	if sum != hot_stamp {
		hot_stamp = sum
		fmt.println("hot reload: shaders changed — reloading pipelines")
		rebuild_pipelines()
	}
}
