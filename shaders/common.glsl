// Shared shader contract. Included by every shader via `#include "common.glsl"`
// (glslc resolves it with -I shaders). The GPU structs (Body, Push) are injected
// from the Odin definitions (render.odin @glsl block) → shaders/gen.glsl, below.
#ifndef COMMON_GLSL
#define COMMON_GLSL

#extension GL_EXT_nonuniform_qualifier : require
#extension GL_EXT_scalar_block_layout  : require

// Odin-generated (from the @glsl blocks + BUF_SPECS): the Body/Push structs, gameplay constants,
// the bindless storage-buffer arrays (bodyBuf[], uintBuf[]) + accessor macros, and the push block.
// Varyings are NOT here — a graphics pipeline declares its own in its .vert/.frag. Needs scalar ext.
#include "gen.glsl"

// Gameplay/layout constants (KIND_*, GRID_*, CAR_RADIUS, …) and the BODIES/GCOUNT/GITEM accessor
// macros are all generated into gen.glsl from the Odin @glsl blocks + BUF_SPECS.

#endif
