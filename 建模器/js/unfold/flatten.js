/**
 * flatten.js — 展開的幾何核心
 *
 * ═══ 🔴 這個檔案最重要的一條：尺寸的依據是網格，不是公式 ═══
 * 〔kang 2026-08-23 定調。這一條凌駕本檔其餘所有說明〕
 *
 *     **展開尺寸 ＝ 網格攤平後的總和。與材料無關。**
 *
 * 攤平是**剛體運動** —— 每個面原地轉到同一個平面上，長度一格都不變。
 * 所以攤出來的數字**就是**這個模型真正的尺寸，不需要任何修正。
 *
 * ── 為什麼公式算出來的會不一樣 ──────────────────────
 * 模型就是網格。網格裡**沒有曲面，一個都沒有** —— 圓、弧、球面
 * 一律是很多小平板拼出來的。r=25、seg=32 的「圓柱」在網格裡
 * 是一根 32 邊柱：
 *
 *     網格真值  32 片 × 4.9008 = 156.83   ← 這根柱子真正的展開寬
 *     公式      2πr            = 157.08   ← 一個從來沒被做出來過的理想圓
 *
 * **起點不同，不是誰比較準。** 網格那個答的是「這張料拼不拼得出
 * 我畫面上看到的東西」；公式那個答的是「捲成真正的圓半徑會是 25」。
 * 而你的模型不是真正的圓。誤差方向永遠固定：弦短於弧。
 *
 * ── 想要更接近真正的圓，就把 seg 開高 ───────────────
 *     seg 32 → 捲起來的半徑誤差 0.40mm
 *     seg 64 → 0.10mm（＝本專案的物理尺度，坑 25／26）
 *     seg 128 → 0.03mm
 * **精緻度是建模階段的決定，不是展開階段要補救的事。**
 * 沒有人會問「立方體的 6 個面該不該修正成別的數字」——
 * 圓柱有 32 個面，道理一模一樣。
 *
 * ═══ 這個檔案不知道材料是什麼 ═══════════════════════
 *
 * 這句話以前是假的（`arcCorrection()` 會問 `rule.canRoll` 來決定
 * 要不要把弦長拉成弧長），2026-08-23 修正之後才真正成立。
 *
 * 現在 rule 只被問三件事，**沒有一件會改變任何長度**：
 *   · `canFold()`  這條邊折不折得起來 → 改變**片數**
 *   · `validate()` 檢查（最小折邊等）→ 只講話
 *   · `k`/`thickness` 算內側 R → 只是**標註**（⚠ 這一項是金屬中性層
 *     概念，主力材料用不到，待辦裡排著要收起來）
 *
 * 材料的補償（軟料會伸長、縫份、黏合片）是**疊在真值之上的獨立一層**，
 * 像 sheet.js 的縫份那樣「圖上未含 X cm，下料時另加」——
 * 真值歸真值、補償歸補償，兩個數字都看得見。
 * **那一層目前不存在，而且刻意不預先開鉤子。**
 *
 * ⛔ **不要把任何材料判斷寫回長度計算裡。** 基準一旦有條件，
 * 圖上就再也沒有一個數字有單一意義了。
 *
 * ── 本檔的工作 ──────────────────────────────────────
 * 純幾何：分片 → 攤平 → 認出圓弧帶（只為了標註與報告）→ 重疊偵測。
 *
 * ── 圓弧至少要兩段才認得出來（這是真的限制，不是偷懶）──
 * 一段的「圓弧」在網格上就是一個平面四邊形，跟一個倒角**完全一樣**，
 * 沒有任何幾何資訊能分辨。所以 prim.js 的 arcSeg 下限設成 2。
 *
 * 單位一律 cm。
 */

import * as THREE from 'three';
import { EDGE_ROLE } from '../core/mesh.js';

const DEG = 180 / Math.PI;

/** 共面容許角度。跟 region.js 一致。 */
export const FLAT_TOL_DEG = 0.5;

// ═══════════════════════════════════════════════════════
//  對外入口
// ═══════════════════════════════════════════════════════

/**
 * 把一個網格展開成一片一片的平面圖樣。
 *
 * @param {Mesh} mesh   要展開的網格（板件是開放的面，也就是中性面）
 * @param {object} rule rules.js 的 makeRule() 產物
 * @param {object} opts { flatTolDeg }
 * @returns {{pieces: Piece[], warnings: string[], stats: object}}
 */
export function unfoldMesh(mesh, rule, opts = {}) {
  const tolDeg = opts.flatTolDeg ?? FLAT_TOL_DEG;
  const warnings = [];

  mesh.computeNormals();

  if (!mesh.faces.length) {
    return { pieces: [], warnings: ['這個物件沒有任何面'], stats: empty() };
  }

  const patches = splitPatches(mesh, rule, tolDeg);
  const pieces = [];

  /**
   * ── 接合編號：只有「使用者自己標過分片」的物件才給 ──────────
   *
   * kang 的原話：「簡單的展開圖很好區分，遇到複雜的分切展開，
   * 標示就需要研究一下了。」—— 那正是他最早那句話的後半段
   * 「切割後**再組裝結合**」。程式做到了切開，沒做怎麼接回去。
   *
   * 紙模型的慣例：每一對接合邊給同一個號碼，A 片的 ③ 對上 B 片的 ③。
   * 這個資訊程式完全知道 —— 每一條被切開的邊，兩側就分屬兩片。
   *
   * ⚠ **接合編號與「一樣的片合併成一張圖」本質上互斥。**
   *
   * 合併只看形狀。方塊的頂面與底面形狀一樣會被併成一張圖，
   * 但它們接的是不同的邊 —— 一張圖只能標一組號碼，另一片的沒地方放。
   * 任何「說明這片裝在哪裡」的標示都會讓合併失效，這不是實作問題。
   *
   * kang 的決定（2026-08-22）：**分切過的就不合併，全部給編號。**
   * 沒標過分片的物件維持原本的合併行為 —— 那是天天在用的路，
   * 不能因為新功能而改掉。判準用「使用者有沒有標過」，
   * 不用「展開結果有沒有超過一片」：後者會靜靜地改掉壓克力箱體的行為。
   */
  const wantJoints = hasUserSeams(mesh);
  const jointNo = wantJoints ? { map: new Map(), next: 1 } : null;

  for (const patch of patches) {
    const r = flattenPatch(mesh, patch, rule, tolDeg, jointNo);
    if (r.piece) pieces.push(r.piece);
    else if (r.error && !warnings.includes(r.error)) warnings.push(r.error);
  }

  // 完全一樣的片合併成「一張圖 ×N」—— 12 片一樣的側板要出一張圖，
  // 不是 12 張一樣的圖。這跟說明表的「套數」是同一個概念。
  const merged = groupIdentical(pieces, !wantJoints);

  for (const p of merged) {
    for (const w of rule.validate(p)) p.warnings.push(w);
  }

  const arcs = merged.reduce((n, p) => n + p.bends.filter(b => b.isArc).length, 0);
  const sharp = merged.reduce((n, p) => n + p.bends.filter(b => !b.isArc).length, 0);

  if (!rule.foldable) {
    warnings.push(`${rule.label}折不了，所有折線已改成切割線，各片分開下料`);
  }
  for (const p of merged) {
    /**
     * 重疊回饋分三態，不是一個布林。
     * 〔2026-08-23 修正。原本只有一句「有重疊，需要切分（第 7 期會做自動分片）」〕
     *
     * 舊訊息有兩個問題：
     *   · **第 7 期已經取消**（剖面分切把同一個需求解得更好），
     *     所以它承諾了一個不存在的退路 —— 使用者會等一個永遠不會來的功能
     *   · 片數超過 3000 時根本沒檢查，卻靜靜地什麼都不說
     */
    if (p.overlap) {
      warnings.push(`「${p.name}」攤平後有重疊 —— 這張圖不能直接下料。`
                  + `請用「分片」把它切開（沒有自動分片，分片是製造決定，由你決定切在哪）`);
    } else if (!p.overlapChecked) {
      warnings.push(`「${p.name}」面數超過 ${OVERLAP_MAX_POLYS} 片，重疊偵測跳過了 ——`
                  + `這一片是「沒有檢查」，不是「沒有問題」。`
                  + `要檢查請先用「分片」切成小片，或把 seg 調低`);
    }
    if (p.nonDevelopable) warnings.push(`「${p.name}」含攤不平的曲面（角虧不為零），數學上不可能無失真展開，這一片的尺寸只是近似值`);
    /**
     * 〔2026-08-23 刪除〕原本這裡有一則錐面警告：
     * 「請勿據以下料 —— 這是錐面，展開長度應該走弧長，但圓弧修正做不到 → 偏短」。
     *
     * **整則拿掉，因為它的前提沒了。** 它假設「應該走弧長」，
     * 而現在的定義是展開尺寸 ＝ 網格攤平後的總和，錐面攤出來的就是答案。
     *
     * 而且錐面的攤平本來就是對的 —— 2026-08-23 實測（r=30、h=70）：
     * seg 6／8／16／32／64，展開圖上離頂點最遠的距離一律 76.1579，
     * 母線 76.1577。**扇形半徑精確等於母線，一格誤差都沒有。**
     * 那則警告是在叫人不要用一個正確的數字（誤報比漏報更糟，坑第 18 條）。
     *
     * `p.radialFolds` 仍然算著 —— 它是事實，之後若要對錐面做別的事會用到。
     */
  }

  return {
    pieces: merged,
    warnings,
    stats: {
      pieces: merged.length,
      total: merged.reduce((n, p) => n + p.qty, 0),
      arcBends: arcs,
      sharpBends: sharp,
      area: merged.reduce((a, p) => a + p.area * p.qty, 0)
    }
  };
}

const empty = () => ({ pieces: 0, total: 0, arcBends: 0, sharpBends: 0, area: 0 });

// ═══════════════════════════════════════════════════════
//  一、分片
// ═══════════════════════════════════════════════════════

/**
 * 這條邊要不要切開？
 *
 * 順序有意義：
 *   1. 沒有隔壁 → 那是網格邊界，本來就是外輪廓
 *   2. 使用者標成 cut → 尊重使用者
 *   3. 夠平 → 連著（不是折線）
 *   4. 剩下的是折線，問材料規則折不折得起來
 *
 * 注意第 4 步是**唯一**需要知道材料的地方，而且只透過 rule.canFold()
 * 問一個是非題。幾何核心到此為止，不再碰材料。
 */
function edgeIsCut(mesh, he, rule, tolDeg) {
  if (!he.twin || !he.face || !he.twin.face) return true;
  if (he.role === EDGE_ROLE.CUT) return true;

  const d = mesh.dihedral(he);
  if (d === null) return true;

  const deg = d * DEG;
  if (Math.abs(deg) <= tolDeg) return false;
  return !rule.canFold(deg);
}

/** 依「不切開的邊」把面分成一群一群，每一群就是展開後的一片 */
function splitPatches(mesh, rule, tolDeg) {
  const seen = new Set();
  const out = [];

  for (const seed of mesh.faces) {
    if (seen.has(seed.id)) continue;

    const group = [];
    const stack = [seed];
    seen.add(seed.id);

    while (stack.length) {
      const f = stack.pop();
      group.push(f);
      for (const he of mesh.faceLoop(f)) {
        if (edgeIsCut(mesh, he, rule, tolDeg)) continue;
        const nb = he.twin.face;
        if (nb && !seen.has(nb.id)) { seen.add(nb.id); stack.push(nb); }
      }
    }
    out.push(group);
  }
  return out;
}

// ═══════════════════════════════════════════════════════
//  二、攤平
// ═══════════════════════════════════════════════════════

/**
 * 把一群面攤到平面上。
 *
 * ── 做法 ────────────────────────────────────────────
 * 從任一個面出發做廣度優先。每走到一個鄰居，就繞著共用的那條邊
 * 把它轉平 —— 共用邊的兩個端點位置不動，其餘頂點照原本的
 * 「離這條邊多遠」擺上去。這是剛體運動，長度與角度都不變，
 * 所以對可展曲面是**精確解**，不是近似。
 *
 * ── 為什麼鄰居會自動落在正確的另一側 ────────────────
 * 每個面都用「沿著自己的半邊方向往左」當第二軸（左 ＝ 法向 × 方向）。
 * 相鄰兩個面共用的那條邊，半邊方向天生相反，
 * 所以兩者的「左」剛好指向相反側，不必額外判斷。
 * 這是半邊結構本身就帶著的資訊，換成面清單就要自己算繞向。
 */
function flattenPatch(mesh, faces, rule, tolDeg, jointNo = null) {
  if (!faces.length) return null;

  const inPatch = new Set(faces.map(f => f.id));
  /** 半邊 id → 這條半邊起點攤平後的 2D 座標 */
  const pt2 = new Map();
  const placed = new Set();

  // ── 種子面 ──
  const seed = faces[0];
  {
    const loop = mesh.faceLoop(seed);
    const o = loop[0].v.p;
    const e1 = new THREE.Vector3().subVectors(loop[1].v.p, o);
    if (e1.lengthSq() < 1e-20) return null;
    e1.normalize();
    const e2 = new THREE.Vector3().crossVectors(seed.normal, e1);
    for (const he of loop) {
      const d = new THREE.Vector3().subVectors(he.v.p, o);
      pt2.set(he.id, { x: d.dot(e1), y: d.dot(e2) });
    }
    placed.add(seed.id);
  }

  /**
   * ── 攤開其餘的面：**先走最平的邊** ──────────────────
   *
   * 這裡刻意不是單純的廣度優先。生成樹要**優先跨過轉折角最小的邊**，
   * 理由是「共面的鄰居其實是同一片板子」，要讓它們黏在一起。
   *
   * 不這樣做會發生什麼（實測，圓錐加底蓋）：
   * 底蓋由 32 個共面三角形組成，側面是 32 片斜面。先進先出的佇列
   * 會讓每個底蓋三角形各自從**它旁邊那片側面**跨輪圈接上去，
   * 而不是接到隔壁的底蓋三角形 —— 底蓋因此被拆散、散落在扇形四周，
   * 攤出來就是一張星芒狀的廢圖（kang 2026-08-22 實際看到的那張）。
   *
   * 改成先走最平的邊之後，底蓋三角形彼此的轉折角是 0，一定先被走完，
   * 整片底蓋保持完整；輪圈（113°）最後才走，而且只會走其中一條，
   * 其餘 31 條自動變成隱含切割線。扇形 ＋ 圓盤，跟實際下料一致。
   *
   * 這不改變任何「哪些邊可以折」的規則，只改變**先攤哪一條**。
   * 攤平是剛體運動，走的順序不影響每一片自己的形狀與尺寸 ——
   * 只影響它們在圖面上被擺到哪裡，以及哪些邊變成隱含切割線。
   */
  const tree = new Set();
  /**
   * 待處理的邊界半邊，隨時取轉折角絕對值最小的那一條。
   *
   * 用堆積而不是每次線性掃一遍找最小值。理由是**演算法性質**，不是實測數字：
   * 線性版是 O(邊界大小²)，而邊界會隨著面數成長。
   *
   * ── 老實說：實測兩者一樣快 ──────────────────────────
   * 暖機後 128 段圓柱 1.2ms、16,128 面的球 112ms，兩種寫法量不出差別。
   * 一開始以為線性版慢了五倍，那是 **Node JIT 冷啟動的假象**
   * （前幾次執行還沒最佳化就拿去計時）。
   * 留堆積是因為 O(n log n) 對「攤平一片很大的曲面」比較安全，
   * 不是因為它現在比較快 —— 別把這段當成效能修正的案例。
   *
   * → 教訓：**計時一定要先暖機再取多次最小值**，
   *   拿冷啟動的單次數字當根據，會做出沒必要的最佳化。
   */
  const frontier = new MinHeap();

  const pushFrontier = (f) => {
    for (const he of mesh.faceLoop(f)) {
      const th = he.twin;
      if (!th || !th.face || !inPatch.has(th.face.id)) continue;
      if (placed.has(th.face.id)) continue;
      if (edgeIsCut(mesh, he, rule, tolDeg)) continue;
      const d = mesh.dihedral(he);
      frontier.push(he, d === null ? Infinity : Math.abs(d));
    }
  };

  pushFrontier(seed);

  while (frontier.size) {
    const he = frontier.pop();
    const th = he.twin;
    if (!th || !th.face || placed.has(th.face.id)) continue;

    // 共用邊：he 從 a 走到 b，孿生的 th 從 b 走到 a
    const A2 = pt2.get(he.id);
    const B2 = pt2.get(he.next.id);
    if (!A2 || !B2) continue;

    placeFace(mesh, th, B2, A2, pt2);
    placed.add(th.face.id);
    tree.add(he.id); tree.add(th.id);
    pushFrontier(th.face);
  }

  // 走不到的面（理論上不會發生，除非結構壞掉）先丟掉並記一筆
  const used = faces.filter(f => placed.has(f.id));
  if (!used.length) return { error: '這一片攤不開，網格結構可能有問題' };

  /**
   * 隱含切割線 —— 攤平時「繞回自己」的那條邊。
   *
   * 圓筒的側面繞一圈接回起點，攤平時一定要在某處剪開，
   * 不然最後一片會疊回第一片。廣度優先走完之後沒被走到的內部邊
   * 就是那條接縫，把它當成切割線就對了。
   * 這也順便讓輪廓走得出來（否則圓筒沒有邊界，抓不到外輪廓）。
   */
  const implicit = new Set();
  for (const f of used) {
    for (const he of mesh.faceLoop(f)) {
      if (edgeIsCut(mesh, he, rule, tolDeg)) continue;
      if (tree.has(he.id)) continue;
      implicit.add(he.id);
      if (he.twin) implicit.add(he.twin.id);
    }
  }

  const isCut = he => edgeIsCut(mesh, he, rule, tolDeg) || implicit.has(he.id);

  // 完全封閉、一條邊都不能切 → 展不開。封閉實體要先抽殼，
  // 或自己標出切割線（紙模那種「剪開攤平」排在第 7 期）。
  let border = 0;
  for (const f of used) for (const he of mesh.faceLoop(f)) if (isCut(he)) border++;
  if (!border) {
    return { error: '這是封閉的實體，沒有任何切割線可以攤開。請先抽殼成板件，或標出要剪開的邊' };
  }

  const piece = buildPiece(mesh, used, pt2, isCut, rule,
    used.length < faces.length ? ['有部分面攤不開，可能是網格結構有問題'] : [],
    jointNo);
  return { piece };
}

/**
 * 最小堆積 —— 攤平時用來「每次取轉折角最小的邊」。
 *
 * 刻意寫得很小：只要 push / pop / size 三件事，不需要泛用的優先佇列。
 * 存成兩個平行陣列（值與成本），比存物件少一次配置。
 */
class MinHeap {
  constructor() { this.v = []; this.c = []; }
  get size() { return this.v.length; }

  push(val, cost) {
    this.v.push(val); this.c.push(cost);
    let i = this.v.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.c[p] <= this.c[i]) break;
      this._swap(p, i); i = p;
    }
  }

  pop() {
    const top = this.v[0];
    const lastV = this.v.pop(), lastC = this.c.pop();
    if (this.v.length) {
      this.v[0] = lastV; this.c[0] = lastC;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.c.length && this.c[l] < this.c[m]) m = l;
        if (r < this.c.length && this.c[r] < this.c[m]) m = r;
        if (m === i) break;
        this._swap(m, i); i = m;
      }
    }
    return top;
  }

  _swap(a, b) {
    const tv = this.v[a]; this.v[a] = this.v[b]; this.v[b] = tv;
    const tc = this.c[a]; this.c[a] = this.c[b]; this.c[b] = tc;
  }
}

/**
 * 把 th 所屬的面擺到平面上。
 * th 的起點與終點在 2D 已經確定是 O2 與 T2，其餘頂點照 3D 的相對位置擺。
 */
function placeFace(mesh, th, O2, T2, pt2) {
  const face = th.face;
  const o = th.v.p;
  const e1 = new THREE.Vector3().subVectors(th.to.p, o);
  if (e1.lengthSq() < 1e-20) return;
  e1.normalize();
  const e2 = new THREE.Vector3().crossVectors(face.normal, e1);

  const dx = T2.x - O2.x, dy = T2.y - O2.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return;
  const ux = dx / len, uy = dy / len;          // 2D 的「沿著這條邊」
  const px = -uy, py = ux;                     // 2D 的「往左」

  const d = new THREE.Vector3();
  for (const he of mesh.faceLoop(face)) {
    d.subVectors(he.v.p, o);
    const u = d.dot(e1), w = d.dot(e2);
    pt2.set(he.id, { x: O2.x + ux * u + px * w, y: O2.y + uy * u + py * w });
  }
}

// ═══════════════════════════════════════════════════════
//  三、組成一片
// ═══════════════════════════════════════════════════════

/**
 * 步驟順序是有意義的，不能調換：
 *   1. 找折線
 *   2. 圓弧修正 —— 會就地改動 pt2 裡的座標
 *   3. 擺正 —— 也是就地改動 pt2
 *   4. 之後才抓輪廓、量尺寸
 *
 * 全部就地改同一份 pt2，所以折線、輪廓、折彎帶三者永遠對得起來，
 * 不會出現「輪廓修正了、折線沒修正」這種畫面騙人的情況。
 */
function buildPiece(mesh, faces, pt2, isCut, rule, warn, jointNo = null) {
  const inPatch = new Set(faces.map(f => f.id));

  const folds = collectFolds(mesh, faces, inPatch, pt2, isCut);

  /**
   * 折線的方向分組要在修正之前算好，而且要傳給 arcCorrection 共用一份。
   *
   * 分組數本身就是一個重要的事實：**一維拉伸修正只在折線互相平行時成立**
   * （見「四、圓弧修正」開頭的說明）。只有一組 ＝ 全部平行 ＝ 修正有效；
   * 超過一組就代表這一片有修正管不到的地方。
   */
  const dirGroups = groupByDirection(folds);
  const bands = arcCorrection(pt2, folds, dirGroups);
  orient(pt2, folds, mesh, faces, isCut);

  const loops = traceLoops(mesh, faces, inPatch, pt2, isCut);
  const polys = faces.map(f => mesh.faceLoop(f).map(he => pt2.get(he.id)));

  // 整片在展開方向上的範圍。折彎帶要用它補回「外側沒有折線」的那幾格。
  let px0 = Infinity, px1 = -Infinity;
  for (const p of pt2.values()) { px0 = Math.min(px0, p.x); px1 = Math.max(px1, p.x); }

  // 擺正之後才知道折彎帶落在展開圖的哪一段（x 就是展開方向）
  for (const b of bands) {
    let lo = Infinity, hi = -Infinity;
    for (const L of b.lines) {
      for (const f of L.folds) {
        lo = Math.min(lo, f.a.x, f.b.x);
        hi = Math.max(hi, f.a.x, f.b.x);
      }
    }

    /**
     * 🔴 補回「外側沒有折線」的那幾格（2026-08-23）。
     *
     * ── 這是什麼 bug ────────────────────────────────
     * 上面那個迴圈是從**折線的位置**量出這條帶的範圍。但圓筒側面
     * 繞一圈接回來，接縫被剪開之後，最外面那兩格仍然是完整的一格弧，
     * **只是外側沒有折線了**（32 個面只有 31 條折線）。
     * 於是量出來的是 30 格的寬度，而 `segs` 是含頭尾的 32 ——
     *
     *     圖上標「展開 147.03　32 段」，而 147.03 ÷ 4.9009 ＝ 30.0
     *
     * 畫面上也看得到：折彎區的兩條虛線沒有涵蓋整片，兩端各留 4.9。
     * 可是圓柱身體整張都是彎的，那兩格也是弧的一部分。
     *
     * 〔kang 2026-08-23 實測截圖照出來的。舊版標「弧長 147.03」，
     * 　沒有段數可以對照，所以這個矛盾一直沒被看見 ——
     * 　是加上「N 段」之後它才自相矛盾。鐵律：**兩個數字互相對得起來，
     * 　錯誤才會自己現形。**〕
     *
     * ── 怎麼補 ──────────────────────────────────────
     * `bandsInGroup()` 記了 `ext`（頭尾各多吃幾格）與 `chord`（一格弦長），
     * 所以補多少是**算得出來的**：一端補一格弦長。
     *
     * 🔴 **先驗一次再補**：只有在「折線量到的寬度 ＋ ext × 一格弦長
     * 剛好等於 `chordW`」時才動手。對不上就完全不補。
     *
     * ⚠ 這道驗證是必要的，不是保險 —— 第一版寫成「直接延伸到整片的
     * 邊界 `px0`／`px1`」，管（tube）當場出事：外壁與內壁的折線方向一樣，
     * 攤平後疊在一起變成同一片，`px0`／`px1` 是**整片**的邊界而不是
     * 那條帶的，結果折彎區被拉成 129.02 而 `chordW` 只有 117.62 ——
     * **比原本的錯還糟，因為它宣稱的範圍比帶本身還大。**
     *
     * ⚠ 只延伸一端時，用「哪一邊的空隙剛好等於一格弦長」來認。
     * **兩邊都像或都不像就不動** —— 標少一點總比標錯好
     * （坑第 24 條：結果不唯一就不要猜）。
     */
    if (b.ext && Number.isFinite(lo) && near(b.chordW - (hi - lo), b.ext * b.chord)) {
      if (b.ext >= 2) {
        lo -= b.chord; hi += b.chord;
      } else {
        const gapLo = near(lo - px0, b.chord);
        const gapHi = near(px1 - hi, b.chord);
        if (gapLo && !gapHi) lo -= b.chord;
        else if (gapHi && !gapLo) hi += b.chord;
      }
    }

    b.x0 = Number.isFinite(lo) ? lo : 0;
    b.x1 = Number.isFinite(hi) ? hi : b.x0;
    delete b.lines;                 // 內部用的，不要留在輸出裡
    delete b.s0; delete b.s1;
    delete b.ext; delete b.chord;
  }
  bands.sort((a, b) => a.x0 - b.x0);

  computeFlanges(bands, px0, px1);

  const ov = detectOverlap(polys);

  const piece = {
    name: '展開片',
    qty: 1,
    outline: loops[0] || [],
    holes: loops.slice(1),
    folds: folds.map(f => ({ a: f.a, b: f.b, angle: f.angle, isArcEdge: !!f.band })),
    /**
     * 接合處：這條邊在 2D 上是邊界，但在 3D 上有鄰居，要接回去。
     * 兩側的片會拿到同一個號碼。沒有分片標記的物件是空陣列。
     */
    joints: collectJoints(mesh, faces, pt2, isCut, jointNo),
    bends: bands,
    faces: polys,
    warnings: warn.slice(),
    /**
     * `overlap` ＝ 確實偵測到重疊。
     * `overlapChecked` ＝ 到底有沒有檢查過（片數太多會跳過）。
     * 兩個要一起看 —— overlap=false 只有在 overlapChecked=true 時
     * 才代表「乾淨」，否則代表「不知道」。理由見 detectOverlap()。
     */
    overlap: ov.hit,
    overlapChecked: ov.checked,
    /** 永遠 false —— 還沒有可靠的判定方式，理由見上面那一大段說明 */
    nonDevelopable: false,
    /**
     * 折線呈放射狀匯聚到同一點 ＝ 這是**錐面**，一維拉伸修正不適用。
     * 這是**事實**，不是結論；要不要據以下料由警告訊息去講。
     */
    radialFolds: radialFan(folds),
    area: 0, width: 0, height: 0
  };

  measure(piece, mesh, faces);
  return piece;
}

/**
 * 折線是不是「放射狀匯聚到同一點」—— 也就是這一片其實是個**錐面**。
 *
 * ── 為什麼要問這個 ──────────────────────────────────
 * 圓弧修正是沿垂直於折線的方向做一維拉伸，前提是同一段圓弧的折線**互相平行**。
 * 圓錐的折線指向頂點，彼此不平行，`groupByDirection()` 會把它們拆成
 * 一條一條各自成群，於是每一條都被當成尖角折，弧長修正整個不觸發，
 * 展開長度退回弦長（偏短）。
 *
 * ── 為什麼不是直接問「折線平不平行」──────────────────
 * 試過，**會在最常見的件上誤報**：鋼板方塊攤成十字型，5 道折線分兩個方向，
 * 「不平行」成立 —— 可是方塊根本沒有圓弧，沒有東西需要修正，那張圖完全正確。
 * （kang 2026-08-22 實測抓到，測試當時漏了「鋼板方塊」這一項，
 * 因為壓克力方塊的折線全被切開、等於沒折線，矇混過關。）
 *
 * 匯聚才是錐面**獨有**的特徵。實測的分離度很寬，不是勉強調出來的門檻：
 *
 *   圓錐（seg 4～64、rTop 0 與 15）  匯聚比例一律 **100%**
 *   方塊 2/5、圓角方塊 2/21、角柱 2/7、管 5/65、球 127/511、折板 0/10
 *   → 非錐面最高只到 25%
 *
 * ── 沒被這條抓到的 ──────────────────────────────────
 * 球冠（45/127）。它由另一條既有的警告負責：攤平後真的重疊（overlap）。
 * 兩條警告講的是不同的事，一條是「算不準」，一條是「這張圖本身不能用」。
 *
 * @param {Array} folds 攤平後的折線（2D 線段）
 * @returns {boolean}
 */
function radialFan(folds) {
  const L = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;

  for (const f of folds) {
    const dx = f.b.x - f.a.x, dy = f.b.y - f.a.y;
    if (Math.hypot(dx, dy) < 1e-9) continue;
    L.push({ x: f.a.x, y: f.a.y, dx, dy, len: Math.hypot(dx, dy) });
    x0 = Math.min(x0, f.a.x, f.b.x); x1 = Math.max(x1, f.a.x, f.b.x);
    y0 = Math.min(y0, f.a.y, f.b.y); y1 = Math.max(y1, f.a.y, f.b.y);
  }
  if (L.length < 3) return false;

  // 容許值取整片尺度的 1%：太嚴會被浮點誤差刷掉，太鬆會讓平行線也算匯聚
  const tol = Math.max(x1 - x0, y1 - y0, 1e-9) * 0.01;
  const need = Math.max(3, L.length / 2);

  // 只拿前 12 條互相配對求交點當候選圓心 —— 錐面的每一條都通過頂點，
  // 所以隨便取兩條就找得到，不必窮舉 O(n²) 個配對
  const cap = Math.min(L.length, 12);
  for (let i = 0; i < cap; i++) {
    for (let j = i + 1; j < cap; j++) {
      const A = L[i], B = L[j];
      const den = A.dx * B.dy - A.dy * B.dx;
      if (Math.abs(den) < 1e-9) continue;                   // 平行，沒有交點
      const t = ((B.x - A.x) * B.dy - (B.y - A.y) * B.dx) / den;
      const px = A.x + t * A.dx, py = A.y + t * A.dy;

      let n = 0;
      for (const l of L) {
        // 點到直線的距離（用外積算，不必先正規化方向）
        if (Math.abs((px - l.x) * l.dy - (py - l.y) * l.dx) / l.len < tol) n++;
      }
      if (n >= need) return true;
    }
  }
  return false;
}

/**
 * ⚠ nonDevelopable 目前**沒有實作**，永遠是 false。這是刻意的，理由如下。
 *
 * 直覺的做法是「用角虧（離散高斯曲率）掃這一片的內部頂點，
 * 不等於 360° 就是攤不平」。試著寫過，**它會給錯答案**，
 * 而錯的地方全在「哪些頂點算內部」這個定義上：
 *
 * ── 三個互相打架的案例（都實測過）────────────────────
 *
 * │ 定義                        │ 圓柱側面 │ 圓錐 │ 球冠 │
 * │ 整個網格的內部點（region.js）│ 可展 ✓  │不可展✗│不可展✓│
 * │ 扣掉所有切割線碰到的點       │ 可展 ✓  │ 可展 ✓│ 可展 ✗│
 *
 * · **圓錐**：頂點的角虧確實不為零，但接縫一剪開它就攤得平 ——
 *   圓錐側面在數學上**是可展的**。所以「整個網格」那個定義錯。
 * · **球冠**：攤平時演算法自己補了一堆「隱含切割線」（生成樹沒走到的邊），
 *   那些切割線把角虧「撐開」了，於是每個點看起來都攤得平。
 *   但那張圖上其實裂了一堆縫，**根本不能下料**。所以「扣掉切割線」也錯。
 *
 * 差別在於**切割線是誰決定的**：圓錐的接縫是幾何上非剪不可，
 * 球冠的裂縫是演算法沒辦法才自己補的。要分辨這兩者，
 * 等於要先決定「這一片該切在哪」—— 那正是第 7 期的自動分片，
 * 是整個展開引擎最重的一塊（約 70% 工作量）。
 *
 * ── 那現在誰擋著 ────────────────────────────────────
 * 兩條各司其職，都問**明確而且答得出來**的問題：
 *   · `radialFolds`（見上）—— 折線放射狀匯聚 ＝ 這是錐面，抓圓錐
 *   · `overlap`            —— 攤平後真的疊在一起，抓球冠
 *
 * 一條是「算不準」，一條是「這張圖本身就不能用」。
 *
 * 寧可留一個誠實的 false，也不要放一個會在圓錐上說「可以下料」的判定 ——
 * 日誌「踩過的坑」第 5 條就是這個教訓：寫「應該是多少」的判定之前，
 * 先問清楚這條規則的成立條件是什麼。這裡問了，答案是「現在還答不出來」。
 */

/**
 * ⚠ 這裡**刻意沒有**「封閉實體一律拒絕展開」這個檢查。加過，被測試打回來。
 *
 * 理由：封閉實體遇到不能折的材料（壓克力、木板）時，每條稜線都會變成
 * 切割線，方塊因此拆成六片各自平坦的面 —— 那正是壓克力箱體的做法，
 * 是**完全正確而且天天在用**的用途（測試「封閉實體 拆成 3 種面」盯著它）。
 *
 * 而且「封閉實體 ＋ 折得動的材料」也不見得會出事：鋼板方塊是封閉實體，
 * 攤出來就是標準的十字型下料圖，完全正確（測試「鋼板方塊 十字型面積」盯著它）。
 * 封閉與否根本不是判準，用它當判準就會同時誤傷壓克力箱體與鋼板方塊兩條路。
 *
 * 至於「這是實體、不是板件」，part.js 的 unfoldObject() 已經擋在前面了。
 */

/**
 * 這個網格上有沒有使用者標的分片切割線。
 *
 * 只認「內部的邊」—— 網格邊界本來就是 CUT（`Mesh` 建構時自動標的），
 * 拿它當判準的話每一片開放的板件都會被當成「使用者標過」。
 */
function hasUserSeams(mesh) {
  for (const he of mesh.edges()) {
    if (he.role === EDGE_ROLE.CUT && he.face && he.twin && he.twin.face) return true;
  }
  return false;
}

/**
 * 這一片邊界上的接合處，以及它們的編號。
 *
 * 「接合處」＝ 在 2D 上是邊界、但在 3D 上有鄰居的邊。
 * 也就是「原本連在一起、被切開、之後要接回去」的地方。
 * 網格真正的邊界（`twin.face` 是 null）不算 —— 它本來就沒有對象。
 *
 * 編號用 `min(he.id, twin.id)` 當 key，所以兩側的片各自跑到這裡時
 * **一定會拿到同一個號碼**，不必兩片互相知道對方的存在。
 *
 * 包含 implicit 那一類（能折但被攤平的生成樹剪開的邊，例如圓筒的接縫）——
 * 那些在實體上同樣要接回去，漏掉的話圓筒就少一條接縫標示。
 */
function collectJoints(mesh, faces, pt2, isCut, jointNo) {
  if (!jointNo) return [];
  const out = [];
  const seen = new Set();
  const inPatch = new Set(faces.map(f => f.id));

  /**
   * ── 一段一個編號，不是一條邊一個 ──────────────────────
   *
   * 第一版是每條切割邊給一個號碼。方塊上很好用（12 條邊、12 組），
   * 但匯入的曲線輪廓有幾百條邊 —— 一個 S 字的面板標了 198 個號碼、
   * 側邊條標了 398 個，整張圖變成一團綠色數字，完全讀不出來。
   *
   * kang 的做法（他那支 SideUnfold.jsx 用了很久）是：
   * **沿著輪廓走，遇到「真的要折的地方」才換一個號碼。**
   * 折線本來就是現場對位的基準，所以段落編號跟折線同一個位置最自然。
   * S 的側邊因此是 A1~A10 這樣的十段，不是 398 個號碼。
   *
   * 這裡的分段點判準：兩條相鄰的切割邊，**對面那兩個面之間的邊**
   * 是不是平滑的。平滑 ＝ 同一段曲線，繼續；是折線 ＝ 換一段。
   * 兩側各自走的時候看到的是同一批邊，所以分出來的段一定對得起來。
   */
  /**
   * ── 分段用「聯集」，不要沿著邊界走 ──────────────────────
   *
   * 第一版是從一條切割邊往前後走，把同一段串起來。寫得出來，但**兩側
   * 走出來的分段會不一致** —— 面板那邊併成 7 段，側邊條那邊還是 198 段，
   * 於是「每個編號恰好出現兩次」這個不變量破了，連方塊都從 12 組變 18 組。
   *
   * 改成定義在**無向邊**上的聯集：兩條切割邊如果共用一個頂點，而且那個
   * 頂點上其他的折線全都是平滑的，就併成同一段。這個定義跟走訪順序無關，
   * 所以兩側算出來一定是同一個分割 —— 不用「小心地讓兩邊一致」，
   * 而是**根本不可能不一致**。
   */
  const part = seamPartition(mesh, isCut, jointNo);

  const groups = new Map();          // 段的 key → 這一片裡屬於它的切割邊
  for (const f of faces) {
    for (const he of mesh.faceLoop(f)) {
      if (!isCut(he) || seen.has(he.id)) continue;
      const th = he.twin;
      if (!th || !th.face) { seen.add(he.id); continue; }   // 網格邊界，沒有對象
      seen.add(he.id);
      /**
       * ⚠ 一條邊的**兩側都可能在同一片上**。
       *
       * 環狀的側牆攤開時，引擎會找個地方剪開一刀；那一刀的兩端
       * 都留在同一條長條上（長條要繞回去接自己）。只用段的 key 分組的話，
       * 兩側會被併成同一組 → 只畫一個號碼 → **那個號碼只出現一次**，
       * 而「每個編號恰好出現兩次」正是這套編號唯一的保命符：
       * 出現一次 ＝ 有一端接不回去，而且圖看起來完全正常。
       *
       * 所以 key 要再帶一個「哪一側」。同一對半邊裡 id 小的算 0、大的算 1
       * —— 兩側因此一定被分開，號碼也就一定出現兩次。
       */
      const side = he.id < th.id ? 0 : 1;
      const k = `${part.find(edgeKey(he))}|${side}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(he);
    }
  }

  for (const [k, run] of groups) {
    // 號碼本身只認「哪一段」，不認哪一側 —— 兩側才會拿到同一個號碼
    const numKey = k.split('|')[0];
    let num = jointNo.map.get(numKey);
    if (num === undefined) { num = jointNo.next++; jointNo.map.set(numKey, num); }

    // 號碼放整段的中點，不是第一條邊上 —— 那才是現場找得到的位置
    const mid = run[Math.floor(run.length / 2)];
    const a = pt2.get(mid.id), b = pt2.get(mid.next.id);
    if (!a || !b) continue;
    out.push({ a, b, num, segs: run.length });
  }
  void inPatch;
  return out;
}

const edgeKey = he => Math.min(he.id, he.twin ? he.twin.id : he.id);

/**
 * 把整個網格的切割邊分成一段一段。整份文件只算一次，存在 jointNo 上。
 *
 * 判準：兩條切割邊共用一個頂點，而且**那個頂點上其他的折線全是平滑的**
 * → 同一段。有一條是真的折線就換段 —— 折線本來就是現場對位的基準。
 *
 * 共面的邊不算（那是三角化的產物，不是折線），所以面板上那些
 * 看不見的對角線不會把一段切開。
 */
function seamPartition(mesh, isCut, jointNo) {
  if (jointNo._part) return jointNo._part;

  const parent = new Map();
  const find = k => {
    let r = k;
    while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r);
    let c = k;
    while (parent.get(c) !== undefined && parent.get(c) !== c) {
      const n = parent.get(c); parent.set(c, r); c = n;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };

  // 每個頂點上有哪些切割邊、有沒有「不平滑的折線」
  const cutAt = new Map();
  const hardAt = new Set();
  for (const he of mesh.edges()) {
    if (!he.twin || !he.twin.face || !he.face) continue;
    const a = he.v.id, b = he.to.id;
    if (isCut(he)) {
      const k = edgeKey(he);
      if (parent.get(k) === undefined) parent.set(k, k);
      for (const v of [a, b]) {
        if (!cutAt.has(v)) cutAt.set(v, []);
        cutAt.get(v).push(k);
      }
    } else {
      const d = mesh.dihedral(he);
      // 共面的不算折線；真的有轉折而且沒被標成平滑的，就是分段點
      if (d !== null && Math.abs(d * DEG) > FLAT_TOL_DEG && !he.smooth) {
        hardAt.add(a); hardAt.add(b);
      }
    }
  }

  for (const [v, ks] of cutAt) {
    if (hardAt.has(v)) continue;              // 這個頂點上有真的折線 → 換段
    /**
     * 一個頂點上剛好兩條切割邊才併。三條以上表示那裡是好幾片的交會點
     * （方塊的角就是三條），併下去會把不相干的段黏在一起。
     */
    if (ks.length !== 2) continue;
    union(ks[0], ks[1]);
  }

  jointNo._part = { find };
  return jointNo._part;
}

/** 這一片內部的折線（不含外輪廓）。順便記下轉折角。 */
function collectFolds(mesh, faces, inPatch, pt2, isCut) {
  const out = [];
  const seen = new Set();

  for (const f of faces) {
    for (const he of mesh.faceLoop(f)) {
      const th = he.twin;
      if (!th || !th.face || !inPatch.has(th.face.id)) continue;
      if (isCut(he)) continue;
      if (seen.has(th.id)) continue;
      seen.add(he.id);

      const d = mesh.dihedral(he);
      if (d === null || Math.abs(d * DEG) <= FLAT_TOL_DEG) continue;   // 共面，不是折線

      const a = pt2.get(he.id), b = pt2.get(he.next.id);
      if (!a || !b) continue;
      // smooth ＝ 這條邊是曲面被切成小面的產物，不是造型上真的有一道折。
      // 上游（貝茲錨點、參數體）才知道，這裡只是帶著走。
      out.push({ a, b, angle: d * DEG, band: null, smooth: !!he.smooth });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════
//  四、認出圓弧帶 —— **只為了標註與報告，不改任何尺寸**
// ═══════════════════════════════════════════════════════

/**
 * 找出「這幾條折線其實同屬一段圓弧」，把它們歸成一條**帶**。
 *
 * ⚠ **這一節以前叫「圓弧修正」，它會把弦長拉成弧長。那件事已經不做了**
 * （2026-08-23，見檔頭）。現在它只負責**認出來**，不負責改。
 *
 * ── 認出來要幹嘛（三件事，沒有一件會動到尺寸）──────
 *   1. 圖上把整條帶畫成一個折彎區，而不是 32 條各自標註的折線
 *   2. 標「R25、32 段、共轉 360°」而不是 32 個 11.25°
 *   3. `arcW`（視為理想圓的周長）留著給**報告**用 ——
 *      「網格 156.83／視為理想圓 157.08／差 0.25」。
 *      **那是資訊，不是修正。** 差多少你自己判斷要不要回頭調 seg。
 *
 * ── 怎麼認出來 ──────────────────────────────────────
 * 一段圓弧被切成 m 段之後，在網格上留下的痕跡很好認：
 *   · 每一段的寬度完全相同（弦長都是 2r·sin(δ/2)）
 *   · 中間每一條折線的轉折角完全相同（都是 δ）
 *   · 頭尾兩條各轉 δ/2（弦跟切線差半個角）
 * 抓到「等寬 ＋ 等角」的連續段，就是一段圓弧。
 *
 * ⚠ 這一招只對參數體有效（圓柱、圓角方塊的格子本來就整齊）。
 * 匯入的自由曲線每一段都不同，走的是上游帶下來的 `he.smooth`
 * 標記那一條路（見 `smoothBands()`）。
 */
function arcCorrection(pt2, folds, groups = null) {
  if (!folds.length) return [];

  groups = groups || groupByDirection(folds);
  const bands = [];
  let arcGroups = 0;

  for (const g of groups) {
    const px = -g.dir.y, py = g.dir.x;
    let lo = Infinity, hi = -Infinity;
    for (const p of pt2.values()) {
      const s = p.x * px + p.y * py;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }

    const found = bandsInGroup(g, lo, hi);
    if (found.some(b => b.isArc)) arcGroups++;

    /**
     * 🔴 **一律不拉伸。展開尺寸 ＝ 網格攤平後的總和，與材料無關。**
     * 〔kang 2026-08-23 定調，取代原本依 `rule.canRoll` 決定的做法〕
     *
     * 攤平是剛體運動，長度一格都不變 —— 所以攤出來的數字**就是**
     * 這個模型真正的尺寸，不需要任何修正。拉伸是這個檔案裡唯一
     * 會破壞精確性的一步，現在它不存在了。
     *
     * ── 為什麼舊做法要拿掉（理由跟結論一樣重要）──────────
     * 舊做法是：捲得起來的材料拉成弧長、捲不起來的用弦長。
     * 結論對板材是對的，但**理由錯了**，而錯的理由會傳染：
     *   · 同一個模型換個材料就換尺寸 → 沒有一個數字有單一意義
     *   · 幾何核心被迫知道材料是什麼 → 破壞本檔第一行的承諾
     *
     * 正確的理由是：模型就是網格。r=25、seg=32 的「圓柱」在網格裡
     * 是一根 32 邊柱，它的展開寬度就是 32 片板子相加 ＝ 156.83。
     * 2πr ＝ 157.08 算的是**一個從來沒被做出來過的理想圓**。
     * 兩個數字的起點不同，不是誰比較準。
     *
     * ── 那想要真正的圓怎麼辦 ────────────────────────────
     * **把 seg 開高**，這是建模階段的決定：
     *   seg 32 → 捲起來的半徑誤差 0.40mm
     *   seg 64 → 0.10mm（＝本專案的物理尺度，見坑 25／26）
     *   seg 128 → 0.03mm
     * 精緻度用 seg 調，不用公式補。
     *
     * ── 材料的補償去哪了 ────────────────────────────────
     * 軟性材料真的需要補償時，那是**疊在真值之上的獨立一層**，
     * 像 `sheet.js` 的縫份那樣「圖上未含 X cm，下料時另加」——
     * 真值歸真值、補償歸補償，兩個數字都看得見。
     * **那一層目前不存在，而且刻意不預先開鉤子。**
     *
     * `arcW`（把這一圈視為理想圓的周長）仍然算著，但**只給報告用**，
     * 永遠不套進圖面。圖面寬度一律是 `chordW`。
     */
    for (const b of found) bands.push(b);
  }

  /**
   * 〔2026-08-23 拿掉〕原本這裡在 `arcGroups > 1`（兩個方向同時有圓弧，
   * 例如四角都倒圓的托盤）時把整片標成 `approx = true`，理由是
   * 「兩次一維拉伸疊起來只在正交時才準」。
   *
   * **拉伸沒有了，所以也沒有東西是近似的。** 攤平是剛體運動，
   * 不管幾個方向有圓弧，出來的尺寸都是精確的網格真值。
   *
   * `approx` 這個欄位在各 band 上仍然一律是 false（見 `sharpBand()` 等），
   * 留著是為了不動輸出格式；目前沒有任何東西會把它設成 true。
   */
  void arcGroups;
  return bands;
}

/** 把折線依方向分組（同一段圓弧的折線一定互相平行） */
function groupByDirection(folds, tolDeg = 1) {
  const cosTol = Math.cos(tolDeg / DEG);
  const groups = [];

  for (const f of folds) {
    const dx = f.b.x - f.a.x, dy = f.b.y - f.a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    const d = { x: dx / L, y: dy / L };

    let g = groups.find(q => Math.abs(q.dir.x * d.x + q.dir.y * d.y) >= cosTol);
    if (!g) { g = { dir: d, folds: [] }; groups.push(g); }
    g.folds.push(f);
  }
  return groups;
}

/**
 * 在同一個方向群裡找出圓弧帶。
 *
 * 先把折線依「垂直方向上的位置 s」合併成一條一條折線
 * （同一條折線可能被切成好幾段半邊，s 相同的就是同一條），
 * 再掃描相鄰折線之間的間距，找等寬等角的連續段。
 */
function bandsInGroup(g, sMin, sMax) {
  const px = -g.dir.y, py = g.dir.x;           // 垂直於折線的方向

  // ── 合併成折線 ──
  const lines = [];
  for (const f of g.folds) {
    const s = ((f.a.x + f.b.x) / 2) * px + ((f.a.y + f.b.y) / 2) * py;
    let L = lines.find(q => Math.abs(q.s - s) <= 1e-6 + 1e-6 * Math.abs(s));
    if (!L) { L = { s, angle: 0, n: 0, folds: [], smooth: true }; lines.push(L); }
    L.angle += f.angle; L.n++; L.folds.push(f);
    if (!f.smooth) L.smooth = false;      // 有一段不是平滑的，整條就不算平滑
  }
  for (const L of lines) L.angle /= L.n;
  lines.sort((a, b) => a.s - b.s);

  if (lines.length < 2) return lines.map(sharpBand);

  /**
   * ── 先問上游，再猜 ────────────────────────────────
   *
   * 下面那個「等寬 ＋ 等角」的掃描是為**圓柱、圓角方塊**寫的 ——
   * 那些形狀的每一格都一模一樣，所以認得出來。
   * 但 Illustrator 畫的自由曲線每一段長度和角度都不同
   * （實測一個 S 字：段長 0.001～7.47cm），**一格都認不出來**，
   * 於是 196 道折彎全部被當成尖角折，展開圖上標了 196 個標註、
   * 398 個接合編號，整張圖變成一團數字。
   *
   * 但那個資訊其實一直都在：貝茲錨點知道自己是平滑點還是轉角。
   * 只要上游把它帶下來（`he.smooth`），這裡就不必猜 ——
   * **連續的平滑折線 ＝ 一條曲線帶**，不管每一格寬不寬、角度等不等。
   *
   * 所以先掃一遍有標記的，剩下的才交給原本那套幾何猜測。
   * 兩者可以並存：參數體走幾何猜測（它的格子本來就等寬等角），
   * 匯入的線稿走這一條。
   */
  const used = new Set();
  const bands = [];
  smoothBands(lines, bands, used);

  const gaps = [];
  for (let i = 0; i + 1 < lines.length; i++) gaps.push(lines[i + 1].s - lines[i].s);

  // ── 掃描：找「等寬 ＋ 中間等角 ＋ 同方向」的連續段 ──
  let i = 0;

  while (i < gaps.length) {
    // 已經被上一輪（有標記的曲線帶）認走的就跳過
    if (used.has(lines[i]) || used.has(lines[i + 1])) { i++; continue; }
    // δ ＝ 每一格轉多少，由這一段的第一條「中間折線」定義。
    // 圓弧的頭尾兩條各只轉 δ/2（弦跟切線差半個角），
    // 所以判斷延不延伸只能看**中間**那條，看到頭尾會提早收手。
    const sgn = Math.sign(lines[i + 1].angle);
    const delta = Math.abs(lines[i + 1].angle);
    let j = i;

    while (j + 1 < gaps.length
           && near(gaps[j + 1], gaps[i])
           && near(Math.abs(lines[j + 1].angle), delta)
           && Math.sign(lines[j + 1].angle) === sgn) j++;

    const m = j - i + 1;                       // 這一段有幾格
    // 一格認不出來（見檔頭說明），至少要兩格才有「中間那條」可以比對
    if (m >= 2 && sameSign(lines, i, j + 1)) {
      /**
       * δ 與弦長都取整段的平均，不要只拿第一個。
       *
       * 轉折角是從面法向量算出來的，帶著浮點誤差；
       * 只取一個值再乘上段數，等於把那個誤差放大 m 倍 ——
       * 128 段的圓柱實測會讓總角度差到 0.005 度。
       * 取平均之後誤差互相抵消，128 段仍在 1e-5 度以內。
       */
      let ds = 0, gs = 0;
      for (let q = i + 1; q <= j; q++) ds += Math.abs(lines[q].angle);
      for (let q = i; q <= j; q++) gs += gaps[q];
      const dAvg = (j > i) ? ds / (j - i) : delta;
      const chord = gs / m;

      const total = dAvg * m;                              // 這段圓弧總共轉多少
      const half = dAvg / 2 / DEG;
      const r = Math.abs(Math.sin(half)) > 1e-12
        ? chord / (2 * Math.sin(half)) : 0;

      if (r > 1e-9 && total > 1e-9) {
        /**
         * 頭尾再各看一格 —— 圓筒才對得起來。
         *
         * 折彎件的圓弧兩端接的是直料，頭尾折線各轉 δ/2（弦跟切線差半個角），
         * 所以圓弧的範圍剛好就是頭尾兩條折線之間。
         *
         * 但圓筒側面是繞一圈接回來的，接縫被當成切割線剪開之後，
         * 最外面那兩片仍然是完整的一格弧，只是外側沒有折線了。
         * 判斷方式：頭尾折線轉的是整個 δ（不是 δ/2），
         * 而且外面那一格的寬度跟弧上每一格一樣 —— 那就是弧的延續。
         */
        let s0 = lines[i].s, s1 = lines[j + 1].s;
        let mm = m;
        /**
         * `ext` ＝ 這條弧在頭尾各多吃了幾格（0／1／2）。
         * 〔2026-08-23 新增。**這個數字後面 `buildPiece()` 要用**〕
         *
         * 為什麼要記：`buildPiece()` 會重新從**折線的位置**算出這條帶
         * 在圖上佔的範圍（`x0`／`x1`），而多吃的那幾格**外側沒有折線**，
         * 於是就被漏掉了 —— 圓柱因此標成「展開 147.03　32 段」，
         * 而 147.03 其實只有 30 段（實測，2026-08-23 kang 的截圖照出來的）。
         */
        let ext = 0;
        if (near(Math.abs(lines[i].angle), dAvg) && near(s0 - sMin, chord)) {
          s0 = sMin; mm++; ext++;
        }
        if (near(Math.abs(lines[j + 1].angle), dAvg) && near(sMax - s1, chord)) {
          s1 = sMax; mm++; ext++;
        }
        const totalAll = dAvg * mm;
        /**
         * ⚠ `arcW` ＝ 把這一圈**視為理想圓**時的周長（r × Θ）。
         *
         * **它不是圖面尺寸，永遠不會被套用。** 圖面一律用 `chordW`
         * ＝ 網格真值（見檔頭）。留著它只有一個用途：報告
         * 「網格 156.83／視為理想圓 157.08／差 0.25」，讓使用者
         * 自己判斷要不要回頭把 seg 開高。
         *
         * ⛔ 看到 `arcW > chordW` 不要以為那是誤差要補回去。
         *    差的那一截是建模時選 seg=32 而不是 128 的代價。
         */
        const arcW = r * totalAll / DEG;

        const band = {
          isArc: true,
          s0, s1,
          chordW: mm * chord, arcW,
          angle: totalAll * Math.sign(lines[i + 1].angle),
          /**
           * `r` ＝ **從網格量出來的半徑**（等寬等角反推）。圖上標的就是它。
           *
           * 🔴 〔2026-08-23 拿掉 `ri`〕原本這裡還有一個
           * `ri: Math.max(0, r - rule.k * rule.thickness)` —— 內側圓角半徑，
           * 由 K 因子與板厚推出來，圖上印的是那一個。**整個拿掉了。**
           *
           * **為什麼**：K 因子／中性層是**金屬折彎的模型**（材料被拉伸，
           * 所以長度要照中性層算）。我們一種金屬都不用，而且 ——
           *
           * ⚠ **實測**：K 因子從頭到尾沒有參與圓柱的建模。
           * `buildPrim()` 建圓柱直接用 r=25，`neutralRadius()` 根本沒被叫到。
           * 網格半徑就是 25.000，K 怎麼調它都不動 —— 但圖上卻印 R24.9。
           * **那個數字描述的是一個不存在的東西**（坑第 20 條：
           * 正確的數字，錯誤的意思）。師傅會以為內側半徑是 24.9。
           *
           * kang 2026-08-23：「K 因子…這都是造成混亂的條件…
           * **不應該在真實尺寸中出現**」。
           *
           * ⛔ 不要把 `ri` 加回來，也不要在這裡問任何材料的事。
           * 圖上要標的是**這一圈現在的半徑**，那是網格事實。
           *
           * 〔折板的 K 因子是另一回事，留著 —— 它在 `buildPrim()` 裡
           * 真的參與建模（換 K 連網格都變），跟 seg 決定圓柱有幾邊同類。
           * 那是**建模參數**，不是展開參數。〕
           */
          r,
          segs: mm,
          ext,                                 // 頭尾各多吃幾格（給 buildPiece 用）
          chord,                               // 一格的弦長（同上）
          approx: false,
          flange: undefined,
          lines: lines.slice(i, j + 2)
        };
        bands.push(band);
        for (let q = i; q <= j + 1; q++) {
          used.add(lines[q]);
          for (const f of lines[q].folds) f.band = band;
        }
        i = j + 1;
        continue;
      }
    }
    i++;
  }

  // 沒被歸進圓弧的折線 ＝ 尖角折，展開圖上就是一條線，不佔寬度
  for (const L of lines) {
    if (used.has(L)) continue;
    bands.push(sharpBand(L));
  }

  bands.sort((a, b) => a.s0 - b.s0);
  return bands;
}

/**
 * 用上游帶下來的標記找曲線帶：**連續的平滑折線就是一段曲線**。
 *
 * 不看每一格寬不寬、角度等不等 —— 那是幾何猜測要煩惱的事。
 * 這裡的判準是「上游說它是平滑的」，而上游（貝茲錨點）真的知道。
 *
 * 一段裡的折線全部被吃掉，兩端的真轉角**不吃** ——
 * 那兩條是造型上真的有的折，要留著當折線畫出來、當分段點用。
 */
function smoothBands(lines, bands, used) {
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].smooth) { i++; continue; }
    let j = i;
    while (j + 1 < lines.length && lines[j + 1].smooth) j++;

    /**
     * 一條孤零零的平滑折線不成帶 —— 它就是一格，跟坑第 10 條同一個道理：
     * 一格的「圓弧」跟一個倒角在幾何上完全一樣，硬當成帶只是自欺欺人。
     * 讓它照舊走尖角折，該標就標。
     */
    if (j > i) {
      const seg = lines.slice(i, j + 1);
      let ang = 0;
      for (const L of seg) ang += L.angle;
      const w = lines[j].s - lines[i].s;
      bands.push({
        isArc: true,
        /**
         * `isCurve` 跟真正的圓弧分開。
         * 圓弧有唯一的半徑，可以算展開長；這種自由曲線每一段曲率都不同，
         * 沒有「一個 R」可言。出圖時要標成「曲線」而不是「R 多少」——
         * 標一個假的半徑比不標更糟（坑第 20 條：正確的數字，錯誤的意思）。
         */
        isCurve: true,
        s0: lines[i].s, s1: lines[j].s,
        chordW: w,
        arcW: w,          // 不做拉伸：自由曲線沒有單一半徑可以算真弧長
        angle: ang,
        r: 0,
        segs: seg.length,
        approx: false,
        flange: undefined,
        lines: seg
      });
      for (const L of seg) {
        used.add(L);
        for (const f of L.folds) f.band = bands[bands.length - 1];
      }
    }
    i = j + 1;
  }
}

function sharpBand(L) {
  return {
    isArc: false, s0: L.s, s1: L.s, chordW: 0, arcW: 0,
    angle: L.angle, r: 0, segs: 0, approx: false, flange: undefined,
    lines: [L]
  };
}

/** 圓弧的每一格都要往同一邊轉，一正一負那是波浪不是圓弧 */
function sameSign(lines, from, to) {
  const s = Math.sign(lines[from + 1].angle);
  for (let q = from + 1; q <= to - 1; q++) {
    if (Math.sign(lines[q].angle) !== s) return false;
  }
  return true;
}

const near = (a, b) => Math.abs(a - b) <= 1e-6 + 1e-4 * Math.max(Math.abs(a), Math.abs(b));

/**
 * 每一道折彎兩側的平面段長度（折邊），單位 cm。
 *
 * 材料規則要拿它檢查「折邊會不會太短，短到模具夾不住」。
 * 兩端最外側的折彎，外側折邊量到展開圖的邊界為止。
 *
 * 一定要等擺正之後才算：擺正後 x 就是展開方向，
 * 折彎帶的 x0/x1 與圖面邊界可以直接相減。
 */
function computeFlanges(bands, minX, maxX) {
  for (let i = 0; i < bands.length; i++) {
    const before = i === 0 ? minX : bands[i - 1].x1;
    const after = i === bands.length - 1 ? maxX : bands[i + 1].x0;
    bands[i].flange = Math.max(0, Math.min(bands[i].x0 - before, after - bands[i].x1));
  }
}

/**
 * 〔2026-08-23 刪除〕`applyStretch()` —— 沿垂直於折線的方向做一維拉伸，
 * 把弦長換成弧長。整支拿掉，不是註解掉。
 *
 * **理由**：展開尺寸 ＝ 網格攤平後的總和，沒有任何東西需要被拉長。
 * 詳見「四、圓弧修正」那一節開頭。
 *
 * 留這段墓碑是因為它會被重新想出來 —— 看到「弦長比弧長短」很容易
 * 得到「所以要補回去」的結論。**不要補。** 短的那一截不是誤差，
 * 是你在建模時選 seg=32 而不是 seg=128 所付出的代價，
 * 而那個代價本來就該由建模階段承擔。
 */

// ═══════════════════════════════════════════════════════
//  五、輪廓
// ═══════════════════════════════════════════════════════

/**
 * 沿著這一片的邊界走一圈，得到外輪廓與內孔。
 * 做法跟 region.js 的 regionLoops 相同：邊界半邊 ＝ 自己在片內、
 * 隔壁不在（或根本沒有隔壁）。
 */
function traceLoops(mesh, faces, inPatch, pt2, isCut) {
  const isBorder = he => he.face && inPatch.has(he.face.id) && isCut(he);

  const border = new Set();
  for (const f of faces) {
    for (const he of mesh.faceLoop(f)) if (isBorder(he)) border.add(he);
  }

  const loops = [];
  const used = new Set();

  for (const start of border) {
    if (used.has(start)) continue;
    const loop = [];
    let he = start, guard = 0;

    do {
      used.add(he);
      const p = pt2.get(he.id);
      if (p) loop.push(p);

      let c = he.next, spin = 0;
      while (c && !isBorder(c) && spin++ < 1e5) {
        if (!c.twin) break;
        c = c.twin.next;
      }
      if (!c || !isBorder(c)) break;
      he = c;
    } while (he !== start && guard++ < 1e6);

    if (loop.length >= 3) loops.push(dropCollinear(loop));
  }

  // 面積最大的當外輪廓，其餘是孔
  loops.sort((a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)));
  return loops;
}

/**
 * 去掉直線中間的多餘點。
 * 攤平後的輪廓上會留下一堆三角化／分段的殘留點，
 * 標尺寸與出 DXF 之前一定要清掉，否則一條邊會變成十幾條線。
 */
function dropCollinear(loop, tolDeg = 0.1) {
  if (loop.length < 3) return loop.slice();
  const cosTol = Math.cos((180 - tolDeg) / DEG);
  const out = [];

  for (let i = 0; i < loop.length; i++) {
    const a = loop[(i - 1 + loop.length) % loop.length];
    const c = loop[i];
    const b = loop[(i + 1) % loop.length];
    const ax = a.x - c.x, ay = a.y - c.y;
    const bx = b.x - c.x, by = b.y - c.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    if ((ax * bx + ay * by) / (la * lb) <= cosTol) continue;
    out.push(c);
  }
  return out.length >= 3 ? out : loop.slice();
}

function signedArea(loop) {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

// ═══════════════════════════════════════════════════════
//  六、擺正與量尺寸
// ═══════════════════════════════════════════════════════

/**
 * 把展開圖轉成慣用的擺法：折線一律是直的（垂直），
 * 展開方向就是水平的 x —— 這是鈑金廠看習慣的下料圖樣子，
 * 也讓「這一段幾公分」的標註全部落在同一條尺寸線上。
 * 沒有折線的平板則讓最長的一條邊水平。
 *
 * 就地改動 pt2 裡的每一個點，所以折線、輪廓、折彎帶會一起跟著轉。
 */
function orient(pt2, folds, mesh, faces, isCut) {
  let ang = 0;

  if (folds.length) {
    const f = folds[0];
    ang = Math.atan2(f.b.y - f.a.y, f.b.x - f.a.x) - Math.PI / 2;
  } else {
    // 只看輪廓上的邊。內部的三角化對角線比外框還長（100×60 的板子
    // 對角線是 116.6），拿它當基準會讓整張圖歪掉。
    let best = -1;
    for (const face of faces) {
      const loop = mesh.faceLoop(face);
      for (let i = 0; i < loop.length; i++) {
        if (!isCut(loop[i])) continue;
        const a = pt2.get(loop[i].id);
        const b = pt2.get(loop[(i + 1) % loop.length].id);
        if (!a || !b) continue;
        const L = Math.hypot(b.x - a.x, b.y - a.y);
        if (L > best) { best = L; ang = Math.atan2(b.y - a.y, b.x - a.x); }
      }
    }
  }

  const c = Math.cos(-ang), s = Math.sin(-ang);
  let minX = Infinity, minY = Infinity;

  for (const p of pt2.values()) {
    const x = p.x * c - p.y * s;
    const y = p.x * s + p.y * c;
    p.x = x; p.y = y;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  }
  if (!Number.isFinite(minX)) return;

  // 平移到左下角原點，出圖與 DXF 都從 0 起算
  for (const p of pt2.values()) { p.x -= minX; p.y -= minY; }
}

function* allPoints(piece) {
  yield* piece.outline;
  for (const h of piece.holes) yield* h;
  for (const f of piece.faces) yield* f;
}

function measure(piece, mesh, faces) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of allPoints(piece)) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  piece.bbox = { minX, minY, maxX, maxY };
  piece.width = Number.isFinite(minX) ? maxX - minX : 0;
  piece.height = Number.isFinite(minY) ? maxY - minY : 0;

  // 面積直接用 3D 的真實面積 —— 攤平是等距的，面積不變，
  // 而且不必為了輪廓有沒有孔傷腦筋
  let a = 0;
  for (const f of faces) {
    const vs = mesh.faceVerts(f);
    for (let i = 2; i < vs.length; i++) {
      const ab = new THREE.Vector3().subVectors(vs[i - 1].p, vs[0].p);
      const ac = new THREE.Vector3().subVectors(vs[i].p, vs[0].p);
      a += ab.cross(ac).length() / 2;
    }
  }
  piece.area = a;
}

// ═══════════════════════════════════════════════════════
//  七、重疊偵測
// ═══════════════════════════════════════════════════════

/**
 * 攤平後有沒有兩塊疊在一起。
 *
 * 有重疊就代表這一片沒辦法用一整張料做出來，必須自己去標分片切開。
 *
 * 面數多的時候先用外接框篩掉九成以上的配對，再做分離軸測試。
 *
 * ── 🔴 為什麼要回傳兩個值，不是一個布林 ──────────────
 * 〔2026-08-23 修正〕原本超過 3000 片時直接 `return false`，
 * 也就是**大模型一律顯示「沒問題」，而且不會說自己沒檢查**。
 * 那是沉默的漏報 —— 使用者連「要懷疑」都不知道。
 *
 * 「沒有重疊」和「沒有檢查」是兩件完全不同的事，
 * 用同一個 `false` 表達，等於把後者藏起來。現在分開回傳：
 *   checked=false → 太大，沒檢查（介面要講出來）
 *   checked=true, hit=false → 真的檢查過而且乾淨
 *
 * @returns {{hit: boolean, checked: boolean}}
 */
const OVERLAP_MAX_POLYS = 3000;

function detectOverlap(polys) {
  if (polys.length < 2) return { hit: false, checked: true };
  if (polys.length > OVERLAP_MAX_POLYS) return { hit: false, checked: false };

  const boxes = polys.map(bbox);
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      if (!boxHit(boxes[i], boxes[j])) continue;
      if (sharesEdge(polys[i], polys[j])) continue;
      if (polyHit(polys[i], polys[j])) return { hit: true, checked: true };
    }
  }
  return { hit: false, checked: true };
}

function bbox(poly) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const p of poly) {
    a = Math.min(a, p.x); c = Math.max(c, p.x);
    b = Math.min(b, p.y); d = Math.max(d, p.y);
  }
  return { minX: a, minY: b, maxX: c, maxY: d };
}

const EPS = 1e-7;
const boxHit = (a, b) =>
  a.minX < b.maxX - EPS && b.minX < a.maxX - EPS &&
  a.minY < b.maxY - EPS && b.minY < a.maxY - EPS;

/**
 * 相鄰的面本來就貼在一起，不算重疊。
 *
 * 判斷條件是「共用兩個點」也就是共用一條邊 —— **只共用一個角不算**。
 * 展開圖上很多面只在角落碰到，若把碰到角就當成相鄰，
 * 真正疊在一起的面會被一起放過去（方塊的展開圖實測過會漏判）。
 */
function sharesEdge(A, B) {
  let n = 0;
  for (const p of A) {
    for (const q of B) {
      if (Math.abs(p.x - q.x) < 1e-7 && Math.abs(p.y - q.y) < 1e-7) { n++; break; }
    }
    if (n >= 2) return true;
  }
  return false;
}

/** 分離軸測試。展開後的面幾乎都是三角形或四邊形，都是凸的。 */
function polyHit(A, B) {
  for (const poly of [A, B]) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const nx = -(b.y - a.y), ny = b.x - a.x;
      const L = Math.hypot(nx, ny);
      if (L < 1e-12) continue;
      const [a0, a1] = project(A, nx / L, ny / L);
      const [b0, b1] = project(B, nx / L, ny / L);
      if (a1 < b0 + 1e-6 || b1 < a0 + 1e-6) return false;   // 找到分離軸
    }
  }
  return true;
}

function project(poly, nx, ny) {
  let lo = Infinity, hi = -Infinity;
  for (const p of poly) {
    const d = p.x * nx + p.y * ny;
    lo = Math.min(lo, d); hi = Math.max(hi, d);
  }
  return [lo, hi];
}

// ═══════════════════════════════════════════════════════
//  八、相同的片合併成「一張圖 ×N」
// ═══════════════════════════════════════════════════════

/**
 * 12 片一樣的側板，要出的是**一張圖標 ×12**，不是 12 張一樣的圖。
 * 這跟說明表的「套數」是同一個概念，也是第 2 期把陣列做成修飾器
 * 而不是複製成 N 個物件的理由。
 *
 * 判斷「一樣」用尺寸與折彎序列，不用輪廓逐點比對 ——
 * 鏡射過的片點順序會反過來，但那仍然是同一張下料圖。
 */
function groupIdentical(pieces, merge = true) {
  /**
   * merge=false ＝ 分切過的物件。每片各自一張圖、各自帶接合編號，
   * 不合併。理由見 unfoldMesh() 裡「接合編號」那一段。
   */
  if (!merge) {
    pieces.forEach((p, i) => { p.name = `展開片 ${i + 1}`; });
    return pieces;
  }

  const map = new Map();
  for (const p of pieces) {
    const key = [
      p.width.toFixed(4), p.height.toFixed(4), p.area.toFixed(4),
      p.outline.length, p.holes.length,
      p.bends.map(b => `${b.isArc ? 'A' : 'S'}${b.angle.toFixed(2)}` +
        `/${b.r.toFixed(4)}/${b.x0.toFixed(3)}`).join(',')
    ].join('|');

    const hit = map.get(key);
    if (hit) hit.qty++;
    else map.set(key, p);
  }

  const out = [...map.values()];
  out.forEach((p, i) => { p.name = `展開片 ${i + 1}`; });
  return out;
}
