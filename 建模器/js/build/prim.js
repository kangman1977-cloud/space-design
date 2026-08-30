/**
 * prim.js — 帶參數的基本體
 *
 * 每個基本體都是「一組參數 → 一個半邊網格」的函式。
 * 參數留在物件身上（存在 src），所以隨時可以改尺寸重新生成，
 * 這是參數化建模跟直接改網格最大的差別。
 *
 * ── 為什麼不直接用 three.js 的 BoxGeometry ──────────
 * 用了，但只當中間產物。three.js 的幾何體每個三角形各有各的頂點，
 * 位置一樣也是不同物件，沒有鄰接關係。
 * 一律走 Mesh.fromGeometry() 焊接成半邊結構之後才交出去。
 *
 * ── 分段數的取捨 ────────────────────────────────────
 * 圓柱的 seg 直接決定面數與展開後的片數。
 * 32 已經很圓，但如果要展開成鈑金，seg 就是實際要折的稜線數 ——
 * 那時候可能刻意只用 12 或 16。所以分段數是使用者參數，不是寫死的常數。
 *
 * 單位一律 cm。
 */

import * as THREE from 'three';
import { Mesh } from '../core/mesh.js';
import { extrudeMany } from './extrude.js';
/**
 * ⚠ **單向相依，⛔ 不會繞回來**：`svgPath.js` 一個 `import` 都沒有
 * （2026-08-29 查過）。⭐ 借 `flattenCubic()` 是刻意的 ——
 * 鋼筆畫的貝茲曲線跟 SVG 匯進來的**是同一種東西**，
 * ⛔ 不要為了避免跨檔就在這裡重寫一支細分。
 */
import { flattenCubic, splitCubic, cubicAt, nearestOnCubic, DEFAULT_TOL }
  from '../sketch/svgPath.js';

/** 每種基本體的預設參數，介面直接拿這個當表單初值 */
export const PRIM_DEFAULTS = {
  box:      { w: 60, h: 45, d: 40 },
  cylinder: { r: 25, h: 70, seg: 32, openEnded: false },
  cone:     { rTop: 0, rBottom: 30, h: 70, seg: 32, openEnded: false },
  sphere:   { r: 30, segW: 32, segH: 16 },
  prism:    { sides: 6, r: 30, h: 60 },
  tube:     { rOuter: 25, rInner: 20, h: 70, seg: 32 },
  roundBox: { w: 60, h: 45, d: 40, r: 6, segR: 4 },
  plate:    { w: 100, d: 60, segW: 1, segD: 1 },
  bend:     {
    w: 60,           // 板寬（沿 Z）
    first: 40,       // 第一段長度
    arcSeg: 4,       // 每個折彎圓弧分幾段
    k: 0.4,          // K 因子（中性層位置比例，見 neutralRadius）
    bends: [{ angle: 90, ri: 2, len: 30 }]   // 一道折彎 ＝ L 型
  }
};

/**
 * 中性層半徑 —— 折彎件所有長度計算的根。
 *
 * ── 為什麼不是直接用使用者填的半徑 ──────────────────
 * 折鐵板時外側被拉長、內側被壓縮，中間有一層長度剛好不變，
 * 這一層叫**中性層**，下料長度必須照它算。
 *
 * 但現場沒有人量得到中性層在哪 —— 師傅講「折 R3」指的是
 * **模具的內側圓角**，圖面標的也是內側 R。所以參數存內側 R，
 * 中性層由公式推出來：
 *
 *     rn = ri + K × t
 *
 * K 是中性層落在板厚的幾成（從內側量起），典型值 0.35～0.45，
 * 是**材料屬性**，所以預設值放在 unfold/rules.js 的材料表裡，
 * 幾何這邊只負責照公式算。
 *
 * ── 差多少 ──────────────────────────────────────────
 * 3mm 鐵板、內 R3、折 90°：
 *   照內側 R 算 → 4.71mm，照中性層算 → 6.60mm，每道差 1.9mm。
 * 折四道就差 7.6mm，折完裝不上去。
 *
 * @param {number} ri 內側圓角半徑 cm
 * @param {number} k  K 因子
 * @param {number} t  板厚 cm
 */
export function neutralRadius(ri, k, t) {
  const r = Math.max(0, num(ri, 0));
  if (r < 1e-9) return 0;            // 尖角折就是尖角折，不補
  return r + Math.max(0, num(k, 0.4)) * Math.max(0, num(t, 0));
}

/** 給介面用的清單：標籤、可調欄位、範圍 */
export const PRIM_SPECS = {
  /**
   * 擠出件只有一個可以改的參數：高度。
   * 輪廓是匯進來的，要改就回 Illustrator 改再匯一次 ——
   * 在這裡放一堆點的編輯欄位沒有意義。
   */
  extrude: {
    label: '擠出件',
    fields: [
      { key: 'h', label: '高 Y', min: 0.05, step: 0.5 }
    ]
  },
  box: {
    label: '方塊',
    fields: [
      { key: 'w', label: '寬 X', min: 0.1, step: 1 },
      { key: 'h', label: '高 Y', min: 0.1, step: 1 },
      { key: 'd', label: '深 Z', min: 0.1, step: 1 }
    ]
  },
  cylinder: {
    label: '圓柱',
    fields: [
      { key: 'r',   label: '半徑', min: 0.1, step: 1 },
      { key: 'h',   label: '高',   min: 0.1, step: 1 },
      { key: 'seg', label: '分段', min: 3, max: 128, step: 1, int: true }
    ]
  },
  cone: {
    label: '錐體',
    fields: [
      { key: 'rTop',    label: '上半徑', min: 0, step: 1 },
      { key: 'rBottom', label: '下半徑', min: 0, step: 1 },
      { key: 'h',       label: '高',     min: 0.1, step: 1 },
      { key: 'seg',     label: '分段',   min: 3, max: 128, step: 1, int: true }
    ]
  },
  sphere: {
    label: '球',
    fields: [
      { key: 'r',    label: '半徑', min: 0.1, step: 1 },
      { key: 'segW', label: '經線', min: 3, max: 128, step: 1, int: true },
      { key: 'segH', label: '緯線', min: 2, max: 64,  step: 1, int: true }
    ]
  },
  prism: {
    label: '角柱',
    fields: [
      { key: 'sides', label: '邊數',   min: 3, max: 64, step: 1, int: true },
      { key: 'r',     label: '外接圓', min: 0.1, step: 1 },
      { key: 'h',     label: '高',     min: 0.1, step: 1 }
    ]
  },
  tube: {
    label: '管',
    fields: [
      { key: 'rOuter', label: '外半徑', min: 0.1, step: 1 },
      { key: 'rInner', label: '內半徑', min: 0, step: 1 },
      { key: 'h',      label: '高',     min: 0.1, step: 1 },
      { key: 'seg',    label: '分段',   min: 3, max: 128, step: 1, int: true }
    ]
  },
  roundBox: {
    label: '圓角方塊',
    fields: [
      { key: 'w',    label: '寬 X',     min: 0.1, step: 1 },
      { key: 'h',    label: '高 Y',     min: 0.1, step: 1 },
      { key: 'd',    label: '深 Z',     min: 0.1, step: 1 },
      { key: 'r',    label: '圓角半徑', min: 0, step: 0.5 },
      { key: 'segR', label: '圓角分段', min: 1, max: 32, step: 1, int: true }
    ]
  },
  plate: {
    label: '平板',
    sheet: true,
    fields: [
      { key: 'w', label: '寬 X', min: 0.1, step: 1 },
      { key: 'd', label: '深 Z', min: 0.1, step: 1 }
    ]
  },
  bend: {
    label: '折板',
    sheet: true,
    /** bends（折彎序列）是動態長度的，面板另外處理，不放在 fields 裡 */
    fields: [
      { key: 'w',      label: '板寬 Z',   min: 0.1, step: 1 },
      { key: 'first',  label: '第一段長', min: 0.1, step: 1 },
      { key: 'arcSeg', label: '圓弧分段', min: 2, max: 24, step: 1, int: true,
        hint: '折彎圓弧切成幾段。至少 2 段 —— 只切 1 段的話，網格上跟一個倒角'
            + '長得完全一樣，展開時分不出是圓弧還是倒角，長度會少算' },
      { key: 'k',      label: 'K 因子',   min: 0, max: 0.5, step: 0.05,
        hint: '中性層落在板厚的幾成（從內側量起）。軟鋼 0.4、不鏽鋼 0.45、鋁 0.35。'
            + '下料長度就是照這個算出來的' }
    ],
    hasBends: true
  }
};

/** 這個基本體天生就是板件（要展開的東西），新增時直接設成 sheet */
export function isSheetPrim(type) {
  return !!(PRIM_SPECS[type] && PRIM_SPECS[type].sheet);
}

/**
 * 扁平的 [x,y,x,y,…] → [{x,y,corner},…]。存檔用扁平的，算的時候用物件。
 * @param {number[]} cor 真轉角的索引清單（一個 S 字只有七八個，比整條 bit 陣列省）
 */
function pairs(arr, cor) {
  const out = [];
  const a = arr || [];
  const set = new Set(cor || []);
  for (let i = 0; i + 1 < a.length; i += 2) {
    out.push({ x: +a[i], y: +a[i + 1], corner: set.has(i / 2) });
  }
  return out;
}

/** [{x,y},…] → 扁平的 [x,y,x,y,…]，順便修到 4 位小數（＝ 1 微米，遠超需要） */
export function flatPts(pts) {
  const out = [];
  for (const p of pts) out.push(r4(p.x), r4(p.y));
  return out;
}

/**
 * 🔴 **鋼筆所有錨點的外框中心。**（原點置中用）
 *
 * ⚠ **只看錨點，⛔ 不看把手** —— 把手是控制點，**它不在形狀上**，
 * 拉得再長也不代表形狀長到那裡。
 * ⭐ 而錨點就是**參數**，搬它們才留得住（參數物件改頂點是留不住的）。
 *
 * @returns {{cx:number, cy:number, ok:boolean}} 形狀座標系（對到世界的 X 與 Z）
 */
export function penBounds(paths) {
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const path of paths || []) {
    const a = (path && path.a) || [];
    for (let i = 0; i + 1 < a.length; i += 2) {
      lo[0] = Math.min(lo[0], +a[i]);   hi[0] = Math.max(hi[0], +a[i]);
      lo[1] = Math.min(lo[1], +a[i + 1]); hi[1] = Math.max(hi[1], +a[i + 1]);
    }
  }
  if (!Number.isFinite(lo[0])) return { cx: 0, cy: 0, ok: false };
  return { cx: (lo[0] + hi[0]) / 2, cy: (lo[1] + hi[1]) / 2, ok: true };
}

/**
 * 把所有錨點平移。**⛔ 不動把手** —— 把手存的是「相對錨點的位移」，
 * 錨點搬了它自己就跟著走。〔那正是當初選相對座標的理由〕
 *
 * ⚠ **就地修改**，回傳同一份（跟 `shiftShape` 不同，鋼筆的路徑本來就是自己的）。
 */
export function shiftPenPaths(paths, dx, dy) {
  for (const path of paths || []) {
    const a = (path && path.a) || [];
    for (let i = 0; i + 1 < a.length; i += 2) {
      a[i] = r4(+a[i] + dx);
      a[i + 1] = r4(+a[i + 1] + dy);
    }
  }
  return paths;
}

/**
 * 🔴 **兩根把手的夾角差幾度以內算「圓滑」**（第 2 階段，2026-08-29）。
 *
 * ⭐ **判準是角度，⛔ 不是「存的時候是不是 `hi = −ho`」** ——
 * 後者是**存法**，而使用者可以把把手折斷成任何角度
 * 〔坑第 26 條：容許值要挑有物理意義的量〕。
 *
 * ⚠ **1 度的物理意義**：一根 100 cm 的把手，端點差 1.7 cm ——
 * 畫面上剛好看得出來。而「拖出來的圓滑點」存的是精確反向（夾角精確 180），
 * **存讀檔往返的浮點誤差遠小於 1 度**，所以⛔ 不會誤判。
 */
export const PEN_SMOOTH_TOL_DEG = 1;

/**
 * 🔴🔴 **這個錨點是「圓滑」的嗎 ＝ 兩根把手成不成一直線。**
 *
 * ⭐ **這一支是 kang 2026-08-29 拍板那個框架的核心**：
 * > **連動與否是【錨點的屬性】，⛔ 不是一個拖曳規則。**
 *
 * 所以⛔ 不必問使用者「現在要不要連動」——
 * **畫面上就看得出來**（圓滑點的兩根永遠成一直線）。
 *
 * ⚠ **兩根都要非零**：只有一根的點（第一段的起點、最後一段的終點、
 * 或剛被 `尖角` 收掉一根的）**⛔ 不算圓滑** ——
 * 那時另一根不存在，「連動」沒有對象。
 *
 * ⚠ **⛔ 放在這裡而不是 `select.js`，是因為 `select.js` 碰 DOM 就測不到**
 * 〔鐵律二：判定邏輯抽成不碰 DOM 的純函式，才測得到〕。
 */
export function penIsSmooth(path, i, tolDeg = PEN_SMOOTH_TOL_DEG) {
  if (!path || !path.hi || !path.ho) return false;
  const ix = +path.hi[i * 2], iz = +path.hi[i * 2 + 1];
  const ox = +path.ho[i * 2], oz = +path.ho[i * 2 + 1];
  if (![ix, iz, ox, oz].every(Number.isFinite)) return false;
  const li = Math.hypot(ix, iz), lo = Math.hypot(ox, oz);
  if (li < 1e-9 || lo < 1e-9) return false;
  /** cos(180° − tol) —— 夾角越接近 180 度，這個值越接近 −1 */
  const lim = Math.cos((180 - tolDeg) * Math.PI / 180);
  return (ix * ox + iz * oz) / (li * lo) <= lim;
}

/**
 * 🔴🔴 **設一根把手，另一根照【這個錨點本來是什麼】決定跟不跟。**
 *
 * > **圓滑點** → 另一根**只跟著轉方向，長度各自保留**
 * > **尖角點** → 另一根**一格都不動**
 *
 * ⚠ **長度⛔ 不連動**是刻意的：連動的話，
 * **調這一段的彎度會強制改掉隔壁那一段的彎度** ——
 * 而「只改該碰的那一端」是這個專案 2026-08-28 立的鐵律
 * （側牆繞向、`marksOf()`、閉合把手都是同一條）。
 *
 * 🔴 **`smooth` 一定要在【改之前】問。**
 * 改完再問的話，**剛拖的那一根方向已經變了 → 永遠算出「不圓滑」**
 * → 連動永遠不會發生，而且**看起來像是功能沒做**。
 *
 * @param {object} path 就地修改
 * @param {'in'|'out'} side 拖的是哪一根
 * @returns {boolean} 另一根有沒有跟著動
 */
export function penSetHandle(path, i, side, dx, dz) {
  if (!path || !path.hi || !path.ho) return false;
  const smooth = penIsSmooth(path, i);
  const self = side === 'in' ? path.hi : path.ho;
  const other = side === 'in' ? path.ho : path.hi;
  self[i * 2] = dx;
  self[i * 2 + 1] = dz;
  if (!smooth) return false;
  const len = Math.hypot(other[i * 2], other[i * 2 + 1]);
  const cur = Math.hypot(dx, dz);
  /** ⚠ 拖到跟錨點重疊 → 方向沒有定義，⛔ 這一格不要動另一根 */
  if (cur < 1e-9 || len < 1e-9) return false;
  other[i * 2] = -dx / cur * len;
  other[i * 2 + 1] = -dz / cur * len;
  return true;
}

/** 一條鋼筆路徑的第 i 段（i → i+1）攤成貝茲的四個點。⛔ 不要各處自己拼。 */
function penSeg(path, i) {
  const n = Math.floor(path.a.length / 2);
  const j = (i + 1) % n;
  const g = (arr, k, c) => +((arr || [])[k * 2 + c] || 0);
  return [
    +path.a[i * 2], +path.a[i * 2 + 1],
    +path.a[i * 2] + g(path.ho, i, 0), +path.a[i * 2 + 1] + g(path.ho, i, 1),
    +path.a[j * 2] + g(path.hi, j, 0), +path.a[j * 2 + 1] + g(path.hi, j, 1),
    +path.a[j * 2], +path.a[j * 2 + 1]
  ];
}

/**
 * 🔴 **整條路徑上離 (x, y) 最近的地方是哪一段、參數多少。**
 * （「點在線上 ＝ 加一個點」要用）
 *
 * ⚠ **回的 `dist` 是【形狀座標系的距離】（cm），⛔ 不是螢幕距離** ——
 * 呼叫端要自己把那個點投影回螢幕再比門檻，
 * 因為**世界距離會隨縮放變，拉遠之後「靠得夠近」就變成不可能達成的條件**
 * 〔`_penHitAnchor()` 那一則的同一條理由〕。
 */
export function penNearestOnPath(path, x, y) {
  if (!path || !path.a) return null;
  const n = Math.floor(path.a.length / 2);
  if (n < 2) return null;
  const last = path.closed === false ? n - 1 : n;
  let best = null;
  for (let i = 0; i < last; i++) {
    const r = nearestOnCubic(x, y, ...penSeg(path, i));
    if (!best || r.dist < best.dist) best = { seg: i, t: r.t, p: r.p, dist: r.dist };
  }
  return best;
}

/**
 * 🔴🔴 **在第 `seg` 段的參數 `t` 處插一個錨點 —— 而形狀⛔ 一格都不變。**
 * （2026-08-29，鋼筆第 3 階段）
 *
 * ⭐ **走 `splitCubic()`（de Casteljau），⛔ 不是「插一個尖角點」** ——
 * 後者做起來只要一行，但**那一段會被拉直**。
 * 而使用者的意思是「我要在這裡多一個**可以調**的點」，⛔ 不是「我要改形狀」。
 *
 * 🔴 **判準因此驗得出來：加點前後【面積一格不變】。**
 * ⚠ ⛔ 這不是「差不多」—— de Casteljau 是**數學上等價**，
 * 兩段合起來就是原本那一條曲線本人。
 *
 * @param {object} path 就地修改
 * @returns {{ok:boolean, at?:number, reason?:string}} `at` ＝ 新錨點的索引
 */
export function penAddAnchor(path, seg, t) {
  if (!path || !path.a) return { ok: false, reason: '沒有路徑' };
  const n = Math.floor(path.a.length / 2);
  if (!(seg >= 0 && seg < n)) return { ok: false, reason: '沒有這一段' };
  if (!(t > 0 && t < 1)) return { ok: false, reason: '要插在這一段的中間' };
  const j = (seg + 1) % n;
  const s = splitCubic(...penSeg(path, seg), t);
  const at = seg + 1;
  /** 前一段的出把手、後一段的進把手都會變短 —— 那就是分割的結果 */
  path.ho[seg * 2]     = s.a[2] - s.a[0];
  path.ho[seg * 2 + 1] = s.a[3] - s.a[1];
  path.hi[j * 2]       = s.b[4] - s.b[6];
  path.hi[j * 2 + 1]   = s.b[5] - s.b[7];
  path.a.splice(at * 2, 0, s.mid.x, s.mid.y);
  path.hi.splice(at * 2, 0, s.a[4] - s.mid.x, s.a[5] - s.mid.y);
  path.ho.splice(at * 2, 0, s.b[2] - s.mid.x, s.b[3] - s.mid.y);
  return { ok: true, at };
}

/**
 * 🔴🔴 **刪掉錨點 `i`，兩側那兩段【擬合】成一段。**
 * （kang 2026-08-29 在三個做法裡選的：「擬合，盡量讓形狀不變」）
 *
 * ── 做法 ────────────────────────────────────────────────
 * **端點與切線方向固定，只解兩根把手的【長度】** α、β —— 那是一個
 * 2×2 的最小平方，有閉式解（Schneider 那一套的核心）。
 * ⭐ **切線方向一定要沿用原本的**，⛔ 不然接點會折一下，
 * 而那正是使用者最看得出來的地方。
 *
 * ── 🔴 退路，而且⛔ 一定要講出來 ──────────────────────────
 * 行列式接近 0（兩個方向幾乎平行）或解出**非正的長度**時，
 * **退回「直接接」**（把手長度 ＝ 弦長的 1/3，那是圓弧的標準近似），
 * 並且**回報 `fitted: false`** —— 呼叫端要講給使用者聽。
 * ⚠ **⛔ 不可以安靜地退路** —— 那樣使用者會以為擬合成功了。
 *
 * ── ⭐ 怎麼知道擬合有沒有用（鐵律三）────────────────────
 * 光看擬合的誤差**沒有人判斷得了好壞**。
 * 判準是**旁邊放一個「直接接」的誤差** —— 擬合那個應該**小一個數量級**。
 * 〔測試釘的就是這個對比〕
 *
 * @param {object} path 就地修改
 * @returns {{ok:boolean, fitted?:boolean, reason?:string}}
 */
export function penRemoveAnchor(path, i, samples = 24) {
  if (!path || !path.a) return { ok: false, reason: '沒有路徑' };
  const n = Math.floor(path.a.length / 2);
  if (!(i >= 0 && i < n)) return { ok: false, reason: '沒有這一個點' };
  if (n <= 3) return { ok: false, reason: '只剩 3 個點了 —— 再刪就圍不出一個形狀' };

  const prev = (i - 1 + n) % n;
  const segA = penSeg(path, prev);          // prev → i
  const segB = penSeg(path, i);             // i → next
  const P0 = { x: segA[0], y: segA[1] };
  const P3 = { x: segB[6], y: segB[7] };

  /** 取樣：兩段各取 `samples` 個點，⛔ 中間那個點只算一次 */
  const pts = [];
  for (let k = 0; k <= samples; k++) pts.push(cubicAt(...segA, k / samples));
  for (let k = 1; k <= samples; k++) pts.push(cubicAt(...segB, k / samples));

  /** 弦長參數化 —— ⛔ 不用均勻的 k/N，那會讓長短差很多的兩段被拉歪 */
  const cum = [0];
  for (let k = 1; k < pts.length; k++) {
    cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].y - pts[k - 1].y));
  }
  const total = cum[cum.length - 1];
  if (!(total > 1e-9)) return { ok: false, reason: '這兩段的長度是 0' };
  const us = cum.map(c => c / total);

  /** 切線方向：沿用原本的把手；沒有把手就用弦的方向 */
  const dirOf = (dx, dz, fx, fz) => {
    const L = Math.hypot(dx, dz);
    if (L > 1e-9) return { x: dx / L, y: dz / L };
    const F = Math.hypot(fx, fz);
    return F > 1e-9 ? { x: fx / F, y: fz / F } : { x: 1, y: 0 };
  };
  const t1 = dirOf(+path.ho[prev * 2], +path.ho[prev * 2 + 1], P3.x - P0.x, P3.y - P0.y);
  const next = (i + 1) % n;
  const t2 = dirOf(+path.hi[next * 2], +path.hi[next * 2 + 1], P0.x - P3.x, P0.y - P3.y);

  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let k = 0; k < pts.length; k++) {
    const u = us[k], v = 1 - u;
    const b0 = v * v * v, b1 = 3 * v * v * u, b2 = 3 * v * u * u, b3 = u * u * u;
    const a1x = t1.x * b1, a1y = t1.y * b1;
    const a2x = t2.x * b2, a2y = t2.y * b2;
    c00 += a1x * a1x + a1y * a1y;
    c01 += a1x * a2x + a1y * a2y;
    c11 += a2x * a2x + a2y * a2y;
    const tx = pts[k].x - (P0.x * (b0 + b1) + P3.x * (b2 + b3));
    const ty = pts[k].y - (P0.y * (b0 + b1) + P3.y * (b2 + b3));
    x0 += tx * a1x + ty * a1y;
    x1 += tx * a2x + ty * a2y;
  }
  const det = c00 * c11 - c01 * c01;
  let alpha = 0, beta = 0, fitted = false;
  if (Math.abs(det) > 1e-12) {
    alpha = (x0 * c11 - c01 * x1) / det;
    beta  = (c00 * x1 - x0 * c01) / det;
    fitted = alpha > 1e-9 && beta > 1e-9;
  }
  if (!fitted) {
    /** 🔴 退路：弦長的 1/3（圓弧的標準近似）。⚠ 呼叫端一定要講出來 */
    const chord = Math.hypot(P3.x - P0.x, P3.y - P0.y);
    alpha = beta = chord / 3;
  }

  path.a.splice(i * 2, 2);
  path.hi.splice(i * 2, 2);
  path.ho.splice(i * 2, 2);
  /** ⚠ 刪掉之後索引會前移 —— `next` 在新陣列裡就是原本的 `i` 那一格 */
  const p2 = prev < i ? prev : prev - 1;
  const n2 = next > i ? next - 1 : next;
  path.ho[p2 * 2]     = t1.x * alpha;
  path.ho[p2 * 2 + 1] = t1.y * alpha;
  path.hi[n2 * 2]     = t2.x * beta;
  path.hi[n2 * 2 + 1] = t2.y * beta;
  return { ok: true, fitted };
}

/**
 * 🔴 **一條鋼筆路徑 → 拉直之後的點串**（給 `BUILDERS.pen` 用）。
 *
 * 每一段是一條三次貝茲：
 * **起點 ＝ 錨點 i，控制點 ＝ 錨點 i ＋ 出把手、錨點 i+1 ＋ 進把手，終點 ＝ 錨點 i+1。**
 *
 * ⭐ **兩邊把手都是 0 的那一段直接放終點，⛔ 不跑細分** ——
 * 直線細分出來還是同一個點，白花時間而已。
 *
 * @param {{closed?:boolean, a?:number[], hi?:number[], ho?:number[]}} path
 * @param {number} tol 拉直的容許值（cm）
 * @returns {Array<{x:number,y:number,corner:boolean}>}
 */
export function flattenPenPath(path, tol = DEFAULT_TOL) {
  const a = (path && path.a) || [];
  const n = Math.floor(a.length / 2);
  if (n < 2) return [];
  const hi = (path && path.hi) || [];
  const ho = (path && path.ho) || [];
  const ax = i => +a[i * 2], ay = i => +a[i * 2 + 1];
  const g = (arr, i, k) => +(arr[i * 2 + k] || 0);

  const out = [];
  const last = path && path.closed === false ? n - 1 : n;
  for (let i = 0; i < last; i++) {
    const j = (i + 1) % n;
    /** 這個錨點是不是轉角 ＝ 它兩側的把手共不共線 */
    out.push({ x: ax(i), y: ay(i), corner: isPenCorner(hi, ho, i) });

    const c1x = ax(i) + g(ho, i, 0), c1y = ay(i) + g(ho, i, 1);
    const c2x = ax(j) + g(hi, j, 0), c2y = ay(j) + g(hi, j, 1);
    /** 兩邊都沒有把手 ＝ 直線，⛔ 不必細分 */
    if (c1x === ax(i) && c1y === ay(i) && c2x === ax(j) && c2y === ay(j)) continue;

    const seg = flattenCubic(ax(i), ay(i), c1x, c1y, c2x, c2y, ax(j), ay(j), tol);
    /**
     * ⚠ `flattenCubic()` **會把終點也放進來**，而終點是下一個錨點 ——
     * ⛔ 不去掉的話每個錨點都會出現兩次。
     */
    for (let k = 0; k < seg.length - 1; k++) {
      out.push({ x: seg[k].x, y: seg[k].y, corner: false });
    }
  }
  /** 開放路徑要補最後一個錨點（封閉的那一個由 `i` 繞回去時放） */
  if (path && path.closed === false) {
    out.push({ x: ax(n - 1), y: ay(n - 1), corner: isPenCorner(hi, ho, n - 1) });
  }
  return out;
}

/**
 * 這個錨點是不是**尖角**：兩側的把手⛔ 不共線就是。
 *
 * ⚠ **判準⛔ 不是「有沒有把手」** —— 一邊有一邊沒有也是尖角
 * （那正是 Illustrator 從曲線接直線時的樣子）。
 * ⭐ 平滑的定義：兩根把手**同一條線、方向相反**（叉積 ≈ 0 且內積 < 0）。
 */
function isPenCorner(hi, ho, i) {
  const ix = +(hi[i * 2] || 0), iy = +(hi[i * 2 + 1] || 0);
  const ox = +(ho[i * 2] || 0), oy = +(ho[i * 2 + 1] || 0);
  const li = Math.hypot(ix, iy), lo = Math.hypot(ox, oy);
  if (li < 1e-9 || lo < 1e-9) return true;          // 有一邊沒有把手
  const cross = Math.abs(ix * oy - iy * ox) / (li * lo);
  const dot = (ix * ox + iy * oy) / (li * lo);
  /** 0.5 度換算成 sin ≈ 0.0087。跟 `SIMILAR_NORMAL_TOL_DEG` 同一個尺度 */
  return !(cross < 0.0087 && dot < 0);
}

/**
 * 真轉角的索引清單。
 * **這個一定要跟著座標一起存。** 少了它，檔案重開之後展開圖就會從
 * 「9 道折線、10 段」變回「196 道折彎」——而且座標完全正確，
 * 看不出哪裡不對，只覺得圖突然變得讀不懂了。
 */
export function cornerIdx(pts) {
  const out = [];
  pts.forEach((p, i) => { if (p.corner) out.push(i); });
  return out;
}

/**
 * 一個擠出形狀的外框與中心（只看外輪廓 —— 內孔本來就在裡面）。
 * 形狀是扁平陣列 { out:[x,y,…], holes:[[x,y,…],…] }。
 */
export function shapeBounds(shape) {
  const a = (shape && shape.out) || [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i + 1 < a.length; i += 2) {
    if (a[i] < minX) minX = a[i];
    if (a[i] > maxX) maxX = a[i];
    if (a[i + 1] < minY) minY = a[i + 1];
    if (a[i + 1] > maxY) maxY = a[i + 1];
  }
  if (minX > maxX) return { minX: 0, minY: 0, maxX: 0, maxY: 0, cx: 0, cy: 0 };
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/** 一組形狀合起來的外框與中心 */
export function shapesBounds(shapes) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes || []) {
    const b = shapeBounds(s);
    if (!(b.maxX > b.minX || b.maxY > b.minY)) continue;
    minX = Math.min(minX, b.minX); minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX); maxY = Math.max(maxY, b.maxY);
  }
  if (minX > maxX) return { minX: 0, minY: 0, maxX: 0, maxY: 0, cx: 0, cy: 0 };
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/**
 * 把一個形狀平移，回傳新的（不改原本的）。
 *
 * ── 為什麼要有這個 ──────────────────────────────────
 * 置中一定要做在**幾何**上，不能靠搬動物件去抵銷。
 * 搬物件的話畫面上看起來是對的，但物件的**原點**跑到很遠的地方 ——
 * 而 gizmo 長在原點上，旋轉與縮放也都繞著原點轉。
 * 那正是 `core/align.js` 開頭警告過的事：
 * **`pos` 是原點，不是物件的位置。** 2026-08-22 匯入線稿時實際踩到。
 */
export function shiftShape(shape, dx, dy) {
  const move = arr => {
    const out = [];
    for (let i = 0; i + 1 < arr.length; i += 2) {
      out.push(r4(arr[i] + dx), r4(arr[i + 1] + dy));
    }
    return out;
  };
  return {
    ...shape,
    out: move(shape.out || []),
    holes: (shape.holes || []).map(move)
  };
}

const r4 = v => Math.round(v * 1e4) / 1e4;

// ═══════════════════════════════════════════════════════

/** three.js 幾何體 → 半邊網格。所有基本體的共同出口。 */
function toMesh(geometry) {
  const m = Mesh.fromGeometry(geometry);
  geometry.dispose();
  m.autoMarkFolds();        // 稜線先標成折線，之後由材料規則覆蓋
  return m;
}

const num = (v, dflt) => (Number.isFinite(+v) ? +v : dflt);
const int = (v, dflt, min = 3) => Math.max(min, Math.round(num(v, dflt)));

const BUILDERS = {
  /**
   * 從 SVG 匯入的輪廓擠出來的東西。
   *
   * ── 為什麼在 BUILDERS 裡，卻不在 PRIM_DEFAULTS 裡 ────────
   * `PRIM_TYPES`（＝ 新增下拉選單）是由 `PRIM_DEFAULTS` 的鍵產生的。
   * 擠出件**沒辦法從零生成** —— 它一定要有一份輪廓，而輪廓來自檔案。
   * 放進 BUILDERS 讓 `buildSrc()` 認得它（存讀檔、布林、陣列因此自動支援），
   * 但不放進 PRIM_DEFAULTS，選單裡就不會出現一個按了會壞的項目。
   *
   * 輪廓存成**扁平陣列**（[x,y,x,y,…]）而不是 {x,y} 物件：
   * 描一張圖動輒幾千個點，扁平陣列的檔案小一半以上，
   * 而且照樣看得懂。這仍然是「存參數，不存三角形」——
   * 改高度不必重新匯入，改完重新生成就好。
   */
  /**
   * 🔴 **內建鋼筆畫出來的東西。**（kang 2026-08-27 決定要做，⛔ 畫在地板上）
   *
   * ── ⭐ 擠出那一半 **一行新的數學都沒有** ────────────────
   * 這一支只做一件事：**把錨點與把手拉直成點串**，
   * 之後原封不動走 `extrude` 已經在用的 `pairs()` → `extrudeMany()`。
   * 〔kang 2026-08-25 批准的框架的又一例：**新功能 ＝ 既有零件換個組合**〕
   *
   * ── 🔴 為什麼是新的來源型別，⛔ 不是塞進 `extrude` ──────────
   * **`extrude` 存的是拉直之後的折線** —— SVG 匯進來時
   * `flattenCubic()` 就把曲線拉掉了，**曲線的資訊已經沒了，回不去**。
   * 而 kang 2026-08-29 拍板「**要能回頭拉點、拉把手**」，
   * 所以一定要**存錨點與把手本身**，生成時才拉直。
   *
   * ⚠ **⛔ 不可以「兩份都存」**（在 `extrude` 上多掛一份曲線）——
   * 那會變成兩條要對齊的路（坑第 31 條）。
   * ⭐ 而分成兩個型別完全符合「**存參數，不存三角形**」：
   * 改一個錨點就重新生成，跟改方塊的寬度是同一條路。
   *
   * ── 資料長怎樣 ────────────────────────────────────────
   * ```
   * { type:'pen', h:3, tol:0.2, paths:[
   *     { closed:true,
   *       a:  [x,y, x,y, …],    錨點
   *       hi: [dx,dy, dx,dy, …], 進來的把手（相對錨點）
   *       ho: [dx,dy, dx,dy, …]  出去的把手（相對錨點）
   *     } ] }
   * ```
   *
   * ⭐ **把手存「相對錨點的位移」，⛔ 不存絕對座標** ——
   * 這樣**拖錨點時把手自動跟著走**（第 2 階段會需要）。
   * ⭐ **扁平陣列**：理由跟 `extrude` 那一則一樣（檔案小一半，照樣看得懂）。
   * ⭐ **兩邊把手都是 (0,0) ＝ 尖角** —— ⛔ 不必另外存一個旗標。
   *
   * ── 🔴 哪些錨點算「真轉角」 ────────────────────────────
   * **兩側把手⛔ 不共線就是轉角**（含「兩邊都沒有把手」）——
   * 那正好就是使用者按「尖角」折斷把手的意思。
   * ⚠ **拉直過程中間長出來的點⛔ 全部不是轉角** —— 它們在曲線上。
   * 〔`oc` 這一欄是展開圖判折線用的，⛔ 不是裝飾〕
   *
   * ── ⚠ 第 1 階段⛔ 不做「洞」 ───────────────────────────
   * 一條路徑 ＝ 一個形狀。`extrude` 的 `holes` 欄位留著沒用，
   * 日後要做洞時**⛔ 不必改資料格式**，只要決定哪一條包住哪一條。
   *
   * ⚠ **⛔ 不放進 `PRIM_DEFAULTS`** —— 理由跟 `extrude` 完全一樣：
   * 它沒辦法從零生成（要有人先畫），放進選單就是一個按了會壞的項目。
   */
  pen(p) {
    const tol = num(p.tol, DEFAULT_TOL);
    const shapes = (p.paths || [])
      .map(path => ({ pts: flattenPenPath(path, tol) }))
      .filter(s => s.pts.length >= 3);
    if (!shapes.length) throw new Error('這支鋼筆還沒有畫出任何封閉的形狀');
    return extrudeMany(shapes, num(p.h, 3));
  },

  extrude(p) {
    const shapes = (p.shapes || []).map(s => ({
      pts: pairs(s.out, s.oc),
      holes: (s.holes || []).map((h, i) => ({ pts: pairs(h, (s.hc || [])[i]) }))
    })).filter(s => s.pts.length >= 3);
    if (!shapes.length) throw new Error('這個擠出件沒有輪廓資料');
    return extrudeMany(shapes, num(p.h, 3));
  },

  box(p) {
    const d = PRIM_DEFAULTS.box;
    return toMesh(new THREE.BoxGeometry(
      num(p.w, d.w), num(p.h, d.h), num(p.d, d.d)
    ));
  },

  cylinder(p) {
    const d = PRIM_DEFAULTS.cylinder;
    const r = num(p.r, d.r);
    return toMesh(new THREE.CylinderGeometry(
      r, r, num(p.h, d.h), int(p.seg, d.seg), 1, !!p.openEnded
    ));
  },

  cone(p) {
    const d = PRIM_DEFAULTS.cone;
    // 半徑 0 會產生退化三角形，給一個極小值讓拓撲保持乾淨
    const rt = Math.max(num(p.rTop, d.rTop), 1e-4);
    const rb = Math.max(num(p.rBottom, d.rBottom), 1e-4);
    return toMesh(new THREE.CylinderGeometry(
      rt, rb, num(p.h, d.h), int(p.seg, d.seg), 1, !!p.openEnded
    ));
  },

  sphere(p) {
    const d = PRIM_DEFAULTS.sphere;
    return toMesh(new THREE.SphereGeometry(
      num(p.r, d.r), int(p.segW, d.segW), int(p.segH, d.segH, 2)
    ));
  },

  /** 角柱 ＝ 分段數很少的圓柱。六角柱、八角柱在鈑金件很常見。 */
  prism(p) {
    const d = PRIM_DEFAULTS.prism;
    const r = num(p.r, d.r);
    return toMesh(new THREE.CylinderGeometry(
      r, r, num(p.h, d.h), int(p.sides, d.sides), 1, false
    ));
  },

  /** 平板 ＝ 開放的單面，沒有厚度。板件（sheet）的預設起點。 */
  plate(p) {
    const d = PRIM_DEFAULTS.plate;
    const g = new THREE.PlaneGeometry(
      num(p.w, d.w), num(p.d, d.d),
      int(p.segW, d.segW, 1), int(p.segD, d.segD, 1)
    );
    g.rotateX(-Math.PI / 2);        // 讓它平躺在地面上，而不是站著
    return toMesh(g);
  },

  /**
   * 管（中空圓柱）。
   *
   * three.js 沒有現成的中空圓柱，自己接半邊結構反而更乾淨 ——
   * 不必經過三角形再焊回來，側面直接就是四邊形。
   *
   * 這個基本體還有一個附加用途：**交叉驗證布林**。
   * 參數直接算出來的體積，應該跟「大圓柱減小圓柱」布林出來的
   * 完全一致，對不上就代表其中一邊有問題。
   */
  tube(p) {
    const D = PRIM_DEFAULTS.tube;
    const ro = num(p.rOuter, D.rOuter);
    const ri = Math.max(0, Math.min(num(p.rInner, D.rInner), ro - 1e-4));
    const h = num(p.h, D.h);
    const n = int(p.seg, D.seg);

    // 內徑等於 0 就退化成實心圓柱，交給角柱那條路走
    if (ri < 1e-6) return BUILDERS.prism({ sides: n, r: ro, h });

    const y0 = -h / 2, y1 = h / 2;
    const pts = [];
    for (const [r, y] of [[ro, y1], [ro, y0], [ri, y1], [ri, y0]]) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
      }
    }
    const OT = 0, OB = n, IT = 2 * n, IB = 3 * n;   // 外上／外下／內上／內下

    const faces = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push([OT + i, OT + j, OB + j, OB + i]);   // 外側面
      faces.push([IT + j, IT + i, IB + i, IB + j]);   // 內側面（法向朝軸心）
      faces.push([OT + j, OT + i, IT + i, IT + j]);   // 頂部環
      faces.push([OB + i, OB + j, IB + j, IB + i]);   // 底部環
    }

    const m = Mesh.fromFaceList(pts, faces);
    m.autoMarkFolds();
    return m;
  },

  /**
   * 圓角方塊 ＝ 圓角矩形的斷面沿 Y 擠出。
   *
   * 只在四條垂直邊倒圓角，不做角落的球面。護罩、機櫃、機箱外觀
   * 幾乎都是這種形狀，而且**圓角是可展的圓柱面** ——
   * 第 3 期展開時可以精確攤平，是很好的驗證題材。
   */
  roundBox(p) {
    const D = PRIM_DEFAULTS.roundBox;
    const w = num(p.w, D.w), h = num(p.h, D.h), d = num(p.d, D.d);
    const segR = int(p.segR, D.segR, 1);
    // 圓角不能大於半個短邊，否則輪廓會自交
    const r = Math.max(0, Math.min(num(p.r, D.r), Math.min(w, d) / 2 - 1e-6));

    return extrudeProfile(roundRectProfile(w, d, r, segR), h);
  },

  /**
   * 折板 —— 第 3 期鈑金展開的主角。
   *
   * ── 為什麼做成「序列」而不是寫死 L 型／U 型 ────────
   * 實際的鈑金件常常折三、四道。寫死只能做兩種形狀，
   * 序列則是同一套邏輯涵蓋全部：
   *   L 型 ＝ 一道折彎
   *   U 型 ＝ 兩道同向折彎
   *   Z 型 ＝ 兩道反向折彎（角度一正一負）
   * 而且第 3 期展開讀的就是這個序列，不必再反推。
   *
   * ── 這是開放的面，不是實體 ──────────────────────────
   * 日誌第 3 個關鍵決定：板件用「面 ＋ 厚度屬性」描述。
   * 這裡產生的是**中性面**，厚度是 ModelObject 的屬性，
   * 畫面上的厚度由 mesh.shell() 在顯示時加上去。
   * 折彎半徑 r 指的也是中性面的半徑。
   *
   * ── 折線會自動標出來 ────────────────────────────────
   * 圓弧被分成 arcSeg 段，段與段之間不共面，
   * autoMarkFolds() 會把它們標成折線（fold）。
   * 這是半邊結構的「邊角色」欄位第一次真正派上用場。
   */
  bend(p, t = 0) {
    const D = PRIM_DEFAULTS.bend;
    const w = num(p.w, D.w);
    const first = num(p.first, D.first);
    // 下限 2：切一段的圓弧在網格上跟倒角完全一樣，展開時認不出來。
    // 這不是保守，是資訊真的不存在（見 unfold/flatten.js 檔頭）。
    const arcSeg = int(p.arcSeg, D.arcSeg, 2);
    const k = num(p.k, D.k);
    const bends = Array.isArray(p.bends) && p.bends.length ? p.bends : D.bends;

    // ── 先在 XY 平面走出斷面折線 ──
    let x = 0, y = 0;          // 目前位置
    let dx = 1, dy = 0;        // 目前方向
    const line = [[x, y]];

    const advance = len => {
      x += dx * len; y += dy * len;
      line.push([x, y]);
    };

    advance(first);

    for (const b of bends) {
      const deg = num(b && b.angle, 90);
      const rad = THREE.MathUtils.degToRad(deg);
      // 面上畫的是中性面，所以用中性層半徑；使用者填的是內側 R
      const r = neutralRadius(b && b.ri, k, t);
      const len = Math.max(0, num(b && b.len, 0));

      if (r > 1e-9 && Math.abs(rad) > 1e-9) {
        // 圓心在垂直於行進方向、朝轉彎那一側，距離 r
        const s = Math.sign(rad);
        const cx = x - dy * r * s;
        const cy = y + dx * r * s;
        const a0 = Math.atan2(y - cy, x - cx);

        for (let k = 1; k <= arcSeg; k++) {
          const a = a0 + (rad / arcSeg) * k;
          x = cx + Math.cos(a) * r;
          y = cy + Math.sin(a) * r;
          line.push([x, y]);
        }
      }

      // 轉向（半徑 0 就是尖角折）
      const c = Math.cos(rad), sn = Math.sin(rad);
      const ndx = dx * c - dy * sn;
      const ndy = dx * sn + dy * c;
      dx = ndx; dy = ndy;

      if (len > 0) advance(len);
    }

    // ── 沿 Z 擠成面（中性面，沒有厚度）──
    const pts = [];
    for (const [px, py] of line) pts.push(new THREE.Vector3(px, py, -w / 2));
    for (const [px, py] of line) pts.push(new THREE.Vector3(px, py, w / 2));

    const n = line.length;
    const faces = [];
    for (let i = 0; i < n - 1; i++) {
      faces.push([i, i + 1, i + 1 + n, i + n]);
    }

    const m = Mesh.fromFaceList(pts, faces);
    m.autoMarkFolds();
    return m;
  }
};

// ═══════════════════════════════════════════════════════
//  斷面工具
// ═══════════════════════════════════════════════════════

/**
 * 圓角矩形的輪廓點（在 XZ 平面，繞著中心一圈）。
 * r ＝ 0 就退化成四個直角。
 */
function roundRectProfile(w, d, r, segR) {
  const hw = w / 2, hd = d / 2;
  if (r < 1e-9) {
    return [[hw, hd], [-hw, hd], [-hw, -hd], [hw, -hd]];
  }

  const out = [];
  // 四個圓角的圓心與起始角度（角度以 (x, z) 為準）
  const corners = [
    [hw - r, hd - r, 0],
    [-hw + r, hd - r, 90],
    [-hw + r, -hd + r, 180],
    [hw - r, -hd + r, 270]
  ];

  for (const [cx, cz, a0] of corners) {
    for (let k = 0; k <= segR; k++) {
      const a = THREE.MathUtils.degToRad(a0 + (90 / segR) * k);
      out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
  }
  return out;
}

/**
 * 把一個閉合的 XZ 斷面沿 Y 擠出，做成封閉實體。
 * 頂面與底面各留成一整片多邊形（不切成三角形），
 * 這樣平面區域合併之後看起來才乾淨。
 */
function extrudeProfile(profile, h) {
  const n = profile.length;
  const y0 = -h / 2, y1 = h / 2;

  const pts = [];
  for (const [px, pz] of profile) pts.push(new THREE.Vector3(px, y1, pz));
  for (const [px, pz] of profile) pts.push(new THREE.Vector3(px, y0, pz));

  const faces = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([i, j, j + n, i + n]);           // 側面
  }
  faces.push([...Array(n).keys()].reverse());     // 頂面
  faces.push([...Array(n).keys()].map(i => i + n));   // 底面

  const m = Mesh.fromFaceList(pts, faces);
  m.autoMarkFolds();
  return m;
}

/**
 * 依參數生成網格。
 * @param {string} type PRIM_DEFAULTS 裡的鍵
 * @param {object} params
 * @returns {Mesh}
 */
export function buildPrim(type, params = {}, thickness = 0) {
  const fn = BUILDERS[type];
  if (!fn) throw new Error(`不認得的基本體類型：${type}`);
  return fn(params, thickness);
}

/** 產生一組帶預設值的參數（含 type，可直接當 src 用） */
export function defaultSrc(type) {
  if (!PRIM_DEFAULTS[type]) throw new Error(`不認得的基本體類型：${type}`);
  // 深拷貝：折板的 bends 是陣列，淺拷貝會讓所有折板共用同一份
  return JSON.parse(JSON.stringify({ type, ...PRIM_DEFAULTS[type] }));
}

/** 折板預設的一道折彎，介面按「加一道」時用 */
export function defaultBend() {
  return { angle: 90, ri: 2, len: 30 };
}

/**
 * 一道折彎的展開長（bend allowance），單位 cm。
 *
 *     BA = θ × (ri + K × t)
 *
 * 這就是鈑金教科書的公式，也是第 3 期出圖與 DXF 用的數字。
 * 半徑 0（尖角折）時 BA ＝ 0。
 */
export function bendAllowance(b, k, t) {
  const rad = Math.abs(THREE.MathUtils.degToRad(num(b && b.angle, 90)));
  return neutralRadius(b && b.ri, k, t) * rad;
}

/**
 * 折板的展開總長（沿中性層量），單位 cm。
 *
 * ── 一定要用真正的弧長 ──────────────────────────────
 * 圓弧在網格上被切成 arcSeg 段直線，**弦長比弧長短**。
 * arcSeg=4、90 度彎時，弦長總和只有弧長的 99.4%。
 * 拿網格去量展開長度，每道折彎都會少算一點，
 * 折三道就差到零點幾公分 —— 雷切下去才發現就來不及了。
 *
 * 所以展開長度一律用 θ × rn 算（rn 見 neutralRadius）。
 * 這個函式是展開長度的**唯一權威來源**：
 * unfold/flatten.js 從網格辨識出來的結果會拿它對答案，
 * 對不上就表示辨識錯了。
 *
 * @param {object} p 折板參數
 * @param {number} t 板厚 cm
 */
export function bendDevelopedLength(p, t = 0) {
  const D = PRIM_DEFAULTS.bend;
  const bends = Array.isArray(p.bends) && p.bends.length ? p.bends : D.bends;
  const k = num(p.k, D.k);
  let len = num(p.first, D.first);

  for (const b of bends) {
    len += bendAllowance(b, k, t) + Math.max(0, num(b && b.len, 0));
  }
  return len;
}

export const PRIM_TYPES = Object.keys(PRIM_DEFAULTS);
