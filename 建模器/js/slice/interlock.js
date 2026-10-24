/**
 * interlock.js — 互卡：側面＋橫肋
 *
 * 🔴 第二輪第六批 6a（2026-10-24，kang「第六批照你的建議：放在剖面分切視窗「做法：疊層／互卡」，拆 6a～6d，先做 6a，預設照表」
 * → `規格\建模器-剖面分切.md`「互卡：側面＋橫肋」；查到的、量表 → `實驗-綜合評估-第二輪.md`「第六批 互卡：動工前查到的」）。
 *
 * 袋鼠、野牛那種：正中間一片「側面」＋一排等間距的「肋」，兩片交叉的地方各開一半的槽、卡在一起，不用膠、不用串桿。
 * 業界：Slicer for Fusion 360 的 Interlocked、Lamina 的 egg-crate（10-22 調查 5.2）。
 *
 * | 怎麼做 | 規矩 |
 * |---|---|
 * | 側面 | 從水平方向比較窄的那一邊切正中間（可以指定 X／Z）|
 * | 肋 | 沿另一個水平方向，每 `spacing` cm 一片（跟疊層同一套切法：每一段的正中間）|
 * | 交叉 | 側面與肋交叉的那條直線（垂直的）上，兩片都有料的那一段 |
 * | 槽 | 槽寬 ＝ 板厚 ＋ 加減（**⛔ 自動補切口**，kang 2026-08-23）；肋從上面挖到中間、側面從下面挖到中間（`share` ＝ 肋那邊佔幾成）；**一路開到料的邊上**（才插得進去）；槽口張開 `flare` |
 * | 一條線交叉好幾段 | 側面同一塊上下兩段 ⇒ 上面那段反過來開；排不下的從最短的拿掉 —— 講出來 |
 * | 6c 側面幾片、肋在哪 | 側面 1～3 片（寬的 i／(k＋1)）；肋可以照給的位置切（肋位圖手動挪、`suggestRibs()` 幫我挪）；同一塊肋跟兩片側面一個照常一個反過來 ⇒ 組不起來（只講）|
 * | 檢查 | 掉下來的塊（插不到另一組的）標紅、槽把零件切斷、卡不牢（交叉不到兩倍板厚）標黃圈 —— **只講、⛔ 刪**（同 5a）|
 *
 * 純幾何，不碰 DOM，測得到。Manifold 只在 `build/bool.js`（`cutSlots()`）。單位 cm。
 */

import { sliceMany, AXES, signedArea, loopsBounds, listNums } from './section.js';
import { cutSlots } from '../build/bool.js';

export const INTERLOCK_DEFAULTS = {
  t: 0.5,          // 板厚 cm
  spacing: 3,      // 肋每幾 cm 一片
  slotAdj: 0,      // 槽寬加減 cm（正 ＝ 鬆、負 ＝ 緊；切口補償 kang 定人工處理，⛔ 自動）
  share: 0.5,      // 肋那邊的槽佔交叉長度的幾成（0.5 ＝ 一半一半）
  flare: 0.1,      // 槽口每邊張開 cm（0 ＝ 不張開）
  spine: 'auto',   // 側面從哪個方向切：auto ＝ 水平方向比較窄的那一邊；'x'／'z'
  spineN: 1        // 6c：側面幾片（1～3；kang 2026-10-25「肋可以挪＋側面 1～3 片…預設照表」）
};
export const SPINE_N_MAX = 3;

const dot = (a, w) => a[0] * w[0] + a[1] * w[1] + a[2] * w[2];
const IDX = { x: 0, y: 1, z: 2 };
const r2 = v => Math.round(v * 100) / 100;

/** 一圈一圈的輪廓在直線 u ＝ U 上（沿 v）的料：[[v0, v1], …]（奇偶）*/
export function lineSpans(loops, U) {
  const ys = [];
  for (const l of loops) {
    const p = l.pts;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      const a = p[i], b = p[j];
      if ((a.x > U) !== (b.x > U)) ys.push(a.y + (U - a.x) * (b.y - a.y) / (b.x - a.x));
    }
  }
  ys.sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i + 1 < ys.length; i += 2) if (ys[i + 1] - ys[i] > 1e-6) out.push([ys[i], ys[i + 1]]);
  return out;
}

/** 兩組區間的交集 */
function overlaps(A, B) {
  const out = [];
  for (const [a0, a1] of A) for (const [b0, b1] of B) {
    const lo = Math.max(a0, b0), hi = Math.min(a1, b1);
    if (hi - lo > 1e-6) out.push([lo, hi]);
  }
  return out.sort((p, q) => p[0] - q[0]);
}

/** 這一點落在哪一塊（最小的那一圈外圈；−1 ＝ 都不在）*/
function pieceOf(loops, x, y) {
  let best = -1, ba = Infinity;
  loops.forEach((l, i) => { if (l.isHole) return; const a = Math.abs(l.area); if (a < ba && inside([l.pts], x, y)) { best = i; ba = a; } });
  return best;
}

/** 點在不在這一塊裡（奇偶，所有圈）*/
function inside(loops, x, y) {
  let c = false;
  for (const p of loops) for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const a = p[i], b = p[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/**
 * 一個槽：u ＝ U、寬 w；從 vEnd（中間）一路開到 vFar（料的外面）；在 vMouth（料的邊）張開 f。
 * dir ＝ +1 往上開（肋）、−1 往下開（側面）。
 */
function slotPolys(U, w, vEnd, vFar, vMouth, f, dir) {
  const L = U - w / 2, R = U + w / 2;
  const rect = dir > 0
    ? [{ x: L, y: vEnd }, { x: R, y: vEnd }, { x: R, y: vFar }, { x: L, y: vFar }]
    : [{ x: L, y: vFar }, { x: R, y: vFar }, { x: R, y: vEnd }, { x: L, y: vEnd }];
  if (!(f > 0)) return [rect];
  const m = vMouth, k = dir;
  // 槽口張開：邊上寬 w ＋ 2f，往裡面 f 收回 w（45°）
  const flare = dir > 0
    ? [{ x: L, y: m - f }, { x: R, y: m - f }, { x: R + f, y: m }, { x: R + f, y: m + f }, { x: L - f, y: m + f }, { x: L - f, y: m }]
    : [{ x: L - f, y: m - f }, { x: R + f, y: m - f }, { x: R + f, y: m }, { x: R, y: m + f }, { x: L, y: m + f }, { x: L - f, y: m }];
  void k;
  return [rect, flare];
}

/** 一塊（cutSlots 給的一組圈）轉成剖面的 loops：外圈逆時針、洞順時針 */
function toLoops(piece) {
  return piece.map(pts => { const a = signedArea(pts); return { pts, area: a, isHole: a < 0 }; });
}

/** 在世界座標 ax ＝ c 切一刀（借 sliceMany：一段、厚 2 ×（c − 最低）、1 片 ⇒ 那一片的正中間就是 c；斷線照樣補）*/
function cutAt(list, ax, c, lo) {
  const r = sliceMany(list, { axis: ax, bands: [{ t: Math.max(1e-4, 2 * (c - lo)), n: 1 }] });
  if (!r.ok || !r.slices[0]) return null;
  r.slices[0].warns = r.warnings || [];     // 開放曲面、沒有布林函式庫那幾句（側面那一刀照 6a 講出來）
  return r.slices[0];
}

/**
 * 6d：掉下來的那一塊在哪（從上面看的世界座標 x、z ＋ 面積）—— 肋位圖畫紅點，人才知道側面要拖去哪
 * （kang 2026-10-25「小脊先不做，肋位圖加紅點（平常就畫），紅框那一句改成教人怎麼救」）。
 * 那一片的平面：沿 `ax` 在 coord；平面上的 u 照 `AXES[ax].uv[0]` 換回世界座標；取外框的正中間。
 */
function dotOf(ax, coord, loop) {
  const xs = loop.pts.map(p => p.x), u = (Math.min(...xs) + Math.max(...xs)) / 2, U = AXES[ax].uv[0];
  const P = [0, 0, 0]; P[IDX[ax]] = coord;
  return { x: P[0] + U[0] * u, z: P[2] + U[2] * u, area: Math.abs(loop.area) };
}

/** 側面 k 片的自動位置：寬的 i／(k＋1)（1 片 ＝ 正中間；3 片 ＝ 1/4、1/2、3/4）*/
export function spineCoordsAuto(lo, width, k) {
  const out = [];
  for (let i = 1; i <= k; i++) out.push(lo + width * i / (k + 1));
  return out;
}

/**
 * 切成「側面＋橫肋」。
 * @param {Mesh[]} meshes 世界座標的網格
 * @param {object} opt `INTERLOCK_DEFAULTS` 那幾個；6c 另外可以給 `spineCoords`、`ribCoords`（手動挪過的位置，世界座標 cm）
 * @returns {{ok, reason?, method:'interlock', axis, ribAxis, slices:object[], warnings:string[], notes:string[], stats:object, plan:{bands:[]},
 *   ribInfo:{coord, n, loose, weak, empty}[], spineInfo:{coord, loose}[], bounds}}
 *   warnings：要注意的（紅框）；notes：說明（藍框，例如上面那段槽反過來開）
 *   slices：每一塊零件一份（樣子跟疊層的片一樣：loops、area、bounds、t，另外帶 axis、coord、tag、label）；
 *     index：側面 0～k−1、肋接著往下排（側面 1 片時肋從 1 開始，跟 6a 一樣）
 *   ribInfo／spineInfo：給 6c 肋位圖畫紅黃（照位置排）；looseDots：6d 掉下來的塊在哪（{x, z, area}，肋位圖的紅點）
 */
export function interlockMany(meshes, opt = {}) {
  const o = { ...INTERLOCK_DEFAULTS, ...opt };
  const t = Math.max(0.01, +o.t || INTERLOCK_DEFAULTS.t);
  const spacing = Math.max(t * 2, +o.spacing || INTERLOCK_DEFAULTS.spacing);
  const w = Math.max(0.01, t + (+o.slotAdj || 0));
  const share = Math.min(0.9, Math.max(0.1, +o.share || 0.5));
  const f = Math.max(0, +o.flare || 0);
  const list = meshes.filter(Boolean);
  if (!list.length) return { ok: false, reason: '沒有可以切的物件。', method: 'interlock' };

  let min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const m of list) { const b = m.bounds(); for (const k of 'xyz') { min[k] = Math.min(min[k], b.min[k]); max[k] = Math.max(max[k], b.max[k]); } }
  const size = { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
  const spineAx = o.spine === 'x' || o.spine === 'z' ? o.spine : (size.x <= size.z ? 'x' : 'z');
  const ribAx = spineAx === 'x' ? 'z' : 'x';
  const bounds = { min, max, size };

  /** 6c：側面 1～3 片（自動 ＝ 寬的 i／(k＋1)）；手動挪過 ⇒ 用手動的位置 */
  const kWant = Math.min(SPINE_N_MAX, Math.max(1, Math.round(+o.spineN || 1)));
  const sCoords = (Array.isArray(o.spineCoords) && o.spineCoords.length ? o.spineCoords.slice() : spineCoordsAuto(min[spineAx], size[spineAx], kWant)).sort((a, b) => a - b);
  const sCut = sCoords.map(c => cutAt(list, spineAx, c, min[spineAx]));
  const spines = sCut.filter(s => s && s.loops.length);
  if (!spines.length) {
    return { ok: false, reason: sCoords.length === 1 && !(Array.isArray(o.spineCoords) && o.spineCoords.length)
      ? '正中間切不到東西（這個方向的正中間是空的）—— 換一個側面方向試試。'
      : '側面切不到東西（那個位置是空的）—— 換一個側面方向、或把側面挪到有料的地方。', method: 'interlock' };
  }
  const K = spines.length;
  /** 肋：自動 ＝ 每 spacing 一片（照 6a）；手動挪過 ⇒ 照給的位置一片一片切 */
  let ribs, emptyRibs = 0;
  const ribInfo = [];
  if (Array.isArray(o.ribCoords)) {
    ribs = [];
    for (const c of o.ribCoords.slice().sort((a, b) => a - b)) {
      const s = cutAt(list, ribAx, c, min[ribAx]);
      if (s && s.loops.length) ribs.push(s); else { emptyRibs++; ribInfo.push({ coord: c, n: null, empty: true, loose: 0, weak: 0 }); }
    }
  } else {
    const rr = sliceMany(list, { axis: ribAx, bands: [{ t: spacing, n: '' }] });
    ribs = rr.ok ? rr.slices.filter(s => s.loops.length) : [];
    emptyRibs = rr.ok ? rr.slices.length - ribs.length : 0;
  }
  if (!ribs.length) return { ok: false, reason: '肋一片都切不到東西 —— 把肋的間距調小（或把肋挪到有料的地方）。', method: 'interlock' };

  const warnings = [], notes = [];
  const spineSlots = spines.map(() => []), spineGlue = spines.map(() => []);
  const engage = spines.map(() => []);      // 每一片肋卡在側面的那一點（側面那邊算「有沒有被卡到」用）
  const loose = [], noCross = [], weak = [], multi = [], cutApart = [], flipped = [], conflict = [];
  const ribParts = [];
  const looseDots = [];     // 6d：掉下來的塊在哪（肋位圖的紅點）
  const spLabel = i => K === 1 ? '側面' : `側面 ${i + 1}`;

  ribs.forEach((rib, k) => {
    const n = k + 1, index = K + k;
    const polys = rib.loops.map(l => l.pts);
    const before = rib.loops.filter(l => !l.isHole).length;
    const glue = [], slots = [], held = [];
    const dirOf = new Map();       // 肋的這一塊往哪裡插（照常 ＝ 側面從上面套下來、反過來 ＝ 肋從上面放下來）
    let any = false, skipped = 0, weakHere = 0;
    const weakLens = [];
    spines.forEach((spine, si) => {
      // 交叉線：世界座標 spineAx ＝ spine.coord、ribAx ＝ rib.coord，沿 Y；兩個平面的 v 都是 +Y
      const P = [0, 0, 0]; P[IDX[spineAx]] = spine.coord; P[IDX[ribAx]] = rib.coord;
      const Us = dot(AXES[spineAx].uv[0], P), Ur = dot(AXES[ribAx].uv[0], P);
      const sSp = lineSpans(spine.loops, Us).map(v => ({ v, piece: pieceOf(spine.loops, Us, (v[0] + v[1]) / 2) }));
      const rSp = lineSpans(rib.loops, Ur).map(v => ({ v, piece: pieceOf(rib.loops, Ur, (v[0] + v[1]) / 2) }));
      // 兩片都有料的每一段，記著它在肋的哪一塊、側面的哪一塊
      const ov = [];
      for (const a of sSp) for (const b of rSp) {
        const lo = Math.max(a.v[0], b.v[0]), hi = Math.min(a.v[1], b.v[1]);
        if (hi - lo > 1e-6) ov.push({ y0: lo, y1: hi, sp: a.piece, rp: b.piece });
      }
      if (ov.length) any = true;
      /**
       * 一條線上交叉好幾段（耳朵、下巴）：槽要一路開到那一塊的邊上才插得進去 ⇒ 同一塊上往上開的槽只能是最上面那一段、
       * 往下開的只能是最下面那一段。⭐ 側面同一塊有上下兩段 ⇒ 下面那段照常（肋從上面、側面從下面），
       * 上面那段反過來（肋從下面、側面從上面），兩段都卡得住；排不下的（中間那段、或肋那邊也衝突）從最短的拿掉、講出來。
       */
      let cand = ov.slice(), plan = [];
      for (let guard = 0; guard < 50; guard++) {
        plan = cand.map(c => ({ ...c, flip: false }));
        const bySp = new Map();
        for (const c of plan) { if (!bySp.has(c.sp)) bySp.set(c.sp, []); bySp.get(c.sp).push(c); }
        const bad = new Set();
        for (const g of bySp.values()) {
          g.sort((a, b) => a.y0 - b.y0);
          if (g.length >= 2) { g[g.length - 1].flip = true; for (let i = 1; i < g.length - 1; i++) bad.add(g[i]); }
        }
        const byRp = new Map();
        for (const c of plan) { if (bad.has(c)) continue; if (!byRp.has(c.rp)) byRp.set(c.rp, []); byRp.get(c.rp).push(c); }
        for (const g of byRp.values()) {
          g.sort((a, b) => a.y0 - b.y0);
          // 肋往上開（照常）只能是這一塊最上面那段；往下開（反過來）只能是最下面那段
          g.forEach((c, i) => { if (!c.flip && i !== g.length - 1) bad.add(c); if (c.flip && i !== 0) bad.add(c); });
        }
        if (!bad.size) break;
        const drop = [...bad].sort((a, b) => (a.y1 - a.y0) - (b.y1 - b.y0))[0];
        cand = cand.filter(c => !(c.y0 === drop.y0 && c.y1 === drop.y1 && c.sp === drop.sp && c.rp === drop.rp));
        skipped++;
      }
      for (const c of plan) {
        const L = c.y1 - c.y0, mid = c.flip ? c.y0 + share * L : c.y1 - share * L;
        const rIn = rSp.find(s => s.piece === c.rp && s.v[0] <= mid + 1e-9 && s.v[1] >= mid - 1e-9) || { v: [c.y0, c.y1] };
        const sIn = sSp.find(s => s.piece === c.sp && s.v[0] <= mid + 1e-9 && s.v[1] >= mid - 1e-9) || { v: [c.y0, c.y1] };
        const rAll = rSp.filter(s => s.piece === c.rp), sAll = sSp.filter(s => s.piece === c.sp);
        if (!c.flip) {
          slots.push(...slotPolys(Ur, w, mid, Math.max(...rAll.map(s => s.v[1])) + 1, rIn.v[1], f, +1));
          spineSlots[si].push(...slotPolys(Us, w, mid, Math.min(...sAll.map(s => s.v[0])) - 1, sIn.v[0], f, -1));
          engage[si].push({ x: Us, y: (mid + c.y1) / 2 });
          held.push({ x: Ur, y: (c.y0 + mid) / 2 });
        } else {
          slots.push(...slotPolys(Ur, w, mid, Math.min(...rAll.map(s => s.v[0])) - 1, rIn.v[0], f, -1));
          spineSlots[si].push(...slotPolys(Us, w, mid, Math.max(...sAll.map(s => s.v[1])) + 1, sIn.v[1], f, +1));
          engage[si].push({ x: Us, y: (c.y0 + mid) / 2 });
          held.push({ x: Ur, y: (mid + c.y1) / 2 });
          flipped.push(n);
        }
        /** 6c：同一塊肋跟兩片側面一個照常、一個反過來 ⇒ 這一塊要往上又要往下 ⇒ 組不起來（只講）*/
        const d = c.flip ? -1 : 1, prev = dirOf.get(c.rp);
        if (prev != null && prev !== d) conflict.push(n); else dirOf.set(c.rp, d);
        if (L < 2 * t) {
          weakHere++;
          weakLens.push(L);
          glue.push({ x: Ur, y: mid, area: 0, with: si, onRib: true });
          spineGlue[si].push({ x: Us, y: mid, area: 0, with: index });
        }
      }
    });
    /** 6c：側面好幾片 ⇒ 同一片肋可能好幾處卡不牢 ⇒ 合成一句（本機看到「肋 9（0.65 cm）、9（0.65 cm）、9（0.65 cm）」）*/
    if (weakLens.length) weak.push(weakLens.length === 1 ? `${n}（${r2(weakLens[0])} cm）` : `${n}（${weakLens.length} 處，最短 ${r2(Math.min(...weakLens))} cm）`);
    if (!any) noCross.push(n);
    if (skipped) multi.push(n);
    const pieces = cutSlots(polys, slots);
    // 卡在側面上的塊：槽下面那一段（中間往下）在它裡面
    pieces.forEach(pc => { pc.attached = held.some(h => inside(pc, h.x, h.y)); });
    const chosen = held.length > 0;
    const loopsAll = [];
    let looseHere = 0;
    for (const pc of pieces) {
      const ls = toLoops(pc);
      if (!pc.attached) { looseHere++; const outer = ls.filter(l => !l.isHole).sort((a, b) => b.area - a.area)[0]; if (outer) { outer.loose = true; looseDots.push(dotOf(ribAx, rib.coord, outer)); } }
      loopsAll.push(...ls);
    }
    if (looseHere) loose.push(`${n}（${looseHere} 塊）`);
    if (pieces.length > before && chosen) cutApart.push(n);
    ribInfo.push({ coord: rib.coord, n, empty: false, loose: looseHere, weak: weakHere });
    ribParts.push({
      index, tag: `R${n}`, label: `肋 ${n}`, axis: ribAx, coord: rib.coord, t, band: 0,
      z0: rib.coord - t / 2, z1: rib.coord + t / 2,
      loops: loopsAll, area: loopsAll.reduce((a, l) => a + l.area, 0), bounds: loopsBounds(loopsAll), glue, open: 0
    });
  });

  // 側面：扣掉每一片肋的槽，分塊；沒有被任何一片肋卡到的塊 ＝ 掉下來
  const spineInfo = [], spineLoose = [];
  const spineParts = spines.map((spine, si) => {
    const sPieces = cutSlots(spine.loops.map(l => l.pts), spineSlots[si]);
    const sLoops = [];
    let sLoose = 0;
    for (const pc of sPieces) {
      const ls = toLoops(pc);
      if (!engage[si].some(e => inside(pc, e.x, e.y))) { sLoose++; const outer = ls.filter(l => !l.isHole).sort((a, b) => b.area - a.area)[0]; if (outer) { outer.loose = true; looseDots.push(dotOf(spineAx, spine.coord, outer)); } }
      sLoops.push(...ls);
    }
    if (sLoose) spineLoose.push(`${spLabel(si)}有 ${sLoose} 塊沒有任何一片肋卡到（掉下來）—— 卡片標成紅色。`);
    spineInfo.push({ coord: spine.coord, loose: sLoose });
    return {
      index: si, tag: K === 1 ? 'S' : `S${si + 1}`, label: spLabel(si), axis: spineAx, coord: spine.coord, t, band: 0,
      z0: spine.coord - t / 2, z1: spine.coord + t / 2,
      loops: sLoops, area: sLoops.reduce((a, l) => a + l.area, 0), bounds: loopsBounds(sLoops), glue: spineGlue[si], open: 0
    };
  });

  if (loose.length) warnings.push(`肋 ${loose.join('、')} 有插不到側面的塊（掉下來）—— 切下來會變成散的零件，卡片標成紅色；腳、耳朵那種伸出去的地方常這樣 —— 肋位圖上的紅點就是掉下來的塊：把「側面」改成 2～3 片、按「手動挪肋」把側面拖到紅點上，再按「幫我挪有問題的肋」（腳張開的模型這樣多半救得回來）。`);
  if (noCross.length) warnings.push(`肋 ${listNums(noCross)} 整片跟側面沒有交叉（側面在那裡沒有料）—— 整片都會掉下來；換側面方向，或改肋的間距。`);
  warnings.push(...spineLoose);
  if (cutApart.length) warnings.push(`肋 ${listNums(cutApart)} 被槽切成兩塊以上（槽要一路開到料的邊上才插得進去）—— 切開的那一塊多半會掉下來。`);
  if (weak.length) warnings.push(`肋 ${weak.join('、')} 跟側面交叉的地方不到兩倍板厚（${r2(2 * t)} cm），卡不牢 —— 卡片上黃圈；可以加膠，或改肋的間距錯開那裡。`);
  if (multi.length) warnings.push(`肋 ${listNums(multi)} 跟側面在同一條線上、同一塊交叉好幾段 —— 同一塊只能開一個槽（槽要一路開到邊上才插得進去），用最長那一段，其他段被槽挖開、沒有卡住。`);
  if (conflict.length) warnings.push(`肋 ${listNums([...new Set(conflict)])} 的同一塊碰到兩片側面，一片要從上面套、一片要從下面插 —— 組不起來；在肋位圖上挪一下那片肋，或改側面的片數。`);
  if (flipped.length) notes.push(`肋 ${listNums([...new Set(flipped)])} 跟側面在同一條線上交叉上下兩段 —— 上面那段的槽反過來開（肋從下面、側面從上面），兩段都卡得住；組的時候那幾片從上面放下來。`);
  if (emptyRibs) notes.push(`有 ${emptyRibs} 片肋切到空的地方，沒有算進去。`);
  if (spines.length < sCoords.length) notes.push(`有 ${sCoords.length - spines.length} 片側面切到空的地方，沒有算進去 —— 肋位圖上畫成虛線；按「手動挪肋」可以把它拖到有料的地方（或紅點上）。`);
  // 開放曲面、沒有布林函式庫那幾句（照 6a：看側面那一刀講的）
  for (const wmsg of spines[0].warns || []) if (/封閉|布林/.test(wmsg)) { warnings.push(wmsg); break; }

  ribInfo.sort((a, b) => a.coord - b.coord);
  const slices = [...spineParts, ...ribParts];
  return {
    ok: true, method: 'interlock', axis: spineAx, ribAxis: ribAx, slices, warnings, notes, bounds, ribInfo, spineInfo, looseDots,
    plan: { bands: [] },
    stats: {
      count: slices.length, spines: K, ribs: ribParts.length, spineAx, ribAx, t, slotW: w, spacing,
      crossings: ribParts.length - noCross.length, conflicts: new Set(conflict).size,
      spineCoords: spines.map(s => s.coord), ribCoords: ribs.map(s => s.coord),
      /** 6d 線上先驗抓到：側面改 2 片、第二片落在空的地方被略掉 ⇒ 手動時要留著它，人才拖得到紅點上 */
      spineCoordsWanted: sCoords.slice(),
      area: slices.reduce((a, s) => a + s.area, 0),
      thickKinds: [r2(t)], used: 0, height: 0, diff: 0
    }
  };
}

/** 6c：有問題的程度（越小越好）—— 掉下來最要緊，再來組不起來、卡不牢 */
export function interlockScore(r) {
  if (!r || !r.ok) return Infinity;
  const looseN = r.slices.reduce((a, s) => a + s.loops.filter(l => l.loose).length, 0);
  const looseA = r.slices.reduce((a, s) => a + s.loops.filter(l => l.loose).reduce((b, l) => b + l.area, 0), 0);
  const weakN = r.ribInfo.reduce((a, q) => a + q.weak, 0);
  return looseN * 1000 + r.stats.conflicts * 1000 + weakN * 100 + looseA * 10;
}

/**
 * 🔴 **幫我挪有問題的肋**（6c，kang 2026-10-25「要「幫我挪有問題的肋」按鈕（按了才算）」）。
 * 有掉下來、卡不牢的肋（或整體還有卡不牢、組不起來）一片一片往左右試 0.5、1 cm（可以連挪；跟旁邊的肋至少隔 2 倍板厚），
 * 比較好才留 —— 結果只是建議，人在肋位圖上還可以再改。⚠ 每試一次整個重切：汽車要 20 幾秒（按了才算、先講正在算）。
 * @returns {{ribCoords:number[], spineCoords:number[], moves:{n:number, from:number, to:number}[], before:object, after:object}|null}
 */
export function suggestRibs(meshes, opt = {}) {
  let cur = interlockMany(meshes, opt);
  if (!cur.ok) return null;
  const sum = r => ({
    loose: r.slices.reduce((a, s) => a + s.loops.filter(l => l.loose).length, 0),
    weak: r.ribInfo.reduce((a, q) => a + q.weak, 0), conflicts: r.stats.conflicts
  });
  const before = sum(cur), start = cur.stats.ribCoords.slice();
  let coords = start.slice(), best = interlockScore(cur);
  const base = { ...opt, spineCoords: cur.stats.spineCoords };
  const t = cur.stats.t;
  for (let i = 0; i < coords.length; i++) {
    const info = cur.ribInfo.find(q => !q.empty && Math.abs(q.coord - coords[i]) < 1e-9);
    const anyWeak = cur.ribInfo.some(q => q.weak);
    if (!(info && (info.loose || info.weak)) && !anyWeak && !cur.stats.conflicts) continue;
    for (const d of [-1, -0.5, 0.5, 1]) {
      const c = Math.round((coords[i] + d) * 100) / 100;
      if ((i > 0 && c - coords[i - 1] < 2 * t) || (i < coords.length - 1 && coords[i + 1] - c < 2 * t)) continue;
      const trial = coords.slice(); trial[i] = c;
      const r = interlockMany(meshes, { ...base, ribCoords: trial });
      const sc = interlockScore(r);
      if (sc < best - 1e-6) { best = sc; cur = r; coords = trial; }
    }
  }
  const moves = coords.map((c, i) => ({ n: i + 1, from: start[i], to: c })).filter(m => Math.abs(m.to - m.from) > 1e-9);
  return { ribCoords: coords, spineCoords: cur.stats.spineCoords, moves, before, after: sum(cur) };
}

/**
 * 6c 肋位圖用：從上面看的外形 —— 從下到上切 7 層疊在一起（腳在下面，只切中間會漏掉）。
 * 回傳每一圈 [{x, z}]（世界座標）。
 */
export function topOutline(meshes) {
  const list = meshes.filter(Boolean);
  if (!list.length) return [];
  let lo = Infinity, hi = -Infinity;
  for (const m of list) { const b = m.bounds(); lo = Math.min(lo, b.min.y); hi = Math.max(hi, b.max.y); }
  const out = [];
  for (let k = 1; k <= 7; k++) {
    const s = cutAt(list, 'y', lo + (hi - lo) * k / 8, lo);
    // 切 Y 的平面座標：u ＝ x、v ＝ −z
    if (s) for (const l of s.loops) out.push(l.pts.map(p => ({ x: p.x, z: -p.y })));
  }
  return out;
}
