/**
 * region.js — 平面區域合併與曲面分類
 *
 * 這個檔案是展開引擎的地基。它不知道材料是什麼，只做純幾何的事：
 * 把三角形湯整理成「一片一片有意義的面」，並判斷哪些地方攤得平。
 *
 * ── 為什麼需要它 ────────────────────────────────────
 * 布林運算完的方塊是 12 個三角形，但人看到的是 6 個面。
 * 直接拿三角形去展開，會得到滿地碎三角形，沒有一片能用。
 * 所以展開前一定要先合併，這一步跳不掉。
 *
 * ── 兩種「攤得平」，別搞混 ──────────────────────────
 *   共面 (coplanar)      本來就在同一個平面上，例如方塊的一個面
 *   可展 (developable)   彎的，但攤得平，例如圓柱的側面
 *
 * 判斷可展用的是高斯的絕妙定理：把一個頂點周圍所有夾角加起來，
 * 等於 360° 就攤得平，小於 360° 就是球面那種攤不平的地方。
 * 差額叫「角虧」(angle defect)，就是離散版的高斯曲率。
 */

import * as THREE from 'three';
import { EDGE_ROLE } from './mesh.js';

/** 曲面種類 */
export const SURFACE = {
  PLANAR:          'planar',           // 平的
  DEVELOPABLE:     'developable',      // 彎的但攤得平（圓柱、圓錐）
  NON_DEVELOPABLE: 'non-developable'   // 攤不平（球面、自由曲面）
};

// ═══════════════════════════════════════════════════════
//  平面區域
// ═══════════════════════════════════════════════════════

export class Region {
  constructor(id) {
    this.id = id;
    this.faces = [];
    this.normal = new THREE.Vector3();
    this.d = 0;                 // 平面方程 normal·p = d
    this.loops = [];            // 邊界迴圈，每個是頂點陣列（已去掉共線點）
    this.area = 0;
  }
  /** 外輪廓 ＝ 最長的那個迴圈；其餘是內孔 */
  get outer() { return this.loops[0] || []; }
  get holes() { return this.loops.slice(1); }
}

/**
 * 把共面且相鄰的面合併成區域。
 *
 * 注意：這是「貼標籤」，不是真的把面刪掉重建。
 * 原本的三角形都還在，只是多了 face.region 這個歸屬。
 * 這樣做是可逆的 —— 換個容許角度重跑一次就好，不會把資料弄壞。
 *
 * @param {Mesh} mesh
 * @param {number} tolDeg 容許的轉折角，超過就算不同片。預設 0.5 度
 * @returns {Region[]}
 */
export function planarRegions(mesh, tolDeg = 0.5) {
  mesh.computeNormals();
  for (const f of mesh.faces) f.region = -1;

  const regions = [];

  for (const seed of mesh.faces) {
    if (seed.region !== -1) continue;

    const r = new Region(regions.length);
    regions.push(r);

    // 泛洪：只要共用的邊夠平，就是同一片
    const stack = [seed];
    seed.region = r.id;

    while (stack.length) {
      const f = stack.pop();
      r.faces.push(f);

      for (const he of mesh.faceLoop(f)) {
        const nb = he.twin && he.twin.face;
        if (!nb || nb.region !== -1) continue;
        if (!mesh.isFlat(he, tolDeg)) continue;
        nb.region = r.id;
        stack.push(nb);
      }
    }

    finishRegion(mesh, r);
  }

  return regions;
}

/** 算出區域的平面、面積、邊界迴圈 */
function finishRegion(mesh, r) {
  // 平面：用面積加權平均法向量，比隨便取一個面穩
  const n = new THREE.Vector3();
  let area = 0;
  const centroid = new THREE.Vector3();

  for (const f of r.faces) {
    // 非凸的面要走耳切，不然面積與重心都會多算（見 mesh.faceTriangles）
    for (const [v0, v1, v2] of mesh.faceTriangles(f)) {
      const vs = [v0, v1, v2];
      const i = 2;
      const ab = new THREE.Vector3().subVectors(vs[i - 1].p, vs[0].p);
      const ac = new THREE.Vector3().subVectors(vs[i].p, vs[0].p);
      const cr = new THREE.Vector3().crossVectors(ab, ac);
      const a = cr.length() / 2;
      area += a;
      n.addScaledVector(cr, 0.5);
      centroid.addScaledVector(
        new THREE.Vector3().add(vs[0].p).add(vs[i - 1].p).add(vs[i].p).divideScalar(3), a
      );
    }
  }

  r.area = area;
  if (area > 1e-12) centroid.divideScalar(area);
  if (n.lengthSq() > 1e-20) n.normalize();
  r.normal.copy(n);
  r.d = n.dot(centroid);

  r.loops = regionLoops(mesh, r).map(loop => simplifyCollinear(loop));
  r.loops.sort((a, b) => b.length - a.length);   // 最長的當外輪廓
}

/**
 * 抓出區域的邊界迴圈。
 * 邊界半邊 ＝ 自己在區域內、但隔壁不在（或根本沒有隔壁）。
 */
function regionLoops(mesh, r) {
  const inR = f => f && f.region === r.id;
  const isBorder = he => he.face && inR(he.face) && !inR(he.twin && he.twin.face);

  const border = new Set();
  for (const f of r.faces) {
    for (const he of mesh.faceLoop(f)) if (isBorder(he)) border.add(he);
  }

  const loops = [];
  const used = new Set();

  for (const start of border) {
    if (used.has(start)) continue;

    const loop = [];
    let he = start;
    let guard = 0;

    do {
      used.add(he);
      loop.push(he.v);

      // 繞著 he 的終點轉，找下一條邊界半邊
      let c = he.next;
      let spin = 0;
      while (c && !isBorder(c) && spin++ < 1e5) {
        if (!c.twin) break;
        c = c.twin.next;
      }
      if (!c || !isBorder(c)) break;
      he = c;
    } while (he !== start && guard++ < 1e6);

    if (loop.length >= 3) loops.push(loop);
  }

  return loops;
}

/**
 * 去掉迴圈上的共線頂點。
 * 合併之後邊界上會留下一堆「在直線中間」的點（三角化的殘留），
 * 方塊的一個面可能有 6 個點而不是 4 個。展開和標尺寸前一定要清掉。
 */
export function simplifyCollinear(loop, tolDeg = 0.1) {
  if (loop.length < 3) return loop.slice();
  const out = [];
  const tol = Math.cos(THREE.MathUtils.degToRad(180 - tolDeg));

  for (let i = 0; i < loop.length; i++) {
    const prev = loop[(i - 1 + loop.length) % loop.length].p;
    const cur  = loop[i].p;
    const next = loop[(i + 1) % loop.length].p;

    const a = new THREE.Vector3().subVectors(prev, cur);
    const b = new THREE.Vector3().subVectors(next, cur);
    if (a.lengthSq() < 1e-20 || b.lengthSq() < 1e-20) continue;
    a.normalize(); b.normalize();

    // 夾角接近 180 度 ＝ 這個點在直線中間，可以拿掉
    if (a.dot(b) <= tol) continue;
    out.push(loop[i]);
  }
  return out.length >= 3 ? out : loop.slice();
}

// ═══════════════════════════════════════════════════════
//  曲面分類（高斯曲率）
// ═══════════════════════════════════════════════════════

/**
 * 一次掃過所有面，累加每個頂點周圍的夾角，並標出邊界頂點。
 *
 * 這是刻意寫成「掃一遍」而不是「每個頂點各查一次」：
 * 後者是 O(頂點數 × 面數)，一個上萬面的模型會卡到讓人以為當掉。
 * 掃一遍是 O(面數)。
 *
 * @returns {{sums: Map<Vertex, number>, boundary: Set<Vertex>}}
 */
export function curvatureData(mesh) {
  const sums = new Map();
  const boundary = new Set();

  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3();

  for (const f of mesh.faces) {
    const vs = mesh.faceVerts(f);
    const n = vs.length;
    for (let i = 0; i < n; i++) {
      const v = vs[i];
      e1.subVectors(vs[(i - 1 + n) % n].p, v.p);
      e2.subVectors(vs[(i + 1) % n].p, v.p);
      if (e1.lengthSq() < 1e-20 || e2.lengthSq() < 1e-20) continue;
      sums.set(v, (sums.get(v) || 0) + e1.angleTo(e2));
    }
  }

  // 邊界半邊的起點與終點都是邊界頂點
  for (const he of mesh.halfEdges) {
    if (he.face) continue;
    boundary.add(he.v);
    if (he.twin) boundary.add(he.twin.v);
  }

  return { sums, boundary };
}

/**
 * 頂點的「角虧」：360° 減掉周圍所有面在這個頂點的夾角總和。
 *
 *   ≈ 0     這一點攤得平（平面、圓柱側面、圓錐側面都是）
 *   > 0     像球面那樣往外鼓
 *   < 0     像馬鞍那樣的鞍點
 *
 * 這就是離散版的高斯曲率。整個封閉曲面的角虧總和恆等於 4π，
 * 不管形狀怎麼變 —— 這正是「球面攤不平」的數學根源。
 *
 * 要問很多個頂點時，先自己呼叫一次 curvatureData() 把結果傳進來，
 * 不然每問一次就會重掃一遍整個網格。
 *
 * @returns {number|null} 弧度；邊界頂點回傳 null（角虧對它沒定義）
 */
export function angleDefect(mesh, v, data = null) {
  const d = data || curvatureData(mesh);
  if (d.boundary.has(v)) return null;
  return 2 * Math.PI - (d.sums.get(v) || 0);
}

/**
 * 用角虧掃描整個網格，回報攤不平的地方在哪。
 * 展開前先跑這個，就知道要不要切分、要切在哪一帶。
 *
 * @param {number} tolDeg 角虧容許值，預設 0.5 度
 */
export function surveyCurvature(mesh, tolDeg = 0.5) {
  const tol = THREE.MathUtils.degToRad(tolDeg);
  const flat = [], curved = [], saddle = [], boundary = [];
  let total = 0;

  const data = curvatureData(mesh);

  for (const v of mesh.verts) {
    const k = angleDefect(mesh, v, data);
    if (k === null) { boundary.push(v); continue; }
    total += k;
    if (Math.abs(k) <= tol) flat.push(v);
    else if (k > 0) curved.push(v);
    else saddle.push(v);
  }

  const kind = (curved.length || saddle.length)
    ? SURFACE.NON_DEVELOPABLE
    : SURFACE.DEVELOPABLE;

  return {
    kind,
    flat, curved, saddle, boundary,
    /** 角虧總和。封閉且無孔的曲面應該 ≈ 4π ≈ 12.566 */
    totalDefect: total,
    /** 攤不平的頂點佔比，用來估計展開的困難度 */
    ratio: mesh.verts.length ? (curved.length + saddle.length) / mesh.verts.length : 0
  };
}

/**
 * 一份給人看的摘要。之後展開面板會直接顯示這些數字。
 */
export function summarize(mesh, tolDeg = 0.5) {
  const regions = planarRegions(mesh, tolDeg);
  const curv = surveyCurvature(mesh, tolDeg);

  let folds = 0, cuts = 0;
  for (const he of mesh.edges()) {
    if (he.role === EDGE_ROLE.FOLD) folds++;
    else if (he.role === EDGE_ROLE.CUT) cuts++;
  }

  return {
    regions: regions.length,
    largestRegion: regions.reduce((m, r) => Math.max(m, r.area), 0),
    surface: curv.kind,
    totalDefect: curv.totalDefect,
    curvedVerts: curv.curved.length + curv.saddle.length,
    folds, cuts,
    _regions: regions,
    _curv: curv
  };
}
