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
 * ── 第四步：片裡不要細切口（2026-10-21，`分片成群-設計方向.md` 第 8 節，kang 定案）──────
 *   「只沿轉角」那一份改成：
 *   1. 塊 ＝ 每一塊平面（`group.js` `regionInfo()`）；碎面跟著共用邊最長的鄰居、不准切的兩塊先接
 *   2. 照「切的先後」排塊對：⭐ 預設「凹處、尖角先切」＝ 平的、凸的、長的先接（凹的最後；Blender 紙模外掛預設也是凹的先切）；
 *      可以改「片數最少」＝ 共用邊長的先接（第二步原本的排法）
 *   3. 一對一對試著接，**只攤接起來的那一片**（其他片不受影響；結果跟整個重攤一樣、快 5～8 倍 —— 沙箱對過）；
 *      片變少、沒重疊、放不進的沒變多，⭐ **而且沒有多出細切口、程式沒有多補剪** ⇒ 接
 *      （「片少一點」：先照上面接完，再放寬「細切口」「補剪」那兩條再接一輪）
 *   4. 小於 2 cm 的片：放寬條件再試著併給旁邊；併了會疊就留著
 *      ⚠ 「不要細切口」時**只放寬「補剪」、⛔ 放寬細切口**（2026-10-21，kang「同意你的建議」）—— 以前兩條都放寬，
 *      齒輪 80 齒嚴格接完 13 片 0 個，這一步併成 9 片卻多出 7 個細切口（設定被越過去）。留下來的小片面板講幾片（`small`）
 *   5. 最後整個攤一次、跟「程式本來剪的」比（放不進的少 → 沒重疊 →（不要細切口時）細切口少 → 片少 → 縫短）
 *   **細切口** ＝ 切線走到片中間一個點就停（那個點只接一條切線）、那個點攤開只張開不到 `NOTCH_DEG`°（張開 ＝ 360° − 一圈面角的和）。
 *   ⚠ 「同一片裡的切線」⛔ 一律算壞事：方塊攤成十字形那 7 條也在同一片裡（`seam.js` `seamKinds()` 算成開口）—— 業界也⛔ 這樣算
 *   （`外部參考-自動分切.md` 第 7 節）；真正費工的是很窄的 V 形切口。
 *
 * 🔴 **踩過的兩次**（沙箱原型，2026-10-13）：
 *   · 「接」的時候把兩組之間的邊**全部**放開 ⇒ 展開程式把整組重新排過（方塊接上側板變成 145×145 放不進）
 *     ⇒ 一次只放開兩塊之間的那一條共用邊界（`open` 只放「接受了的那幾對」）
 *   · 判斷放不放得進沒扣排版間距 ⇒ 改用排版那支 `fitsBoard()`（第一步也是同一個錯）
 */

import * as THREE from 'three';
import { unfoldMesh } from './flatten.js';
import { makeRule, DEFAULT_MATERIAL } from './rules.js';
import { isMarkable, isSeam, markSignature, vertexAngles, NOTCH_DEG } from './seam.js';
import { EDGE_ROLE } from '../core/mesh.js';
import { fitsBoard, NEST_DEFAULTS } from '../out/nest.js';
import { gridOf, candidatesOf } from './curved.js';
import { canonicalMesh } from './part.js';
import { regionInfo, tinyRegions, hostOf } from './group.js';
import { Mesh } from '../core/mesh.js';

const DEG = 180 / Math.PI;
/** 轉折小於這個角度 ＝ 曲面上的分格，算同一塊（圓柱 32 段約 11°、圓角 4 段 22.5°；方塊的角 90°）*/
export const SMOOTH_DEG = 30;
/** 第三步找曲面用的角度：圓環繞管子 12 段（30°）要算同一塊；八角柱（45°）也當曲面試（不加刀那份一定在候選裡，不會變差）*/
export const GRID_DEG = 46;
/** 轉折大於這個角度的邊才算「有彎」（一塊裡完全沒有 ⇒ 是平面，⛔ 找格子）*/
const CURVE_DEG = 1;
/** 每一種切法的名稱（面板用）；`corner` ＝ 只沿轉角切（第二步那種）*/
export const KIND_LABEL = { corner: '只沿轉角', petal: '花瓣', strip: '長條', band: '環帶' };
/** 第四步（2026-10-21）的三個設定 ⭐ 預設：不要細切口、30°、凹處尖角先切 */
/** 細切口的角度 —— 家在 `seam.js`（3D 的開口顏色也用它）；這裡轉出去給面板與測試 */
export { NOTCH_DEG };
export const MIN_PIECE_CM = 2;
/** 轉折小於這個角度的一整塊先整塊試（曲面的分格：齒輪的齒弧、圓柱 32 段約 11°）；低多邊形的臉、眼窩那種轉折⛔ 碰 */
const PREMERGE_DEG = 15;
export const SLIT_LABEL = { none: '不要細切口', allow: '片少一點（允許細切口）' };
export const ORDER_LABEL = { feature: '凹處、尖角先切', fewest: '片數最少' };
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
/**
 * 🔴 **一口氣算完**（測試、程式裡要馬上拿到結果的地方用）。⭐ 預設**⛔ 設時間上限**（kang「算得對第一、算得快第二」，2026-10-21）——
 * 以前預設 2 秒就截斷、交出沒算完的（齒輪 74 片；算完是 5 片）。要上限照樣可以傳 `timeLimitMs`。
 */
export function proposeSeams(obj, opt = {}) {
  const g = proposeGen(obj, opt);
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}

/**
 * 🔴 **一邊算、一邊讓畫面喘口氣**（面板用，2026-10-21 大模型 丙）：每算 `sliceMs` 毫秒就讓出去一次 ——
 * 畫面不卡、`onProgress(進度)` 更新面板、`opt.shouldStop()` 回 true ⇒ 收手、交出**目前最好的**（`timedOut` ＝ true，面板講「還沒算完」）。
 * ⚠ ⛔ 開背景執行緒：這樣最簡單、跟一口氣算完是**同一份程式**（結果一模一樣）。
 */
export async function proposeSeamsAsync(obj, opt = {}, { onProgress = null, sliceMs = 40 } = {}) {
  const g = proposeGen(obj, opt);
  let last = now();
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    if (now() - last >= sliceMs) {
      if (onProgress) onProgress({ ...r.value, ms: now() - r.value.t0 });
      await new Promise(res => setTimeout(res, 0));
      last = now();
    }
  }
}

function* proposeGen(obj, opt = {}) {
  const t0 = now();
  const limit = opt.timeLimitMs ?? Infinity;
  const stopAsked = typeof opt.shouldStop === 'function' ? opt.shouldStop : () => false;
  /** 進度（`proposeSeamsAsync()` 交給面板）：在算哪一段、這一段試了幾對／共幾對 */
  const prog = { t0, phase: '', done: 0, total: 0 };
  const step = (phase, total) => { prog.phase = phase; prog.done = 0; prog.total = total; };
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
  const late = () => (now() - t0 > limit || stopAsked() ? (timedOut = true) : false);
  const slits = opt.slits === 'allow' ? 'allow' : 'none';
  const notchDeg = Number.isFinite(+opt.notchDeg) && opt.notchDeg !== null && opt.notchDeg !== ''
    ? Math.max(0, Math.min(180, +opt.notchDeg)) : NOTCH_DEG;
  const cutOrder = opt.cutOrder === 'fewest' ? 'fewest' : 'feature';
  const minPiece = Number.isFinite(+opt.minPieceCm) && opt.minPieceCm !== null ? +opt.minPieceCm : MIN_PIECE_CM;

  /** 每個頂點攤開張開幾度（360° − 一圈面角的和）、在不在網格邊緣 —— 用頂點編號（`vi`）記，複製品、子網格都對得回來 */
  const VA = vertexAngles(base);                   // ⚠ 凹的角也算對（`seam.js`）
  const gapOf = new Map(base.verts.map((v, i) => [i, VA.angle.get(v.id) || 0]));
  const border = new Set();
  base.verts.forEach((v, i) => { if (VA.border.has(v.id)) border.add(i); });
  /**
   * 細切口幾個：`m` 上的切線（CUT 或程式補剪 `autoSet`）只有一條接到的頂點、⛔ 在網格邊緣、攤開張開 < notchDeg°。
   * `idxOf(v)` ＝ 這個頂點在 `base` 的編號；`edgeOf(v)` ＝ 這個頂點在 `m` 上是不是邊緣（子網格的外框 ＝ 片的外框，⛔ 算）。
   */
  const notchOf = (m, idxOf, autoSet) => {
    const deg = new Map(), mb = new Set();
    for (const h of m.edges()) {
      if (!h.face || !h.twin || !h.twin.face) { mb.add(h.v.id); mb.add(h.to.id); continue; }
      if (!(h.role === EDGE_ROLE.CUT || autoSet.has(Math.min(h.id, h.twin.id)))) continue;
      deg.set(h.v.id, (deg.get(h.v.id) || 0) + 1);
      deg.set(h.to.id, (deg.get(h.to.id) || 0) + 1);
    }
    let n = 0;
    for (const v of m.verts) {
      if (deg.get(v.id) !== 1 || mb.has(v.id)) continue;
      const k = idxOf(v);
      if (border.has(k)) continue;
      if ((2 * Math.PI - (gapOf.get(k) || 0)) * DEG < notchDeg) n++;
    }
    return n;
  };

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
      const notch = notchOf(work, v => wvi.get(v.id), auto);
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
        r, cuts, cutLen, notch,
        misfit: r.pieces.reduce((n, p) => n + (fits(p) ? 0 : p.qty), 0),
        overlap: r.pieces.some(p => p.overlap),
        total: r.stats.total,
        // 程式補剪的線：每一片容許 1 條（一刀直線本來就是順的 —— 圓柱側面就是這樣）
        jag: r.pieces.reduce((n, p) => n + Math.max(0, ((p.autoCut && p.autoCut.lines) || 0) - 1) * p.qty, 0)
      };
    };

    /** ── 2、3. 每塊一片 → 一對一對試著接 ── 回傳 `{start, cur}` */
    /**
     * 🔴 **接塊：只攤接起來的那一組**（2026-10-21，大模型加快；kang「算得對第一、算得快第二」）。
     * 以前每試一對就把整個物件重攤一次（齒輪 1,656 面這一段要 7.5 秒）。判斷條件**照舊、一個字都不變**：
     *   接了之後「全部的片數變少、哪一片都沒重疊、放不進的沒變多」才接 ——
     *   其他組⛔ 受影響 ⇒ 等於「接起來那一組的片數 < 兩組加起來、它⛔ 疊、它的放不進 ≤ 兩組加起來」，
     *   ⭐ 而且「**別的組都沒有重疊**」（以前整個攤時，別的片有疊就一律不接 —— 這一條照樣守）。
     * ⚠ 結果跟以前整個攤**一模一樣**（對照組逐條比過）；最後照舊整個攤一次交出提案。
     */
    const facesOfSid = new Map();
    for (const f of base.faces) { const b = sid(f); if (!facesOfSid.has(b)) facesOfSid.set(b, []); facesOfSid.get(b).push(f); }
    const forder = new Map(base.faces.map((f, i) => [f.id, i]));
    const baseEdge = new Map(inner.map(h => [pairKey(base, vi, h), h]));
    const local = (faces0, open, fixed, sideA) => {
      const faces = [...faces0].sort((x, y) => forder.get(x.id) - forder.get(y.id));
      const used = new Map(), pts = [];
      const at = v => { if (!used.has(v.id)) { used.set(v.id, pts.length); pts.push(v.p.clone()); } return used.get(v.id); };
      const sub = Mesh.fromFaceList(pts, faces.map(f => base.faceVerts(f).map(at)));
      sub.computeNormals();
      const toBase = new Array(pts.length);
      for (const [id, i] of used) toBase[i] = vi.get(id);
      const sIdx = new Map(sub.verts.map((v, i) => [v.id, toBase[i]]));
      for (const h of innerEdges(sub)) {
        const k = pairKey(sub, sIdx, h);
        const o = baseEdge.get(k);
        if (!o) continue;
        if (isUserCut(o)) { sub.setRole(h, EDGE_ROLE.CUT); continue; }
        if (o.keep) sub.setKeep(h, true);
        const a = sid(o.face), b = sid(o.twin.face);
        if ((a !== b && !open.has(pk(a, b))) || (fixed && fixed.has(k))) sub.setRole(h, EDGE_ROLE.CUT);
      }
      let side = null;
      if (sideA) { side = new Map(); sub.faces.forEach((f, i) => side.set(f.id, sideA.has(faces[i].id) ? 0 : 1)); }
      const r = unfoldMesh(sub, rule, { probe: { side } });
      return {
        n: r.stats.total,
        overlap: r.pieces.some(p => p.overlap),
        misfit: r.pieces.reduce((n, p) => n + (fits(p) ? 0 : p.qty), 0),
        auto: r.pieces.reduce((n, p) => n + ((p.autoCut && p.autoCut.lines) || 0), 0)
      };
    };

    const merge = function* (fixed = null) {
      const accepted = [];
      const start = evaluate(accepted, fixed);
      step('曲面切法：接塊', order.length * 2);
      // 一開始的組：每塊一組，不准切的先接起來
      const G = unionFind();
      for (const b of facesOfSid.keys()) G.find(b);
      for (const [a, b] of forced) G.union(a, b);
      const grp = new Map();
      for (const [b, fs] of facesOfSid) {
        const g = G.find(b);
        if (!grp.has(g)) grp.set(g, { faces: [], open: new Set() });
        grp.get(g).faces.push(...fs);
      }
      for (const [a, b] of forced) grp.get(G.find(a)).open.add(pk(a, b));
      let overlapping = 0;
      for (const g of grp.values()) { g.sc = local(g.faces, g.open, fixed, null); if (g.sc.overlap) overlapping++; }
      outer:
      for (let pass = 0; pass < 2; pass++) {
        let changed = false;
        for (const pr of order) {
          if (late()) break outer;
          prog.done++; yield prog;
          const ga = G.find(pr.a), gb = G.find(pr.b);
          if (ga === gb) continue;                                   // 已經同一片（再接會繞成一圈）
          const A = grp.get(ga), B = grp.get(gb);
          // 別的組有重疊 ⇒ 以前整個攤一定「有重疊」⇒ ⛔ 接（照舊）
          if (overlapping - (A.sc.overlap ? 1 : 0) - (B.sc.overlap ? 1 : 0) > 0) continue;
          const faces = A.faces.concat(B.faces);
          const open = new Set([...A.open, ...B.open, pk(pr.a, pr.b)]);
          const clean = !A.sc.overlap && !B.sc.overlap && !A.sc.auto && !B.sc.auto;
          const sc = local(faces, open, fixed, clean ? new Set(A.faces.map(f => f.id)) : null);
          if (sc.misfit <= A.sc.misfit + B.sc.misfit && !sc.overlap && sc.n < A.sc.n + B.sc.n) {
            accepted.push([pr.a, pr.b]);
            if (A.sc.overlap) overlapping--;
            if (B.sc.overlap) overlapping--;
            G.union(pr.a, pr.b);
            const g = G.find(pr.a);
            grp.delete(ga); grp.delete(gb);
            grp.set(g, { faces, open, sc });
            changed = true;
          }
        }
        if (!changed) break;
      }
      return { start, cur: evaluate(accepted, fixed) };
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

  /** 第四步的判準：放不進的少 → 沒重疊 →（不要細切口時）細切口少 → 片少 → 縫短 */
  const better4 = (x, y) =>
    x.misfit !== y.misfit ? x.misfit < y.misfit
      : x.overlap !== y.overlap ? !x.overlap
        : slits === 'none' && x.notch !== y.notch ? x.notch < y.notch
          : x.total !== y.total ? x.total < y.total
            : x.cutLen < y.cutLen - 1e-6;

  /**
   * ── 第四步：「只沿轉角」的新接法（見檔頭）── 回傳 `{start, cur}`，格式跟 `engine().merge()` 一樣。
   */
  const cornerPlan = function* () {
    // 1. 塊 ＝ 平面；碎面跟主人、不准切先接
    const R = regionInfo(base);
    const tiny = tinyRegions(R);
    const U = unionFind();
    for (const r of R.keys()) U.find(r);
    for (const t of tiny) { const h = hostOf(R, t, tiny); if (h != null) U.union(t, h); }
    for (const h of inner) if (h.keep && !isUserCut(h)) U.union(h.face.region, h.twin.face.region);
    const blk = f => U.find(f.region);

    // 2. 塊對：共用長度、平均轉角、凹或凸
    const pairs = new Map();
    for (const h of inner) {
      if (isUserCut(h)) continue;
      const a = blk(h.face), b = blk(h.twin.face);
      if (a === b) continue;
      const k = pk(a, b);
      if (!pairs.has(k)) pairs.set(k, { a, b, len: 0, ang: 0, cave: 0 });
      const pr = pairs.get(k);
      const L = h.v.p.distanceTo(h.to.p);
      pr.len += L;
      pr.ang += deg(h) * L;
      const tv = base.faceVerts(h.twin.face);
      const c2 = tv.reduce((acc, v) => acc.add(v.p), new THREE.Vector3()).divideScalar(tv.length);
      if (c2.sub(h.v.p).dot(h.face.normal) > 1e-6) pr.cave += L;       // 對面那個面的中心在這個面前面 ⇒ 凹
    }
    const list = [...pairs.values()];
    for (const pr of list) { pr.ang /= pr.len || 1; pr.concave = pr.cave > pr.len / 2 ? 1 : 0; }
    // ⚠ 轉角取到整數度再比：方塊每條邊都是 90°，算出來卻是 89.9999… 跟 90.0000… —— 不取整的話「長的先接」整個被打亂（150×60×50 方塊 2 片變 4 片）
    if (cutOrder === 'feature') list.sort((x, y) => (x.concave - y.concave) || (Math.round(x.ang) - Math.round(y.ang)) || (y.len - x.len));
    else list.sort((x, y) => y.len - x.len);

    // 3. 只攤一組（子網格）：組裡沒放開的塊界線照切
    const baseEdge = new Map(inner.map(h => [pairKey(base, vi, h), h]));
    /**
     * ⚠ 面要照 `base` 原本的順序：展開時一片怎麼擺（外框橫的直的）看那一片排第一個的面 ——
     * 順序不同 ⇒ 同一片擺的方向不同 ⇒ 放不放得進的判斷跟最後整個攤的對不上。【實證 2026-10-21】150×60×50 方塊 2 片變 4 片。
     */
    const order = new Map(base.faces.map((f, i) => [f.id, i]));
    /** `sideA` 有給 ⇒ 試算時重疊只查 A、B 兩邊之間（兩邊都沒有程式補剪的才給 —— 見 `tryJoin()`）*/
    const local = (faces0, open, sideA = null) => {
      const faces = [...faces0].sort((x, y) => order.get(x.id) - order.get(y.id));
      const used = new Map(), pts = [];
      const at = v => { if (!used.has(v.id)) { used.set(v.id, pts.length); pts.push(v.p.clone()); } return used.get(v.id); };
      const sub = Mesh.fromFaceList(pts, faces.map(f => base.faceVerts(f).map(at)));
      sub.computeNormals();
      const toBase = new Array(pts.length);
      for (const [id, i] of used) toBase[i] = vi.get(id);
      const sIdx = new Map(sub.verts.map((v, i) => [v.id, toBase[i]]));
      for (const h of innerEdges(sub)) {
        const o = baseEdge.get(pairKey(sub, sIdx, h));
        if (!o) continue;
        if (isUserCut(o)) { sub.setRole(h, EDGE_ROLE.CUT); continue; }
        if (o.keep) sub.setKeep(h, true);
        const a = blk(o.face), b = blk(o.twin.face);
        if (a !== b && !open.has(pk(a, b))) sub.setRole(h, EDGE_ROLE.CUT);
      }
      let side = null;
      if (sideA) { side = new Map(); sub.faces.forEach((f, i) => side.set(f.id, sideA.has(faces[i].id) ? 0 : 1)); }
      const r = unfoldMesh(sub, rule, { probe: { side } });
      const auto = new Set((r.autoEdges || []).map(h => Math.min(h.id, h.twin.id)));
      return {
        n: r.stats.total,
        overlap: r.pieces.some(p => p.overlap),
        misfit: r.pieces.reduce((n, p) => n + (fits(p) ? 0 : p.qty), 0),
        auto: r.pieces.reduce((n, p) => n + ((p.autoCut && p.autoCut.lines) || 0), 0),
        notch: notchOf(sub, v => sIdx.get(v.id), auto),
        size: r.pieces.reduce((m, p) => Math.max(m, p.width, p.height), 0)
      };
    };
    const facesOf = new Map();
    for (const f of base.faces) { const b = blk(f); if (!facesOf.has(b)) facesOf.set(b, []); facesOf.get(b).push(f); }
    const G = new Map();                           // 組 → { faces, open, sc }
    for (const [b, fs] of facesOf) G.set(b, { faces: fs, open: new Set(), sc: local(fs, new Set()) });
    const P = unionFind();
    /**
     * 先整塊接：轉折小於 30° 連起來的那一塊（曲面上的分格，齒輪的齒弧有幾十塊）整塊攤一次 ——
     * 一片、沒疊、放得進、沒有細切口、程式沒補剪 ⇒ 直接當一組（省掉一對一對試）；⛔ 的話照舊一塊一塊試。
     * ⚠ 跟「凹處、尖角先切」同一個方向（平的先接）；只是一次接完。【實證 2026-10-21】齒輪 2 秒算不完、交出 73 片。
     */
    {
      const S = unionFind();
      for (const pr of list) if (pr.ang < PREMERGE_DEG) S.union(pr.a, pr.b);
      const big = new Map();
      for (const b of G.keys()) { const r = S.find(b); if (!big.has(r)) big.set(r, []); big.get(r).push(b); }
      for (const bs of big.values()) {
        if (bs.length < 2 || late()) continue;
        yield prog;
        const faces = bs.flatMap(b => G.get(b).faces);
        const inside = new Set(bs);
        const open = new Set(list.filter(pr => inside.has(pr.a) && inside.has(pr.b) && pr.ang < PREMERGE_DEG).map(pr => pk(pr.a, pr.b)));
        const sc = local(faces, open);
        if (sc.n !== 1 || sc.overlap || sc.misfit || sc.auto || sc.notch) continue;
        for (const b of bs.slice(1)) P.union(bs[0], b);
        const g = P.find(bs[0]);
        for (const b of bs) G.delete(b);
        G.set(g, { faces, open, sc });
      }
    }
    /** `strict`：true ＝ 補剪、細切口都不准多；'notch' ＝ 只有細切口不准多（小片那一步、不要細切口時）；false ＝ 都放寬 */
    const tryJoin = (pr, strict) => {
      const ga = P.find(pr.a), gb = P.find(pr.b);
      if (ga === gb) return false;                 // 已經同一片（再接會繞成一圈）
      const A = G.get(ga), B = G.get(gb);
      const faces = A.faces.concat(B.faces);
      const open = new Set([...A.open, ...B.open, pk(pr.a, pr.b)]);
      const sc = local(faces, open, !A.sc.auto && !B.sc.auto ? new Set(A.faces.map(f => f.id)) : null);
      if (!(sc.n < A.sc.n + B.sc.n && !sc.overlap && sc.misfit <= A.sc.misfit + B.sc.misfit)) return false;
      if (strict === true && sc.auto > A.sc.auto + B.sc.auto) return false;
      if (strict && sc.notch > A.sc.notch + B.sc.notch) return false;
      P.union(ga, gb);
      const g = P.find(ga);
      G.delete(ga); G.delete(gb);
      G.set(g, { faces, open, sc });
      return true;
    };
    step('只沿轉角：接塊', list.length * 2 * (slits === 'none' ? 1 : 2));
    outer:
    for (const strict of slits === 'none' ? [true] : [true, false]) {
      for (let pass = 0; pass < 2; pass++) {
        let changed = false;
        for (const pr of list) {
          if (late()) break outer;
          prog.done++; yield prog;
          if (tryJoin(pr, strict)) changed = true;
        }
        if (!changed) break;
      }
    }
    // 4. 小片：放寬條件再試著併給旁邊（共用邊長的先試）
    if (minPiece > 0 && !late()) {
      const byLen = [...list].sort((x, y) => y.len - x.len);
      for (const pr of byLen) {
        if (late()) break;
        yield prog;
        const ga = P.find(pr.a), gb = P.find(pr.b);
        if (ga === gb) continue;
        if (Math.min(G.get(ga).sc.size, G.get(gb).sc.size) >= minPiece) continue;
        tryJoin(pr, slits === 'none' ? 'notch' : false);
      }
    }

    // 5. 整個攤一次（提案、面板、接受都用這份）
    const openAll = new Set([...G.values()].flatMap(g => [...g.open]));
    const keyBlk = new Map(base.faces.map(f => [fkey(base, vi, f), blk(f)]));
    const evalAll = all => {
      const work = base.clone();
      const wvi = new Map(work.verts.map((v, i) => [v.id, i]));
      const wb = new Map(work.faces.map(f => [f.id, keyBlk.get(fkey(work, wvi, f))]));
      for (const h of innerEdges(work)) {
        if (isUserCut(h)) continue;
        const a = wb.get(h.face.id), b = wb.get(h.twin.face.id);
        if (a !== b && (!all || !openAll.has(pk(a, b)))) work.setRole(h, EDGE_ROLE.CUT);
      }
      const r = unfoldMesh(work, rule);
      const auto = new Set((r.autoEdges || []).map(h => Math.min(h.id, h.twin.id)));
      const cuts = [];
      let cutLen = 0;
      for (const h of innerEdges(work)) {
        if (!(isUserCut(h) || auto.has(Math.min(h.id, h.twin.id)))) continue;
        const o = ownByPair.get(pairKey(work, wvi, h));
        if (!o || isSeam(o)) continue;
        cuts.push(o);
        cutLen += h.v.p.distanceTo(h.to.p);
      }
      return {
        r, cuts, cutLen,
        notch: notchOf(work, v => wvi.get(v.id), auto),
        misfit: r.pieces.reduce((n, p) => n + (fits(p) ? 0 : p.qty), 0),
        overlap: r.pieces.some(p => p.overlap),
        total: r.stats.total,
        jag: r.pieces.reduce((n, p) => n + Math.max(0, ((p.autoCut && p.autoCut.lines) || 0) - 1) * p.qty, 0)
      };
    };
    return { start: evalAll(false), cur: evalAll(true) };
  };

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
      notch: pick.notch || 0,
      /** 長邊小於 `minPiece` cm 的片幾片（面板講；「不要細切口」時小片併不掉就留著）*/
      small: pick.r.pieces.reduce((n, p) => n + (Math.max(p.width, p.height) < minPiece ? p.qty : 0), 0),
      minPiece,
      keepCut: pick.r.keepCut || 0,
      cutLen: pick.cutLen,
      usedBaseline,
      _score: pick
    };
  };

  // ── 只沿轉角：第四步的接法（2026-10-21；只有平面的物件就只有這一份）──
  const E0 = engine([]);
  const m0 = yield* cornerPlan();
  const baseline = E0.evaluate(null);
  const usedBaseline = better4(baseline, m0.cur) || (!better4(m0.cur, baseline) && baseline.misfit === 0 && !baseline.overlap
    && (slits === 'allow' || baseline.notch <= m0.cur.notch));
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
    prog.phase = '找曲面的格子'; yield prog;
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
        prog.phase = '曲面切法：試候選'; yield prog;
        const sc = E1.evaluate([], c.keys);
        if (!rg.score[c.kind] || better3(sc, rg.score[c.kind])) { rg.score[c.kind] = sc; rg.best[c.kind] = c.keys; }
      }
      rg.top = Object.keys(rg.score).reduce((a, k) => (better3(rg.score[k], rg.score[a]) ? k : a), 'corner');
    }
    const plan = function* (kind, label, pickOf) {
      const m = yield* E1.merge(union(regions.map(pickOf)));
      return finish(kind, label, m.start, m.cur, false);
    };
    // 每塊各挑最好的 ⇒ 提案；只有一塊（最常見）時就是那一種
    const tops = [...new Set(regions.map(r => r.top))];
    if (!(tops.length === 1 && tops[0] === 'corner')) {
      options.push(yield* plan(tops.length === 1 ? tops[0] : 'mix', tops.map(k => KIND_LABEL[k]).join('＋'), r => r.best[r.top]));
    }
    for (const k of ['petal', 'strip', 'band']) {
      if (tops.length === 1 && tops[0] === k) continue;            // 跟提案同一份
      if (!regions.some(r => r.best[k])) continue;
      if (late()) break;
      options.push(yield* plan(k, KIND_LABEL[k], r => r.best[k] || null));
    }
    // 第 0 份 ＝ 最好的（照第三步的判準）；其餘照好壞排
    /**
     * 「不要細切口」時，挑切法也比細切口（第四步，2026-10-21）：放不進的少 → 沒重疊 → 細切口少 → 照第三步。
     * ⚠ 花瓣的 V 形切口是設計（沿經線切到極點附近停）⇒ ⛔ 算；長條、環帶、只沿轉角照算
     * 【實證】小圓柱：長條 2 片但蓋子邊留 32 個細切口，以前會勝過只沿轉角 3 片。
     */
    const notchEff = o => (slits === 'none' && o.kind !== 'petal' ? o._score.notch || 0 : 0);
    const better5 = (x, y) => {
      if (x._score.misfit !== y._score.misfit || x._score.overlap !== y._score.overlap) return better3(x._score, y._score);
      if (notchEff(x) !== notchEff(y)) return notchEff(x) < notchEff(y);
      return better3(x._score, y._score);
    };
    options.sort((x, y) => (better5(x, y) ? -1 : better5(y, x) ? 1 : 0));
  }
  for (const o of options) delete o._score;

  return {
    ...options[0],
    options,
    nonGrid,
    timedOut,
    board,
    slits, notchDeg, cutOrder,
    sig: markSignature(own),
    mesh: own
  };
}
