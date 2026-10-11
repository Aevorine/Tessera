"""从一张方形源图生成全套安卓启动器图标。

    python -X utf8 tools/make_launcher_icons.py <源图.png>

产出（全部落在 app/src/main/res/ 与 store/ 下，直接覆盖）：

    mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher.png          传统图标，48~192 px
    mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher_round.png    圆形遮罩版，同上尺寸
    mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher_foreground.png   自适应前景，108~432 px
    mipmap-{m,h,xh,xxh,xxxh}dpi/ic_launcher_background.png   自适应背景，同上
    store/ic_launcher-playstore.png                      Play 商店用，512 px 不透明

## 为什么要有自适应图标

本工程 minSdk=26，所有目标设备都支持自适应图标（Adaptive Icon）。只给传统位图
的话，API 26+ 的启动器会把它当"遗留图标"处理：缩小一圈、垫一层白底衬垫再套遮罩
——表现就是图标比别的应用小一号还带白边。有了 mipmap-anydpi-v26 之后，启动器
直接拿两个图层自己套形状，各家厂商的圆形/方形/水滴遮罩都能正确渲染。

## 尺寸与安全区

自适应图标的画布是 108dp，但**启动器遮罩最多能从每边裁掉 18dp**，只有中心
72dp（= 66.7%）是保证可见的"安全区"。前景按 FG_SCALE 缩放居中，取值见下面的
常量注释——这是本脚本唯一一个需要按图调的参数。

## 白角

AI 生成的图标通常把圆角画进像素里，四角是不透明的白色而非透明。这种图直接当
图标用，遇到方形遮罩的启动器就会露出四个白三角。strip_corners() 负责剥掉它。
"""

from __future__ import annotations

import os
import sys
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ANDROID_ROOT = os.path.dirname(HERE)
RES = os.path.join(ANDROID_ROOT, "app", "src", "main", "res")
STORE = os.path.join(ANDROID_ROOT, "store")

# 密度 -> (传统图标边长, 自适应图层边长)。自适应图层永远是 108/48 = 2.25 倍。
DENSITIES = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}

# 前景内容占 108dp 画布的比例。官方安全区 66.7% 是给内容顶边的图设计的，本图主体自带内边距，照搬会偏
# 小。
# 0.74 是在圆形遮罩（最苛刻）下逐个渲染 0.80/0.77/0.74/0.71 比出的：前两者削平两侧设备外框，0.74 是
# 第一个完整的值。
# 换图后必须重新目测定，不能自动算：环绕白弧和底部彩虹波浪是故意画到出血的装饰，会被量成主体而使比例
# 过小。
FG_SCALE = 0.74

# 背景模糊半径（相对画布边长）。背景是源图铺满后重度模糊得到的柔光色场，
# 目的是让前景边界外侧的颜色与前景自身的边缘色同色系，接缝不突兀。
BG_BLUR = 0.09

# floodfill 容差。40 能吃掉抗锯齿过渡带的大部分，又不会翻过圆角边界。
CORNER_THRESH = 40
# 侵蚀核大小（奇数）。5 = 向内收 2px，吃掉 floodfill 没吃干净的浅色描边。
ERODE = 5


def strip_corners(im: Image.Image) -> Image.Image:
    """把四角与角相连的白色连通域变成透明，返回 RGBA。

    用哨兵色做标记而不是直接改 alpha，是因为 ImageDraw.floodfill 在 RGBA 上
    对 alpha 的处理不直观；先在 RGB 上填一个绝不会出现在图里的品红，再据此
    生成 mask，行为完全可预测。
    """
    rgb = im.convert("RGB")
    w, h = rgb.size
    sentinel = (255, 0, 255)

    work = rgb.copy()
    for xy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(work, xy, sentinel, thresh=CORNER_THRESH)

    wp = work.load()
    mask = Image.new("L", (w, h), 255)
    mp = mask.load()
    for y in range(h):
        for x in range(w):
            if wp[x, y] == sentinel:
                mp[x, y] = 0

    out = rgb.convert("RGBA")
    out.putalpha(mask.filter(ImageFilter.MinFilter(ERODE)))
    return out


def edge_corner_colors(im: Image.Image) -> tuple:
    """沿四条边采样，得到左上/右上/左下/右下四个控制色。

    只采 alpha=255 的边缘像素——四个白角已经被剥成透明了，把它们算进平均色
    会把整块背景往白里拉。内容不触边，所以边上剩下的全是背景色。
    """
    w, h = im.size
    px = im.load()
    buckets = {"tl": [], "tr": [], "bl": [], "br": []}

    def put(key, p):
        if p[3] == 255:
            buckets[key].append(p[:3])

    for x in range(w):
        left = x < w // 2
        put("tl" if left else "tr", px[x, 0])
        put("bl" if left else "br", px[x, h - 1])
    for y in range(h):
        top = y < h // 2
        put("tl" if top else "bl", px[0, y])
        put("tr" if top else "br", px[w - 1, y])

    def avg(vals):
        n = len(vals)
        if n == 0:
            raise SystemExit("边缘采样为空：源图四边可能整圈都是白的，请换图")
        return tuple(sum(v[i] for v in vals) // n for i in range(3))

    return avg(buckets["tl"]), avg(buckets["tr"]), avg(buckets["bl"]), avg(buckets["br"])


def make_gradient(size: int, colors: tuple) -> Image.Image:
    """双线性渐变。

    把四个控制色塞进一张 2x2 的图再放大——BICUBIC 插值出来的就是标准双线性
    渐变，比手写逐像素插值快几个数量级，也不会有 banding。
    """
    tl, tr, bl, br = colors
    seed = Image.new("RGB", (2, 2))
    seed.putpixel((0, 0), tl)
    seed.putpixel((1, 0), tr)
    seed.putpixel((0, 1), bl)
    seed.putpixel((1, 1), br)
    return seed.resize((size, size), Image.BICUBIC).convert("RGBA")


def make_background(art: Image.Image, size: int, colors: tuple) -> Image.Image:
    """自适应图标的背景层：渐变打底 + 源图铺满 + 重度模糊。

    先垫渐变是为了填掉被剥空的四角，否则模糊会把角落的透明拖成一圈暗边。
    """
    base = make_gradient(size, colors)
    base.alpha_composite(art.resize((size, size), Image.LANCZOS))
    blurred = base.filter(ImageFilter.GaussianBlur(radius=size * BG_BLUR))
    return blurred.convert("RGB").convert("RGBA")


def make_foreground(art: Image.Image, size: int) -> Image.Image:
    """自适应图标的前景层：内容缩到 FG_SCALE 居中，四周留透明。"""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = max(1, int(round(size * FG_SCALE)))
    off = (size - inner) // 2
    canvas.alpha_composite(art.resize((inner, inner), Image.LANCZOS), (off, off))
    return canvas


def make_round(art: Image.Image, size: int) -> Image.Image:
    """传统圆形图标：内容缩放后套圆形遮罩。

    4 倍超采样再缩回来，是为了拿到平滑的圆边——PIL 的 ellipse 不做抗锯齿，
    直接画一个 48px 的圆，边缘是锯齿状的。
    """
    ss = size * 4
    mask = Image.new("L", (ss, ss), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, ss - 1, ss - 1), fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)

    square = art.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(square, (0, 0), mask)
    return out


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    src = sys.argv[1]
    if not os.path.isfile(src):
        print(f"源图不存在: {src}")
        return 2

    im = Image.open(src)
    if im.width != im.height:
        print(f"源图不是正方形 ({im.width}x{im.height})，图标会被拉伸。请先裁成方图。")
        return 2

    art = strip_corners(im)
    colors = edge_corner_colors(art)
    print("边缘采样色 TL/TR/BL/BR:", colors)

    written = []
    for density, (legacy, adaptive) in DENSITIES.items():
        d = os.path.join(RES, f"mipmap-{density}")
        os.makedirs(d, exist_ok=True)

        jobs = [
            ("ic_launcher.png", art.resize((legacy, legacy), Image.LANCZOS)),
            ("ic_launcher_round.png", make_round(art, legacy)),
            ("ic_launcher_foreground.png", make_foreground(art, adaptive)),
            ("ic_launcher_background.png", make_background(art, adaptive, colors)),
        ]
        for name, img in jobs:
            p = os.path.join(d, name)
            img.save(p, "PNG", optimize=True)
            written.append(p)

    # Play 商店图：必须不透明、满幅、512x512，圆角由 Play 自己套。
    os.makedirs(STORE, exist_ok=True)
    store_img = make_gradient(512, colors)
    store_img.alpha_composite(art.resize((512, 512), Image.LANCZOS))
    p = os.path.join(STORE, "ic_launcher-playstore.png")
    store_img.convert("RGB").save(p, "PNG", optimize=True)
    written.append(p)

    for p in written:
        print(f"{os.path.getsize(p):>9,} B  {os.path.relpath(p, ANDROID_ROOT)}")
    print(f"\n共写出 {len(written)} 个文件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
