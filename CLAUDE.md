# CLAUDE.md

- Complete the entire task without human intervention
- Do NOT ask questions — make your best judgment and keep moving
- Fix root causes, not symptoms
- Game is top-down
- Tiny top-down shooter on a hand-written modern-Vulkan renderer — keep it small and dumb
- DO NOT EDIT `shaders/gen.glsl` (generated from the Odin structs) or `.wgpu-backup/` (the retired wgpu backend)
- Shaders compile at runtime via `glslc` — do NOT hand-run `glslc`/`spirv-*`; `load_shader_module` does the whole chain
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
- GPU structs (`Body`, `Push`) live once in `pipelines.odin` and are injected into GLSL via `shaders/gen.glsl` (register in `GLSL_STRUCTS`). Use scalar layout — Odin default alignment matches GLSL `scalar`; never add `_pad` fields.
- Gameplay/grid constants are duplicated in `car.odin`/`pipelines.odin` and `shaders/common.glsl` — keep the "MUST match" comments honest.
- Broad-phase is the bucket grid: scan the 3×3 neighbour cells, don't loop all bodies.
- In `physics.comp` every body only writes ITSELF — no cross-body writes, so no races (only the grid scatter uses atomics).
- New device feature needed? Add it to the `feat12`/`feat13`/`feat2` chain in `vk_init`. The validation layers name the exact capability/feature a shader requires.
- Shader validity chain: `glslc -Werror` → `spirv-val` → `spirv-opt --validate-after-all`, then runtime validation layers. (naga cross-validate is intentionally dropped — it rejects glslc's `OpCopyLogical` from struct copies.)

## Buffer / Pipeline Interface
- Data-driven, like the old render.odin. Add a buffer = one `BUF_SPECS` row; it's auto-created and gets a bindless slot in `buf_index`, which you hand to shaders via push constants.
- Add a pipeline = one `PIPE_SPECS` row + shader files. Every pipeline shares the one bindless descriptor set + push-constant layout — no per-pipeline descriptors.

## Code Style
- Only break out a function if used 2+ times — inline single-use functions
- Write concrete code first, extract shared parts only after 2+ instances
- Never create abstractions preemptively
- Each unique concept exists once, unique code stays inline

## Build / Test
- `./run.sh` builds + runs with Vulkan validation ON. `.glsl` edits hot-reload in-app (mtime poll in `main`); `.odin` edits need a rebuild — `./run.sh watch` (the watcher rebuilds the binary on `.odin`, ignores `.glsl`).
- `./run.sh shot` drives the game headless and writes `.debug_screenshots/vk.jpg` — use it to verify rendering actually looks right (validation-clean ≠ visible). Edit the drive sweep in `main.odin` (gated by the `shot` arg); trigger a capture with `vk_request_shot(path)`.
- Shaders are read from `shaders/` at runtime — always run from the project root.
