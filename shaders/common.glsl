// Shared shader contract. Included by every shader via `#include "common.glsl"`
// (glslc resolves it with -I shaders). The GPU structs (Body, Push) are injected
// from the Odin definitions — Odin writes shaders/gen.glsl, included just below.
#ifndef COMMON_GLSL
#define COMMON_GLSL

#extension GL_EXT_nonuniform_qualifier : require
#extension GL_EXT_scalar_block_layout  : require

#include "gen.glsl" // Odin-generated: struct Body, struct Push

// Bindless: ONE descriptor binding, an array of storage buffers, aliased per
// element type. Index it with the buffer slots the CPU passes in push constants.
layout(set = 0, binding = 0, scalar) buffer BodyBuf { Body v[]; } bodyBuf[];
layout(set = 0, binding = 0, scalar) buffer UintBuf { uint v[]; } uintBuf[];

layout(push_constant, scalar) uniform PushBlock { Push pc; };

// Gameplay + layout constants — MUST match car.odin / pipelines.odin.
const uint  KIND_PLAYER = 0u, KIND_ENEMY = 1u, KIND_BULLET = 2u, KIND_DEAD = 3u;
const uint  MAX_ENEMIES = 150u, MAX_BULLETS = 128u;
const uint  ENEMY_LO = 1u, ENEMY_HI = ENEMY_LO + MAX_ENEMIES;
const uint  BULLET_LO = ENEMY_HI, BODY_COUNT = BULLET_LO + MAX_BULLETS;
const uint  GRID_SIZE = 32u, GRID_CELLS = GRID_SIZE * GRID_SIZE, CELL_CAP = 32u;
const float CAR_RADIUS = 18.0, ENEMY_SPEED = 100.0, ENEMY_R_MIN = 9.0, ENEMY_R_MAX = 20.0;

// Shorthands for the three buffers this game uses.
#define BODIES bodyBuf[pc.body_i].v
#define GCOUNT uintBuf[pc.gcount_i].v
#define GITEM  uintBuf[pc.gitem_i].v

#endif
