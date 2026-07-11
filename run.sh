#!/usr/bin/env bash
# Thin wrapper — ALL build/run/capture/profile tooling lives in tools/build.odin.
#   ./run.sh          build shaders + game, run (Vulkan validation ON)
#   ./run.sh watch    live-reload watcher (rebuilds the binary on .odin edits)
#   ./run.sh shot     headless screenshot → .debug_screenshots/ (--x/--y/--no-fire/--freeze/--loader/--no-build…)
#   ./run.sh test     600-frame wall/GPU/CPU profile print
#   ./run.sh gpuprof  Nsight GPU Trace: locked-clock per-pass median ms (--w/--h/--clocks/--no-build…)
#   ./run.sh smoke    run the SHIPPED Linux + Windows (Wine) binaries: verify boot + play
#   ./run.sh dist [linux|windows|mac|all]   cross-compile shippable bundles (from Linux; default all)
cd "$(dirname "$0")"
exec odin run tools/build.odin -file -- "$@"
