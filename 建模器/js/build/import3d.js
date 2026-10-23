/**
 * import3d.js — 匯入 3D 模型（STL／OBJ／GLB）當骨架（2026-10-21，kang 定的定位 → `規格\建模器-匯入3D模型.md`）
 *
 * 只讀「點 ＋ 面」—— ⛔ 執行檔案裡的任何東西；顏色、貼圖、材質、動畫一律不讀（骨架只要形狀）。
 * 讀完照同一條路：清理（`cleanModel()`）→ 檢查（`edgeCheck()`）→ 換成公分、Y 朝上、分成幾個部分（`toParts()`）。
 * 畫面在 `ui/import3dPanel.js`。
 *
 * 讀出來的格式（三種一樣）：
 *   { format, points: [[x,y,z]…], faces: [[i,j,k…]…], partOf: [面 → 第幾個部分], parts: [名字…], notes: [字串…] }
 */

/** 單位 → 公分 */
export const UNIT_CM = { mm: 0.1, cm: 1, m: 100, in: 2.54 };
export const UNIT_LABEL = { mm: 'mm（公釐）', cm: 'cm（公分）', m: 'm（公尺）', in: 'in（英吋）' };

/** 看副檔名認格式；認不得 ⇒ null */
export function formatOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : '';
  return ['stl', 'obj', 'glb', 'gltf'].includes(ext) ? ext : null;
}

/**
 * 讀一個檔。`buf` ＝ ArrayBuffer。
 * @returns {{ok:boolean, reason?:string, format, points, faces, partOf, parts, notes}}
 */
export function readModel(name, buf) {
  const fmt = formatOf(name);
  try {
    if (fmt === 'stl') return { ok: true, ...readSTL(buf) };
    if (fmt === 'obj') return { ok: true, ...readOBJ(new TextDecoder().decode(new Uint8Array(buf))) };
    if (fmt === 'glb') return { ok: true, ...readGLB(buf) };
    if (fmt === 'gltf') return { ok: false, reason: '.gltf 會拆成好幾個檔（.gltf ＋ .bin ＋ 圖片），網頁一次只拿得到一個 —— 請改拿同一個模型的 .glb' };
    return { ok: false, reason: '認不得這個格式 —— 目前讀得了 .stl、.obj、.glb' };
  } catch (e) {
    return { ok: false, reason: `讀不了這個檔：${e.message || e}` };
  }
}

/** STL：二進位（檔案大小剛好 ＝ 84 ＋ 三角形數 × 50）或文字。⚠ STL 沒有寫單位 */
export function readSTL(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  const n = u8.length >= 84 ? dv.getUint32(80, true) : -1;
  const points = [], faces = [];
  let note;
  if (n >= 0 && u8.length === 84 + n * 50) {
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12;                       // 跳過法向量
      const f = [];
      for (let k = 0; k < 3; k++) {
        points.push([dv.getFloat32(o + k * 12, true), dv.getFloat32(o + k * 12 + 4, true), dv.getFloat32(o + k * 12 + 8, true)]);
        f.push(points.length - 1);
      }
      faces.push(f);
    }
    note = `二進位 STL，${n} 個三角形`;
  } else {
    const txt = new TextDecoder().decode(u8);
    const re = /vertex\s+([-+\d.eE]+)\s+([-+\d.eE]+)\s+([-+\d.eE]+)/g;
    let m, cur = [];
    while ((m = re.exec(txt))) {
      points.push([+m[1], +m[2], +m[3]]);
      cur.push(points.length - 1);
      if (cur.length === 3) { faces.push(cur); cur = []; }
    }
    if (!faces.length) throw new Error('找不到任何三角形（不像 STL）');
    note = `文字 STL，${faces.length} 個三角形`;
  }
  // 部分沒有名字 ⇒ 物件名稱就用檔名（⛔ 叫「fox－STL」）
  return { format: 'stl', points, faces, partOf: faces.map(() => 0), parts: [''], notes: [note, 'STL 檔裡沒有寫單位'] };
}

/** OBJ：`v`、`f`（多邊形、負的索引、`v/vt/vn`）、`o`／`g` 分部分；其他（`vt`、`vn`、材質、點上的顏色）不讀 */
export function readOBJ(text) {
  const points = [], faces = [], partOf = [], parts = [];
  let part = -1, colors = 0;
  const partNamed = name => {
    let i = parts.indexOf(name);
    if (i < 0) { parts.push(name); i = parts.length - 1; }
    return i;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.split(/\s+/);
    const tag = sp[0];
    if (tag === 'v') {
      points.push([+sp[1], +sp[2], +sp[3]]);
      if (sp.length >= 7) colors++;
    } else if (tag === 'f') {
      const idx = sp.slice(1).map(s => { const i = parseInt(s.split('/')[0], 10); return i < 0 ? points.length + i : i - 1; });
      if (idx.length < 3 || idx.some(i => !(i >= 0 && i < points.length))) continue;
      if (part < 0) part = partNamed('物件');
      faces.push(idx);
      partOf.push(part);
    } else if (tag === 'o' || tag === 'g') {
      part = partNamed(sp.slice(1).join(' ') || '物件');      // 同名的併成同一個部分
    }
  }
  if (!faces.length) throw new Error('找不到任何面（不像 OBJ）');
  const notes = [`OBJ，${points.length} 個點、${faces.length} 個面`, 'OBJ 檔裡沒有寫單位'];
  if (colors) notes.push('點上帶顏色、旁邊可能有 .mtl 材質檔 —— 只讀形狀，顏色不讀');
  return { format: 'obj', points, faces, partOf, parts, notes };
}

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** GLB（glTF 2.0 二進位）：節點的位移、旋轉、縮放一路乘下來；只讀三角形 */
export function readGLB(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error('不是 GLB（檔頭不對）');
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    const chunk = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (type === 0x004E4942) bin = chunk;
    off += 8 + len;
  }
  if (!json) throw new Error('GLB 裡沒有描述資料');
  const notes = [];
  const acc = i => {
    const a = json.accessors[i], bv = json.bufferViews[a.bufferView];
    const C = COMP[a.componentType], nc = NCOMP[a.type];
    if (!C || !nc || !bin) throw new Error('GLB 裡的資料格式讀不懂');
    const stride = bv.byteStride || 0;
    const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const out = [];
    if (!stride || stride === nc * C.BYTES_PER_ELEMENT) {
      const arr = new C(bin, base, a.count * nc);
      for (let k = 0; k < a.count; k++) out.push(nc === 1 ? arr[k] : Array.from(arr.subarray(k * nc, k * nc + nc)));
    } else {
      for (let k = 0; k < a.count; k++) { const arr = new C(bin, base + k * stride, nc); out.push(nc === 1 ? arr[0] : Array.from(arr)); }
    }
    return out;
  };
  const mul = (A, B) => {
    const R = new Array(16).fill(0);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) R[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k];
    return R;
  };
  const trs = n => {
    if (n.matrix) return n.matrix;
    const [tx, ty, tz] = n.translation || [0, 0, 0], [qx, qy, qz, qw] = n.rotation || [0, 0, 0, 1], [sx, sy, sz] = n.scale || [1, 1, 1];
    const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
    return [(1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
      2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
      2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0, tx, ty, tz, 1];
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const points = [], faces = [], partOf = [], parts = [];
  let skipped = 0;
  const visit = (ni, M) => {
    const n = json.nodes[ni], W = mul(M, trs(n));
    if (n.mesh !== undefined) {
      const mesh = json.meshes[n.mesh];
      const part = parts.length;
      parts.push(n.name || mesh.name || `物件 ${part + 1}`);
      for (const pr of mesh.primitives) {
        if ((pr.mode ?? 4) !== 4) { skipped++; continue; }
        const P = acc(pr.attributes.POSITION), base = points.length;
        for (const [x, y, z] of P) points.push([W[0] * x + W[4] * y + W[8] * z + W[12], W[1] * x + W[5] * y + W[9] * z + W[13], W[2] * x + W[6] * y + W[10] * z + W[14]]);
        const ix = pr.indices !== undefined ? acc(pr.indices) : P.map((_, k) => k);
        for (let k = 0; k + 2 < ix.length; k += 3) { faces.push([base + ix[k], base + ix[k + 1], base + ix[k + 2]]); partOf.push(part); }
      }
    }
    for (const c of n.children || []) visit(c, W);
  };
  const scene = (json.scenes || [])[json.scene || 0];
  for (const ni of (scene ? scene.nodes : (json.nodes || []).map((_, i) => i))) visit(ni, I);
  if (!faces.length) throw new Error('GLB 裡找不到任何三角形');
  notes.push(`GLB（glTF ${(json.asset && json.asset.version) || '2.0'}），${faces.length} 個三角形`);
  if (skipped) notes.push(`有 ${skipped} 段不是三角形（線、點），跳過`);
  return { format: 'glb', points, faces, partOf, parts, notes };
}

/**
 * 🔴 **清理**：位置一樣的點合成一個（STL、GLB 每個三角形自己帶點）、同一組點的面只留一個
 * （不管繞的方向 —— Kenney 的 OBJ 每個面寫了兩次）、少於 3 個不同點的面丟掉。
 *
 * 🔴 **只合「位置完全一樣」的點**（網格核心第五批 b ①，kang 2026-10-23「第 ① 小批照你的修法：焉點只合位置完全一樣的點…」→
 * `網格核心-研究.md` 10.5）。以前用容許值（整個模型的對角線 × 10⁻⁶）把「很近」的也合起來 ——
 * 22 個樣本比過：只合完全一樣的⛔ 有一個變差；工地帽少焊掉 50 個好面、LLT 三面共用的邊 7,076 → 2,317；
 * STL、GLB 同一個點寫出來的座標本來就一模一樣，照樣連得起來。
 * ⚠ 已經整理好（Manifold 出來）的資料⛔ 再送進這一支：Manifold 在零件碰到的地方刻意讓位置一樣的點分開，
 * 焊了就壞（整理好的汽車：只合完全一樣的也還有 654 條三面共用）—— 那條路是匯入整理「整理成實體」的事。
 * @returns 跟讀出來的一樣，多 `stats: {merged, dup, degen}`、`size`（檔案單位的長寬高）
 */
export function cleanModel(r) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of r.points) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  const key = new Map(), points = [], remap = [];
  r.points.forEach((p, i) => {
    const k = p.join(',');
    if (!key.has(k)) { key.set(k, points.length); points.push(p); }
    remap[i] = key.get(k);
  });
  let degen = 0, dup = 0;
  const faces = [], partOf = [], seen = new Set();
  r.faces.forEach((f, fi) => {
    const g = f.map(i => remap[i]).filter((v, k, a) => v !== a[(k + a.length - 1) % a.length]);
    if (new Set(g).size < 3) { degen++; return; }
    const sk = [...g].sort((x, y) => x - y).join(',');
    if (seen.has(sk)) { dup++; return; }
    seen.add(sk);
    faces.push(g);
    partOf.push(r.partOf[fi]);
  });
  return { ...r, points, faces, partOf, size: hi.map((h, k) => h - lo[k]), lo, hi, stats: { merged: r.points.length - points.length, dup, degen } };
}

/** 邊的檢查：破洞（只有一個面用的邊）、接不起來（三個面以上共用）、方向不一致（兩個面繞同一個方向）*/
export function edgeCheck(faces) {
  const cnt = new Map();
  for (const f of faces) for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + 1) % f.length];
    const key = a < b ? a + '-' + b : b + '-' + a;
    const e = cnt.get(key) || { n: 0, dir: 0 };
    e.n++; e.dir += a < b ? 1 : -1;
    cnt.set(key, e);
  }
  let open = 0, nonManifold = 0, flipped = 0;
  for (const e of cnt.values()) {
    if (e.n === 1) open++;
    else if (e.n > 2) nonManifold++;
    else if (e.dir !== 0) flipped++;
  }
  return { edges: cnt.size, open, nonManifold, flipped };
}

/** 單位先猜：STL ⇒ mm、GLB ⇒ m（glTF 規格的單位是公尺）、OBJ ⇒ 照大小猜（最長邊 < 10 ⇒ m，否則 mm）*/
export function guessUnit(format, size) {
  if (format === 'stl') return 'mm';
  if (format === 'glb') return 'm';
  return Math.max(...size) < 10 ? 'm' : 'mm';
}
/** 朝上先猜：STL ⇒ Z（3D 列印檔常常這樣）、OBJ／GLB ⇒ Y */
export const guessUp = format => (format === 'stl' ? 'z' : 'y');

/**
 * 換成公分、Y 朝上（Z 朝上 ⇒ (x, y, z) → (x, z, −y)，右手不翻面），分成幾個部分。
 * @param {object} c `cleanModel()` 的結果
 * @param {{cmPerUnit:number, up:'y'|'z', split:boolean}} opt
 * @returns {{name:string, points:number[][], faces:number[][]}[]} 每個部分自己的點（重新編號）
 */
export function toParts(c, opt) {
  const s = opt.cmPerUnit;
  const conv = opt.up === 'z' ? p => [p[0] * s, p[2] * s, -p[1] * s] : p => [p[0] * s, p[1] * s, p[2] * s];
  const groups = new Map();
  c.faces.forEach((f, i) => {
    const g = opt.split ? c.partOf[i] : 0;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(f);
  });
  const out = [];
  for (const [g, fs] of groups) {
    const used = new Map(), pts = [];
    const faces = fs.map(f => f.map(i => { if (!used.has(i)) { used.set(i, pts.length); pts.push(conv(c.points[i])); } return used.get(i); }));
    out.push({ name: opt.split ? c.parts[g] : null, points: pts, faces });
  }
  return out;
}

/**
 * 🔴 **極小碎面的門檻預設 ＝ 整個模型最長的那一邊 ÷ 500**（2026-10-21，kang「同意你的建議」；
 * 比較在 `規格\建模器-匯入3D模型.md`「② 沙箱比較」）。
 * ⛔ 寫死幾 mm：模型放大，碎面跟著變大就清不到（狐狸放大成 30 cm，固定 0.2 mm 清不到）；
 * 照大小走，狐狸 3～100 cm 每次都清掉同樣那 8 個面。÷ 1000 太小（狐狸清不到）；
 * kang 的 6 個棋子最短的邊在 ÷ 112 以上，÷ 500 都不動。
 */
export const MICRO_DIV = 500;

/**
 * 🔴 **極小碎面合併掉**（第二步，kang 選甲：匯入時清、預設開、可以關）—— 跟 Blender 的
 * 「Degenerate Dissolve」同一個做法：比門檻短的邊，兩端合到中點，小的面跟著不見。
 * 從最短的開始；**縮了會壞就不縮那一條**：碰到的面翻過去、多出同一組點的面、
 * 只接一個面或三個面以上的邊變多。（⛔ 改展開那邊的重疊判斷：疊到的是真的面，只是很小。）
 * 只看碰到的那幾個面（一條邊縮掉，會變的只有接著兩端的面）。
 * @param {{points:number[][], faces:number[][]}} p 一個部分（`toParts()` 的一個，cm）
 * @param {number} tol 比這個短的邊縮掉（cm）
 * @returns {{points, faces, stats:{collapsed, kept, removed, maxMove}}}（`kept` ＝ 會壞所以沒縮的邊；`maxMove` cm）
 */
export function collapseShort(p, tol) {
  const P = p.points.map(q => q.slice());
  const faces = p.faces.map(f => f.slice());     // 縮掉的面變 null
  const alive = faces.map(() => true);
  const vf = P.map(() => new Set());               // 點 → 用到它的面
  faces.forEach((f, i) => f.forEach(v => vf[v].add(i)));
  const ek = (a, b) => (a < b ? a + '-' + b : b + '-' + a);
  const cnt = new Map();                           // 邊 → 幾個面用它
  const addF = (f, d) => { for (let k = 0; k < f.length; k++) { const key = ek(f[k], f[(k + 1) % f.length]); cnt.set(key, (cnt.get(key) || 0) + d); } };
  faces.forEach(f => addF(f, 1));
  const dist = (a, b) => Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1], P[a][2] - P[b][2]);
  const rep = P.map((_, i) => i);
  const find = i => { while (rep[i] !== i) i = rep[i] = rep[rep[i]]; return i; };
  // 候選：比門檻短的邊，照長度排（縮了以後，接著 a 的邊照新的長度再排進來）。
  // 拿出來時重算長度：變長了就照新的長度放回去 ⇒ 每次拿到的都是現在真的最短的那一條
  // （只有接著 a 的邊會變短，那些都重新排過）。⛔ 每一步把所有候選掃一遍（16 萬面 6.6 秒）。
  const heap = new MinHeap(), bad = new Set();
  const addCand = f => { for (let k = 0; k < f.length; k++) { const a = f[k], b = f[(k + 1) % f.length], l = dist(a, b); if (l < tol) heap.push(l, a < b ? a : b, a < b ? b : a); } };
  faces.forEach(addCand);
  let collapsed = 0, removed = 0;
  for (;;) {
    let best = null;
    while (heap.size) {
      const [l0, a, b] = heap.pop(), key = ek(a, b);
      if (bad.has(key) || find(a) !== a || find(b) !== b || !cnt.get(key)) continue;
      const l = dist(a, b);
      if (l >= tol) continue;
      if (l > l0) { heap.push(l, a, b); continue; }
      best = [a, b, key]; break;
    }
    if (!best) break;
    const [a, b, key] = best;
    const F = [...new Set([...vf[a], ...vf[b]])];
    const n0 = F.map(i => normal(P, faces[i]));
    const keepA = P[a];
    P[a] = keepA.map((v, k) => (v + P[b][k]) / 2);
    const nf = F.map(i => tidy(faces[i].map(v => (v === b ? a : v))));
    let ok = true;
    // 1. 留下來的面不能翻過去
    for (let t = 0; t < F.length && ok; t++) {
      if (nf[t].length < 3) continue;
      const n = normal(P, nf[t]);
      if (len(n) > 0 && len(n0[t]) > 0 && dot(n, n0[t]) <= 0) ok = false;
    }
    // 2. 不能多出同一組點的面（會一樣的一定都接著 a ⇒ 只看 F）
    if (ok) {
      const seen = new Set();
      for (const f of nf) { if (f.length < 3) continue; const s = [...f].sort((x, y) => x - y).join(','); if (seen.has(s)) { ok = false; break; } seen.add(s); }
    }
    // 3. 只接一個面、三個面以上的邊不能變多（只看這幾個面的邊）
    if (ok) {
      const d = new Map();
      const tally = (f, s) => { for (let k = 0; k < f.length; k++) { const key2 = ek(f[k], f[(k + 1) % f.length]); d.set(key2, (d.get(key2) || 0) + s); } };
      F.forEach(i => tally(faces[i], -1));
      nf.forEach(f => { if (f.length >= 3) tally(f, 1); });
      let open = 0, nm = 0;
      for (const [key2, dd] of d) {
        if (!dd) continue;
        const was = cnt.get(key2) || 0, now = was + dd;
        open += (now === 1) - (was === 1);
        nm += (now > 2) - (was > 2);
      }
      if (open > 0 || nm > 0) ok = false;
    }
    if (!ok) { P[a] = keepA; bad.add(key); continue; }
    // 縮：b 合到 a
    F.forEach((i, t) => {
      addF(faces[i], -1);
      for (const v of faces[i]) vf[v].delete(i);
      if (nf[t].length < 3) { alive[i] = false; faces[i] = null; removed++; return; }
      faces[i] = nf[t];
      addF(faces[i], 1);
      for (const v of faces[i]) vf[v].add(i);
    });
    rep[b] = a;
    collapsed++;
    for (const i of vf[a]) addCand(faces[i]);
  }
  let maxMove = 0;
  p.points.forEach((q, i) => { const r = P[find(i)]; maxMove = Math.max(maxMove, Math.hypot(r[0] - q[0], r[1] - q[1], r[2] - q[2])); });
  const live = faces.filter((f, i) => alive[i]);
  const used = new Map(), pts = [];
  const out = live.map(f => f.map(v => { if (!used.has(v)) { used.set(v, pts.length); pts.push(P[v]); } return used.get(v); }));
  return { ...p, points: pts, faces: out, stats: { collapsed, kept: bad.size, removed, maxMove } };
}

/** 最小的先出來（長度一樣 ⇒ 點的編號小的先，結果才不會因為放進去的順序而變）*/
class MinHeap {
  constructor() { this.h = []; }
  get size() { return this.h.length; }
  less(x, y) { return x[0] < y[0] || (x[0] === y[0] && (x[1] < y[1] || (x[1] === y[1] && x[2] < y[2]))); }
  push(l, a, b) {
    const h = this.h; h.push([l, a, b]);
    let i = h.length - 1;
    while (i > 0) { const j = (i - 1) >> 1; if (!this.less(h[i], h[j])) break; [h[i], h[j]] = [h[j], h[i]]; i = j; }
  }
  pop() {
    const h = this.h, top = h[0], last = h.pop();
    if (h.length) {
      h[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < h.length && this.less(h[l], h[m])) m = l;
        if (r < h.length && this.less(h[r], h[m])) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m], h[i]]; i = m;
      }
    }
    return top;
  }
}

const sub3 = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
const len = u => Math.hypot(u[0], u[1], u[2]);
/** 多邊形的法向（扇形加起來；長度 ＝ 面積 × 2）*/
function normal(P, f) {
  let x = 0, y = 0, z = 0;
  for (let i = 1; i < f.length - 1; i++) {
    const u = sub3(P[f[i]], P[f[0]]), v = sub3(P[f[i + 1]], P[f[0]]);
    x += u[1] * v[2] - u[2] * v[1]; y += u[2] * v[0] - u[0] * v[2]; z += u[0] * v[1] - u[1] * v[0];
  }
  return [x, y, z];
}
/** 連續重複的點拿掉（縮了一條邊以後，面上會有兩個一樣的點）*/
function tidy(f) {
  const g = [];
  for (const v of f) if (g[g.length - 1] !== v) g.push(v);
  while (g.length > 1 && g[0] === g[g.length - 1]) g.pop();
  return g;
}
