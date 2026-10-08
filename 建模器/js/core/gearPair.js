/**
 * gearPair.js — 齒輪「咬上去」：把一個齒輪擺到剛好咬住另一個
 *
 * kang 2026-10-08：「關於這計算的方式...可以做成一個小功能..這樣方便我操作上單純化嗎?」
 * ⇒ 做成一顆按鈕（⛔ 不是換算器 —— 換算器算完還要人自己抄數字）。
 * 互動圖確認過，四題照建議拍板：
 *
 *   1. 🔴 **先選的動、後選的不動** —— 跟「貼合」（`mate.js`）同一個規則。
 *      ⚠ 一開始建議的是「後選的動」，⛔ 漏查了貼合；kang 改選跟貼合一致：
 *      整個建模器「把甲接到乙」只有一種規則。
 *   2. 🔴 **維持動的那個現在的方向**，只調距離與角度（⛔ 不是一律擺到 +X）。
 *   3. 🔴 **模數不同 → 改成跟不動的那個一樣，而且說出來**（⛔ 不默默改）。
 *   4. 高度（Y）跟不動的那個一樣 —— 兩個齒輪才在同一個平面上。
 *
 * ── 角度怎麼算 ──────────────────────────────────────
 * 2D（齒形）裡：不動的 A 轉了 θA、動的 B 在 A 的 φ 方向，B 要轉
 *
 *     θB ＝ φ ＋ π − π/zB ＋ (φ − θA)·zA/zB
 *
 * 推導：沿著兩個中心的連線，A 的齒相位 uA ＝ (φ−θA)·zA/2π（0 ＝ 齒正對 B），
 * B 的 uB ＝ (φ＋π−θB)·zB/2π；兩個一起轉時 uA ＋ uB 不變，咬上 ⇔ uA ＋ uB ≡ ½。
 * ⭐ θA ＝ 0、φ ＝ 0 時就是測試「咬合」那一項用的 π ＋ π/zB（差一個齒距，等價）。
 *
 * ⚠ **2D 角度 ↔ 世界的「旋轉 Y」差一個負號**：齒形的 (x, y) 放在世界的 (x, z)
 * （`extrude.js` 檔頭），而 three.js 繞 Y 轉 ψ 會把 (x, z) 平面上的角度減掉 ψ ⇒ θ ＝ −ψ。
 * 🔴 **⛔ 不靠推理，靠對答案**：測試拿 `ModelObject.matrix()` 把兩個齒形真的擺到世界裡，查有沒有卡住。
 *
 * 這個檔案⛔ 不改動任何東西，只回傳算出來的新位置、角度、模數 —— 跟 `mate.js` 一樣。
 * 單位 cm。⛔ 不碰 DOM，Node 裡測得到。
 */

import { gearDims } from '../build/prim.js';

const isGear = o => !!(o && o.src && o.src.type === 'gear');
const near1 = v => Math.abs(v - 1) <= 1e-9;
const near0 = v => Math.abs(v) <= 1e-9;

/**
 * @param {ModelObject} mover 動的那個（先選的）
 * @param {ModelObject} anchor 不動的那個（後選的）
 * @returns {{ok:false, reason:string} |
 *           {ok:true, pos:{x,y,z}, rotY:number, module:number|null, dist:number, notes:string[]}}
 *   `rotY` 是弧度；`module` 只有要改的時候才有值
 */
export function meshGearPair(mover, anchor) {
  if (!isGear(mover) || !isGear(anchor)) {
    return { ok: false, reason: '要選兩個齒輪' };
  }
  for (const o of [mover, anchor]) {
    const s = o.scale;
    if (!(near1(s.x) && near1(s.y) && near1(s.z))) {
      return { ok: false, reason: `「${o.name}」被縮放過 —— 先把縮放改回 1（大小請改「模數」）` };
    }
    if (!(near0(o.rot.x) && near0(o.rot.z))) {
      return { ok: false, reason: `「${o.name}」沒有平躺 —— 旋轉的 X、Z 要是 0（只能繞 Y 轉）` };
    }
  }

  const gA = gearDims(anchor.src);
  const notes = [];
  let module = null;
  const gB0 = gearDims(mover.src);
  if (Math.abs(gB0.m - gA.m) > 1e-9) {
    module = gA.m;
    notes.push(`「${mover.name}」的模數從 ${+gB0.m.toFixed(4)} 改成 ${+gA.m.toFixed(4)}（跟「${anchor.name}」一樣才咬得住），`
      + `所以它的大小也跟著變了`);
  }
  const gB = gearDims({ ...mover.src, module: gA.m });

  // 方向：維持動的那個現在在不動的那個的哪一邊；疊在一起分不出來 → 擺到 +X
  let dx = mover.pos.x - anchor.pos.x, dz = mover.pos.z - anchor.pos.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-9) { dx = 1; dz = 0; notes.push('兩個疊在同一個位置，分不出方向 —— 擺到右邊（+X）'); }
  else { dx /= len; dz /= len; }

  const dist = gA.m * (gA.z + gB.z) / 2;
  const phi = Math.atan2(dz, dx);
  const thA = -anchor.rot.y;
  const thB = phi + Math.PI - Math.PI / gB.z + (phi - thA) * gA.z / gB.z;
  // 一個齒距之內都一樣 —— 收到 [0, 360/zB) 度，面板上的數字才不會是一個很大的角度
  const pitch = 2 * Math.PI / gB.z;
  let rotY = (-thB) % pitch;
  if (rotY < 0) rotY += pitch;

  return {
    ok: true,
    pos: { x: anchor.pos.x + dx * dist, y: anchor.pos.y, z: anchor.pos.z + dz * dist },
    rotY, module, dist, notes
  };
}
