#!/usr/bin/env bash
# shot.sh — RELIABLE headless capture of any vantage, no game-code edits ever. Builds the
# VALIDATED (debug) dev harness once, then drives + screenshots with env-driven knobs. The whole
# debug-capture facility lives in the harness (tools/devharness), outside the game source.
#
#   ./shot.sh                                            # default city vantage → .debug_screenshots/vk.jpg
#   ./shot.sh --x 15400 --y 9400 --no-fire --w 1920 --h 1200 --out .debug_screenshots/horde.jpg
#   ./shot.sh --no-build --x 9400 --y 3400               # reuse the built harness (fast iteration)
#   ./shot.sh --freeze --settle 6 ...                    # freeze the sim once settled (stable frame)
set -euo pipefail
cd "$(dirname "$0")"

BUILD=1
export TMM_W="${TMM_W:-960}" TMM_H="${TMM_H:-600}"
export TMM_SHOT_OUT=".debug_screenshots/vk.jpg"
while [ $# -gt 0 ]; do
	case "$1" in
		--x)       export TMM_SHOT_X="$2"; shift 2 ;;
		--y)       export TMM_SHOT_Y="$2"; shift 2 ;;
		--w)       export TMM_W="$2"; shift 2 ;;
		--h)       export TMM_H="$2"; shift 2 ;;
		--out)     export TMM_SHOT_OUT="$2"; shift 2 ;;
		--settle)  export TMM_SHOT_SETTLE="$2"; shift 2 ;;
		--no-fire) export TMM_SHOT_FIRE=0; export TMM_SHOT_LASER=0; shift ;;
		--freeze)  export TMM_SHOT_FREEZE=1; shift ;;
		--no-build) BUILD=0; shift ;;
		*) echo "unknown arg: $1"; exit 2 ;;
	esac
done

if [ "$BUILD" = "1" ]; then
	echo ">> building validated harness + baked caches…"
	odin run tools/build.odin -file -- harness 2>&1 | sed 's/^/   /'
fi
./devharness shot
echo ">> wrote $TMM_SHOT_OUT (${TMM_W}x${TMM_H})"
