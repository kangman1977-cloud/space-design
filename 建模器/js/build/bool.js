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
