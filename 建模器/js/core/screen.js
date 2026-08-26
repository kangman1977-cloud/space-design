/**
 * screen.js — 世界座標 → 螢幕座標
 *
 * 框選要問的是：「這個物件在畫面上有沒有落在我拉的矩形裡」。
 * 那是一個投影問題，而投影只需要相機，**不需要 DOM 也不需要場景** ——
 * 所以整段抽在這裡，測得到。
 *
 * select.js 只留真正的滑鼠／觸控事件那一層。
 * 又是同一條：要讓東西測得到，就把不碰 DOM 的那一半抽出來。
 *
 * 世界座標單位 cm，螢幕座標單位 px（原點在畫布左上角）。
 */

import * as THREE from 'three';

/**
 * 物件的外框投影到螢幕之後，佔住的矩形。
 *
 * ── 為什麼要投影八個角，不能只投影中心 ────────────────
 * 一個很長的物件，中心可能落在框外，但大半個身體在框裡。
 * 只看中心的話那種物件永遠選不到，而使用者會覺得框選壞掉。
 *
 * ── 相機後面的東西 ────────────────────────────────────
 * 透視投影下，位於相機後方的點投影出來會**左右上下顛倒**，
 * 直接拿來算外框會得到一個橫跨整個畫面的假矩形，
 * 於是框選一拉就把所有東西都選進來。
 * 所以在相機後面的角要丟掉；八個角全在後面就是完全看不到，回傳 null。
 *
 * @returns {{x0,y0,x1,y1}|null} null ＝ 這個物件不在畫面上
 */
export function screenBounds(box, camera, w, h) {
  if (!box || box.isEmpty()) return null;

  const min = box.min, max = box.max;
  const p = new THREE.Vector3();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  let seen = 0;

  for (let i = 0; i < 8; i++) {
    p.set((i & 1) ? max.x : min.x, (i & 2) ? max.y : min.y, (i & 4) ? max.z : min.z);
    p.applyMatrix4(camera.matrixWorldInverse);
    // 透視相機看向 −Z，所以 z ≥ 0 代表這個角在相機後面（或正好在鏡頭上）
    if (camera.isPerspectiveCamera && p.z >= -1e-6) continue;
    p.applyMatrix4(camera.projectionMatrix);

    const sx = (p.x * 0.5 + 0.5) * w;
    const sy = (-p.y * 0.5 + 0.5) * h;
    if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;

    x0 = Math.min(x0, sx); x1 = Math.max(x1, sx);
    y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    seen++;
  }

  if (!seen) return null;
  return { x0, y0, x1, y1 };
}

/** 兩個矩形有沒有交集。邊碰邊算有。 */
export function rectHit(a, b) {
  if (!a || !b) return false;
  return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

/** a 有沒有完全包在 b 裡面 */
export function rectInside(a, b) {
  if (!a || !b) return false;
  return a.x0 >= b.x0 && a.x1 <= b.x1 && a.y0 >= b.y0 && a.y1 <= b.y1;
}

/** 把拖曳的兩個端點整理成左上／右下 */
export function normRect(x1, y1, x2, y2) {
  return {
    x0: Math.min(x1, x2), y0: Math.min(y1, y2),
    x1: Math.max(x1, x2), y1: Math.max(y1, y2)
  };
}

/**
 * 一個世界座標的點投影到螢幕上的哪裡。
 *
 * @returns {{x:number,y:number}|null} null ＝ 在相機後面或算不出來
 */
export function projectPoint(p, camera, w, h) {
  if (!p || !camera) return null;
  const q = p.clone().applyMatrix4(camera.matrixWorldInverse);
  if (camera.isPerspectiveCamera && q.z >= -1e-6) return null;
  q.applyMatrix4(camera.projectionMatrix);
  const x = (q.x * 0.5 + 0.5) * w;
  const y = (-q.y * 0.5 + 0.5) * h;
  return (Number.isFinite(x) && Number.isFinite(y)) ? { x, y } : null;
}

/** 一個點在不在框裡 */
export function pointInRect(s, rect) {
  return !!s && !!rect && s.x >= rect.x0 && s.x <= rect.x1 && s.y >= rect.y0 && s.y <= rect.y1;
}

/**
 * 一條線段有沒有碰到框（兩端在框裡、或穿過框）。
 *
 * ⚠ **⛔ 不可以只看兩端在不在框裡** —— 一條長邊可以整條橫跨框、
 * 兩端都在外面，那時候使用者明明框到它了卻選不到。
 * 用「線段 vs 矩形」的標準判定：先看端點，再看跟四條邊有沒有交叉。
 */
export function segHitRect(a, b, rect) {
  if (!a || !b || !rect) return false;
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true;
  /** 整條都在框的同一側 → 不可能碰到（便宜的早退） */
  if ((a.x < rect.x0 && b.x < rect.x0) || (a.x > rect.x1 && b.x > rect.x1)) return false;
  if ((a.y < rect.y0 && b.y < rect.y0) || (a.y > rect.y1 && b.y > rect.y1)) return false;
  const cross = (p, q, r, s) => {
    const d = (q.x - p.x) * (s.y - r.y) - (q.y - p.y) * (s.x - r.x);
    if (Math.abs(d) < 1e-12) return false;
    const t = ((r.x - p.x) * (s.y - r.y) - (r.y - p.y) * (s.x - r.x)) / d;
    const u = ((r.x - p.x) * (q.y - p.y) - (r.y - p.y) * (q.x - p.x)) / d;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1;
  };
  const c = [
    { x: rect.x0, y: rect.y0 }, { x: rect.x1, y: rect.y0 },
    { x: rect.x1, y: rect.y1 }, { x: rect.x0, y: rect.y1 }
  ];
  for (let i = 0; i < 4; i++) if (cross(a, b, c[i], c[(i + 1) % 4])) return true;
  return false;
}

/**
 * 🔴 **框選子元素：哪些點／邊／面落在框裡。**
 *
 * ── 🔴 連背面一起選（kang 2026-08-26 拍板）─────────────
 * > 跟刀具那條「**點到哪切到哪**」同一個作風 ——
 * > 而且**選一整條經線、選一整圈**這種事本來就要包含背面。
 *
 * ⚠ **代價是「會選到看不見的東西」**，所以呼叫端**一定要講出數量**
 * （坑第 11、21 條：選了什麼看不出來，比沒選到更難查）。
 * ⛔ 不可以安靜地多選一堆。
 *
 * ── 各自的判準 ────────────────────────────────────────
 * | 型別 | 算選到的條件 |
 * |---|---|
 * | 點 | 投影落在框裡 |
 * | 邊 | 線段**碰到**框（⛔ 不是兩端都要在框裡）|
 * | 面 | **重心**落在框裡 |
 *
 * ⚠ **面為什麼看重心，不看「有沒有碰到」**：一個大面只要邊角掃到框
 * 就被選走的話，框選會變得完全不可控 —— 而面通常是一片一片挑的。
 * 〔跟「碰到就算」那條物件層級的規則**刻意不同**，理由寫在這裡：
 * 　物件的外框比實體大所以要放寬，面就是實體本身，不必放寬〕
 *
 * @param {{verts?:Array,edges?:Array,faces?:Array}} items
 *        每一項都是 `{el, pts:THREE.Vector3[]}`（世界座標）：
 *        點給 1 個、邊給 2 個、面給 1 個（重心）
 * @returns {{verts:Array, edges:Array, faces:Array}} 選到的 `el`
 */
export function elementsInRect(items, rect, camera, w, h) {
  const out = { verts: [], edges: [], faces: [] };
  if (!items || !rect || !camera) return out;
  const pr = p => projectPoint(p, camera, w, h);

  for (const it of (items.verts || [])) {
    if (pointInRect(pr(it.pts[0]), rect)) out.verts.push(it.el);
  }
  for (const it of (items.edges || [])) {
    const a = pr(it.pts[0]), b = pr(it.pts[1]);
    if (a && b && segHitRect(a, b, rect)) out.edges.push(it.el);
  }
  for (const it of (items.faces || [])) {
    if (pointInRect(pr(it.pts[0]), rect)) out.faces.push(it.el);
  }
  return out;
}

/**
 * 哪些物件落在框裡。
 *
 * @param {object} opt.enclose true ＝ 要整個包住才算（Illustrator 的行為）；
 *                             false ＝ 碰到就算（預設）
 *
 * 預設用「碰到就算」，因為 3D 裡物件常常互相遮擋、外框又比實體大，
 * 要求整個包住的話大件永遠選不到。真的只想要小件時再拉緊一點就好 ——
 * **選太多比選不到容易補救**（多按一下 Shift 取消，而選不到只能放棄）。
 *
 * @returns {number[]} ModelObject.id
 */
export function objectsInRect(entries, rect, camera, w, h, opt = {}) {
  const enclose = !!opt.enclose;
  const out = [];
  for (const { id, box } of entries) {
    const sb = screenBounds(box, camera, w, h);
    if (!sb) continue;
    if (enclose ? rectInside(sb, rect) : rectHit(sb, rect)) out.push(id);
  }
  return out;
}
