"""
渲染结果像素验收

目的：不靠"看着像"判断 3D 场景是否渲染正确，而是用可判定的像素统计做对账。
断言值取参考图（西湖 3D 地图）的同类指标作为基准区间。

指标定义
  coverage      非背景像素占画面比例 —— 模型在画面中占多大
  band[top/mid/bottom]  各水平带内的非背景占比，用于判断构图（模型是否被切掉/偏移）
  greenRatio    绿色像素占比 —— 植被/山林
  blueRatio     蓝色像素占比 —— 水体/河流（都江堰应有岷江与内江）
  grayRatio     灰白像素占比 —— 建筑/城区/岩石
  lumStd        亮度标准差 —— 立体感（光照产生的明暗层次）
  edgeDensity   边缘密度 —— 地形细节丰富度
  baseBlock     底部是否出现连续深色基座（地质剖面块）

用法：python tools/test_render.py [png 路径 ...]
"""

import sys
from pathlib import Path

from PIL import Image

BG = (198, 217, 227)  # scene.background 0xc9dde8 附近的渲染值
BG_TOL = 12          # 容差

failures = []
checks = 0


def check(name, cond, detail=""):
    global checks
    checks += 1
    if cond:
        print(f"  PASS  {name}")
        return True
    print(f"  FAIL  {name}  {detail}")
    failures.append(f"{name} {detail}")
    return False


def is_bg(px):
    return (
        abs(px[0] - BG[0]) <= BG_TOL
        and abs(px[1] - BG[1]) <= BG_TOL
        and abs(px[2] - BG[2]) <= BG_TOL
    )


def analyze(path):
    im = Image.open(path).convert("RGB")
    W, H = im.size
    px = im.load()

    step = 2
    n = 0
    non_bg = 0
    green = blue = gray = 0
    lums = []
    band_hits = {"top": [0, 0], "mid": [0, 0], "bottom": [0, 0]}

    for y in range(0, H, step):
        for x in range(0, W, step):
            p = px[x, y]
            n += 1
            band = "top" if y < H * 0.33 else ("mid" if y < H * 0.72 else "bottom")
            band_hits[band][1] += 1

            if is_bg(p):
                lums.append(200)
                continue

            non_bg += 1
            band_hits[band][0] += 1

            r, g, b = p
            lum = 0.299 * r + 0.587 * g + 0.114 * b
            lums.append(lum)

            mx, mn = max(p), min(p)
            sat = mx - mn

            # 植被：绿通道明显主导
            if g > r + 8 and g > b + 8:
                green += 1
            # 水体：蓝通道主导且偏暗
            elif b > r + 12 and b >= g:
                blue += 1
            # 灰白：低饱和（建筑、岩石、道路）
            elif sat < 26:
                gray += 1

    # 边缘密度：Sobel 简化版，横向+纵向差分
    edges = 0
    en = 0
    lpx = im.convert("L").load()
    for y in range(2, H - 2, 3):
        for x in range(2, W - 2, 3):
            gx = abs(lpx[x + 1, y] - lpx[x - 1, y])
            gy = abs(lpx[x, y + 1] - lpx[x, y - 1])
            if gx + gy > 34:
                edges += 1
            en += 1

    mean_lum = sum(lums) / len(lums)
    lum_std = (sum((v - mean_lum) ** 2 for v in lums) / len(lums)) ** 0.5

    return {
        "path": str(path),
        "size": (W, H),
        "coverage": non_bg / n,
        "band": {k: (v[0] / v[1] if v[1] else 0) for k, v in band_hits.items()},
        "greenRatio": green / n,
        "blueRatio": blue / n,
        "grayRatio": gray / n,
        "lumStd": lum_std,
        "edgeDensity": edges / en,
    }


def test_shot(path, expect):
    """expect: 'far' 远景全景 / 'near' 近景特写"""
    print(f"\n=== {Path(path).name} ({expect}) ===")
    if not check("文件存在", Path(path).exists(), path):
        return
    a = analyze(path)

    print(
        f"  实测 coverage={a['coverage']:.1%} "
        f"top={a['band']['top']:.0%} mid={a['band']['mid']:.0%} bottom={a['band']['bottom']:.0%}"
    )
    print(
        f"       绿={a['greenRatio']:.1%} 蓝={a['blueRatio']:.1%} 灰={a['grayRatio']:.1%} "
        f"亮度σ={a['lumStd']:.1f} 边缘={a['edgeDensity']:.1%}"
    )

    # 1) 模型必须占据画面主体，不能是空白
    check(
        "模型占画面 >35%",
        a["coverage"] > 0.35,
        f"得 {a['coverage']:.1%}",
    )
    # 2) 不能糊满整屏（说明相机钻进了地形内部或过近失真）
    check(
        "模型未糊满整屏 <97%",
        a["coverage"] < 0.97,
        f"得 {a['coverage']:.1%}（疑似相机在地形内部）",
    )
    # 3) 中部必须有内容（模型主体所在）
    check(
        "中部有模型主体 >55%",
        a["band"]["mid"] > 0.55,
        f"得 {a['band']['mid']:.0%}",
    )
    # 4) 顶部大部分是天空，模型不应顶满
    check(
        "顶部留有天空 >40%",
        a["band"]["top"] < 0.60,
        f"得 {a['band']['top']:.0%}",
    )
    # 5) 立体感：光照产生明暗层次
    check("亮度标准差 >18（有立体光影）", a["lumStd"] > 18, f"得 {a['lumStd']:.1f}")
    # 6) 细节：卫星影像必须有丰富纹理
    check(
        "边缘密度 >6%（影像纹理丰富）",
        a["edgeDensity"] > 0.06,
        f"得 {a['edgeDensity']:.1%}",
    )
    # 7) 颜色构成：应有植被绿
    check("存在植被绿 >8%", a["greenRatio"] > 0.08, f"得 {a['greenRatio']:.1%}")
    # 8) 颜色多样性：不能是单一色块
    total_cls = a["greenRatio"] + a["blueRatio"] + a["grayRatio"]
    check(
        "地物类型多样 >30%",
        total_cls > 0.30,
        f"绿+蓝+灰={total_cls:.1%}",
    )

    if expect == "far":
        # 远景：底部应出现基座（连续非背景带）
        check(
            "远景底部有基座/前景 >25%",
            a["band"]["bottom"] > 0.25,
            f"得 {a['band']['bottom']:.0%}",
        )
    return a


def main():
    print("=== 渲染像素验收 ===")
    files = sys.argv[1:] or [
        "probe/shot.png",
        "probe/shot_yuzui.png",
        "probe/shot_yulei.png",
    ]
    expects = ["far", "near", "near"]

    results = []
    for f, e in zip(files, expects):
        results.append(test_shot(f, e))

    print(f"\n=== 结果：{checks - len(failures)}/{checks} 通过 ===")
    if failures:
        print("\n失败项：")
        for x in failures:
            print(f"  - {x}")
        sys.exit(1)
    print("全部通过")
    sys.exit(0)


if __name__ == "__main__":
    main()
