/**
 * bedCut.js — 3D 列印：太大的模型切成放得下的塊、接面加定位銷
 *
 * 🔴 第二輪第九批 9a（2026-10-25，kang「同意你的建議」→ `實驗-綜合評估-第二輪.md`「第九批 切塊加插銷」、
 * 規格 `規格\建模器-STL匯出.md`「切成放得下的塊」）：
 * ① 先試轉方向（轉 90° 的六種擺法、再加在平台上斜著轉）—— 放得下就講，不用切
 * ② 放不下 ⇒ 每個方向切幾刀照「塊數最少」（三個方向怎麼對平台都試，Bed Fit Splitter 那種）；
 *    刀的位置預設「挑位置」：一樣的刀數，在平台多出來的空間裡挑「插銷放得下、斷面分成的塊最少」的地方；「平均切」快
 * ③ 平台寬、深、高、留邊都可以改
 * ④ 定位銷（另外印一根、兩邊各挖一個孔）：放在接面兩邊都有料、往兩邊各一個孔深也都有料的地方，同一塊裡互相離最遠；
 *    放不下換小一號（⌀3 → ⌀1.75），還放不下講「只能黏」
 *
 * | 項目 | 預設 | 為什麼 |
 * |---|---|---|
 * | 平台 | 250 × 250 × 250 mm、留邊 2 mm | 原本「超過常見成型範圍」的 250；留邊照 Bed Fit Splitter |
 * | 銷 | ⌀6、孔深 8、孔比銷每邊大 0.2、孔外至少 1.5 mm 料 | Bed Fit Splitter 的預設；Sovol「沒有一個間隙適合所有機器」⇒ 都可以改 |
 * | 每個接面最多 | 2 根 | 兩根才不會轉（跟疊板的定位孔同一個道理）|
 * | 銷的長 | 兩個孔深 − 0.6、兩頭倒角 0.5 | 孔底留空才壓得緊；倒角好插 |
 *
 * 沙箱 `輸出\切塊插銷研究\`：實心的（方塊、半球、柱頭）兩種切法一樣；飛機平均切 8 塊、2 個接面只能黏，挑位置 4 塊、0 個；
 * 工地帽（殼）⌀6 四個接面三個放不下、換 ⌀3 都放得下；頭盔左片斜著轉 11° 就放得下。
 *
 * 座標：網格一律**世界座標、cm、Y 朝上**；刀跟世界的軸垂直。平台的軸：列印 X ＝ 世界 x、Y ＝ 世界 z、Z ＝ 世界 y。
 * Manifold 的部分（斷面、挖孔、切開）在 `build/bool.js` `cutBody()`；這裡是規劃與挑位置，node 測得到。
 */

import { cutBody, CUT_UV } from '../build/bool.js';

export const BED_MM = [250, 250, 250];          // 寬、深、高
export const MARGIN_MM = 2;
export const DOWEL = { dMM: 6, depthMM: 8, clearMM: 0.2, wallMM: 1.5, per: 2, smaller: true };
export const DOWEL_GAP_MM = 0.6;
export const DOWEL_CHAMFER_MM = 0.5;
/** 放不下換小一號（沙箱量過：工地帽 ⌀3 都放得下；⌀1.75 可以剪一段耗材當銷）*/
export const SMALLER = [{ dMM: 3, clearMM: 0.15, wallMM: 1.2, depthMM: 6 }, { dMM: 1.75, clearMM: 0.15, wallMM: 1.0, depthMM: 6 }];
/** 斷面上比這個小的一塊算「碎」（cm²，25 mm²）*/
export const TINY_CM2 = 0.25;
/** 挑位置時每隔幾 mm 試一次 */
export const STEP_MM = 2;
/** 世界軸 k 對到平台的哪一軸（0 寬、1 深、2 高）*/
export const BED_OF_WORLD = [0, 2, 1];
export const AXIS_NAME = ['左右', '上下', '前後'];      // 世界 x、y、z

// ═══════════════════════════════════════════════════════
//  ① 放不放得下：照原樣、轉 90°、斜著放
// ═══════════════════════════════════════════════════════

/** 平面上的凸包（Andrew）*/
export function hull2(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

/**
 * 放得下嗎（列印座標：Z 朝上；`points` [[x,y,z]] 跟 `bed` 同一個單位）。
 * 先看照原樣；不行就試三個方向朝上 × 在平台上轉 0～89°（每 1°）。
 * @returns {{asIs:boolean, size:number[], turn:null|{up:number, deg:number, size:number[]}}}
 *   up ＝ 原本的哪一軸變成朝上（0 左右、1 前後、2 本來就朝上）
 */
export function fitBed(points, bed) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  const size = [0, 1, 2].map(k => (points.length ? hi[k] - lo[k] : 0));
  const asIs = size.every((s, k) => s <= bed[k] + 1e-9);
  if (asIs || !points.length) return { asIs, size, turn: null };
  const ups = [[2, 0, 1], [0, 1, 2], [1, 2, 0]];      // [朝上的軸, 平面的兩軸]：照原本朝上的先試
  for (const [up, a, b] of ups) {
    if (size[up] > bed[2] + 1e-9) continue;
    const h = hull2(points.map(p => [p[a], p[b]]));
    for (let deg = 0; deg < 90; deg++) {
      const t = deg * Math.PI / 180, co = Math.cos(t), si = Math.sin(t);
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of h) { const X = co * x - si * y, Y = si * x + co * y; if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; }
      const w = x1 - x0, d = y1 - y0;
      if ((w <= bed[0] + 1e-9 && d <= bed[1] + 1e-9) || (d <= bed[0] + 1e-9 && w <= bed[1] + 1e-9)) {
        return { asIs, size, turn: { up, deg, size: w <= bed[0] + 1e-9 && d <= bed[1] + 1e-9 ? [w, d, size[up]] : [d, w, size[up]] } };
      }
    }
  }
  return { asIs, size, turn: null };
}

/** 「怎麼轉」講成人看得懂的話（列印座標的 up）*/
export function turnWords(turn) {
  const how = turn.up === 2 ? '照原本朝上' : turn.up === 0 ? '往左或往右倒下來（原本的左右變成上下）' : '往前或往後倒下來（原本的前後變成上下）';
  return how + (turn.deg ? `、在平台上轉 ${turn.deg}°` : '');
}

// ═══════════════════════════════════════════════════════
//  ② 切幾刀、刀放哪
// ═══════════════════════════════════════════════════════

/**
 * 每個方向切幾刀：三個方向怎麼對平台的寬、深、高都試，挑總塊數最少的（一樣多 ⇒ 照原本的擺法）。
 * @param {number[]} size 世界 [x, y, z] 的長（cm）
 * @param {number[]} bedCm 平台 [寬, 深, 高]（cm）
 * @returns {{n:number[], lim:number[], tot:number}} n、lim 照世界軸：每個方向幾塊、每一塊最長多少
 */
export function gridPlan(size, bedCm, marginCm) {
  const usable = bedCm.map(b => Math.max(1e-6, b - marginCm));
  const perms = [[0, 2, 1], [0, 1, 2], [1, 2, 0], [1, 0, 2], [2, 0, 1], [2, 1, 0]];   // 世界軸 k 放在平台的 perm[k]；第一個 ＝ 原本的擺法
  let best = null;
  for (const p of perms) {
    const lim = [0, 1, 2].map(k => usable[p[k]]);
    const n = size.map((s, k) => Math.max(1, Math.ceil(s / lim[k] - 1e-9)));
    const tot = n[0] * n[1] * n[2];
    if (!best || tot < best.tot) best = { n, lim, tot };
  }
  return best;
}

export function evenCuts(lo, hi, n) { return Array.from({ length: n - 1 }, (_, i) => lo + (hi - lo) * (i + 1) / n); }

/** 刀切出來的每一段都不超過 lim 嗎（給「自己改刀的位置」用）；回傳每一段的長 */
export function segments(cuts, lo, hi) {
  const xs = [lo, ...cuts.slice().sort((p, q) => p - q), hi];
  return xs.slice(1).map((x, i) => x - xs[i]);
}

/** 軸 a 的刀面被另外兩個方向的刀分成的格子（平面座標 u, v）*/
export function cellsFor(a, cuts, bb) {
  const [ua, va] = CUT_UV[a];
  const edges = k => [bb.min[k] - 1, ...cuts[k].slice().sort((p, q) => p - q), bb.max[k] + 1];
  const eu = edges(ua), ev = edges(va);
  const cells = [];
  for (let i = 0; i + 1 < eu.length; i++) for (let j = 0; j + 1 < ev.length; j++) cells.push([eu[i], ev[j], eu[i + 1], ev[j + 1]]);
  return cells;
}

const keepOf = s => (s.dMM / 2 + s.clearMM + s.wallMM) / 10;

/** 一刀的分數：放不下插銷的塊 → 碎的塊 → 斷面分成幾塊（越少越好；⛔「插銷越多越好」：切到凹槽會變多 —— 沙箱的柱頭）*/
export function cutCost(body, a, c, cells, d) {
  let noRoom = 0, tiny = 0, isl = 0;
  for (const cell of cells) {
    for (const I of body.room(a, c, cell, keepOf(d), d.depthMM / 10)) {
      isl++;
      if (I.area < TINY_CM2) tiny++;
      if (I.room <= 1e-12) noRoom++;
    }
  }
  return { noRoom, tiny, isl, cost: 1000 * noRoom + 100 * tiny + 10 * isl };
}

/**
 * 挑位置：一個方向的刀（一樣的刀數），每一段不超過 lim，總分最低（動態規劃，每 `STEP_MM` 試一次）；
 * 分數一樣 ⇒ 靠近平均的。
 */
async function smartAxis(body, a, bb, n, lim, cuts, d, tick) {
  const lo = bb.min[a], hi = bb.max[a], step = STEP_MM / 10;
  const even = evenCuts(lo, hi, n);
  const cand = []; for (let x = lo + step / 2; x < hi; x += step) cand.push(x);
  const cells = cellsFor(a, cuts, bb);
  const memo = new Map();
  const score = async (x, i) => { if (!memo.has(i)) { memo.set(i, cutCost(body, a, x, cells, d).cost); await tick(); } return memo.get(i); };
  const K = n - 1;
  let prev = null;
  for (let k = 0; k < K; k++) {
    const cur = [];
    for (let i = 0; i < cand.length; i++) {
      const x = cand[i];
      let best = null;
      if (k === 0) { if (x - lo <= lim + 1e-9) best = { c: 0, path: [] }; }
      else for (let j = 0; j < i; j++) { const p = prev[j]; if (!p || x - cand[j] > lim + 1e-9) continue; if (!best || p.c < best.c) best = p; }
      if (!best || (k === K - 1 && hi - x > lim + 1e-9)) { cur.push(null); continue; }
      const s = await score(x, i);
      cur.push({ c: best.c + s + Math.abs(x - even[k]) / (hi - lo), path: [...best.path, x] });
    }
    prev = cur;
  }
  let best = null; for (const p of prev || []) if (p && (!best || p.c < best.c)) best = p;
  return best ? best.path : even;
}

/** 挑位置總共要試幾個位置（給進度條）*/
function smartWork(bb, grid) {
  let w = 0;
  for (let a = 0; a < 3; a++) if (grid.n[a] > 1) w += 2 * Math.ceil((bb.max[a] - bb.min[a]) / (STEP_MM / 10));
  return w;
}

/**
 * 規劃：切幾刀、刀放哪（世界 cm）。
 * @param {object} body `cutBody()` 的結果
 * @param {{min:number[], max:number[]}} bb 外框
 * @param {object} o { bedMM, marginMM, mode:'smart'|'even', dowel }
 * @param {{progress?:Function, stopped?:Function}} hooks progress(做了, 總共)；stopped() 回 true ⇒ 停下來用平均的
 * @returns {Promise<{grid, cuts:number[][], stopped:boolean}>}
 */
export async function planCuts(body, bb, o, hooks = {}) {
  const size = [0, 1, 2].map(k => bb.max[k] - bb.min[k]);
  const grid = gridPlan(size, o.bedMM.map(x => x / 10), o.marginMM / 10);
  const cuts = [0, 1, 2].map(a => evenCuts(bb.min[a], bb.max[a], grid.n[a]));
  if (o.mode !== 'smart' || grid.tot === 1) return { grid, cuts, stopped: false };
  const total = smartWork(bb, grid);
  let done = 0, stopped = false, last = 0;
  const tick = async () => {
    done++;
    if (hooks.stopped && hooks.stopped()) { stopped = true; throw STOP; }
    const now = Date.now();
    if (hooks.progress && now - last > 120) { last = now; hooks.progress(done, total); await new Promise(r => setTimeout(r, 0)); }
  };
  try {
    for (let pass = 0; pass < 2; pass++) for (let a = 0; a < 3; a++) {
      if (grid.n[a] > 1) cuts[a] = await smartAxis(body, a, bb, grid.n[a], grid.lim[a], cuts, o.dowel, tick);
    }
  } catch (e) { if (e !== STOP) throw e; }
  return { grid, cuts: stopped ? [0, 1, 2].map(a => evenCuts(bb.min[a], bb.max[a], grid.n[a])) : cuts, stopped };
}
const STOP = { stop: true };

// ═══════════════════════════════════════════════════════
//  ④ 插銷放哪
// ═══════════════════════════════════════════════════════

function insidePolys(pp, x, y) {
  let k = false;
  for (const p of pp) for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i], [xj, yj] = p[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) k = !k;
  }
  return k;
}

/**
 * 在一塊「放得下的地方」裡挑 per 個點：第一個離這塊的中心最遠，之後離已經挑的最遠（而且至少隔 minSep）。
 * 格點每隔一點取（最多約 60 × 60 個）。
 */
export function pickPoints(polys, area, per, minSep) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  const step = Math.max(0.05, Math.min(x1 - x0, y1 - y0) / 40, Math.sqrt(area) / 60);
  const pts = [];
  for (let x = x0; x <= x1 + 1e-9; x += step) for (let y = y0; y <= y1 + 1e-9; y += step) if (insidePolys(polys, x, y)) pts.push([x, y]);
  if (!pts.length) {      // 很窄的一條：取第一圈的中點
    const p = polys[0]; let sx = 0, sy = 0; for (const [x, y] of p) { sx += x; sy += y; }
    pts.push([sx / p.length, sy / p.length]);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const chosen = [];
  let far = pts[0], fd = -1;
  for (const q of pts) { const d = Math.hypot(q[0] - cx, q[1] - cy); if (d > fd) { fd = d; far = q; } }
  chosen.push(far);
  while (chosen.length < per) {
    let bq = null, bd = -1;
    for (const q of pts) { const d = Math.min(...chosen.map(s => Math.hypot(q[0] - s[0], q[1] - s[1]))); if (d > bd) { bd = d; bq = q; } }
    if (bd < minSep) break;
    chosen.push(bq);
  }
  return chosen;
}

/** 銷的設定（mm）：照 o.dowel，加上放不下換的小一號 */
export function dowelTries(d) {
  return [{ dMM: d.dMM, clearMM: d.clearMM, wallMM: d.wallMM, depthMM: d.depthMM },
    ...(d.smaller ? SMALLER.filter(s => s.dMM < d.dMM - 1e-9) : [])];
}

/**
 * 每一刀、每一格的接面放插銷。
 * @returns {{joints:{a,c,area,islands,noRoom,dowels,smaller}[], dowels:{a,p:number[],dMM,r,depth}[]}}
 *   dowels 的 r ＝ 孔的半徑（含間隙，cm）、depth ＝ 孔深（cm）；joints 只列真的切到料的
 */
export function placeDowels(body, bb, cuts, d) {
  const tries = dowelTries(d);
  const joints = [], dowels = [];
  for (let a = 0; a < 3; a++) {
    const [ua, va] = CUT_UV[a];
    for (const c of cuts[a]) for (const cell of cellsFor(a, cuts, bb)) {
      const per = tries.map(s => body.room(a, c, cell, keepOf(s), s.depthMM / 10));
      const isl = per[0];
      if (!isl.length) continue;
      const got = isl.map(() => null);
      for (let t = 0; t < tries.length; t++) {
        const s = tries[t];
        per[t].forEach((I, i) => {
          if (got[i] || !(I.room > 1e-12)) return;
          const minSep = (2 * (s.dMM / 2 + s.clearMM) + s.wallMM) / 10;
          got[i] = { s, pts: pickPoints(I.polys, I.room, Math.max(1, d.per), minSep) };
        });
      }
      const area = isl.reduce((x, I) => x + I.area, 0);
      let n = 0, smaller = 0;
      for (const g of got) if (g) for (const [u, v] of g.pts) {
        const p = [0, 0, 0]; p[ua] = u; p[va] = v; p[a] = c;
        dowels.push({ a, p, dMM: g.s.dMM, r: (g.s.dMM / 2 + g.s.clearMM) / 10, depth: g.s.depthMM / 10 });
        n++; if (g.s !== tries[0]) smaller++;
      }
      joints.push({ a, c, area, islands: isl.length, noRoom: got.filter(g => !g).length, dowels: n, smaller });
    }
  }
  return { joints, dowels };
}

/** 要另外印的銷：每種大小幾根、多長（mm）*/
export function dowelSpecs(dowels) {
  const m = new Map();
  for (const x of dowels) {
    const len = 2 * x.depth * 10 - DOWEL_GAP_MM;
    const k = `${x.dMM}|${len}`;
    if (!m.has(k)) m.set(k, { dMM: x.dMM, lenMM: len, n: 0 });
    m.get(k).n++;
  }
  return [...m.values()].sort((p, q) => q.dMM - p.dMM);
}

/** 打開一個實體準備切（世界座標、封閉）—— 用完記得 `close()`。外框一起給 */
export function openCut(mesh, label) {
  const body = cutBody(mesh, label);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.verts) { const p = [v.p.x, v.p.y, v.p.z]; for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; } }
  return { body, bb: { min: lo, max: hi } };
}
