/**
 * decimate.js — 保形狀減面（二次誤差，Garland & Heckbert 1997；Blender Decimate 的 Collapse、MeshLab、VTK 同一個原理）
 * 網格核心第五批 b ④，2026-10-24 → `匯入整理-研究.md` 第 9 節 ②⑤、第 12 節；
 * kang 2026-10-22 定「清碎面換成保形狀減面（同一個門檻決定減多少、點放在誤差最小的位置）、超過一成停下來給 kang 看」
 * 與「減面預設不減、減到 ___ 面＋三個快捷」；kang 2026-10-24「第 ④ 小批照你的建議：減到 N 面時不保護格子、視窗用卡片、減到 N 面點了才算」。
 *
 * 每個點記「到周圍面的平面距離平方」的加總（面用 Newell 法向、乘面積 —— 吃多邊形，⛔ 先拆三角形；
 * OBJ 的四邊形照樣是四邊形）；破洞邊加一道牆讓洞口不亂跑。每次合併「代價最小」的一條邊，點放在誤差最小的位置。
 * 會壞就不合（照 `collapseShort()`）：面翻過去（夾角超過 78° 就算）、多出同一組點的面、破洞或三面共用的邊變多。
 * 汽車同樣減 78.5%：兩端合到中點最多偏 0.1 mm，這個 0.005 mm（慢約 3 倍）。
 */

/**
 * @param {{points:number[][], faces:number[][]}} p 一個部分
 * @param {{target?:number, maxLen?:number, keep?:Set<number>|null}} opt
 *   `target` 減到幾個面（0 ＝ 不限）；`maxLen` 只合比這個短的邊；`keep` 這些點不動（第 ② 小批照原檔的格子）
 * @returns {{points, faces, from, stats:{collapsed, refused, removed, maxMove}}}
 *   `from[k]` ＝ 減完的第 k 個面是原本第幾個；`maxMove` ＝ 原本的點最多被搬多遠（點的單位）
 */
export function decimate(p, { target = 0, maxLen = Infinity, keep = null } = {}) {
  const P = p.points.map(q => q.slice());
  const faces = p.faces.map(f => f.slice());
  const alive = faces.map(() => true);
  const nV = P.length;
  const vf = P.map(() => new Set());
  faces.forEach((f, i) => f.forEach(v => vf[v].add(i)));
  const ek = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
  const cnt = new Map();
  const addF = (f, d) => { for (let k = 0; k < f.length; k++) { const key = ek(f[k], f[(k + 1) % f.length]); cnt.set(key, (cnt.get(key) || 0) + d); } };
  faces.forEach(f => addF(f, 1));

  // ── 每個點的二次誤差 ──
  const Q = Array.from({ length: nV }, () => new Float64Array(10));
  const addPlane = (q, n, d, w) => {
    const [a, b, c] = n;
    q[0] += w * a * a; q[1] += w * a * b; q[2] += w * a * c; q[3] += w * a * d; q[4] += w * b * b;
    q[5] += w * b * c; q[6] += w * b * d; q[7] += w * c * c; q[8] += w * c * d; q[9] += w * d * d;
  };
  const newell = f => {
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < f.length; k++) {
      const a = P[f[k]], b = P[f[(k + 1) % f.length]];
      x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]);
    }
    return [x / 2, y / 2, z / 2];
  };
  for (const f of faces) {
    const n = newell(f), l = Math.hypot(n[0], n[1], n[2]);
    if (!l) continue;
    const u = [n[0] / l, n[1] / l, n[2] / l], d = -(u[0] * P[f[0]][0] + u[1] * P[f[0]][1] + u[2] * P[f[0]][2]);
    for (const v of f) addPlane(Q[v], u, d, l);
  }
  // 破洞邊：沿著洞口加一道垂直的牆（權重大），洞口不亂跑
  const owner = new Map();
  faces.forEach((f, i) => { for (let k = 0; k < f.length; k++) owner.set(f[k] + '>' + f[(k + 1) % f.length], i); });
  for (const [key, c] of cnt) {
    if (c !== 1) continue;
    const [a, b] = key.split('-').map(Number);
    const fi = owner.has(a + '>' + b) ? owner.get(a + '>' + b) : owner.get(b + '>' + a);
    if (fi === undefined) continue;
    const n = newell(faces[fi]), A = P[a], B = P[b], e = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    let w = [e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0]];
    const l = Math.hypot(w[0], w[1], w[2]);
    if (!l) continue;
    w = [w[0] / l, w[1] / l, w[2] / l];
    const d = -(w[0] * A[0] + w[1] * A[1] + w[2] * A[2]), W = (e[0] * e[0] + e[1] * e[1] + e[2] * e[2]) * 100;
    addPlane(Q[a], w, d, W); addPlane(Q[b], w, d, W);
  }
  const err = (q, x) => q[0] * x[0] * x[0] + 2 * q[1] * x[0] * x[1] + 2 * q[2] * x[0] * x[2] + 2 * q[3] * x[0]
    + q[4] * x[1] * x[1] + 2 * q[5] * x[1] * x[2] + 2 * q[6] * x[1] + q[7] * x[2] * x[2] + 2 * q[8] * x[2] + q[9];
  /** 合併 u、v 的代價與位置：解二次誤差最小的點（離這條邊太遠就不用 —— 數值不穩），跟中點、兩端比，取最小 */
  const best = (u, v) => {
    const q = new Float64Array(10);
    for (let k = 0; k < 10; k++) q[k] = Q[u][k] + Q[v][k];
    if (keep && keep.has(u)) return [err(q, P[u]), P[u].slice()];
    if (keep && keep.has(v)) return [err(q, P[v]), P[v].slice()];
    const mid = [(P[u][0] + P[v][0]) / 2, (P[u][1] + P[v][1]) / 2, (P[u][2] + P[v][2]) / 2], cands = [mid, P[u], P[v]];
    const a = q[0], b = q[1], c = q[2], e = q[4], f = q[5], i = q[7];
    const det = a * (e * i - f * f) - b * (b * i - f * c) + c * (b * f - e * c);
    if (Math.abs(det) > 1e-18) {
      const r0 = -q[3], r1 = -q[6], r2 = -q[8];
      const x = [(r0 * (e * i - f * f) - b * (r1 * i - f * r2) + c * (r1 * f - e * r2)) / det,
        (a * (r1 * i - f * r2) - r0 * (b * i - f * c) + c * (b * r2 - r1 * c)) / det,
        (a * (e * r2 - r1 * f) - b * (b * r2 - r1 * c) + r0 * (b * f - e * c)) / det];
      const L = Math.hypot(P[u][0] - P[v][0], P[u][1] - P[v][1], P[u][2] - P[v][2]);
      if (Math.hypot(x[0] - mid[0], x[1] - mid[1], x[2] - mid[2]) < 2 * L) cands.unshift(x);
    }
    let bx = mid, be = Infinity;
    for (const x of cands) { const e2 = err(q, x); if (e2 < be) { be = e2; bx = x; } }
    return [Math.max(0, be), bx.slice()];
  };

  // ── 一條一條合：代價最小的先（點被動過就重新算，用版本號丟掉舊的）──
  const ver = new Uint32Array(nV), rep = new Int32Array(nV);
  for (let i = 0; i < nV; i++) rep[i] = i;
  const heap = new Heap();
  const len = (a, b) => Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1], P[a][2] - P[b][2]);
  const pushEdge = (a, b) => {
    if (keep && keep.has(a) && keep.has(b)) return;
    if (len(a, b) >= maxLen) return;
    const [c, x] = best(a, b);
    heap.push([c, a, b, ver[a], ver[b], x]);
  };
  for (const key of cnt.keys()) { const [a, b] = key.split('-').map(Number); pushEdge(a, b); }
  const tidy = f => { const o = []; for (const v of f) if (o[o.length - 1] !== v) o.push(v); while (o.length > 1 && o[0] === o[o.length - 1]) o.pop(); return o; };
  let live = faces.length, collapsed = 0, refused = 0, removed = 0;
  while (live > target && heap.size) {
    let [, a, b, va, vb, x] = heap.pop();
    if (rep[a] !== a || rep[b] !== b || ver[a] !== va || ver[b] !== vb || !cnt.get(ek(a, b))) continue;
    /** 一頭是保護的點 ⇒ 留下來的一定要是它（⛔ 只把位置放過去：留下來的編號不在保護名單，之後又會被搬走 —— 測試抓到）*/
    if (keep && keep.has(b) && !keep.has(a)) { [a, b] = [b, a]; }
    const F = [...new Set([...vf[a], ...vf[b]])];
    const n0 = F.map(i => newell(faces[i]));
    const keepA = P[a];
    P[a] = x;
    const nf = F.map(i => tidy(faces[i].map(v => (v === b ? a : v))));
    let ok = true;
    // 1. 留下來的面不翻過去（夾角 78° 以內）
    for (let t = 0; t < F.length && ok; t++) {
      if (nf[t].length < 3) continue;
      const n = newell(nf[t]), l0 = Math.hypot(n0[t][0], n0[t][1], n0[t][2]), l1 = Math.hypot(n[0], n[1], n[2]);
      if (l0 > 0 && (l1 < 1e-15 || n[0] * n0[t][0] + n[1] * n0[t][1] + n[2] * n0[t][2] < 0.2 * l0 * l1)) ok = false;
    }
    // 2. 不多出同一組點的面
    if (ok) {
      const seen = new Set();
      for (const f of nf) { if (f.length < 3) continue; const s = [...f].sort((p1, p2) => p1 - p2).join(','); if (seen.has(s)) { ok = false; break; } seen.add(s); }
    }
    // 3. 破洞、三面共用的邊不變多
    if (ok) {
      const d = new Map();
      const tally = (f, s) => { for (let k = 0; k < f.length; k++) { const k2 = ek(f[k], f[(k + 1) % f.length]); d.set(k2, (d.get(k2) || 0) + s); } };
      F.forEach(i => tally(faces[i], -1));
      nf.forEach(f => { if (f.length >= 3) tally(f, 1); });
      let open = 0, nm = 0;
      for (const [k2, dd] of d) { if (!dd) continue; const was = cnt.get(k2) || 0, now = was + dd; open += (now === 1) - (was === 1); nm += (now > 2) - (was > 2); }
      if (open > 0 || nm > 0) ok = false;
    }
    if (!ok) { P[a] = keepA; refused++; continue; }
    F.forEach((i, t) => {
      addF(faces[i], -1);
      for (const v of faces[i]) vf[v].delete(i);
      if (nf[t].length < 3) { alive[i] = false; faces[i] = null; live--; removed++; return; }
      faces[i] = nf[t];
      addF(faces[i], 1);
      for (const v of faces[i]) vf[v].add(i);
    });
    rep[b] = a;
    for (let k = 0; k < 10; k++) Q[a][k] += Q[b][k];
    ver[a]++; collapsed++;
    const nb = new Set();
    for (const i of vf[a]) for (const v of faces[i]) if (v !== a) nb.add(v);
    for (const v of nb) ver[v]++;
    for (const v of nb) pushEdge(a, v);
    for (const v of nb) {
      const n2 = new Set();
      for (const i of vf[v]) for (const w of faces[i]) if (w !== v && w !== a) n2.add(w);
      for (const w of n2) pushEdge(v, w);
    }
  }
  const find = i => { while (rep[i] !== i) i = rep[i]; return i; };
  let maxMove = 0;
  for (let i = 0; i < nV; i++) { const r = P[find(i)], q = p.points[i]; maxMove = Math.max(maxMove, Math.hypot(r[0] - q[0], r[1] - q[1], r[2] - q[2])); }
  const used = new Map(), pts = [], out = [], from = [];
  faces.forEach((f, i) => {
    if (!alive[i]) return;
    from.push(i);
    out.push(f.map(v => { if (!used.has(v)) { used.set(v, pts.length); pts.push(P[v]); } return used.get(v); }));
  });
  return { ...p, points: pts, faces: out, from, stats: { collapsed, refused, removed, maxMove } };
}

/**
 * 減完的面離原本的表面最多多遠（每個面的中心、每個點各量一次，到原本最近的三角形）。
 * ⚠ 不是「點被搬了多遠」：保形狀減面會把點沿著表面滑到誤差最小的位置，點搬得遠、表面卻幾乎沒動
 * （狐狸：點最多搬 0.33 mm、表面最多偏 0.003 mm）—— 使用者要看的是表面。
 * 🔴 找最近的三角形用**包圍盒樹**（⛔ 均勻格子：汽車有很多又長又細的三角形，一格塞上百個，瀏覽器卡了 5 分鐘以上）。
 * @returns {number} 最遠的距離（點的單位）
 */
export function surfaceDev(orig, out) {
  const T = [];
  for (const f of orig.faces) for (let k = 1; k + 1 < f.length; k++) T.push([f[0], f[k], f[k + 1]]);
  const P = orig.points;
  if (!T.length) return 0;
  const tree = boxTree(P, T);
  let worst = 0;
  for (const f of out.faces) {
    const c = [0, 0, 0];
    for (const i of f) for (let k = 0; k < 3; k++) c[k] += out.points[i][k] / f.length;
    worst = Math.max(worst, nearest(tree, c));
  }
  for (const q of out.points) worst = Math.max(worst, nearest(tree, q));
  return worst;
}

/** 三角形的包圍盒二元樹（照中心點沿最長的軸對半分，葉子 ≤ 8 個）*/
function boxTree(P, T) {
  const n = T.length, idx = new Int32Array(n), cen = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) { idx[i] = i; for (let k = 0; k < 3; k++) cen[i * 3 + k] = (P[T[i][0]][k] + P[T[i][1]][k] + P[T[i][2]][k]) / 3; }
  const nodes = [];
  const make = (lo, hi) => {
    const nd = { lo, hi, left: -1, right: -1, bl: [Infinity, Infinity, Infinity], bh: [-Infinity, -Infinity, -Infinity] };
    const id = nodes.length; nodes.push(nd);
    const cl = [Infinity, Infinity, Infinity], ch = [-Infinity, -Infinity, -Infinity];
    for (let q = lo; q < hi; q++) {
      const t = T[idx[q]];
      for (const v of t) for (let k = 0; k < 3; k++) { if (P[v][k] < nd.bl[k]) nd.bl[k] = P[v][k]; if (P[v][k] > nd.bh[k]) nd.bh[k] = P[v][k]; }
      for (let k = 0; k < 3; k++) { const c = cen[idx[q] * 3 + k]; if (c < cl[k]) cl[k] = c; if (c > ch[k]) ch[k] = c; }
    }
    if (hi - lo > 8) {
      let ax = 0; for (let k = 1; k < 3; k++) if (ch[k] - cl[k] > ch[ax] - cl[ax]) ax = k;
      const part = Array.from(idx.subarray(lo, hi)).sort((a, b) => cen[a * 3 + ax] - cen[b * 3 + ax]);
      idx.set(part, lo);
      const mid = (lo + hi) >> 1;
      nd.left = make(lo, mid); nd.right = make(mid, hi);
    }
    return id;
  };
  make(0, n);
  return { P, T, idx, nodes };
}
/** 點到包圍盒的距離（在盒子裡 ＝ 0）*/
function boxDist(nd, q) {
  let s = 0;
  for (let k = 0; k < 3; k++) { const d = q[k] < nd.bl[k] ? nd.bl[k] - q[k] : q[k] > nd.bh[k] ? q[k] - nd.bh[k] : 0; s += d * d; }
  return Math.sqrt(s);
}
/** 最近的三角形有多遠：先走近的那一邊，比目前找到的還遠的盒子整個跳過 */
function nearest(tree, q) {
  const { P, T, idx, nodes } = tree;
  let best = Infinity;
  const st = [0];
  while (st.length) {
    const nd = nodes[st.pop()];
    if (boxDist(nd, q) >= best) continue;
    if (nd.left < 0) { for (let k = nd.lo; k < nd.hi; k++) { const t = T[idx[k]]; const d = ptTri(q, P[t[0]], P[t[1]], P[t[2]]); if (d < best) best = d; } continue; }
    const a = nodes[nd.left], b = nodes[nd.right];
    if (boxDist(a, q) < boxDist(b, q)) st.push(nd.right, nd.left); else st.push(nd.left, nd.right);
  }
  return best === Infinity ? 0 : best;
}
/** 點到三角形最近的距離（Ericson《Real-Time Collision Detection》5.1.5）*/
function ptTri(p, a, b, c) {
  const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]], dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
  let q;
  if (d1 <= 0 && d2 <= 0) q = a;
  else {
    const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp);
    if (d3 >= 0 && d4 <= d3) q = b;
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); q = [a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2]]; }
      else {
        const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
        if (d6 >= 0 && d5 <= d6) q = c;
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) { const v = d2 / (d2 - d6); q = [a[0] + v * ac[0], a[1] + v * ac[1], a[2] + v * ac[2]]; }
          else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const v = (d4 - d3) / ((d4 - d3) + (d5 - d6)); q = [b[0] + v * (c[0] - b[0]), b[1] + v * (c[1] - b[1]), b[2] + v * (c[2] - b[2])]; }
            else { const dn = 1 / (va + vb + vc), v = vb * dn, w = vc * dn; q = [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w]; }
          }
        }
      }
    }
  }
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** 最小的先出來 */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}
