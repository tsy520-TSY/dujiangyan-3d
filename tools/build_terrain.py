"""
都江堰景区地形数据管线

数据源
  高程  AWS Terrain Tiles (terrarium 编码 PNG, z15)
        https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
        height = R*256 + G + B/256 - 32768
  影像  Esri World Imagery (公开 ArcGIS REST 瓦片)
        https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}

产物 (public/data/)
  heightmap.f32   高程网格 Float32 行优先，左上原点，单位米
  terrain.png     卫星影像贴图，已按 bbox 裁剪
  spots.json      景区点位表（坐标/高程/停留时长/类别/标签）
  meta.json       场景元数据

用法：python tools/build_terrain.py
"""

import io
import json
import math
import struct
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data"

# 场景包围盒：都江堰水利工程核心区 + 玉垒山 + 灌县古城
BBOX = {
    "west": 103.575,
    "east": 103.645,
    "south": 30.983,
    "north": 31.030,
}

GRID_W, GRID_H = 1025, 769
DEM_Z = 15
IMG_Z = 18
IMG_OUTPUT_W = 8192
TILE = 256
WORKERS = 12

UA = {"User-Agent": "dujiangyan-3d-edu/0.1 (undergraduate thesis; contact: local)"}


# ---------------- 瓦片数学 ----------------

def lon_to_tile_x(lon, z):
    return (lon + 180.0) / 360.0 * (2 ** z)


def lat_to_tile_y(lat, z):
    r = math.radians(lat)
    return (1.0 - math.log(math.tan(r) + 1.0 / math.cos(r)) / math.pi) / 2.0 * (2 ** z)


def tile_range(bbox, z):
    x0 = int(math.floor(lon_to_tile_x(bbox["west"], z)))
    x1 = int(math.floor(lon_to_tile_x(bbox["east"], z)))
    y0 = int(math.floor(lat_to_tile_y(bbox["north"], z)))
    y1 = int(math.floor(lat_to_tile_y(bbox["south"], z)))
    return x0, x1, y0, y1


# ---------------- 下载 ----------------

def fetch(url, retries=3, timeout=30):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:
            last = e
            time.sleep(0.5 * (i + 1))
    raise RuntimeError(f"下载失败 {url}: {last}")


def fetch_all(jobs, worker, label):
    total = len(jobs)
    results = [None] * total
    done = [0]

    def run(idx_job):
        idx, job = idx_job
        results[idx] = worker(job)
        done[0] += 1
        if done[0] % 10 == 0 or done[0] == total:
            print(f"\r  {label} {done[0]}/{total}", end="", flush=True)

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(run, enumerate(jobs)))
    print()
    return results


# ---------------- 影像 ----------------

def build_imagery():
    x0, x1, y0, y1 = tile_range(BBOX, IMG_Z)
    cols, rows = x1 - x0 + 1, y1 - y0 + 1
    print(f"影像瓦片 z{IMG_Z}: {cols}×{rows} = {cols * rows} 张")

    jobs = [(tx, ty) for ty in range(y0, y1 + 1) for tx in range(x0, x1 + 1)]

    def fetch_tile(tx, ty, z):
        url = ("https://server.arcgisonline.com/ArcGIS/rest/services/"
               f"World_Imagery/MapServer/tile/{z}/{ty}/{tx}")
        return Image.open(io.BytesIO(fetch(url))).convert("RGB")

    def imagery_tile(tx, ty):
        """取当前影像级别瓦片；若个别位置缺失，回退到父级瓦片放大，保证整片影像不断档。"""
        for dz in range(3):
            z = IMG_Z - dz
            sx, sy = tx >> dz, ty >> dz
            try:
                im = fetch_tile(sx, sy, z)
            except Exception:
                continue
            if dz:
                k = 1 << dz
                m = TILE // k
                ox, oy = (tx & (k - 1)) * m, (ty & (k - 1)) * m
                im = im.crop((ox, oy, ox + m, oy + m)).resize((TILE, TILE), Image.LANCZOS)
            return im
        raise RuntimeError(f"影像瓦片缺失 {tx},{ty}")

    tiles = fetch_all(jobs, lambda job: imagery_tile(*job), "影像")

    mosaic = Image.new("RGB", (cols * TILE, rows * TILE))
    for (tx, ty), im in zip(jobs, tiles):
        mosaic.paste(im, ((tx - x0) * TILE, (ty - y0) * TILE))

    # 按 bbox 精确裁剪
    cx0 = (lon_to_tile_x(BBOX["west"], IMG_Z) - x0) * TILE
    cx1 = (lon_to_tile_x(BBOX["east"], IMG_Z) - x0) * TILE
    cy0 = (lat_to_tile_y(BBOX["north"], IMG_Z) - y0) * TILE
    cy1 = (lat_to_tile_y(BBOX["south"], IMG_Z) - y0) * TILE

    # z18 原生约 0.5m/像素；输出 8192 宽，在细节与显存占用间折中。
    out_w = IMG_OUTPUT_W
    out_h = round(out_w * (cy1 - cy0) / (cx1 - cx0))
    crop = mosaic.crop((round(cx0), round(cy0), round(cx1), round(cy1)))
    if crop.size != (out_w, out_h):
        crop = crop.resize((out_w, out_h), Image.LANCZOS)
    # 轻微反锐化，强化道路与建筑边缘
    crop = crop.filter(ImageFilter.UnsharpMask(radius=1.15, percent=58, threshold=2))
    print(f"  裁剪输出 {out_w}×{out_h}")
    return crop


# ---------------- 高程 ----------------

def build_dem():
    x0, x1, y0, y1 = tile_range(BBOX, DEM_Z)
    cols, rows = x1 - x0 + 1, y1 - y0 + 1
    print(f"高程瓦片 z{DEM_Z}: {cols}×{rows} = {cols * rows} 张")

    jobs = [(tx, ty) for ty in range(y0, y1 + 1) for tx in range(x0, x1 + 1)]

    def worker(job):
        tx, ty = job
        url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{DEM_Z}/{tx}/{ty}.png"
        return Image.open(io.BytesIO(fetch(url))).convert("RGB")

    tiles = fetch_all(jobs, worker, "高程")

    mw, mh = cols * TILE, rows * TILE
    mosaic = Image.new("RGB", (mw, mh))
    for (tx, ty), im in zip(jobs, tiles):
        mosaic.paste(im, ((tx - x0) * TILE, (ty - y0) * TILE))

    return mosaic, (x0, y0)


def decode_terrarium(rgb):
    r, g, b = rgb
    return r * 256.0 + g + b / 256.0 - 32768.0


def repair_dem(arr):
    """
    修复 DEM 异常点。

    实测发现 AWS Terrain Tiles 个别瓦片存在**整行损坏**（z15/25811/13413
    的局部行读出 -2352m，而其上下相邻行均约 1203m）。若不清除，3D 网格会
    出现深达数百米的裂缝，高程修正模型的输入也随之失真。

    注意：因为损坏沿水平方向整行连续，水平邻域同样被污染，用 4 邻域中位数
    收不干净（实测残留 -738m）。故改用两个更可靠的手段：
      1. 绝对合理性过滤——研究区地表实测范围约 680~1400m，超出
         [ELEV_FLOOR, ELEV_CEIL] 的必为数据缺陷；
      2. 垂直方向线性插值——损坏是整行，同一列的上下行仍可靠。

    另外，网格加密到 6.5m 后，还会暴露个别「单点凹坑」（邻域 700m、
    自身 633m），这类点不越界也过滤不掉，会在地形上扎出一根针孔，
    因此最后再用 3×3 邻域中位数做一次孤立点剔除。
    """
    import numpy as np

    h = arr.astype(np.float32).copy()
    rows, cols = h.shape

    ELEV_FLOOR, ELEV_CEIL = 400.0, 2200.0
    bad = (h < ELEV_FLOOR) | (h > ELEV_CEIL)
    n_bad = int(bad.sum())

    for j in range(rows):
        xs = np.where(bad[j])[0]
        if xs.size == 0:
            continue
        # 该列上下最近的有效行
        good_rows = np.where(~bad[:, xs[0]])[0]
        for i in xs:
            up = good_rows[good_rows < j]
            dn = good_rows[good_rows > j]
            if up.size and dn.size:
                j0, j1 = up[-1], dn[0]
                t = (j - j0) / (j1 - j0)
                h[j, i] = h[j0, i] * (1 - t) + h[j1, i] * t
            elif up.size:
                h[j, i] = h[up[-1], i]
            elif dn.size:
                h[j, i] = h[dn[0], i]
            else:
                h[j, i] = float(np.median(h[~bad]))

    pad = np.pad(h, 1, mode="edge")
    win = np.lib.stride_tricks.sliding_window_view(pad, (3, 3))
    med = np.median(win.reshape(rows * cols, 9), axis=1).reshape(rows, cols)
    spike = np.abs(h - med) > 60.0
    n_spike = int(spike.sum())
    h[spike] = med[spike]

    return h, n_bad + n_spike


def resample_dem(mosaic, origin, w, h):
    """双线性重采样到目标网格。行 0 = 北边界。"""
    px_mosaic = mosaic.load()
    ox, oy = origin

    def sample(lon, lat):
        px = (lon_to_tile_x(lon, DEM_Z) - ox) * TILE - 0.5
        py = (lat_to_tile_y(lat, DEM_Z) - oy) * TILE - 0.5
        ix, iy = int(math.floor(px)), int(math.floor(py))
        fx, fy = px - ix, py - iy
        ix = max(0, min(mosaic.width - 1, ix))
        iy = max(0, min(mosaic.height - 1, iy))
        ix1 = min(mosaic.width - 1, ix + 1)
        iy1 = min(mosaic.height - 1, iy + 1)
        h00 = decode_terrarium(px_mosaic[ix, iy])
        h10 = decode_terrarium(px_mosaic[ix1, iy])
        h01 = decode_terrarium(px_mosaic[ix, iy1])
        h11 = decode_terrarium(px_mosaic[ix1, iy1])
        return (h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy)
                + h01 * (1 - fx) * fy + h11 * fx * fy)

    heights = []
    lo, hi = float("inf"), float("-inf")
    for j in range(h):
        lat = BBOX["north"] - (BBOX["north"] - BBOX["south"]) * j / (h - 1)
        for i in range(w):
            lon = BBOX["west"] + (BBOX["east"] - BBOX["west"]) * i / (w - 1)
            v = sample(lon, lat)
            heights.append(v)
            lo = min(lo, v)
            hi = max(hi, v)
    return heights, lo, hi

# ---------------- 点位表 ----------------

# 坐标来自 DEM 河谷校正：河谷约 700~730m，玉垒山约 790m
# elevation 留空由脚本按网格实际采样填入，保证与地形严格一致
SPOT_SEED = [
    # id, 名称, 经度, 纬度, 类别, 停留分钟, 必看, 标签, 无障碍
    ("yuzui",         "鱼嘴分水堤",   103.6078, 31.0038, "水利工程", 30, True,  ["必看", "核心", "拍照"], 3),
    ("feishayan",     "飞沙堰",       103.6081662, 31.0010593, "水利工程", 20, True,  ["必看", "核心"], 3),
    ("baopingkou",    "宝瓶口",       103.6105647, 31.0011322, "水利工程", 20, True,  ["必看", "核心", "拍照"], 2),
    ("fulongguan",    "伏龙观",       103.6105741, 31.000834, "人文古迹", 25, True,  ["必看", "人文"], 2),
    ("lidui",         "离堆公园",     103.6205, 30.9965, "园林",     30, False, ["休闲", "入口"], 4),
    ("anlan",         "安澜索桥",     103.6055439, 31.0078337, "桥梁",    15, True,  ["必看", "拥堵点", "体验"], 1),
    ("erwangmiao",    "二王庙",       103.6081189, 31.0083083, "人文古迹", 40, True,  ["必看", "人文", "台阶多"], 1),
    ("yuleiguan",     "玉垒关",       103.6095179, 31.004261, "关隘",     15, False, ["人文", "观景"], 2),
    ("yuleige",       "玉垒阁",       103.6123879, 31.0044967, "观景建筑", 30, True,  ["必看", "制高点", "全景"], 1),
    ("songmao",       "松茂古道",     103.6195, 31.0145, "古道",     25, False, ["徒步", "台阶多"], 1),
    ("chenghuang",    "城隍庙",       103.6133468, 31.0028751, "人文古迹", 20, False, ["人文"], 2),
    ("nanqiao",       "南桥",         103.613962, 30.999104, "桥梁",    15, True,  ["必看", "夜景", "拍照"], 4),
    ("guanxian",      "灌县古城",     103.6250, 30.9930, "街区",     60, False, ["餐饮", "休闲", "夜景"], 4),
    ("xijie",         "西街",         103.6258, 30.9945, "街区",     40, False, ["餐饮", "购物"], 3),
    ("xuahuamen",     "宣化门",       103.6206979, 30.9981733, "城门", 10, False, ["人文", "拍照"], 3),
    ("yangtianwo",    "仰天窝广场",   103.6275, 30.9938, "广场",     15, False, ["休闲", "入口"], 4),
    ("qinyanlou",     "秦堰楼(6号门)", 103.6074843, 31.0092614, "观景建筑", 20, False, ["制高点", "入口", "全景"], 2),
    ("yuleishan",     "玉垒山公园",   103.6180, 31.0105, "山林",     40, False, ["徒步", "自然"], 1),
    # 服务设施
    ("vc_south",      "游客中心(南门)", 103.6215, 30.9955, "游客中心", 10, False, ["服务", "咨询"], 5),
    ("vc_gate6",      "游客中心(6号门)", 103.5985, 31.0118, "游客中心", 10, False, ["服务", "咨询"], 5),
    ("shuttle_lidui", "观光车站(碑亭)", 103.6195, 30.9975, "交通设施", 5,  False, ["观光车", "候车"], 5),
    ("shuttle_yuzui", "观光车站(鱼嘴)", 103.6088, 31.0048, "交通设施", 5,  False, ["观光车", "候车"], 5),
    ("toilet_yuzui",  "公厕(鱼嘴)",   103.6095, 31.0052, "公共设施", 5,  False, ["厕所"], 5),
    ("toilet_erwang", "公厕(二王庙)", 103.608476, 31.006489, "公共设施", 5,  False, ["厕所"], 4),
    ("medical",       "医疗点(游客中心)", 103.6212, 30.9958, "医疗点", 10, False, ["医疗", "求助"], 5),
    ("rest_area",     "休憩区(飞沙堰)", 103.6128, 31.0028, "休憩",    10, False, ["休息", "遮阴"], 4),
]


def build_spots(heights, w, h):
    def sample_grid(lon, lat):
        i = round((lon - BBOX["west"]) / (BBOX["east"] - BBOX["west"]) * (w - 1))
        j = round((BBOX["north"] - lat) / (BBOX["north"] - BBOX["south"]) * (h - 1))
        i = max(0, min(w - 1, i))
        j = max(0, min(h - 1, j))
        return heights[j * w + i]

    spots = []
    for sid, name, lng, lat, cat, stay, must, tags, access in SPOT_SEED:
        spots.append({
            "id": sid,
            "name": name,
            "lng": lng,
            "lat": lat,
            "elevation": round(sample_grid(lng, lat), 1),
            "category": cat,
            "stayMinutes": stay,
            "mustVisit": must,
            "tags": tags,
            "accessibleLevel": access,
        })
    return spots


# ---------------- 主流程 ----------------

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    print("=== 都江堰 3D 地形数据构建 ===\n")
    print(f"bbox 经度 {BBOX['west']}~{BBOX['east']}  纬度 {BBOX['south']}~{BBOX['north']}")
    print(f"网格 {GRID_W}×{GRID_H}\n")

    print("[1/4] 卫星影像")
    imagery = build_imagery()
    im_path = OUT / "terrain.jpg"
    imagery.save(im_path, quality=94, subsampling=0, optimize=True, progressive=True)
    stale = OUT / "terrain.png"
    if stale.exists():
        stale.unlink()
    print(f"  已存 {im_path.name} ({im_path.stat().st_size // 1024} KB)")

    print("\n[2/4] DEM 高程")
    mosaic, origin = build_dem()
    print(f"  拼接 {mosaic.width}×{mosaic.height}")

    print("\n[3/4] 重采样到目标网格")
    heights, lo, hi = resample_dem(mosaic, origin, GRID_W, GRID_H)
    print(f"  重采样高程 {lo:.1f} ~ {hi:.1f} m")

    import numpy as np
    arr, fixed = repair_dem(np.array(heights, dtype=np.float32).reshape(GRID_H, GRID_W))
    lo, hi = float(arr.min()), float(arr.max())
    print(f"  修复异常/孤立点 {fixed} 个")
    print(f"  高程范围 {lo:.1f} ~ {hi:.1f} m  落差 {hi - lo:.1f} m")

    heights = arr.ravel().tolist()
    buf = struct.pack(f"<{len(heights)}f", *heights)
    (OUT / "heightmap.f32").write_bytes(buf)
    print(f"  已存 heightmap.f32 ({len(buf)} 字节)")

    print("\n[4/4] 点位表")
    spots = build_spots(heights, GRID_W, GRID_H)
    (OUT / "spots.json").write_text(
        json.dumps(spots, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"  已存 spots.json ({len(spots)} 个点位)")

    mid_lat = (BBOX["north"] + BBOX["south"]) / 2
    width_m = (BBOX["east"] - BBOX["west"]) * 111320 * math.cos(math.radians(mid_lat))
    height_m = (BBOX["north"] - BBOX["south"]) * 110540

    meta = {
        "name": "都江堰水利工程景区",
        "bbox": BBOX,
        "grid": {"width": GRID_W, "height": GRID_H},
        "elevation": {"min": round(lo, 2), "max": round(hi, 2)},
        "sceneSizeMeters": {
            "width": round(width_m),
            "height": round(height_m),
        },
        "imagery": {"width": imagery.width, "height": imagery.height},
        "sources": {
            "elevation": f"AWS Terrain Tiles terrarium z{DEM_Z}",
            "imagery": f"Esri World Imagery z{IMG_Z} (c) Esri, Maxar, Earthstar Geographics",
        },
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    (OUT / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print(f"\n=== 完成 ===")
    print(f"场景约 {meta['sceneSizeMeters']['width']}m × {meta['sceneSizeMeters']['height']}m")
    print(f"输出 {OUT}")


if __name__ == "__main__":
    main()
