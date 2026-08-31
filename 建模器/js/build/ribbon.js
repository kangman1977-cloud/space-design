/**
 * ribbon.js — 把一條**開放的線**掃成一片單層的帶
 *
 * 〔kang 2026-08-30 拍板的第 ③ 件：**甲 加厚成板 ／ 乙 立成牆**〕
 *
 * ── 🔴 為什麼甲乙是同一支，⛔ 不是兩套幾何 ──────────────
 * 兩件事看起來完全不同（一個躺著、一個站著），但拆開之後是**同一個動作**：
 *
 * > **沿著線，往某個方向掃出一片帶。**
 *
 * 差別只有「往哪個方向」與「掃多寬」：
 *   **乙 牆** ＝ 往 **+Y** 掃，距離就是**高度**（線在底下）
 *   **甲 板** ＝ 往**線的側向**掃，距離就是**寬度**（線在正中間，兩側各半）
 *
 * ⭐ 所以底下只有**一組四邊形**，兩條軌道（`A`／`B`）由誰產生換掉而已。
 * 〔kang 2026-08-25 批准的四動作框架：**新功能 ＝ 既有零件換個組合**〕
 *
 * ── 🔴 為什麼是「單層的面」，⛔ 不是實體 ────────────────
 * 甲乙做出來的是**板件（sheet）**，而這個專案的板件一律是
 * **開放的單層面，厚度由 `mesh.shell()` 在顯示與匯出時才加上去**
 * （`prim.js` 的 `plate()` 就是這樣，一路到 STL 都走同一支）。
 * ⛔ **這裡不可以自己把厚度做進網格** —— 那會變成兩份板厚各自為政。
 *
 * ── ⚠ 甲的轉角要 miter，⛔ 不可以每段各自偏移 ──────────
 * 每段各偏移各的，轉角處會**裂開一個缺口**（外側）或**互相穿過**（內側）。
 * 正解跟 `mesh.js` `shell()`、`edit.js` `insetFaces()` 完全一樣：
 * **沿角平分線推，而且要除以 cos（半夾角）**，否則轉角處會被削窄
 * —— 90 度轉角只剩 0.707 倍。
 *
 * ⭐ **而 miter 讓面積剛好守恆**：外側多出來的楔形與內側少掉的
 * 一模一樣（都是 `(w/2)² × tan(θ/2)`），所以
 *
 * > 🔴 **帶的面積 ＝ 折線長 × 那個數字** —— 甲乙**同一條斷言**。
 *
 * 那就是這支函式對得了答案的地方（鐵律三：讓兩個數字互相對得起來）。
 * ⚠ 夾角太尖時推距會爆掉，跟 `shell()` 一樣**設 5 倍上限** ——
 * 那種形狀實際上也做不出來，而超過上限之後面積就不再精確守恆。
 *
 * 單位 cm。不碰 DOM，Node 裡測得到。
 */

import * as THREE from 'three';
import { Mesh } from '../core/mesh.js';

/** 跟 `shell()` 同一個上限：夾角太尖時推距不讓它爆掉 */
const MITER_CAP = 5;

/**
 * 一疊開放的線 → 一片（或幾片）單層的帶，合成一個網格。
 *
 * ⚠ **分開的線直接放在同一個網格裡，⛔ 不做布林聯集** ——
 * 它們本來就不相連。跟 `extrudeMany()` 同一個判斷。
 *
 * @param {Array<Array<{x:number,y:number,corner?:boolean}>>} lines
 *        每條線是**拉直之後的點串**，`(x, y)` 對到世界的 `(X, Z)`
 * @param {{up?:boolean, size:number}} opt
 *        `up` ＝ 往上長（牆），`size` ＝ 牆高／板寬，cm
 * @returns {Mesh} **開放的單層面**（板件）
 */
export function ribbonFromPaths(lines, opt = {}) {
  const S = +opt.size;
  if (!(Math.abs(S) > 1e-9)) throw new Error('這個數字不能是 0');
  const up = !!opt.up;

  const points = [];
  const faces = [];
  const smoothPairs = [];     // 橫向邊裡「不是真轉角」的那些

  for (const raw of lines || []) {
    const pts = dedupe(raw);
    if (pts.length < 2) continue;

    const [railA, railB] = up ? railsUp(pts, S) : railsFlat(pts, S);

    const i0 = points.length;
    for (const p of railA) points.push(p);
    const i1 = points.length;
    for (const p of railB) points.push(p);

    const L = pts.length;
    for (let i = 0; i + 1 < L; i++) {
      faces.push([i0 + i, i0 + i + 1, i1 + i + 1, i1 + i]);
    }
    /**
     * 🔴 **橫向邊：原本的點不是真轉角，這條邊就⛔ 不是造型上的折。**
     * ⚠ 少了這一步，一段曲線牆展開時會變成一百多道折彎 ——
     * 跟 `extrudeMany()` 側牆那一則是同一件事，⛔ 不是另一個規則。
     * ⭐ 兩端那兩條是邊界邊，⛔ 不標（標了也沒有意義）。
     */
    for (let i = 1; i + 1 < L; i++) {
      if (!pts[i].corner) smoothPairs.push([i0 + i, i1 + i]);
    }
  }

  if (!faces.length) throw new Error('這條線上找不到兩個以上的點，掃不出東西');
  const mesh = Mesh.fromFaceList(points, faces);

  // 建好之後才標得到邊 —— 用「頂點索引配對」找，跟 `extrudeMany()` 同一套
  if (smoothPairs.length) {
    const idx = new Map(mesh.verts.map((v, i) => [v.id, i]));
    const byPair = new Map();
    for (const he of mesh.edges()) {
      const a = idx.get(he.v.id), b = idx.get(he.to.id);
      byPair.set(`${Math.min(a, b)}-${Math.max(a, b)}`, he);
    }
    for (const [a, b] of smoothPairs) {
      const he = byPair.get(`${Math.min(a, b)}-${Math.max(a, b)}`);
      if (he) mesh.setSmooth(he, true);
    }
  }
  return mesh;
}

/**
 * **乙 立成牆**：線留在地上，另一條軌道就是同一串點往上 `h`。
 * ⭐ 這一半沒有任何幾何問題 —— 轉角處兩片牆本來就共用那條垂直邊。
 */
function railsUp(pts, h) {
  const a = pts.map(p => new THREE.Vector3(p.x, 0, p.y));
  const b = pts.map(p => new THREE.Vector3(p.x, h, p.y));
  return [a, b];
}

/**
 * **甲 加厚成板**：線是**中心線**，往兩側各推 `w/2`（miter 修正過）。
 *
 * ── 🔴 繞向（⛔ 這裡錯了看不出來）────────────────────────
 * 側向取 `n ＝ (dz, 0, −dx)`、`A ＝ p − n·w/2`、`B ＝ p + n·w/2`，
 * 四邊形照 `[A_i, A_{i+1}, B_{i+1}, B_i}]` 繞 → **法向朝 +Y**。
 * ⚠ 反過來的話板子的正面朝下，**畫面上看起來完全正常**，
 * 只有匯出 STL 的列印前檢查才抓得到（跟 `extrudeMany()` 踩過的同一個坑）。
 * ⭐ 線反過來畫也一樣朝上：`d` 反向 → `n` 跟著反 → 兩件事同時翻，抵消。
 */
function railsFlat(pts, w) {
  const half = w / 2;
  const n = segNormals(pts);
  const a = [], b = [];
  for (let i = 0; i < pts.length; i++) {
    const m = miterAt(n, i);
    a.push(new THREE.Vector3(pts[i].x - m.x * half, 0, pts[i].y - m.y * half));
    b.push(new THREE.Vector3(pts[i].x + m.x * half, 0, pts[i].y + m.y * half));
  }
  return [a, b];
}

/** 每一段的單位側向。第 `i` 個是「點 i → 點 i+1」那一段的 */
function segNormals(pts) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
    const L = Math.hypot(dx, dy) || 1;
    out.push({ x: dy / L, y: -dx / L });
  }
  return out;
}

/**
 * 第 `i` 個點要往哪個方向推、推多長（單位向量 × 倍率）。
 * 兩端只有一段可依靠；中間走角平分線 ÷ cos（半夾角）。
 */
function miterAt(n, i) {
  const prev = n[i - 1], cur = n[i];
  if (!prev) return { x: cur.x, y: cur.y };
  if (!cur) return { x: prev.x, y: prev.y };
  let mx = prev.x + cur.x, my = prev.y + cur.y;
  const L = Math.hypot(mx, my);
  /** 折回去 180 度（尖刺）：角平分線長度是 0，方向不唯一 → 照前一段走 */
  if (L < 1e-9) return { x: prev.x, y: prev.y };
  mx /= L; my /= L;
  const cos = mx * cur.x + my * cur.y;
  const k = Math.min(MITER_CAP, 1 / Math.max(cos, 1e-6));
  return { x: mx * k, y: my * k };
}

/**
 * 相鄰的重複點會讓方向算不出來（除以 0）。
 * ⚠ **`corner` 旗標一定要跟著複製** —— 掉了的話展開圖會多出一堆折彎。
 */
function dedupe(pts) {
  const out = [];
  for (const p of pts || []) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > 1e-12 || Math.abs(last.y - p.y) > 1e-12) {
      out.push({ x: +p.x, y: +p.y, corner: !!p.corner });
    }
  }
  return out;
}

/**
 * 折線總長（⛔ 不繞回起點）。
 * ⭐ 對外開這一支，是因為**提示訊息與測試都要拿它跟面積對答案**：
 * **面積 ＝ 這個長度 × 那個數字**。
 */
export function polylineLength(pts) {
  let s = 0;
  for (let i = 0; i + 1 < (pts || []).length; i++) {
    s += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  }
  return s;
}
