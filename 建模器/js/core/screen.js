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
