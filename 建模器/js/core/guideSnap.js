/**
 * 參考線吸附的數學（第 2 階段，2026-09-01）。
 *
 * ── 🔴 為什麼是一支獨立的純函式 ──────────────────────
 * 這裡面**一個 three.js 物件都不碰、一個畫面的東西都不碰**，
 * 進去是數字、出來是數字 —— 所以**沙箱測得到**。
 * ⚠ 這正是 `stroke.js`（刀具一筆畫）當初被抽出來的理由：
 * 刀具那一輪 kang 抓到的 bug 在「誰該收這個手勢」那一層，
 * 而**數學那一層 1890 項測試一項都沒漏** —— 能測的部分就要測得到。
 *
 * ── ⛔ 這裡不決定的事 ────────────────────────────
 * **容許距離是呼叫端算好才傳進來的**（`tol`，世界單位）。
 * 🔴 理由是規格釘死的：**容許距離要用螢幕像素，⛔ 不用公分** ——
 * 用公分的話拉遠了就吸不到、拉近了到處都在吸，而使用者
 * ⛔ 不會把「吸不到」跟「我把畫面縮小了」連在一起。
 * ⇒ 「像素 → 世界」要問相機，那是畫面的事，⛔ 不屬於這一支。
 */

/** 三個軸的順序（⛔ 不要就地寫成字串陣列，兩處會漂） */
export const GUIDE_AXES = ['x', 'y', 'z'];

/**
 * 算一個物件外框要挪多少才會吸到參考線上。
 *
 * ── 吸物件的哪裡：**邊緣 ＋ 中心**（kang 2026-08-31 選的，＝ Illustrator）──
 * 每個軸有三個候選：`min`／`center`／`max`，各自去找最近的一條線。
 *
 * ── 🔴 各軸各自吸（kang 2026-09-01 拍板）────────────────
 * X 吸 X 的線、Y 吸 Y 的線，**兩個可以同時成立** ——
 * 拖到一個角附近就**一次對齊到那個角**，⛔ 不必分兩次拖。
 * ⚠ 對照組（沒選的那個）是「一次只吸最近的一個軸」。
 *
 * @param {{min:{x,y,z}, max:{x,y,z}}} bounds 物件在世界座標的外框（＝ `align.js` 的
 *        `worldBounds(obj)`。🔴 **⛔ 不可以拿 `obj.pos`** —— 網格不一定
 *        以原點為中心，拿 `pos` 去對齊畫面上看起來就會沒對齊，
 *        那個坑 `align.js` 的檔頭已經釘死過）
 * @param {{x:number[], y:number[], z:number[]}} guides 三串參考線的位置（cm）
 * @param {number} tol 容許距離，**世界單位**（呼叫端用螢幕像素換算好）
 * @returns {{delta:{x:number,y:number,z:number}, hits:Array<{ax:string,v:number,from:string}>}}
 *          `delta` ＝ 物件要加上去的位移；`hits` ＝ 吸到了哪幾條（拿去畫高亮）
 */
export function guideSnapDelta(bounds, guides, tol) {
  const delta = { x: 0, y: 0, z: 0 };
  const hits = [];
  if (!bounds || !guides || !(tol > 0)) return { delta, hits };

  for (const ax of GUIDE_AXES) {
    const list = guides[ax];
    if (!list || !list.length) continue;

    const lo = bounds.min[ax], hi = bounds.max[ax];
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue;

    /**
     * ⚠ 順序是 `min → center → max`，而 `<` 的比較是**嚴格小於** ——
     * 所以**平手時留最先的那個**。
     * 🔴 這件事看起來無關緊要，但它決定了「一個剛好對稱的物件
     * 落在兩條線正中間」時會往哪邊吸 —— **⛔ 不可以每次不一樣**，
     * 那會變成使用者眼中的「這個吸附有時候會亂跳」。
     */
    const cands = [
      { from: 'min', at: lo },
      { from: 'center', at: (lo + hi) / 2 },
      { from: 'max', at: hi }
    ];

    let best = null;
    for (const c of cands) {
      for (const g of list) {
        if (!Number.isFinite(g)) continue;
        const d = Math.abs(g - c.at);
        if (d > tol) continue;
        if (!best || d < best.d) best = { d, g, from: c.from, at: c.at };
      }
    }

    if (!best) continue;
    delta[ax] = best.g - best.at;
    hits.push({ ax, v: best.g, from: best.from });
  }

  return { delta, hits };
}

/**
 * 兩組 `hits` 是不是同一件事。
 *
 * ⚠ **⛔ 這不是為了省效能，是為了⛔ 不要每一幀都重建高亮的那幾條線** ——
 * 拖曳中 `objectChange` 一秒會送幾十次，每次都 dispose ＋ 重建
 * 是「每幀迴圈裡的東西」（鐵律四），而且畫面會閃。
 */
export function sameGuideHits(a, b) {
  const A = a || [], B = b || [];
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) {
    if (A[i].ax !== B[i].ax || A[i].v !== B[i].v) return false;
  }
  return true;
}
