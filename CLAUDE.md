# CLAUDE.md

- Complete the entire task without human intervention
- Do NOT ask questions — make your best judgment and keep moving
- Fix root causes, not symptoms
- Game is top-down
- **Zero tolerance on validation.** NEVER suppress, ignore, or "accept" a validation message — fix it. The debug callback (`vk.odin`) aborts on any Vulkan error or core/sync validation message. Every run: best-practices + synchronization2 + core checks. Nothing is ever suppressed; to silence a message you MUST add it to the callback `switch` with a written reason.
- Tiny top-down shooter on a hand-written modern-Vulkan renderer — keep it small and dumb
- DO NOT EDIT `shaders/gen.glsl` (generated from the Odin structs) or `.wgpu-backup/` (the retired wgpu backend)
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
- GPU structs (`Body`, `Push`) live once in `gpu/types.odin` (shared by the game and the build step). `tools/gen_glsl.odin` reflects `gpu.STRUCTS` into `shaders/gen.glsl`; register new ones there. Scalar layout — Odin default alignment matches GLSL `scalar`; never add `_pad` fields.
- Gameplay/grid constants are duplicated in `car.odin`/`pipelines.odin` and `shaders/common.glsl` — keep the "MUST match" comments honest.
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
- `./run.sh` is a thin wrapper over `tools/build.odin` (the whole pipeline: regen `gen.glsl` from the Odin structs → compile `shaders/spv/` → `odin build` the game → run, Vulkan validation ON). `.glsl` edits hot-reload in-app (mtime poll → re-run `tools/build.odin -- shaders` → reload pipelines); `.odin` edits need a rebuild — `./run.sh watch` (the watcher rebuilds the binary on `.odin`, ignores `.glsl`). A struct change in `gpu/types.odin` needs a full `./run.sh` to regenerate `gen.glsl`.
- `./run.sh shot` drives the game headless and writes `.debug_screenshots/vk.jpg` — use it to verify rendering actually looks right (validation-clean ≠ visible). Edit the drive sweep in `main.odin` (gated by the `shot` arg); trigger a capture with `vk_request_shot(path)`.
- Shaders are read from `shaders/` at runtime — always run from the project root.
