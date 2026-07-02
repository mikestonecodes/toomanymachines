package main

// Shader-type generator. Reflects the GPU structs copied out of render.odin (tools/build.odin
// writes them, plus the GLSL_TYPES enumeration, into types.gen.odin next to this file) and emits
// the GLSL contract: shaders/gen.glsl (structs + bindless buffers + push block) and one
// shaders/<Name>.glsl varying include per interface. Categorisation is by reflection:
//   • every field name `v_`-prefixed → a vertex↔fragment varying
//   • named `Push`                   → the push-constant block
//   • otherwise                      → a struct, and a bindless buffer element
// Run via `odin run tools/gen` (tools/build.odin does this after regenerating types.gen.odin).

import "base:intrinsics"
import "core:fmt"
import "core:os"
import "core:reflect"
import "core:strings"

main :: proc() {
	b: strings.Builder
	strings.write_string(&b, "// AUTO-GENERATED from render.odin (@glsl block) — do not edit.\n")

	for tid in GLSL_TYPES { // one GLSL struct per @glsl struct
		name, info := reflect_struct(tid)
		fmt.sbprintf(&b, "struct %s {{\n", name)
		for i in 0 ..< info.field_count { fmt.sbprintf(&b, "\t%s %s;\n", glsl_type(info.types[i]), info.names[i]) }
		strings.write_string(&b, "};\n")
	}
	emit_consts(&b) // gameplay/layout constants (resolved values) from the @glsl blocks
	seen: [dynamic]string // bindless views: one storage-buffer array per distinct element type
	for gb in GLSL_BUFFERS {
		view := glsl_typename(type_info_of(gb.elem))
		found := false
		for s in seen { if s == view { found = true } }
		if !found { append(&seen, view); emit_buffer(&b, view) }
	}
	for tid in GLSL_TYPES { // the push-constant block
		name, _ := reflect_struct(tid)
		if name == "Push" { fmt.sbprintf(&b, "layout(push_constant, scalar) uniform PushBlock {{ %s pc; }};\n", name) }
	}
	// accessor macros — literal slot = row order (matches the Res ordinal / registration order)
	for gb, i in GLSL_BUFFERS {
		fmt.sbprintf(&b, "#define %s %s[%d].v\n", gb.glsl, buf_var(glsl_typename(type_info_of(gb.elem))), i)
	}
	write("shaders/gen.glsl", strings.to_string(b))
}

// The bindless storage-buffer array + its typed view, named from the element type:
//   Body → buffer BodyBuf {…} bodyBuf[];   uint → buffer UintBuf {…} uintBuf[];
GBuf :: struct { glsl: string, elem: typeid } // one BUF_SPECS row's GLSL name + element type

emit_buffer :: proc(b: ^strings.Builder, t: string) {
	block := fmt.tprintf("%s%sBuf", strings.to_upper(t[:1], context.temp_allocator), t[1:])
	fmt.sbprintf(b, "layout(set = 0, binding = 0, scalar) buffer %s {{ %s v[]; }} %s[];\n", block, t, buf_var(t))
}

buf_var :: proc(t: string) -> string { return fmt.tprintf("%s%sBuf", strings.to_lower(t[:1], context.temp_allocator), t[1:]) }

// Emit an Odin constant as GLSL, type + value resolved by the compiler: f32/f64 → `const float`,
// anything else → `const uint`. (emit_consts is generated in types.gen.odin — one call per const.)
emit_const :: proc(b: ^strings.Builder, name: string, value: $T) {
	when intrinsics.type_is_float(T) {
		fmt.sbprintf(b, "const float %s = %s;\n", name, glsl_float(f64(value)))
	} else {
		fmt.sbprintf(b, "const uint %s = %du;\n", name, u64(value))
	}
}

// GLSL float literal — ensure a decimal point so glslc doesn't read it as an int (18 → 18.0).
glsl_float :: proc(v: f64) -> string {
	s := fmt.tprintf("%v", v)
	if strings.index_any(s, ".eE") < 0 { s = fmt.tprintf("%s.0", s) }
	return s
}

reflect_struct :: proc(tid: typeid) -> (name: string, info: reflect.Type_Info_Struct) {
	ti := type_info_of(tid)
	name = ti.variant.(reflect.Type_Info_Named).name
	info = reflect.type_info_base(ti).variant.(reflect.Type_Info_Struct)
	return
}

// GLSL name for a buffer's element type: a named struct keeps its Odin name (Body), a scalar maps
// to the builtin (u32 → uint).
glsl_typename :: proc(ti: ^reflect.Type_Info) -> string {
	base := reflect.type_info_base(ti)
	if _, ok := base.variant.(reflect.Type_Info_Struct); ok { return ti.variant.(reflect.Type_Info_Named).name }
	return glsl_type(base)
}

write :: proc(path, content: string) {
	_ = os.write_entire_file(path, transmute([]u8)content)
	fmt.printf("gen: wrote %s\n", path)
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
