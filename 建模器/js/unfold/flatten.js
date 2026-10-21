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

/**
 * 程式自己剪開的邊，兩側攤平後相距不到這個值 ⇒ 其實沒張開，⛔ 不剪（cm，＝ 10 微米）。
 * 理由見 `flattenPatch()` 裡「兩側攤平後完全貼在一起的」那一段。
 */
const SEAM_SHUT_TOL_CM = 0.001;
/** 比這短的邊最後才拿來當攤平的軸（見 `flattenPatch()` 的 `pushFrontier`，2026-10-21）*/
const SHORT_HINGE_CM = 0.01;
/** 轉折角（弧度，最多 π）加上這個 ⇒ 排在所有一般的邊後面 */
const SHORT_HINGE_PENALTY = 10;

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

  /**
   * 🔴 **展開方式**（2026-10-12，kang 拍板）：`'exact'`（預設）＝ 精確分片（原本的路，一個字都不變）；
   * `'dart'` ＝ **省道打版**：容許變形、縫邊長度保持真值、變形只擠到片的中間。
   * → `規格\建模器-省道打版.md`「第二步」
   *
   * ⭐ 省道打版**⛔ 管材料「折不折得動」**（布哪裡都彎得了 —— kang 2026-10-12「依照你的建議處理」）：
   * 分片只照使用者標的切線。⇒ 幾何核心看到的是一份「什麼都折得動」的規則；
   * 材料本身（縫份那一行、`validate()`）照舊用原本的 `rule`。
   */
  const dart = opts.mode === 'dart';
  const geo = dart ? Object.assign(Object.create(rule), { foldable: true, canFold: () => true }) : rule;
  /**
   * 🔴 **試算模式**（2026-10-21，智慧分切大模型加快；kang「算得對第一、算得快第二」）：`opts.probe` ＝ 只要
   * 「幾片、有沒有重疊、外框多大、程式補剪幾條」—— ⛔ 算接合編號、接縫連段、3D 位置、放射折線、圓弧面（出圖才用）；
   * 重疊找到第一對就停（只問有沒有）；`probe.side`（面 id → 0／1）有給 ⇒ 只查兩邊之間（兩邊各自早就查過、形狀不會變 —— 見 `buildPiece()`）。
   * ⚠ 這幾個數字跟一般模式**一模一樣**（`propose.js` 用它；對照組逐條比過）。
   */
  const probe = opts.probe || null;

  mesh.computeNormals();

  if (!mesh.faces.length) {
    return { pieces: [], warnings: ['這個物件沒有任何面'], autoEdges: [], keepCut: 0, stats: empty() };
  }

  const patches = splitPatches(mesh, geo, tolDeg);
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
    const r = flattenPatch(mesh, patch, geo, tolDeg, jointNo, dart, probe);
    if (r.piece) pieces.push(r.piece);
    else if (r.error && !warnings.includes(r.error)) warnings.push(r.error);
  }

  // 完全一樣的片合併成「一張圖 ×N」—— 12 片一樣的側板要出一張圖，
  // 不是 12 張一樣的圖。這跟說明表的「套數」是同一個概念。
  /** 智慧分切要的是**全部**補剪的邊 ⇒ 在「一樣的片併成一張」之前收（併掉的片也有它自己的邊）*/
  const autoEdges = pieces.flatMap(p => p.autoEdges || []);
  /** 圓弧帶裡面的面也在併片之前收（併掉的片也有它自己的圓弧，`piece.arcFaces`）*/
  const arcFaces = pieces.flatMap(p => p.arcFaces || []);
  /**
   * 🔴 **不准切卻非切不可的**：一樣在併片之前加總（併掉的片也算），寫成整份的一則提醒（⛔ 安靜地切）。
   * ⚠ 標不准切的物件⛔ 一定標過縫，片可能被併成一張 —— 寫在卡片上只會算到留下來的那一片。
   */
  const keepLoop = new Set(pieces.flatMap(p => (p.keepCut && p.keepCut.loop) || [])).size;
  const keepMat = new Set(pieces.flatMap(p => (p.keepCut && p.keepCut.material) || [])).size;
  if (keepLoop + keepMat) {
    const why = [];
    if (keepLoop) why.push(`${keepLoop} 條是不剪就攤不開（例如繞一圈的筒子一定要剪一刀）`);
    if (keepMat) why.push(`${keepMat} 條是${rule.label}折不起來`);
    warnings.push(`有 ${keepLoop + keepMat} 條「不准切」的邊非切不可，已經切開：${why.join('；')}`);
  }
  const merged = groupIdentical(pieces, !wantJoints);

  for (const p of merged) {
    for (const w of rule.validate(p)) p.warnings.push(w);
  }

  const arcs = merged.reduce((n, p) => n + p.bends.filter(b => b.isArc).length, 0);
  const sharp = merged.reduce((n, p) => n + p.bends.filter(b => !b.isArc).length, 0);

  if (!rule.foldable && !dart) {
    warnings.push(`${rule.label}折不了，所有折線已改成切割線，各片分開下料`);
  }
  for (const p of merged) {
    /**
     * 🔴 省道打版：攤平後有面翻過來（疊在一起）＝ **這片就算能拉也做不出來**（2026-10-12）。
     * ⚠ 一般的重疊偵測抓不到它：翻過來的面跟隔壁共用一條邊，`sharesEdge()` 當成相鄰放過去了。
     * 沙箱實測：半球的開口停在 6 成高 ⇒ 上面那頂帽子太鼓，有 1 個面翻過來；不開口 ⇒ 50 個。
     */
    if (dart && p.strain && p.strain.flips) {
      /**
       * ⚠ 2026-10-19（實驗 T5：`實驗-綜合評估.md` ①-14，kang「先同意你的研究與建議」）：多講一句「不想變形可以怎麼做」——
       * T5 燈罩是 AI 拿錯了工具：圓錐面用分片的智慧分切「環帶」就 0% 攤平（3 片），省道打版是給會伸縮的材料做鼓起來的形狀用的。
       * ⭐ 照 10/09 的定案（`外部參考-打版.md` 第 2 節第 1 條）⛔ 做自動開口，只指路（`DART_HINT`）。
       */
      warnings.push(`「${p.name}」攤平後有 ${p.strain.flips} 個面翻過來（疊在一起）—— 這片就算能拉也做不出來。`
                  + `請多開幾道開口（開長一點），或多分幾片${DART_HINT}`);
    }
    if (dart && p.strain && !p.strain.converged) {
      warnings.push(`「${p.name}」算到上限還沒停下來 —— 上面的拉伸數字可能還會再變一點`);
    }
    /**
     * 重疊回饋分三態，不是一個布林。
     * 〔2026-08-23 修正。原本只有一句「有重疊，需要切分（第 7 期會做自動分片）」〕
     *
     * 舊訊息有兩個問題：
     *   · **第 7 期已經取消**（剖面分切把同一個需求解得更好），
     *     所以它承諾了一個不存在的退路 —— 使用者會等一個永遠不會來的功能
     *   · 片數超過 3000 時根本沒檢查，卻靜靜地什麼都不說
     */
    /**
     * ⚠ 省道打版已經講了「有面翻過來」⇒ 這一則⛔ 再講一次（同一件事兩則警告；
     * 而且這一則叫人「用分片切開」，那一則叫人「多開口或多分片」—— 後者才對）。
     * 【實證 2026-10-12】AI 線上先驗：球只切兩條經線，每片都是兩則一樣意思的紅字。
     */
    /** 2026-10-21（分片成群第一件）：講出幾個面疊在一起、標在哪 ⇒ 知道該往哪裡切 */
    if (p.overlap && !(dart && p.strain && p.strain.flips)) {
      const nf = (p.overlapFaces || []).length;
      warnings.push(`「${p.name}」攤平後有重疊 —— ${nf} 個面疊在一起${p.overlapMore ? '（還不只）' : ''}，圖上標紅；`
                  + `這張圖不能直接下料。請用「分片」在那幾個面附近切開（分片模式的即時預覽也會在 3D 上標紅）`);
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
    /** 程式自己補剪的邊（每條一次、所有片）—— 智慧分切的提案用（2026-10-13）*/
    autoEdges,
    /** 圓弧帶裡面的面（face id，所有片）—— 折不了的材料要先拿掉（`part.js`，2026-10-19 ①-13）*/
    arcFaces,
    /** 不准切卻非切不可的條數（所有片）*/
    keepCut: keepLoop + keepMat,
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
function flattenPatch(mesh, faces, rule, tolDeg, jointNo = null, dart = false, probe = null) {
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
      /**
       * 🔴 **「不准切」排最前面**（2026-10-13，智慧分切第一步）：先連起來 ⇒ 程式自己補剪時繞開它。
       * ⭐ 沒標不准切的物件，排序跟以前逐字一樣（只有標了的才拿 −1）—— 測試守著「展開結果一個字都不變」。
       *
       * 🔴 **很短的邊最後才當軸**（2026-10-21，`分片成群-設計方向.md` 10.6，kang「同意你的建議」）：
       * 拿一條很短的邊當軸，它方向上一點點誤差會被放大到整片 ⇒ 遠處的縫兩側對不上（> 0.001 cm）⇒ 多剪一刀。
       * 【實證】獅子頭有一條 0.0001 cm 的邊，轉折比旁邊 2.6 cm 那條小 ⇒ 被先挑來當軸 ⇒ 多剪 5 刀、智慧分切 11 片（改後 9 片）。
       * ⭐ 有別的邊可以接就先用別的；沒有很短的邊的物件排序一個字都不變（對照：70 組展開、87 項提案只有獅子頭變）。
       */
      const shortE = he.v.p.distanceTo(he.next.v.p) < SHORT_HINGE_CM;
      frontier.push(he, he.keep ? -1 : d === null ? Infinity : Math.abs(d) + (shortE ? SHORT_HINGE_PENALTY : 0));
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

  /**
   * 🔴 **兩側攤平後完全貼在一起的，⛔ 不剪**（2026-10-12，kang 同意）。
   *
   * 生成樹沒走到的邊**不一定張得開**：圓柱的蓋子是一圈三角形繞著圓心，
   * 樹在那一圈裡一定漏掉一條，而圓心是平的（角虧 0）—— 那條邊兩側攤平後**落在同一個位置**。
   * 舊版照樣把它當切割線 ⇒ **蓋子上多一刀，從圓心切到邊**（實測：圓柱、圓錐、角柱、半球的蓋子各一條，
   * 圓環 27 條；照圖切就是把好好的蓋子剪開）。
   *
   * ⭐ 判準只問「兩端在圖上是不是同一點」—— 是 ⇒ 兩側的料本來就連著，這條邊照一般的邊處理
   * （有轉折就是折線，平的就什麼都不畫）。⛔ 不問角虧：角虧是「為什麼」，貼不貼得上才是「結果」。
   * 容許值 0.001 cm（10 微米）：比這更近的縫，刀子也切不出來。
   * ⚠ 這時的座標還是**剛體攤平**的結果（圓弧修正、擺正都在 `buildPiece()` 裡，還沒做）。
   *
   * 🔴 **省道打版⛔ 做這一步**（2026-10-12）：剛體攤平只是它的起點，座標之後會被拉動 ——
   * 「現在貼在一起」不代表「拓撲上不用剪」。圓環那段要剪開的一刀裡，剛好有邊兩側是貼著的，
   * 這一步先把它拿掉 ⇒ 環沒剪開 ⇒ 拉出來打結（【實證】拉 89%、7 個面翻過來）。
   * 省道打版該剪幾刀由 `pruneToTopology()` 決定。
   */
  for (const f of dart ? [] : used) {
    for (const he of mesh.faceLoop(f)) {
      if (!implicit.has(he.id) || !he.twin) continue;
      const t = he.twin;
      const a1 = pt2.get(he.id), b1 = pt2.get(he.next.id);     // 這一側：a → b
      const b2 = pt2.get(t.id), a2 = pt2.get(t.next.id);       // 另一側：b → a
      if (!a1 || !b1 || !a2 || !b2) continue;
      if (Math.hypot(a1.x - a2.x, a1.y - a2.y) < SEAM_SHUT_TOL_CM
          && Math.hypot(b1.x - b2.x, b1.y - b2.y) < SEAM_SHUT_TOL_CM) {
        implicit.delete(he.id); implicit.delete(t.id);
      }
    }
  }

  /** 🔴 省道打版：程式自己剪的邊只留「不剪就攤不開」的那幾條（理由見 `pruneToTopology()`）*/
  if (dart) pruneToTopology(mesh, used, implicit, he => edgeIsCut(mesh, he, rule, tolDeg));

  const isCut = he => edgeIsCut(mesh, he, rule, tolDeg) || implicit.has(he.id);

  // 完全封閉、一條邊都不能切 → 展不開。封閉實體要先抽殼，
  // 或自己標出切割線（紙模那種「剪開攤平」排在第 7 期）。
  let border = 0;
  for (const f of used) for (const he of mesh.faceLoop(f)) if (isCut(he)) border++;
  if (!border) {
    return { error: '這是封閉的實體，沒有任何切割線可以攤開。請先抽殼成板件，或標出要剪開的邊' };
  }

  /** 🔴 省道打版：剛體攤平只是起點，接著拉成「縫邊等長、變形在中間」（`relaxDart()`）*/
  const strain = dart ? relaxDart(mesh, used, pt2, isCut) : null;

  const piece = buildPiece(mesh, used, pt2, isCut, rule,
    used.length < faces.length ? ['有部分面攤不開，可能是網格結構有問題'] : [],
    jointNo, he => implicit.has(he.id), strain, probe);

  /**
   * 🔴 **程式自己補剪的邊（每條一次）＋ 不准切卻非切不可的**（2026-10-13，智慧分切第一步）。
   * `autoEdges`：智慧分切的提案就是這幾條（`propose.js`）。
   * `keepCut`：標了不准切、最後還是切開的 —— `loop` ＝ 不剪就攤不開（例如繞一圈的筒子），
   * `material` ＝ 材料折不了（壓克力的轉角）。卡片照實講（⛔ 安靜地切）。
   */
  const autoEdges = [], seenE = new Set(), keepLoop = [], keepMat = [];
  for (const f of used) {
    for (const he of mesh.faceLoop(f)) {
      if (!he.twin || !he.twin.face) continue;
      const k = Math.min(he.id, he.twin.id);
      if (seenE.has(k)) continue;
      seenE.add(k);
      if (implicit.has(he.id)) autoEdges.push(he);
      if (!he.keep) continue;
      if (implicit.has(he.id)) keepLoop.push(k);
      else if (edgeIsCut(mesh, he, rule, tolDeg)) keepMat.push(k);
    }
  }
  piece.autoEdges = autoEdges;
  /**
   * 記「哪幾條」（邊的鍵）⛔ 記條數：材料折不了的那一條夾在**兩片**之間，兩片各看到一次 ——
   * 加總時要去掉重複（【實證】壓克力方塊 12 條邊全標不准切，第一版寫成「24 條」）。
   */
  piece.keepCut = { loop: keepLoop, material: keepMat };
  return { piece };
}

/**
 * 🔴 **省道打版：程式自己剪的邊，只留「不剪就攤不開」的那幾條**（2026-10-12）。
 *
 * 模式一剪掉生成樹沒走到的每一條邊 —— 那是為了**攤平不變形**（每個鼓的點都要剪到）。
 * 模式二的鼓交給材料伸縮，⛔ 不該再為它剪；但**拓撲上**還是有非剪不可的：
 * 圓環切成一段一段，每段是一個「環」，不剪一刀永遠攤不開。
 *
 * ⭐ 做法（「切割圖」的標準做法）：從模式一那批邊出發，**一直修掉停在片中間的那一頭** ——
 * 某個頂點只接一條、而且它⛔ 在邊界上（網格邊界、使用者標的切線、開口），那條就不必剪。
 * 修到不能再修，剩下的就是：連接兩個邊界的路（環要剪開的那一刀）、或繞著洞的圈。
 * 【沙箱實證 2026-10-12】球、半球一條都不剩；圓環每段剩一條（8 條邊）。
 *
 * ⚠ 用佇列一次走完（⛔ 每輪從頭掃 —— 預設球直接展開有 481 條要修，那會是 O(邊數²)）。
 *
 * @param {Set<number>} implicit 就地刪改（兩條半邊一起）
 * @param {(he)=>boolean} isRealCut 網格邊界 ＋ 使用者標的切線（⛔ 含 implicit）
 */
function pruneToTopology(mesh, faces, implicit, isRealCut) {
  const onBd = new Set();
  const inc = new Map();                       // 頂點 → 還留著的 implicit 邊（取 id 小的那條半邊）
  for (const f of faces) {
    for (const he of mesh.faceLoop(f)) {
      if (isRealCut(he)) { onBd.add(he.v.id); onBd.add(he.to.id); continue; }
      if (!implicit.has(he.id) || (he.twin && he.twin.id < he.id)) continue;
      for (const v of [he.v.id, he.to.id]) {
        if (!inc.has(v)) inc.set(v, new Set());
        inc.get(v).add(he);
      }
    }
  }
  const queue = [...inc.keys()].filter(v => inc.get(v).size === 1 && !onBd.has(v));
  while (queue.length) {
    const v = queue.pop();
    const set = inc.get(v);
    if (!set || set.size !== 1 || onBd.has(v)) continue;
    const he = [...set][0];
    implicit.delete(he.id); if (he.twin) implicit.delete(he.twin.id);
    for (const w of [he.v.id, he.to.id]) {
      const s = inc.get(w); if (!s) continue;
      s.delete(he);
      if (w !== v && s.size === 1 && !onBd.has(w)) queue.push(w);
    }
  }
}

/**
 * 🔴 **省道打版的攤平：縫邊長度 ＝ 3D 真值（硬規定），變形只擠到片的中間**（2026-10-12）。
 *
 * kang 定的（`外部參考-打版.md` 第 4 節）：容許變形、但**縫邊長度保持真值**、每片印出拉／壓幾 %。
 * 業界的同一類做法：彈簧／能量最小化（ExactFlat、CDI 專利、technet 的硬約束）。
 *
 * ── 怎麼做 ──────────────────────────────────────────
 * 每個面的每條邊、加上三角化的對角線當彈簧（原長 ＝ 3D 長度，面因此保持形狀）；
 * 切割線（網格邊界、使用者的縫與開口、程式為了攤開才剪的）那幾條是「縫邊」。
 *   ① 從剛體攤平出發（模式一同一套），把同一個點的幾個角合成一個節點
 *   ② 整片一起拉幾輪
 *   ③ **交替**：中間拉一次 → 縫邊拉回原長好幾次，反覆到不動為止
 *   ④ 最後只拉縫邊，直到誤差 < 十億分之一
 * ⚠ 試過但比較差的：「縫邊先拉準、再固定縫邊只動中間」—— 中間被逼到極端（球 4 片不開口拉 80%，交替是 22%）。
 *
 * ── 收斂 ────────────────────────────────────────────
 * 【沙箱實證 2026-10-12】交替 1000 輪 vs 16000 輪，最大拉／壓差不到 0.05% ⇒ 每 50 輪看一次最大位移，
 * 小到 1 微米（0.0001 cm）就停；上限 6000 輪，到上限還在動就講出來（`converged`）。
 *
 * @returns {{faces:number[], max:number, min:number, seamErr:number, flips:number, converged:boolean, area:number}}
 *   `faces[i]` ＝ 第 i 個面（`faces` 的順序）的平均拉伸（正＝拉長、負＝壓縮，0.05 ＝ 5%）
 *   `area` ＝ 攤平後的面積（布要買多少；⚠ 跟 3D 表面積不一樣，那就是變形）
 */
function relaxDart(mesh, faces, pt2, isCut) {
  // ① 角 → 節點（不切的邊兩側是同一個點）
  const par = new Map();
  const find = x => { while (par.get(x) !== x) { par.set(x, par.get(par.get(x))); x = par.get(x); } return x; };
  for (const f of faces) for (const he of mesh.faceLoop(f)) par.set(he.id, he.id);
  const inPatch = new Set(faces.map(f => f.id));
  for (const f of faces) {
    for (const he of mesh.faceLoop(f)) {
      if (isCut(he) || !he.twin || !he.twin.face || !inPatch.has(he.twin.face.id)) continue;
      const t = he.twin;
      for (const [a, b] of [[he.id, t.next.id], [he.next.id, t.id]]) {
        const ra = find(a), rb = find(b); if (ra !== rb) par.set(ra, rb);
      }
    }
  }
  const idx = new Map();
  let n = 0;
  for (const id of par.keys()) { const r = find(id); if (!idx.has(r)) idx.set(r, n++); }

  /**
   * 起點：**從一個面一圈一圈往外擺**（廣度優先、照這一片最後的切線）——
   * ⛔ 直接用模式一的剛體攤平（「先走最平的邊」，而且是照模式一那批多剪的邊擺的）。
   * 【實證 2026-10-12】圓環那一段照模式一的擺法會攤成一長條繞來繞去，拉完 89%、7 個面翻過來；
   * 一圈一圈往外擺是 27%、0 個（跟沙箱版一致）。球兩種起點結果一樣。
   */
  const start = new Map();
  {
    const seed = faces[0], loop = mesh.faceLoop(seed), o = loop[0].v.p;
    const e1 = new THREE.Vector3().subVectors(loop[1].v.p, o).normalize();
    const e2 = new THREE.Vector3().crossVectors(seed.normal, e1);
    for (const he of loop) {
      const d = new THREE.Vector3().subVectors(he.v.p, o);
      start.set(he.id, { x: d.dot(e1), y: d.dot(e2) });
    }
    const placed = new Set([seed.id]), queue = [seed];
    for (let qi = 0; qi < queue.length; qi++) {
      for (const he of mesh.faceLoop(queue[qi])) {
        const t = he.twin;
        if (isCut(he) || !t || !t.face || !inPatch.has(t.face.id) || placed.has(t.face.id)) continue;
        placeFace(mesh, t, start.get(he.next.id), start.get(he.id), start);
        placed.add(t.face.id); queue.push(t.face);
      }
    }
  }
  const X = new Float64Array(n), Y = new Float64Array(n), C = new Float64Array(n);
  for (const id of par.keys()) {
    const k = idx.get(find(id)), p = start.get(id) || pt2.get(id);
    if (!p) continue;
    X[k] += p.x; Y[k] += p.y; C[k]++;
  }
  for (let k = 0; k < n; k++) if (C[k]) { X[k] /= C[k]; Y[k] /= C[k]; }
  const nid = he => idx.get(find(he.id));

  // 彈簧：面的邊（記是不是縫邊）＋ 三角化的對角線
  const springs = new Map();
  const add = (a, b, L, edge, bd) => {
    if (a === b) return;
    const key = a < b ? a * n + b : b * n + a;
    const s = springs.get(key);
    if (!s) springs.set(key, { a, b, L, edge, bd });
    else { s.edge = s.edge || edge; s.bd = s.bd || bd; }
  };
  for (const f of faces) {
    const loop = mesh.faceLoop(f);
    for (const he of loop) add(nid(he), nid(he.next), he.v.p.distanceTo(he.next.v.p), true, isCut(he));
    /**
     * ⚠ 六邊以內的面：**每兩個角之間都拉一條**（四邊形兩條對角線都要）。
     * 只拉三角化的一條對角線，四邊形會**斜著歪掉**而每條邊長度都沒變 —— 拉伸數字看起來變小，
     * 其實布被斜拉了（那也是變形）。【實證 2026-10-12】只拉一條時圓環有 21 個面翻過來，兩條都拉 0 個。
     * 更大的面（共面合併出來的大片）用三角化，⛔ 每兩點一條（32 邊形會變 496 條）。
     */
    if (loop.length <= 6) {
      for (let i = 0; i < loop.length; i++) for (let k = i + 2; k < loop.length; k++) {
        if (i === 0 && k === loop.length - 1) continue;
        add(nid(loop[i]), nid(loop[k]), loop[i].v.p.distanceTo(loop[k].v.p), false, false);
      }
    } else {
      const byV = new Map(loop.map(he => [he.v, he]));
      for (const [a, b, c] of mesh.faceTriangles(f)) {
        for (const [u, v] of [[a, b], [b, c], [c, a]]) {
          const hu = byV.get(u), hv = byV.get(v);
          if (hu && hv) add(nid(hu), nid(hv), u.p.distanceTo(v.p), false, false);
        }
      }
    }
  }
  const all = [...springs.values()];
  const bd = all.filter(s => s.bd), inner = all.filter(s => !s.bd);

  const pull = list => {
    for (const s of list) {
      const dx = X[s.b] - X[s.a], dy = Y[s.b] - Y[s.a];
      const l = Math.hypot(dx, dy) || 1e-12;
      const c = (l - s.L) / l * 0.5;
      const mx = dx * c, my = dy * c;
      X[s.a] += mx; Y[s.a] += my; X[s.b] -= mx; Y[s.b] -= my;
    }
  };
  const seamErr = () => {
    let e = 0;
    for (const s of bd) e = Math.max(e, Math.abs(Math.hypot(X[s.b] - X[s.a], Y[s.b] - Y[s.a]) / s.L - 1));
    return e;
  };

  for (let i = 0; i < 300; i++) { pull(all); pull(bd); pull(bd); }                  // ②
  /**
   * ③ 收斂：**比「這 50 輪前後，形狀差多少」**（⛔ 比「這一輪有沒有人在動」）——
   * 中間拉一次、縫邊拉回來，到了平衡點每一輪還是會互相推來推去一點點，但形狀已經不變了。
   * 【實證 2026-10-12】第一版比「這一輪動了多少」，一次都沒停過。
   * ⚠ **整片會一直慢慢轉**（這種一條一條拉的做法的副作用，形狀不變）⇒ 比之前先扣掉平移與轉動。
   * 【實證 2026-10-12】只扣平移時，每 50 輪的差停在 0.001 cm 不再下降 —— 那就是整片在轉，6000 輪都停不下來。
   */
  let converged = false;
  const PX = new Float64Array(n), PY = new Float64Array(n);
  const snap = () => {
    let cx = 0, cy = 0; for (let k = 0; k < n; k++) { cx += X[k]; cy += Y[k]; } cx /= n; cy /= n;
    /** 跟上一次比，整片轉了幾度（最小平方的那個角度）*/
    let sn = 0, cs = 0;
    for (let k = 0; k < n; k++) { const x = X[k] - cx, y = Y[k] - cy; sn += PX[k] * y - PY[k] * x; cs += PX[k] * x + PY[k] * y; }
    const th = Math.atan2(sn, cs), c = Math.cos(-th), s = Math.sin(-th);
    let d = 0;
    for (let k = 0; k < n; k++) {
      const x = X[k] - cx, y = Y[k] - cy;
      d = Math.max(d, Math.abs(x * c - y * s - PX[k]) + Math.abs(x * s + y * c - PY[k]));
      PX[k] = x; PY[k] = y;
    }
    return d;
  };
  snap();
  /**
   * 門檻跟著片的大小走：每 50 輪形狀變化 < 片大小的百萬分之五（1 公尺的片 ＝ 0.05 mm），最少 1 微米。
   * 【實證 2026-10-12】預設球分 4 片（每片 97 cm）到 6000 輪還在以每 50 輪 0.0015 mm 慢慢變 ——
   * 固定 1 微米會一直報「還沒算完」，那是誤報（刀子根本切不出這種差別）。
   */
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let k = 0; k < n; k++) { x0 = Math.min(x0, X[k]); x1 = Math.max(x1, X[k]); y0 = Math.min(y0, Y[k]); y1 = Math.max(y1, Y[k]); }
  const tol = Math.max(1e-4, 5e-6 * Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i < 6000; i++) {                                                    // ③
    pull(inner);
    for (let j = 0; j < 6; j++) pull(bd);
    if (i % 50 === 49 && snap() < tol) { converged = true; break; }
  }
  for (let i = 0; i < 20000; i++) { pull(bd); if (i % 100 === 99 && seamErr() < 1e-9) break; }   // ④

  // 寫回每個角
  for (const id of par.keys()) { const k = idx.get(find(id)); pt2.set(id, { x: X[k], y: Y[k] }); }

  // 拉伸：面的邊（2D 長 ÷ 3D 長 − 1）
  let max = 0, min = 0, flipsPos = 0, flipsNeg = 0, area = 0;
  const per = [];
  for (const f of faces) {
    const loop = mesh.faceLoop(f);
    let sum = 0, a2 = 0;
    for (const he of loop) {
      const p = pt2.get(he.id), q = pt2.get(he.next.id);
      const e = Math.hypot(q.x - p.x, q.y - p.y) / he.v.p.distanceTo(he.next.v.p) - 1;
      sum += e; if (e > max) max = e; if (e < min) min = e;
      a2 += p.x * q.y - q.x * p.y;
    }
    per.push(sum / loop.length);
    if (a2 > 0) flipsPos++; else flipsNeg++;
    area += Math.abs(a2) / 2;
  }
  return { faces: per, max, min, seamErr: seamErr(), flips: Math.min(flipsPos, flipsNeg), converged, area };
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
function buildPiece(mesh, faces, pt2, isCut, rule, warn, jointNo = null, isAuto = () => false, strain = null, probe = null) {
  const inPatch = new Set(faces.map(f => f.id));

  /**
   * 🔴 省道打版（`strain` 有值）：**⛔ 折線、⛔ 圓弧修正**（kang 2026-10-12「依照你的建議處理」）——
   * 布、皮不會沿著網格的稜線折；球一片會有幾百條折線，畫了只是雜訊。
   */
  const found = collectFolds(mesh, faces, inPatch, pt2, isCut);
  const folds = strain ? [] : found;

  /**
   * 折線的方向分組要在修正之前算好，而且要傳給 arcCorrection 共用一份。
   *
   * 分組數本身就是一個重要的事實：**一維拉伸修正只在折線互相平行時成立**
   * （見「四、圓弧修正」開頭的說明）。只有一組 ＝ 全部平行 ＝ 修正有效；
   * 超過一組就代表這一片有修正管不到的地方。
   */
  /**
   * 🔴 **有平滑標記、但互相不平行的折線 ⇒ 一整段圓錐面**（2026-10-19，實驗 T5：`實驗-綜合評估.md` ①-11，kang「同意」）。
   * ⚠ 下面那套認曲線帶的做法假設折線**互相平行**（圓柱攤開），方向差超過 1° 就分開 ——
   * 燈罩每一片是圓錐的一圈，攤開的折線是放射狀的：一片當成 15 段兩小格的曲線帶，另外兩片各 31 道「真轉角」。
   * ⭐ 那些折線其實都帶著平滑標記（旋轉成形、鋼筆的平滑點、匯入的曲線才有；方塊、圓柱、圓錐這些基本形狀沒有）
   * ⇒ 先把**連在一起的平滑折線**收成一段（`coneBands()`）；彼此平行的照舊交給下面那套（數字一個都不變）。
   */
  const cones = coneBands(folds);
  const rest = cones.length ? folds.filter(f => !f.band) : folds;
  const dirGroups = groupByDirection(rest);
  const bands = [...cones, ...arcCorrection(pt2, rest, dirGroups)];
  orient(pt2, folds, mesh, faces, isCut);

  /**
   * 開口 ＝ 使用者標的切線、兩側都在這一片（切進去、沒把片分開）。⚠ 只在省道打版才分出來 ——
   * 精確分片的圖一個字都不變（開口在那裡照舊是一般的切割線）。
   */
  const isDart = strain
    ? he => he.role === EDGE_ROLE.CUT && !!he.twin && !!he.twin.face && inPatch.has(he.twin.face.id)
    : () => false;
  const traced = traceLoops(mesh, faces, inPatch, pt2, isCut, isAuto, isDart);
  const loops = traced.map(l => l.pts);
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

  /**
   * 試算模式的重疊：找到第一對就停。`probe.side` 有給、而且這一片**程式一條都沒補剪** ⇒ 只查兩邊之間 ——
   * 沒補剪 ＝ 攤法只有一種（每一邊各自攤出來的形狀不會因為接起來而變），兩邊各自早就查過沒疊。
   * ⚠ 有補剪 ⇒ 補在哪裡會影響形狀 ⇒ 照舊全部查。
   */
  const autoLines = autoCutLines(mesh, faces, isAuto);
  const ov = probe
    ? detectOverlap(polys, { first: true, side: probe.side && !autoLines ? faces.map(f => probe.side.get(f.id)) : null })
    : detectOverlap(polys);

  const piece = {
    name: '展開片',
    qty: 1,
    outline: loops[0] || [],
    holes: loops.slice(1),
    /**
     * 🔴 **程式自己加的切線**（2026-10-12，kang 同意：橘色、DXF 另一層、卡片寫幾條、⛔ 不打 ⚠）。
     *
     * 生成樹沒走到、又真的張開的邊 —— 使用者沒標過，是程式為了攤平才剪的。
     * 方塊的十字形（7 條邊）是正常的；但**球直接展開會剪 481 條邊、分 6 片還剪 90 條**，
     * 而舊版圖上跟使用者標的長得一模一樣、一則說明都沒有（`外部參考-打版.md` 第 3 節）。
     *
     * `outline[i]`／`holes[k][i]` ＝ 從第 i 點到第 i＋1 點那一段是不是程式加的
     * （跟 `outline`／`holes` 一一對應；`dropCollinear()` ⛔ 把兩種線併成一段）。
     * `lines` ＝ 幾**條**線：連在一起的算一條，遇到分岔或端點才斷開（⛔ 不是幾段邊）。
     *
     * 🔴 **只有使用者標過分片的物件才上色**（`userSeams`，kang 2026-10-12 同意）：
     * 沒標過的，切線本來**全部**是程式決定的 —— 方塊、圓柱整圈外框都會變橘色，分不出任何東西，
     * 而且 DXF 整圈搬到 CUT_AUTO 層，切割廠只開 CUT 層就一刀都切不到。
     * ⇒ 沒標過的：`outline`／`holes` 全是 false（照舊全黑、全在 CUT），只在卡片上寫條數。
     * 判準跟接合編號同一個（`hasUserSeams()`）。
     */
    autoCut: {
      userSeams: !!jointNo,
      outline: jointNo ? ((traced[0] && traced[0].auto) || []) : [],
      holes: jointNo ? traced.slice(1).map(l => l.auto) : traced.slice(1).map(() => []),
      lines: autoLines
    },
    /**
     * 🔴 **省道打版的開口**（2026-10-12）：`outline[i]` ＝ 第 i 段是開口的一邊；
     * `vids[i]` ＝ 第 i 點是哪個頂點 —— 「只畫縫線」要把開口的口子接起來，靠它認出 V 的兩個口。
     * 精確分片 ⇒ `null`。
     */
    dartCut: strain ? {
      outline: (traced[0] && traced[0].dart) || [],
      holes: traced.slice(1).map(l => l.dart),
      vids: (traced[0] && traced[0].vids) || [],
      holeVids: traced.slice(1).map(l => l.vids)
    } : null,
    /**
     * 🔴 **省道打版的變形量**（2026-10-12）：`faces[i]` 對應 `piece.faces[i]`（正＝拉長、負＝壓縮）；
     * `max`／`min` 最多拉／壓；`seamErr` 縫邊長度最多差（應該 ≈ 0）；`flips` 翻過來的面數。
     * 精確分片 ⇒ `null`。
     */
    strain,
    /**
     * 🔴 **省道打版的折線（只在要畫的時候畫）**（2026-10-12，kang：「可以有一個開/關可以讓 DXF 與 SVG 能夠出現『折線』」）。
     * 起因：kang 用**珍珠板／發泡板**做省道打版的圓環 —— 板子要知道每一格在哪裡折。
     * ⭐ `folds` 照舊是空的（布不折、⛔ 折彎標註、⛔ 圓弧修正），折線另外放這裡，展開圖視窗「畫折線」打勾才畫。
     * 點是 `pt2` 裡的同一個物件 ⇒ 拉過、擺正之後的位置（⚠ 片有拉伸，位置是參考）。精確分片 ⇒ `null`。
     */
    dartFolds: strain ? found.map(f => ({ a: f.a, b: f.b, angle: f.angle })) : null,
    folds: folds.map(f => ({ a: f.a, b: f.b, angle: f.angle, isArcEdge: !!f.band })),
    /**
     * 接合處：這條邊在 2D 上是邊界，但在 3D 上有鄰居，要接回去。
     * 兩側的片會拿到同一個號碼。沒有分片標記的物件是空陣列。
     */
    joints: probe ? [] : collectJoints(mesh, faces, pt2, isCut, jointNo),
    /**
     * 🔴 **對位記號要的「一整條縫」**（2026-10-12）：記的是整條的每一條邊
     * （`segs[i]` ＝ `{a, b, len, va, vb}`：2D 起訖點、**3D 長度**、起訖頂點 id），而且**兩側同一個起點、同一個方向**。
     * 只在三條以上切割邊交會處斷開（⛔ 跟接合編號一樣在折線斷開）。沒有接合編號的物件是空陣列。理由見 `collectSeamRuns()`。
     */
    seamRuns: probe ? [] : collectSeamRuns(mesh, faces, pt2, isCut, jointNo),
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
    /**
     * 疊在一起的是哪幾個面（2026-10-21，`分片成群-設計方向.md` 第一件）：`faces` 的索引、由小到大、不重複；
     * `overlapPairs` ＝ 幾對（`overlapMore` ＝ 收到上限就停了，實際更多）。畫面、展開圖、3D 都照這份標紅。
     */
    overlapFaces: [...new Set(ov.pairs.flat())].sort((a, b) => a - b),
    overlapPairs: ov.pairs.length,
    overlapMore: ov.more,
    /**
     * 每個面在 3D 的位置（攤之前那份網格的座標，跟 `faces` 同一個順序）—— 3D 上標「這一片是哪些面」「哪些面疊在一起」用。
     * ⚠ 是**攤的那份網格**的座標（縮放已經吃進去、還沒套位置與旋轉）；換成世界座標是 `part.js` 的事。
     */
    faces3: probe ? [] : faces.map(f => mesh.faceLoop(f).map(he => [he.v.p.x, he.v.p.y, he.v.p.z])),
    /** 永遠 false —— 還沒有可靠的判定方式，理由見上面那一大段說明 */
    nonDevelopable: false,
    /**
     * 折線呈放射狀匯聚到同一點 ＝ 這是**錐面**，一維拉伸修正不適用。
     * 這是**事實**，不是結論；要不要據以下料由警告訊息去講。
     */
    radialFolds: probe ? [] : radialFan(folds),
    /**
     * 🔴 **圓弧帶裡面的面**（face id，2026-10-19，實驗 T3：`實驗-綜合評估.md` ①-13）：兩條以上的邊落在同一條圓弧帶上的面 ＝ 折板圓弧切出來的小格。
     * 折不了的材料（壓克力／木板）要先把這幾格拿掉 —— 不然每一格都變成一條 0.16 cm 寬的細條當成一片（`part.js` `arcStripFaces()`）。
     * ⭐ 只認 `isArc` 的帶（尖角的折線⛔ 算）；平的那段只碰到帶的一條邊 ⇒ ⛔ 算進來。
     */
    arcFaces: probe ? [] : arcFacesOf(mesh, faces, bands, found),
    area: 0, width: 0, height: 0
  };

  measure(piece, mesh, faces);
  /** 省道打版：面積 ＝ 攤平後的（布要買多少）—— ⚠ 跟 3D 表面積不一樣，差的就是變形 */
  if (strain) piece.area = strain.area;
  return piece;
}

/**
 * 省道打版變形太大時多講的那一句（翻面的提醒、`out/sheet.js` 超過上限那一行共用 —— ⛔ 兩邊各寫一份）。
 * 2026-10-19 ①-14：不做自動開口（10/09 定案），改成指出不變形的做法。
 */
export const DART_HINT = '；不想變形的話，改用「精確分片」，或到分片模式用「智慧分切」（例如環帶）—— 省道打版是給布這類會伸縮的材料用的';

/** 圓弧帶裡面的面（見 `piece.arcFaces`）*/
function arcFacesOf(mesh, faces, bands, found) {
  const out = [];
  for (const b of bands) {
    if (!b.isArc) continue;
    const es = new Set();
    for (const f of found) {
      if (f.band !== b || !f.he) continue;
      es.add(f.he.id);
      if (f.he.twin) es.add(f.he.twin.id);
    }
    for (const fc of faces) {
      let n = 0;
      for (const he of mesh.faceLoop(fc)) if (es.has(he.id)) n++;
      if (n >= 2) out.push(fc.id);
    }
  }
  return out;
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

/**
 * ── 對位記號：把一段縫串成一條，兩側走同一個方向（2026-10-12）──────────
 *
 * kang 拍板：沿縫線每隔固定距離放一個記號，兩片的記號要對得上。
 * 「對得上」只有一個辦法：**兩側從同一個 3D 頂點量起、量一樣的 3D 長度**。
 * ⇒ 這裡把一段縫（跟接合編號同一個分段）串成一條有順序的邊，而且兩側的起點、方向一定一樣：
 *
 *   · 不封閉：從兩個端點裡**頂點 id 小的那一端**開始
 *   · 封閉（一整圈都平滑）：從整圈 id 最小的頂點開始，往「下一個頂點 id 比較小」的那個方向走
 *
 * 兩側看到的是同一批頂點（一條邊和它的 twin 共用頂點），所以兩邊用同一條規則一定挑到同一端。
 * 長度用 **3D** 的：兩種展開方式的縫邊 2D 長度都等於 3D（精確分片是剛體；省道打版把縫邊拉回原長），
 * 用 3D 量就不受攤平的一點點誤差影響；畫的時候再照比例落到那條邊的 2D 上。
 *
 * 🔴 **分段⛔ 跟接合編號一樣**（2026-10-12 實測改的）：接合編號走到「真的折線」就換號碼，
 * 而球（沒有平滑標記）每一圈緯線都算真的折線 —— 12×16 的球一片西瓜皮的縫被切成 32 段、每段 5.88 cm，
 * 間距 10 cm 一個記號都放不下。⇒ 這裡**只在三條以上切割邊交會的地方斷開**（球的南北極、方塊的角），
 * 經過折線照樣往下走（`runPartition()`）。這樣仍然兩側一致：兩側看到同一批切割邊，用同一條規則斷開；
 * 長度也一樣：每一條邊的長度兩側都相同，跟中間有沒有折線無關。
 *
 * ⚠ **⛔ 照 `collectJoints()` 的「哪一側」分組**：那個 key 是拿半邊 id 大小決定的，
 * 同一段縫上不保證每條邊都分到同一側 —— 拿它串會串成好幾截，記號就從錯的地方開始量。
 * 這裡改成「同一段（`seamPartition`）、同一片」的切割邊全部放一起，再一條一條接：
 * 一條邊後面接「從它的終點出發、而且不是它自己另一側」的那一條。
 * 環狀片兩側都在同一片時（側牆繞回去接自己），兩側自然串成兩條。
 */
function collectSeamRuns(mesh, faces, pt2, isCut, jointNo) {
  if (!jointNo) return [];
  const part = runPartition(mesh, isCut, jointNo);

  const byRoot = new Map();          // 段 → 這一片上屬於它的切割半邊
  for (const f of faces) {
    for (const he of mesh.faceLoop(f)) {
      if (!isCut(he) || !he.twin || !he.twin.face) continue;
      if (!pt2.get(he.id) || !pt2.get(he.next.id)) continue;
      const k = String(part.find(edgeKey(he)));
      if (!byRoot.has(k)) byRoot.set(k, []);
      byRoot.get(k).push(he);
    }
  }

  const runs = [];
  for (const hes of byRoot.values()) {
    const from = new Map(), into = new Map();
    for (const he of hes) {
      if (!from.has(he.v.id)) from.set(he.v.id, []);
      from.get(he.v.id).push(he);
      if (!into.has(he.to.id)) into.set(he.to.id, []);
      into.get(he.to.id).push(he);
    }
    const nextOf = he => (from.get(he.to.id) || []).find(h => h !== he.twin) || null;
    const prevOf = he => (into.get(he.v.id) || []).find(h => h !== he.twin) || null;

    const used = new Set();
    for (const he of hes) {
      if (used.has(he)) continue;
      let h0 = he;
      for (let g = 0; g < hes.length; g++) {
        const p = prevOf(h0);
        if (!p || p === he || used.has(p)) break;
        h0 = p;
      }
      const chain = [];
      for (let h = h0; h && !used.has(h); h = nextOf(h)) { used.add(h); chain.push(h); }
      const closed = chain.length > 1 && nextOf(chain[chain.length - 1]) === chain[0];
      runs.push(orientRun(chain, closed, pt2));
    }
  }
  return runs;
}

/**
 * 對位記號的分段：兩條切割邊共用一個頂點、而且那個頂點上**剛好兩條**切割邊，就併成同一段 ——
 * 跟 `seamPartition()` 一樣，只是⛔ 管那個頂點上有沒有折線（理由見 `collectSeamRuns()`）。
 */
function runPartition(mesh, isCut, jointNo) {
  if (jointNo._runPart) return jointNo._runPart;
  const parent = new Map();
  const find = k => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    for (let c = k; parent.get(c) !== r;) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  const cutAt = new Map();
  for (const he of mesh.edges()) {
    if (!he.twin || !he.twin.face || !he.face || !isCut(he)) continue;
    const k = edgeKey(he);
    if (parent.has(k)) continue;
    parent.set(k, k);
    for (const v of [he.v.id, he.to.id]) {
      if (!cutAt.has(v)) cutAt.set(v, []);
      cutAt.get(v).push(k);
    }
  }
  for (const ks of cutAt.values()) {
    if (ks.length !== 2) continue;
    const a = find(ks[0]), b = find(ks[1]);
    if (a !== b) parent.set(Math.max(a, b), Math.min(a, b));
  }
  jointNo._runPart = { find };
  return jointNo._runPart;
}

/** 一串半邊 → `{closed, segs:[{a, b, len, va, vb}]}`，方向照 `collectSeamRuns()` 那條規則 */
function orientRun(chain, closed, pt2) {
  const fwd = chain.map(h => ({ a: pt2.get(h.id), b: pt2.get(h.next.id), len: h.v.p.distanceTo(h.to.p), va: h.v.id, vb: h.to.id }));
  const rev = () => fwd.slice().reverse().map(s => ({ a: s.b, b: s.a, len: s.len, va: s.vb, vb: s.va }));
  let segs = fwd;
  if (!closed) {
    if (fwd[0].va > fwd[fwd.length - 1].vb) segs = rev();
  } else {
    // 從 id 最小的頂點出發；往「下一個頂點 id 比較小」的方向
    let i0 = 0;
    for (let i = 1; i < fwd.length; i++) if (fwd[i].va < fwd[i0].va) i0 = i;
    const n = fwd.length;
    const nextV = fwd[i0].vb, prevV = fwd[(i0 - 1 + n) % n].va;
    if (prevV < nextV) {
      segs = rev();
      i0 = segs.findIndex(s => s.va === fwd[i0].va);
    }
    segs = segs.slice(i0).concat(segs.slice(0, i0));
  }
  return { closed, segs: segs.map(s => ({ a: s.a, b: s.b, len: s.len, va: s.va, vb: s.vb })) };
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
      /** `he` 只在裡面用（認圓弧帶裡面的面 `arcFaces`），⛔ 進輸出 */
      out.push({ a, b, angle: d * DEG, band: null, smooth: !!he.smooth, he });
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

/**
 * 連在一起（共用一個面）的平滑折線收成一段；**互相不平行**的才算圓錐面（`radial`），平行的留給 `bandsInGroup()`。
 * 只有一條的⛔ 成帶（理由同 `smoothBands()`：一格的圓弧跟倒角分不出來）。
 * ⚠ 會設 `f.band`；回傳的帶跟 `smoothBands()` 同一種格式（`isArc`、`isCurve`、`segs` ＝ 幾條折線）＋ `radial: true`。
 */
function coneBands(folds) {
  const sm = folds.filter(f => f.smooth && f.he && f.he.face && f.he.twin && f.he.twin.face);
  if (sm.length < 2) return [];
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const add = x => { if (!parent.has(x)) parent.set(x, x); };
  for (const f of sm) {
    const a = f.he.face.id, b = f.he.twin.face.id;
    add(a); add(b);
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const groups = new Map();
  for (const f of sm) {
    const k = find(f.he.face.id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const out = [];
  const cosTol = Math.cos(1 / DEG);                       // 跟 `groupByDirection()` 同一個 1°
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const dir = f => { const dx = f.b.x - f.a.x, dy = f.b.y - f.a.y, L = Math.hypot(dx, dy) || 1; return { x: dx / L, y: dy / L }; };
    const d0 = dir(g[0]);
    if (g.every(f => { const d = dir(f); return Math.abs(d.x * d0.x + d.y * d0.y) >= cosTol; })) continue;   // 平行 ⇒ 照舊
    let ang = 0;
    for (const f of g) ang += f.angle;
    const band = {
      isArc: true, isCurve: true, radial: true,
      chordW: 0, arcW: 0, angle: ang, r: 0, segs: g.length,
      approx: false, flange: undefined,
      lines: g.map(f => ({ folds: [f] }))
    };
    for (const f of g) f.band = band;
    out.push(band);
  }
  return out;
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
function traceLoops(mesh, faces, inPatch, pt2, isCut, isAuto = () => false, isDart = () => false) {
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
    /**
     * 第 i 點出發的那一段是哪一種線（跟 loop 一一對應）：
     * `'cut'` 一般切割線／`'auto'` 程式自己加的（2026-10-12）／`'dart'` 省道打版的開口（2026-10-12）。
     * `vids[i]` ＝ 第 i 點是哪個頂點（「只畫縫線」認 V 的口子用）。
     */
    const kind = [], vids = [];
    let he = start, guard = 0;

    do {
      used.add(he);
      const p = pt2.get(he.id);
      if (p) { loop.push(p); kind.push(isAuto(he) ? 'auto' : isDart(he) ? 'dart' : 'cut'); vids.push(he.v.id); }

      let c = he.next, spin = 0;
      while (c && !isBorder(c) && spin++ < 1e5) {
        if (!c.twin) break;
        c = c.twin.next;
      }
      if (!c || !isBorder(c)) break;
      he = c;
    } while (he !== start && guard++ < 1e6);

    if (loop.length >= 3) loops.push(dropCollinear(loop, kind, vids));
  }

  // 面積最大的當外輪廓，其餘是孔
  loops.sort((a, b) => Math.abs(signedArea(b.pts)) - Math.abs(signedArea(a.pts)));
  return loops;
}

/**
 * 去掉直線中間的多餘點。
 * 攤平後的輪廓上會留下一堆三角化／分段的殘留點，
 * 標尺寸與出 DXF 之前一定要清掉，否則一條邊會變成十幾條線。
 *
 * ⚠ `kind[i]` ＝ 第 i 點出發那一段是哪一種線（2026-10-12：一般／程式加的／開口）。
 * **兩側是不同種的線就⛔ 不併** —— 併了之後那一段只能有一種顏色，橘色就會吃掉黑色（或反過來）。
 *
 * @returns {{pts: object[], kind: string[], auto: boolean[], dart: boolean[], vids: number[]}}
 */
function dropCollinear(loop, kind = loop.map(() => 'cut'), vids = loop.map(() => -1), tolDeg = 0.1) {
  const pack = (pts, k, v) => ({ pts, kind: k, vids: v, auto: k.map(x => x === 'auto'), dart: k.map(x => x === 'dart') });
  if (loop.length < 3) return pack(loop.slice(), kind.slice(), vids.slice());
  const cosTol = Math.cos((180 - tolDeg) / DEG);
  const out = [], outK = [], outV = [];

  for (let i = 0; i < loop.length; i++) {
    const a = loop[(i - 1 + loop.length) % loop.length];
    const c = loop[i];
    const b = loop[(i + 1) % loop.length];
    const ax = a.x - c.x, ay = a.y - c.y;
    const bx = b.x - c.x, by = b.y - c.y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la < 1e-9 || lb < 1e-9) continue;
    const sameKind = kind[(i - 1 + loop.length) % loop.length] === kind[i];
    if (sameKind && (ax * bx + ay * by) / (la * lb) <= cosTol) continue;
    out.push(c); outK.push(kind[i]); outV.push(vids[i]);
  }
  return out.length >= 3 ? pack(out, outK, outV) : pack(loop.slice(), kind.slice(), vids.slice());
}

/**
 * 程式自己加的切線有幾**條**（⛔ 不是幾段邊）。
 *
 * 一條 ＝ 連在一起的一串邊，在「分岔」或「端點」斷開：
 * 只算程式加的那些邊，每個頂點接幾條（度數）；度數 ≠ 2 的點是斷點。
 * 條數 ＝（所有斷點的度數加總）÷ 2 ＋ 沒有任何斷點的整圈。
 * 〔kang 2026-10-12 同意「數的是一條線，不是每一小段」〕
 */
function autoCutLines(mesh, faces, isAuto) {
  const deg = new Map();
  const par = new Map();
  const find = v => { while (par.get(v) !== v) { par.set(v, par.get(par.get(v))); v = par.get(v); } return v; };
  const seen = new Set();
  for (const f of faces) {
    for (const he of mesh.faceLoop(f)) {
      if (!isAuto(he) || seen.has(he.id)) continue;
      seen.add(he.id); if (he.twin) seen.add(he.twin.id);
      for (const v of [he.v.id, he.to.id]) {
        deg.set(v, (deg.get(v) || 0) + 1);
        if (!par.has(v)) par.set(v, v);
      }
      const r1 = find(he.v.id), r2 = find(he.to.id);
      if (r1 !== r2) par.set(r1, r2);
    }
  }
  let ends = 0;
  const brokenComp = new Set();
  for (const [v, d] of deg) if (d !== 2) { ends += d; brokenComp.add(find(v)); }
  const comps = new Set([...deg.keys()].map(find));
  let loops = 0;
  for (const c of comps) if (!brokenComp.has(c)) loops++;
  return ends / 2 + loops;
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
    // ⚠ 非凸的面用扇形切會多算面積，而這個數字會變成備料表上的數字
    for (const [x, y, z] of mesh.faceTriangles(f)) {
      const ab = new THREE.Vector3().subVectors(y.p, x.p);
      const ac = new THREE.Vector3().subVectors(z.p, x.p);
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
 * ── 🔴 記下是哪幾對面疊在一起（2026-10-21，`分片成群-設計方向.md` 第 5 節第一件，kang「同意你的建議」）──
 * 以前找到第一對就停 ⇒ 畫面只能說「這片有重疊」、不知道疊在哪（T10 獅子頭卡在這裡）。
 * 現在照樣掃完、把配對收進 `pairs`（`[i, j]` ＝ `polys` 的索引，也就是這一片 `faces` 的索引）；
 * 收到 `OVERLAP_MAX_PAIRS` 對就停（夠標出位置了，⛔ 為了數完拖慢）、`more` 講還有沒有。
 *
 * ── 🔴 凹的面改用精確判法 ──
 * 分離軸測試只對凸多邊形準；凍結成網格後同一平面併成的面可以是凹的 ⇒ 會把「沒疊」說成「疊」
 * （獅子頭 128 個面裡凹的 20 個，攤成一片時 2 對是這樣誤判的 —— 2026-10-21 沙箱）。
 * ⭐ 兩個都是凸的 ⇒ 照舊用分離軸（結果一個字都不變）；有一個凹的 ⇒ 看邊有沒有真的交叉、或一塊的內部點落在另一塊裡（`exactHit()`）。
 *
 * @returns {{hit: boolean, checked: boolean, pairs: number[][], more: boolean}}
 */
/** 一片超過這麼多個面 ⇒ ⛔ 查重疊（太慢）；智慧分切的「每一片最多幾個面」預設也用它（`propose.js`，2026-10-21）*/
export const OVERLAP_MAX_POLYS = 3000;
const OVERLAP_MAX_PAIRS = 500;

function detectOverlap(polys, opt = {}) {
  if (polys.length < 2) return { hit: false, checked: true, pairs: [], more: false };
  const side = opt.side || null;               // 試算模式：只查兩邊之間（`buildPiece()`）
  if (polys.length > OVERLAP_MAX_POLYS) return { hit: false, checked: false, pairs: [], more: false };

  const boxes = polys.map(bbox);
  const cvx = polys.map(isConvex);
  const pairs = [];
  /**
   * 只查兩邊之間時：直接拿 0 邊的面配 1 邊的面（⛔ 每兩個都繞一遍再跳過），
   * 0 邊的面先跟 1 邊整組的範圍框比，碰不到的整個跳過 —— 少的只是「一定碰不到」的組合，結果一樣。
   */
  if (side) {
    const L = [], R = [];
    polys.forEach((_, i) => (side[i] ? R : L).push(i));
    const all = R.reduce((b, j) => ({ minX: Math.min(b.minX, boxes[j].minX), minY: Math.min(b.minY, boxes[j].minY), maxX: Math.max(b.maxX, boxes[j].maxX), maxY: Math.max(b.maxY, boxes[j].maxY) }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    for (const i of L) {
      if (!boxHit(boxes[i], all)) continue;
      for (const j of R) {
        if (!boxHit(boxes[i], boxes[j])) continue;
        if (sharesEdge(polys[i], polys[j])) continue;
        const hit = cvx[i] && cvx[j] ? polyHit(polys[i], polys[j]) : exactHit(polys[i], polys[j]);
        if (!hit) continue;
        pairs.push(i < j ? [i, j] : [j, i]);
        return { hit: true, checked: true, pairs, more: true };
      }
    }
    return { hit: false, checked: true, pairs, more: false };
  }
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      if (!boxHit(boxes[i], boxes[j])) continue;
      if (sharesEdge(polys[i], polys[j])) continue;
      const hit = cvx[i] && cvx[j] ? polyHit(polys[i], polys[j]) : exactHit(polys[i], polys[j]);
      if (!hit) continue;
      if (pairs.length >= OVERLAP_MAX_PAIRS) return { hit: true, checked: true, pairs, more: true };
      pairs.push([i, j]);
      if (opt.first) return { hit: true, checked: true, pairs, more: true };
    }
  }
  return { hit: pairs.length > 0, checked: true, pairs, more: false };
}

/** 凸不凸：沿著走一圈，轉的方向都一樣（共線的角不算）*/
function isConvex(P) {
  let s = 0;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], c = P[(i + 2) % P.length];
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) < 1e-12) continue;
    if (s && Math.sign(z) !== s) return false;
    s = Math.sign(z);
  }
  return true;
}

/**
 * 精確判法（任意簡單多邊形）：兩條邊在端點以外真的交叉 ⇒ 疊；沒有交叉時，一塊的內部點落在另一塊裡 ⇒ 疊（整塊包在裡面）。
 * ⚠ 只碰到邊、只碰到角 ⛔ 算（跟 `polyHit()` 的 1e-6 容許值同一個意思）。
 */
function exactHit(A, B) {
  for (let i = 0; i < A.length; i++) {
    for (let j = 0; j < B.length; j++) {
      if (segCross(A[i], A[(i + 1) % A.length], B[j], B[(j + 1) % B.length])) return true;
    }
  }
  const a = interiorPoint(A), b = interiorPoint(B);
  return !!((a && pointIn(a, B)) || (b && pointIn(b, A)));
}

const orient2 = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
function segCross(p, q, r, s) {
  const e = 1e-9;
  const d1 = orient2(p, q, r), d2 = orient2(p, q, s), d3 = orient2(r, s, p), d4 = orient2(r, s, q);
  return ((d1 > e && d2 < -e) || (d1 < -e && d2 > e)) && ((d3 > e && d4 < -e) || (d3 < -e && d4 > e));
}
function pointIn(pt, P) {
  let c = false;
  for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
    const a = P[i], b = P[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
/** 一個確定在內部的點：每個角往角平分方向挪一點點，第一個落在裡面的就是（面積幾乎是 0 的碎面可能找不到 ⇒ null）*/
function interiorPoint(P) {
  for (let i = 0; i < P.length; i++) {
    const a = P[(i + P.length - 1) % P.length], b = P[i], c = P[(i + 1) % P.length];
    const m = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
    const t = { x: b.x + (m.x - b.x) * 0.01, y: b.y + (m.y - b.y) * 0.01 };
    if (pointIn(t, P)) return t;
  }
  return null;
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

// 智慧分切的快的接法（propose.js）共用重疊判法
export { polyHit as _polyHit, exactHit as _exactHit, isConvex as _isConvex, sharesEdge as _sharesEdge, boxHit as _boxHit, OVERLAP_MAX_POLYS as _OVMAX };
