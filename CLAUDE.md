# CLAUDE.md

- Complete the entire task without human intervention
- Do NOT ask questions — make your best judgment and keep moving
- Fix root causes, not symptoms
- Game is top-down
- **Zero tolerance on validation.** NEVER suppress, ignore, or "accept" a validation message — fix it. The debug callback (`vk.odin`) aborts on any Vulkan error or core/sync validation message. Every run: best-practices + synchronization2 + core checks. The build step (`tools/build.odin`) also runs a headless **GPU-Assisted validation pass** (`./toomanymachines gpuav`) before launching — runtime descriptor/OOB checks the CPU-side layers can't see. Nothing is ever suppressed; to silence a message you MUST add it to the callback `switch` with a written reason.
- Tiny top-down shooter on a hand-written modern-Vulkan renderer — keep it small and dumb
- DO NOT EDIT the generated shader includes `shaders/gen.glsl` (structs + bindless buffers + push block) or `shaders/CircleIO.glsl` (varyings) — both come from render.odin's `@glsl` block. Also don't touch `.wgpu-backup/` (the retired wgpu backend)
- Shaders are compiled by the **build step** (`tools/build.odin`), NOT the game — the game only reads `shaders/spv/*.spv`. Don't hand-run `glslc`/`spirv-*`; `./run.sh` runs the build step first.
- Error handling: `vkok(result, "what")` for Vulkan calls; `check(ok, err)` / `fmt.panicf` for setup

## Memory Rules
- Keep the per-frame path allocation-free (input → `game_update` → `vk_render`). No `make`/`append` in the loop.
- Init-time allocation is fine: buffers, swapchain `[dynamic]` arrays, bindless set.
- Transient init queries (device/layer enumeration, shader command strings) use `context.temp_allocator`; the loop `free_all`s it each frame.

## State Rules
- No monolithic state struct. Game state is small globals in `car.odin` (`player_pos`, `input`, `fire_timer`, `bullet_head`) plus the GPU body buffer (`buf_map[.Body]`).
- The CPU only owns the player + bullet spawns; it writes them straight into the host-visible body buffer and never reads the buffer back.
- `game_init()` reseeds everything for a fresh start (the R key).

## GPU / Shader Rules
- GPU structs live once in render.odin's `@glsl` block (real package-main types the game uses). `tools/build.odin` copies that block verbatim into `tools/gen` (+ a generated `GLSL_TYPES` typeid enumeration), and `tools/gen` reflects each type into GLSL — no hand-written type lists. Categorisation is by reflection: named `Push` → the push-constant block; all fields `v_`-prefixed → a `shaders/<Name>.glsl` varying include (integer fields get `flat`; stage files `#define VARYING out|in` then `#include` it); every other struct → a GLSL `struct` + a bindless `buffer` array (a raw `uintBuf` is always emitted too, for the grid/index buffers). Add a GPU type = add a struct to the block (self-contained, builtins only, one per line). Scalar layout — Odin default alignment matches GLSL `scalar`; never add `_pad` fields.
- Gameplay/grid constants are duplicated in `car.odin`/`render.odin` and `shaders/common.glsl` — keep the "MUST match" comments honest.
- Broad-phase is the bucket grid: scan the 3×3 neighbour cells, don't loop all bodies.
- In `physics.comp` every body only writes ITSELF — no cross-body writes, so no races (only the grid scatter uses atomics).
- New device feature needed? Add it to the `feat12`/`feat13`/`feat2` chain in `vk_init`. The validation layers name the exact capability/feature a shader requires.
- Shader validity is enforced in `tools/build.odin`: `glslc -Werror` → `spirv-val`, then the runtime validation layers.

## Buffer / Pipeline Interface
- Data-driven, like the old render.odin. Add a buffer = one `BUF_SPECS` row; it's auto-created and gets a bindless slot in `buf_index`, which you hand to shaders via push constants.
- Add a pipeline = one `PIPE_SPECS` row + shader files. Every pipeline shares the one bindless descriptor set + push-constant layout — no per-pipeline descriptors.

## Code Style
- Only break out a function if used 2+ times — inline single-use functions
- Write concrete code first, extract shared parts only after 2+ instances
- Never create abstractions preemptively
- Each unique concept exists once, unique code stays inline

## Build / Test
- `./run.sh` is a thin wrapper over `tools/build.odin` (the whole pipeline: regen `gen.glsl` from the Odin structs → compile `shaders/spv/` → `odin build` the game → GPU-AV pass → run, Vulkan validation ON). The game is a pure `.spv` consumer: it loads `shaders/spv/*.spv` (the paths listed in `PIPE_SPECS`) and reloads pipelines whenever those files change (mtime poll). Producing the `.spv` is the watcher's job — `./run.sh watch` runs `tools/odin-watch`, which recompiles GLSL → SPIR-V + **naga** on `.glsl`/`.comp` saves and rebuilds the binary on `.odin` saves; the running game reloads the new `.spv` itself. A GPU-type change in render.odin's `@glsl` block needs a full `./run.sh` to regenerate `gen.glsl`.
- `./run.sh shot` drives the game headless and writes `.debug_screenshots/vk.jpg` — use it to verify rendering actually looks right (validation-clean ≠ visible). Edit the drive sweep in `main.odin` (gated by the `shot` arg); trigger a capture with `vk_request_shot(path)`.
- Shaders are read from `shaders/` at runtime — always run from the project root.
