/**
 * align.js — 對齊與均分
 *
 * kang 的原話（2026-08-22）：「當有一個造型是由多個物件所組合時，
 * 每個物件要如何準確的移動到正確位置……希望編輯的方式可以類似 AI 軟體。」
 *
 * 他貼的 Illustrator 面板有兩塊：「路徑管理員」與「對齊」。
 * **路徑管理員那半建模器已經有了**（布林的聯集／差集／交集），
 * 缺的是對齊那半 —— 就是這個檔案。
 *
 * ── 空間平面規劃器已經做過 2D 版 ──────────────────────
 * `alignSel()` / `distSel()`，但只有靠左／靠上，而且均分是對「中心」等距。
 * 這裡做完整版：三個軸 × 三種對齊，加上兩種均分。
 *
 * ── 為什麼是純函式 ────────────────────────────────────
 * 這裡的每個函式都**不改動任何東西**，只回傳「算出來的新位置」
 * （順序與輸入相同），由呼叫端決定要不要套用。
 *
 * 這樣才測得到 —— 對齊算錯了不會讓程式當掉，只會讓東西差幾公分，
 * 而那種錯用眼睛看不出來，只有拿數字對答案抓得到。
 * 又是同一條：要讓東西測得到，就把不碰 DOM 的那一半抽出來。
 *
 * 單位一律 cm。
 */

import * as THREE from 'three';

/** 三個軸。X＝左右、Y＝上下（高度）、Z＝前後。 */
export const AXIS = { X: 'x', Y: 'y', Z: 'z' };
export const AXIS_KEYS = ['x', 'y', 'z'];

/** 對齊到哪一邊 */
export const ALIGN = { MIN: 'min', CENTER: 'center', MAX: 'max' };

export const AXIS_LABEL = { x: 'X 左右', y: 'Y 上下', z: 'Z 前後' };
export const ALIGN_LABEL = {
  x: { min: '靠左', center: '水平置中', max: '靠右' },
  y: { min: '靠下', center: '垂直置中', max: '靠上' },
  z: { min: '靠後', center: '前後置中', max: '靠前' }
};

// ═══════════════════════════════════════════════════════
//  世界外框
// ═══════════════════════════════════════════════════════

/**
 * 物件在世界座標裡的外框（AABB）。
 *
 * ⚠ **不能直接拿 `obj.pos` 當作物件的位置來對齊。**
 *
 * `pos` 是物件原點的位置，而網格不一定以原點為中心 —— 折板、布林結果、
 * 陣列都可能偏一邊。拿 `pos` 去對齊，畫面上看起來就會沒對齊，
 * 而使用者只會覺得「這個對齊功能怪怪的」。
 *
 * 所以一律以**外框**為準，再回推原點該移到哪裡（見 alignPositions）。
 *
 * 旋轉過的物件用 Box3.applyMatrix4()，它會把八個角都轉過去再取外框，
 * 所以斜擺的東西也對得準（對到的是它的外接盒，這正是 Illustrator 的行為）。
 */
export function worldBounds(obj) {
  const local = obj.mesh().bounds();
  if (local.isEmpty()) return new THREE.Box3();
  return local.clone().applyMatrix4(obj.matrix());
}

/** 一群物件合起來的外框 */
export function unionBounds(objs) {
  const all = new THREE.Box3();
  for (const o of objs) {
    const b = worldBounds(o);
    if (!b.isEmpty()) all.union(b);
  }
  return all;
}

const lo = (b, ax) => b.min[ax];
const hi = (b, ax) => b.max[ax];
const mid = (b, ax) => (b.min[ax] + b.max[ax]) / 2;
const size = (b, ax) => b.max[ax] - b.min[ax];

function edge(b, ax, mode) {
  if (mode === ALIGN.MIN) return lo(b, ax);
  if (mode === ALIGN.MAX) return hi(b, ax);
  return mid(b, ax);
}

// ═══════════════════════════════════════════════════════
//  對齊
// ═══════════════════════════════════════════════════════

/**
 * 把一群物件沿某個軸對齊。
 *
 * 基準是**整組選取的外框**（Illustrator 的「對齊至：選取範圍」）。
 * 所以靠左＝全部貼到最左邊那個的左緣，置中＝全部對到整組的中線。
 *
 * @param {ModelObject[]} objs
 * @param {'x'|'y'|'z'} ax
 * @param {'min'|'center'|'max'} mode
 * @returns {THREE.Vector3[]} 每個物件的新位置，順序同輸入。不改動輸入。
 */
export function alignPositions(objs, ax, mode) {
  const out = objs.map(o => o.pos.clone());
  if (objs.length < 2) return out;          // 一個物件對誰？不動

  const bs = objs.map(worldBounds);
  const all = new THREE.Box3();
  for (const b of bs) if (!b.isEmpty()) all.union(b);
  if (all.isEmpty()) return out;

  const target = edge(all, ax, mode);

  objs.forEach((o, i) => {
    if (bs[i].isEmpty()) return;
    // 位移量 ＝ 目標邊 − 目前這一邊。加在原點上，外框就跟著過去。
    out[i][ax] += target - edge(bs[i], ax, mode);
  });
  return out;
}

// ═══════════════════════════════════════════════════════
//  均分
// ═══════════════════════════════════════════════════════

/**
 * 均分物件：讓各物件的**中心**沿某軸等距。
 *
 * 頭尾兩個不動，中間的重新排。少於三個沒有意義（頭尾就是全部）。
 *
 * 這是空間平面規劃器 `distSel()` 的做法，也是 Illustrator 的「均分物件」。
 * 物件大小一致時它跟「均分間距」結果相同；大小不一致時兩者不同，
 * 所以兩個都要提供 —— 見下面 spacePositions() 的說明。
 */
export function distributePositions(objs, ax) {
  const out = objs.map(o => o.pos.clone());
  if (objs.length < 3) return out;

  const bs = objs.map(worldBounds);
  if (bs.some(b => b.isEmpty())) return out;

  const order = objs.map((_, i) => i).sort((a, b) => mid(bs[a], ax) - mid(bs[b], ax));
  const first = mid(bs[order[0]], ax);
  const last = mid(bs[order[order.length - 1]], ax);
  const step = (last - first) / (order.length - 1);

  order.forEach((oi, k) => {
    out[oi][ax] += (first + step * k) - mid(bs[oi], ax);
  });
  return out;
}

/**
 * 均分間距：讓相鄰兩物件之間的**空隙**相等。
 *
 * ── 跟「均分物件」差在哪 ──────────────────────────────
 * 三個東西寬度 10、50、10，總跨距 100：
 *   均分物件 → 中心等距，中間那個大的兩側空隙一邊寬一邊窄
 *   均分間距 → 兩個空隙一樣寬
 * 大小一致時兩者相同，大小不一致時**看起來對的是後者**。
 * 做料架、隔板、等距排列的東西時要的都是這個。
 *
 * @param {number|null} gap 指定空隙 cm。null ＝ 沿用目前的總跨距自動算，
 *                          頭尾不動（Illustrator 不填數字時的行為）。
 */
export function spacePositions(objs, ax, gap = null) {
  const out = objs.map(o => o.pos.clone());
  if (objs.length < 2) return out;

  const bs = objs.map(worldBounds);
  if (bs.some(b => b.isEmpty())) return out;

  const order = objs.map((_, i) => i).sort((a, b) => lo(bs[a], ax) - lo(bs[b], ax));
  const sizes = order.map(i => size(bs[i], ax));
  const start = lo(bs[order[0]], ax);

  let g = gap;
  if (g === null) {
    const span = hi(bs[order[order.length - 1]], ax) - start;
    const total = sizes.reduce((s, v) => s + v, 0);
    g = (span - total) / (order.length - 1);
  }

  let cur = start;
  order.forEach((oi, k) => {
    out[oi][ax] += cur - lo(bs[oi], ax);
    cur += sizes[k] + g;
  });
  return out;
}

/**
 * 目前相鄰物件之間的空隙，沿某軸由小到大排好之後回傳。
 *
 * 給面板顯示用，也給測試對答案用 —— 「均分間距做完之後這個陣列裡的數字
 * 應該全部一樣」是一句用數字驗得到的話。
 *
 * 負數代表兩個物件在這個軸上重疊了，那是事實不是錯誤（例如互相咬合的件），
 * 所以不做任何修正，如實回傳。
 */
export function currentGaps(objs, ax) {
  if (objs.length < 2) return [];
  const bs = objs.map(worldBounds);
  if (bs.some(b => b.isEmpty())) return [];
  const order = objs.map((_, i) => i).sort((a, b) => lo(bs[a], ax) - lo(bs[b], ax));
  const out = [];
  for (let k = 1; k < order.length; k++) {
    out.push(lo(bs[order[k]], ax) - hi(bs[order[k - 1]], ax));
  }
  return out;
}
