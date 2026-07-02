#!/usr/bin/env bash
# Usage:
#   ./run.sh          build + run once (debug, Vulkan validation ON)
#   ./run.sh watch    live-reload watcher — rebuilds + relaunches on any .odin save
#                     (.glsl edits hot-reload in-app, no rebuild needed)
#   ./run.sh shot     headless: drive the game a few frames, screenshot → .debug_screenshots/, exit
set -euo pipefail
cd "$(dirname "$0")"

# Kill any prior instance so a fresh run is the only one on the GPU.
pkill -x toomanymachines 2>/dev/null || true
sleep 0.1

case "${1:-run}" in
	watch) exec odin run tools/odin-watch.odin -file -- . ;;
	shot)  odin run . -out:toomanymachines -debug -- shot; echo "EXIT: $?" ;;
	*)     odin run . -out:toomanymachines -debug; echo "EXIT: $?" ;;
esac
