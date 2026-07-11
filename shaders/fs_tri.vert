// Fullscreen triangle from 3 vertices — shared by every fullscreen pass
// (city backdrop, bloom, composite). No varyings; frags work off gl_FragCoord.
void main() {
	gl_Position = vec4(float(gl_VertexIndex & 1) * 4.0 - 1.0, float(gl_VertexIndex >> 1) * 4.0 - 1.0, 0.0, 1.0);
}
