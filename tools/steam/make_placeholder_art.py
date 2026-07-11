#!/usr/bin/env python3
# Generate PLACEHOLDER Steam capsule art from a gameplay screenshot, at the sizes Steam requires.
# These are functional stand-ins (real key art can replace them later) so the store/playtest page
# can be submitted. Sizes per Steamworks "Store Assets" spec.
#   python3 tools/steam/make_placeholder_art.py [source.jpg]
# Default source: .debug_screenshots/vk.jpg (produced by ./run.sh shot). Output: dist/steam/upload/
# — ONLY the files the Playtest (4933640) needs, named by their exact Steamworks slot. Nothing extra
# (Steam's drag-drop rejects files whose dimensions don't match a slot), so drop the whole folder in.
import sys, os, shutil
from PIL import Image, ImageDraw, ImageFont, ImageEnhance

SRC  = sys.argv[1] if len(sys.argv) > 1 else ".debug_screenshots/vk.jpg"
OUT  = "dist/steam/upload"
# A bold sans, wherever the distro keeps it (Debian and Arch differ). First existing wins.
FONT = next((p for p in (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
) if os.path.exists(p)), None)
if FONT is None: sys.exit("no bold sans font found — install ttf-dejavu or ttf-liberation")
TITLE = "TOO MANY\nMACHINES"
shutil.rmtree(OUT, ignore_errors=True); os.makedirs(OUT)  # clean folder — never leave stale/extra files
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
    if title is None and tag is None:                # plain artwork, no text (e.g. Library Hero — Steam forbids text/logos on it)
        im.save(f"{OUT}/{name}.png"); print("  ", name, f"{w}x{h}"); return
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

# Store assets (App Admin -> Graphical Assets -> Store assets). Current Steam spec sizes.
titled(920, 430, "store-header-capsule-920x430")   # logo only (game name) — no other text
titled(462, 174, "store-small-capsule-462x174", scale=0.22)
titled(1232, 706, "store-main-capsule-1232x706")
# Library assets (App Admin -> Graphical Assets -> Library assets).
titled(600, 900, "library-capsule-600x900", scale=0.10)
titled(920, 430, "library-header-920x430")
titled(3840, 1240, "library-hero-3840x1240", title=None)  # hero: artwork ONLY, no text/logo (the logo is a separate asset)

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
logo.save(f"{OUT}/library-logo-1280x720.png"); print("   library-logo-1280x720 (transparent)")

# The real screenshot, kept as a store screenshot
base.save(f"{OUT}/screenshot-1280x720.jpg", quality=92)
print("   screenshot-1280x720 (real gameplay)")

# App / shortcut icon: the game's red targeting reticle on near-black — reads at small sizes.
def icon(sz):
    im = Image.new("RGBA", (sz, sz), (14, 12, 12, 255))
    d = ImageDraw.Draw(im)
    c = sz / 2; red = (232, 72, 40, 255)
    lw = max(2, sz // 40)
    d.ellipse([sz*0.20, sz*0.20, sz*0.80, sz*0.80], outline=red, width=lw)      # outer ring
    d.ellipse([sz*0.40, sz*0.40, sz*0.60, sz*0.60], outline=red, width=lw)      # inner ring
    for a, b in [((c, sz*0.10), (c, sz*0.30)), ((c, sz*0.70), (c, sz*0.90)),    # ticks
                 ((sz*0.10, c), (sz*0.30, c)), ((sz*0.70, c), (sz*0.90, c))]:
        d.line([a, b], fill=red, width=lw)
    d.ellipse([c-lw, c-lw, c+lw, c+lw], fill=red)                                # center dot
    return im
ic = icon(512)
ic.resize((184, 184), Image.LANCZOS).save(f"{OUT}/app-icon-184x184.png")   # Community -> App Icon
ic.save(f"{OUT}/shortcut-icon.ico", sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
print("   app-icon-184x184 / shortcut-icon.ico")
print("done ->", OUT)
