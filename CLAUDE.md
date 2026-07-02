# CLAUDE.md

- Complete the entire task without human intervention
- Do NOT ask questions — make your best judgment and keep moving
- Fix root causes, not symptoms
- Game is top-down
- **Zero tolerance on validation.** NEVER suppress, ignore, or "accept" a validation message — fix it. The debug callback (`vk.odin`) aborts on any Vulkan error or core/sync validation message. Every run: best-practices + synchronization2 + core checks. The build step (`tools/build.odin`) also runs a headless **GPU-Assisted validation pass** (`./toomanymachines gpuav`) before launching — runtime descriptor/OOB checks the CPU-side layers can't see. Nothing is ever suppressed; to silence a message you MUST add it to the callback `switch` with a written reason.
- Tiny top-down city-defense shooter on a hand-written modern-Vulkan renderer — keep it small and dumb. WASD drives the truck (bicycle-model car physics), mouse aims the turret, LMB fires, R restarts. Enemies (spider/skitter/brute bots, 60/30/10 mix) stream in endlessly from OUTSIDE the city border (GPU-driven; pressure only grows), march on hashed interior street crossings and occupy them; they aggro onto the truck inside AGGRO_D and kamikaze on contact. The truck can drive OUTSKIRTS px beyond the border to meet them.
- Look: 60/30/10 palette (PAL_* in common.glsl) — 60% near-black asphalt/plates, 30% warm grey metal, 10% hot red-orange (amber = the player's slice). Post chain ported from ../fishlab post.wgsl: HDR scene → soft-knee bright-pass + half-res gaussian bloom → ACES + sRGB encode + film grain + vignette.
- DO NOT EDIT the generated `shaders/gen.glsl` (structs + constants + bindless buffers + accessor macros + push block) — it comes from the `@glsl` blocks across the `.odin` files. Also don't touch `.wgpu-backup/` (the retired wgpu backend)
- Shaders are compiled by the **build step** (`tools/build.odin`), NOT the game — the game only reads `shaders/spv/*.spv`. Don't hand-run `glslc`/`spirv-*`; `./run.sh` runs the build step first.
- Error handling: `vkok(result, "what")` for Vulkan calls; `check(ok, err)` / `fmt.panicf` for setup

## Memory Rules
- Keep the per-frame path allocation-free (input → `game_update` → `vk_render`). No `make`/`append` in the loop.
- Init-time allocation is fine: buffers, swapchain `[dynamic]` arrays, bindless set.
- Transient init queries (device/layer enumeration, shader command strings) use `context.temp_allocator`; the loop `free_all`s it each frame.

## State Rules
- No monolithic state struct. Game state is small globals in `car.odin` (`car_pos`/`car_vel`/`car_angle`, `input`, `cam`/`cam_shake`, `muzzle`, `fire_timer`, `bullet_head`) plus the GPU body buffer (`buf_map[.Body]`) and city height grid (`buf_map[.City]`).
- The CPU only owns the truck, bullet spawns and the city layout; it writes them straight into the host-visible buffers and never reads them back. Enemy respawning/damage live entirely in physics.comp (game_init pre-seeds the first ring of attackers).
- The building collision test (cell rect inset by BLDG_INSET) exists twice on purpose: `collide_city` (car.odin) and `building_push` (physics.comp) — keep them mirrored.
- `game_init()` reseeds everything for a fresh start (the R key).

## GPU / Shader Rules
- Anything the shaders share with the game lives once in Odin, inside a `// @glsl … // @glsl-end` block in ANY `.odin` file (structs in render.odin, gameplay constants in car.odin, etc.). `tools/build.odin` scans every `.odin` for these blocks, copies them verbatim into `tools/gen`, and `tools/gen` reflects/evaluates them into GLSL — no hand-written type lists, no "MUST match". By reflection: a struct named `Push` → the push-constant block; any other struct → a GLSL `struct`, and if it's a buffer element type also a bindless `buffer` array (a raw `uintBuf` is always emitted for grid/index buffers); a constant → `const uint`/`const float` (the Odin compiler resolves value + type: `u32`→uint, `f32`→float). Vertex↔fragment **varyings are NOT generated** — they're purely shader-side, so each graphics pipeline declares its own `out`/`in` in its `.vert`/`.frag`. Add a shared type/constant = add it to an `@glsl` block (self-contained, builtins only, one decl per line). Scalar layout — Odin default alignment matches GLSL `scalar`; never add `_pad`.
- Broad-phase is the bucket grid: scan the 3×3 neighbour cells, don't loop all bodies.
- In `physics.comp` every body only writes ITSELF — no cross-body writes, so no races (only the grid scatter uses atomics).
- New device feature needed? Add it to the `feat12`/`feat13`/`feat2` chain in `vk_init`. The validation layers name the exact capability/feature a shader requires.
- Shader validity is enforced in `tools/build.odin`: `glslc -Werror` → `spirv-val`, then the runtime validation layers.

## Buffer / Pipeline Interface
- Data-driven. Add a buffer = one `BUF_SPECS` row in render.odin (`{glsl-macro, element-type, size, host-visible}`) and NOTHING else: it's auto-created, its bindless slot is its row order (asserted at registration), and `tools/gen` emits the storage-buffer view + a `<glsl-macro>` accessor into `gen.glsl` (e.g. `#define BODIES bodyBuf[0].v`) so shaders just write `BODIES`. Rows MUST be in `Res` enum order.
- Add a pipeline = one `PIPE_SPECS` row + shader files (`hdr` picks the offscreen HDR format vs the swapchain). Every pipeline shares the one bindless descriptor set + push-constant layout — no per-pipeline descriptors.
- Offscreen images: one `IMG_SPECS` row per HDR target (Scene/BloomA/BloomB) — created with the swapchain, registered at binding 1 (slot = row order = the `IMG_*` constants). Sample via `layout(set=0, binding=1) uniform sampler2D TEXS[];` declared ONLY in the frags that read it (binding 1 is FRAGMENT-stage only — declaring it in a compute shader breaks pipeline layout compatibility).

## Code Style
- Only break out a function if used 2+ times — inline single-use functions
- Write concrete code first, extract shared parts only after 2+ instances
- Never create abstractions preemptively
- Each unique concept exists once, unique code stays inline

## Build / Test
- `./run.sh` is a thin wrapper over `tools/build.odin` (the whole pipeline: regen `gen.glsl` from the Odin structs → compile `shaders/spv/` → `odin build` the game → GPU-AV pass → run, Vulkan validation ON). The game is a pure `.spv` consumer: it loads `shaders/spv/*.spv` (the paths listed in `PIPE_SPECS`) and reloads pipelines whenever those files change (mtime poll). Producing the `.spv` is the watcher's job — `./run.sh watch` runs `tools/odin-watch`, which recompiles GLSL → SPIR-V + **naga** on `.glsl`/`.comp` saves and rebuilds the binary on `.odin` saves; the running game reloads the new `.spv` itself. Editing any `@glsl` block regenerates `gen.glsl` on the next `./run.sh` (or automatically on a `.odin` save under `./run.sh watch`).
- `./run.sh shot` drives the game headless and writes `.debug_screenshots/vk.jpg` — use it to verify rendering actually looks right (validation-clean ≠ visible). Edit the drive sweep in `main.odin` (gated by the `shot` arg); trigger a capture with `vk_request_shot(path)`.
- Shaders are read from `shaders/` at runtime — always run from the project root.
