/**
 * edit.js — 點／邊／面的幾何編輯（第 6 期第一刀・資料層）
 *
 * 「選到一個元素之後，能不能改變它。」——`編輯功能設計方向.md` 第 4 節把
 * 擠出面、拉點、導圓角三件事收斂成這一句。**選那一半早就做好了**
 * （`unfold/seam.js` 的 nearestVertex / nearestMarkableEdge / nearestFace，
 * 目前被指定分片與貼合共用）。這個檔案補的是「改變」那一半的第一塊。
 *
 * ── 這個檔案做什麼、不做什麼 ──────────────────────────
 * **做**：移動既有的頂點（拉點／拉邊／拉面），以及改完之後的連帶重算。
 * **不做**：任何改變拓撲的事 —— 不新增頂點、不新增面、不刪除、不分裂。
 *
 * 這條界線不是偷懶，是刻意的第一刀：`mesh.js` 目前**完全沒有**改拓撲的
 * API（32 個方法全是讀、標記、整體變換、建構），而擠出面非它不可。
 * 但拉點根本不需要它 —— `Vertex.p` 就是一個 THREE.Vector3，改它就好。
 * 所以先把「改變 → 連帶重算 → 展開還是對的」這條迴路走通，
 * 擠出面（第二刀）再回來長拓撲那一層。
 *
 * ⚠ **拉點做不出鹿角。** 鹿角要從一個面長出新的一段，那是擠出面。
 * 這一刀能做的是「把已經有的形狀捏形狀」。
 *
 * ── 改完之後一定要跑 refreshAfterEdit() ────────────────
 * 幾何一動，有三件事會靜靜地變成謊話。三件都不會報錯，
 * 而且**圖看起來完全正常**（鐵律三那一整組的病）：
 *
 *   1. 面法向（`face.normal`）還是舊的 → dihedral 全錯 → 折線全錯
 *   2. 邊的 role 還是舊的 → 拉平的折線仍標著 FOLD、拉出角度的平面沒標
 *   3. `smooth` 還是舊的 → flatten.js 那行 `!he.smooth` 會讓
 *      **夾角 30 度的邊照樣不算折線**，展開長度直接錯
 *
 * ── 為什麼 remarkFolds() 不能直接呼叫 mesh.autoMarkFolds() ──
 * `autoMarkFolds()` 用 `setRole` 直接覆蓋，**會把使用者標的 CUT 洗回 FOLD**。
 * 那正是「開檔時標記就沒了」的機制（見 `規格\建模器-展開與分片.md`
 * 「指定分片」第 2 個決定）。編輯是在同一次開著的時候發生的，
 * 洗掉的是他剛剛才標的東西 —— 更糟。
 *
 * 單位一律 cm。**這個檔案不碰 DOM，所以測得到。**
 */

import * as THREE from 'three';
import { Mesh, EDGE_ROLE } from './mesh.js';
import { planarRegions } from './region.js';
import { FLAT_TOL_DEG } from '../unfold/flatten.js';
import { DEFAULT_CORNER_DEG } from '../sketch/svgPath.js';

const DEG = 180 / Math.PI;

/**
 * 「這個面還算不算平的」的容許值，單位 cm。
 *
 * 跟 `slice/section.js` 的 FIT_TOL 剛好同一個數字，但**是兩條不同的規則**，
 * 所以各自定義、不共用一個常數（共用了，日後調其中一個會誤傷另一個）。
 * 挑 0.01cm 的理由一樣：這個專案切的是珍珠板與壓克力，
 * 0.1mm 已經遠低於任何切得出來的東西。**容許值要挑講得出物理意義的量**
 * （鐵律三，坑 25／26）。
 */
export const PLANAR_TOL_CM = 0.01;

/**
 * 「這一批三角形是不是**真的**躺在同一個平面上」的容許值，單位 cm。
 * 1e-4 cm ＝ **1 微米**。
 *
 * 🔴 **它跟 `PLANAR_TOL_CM` 是兩條完全不同的規則，不可以共用一個常數。**
 *
 * | 常數 | 回答什麼 | 尺度 |
 * |---|---|---|
 * | `PLANAR_TOL_CM` (0.01) | **這個面做不做得出來** —— 製造問題 | 珍珠板與壓克力，0.1mm |
 * | `MERGE_FLAT_TOL_CM` (1e-4) | **這些三角形是不是同一個平面** —— 數值問題 | 浮點雜訊之上 |
 *
 * ── 為什麼是 1 微米（實測挑的，不是猜的）────────────────
 * 2026-08-24 量過「真的共面」的區域，Newell 平面偏離：
 * 方塊 0、圓柱 seg32 4.4e-16、seg128 1.1e-16、圓錐 1.9e-11、
 * **球 seg16 是 1.0e-6**（最糟的一個）。
 * 而要擋掉的 seg=720 圓柱是 **1.9e-3**。
 *
 * 1e-4 落在中間：比真正共面的大 **100 倍**（不會誤擋），
 * 比要擋的小 **19 倍**（擋得住）。
 *
 * ⚠ 一開始這裡用的是 `PLANAR_TOL_CM`，**太鬆了三個數量級**，
 * seg=719／720 照樣溜過去、展開面積跟著變。
 * 〔坑第 25／26 條的同一家族：容許值要挑一個**這條規則自己**講得出意義的量，
 * 　不是隨手借一個看起來差不多的〕
 */
export const MERGE_FLAT_TOL_CM = 1e-4;

// ═══════════════════════════════════════════════════════
//  選到的元素 → 涉及哪些頂點
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **「一個面」指的是共面區域，不是三角形。**
 *
 * 方塊在網格裡是 **12 個三角形**，但使用者看到的是 **6 個正方形面**。
 * 點「頂面」要移動的是那 4 個頂點，不是命中的那一個三角形的 3 個。
 *
 * ⚠ 這條警告 `unfold/seam.js` 的 `cutAroundFace()` 早就寫著了，
 * 而寫這個檔案時**照樣踩進去** —— 推頂面只推了一半，體積只增加
 * 20000 而不是 24000。原因就是坑第 33 條那句：
 * **教訓寫在別的功能底下，就等於沒寫**（那條寫在「指定分片」，
 * 而我在寫「編輯」）。測試當場擋下來了。
 *
 * `planarRegions()` 是「貼標籤」不是重建網格，跑幾次都不會把資料弄壞。
 *
 * @returns {{rid:number, faces:Face[], verts:Vertex[]}}
 */
export function regionOf(mesh, face, tolDeg = 0.5) {
  if (!face) return { rid: -1, faces: [], verts: [] };
  planarRegions(mesh, tolDeg);
  const rid = face.region;
  if (rid === undefined || rid < 0) {
    return { rid: -1, faces: [face], verts: [...new Set(mesh.faceVerts(face))] };
  }
  const faces = mesh.faces.filter(f => f.region === rid);
  const verts = new Set();
  for (const f of faces) for (const v of mesh.faceVerts(f)) verts.add(v);
  return { rid, faces, verts: [...verts] };
}

/**
 * 一個共面區域的**邊界邊**（跟區域外面相鄰的那些邊）。
 *
 * ⚠ **畫「選到這個面」的標示一定要用這個，不能拿 `regionOf().verts` 去串。**
 * 那份頂點是從 Set 出來的，**順序是任意的** —— 依序連成封閉迴圈的話，
 * 方塊的一個正方形面會畫成一個蝴蝶結。
 * 〔2026-08-23 kang 實測截圖抓到：幾何完全正確（4 個頂點沒錯），
 * 　但畫出來的意思是錯的。又是坑第 20 條「正確的數字，錯誤的意思」〕
 *
 * @returns {Array<[Vertex, Vertex]>} 每一組是一條邊界邊的兩個端點
 */
export function regionBoundaryEdges(mesh, face, tolDeg = 0.5) {
  const reg = regionOf(mesh, face, tolDeg);
  if (!reg.faces.length) return [];
  const inRegion = new Set(reg.faces);
  const out = [];
  const seen = new Set();
  for (const f of reg.faces) {
    for (const he of mesh.faceLoop(f)) {
      // 沒有隔壁（邊界）或隔壁不在這個區域裡 → 這條就是區域的外緣
      if (he.twin && he.twin.face && inRegion.has(he.twin.face)) continue;
      const key = he.twin ? Math.min(he.id, he.twin.id) : he.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push([he.v, he.to]);
    }
  }
  return out;
}

/**
 * 把 select.js 的 pickElement() 回傳的元素，換成「要移動哪些頂點」。
 *
 * 三種 kind 的差別只在這裡，底下的移動與重算完全共用 ——
 * 又是專案既有的那條「入口分開、動作邏輯共用」。
 *
 * 🔴 **`el` 可以是一個元素，也可以是一個陣列（多選）。**
 * 一個名字、一條規則 —— 呼叫端不必分兩種寫法，
 * 而底下的移動、變換、重算完全不知道有沒有多選這件事。
 *
 * ⚠ 多選時去重**比物件本身，不比 id 也不比座標**。
 * 相鄰的兩個面共用一條邊上的頂點，那真的是**同一個 `Vertex` 物件** ——
 * 不去重就會被平移兩次（走兩倍距離），而畫面上看起來只是「拉太多了」。
 *
 * @param {object|object[]} el {kind:'vertex'|'edge'|'face', vert?, he?, face?}
 * @param {number} tolDeg 共面容許值（face 才用得到）
 * @returns {Vertex[]} 去重過的頂點清單；認不得的 kind 回傳空陣列
 */
export function elementVerts(mesh, el, tolDeg = 0.5) {
  if (!el) return [];
  if (Array.isArray(el)) {
    const out = [], seen = new Set();
    for (const e of el) {
      for (const v of elementVerts(mesh, e, tolDeg)) {
        if (!seen.has(v)) { seen.add(v); out.push(v); }
      }
    }
    return out;
  }
  if (el.kind === 'vertex') return el.vert ? [el.vert] : [];
  if (el.kind === 'edge') {
    const he = el.he;
    if (!he) return [];
    return he.v === he.to ? [he.v] : [he.v, he.to];
  }
  if (el.kind === 'face') {
    if (!el.face) return [];
    return regionOf(mesh, el.face, tolDeg).verts;   // ★ 區域，不是三角形
  }
  return [];
}

/**
 * gizmo 要掛在哪裡 ＝ **中心**（變換三個概念裡的第三個）。
 *
 * 用重心而不是「面的中心點」，是因為三種 kind 這樣就能共用同一段 ——
 * 單一頂點的重心就是它自己，一條邊的重心就是中點。
 *
 * ── 兩種中心（`pivot`）────────────────────────────────
 * | 值 | 是什麼 | 什麼時候差得出來 |
 * |---|---|---|
 * | `'median'`（預設） | **全部**選取頂點的重心 | — |
 * | `'active'` | **最後點的那一個元素**自己的重心 | 多選 ＋ 旋轉／縮放 |
 *
 * 單選時兩者**是同一個點**，所以這個參數在多選做出來之前沒有意義
 * （原本刻意沒做，見那一輪的說明）。多選之後差別很具體：
 * 選兩個面要縮放時，`median` 是兩面中間、`active` 是剛點的那一面 ——
 * **它決定東西往哪邊長。**
 *
 * ⚠ `pivot='active'` 會回過頭影響**方向**：`elementBasis()` 的切線本來就
 * 只看 active 那一個。兩個概念名義上正交，實作上方向依賴中心 ——
 * Blender 也是這樣（算方向的函式吃 pivot 當參數）。
 *
 * @param {object|object[]} el 一個元素或一個陣列
 * @param {'median'|'active'} pivot
 */
export function elementCenter(mesh, el, tolDeg = 0.5, pivot = 'median') {
  let target = el;
  if (pivot === 'active' && Array.isArray(el) && el.length) {
    target = el[el.length - 1];                    // 順序即 active：最後一筆
  }
  const vs = elementVerts(mesh, target, tolDeg);
  const c = new THREE.Vector3();
  if (!vs.length) return c;
  for (const v of vs) c.add(v.p);
  return c.divideScalar(vs.length);
}

// ═══════════════════════════════════════════════════════
//  方向：選到的元素自己的座標系（gizmo 的箭頭朝哪）
// ═══════════════════════════════════════════════════════

/**
 * 這一個頂點的法向 ＝ 圍繞它的面法向的和。
 *
 * 不用 `mesh.vertexNormals()`，因為那支會把**整個網格**的頂點都算一遍
 * （O(V+F)），而這裡只要一個。⚠ 邊界頂點只走得到半邊的扇形
 * （`vertOutgoing()` 自己的註解寫著），那對「箭頭朝哪」不致命 ——
 * 它只影響方向，不影響尺寸。
 */
function vertNormal(mesh, v) {
  const n = new THREE.Vector3();
  for (const he of mesh.vertOutgoing(v)) {
    if (he.face) n.add(mesh.computeFaceNormal(he.face));
  }
  return n;
}

/**
 * 用「Z 想朝哪、Y 大概朝哪」建一組正交基底，回傳對應的四元數。
 *
 * ⚠ **退化情況要當第一等公民處理，不是例外。**
 * Z 與 Y 共線、Y 給不出來、Z 是零向量 —— 三種都會讓矩陣建不起來，
 * 而建不起來的症狀是箭頭消失或亂轉，看起來像功能壞掉。
 * Blender 的做法是一條**退化鏈**：算不出來就往下退，
 * **永遠有答案，永遠不會沉默地什麼都不做。** 這裡照做。
 *
 * @returns {THREE.Quaternion|null} Z 真的是零向量時才回 null（呼叫端退回世界）
 */
function basisFrom(nz, ty) {
  const z = nz.clone();
  if (z.lengthSq() < 1e-16) return null;          // 退到最後一階：交給呼叫端用世界
  z.normalize();

  let y = ty ? ty.clone() : null;
  if (y) {
    y.addScaledVector(z, -y.dot(z));               // 投影到與 Z 垂直的平面
    if (y.lengthSq() < 1e-12) y = null;            // 跟 Z 共線 → 當成沒給
  }
  if (!y) {
    // 沒有切線就挑一個**跟 Z 最不共線**的世界軸來湊。挑最不共線的那一個，
    // 是為了讓叉積夠長 —— 這正是 Blender 那條「切線挑最不共線的」的同一個理由。
    const ax = Math.abs(z.x), ay = Math.abs(z.y), az = Math.abs(z.z);
    const w = (ax <= ay && ax <= az) ? new THREE.Vector3(1, 0, 0)
            : (ay <= az) ? new THREE.Vector3(0, 1, 0)
            : new THREE.Vector3(0, 0, 1);
    y = w.addScaledVector(z, -w.dot(z));
  }
  y.normalize();

  const x = new THREE.Vector3().crossVectors(y, z).normalize();
  y.crossVectors(z, x).normalize();                // 重算 Y，保證嚴格正交
  return new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(x, y, z));
}

/**
 * 🔴 選到的元素自己的座標系（**Z 一律是法向**），單位四元數，網格自己的座標系。
 *
 * ── 為什麼需要它 ────────────────────────────────────
 * 「擠出好像沒用」「斜面推不動」「拉不出梯形」根源是同一件事：
 * **gizmo 只有世界 XYZ 一種方向**。而變換其實是三個正交的概念 ——
 * **種類（移動／旋轉／縮放）× 方向 × 中心**，方向只是其中一個
 * （`外部參考-Blender編輯.md` 第 3 節）。
 *
 * 有了這一支，「沿法向推拉」就**不再是一個獨立功能**，
 * 而是「移動 × 法向 × 任意中心」的一個組合 —— `pushFace()` 那支
 * 獨立函式（以及它那個一直沒接上的介面）因此變成多餘的。
 *
 * ── 三種 kind 的規則（照 Blender，只取我們用得到的三種）──
 * | 選到 | Z（法向） | Y（切線） |
 * |---|---|---|
 * | 面 | 共面區域的面法向和 | **最長的那一條邊界邊**的方向 |
 * | 邊 | 兩端頂點法向和，投影到與邊垂直的平面 | 沿邊方向（v → to） |
 * | 點 | 頂點法向 | 剛好連兩條邊時取兩邊方向和，否則沒有 |
 *
 * 面的切線刻意用**最長的邊界邊**，而不是自己發明一條：那條邊
 * **畫面上正被畫成黃色**，使用者看得見箭頭為什麼朝那邊。
 * 長度相同時比座標決定先後 —— **同一個模型每次都要給同一個答案**
 * （鐵律三：結果不唯一就補條件補到唯一）。
 *
 * @returns {{quat: THREE.Quaternion, ok: boolean}} ok=false ＝ 算不出來，請退回世界方向
 */
export function elementBasis(mesh, el, tolDeg = 0.5) {
  const fail = () => ({ quat: new THREE.Quaternion(), ok: false });
  if (!mesh || !el) return fail();

  const list = Array.isArray(el) ? el : [el];
  if (!list.length) return fail();

  /**
   * 多選：**法向取全部的和，切線照 active（最後點的）那一個。**
   *
   * 法向取和是 Blender 的規則（選了幾個面就把法向相加）——
   * 兩個相鄰的斜面一起選，箭頭會指向它們中間，那正是要的。
   *
   * ⚠ **每一個元素的 Z 先正規化再相加。** 不正規化的話，一個面的 Z 是
   * 「那個共面區域裡所有三角形法向的和」—— 12 個三角形的區域會
   * **壓過** 2 個三角形的區域，而使用者眼中那只是「兩個面」。
   * 正規化之後每個選取元素**權重相同**，結果講得出來。
   *
   * 切線只看 active，理由是它必須**唯一**：把好幾條切線平均起來，
   * 兩個垂直的面就會得到一個零向量（然後退化）。
   * 而「箭頭的扭轉方向照你最後點的那一個」是一句講得出來的規則。
   */
  const z = new THREE.Vector3();
  for (const e of list) {
    const r = elementZY(mesh, e, tolDeg);
    if (r && r.z.lengthSq() > 1e-16) z.add(r.z.clone().normalize());
  }
  const act = elementZY(mesh, list[list.length - 1], tolDeg);
  const y = act ? act.y : null;

  const q = basisFrom(z, y);
  return q ? { quat: q, ok: true } : fail();
}

/**
 * 一個元素的「Z 想朝哪、Y 大概朝哪」（還沒正交化）。
 *
 * 抽出來是為了讓多選那一段有東西可以合併 ——
 * 三種 kind 的規則只寫在這裡一次。
 *
 * @returns {{z:THREE.Vector3, y:THREE.Vector3|null}|null}
 */
function elementZY(mesh, el, tolDeg = 0.5) {
  if (!el) return null;
  let z = null, y = null;

  if (el.kind === 'vertex') {
    if (!el.vert) return null;
    z = vertNormal(mesh, el.vert);
    const out = mesh.vertOutgoing(el.vert);
    if (out.length === 2) {
      y = new THREE.Vector3()
        .subVectors(out[0].to.p, el.vert.p).normalize()
        .add(new THREE.Vector3().subVectors(out[1].to.p, el.vert.p).normalize());
    }

  } else if (el.kind === 'edge') {
    const he = el.he;
    if (!he || he.v === he.to) return null;
    y = new THREE.Vector3().subVectors(he.to.p, he.v.p);
    if (y.lengthSq() < 1e-20) return null;
    z = vertNormal(mesh, he.v).add(vertNormal(mesh, he.to));
    // 法向要投影到與邊垂直的平面上，否則 Y 與 Z 不正交，基底會被 basisFrom 扭回去
    const d = y.clone().normalize();
    z.addScaledVector(d, -z.dot(d));

  } else if (el.kind === 'face') {
    if (!el.face) return null;
    const reg = regionOf(mesh, el.face, tolDeg);
    z = new THREE.Vector3();
    for (const f of (reg.faces.length ? reg.faces : [el.face])) {
      z.add(mesh.computeFaceNormal(f));
    }
    // 切線 ＝ 最長的邊界邊。長度相同時比端點座標，答案才唯一。
    let best = null, bestLen = -1, bestKey = null;
    for (const [a, b] of regionBoundaryEdges(mesh, el.face, tolDeg)) {
      const d = new THREE.Vector3().subVectors(b.p, a.p);
      const L = d.length();
      const key = `${a.p.x},${a.p.y},${a.p.z}|${b.p.x},${b.p.y},${b.p.z}`;
      if (L > bestLen + 1e-9 || (Math.abs(L - bestLen) <= 1e-9 && bestKey !== null && key < bestKey)) {
        best = d; bestLen = Math.max(L, bestLen); bestKey = key;
      }
    }
    y = best;

  } else {
    return null;
  }

  return z ? { z, y } : null;
}

// ═══════════════════════════════════════════════════════
//  移動
// ═══════════════════════════════════════════════════════

/**
 * 把一組頂點平移。**這是這個檔案唯一真正改動幾何的地方。**
 *
 * 刻意不在這裡呼叫 refreshAfterEdit() —— 拖曳 gizmo 時這支會每幀跑一次，
 * 而重算要走訪所有的邊（O(邊數)）。放進熱路徑就是坑第 3、22 條的第三次。
 * 呼叫端在**放開滑鼠時**跑一次重算就好。
 *
 * @returns {number} 實際移動的頂點數
 */
export function moveVerts(verts, delta) {
  if (!verts || !verts.length || !delta) return 0;
  for (const v of verts) v.p.add(delta);
  return verts.length;
}

/** 移動選到的元素（點／邊／面）。回傳移動的頂點數。 */
export function moveElement(mesh, el, delta, tolDeg = 0.5) {
  return moveVerts(elementVerts(mesh, el, tolDeg), delta);
}

/**
 * 沿面法向推拉一個面。**這是「拉面」的預設模式。**
 *
 * 🔴 **它已經被降級成一支便利函式，不再是「沿法向推拉」的唯一辦法。**
 * 介面走的是 **`elementBasis()` ＋ 方向切到「法向」＋ 拉 Z 那根箭頭** ——
 * 也就是「移動 × 法向 × 中心」的一個組合，不是一個獨立功能
 * （`外部參考-Blender編輯.md` 第 3 節：三個概念正交之後，
 * 沿法向擠出就不必是一個寫死的工具）。
 *
 * 留著它的理由只剩一個：**測試拿它當「已知正確的答案」**去對
 * 新的變換路徑（同一個位移，兩條路要算出同一個網格）。
 * ⛔ **不要再為它加介面**，那條待辦已經因為方向做出來而消失了。
 *
 * 〔曾經在規格檔寫成「拉面預設沿法向」，那是假的：那個開關不存在。
 * 　kang 實測截圖照出來的。鐵律六「不要寫一個不存在的退路」。
 * 　現在那個開關真的存在了，而它不是這一支。〕
 *
 * ── 整個面一起動不會拉歪，動一部分才會 ────────────────
 * 一整個共面區域一起平移是剛體運動，**面一定還是平的**，
 * 不管往哪個方向。真正會把面拉歪的是「只移動一個頂點或一條邊」。
 * 那才是 `nonPlanarFaces()` 在盯的東西。
 *
 * ⚠ 這是「推拉面」不是「擠出面」：方塊推完還是方塊，只是變高了，
 * 不會長出新的一段。差別見 `編輯功能設計方向.md` 第 4 節。
 *
 * ⚠ **推的是整個共面區域，不是命中的那一個三角形**（見 regionOf 的說明）。
 *
 * @param {number} dist 正值 ＝ 往法向外推，負值 ＝ 往內縮
 */
export function pushFace(mesh, face, dist, tolDeg = 0.5) {
  if (!face || !dist) return 0;
  const reg = regionOf(mesh, face, tolDeg);
  if (!reg.verts.length) return 0;
  const n = mesh.computeFaceNormal(face).clone();
  if (n.lengthSq() < 1e-12) return 0;
  return moveVerts(reg.verts, n.multiplyScalar(dist));
}

// ═══════════════════════════════════════════════════════
//  拆掉重建這條路的三個必要配件
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **這三支（預檢／清乾淨／搬選取）是同一件事的三面，不能只做一個。**
 *
 * 我們唯一改變拓撲的路徑是「拆掉重建」（湊出 `points[]` 與 `faces[][]`
 * 再叫 `Mesh.fromFaceList()`）。2026-08-24 沙箱實測照出三件事：
 *
 * 1. **`fromFaceList()` 對壞資料一律照建，不報錯。**
 *    把方塊的頂點 1 併到頂點 0（最天真的「合併頂點」寫法）之後，
 *    12 個面裡有 2 個退化成一條線、1 個頂點變孤點 ——
 *    而它照樣建出 `V8 E20 F12 χ0 closed=false`。
 *
 * 2. **`validate()` 抓不到孤點。** 面合併之後的圓柱是
 *    `V66 E96 F34 χ4 closed=true ok=true　issues:（無）`——
 *    `ok` 說沒事，**唯一露餡的是尤拉數**（封閉實體應該是 2，卻是 4）。
 *    這正是鐵律三「讓兩個數字互相對得起來，錯誤才會自己現形」：
 *    `ok` 是孤零零的布林值沒人驗得了，χ 是由 V／E／F 推得出來的。
 *
 * 3. **清掉孤點就要重新編號**，而那會打破
 *    「既有頂點保持原索引」這個契約 —— `role`、`smooth`、選取搬移全靠它。
 *    所以清乾淨的那一支**必須把 remap 交出來**，讓呼叫端有辦法補救。
 *
 * ⚠ 四個工具（面合併、刪除面、導角、合併頂點）**全部**會產生孤點。
 * 實測過的，不是推的。
 */

/**
 * 拆掉重建之前先檢查。**不修，只回報。**
 *
 * 分成「一定壞掉」與「可以修掉」兩類 —— 因為呼叫端的處理方式不同：
 * 前者要擋下來並說原因，後者交給 `cleanRebuild()` 清掉就好。
 *
 * @param {THREE.Vector3[]} points
 * @param {number[][]} faces
 * @returns {{ok:boolean, fatal:string[], fixable:string[],
 *            orphans:number[], degenerate:number[], dupFaces:number[]}}
 */
export function preflightRebuild(points, faces) {
  const fatal = [], fixable = [];
  const orphans = [], degenerate = [], dupFaces = [];

  if (!Array.isArray(points) || !Array.isArray(faces)) {
    return { ok: false, fatal: ['沒有給 points 或 faces'], fixable, orphans, degenerate, dupFaces };
  }

  const used = new Set();
  const seenFace = new Map();

  faces.forEach((f, fi) => {
    if (!Array.isArray(f)) { fatal.push(`第 ${fi} 個面不是陣列`); return; }
    for (const i of f) {
      if (!Number.isInteger(i) || i < 0 || i >= points.length) {
        fatal.push(`第 ${fi} 個面指到不存在的頂點 ${i}`);
        return;
      }
      used.add(i);
    }
    // 退化：去重之後不足 3 個點 —— 那是一條線或一個點，不是面
    if (new Set(f).size < 3) { degenerate.push(fi); return; }
    // 重複的面：同一組頂點出現兩次（繞向不同也算，那是「兩面貼在一起」）
    const key = [...new Set(f)].sort((a, b) => a - b).join(',');
    if (seenFace.has(key)) dupFaces.push(fi);
    else seenFace.set(key, fi);
  });

  for (let i = 0; i < points.length; i++) if (!used.has(i)) orphans.push(i);

  if (degenerate.length) fixable.push(`${degenerate.length} 個面退化成線或點`);
  if (orphans.length) fixable.push(`${orphans.length} 個頂點沒有被任何面用到（孤點）`);
  if (dupFaces.length) fixable.push(`${dupFaces.length} 個面跟別的面完全重複`);

  return { ok: fatal.length === 0, fatal, fixable, orphans, degenerate, dupFaces };
}

/**
 * 把 `points`／`faces` 清乾淨，並**交出索引對照表**。
 *
 * 清三種：退化的面、重複的面、孤點。清完之後重新編號 ——
 * 🔴 **而 `remap` 就是那筆「誰變成誰」的帳**，呼叫端要拿它去搬
 * `role`／`smooth`／使用者的選取。沒有它，那些東西會安靜地消失。
 *
 * ⚠ **孤點剛好都在最後面時 remap 是恆等的**（實測圓柱那個案例位移 0 個），
 * 但那是運氣。孤點在中間時一定會位移（實測合併頂點：原索引 7 → 6）。
 * ⛔ **不要因為「大部分時候不會動」就跳過搬移。**
 *
 * @returns {{points:THREE.Vector3[], faces:number[][],
 *            remap:Map<number,number>, dropped:{orphans:number, degenerate:number, dup:number}}}
 */
export function cleanRebuild(points, faces) {
  const pre = preflightRebuild(points, faces);
  const bad = new Set([...pre.degenerate, ...pre.dupFaces]);

  const keep = [];
  faces.forEach((f, fi) => {
    if (bad.has(fi)) return;
    // 連續重複的點也要拿掉（`a,a,b,c` → `a,b,c`），否則會生出零長度的邊
    const clean = f.filter((v, i) => v !== f[(i + 1) % f.length]);
    if (new Set(clean).size >= 3) keep.push(clean);
  });

  const used = new Set();
  for (const f of keep) for (const i of f) used.add(i);

  const remap = new Map();
  const pts = [];
  for (let i = 0; i < points.length; i++) {
    if (!used.has(i)) continue;
    remap.set(i, pts.length);
    pts.push(points[i]);
  }

  return {
    points: pts,
    faces: keep.map(f => f.map(i => remap.get(i))),
    remap,
    dropped: {
      orphans: points.length - pts.length,
      degenerate: pre.degenerate.length,
      dup: pre.dupFaces.length
    }
  };
}

/**
 * 🔴 **把一份選取從舊網格搬到新網格上**（＝ Blender 的 targetmap）。
 *
 * ── 為什麼非做不可 ──────────────────────────────────
 * 重建之後舊的 `Vertex`／`HalfEdge`／`Face` 物件**還活著**
 * （JS 不會回收被引用的東西）—— 拖曳照樣「成功」，只是改的是一份
 * **已經不在文件裡的網格**。畫面沒反應、資料也沒錯，最難查的那一種。
 *
 * ── 配對一律走頂點索引，不走 `id` ────────────────────
 * `id` 每次重建都重新編號，所以不能用。索引可以 ——
 * 而且 `cleanRebuild()` 已經把 `remap` 交出來了，配對是**精確的**，不是猜的。
 *
 * | kind | 拿什麼配 |
 * |---|---|
 * | 點 | 頂點索引 |
 * | 邊 | （起點索引、終點索引）那一對 |
 * | 面 | 共面區域的**頂點索引集合** |
 *
 * ⚠ **這一支不適用於 Undo／讀檔。** 那兩條路換上來的是**另一個模型狀態**，
 * 索引根本不保證對得起來 —— 那裡就該老實清掉（`select.js` 的 `revalidate()` 在做）。
 *
 * ⚠ 搬不過去的會**掉掉**（例如那個面已經被合併進別的面了）。
 * 呼叫端要比對數量，少掉時講一句 —— 選取安靜地變少最讓人不敢相信工具。
 *
 * @param {Mesh} oldMesh
 * @param {Mesh} newMesh
 * @param {object|object[]} els
 * @param {Map<number,number>} remap 舊頂點索引 → 新頂點索引（`cleanRebuild()` 給的）
 * @returns {object[]} 搬得過去的那些
 */
export function remapElements(oldMesh, newMesh, els, remap, tolDeg = 0.5) {
  const list = Array.isArray(els) ? els : (els ? [els] : []);
  if (!oldMesh || !newMesh || !list.length) return [];

  const oi = new Map();
  oldMesh.verts.forEach((v, i) => oi.set(v, i));
  const ni = new Map();
  newMesh.verts.forEach((v, i) => ni.set(v, i));

  /** 舊索引 → 新索引。沒給 remap 就當成恆等（頂點沒被清掉的情形） */
  const to = i => (remap ? remap.get(i) : i);

  /** 新網格上「連接索引 a 與 b」的那條半邊 */
  const findEdge = (a, b) => {
    for (const he of newMesh.edges()) {
      const x = ni.get(he.v), y = ni.get(he.to);
      if ((x === a && y === b) || (x === b && y === a)) return he;
    }
    return null;
  };

  /** 新網格上「共面區域的頂點索引集合剛好等於 want」的那個面 */
  let regionCache = null;
  const findRegionFace = want => {
    if (!regionCache) {
      planarRegions(newMesh, tolDeg);
      regionCache = new Map();
      for (const f of newMesh.faces) {
        const rid = f.region;
        if (rid === undefined || rid < 0) continue;
        if (!regionCache.has(rid)) regionCache.set(rid, { first: f, set: new Set() });
        const g = regionCache.get(rid);
        for (const v of newMesh.faceVerts(f)) g.set.add(ni.get(v));
      }
    }
    for (const g of regionCache.values()) {
      if (g.set.size !== want.size) continue;
      let same = true;
      for (const k of want) if (!g.set.has(k)) { same = false; break; }
      if (same) return g.first;
    }
    return null;
  };

  const out = [];
  /**
   * ⚠ **搬過去之後可能撞在一起，要去重。**
   * 例如壓平三片再合併：三個舊面**全部指向同一個新面**，
   * 不去重的話「選了幾個」會說 3，而畫面上只有一個 —— 那個數字在說謊（坑第 20 條）。
   * 邊要連 `twin` 一起比（同一條邊有兩條半邊）。
   */
  const seen = new Set();
  const fresh = e => {
    const k = e.kind === 'vertex' ? e.vert
            : e.kind === 'face' ? e.face
            : (e.he.id < (e.he.twin ? e.he.twin.id : Infinity) ? e.he : e.he.twin);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  };

  for (const el of list) {
    if (!el) continue;

    if (el.kind === 'vertex') {
      const i = to(oi.get(el.vert));
      if (i !== undefined && newMesh.verts[i]) {
        const e = { ...el, vert: newMesh.verts[i], mesh: newMesh };
        if (fresh(e)) out.push(e);
      }

    } else if (el.kind === 'edge') {
      const a = to(oi.get(el.he && el.he.v)), b = to(oi.get(el.he && el.he.to));
      if (a === undefined || b === undefined) continue;
      const he = findEdge(a, b);
      if (he) { const e = { ...el, he, mesh: newMesh }; if (fresh(e)) out.push(e); }

    } else if (el.kind === 'face') {
      if (!el.face) continue;
      const want = new Set();
      let lost = false;
      for (const v of regionOf(oldMesh, el.face, tolDeg).verts) {
        const i = to(oi.get(v));
        if (i === undefined) { lost = true; break; }
        want.add(i);
      }
      if (lost || !want.size) continue;
      const f = findRegionFace(want);
      if (f) { const e = { ...el, face: f, mesh: newMesh }; if (fresh(e)) out.push(e); }
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════
//  壓平
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **把選取的頂點壓到同一個平面上。**
 *
 * ── 它不是一個新功能，是「縮放 × 法向 × Z 打 0」──────────
 * 這一支**完全走現成的 `elementBasis()` ＋ `applyElementTransform()`**，
 * 一行新的數學都沒有。存在的理由只是**讓它按得到** ——
 * 「方向切法向、種類切縮放、Z 打 0」沒有人猜得到。
 *
 * 跟擠出的方案 C 同一個形狀：按一顆做一件固定的事，
 * 而那件事底下是已經驗過的機制。
 *
 * ── 為什麼這才是「把幾個面併成一個」的正解 ────────────
 * kang 選了 3 個 seg，想把它們變成一個面。直覺的做法是
 * 「不管夾角、直接併成一個 n 邊形」（＝ Blender 的溶解面）——
 * **實測那個 8 邊形偏離平面 0.9561 cm，是可切容許值（0.1mm）的 96 倍。**
 * 那不是「精確變近似」，是做不出來。
 *
 * 壓平之後那三片**真的共面**了，`mergeCoplanarFaces()` 就會自己把它們
 * 併成一個面 —— 而且是**真正平的**面，展開仍然精確。
 * **所以壓平之後，「併成一個面」是免費的。**
 *
 * ⚠ **形狀會變，這是它的本質不是缺點。** 呼叫端要講清楚。
 *
 * ⚠ **平面的法向是所有選取面的平均**（`elementBasis()` 的規則），
 * 平面通過中心（`editPivot` 決定是重心還是 active）。
 * 要「壓到跟某一片完全共面」是另一件事，**現在做不到**。
 *
 * @param {Mesh} mesh
 * @param {object|object[]} el 一個元素或一個陣列
 * @param {'median'|'active'} pivot
 * @returns {{ok:boolean, reason?:string, moved:number, before:number}}
 *          `before` ＝ 壓平前最遠的點離那個平面多遠（cm）——
 *          本來就在平面上時它是 0，呼叫端據此講「這個面本來就是平的」
 */
export function flattenElements(mesh, el, pivot = 'median', tolDeg = 0.5) {
  const verts = elementVerts(mesh, el, tolDeg);
  if (verts.length < 3) {
    return { ok: false, reason: '至少要選到 3 個頂點才壓得平', moved: 0, before: 0 };
  }

  const basis = elementBasis(mesh, el, tolDeg);
  if (!basis.ok) {
    return { ok: false, reason: '算不出這些面的方向（面積是零或孤立的點）', moved: 0, before: 0 };
  }

  const center = elementCenter(mesh, el, tolDeg, pivot);
  const nZ = new THREE.Vector3(0, 0, 1).applyQuaternion(basis.quat);

  let before = 0;
  for (const v of verts) {
    before = Math.max(before, Math.abs(nZ.dot(new THREE.Vector3().subVectors(v.p, center))));
  }

  const base = snapshotVerts(verts);
  const moved = applyElementTransform(verts, base,
    { pos: center, quat: basis.quat },
    { pos: center, quat: basis.quat, scale: new THREE.Vector3(1, 1, 0) });

  return { ok: true, moved, before };
}

// ═══════════════════════════════════════════════════════
//  面合併（＝ Blender 的「限制性溶解」）
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **把每一個共面區域合併成一個 n 邊形。**
 *
 * ── 為什麼這一支這麼重要 ────────────────────────────
 * 它一口氣解掉三件本來各自要做的事：
 *
 * 1. **`box` 四邊形化** —— 待辦裡那條原本只是「整齊」的小項，
 *    而這是**通用解**：不只 box，所有參數體一起。
 * 2. 🔴 **環切的前提。** 實測：16 段圓柱是 **64 個三角形、0 個四邊形**，
 *    而環切的 ring walker 穿的是四邊形 —— **沒有東西可以走**。
 *    合併之後圓柱變成 32 個四邊形 ＋ 2 個 32 邊形，ring 立刻走得通
 *    （實測：垂直邊的 ring 是 32 條的**閉環**）。
 * 3. 它本身就是第 6 期要做的「溶解」。
 *
 * ── 零件全部是現成的 ────────────────────────────────
 * `planarRegions()`（哪些面共面，就是 Blender 那個「量夾角低於門檻就合併」）
 * ＋ `boundaryLoops()`（有序的外緣）＋ `cleanRebuild()`（清孤點與重新編號）。
 * **這一支自己只做「把它們接起來」。**
 *
 * ── 合併不動幾何，所以可以對答案 ────────────────────
 * 它只是把三角形併回它本來就屬於的那個平面。實測（小數點後 6 位全同）：
 *
 * | | 面數 | 體積 | 面積 |
 * |---|---|---|---|
 * | 方塊 | 12 → **6** | 108000 → 108000 | 13800 → 13800 |
 * | 32 段圓柱 | 128 → **34** | 78036.130979 → 78036.130979 | 10174.903617 → 10174.903617 |
 *
 * ⚠ **多迴圈的區域不能合併，要原樣留著。** 管的兩個端面是**環形**
 * （外圈＋內圈兩個迴圈），一個面裝不下兩個迴圈。
 * 實測 66 個區域裡剛好 2 個是這種。
 *
 * ⚠ **一定會產生孤點。** 圓柱端面扇形的中心點合併之後就沒人用了 ——
 * 不清的話 χ 會從 2 變成 4，而 `validate()` 照樣回 `ok=true`。
 * 所以走 `cleanRebuild()`，並把 `remap` 交出去。
 *
 * ⚠ **合併出來的 n 邊形不保證是平的**：`tolDeg` 容許 0.5°，
 * 所以「幾乎共面」的一批三角形會被併成一個**略微不平**的 n 邊形。
 * 那對展開有影響（`nonPlanarFaces()` 會抓到）。**這一項還沒實測**，
 * 見 `外部參考-Blender編輯.md` 第 9.10 節。
 *
 * @param {Mesh} mesh 不會被改動，回傳一個新的
 * @param {number} tolDeg 共面容許值
 * @returns {{ok:boolean, mesh?:Mesh, reason?:string, remap?:Map<number,number>,
 *            before:number, after:number, skipped:number, orphans:number}}
 */
export function mergeCoplanarFaces(mesh, tolDeg = 0.5) {
  if (!mesh || !mesh.faces.length) {
    return { ok: false, reason: '沒有網格可以合併', before: 0, after: 0, skipped: 0, orphans: 0 };
  }

  mesh.computeNormals();
  planarRegions(mesh, tolDeg);

  const byRid = new Map();
  for (const f of mesh.faces) {
    const rid = f.region;
    if (!byRid.has(rid)) byRid.set(rid, []);
    byRid.get(rid).push(f);
  }

  const vi = mesh._vertIndex();
  const points = mesh.verts.map(v => v.p.clone());
  const faces = [];
  let skipped = 0, unflat = 0;

  for (const group of byRid.values()) {
    const loops = boundaryLoops(mesh, group);
    /**
     * 迴圈不是剛好一圈就**原樣留著**，不要硬合。
     * 0 圈 ＝ 走不出來（區域在某個頂點上「捏」成一點，`boundaryLoops` 會放棄）；
     * 2 圈以上 ＝ 環形（管的端面），一個面裝不下兩個迴圈。
     */
    if (loops.length !== 1) {
      skipped++;
      for (const f of group) faces.push(mesh.faceVerts(f).map(v => vi.get(v.id)));
      continue;
    }

    /**
     * 🔴 **併出來的多邊形要真的是平的，不然就不要併。**
     *
     * `tolDeg` 只看**相鄰兩個面**的夾角，而共面區域是**泛洪**出來的 ——
     * 一路上每一步都在容許值內，累積起來卻可能歪掉一大截。
     *
     * 實測（2026-08-24）：seg=720 的圓柱，相鄰 seg 夾角剛好 0.500°，
     * 整條側面被串成一區，併出來的多邊形**偏離 0.0019 cm**，
     * 而**展開總面積跟著從 10210.106 變成 10210.182** —— 下料尺寸會錯。
     *
     * 參數體碰不到（介面 seg 上限 128 → 夾角 2.813°，有 5.6 倍餘裕），
     * 但**匯入的線稿不保證** —— 擠出件的側牆角度取決於 SVG 取樣的精細度，
     * 那不在我們控制之下。
     *
     * 🔴 判準用 `MERGE_FLAT_TOL_CM`（1 微米），**不是** `PLANAR_TOL_CM`（0.1mm）——
     * 那兩條規則問的是不同的問題，理由見那個常數的說明。
     * 借用 0.1mm 會鬆三個數量級，seg=719／720 照樣溜過去。
     *
     * ⚠ 不平就**原樣留著**，不是硬併之後再警告 ——
     * 併下去尺寸就已經錯了，警告救不回來。
     */
    const idx = loops[0].map(he => vi.get(he.v.id));
    if (group.length > 1 && !isPlanarLoop(points, idx)) {
      unflat++;
      for (const f of group) faces.push(mesh.faceVerts(f).map(v => vi.get(v.id)));
      continue;
    }
    faces.push(idx);
  }

  const before = mesh.faces.length;
  if (faces.length === before) {
    /**
     * ⚠ **理由要講對，不要一句「沒得合併」蓋過去。**
     * 面數沒變有兩種完全不同的原因，而使用者的下一步不一樣：
     * 「本來就都是單一面」是好消息（已經是乾淨的），
     * 「有區域因為是環形而被跳過」是**限制**，他該知道那幾片還是三角形。
     * 〔坑第 20 條的同一家族：正確的結果，錯誤的意思〕
     */
    const why = [];
    if (skipped) why.push(`${skipped} 個區域是環形的（像管的端面），一個面裝不下兩圈`);
    if (unflat) why.push(`${unflat} 個區域的三角形其實不共面（超過 ${MERGE_FLAT_TOL_CM} cm），併了展開尺寸會錯`);
    return {
      ok: false,
      reason: why.length
        ? `沒有合併任何面：${why.join('；')}，只能維持原狀`
        : '沒有可以合併的面 —— 每個面本來就自成一區，已經是乾淨的',
      before, after: before, skipped, unflat, orphans: 0
    };
  }

  const clean = cleanRebuild(points, faces);
  const out = Mesh.fromFaceList(clean.points, clean.faces);
  out.computeNormals();

  /**
   * ⚠ 標記要搬。合併只是把三角形併起來，**使用者標的 CUT 一條都不該少** ——
   * 而共面區域內部那些對角線本來就標不了（`nearestMarkableEdge` 擋著），
   * 所以會被合併掉的邊上不會有 CUT。
   * 索引若沒位移（孤點都在最後面）`_copyMarksTo()` 直接就對；
   * 位移了就要走 remap —— 所以底下用重新編號後的座標自己配一次。
   */
  copyMarksThroughRemap(mesh, out, clean.remap);

  return {
    ok: true, mesh: out, remap: clean.remap,
    before, after: out.faces.length, skipped, unflat,
    orphans: clean.dropped.orphans
  };
}

/**
 * 這一圈頂點是不是共平面（在 `PLANAR_TOL_CM` 之內）。
 *
 * 用 Newell 法定一個平面，量最遠的點離平面多少 ——
 * 跟 `facePlanarity()` 同一套算法，但它吃的是 `Face`，
 * 而這裡要在**面還沒建出來之前**就先問，所以直接吃索引。
 *
 * ⚠ 兩支要用**同一個容許值**，否則會出現「合併時說平的、
 * 建出來之後 `nonPlanarFaces()` 又說不平」這種自相矛盾的狀態。
 */
function isPlanarLoop(points, idx) {
  if (idx.length < 4) return true;               // 三角形恆為平面（幾何事實）
  const n = new THREE.Vector3();
  for (let i = 0; i < idx.length; i++) {
    const a = points[idx[i]], b = points[idx[(i + 1) % idx.length]];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  if (n.lengthSq() < 1e-20) return false;        // 算不出平面就別併
  n.normalize();
  const o = points[idx[0]];
  let dev = 0;
  for (const i of idx) {
    dev = Math.max(dev, Math.abs(n.dot(new THREE.Vector3().subVectors(points[i], o))));
  }
  return dev <= MERGE_FLAT_TOL_CM;
}

/**
 * 把邊上的標記透過索引對照表搬到新網格上。
 *
 * `mesh.js` 的 `_copyMarksTo()` 假設**索引完全一樣**，
 * 而清孤點之後索引會位移 —— 所以這裡自己配一次。
 *
 * 🔴 **一律走 `marksOf()` / `applyMarks()`，不要手寫「搬哪幾樣」。**
 * 這一支就是那個教訓的現場：它原本手寫成「搬 `role` 與 `smooth`」，
 * 而 2026-08-24 加了 `hard` 之後**沒有人記得回來改這裡** ——
 * 結果是**按一次「壓平」，環切的線 48 條全部歸零**
 * （壓平會跑一次併面，而併面走的正是這一條路）。
 *
 * ⚠ 這已經是同一個病的第二次：`smooth` 在 2026-08-23 也是這樣漏掉的
 * （匯入的 S 字擠出後展開圖從 12 處變回 196 道折彎，座標完全正確）。
 * 兩次都是「東西安靜地不見了，而形狀完全正常」。
 * 〔坑第 31 條：與其讓好幾條路各自對齊，不如換一個只有一條路的定義〕
 */
function copyMarksThroughRemap(src, dst, remap) {
  const si = src._vertIndex(), di = dst._vertIndex();
  const to = i => (remap ? remap.get(i) : i);
  const key = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;

  const want = new Map();
  for (const he of src.edges()) {
    const m = src.marksOf(he);
    if (Mesh.marksEmpty(m)) continue;
    const a = to(si.get(he.v.id)), b = to(si.get(he.to.id));
    if (a === undefined || b === undefined) continue;
    want.set(key(a, b), m);
  }
  if (!want.size) return dst;

  for (const he of dst.edges()) {
    dst.applyMarks(he, want.get(key(di.get(he.v.id), di.get(he.to.id))));
  }
  return dst;
}

// ═══════════════════════════════════════════════════════
//  環切（Loop Cut）
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **從一條邊出發，穿過四邊形走到「對面那條邊」，串出一圈 edge ring。**
 *
 * ── edge ring 不是 edge loop，這兩個一直被搞混 ────────────
 * **edge loop**：在**四價頂點**上走「中間那條邊」，選出一整圈邊。
 * **edge ring**：穿過**四邊形**走「對面那條邊」，環切用的是這個。
 *
 * 🔴 **方塊與 32 段圓柱的頂點全是 3 價**（實測），
 * ⚠ **但那不是全域事實** —— 圓錐 seg12 的價數是 {3:10, 4:2, 5:2, 6:2}
 * （2026-08-25 導正，原本這裡寫的是「我們的網格頂點全是 3 價」）。
 * 所以 Blender 的 edge-loop walker 在上面**一步都走不了**。
 * 而 ring walker 走得非常好 —— 實測 32 段圓柱的 32 條垂直邊剛好繞成一個閉環。
 *
 * ── 停止條件 ──────────────────────────────────────────
 * 碰到**不是四邊形的面**就停（三角形與 n 邊形沒有「對面那條邊」，
 * 路徑不唯一，而**不唯一就不猜** —— 鐵律三）。碰到邊界也停。
 * 兩個方向各走一次，繞回起點就是閉環。
 *
 * 實測 ring 長度：方塊 **4（閉）**、32 段圓柱垂直邊 **32（閉）**、
 * 圓柱水平邊 **2**（撞到端面的 32 邊形就停 —— **那是對的行為**，不是缺陷）。
 *
 * ⚠ 前提是網格已經四邊形化。參數體借的是 three.js 的三角形
 * （16 段圓柱 ＝ 64 個三角形、**0 個四邊形**，一步都走不了），
 * 靠 `bake()` 時的 `mergeCoplanarFaces()` 補上。
 *
 * @param {Mesh} mesh
 * @param {HalfEdge} he0 起點那條邊（任一條半邊）
 * @returns {{hes:HalfEdge[], keys:string[], closed:boolean}}
 *          `hes` 每條邊只出現一次；`keys` 是「小索引-大索引」字串
 */
export function edgeRing(mesh, he0) {
  const out = { hes: [], keys: [], closed: false };
  if (!mesh || !he0) return out;

  const vi = mesh._vertIndex();
  const kOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const keyOf = h => kOf(vi.get(h.v.id), vi.get(h.to.id));

  const seen = new Set();
  const startKey = keyOf(he0);

  for (const start of [he0, he0.twin]) {
    if (!start) continue;
    let h = start, guard = 0;
    while (h && h.face && guard++ < 1e6) {
      const k = keyOf(h);
      if (seen.has(k)) {
        // 走回起點 ＝ 閉環（第一步就撞到自己不算，那是還沒走）
        if (k === startKey && out.hes.length > 1) out.closed = true;
        break;
      }
      seen.add(k);
      out.hes.push(h);
      out.keys.push(k);

      const loop = mesh.faceLoop(h.face);
      if (loop.length !== 4) break;           // 只穿得過四邊形
      const i = loop.indexOf(h);
      if (i < 0) break;
      const opp = loop[(i + 2) % 4];
      if (!opp.twin) break;                   // 對面那條是邊界，走不過去
      h = opp.twin;
    }
    if (out.closed) break;
  }
  return out;
}

/**
 * 🔴 **環切：在一整圈 edge ring 上插點，把穿過的四邊形切成好幾片。**
 *
 * ── 它做什麼、不做什麼 ────────────────────────────────
 * **做**：加線。**不動任何既有頂點的位置** —— 所以體積、面積、展開尺寸
 * 全部**精確不變**，那是可以對答案的（實測方塊 108000.000000 →
 * 108000.000000、圓柱 117054.196468 → 117054.196468）。
 * **不做**：改變形狀。要改形狀是接下來「拉那一圈邊」的事。
 *
 * ⚠ **加線本身就是目的。** 「加線」是整個編輯循環現在斷掉的地方 ——
 * 沒有它，一個方塊永遠只有 8 個頂點可以拉。
 *
 * ── 三個一定要一起做的配件（少一個就會出事）────────────
 *
 * | 配件 | 不做的症狀 |
 * |---|---|
 * | 新的邊標 **`hard`** | 畫面上看不見、點不到、半塊面拉不動、壓平會併掉（四個出口全中）|
 * | **被切成兩半的邊要繼承標記** | 實測：標了 CUT 的邊切完之後 **CUT 0 條**，安靜消失 |
 * | `preflightRebuild` / `cleanRebuild` | 拆掉重建這條路的必要配件 |
 *
 * ⭐ **環切是四個「拆掉重建」的工具裡唯一不產生孤點的**
 * （實測方塊、圓柱、半條 ring 都是 0 個）—— 因為它只加不減。
 * 但 `cleanRebuild()` 照走，那是這條路的規矩，不是看情況跳過的檢查。
 *
 * ── 撞到非四邊形停下來的那半條 ring ────────────────────
 * 停下來的地方那個面（例如圓柱端面的 32 邊形）**只插點、不切開** ——
 * 切開它才是不唯一的猜測，而只插點是唯一解：那個點本來就在它的邊上，
 * 不插進去反而會變成 T 型接點（一邊一條邊、另一邊兩條）。
 * 實測圓柱水平邊：32 邊形變 33 邊形，**χ 仍是 2、ok=true、體積精確不變**。
 *
 * @param {Mesh} mesh
 * @param {HalfEdge} he0 起點那條邊
 * @param {{cuts?:number}} opt `cuts` ＝ 刀數（預設 1），切點取 i/(cuts+1)
 * @returns {{ok:boolean, reason?:string, mesh?:Mesh, remap?:Map,
 *            ringLen?:number, closed?:boolean, cuts?:number,
 *            newEdges?:Array<[number,number]>, orphans?:number}}
 *          `newEdges` 是新那幾圈邊在**新網格**上的頂點索引對，
 *          呼叫端拿它去把那幾條邊選起來。
 */
export function loopCut(mesh, he0, opt = {}) {
  const cuts = Math.max(1, Math.round(opt.cuts || 1));
  if (!mesh || !he0) return { ok: false, reason: '沒有網格或沒有選到邊' };
  if (!he0.face || !he0.twin || !he0.twin.face) {
    return { ok: false, reason: '這是外輪廓的邊，環切要從兩側都有面的邊出發' };
  }

  mesh.computeNormals();
  const ring = edgeRing(mesh, he0);
  if (!ring.hes.length) return { ok: false, reason: '從這條邊走不出一圈可以切的邊' };

  const vi = mesh._vertIndex();
  const kOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const cutKeys = new Set(ring.keys);

  /**
   * 每條要切的邊插 `cuts` 個點。
   * ⚠ **存的順序一律是「小索引 → 大索引」**，取用時再照走的方向翻過來 ——
   * 邊沒有方向，而面有；不定一個標準的話，同一條邊在兩個面裡會插出
   * 相反的順序，切出來的四邊形就會自交（畫面上看不出來，體積才會露餡）。
   */
  const points = mesh.verts.map(v => v.p.clone());
  const mids = new Map();
  for (const k of cutKeys) {
    const [a, b] = k.split('-').map(Number);
    const arr = [];
    for (let i = 1; i <= cuts; i++) {
      arr.push(points.length);
      points.push(points[a].clone().lerp(points[b], i / (cuts + 1)));
    }
    mids.set(k, arr);
  }
  /** 從 u 走向 w 時，這條邊上的插點由近到遠 */
  const midsAlong = (u, w) => {
    const arr = mids.get(kOf(u, w));
    return u < w ? arr : [...arr].reverse();
  };

  /**
   * 標記帳本，記在**重建前**的索引空間，最後透過 `remap` 一次搬過去。
   * 三種來源：既有邊照抄、被切成兩半（n+1 段）的每一段都繼承、新的那幾圈標 hard。
   */
  const marks = new Map();
  const mark = (a, b, m) => {
    const k = kOf(a, b);
    marks.set(k, Object.assign({}, marks.get(k), m));
  };

  for (const he of mesh.edges()) {
    const a = vi.get(he.v.id), b = vi.get(he.to.id);
    // 🔴 整包讀，不要手寫「有哪幾樣」—— 見 copyMarksThroughRemap() 的說明
    const m = mesh.marksOf(he);
    if (!cutKeys.has(kOf(a, b))) { mark(a, b, m); continue; }
    /**
     * 🔴 **一條變 n+1 條，每一段都要繼承。**
     * 不做的話 `copyMarksThroughRemap()` 那種「起點-終點索引對」的配對
     * 一定落空（`1-3` 被切成 `1-8` 與 `8-3`），而**標記會安靜消失**。
     * 實測：標了 CUT ＋ smooth 的邊切完之後 CUT 0 條、smooth 0 條。
     */
    const chain = [a, ...midsAlong(a, b), b];
    for (let i = 0; i + 1 < chain.length; i++) mark(chain[i], chain[i + 1], m);
  }

  const faces = [];
  const newEdgePairs = [];
  let split = 0, pierced = 0;

  for (const f of mesh.faces) {
    const loop = mesh.faceLoop(f);
    const idx = loop.map(he => vi.get(he.v.id));
    const hit = [];
    for (let i = 0; i < loop.length; i++) {
      if (cutKeys.has(kOf(idx[i], idx[(i + 1) % loop.length]))) hit.push(i);
    }
    if (!hit.length) { faces.push(idx); continue; }

    if (loop.length === 4 && hit.length === 2 && hit[1] - hit[0] === 2) {
      /**
       * 正常情形：四邊形被一對**對面的邊**穿過 → 切成 cuts+1 條。
       *
       * 面的繞向是 v0→v1→v2→v3。切線 k 連的是「v0 那條邊上第 k 個點」
       * 與「v2 那條邊上第 (n+1-k) 個點」—— 因為 v2 那一側的參數是反過來數的
       * （v2 挨著 v1，所以「離 v0 t 遠」＝「離 v2 (1−t) 遠」）。
       * ⚠ 配錯的話四邊形會扭成沙漏，而**畫面上完全看不出來**（坑第 29 條）。
       */
      const i0 = hit[0];
      const v = k => idx[(i0 + k) % 4];
      const A = midsAlong(v(0), v(1));        // v0 → v1 上的點，由近到遠
      const B = midsAlong(v(2), v(3));        // v2 → v3 上的點，由近到遠
      const n = cuts;
      for (let k = 0; k <= n; k++) {
        const left  = k === 0 ? v(0) : A[k - 1];
        const right = k === 0 ? v(3) : B[n - k];
        const nl = k === n ? v(1) : A[k];
        const nr = k === n ? v(2) : B[n - k - 1];
        faces.push([left, nl, nr, right]);
      }
      for (let k = 0; k < n; k++) {
        mark(A[k], B[n - 1 - k], { hard: true });
        newEdgePairs.push([A[k], B[n - 1 - k]]);
      }
      split++;
      continue;
    }

    /**
     * 半條 ring 停下來的地方：這個面被切到但穿不過去（三角形、n 邊形，
     * 或只被切到一條邊）。**只把點插進迴圈，不切開它。**
     * 不插的話那條邊會變成一邊一條、另一邊兩條 —— T 型接點。
     */
    const out = [];
    for (let i = 0; i < loop.length; i++) {
      const u = idx[i], w = idx[(i + 1) % loop.length];
      out.push(u);
      if (cutKeys.has(kOf(u, w))) out.push(...midsAlong(u, w));
    }
    faces.push(out);
    pierced++;
  }

  const pre = preflightRebuild(points, faces);
  if (!pre.ok) return { ok: false, reason: `環切做出壞掉的網格：${pre.fatal[0]}` };

  const clean = cleanRebuild(points, faces);
  const out = Mesh.fromFaceList(clean.points, clean.faces);
  out.computeNormals();

  // 標記搬過去（順便把新的那幾圈標成 hard）
  const to = i => clean.remap.get(i);
  const di = out._vertIndex();
  const want = new Map();
  for (const [k, m] of marks) {
    const [a, b] = k.split('-').map(Number);
    const x = to(a), y = to(b);
    if (x === undefined || y === undefined) continue;
    want.set(kOf(x, y), m);
  }
  for (const he of out.edges()) {
    out.applyMarks(he, want.get(kOf(di.get(he.v.id), di.get(he.to.id))));
  }

  return {
    ok: true, mesh: out, remap: clean.remap,
    ringLen: ring.hes.length, closed: ring.closed, cuts,
    split, pierced,
    newEdges: newEdgePairs
      .map(([a, b]) => [to(a), to(b)])
      .filter(([a, b]) => a !== undefined && b !== undefined),
    orphans: clean.dropped.orphans
  };
}

// ═══════════════════════════════════════════════════════
//  任意切線（Bisect）＝ 加線 × 平面
// ═══════════════════════════════════════════════════════

/**
 * 「離平面這麼近就當它在平面上」的容許值，單位 cm。
 *
 * 🔴 **這個常數是這一支跟 `slice/section.js` 唯一實質不同的地方，
 * 　　而它非有不可。**
 *
 * `section.js` 算的是 2D 線段（給 DXF 用），它的做法是
 * 「距離剛好 0 的頂點一律往正側推 1e-9」—— 這樣每條邊只剩
 * 「跨」與「不跨」兩態，漏掉任何一種組合就會少一段線。
 * **那條規則在出圖是對的，拿來改網格會出事**：
 * 頂點剛好落在平面上時 `s = dA/(dA−dB)` 會算出 0 或 1，
 * 於是**在既有頂點上再插一個幾乎重合的新點**，長出一條零長度的邊。
 * 2D 可以事後濾掉，網格不行 —— 那是退化幾何，會一路帶到布林與 STL。
 *
 * ⚠ 而且它**不會報錯**：體積、面積、χ 全部照樣正確
 * （坑第 17 條：中途的量一直都是對的，末端才錯）。
 *
 * → 所以這裡改成三態，判準用**講得出物理意義的量**：
 *   離平面比 0.1mm 更近的頂點就**直接拿它當交點**，不插新點。
 *   比 0.1mm 更近的兩個點本來就切不出來（坑 25／26 同一條理由）。
 *   借用 `PLANAR_TOL_CM` 而不是另定一個 —— 它問的是同一件事：
 *   「這個東西算不算貼在這個平面上」。
 */
const ON_PLANE_CM = PLANAR_TOL_CM;

/**
 * 導角段數的上限（kang 2026-08-25 選的，跟環切的刀數對齊）。
 * ⚠ 段數 16 的方塊全導已經是 2000 多個點，32 只會更多 ——
 * 對實際加工沒有差別（誤差 0.016% 已遠低於任何切得出來的東西），
 * 上限給高只是為了**跟環切一致好記**，不是鼓勵用。
 */
export const BEVEL_MAX_SEG = 32;

/**
 * 把「世界座標的軸平面」換算成這個物件**自己座標**裡的平面。
 *
 * 🔴 **不做這件事就會切錯位置，而且形狀完全正常。**
 *
 * 網格存的是物件自己的座標，物件另外帶著位置與旋轉
 * （`align.js` 的 `worldBounds()` 就是為此存在的）。
 * 使用者在畫面上打的「x＝5」是**世界**座標，物件被轉過的話，
 * 那個平面在網格自己的座標裡是**斜的**。
 *
 * 推導：世界點 `P = M·p + t`。要 `P[軸] = coord`，
 * 展開就是 `(M 的第「軸」列)·p = coord − t[軸]`，
 * 所以本地法向就是 M 的那一**列**（不是行），偏移是 `coord − t[軸]`。
 * 有縮放時法向不是單位長度，`bisect()` 自己會歸一化。
 *
 * ⭐ 副產品：日後要做「拿選到的那個面當平面」不必動這裡 ——
 * 那條路直接給 `{ n: 面法向, d: n·面上任一點 }` 就好。
 *
 * @param {THREE.Matrix4} matrix 物件的變換矩陣
 * @param {'x'|'y'|'z'} axis
 * @param {number} coord 世界座標，cm
 * @returns {{n: THREE.Vector3, d: number}} 本地平面 `n·p = d`
 */
export function worldAxisPlane(matrix, axis, coord) {
  const e = matrix.elements;                 // three.js 是 column-major
  const row = { x: 0, y: 1, z: 2 }[axis];
  if (row === undefined) throw new Error(`worldAxisPlane：不認得的軸「${axis}」`);
  return {
    n: new THREE.Vector3(e[row], e[4 + row], e[8 + row]),
    d: coord - e[12 + row]
  };
}

/**
 * 🔴 **任意切線：用一個平面把網格切開，只加線、不改形狀。**
 *
 * ── 它是「加線 × 平面」，不是新功能 ──────────────────────
 * 2026-08-25 kang 批准的四動作框架（加線／加面／移除／移動）的第三個案例：
 * 環切是「加線 × 一圈邊」、內縮是「加線 × 面的內縮輪廓」、
 * 這一支是「加線 × 平面」。**骨架跟 `loopCut()` 逐項對應**
 * （帳本 → `preflightRebuild` → `cleanRebuild` → `applyMarks`）。
 *
 * 🔴 **只加線，體積與面積精確不變** —— 跟環切、內縮同一條主斷言。
 * 要改形狀是下一步「拉那一圈邊」的事。
 *
 * ── ⚠ `sectionAt()` 不能重用，但它踩過的坑要沿用 ────────────
 * `slice/section.js` 算的是 2D 線段，不是改網格。
 * 它那條「頂點落在平面上怎麼辦」的坑這裡照樣會踩，
 * 但**解法必須不同** —— 見 `ON_PLANE_CM` 的說明。
 *
 * ── 新的那一圈要標 `hard` ─────────────────────────────
 * 切開的兩半是**共面**的，而這個專案有一條貫穿全域的規則
 * 「共面的邊 ＝ 看不見的邊 ＝ 不該存在的邊」。不標 `hard` 的話
 * 四個出口全中（畫不出來、點不到、半塊面拉不動、按壓平被併掉），
 * 這顆按鈕按下去畫面上什麼都不會變（坑第 21 條）。
 *
 * ── ⚠ 一個面被穿超過兩次：不切，但要講 ──────────────────
 * 凸的面一定只被穿兩次。非凸的面可能被穿 4 次以上，
 * 那要切成 3 片以上 —— **還沒做**。這種面**原樣保留並計入 `skipped`**，
 * 由呼叫端講出來。⛔ 不可以沉默跳過（坑第 11 條）。
 * 〔實測球 segW12/segH12 跳過 0 個，所以先這樣做〕
 *
 * @param {Mesh} mesh
 * @param {{n: THREE.Vector3, d: number}} plane 本地平面 `n·p = d`；
 *        世界的軸平面請先過 `worldAxisPlane()`
 * @returns {{ok:boolean, reason?:string, mesh?:Mesh, remap?:Map,
 *            crossed?:number, split?:number, pierced?:number,
 *            skipped?:number, newEdges?:Array, orphans?:number}}
 */
export function bisect(mesh, plane) {
  if (!mesh || !mesh.faces.length) return { ok: false, reason: '沒有網格' };
  if (!plane || !plane.n) return { ok: false, reason: '沒有給切割平面' };

  const n = plane.n.clone();
  const len = n.length();
  if (!(len > 1e-12)) return { ok: false, reason: '切割平面的方向是 0，指不出方向' };
  n.divideScalar(len);
  const d = plane.d / len;

  mesh.computeNormals();
  const vi = mesh._vertIndex();
  const points = mesh.verts.map(v => v.p.clone());

  /**
   * 三態：`+1` 正側、`-1` 負側、`0` 就在平面上（見 `ON_PLANE_CM`）。
   * `0` 的頂點**直接當交點用**，不插新點。
   */
  const dist = points.map(p => p.dot(n) - d);
  const side = dist.map(x => (Math.abs(x) < ON_PLANE_CM ? 0 : (x > 0 ? 1 : -1)));

  if (!side.some(s => s > 0) || !side.some(s => s < 0)) {
    return {
      ok: false,
      reason: '這個位置沒有切到東西 —— 整個物件都在平面的同一側，'
            + '或是平面剛好貼在表面上。看一下輸入框旁邊寫的範圍'
    };
  }

  const kOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  /** 跨過平面的邊，各插一個點。同一條邊只插一次（`edges()` 已經去重） */
  const cross = new Map();
  for (const he of mesh.edges()) {
    const a = vi.get(he.v.id), b = vi.get(he.to.id);
    if (side[a] * side[b] >= 0) continue;       // 不跨（含任一端在平面上）
    const k = kOf(a, b);
    if (cross.has(k)) continue;
    const s = dist[a] / (dist[a] - dist[b]);
    cross.set(k, points.length);
    points.push(points[a].clone().lerp(points[b], s));
  }

  /**
   * 標記帳本，記在**重建前**的索引空間，最後透過 `remap` 一次搬過去。
   * 🔴 **被切成兩段的邊，兩段都要繼承** —— 不做的話
   * `1-3` 變成 `1-8` 與 `8-3`，索引配對落空，**標記會安靜消失**。
   */
  const marks = new Map();
  const mark = (a, b, m) => {
    const k = kOf(a, b);
    marks.set(k, Object.assign({}, marks.get(k), m));
  };
  for (const he of mesh.edges()) {
    const a = vi.get(he.v.id), b = vi.get(he.to.id);
    // 🔴 整包讀，不要手寫「有哪幾樣」—— 見 copyMarksThroughRemap() 的說明
    const m = mesh.marksOf(he);
    const mid = cross.get(kOf(a, b));
    if (mid === undefined) { mark(a, b, m); continue; }
    mark(a, mid, m);
    mark(mid, b, m);
  }

  const faces = [];
  const newEdgePairs = [];
  let split = 0, pierced = 0, skipped = 0;

  for (const f of mesh.faces) {
    const idx = mesh.faceLoop(f).map(he => vi.get(he.v.id));

    /**
     * 沿著這個面的迴圈走一圈，展開成「切完之後的頂點序列」，
     * 同時記下序列裡哪幾個位置落在平面上 —— 那些就是切線的端點。
     * 兩種來源合在同一個清單裡：既有頂點（`side === 0`）與新插的點。
     */
    const seq = [];
    const onIdx = [];
    for (let i = 0; i < idx.length; i++) {
      const a = idx[i], b = idx[(i + 1) % idx.length];
      if (side[a] === 0) onIdx.push(seq.length);
      seq.push(a);
      const mid = cross.get(kOf(a, b));
      if (mid !== undefined) { onIdx.push(seq.length); seq.push(mid); }
    }

    if (onIdx.length !== 2) {
      /**
       * 0 個：這個面整片在一側，原樣。
       * 1 個：只碰到一個角，切不開，原樣（但點已經在序列裡了）。
       * 3 個以上：非凸的面被穿多次，要切成 3 片以上 —— 還沒做，計入 skipped。
       */
      faces.push(seq);
      if (onIdx.length > 2) skipped++;
      else if (seq.length !== idx.length) pierced++;
      continue;
    }

    const [p, q] = onIdx;
    /**
     * ⚠ 兩個交點**相鄰**時不能切 —— 那條「切線」就是既有的那條邊，
     * 切下去會生出一個只有兩個點的面，而 `fromFaceList()` 會直接跳過它
     * （靜默掉一個面，形狀就破了）。
     * 兩側都要檢查：迴圈是繞回來的，「相鄰」可能發生在接縫那一頭。
     */
    if (q - p < 2 || seq.length - (q - p) < 2) { faces.push(seq); continue; }

    faces.push(seq.slice(p, q + 1));
    faces.push([...seq.slice(q), ...seq.slice(0, p + 1)]);
    mark(seq[p], seq[q], { hard: true });
    newEdgePairs.push([seq[p], seq[q]]);
    split++;
  }

  if (!split) {
    return {
      ok: false,
      reason: '這個位置切不出新的線 —— 平面剛好落在既有的邊上，'
            + '那裡本來就已經是斷開的了'
    };
  }

  const pre = preflightRebuild(points, faces);
  if (!pre.ok) return { ok: false, reason: `切下去做出壞掉的網格：${pre.fatal[0]}` };

  const clean = cleanRebuild(points, faces);
  const out = Mesh.fromFaceList(clean.points, clean.faces);
  out.computeNormals();

  const to = i => clean.remap.get(i);
  const di = out._vertIndex();
  const want = new Map();
  for (const [k, m] of marks) {
    const [a, b] = k.split('-').map(Number);
    const x = to(a), y = to(b);
    if (x === undefined || y === undefined) continue;
    want.set(kOf(x, y), m);
  }
  for (const he of out.edges()) {
    out.applyMarks(he, want.get(kOf(di.get(he.v.id), di.get(he.to.id))));
  }

  return {
    ok: true, mesh: out, remap: clean.remap,
    crossed: cross.size, split, pierced, skipped,
    newEdges: newEdgePairs
      .map(([a, b]) => [to(a), to(b)])
      .filter(([a, b]) => a !== undefined && b !== undefined),
    orphans: clean.dropped.orphans
  };
}

// ═══════════════════════════════════════════════════════
//  邊上加點（＝ Blender 的 Subdivide 選一條邊）
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **邊上加點：在選到的邊上放點，什麼都不連。**
 *
 * ── 它補的是一個很具體的洞（kang 2026-08-25 問出來的）──────────
 * > 「是不是還有功能是**可以增加點**..然後再使用多點連接功能?」
 *
 * 現在能加點的四顆按鈕（切一刀／環切／面上加線／內縮導角）
 * **加完都順手把線連掉了**，沒有一顆是「只放一個點，其他什麼都別做」。
 *
 * 🔴 **有了它，「多點連接」才真的自由** —— 在這之前只連得到**既有的角**，
 * 現在可以先把點放到想要的地方，再連。
 *
 * ── ⛔ 刻意不做位置參數 ────────────────────────────────
 * 只給「幾個點」（均分）。要放在特定位置，**加完用「拉點」移過去**。
 * ⭐ 那跟「加線只加線、形狀交給拉點」是同一條分工，
 * 而且 kang 自己示範過（「本來會產生歪的切線..人工拉點後做調整」）。
 *
 * ── ⚠ 這一支會留下「共線的點」，那是刻意的 ──────────────────
 * 方塊頂面加一個點之後是**五邊形**，其中一個角是 180 度。
 * 那在幾何上完全合法（`faceTriangles()` 走耳切，共線點不影響），
 * 但**跟這個專案其他地方的直覺相反** —— 別處都在消滅多餘的點
 * （還原多邊形、`cleanRebuild()` 清孤點）。
 * 🔴 **這裡不可以清掉，那正是使用者要的東西。**
 *
 * ── ⚠ 插點一定會波及鄰面 ─────────────────────────────
 * 跟 `splitFaceByEdges()` 同一條：共用那條邊的面都要跟著加，
 * 否則兩邊的迴圈對不起來。呼叫端要把 `touched` 講出來。
 *
 * @param {Mesh} mesh
 * @param {HalfEdge[]} hes 選到的邊（同一條只算一次）
 * @param {number} cuts 每條邊上加幾個點，均分。1 ＝ 中點
 * @returns {{ok:boolean, reason?:string, mesh?:Mesh, remap?:Map,
 *            newVerts?:number[], edges?:number, touched?:number, orphans?:number}}
 *          `newVerts` ＝ 新加的點在新網格裡的索引，呼叫端拿去選中
 */
export function subdivideEdges(mesh, hes, cuts = 1) {
  if (!mesh || !mesh.faces.length) return { ok: false, reason: '沒有網格' };
  if (!Array.isArray(hes) || !hes.length) return { ok: false, reason: '先選一條邊' };
  cuts = Math.round(cuts);
  if (!(cuts >= 1)) return { ok: false, reason: '至少要加一個點' };

  const vi = mesh._vertIndex();
  const kOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const points = mesh.verts.map(v => v.p.clone());

  /**
   * 每條要加點的邊記一筆。`a`／`b` 記的是**當初的方向**，
   * ⚠ 因為 `ids` 是照 `a → b` 排的，而面的迴圈可能反向走過這條邊。
   */
  const ins = new Map();
  for (const he of hes) {
    if (!he || !he.v || !he.to) continue;
    const a = vi.get(he.v.id), b = vi.get(he.to.id);
    if (a === undefined || b === undefined) {
      return { ok: false, reason: '選到的邊不在這個物件上' };
    }
    const k = kOf(a, b);
    if (ins.has(k)) continue;                 // 同一條邊只加一次
    const len = points[a].distanceTo(points[b]);
    /**
     * ⚠ 判準是**實際距離**，⛔ 不是比例 —— 邊有長有短。
     * 分出來的每一段都要比 `PLANAR_TOL_CM`（0.1mm）長，
     * 否則會長出幾乎零長度的邊，而**體積、面積、χ 全部照樣正確**
     * （坑第 17、25／26 條）。
     */
    if (len / (cuts + 1) < PLANAR_TOL_CM) {
      return {
        ok: false,
        reason: `有一條邊只有 ${len.toFixed(2)} cm，切成 ${cuts + 1} 段之後`
              + `每段不到 ${PLANAR_TOL_CM * 10} mm —— 會長出長度 0 的線`
      };
    }
    const ids = [];
    for (let i = 1; i <= cuts; i++) {
      ids.push(points.length);
      points.push(points[a].clone().lerp(points[b], i / (cuts + 1)));
    }
    ins.set(k, { a, b, ids });
  }
  if (!ins.size) return { ok: false, reason: '沒有選到有效的邊' };

  /** 這條邊上的新點，照「從 `a` 走到 `b`」的順序排好 */
  const along = (a, b) => {
    const rec = ins.get(kOf(a, b));
    if (!rec) return null;
    return rec.a === a ? rec.ids : rec.ids.slice().reverse();
  };

  /**
   * 標記帳本。🔴 **一條邊被切成 `cuts+1` 段，每一段都要繼承** ——
   * 不做的話索引配對落空，**標記會安靜消失**（環切那一輪燒過）。
   */
  const marks = new Map();
  const mark = (a, b, m) => {
    const k = kOf(a, b);
    marks.set(k, Object.assign({}, marks.get(k), m));
  };
  for (const he of mesh.edges()) {
    const a = vi.get(he.v.id), b = vi.get(he.to.id);
    const m = mesh.marksOf(he);
    const mid = along(a, b);
    if (!mid) { mark(a, b, m); continue; }
    const chain = [a, ...mid, b];
    for (let i = 0; i + 1 < chain.length; i++) mark(chain[i], chain[i + 1], m);
  }

  const faces = [];
  let touched = 0;
  for (const f of mesh.faces) {
    const idx = mesh.faceLoop(f).map(he => vi.get(he.v.id));
    const seq = [];
    let hit = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[i], b = idx[(i + 1) % idx.length];
      seq.push(a);
      const mid = along(a, b);
      if (mid) { seq.push(...mid); hit = true; }
    }
    faces.push(seq);
    if (hit) touched++;
  }

  const pre = preflightRebuild(points, faces);
  if (!pre.ok) return { ok: false, reason: `加下去做出壞掉的網格：${pre.fatal[0]}` };

  const clean = cleanRebuild(points, faces);
  const out = Mesh.fromFaceList(clean.points, clean.faces);
  out.computeNormals();

  const to = i => clean.remap.get(i);
  const di = out._vertIndex();
  const want = new Map();
  for (const [k, m] of marks) {
    const [a, b] = k.split('-').map(Number);
    const x = to(a), y = to(b);
    if (x === undefined || y === undefined) continue;
    want.set(kOf(x, y), m);
  }
  for (const he of out.edges()) {
    out.applyMarks(he, want.get(kOf(di.get(he.v.id), di.get(he.to.id))));
  }

  const newVerts = [];
  for (const rec of ins.values()) {
    for (const id of rec.ids) {
      const x = to(id);
      if (x !== undefined) newVerts.push(x);
    }
  }

  return {
    ok: true, mesh: out, remap: clean.remap, newVerts,
    edges: ins.size, touched, orphans: clean.dropped.orphans
  };
}

// ═══════════════════════════════════════════════════════
//  在一個面上拉一條線：那條線必須留在面裡面
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **新拉的那條線有沒有跑到面外面去。**
 *
 * ── ⚠ 這一支是 kang 實測抓出來的，而且症狀很典型 ──────────
 * 2026-08-25：L 形（**凹的**）頂面用「面上加線」，
 * 「線很奇怪」—— 查下去發現不只是難看：
 *
 * > **面積 2200 → 2600，而 `validate()`、χ、體積全部照樣正確。**
 *
 * 線穿出邊界之後，切出來的兩塊是**自交的多邊形**，三角化會把外面那塊
 * 也算進去。⚠ **體積是有號量所以照樣精確**（跟導角那次「只有 `volume()`
 * 是對的」一模一樣）—— 坑第 17 條：**中途的量一直都是對的，末端才錯。**
 *
 * ── ⚠ 我的測試沒抓到，因為樣本全是凸的 ───────────────────
 * 方塊的四邊形、圓柱的 32 邊形 —— **兩個都是凸多邊形**，
 * 而凸多邊形的任兩點連線一定在裡面，那條路根本沒被走到。
 * 🔴 **坑第 17 條又一次**：挑樣本要涵蓋不同的**網格結構**，
 * 而「凸／非凸」是這個專案反覆踩到的那一組
 * 〔扇形三角化那次有 8 個出口，這是同一個病的第 9 個〕。
 * ⛔ 日後任何「在面上拉線」的功能，**L 形那組一定要一起跑**。
 *
 * ── 🔴 為什麼兩支共用一份，不各寫各的 ────────────────────
 * `connectVerts()` 與 `splitFaceByEdges()` 都要問同一個問題。
 * 各寫一份就是「兩個地方各判一次，遲早不一致」（坑第 31 條）——
 * 與其讓兩條路對齊，不如換一個**只有一條路**的定義。
 *
 * ── 判準是兩件事，缺一不可 ───────────────────────────
 * | 檢查 | 擋掉什麼 |
 * |---|---|
 * | 跟其他邊**不可以相交** | 線穿出去又穿回來（中點可能還在裡面）|
 * | **中點必須在多邊形內** | 線整條落在凹口外面（可能完全不相交）|
 *
 * @param {THREE.Vector3[]} loop 這個面的迴圈（**已經插好新點**的版本）
 * @param {number} ia 線的一端在迴圈上的索引
 * @param {number} ib 另一端
 * @returns {boolean} 線是不是整條留在面裡面
 */
function chordInsideFace(loop, ia, ib) {
  const n = loop.length;
  if (n < 4) return true;                    // 三角形沒有對角線可拉

  /** 投影到面自己的平面上：法向用 Newell（對非凸也成立） */
  const nrm = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n];
    nrm.x += (a.y - b.y) * (a.z + b.z);
    nrm.y += (a.z - b.z) * (a.x + b.x);
    nrm.z += (a.x - b.x) * (a.y + b.y);
  }
  if (!(nrm.length() > 1e-12)) return true;  // 退化的面，交給 preflight 去擋
  nrm.normalize();
  const ux = Math.abs(nrm.x) < 0.9 ? new THREE.Vector3(1, 0, 0)
                                   : new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(nrm, ux).normalize();
  const v = new THREE.Vector3().crossVectors(nrm, u);
  const P = loop.map(p => [p.dot(u), p.dot(v)]);

  const A = P[ia], B = P[ib];
  const EPS = 1e-9;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  /** 一、跟其他邊相交就不行（共用端點的那幾條要跳過） */
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    if (i === ia || i === ib || j === ia || j === ib) continue;
    const C = P[i], D = P[j];
    const d1 = cross(A, B, C), d2 = cross(A, B, D);
    const d3 = cross(C, D, A), d4 = cross(C, D, B);
    if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) &&
        ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) return false;
  }

  /** 二、中點要落在多邊形裡面（射線法，⚠ 非凸一定要用這個而不是凸判定） */
  const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = P[i], [xj, yj] = P[j];
    if ((yi > my) !== (yj > my) &&
        mx < (xj - xi) * (my - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 兩支共用的那句話 —— ⛔ 訊息也只寫一次（坑第 31 條） */
const OUTSIDE_REASON =
  '這條線會跑到面的外面 —— 那個面是凹的（像 L 形），'
  + '兩頭之間的直線穿出了邊界。換一組位置，讓線整條留在面裡面';

// ═══════════════════════════════════════════════════════
//  連接兩點（Connect Vertex Pairs）
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **連接兩點：在一個面上選兩個角，中間長出一條線，把那個面切成兩塊。**
 *
 * ── 它是「加線 × 兩個既有頂點」──────────────────────────
 * 四動作框架（加線／加面／移除／移動）的**第四個**案例，而且是最便宜的一個：
 * 環切是「加線 × 一圈邊」、內縮是「加線 × 面的內縮輪廓」、
 * 切一刀是「加線 × 平面」，這一支是「加線 × 兩個既有頂點」。
 *
 * ⭐ **它比 `bisect()` 還簡單** —— `bisect()` 要先算平面跟每條邊的交點、
 * 插新點，這一支的兩個端點**使用者直接給，本來就存在**。
 * 骨架其餘部分逐項對應（帳本 → `preflightRebuild` → `cleanRebuild` →
 * `applyMarks`），**沒有開任何新的重建路徑**。
 *
 * 🔴 **只加線，體積與面積精確不變**，而且**頂點數也不變**
 * （環切、內縮、切一刀都會加點，只有這一支不會）。
 *
 * ── 🔴 它是 Blender 的 Connect Vertex **Pairs**，不是 Path ────────
 * ⚠ **`外部參考-Blender編輯.md` 第 10.1 節把這兩個的名字寫反了**
 * （2026-08-25 讀官方手冊內文才發現，該節已修正）。正確的是：
 *
 * | | 行為 |
 * |---|---|
 * | **Connect Vertex Pairs**（＝這一支）| 只連**共用同一個面**的兩個點，把那個面切成兩半 |
 * | **Connect Vertex Path（J）** | **跨多個面**，依選取順序沿路徑切開 —— **還沒做** |
 *
 * ⛔ 擋下來的訊息**不可以**叫使用者「換個方式選」去做跨面的事 ——
 * 那條路現在不存在，寫了就是坑第 34 條（指一條不存在的退路）。
 *
 * ── 新的那條線要標 `hard` ─────────────────────────────
 * 切開的兩半是**共面**的，而全域規則是「共面的邊 ＝ 看不見的邊」。
 * 不標 `hard` 的話四個出口全中（畫不出來、點不到、半塊面拉不動、
 * 按壓平被併掉），這顆按鈕按下去畫面上什麼都不會變（坑第 21 條）。
 *
 * ── ⚠ 三種擋下來的情形，每一種都要講原因（坑第 11 條）────────
 * | 情形 | 為什麼擋 |
 * |---|---|
 * | 兩個點**不在同一個面**上 | 那是 Path 要做的事，還沒做 |
 * | 兩個點在那個面上**相鄰** | 它們之間**本來就有一條邊**了 |
 * | 兩個點**同時在好幾個面**上 | 連下去會長出兩條一模一樣的線 ＝ 非流形。
 *   ⚠ 這種形狀罕見，但**結果不唯一就不要猜**（坑第 24 條）|
 *
 * @param {Mesh} mesh
 * @param {Vertex} vA 第一個點
 * @param {Vertex} vB 第二個點
 * @returns {{ok:boolean, reason?:string, mesh?:Mesh, remap?:Map,
 *            newEdges?:Array, orphans?:number}}
 *          `newEdges` ＝ 新長出來的那條線（一條），呼叫端拿它去自動選中
 */
export function connectVerts(mesh, vA, vB) {
  if (!mesh || !mesh.faces.length) return { ok: false, reason: '沒有網格' };
  if (!vA || !vB) return { ok: false, reason: '要選兩個點' };
  if (vA === vB) return { ok: false, reason: '選到的是同一個點，連不出線' };

  const vi = mesh._vertIndex();
  const ia = vi.get(vA.id), ib = vi.get(vB.id);
  if (ia === undefined || ib === undefined) {
    return { ok: false, reason: '選到的點不在這個物件上' };
  }

  /**
   * 🔴 **相鄰要最先擋，而且判準是「有沒有邊」，不是迴圈上的位置。**
   *
   * ⚠ **順序錯了訊息就會說謊**（2026-08-25 沙箱實測抓到）：相鄰的兩個點
   * 本來就同時屬於**兩個**面（共用那條邊的左右兩片），所以底下那個
   * 「同時在好幾個面上」的檢查會**先觸發**，使用者被指去想面的問題，
   * 而真正的原因是「**這兩點之間本來就有線**」。
   * 〔坑第 34 條：不要給一個不存在的方向。導角那一輪才剛犯過同一個病〕
   */
  for (const he of mesh.edges()) {
    const a = vi.get(he.v.id), b = vi.get(he.to.id);
    if ((a === ia && b === ib) || (a === ib && b === ia)) {
      return {
        ok: false,
        reason: '這兩個點是相鄰的，它們之間本來就已經有一條線了'
      };
    }
  }

  /**
   * 找「迴圈上同時有這兩個點」的面。
   * ⚠ **要全部走完，不可以找到第一個就跳出** —— 找到兩個以上得擋下來，
   * 而「只切第一個找到的」會讓結果取決於面的儲存順序（坑第 24 條）。
   */
  const cands = [];
  for (const f of mesh.faces) {
    const idx = mesh.faceLoop(f).map(he => vi.get(he.v.id));
    const p = idx.indexOf(ia), q = idx.indexOf(ib);
    if (p < 0 || q < 0) continue;
    cands.push({ f, idx, lo: Math.min(p, q), hi: Math.max(p, q) });
  }

  if (!cands.length) {
    return {
      ok: false,
      reason: '這兩個點不在同一個面上 —— 這一顆只能在一個面裡面連，'
            + '跨過好幾個面的那一種還沒做'
    };
  }
  if (cands.length > 1) {
    return {
      ok: false,
      reason: `這兩個點同時在 ${cands.length} 個面上，連下去會長出兩條重疊的線`
    };
  }

  const { f: target, idx: loop, lo, hi } = cands[0];
  const n = loop.length;

  /**
   * ⚠ **保險絲**：切下去會生出一個只有兩個點的面，而 `fromFaceList()`
   * 會**直接跳過**少於 3 點的面 —— 靜默掉一個面，形狀就破了。
   * 〔這一段跟 `bisect()` 的 `q - p < 2` 是同一條規則〕
   *
   * ⚠ 上面「有沒有邊」那一關**正常情況下已經擋掉全部**，走到這裡代表
   * 網格處於「面的迴圈上相鄰、卻沒有對應的邊」的壞狀態。
   * ⛔ 留著不要拿掉，但**訊息要跟上面那則分得出來** —— 兩者的成因不同。
   */
  if (hi - lo < 2 || n - (hi - lo) < 2) {
    return {
      ok: false,
      reason: '這兩個點在這個面上是連著的，中間切不出東西'
    };
  }

  /**
   * 🔴 **凹的面（L 形）上，兩個角之間的直線可能穿出邊界。**
   * 不擋的話面積會算多，而 χ、`validate()`、體積**全部照樣正確**
   * （坑第 17 條）。見 `chordInsideFace()` 檔頭。
   */
  if (!chordInsideFace(loop.map(i => mesh.verts[i].p), lo, hi)) {
    return { ok: false, reason: OUTSIDE_REASON };
  }

  const points = mesh.verts.map(v => v.p.clone());
  const kOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  /**
   * 標記帳本，記在**重建前**的索引空間，最後透過 `remap` 一次搬過去。
   * ⭐ 這一支不插新點，所以**沒有「一條邊被切成兩段」的問題**
   * （那正是 `bisect()` 與 `loopCut()` 各自記一本帳的理由）——
   * 既有的邊逐條原樣搬過去就好。
   * 🔴 整包讀（`marksOf()`），⛔ 不要手寫「有哪幾樣」。
   */
  const marks = new Map();
  for (const he of mesh.edges()) {
    marks.set(kOf(vi.get(he.v.id), vi.get(he.to.id)), mesh.marksOf(he));
  }
  marks.set(kOf(ia, ib), Object.assign({}, marks.get(kOf(ia, ib)), { hard: true }));

  const faces = [];
  for (const f of mesh.faces) {
    const idx = f === target ? loop : mesh.faceLoop(f).map(he => vi.get(he.v.id));
    if (f !== target) { faces.push(idx); continue; }
    faces.push(idx.slice(lo, hi + 1));
    faces.push([...idx.slice(hi), ...idx.slice(0, lo + 1)]);
  }

  const pre = preflightRebuild(points, faces);
  if (!pre.ok) return { ok: false, reason: `連下去做出壞掉的網格：${pre.fatal[0]}` };

  const clean = cleanRebuild(points, faces);
  const out = Mesh.fromFaceList(clean.points, clean.faces);
  out.computeNormals();

  const to = i => clean.remap.get(i);
  const di = out._vertIndex();
  const want = new Map();
  for (const [k, m] of marks) {
    const [a, b] = k.split('-').map(Number);
    const x = to(a), y = to(b);
    if (x === undefined || y === undefined) continue;
    want.set(kOf(x, y), m);
  }
  for (const he of out.edges()) {
    out.applyMarks(he, want.get(kOf(di.get(he.v.id), di.get(he.to.id))));
  }

  const na = to(ia), nb = to(ib);
  return {
    ok: true, mesh: out, remap: clean.remap,
    newEdges: (na !== undefined && nb !== undefined) ? [[na, nb]] : [],
    orphans: clean.dropped.orphans
  };
}

/**
 * 🔴 **多點連接：選好幾個點，依照選的順序一段一段連起來。**
 *
 * ── 它就是 `connectVerts()` 跑好幾次 ─────────────────────
 * ⭐ **兩個點的時候行為跟以前完全一樣**（迴圈只跑一次），
 * 所以舊行為是**結構保證**，不是靠測試盯著。
 *
 * ── 🔴 為什麼一定要「依序、一段一段」，不能一次算完 ──────────
 * **切完第一段，面就變了。** L 形頂面選四個點連三段：
 * 第一段切下去之後頂面裂成兩塊，第二段的兩個點可能**分屬不同塊** ——
 * 拿原本那個面去算第二段一定錯。
 * → 每一段都在**上一段的結果**上重新找面。
 *
 * ── ⚠ 每切一次，頂點物件就換了一批 ──────────────────────
 * `connectVerts()` 走的是「拆掉重建」，回來的是**新的網格**，
 * 舊的 `Vertex` 物件全部作廢。所以還沒用到的點要靠 `remap`
 * （舊索引 → 新索引）搬過去，⛔ 不可以抓著舊的物件不放。
 * 〔這正是 `remapElements()` 存在的理由，只是這裡搬的是索引不是選取〕
 *
 * ── ⚠ Blender 的 Connect Vertex Path 還有一半我們不做 ────────
 * 官方原文：只選兩個點時「會**切過沒被選到的面**…限制在相連的面上做直線切」。
 * 🔴 **那一半沒做，而且是刻意的**：方塊選頂面一個角、底面另一頭的角，
 * 那條線要從側面的哪裡通過 —— 繞左、繞右、斜著過去**都說得通**，
 * **結果不唯一就不要猜**（坑第 24 條）。
 * ⭐ 真要跨面切，「刀具」（畫面上手畫）才是誠實的答案 —— 畫到哪切到哪。
 *
 * @param {Mesh} mesh
 * @param {Vertex[]} verts 依選取順序的點，至少兩個
 * @returns {{ok:boolean, reason?:string, mesh?:Mesh, remap?:Map,
 *            newEdges?:Array, segments?:number, orphans?:number}}
 */
export function connectVertsPath(mesh, verts) {
  if (!mesh || !mesh.faces.length) return { ok: false, reason: '沒有網格' };
  if (!Array.isArray(verts) || verts.length < 2) {
    return { ok: false, reason: '至少要選兩個點' };
  }

  const vi0 = mesh._vertIndex();
  const idx = verts.map(v => (v ? vi0.get(v.id) : undefined));
  if (idx.some(i => i === undefined)) {
    return { ok: false, reason: '選到的點不在這個物件上' };
  }
  for (let i = 1; i < idx.length; i++) {
    if (idx[i] === idx[i - 1]) return { ok: false, reason: '連續選到了同一個點' };
  }

  let cur = mesh;
  let at = idx.slice();                 // 這些點在「目前這個網格」裡的索引
  let done = [];                        // 已經連好的線，同樣要跟著搬
  let orphans = 0;
  /**
   * ⚠ **完整的對照要一路串下去**（原網格的每個索引 → 目前網格）。
   * ⛔ 不可以只回最後一段的 remap，也不可以只放選取的那幾個點 ——
   * 這個欄位的名字承諾的是完整對照，給半套就是「寫一個不存在的退路」
   * （坑第 34 條）。
   */
  let chain = new Map(cur.verts.map((_, i) => [i, i]));

  for (let s = 0; s + 1 < at.length; s++) {
    const r = connectVerts(cur, cur.verts[at[s]], cur.verts[at[s + 1]]);
    if (!r.ok) {
      /**
       * ⚠ **要講出是第幾段卡住的。** 選了五個點只講「不在同一個面上」，
       * 使用者不知道是哪一段的問題（坑第 20 條的近親：畫面上數不出來）。
       */
      return {
        ok: false,
        reason: at.length > 2 ? `第 ${s + 1} 段連不起來：${r.reason}` : r.reason
      };
    }
    const mv = i => r.remap.get(i);
    at = at.map(mv);
    done = done.map(([a, b]) => [mv(a), mv(b)]).concat(r.newEdges);
    chain = new Map([...chain]
      .map(([o, c]) => [o, mv(c)])
      .filter(([, c]) => c !== undefined));
    orphans += r.orphans || 0;
    cur = r.mesh;
  }

  return {
    ok: true, mesh: cur, remap: chain,
    newEdges: done.filter(([a, b]) => a !== undefined && b !== undefined),
    segments: at.length - 1, orphans
  };
}

// ═══════════════════════════════════════════════════════
//  面上加線（＝ Blender 的 Subdivide 選兩條邊）
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **面上加線：選一個面上的兩條邊，在邊上各長出一個點，連起來把面切成兩塊。**
 *
 * ── 為什麼它跟「連接兩點」是兩顆按鈕（kang 2026-08-25 拍板）──────
 * > 「我是認為分成兩顆按鈕..畢竟**效果呈現不同**」
 *
 * | | 連的是 | 切出來 |
 * |---|---|---|
 * | **連接兩點** | 兩個**既有的角** | 方塊頂面 → 兩個三角形 |
 * | **面上加線**（這一支）| 兩條邊上**新長出來的點** | 方塊頂面 → 兩個矩形 |
 *
 * ⭐ **kang 原本以為「連接兩點」就是這個** —— 他要的是「讓面變成兩等分」。
 * 那一顆做不到，因為**邊的中間本來沒有點**。這一支就是去長那個點。
 *
 * ── 🔴 `t` 的方向：第二條邊一定要反過來算 ────────────────
 * 兩條邊在面的迴圈上是**繞著走**的，所以「各自的 0.3」會落在**對角** ——
 * 切出來是一條**斜線**，不是使用者要的平行線。
 *
 * > **A 上取 `t`、B 上取 `1 − t`。**
 *
 * `t = 0.5` 時兩端對稱，怎麼算都一樣（那就是「兩等分」）；
 * 其餘的值才看得出差別。
 * 🔴 **機械斷言**：`t=0.5` 兩塊面積**必須完全相等**，`t=0.3` 必須是 3:7 ——
 * 那是「真的平行」唯一驗得出來的方式（斜線的比例會不對）。
 * 〔鐵律三：讓兩個數字互相對得起來，錯誤才會自己現形〕
 *
 * ── 🔴 插點會波及相鄰的面，而且**必須**波及 ────────────────
 * 一條邊被插了點，**共用那條邊的另一個面也要跟著加**，否則兩邊的迴圈
 * 對不起來 —— 那不是「順便」，是不做就會破洞。
 * ⚠ 所以方塊頂面加一條線，**側面會從四邊形變成五邊形**，
 * 畫面上看得到多一條短線。那是對的，呼叫端要講出來（坑第 21 條）。
 *
 * ── ⚠ `t` 太靠近端點要擋 ─────────────────────────────
 * 插的點離既有頂點比 `PLANAR_TOL_CM`（0.1mm）還近的話，
 * 會長出一條**零長度的邊**，而**體積、面積、χ 全部照樣正確**，
 * 只有 `validate()` 或日後的布林會露餡（坑第 17 條、25／26 條）。
 * 判準用**實際距離**，⛔ 不要用比例的絕對值 —— 邊有長有短。
 *
 * @param {Mesh} mesh
 * @param {HalfEdge} heA 第一條邊
 * @param {HalfEdge} heB 第二條邊
 * @param {number} t 位置比例，0.5 ＝ 中點（預設）
 * @returns {{ok:boolean, reason?:string, mesh?:Mesh, remap?:Map,
 *            newEdges?:Array, touched?:number, orphans?:number}}
 *          `touched` ＝ 被順帶加點的**相鄰**面數，呼叫端要講出來
 */
export function splitFaceByEdges(mesh, heA, heB, t = 0.5) {
  if (!mesh || !mesh.faces.length) return { ok: false, reason: '沒有網格' };
  if (!heA || !heB) return { ok: false, reason: '要選兩條邊' };
  if (!(t > 0 && t < 1)) {
    return { ok: false, reason: '位置要在 0 跟 1 中間（0.5 ＝ 正中間）' };
  }

  const vi = mesh._vertIndex();
  const kOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const kA = kOf(vi.get(heA.v.id), vi.get(heA.to.id));
  const kB = kOf(vi.get(heB.v.id), vi.get(heB.to.id));
  if (kA === kB) return { ok: false, reason: '選到的是同一條邊' };

  /**
   * 找「迴圈上同時有這兩條邊」的面。
   * ⚠ 全部走完，找到兩個以上要擋 —— 只切第一個會讓結果取決於儲存順序
   * （坑第 24 條）。〔跟 `connectVerts()` 同一條〕
   */
  const cands = [];
  for (const f of mesh.faces) {
    const idx = mesh.faceLoop(f).map(he => vi.get(he.v.id));
    let pa = -1, pb = -1;
    for (let i = 0; i < idx.length; i++) {
      const k = kOf(idx[i], idx[(i + 1) % idx.length]);
      if (k === kA) pa = i;
      if (k === kB) pb = i;
    }
    if (pa < 0 || pb < 0) continue;
    cands.push({ f, idx, pa, pb });
  }

  if (!cands.length) {
    return { ok: false, reason: '這兩條邊不在同一個面上 —— 這一顆只能在一個面裡面加線' };
  }
  if (cands.length > 1) {
    return { ok: false, reason: `這兩條邊同時在 ${cands.length} 個面上，加下去會長出兩條重疊的線` };
  }

  const { f: target, idx: loop, pa, pb } = cands[0];
  const points = mesh.verts.map(v => v.p.clone());

  /**
   * 兩個新點的位置。**方向以目標面的迴圈為準**（`idx[i] → idx[i+1]`），
   * 第二條取 `1 − t` —— 見檔頭那一段。
   */
  const mk = (i, s) => {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const pa2 = points[a], pb2 = points[b];
    const len = pa2.distanceTo(pb2);
    if (!(len > 0)) return { err: '這條邊的長度是 0' };
    if (len * s < PLANAR_TOL_CM || len * (1 - s) < PLANAR_TOL_CM) {
      return { err: `位置太靠近邊的端點了（這條邊只有 ${len.toFixed(2)} cm，`
                  + `${PLANAR_TOL_CM * 10} mm 以內會長出一條長度 0 的線）` };
    }
    return { p: pa2.clone().lerp(pb2, s) };
  };

  const ra = mk(pa, t), rb = mk(pb, 1 - t);
  if (ra.err) return { ok: false, reason: ra.err };
  if (rb.err) return { ok: false, reason: rb.err };

  const newIdx = new Map();               // 邊 key → 新點的索引
  newIdx.set(kA, points.length); points.push(ra.p);
  newIdx.set(kB, points.length); points.push(rb.p);
  const iA = newIdx.get(kA), iB = newIdx.get(kB);

  /**
   * 目標面插好點之後的迴圈 —— 先拿它問一次「這條線跑不跑得出去」。
   *
   * 🔴 **凹的面（L 形）上這是真的會發生的**，而且不擋的話面積會算多，
   * 同時 χ、`validate()`、體積**全部照樣正確**（坑第 17 條）。
   * 見 `chordInsideFace()` 檔頭 —— 那是 kang 2026-08-25 實測抓到的。
   */
  {
    const seq = [], on = [];
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      seq.push(a);
      const mid = newIdx.get(kOf(a, b));
      if (mid !== undefined) { on.push(seq.length); seq.push(mid); }
    }
    on.sort((x, y) => x - y);
    if (!chordInsideFace(seq.map(i => points[i]), on[0], on[1])) {
      return { ok: false, reason: OUTSIDE_REASON };
    }
  }

  /**
   * 標記帳本。🔴 **一條邊被插點就變成兩段，兩段都要繼承** ——
   * 不做的話索引配對落空，**標記會安靜消失**（環切那一輪燒過）。
   */
  const marks = new Map();
  const mark = (a, b, m) => {
    const k = kOf(a, b);
    marks.set(k, Object.assign({}, marks.get(k), m));
  };
  for (const he of mesh.edges()) {
    const a = vi.get(he.v.id), b = vi.get(he.to.id);
    const m = mesh.marksOf(he);
    const mid = newIdx.get(kOf(a, b));
    if (mid === undefined) { mark(a, b, m); continue; }
    mark(a, mid, m);
    mark(mid, b, m);
  }
  mark(iA, iB, { hard: true });           // 新長出來的那條線

  /**
   * 重建。**每個面都要走一次插點**（不只目標面）——
   * 共用那條邊的鄰面不跟著加點的話，兩邊的迴圈就對不起來了。
   */
  const faces = [];
  let touched = 0;
  for (const f of mesh.faces) {
    const idx = f === target ? loop : mesh.faceLoop(f).map(he => vi.get(he.v.id));
    const seq = [];
    let onIdx = [];
    for (let i = 0; i < idx.length; i++) {
      const a = idx[i], b = idx[(i + 1) % idx.length];
      seq.push(a);
      const mid = newIdx.get(kOf(a, b));
      if (mid !== undefined) { onIdx.push(seq.length); seq.push(mid); }
    }
    if (f !== target) {
      faces.push(seq);
      if (onIdx.length) touched++;        // 順帶加了點的鄰面
      continue;
    }
    const [p, q] = onIdx.sort((x, y) => x - y);
    faces.push(seq.slice(p, q + 1));
    faces.push([...seq.slice(q), ...seq.slice(0, p + 1)]);
  }

  const pre = preflightRebuild(points, faces);
  if (!pre.ok) return { ok: false, reason: `加下去做出壞掉的網格：${pre.fatal[0]}` };

  const clean = cleanRebuild(points, faces);
  const out = Mesh.fromFaceList(clean.points, clean.faces);
  out.computeNormals();

  const to = i => clean.remap.get(i);
  const di = out._vertIndex();
  const want = new Map();
  for (const [k, m] of marks) {
    const [a, b] = k.split('-').map(Number);
    const x = to(a), y = to(b);
    if (x === undefined || y === undefined) continue;
    want.set(kOf(x, y), m);
  }
  for (const he of out.edges()) {
    out.applyMarks(he, want.get(kOf(di.get(he.v.id), di.get(he.to.id))));
  }

  const na = to(iA), nb = to(iB);
  return {
    ok: true, mesh: out, remap: clean.remap, touched,
    newEdges: (na !== undefined && nb !== undefined) ? [[na, nb]] : [],
    orphans: clean.dropped.orphans
  };
}

// ═══════════════════════════════════════════════════════
//  內縮（Inset）
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **內縮：沿著一個面的外緣往面內長出一圈新的邊。**
 *
 * ── 它是「加線」，不是新功能 ──────────────────────────
 * ⭐ **這一支沒有一行新的數學**：
 * miter 是 `mesh.js` `shell()` 現成的、外緣是 `boundaryLoops()`、
 * 重建是 `fromFaceList()`、新邊標 `hard` 是環切那一輪定的規則。
 *
 * 它是「**加線 × 面的內縮輪廓**」—— 2026-08-25 kang 批准的四動作框架
 * （加線／加面／移除／移動）的第一個試金石，而且**框架成立**。
 *
 * 🔴 **只加線，形狀一格都不變** —— 體積與面積**精確不變**，
 * 那是可以對答案的（跟環切同一條斷言）。要凹下去是下一步「拉面」的事。
 *
 * ── 為什麼不做 Blender 的 Depth（內縮同時往法向推）────────
 * kang 2026-08-25 選的，**跟擠出的方案 C 同一個形狀**：
 * 內縮只負責加線 → **內圈那個新面自動選中** → 用已經驗過的
 * 「拉面 × 法向」推到想要的深度（還可以打精確數字）。
 * **一個動作一件事，零行新程式**，而凹槽、面板開口、邊框全都做得出來。
 *
 * ── 🔴 miter：只推角平分線會不夠寬 ────────────────────
 * 沿角平分線推 d，實際牆距只有 `d × cos(半夾角)` ——
 * **方塊頂面內縮 5，實測只有 3.5355**（＝5×cos45°）。
 * 除以 cos 之後是 **5.0000**，精確。
 * 上限 5 倍：夾角接近 180 度時 cos 趨近 0，推距會爆掉（`shell()` 的老規矩）。
 *
 * ── ⚠ 多個迴圈的區域照樣可以內縮 ──────────────────────
 * 管的端面是**環形**（外圈 ＋ 內孔），兩個迴圈各自往「面內」推 ——
 * 而「面內」的方向由 `n × 邊方向` 決定，外圈往內、內孔往外，
 * **同一條公式自己就對了**，不必分開判斷（實測 χ 仍是 0）。
 * 〔對照：`mergeCoplanarFaces()` 遇到多迴圈是**跳過**的，因為一個面
 * 　裝不下兩個迴圈；內縮不受這個限制，它不合併面〕
 *
 * @param {Mesh} mesh
 * @param {Face} face 選到的那個面（會自動擴成整個共面區域）
 * @param {number} w 內縮寬度，cm
 * @returns {{ok:boolean, reason?:string, mesh?:Mesh, remap?:Map,
 *            loops?:number, ring?:number, innerFace?:Face}}
 *          `innerFace` ＝ 內縮之後**內圈**那個面，呼叫端拿它去自動選中
 */
export function insetFaces(mesh, face, w, tolDeg = 0.5) {
  if (!mesh || !face) return { ok: false, reason: '沒有選到面' };
  if (!(w > 0)) return { ok: false, reason: '內縮寬度要大於 0' };

  mesh.computeNormals();
  const reg = regionOf(mesh, face, tolDeg);
  if (!reg.faces.length) return { ok: false, reason: '找不到這個面所屬的共面區域' };

  const loops = boundaryLoops(mesh, reg.faces);
  if (!loops.length) {
    return { ok: false, reason: '這個面走不出完整的外緣（區域可能在某個頂點上捏成一點）' };
  }

  const vi = mesh._vertIndex();
  const points = mesh.verts.map(v => v.p.clone());
  const n = face.normal.clone().normalize();
  const inner = new Map();          // 舊頂點索引 → 內圈新頂點索引
  const ringPairs = [];
  let clamped = 0;

  /** 一條邊在面內「往面內」的方向 ＝ 面法向 × 邊方向（左手邊就是內側） */
  const dirIn = he => {
    const d = new THREE.Vector3().subVectors(he.to.p, he.v.p).normalize();
    return new THREE.Vector3().crossVectors(n, d).normalize();
  };

  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const cur = loop[i], prv = loop[(i - 1 + loop.length) % loop.length];
      const a = vi.get(cur.v.id);
      if (inner.has(a)) continue;              // 同一個頂點只做一次
      const i1 = dirIn(cur), i2 = dirIn(prv);
      const bis = i1.clone().add(i2);
      let p;
      if (bis.lengthSq() < 1e-16) {
        p = cur.v.p.clone().addScaledVector(i1, w);      // 兩條邊剛好反向（退化）
      } else {
        bis.normalize();
        const cos = bis.dot(i1);
        if (cos < 0.2) clamped++;                        // 上限 5 倍，跟 shell() 同一個規矩
        p = cur.v.p.clone().addScaledVector(bis, w / Math.max(cos, 0.2));
      }
      inner.set(a, points.length);
      points.push(p);
    }
  }

  const inSet = new Set(reg.faces);
  const faces = [];
  for (const f of mesh.faces) {
    const idx = mesh.faceVerts(f).map(v => vi.get(v.id));
    // 區域內的面：外緣上的頂點換成內圈的；區域外的面一個字都不動
    faces.push(inSet.has(f) ? idx.map(i => (inner.has(i) ? inner.get(i) : i)) : idx);
  }
  for (const loop of loops) {
    for (const he of loop) {
      const a = vi.get(he.v.id), b = vi.get(he.to.id);
      faces.push([a, b, inner.get(b), inner.get(a)]);     // 一圈側面
      ringPairs.push([inner.get(a), inner.get(b)]);
    }
  }

  const pre = preflightRebuild(points, faces);
  if (!pre.ok) return { ok: false, reason: `內縮做出壞掉的網格：${pre.fatal[0]}` };

  const clean = cleanRebuild(points, faces);
  const out = Mesh.fromFaceList(clean.points, clean.faces);
  out.computeNormals();
  copyMarksThroughRemap(mesh, out, clean.remap);

  /**
   * 🔴 **新的一圈一定要標 `hard`。**
   * 它是**共面**的（就在原本那個面的平面上），而這個專案的規則是
   * 「共面的邊 ＝ 畫面上看不見的邊 ＝ 不該存在的邊」——
   * 不標的話**畫面上看不見、點不到、內圈那個面選不動、按壓平就被併回去**。
   * 〔環切那一輪的教訓，四個出口見 `HalfEdge.hard` 的說明〕
   */
  const to = i => clean.remap.get(i);
  const di = out._vertIndex();
  const kOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const want = new Set();
  for (const [a, b] of ringPairs) {
    const x = to(a), y = to(b);
    if (x !== undefined && y !== undefined) want.add(kOf(x, y));
  }
  let ring = 0;
  for (const he of out.edges()) {
    if (!want.has(kOf(di.get(he.v.id), di.get(he.to.id)))) continue;
    out.setHard(he, true);
    ring++;
  }

  /** 內圈那個面：拿「原本區域的第一個面，頂點換成內圈之後」去找回來 */
  let innerFace = null;
  {
    const wantSet = new Set();
    for (const v of mesh.faceVerts(reg.faces[0])) {
      const i = vi.get(v.id);
      const j = to(inner.has(i) ? inner.get(i) : i);
      if (j !== undefined) wantSet.add(j);
    }
    for (const f of out.faces) {
      const s = new Set(out.faceVerts(f).map(v => di.get(v.id)));
      if (s.size !== wantSet.size) continue;
      let same = true;
      for (const k of wantSet) if (!s.has(k)) { same = false; break; }
      if (same) { innerFace = f; break; }
    }
  }

  return {
    ok: true, mesh: out, remap: clean.remap,
    loops: loops.length, ring, clamped, innerFace
  };
}

/**
 * 🔴 **把「假邊界」帶進來的 CUT 清掉。**
 *
 * `mesh.js` 的 `_buildBoundaryLoops()` 有一條規則：**邊界天生就是切割線**，
 * 所以沒有 twin 的半邊會自動被標成 `CUT`。**那條規則本身是對的。**
 *
 * 但有兩種情況，那些邊只是**暫時**是邊界：
 *
 * | 情況 | 誰造成的 |
 * |---|---|
 * | 繞向不一致 → twin 配不起來 → 被當成邊界 | `recalcNormalsOutside()` 修好之後它們變回內部邊 |
 * | 刪掉一個面留下的洞 → 邊界 | `fillHoles()` 補回去之後它們變回內部邊 |
 *
 * 兩種情況下 CUT 都已經跟著搬進成品了 ——
 * **症狀是畫面上憑空多出幾條分片線，而使用者從來沒標過。**
 *
 * ⚠ **只清「原本是邊界、現在變成內部」的那些。**
 * 真正的邊界（開放的殼）照樣該是 CUT；使用者自己標的也不會落進這個集合
 * （他標的在原網格上是內部邊）。
 *
 * @returns {number} 清掉幾條
 */
function clearBoundaryOnlySeams(src, dst, remap) {
  const si = src._vertIndex(), di = dst._vertIndex();
  const key = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;
  const to = i => (remap ? remap.get(i) : i);

  const wasBoundary = new Set();
  for (const he of src.halfEdges) {
    if (he.face && he.twin && he.twin.face) continue;       // 原本就是內部邊
    const a = to(si.get(he.v.id)), b = to(si.get(he.to.id));
    if (a !== undefined && b !== undefined) wasBoundary.add(key(a, b));
  }
  if (!wasBoundary.size) return 0;

  let n = 0;
  for (const he of dst.edges()) {
    if (!he.face || !he.twin || !he.twin.face) continue;     // 現在還是邊界 → 該留著
    if (he.role !== EDGE_ROLE.CUT) continue;
    if (wasBoundary.has(key(di.get(he.v.id), di.get(he.to.id)))) {
      dst.setRole(he, EDGE_ROLE.FREE);
      n++;
    }
  }
  return n;
}

// ═══════════════════════════════════════════════════════
//  刪除面 ／ 補洞（一對）
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **刪除面：把選到的面拿掉，那裡就變成一個洞。**
 *
 * ── 它跟「補洞」是一對，不是先後 ──────────────────────
 * 沒有刪除面就做不出洞，沒有補洞就補不回去。所以兩個一起做。
 * 〔原本排的順序是「補面先做，因為它是刪除面的前提」——**那個說法有問題**：
 * 　補洞當時根本沒有輸入。是 kang 2026-08-25 問「不懂意思」才發現的〕
 *
 * ⚠ **一個面 ＝ 共面區域**（鐵律二）。點方塊的頂面刪掉的是那一整片，
 * 不是命中的那一個三角形。
 *
 * ⚠ **會產生孤點** —— 實測「刪一個角落周圍的三個面」會留下 1 個孤點
 * （那個角只被那三個面用著）。`cleanRebuild()` 清掉，索引會位移，
 * 所以標記一定要走 remap 搬。
 *
 * ⚠ **代價要講清楚**：網格會變**開放** → 不能再做布林（`canBool` 擋開放件），
 * 展開與 STL 的行為也會變。呼叫端負責講。
 *
 * @returns {{ok:boolean, reason?:string, mesh?:Mesh, remap?:Map,
 *            removed?:number, orphans?:number, wasClosed?:boolean, nowClosed?:boolean}}
 */
export function deleteFaces(mesh, els, tolDeg = 0.5) {
  const list = (Array.isArray(els) ? els : [els]).filter(Boolean);
  if (!mesh || !list.length) return { ok: false, reason: '沒有選到面' };

  const drop = new Set();
  for (const el of list) {
    if (el.kind !== 'face' || !el.face) return { ok: false, reason: '只能刪除「面」' };
    for (const f of regionOf(mesh, el.face, tolDeg).faces) drop.add(f);
  }
  /**
   * ⚠ **不能把面刪光** —— 那會留下一個沒有任何面的「物件」，
   * 而畫面上什麼都沒有、參數面板還在，看起來像壞掉。
   * 要刪整個物件有工具列那顆「刪除」。〔坑第 11 條：擋下來要講清楚出路〕
   */
  if (drop.size >= mesh.faces.length) {
    return {
      ok: false,
      reason: `那樣會把整個物件的面刪光（${drop.size}/${mesh.faces.length} 個）。`
            + `要刪掉整個物件請用工具列的「刪除」`
    };
  }

  const wasClosed = mesh.isClosed();
  const vi = mesh._vertIndex();
  const points = mesh.verts.map(v => v.p.clone());
  const faces = mesh.faces.filter(f => !drop.has(f))
                          .map(f => mesh.faceVerts(f).map(v => vi.get(v.id)));

  const pre = preflightRebuild(points, faces);
  if (!pre.ok) return { ok: false, reason: `刪出壞掉的網格：${pre.fatal[0]}` };

  /**
   * 🔴 **擋掉「洞在一個頂點上捏在一起」的情形。**
   *
   * ── 這是 `mesh.js` 的一個既有限制，不是這一支的問題 ──────
   * `_buildBoundaryLoops()` 用一個 **`頂點 → 邊界半邊` 的 Map** 把邊界串成迴圈，
   * 所以**一個頂點只放得下一條**。刪掉的面如果**只在一個頂點相接**，
   * 那個頂點會同時落在兩個洞的邊界上 → Map 被覆蓋 → **迴圈斷掉**。
   * 〔`mesh.js` 自己也知道，那裡寫著 `邊界迴圈在頂點 N 斷開` 這個 issue〕
   *
   * 實測（2026-08-25 壓力測試）：球 seg8 隨機刪 4 個面就會踩到 ——
   * `半邊 X 沒有 next`、χ −2、結構壞掉。
   *
   * ⚠ **判準**：一個頂點上「只被用到一次的邊」超過 2 條，就是有兩個洞
   * 從它身上穿過（一個洞經過一個頂點只會貢獻 2 條）。
   *
   * ⛔ **不要在這裡偷偷改 `mesh.js`** —— 那是核心，而且這一題有獨立的解
   * （讓邊界迴圈支援「一個頂點多條」）。先擋下來並講清楚，記進待辦。
   */
  {
    const use = new Map();          // 無向邊 → 用了幾次
    const kOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
    for (const f of faces) {
      for (let i = 0; i < f.length; i++) {
        const k = kOf(f[i], f[(i + 1) % f.length]);
        use.set(k, (use.get(k) || 0) + 1);
      }
    }
    const atVert = new Map();
    for (const [k, n] of use) {
      if (n !== 1) continue;                       // 只有「用一次」的才是洞的邊界
      const [a, b] = k.split('-').map(Number);
      atVert.set(a, (atVert.get(a) || 0) + 1);
      atVert.set(b, (atVert.get(b) || 0) + 1);
    }
    let pinched = 0;
    for (const n of atVert.values()) if (n > 2) pinched++;
    if (pinched) {
      return {
        ok: false,
        reason: `這樣刪會讓 ${pinched} 個頂點同時落在兩個洞的邊界上（洞在那裡「捏」成一點），`
              + `而目前的網格結構撐不住那種形狀。`
              + `改成刪「連在一起」的面，或一次少刪幾個`
      };
    }
  }

  const clean = cleanRebuild(points, faces);
  const out = Mesh.fromFaceList(clean.points, clean.faces);
  out.computeNormals();
  copyMarksThroughRemap(mesh, out, clean.remap);

  return {
    ok: true, mesh: out, remap: clean.remap,
    removed: drop.size, orphans: clean.dropped.orphans,
    wasClosed, nowClosed: out.isClosed()
  };
}

/**
 * 🔴 **補洞：把物件上所有的洞補起來。**（＝ Blender Cleanup 的 Fill Holes）
 *
 * ── 洞在我們的資料結構裡本來就串好了 ────────────────────
 * ⭐ **一行新的走訪都不用寫** —— `_buildBoundaryLoops()` 在建網格時
 * 就把「沒有 twin 的半邊」補成 `face` 為 null 的邊界半邊，
 * 並且**串成迴圈**（`next`／`prev`）。所以繞一圈就是洞的輪廓。
 *
 * ── 為什麼不做成「選一個洞補一個」──────────────────────
 * 🔴 **邊界邊在編輯模式下點不到** —— 挑邊走 `nearestMarkableEdge()`，
 * 而它明文排除邊界邊（「邊界本來就是外輪廓，標了也沒有意義」，
 * 那對分片是對的）。所以使用者選不到洞。
 * → 做成「全部補起來」，跟 Blender 的 Fill Holes 一樣。
 * 〔要做成精準版就得在 `select.js` 另外加一支「找最近的邊界邊」，
 * 　不能改 `isMarkable` —— 那支被分片與貼合共用〕
 *
 * ⚠ **板件（本來就開放）按下去會被封起來** —— 它的「邊界」不是洞，
 * 是它本來的外輪廓。那時補完體積會是 0，呼叫端要把體積講出來讓使用者看得見。
 *
 * @returns {{ok:boolean, reason?:string, mesh?:Mesh, remap?:Map,
 *            holes?:number, sizes?:number[], nowClosed?:boolean, fakeSeams?:number}}
 */
export function fillHoles(mesh) {
  if (!mesh || !mesh.faces.length) return { ok: false, reason: '沒有網格' };
  const naked = mesh.halfEdges.filter(he => !he.face);
  if (!naked.length) {
    return { ok: false, reason: '這個物件沒有洞（表面已經是封閉的）' };
  }

  const vi = mesh._vertIndex();
  const points = mesh.verts.map(v => v.p.clone());
  const faces = mesh.faces.map(f => mesh.faceVerts(f).map(v => vi.get(v.id)));

  const seen = new Set();
  const sizes = [];
  for (const b of naked) {
    if (seen.has(b)) continue;
    const loop = [];
    let c = b, guard = 0;
    do { seen.add(c); loop.push(vi.get(c.v.id)); c = c.next; }
    while (c && c !== b && guard++ < 1e5);
    if (c !== b) return { ok: false, reason: '洞的邊界沒有繞回來（迴圈斷了）' };
    if (loop.length < 3) continue;      // 兩條邊繞不成面
    faces.push(loop);
    sizes.push(loop.length);
  }
  if (!sizes.length) return { ok: false, reason: '找到邊界，但沒有一個繞得成面' };

  const pre = preflightRebuild(points, faces);
  if (!pre.ok) return { ok: false, reason: `補出壞掉的網格：${pre.fatal[0]}` };

  const clean = cleanRebuild(points, faces);
  const out = Mesh.fromFaceList(clean.points, clean.faces);
  out.computeNormals();
  copyMarksThroughRemap(mesh, out, clean.remap);
  /**
   * 🔴 補回去的那幾條邊**原本是邊界**，所以身上有自動標的 CUT。
   * 現在它們變回內部邊了，那些 CUT 是假的，要清掉 ——
   * 不清的話**畫面上會憑空多出幾條分片線**（見 `clearBoundaryOnlySeams`）。
   */
  const fakeSeams = clearBoundaryOnlySeams(mesh, out, clean.remap);

  return {
    ok: true, mesh: out, remap: clean.remap,
    holes: sizes.length, sizes, nowClosed: out.isClosed(), fakeSeams
  };
}

// ═══════════════════════════════════════════════════════
//  導角（Bevel，單段斜切）
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **導角：把選到的邊換成一片斜切面，角落自己會長出來。**
 *
 * ── 它是「內縮 ＋ 加面」，沒有專用的數學 ────────────────
 * ⭐ 每個面沿「被導的邊」往面內縮（**跟 `insetFaces()` 同一段 miter**），
 * 縮出來的縫隙就是斜切面與角落面。四動作框架的第二個成品。
 *
 * ── 🔴 「角落不唯一」是有條件的，而那個條件我們不滿足 ────
 * Blender 為角落開了 Miter（Sharp／Patch／Arc）三個選項，**那是因為
 * 多段導角（圓角）** —— 角落要用弧面接，接法真的有好幾種。
 * **但單段（斜切）在 3 價頂點上，角落是唯一的**：就是那幾個偏移點圍成的
 * 多邊形，沒得選。
 * ⚠ **而「我們的頂點全是 3 價」是錯的** —— 方塊與圓柱是，圓錐不是
 * （seg12 實測 {3:10, 4:2, 5:2, 6:2}）。**4 價以上的情形被擋下來**，
 * 見函式開頭那道防護。
 * → 完整推導與四個案例的數字見 `外部參考-Blender編輯.md` **第 11 節**。
 *
 * ── 🔴 三個「推理會錯、實測才對」的地方（每一個都會讓網格壞掉）──
 *
 * **① 往面內的方向是 `n × d`。** 反了的話體積不減反增（實測 108000 → 117000）。
 *
 * **② 沒被導到的面要「吸收」鄰居的代表點。**
 * 只導一部分的邊時，斜切線會**橫過**旁邊那個面的角，
 * 所以它要從 n 邊形變成 n+1 邊形。不吸收的話網格不封閉（實測 χ −2）。
 * 〔`外部參考-Blender編輯.md` 第 9.6 節其實提過這件事，
 * 　**但寫成一句觀察、沒寫成規則，所以實作時照樣踩進去** —— 坑第 33 條的家族〕
 *
 * **③ 共用「沒被導的邊」的兩個面，代表點必須是同一個。**
 * 它們在幾何上本來就是同一點（那條邊沒被動，只是變短），
 * 但逐面算會給出兩個不同的索引 → **網格從那裡裂開**
 * （實測 16 段圓柱上下兩圈導角：χ −14、不封閉）。
 * 🔴 **用併查集解，不要用容許值** —— 它是結構問題，不是數值問題。
 *
 * ── ⚠ 被導掉的那條邊上的標記會消失 ──────────────────
 * 那條邊**真的不存在了**（換成一片斜切面），所以標記跟著走是正確的。
 * 呼叫端要講一句，不要讓它安靜消失。沒被導的邊照樣搬。
 *
 * @param {Mesh} mesh
 * @param {HalfEdge[]} hes 要導的邊（任一條半邊即可）
 * @param {number} w 導角寬度，cm
 * @returns {{ok:boolean, reason?:string, mesh?:Mesh,
 *            edges?:number, walls?:number, corners?:number,
 *            clamped?:number, lostMarks?:number}}
 */
export function bevelEdges(mesh, hes, w, opt = {}) {
  const list = (Array.isArray(hes) ? hes : [hes]).filter(Boolean);
  if (!mesh || !list.length) return { ok: false, reason: '沒有選到邊' };
  if (!(w > 0)) return { ok: false, reason: '導角寬度要大於 0' };
  /** 段數：1 ＝ 現在的斜切邊。⚠ 0 或負的一律當 1（跟環切的刀數同一條規矩）*/
  const segs = Math.max(1, Math.min(BEVEL_MAX_SEG, Math.round(opt.segments || 1)));

  mesh.computeNormals();
  const vi = mesh._vertIndex();
  const kOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const pts = mesh.verts.map(v => v.p.clone());

  const cut = new Set();
  for (const he of list) {
    if (!he.face || !he.twin || !he.twin.face) {
      return { ok: false, reason: '外輪廓的邊不能導角（它只有一側有面）' };
    }
    cut.add(kOf(vi.get(he.v.id), vi.get(he.to.id)));
  }
  const isCut = (a, b) => cut.has(kOf(vi.get(a.id), vi.get(b.id)));

  /**
   * 🔴 **擋下來：4 價以上的頂點只導一部分的邊，角落會留一個洞。**
   *
   * ── 這一條是 kang 2026-08-25 實測逼出來的 ────────────────
   * 日誌與第 11 節都寫著「**我們的頂點全是 3 價**」，而角落規則就建在那句話上：
   * 3 價時，那個沒被導到的面會**同時吸收兩邊的代表點**，自己把縫補起來。
   *
   * **但那句話是錯的。** 圓錐 seg12 的頂點價數實測是
   * **{3 價 10 個、4 價 2 個、5 價 2 個、6 價 2 個}** ——
   * 它只對**方塊與圓柱**成立，被當成了全域事實。
   *
   * 4 價以上時兩個吸收面各自只拿到一邊，中間留下一個三角形的洞
   * （實測圓錐導一條邊：χ 1、邊界半邊 3 條）。
   *
   * ⚠ **通用的角落規則試了三次都沒解出來**（見 `外部參考-Blender編輯.md`
   * 第 11.7 節），所以先擋下來 —— **做出一個破洞的網格比擋下來糟得多**
   * （坑第 11 條：沉默地退回是最糟的做法，所以要擋而且要講清楚原因）。
   *
   * ✅ **不受影響的**：頂點全被導到時（例如 12 條邊全導）照樣可以，
   * 因為那時沒有面需要吸收。方塊、圓柱、圓角方塊都在範圍內。
   */
  /**
   * 🔴 **角落規則的歷史（2026-08-25，第四次才解出來）**
   *
   * 這裡原本有一道防護，把「4 價以上的頂點只導一部分」擋掉 ——
   * 因為那時的角落規則是「**每個面都被導到才補**」，而它**只對 3 價成立**。
   *
   * ⚠ 那個限制比當初估的嚴重得多：**導角自己就會製造 4 價頂點**
   * （方塊導完頂面四條，價數從 {3:8} 變成 {3:8, 4:4}），
   * 所以它擋掉的不是「圓錐那種特殊形狀」，而是
   * **「先導一組、再導旁邊那一組」這種日常操作**（kang 2026-08-25 實測踩到）。
   *
   * **現在解掉了，防護已移除。** 解法見底下 ④ 那一段 ——
   * 真正的難處只有一個：**繞一圈的順序跟面迴圈的順序是相反的**。
   * ⛔ 要再動那一段之前，先讀 `外部參考-Blender編輯.md` 第 11.7 節
   * （四次嘗試分別錯在哪），並且**先跑驗證集**：
   * 方塊一條邊／方塊一個角落／12 條全導／圓柱兩圈／圓角方塊一條一條／
   * 圓錐（4～6 價）／先頂面四條再垂直四條／順序無關。
   */

  /** 面 f 的迴圈裡，頂點 V 那一格的 {cur, prv} */
  const at = (f, V) => {
    const loop = mesh.faceLoop(f);
    const i = loop.findIndex(he => he.v === V);
    return i < 0 ? null : { cur: loop[i], prv: loop[(i - 1 + loop.length) % loop.length] };
  };
  const hasBev = (f, V) => {
    const c = at(f, V);
    return c ? (isCut(V, c.cur.to) || isCut(c.prv.v, V)) : false;
  };

  // ── ① 只有「在這個頂點有被導的邊」的面才產生代表點 ──
  const R = new Map();                     // `面id:頂點id` → 代表點索引
  let clamped = 0;
  for (const f of mesh.faces) {
    const n = f.normal.clone().normalize();
    for (const V of mesh.faceVerts(f)) {
      const c = at(f, V);
      if (!c) continue;
      const bNext = isCut(V, c.cur.to), bPrev = isCut(c.prv.v, V);
      if (!bNext && !bPrev) continue;
      /** 往面內 ＝ 面法向 × 邊方向（左手邊就是內側）。⚠ 反了體積會不減反增 */
      const inward = he => {
        const d = new THREE.Vector3().subVectors(he.to.p, he.v.p).normalize();
        return new THREE.Vector3().crossVectors(n, d).normalize();
      };
      let p;
      if (bNext && bPrev) {
        const i1 = inward(c.cur), i2 = inward(c.prv);
        const bis = i1.clone().add(i2);
        if (bis.lengthSq() < 1e-16) p = V.p.clone().addScaledVector(i1, w);
        else {
          bis.normalize();
          const cos = bis.dot(i1);
          if (cos < 0.2) clamped++;        // 上限 5 倍，跟 shell()／內縮同一個規矩
          p = V.p.clone().addScaledVector(bis, w / Math.max(cos, 0.2));
        }
      } else {
        /**
         * 🔴 **只有一條邊被導時，角要「沿著沒被導的那條邊滑」，
         * 不是「垂直於被導的邊偏移」。**
         *
         * ── 為什麼（kang 2026-08-25 實測抓到）────────────────
         * 斜切面會**橫過**旁邊那個面的角，而旁邊那個面要把這個點吸收進去。
         * 點要留在**它的**平面上，唯一的辦法是讓它待在兩個面的交線上 ——
         * 也就是**那條沒被導的邊**。
         *
         * ⚠ **方塊把這個錯誤藏起來了**：方塊的兩條邊互相垂直，
         * 「垂直於 A 偏移 w」跟「沿 B 滑 w」剛好是同一點。
         * 一旦不是直角就分岔 —— 症狀是**吸收它的那個面變成非平面**，
         * 三角化之後畫面上出現奇怪的形狀。
         * 〔實測：不相鄰的三條邊一條一條導，非平面面 0 → 1 → 2〕
         *
         * 距離換算：沿 B 滑 t，離 A 的垂直距離是 `t·sin(A,B 夾角)`，
         * 所以 `t = w / sin`。夾角趨近 0 或 180° 時 t 會爆掉，
         * 沿用 `shell()` 那條上限 5 倍的老規矩。
         */
        const bevHe = bNext ? c.cur : c.prv;
        const oppHe = bNext ? c.prv : c.cur;
        const dA = new THREE.Vector3()
          .subVectors(bevHe.to.p, bevHe.v.p).normalize()
          .multiplyScalar(bNext ? 1 : -1);                  // 一律從 V 出發
        const dB = (oppHe === c.cur)
          ? new THREE.Vector3().subVectors(c.cur.to.p, V.p).normalize()
          : new THREE.Vector3().subVectors(c.prv.v.p, V.p).normalize();
        const sin = new THREE.Vector3().crossVectors(dA, dB).length();
        if (sin < 0.2) clamped++;
        p = V.p.clone().addScaledVector(dB, w / Math.max(sin, 0.2));
      }
      R.set(`${f.id}:${V.id}`, pts.length);
      pts.push(p);
    }
  }

  // ── ①b 共用「沒被導的邊」的兩個面，代表點併成同一個（見檔頭 ③）──
  {
    const par = new Map();
    const find = k => { while (par.get(k) !== k) { par.set(k, par.get(par.get(k))); k = par.get(k); } return k; };
    for (const key of R.keys()) par.set(key, key);
    for (const V of mesh.verts) {
      for (const he of mesh.vertOutgoing(V)) {
        if (!he.face || !he.twin || !he.twin.face) continue;
        if (isCut(V, he.to)) continue;                 // 這條邊被導了 → 本來就該分開
        const a = `${he.face.id}:${V.id}`, b = `${he.twin.face.id}:${V.id}`;
        if (!R.has(a) || !R.has(b)) continue;          // 有一邊沒代表點 → 那一邊會去吸收
        const ra = find(a), rb = find(b);
        if (ra !== rb) par.set(ra, rb);
      }
    }
    const canon = new Map();
    for (const key of R.keys()) { const root = find(key); if (!canon.has(root)) canon.set(root, R.get(key)); }
    for (const key of [...R.keys()]) R.set(key, canon.get(find(key)));
  }

  /**
   * 🔴 **「這條邊在這個面上，現在從哪一點出發」。**
   *
   * ⚠ **不能只問「這個面在這個頂點的代表點」** —— 那個面如果是
   * 「吸收型」的（在這個頂點沒有被導到的邊），它根本沒有自己的代表點，
   * 而是把**兩側鄰居的**代表點各吸收一個。那時候這條邊的新起點是
   * **它自己那一側**的那個，不是原本的頂點。
   *
   * 不分這一層的話，標記會落空：實測方塊導一條邊，**4 條沒被導的邊
   * 標記直接消失**（它們的端點被吸收掉了，配對配到一個已經不存在的索引）。
   *
   * @param {Face} f 這條半邊所屬的面
   * @param {HalfEdge} he 這條半邊（用來決定是「出發側」還是「到達側」）
   * @param {Vertex} V `he` 的兩個端點之一
   */
  const repForEdge = (f, he, V) => {
    const own = R.get(`${f.id}:${V.id}`);
    if (own !== undefined) return own;
    const c = at(f, V);
    if (!c) return vi.get(V.id);
    // V 是這條邊的起點 → 用「跨過這條邊」的那個鄰居的代表點；是終點就用另一側
    const side = (c.cur === he) ? c.cur : c.prv;
    const g = side.twin && side.twin.face;
    const k = g ? R.get(`${g.id}:${V.id}`) : undefined;
    return k === undefined ? vi.get(V.id) : k;
  };

  /**
   * ═══ 多段（圓角）用的四個零件 ═══════════════════════════
   *
   * 🔴 **段數 1 完全不走這裡** —— ③④ 的單段那條路一行都沒改，
   * 所以「舊行為完全沒變」是**結構保證**，不是靠人記得。
   * 測試釘的是更強的版本：段數 1 跟原本**逐個頂點完全相同**。
   *
   * ⚠ **定義的位置很重要** —— 要放在 ② 前面。
   * ② 也會用到 `arcPt()`（沒被導到的面要吸收整條弧），
   * 放在 ③ 前面的話 ② 那邊會取到還沒初始化的 const。
   * 〔第一版就是放在 ③ 前面，於是 ② 沒吸收到弧，網格裂開 —— kang 實測抓到〕
   *
   * ── ⭐ 「推到弧上」不必事後推 ──────────────────────────
   * 第 12.4 節寫的路徑是「導角 ＋ 環切那片斜切面 ＋ **把新的點推到弧上**」。
   * 實際做下去發現第三步是免費的：
   *
   * > **弧上的點 ＝ 兩個面法向的球面插值，乘上半徑，加上圓心。**
   *
   * 因為圓角面跟原本兩個面**相切**，所以 `圓心 = 代表點 − w × 面法向`，
   * 而代表點到圓心的方向**就是那個面的法向**。於是整條弧是
   * `c + w × slerp(nF, nG, t)` —— **精確落在弧上，不需要任何修正**。
   *
   * ⭐ 這也順帶解掉「圓心在哪」：**從哪個面算都要得到同一個圓心**，
   * 而那正是第 12.5 節說的「非直角時可能沒有一個球同時相切」的判準本身。
   * ⛔ 所以不要去判斷「是不是直角」—— 直接算圓心，對不上就擋下來。
   */

  /** 球面插值：沿大圓等角度走，兩端與中間都精確落在弧上 */
  const slerpDir = (a, b, t) => {
    const d = Math.min(1, Math.max(-1, a.dot(b)));
    const ang = Math.acos(d);
    if (ang < 1e-9) return a.clone();
    const s = Math.sin(ang);
    return a.clone().multiplyScalar(Math.sin((1 - t) * ang) / s)
      .add(b.clone().multiplyScalar(Math.sin(t * ang) / s));
  };

  /**
   * 這個頂點在這幾個面上的**共同圓心**。
   * 🔴 **對不上就是「沒有一個球同時相切」** —— 回 null，由呼叫端擋下來。
   */
  const centerAt = (V, fs) => {
    let c = null;
    for (const f of fs) {
      const rep = R.get(`${f.id}:${V.id}`);
      if (rep === undefined) return null;
      const ci = pts[rep].clone().addScaledVector(f.normal, -w);
      if (!c) { c = ci; continue; }
      if (c.distanceTo(ci) > PLANAR_TOL_CM) return null;   // 半徑對不起來
    }
    return c;
  };

  /**
   * 這個頂點**只導了一部分的邊**嗎（有被導的，也有沒被導的）。
   *
   * 🔴 **這是圓角最常撞到的一種情形，而且訊息說錯會很誤導。**
   * kang 2026-08-25 實測：方塊選頂面四條邊導圓角 → 跳「這個角落不是直角」，
   * **可是方塊明明是直角**。真正的原因是那個角落的垂直邊沒被導，
   * 於是兩條弧的圓心差了一個 w，接不起來。
   *
   * → 分開講：**只導一部分**要告訴他「全部一起選就可以」（那是做得到的），
   * 「不是直角」才是真的還沒解。⛔ 兩種混成一句話，他會往錯的方向試。
   */
  const partialAtVert = V => {
    let bev = 0, plain = 0;
    for (const he of mesh.vertOutgoing(V)) {
      if (!he.face || !he.twin || !he.twin.face) continue;
      if (isCut(he.v, he.to)) bev++; else plain++;
    }
    return bev > 0 && plain > 0;
  };

  /**
   * ═══ outer miter：只導一部分的邊，角落怎麼接 ═══════════════
   *
   * 🔴 **方案來源 `外部參考-Blender編輯.md` 第 13 節**（動這一段之前先讀）。
   * Blender 三種接法（Sharp／Patch／Arc）裡**選 Sharp**：
   * **兩片圓角面延伸到相交，不加額外頂點**。
   * Patch／Arc 解的是**算圖的著色問題**，那是 Blender 的其他目的，我們不算圖。
   *
   * ── ⭐ 關鍵：兩條弧共用同一個圓心 ──────────────────────
   * 這一段卡了兩輪，原因是我一直用「每個面在這個頂點的代表點」去算圓心，
   * 而**共用面 T 的代表點是「兩條邊都內縮」的角點**，不是任一條邊的偏移。
   *
   * > **圓心 c ＝ T 的代表點 − w × T 的法向。兩條弧都用它。**
   *
   * 弧1 ＝ `c + w × slerp(n_T, n_B, t)`（e1 的圓角面在 V 端縮短後的那一圈）
   * 弧2 ＝ `c + w × slerp(n_T, n_A, t)`
   * 兩條弧的 t=0 都落在 `T:V`，而**交線的兩端剛好是 `T:V` 與 `A:V`**。
   *
   * ── 交線：不是圓弧，而且不必解聯立 ──────────────────────
   * 片1 的點 ＝ `c + s×(e1 方向) + w×slerp(n_T, n_B, t)`，
   * 代進片2 解出來 **`s = w × sin(t × 90°)`** —— 一個封閉式。
   * ⚠ 交線上的點**到 c 的距離不是 w**（是 √(w²+s²)）——
   * 它是**橢圓弧**，⛔ 不要拿圓弧公式去套。
   */

  /** V 周圍「被導的」邊（從 V 出發的半邊） */
  const bevAtVert = V => mesh.vertOutgoing(V).filter(
    he => he.face && he.twin && he.twin.face && isCut(he.v, he.to));

  /**
   * 這個頂點適不適用 miter，適用的話把零件算好。
   * 只處理**剛好兩條被導的邊、而且它們共用一個面**的情形 ——
   * 其餘（4 價上兩條不相鄰、三條以上但沒全導）先擋，⛔ 不唯一就不猜。
   */
  const miterAt = V => {
    const bs = bevAtVert(V);
    if (bs.length !== 2) return null;
    const [e1, e2] = bs;
    const f1 = [e1.face, e1.twin.face], f2 = [e2.face, e2.twin.face];
    const T = f1.find(f => f2.includes(f));
    if (!T) return null;                       // 兩條被導的邊不相鄰
    const B = f1.find(f => f !== T);
    const A = f2.find(f => f !== T);
    if (!A || !B || A === B) return null;
    const repT = R.get(`${T.id}:${V.id}`);
    if (repT === undefined) return null;
    const c = pts[repT].clone().addScaledVector(T.normal, -w);
    /** 兩條邊的單位方向（從 V 往外） */
    const d1 = e1.to.p.clone().sub(V.p).normalize();
    const d2 = e2.to.p.clone().sub(V.p).normalize();
    return { e1, e2, T, A, B, c, d1, d2, repT };
  };

  /**
   * 圓角接不起來時，講**這個頂點**真正的原因，而且要講得出路。
   * 〔坑第 11 條：沉默地退回最糟；坑第 18 條：訊息錯了比沒訊息更糟〕
   */
  const bevelBlockReason = V => {
    /**
     * ⚠ **outer miter（2026-08-25）之後這裡要重新分類。**
     * 「只導一部分」本身**已經做得到了**（剛好兩條、而且是直角的角落），
     * 所以還會走到這裡的只剩兩種，⛔ 不可以再一律說「只導了一部分」——
     * 那會叫圓錐的使用者去「全部一起選」，而那條路對他是死路
     * （坑第 34 條：不要寫一個不存在的退路）。
     */
    const bs = bevAtVert(V).length;
    if (partialAtVert(V) && bs !== 2) {
      return '這個角落只導了一部分的邊，圓角在那裡接不起來。'
           + '把這個角落的邊**全部一起選**就可以了（例如方塊要整個圓角，12 條邊一起選）。'
           + '只想導幾條的話，段數改成 1 的斜切邊可以做';
    }
    return '這個角落不是直角，圓角還做不出來 —— 兩邊的圓弧接不到一起。'
         + '段數改成 1 的斜切邊可以做';
  };

  /** 這兩個面之間，有沒有一條**被導的**邊通過 V —— 有才存在一條弧 */
  const sharedBevelEdge = (V, g1, g2) => {
    for (const he of mesh.vertOutgoing(V)) {
      if (!he.face || !he.twin || !he.twin.face) continue;
      if (!isCut(he.v, he.to)) continue;
      const a = he.face, b = he.twin.face;
      if ((a === g1 && b === g2) || (a === g2 && b === g1)) return true;
    }
    return false;
  };

  /**
   * 弧上第 k 個點的索引（k ＝ 0…segs，0 在 F 側、segs 在 G 側）。
   * ⚠ **一定要快取而且 key 要正規化** —— 同一條弧會被斜切面、角落、
   * 以及「吸收的面」各要一次，各生一次的話接縫上會出現重合但不共用的點，
   * `cleanRebuild()` 併不掉（它併的是孤點不是重點），網格就裂開了。
   */
  const arcCache = new Map();
  const arcPt = (V, F, G, k) => {
    const flip = F.id > G.id;
    const [A, B] = flip ? [G, F] : [F, G];
    const kk = flip ? segs - k : k;
    const key = `${V.id}|${A.id}|${B.id}|${kk}`;
    if (arcCache.has(key)) return arcCache.get(key);
    if (kk === 0)     { const i = R.get(`${A.id}:${V.id}`); arcCache.set(key, i); return i; }
    if (kk === segs)  { const i = R.get(`${B.id}:${V.id}`); arcCache.set(key, i); return i; }
    const c = centerAt(V, [A, B]);
    if (!c) return undefined;
    const idx = pts.length;
    pts.push(c.clone().addScaledVector(
      slerpDir(A.normal, B.normal, kk / segs), w));
    arcCache.set(key, idx);
    return idx;
  };

  /**
   * ── miter 的兩片：先把點全部生好，②③④ 再各自取用 ──────────
   * ⚠ 一定要**共用**：交線 `seam[i]` 同時屬於兩片，
   * 兩邊各生一次的話接縫上會出現重合但不共用的點，網格就裂開了
   * （跟 `arcPt()` 要快取是同一個理由）。
   */
  const miters = new Map();
  if (segs > 1) {
    for (const V of mesh.verts) {
      const mi = miterAt(V);
      if (!mi) continue;
      const { T, A, B, c, d1, d2 } = mi;
      /**
       * ⚠ **只做直角。** 非直角時三片的偏移距離不一樣，
       * `s = w·sin(t·夾角)` 那條封閉式是從正交推出來的，不成立 ——
       * 而**那正是 Blender 開 Miter 三個選項的地方**（第 13 節）。
       * ⛔ 不唯一就不猜，擋下來。
       */
      if (Math.abs(T.normal.dot(A.normal)) > 1e-6) continue;
      if (Math.abs(T.normal.dot(B.normal)) > 1e-6) continue;
      /** 交線的兩端必須是既有的點：T:V 與 A:V（＝ B:V，①b 已經併過） */
      const iT = R.get(`${T.id}:${V.id}`);
      const iA = R.get(`${A.id}:${V.id}`), iB = R.get(`${B.id}:${V.id}`);
      if (iT === undefined || iA === undefined || iA !== iB) continue;

      const ang1 = Math.acos(Math.min(1, Math.max(-1, T.normal.dot(B.normal))));
      const ang2 = Math.acos(Math.min(1, Math.max(-1, T.normal.dot(A.normal))));
      const g1 = d1.clone().negate(), g2 = d2.clone().negate();
      const P = v => { pts.push(v); return pts.length - 1; };

      /** 交線：從 T:V 走到 A:V。⚠ 它是**橢圓弧**，到 c 的距離不是 w */
      const seam = [iT];
      for (let i = 1; i < segs; i++) {
        const t = i / segs;
        seam.push(P(c.clone()
          .addScaledVector(slerpDir(T.normal, B.normal, t), w)
          .addScaledVector(g1, w * Math.sin(t * ang1))));
      }
      seam.push(iA);

      /** 一片：第 i 列 i+1 個點，j=0 在弧上、j=i 在交線上 */
      const mkRows = (nOther, ang, dir) => {
        const rows = [[seam[0]]];
        for (let i = 1; i <= segs; i++) {
          const t = i / segs;
          const u = slerpDir(T.normal, nOther, t);
          const s = w * Math.sin(t * ang);
          const row = [];
          for (let j = 0; j <= i; j++) {
            if (j === i) { row.push(seam[i]); continue; }
            row.push(P(c.clone().addScaledVector(u, w)
                                .addScaledVector(dir, s * j / i)));
          }
          rows.push(row);
        }
        return rows;
      };
      const rows1 = mkRows(B.normal, ang1, g1);
      const rows2 = mkRows(A.normal, ang2, g2);

      miters.set(V.id, {
        T, A, B, rows1, rows2,
        arc1: rows1.map(r => r[0]), arc2: rows2.map(r => r[0]),
        endB: rows1[segs][0], endA: rows2[segs][0],
        k1: kOf(vi.get(mi.e1.v.id), vi.get(mi.e1.to.id)),
        k2: kOf(vi.get(mi.e2.v.id), vi.get(mi.e2.to.id))
      });
    }
  }

  /**
   * 這條邊在 V 端、F 側的第 k 個弧點。
   * miter 頂點用**縮短後**的弧（角落那兩片接管了剩下的部分），
   * 其餘走一般的 `arcPt()`。
   */
  const arcAt = (V, F, G, k, ekey) => {
    const m = miters.get(V.id);
    if (m) {
      if (ekey === m.k1) return F === m.T ? m.arc1[k] : m.arc1[segs - k];
      if (ekey === m.k2) return F === m.T ? m.arc2[k] : m.arc2[segs - k];
    }
    return arcPt(V, F, G, k);
  };

  const faces = [];
  // ── ② 原面：有代表點就換掉；沒有的要吸收鄰居的（見檔頭 ②）──
  for (const f of mesh.faces) {
    const out = [];
    for (const V of mesh.faceVerts(f)) {
      const own = R.get(`${f.id}:${V.id}`);
      if (own !== undefined) {
        /**
         * 🔴 **miter 的兩片會吃掉旁邊那兩個面的一角**，
         * 所以那兩個面在這一角要多吸收一個點（弧的末端）。
         * ⚠ **這跟「只導一條邊網格會裂開」是同一個機制** ——
         * 少吸收一個點，半邊就配不到 twin。
         *
         * 順序照繞行方向：`prv` 先、`cur` 後。
         * 靠「被導的那條邊」那一側放弧的末端，另一側放原本的代表點。
         */
        const m = segs > 1 ? miters.get(V.id) : null;
        if (m && (f === m.A || f === m.B)) {
          /**
           * ⚠ **要吸收的是一整列，不是兩端。**
           * 角落那片的第三條邊界（`rows[segs]`）整條躺在這個面上，
           * 只放兩端的話中間 segs−1 個點在這裡配不到邊 → 破洞
           * （實測 χ 2 → −6，而**體積照樣正確收斂** —— 坑第 17 條）。
           * 該列的最後一個就是 `own`（＝ A:V ＝ 交線終點），所以不另外放。
           */
          const row = (f === m.A) ? m.rows2[segs] : m.rows1[segs];
          const cc = at(f, V);
          const prvBev = cc && isCut(cc.prv.v, cc.prv.to);
          if (prvBev) out.push(...row);
          else        out.push(...[...row].reverse());
          continue;
        }
        out.push(own);
        continue;
      }
      const c = at(f, V);
      const a1 = repForEdge(f, c.prv, V), a2 = repForEdge(f, c.cur, V);
      out.push(a1);
      if (a2 !== a1) {
        /**
         * 🔴 **多段時，這個面要吸收的是「整條弧」，不是只有兩端。**
         *
         * ⚠ **kang 2026-08-25 實測抓到的**：選一條邊導圓角，
         * 側面上冒出一堆奇怪的線 —— 那是弧上的中間點在這個面這邊
         * **配不到對應的邊**，半邊配不到 twin，網格就裂開了
         * （χ 2 → 0、`isClosed()` false、邊界半邊 2n+2 條）。
         *
         * 🔴 **而 `validate()` 抓不到** —— 跟「清孤點」那次一樣，只有 χ 露餡。
         *
         * ⚠ **沙箱測試沒抓到，因為當時只驗「12 條邊全導」** ——
         * 那時每個面都有自己的代表點，**沒有任何面需要吸收**，
         * 這條路根本沒被走到。〔坑第 17 條的又一次重演：
         * 挑樣本要涵蓋不同的**網格結構**，不只是不同的形狀〕
         */
        if (segs > 1) {
          const g1 = c.prv.twin && c.prv.twin.face;
          const g2 = c.cur.twin && c.cur.twin.face;
          if (g1 && g2 && g1 !== g2 && sharedBevelEdge(V, g1, g2)) {
            for (let k = 1; k < segs; k++) {
              const p = arcPt(V, g1, g2, k);
              if (p !== undefined) out.push(p);
            }
          }
        }
        out.push(a2);
      }
    }
    faces.push(out);
  }

  // ── ③ 每條被導的邊 → 一片斜切面（多段時 segs 片）──
  let walls = 0;
  for (const he of mesh.edges()) {
    if (!isCut(he.v, he.to) || !he.face || !he.twin || !he.twin.face) continue;
    const F = he.face, G = he.twin.face;

    if (segs === 1) {
      faces.push([R.get(`${F.id}:${he.v.id}`),  R.get(`${F.id}:${he.to.id}`),
                  R.get(`${G.id}:${he.to.id}`), R.get(`${G.id}:${he.v.id}`)]);
      walls++;
      continue;
    }

    /**
     * 多段：兩端各走一條弧，把對應的點串成 segs 片四邊形。
     * ⚠ 兩端的弧**方向要一致**（都從 F 走到 G），否則四邊形會扭成沙漏
     * —— 那是坑第 29 條，畫面上完全看不出來。
     */
    const ekey = kOf(vi.get(he.v.id), vi.get(he.to.id));
    for (let k = 0; k < segs; k++) {
      const a0 = arcAt(he.v,  F, G, k, ekey),     a1 = arcAt(he.to, F, G, k, ekey);
      const b1 = arcAt(he.to, F, G, k + 1, ekey), b0 = arcAt(he.v,  F, G, k + 1, ekey);
      if ([a0, a1, b1, b0].some(x => x === undefined)) {
        const V = (a0 === undefined || b0 === undefined) ? he.v : he.to;
        return { ok: false, reason: bevelBlockReason(V) };
      }
      faces.push([a0, a1, b1, b0]);
      walls++;
    }
  }

  /**
   * ── ④ 角落面：頂點周圍**每一個**面都被導到時才補 ──────────
   *
   * 那時 V 沒有任何面在用了，中間會空一個洞，由這些代表點圍起來。
   * 只導一部分時**不補** —— 3 價的話，那個沒被導到的面會
   * **同時吸收兩邊的代表點**，自己就把縫補起來了。
   *
   * ⚠ **這條規則只對 3 價頂點成立，4 價以上會留一個洞** ——
   * 所以函式開頭有一道防護把那種情形擋掉（見上方那則說明）。
   * **通用的角落規則試了三次都沒解出來**，經過見
   * `外部參考-Blender編輯.md` 第 11.7 節。⛔ 不要憑印象再改這一段，
   * 先去讀那一節：那裡記了三次分別錯在哪、以及哪些案例會回歸。
   */
  let corners = 0;
  for (const V of mesh.verts) {
    const around = mesh.vertOutgoing(V).filter(he => he.face);
    if (!around.length) continue;
    if (!around.some(he => hasBev(he.face, V))) continue;   // 這個頂點完全沒被碰到

    /**
     * ── miter 角落：兩片圓柱面延伸到交線（第 13 節的 Sharp）──────
     * ⚠ 走這條就不走底下的 ring 邏輯 —— miter 頂點的 ring 只有 2 個點
     * （`A:V` 與 `T:V`），會被當成「不用補」而 continue，那就破了。
     * ⭐ 繞向不在這裡判斷，交給後面已經驗過的 `recalcNormalsOutside()`。
     */
    const mt = segs > 1 ? miters.get(V.id) : null;
    if (mt) {
      for (const rows of [mt.rows1, mt.rows2]) {
        for (let i = 1; i <= segs; i++) {
          const up = rows[i - 1], dn = rows[i];
          for (let j = 0; j < i; j++) {
            faces.push([up[j], dn[j], dn[j + 1]]);
            if (j > 0) faces.push([up[j - 1], dn[j], up[j]]);
          }
        }
      }
      corners++;
      continue;
    }

    /**
     * 🔴 **繞著 V 走一圈，收集「每個面在這一角現在用的是哪一點」。**
     *
     * ⚠ **順序是這一段唯一的難處，而且它反過來了。**
     * `vertOutgoing()` 走的是 `he.prev.twin` —— 也就是**從這個面的 `prv` 邊
     * 跨到下一個面**。所以繞一圈時，每個面要**先放 `cur` 側、後放 `prv` 側**。
     * 而**面迴圈裡剛好相反**（`prv` 先、`cur` 後，因為是沿 prv 進來、沿 cur 出去）。
     *
     * 🔴 **第二次嘗試就是死在這裡** —— 邏輯完全正確，兩個順序寫反了，
     * 串出來的環就亂掉（方塊多出假的角落面、圓錐 χ −35）。
     * 〔三次失敗的完整經過見 `外部參考-Blender編輯.md` 第 11.7 節〕
     */
    const seq = [];
    for (const he of around) {
      const f = he.face;
      const own = R.get(`${f.id}:${V.id}`);
      if (own !== undefined) { seq.push(own); continue; }   // 有自己的代表點 → 一個點
      const c = at(f, V);
      if (!c) continue;
      seq.push(repForEdge(f, c.cur, V), repForEdge(f, c.prv, V));
    }
    // 連續去重（含頭尾相接）
    const ring = [];
    for (const k of seq) if (ring[ring.length - 1] !== k) ring.push(k);
    while (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();

    /**
     * 剩幾個相異點就決定要不要補：
     *
     * | 情形 | 相異點 | 補嗎 |
     * |---|---|---|
     * | 圓柱邊緣：2 條被導、代表點併掉了 | 2 | 不補（兩片斜切面自己接起來）|
     * | **3 價、只導一條** | **2** | **不補** —— 那個沒被導到的面同時吸收了兩邊，自己補起來了 |
     * | **4 價、只導一條** | **3** | **要補** ← 就是這一格讓 kang 的流程壞掉 |
     * | 3 價、三條全導 | 3 | 要補 |
     */
    if (ring.length < 3) continue;

    if (segs === 1) { faces.push(ring); corners++; continue; }

    /**
     * ── 多段的角落 ＝ **球面的一塊**（第 12.2 節）───────────────
     *
     * 三片圓柱面跟中間這塊球面接得水密，**沒有任何「要怎麼接」的選擇** ——
     * Blender 開 Miter（Sharp／Patch／Arc）是為了一般情況，
     * 在「均勻半徑 ＋ 角落有共同球心」這個條件下答案唯一。
     *
     * ⚠ **只做三個面的角落。** 四個以上的球面多邊形怎麼分割**不唯一**，
     * 而不唯一就不猜（鐵律三，坑第 24 條）—— 擋下來說原因。
     * 〔單段不受影響：它 2026-08-25 就解掉 4～6 價了，走上面那條路〕
     */
    const fs = around.map(he => he.face)
      .filter((f, i, a) => a.indexOf(f) === i)
      .filter(f => R.get(`${f.id}:${V.id}`) !== undefined);
    if (fs.length !== 3) {
      return {
        ok: false,
        reason: `這個角落有 ${fs.length} 個面，圓角目前只做得出三個面的角落。`
              + `段數改成 1 的斜切邊可以做`
      };
    }
    const c = centerAt(V, fs);
    if (!c) return { ok: false, reason: bevelBlockReason(V) };

    /**
     * 🔴 **列的起訖用 `arcPt()`，內部才自己生。**
     * 三條邊界（A→B、A→C、B→C）因此**逐點等於斜切面用的那三條弧**，
     * 而不是「算出來剛好一樣」—— 接縫是結構保證的，不是靠精度。
     * 〔坑第 31 條：與其讓兩條路對齊，不如換一個只有一條路的定義〕
     */
    const [A, B, C] = fs;
    const rows = [];
    for (let r = 0; r <= segs; r++) {
      const row = [];
      const s0 = arcPt(V, A, B, r), s1 = arcPt(V, A, C, r);
      if (s0 === undefined || s1 === undefined) {
        return { ok: false, reason: '這個角落的圓弧算不出來（半徑對不起來）' };
      }
      if (r === 0) { rows.push([s0]); continue; }
      const d0 = pts[s0].clone().sub(c).normalize();
      const d1 = pts[s1].clone().sub(c).normalize();
      for (let s = 0; s <= r; s++) {
        if (s === 0)      { row.push(s0); continue; }
        if (s === r)      { row.push(s1); continue; }
        if (r === segs)   { row.push(arcPt(V, B, C, s)); continue; }  // B→C 邊界
        row.push(pts.length);
        pts.push(c.clone().addScaledVector(slerpDir(d0, d1, s / r), w));
      }
      rows.push(row);
    }

    /** 標準三角形細分：第 r 列有 r+1 個點，跟第 r−1 列串成 2r−1 個三角形 */
    for (let r = 1; r <= segs; r++) {
      const up = rows[r - 1], dn = rows[r];
      for (let s = 0; s < r; s++) {
        faces.push([up[s], dn[s], dn[s + 1]]);
        if (s > 0) faces.push([up[s - 1], dn[s], up[s]]);
      }
    }
    corners++;
  }

  const pre = preflightRebuild(pts, faces);
  if (!pre.ok) return { ok: false, reason: `導角做出壞掉的網格：${pre.fatal[0]}` };

  const clean = cleanRebuild(pts, faces);
  let out = Mesh.fromFaceList(clean.points, clean.faces);
  out.computeNormals();

  /**
   * 🔴 **繞向交給已經驗過的那一支修，不要在這裡手工判斷。**
   * 角落面的繞向取決於 `vertOutgoing()` 繞的方向，而**繞向錯了畫面上
   * 完全看不出來**（坑第 29 條），只有體積會露餡。
   * `recalcNormalsOutside()` 是為這件事做的，而且它自己有回歸測試守著。
   */
  const fix = recalcNormalsOutside(out);
  if (fix.ok) out = fix.mesh;

  /**
   * 標記搬移：**沒被導的邊照搬，被導掉的邊上的標記會消失** ——
   * 那條邊真的不存在了（換成一片斜切面），所以跟著走是正確的。
   * ⚠ 但要數出來讓呼叫端講一句，不要安靜消失。
   */
  const di = out._vertIndex();
  const have = new Map();
  for (const he of out.edges()) have.set(kOf(di.get(he.v.id), di.get(he.to.id)), he);
  const to = i => clean.remap.get(i);
  let lostMarks = 0;
  for (const he of mesh.edges()) {
    const m = mesh.marksOf(he);
    if (Mesh.marksEmpty(m)) continue;
    if (isCut(he.v, he.to)) { lostMarks++; continue; }        // 這條邊被導掉了
    const f = he.face || (he.twin && he.twin.face);
    if (!f) { lostMarks++; continue; }
    const side = (he.face === f) ? he : he.twin;
    const a = to(repForEdge(f, side, side.v)), b = to(repForEdge(f, side, side.to));
    const dst = (a === undefined || b === undefined) ? null : have.get(kOf(a, b));
    if (dst) out.applyMarks(dst, m); else lostMarks++;
  }

  /**
   * 🔴 **曲面上導角，斜切面本身不會是平的 —— 那是取捨，不是 bug。**
   *
   * 斜切面的四個角是「兩個相鄰面各自的偏移點」。而偏移是**沿著沒被導的那條邊滑**
   * （見上方那則說明），所以相鄰邊不垂直於被導的邊時，
   * 兩端滑的距離不一樣 → 那四個點**不共面**。
   *
   * ⚠ **不可能兩邊都平**：改成「垂直偏移」的話斜切面會變平，
   * 但**旁邊那個吸收它的面會不平** —— 而弄壞一個使用者沒碰過的既有面，
   * 比新長出來的斜切面不平糟得多。所以選現在這個。
   *
   * 實測佐證（320 組隨機選法）：**不平的面全部是 4 邊形（斜切面），
   * 被吸收的 n 邊形一個都沒有不平**。最大偏離 0.11 cm ＝ 可切容許值的 11 倍。
   *
   * ⛔ **不要擋掉** —— 方塊、圓柱那些常見情形本來就是平的（實測 0 個），
   * 只有真的曲面才會遇到，而那時使用者需要的是**知道**，不是被拒絕。
   * 〔坑第 18 條：誤報比漏報更糟；鐵律三：把數字講出來讓他自己判斷〕
   */
  const np = nonPlanarFaces(out);
  const npWorst = np.reduce((a, x) => Math.max(a, x.dev), 0);

  return {
    ok: true, mesh: out, edges: cut.size, walls, corners, clamped, lostMarks,
    nonPlanar: np.length, nonPlanarWorst: npWorst
  };
}

// ═══════════════════════════════════════════════════════
//  法向：重算外側 ／ 翻面
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **把整個網格的面繞向重算成「一致而且朝外」。**（＝ Blender 的 Recalculate Outside）
 *
 * ── 為什麼這一支比路線圖上任何一項都急 ──────────────────
 * **繞向錯了畫面上完全看不出來**（three.js 預設雙面打光），而它會讓
 * STL 送去列印時被切片軟體判成非流形。這個專案已經為它踩過坑第 29 條，
 * 導角實測又中一次（錯的繞向體積 99750、畫面完全正常）。
 *
 * 🔴 **而 `out/stl.js` 早就在報這件事**（「法向朝內（體積算出來是負的），
 * 印出來會內外相反」）—— **卻沒有給任何修法**。
 * 講了問題卻沒有出路，那是坑第 11 條的近親。這一支就是那個出路。
 *
 * ── 兩種完全不同的病，一起治 ────────────────────────────
 *
 * | 病 | 現有的檢查抓不抓得到 |
 * |---|---|
 * | **① 相鄰面互相矛盾**（同一條邊在兩個面裡同方向）| ✅ 抓得到 —— `fromFaceList()` 會配不到 twin，變成非流形 ＋ 不封閉 |
 * | **② 一致但整個內外顛倒** | ❌ **完全抓不到** —— `closed=true`、`ok=true`、沒有 issues，**只有體積是負的** |
 *
 * ⚠ 實測還有一個更陰險的：**兩個分開的物件一正一反，總體積剛好 0**，
 * 而 `closed=true ok=true`。所以**內外要逐個連通元件各自判斷**，不能看總體積。
 *
 * ── 做法 ────────────────────────────────────────────
 * 1. 用**無向邊**建鄰接表 —— 這是關鍵：繞向不一致時 twin 根本沒配上，
 *    走半邊結構走不過去，只有無向邊配得起來
 * 2. 泛洪，讓每個連通元件內部繞向一致（同方向 ＝ 矛盾 ＝ 要翻）
 * 3. **每個元件各自**算有號體積，負的就整組翻過來
 *
 * ⚠ **開放的元件（板件、被刪過面的）不判內外，只做一致化。**
 * 「外側」對一張沒有厚度的曲面在數學上沒有定義 ——
 * 實測平板體積 0、折板 44929（一個沒有意義的數字）。
 * 硬猜會有一半機率猜反，而**猜反的後果跟原本的病一樣嚴重**。
 * 那種情形要靠使用者自己按「翻面」。
 *
 * @param {Mesh} mesh
 * @returns {{ok:boolean, reason?:string, mesh?:Mesh,
 *            fixedInconsistent:number, flippedComponents:number,
 *            components:number, openComponents:number, ambiguousEdges:number}}
 */
export function recalcNormalsOutside(mesh) {
  const base = {
    fixedInconsistent: 0, flippedComponents: 0,
    components: 0, openComponents: 0, ambiguousEdges: 0
  };
  if (!mesh || !mesh.faces.length) {
    return { ...base, ok: false, reason: '沒有網格可以重算' };
  }

  const vi = mesh._vertIndex();
  const points = mesh.verts.map(v => v.p.clone());
  const faces = mesh.faces.map(f => mesh.faceVerts(f).map(v => vi.get(v.id)));
  const kOf = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

  /**
   * 🔴 **一定要用無向邊。**
   * 繞向不一致時 `fromFaceList()` 配不到 twin（它只配 `a→b` 與 `b→a`），
   * 那兩個面在半邊結構裡是**走不過去的**。而這一支要修的正是那種網格 ——
   * 所以不能靠 `he.twin`，要自己用無向邊配一次。
   */
  const byEdge = new Map();
  faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      const k = kOf(f[i], f[(i + 1) % f.length]);
      if (!byEdge.has(k)) byEdge.set(k, []);
      byEdge.get(k).push(fi);
    }
  });

  /** 面 fi 上這條無向邊往哪個方向走：+1 ＝ a→b、−1 ＝ b→a、0 ＝ 不在這個面上 */
  const dirIn = (fi, a, b) => {
    const f = faces[fi];
    for (let i = 0; i < f.length; i++) {
      const x = f[i], y = f[(i + 1) % f.length];
      if (x === a && y === b) return 1;
      if (x === b && y === a) return -1;
    }
    return 0;
  };

  const comp = new Array(faces.length).fill(-1);
  const flip = new Array(faces.length).fill(false);
  const groups = [];
  const ambiguous = new Set();
  let fixedInconsistent = 0;

  for (let seed = 0; seed < faces.length; seed++) {
    if (comp[seed] !== -1) continue;
    const id = groups.length;
    const members = [seed];
    comp[seed] = id;
    const stack = [seed];

    while (stack.length) {
      const fi = stack.pop();
      const f = faces[fi];
      for (let i = 0; i < f.length; i++) {
        const a = f[i], b = f[(i + 1) % f.length];
        const key = kOf(a, b);
        const share = byEdge.get(key) || [];
        /**
         * 3 個以上的面共用一條邊 ＝ **真的非流形**，不是繞向問題。
         * 這一支修不了它（「外側」在那種邊上沒有定義），**記下來並回報**，
         * 不要假裝處理過了。〔查不到就明寫查不到〕
         */
        if (share.length > 2) ambiguous.add(key);
        for (const nb of share) {
          if (nb === fi || comp[nb] !== -1) continue;
          // 一致 ＝ 鄰居走反方向。同方向就是矛盾，要把鄰居翻過來。
          const needFlip = (dirIn(nb, a, b) * (flip[fi] ? -1 : 1)) === 1;
          comp[nb] = id;
          flip[nb] = needFlip;
          if (needFlip) fixedInconsistent++;
          members.push(nb);
          stack.push(nb);
        }
      }
    }
    groups.push(members);
  }

  const oriented = faces.map((f, i) => (flip[i] ? f.slice().reverse() : f));

  let flippedComponents = 0, openComponents = 0;
  for (const members of groups) {
    /**
     * 這個元件封不封閉：**元件內部**每條邊都剛好被兩個面用到才算。
     * ⚠ 用元件自己的邊數判斷，不要問 `mesh.isClosed()` —— 那是整個網格的事，
     * 而「兩個物件其中一個是開放的」時它會回答錯的那一邊。
     */
    const count = new Map();
    for (const fi of members) {
      const f = oriented[fi];
      for (let i = 0; i < f.length; i++) {
        const k = kOf(f[i], f[(i + 1) % f.length]);
        count.set(k, (count.get(k) || 0) + 1);
      }
    }
    let closed = true;
    for (const n of count.values()) if (n !== 2) { closed = false; break; }
    if (!closed) { openComponents++; continue; }   // 開放 → 只做一致化，不猜內外

    /** 有號體積（散度定理）。非凸的面照樣對 —— 有號量會自己抵銷掉多算的部分 */
    let vol = 0;
    for (const fi of members) {
      const f = oriented[fi];
      for (let i = 2; i < f.length; i++) {
        const a = points[f[0]], b = points[f[i - 1]], c = points[f[i]];
        vol += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
      }
    }
    if (vol < 0) {
      for (const fi of members) oriented[fi] = oriented[fi].slice().reverse();
      flippedComponents++;
    }
  }

  const info = {
    fixedInconsistent, flippedComponents,
    components: groups.length, openComponents,
    ambiguousEdges: ambiguous.size
  };

  /**
   * ⚠ **本來就是對的就什麼都不要做，而且要講一句。**
   * 悶著記一步「什麼都沒改」的 Undo，使用者會以為壞掉了（跟壓平同一條）。
   */
  if (!fixedInconsistent && !flippedComponents) {
    const why = [];
    if (openComponents) {
      why.push(`有 ${openComponents} 個開放的面（沒有厚度的殼），`
             + `「外側」對它們沒有定義 —— 方向不對請按「翻面」`);
    }
    if (ambiguous.size) why.push(`${ambiguous.size} 條邊被 3 個以上的面共用（真的非流形），這支修不了`);
    return {
      ...info, ok: false,
      reason: why.length ? `法向本來就是一致的。${why.join('；')}`
                         : '法向本來就一致而且朝外，沒有東西要修'
    };
  }

  const out = Mesh.fromFaceList(points, oriented);
  out.computeNormals();
  mesh._copyMarksTo(out);

  /**
   * 🔴 **把「假邊界」帶進來的 CUT 清掉。**
   *
   * 繞向不一致時，`fromFaceList()` 配不到 twin（它只配 `a→b` 與 `b→a`，
   * 同方向就配不上），那些邊被當成邊界、自動標了 CUT。
   * 這一支把繞向修好之後它們變回內部邊，**而 CUT 已經跟著搬進來了** ——
   * 症狀是**修一個繞向壞掉的模型，畫面上憑空多出幾條分片線**（實測方塊多 4 條）。
   *
   * ⚠ 規則與「補洞」共用同一支（`clearBoundaryOnlySeams`）——
   * **同一條規則只寫一次**，兩邊對不上時不會有第二份可以讀錯。
   */
  clearBoundaryOnlySeams(mesh, out, null);

  return { ...info, ok: true, mesh: out };
}

/**
 * 把整個網格的面繞向**全部翻過來**（＝ Blender 的 Flip Normals，整體版）。
 *
 * ⚠ **刻意只做「整個網格」，不做「選取的面」。**
 * 翻一部分的面會做出「相鄰面互相矛盾」的網格 —— 那正是
 * `recalcNormalsOutside()` 要修的病，我們沒有理由提供一個製造它的按鈕。
 * 而實際的痛點本來就是整件事：**匯進來或算出來的東西整個內外相反**。
 *
 * 這一支存在的理由是**開放的網格**：「外側」對一張沒有厚度的曲面沒有定義，
 * 重算那一支不會去猜，所以要留一個讓使用者自己決定的入口。
 */
export function flipNormals(mesh) {
  if (!mesh || !mesh.faces.length) return { ok: false, reason: '沒有網格可以翻' };
  const vi = mesh._vertIndex();
  const points = mesh.verts.map(v => v.p.clone());
  const faces = mesh.faces.map(f => mesh.faceVerts(f).map(v => vi.get(v.id)).reverse());
  const out = Mesh.fromFaceList(points, faces);
  out.computeNormals();
  /**
   * ⚠ 標記照樣要搬。翻繞向只改「每個面裡頂點的順序」，**頂點索引沒變**，
   * 所以索引配對照樣對得上（`transformed()` 的鏡射那條路早就在用同一招）。
   */
  mesh._copyMarksTo(out);
  return { ok: true, mesh: out, faces: faces.length };
}

// ═══════════════════════════════════════════════════════
//  變換：記下初始座標，每一幀從初始值重算
// ═══════════════════════════════════════════════════════

/**
 * 拖曳開始時，把這些頂點現在的座標拍一份下來。
 *
 * 🔴 **這一份是整個互動模型的地基。**
 * 舊做法是**增量累加**（這一幀的位置減上一幀），而它是被逼出來的：
 * 頂點跟著移動之後元素重心也跟著跑，拿絕對值算會每幀重複套用一次，
 * 一拖就飛出去。記下初始座標之後**那個問題自動消失** ——
 * 因為每一幀都是「從沒動過的樣子重算一次」，不是疊在上一幀的結果上。
 *
 * 而真正的收穫不是手感，是**這些東西跟著變成免費的**：
 * 取消（把這份寫回去就好）、旋轉與縮放（增量累加根本做不對）、
 * 拖到一半直接打數字（把數字套上去跟把拖曳量套上去是同一段程式）、
 * 以及不累積浮點誤差。
 * 〔`外部參考-Blender編輯.md` 第 5 節：Blender 的 `iloc`〕
 */
export function snapshotVerts(verts) {
  return (verts || []).map(v => v.p.clone());
}

/** 把快照寫回去 ＝ 取消。取消因此不是一個功能，是「什麼都不做」。 */
export function restoreVerts(verts, base) {
  if (!verts || !base || verts.length !== base.length) return 0;
  for (let i = 0; i < verts.length; i++) verts[i].p.copy(base[i]);
  return verts.length;
}

/**
 * 把 gizmo 替身「從開始到現在」的變換，套到那份初始座標上。
 *
 * 替身在拖曳開始時位於 `start`（位置 ＝ 元素中心、旋轉 ＝ 方向基底、縮放 ＝ 1），
 * 現在位於 `now`。兩者相除就是這一次拖曳做了什麼，套到初始座標上即可。
 *
 * **移動、旋轉、縮放共用這一段** —— 只拖移動時 `now.quat === start.quat`
 * 且 `now.scale` 是 1，矩陣自然退化成純位移，不必分支。
 *
 * ⚠ 縮放是在**替身自己的座標系**裡發生的（`start.quat` 決定），
 * 所以方向切到「法向」之後，縮放也跟著沿法向與切線走 ——
 * 三個概念正交的好處在這裡直接兌現。
 *
 * @param {Vertex[]} verts
 * @param {THREE.Vector3[]} base 對應 verts 的初始座標（snapshotVerts 拍的）
 * @param {{pos:THREE.Vector3, quat:THREE.Quaternion}} start
 * @param {{pos:THREE.Vector3, quat:THREE.Quaternion, scale?:THREE.Vector3}} now
 * @returns {number} 實際寫入的頂點數
 */
export function applyElementTransform(verts, base, start, now) {
  if (!verts || !base || verts.length !== base.length || !verts.length) return 0;
  if (!start || !now) return 0;

  const ONE = new THREE.Vector3(1, 1, 1);
  const m0 = new THREE.Matrix4().compose(start.pos, start.quat, ONE);
  const m1 = new THREE.Matrix4().compose(now.pos, now.quat, now.scale || ONE);
  const m = m1.multiply(m0.invert());

  for (let i = 0; i < verts.length; i++) verts[i].p.copy(base[i]).applyMatrix4(m);
  return verts.length;
}

// ═══════════════════════════════════════════════════════
//  平面性檢查
// ═══════════════════════════════════════════════════════

/**
 * 這個面還平不平？
 *
 * 三角形恆為平面，直接回 true（不是偷懶，是幾何事實）。
 * 四邊形以上用 Newell 法向定一個平面，量最遠的頂點離平面多少。
 *
 * @returns {{planar:boolean, dev:number}} dev ＝ 最大偏離，單位 cm
 */
export function facePlanarity(mesh, face, tolCm = PLANAR_TOL_CM) {
  const vs = mesh.faceVerts(face);

  /**
   * 🔴 **先分辨「被壓成零面積」與「不平」——這是兩件事。**
   *
   * 〔2026-08-23 kang 實測抓到：擠出 20 之後把蓋子拉回原位，側牆被壓扁成
   * 　零面積，而舊版把它回報成「4 個面不平了」。**偵測是對的，講出來的
   * 　意思是錯的** —— 坑第 20 條的另一次。〕
   *
   * 零面積的面其實**是平的**（所有點都在同一條線上），所以 planar 回 true；
   * 真正該講的是「它被壓扁了」，那要另外一個欄位。
   */
  /**
   * ⚠ 走 `mesh.faceTriangles()`，**不要自己扇形切**。
   * 這裡只拿面積判「是不是零面積」，多算一點不致命 ——
   * 但全專案只留一個三角化入口，留一個例外就等於規則沒立起來
   * （那個 `for (let i = 2; ...)` 的模式曾經有 8 個出口，每一個都是同一個 bug）。
   */
  let area = 0;
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (const [x, y, z] of mesh.faceTriangles(face)) {
    ab.subVectors(y.p, x.p);
    ac.subVectors(z.p, x.p);
    area += ab.cross(ac).length() / 2;
  }
  if (area < 1e-9) return { planar: true, dev: 0, area, degenerate: true };

  if (vs.length <= 3) return { planar: true, dev: 0, area, degenerate: false };

  const n = mesh.computeFaceNormal(face);
  if (n.lengthSq() < 1e-12) return { planar: true, dev: 0, area, degenerate: true };
  const c = new THREE.Vector3();
  for (const v of vs) c.add(v.p);
  c.divideScalar(vs.length);
  let dev = 0;
  const t = new THREE.Vector3();
  for (const v of vs) {
    dev = Math.max(dev, Math.abs(t.subVectors(v.p, c).dot(n)));
  }
  return { planar: dev <= tolCm, dev, area, degenerate: false };
}

/**
 * 被壓成零面積的面。
 *
 * 最常見的來路：擠出一段之後又把蓋子拉回原位，側牆就被壓扁了。
 * **不是錯誤** —— 使用者可能就是要把那一段收回去。但它值得講一聲，
 * 因為零面積的面沒有法向，畫面上會閃、折線判定也會亂跳。
 */
export function degenerateFaces(mesh) {
  const out = [];
  for (const f of mesh.faces) {
    const r = facePlanarity(mesh, f);
    if (r.degenerate) out.push(f);
  }
  return out;
}

/**
 * 整個網格上有哪些面已經不平了。
 *
 * 給介面用來提醒 —— **不擋**。程式沒資格替人決定做不做得出來
 * （跟指定分片「只做強制切開」同一條），而且剖面分切那條路
 * 本來就不在乎面平不平。只有「展開」在乎。
 */
export function nonPlanarFaces(mesh, tolCm = PLANAR_TOL_CM) {
  const out = [];
  for (const f of mesh.faces) {
    const r = facePlanarity(mesh, f, tolCm);
    if (!r.planar) out.push({ face: f, dev: r.dev });
  }
  return out;
}

// ═══════════════════════════════════════════════════════
//  擠出面（第 6 期第二刀）
// ═══════════════════════════════════════════════════════

/**
 * 一個共面區域的**有序**邊界迴圈（可能不只一個，例如中間有洞的面）。
 *
 * `regionBoundaryEdges()` 回傳的是無序線段，畫標示夠用；
 * 擠出要生側牆，就必須知道**繞的方向**，否則側牆的法向會朝內 ——
 * 而那在畫面上完全看不出來（坑第 29 條）。
 *
 * 半邊本來就繞著面轉，方向跟面的繞向一致，所以串起來的迴圈方向
 * 自然就是「從外面看，繞著這個區域走」的方向。不必自己判斷方向。
 *
 * @returns {Array<HalfEdge[]>} 每個迴圈是首尾相接的一串半邊
 */
export function boundaryLoops(mesh, regionFaces) {
  const inRegion = new Set(regionFaces);
  const bnd = [];
  for (const f of regionFaces) {
    for (const he of mesh.faceLoop(f)) {
      if (he.twin && he.twin.face && inRegion.has(he.twin.face)) continue;
      bnd.push(he);
    }
  }
  const byStart = new Map();
  for (const he of bnd) {
    if (!byStart.has(he.v)) byStart.set(he.v, []);
    byStart.get(he.v).push(he);
  }
  const used = new Set();
  const loops = [];
  for (const start of bnd) {
    if (used.has(start)) continue;
    const loop = [];
    let cur = start;
    while (cur && !used.has(cur)) {
      used.add(cur);
      loop.push(cur);
      const nexts = (byStart.get(cur.to) || []).filter(h => !used.has(h));
      // ⚠ 一個頂點上有兩條以上待接的邊界邊 ＝ 區域在那裡「捏」成一點。
      //   隨便挑一條就可能串出扭曲的迴圈。真的遇到再處理，先不假裝有解。
      cur = nexts.length === 1 ? nexts[0] : null;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

/**
 * 擠出一個面：**從它長出新的一段**。做鹿角的那個動作。
 *
 * ⚠ 這跟「拉面」（`moveElement`）不是同一件事：
 * 拉面是把既有的面搬走，方塊拉完還是六個面；
 * **擠出是長出新的一段**，方塊擠完會多出四面側牆。
 *
 * ── 為什麼走「拆掉重建」而不是半邊手術 ────────────────────
 * `mesh.js` 完全沒有改拓撲的 API，半邊手術要從零長出一整層，
 * 而且接線錯了不會報錯，只會產生一個結構壞掉的網格。
 * `Mesh.fromFaceList()` 是現成的、驗過的，而且只要**既有頂點保持原索引、
 * 新頂點往後追加**，標記的索引配對就還對得上。
 *
 * ── 側牆的繞向 ──────────────────────────────────────
 * 邊界半邊 a→b（繞著區域走）對應的側牆是 **(a, b, b', a')**，
 * `'` 是偏移後的新頂點。這個順序是兩條獨立的路得到的同一個答案：
 * 手算一個例子的 Newell 法向，以及對照 `build/extrude.js` 第 91 行
 * 那支已經驗過的側牆（它踩過「體積 −500000」那個坑）。
 *
 * ── 只做封閉的那一種 ────────────────────────────────
 * Blender 手冊分兩種：邊界邊只屬於一個面時**複製**選取的面，
 * 否則**不複製**（免得留一個面在實體裡面）。
 * 這裡只做後者（封閉網格），開放邊緣**擋下來並說明原因** ——
 * 前者要決定「複製還是搬移」，那是使用者的取捨，不該由我猜。
 * 而且板件（開放曲面）本來就不在第 6 期的支援範圍內。
 *
 * @param {number} dist 沿面法向的距離；負值 ＝ 往內凹
 * @returns {{ok:boolean, mesh?:Mesh, reason?:string, walls?:number, loops?:number}}
 */
export function extrudeFace(mesh, face, dist, opt = {}) {
  const tolDeg = opt.tolDeg ?? 0.5;
  const cornerDeg = opt.cornerDeg ?? DEFAULT_CORNER_DEG;

  if (!face) return { ok: false, reason: '沒有選到面' };
  if (!Number.isFinite(dist) || Math.abs(dist) < 1e-12) {
    return { ok: false, reason: '擠出距離不能是 0' };
  }

  const reg = regionOf(mesh, face, tolDeg);
  if (!reg.faces.length) return { ok: false, reason: '找不到這個面所在的共面區域' };
  const inRegion = new Set(reg.faces);

  // 邊界邊一定要有隔壁 —— 開放邊緣的行為還沒定案（見上方說明）
  for (const f of reg.faces) {
    for (const he of mesh.faceLoop(f)) {
      if (he.twin && he.twin.face && inRegion.has(he.twin.face)) continue;
      if (!he.twin || !he.twin.face) {
        return { ok: false, reason: '這個面在網格的開放邊緣上，擠出還不支援' };
      }
    }
  }

  const loops = boundaryLoops(mesh, reg.faces);
  if (!loops.length) {
    return { ok: false, reason: '串不出這個面的邊界（形狀太特殊，例如捏成一點）' };
  }

  const n = mesh.computeFaceNormal(face).clone();
  if (n.lengthSq() < 1e-12) return { ok: false, reason: '算不出這個面的法向' };
  const off = n.clone().multiplyScalar(dist);

  // ── 頂點：既有的保持原索引，新的往後追加 ──
  const vi = mesh._vertIndex();
  const points = mesh.verts.map(v => v.p.clone());
  const dup = new Map();                       // 邊界頂點 → 新頂點的索引

  const bndVerts = new Set();
  for (const loop of loops) for (const he of loop) bndVerts.add(he.v);

  for (const v of bndVerts) {
    dup.set(v, points.length);
    points.push(v.p.clone().add(off));
  }
  /**
   * 內部頂點（只有這個區域在用的）**直接搬，不複製**。
   * 複製的話原本那個就沒有任何面在用了 —— 變成孤點，
   * 而孤點不會報錯，只會讓頂點數對不上、尤拉數算錯。
   */
  for (const v of reg.verts) {
    if (bndVerts.has(v)) continue;
    points[vi.get(v.id)] = v.p.clone().add(off);
  }

  const idxOf = v => (dup.has(v) ? dup.get(v) : vi.get(v.id));

  // ── 面 ──
  const faces = [];
  /**
   * 記下「被點到的那個面」在新網格裡的位置。
   *
   * 擠完之後呼叫端要立刻把它選起來，箭頭才會停在新長出來的蓋子上 ——
   * 使用者可以直接用「拉面」調到想要的長度。
   * 沒有這個的話，擠完畫面上什麼都沒選中，他得自己再點一次那個面，
   * 而那個面剛剛才移動過，不一定點得到同一個。
   */
  let capIdx = -1;
  for (const f of mesh.faces) {
    if (f === face) capIdx = faces.length;
    faces.push(inRegion.has(f)
      ? mesh.faceVerts(f).map(idxOf)                     // 蓋子改指向新頂點
      : mesh.faceVerts(f).map(v => vi.get(v.id)));       // 其餘原封不動
  }
  let walls = 0;
  for (const loop of loops) {
    for (const he of loop) {
      faces.push([vi.get(he.v.id), vi.get(he.to.id), dup.get(he.to), dup.get(he.v)]);
      walls++;
    }
  }

  const out = Mesh.fromFaceList(points, faces);

  /**
   * ── 標記的搬移 ──────────────────────────────────────
   * 先用 `_copyMarksTo()` 搬「索引配對沒變」的那些邊：區域外的邊、
   * 以及邊界邊（它現在是側牆與鄰居之間那條）。
   *
   * ⚠ **蓋子內部的邊搬不到** —— 它的兩個端點都換成新頂點了，
   * 索引配對整組不同。所以底下要自己再搬一次。
   * 直接信任 `_copyMarksTo()` 的話，蓋子上使用者標的分片會安靜消失。
   */
  mesh._copyMarksTo(out);

  // ⚠ 一定要先建索引表。寫成 `out.verts.indexOf(he.v)` 是「對每條邊查一次
  //   全部頂點」＝ O(頂點×邊)，正是坑第 3 條。擠出一個描圖輪廓動輒上千頂點。
  const outIdx = new Map(out.verts.map((v, i) => [v.id, i]));
  const key = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;
  const byPair = new Map();
  for (const he of out.edges()) {
    byPair.set(key(outIdx.get(he.v.id), outIdx.get(he.to.id)), he);
  }

  for (const he of mesh.edges()) {
    if (!he.face || !he.twin || !he.twin.face) continue;
    if (!inRegion.has(he.face) || !inRegion.has(he.twin.face)) continue;   // 只有蓋子內部
    const to = byPair.get(key(idxOf(he.v), idxOf(he.to)));
    if (!to) continue;
    // 🔴 整包搬，不要手寫「搬哪幾樣」—— 見 copyMarksThroughRemap() 的說明
    out.applyMarks(to, mesh.marksOf(he));
  }

  /**
   * ── 新的垂直邊要不要算平滑：**只繼承，不猜** ──────────────
   *
   * 側牆的垂直邊，是把「原網格上那條邊」往外延長了一段。
   * 例如擠出圓柱的頂面，新的垂直邊就是圓柱既有垂直邊的延伸。
   * **所以直接問那條邊就好**，不必從幾何猜。
   *
   * 找法：邊界頂點 v 上，兩條邊界邊的隔壁面是 N1 與 N2，
   * 它們之間那條（也通過 v 的）邊，就是被延長的那一條。
   *
   * ⚠ **刻意不做「轉角小於 3 度就算平滑」那種猜測。**
   * 標成 smooth 的意思是「這裡不算折線」，猜錯的後果是**漏掉一道折彎**，
   * 而展開圖漏折彎 ＝ 東西做出來是錯的。標多了只是多一道折線，安全得多。
   * **這個方向上不對稱，所以寧可不猜。**
   *
   * ⚠ 實查（2026-08-23）：九種參數體**一條 smooth 都沒標**，
   * 只有匯入的擠出件會標（它有貝茲錨點這個上游）。所以擠出參數體的面時，
   * 垂直邊一律不算平滑 —— 那是對的：32 邊形跟「真的做成 32 面的角柱」
   * 幾何上完全一樣，分不出來（坑第 10 條）。
   */
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const prev = loop[(i - 1 + loop.length) % loop.length], cur = loop[i];
      const N1 = prev.twin && prev.twin.face, N2 = cur.twin && cur.twin.face;
      if (!N1 || !N2 || N1 === N2) continue;      // 同一個鄰居繞過來，中間沒有邊
      const src = mesh.vertOutgoing(cur.v).find(h =>
        h.twin && ((h.face === N1 && h.twin.face === N2) ||
                   (h.face === N2 && h.twin.face === N1)));
      if (!src) continue;
      /**
       * ⚠ **繼承 `smooth` 與 `hard`，但不繼承 `role`。**
       *
       * `smooth`／`hard` 講的是「這條邊是什麼」（造型的一部分／使用者刻意
       * 加的），被延長之後仍然成立。`role` 講的是「這條邊要怎麼加工」——
       * 那是使用者對**某一條特定的邊**下的決定，不該自己長到新的邊上去
       * （擠出一個標了 CUT 的頂面，側牆的垂直邊不該憑空變成切割線）。
       *
       * 🔴 `hard` 這一項是 2026-08-24 補的：環切過的邊被擠出延長時，
       * 新的那一段一樣是共面的 —— 不繼承的話它會看不見、點不到，
       * 而且兩片側牆會被併成一片。
       */
      if (!src.smooth && !src.hard) continue;
      const he = byPair.get(key(vi.get(cur.v.id), dup.get(cur.v)));
      if (he) out.applyMarks(he, { smooth: src.smooth, hard: src.hard });
    }
  }

  out.computeNormals();
  return {
    ok: true, mesh: out, walls, loops: loops.length,
    // `fromFaceList` 只會跳過「少於 3 個點」的面，而網格裡不存在那種，
    // 所以索引是一一對應的。仍然防一手，對不到就回 null 讓呼叫端自己處理。
    capFace: (capIdx >= 0 && capIdx < out.faces.length) ? out.faces[capIdx] : null
  };
}

// ═══════════════════════════════════════════════════════
//  改完之後的連帶重算
// ═══════════════════════════════════════════════════════

/**
 * 重標折線，**但保留使用者標的 CUT**。
 *
 * 跟 `mesh.autoMarkFolds()` 有兩個差別，兩個都是刻意的：
 *
 * 1. **CUT 一律不動。** 那是使用者的決定，不是計算結果。
 *    直接呼叫 autoMarkFolds() 會把它洗回 FOLD。
 * 2. **會清掉過期的 FOLD**（autoMarkFolds 只加不減）。
 *    一條折線被拉平之後仍標著 FOLD，目前不會害到展開圖
 *    （flatten.js 另外檢查實際夾角），但它會讓「這條邊是什麼」
 *    這個問題有兩個互相矛盾的答案 —— 而下一個人只會讀其中一個。
 *
 * 前置：**必須先 computeNormals()**，否則 isFlat() 讀到的是舊法向。
 * 走 refreshAfterEdit() 就不用自己記這件事。
 *
 * @returns {{added:number, cleared:number, kept:number}}
 */
export function remarkFolds(mesh, tolDeg = FLAT_TOL_DEG) {
  let added = 0, cleared = 0, kept = 0;
  for (const he of mesh.edges()) {
    if (!he.twin || !he.face || !he.twin.face) continue;   // 邊界一律是切割線
    if (he.role === EDGE_ROLE.CUT) { kept++; continue; }   // ★ 使用者的決定
    const flat = mesh.isFlat(he, tolDeg);
    if (!flat && he.role !== EDGE_ROLE.FOLD) { mesh.setRole(he, EDGE_ROLE.FOLD); added++; }
    else if (flat && he.role === EDGE_ROLE.FOLD) { mesh.setRole(he, EDGE_ROLE.FREE); cleared++; }
  }
  return { added, cleared, kept };
}

/**
 * 使用者把邊拉出角度了 → 把 `smooth` 關掉。**單向，只關不開。**
 *
 * ── 為什麼一定要做 ────────────────────────────────────
 * `flatten.js` 有這一行：
 *
 *     if (Math.abs(角度) > FLAT_TOL_DEG && !he.smooth)   // 是 smooth 就永遠不算折線
 *
 * 只要 `smooth` 還寫著 true，**夾角拉到 30 度它照樣不算折線**，
 * 展開長度就錯了 —— 而圖看起來完全正常。
 *
 * ── 為什麼反向不成立 ──────────────────────────────────
 * 原本是**真轉角**的邊，被拉到剛好共線，不該自動變成 smooth。
 * 共線可能只是巧合，而 `smooth` 回答的是「這是不是造型的一部分」，
 * 那個答案只有上游知道（貝茲錨點、參數體），幾何猜不出來。
 * 關掉是安全的（頂多多標一道折線），打開是危險的（會漏掉一道折線）。
 *
 * 判準：**使用者拉那個點就是故意要它有角度，他的意圖比檔案裡的舊資訊新。**
 *
 * 門檻沿用真轉角那個 3 度（`svgPath.js` 的 DEFAULT_CORNER_DEG），
 * 不另外發明一個數字 —— 那個數字抄自 kang 自己在用的 SideUnfold.jsx，
 * 他驗過很多次。
 *
 * 前置：**必須先 computeNormals()**。
 *
 * @returns {number} 被關掉的邊數
 */
export function demoteSmooth(mesh, cornerDeg = DEFAULT_CORNER_DEG) {
  let n = 0;
  for (const he of mesh.edges()) {
    if (!he.smooth) continue;
    const d = mesh.dihedral(he);
    if (d === null) continue;                    // 邊界邊沒有夾角，不動它
    if (Math.abs(d) * DEG > cornerDeg) { mesh.setSmooth(he, false); n++; }
  }
  return n;
}

/**
 * 改完幾何之後跑這一支。順序不能換：
 *
 *   法向 → 折線 → smooth
 *
 * 後兩者都要問 dihedral()，而 dihedral() 讀的是 `face.normal`。
 * 法向沒先算，後面兩步全部是拿舊資料在判斷。
 *
 * ⚠ **不要放進拖曳的每一幀。** 它走訪所有的邊，是 O(邊數)。
 * 放開滑鼠時跑一次就好（坑第 3、22 條）。
 *
 * @returns {{folds:object, smoothOff:number, nonPlanar:number}}
 */
export function refreshAfterEdit(mesh, opts = {}) {
  const tolDeg = opts.flatTolDeg ?? FLAT_TOL_DEG;
  const cornerDeg = opts.cornerDeg ?? DEFAULT_CORNER_DEG;
  mesh.computeNormals();
  const folds = remarkFolds(mesh, tolDeg);
  const smoothOff = demoteSmooth(mesh, cornerDeg);
  const nonPlanar = nonPlanarFaces(mesh, opts.planarTolCm ?? PLANAR_TOL_CM).length;
  const degenerate = degenerateFaces(mesh).length;
  return { folds, smoothOff, nonPlanar, degenerate };
}
