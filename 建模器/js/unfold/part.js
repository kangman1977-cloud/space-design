/**
 * part.js — 文件物件與展開引擎之間的轉接層
 *
 * flatten.js 只認識「網格 ＋ 規則」，不認識 ModelObject；
 * rules.js 只認識材料。兩邊都不該知道文件長什麼樣子。
 * 這個檔案負責把 ModelObject 翻譯成它們看得懂的東西，
 * 再把結果翻回文件的語言（份數、名稱、料表）。
 *
 * 這樣做的好處在第 5、7 期會很明顯：展開引擎換掉演算法，
 * 這裡不用改；文件格式加欄位，flatten.js 也不用改。
 */

import * as THREE from 'three';
import { makeRule, DEFAULT_MATERIAL } from './rules.js';
import { unfoldMesh } from './flatten.js';
import { Mesh } from '../core/mesh.js';
import { mergeCoplanarFaces, cleanRebuild } from '../core/edit.js';
import { PRIM_DEFAULTS } from '../build/prim.js';

/**
 * 展開一個物件。
 *
 * @param {ModelObject} obj
 * @param {object} opt { material, flatTolDeg }
 * @returns {{ok:boolean, reason?:string, pieces, warnings, stats, rule}}
 */
export function unfoldObject(obj, opt = {}) {
  const material = opt.material || DEFAULT_MATERIAL;
  /**
   * ⚠ 〔2026-08-23 不再傳 `k`〕展開流程已經沒有任何東西會用到 K 因子。
   * 詳見 `js/unfold/rules.js` 檔頭與 `PROJECT_LOG.md`「尺寸的依據」。
   */
  let rule = makeRule(material, obj.thickness);

  /**
   * ⚠ 這裡**刻意沒有**「不是板件就拒絕展開」這道門。2026-08-22 拿掉的。
   *
   * 原本擋著，理由是「展開的前提是有板厚的一張料，實體要先抽殼」。
   * 那是鈑金的思路：鐵板折彎時中性層長度不變，所以資料要存中性面，
   * 而實體沒有中性面可言。
   *
   * 但這套工具實際的做法是**切開再接合**（珍珠板、發泡板、木板、壓克力），
   * 接縫銑 45 度斜接，板厚由斜面自動吸收 —— 所以每一片就是切到
   * **外緣尺寸**，而實體的網格本來就是外表面。**直接展開它就是正確答案。**
   *
   * 實測佐證：60×45×40 的實體方塊，展開得到十字型 145×210、
   * 面積 13800 ＝ 2×(60×45 + 60×40 + 45×40)，精確。
   * 擋著的時候使用者只能手動把種類改成「板件」繞過去 ——
   * 得到的數字一模一樣，證明擋的只是標籤，不是幾何。
   *
   * 至於「這一片攤不攤得平」「尺寸可不可信」，flatten.js 有自己的判斷
   * （radialFolds、overlap），不需要靠 kind 這個標籤來猜。
   */

  let mesh = obj.mesh();
  const warn = [];

  /**
   * 縮放要吃進去，否則圖面跟實際做出來的東西不一樣大。
   * 但非等比縮放會把圓弧壓成橢圓，折彎半徑就不再是一個數字，
   * 展開長度也算不準 —— 這種情況只能如實告知。
   */
  const s = obj.scale;
  if (Math.abs(s.x - 1) > 1e-9 || Math.abs(s.y - 1) > 1e-9 || Math.abs(s.z - 1) > 1e-9) {
    mesh = mesh.transformed(new THREE.Matrix4().makeScale(s.x, s.y, s.z));
    const uniform = Math.abs(s.x - s.y) < 1e-9 && Math.abs(s.y - s.z) < 1e-9;
    if (!uniform) {
      warn.push('這個物件被非等比縮放過，圓弧會變成橢圓，展開長度只是近似值。'
              + '建議改參數而不是拉縮放');
    }
  }

  /**
   * 🔴 **實心的板 ＋ 折不了的材料 ⇒ 只出一片外形＋洞**（2026-10-19，實驗 T2、T3、T7：`實驗-綜合評估.md` ①-2）。
   *
   * ⚠ 以前實心一律照外表面攤：鋼筆畫的背板（40 × 60、開一個窗、厚 0.5）拆成上下兩大片＋8 條 0.5 寬的邊條，
   * 而壓克力／木板雷切其實只要**一片**。kang 2026-10-19：「三條都照你的建議做」——
   * 建議是**照材質決定**：折不了的材料（`rule.foldable === false`，目前是壓克力／木板）自動認出實心板；
   * 紙模、珍珠板、帆布、金屬照舊攤成盒子（那些本來就是用多片組成中空盒 ——
   * `io.js` `bakeShelled()` 註解：「想做用紙板組的中空扁盒的話，那正是要的東西」）。
   * ⭐ 認的條件在 `solidPlate()`：封閉、所有面不是跟大面平行就是垂直、頂點只落在兩個高度、厚度 ≤ 3 cm 而且比大面窄邊的 1/4 薄。
   * ⭐ 板厚改用**實際的幾何厚度**（⛔ 用物件身上看不見的 0.2）—— 卡片、CSV 寫的就是這塊板真正的厚度。
   */
  /**
   * 🔴 **網格物件照存檔內容重建後才攤**（2026-10-19，實驗 T3：`實驗-綜合評估.md` ①-3）。
   *
   * ⚠ 同一個盒身，存檔讀回來攤法就變（28 × 52 → 44 × 28）。病因【已查證 · 沙箱】：方塊的折角全是 90°，
   * 「先走最平的邊」要在一堆一樣大的角裡挑 —— 挑中哪一條，靠的是座標**最後幾位的浮點雜訊**；
   * 存檔把座標捨入到 6 位小數，雜訊換了一組，挑中的邊跟著換。轉一下再轉回來的方塊 20 個裡有 9 個存讀後攤法變了。
   * ⭐ 修兩件事：① 存檔座標改存**完整精度**（`mesh.js` `toJSON()`）⇒ 讀回來一位不差；
   * ② 一律在「照存檔內容重建」的副本上攤（`canonicalMesh()`）⇒ 編輯過的網格內部排列就算跟重建的不一樣，攤的也是存讀之後那一份。
   * ⛔ 改攤平的規則本身 —— 試過「一樣大的角捨入後照順序挑」，圓錐、圓環、階梯的攤法跟著變、還有變差的（2026-10-19 沙箱）。
   * ⛔ 只做 ②、存檔照舊捨入 —— 也試過：存讀前後一樣了，但剛轉成網格的圓柱縫從 1 條直線變成 5 段、
   *   智慧分切的提案也從 1 片變 2 片（捨入過的雜訊剛好挑得比較亂；2026-10-19 沙箱）。
   * ⚠ **只對網格物件做**（`src.type === 'mesh'`：編輯過的、讀檔讀回來的）。參數物件（方塊、圓柱、布林、陣列…）
   * 每次都照參數重建，順序本來就固定、存讀前後一樣 —— 排了反而會讓大家看慣的攤法換樣子（方塊的十字形 145 × 210）。
   */
  const canon = obj.src && obj.src.type === 'mesh' ? canonicalMesh(mesh) : null;
  if (canon) mesh = canon.mesh;

  /**
   * 🔴 **布林、陣列：先把同一個平面上的三角形併回一個面再攤**（2026-10-19，實驗 T2 疑點 Q9：`實驗-綜合評估.md` ①-4）。
   *
   * ⚠ 布林／實體陣列的網格是 Manifold 算出來的（`build/bool.js`），**全部是三角形**；
   * 以前只有按「轉成可編輯網格」（`io.js` `bake()`）才會併回面，而展開拿沒轉的照樣攤 ——
   * 方塊挖掉一角（差集）攤出來**重疊、不能下料**，轉成網格之後就是一片好的（2026-10-19 沙箱）。
   * ⭐ 跟 `bake()` 用同一支（`edit.js` `mergeCoplanarFaces()`）：⛔ 改幾何（體積面積一樣），只把三角形併回本來那個平面；
   * 併不動的（環形、其實不共面的）原樣留著。⇒ 沒轉就攤、轉了再攤，攤出來一樣。
   * ⚠ 只對布林與陣列做：基本形狀的三角形排得整齊、本來就攤得好，大家看慣的攤法⛔ 動。
   * ⚠ 物件自己的網格⛔ 換（畫面、匯出照舊）；程式補剪的邊照頂點編號對回去（`remap`）。
   */
  let merged = null;
  if (!canon && (obj.isBool || obj.isArray)) {
    const mr = mergeCoplanarFaces(mesh);
    if (mr.ok) {
      mesh = mr.mesh;
      merged = [];
      for (const [from, to] of mr.remap) merged[to] = from;
    }
  }

  const plate = (rule.foldable === false && opt.mode !== 'dart') ? solidPlate(mesh) : null;
  if (plate) {
    mesh = plate.mesh;
    rule = makeRule(material, plate.t);
  }

  /**
   * 🔴 **折不了的材料遇到折板的圓弧：圓弧那幾格⛔ 出片**（2026-10-19，實驗 T3：`實驗-綜合評估.md` ①-13，kang「同意你的安排與建議」）。
   *
   * ⚠ 以前壓克力／木板把所有折線改成切割線 ⇒ 圓弧切出來的每一小格都變成一片：
   * 隔板（板寬 11、內側圓角 0.2、分 4 段）出了 4 條 11 × 0.16 的細條 —— 下不了料，也⛔ 是設計要的東西。
   * ⭐ 先用能折的規則認出圓弧帶（`flatten.js` `piece.arcFaces`，跟展開圖標「圓弧折彎」同一套），把那幾格拿掉再攤 ⇒ 只出平的那幾段，並且講出來。
   * ⚠ 尖角的折線照舊（本來就是一刀切成兩片）。
   * ⚠ **只對折板**（`src.type === 'bend'`，或陣列裡排的是折板，T3 的隔板就是）：圓柱、圓角方塊的曲面拆成一條一條
   *   是可以黏成多邊形的，照舊出片。轉成網格之後的折板認不出來（沒有參數了），照舊。
   */
  let arcDrop = null;
  if (rule.foldable === false && opt.mode !== 'dart' && !plate && isBendSrc(obj.src)) {
    arcDrop = arcStripFaces(mesh, obj.thickness);
    if (arcDrop) mesh = arcDrop.mesh;
  }

  /** `opt.mode`：`'dart'` ＝ 省道打版（2026-10-12）；沒給 ＝ 精確分片（原本的路）*/
  const r = unfoldMesh(mesh, rule, { flatTolDeg: opt.flatTolDeg, mode: opt.mode });
  if (plate) for (const p of r.pieces) p.solidPlate = { t: plate.t };
  if (arcDrop) {
    r.warnings.push(`${rule.label}折不了：圓弧折彎 ${arcDrop.bands} 道沒有出片（彎的那一段做不出來），只出平的那幾段`
      + ` —— 要整片折成形，請換能折的材質，或把折板拆成幾片平板`);
  }

  /**
   * 🔴 **陣列的份數⛔ 再乘一次**（2026-10-19 實驗 T3／T7 抓到：份數被平方）。
   *
   * ⚠ 這裡原本寫 `p.qty *= obj.copies` —— 那是「陣列只算一份網格」那個年代的寫法。
   * **現在 `obj.mesh()` 已經把每一份都放進去了**（`build/array.js` `evalArrayTree()`：
   * 板件 `Mesh.merge(copies)`、實體 `unionMeshes(copies)`），
   * 而 `unfoldMesh()` 本來就會把一樣的片併成一張圖 ×N（`flatten.js` `groupIdentical()`）。
   * ⇒ 再乘一次就是 N²：排列 2 份出 4 片、3 份出 9 片、鏡射出 4 片、2 × 3 網格的三角片 ×72。
   *
   * ⭐ **片數只由「實際攤的那份網格」決定**（鐵律二：性質由兩端決定 —— 這裡的兩端是
   * 陣列造網格的那一端、展開數片的這一端；網格那一端改了，這一端要跟著拿掉）。
   * ⭐ 重疊的實體陣列聯集成一塊之後也就對了：一塊就是一塊，⛔ 再乘份數。
   * 〔守門的測試：`tests/run.mjs`「陣列展開的片數」—— 陣列物件 vs 同一份網格烤成的物件，片數與面積要一樣〕
   */

  /**
   * 🔴 **每一片帶著自己的規則（材質＋板厚）**（2026-10-08 查 bug 找到的）。
   * 多個物件一起展開時，整份結果只有一個 `rule`（第一個物件的）——
   * 0.5 與 1.0 的板一起展開，DXF／CSV／標題欄**全部寫 0.5**，而那是要交給師傅的。
   * ⭐ 出圖的地方一律先看 `p.rule`，沒有才用整份的。
   */
  for (const p of r.pieces) { p.owner = obj.name; p.rule = rule; }

  /**
   * 🔴 **實體⛔ 寫板厚**（2026-10-19，實驗 T7、T8、補測：`實驗-綜合評估.md` ①-9，kang「先做 ①-9（照這個建議）」）。
   * ⚠ 實體的面板上看不到板厚，物件身上卻帶著預設的 0.2 —— 以前照樣寫進卡片、CSV、DXF 標題：
   * T7 托架寫 0.2、其他板 0.5，同一張料單兩種厚度。⭐ 實體（`kind` ≠ 板件）的片標 `solidBody` ⇒ 板厚寫「—」；
   * 被認成實心板的（`solidPlate`）照舊寫量出來的厚度。攤平本身⛔ 動（`rule` 照舊傳進去）。
   */
  if (obj.kind !== 'sheet' && !plate) for (const p of r.pieces) p.solidBody = true;

  /**
   * 🔴 **折板的折彎長度照折板自己的 K 算 —— 講出來**（2026-10-19，實驗 T3：`實驗-綜合評估.md` ①-13，kang「同意」）。
   * ⚠ 折板的形狀是照物件面板上的 K 建的（`build/prim.js`），展開圖選什麼材質都一樣（T3 隔板 K 0.4 ⇒ 9.1243、K 0.3 ⇒ 9.0463）——
   * 以前畫面一句都沒講。⭐ 這一輪⛔ 改長度（要先知道實際怎麼折才知道該怎麼算），只在有圓弧折彎的片上寫是照哪個 K（`out/sheet.js`）。
   */
  const bk = bendSrcK(obj.src);
  if (bk !== null) for (const p of r.pieces) if (p.bends.some(b => b.isArc)) p.bendK = bk;

  /**
   * 🔴 **紙模的黏合片長在接縫的哪一邊**（2026-10-19，`實驗-綜合評估.md` ①-7；畫的人是 `out/sheet.js` `marginGeometry()`）。
   * 一條縫的兩側走的是同一串 3D 頂點、同一個方向（`flatten.js` `collectSeamRuns()`）⇒ 用頂點串當 key，
   * **先遇到的那一側長**（片的順序、縫的順序），另一側不長 —— 一對接縫只長一片，兩邊一定對得上。
   */
  const tabSeen = new Set();
  for (const p of r.pieces) {
    for (const run of (p.seamRuns || [])) {
      const k = run.segs.map(g => `${g.va}-${g.vb}`).join(',');
      run.tab = !tabSeen.has(k);
      tabSeen.add(k);
    }
  }

  return {
    ok: true,
    pieces: r.pieces,
    /**
     * 程式自己補剪的邊（智慧分切的提案用，2026-10-13）—— 一律是**物件自己那份網格**的邊。
     * ⚠ 縮放過的物件展開的是套了縮放的另一份網格（上面的 `transformed()`）：頂點順序不變，照頂點編號對回來。
     */
    /** ⚠ 實心板攤的是頂面那一份新網格，邊對不回原物件 ⇒ ⛔ 給（一片板也⛔ 需要補剪）*/
    autoEdges: plate || arcDrop ? [] : mesh === obj.mesh() ? (r.autoEdges || []) : mapEdgesBack(r.autoEdges || [], mesh, obj.mesh(), merged || (canon && canon.orig)),
    keepCut: r.keepCut || 0,
    warnings: [...warn, ...r.warnings],
    stats: { ...r.stats, total: r.pieces.reduce((n, p) => n + p.qty, 0) },
    rule
  };
}

/**
 * 實心的板：回傳「頂面那幾個面」組成的新網格與板厚；⛔ 是板就回 null。
 *
 * **每一塊（連在一起的一團面）各自判斷**，全部都是板、而且厚度一樣才算 ——
 * 陣列的網格是好幾塊拼在一起（6 個托架 ＝ 6 塊），整體看頂點會落在很多個高度。
 * 每一塊的條件：
 *   1. 封閉（整個網格封閉）
 *   2. 這一塊面積最大的方向 n：每個面的法向不是跟 n 平行（頂、底）就是跟 n 垂直（側邊）
 *   3. 這一塊的頂點沿 n 只落在兩個高度 ⇒ 厚度 t ＝ 兩個高度的差
 *   4. t ≤ 3 cm，而且 t ≤ 頂面外框窄邊的 1/4 —— ⛔ 把 10 × 10 × 100 的柱子當成一片 100 × 10 的板
 * 「頂面」＝ 法向朝 +n 的那幾個面（頂、底形狀一樣，取哪一面都是同一個輪廓；洞會跟著出來）。
 */
const PLATE_MAX_T = 3;
function solidPlate(mesh) {
  if (!mesh.isClosed()) return null;
  mesh.computeNormals();
  const seen = new Set(), parts = [];
  for (const f of mesh.faces) {
    if (seen.has(f.id)) continue;
    const list = [f], stack = [f];
    seen.add(f.id);
    while (stack.length) {
      for (const he of mesh.faceLoop(stack.pop())) {
        const nb = he.twin && he.twin.face;
        if (nb && !seen.has(nb.id)) { seen.add(nb.id); stack.push(nb); list.push(nb); }
      }
    }
    parts.push(list);
  }
  let t = null;
  const top = [];
  for (const faces of parts) {
    const r = platePart(mesh, faces);
    if (!r) return null;
    if (t !== null && Math.abs(r.t - t) > 1e-6) return null;
    t = r.t;
    top.push(...r.top);
  }
  if (!top.length) return null;
  const vi = new Map(), pts = [];
  const faces = top.map(f => mesh.faceVerts(f).map(v => {
    if (!vi.has(v.id)) { vi.set(v.id, pts.length); pts.push(v.p.clone()); }
    return vi.get(v.id);
  }));
  return { mesh: Mesh.fromFaceList(pts, faces), t };
}

/** 一塊是不是實心的板：是 ⇒ { t, top:[頂面的面] }；⛔ 是 ⇒ null（條件見 `solidPlate()`）*/
function platePart(mesh, faces) {
  const area = f => {
    let s = 0;
    for (const [a, b, c] of mesh.faceTriangles(f)) {
      s += new THREE.Vector3().subVectors(b.p, a.p).cross(new THREE.Vector3().subVectors(c.p, a.p)).length() / 2;
    }
    return s;
  };
  // 面積最大的方向（正反算同一個）
  const groups = [];
  for (const f of faces) {
    const n = f.normal, a = area(f);
    const g = groups.find(x => Math.abs(x.n.dot(n)) > 0.9999);
    if (g) g.a += a; else groups.push({ n: n.clone(), a });
  }
  if (!groups.length) return null;
  const n = groups.reduce((m, g) => (g.a > m.a ? g : m)).n;
  for (const f of faces) {
    const d = Math.abs(f.normal.dot(n));
    if (d < 0.9999 && d > 1e-4) return null;
  }
  const hs = [], pts = [];
  for (const f of faces) {
    for (const v of mesh.faceVerts(f)) {
      pts.push(v.p);
      const h = v.p.dot(n);
      if (!hs.some(x => Math.abs(x - h) < 1e-6)) hs.push(h);
      if (hs.length > 2) return null;
    }
  }
  if (hs.length !== 2) return null;
  const t = Math.abs(hs[1] - hs[0]);
  const top = faces.filter(f => f.normal.dot(n) > 0.9999);
  if (!top.length) return null;
  // 頂面外框的窄邊（在頂面所在的平面上量）
  const u = Math.abs(n.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const e1 = u.sub(n.clone().multiplyScalar(u.dot(n))).normalize();
  const e2 = new THREE.Vector3().crossVectors(n, e1);
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const p of pts) {
    const a = p.dot(e1), b = p.dot(e2);
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
  }
  const narrow = Math.min(a1 - a0, b1 - b0);
  if (!(t > 0) || t > PLATE_MAX_T || t > narrow / 4) return null;
  return { t, top };
}

/** 折板（或排的是折板的陣列）面板上的 K；不是折板 ⇒ null（沒填 ⇒ 折板的預設）*/
function bendSrcK(src) {
  if (!src) return null;
  if (src.type === 'bend') return Number.isFinite(+src.k) ? +src.k : PRIM_DEFAULTS.bend.k;
  return src.type === 'array' && src.child ? bendSrcK(src.child.src) : null;
}

/** 這個物件是不是折板（陣列的話看排的那一個）*/
function isBendSrc(src) {
  if (!src) return false;
  if (src.type === 'bend') return true;
  return src.type === 'array' && !!src.child && isBendSrc(src.child.src);
}

/**
 * 折板圓弧切出來的小格（`unfoldMesh()` 用能折的規則攤一次拿 `arcFaces`）→ 拿掉之後的網格；沒有圓弧 ⇒ null。
 * ⚠ 用鐵板的規則認：什麼角度都折得動 ⇒ 圓弧帶一定認得出來（認法只看幾何，跟材質無關）。
 * @returns {{mesh:Mesh, faces:number, bands:number}|null}
 */
function arcStripFaces(mesh, t) {
  const probe = unfoldMesh(mesh, makeRule('steel', t));
  const drop = new Set(probe.arcFaces || []);
  if (!drop.size) return null;
  const bands = probe.pieces.reduce((n, p) => n + p.bends.filter(b => b.isArc).length * p.qty, 0);
  const d = mesh.toJSON();
  const pts = [];
  for (let i = 0; i < d.points.length; i += 3) pts.push(new THREE.Vector3(d.points[i], d.points[i + 1], d.points[i + 2]));
  const keep = d.faces.filter((f, i) => !drop.has(mesh.faces[i].id));
  const cr = cleanRebuild(pts, keep);
  const pair = ([a, b, ...rest]) => (cr.remap.has(a) && cr.remap.has(b) ? [cr.remap.get(a), cr.remap.get(b), ...rest] : null);
  const out = Mesh.fromJSON({
    points: cr.points.flatMap(p => [p.x, p.y, p.z]),
    faces: cr.faces,
    roles: (d.roles || []).map(pair).filter(Boolean),
    smooth: (d.smooth || []).map(pair).filter(Boolean),
    hard: (d.hard || []).map(pair).filter(Boolean),
    keep: (d.keep || []).map(pair).filter(Boolean)
  });
  return { mesh: out, faces: drop.size, bands };
}

/**
 * 「照存檔的樣子重建一次」的副本（頂點順序不變，所以 `orig` 是恆等、回傳 null）。
 *
 * ⭐ 編輯中的網格跟讀檔讀回來的網格，**存檔內容一模一樣** ⇒ 一律攤「存檔內容重建出來的那一份」⇒ 存讀前後攤法一模一樣。
 * ⚠ 照存檔的兩件事：① 座標（`mesh.js` `toJSON()` 存完整精度；舊檔捨入過的讀進來就是捨入過的那組，之後也一直是那組）；
 * ② 內部排列（半邊的順序）照重建的 —— 編輯過的網格還留著「刪過、加過」的痕跡，那些⛔ 寫進存檔。
 * ⚠ 真的走一次 `JSON.stringify()`／`JSON.parse()`（跟存檔同一條路，例如 −0 存成 0）。
 * ⚠ 走 `toJSON()`／`fromJSON()`：標記（切開、不准切、平滑、環切的邊）跟著頂點編號一起搬，⛔ 漏。
 */
export function canonicalMesh(mesh) {
  return { mesh: Mesh.fromJSON(JSON.parse(JSON.stringify(mesh.toJSON()))), orig: null };
}

/**
 * 攤的那份網格上的邊 → 物件自己網格上同一條邊。
 * `orig[i]` ＝ 攤的那份第 i 個點對應原網格的第幾個點（`canonicalMesh()` 是恆等；併面會清掉孤點、編號往前移；
 * 縮放的 `transformed()` 不改頂點順序）。
 */
function mapEdgesBack(hes, from, to, orig) {
  const idx = new Map(from.verts.map((v, i) => [v.id, orig ? orig[i] : i]));
  const tIdx = new Map(to.verts.map((v, i) => [v.id, i]));
  const byPair = new Map();
  for (const he of to.edges()) {
    const a = tIdx.get(he.v.id), b = tIdx.get(he.to.id);
    byPair.set(`${Math.min(a, b)}-${Math.max(a, b)}`, he);
  }
  const out = [];
  for (const he of hes) {
    const a = idx.get(he.v.id), b = idx.get(he.to.id);
    const t = byPair.get(`${Math.min(a, b)}-${Math.max(a, b)}`);
    if (t) out.push(t);
  }
  return out;
}

/**
 * 一次展開多個物件，並把結果併成一份。
 * 不同物件之間不合併相同的片 —— 名稱要對得回原件，
 * 現場才知道這張圖是哪個零件。
 */
export function unfoldMany(objs, opt = {}) {
  const pieces = [];
  const warnings = [];
  const skipped = [];
  let rule = null;

  for (const o of objs) {
    const r = unfoldObject(o, opt);
    rule = rule || r.rule;
    if (!r.ok) { skipped.push(`${o.name}：${r.reason}`); continue; }
    for (const p of r.pieces) {
      p.name = objs.length > 1 ? `${o.name}－${p.name}` : `${o.name}`;
      pieces.push(p);
    }
    for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
  }

  /**
   * 🔴 **片號 P01、P02…：DXF、CSV、畫面卡片用同一個號碼**（2026-10-08 查 bug E9，kang 決定）。
   * DXF 用的是舊版格式（R12），標題只能放英文數字 —— 中文名稱會變成「-」，
   * 師傅拿到圖分不出哪片是哪片。⭐ 圖上寫片號，CSV 第一欄也寫片號、旁邊是中文名稱，一對就知道。
   */
  pieces.forEach((p, i) => { p.no = pieceNo(i + 1); });

  return {
    pieces, warnings, skipped, rule,
    stats: {
      pieces: pieces.length,
      total: pieces.reduce((n, p) => n + p.qty, 0),
      area: pieces.reduce((a, p) => a + p.area * p.qty, 0),
      arcBends: pieces.reduce((n, p) => n + p.bends.filter(b => b.isArc).length, 0),
      sharpBends: pieces.reduce((n, p) => n + p.bends.filter(b => !b.isArc).length, 0)
    }
  };
}

/**
 * 備料明細：一片一列。可直接匯出 CSV，
 * 欄位刻意跟「組裝系統結構說明表」的備料表對齊，日後好合併。
 */
/** 片號的寫法只有這一個家：P01、P02 … P100 */
export function pieceNo(n) { return 'P' + String(n).padStart(2, '0'); }

export function billOfMaterials(pieces, rule) {
  return pieces.map((p, i) => ({
    片號: p.no || pieceNo(i + 1),
    名稱: p.name,
    數量: p.qty,
    材質: (p.rule || rule) ? (p.rule || rule).label : '',
    /** 實體的片（`solidBody`）⛔ 寫看不見的 0.2（①-9）*/
    板厚cm: p.solidBody ? '—' : (p.rule || rule) ? (p.rule || rule).thickness : '',
    展開長cm: round(p.width),
    展開寬cm: round(p.height),
    單片面積cm2: round(p.area),
    總面積cm2: round(p.area * p.qty),
    折彎道數: p.bends.length,
    備註: p.warnings.join('；')
  }));
}

export function bomCSV(pieces, rule) {
  const rows = billOfMaterials(pieces, rule);
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const esc = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\r\n');
}

const round = v => Math.round(v * 100) / 100;
