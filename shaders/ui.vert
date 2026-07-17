// One instanced quad per immediate-mode UI element (UIEL — ui.odin refills the buffer
// every frame). Elements live in SCREEN PIXELS; v_local = px within the element.

layout(location = 0) out vec2 v_local;
layout(location = 1) out flat uint v_id;

const vec2 UI_CORNERS[6] = vec2[6](
	vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(0.0, 1.0),
	vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(1.0, 1.0)
);

void main() {
	uint id = uint(gl_InstanceIndex);
	Ui e = UIEL[id];
	vec2 c = UI_CORNERS[gl_VertexIndex];
	gl_Position = vec4((e.pos + c * e.size) / pc.screen * 2.0 - 1.0, 0.0, 1.0);
	v_local = c * e.size;
	v_id = id;
}
