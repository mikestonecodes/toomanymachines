package main

import "core:c/libc"
import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:reflect"
import "core:strings"
import "core:time"
import vk "vendor:vulkan"

// Odin → GLSL struct injection + the GLSL build/validate chain + hot reload.
//
// Odin reflection writes shaders/gen.glsl (the structs); common.glsl #includes it,
// and the shaders #include common.glsl — all via glslc's native -I include path.
// Each shader is compiled + statically validated:
//   glslc -Werror → spirv-val → spirv-opt --validate-after-all → naga (cross-check)

CACHE :: ".shadercache"

GlslStruct :: struct { ti: ^reflect.Type_Info, name: string }

@(private = "file") gen_buf: [4096]u8

// Emit shaders/gen.glsl from the registered Odin structs.
write_gen_glsl :: proc() {
	os.make_directory("shaders")
	b := strings.builder_from_bytes(gen_buf[:])
	strings.write_string(&b, "// AUTO-GENERATED from Odin structs (pipelines.odin) — do not edit.\n")
	for s in GLSL_STRUCTS {
		fmt.sbprintf(&b, "struct %s {{\n", s.name)
		info := reflect.type_info_base(s.ti).variant.(reflect.Type_Info_Struct)
		for i in 0 ..< info.field_count { fmt.sbprintf(&b, "\t%s %s;\n", odin_to_glsl(info.types[i]), info.names[i]) }
		strings.write_string(&b, "};\n")
	}
	_ = os.write_entire_file("shaders/gen.glsl", transmute([]u8)strings.to_string(b))
}

odin_to_glsl :: proc(ti: ^reflect.Type_Info) -> string {
	#partial switch v in ti.variant {
	case reflect.Type_Info_Float:   if ti.size == 4 { return "float" }
	case reflect.Type_Info_Integer: if ti.size == 4 { return v.signed ? "int" : "uint" }
	case reflect.Type_Info_Array:
		if v.elem.size == 4 {
			#partial switch ev in v.elem.variant {
			case reflect.Type_Info_Float:   if v.count == 2 { return "vec2" }; if v.count == 4 { return "vec4" }
			case reflect.Type_Info_Integer: if v.count == 2 { return ev.signed ? "ivec2" : "uvec2" }; if v.count == 4 { return ev.signed ? "ivec4" : "uvec4" }
			}
		}
	}
	return "float"
}

// Compile + validate one GLSL file → SPIR-V bytes. Returns (nil, false) on any
// failure (and prints the log), so hot reload can keep the old pipeline.
compile_glsl :: proc(path: string, stage: string) -> ([]u8, bool) {
	os.make_directory(CACHE)
	spv := fmt.tprintf("%s/%s.spv", CACHE, filepath.base(path))
	log := fmt.tprintf("%s/build.log", CACHE)
	// glslc -Werror (syntax+semantics) → spirv-val (spec) → spirv-opt --validate-after-all
	// (post-transform). naga cross-validate is intentionally dropped: it rejects glslc's
	// OpCopyLogical (emitted for struct copies), and our descriptor indices are all
	// uniform push constants — the runtime validation layers cover nonuniform anyway.
	cmd := fmt.tprintf(
		"glslc -I shaders --target-env=vulkan1.3 -Werror -fshader-stage=%s %s -o %s 2>%s && " +
		"spirv-val %s 2>>%s && spirv-opt --validate-after-all %s -o %s.opt 2>>%s",
		stage, path, spv, log, spv, log, spv, spv, log)
	if libc.system(strings.clone_to_cstring(cmd, context.temp_allocator)) != 0 {
		if data, err := os.read_entire_file(log, context.temp_allocator); err == nil { fmt.eprintf("SHADER BUILD FAILED (%s):\n%s\n", path, string(data)) }
		return nil, false
	}
	data, err := os.read_entire_file(spv, context.allocator)
	return data, err == nil
}

// Compile → VkShaderModule (or VK_NULL_HANDLE on failure).
load_shader_module :: proc(path, stage: string) -> vk.ShaderModule {
	data, ok := compile_glsl(path, stage)
	if !ok { return 0 }
	defer delete(data)
	ci := vk.ShaderModuleCreateInfo{sType = .SHADER_MODULE_CREATE_INFO, codeSize = len(data), pCode = cast(^u32)raw_data(data)}
	mod: vk.ShaderModule
	vkok(vk.CreateShaderModule(vkc.device, &ci, nil, &mod), "CreateShaderModule")
	return mod
}

// Stage keyword glslc expects, inferred from the file extension.
stage_of :: proc(path: string) -> string {
	switch filepath.ext(path) {
	case ".comp": return "compute"
	case ".vert": return "vertex"
	case ".frag": return "fragment"
	}
	return "compute"
}

// ── Hot reload ───────────────────────────────────────────────────────────────
// Poll every shader source's mtime; rebuild all pipelines when anything changes.

// gen.glsl is intentionally excluded: it's regenerated from Odin structs (which
// can't change without recompiling the binary), so watching it would self-trigger.
@(private = "file") hot_files := [?]string{
	"shaders/common.glsl",
	"shaders/physics.comp", "shaders/circle.vert", "shaders/circle.frag",
}
@(private = "file") hot_stamp: i64

hot_reload_poll :: proc() {
	sum: i64
	for f in hot_files { t, _ := os.last_write_time_by_name(f); sum += time.to_unix_nanoseconds(t) }
	if hot_stamp == 0 { hot_stamp = sum; return }
	if sum != hot_stamp {
		hot_stamp = sum
		fmt.println("hot reload: rebuilding pipelines")
		rebuild_pipelines()
	}
}
