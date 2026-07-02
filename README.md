# toomanymachines

A tiny top-down shooter on a hand-written **Vulkan** renderer. Drive a red circle
("the car") with **WASD**, **aim with the mouse**, **hold left-click** to shoot
yellow bullets at a blue horde that chases you and respawns from the edges.

## Renderer

Modern, bindless Vulkan — deliberately small:

- **Vulkan 1.3**: dynamic rendering + synchronization2 (no render passes / framebuffers).
- **Bindless**: ONE descriptor set (an array of storage buffers). Every pipeline shares
  one layout; a buffer is handed to shaders by an index in a push constant. Adding a
  buffer never touches a descriptor layout.
- **GPU sim**: the horde + bullets run entirely in a GLSL compute shader
  (`shaders/physics.comp`) over a bucket grid; the CPU only drives the player.
- **Data-driven**: buffers live in `BUF_SPECS`, pipelines in `PIPE_SPECS` (`pipelines.odin`).
- **Separate build step**: `build_shaders.sh` reads the Odin structs (`gpu/types.odin`) via
  `tools/gen_glsl.odin` → `shaders/gen.glsl`, then compiles + validates each GLSL shader
  (`glslc -Werror` → `spirv-val` → `spirv-opt --validate-after-all` → `naga` advisory) into
  `shaders/spv/`. **The game only reads the compiled `.spv`** — no compiler in the game.
- **Odin → GLSL**: `Body`/`Push` are defined once in `gpu/types.odin` and injected into the
  shaders via `gen.glsl` (`#include`d, glslc `-I`).
- **Hot reload**: editing any `.glsl` re-runs `build_shaders.sh` and rebuilds the pipelines
  in-app, no restart. Plus Vulkan **validation layers** at runtime.

## Controls

| control        | action               |
|----------------|----------------------|
| **W A S D**    | drive the car        |
| **mouse**      | aim                  |
| **left-click** | shoot (hold to fire) |
| **R**          | restart              |
| **ESC**        | quit                 |

## Files

| file                    | what it is                                              |
|-------------------------|---------------------------------------------------------|
| `main.odin`             | window + loop + input                                    |
| `vk.odin`               | Vulkan backend: bootstrap, bindless, buffers, pipelines, frame |
| `pipelines.odin`        | data-driven buffer + pipeline tables, GPU structs        |
| `shaders.odin`          | loads compiled `.spv` + hot-reload trigger               |
| `gpu/types.odin`        | shared GPU structs (`Body`, `Push`) — single source      |
| `tools/gen_glsl.odin`   | build step: Odin structs → `shaders/gen.glsl`            |
| `build_shaders.sh`      | build step: GLSL → validated SPIR-V in `shaders/spv/`    |
| `car.odin`              | CPU game: player movement + bullet spawning              |
| `shaders/common.glsl`   | shared shader contract (bindless decls, push constant, consts) |
| `shaders/physics.comp`  | GPU sim: bucket grid + chase/separate/shoot/respawn      |
| `shaders/circle.{vert,frag}` | instanced circle-SDF render                        |
| `tools/odin-watch.odin` | inotify watcher (rebuilds the binary on `.odin` edits)   |

## Run

```
./run.sh          # build + run (Vulkan validation ON)
./run.sh watch    # rebuild + relaunch on .odin edits; .glsl hot-reloads in-app
./run.sh shot     # headless drive + screenshot → .debug_screenshots/
```

Requires Odin, the Vulkan SDK / `libvulkan`, `glslc` + `spirv-tools`, and
`vendor:sdl3` / `vendor:vulkan` / `vendor:stb`. Run from the project root (shaders are
read from `shaders/`). For runtime validation: `sudo pacman -S vulkan-validation-layers`.
