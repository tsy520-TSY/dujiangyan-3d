/**
 * 水体：岷江干流 + 内江 / 外江
 *
 * 做法不是给整片地形加水，而是沿河道中心线生成「水面条带」：
 *   - 中心线用 Catmull-Rom 样条按 ~22m 步长重采样，河宽同步平滑插值，
 *     避免折线拐点和忽宽忽窄；
 *   - 主要中心线按项目卫星底图逐段校核，分汊后分别沿外江与内江河槽走向；
 *   - 水面逐顶点受地形高程约束，避免宽水带跨过河岸后浮在陆地上；
 *   - 水位以中心线地形为基准，仅抬高少量以避免与地形争抢深度；
 *   - 横向 11 列顶点，外缘下沉埋入河岸，靠 alpha 淡出与影像衔接；
 *   - 着色器以卫星影像底色为基调（宽浅河床与深窄城市河道都能自动同色），
 *     叠加多尺度法线、菲涅尔、太阳高光、顺流涌纹与近岸白沫。
 */

import * as THREE from "three";

/** [经度, 纬度, 半宽(米)]，按水流方向（上游 → 下游）排列 */
const PATHS = [
  {
    id: "minjiang",
    points: [
      [103.578, 31.0235, 105],
      [103.581, 31.0212, 115],
      [103.585, 31.019, 105],
      [103.589, 31.0175, 92],
      [103.5935, 31.0165, 78],
      [103.598, 31.0155, 66],
      [103.6018, 31.014, 58],
      [103.603, 31.012, 52],
      [103.6043, 31.0098, 48],
      [103.6047, 31.0078, 46],
      [103.6049, 31.0058, 44],
      [103.605, 31.0042, 42],
    ],
  },
  {
    id: "waijiang",
    points: [
      [103.605, 31.0042, 42],
      [103.6048, 31.0018, 44],
      [103.6046, 30.9995, 45],
      [103.6045, 30.9965, 46],
      [103.6045, 30.993, 47],
      [103.6048, 30.9895, 48],
      [103.6052, 30.986, 49],
      [103.6056, 30.983, 50],
    ],
  },
  {
    // 内江：鱼嘴 → 宝瓶口 → 城南，控制点按影像水体逐段校核
    id: "neijiang",
    points: [
      [103.60855, 31.00405, 20],
      [103.60885, 31.00322, 18],
      [103.60986, 31.0014, 20],
      [103.61174, 31.00033, 18],
      [103.61357, 30.99923, 20],
      [103.6159, 30.99857, 24],
      [103.61834, 30.99801, 24],
      [103.6196, 30.997, 18],
      [103.6191, 30.996, 15],
      [103.6191, 30.995, 14],
      [103.6202, 30.994, 14],
      [103.6208, 30.993, 14],
      [103.6215, 30.992, 15],
      [103.6228, 30.9912, 14],
      [103.624, 30.9904, 12],
      [103.6246, 30.9896, 12],
      [103.6252, 30.9886, 12],
      [103.6256, 30.9874, 12],
      [103.6259, 30.9862, 12],
      [103.6262, 30.9845, 14],
    ],
  },
  {
    // 柏条河：出宝瓶口后向东穿过城区的一条支渠，南桥横跨其上
    id: "baitiao",
    points: [
      [103.6195, 30.9969, 13],
      [103.622, 30.9964, 14],
      [103.625, 30.9961, 15],
      [103.628, 30.9962, 15],
      [103.631, 30.9959, 16],
      [103.634, 30.9951, 16],
      [103.637, 30.9947, 17],
    ],
  },
];

/** 横断面采样位置（-1..1，按半宽归一化） */
const COLS = [-1, -0.88, -0.7, -0.48, -0.24, 0, 0.24, 0.48, 0.7, 0.88, 1];

/** 沿中心线的重采样步长（米） */
const STEP = 22;

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const catmull = (p0, p1, p2, p3, t) => {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
};

/** 经纬度折线 → 平滑等距采样点（含河宽平滑） */
function resamplePath(site, points) {
  const ctrl = points.map(([lng, lat, hw]) => {
    const p = site.toScene(lng, lat);
    return { x: p.x, z: p.z, hw };
  });

  const out = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)];
    const p1 = ctrl[i];
    const p2 = ctrl[i + 1];
    const p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];

    const segLen = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const n = Math.max(2, Math.round(segLen / STEP));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push({
        x: catmull(p0.x, p1.x, p2.x, p3.x, t),
        z: catmull(p0.z, p1.z, p2.z, p3.z, t),
        hw: catmull(p0.hw, p1.hw, p2.hw, p3.hw, t),
      });
    }
  }
  out.push({ ...ctrl[ctrl.length - 1] });
  return out;
}

function buildRibbon(site, points) {
  const samples = resamplePath(site, points);
  const { width: sceneW, height: sceneH } = site.meta.sceneSizeMeters;

  const pos = [];
  const uv = [];
  const edge = [];
  const flow = [];
  const idx = [];
  let prevLevel = null;
  let dist = 0;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const prev = samples[Math.max(0, i - 1)];
    const next = samples[Math.min(samples.length - 1, i + 1)];

    let tx = next.x - prev.x;
    let tz = next.z - prev.z;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    const nx = -tz;
    const nz = tx;

    // 以河槽中心线高程定水位；不能用整个断面的最低点抬升整条水带，
    // 否则一侧低洼会把另一侧岸地上方也撑出一块悬空水面。
    const bed = site.heightAt(s.x, s.z);
    let level = bed + 0.42;
    // 只约束剧烈上升，允许河床浅滩处缓慢跟随地形，避免整段被前一低点压入山体。
    if (prevLevel !== null) level = Math.min(level, prevLevel + 0.025);
    prevLevel = level;

    if (i > 0) {
      dist += Math.hypot(s.x - prev.x, s.z - prev.z);
    }

    for (const u of COLS) {
      const au = Math.abs(u);
      const x = s.x + nx * s.hw * u;
      const z = s.z + nz * s.hw * u;
      // 沿横断面逐点贴合地形：误压到岸上的部分会沉入地表，而不会形成浮空水塘。
      // 中间保留很小的深度偏移，避免与地形网格出现闪烁；两侧自然下切河岸。
      const ground = site.heightAt(x, z);
      const profileY = level - 0.55 * u * u - 1.15 * smoothstep(0.68, 1, au);
      const y = Math.min(profileY, ground + 0.12);
      pos.push(x, y, z);
      uv.push((x + sceneW / 2) / sceneW, 1 - (z + sceneH / 2) / sceneH);
      edge.push(au);
      flow.push(dist * 0.004);
    }
  }

  const n = samples.length;
  const cols = COLS.length;
  for (let i = 0; i < n - 1; i++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = i * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute("aEdge", new THREE.Float32BufferAttribute(edge, 1));
  geo.setAttribute("aFlow", new THREE.Float32BufferAttribute(flow, 1));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

const VERT = /* glsl */ `
  attribute float aEdge;
  attribute float aFlow;
  varying float vEdge;
  varying float vFlow;
  varying vec3 vWorld;
  varying vec2 vUv;
  void main() {
    vEdge = aEdge;
    vFlow = aFlow;
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uSky;
  uniform vec3 uSun;
  varying float vEdge;
  varying float vFlow;
  varying vec3 vWorld;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  // 与渲染器 ACESFilmicToneMapping 同款曲线
  vec3 aces(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  void main() {
    vec2 p = vWorld.xz;
    float t = uTime;

    // 远景衰减波幅，抑制高频闪烁
    float camDist = length(cameraPosition - vWorld);
    float detail = mix(0.12, 1.0, smoothstep(5200.0, 700.0, camDist));

    // 三层不同尺度的行波叠加成细碎水面
    vec2 g = vec2(0.0);
    g += 0.085 * vec2(
      cos(p.x * 0.062 + p.y * 0.024 + t * 1.6),
      cos(p.y * 0.058 - p.x * 0.019 - t * 1.3)
    );
    g += 0.045 * vec2(
      cos(p.x * 0.155 - p.y * 0.088 - t * 2.2),
      cos(p.y * 0.142 + p.x * 0.096 + t * 1.9)
    );
    g += 0.020 * vec2(
      cos(p.x * 0.39 + p.y * 0.31 + t * 2.9),
      cos(p.y * 0.36 - p.x * 0.33 - t * 2.6)
    );

    // 两片噪声打破正弦的规律感
    float n1 = noise(p * 0.09 + vec2(t * 0.06, -t * 0.04));
    float n2 = noise(p * 0.31 - vec2(t * 0.12, t * 0.09));
    g += (n1 - 0.5) * 0.10 + (n2 - 0.5) * 0.05;

    // 顺流方向的拉伸波纹
    g.y += sin(vFlow * 5.0 + n1 * 5.0 - t * 2.6) * 0.05;

    vec3 N = normalize(vec3(g.x * detail, 1.0, g.y * detail));

    vec3 V = normalize(cameraPosition - vWorld);
    vec3 L = normalize(uSun);
    vec3 H = normalize(L + V);

    float ndv = clamp(dot(N, V), 0.0, 1.0);
    // 克制掠射角的天空反射，避免卫星底图上的草地被映成浅蓝色浮块。
    float fres = 0.035 + 0.46 * pow(1.0 - ndv, 5.0);

    float ndh = max(dot(N, H), 0.0);
    float spec = pow(ndh, 220.0) * 0.55 + pow(ndh, 30.0) * 0.07;

    // 以卫星影像上的真实水色为基调，宽浅河床与深窄城市河道都能自然同色
    vec3 base = texture2D(uMap, vUv).rgb;
    vec3 col = mix(base, uDeep, 0.22) * 0.94;

    // 顺流明暗涌纹
    float streak = sin(vFlow * 2.4 - t * 1.5) * 0.5 + 0.5;
    col *= 0.92 + 0.16 * streak;

    // 天空反射（菲涅尔）：掠射角越强越像镜面
    vec3 sky = mix(uSky, vec3(0.90, 0.94, 0.97), fres);
    col = mix(col, sky, clamp(fres * 0.24, 0.0, 0.22));

    // 近岸白沫
    float foamBand = smoothstep(0.82, 0.99, vEdge);
    float foam = foamBand * smoothstep(0.45, 0.95, noise(p * 0.55 + vec2(t * 0.4, -t * 0.3)));
    col = mix(col, vec3(0.86, 0.90, 0.89), foam * 0.16);

    col += vec3(1.0, 0.95, 0.86) * spec;

    // 与地形材质走同一条色彩管线：ACES 色调映射 + sRGB 编码，
    // 否则水面会比周边地形偏暗
    col = aces(col * 1.05);
    col = pow(col, vec3(1.0 / 2.2));

    float alpha = mix(0.76, 0.0, smoothstep(0.66, 1.0, vEdge));
    gl_FragColor = vec4(col, alpha);
  }
`;

export function buildWater(site, map = null) {
  const uniforms = {
    uMap: { value: map },
    uTime: { value: 0 },
    uDeep: { value: new THREE.Color(0x17434d) },
    uSky: { value: new THREE.Color(0xc4dde9) },
    uSun: { value: new THREE.Vector3(-0.55, 0.72, 0.42).normalize() },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  const group = new THREE.Group();
  group.name = "water";

  for (const path of PATHS) {
    const mesh = new THREE.Mesh(buildRibbon(site, path.points), mat);
    mesh.name = `water-${path.id}`;
    mesh.renderOrder = 1;
    group.add(mesh);
  }

  return {
    group,
    update(t) {
      uniforms.uTime.value = t;
    },
  };
}
