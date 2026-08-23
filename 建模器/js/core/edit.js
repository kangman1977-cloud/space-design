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
 * @param {object} el {kind:'vertex'|'edge'|'face', vert?, he?, face?}
 * @param {number} tolDeg 共面容許值（face 才用得到）
 * @returns {Vertex[]} 去重過的頂點清單；認不得的 kind 回傳空陣列
 */
export function elementVerts(mesh, el, tolDeg = 0.5) {
  if (!el) return [];
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
 * gizmo 要掛在哪裡 ＝ 涉及頂點的重心。
 *
 * 用重心而不是「面的中心點」，是因為三種 kind 這樣就能共用同一段 ——
 * 單一頂點的重心就是它自己，一條邊的重心就是中點。
 */
export function elementCenter(mesh, el, tolDeg = 0.5) {
  const vs = elementVerts(mesh, el, tolDeg);
  const c = new THREE.Vector3();
  if (!vs.length) return c;
  for (const v of vs) c.add(v.p);
  return c.divideScalar(vs.length);
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
 * ⚠ **目前沒有任何介面呼叫這一支**（2026-08-23 查證）。
 * UI 的「拉面」走的是 `moveElement()` ＋ gizmo 的自由三軸位移。
 * 這支留著是因為測試涵蓋得到、而且日後要推**非軸向的斜面**時就需要它 ——
 * 軸向的面用 gizmo 那根對應的箭頭就等於沿法向了。
 *
 * 〔曾經在規格檔寫成「拉面預設沿法向」，那是假的：那個開關不存在。
 * 　kang 實測截圖照出來的。鐵律六「不要寫一個不存在的退路」。〕
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
  let area = 0;
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (let i = 2; i < vs.length; i++) {
    ab.subVectors(vs[i - 1].p, vs[0].p);
    ac.subVectors(vs[i].p, vs[0].p);
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
    if (he.role !== EDGE_ROLE.FREE) out.setRole(to, he.role);
    if (he.smooth) out.setSmooth(to, true);
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
      if (!src || !src.smooth) continue;
      const he = byPair.get(key(vi.get(cur.v.id), dup.get(cur.v)));
      if (he) out.setSmooth(he, true);
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
