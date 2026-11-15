"""HypeConnect 제휴 제안서 빌드 스크립트.

내용은 slides/*.yaml (파일 이름 순서대로 한 장씩), 디자인은 이 파일이 담당한다.
내용만 고칠 때는 YAML만 수정하면 된다.

    python proposal/build.py            # proposal/dist/HypeConnect-제휴제안서.pptx 생성
"""
from pathlib import Path

import yaml
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Inches, Pt

ROOT = Path(__file__).parent
OUT = ROOT / "dist" / "HypeConnect-제휴제안서.pptx"

# 브랜드 토큰 (SPECIFICATION.md 6장)
ROSE = RGBColor(0xE1, 0x1D, 0x48)
ROSE_SOFT = RGBColor(0xFB, 0x71, 0x85)
TINT = RGBColor(0xFF, 0xF1, 0xF2)
INK = RGBColor(0x18, 0x18, 0x1B)
MUTED = RGBColor(0x71, 0x71, 0x7A)
BORDER = RGBColor(0xE4, 0xE4, 0xE7)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)
DARK_MUTED = RGBColor(0xA1, 0xA1, 0xAA)
FONT = "Malgun Gothic"

W, H = 13.333, 7.5
MX = 0.75          # 좌우 여백
TITLE_Y = 0.6
CONTENT_Y = 1.85


def nl(s):
    return str(s).replace("\\n", "\n")


def bg(slide, color):
    fill = slide.background.fill
    fill.solid()
    fill.fore_color.rgb = color


def box(slide, x, y, w, h, fill, shape=MSO_SHAPE.ROUNDED_RECTANGLE, line=None, radius=0.08):
    s = slide.shapes.add_shape(shape, Inches(x), Inches(y), Inches(w), Inches(h))
    s.fill.solid()
    s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
        s.line.width = Pt(1)
    s.shadow.inherit = False
    if shape == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = radius
    return s


def text(slide, x, y, w, h, value, size=16, bold=False, color=INK, align=PP_ALIGN.LEFT,
         anchor=MSO_ANCHOR.TOP, spacing=1.15, after=0):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.vertical_anchor = anchor
    for side in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
        setattr(tf, side, 0)
    for i, line in enumerate(nl(value).split("\n")):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        p.line_spacing = spacing
        p.space_after = Pt(after)
        r = p.add_run()
        r.text = line
        r.font.size = Pt(size)
        r.font.bold = bold
        r.font.color.rgb = color
        r.font.name = FONT
    return tb


def badge(slide, x, y, label, d=0.55, fill=ROSE, color=WHITE, size=16):
    c = box(slide, x, y, d, d, fill, shape=MSO_SHAPE.OVAL)
    tf = c.text_frame
    for side in ("margin_left", "margin_right", "margin_top", "margin_bottom"):
        setattr(tf, side, 0)
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    r.text = str(label)
    r.font.size = Pt(size)
    r.font.bold = True
    r.font.color.rgb = color
    r.font.name = FONT


def title(slide, value, color=INK):
    text(slide, MX, TITLE_Y, W - 2 * MX, 0.8, value, size=32, bold=True, color=color)


def page_no(slide, n, color=MUTED):
    text(slide, W - MX - 1, H - 0.5, 1, 0.3, f"{n:02d}", size=10, color=color, align=PP_ALIGN.RIGHT)
    text(slide, MX, H - 0.5, 4, 0.3, "HypeConnect", size=10, bold=True, color=color)


# ---------- 레이아웃 ----------

def cover(s, d, n):
    bg(s, INK)
    box(s, W - 4.6, -1.2, 6.0, 6.0, ROSE, shape=MSO_SHAPE.OVAL)
    box(s, W - 2.4, 4.4, 3.4, 3.4, ROSE_SOFT, shape=MSO_SHAPE.OVAL)
    text(s, MX, 1.6, 7.5, 0.4, d["kicker"], size=16, bold=True, color=ROSE_SOFT)
    text(s, MX, 2.2, 8.2, 2.2, d["title"], size=44, bold=True, color=WHITE, spacing=1.1)
    text(s, MX, 4.55, 7.5, 0.5, d["subtitle"], size=18, color=DARK_MUTED)
    text(s, MX, H - 0.9, 7, 0.3, d["footer"], size=12, color=DARK_MUTED)


def cards(s, d, n):
    title(s, d["title"])
    text(s, MX, 1.45, W - 2 * MX, 0.4, d["lead"], size=16, color=MUTED)
    k = len(d["cards"])
    gap = 0.4
    cw = (W - 2 * MX - gap * (k - 1)) / k
    for i, c in enumerate(d["cards"]):
        x = MX + i * (cw + gap)
        box(s, x, 2.4, cw, 3.9, TINT)
        badge(s, x + 0.4, 2.8, i + 1)
        text(s, x + 0.4, 3.65, cw - 0.8, 0.5, c["head"], size=22, bold=True)
        text(s, x + 0.4, 4.45, cw - 0.8, 1.7, c["body"], size=15, color=MUTED, spacing=1.3)


def statement(s, d, n):
    title(s, d["title"])
    box(s, MX, CONTENT_Y, W - 2 * MX, 1.6, INK)
    text(s, MX + 0.5, CONTENT_Y, W - 2 * MX - 1, 1.6, d["statement"], size=20, bold=True,
         color=WHITE, anchor=MSO_ANCHOR.MIDDLE, spacing=1.3)
    k = len(d["points"])
    gap = 0.4
    cw = (W - 2 * MX - gap * (k - 1)) / k
    for i, p in enumerate(d["points"]):
        x = MX + i * (cw + gap)
        box(s, x, 3.9, cw, 2.4, WHITE, line=BORDER)
        text(s, x + 0.4, 4.25, cw - 0.8, 0.5, p["head"], size=24, bold=True, color=ROSE)
        text(s, x + 0.4, 4.95, cw - 0.8, 1.2, p["body"], size=15, color=INK, spacing=1.3)


def flow(s, d, n):
    title(s, d["title"])
    k = len(d["steps"])
    gap = 0.3
    cw = (W - 2 * MX - gap * (k - 1)) / k
    y = 2.3
    for i, st in enumerate(d["steps"]):
        x = MX + i * (cw + gap)
        last = i == k - 1
        box(s, x, y, cw, 3.1, ROSE if last else TINT)
        text(s, x + 0.3, y + 0.35, cw - 0.6, 0.4, f"STEP {i + 1}", size=12, bold=True,
             color=WHITE if last else ROSE)
        text(s, x + 0.3, y + 0.85, cw - 0.6, 0.6, st["head"], size=22, bold=True,
             color=WHITE if last else INK)
        text(s, x + 0.3, y + 1.6, cw - 0.6, 1.3, st["body"], size=15,
             color=WHITE if last else MUTED, spacing=1.3)
        if not last:
            a = s.shapes.add_shape(MSO_SHAPE.ISOSCELES_TRIANGLE, Inches(x + cw + 0.06),
                                   Inches(y + 1.45), Inches(0.18), Inches(0.2))
            a.rotation = 90
            a.fill.solid()
            a.fill.fore_color.rgb = ROSE_SOFT
            a.line.fill.background()
    text(s, MX, 5.85, W - 2 * MX, 0.5, d["caption"], size=15, color=MUTED)


def stat(s, d, n):
    title(s, d["title"])
    lw = 4.6
    box(s, MX, CONTENT_Y, lw, 4.5, INK)
    text(s, MX + 0.5, CONTENT_Y + 0.7, lw - 1, 1.2, d["stat"], size=60, bold=True, color=WHITE)
    text(s, MX + 0.5, CONTENT_Y + 1.95, lw - 1, 0.8, d["stat_label"], size=16, color=DARK_MUTED, spacing=1.3)
    text(s, MX + 0.5, CONTENT_Y + 3.3, lw - 1, 0.8, d["example"], size=14, bold=True, color=ROSE_SOFT, spacing=1.3)
    rx = MX + lw + 0.5
    rw = W - MX - rx
    rows = d["points"]
    rh = 4.5 / len(rows)
    for i, p in enumerate(rows):
        y = CONTENT_Y + i * rh
        badge(s, rx, y + 0.12, "✓", d=0.45, fill=TINT, color=ROSE, size=14)
        text(s, rx + 0.7, y + 0.08, rw - 0.7, 0.45, p["head"], size=19, bold=True)
        text(s, rx + 0.7, y + 0.55, rw - 0.7, 0.5, p["body"], size=15, color=MUTED)


def grid(s, d, n):
    title(s, d["title"])
    gap = 0.4
    cw = (W - 2 * MX - gap) / 2
    ch = 2.2
    for i, c in enumerate(d["cards"]):
        x = MX + (i % 2) * (cw + gap)
        y = CONTENT_Y + (i // 2) * (ch + gap)
        box(s, x, y, cw, ch, TINT)
        badge(s, x + 0.4, y + 0.4, i + 1)
        text(s, x + 1.2, y + 0.42, cw - 1.6, 0.5, c["head"], size=21, bold=True)
        text(s, x + 1.2, y + 1.0, cw - 1.6, 0.9, c["body"], size=15, color=MUTED, spacing=1.3)


def compare(s, d, n):
    title(s, d["title"])
    gap = 0.4
    cw = (W - 2 * MX - gap) / 2
    for i, side in enumerate((d["left"], d["right"])):
        x = MX + i * (cw + gap)
        dark = i == 1
        box(s, x, CONTENT_Y, cw, 3.9, INK if dark else TINT)
        text(s, x + 0.5, CONTENT_Y + 0.4, cw - 1, 0.5, side["head"], size=24, bold=True,
             color=ROSE_SOFT if dark else ROSE)
        for j, item in enumerate(side["items"]):
            y = CONTENT_Y + 1.25 + j * 0.62
            box(s, x + 0.5, y + 0.12, 0.14, 0.14, ROSE_SOFT if dark else ROSE, shape=MSO_SHAPE.OVAL)
            text(s, x + 0.85, y, cw - 1.35, 0.4, item, size=17, color=WHITE if dark else INK)
    text(s, MX, 6.0, W - 2 * MX, 0.5, d["caption"], size=14, color=MUTED)


def mission(s, d, n):
    title(s, d["title"])
    text(s, MX, 1.45, W - 2 * MX, 0.4, d["lead"], size=16, color=MUTED)
    tw = 7.2
    rows = d["fields"]
    rh = 0.7
    y0 = 2.25
    box(s, MX, y0, tw, rh * len(rows), WHITE, line=BORDER, radius=0.04)
    for i, (k, v) in enumerate(rows):
        y = y0 + i * rh
        if i:
            box(s, MX, y, tw, 0.015, BORDER, shape=MSO_SHAPE.RECTANGLE)
        text(s, MX + 0.4, y, 2.0, rh, k, size=16, bold=True, color=MUTED, anchor=MSO_ANCHOR.MIDDLE)
        text(s, MX + 2.4, y, tw - 2.8, rh, v, size=17, anchor=MSO_ANCHOR.MIDDLE)
    # 휴대폰 모양 미리보기
    px, pw = MX + tw + 1.0, 2.6
    box(s, px, 1.75, pw, 4.9, INK, radius=0.12)
    box(s, px + 0.15, 1.95, pw - 0.3, 4.5, WHITE, radius=0.08)
    box(s, px + 0.3, 2.15, 0.4, 0.4, ROSE_SOFT, shape=MSO_SHAPE.OVAL)
    box(s, px + 0.85, 2.27, 1.2, 0.16, BORDER, radius=0.5)
    sq = (pw - 0.6 - 0.1) / 2
    for r in range(2):
        for c in range(2):
            box(s, px + 0.3 + c * (sq + 0.1), 2.8 + r * (sq + 0.1), sq, sq,
                ROSE if (r + c) % 2 == 0 else TINT, radius=0.06)
    text(s, px + 0.3, 2.8 + 2 * sq + 0.35, pw - 0.6, 0.4, "#HypeConnect", size=12, bold=True, color=ROSE)
    box(s, px + 0.3, 2.8 + 2 * sq + 0.8, pw - 0.6, 0.14, BORDER, radius=0.5)
    box(s, px + 0.3, 2.8 + 2 * sq + 1.05, pw - 1.2, 0.14, BORDER, radius=0.5)
    text(s, MX, y0 + rh * len(rows) + 0.35, tw, 0.4, d["caption"], size=14, color=MUTED)


def steps(s, d, n):
    title(s, d["title"])
    rows = d["steps"]
    rh = 1.08
    for i, st in enumerate(rows):
        y = CONTENT_Y + i * rh
        badge(s, MX, y + 0.1, i + 1, d=0.7, size=20)
        text(s, MX + 1.1, y + 0.08, 3.2, 0.7, st["head"], size=22, bold=True, anchor=MSO_ANCHOR.MIDDLE)
        text(s, MX + 4.3, y + 0.08, W - 2 * MX - 4.3, 0.7, st["body"], size=17, color=MUTED,
             anchor=MSO_ANCHOR.MIDDLE)
        if i < len(rows) - 1:
            box(s, MX, y + rh - 0.05, W - 2 * MX, 0.015, BORDER, shape=MSO_SHAPE.RECTANGLE)


def closing(s, d, n):
    bg(s, INK)
    box(s, -1.6, 4.2, 4.6, 4.6, ROSE, shape=MSO_SHAPE.OVAL)
    text(s, MX, 1.6, W - 2 * MX, 1.0, d["title"], size=40, bold=True, color=WHITE)
    text(s, MX, 2.75, 9, 0.8, d["body"], size=18, color=DARK_MUTED, spacing=1.3)
    for i, (k, v) in enumerate(d["contact"]):
        y = 4.2 + i * 0.75
        text(s, 4.0, y, 1.6, 0.5, k, size=14, bold=True, color=ROSE_SOFT, anchor=MSO_ANCHOR.MIDDLE)
        text(s, 5.6, y, 7, 0.5, v, size=20, bold=True, color=WHITE, anchor=MSO_ANCHOR.MIDDLE)


LAYOUTS = {f.__name__: f for f in (cover, cards, statement, flow, stat, grid, compare, mission, steps, closing)}
DARK = {"cover", "closing"}


def build():
    prs = Presentation()
    prs.slide_width, prs.slide_height = Inches(W), Inches(H)
    blank = prs.slide_layouts[6]
    files = sorted((ROOT / "slides").glob("*.yaml"))
    for n, f in enumerate(files, 1):
        d = yaml.safe_load(f.read_text(encoding="utf-8"))
        layout = d.get("layout")
        if layout not in LAYOUTS:
            raise SystemExit(f"{f.name}: 알 수 없는 layout '{layout}' (가능: {', '.join(LAYOUTS)})")
        s = prs.slides.add_slide(blank)
        bg(s, WHITE)
        LAYOUTS[layout](s, d, n)
        if layout not in DARK:
            page_no(s, n)
        if d.get("notes"):
            s.notes_slide.notes_text_frame.text = d["notes"].strip()
    OUT.parent.mkdir(exist_ok=True)
    prs.save(OUT)
    print(f"{len(files)}장 → {OUT.relative_to(ROOT.parent)}")


if __name__ == "__main__":
    build()
