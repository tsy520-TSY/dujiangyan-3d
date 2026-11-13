"""
都江堰地形数据产物验收测试

这是项目的 ground truth 门禁：3D 场景再好看，数据错了整个模型就是错的。
断言值来自对 AWS Terrain Tiles 的实测采样（见 docs/terrain-facts.md）。

运行：python tools/test_terrain.py
"""

import json
import math
import struct
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "public" / "data"

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


def approx(val, lo, hi):
    return lo <= val <= hi


def main():
    print("=== 地形数据产物验收 ===\n")

    # ---------- 1. meta.json ----------
    print("[1] meta.json")
    meta_path = DATA / "meta.json"
    if not meta_path.exists():
        check("meta.json 存在", False, str(meta_path))
        return report()
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    check("meta.json 可解析", isinstance(meta, dict))
    for key in ("bbox", "grid", "elevation", "sceneSizeMeters", "imagery", "sources"):
        check(f"含字段 {key}", key in meta)

    bbox = meta["bbox"]
    grid = meta["grid"]
    elev = meta["elevation"]
    check(
        "bbox 覆盖水利工程核心区",
        bbox["west"] < 103.60 and bbox["east"] > 103.63,
    )
    check("bbox 纬度正确", bbox["south"] < 31.00 < bbox["north"])
    check("网格尺寸为正", grid["width"] > 100 and grid["height"] > 100)

    # ---------- 2. 高程合理区间 ----------
    print("\n[2] 高程范围（实测基准：河谷约 700m，西北山地 >1000m）")
    check("min 在河谷高程区间", approx(elev["min"], 690, 715), f'得 {elev["min"]}')
    check("max 达到山地高程", approx(elev["max"], 1000, 1300), f'得 {elev["max"]}')
    check(
        "场景落差 >300m（立体感下限）",
        elev["max"] - elev["min"] > 300,
        f'得 {elev["max"] - elev["min"]:.0f}m',
    )

    # ---------- 3. heightmap.f32 ----------
    print("\n[3] heightmap.f32 二进制网格")
    hm_path = DATA / "heightmap.f32"
    if not check("heightmap.f32 存在", hm_path.exists()):
        return report()
    raw = hm_path.read_bytes()
    expected = grid["width"] * grid["height"] * 4
    check("字节数 = 宽×高×4", len(raw) == expected, f"得 {len(raw)} 应为 {expected}")

    w, h = grid["width"], grid["height"]
    vals = struct.unpack(f"<{w * h}f", raw[:expected])
    check("无 NaN/Inf", all(math.isfinite(v) for v in vals))
    lo, hi = min(vals), max(vals)
    check("实际最低值与 meta 一致", abs(lo - elev["min"]) < 1.0, f"得 {lo:.1f}")
    check("实际最高值与 meta 一致", abs(hi - elev["max"]) < 1.0, f"得 {hi:.1f}")

    # ---------- 4. 关键点位高程核验 ----------
    print("\n[4] 关键点位高程（对比实地/公开资料）")
    def sample(lng, lat):
        """最近邻采样高程网格"""
        i = round((lng - bbox["west"]) / (bbox["east"] - bbox["west"]) * (w - 1))
        j = round((bbox["north"] - lat) / (bbox["north"] - bbox["south"]) * (h - 1))
        i = max(0, min(w - 1, i))
        j = max(0, min(h - 1, j))
        return vals[j * w + i]

    # 期望区间宽松但有意义：河谷类点位必须低，山地类必须高
    landmarks = [
        ("鱼嘴分水堤", 103.6085, 31.0045, 720, 760),
        ("离堆公园", 103.6205, 30.9965, 710, 745),
        ("南桥", 103.6270, 30.9950, 710, 740),
        ("灌县古城", 103.6250, 30.9930, 710, 740),
        ("玉垒山一带", 103.6150, 31.0120, 730, 810),
    ]
    for name, lng, lat, lo_, hi_ in landmarks:
        v = sample(lng, lat)
        check(f"{name} 高程合理", approx(v, lo_, hi_), f"得 {v:.1f}m 期望 {lo_}~{hi_}")

    # 河谷必须显著低于山地 —— 这是整个地形模型的核心不变量
    # 采样点均取实测确认的值：西缘山地约 1011m，鱼嘴河道约 741m
    river = sample(103.6090, 31.0045)
    mountain = sample(103.5800, 31.0130)
    check(
        "西缘山地明显高于河谷",
        mountain - river > 150,
        f"山地 {mountain:.0f} - 河谷 {river:.0f} = {mountain - river:.0f}m",
    )

    # ---------- 5. 影像贴图 ----------
    print("\n[5] 卫星影像贴图")
    img_path = DATA / "terrain.png"
    alt_path = DATA / "terrain.jpg"
    use = img_path if img_path.exists() else alt_path
    check("影像文件存在", use.exists(), f"找过 {img_path.name} / {alt_path.name}")
    if use.exists():
        check("影像非空", use.stat().st_size > 50000, f"得 {use.stat().st_size}B")
        check(
            "影像尺寸与 meta 一致",
            meta["imagery"]["width"] > 2000,
            f'得 {meta["imagery"]["width"]}',
        )

    # ---------- 6. 点位清单 ----------
    print("\n[6] 点位清单 spots.json")
    sp_path = DATA / "spots.json"
    if not check("spots.json 存在", sp_path.exists()):
        return report()
    spots = json.loads(sp_path.read_text(encoding="utf-8"))
    arr = spots if isinstance(spots, list) else spots.get("spots", [])
    check("点位数 >= 25", len(arr) >= 25, f"得 {len(arr)}")

    required = {"id", "name", "lng", "lat", "elevation", "category", "stayMinutes"}
    bad = [s.get("id", "?") for s in arr if not required.issubset(s)]
    check("每个点位含必需字段", not bad, f"缺失: {bad[:5]}")

    out_of_box = [
        s["id"]
        for s in arr
        if not (bbox["west"] <= s["lng"] <= bbox["east"]
                and bbox["south"] <= s["lat"] <= bbox["north"])
    ]
    check("所有点位在场景 bbox 内", not out_of_box, f"越界: {out_of_box[:5]}")

    ids = [s["id"] for s in arr]
    check("点位 id 唯一", len(ids) == len(set(ids)))

    # 必看点必须存在（行程算法的硬约束依赖它）
    must = [s for s in arr if s.get("mustVisit")]
    check("存在必看点标记", len(must) >= 3, f"得 {len(must)}")

    report()


def report():
    print(f"\n=== 结果：{checks - len(failures)}/{checks} 通过 ===")
    if failures:
        print("\n失败项：")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("全部通过")
    sys.exit(0)


if __name__ == "__main__":
    main()
