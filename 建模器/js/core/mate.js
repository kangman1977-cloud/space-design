/**
 * mate.js — 貼合
 *
 * kang 的原話（2026-08-22）：「希望能夠有一個機制，是類似『貼合』或是
 * 『相吸』，也就是一個物件的點線面可以貼合到另一個物件的點線面。」
 *
 * ── 跟現有的「吸附」不是同一件事 ──────────────────────
 * 工具列那個吸附是吸到 1／5／10cm 的**網格**。
 * 這裡是吸到**另一個物件的幾何**。兩個各有用處，互不干擾。
 *
 * ── 兩個已定案的決定（kang 2026-08-22）──────────────
 *
 * **一、含旋轉。**
 * 只平移的話，兩個角度不同的物件推到底也只會碰到一個角，不會貼平。
 * 而「組裝造型」要的就是貼平，所以貼合一定要連角度一起轉。
 *
 * **二、選兩個元素再按一下，不是拖曳時磁吸。**
 * 精確、結果可預測，而且點選面／邊的地基在分片模式已經驗過了
 * （`seam.js` 的 nearestFace / nearestMarkableEdge）。
 * 磁吸手感好，但會跟三軸 gizmo 打架，難度高很多。
 *
 * ── 先點的動，後點的不動 ────────────────────────────
 * 「把**這個**貼到**那個**」。這是唯一不用解釋就猜得到的規則。
 *
 * ── 面內位置不動 ────────────────────────────────────
 * 貼合只負責「貼平」：轉到兩面正對，再沿法線推到共平面。
 * **不會把兩個面的中心對在一起** —— 那會讓東西突然飛到模型另一頭，
 * 而使用者只是想讓它貼上去。要再對到特定位置就用對齊（align.js）。
 *
 * 這個檔案不改動任何東西，只回傳算出來的新 pos / rot，
 * 由呼叫端決定要不要套用 —— 所以測得到。
 *
 * 單位一律 cm。
 */

import * as THREE from 'three';
import { elementCenter } from './edit.js';

/** 貼合的對象種類 */
export const MATE = { FACE: 'face', EDGE: 'edge', VERTEX: 'vertex' };

// ═══════════════════════════════════════════════════════
//  取出元素在世界座標裡的幾何
// ═══════════════════════════════════════════════════════

/**
 * 一個面在世界座標的中心與法線。
 *
 * 法線要用**法線矩陣**轉，不能直接套物件的變換矩陣 ——
 * 非等比縮放時法線會歪掉（拉長的方向法線要反方向壓縮）。
 * 這種錯畫面上看起來只是「貼歪了一點」，很難查。
 *
 * ── 🔴🔴 `point` 是【共面區域】的中心，⛔ 不是那個三角形的重心 ──
 *
 * **方塊在網格裡是 12 個三角形，⛔ 不是 6 個面**（`io.js` 檔頭那則講的
 * 同一件事）。而使用者點的是「一個面」，⛔ 不是他看不見的那條對角線的一邊。
 *
 * ⚠ **舊版直接對 `faceVerts(face)` 取平均，那是【碰巧不出事】**：
 * 【沙箱實測】方塊 60×45×40 的 +X 面，舊版給 **(30, 7.5, 6.667)**，
 * 而那個面的中心是 **(30, 0, 0)**。舊的「只貼平不定位」只取**法線方向**
 * 的分量，那個偏移剛好整個落在面內 ⇒ **被丟掉了，所以從來沒人發現**。
 * 🔴 一改成「中心對中心」，它就**直接變成貼歪的量**，
 * 而且歪多少**取決於點到哪一個三角形** —— ⛔ 使用者看不到那條對角線。
 *
 * ⭐ **`elementCenter()` 是這個專案「一個面的中心」的唯一定義** ——
 * 編輯模式 gizmo 掛的位置、`標尺寸` 報的重心，用的都是它。
 * ⇒ 三個地方講的中心是**同一個點**〔鐵律三：讓數字互相對得起來〕。
 * ⛔ 不要在這裡自己再算一份。
 */
export function faceFrame(obj, face, mesh = null) {
  const m = mesh || obj.mesh();
  m.computeNormals();
  const M = obj.matrix();

  const c = elementCenter(m, { kind: 'face', face }).applyMatrix4(M);

  const nm = new THREE.Matrix3().getNormalMatrix(M);
  const n = face.normal.clone().applyMatrix3(nm).normalize();

  return { point: c, dir: n };
}

/**
 * 一條邊在世界座標的中點與方向，**外加它旁邊那個面的法線**。
 *
 * 那個法線是邊對邊貼合的關鍵 —— 沒有它，物件還能繞著邊自轉，
 * 結果就不唯一（見 mateEdgeToEdge 的說明）。
 *
 * 邊界半邊沒有面（`he.face` 是 null，板件的外輪廓就是這種），
 * 這時改用孿生那一側的面。兩邊都沒有的話就只能不給，
 * 呼叫端會退回「只對齊邊」並把結果標成 ambiguous。
 */
export function edgeFrame(obj, he) {
  const M = obj.matrix();
  const a = he.v.p.clone().applyMatrix4(M);
  const b = he.to.p.clone().applyMatrix4(M);

  const face = he.face || (he.twin && he.twin.face) || null;
  let faceDir = null;
  if (face) {
    const m = obj.mesh();
    m.computeNormals();
    faceDir = face.normal.clone()
      .applyMatrix3(new THREE.Matrix3().getNormalMatrix(M)).normalize();
  }

  return {
    point: a.clone().add(b).multiplyScalar(0.5),
    dir: b.clone().sub(a).normalize(),
    faceDir, a, b
  };
}

/** 一個頂點在世界座標的位置 */
export function vertexPoint(obj, vert) {
  return vert.p.clone().applyMatrix4(obj.matrix());
}

// ═══════════════════════════════════════════════════════
//  旋轉
// ═══════════════════════════════════════════════════════

/**
 * 把向量 from 轉到 to 的最短旋轉。
 *
 * ⚠ **完全反向（180 度）時軸是不唯一的**，`setFromUnitVectors` 會自己
 * 挑一個垂直軸，結果雖然正確但方位無法預測。這是數學上的事實，
 * 不是函式庫的缺陷 —— 繞著任何一條垂直軸轉 180 度都能把 from 轉到 to。
 *
 * 所以這裡不自作聰明去「修正」它，只是把情況標出來，
 * 讓呼叫端可以提醒使用者「轉出來的方位可能不是你想的那個，
 * 不滿意就自己再轉」。硬挑一個軸假裝很聰明，只會讓行為更難預測。
 */
export function rotationBetween(from, to) {
  const a = from.clone().normalize();
  const b = to.clone().normalize();
  const dot = a.dot(b);
  const q = new THREE.Quaternion().setFromUnitVectors(a, b);
  return { q, ambiguous: dot < -0.999999 };
}

/**
 * 這次貼合到底有沒有動到東西。
 *
 * ⚠ **不能拿四元數跟單位四元數做 `equals()`** —— 那是精確比對，
 * 而「已經貼好了」算出來的旋轉是 (0, 0, 0, 0.9999999999)，
 * 永遠不等於單位四元數。於是每次都回報「動了」，
 * 使用者按第二下會看到「已貼合」變成「移動了 1 個物件」，
 * 然後開始懷疑它到底有沒有真的貼上去。
 *
 * 改成看**轉了幾度**：`angle = 2·acos(|w|)`，單位四元數是 0 度。
 */
function didMove(q, from, to) {
  const deg = 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI;
  return to.distanceTo(from) > 1e-9 || deg > 1e-6;
}

/**
 * 讓物件繞著世界座標的某個點旋轉。
 *
 * 繞著**選到的那個元素**轉，不是繞物件原點 —— 否則按下去物件會先
 * 甩到一邊再貼回來，中間那一下看起來像出錯了。
 */
function rotateAbout(pos, rot, q, pivot) {
  const quat = new THREE.Quaternion().setFromEuler(rot);
  const newQuat = q.clone().multiply(quat);

  const offset = pos.clone().sub(pivot).applyQuaternion(q);
  const newPos = pivot.clone().add(offset);

  return { pos: newPos, rot: new THREE.Euler().setFromQuaternion(newQuat, rot.order) };
}

// ═══════════════════════════════════════════════════════
//  貼合
// ═══════════════════════════════════════════════════════

/**
 * 面貼面。
 *
 * 兩步：
 *   1. 轉到**兩面法線正對**（`nA` 轉成 `−nB`），繞著 A 那個面的中心轉
 *   2. **把兩個面的中心疊在一起**
 *
 * 為什麼是「正對」而不是「同向」：兩個面要貼在一起的話，它們的
 * 外法線必定指向相反方向 —— 就像兩本書合起來，封面各自朝外。
 * 轉成同向的話兩個物件會疊在一起。
 *
 * ── 🔴 中心對中心（kang 2026-09-01 拍板，⛔ 覆蓋舊定案）────────
 *
 * ⚠ **舊版⛔ 只推法線方向那一段，面內的兩個自由度刻意不動**，
 * 理由寫在規格檔：「中心對中心？角對角？每一種都是猜的 ——
 * 與其猜一個，不如不動」⇒ 定案是「貼合負責貼平，對齊負責定位」，**兩步**。
 *
 * 🔴 **kang 用下來的結論是那兩步太麻煩**，拍板改成一步。
 * 他對「只貼平不定位」要不要留成開關的回答：「**先改掉，用不慣再說**」。
 *
 * ⭐ **改完之後三種貼合的規則一致了**：點對點、邊對邊（中點對中點）、
 * 面對面（中心對中心）—— 都是「**你選的那兩個東西的代表點重合**」。
 * ⚠ 而位移也因此**跟 `mateEdgeToEdge` 的最後一步同一個形式**，
 * ⛔ 不再是「取法線分量」那種只有這裡才有的寫法。
 *
 * @returns {{pos, rot, ambiguous, moved}}
 */
export function mateFaceToFace(src, srcFrame, dstFrame) {
  const want = dstFrame.dir.clone().negate();
  const { q, ambiguous } = rotationBetween(srcFrame.dir, want);

  const r = rotateAbout(src.pos, src.rot, q, srcFrame.point);

  /**
   * 繞著 A 那個面的中心轉，所以轉完之後**它自己沒有動** ——
   * 直接把它搬到目標面的中心即可。這一步同時吃掉法線方向的距離
   * 與面內的那兩個自由度。
   */
  r.pos.add(dstFrame.point.clone().sub(srcFrame.point));

  return {
    pos: r.pos, rot: r.rot, ambiguous,
    moved: didMove(q, src.pos, r.pos)
  };
}

/**
 * 邊貼邊。
 *
 * ── 為什麼不能只對齊邊 ────────────────────────────────
 * 只讓兩條邊重合的話，物件還能**繞著那條邊自轉任意角度** ——
 * 兩條邊仍然完全重合，但成品的方位是隨機的。
 * kang 2026-08-22 實測回報「邊對邊沒辦法驗證準確」，原因就是這個：
 * 程式挑的是「轉最少」的那個角度，不是任何人想要的那個角度。
 *
 * ⚠ **自由度沒鎖滿的功能，使用者無法判斷它有沒有做對。**
 * 那比做錯更糟 —— 做錯還能發現，隨機只會讓人不敢用。
 *
 * ── 多鎖的那一個：相鄰的面也要貼平 ────────────────────
 * 一條邊旁邊就有一個面（`he.face`）。把來源那個面轉到跟目標那個面
 * **法線反向**，自轉那一圈就被鎖死了，結果唯一。
 *
 * 為什麼是反向不是同向：跟面對面同一條道理 —— 兩個要貼在一起的面，
 * 外法線必定指向相反方向。轉成同向的話兩個物件會疊在一起
 * （實際推導過：同向會讓兩個物件佔住同一塊空間）。
 *
 * ── 所以邊對邊 ＝ 面對面 ＋ 位置也被釘死 ──────────────
 * 面對面留著「面內滑動」的自由；邊對邊再把那個滑動也定下來。
 *
 * @param {THREE.Vector3} srcFrame.faceDir 來源邊相鄰面的法線（世界座標）
 * @param {THREE.Vector3} dstFrame.faceDir 目標邊相鄰面的法線（世界座標）
 *                        沒給就退回舊行為（只對齊邊），並標成 ambiguous
 */
export function mateEdgeToEdge(src, srcFrame, dstFrame) {
  let want = dstFrame.dir.clone();
  if (srcFrame.dir.dot(want) < 0) want.negate();

  const { q: q1 } = rotationBetween(srcFrame.dir, want);
  let q = q1;
  let ambiguous = true;                 // 沒有面可參考的話，自轉角度確實是任意的

  if (srcFrame.faceDir && dstFrame.faceDir) {
    const axis = want.clone().normalize();

    // 轉完第一步之後，來源相鄰面的法線指向哪裡
    const n1 = srcFrame.faceDir.clone().applyQuaternion(q1);
    const n2 = dstFrame.faceDir.clone().negate();

    /**
     * 兩個法線都必定垂直於邊（面包含那條邊），所以投影到垂直於軸的平面上
     * 理論上不會改變它們。還是投影一次，是為了擋掉浮點誤差累積出來的
     * 微小軸向分量 —— 那會讓算出來的角度偏掉一點點，而「一點點」
     * 在下料圖上就是對不上。
     */
    const proj = v => v.clone().addScaledVector(axis, -v.dot(axis));
    const a = proj(n1), b = proj(n2);

    if (a.lengthSq() > 1e-12 && b.lengthSq() > 1e-12) {
      a.normalize(); b.normalize();
      const cos = Math.max(-1, Math.min(1, a.dot(b)));
      const sign = Math.sign(new THREE.Vector3().crossVectors(a, b).dot(axis)) || 1;
      const ang = Math.acos(cos) * sign;
      const q2 = new THREE.Quaternion().setFromAxisAngle(axis, ang);
      q = q2.multiply(q1);
      ambiguous = false;                // 自轉被鎖死了，結果唯一
    }
  }

  const r = rotateAbout(src.pos, src.rot, q, srcFrame.point);

  // 邊要完全重合，所以中點對中點（跟面不同 —— 面只要共平面）
  r.pos.add(dstFrame.point.clone().sub(srcFrame.point));

  return {
    pos: r.pos, rot: r.rot, ambiguous,
    moved: didMove(q, src.pos, r.pos)
  };
}

/**
 * 點貼點：純平移，不轉。
 *
 * 一個點沒有方向，所以沒有「要轉到哪」這件事。
 * 這是三種裡面唯一不含旋轉的。
 */
export function mateVertexToVertex(src, srcPoint, dstPoint) {
  const pos = src.pos.clone().add(dstPoint.clone().sub(srcPoint));
  return {
    pos, rot: src.rot.clone(), ambiguous: false,
    moved: pos.distanceTo(src.pos) > 1e-9
  };
}

// ═══════════════════════════════════════════════════════
//  同軸（綜合評估 ④-9，2026-10-20，kang「同意你的建議」）
// ═══════════════════════════════════════════════════════

/**
 * 🔴🔴 **從點到的那一個面，找出它所在那一圈曲面的中心線**（軸的外面、孔的內壁都行）。
 *
 * kang 照建議定的三件事：**點圓的側面**（⛔ 點邊緣 —— T9 小東西點下去常常抓到點）；
 * **沿中心線的上下位置⛔ 動**（只往旁邊移、轉正 —— 跟 SolidWorks 的「同心」一樣）；
 * **⛔ 記「這兩個同軸」**（對一次就好，跟齒輪「咬上去」同一個決定）。
 *
 * 做法：
 * ① 從點到的面往旁邊長，相鄰兩個面的夾角小於 `COAX_GROW_DEG` 就算同一圈 ——
 * 　 圓柱的側面一格只轉 11.25°（32 段），碰到蓋子（90°）就停。
 * ② 中心線的方向 ＝ 這一圈每個面的法線兩兩外積（法線都垂直於中心線，外積就平行於它）。
 * ③ 中心線的位置：每個面的法線那條線都穿過中心線（圓柱、圓錐都是）⇒ 在垂直於中心線的平面上
 * 　 求離所有法線線「最近」的那一點（最小平方，2 × 2）。⭐ 孔的法線朝內、軸的朝外，一樣成立。
 * ⚠ 平的面、球面這種⛔ 是一圈繞同一條線的 ⇒ 講原因、⛔ 猜。
 *
 * @returns {{ok:boolean, reason?:string, point?:THREE.Vector3, dir?:THREE.Vector3, radius?:number,
 *           ends?:THREE.Vector3[], count?:number, inward?:boolean}} 世界座標；`point` 在這一圈的中段；
 *           `inward` ＝ 法線朝中心線（＝ 孔的內壁）；⛔ 朝外 ＝ 軸的外面（⑤-28 量孔要分孔與軸）
 */
const COAX_GROW_DEG = 40;
export function cylinderFrame(obj, face, mesh = null) {
  const m = mesh || obj.mesh();
  m.computeNormals();
  if (!face || !face.normal) return { ok: false, reason: '沒點到面' };
  const cosGrow = Math.cos(COAX_GROW_DEG * Math.PI / 180);
  const seen = new Set([face]);
  const list = [face];
  for (let k = 0; k < list.length; k++) {
    const f = list[k];
    for (const he of m.faceLoop(f)) {
      const g = he.twin && he.twin.face;
      if (!g || seen.has(g)) continue;
      if (f.normal.dot(g.normal) < cosGrow) continue;
      seen.add(g);
      list.push(g);
    }
    if (list.length > 20000) break;
  }
  /** 每個面：中心、法線、面積（面積當權重 —— 細長的三角形⛔ 該跟大面一樣重） */
  const items = list.map(f => {
    const vs = m.faceVerts(f).map(v => v.p);
    const c = new THREE.Vector3();
    for (const p of vs) c.add(p);
    c.multiplyScalar(1 / vs.length);
    let area = 0;
    for (let i = 1; i + 1 < vs.length; i++) {
      area += new THREE.Vector3().subVectors(vs[i], vs[0]).cross(new THREE.Vector3().subVectors(vs[i + 1], vs[0])).length() / 2;
    }
    return { c, n: f.normal.clone().normalize(), w: Math.max(area, 1e-12), vs };
  });
  const n0 = items[0].n;
  const axis = new THREE.Vector3();
  let spread = 0;
  for (const it of items) {
    const x = new THREE.Vector3().crossVectors(n0, it.n);
    spread = Math.max(spread, x.length());
    if (x.lengthSq() < 1e-8) continue;
    if (axis.lengthSq() > 0 && x.dot(axis) < 0) x.negate();
    axis.addScaledVector(x, it.w);
  }
  if (spread < Math.sin(15 * Math.PI / 180) || axis.lengthSq() < 1e-16) {
    return { ok: false, reason: '點到的是平的面（或彎得太少）—— 要點圓的側面：軸的外面、孔的內壁' };
  }
  axis.normalize();
  /** 法線要大致垂直於中心線（圓柱 0°；圓錐容許到 30°）—— 球面、自由曲面這裡會被擋下來 */
  for (const it of items) {
    if (Math.abs(it.n.dot(axis)) > 0.5) {
      return { ok: false, reason: '點到的那一圈不是繞同一條中心線的圓（可能是球面、或連到別的面）—— 要點圓柱的側面' };
    }
  }
  const u = new THREE.Vector3(1, 0, 0);
  if (Math.abs(u.dot(axis)) > 0.9) u.set(0, 1, 0);
  u.addScaledVector(axis, -u.dot(axis)).normalize();
  const v = new THREE.Vector3().crossVectors(axis, u);
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0, tSum = 0, wSum = 0;
  for (const it of items) {
    const du = it.n.dot(u), dv = it.n.dot(v);
    const L = Math.hypot(du, dv);
    if (L < 1e-9) continue;
    const ex = du / L, ey = dv / L;
    const cu = it.c.dot(u), cv = it.c.dot(v);
    /** (I − d dᵀ) p ＝ (I − d dᵀ) c */
    const m11 = 1 - ex * ex, m12 = -ex * ey, m22 = 1 - ey * ey;
    a11 += it.w * m11; a12 += it.w * m12; a22 += it.w * m22;
    b1 += it.w * (m11 * cu + m12 * cv); b2 += it.w * (m12 * cu + m22 * cv);
    tSum += it.w * it.c.dot(axis); wSum += it.w;
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 1e-12 * Math.max(1, a11 * a22)) return { ok: false, reason: '算不出中心線（那一圈的面都朝同一個方向）' };
  const pu = (b1 * a22 - b2 * a12) / det, pv = (a11 * b2 - a12 * b1) / det;
  const local = new THREE.Vector3().addScaledVector(u, pu).addScaledVector(v, pv).addScaledVector(axis, tSum / wSum);
  /** 換到世界座標：點照矩陣、方向是「沿著線」的向量（⛔ 法線矩陣） */
  const M = obj.matrix();
  const point = local.clone().applyMatrix4(M);
  const dir = axis.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(M)).normalize();
  /** ⑤-28：法線朝中心線的多 ⇒ 孔（內壁）；朝外的多 ⇒ 軸（物件座標裡比，面積當權重）*/
  let inSide = 0;
  for (const it of items) {
    const r = it.c.clone().sub(local);
    r.addScaledVector(axis, -r.dot(axis));
    inSide += it.w * Math.sign(-it.n.dot(r));
  }
  let rs = 0, rn = 0, tMin = Infinity, tMax = -Infinity;
  for (const it of items) {
    for (const p of it.vs) {
      const w = p.clone().applyMatrix4(M).sub(point);
      const t = w.dot(dir);
      tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
      rs += w.addScaledVector(dir, -t).length(); rn++;
    }
  }
  return {
    ok: true, point, dir, radius: rn ? rs / rn : 0, count: list.length, inward: inSide > 0,
    ends: [point.clone().addScaledVector(dir, tMin), point.clone().addScaledVector(dir, tMax)]
  };
}

/**
 * 🔴 **兩條中心線（兩個孔、或孔與軸）的距離**（綜合評估 ⑤-28 ＋ ④-16 孔心距，2026-10-20，kang「同意你的建議」）。
 * T4：布林挖的孔轉成網格之後一圈選不起來 ⇒ 量不到孔徑、孔心距只好自己算。
 * | 兩條線 | 回答 |
 * |---|---|
 * | 平行（夾角 < 1°）| **孔心距 ＝ 兩條線之間的垂直距離**（沿中心線錯開多少⛔ 算進去，另外講 `along`）|
 * | ⛔ 平行 | 兩個孔心（各自那一圈的中段）的直線距離，另外講夾幾度 |
 * ⚠ 都是世界座標、公分；這支⛔ 改任何東西。
 * @returns {{parallel:boolean, angle:number, dist:number, along:number, from:THREE.Vector3, to:THREE.Vector3}}
 *          `from`／`to` ＝ 畫連線用的兩端（平行時是垂直的那一段）
 */
export function holeDistance(a, b) {
  const cos = Math.min(1, Math.abs(a.dir.dot(b.dir)));
  const angle = Math.acos(cos) * 180 / Math.PI;
  const d = b.point.clone().sub(a.point);
  if (angle < 1) {
    const along = d.dot(a.dir);
    const perp = d.clone().addScaledVector(a.dir, -along);
    return { parallel: true, angle, dist: perp.length(), along: Math.abs(along),
             from: a.point.clone(), to: a.point.clone().add(perp) };
  }
  return { parallel: false, angle, dist: d.length(), along: 0, from: a.point.clone(), to: b.point.clone() };
}

/**
 * 同軸：把 `src` 轉正、往旁邊移，讓它的中心線跟 `dst` 的變成同一條。
 * ⚠ **沿中心線的位置⛔ 動**（只去掉垂直於中心線的那段距離）；轉的時候挑轉最少的那個方向（⛔ 無故翻面）。
 * @returns {{pos, rot, moved:boolean, angle:number, shift:number}} `angle` 轉了幾度、`shift` 旁移了幾 cm
 */
export function mateCoaxial(src, srcFrame, dstFrame) {
  const want = dstFrame.dir.clone();
  if (srcFrame.dir.dot(want) < 0) want.negate();
  const { q } = rotationBetween(srcFrame.dir, want);
  const r = rotateAbout(src.pos, src.rot, q, srcFrame.point);
  const d = dstFrame.point.clone().sub(srcFrame.point);
  d.addScaledVector(want, -d.dot(want));
  r.pos.add(d);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI;
  return { pos: r.pos, rot: r.rot, moved: didMove(q, src.pos, r.pos), angle, shift: d.length() };
}
