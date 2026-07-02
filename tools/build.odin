package main

// Shader build. Run from the project root:
//   odin run tools/build.odin -file -- --gen   # regen gen.glsl from Odin structs, then compile
//   odin run tools/build.odin -file            # compile only (used by in-app hot reload)
// Compiles each GLSL shader → shaders/spv/*.spv with validation on (glslc -Werror +
// spirv-val). The game only ever reads those .spv files. Exits non-zero on any failure.

import "core:c/libc"
import "core:fmt"
import "core:os"
import "core:strings"

// src : glslc shader stage
SHADERS := [][2]string{
	{"physics.comp", "compute"},
	{"circle.vert", "vertex"},
	{"circle.frag", "fragment"},
}

sh :: proc(cmd: string) {
	if libc.system(strings.clone_to_cstring(cmd, context.temp_allocator)) != 0 {
		fmt.eprintln("build failed:", cmd)
		os.exit(1)
	}
}

main :: proc() {
	os.make_directory("shaders/spv")
	if len(os.args) > 1 && os.args[1] == "--gen" {
		sh("odin run tools/gen_glsl.odin -file") // Odin structs → shaders/gen.glsl
	}
	for s in SHADERS {
		src, stage := s[0], s[1]
		sh(fmt.tprintf("glslc -I shaders --target-env=vulkan1.3 -Werror -fshader-stage=%s shaders/%s -o shaders/spv/%s.spv", stage, src, src))
		sh(fmt.tprintf("spirv-val shaders/spv/%s.spv", src)) // spec validity — validation on build
	}
	fmt.println("shaders → shaders/spv/")
}
