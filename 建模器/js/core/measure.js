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
