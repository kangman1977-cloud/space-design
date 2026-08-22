/**
 * seam.js — 指定分片
 *
 * 「立體造型必須做規劃，如何分配展開的區域，能夠依序讓 CNC
 *   切割後再組裝結合。」（kang）
 *
 * 一個立方體可以六面展成一片（銑 45 度 V 溝折起來），也可以拆成三片，
 * 也可以六片全分開。**選哪一種是製造決定，不是計算結果** ——
 * 少一片就少一道對位誤差，但要多一道銑溝工序。
 *
 * 在這個檔案出現之前，接縫位置是攤平生成樹走訪順序的副產品，
 * 不是任何人的判斷。這裡把那個決定權交回給使用者。
 *
 * ── 這個檔案不做什麼 ──────────────────────────────────
 * 幾何運算一行都沒有。它只做一件事：**把某些邊的角色改成 CUT**。
 * 之後 flatten.js 的 edgeIsCut() 第二件事就是尊重 EDGE_ROLE.CUT
 * （第一件是「沒有隔壁就是邊界」），所以分片自然就跟著變。
 *
 * 也因此這裡完全不需要知道材料是什麼 —— 又是同一條
 * 「規則分開、幾何共用」。
 *
 * ── 只做「強制切開」，不做「強制折起來」──────────────
 * 標成 CUT ＝ 我要它切開，一定做得出來（多切一刀而已）。
 * 取消標記 ＝ 交還給材料規則決定，**不是**強迫它折起來。
 *
 * 這個不對稱是刻意的。若允許「強制折起來」，使用者就能在壓克力上
 * 標一條折線 —— 而壓克力物理上折不起來，那張圖做不出來。
 * 現在這個設計**不可能**產生做不出來的圖。
 *
 * ── 只有已烘成網格的物件標得起來 ──────────────────────
 * 參數物件（{type:'box', w:60...}）存檔只存參數，開檔時網格重新生成、
 * autoMarkFolds() 重跑，標記就沒了。而它在同一次開著的時候又是好的
 * （ModelObject._mesh 有快取）—— 這種「用起來正常、存檔重開才發現
 * 不見了」是最糟的一種失敗。
 *
 * 所以正確順序是：**尺寸先確定 → 轉成可編輯網格 → 標分片 → 出圖。**
 * 呼叫端要用 canMarkSeams() 擋住參數物件，並說明原因。
 *
 * 單位一律 cm。這個檔案不碰 DOM，所以測得到。
 */

import { EDGE_ROLE } from '../core/mesh.js';
import { planarRegions } from '../core/region.js';
import { FLAT_TOL_DEG } from './flatten.js';

// ═══════════════════════════════════════════════════════
//  哪些邊可以標
// ═══════════════════════════════════════════════════════

/**
 * 這條邊能不能讓使用者標？
 *
 * 兩種邊要排除：
 *
 * 1. **邊界邊**（沒有隔壁的面）—— 它本來就是外輪廓，
 *    標了也沒有意義，取消更是做不到。
 *
 * 2. **共面的對角線** —— 這是三角化的產物。一個正方形面在網格裡
 *    是兩個三角形，中間那條對角線也是一條「邊」，但它在畫面上
 *    看不到，因為 scene.js 畫稜線用的是 EdgesGeometry(geometry, 1)，
 *    只畫轉折超過 1 度的邊。
 *
 *    讓使用者標到看不見的邊，結果會是「一個面被斜切成兩個三角形」——
 *    正確但絕對不是他要的，而且他根本不知道自己點了什麼。
 *
 * 所以判準是：**畫面上看得見的稜線，才是可以標的邊。** 兩者必須是
 * 同一組，否則畫面就在騙人（跟平面規劃器「命中判斷與繪製必須用
 * 同一個函式」是同一條教訓）。
 */
export function isMarkable(mesh, he, tolDeg = FLAT_TOL_DEG) {
  if (!he.twin || !he.face || !he.twin.face) return false;   // 邊界
  return !mesh.isFlat(he, tolDeg);                           // 共面 → 看不見
}

/** 所有可以標的邊。每條邊只回傳一次（edges() 已經保證了）。 */
export function markableEdges(mesh, tolDeg = FLAT_TOL_DEG) {
  return [...mesh.edges()].filter(he => isMarkable(mesh, he, tolDeg));
}

/**
 * 這個物件能不能標分片？
 * 參數物件不行，理由見檔頭。回傳 null ＝ 可以，回傳字串 ＝ 不行的原因。
 */
export function seamBlockReason(obj) {
  if (!obj) return '沒有選取物件';
  if (obj.isParametric) {
    return '參數物件的分片標記存不進檔案（開檔時形狀會照參數重新生成）。'
         + '請先按「轉成可編輯網格」——但那之後就不能再改尺寸了，'
         + '所以請確定尺寸不會再動。';
  }
  return null;
}

export function canMarkSeams(obj) { return seamBlockReason(obj) === null; }

// ═══════════════════════════════════════════════════════
//  標記
// ═══════════════════════════════════════════════════════

/** 這條邊是不是使用者標的接縫 */
export function isSeam(he) { return he.role === EDGE_ROLE.CUT; }

/**
 * 設定一條邊要不要切開。
 *
 * 取消時回到 FOLD，**不是**回到 FREE —— 因為可標記的邊依定義就是
 * 非共面的，autoMarkFolds() 本來就會把它標成 FOLD。回到 FOLD 等於
 * 「交還給材料規則決定」，這正是取消標記該有的意思。
 *
 * 一定要走 mesh.setRole()，它會同時設兩條半邊。只設單邊的話，
 * edges() 可能剛好讀到另一條，看起來就像沒設（踩過的坑第 1 條）。
 */
export function setSeam(mesh, he, on, tolDeg = FLAT_TOL_DEG) {
  if (!isMarkable(mesh, he, tolDeg)) return false;
  mesh.setRole(he, on ? EDGE_ROLE.CUT : EDGE_ROLE.FOLD);
  return true;
}

export function toggleSeam(mesh, he, tolDeg = FLAT_TOL_DEG) {
  return setSeam(mesh, he, !isSeam(he), tolDeg);
}

/** 目前標了幾條 */
export function seamCount(mesh, tolDeg = FLAT_TOL_DEG) {
  return markableEdges(mesh, tolDeg).filter(isSeam).length;
}

/** 清掉全部標記，回到自動判斷。邊界邊不動（它們本來就該是 CUT）。 */
export function clearSeams(mesh, tolDeg = FLAT_TOL_DEG) {
  let n = 0;
  for (const he of markableEdges(mesh, tolDeg)) {
    if (isSeam(he)) { mesh.setRole(he, EDGE_ROLE.FOLD); n++; }
  }
  return n;
}

// ═══════════════════════════════════════════════════════
//  一鍵切出一個面
// ═══════════════════════════════════════════════════════

/**
 * 把一個面周圍全部切開，讓它獨立成一片。
 *
 * ── 為什麼需要這個 ────────────────────────────────────
 * 因為**標一條邊通常什麼都不會發生**。實測：60×45×40 的方塊標 1 條
 * 邊，片數仍然是 1。要切到足以把面的鄰接關係切斷才會多一片 ——
 * 上面那個例子要切滿一個面周圍的邊才變成 2 片。
 *
 * 這在數學上完全正確，但使用者標了一條邊、畫面毫無反應，第一個念頭
 * 一定是「壞了」。而「讓人不敢相信工具給的東西」是這個專案踩過最多
 * 次的坑（第 5、18 條）。所以除了即時顯示片數，還要給一個
 * **一按就看得到結果**的操作。
 *
 * ── 「一個面」指的是共面區域，不是三角形 ──────────────
 * 方塊在網格裡是 12 個三角形，但使用者看到的是 6 個正方形面。
 * 所以這裡先用 planarRegions() 把共面的三角形合併成區域，
 * 再切那個區域的邊界。點方塊的一個面，切的是 4 條邊不是 3 條。
 *
 * @param {Mesh} mesh
 * @param {Face} face  區域裡的任一個面（通常是點選命中的那個三角形）
 * @param {boolean} on true ＝ 切開；false ＝ 取消
 * @returns {number} 實際改動的邊數
 */
export function cutAroundFace(mesh, face, on = true, tolDeg = FLAT_TOL_DEG) {
  if (!face) return 0;

  // planarRegions() 是「貼標籤」不是重建網格，跑幾次都不會把資料弄壞
  planarRegions(mesh, tolDeg);
  const rid = face.region;
  if (rid === undefined || rid < 0) return 0;

  let n = 0;
  for (const f of mesh.faces) {
    if (f.region !== rid) continue;
    for (const he of mesh.faceLoop(f)) {
      const nb = he.twin && he.twin.face;
      if (!nb || nb.region === rid) continue;      // 區域內部的邊不動
      if (setSeam(mesh, he, on, tolDeg)) n++;
    }
  }
  return n;
}
