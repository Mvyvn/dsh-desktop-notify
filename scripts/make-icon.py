# dsh-desktop-notify — 生成通知图标 assets/dsh.png / assets/dsh.ico
#
# 输入：assets/dsh-logo.svg（DSH 官方 favicon，深色模式为白色鱼形）
# 输出：
#   assets/dsh.png  — 256x256 RGBA：透明底 + 白色鱼形（Toast appLogoOverride 用）
#   assets/dsh.ico  — 256x256 ICO（PNG 压缩，透明底白鱼；AUMID 应用图标用）
#
# 依赖：pip install svgpathtools pillow（仅开发期换图用；插件安装与运行都不需要 Python）
# 用法：python scripts/make-icon.py
#
# 背景：Windows Toast 的 appLogoOverride 只支持 PNG/JPG/GIF，不支持 SVG；
# 故必须预栅格化一张 PNG 随包携带（Linux 侧的 app_icon 也直接用它）。
# 实现：svgpathtools 解析路径 → 按不连续点切分子路径 → 贝塞尔展平 →
#       PIL 多边形填充（外轮廓白、内孔镂空）→ 4x 超采样 + LANCZOS 抗锯齿。

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw
from svgpathtools import parse_path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "dsh-logo.svg"
OUT_PNG = ROOT / "assets" / "dsh.png"
OUT_ICO = ROOT / "assets" / "dsh.ico"

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

def render_fish(d: str) -> Image.Image:
    """返回 256x256 RGBA：透明底 + 白色鱼形。"""
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
    out = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 0))
    out.putalpha(alpha)
    return out

def main() -> None:
    svg = SRC.read_text(encoding="utf-8")
    m = re.search(r'<path[^>]*\bd="([^"]+)"', svg, re.S)
    if not m:
        sys.exit(f"[make-icon] no path d= found in {SRC}")
    d = m.group(1)

    img = render_fish(d)
    img.save(OUT_PNG, format="PNG")
    img.save(OUT_ICO, format="ICO", sizes=[(SIZE, SIZE)])
    print(f"[make-icon] wrote {OUT_PNG} and {OUT_ICO} ({SIZE}x{SIZE}, transparent bg, white fish)")

if __name__ == "__main__":
    main()
