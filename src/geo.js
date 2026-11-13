/**
 * 场景坐标工具
 *
 * DEM 网格以左上（西北）为原点，行列优先；场景 X 向东、Z 向南、Y 向上。
 * 这里把「经纬度 → 场景 XZ」和「按地形取高程」收敛到一处，
 * 水面、建筑、标注都复用同一套换算，避免各自偏移。
 */

import * as THREE from "three";

export function createSite(meta, terrain) {
  const bb = meta.bbox;
  const { heights, W, H, sx, sz, ox, oz, baseElev } = terrain;

  const sceneW = meta.sceneSizeMeters.width;
  const sceneH = meta.sceneSizeMeters.height;
  const midLng = (bb.west + bb.east) / 2;
  const midLat = (bb.north + bb.south) / 2;
  const mPerLng = sceneW / (bb.east - bb.west);
  const mPerLat = sceneH / (bb.north - bb.south);

  /** 经纬度 → 场景平面坐标（y 恒为 0） */
  function toScene(lng, lat) {
    return new THREE.Vector3(
      (lng - midLng) * mPerLng,
      0,
      (midLat - lat) * mPerLat,
    );
  }

  /** 双线性采样地形高程（返回相对基座的高度，与地形网格一致） */
  function heightAt(x, z) {
    const fi = Math.min(W - 1, Math.max(0, (x - ox) / sx));
    const fj = Math.min(H - 1, Math.max(0, (z - oz) / sz));
    const i0 = Math.min(W - 2, Math.floor(fi));
    const j0 = Math.min(H - 2, Math.floor(fj));
    const tx = fi - i0;
    const tz = fj - j0;
    const k = j0 * W + i0;
    const h00 = heights[k];
    const h10 = heights[k + 1];
    const h01 = heights[k + W];
    const h11 = heights[k + W + 1];
    const h =
      h00 * (1 - tx) * (1 - tz) +
      h10 * tx * (1 - tz) +
      h01 * (1 - tx) * tz +
      h11 * tx * tz;
    return h - baseElev;
  }

  function heightAtLngLat(lng, lat) {
    const p = toScene(lng, lat);
    return heightAt(p.x, p.z);
  }

  /** 把一个 group 摆到某个经纬度上，y 取地形高度 */
  function place(group, lng, lat, rotY = 0, sink = 1.5) {
    const p = toScene(lng, lat);
    group.position.set(p.x, heightAt(p.x, p.z) - sink, p.z);
    group.rotation.y = rotY;
    return group;
  }

  return { toScene, heightAt, heightAtLngLat, place, meta, terrain };
}
