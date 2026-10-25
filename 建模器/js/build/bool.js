/**
 * bool.js — 布林運算（聯集／差集／交集）
 *
 * ── 這個檔案的定位 ──────────────────────────────────
 * 這是整個專案**唯一**直接接觸 Manifold 函式庫的檔案。
 * 其他所有程式碼一律只呼叫這裡匯出的函式，不 import manifold。
 *
 * 沿用日誌既有的分層原則「規則分開、幾何共用」：
 * 換掉布林引擎 ＝ 改這一個檔，運算樹格式、面板、Undo、
 * 存讀檔一行都不用動。這是選用外部函式庫時能給的最實際保險。
 *
 * ── 為什麼是 Manifold，不是原訂的 three-bvh-csg ─────
 * 實測同一題（方塊 60×45×40 挖 ⌀20 貫孔）：
 *
 *                  three-bvh-csg   Manifold
 *   耗時               40 ms         0 ms
 *   三角形              376          144
 *   尤拉數（應為 0）    -113 ✗        0 ✓
 *   網格封閉             否           是
 *   結構問題           244 項        0 項
 *
 * three-bvh-csg 的輸出有 506 條邊沒有鄰居。畫面上看不出來，
 * 但第 3 期展開引擎問的第一個問題就是「這條邊隔壁是哪個面」，
 * 接不起來的網格會讓展開直接失效。
 * Manifold 的設計目標正是「保證輸出是封閉可接的網格」。
 *
 * ── 運算樹的資料形狀 ────────────────────────────────
 * 存的是「怎麼算出來的」，不是「算完的三角形」——
 * 跟日誌的第 2 個關鍵決定（存參數不存三角形）一致，
 * 所以挖完孔還能回頭改孔徑。
 *
 *   {
 *     type: 'bool',
 *     op:   'union' | 'subtract' | 'intersect',
 *     items: [
 *       { src:{type:'box',...}, pos:[x,y,z], rot:[x,y,z], scale:[x,y,z], name },
 *       { src:{type:'cylinder',...}, ... }
 *     ]
 *   }
 *
 * items[0] 是被減的那個；差集是 items[0] − items[1] − items[2] …
 * item.src 本身也可以是 bool，所以能巢狀（先挖孔再跟別的聯集）。
 *
 * 單位一律 cm。
 */

import * as THREE from 'three';
import { Mesh } from '../core/mesh.js';

/** Manifold 的進入點。相對路徑，瀏覽器與 Node 都能解析，不需要 importmap。 */
const MANIFOLD_URL = '../../lib/manifold/manifold.js';

export const BOOL_OPS = {
  UNION:     'union',
  SUBTRACT:  'subtract',
  INTERSECT: 'intersect'
};

export const BOOL_LABEL = {
  union:     '聯集',
  subtract:  '差集',
  intersect: '交集'
};

/** 給介面用的符號，按鈕上比文字好認 */
export const BOOL_SYMBOL = {
  union:     '∪',
  subtract:  '−',
  intersect: '∩'
};

// ═══════════════════════════════════════════════════════
//  函式庫載入
// ═══════════════════════════════════════════════════════

let _wasm = null;      // 載好的模組
let _loading = null;   // 進行中的 Promise
let _error = null;     // 載入失敗的原因

/** 布林功能現在可不可以用 */
export function csgReady() { return _wasm !== null; }

/** 載入失敗的原因；沒失敗回傳 null */
export function csgError() { return _error; }

/**
 * 載入 Manifold。
 *
 * 它是 WebAssembly，一定是非同步的。但整個建模器的資料流
 * （操作 → 改 Doc → view.sync）是同步的，若讓 mesh() 變成非同步，
 * 等於要把每一處呼叫都改寫，風險遠大於收益。
 *
 * 所以做法是：**啟動時先把它載完，之後全部維持同步。**
 * 載入失敗也不讓程式掛掉 —— 其餘功能照常，只是不能做布林。
 *
 * @returns {Promise<boolean>} 成功與否
 */
export function initCSG() {
  if (_wasm) return Promise.resolve(true);
  if (_loading) return _loading;

  _loading = (async () => {
    try {
      const mod = await import(/* @vite-ignore */ MANIFOLD_URL);
      const w = await mod.default();
      w.setup();
      _wasm = w;
      _error = null;
      return true;
    } catch (e) {
      _error = e;
      return false;
    }
  })();

  return _loading;
}

function need() {
  if (!_wasm) {
    throw new Error(
      _error
        ? '布林運算函式庫沒有載入成功：' + _error.message
        : '布林運算函式庫還在載入中，請稍候再試'
    );
  }
  return _wasm;
}

// ═══════════════════════════════════════════════════════
//  我們的 Mesh ←→ Manifold
// ═══════════════════════════════════════════════════════

/**
 * 我們的半邊網格 → Manifold 物件。
 *
 * Manifold 只吃三角形，所以多邊形的面要先扇形三角化；
 * 而且它要求輸入必須是封閉的（開放的板件不是「實體」，沒有內外之分），
 * 所以在這裡先擋下來，給看得懂的訊息，而不是讓它丟出底層錯誤。
 */
function toManifold(mesh, label = '物件') {
  const { Manifold, Mesh: MMesh } = need();

  const check = mesh.validate();
  if (!check.closed) {
    throw new Error(
      `「${label}」是開放的面（板件），不能做布林運算。` +
      '布林是實體之間的運算，要有內外之分才算得出來。'
    );
  }

  const vi = mesh._vertIndex();
  const verts = new Float32Array(mesh.verts.length * 3);
  mesh.verts.forEach((v, i) => {
    verts[i * 3]     = v.p.x;
    verts[i * 3 + 1] = v.p.y;
    verts[i * 3 + 2] = v.p.z;
  });

  const tri = [];
  for (const f of mesh.faces) {
    // ⚠ 非凸的面用扇形切會送出繞向翻掉的三角形，Manifold 會拿到一個壞掉的實體
    for (const [a, b, c] of mesh.faceTriangles(f)) {
      tri.push(vi.get(a.id), vi.get(b.id), vi.get(c.id));
    }
  }

  const mm = new MMesh({
    numProp: 3,
    vertProperties: verts,
    triVerts: new Uint32Array(tri)
  });

  const man = new Manifold(mm);
  const st = man.status();
  if (st && st !== 'NoError') {
    man.delete();
    throw new Error(`「${label}」的網格有問題（${st}），無法做布林運算`);
  }
  return man;
}

/** Manifold 物件 → 我們的半邊網格 */
function fromManifold(man) {
  const mm = man.getMesh();
  const stride = mm.numProp;

  const points = [];
  for (let i = 0; i < mm.numVert; i++) {
    points.push(new THREE.Vector3(
      mm.vertProperties[i * stride],
      mm.vertProperties[i * stride + 1],
      mm.vertProperties[i * stride + 2]
    ));
  }

  const faces = [];
  for (let i = 0; i < mm.numTri; i++) {
    faces.push([mm.triVerts[i * 3], mm.triVerts[i * 3 + 1], mm.triVerts[i * 3 + 2]]);
  }

  // Manifold 的輸出本來就共用頂點，不需要再焊接，直接建結構
  const mesh = Mesh.fromFaceList(points, faces);
  mesh.autoMarkFolds();
  return mesh;
}

// ═══════════════════════════════════════════════════════
//  運算樹
// ═══════════════════════════════════════════════════════

const ident = { pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] };

/** 一個 item 的位置／角度／縮放 → 4×4 矩陣 */
export function itemMatrix(item) {
  const p = item.pos   || ident.pos;
  const r = item.rot   || ident.rot;
  const s = item.scale || ident.scale;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(p[0], p[1], p[2]),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2])),
    new THREE.Vector3(s[0], s[1], s[2])
  );
}

/** 建立一個 item（給 io.js 與介面用，避免各處自己拼物件） */
export function makeItem(src, pos, rot, scale, name) {
  return {
    src,
    pos:   pos   ? [pos.x, pos.y, pos.z]       : [0, 0, 0],
    rot:   rot   ? [rot.x, rot.y, rot.z]       : [0, 0, 0],
    scale: scale ? [scale.x, scale.y, scale.z] : [1, 1, 1],
    name:  name  || ''
  };
}

export function isBoolSrc(src) {
  return !!src && src.type === 'bool';
}

/**
 * 求值一棵運算樹，回傳半邊網格。
 *
 * @param {object}   node       {type:'bool', op, items:[...]}
 * @param {Function} buildChild (src) => Mesh　由 io.js 提供，
 *                              因為只有它知道 box / cylinder / 巢狀 bool / 已烘網格
 *                              各要怎麼生成。這樣 bool.js 就不必認識 ModelObject，
 *                              兩邊不會互相 import。
 * @returns {Mesh}
 */
export function evalBoolTree(node, buildChild) {
  if (!isBoolSrc(node)) throw new Error('這不是布林運算樹');

  const items = node.items || [];
  if (!items.length) throw new Error('布林運算沒有任何運算元');

  // 只有一個運算元就沒得算，直接把它擺到定位回傳
  if (items.length === 1) {
    return buildChild(items[0].src).transformed(itemMatrix(items[0]));
  }

  const { Manifold } = need();
  const made = [];        // 所有產生過的 Manifold 物件，最後一律釋放

  try {
    let acc = null;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const label = it.name || `第 ${i + 1} 個運算元`;
      const childMesh = buildChild(it.src).transformed(itemMatrix(it));
      const man = toManifold(childMesh, label);
      made.push(man);

      if (i === 0) { acc = man; continue; }

      let next;
      switch (node.op) {
        case BOOL_OPS.UNION:     next = Manifold.union(acc, man); break;
        case BOOL_OPS.SUBTRACT:  next = Manifold.difference(acc, man); break;
        case BOOL_OPS.INTERSECT: next = Manifold.intersection(acc, man); break;
        default: throw new Error(`不認得的布林運算：${node.op}`);
      }
      made.push(next);
      acc = next;
    }

    if (acc.isEmpty()) {
      throw new Error(
        node.op === BOOL_OPS.INTERSECT
          ? '交集是空的 —— 這些物件沒有重疊到的部分'
          : '運算結果是空的 —— 檢查一下物件的位置與大小'
      );
    }

    return fromManifold(acc);

  } finally {
    // WASM 的記憶體不會自動回收，一定要手動釋放，
    // 否則每按一次布林就漏一份網格，iPad 上很快就撐不住
    for (const m of made) {
      try { m.delete(); } catch (e) { /* 已釋放過，忽略 */ }
    }
  }
}

/**
 * 把一堆網格聯集成一個。
 *
 * 陣列與鏡射（array.js）需要把 N 份副本併起來，但**只有這個檔案
 * 可以碰 Manifold**（見日誌「四個關鍵決定」第 4 條），所以把能力
 * 從這裡開出去，而不是讓 array.js 自己去 import 函式庫。
 *
 * 為什麼一定要走布林聯集，不能只是把網格堆在一起：
 * 堆疊很快，但副本一旦互相碰到，結果就是「兩件衣服疊著沒縫線」——
 * 正是當初換掉 three-bvh-csg 的同一個問題。
 *
 * @param {Mesh[]} meshes
 * @param {string[]} [labels] 出錯時用來指出是哪一份
 * @returns {Mesh}
 */
export function unionMeshes(meshes, labels = []) {
  if (!meshes || !meshes.length) throw new Error('沒有東西可以聯集');
  if (meshes.length === 1) return meshes[0];

  const { Manifold } = need();
  const made = [];

  try {
    const mans = meshes.map((m, i) => {
      const man = toManifold(m, labels[i] || `第 ${i + 1} 份`);
      made.push(man);
      return man;
    });

    // 批次版比兩兩相加快，數值也比較穩（實測 50 份 3ms，
    // 而且體積剛好是 50000 而不是 49999.999…）
    const acc = Manifold.union(mans);
    made.push(acc);

    if (acc.isEmpty()) throw new Error('聯集結果是空的');
    return fromManifold(acc);

  } finally {
    for (const m of made) {
      try { m.delete(); } catch (e) { /* 已釋放過，忽略 */ }
    }
  }
}

/**
 * 匯入整理「聯集成一個實體」（網格核心第五批 b ③a → `build/importSolid.js`）：每一塊各自是實體 ⇒ 全部聯集；
 * 聯集完分開的碎屑（體積小於全部的百萬分之一 —— 汽車 49 塊、都是浮點誤差留下的）丟掉、講出丟了幾塊。
 * 放在這裡的理由同 `unionMeshes()`：只有這個檔可以碰 Manifold。
 * @param {Mesh[]} meshes 每一塊都要封閉、朝外（呼叫端先挑好、先修好）
 * @returns {{mesh: Mesh, sumVolume: number, volume: number, pieces: number, dropped: number}}
 *   `sumVolume` ＝ 各塊體積加總（> `volume` ⇒ 有穿插）；`pieces` ＝ 留下幾個分開的實體
 */
export function unionSolids(meshes, labels = []) {
  if (!meshes || !meshes.length) throw new Error('沒有東西可以聯集');
  const { Manifold } = need();
  const made = [];
  try {
    let sumVolume = 0;
    const mans = meshes.map((m, i) => {
      const man = toManifold(m, labels[i] || `第 ${i + 1} 塊`);
      made.push(man);
      sumVolume += man.volume();
      return man;
    });
    const acc = mans.length > 1 ? Manifold.union(mans) : mans[0];
    if (acc !== mans[0]) made.push(acc);
    if (acc.isEmpty()) throw new Error('聯集結果是空的');
    const parts = acc.decompose();
    made.push(...parts);
    const total = parts.reduce((s, p) => s + Math.abs(p.volume()), 0);
    const keep = parts.filter(p => Math.abs(p.volume()) >= total * SPECK_FRAC);
    const out = keep.length === parts.length ? acc : Manifold.union(keep);
    if (out !== acc) made.push(out);
    return { mesh: fromManifold(out), sumVolume, volume: out.volume(), pieces: keep.length, dropped: parts.length - keep.length };
  } finally {
    for (const m of made) {
      try { m.delete(); } catch (e) { /* 已釋放過，忽略 */ }
    }
  }
}
/** 碎屑：體積小於全部的這個比例 */
export const SPECK_FRAC = 1e-6;

/**
 * 這個網格 Manifold 收不收得下（是不是一個乾淨、朝外的實體）—— 匯入整理修完隔板先問一次（網格核心第五批 b ③b），
 * 收不下的⛔ 送去聯集（一塊壞的會讓整個聯集失敗）。
 * @returns {{ok: boolean, volume: number, reason: string}}
 */
export function solidInfo(mesh, label = '這一塊') {
  let man = null;
  try {
    man = toManifold(mesh, label);
    const v = man.volume();
    return v > 0 ? { ok: true, volume: v, reason: '' } : { ok: false, volume: v, reason: '體積是負的（裡外反了）' };
  } catch (e) {
    return { ok: false, volume: 0, reason: e.message || String(e) };
  } finally {
    if (man) try { man.delete(); } catch (e) { /* 已釋放過，忽略 */ }
  }
}

/**
 * 🔴 **剖面分切「照最大外形切」：一段厚度裡最大的外形**（2026-10-19，實驗 T2 帽簷不見）。
 * 放在這裡的理由同 `unionMeshes()`：只有這個檔可以碰 Manifold。
 *
 * 做法：把網格轉到 (u, v, w) 座標（w ＝ 切片軸）→ 只留 w 在 z0～z1 那一段（`trimByPlane` 兩刀）
 * → 往 u–v 平面投影（`project()`，⭐ 就是這一段立體的「影子」）→ 多邊形。
 * ⇒ 那一段裡任何高度、任何厚度的東西都會出現在外形裡 —— 寧大勿小（之後再磨掉）。
 *
 * @param {Mesh} mesh  世界座標、封閉
 * @param {number[][]} basis [U, V, W]：片的右、片的上、切片軸（右手系，`slice/section.js` `AXES`）
 * @param {number} z0 這一片的下緣（沿 W，世界座標）
 * @param {number} z1 這一片的上緣
 * @returns {Array<Array<{x:number,y:number}>>} 每個多邊形一圈點；外圈逆時針、洞順時針（Manifold 的慣例）
 */
export function slabShadow(mesh, basis, z0, z1, label = '物件') {
  need();
  const [U, V, W] = basis;
  const M = new THREE.Matrix4().set(
    U[0], U[1], U[2], 0,
    V[0], V[1], V[2], 0,
    W[0], W[1], W[2], 0,
    0, 0, 0, 1);
  const made = [];
  try {
    const man = toManifold(mesh.transformed(M), label);
    made.push(man);
    const lo = man.trimByPlane([0, 0, 1], z0);
    made.push(lo);
    const band = lo.trimByPlane([0, 0, -1], -z1);
    made.push(band);
    if (band.isEmpty()) return [];
    const cs = band.project();
    made.push(cs);
    return cs.toPolygons().map(poly => poly.map(p => ({ x: p[0], y: p[1] })));
  } finally {
    for (const m of made) {
      try { m.delete(); } catch (e) { /* 已釋放過，忽略 */ }
    }
  }
}

/**
 * 🔴 **剖面分切「每片自動合併」：同一片的輪廓照「被任何一圈包住就是料」合成一張**（2026-10-22，第二輪第一批（二）甲）。
 * 放在這裡的理由同 `slabShadow()`：只有這個檔可以碰 Manifold（`CrossSection`）。
 * ⭐ 填法用 Positive（繞的圈數 > 0 才是料）：外圈逆時針 +1、洞順時針 −1 ⇒ 洞照樣是洞；
 * 兩個物件疊在一起 ⇒ 重疊處 +2 還是料、只算一次；別的物件塞進洞裡 ⇒ −1 ＋ 1 ＋ 1 ＝ 料。
 * ⚠ 整圈順時針、外面沒有包它的那一圈（翻面的物件、外圈斷掉只剩洞）⇒ 不算料、會被拿掉。
 * 〔PrusaSlicer 的預設也是 Positive【已查證 · 外部參考-3D列印與剖面分切.md】〕
 * @param {Array<{x:number,y:number}[]>} polys 同一片的所有輪廓
 * @returns {Array<{x:number,y:number}[]>} 合併後的輪廓：外圈逆時針、洞順時針
 */
export function mergeLoops(polys) {
  const w = need();
  const made = [];
  try {
    const cs = new w.CrossSection(polys.map(pts => pts.map(p => [p.x, p.y])), 'Positive');
    made.push(cs);
    if (cs.isEmpty()) return [];
    return cs.toPolygons().map(poly => poly.map(p => ({ x: p[0], y: p[1] })));
  } finally {
    for (const m of made) {
      try { m.delete(); } catch (e) { /* 已釋放過，忽略 */ }
    }
  }
}

/**
 * 🔴 **互卡開槽：一片的料扣掉幾個槽，分成一塊一塊**（2026-10-24，第二輪第六批 6a → `slice/interlock.js`）。
 * 放在這裡的理由同 `mergeLoops()`：只有這個檔可以碰 Manifold（`CrossSection` 相減＋`decompose()`）。
 * 填法同 `mergeLoops()`：Positive。
 * @param {Array<{x:number,y:number}[]>} polys 這一片的輪廓（外圈逆時針、洞順時針）
 * @param {Array<{x:number,y:number}[]>} slots 要挖掉的槽（任何方向都可以）
 * @returns {Array<Array<{x:number,y:number}[]>>} 挖完之後的每一塊（每塊的輪廓：外圈逆時針、洞順時針）
 */
export function cutSlots(polys, slots) {
  const w = need();
  const made = [];
  try {
    const cs = new w.CrossSection(polys.map(pts => pts.map(p => [p.x, p.y])), 'Positive');
    made.push(cs);
    let res = cs;
    if (slots.length) {
      const cut = new w.CrossSection(slots.map(pts => pts.map(p => [p.x, p.y])), 'NonZero');
      made.push(cut);
      res = cs.subtract(cut);
      made.push(res);
    }
    if (res.isEmpty()) return [];
    const parts = res.decompose();
    for (const q of parts) made.push(q);
    return parts.map(q => q.toPolygons().map(poly => poly.map(p => ({ x: p[0], y: p[1] }))));
  } finally {
    for (const m of made) {
      try { m.delete(); } catch (e) { /* 已釋放過，忽略 */ }
    }
  }
}

/**
 * 🔴 **剖面斷線那一片：一堆掃描線的細長方塊合成輪廓、把階梯拉直**（網格核心第五批 b ⑥ → `slice/section.js` `scanFill()`）。
 * 放在這裡的理由同 `mergeLoops()`：只有這個檔可以碰 Manifold（`CrossSection` NonZero 聯集＋`simplify()`）。
 * @param {Array<[number,number][]>} rects 每個是一列裡實心的那一段（四個角）
 * @param {number} eps 拉直的容許值（cm）：比這個小的鋸齒拿掉
 * @returns {{x:number,y:number}[][]}
 */
export function rowsToLoops(rects, eps) {
  if (!rects.length) return [];
  const w = need();
  const made = [];
  try {
    const cs = new w.CrossSection(rects, 'NonZero');
    made.push(cs);
    if (cs.isEmpty()) return [];
    const sm = eps > 0 ? cs.simplify(eps) : cs;
    if (sm !== cs) made.push(sm);
    return sm.toPolygons().map(poly => poly.map(p => ({ x: p[0], y: p[1] })));
  } finally {
    for (const m of made) {
      try { m.delete(); } catch (e) { /* 已釋放過，忽略 */ }
    }
  }
}

/**
 * 🔴 **兩塊（各自是外圈＋洞）疊在一起的面積**（2026-10-24，第二輪第五批 5a → `slice/section.js` `stackCheck()`：
 * 相鄰兩片的塊黏得到多少）。放在這裡的理由同 `mergeLoops()`：只有這個檔可以碰 Manifold（`CrossSection` 交集）。
 * 填法同 `mergeLoops()`：Positive（外圈逆時針 +1、洞順時針 −1）。
 * @param {Array<{x:number,y:number}[]>} a
 * @param {Array<{x:number,y:number}[]>} b
 * @returns {number} 面積（同單位的平方）
 */
export function overlapArea(a, b) {
  return overlapPatch(a, b).area;
}

/**
 * 同 `overlapArea()`，另外給**疊在一起的那一塊在哪**（外框的中心；沒疊到 ⇒ `at` 是 null）。
 * 2026-10-24 第二輪第五批 5b（kang「只黏一點點只塗小的那塊＋在黏的那一點畫圈」）：圈要畫在黏的那一點。
 * @returns {{area: number, at: {x:number,y:number}|null}}
 */
export function overlapPatch(a, b) {
  const w = need();
  const made = [];
  try {
    const ca = new w.CrossSection(a.map(pts => pts.map(p => [p.x, p.y])), 'Positive');
    made.push(ca);
    const cb = new w.CrossSection(b.map(pts => pts.map(p => [p.x, p.y])), 'Positive');
    made.push(cb);
    const ab = ca.intersect(cb);
    made.push(ab);
    if (ab.isEmpty()) return { area: 0, at: null };
    const bb = ab.bounds();
    return { area: ab.area(), at: { x: (bb.min[0] + bb.max[0]) / 2, y: (bb.min[1] + bb.max[1]) / 2 } };
  } finally {
    for (const m of made) {
      try { m.delete(); } catch (e) { /* 已釋放過，忽略 */ }
    }
  }
}

/**
 * 🔴 **一圈平面上的點往外（`delta` > 0）或往內（< 0）推一段距離**（2026-10-19，展開圖的縫份／黏合片：`out/sheet.js` `marginGeometry()`）。
 * 放在這裡的理由同 `slabShadow()`：只有這個檔可以碰 Manifold（`CrossSection.offset()`）。
 * ⭐ 轉角用「尖角」（Miter，上限 2 倍 ⇒ 很尖的角會被削平，⛔ 長出一根刺）—— 縫份、黏合片的外框都是直角接。
 * ⚠ 照 EvenOdd 填：一圈點不管順時針逆時針都當成「圈裡面是料」。往內推到沒了 ⇒ 回傳空陣列。
 * @param {{x:number,y:number}[]} loop
 * @returns {{x:number,y:number}[][]} 推完的幾圈（凹得很深的形狀可能多出一圈內圈）
 */
export function offsetLoop(loop, delta) {
  const w = need();
  const made = [];
  try {
    const cs = new w.CrossSection([loop.map(p => [p.x, p.y])], 'EvenOdd');
    made.push(cs);
    const off = cs.offset(delta, 'Miter', 2);
    made.push(off);
    if (off.isEmpty()) return [];
    return off.toPolygons().map(poly => poly.map(p => ({ x: p[0], y: p[1] })));
  } finally {
    for (const m of made) {
      try { m.delete(); } catch (e) { /* 已釋放過，忽略 */ }
    }
  }
}

/**
 * 🔴 **曲線刀具第四步 `切穿`：物件 ∩ 刀柱、物件 − 刀柱**（刀柱由 `edit.js` `curveCutterPrism()` 組）。
 * 放在這裡的理由同 `unionMeshes()`：只有這個檔可以碰 Manifold。
 * ⚠ 平滑旗標與分片線會消失（布林的輸出是重新組的三角形，`fromManifold()`）—— 規格「切穿」那一段寫著要講。
 *
 * @returns {{inside: Mesh|null, outside: Mesh|null}} 空的那一塊回 null（線沒有真的把物件分開）
 */
export function splitByCutter(mesh, cutter, label = '物件') {
  const { Manifold } = need();
  const made = [];
  try {
    const a = toManifold(mesh, label); made.push(a);
    const c = toManifold(cutter, '切穿的刀'); made.push(c);
    const inn = Manifold.intersection(a, c); made.push(inn);
    const out = Manifold.difference(a, c); made.push(out);
    return {
      inside: inn.isEmpty() ? null : fromManifold(inn),
      outside: out.isEmpty() ? null : fromManifold(out)
    };
  } finally {
    for (const m of made) {
      try { m.delete(); } catch (e) { /* 已釋放過，忽略 */ }
    }
  }
}

/** 切成放得下的塊：每個軸的刀面上 (u, v) 是世界的哪兩軸（見 `cutBody()`）*/
export const CUT_UV = [[2, 1], [0, 2], [0, 1]];
const CUT_ROT = [[0, 90, 0], [-90, 0, 0], null];     // 把軸 a 轉到 Z（轉完 Z ＝ −x、−y、z）
const CUT_W = [-1, -1, 1];

/**
 * 🔴 **切成放得下的塊（第二輪第九批 9a，2026-10-25）—— Manifold 的那一半**（規劃、挑插銷的位置在 `out/bedCut.js`）。
 * 放在這裡的理由同 `unionMeshes()`：只有這個檔可以碰 Manifold。
 * 實體轉一次就留著（大模型轉一次要好幾秒），挑刀的位置時一個位置切好幾次斷面；用完一定要 `close()`。
 *
 * 座標：傳進來的網格是**世界座標**（cm、Y 朝上）；刀都跟世界的 x／y／z 軸垂直（列印的 X ＝ x、Y ＝ −z、Z ＝ y，軸一樣只是換名字）。
 * 斷面上的平面座標 (u, v)：照 `CUT_UV` —— 軸 0（x）的刀面 u ＝ z、v ＝ y；軸 1（y）u ＝ x、v ＝ z；軸 2（z）u ＝ x、v ＝ y。
 *
 * @param {Mesh} mesh 封閉的實體（世界座標）
 * @returns {{volume:number, room:Function, split:Function, close:Function}}
 */
export function cutBody(mesh, label = '物件') {
  const w = need();
  const body = toManifold(mesh, label);
  const turned = CUT_ROT.map(r => (r ? body.rotate(r) : body));
  const free = list => { for (const m of list) { try { m.delete(); } catch (e) { /* 已釋放過，忽略 */ } } };
  const slice = (a, c) => turned[a].slice(c * CUT_W[a]);
  return {
    volume: body.volume(),
    /**
     * 刀面（軸 a、位置 c）在格子 `cell`（[u0, v0, u1, v1]）裡切到的每一塊，各自「放得下插銷的地方」：
     * 往內縮 `keep`（孔半徑 ＋ 孔外的料）還剩的地方，而且往兩邊各 `depth` 的斷面也要剩（孔⛔ 打穿到外面）。
     * @returns {{area:number, room:number, polys:[number,number][][]}[]}
     */
    room(a, c, cell, keep, depth) {
      const made = [];
      try {
        const s0 = slice(a, c); made.push(s0);
        const box = w.CrossSection.square([cell[2] - cell[0], cell[3] - cell[1]]); made.push(box);
        const boxT = box.translate([cell[0], cell[1]]); made.push(boxT);
        const face = s0.intersect(boxT); made.push(face);
        if (face.isEmpty()) return [];
        const inner = [cell[0] + keep, cell[1] + keep, cell[2] - keep, cell[3] - keep];
        let limit = null;
        if (inner[2] > inner[0] && inner[3] > inner[1]) {
          const ib = w.CrossSection.square([inner[2] - inner[0], inner[3] - inner[1]]); made.push(ib);
          limit = ib.translate([inner[0], inner[1]]); made.push(limit);
          for (const d of [-depth, depth]) {
            const s = slice(a, c + d); made.push(s);
            const o = s.offset(-keep, 'Round', 2, 32); made.push(o);
            const nx = limit.intersect(o); made.push(nx);
            limit = nx;
          }
        }
        const out = [];
        const isl = face.decompose(); for (const q of isl) made.push(q);
        for (const I of isl) {
          const area = I.area();
          if (area < 1e-9) continue;
          let room = null;
          if (limit) { const o = I.offset(-keep, 'Round', 2, 32); made.push(o); room = o.intersect(limit); made.push(room); }
          const ra = room ? room.area() : 0;
          out.push({ area, room: ra, polys: ra > 1e-12 ? room.toPolygons().map(p => p.map(q => [q[0], q[1]])) : [] });
        }
        return out;
      } finally { free(made); }
    },
    /**
     * 先挖插銷孔（以刀面為中心、往兩邊各 `depth`），再照刀切開；每一格裡分開的也拆開。
     * @param {{a:number, p:number[], r:number, depth:number}[]} socks 孔（世界座標、半徑已含間隙）
     * @param {number[][]} cuts 三個軸各自的刀的位置
     * @returns {{pieces:Mesh[], socketVol:number}}
     */
    split(socks, cuts) {
      const made = [];
      try {
        let cur = body;
        if (socks.length) {
          const cyl = socks.map(s => {
            const c0 = w.Manifold.cylinder(2 * s.depth, s.r, s.r, 32, true); made.push(c0);
            const c1 = s.a === 0 ? c0.rotate([0, 90, 0]) : s.a === 1 ? c0.rotate([90, 0, 0]) : c0; if (c1 !== c0) made.push(c1);
            const c2 = c1.translate(s.p); made.push(c2);
            return c2;
          });
          const all = w.Manifold.union(cyl); made.push(all);
          cur = w.Manifold.difference(body, all); made.push(cur);
        }
        const socketVol = body.volume() - cur.volume();
        let parts = [cur];
        for (let a = 0; a < 3; a++) for (const c of cuts[a] || []) {
          const nrm = [0, 0, 0]; nrm[a] = 1;
          const next = [];
          for (const p of parts) for (const q of p.splitByPlane(nrm, c)) { made.push(q); if (!q.isEmpty()) next.push(q); }
          parts = next;
        }
        const pieces = [];
        for (const p of parts) for (const q of p.decompose()) { made.push(q); if (!q.isEmpty()) pieces.push(fromManifold(q)); }
        return { pieces, socketVol };
      } finally { free(made); }
    },
    close() { free([...new Set([...turned, body])]); }
  };
}

/** 插銷本身（另外印）：⌀ 2r、長 len 的圓柱，軸朝 Y（世界座標）、中心在 `at`；兩頭倒角 `ch`（好插進去） */
export function dowelMesh(r, len, at, ch = 0) {
  const w = need();
  const made = [];
  try {
    const seg = 32;
    let m;
    if (ch > 0 && len > 2 * ch && r > ch) {
      const mid = w.Manifold.cylinder(len - 2 * ch, r, r, seg, true); made.push(mid);
      const top = w.Manifold.cylinder(ch, r, r - ch, seg, false); made.push(top);
      const topT = top.translate([0, 0, (len - 2 * ch) / 2]); made.push(topT);
      const bot = w.Manifold.cylinder(ch, r - ch, r, seg, false); made.push(bot);
      const botT = bot.translate([0, 0, -len / 2]); made.push(botT);
      m = w.Manifold.union([mid, topT, botT]); made.push(m);
    } else { m = w.Manifold.cylinder(len, r, r, seg, true); made.push(m); }
    const up = m.rotate([-90, 0, 0]); made.push(up);
    const at2 = up.translate(at); made.push(at2);
    return fromManifold(at2);
  } finally {
    for (const x of made) { try { x.delete(); } catch (e) { /* 已釋放過，忽略 */ } }
  }
}

/**
 * 🔴 **干涉檢查：兩個實體重疊的那一塊**（綜合評估 ④-20，2026-10-20，kang「照建議」）。
 * 放在這裡的理由同 `unionMeshes()`：只有這個檔可以碰 Manifold。⚠ 兩個都要是**世界座標、封閉**的網格
 * （板件先照板厚加厚 —— `core/interfere.js` `solidForClash()`）。
 * @returns {{mesh: Mesh|null, volume: number}} 沒重疊 ⇒ `mesh` 是 null、體積 0
 */
export function overlapOf(meshA, meshB, labelA = '第一個', labelB = '第二個') {
  const { Manifold } = need();
  const made = [];
  try {
    const a = toManifold(meshA, labelA); made.push(a);
    const b = toManifold(meshB, labelB); made.push(b);
    const inn = Manifold.intersection(a, b); made.push(inn);
    if (inn.isEmpty()) return { mesh: null, volume: 0 };
    const m = fromManifold(inn);
    return { mesh: m, volume: Math.abs(m.volume()) };
  } finally {
    for (const m of made) {
      try { m.delete(); } catch (e) { /* 已釋放過，忽略 */ }
    }
  }
}

/**
 * 只做結構檢查，不真的運算。介面在按鈕按下去之前先問一次，
 * 才能給「板件不能布林」這種看得懂的提示，而不是跳一堆英文。
 *
 * @returns {{ok:boolean, reason:string}}
 */
export function canBool(meshes, names = []) {
  if (!csgReady()) {
    return { ok: false, reason: '布林運算函式庫還沒載入完成' };
  }
  if (meshes.length < 2) {
    return { ok: false, reason: '布林運算至少要選兩個物件' };
  }
  for (let i = 0; i < meshes.length; i++) {
    if (!meshes[i].validate().closed) {
      return {
        ok: false,
        reason: `「${names[i] || '第 ' + (i + 1) + ' 個'}」是開放的板件，不能做布林運算`
      };
    }
  }
  return { ok: true, reason: '' };
}
