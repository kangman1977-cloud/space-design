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
 */
export function faceFrame(obj, face, mesh = null) {
  const m = mesh || obj.mesh();
  m.computeNormals();
  const M = obj.matrix();

  const vs = m.faceVerts(face);
  const c = new THREE.Vector3();
  for (const v of vs) c.add(v.p);
  c.divideScalar(vs.length || 1).applyMatrix4(M);

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
 *   2. 沿著 `nB` 推，讓兩個面共平面
 *
 * 為什麼是「正對」而不是「同向」：兩個面要貼在一起的話，它們的
 * 外法線必定指向相反方向 —— 就像兩本書合起來，封面各自朝外。
 * 轉成同向的話兩個物件會疊在一起。
 *
 * @returns {{pos, rot, ambiguous, moved}}
 */
export function mateFaceToFace(src, srcFrame, dstFrame) {
  const want = dstFrame.dir.clone().negate();
  const { q, ambiguous } = rotationBetween(srcFrame.dir, want);

  const r = rotateAbout(src.pos, src.rot, q, srcFrame.point);

  // 轉完之後那個面的中心也跟著轉了，要重新算才知道還差多遠
  const cAfter = srcFrame.point.clone();          // 繞它自己轉，所以不動
  const n = dstFrame.dir;
  const gap = dstFrame.point.clone().sub(cAfter).dot(n);
  r.pos.addScaledVector(n, gap);

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
