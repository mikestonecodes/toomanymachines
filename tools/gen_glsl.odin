package main

// Build step (1/2): read the Odin GPU structs via reflection and emit them as GLSL
// into shaders/gen.glsl (which shaders/common.glsl #includes). Run standalone:
//   odin run tools/gen_glsl.odin -file
// tools/build.odin then compiles the GLSL → SPIR-V.

import "core:fmt"
import "core:os"
import "core:reflect"
import "core:strings"
import gpu "../gpu"

main :: proc() {
	b: strings.Builder
	strings.write_string(&b, "// AUTO-GENERATED from Odin structs (gpu/types.odin) — do not edit.\n")
	for s in gpu.STRUCTS {
		fmt.sbprintf(&b, "struct %s {{\n", s.name)
		info := reflect.type_info_base(s.ti).variant.(reflect.Type_Info_Struct)
		for i in 0 ..< info.field_count { fmt.sbprintf(&b, "\t%s %s;\n", glsl_type(info.types[i]), info.names[i]) }
		strings.write_string(&b, "};\n")
	}
	_ = os.write_entire_file("shaders/gen.glsl", transmute([]u8)strings.to_string(b))
	fmt.println("gen_glsl: wrote shaders/gen.glsl")
}

glsl_type :: proc(ti: ^reflect.Type_Info) -> string {
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
