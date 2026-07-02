#!/usr/bin/env bash
# Usage:
#   ./run.sh          build shaders + build + run (Vulkan validation ON)
#   ./run.sh watch    live-reload watcher — rebuilds the binary on .odin edits
#                     (.glsl edits hot-reload in-app)
#   ./run.sh shot     headless: drive the game, screenshot → .debug_screenshots/, exit
set -euo pipefail
cd "$(dirname "$0")"

pkill -x toomanymachines 2>/dev/null || true
sleep 0.1

odin run tools/build.odin -file -- --gen   # Odin structs → gen.glsl, then GLSL → shaders/spv/
odin build . -out:toomanymachines -debug

case "${1:-run}" in
	watch) exec odin run tools/odin-watch.odin -file -- . ;;
	shot)  ./toomanymachines shot; echo "EXIT: $?" ;;
	*)     ./toomanymachines; echo "EXIT: $?" ;;
esac
