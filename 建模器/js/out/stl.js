/**
 * stl.js — 匯出 STL 給 3D 列印與 CAM
 *
 * ── 為什麼是 STL ────────────────────────────────────
 * 所有切片軟體（Cura、PrusaSlicer、Bambu Studio）與 CAM 軟體都吃 STL。
 * 格式本身極簡：一堆三角形，每個帶一條法向量，沒有別的。
 * 沒有材質、沒有單位、沒有結構 —— 這既是它的缺點也是它通用的原因。
 *
 * ── 這個建模器匯 STL 有一個別人沒有的優勢 ──────────────
 * **3D 列印最常見的失敗原因是「模型不封閉」**（破面、法向朝內、
 * 面沒接起來），切片軟體遇到就印出空殼或直接失敗。
 *
 * 而這個建模器從第 1 期就是半邊結構、布林走 Manifold（保證封閉可接），
 * 第 1 期就在算尤拉數與角虧總和。所以匯出前可以**直接告訴使用者
 * 這個模型印不印得出來**，而不是丟出去讓切片軟體自己碰運氣。
 * 這正是 printCheck() 在做的事。
 *
 * ── 三個容易錯的轉換（都在這個檔案裡處理掉）──────────
 *
 * **1. 單位**：STL 沒有單位欄位，切片軟體一律當 mm。
 *    專案內部是 cm，所以預設 ×10。選 cm 輸出的話模型會小十倍 ——
 *    介面上必須警告，這裡也把單位寫進檔頭註解。
 *
 * **2. 上方向**：建模器沿用 three.js 的 **Y 軸向上**，
 *    但列印平台是 XY 平面、**Z 軸向上**。不轉的話模型會躺著進切片軟體。
 *    轉換：(x, y, z) → (x, −z, y)。行列式為 +1，右手座標系不變，
 *    所以三角形的繞向與法向朝外都自動保持正確。
 *
 * **3. 貼平台**：整批平移到最低點 Z=0，一放進去就站在平台上。
 *    多個物件合成一個檔時是整組一起落下，相對位置不變。
 *
 * 單位一律 cm 進、指定單位出。
 */

import * as THREE from 'three';

/** 輸出單位。STL 沒有單位欄位，這裡只是換算倍率。 */
export const STL_UNITS = {
  mm: { scale: 10, label: 'mm' },
  cm: { scale: 1,  label: 'cm' }
};

/** 一般桌上型 3D 列印機的成型範圍（mm），超過就提醒 */
export const DEFAULT_BUILD_MM = 250;

// ═══════════════════════════════════════════════════════
//  三角化
// ═══════════════════════════════════════════════════════

/**
 * 把網格攤成一串三角形，順便做完所有座標轉換。
 *
 * 法向量**重新算**而不是沿用面的法向：
 * 扇形三角化之後，凹多邊形的某些三角形方向可能跟整個面不同，
 * 沿用面法向會讓切片軟體判錯內外。逐三角形算最保險，
 * 而且 STL 的法向本來就是逐三角形的。
 *
 * @param {Mesh} mesh
 * @param {object} opt { matrix, scale, zUp, drop }
 * @returns {Array<{a,b,c,n}>} 每個都是 THREE.Vector3
 */
export function triangles(mesh, opt = {}) {
  const m4 = opt.matrix || null;
  const s = opt.scale ?? 1;
  const zUp = opt.zUp !== false;

  const out = [];
  const put = (p) => {
    const q = p.clone();
    if (m4) q.applyMatrix4(m4);
    // Y 軸向上 → Z 軸向上（列印平台是 XY 平面）
    const v = zUp ? new THREE.Vector3(q.x, -q.z, q.y) : q;
    return v.multiplyScalar(s);
  };

  for (const f of mesh.faces) {
    const vs = mesh.faceVerts(f);
    if (vs.length < 3) continue;
    const p0 = put(vs[0].p);
    for (let i = 2; i < vs.length; i++) {
      const a = p0, b = put(vs[i - 1].p), c = put(vs[i].p);
      const n = new THREE.Vector3()
        .subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const L = n.length();
      // 退化三角形（三點共線或重合）在這裡就丟掉，
      // 留著只會讓切片軟體報「非流形」
      if (L < 1e-12) continue;
      out.push({ a, b: b.clone(), c: c.clone(), n: n.divideScalar(L) });
    }
  }
  return out;
}

/**
 * 從三角形反算封閉體積（散度定理）。
 *
 * **這是整個模組最重要的驗證工具**：算出來的值必須等於
 * `mesh.volume() × 倍率³`。對不上就代表三角化錯了、法向反了、
 * 或單位換算錯了 —— 一次抓三種錯。
 * 負值代表法向朝內，那種模型切片軟體會印成反的。
 */
export function stlVolume(tris) {
  let v = 0;
  for (const t of tris) v += t.a.dot(new THREE.Vector3().crossVectors(t.b, t.c));
  return v / 6;
}

/** 整批三角形的外接框 */
export function trisBounds(tris) {
  const box = new THREE.Box3();
  for (const t of tris) { box.expandByPoint(t.a); box.expandByPoint(t.b); box.expandByPoint(t.c); }
  return box;
}

/** 整批往下平移，讓最低點貼在 Z=0 的列印平台上 */
export function dropToBed(tris) {
  if (!tris.length) return tris;
  const z = trisBounds(tris).min.z;
  if (Math.abs(z) < 1e-12) return tris;
  for (const t of tris) { t.a.z -= z; t.b.z -= z; t.c.z -= z; }
  return tris;
}

// ═══════════════════════════════════════════════════════
//  輸出
// ═══════════════════════════════════════════════════════

/**
 * 二進位 STL。這是實務上的預設格式 —— 同樣的模型比 ASCII 小約六倍。
 *
 * 結構：
 *   80 bytes   檔頭（純文字，內容自由。**絕對不能以 "solid" 開頭**，
 *              有些軟體會據此誤判成 ASCII 格式）
 *   uint32     三角形數
 *   每個三角形 50 bytes：12 個 float32（法向 + 三個頂點）+ uint16 屬性
 *
 * 檔頭拿來寫單位 —— STL 沒有單位欄位，寫在這裡至少人打開看得到。
 */
export function toSTLBinary(tris, opt = {}) {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  const head = ascii(opt.header || 'modeler').slice(0, 79);
  for (let i = 0; i < head.length; i++) u8[i] = head.charCodeAt(i);

  dv.setUint32(80, tris.length, true);

  let o = 84;
  for (const t of tris) {
    for (const v of [t.n, t.a, t.b, t.c]) {
      dv.setFloat32(o, v.x, true); o += 4;
      dv.setFloat32(o, v.y, true); o += 4;
      dv.setFloat32(o, v.z, true); o += 4;
    }
    dv.setUint16(o, 0, true); o += 2;
  }
  return u8;
}

/**
 * ASCII STL。檔案大很多，但打得開看得懂，出事時查得出來。
 * 座標用 6 位小數 —— 以 mm 計就是奈米級，遠比任何機台精細。
 */
export function toSTLAscii(tris, opt = {}) {
  const name = ascii(opt.name || 'modeler').replace(/\s+/g, '_') || 'modeler';
  const f = v => v.toFixed(6);
  const out = [`solid ${name}`];
  for (const t of tris) {
    out.push(`facet normal ${f(t.n.x)} ${f(t.n.y)} ${f(t.n.z)}`);
    out.push('  outer loop');
    for (const v of [t.a, t.b, t.c]) out.push(`    vertex ${f(v.x)} ${f(v.y)} ${f(v.z)}`);
    out.push('  endloop');
    out.push('endfacet');
  }
  out.push(`endsolid ${name}`);
  return out.join('\n') + '\n';
}

/** STL 的文字部分只保證 ASCII 讀得對，跟 DXF 同樣的理由 */
function ascii(s) {
  return String(s).replace(/[^\x20-\x7E]/g, '-').replace(/-+/g, '-');
}

// ═══════════════════════════════════════════════════════
//  列印前檢查
// ═══════════════════════════════════════════════════════

/**
 * 這個模型印不印得出來？
 *
 * ── 為什麼值得做 ────────────────────────────────────
 * 切片軟體遇到破面通常只會說「模型有問題」或乾脆默默印出空殼，
 * 等你發現已經浪費了幾小時。這裡在**匯出之前**就講清楚，
 * 而且講得出是哪裡的問題 —— 因為半邊結構本來就知道邊界在哪。
 *
 * 回傳的 issues 分三級：
 *   bad   一定印不出來或印錯，要先修
 *   warn  印得出來但要注意
 *   info  只是告知
 *
 * @param {Mesh} mesh   已經是最終要匯出的網格（板件請先 shell 過）
 * @param {Array} tris  triangles() 的產物（已含單位與座標轉換）
 * @param {object} opt  { buildMM, isSheet }
 */
export function printCheck(mesh, tris, opt = {}) {
  const issues = [];
  const v = mesh.validate();
  const vol = stlVolume(tris);
  const box = trisBounds(tris);
  const size = box.getSize(new THREE.Vector3());
  const build = opt.buildMM ?? DEFAULT_BUILD_MM;

  if (!tris.length) {
    issues.push({ level: 'bad', text: '沒有任何三角形，這個模型是空的' });
  }

  if (!v.closed) {
    issues.push({
      level: 'bad',
      text: `不是封閉的（有 ${v.boundaryHalfEdges} 條邊界邊）。`
          + '切片軟體會印出空殼或直接失敗 —— 板件請先給板厚，實體請檢查是不是破面'
    });
  }

  if (v.closed && vol <= 0) {
    issues.push({
      level: 'bad',
      text: '法向朝內（體積算出來是負的），印出來會內外相反'
    });
  }

  if (!v.ok) {
    issues.push({ level: 'bad', text: '網格結構有問題：' + v.errors[0] });
  }

  if (v.components > 1) {
    issues.push({
      level: 'warn',
      text: `由 ${v.components} 個互不相連的塊組成。`
          + '印得出來，但它們是分開的物件，不會黏在一起'
    });
  }

  const big = Math.max(size.x, size.y, size.z);
  if (big > build) {
    issues.push({
      level: 'warn',
      text: `最長邊 ${big.toFixed(1)}mm 超過常見成型範圍 ${build}mm，可能要分件或縮小`
    });
  }

  /**
   * 整個模型不到 1 公分，多半是單位選錯 ——
   * 用 cm 匯出、切片軟體卻當 mm 讀，模型就會變成十分之一大。
   * 這是 warn 不是 bad：真的很小的零件是存在的，程式沒資格替人決定。
   */
  if (tris.length && big < 10) {
    issues.push({
      level: 'warn',
      text: `整個模型最長邊只有 ${big.toFixed(2)}mm（不到 1 公分），`
          + '確認一下單位是不是選錯了 —— 用 cm 匯出會讓模型小十倍'
    });
  }

  return {
    ok: !issues.some(i => i.level === 'bad'),
    issues,
    closed: v.closed,
    components: v.components,
    euler: v.euler,
    triangles: tris.length,
    volume: vol,                       // 已換算後的單位³
    size: { x: size.x, y: size.y, z: size.z }
  };
}
