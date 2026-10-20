/**
 * group.js — 分片：選一群面切成一片（2026-10-21，`分片成群-設計方向.md` 第 5 節第二件，kang「同意你的建議與安排」）
 *
 * ── 這份回答什麼 ─────────────────────────────────────
 * 分片模式「選面」那一套的**純計算**（⛔ 碰畫面、⛔ 碰 DOM，所以測得到）：
 *   · `regionInfo()`   每一塊平面（共面區域）：面、面積、朝向、跟誰相鄰（共用邊多長、隔著縫的不算「連著」）
 *   · `growRegions()`  往外長：從一塊面開始，相連（⛔ 跨過縫）、朝向差在角度以內的都加進來
 *   · `pieceRegions()` 選起整片：被縫圍起來的那一整片
 *   · `withTiny()`     碎面跟著旁邊那一片走（面積小於門檻 ⇒ 跟著共用邊最長的鄰居）
 *   · `components()`   選的面連成幾塊（⛔ 連在一起 ⇒ 切下去會變好幾片，要先講）
 *   · `applyGroup()`   切成一片：外圈標縫、裡面的縫拿掉；「不准切」的邊一律⛔ 碰（10/13 硬規定）
 *   · `checkGroup()`   選的當下就檢查：在副本上照「切成一片」標縫、攤一次，講這一群會不會疊
 *
 * ── 單位 ──────────────────────────────────────────────
 * 「一塊面」＝ 一個共面區域（`planarRegions()` 的 `face.region`），跟「切出這個面」同一個意思；
 * 選取存的是區域編號。⚠ 區域編號只在網格沒變的時候有效 —— 網格換了（Undo、改點）就要重算、選取要清。
 *
 * ── 預設值（kang「穩定、有預設、也能彈性調整」）──────
 *   往外長的角度 `GROW_DEG` ＝ 30°（臉與眼窩這種轉折大的地方會停）—— 面板上可以改
 *   碎面門檻 `TINY_MM2` ＝ 1 mm²（錐體尖端是 0.0001 cm 的小方塊、布林接縫是細長三角形）—— 面板上可以改
 */

import * as THREE from 'three';
import { planarRegions } from '../core/region.js';
import { setSeam, isSeam, isMarkable } from './seam.js';
import { FLAT_TOL_DEG } from './flatten.js';
import { unfoldObject } from './part.js';
import { ModelObject } from '../core/io.js';

export const GROW_DEG = 30;
export const TINY_MM2 = 1;

/**
 * 每一塊平面的資料。
 * @returns {Map<number, {id, faces, area, n: THREE.Vector3, nb: Map<number, number>, nbOpen: Map<number, number>}>}
 *   `area` cm²；`n` 面積加權的朝向；`nb` 相鄰（共用邊長，含隔著縫的）；`nbOpen` 沒隔著縫的相鄰（往外長、選起整片走這個）
 */
export function regionInfo(mesh, tolDeg = FLAT_TOL_DEG) {
  planarRegions(mesh, tolDeg);
  const R = new Map();
  for (const f of mesh.faces) {
    if (!R.has(f.region)) R.set(f.region, { id: f.region, faces: [], area: 0, n: new THREE.Vector3(), nb: new Map(), nbOpen: new Map() });
    const r = R.get(f.region);
    r.faces.push(f);
    for (const [x, y, z] of mesh.faceTriangles(f)) {
      const c = new THREE.Vector3().subVectors(y.p, x.p).cross(new THREE.Vector3().subVectors(z.p, x.p));
      r.area += c.length() / 2;
      r.n.add(c);
    }
  }
  for (const r of R.values()) if (r.n.lengthSq() > 0) r.n.normalize();
  for (const he of mesh.edges()) {
    const a = he.face, b = he.twin && he.twin.face;
    if (!a || !b || a.region === b.region) continue;
    const L = he.v.p.distanceTo(he.to.p);
    const A = R.get(a.region), B = R.get(b.region);
    A.nb.set(b.region, (A.nb.get(b.region) || 0) + L);
    B.nb.set(a.region, (B.nb.get(a.region) || 0) + L);
    if (!isSeam(he)) {
      A.nbOpen.set(b.region, (A.nbOpen.get(b.region) || 0) + L);
      B.nbOpen.set(a.region, (B.nbOpen.get(a.region) || 0) + L);
    }
  }
  return R;
}

/** 面積小於門檻（mm²）的平面 ⇒ 碎面 */
export function tinyRegions(R, mm2 = TINY_MM2) {
  const lim = Math.max(0, +mm2 || 0) / 100;        // mm² → cm²
  return new Set([...R.values()].filter(r => r.area < lim).map(r => r.id));
}

/** 碎面跟著誰走：共用邊最長、而且不是碎面的鄰居（鄰居全是碎面 ⇒ 順著往下找；找不到 ⇒ null）*/
export function hostOf(R, rid, tiny) {
  const seen = new Set([rid]);
  let cur = rid;
  for (;;) {
    const nbs = [...R.get(cur).nb.entries()].sort((x, y) => y[1] - x[1]);
    const real = nbs.find(([id]) => !tiny.has(id));
    if (real) return real[0];
    const next = nbs.find(([id]) => !seen.has(id));
    if (!next) return null;
    seen.add(next[0]);
    cur = next[0];
  }
}

/** 選取加上「跟著它走」的碎面（碎面本身被選到也算）*/
export function withTiny(R, sel, tiny) {
  const out = new Set(sel);
  for (const t of tiny) if (!out.has(t) && out.has(hostOf(R, t, tiny))) out.add(t);
  return out;
}

/**
 * 往外長：從 `seed` 開始，沿著沒隔著縫的相鄰走，朝向跟 seed 差 `deg` 度以內的都加進來。
 * ⚠ 碎面的朝向不可靠（面積幾乎是 0）⇒ ⛔ 拿來判斷、⛔ 從它長出去；它們由 `withTiny()` 跟著走。
 */
export function growRegions(R, seed, deg = GROW_DEG, tiny = new Set()) {
  const lim = Math.max(0, Math.min(180, +deg || 0)) * Math.PI / 180;
  const n0 = R.get(seed).n;
  const out = new Set([seed]), q = [seed];
  while (q.length) {
    const r = q.pop();
    for (const t of R.get(r).nbOpen.keys()) {
      if (out.has(t) || tiny.has(t)) continue;
      if (R.get(t).n.angleTo(n0) <= lim + 1e-9) { out.add(t); q.push(t); }
    }
  }
  return out;
}

/** 選起整片：沿著沒隔著縫的相鄰走到底（＝ 展開時同一片）*/
export function pieceRegions(R, seed) {
  const out = new Set([seed]), q = [seed];
  while (q.length) {
    const r = q.pop();
    for (const t of R.get(r).nbOpen.keys()) if (!out.has(t)) { out.add(t); q.push(t); }
  }
  return out;
}

/** 選的面連成幾塊（看「有沒有共用邊」，隔著縫也算連著 —— 切下去之後縫裡面會拿掉）*/
export function components(R, sel) {
  const left = new Set(sel);
  let n = 0;
  while (left.size) {
    n++;
    const s = left.values().next().value;
    const q = [s]; left.delete(s);
    while (q.length) {
      const r = q.pop();
      for (const t of R.get(r).nb.keys()) if (left.has(t)) { left.delete(t); q.push(t); }
    }
  }
  return n;
}

/**
 * 切成一片：選的那群面（區域編號）外圈標縫、裡面的縫拿掉。
 * ⚠ 「不准切」的邊一律⛔ 碰（`setSeam()` 會把不准切蓋掉 ⇒ 這裡先擋）—— 10/13 硬規定「kang 標的照辦」。
 * ⚠ 呼叫前 `face.region` 要是 `regionInfo()` 那一次的標籤（同一份網格、中間沒改）。
 * @returns {{cut:number, uncut:number, blocked:number}} 新標的縫、拿掉的縫、因為不准切沒切的
 */
export function applyGroup(mesh, sel, tolDeg = FLAT_TOL_DEG) {
  let cut = 0, uncut = 0, blocked = 0;
  for (const he of mesh.edges()) {
    const a = he.face, b = he.twin && he.twin.face;
    if (!a || !b) continue;
    const inA = sel.has(a.region), inB = sel.has(b.region);
    if (inA !== inB) {
      if (isSeam(he)) continue;
      if (he.keep) { if (isMarkable(mesh, he, tolDeg)) blocked++; continue; }
      if (setSeam(mesh, he, true, tolDeg)) cut++;
    } else if (inA && inB && isSeam(he)) {
      if (setSeam(mesh, he, false, tolDeg)) uncut++;
    }
  }
  return { cut, uncut, blocked };
}

/**
 * 選的當下就檢查：在**副本**上照「切成一片」標縫、攤一次（物件本身一條縫都⛔ 動），
 * 找出選的那群面攤成幾片、有沒有疊、疊的是哪幾個面。
 * @param {object} opt 傳給 `unfoldObject()` 的（material、mode…）
 * @returns {{ok:boolean, reason?:string, pieces:object[], overlap:number, overlapPieces:object[]}}
 *   `pieces` ＝ 選的面所在的片（照理 1 片；⛔ 連在一起會多片）；每片有 `overlapFaces`（疊的面）
 */
export function checkGroup(obj, sel, opt = {}) {
  const twin = new ModelObject({ name: obj.name, src: { type: 'mesh' }, kind: obj.kind, thickness: obj.thickness });
  twin._mesh = obj.mesh().clone();
  twin.pos.copy(obj.pos); twin.rot.copy(obj.rot); twin.scale.copy(obj.scale);
  const m = twin.mesh();
  planarRegions(m);
  applyGroup(m, sel);
  const r = unfoldObject(twin, opt);
  if (!r.ok || !r.pieces) return { ok: false, reason: r.reason || '攤不出來', pieces: [], overlap: 0, overlapPieces: [] };
  /** 片 → 有沒有選到的面：用面的中心對（攤的那份網格吃了縮放 ⇒ 這邊也乘縮放）*/
  const s = obj.scale;
  const key = (x, y, z) => `${x.toFixed(4)},${y.toFixed(4)},${z.toFixed(4)}`;
  const selKeys = new Set();
  for (const f of m.faces) {
    if (!sel.has(f.region)) continue;
    const vs = m.faceVerts(f).map(v => v.p);
    const c = vs.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(vs.length);
    selKeys.add(key(c.x * s.x, c.y * s.y, c.z * s.z));
  }
  const pieces = r.pieces.filter(p => p.faces3 && p.faces3.some(poly => {
    const c = poly.reduce((a, q) => [a[0] + q[0], a[1] + q[1], a[2] + q[2]], [0, 0, 0]).map(v => v / poly.length);
    return selKeys.has(key(c[0], c[1], c[2]));
  }));
  const overlapPieces = pieces.filter(p => p.overlapFaces && p.overlapFaces.length);
  return { ok: true, pieces, overlap: overlapPieces.reduce((n, p) => n + p.overlapFaces.length, 0), overlapPieces };
}
