package main

// Shader-type generator. Reflects the GPU structs copied out of render.odin (tools/build.odin
// writes them, plus the GLSL_TYPES enumeration, into types.gen.odin next to this file) and emits
// the GLSL contract: shaders/gen.glsl (structs + bindless buffers + push block) and one
// shaders/<Name>.glsl varying include per interface. Categorisation is by reflection:
//   • every field name `v_`-prefixed → a vertex↔fragment varying
//   • named `Push`                   → the push-constant block
//   • otherwise                      → a struct, and a bindless buffer element
// Run via `odin run tools/gen` (tools/build.odin does this after regenerating types.gen.odin).

import "core:fmt"
import "core:os"
import "core:reflect"
import "core:strings"

main :: proc() {
	b: strings.Builder
	strings.write_string(&b, "// AUTO-GENERATED from render.odin (@glsl block) — do not edit.\n")

	for tid in GLSL_TYPES { // structs — everything that isn't a varying
		name, info := reflect_struct(tid)
		if is_varying(info) { continue }
		fmt.sbprintf(&b, "struct %s {{\n", name)
		for i in 0 ..< info.field_count { fmt.sbprintf(&b, "\t%s %s;\n", glsl_type(info.types[i]), info.names[i]) }
		strings.write_string(&b, "};\n")
	}
	seen: [dynamic]string // bindless views: one storage-buffer array per distinct element type
	for gb in GLSL_BUFFERS {
		view := glsl_typename(type_info_of(gb.elem))
		found := false
		for s in seen { if s == view { found = true } }
		if !found { append(&seen, view); emit_buffer(&b, view) }
	}
	for tid in GLSL_TYPES { // the push-constant block
		name, info := reflect_struct(tid)
		if !is_varying(info) && name == "Push" { fmt.sbprintf(&b, "layout(push_constant, scalar) uniform PushBlock {{ %s pc; }};\n", name) }
	}
	// accessor macros — literal slot = row order (matches the Res ordinal / registration order)
	for gb, i in GLSL_BUFFERS {
		fmt.sbprintf(&b, "#define %s %s[%d].v\n", gb.glsl, buf_var(glsl_typename(type_info_of(gb.elem))), i)
	}
	write("shaders/gen.glsl", strings.to_string(b))

	for tid in GLSL_TYPES { // varyings → one include each; the stage #defines VARYING out|in
		name, info := reflect_struct(tid)
		if !is_varying(info) { continue }
		vb: strings.Builder
		strings.write_string(&vb, "// AUTO-GENERATED from render.odin — do not edit. Stage #defines VARYING as out|in.\n")
		for i in 0 ..< info.field_count {
			flat := glsl_int(info.types[i]) ? "flat " : ""
			fmt.sbprintf(&vb, "layout(location = %d) VARYING %s%s %s;\n", i, flat, glsl_type(info.types[i]), info.names[i])
		}
		write(fmt.tprintf("shaders/%s.glsl", name), strings.to_string(vb))
	}
}

// A struct whose fields are ALL `v_`-prefixed is a vertex↔fragment interface, not a data struct.
is_varying :: proc(info: reflect.Type_Info_Struct) -> bool {
	if info.field_count == 0 { return false }
	for i in 0 ..< info.field_count { if !strings.has_prefix(info.names[i], "v_") { return false } }
	return true
}

// The bindless storage-buffer array + its typed view, named from the element type:
//   Body → buffer BodyBuf {…} bodyBuf[];   uint → buffer UintBuf {…} uintBuf[];
GBuf :: struct { glsl: string, elem: typeid } // one BUF_SPECS row's GLSL name + element type

emit_buffer :: proc(b: ^strings.Builder, t: string) {
	block := fmt.tprintf("%s%sBuf", strings.to_upper(t[:1], context.temp_allocator), t[1:])
	fmt.sbprintf(b, "layout(set = 0, binding = 0, scalar) buffer %s {{ %s v[]; }} %s[];\n", block, t, buf_var(t))
}

buf_var :: proc(t: string) -> string { return fmt.tprintf("%s%sBuf", strings.to_lower(t[:1], context.temp_allocator), t[1:]) }

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

// Integer varyings must be `flat` — they can't be interpolated.
glsl_int :: proc(ti: ^reflect.Type_Info) -> bool {
	#partial switch v in ti.variant {
	case reflect.Type_Info_Integer:
		return true
	case reflect.Type_Info_Array:
		_, is_int := v.elem.variant.(reflect.Type_Info_Integer)
		return is_int
	}
	return false
}
