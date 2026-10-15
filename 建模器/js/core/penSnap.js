/**
 * penSnap.js — 鋼筆的「智慧參考線」：放點時跟別的點對齊、吸到參考線
 * （kang 2026-10-15 拍板：「在允許的條件下在操作方式上能夠與AI繪圖軟體一致」）
 *
 * 只做數學：給游標在地板上的位置（x, z）＋ 一堆可以對齊的東西 ＋ 容許距離，
 * 回「吸過去之後的位置」與「為什麼吸過去」（畫粉紅線、標字用）。
 * ⛔ 不碰 DOM、⛔ 不碰相機 —— 容許距離由呼叫端照「畫面上幾 px」換算好再傳進來，
 * 所以整支在 Node 裡測得到。
 *
 * ── 跟 Illustrator 一樣的三種吸法 ──────────────────────
 * - **對齊**：游標跟某個點**同一個 X**（或同一個 Z）→ 吸到那條直線上，畫一條粉紅線連過去
 * - **交集**：兩個方向都對齊（可以是兩個不同的點）→ 吸到兩條線的交叉處
 * - **參考線**：靠近參考線（地板上那條直線）→ 吸上去
 * ⭐ 剛好落在某個點上就標「錨點」—— 那是交集的特例（兩個方向對到同一個點）。
 *
 * ── 對齊的對象（kang 2026-10-15 拍板）──────────────────
 * 這條線自己的點 ＋ 參考線 ＋ **別的物件貼在地板上那一圈外框的四個角與中心**。
 * ⚠ ⛔ 用別的物件的每一個頂點 —— 一顆球幾百個點，粉紅線會到處跳。
 *
 * ── 🔴 參考線只有 X 與 Z 兩種算數 ───────────────────────
 * 參考線是一個**平面**（`io.js` `GUIDE_AXES`）；鋼筆畫在地板上，
 * 所以只有跟地板**交成一條線**的那兩種有用：`x ＝ c`（前後方向）與 `z ＝ c`（左右方向）。
 * `y ＝ c` 跟地板平行，⛔ 交不出線 ⇒ 不管。
 */

/**
 * @param {number} x 游標在地板上的 X
 * @param {number} z 游標在地板上的 Z
 * @param {object} o
 *   `points` [{x, z}] 可以對齊的點（這條線自己的錨點、別的物件外框的角與中心）
 *   `guides` { x:[…], z:[…] } 參考線的位置（`Doc.guides`；`y` 不看）
 *   `tol`    多近才吸（世界單位 cm，呼叫端從 px 換算）
 * @returns {{x:number, z:number, label:string,
 *            fromX:{x,z}|null, fromZ:{x,z}|null, guideX:number|null, guideZ:number|null}}
 *   `fromX`：讓 X 對齊的那個點（粉紅線從它畫到吸過去的位置）；`guideX`：讓 X 吸上去的參考線
 */
export function penSmartSnap(x, z, o = {}) {
  const tol = +o.tol > 0 ? +o.tol : 0;
  const pts = (o.points || []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.z));
  const gx = (o.guides && o.guides.x) || [];
  const gz = (o.guides && o.guides.z) || [];

  /** 一個方向挑**最近**的那一個；⚠ 參考線跟點一起比，誰近吸誰 */
  const best = (v, key, guides) => {
    let at = null, d = tol, from = null, guide = null;
    for (const p of pts) {
      const e = Math.abs(p[key] - v);
      if (e <= d) { d = e; at = p[key]; from = p; guide = null; }
    }
    for (const g of guides) {
      const e = Math.abs(g - v);
      if (e < d || (e <= d && at === null)) { d = e; at = g; from = null; guide = g; }
    }
    return { at, from, guide };
  };

  const bx = best(x, 'x', gx);
  const bz = best(z, 'z', gz);
  const nx = bx.at === null ? x : bx.at;
  const nz = bz.at === null ? z : bz.at;

  let label = '';
  if (bx.at !== null || bz.at !== null) {
    const onPoint = pts.some(p => Math.abs(p.x - nx) < 1e-9 && Math.abs(p.z - nz) < 1e-9);
    label = onPoint ? '錨點'
      : (bx.at !== null && bz.at !== null) ? '交集'
      : (bx.guide !== null || bz.guide !== null) ? '參考線'
      : '對齊';
  }
  return {
    x: nx, z: nz, label,
    fromX: bx.from, fromZ: bz.from,
    guideX: bx.guide, guideZ: bz.guide
  };
}

/**
 * 物件貼在地板上那一圈外框的四個角與中心（`THREE.Box3` 或 {min,max}）。
 * ⚠ 只看 X 與 Z —— 鋼筆畫在地板上，高度⛔ 有意義。
 */
export function footprintPoints(box) {
  if (!box || !box.min || !box.max) return [];
  const { min, max } = box;
  if (!(max.x >= min.x) || !(max.z >= min.z)) return [];
  return [
    { x: min.x, z: min.z }, { x: max.x, z: min.z },
    { x: max.x, z: max.z }, { x: min.x, z: max.z },
    { x: (min.x + max.x) / 2, z: (min.z + max.z) / 2 }
  ];
}

/**
 * 打數字定長度：從 `from` 朝 `toward` 的方向，走剛好 `len`。
 * ⚠ 方向看「游標吸過去之後」的位置 —— 鎖角度、對齊都已經算進去了。
 * @returns {{ok:boolean, x?:number, z?:number, reason?:string}}
 */
export function pointAtLength(from, toward, len) {
  if (!(len > 0)) return { ok: false, reason: '長度要打一個大於 0 的數字' };
  const dx = toward.x - from.x, dz = toward.z - from.z;
  const n = Math.hypot(dx, dz);
  if (n < 1e-9) return { ok: false, reason: '游標跟上一個點疊在一起，看不出方向 —— 先把游標移開' };
  return { ok: true, x: from.x + dx / n * len, z: from.z + dz / n * len };
}
