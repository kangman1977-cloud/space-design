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

  /** 有號體積。封閉網格才有意義，用來對答案。 */
  volume() {
    let v = 0;
    for (const f of this.faces) {
      const vs = this.faceVerts(f);
      for (let i = 2; i < vs.length; i++) {
        const a = vs[0].p, b = vs[i - 1].p, c = vs[i].p;
        v += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
      }
    }
    return v;
  }

  /** 表面積 */
  area() {
    let s = 0;
    for (const f of this.faces) {
      const vs = this.faceVerts(f);
      for (let i = 2; i < vs.length; i++) {
        const ab = new THREE.Vector3().subVectors(vs[i - 1].p, vs[0].p);
        const ac = new THREE.Vector3().subVectors(vs[i].p, vs[0].p);
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
      const vs = this.faceVerts(f);
      const n = f.normal;
      for (let i = 2; i < vs.length; i++) {
        for (const v of [vs[0], vs[i - 1], vs[i]]) {
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
    this._copyRolesTo(m);
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
    this._copyRolesTo(m);
    return m;
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

  // ═════════════════════════════════════════════════════
  //  建構
  // ═════════════════════════════════════════════════════

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
        .map(he => [vi.get(he.v.id), vi.get(he.to.id), he.role])
    };
  }

  static fromJSON(d) {
    const points = [];
    for (let i = 0; i < d.points.length; i += 3) {
      points.push(new THREE.Vector3(d.points[i], d.points[i + 1], d.points[i + 2]));
    }
    const m = Mesh.fromFaceList(points, d.faces);

    if (d.roles && d.roles.length) {
      const byPair = new Map();
      const vi = new Map(m.verts.map((v, i) => [i, v]));
      for (const he of m.edges()) {
        const a = m.verts.indexOf(he.v), b = m.verts.indexOf(he.to);
        byPair.set(`${Math.min(a, b)}-${Math.max(a, b)}`, he);
      }
      for (const [a, b, role] of d.roles) {
        const he = byPair.get(`${Math.min(a, b)}-${Math.max(a, b)}`);
        if (he) m.setRole(he, role);
      }
      void vi;
    }
    return m;
  }
}
