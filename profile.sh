#!/usr/bin/env bash
# profile.sh — GPU + CPU profile of the live 80k-enemy fight at a target resolution.
#
# The dev panel is 2560x1600, so "4K" means a HIDDEN off-screen 3840x2160 swapchain
# (a visible window on a tiling WM would be resized to the panel — never truly 4K).
#
# Primary output is the engine's OWN per-pass GPU timestamp profiler (gpu_ms[6]:
# physics/city/bodies/bloom/composite/total) + CPU spans (fence+acquire/update/record/
# submit) — authoritative, exact, and it names each pass. Build is RELEASE (validation
# OFF) + DEBUG_TEST (the drive harness), so numbers reflect shipping perf.
#
#   --w N --h N   target resolution (default 3840x2160)
#   --ngfx        also capture an Nsight Graphics GPU Trace (raw .ngfx-gputrace for
#                 shader-level deep-dive in ngfx-ui — passes aren't debug-labelled, so
#                 the per-pass digest above is the readable one)
#   --cpu         also run nsys for the CPU-side Vulkan API timeline
#   --open        open the ngfx/nsys reports in their UIs
set -euo pipefail
cd "$(dirname "$0")"

W=3840; H=2160; RUN_NGFX=0; RUN_CPU=0; OPEN_UI=0
NGFX_FRAMES=8; NGFX_WARMUP=100; NSYS_DURATION=8; NSYS_DELAY=4
while [ $# -gt 0 ]; do
	case "$1" in
		--w) W="$2"; shift 2 ;;
		--h) H="$2"; shift 2 ;;
		--ngfx) RUN_NGFX=1; shift ;;
		--cpu) RUN_CPU=1; shift ;;
		--frames) NGFX_FRAMES="$2"; shift 2 ;;
		--start-after) NGFX_WARMUP="$2"; shift 2 ;;
		--open) OPEN_UI=1; shift ;;
		*) echo "unknown arg: $1"; exit 2 ;;
	esac
done

BIN="devharness"
NGFX_DIR=".ngfx-perf"; NSYS_DIR=".nsys-reports"; NSYS_REPORT="$NSYS_DIR/tmm"
need() { command -v "$1" >/dev/null || { echo "missing: $1 ($2)"; exit 1; }; }
need odin "Odin compiler"; need awk "coreutils"

pkill -f "toomanymachines watch" >/dev/null 2>&1 || true

# RELEASE dev harness (no -debug → validation layers compiled out; ngfx/nsys are incompatible
# with the KHRONOS validation layer). Assembled from the game sources + the drive harness, and
# the city cache is (re)baked if stale — all via the build step, so it's always current.
echo ">> Building $BIN (release) + city cache (${W}x${H})..."
odin run tools/build.odin -file -- devrelease

# ── 1. In-engine per-pass GPU digest (600-frame report, then self-exits) ──
echo
echo "═══ engine profiler — per-pass GPU (${W}x${H}, 600 frames) ═══"
TMM_W="$W" TMM_H="$H" TMM_HIDDEN=1 ./"$BIN" test 2>/dev/null | grep -E "frames:|GPU avg" || {
	echo "  (no profiler output — the 600-frame report didn't run)"; }

# ── 2. Optional: Nsight Graphics GPU Trace (raw trace for the UI) ──────────────
if [ "$RUN_NGFX" = "1" ]; then
	need ngfx "paru -S nsight-graphics"
	[ "$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 0)" = "0" ] || {
		echo "ptrace_scope != 0 (need 0 for ngfx): sudo sysctl kernel.yama.ptrace_scope=0"; exit 1; }
	AO=$(grep -oE 'RmProfilingAdminOnly: *[0-9]+' /proc/driver/nvidia/params 2>/dev/null | awk '{print $2}')
	[ "${AO:-0}" = "0" ] || { echo "RmProfilingAdminOnly=$AO (need 0) — see fishlab/profile.sh for the modprobe fix."; exit 1; }
	mkdir -p "$NGFX_DIR"
	ARCH_CFG="$NGFX_DIR/_arch.json"
	echo '[ { "architecture": "Ada", "metric-set-id": "1", "real-time-shader-profiler": "true", "multi-pass-metrics": "true" } ]' > "$ARCH_CFG"
	echo
	echo ">> ngfx GPU Trace (warmup=${NGFX_WARMUP}, capture=${NGFX_FRAMES} frames)..."
	rm -rf "$NGFX_DIR/BASE_UNLOCKED"
	ngfx \
		--activity "GPU Trace Profiler" \
		--exe "$(pwd)/$BIN" --args "test" --dir "$(pwd)" \
		--env "SDL_VIDEO_DRIVER=x11; TMM_W=$W; TMM_H=$H; TMM_HIDDEN=1; TMM_PROFILE_LOOP=1;" \
		--start-after-frames "$NGFX_WARMUP" --limit-to-frames "$NGFX_FRAMES" \
		--max-duration-ms 9000 --set-gpu-clocks unaltered \
		--per-arch-config-path "$ARCH_CFG" --pc-samples-per-pm-interval-per-sm 64 \
		--output-dir "$NGFX_DIR" --auto-export 1 --no-timeout \
		> "$NGFX_DIR/_ngfx.log" 2>&1 || true
	TRACE=$(ls -t "$NGFX_DIR"/*.ngfx-gputrace 2>/dev/null | head -1)
	if [ -n "${TRACE:-}" ]; then echo "   raw trace: $TRACE   (open: ngfx-ui '$TRACE')"
	else echo "   ngfx failed — see $NGFX_DIR/_ngfx.log"; tail -8 "$NGFX_DIR/_ngfx.log"; fi
fi

# ── 3. Optional: nsys CPU-side Vulkan API timeline ────────────────────────────
if [ "$RUN_CPU" = "1" ]; then
	need nsys "pacman -S nsight-systems"; mkdir -p "$NSYS_DIR"
	echo
	echo ">> nsys (delay=${NSYS_DELAY}s, capture=${NSYS_DURATION}s)..."
	rm -f "${NSYS_REPORT}.nsys-rep" "${NSYS_REPORT}.sqlite"
	TMM_W="$W" TMM_H="$H" TMM_HIDDEN=1 TMM_PROFILE_LOOP=1 nsys profile \
		--trace=vulkan --sample=none --duration="$NSYS_DURATION" --delay="$NSYS_DELAY" \
		--output="$NSYS_REPORT" --force-overwrite=true --kill=sigkill \
		./"$BIN" test > "$NSYS_DIR/_nsys.log" 2>&1 || true
	if [ -f "${NSYS_REPORT}.nsys-rep" ]; then
		echo; echo "═══ CPU-side / Vulkan API (nsys, ${NSYS_DURATION}s) ═══"; echo
		nsys stats --force-export=true --report vulkan_api_sum --format csv "${NSYS_REPORT}.nsys-rep" 2>/dev/null \
		| awk -F',' -v d="$NSYS_DURATION" '
		/^Time \(%\)/ { t=1; next }
		t && NF>=9 { n=$9; gsub(/"| /,"",n); api[n]=$2+0; cnt[n]=$3+0; avg[n]=$4+0 }
		END {
			p=cnt["vkQueuePresentKHR"]+0; if(p==0){print "  no present calls — capture missed gameplay"; exit}
			printf "  frames presented:  %d  (~%.1f fps, %.2f ms/frame)\n", p, p/d, 1000/(p/d)
			printf "  vkWaitForFences:   %.0f ms total, avg %.2f ms/call, %d calls\n", api["vkWaitForFences"]/1e6, avg["vkWaitForFences"]/1e6, cnt["vkWaitForFences"]
			printf "  vkQueueSubmit:     %.0f ms total, %d calls\n", api["vkQueueSubmit"]/1e6, cnt["vkQueueSubmit"]
			printf "  CPU waited %.1f%% of wall on the GPU (fences)\n", 100*(api["vkWaitForFences"]+0)/(d*1e9)
		}'
		echo "   raw nsys:  ${NSYS_REPORT}.nsys-rep  (open: nsys-ui '${NSYS_REPORT}.nsys-rep')"
	else echo "   nsys failed — see $NSYS_DIR/_nsys.log"; fi
fi

if [ "$OPEN_UI" = "1" ]; then
	[ "$RUN_NGFX" = "1" ] && [ -n "${TRACE:-}" ] && nohup ngfx-ui "$TRACE" >/dev/null 2>&1 &
	[ "$RUN_CPU" = "1" ] && [ -f "${NSYS_REPORT}.nsys-rep" ] && nohup nsys-ui "${NSYS_REPORT}.nsys-rep" >/dev/null 2>&1 &
fi
echo
