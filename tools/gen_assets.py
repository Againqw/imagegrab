"""生成扩展图标（16/48/128）与本地演示用的商品图片。

用法：python tools/gen_assets.py
依赖：Pillow
"""

from __future__ import annotations

import math
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"
DEMO_DIR = ROOT / "demo" / "images"

FONT_CANDIDATES = [
    "C:/Windows/Fonts/segoeuib.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def load_font(size: int):
    """加载系统字体，失败则返回 None"""
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return None

INDIGO = (79, 70, 229)
VIOLET = (168, 85, 247)


def linear_gradient(size: int, start: tuple[int, int, int], end: tuple[int, int, int]) -> Image.Image:
    """生成 135° 线性渐变底图"""
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(start[i] + (end[i] - start[i]) * t) for i in range(3))
    return img


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def build_icon(size: int = 512) -> Image.Image:
    """绘制 512 尺寸母版图标"""
    s = size
    base = linear_gradient(s, INDIGO, VIOLET).convert("RGBA")
    base.putalpha(rounded_mask(s, int(s * 0.28)))

    layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # 外框（圆角矩形）
    pad = int(s * 0.2)
    stroke = max(2, int(s * 0.055))
    d.rounded_rectangle(
        (pad, pad, s - pad, s - pad),
        radius=int(s * 0.14),
        outline=(255, 255, 255, 245),
        width=stroke,
    )
    # 太阳
    r = int(s * 0.055)
    cx, cy = int(s * 0.36), int(s * 0.38)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(255, 255, 255, 255))

    # 山形折线
    pts = [
        (int(s * 0.24), int(s * 0.66)),
        (int(s * 0.41), int(s * 0.49)),
        (int(s * 0.53), int(s * 0.61)),
        (int(s * 0.62), int(s * 0.52)),
        (int(s * 0.77), int(s * 0.68)),
    ]
    d.line(pts, fill=(255, 255, 255, 255), width=stroke, joint="curve")

    # 顶部高光
    gloss = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    ImageDraw.Draw(gloss).ellipse(
        (-int(s * 0.4), -int(s * 0.7), int(s * 1.0), int(s * 0.5)), fill=(255, 255, 255, 26)
    )
    base = Image.alpha_composite(base, gloss)
    return Image.alpha_composite(base, layer)


def build_demo_image(index: int, size: int = 900) -> Image.Image:
    """生成本地演示用的“商品图”：渐变背景 + 柔和光斑 + 序号"""
    palettes = [
        ((238, 242, 255), (199, 210, 254), (79, 70, 229)),
        ((255, 247, 237), (254, 215, 170), (234, 88, 12)),
        ((236, 253, 245), (167, 243, 208), (5, 150, 105)),
        ((253, 242, 248), (251, 207, 232), (219, 39, 119)),
        ((239, 246, 255), (191, 219, 254), (37, 99, 235)),
        ((245, 243, 255), (221, 214, 254), (124, 58, 237)),
        ((250, 250, 249), (231, 229, 228), (87, 83, 78)),
        ((254, 252, 232), (254, 240, 138), (202, 138, 4)),
    ]
    bg_a, bg_b, accent = palettes[index % len(palettes)]
    img = Image.new("RGB", (size, size), bg_a)

    # 竖向渐变
    draw = ImageDraw.Draw(img)
    for y in range(size):
        t = y / (size - 1)
        draw.line(
            [(0, y), (size, y)],
            fill=tuple(round(bg_a[i] + (bg_b[i] - bg_a[i]) * t) for i in range(3)),
        )

    # 柔和光斑
    blobs = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(blobs)
    bd.ellipse(
        (int(size * 0.05), int(size * 0.55), int(size * 0.75), int(size * 1.15)),
        fill=(255, 255, 255, 120),
    )
    bd.ellipse(
        (int(size * 0.45), int(size * -0.1), int(size * 1.05), int(size * 0.5)),
        fill=accent + (40,),
    )
    blobs = blobs.filter(ImageFilter.GaussianBlur(radius=size * 0.06))
    img = Image.alpha_composite(img.convert("RGBA"), blobs)

    # 主体：圆角矩形 + 序号
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    margin = int(size * 0.22)
    ld.rounded_rectangle(
        (margin, margin, size - margin, size - margin),
        radius=int(size * 0.11),
        fill=(255, 255, 255, 205),
        outline=accent + (90,),
        width=max(2, int(size * 0.004)),
    )
    # 圆环
    ring_r = int(size * 0.115)
    ring_c = (size // 2, int(size * 0.42))
    ld.ellipse(
        (ring_c[0] - ring_r, ring_c[1] - ring_r, ring_c[0] + ring_r, ring_c[1] + ring_r),
        outline=accent + (255,),
        width=max(3, int(size * 0.012)),
    )
    # 序号：优先使用系统字体，找不到时退回几何图形
    label = f"{index + 1:02d}"
    font = load_font(int(size * 0.13))
    if font is not None:
        bbox = ld.textbbox((0, 0), label, font=font)
        text_w, text_h = bbox[2] - bbox[0], bbox[3] - bbox[1]
        ld.text(
            ((size - text_w) / 2 - bbox[0], int(size * 0.72) - text_h - bbox[1]),
            label,
            font=font,
            fill=accent + (255,),
        )
    else:
        digit_w = int(size * 0.035)
        gap = int(size * 0.03)
        total_w = len(label) * digit_w + (len(label) - 1) * gap
        start_x = (size - total_w) // 2
        base_y = int(size * 0.72)
        for i, ch in enumerate(label):
            x = start_x + i * (digit_w + gap)
            ld.rounded_rectangle(
                (x, base_y - digit_w * 1.6, x + digit_w, base_y),
                radius=digit_w // 2,
                outline=accent + (255,),
                width=max(2, int(size * 0.009)),
            )

    img = Image.alpha_composite(img, layer)

    # 底部水印，模拟商品图上的文字
    wm = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    wd = ImageDraw.Draw(wm)
    bar_w, bar_h = int(size * 0.34), int(size * 0.012)
    wd.rounded_rectangle(
        ((size - bar_w) // 2, int(size * 0.83), (size + bar_w) // 2, int(size * 0.83) + bar_h),
        radius=bar_h // 2,
        fill=accent + (70,),
    )
    return Image.alpha_composite(img, wm).convert("RGB")


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    DEMO_DIR.mkdir(parents=True, exist_ok=True)

    master = build_icon(512)
    for size in (16, 48, 128):
        master.resize((size, size), Image.LANCZOS).save(ICON_DIR / f"icon{size}.png")
    master.save(ROOT / "docs" / "assets" / "logo-512.png")
    master.resize((256, 256), Image.LANCZOS).save(ROOT / "docs" / "assets" / "logo-256.png")
    print("icons done")

    # 演示商品图：8 张 PNG + 1 张 JPG + 1 张 WebP + 小图标 + 1x1 像素（用于测试过滤与格式转换）
    for i in range(8):
        build_demo_image(i).save(DEMO_DIR / f"product-{i + 1:02d}.png")
    build_demo_image(8).save(DEMO_DIR / "product-09.jpg", quality=88)
    build_demo_image(9).save(DEMO_DIR / "product-10.webp", quality=88)
    build_icon(64).resize((32, 32), Image.LANCZOS).save(DEMO_DIR / "icon-logo.png")
    Image.new("RGB", (1, 1), (255, 255, 255)).save(DEMO_DIR / "pixel-1x1.png")
    print("demo images done")


if __name__ == "__main__":
    main()
