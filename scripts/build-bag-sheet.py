"""Build the bag-fill sprite sheet from ~/Desktop/Grocery_Bag_Color_Edit/*.png.

The source frames are not registered: the bag drifts and changes size by up to
4% across the eleven drawings, which reads as the bag breathing rather than
filling. Each frame is aligned on the red stripe (the one element every frame
draws identically relative to the bag) before it goes into the sheet.
"""
import json, sys
from collections import deque
import numpy as np
from PIL import Image

SRC = '/home/sgreer/Desktop/Grocery_Bag_Color_Edit'
N = 11
OUT_H = 700          # authored height: 3x the 232pt on-screen height
COLS, ROWS = 4, 3    # keeps the sheet under the 4096px texture limit


def stripe(arr):
    """bbox of the red band: (x0, x1, y0, y1). Ignores the apple and sparkles,
    which are red too but nowhere near 1000px wide."""
    r, g, b = arr[:, :, 0], arr[:, :, 1], arr[:, :, 2]
    red = (r > 120) & (g < 90) & (b < 90)
    rows = np.nonzero(red.sum(1) > 1000)[0]
    band = red[rows.min():rows.max() + 1]
    xs = np.nonzero(band.any(0))[0]
    return xs.min(), xs.max(), rows.min(), rows.max()


def load(i):
    im = Image.open(f'{SRC}/{i}.png')
    if im.mode == 'RGBA':                      # frame 11 ships a soft alpha
        flat = Image.new('RGB', im.size, (255, 255, 255))
        flat.paste(im, mask=im.getchannel('A'))
        im = flat
    return im.convert('RGB')


srcs = [load(i) for i in range(1, N + 1)]
marks = [stripe(np.array(s).astype(int)) for s in srcs]

# Reference: frames 2..7, the cluster six of the eleven already agree on.
ref = marks[1]
REF_W = ref[1] - ref[0]
REF_CX, REF_CY = (ref[0] + ref[1]) / 2, (ref[2] + ref[3]) / 2

# Register: uniform scale + translate, so every stripe lands on the reference.
reg = []
for im, m in zip(srcs, marks):
    s = REF_W / (m[1] - m[0])
    cx, cy = (m[0] + m[1]) / 2, (m[2] + m[3]) / 2
    W, H = im.size
    # affine wants the inverse map: dest -> source
    out = im.transform((W, H), Image.AFFINE,
                       (1 / s, 0, cx - REF_CX / s, 0, 1 / s, cy - REF_CY / s),
                       resample=Image.BICUBIC, fillcolor=(255, 255, 255))
    reg.append(out)

# Common crop: the union of every registered frame's ink, so nothing is clipped
# and the bag does not move inside the window.
x0, y0, x1, y1 = 10**9, 10**9, -1, -1
for im in reg:
    a = np.array(im).astype(int)
    ink = a.sum(2) < 700
    ink[:6], ink[-6:], ink[:, :6], ink[:, -6:] = False, False, False, False  # scan edge
    ys, xs = np.nonzero(ink)
    x0, y0 = min(x0, xs.min()), min(y0, ys.min())
    x1, y1 = max(x1, xs.max()), max(y1, ys.max())
pad = int((y1 - y0) * 0.03)
x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
x1, y1 = min(reg[0].width - 1, x1 + pad), min(reg[0].height - 1, y1 + pad)
cw, ch = x1 - x0 + 1, y1 - y0 + 1
FH = OUT_H
FW = int(round(cw * FH / ch))
print('crop', (x0, y0, x1, y1), '->', FW, 'x', FH)


def key_background(im):
    """White to alpha, but only the white the outside can reach — the bag body
    and the milk carton are near-white too and have to stay opaque."""
    a = np.array(im.convert('RGB')).astype(int)
    light = a.sum(2) > 735
    H, W = light.shape
    seen = np.zeros((H, W), bool)
    q = deque()
    for x in range(W):
        for y in (0, H - 1):
            if light[y, x] and not seen[y, x]:
                seen[y, x] = True; q.append((y, x))
    for y in range(H):
        for x in (0, W - 1):
            if light[y, x] and not seen[y, x]:
                seen[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for ny, nx in ((y-1, x), (y+1, x), (y, x-1), (y, x+1)):
            if 0 <= ny < H and 0 <= nx < W and light[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True; q.append((ny, nx))
    out = im.convert('RGBA')
    al = np.array(out.getchannel('A'))
    al[seen] = 0
    out.putalpha(Image.fromarray(al))
    return out


frames = [key_background(im.crop((x0, y0, x1 + 1, y1 + 1))
                          .resize((FW, FH), Image.LANCZOS)) for im in reg]

sheet = Image.new('RGBA', (FW * COLS, FH * ROWS), (0, 0, 0, 0))
for i, f in enumerate(frames):
    sheet.paste(f, ((i % COLS) * FW, (i // COLS) * FH))

dest = sys.argv[1] if len(sys.argv) > 1 else '.'
sheet.save(f'{dest}/bag-fill.webp', quality=92, method=6)
json.dump({'frames': N, 'cols': COLS, 'rows': ROWS,
           'frameWidth': FW, 'frameHeight': FH,
           'sheetWidth': FW * COLS, 'sheetHeight': FH * ROWS},
          open(f'{dest}/bag-fill.json', 'w'), indent=2)
print('wrote', dest)
