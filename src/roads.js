/**
 * OSM 道路与步道叠加层
 *
 * 卫星影像上的道路在近景会被拉伸发糊，这里把 OpenStreetMap 的路网
 * 作为矢量面片铺在地形上（抬高 0.9m），保证公路、游步道、台阶都清晰可辨，
 * 也便于后续做路线规划时直接读路网走向。
 *
 * 数据：public/data/roads.json（tools/fetch_osm.py 生成，© OpenStreetMap contributors, ODbL）
 */

import * as THREE from "three";

const STYLE = {
  motorway: { w: 11, c: 0x6d7278 },
  trunk: { w: 10, c: 0x6d7278 },
  primary: { w: 9, c: 0x77736d },
  secondary: { w: 7.5, c: 0x817a70 },
  tertiary: { w: 6.5, c: 0x8b8274 },
  unclassified: { w: 5.5, c: 0x928878 },
  residential: { w: 4.8, c: 0x999080 },
  living_street: { w: 4.3, c: 0xa39783 },
  service: { w: 3.4, c: 0xa99b84 },
  pedestrian: { w: 4.6, c: 0xc3a46d },
  footway: { w: 2.8, c: 0xd2b581 },
  path: { w: 2.5, c: 0xc8a36a },
  steps: { w: 2.4, c: 0xe0c894 },
  cycleway: { w: 2.8, c: 0x9aa77a },
  track: { w: 2.5, c: 0xb09a72 },
};

const WALKING = new Set(["pedestrian", "footway", "path", "steps", "cycleway", "track"]);

/** 一段折线展开成带状面片，顶点按地形高程贴地 */
function appendWay(site, bucket, P, width, lift = 0) {
  // 把 OSM 控制点之间的长边按 4m 加密，沿 DEM 高程贴合路面，降低路面悬空与折面感。
  const dense = [];
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const steps = Math.max(1, Math.ceil(length / 4));
    for (let j = 0; j < steps; j++) {
      const t = j / steps;
      dense.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
    }
  }
  dense.push(P[P.length - 1]);
  P = dense;
  const n = P.length;
  const half = width / 2;
  const base = bucket.n;

  for (let i = 0; i < n; i++) {
    const prev = P[Math.max(0, i - 1)];
    const next = P[Math.min(n - 1, i + 1)];

    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    let nx = -dz;
    let nz = dx;
    let miter = 1;

    // 折点处用法线平均做斜接，宽度不塌陷
    if (i > 0 && i < n - 1) {
      const a = P[i - 1];
      const b = P[i];
      const c = P[i + 1];
      const l1 = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const l2 = Math.hypot(c.x - b.x, c.z - b.z) || 1;
      const n1x = -(b.z - a.z) / l1;
      const n1z = (b.x - a.x) / l1;
      const n2x = -(c.z - b.z) / l2;
      const n2z = (c.x - b.x) / l2;
      let ax = n1x + n2x;
      let az = n1z + n2z;
      const al = Math.hypot(ax, az);
      if (al > 1e-4) {
        ax /= al;
        az /= al;
        nx = ax;
        nz = az;
        miter = Math.min(2.5, 1 / Math.max(0.35, ax * n1x + az * n1z));
      }
    }

    const x = P[i].x;
    const z = P[i].z;
    const y = site.heightAt(x, z) + 0.9 + lift;
    bucket.pos.push(x + nx * half * miter, y, z + nz * half * miter);
    bucket.pos.push(x - nx * half * miter, y, z - nz * half * miter);
  }

  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2;
    bucket.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  bucket.n += n * 2;
}

export function buildRoads(site, data) {
  const group = new THREE.Group();
  group.name = "roads";

  // 场景边界：OSM 的 way 往往跨出 bbox，超出的点会被高程采样钳制，
  // 会在地形块外面吊出一条条悬空路面，所以先按边界切段。
  const halfW = site.meta.sceneSizeMeters.width / 2 - 2;
  const halfH = site.meta.sceneSizeMeters.height / 2 - 2;

  const buckets = new Map();
  const edgeBuckets = new Map();
  for (const r of data.roads) {
    if (r.x) continue;
    const st = STYLE[r.c];
    if (!st) continue;

    let b = buckets.get(r.c);
    if (!b) {
      b = { pos: [], idx: [], n: 0, style: st };
      buckets.set(r.c, b);
    }
    let edge = null;
    if (WALKING.has(r.c)) {
      edge = edgeBuckets.get(r.c);
      if (!edge) {
        edge = { pos: [], idx: [], n: 0, style: st };
        edgeBuckets.set(r.c, edge);
      }
    }

    const P = r.p.map(([lng, lat]) => site.toScene(lng, lat));
    let run = [];
    for (const p of P) {
      if (Math.abs(p.x) < halfW && Math.abs(p.z) < halfH) {
        run.push(p);
      } else {
        if (run.length >= 2) {
          if (edge) appendWay(site, edge, run, st.w + 1.5, 0.04);
          appendWay(site, b, run, st.w);
        }
        run = [];
      }
    }
    if (run.length >= 2) {
      if (edge) appendWay(site, edge, run, st.w + 1.5, 0.04);
      appendWay(site, b, run, st.w);
    }
  }

  const allBuckets = [
    ...[...edgeBuckets].map(([cls, bucket]) => [cls, bucket, true]),
    ...[...buckets].map(([cls, bucket]) => [cls, bucket, false]),
  ];
  for (const [cls, b, isEdge] of allBuckets) {
    if (!b.pos.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
    geo.setIndex(b.idx);
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(
      geo,
      // 用无光照材质：颜色不受太阳强度影响，远近都是一致的"地图路网"观感
      new THREE.MeshBasicMaterial({
        color: isEdge ? 0x6f685c : b.style.c,
        side: THREE.DoubleSide,
      }),
    );
    mesh.name = `road-${cls}`;
    mesh.renderOrder = isEdge ? 1.8 : 2;
    group.add(mesh);
  }

  return group;
}
