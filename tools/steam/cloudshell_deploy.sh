#!/usr/bin/env bash
# One-shot deploy to the Steam Playtest from a fresh Linux shell (e.g. Google Cloud Shell,
# free, runs in a phone browser). Installs the toolchain, bakes the city cache on a software
# Vulkan renderer, cross-compiles Windows/macOS/Linux, and uploads to Playtest depot 4933641.
# You type your Steam login when prompted (it never leaves your shell); approve 2FA on your phone.
#
#   export STEAM_USER=your_steam_login
#   bash tools/steam/cloudshell_deploy.sh
#
# First run is ~15-25 min (building Odin). Re-runs reuse the toolchain and are much faster.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/../.." && pwd)"
TC="$HOME/tmm-tc"; mkdir -p "$TC"
: "${STEAM_USER:?set STEAM_USER=your_steam_login first}"

echo "== [1/7] system packages =="
sudo apt-get update -y
sudo apt-get install -y clang lld llvm-18-dev llvm-18-tools git curl unzip zstd zip \
	glslc spirv-tools mesa-vulkan-drivers libvulkan1 python3 make build-essential

echo "== [2/7] zig =="
if [ ! -x "$TC/zig/zig" ]; then
	curl -fsSL https://ziglang.org/download/0.14.1/zig-x86_64-linux-0.14.1.tar.xz -o "$TC/zig.tar.xz"
	tar xf "$TC/zig.tar.xz" -C "$TC" && mv "$TC/zig-x86_64-linux-0.14.1" "$TC/zig"
fi
export PATH="$TC/zig:$PATH"

echo "== [3/7] odin (from source, LLVM 18) =="
if [ ! -x "$TC/Odin/odin" ]; then
	git clone --depth 1 https://github.com/odin-lang/Odin "$TC/Odin"
	( cd "$TC/Odin" && LLVM_CONFIG=llvm-config-18 ./build_odin.sh release-native )
fi
export PATH="$TC/Odin:$PATH"

echo "== [4/7] rcodesign (macOS ad-hoc signer) =="
if [ ! -x "$TC/rcodesign" ]; then
	# prebuilt static binary (a passive download; nothing to sign in to)
	RC_URL=$(curl -fsSL https://api.github.com/repos/indygreg/apple-platform-rs/releases/latest \
		| python3 -c "import json,sys;[print(a['browser_download_url']) for a in json.load(sys.stdin)['assets'] if 'x86_64-unknown-linux-musl' in a['name'] and a['name'].endswith('.tar.gz')]" | head -1)
	curl -fsSL "$RC_URL" -o "$TC/rc.tgz" && tar xzf "$TC/rc.tgz" -C "$TC" --wildcards --strip-components=1 '*/rcodesign'
fi
export PATH="$TC:$PATH"

echo "== [5/7] pre-fetch Linux SDL3 (so the cache bake can link) =="
# The cache bake builds a small native helper that links SDL3; make it available before the build.
cd "$SRC"
if [ ! -e libs/linux/lib/libSDL3.so ]; then
	mkdir -p libs/linux; t=$(mktemp -d)
	curl -fsSL -o "$t/p.conda" "https://conda.anaconda.org/conda-forge/linux-64/sdl3-3.4.12-hdeec2a5_0.conda"
	( cd "$t" && unzip -qo p.conda && zstd -dc pkg-*.tar.zst | tar -x -C "$SRC/libs/linux" )
	rm -rf "$t"
fi
export LIBRARY_PATH="$SRC/libs/linux/lib" LD_LIBRARY_PATH="$SRC/libs/linux/lib" SDL_VIDEODRIVER=offscreen

echo "== [6/7] build all three + assemble Steam content =="
./run.sh dist steam

echo "== [7/7] upload to Steam (log in when prompted; approve 2FA on your phone) =="
if [ ! -x "$TC/steamcmd/steamcmd.sh" ]; then
	mkdir -p "$TC/steamcmd"
	curl -fsSL https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | tar xz -C "$TC/steamcmd"
fi
"$TC/steamcmd/steamcmd.sh" +login "$STEAM_USER" +run_app_build "$SRC/tools/steam/app_build.vdf" +quit
echo ">> Done. In Steamworks -> Playtest app -> SteamPipe -> Builds, set the new build live on the playtest branch."
