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
import { flattenCubic, splitCubic, cubicAt, nearestOnCubic, polyArea, DEFAULT_TOL }
  from '../sketch/svgPath.js';
/**
 * 🔴 **判「哪一圈是洞」跟匯入線稿走同一支**（2026-08-30）——
 * ⛔ 不在這裡重寫一份。⭐ 相依單向，`profile.js` 沒有 import 回來。
 */
import { classify } from '../sketch/profile.js';
/**
 * 🔴 **開放的線走不了 `extrudeMany()`**（那要封閉輪廓）——
 * `不封口` 的鋼筆走的是「沿線掃出一片單層的帶」那一支（2026-08-31）。
 */
import { ribbonFromPaths } from './ribbon.js';
/**
 * ⭐ **圓環與半球走旋轉成形那一支**（2026-10-08）：一條輪廓繞 Y 轉一圈。
 * 極點只放一個頂點、封閉輪廓轉成環、平滑邊、繞向 —— 那一支都量過了，⛔ 不在這裡重寫。
 */
import { revolve } from './revolve.js';

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
    bends: [{ angle: 90, ri: 2, len: 30 }],  // 一道折彎 ＝ L 型
    anchorSeg: 1     // ④-19：原點在第幾段的起點（1 ＝ 第一段，跟以前一樣）
  },
  // ── 2026-10-08 加的四種（kang 看過互動圖、拍板）──
  torus:    { rOuter: 30, rInner: 15, seg: 32, segT: 12 },
  wedge:    { w: 60, h: 30, d: 40 },
  dome:     { r: 30, seg: 32, segH: 8 },
  stairs:   { steps: 4, stepH: 15, stepD: 25, w: 60 },
  // 齒輪（2026-10-08 第二輪，kang：真的要能轉、預設照建議）。單位 cm，只有 gapMm 是 mm
  gear:     { module: 0.3, teeth: 20, t: 0.5, hole: 0.6, gapMm: 0.2 }
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
  /**
   * 🔴 **鋼筆畫出來的東西**（2026-08-30 補；⚠ **這一格原本漏了**）。
   *
   * 〔kang 2026-08-30 問出來的：「進入編輯時...是不能編輯的」〕
   * ⛔ **病因**：`toolbar.js` 是「**去 `PRIM_SPECS` 查得到才顯示東西**」，
   * 而 `pen` **不在這裡** → 鋼筆物件的右側面板**什麼都沒有** ——
   * 既改不了厚度，也**沒有「轉成可編輯網格」那顆**。
   * 🔴 **而 `extrude`（匯入線稿）有** —— 兩個走同一條路的功能行為不一致，
   * 那正是他感覺得出來的地方。
   *
   * ⚠ **⛔ 加在這裡不會讓它跑進「新增」下拉** ——
   * 下拉是 `PRIM_TYPES`，而那是從 **`PRIM_DEFAULTS`** 產生的。
   * ⭐ `extrude` 就是同樣的情形（在 `PRIM_SPECS`、⛔ 不在下拉）。
   *
   * ⚠ **label 用「高 Y」⛔ 不用「厚度」**：物件面板上已經有一個「**板厚**」
   * （板件用的），再來一個「厚度」會糊在一起。⭐ 而「高 Y」跟 `extrude` 一致。
   */
  pen: {
    label: '鋼筆',
    fields: [
      { key: 'h', label: '高 Y', min: 0.05, step: 0.5,
        /** ⚠ 旋轉成形開著時這個數字⛔ 沒有用到 ⇒ 不顯示〔鐵律三〕 */
        when: src => !src || !src.rev,
        /**
         * 🔴 **同一個數字，三種意思 —— 標籤跟著換**
         * （kang 2026-08-30 拍板：**共用一個欄位**，2026-08-31 實作）。
         * ⚠ **⛔ 不要為了「說得清楚」拆成三個欄位** —— 那會有兩個
         * 在任何時候都是沒有意義的數字，而它們還看得到、改得動
         * 〔鐵律三：這個數字在這個狀態下有沒有意義〕。
         */
        /** 🔴 乙 第 2 輪：立在牆上（`ctx.wall`，由 `toolbar.js` 問 `io.js` `penWallSide()`）⇒ 本地的「上」是往外 */
        labelOf: (src, ctx) => (ctx && ctx.wall)
          ? ((!src || !src.open) ? '厚度' : (src.up ? '伸出' : '寬度'))
          : ((!src || !src.open) ? '高 Y' : (src.up ? '高度' : '寬度')),
        hintOf: (src, ctx) => (ctx && ctx.wall)
          ? ((!src || !src.open)
              ? '這塊畫在牆上（或物件的面上），這個數字是它往外長多厚（公分）'
              : (src.up
                  ? '這條線畫在牆上，沿著線往外伸出多遠（公分）。⚠ 厚薄在上面的「板厚」'
                  : '這片板沿著線往兩側各長一半，總共這麼寬（公分）。⚠ 厚薄在上面的「板厚」'))
          : (!src || !src.open)
          ? '往上拉多高（公分）—— 就是畫的時候工具列上那個「厚度」。'
            + '⭐ 這個數字隨時改得了，不像「轉成可編輯網格」是不可逆的'
          : (src.up
              ? '這道牆從地面往上長多高（公分）。'
                + '⚠ 牆的厚薄不在這裡 —— 那是上面的「板厚」'
              : '這片板沿著線往兩側各長一半，總共這麼寬（公分）。'
                + '⚠ 板的厚薄不在這裡 —— 那是上面的「板厚」'),
        hint: '往上拉多高（公分）—— 就是畫的時候工具列上那個「厚度」。'
            + '⭐ 這個數字隨時改得了，不像「轉成可編輯網格」是不可逆的' }
    ],
    /**
     * 🔴🔴 **兩顆開關（kang 2026-08-30 拍板；他要求工具列與右側面板【都要有】）。**
     *
     * ⚠ **`up` 只在 `open` 開著時才出現** —— 封起來的形狀沒有「往不往上長」
     * 這回事，擺在那裡就是一個按了什麼都不會變的東西（坑第 21 條）。
     *
     * 🔴 **改 `open` 會連動物件的「種類」**（solid ⇄ sheet）——
     * 那一段在 `toolbar.js`，⛔ 不在這裡：`prim.js` 不認識 `ModelObject`。
     */
    toggles: [
      { key: 'open', label: '不封口',
        hint: '關（預設）＝ 頭尾接起來、圍成形狀，往上擠成實心塊。'
            + '開 ＝ 就是一條線，拿去做板或牆 —— '
            + '厚薄改走上面的「板厚」，種類會自動變成板件' },
      { key: 'up', label: '往上長', when: src => !!src && !!src.open && !src.rev,
        /** 🔴 乙 第 2 輪：立在牆上時「上」其實是往外 */
        labelOf: (src, ctx) => (ctx && ctx.wall) ? '往外長' : '往上長',
        hint: '開 ＝ 沿著線立成一道牆（數字是高度）。'
            + '關 ＝ 沿著線加厚成一片板平躺在地上（數字是寬度，兩側各一半）',
        hintOf: (src, ctx) => (ctx && ctx.wall)
          ? '開 ＝ 沿著線往外伸出一片（數字是伸出多遠）。關 ＝ 沿著線在牆上加寬成一條帶子（數字是寬度）'
          : '開 ＝ 沿著線立成一道牆（數字是高度）。'
            + '關 ＝ 沿著線加厚成一片板平躺在地上（數字是寬度，兩側各一半）' }
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
    ],
    noteOf: src => innerTooBig(src, PRIM_DEFAULTS.tube, '管壁')
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
            + '下料長度就是照這個算出來的' },
      /** ④-19 剩下的（2026-10-20）：原點放在第幾段的起點（`bendProfile()`）；改它時面板會把位置補回來，板子⛔ 跳 */
      { key: 'anchorSeg', label: '原點在第幾段', min: 1, step: 1, int: true,
        hint: '原點（位置欄的那一點）放在第幾段直線的起點：1 ＝ 第一段（原本的），2 ＝ 第一道折彎之後那一段…。'
            + '例如要讓牆（第 2 段）剛好在 X −3.33，就選 2、位置 X 打 −3.33。改這格時板子不會動，只換原點' }
    ],
    hasBends: true
  },
  /**
   * 🔴 **圓環用「外半徑＋內半徑」**（kang 2026-10-08 拍板）——
   * 拿尺量得到，跟「管」同一種填法；⛔ 不用 Blender 的「環半徑＋管半徑」。
   */
  torus: {
    label: '圓環',
    fields: [
      { key: 'rOuter', label: '外半徑',     min: 0.1, step: 1 },
      { key: 'rInner', label: '內半徑',     min: 0.1, step: 1,
        hint: '一定要比外半徑小。管粗 ＝ 外半徑 − 內半徑' },
      { key: 'seg',    label: '繞一圈分段', min: 3, max: 128, step: 1, int: true },
      { key: 'segT',   label: '管分段',     min: 3, max: 64,  step: 1, int: true }
    ],
    noteOf: src => innerTooBig(src, PRIM_DEFAULTS.torus, '環')
  },
  /** 楔形：後面（−Z）高、前面（+Z）低。要換方向用旋轉（kang 2026-10-08 同意） */
  wedge: {
    label: '楔形',
    fields: [
      { key: 'w', label: '寬 X', min: 0.1, step: 1 },
      { key: 'h', label: '高 Y', min: 0.1, step: 1 },
      { key: 'd', label: '深 Z', min: 0.1, step: 1 }
    ]
  },
  /**
   * 🔴 **半球只做實心、底是平的**（kang 2026-10-08 拍板）。
   * 要空心殼 ＝ 大半球減小半球（布林），⛔ 不另開「厚度」欄。
   */
  dome: {
    label: '半球',
    fields: [
      { key: 'r',    label: '半徑',       min: 0.1, step: 1 },
      { key: 'seg',  label: '繞一圈分段', min: 3, max: 128, step: 1, int: true },
      { key: 'segH', label: '高度分段',   min: 1, max: 64,  step: 1, int: true }
    ]
  },
  /**
   * 🔴 **階梯下面實心填到地**（kang 2026-10-08 拍板），側面是一階一階的鋸齒。
   * 前面（+Z）低、後面（−Z）高，跟楔形同一個方向。
   */
  stairs: {
    label: '階梯',
    fields: [
      { key: 'steps', label: '階數',   min: 1, max: 100, step: 1, int: true },
      { key: 'stepH', label: '每階高', min: 0.1, step: 1 },
      { key: 'stepD', label: '每階深', min: 0.1, step: 1 },
      { key: 'w',     label: '寬',     min: 0.1, step: 1 }
    ]
  },
  /**
   * 🔴 **齒輪：真的要能轉**（kang 2026-10-08）——標準漸開線齒形、壓力角固定 20°。
   * ⭐ kang：「我只要知道要如何使用為主」⇒ 專業的部分寫成**看得到的用法**（`noteOf`），
   * ⚠ ⛔ 不只寫在 `hint`：那是滑鼠移上去才出現的提示，**平板上看不到**。
   * ⚠ 雷射切的檔案走「剖面分切」，⛔ 不走展開圖 —— 展開圖遇到中間有洞的平板，
   * 會從外圈到孔畫一條切開線（`out/sheet.js` 檔頭「環形片沒有 holes 資料」那則）。
   */
  gear: {
    label: '齒輪',
    fields: [
      { key: 'module', label: '模數（齒的大小）', min: 0.05, step: 0.05,
        hint: '要互相咬合的齒輪，這一格一定要填一樣' },
      { key: 'teeth',  label: '齒數',       min: 8, max: 300, step: 1, int: true,
        hint: '齒輪大小 ＝ 模數 × 齒數。少於 17 齒的齒根比較薄、比較容易斷' },
      { key: 't',      label: '厚度',       min: 0.05, step: 0.1,
        hint: '填板子的厚度' },
      { key: 'hole',   label: '中心孔直徑', min: 0, step: 0.1,
        hint: '套軸或木棒用。0 ＝ 沒有孔' },
      { key: 'gapMm',  label: '間隙 mm',    min: 0, max: 2, step: 0.05,
        hint: '齒和齒之間留的空隙。雷射切木頭建議 0.1～0.2；轉不動就加大，晃太多就減小' }
    ],
    noteOf: (src, obj) => gearNotes(src, obj)
  }
};

/**
 * 🔴 **內半徑填得不比外半徑小 ⇒ 說出來**（2026-10-09，kang 實測新增形狀時發現）。
 * 管與圓環都會**默默夾到外半徑以內**（做得出來、⛔ 不會壞），但做出來的是薄到看不見的東西，
 * 而格子上還寫著填的數字 —— 兩個數字對不上又⛔ 沒有任何提示（鐵律三：讓兩個數字對得起來）。
 * ⭐ 跟齒輪「中心孔太大」同一個做法：照樣做、**在面板上講出來**。
 */
function innerTooBig(src, D, what) {
  const ro = Number.isFinite(+src.rOuter) ? +src.rOuter : D.rOuter;
  const ri = Number.isFinite(+src.rInner) ? +src.rInner : D.rInner;
  if (ri < ro) return [];
  return [`⚠ 內半徑（${ri}）不比外半徑（${ro}）小 —— ${what}薄到幾乎看不見。把內半徑改得比外半徑小`];
}

/**
 * 齒輪的尺寸（給面板的說明與測試用；`BUILDERS.gear` 也從這裡拿，⛔ 不各算一份）。
 * 分度圓 ＝ 兩個齒輪咬合時「滾在一起」的那個圓；中心距 ＝ 兩個分度圓半徑相加。
 */
export function gearDims(p) {
  const D = PRIM_DEFAULTS.gear;
  const m = Math.max(num(p.module, D.module), 1e-3);
  const z = int(p.teeth, D.teeth, 8);
  const r = m * z / 2;
  const rf = r - 1.25 * m;                 // 齒根圓
  const holeWant = Math.max(0, num(p.hole, D.hole)) / 2;
  const holeMax = rf * 0.8;                // 孔太大會吃到齒根 —— 夾住，⛔ 而且說出來
  return {
    m, z, r, rf, ra: r + m, rb: r * Math.cos(GEAR_PA),
    t: Math.max(num(p.t, D.t), 1e-3),
    gap: Math.max(0, num(p.gapMm, D.gapMm)) / 10,     // mm → cm
    holeR: Math.min(holeWant, holeMax),
    holeClamped: holeWant > holeMax
  };
}

/** 齒輪外形的一圈點 [{x, y}]（躺在地上的 x、z）。⭐ 測試拿它驗「兩個齒輪咬合會不會卡住」 */
export function gearProfile(p) {
  return gearOutline(gearDims(p)).map(([rho, a]) => ({ x: rho * Math.cos(a), y: rho * Math.sin(a) }));
}

/**
 * 面板上**看得到**的用法說明（一句一行）。數字一律照這個齒輪自己的格子算。
 * `obj` 是物件本身（拿它的縮放）；巢狀裡面傳的是外層那個物件。
 */
function gearNotes(src, obj) {
  const g = gearDims(src);
  const f = v => +v.toFixed(2);
  const out = [
    `大小：分度圓直徑 ＝ 模數 × 齒數 ＝ ${f(g.r * 2)} cm，最外圈直徑 ${f(g.ra * 2)} cm`,
    // kang 2026-10-08 實測時用縮放把齒輪放大 5 倍 —— 中心距與厚度就都對不上格子了
    '要變大變小：改「模數」（例：0.3 改成 0.6 就是兩倍大）。不要用縮放 —— 會跟別的齒輪咬不上，厚度也會跟著變',
    `要跟另一個齒輪咬合：兩個的「模數」填一樣，中心距離 ＝ 模數 × (這個的齒數 ＋ 對方的齒數) ÷ 2`
      /** ⚠ 2026-10-19（實驗 T9：`實驗-綜合評估.md` ②-9）這個係數⛔ 捨到 2 位：0.125 寫成 0.13 ⇒ 照抄算中心距差 0.3 cm（後面還要乘齒數）*/
      + ` ＝ ${+(g.m / 2).toFixed(6)} × (${g.z} ＋ 對方齒數)`,
    // ⚠ 對方齒數是偶數時，兩個都沒轉 ⇒ 齒尖正對齒尖（測試的咬合就是靠轉這半齒才咬上）
    '擺好之後如果齒尖頂著齒尖：把其中一個繞 Y 轉「180 ÷ 它的齒數」度（半個齒）',
    // ⚠ 格子名稱照 `ui/slicePanel.js` 抄：分段表的「板厚 cm」、上方的「孔徑 cm」
    // ⛔ 展開圖：中間有洞的平板會多一條從孔到外緣的切開線（kang 2026-10-08 實測撞到，截圖 P01、P02）
    // 🔴 「孔徑」要講清楚是剖面分切視窗那一格 —— kang 2026-10-08 照舊說明把【這裡的】中心孔直徑改成 0，孔就不見了
    '雷射切：選這個齒輪按「剖面分切」→ 分段的「板厚」填這個齒輪的厚度、視窗上方的「孔徑」填 0'
      + '（那是定位孔，不是這裡的「中心孔直徑」）→ 存 DXF。不要用展開圖（會從中心孔到外緣多畫一條切開線）',
    // kang 2026-10-08 在 Illustrator 驗過 —— DXF 刻意只寫短線段（out/dxf.js 檔頭「只用 LINE 和 TEXT」），合併交給 Illustrator
    'Illustrator 打開 DXF 後外形是很多段短線：選取切割層的線段 → 物件 → 路徑 → 合併（Ctrl＋J），就變成一條封閉線'
  ];
  const sc = obj && obj.scale;
  if (sc && [sc.x, sc.y, sc.z].some(v => Math.abs(v - 1) > 1e-6)) {
    out.push(`⚠ 這個齒輪被縮放過（${[sc.x, sc.y, sc.z].map(f).join(' × ')} 倍）：`
      + '實際大小、厚度都跟上面的格子對不上，跟別的齒輪也可能咬不上。把縮放改回 1，改用「模數」調大小');
  }
  if (g.z < 17) out.push(`⚠ 齒數 ${g.z} 少於 17：齒根比較薄，比較容易斷`);
  if (g.holeClamped) out.push(`⚠ 中心孔太大會吃到齒根，已經縮成直徑 ${f(g.holeR * 2)} cm`);
  /**
   * ⑥-7（2026-10-21，實驗 T9：`實驗-綜合評估.md`「⑥ 的分批」，kang「同意你的建議」）：孔徑旁邊講一句配合。
   * ⚠ ⛔ 寫建議的間隙數字：小多少跟機器有關（3D 列印、雷射切不一樣），kang 還沒給自己機器的數字 ⇒ 只講方向。
   */
  if (g.holeR > 1e-6) {
    out.push(`套軸：中心孔直徑 ${f(g.holeR * 2)} cm 是孔本身的大小 —— 軸要比孔小一點才插得進去；`
      + '小多少看你的機器（3D 列印、雷射切各不一樣），先做一個試套');
  }
  return out;
}

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
export function penRemoveAnchor(path, i, samples = 24, min = 3) {
  if (!path || !path.a) return { ok: false, reason: '沒有路徑' };
  const n = Math.floor(path.a.length / 2);
  if (!(i >= 0 && i < n)) return { ok: false, reason: '沒有這一個點' };
  /**
   * 🔴 **下限跟著「封不封口」走**（2026-08-31 補）：
   * 封起來要 3 個才圍得出形狀，**不封口 2 個就是一條線**。
   * ⚠ ⛔ 不可以寫死 3 —— 那會讓一條三點的牆刪不回兩點的直牆。
   */
  if (n <= min) {
    return { ok: false, reason: min === 2
      ? '只剩 2 個點了 —— 再刪就不成一條線'
      : '只剩 3 個點了 —— 再刪就圍不出一個形狀' };
  }

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
 * 🔴🔴 **鋼筆轉角圓角**（綜合評估 ④-13 第三件，2026-10-20，kang「照建議」）。
 * 一個尖角 ⇒ 換成一段**跟兩邊直線相切的圓弧**：原本的錨點拿掉，換成圓弧兩端的兩個錨點，
 * 把手長 ＝ 4/3 × tan(轉的角度 ÷ 4) × R（三次貝茲畫圓弧的標準值，90° 時誤差約萬分之三）。
 *
 * kang 定的三件事：**倒一次就定下來**（⛔ 記住半徑；要換就退回去重倒）、
 * **半徑太大就⛔ 倒、講最大值**（⛔ 悄悄縮小）、**只做圓角**（斜角先不做）。
 * ⚠ 這一版**只倒兩邊都是直線的角**（兩側那兩段都沒有把手）；旁邊是曲線就講原因。
 * ⭐ 圓弧的端點剛好落在旁邊的錨點上（例如圓角 ＝ 寬的一半 ⇒ 膠囊形）⇒ 兩個點併成一個，⛔ 留一段長度 0 的線。
 */
const PEN_FILLET_EPS = 1e-6;
const penH = (arr, k) => Math.hypot(+(arr[k * 2] || 0), +(arr[k * 2 + 1] || 0));

/**
 * 這個錨點能不能倒、最大到多少（只看它自己兩邊；`penFilletAll()` 另外算兩個角共用一段的情形）。
 * @returns {{ok:boolean, reason?:string, maxR?:number, t?:number}} `t` ＝ tan(夾角 ÷ 2)
 */
export function penFilletInfo(path, i) {
  const a = (path && path.a) || [];
  const n = Math.floor(a.length / 2);
  if (!Number.isInteger(i) || i < 0 || i >= n) return { ok: false, reason: '先點一個尖角（錨點），再按「倒圓角」' };
  const closed = path.closed !== false;
  if (n < 3 || (!closed && (i === 0 || i === n - 1))) {
    return { ok: false, reason: '這個點是線的頭或尾，不是轉角 —— 倒不了圓角' };
  }
  const p = (i + n - 1) % n, q = (i + 1) % n;
  const hi = path.hi || [], ho = path.ho || [];
  if (penH(ho, p) > PEN_FILLET_EPS || penH(hi, i) > PEN_FILLET_EPS
      || penH(ho, i) > PEN_FILLET_EPS || penH(hi, q) > PEN_FILLET_EPS) {
    return { ok: false, reason: '這個角旁邊有曲線（有把手）—— 這一版只倒兩邊都是直線的角' };
  }
  const px = +a[i * 2], py = +a[i * 2 + 1];
  const ax = +a[p * 2] - px, ay = +a[p * 2 + 1] - py;
  const bx = +a[q * 2] - px, by = +a[q * 2 + 1] - py;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la < PEN_FILLET_EPS || lb < PEN_FILLET_EPS) return { ok: false, reason: '這個點跟旁邊的點疊在一起，量不出角度' };
  const dot = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  const theta = Math.acos(dot);                     // 兩條邊的夾角
  if (theta > Math.PI - 1e-4) return { ok: false, reason: '這個點兩邊是直直的一條線，沒有角可以倒' };
  if (theta < 1e-4) return { ok: false, reason: '這個點兩邊折回同一個方向，倒不了圓角' };
  const t = Math.tan(theta / 2);
  return { ok: true, maxR: Math.min(la, lb) * t, t, p, q, ux1: ax / la, uy1: ay / la, ux2: bx / lb, uy2: by / lb, theta };
}

/** 線在錨點 `i` 有沒有轉折（進來與出去的切線方向差超過 1°）；把手長 0 就往下一個控制點找方向 */
function penTurnsAt(path, i) {
  const a = path.a, hi = path.hi || [], ho = path.ho || [];
  const n = Math.floor(a.length / 2);
  const p = (i + n - 1) % n, q = (i + 1) % n;
  const X = k => +a[k * 2], Y = k => +a[k * 2 + 1];
  const g = (arr, k, c) => +(arr[k * 2 + c] || 0);
  const firstNonZero = cands => cands.find(v => Math.hypot(v[0], v[1]) > PEN_FILLET_EPS);
  const vin = firstNonZero([
    [-g(hi, i, 0), -g(hi, i, 1)],
    [X(i) - X(p) - g(ho, p, 0), Y(i) - Y(p) - g(ho, p, 1)],
    [X(i) - X(p), Y(i) - Y(p)]]);
  const vout = firstNonZero([
    [g(ho, i, 0), g(ho, i, 1)],
    [X(q) + g(hi, q, 0) - X(i), Y(q) + g(hi, q, 1) - Y(i)],
    [X(q) - X(i), Y(q) - Y(i)]]);
  if (!vin || !vout) return false;
  const c = (vin[0] * vout[0] + vin[1] * vout[1]) / (Math.hypot(...vin) * Math.hypot(...vout));
  return c < Math.cos(Math.PI / 180);
}

/** 最大值講給人看：無條件捨去到 0.01 cm（照著打一定倒得下去） */
const floor2 = v => Math.floor(v * 100 + 1e-6) / 100;

/** 照算好的幾何把一串角換成圓弧（`list` 是 `penFilletInfo()` 的結果、加上 `i`），再併掉疊在一起的點 */
function penFilletApply(path, list, r) {
  const n = Math.floor(path.a.length / 2);
  const by = new Map(list.map(g => [g.i, g]));
  const a = [], hi = [], ho = [];
  for (let k = 0; k < n; k++) {
    const g = by.get(k);
    if (!g) {
      a.push(+path.a[k * 2], +path.a[k * 2 + 1]);
      hi.push(+(path.hi[k * 2] || 0), +(path.hi[k * 2 + 1] || 0));
      ho.push(+(path.ho[k * 2] || 0), +(path.ho[k * 2 + 1] || 0));
      continue;
    }
    const px = +path.a[k * 2], py = +path.a[k * 2 + 1];
    const d = r / g.t;                                // 角到圓弧端點的距離
    const h = (4 / 3) * Math.tan((Math.PI - g.theta) / 4) * r;
    a.push(px + g.ux1 * d, py + g.uy1 * d, px + g.ux2 * d, py + g.uy2 * d);
    hi.push(0, 0, -g.ux2 * h, -g.uy2 * h);            // 第二個端點：進把手朝角
    ho.push(-g.ux1 * h, -g.uy1 * h, 0, 0);            // 第一個端點：出把手朝角
  }
  /** 疊在一起的相鄰兩點併成一個：留前一個的進把手、後一個的出把手 */
  const closed = path.closed !== false;
  for (let j = 0; ; ) {
    const m = a.length / 2;
    if (m < 2 || j >= (closed ? m : m - 1)) break;
    const k = (j + 1) % m;
    if (k !== j && Math.hypot(a[j * 2] - a[k * 2], a[j * 2 + 1] - a[k * 2 + 1]) < PEN_FILLET_EPS) {
      hi[k * 2] = hi[j * 2]; hi[k * 2 + 1] = hi[j * 2 + 1];
      a.splice(j * 2, 2); hi.splice(j * 2, 2); ho.splice(j * 2, 2);
      continue;
    }
    j++;
  }
  path.a = a; path.hi = hi; path.ho = ho;
}

/**
 * 倒一個角。⚠ **會直接改 `path`**（跟 `penAddAnchor()`／`penRemoveAnchor()` 一樣）。
 * @returns {{ok:boolean, reason?:string, maxR?:number, added?:number}}
 */
export function penFilletAt(path, i, r) {
  r = +r;
  if (!(r > 0)) return { ok: false, reason: '圓角 R 要打一個大於 0 的數字（cm）' };
  const g = penFilletInfo(path, i);
  if (!g.ok) return g;
  if (r > g.maxR * (1 + 1e-9)) {
    return { ok: false, maxR: floor2(g.maxR), reason: `R ${r} 太大了：這個角兩邊的直線不夠長，最大只能 R ${floor2(g.maxR)}` };
  }
  const before = path.a.length / 2;
  penFilletApply(path, [{ ...g, i }], r);
  return { ok: true, added: path.a.length / 2 - before };
}

/**
 * 整條的尖角一起倒（兩邊都是直線的那些）。兩個角共用一段時，兩邊各吃掉的長度加起來⛔ 超過那一段。
 * @returns {{ok:boolean, reason?:string, maxR?:number, done?:number, skipped?:number}}
 */
export function penFilletAll(path, r) {
  r = +r;
  if (!(r > 0)) return { ok: false, reason: '圓角 R 要打一個大於 0 的數字（cm）' };
  const n = Math.floor(((path && path.a) || []).length / 2);
  const list = [];
  let skipped = 0;
  for (let i = 0; i < n; i++) {
    const g = penFilletInfo(path, i);
    if (g.ok) list.push({ ...g, i });
    /**
     * 兩邊直直一條線、線的頭尾 ⛔ 算「沒倒到」—— 那些本來就不是角；
     * 旁邊有曲線、但線在這裡是順的（例如已經倒好的圓弧兩端）也⛔ 算（本機畫面試出來的：以前講「2 個角沒倒」嚇人）
     */
    else if (/曲線/.test(g.reason) ? penTurnsAt(path, i) : !/直直的一條線|頭或尾/.test(g.reason)) skipped++;
  }
  if (!list.length) {
    return { ok: false, reason: skipped ? '這條線的角旁邊都有曲線 —— 這一版只倒兩邊都是直線的角' : '這條線沒有尖角可以倒' };
  }
  const isF = new Map(list.map(g => [g.i, g]));
  const closed = path.closed !== false;
  let maxR = Infinity;
  for (let k = 0; k < (closed ? n : n - 1); k++) {
    const j = (k + 1) % n;
    const s = (isF.has(k) ? 1 / isF.get(k).t : 0) + (isF.has(j) ? 1 / isF.get(j).t : 0);
    if (s <= 0) continue;
    const len = Math.hypot(path.a[k * 2] - path.a[j * 2], path.a[k * 2 + 1] - path.a[j * 2 + 1]);
    maxR = Math.min(maxR, len / s);
  }
  if (r > maxR * (1 + 1e-9)) {
    return { ok: false, maxR: floor2(maxR), reason: `R ${r} 太大了：相鄰兩個角的圓弧會疊在一起，整條一起倒最大只能 R ${floor2(maxR)}` };
  }
  penFilletApply(path, list, r);
  return { ok: true, done: list.length, skipped };
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
/**
 * 🔴 **鋼筆的預設細分 0.05 cm**（2026-10-20 kang「同意你的建議」；以前跟 SVG 共用 `DEFAULT_TOL` 0.2 cm）。
 * 0.2 cm 時 R 5 的圓角只切 4 段、跟圓弧最多差約 1 mm（做實體、展開圖都看得出折線）；0.05 cm ⇒ 約 0.25 mm、點多不到一倍。
 * ⚠ 物件自己記了 `tol`（匯入轉成鋼筆的 0.02）就照它的。⛔ 動 `DEFAULT_TOL`（SVG 匯入沒有單位時還在用）。
 */
export const PEN_TOL = 0.05;
export function flattenPenPath(path, tol = PEN_TOL) {
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
  /** ④-7（2026-10-20）：匯入時留下來的錨點（`ob`／`hb`）也要跟著搬 —— 把手是相對錨點的位移，⛔ 用動 */
  const moveBez = bz => (bz && Array.isArray(bz.a) ? { a: move(bz.a), hi: (bz.hi || []).slice(), ho: (bz.ho || []).slice() } : bz);
  return {
    ...shape,
    out: move(shape.out || []),
    holes: (shape.holes || []).map(move),
    ...(shape.ob ? { ob: moveBez(shape.ob) } : {}),
    ...(shape.hb ? { hb: shape.hb.map(moveBez) } : {})
  };
}

/**
 * 🔴 **匯入的封閉形狀 → 鋼筆**（綜合評估 ④-7，2026-10-20，kang「同意你的安排與建議」）。
 * 匯入的形狀是「擠出件」（只存折成直線的點）⇒ ⛔ 能改點、加洞（T6 招牌字）。鋼筆可以「編輯路徑」。
 * ⭐ 匯入時多留了每一圈 Illustrator 的錨點與把手（`ob` 外圈、`hb` 每個洞）⇒ 轉過去點跟原稿一樣；
 * 　 舊的匯入沒有 ⇒ 每個折點當一個尖角的錨點（形狀一樣、點比較多），回傳 `approx` 讓畫面講出來。
 * ⚠ 兩邊都走 `extrudeMany()`、同一套 2D 座標與厚度 ⇒ 位置、大小⛔ 變（曲線重新細分，邊上的點可能差一點點）。
 * 🔴 **細分的容許值要跟著帶過去**（本機畫面試出來的）：鋼筆預設當時是 0.2 cm（現在 `PEN_TOL` 0.05 cm），匯入預設 0.2 mm ——
 * 　 沒帶過去的話一段平緩的弧只切兩刀，體積少 0.7%。匯入時記在 `src.tol`（cm）；舊的匯入沒記 ⇒ 用匯入的預設 0.02 cm。
 * @returns {{ok:boolean, src?:object, approx?:number, anchors?:number, reason?:string}}
 */
export const IMPORT_TOL_CM = 0.02;
export function extrudeToPenSrc(src) {
  if (!src || src.type !== 'extrude' || !Array.isArray(src.shapes) || !src.shapes.length) {
    return { ok: false, reason: '這個物件不是匯入的擠出件' };
  }
  let approx = 0, anchors = 0;
  const path = (bz, flat) => {
    if (bz && Array.isArray(bz.a) && bz.a.length >= 6) {
      anchors += bz.a.length / 2;
      return { closed: true, a: bz.a.slice(), hi: (bz.hi || bz.a.map(() => 0)).slice(), ho: (bz.ho || bz.a.map(() => 0)).slice() };
    }
    approx++;
    anchors += (flat || []).length / 2;
    return { closed: true, a: (flat || []).slice(), hi: (flat || []).map(() => 0), ho: (flat || []).map(() => 0) };
  };
  const paths = [];
  for (const s of src.shapes) {
    paths.push(path(s.ob, s.out));
    (s.holes || []).forEach((h, i) => paths.push(path(s.hb && s.hb[i], h)));
  }
  const tol = +src.tol > 0 ? +src.tol : IMPORT_TOL_CM;
  return { ok: true, src: { type: 'pen', h: num(src.h, 3), tol, paths }, approx, anchors };
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

/** 齒輪的壓力角：固定標準的 20°（kang 2026-10-08 同意 ⛔ 不開成格子 —— 同一個角度才保證咬得上） */
const GEAR_PA = 20 * Math.PI / 180;
const involute = a => Math.tan(a) - a;

/**
 * 齒輪外形：一串 [半徑, 角度]（逆時針），`corner` 是「齒尖、齒根交界」那些點的索引。
 *
 * 每一齒：左齒面（齒根 → 齒尖）→ 齒尖圓弧 → 右齒面（齒尖 → 齒根）→ 齒根圓弧。
 * 齒面上半徑 ρ 那一點，離齒中心線的角度 ＝ ψ ＋ inv(20°) − inv(α_ρ)，cos α_ρ ＝ 基圓半徑 ÷ ρ。
 * ψ ＝ 分度圓上半個齒厚的角度 ＝ π/(2z) − 間隙/(4r) ——
 * 兩個齒輪都用同一個間隙時，咬合處合起來留的空隙剛好就是這個數字。
 */
function gearOutline(g) {
  const { z, r, rb, ra, rf, gap } = g;
  const half = Math.PI / (2 * z) - gap / (4 * r) + involute(GEAR_PA);
  const ang = rho => (rho <= rb ? half : half - involute(Math.acos(rb / rho)));
  const N = 8;
  const flank = [];                                   // 齒根 → 齒尖，[ρ, 離中心線的角度]
  const r0 = Math.max(rf, rb);
  if (rf < rb) flank.push([rf, ang(rb)]);             // 基圓以下：徑向直線
  for (let i = 0; i <= N; i++) { const rho = r0 + (ra - r0) * i / N; flank.push([rho, ang(rho)]); }
  const tipA = flank[flank.length - 1][1];
  const out = [];
  out.corner = new Set();
  const ARC = 3;                                      // 齒尖、齒根圓弧中間各插幾個點
  for (let k = 0; k < z; k++) {
    const c = 2 * Math.PI * k / z;
    out.corner.add(out.length);                       // 左齒面的齒根端
    for (const [rho, a] of flank) out.push([rho, c - a]);
    out.corner.add(out.length - 1);                   // 左齒面的齒尖端
    for (let j = 1; j <= ARC; j++) out.push([ra, c - tipA + 2 * tipA * j / (ARC + 1)]);
    out.corner.add(out.length);                       // 右齒面的齒尖端
    for (let i = flank.length - 1; i >= 0; i--) out.push([flank[i][0], c + flank[i][1]]);
    out.corner.add(out.length - 1);                   // 右齒面的齒根端
    const a0 = c + flank[0][1], a1 = c + 2 * Math.PI / z - flank[0][1];
    for (let j = 1; j <= ARC; j++) out.push([rf, a0 + (a1 - a0) * j / (ARC + 1)]);
  }
  return out;
}

/**
 * 旋轉成形的出口：一條輪廓繞 Y 轉一圈 → 半邊網格。
 * ⚠ 跟 `toMesh()` 一樣補 `autoMarkFolds()` —— `revolve()` 只標平滑邊，⛔ 不標折線。
 */
function fromRevolve(pts, seg) {
  const r = revolve(pts, { axis: 'y', a: 0, b: 0, seg });
  if (!r.ok) throw new Error(r.reason);
  r.mesh.autoMarkFolds();
  return r.mesh;
}

/**
 * 🔴🔴 **鋼筆物件的「旋轉成形」模式**（2026-10-15，第 1 輪接回）。
 *
 * ⭐ **kang 2026-09-02 拍板的「丙-1.5」**：線留在 `src` 裡、改了東西跟著變 ——
 * ⇒ ⛔ **不另外生一個物件**，是**這支鋼筆自己變成碗**；
 * 　 回頭 `編輯路徑` 拖錨點，碗當場跟著變。
 * ⭐ 資料只多一格：`src.rev = { dir, at, seg, stand }`；**沒有 `rev` ＝ 原本的行為**。
 *
 * ── 🔴 中心線只有兩種方向，⛔ 不是三種 ─────────────────
 * 鋼筆的線**躺在地板上**（形狀的 (x, y) ＝ 本地的 (x, z)），
 * 而中心線要跟線**在同一個平面**才轉得出立體 ⇒ 只能是地板上的一條線：
 * - `dir:'z'`：前後方向（平行 Z），在 **x ＝ at**
 * - `dir:'x'`：左右方向（平行 X），在 **z ＝ at**
 * ⚠ 所以**只要一個數字**（另一個座標就是地板）——
 * 　 規格裡「軸要兩個座標」講的是任意一串邊，⛔ 不是這裡。
 * ⚠ `at` 是**這個物件自己的座標**（跟 `paths` 同一套）⇒ 搬物件時碗整個跟著走、形狀不變。
 *
 * ── 🔴 立起來（kang 2026-10-15 拍板：記在物件上）───────────
 * 躺著轉出來的碗中心線是橫的；`stand` 開著就把中心線轉成**直立**、底貼地板。
 * ⚠ **哪一頭朝上是定死的規則，⛔ 不猜**（上視圖畫的時候）：
 * - 前後方向：**畫面上方朝上**（上視圖的畫面上方 ＝ −Z，`scene.js` 的 `setView('top')`）
 * - 左右方向：**畫面右邊朝上**（⚠ 這個方向⛔ 沒有自然的答案，挑了一個；反了就把物件轉 180°）
 * ⭐ 做法是**先把輪廓立起來、再繞直立的軸轉** —— `revolve()` 一行都不用知道「立起來」。
 *
 * ── 🔴 躺著（`stand` 關）：整個抬起來，最低點貼地板（kang 2026-10-15 拍板）──
 * 中心線畫在地板上，轉出來上下各一半 ⇒ 下面那一半會鑽到地板底下。形狀⛔ 不變，只往上搬。
 */
export const PEN_REV_DEFAULTS = { dir: 'z', seg: 32, stand: true };

/** 輪廓拉直成點串（形狀座標 {x,y}）；不只一條就講出來 */
function penRevProfile(p) {
  const tol = num(p.tol, PEN_TOL);
  const paths = (p.paths || []).filter(path => path && (path.a || []).length >= 4);
  if (!paths.length) return { ok: false, reason: '這支鋼筆還沒有畫出任何一條線' };
  if (paths.length > 1) {
    return { ok: false, reason: `這支鋼筆有 ${paths.length} 條線 —— 旋轉成形一次只轉一條` };
  }
  /**
   * ⚠ **封口的線要把第一個點再接到最後** —— `revolve()` 是靠
   * 「頭尾同一個點」認出封閉輪廓的（它自己會收掉重複的那一個，⛔ 不會疊兩個頂點）。
   * ⛔ 不接的話會少一段，轉出來的環**缺一圈**，而畫面上很難看出來。
   */
  const pts = p.open
    ? flattenPenPath({ ...paths[0], closed: false }, tol)
    : flattenPenPath(paths[0], tol);
  if (!p.open && pts.length) pts.push({ ...pts[0] });
  if (pts.length < 2) return { ok: false, reason: '至少要有 2 個點才轉得出東西' };
  return { ok: true, pts };
}

/**
 * 中心線的自動位置：**輪廓在那個方向的最小值**。
 * 〔理由照 `規格\建模器-旋轉成形.md`「軸的座標欄：自動填那個座標的最小值」——
 * 　所有點都在同一側（⛔ 永遠不會誤擋），而從中心線出發畫的碗剛好封底〕
 */
export function penRevAutoAt(p, dir) {
  const pr = penRevProfile(p);
  if (!pr.ok) return 0;
  return Math.min(...pr.pts.map(q => (dir === 'x' ? q.y : q.x)));
}

/**
 * @param {object} p 鋼筆的 src（要有 `rev`）
 * @returns `revolve()` 的回傳（`ok:false` 時有 `reason`）——
 *          介面的「離中心線」與「實體還是板件」都讀這一份，⛔ 不各算一次
 */
/**
 * 🔴 **旋轉成形：打「起點離中心線多遠」⇒ 中心線該放哪**（綜合評估 ④-13，2026-10-20，kang「同意你的安排與建議」）。
 * 以前只能打中心線的位置，要燈罩上口剛好半徑 8 得自己算（T5）。
 * ⭐ 線**一格都不動**、只挪中心線：起點（輪廓的第一個點）離中心線剛好 `R`，而且**留在原本那一側**（⛔ 跨過去把碗翻面）。
 * ⚠ R 是線自己座標的長度（面板會先除以物件的縮放）。
 * @returns {{ok:boolean, at?:number, reason?:string}}
 */
export function penRevAtForHeadR(p, R) {
  const rv = p && p.rev;
  if (!rv) return { ok: false, reason: '這支鋼筆沒有開旋轉成形' };
  if (!(R >= 0)) return { ok: false, reason: '起點離中心線要打 0 以上的數字' };
  const pr = penRevProfile(p);
  if (!pr.ok) return pr;
  const q = pr.pts[0];
  const c = rv.dir === 'x' ? q.y : q.x;
  const at = num(rv.at, 0);
  const side = Math.sign(c - at) || 1;
  return { ok: true, at: c - side * R };
}

export function penRevolve(p) {
  const rv = p && p.rev;
  if (!rv) return { ok: false, reason: '這支鋼筆沒有開旋轉成形' };
  const pr = penRevProfile(p);
  if (!pr.ok) return pr;
  const pts = pr.pts;
  const dir = rv.dir === 'x' ? 'x' : 'z';
  const at = num(rv.at, 0);
  const seg = int(rv.seg, PEN_REV_DEFAULTS.seg);
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  /**
   * 🔴 **牆上的旋轉成形**（kang 2026-10-17 拍板「甲」：中心線就在畫的那條線上、⛔ 抬）——
   * `rv.wall`（'x+'…）是**打開旋轉成形那一刻**照物件角度記下的（`toolbar.js`；prim ⛔ 認識物件）。
   * ⭐ 牆上的線本地 XZ 就是那片牆 ⇒ 照「躺著」那條路原地轉、⛔ 往本地 +Y 抬
   * （本地 +Y 在牆上是朝牆外 —— 抬了就整個被推出牆，2026-10-17 線上實測抓到的）；「立起來」⛔ 管。
   */
  if (!rv.stand || rv.wall) {
    const r = dir === 'z'
      ? revolve(pts.map(q => V(q.x, 0, q.y)), { axis: 'z', a: at, b: 0, seg })
      : revolve(pts.map(q => V(q.x, 0, q.y)), { axis: 'x', a: 0, b: at, seg });
    /**
     * 🔴 **躺著的碗整個往上抬，最低點貼地板**（kang 2026-10-15 拍板）。
     * ⚠ 中心線畫在地板上 ⇒ 繞它轉出來的東西**上下各一半**，下面那一半鑽到地板底下。
     * ⭐ 抬的量**看轉出來的網格量**，⛔ 不用「離中心線最遠」去算 ——
     * 　 `轉幾格` 不是 4 的倍數時，最低的那一格⛔ 剛好在正下方，用半徑算會浮起來一點。
     * ⚠ 走 `transformed()` 搬，平滑邊與折線的標記才會一起帶過去。
     */
    if (r.ok) {
      const lo = rv.wall ? 0 : r.mesh.bounds().min.y;
      if (lo) r.mesh = r.mesh.transformed(new THREE.Matrix4().makeTranslation(0, -lo, 0));
      /** 中心線也跟著往上搬了 `−lo`（第 2 輪「綁參考線」要知道它在哪） */
      r.axisLocal = dir === 'z'
        ? { p: [at, -lo, 0], d: [0, 0, 1] }
        : { p: [0, -lo, at], d: [1, 0, 0] };
    }
    return r;
  }
  /**
   * 立起來：輪廓搬到一個直立的平面上，底（往下那一頭）貼地板。
   * ⚠ 碗的中心落在**原本那一頭的位置**（前後方向：輪廓最前面那一頭；
   * 左右方向：最左邊那一頭）—— 從上面看，碗就站在你畫線的那一端。
   */
  /**
   * ⭐ `axisLocal`：中心線在**網格自己的座標**裡的一點 `p` 與方向 `d` ——
   * 第 2 輪「綁參考線」用它判斷「中心線還在不在那條參考線上」，⛔ 另外再推一次（坑第 31 條）。
   */
  if (dir === 'z') {
    const ymax = Math.max(...pts.map(q => q.y));
    const r = revolve(pts.map(q => V(q.x, ymax - q.y, ymax)), { axis: 'y', a: at, b: ymax, seg });
    if (r.ok) r.axisLocal = { p: [at, 0, ymax], d: [0, 1, 0] };
    return r;
  }
  const xmin = Math.min(...pts.map(q => q.x));
  const r = revolve(pts.map(q => V(xmin, q.x - xmin, q.y)), { axis: 'y', a: xmin, b: at, seg });
  if (r.ok) r.axisLocal = { p: [xmin, 0, at], d: [0, 1, 0] };
  return r;
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
   * ── 🔴 洞（2026-08-30 加，第 3 階段）────────────────────
   * **包在裡面的那一條路徑就是洞。** 判準走 `profile.js` 的 `classify()`
   * —— **巢狀深度是偶數 ＝ 實心，奇數 ＝ 洞**。
   *
   * ⚠ **⛔ 不用繞向判斷**（順時針／逆時針）：畫的人不一定照規矩，
   * 而「在不在裡面」是**幾何事實**，繞向只是慣例。
   * ⭐ **跟匯入線稿⛔ 不是各判一次，是同一支函式** —— 兩份遲早會不一致。
   *
   * ⚠ **`classify()` 一定要有 `area`**，所以這裡補算 `polyArea()`；
   * ⛔ 少了它每一條都會被當成外框，**洞會變成疊在上面的實心塊**
   * （【實證 2026-08-29】外 40×40 ＋ 內 20×20 → 體積 10000，⛔ 不是 6000）。
   *
   * ⚠ **⛔ 不放進 `PRIM_DEFAULTS`** —— 理由跟 `extrude` 完全一樣：
   * 它沒辦法從零生成（要有人先畫），放進選單就是一個按了會壞的項目。
   */
  pen(p) {
    /**
     * 🔴 **開了旋轉成形就走 `penRevolve()`**（2026-10-15）——
     * `h`（高／寬）與 `up`（往上長）這時候⛔ 沒有意義，面板也把它們藏起來。
     * ⚠ 擋關（跨過中心線、不只一條線…）照樣 `throw` ⇒ 變成物件上的那一行錯誤，
     * ⛔ 不會讓整個畫面掛掉（`ModelObject.mesh()` 接得住）。
     */
    if (p.rev) {
      const r = penRevolve(p);
      if (!r.ok) throw new Error(r.reason);
      r.mesh.autoMarkFolds();
      return r.mesh;
    }
    const tol = num(p.tol, PEN_TOL);
    /**
     * 🔴🔴 **`不封口`：整個物件一個旗標，⛔ 不是每條路徑各存一份**
     * （kang 2026-08-30 拍板的第 ③ 件，2026-08-31 實作）。
     *
     * ⚠ **⛔ 不要改成「看 `path.closed`」** —— 那會變成
     * **兩個地方各記一份「這支鋼筆封不封口」**，遲早不一致（坑第 31 條）。
     * ⭐ 這裡直接把 `closed:false` **蓋上去**，
     * 所以 `takePen()`／`peekPen()`／`loadPen()` **一行都不用改**。
     *
     * ⭐ 而 `flattenPenPath()` **本來就支援開放**（最後一個錨點另外補），
     * ⛔ 不必為了這一件動它。
     */
    if (p.open) {
      const lines = (p.paths || [])
        .map(path => flattenPenPath({ ...path, closed: false }, tol))
        .filter(pts => pts.length >= 2);
      if (!lines.length) throw new Error('這支鋼筆還沒有畫出任何一條線');
      /**
       * 🔴 **開放的路徑⛔ 沒有「洞」這回事** —— 所以⛔ 不走 `classify()`。
       * 一條線就是一片帶，兩條線就是兩片，**互相不影響**。
       * 〔包在裡面 ＝ 洞，那個判準的前提是「圍得出面積」〕
       */
      return ribbonFromPaths(lines, { up: !!p.up, size: num(p.h, 3) });
    }
    const flat = (p.paths || [])
      .map(path => flattenPenPath(path, tol))
      .filter(pts => pts.length >= 3)
      .map(pts => ({ pts, area: polyArea(pts) }));
    /**
     * ⚠ **面積接近 0 的先丟掉** —— 那種形狀 `pointInPoly` 判不準，
     * 而且擠出來什麼都不是。〔跟 `readSVG()` 的 `tiny` 同一條〕
     */
    const shapes = classify(flat.filter(s => Math.abs(s.area) >= 1e-6));
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
   * 圓環 ＝ 一個圓（管的斷面）繞 Y 轉一圈。
   * ⭐ **幾何一行新的都沒有**：首尾同一點的輪廓交給 `revolve()`，它就轉成環。
   * ⚠ 圓照**逆時針**走（往外、往上）—— 那是 `revolve()` 量過體積為正的方向。
   */
  torus(p) {
    const D = PRIM_DEFAULTS.torus;
    const ro = num(p.rOuter, D.rOuter);
    // 內半徑要在 (0, 外半徑) 之間：等於 0 會碰到中心線，等於外半徑就沒有管了
    const ri = Math.max(ro * 1e-3, Math.min(num(p.rInner, D.rInner), ro * (1 - 1e-3)));
    const R = (ro + ri) / 2, a = (ro - ri) / 2;
    const n = int(p.segT, D.segT);
    const pts = [];
    for (let i = 0; i <= n; i++) {          // i ＝ n 回到起點 ⇒ revolve 認得是封閉的
      const t = (i % n) / n * Math.PI * 2;
      pts.push(new THREE.Vector3(R + a * Math.cos(t), a * Math.sin(t), 0));
    }
    return fromRevolve(pts, int(p.seg, D.seg));
  },

  /**
   * 楔形（斜坡）：直角三角形的柱。後面（−Z）高、前面（+Z）低。
   * ⚠ 每個面的頂點順序都照右手定則朝外排 —— 測試盯「體積 ＝ 寬×高×深÷2，而且是正的」。
   */
  wedge(p) {
    const D = PRIM_DEFAULTS.wedge;
    const w = num(p.w, D.w) / 2, h = num(p.h, D.h) / 2, d = num(p.d, D.d) / 2;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const pts = [V(-w, -h, -d), V(w, -h, -d), V(w, -h, d), V(-w, -h, d),   // 底
                 V(-w, h, -d), V(w, h, -d)];                                // 後面頂端那條邊
    const m = Mesh.fromFaceList(pts, [
      [0, 1, 2, 3],      // 底
      [0, 4, 5, 1],      // 後面（直立的那一面）
      [3, 2, 5, 4],      // 斜面
      [0, 3, 4],         // 左側三角形
      [1, 5, 2]          // 右側三角形
    ]);
    m.autoMarkFolds();
    return m;
  },

  /**
   * 半球（圓頂）：實心、底是平的。輪廓 ＝ 底心 → 底邊 → 四分之一圓弧 → 頂點，繞 Y 轉一圈。
   * ⭐ 底心與頂點落在中心線上，`revolve()` 會各只放一個頂點（⛔ 不是一圈疊在一起的點）。
   */
  dome(p) {
    const D = PRIM_DEFAULTS.dome;
    const r = num(p.r, D.r);
    const n = int(p.segH, D.segH, 1);
    const y0 = -r / 2;                       // 外框中心放在原點，跟其他基本體一樣
    const pts = [new THREE.Vector3(0, y0, 0)];
    for (let j = 0; j <= n; j++) {
      const a = j / n * Math.PI / 2;
      // 最後一點的 cos(90°) 不是剛好 0 —— 直接放 0，免得頂點差一點點沒落在中心線上
      pts.push(new THREE.Vector3(j === n ? 0 : r * Math.cos(a), y0 + r * Math.sin(a), 0));
    }
    return fromRevolve(pts, int(p.seg, D.seg));
  },

  /**
   * 階梯：下面實心填到地，側面是鋸齒形。前面（+Z）低、後面（−Z）高。
   * 側面是**凹的多邊形**，一整片放（⛔ 不切成三角形）—— 畫面與 STL 走 `faceTriangles` 的耳切。
   */
  stairs(p) {
    const D = PRIM_DEFAULTS.stairs;
    const n = int(p.steps, D.steps, 1);
    const sh = num(p.stepH, D.stepH), sd = num(p.stepD, D.stepD);
    const w = num(p.w, D.w) / 2;
    const H = n * sh, L = n * sd;
    // 側面輪廓（z 由後 0 到前 L，y 由地 0 往上）：底 → 前面第一階 → 一階一階往後上，
    // 最後一階的後緣剛好是 (0, H)，從那裡回到 (0, 0) 就是後牆
    const prof = [[0, 0], [L, 0]];
    for (let k = 0; k < n; k++) {
      const z = L - k * sd;
      prof.push([z, (k + 1) * sh], [z - sd, (k + 1) * sh]);
    }
    const m = prof.length;
    const pts = [];
    for (const x of [-w, w]) {
      for (const [z, y] of prof) pts.push(new THREE.Vector3(x, y - H / 2, z - L / 2));
    }
    const faces = [
      [...Array(m).keys()],                          // 左側（−X）
      [...Array(m).keys()].map(i => m + i).reverse() // 右側（+X）
    ];
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % m;
      faces.push([i, m + i, m + j, j]);              // 底、踢面、踏面、後牆
    }
    const mesh = Mesh.fromFaceList(pts, faces);
    mesh.autoMarkFolds();
    return mesh;
  },

  /**
   * 齒輪：標準漸開線齒形（壓力角 20°）＋ 中心孔，躺在地上往上擠出厚度。
   * ⭐ 擠出走 `extrudeMany()`（帶孔、耳切、平滑邊都是現成的）。
   * ⚠ 齒根圓比基圓小時，基圓以下那一小段用**徑向直線**接到齒根
   * （⛔ 不是真正的根切曲線 —— 雷射切的精度用不到）。
   */
  gear(p) {
    const g = gearDims(p);
    const pts = gearOutline(g).map(([rho, a], i, arr) => ({
      x: rho * Math.cos(a), y: rho * Math.sin(a), corner: arr.corner.has(i)
    }));
    const holes = [];
    if (g.holeR > 1e-6) {
      const n = 32;
      holes.push({ pts: [...Array(n).keys()].map(i => ({
        x: g.holeR * Math.cos(i / n * 2 * Math.PI), y: g.holeR * Math.sin(i / n * 2 * Math.PI), corner: false
      })) });
    }
    return extrudeMany([{ pts, holes }], g.t, { base: -g.t / 2 });   // 外框中心放在原點
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
    const { line } = bendProfile(p, t);

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

/**
 * 折板的斷面折線（XY 平面），從 `bend()` 拆出來（原本那一段一字未改，只多記「每一段直線從哪裡開始」）。
 *
 * 🔴 **原點放在第幾段的起點**（綜合評估 ④-19 剩下的，2026-10-20，kang「同意你的安排與建議」）——
 * 以前原點一律在**第一段的起點**：T3 要讓隔板的牆（第 2 段）落在 X −3.33，得自己算 −3.33 −（1 ＋ 0.2 ＋ 0.25）＝ −4.78。
 * ⇒ `p.anchorSeg`（1 ＝ 第一段，照舊）：整條斷面平移，讓**那一段的起點**落在原點 ⇒ 位置欄打的就是那一段在哪。
 * ⚠ 只平移、⛔ 轉：每一段的方向照舊（要哪一段水平靠旋轉）。超出段數 ⇒ 夾到最後一段。
 *
 * @returns {{line:number[][], segStarts:number[][], anchor:number}} `segStarts[i]` ＝ 第 i＋1 段在「沒平移時」的起點
 */
export function bendProfile(p, t = 0) {
  const D = PRIM_DEFAULTS.bend;
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
  const segStarts = [[0, 0]];

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

    segStarts.push([x, y]);
    if (len > 0) advance(len);
  }

  const anchor = Math.min(Math.max(int(p.anchorSeg, 1, 1), 1), segStarts.length);
  const [ox, oy] = segStarts[anchor - 1];
  if (ox || oy) for (const q of line) { q[0] -= ox; q[1] -= oy; }
  return { line, segStarts, anchor };
}

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
