package main

// The game entry point. The loop itself lives in loop.odin (run_game) so the headless dev
// harness (tools/devharness) and the offline baker (tools/citybake) can reuse it with their
// own main. The shipped game is pure: no headless modes, no drive, no profiling code — all
// of that sits behind the single dev_tick seam (app.odin), which is nil here.
main :: proc() {
	run_game()
}
