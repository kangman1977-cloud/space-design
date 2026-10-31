/**
 * symmetry.js — 對稱減面（2026-10-31 → `規格\建模器-匯入3D模型.md`「左右對稱減面」、`三視圖導入-研究.md` 實驗 6、12；
 * kang 2026-10-31「照你的建議」(a)～(i)）
 *
 * 混元這類 AI 生成的面具、獅子頭左右 99.7～100% 對稱，但一般減面完點只有 0～40% 左右對得上 ⇒ 紙模左右的展開片不一樣。
 * 做法（業界 SeamSmith、Blender 社群、DAZ 使用者同一招；⛔ Blender 那種「兩邊的點成對一起合」—— 要原檔左右的點剛好配得上）：
 *   **在鏡射面切開 → 只減一半到一半的面數（切口的點只能在鏡射面上，`decimate()` 的 `plane`）→ 鏡射接回**
 * ⇒ 網格完全對稱、展開片左右成對、快一倍；本來就對稱的形狀幾乎不變（平均多偏 0～0.03 mm），不太對稱的會被改成對稱（所以先量）。
 * 都在檔案單位、檔案的座標（跟減面一樣）；軸是檔案的第幾軸，視窗自己換成建模器的左右／上下／前後。
 */

import { decimate, boxTree, nearest } from './decimate.js';
import { edgeCheck } from './import3d.js';
import { components } from './importSolid.js';

/** 量對稱：表面上取這麼多點（點＋面中心，固定亂數）*/
export const SYM_SAMPLES = 1500;
/** 鏡射過去到原本表面 < 高 × 這個 ⇒ 算對得上 */
export const SYM_TOL = 0.005;
/** 這麼對稱以上 ⇒ 出現、預設打勾；`SYM_SHOW` 以上 ⇒ 出現、預設不勾；更低 ⇒ 不出現（kang 2026-10-31 (d)）*/
export const SYM_ON = 0.99;
export const SYM_SHOW = 0.9;

/**
 * 量三個軸各有多對稱（鏡射面在中間 ±3% 找最好的位置）。
 * @param {{points:number[][], faces:number[][]}} p 一個部分（檔案單位）
 * @param {number} height 高（檔案單位；`SYM_TOL` 照它算）
 * @returns {{axes:{within:number, c:number}[], best:number}} `axes[k]` ＝ 第 k 軸；`best` ＝ 最對稱的那一軸
 */
export function symmetryOf(p, height) {
  const P = p.points, T = [];
  for (const f of p.faces) for (let k = 1; k + 1 < f.length; k++) T.push([f[0], f[k], f[k + 1]]);
  if (!T.length) return { axes: [0, 1, 2].map(() => ({ within: 0, c: 0 })), best: 0 };
  const tree = boxTree(P, T);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const q of P) for (let k = 0; k < 3; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; }   // ⛔ Math.min(...大陣列)：汽車會爆堆疊
  let seed = 1;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const pick = [];
  const nS = P.length + T.length;
  for (let n = 0; n < Math.min(SYM_SAMPLES, nS); n++) {
    const i = nS <= SYM_SAMPLES ? n : Math.floor(rnd() * nS);
    pick.push(i < P.length ? P[i] : [0, 1, 2].map(k => (P[T[i - P.length][0]][k] + P[T[i - P.length][1]][k] + P[T[i - P.length][2]][k]) / 3));
  }
  const tol = (height > 0 ? height : Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])) * SYM_TOL;
  const score = (ax, c) => { let n = 0; for (const q of pick) { const m = q.slice(); m[ax] = 2 * c - q[ax]; if (nearest(tree, m) < tol) n++; } return n / pick.length; };
  const axes = [0, 1, 2].map(ax => {
    const mid = (lo[ax] + hi[ax]) / 2, ext = hi[ax] - lo[ax];
    let best = { c: mid, within: score(ax, mid) };
    if (best.within < SYM_ON) {                         // 正中間就夠對稱 ⇒ 不用找（混元的都是這樣，省時間）
      for (let s = -6; s <= 6; s++) { if (!s) continue; const c = mid + ext * 0.005 * s, w = score(ax, c); if (w > best.within) best = { c, within: w }; }
      const c0 = best.c;
      for (let s = -4; s <= 4; s++) { if (!s) continue; const c = c0 + ext * 0.00125 * s, w = score(ax, c); if (w > best.within) best = { c, within: w }; }
    }
    return best;
  });
  return { axes, best: [0, 1, 2].reduce((a, b) => (axes[b].within > axes[a].within ? b : a), 0) };
}

/** 切一半：留 `side`（−1／+1）那一邊；跨過鏡射面的面切開、切口的點共用；整個躺在鏡射面上的面不要（鏡射後會重複）*/
export function cutHalf(p, ax, c, side, eps) {
  const P = p.points.map(q => q.slice());
  for (const q of P) if (Math.abs(q[ax] - c) <= eps) q[ax] = c;
  const s = P.map(q => (c - q[ax]) * side);              // ≤ 0 ＝ 留下來那邊
  const cut = new Map(), faces = [];
  let inPlane = 0;
  const mid = (a, b) => {
    const k = a < b ? a + ',' + b : b + ',' + a;
    if (!cut.has(k)) { const t = s[a] / (s[a] - s[b]), q = P[a].map((x, j) => x + (P[b][j] - x) * t); q[ax] = c; cut.set(k, P.length); P.push(q); s.push(0); }
    return cut.get(k);
  };
  for (const f of p.faces) {
    const ss = f.map(v => s[v]);
    if (ss.every(x => x === 0)) { inPlane++; continue; }
    if (ss.every(x => x <= 0)) { faces.push(f.slice()); continue; }
    if (ss.every(x => x >= 0)) continue;
    const o = [];
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length];
      if (s[a] <= 0) o.push(a);
      if ((s[a] < 0 && s[b] > 0) || (s[a] > 0 && s[b] < 0)) o.push(mid(a, b));
    }
    const t = o.filter((v, k) => v !== o[(k + 1) % o.length]);
    if (t.length >= 3) faces.push(t);
  }
  const used = new Map(), pts = [];
  const F = faces.map(f => f.map(v => { if (!used.has(v)) { used.set(v, pts.length); pts.push(P[v]); } return used.get(v); }));
  return { ...p, points: pts, faces: F, inPlane };
}

/** 鏡射接回：另一半 ＝ 鏡射＋面反過來；剛好在鏡射面上的點共用 */
export function mirrorWeld(h, ax, c) {
  const n = h.points.length, map = new Int32Array(n), pts = h.points.map(q => q.slice());
  for (let i = 0; i < n; i++) {
    if (h.points[i][ax] === c) { map[i] = i; continue; }
    const q = h.points[i].slice(); q[ax] = 2 * c - q[ax]; map[i] = pts.length; pts.push(q);
  }
  return { ...h, points: pts, faces: [...h.faces, ...h.faces.map(f => f.map(v => map[v]).reverse())] };
}

/**
 * 對稱減面：切一半 → 減到一半的面數 → 鏡射接回；做出來塊數或破洞邊比原本多 ⇒ `bad` 寫原因（呼叫的人改用一般減面 —— kang (g)）。
 * @returns {{points, faces, from:number[], stats, bad:string}}
 */
export function symDecimate(p, { target, ax, c, side = -1, noCross = false, crossCap } = {}) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const q of p.points) for (let k = 0; k < 3; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; }
  const eps = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1e-7;
  const h = cutHalf(p, ax, c, side, eps);
  const d = decimate(h, { target: Math.max(4, Math.round(target / 2)), noCross, crossCap, plane: { ax, c, eps, side } });
  const w = mirrorWeld(d, ax, c);
  const bad = symProblem(p, w);
  return { ...w, from: w.faces.map(() => -1), stats: { ...d.stats, half: h.faces.length, inPlane: h.inPlane }, bad };   // 切過、鏡射過 ⇒ 沒有「原本第幾個面」
}

/**
 * 對稱減面做出來對不對（kang 2026-10-31 (g)）：塊數、破洞邊比原本多，或有三面共用的邊 ⇒ 原因；沒問題 ⇒ ''
 * （實驗 12：薄殼原樣直接對稱減，獅子頭 1,290 面、面具 3 變成 2 塊）
 */
export function symProblem(before, after) {
  const p0 = components(before.faces, before.points.length).length, o0 = edgeCheck(before.faces).open;
  const e = edgeCheck(after.faces), pieces = components(after.faces, after.points.length).length;
  return pieces > p0 ? `對稱減面做出來分成 ${pieces} 塊（原本 ${p0} 塊）`
    : e.open > o0 ? `對稱減面做出來多了破洞（${e.open - o0} 條邊沒接上）`
    : e.nonManifold ? `對稱減面做出來有 ${e.nonManifold} 條邊被三個以上的面共用` : '';
}
