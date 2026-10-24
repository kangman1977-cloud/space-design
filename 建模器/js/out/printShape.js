/**
 * printShape.js — 列印前檢查的「形狀」那三項：牆太薄、懸空、面互相穿過去
 * （2026-10-24，第二輪第四批 → `規格\建模器-STL匯出.md`「列印檢查補齊」；
 * kang「牆太薄預設 0.9 mm 可以改、黃色提醒；懸空預設 45° 可以改、藍色說明；面互相穿過去黃色提醒；三項都加指出來」）。
 *
 * 以前的列印前檢查只看「接得好不好」（封閉、方向、三面共用）⇒ 樹蛙腳趾比 0.9 mm 薄、有摺的平滑帽子面穿過去、
 * 飛機懸空 29% 都說「可以列印」（`實驗-綜合評估-第二輪.md` ②-4、②-5）。
 *
 * 做法（業界同一招 → `外部參考-3D列印與剖面分切.md` 第 6 節）：
 * - **牆太薄**：從面的中心往裡面打一條線，打到的最近的面 ＝ 那裡的厚度（Meshmixer、Blender 3D Print Toolbox）。
 *   面太多就照順序平均抽 `THIN_SAMPLES` 個（24 萬個三角形的飛機抽 2 萬個 0.3 秒）。
 * - **懸空**：面朝下、離垂直超過門檻（Blender 預設 45°）；貼平台的面（三點都在最低點 0.1 mm 以內）不算。
 * - **面互相穿過去**：三角形兩兩比（包圍盒樹先篩、共點的鄰居不比），比到 `CROSS_MAX_PAIRS` 對就停、照實講。
 *
 * 純計算、⛔ 碰畫面；吃 `stl.js` `triangles()` 的三角形（Z 朝上，單位照匯出單位，`mmPerUnit` 換成 mm）。
 */

export const DEFAULT_MIN_WALL_MM = 0.9;     // 0.4 噴嘴印兩圈（Prusa 知識庫）；面板可以改
export const DEFAULT_OVERHANG_DEG = 45;     // Blender 3D Print Toolbox 預設；面板可以改
export const THIN_SAMPLES = 20000;
export const CROSS_MAX_PAIRS = 2e7;
const BED_TOL_MM = 0.1;

/**
 * @param {{a,b,c,n}[]} tris
 * @param {{mmPerUnit?:number, minWallMM?:number, overhangDeg?:number}} opt
 * @returns {{thin, overhang, cross}} 每一項都有 `tris`（三角形的編號，給「指出來」）
 */
export function shapeCheck(tris, opt = {}) {
  const k = opt.mmPerUnit || 1;
  const minWall = opt.minWallMM ?? DEFAULT_MIN_WALL_MM;
  const ovDeg = opt.overhangDeg ?? DEFAULT_OVERHANG_DEG;
  const n = tris.length;
  const area = new Float64Array(n);
  let total = 0, zMin = Infinity;
  for (let i = 0; i < n; i++) {
    const { a, b, c } = tris[i];
    const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z, vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
    area[i] = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2 * k * k;
    total += area[i];
    zMin = Math.min(zMin, a.z, b.z, c.z);
  }

  // ── 懸空 ──
  const sinLim = Math.sin(ovDeg * Math.PI / 180), bed = zMin + BED_TOL_MM / k;
  const ovTris = [];
  let ovArea = 0;
  for (let i = 0; i < n; i++) {
    const t = tris[i];
    if (!(-t.n.z > sinLim)) continue;
    if (t.a.z <= bed && t.b.z <= bed && t.c.z <= bed) continue;
    ovTris.push(i); ovArea += area[i];
  }

  // ── 牆太薄 ──
  const tree = n ? buildTree(tris) : null;
  const N = Math.min(n, THIN_SAMPLES), step = n / (N || 1);
  const thinTris = [];
  let thinArea = 0, sampled = 0, minMM = Infinity;
  for (let s = 0; s < N; s++) {
    const i = Math.floor(s * step), t = tris[i];
    const ox = (t.a.x + t.b.x + t.c.x) / 3 - t.n.x * 1e-6, oy = (t.a.y + t.b.y + t.c.y) / 3 - t.n.y * 1e-6, oz = (t.a.z + t.b.z + t.c.z) / 3 - t.n.z * 1e-6;
    const d = castNearest(tree, tris, ox, oy, oz, -t.n.x, -t.n.y, -t.n.z, i);
    if (!Number.isFinite(d)) continue;            // 打不到東西（開放的面、朝內的面）⇒ 不算
    const mm = d * k;
    sampled += area[i];
    if (mm < minMM) minMM = mm;
    if (mm < minWall) { thinTris.push(i); thinArea += area[i]; }
  }

  // ── 面互相穿過去 ──
  const cross = n ? crossings(tris, tree) : { hit: new Set(), cut: false };
  let crossArea = 0;
  for (const i of cross.hit) crossArea += area[i];

  return {
    totalMM2: total,
    overhang: { deg: ovDeg, tris: ovTris, areaMM2: ovArea, pct: total ? ovArea / total : 0 },
    thin: { minWallMM: minWall, tris: thinTris, areaMM2: thinArea, pct: sampled ? thinArea / sampled : 0,
      minMM: Number.isFinite(minMM) ? minMM : null, sampled: N < n ? N : 0 },
    cross: { tris: [...cross.hit].sort((p, q) => p - q), areaMM2: crossArea, pct: total ? crossArea / total : 0, cut: cross.cut }
  };
}

// ═══ 底層：三角形包圍盒樹、打線、兩兩相交 ═══

function buildTree(tris) {
  const n = tris.length, idx = new Int32Array(n), bb = new Float64Array(n * 6), cen = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const { a, b, c } = tris[i];
    idx[i] = i;
    bb[i * 6] = Math.min(a.x, b.x, c.x); bb[i * 6 + 1] = Math.min(a.y, b.y, c.y); bb[i * 6 + 2] = Math.min(a.z, b.z, c.z);
    bb[i * 6 + 3] = Math.max(a.x, b.x, c.x); bb[i * 6 + 4] = Math.max(a.y, b.y, c.y); bb[i * 6 + 5] = Math.max(a.z, b.z, c.z);
    cen[i * 3] = (a.x + b.x + c.x) / 3; cen[i * 3 + 1] = (a.y + b.y + c.y) / 3; cen[i * 3 + 2] = (a.z + b.z + c.z) / 3;
  }
  const make = (lo, hi) => {
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let j = lo; j < hi; j++) {
      const o = idx[j] * 6;
      for (let q = 0; q < 3; q++) { box[q] = Math.min(box[q], bb[o + q]); box[q + 3] = Math.max(box[q + 3], bb[o + q + 3]); }
    }
    const node = { box, lo, hi, l: null, r: null };
    if (hi - lo <= 8) return node;
    const ext = [box[3] - box[0], box[4] - box[1], box[5] - box[2]];
    const ax = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
    const part = Array.from(idx.subarray(lo, hi)).sort((p, q) => cen[p * 3 + ax] - cen[q * 3 + ax]);
    idx.set(part, lo);
    const mid = (lo + hi) >> 1;
    node.l = make(lo, mid); node.r = make(mid, hi);
    return node;
  };
  return { root: make(0, n), idx };
}

/** 從 (ox,oy,oz) 往 (dx,dy,dz) 打，最近打到的面多遠（⛔ 算自己那一面）；打不到 ⇒ Infinity */
function castNearest(tree, tris, ox, oy, oz, dx, dy, dz, skip) {
  let best = Infinity;
  const st = [tree.root];
  while (st.length) {
    const nd = st.pop();
    if (!rayBox(ox, oy, oz, dx, dy, dz, nd.box, best)) continue;
    if (nd.l) { st.push(nd.l, nd.r); continue; }
    for (let j = nd.lo; j < nd.hi; j++) {
      const i = tree.idx[j];
      if (i === skip) continue;
      const t = rayTri(ox, oy, oz, dx, dy, dz, tris[i]);
      if (t > 1e-9 && t < best) best = t;
    }
  }
  return best;
}

function rayBox(ox, oy, oz, dx, dy, dz, b, tmax) {
  let t0 = 0, t1 = tmax;
  const O = [ox, oy, oz], D = [dx, dy, dz];
  for (let q = 0; q < 3; q++) {
    const inv = 1 / D[q];
    let a = (b[q] - O[q]) * inv, c = (b[q + 3] - O[q]) * inv;
    if (a > c) { const s = a; a = c; c = s; }
    if (a > t0) t0 = a;
    if (c < t1) t1 = c;
    if (t0 > t1) return false;
  }
  return true;
}

/** Möller–Trumbore；沒打到 ⇒ Infinity */
function rayTri(ox, oy, oz, dx, dy, dz, { a, b, c }) {
  const e1x = b.x - a.x, e1y = b.y - a.y, e1z = b.z - a.z, e2x = c.x - a.x, e2y = c.y - a.y, e2z = c.z - a.z;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-15) return Infinity;
  const inv = 1 / det, tx = ox - a.x, ty = oy - a.y, tz = oz - a.z;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return Infinity;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return Infinity;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

/** 兩兩比：包圍盒樹兩棵一起走；共點（位置一樣）的鄰居⛔ 比；超過 `CROSS_MAX_PAIRS` 對就停（`cut`）*/
function crossings(tris, tree) {
  const key = p => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)},${Math.round(p.z * 1e5)}`;
  const vk = tris.map(t => [key(t.a), key(t.b), key(t.c)]);
  const hit = new Set();
  let pairs = 0;
  const ov = (p, q) => p[0] <= q[3] && q[0] <= p[3] && p[1] <= q[4] && q[1] <= p[4] && p[2] <= q[5] && q[2] <= p[5];
  const st = [[tree.root, tree.root]];
  while (st.length) {
    const [p, q] = st.pop();
    if (!ov(p.box, q.box)) continue;
    if (!p.l && !q.l) {
      for (let x = p.lo; x < p.hi; x++) {
        for (let y = q.lo; y < q.hi; y++) {
          const i = tree.idx[x], j = tree.idx[y];
          if (i >= j) continue;
          if (vk[i].some(s => vk[j].includes(s))) continue;
          if (++pairs > CROSS_MAX_PAIRS) return { hit, cut: true };
          if (triTri(tris[i], tris[j])) { hit.add(i); hit.add(j); }
        }
      }
      continue;
    }
    if (p === q) { st.push([p.l, p.l], [p.l, p.r], [p.r, p.r]); continue; }
    if (!p.l) st.push([p, q.l], [p, q.r]);
    else if (!q.l) st.push([p.l, q], [p.r, q]);
    else st.push([p.l, q.l], [p.l, q.r], [p.r, q.l], [p.r, q.r]);
  }
  return { hit, cut: false };
}

/**
 * 兩個三角形有沒有穿過去：分離軸（兩個法向 ＋ 9 條邊的叉積），任何一條軸上分得開 ⇒ 沒有。
 * 只碰到（擋在軸上剛好相切）不算，留一點容許值。
 */
function triTri(A, B) {
  const P = [A.a, A.b, A.c], Q = [B.a, B.b, B.c];
  const sub = (u, v) => [u.x - v.x, u.y - v.y, u.z - v.z];
  const cr = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const ea = [sub(P[1], P[0]), sub(P[2], P[1]), sub(P[0], P[2])], eb = [sub(Q[1], Q[0]), sub(Q[2], Q[1]), sub(Q[0], Q[2])];
  const axes = [cr(ea[0], ea[1]), cr(eb[0], eb[1])];
  for (const u of ea) for (const v of eb) axes.push(cr(u, v));
  for (const ax of axes) {
    const L = Math.hypot(ax[0], ax[1], ax[2]);
    if (L < 1e-12) continue;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of P) { const d = ax[0] * p.x + ax[1] * p.y + ax[2] * p.z; if (d < a0) a0 = d; if (d > a1) a1 = d; }
    for (const p of Q) { const d = ax[0] * p.x + ax[1] * p.y + ax[2] * p.z; if (d < b0) b0 = d; if (d > b1) b1 = d; }
    const tol = 1e-7 * L;
    if (a1 <= b0 + tol || b1 <= a0 + tol) return false;
  }
  return true;
}
