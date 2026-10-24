/**
 * stackModel.js — 疊板立體預覽要畫的東西（純幾何，不碰畫面）
 *
 * 🔴 第二輪第五批 5b（2026-10-24，kang「方案一（視窗最上面一塊 3D 小畫面），預設＋可以調照表，
 * 只黏一點點只塗小的那塊＋在黏的那一點畫圈」→ `規格\建模器-剖面分切.md`「疊板立體預覽」）。
 *
 * 每一片的每一塊（外圈＋它裡面的洞）照那片的板厚擠成一塊板，放回模型原本的位置，照順序疊起來。
 * 顏色照 `slice/section.js` `stackCheck()` 記在輪廓上的：掉下來的（`loose`）紅、只黏一點點的小塊（`weak`）黃；
 * 圈的位置另外給（`rings`），由畫面那邊做成永遠看得到的圈 —— 這裡⛔ 碰 DOM，所以 node 測得到。
 *
 * 座標：片的平面座標 (x, y) 走 `AXES[axis].uv`，片的位置走 `dir` —— 跟 `sectionAt()` 同一套，
 * 所以疊出來的板跟主畫面的模型在同一個地方（淡淡的原模型才疊得上）。
 */

import * as THREE from 'three';
import { AXES } from '../slice/section.js';

/** 跟排版預覽同一組顏色（`out/sheet.js` 的 markLoose／markWeak）*/
export const STACK3D_COLORS = { wood: 0xc9a77a, loose: 0xe74c3c, weak: 0xef9f27, ghost: 0xa9c8f0, rod: 0x8e44ad, rodManual: 0x2f7fe0 };

/** 淡淡的原模型：超過這麼多個三角形預設不疊（汽車 54.8 萬面要在小畫面再放一份）；勾了照樣疊 */
export const GHOST_MAX_TRIS = 50000;

/** 小塊才加圈：外框最長邊比整疊的這個比例小（大的板子塗色就看得到，圈它只是一個大圈）*/
const RING_MAX_FRAC = 0.15;
/** 圈至少整疊的這個比例（排版預覽是 4%，3D 拉遠了看再大一點）*/
const RING_MIN_FRAC = 0.05;

/** 點在不在一圈裡（奇偶）*/
function inLoop(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

/** 一片的每一塊：外圈＋落在它裡面的洞（洞找最小的那個外圈）*/
export function slicePieces(slice) {
  const outer = slice.loops.filter(l => !l.isHole);
  const out = outer.map(l => ({ outer: l, holes: [], area: Math.abs(l.area) }));
  for (const h of slice.loops.filter(l => l.isHole)) {
    const q = h.pts[0];
    let host = null;
    for (const o of out) if (o.area > Math.abs(h.area) && inLoop(o.outer.pts, q.x, q.y) && (!host || o.area < host.area)) host = o;
    if (host) host.holes.push(h);
  }
  return out;
}

/**
 * 把切好的一疊建成 3D。
 * @param {object[]} slices `sliceMany()` 的 `slices`
 * @param {string} axis 'x'|'y'|'z'
 * @param {{from?:number, to?:number, explode?:boolean, faint?:boolean, rods?:object[], rodD?:number}} opt
 *   from／to：只看第幾片到第幾片（片號，含頭尾；沒給 ＝ 全部）；
 *   explode：片跟片之間空一點（平均板厚的 0.8 倍）；faint：沒問題的片變淡（只看紅黃的）；
 *   rods：定位孔的桿子 `[{x, y, from, to, manual}]`（5c，`pegs.js` `holesFromAuto()` 排好的）、rodD：孔徑
 * @returns {{group: THREE.Group, rings: {kind:'loose'|'weak', pos: THREE.Vector3, r:number}[], box: THREE.Box3, tris:number, shown:number}}
 *   group 裡的每一塊板是一個 Mesh，`userData.slice` ＝ 片號（點一片跳到它的卡片用）
 */
export function buildStack(slices, axis, opt = {}) {
  const A = AXES[axis] || AXES.y;
  const u = new THREE.Vector3(...A.uv[0]), v = new THREE.Vector3(...A.uv[1]), w = new THREE.Vector3(...A.dir);
  const from = opt.from == null || opt.from === '' ? -Infinity : opt.from, to = opt.to == null || opt.to === '' ? Infinity : opt.to;     // 6a 互卡：側面是第 0 塊
  const all = slices.filter(s => s.loops.length);
  const meanT = all.length ? all.reduce((a, s) => a + s.t, 0) / all.length : 1;
  /** 6a 互卡：每一塊零件自己帶方向（側面、肋不同方向）⇒ 放在自己的平面上、⛔ 拉開（拉開只對疊層有意義）*/
  const mixed = slices.some(s => s.axis);
  const gap = opt.explode && !mixed ? meanT * 0.8 : 0;
  const basisOf = s => { const B = AXES[s.axis] || A; return [new THREE.Vector3(...B.uv[0]), new THREE.Vector3(...B.uv[1]), new THREE.Vector3(...B.dir)]; };

  // 整疊的大小（圈的大小照它）—— 用全部的片，⛔ 只看選到的那幾片（不然圈的大小會跟著範圍跳）
  let size = 0;
  {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const s of all) {
      z0 = Math.min(z0, s.z0); z1 = Math.max(z1, s.z1);
      x0 = Math.min(x0, s.bounds.minX); x1 = Math.max(x1, s.bounds.maxX);
      y0 = Math.min(y0, s.bounds.minY); y1 = Math.max(y1, s.bounds.maxY);
    }
    if (all.length) size = Math.max(x1 - x0, y1 - y0, z1 - z0);
  }

  const group = new THREE.Group();
  const rings = [];
  const mats = {};
  const mat = (kind, faint) => mats[kind + faint] || (mats[kind + faint] = new THREE.MeshLambertMaterial({
    color: STACK3D_COLORS[kind], transparent: faint, opacity: faint ? 0.12 : 1, depthWrite: !faint
  }));
  const lineMat = new THREE.LineBasicMaterial({ color: 0x5a4630, transparent: true, opacity: 0.55 });
  const line = [];
  let tris = 0, shown = 0;
  const at = (x, y, z) => u.clone().multiplyScalar(x).add(v.clone().multiplyScalar(y)).add(w.clone().multiplyScalar(z));
  const atS = (s, x, y, z) => { if (!s.axis) return at(x, y, z); const [su, sv, sw] = basisOf(s); return su.multiplyScalar(x).add(sv.multiplyScalar(y)).add(sw.multiplyScalar(z)); };

  slices.forEach((s, k) => {
    if (!s.loops.length || s.index < from || s.index > to) return;
    shown++;
    const off = s.z0 + k * gap, t = s.z1 - s.z0;
    const [bu, bv, bw] = s.axis ? basisOf(s) : [u, v, w];
    const basis = new THREE.Matrix4().makeBasis(bu, bv, bw).setPosition(bw.clone().multiplyScalar(off));
    for (const pc of slicePieces(s)) {
      const kind = pc.outer.loose ? 'loose' : (pc.outer.weak ? 'weak' : 'wood');
      const faint = !!opt.faint && kind === 'wood';
      const shape = new THREE.Shape(pc.outer.pts.map(p => new THREE.Vector2(p.x, p.y)));
      for (const h of pc.holes) shape.holes.push(new THREE.Path(h.pts.map(p => new THREE.Vector2(p.x, p.y))));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1 });
      geo.applyMatrix4(basis);
      tris += geo.index ? geo.index.count / 3 : geo.attributes.position.count / 3;
      const mesh = new THREE.Mesh(geo, mat(kind, faint));
      mesh.userData.slice = s.index;
      group.add(mesh);
      // 板子的上下兩圈畫線，一片一片才分得出來（變淡的片⛔ 畫）
      if (!faint) {
        for (const l of [pc.outer, ...pc.holes]) {
          for (const z of [off, off + t]) {
            for (let i = 0; i < l.pts.length; i++) {
              const a = l.pts[i], b = l.pts[(i + 1) % l.pts.length];
              const p = atS(s, a.x, a.y, z), q = atS(s, b.x, b.y, z);
              line.push(p.x, p.y, p.z, q.x, q.y, q.z);
            }
          }
        }
      }
      // 掉下來的小塊加紅圈（大的板子塗色就看得到）；只黏一點點的圈畫在黏的那一點（下面），⛔ 圈小塊本身 —— 跟排版預覽一樣
      if (kind === 'loose') {
        const bb = boxOf(pc.outer.pts);
        if (Math.max(bb.w, bb.h) < size * RING_MAX_FRAC) {
          rings.push({ kind, pos: atS(s, (bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2, off + t / 2),
            r: Math.max(Math.hypot(bb.w, bb.h, t) * 0.8, size * RING_MIN_FRAC) });
        }
      }
    }
  });

  // 只黏一點點：在黏的那一點畫黃圈（兩片交界的高度；兩片都在範圍裡才畫）
  const seen = new Set();
  slices.forEach((s, k) => {
    for (const g of s.glue || []) {
      /** 6a 互卡：卡不牢的交叉點記在肋上（with 0）、側面上（with ＝ 肋號）—— 從肋畫一次，畫在那一塊的正中間 */
      if (s.axis) {
        if (g.with !== 0 || s.index < from || s.index > to) continue;
        rings.push({ kind: 'weak', pos: atS(s, g.x, g.y, (s.z0 + s.z1) / 2), r: size * RING_MIN_FRAC });
        continue;
      }
      if (g.with !== s.index + 1) continue;                 // 每一對只畫一次（從下面那片畫）
      if (s.index < from || g.with > to) continue;
      const key = `${s.index}:${g.x.toFixed(4)}:${g.y.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rings.push({ kind: 'weak', pos: at(g.x, g.y, s.z1 + k * gap + gap / 2), r: size * RING_MIN_FRAC });
    }
  });

  /**
   * 5c：定位孔的桿子（只看、⛔ 在 3D 裡放）—— 從那一段最下面一片的底到最上面一片的頂；自動的紫、手動的藍（跟孔位圖同色）。
   * ⚠ 畫的粗細至少整疊的 1.2%：0.5 cm 的桿子在 38 cm 的獅子頭上細到看不見（沙箱對照圖撞過）。
   */
  for (const r of opt.rods || []) {
    const ka = slices.findIndex(s => s.index === Math.max(r.from, from)), kb = slices.findIndex(s => s.index === Math.min(r.to, to));
    if (ka < 0 || kb < 0 || ka > kb) continue;
    const z0 = slices[ka].z0 + ka * gap, z1 = slices[kb].z1 + kb * gap;
    const p0 = at(r.x, r.y, z0), p1 = at(r.x, r.y, z1);
    const rad = Math.max((opt.rodD || 0.5) / 2, size * 0.006);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, p0.distanceTo(p1) + size * 0.02, 12),
      new THREE.MeshLambertMaterial({ color: r.manual ? STACK3D_COLORS.rodManual : STACK3D_COLORS.rod }));
    m.position.copy(p0.clone().add(p1).multiplyScalar(0.5));
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), w.clone());
    m.userData.rod = true;
    group.add(m);
  }

  if (line.length) {
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(line, 3));
    group.add(new THREE.LineSegments(lg, lineMat));
  }
  const box = new THREE.Box3().setFromObject(group);
  return { group, rings, box, tris: Math.round(tris), shown };
}

function boxOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** 淡淡的原模型（世界座標的網格，跟切的時候同一份）*/
export function ghostOf(meshes) {
  const group = new THREE.Group();
  // ⚠ 視窗是深色底：0.12 幾乎看不到（本機抓到）⇒ 淺藍、0.22
  // ⚠ 原模型的面跟板子的側面常常在同一個位置（方塊切出來剛好貼齊）⇒ 兩個搶著畫、板子上出現一條條斑紋（本機抓到）
  //   ⇒ 原模型往後推一點（polygonOffset），貼在一起的地方讓板子贏
  const m = new THREE.MeshBasicMaterial({ color: STACK3D_COLORS.ghost, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2 });
  for (const mesh of meshes) group.add(new THREE.Mesh(mesh.toGeometry(), m));
  return group;
}

/** 這些網格一共幾個三角形（決定要不要預設疊原模型）*/
export function trisOf(meshes) {
  return meshes.reduce((a, m) => a + m.triangleCount(), 0);
}

/** 用完要丟掉顯示卡上的東西 */
export function disposeGroup(group) {
  group.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
  });
}
