/**
 * meshReduce.js — 匯入之後再減面（物件面板、拉點線面選面）（2026-10-31 → `規格\建模器-匯入3D模型.md`「匯入之後再減面」、
 * `三視圖導入-研究.md` 實驗 13；kang 2026-10-31「照你的建議」(a)～(j)）
 *
 * 實驗 10 改造時刪掉內層之後想再減就得重新匯入 ⇒ 匯入視窗那一套（`decimate()`、不讓面互相穿過去、對稱減面）搬到物件上。
 * 實驗 13：匯入 2,000 面之後再減到 500 跟匯入時直接減一樣好（0.27 秒）；**縫這些標記減完幾乎都沒了**（1,088 條剩 9 條），
 * 保住就減不下去（2,000 → 1,938）⇒ 預設清掉、先講清掉幾條，可以勾「保留有標記的線」（線上的點不動）；
 * 只減選到的面做得到（其他面的點不動），目標照「選到的那幾面減到多少」算。
 * 直接改網格、Ctrl+Z 退得回去（呼叫的人負責記一步）。
 */

import * as THREE from 'three';
import { Mesh, EDGE_ROLE, CREASE } from '../core/mesh.js';
import { decimate, surfaceDev } from './decimate.js';
import { symDecimate } from './symmetry.js';

/** 有沒有「人標的」標記：切開、折、不准切、硬邊（環切的線、匯入的格線）、自己標的尖／圓（照轉折判的不算 —— 平滑細分會重判）*/
export function marked(m) {
  return m.role !== EDGE_ROLE.FREE || m.keep || m.hard || m.crease === CREASE.SHARP || m.crease === CREASE.SMOOTH;
}

/** 數這份網格上人標的標記（給「會清掉幾條」用）*/
export function countMarks(mesh) {
  const c = { cut: 0, fold: 0, keep: 0, hard: 0, crease: 0, total: 0 };
  for (const he of mesh.edges()) {
    const m = mesh.marksOf(he);
    if (!marked(m)) continue;
    c.total++;
    if (m.role === EDGE_ROLE.CUT) c.cut++;
    else if (m.role === EDGE_ROLE.FOLD) c.fold++;
    if (m.keep) c.keep++;
    if (m.hard) c.hard++;
    if (m.crease === CREASE.SHARP || m.crease === CREASE.SMOOTH) c.crease++;
  }
  return c;
}

/** 「會清掉／清掉了 N 條縫…」那一串字 */
export function marksText(c) {
  const t = [];
  if (c.cut) t.push(`${c.cut} 條縫`);
  if (c.fold) t.push(`${c.fold} 條折線`);
  if (c.keep) t.push(`${c.keep} 條不准切`);
  if (c.hard) t.push(`${c.hard} 條硬邊（環切的線、匯入的格線）`);
  if (c.crease) t.push(`${c.crease} 條自己標的尖／圓`);
  return t.join('、');
}

/**
 * 減面。
 * @param {Mesh} mesh
 * @param {{target:number, faces?:Set<object>|null, noCross?:boolean, keepMarks?:boolean, sym?:{ax:number, c:number, side:number}|null}} o
 *   `target` ＝ 整個減到幾個面；`faces` 有給 ⇒ 只減這些面（`target` 是「這些面」要減到幾個），其他面的點不動；
 *   `keepMarks` ⇒ 有標記的線上的點不動（標記留得住，減得比較少）；`sym` ⇒ 對稱減面（整個物件、沒勾保留標記時才用）
 * @returns {{ok:boolean, reason?:string, mesh?:Mesh, before:number, after:number, want:number, dev:number,
 *   selN:number, selAfter:number, dropped:object, kept:number, symBad:string, sym:boolean, short:boolean}}
 *   `selAfter` ＝ 選到的那幾面減完剩幾個（沒選 ＝ 整個）；`short` ＝ 比目標多太多（減不下去）
 */
export function reduceMesh(mesh, { target, faces = null, noCross = false, keepMarks = false, sym = null } = {}) {
  const vi = mesh._vertIndex();
  const points = mesh.verts.map(v => [v.p.x, v.p.y, v.p.z]);
  const flist = mesh.faces;
  const fArr = flist.map(f => mesh.faceVerts(f).map(v => vi.get(v.id)));
  const before = flist.length;
  const selN = faces ? flist.filter(f => faces.has(f)).length : before;
  if (!(target >= 4)) return { ok: false, reason: '打一個面數（至少 4）', before, after: before };
  if (target >= selN) return { ok: false, reason: faces ? `選到的只有 ${selN} 個面，比 ${target} 少 —— 不用減` : `現在只有 ${before} 個面，比 ${target} 少 —— 不用減`, before, after: before };
  // 標記：照「兩個點的編號」記下來
  const ek = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
  const marks = new Map(), all = { cut: 0, fold: 0, keep: 0, hard: 0, crease: 0, total: 0 };
  for (const he of mesh.edges()) {
    const m = mesh.marksOf(he);
    if (!Mesh.marksEmpty(m)) marks.set(ek(vi.get(he.v.id), vi.get(he.to.id)), m);
  }
  Object.assign(all, countMarks(mesh));
  // 不動的點：沒選到的面上的點（只減選到的）、有標記的線上的點（保留標記）
  let keep = null;
  if (faces) { keep = new Set(); flist.forEach((f, i) => { if (!faces.has(f)) for (const v of fArr[i]) keep.add(v); }); }
  if (keepMarks) { keep = keep || new Set(); for (const [k, m] of marks) if (marked(m)) for (const v of k.split('-')) keep.add(+v); }
  const want = faces ? before - selN + target : target;
  const p = { points, faces: fArr };
  let out = null, symBad = '', usedSym = false;
  if (sym && !faces && !keepMarks) {
    const y = symDecimate(p, { target: want, ax: sym.ax, c: sym.c, side: sym.side, noCross });
    if (y.bad) symBad = y.bad; else { out = y; usedSym = true; }
  }
  if (!out) out = decimate(p, { target: want, keep, noCross });
  if (out.faces.length >= before) {
    /** 本機滑鼠驗證看到：縫 355 條勾保留 ⇒ 一個都減不掉，原本只講「破洞、翻面、穿面」—— 真正的原因是不動的點 ⇒ 照實講、指路 */
    const why = keepMarks ? ' —— 有標記的線上的點都不動（標得多就減不下去）：拿掉「保留有標記的線」再減，減完再標'
      : faces ? '（選到的面邊上的點不動；再減會弄出破洞、讓面翻過去或互相穿過去）' : '（再減會弄出破洞、讓面翻過去或互相穿過去）';
    return { ok: false, reason: '一個面都減不掉' + why, before, after: before };
  }
  const nm = Mesh.fromFaceList(out.points.map(q => new THREE.Vector3(q[0], q[1], q[2])), out.faces);
  /**
   * 標記補回去：沒動到的點（不動的點、或剛好沒被合到的）位置一模一樣 ⇒ 照位置對回原本的編號，
   * 兩頭都對得上、而且還連著的邊照原本帶。
   */
  const posKey = q => q[0] + ',' + q[1] + ',' + q[2];
  const old = new Map(points.map((q, i) => [posKey(q), i]));
  const map = out.points.map(q => old.get(posKey(q)));
  const nvi = nm._vertIndex();
  let kept = 0;
  const left = { cut: 0, fold: 0, keep: 0, hard: 0, crease: 0, total: 0 };
  for (const he of nm.edges()) {
    const a = map[nvi.get(he.v.id)], b = map[nvi.get(he.to.id)];
    if (a === undefined || b === undefined) continue;
    const m = marks.get(ek(a, b));
    if (!m) continue;
    nm.applyMarks(he, m);
    if (marked(m)) kept++;
  }
  Object.assign(left, countMarks(nm));
  const dropped = {};
  for (const k of Object.keys(all)) dropped[k] = Math.max(0, all[k] - left[k]);
  /**
   * 減不下去：拿「選到的那幾面」減完剩幾個跟目標比（沒選 ＝ 整個）。
   * 線上先驗看到：拿整個比，選 64 面要減到 19 只減到 62，2,046 沒超過 2,003 的 1.05 倍 ⇒ 沒講（kang 2026-11-01「照你的建議修」）
   */
  const selAfter = out.faces.length - (before - selN);
  return { ok: true, mesh: nm, before, after: out.faces.length, want, selN, selAfter, dev: surfaceDev(p, out), dropped, kept, symBad, sym: usedSym,
    short: selAfter > target * 1.05 + 2 };
}
