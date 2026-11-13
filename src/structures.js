/**
 * 都江堰核心水工建筑与沿江古建
 *
 * 尺度说明：场景 6.7km 宽、1:1 真实比例，单栋建筑只有几十米，
 * 因此这里做「体块 + 屋顶轮廓」的写意建模：远看有剪影，近看有层次，
 * 不做门窗级别的细节。
 *
 * 涵盖：
 *   鱼嘴分水堤（含观景亭）、飞沙堰、安澜索桥
 *   南桥（廊桥）、玉垒阁（八角塔）、二王庙、伏龙观
 */

import * as THREE from "three";

const MAT = {
  stone: new THREE.MeshStandardMaterial({ color: 0x9b978b, roughness: 0.95 }),
  stoneDark: new THREE.MeshStandardMaterial({ color: 0x736f64, roughness: 0.96 }),
  wall: new THREE.MeshStandardMaterial({ color: 0xa9593f, roughness: 0.86 }),
  wallLight: new THREE.MeshStandardMaterial({ color: 0xbfa27a, roughness: 0.9 }),
  wood: new THREE.MeshStandardMaterial({ color: 0x76452c, roughness: 0.82 }),
  deckWood: new THREE.MeshStandardMaterial({
    color: 0xa8834f,
    roughness: 0.92,
    side: THREE.DoubleSide,
  }),
  roof: new THREE.MeshStandardMaterial({
    color: 0x363d45,
    roughness: 0.72,
    side: THREE.DoubleSide,
  }),
  roofLight: new THREE.MeshStandardMaterial({
    color: 0x525d68,
    roughness: 0.78,
    side: THREE.DoubleSide,
  }),
  gold: new THREE.MeshStandardMaterial({
    color: 0xd7ab55,
    roughness: 0.38,
    metalness: 0.55,
  }),
  red: new THREE.MeshStandardMaterial({ color: 0x9c3a2b, roughness: 0.7 }),
  plaster: new THREE.MeshStandardMaterial({ color: 0xd3c3a0, roughness: 0.9 }),
  shadow: new THREE.MeshStandardMaterial({ color: 0x302d29, roughness: 0.95 }),
  tile: new THREE.MeshStandardMaterial({ color: 0x68737a, roughness: 0.82 }),
  cable: new THREE.MeshStandardMaterial({
    color: 0x2d2a26,
    roughness: 0.6,
    metalness: 0.35,
  }),
};

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  return m;
}

/**
 * 地形贴合的矩形台基。顶部保持水平供建筑落脚，侧墙底边按 DEM 逐段采样，
 * 把平台与坡地之间的落差做成石砌挡土墙，避免出现整块悬空托盘。
 * centerX/centerZ 与 childRotation 用于将台基定位到父组内的建筑局部坐标。
 */
function addGroundedPad(parent, site, {
  centerX = 0, centerZ = 0, width, depth, topY = 0,
  childRotation = 0, embed = 0.8,
}) {
  const halfW = width / 2;
  const halfD = depth / 2;
  const corners = [
    [-halfW, -halfD], [halfW, -halfD], [halfW, halfD], [-halfW, halfD],
  ];
  const toParentLocal = (dx, dz) => {
    const ca = Math.cos(childRotation), sa = Math.sin(childRotation);
    return [centerX + dx * ca + dz * sa, centerZ - dx * sa + dz * ca];
  };
  const toWorldLocal = (x, z) => {
    const cp = Math.cos(parent.rotation.y), sp = Math.sin(parent.rotation.y);
    return [x * cp + z * sp, -x * sp + z * cp];
  };
  const groundLocalY = (x, z) => {
    const [wx, wz] = toWorldLocal(x, z);
    const sampled = site.heightAt(parent.position.x + wx, parent.position.z + wz)
      - parent.position.y - embed;
    return Math.min(topY - 0.45, sampled);
  };

  const topPos = corners.map(([x, z]) => {
    const [lx, lz] = toParentLocal(x, z);
    return [lx, topY, lz];
  });
  const topGeo = new THREE.BufferGeometry();
  topGeo.setAttribute("position", new THREE.Float32BufferAttribute(topPos.flat(), 3));
  topGeo.setIndex([0, 2, 1, 0, 3, 2]);
  topGeo.computeVertexNormals();
  parent.add(new THREE.Mesh(topGeo, MAT.stone));

  const sidePos = [];
  const sideIdx = [];
  const segments = Math.max(2, Math.ceil(Math.max(width, depth) / 4));
  for (let edge = 0; edge < 4; edge++) {
    const a = corners[edge], b = corners[(edge + 1) % 4];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const dx = a[0] + (b[0] - a[0]) * t;
      const dz = a[1] + (b[1] - a[1]) * t;
      const [x, z] = toParentLocal(dx, dz);
      sidePos.push(x, topY, z, x, groundLocalY(x, z), z);
    }
    const base = edge * (segments + 1) * 2;
    for (let i = 0; i < segments; i++) {
      const p = base + i * 2;
      sideIdx.push(p, p + 2, p + 1, p + 2, p + 3, p + 1);
    }
  }
  const sideGeo = new THREE.BufferGeometry();
  sideGeo.setAttribute("position", new THREE.Float32BufferAttribute(sidePos, 3));
  sideGeo.setIndex(sideIdx);
  sideGeo.computeVertexNormals();
  parent.add(new THREE.Mesh(sideGeo, MAT.stoneDark));
}

/** 八边形塔基的贴地石砌裙墙，保留原塔基轮廓并填合坡面高差。 */
function addGroundedOctagonSkirt(parent, site, radius, topY = 0, embed = 0.8) {
  const pos = [];
  const idx = [];
  const count = 8;
  const ca = Math.cos(parent.rotation.y), sa = Math.sin(parent.rotation.y);
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const x = Math.sin(a) * radius;
    const z = Math.cos(a) * radius;
    const wx = x * ca + z * sa;
    const wz = -x * sa + z * ca;
    const sampled = site.heightAt(parent.position.x + wx, parent.position.z + wz)
      - parent.position.y - embed;
    const bottomY = Math.min(topY - 0.45, sampled);
    pos.push(x, topY, z, x, bottomY, z);
  }
  for (let i = 0; i < count; i++) {
    const a = i * 2, b = ((i + 1) % count) * 2;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  parent.add(new THREE.Mesh(geo, MAT.stoneDark));
}

/** 四坡屋顶（庑殿顶），屋脊沿 X 轴 */
function hipRoof(w, d, h) {
  const W = w / 2;
  const D = d / 2;
  const ridge = Math.max(w * 0.14, (w - d) / 2);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        -W, 0, -D,
        W, 0, -D,
        W, 0, D,
        -W, 0, D,
        -ridge, h, 0,
        ridge, h, 0,
      ],
      3,
    ),
  );
  geo.setIndex([0, 1, 5, 0, 5, 4, 2, 3, 4, 2, 4, 5, 1, 2, 5, 3, 0, 4]);
  geo.computeVertexNormals();
  return geo;
}

/** 双坡屋顶（悬山顶），屋脊沿 X 轴 */
function gableRoof(w, d, h) {
  const W = w / 2;
  const D = d / 2;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        -W, 0, -D,
        W, 0, -D,
        W, 0, D,
        -W, 0, D,
        -W, h, 0,
        W, h, 0,
      ],
      3,
    ),
  );
  geo.setIndex([0, 1, 5, 0, 5, 4, 2, 3, 4, 2, 4, 5, 0, 4, 3, 1, 2, 5]);
  geo.computeVertexNormals();
  return geo;
}

/** 屋脊、檐口与瓦垄，让屋顶从大色块变成可读的传统瓦作轮廓。 */
function addRoofTrim(group, w, d, roofH, y, hip = true) {
  const ridge = hip ? Math.max(w * 0.14, (w - d) / 2) : w / 2;
  const ridgeLen = Math.max(2, ridge * 2);
  group.add(box(ridgeLen + 2.4, 0.65, 0.9, MAT.tile, 0, y + roofH + 0.18, 0));
  for (const z of [-d / 2, d / 2]) {
    group.add(box(w + 1.2, 0.62, 0.72, MAT.wood, 0, y + 0.05, z));
  }
  if (hip) {
    for (const x of [-1, 1]) {
      for (const z of [-1, 1]) {
        const pts = [
          new THREE.Vector3(x * ridge, y + roofH + 0.2, 0),
          new THREE.Vector3(x * (w / 2 - 0.3), y + roofH * 0.5, z * (d / 4)),
          new THREE.Vector3(x * (w / 2 - 0.3), y + 0.16, z * (d / 2 - 0.25)),
        ];
        group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 8, 0.28, 5), MAT.tile));
      }
    }
  }
  // 瓦垄沿坡面从正脊延伸至檐口，间距按建筑尺度递增。
  const ribCount = Math.max(5, Math.round(ridgeLen / 3.8));
  for (let i = 0; i <= ribCount; i++) {
    const x = -ridge + (ridgeLen * i) / ribCount;
    if (Math.abs(x) > w / 2 - 0.5) continue;
    for (const side of [-1, 1]) {
      const pts = [
        new THREE.Vector3(x, y + roofH + 0.28, 0),
        new THREE.Vector3(x, y + roofH * 0.72, side * d * 0.14),
        new THREE.Vector3(x, y + roofH * 0.38, side * d * 0.31),
        new THREE.Vector3(x, y + 0.18, side * (d / 2 - 0.3)),
      ];
      group.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.055, 4), MAT.tile));
    }
  }
}

/** 单栋殿宇：台基 + 墙体 + 廊柱 + 庑殿顶 */
function makeHall(w, d, bodyH, roofH) {
  const g = new THREE.Group();

  g.add(box(w + 9, 1.8, d + 9, MAT.stoneDark, 0, 0.9, 0));
  g.add(box(w + 5, 0.55, d + 5, MAT.stone, 0, 1.95, 0));
  g.add(box(w, bodyH, d, MAT.wall, 0, 1.8 + bodyH / 2, 0));
  // 檐下木枋
  g.add(box(w + 1.6, 1.2, d + 1.6, MAT.wood, 0, 1.8 + bodyH - 0.6, 0));

  // 环殿柱廊与朱漆柱础
  const cols = Math.max(3, Math.round(w / 7));
  for (let i = 0; i < cols; i++) {
    const x = -w / 2 + (w / (cols - 1)) * i;
    for (const zSign of [-1, 1]) {
      const z = zSign * (d / 2 + 1.15);
      g.add(box(0.82, bodyH + 0.25, 0.82, MAT.red, x, 1.8 + bodyH / 2, z));
      g.add(box(1.12, 0.55, 1.12, MAT.stone, x, 2.05, z));
    }
  }
  const sideCols = Math.max(2, Math.round(d / 6));
  for (let i = 1; i < sideCols; i++) {
    const z = -d / 2 + (d / sideCols) * i;
    for (const xSign of [-1, 1]) {
      g.add(box(0.78, bodyH, 0.78, MAT.wood, xSign * (w / 2 + 0.55), 1.8 + bodyH / 2, z));
    }
  }

  // 正立面门扇与成组格窗，给近景提供可辨识的尺度参照。
  const doorW = w * 0.15;
  const doorH = bodyH * 0.66;
  const doorY = 1.8 + bodyH * 0.36;
  const doorZ = d / 2 + 0.43;
  g.add(box(doorW * 1.27, doorH * 1.09, 0.34, MAT.wood, 0, doorY, d / 2 + 0.22));
  g.add(box(doorW, doorH, 0.16, MAT.red, 0, doorY, doorZ));
  // 两扇门的抱框、横档与门钉，避免正立面只剩一块红色矩形。
  for (const side of [-1, 1]) {
    g.add(box(0.2, doorH * 0.94, 0.12, MAT.gold, side * doorW * 0.43, doorY, doorZ + 0.1));
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), MAT.gold);
    handle.position.set(side * doorW * 0.17, doorY, doorZ + 0.2);
    g.add(handle);
  }
  for (let i = 0; i < 3; i++) {
    const y = doorY - doorH * 0.32 + (doorH * 0.64 * i) / 2;
    g.add(box(doorW * 0.82, 0.16, 0.13, MAT.wood, 0, y, doorZ + 0.1));
  }
  const windowCount = Math.max(2, Math.floor(w / 9));
  for (let i = 0; i < windowCount; i++) {
    const x = -w * 0.38 + (w * 0.76 * i) / Math.max(1, windowCount - 1);
    if (Math.abs(x) < w * 0.14) continue;
    const wy = 1.8 + bodyH * 0.6;
    const ww = Math.min(2.6, w / (windowCount * 1.8));
    g.add(box(ww, bodyH * 0.3, 0.25, MAT.shadow, x, wy, d / 2 + 0.2));
    g.add(box(ww + 0.48, 0.38, 0.42, MAT.plaster, x, wy + bodyH * 0.17, d / 2 + 0.24));
    g.add(box(0.22, bodyH * 0.3, 0.12, MAT.wood, x, wy, d / 2 + 0.4));
    g.add(box(ww, 0.2, 0.12, MAT.wood, x, wy, d / 2 + 0.4));
  }

  // 台阶和石栏杆
  const stairCount = 4;
  for (let i = 0; i < stairCount; i++) {
    g.add(box(w * 0.32 + i * 1.8, 0.35, 1.15, MAT.stone, 0, 0.22 + i * 0.38, d / 2 + 4.2 + i * 0.95));
  }
  for (const xSign of [-1, 1]) {
    g.add(box(0.62, 1.25, 4.1, MAT.stone, xSign * (w * 0.19 + 1), 1.2, d / 2 + 5.3));
  }

  const roofW = w + 8, roofD = d + 8;
  const roofY = 1.8 + bodyH;
  const roof = new THREE.Mesh(hipRoof(roofW, roofD, roofH), MAT.roof);
  roof.position.y = roofY;
  g.add(roof);
  addRoofTrim(g, roofW, roofD, roofH, roofY, true);

  // 柱头斗拱与额枋：把朱柱、墙体和深色屋檐连成连续的木构层次。
  const eaveY = roofY - 0.38;
  for (let i = 0; i < cols; i++) {
    const x = -w / 2 + (w / (cols - 1)) * i;
    for (const side of [-1, 1]) {
      const z = side * (d / 2 + 1.15);
      g.add(box(1.65, 0.34, 1.25, MAT.wood, x, eaveY, z));
      g.add(box(0.72, 0.42, 0.92, MAT.red, x, eaveY - 0.34, z));
    }
  }

  return g;
}

/** 带拱券门洞、城墙基座和木构门楼的传统城门。 */
function makeGate(w, h, d = 9) {
  const g = new THREE.Group();
  const openingW = Math.min(w * 0.36, h * 0.94);
  const openingH = h * 0.76;
  const springY = openingH - openingW / 2;

  // 城门墙身以真正的拱形孔洞挤出，门洞前后贯通，路面可连续通过。
  const wallShape = new THREE.Shape();
  wallShape.moveTo(-w / 2, 0);
  wallShape.lineTo(w / 2, 0);
  wallShape.lineTo(w / 2, h);
  wallShape.lineTo(-w / 2, h);
  wallShape.closePath();
  const portal = new THREE.Path();
  portal.moveTo(-openingW / 2, -0.1);
  portal.lineTo(-openingW / 2, springY);
  portal.absarc(0, springY, openingW / 2, Math.PI, 0, true);
  portal.lineTo(openingW / 2, -0.1);
  portal.closePath();
  wallShape.holes.push(portal);
  const wallGeo = new THREE.ExtrudeGeometry(wallShape, {
    depth: d,
    bevelEnabled: true,
    bevelSegments: 1,
    steps: 1,
    bevelSize: 0.12,
    bevelThickness: 0.1,
  });
  wallGeo.translate(0, 0, -d / 2);
  g.add(new THREE.Mesh(wallGeo, MAT.wallLight));

  // 石砌台基与勒脚线。
  g.add(box(w + 2.4, 0.9, d + 2.4, MAT.stoneDark, 0, 0.35, 0));
  g.add(box(w + 0.8, 0.42, d + 0.8, MAT.stone, 0, 1.0, 0));
  g.add(box(w + 0.6, 0.58, d + 0.6, MAT.stoneDark, 0, h - 0.32, 0));

  // 拱券由分块券石围合，前后两面均有门框收边。
  const archSegments = 13;
  const archRadius = openingW / 2;
  for (const face of [-1, 1]) {
    for (let i = 0; i < archSegments; i++) {
      const a = Math.PI - (Math.PI * i) / (archSegments - 1);
      const voussoir = box(archRadius * 0.38, 0.62, 0.42, i % 2 ? MAT.stone : MAT.plaster);
      voussoir.position.set(
        Math.cos(a) * (archRadius + 0.24),
        springY + Math.sin(a) * (archRadius + 0.24),
        face * (d / 2 + 0.13),
      );
      voussoir.rotation.z = a + Math.PI / 2;
      g.add(voussoir);
    }
    for (const side of [-1, 1]) {
      g.add(box(0.56, springY, 0.38, MAT.stone, side * (openingW / 2 + 0.22), springY / 2, face * (d / 2 + 0.13)));
    }
  }

  // 门洞内壁与石板路面，削弱模型像贴在地表上的剪纸感。
  g.add(box(openingW - 0.65, 0.18, d + 0.8, MAT.stoneDark, 0, 0.12, 0));
  for (let i = 0; i < 4; i++) {
    const stepD = 1.25;
    const step = box(openingW + 1.2 + i * 0.7, 0.3, stepD + 0.25, MAT.stone,
      0, 0.22 + i * 0.28, d / 2 + 0.55 + i * stepD);
    g.add(step);
  }
  for (const side of [-1, 1]) {
    const bollard = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.48, 1.25, 8), MAT.stoneDark);
    bollard.position.set(side * (openingW / 2 + 1.1), 0.62, d / 2 + 5.8);
    g.add(bollard);
  }

  // 城墙垛口只布置在两翼，保持门洞上方完整承托门楼。
  const merlonCount = Math.max(4, Math.floor((w - openingW - 4) / 2.4));
  for (const side of [-1, 1]) {
    const wingW = (w - openingW) / 2 - 1.3;
    for (let i = 0; i < merlonCount; i++) {
      const x = side * (openingW / 2 + 1.5 + ((i + 0.5) / merlonCount) * wingW);
      g.add(box(1.15, 0.85, d * 0.72, MAT.stone, x, h + 0.35, 0));
      g.add(box(0.5, 0.22, d * 0.8, MAT.plaster, x, h - 0.22, 0));
    }
  }

  // 上层门楼采用朱柱、阑额与栏杆围合的开敞木构。
  const towerW = w * 0.66;
  const towerD = d + 3.8;
  const floorY = h + 0.65;
  g.add(box(towerW + 3.2, 0.85, towerD + 2.8, MAT.stoneDark, 0, floorY, 0));
  g.add(box(towerW + 1.8, 0.38, towerD + 1.6, MAT.red, 0, floorY + 0.52, 0));
  const columnH = Math.max(3.7, h * 0.44);
  const colX = towerW / 2 - 1.4;
  const colZ = towerD / 2 - 1.25;
  for (const x of [-colX, colX]) {
    for (const z of [-colZ, colZ]) {
      g.add(box(1.35, 0.5, 1.35, MAT.stone, x, floorY + 0.9, z));
      g.add(box(0.9, columnH, 0.9, MAT.red, x, floorY + 1.15 + columnH / 2, z));
      g.add(box(1.2, 0.32, 1.2, MAT.gold, x, floorY + 1.3, z));
    }
  }
  const beamY = floorY + 1.15 + columnH;
  g.add(box(towerW + 1.5, 0.95, 1.1, MAT.wood, 0, beamY, colZ));
  g.add(box(towerW + 1.5, 0.95, 1.1, MAT.wood, 0, beamY, -colZ));
  g.add(box(1.1, 0.95, towerD + 1.1, MAT.wood, colX, beamY, 0));
  g.add(box(1.1, 0.95, towerD + 1.1, MAT.wood, -colX, beamY, 0));

  // 栏板和细木格栅围住楼层边缘。
  const railY = floorY + 1.55;
  for (const side of [-1, 1]) {
    const z = side * (towerD / 2 - 0.55);
    g.add(box(towerW - 2.4, 0.42, 0.36, MAT.red, 0, railY, z));
    g.add(box(towerW - 2.4, 0.34, 0.42, MAT.wood, 0, railY + 1.05, z));
    for (let i = 0; i <= 10; i++) {
      const x = -colX + (2 * colX * i) / 10;
      g.add(box(0.18, 0.9, 0.22, MAT.wood, x, railY + 0.53, z));
    }
  }

  // 门楼正面悬挂匾额，三层瓦檐和椽子增强屋顶轮廓。
  const signZ = towerD / 2 + 0.4;
  g.add(box(Math.min(12, towerW * 0.55), 1.5, 0.38, MAT.gold, 0, floorY + 2.65, signZ));
  g.add(box(Math.min(11.2, towerW * 0.51), 1.08, 0.24, MAT.red, 0, floorY + 2.65, signZ + 0.23));
  const roofW = towerW + 8, roofD = towerD + 6, roofH = Math.max(3.4, h * 0.38);
  const roofY = beamY + 0.65;
  const roof = new THREE.Mesh(hipRoof(roofW, roofD, roofH), MAT.roof);
  roof.position.y = roofY;
  g.add(roof);
  addRoofTrim(g, roofW, roofD, roofH, roofY, true);
  for (const x of [-roofW / 2 + 1, roofW / 2 - 1]) {
    const finial = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.25, 5), MAT.gold);
    finial.position.set(x, roofY + roofH + 0.8, 0);
    finial.rotation.z = x < 0 ? -0.25 : 0.25;
    g.add(finial);
  }
  return g;
}

/** 八角楼阁式塔（玉垒阁） */
function makePagoda(tiers = 5, radius = 10, tierH = 6.5) {
  const g = new THREE.Group();

  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(radius * 1.85, radius * 2.1, 4, 8),
    MAT.stoneDark,
  );
  plinth.position.y = 2;
  g.add(plinth);

  let y = 4;
  for (let i = 0; i < tiers; i++) {
    const r = radius * (1 - i * 0.055);

    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(r, r, tierH, 8),
      MAT.wall,
    );
    body.position.y = y + tierH / 2;
    g.add(body);

    // 八面窗格与抱框：每层立面都有深色窗洞、朱色窗棂和浅色窗楣。
    for (let face = 0; face < 8; face++) {
      const a = (face * Math.PI) / 4 + Math.PI / 8;
      const panelW = r * 0.48;
      const panelH = tierH * 0.4;
      const panel = box(panelW, panelH, 0.22, MAT.shadow);
      panel.position.set(Math.sin(a) * (r + 0.04), y + tierH * 0.56, Math.cos(a) * (r + 0.04));
      panel.rotation.y = a;
      g.add(panel);
      const lattice = box(0.18, panelH * 0.9, 0.12, MAT.red);
      lattice.position.set(Math.sin(a) * (r + 0.18), y + tierH * 0.56, Math.cos(a) * (r + 0.18));
      lattice.rotation.y = a;
      g.add(lattice);
      const sill = box(panelW + 0.7, 0.34, 0.5, MAT.plaster);
      sill.position.set(Math.sin(a) * (r + 0.11), y + tierH * 0.34, Math.cos(a) * (r + 0.11));
      sill.rotation.y = a;
      g.add(sill);
    }

    // 平座栏杆
    const rail = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 1.1, r * 1.1, 0.9, 8, 1, true),
      MAT.wood,
    );
    rail.position.y = y + tierH - 0.4;
    g.add(rail);
    const railPosts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.48, 1.2, 0.48), MAT.wood, 16);
    const postMatrix = new THREE.Matrix4();
    for (let p = 0; p < 16; p++) {
      const a = (p * Math.PI) / 8;
      postMatrix.makeTranslation(Math.sin(a) * r * 1.06, y + tierH - 0.2, Math.cos(a) * r * 1.06);
      railPosts.setMatrixAt(p, postMatrix);
    }
    g.add(railPosts);

    // 挑檐
    const roofH = tierH * 0.6;
    const eave = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 0.6, r * 1.5, roofH, 8),
      MAT.roof,
    );
    eave.position.y = y + tierH + roofH / 2;
    g.add(eave);
    const cornice = new THREE.Mesh(
      new THREE.CylinderGeometry(r * 1.54, r * 1.54, 0.34, 8),
      MAT.tile,
    );
    cornice.position.y = y + tierH + 0.08;
    g.add(cornice);
    // 八个檐角略微上翘，配小型铜色铃饰。
    for (let corner = 0; corner < 8; corner++) {
      const a = (corner * Math.PI) / 4;
      const finial = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.45, 5), MAT.gold);
      finial.position.set(Math.sin(a) * r * 1.45, y + tierH + roofH * 0.22, Math.cos(a) * r * 1.45);
      finial.rotation.z = Math.cos(a) * -0.28;
      finial.rotation.x = Math.sin(a) * 0.28;
      g.add(finial);
    }

    y += tierH + roofH * 0.55;
  }

  const spire = new THREE.Mesh(
    new THREE.ConeGeometry(radius * 0.27, radius * 1.7, 8),
    MAT.gold,
  );
  spire.position.y = y + radius * 0.85;
  g.add(spire);

  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(radius * 0.22, 12, 10),
    MAT.gold,
  );
  ball.position.y = y + radius * 1.9;
  g.add(ball);

  return g;
}

/**
 * 鱼嘴分水堤：船形石堤
 * 局部坐标：Z 轴指向下游，堤首（鱼嘴）在 -Z 端
 */
function makeFishMouthLevee(length, width, height) {
  // [沿堤位置 -0.5..0.5, 半宽比例]
  const profile = [
    [-0.5, 0.05],
    [-0.45, 0.24],
    [-0.36, 0.46],
    [-0.22, 0.66],
    [-0.04, 0.79],
    [0.16, 0.86],
    [0.36, 0.88],
    [0.5, 0.86],
  ];

  const pos = [];
  const idx = [];
  const n = profile.length;

  // 每站 4 个点：左上、右上、左下、右下
  for (const [t, hwRatio] of profile) {
    const z = t * length;
    const hw = (hwRatio * width) / 2;
    pos.push(-hw, height, z);
    pos.push(hw, height, z);
    pos.push(-hw, -4, z);
    pos.push(hw, -4, z);
  }

  for (let i = 0; i < n - 1; i++) {
    const a = i * 4;
    const b = a + 4;
    // 顶面
    idx.push(a, a + 1, b, a + 1, b + 1, b);
    // 西侧
    idx.push(a, b, a + 2, a + 2, b, b + 2);
    // 东侧
    idx.push(a + 1, a + 3, b + 1, a + 3, b + 3, b + 1);
  }
  // 首尾封口
  idx.push(0, 2, 1, 1, 2, 3);
  const last = (n - 1) * 4;
  idx.push(last, last + 1, last + 2, last + 1, last + 3, last + 2);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const g = new THREE.Group();
  const mesh = new THREE.Mesh(geo, MAT.stone);
  g.add(mesh);

  // 堤顶石铺装 + 行道树（远看是堤上的绿带）
  g.add(box(width * 0.7, 0.8, length * 0.94, MAT.stoneDark, 0, height + 0.2, 0));
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5c4630, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x39552f, roughness: 1 });
  const treeCount = 11;
  for (let i = 0; i < treeCount; i++) {
    const t = -0.42 + (0.84 * i) / (treeCount - 1);
    const tw = width * (0.48 - Math.abs(t) * 0.16);
    for (const side of [-1, 1]) {
      const tree = new THREE.Group();
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 3, 6), trunkMat);
      trunk.position.y = 1.5;
      tree.add(trunk);
      const crown = new THREE.Mesh(new THREE.SphereGeometry(3.4, 8, 6), leafMat);
      crown.position.y = 5.2;
      crown.scale.y = 1.25;
      tree.add(crown);
      tree.position.set(side * tw, height + 0.6, t * length);
      g.add(tree);
    }
  }

  // 鱼嘴处小观景亭
  const pav = new THREE.Group();
  pav.add(box(9, 0.9, 9, MAT.stoneDark, 0, 0.45, 0));
  for (const [sx, sz] of [
    [-3.6, -3.6],
    [3.6, -3.6],
    [-3.6, 3.6],
    [3.6, 3.6],
  ]) {
    pav.add(box(0.7, 6, 0.7, MAT.red, sx, 3.9, sz));
  }
  const pavRoof = new THREE.Mesh(hipRoof(13, 13, 3.6), MAT.roof);
  pavRoof.position.y = 6.9;
  pav.add(pavRoof);
  pav.position.set(0, height, -length * 0.3);
  g.add(pav);

  return g;
}

/** 飞沙堰：梯形断面的低堰 */
function makeWeir(length, baseW, crestW, height) {
  const shape = new THREE.Shape();
  shape.moveTo(-baseW / 2, 0);
  shape.lineTo(baseW / 2, 0);
  shape.lineTo(crestW / 2, height);
  shape.lineTo(-crestW / 2, height);
  shape.closePath();

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: length,
    bevelEnabled: false,
  });
  geo.translate(0, 0, -length / 2);
  geo.rotateY(Math.PI / 2); // 断面在 ZY 平面，堰体沿 X 展开

  const g = new THREE.Group();
  g.add(new THREE.Mesh(geo, MAT.stoneDark));
  // 堰顶溢流面
  const crest = box(length * 0.96, 0.5, crestW * 0.8, MAT.stone, 0, height + 0.25, 0);
  g.add(crest);
  return g;
}

/** 悬索桥（安澜索桥） */
function makeSuspensionBridge(len, endYs, deckW = 4.2, context = null) {
  const g = new THREE.Group();
  const sag = 6.5;
  const segments = 48;
  // 桥面抬高，避免主索下挠后没入水面
  const ya = endYs[0] + 7;
  const yb = endYs[1] + 7;

  const deckY = (t) => {
    // t: 0..1，线性连接两端 + 抛物线下垂
    const chord = ya + (yb - ya) * t;
    return chord - sag * Math.sin(Math.PI * t);
  };
  // 安澜索桥是"索随桥走"：主索贴着桥面上方 1.4m，而不是架在高塔顶
  const railY = (t) => deckY(t) + 1.35;

  // 桥面
  const pos = [];
  const idx = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = -len / 2 + len * t;
    const y = deckY(t);
    pos.push(x, y, -deckW / 2, x, y, deckW / 2);
  }
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const deckGeo = new THREE.BufferGeometry();
  deckGeo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  deckGeo.setIndex(idx);
  deckGeo.computeVertexNormals();
  g.add(new THREE.Mesh(deckGeo, MAT.deckWood));

  // 两侧木边梁，桥面不是一块薄片
  for (const side of [-1, 1]) {
    const bp = [];
    const bi = [];
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const x = -len / 2 + len * t;
      const y = deckY(t);
      bp.push(x, y + 0.06, (side * deckW) / 2, x, y - 0.5, (side * deckW) / 2);
    }
    for (let i = 0; i < segments; i++) {
      const a = i * 2;
      bi.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute("position", new THREE.Float32BufferAttribute(bp, 3));
    bg.setIndex(bi);
    bg.computeVertexNormals();
    g.add(new THREE.Mesh(bg, MAT.deckWood));
  }

  // 主索 + 扶手索 + 吊杆
  const cablePts = (side, dy) =>
    Array.from({ length: segments + 1 }, (_, i) => {
      const t = i / segments;
      return new THREE.Vector3(
        -len / 2 + len * t,
        railY(t) + dy,
        (side * (deckW + 0.1)) / 2,
      );
    });

  for (const side of [-1, 1]) {
    // 承重主索
    g.add(
      new THREE.Mesh(
        new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3(cablePts(side, 0.12)),
          segments,
          0.13,
          5,
        ),
        MAT.cable,
      ),
    );
    // 中道扶手索
    g.add(
      new THREE.Mesh(
        new THREE.TubeGeometry(
          new THREE.CatmullRomCurve3(cablePts(side, -0.55)),
          segments,
          0.07,
          4,
        ),
        MAT.cable,
      ),
    );
  }

  // 吊杆：用实例化细杆，远处不会退化成一条像素线
  const step = 1.15;
  const n = Math.max(8, Math.floor(len / step));
  const hangerGeo = new THREE.BoxGeometry(0.075, 1, 0.075);
  const hangers = new THREE.InstancedMesh(hangerGeo, MAT.cable, n * 2);
  const mtx = new THREE.Matrix4();
  let hi = 0;
  for (const side of [-1, 1]) {
    for (let i = 1; i < n; i++) {
      const t = i / n;
      const x = -len / 2 + len * t;
      const top = railY(t) + 0.12;
      const bot = deckY(t);
      mtx.makeScale(1, Math.max(0.2, top - bot), 1);
      mtx.setPosition(x, (top + bot) / 2, (side * (deckW + 0.1)) / 2);
      hangers.setMatrixAt(hi++, mtx);
    }
  }
  hangers.count = hi;
  g.add(hangers);

  // 桥塔（木构门架）+ 石砌桥台
  for (const x of [-len / 2, len / 2]) {
    const groundY = x < 0 ? endYs[0] : endYs[1];
    const deckEndY = x < 0 ? ya : yb;
    const top = deckEndY + 6.3;
    const postH = top - groundY + 3;

    for (const side of [-1, 1]) {
      const z = side * (deckW / 2 + 1.5);
      g.add(box(1.5, postH, 1.5, MAT.wood, x, groundY - 3 + postH / 2, z));
      // 柱脚石
      g.add(box(2.9, 1.8, 2.9, MAT.stoneDark, x, groundY - 0.2, z));
    }
    // 上下两道横梁
    g.add(box(1.1, 0.9, deckW + 5.2, MAT.wood, x, deckEndY + 1.5, 0));
    g.add(box(1.1, 0.9, deckW + 5.2, MAT.wood, x, top - 0.9, 0));
    // 塔顶小瓦顶
    const capRoof = new THREE.Mesh(hipRoof(6.4, deckW + 5.6, 2.1), MAT.roof);
    capRoof.position.set(x, top + 0.1, 0);
    g.add(capRoof);

    // 桥台：从地面砌到桥面，托住桥头
    const abH = Math.max(3, deckEndY - groundY + 2.4);
    const abY = groundY - 2 + abH / 2;
    g.add(box(9, abH, deckW + 4.6, MAT.stoneDark, x + (x < 0 ? -3 : 3), abY, 0));
  }

  // 两侧桥头接地台阶，连接桥面与河岸步道。
  if (context) {
    for (const end of [-1, 1]) {
      const deckEnd = end < 0 ? ya : yb;
      const run = 10, steps = 7;
      for (let i = 0; i < steps; i++) {
        const t = (i + 1) / steps;
        const x = end * (len / 2 + run * (1 - (i + 0.5) / steps));
        const ground = context.groundAt(x) - context.avgY;
        const top = ground + (deckEnd - ground) * t;
        const step = box(run / steps + 0.22, Math.max(0.5, top - ground + 0.3), deckW + 4.8, MAT.stone, x, (top + ground - 0.3) / 2, 0);
        g.add(step);
      }
    }
  }

  return g;
}

/** 廊桥（南桥） */
function makeGalleryBridge(len, endYs, width = 11, context = null) {
  const g = new THREE.Group();
  const deckTop = (endYs[0] + endYs[1]) / 2 + 4.5;
  const supportX = [-len / 3, 0, len / 3];
  const groundAt = (localX) => {
    if (!context) return -7;
    const { site, p1, p2, avgY } = context;
    const t = localX / len;
    return site.heightAt(
      (p1.x + p2.x) / 2 + (p2.x - p1.x) * t,
      (p1.z + p2.z) / 2 + (p2.z - p1.z) * t,
    ) - avgY;
  };

  // 桥台从两岸地面连续托到桥面，底部埋入 DEM，避免桥头悬空。
  for (const end of [-1, 1]) {
    const x = end * (len / 2 - 2.5);
    const ground = groundAt(end * len / 2);
    const h = Math.max(1.6, deckTop - ground + 0.8);
    const abutment = new THREE.Mesh(
      new THREE.BoxGeometry(10, h, width + 4.2),
      MAT.stoneDark,
    );
    abutment.position.set(x, (deckTop + ground - 0.8) / 2, 0);
    g.add(abutment);

    const run = 14;
    const nSteps = 8;
    for (let i = 0; i < nSteps; i++) {
      const t = (i + 1) / nSteps;
      const stairX = end * (len / 2 + run * (1 - (i + 0.5) / nSteps));
      const groundY = groundAt(stairX);
      const topY = groundY + (deckTop - groundY) * t;
      const bottomY = groundY - 0.35;
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(run / nSteps + 0.22, Math.max(0.5, topY - bottomY), width + 3.2),
        i % 2 ? MAT.stone : MAT.stoneDark,
      );
      step.position.set(stairX, (topY + bottomY) / 2, 0);
      g.add(step);
    }
    // 桥头石栏收口和入口压顶
    for (const side of [-1, 1]) {
      g.add(box(2.2, 1.15, 1.05, MAT.stone, end * (len / 2 - 1.2), deckTop + 0.58, side * (width / 2 + 1.2)));
    }
  }

  // 桥墩按每个位置的 DEM 高程独立落地，顶部与桥底横梁咬合。
  for (const x of supportX) {
    const ground = groundAt(x);
    const bottom = ground - 0.65;
    const pierTop = deckTop - 1.25;
    const pierH = Math.max(1.4, pierTop - bottom);
    const pier = new THREE.Mesh(
      new THREE.CylinderGeometry(1.9, 2.65, pierH, 10),
      MAT.stoneDark,
    );
    pier.position.set(x, (pierTop + bottom) / 2, 0);
    g.add(pier);
    const footing = new THREE.Mesh(new THREE.BoxGeometry(6.2, 1.15, width + 2.4), MAT.stone);
    footing.position.set(x, ground - 0.15, 0);
    g.add(footing);
  }

  // 主梁、木桥板与桥面逐块铺板，桥身不再像一整块浮在水面上的薄片。
  g.add(box(len + 1.8, 1.2, width + 1.8, MAT.stoneDark, 0, deckTop - 1.1, 0));
  g.add(box(len, 0.62, width, MAT.deckWood, 0, deckTop - 0.31, 0));
  const plankCount = Math.ceil(len / 1.15);
  for (let i = 0; i <= plankCount; i++) {
    const x = -len / 2 + (len * i) / plankCount;
    g.add(box(0.14, 0.12, width - 0.8, MAT.wood, x, deckTop + 0.06, 0));
  }
  // 横向承重梁与外侧木枋
  const bayCount = Math.max(12, Math.ceil(len / 8));
  for (let i = 0; i <= bayCount; i++) {
    const x = -len / 2 + (len * i) / bayCount;
    g.add(box(0.5, 0.72, width + 2.4, MAT.wood, x, deckTop - 0.95, 0));
  }
  for (const side of [-1, 1]) {
    g.add(box(len, 0.5, 0.58, MAT.red, 0, deckTop + 0.32, side * (width / 2 - 0.5)));
    g.add(box(len, 0.42, 0.45, MAT.wood, 0, deckTop + 2.1, side * (width / 2 - 0.7)));
  }

  // 廊柱、柱础与分格栏杆
  const bays = Math.max(16, Math.ceil(len / 7));
  for (let i = 0; i <= bays; i++) {
    const x = -len / 2 + (len / bays) * i;
    for (const side of [-1, 1]) {
      const z = side * (width / 2 - 1);
      g.add(box(1.15, 0.56, 1.15, MAT.stone, x, deckTop + 0.62, z));
      g.add(box(0.58, 4.45, 0.58, MAT.red, x, deckTop + 2.82, z));
      g.add(box(0.86, 0.28, 0.86, MAT.gold, x, deckTop + 0.98, z));
    }
  }
  for (let i = 0; i < bays; i++) {
    const x0 = -len / 2 + (len * i) / bays;
    const x1 = -len / 2 + (len * (i + 1)) / bays;
    const bayWidth = x1 - x0;
    const midX = (x0 + x1) / 2;
    for (const side of [-1, 1]) {
      const z = side * (width / 2 - 1);
      // 腰枋与竖向栏杆芯子组成传统木栏板。
      g.add(box(bayWidth, 0.3, 0.38, MAT.red, midX, deckTop + 1.48, z));
      g.add(box(bayWidth, 0.28, 0.42, MAT.red, midX, deckTop + 2.12, z));
      const balusterCount = Math.max(3, Math.floor(bayWidth / 1.35));
      for (let j = 0; j <= balusterCount; j++) {
        const bx = x0 + (bayWidth * j) / balusterCount;
        g.add(box(0.16, 0.66, 0.2, MAT.wood, bx, deckTop + 1.8, z));
      }
    }
  }

  // 屋面
  const roofW = len + 5, roofD = width + 6, roofH = 4.8;
  const roofY = deckTop + 4.9;
  const roof = new THREE.Mesh(gableRoof(roofW, roofD, roofH), MAT.roof);
  roof.position.y = roofY;
  g.add(roof);
  // 正脊、檐口、椽子与瓦垄，强化长廊桥的传统木瓦结构。
  g.add(box(roofW + 1.2, 0.58, 0.82, MAT.tile, 0, roofY + roofH + 0.15, 0));
  for (const side of [-1, 1]) {
    g.add(box(roofW + 1.6, 0.5, 0.58, MAT.wood, 0, roofY + 0.12, side * (roofD / 2 - 0.2)));
  }
  const rafterCount = Math.ceil(len / 2.4);
  for (let i = 0; i <= rafterCount; i++) {
    const x = -len / 2 + (len * i) / rafterCount;
    for (const side of [-1, 1]) {
      const pts = [
        new THREE.Vector3(x, roofY + roofH + 0.2, 0),
        new THREE.Vector3(x, roofY + roofH * 0.56, side * roofD * 0.24),
        new THREE.Vector3(x, roofY + 0.2, side * (roofD / 2 - 0.25)),
      ];
      g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 5, 0.075, 4), MAT.tile));
    }
  }
  // 金色脊饰只在两端收头，避免整条屋脊像一根亮色塑料梁。
  for (const side of [-1, 1]) {
    const finial = new THREE.Mesh(new THREE.SphereGeometry(0.75, 8, 6), MAT.gold);
    finial.position.set(side * (roofW / 2 - 1), roofY + roofH + 0.7, 0);
    g.add(finial);
  }

  return g;
}

/** 把一条经纬度线段的桥搭起来 */
function placeBridge(site, from, to, maker) {
  const p1 = site.toScene(from[0], from[1]);
  const p2 = site.toScene(to[0], to[1]);
  const y1 = site.heightAt(p1.x, p1.z);
  const y2 = site.heightAt(p2.x, p2.z);
  const dx = p2.x - p1.x;
  const dz = p2.z - p1.z;
  const len = Math.hypot(dx, dz);

  const avgY = (y1 + y2) / 2;
  const groundAt = (localX) => {
    const t = localX / len;
    return site.heightAt(
      (p1.x + p2.x) / 2 + (p2.x - p1.x) * t,
      (p1.z + p2.z) / 2 + (p2.z - p1.z) * t,
    );
  };
  const context = { site, p1, p2, avgY, groundAt };
  const g = maker(len, [y1 - avgY, y2 - avgY], context);

  g.position.set((p1.x + p2.x) / 2, (y1 + y2) / 2, (p1.z + p2.z) / 2);
  g.rotation.y = Math.atan2(-dz, dx);
  return g;
}

export function buildStructures(site) {
  const group = new THREE.Group();
  group.name = "structures";

  // ---- 鱼嘴分水堤 ----
  const levee = makeFishMouthLevee(260, 44, 11);
  site.place(levee, 103.6078, 31.0038, 0.28, 6);
  group.add(levee);

  // ---- 飞沙堰 ----
  // 低矮的溢流堰：横跨内江，堰顶仅高出水面半米，避免在水面上形成一整块高台
  const weir = makeWeir(70, 26, 18, 4.0);
  site.place(weir, 103.6081662, 31.0010593, 0.91, 0);
  const waterY = site.heightAtLngLat(103.6082, 31.0011);
  weir.position.y = waterY - 3.35; // 堰体大半埋入河床，堰顶略高于水面
  weir.name = "weir";
  group.add(weir);

  // ---- 安澜索桥 ----
  group.add(
    placeBridge(site, [103.6042456, 31.0070664], [103.6068421, 31.0086009], (len, ys, context) =>
      makeSuspensionBridge(len, ys, 4.4, context),
    ),
  );

  // ---- 南桥（廊桥）----
  // 横跨内江出宝瓶口后东流的水道（影像上位于 30.9962 一带），桥轴南北向
  group.add(
    placeBridge(site, [103.614046, 30.999361], [103.613878, 30.998847], (len, ys, context) =>
      makeGalleryBridge(len, ys, 11, context),
    ),
  );

  // ---- 玉垒阁 ----
  const pagoda = makePagoda(5, 11, 6.8);
  site.place(pagoda, 103.6123879, 31.0044967, 0.35, 0);
  addGroundedOctagonSkirt(pagoda, site, 11 * 2.1 * 1.015);
  group.add(pagoda);

  // ---- 二王庙 ----
  const erwang = new THREE.Group();
  const mainHall = makeHall(40, 19, 10, 7.5);
  mainHall.position.y = 5;
  erwang.add(mainHall);
  const wingA = makeHall(20, 13, 8, 5.5);
  wingA.position.set(-33, 5, 14);
  wingA.rotation.y = 0.2;
  erwang.add(wingA);
  const wingB = makeHall(20, 13, 8, 5.5);
  wingB.position.set(33, 5, 12);
  wingB.rotation.y = -0.2;
  erwang.add(wingB);
  site.place(erwang, 103.6081189, 31.0083083, 0.5, 5);
  // 三进建筑分别落在顺坡的石砌台地上，取消原来一整块跨过坡面的托盘。
  addGroundedPad(erwang, site, { width: 49, depth: 28, topY: 5, embed: 0.8 });
  addGroundedPad(erwang, site, {
    centerX: -33, centerZ: 14, width: 29, depth: 22,
    topY: 5, childRotation: 0.2, embed: 0.8,
  });
  addGroundedPad(erwang, site, {
    centerX: 33, centerZ: 12, width: 29, depth: 22,
    topY: 5, childRotation: -0.2, embed: 0.8,
  });
  group.add(erwang);

  // ---- 伏龙观 ----
  const fulong = new THREE.Group();
  fulong.add(box(56, 4, 44, MAT.stoneDark, 0, 2, 0));
  const fHall = makeHall(28, 16, 9, 6.5);
  fHall.position.y = 4;
  fulong.add(fHall);
  const gate = makeHall(12, 8, 6, 4);
  gate.position.set(0, 4, 20);
  fulong.add(gate);
  site.place(fulong, 103.6105741, 31.000834, -0.6, 0.5);
  addGroundedPad(fulong, site, { width: 56, depth: 44, topY: 0, embed: 0.8 });
  group.add(fulong);

  // ---- 城隍庙 ----
  const chenghuang = new THREE.Group();
  chenghuang.add(box(46, 3, 32, MAT.stoneDark, 0, 1.5, 0));
  const chHall = makeHall(26, 15, 8.5, 6.5);
  chHall.position.y = 3;
  chenghuang.add(chHall);
  const chWing = makeHall(14, 10, 6.5, 5);
  chWing.position.set(0, 3, 17);
  chenghuang.add(chWing);
  site.place(chenghuang, 103.6133468, 31.0028751, 0.25, 0.5);
  addGroundedPad(chenghuang, site, { width: 46, depth: 32, topY: 0, embed: 0.8 });
  group.add(chenghuang);

  // ---- 玉垒关 ----
  const yuleiguan = makeGate(24, 9.5, 8);
  site.place(yuleiguan, 103.6095179, 31.004261, -0.35, 0);
  addGroundedPad(yuleiguan, site, { width: 26.4, depth: 10.4, topY: -0.1, embed: 0.8 });
  group.add(yuleiguan);

  // ---- 秦堰楼 ----
  const qinyan = makePagoda(2, 7.5, 6.2);
  site.place(qinyan, 103.6074843, 31.0092614, 0.4, 0);
  addGroundedOctagonSkirt(qinyan, site, 7.5 * 2.1 * 1.015);
  group.add(qinyan);

  // ---- 宣化门 ----
  const xuanhua = makeGate(30, 11, 9);
  site.place(xuanhua, 103.6206979, 30.9981733, 0.15, 0);
  addGroundedPad(xuanhua, site, { width: 32.4, depth: 11.4, topY: -0.1, embed: 0.8 });
  group.add(xuanhua);

  return group;
}
