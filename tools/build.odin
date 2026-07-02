package main

// Build + run orchestrator. Run from the project root (see ../run.sh):
//   odin run tools/build.odin -file            build shaders + game, run (Vulkan validation ON)
//   odin run tools/build.odin -file -- watch   ... then hand off to the .odin live-reload watcher
//   odin run tools/build.odin -file -- shot    ... headless: drive the game, screenshot, exit
//   odin run tools/build.odin -file -- shaders  compile shaders only (used by in-app hot reload)
// Shaders compile with validation on (glslc -Werror + spirv-val); the game reads shaders/spv/*.spv.

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

sh :: proc(cmd: string) -> int {
	return int(libc.system(strings.clone_to_cstring(cmd, context.temp_allocator)))
}

must :: proc(cmd: string) {
	if sh(cmd) != 0 {
		fmt.eprintln("build failed:", cmd)
		os.exit(1)
	}
}

build_shaders :: proc() {
	os.make_directory("shaders/spv")
	for s in SHADERS {
		src, stage := s[0], s[1]
		must(fmt.tprintf("glslc -I shaders --target-env=vulkan1.3 -Werror -fshader-stage=%s shaders/%s -o shaders/spv/%s.spv", stage, src, src))
		must(fmt.tprintf("spirv-val shaders/spv/%s.spv", src)) // spec validity — validation on build
	}
	fmt.println("shaders → shaders/spv/")
}

main :: proc() {
	mode := len(os.args) > 1 ? os.args[1] : "run"

	// Hot reload just recompiles the shaders — no regen, no game build, no run.
	if mode == "shaders" {
		build_shaders()
		return
	}

	sh("pkill -x toomanymachines 2>/dev/null; sleep 0.1")
	must("odin run tools/gen_glsl.odin -file") // Odin structs → shaders/gen.glsl
	build_shaders()
	must("odin build . -out:toomanymachines -debug")

	switch mode {
	case "watch":
		sh("odin run tools/odin-watch.odin -file -- .") // rebuilds the binary on .odin edits
	case "shot":
		fmt.printf("EXIT: %d\n", sh("./toomanymachines shot") >> 8 & 0xff)
	case:
		fmt.printf("EXIT: %d\n", sh("./toomanymachines") >> 8 & 0xff)
	}
}
