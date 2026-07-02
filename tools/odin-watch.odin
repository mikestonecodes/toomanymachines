package main

// Minimal live-reload watcher: watch one directory with inotify, and on any
// .odin/.wgsl save rebuild + relaunch the app. The project is flat (all sources in
// the root), so no recursive directory scan is needed.
//
//   odin run tools/odin-watch.odin -file -- <dir>

import "core:c"
import "core:fmt"
import "core:os"
import "core:strings"
import "core:time"

foreign import libc "system:c"
foreign libc {
	system            :: proc(cmd: cstring) -> c.int ---
	inotify_init      :: proc() -> c.int ---
	inotify_add_watch :: proc(fd: c.int, pathname: cstring, mask: c.uint) -> c.int ---
	read              :: proc(fd: c.int, buf: rawptr, count: c.size_t) -> c.ssize_t ---
	poll              :: proc(fds: [^]Poll_Fd, nfds: c.ulong, timeout: c.int) -> c.int ---
}

Poll_Fd :: struct { fd: c.int, events, revents: c.short }
POLLIN :: 0x0001

// inotify masks: file written+closed, modified, or moved into the dir.
IN_MODIFY      :: 0x00000002
IN_MOVED_TO    :: 0x00000080
IN_CLOSE_WRITE :: 0x00000008
WATCH_MASK     :: IN_MODIFY | IN_MOVED_TO | IN_CLOSE_WRITE

Inotify_Event :: struct #packed { wd: c.int, mask, cookie, len: c.uint }

EVENT_BUF_LEN :: 4096
watch_dir: string
cmd_buf: [2048]u8

// Run a shell command from inside watch_dir.
run :: proc(cmd: string) -> c.int {
	b := strings.builder_from_bytes(cmd_buf[:])
	fmt.sbprintf(&b, "cd \"%s\" && %s", watch_dir, cmd)
	strings.write_byte(&b, 0)
	return system(cstring(raw_data(cmd_buf[:])))
}

build :: proc() {
	fmt.println("Building...")
	run("pkill -x toomanymachines 2>/dev/null || true")
	time.sleep(100 * time.Millisecond)
	if run("odin build . -out:toomanymachines -debug") == 0 {
		fmt.println("OK — launching")
		run("nohup ./toomanymachines >/dev/null 2>&1 &")
	} else {
		fmt.println("BUILD FAILED")
	}
}

main :: proc() {
	watch_dir = len(os.args) > 1 ? os.args[1] : "."
	fmt.printf("Watching %s for .odin/.wgsl changes\n", watch_dir)

	fd := inotify_init()
	if fd < 0 { fmt.println("ERROR: inotify_init failed"); return }
	dir_c := strings.clone_to_cstring(watch_dir, context.temp_allocator)
	if inotify_add_watch(fd, dir_c, WATCH_MASK) < 0 { fmt.println("ERROR: add_watch failed"); return }

	build()  // initial build + launch

	buf: [EVENT_BUF_LEN]u8
	fds: [1]Poll_Fd = {{fd = fd, events = POLLIN, revents = 0}}
	for {
		// Wait for an event, then coalesce a burst of them before rebuilding once.
		if poll(&fds[0], 1, -1) <= 0 || (fds[0].revents & POLLIN) == 0 { continue }
		time.sleep(120 * time.Millisecond)  // debounce editors writing several files

		relevant := false
		for {
			n := read(fd, &buf[0], EVENT_BUF_LEN)
			if n <= 0 { break }
			i := 0
			for i < int(n) {
				ev := (^Inotify_Event)(&buf[i])
				if ev.len > 0 {
					name := string(cstring(&buf[i + size_of(Inotify_Event)]))
					if strings.has_suffix(name, ".odin") || strings.has_suffix(name, ".wgsl") { relevant = true }
				}
				i += size_of(Inotify_Event) + int(ev.len)
			}
			if int(n) < EVENT_BUF_LEN { break }  // drained
		}
		if relevant { build() }
	}
}
