# Generates the built-in Reva pet sprite sheet (Codex-pet compatible: 8 columns x 11 rows, 192x208 cells).
import math, sys
from PIL import Image, ImageDraw, ImageFilter, ImageChops
S = 4; CW, CH = 192, 208
OUT = sys.argv[1] if len(sys.argv) > 1 else 'src/renderer/assets/pets/reva/spritesheet.png'

def grad(w, h, top, bot):
    g = Image.new("RGBA", (w, h)); px = g.load()
    for y in range(h):
        t = y / (h - 1)
        c = tuple(int(top[i] + (bot[i] - top[i]) * t) for i in range(4))
        for x in range(w): px[x, y] = c
    return g

BODY_TOP, BODY_BOT = (196, 160, 255, 255), (112, 62, 220, 255)
OUTLINE = (52, 28, 104, 255); DARK = (34, 18, 70, 255); WHITE = (255, 255, 255, 255); PINK = (255, 150, 200, 150)
GEM = (130, 235, 255, 255); GEM2 = (70, 170, 235, 255)

class T:  # transform around the feet pivot: scale, rotate (deg), translate (cell px)
    def __init__(s, dx=0, dy=0, sx=1, sy=1, rot=0):
        s.dx, s.dy, s.sx, s.sy, s.rot = dx, dy, sx, sy, math.radians(rot)
        s.px, s.py = 96, 178
    def __call__(s, x, y):
        x, y = (x - s.px) * s.sx, (y - s.py) * s.sy
        c, n = math.cos(s.rot), math.sin(s.rot)
        x, y = x * c - y * n, x * n + y * c
        return ((x + s.px + s.dx) * S, (y + s.py + s.dy) * S)

def ell(d, t, cx, cy, rx, ry, fill=None, outline=None, w=0):
    pts = [t(cx + rx * math.cos(a / 40 * math.pi), cy + ry * math.sin(a / 40 * math.pi)) for a in range(80)]
    d.polygon(pts, fill=fill, outline=outline)
    if outline and w:
        d.line(pts + [pts[0]], fill=outline, width=w * S, joint="curve")

def poly(d, t, pts, fill=None, outline=None, w=0):
    p = [t(*q) for q in pts]; d.polygon(p, fill=fill)
    if outline: d.line(p + [p[0]], fill=outline, width=w * S, joint="curve")

def cell(t=None, eyes="open", look=(0, 0), mouth="smile", arm=None, feet=None, extra=None, blink=False, flip=False):
    t = t or T()
    img = Image.new("RGBA", (CW * S, CH * S), (0, 0, 0, 0))
    # soft ground shadow
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0)); sd = ImageDraw.Draw(sh)
    k = max(0.55, min(1.15, 1 - (-t.dy) / 90))
    sd.ellipse([(96 - 46 * k + t.dx) * S, 178 * S, (96 + 46 * k + t.dx) * S, 190 * S], fill=(20, 8, 40, 70))
    img.alpha_composite(sh.filter(ImageFilter.GaussianBlur(3 * S)))
    d = ImageDraw.Draw(img)
    # feet
    f = feet or (0, 0)
    for side, off in ((-1, f[0]), (1, f[1])):
        ell(d, t, 96 + side * 24 + off * 6, 176 - max(0, -off) * 7, 15, 9, fill=(92, 50, 190, 255), outline=OUTLINE, w=2)
    # antenna gem
    stem = [(94, 80), (98, 80), (99, 66), (93, 66)]
    poly(d, t, stem, fill=OUTLINE)
    gm = [(96, 40), (108, 54), (96, 70), (84, 54)]
    poly(d, t, gm, fill=GEM, outline=OUTLINE, w=2)
    poly(d, t, [(96, 40), (108, 54), (96, 54)], fill=(190, 250, 255, 255))
    poly(d, t, [(96, 54), (84, 54), (96, 70)], fill=GEM2)
    # arms (behind body when down)
    def draw_arm(side, ang):
        sx0, sy0 = 96 + side * 48, 134
        L = 26; a = math.radians(ang)
        ex, ey = sx0 + side * L * math.cos(a), sy0 - L * math.sin(a)
        p = [t(sx0, sy0), t(ex, ey)]
        d.line(p, fill=OUTLINE, width=15 * S, joint="curve"); d.line(p, fill=(140, 90, 235, 255), width=10 * S, joint="curve")
        e = t(ex, ey); r = 7.5 * S; d.ellipse([e[0] - r, e[1] - r, e[0] + r, e[1] + r], fill=(160, 110, 245, 255), outline=OUTLINE, width=2 * S)
    left_ang, right_ang = -35, -35
    if arm: left_ang, right_ang = arm.get("l", -35), arm.get("r", -35)
    draw_arm(-1, left_ang)
    draw_arm(1, right_ang)
    # body (gradient clipped to the blob)
    mask = Image.new("L", img.size, 0); md = ImageDraw.Draw(mask)
    ell(md, t, 96, 128, 54, 50, fill=255)
    body = grad(img.size[0], img.size[1], BODY_TOP, BODY_BOT); body.putalpha(mask)
    ol = Image.new("RGBA", img.size, (0, 0, 0, 0)); od = ImageDraw.Draw(ol)
    ell(od, t, 96, 128, 54, 50, fill=OUTLINE)
    ol_mask = ol.split()[3].filter(ImageFilter.MaxFilter(2 * S + 1))
    outline_layer = Image.new("RGBA", img.size, OUTLINE); outline_layer.putalpha(ol_mask)
    img.alpha_composite(outline_layer); img.alpha_composite(body)
    d = ImageDraw.Draw(img)
    # highlight
    hl = Image.new("RGBA", img.size, (0, 0, 0, 0)); hd = ImageDraw.Draw(hl)
    ell(hd, t, 72, 100, 15, 9, fill=(255, 255, 255, 120))
    img.alpha_composite(hl.filter(ImageFilter.GaussianBlur(S)))
    d = ImageDraw.Draw(img)
    # cheeks
    for sx in (-1, 1): ell(d, t, 96 + sx * 38, 138, 8, 5, fill=PINK)
    # eyes
    lx, ly = look
    for sx in (-1, 1):
        cx, cy = 96 + sx * 20 + lx * 3, 124 + ly * 2.5
        if eyes == "open":
            ell(d, t, cx, cy, 8.5, 12 if not blink else 1.6, fill=DARK)
            if not blink:
                ell(d, t, cx + 2.5 + lx, cy - 4 + ly, 3, 3.5, fill=WHITE)
        elif eyes == "closed":
            d.arc([t(cx - 9, cy - 4)[0], t(cx - 9, cy - 4)[1], t(cx + 9, cy + 8)[0], t(cx + 9, cy + 8)[1]], 200, 340, fill=DARK, width=3 * S)
        elif eyes == "happy":
            d.arc([t(cx - 9, cy - 2)[0], t(cx - 9, cy - 2)[1], t(cx + 9, cy + 12)[0], t(cx + 9, cy + 12)[1]], 200, 340, fill=DARK, width=3 * S)
        elif eyes == "x":
            for a, b in (((-6, -6), (6, 6)), ((-6, 6), (6, -6))):
                d.line([t(cx + a[0], cy + a[1]), t(cx + b[0], cy + b[1])], fill=DARK, width=3 * S)
        elif eyes == "narrow":
            ell(d, t, cx, cy + 2, 9, 5, fill=DARK); ell(d, t, cx + 2.5 + lx, cy + 1, 2.5, 2.2, fill=WHITE)
    # mouth
    mx, my = 96 + lx * 2, 144
    if mouth == "smile": d.arc([t(mx - 9, my - 7)[0], t(mx - 9, my - 7)[1], t(mx + 9, my + 7)[0], t(mx + 9, my + 7)[1]], 20, 160, fill=DARK, width=3 * S)
    elif mouth == "o": ell(d, t, mx, my + 2, 4.5, 5.5, fill=DARK)
    elif mouth == "flat": d.line([t(mx - 6, my + 2), t(mx + 6, my + 2)], fill=DARK, width=3 * S)
    elif mouth == "sad": d.arc([t(mx - 8, my + 1)[0], t(mx - 8, my + 1)[1], t(mx + 8, my + 15)[0], t(mx + 8, my + 15)[1]], 200, 340, fill=DARK, width=3 * S)
    elif mouth == "grin":
        poly(d, t, [(mx - 9, my - 1), (mx + 9, my - 1), (mx + 6, my + 8), (mx - 6, my + 8)], fill=DARK)
    # extras
    if extra == "sweat": poly(d, t, [(150, 96), (155, 108), (150, 114), (145, 108)], fill=(150, 220, 255, 255), outline=OUTLINE, w=1)
    if extra == "dots":
        for i in range(3): ell(d, T(), 140 + i * 11, 70, 3.5, 3.5, fill=(235, 220, 255, 255))
    if extra == "glass":
        gx, gy = 150, 122
        d.line([(gx * S, gy * S), ((gx + 14) * S, (gy + 18) * S)], fill=OUTLINE, width=5 * S)
        r = 13 * S; d.ellipse([(gx - 13) * S - r + r, (gy - 13) * S, (gx + 13) * S, (gy + 13) * S], outline=OUTLINE, width=4 * S, fill=(200, 235, 255, 90))
    if extra == "lines":
        for i, (a, b) in enumerate(((40, 100), (30, 124), (40, 148))): d.line([(a * S, b * S), ((a - 22) * S, b * S)], fill=(235, 220, 255, 200), width=3 * S)
    if extra == "spark":
        for (x, y, r) in ((40, 66, 6), (154, 60, 5), (166, 100, 4)): poly(d, T(), [(x, y - r * 1.6), (x + r * .5, y - r * .5), (x + r * 1.6, y), (x + r * .5, y + r * .5), (x, y + r * 1.6), (x - r * .5, y + r * .5), (x - r * 1.6, y), (x - r * .5, y - r * .5)], fill=(255, 245, 190, 255))
    if extra == "q":
        d.text((142 * S, 40 * S), "?", fill=(235, 220, 255, 255), font=None)
    out = img.resize((CW, CH), Image.LANCZOS)
    return ImageOps_mirror(out) if flip else out

def ImageOps_mirror(im):
    return im.transpose(Image.FLIP_LEFT_RIGHT)

sheet = Image.new("RGBA", (CW * 8, CH * 11), (0, 0, 0, 0))
def put(row, col, im): sheet.alpha_composite(im, (col * CW, row * CH))

# 0 idle (7)
for i in range(7):
    b = math.sin(i / 7 * 2 * math.pi)
    put(0, i, cell(T(dy=-1.2 * b, sy=1 + 0.012 * b, sx=1 - 0.008 * b), blink=(i == 4), mouth="smile"))
# 1 run right / 2 run left (8)
for i in range(8):
    ph = i / 8 * 2 * math.pi; bounce = abs(math.sin(ph)) * 7
    f = (math.sin(ph), -math.sin(ph))
    im = cell(T(dy=-bounce, rot=7, sy=1 + 0.02 * math.sin(ph * 2)), look=(1.6, 0), feet=f, mouth="grin", arm={"l": 20 + 25 * math.sin(ph), "r": -50 - 25 * math.sin(ph)})
    put(1, i, im); put(2, i, im.transpose(Image.FLIP_LEFT_RIGHT))
# 3 waving (4)
for i in range(4):
    put(3, i, cell(T(dy=-1), eyes="happy", mouth="smile", arm={"r": 70 + 22 * math.sin(i / 4 * 2 * math.pi + 1), "l": -35}))
# 4 jumping (5)
J = [dict(dy=2, sy=.9, sx=1.07), dict(dy=-12, sy=1.07, sx=.95), dict(dy=-26, sy=1.1, sx=.93), dict(dy=-10, sy=1.04, sx=.97), dict(dy=3, sy=.88, sx=1.08)]
for i, p in enumerate(J):
    put(4, i, cell(T(**p), eyes="happy" if i in (1, 2, 3) else "open", mouth="o" if i == 2 else "smile", arm={"l": 60, "r": 60} if i in (1, 2) else None, feet=(0, 0) if i in (0, 4) else (-1, -1)))
# 5 failed (8)
for i in range(8):
    shake = math.sin(i / 8 * 4 * math.pi) * 3
    put(5, i, cell(T(dx=shake, dy=1, sy=.96, sx=1.03), eyes="x", mouth="sad", extra="sweat", arm={"l": -60, "r": -60}))
# 6 waiting (6)
LK = [(-1.6, 0), (-1.6, 0), (0, 0), (1.6, 0), (1.6, 0), (0, 0)]
for i in range(6):
    put(6, i, cell(T(dy=-0.6 * math.sin(i)), look=LK[i], mouth="flat", extra="dots" if i % 3 else None))
# 7 running / working (6)
for i in range(6):
    ph = i / 6 * 2 * math.pi
    put(7, i, cell(T(dy=-abs(math.sin(ph)) * 5, rot=2 * math.sin(ph)), look=(0, 1), mouth="grin", feet=(math.sin(ph), -math.sin(ph)), arm={"l": 10 + 55 * math.sin(ph), "r": 10 - 55 * math.sin(ph)}, extra="lines"))
# 8 review (6)
for i in range(6):
    put(8, i, cell(T(dy=-0.8 * math.sin(i), rot=-2), eyes="narrow", look=(1.2, 0.6), mouth="flat", arm={"r": 35 + 6 * math.sin(i), "l": -35}, extra="glass"))
# 9-10 look directions (16)
for i in range(16):
    a = i / 16 * 2 * math.pi
    lx, ly = math.sin(a) * 1.8, -math.cos(a) * 1.4
    put(9 + i // 8, i % 8, cell(T(rot=lx * 1.3), look=(lx, ly), mouth="smile"))
sheet.save(OUT)
print("ok", sheet.size)