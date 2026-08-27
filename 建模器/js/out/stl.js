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
import { boundaryEdges, nonManifoldEdges, reversedFaceEdges } from '../core/selectops.js';

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
    /**
     * ⚠ **一律走 `mesh.faceTriangles()`，不要自己扇形切。**
     * 非凸的面用扇形切會送出**跑到多邊形外面、而且繞向翻掉**的三角形，
     * 而 STL 的繞向就是法向 —— 切片軟體會報非流形，
     * 而**體積照樣對得上**（有號量），所以在這裡驗不出來。
     * 那正是坑第 17 條：**中途的量一直都是對的，末端才錯。**
     */
    for (const tri of mesh.faceTriangles(f)) {
      const a = put(tri[0].p), b = put(tri[1].p), c = put(tri[2].p);
      const n = new THREE.Vector3()
        .subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
      const L = n.length();
      // 退化三角形（三點共線或重合）在這裡就丟掉，
      // 留著只會讓切片軟體報「非流形」
      if (L < 1e-12) continue;

      /**
       * ⚠ 三個頂點都要 clone。
       *
       * 〔2026-08-24 改：原本的理由是「扇形三角化時 `p0` 每個面只算一次、
       * 　給所有三角形共用，直接塞進去會讓兩個三角形共用同一個
       * 　`Vector3`」。改走 `faceTriangles()` 之後每個三角形各自 `put()`，
       * 　而 `put()` 自己就 `clone()` 了 —— **那個共用情形已經不存在**。
       * 　留著 clone 是**便宜的保險**：這裡是輸出端，
       * 　而下游的 `dropToBed()` 是「就地」平移，一旦共用就會被減兩次。〕
       *
       * 實測過的症狀（100×60 的平板加厚後放在 Y=44cm 處匯出）：
       *   dropToBed 前  外框 1000×600×2 mm、體積 +1,200,000  ✓
       *   dropToBed 後  外框 1000×600×439 mm、體積 −86,600,000 ✗
       * 面板判定「法向朝內，印出來會內外相反」，但真正的原因是
       * 頂點被移了兩次、把薄板整個扯開。
       *
       * 三角形面（方塊、圓錐這些）每個面只產生一個三角形，共用不到，
       * 所以一直沒事 —— 這個 bug 只在**有四邊形面**的東西上發作
       * （平板、折板、管、圓柱側面），而那正是板件。
       */
      out.push({ a: a.clone(), b: b.clone(), c: c.clone(), n: n.divideScalar(L) });
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

  /**
   * 🔴 **非流形先報，⛔ 不要讓它混在「網格結構有問題」那一則裡。**
   *
   * ⚠ **原本它走的是 `v.errors[0]`**，印出來是
   * 「網格結構有問題：邊 0→1 出現兩次（非流形…）」——
   * `0` 跟 `1` 是**頂點索引**，畫面上沒有任何東西叫這個名字，
   * 使用者拿它一步都走不下去。〔坑第 20 條、坑第 11 條〕
   *
   * ⭐ 現在它是獨立的一則，而且面板會在旁邊長出一顆 `指出來`。
   */
  /**
   * 🔴 **「有面貼反了」單獨一則，而且要指到 `修法向` 那顆按鈕。**
   *
   * ⚠ **這是使用者真的會遇到的那一種**（按 `翻面` 只選一個面就會這樣），
   * ⛔ 而它原本跟非流形共用同一句看不懂的話
   * 「網格結構有問題：邊 2→1 出現兩次（非流形…）」——
   * **2 跟 1 是頂點索引，畫面上沒有這種東西**，使用者一步都走不下去。
   * 【實證 2026-08-27】方塊翻一個面：那句話出現 6 次，
   * 而真正的非流形邊是 **0** 條 —— 訊息叫人去找一個不存在的東西。
   *
   * ⭐ **出路早就存在，只是沒有人講** —— 工具列的 `修法向`。
   * 〔坑第 11 條：講了問題卻沒有出路；坑第 18 條：誤報比漏報更糟〕
   *
   * ⚠ **這裡的名字照介面上的字**：按鈕叫「修法向」，⛔ 不叫 recalcNormals。
   */
  const rev = reversedFaceEdges(mesh);
  if (rev.edges) {
    issues.push({
      level: 'bad',
      kind: 'flipped',
      text: `有 ${rev.faces} 個面的朝向跟鄰居相反（正反面貼反了），`
          + `${rev.edges} 條邊對不起來。`
          + '切片軟體會以為那幾塊是內部，印出來會缺角或失敗 —— '
          + '按工具列的「修法向」就會自動修好，'
          + '修好之後再檢查一次（其他問題要修好它才看得準）'
    });
  }

  const nm = nonManifoldEdges(mesh);
  if (nm.edges) {
    issues.push({
      level: 'bad',
      kind: 'nonmanifold',
      text: `有 ${nm.edges} 條邊被 3 個以上的面共用（非流形），涉及 ${nm.faces} 個面。`
          + '切片軟體算不出哪邊是實心，會印壞或直接失敗 —— '
          + '這種要自己刪掉多餘的面，「補洞」補不了它'
    });
  }

  /**
   * 🔴 **這裡的條數要跟「指出來」畫出來的紅線是同一個數字。**
   *
   * ⚠ **原本用的是 `v.boundaryHalfEdges`，而那個數字含非流形邊** ——
   * 一條邊被 3 個面共用時，配不到 twin 的那條半邊會被補成邊界半邊，
   * `validate()` 照樣把它數進去。於是報告說「有 10 條邊界邊」，
   * 按下去只亮 9 條紅線 —— **兩個數字對不起來，而且沒有人查得出為什麼。**
   *
   * ⭐ 改成問 `boundaryEdges()`（＝ 按鈕用的同一支）之後，
   * **兩個數字必然一致** —— 這正是「讓兩個數字互相對得起來」那條規則
   * 的另一面：⛔ 與其讓兩條路對齊，不如只問同一支。〔坑第 31 條〕
   *
   * ⚠ **邊界邊全部來自非流形時（`bd.hes` 是 0），⛔ 不要報這一則** ——
   * 病因是「多了面」不是「少了面」，叫人去補洞是指一條死路（坑第 34 條）。
   * 非流形那一則已經在上面報過了。
   */
  /**
   * ⚠ **面貼反了的時候，「不是封閉的」是它的症狀，⛔ 不是另一個病。**
   *
   * 【實證】方塊翻一個面 → `boundaryEdges()` 回 **6 條** ——
   * 因為繞向對不起來的半邊配不到 twin，被補成了邊界半邊。
   * 但**那個方塊一個洞都沒有**，按 `指出來` 會亮 6 條紅線指著好好的邊，
   * 而 toast 還叫人去按 `補洞`。〔坑第 18 條 ＋ 第 34 條，一次中兩條〕
   *
   * → **貼反了就先只講貼反了**；按 `修法向` 修好之後這一則會自己消失，
   * 真的有洞的話那時候才報得準。
   */
  const bd = boundaryEdges(mesh);
  if (!v.closed && bd.hes.length && !rev.edges) {
    issues.push({
      level: 'bad',
      kind: 'open',
      text: `不是封閉的（有 ${bd.hes.length} 條邊界邊，${bd.holes} 個破洞）。`
          + '切片軟體會印出空殼或直接失敗 —— 板件請先給板厚，實體請檢查是不是破面'
    });
  }

  /**
   * 🔴 **這一則是三種病裡唯一使用者真的做得出來的，⛔ 所以它最需要出路。**
   *
   * ⚠ **`翻面` 那顆按鈕就會做出這個狀態** —— 它把**整個物件**的面朝向
   * 全部翻過來（⛔ 不是翻選到的那一個面）。繞向仍然一致，只是內外顛倒，
   * 所以 `reversedFaceEdges()` 是 0、`v.closed` 是 true ——
   * **只有體積是負的**。〔`edit.js` `flipNormals()` 的註解：
   * 「`recalcNormalsOutside()` 要修的病，我們沒有理由提供一個製造它的按鈕」
   * —— 所以真正走得到的入口只有 `翻面`，以及日後匯進來的模型〕
   *
   * ⚠ **原本這一則只講「印出來會內外相反」，⛔ 沒說按哪顆** ——
   * 而 `修法向` 就修得掉（實測：翻面 → 修法向 → 一則問題都沒有）。
   * 〔坑第 11 條：講了問題卻沒有出路〕
   *
   * ⚠ **名字照介面上的字**：按鈕叫「修法向」，⛔ 不叫 recalcNormals。
   */
  if (v.closed && vol <= 0) {
    issues.push({
      level: 'bad',
      kind: 'inward',
      text: '整個物件的面都朝內（體積算出來是負的），印出來會內外相反 —— '
          + '按工具列的「修法向」就會自動修好'
    });
  }

  if (!v.ok) {
    /**
     * ⚠ **非流形已經在上面單獨報過了，這裡要扣掉，⛔ 不要報兩次。**
     * 同一件事講兩遍會讓人以為是兩個病，而第二句還帶著看不懂的頂點索引。
     * 〔⚠ 只能比對文字 —— `mesh.issues` 存的就是字串，沒有結構可以問。
     * 　那正是這一輪要繞開它、自己從面重新數一次的理由〕
     */
    const rest = (nm.edges || rev.edges)
      ? v.errors.filter(e => !/非流形/.test(e))
      : v.errors;
    /**
     * ⚠ **貼反了的時候，⛔ 連這一則也不要報。**
     * 【實證】方塊翻一個面 → 這裡吐「網格結構有問題：**半邊 113 沒有 next**」。
     * 那是半邊結構的內部編號，**畫面上更不存在** —— 而且它是貼反造成的，
     * 不是另一個病。修完法向就沒了（實測歸零）。
     */
    if (rest.length && !rev.edges) {
      issues.push({ level: 'bad', text: '網格結構有問題：' + rest[0] });
    }
  }

  /**
   * ⚠ **貼反了會讓這個數字說謊，⛔ 所以也要壓下去。**
   * 【實證】方塊翻一個面 → 報「由 **2 個**互不相連的塊組成」——
   * **那是一個方塊，只有一塊。** 病因是 `componentCount()` 沿 `he.twin.face`
   * 走訪，而繞向對不起來的地方配不到 twin，走訪就斷在那裡。
   * 〔坑第 18 條：誤報比漏報更糟 —— 這一則會讓人去找一個不存在的第二塊〕
   */
  if (v.components > 1 && !rev.edges) {
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
