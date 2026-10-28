/**
 * skinWeld.js — 好幾張面皮一起展開：照複製那一刻的位置焊回去（面皮 B）
 *
 * 🔴 kang 2026-10-28「同意你的建議」→ `每片展開方式-設計方向.md`「面皮 B」、`規格\建模器-面皮.md`「B」：
 *   ① 照**複製那一刻的位置**焊（`skinOf.home`；B 之前的面皮沒記 ⇒ 照現在的）—— 拉開過也接得上；
 *   ② **同一個原本物件**的面皮焊在一起（跨批也焊）；
 *   ③ **疊在一起的那幾張先不焊**（各自展開、講是第幾批的哪一張）。
 * 沙箱（圓柱 3 張面皮）：焊回去接合編號 65 對 ＝ 原本一模一樣；拉開一張照現在的位置焊只剩 1 對、照複製那一刻的 65 對；
 * 兩批全部硬焊 130 對 —— 看起來沒事、其實兩層疊在一起（⇒ 一定先查重疊）。
 *
 * 純函式、⛔ 碰畫面 ⇒ 測試直接驗。
 */

import * as THREE from 'three';
import { Mesh, EDGE_ROLE } from '../core/mesh.js';

/** 複製那一刻的位置角度縮放（矩陣）；B 之前的面皮沒記 ⇒ 現在的 */
export function homeMatrix(s) {
  const h = s.skinOf && s.skinOf.home;
  if (!h) return s.matrix();
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...h.pos),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...h.rot)),
    new THREE.Vector3(...h.scale));
}

/** 座標 → 焊點的 key（1e-5 cm 以內算同一點：同一份原本的座標換來換去，誤差只有 1e-12 那麼小）*/
const keyOf = v => `${Math.round(v.x * 1e5)}|${Math.round(v.y * 1e5)}|${Math.round(v.z * 1e5)}`;

/**
 * 🔴 **疊在一起的面皮**（③）：兩張面皮有面的中心點落在同一個位置（照複製那一刻）⇒ 疊在一起。
 * @param {ModelObject[]} skins 同一個原本物件的面皮
 * @returns {{bad:Set<ModelObject>, pairs:{a:ModelObject, b:ModelObject, n:number}[]}} `bad` ＝ 有跟別張疊到的（先不焊）
 */
export function skinOverlaps(skins) {
  const at = new Map(), pairs = new Map(), bad = new Set();
  skins.forEach((s, si) => {
    const M = homeMatrix(s), m = s.mesh();
    for (const f of m.faces) {
      const c = new THREE.Vector3();
      const vs = m.faceVerts(f);
      for (const v of vs) c.add(v.p.clone().applyMatrix4(M));
      c.multiplyScalar(1 / vs.length);
      const k = `${Math.round(c.x * 1e4)}|${Math.round(c.y * 1e4)}|${Math.round(c.z * 1e4)}`;
      const prev = at.get(k);
      if (prev === undefined) { at.set(k, si); continue; }
      if (prev === si) continue;
      const pk = `${prev}|${si}`;
      pairs.set(pk, (pairs.get(pk) || 0) + 1);
      bad.add(skins[prev]); bad.add(s);
    }
  });
  return { bad, pairs: [...pairs].map(([k, n]) => { const [a, b] = k.split('|').map(Number); return { a: skins[a], b: skins[b], n }; }) };
}

/**
 * 🔴 **焊回去**：每張面皮的點照複製那一刻的位置換到同一個座標系（縮放一起吃進去）、座標一樣的點當同一點；
 * **兩側來自不同面皮的邊標切開**（那就是要接回去的縫 ⇒ 現成那一套接合編號、對位記號）；每張面皮裡面的標記照搬。
 * @param {ModelObject[]} skins 已經查過⛔ 疊在一起的
 * @returns {{mesh:Mesh, owner:Map<number, ModelObject>}} `owner` ＝ 焊好那一份的面 id → 哪張面皮
 */
export function weldSkins(skins) {
  const pts = [], at = new Map(), faces = [], whose = [], vidOf = [];
  skins.forEach((s, si) => {
    const M = homeMatrix(s), m = s.mesh(), map = new Map();
    for (const v of m.verts) {
      const w = v.p.clone().applyMatrix4(M), k = keyOf(w);
      if (!at.has(k)) { at.set(k, pts.length); pts.push(w); }
      map.set(v.id, at.get(k));
    }
    vidOf.push(map);
    for (const f of m.faces) { faces.push(m.faceVerts(f).map(v => map.get(v.id))); whose.push(si); }
  });
  const mesh = Mesh.fromFaceList(pts, faces);
  const owner = new Map();
  mesh.faces.forEach((f, i) => owner.set(f.id, skins[whose[i]]));

  // 每張面皮裡面的標記（折線、切開、不准切、保持尖…）：照「哪兩個焊點」對回去
  const pair = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const marks = new Map();
  skins.forEach((s, si) => {
    const m = s.mesh();
    for (const he of m.halfEdges) {
      if (!he.face || !he.twin || !he.twin.face) continue;
      const mk = m.marksOf(he);
      if (Mesh.marksEmpty(mk)) continue;
      marks.set(`${si}|${pair(vidOf[si].get(he.v.id), vidOf[si].get(he.to.id))}`, mk);
    }
  });
  const nvi = mesh._vertIndex(), done = new Set();
  for (const he of mesh.halfEdges) {
    if (!he.face || !he.twin || !he.twin.face) continue;
    const k = pair(nvi.get(he.v.id), nvi.get(he.to.id));
    if (done.has(k)) continue;
    done.add(k);
    const a = owner.get(he.face.id), b = owner.get(he.twin.face.id);
    if (a !== b) { mesh.setRole(he, EDGE_ROLE.CUT); continue; }
    const mk = marks.get(`${skins.indexOf(a)}|${k}`);
    if (mk) mesh.applyMarks(he, mk);
  }
  mesh.computeNormals();
  return { mesh, owner };
}
