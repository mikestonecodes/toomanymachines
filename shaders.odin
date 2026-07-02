package main

import "core:c/libc"
import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:strings"
import "core:time"
import vk "vendor:vulkan"

// The game only READS precompiled SPIR-V (from shaders/spv/, produced by
// tools/build.odin). No shader compilation lives here — hot reload just re-runs the
// external build and reloads the modules.

SPV_DIR :: "shaders/spv"

spv_path :: proc(src: string) -> string { return fmt.tprintf("%s/%s.spv", SPV_DIR, filepath.base(src)) }

// Load a precompiled SPIR-V file → VkShaderModule (0 on failure).
load_spv :: proc(src: string) -> vk.ShaderModule {
	data, err := os.read_entire_file(spv_path(src), context.allocator)
	if err != nil { fmt.eprintln("missing compiled shader:", spv_path(src), "— run ./run.sh"); return 0 }
	defer delete(data)
	ci := vk.ShaderModuleCreateInfo{sType = .SHADER_MODULE_CREATE_INFO, codeSize = len(data), pCode = cast(^u32)raw_data(data)}
	m: vk.ShaderModule
	vkok(vk.CreateShaderModule(vkc.device, &ci, nil, &m), "CreateShaderModule")
	return m
}

// ── Hot reload ───────────────────────────────────────────────────────────────
// Poll the GLSL sources; on a change, re-run tools/build.odin (recompiles → spv) and
// rebuild the pipelines. gen.glsl is excluded (structs can't change without a rebuild).

@(private = "file") hot_files := [?]string{
	"shaders/common.glsl", "shaders/physics.comp", "shaders/circle.vert", "shaders/circle.frag",
}
@(private = "file") hot_stamp: i64

hot_reload_poll :: proc() {
	sum: i64
	for f in hot_files { t, _ := os.last_write_time_by_name(f); sum += time.to_unix_nanoseconds(t) }
	if hot_stamp == 0 { hot_stamp = sum; return }
	if sum != hot_stamp {
		hot_stamp = sum
		fmt.println("hot reload: recompiling shaders")
		if libc.system(strings.clone_to_cstring("odin run tools/build.odin -file", context.temp_allocator)) == 0 {
			rebuild_pipelines()
		} else {
			fmt.eprintln("hot reload: shader build failed — keeping current pipelines")
		}
	}
}
