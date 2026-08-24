/**
 * mesh.js — 半邊網格結構（half-edge mesh）
 *
 * 這是整個建模器唯一的真相來源。參數物件、布林運算、展開引擎，
 * 全部都以這個結構為底。
 *
 * ── 為什麼用半邊而不是單純的面清單 ──────────────────
 * 展開引擎和面編輯最常問的問題是「這條邊隔壁是哪個面」。
 * 面清單答得出來，但每問一次都要翻遍全部的面；半邊結構是 O(1)。
 * 一個幾千面的模型，展開時要問幾萬次，差別就是「秒」跟「分鐘」。
 *
 * ── 結構長什麼樣 ────────────────────────────────────
 *
 *              next
 *        v1 ───────he──────▶ v2
 *           ◀─────twin──────
 *
 *   he.v     這條半邊的「起點」
 *   he.face  它所屬的面（邊界半邊沒有面，是 null）
 *   he.next  同一個面上的下一條（繞一圈回到自己）
 *   he.twin  方向相反的那一條，兩條合起來才是一條「邊」
 *
 * 一條邊 ＝ 兩條半邊。要走訪不重複的邊，用 edges()。
 *
 * ── 單位 ────────────────────────────────────────────
 * 全部以 cm 為單位，跟空間平面規劃器一致。
 */

import * as THREE from 'three';
import { earClip } from './triangulate.js';

/** 邊的角色。展開時才會用到，但欄位從第 1 期就存在。 */
export const EDGE_ROLE = {
  FREE: 'free',   // 還沒指定
  FOLD: 'fold',   // 折線 —— 展開後仍相連，用虛線畫
  CUT:  'cut'     // 切割線 —— 展開時從這裡分開
};

let _uid = 1;
const nextUid = () => _uid++;

// ═══════════════════════════════════════════════════════
//  基本元件
// ═══════════════════════════════════════════════════════

export class Vertex {
  constructor(p) {
    this.id = nextUid();
    this.p = p.clone();     // THREE.Vector3，單位 cm
    this.he = null;         // 任一條「由此頂點出發」的半邊
  }
}

export class HalfEdge {
  constructor() {
    this.id = nextUid();
    this.v = null;          // 起點
    this.face = null;       // 所屬的面；null ＝ 這是邊界半邊
    this.next = null;
    this.prev = null;
    this.twin = null;
    this.role = EDGE_ROLE.FREE;
    /**
     * 這條邊是「曲面被切成小面」產生的，不是造型上真的有一道折。
     *
     * ── 為什麼不能塞進 role ──────────────────────────
     * `role` 回答的是**製造問題**：這條邊要切、要折、還是不管。
     * 這個旗標回答的是**形狀問題**：它是造型的一部分，還是離散化的產物。
     * 兩個問題不同，混在同一個欄位裡就會逼下游用角度去猜 ——
     * 而猜在自由曲線上一定會失敗（一個 S 字的側面猜出 196 道折彎）。
     *
     * 誰知道答案：**上游**。貝茲曲線的錨點自己知道自己是不是平滑點，
     * 參數體（圓柱、圓角方塊）也知道哪幾圈是滾出來的。
     * 布林運算之後會消失（Manifold 不認得我們的旗標），
     * 從 STL 匯進來的也從來沒有 —— 那些情況只能回頭用角度猜。
     */
    this.smooth = false;
  }
  /** 終點 ＝ 反向半邊的起點 */
  get to() { return this.twin ? this.twin.v : this.next.v; }
}

export class Face {
  constructor() {
    this.id = nextUid();
    this.he = null;         // 這個面上的任一條半邊
    this.normal = new THREE.Vector3();
    this.region = -1;       // 由 region.js 填入
  }
}

// ═══════════════════════════════════════════════════════
//  網格
// ═══════════════════════════════════════════════════════

export class Mesh {
  constructor() {
    this.verts = [];
    this.halfEdges = [];
    this.faces = [];
    /** 建構過程遇到的問題，validate() 會一併回報 */
    this.issues = [];
  }

  // ── 走訪 ──────────────────────────────────────────

  /** 走訪不重複的邊。每條邊只回傳兩條半邊中 id 較小的那條。 */
  *edges() {
    for (const he of this.halfEdges) {
      if (!he.twin || he.id < he.twin.id) yield he;
    }
  }

  /** 一個面上的所有半邊（繞一圈） */
  faceLoop(face) {
    const out = [];
    let he = face.he;
    do { out.push(he); he = he.next; } while (he && he !== face.he && out.length < 1e6);
    return out;
  }

  /**
   * 網格封不封閉（一條邊界半邊都沒有）。
   *
   * ── 為什麼要有這個，而不是問物件的 kind ────────────
   * 「這東西要不要加厚」看起來像是在問「它是不是板件」，其實不是。
   * `kind` 是使用者在下拉選單裡隨手可改的**標籤**；
   * 封不封閉是**幾何事實**。兩者不一致時，該信的是後者。
   *
   * 實際出過事：把封閉的方塊標成板件，STL 匯出會對它加厚，
   * 結果是**兩個互不相連的盒子**（內外各一個），不是一個空心盒。
   * 這跟「板件不該做布林聯集」（踩過的坑第 8 條）是同一條原則。
   *
   * 開放網格通常第一條就命中（邊界半邊會被串成迴圈），所以很快；
   * 封閉網格必須掃完才能確定，是 O(半邊數)。
   */
  isClosed() {
    for (const he of this.halfEdges) if (!he.face) return false;
    return true;
  }

  /** 一個面上的所有頂點 */
  faceVerts(face) {
    return this.faceLoop(face).map(he => he.v);
  }

  /** 繞著一個頂點的所有半邊（由此頂點出發的） */
  vertOutgoing(v) {
    const out = [];
    let he = v.he;
    if (!he) return out;
    do {
      out.push(he);
      if (!he.prev) break;          // 碰到邊界，走不下去
      he = he.prev.twin;
    } while (he && he !== v.he && out.length < 1e6);
    return out;
  }

  // ── 幾何 ──────────────────────────────────────────

  /** 用 Newell 法算面法向量：多邊形、非平面的面都算得出來，比叉積穩 */
  computeFaceNormal(face) {
    const vs = this.faceVerts(face);
    const n = new THREE.Vector3();
    for (let i = 0; i < vs.length; i++) {
      const a = vs[i].p, b = vs[(i + 1) % vs.length].p;
      n.x += (a.y - b.y) * (a.z + b.z);
      n.y += (a.z - b.z) * (a.x + b.x);
      n.z += (a.x - b.x) * (a.y + b.y);
    }
    const len = n.length();
    if (len > 1e-12) n.divideScalar(len);
    face.normal.copy(n);
    return face.normal;
  }

  computeNormals() {
    for (const f of this.faces) this.computeFaceNormal(f);
    return this;
  }

  /**
   * 兩個相鄰面之間的「轉折角」，單位弧度。
   *   0    ＝ 完全共面（攤平的）
   *   正值 ＝ 凸角（山折）
   *   負值 ＝ 凹角（谷折）
   * 展開時要靠這個判斷折線方向，以及哪些面可以合併成一片。
   */
  dihedral(he) {
    if (!he.twin || !he.face || !he.twin.face) return null;   // 邊界邊沒有夾角
    const a = he.v.p, b = he.to.p;
    const dir = new THREE.Vector3().subVectors(b, a);
    if (dir.lengthSq() < 1e-20) return null;
    dir.normalize();
    const n1 = he.face.normal, n2 = he.twin.face.normal;
    const cross = new THREE.Vector3().crossVectors(n1, n2);
    return Math.atan2(cross.dot(dir), n1.dot(n2));
  }

  /** 這條邊兩側是否共面（預設容許 0.5 度） */
  isFlat(he, tolDeg = 0.5) {
    const d = this.dihedral(he);
    return d !== null && Math.abs(d) <= THREE.MathUtils.degToRad(tolDeg);
  }

  /**
   * 🔴 **一個面拆成哪幾個三角形。全專案唯一的入口。**
   *
   * ── 為什麼要有這一支 ────────────────────────────────
   * 顯示卡、STL、布林函式庫都只吃三角形，所以 n 邊形一定要拆。
   * 而**扇形三角化（從第一個點拉到每一組相鄰邊）只對凸多邊形成立** ——
   * 凹進去的多邊形用扇形切，會產生**跑到多邊形外面、而且繞向翻掉**的三角形。
   *
   * 實測（2026-08-24，kang 回報的畫面）：圓柱壓平一段再往內拉，
   * 上蓋變成非凸的 32 邊形，扇形切出來**多畫了 81.95 cm²（4.56%）**，
   * 其中 1 個三角形繞向是反的。
   *
   * ⚠ **這個 bug 一直都在，只是以前叫不出來。**
   * n 邊形本來只出現在 `roundBox`（20 邊形，凸）與 `tube`（四邊形），
   * 而匯入的擠出件早就自己耳切成三角形了。
   * 「還原多邊形」讓每個共面區域都變成 n 邊形之後，它才浮出來。
   *
   * ── 為什麼不一律耳切 ────────────────────────────────
   * 絕大多數的面都是凸的（三角形、四邊形、參數體的每一個面），
   * 而扇形是 O(n)、耳切是 O(n²)。**先問凸不凸，凸的走快的那條。**
   * ⭐ 而且這樣一來，**凸的情況跟改之前逐字相同** ——
   * 1219 項既有測試就是那個斷言。
   *
   * ⛔ **不要再自己寫 `for (let i = 2; i < vs.length; i++)`。**
   * 那個模式在這個專案出現過 8 次，每一次都是同一個 bug 的一個出口。
   *
   * @returns {Array<[Vertex,Vertex,Vertex]>} 繞向跟面一致
   */
  faceTriangles(face) {
    const vs = this.faceVerts(face);
    if (vs.length < 3) return [];
    if (vs.length === 3) return [[vs[0], vs[1], vs[2]]];

    const fan = () => {
      const out = [];
      for (let i = 2; i < vs.length; i++) out.push([vs[0], vs[i - 1], vs[i]]);
      return out;
    };
    if (vs.length === 4 || isConvexLoop(vs, this.computeFaceNormal(face))) return fan();

    /**
     * 非凸 → 投影到面自己的平面，用耳切。
     *
     * 投影的基底：Z ＝ 面法向，X 取第一條邊，Y ＝ Z×X。
     * 繞向會因此保持一致 —— 在那個基底裡，面的繞向是逆時針，
     * 而 `earClip()` 吃的就是逆時針。
     */
    const n = this.computeFaceNormal(face).clone();
    if (n.lengthSq() < 1e-20) return fan();      // 零面積，退回扇形（反正也畫不出來）
    n.normalize();
    const ex = new THREE.Vector3().subVectors(vs[1].p, vs[0].p);
    ex.addScaledVector(n, -ex.dot(n));
    if (ex.lengthSq() < 1e-20) return fan();
    ex.normalize();
    const ey = new THREE.Vector3().crossVectors(n, ex);

    const o = vs[0].p;
    const flat = vs.map(v => {
      const d = new THREE.Vector3().subVectors(v.p, o);
      return { x: d.dot(ex), y: d.dot(ey) };
    });

    const tris = earClip(flat.map((_, i) => i), flat);
    /**
     * ⚠ **耳切失敗（自交、重複點…）就退回扇形，不要回傳空的。**
     * 回空的話那個面在畫面上與 STL 裡**整片消失**，
     * 而使用者會以為模型壞了 —— 那比「畫得有點怪」糟得多（坑第 11 條）。
     */
    if (tris.length !== vs.length - 2) return fan();
    return tris.map(t => [vs[t[0]], vs[t[1]], vs[t[2]]]);
  }

  /** 有號體積。封閉網格才有意義，用來對答案。 */
  volume() {
    let v = 0;
    for (const f of this.faces) {
      // 有號量對非凸也成立，但一律走 faceTriangles() —— 全專案只留一個三角化入口
      for (const [x, y, z] of this.faceTriangles(f)) {
        v += x.p.dot(new THREE.Vector3().crossVectors(y.p, z.p)) / 6;
      }
    }
    return v;
  }

  /** 表面積 */
  area() {
    let s = 0;
    for (const f of this.faces) {
      /**
       * ⚠ 這裡加的是**絕對值**，所以非凸的面用扇形切會多算
       * （實測凹掉的 32 邊形多算 4.56%）。`faceTriangles()` 擋掉了那件事。
       */
      for (const [a, b, c] of this.faceTriangles(f)) {
        const ab = new THREE.Vector3().subVectors(b.p, a.p);
        const ac = new THREE.Vector3().subVectors(c.p, a.p);
        s += ab.cross(ac).length() / 2;
      }
    }
    return s;
  }

  bounds() {
    const box = new THREE.Box3();
    for (const v of this.verts) box.expandByPoint(v.p);
    return box;
  }

  // ── 邊的角色 ──────────────────────────────────────

  /** 設定「這條邊是曲面的一部分」。跟 setRole 一樣，兩條半邊要一起設。 */
  setSmooth(he, on = true) {
    he.smooth = !!on;
    if (he.twin) he.twin.smooth = !!on;
    return this;
  }

  /** 設定邊的角色。一定要兩條半邊一起設，不然走另一邊會讀到舊值。 */
  setRole(he, role) {
    he.role = role;
    if (he.twin) he.twin.role = role;
    return this;
  }

  /**
   * 依轉折角自動標記：夠平的當折線、其餘保持未指定。
   * 這只是個起手式，實際哪裡切哪裡折由各材料的規則模組決定。
   */
  autoMarkFolds(flatTolDeg = 0.5) {
    let n = 0;
    for (const he of this.edges()) {
      if (!he.twin || !he.face || !he.twin.face) continue;   // 邊界一律是切割線
      if (!this.isFlat(he, flatTolDeg)) { this.setRole(he, EDGE_ROLE.FOLD); n++; }
    }
    return n;
  }

  // ── 拓撲檢查 ──────────────────────────────────────

  /**
   * 連通元件個數 —— 這個網格其實是幾個彼此分開的殼。
   *
   * 封閉曲面的尤拉數是 χ ＝ 2c − 2g（c 是元件數，g 是貫穿孔總數）。
   * 沒有這個數字就沒辦法分辨「兩個分開的方塊（χ=4）」和「結構接錯了」，
   * 布林聯集很容易做出前者。走一遍所有面，成本 O(面數)。
   */
  componentCount() {
    const seen = new Set();
    let n = 0;
    for (const f of this.faces) {
      if (seen.has(f.id)) continue;
      n++;
      const stack = [f];
      seen.add(f.id);
      while (stack.length) {
        for (const he of this.faceLoop(stack.pop())) {
          const nb = he.twin && he.twin.face;
          if (nb && !seen.has(nb.id)) { seen.add(nb.id); stack.push(nb); }
        }
      }
    }
    return n;
  }

  /**
   * 自我檢查。回傳 { ok, V, E, F, euler, closed, components, errors[] }
   *
   * 尤拉公式是驗證結構有沒有接錯最快的方法。封閉網格的
   * χ ＝ V−E+F ＝ 2×元件數 − 2×貫穿孔數，所以 χ 必為偶數；
   * 開放的殼（一片板子）是 1。
   */
  validate() {
    const errors = [...this.issues];
    let boundary = 0;

    for (const he of this.halfEdges) {
      if (!he.v)            errors.push(`半邊 ${he.id} 沒有起點`);
      if (!he.next)         errors.push(`半邊 ${he.id} 沒有 next`);
      if (he.next && he.next.prev !== he) errors.push(`半邊 ${he.id} 的 next/prev 對不起來`);
      if (he.twin && he.twin.twin !== he) errors.push(`半邊 ${he.id} 的 twin 不對稱`);
      if (he.twin && he.twin.v !== he.to) errors.push(`半邊 ${he.id} 與 twin 的端點不一致`);
      if (!he.face) boundary++;
    }

    for (const f of this.faces) {
      const loop = this.faceLoop(f);
      if (loop.length < 3) errors.push(`面 ${f.id} 只有 ${loop.length} 條邊`);
      for (const he of loop) {
        if (he.face !== f) errors.push(`面 ${f.id} 的迴圈裡混到別的面`);
      }
    }

    const V = this.verts.length;
    const E = [...this.edges()].length;
    const F = this.faces.length;
    const closed = boundary === 0;

    return {
      ok: errors.length === 0,
      V, E, F,
      euler: V - E + F,
      closed,
      components: this.componentCount(),
      boundaryHalfEdges: boundary,
      errors
    };
  }

  // ── 轉換 ──────────────────────────────────────────

  /** 轉成 three.js 可以畫的 BufferGeometry（扇形三角化） */
  toGeometry() {
    const pos = [], nor = [];
    for (const f of this.faces) {
      const n = f.normal;
      for (const tri of this.faceTriangles(f)) {
        for (const v of tri) {
          pos.push(v.p.x, v.p.y, v.p.z);
          nor.push(n.x, n.y, n.z);
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    return g;
  }

  /**
   * 頂點 id → 陣列索引。faceList 形式的輸出都要用它。
   * 不建這張表就得用 verts.indexOf()，那是「對每個頂點查一次全部頂點」，
   * 面數一多就是 O(V×F) —— 跟第 1 期曲率計算踩過的是同一個坑。
   */
  _vertIndex() {
    return new Map(this.verts.map((v, i) => [v.id, i]));
  }

  /** 這個網格的面清單形式（頂點索引） */
  _faceList(vi = this._vertIndex()) {
    return this.faces.map(f => this.faceVerts(f).map(v => vi.get(v.id)));
  }

  clone() {
    const m = Mesh.fromFaceList(this.verts.map(v => v.p.clone()), this._faceList());
    this._copyMarksTo(m);      // role ＋ smooth 都要搬，只搬 role 會讓展開圖讀不懂
    return m;
  }

  /**
   * 套用一個 4×4 變換，回傳新的網格（原本的不動）。
   *
   * 行列式為負（例如鏡射、某一軸縮放 -1）時，面的繞向會整個翻過來，
   * 法向量就會朝內、體積變負數。所以偵測到就把每個面的頂點順序倒過來。
   * 第 2 期的布林要用它把子物件擺到正確位置，鏡射也靠它。
   */
  transformed(m4) {
    const points = this.verts.map(v => v.p.clone().applyMatrix4(m4));
    const flip = new THREE.Matrix3().setFromMatrix4(m4).determinant() < 0;
    const faces = this._faceList();
    const m = Mesh.fromFaceList(points, flip ? faces.map(f => f.slice().reverse()) : faces);
    /**
     * ⚠ 一定要連 `smooth` 一起搬。翻繞向只改變「每個面裡頂點的順序」，
     * **頂點索引本身沒變**，所以索引配對照樣對得上。
     * 只搬 role 的話，純縮放或鏡射一次，匯入件的展開圖就從
     * 「5 處折彎」變成「45 處折彎」（見 `_copySmoothTo` 的實測表）。
     */
    this._copyMarksTo(m);
    return m;
  }

  /**
   * 每個頂點的法向 ＝ 圍繞它的面法向的平均。
   * 加厚時要靠它決定往哪邊偏移；折彎處自然會取到兩面的中間方向。
   */
  vertexNormals() {
    const acc = new Map();
    for (const v of this.verts) acc.set(v.id, new THREE.Vector3());
    for (const f of this.faces) {
      for (const v of this.faceVerts(f)) acc.get(v.id).add(f.normal);
    }
    for (const n of acc.values()) {
      if (n.lengthSq() > 1e-20) n.normalize();
    }
    return acc;
  }

  /**
   * 把一片開放的面加上厚度，變成封閉的實體。
   *
   * ── 為什麼需要它 ────────────────────────────────────
   * 日誌第 3 個關鍵決定：板件用「面 ＋ 厚度屬性」描述，展開才算得對。
   * 但畫面上一張沒有厚度的面看起來就是一張紙，使用者沒辦法確認
   * 板厚有沒有設對、折彎處長什麼樣。
   *
   * 所以**資料仍然是面，只有畫的時候才加厚**——
   * 這符合「畫面是文件的投影，自己不存狀態」的單向資料流。
   *
   * ── 做法與精度 ──────────────────────────────────────
   * 以原本的面當中性面，每個頂點沿自己的法向往兩側各偏移半個板厚，
   * 邊界再補上側壁。
   *
   * 中面偏移有個好性質：**體積精確等於「面積 × 厚度」**，
   * 平面與圓柱面都成立（圓柱面外側多出來的剛好補掉內側少掉的）。
   * 所以這個函式可以用數學對答案，不必靠眼睛看。
   *
   * 板厚遠大於曲率半徑時（例如 1cm 厚的板折 R0.2 的彎）會自交，
   * 那在真實世界也折不出來，不特別處理。
   *
   * @param {number} t 板厚，單位 cm
   * @returns {Mesh} 封閉的實體網格
   */
  shell(t) {
    const half = Math.abs(t) / 2;
    if (half < 1e-9) return this.clone();

    const vi = this._vertIndex();
    const vn = this.vertexNormals();
    const n = this.verts.length;

    /**
     * 折彎處要多推一點，否則板會被削薄。
     *
     * 頂點法向是兩個面法向的角平分線。若只沿它推 t/2，
     * 兩側的面在折角處會往內縮，量到的厚度變成 t×cos(半夾角) ——
     * 90 度折彎就只剩 0.71t。實測 0.3cm 的折板體積少了 0.076%。
     *
     * 正確的推法是除以 cos(半夾角)，也就是除以「頂點法向 ·
     * 相鄰面法向」。這就是鈑金與繪圖裡講的「尖角接合（miter）」。
     *
     * 夾角接近 180 度（板對折貼合）時餘弦趨近 0，推距會爆掉，
     * 所以設上限 5 倍。那種形狀實際上也折不出來。
     */
    const miter = new Map();
    for (const v of this.verts) miter.set(v.id, { sum: 0, n: 0 });
    for (const f of this.faces) {
      for (const v of this.faceVerts(f)) {
        const acc = miter.get(v.id);
        acc.sum += vn.get(v.id).dot(f.normal);
        acc.n++;
      }
    }
    const push = new Map();
    for (const v of this.verts) {
      const acc = miter.get(v.id);
      const cos = acc.n ? acc.sum / acc.n : 1;
      push.set(v.id, half * Math.min(5, 1 / Math.max(cos, 1e-6)));
    }

    // 前 n 個是外側，後 n 個是內側
    const points = [];
    for (const v of this.verts) {
      points.push(v.p.clone().addScaledVector(vn.get(v.id), push.get(v.id)));
    }
    for (const v of this.verts) {
      points.push(v.p.clone().addScaledVector(vn.get(v.id), -push.get(v.id)));
    }

    const faces = [];
    for (const f of this.faces) {
      const idx = this.faceVerts(f).map(v => vi.get(v.id));
      faces.push(idx);                                        // 外側：原繞向
      faces.push(idx.slice().reverse().map(i => i + n));       // 內側：反繞向
    }

    // 邊界補側壁。邊界半邊的 face 是 null，沿著它走一圈就是輪廓。
    for (const he of this.halfEdges) {
      if (he.face !== null) continue;
      const a = vi.get(he.v.id);
      const b = vi.get(he.to.id);
      if (a === undefined || b === undefined) continue;
      faces.push([a, b, b + n, a + n]);
    }

    return Mesh.fromFaceList(points, faces);
  }

  /**
   * 把邊的角色搬到另一個「頂點索引相同」的網格上。
   * 用兩端點的索引配對，所以繞向翻轉過也對得上。
   */
  _copyRolesTo(other) {
    const src = this._vertIndex(), dst = other._vertIndex();
    const pairs = new Map();
    for (const he of this.edges()) {
      if (he.role === EDGE_ROLE.FREE) continue;
      const a = src.get(he.v.id), b = src.get(he.to.id);
      pairs.set(`${Math.min(a, b)}-${Math.max(a, b)}`, he.role);
    }
    if (!pairs.size) return other;
    for (const he of other.edges()) {
      const a = dst.get(he.v.id), b = dst.get(he.to.id);
      const role = pairs.get(`${Math.min(a, b)}-${Math.max(a, b)}`);
      if (role) other.setRole(he, role);
    }
    return other;
  }

  /**
   * 把 `smooth` 旗標搬到另一個網格上。做法跟 `_copyRolesTo()` 一樣，
   * 用**頂點索引配對**（id 每次都重新編號，存了也對不回來）。
   *
   * 🔴 **這一支是 2026-08-23 補的，補的是一個一直存在的 bug。**
   * `clone()` 與 `transformed()` 以前只搬 `role`，**`smooth` 全部掉光**，
   * 而那兩支被這些路徑用著：
   *   `part.js` 展開前的縮放、`array.js` 陣列與鏡射、
   *   `io.js` 子物件擺位、`slicePanel.js` 剖面分切前
   *
   * 後果實測（自由曲線的擠出件，形狀完全沒變、只是縮放 2 倍）：
   *
   * | | smooth 邊 | 折彎處 | 圓弧 | 尖角 |
   * |---|---|---|---|---|
   * | 原件 | 42 | **5** | 1 | 4 |
   * | 縮放 2 倍 | 0 | **45** | 0 | 45 |
   *
   * **展開圖從「5 處折彎」變成「45 處折彎」，而形狀一模一樣。**
   * 那正是日誌上「196 道折彎、整張圖一團綠色數字」的同一個症狀 ——
   * 圖看起來完全正常，只是讀不懂，而且要出圖才發現。
   *
   * ⚠ 布林之後掉光是**正常的**（Manifold 不認得我們的旗標，輸出是全新網格），
   * 那件事日誌早就寫明；這裡修的是「純搬移／純縮放也掉」那條。
   */
  _copySmoothTo(other) {
    const src = this._vertIndex(), dst = other._vertIndex();
    const pairs = new Set();
    for (const he of this.edges()) {
      if (!he.smooth) continue;
      const a = src.get(he.v.id), b = src.get(he.to.id);
      pairs.add(`${Math.min(a, b)}-${Math.max(a, b)}`);
    }
    if (!pairs.size) return other;
    for (const he of other.edges()) {
      const a = dst.get(he.v.id), b = dst.get(he.to.id);
      if (pairs.has(`${Math.min(a, b)}-${Math.max(a, b)}`)) other.setSmooth(he, true);
    }
    return other;
  }

  /**
   * 邊上的兩個標記一起搬。**凡是「拆掉重建」的路徑都該叫這一支**，
   * 不要只叫 `_copyRolesTo()` —— 漏掉 `smooth` 不會報錯，
   * 只會讓展開圖在**匯入的自由曲線**上突然變得讀不懂（見 `_copySmoothTo`）。
   *
   * 兩個標記回答的是兩個不同的問題（`role` ＝ 製造問題、`smooth` ＝ 形狀問題），
   * 但它們一起活、一起死，所以給一個入口。
   */
  _copyMarksTo(other) {
    this._copyRolesTo(other);
    this._copySmoothTo(other);
    return other;
  }

  // ═════════════════════════════════════════════════════
  //  建構
  // ═════════════════════════════════════════════════════

  /**
   * 把多個網格併成一個，但**不做任何合併運算** ——
   * 只是放在同一份資料裡，各自仍是獨立的殼。
   *
   * ── 什麼時候該用它，什麼時候該用布林聯集 ────────────
   * 實體要用布林聯集，否則兩份重疊的地方會被算兩次，
   * 而且接縫沒有真正縫起來（就是當初換掉 three-bvh-csg 的問題）。
   *
   * **板件則相反，本來就不該合併。**
   * 12 片一樣的側板就是 12 片，展開時要分開出圖；
   * 硬把它們黏成一體，反而讓第 3 期沒辦法分辨。
   * 而且板件是開放的面，布林引擎本來就吃不下（沒有內外之分）。
   *
   * 位置相同的頂點不會被焊接，所以各份保持獨立，這正是要的。
   */
  static merge(meshes) {
    const points = [];
    const faces = [];
    const roles = [];
    let off = 0;

    for (const m of meshes) {
      const vi = m._vertIndex();
      for (const v of m.verts) points.push(v.p.clone());
      for (const f of m.faces) faces.push(m.faceVerts(f).map(v => vi.get(v.id) + off));
      for (const he of m.edges()) {
        if (he.role === EDGE_ROLE.FREE) continue;
        roles.push([vi.get(he.v.id) + off, vi.get(he.to.id) + off, he.role]);
      }
      off += m.verts.length;
    }

    const out = Mesh.fromFaceList(points, faces);

    // 把折線／切割線的標記搬過來。邊界的 cut 是建構時自動補的，
    // 這裡主要是為了保住折線 —— 折板陣列如果掉了折線，第 3 期就展不開。
    if (roles.length) {
      const byPair = new Map();
      const dst = out._vertIndex();
      for (const he of out.edges()) {
        const a = dst.get(he.v.id), b = dst.get(he.to.id);
        byPair.set(`${Math.min(a, b)}-${Math.max(a, b)}`, he);
      }
      for (const [a, b, role] of roles) {
        const he = byPair.get(`${Math.min(a, b)}-${Math.max(a, b)}`);
        if (he) out.setRole(he, role);
      }
    }
    return out;
  }

  /**
   * 由「頂點座標 + 面的頂點索引」建立半邊結構。
   * 這是唯一的建構入口，fromGeometry 也是先轉成這個形式再進來。
   */
  static fromFaceList(points, faceIndices) {
    const m = new Mesh();
    m.verts = points.map(p => new Vertex(p));

    // key「起點id-終點id」→ 半邊。用來配對 twin。
    const dirMap = new Map();

    for (const idx of faceIndices) {
      if (idx.length < 3) { m.issues.push(`跳過只有 ${idx.length} 個點的面`); continue; }

      const face = new Face();
      const loop = [];

      for (let i = 0; i < idx.length; i++) {
        const he = new HalfEdge();
        he.v = m.verts[idx[i]];
        he.face = face;
        if (!he.v.he) he.v.he = he;
        loop.push(he);
        m.halfEdges.push(he);
      }

      for (let i = 0; i < loop.length; i++) {
        loop[i].next = loop[(i + 1) % loop.length];
        loop[i].prev = loop[(i - 1 + loop.length) % loop.length];
      }

      face.he = loop[0];
      m.faces.push(face);

      // 配對 twin
      for (let i = 0; i < loop.length; i++) {
        const a = idx[i], b = idx[(i + 1) % idx.length];
        const key = `${a}-${b}`, rev = `${b}-${a}`;

        if (dirMap.has(key)) {
          m.issues.push(`邊 ${a}→${b} 出現兩次（非流形，這條邊被兩個以上的面共用）`);
        } else {
          dirMap.set(key, loop[i]);
        }
        const twin = dirMap.get(rev);
        if (twin && !twin.twin) {
          twin.twin = loop[i];
          loop[i].twin = twin;
        }
      }
    }

    m._buildBoundaryLoops(dirMap);
    m.computeNormals();
    return m;
  }

  /**
   * 沒有 twin 的半邊 ＝ 網格的邊界（開放的殼，例如一片板子）。
   * 幫它們補上 face 為 null 的邊界半邊，並串成迴圈，
   * 這樣走訪程式碼就不用到處寫 if (he.twin === null)。
   */
  _buildBoundaryLoops(dirMap) {
    const naked = this.halfEdges.filter(he => !he.twin);
    if (!naked.length) return;

    const made = new Map();   // 起點id → 邊界半邊
    for (const he of naked) {
      const b = new HalfEdge();
      b.v = he.to;            // 方向相反
      b.face = null;
      b.twin = he;
      he.twin = b;
      // 邊界天生就是切割線。兩條半邊都要設 —— 只設一邊的話，
      // edges() 走訪時可能剛好讀到另一條，看起來就像沒設。
      b.role = he.role = EDGE_ROLE.CUT;
      this.halfEdges.push(b);
      made.set(b.v.id, b);
    }

    // 串成迴圈：每條邊界半邊的 next，是「從它終點出發」的那條邊界半邊
    for (const b of made.values()) {
      const endV = b.twin.v;
      const nxt = made.get(endV.id);
      if (nxt) { b.next = nxt; nxt.prev = b; }
      else this.issues.push(`邊界迴圈在頂點 ${endV.id} 斷開`);
    }
  }

  /**
   * 由 three.js 的 BufferGeometry 建立。
   * 關鍵是「焊接」——BufferGeometry 的每個三角形各有各的頂點，
   * 位置相同也是不同物件。不焊接就找不到鄰居，半邊結構等於白做。
   *
   * @param {number} weld 焊接容差，單位 cm。預設 0.0001（1 微米）
   */
  static fromGeometry(geometry, weld = 1e-4) {
    let g = geometry;
    if (g.index) g = g.toNonIndexed();
    const pos = g.attributes.position;

    const points = [];
    const map = new Map();
    const inv = 1 / weld;

    const keyOf = (x, y, z) =>
      `${Math.round(x * inv)},${Math.round(y * inv)},${Math.round(z * inv)}`;

    const indexOf = (x, y, z) => {
      const k = keyOf(x, y, z);
      let i = map.get(k);
      if (i === undefined) {
        i = points.length;
        points.push(new THREE.Vector3(x, y, z));
        map.set(k, i);
      }
      return i;
    };

    const faces = [];
    for (let i = 0; i < pos.count; i += 3) {
      const a = indexOf(pos.getX(i),     pos.getY(i),     pos.getZ(i));
      const b = indexOf(pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
      const c = indexOf(pos.getX(i + 2), pos.getY(i + 2), pos.getZ(i + 2));
      if (a === b || b === c || a === c) continue;   // 退化三角形，丟掉
      faces.push([a, b, c]);
    }

    return Mesh.fromFaceList(points, faces);
  }

  /** 存檔用的精簡形式 */
  toJSON() {
    const vi = new Map(this.verts.map((v, i) => [v.id, i]));
    return {
      points: this.verts.flatMap(v => [
        +v.p.x.toFixed(6), +v.p.y.toFixed(6), +v.p.z.toFixed(6)
      ]),
      faces: this.faces.map(f => this.faceVerts(f).map(v => vi.get(v.id))),
      roles: [...this.edges()]
        .filter(he => he.role !== EDGE_ROLE.FREE)
        .map(he => [vi.get(he.v.id), vi.get(he.to.id), he.role]),
      // 平滑旗標跟 roles 一樣用「頂點索引配對」存，不用 id ——
      // id 每次載入都會重新編號，存了也對不回來
      smooth: [...this.edges()]
        .filter(he => he.smooth)
        .map(he => [vi.get(he.v.id), vi.get(he.to.id)])
    };
  }

  static fromJSON(d) {
    const points = [];
    for (let i = 0; i < d.points.length; i += 3) {
      points.push(new THREE.Vector3(d.points[i], d.points[i + 1], d.points[i + 2]));
    }
    const m = Mesh.fromFaceList(points, d.faces);

    if ((d.roles && d.roles.length) || (d.smooth && d.smooth.length)) {
      const idx = new Map(m.verts.map((v, i) => [v.id, i]));
      const byPair = new Map();
      for (const he of m.edges()) {
        const a = idx.get(he.v.id), b = idx.get(he.to.id);
        byPair.set(`${Math.min(a, b)}-${Math.max(a, b)}`, he);
      }
      for (const [a, b, role] of (d.roles || [])) {
        const he = byPair.get(`${Math.min(a, b)}-${Math.max(a, b)}`);
        if (he) m.setRole(he, role);
      }
      for (const [a, b] of (d.smooth || [])) {
        const he = byPair.get(`${Math.min(a, b)}-${Math.max(a, b)}`);
        if (he) m.setSmooth(he, true);
      }
    }
    return m;
  }
}


/**
 * 這一圈頂點是不是凸多邊形（在它自己的平面上看）。
 *
 * 判準：沿著繞向走一圈，每一個轉角的叉積都要跟法向同向。
 * 出現反向就是凹角。
 *
 * ⚠ 容許值刻意用 `-1e-9` 而不是 0：**共線的三個點叉積是 0**，
 * 那不是凹角（一整排共線的點在三角化後的網格上很常見）。
 * 拿 `< 0` 去比會把它們誤判成凹的，然後每個面都跑去走耳切那條慢路。
 */
function isConvexLoop(vs, n) {
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i].p, b = vs[(i + 1) % vs.length].p, c = vs[(i + 2) % vs.length].p;
    const cr = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(b, a),
      new THREE.Vector3().subVectors(c, b));
    if (cr.dot(n) < -1e-9) return false;
  }
  return true;
}
