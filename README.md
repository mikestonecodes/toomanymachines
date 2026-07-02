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
- **Data-driven**: buffers live in `BUF_SPECS`, pipelines in `PIPE_SPECS` (`render.odin`).
- **Separate build step**: `tools/build.odin` copies the GPU structs from render.odin's `@glsl`
  block into `tools/gen`, which reflects them → `shaders/gen.glsl`, then compiles + validates each
  GLSL shader (`glslc -Werror` → `spirv-val`) into `shaders/spv/`. **The game only reads the
  compiled `.spv`** — no compiler in the game.
- **Odin → GLSL**: `Body`/`Push`/`CircleIO` are defined once in render.odin and reflected into the
  shader `#include`s (structs, bindless buffers, push block, varyings) — one source of truth.
- **Hot reload**: the game watches its compiled `.spv` and reloads pipelines when they change.
  Under `./run.sh watch` the watcher recompiles GLSL → SPIR-V (+ naga) on save, so editing a
  `.glsl` reloads in-app, no restart. Plus Vulkan **validation layers** at runtime.

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
| `render.odin`           | high-level surface: buffer list, pipeline list, init, render() |
| `shaders.odin`          | loads compiled `.spv` + hot-reload trigger               |
| `tools/gen/`            | reflects render.odin's GPU structs → `shaders/gen.glsl` + varyings |
| `tools/build.odin`      | build step: GLSL → validated SPIR-V in `shaders/spv/`    |
| `car.odin`              | CPU game: player movement + bullet spawning              |
| `shaders/common.glsl`   | shared shader contract (bindless decls, push constant, consts) |
| `shaders/physics.comp`  | GPU sim: bucket grid + chase/separate/shoot/respawn      |
| `shaders/circle.{vert,frag}` | instanced circle-SDF render (`circle_io.glsl` = shared varyings) |
| `tools/odin-watch.odin` | inotify watcher (rebuilds the binary on `.odin` edits)   |

## Run

```
./run.sh          # build + run (Vulkan validation ON)
./run.sh watch    # watcher: recompile shaders (+naga) on .glsl, rebuild binary on .odin
./run.sh shot     # headless drive + screenshot → .debug_screenshots/
```

Requires Odin, the Vulkan SDK / `libvulkan`, `glslc` + `spirv-tools`, and
`vendor:sdl3` / `vendor:vulkan` / `vendor:stb`. Run from the project root (shaders are
read from `shaders/`). For runtime validation: `sudo pacman -S vulkan-validation-layers`.
