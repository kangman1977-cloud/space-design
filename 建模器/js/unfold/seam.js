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

import * as THREE from 'three';
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
  /**
   * 🔴 **環切加出來的邊是這條規則的第一個例外。**
   *
   * 上面那句「共面 → 看不見」擋的是**三角化的對角線** —— 沒有人加它、
   * 畫面上也沒有它。而環切的線是**使用者自己切的**，`scene.js` 也會把它
   * 畫出來，所以「畫面上看得見的稜線才是可以標的邊」這條判準仍然成立 ——
   * 只是「看得見」的定義多了一種來源。
   *
   * ⚠ 不放行的話環切等於白做：實測方塊切完，新的一圈 4 條邊
   * **「點得到」的 0 條**，連選都選不到，更別說拉。
   */
  if (he.hard) return true;
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

/** 這個共面區域周圍是不是已經整圈切開了（用來讓「切出這個面」變成可切換） */
export function faceIsCutOut(mesh, face, tolDeg = FLAT_TOL_DEG) {
  if (!face) return false;
  planarRegions(mesh, tolDeg);
  const rid = face.region;
  if (rid === undefined || rid < 0) return false;

  let any = false;
  for (const f of mesh.faces) {
    if (f.region !== rid) continue;
    for (const he of mesh.faceLoop(f)) {
      const nb = he.twin && he.twin.face;
      if (!nb || nb.region === rid) continue;
      if (!isMarkable(mesh, he, tolDeg)) continue;
      any = true;
      if (!isSeam(he)) return false;       // 有一條沒切 → 還沒整圈切開
    }
  }
  return any;
}

// ═══════════════════════════════════════════════════════
//  點到哪一個頂點、哪一條邊、哪一個面
// ═══════════════════════════════════════════════════════
//
// 這一段是「點選」的幾何部分，刻意放在這裡而不是 select.js，
// 因為它不碰 DOM 也不碰 three.js 的場景 —— 所以**測得到**。
// select.js 只留真正的滑鼠／觸控事件那一層。
//
// ⚠ 這幾個函式**已經不只分片在用了** —— 貼合（mate.js）也用同一組。
//    再有第三個功能要用的話，就該搬到自己的模組（例如 core/pick.js），
//    現在不搬是因為搬動會動到已經驗證過的 seam.js 匯出與 select.js 匯入，
//    而那是為了整齊去冒險改能用的東西。
//
// 又是同一條原則：要讓東西測得到，就把不碰 DOM 的那一半抽出來。
//
// ── 為什麼用「命中點」而不是 raycast 給的 faceIndex ──────
// scene.js 是把網格轉成 three.js 的 BufferGeometry 才畫出來的，
// 中間經過三角化，raycast 回傳的 faceIndex 是**三角形編號**，
// 不是半邊網格的面。要對回去得另外維護一份對照表，而那份表
// 一旦跟 toGeometry() 的順序脫節就會靜靜地指錯面。
//
// 改用「命中點的 3D 座標」就完全避開這件事：座標是幾何事實，
// 不依賴任何編號。而且命中點必定落在**朝向鏡頭的那一面**上，
// 所以背面的邊不會被誤選 —— 這是免費送的。

/**
 * 離這個點最近的頂點。貼合的「點對點」用。
 *
 * 只回傳**有面連著**的頂點 —— 網格裡不該有孤立頂點，但布林運算或
 * 讀進來的舊檔可能留下，那種點貼上去毫無意義。
 */
export function nearestVertex(mesh, p) {
  let best = null;
  for (const v of mesh.verts) {
    if (!v.he) continue;
    const d = p.distanceTo(v.p);
    if (!best || d < best.dist) best = { vert: v, dist: d };
  }
  return best;
}

/** 點到線段的最短距離 */
export function distPointSeg(p, a, b) {
  const ab = b.clone().sub(a);
  const L2 = ab.lengthSq();
  if (L2 < 1e-20) return p.distanceTo(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / L2));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/**
 * 離這個點最近的「可標記的邊」。
 * @param {THREE.Vector3} p 物件本地座標系的點（通常是 raycast 的命中點）
 * @returns {{he, dist}|null}
 */
export function nearestMarkableEdge(mesh, p, tolDeg = FLAT_TOL_DEG) {
  let best = null;
  for (const he of markableEdges(mesh, tolDeg)) {
    const d = distPointSeg(p, he.v.p, he.to.p);
    if (!best || d < best.dist) best = { he, dist: d };
  }
  return best;
}

/** 點到一個面（多邊形）的最短距離。面不一定是三角形，所以直接處理多邊形。 */
export function distPointFace(mesh, face, p) {
  const vs = mesh.faceVerts(face).map(v => v.p);
  if (vs.length < 3) return Infinity;

  const n = face.normal;
  // 法向可能還沒算過（computeNormals 由 planarRegions 等呼叫端負責）
  if (!n || n.lengthSq() < 0.5) return nearestEdgeDist(vs, p);

  // 投影到面的平面上
  const q = p.clone().addScaledVector(n, -(p.clone().sub(vs[0]).dot(n)));

  // 在平面上建一組基底，把多邊形與投影點都攤成 2D，做點在多邊形內判定
  const u = new THREE.Vector3().subVectors(vs[1], vs[0]).normalize();
  const v = new THREE.Vector3().crossVectors(n, u);
  const to2 = w => [w.clone().sub(vs[0]).dot(u), w.clone().sub(vs[0]).dot(v)];
  const poly = vs.map(to2);
  const [px, py] = to2(q);

  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) &&
        px < ((xj - xi) * (py - yi)) / (yj - yi || 1e-20) + xi) inside = !inside;
  }
  if (inside) return p.distanceTo(q);
  return nearestEdgeDist(vs, p);
}

function nearestEdgeDist(vs, p) {
  let d = Infinity;
  for (let i = 0; i < vs.length; i++) {
    d = Math.min(d, distPointSeg(p, vs[i], vs[(i + 1) % vs.length]));
  }
  return d;
}

/**
 * 離這個點最近的面。給「一鍵切出一個面」用。
 *
 * 不需要百分之百精準 —— 因為拿到面之後會立刻擴張成整個共面區域，
 * 選到隔壁那個共面的三角形，得到的是**同一個區域**。
 * 只有點在區域交界上才會有差別，而那時候使用者本來就點在邊界上。
 */
export function nearestFace(mesh, p) {
  mesh.computeNormals();
  let best = null;
  for (const f of mesh.faces) {
    const d = distPointFace(mesh, f, p);
    if (!best || d < best.dist) best = { face: f, dist: d };
  }
  return best;
}
