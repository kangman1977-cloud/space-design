/**
 * importSolid.js — 匯入時「整理成實體」（網格核心第五批 b ③a，2026-10-24 → `規格\建模器-網格核心.md`「第五批 b ③a」、
 * `匯入整理-研究.md` 第 9、10 節；kang 2026-10-24「第 ③ 小批照你的建議：拆成 ③a、③b，只有破洞的改建議補洞＋修方向，先做 ③a」）
 *
 * 照 kang 10-22「預覽＋建議、由人選」：視窗並排幾個做法，每個都量出數字、畫一張小圖，程式標一個建議，人按了才算。
 * 做法（`SOLID_MODES`）：
 *   - **原樣**：照檔案（每一塊都封閉、沒有穿插的建議這個）
 *   - **補洞＋修方向**：每個部分用建模器現成的「補洞」（`fillHoles()`）＋「修法向」（`recalcNormalsOutside()`）——
 *     補的只是洞口，其他表面一點都不動（頭盔整塊重算剖面少 1.8～3.3%，補洞 0）。只有破洞或翻面的建議這個
 *   - **聯集成一個實體**：每一塊先補洞修方向，封閉的全部聯集（`bool.js` `unionSolids()`，碎屑丟掉）；
 *     裡面有隔板（三面共用的邊）的那幾塊照原樣另外放 —— 隔板是 ③b 的事。零件之間有穿插的建議這個
 * 都在讀檔、焊點之後、拆部分之前做（檔案單位）⇒ 輸出跟 `cleanModel()` 一樣的形狀，後面拆部分、判斷平面、清碎面照舊；
 * 🔴 整理好的資料⛔ 再焊點（第 ① 小批查到：Manifold 在零件碰到的地方刻意讓點分開，焊了就壞）—— 這裡做完就不會再進 `cleanModel()`。
 */

import * as THREE from 'three';
import { Mesh } from '../core/mesh.js';
import { fillHoles, recalcNormalsOutside } from '../core/edit.js';
import { unionSolids, csgReady } from './bool.js';
import { edgeCheck } from './import3d.js';

export const SOLID_MODES = { raw: '原樣', fill: '補洞＋修方向', union: '聯集成一個實體' };
/** 穿插：重疊的體積（各塊加總 − 聯集）佔各塊加總的這個比例以上才算（浮點誤差以下的不算）*/
export const OVERLAP_MIN = 1e-4;

/** 照共用的點分成一塊一塊（「零件」，⛔ 一定是設計者心裡的零件）；回傳每一塊的面編號 */
export function components(faces, nPoints) {
  const par = new Int32Array(nPoints).map((_, i) => i);
  const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (const f of faces) for (let k = 1; k < f.length; k++) { const a = find(f[0]), b = find(f[k]); if (a !== b) par[a] = b; }
  const g = new Map();
  faces.forEach((f, i) => { const k = find(f[0]); if (!g.has(k)) g.set(k, []); g.get(k).push(i); });
  return [...g.values()];
}

/**
 * 原檔每一塊的狀況：乾淨（封閉、方向一致）／只有破洞或翻面／有隔板（三面以上共用的邊）。
 * @param {{points, faces}} r 焊點之後（`cleanModel()`）
 */
export function solidCheck(r) {
  const comps = components(r.faces, r.points.length);
  const out = { comps: comps.length, clean: 0, holes: 0, partition: 0, openEdges: 0, flipEdges: 0, nmEdges: 0 };
  for (const c of comps) {
    const e = edgeCheck(c.map(i => r.faces[i]));
    out.openEdges += e.open; out.flipEdges += e.flipped; out.nmEdges += e.nonManifold;
    if (e.nonManifold) out.partition++;
    else if (e.open || e.flipped) out.holes++;
    else out.clean++;
  }
  return out;
}

/** 一組面（原檔的點編號）→ 建模器的網格（自己的點編號）*/
function toMesh(points, faces) {
  const used = new Map(), P = [];
  const F = faces.map(f => f.map(i => { if (!used.has(i)) { used.set(i, P.length); P.push(new THREE.Vector3(points[i][0], points[i][1], points[i][2])); } return used.get(i); }));
  return Mesh.fromFaceList(P, F);
}
/** 網格 → 點、面（陣列）*/
function fromMesh(m) {
  const vi = m._vertIndex();
  return { points: m.verts.map(v => [v.p.x, v.p.y, v.p.z]), faces: m.faces.map(f => m.faceVerts(f).map(v => vi.get(v.id))) };
}
/** 有破洞就補、方向修成一致朝外；回傳修過的網格與做了什麼（修不了的照實講）*/
function fixMesh(m) {
  const st = { holes: 0, turned: 0, flippedSolids: 0, failed: '' };
  const e0 = edgeCheck(fromMesh(m).faces);
  if (e0.nonManifold) { st.failed = '有三面共用的邊'; return { mesh: m, st }; }
  if (e0.open) {
    const f = fillHoles(m);
    if (f.ok) { m = f.mesh; st.holes = f.holes; } else st.failed = f.reason;
  }
  const n = recalcNormalsOutside(m);
  if (n.ok) { m = n.mesh; st.turned = n.fixedInconsistent; st.flippedSolids = n.flippedComponents; }
  return { mesh: m, st };
}
/** 每個部分（`partOf`）各自的面 */
function byPart(r) {
  const g = new Map();
  r.faces.forEach((f, i) => { const p = r.partOf[i]; if (!g.has(p)) g.set(p, []); g.get(p).push(f); });
  return g;
}
/** 收集好幾組 {points, faces, part 或 parts（每個面各自的部分）} → 跟 `cleanModel()` 一樣的形狀 */
function assemble(r, groups) {
  const points = [], faces = [], partOf = [];
  for (const g of groups) {
    const base = points.length;
    for (const p of g.points) points.push(p);         // ⛔ push(...很大的陣列)：汽車 50 萬點會堆疊溢位
    g.faces.forEach((f, k) => { faces.push(f.map(i => i + base)); partOf.push(g.parts ? g.parts[k] : g.part); });
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  return { ...r, points, faces, partOf, size: hi.map((h, k) => h - lo[k]), lo, hi };
}

/**
 * 補洞＋修方向：照**連在一起的那一塊**做（⛔ 照部分 —— iPhone 的側壁 Extrude 跟它的蓋子 Cap:1、Cap:2 是不同名字的部分，
 * 合起來本來就封閉；照部分補會在側壁上多補一層蓋子，跟原本的蓋子疊在一起）。
 * 每個面的部分照舊（補洞、修方向都不搬點 ⇒ 照「同一組點的位置」對回去）；補出來的面歸給那一塊裡面最多的部分。
 */
export function fillVariant(r) {
  const info = { holes: 0, turned: 0, flippedSolids: 0, failed: [] };
  const groups = [];
  const key = (P, f) => f.map(i => P[i].join(',')).sort().join(';');
  for (const c of components(r.faces, r.points.length)) {
    const fs = c.map(i => r.faces[i]), ps = c.map(i => r.partOf[i]);
    const e = edgeCheck(fs);
    if (!e.open && !e.flipped) { groups.push({ ...localGroup(r.points, fs, 0), parts: ps }); continue; }
    const { mesh, st } = fixMesh(toMesh(r.points, fs));
    info.holes += st.holes; info.turned += st.turned; info.flippedSolids += st.flippedSolids;
    if (st.failed) info.failed.push(`${r.parts[mode(ps)] || '模型'}：${st.failed}`);
    const was = new Map(fs.map((f, k) => [key(r.points, f), ps[k]]));
    const g = fromMesh(mesh), main = mode(ps);
    groups.push({ ...g, parts: g.faces.map(f => { const p = was.get(key(g.points, f)); return p === undefined ? main : p; }) });
  }
  return { read: assemble(r, groups), info };
}
/** 最多的那一個 */
function mode(a) {
  const n = new Map(); let best = a[0], bn = 0;
  for (const x of a) { const k = (n.get(x) || 0) + 1; n.set(x, k); if (k > bn) { bn = k; best = x; } }
  return best;
}
function localGroup(points, fs, part) {
  const used = new Map(), P = [];
  const F = fs.map(f => f.map(i => { if (!used.has(i)) { used.set(i, P.length); P.push(points[i]); } return used.get(i); }));
  return { points: P, faces: F, part };
}

/**
 * 聯集成一個實體：每一塊（共用點連在一起的）先補洞修方向，封閉的全部聯集成一個部分；
 * 收不了的（有隔板、補不起來）照原樣另外放、照原本的部分。
 * @returns {{read, info:{united, kept, holes, turned, sumVolume, volume, overlap, pieces, dropped, why}}|{read:null, info:{why}}}
 */
export function unionVariant(r) {
  if (!csgReady()) return { read: null, info: { why: '布林運算函式庫還沒載入' } };
  const info = { united: 0, kept: 0, holes: 0, turned: 0, sumVolume: 0, volume: 0, overlap: 0, pieces: 0, dropped: 0, why: '' };
  const solids = [], rest = [];
  for (const c of components(r.faces, r.points.length)) {
    const fs = c.map(i => r.faces[i]);
    const { mesh, st } = fixMesh(toMesh(r.points, fs));
    if (!st.failed && mesh.isClosed()) { solids.push(mesh); info.holes += st.holes; info.turned += st.turned; continue; }
    rest.push(c);
  }
  if (solids.length < 2) return { read: null, info: { why: solids.length ? '只有一塊是實體，沒有東西可以聯集' : '沒有一塊是封閉的實體' } };
  let u;
  try { u = unionSolids(solids); } catch (e) { return { read: null, info: { why: '聯集失敗：' + (e.message || e) } }; }
  info.united = solids.length; info.kept = rest.length;
  info.sumVolume = u.sumVolume; info.volume = u.volume; info.pieces = u.pieces; info.dropped = u.dropped;
  info.overlap = u.sumVolume > 0 ? 1 - u.volume / u.sumVolume : 0;
  const parts = [...r.parts];
  const unitedPart = parts.length;
  parts.push(null);                                   // 聯集出來的那一個 ⇒ 名字用檔名（`_name()` 遇到 null 用檔名）
  const groups = [{ ...fromMesh(u.mesh), part: unitedPart }];
  for (const c of rest) for (const [part, fs] of byPart({ faces: c.map(i => r.faces[i]), partOf: c.map(i => r.partOf[i]) })) groups.push(localGroup(r.points, fs, part));
  return { read: assemble({ ...r, parts }, groups), info };
}

/**
 * 建議哪一個（照 `匯入整理-研究.md` 第 9 節 ③、第 10 節）：
 *   零件之間有穿插（聯集算得出來、體積少了 `OVERLAP_MIN` 以上）⇒ 聯集；
 *   有破洞或翻面 ⇒ 補洞＋修方向；其他 ⇒ 原樣（只有隔板的也是 —— 隔板是 ③b）
 * @returns {{mode:string, why:string}}
 */
export function suggestSolid(check, union) {
  if (union && union.read && union.info.overlap > OVERLAP_MIN) {
    return { mode: 'union', why: `零件之間有穿插（重疊的體積佔各塊加總的 ${pct(union.info.overlap)}）` };
  }
  if (check.holes) return { mode: 'fill', why: `有 ${check.holes} 塊有破洞或面翻過來 —— 補的只是洞口，其他表面不動` };
  if (check.partition) return { mode: 'raw', why: `有 ${check.partition} 塊裡面有隔板（三面以上共用的邊）—— 下一小批處理，現在先照原樣` };
  return { mode: 'raw', why: check.comps > 1 ? '每一塊都封閉、沒有穿插' : '封閉、乾淨' };
}
const pct = x => (Math.round(x * 1000) / 10) + '%';
