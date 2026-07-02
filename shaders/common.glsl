// Shared shader contract. Included by every shader via `#include "common.glsl"`
// (glslc resolves it with -I shaders). The GPU structs (Body, Push) are injected
// from the Odin definitions (render.odin @glsl block) → shaders/gen.glsl, below.
#ifndef COMMON_GLSL
#define COMMON_GLSL

#extension GL_EXT_nonuniform_qualifier : require
#extension GL_EXT_scalar_block_layout  : require

// Odin-generated (render.odin @glsl block): the Body/Push structs, the bindless storage-buffer
// arrays (bodyBuf[], uintBuf[]), and the push-constant block. Needs the scalar extension above.
#include "gen.glsl"

// Gameplay + layout constants — MUST match car.odin / pipelines.odin.
const uint  KIND_PLAYER = 0u, KIND_ENEMY = 1u, KIND_BULLET = 2u, KIND_DEAD = 3u;
const uint  MAX_ENEMIES = 150u, MAX_BULLETS = 128u;
const uint  ENEMY_LO = 1u, ENEMY_HI = ENEMY_LO + MAX_ENEMIES;
const uint  BULLET_LO = ENEMY_HI, BODY_COUNT = BULLET_LO + MAX_BULLETS;
const uint  GRID_SIZE = 32u, GRID_CELLS = GRID_SIZE * GRID_SIZE, CELL_CAP = 32u;
const float CAR_RADIUS = 18.0, ENEMY_SPEED = 100.0, ENEMY_R_MIN = 9.0, ENEMY_R_MAX = 20.0;

// The BODIES / GCOUNT / GITEM accessor macros are generated into gen.glsl from BUF_SPECS.

#endif
