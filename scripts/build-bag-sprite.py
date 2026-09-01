#!/usr/bin/env python3
"""Rebuild assets/anim/bag-fill.{webp,json}. See build-bag-sprite.js for the why."""
import json, sys
from PIL import Image

# The source is NOT in the repo: it is 4.2 MB and this project has no
# assetBundlePatterns, so anything under the project root ships inside the app.
# It lives on Stephen's Desktop; this hash is what identifies it.
SRC_SHA256 = "8670a737aa80fc049588c3e468c0ed45e03d2ca204356a746eeb273bf1e8c097"
SRC = sys.argv[1] if len(sys.argv) > 1 else "/mnt/c/Users/Steve/OneDrive/Desktop/6y9HsPBq.png"
SRC_COLS, SRC_ROWS = 5, 8
# EVERY FRAME, IN SHEET ORDER. Stephen's instruction, 2026-09-01: "use every
# frame in the spritesheet I gave you... Just go in the same order as the sprite
# sheet. Don't try to reorder the frames yourself."
#
# Earlier builds curated a subsequence because the raw order is not monotonic --
# the bag fills, empties and refills. That was my call and it is reversed. The
# sheet is the artwork and its order is the artwork's order.
PICKS = list(range(40))
OUT_COLS, FRAME_H = 8, 320

import hashlib
actual = hashlib.sha256(open(SRC, "rb").read()).hexdigest()
if actual != SRC_SHA256:
    print(f"warning: {SRC} is not the sheet this was tuned for\n  expected {SRC_SHA256}\n  got      {actual}\n  PICKS below indexes THAT sheet's frames; check the output strip.")

im = Image.open(SRC).convert("RGBA")
fw, fh = im.size[0] // SRC_COLS, im.size[1] // SRC_ROWS
frames = []
for i in PICKS:
    r, c = divmod(i, SRC_COLS)
    frames.append(im.crop((c * fw, r * fh, (c + 1) * fw, (r + 1) * fh)))

# ONE crop box shared by every frame. Cropping each to its own content would
# re-centre the bag frame by frame and make it jitter as it fills.
box = None
for f in frames:
    b = f.getchannel("A").point(lambda p: 255 if p > 16 else 0).getbbox()
    if b:
        box = b if box is None else (min(box[0], b[0]), min(box[1], b[1]),
                                     max(box[2], b[2]), max(box[3], b[3]))

cw, ch = box[2] - box[0], box[3] - box[1]
FRAME_W = max(2, int(round(cw * FRAME_H / ch)))
FRAME_W += FRAME_W % 2

cropped = [f.crop(box).resize((FRAME_W, FRAME_H), Image.LANCZOS) for f in frames]
rows = (len(cropped) + OUT_COLS - 1) // OUT_COLS
sheet = Image.new("RGBA", (FRAME_W * OUT_COLS, FRAME_H * rows), (0, 0, 0, 0))
for n, f in enumerate(cropped):
    sheet.alpha_composite(f, ((n % OUT_COLS) * FRAME_W, (n // OUT_COLS) * FRAME_H))
sheet.save("assets/anim/bag-fill.webp", "WEBP", quality=90, method=6, exact=True)

json.dump({"frames": len(cropped), "cols": OUT_COLS, "rows": rows,
           "frameWidth": FRAME_W, "frameHeight": FRAME_H,
           "sheetWidth": FRAME_W * OUT_COLS, "sheetHeight": FRAME_H * rows},
          open("assets/anim/bag-fill.json", "w"), indent=2)
print(f"{len(cropped)} frames, {FRAME_W}x{FRAME_H}, {OUT_COLS}x{rows}")
