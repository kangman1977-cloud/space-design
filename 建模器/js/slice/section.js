/**
 * section.js — 剖面分切的幾何核心
 *
 * 用一組平行平面去切一個立體，每一刀得到一個或多個封閉輪廓。
 * 每個輪廓轉成 DXF 拿去 CNC 裁切，切出一疊板，照順序疊起來黏合，
 * 就長回原來的立體形狀。**片厚 ＝ 板材厚度。**
 *
 * ── 為什麼這條路值得做 ──────────────────────────────
 * 高斯絕妙定理說球面、環面、自由曲面**數學上不可能無失真展開**。
 * 展開那條路碰到它們只能近似。
 * 剖面分切完全繞過這個問題 —— 它不需要曲面可展，任何形狀都切得開，
 * 而且是精確的。
 *
 * ── 這個檔案完全不知道材料是什麼，也不碰 DOM ────────────
 * 跟 unfold/flatten.js 同一條原則。切片是純幾何，
 * 所以整個檔案在 Node 裡用數學對得了答案（片面積、片數、累計高度）。
 *
 * 單位一律 cm。
 */

import * as THREE from 'three';
import { csgReady, slabShadow, mergeLoops, rowsToLoops } from '../build/bool.js';

/**
 * 三個切片軸。
 *
 * ── u、v 的順序不是隨便排的，排錯會出鏡射的圖 ────────────
 * 每個軸配一組 (u, v) 當作 2D 圖的橫軸與縱軸，而且必須滿足
 * **u × v ＝ 切片軸**（右手系）。滿足了，從 +軸 方向看下去
 * 逆時針就是正面積，切出來的片才是「正的」。
 *
 * 若把 u、v 對調，每一片都會左右翻過來 —— 圖看起來完全正常，
 * 面積、片數、孔位全部算得對，但**做出來的東西是鏡像的，疊不回原形**。
 * 而且要等切完料疊起來才會發現。所以這裡寫死並在測試裡盯住手性。
 *
 * ── 🔴 u、v 還要跟「對應的視圖」同方向（2026-10-19 改，實驗 T6）──────
 * ⚠ 舊版 Y 軸是 (u, v) ＝ (z, x)：手性對（⛔ 鏡像），但**整片轉了 90°** ——
 * 300 × 160 的招牌切出來每片 160 × 300，圓孔從左邊跑到下面，跟 Illustrator 原稿對不上。
 * kang 2026-10-19：「三條都照你的建議做」（建議：改成跟畫面同方向、只轉不鏡像）。
 * ⭐ 現在每個軸的 u、v 就是**那個視圖的螢幕右、螢幕上**（`view/scene.js` `setView()`，相機 up ＝ +Y）：
 *
 * | 切片軸 | 對應視圖 | u（片的右）| v（片的上）| u × v |
 * |---|---|---|---|---|
 * | Y 水平切 | 上 | +X | −Z | +Y ✓ |
 * | Z 從正面切 | 前 | +X | +Y | +Z ✓ |
 * | X 從右邊切 | 側（從 +X 看）| −Z | +Y | +X ✓ |
 *
 * ⇒ 帶正負號，所以存成**向量** `uv: [u, v]`，⛔ 是座標字母。
 * 〔守門的測試：`tests/run.mjs`「剖面片跟視圖同方向」—— 三個軸各驗「右／上」與手性〕
 */
export const AXES = {
  x: { key: 'x', label: 'X（從右邊切）', uv: [[0, 0, -1], [0, 1, 0]], dir: [1, 0, 0] },
  y: { key: 'y', label: 'Y（水平切，最常用）', uv: [[1, 0, 0], [0, 0, -1]], dir: [0, 1, 0] },
  z: { key: 'z', label: 'Z（從正面切）', uv: [[1, 0, 0], [0, 1, 0]], dir: [0, 0, 1] }
};

/** 一個 3D 點（或向量）在 (u, v) 上的座標 */
const along = (p, w) => p.x * w[0] + p.y * w[1] + p.z * w[2];

export const AXIS_KEYS = ['y', 'x', 'z'];
export const DEFAULT_AXIS = 'y';

/** 頂點落在平面上時往正側推的量。見下方 sectionAt() 的說明。 */
const ON_PLANE = 1e-9;

/**
 * 「湊得剛剛好」的容許值，單位 cm。
 *
 * ── 為什麼不是 1e-6 ──────────────────────────────────
 * 第一版用 1e-6 當判準，實測（2026-08-22）在布林聯集出來的物件上
 * 跳出「**還差 0 cm 沒疊到**」——自相矛盾的一句話。
 * 成因是 Manifold 的輸出座標帶著 1e-4 等級的精度殘留，
 * 所以模型高度不是剛好 60 而是 60.0001。
 *
 * 1e-6 cm ＝ 十奈米。**那是浮點數的尺度，不是板材的尺度。**
 * 這個專案切的是珍珠板與壓克力，0.1mm 已經遠低於任何切得出來的東西。
 * 判準要挑一個**有物理意義的量**去比（坑第 25 條講過同一件事，
 * 那次是拿四元數分量比，這次是拿浮點誤差當公差）。
 *
 * 兩個地方都要用它：
 *   一、「剩下的填滿」算片數時 —— 差一點點不該少算一整片
 *   二、面板顯示差額警告時 —— 差一點點不該跳警告
 * 只改一邊的話，會變成「不跳警告，但少一片」，更難查。
 */
export const FIT_TOL = 0.01;

/**
 * 一次最多切幾片。2 公尺高、0.1cm 的紙一片一片疊也才 2000 片，
 * 超過這個數幾乎一定是單位打錯（把 mm 當 cm），⛔ 不是真的要切那麼多。
 */
export const MAX_SLABS = 2000;

/** 串接輪廓時判斷「同一個點」的量化格線 */
const SNAP = 1e6;
/** 斷線補線：每一列多高（cm）＝ 精度 0.1 mm；拉直的容許值（cm）*/
export const SCAN_H = 0.01, SCAN_EPS = 0.005;
/** 斷線接頭尾：每條尾巴找最近的幾個頭來比 */
const BRIDGE_K = 8;

/**
 * 🔴 **每片自動合併：面積差多少才算「真的有疊到」**（cm²；2026-10-22，第二輪第一批（二）甲）。
 * 合併前後的面積一樣 ⇒ **原樣留著原本的輪廓**（乾淨的模型一個點都不動）；差超過這個量才換成合併後的。
 * 0.0001 cm² ＝ 0.01 mm²，遠小於任何切得出來的東西；⛔ 用 1e-9 那種浮點的尺度（`FIT_TOL` 那一段講的同一件事）。
 * 加上面積的百萬分之一：大的片（幾千 cm²）合併時的浮點殘留跟著大。
 */
const MERGE_TOL = 1e-4;
const MERGE_REL = 1e-6;

// ═══════════════════════════════════════════════════════
//  一、分段：一段一段疊上去
// ═══════════════════════════════════════════════════════

/**
 * 把「板厚 × 片數」的分段表換算成一疊實際的位置。
 *
 * ── 為什麼是「疊上去」而不是「先分 N 片再改厚度」──────────
 * 模型的總高是固定的。若先說「分 20 片」再把中間幾片改成 2cm，
 * 總高就跟著變了 —— 那已經不是同一個模型。
 * 所以正確的順序是反過來：**你設每段的板厚與片數，
 * 程式算出疊到多高、離模型頂端還差多少。**
 *
 * 差額一律如實回報，**不四捨五入湊滿**。
 * 偷偷湊滿的後果是圖看起來剛剛好、東西做出來矮一截，
 * 而且要疊完才發現（跟坑第 5、25 條同一種傷害：讓人不敢相信數字）。
 *
 * @param {number} height 模型沿切片軸的總高（cm）
 * @param {Array} bands   [{ t:1.0, n:5 }, { t:2.0, n:7 }, { t:1.0, n:'rest' }]
 *                        n 給 'rest'（或 null）＝ 用剩下的高度能塞幾片就幾片
 * @returns {{slabs:Array, used:number, height:number, diff:number, bands:Array}}
 */
export function planSlabs(height, bands) {
  const list = (bands && bands.length) ? bands : [{ t: 1.0, n: 'rest' }];
  const slabs = [];
  const info = [];
  let used = 0;

  for (let bi = 0; bi < list.length; bi++) {
    const t = +list[bi].t;
    if (!(t > 0)) { info.push({ t, n: 0, from: 0, to: 0, bad: '板厚要大於 0' }); continue; }

    let n = list[bi].n;
    if (n === 'rest' || n === null || n === undefined || n === '') {
      // 剩下的填滿：能塞幾片就幾片，塞不滿的零頭留著（下面會顯示差額）。
      // 容許值加在分子上，這樣「差 0.0001 就滿一片」不會被無條件捨去掉一整片。
      n = Math.max(0, Math.floor((height - used + FIT_TOL) / t));
    }
    n = Math.max(0, Math.floor(+n) || 0);
    /**
     * 🔴 **片數要有上限**（2026-10-08 查 bug 找到的）。
     * 板厚打成 0.001（把 mm 當 cm 打）＝ 要切兩萬多片，每一片都要切一刀 ⇒ 視窗卡死。
     * ⚠ 而介面在計算**之前**就把設定存起來了，所以⛔ 擋在介面不夠 ——
     * 下次打開又會用同一個壞值再卡一次。擋在這裡，兩條路都過不去。
     */
    if (slabs.length + n > MAX_SLABS) {
      info.push({ t, n: 0, from: 0, to: 0,
        bad: `會切出 ${slabs.length + n} 片，超過上限 ${MAX_SLABS} 片 —— 板厚的單位是 cm，是不是打成 mm 了？` });
      continue;
    }

    const from = slabs.length + 1;
    for (let i = 0; i < n; i++) {
      const z0 = used, z1 = used + t;
      slabs.push({
        index: slabs.length + 1,   // 片號從 1 開始，跟現場講「第幾片」一致
        band: bi,
        t, z0, z1,
        /**
         * 取這一片**正中央**的截面，不是底面。
         * 一塊 1cm 厚的板要代表 z0~z1 這一段立體，取中央的誤差是對稱的
         * （上半多切掉、下半多留下，互相抵銷）；取底面則整疊都往同一邊偏。
         * 順帶避開一件事：取底面時第一刀剛好落在模型最底端那個面上，
         * 那是最容易出退化輪廓的地方。
         */
        mid: (z0 + z1) / 2
      });
      used += t;
    }
    info.push({ t, n, from, to: slabs.length });
  }

  return {
    slabs,
    used,
    height,
    diff: height - used,      // 正 ＝ 還差這麼多沒疊到；負 ＝ 疊過頭了
    bands: info
  };
}

// ═══════════════════════════════════════════════════════
//  二、一刀：平面切網格 → 封閉輪廓
// ═══════════════════════════════════════════════════════

/**
 * 切一刀。
 *
 * @param {Mesh} mesh  半邊網格（**要先轉成世界座標**）
 * @param {string} axisKey 'x' | 'y' | 'z'
 * @param {number} coord 平面位置
 * @returns {{loops:Array, area:number, open:number}}
 *   loops 每個是 { pts:[{x,y}], area, isHole }
 *   area  這一刀的實心面積（外輪廓減掉內孔）
 *   open  沒接成封閉迴圈的線串數量；> 0 表示網格不封閉
 */
export function sectionAt(mesh, axisKey, coord) {
  const A = AXES[axisKey] || AXES[DEFAULT_AXIS];
  const K = A.key, [U, V] = A.uv;
  const kv = new THREE.Vector3(...A.dir);

  const segs = [];

  for (const f of mesh.faces) {
    const vs = mesh.faceVerts(f);
    const n = vs.length;
    if (n < 3) continue;

    /**
     * ── 頂點剛好落在平面上怎麼辦 ──────────────────────
     * 距離是 0 的頂點會讓「有沒有跨過去」變成三態，
     * 每一種組合都要另外處理，而漏掉任何一種就會少一段線，
     * 輪廓接不起來 —— 而且只在某些高度發作，最難查。
     *
     * 標準解法：把 0 一律推到正側。這樣每條邊只有「跨」與「不跨」兩種，
     * 而且推的量遠小於任何有意義的尺寸，對結果沒有影響。
     * 整片貼在平面上的面會變成全正，自然不產生線段 —— 那正是我們要的。
     */
    const d = new Array(n);
    for (let i = 0; i < n; i++) {
      let x = vs[i].p[K] - coord;
      if (Math.abs(x) < ON_PLANE) x = ON_PLANE;
      d[i] = x;
    }

    // 沿著這個面的邊走一圈，記下所有穿過平面的點（順序就是繞行順序）
    const hits = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if ((d[i] < 0) === (d[j] < 0)) continue;
      const s = d[i] / (d[i] - d[j]);
      const a = vs[i].p, b = vs[j].p;
      const au = along(a, U), av = along(a, V);
      hits.push({
        x: au + (along(b, U) - au) * s,
        y: av + (along(b, V) - av) * s
      });
    }
    if (hits.length < 2) continue;

    /**
     * 平面多邊形跟平面相交，穿越點一定是「進、出、進、出……」交替，
     * 所以照繞行順序兩兩配對就是正確的線段。
     * 三角形永遠只有 2 個點；四邊形凹進去時可能有 4 個，配對照樣成立。
     */
    const nn = f.normal;
    // 線段方向 ＝ 切片軸 × 面法向。
    // 這樣走出來的迴圈從 +軸 看下去是逆時針，實心在左手邊，
    // 內孔自然變成順時針 —— 外輪廓與內孔不必另外判斷包含關係。
    const t = new THREE.Vector3().crossVectors(kv, nn);
    const tu = along(t, U), tv = along(t, V);

    for (let i = 0; i + 1 < hits.length; i += 2) {
      let p = hits[i], q = hits[i + 1];
      if ((q.x - p.x) * tu + (q.y - p.y) * tv < 0) { const s = p; p = q; q = s; }
      if (Math.abs(q.x - p.x) < 1e-12 && Math.abs(q.y - p.y) < 1e-12) continue;
      segs.push({ a: p, b: q });
    }
  }

  return { ...chain(segs), segs };     // segs：斷線的時候掃描線補要用（網格核心第五批 b ⑥）
}

/**
 * 🔴 **斷線那一片用掃描線補**（網格核心第五批 b ⑥，2026-10-24 → `匯入整理-研究.md` 第 9 節 ⑥；
 * kang 2026-10-22「先依照你的判斷建議處理」⇒ 斷線的片自動改用掃描線補、並講出「第幾片有斷線、已經補了」）。
 * 外來的破模型（汽車 41 片有 36 片）切到斷線，那一片照舊「沒有板」或少一塊 —— ⛔ 有人要那個結果。
 * 做法（10-22 原型 `slice_proto5.mjs`）：線段一列一列掃（每列 `SCAN_H` ＝ 0.01 cm），照線段的方向數進出，
 * **被任何一圈包住就算料**（非零規則）⇒ 每一列實心的那一段變成細長方塊 ⇒ 合成輪廓、把階梯拉直（`SCAN_EPS`）。
 * ⚠ 呼叫前先把斷線的頭尾接起來（`bridgeEnds()`）—— 只靠「收在最後一條線」的話，一列裡只剩一條線的地方
 * （開口朝某一邊、牆上有缺口）整列補不起來：開口的方塊開口朝 x 時 10 片全空、收納盒有把手洞的片被切成兩塊。
 * 乾淨的片⛔ 走這裡（照舊精確的輪廓）。
 * @param {{a:{x,y}, b:{x,y}}[]} segs 這一刀所有物件的有向線段（含接頭尾補的線）
 * @returns {{pts, area, isHole}[]}
 */
export function scanFill(segs) {
  let y0 = Infinity, y1 = -Infinity;
  for (const { a, b } of segs) { y0 = Math.min(y0, a.y, b.y); y1 = Math.max(y1, a.y, b.y); }
  if (!(y1 > y0)) return [];
  const rows = Math.ceil((y1 - y0) / SCAN_H), by = Array.from({ length: rows }, () => []);
  for (const { a, b } of segs) {
    if (a.y === b.y) continue;
    const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y), w = b.y > a.y ? 1 : -1;
    for (let r = Math.max(0, Math.ceil((lo - y0) / SCAN_H - 0.5)); r < rows; r++) {
      const y = y0 + (r + 0.5) * SCAN_H;
      if (y >= hi) break;
      if (y < lo) continue;
      by[r].push([a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x), w]);
    }
  }
  const rects = [];
  by.forEach((xs, r) => {
    if (!xs.length) return;
    xs.sort((p, q) => p[0] - q[0]);
    const yb = y0 + r * SCAN_H, yt = yb + SCAN_H;
    let wn = 0, st = 0, last = 0;
    for (const [x, sg] of xs) {
      const was = wn !== 0;
      wn += sg;
      if (!was && wn !== 0) st = x;
      else if (was && wn === 0 && x > st) rects.push([[st, yb], [x, yb], [x, yt], [st, yt]]);
      last = x;
    }
    // 掃到最後還沒回到 0（斷掉的線少一條）⇒ 收在最後一條線
    if (wn !== 0 && last > st) rects.push([[st, yb], [last, yb], [last, yt], [st, yt]]);
  });
  return shadowLoops(rowsToLoops(rects, SCAN_EPS));
}

/**
 * 🔴 **斷線先接頭尾**（網格核心第五批 b ⑥）：每一條斷掉的線，尾巴接到最近、還沒被接過的頭
 * （可以是自己的頭 ⇒ 開口的 U 字自己封起來）。所有配對照距離排、**短的先接**、一個頭只接一次。
 * 只有一條直線的斷線（沒有厚度的板子切到的那一條）接回自己 ⇒ 圍不出面積 ⇒ ⛔ 憑空補出料
 * （以前「收在最後一條線」會把兩片隔板中間整個填滿）。
 * 每條尾巴只找最近的 `BRIDGE_K` 個頭（格子一圈一圈往外找）⇒ 斷線多也⛔ 變成兩兩全比；
 * 那幾個頭都被別人接走的尾巴最後再從剩下的頭裡找最近的。
 * @param {{head:{x,y}, tail:{x,y}}[]} ends `chain()` 回傳的斷線頭尾
 * @returns {{a:{x,y}, b:{x,y}}[]} 補上的線（尾 → 頭）
 */
export function bridgeEnds(ends) {
  const n = ends.length;
  if (!n) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  // ⚠ 格子要把頭跟尾都包進去：只包頭的話，只有一條斷線時格子小到 0、尾巴在無限遠的格子外 ⇒ 一圈一圈找不完（測試抓到）
  for (const { head: h, tail: t } of ends) {
    x0 = Math.min(x0, h.x, t.x); y0 = Math.min(y0, h.y, t.y); x1 = Math.max(x1, h.x, t.x); y1 = Math.max(y1, h.y, t.y);
  }
  const cell = Math.max(x1 - x0, y1 - y0, 1e-9) / Math.ceil(Math.sqrt(n));
  const gx = x => Math.floor((x - x0) / cell), gy = y => Math.floor((y - y0) / cell);
  const nx = gx(x1), ny = gy(y1), grid = new Map();
  ends.forEach(({ head: h }, j) => {
    const k = gx(h.x) + ',' + gy(h.y);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(j);
  });
  const dist = (t, j) => Math.hypot(ends[j].head.x - t.x, ends[j].head.y - t.y);
  const pairs = [];
  ends.forEach(({ tail: t }, i) => {
    const cx = gx(t.x), cy = gy(t.y), found = [];
    for (let r = 0; ; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          for (const j of grid.get((cx + dx) + ',' + (cy + dy)) || []) if (j !== i) found.push([dist(t, j), j]);
        }
      }
      // 外面一圈的頭至少離 r 格遠 ⇒ 已經找到 K 個、而且第 K 個不比那更遠就夠了
      if (found.length >= BRIDGE_K) {
        found.sort((p, q) => p[0] - q[0]);
        if (found[BRIDGE_K - 1][0] <= r * cell) break;
      }
      if (cx - r <= 0 && cy - r <= 0 && cx + r >= nx && cy + r >= ny) break;    // 整張格子都找過了
    }
    found.sort((p, q) => p[0] - q[0]);
    for (const [d, j] of found.slice(0, BRIDGE_K)) pairs.push([d, i, j]);
    pairs.push([dist(t, i), i, i]);
  });
  pairs.sort((p, q) => p[0] - q[0]);
  const tUsed = new Set(), hUsed = new Set(), out = [];
  const join = (i, j) => { tUsed.add(i); hUsed.add(j); out.push({ a: ends[i].tail, b: ends[j].head }); };
  for (const [, i, j] of pairs) if (!tUsed.has(i) && !hUsed.has(j)) join(i, j);
  // 剩下的（找的那幾個頭都被接走了）：剩下的尾巴跟剩下的頭照樣短的先接
  const ti = [], hj = [];
  for (let i = 0; i < n; i++) { if (!tUsed.has(i)) ti.push(i); if (!hUsed.has(i)) hj.push(i); }
  const rest = [];
  // ⚠ 剩下太多（⛔ 遇過）就不兩兩全比 —— 沒接到的交給掃描線「收在最後一條線」
  if (ti.length * hj.length <= 4e6) for (const i of ti) for (const j of hj) rest.push([dist(ends[i].tail, j), i, j]);
  rest.sort((p, q) => p[0] - q[0]);
  for (const [, i, j] of rest) if (!tUsed.has(i) && !hUsed.has(j)) join(i, j);
  return out;
}

/**
 * 把一堆有向線段串成封閉迴圈。
 *
 * 用量化過的座標當 key 找「下一段」。量化是必要的：
 * 同一個交點由相鄰兩個面各自算一次，浮點結果可能差在最後一兩位。
 */
function chain(segs) {
  const key = p => `${Math.round(p.x * SNAP)},${Math.round(p.y * SNAP)}`;
  const from = new Map();
  for (const s of segs) {
    const k = key(s.a);
    if (!from.has(k)) from.set(k, []);
    from.get(k).push(s);
  }

  const loops = [];
  let open = 0;
  const ends = [];                      // 斷掉的線的頭與尾（網格核心第五批 b ⑥ 接頭尾要用）
  const used = new Set();

  for (const s0 of segs) {
    if (used.has(s0)) continue;

    const pts = [s0.a];
    let cur = s0;
    used.add(cur);
    let closed = false;

    for (let guard = 0; guard < segs.length + 2; guard++) {
      pts.push(cur.b);
      const k = key(cur.b);
      if (k === key(s0.a)) { closed = true; pts.pop(); break; }

      const cand = (from.get(k) || []).find(s => !used.has(s));
      if (!cand) break;                 // 走到底接不下去 ＝ 網格不封閉
      used.add(cand);
      cur = cand;
    }

    if (!closed) { open++; ends.push({ head: pts[0], tail: pts[pts.length - 1] }); continue; }

    const clean = dropCollinear(pts);
    if (clean.length < 3) continue;

    const a = signedArea(clean);
    if (Math.abs(a) < 1e-9) continue;   // 退化成一條線，丟掉
    loops.push({ pts: clean, area: a, isHole: a < 0 });
  }

  return {
    loops,
    area: loops.reduce((s, l) => s + l.area, 0),
    open,
    ends
  };
}

/**
 * 拿掉共線的多餘頂點。
 *
 * 方塊的一個側面在網格上是兩個三角形，切下去會得到兩段首尾相接、
 * 方向完全一樣的線 —— 中間那個點是三角化的產物，不是形狀的一部分。
 * 留著的話 DXF 會多一倍的 LINE 實體，進 Illustrator 之後
 * 那個點還會變成一個可以被拖走的錨點。
 *
 * 判準用**面積**不用角度：三點圍出的三角形面積小於容許值就是共線。
 * 面積對「兩點很近」與「角度很小」同時有效，而角度對前者會誤判。
 * 容許值刻意設得極小（1e-9 cm²），只清掉真正共線的，不動任何曲線。
 */
function dropCollinear(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-12 && Math.abs(last.y - p.y) < 1e-12) continue;
    out.push(p);
  }
  if (out.length < 3) return out;

  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(cross) / 2 < 1e-9) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** 鞋帶公式。逆時針為正。 */
export function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

// ═══════════════════════════════════════════════════════
//  三、整份：切成一疊
// ═══════════════════════════════════════════════════════

/**
 * 把一個網格切成一疊片。
 *
 * @param {Mesh} mesh 世界座標的半邊網格
 * @param {object} opt { axis, bands }
 * @returns {{ok, axis, plan, slices, warnings, stats}}
 */
export function sliceMesh(mesh, opt = {}) {
  return sliceMany([mesh], opt);
}

/**
 * 一次切多個網格，用**同一組平面**。
 *
 * 多物件一定要共用一組平面，不能各切各的：各自算自己的高度範圍的話，
 * 兩個物件的第 3 片會落在不同高度，疊起來就對不上了。
 * 所以高度範圍取全部物件的聯集，切出來的輪廓再合進同一片裡。
 *
 * @param {Mesh[]} meshes 世界座標的半邊網格
 */
export function sliceMany(meshes, opt = {}) {
  const axis = AXES[opt.axis] ? opt.axis : DEFAULT_AXIS;
  const A = AXES[axis];
  const warnings = [];
  const list = meshes.filter(Boolean);

  if (!list.length) return { ok: false, reason: '沒有可以切的物件。', axis };

  let lo = Infinity, hi = -Infinity;
  for (const m of list) {
    m.computeNormals();
    const b = m.bounds();
    lo = Math.min(lo, b.min[A.key]);
    hi = Math.max(hi, b.max[A.key]);
  }
  const height = hi - lo;

  if (!(height > 0)) {
    return { ok: false, reason: '這個物件沿切片軸沒有厚度，切不出東西。', axis };
  }

  const open = list.filter(m => !m.isClosed()).length;
  if (open) {
    /**
     * 開放曲面（板件）切下去得到的是斷掉的線串，不是封閉輪廓，
     * 沒辦法轉成「一片可以裁下來的板」。
     * 這裡不擋，但一定要講 —— 沉默地給一張接不起來的圖最糟。
     */
    warnings.push(`有 ${open} 個物件不是封閉的實體（是開放曲面），`
      + '剖面切出來的線可能接不成封閉輪廓（有斷線的片補了沒有，下面會講）。要精確的輪廓，請先改成實體或做布林聯集。');
  }
  /**
   * 🔴 **每片自動合併**（2026-10-22，第二輪第一批（二）甲；kang「同意你的建議」）。
   * 以前多個物件只講「若它們互相重疊…請先做布林聯集再切」，切出來照樣是兩圈線：
   * 方塊＋圓柱疊在一起 70 片有 45 片面積算兩次（多算 19%），雷切照線切一片碎成 3 塊；
   * 一個物件裡零件穿插（匯入的汽車）同樣算兩次，而且連那一句都沒有。
   * ⭐ 現在每一片的輪廓交給 `mergeLoops()`（Positive）合成一張；⛔ 有疊到的片原樣不動。
   * ⚠ 沒有布林函式庫就合不了 ⇒ 照舊、照舊提醒。
   */
  const canMerge = csgReady();
  if (list.length > 1 && !canMerge) {
    warnings.push(`一次切了 ${list.length} 個物件。布林函式庫還沒載入（或載入失敗），`
      + '重疊的地方沒辦法自動合併 —— 若它們互相重疊，重疊處會畫出兩圈線，請先做布林聯集再切。');
  }

  const plan = planSlabs(height, opt.bands);
  /**
   * 🔴 **被擋下來的那一段一定要講出來**（2026-10-08）。
   * `bad` 以前只寫進 `plan.bands`、畫面上一個字都不印 ——
   * 結果是「片數變 0、沒有任何說明」，跟壞掉看起來一模一樣。
   */
  plan.bands.forEach((b, i) => {
    if (b.bad) warnings.push(`第 ${i + 1} 段：${b.bad}`);
  });
  /**
   * 🔴 **照最大外形切（寧大勿小）**（2026-10-19，實驗 T2：0.4 cm 的帽簷遇到 1 cm 的板，整個不見）。
   * kang 2026-10-19：「三條都照你的建議做」（建議：預設照舊取中間、漏掉時講出來、另外給這個選項）。
   * ⭐ 勾了 ⇒ 每片取那一段厚度裡**最大的外形**（`bool.js` `slabShadow()`：那一段立體的影子），
   * 薄的部分不會不見；疊起來比模型大一點，之後再磨。⚠ 要布林函式庫；開放曲面⛔ 影子可言，照舊取中間。
   */
  const wantMax = !!opt.maxOutline;
  const canMax = wantMax && csgReady();
  if (wantMax && !canMax) {
    warnings.push('「照最大外形切」要用布林運算函式庫，它還沒載入（或載入失敗）—— 這次照中間的截面切。');
  }
  const basis = [A.uv[0], A.uv[1], A.dir];

  const slices = [];
  let openTotal = 0;
  const patchedAt = [], unpatchedAt = [];
  const mergedAt = [];
  let before = 0, after = 0;

  for (const s of plan.slabs) {
    const coord = lo + s.mid;
    let loops = [];
    let op = 0;
    const segs = [], ends = [], shadows = [];
    for (const m of list) {
      if (canMax && m.isClosed()) {
        for (const l of shadowLoops(slabShadow(m, basis, lo + s.z0, lo + s.z1))) { loops.push(l); shadows.push(l); }
        continue;
      }
      const r = sectionAt(m, axis, coord);
      loops.push(...r.loops);
      op += r.open;
      for (const g of r.segs) segs.push(g);
      if (r.ends.length) ends.push(r.ends);
    }
    openTotal += op;
    /**
     * 有斷線 ⇒ 斷線先接頭尾、這一片整片改用掃描線補（所有物件的線段一起掃 ⇒ 疊在一起的也一次合好）。
     * ⚠ 頭尾**只在同一個物件裡面接**：收納盒整份一起切，盒身牆上缺口的線頭被接到旁邊隔板的線上 ⇒ 第 4～6 片
     * 多出一個斜的缺口（203.45 cm²，本機抓到）；各接各的 ⇒ 240、跟上下片一樣。
     */
    let patched = false;
    if (op > 0 && canMerge && segs.length) {
      for (const e of ends) for (const g of bridgeEnds(e)) segs.push(g);
      const filled = scanFill(segs);
      // ⚠ 照最大外形切時封閉的物件走影子、⛔ 在線段裡 ⇒ 影子要留著、跟補出來的再合一次（⛔ 留的話那些物件整個不見）
      if (filled.length) { loops = [...shadows, ...filled]; patched = true; patchedAt.push(s.index); }
      else unpatchedAt.push(s.index);       // 接起來也圍不出面積（只切到沒有厚度的板子的一條線）
    }
    let area = loops.reduce((a, l) => a + l.area, 0);
    let overlap = 0;
    if (canMerge && loops.length > 1 && (!patched || shadows.length)) {
      const merged = shadowLoops(mergeLoops(loops.map(l => l.pts)));
      const mArea = merged.reduce((a, l) => a + l.area, 0);
      if (Math.abs(area - mArea) > MERGE_TOL + MERGE_REL * Math.abs(area)) {
        overlap = area - mArea;
        mergedAt.push(s.index);
        before += area; after += mArea;
        loops = merged;
        area = mArea;
      }
    }
    slices.push({
      index: s.index,
      band: s.band,
      t: s.t,
      z0: lo + s.z0, z1: lo + s.z1,
      coord,
      loops,
      area,
      overlap,          // 合併前多算的面積（cm²）；0 ＝ 沒有疊到、輪廓原樣
      open: op,
      patched,          // 有斷線、已經用掃描線補（網格核心第五批 b ⑥）
      bounds: loopsBounds(loops)
    });
  }

  if (mergedAt.length) {
    warnings.push(`第 ${listNums(mergedAt)} 片有輪廓疊在一起（`
      + (list.length > 1 ? `${list.length} 個物件互相重疊` : '物件裡的零件互相穿插')
      + `），已經照「被任何一圈包住就是料」合成一圈，重疊的地方只算一次：這幾片原本算 ${r2(before)} cm²、合併後 ${r2(after)} cm²。`);
  }

  if (patchedAt.length) {
    warnings.push(`第 ${listNums(patchedAt)} 片有斷線（模型有破洞、零件沒接好，或是開口的板件，共 ${openTotal} 條線接不起來），`
      + '已經補成實心的片：斷掉的線頭尾接到最近的線、再一列一列掃，被任何一圈包住就算料，精度 0.1 mm —— 這幾片的輪廓是補出來的，切之前看一下形狀對不對。');
  }
  if (unpatchedAt.length) {
    warnings.push(`第 ${listNums(unpatchedAt)} 片有斷線、補不起來（斷掉的線接起來也圍不出面積 —— 例如只切到沒有厚度的板子的一條線）`
      + ' —— 那幾片只剩接得起來的輪廓；外來的破模型先補好（匯入時選「補洞＋修方向」）再切。');
  }
  if (!patchedAt.length && !unpatchedAt.length && openTotal > 0) {
    warnings.push(`有 ${openTotal} 條線接不成封閉輪廓，那些地方切不出可裁的片`
      + (canMerge ? '。' : '（布林運算函式庫沒載入，沒辦法用掃描線補）。'));
  }

  /**
   * 🔴 **照中間切時，片裡面有「台階」要講出來**（2026-10-19，實驗 T2）。
   * ⚠ 一片只取中間那一刀 ⇒ 落在片**裡面**（⛔ 剛好在片與片之間）的水平面，它上下其中一邊的東西
   * 會漏掉或多出一塊 —— 帽簷 0～0.4 cm、板 0～1 cm、中間取 0.5：帽簷整個不見，⛔ 任何提示（漏報）。
   * ⭐ 判準只看「跟切片軸垂直的面」落在哪個高度：平滑曲面⛔ 會有這種面 ⇒ 球、碗⛔ 會被誤報。
   */
  if (!canMax) {
    const steps = stepHeights(list, A.dir);
    const hit = [];
    for (const sl of slices) {
      const hs = steps.filter(h => h > sl.z0 + STEP_TOL && h < sl.z1 - STEP_TOL);
      if (hs.length) hit.push(`第 ${sl.index} 片（${r2(sl.z0 - lo)}～${r2(sl.z1 - lo)} cm，台階在 ${hs.map(h => r2(h - lo)).join('、')}）`);
    }
    if (hit.length) {
      warnings.push(`有 ${hit.length} 片裡面有台階（跟板子平行的面），照中間切會漏掉或多出一塊：`
        + hit.slice(0, 5).join('、') + (hit.length > 5 ? ` …等 ${hit.length} 片` : '')
        + '。改那一段的板厚讓台階落在片與片之間，或勾「照最大外形切」。');
    }
  }

  const empty = slices.filter(s => !s.loops.length).map(s => s.index);
  if (empty.length) {
    warnings.push(`第 ${listNums(empty)} 片切到空的地方（模型在那個高度沒有東西），`
      + '要嘛分段的總高超出模型，要嘛模型中間是斷開的。');
  }

  return {
    ok: true,
    axis,
    plan,
    slices,
    warnings,
    stats: {
      count: slices.length,
      height,
      used: plan.used,
      diff: plan.diff,
      area: slices.reduce((a, s) => a + s.area, 0),
      merged: mergedAt.length,
      thickKinds: [...new Set(slices.map(s => r2(s.t)))].sort((a, b) => a - b)
    }
  };
}

/** 一疊片沿切片軸的總外框（排版與定位孔都要用） */
export function loopsBounds(loops) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of loops) {
    for (const p of l.pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (minX > maxX) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** 全部片合起來的外框 —— 定位孔要在這個範圍裡找 */
export function stackBounds(slices) {
  return loopsBounds(slices.flatMap(s => s.loops));
}

/**
 * 點在不在這一片的實心部分裡，離最近的邊有多遠。
 *
 * @returns {number} 正 ＝ 在料上，數字就是離邊界的距離；負 ＝ 在料外
 *
 * 用「射線交叉數」判斷內外（外輪廓逆時針、內孔順時針都一樣適用，
 * 因為內外只看穿過幾條邊，跟繞向無關），距離另外算。
 * 兩件事分開算比較笨，但**分開才驗得出來**：測試可以單獨盯
 * 「方塊中心到邊界 ＝ 一半」這種手算得出來的數字。
 */
export function insideDepth(loops, x, y) {
  let inside = false;
  let best = Infinity;

  for (const l of loops) {
    const pts = l.pts;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a.y > y) !== (b.y > y)) {
        const xx = a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x);
        if (xx > x) inside = !inside;
      }
      const d = segDist(x, y, a.x, a.y, b.x, b.y);
      if (d < best) best = d;
    }
  }

  if (!isFinite(best)) return -Infinity;
  return inside ? best : -best;
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
}

/** 把 [1,2,3,7,8] 印成「1~3、7~8」——片一多，一長串數字沒人讀得完 */
export function listNums(ns) {
  if (!ns.length) return '';
  const out = [];
  let a = ns[0], b = ns[0];
  for (let i = 1; i <= ns.length; i++) {
    if (i < ns.length && ns[i] === b + 1) { b = ns[i]; continue; }
    out.push(a === b ? `${a}` : `${a}~${b}`);
    a = b = ns[i];
  }
  return out.join('、');
}

const r2 = v => Math.round(v * 100) / 100;

/** 台階高度跟片的上下緣要差多少才算「在片裡面」（cm）—— 剛好落在片與片之間的⛔ 算 */
const STEP_TOL = 1e-4;

/** 所有網格裡「跟切片軸垂直的面」的高度（沿切片軸、世界座標，去重）*/
function stepHeights(meshes, dir) {
  const out = [];
  for (const m of meshes) {
    for (const f of m.faces) {
      const n = f.normal;
      if (!n || Math.abs(n.x * dir[0] + n.y * dir[1] + n.z * dir[2]) < 0.9999) continue;
      const p = m.faceVerts(f)[0].p;
      const h = p.x * dir[0] + p.y * dir[1] + p.z * dir[2];
      if (!out.some(x => Math.abs(x - h) < STEP_TOL)) out.push(h);
    }
  }
  return out.sort((a, b) => a - b);
}

/** `slabShadow()` 的多邊形 → 跟 `sectionAt()` 一樣的輪廓（外圈正面積、洞負面積）*/
function shadowLoops(polys) {
  const out = [];
  for (const pts of polys) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i], q = pts[(i + 1) % pts.length];
      a += p.x * q.y - q.x * p.y;
    }
    a /= 2;
    if (Math.abs(a) < 1e-12) continue;
    out.push({ pts, area: a, isHole: a < 0 });
  }
  return out;
}
