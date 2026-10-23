/**
 * quadify.js — 匯入時「兩兩合併」：共用一條邊的兩個三角形合成一個四邊形（網格核心第五批 b ⑤，2026-10-24 → `匯入整理-研究.md` 第 9 節 ④；
 * kang 2026-10-22 定「視窗放原樣、兩兩合併，預設建議兩兩合併；Instant Meshes 先當外部轉換器、寫一行說明」、
 * 2026-10-23「兩兩合併只合平的」）。
 *
 * Blender「Tris to Quads」同一個原理：兩個三角形夾角夠小（≤ 40°）、合出來的四個角夠接近直角（離 90° ≤ 40°）才合，代價小的先。
 * 🔴 **只合「合完還是平的」**（四個點離平面 ≤ `PLANAR_TOL_CM` ＝ 0.01 cm，跟琥珀色「不平的面」同一個容許值）——
 * 照 10-22 原型合，狐狸、頭盔會冒出幾十個不平的面（展開變近似）；只合平的一個都不冒，四邊形比例幾乎不變（`網格核心-研究.md` 10.2）。
 * 形狀一點都不變（只是把兩個三角形中間那條線拿掉）；四邊形多了，選一圈、環切比較走得動。
 */

import { PLANAR_TOL_CM } from '../core/edit.js';

/** 兩個三角形的夾角上限、四個角離 90° 的上限（度）*/
export const PAIR_MAX_FACE = 40, PAIR_MAX_SHAPE = 40;

/**
 * @param {number[][]} P 點（cm）
 * @param {number[][]} F 面（只會動三角形；四邊形、多邊形照原樣）
 * @returns {{faces:number[][], pairs:number}} `pairs` ＝ 合了幾對
 */
export function pairQuads(P, F, tol = PLANAR_TOL_CM) {
  const nrm = t => {
    const a = P[t[0]], b = P[t[1]], c = P[t[2]];
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx], l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  };
  const N = new Map(), E = new Map();
  F.forEach((t, i) => {
    if (t.length !== 3) return;
    N.set(i, nrm(t));
    for (let k = 0; k < 3; k++) { const a = t[k], b = t[(k + 1) % 3], key = a < b ? a + ',' + b : b + ',' + a; if (!E.has(key)) E.set(key, []); E.get(key).push([i, k]); }
  });
  const deg = x => Math.acos(Math.max(-1, Math.min(1, x))) * 180 / Math.PI;
  const cand = [];
  for (const l of E.values()) {
    if (l.length !== 2) continue;
    const [[f, k], [g]] = l, nf = N.get(f), ng = N.get(g);
    const fa = deg(nf[0] * ng[0] + nf[1] * ng[1] + nf[2] * ng[2]);
    if (fa > PAIR_MAX_FACE) continue;
    const t = F[f], a = t[k], b = t[(k + 1) % 3], c = t[(k + 2) % 3], d = F[g].find(v => v !== a && v !== b);
    if (d === undefined || d === c) continue;
    const q = [b, c, a, d];                                   // 繞向跟 f 一樣：a→b 是共用邊、拿掉後 b c a d
    let worst = 0;
    for (let i = 0; i < 4; i++) {
      const p = P[q[i]], u = P[q[(i + 3) % 4]], v = P[q[(i + 1) % 4]];
      const ux = u[0] - p[0], uy = u[1] - p[1], uz = u[2] - p[2], vx = v[0] - p[0], vy = v[1] - p[1], vz = v[2] - p[2];
      const ang = deg((ux * vx + uy * vy + uz * vz) / ((Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz)) || 1));
      worst = Math.max(worst, Math.abs(ang - 90));
      if (ang >= 179) worst = 999;
    }
    if (worst > PAIR_MAX_SHAPE) continue;
    // 合完還平嗎：Newell 法向定一個平面，四個點離它最遠多少
    let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0;
    for (let i = 0; i < 4; i++) {
      const A = P[q[i]], B = P[q[(i + 1) % 4]];
      nx += (A[1] - B[1]) * (A[2] + B[2]); ny += (A[2] - B[2]) * (A[0] + B[0]); nz += (A[0] - B[0]) * (A[1] + B[1]);
      cx += A[0] / 4; cy += A[1] / 4; cz += A[2] / 4;
    }
    const L = Math.hypot(nx, ny, nz);
    if (!L) continue;
    let dev = 0;
    for (const v of q) dev = Math.max(dev, Math.abs(((P[v][0] - cx) * nx + (P[v][1] - cy) * ny + (P[v][2] - cz) * nz) / L));
    if (dev > tol) continue;
    cand.push([worst + fa, f, g, q]);
  }
  cand.sort((x, y) => x[0] - y[0]);
  const used = new Uint8Array(F.length), out = [];
  let pairs = 0;
  for (const [, f, g, q] of cand) { if (used[f] || used[g]) continue; used[f] = used[g] = 1; out.push(q); pairs++; }
  F.forEach((t, i) => { if (!used[i]) out.push(t.slice()); });
  return { faces: out, pairs };
}
