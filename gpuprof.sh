#!/usr/bin/env bash
# gpuprof.sh — AUTHORITATIVE per-pass GPU timing via Nsight Graphics GPU Trace.
#
# The engine's own timestamp profiler (./run.sh test) is useless for A/B here: this is a
# laptop GPU whose clocks CANNOT be locked without root, and the app is present-paced, so the
# GPU boosts erratically and per-pass ms swing 2-3× run to run. Nsight Graphics locks the GPU
# clocks (--set-gpu-clocks) for the capture window and reports the true GPU time spent inside
# each debug-util label region (render.odin brackets physics/city/bodies/bloom/composite with
# gpu_label). Those per-marker times land in the D3DPERF_EVENTS export — parsed here into a
# median-ms table. Clocks locked + deterministic drive ⇒ reproducible to a couple %.
#
#   ./gpuprof.sh              # 4K, boost-locked, ~16 captured frames, prints per-pass median ms
#   ./gpuprof.sh --w 2560 --h 1600
#   ./gpuprof.sh --clocks base   # base is even more stable but less representative than boost
set -euo pipefail
cd "$(dirname "$0")"

W=3840; H=2160; CLOCKS=boost; FRAMES=16; WARMUP=140; BUILD=1
while [ $# -gt 0 ]; do
	case "$1" in
		--w) W="$2"; shift 2 ;;
		--h) H="$2"; shift 2 ;;
		--clocks) CLOCKS="$2"; shift 2 ;;   # unaltered | base | boost
		--frames) FRAMES="$2"; shift 2 ;;
		--start-after) WARMUP="$2"; shift 2 ;;
		--no-build) BUILD=0; shift ;;        # re-measure the already-built binary (reproducibility checks)
		*) echo "unknown arg: $1"; exit 2 ;;
	esac
done

command -v ngfx >/dev/null || { echo "missing: ngfx (paru -S nsight-graphics)"; exit 1; }
[ "$(cat /proc/sys/kernel/yama/ptrace_scope 2>/dev/null || echo 1)" = "0" ] || {
	echo "ptrace_scope != 0 — need: sudo sysctl kernel.yama.ptrace_scope=0"; exit 1; }
AO=$(grep -oE 'RmProfilingAdminOnly: *[0-9]+' /proc/driver/nvidia/params 2>/dev/null | awk '{print $2}')
[ "${AO:-1}" = "0" ] || { echo "RmProfilingAdminOnly=$AO (need 0) for GPU Trace"; exit 1; }

BIN="devharness"; OUT=".ngfx-perf"; ARCH="$OUT/_arch.json"
if [ "$BUILD" = "1" ]; then
	echo ">> Building $BIN (release, per-pass labels on) + city cache (${W}x${H})..."
	odin run tools/build.odin -file -- devrelease 2>&1 | sed 's/^/   /'
fi

mkdir -p "$OUT"
# Ada (RTX 4070 Laptop) throughput metrics + the SM-sampling shader profiler.
echo '[ { "architecture": "Ada", "metric-set-id": "1", "real-time-shader-profiler": "true", "multi-pass-metrics": "true" } ]' > "$ARCH"
# clear any prior export dir so we parse THIS run
rm -rf "$OUT"/*_LOCKED "$OUT"/*_UNLOCKED

echo ">> ngfx GPU Trace — clocks=$CLOCKS, warmup=$WARMUP, capture=$FRAMES frames..."
ngfx \
	--activity "GPU Trace Profiler" \
	--exe "$(pwd)/$BIN" --args "test" --dir "$(pwd)" \
	--env "SDL_VIDEO_DRIVER=x11; TMM_W=$W; TMM_H=$H; TMM_HIDDEN=1; TMM_PROFILE_LOOP=1;" \
	--start-after-frames "$WARMUP" --limit-to-frames "$FRAMES" \
	--max-duration-ms 9000 --set-gpu-clocks "$CLOCKS" \
	--per-arch-config-path "$ARCH" --pc-samples-per-pm-interval-per-sm 64 \
	--output-dir "$OUT" --auto-export 1 --no-timeout \
	> "$OUT/_ngfx.log" 2>&1 || true

EV=$(ls -t "$OUT"/*/D3DPERF_EVENTS.xls 2>/dev/null | head -1)
FR=$(ls -t "$OUT"/*/FRAME.xls 2>/dev/null | head -1)
if [ -z "${EV:-}" ]; then echo "  ngfx produced no export — tail of log:"; tail -20 "$OUT/_ngfx.log"; exit 1; fi

echo
echo "═══ per-pass GPU time (median of $FRAMES frames, clocks=$CLOCKS locked) ═══"
# D3DPERF_EVENTS.xls: row = "<label>\t<ms_frame1>\t<ms_frame2>…". Print each pass's median.
awk -F'\t' '
	function median(a, n,   i, b, m) { for(i=1;i<=n;i++) b[i]=a[i]; # copy
		for(i=1;i<=n;i++) for(m=i+1;m<=n;m++) if(b[m]<b[i]){ t=b[i];b[i]=b[m];b[m]=t }
		return (n%2)? b[(n+1)/2] : (b[n/2]+b[n/2+1])/2 }
	NR==1 { next }
	{ name=$1; k=0; for(i=2;i<=NF;i++) if($i+0==$i && $i!=""){ k++; v[k]=$i+0 }
	  if(k>0){ order[++no]=name; med[name]=median(v,k); cnt[name]=k; delete v } }
	END { tot=0
	      for(i=1;i<=no;i++){ n=order[i]; printf "  %-12s %7.3f ms\n", n, med[n]; tot+=med[n] }
	      printf "  %-12s %7.3f ms\n", "(sum)", tot }
' "$EV"
if [ -n "${FR:-}" ]; then
	awk -F'\t' '/GPU frame time/{s=0;k=0;for(i=2;i<=NF;i++)if($i+0==$i&&$i!=""){s+=$i;k++}
		if(k)printf "  %-12s %7.3f ms  (whole-frame GPU, avg)\n","frame",s/k}' "$FR"
fi
echo
echo "   raw trace: $(ls -t "$OUT"/*.ngfx-gputrace 2>/dev/null | head -1)"
