/**
 * propose.js — 智慧分切：程式提案縫（2026-10-13 → `規格\建模器-智慧分切.md`）
 *
 * kang 選的是「**程式提案、我決定**」：這裡只**算出建議**，⛔ 改物件的任何一條邊 ——
 * 改是使用者按「全部接受」之後，`main.js` 照提案一條一條 `setSeam()`。
 * 純函式、⛔ 碰畫面 ⇒ 測試裡直接驗。判斷一律交給真的展開程式（`unfoldMesh()`），在網格的**複製品**上臨時標 CUT。
 *
 * ── 第二步：放得進板子（規格「第二步」第 1 節）──────────────────
 *   1. 分塊：相鄰的面共面、或轉折小於 30°（曲面上的分格）⇒ 同一塊；使用者標的縫一定分開
 *   2. 一開始每塊各自一片（切口全在轉角上）；標了不准切的兩塊先接起來
 *   3. 照共用邊界由長到短、一對一對試著接 —— **只放開那兩塊之間的邊**；
 *      片變少、放不進的沒變多、沒有重疊 ⇒ 接。走兩輪
 *   4. 跟第一步那種「程式本來剪的」比，挑比較好的（放不進的少 → 沒重疊 → 片少 → 縫短）
 *   5. 提案 ＝ 最後那份切法裡「切開、而且不是使用者標的」邊
 *   6. 超過時間上限（預設 2 秒）就交出目前最好的
 *
 * ── 第三步：曲面切成整齊的長線（規格「第三步」第 1 節；候選在 `curved.js`）──────
 *   1. 曲面用比較寬的角度（< 46°）另外找一次；是一圈一圈的格子 ⇒ 列候選（長條／環帶／花瓣）
 *   2. 每個候選都攤一次（整個曲面當一塊、塊的邊界照第二步的起點切開），照
 *      放不進的少 → 沒重疊 → **程式補剪的線少** → 片少 → 縫短 挑（每一片容許補剪 1 條：一刀直線本來就是順的）
 *   3. 每一種（只沿轉角／長條／環帶／花瓣）各留最好的一份，各自照第二步接完 ⇒ `options`；最好的那份當提案
 *   ⚠ 「只沿轉角」那一份**完全照第二步**（塊照 30° 分、跟「程式本來剪的」比）—— 只有平面的物件結果一個字都不變
 *   ⚠ 圓環繞管子 12 段 ＝ 每格轉 30°，剛好卡在分塊的 30° 上 ⇒ 第二步會把它切成 12 圈；所以曲面另外用 46° 找
 *
 * 🔴 **踩過的兩次**（沙箱原型，2026-10-13）：
 *   · 「接」的時候把兩組之間的邊**全部**放開 ⇒ 展開程式把整組重新排過（方塊接上側板變成 145×145 放不進）
 *     ⇒ 一次只放開兩塊之間的那一條共用邊界（`open` 只放「接受了的那幾對」）
 *   · 判斷放不放得進沒扣排版間距 ⇒ 改用排版那支 `fitsBoard()`（第一步也是同一個錯）
 */

import * as THREE from 'three';
import { unfoldMesh } from './flatten.js';
import { makeRule, DEFAULT_MATERIAL } from './rules.js';
import { isMarkable, isSeam, markSignature } from './seam.js';
import { EDGE_ROLE } from '../core/mesh.js';
import { fitsBoard, NEST_DEFAULTS } from '../out/nest.js';
import { gridOf, candidatesOf } from './curved.js';
import { canonicalMesh } from './part.js';

const DEG = 180 / Math.PI;
/** 轉折小於這個角度 ＝ 曲面上的分格，算同一塊（圓柱 32 段約 11°、圓角 4 段 22.5°；方塊的角 90°）*/
export const SMOOTH_DEG = 30;
/** 第三步找曲面用的角度：圓環繞管子 12 段（30°）要算同一塊；八角柱（45°）也當曲面試（不加刀那份一定在候選裡，不會變差）*/
export const GRID_DEG = 46;
/** 轉折大於這個角度的邊才算「有彎」（一塊裡完全沒有 ⇒ 是平面，⛔ 找格子）*/
const CURVE_DEG = 1;
/** 每一種切法的名稱（面板用）；`corner` ＝ 只沿轉角切（第二步那種）*/
export const KIND_LABEL = { corner: '只沿轉角', petal: '花瓣', strip: '長條', band: '環帶' };
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function unionFind() {
  const p = new Map();
  const find = x => {
    if (!p.has(x)) p.set(x, x);
    while (p.get(x) !== x) { p.set(x, p.get(p.get(x))); x = p.get(x); }
    return x;
  };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) p.set(a, b); };
  return { find, union };
}

const innerEdges = m => [...m.edges()].filter(h => h.face && h.twin && h.twin.face);
const isUserCut = h => h.role === EDGE_ROLE.CUT;

/**
 * @param {object} obj 已轉成可編輯網格的物件
 * @param {object} opt `{ material, board: { w, h, gap, rotate }, timeLimitMs }`（材料、板子照展開圖視窗與排版設定）
 * @returns {{
 *   edges: HalfEdge[],       提案的邊（物件自己那份網格上、可以標的）
 *   unmarkable: number,      提案裡標不上的（共面的邊 —— 接受時會跳過）
 *   total: number,           接受之後展開幾片
 *   maxPiece: {w, h}|null,   最大一片的外框
 *   big: number,             幾片還是放不進
 *   bigCurved: number,       其中「一整個曲面、沒有轉角可以切」的（第三步）
 *   bigFlat: number,         其中「本身就是一個比板子大的平面」的
 *   overlap: boolean,        提案的片還有重疊
 *   keepCut: number,         標了不准切、還是非切不可的條數
 *   cutLen: number,          提案的縫總長（cm）
 *   usedBaseline: boolean,   挑的是「程式本來剪的」那份
 *   timedOut: boolean,       算到時間上限先交出
 *   kind, label,             用的是哪一種切法（`KIND_LABEL`；幾塊曲面挑的不一樣 ⇒ 名稱用「＋」接）
 *   options: object[],       每一種切法各一份（上面那幾欄 ＋ kind、label），第 0 份 ＝ 提案；只有平面 ⇒ 只有 1 份
 *   nonGrid: number,         幾塊曲面不是一圈一圈的格子（照沿轉角切）
 *   board, sig, mesh
 * }}
 */
export function proposeSeams(obj, opt = {}) {
  const t0 = now();
  const limit = opt.timeLimitMs ?? 2000;
  const board = { ...NEST_DEFAULTS, ...(opt.board || {}) };
  const rule = makeRule(opt.material || DEFAULT_MATERIAL, obj.thickness);
  const own = obj.mesh();

  /** 縮放吃進去（跟 `unfoldObject()` 一樣）；`clone()`／`transformed()` 都保持頂點順序 ⇒ 用頂點編號對回物件自己的網格 */
  const s = obj.scale || { x: 1, y: 1, z: 1 };
  const scaled = Math.abs(s.x - 1) > 1e-9 || Math.abs(s.y - 1) > 1e-9 || Math.abs(s.z - 1) > 1e-9;
  let base = scaled ? own.transformed(new THREE.Matrix4().makeScale(s.x, s.y, s.z)) : own.clone();
  /**
   * 🔴 網格物件照存檔內容重建後才試攤 —— 跟 `unfoldObject()` 同一個做法（`part.js` `canonicalMesh()`，2026-10-19 實驗 T3），
   * ⛔ 的話提案在編輯中的網格上量、展開圖在重建的那份上攤，兩邊的片可能對不上。⭐ `fromJSON()` 保持頂點順序 ⇒ 下面照頂點編號對回照舊。
   */
  if (obj.src && obj.src.type === 'mesh') base = canonicalMesh(base).mesh;
  base.computeNormals();

  const vi = new Map(base.verts.map((v, i) => [v.id, i]));
  const pairKey = (m, idx, h) => { const a = idx.get(h.v.id), b = idx.get(h.to.id); return a < b ? `${a}-${b}` : `${b}-${a}`; };
  const ownIdx = new Map(own.verts.map((v, i) => [v.id, i]));
  const ownByPair = new Map(innerEdges(own).map(h => [pairKey(own, ownIdx, h), h]));

  const inner = innerEdges(base);
  const pk = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const fkey = (m, idx, f) => m.faceVerts(f).map(v => idx.get(v.id)).sort((a, b) => a - b).join(',');
  const fits = p => fitsBoard(p.width, p.height, board);
  const deg = h => { const d = base.dihedral(h); return d === null ? 0 : Math.abs(d * DEG); };
  let timedOut = false;
  const late = () => (now() - t0 > limit ? (timedOut = true) : false);

  /**
   * 一套「塊」＋ 在上面評估、接塊的工具。`merged` ＝ 要整個當一塊的面（第三步的格子曲面）；空的 ⇒ 完全照第二步。
   */
  const engine = merged => {
    // ── 1. 分塊 ──
    const S = unionFind();
    for (const f of base.faces) S.find(f.id);
    for (const h of inner) {
      if (isUserCut(h)) continue;
      if (deg(h) < SMOOTH_DEG) S.union(h.face.id, h.twin.face.id);
    }
    for (const faces of merged) { const fs = [...faces]; for (let i = 1; i < fs.length; i++) S.union(fs[0], fs[i]); }
    const sid = f => S.find(f.id);

    // 不准切 ⇒ 那兩塊先接起來；塊與塊之間的邊照「塊對」分組、記共用長度
    const forced = [];
    const pairs = new Map();
    for (const h of inner) {
      if (isUserCut(h)) continue;
      const a = sid(h.face), b = sid(h.twin.face);
      if (a === b) continue;
      if (h.keep) forced.push([a, b]);
      const k = pk(a, b);
      if (!pairs.has(k)) pairs.set(k, { a, b, len: 0 });
      pairs.get(k).len += h.v.p.distanceTo(h.to.p);
    }
    const order = [...pairs.values()].sort((x, y) => y.len - x.len);

    // 複製品的面 ↔ 原本的面：用「頂點編號組合」配
    const surfOfKey = new Map(base.faces.map(f => [fkey(base, vi, f), sid(f)]));

    /**
     * 照「接受了的塊對」標臨時 CUT、攤一次；`accepted === null` ＝ 一刀都不加（＝ 程式本來剪的，第一步那種）。
     * `fixed` ＝ 第三步挑定的曲面切法（頂點編號配對），一律切。
     */
    const evaluate = (accepted, fixed = null) => {
      const open = new Set([...forced, ...(accepted || [])].map(([a, b]) => pk(a, b)));
      const work = base.clone();
      const wvi = new Map(work.verts.map((v, i) => [v.id, i]));
      const ws = new Map(work.faces.map(f => [f.id, surfOfKey.get(fkey(work, wvi, f))]));
      if (accepted !== null) {
        for (const h of innerEdges(work)) {
          if (isUserCut(h)) continue;
          const a = ws.get(h.face.id), b = ws.get(h.twin.face.id);
          if ((a !== b && !open.has(pk(a, b))) || (fixed && fixed.has(pairKey(work, wvi, h)))) work.setRole(h, EDGE_ROLE.CUT);
        }
      }
      const r = unfoldMesh(work, rule);
      // 提案的邊：切開、⛔ 是使用者原本標的（臨時 CUT ＋ 程式補剪）
      const auto = new Set((r.autoEdges || []).map(h => Math.min(h.id, h.twin.id)));
      const cuts = [];
      let cutLen = 0;
      for (const h of innerEdges(work)) {
        const cut = isUserCut(h) || auto.has(Math.min(h.id, h.twin.id));
        if (!cut) continue;
        const o = ownByPair.get(pairKey(work, wvi, h));
        if (!o || isSeam(o)) continue;
        cuts.push(o);
        cutLen += h.v.p.distanceTo(h.to.p);
      }
      return {
        r, cuts, cutLen,
        misfit: r.pieces.reduce((n, p) => n + (fits(p) ? 0 : p.qty), 0),
        overlap: r.pieces.some(p => p.overlap),
        total: r.stats.total,
        // 程式補剪的線：每一片容許 1 條（一刀直線本來就是順的 —— 圓柱側面就是這樣）
        jag: r.pieces.reduce((n, p) => n + Math.max(0, ((p.autoCut && p.autoCut.lines) || 0) - 1) * p.qty, 0)
      };
    };

    /** ── 2、3. 每塊一片 → 一對一對試著接 ── 回傳 `{start, cur}` */
    const merge = (fixed = null) => {
      const accepted = [];
      const start = evaluate(accepted, fixed);
      let cur = start;
      outer:
      for (let pass = 0; pass < 2; pass++) {
        let changed = false;
        const G = unionFind();
        for (const [a, b] of [...forced, ...accepted]) G.union(a, b);
        for (const pr of order) {
          if (late()) break outer;
          if (G.find(pr.a) === G.find(pr.b)) continue;              // 已經同一片（再接會繞成一圈）
          const nx = evaluate([...accepted, [pr.a, pr.b]], fixed);
          if (nx.misfit <= cur.misfit && !nx.overlap && nx.total < cur.total) {
            cur = nx;
            accepted.push([pr.a, pr.b]);
            G.union(pr.a, pr.b);
            changed = true;
          }
        }
        if (!changed) break;
      }
      return { start, cur };
    };
    return { evaluate, merge };
  };

  const better = (x, y) => // x 比 y 好？放不進的少 → 沒重疊 → 片少 → 縫短（第二步）
    x.misfit !== y.misfit ? x.misfit < y.misfit
      : x.overlap !== y.overlap ? !x.overlap
        : x.total !== y.total ? x.total < y.total
          : x.cutLen < y.cutLen - 1e-6;
  const better3 = (x, y) => // 第三步：沒重疊之後多比「程式補剪的線少」
    x.misfit !== y.misfit ? x.misfit < y.misfit
      : x.overlap !== y.overlap ? !x.overlap
        : x.jag !== y.jag ? x.jag < y.jag
          : x.total !== y.total ? x.total < y.total
            : x.cutLen < y.cutLen - 1e-6;

  /** 一份完整的提案（面板、3D 線、接受都用這份）*/
  const finish = (kind, label, start, pick, usedBaseline) => {
    // 還放不進的：一開始（每塊各自一片）就放不進的那幾片 —— 接了也不會變好，分成曲面／平面講
    let bigCurved = 0, bigFlat = 0;
    if (pick.misfit) {
      for (const p of start.r.pieces) {
        if (fits(p)) continue;
        if (p.folds.length || p.bends.length) bigCurved += p.qty; else bigFlat += p.qty;
      }
    }
    const own2 = pick.cuts.filter((h, i, a) => a.indexOf(h) === i);
    const edges = own2.filter(h => isMarkable(own, h));
    let maxPiece = null;
    for (const p of pick.r.pieces) {
      if (!maxPiece || p.width * p.height > maxPiece.w * maxPiece.h) maxPiece = { w: p.width, h: p.height };
    }
    return {
      kind, label,
      edges,
      unmarkable: own2.length - edges.length,
      total: pick.total,
      maxPiece,
      big: pick.misfit,
      bigCurved, bigFlat,
      overlap: pick.overlap,
      keepCut: pick.r.keepCut || 0,
      cutLen: pick.cutLen,
      usedBaseline,
      _score: pick
    };
  };

  // ── 第二步：只沿轉角（⚠ 完全照第二步，只有平面的物件就只有這一份）──
  const E0 = engine([]);
  const m0 = E0.merge();
  const baseline = E0.evaluate(null);
  const usedBaseline = better(baseline, m0.cur) || (!better(m0.cur, baseline) && baseline.misfit === 0 && !baseline.overlap);
  const corner = finish('corner', KIND_LABEL.corner, m0.start, usedBaseline ? baseline : m0.cur, usedBaseline);

  // ── 第三步：找格子曲面 ──
  const R = unionFind();
  for (const f of base.faces) R.find(f.id);
  for (const h of inner) if (!isUserCut(h) && deg(h) < GRID_DEG) R.union(h.face.id, h.twin.face.id);
  const regionFaces = new Map();
  for (const f of base.faces) {
    const r = R.find(f.id);
    if (!regionFaces.has(r)) regionFaces.set(r, new Set());
    regionFaces.get(r).add(f.id);
  }
  const keepKeys = new Set(inner.filter(h => h.keep).map(h => pairKey(base, vi, h)));
  const regions = [];
  let nonGrid = 0;
  for (const faces of regionFaces.values()) {
    const own3 = inner.filter(h => faces.has(h.face.id) && faces.has(h.twin.face.id) && !isUserCut(h));
    // 太小的（例如齒輪每一齒的小圓弧，⇒ 齒輪有 80 幾塊）⛔ 找：沒什麼可以排整齊的，每塊都走一次線會拖到好幾秒
    if (own3.length < 8 || !own3.some(h => deg(h) > CURVE_DEG)) continue;
    if (late()) break;
    const g = gridOf(base, faces);
    if (!g) { nonGrid++; continue; }
    // 不准切：碰到不准切的那一種就不列
    const cands = candidatesOf(g).filter(c => ![...c.keys].some(k => keepKeys.has(k)));
    if (cands.length) regions.push({ faces, cands });
  }

  const options = [corner];
  if (regions.length) {
    const E1 = engine(regions.map(r => r.faces));
    const union = sets => new Set(sets.flatMap(x => (x ? [...x] : [])));
    // 每塊曲面：每一種各留最好的一份（其他曲面先不加刀）
    for (const rg of regions) {
      rg.best = { corner: null };                                  // corner ＝ 不加刀
      rg.score = { corner: E1.evaluate([], null) };
      for (const c of rg.cands) {
        if (late()) break;
        const sc = E1.evaluate([], c.keys);
        if (!rg.score[c.kind] || better3(sc, rg.score[c.kind])) { rg.score[c.kind] = sc; rg.best[c.kind] = c.keys; }
      }
      rg.top = Object.keys(rg.score).reduce((a, k) => (better3(rg.score[k], rg.score[a]) ? k : a), 'corner');
    }
    const plan = (kind, label, pickOf) => {
      const m = E1.merge(union(regions.map(pickOf)));
      return finish(kind, label, m.start, m.cur, false);
    };
    // 每塊各挑最好的 ⇒ 提案；只有一塊（最常見）時就是那一種
    const tops = [...new Set(regions.map(r => r.top))];
    if (!(tops.length === 1 && tops[0] === 'corner')) {
      options.push(plan(tops.length === 1 ? tops[0] : 'mix', tops.map(k => KIND_LABEL[k]).join('＋'), r => r.best[r.top]));
    }
    for (const k of ['petal', 'strip', 'band']) {
      if (tops.length === 1 && tops[0] === k) continue;            // 跟提案同一份
      if (!regions.some(r => r.best[k])) continue;
      if (late()) break;
      options.push(plan(k, KIND_LABEL[k], r => r.best[k] || null));
    }
    // 第 0 份 ＝ 最好的（照第三步的判準）；其餘照好壞排
    options.sort((x, y) => (better3(x._score, y._score) ? -1 : better3(y._score, x._score) ? 1 : 0));
  }
  for (const o of options) delete o._score;

  return {
    ...options[0],
    options,
    nonGrid,
    timedOut,
    board,
    sig: markSignature(own),
    mesh: own
  };
}
