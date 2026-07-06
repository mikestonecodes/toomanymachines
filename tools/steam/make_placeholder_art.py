#!/usr/bin/env python3
# Generate PLACEHOLDER Steam capsule art from a gameplay screenshot, at the sizes Steam requires.
# These are functional stand-ins (real key art can replace them later) so the store/playtest page
# can be submitted. Sizes per Steamworks "Store Assets" spec.
#   python3 tools/steam/make_placeholder_art.py [source.jpg]
# Default source: .debug_screenshots/vk.jpg (produced by ./run.sh shot). Output: dist/steam/art/.
import sys, os
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

SRC  = sys.argv[1] if len(sys.argv) > 1 else ".debug_screenshots/vk.jpg"
OUT  = "dist/steam/art"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
TITLE = "TOO MANY\nMACHINES"
os.makedirs(OUT, exist_ok=True)
base = Image.open(SRC).convert("RGB")

def cover(box_w, box_h):
    # scale to cover the box, center-crop
    bw, bh = base.size
    s = max(box_w / bw, box_h / bh)
    im = base.resize((int(bw * s) + 1, int(bh * s) + 1), Image.LANCZOS)
    x = (im.width - box_w) // 2; y = (im.height - box_h) // 2
    return im.crop((x, y, x + box_w, y + box_h))

def titled(w, h, name, title=TITLE, tag=None, scale=0.16):
    im = cover(w, h)
    im = ImageEnhance.Brightness(im).enhance(0.62)   # darken for text legibility
    d = ImageDraw.Draw(im)
    fs = max(14, int(h * scale))
    f = ImageFont.truetype(FONT, fs)
    lines = title.split("\n")
    lh = fs * 1.05
    ty = h / 2 - (lh * len(lines)) / 2
    for ln in lines:
        tw = d.textlength(ln, font=f)
        tx = (w - tw) / 2
        d.text((tx + 2, ty + 2), ln, font=f, fill=(0, 0, 0))          # shadow
        d.text((tx, ty), ln, font=f, fill=(240, 236, 230))
        ty += lh
    if tag:
        ft = ImageFont.truetype(FONT, max(11, int(h * 0.06)))
        tw = d.textlength(tag, font=ft)
        d.text(((w - tw) / 2, ty + 6), tag, font=ft, fill=(230, 120, 60))
    im.save(f"{OUT}/{name}.png")
    print("  ", name, f"{w}x{h}")

# App store capsules
titled(460, 215, "header_capsule_460x215")
titled(231,  87, "small_capsule_231x87", scale=0.22)
titled(616, 353, "main_capsule_616x353")
titled(374, 448, "vertical_capsule_374x448")
titled(600, 900, "library_capsule_600x900", scale=0.10)
titled(1920, 620, "library_hero_1920x620", scale=0.13)
titled(1438, 810, "page_background_1438x810", scale=0.10)
# Playtest is a separate app — needs its own header
titled(460, 215, "playtest_header_460x215", tag="PLAYTEST")

# Library logo: transparent PNG, title text only (Steam overlays it on the hero)
logo = Image.new("RGBA", (1280, 720), (0, 0, 0, 0))
d = ImageDraw.Draw(logo)
f = ImageFont.truetype(FONT, 150)
lines = TITLE.split("\n"); lh = 160; ty = 360 - lh * len(lines) / 2
for ln in lines:
    tw = d.textlength(ln, font=f); tx = (1280 - tw) / 2
    d.text((tx + 4, ty + 4), ln, font=f, fill=(0, 0, 0, 180))
    d.text((tx, ty), ln, font=f, fill=(245, 242, 236, 255))
    ty += lh
logo.save(f"{OUT}/library_logo_1280x720.png"); print("   library_logo_1280x720 1280x720 (transparent)")

# The real screenshot, kept as a store screenshot
base.save(f"{OUT}/screenshot_01_1280x720.jpg", quality=92)
print("   screenshot_01_1280x720 (real gameplay)")
print("done ->", OUT)
