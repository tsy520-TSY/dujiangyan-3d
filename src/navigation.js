/**
 * 以 OSM 的原始道路节点构建徒步路由图。
 * 新版 roads.json 使用节点 ID 连边；旧版会以保留 6 位小数的坐标作为兼容键。
 */

import * as THREE from "three";

const BLOCKED = new Set(["motorway", "motorway_link"]);

function nodeKey(way, index, point) {
  const id = way.nodes?.[index];
  return id == null ? `${point[0].toFixed(6)},${point[1].toFixed(6)}` : `n${id}`;
}

function edgeCost(roadClass, length) {
  const multiplier = roadClass === "steps" ? 1.35
    : roadClass === "path" || roadClass === "track" ? 1.18
      : roadClass === "primary" || roadClass === "secondary" || roadClass === "trunk" ? 1.12
        : 1;
  return length * multiplier;
}

export function buildNavigationGraph(data, site) {
  const nodes = new Map();
  const adjacency = new Map();
  const addNode = (key, ll) => {
    if (!nodes.has(key)) {
      const p = site.toScene(ll[0], ll[1]);
      nodes.set(key, { key, lng: ll[0], lat: ll[1], x: p.x, z: p.z });
      adjacency.set(key, []);
    }
    return nodes.get(key);
  };

  let edgeCount = 0;
  const halfW = site.meta.sceneSizeMeters.width / 2 - 2;
  const halfH = site.meta.sceneSizeMeters.height / 2 - 2;
  for (const way of data.roads) {
    if (way.x || BLOCKED.has(way.c) || way.p.length < 2) continue;
    for (let i = 0; i < way.p.length - 1; i++) {
      const aLL = way.p[i], bLL = way.p[i + 1];
      const aScene = site.toScene(aLL[0], aLL[1]);
      const bScene = site.toScene(bLL[0], bLL[1]);
      if (Math.abs(aScene.x) >= halfW || Math.abs(aScene.z) >= halfH
        || Math.abs(bScene.x) >= halfW || Math.abs(bScene.z) >= halfH) continue;
      const a = addNode(nodeKey(way, i, aLL), aLL);
      const b = addNode(nodeKey(way, i + 1, bLL), bLL);
      const length = Math.hypot(a.x - b.x, a.z - b.z);
      if (length < 0.25) continue;
      const edge = { to: b.key, length, cost: edgeCost(way.c, length), roadClass: way.c, name: way.n || "" };
      const reverse = { ...edge, to: a.key };
      adjacency.get(a.key).push(edge);
      adjacency.get(b.key).push(reverse);
      edgeCount++;
    }
  }
  return { nodes, adjacency, edgeCount };
}

class MinHeap {
  items = [];
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= item.cost) break;
      a[i] = a[p]; i = p;
    }
    a[i] = item;
  }
  pop() {
    const a = this.items;
    if (!a.length) return null;
    const first = a[0], last = a.pop();
    if (a.length) {
      let i = 0;
      while (true) {
        const l = i * 2 + 1, r = l + 1;
        if (l >= a.length) break;
        const c = r < a.length && a[r].cost < a[l].cost ? r : l;
        if (a[c].cost >= last.cost) break;
        a[i] = a[c]; i = c;
      }
      a[i] = last;
    }
    return first;
  }
  get length() { return this.items.length; }
}

function nearestNode(graph, site, spot) {
  const p = site.toScene(spot.lng, spot.lat);
  let best = null, bestD2 = Infinity;
  for (const node of graph.nodes.values()) {
    const dx = node.x - p.x, dz = node.z - p.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) { best = node; bestD2 = d2; }
  }
  return best ? { node: best, distance: Math.sqrt(bestD2), point: p } : null;
}

export function findWalkingRoute(graph, site, fromSpot, toSpot) {
  const from = nearestNode(graph, site, fromSpot);
  const to = nearestNode(graph, site, toSpot);
  if (!from || !to || from.distance > 180 || to.distance > 180) return null;

  const cost = new Map([[from.node.key, 0]]);
  const previous = new Map();
  const heap = new MinHeap();
  heap.push({ key: from.node.key, cost: 0 });
  while (heap.length) {
    const current = heap.pop();
    if (current.cost !== cost.get(current.key)) continue;
    if (current.key === to.node.key) break;
    for (const edge of graph.adjacency.get(current.key) || []) {
      const nextCost = current.cost + edge.cost;
      if (nextCost >= (cost.get(edge.to) ?? Infinity)) continue;
      cost.set(edge.to, nextCost);
      previous.set(edge.to, { key: current.key, edge });
      heap.push({ key: edge.to, cost: nextCost });
    }
  }
  if (!cost.has(to.node.key)) return null;

  const path = [];
  let key = to.node.key;
  while (key !== from.node.key) {
    const step = previous.get(key);
    if (!step) return null;
    path.push(graph.nodes.get(key));
    key = step.key;
  }
  path.push(graph.nodes.get(from.node.key));
  path.reverse();

  const points = [from.point, ...path.map((n) => new THREE.Vector3(n.x, 0, n.z)), site.toScene(toSpot.lng, toSpot.lat)];
  const length = from.distance + path.slice(1).reduce((sum, n, i) => {
    const prev = path[i];
    return sum + Math.hypot(n.x - prev.x, n.z - prev.z);
  }, 0) + to.distance;
  return { points, length, minutes: Math.max(1, Math.round(length / 76)), nodes: path.length };
}

/** 把路线画成贴着地面的双层发光线，便于从 3D 地形和道路网中识别。 */
export function buildRouteOverlay(site, route) {
  const group = new THREE.Group();
  group.name = "active-route";
  if (!route || route.points.length < 2) return group;
  // 沿每段道路按 4m 采样高程，路线几何贴合 DEM，同时保留 OSM 折线走向。
  const points = [];
  for (let i = 0; i < route.points.length - 1; i++) {
    const a = route.points[i], b = route.points[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 4));
    for (let j = 0; j < steps; j++) {
      const t = j / steps;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      points.push(new THREE.Vector3(x, site.heightAt(x, z) + 3.2, z));
    }
  }
  const end = route.points[route.points.length - 1];
  points.push(new THREE.Vector3(end.x, site.heightAt(end.x, end.z) + 3.2, end.z));
  const curve = new THREE.CurvePath();
  for (let i = 0; i < points.length - 1; i++) {
    curve.add(new THREE.LineCurve3(points[i], points[i + 1]));
  }
  const segments = Math.max(32, points.length * 2);
  const outer = new THREE.Mesh(
    new THREE.TubeGeometry(curve, segments, 2.0, 6, false),
    new THREE.MeshBasicMaterial({ color: 0xffd36a, transparent: true, opacity: 0.2, depthWrite: false }),
  );
  const core = new THREE.Mesh(
    new THREE.TubeGeometry(curve, segments, 0.72, 6, false),
    new THREE.MeshBasicMaterial({ color: 0xff9b18, depthWrite: false }),
  );
  outer.renderOrder = core.renderOrder = 4;
  group.add(outer, core);
  return group;
}
