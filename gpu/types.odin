package gpu

import "core:reflect"

// GPU-facing structs — the single source of truth, shared by the game (which uses
// them as CPU-side types) and the shader build step (which injects them into GLSL).
// Scalar layout: Odin default alignment matches GLSL `scalar`.

Body :: struct { pos, vel: [2]f32, radius, life: f32, kind: u32 }
Push :: struct { screen, player: [2]f32, dt, time, cell_size: f32, mode, body_i, gcount_i, gitem_i: u32 }

GlslStruct :: struct { ti: ^reflect.Type_Info, name: string }

// Structs to emit into shaders/gen.glsl (see tools/gen_glsl.odin).
STRUCTS := [?]GlslStruct{
	{type_info_of(Body), "Body"},
	{type_info_of(Push), "Push"},
}
