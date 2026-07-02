package main

// Build + run orchestrator. Run from the project root (see ../run.sh):
//   odin run tools/build.odin -file            build shaders + game, run (Vulkan validation ON)
//   odin run tools/build.odin -file -- watch   ... then hand off to the live-reload watcher
//   odin run tools/build.odin -file -- shot    ... headless: drive the game, screenshot, exit
//   odin run tools/build.odin -file -- shaders  recompile shaders only, + naga (used by the watcher)
// Shaders compile with validation on (glslc -Werror + spirv-val); the game reads shaders/spv/*.spv.

import "core:c/libc"
import "core:fmt"
import "core:os"
import "core:strings"

// A GLSL source → one SPIR-V stage. A combined file (circle.glsl) appears once per stage with a
// stage #define; each row names its own .spv output so both stages get distinct artifacts.
Shader :: struct { src, stage, def, spv: string }
SHADERS := []Shader{
	{"physics.comp", "compute",  "",        "physics.comp.spv"},
	{"circle.glsl",  "vertex",   "VERTEX",   "circle.vert.spv"},
	{"circle.glsl",  "fragment", "FRAGMENT", "circle.frag.spv"},
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

// Compile every shader to shaders/spv/*.spv with validation on (glslc -Werror + spirv-val).
// naga=true additionally cross-checks each SPIR-V with naga — advisory (it can't parse all the
// legal SPIR-V glslc emits for the bindless design), so its output is shown, never gated.
build_shaders :: proc(naga: bool) {
	os.make_directory("shaders/spv")
	for s in SHADERS {
		def := s.def != "" ? fmt.tprintf("-D%s ", s.def) : ""
		must(fmt.tprintf("glslc -I shaders --target-env=vulkan1.3 -Werror %s-fshader-stage=%s shaders/%s -o shaders/spv/%s", def, s.stage, s.src, s.spv))
		must(fmt.tprintf("spirv-val shaders/spv/%s", s.spv))
		if naga { sh(fmt.tprintf("naga shaders/spv/%s", s.spv)) } // advisory cross-check
	}
	fmt.println("shaders → shaders/spv/")
}

main :: proc() {
	mode := len(os.args) > 1 ? os.args[1] : "run"

	// Watcher recompile: shaders only, with naga feedback — no regen, no game build, no run.
	if mode == "shaders" {
		build_shaders(true)
		return
	}

	sh("pkill -x toomanymachines 2>/dev/null; sleep 0.1")
	must("odin run tools/gen_glsl.odin -file") // Odin structs → shaders/gen.glsl
	build_shaders(false)
	must("odin build . -out:toomanymachines -debug")

	// GPU-Assisted validation pass: run the sim headless under GPU-AV (runtime descriptor/OOB
	// checks the CPU-side layers can't see). Aborts non-zero on any finding.
	fmt.println(">> GPU-Assisted validation pass…")
	must("./toomanymachines gpuav")

	switch mode {
	case "watch":
		sh("odin run tools/odin-watch.odin -file -- .") // rebuilds on .odin, recompiles shaders on .glsl
	case "shot":
		fmt.printf("EXIT: %d\n", sh("./toomanymachines shot") >> 8 & 0xff)
	case:
		fmt.printf("EXIT: %d\n", sh("./toomanymachines") >> 8 & 0xff)
	}
}
