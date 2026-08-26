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
