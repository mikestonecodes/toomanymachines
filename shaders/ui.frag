// The immediate-mode UI over the composite (post-tonemap, premultiplied): rounded
// panels/buttons/outlines and the 5x7 PROCEDURAL FONT — glyph bits come from the FONT
// buffer (ui_font_upload packs the ASCII art in ui.odin; 35 bits = 2 u32 per glyph).
// No sprite sheet, no atlas, nothing baked.

void main() {
	Ui e = UIEL[v_id];
	float a;
	if (e.kind == 1u) { // glyph: decode the 5x7 bitmap, hard pixels (machine readout)
		ivec2 cell = ivec2(clamp(floor(v_local / e.size * vec2(5.0, 7.0)), vec2(0.0), vec2(4.0, 6.0)));
		uint bitn = uint(cell.y) * 5u + uint(cell.x);
		a = float((FONT[e.v0 * 2u + bitn / 32u] >> (bitn & 31u)) & 1u);
	} else { // rounded rect: kind 0 = fill, kind 2 = outline of v1 px
		vec2 halfs = e.size * 0.5;
		float r = float(e.v0);
		float d = sd_box(v_local - halfs, halfs - r) - r;
		a = 1.0 - smoothstep(-1.0, 0.5, d);
		if (e.kind == 2u) { a *= smoothstep(-float(e.v1) - 1.0, -float(e.v1), d); }
	}
	a *= e.color.a;
	o_color = vec4(e.color.rgb * a, a);
}
