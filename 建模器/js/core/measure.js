/**
 * 量測：把「選到的東西有多大」算出來。
 *
 * ── 這支檔案為什麼存在 ────────────────────────────────
 * kang 2026-08-25 提出來的問題：
 *   「轉換成編輯網格後，就無法正確知道真實尺寸，只有座標…
 *     看座標無法真正知道我移動多少，或是我編輯後的造型的實際長度、曲線長…
 *     這樣建模上就很難做得精準」
 *
 * 參數物件的尺寸寫在參數裡（`{type:'box', w:60, h:45, d:40}`），
 * 一旦 `bake()` 成網格那些數字就沒了，只剩一堆頂點座標。
 * 這支檔案負責把尺寸**從網格現算回來**。
 *
 * ⭐ **現算，不存。** 跟圓弧擬合那一節同一條結論：存起來的東西會過期，
 * 而這個專案的編輯功能**每一個都在拆掉重建網格**。
 * 〔`smooth` 漏一條路 → 展開圖 5 處折彎變 45 處；
 * 　`hard` 漏兩條路 → 按一次壓平，環切的 48 條線全部歸零〕
 *
 * ── 🔴 一律換到世界座標再量 ───────────────────────────
 * **網格存的是物件自己的座標**，物件另外帶著位置、旋轉與縮放。不換的話：
 *   · 被**縮放**過的物件會報出錯的長度與面積
 *   · 面板的座標跟「切一刀」「對齊」「貼合」「剖面分切」**對不起來**
 *
 * ⚠ **而且畫面完全正常**，跟 `worldAxisPlane()` 踩到的是同一個病
 * （坑第 17 條：中途的量一直都是對的，末端才錯）。
 *
 * 🔴 kang 2026-08-25 為「切一刀」拍板過，這裡只是把同一條套用過來：
 * > **座標是「空間裡的實際位置」，跟對齊、貼合、剖面分切同一套數字。**
 *
 * ── ⚠ 「面」是共面區域，不是三角形 ─────────────────────
 * 方塊的頂面在網格裡是 2 個三角形，使用者看到的是 1 個正方形。
 * 三角化一律走 `mesh.faceTriangles()`（⛔ 不要自己寫扇形三角化，
 * 那只對凸多邊形成立 —— 它有過 8 個出口）。
 *
 * ── ⚠ `regionOf()` 跟 `Region` 是兩個不同的東西（寫這支時踩到）───
 * `edit.js` 的 `regionOf()` 只回 `{rid, faces, verts}`，**沒有 `loops`**；
 * 有 `loops` 的是 `region.js` `planarRegions()` 回的 `Region`。
 * 算周長要的是後者。〔又一次「讀程式，不要照描述推」〕
 *
 * ── 這份不回答 ──────────────────────────────────────
 * · 怎麼把數字畫到畫面上 → `js/ui/toolbar.js`、`js/view/scene.js`
 * · 展開圖上的尺寸標註   → `js/out/sheet.js`
 * · 圓的半徑／弧長／弦長 → 還沒做，見日誌待辦「圓弧擬合接上介面」
 *
 * ── 第 2 步：畫到 3D 畫面上（2026-08-27 加）─────────────
 * `measureLabels()` 回的是「**哪個位置該出現哪一串字**」，
 * 純資料、不碰 DOM 也不碰 three.js 的場景 —— 所以測得到。
 * 怎麼把它變成畫面上的字是 `scene.js` `setMeasureLabels()` 的事。
 *
 * ⭐ **這是這個專案的老招**：出圖也是拆成「決定畫什麼」（純資料）
 * 與「怎麼畫出來」兩層，所以連「圖上標了什麼」都測得到。
 */

import * as THREE from 'three';
import { planarRegions } from './region.js';
import { elementVerts, elementCenter } from './edit.js';

/** 小數點兩位 —— kang 2026-08-25 選的。0.01 cm ＝ 0.1mm，正好是可切容許值 */
export const MEASURE_DP = 2;

/** 顯示用。⚠ 一律走這裡，⛔ 不要各處自己 toFixed，不然位數會各講各的 */
export function fmtCm(v) {
  return (Math.round(v * 100) / 100).toFixed(MEASURE_DP);
}

/** 一條邊在世界座標下的長度。@param {THREE.Matrix4} M `obj.matrix()` */
export function edgeLength(he, M) {
  if (!he || !he.v || !he.to) return 0;
  return he.v.p.clone().applyMatrix4(M)
    .distanceTo(he.to.p.clone().applyMatrix4(M));
}

/**
 * 一個共面區域在世界座標下的面積與外緣周長。
 *
 * ⚠ **周長只算最外圈**（`loops[0]`；`finishRegion()` 已經照長度排序過）。
 * 有洞的面，洞的一圈**不加進去** —— 「周長」在使用者眼中是外緣一圈，
 * 把洞加進去那個數字就沒有人驗得出來了（坑第 20 條）。
 * 洞的數量另外回報，讓使用者知道這個面上有洞。
 *
 * @param {Region} reg `planarRegions()` 回來的那種
 * @returns {{area:number, perimeter:number, holes:number}}
 */
export function regionMeasure(mesh, reg, M) {
  let area = 0;
  for (const f of reg.faces) {
    for (const [v0, v1, v2] of mesh.faceTriangles(f)) {
      const a = v0.p.clone().applyMatrix4(M);
      const ab = v1.p.clone().applyMatrix4(M).sub(a);
      const ac = v2.p.clone().applyMatrix4(M).sub(a);
      area += new THREE.Vector3().crossVectors(ab, ac).length() / 2;
    }
  }

  let perimeter = 0;
  const outer = reg.loops[0] || [];
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i].p.clone().applyMatrix4(M);
    const b = outer[(i + 1) % outer.length].p.clone().applyMatrix4(M);
    perimeter += a.distanceTo(b);
  }

  return { area, perimeter, holes: Math.max(0, reg.loops.length - 1) };
}

/**
 * 一整份選取的量測結果。介面直接拿這個去畫。
 *
 * 🔴 **多選時哪些量有意義、哪些沒有，在這裡就決定完**，
 * ⛔ 不要讓介面自己再判一次 —— 那就變成兩個地方各判一次（坑第 31 條）。
 *
 *   · `length`    邊：全部選取的**總長**。多選有意義（一整圈 ＝ 曲線長）
 *   · `area`      面：全部選取的**總面積**。多選有意義
 *   · `perimeter` 面：**只有單選一個面才給，多選一律 `null`**。
 *     🔴 多選時相鄰的面共用的邊會被算兩次，**那個數字沒有人驗得出來**。
 *     ⛔ 不要為了「有東西可以顯示」硬湊一個（坑第 20 條）
 *   · `size`      選取範圍的外框（世界座標）。任何選取都有意義
 *   · `center`    重心（世界座標）
 *
 * ⚠ **效能**：`planarRegions()` 在這裡**只跑一次**，不是每個面跑一次 ——
 * 它是掃全網格的，選 32 個面就會變成掃 32 遍（坑第 3、22 條）。
 *
 * @returns {null|{kind, count, vertCount, center, size,
 *                 length, area, perimeter, holes}}
 */
export function measureSelection(mesh, els, M, pivot = 'median', tolDeg = 0.5) {
  if (!mesh || !Array.isArray(els) || !els.length) return null;

  const kind = els[0].kind;
  const verts = elementVerts(mesh, els, tolDeg);
  if (!verts.length) return null;

  /**
   * 🔴 **重心借 `elementCenter()`，⛔ 不要在這裡自己再算一次平均。**
   * gizmo 掛在哪、縮放往哪裡收，用的都是它 —— 面板寫的數字必須是**同一個點**，
   * 不然使用者看到的重心跟箭頭站的位置會對不起來，而且**只有在多選
   * 加上「中心＝最後選的」時才看得出來**（坑第 31 條）。
   * 這裡唯一多做的事是**換到世界座標**。
   */
  const center = elementCenter(mesh, els, tolDeg, pivot).applyMatrix4(M);

  const box = new THREE.Box3();
  for (const v of verts) box.expandByPoint(v.p.clone().applyMatrix4(M));

  let length = null, area = null, perimeter = null, holes = 0;

  if (kind === 'edge') {
    length = 0;
    for (const e of els) length += edgeLength(e.he, M);

  } else if (kind === 'face') {
    const regions = planarRegions(mesh, tolDeg);      // ★ 只跑一次
    const byId = new Map(regions.map(r => [r.id, r]));
    const done = new Set();
    area = 0;
    for (const e of els) {
      if (!e.face) continue;
      const reg = byId.get(e.face.region) || regions.find(r => r.faces.includes(e.face));
      if (!reg || done.has(reg)) continue;            // 同一個區域不重複算
      done.add(reg);
      const m = regionMeasure(mesh, reg, M);
      area += m.area;
      if (els.length === 1) { perimeter = m.perimeter; holes = m.holes; }
    }
  }

  return {
    kind,
    count: els.length,
    vertCount: verts.length,
    center,
    size: box.getSize(new THREE.Vector3()),
    length, area, perimeter, holes
  };
}

// ═══════════════════════════════════════════════════════
//  第 2 步：把數字畫到 3D 畫面上
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **「每一個」模式最多標幾個。**
 *
 * ⚠ **這個數字是猜的，沒有量過** —— 跟 `VERT_DOTS_MAX` 同一個誠實標記。
 * 每一個標籤是一張 canvas 材質 ＋ 一個 Sprite，**比 `VERT_DOTS_MAX`
 * 那種一整批走一個 `THREE.Points` 的東西貴得多**，所以上限低很多。
 *
 * 手上的實際數量：選一圈面 32、球一條經線 32、圓柱全選邊 96、
 * 球全選邊 960（← 這個一定要擋）。
 *
 * 🔴 **超過就不標，而且要講出實際數量**（坑第 11 條的反面：
 * ⛔ 不是沉默退回，是沉默地把畫面弄糊）。
 * 等 kang 平板實測再照真實結果調，⛔ 不要為想像中的數字辯護。
 */
export const MEASURE_LABELS_MAX = 200;

/** 座標寫成一串。⚠ 這串字最長，是「點」那一種佔位置比別人大的原因 */
function fmtXYZ(p) {
  return `(${fmtCm(p.x)}, ${fmtCm(p.y)}, ${fmtCm(p.z)})`;
}

/** 量詞：邊論條、面與點論個。⛔ 不要只寫數字（坑第 20 條：單位沒講就不是數量）*/
const UNIT_OF = { vertex: '個點', edge: '條邊', face: '個面' };

/**
 * 🔴 **選到的東西該顯示什麼字、那串字講的是哪裡。**
 *
 * kang 2026-08-25 拍板「**只有選到的才顯示**」，跟 Blender 的
 * Measurement overlay 一致 —— 方塊 12 條邊全標就已經看不清楚了。
 *
 * ── 兩種模式 ─────────────────────────────────────────
 *
 * | 模式 | 選 32 條邊時 | 畫在哪 |
 * |---|---|---|
 * | `'total'` | **一整塊讀數**（幾條／總長／外框／重心）| 🔴 **畫面左下角**，固定位置 |
 * | `'each'` | **32 個字**，每條邊中間各一個：「4.90 cm」| 元素身上（3D Sprite）|
 *
 * 🔴🔴 **`'total'` ⛔ 不畫在元素上了 —— kang 2026-08-27 實測當場退回。**
 *
 * > 他的原話：「**顯示位置..目前顯示集中在 XYZ 控制軸..這樣很難選**」
 *
 * ⚠ **病因是設計上必然，⛔ 不是巧合**：那個字站在選取的重心上，
 * 而 **gizmo 掛的就是同一個點**（兩邊都借 `elementCenter()`）——
 * 所以它們**一定**搶同一個位置，結果是數字擋住拉桿、拉桿擋住數字。
 * ⭐ 左下角那塊**不指向任何位置**，所以它擋不到任何東西。
 *
 * ⚠ **⛔ 這跟刀具第一版那個坑不一樣**：那次失敗是因為那條線
 * **指著模型上的某個位置**，畫在螢幕座標系就對不上。
 * 左下角這塊就像旁邊的 FPS 那格，⛔ 不指向任何地方。
 *
 * ⏭ **`'each'` 暫時沒有介面入口**（kang 2026-08-27：「**每一個先暫時收起來...
 * 我思考一下還有甚麼方式可以呈現..會在跟你說想法**」）——
 * ⛔ **不是不做，也 ⛔ 不是殘骸**：程式與測試都留著等他的想法。
 *
 * 🔴 **多選時一定要連數量一起寫**（「32 條邊」那半）——
 * 只寫「156.83」會被讀成「某一條有這麼長」。⭐ 而且兩個數字擺在一起
 * 就互相驗得起來：156.83 ÷ 32 ＝ 4.90，對不上會被**使用者**看見（鐵律三）。
 *
 * ── ⛔ 數字不在這裡另算一份 ──────────────────────────────
 * 總計那一組直接問 `measureSelection()`，**跟右邊面板同一個來源**。
 * 兩邊各算一次的話遲早會不一致，而且畫面上看不出來（坑第 31 條）。
 *
 * ── ⚠ 面：同一個共面區域只標一次 ────────────────────────
 * 「一個面」是共面區域不是三角形。同一個區域被選到兩個 face element 時
 * 硬標兩次，畫面上就是兩個字疊在一起（而且數字一模一樣）。
 *
 * ⚠ **`planarRegions()` 在這裡只跑一次**，⛔ 不是每個面跑一次
 * （它是掃全網格的，選 32 個面就會變成掃 32 遍 —— 坑第 3、22 條）。
 *
 * @param {'total'|'each'} opt.mode
 * @param {'median'|'active'} opt.pivot 跟 gizmo 掛的中心同一個
 * @returns {{items:{text:string,pos:THREE.Vector3}[],
 *            total:number, shown:number, tooMany:boolean}}
 *          `total` ＝ 這份選取在 `'each'` 下**本來會有幾個字**；
 *          `tooMany` ＝ 被上限擋掉了，呼叫端**必須講出來**
 */
export function measureLabels(mesh, els, M, opt = {}) {
  const mode = opt.mode === 'each' ? 'each' : 'total';
  const pivot = opt.pivot || 'median';
  const tolDeg = opt.tolDeg ?? 0.5;
  const max = opt.max ?? MEASURE_LABELS_MAX;
  const none = { items: [], total: 0, shown: 0, tooMany: false };

  if (!mesh || !Array.isArray(els) || !els.length) return none;
  const kind = els[0].kind;

  // ── 總計：一整塊讀數（畫在畫面左下角，⛔ 不畫在元素上）──
  if (mode === 'total') {
    const ms = measureSelection(mesh, els, M, pivot, tolDeg);
    if (!ms) return none;

    const many = els.length > 1;
    const rows = [];

    /** 第一行：選到幾個、什麼型別。⛔ 沒有單位就不是數量（坑第 20 條）*/
    rows.push(many
      ? `${els.length} ${UNIT_OF[kind] || '個'}（共 ${ms.vertCount} 個頂點）`
      : `1 ${UNIT_OF[kind] || '個'}`);

    /** 第二行：尺寸。⚠ 哪些量有意義是 `measureSelection()` 決定的，這裡只管排版 */
    const dim = [];
    if (ms.length !== null) dim.push(`${many ? '總長' : '長度'} ${fmtCm(ms.length)} cm`);
    if (ms.area !== null) dim.push(`${many ? '總面積' : '面積'} ${fmtCm(ms.area)} cm²`);
    if (ms.perimeter !== null) dim.push(`周長 ${fmtCm(ms.perimeter)} cm`);
    if (ms.holes) dim.push(`（有 ${ms.holes} 個洞，周長只算外緣）`);
    if (dim.length) rows.push(dim.join('　'));

    /** 第三行：外框。只有多選才有意義（單選一條邊的外框就是它自己）*/
    if (many) {
      rows.push(`外框 ${fmtCm(ms.size.x)} × ${fmtCm(ms.size.y)} × ${fmtCm(ms.size.z)} cm`);
    }

    /**
     * 最後一行：座標。
     * ⚠ 單選一個點時上面那些量全是 `null`，所以這一行就是它**自己的位置**，
     * ⛔ 不要寫「重心」—— 一個點的重心就是它自己，那兩個字只會讓人多想一次。
     */
    const isOneVert = kind === 'vertex' && !many;
    rows.push((isOneVert ? '座標' : (many && pivot === 'active' ? '中心（最後選的）' : '重心'))
      + ` X ${fmtCm(ms.center.x)}　Y ${fmtCm(ms.center.y)}　Z ${fmtCm(ms.center.z)} cm`);

    /**
     * ⚠ **`pos` 在這個模式下呼叫端用不到**（左下角那塊是固定位置）——
     * 但它照樣要給：`measureLabels()` 是純資料函式，
     * 回「這串字 ＋ 它講的是哪裡」才是完整的描述，用不用是呼叫端的事。
     * ⭐ 而且測試守著它，⛔ 不是殘骸。
     */
    return {
      items: [{ text: rows.join('\n'), pos: ms.center.clone() }],
      total: 1, shown: 1, tooMany: false
    };
  }

  // ── 每一個：先數，超過上限就整批不畫 ──────────────────
  /** 面要先摺成「不重複的共面區域」才知道實際會有幾個字 */
  let units = els;
  let regionOfEl = null;
  if (kind === 'face') {
    const regions = planarRegions(mesh, tolDeg);          // ★ 只跑一次
    const byId = new Map(regions.map(r => [r.id, r]));
    regionOfEl = new Map();
    const seen = new Set();
    units = [];
    for (const e of els) {
      if (!e.face) continue;
      const reg = byId.get(e.face.region) || regions.find(r => r.faces.includes(e.face));
      if (!reg || seen.has(reg)) continue;
      seen.add(reg);
      regionOfEl.set(e, reg);
      units.push(e);
    }
  }

  const total = units.length;
  if (!total) return none;
  if (total > max) return { items: [], total, shown: 0, tooMany: true };

  const items = [];
  for (const e of units) {
    if (kind === 'edge') {
      const a = e.he.v.p.clone().applyMatrix4(M);
      const b = e.he.to.p.clone().applyMatrix4(M);
      items.push({
        text: `${fmtCm(a.distanceTo(b))} cm`,
        pos: a.clone().add(b).multiplyScalar(0.5)          // 邊的中點
      });

    } else if (kind === 'face') {
      const m = regionMeasure(mesh, regionOfEl.get(e), M);
      items.push({
        text: `${fmtCm(m.area)} cm²`,
        /**
         * ⚠ **位置借 `elementCenter()`，⛔ 不自己再算一次平均** ——
         * 那正是 gizmo 掛的那個點，所以**字會長在箭頭那裡**，
         * 使用者不必猜這個數字在講哪一片（規格「重心借 elementCenter」同一條）。
         */
        pos: elementCenter(mesh, e, tolDeg).applyMatrix4(M)
      });

    } else {
      const p = e.vert.p.clone().applyMatrix4(M);
      items.push({ text: fmtXYZ(p), pos: p });
    }
  }

  return { items, total, shown: items.length, tooMany: false };
}
