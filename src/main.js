/**
 * 都江堰景区 3D 地形模型
 *
 * 渲染结构（对照参考图拆解）：
 *   1. 地形面  —— 高程网格 + 卫星影像贴图 + 法线光照
 *   2. 基座    —— 地形垂直挤出到统一底面，形成"地质剖面块"效果
 *   3. 标注    —— 景点用 3D 投影到屏幕的 HTML 标签
 *
 * 坐标约定：
 *   场景以米为单位。X 向东，Z 向南（与经纬度方向一致），Y 向上。
 *   高程不放大，保持真实比例；因为 bbox 约 6.7km 宽、落差 555m，
 *   真实比例下立体感已经足够（参考图同样是 ~15 倍宽高比）。
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createSite } from "./geo.js";
import { buildWater } from "./water.js";
import { buildStructures } from "./structures.js";
import { buildRoads } from "./roads.js";
import { buildNavigationGraph, findWalkingRoute, buildRouteOverlay } from "./navigation.js";

// ---------------- 全局状态 ----------------

const state = {
  meta: null,
  spots: [],
  terrain: null, // { mesh, geometry, heights }
  site: null, // 经纬度 / 高程换算
  water: null, // { group, update }
  structures: null,
  roads: null,
  navigationGraph: null,
  activeRoute: null,
  freeView: false,
  labels: [],
  markers: null,
  hovered: null,
  options: {
    spots: true,
    shade: true,
    wire: false,
    water: true,
    structures: true,
    roads: true,
  },
};

const canvas = document.getElementById("scene");
const tooltip = document.getElementById("tooltip");

// ---------------- 渲染器 / 场景 / 相机 ----------------

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xc9dde8);
scene.fog = new THREE.Fog(0xc9dde8, 9000, 22000);

const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  1,
  40000,
);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
  controls.maxPolarAngle = Math.PI * 0.455; // 普通模式保持俯视；自由视角可更接近水平
controls.minDistance = 160;
controls.maxDistance = 16000;
controls.target.set(0, 0, 0);

// ---------------- 光照 ----------------

// 用半球光打底，配合方向光做出参考图那种"太阳斜照"的立体感
const hemi = new THREE.HemisphereLight(0xdff0f7, 0x4a5240, 1.5);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2dc, 2.1);
sun.position.set(-4200, 5200, 2600);
scene.add(sun);

// 补一盏冷色弱光，压暗面不至于死黑
const fill = new THREE.DirectionalLight(0x9dc4d8, 0.55);
fill.position.set(3800, 2200, -3400);
scene.add(fill);

// ---------------- 加载数据 ----------------

const hint = document.getElementById("loading-hint");
const fillBar = document.getElementById("loading-fill");

function setProgress(pct, text) {
  fillBar.style.width = `${pct}%`;
  if (text) hint.textContent = text;
}

async function loadData() {
  setProgress(8, "读取场景元数据…");
  const meta = await fetch("/data/meta.json").then((r) => r.json());

  setProgress(24, "读取高程网格…");
  const [hmBuf, tex] = await Promise.all([
    fetch("/data/heightmap.f32").then((r) => r.arrayBuffer()),
    loadTerrainTexture(),
  ]);

  setProgress(58, "读取景点与路网数据…");
  const [spots, roadGeo] = await Promise.all([
    fetch("/data/spots.json").then((r) => r.json()),
    fetch("/data/roads.json").then((r) => r.json()),
  ]);

  setProgress(76, "构建地形网格…");
  return { meta, hmBuf, tex, spots, roadGeo };
}

/** 8192px 底图在部分集显上超过最大纹理尺寸；按设备上限缩放，保证场景仍可启动。 */
async function loadTerrainTexture() {
  const texture = await new THREE.TextureLoader().loadAsync("/data/terrain.jpg");
  const image = texture.image;
  const maxSize = renderer.capabilities.maxTextureSize;
  if (image.width <= maxSize && image.height <= maxSize) return texture;

  const scale = maxSize / Math.max(image.width, image.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(image.width * scale));
  canvas.height = Math.max(1, Math.floor(image.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  texture.dispose();
  return new THREE.CanvasTexture(canvas);
}

// ---------------- 地形构建 ----------------

/**
 * 把 Float32 高程网格转成 BufferGeometry。
 *
 * heightmap 是行优先、左上(西北)原点。场景里 X 向东、Z 向南，
 * 所以行 j 映射到 Z 从负到正，列 i 映射到 X 从负到正。
 */
function buildTerrain(meta, hmBuf, tex) {
  const { width: W, height: H } = meta.grid;
  const heights = new Float32Array(hmBuf);

  const sceneW = meta.sceneSizeMeters.width;
  const sceneH = meta.sceneSizeMeters.height;

  // 平面尺寸直接用真实米数，高程 1:1
  const sx = sceneW / (W - 1);
  const sz = sceneH / (H - 1);

  // 以场景中心为原点
  const ox = -sceneW / 2;
  const oz = -sceneH / 2;

  // 基准高程：让最低点落在 y=0 附近，便于摆放基座
  const baseElev = meta.elevation.min - 1.5;

  const pos = new Float32Array(W * H * 3);
  const uv = new Float32Array(W * H * 2);
  const idx = [];

  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const h = heights[k];
      pos[k * 3] = ox + i * sx;
      pos[k * 3 + 1] = h - baseElev;
      pos[k * 3 + 2] = oz + j * sz;

      uv[k * 2] = i / (W - 1);
      uv[k * 2 + 1] = 1 - j / (H - 1); // 纹理 v 轴朝上
    }
  }

  for (let j = 0; j < H - 1; j++) {
    for (let i = 0; i < W - 1; i++) {
      const a = j * W + i;
      const b = a + 1;
      const c = a + W;
      const d = c + 1;
      // 两个三角形，逆时针面向 +Y
      idx.push(a, c, b);
      idx.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;

  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    bumpMap: createTerrainReliefMap(),
    bumpScale: 0.72,
    roughness: 0.94,
    metalness: 0.0,
    // 不再压暗影像：满亮度贴图色彩更饱和，近景边缘也更锐
    color: new THREE.Color(0xffffff),
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "terrain";
  scene.add(mesh);

  return { mesh, geometry: geo, heights, sx, sz, ox, oz, W, H, baseElev };
}

/** 低幅度、可平铺的多尺度微地形，用于加强真实 DEM 的山脊与坡面质感。 */
function createTerrainReliefMap() {
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const hash = (x, y) => {
    const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
    return n - Math.floor(n);
  };
  const noise = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), sx);
    const b = THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), sx);
    return THREE.MathUtils.lerp(a, b, sy);
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // 低频起伏模拟山坡细纹，高频分量只留下轻微颗粒，不覆盖卫星影像。
      const h = 0.5 + (noise(u * 9, v * 9) - 0.5) * 0.54
        + (noise(u * 27, v * 27) - 0.5) * 0.24
        + (noise(u * 81, v * 81) - 0.5) * 0.10;
      const value = Math.round(THREE.MathUtils.clamp(h, 0, 1) * 255);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = value;
      data[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(36, 36);
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/**
 * 基座：把地形四周边界垂直挤出到底部平面。
 * 参考图那块"地质剖面"就是这个做法——不是实体建模，是侧裙。
 */
function buildSkirt(terrain) {
  const { heights, W, H, sx, sz, ox, oz, baseElev } = terrain;
  const bottom = -Math.max(420, (terrain.mesh.geometry.boundingBox?.max.y ?? 600) * 0.9);

  const BOTTOM = -520;

  const verts = [];
  const norms = [];
  const idx = [];

  // 沿四条边生成侧裙
  const boundary = [];
  // 北边（j=0）：i 从 0→W-1
  for (let i = 0; i < W; i++) boundary.push([i, 0, "north"]);
  // 东边（i=W-1）：j 从 0→H-1
  for (let j = 1; j < H; j++) boundary.push([W - 1, j, "east"]);
  // 南边（j=H-1）：i 从 W-2→0
  for (let i = W - 2; i >= 0; i--) boundary.push([i, H - 1, "south"]);
  // 西边（i=0）：j 从 H-2→1
  for (let j = H - 2; j >= 1; j--) boundary.push([0, j, "west"]);

  let vi = 0;
  for (let n = 0; n < boundary.length; n++) {
    const [i, j] = boundary[n];
    const h = heights[j * W + i] - baseElev;
    const x = ox + i * sx;
    const z = oz + j * sz;
    verts.push(x, h, z);
    verts.push(x, BOTTOM, z);
    vi += 2;
  }

  const count = boundary.length;
  for (let n = 0; n < count; n++) {
    const a = n * 2;
    const b = a + 1;
    const c = ((n + 1) % count) * 2;
    const d = c + 1;
    idx.push(a, b, c);
    idx.push(c, b, d);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();

  const mat = new THREE.MeshStandardMaterial({
    color: 0x5c6350,
    roughness: 1.0,
    metalness: 0.0,
    side: THREE.DoubleSide,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "skirt";
  scene.add(mesh);
  return mesh;
}

// ---------------- 景点标注 ----------------

function buildLabels(spots, terrain) {
  const { W, H, sx, sz, ox, oz } = terrain;
  const container = document.getElementById("app");
  const labels = [];
  const markers = new THREE.Group();
  markers.name = "spot-markers";

  const majorCats = new Set(["水利工程", "人文古迹", "观景建筑", "桥梁", "关隘"]);
  const pinGeo = new THREE.CylinderGeometry(0.45, 0.9, 5.2, 7);
  const capGeo = new THREE.SphereGeometry(1.8, 10, 8);
  const ringGeo = new THREE.TorusGeometry(2.1, 0.35, 5, 12);
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xffca58, roughness: 0.56, emissive: 0x513000, emissiveIntensity: 0.22 });
  const blueMat = new THREE.MeshStandardMaterial({ color: 0x9ed7e7, roughness: 0.62, emissive: 0x143947, emissiveIntensity: 0.18 });

  for (const s of spots) {
    // 坐标 → 网格索引（用于取地形高度，保证标签贴地）
    const fi = ((s.lng - state.meta.bbox.west) /
      (state.meta.bbox.east - state.meta.bbox.west)) * (W - 1);
    const fj = ((state.meta.bbox.north - s.lat) /
      (state.meta.bbox.north - state.meta.bbox.south)) * (H - 1);
    const x = ox + fi * sx;
    const z = oz + fj * sz;
    const y = state.site.heightAt(x, z);
    const major = majorCats.has(s.category);

    const pin = new THREE.Group();
    pin.position.set(x, y, z);
    const markerMat = major ? goldMat : blueMat;
    const stem = new THREE.Mesh(pinGeo, markerMat);
    stem.position.y = 3.1;
    const cap = new THREE.Mesh(capGeo, markerMat);
    cap.position.y = 6.2;
    const ring = new THREE.Mesh(ringGeo, markerMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.28;
    const scale = major ? 1 : 0.72;
    pin.scale.setScalar(scale);
    pin.add(stem, cap, ring);
    markers.add(pin);

    const el = document.createElement("div");
    el.className = "spot-label" + (major ? " major" : "");
    if (s.mustVisit) el.classList.add("must");
    el.innerHTML = `<span>${s.name}</span><i></i>`;
    container.appendChild(el);

    labels.push({
      el,
      pos: new THREE.Vector3(x, y + 6.2 * scale, z),
      spot: s,
      major,
      must: s.mustVisit,
    });
  }

  return { labels, markers };
}

// 标签投影更新
const _v = new THREE.Vector3();

function updateLabels() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const candidates = [];

  for (const L of state.labels) {
    if (!state.options.spots) { L.el.style.display = "none"; continue; }
    const dist = camera.position.distanceTo(L.pos);
    if (!L.major && dist > 3600) { L.el.style.display = "none"; continue; }
    _v.copy(L.pos).project(camera);
    const visible = _v.z < 1 && _v.z > -1;
    if (!visible) {
      L.el.style.display = "none";
      continue;
    }
    const x = (_v.x * 0.5 + 0.5) * w;
    const y = (-_v.y * 0.5 + 0.5) * h;
    if (x < -80 || x > w + 80 || y < -40 || y > h + 40) {
      L.el.style.display = "none";
      continue;
    }
    L.el.style.display = "";
    const opacity = L.major ? 1 : Math.max(0.45, Math.min(0.92, (4600 - dist) / 2600));
    candidates.push({ ...L, x, y, dist, opacity, width: L.el.offsetWidth, height: L.el.offsetHeight });
  }

  // 重要景点优先保留；次要点位在近景缩放时再逐步出现，避免标签互相盖住。
  candidates.sort((a, b) => Number(b.major) - Number(a.major)
    || Number(b.must) - Number(a.must) || a.dist - b.dist);
  const placed = [];
  for (const L of candidates) {
    const box = { left: L.x - L.width / 2 - 5, right: L.x + L.width / 2 + 5,
      top: L.y - L.height - 5, bottom: L.y + 3 };
    const overlaps = placed.some((p) => box.left < p.right && box.right > p.left
      && box.top < p.bottom && box.bottom > p.top);
    if (overlaps) { L.el.style.display = "none"; continue; }
    placed.push(box);
    L.el.style.display = "";
    L.el.style.transform = `translate(-50%, -100%) translate(${L.x}px, ${L.y}px)`;
    L.el.style.opacity = L.opacity;
  }
}

// ---------------- 视角预设 ----------------

let VIEWS = {};

function buildViews(site) {
  // 以经纬度定位，避免预设坐标与建筑位置脱节
  const focus = (lng, lat, dy = 30) => {
    const p = site.toScene(lng, lat);
    return [p.x, site.heightAt(p.x, p.z) + dy, p.z];
  };
  const away = (t, dx, dy, dz) => [t[0] + dx, t[1] + dy, t[2] + dz];

  const yuzui = focus(103.6078, 31.0038, 20);
  const anlan = focus(103.6055439, 31.0078337, 20);
  const baoping = focus(103.6105647, 31.0011322, 15);
  const yuleige = focus(103.6123879, 31.0044967, 40);
  const nanqiao = focus(103.613962, 30.999104, 12);

  VIEWS = {
    overview: { pos: [-4100, 5200, 4600], target: [0, 180, 0] },
    yuzui: { pos: away(yuzui, -950, 360, 950), target: yuzui },
    anlan: { pos: away(anlan, 520, 240, 620), target: anlan },
    baopingkou: { pos: away(baoping, 900, 400, 900), target: baoping },
    yuleige: { pos: away(yuleige, 1500, 550, 1500), target: yuleige },
    city: { pos: away(nanqiao, 700, 320, 700), target: nanqiao },
  };
}

function applyView(name, instant = false) {
  const v = VIEWS[name] || VIEWS.overview;
  const toPos = new THREE.Vector3(...v.pos);
  const toTarget = new THREE.Vector3(...v.target);

  if (instant) {
    camera.position.copy(toPos);
    controls.target.copy(toTarget);
    controls.update();
    return;
  }

  animateCamera(toPos, toTarget, 900);
}

let camAnim = null;

function animateCamera(toPos, toTarget, duration) {
  const fromPos = camera.position.clone();
  const fromTarget = controls.target.clone();
  const start = performance.now();

  camAnim = (now) => {
    const t = Math.min(1, (now - start) / duration);
    // easeInOutCubic
    const e = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    camera.position.lerpVectors(fromPos, toPos, e);
    controls.target.lerpVectors(fromTarget, toTarget, e);
    controls.update();
    return t < 1;
  };
}

// ---------------- 辅助元素 ----------------

function buildGroundPlane() {
  // 极淡的底面阴影承接，让模型"落"在地上而不是飘着
  const geo = new THREE.CircleGeometry(9000, 64);
  const mat = new THREE.MeshBasicMaterial({
    color: 0xa8c0d0,
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
  });
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = -530;
  scene.add(m);
}

// ---------------- 交互 ----------------

function setupRaycast(terrain) {
  const ray = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let last = 0;

  canvas.addEventListener("pointermove", (e) => {
    const now = performance.now();
    if (now - last < 40) return;
    last = now;

    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(mouse, camera);

    // 标签悬停优先
    let hitLabel = null;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const L of state.labels) {
      if (!state.options.spots) continue;
      _v.copy(L.pos).project(camera);
      if (_v.z > 1 || _v.z < -1) continue;
      const lx = (_v.x * 0.5 + 0.5) * w;
      const ly = (-_v.y * 0.5 + 0.5) * h;
      if (Math.hypot(lx - e.clientX, ly - e.clientY) < 26) {
        hitLabel = L;
        break;
      }
    }

    if (hitLabel) {
      tooltip.textContent = `${hitLabel.spot.name} · ${Math.round(hitLabel.spot.elevation)}m`;
      tooltip.style.left = `${e.clientX}px`;
      tooltip.style.top = `${e.clientY}px`;
      tooltip.classList.add("show");
      canvas.style.cursor = "pointer";
    } else {
      tooltip.classList.remove("show");
      canvas.style.cursor = "grab";
    }
  });

  canvas.addEventListener("pointerleave", () => {
    tooltip.classList.remove("show");
  });

  canvas.addEventListener("dblclick", (e) => {
    if (!state.freeView) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    ray.setFromCamera(mouse, camera);
    const targets = [state.structures, state.roads, state.water?.group, terrain.mesh]
      .filter(Boolean);
    const hit = ray.intersectObjects(targets, true)[0];
    if (hit) animateCamera(camera.position.clone(), hit.point.clone(), 650);
  });
}

function setFreeView(enabled) {
  state.freeView = enabled;
  controls.maxPolarAngle = enabled ? Math.PI * 0.495 : Math.PI * 0.455;
  controls.minDistance = enabled ? 35 : 160;
  controls.maxDistance = enabled ? 24000 : 16000;
  const button = document.getElementById("view-free");
  const help = document.getElementById("view-help");
  button.setAttribute("aria-pressed", String(enabled));
  button.classList.toggle("active", enabled);
  button.textContent = enabled ? "退出自由视角" : "开启自由视角";
  help.textContent = enabled
    ? "左键旋转 · 滚轮缩放 · 右键平移 · 双击地面设观察中心"
    : "左键旋转 · 滚轮缩放 · 右键平移";
  controls.update();
}

function updateScaleBar() {
  const height = canvas.clientHeight;
  if (!height) return;
  const distance = camera.position.distanceTo(controls.target);
  const metersPerPixel = (2 * distance * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / height;
  const desiredMeters = metersPerPixel * 84;
  const power = 10 ** Math.floor(Math.log10(Math.max(desiredMeters, 0.01)));
  const factor = [1, 2, 5, 10].find((n) => n * power >= desiredMeters) ?? 10;
  const meters = factor * power;
  document.getElementById("scalebar").style.setProperty("--scale-width", `${meters / metersPerPixel}px`);
  document.getElementById("scale-text").textContent = meters >= 1000
    ? `${Number((meters / 1000).toFixed(2))} km`
    : `${Math.round(meters)} m`;
}

// ---------------- UI 绑定 ----------------

function bindUI() {
  document.getElementById("tgl-spots").addEventListener("change", (e) => {
    state.options.spots = e.target.checked;
    if (state.markers) state.markers.visible = e.target.checked;
  });
  document.getElementById("tgl-shade").addEventListener("change", (e) => {
    state.options.shade = e.target.checked;
    sun.intensity = e.target.checked ? 2.1 : 0.5;
    fill.intensity = e.target.checked ? 0.55 : 0.2;
  });
  document.getElementById("tgl-wire").addEventListener("change", (e) => {
    state.options.wire = e.target.checked;
    const m = state.terrain?.mesh.material;
    if (m) m.wireframe = e.target.checked;
  });
  document.getElementById("tgl-water").addEventListener("change", (e) => {
    state.options.water = e.target.checked;
    if (state.water) state.water.group.visible = e.target.checked;
  });
  document.getElementById("tgl-structures").addEventListener("change", (e) => {
    state.options.structures = e.target.checked;
    if (state.structures) state.structures.visible = e.target.checked;
  });
  document.getElementById("tgl-roads").addEventListener("change", (e) => {
    state.options.roads = e.target.checked;
    if (state.roads) state.roads.visible = e.target.checked;
  });

  document.querySelectorAll(".views button").forEach((b) => {
    b.addEventListener("click", () => applyView(b.dataset.view));
  });
  document.getElementById("view-free").addEventListener("click", () => {
    setFreeView(!state.freeView);
  });

  const startSelect = document.getElementById("route-start");
  const endSelect = document.getElementById("route-end");
  for (const spot of state.spots) {
    for (const select of [startSelect, endSelect]) {
      const option = document.createElement("option");
      option.value = spot.id;
      option.textContent = spot.name;
      select.appendChild(option);
    }
  }
  startSelect.value = state.spots.find((s) => s.id === "yuzui")?.id ?? state.spots[0]?.id;
  endSelect.value = state.spots.find((s) => s.id === "baopingkou")?.id ?? state.spots[1]?.id;
  document.getElementById("route-plan").addEventListener("click", () => {
    const from = state.spots.find((s) => s.id === startSelect.value);
    const to = state.spots.find((s) => s.id === endSelect.value);
    const status = document.getElementById("route-status");
    if (!from || !to || from.id === to.id) {
      status.textContent = "请选择两个不同的景点";
      return;
    }
    const route = findWalkingRoute(state.navigationGraph, state.site, from, to);
    if (!route) {
      status.textContent = "当前路网未连通这两个景点";
      return;
    }
    if (state.activeRoute) scene.remove(state.activeRoute);
    state.activeRoute = buildRouteOverlay(state.site, route);
    scene.add(state.activeRoute);
    status.textContent = `${(route.length >= 1000 ? `${(route.length / 1000).toFixed(2)} km` : `${Math.round(route.length)} m`)} · 约 ${route.minutes} 分钟步行`;
    const center = new THREE.Vector3();
    for (const p of route.points) {
      center.add(new THREE.Vector3(p.x, state.site.heightAt(p.x, p.z) + 18, p.z));
    }
    center.divideScalar(route.points.length);
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of route.points) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const span = Math.max(360, Math.hypot(maxX - minX, maxZ - minZ));
    const direction = new THREE.Vector3(0.42, 0.82, 0.39).normalize();
    const routeCamera = center.clone().addScaledVector(direction, span * 1.05);
    animateCamera(routeCamera, center, 900);
  });

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    updateScaleBar();
  });
}

function fillElevInfo(meta) {
  const { min, max } = meta.elevation;
  document.getElementById("el-min").textContent = `${min.toFixed(0)} m`;
  document.getElementById("el-max").textContent = `${max.toFixed(0)} m`;
  document.getElementById("el-drop").textContent = `${(max - min).toFixed(0)} m`;
}

// ---------------- 主循环 ----------------

const clock = new THREE.Clock();
let lastScaleUpdate = 0;

function tick(now) {
  requestAnimationFrame(tick);

  if (camAnim) {
    if (!camAnim(now)) camAnim = null;
  }

  controls.update();
  state.water?.update(now * 0.001);
  updateLabels();
  if (now - lastScaleUpdate > 120) {
    updateScaleBar();
    lastScaleUpdate = now;
  }
  renderer.render(scene, camera);
}

// ---------------- 启动 ----------------

async function init() {
  const { meta, hmBuf, tex, spots, roadGeo } = await loadData();

  state.meta = meta;
  state.spots = spots;

  setProgress(84, "生成地形…");
  const terrain = buildTerrain(meta, hmBuf, tex);
  state.terrain = terrain;
  const site = createSite(meta, terrain);
  state.site = site;

  setProgress(90, "生成基座与标注…");
  buildSkirt(terrain);
  buildGroundPlane();
  const spotLayers = buildLabels(spots, terrain);
  state.labels = spotLayers.labels;
  state.markers = spotLayers.markers;
  scene.add(state.markers);

  state.navigationGraph = buildNavigationGraph(roadGeo, site);

  setProgress(94, "引入岷江水体…");
  state.water = buildWater(site, tex);
  scene.add(state.water.group);

  setProgress(97, "搭建水工建筑…");
  state.structures = buildStructures(site);
  scene.add(state.structures);

  setProgress(98, "铺设公路与步道…");
  state.roads = buildRoads(site, roadGeo);
  scene.add(state.roads);

  buildViews(site);
  fillElevInfo(meta);
  bindUI();
  setupRaycast(terrain);

  applyView("overview", true);

  setProgress(100, "完成");
  await new Promise((r) => setTimeout(r, 260));
  document.getElementById("loading").classList.add("hidden");

  clock.start();
  requestAnimationFrame(tick);
}

init().catch((err) => {
  console.error(err);
  hint.textContent = "加载失败：" + err.message;
  hint.style.color = "#e08c7a";
});
