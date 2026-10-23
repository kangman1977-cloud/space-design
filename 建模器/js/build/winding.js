/**
 * winding.js — 一個點在不在裡面（環繞數），與「被任何面包住就算實心」的剖面面積
 * （網格核心第五批 b ③b，2026-10-24 → `匯入整理-研究.md` 第 11 節；kang 2026-10-24「③b 照你的建議：只修剖面比得過的，其他照原樣另外放、講出來」）
 *
 * 環繞數 ＝ 所有三角形對這個點張開的立體角加總 ÷ 4π：封閉、朝外的實體裡面是 1、外面是 0；
 * 表面有洞、有隔板也算得出一個合理的值（「廣義環繞數」）—— 拆片判「外皮／隔板」靠它。
 * 🔴 **快，但⛔ 犧牲對**：照 Barill 等 2018（SIGGRAPH「Fast Winding Numbers for Soups and Clouds」）的一階版 ——
 * 三角形分成二元樹，遠的一群用一個偶極子代替（iPhone 機身一次 15 毫秒 → 0.08 毫秒）；
 * 它有誤差（實測最大 0.29），所以**落在 0.2～0.8 之間（不夠確定）的改用精確的重算**（PROJECT_LOG「算得對第一」）。
 */

/** 不夠確定的範圍：快速算出來落在這中間就精確重算 */
export const UNSURE = [0.2, 0.8];

/**
 * 建樹。
 * @param {number[][]} P 點
 * @param {number[][]} T 三角形（點的編號）
 */
export function windTree(P, T, leaf = 8) {
  const n = T.length, cen = new Float64Array(n * 3), an = new Float64Array(n * 3), ar = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = P[T[i][0]], b = P[T[i][1]], c = P[T[i][2]];
    for (let k = 0; k < 3; k++) cen[i * 3 + k] = (a[k] + b[k] + c[k]) / 3;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    an[i * 3] = nx / 2; an[i * 3 + 1] = ny / 2; an[i * 3 + 2] = nz / 2; ar[i] = Math.hypot(nx, ny, nz) / 2;
  }
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  const nodes = [];
  const make = (lo, hi) => {
    const nd = { lo, hi, left: -1, right: -1, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, r: 0 };
    const id = nodes.length; nodes.push(nd);
    let A = 0; const bl = [Infinity, Infinity, Infinity], bh = [-Infinity, -Infinity, -Infinity];
    for (let q = lo; q < hi; q++) {
      const i = idx[q], w = ar[i] || 1e-30;
      A += w; nd.px += cen[i * 3] * w; nd.py += cen[i * 3 + 1] * w; nd.pz += cen[i * 3 + 2] * w;
      nd.nx += an[i * 3]; nd.ny += an[i * 3 + 1]; nd.nz += an[i * 3 + 2];
      for (let k = 0; k < 3; k++) { const c = cen[i * 3 + k]; if (c < bl[k]) bl[k] = c; if (c > bh[k]) bh[k] = c; }
    }
    nd.px /= A; nd.py /= A; nd.pz /= A;
    for (let q = lo; q < hi; q++) for (const v of T[idx[q]]) { const p = P[v]; nd.r = Math.max(nd.r, Math.hypot(p[0] - nd.px, p[1] - nd.py, p[2] - nd.pz)); }
    if (hi - lo > leaf) {
      let ax = 0; for (let k = 1; k < 3; k++) if (bh[k] - bl[k] > bh[ax] - bl[ax]) ax = k;
      const part = Array.from(idx.subarray(lo, hi)).sort((a, b) => cen[a * 3 + ax] - cen[b * 3 + ax]);
      idx.set(part, lo);
      const mid = (lo + hi) >> 1;
      nd.left = make(lo, mid); nd.right = make(mid, hi);
    }
    return id;
  };
  if (n) make(0, n);
  return { P, T, idx, nodes };
}

/** 一個三角形對 q 張開的立體角（Van Oosterom & Strackee）*/
function solid(P, t, q) {
  const a = P[t[0]], b = P[t[1]], c = P[t[2]];
  const ax = a[0] - q[0], ay = a[1] - q[1], az = a[2] - q[2], bx = b[0] - q[0], by = b[1] - q[1], bz = b[2] - q[2], cx = c[0] - q[0], cy = c[1] - q[1], cz = c[2] - q[2];
  const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz), lc = Math.hypot(cx, cy, cz);
  const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  return 2 * Math.atan2(det, la * lb * lc + (ax * bx + ay * by + az * bz) * lc + (bx * cx + by * cy + bz * cz) * la + (cx * ax + cy * ay + cz * az) * lb);
}

/** 精確的環繞數（每個三角形都算）*/
export function windExact(P, T, q) {
  let s = 0;
  for (const t of T) s += solid(P, t, q);
  return s / (4 * Math.PI);
}

/** 快速版（樹＋偶極子，β ＝ 2）*/
export function windFast(W, q, beta = 2) {
  const { P, T, idx, nodes } = W;
  if (!nodes.length) return 0;
  let s = 0; const st = [0];
  while (st.length) {
    const nd = nodes[st.pop()];
    const dx = nd.px - q[0], dy = nd.py - q[1], dz = nd.pz - q[2], d = Math.hypot(dx, dy, dz);
    if (d > beta * nd.r) { s += (dx * nd.nx + dy * nd.ny + dz * nd.nz) / (d * d * d); continue; }
    if (nd.left < 0) { for (let k = nd.lo; k < nd.hi; k++) s += solid(P, T[idx[k]], q); continue; }
    st.push(nd.left, nd.right);
  }
  return s / (4 * Math.PI);
}

/** 先快速、不夠確定才精確；`stat` 記算了幾次、精確幾次 */
export function windSure(W, q, stat) {
  const f = windFast(W, q);
  if (stat) stat.calls++;
  if (f > UNSURE[0] && f < UNSURE[1]) { if (stat) stat.exact++; return windExact(W.P, W.T, q); }
  return f;
}

/**
 * 剖面面積，「被任何面包住就算實心」（非零規則，跟 10-22 原型 `rasterSlice` 同一個想法）：
 * 在 `axis` ＝ `value` 那一刀，沿另一軸一列一列掃，每列照面的方向數進出，非零的那段算進去。
 * 修前（有隔板、有破洞也算得出來）、修後用**同一支**量 ⇒ 掃描的誤差兩邊一樣、互相抵掉。
 * @returns {number} 面積（點的單位²）
 */
export function sliceArea(P, T, axis, value, rows = 400) {
  const X = (axis + 1) % 3, Z = (axis + 2) % 3;
  let zl = Infinity, zh = -Infinity;
  for (const p of P) { if (p[Z] < zl) zl = p[Z]; if (p[Z] > zh) zh = p[Z]; }
  const dz = (zh - zl) / rows || 1;
  const hit = Array.from({ length: rows }, () => []);
  for (const t of T) {
    const up = t.map(v => P[v][axis] >= value);
    if (up[0] === up[1] && up[1] === up[2]) continue;
    const hs = [];
    for (let k = 0; k < 3; k++) {
      const m = (k + 1) % 3;
      if (up[k] === up[m]) continue;
      const A = P[t[k]], B = P[t[m]], s = (value - A[axis]) / (B[axis] - A[axis]);
      hs.push({ x: A[X] + s * (B[X] - A[X]), z: A[Z] + s * (B[Z] - A[Z]), goingUp: !up[k] });
    }
    if (hs.length !== 2) continue;
    const a = hs[0].goingUp ? hs[1] : hs[0], b = hs[0].goingUp ? hs[0] : hs[1];
    if (a.z === b.z) continue;
    const lo = Math.min(a.z, b.z), hi = Math.max(a.z, b.z), sg = b.z > a.z ? 1 : -1;
    for (let r = Math.max(0, Math.ceil((lo - zl) / dz - 0.5)); r < rows; r++) {
      const z = zl + (r + 0.5) * dz;
      if (z >= hi) break;
      if (z < lo) continue;
      hit[r].push([a.x + (z - a.z) / (b.z - a.z) * (b.x - a.x), sg]);
    }
  }
  let area = 0;
  for (const xs of hit) {
    if (!xs.length) continue;
    xs.sort((p, q) => p[0] - q[0]);
    let wn = 0, st = 0;
    for (const [x, s] of xs) { const was = wn !== 0; wn += s; if (!was && wn !== 0) st = x; else if (was && wn === 0) area += x - st; }
  }
  return area * dz;
}

/**
 * 修前修後比剖面：沿最長的那一軸切 `cuts` 刀，每一刀的面積差 ÷ 修前最大的那一刀（⛔ 除以那一刀自己 —— 頭尾很小的刀會被放大）。
 * @returns {{worst:number, cuts:number}} `worst` ＝ 最大的差（0.01 ＝ 1%）
 */
export function sectionDiff(P0, T0, P1, T1, cuts = 20) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of P0) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  let ax = 0; for (let k = 1; k < 3; k++) if (hi[k] - lo[k] > hi[ax] - lo[ax]) ax = k;
  const a0 = [], a1 = [];
  for (let s = 0; s < cuts; s++) {
    const v = lo[ax] + (hi[ax] - lo[ax]) * (s + 0.5) / cuts;
    a0.push(sliceArea(P0, T0, ax, v)); a1.push(sliceArea(P1, T1, ax, v));
  }
  const big = Math.max(...a0) || 1;
  let worst = 0;
  for (let s = 0; s < cuts; s++) worst = Math.max(worst, Math.abs(a1[s] - a0[s]) / big);
  return { worst, cuts };
}
