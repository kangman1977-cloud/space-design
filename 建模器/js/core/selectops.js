/**
 * selectops.js — 選取那一組：走訪與判準（純函式）
 *
 * ── 這支檔案為什麼存在 ────────────────────────────────
 * `外部參考-Blender編輯.md` 第 10 節那張對照表，列出三大缺口：
 * **加線**（已補齊）、**補面**（已完成）、**選取**。
 * 這支是最後那一格的家。
 *
 * > **多選現在只能一個一個點。32 片 seg 要選 32 下。**
 *
 * ⚠ **⛔ 不要把這裡的東西寫回 `edit.js`。** 判準很單純：
 * **這裡的函式只回答「哪些元素」，一個頂點都不動。**
 * 會改網格的一律留在 `edit.js`。
 *
 * ⭐ **`edgeRing()` 刻意留在 `edit.js`，那不是漏搬** ——
 * 它是**環切的零件**（`loopCut()` 直接用它決定要切哪些邊），
 * 搬過來會讓 `edit.js` 反過來相依這支。〔它的雙胞胎在這裡，見下〕
 *
 * 單位一律 cm。**這個檔案不碰 DOM，所以測得到。**
 */

import { markableEdges } from '../unfold/seam.js';

/**
 * 🔴 **邊迴圈：沿著這條線一直走到底。**
 *
 * ── ⚠ 它跟「選一圈」（邊環 `edgeRing()`）是兩件事，⛔ 不要搞混 ────
 *
 * | | 走法 | 在球上選一條經線邊會拿到 |
 * |---|---|---|
 * | **邊環**（`edgeRing`，已有） | **橫著跨過**四邊形 | **繞球一圈**，每條經線各一條 |
 * | **邊迴圈**（這一支） | **順著**同一條線走 | **整條經線**，從極走到極 |
 *
 * 〔kang 2026-08-26 拍板做成兩顆按鈕：**功能之間的定位不可以互相模糊**，
 * 　跟「切一刀 vs 環切」「連接兩點 vs 面上加線」同一條〕
 *
 * ── 🔴 它翻掉了對照表上的一格（2026-08-26 實測）─────────
 * 對照表寫「邊迴圈 ❌ 走不動 —— 它要四價頂點，
 * **而方塊與圓柱的頂點是 3 價**」。
 * **那句話對方塊與圓柱成立，對球完全不成立**：
 *
 * | 模型 | 價數分布 | 走得動嗎 |
 * |---|---|---|
 * | 方塊 | `{3: 8}` | ✘ 1 條（對照表是對的） |
 * | 圓柱 seg32 | `{3: 64}` | ✘ 1 條（對照表是對的） |
 * | **球 segW12 segH32** | **`{4: 372, 12: 2}`** | ✅ **32 條，剛好一整條經線** |
 * | **球 segW32 segH16** | **`{4: 480, 32: 2}`** | ✅ **16 條，剛好一整條經線** |
 *
 * ⚠ **那個 ❌ 是拿方塊與圓柱推到全部** —— 而**球正好是瓣片展開的對象**。
 * 〔「推論不是權威事實」的又一個實例：對照表本身也是快照〕
 *
 * ⭐ **它解掉「瓣片展開 A」的卡點**：選一整條經線標成分片切割線，
 * 原本要點 **384 條邊**，現在一條經線 1 下、12 瓣 12 下。
 * ⚠ 而日誌原本寫「動工第一件事：實測『選一圈』抓不抓得到經線」——
 * **實測答案是抓不到**（只抓到 1 條），要的是這一支。
 *
 * ── 走法：在四價頂點上找「對面那一條」 ────────────────
 * 對面 ＝ **不跟目前這條邊共用任何一個面**的那一條。
 *
 * ⚠ **⛔ 不要用「夾角最接近 180 度」當判準** —— 那是幾何，
 * 而迴圈是**拓撲**的事。球的經線在極點附近夾角很小，
 * 用角度會走錯；用「不共用面」則不管形狀多彎都成立。
 *
 * ── ⭐ 停在非四價點是**正確行為**，不是限制 ──────────────
 * 球的經線本來就該**從極走到極**，而極點正是那個非四價點
 * （segW12 的極點是 12 價）。所以它自己就停在對的地方。
 *
 * @param {Mesh} mesh
 * @param {HalfEdge} he0 種子邊
 * @param {{tolDeg?:number, markableOnly?:boolean}} [opt]
 *        `markableOnly`（預設 true）＝ 只走**畫面上看得見**的邊
 * @returns {{hes:HalfEdge[], keys:string[], closed:boolean, stopped:string[]}}
 *          `hes` 每條邊只出現一次，`keys` 是「小索引-大索引」字串
 */
export function edgeLoop(mesh, he0, opt = {}) {
  const out = { hes: [], keys: [], closed: false, stopped: [] };
  if (!mesh || !he0) return out;

  const vi = mesh._vertIndex();
  const kOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const keyOf = h => kOf(vi.get(h.v.id), vi.get(h.to.id));

  /**
   * ⚠ 判準沿用 `isMarkable()` 那一套（`markableEdges`）——
   * ⛔ 不要另外寫一套「哪些邊算數」。
   * 〔全選邊那一輪定的：**畫面上看得見的邊**是唯一的定義〕
   */
  let allowed = null;
  if (opt.markableOnly !== false) {
    allowed = new Set();
    for (const he of markableEdges(mesh, opt.tolDeg)) allowed.add(keyOf(he));
  }
  const ok = h => !allowed || allowed.has(keyOf(h));

  const seen = new Set([keyOf(he0)]);
  out.hes.push(he0);

  /** 兩個方向各走一次（種子那條邊自己已經收進去了） */
  for (const start of [he0, he0.twin]) {
    if (!start) { out.stopped.push('這條邊沒有另一側'); continue; }
    let h = start;
    for (let guard = 0; guard < 1e6; guard++) {
      const v = h.to;
      const inc = mesh.vertOutgoing(v);
      /**
       * 🔴 **只有四價點走得下去。**
       * ⚠ 這不是缺陷：三價點（方塊、圓柱的角）**本來就沒有「對面那一條」**，
       * 而球的極點是「所有經線交會的地方」—— 停在那裡才對。
       */
      if (inc.length !== 4) { out.stopped.push(`停在 ${inc.length} 價的點`); break; }

      const myFaces = new Set([h.face, h.twin && h.twin.face].filter(Boolean));
      const nxt = inc.find(o => {
        if (keyOf(o) === keyOf(h)) return false;
        const fs = [o.face, o.twin && o.twin.face].filter(Boolean);
        return !fs.some(f => myFaces.has(f));
      });
      if (!nxt) { out.stopped.push('找不到對面那一條'); break; }
      if (!ok(nxt)) { out.stopped.push('對面那一條在畫面上看不見'); break; }

      const k = keyOf(nxt);
      if (seen.has(k)) { out.closed = true; out.stopped.push('繞回起點'); break; }
      seen.add(k);
      out.hes.push(nxt);
      h = nxt;
    }
  }

  out.keys = out.hes.map(keyOf);
  return out;
}
