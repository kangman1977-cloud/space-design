/**
 * stroke.js — 一筆畫：把「手指／筆在表面上劃過的一串位置」變成一串切點
 *
 * ── 這支檔案為什麼存在 ────────────────────────────────
 * 刀具本來只吃「輕點」：點一下 → 吸到最近的邊 → 一個切點。
 * kang 2026-08-26 批准的三項輔助裡，第一項是**一筆畫**：
 *
 *   > 按住拖一條線過表面 → 放開，**交點自動變成切點**。
 *
 * ⭐ **兩種輸入並存，不是模式切換**（kang 拍板）：同一次切線裡
 * 可以先拖一段、再輕點微調。所以這支只負責「拖曳那一半」，
 * 產出的東西跟輕點**完全同型**（`{a, b, p}`），
 * 交給已經寫好、測過的 `knifePath()` 去切。
 *
 * ── 🔴 為什麼切點只能落在「線穿過邊」的地方 ─────────────
 * `knifePath()` 要求**每一個切點都在某條邊上**，理由在它的檔頭：
 * 一條線要把面切開，它的兩端一定得落在那個面的邊上，
 * 端點停在面中間會懸空，網格拓撲不允許。
 *
 * → 所以一筆畫的切點就是**你的線跟邊的交點**。
 * ⚠ **代價要講給使用者聽**：沒辦法指定它在邊上的哪一點；要精準就輕點。
 *
 * ── 🔴 起點與終點：吸到「所在那個面」的最近一條邊 ────────
 * 〔kang 2026-08-26 拍板：自動吸到最近的邊〕
 *
 * ⚠ **關鍵是「所在那個面」，不是全網格最近的邊。** 全網格最近的邊
 * 可能在隔壁面上，那樣第一段的兩個端點就不同屬一個面 ——
 * `connectVertsPath()` 會擋下來，而使用者只會看到「切不下去」。
 *
 * ── ⭐ 由此掉出一個可以斷言的性質 ─────────────────────
 * 這支產出的切點串，**每相鄰兩點必定同屬一個面**：
 *
 *   | 這一對 | 為什麼同面 |
 *   |---|---|
 *   | 起點 → 第 1 個交點 | 兩條邊都是 `f0` 的邊 |
 *   | 第 i 個 → 第 i+1 個 | 兩條邊都是 `f_i` 的邊 |
 *   | 最後一個交點 → 終點 | 兩條邊都是 `f_n` 的邊 |
 *
 * 那正是 `connectVertsPath()` 的規則，**所以是結構保證，不是碰運氣**
 * （坑第 31 條：與其讓兩條路對齊，不如換一個只有一條路的定義）。
 * 測試直接驗這條。
 *
 * ── ⚠ 取樣跳太遠怎麼辦 ────────────────────────────────
 * 手劃得快的時候，兩個取樣點之間可能**跨過整個面**（f_i 與 f_j 不相鄰）。
 * 那時候就把這一段**對半切**，取中點重新問它在哪個面，遞迴下去。
 * ⛔ 不是「找不到就放棄」，也 ⛔ 不是「猜一條邊」（坑第 24 條）。
 *
 * ── 效能 ──────────────────────────────────────────────
 * `nearestFace()` 是 O(面數)，這裡每個取樣點問一次。
 * 🔴 **所以這支只在放開手的那一刻跑一次，⛔ 絕對不可以放進
 * `pointermove` 或每幀迴圈**（坑第 22 條）。呼叫端要守住這條。
 *
 * 單位一律 cm，座標一律是**物件本地座標**（跟 `knifePath()` 一致）。
 * **這個檔案不碰 DOM，所以測得到。**
 */

import * as THREE from 'three';
import { nearestFace, distPointSeg } from '../unfold/seam.js';
import { PLANAR_TOL_CM } from './edit.js';

/** 遞迴細分的上限：2^7 ＝ 一段最多補到 128 份 */
const MAX_SPLIT_DEPTH = 7;

/**
 * 兩個面共用的那條邊。
 *
 * @returns {HalfEdge|null} `f1` 上的那條半邊（它的 `twin.face` 就是 `f2`）
 */
export function sharedEdge(mesh, f1, f2) {
  if (!f1 || !f2 || f1 === f2) return null;
  for (const he of mesh.faceLoop(f1)) {
    if (he.twin && he.twin.face === f2) return he;
  }
  return null;
}

/**
 * 線段 `p→q` 跟線段 `a→b` 最接近的地方，回傳**在 `a→b` 上**的參數 t（夾在 0～1）。
 *
 * ⚠ 為什麼不直接算「交點」：兩條線段在 3D 裡幾乎不會真的相交 ——
 * 取樣點只是**靠近**表面，不是精確在面上。求最近點是唯一穩的做法。
 * （同一招 `pickEdgePoint()` 已經在用：使用者點的位置也只是「靠近」。）
 */
export function closestParamOnEdge(p, q, a, b) {
  const d1 = q.clone().sub(p);
  const d2 = b.clone().sub(a);
  const r = p.clone().sub(a);
  const A = d1.dot(d1), B = d1.dot(d2), C = d2.dot(d2);
  const D = d1.dot(r), E = d2.dot(r);
  const den = A * C - B * B;
  let t;
  if (Math.abs(den) < 1e-12) {
    /** 兩段平行 —— 退回「把 p 投影到 a→b 上」，那是這種情況下唯一講得通的答案 */
    t = C > 0 ? -E / C : 0;
  } else {
    t = (A * E - B * D) / den;
  }
  return Math.max(0, Math.min(1, t));
}

/** 一個面上離 `p` 最近的那條邊，以及邊上的落點參數 */
function nearestEdgeOfFace(mesh, face, p) {
  let best = null;
  for (const he of mesh.faceLoop(face)) {
    const a = he.v.p, b = he.to.p;
    const d = distPointSeg(p, a, b);
    if (!best || d < best.dist) {
      const ab = b.clone().sub(a);
      const L2 = ab.lengthSq();
      let t = L2 > 0 ? p.clone().sub(a).dot(ab) / L2 : 0;
      t = Math.max(0, Math.min(1, t));
      best = { he, t, dist: d };
    }
  }
  return best;
}

/**
 * 把邊上的參數 t 變成一個切點。
 *
 * 🔴 **順手擋掉「太靠近端點」** —— `knifePath()` 會因為那個整筆退回
 * （「那裡會長出長度 0 的線」）。一筆畫的交點是算出來的、不是使用者指定的，
 * 為了一個不巧的位置把整筆丟掉不划算。
 *
 * ⚠ **但推開這件事不可以安靜地做**（坑第 11 條）——
 * 推了幾點會回報出去，由呼叫端講給使用者聽。
 * 推的幅度上限是 `PLANAR_TOL_CM`（0.1mm），**低於這個專案切得出來的尺度**
 * （珍珠板與壓克力，坑 25／26），所以不會改變做出來的東西。
 */
function pickOnEdge(mesh, vi, he, t, snapMid) {
  const a = he.v.p, b = he.to.p;
  const len = a.distanceTo(b);
  let s = snapMid ? 0.5 : t;
  let nudged = false;
  if (len > 2 * PLANAR_TOL_CM) {
    const lo = (PLANAR_TOL_CM * 1.5) / len;
    const hi = 1 - lo;
    if (s < lo) { s = lo; nudged = true; }
    else if (s > hi) { s = hi; nudged = true; }
  }
  return {
    pick: {
      a: vi.get(he.v.id),
      b: vi.get(he.to.id),
      p: a.clone().lerp(b, s)
    },
    he,
    nudged
  };
}

/** 這一串點各自落在哪個面（`nearestFace` 一次，之後都用快取） */
function faceAt(mesh, p, cache) {
  const k = `${p.x.toFixed(4)},${p.y.toFixed(4)},${p.z.toFixed(4)}`;
  if (cache.has(k)) return cache.get(k);
  const r = nearestFace(mesh, p);
  const f = r ? r.face : null;
  cache.set(k, f);
  return f;
}

/**
 * 一段（`p` 在 `fp`、`q` 在 `fq`，兩個面不同）之間的所有換面事件。
 *
 * 相鄰 → 直接收下共用邊上的交點；不相鄰 → 對半切再問一次。
 * 切到上限還是接不起來，就回 `null` 讓外層明講（⛔ 不猜）。
 */
function crossingsBetween(mesh, p, fp, q, fq, cache, depth) {
  if (fp === fq) return [];
  const he = sharedEdge(mesh, fp, fq);
  if (he) {
    return [{ he, t: closestParamOnEdge(p, q, he.v.p, he.to.p) }];
  }
  if (depth >= MAX_SPLIT_DEPTH) return null;

  const mid = p.clone().lerp(q, 0.5);
  const fm = faceAt(mesh, mid, cache);
  if (!fm) return null;

  const left = crossingsBetween(mesh, p, fp, mid, fm, cache, depth + 1);
  if (!left) return null;
  const right = crossingsBetween(mesh, mid, fm, q, fq, cache, depth + 1);
  if (!right) return null;
  return left.concat(right);
}

/**
 * 🔴 **一串表面上的位置 → 一串切點。**
 *
 * @param {Mesh} mesh
 * @param {Array<THREE.Vector3>} points 依序的位置，**物件本地座標**，
 *        每一點都應該落在（或非常靠近）模型表面
 * @param {{snapMid?:boolean}} [opts] `snapMid` ＝ 每個切點都吸到邊的正中間
 * @returns {{ok:boolean, reason?:string,
 *            picks?:Array<{a:number,b:number,p:THREE.Vector3}>,
 *            crossings?:number, nudged?:number}}
 *          `crossings` ＝ 中間有幾個是「線穿過邊」算出來的
 *          （起終點那兩個不算，它們是吸過去的）
 */
export function strokeToPicks(mesh, points, opts = {}) {
  if (!mesh || !mesh.faces.length) return { ok: false, reason: '沒有網格' };
  if (!Array.isArray(points) || points.length < 2) {
    return { ok: false, reason: '這一筆太短了 —— 拖長一點，或改用點的' };
  }
  const snapMid = !!opts.snapMid;

  mesh.computeNormals();
  const vi = mesh._vertIndex();
  const cache = new Map();

  /** 先把重複／幾乎重複的取樣點壓掉，不然中間會冒出一堆長度 0 的段 */
  const pts = [points[0].clone()];
  for (let i = 1; i < points.length; i++) {
    if (points[i].distanceTo(pts[pts.length - 1]) > PLANAR_TOL_CM) {
      pts.push(points[i].clone());
    }
  }
  if (pts.length < 2) {
    return { ok: false, reason: '這一筆太短了 —— 拖長一點，或改用點的' };
  }

  const f0 = faceAt(mesh, pts[0], cache);
  if (!f0) return { ok: false, reason: '起點不在模型上' };

  /** ── 中間：逐段找換面事件 ────────────────────────── */
  const events = [];
  let prevFace = f0;
  for (let i = 1; i < pts.length; i++) {
    const f = faceAt(mesh, pts[i], cache);
    if (!f) return { ok: false, reason: '這一筆有一段離開了模型' };
    if (f !== prevFace) {
      const got = crossingsBetween(mesh, pts[i - 1], prevFace, pts[i], f, cache, 0);
      if (!got) {
        return {
          ok: false,
          reason: '這一筆劃太快，中間跳過去的地方接不起來 —— 慢一點再劃一次，'
                + '或改用點的'
        };
      }
      events.push(...got);
      prevFace = f;
    }
  }
  const fLast = prevFace;

  /** ── 兩端：吸到「所在那個面」的最近一條邊 ─────────── */
  const startNear = nearestEdgeOfFace(mesh, f0, pts[0]);
  const endNear = nearestEdgeOfFace(mesh, fLast, pts[pts.length - 1]);
  if (!startNear || !endNear) {
    return { ok: false, reason: '這一筆的兩端找不到可以落腳的邊' };
  }

  /** 邊的身分用「兩個頂點索引」認，⛔ 不比 half-edge 物件（twin 是兩個物件） */
  const idOf = he => {
    const a = vi.get(he.v.id), b = vi.get(he.to.id);
    return a < b ? `${a}-${b}` : `${b}-${a}`;
  };

  const seq = [];
  seq.push({ he: startNear.he, t: startNear.t });
  seq.push(...events);
  seq.push({ he: endNear.he, t: endNear.t });

  /**
   * ⚠ **連續兩個落在同一條邊上就丟掉後面那個** ——
   * 那一段長度是 0（或近乎 0），切下去只會長出一條沒有意義的線。
   * 最常見的成因：起點剛好就吸到了「第一個要穿過的那條邊」。
   */
  const picks = [];
  const hes = [];
  let nudged = 0;
  let lastId = null;
  for (const e of seq) {
    const id = idOf(e.he);
    if (id === lastId) continue;
    const r = pickOnEdge(mesh, vi, e.he, e.t, snapMid);
    if (r.nudged) nudged++;
    picks.push(r.pick);
    hes.push(e.he);
    lastId = id;
  }

  if (picks.length < 2) {
    return {
      ok: false,
      reason: '這一筆沒有穿過任何一條邊 —— 從一條邊劃到另一條邊，或改用點的'
    };
  }

  return {
    ok: true,
    picks,
    crossings: events.length,
    nudged
  };
}
