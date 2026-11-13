"""
抓取研究区内的 OSM 道路与步道，输出精简 JSON 供三维场景叠加。

数据源 OpenStreetMap（ODbL），Overpass API。
坐标保留 6 位小数（约 0.1m），只保留渲染需要的字段。

用法：python tools/fetch_osm.py
产物：public/data/roads.json
"""

import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data" / "roads.json"

BBOX = {"west": 103.575, "east": 103.645, "south": 30.983, "north": 31.030}

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]

UA = {"User-Agent": "dujiangyan-3d-edu/0.1 (thesis project; contact: local)"}

QUERY = """
[out:json][timeout:180];
(
  way["highway"]({s},{w},{n},{e});
);
out body geom;
""".format(
    s=BBOX["south"], w=BBOX["west"], n=BBOX["north"], e=BBOX["east"]
)

# 只保留这些道路等级，其余（proposed / construction 等）丢弃
KEEP = {
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "unclassified", "residential", "living_street", "service",
    "pedestrian", "footway", "path", "steps", "cycleway", "track",
}


def fetch():
    data = urllib.parse.urlencode({"data": QUERY}).encode()
    last = None
    for host in ENDPOINTS:
        for attempt in range(2):
            try:
                req = urllib.request.Request(host, data=data, headers=UA)
                t = time.time()
                with urllib.request.urlopen(req, timeout=240) as r:
                    body = r.read()
                print(f"  {host} 返回 {len(body) // 1024} KB，用时 {time.time() - t:.0f}s")
                return json.loads(body)
            except Exception as e:  # noqa: BLE001
                last = e
                print(f"  {host} 第 {attempt + 1} 次失败：{e}")
                time.sleep(3)
    raise RuntimeError(f"OSM 抓取失败：{last}")


def main():
    print("=== 抓取 OSM 路网 ===")
    raw = fetch()
    roads = []
    skipped = 0
    for el in raw.get("elements", []):
        tags = el.get("tags", {})
        cls = tags.get("highway")
        if cls not in KEEP:
            skipped += 1
            continue
        geom = el.get("geometry") or []
        pts = [[round(p["lon"], 6), round(p["lat"], 6)] for p in geom if p]
        if len(pts) < 2:
            skipped += 1
            continue
        item = {"id": el.get("id"), "c": cls, "p": pts}
        # 保留 OSM 原生节点 ID，后续路由图可在路口按拓扑连接，避免只靠坐标猜测。
        node_ids = el.get("nodes") or []
        if len(node_ids) == len(pts):
            item["nodes"] = node_ids
        for key in ("foot", "access", "oneway", "surface", "bridge", "tunnel", "lit", "incline", "wheelchair"):
            if tags.get(key) is not None:
                item[key] = tags[key]
        name = tags.get("name")
        if name:
            item["n"] = name
        if tags.get("foot") == "no" or tags.get("access") == "private":
            item["x"] = 1
        roads.append(item)

    # 合并同名同等级相邻的断头：这里不做拓扑处理，直接按原始 way 渲染
    roads.sort(key=lambda r: r["c"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "bbox": BBOX,
                "source": "OpenStreetMap contributors (ODbL)",
                "count": len(roads),
                "roads": roads,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    size = OUT.stat().st_size
    print(f"  道路 {len(roads)} 条（跳过 {skipped}），{size // 1024} KB")
    print(f"  已存 {OUT.relative_to(ROOT)}")

    # 简单统计，便于判断数据完整度
    from collections import Counter

    c = Counter(r["c"] for r in roads)
    print("  等级分布：" + "  ".join(f"{k}={v}" for k, v in c.most_common()))


if __name__ == "__main__":
    main()
