/**
 * flatten.js — 展開的幾何核心
 *
 * **這個檔案完全不知道材料是什麼。** 折不折得起來、補償多少、
 * 要留多少餘量，全部由外面傳進來的 rule 物件回答（見 rules.js）。
 * 這裡只做純幾何：分片 → 攤平 → 圓弧修正 → 重疊偵測。
 *
 * ═══ 這裡最重要的一件事：弦長不等於弧長 ═══════════════
 *
 * 圓弧在網格上被切成 arcSeg 段直線。把這些直線一段一段攤開，
 * 得到的是**弦長總和**，永遠比真正的弧長短：
 *
 *     弦長 = m × 2r·sin(Θ/2m)     弧長 = r × Θ
 *
 * arcSeg=4、90 度彎差 0.6%，折三道就差到零點幾公分。
 * 雷切下去才發現就來不及了（日誌「踩過的坑」第 6 條）。
 *
 * 所以攤平之後一定要做**圓弧修正**：辨識出哪幾條折線其實
 * 同屬一段圓弧，把那一段拉長到真正的弧長。
 *
 * 修正後的結果必須跟 prim.js 的 bendDevelopedLength() 完全一致 ——
 * 那是展開長度的權威來源，測試裡有一項專門交叉對答案。
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

  for (const patch of patches) {
    const r = flattenPatch(mesh, patch, rule, tolDeg);
    if (r.piece) pieces.push(r.piece);
    else if (r.error && !warnings.includes(r.error)) warnings.push(r.error);
  }

  // 完全一樣的片合併成「一張圖 ×N」—— 12 片一樣的側板要出一張圖，
  // 不是 12 張一樣的圖。這跟說明表的「套數」是同一個概念。
  const merged = groupIdentical(pieces);

  for (const p of merged) {
    for (const w of rule.validate(p)) p.warnings.push(w);
  }

  const arcs = merged.reduce((n, p) => n + p.bends.filter(b => b.isArc).length, 0);
  const sharp = merged.reduce((n, p) => n + p.bends.filter(b => !b.isArc).length, 0);

  if (!rule.foldable) {
    warnings.push(`${rule.label}折不了，所有折線已改成切割線，各片分開下料`);
  }
  for (const p of merged) {
    if (p.overlap) warnings.push(`「${p.name}」攤平後有重疊，需要切分（第 7 期會做自動分片）`);
    if (p.nonDevelopable) warnings.push(`「${p.name}」含攤不平的曲面，這一片的尺寸只是近似值`);
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
function flattenPatch(mesh, faces, rule, tolDeg) {
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

  // ── 廣度優先攤開其餘的面 ──
  /** 真正用來攤平的那些邊（生成樹）。沒被用到的內部邊就是隱含切割線。 */
  const tree = new Set();
  const queue = [seed];

  while (queue.length) {
    const f = queue.shift();
    for (const he of mesh.faceLoop(f)) {
      const th = he.twin;
      if (!th || !th.face || !inPatch.has(th.face.id)) continue;
      if (placed.has(th.face.id)) continue;
      if (edgeIsCut(mesh, he, rule, tolDeg)) continue;

      // 共用邊：he 從 a 走到 b，孿生的 th 從 b 走到 a
      const A2 = pt2.get(he.id);
      const B2 = pt2.get(he.next.id);
      if (!A2 || !B2) continue;

      placeFace(mesh, th, B2, A2, pt2);
      placed.add(th.face.id);
      tree.add(he.id); tree.add(th.id);
      queue.push(th.face);
    }
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
    used.length < faces.length ? ['有部分面攤不開，可能是網格結構有問題'] : []);
  return { piece };
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
function buildPiece(mesh, faces, pt2, isCut, rule, warn) {
  const inPatch = new Set(faces.map(f => f.id));

  const folds = collectFolds(mesh, faces, inPatch, pt2, isCut);
  const bands = arcCorrection(pt2, folds, rule);
  orient(pt2, folds, mesh, faces, isCut);

  const loops = traceLoops(mesh, faces, inPatch, pt2, isCut);
  const polys = faces.map(f => mesh.faceLoop(f).map(he => pt2.get(he.id)));

  // 擺正之後才知道折彎帶落在展開圖的哪一段（x 就是展開方向）
  for (const b of bands) {
    let lo = Infinity, hi = -Infinity;
    for (const L of b.lines) {
      for (const f of L.folds) {
        lo = Math.min(lo, f.a.x, f.b.x);
        hi = Math.max(hi, f.a.x, f.b.x);
      }
    }
    b.x0 = Number.isFinite(lo) ? lo : 0;
    b.x1 = Number.isFinite(hi) ? hi : b.x0;
    delete b.lines;                 // 內部用的，不要留在輸出裡
    delete b.s0; delete b.s1;
  }
  bands.sort((a, b) => a.x0 - b.x0);

  let px0 = Infinity, px1 = -Infinity;
  for (const p of pt2.values()) { px0 = Math.min(px0, p.x); px1 = Math.max(px1, p.x); }
  computeFlanges(bands, px0, px1);

  const piece = {
    name: '展開片',
    qty: 1,
    outline: loops[0] || [],
    holes: loops.slice(1),
    folds: folds.map(f => ({ a: f.a, b: f.b, angle: f.angle, isArcEdge: !!f.band })),
    bends: bands,
    faces: polys,
    warnings: warn.slice(),
    overlap: detectOverlap(polys),
    nonDevelopable: false,
    area: 0, width: 0, height: 0
  };

  measure(piece, mesh, faces);
  return piece;
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
      out.push({ a, b, angle: d * DEG, band: null });
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════
//  四、圓弧修正 —— 這一節是整個第 3 期的關鍵
// ═══════════════════════════════════════════════════════

/**
 * 把攤平後的弦長改成真正的弧長。
 *
 * ── 怎麼認出「這幾條折線其實是同一段圓弧」──────────
 * 一段圓弧被切成 m 段之後，在網格上留下的痕跡很好認：
 *   · 每一段的寬度完全相同（弦長都是 2r·sin(δ/2)）
 *   · 中間每一條折線的轉折角完全相同（都是 δ）
 *   · 頭尾兩條各轉 δ/2（弦跟切線差半個角）
 * 只要抓到「等寬 ＋ 等角」的連續段，就是一段圓弧。
 *
 * ── 修正量 ──────────────────────────────────────────
 *   弦長總和 = m × 2r·sin(Θ/2m)        Θ = 總轉角
 *   真正弧長 = r × Θ
 *   拉伸倍率 = Θ / (2m·sin(Θ/2m))
 * 所有在這一段之後的東西，整個往外平移對應的差額。
 *
 * ── 為什麼可以只沿一個方向拉 ────────────────────────
 * 同一段圓弧的折線彼此平行，展開後也還是平行。
 * 沿著垂直於折線的方向做一維拉伸，折線本身不動、
 * 平行於折線的尺寸也不動 —— 這正是「捲起來的紙攤開」在做的事。
 */
function arcCorrection(pt2, folds, rule) {
  if (!folds.length) return [];

  const groups = groupByDirection(folds);
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

    const found = bandsInGroup(g, rule, lo, hi);
    if (found.some(b => b.isArc)) arcGroups++;
    applyStretch(pt2, g.dir, found);
    for (const b of found) bands.push(b);
  }

  if (arcGroups > 1) {
    // 兩個方向同時有圓弧＝複合折彎（例如四角都倒圓的托盤）。
    // 兩次一維拉伸疊起來只在正交時才準，這裡先做並如實告知。
    for (const b of bands) b.approx = true;
  }
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
function bandsInGroup(g, rule, sMin, sMax) {
  const px = -g.dir.y, py = g.dir.x;           // 垂直於折線的方向

  // ── 合併成折線 ──
  const lines = [];
  for (const f of g.folds) {
    const s = ((f.a.x + f.b.x) / 2) * px + ((f.a.y + f.b.y) / 2) * py;
    let L = lines.find(q => Math.abs(q.s - s) <= 1e-6 + 1e-6 * Math.abs(s));
    if (!L) { L = { s, angle: 0, n: 0, folds: [] }; lines.push(L); }
    L.angle += f.angle; L.n++; L.folds.push(f);
  }
  for (const L of lines) L.angle /= L.n;
  lines.sort((a, b) => a.s - b.s);

  if (lines.length < 2) return lines.map(sharpBand);

  const gaps = [];
  for (let i = 0; i + 1 < lines.length; i++) gaps.push(lines[i + 1].s - lines[i].s);

  // ── 掃描：找「等寬 ＋ 中間等角 ＋ 同方向」的連續段 ──
  const used = new Set();
  const bands = [];
  let i = 0;

  while (i < gaps.length) {
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
        if (near(Math.abs(lines[i].angle), dAvg) && near(s0 - sMin, chord)) {
          s0 = sMin; mm++;
        }
        if (near(Math.abs(lines[j + 1].angle), dAvg) && near(sMax - s1, chord)) {
          s1 = sMax; mm++;
        }
        const totalAll = dAvg * mm;
        const arcW = r * totalAll / DEG;

        const band = {
          isArc: true,
          s0, s1,
          chordW: mm * chord, arcW,
          angle: totalAll * Math.sign(lines[i + 1].angle),
          r,                                   // 中性層半徑（網格本身就是中性面）
          ri: Math.max(0, r - rule.k * rule.thickness),
          segs: mm,
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

function sharpBand(L) {
  return {
    isArc: false, s0: L.s, s1: L.s, chordW: 0, arcW: 0,
    angle: L.angle, r: 0, ri: 0, segs: 0, approx: false, flange: undefined,
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
 * 沿垂直於折線的方向做一維拉伸，把弦長換成弧長。
 * 拉伸是分段線性的：圓弧帶內部按比例拉開，帶以外整段平移。
 */
function applyStretch(pt2, dir, bands) {
  const arcs = bands.filter(b => b.isArc && b.chordW > 1e-12);
  if (!arcs.length) return;

  arcs.sort((a, b) => a.s0 - b.s0);
  const px = -dir.y, py = dir.x;

  const map = s => {
    let out = s;
    for (const b of arcs) {
      if (s <= b.s0 + 1e-12) break;
      if (s >= b.s1 - 1e-12) out += (b.arcW - b.chordW);
      else out += (s - b.s0) * (b.arcW / b.chordW - 1);
    }
    return out;
  };

  for (const p of pt2.values()) {
    const s = p.x * px + p.y * py;
    const ds = map(s) - s;
    if (Math.abs(ds) < 1e-15) continue;
    p.x += px * ds;
    p.y += py * ds;
  }

  // 折彎帶自己的 s 座標也要更新。
  // 一定要**先把尖角折的新位置全部算完**再改圓弧帶的座標 ——
  // map() 讀的就是 arcs 的 s0/s1，邊改邊用會拿到改到一半的值。
  const sharpNew = bands.filter(b => !b.isArc).map(b => map(b.s0));

  let shift = 0;
  for (const b of arcs) {
    b.s0 += shift;
    shift += (b.arcW - b.chordW);
    b.s1 = b.s0 + b.arcW;
  }
  bands.filter(b => !b.isArc).forEach((b, i) => { b.s0 = sharpNew[i]; b.s1 = sharpNew[i]; });
}

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
 * 有重疊就代表這一片沒辦法用一整張料做出來，必須切分。
 * v1 只負責**偵測與告知**，自動分片排在第 7 期（那是整個展開
 * 引擎最重的一塊，而且一定要搭配手動調整切線，不能強迫接受）。
 *
 * 面數多的時候先用外接框篩掉九成以上的配對，再做分離軸測試。
 */
function detectOverlap(polys) {
  if (polys.length < 2 || polys.length > 3000) return false;

  const boxes = polys.map(bbox);
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      if (!boxHit(boxes[i], boxes[j])) continue;
      if (sharesEdge(polys[i], polys[j])) continue;
      if (polyHit(polys[i], polys[j])) return true;
    }
  }
  return false;
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
function groupIdentical(pieces) {
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
