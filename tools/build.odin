package main

// Build + run orchestrator. Run from the project root (see ../run.sh):
//   odin run tools/build.odin -file            build shaders + game, run (Vulkan validation ON)
//   odin run tools/build.odin -file -- watch   live-reload dev loop (release build: no validation)
//   odin run tools/build.odin -file -- shot    headless: drive the game, screenshot, exit
//   odin run tools/build.odin -file -- test    build with the test harness (-define:DEBUG_TEST) + run debug_test_run
// Shaders compile with validation on (glslc -Werror + spirv-val); the game reads shaders/spv/*.spv.

import "core:c"
import "core:c/libc"
import "core:fmt"
import "core:os"
import "core:path/filepath"
import "core:strings"
import "core:sys/linux"
import "core:time"

// src : glslc shader stage. Compiles to shaders/spv/<src>.spv.
SHADERS := [][2]string{
	{"physics.comp", "compute"},
	{"fs_tri.vert", "vertex"},
	{"city.frag", "fragment"},
	{"body.vert", "vertex"},
	{"body.frag", "fragment"},
	{"bloom.frag", "fragment"},
	{"composite.frag", "fragment"},
}

sh :: proc(cmd: string) -> int {
	return int(libc.system(strings.clone_to_cstring(cmd, context.temp_allocator)))
}

soft: bool // watch mode: a failed step prints and keeps the loop alive instead of exiting

must :: proc(cmd: string) {
	if sh(cmd) != 0 {
		fmt.eprintln("build failed:", cmd)
		if !soft { os.exit(1) }
	}
}

// The offline BAKE CACHES (assets/*.cache): static, view-independent layers pre-rendered once
// by the SEPARATE baker harness (tools/bake) so the game just samples them — the city building
// layer AND the enemy-chassis sprite atlas (bake_cache.odin: BAKE_SPECS). The game tree carries
// NO bake code — the baker is assembled at build time by copying every game .odin EXCEPT
// main.odin next to tools/bake/bake.odin (which supplies its own main + the standalone bake
// pipeline) and compiling that. Rebake when any cache is missing or older than a source that
// changes the baked pixels.
// NOTE: a live `watch` session editing ONLY the shaders (.glsl saves, no game relaunch) won't
// auto-rebake — rerun ./run.sh to refresh the baked layers.
BAKE_CACHES := []string{"assets/city.cache", "assets/body.cache"}
BAKE_SRCS := []string{"shaders/common.glsl", "shaders/city.frag", "shaders/body.frag", "car.odin", "render.odin", "bake_cache.odin", "tools/bake/bake.odin"}
BAKE_GEN :: "tools/bake/gen" // assembled baker package (copied game sources + harness)

ensure_bakes :: proc() {
	// the baker frags (one per job) are also sources — glob them in.
	frags, _ := filepath.glob("tools/bake/*.frag")
	stale := false
	oldest := i64(max(i64))
	for c in BAKE_CACHES {
		ct, cerr := os.last_write_time_by_name(c)
		if cerr != os.ERROR_NONE { stale = true; break }
		oldest = min(oldest, time.to_unix_nanoseconds(ct))
	}
	if !stale {
		for s in slice_concat(BAKE_SRCS, frags) {
			st, serr := os.last_write_time_by_name(s)
			if serr == os.ERROR_NONE && time.to_unix_nanoseconds(st) > oldest { stale = true; break }
		}
	}
	if !stale { return }
	fmt.println(">> baking static caches (a bake source changed)…")
	assemble_harness(BAKE_GEN, "tools/bake") // game sources (minus main.odin) + the baker's main
	// each baker frag → shaders/spv (loaded by the harness at runtime), validated.
	for f in frags {
		name := filepath.base(f) // e.g. bake_city.frag
		must(fmt.tprintf("glslc -I shaders --target-env=vulkan1.3 -Werror -fshader-stage=fragment %s -o shaders/spv/%s.tmp.spv", f, name))
		must(fmt.tprintf("spirv-val shaders/spv/%s.tmp.spv", name))
		must(fmt.tprintf("mv shaders/spv/%s.tmp.spv shaders/spv/%s.spv", name, name))
	}
	must(fmt.tprintf("odin build %s -debug -out:bake.tmp", BAKE_GEN)) // -debug → the bake VALIDATES too
	must("mv -f bake.tmp bake")                                       // atomic: never write a possibly-busy inode
	must("./bake")
}

slice_concat :: proc(a, b: []string) -> []string {
	out := make([]string, len(a) + len(b), context.temp_allocator)
	copy(out[:], a); copy(out[len(a):], b)
	return out
}

// Assemble a harness package: a FRESH copy of every game .odin EXCEPT main.odin (the harness
// supplies its own) into `gendir`, then the harness's own .odin on top. Rebuilt from scratch
// on EVERY invocation (rm -rf first), and it copies the whole game by glob — so the harness
// can never drift out of sync: add/rename/remove a game source and the copy tracks it, and any
// symbol mismatch is a loud compile error, not silent staleness. Shared by the baker
// (tools/citybake) and the headless dev harness (tools/devharness).
assemble_harness :: proc(gendir, harness_dir: string) {
	must(fmt.tprintf("rm -rf '%s' && mkdir -p '%s'", gendir, gendir))
	must(fmt.tprintf("cp ./*.odin '%s'/", gendir))         // every game source at the repo root…
	must(fmt.tprintf("rm -f '%s'/main.odin", gendir))      // …minus the game's main (harness has its own)
	must(fmt.tprintf("cp '%s'/*.odin '%s'/", harness_dir, gendir)) // + the harness's main / code
}

// Build the headless dev harness (gpuav/shot/test) into ./devharness. -debug → it validates
// (unless `release`, for profile.sh's ngfx/nsys runs which need the layers off).
DEV_GEN :: "tools/devharness/gen"
build_devharness :: proc(release := false) {
	assemble_harness(DEV_GEN, "tools/devharness")
	// Build to a .tmp then rename: a devharness still draining from a prior shot/test/profile run
	// holds the executable open (ETXTBSY), so `-out:devharness` would intermittently fail. The
	// rename is atomic and never touches the busy inode — reliable every time.
	must(fmt.tprintf("odin build %s %s -out:devharness.tmp", DEV_GEN, release ? "" : "-debug"))
	must("mv -f devharness.tmp devharness")
}

// Regenerate the shared GLSL from the @glsl blocks, then compile every shader to SPIR-V.
// The whole producer path holds the build lock: a `./run.sh shot` (Claude's verify loop)
// runs ALONGSIDE a live `watch` session (the human playing), and both regenerate
// gen.glsl + shaders/spv/* — unserialized they interleave writes into the same files.
prep :: proc() {
	build_lock()
	defer build_unlock()
	gen_types()                // @glsl blocks → tools/gen/types.gen.odin
	must("odin run tools/gen") // reflect them → shaders/gen.glsl + accessors
	build_shaders(soft)        // GLSL → shaders/spv/*.spv (naga cross-check in watch mode)
}

// Compile every shader to shaders/spv/*.spv with validation on (glslc -Werror + spirv-val).
// naga=true additionally cross-checks each SPIR-V with naga — advisory (it can't parse all the
// legal SPIR-V glslc emits for the bindless design), so its output is shown, never gated.
// Each .spv is compiled + validated as a .tmp.spv and RENAMED into place: the rename is
// atomic, so the running game's hot-reload (and a concurrent headless pass loading its
// pipelines) can never read a half-written shader.
build_shaders :: proc(naga: bool) {
	os.make_directory("shaders/spv")
	for s in SHADERS {
		src, stage := s[0], s[1]
		must(fmt.tprintf("glslc -I shaders --target-env=vulkan1.3 -Werror -fshader-stage=%s shaders/%s -o shaders/spv/%s.tmp.spv", stage, src, src))
		must(fmt.tprintf("spirv-val shaders/spv/%s.tmp.spv", src))
		if naga { sh(fmt.tprintf("naga shaders/spv/%s.tmp.spv", src)) } // advisory cross-check
		must(fmt.tprintf("mv shaders/spv/%s.tmp.spv shaders/spv/%s.spv", src, src))
	}
	fmt.println("shaders → shaders/spv/")
}

// Cross-process build lock (flock on a root-level lock file): serializes every shader/
// gen producer across concurrent tools/build.odin processes. Released automatically on
// process exit, so a crashed builder can never wedge the other one.
lock_fd := linux.Fd(-1)
build_lock :: proc() {
	if lock_fd < 0 {
		fd, err := linux.open(".build.lock", {.RDWR, .CREAT}, {.IRUSR, .IWUSR})
		if err != .NONE { return } // lockless fallback — same behavior as before the lock existed
		lock_fd = fd
	}
	_ = linux.flock(lock_fd, {.EX}) // blocks until the other builder finishes
}
build_unlock :: proc() {
	if lock_fd >= 0 { _ = linux.flock(lock_fd, {.UN}) }
}

// Scan every .odin in the project root for `// @glsl … // @glsl-end` blocks (structs + constants,
// in any file) and the BUF_SPECS table, and write tools/gen/types.gen.odin: the blocks copied
// verbatim (so tools/gen reflects the real Odin types AND the compiler evaluates the constants),
// plus a typeid enumeration, the buffer table, and one emit_const call per constant. The only
// parsing is reading declaration names — layout + values are left to reflection / the compiler.
gen_types :: proc() {
	files, _ := filepath.glob("*.odin", context.temp_allocator)

	blob:   strings.Builder // @glsl declarations, copied verbatim
	types:  [dynamic]string // struct type names
	consts: [dynamic]string // constant names
	bufsrc: string          // the file text that holds BUF_SPECS

	for path in files {
		src, err := os.read_entire_file(path, context.temp_allocator)
		if err != nil { continue }
		text := string(src)
		if strings.contains(text, "BUF_SPECS :=") { bufsrc = text }
		B :: "// @glsl\n"
		rest := text
		for {
			i := strings.index(rest, B)
			if i < 0 { break }
			rest = rest[i + len(B):]
			j := strings.index(rest, "// @glsl-end")
			if j < 0 { fmt.eprintln("build: unterminated @glsl block in", path); os.exit(1) }
			block := rest[:j]
			rest = rest[j:]
			strings.write_string(&blob, block)
			b2 := block
			for line in strings.split_lines_iterator(&b2) {
				t := strings.trim_space(line)
				if len(t) == 0 || strings.has_prefix(t, "//") { continue }
				k := strings.index(line, "::")
				if k < 0 { continue }
				name := strings.trim_space(line[:k])
				if strings.contains(line, "struct") { append(&types, name) } else { append(&consts, name) }
			}
		}
	}
	if len(types) == 0 { fmt.eprintln("build: no `Name :: struct` in any @glsl block"); os.exit(1) }
	if bufsrc == "" { fmt.eprintln("build: BUF_SPECS not found"); os.exit(1) }

	out: strings.Builder
	strings.write_string(&out, "package main\n\nimport \"core:strings\"\n\n// AUTO-GENERATED by tools/build.odin — do not edit.\n\n")
	strings.write_string(&out, strings.to_string(blob))
	strings.write_string(&out, "\nGLSL_TYPES := []typeid{ ")
	for name, i in types { if i > 0 { strings.write_string(&out, ", ") }; strings.write_string(&out, name) }
	strings.write_string(&out, " }\n")

	// Buffers: parse each BUF_SPECS row for its GLSL accessor name (first string literal) and
	// element type (next token). Row order = bindless slot; size/host stay CPU-side.
	rows := bufsrc[strings.index(bufsrc, "BUF_SPECS"):]
	rows = rows[strings.index(rows, "{") + 1:] // into the [Res]BufSpec{ … } literal
	strings.write_string(&out, "GLSL_BUFFERS := []GBuf{ ")
	nb := 0
	for line in strings.split_lines_iterator(&rows) {
		if strings.has_prefix(strings.trim_space(line), "}") { break } // end of the literal
		q := strings.index(line, "\"");                if q < 0 { continue }
		q2 := strings.index(line[q + 1:], "\"");        if q2 < 0 { continue }
		glsl := line[q + 1 : q + 1 + q2]
		after := strings.trim_left(line[q + 1 + q2 + 1:], " ,")
		ce := strings.index(after, ",");                if ce < 0 { continue }
		if nb > 0 { strings.write_string(&out, ", ") }
		fmt.sbprintf(&out, "{{\"%s\", %s}}", glsl, strings.trim_space(after[:ce]))
		nb += 1
	}
	strings.write_string(&out, " }\n")
	if nb == 0 { fmt.eprintln("build: no rows parsed from BUF_SPECS"); os.exit(1) }

	// One emit_const call per constant — tools/gen resolves value + GLSL type by reflection.
	strings.write_string(&out, "emit_consts :: proc(b: ^strings.Builder) {\n")
	for name in consts { fmt.sbprintf(&out, "\temit_const(b, \"%s\", %s)\n", name, name) }
	strings.write_string(&out, "}\n")

	os.make_directory("tools/gen")
	_ = os.write_entire_file("tools/gen/types.gen.odin", transmute([]u8)strings.to_string(out))
}

main :: proc() {
	mode := len(os.args) > 1 ? os.args[1] : "run"

	// watch: the HUMAN's live-reload play loop (runtime validation OFF). Own loop below; no
	// GPU-AV pass — it loads fast and must survive a failing compile. Claude must NOT use watch.
	if mode == "watch" {
		watch()
		return
	}

	// `shaders`: regen gen.glsl + compile shaders/spv/*, then exit — no game build/run.
	// Used by profile.sh to guarantee current SPIR-V before an external profiler launch.
	if mode == "shaders" {
		prep()
		return
	}

	// `devrelease`: build the dev harness as a RELEASE binary (validation OFF) + ensure the
	// city cache, then exit. profile.sh uses it so ngfx/nsys profile the shipping-perf path.
	if mode == "devrelease" {
		prep()
		ensure_bakes()
		build_devharness(release = true)
		return
	}

	// `harness`: build the VALIDATED (debug) dev harness + ensure the baked caches, then exit —
	// no run. shot.sh builds with this once, then runs `./devharness shot` with its own env knobs
	// (camera/fire/res/output) for a reliable capture of ANY vantage without touching game code.
	if mode == "harness" {
		prep()
		ensure_bakes()
		build_devharness()
		return
	}

	// `shot`/`test` run the SEPARATE devharness binary (tools/devharness) — the game binary is
	// never built or replaced, so a headless capture/profile can run ALONGSIDE a live `watch`
	// session without fighting over the executable. All headless/drive/profiling code lives in
	// the harness; the game source is pure.
	if mode == "shot" || mode == "test" {
		prep()
		ensure_bakes()
		build_devharness()
		fmt.printf("EXIT: %d\n", sh(fmt.tprintf("./devharness %s", mode)) >> 8 & 0xff)
		return
	}

	// `dist [linux|windows|mac|all]`: cross-compile shippable native builds FROM LINUX (default all).
	// Godot-style — one Linux host produces Windows/macOS/Linux bundles. See the dist section below.
	if mode == "dist" {
		target := len(os.args) > 2 ? os.args[2] : "all"
		dist(target)
		return
	}

	// `deploy steam [user]`: build the steam bundles + upload to the Playtest depot via steamcmd.
	// The login must already be cached (run `steamcmd +login <user>` once). STEAM_USER (or the 3rd
	// arg) is the login. The build is uploaded but NOT set live — flip it live on the default branch
	// yourself in Steamworks -> SteamPipe -> Builds (steamcmd can't set the default branch live).
	if mode == "deploy" {
		if len(os.args) < 3 || os.args[2] != "steam" {
			fmt.eprintln("deploy: only 'steam' is supported — use ./run.sh deploy steam [user]")
			os.exit(1)
		}
		dist("steam")
		user := len(os.args) > 3 ? os.args[3] : os.get_env("STEAM_USER", context.temp_allocator)
		if user == "" {
			fmt.eprintln("deploy steam: set STEAM_USER=<steam login> (or pass it as the 3rd arg); login must be cached (`steamcmd +login <user>` once)")
			os.exit(1)
		}
		// $(pwd) → the project root (run.sh cd's here); steamcmd wants an absolute app_build.vdf path.
		must(cat("steamcmd +login ", user, ` +run_app_build "$(pwd)/tools/steam/app_build.vdf" +quit`))
		fmt.println(">> uploaded — now set the build live on the DEFAULT branch in Steamworks -> SteamPipe -> Builds.")
		return
	}

	// default `run`: build + validate + launch the actual game.
	sh("pkill -x toomanymachines 2>/dev/null; sleep 0.1")
	prep()
	must("odin build . -out:toomanymachines -debug")
	ensure_bakes() // the static city the game loads (rebakes if a bake source changed)
	build_devharness()

	// GPU-Assisted validation pass: drive the sim headless under GPU-AV (runtime descriptor/OOB
	// checks the CPU-side layers can't see). Aborts non-zero on any finding.
	fmt.println(">> GPU-Assisted validation pass…")
	must("./devharness gpuav")

	fmt.printf("EXIT: %d\n", sh("./toomanymachines") >> 8 & 0xff)
}

// --- watch: live-reload dev loop -------------------------------------------
// Two inotify watches: the root (.odin saves → regen + recompile shaders + rebuild + relaunch)
// and shaders/ (.glsl saves → recompile SPIR-V only; the running game reloads the new .spv on its
// own). Everything runs in-process (prep/build_shaders/odin build) — a failed step prints and the
// loop lives on (soft=true). Flat project, no recursive scan.
foreign import c_ "system:c"
foreign c_ {
	inotify_init      :: proc() -> c.int ---
	inotify_add_watch :: proc(fd: c.int, path: cstring, mask: c.uint) -> c.int ---
	read              :: proc(fd: c.int, buf: rawptr, count: c.size_t) -> c.ssize_t ---
	poll              :: proc(fds: rawptr, nfds: c.ulong, timeout: c.int) -> c.int ---
}
Poll_Fd :: struct { fd: c.int, events, revents: c.short }
Inotify_Event :: struct #packed { wd: c.int, mask, cookie, len: c.uint }
WATCH_MASK :: 0x00000002 | 0x00000080 | 0x00000008 // IN_MODIFY | IN_MOVED_TO | IN_CLOSE_WRITE

// Rebuild + relaunch as a RELEASE build (no -debug → ODIN_DEBUG off → validation compiled out):
// this is the human's frame-time loop, fast and unvalidated. `./run.sh`/shot/test build -debug.
launch :: proc() {
	fmt.println("Building…")
	sh("pkill -x toomanymachines 2>/dev/null; sleep 0.1")
	if sh("odin build . -out:toomanymachines") == 0 {
		ensure_bakes() // the game loads the baked caches at startup
		fmt.println("OK — launching (release build: no validation, fast)")
		sh("nohup ./toomanymachines >/dev/null 2>&1 &")
	} else {
		fmt.println("BUILD FAILED")
	}
}

watch :: proc() {
	fmt.println(">> watch = the HUMAN's play loop (release build, no validation). Claude: use ./run.sh / shot / test.")
	soft = true
	prep(); launch() // initial build + launch

	fd := inotify_init()
	if fd < 0 { fmt.eprintln("inotify_init failed"); return }
	if inotify_add_watch(fd, ".", WATCH_MASK) < 0 { fmt.eprintln("add_watch . failed"); return }
	if inotify_add_watch(fd, "shaders", WATCH_MASK) < 0 { fmt.eprintln("add_watch shaders failed"); return }
	fmt.println("Watching . (.odin) + shaders (.glsl)")

	buf: [4096]u8
	fds := Poll_Fd{fd = fd, events = 0x0001 /*POLLIN*/}
	for {
		if poll(&fds, 1, -1) <= 0 || (fds.revents & 0x0001) == 0 { continue }
		time.sleep(120 * time.Millisecond) // debounce editors writing several files at once

		odin, glsl := false, false
		for {
			n := read(fd, &buf[0], 4096)
			if n <= 0 { break }
			for i := 0; i < int(n); {
				ev := (^Inotify_Event)(&buf[i])
				if ev.len > 0 {
					name := string(cstring(&buf[i + size_of(Inotify_Event)]))
					if strings.has_suffix(name, ".odin") {
						odin = true // any .odin may hold an @glsl block
					} else if name != "gen.glsl" && has_shader_ext(name) {
						glsl = true // gen.glsl is generated, not a source
					}
				}
				i += size_of(Inotify_Event) + int(ev.len)
			}
			if int(n) < 4096 { break }
		}
		if odin      { prep(); launch() }   // .odin → regen GLSL, recompile shaders, rebuild + relaunch
		else if glsl { build_lock(); build_shaders(true); build_unlock() } // .glsl → recompile .spv; the running game reloads it
	}
}

has_shader_ext :: proc(name: string) -> bool {
	for ext in ([]string{".vert", ".frag", ".comp", ".glsl"}) { if strings.has_suffix(name, ext) { return true } }
	return false
}

// ══ dist: cross-compile shippable Windows / macOS / Linux bundles FROM LINUX ═══════════════════
//   ./run.sh dist            all three targets
//   ./run.sh dist linux|windows|mac
//
// Godot-style: one Linux host builds every native target. Odin emits the game as an OBJECT for the
// target (`-build-mode:obj -target:...`); `zig cc` links it — zig carries the glibc / mingw-w64 /
// macOS sysroots, so no MSVC, no osxcross, no Windows/Mac machine. The ONLY library ever linked is
// SDL3 (window + input); Vulkan is loaded at runtime, so it is never linked — on macOS that runtime
// driver is MoltenVK (Vulkan-on-Metal), bundled into the .app and pointed at via SDL_VULKAN_LIBRARY.
// Linux targets an OLD glibc (below) so the binary runs on ancient distros. The game finds its data
// through SDL_GetBasePath at startup (see loop.odin), so shaders/spv + assets ship beside the binary
// (in Contents/Resources for the .app).
//
// Prebuilt SDL3 + MoltenVK come from conda-forge (pinned below) into a gitignored libs/ cache — the
// same trusted source across all targets. Host tools needed: zig, curl, unzip, zstd, tar, zip, and
// (mac only) llvm-install-name-tool + a code signer (rcodesign — `cargo install apple-codesign`).
// Bump a lib by picking a new build string from https://anaconda.org/conda-forge/<pkg>/files.
CONDA           :: "https://conda.anaconda.org/conda-forge/"
PKG_SDL3_LINUX  :: "linux-64/sdl3-3.4.12-hdeec2a5_0.conda"
PKG_ICONV_LINUX :: "linux-64/libiconv-1.18-h3b78370_2.conda" // conda's SDL3 hard-links libiconv.so.2 — bundle it
PKG_SDL3_WIN    :: "win-64/sdl3-3.4.12-h5112557_0.conda"
PKG_SDL3_MAC    :: "osx-arm64/sdl3-3.4.12-h6fa9c73_0.conda"
PKG_MVK_MAC     :: "osx-arm64/moltenvk-1.4.1-h407b865_0.conda"
DIST_GLIBC      :: "2.17" // oldest glibc the linux binary targets — matches the conda SDL3 floor

// The macOS .app property list. LSEnvironment sets the process env for a Finder launch:
//  - SDL_VULKAN_LIBRARY → SDL.Vulkan_LoadLibrary(nil) (loop.odin) loads the bundled MoltenVK;
//    @executable_path is expanded by dyld at load time.
//  - MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS=1 → the renderer is bindless (unsized runtime descriptor
//    arrays + update-after-bind), which MoltenVK can only honor through Metal tier-2 argument
//    buffers; force them on so device/descriptor-set creation succeeds on Apple Silicon.
INFO_PLIST :: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>TooManyMachines</string>
	<key>CFBundleDisplayName</key><string>TooManyMachines</string>
	<key>CFBundleIdentifier</key><string>com.mikestone.toomanymachines</string>
	<key>CFBundleExecutable</key><string>toomanymachines</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleVersion</key><string>1.0</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>LSMinimumSystemVersion</key><string>11.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>LSEnvironment</key>
	<dict>
		<key>SDL_VULKAN_LIBRARY</key><string>@executable_path/../Frameworks/libMoltenVK.dylib</string>
		<key>MVK_CONFIG_USE_METAL_ARGUMENT_BUFFERS</key><string>1</string>
	</dict>
</dict>
</plist>
`

// Windows glue compiled alongside the game object: _fltused is the MSVC float marker Odin's codegen
// references, and WinMain→main lets -mwindows build a GUI-subsystem exe (no console) while keeping
// Odin's C `main` as the real entry.
WINSHIM :: `int _fltused = 1;
int main(int, char **);
__stdcall int WinMain(void *a, void *b, char *c, int d) { (void)a; (void)b; (void)c; (void)d; return main(0, 0); }
`

cat :: proc(parts: ..string) -> string { return strings.concatenate(parts, context.temp_allocator) }

dist :: proc(target: string) {
	prep()              // regen gen.glsl + compile shaders/spv (bundled)
	ensure_bakes() // bake the city + body caches if a march source changed (bundled)
	os.make_directory("dist")
	os.make_directory("dist/.obj")
	switch target {
	case "linux":   dist_linux()
	case "windows": dist_windows()
	case "mac":     dist_mac()
	case "all":     dist_linux(); dist_windows(); dist_mac()
	case "steam":   dist_steam()
	case:
		fmt.eprintln("dist: unknown target", target, "— use linux | windows | mac | all | steam")
		os.exit(1)
	}
	fmt.println(">> dist bundles in dist/")
}

// Download + extract a conda-forge package into libs/<dest>/ unless <sentinel> is already there.
// A .conda is a zip wrapping pkg-*.tar.zst (the file payload); crack it with unzip + zstd + tar.
dist_fetch :: proc(pkg, dest, sentinel: string) {
	if os.exists(sentinel) { return }
	fmt.println(">> fetch", pkg)
	must(cat("mkdir -p libs/", dest))
	must(cat(`root="$PWD"; t=$(mktemp -d) && curl -fsSL -o "$t/p.conda" '`, CONDA, pkg,
		`' && unzip -qo "$t/p.conda" -d "$t" && zstd -dc "$t"/pkg-*.tar.zst | tar -x -C "$root/libs/`, dest,
		`" && rm -rf "$t"`))
}

// Compile the game to a release object for `otarget`; returns "<outbase>.obj" (Odin's obj name).
dist_obj :: proc(otarget, outbase: string) -> string {
	// odin needs the object extension spelled out in -out: (.obj for windows, .o elsewhere).
	out := cat(outbase, strings.contains(otarget, "windows") ? ".obj" : ".o")
	must(cat("odin build . -build-mode:obj -target:", otarget,
		" -use-single-module -o:speed -no-bounds-check -disable-assert -out:", out))
	return out
}

// Stage the runtime data (compiled shaders + baked city) under <dir> where the game reads it,
// relative to SDL_GetBasePath at startup.
dist_data :: proc(dir: string) {
	must(cat("mkdir -p '", dir, "/shaders/spv' '", dir, "/assets'"))
	must(cat("cp shaders/spv/*.spv '", dir, "/shaders/spv/'"))
	must(cat("cp assets/*.cache '", dir, "/assets/'")) // city.cache + body.cache (see BAKE_CACHES)
}

// Linux: old-glibc x86_64 tarball. rpath $ORIGIN/lib finds the bundled SDL3 + libiconv.
dist_linux :: proc() {
	dist_fetch(PKG_SDL3_LINUX,  "linux", "libs/linux/lib/libSDL3.so")
	dist_fetch(PKG_ICONV_LINUX, "linux", "libs/linux/lib/libiconv.so.2")
	obj := dist_obj("linux_amd64", "dist/.obj/tmm_linux")
	D := "dist/toomanymachines-linux-x86_64"
	must(cat("rm -rf '", D, "' && mkdir -p '", D, "/lib'"))
	must(cat("zig cc -target x86_64-linux-gnu.", DIST_GLIBC, " '", obj,
		"' -o '", D, "/toomanymachines' -Llibs/linux/lib -lSDL3 -lm -ldl -lpthread -Wl,-rpath,'$ORIGIN/lib' -s"))
	must(cat("cp -L libs/linux/lib/libSDL3.so.0 '", D, "/lib/libSDL3.so.0'"))
	must(cat("cp -L libs/linux/lib/libiconv.so.2 '", D, "/lib/libiconv.so.2'"))
	dist_data(D)
	must(cat("tar czf '", D, ".tar.gz' -C dist toomanymachines-linux-x86_64"))
	fmt.println("   →", cat(D, ".tar.gz"))
}

// Windows: GUI-subsystem x86_64 .exe + SDL3.dll, zipped. mingw link via zig; the shim supplies
// WinMain/_fltused, -lbcrypt satisfies the runtime RNG.
dist_windows :: proc() {
	dist_fetch(PKG_SDL3_WIN, "windows", "libs/windows/Library/bin/SDL3.dll")
	obj := dist_obj("windows_amd64", "dist/.obj/tmm_win")
	D := "dist/toomanymachines-windows-x86_64"
	_ = os.write_entire_file("dist/.obj/winshim.c", string(WINSHIM))
	must("zig cc -target x86_64-windows-gnu -c dist/.obj/winshim.c -o dist/.obj/winshim.obj")
	must(cat("rm -rf '", D, "' && mkdir -p '", D, "'"))
	must(cat("zig cc -target x86_64-windows-gnu -mwindows -Wl,--subsystem,windows '", obj,
		"' dist/.obj/winshim.obj -lbcrypt libs/windows/Library/bin/SDL3.dll -o '", D, "/toomanymachines.exe' -s"))
	must(cat("cp libs/windows/Library/bin/SDL3.dll '", D, "/'"))
	dist_data(D)
	must("cd dist && rm -f toomanymachines-windows-x86_64.zip && zip -qry toomanymachines-windows-x86_64.zip toomanymachines-windows-x86_64")
	fmt.println("   →", cat(D, ".zip"))
}

// macOS (arm64 / Apple Silicon): a .app bundle. MoltenVK is the Vulkan driver; SDL loads it via the
// Info.plist SDL_VULKAN_LIBRARY env. Its @rpath/libc++ dep is repointed at the OS copy.
dist_mac :: proc() {
	dist_fetch(PKG_SDL3_MAC, "mac-arm64", "libs/mac-arm64/lib/libSDL3.0.dylib")
	dist_fetch(PKG_MVK_MAC,  "mvk-arm64", "libs/mvk-arm64/lib/libMoltenVK.dylib")
	obj := dist_obj("darwin_arm64", "dist/.obj/tmm_mac")
	APP := "dist/toomanymachines-macos-arm64/TooManyMachines.app"
	must("rm -rf 'dist/toomanymachines-macos-arm64'")
	must(cat("mkdir -p '", APP, "/Contents/MacOS' '", APP, "/Contents/Frameworks' '", APP, "/Contents/Resources'"))
	must(cat("zig cc -target aarch64-macos -mmacos-version-min=11.0 '", obj,
		"' -o '", APP, "/Contents/MacOS/toomanymachines' -Llibs/mac-arm64/lib -lSDL3 -Wl,-rpath,@executable_path/../Frameworks"))
	// llvm binutils, whatever they're named on this host (unsuffixed or -NN).
	STRIP :: `S=""; for c in llvm-strip llvm-strip-20 llvm-strip-19 llvm-strip-18; do S=$(command -v "$c") && break; done`
	INT :: `I=""; for c in llvm-install-name-tool llvm-install-name-tool-20 llvm-install-name-tool-19 llvm-install-name-tool-18; do I=$(command -v "$c") && break; done`
	sh(cat(STRIP, `; [ -n "$S" ] && "$S" -x '`, APP, "/Contents/MacOS/toomanymachines'")) // best-effort size trim
	must(cat("cp -L libs/mac-arm64/lib/libSDL3.0.dylib '", APP, "/Contents/Frameworks/libSDL3.0.dylib'"))
	must(cat("cp -L libs/mvk-arm64/lib/libMoltenVK.dylib '", APP, "/Contents/Frameworks/libMoltenVK.dylib'"))
	// MoltenVK's rpath is @loader_path/ but libc++ lives in the OS — point straight at the system copy.
	must(cat(INT, `; [ -n "$I" ] || { echo "dist mac: need llvm-install-name-tool (install llvm)"; exit 1; }; "$I" -change @rpath/libc++.1.dylib /usr/lib/libc++.1.dylib '`, APP, "/Contents/Frameworks/libMoltenVK.dylib'"))
	_ = os.write_entire_file(cat(APP, "/Contents/Info.plist"), string(INFO_PLIST))
	dist_data(cat(APP, "/Contents/Resources"))
	// Ad-hoc sign the FINISHED bundle (last — the signature seals the whole tree). Apple Silicon
	// refuses to run unsigned or stale-signed code, and strip/install_name_tool above only re-sign
	// on LLVM ≥ 16 — so sign authoritatively here. rcodesign (Linux) or codesign (if building on a
	// Mac) both deep-sign in place; with neither, the bundle still carries the linker's ad-hoc
	// signature, which is valid on LLVM ≥ 16.
	must(cat(`if command -v rcodesign >/dev/null 2>&1; then rcodesign sign '`, APP,
		`'; elif command -v codesign >/dev/null 2>&1; then codesign --force --deep --sign - '`, APP,
		`'; else echo "dist mac: no rcodesign/codesign found — relying on the linker ad-hoc signature (valid on LLVM >= 16; otherwise codesign on a Mac)"; fi`))
	must("cd dist/toomanymachines-macos-arm64 && rm -f ../toomanymachines-macos-arm64.zip && zip -qry ../toomanymachines-macos-arm64.zip TooManyMachines.app")
	fmt.println("   → dist/toomanymachines-macos-arm64.zip")
}

// Steam: build all three and lay them out as SteamPipe depot content under dist/steam/content/.
// Upload with `steamcmd +run_app_build $(pwd)/tools/steam/app_build.vdf` (fill in the IDs there).
// Steam-delivered builds aren't quarantined and launch the binary directly, so the mac build runs
// without notarization or Gatekeeper prompts — the in-process MoltenVK setup (loop.odin) covers the
// direct launch. Set per-OS launch executables in the Steamworks dashboard (see tools/steam/README).
dist_steam :: proc() {
	dist_linux(); dist_windows(); dist_mac()
	must("rm -rf dist/steam/content && mkdir -p dist/steam/content/windows dist/steam/content/linux dist/steam/content/macos")
	must("cp -a dist/toomanymachines-windows-x86_64/. dist/steam/content/windows/")
	must("cp -a dist/toomanymachines-linux-x86_64/.   dist/steam/content/linux/")
	must("cp -a dist/toomanymachines-macos-arm64/TooManyMachines.app dist/steam/content/macos/")
	fmt.println("   → dist/steam/content/{windows,linux,macos} — upload via tools/steam/app_build.vdf")
}
