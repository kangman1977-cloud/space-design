/**
 * subd.js — 平滑細分（Catmull-Clark；Blender Subdivision Surface、Rhino SubD、Fusion Form、3ds Max TurboSmooth 同一個原理）
 * 第二輪第八批 8a，2026-10-25 → `規格\建模器-平滑細分.md`；量表 `實驗-綜合評估-第二輪.md` 第八批；
 * kang 2026-10-25「第八批照你的建議：① 甲 疊一層 ② 預設 2 次可選 0～3 ③ a 照縮寫前後尺寸，b 當選項
 * ④ 甲 轉折 ≥30° 自動保持尖 ⑤ 量測列印剖面看平滑後、展開用粗網格 ⑥ 翻過來要檢查講在哪 ⑦ 只有網格物件；拆 8a→8b→8c」。
 *
 * 🔴 **這支只「算」：粗網格進來、平滑後的網格出去，粗網格一個點都不動**（疊一層 —— 物件身上留的是粗網格，
 * 平滑後的是 `io.js` `ModelObject.smoothMesh()` 每次照粗網格算出來的，⛔ 存檔）。
 *
 * 每磨一次：每個面長一個「面點」（面的中心）、每條邊長一個「邊點」、原本的點往周圍挪 ⇒ n 邊形變 n 個四邊形。
 * 🔴 **轉折 ≥ `CREASE_DEG`（30°）的邊保持尖**（④ 甲）：業界預設是全部磨圓、尖的要人一條一條標，
 * 但沙箱量過 kang 自己建的東西全部磨圓會壞掉（方塊每邊 −12%、體積 −65% 變成蛋；圓柱體積 −42%），
 * 自動保持尖之後方塊一模一樣、圓柱只圓側面、半球殼寬 −0.6%。尖邊照業界「無限尖」的規則：
 * 邊點在兩端正中間、兩條尖邊經過的點只沿著尖邊挪、三條以上的是角（不動）；破洞的邊、三個面以上共用的邊也當尖邊。
 *
 * ⚠ **凹的多邊形先拆三角形再磨**（⑥）：面的中心會落到面外面 ⇒ 小面翻過來（獅子頭布林留下的 12～15 邊形 21 → 2 個）。
 * ⚠ **翻過來的小面照實講**（⑥）：窄長條接大面那種（狐狸頭）規則救不完全 —— 磨完跟粗網格那一面比方向，反過來的記下來。
 *
 * 🔴 **8b（2026-10-25，kang「① 丙 勾平滑那一刻判一次、新長出來的邊照轉折 ④ 改角度自己標的不動、另一顆全部重新判斷」）**：
 * 保持尖不再每次照轉折重判（8a 那樣拉高一個點，那一圈會突然變尖）—— 判一次就記在邊上（`HalfEdge.crease`，`decideCreases()`），
 * 之後照記的；還沒判過的（新長出來的邊）第一次算的時候照轉折判、記下來。自己標的（3／4）蓋過照轉折判的。
 */
import * as THREE from 'three';
import { Mesh, CREASE } from '../core/mesh.js';
import { earClip } from '../core/triangulate.js';

/** 預設磨幾次（② kang 定：預設 2、可以選 0～3）*/
export const SUBD_DEFAULT = 2;
export const SUBD_MAX = 3;
/** 轉折這麼多以上的邊保持尖（④ 甲；可以調）*/
export const CREASE_DEG = 30;
/**
 * 磨完最多幾個面：超過就少磨一次（照實講）。⚠ 每磨一次 ×4 —— 匯入的 6 萬面磨 2 次就是 100 萬面，畫面會卡死。
 * 半球殼 544 面磨 3 次是 3.4 萬面（沙箱 43 毫秒）。
 */
export const SUBD_FACE_CAP = 300000;

/**
 * 粗網格 → 平滑後的網格。
 * @param {Mesh} mesh 粗網格（不會被改）
 * @param {{levels?:number, deg?:number}} opt
 * @returns {{mesh:Mesh, levels:number, wanted:number, capped:boolean, creases:number, split:number,
 *   flipped:number, flipOrigins:number, flipSegs:THREE.Vector3[]}}
 *   `levels` 真的磨了幾次（`capped` ⇒ 因為面太多少磨）；`creases` 保持尖的邊幾條；`split` 凹的面拆了幾個；
 *   `flipped` 翻過來的小面幾個、`flipOrigins` 出在粗網格幾個面上；`flipSegs` 翻過來那些小面的邊（每兩點一段，網格座標）
 */
export function subdivide(mesh, { levels = SUBD_DEFAULT, deg = CREASE_DEG } = {}) {
  const wanted = Math.max(0, Math.min(SUBD_MAX, Math.round(levels)));
  const base = toLists(mesh);
  const sp = splitConcave(base);
  let X = { P: sp.P, F: sp.F, C: creaseKeys(sp, deg, base.marks), O: sp.F.map((_, i) => i) };
  /** 8b ③：保持尖的邊（粗網格上、網格座標，每兩點一段）—— 拉點線面時畫紫色 */
  const creaseSegs = [];
  for (const key of X.C) {
    const a = Math.floor(key / BIG), b = key % BIG;
    if (a >= base.P.length || b >= base.P.length) continue;
    const p = base.P[a], q = base.P[b];
    creaseSegs.push(new THREE.Vector3(p[0], p[1], p[2]), new THREE.Vector3(q[0], q[1], q[2]));
  }
  const creases = X.C.size;

  let n = 0, faces = X.F.reduce((s, f) => s + f.length, 0);
  while (n < wanted && faces <= SUBD_FACE_CAP) { X = ccStep(X); n++; faces *= 4; }
  const capped = n < wanted;

  // ⑥ 翻過來的小面：磨完的每一面跟它出身的那一面（拆過凹面之後的）比方向
  const N0 = sp.F.map(f => newell(sp.P, f));
  const flipF = [], origins = new Set();
  if (n > 0) X.F.forEach((f, i) => {
    const a = newell(X.P, f), b = N0[X.O[i]];
    if (!a || !b) return;
    if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < 0) { flipF.push(f); origins.add(X.O[i]); }
  });

  const out = Mesh.fromFaceList(X.P.map(p => new THREE.Vector3(p[0], p[1], p[2])), X.F);
  /**
   * 🔴 **磨出來的邊標 `smooth`、保持尖的邊⛔ 標**：`smooth` 本來就是「這條邊是曲面切成小面產生的，不是造型上的折」
   * （`mesh.js` `HalfEdge.smooth`）⇒ 畫面只畫尖邊（不然整片曲面是密密的網）、匯出 OBJ 寫成平滑群組。
   */
  if (n > 0) {
    const vi = new Map(out.verts.map((v, i) => [v, i]));
    for (const he of out.halfEdges) he.smooth = !X.C.has(ekey(vi.get(he.v), vi.get(he.to)));
  }
  const flipSegs = [];
  for (const f of flipF) for (let k = 0; k < f.length; k++) {
    const p = X.P[f[k]], q = X.P[f[(k + 1) % f.length]];
    flipSegs.push(new THREE.Vector3(p[0], p[1], p[2]), new THREE.Vector3(q[0], q[1], q[2]));
  }
  return { mesh: out, levels: n, wanted, capped, creases, split: sp.split, flipped: flipF.length, flipOrigins: origins.size, flipSegs, creaseSegs };
}

/**
 * 粗網格的指紋：點數、面數、半邊數，加上每個點座標乘不同權重的加總 —— 拉一個點、加一個面都會變。
 * 8b 起連「保持尖／磨圓」的標記一起算（標一條邊就重算）。
 * `ModelObject.smoothMesh()` 拿它判斷快取還能不能用（粗網格是就地改的，網格本人沒換）。O(點數＋半邊數)。
 */
export function subdSig(mesh) {
  let s = 0;
  const vs = mesh.verts;
  for (let i = 0; i < vs.length; i++) {
    const p = vs[i].p, w = 1 + (i % 97) * 0.013;
    s += (p.x * 1.000003 + p.y * 1.7 + p.z * 2.3) * w;
  }
  let c = 0;
  const hs = mesh.halfEdges;
  for (let i = 0; i < hs.length; i++) if (hs[i].crease) c += hs[i].crease * (1 + (i % 89));
  return `${vs.length}|${mesh.faces.length}|${hs.length}|${s}|${c}`;
}

/**
 * 🔴 **判斷哪些邊保持尖、記在邊上**（8b ① 丙 ④）。
 * @param {Mesh} mesh 粗網格（⚠ 會改它的 `crease` 標記，形狀不動）
 * @param {number} deg 轉折幾度以上算尖
 * @param {'new'|'auto'|'all'} scope
 *   `new` 只判還沒判過的（勾平滑那一刻、新長出來的邊）；
 *   `auto` 照轉折判的那些也重判（改角度時；自己標的不動）；
 *   `all` 全部重判（「全部照轉折重新判斷」，自己標的也蓋掉）
 * @returns {number} 改了幾條邊
 * ⚠ 破洞的邊、三個面以上共用的邊⛔ 記（磨的時候本來就當尖邊）。
 */
export function decideCreases(mesh, deg = CREASE_DEG, scope = 'new') {
  const cosLim = Math.cos(deg * Math.PI / 180);
  let normalsReady = false, n = 0;
  for (const he of mesh.edges()) {
    const c = he.crease | 0;
    if (scope === 'new' && c) continue;
    if (scope === 'auto' && (c === CREASE.SHARP || c === CREASE.SMOOTH)) continue;
    if (!he.face || !he.twin || !he.twin.face) continue;
    if (!normalsReady) { mesh.computeNormals(); normalsReady = true; }
    const a = he.face.normal, b = he.twin.face.normal;
    const v = a.dot(b) <= cosLim + 1e-12 ? CREASE.AUTO_SHARP : CREASE.AUTO_SMOOTH;
    if (v !== c) { mesh.setCrease(he, v); n++; }
  }
  return n;
}

/** 8c：每次往回推幾倍、最多推幾次、準到多少（cm）—— 程式內部的，⛔ 給人調（沙箱：1 倍救不了狐狸頭、1.5 倍 14 次）*/
export const INTERP_OMEGA = 1.5;
export const INTERP_MAX_ITER = 30;
export const INTERP_TOL = 0.001;

/**
 * 🔴 **穿過原本的點（不縮）**（第二輪第八批 8c，kang 2026-10-25「① 甲 做成選項、預設不勾 ③ 推不準退回照縮並講、
 * 推得準寫最多差幾 mm」→ `規格\建模器-平滑細分.md`「8c」；業界：Rhino 轉換的 `UseMesh=Location`；做法：漸進迭代逼近 PIA，Chen 等 2008）。
 * 粗網格**複製一份**反覆往回推：磨完之後原本第 i 個點在哪（`ccStep()` 原本的點編號不變）⇒ 差多少就把複製那份的第 i 個點多推 ω 倍，
 * 直到每個原本的點都落在磨完的表面上（差 < `INTERP_TOL`）。⚠ 粗網格本人一個點都不動；尖邊照粗網格上記的（複製會帶標記）。
 * 推不準（布林的結果、翻過來的小面那種，沙箱獅子頭越推越歪）⇒ **退回照縮**、`interp.ok = false` 讓面板講。
 * @returns 跟 `subdivide()` 一樣，多一個 `interp: {ok, iters, err}`（`err` cm，原本的點離磨完的位置最遠多少）
 */
export function subdivideInterp(mesh, { levels = SUBD_DEFAULT, deg = CREASE_DEG } = {}) {
  const C = mesh.clone();
  const orig = mesh.verts.map(v => v.p);
  let r = null, err = Infinity, iters = 0;
  for (; iters < INTERP_MAX_ITER; ) {
    r = subdivide(C, { levels, deg });
    iters++;
    err = 0;
    const out = r.mesh.verts;
    for (let i = 0; i < orig.length; i++) {
      const o = orig[i], q = out[i].p;
      const dx = o.x - q.x, dy = o.y - q.y, dz = o.z - q.z;
      err = Math.max(err, Math.hypot(dx, dy, dz));
      const p = C.verts[i].p;
      p.x += dx * INTERP_OMEGA; p.y += dy * INTERP_OMEGA; p.z += dz * INTERP_OMEGA;
    }
    if (err < INTERP_TOL || r.levels === 0) break;
  }
  if (err < INTERP_TOL || (r && r.levels === 0)) return { ...r, interp: { ok: true, iters, err } };
  return { ...subdivide(mesh, { levels, deg }), interp: { ok: false, iters, err } };
}

/**
 * 自己標選到的邊（8b ②）：保持尖（`true`）或磨圓（`false`）。
 * @returns {number} 改了幾條（本來就是那樣的不算）
 */
export function markCreases(mesh, hes, sharp) {
  const v = sharp ? CREASE.SHARP : CREASE.SMOOTH;
  let n = 0;
  for (const he of hes) {
    if (!he || !he.face || !he.twin || !he.twin.face) continue;      // 破洞的邊本來就是尖的
    if ((he.crease | 0) !== v) { mesh.setCrease(he, v); n++; }
  }
  return n;
}

// ── 內部 ─────────────────────────────────────────────

/** 邊的鍵（兩個點的編號，小的在前）—— 用數字比字串快（4,000 萬個點以內不會撞）*/
const BIG = 67108864;
function ekey(a, b) { return a < b ? a * BIG + b : b * BIG + a; }

/** 半邊網格 → 純陣列（點照 `mesh.verts` 的順序，⛔ 重排 —— `fromFaceList()` 建回來編號一樣）*/
function toLists(mesh) {
  const vi = new Map(mesh.verts.map((v, i) => [v, i]));
  /** 8b：邊上記的保持尖／磨圓（邊的鍵 → `CREASE` 值；沒記的不放）*/
  const marks = new Map();
  for (const he of mesh.edges()) if (he.crease) marks.set(ekey(vi.get(he.v), vi.get(he.to)), he.crease);
  return {
    P: mesh.verts.map(v => [v.p.x, v.p.y, v.p.z]),
    F: mesh.faces.map(f => mesh.faceVerts(f).map(v => vi.get(v))),
    marks
  };
}

/** 面的法向（Newell，吃多邊形；面積 0 回 null）*/
function newell(P, f) {
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < f.length; k++) {
    const a = P[f[k]], b = P[f[(k + 1) % f.length]];
    x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const l = Math.hypot(x, y, z);
  return l > 1e-12 ? [x / l, y / l, z / l] : null;
}

/** 凹的多邊形拆成三角形（專案的 `earClip()`，投影到面自己的平面）；凸的照原樣 */
function splitConcave({ P, F }) {
  const out = [];
  let split = 0;
  for (const f of F) {
    const n = f.length > 3 ? newell(P, f) : null;
    if (!n || !isConcave(P, f, n)) { out.push(f); continue; }
    const ax = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = cross(n, ax), ul = Math.hypot(...u);
    u[0] /= ul; u[1] /= ul; u[2] /= ul;
    const w = cross(n, u);
    const pts = f.map(i => ({ x: dot(P[i], u), y: dot(P[i], w) }));
    const tris = earClip(f.map((_, k) => k), pts);
    if (tris.length !== f.length - 2) { out.push(f); continue; }   // 拆不乾淨就照原樣（翻過來的話下面會照實講）
    for (const t of tris) out.push(t.map(k => f[k]));
    split++;
  }
  return { P, F: out, split };
}
function isConcave(P, f, n) {
  for (let k = 0; k < f.length; k++) {
    const a = P[f[(k - 1 + f.length) % f.length]], b = P[f[k]], c = P[f[(k + 1) % f.length]];
    const x = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - b[0], c[1] - b[1], c[2] - b[2]]);
    if (dot(x, n) < -1e-9) return true;
  }
  return false;
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * 保持尖的邊：邊上記了的照記的（8b：1／3 尖、2／4 磨圓），沒記的照轉折 ≥ `deg`（兩個面的法向夾角）；
 * 破洞與三面共用的邊在 `ccStep()` 裡另外當尖
 */
function creaseKeys({ P, F }, deg, marks = new Map()) {
  const C = new Set();
  const N = F.map(f => newell(P, f));
  const E = new Map();
  F.forEach((f, fi) => f.forEach((a, k) => {
    const key = ekey(a, f[(k + 1) % f.length]);
    const l = E.get(key);
    if (l) l.push(fi); else E.set(key, [fi]);
  }));
  const cosLim = Math.cos(deg * Math.PI / 180);
  for (const [key, fs] of E) {
    if (fs.length !== 2) continue;
    const m = marks.get(key);
    if (m === CREASE.AUTO_SHARP || m === CREASE.SHARP) { C.add(key); continue; }
    if (m === CREASE.AUTO_SMOOTH || m === CREASE.SMOOTH) continue;
    const a = N[fs[0]], b = N[fs[1]];
    if (!a || !b) continue;
    if (dot(a, b) <= cosLim + 1e-12) C.add(key);
  }
  return C;
}

/** 磨一次。`O[i]` ＝ 第 i 個面出身於（拆過凹面之後的）粗網格第幾個面 */
function ccStep({ P, F, C, O }) {
  const nP = P.length;
  const fp = F.map(f => {
    let x = 0, y = 0, z = 0;
    for (const i of f) { x += P[i][0]; y += P[i][1]; z += P[i][2]; }
    return [x / f.length, y / f.length, z / f.length];
  });
  // 邊：兩端、旁邊的面
  const E = new Map();
  F.forEach((f, fi) => f.forEach((a, k) => {
    const b = f[(k + 1) % f.length], key = ekey(a, b);
    let e = E.get(key);
    if (!e) { e = { a, b, faces: [], idx: -1 }; E.set(key, e); }
    e.faces.push(fi);
  }));
  const sharp = (key, e) => e.faces.length !== 2 || C.has(key);
  const vf = Array.from({ length: nP }, () => []), ve = Array.from({ length: nP }, () => []);
  F.forEach((f, fi) => { for (const i of f) vf[i].push(fi); });
  for (const [key, e] of E) { e.sharp = sharp(key, e); ve[e.a].push(e); ve[e.b].push(e); }

  // 原本的點挪到哪
  const out = new Array(nP);
  for (let i = 0; i < nP; i++) {
    const p = P[i], es = ve[i];
    if (!es.length) { out[i] = p.slice(); continue; }
    const s = es.filter(e => e.sharp);
    if (s.length >= 3) { out[i] = p.slice(); continue; }                 // 角：不動
    if (s.length === 2) {                                                // 尖邊上：只沿著尖邊挪
      const q0 = P[s[0].a === i ? s[0].b : s[0].a], q1 = P[s[1].a === i ? s[1].b : s[1].a];
      out[i] = [0.75 * p[0] + 0.125 * (q0[0] + q1[0]), 0.75 * p[1] + 0.125 * (q0[1] + q1[1]), 0.75 * p[2] + 0.125 * (q0[2] + q1[2])];
      continue;
    }
    const n = vf[i].length;
    if (n < 3) { out[i] = p.slice(); continue; }
    let fx = 0, fy = 0, fz = 0;
    for (const fi of vf[i]) { fx += fp[fi][0]; fy += fp[fi][1]; fz += fp[fi][2]; }
    let rx = 0, ry = 0, rz = 0;
    for (const e of es) { rx += (P[e.a][0] + P[e.b][0]) / 2; ry += (P[e.a][1] + P[e.b][1]) / 2; rz += (P[e.a][2] + P[e.b][2]) / 2; }
    const k = vf[i].length, m = es.length;
    out[i] = [
      (fx / k + 2 * rx / m + (n - 3) * p[0]) / n,
      (fy / k + 2 * ry / m + (n - 3) * p[1]) / n,
      (fz / k + 2 * rz / m + (n - 3) * p[2]) / n
    ];
  }
  // 面點、邊點接在後面
  const fIdx = fp.map(p => { out.push(p); return out.length - 1; });
  const C2 = new Set();
  for (const [key, e] of E) {
    const a = P[e.a], b = P[e.b];
    let p;
    if (e.sharp) p = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    else {
      const c = fp[e.faces[0]], d = fp[e.faces[1]];
      p = [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4, (a[2] + b[2] + c[2] + d[2]) / 4];
    }
    e.idx = out.length;
    out.push(p);
    // 尖邊切成兩段，兩段都還是尖邊（破洞、三面共用的邊下一輪自己會再認出來）
    if (C.has(key)) { C2.add(ekey(e.a, e.idx)); C2.add(ekey(e.idx, e.b)); }
  }
  const F2 = [], O2 = [];
  F.forEach((f, fi) => {
    for (let k = 0; k < f.length; k++) {
      const a = f[k], b = f[(k + 1) % f.length], z = f[(k - 1 + f.length) % f.length];
      F2.push([a, E.get(ekey(a, b)).idx, fIdx[fi], E.get(ekey(z, a)).idx]);
      O2.push(O[fi]);
    }
  });
  return { P: out, F: F2, C: C2, O: O2 };
}
