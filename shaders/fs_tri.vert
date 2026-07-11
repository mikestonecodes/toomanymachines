// Fullscreen triangle from 3 vertices — shared by every fullscreen pass
// (city backdrop, bloom, composite, loader, the bakes). Frags work off gl_FragCoord;
// the v_local/v_id outputs exist only to satisfy the shared fragment interface
// (bodyfx.glsl — a fragment input must be written by its vertex stage, VUID 08743).
// Zeros, never read.
layout(location = 0) out vec2      v_local;
layout(location = 1) out flat uint v_id;

void main() {
	v_local = vec2(0.0);
	v_id = 0u;
	gl_Position = vec4(float(gl_VertexIndex & 1) * 4.0 - 1.0, float(gl_VertexIndex >> 1) * 4.0 - 1.0, 0.0, 1.0);
}
