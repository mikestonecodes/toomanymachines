package main

import "core:fmt"

// ── IMMEDIATE-MODE UI ─────────────────────────────────────────────────────────
// The whole interface is re-emitted from scratch every frame (fishlab's pattern):
// game_update calls ui_frame(), widgets push Ui instances straight into the mapped
// UIEL buffer and answer clicks in the same call — no retained widget state anywhere.
// ui.vert/ui.frag drain the buffer over the composite (post-tonemap screen space).
//
// TEXT is a 5x7 procedural font: the glyphs live below as ASCII ART, ui_font_upload
// packs them into the FONT buffer once (35 bits → 2 u32 per glyph) and the fragment
// shader decodes bits — no sprite sheet, no atlas bake, nothing to regenerate.

MAX_UI   :: 8192
FONT_CAP :: 128 // glyph slots in the FONT buffer (2 u32 each)

ui_count: int
ui_hover: bool // cursor is over a panel this frame — the game must not fire through it
ui_click: bool // LMB went DOWN this frame (edge, set by loop.odin, consumed by widgets)

ui_at :: proc(i: int) -> ^Ui { return (^Ui)(uintptr(buf_map[.Ui]) + uintptr(i * size_of(Ui))) }
font_at :: proc(i: int) -> ^u32 { return (^u32)(uintptr(buf_map[.Font]) + uintptr(i * 4)) }

// ── the font ── one string per glyph, 7 rows x 5 cols ('#' = pixel). Legible, editable,
// verified by eye right here in the source — this IS the font asset.
FONT_CHARS :: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -.:>+/!"
FONT_ART := [?]string{
	".###." + "#...#" + "#...#" + "#####" + "#...#" + "#...#" + "#...#", // A
	"####." + "#...#" + "#...#" + "####." + "#...#" + "#...#" + "####.", // B
	".###." + "#...#" + "#...." + "#...." + "#...." + "#...#" + ".###.", // C
	"####." + "#...#" + "#...#" + "#...#" + "#...#" + "#...#" + "####.", // D
	"#####" + "#...." + "#...." + "####." + "#...." + "#...." + "#####", // E
	"#####" + "#...." + "#...." + "####." + "#...." + "#...." + "#....", // F
	".###." + "#...#" + "#...." + "#.###" + "#...#" + "#...#" + ".####", // G
	"#...#" + "#...#" + "#...#" + "#####" + "#...#" + "#...#" + "#...#", // H
	".###." + "..#.." + "..#.." + "..#.." + "..#.." + "..#.." + ".###.", // I
	"..###" + "...#." + "...#." + "...#." + "...#." + "#..#." + ".##..", // J
	"#...#" + "#..#." + "#.#.." + "##..." + "#.#.." + "#..#." + "#...#", // K
	"#...." + "#...." + "#...." + "#...." + "#...." + "#...." + "#####", // L
	"#...#" + "##.##" + "#.#.#" + "#.#.#" + "#...#" + "#...#" + "#...#", // M
	"#...#" + "##..#" + "#.#.#" + "#..##" + "#...#" + "#...#" + "#...#", // N
	".###." + "#...#" + "#...#" + "#...#" + "#...#" + "#...#" + ".###.", // O
	"####." + "#...#" + "#...#" + "####." + "#...." + "#...." + "#....", // P
	".###." + "#...#" + "#...#" + "#...#" + "#.#.#" + "#..#." + ".##.#", // Q
	"####." + "#...#" + "#...#" + "####." + "#.#.." + "#..#." + "#...#", // R
	".####" + "#...." + "#...." + ".###." + "....#" + "....#" + "####.", // S
	"#####" + "..#.." + "..#.." + "..#.." + "..#.." + "..#.." + "..#..", // T
	"#...#" + "#...#" + "#...#" + "#...#" + "#...#" + "#...#" + ".###.", // U
	"#...#" + "#...#" + "#...#" + "#...#" + "#...#" + ".#.#." + "..#..", // V
	"#...#" + "#...#" + "#...#" + "#.#.#" + "#.#.#" + "##.##" + "#...#", // W
	"#...#" + "#...#" + ".#.#." + "..#.." + ".#.#." + "#...#" + "#...#", // X
	"#...#" + "#...#" + ".#.#." + "..#.." + "..#.." + "..#.." + "..#..", // Y
	"#####" + "....#" + "...#." + "..#.." + ".#..." + "#...." + "#####", // Z
	".###." + "#...#" + "#..##" + "#.#.#" + "##..#" + "#...#" + ".###.", // 0
	"..#.." + ".##.." + "..#.." + "..#.." + "..#.." + "..#.." + ".###.", // 1
	".###." + "#...#" + "....#" + "...#." + "..#.." + ".#..." + "#####", // 2
	".###." + "#...#" + "....#" + "..##." + "....#" + "#...#" + ".###.", // 3
	"...#." + "..##." + ".#.#." + "#..#." + "#####" + "...#." + "...#.", // 4
	"#####" + "#...." + "####." + "....#" + "....#" + "#...#" + ".###.", // 5
	"..##." + ".#..." + "#...." + "####." + "#...#" + "#...#" + ".###.", // 6
	"#####" + "....#" + "...#." + "..#.." + ".#..." + ".#..." + ".#...", // 7
	".###." + "#...#" + "#...#" + ".###." + "#...#" + "#...#" + ".###.", // 8
	".###." + "#...#" + "#...#" + ".####" + "....#" + "...#." + ".##..", // 9
	"....." + "....." + "....." + "....." + "....." + "....." + ".....", // space
	"....." + "....." + "....." + ".###." + "....." + "....." + ".....", // -
	"....." + "....." + "....." + "....." + "....." + ".##.." + ".##..", // .
	"....." + ".##.." + ".##.." + "....." + ".##.." + ".##.." + ".....", // :
	"#...." + ".#..." + "..#.." + "...#." + "..#.." + ".#..." + "#....", // >
	"....." + "..#.." + "..#.." + "#####" + "..#.." + "..#.." + ".....", // +
	"....#" + "...#." + "...#." + "..#.." + ".#..." + ".#..." + "#....", // /
	"..#.." + "..#.." + "..#.." + "..#.." + "..#.." + "....." + "..#..", // !
}
#assert(len(FONT_ART) == len(FONT_CHARS))

font_index: [128]u8 // byte → glyph slot (space for anything unmapped)

// Pack the ASCII art into the FONT buffer (called from game_init — buffers are mapped
// by then; a restart just rewrites the same bits).
ui_font_upload :: proc() {
	for i in 0 ..< 128 { font_index[i] = 36 } // default: space
	for c, g in FONT_CHARS {
		font_index[u8(c)] = u8(g)
		if c >= 'A' && c <= 'Z' { font_index[u8(c) + 32] = u8(g) } // lowercase folds up
		lo, hi: u32
		for px, i in FONT_ART[g] {
			if px != '#' { continue }
			if i < 32 { lo |= 1 << u32(i) } else { hi |= 1 << u32(i - 32) }
		}
		font_at(g * 2)^ = lo
		font_at(g * 2 + 1)^ = hi
	}
}

// ── emit primitives ───────────────────────────────────────────────────────────
ui_push :: proc(e: Ui) {
	if ui_count < MAX_UI { ui_at(ui_count)^ = e; ui_count += 1 }
}

ui_rect :: proc(x, y, w, h: f32, color: [4]f32, radius: f32 = 5) {
	ui_push({pos = {x, y}, size = {w, h}, color = color, v0 = u32(radius), kind = 0})
}

ui_outline :: proc(x, y, w, h: f32, color: [4]f32, radius: f32 = 5, thick: f32 = 2) {
	ui_push({pos = {x, y}, size = {w, h}, color = color, v0 = u32(radius), v1 = u32(thick), kind = 2})
}

// Monospace text at `s` px per font pixel (glyphs are 5x7, advance 6). Returns width.
ui_text :: proc(x, y, s: f32, color: [4]f32, str: string) -> f32 {
	cx := x
	for i in 0 ..< len(str) {
		if str[i] != ' ' {
			ui_push({pos = {cx, y}, size = {5 * s, 7 * s}, color = color, v0 = u32(font_index[str[i] & 127]), kind = 1})
		}
		cx += 6 * s
	}
	return cx - x
}
ui_text_w :: proc(str: string, s: f32) -> f32 { return f32(len(str)) * 6 * s }

// Static scratch for label formatting — the UI never heap-allocates (fishlab's ui_fmt).
@(private = "file") ui_buf: [128]u8
ui_fmt :: proc(format: string, args: ..any) -> string { return fmt.bprintf(ui_buf[:], format, ..args) }

ui_over :: proc(x, y, w, h: f32) -> bool {
	m := input.mouse
	return m.x >= x && m.x < x + w && m.y >= y && m.y < y + h
}

// ── widgets ───────────────────────────────────────────────────────────────────
UI_TEXT_C   :: [4]f32{0.78, 0.79, 0.74, 1.0}  // pale readout grey
UI_DIM_C    :: [4]f32{0.42, 0.43, 0.40, 1.0}
UI_GREEN_C  :: [4]f32{0.45, 1.00, 0.50, 1.0}  // your side
UI_EMBER_C  :: [4]f32{1.00, 0.58, 0.22, 1.0}  // scrap — the pit's color
UI_PANEL_C  :: [4]f32{0.020, 0.020, 0.026, 0.88}
UI_ROW_C    :: [4]f32{0.075, 0.077, 0.085, 0.90}
UI_HOT_C    :: [4]f32{0.125, 0.128, 0.135, 0.95}
UI_SEL_C    :: [4]f32{0.045, 0.140, 0.060, 0.95}

// One row-button: background (hover/selected states), left label, optional right label.
// Returns true on the LMB-down edge over it.
ui_button :: proc(x, y, w, h: f32, label: string, right: string, sel: bool, enabled := true) -> bool {
	hot := ui_over(x, y, w, h) && enabled
	bg := sel ? UI_SEL_C : hot ? UI_HOT_C : UI_ROW_C
	ui_rect(x, y, w, h, bg)
	if sel { ui_outline(x, y, w, h, {0.30, 0.85, 0.36, 0.9}) }
	tc := !enabled ? UI_DIM_C : sel ? UI_GREEN_C : UI_TEXT_C
	s := f32(2)
	ui_text(x + 10, y + (h - 7 * s) * 0.5, s, tc, label)
	if len(right) > 0 {
		ui_text(x + w - 10 - ui_text_w(right, s), y + (h - 7 * s) * 0.5, s, enabled ? UI_DIM_C : UI_DIM_C * {1, 1, 1, 0.6}, right)
	}
	return hot && ui_click
}

// ── the frame ─────────────────────────────────────────────────────────────────
// Called at the top of game_update: emits the HUD + the open factory's panels, answers
// this frame's click, and raises ui_hover so the weapons don't fire through the UI.
// A factory opens by PARKING on its pad or by CLICKING the pad on screen (game_update
// owns fab_open's lifetime; driving out of range closes it).
ui_frame :: proc() {
	ui_count = 0
	ui_hover = false

	// HUD: the scrap ledger + the fleet's income rate, always on (top-left)
	w := ui_text(14, 12, 2, UI_EMBER_C, ui_fmt("SCRAP %d", scrap_avail()))
	ui_text(14 + w + 12, 14, 1, UI_DIM_C, ui_fmt("+%d/M", int(scrap_rate * 60 / f32(FAB_EXCH))))

	if fab_open != 0 { fab_panel() }

	// click a factory PAD on screen → open its panels from afar (the panels above have
	// first claim on the click)
	if ui_click && !ui_hover {
		for pad in 1 ..= 2 {
			pp := CENTER + [2]f32{pad == 1 ? FAB_D : -FAB_D, 0}
			sp := (pp - cam) / ZOOM + [2]f32{f32(win_w), f32(win_h)} * 0.5
			d := input.mouse - sp
			if d.x * d.x + d.y * d.y < (FAB_R / ZOOM) * (FAB_R / ZOOM) {
				fab_open = fab_open == pad ? 0 : pad // click again: closed
			}
		}
	}

	// over a panel the reticle sits under the UI (composite draws it first) — give the
	// cursor a visible pointer on top
	if ui_hover {
		ui_push({pos = input.mouse - {5, 7}, size = {10, 14}, color = UI_GREEN_C, v0 = u32(font_index['+']), kind = 1})
	}
}

MACH_NAMES := [7]string{"AUTO MIX", "TANK", "GUN-CAR", "GUNNER MECH", "KAMIKAZE", "BOMBER", "GUN DRONE"}
WEAP_NAMES := [5]string{"EMPTY", "CANNON", "GATLING", "LASER", "ARC FIELD"}

// The factory panels — MACHINE WORKS (fab_open 1) or WEAPONS LAB (fab_open 2). Works:
// click a machine to set the line AND open its LOADOUT panel alongside — there, click
// a hardpoint to cycle weapons under the chassis' weight budget. Lab: pick a weapon,
// buy its levels. The 1-6 / F keys still work while parked.
fab_panel :: proc() {
	mach := fab_open == 1
	nrows := mach ? 6 : 4
	rows := mach ? nrows + 1 : nrows // the works lists AUTO MIX on top
	W, RH, PAD := f32(264), f32(34), f32(10)
	H := 66 + f32(rows) * (RH + 6) + RH + 34
	X, Y := f32(20), (f32(win_h) - H) * 0.5
	if ui_over(X, Y, W, H) { ui_hover = true }
	ui_rect(X, Y, W, H, UI_PANEL_C, 8)
	ui_outline(X, Y, W, H, {0.16, 0.30, 0.18, 0.7}, 8)

	y := Y + PAD + 4
	ui_text(X + PAD, y, 2, UI_GREEN_C, mach ? "MACHINE WORKS" : "WEAPONS LAB")
	y += 20
	ui_text(X + PAD, y, 1, UI_DIM_C, mach ? "WHAT THE LINE BUILDS - CLICK TO FIT ITS GUNS" : "WEAPON RESEARCH - LEVELS ARM EVERY MOUNT")
	y += 18

	sel := mach ? fab_mach : fab_weap
	for i in (mach ? 0 : 1) ..= nrows {
		name := mach ? MACH_NAMES[i] : WEAP_NAMES[i]
		lvi := i == 0 ? 1 : mach ? mach_lv[i] : weap_lv[i]
		right := i == 0 ? "" : lvi == 0 ? "LOCKED" : ui_fmt("LV %d", lvi)
		if ui_button(X + PAD, y, W - PAD * 2, RH, name, right, sel == i) {
			if mach { fab_mach = i } else { fab_weap = i }
		}
		y += RH + 6
	}

	// the buy line: the founding UNLOCK while locked, levels after (F does the same)
	y += 4
	lv := sel > 0 ? (mach ? mach_lv[sel] : weap_lv[sel]) : 0
	label, right: string
	can := false
	switch {
	case sel == 0:        label = "SELECT A SLOT"
	case lv >= FAB_LVMAX: label = "MAX LEVEL"
	case:
		label = lv == 0 ? (mach ? "UNLOCK THE LINE" : "RESEARCH IT") : "UPGRADE"
		right = ui_fmt("%d SCRAP", fab_price(fab_open, sel))
		can = scrap_avail() >= fab_price(fab_open, sel)
	}
	if ui_button(X + PAD, y, W - PAD * 2, RH, label, right, false, can) && can {
		fab_buy(fab_open)
	}

	if mach && fab_mach > 0 && mach_lv[fab_mach] > 0 { load_panel(X + W + 8, Y) }
}

// The LOADOUT panel: the selected machine's hardpoints. Click a slot to cycle the
// weapon on it (only fits under the weight bar — heavier guns need a higher build
// level); the footer shows the resulting weight and the per-build price in scrap.
load_panel :: proc(X, Y: f32) {
	t := fab_mach
	W, RH, PAD := f32(252), f32(34), f32(10)
	ns := MACH_SLOTS[t]
	H := 66 + f32(max(ns, 1)) * (RH + 6) + 58
	if ui_over(X, Y, W, H) { ui_hover = true }
	ui_rect(X, Y, W, H, UI_PANEL_C, 8)
	ui_outline(X, Y, W, H, {0.16, 0.30, 0.18, 0.7}, 8)

	y := Y + PAD + 4
	ui_text(X + PAD, y, 2, UI_GREEN_C, ui_fmt("%s FIT", MACH_NAMES[t]))
	y += 20
	ui_text(X + PAD, y, 1, UI_DIM_C, ns > 0 ? "CLICK A HARDPOINT TO CYCLE ITS GUN" : "")
	y += 18

	if ns == 0 { // suicide drones / bombers: the machine IS the ordnance
		ui_text(X + PAD, y + 8, 2, UI_DIM_C, "NO HARDPOINTS")
		ui_text(X + PAD, y + 30, 1, UI_DIM_C, "THIS MACHINE IS THE PAYLOAD")
		return
	}
	for s in 0 ..< ns {
		if s >= mach_slots_unl[t] { // still-sealed hardpoints open strictly one by one
			buyable := s == mach_slots_unl[t]
			can := buyable && scrap_avail() >= slot_cost(s)
			right := buyable ? fmt.bprintf(ui_buf[64:], "%d", slot_cost(s)) : ""
			if ui_button(X + PAD, y, W - PAD * 2, RH, ui_fmt("%d: LOCKED", s + 1), right, false, can) && can {
				fab_buy_slot(t, s)
			}
		} else {
			wp := mach_load[t][s]
			right := wp > 0 ? fmt.bprintf(ui_buf[64:], "WT %d", WEAP_WT[wp]) : ""
			if ui_button(X + PAD, y, W - PAD * 2, RH, ui_fmt("%d: %s", s + 1, WEAP_NAMES[wp]), right, wp > 0) {
				fab_cycle_slot(t, s)
			}
		}
		y += RH + 6
	}

	// the weight bar: mounted load vs what this build level's frame carries
	y += 6
	used, cap := weight_used(t), weight_cap(t)
	full := used >= cap
	ui_text(X + PAD, y, 1, full ? UI_EMBER_C : UI_DIM_C, ui_fmt("WEIGHT %d/%d", used, cap))
	bw := W - PAD * 2
	ui_rect(X + PAD, y + 12, bw, 6, UI_ROW_C, 3)
	if used > 0 {
		ui_rect(X + PAD, y + 12, bw * f32(used) / f32(max(cap, 1)), 6, full ? [4]f32{1.0, 0.55, 0.2, 0.9} : [4]f32{0.30, 0.85, 0.36, 0.9}, 3)
	}
	ui_text(X + PAD, y + 26, 1, UI_EMBER_C, ui_fmt("BUILD COST %d SCRAP", build_cost(t)))
}
