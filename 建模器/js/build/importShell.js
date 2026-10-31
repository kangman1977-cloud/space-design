/**
 * importShell.js — 匯入時「只留正面：面皮／實心」（2026-10-31 → `規格\建模器-匯入3D模型.md`「只留正面：面皮／實心」、
 * `三視圖導入-研究.md` 實驗 4、8、10、11；kang 2026-10-31「照你的建議」(a)～(k)）
 *
 * 混元這類 AI 生成的模型常常是**薄殼**：正面一層、背面一層內壁，中間只有 1～2 mm。減到幾百個面時兩層擠在一起 ⇒
 * 互相穿過去、太薄、內壁的線從外面透出來（實驗 4、8）；改造時 1,000 面就手動拿不掉內層（實驗 10）⇒ **在匯入時、減面前**挑出正面。
 * 照 kang 10-22「預覽＋建議、由人選」：視窗並排 原樣／面皮／實心 三張卡，程式標一個建議，人按了才算。
 *
 * 挑法（實驗 11「乙」；舊的「從正面看得到的面」碎掉、正面寫死 +Z，⛔ 用）：
 *   1. **量厚度**：每個面從中心往裡面（法向反方向）打一條線，在「高 ÷ `THICK_DIV`」以內碰到朝反方向的面 ⇒ 薄牆的一面，碰到的在對面
 *   2. **種子**：跟對面幾乎正對（`CORE_DOT`）的才當種子，照轉角（`SMOOTH_DOT`）連成一塊一塊 ⇒ 殼的邊緣慢慢轉過去的那一圈不當種子，正反就在那裡斷開
 *   3. **分正反**：最大一塊跟它對面那一塊一外一內，其他塊照「對面是哪邊」一路傳
 *   4. **哪一側是外面**：從四面八方（`VIEWS` 個方向）看，被看到的方向多的那一側（碗的內側只有從開口看得到）——
 *      ⛔ 用「凸不凸」（安全帽頂上幾道溝就判反）、⛔ 用「沿法向打線撞不撞到自己」（面具 1 判反）
 *   5. **正面方向** ＝ 整個外側的平均朝向，貼到最近的軸；使用者選了別的 ⇒ 外側朝向跟它相反就整個對調
 *   6. **兩邊一起長**：其他面（殼的邊緣、厚的實心部分）從兩邊的種子一起長，轉彎越大越貴 ⇒ 在殼的邊緣中間碰到
 *   7. **看得到的修正**：被標成內、但從正面 `SEE_DEG`° 內直接看得到大半的那一塊 ⇒ 改回外（耳朵這種薄片的背面）；
 *      比整個內側的 `RELABEL_MAX` 大的不改（正面猜錯時⛔ 整片翻過去）
 * 實心：面皮的外緣沿正面反方向拉到最後面的平面、封背板；裡面的洞比外緣一圈的 `BIG_HOLE` 長的打穿（眼洞）、小的補起來；
 * 做完一定檢查（封閉、一塊、方向一致、沒有面互相穿過去、體積是正的），過不了就照實講「做不了」。
 *
 * 都在檔案單位、檔案的座標（跟「整理成實體」一樣，在拆部分之前）；正面方向在這裡也是檔案的座標，視窗自己換成建模器的前後左右。
 */

import * as THREE from 'three';
import { Mesh } from '../core/mesh.js';
import { fillHoles, recalcNormalsOutside } from '../core/edit.js';
import { edgeCheck } from './import3d.js';
import { assemble, components } from './importSolid.js';
import { crossCheck } from '../out/printShape.js';

export const SHELL_MODES = { raw: '原樣', skin: '面皮', solid: '實心' };
/** 量厚度：在「高 ÷ 這個」以內碰到朝反方向的面才算薄牆（實驗 11：獅子頭 40 cm ⇒ 2 cm）*/
export const THICK_DIV = 20;
/** 對面要多「反」才算（法向內積 < −0.5）*/
const MATE_DOT = -0.5;
/** 種子：跟對面幾乎正對（夾角 < 約 25°）*/
export const CORE_DOT = -0.9;
/** 種子連成一塊：相鄰兩面轉角 < 60° */
export const SMOOTH_DOT = 0.5;
/** 「成對的薄牆」佔表面這麼多以上才算薄殼（實驗 11：混元薄殼 32.5～97%，浮雕 A1 26.6%、杯子 ≤ 14.2%）*/
export const SHELL_MIN = 0.3;
/** 看得到的修正：正面這麼多度以內 */
export const SEE_DEG = 45;
/** 看得到的修正：比整個內側的這個比例大的不改 */
export const RELABEL_MAX = 0.3;
/** 實心：比外緣一圈的這個比例長的洞打穿（眼洞），短的補起來 */
export const BIG_HOLE = 0.1;
/** 實心做出來有穿面，但不到三角形的這個比例 ⇒ 照樣給選、照實講（面具 4、照片面具減面前 3、5 個，減到 500 面就沒了 —— 實驗 11）*/
export const CROSS_FEW = 0.001;
/** 面超過這麼多就不自動看（汽車 55 萬面 33 秒）—— 按了才算（kang 2026-10-31 (i)）*/
export const AUTO_MAX_FACES = 200000;
/** 分外側內側：從這麼多個方向看（立方體的 26 個方向）*/
export const VIEWS = 26;

const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
const dot3 = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
/** 六個軸（檔案的座標）*/
export const AXES = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
const axisKey = d => Object.keys(AXES).reduce((a, b) => (dot3(AXES[b], d) > dot3(AXES[a], d) ? b : a), '+x');

/**
 * 看是不是薄殼、分正反（實驗 11 的 1～7 步）。
 * @param {{points:number[][], faces:number[][]}} r 檔案單位
 * @param {{height:number, front?:string}} o height ＝ 朝上那一軸的高（檔案單位）；front ＝ 使用者選的正面（`AXES` 的鍵，檔案座標），沒給 ＝ 自己猜
 * @returns {{shell:boolean, pairPct:number, guess?:string, front?:string, lab?:Int8Array, wall?:number, relabeled?:number, swapped?:boolean, seen?:number[]}}
 *   lab：每個面 1 ＝ 外（正面）、2 ＝ 內；wall ＝ 薄牆厚度的中位數（檔案單位）
 */
export function shellFind(r, o) {
  const P = r.points, F = r.faces, nF = F.length;
  const H = o.height > 0 ? o.height : Math.max(...r.size);
  // 每個面：法向（Newell）、面積、中心；三角形（打線、畫圖用）記是哪個面的
  const U = new Array(nF), A = new Float64Array(nF), C = new Array(nF), T = [], TF = [];
  for (let i = 0; i < nF; i++) {
    const f = F[i]; const n = [0, 0, 0], c = [0, 0, 0];
    for (let k = 0; k < f.length; k++) {
      const p = P[f[k]], q = P[f[(k + 1) % f.length]];
      n[0] += (p[1] - q[1]) * (p[2] + q[2]); n[1] += (p[2] - q[2]) * (p[0] + q[0]); n[2] += (p[0] - q[0]) * (p[1] + q[1]);
      for (let j = 0; j < 3; j++) c[j] += p[j] / f.length;
    }
    const L = Math.hypot(n[0], n[1], n[2]);
    A[i] = L / 2; U[i] = L > 0 ? n.map(x => x / L) : [0, 0, 0]; C[i] = c;
    for (let k = 1; k + 1 < f.length; k++) { T.push([f[0], f[k], f[k + 1]]); TF.push(i); }
  }
  let totalA = 0; for (let i = 0; i < nF; i++) totalA += A[i];
  const tree = bvh(P, T);
  // 1. 量厚度
  const TAU = H / THICK_DIV;
  const mate = new Int32Array(nF).fill(-1), thick = new Float64Array(nF);
  let pairA = 0;
  for (let i = 0; i < nF; i++) {
    if (!(A[i] > 0)) continue;
    const h = rayHit(P, T, tree, C[i], U[i].map(x => -x), i, TF, TAU);
    if (h.t < TAU) { const j = TF[h.tri]; if (dot3(U[j], U[i]) < MATE_DOT) { mate[i] = j; thick[i] = h.t; pairA += A[i]; } }
  }
  const thinPct = totalA > 0 ? pairA / totalA : 0;
  if (thinPct < SHELL_MIN) return { shell: false, pairPct: thinPct };      // 成對的種子一定在這裡面 ⇒ 先擋掉（貓、狐狸不用往下算）
  // 面的鄰居（共用邊）
  const nb = Array.from({ length: nF }, () => []);
  { const E = new Map(); for (let i = 0; i < nF; i++) { const f = F[i]; for (let k = 0; k < f.length; k++) { const a = f[k], b = f[(k + 1) % f.length]; const key = a < b ? a + ',' + b : b + ',' + a; const j = E.get(key); if (j === undefined) E.set(key, i); else if (j !== i) { nb[i].push(j); nb[j].push(i); } } } }
  const groups = (sel, smooth) => {
    const seen = new Uint8Array(nF), out = [];
    for (let i = 0; i < nF; i++) if (sel[i] && !seen[i]) {
      const g = [i]; seen[i] = 1;
      for (let q = 0; q < g.length; q++) for (const j of nb[g[q]]) if (sel[j] && !seen[j] && (smooth === undefined || dot3(U[g[q]], U[j]) > smooth)) { seen[j] = 1; g.push(j); }
      out.push(g);
    }
    return out;
  };
  // 2. 種子
  const core = new Uint8Array(nF);
  for (let i = 0; i < nF; i++) if (mate[i] >= 0 && dot3(U[mate[i]], U[i]) < CORE_DOT) core[i] = 1;
  const layerOf = new Int32Array(nF).fill(-1);
  const layers = groups(core, SMOOTH_DOT).map((ids, j) => {
    let a = 0; const m = [0, 0, 0];
    for (const i of ids) { layerOf[i] = j; a += A[i]; for (let k = 0; k < 3; k++) m[k] += U[i][k] * A[i]; }
    return { j, ids, area: a, m };
  });
  if (!layers.length) return { shell: false, pairPct: 0 };
  // 3. 分正反：最大一塊跟它對面最多的那一塊
  const big = layers.reduce((x, y) => (y.area > x.area ? y : x));
  const cnt = new Map();
  for (const i of big.ids) { const o2 = layerOf[mate[i]]; if (o2 >= 0 && o2 !== big.j) cnt.set(o2, (cnt.get(o2) || 0) + A[i]); }
  let other = -1, ob = 0; for (const [k, v] of cnt) if (v > ob) { ob = v; other = k; }
  if (other < 0) return { shell: false, pairPct: big.area / totalA };
  /** 「成對的薄牆」＝ 最大一塊種子跟它對面那一塊佔表面多少（實驗 11 的門檻就是量這個：浮雕 A1 26.6%、杯子 ≤ 14.2%）*/
  const pairPct = (big.area + layers[other].area) / totalA;
  if (pairPct < SHELL_MIN) return { shell: false, pairPct };
  const side = new Int8Array(layers.length);
  side[big.j] = 1; side[other] = 2;
  for (let changed = true; changed;) {
    changed = false;
    for (const l of layers) {
      if (side[l.j]) continue;
      let o1 = 0, o2 = 0;
      for (const i of l.ids) { const s = side[layerOf[mate[i]]] || 0; if (s === 1) o1 += A[i]; else if (s === 2) o2 += A[i]; }
      if (o1 + o2 > 0) { side[l.j] = o1 > o2 ? 2 : 1; changed = true; }      // 對面是外 ⇒ 我是內
    }
  }
  // 4. 哪一側是外面：從四面八方看，被看到的方向多的那一側
  const dirs = []; for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) if (x || y || z) dirs.push([x, y, z]);
  const seenCnt = new Uint8Array(nF);
  for (const d of dirs) { const v = visible(P, T, TF, nF, [d], H / 300); for (let i = 0; i < nF; i++) if (v[i]) seenCnt[i]++; }
  const avg = s => { let a = 0, b = 0; for (const l of layers) if (side[l.j] === s) for (const i of l.ids) { a += A[i]; b += A[i] * seenCnt[i]; } return a ? b / a : 0; };
  const seen = [avg(1), avg(2)];
  const flipAll = () => { for (const l of layers) if (side[l.j]) side[l.j] = 3 - side[l.j]; };
  if (seen[1] > seen[0]) { flipAll(); seen.reverse(); }
  // 5. 正面方向
  const sideM = s => { const m = [0, 0, 0]; let a = 0; for (const l of layers) if (side[l.j] === s) { a += l.area; for (let k = 0; k < 3; k++) m[k] += l.m[k]; } return { m, a }; };
  let outer = sideM(1);
  const guess = axisKey(outer.m);
  let front = guess, swapped = false;
  if (o.front && AXES[o.front]) {
    front = o.front;
    if (dot3(outer.m, AXES[front]) < 0) { flipAll(); swapped = true; outer = sideM(1); }   // 選的正面跟外側朝向相反 ⇒ 整個對調
  }
  const innerArea = sideM(2).a;
  // 6. 兩邊一起長
  const lab = new Int8Array(nF), dist = new Float64Array(nF).fill(Infinity);
  const heap = new Heap();
  for (let i = 0; i < nF; i++) if (layerOf[i] >= 0 && side[layerOf[i]]) { lab[i] = side[layerOf[i]]; dist[i] = 0; heap.push(0, i); }
  while (heap.size) {
    const [d, i] = heap.pop(); if (d > dist[i]) continue;
    for (const k of nb[i]) { const w = (1 - dot3(U[i], U[k])) + 1e-3; if (d + w < dist[k]) { dist[k] = d + w; lab[k] = lab[i]; heap.push(d + w, k); } }
  }
  // 7. 看得到的修正
  const g = AXES[front], t1 = Math.abs(g[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0], t2 = cross3(g, t1);
  const cone = [g];
  const s = Math.sin(SEE_DEG * Math.PI / 180), c = Math.cos(SEE_DEG * Math.PI / 180);
  for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; cone.push([0, 1, 2].map(j => g[j] * c + (t1[j] * Math.cos(a) + t2[j] * Math.sin(a)) * s)); }
  const vis = visible(P, T, TF, nF, cone, H / 600);
  let relabeled = 0;
  for (const comp of groups(Array.from(lab, x => x === 2))) {
    let va = 0, ta = 0;
    for (const i of comp) { ta += A[i]; if (vis[i]) va += A[i]; }
    if (va > ta / 2 && ta < RELABEL_MAX * innerArea) { for (const i of comp) lab[i] = 1; relabeled++; }
  }
  // 牆厚：種子的中位數
  const ts = []; for (let i = 0; i < nF; i++) if (core[i]) ts.push(thick[i]);
  ts.sort((a, b) => a - b);
  return { shell: true, pairPct, guess, front, swapped, lab, wall: ts.length ? ts[ts.length >> 1] : 0, relabeled, seen };
}

/**
 * 面皮：標成外的面、連在一起最大的那一塊（其他小塊丟掉、講出來）；變成一個部分「（面皮）」。
 * @returns {{read, info:{faces:number, holes:number, dropped:number, wall:number}}}
 */
export function skinVariant(r, sh) {
  const sel = []; for (let i = 0; i < r.faces.length; i++) if (sh.lab[i] === 1) sel.push(r.faces[i]);
  const comps = components(sel, r.points.length);
  const best = comps.reduce((x, y) => (y.length > x.length ? y : x), []);
  const fs = best.map(i => sel[i]);
  const g = local(r.points, fs);
  const read = assemble({ ...r, parts: ['（面皮）'] }, [{ ...g, part: 0 }]);
  return { read, info: { faces: fs.length, holes: Math.max(0, loopsOf(g).length - 1), dropped: sel.length - fs.length, wall: sh.wall } };
}

/**
 * 實心：面皮的外緣沿正面反方向拉到最後面那一點的平面、封背板；裡面的洞：比外緣 `BIG_HOLE` 長的打穿（fillBig ⇒ 也補起來）、
 * 短的交給「補洞」；方向修成朝外；做完檢查，過不了 ⇒ read: null、寫原因。
 * @param skin `skinVariant()` 的 read
 * @returns {{read, info:{faces, tunnels, filled, why?}}}
 */
export function solidVariant(skin, front, { fillBig = false } = {}) {
  const g = { points: skin.points, faces: skin.faces };
  const lp = loopsOf(g);
  if (!lp.length) return { read: null, info: { why: '面皮沒有外緣（本來就封閉）' } };
  const f = AXES[front], ax = f.findIndex(x => x !== 0), sg = f[ax], i1 = (ax + 1) % 3, i2 = (ax + 2) % 3;
  const pts = g.points.map(p => p.slice()), faces = g.faces.map(q => q.slice());
  let back = Infinity; for (const p of pts) back = Math.min(back, p[ax] * sg);
  const wall = L => {
    const base = pts.length;
    for (const k of L) { const q = pts[k].slice(); q[ax] = back * sg; pts.push(q); }
    for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length], a2 = base + i, b2 = base + (i + 1) % L.length; faces.push([a, b, b2], [a, b2, a2]); }
    return base;
  };
  const rim = lp[0];
  const big = fillBig ? [] : lp.slice(1).filter(x => x.len >= rim.len * BIG_HOLE);
  const rb = wall(rim.L), hb = big.map(x => wall(x.L));
  const v2 = k => new THREE.Vector2(pts[k][i1], pts[k][i2]);
  const loops2 = [rim.L.map((_, i) => rb + i), ...big.map((x, j) => x.L.map((_, i) => hb[j] + i))];
  for (const t of plate(loops2, v2)) faces.push(t);
  let m = Mesh.fromFaceList(pts.map(p => new THREE.Vector3(p[0], p[1], p[2])), faces);
  const fh = fillHoles(m);
  let filled = 0;
  if (fh.ok && fh.mesh) { m = fh.mesh; filled = fh.holes || 0; }
  const n = recalcNormalsOutside(m); if (n.ok) m = n.mesh;
  const vi = m._vertIndex();
  const out = { points: m.verts.map(v => [v.p.x, v.p.y, v.p.z]), faces: m.faces.map(q => m.faceVerts(q).map(v => vi.get(v.id))) };
  const info = { faces: out.faces.length, tunnels: big.length, filled, cross: 0 };
  const why = solidProblem(out, m, info);
  if (why) return { read: null, info: { ...info, why } };
  return { read: assemble({ ...skin, parts: ['（實心）'] }, [{ ...out, part: 0 }]), info };
}

/**
 * 背板：外圈＋洞（點的編號，各一圈）切成三角形，**每一個點都要用到**。
 * ⚠ `THREE.ShapeUtils.triangulateShape()`（earcut）會把剛好排成一直線的點丟掉（合成的面具眼洞下緣在 y ＝ 0 那條線上：124 個點只用到 121 個）
 * ⇒ 牆的那幾條邊接不上、做出來不封閉；洞跟外圈在同一直線上時，接洞的「橋」還會疊在線上、切出扁掉的三角形。
 * ⇒ ① 切之前每個點挪一點點（外框的百萬分之一，照編號固定、每次一樣；只用來決定怎麼切，點真正的位置不動）⇒ 不會剛好一直線；
 *   ② 還有丟掉的點 ⇒ 一定落在某個三角形的邊上，把那個三角形從那些點拆成扇形。
 */
function plate(loops, v2) {
  const all = loops.flat();
  const P2 = loops.map(L => L.map(v2));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const L of P2) for (const q of L) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  const eps = Math.max(x1 - x0, y1 - y0) * 1e-6;
  const jit = k => { const h = Math.sin(k * 12.9898 + 78.233) * 43758.5453; return h - Math.floor(h) - 0.5; };
  let n0 = 0;
  for (const L of P2) for (const q of L) { q.x += eps * jit(n0); q.y += eps * jit(n0 + 0.5); n0++; }
  const tri = THREE.ShapeUtils.triangulateShape(P2[0], P2.slice(1)).map(t => t.map(i => all[i]));
  const used = new Set(tri.flat());
  if (used.size === all.length) return tri;
  for (const L of loops) {
    const n = L.length, s = L.findIndex(k => used.has(k));
    if (s < 0) continue;
    for (let q = 0; q < n;) {
      const u = L[(s + q) % n];
      let r = 1; const mid = [];
      while (r < n && !used.has(L[(s + q + r) % n])) { mid.push(L[(s + q + r) % n]); r++; }
      const v = L[(s + q + r) % n];
      if (mid.length) {
        const ti = tri.findIndex(t => [0, 1, 2].some(k => (t[k] === u && t[(k + 1) % 3] === v) || (t[k] === v && t[(k + 1) % 3] === u)));
        if (ti >= 0) {
          const t = tri[ti], k = [0, 1, 2].find(k2 => t[k2] !== u && t[k2] !== v), w = t[k];
          const fwd = t[(k + 1) % 3] === u;             // 原本的繞向：w → u → v 或 w → v → u
          const chain = fwd ? [u, ...mid, v] : [v, ...mid.slice().reverse(), u];
          tri.splice(ti, 1, ...chain.slice(0, -1).map((a, i) => [w, a, chain[i + 1]]));
          for (const m of mid) used.add(m);
        }
      }
      q += r;
    }
  }
  return tri;
}

/** 實心做出來的檢查（h：做不了要講原因）；沒問題 ⇒ ''。穿面不到 `CROSS_FEW` 照樣給、記在 info.cross */
function solidProblem(out, m, info) {
  const e = edgeCheck(out.faces);
  if (e.open) return `做出來不封閉（${e.open} 條邊只接一個面）`;
  if (e.nonManifold) return `做出來有 ${e.nonManifold} 條邊被三個以上的面共用`;
  if (e.flipped) return `做出來有面翻過去（${e.flipped} 條邊兩邊方向不一致）`;
  const pieces = components(out.faces, out.points.length).length;
  if (pieces > 1) return `做出來分成 ${pieces} 塊`;
  if (!(m.volume() > 0)) return '做出來裡外反了';
  const V = out.points.map(q => ({ x: q[0], y: q[1], z: q[2] })), tris = [];
  for (const f of out.faces) for (let k = 1; k + 1 < f.length; k++) tris.push({ a: V[f[0]], b: V[f[k]], c: V[f[k + 1]] });
  const c = crossCheck(tris);
  if (c.tris && (c.cut || c.tris > tris.length * CROSS_FEW)) return `做出來有 ${c.tris} 個三角形互相穿過去${c.cut ? '以上' : ''}`;
  info.cross = c.tris;
  return '';
}

/** 一組面（原本的點編號）→ 自己的點 */
function local(points, fs) {
  const used = new Map(), P = [];
  const F = fs.map(f => f.map(i => { if (!used.has(i)) { used.set(i, P.length); P.push(points[i]); } return used.get(i); }));
  return { points: P, faces: F };
}

/** 邊界一圈一圈（點的編號），由長到短 */
function loopsOf(g) {
  const m = Mesh.fromFaceList(g.points.map(p => new THREE.Vector3(p[0], p[1], p[2])), g.faces);
  const vi = m._vertIndex();
  const next = new Map();
  for (const h of m.halfEdges) if (!h.face) next.set(vi.get(h.v.id), vi.get(h.to.id));
  const loops = [], seen = new Set();
  for (const [a] of next) {
    if (seen.has(a)) continue;
    const L = []; let x = a;
    while (!seen.has(x) && next.has(x)) { seen.add(x); L.push(x); x = next.get(x); }
    let len = 0; for (let i = 0; i < L.length; i++) len += Math.hypot(...sub3(g.points[L[i]], g.points[L[(i + 1) % L.length]]));
    loops.push({ L, len });
  }
  return loops.sort((a, b) => b.len - a.len);
}

// ═══ 底層：打線（三角形的包圍盒樹）、從某些方向看得到哪些面（正投影＋深度）、最小堆 ═══

function bvh(P, T) {
  const C = T.map(t => [0, 1, 2].map(k => (P[t[0]][k] + P[t[1]][k] + P[t[2]][k]) / 3));
  const build = ids => {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const i of ids) for (const v of T[i]) for (let k = 0; k < 3; k++) { if (P[v][k] < lo[k]) lo[k] = P[v][k]; if (P[v][k] > hi[k]) hi[k] = P[v][k]; }
    const n = { lo, hi };
    if (ids.length <= 8) { n.tris = ids; return n; }
    const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]], ax = ext.indexOf(Math.max(...ext));
    ids.sort((a, b) => C[a][ax] - C[b][ax]);
    const m = ids.length >> 1;
    n.l = build(ids.slice(0, m)); n.r = build(ids.slice(m));
    return n;
  };
  return build(T.map((_, i) => i));
}
/** 從 o 往 d 打線，tmax 以內最近碰到哪個三角形（跳過面 skipFace 的三角形）*/
function rayHit(P, T, root, o, d, skipFace, TF, tmax) {
  const inv = d.map(x => 1 / x);
  let best = tmax, hit = -1;
  const st = [root];
  while (st.length) {
    const n = st.pop();
    let t0 = 0, t1 = best, miss = false;
    for (let k = 0; k < 3; k++) { let a = (n.lo[k] - o[k]) * inv[k], b = (n.hi[k] - o[k]) * inv[k]; if (a > b) [a, b] = [b, a]; if (a > t0) t0 = a; if (b < t1) t1 = b; if (t0 > t1) { miss = true; break; } }
    if (miss) continue;
    if (n.tris) {
      for (const i of n.tris) {
        if (TF[i] === skipFace) continue;
        const a = P[T[i][0]], b = P[T[i][1]], c = P[T[i][2]];
        const e1 = sub3(b, a), e2 = sub3(c, a), h = cross3(d, e2), det = dot3(e1, h);
        if (Math.abs(det) < 1e-14) continue;
        const f = 1 / det, s = sub3(o, a), u = f * dot3(s, h);
        if (u < 0 || u > 1) continue;
        const q = cross3(s, e1), v = f * dot3(d, q);
        if (v < 0 || u + v > 1) continue;
        const t = f * dot3(e2, q);
        if (t > 1e-9 && t < best) { best = t; hit = i; }
      }
    } else st.push(n.l, n.r);
  }
  return { t: best, tri: hit };
}
/** 從 dirs 這些方向（正投影、格子 res）看得到哪些面 */
function visible(P, T, TF, nF, dirs, res) {
  const seen = new Uint8Array(nF);
  for (const d0 of dirs) {
    const L = Math.hypot(d0[0], d0[1], d0[2]), v = d0.map(x => x / L);
    const r0 = Math.abs(v[1]) > 0.9 ? [1, 0, 0] : cross3([0, 1, 0], v), rl = Math.hypot(...r0), rr = r0.map(x => x / rl);
    const u = cross3(v, rr);
    const n = P.length, X = new Float64Array(n), Y = new Float64Array(n), Z = new Float64Array(n);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = P[i]; X[i] = dot3(p, rr); Y[i] = dot3(p, u); Z[i] = dot3(p, v);
      if (X[i] < x0) x0 = X[i]; if (X[i] > x1) x1 = X[i]; if (Y[i] < y0) y0 = Y[i]; if (Y[i] > y1) y1 = Y[i];
    }
    const W = Math.ceil((x1 - x0) / res) + 2, Hh = Math.ceil((y1 - y0) / res) + 2;
    const zb = new Float64Array(W * Hh).fill(-Infinity), id = new Int32Array(W * Hh).fill(-1);
    for (let ti = 0; ti < T.length; ti++) {
      const [a, b, c] = T[ti];
      const ax = (X[a] - x0) / res, ay = (Y[a] - y0) / res, bx = (X[b] - x0) / res, by = (Y[b] - y0) / res, cx = (X[c] - x0) / res, cy = (Y[c] - y0) / res;
      const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(den) < 1e-12) continue;
      const mx = Math.max(0, Math.floor(Math.min(ax, bx, cx))), Mx = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
      const my = Math.max(0, Math.floor(Math.min(ay, by, cy))), My = Math.min(Hh - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = my; y <= My; y++) for (let x = mx; x <= Mx; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den, w2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den, w3 = 1 - w1 - w2;
        if (w1 < -1e-6 || w2 < -1e-6 || w3 < -1e-6) continue;
        const z = w1 * Z[a] + w2 * Z[b] + w3 * Z[c], k = y * W + x;
        if (z > zb[k]) { zb[k] = z; id[k] = ti; }
      }
    }
    for (const ti of id) if (ti >= 0) seen[TF[ti]] = 1;
  }
  return seen;
}
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(d, i) { const a = this.a; a.push([d, i]); let k = a.length - 1; while (k) { const p = (k - 1) >> 1; if (a[p][0] <= a[k][0]) break; [a[p], a[k]] = [a[k], a[p]]; k = p; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === k) break; [a[m], a[k]] = [a[k], a[m]]; k = m; } }
    return top;
  }
}

/**
 * 建議哪一張（kang 2026-10-31 (d)）：實心做得出來 ⇒ 實心；做不了 ⇒ 原樣（⛔ 自動換面皮 —— 面皮是做紙模、面具的人自己挑）
 * @returns {{mode:string, why:string}}
 */
export function suggestShell(sh, solid) {
  if (!sh || !sh.shell) return { mode: 'raw', why: '' };
  if (solid && solid.read) return { mode: 'solid', why: '畫面、3D 列印、剖面都乾淨，減面時面全給正面（展開多一片平的背板）' };
  return { mode: 'raw', why: '實心做不了（看那張卡寫的原因）—— 照原樣；做紙模、面具可以自己點「面皮」' };
}
