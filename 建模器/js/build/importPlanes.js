/**
 * importPlanes.js — 匯入時每一片平面各自判斷（網格核心第五批 b ②，2026-10-23 → `規格\建模器-網格核心.md` 第 4 節、
 * `網格核心-研究.md` 8.2、10.7；kang 2026-10-23「第 ② 小批照你的建議：先判斷再清碎面、碎塊維持看不見、視窗加三選一預設照建議」）
 *
 * 同一個模型兩種都有（iPhone：螢幕外框是匯出時切的碎塊，機身是一格一格畫的四邊形）⇒ ⛔ 整個模型判一次，
 * 每一片平面（`planarRegions()`，跟畫面同一支）各自看：
 *   - **碎塊**：裡面有三角形、或細長的塊（最小角 < 15°、或 最長邊² ÷ 2 面積 > 6）⇒ 合成一個面
 *     —— 維持原本的樣子（中間的線看不見），⛔ 真的合成一個多邊形（工地帽試過：智慧分切 1 片 → 60 片、有重疊）
 *   - **格子**：全是不細長的四邊形／多邊形 ⇒ 照原檔一格一格，格線標 `hard`（看得見、點得到，跟建模器自己細分的一樣）
 * 🔴 **要在清碎面之前判斷**，照原檔的那幾片平面的點清碎面⛔ 動（`collapseShort(p, tol, keep)`）——
 * 先清的話 iPhone 機身的格子 1,282 片只剩 31 片（細格子的邊比門檻短，被一路縮掉）。
 * 判斷、門檻都跟大小、朝上無關（只看角度與比例）⇒ 視窗換單位、換朝上⛔ 重算。
 */

import * as THREE from 'three';
import { Mesh } from '../core/mesh.js';
import { planarRegions } from '../core/region.js';

/** 視窗的三選一（預設照建議）*/
export const PLANE_MODES = { suggest: '照建議', merge: '全部合成一個面', keep: '全部照原檔一格一格' };
/** 細長的塊：最小的角比這個小（度）*/
export const SLIVER_MIN_DEG = 15;
/** 細長的塊：最長邊² ÷ (2 × 面積) 比這個大（正方形 0.5、2 × 1 的長方形 1、6 ＝ 大約 12 × 1）*/
export const SLIVER_RATIO = 6;

/**
 * 一個部分（`toParts()` 的一個，清碎面之前）每一片「好幾塊拼成」的平面判斷一次。
 * @param {{points:number[][], faces:number[][]}} p
 * @returns {{regions:{faces:number[], cut:boolean}[], cut:number, grid:number, cutFaces:number, gridFaces:number}}
 *   `regions` 只列兩塊以上的平面；`faces` 是 `p.faces` 的編號
 */
export function judgePlanes(p) {
  const idx = [];                                       // mesh 的第幾個面 ⇒ p.faces 的第幾個（只有 3 點以上的會建）
  p.faces.forEach((f, i) => { if (f.length >= 3) idx.push(i); });
  const m = Mesh.fromFaceList(p.points.map(q => new THREE.Vector3(q[0], q[1], q[2])), idx.map(i => p.faces[i]));
  const fi = new Map(m.faces.map((f, k) => [f, idx[k]]));
  const out = { regions: [], cut: 0, grid: 0, cutFaces: 0, gridFaces: 0 };
  for (const r of planarRegions(m)) {
    if (r.faces.length < 2) continue;
    const faces = r.faces.map(f => fi.get(f));
    const cut = faces.some(i => isSliver(p.points, p.faces[i]));
    out.regions.push({ faces, cut });
    if (cut) { out.cut++; out.cutFaces += faces.length; } else { out.grid++; out.gridFaces += faces.length; }
  }
  return out;
}

/** 這一塊是不是「匯出時切出來的」：三角形、或細長 */
export function isSliver(P, f) {
  const n = f.length;
  if (n === 3) return true;
  let minA = 180, longE = 0;
  for (let i = 0; i < n; i++) {
    const c = P[f[i]], a = sub(P[f[(i + n - 1) % n]], c), b = sub(P[f[(i + 1) % n]], c);
    const la = len(a), lb = len(b);
    if (!(la > 0) || !(lb > 0)) return true;
    minA = Math.min(minA, Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb)))) * 180 / Math.PI);
    longE = Math.max(longE, lb);
  }
  let area = 0;
  for (let i = 1; i + 1 < n; i++) area += len(cross(sub(P[f[i]], P[f[0]]), sub(P[f[i + 1]], P[f[0]]))) / 2;
  return minA < SLIVER_MIN_DEG || longE * longE / (2 * area || 1e-12) > SLIVER_RATIO;
}

/** 照這個選擇，哪幾片平面照原檔一格一格 */
export function keptRegions(judged, mode) {
  if (mode === 'merge') return [];
  if (mode === 'keep') return judged.regions;
  return judged.regions.filter(r => !r.cut);
}

/** 照原檔的那幾片平面用到的點（`p` 的編號）—— 清碎面⛔ 動它們 */
export function keepVerts(p, regions) {
  const s = new Set();
  for (const r of regions) for (const i of r.faces) for (const v of p.faces[i]) s.add(v);
  return s;
}

/**
 * 清碎面之後，照原檔的那幾片平面裡面的線（兩邊都是同一片平面的邊）：`"小-大"` 的點編號（清過之後的編號）。
 * @param {{faces:number[][]}} q 清過的部分（沒清就是原本那個）
 * @param {number[]} from `q.faces[k]` 是原本的第幾個面（`collapseShort()` 給的；沒清就是 0、1、2…）
 */
export function gridEdges(q, regions, from) {
  const rid = new Map();
  regions.forEach((r, k) => { for (const i of r.faces) rid.set(i, k); });
  const seen = new Map(), out = new Set();
  q.faces.forEach((f, k) => {
    const g = rid.get(from[k]);
    if (g === undefined) return;
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length], key = a < b ? a + '-' + b : b + '-' + a;
      if (seen.get(key) === g) out.add(key);
      else seen.set(key, g);
    }
  });
  return out;
}

/** 建好的網格上把那幾條線標 `hard`（點的編號 ＝ 建網格時的編號）；回傳標了幾條 */
export function markGrid(mesh, edges) {
  if (!edges.size) return 0;
  const vi = mesh._vertIndex();
  let n = 0;
  for (const he of mesh.edges()) {
    const a = vi.get(he.v.id), b = vi.get(he.twin ? he.twin.v.id : -1);
    if (b === undefined) continue;
    if (edges.has(a < b ? a + '-' + b : b + '-' + a)) { mesh.setHard(he, true); n++; }
  }
  return n;
}

const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const len = u => Math.hypot(u[0], u[1], u[2]);
