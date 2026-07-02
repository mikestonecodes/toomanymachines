#!/usr/bin/env bash
# Thin wrapper — all the build+run logic lives in tools/build.odin.
#   ./run.sh          build shaders + game, run (Vulkan validation ON)
#   ./run.sh watch    live-reload watcher (rebuilds the binary on .odin edits)
#   ./run.sh shot     headless: drive the game, screenshot → .debug_screenshots/, exit
cd "$(dirname "$0")"
exec odin run tools/build.odin -file -- "$@"
