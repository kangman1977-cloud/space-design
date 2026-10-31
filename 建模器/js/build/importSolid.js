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
import { unionSolids, solidInfo, csgReady } from './bool.js';
import { edgeCheck } from './import3d.js';
import { windTree, windSure, sectionDiff } from './winding.js';

export const SOLID_MODES = { raw: '原樣', fill: '補洞＋修方向', union: '聯集成一個實體' };
/** 有隔板的一塊切出來超過這麼多片就不修（iPhone 機身 15,914 片：快速版也要 217 秒、修完還有破洞 —— `匯入整理-研究.md` 第 11 節）*/
export const MAX_PATCHES = 2000;
/** 修前修後剖面差（÷ 修前最大的那一刀）超過這個就不用修過的那份（kang 2026-10-24「只修剖面比得過的」）*/
export const SECTION_TOL = 0.01;
const PARTITION = '有三面共用的邊';
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
  const out = { comps: comps.length, clean: 0, holes: 0, partition: 0, openEdges: 0, flipEdges: 0, nmEdges: 0, cavities: cavities(r, comps).size };
  for (const c of comps) {
    const e = edgeCheck(c.map(i => r.faces[i]));
    out.openEdges += e.open; out.flipEdges += e.flipped; out.nmEdges += e.nonManifold;
    if (e.nonManifold) out.partition++;
    else if (e.open || e.flipped) out.holes++;
    else out.clean++;
  }
  return out;
}

/**
 * 空心（kang 2026-10-31 (k) → `三視圖導入-研究.md` 實驗 11 最後）：封閉、方向一致、**體積是負的**（朝裡）、而且包在另一塊（體積是正的）裡面的那一塊
 * ＝ 那一塊的空心，⛔ 翻成朝外。以前補洞＋修方向一塊一塊各自修，朝裡的內層被翻成朝外、當成另一塊實心 ⇒
 * 聯集把空心填成實心（中間空的方塊體積 488 → 1,000）。包在好幾塊裡面的歸給最小的那一塊。
 * @returns {Map<number, number>} 空心那一塊（`components()` 的順序）→ 包住它的那一塊
 */
export function cavities(r, comps = components(r.faces, r.points.length)) {
  const info = comps.map(c => {
    const fs = c.map(i => r.faces[i]), e = edgeCheck(fs);
    const closed = !e.open && !e.flipped && !e.nonManifold;
    return { fs, closed, vol: closed ? signedVolume(r.points, fs) : 0, W: null };
  });
  const out = new Map();
  info.forEach((a, i) => {
    if (!a.closed || !(a.vol < 0)) return;
    const q = r.points[a.fs[0][0]];
    let best = -1;
    info.forEach((b, j) => {
      if (j === i || !b.closed || !(b.vol > 0) || (best >= 0 && b.vol >= info[best].vol)) return;
      if (!b.W) { const T = []; for (const f of b.fs) for (let k = 1; k + 1 < f.length; k++) T.push([f[0], f[k], f[k + 1]]); b.W = windTree(r.points, T); }
      if (windSure(b.W, q) > 0.5) best = j;
    });
    if (best >= 0) out.set(i, best);
  });
  return out;
}
/** 帶正負號的體積（朝外 > 0）*/
function signedVolume(P, fs) {
  let v = 0;
  for (const f of fs) for (let k = 1; k + 1 < f.length; k++) {
    const a = P[f[0]], b = P[f[k]], c = P[f[k + 1]];
    v += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return v / 6;
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
  if (e0.nonManifold) { st.failed = PARTITION; return { mesh: m, st }; }
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
/** 收集好幾組 {points, faces, part 或 parts（每個面各自的部分）} → 跟 `cleanModel()` 一樣的形狀（`importShell.js` 也用）*/
export function assemble(r, groups) {
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
  const info = { united: 0, kept: 0, holes: 0, turned: 0, sumVolume: 0, volume: 0, overlap: 0, pieces: 0, dropped: 0, why: '',
    partFixed: 0, partWorst: 0, partSkip: { many: 0, open: 0, section: 0 }, partSkipWorst: 0, cavities: 0 };
  const comps = components(r.faces, r.points.length), cav = cavities(r, comps);
  const solids = [], rest = [], solidOf = new Map();
  comps.forEach((c, ci) => {
    if (cav.has(ci)) return;                         // 空心：⛔ 翻，下面併回包住它的那一塊
    const fs = c.map(i => r.faces[i]);
    const { mesh, st } = fixMesh(toMesh(r.points, fs));
    if (!st.failed && mesh.isClosed()) { solidOf.set(ci, solids.length); solids.push(mesh); info.holes += st.holes; info.turned += st.turned; return; }
    if (st.failed === PARTITION) {
      const fx = fixPartition(r.points, fs);
      if (fx.ok) { solidOf.set(ci, solids.length); solids.push(fx.mesh); info.partFixed++; info.partWorst = Math.max(info.partWorst, fx.diff); return; }
      info.partSkip[fx.why]++;
      if (fx.why === 'section') info.partSkipWorst = Math.max(info.partSkipWorst, fx.diff);
    }
    rest.push(c);
  });
  /** 空心併回包住它的那一塊（同一個網格兩層：外朝外、內朝裡 ⇒ Manifold 收成中間空的實體）；包住它的那塊沒收進來 ⇒ 空心也照原樣另外放 */
  for (const [ci, pj] of cav) {
    const k = solidOf.get(pj);
    if (k === undefined) { rest.push(comps[ci]); continue; }
    solids[k] = Mesh.merge([solids[k], toMesh(r.points, comps[ci].map(i => r.faces[i]))]);
    info.cavities++;
  }
  if (solids.length < 2 && !(solids.length === 1 && info.partFixed)) return { read: null, info: { why: solids.length ? '只有一塊是實體，沒有東西可以聯集' : '沒有一塊是封閉的實體' } };
  let u;
  try { u = unionSolids(solids); } catch (e) { return { read: null, info: { why: '聯集失敗：' + (e.message || e) } }; }
  info.united = solids.length; info.kept = rest.length;
  info.sumVolume = u.sumVolume; info.volume = u.volume; info.pieces = u.pieces; info.dropped = u.dropped;
  info.overlap = u.sumVolume > 0 ? 1 - u.volume / u.sumVolume : 0;
  const parts = [...r.parts];
  const unitedPart = parts.length;
  /**
   * 第三輪第三批 ②-13（kang 2026-10-26「⑤ 甲 名字加說明」）：聯集出來的、另外放的以前都叫檔名（T20 汽車兩個都叫「LLT_3D_Print_1k72」，
   * 畫面、AI.看() 都分不出來）⇒ 名字加說明（`（` 開頭 ⇒ `import3dPanel.js` `_name()` 接在檔名後面）。原本就有名字的部分照舊。
   */
  parts.push('（聯集）');
  const groups = [{ ...fromMesh(u.mesh), part: unitedPart }];
  let restPart = -1;
  for (const c of rest) for (const [part, fs] of byPart({ faces: c.map(i => r.faces[i]), partOf: c.map(i => r.partOf[i]) })) {
    let p = part;
    if (!parts[part]) { if (restPart < 0) { restPart = parts.length; parts.push(`（另外放的 ${rest.length} 塊）`); } p = restPart; }
    groups.push(localGroup(r.points, fs, p));
  }
  return { read: assemble({ ...r, parts }, groups), info };
}

/**
 * 修一塊有隔板的（三面以上共用的邊）—— 10-22 原型的做法，加上兩道關（kang 2026-10-24「只修剖面比得過的，其他照原樣另外放、講出來」）：
 *   1. 以三面共用的邊把面切成一片一片；每片取最大的 3 個三角形，往兩側各量一次環繞數（`winding.js`，快速、不確定才精確）：
 *      一側裡一側外 ＝ 外皮（留）；兩側都在裡面 ＝ 隔板（丟）；兩側都在外面 ＝ 多出來的鰭（丟）；反過來 ＝ 外皮但方向反了（翻回來留）
 *   2. 留下的 Manifold 要收得下（`solidInfo()`）
 *   3. 修前修後沿最長的那一軸切 20 刀比面積，差 ≤ `SECTION_TOL` 才用 —— 汽車有 5 塊會被判錯、丟掉真的料（剖面差 49～111%），靠這一關擋下來
 *   片太多（> `MAX_PATCHES`）的⛔ 修：iPhone 機身 15,914 片，快速版也要 217 秒、修完還有破洞
 * @returns {{ok:true, mesh, diff}|{ok:false, why:'many'|'open'|'section', diff?}}
 */
export function fixPartition(points, faces) {
  const used = new Map(), P = [], T = [];
  for (const f of faces) for (let k = 1; k + 1 < f.length; k++) T.push([f[0], f[k], f[k + 1]].map(v => { if (!used.has(v)) { used.set(v, P.length); P.push(points[v]); } return used.get(v); }));
  const ek = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
  const E = new Map();
  T.forEach((t, i) => { for (let k = 0; k < 3; k++) { const key = ek(t[k], t[(k + 1) % 3]); if (!E.has(key)) E.set(key, []); E.get(key).push(i); } });
  const par = new Int32Array(T.length).map((_, i) => i);
  const find = i => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
  for (const l of E.values()) if (l.length === 2) { const a = find(l[0]), b = find(l[1]); if (a !== b) par[a] = b; }
  const patches = new Map();
  T.forEach((_, i) => { const k = find(i); if (!patches.has(k)) patches.set(k, []); patches.get(k).push(i); });
  if (patches.size > MAX_PATCHES) return { ok: false, why: 'many' };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of P) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  const eps = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1e-4;
  const W = windTree(P, T), keep = [];
  for (const fl of patches.values()) {
    const big = fl.map(i => { const n = triNormal(P, T[i]); return { i, n, A: Math.hypot(n[0], n[1], n[2]) }; }).sort((x, y) => y.A - x.A).slice(0, 3);
    const votes = { skin: 0, wall: 0, fin: 0, flip: 0 };
    for (const { i, n, A } of big) {
      if (!(A > 0)) continue;
      const t = T[i], c = [0, 1, 2].map(k => (P[t[0]][k] + P[t[1]][k] + P[t[2]][k]) / 3);
      const out = windSure(W, c.map((x, k) => x + n[k] / A * eps)) > 0.5, inn = windSure(W, c.map((x, k) => x - n[k] / A * eps)) > 0.5;
      votes[inn && !out ? 'skin' : inn && out ? 'wall' : !inn && !out ? 'fin' : 'flip']++;
    }
    let v = 'skin', best = -1;
    for (const k of ['skin', 'wall', 'fin', 'flip']) if (votes[k] > best) { best = votes[k]; v = k; }
    if (v === 'skin') for (const i of fl) keep.push(T[i]);
    else if (v === 'flip') for (const i of fl) keep.push([T[i][0], T[i][2], T[i][1]]);
  }
  const mesh = toMesh(P, keep);
  if (!keep.length || !solidInfo(mesh).ok) return { ok: false, why: 'open' };
  const d = sectionDiff(P, T, P, keep).worst;
  if (d > SECTION_TOL) return { ok: false, why: 'section', diff: d };
  return { ok: true, mesh, diff: d };
}
function triNormal(P, t) {
  const a = P[t[0]], b = P[t[1]], c = P[t[2]];
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

/**
 * 建議哪一個（照 `匯入整理-研究.md` 第 9 節 ③、第 10 節）：
 *   零件之間有穿插（聯集算得出來、體積少了 `OVERLAP_MIN` 以上）⇒ 聯集；
 *   有破洞或翻面 ⇒ 補洞＋修方向；其他 ⇒ 原樣（只有隔板的也是 —— 隔板是 ③b）
 * @returns {{mode:string, why:string}}
 */
export function suggestSolid(check, union) {
  if (union && union.read && union.info.overlap > OVERLAP_MIN) {
    return { mode: 'union', why: `零件之間有穿插（重疊的體積佔各塊加總的 ${pct(union.info.overlap)}）` + (union.info.partFixed ? `；${union.info.partFixed} 塊的隔板修好了（修前修後剖面差 ≤ ${pct(SECTION_TOL)}）` : '') };
  }
  if (union && union.read && union.info.partFixed) {
    return { mode: 'union', why: `${union.info.partFixed} 塊的隔板修好了（修前修後剖面差 ≤ ${pct(SECTION_TOL)}）` };
  }
  if (check.holes) return { mode: 'fill', why: `有 ${check.holes} 塊有破洞或面翻過來 —— 補的只是洞口，其他表面不動` };
  if (check.partition) return { mode: 'raw', why: `有 ${check.partition} 塊裡面有隔板（三面以上共用的邊），修不好（看聯集那張卡寫的原因）—— 照原樣` };
  if (check.cavities) return { mode: 'raw', why: `有 ${check.cavities} 塊是包在裡面的空心（朝裡的內層），沒有穿插 —— 照原樣（中間是空的）` };
  return { mode: 'raw', why: check.comps > 1 ? '每一塊都封閉、沒有穿插' : '封閉、乾淨' };
}
const pct = x => (Math.round(x * 1000) / 10) + '%';
