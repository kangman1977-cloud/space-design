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

import * as THREE from 'three';
import { markableEdges } from '../unfold/seam.js';
/**
 * ⚠ **單向相依，⛔ 不會繞回來**：`edit.js` 只 import `mesh` / `region` /
 * `flatten` / `svgPath`，**沒有 import 本檔**（2026-08-27 查過）。
 * ⭐ 借 `edgeRing()` 是刻意的 —— 面迴圈跟邊環是**同一條路徑的兩種讀法**，
 * ⛔ 不要為了避免跨檔就在這裡重寫一支走訪。
 */
import { edgeRing } from './edit.js';

/**
 * 🔴 **「一樣大」「一樣長」的容許值：0.01 cm。**
 *
 * ⚠ **這個數字不是隨便挑的，也不是浮點數的尺度**（坑第 25、26 條）——
 * 它跟 `edit.js` 的 `PLANAR_TOL_CM` 是**同一個數字、同一個物理意義**：
 * **切得出來的精度**。0.01 cm² ＝ 一個 0.1×0.1 cm 的小方塊，
 * 比珍珠板、壓克力的切割精度還小。
 *
 * ⛔ **不要改成 1e-6** —— 這個專案切的是板材，不是在比浮點數。
 * 〔kang 2026-08-27 拍板〕
 */
export const SIMILAR_TOL_CM = 0.01;

/** 法向「同不同向」的容許角度。沿用 `isFlat()` 那一套的預設 */
export const SIMILAR_NORMAL_TOL_DEG = 0.5;

/**
 * 門檻本身的容許值（度）。**等於門檻就算轉角。**
 *
 * ⚠ **為什麼需要它，理由是實測出來的，⛔ 不是防衛性程式碼**：
 * **形狀的夾角常常正好是整數度，而門檻也是使用者打的整數度。**
 *
 * | 實測 | 沒有容許值會怎樣 |
 * |---|---|
 * | 方塊的角**正好 90.0000 度** | 打 90 選到 **0 條** —— 而使用者當然認為 90 度的角是 90 度 |
 * | 六角柱的夾角**正好 60.0000 與 90.0000** | 打 60 選到 12 條（漏掉側面那 6 條） |
 *
 * → 沒有它，「選不選得到」就變成浮點數尾巴決定的。
 *
 * ⚠ **⛔ 這裡原本寫的理由是錯的**（2026-08-27 當天實測改掉）：
 * 原文說「球 segW12 的相鄰經向夾角正好是 30 度」——
 * **實測是 1.507 ～ 29.965 度**，隨緯度變，一條都沒有正好 30 度。
 * 〔30 度是**經度間隔**，不是**二面角**。又一次「推論不是權威事實」〕
 */
const THRESH_TOL_DEG = 0.01;

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

/**
 * 🔴 **破洞在哪裡：找出模型上所有「只有一邊有面」的邊，並分成幾個洞。**
 *
 * ── 它拿來做什麼（＝ 對照表的「依特徵全選」，標 ⭐⭐）────────
 * **3D 列印要的東西必須是完全密封的**，有洞就印失敗或印出空殼。
 * 而 `stl.js` 的 `printCheck()` **早就在報這件事**（bad 級，
 * 「不是封閉的（有 N 條邊界邊）」）—— **卻只給數字，指不出來在哪。**
 * 〔坑第 11 條的近親：**講了問題卻沒有出路**〕
 *
 * ── ⚠ 它 ⛔ 不走選取，只回答「哪幾條」───────────────────
 * 呼叫端拿去**畫在畫面上**（像刀具的預覽線那樣）。
 * 🔴 **⛔ 不要改成把它們選起來** —— `isMarkable()` 第一行就把邊界邊擋掉了
 * （「它本來就是外輪廓」），要選就得為它開**第二個例外**，
 * 而那條規則開一次例外**有四個出口全要改**（環切那一輪實測過）。
 * ⭐ 而使用者要的是「**看得到**」，補洞那顆按鈕本來就存在。
 *
 * ── ⚠ 洞的分組 ⛔ 不用 `_buildBoundaryLoops()` 串好的迴圈 ────
 * 那一支用 `Map<頂點id, 邊界半邊>` 串 next/prev，**一個頂點只放得下一條**
 * （日誌待辦記著這個限制，刪除面已經因此被擋掉一種情形）。
 * → 這裡改用**沿共用頂點的連通分量**分組，不依賴那個串接。
 *
 * @param {Mesh} mesh
 * @returns {{hes:HalfEdge[], holes:number, biggest:number}}
 *          `hes` 每條邊只出現一次　`holes` 幾個洞
 *          `biggest` 最大那個洞有幾條邊
 */
export function boundaryEdges(mesh) {
  const out = { hes: [], holes: 0, biggest: 0, nonManifold: 0 };
  if (!mesh) return out;

  /**
   * 🔴 **非流形邊會偽裝成邊界邊，⛔ 要先扣掉。**
   *
   * ⚠ **這是一個既有的誤報，2026-08-27 沙箱實測抓到**（坑第 18 條）：
   * 一條邊被 3 個面共用時，`fromFaceList()` 只配得出一組 twin，
   * **第三個面那條半邊配不到** → `_buildBoundaryLoops()` 把它補成邊界半邊
   * → 這一支就把它當成破洞回報。
   *
   * 【實證】三個四邊形共用一條邊：外圍真的破了 9 條，
   * 這一支卻回 10 條 —— 多出來的那條**補不起來**，
   * 而 toast 正叫使用者去按 `補洞`。〔坑第 34 條：不要指一條不存在的退路〕
   *
   * ⭐ 扣掉之後那條邊 ⛔ 不是消失，是**改由 `nonManifoldEdges()` 用紫線回報**。
   */
  const nm = new Set(nonManifoldKeys(mesh));

  for (const he of mesh.edges()) {
    if (!he.twin || !he.face || !he.twin.face) {
      if (nm.size && nm.has(edgeKeyOf(he.v.id, he.to.id))) { out.nonManifold++; continue; }
      out.hes.push(he);
    }
  }
  if (!out.hes.length) return out;

  /** 沿「共用頂點」把邊界邊分組 ＝ 一組就是一個洞 */
  const byVert = new Map();
  const add = (v, i) => {
    if (!byVert.has(v.id)) byVert.set(v.id, []);
    byVert.get(v.id).push(i);
  };
  out.hes.forEach((he, i) => { add(he.v, i); add(he.to, i); });

  const seen = new Set();
  for (let i = 0; i < out.hes.length; i++) {
    if (seen.has(i)) continue;
    out.holes++;
    let size = 0;
    const stack = [i];
    seen.add(i);
    while (stack.length) {
      const cur = stack.pop();
      size++;
      const he = out.hes[cur];
      for (const v of [he.v, he.to]) {
        for (const nb of byVert.get(v.id) || []) {
          if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
        }
      }
    }
    out.biggest = Math.max(out.biggest, size);
  }
  return out;
}

/**
 * 🔴 **面迴圈：繞一圈的那些「面」。**
 *
 * ── ⚠ 它 ⛔ 不叫 `faceLoop`，理由是撞名 ──────────────────
 * **`mesh.faceLoop(f)` 早就存在，而且意思完全不同**（一個面自己的
 * 半邊迴圈）。⛔ 兩支名字一樣意思不同，比名字醜難查得多。
 *
 * ── ⭐ 一行新的數學都沒有 ────────────────────────────
 * **面迴圈 ＝ `edgeRing()` 走訪時「穿進去的那些面」。**
 * 邊環與面迴圈本來就是同一條路徑的兩種讀法（一個讀邊、一個讀面）——
 * 所以 ⛔ **不要另外寫一支走訪**，那會變成兩條要對齊的路（坑第 31 條）。
 * 〔kang 2026-08-25 批准的四動作框架的又一例：新功能 ＝ 既有零件換個組合〕
 *
 * ── 🔴 種子一定是「一條邊」，⛔ 不能是「一個面」───────────
 * **一個四邊形有兩個方向**，從面出發的話**結果不唯一**（坑第 24 條：
 * 不唯一就補條件補到唯一，補不到就明講）。
 * 所以介面沿用 `選一圈` 那一套：先點一條邊，再按按鈕。
 *
 * ── 實測（2026-08-27 沙箱）────────────────────────────
 * | 模型 | 選起來幾個面 |
 * |---|---|
 * | 方塊 | **4**（繞一圈的側面，⛔ 不含頂底） |
 * | 圓柱 seg32 | **32** |
 * | 球 segW12 segH32 | **12**（同一條緯度帶繞一圈） |
 *
 * ⚠ **撞到不是四邊形的面就會停** —— 那是 `edgeRing()` 本來的行為
 * （`loop.length !== 4` 就 break），⛔ 不是這一支的限制。
 *
 * @param {Mesh} mesh
 * @param {HalfEdge} he0 種子邊
 * @returns {{faces:Face[], edges:number, closed:boolean}}
 *          `faces` ⛔ 已去重　`edges` 穿過幾條邊　`closed` 有沒有繞回來
 */
export function loopFaces(mesh, he0) {
  const out = { faces: [], edges: 0, closed: false };
  if (!mesh || !he0) return out;

  const r = edgeRing(mesh, he0);
  out.edges = r.hes.length;
  out.closed = r.closed;

  /**
   * ⚠ **一定要去重**：`edgeRing()` 兩個方向各走一次，
   * 而種子那個面**兩邊都會經過** —— 不去重的話它會被選兩次，
   * 數量也會多報一個。
   */
  const seen = new Set();
  for (const he of r.hes) {
    if (!he.face || seen.has(he.face.id)) continue;
    seen.add(he.face.id);
    out.faces.push(he.face);
  }
  return out;
}

// ── 非流形邊 ─────────────────────────────────────────────

/** 無向邊的 key。⚠ 用頂點 **id**，⛔ 不用索引 —— 索引要另外建表，而 id 本來就唯一 */
function edgeKeyOf(a, b) { return a < b ? `${a}-${b}` : `${b}-${a}`; }

/**
 * 🔴 **無向邊 → 用到它的面**。⛔ 不走 `he.twin`。
 *
 * ⚠ **這是整支的關鍵，而且 `edit.js` 的 `recalcNormalsOutside()` 早就這樣做了**
 * （那裡的註解寫著理由）：**半邊結構配不出 3 個面共用一條邊的情形** ——
 * `fromFaceList()` 只配 `a→b` 與 `b→a` 一組 twin，第三個面那條就落單了。
 * 🔴 **所以「哪幾條邊是非流形」這個問題，半邊結構自己答不出來，
 * 一定要從面的頂點繞行重新數一次。**
 */
function faceEdgeMap(mesh) {
  const by = new Map();
  for (const f of mesh.faces) {
    const vs = mesh.faceVerts(f);
    for (let i = 0; i < vs.length; i++) {
      const k = edgeKeyOf(vs[i].id, vs[(i + 1) % vs.length].id);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(f);
    }
  }
  return by;
}

/** 被 3 個以上的面共用的無向邊 key。內部用，⛔ 不對外 */
function nonManifoldKeys(mesh) {
  if (!mesh || !mesh.faces.length) return [];
  const out = [];
  for (const [k, fs] of faceEdgeMap(mesh)) if (fs.length > 2) out.push(k);
  return out;
}

/**
 * 🔴 **有沒有面「貼反了」：找出兩個面在同一條邊上走同方向的地方。**
 *
 * ── 它拿來做什麼 ──────────────────────────────────────
 * 每個面都有正反面，正面要一致朝外。**有一片貼反了，切片軟體就會
 * 以為那一小塊是內部**，印出來會缺一角或整個失敗。
 * ⭐ **出路早就存在**：工具列的 `修法向`（`recalcNormalsOutside()`）。
 *
 * ── 🔴 為什麼一定要跟「非流形」分開 ────────────────────
 * ⚠ **`mesh.js` 把這兩件事講成同一句話**：
 * 「邊 a→b 出現兩次（非流形，這條邊被兩個以上的面共用）」——
 * **貼反了的方塊會吐出這句，而它一條非流形邊都沒有。**
 * 【實證 2026-08-27】方塊翻掉一個面：`mesh.issues` 說「非流形」6 次，
 * `nonManifoldEdges()` 回 **0** —— 兩者根本是不同的病，修法也不同
 * （這個按 `修法向` 就好，非流形要自己刪面）。
 * 🔴 **把它們報成同一則，等於叫使用者去找一個不存在的東西**（坑第 18 條）。
 *
 * ── 判準（⛔ 不比對訊息文字，自己數一次）──────────────
 * 相鄰的兩個面走同一條邊時**方向一定相反**（你的 a→b 是我的 b→a）。
 * **同方向 ＝ 其中一個貼反了。**
 *
 * @param {Mesh} mesh
 * @returns {{edges:number, faces:number}} 幾條邊對不起來、涉及幾個面
 */
export function reversedFaceEdges(mesh) {
  const out = { edges: 0, faces: 0 };
  if (!mesh || !mesh.faces.length) return out;

  /** 有向邊 → 用到它的面。⚠ `a→b` 與 `b→a` 是**兩個不同的 key** */
  const dir = new Map();
  for (const f of mesh.faces) {
    const vs = mesh.faceVerts(f);
    for (let i = 0; i < vs.length; i++) {
      const k = `${vs[i].id}->${vs[(i + 1) % vs.length].id}`;
      if (!dir.has(k)) dir.set(k, []);
      dir.get(k).push(f);
    }
  }

  /**
   * ⚠ **真非流形的邊也會讓同方向出現兩次，⛔ 要先扣掉，不然會報兩遍。**
   * 【實證】T 形接面：`0→1` 有兩個面、`1→0` 有一個 —— 那條邊的病是
   * 「黏了 3 片」，⛔ 不是「貼反了」，而 `修法向` 明確修不了它
   * （`recalcNormalsOutside()` 自己回報 `ambiguousEdges`）。
   */
  const nm = new Set(nonManifoldKeys(mesh));

  const faces = new Set();
  const seen = new Set();
  for (const [k, fs] of dir) {
    if (fs.length < 2) continue;
    const [a, b] = k.split('->');
    const uk = edgeKeyOf(Number(a), Number(b));
    if (seen.has(uk) || nm.has(uk)) continue;
    seen.add(uk);
    out.edges++;
    for (const f of fs) faces.add(f.id);
  }
  out.faces = faces.size;
  return out;
}

/**
 * 🔴 **非流形邊在哪裡：找出「被 3 個以上的面共用」的邊。**
 *
 * ── 它拿來做什麼（＝ 對照表的「依特徵全選」，標 ⭐⭐）────────
 * **非流形正是 STL 送去列印失敗的頭號原因** —— 切片軟體算不出
 * 「哪邊是實心」，會印出破爛的東西或直接拒絕。
 * 而 `printCheck()` **早就在報這件事**，報的卻是
 * 「網格結構有問題：邊 0→1 出現兩次」——
 * 🔴 **`0` 跟 `1` 是頂點索引，畫面上沒有任何東西叫這個名字。**
 * 〔坑第 20 條：把內部的數字放上介面之前先問「這個數字的單位是什麼」〕
 *
 * ── ⚠ 它跟破洞是兩種病，⛔ 不要混為一談 ─────────────────
 * 破洞是「少了面」，補起來就好；非流形是「多了面」，**`補洞` 補不了**。
 * 兩者在畫面上都是一條線，所以**用顏色分**（紅／紫，見 `scene.js`）。
 *
 * ── ⚠ 它 ⛔ 不走選取（跟 `boundaryEdges()` 同一條理由）──────
 * 呼叫端拿去畫在畫面上。⛔ 不要改成把它們選起來 ——
 * 那要為 `isMarkable()` 開例外，而那條規則開一次例外有四個出口全要改。
 *
 * @param {Mesh} mesh
 * @returns {{hes:HalfEdge[], edges:number, faces:number, worst:number}}
 *          `hes` 每條邊一條代表半邊（畫線用，⛔ 已去重）
 *          `edges` 幾條邊　`faces` 涉及幾個面　`worst` 最多被幾個面共用
 */
export function nonManifoldEdges(mesh) {
  const out = { hes: [], edges: 0, faces: 0, worst: 0 };
  if (!mesh || !mesh.faces.length) return out;

  const bad = new Map();
  for (const [k, fs] of faceEdgeMap(mesh)) if (fs.length > 2) bad.set(k, fs);
  if (!bad.size) return out;

  const faces = new Set();
  for (const fs of bad.values()) {
    out.worst = Math.max(out.worst, fs.length);
    for (const f of fs) faces.add(f.id);
  }
  out.edges = bad.size;
  out.faces = faces.size;

  /**
   * ⚠ **同一條無向邊在半邊結構裡不只一條半邊**（配不到 twin 的那些會各自
   * 被補成邊界半邊），所以**畫線之前一定要去重** ——
   * 不去重的話同一條線會被畫好幾次，數量也會多報。
   */
  const taken = new Set();
  for (const he of mesh.halfEdges) {
    if (!he.v || !he.to) continue;
    const k = edgeKeyOf(he.v.id, he.to.id);
    if (!bad.has(k) || taken.has(k)) continue;
    taken.add(k);
    out.hes.push(he);
  }
  return out;
}

/**
 * 🔴 **依銳邊（工具列「選轉角」）：把模型上所有「折起來」的邊一次選起來。**
 *
 * ── 它拿來做什麼 ──────────────────────────────────────
 * ⭐ **對分片是一條捷徑**（對照表標 ⭐⭐）：一次選出所有轉角，
 * 再從裡面決定哪幾條要標成切割線 —— ⛔ 不必一條一條點。
 *
 * ── ⭐ 它沒有任何新的數學 ────────────────────────────
 * `mesh.dihedral()`（轉折角）與 `isMarkable()`（哪些邊算數）**兩支都早就有了**，
 * 這裡只是「掃一遍，合門檻的收進來」。
 * 〔kang 2026-08-25 批准的四動作框架的又一例：**新功能 ＝ 既有零件換個組合**〕
 *
 * ── 🔴 為什麼邊界邊選不進來（kang 2026-08-27 拍板）──────
 * 「邊界邊」＝ 只有一側有面的邊：**一片平板的四周、刪除面之後那圈洞口**。
 * 它**沒有夾角可以算**（`dihedral()` 回傳 `null`）。
 *
 * **不選進來，而且理由不是這裡定的** —— `isMarkable()` 第一行就擋掉了，
 * 註解寫著「**它本來就是外輪廓，標了也沒有意義，取消更是做不到**」。
 * ⛔ 這裡再開一個例外，就會變成「四顆選取按鈕，一顆算邊界邊、三顆不算」，
 * 撞到 kang 定的「**功能之間的定位不可以互相模糊**」。
 *
 * ⚠ **代價要由呼叫端講出來**：**一片平板按下去是 0 條**（整圈都是邊界邊）。
 * 安靜地沒反應 ＝ 坑第 21 條，所以 `boundarySkipped` 要拿去寫進提示。
 *
 * ── ⚠ 環切／內縮加出來的 `hard` 邊不會被選到，那是對的 ────
 * `isMarkable()` 為 `hard` 邊開了例外（共面也算看得見），但它們的
 * **轉折角是 0** —— 而「轉角」問的就是折了幾度。**加的線不是轉角。**
 *
 * @param {Mesh} mesh
 * @param {number} deg 門檻：夾角**大於等於**幾度算轉角（工具列預設 30）
 * @param {{tolDeg?:number}} [opt]
 * @returns {{hes:HalfEdge[], convex:number, concave:number,
 *            scanned:number, boundarySkipped:number}}
 *          `convex`／`concave` ＝ 凸角（山折）與凹角（谷折）各幾條
 */
export function sharpEdges(mesh, deg, opt = {}) {
  const out = { hes: [], convex: 0, concave: 0, scanned: 0, boundarySkipped: 0 };
  if (!mesh || !Number.isFinite(deg)) return out;

  /**
   * 邊界邊有幾條 —— **不是拿來選的，是拿去講的**。
   * 平板按下去 0 條時，使用者要看得到「因為四周是開口邊緣」。
   */
  for (const he of mesh.edges()) {
    if (!he.twin || !he.face || !he.twin.face) out.boundarySkipped++;
  }

  const thr = THREE.MathUtils.degToRad(Math.max(0, deg - THRESH_TOL_DEG));
  for (const he of markableEdges(mesh, opt.tolDeg)) {
    out.scanned++;
    const d = mesh.dihedral(he);
    if (d === null) continue;
    if (Math.abs(d) < thr) continue;
    out.hes.push(he);
    if (d >= 0) out.convex++; else out.concave++;
  }
  return out;
}

/** 一個面的面積。⛔ 一律走 `faceTriangles()`（全專案唯一入口，鐵律二） */
function faceArea(mesh, face) {
  let s = 0;
  for (const [a, b, c] of mesh.faceTriangles(face)) {
    const ab = new THREE.Vector3().subVectors(b.p, a.p);
    const ac = new THREE.Vector3().subVectors(c.p, a.p);
    s += ab.cross(ac).length() / 2;
  }
  return s;
}

/** 一條邊的長度 */
function edgeLen(he) {
  return he.v.p.distanceTo(he.to.p);
}

/**
 * 🔴 **選相似（工具列「選相似」）：跟現在選到的那一個同一類的，全部選起來。**
 *
 * ── 它拿來做什麼 ──────────────────────────────────────
 * 「**選起全部 32 片 seg**」那種事。⛔ 不必點 32 下。
 *
 * ── 🔴 四種判準是 kang 2026-08-27 選的，四種都要 ────────
 *
 * | mode | 意思 | 要不要容許值 |
 * |---|---|---|
 * | `normal` | 同法向 —— 朝同一個方向的面 | 角度 0.5 度 |
 * | `area`   | 同面積 —— 一樣大的面 | **0.01 cm²** |
 * | `length` | 同邊長 —— 一樣長的邊 | **0.01 cm** |
 * | `sides`  | 同邊數 —— 三角形選三角形、四邊形選四邊形 | ⭐ **不用，完全精確** |
 *
 * ⚠ **容許值為什麼是 0.01 而不是 1e-6** —— 見 `SIMILAR_TOL_CM` 的說明。
 * 〔坑第 25、26 條：**要挑一個有物理意義的量去比**〕
 *
 * ── ⚠ 種子是「最後選的那一個」 ────────────────────────
 * 跟「中心 ＝ 最後選的」「法向的切線看 active」同一套 ——
 * ⛔ 不要改成「第一個選的」，那會讓橘色那個元素的意義在不同功能底下不一樣。
 *
 * ── ⚠ 判準跟元素型別要對得起來 ──────────────────────
 * `normal`／`area`／`sides` 是**面**的事，`length` 是**邊**的事。
 * 對不起來時**回傳 `reason` 讓呼叫端講出來**，⛔ 不要安靜地回 0 個
 * （坑第 11 條：沉默地退回是最糟的做法）。
 *
 * @param {Mesh} mesh
 * @param {{kind:string, face?:object, he?:object}} seed 最後選到的那一個
 * @param {'normal'|'area'|'length'|'sides'} mode
 * @param {{tolCm?:number, normalTolDeg?:number, tolDeg?:number}} [opt]
 * @returns {{kind:'face'|'edge'|null, faces:object[], hes:object[],
 *            scanned:number, reason:string}}
 */
export function similarTo(mesh, seed, mode, opt = {}) {
  const out = { kind: null, faces: [], hes: [], scanned: 0, reason: '' };
  if (!mesh || !seed) { out.reason = '沒有選到任何元素'; return out; }

  const tolCm = opt.tolCm ?? SIMILAR_TOL_CM;
  const wantFace = mode === 'normal' || mode === 'area' || mode === 'sides';

  if (wantFace && seed.kind !== 'face') {
    out.reason = '「同法向／同面積／同邊數」要先選一個【面】當範本';
    return out;
  }
  if (mode === 'length' && seed.kind !== 'edge') {
    out.reason = '「同邊長」要先選一條【邊】當範本';
    return out;
  }

  if (wantFace) {
    out.kind = 'face';
    const f0 = seed.face;
    if (!f0) { out.reason = '沒有選到面'; return out; }

    const n0 = mesh.computeFaceNormal(f0).clone();
    const a0 = faceArea(mesh, f0);
    const k0 = mesh.faceVerts(f0).length;
    const cosTol = Math.cos(
      THREE.MathUtils.degToRad(opt.normalTolDeg ?? SIMILAR_NORMAL_TOL_DEG));

    for (const f of mesh.faces) {
      out.scanned++;
      let hit = false;
      if (mode === 'normal') hit = mesh.computeFaceNormal(f).dot(n0) >= cosTol;
      else if (mode === 'area') hit = Math.abs(faceArea(mesh, f) - a0) <= tolCm;
      else hit = mesh.faceVerts(f).length === k0;
      if (hit) out.faces.push(f);
    }
    return out;
  }

  out.kind = 'edge';
  const l0 = edgeLen(seed.he);
  /**
   * ⚠ **只掃「畫面上看得見的邊」** —— 跟「全選邊」同一支判準。
   * 共面的三角化對角線選進來，方塊會變成 18 條而不是 12 條（坑第 20 條）。
   */
  for (const he of markableEdges(mesh, opt.tolDeg)) {
    out.scanned++;
    if (Math.abs(edgeLen(he) - l0) <= tolCm) out.hes.push(he);
  }
  return out;
}
