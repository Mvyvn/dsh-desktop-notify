# dsh-desktop-notify — 生成通知图标（深浅两套透明底鱼形）
#
# 输入：assets/dsh-logo.svg（DSH 官方 favicon，深色模式为白色鱼形）
# 输出（均为 256x256 RGBA，透明底）：
#   assets/dsh-dark.png  / dsh-dark.ico   — 白色鱼形，深色主题用（Toast/Linux 通知背景是深色）
#   assets/dsh-light.png / dsh-light.ico  — 黑色鱼形，浅色主题用（背景是白色，白鱼会看不见）
#   assets/dsh.png       / dsh.ico        — 兼容旧路径：与 dsh-dark.* 同像素（历史默认=白鱼）
#
# 依赖：pip install svgpathtools pillow（仅开发期换图用；插件安装与运行都不需要 Python）
# 用法：python scripts/make-icon.py
#
# 背景：Windows Toast 的 appLogoOverride 只支持 PNG/JPG/GIF，不支持 SVG；
# 故必须预栅格化一张 PNG 随包携带（Linux 侧的 app_icon 也直接用它）。
#       Toast 与桌面通知的背景色跟随系统主题，图标本身不会被反色——所以必须
#       深浅两套，由 lib/theme.js 在发送时按当前主题挑选。
# 实现：svgpathtools 解析路径 → 按不连续点切分子路径 → 贝塞尔展平 →
#       PIL 多边形填充（外轮廓上色、内孔镂空）→ 4x 超采样 + LANCZOS 抗锯齿。

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw
from svgpathtools import parse_path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "dsh-logo.svg"
# (输出文件名, 鱼形 RGB)——alpha 通道完全一致，只有前景色不同
VARIANTS = [
    ("dsh-dark", (255, 255, 255)),   # 深色主题：白鱼
    ("dsh-light", (0, 0, 0)),        # 浅色主题：黑鱼
]
LEGACY = "dsh"                       # 旧路径，写一份与 dsh-dark 同像素的副本

SIZE = 256            # 输出尺寸
SS = 4                # 超采样倍数（抗锯齿；SS=4 → 1024x1024 绘制后降采样）
FISH_SCALE = 0.86     # 鱼形占画布比例
FLAT_TOL = 0.2        # 贝塞尔展平容差（logo 坐标单位）

def collect_subpaths(path) -> list[list[tuple[float, float]]]:
    """svgpathtools 1.7 把整条路径展平成片段列表；按不连续点（M 起新子路径）切分，
    每个片段按长度自适应采样展平。"""
    subs: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []
    prev_end: complex | None = None
    for seg in path:
        if cur and prev_end is not None and abs(seg.start - prev_end) > 1e-9:
            subs.append(cur)
            cur = []
        pts: list[tuple[float, float]] = []
        n = max(4, int(seg.length() / FLAT_TOL) + 1)
        for k in range(n + 1):
            p = seg.point(k / n)
            if not pts or abs(p - complex(*pts[-1])) > 1e-9:
                pts.append((p.real, p.imag))
        if cur and pts and abs(complex(*cur[-1]) - complex(*pts[0])) <= 1e-9:
            pts = pts[1:]
        cur.extend(pts)
        prev_end = seg.end
    if cur:
        subs.append(cur)
    return subs

def signed_area(poly: list[tuple[float, float]]) -> float:
    """Shoelace 有符号面积（SVG y 向下坐标）。"""
    s = 0.0
    for i in range(len(poly) - 1):
        s += poly[i][0] * poly[i + 1][1] - poly[i + 1][0] * poly[i][1]
    return s / 2.0

def render_fish(d: str, rgb: tuple[int, int, int]) -> Image.Image:
    """返回 256x256 RGBA：透明底 + 指定颜色的鱼形。"""
    path = parse_path(d)
    polys = collect_subpaths(path)

    # 孔洞判定：SVG nonzero 绕向规则——面积最大的子路径是外轮廓，
    # 与之绕向相反（有符号面积异号）的子路径是内部镂空（孔）。
    areas = [signed_area(p) for p in polys]
    main_sign = 1 if areas[areas.index(max(areas, key=abs))] >= 0 else -1
    holes = {i for i, a in enumerate(areas) if a != 0 and (a > 0) != (main_sign > 0)}

    canvas = SIZE * SS
    f = canvas * FISH_SCALE / 50.0
    def to_canvas(pts):
        return [(canvas / 2 + (x - 25) * f, canvas / 2 + (y - 25) * f) for x, y in pts]

    mask = Image.new("L", (canvas, canvas), 0)
    dr = ImageDraw.Draw(mask)
    for i, poly in enumerate(polys):
        if i not in holes:
            dr.polygon(to_canvas(poly), fill=255)
    for i in holes:
        dr.polygon(to_canvas(polys[i]), fill=0)

    # 超采样降采样 → 抗锯齿 alpha
    alpha = mask.resize((SIZE, SIZE), Image.LANCZOS)
    out = Image.new("RGBA", (SIZE, SIZE), (*rgb, 0))
    out.putalpha(alpha)
    return out

def main() -> None:
    svg = SRC.read_text(encoding="utf-8")
    m = re.search(r'<path[^>]*\bd="([^"]+)"', svg, re.S)
    if not m:
        sys.exit(f"[make-icon] no path d= found in {SRC}")
    d = m.group(1)

    written = []
    for stem, rgb in VARIANTS:
        img = render_fish(d, rgb)
        png = ROOT / "assets" / f"{stem}.png"
        ico = ROOT / "assets" / f"{stem}.ico"
        img.save(png, format="PNG")
        img.save(ico, format="ICO", sizes=[(SIZE, SIZE)])
        written.append((png, ico))
        print(f"[make-icon] wrote {png.name} and {ico.name} "
              f"({SIZE}x{SIZE}, transparent bg, rgb={rgb})")

    # 旧路径兼容副本：与深色（白鱼）版本逐像素一致，历史引用不会失效
    dark_png, dark_ico = written[0]
    legacy_png = ROOT / "assets" / f"{LEGACY}.png"
    legacy_ico = ROOT / "assets" / f"{LEGACY}.ico"
    legacy_png.write_bytes(dark_png.read_bytes())
    legacy_ico.write_bytes(dark_ico.read_bytes())
    print(f"[make-icon] wrote {legacy_png.name} and {legacy_ico.name} (copy of dsh-dark)")

if __name__ == "__main__":
    main()
