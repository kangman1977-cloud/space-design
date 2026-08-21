/**
 * io.js — 文件模型與存讀檔格式
 *
 * ── 格式哲學（跟 assembly-system 同一套）────────────
 * 存「參數」而不是存「烤熟的三角形」。
 * 一個方塊存的是 {type:'box', w:60, h:45, d:40}，不是 12 個三角形的座標。
 * 好處：檔案小、看得懂、而且日後可以回頭把 60 改成 80 重新生成。
 *
 * 只有「已經被布林或面編輯改過、回不去參數」的物件，才存網格。
 * 這對應 Blender 的 .blend 跟 .obj 的差別 —— 我們主要存前者。
 *
 * 第 2 期的布林運算走的是同一套：挖了孔之後存的是
 * 「方塊 減去 圓柱」這件事，不是挖完的三角形，所以還能回頭改孔徑。
 *
 * ── 版本相容 ────────────────────────────────────────
 * 每個檔案都帶 v 版本號，讀檔一律走 migrate()。
 * v1（第 1 期）→ v2（布林運算樹）→ v3（陣列與鏡射）。
 * 新版讀得動所有舊檔：舊版本的年代還沒有那些功能，
 * 檔案裡不可能出現對應的 type，沒有東西要補。
 */

import * as THREE from 'three';
import { Mesh } from './mesh.js';
import { buildPrim, PRIM_DEFAULTS } from '../build/prim.js';
import { evalBoolTree, isBoolSrc, makeItem, itemMatrix }
  from '../build/bool.js';
import { evalArrayTree, isArraySrc, arrayMatrices, copyCount,
         ARRAY_MODES, ARRAY_DEFAULTS } from '../build/array.js';

export const DOC_TYPE = 'model-doc';
export const DOC_VERSION = 3;
export const UNIT = 'cm';

/** 物件種類。sheet 是要拿去展開的板件，solid 是有體積的量體。 */
export const KIND = {
  SOLID: 'solid',
  SHEET: 'sheet'
};

let _oid = 1;

// ═══════════════════════════════════════════════════════
//  由 src 生成網格
// ═══════════════════════════════════════════════════════

/** src 是純資料，深拷貝直接走 JSON 就夠，不會有函式或循環參照 */
export function cloneSrc(src) {
  return JSON.parse(JSON.stringify(src));
}

/**
 * 一個 src → 一個半邊網格。這是唯一的生成入口。
 *
 * 四種 src：
 *   {type:'box', w,h,d}            參數體 → prim.js
 *   {type:'bool', op, items}       布林運算樹 → bool.js
 *   {type:'array', mode, child}    陣列／鏡射 → array.js
 *   {type:'mesh', mesh:{...}}      已烘好的網格，照原樣還原
 *
 * 遞迴是把 buildSrc 自己當參數傳下去完成的。所以
 * 「挖好孔的板子排成一排」與「一排孔拿去挖穿板子」都做得到，
 * 而且 bool.js / array.js 都不必認識 box、cylinder 是什麼，
 * io.js 也不必認識 Manifold —— 各做各的，不互相 import。
 */
export function buildSrc(src) {
  if (!src || !src.type) throw new Error('物件沒有來源資料');

  if (isBoolSrc(src)) return evalBoolTree(src, buildSrc);
  if (isArraySrc(src)) return evalArrayTree(src, buildSrc);

  if (src.type === 'mesh') {
    if (src.mesh) return Mesh.fromJSON(src.mesh);
    throw new Error('這個網格物件沒有幾何資料');
  }

  return buildPrim(src.type, src);
}

/** 出事時的替身：一個小方塊，讓畫面不會整個掛掉 */
function placeholderMesh() {
  return buildPrim('box', { w: 10, h: 10, d: 10 });
}

// ═══════════════════════════════════════════════════════
//  單一物件
// ═══════════════════════════════════════════════════════

export class ModelObject {
  constructor(opts = {}) {
    this.id = opts.id ?? _oid++;
    this.name = opts.name ?? '物件';
    this.kind = opts.kind ?? KIND.SOLID;

    /**
     * 來源。三種可能：
     *   { type:'box', w, h, d }        參數物件 —— 可以回頭改參數
     *   { type:'bool', op, items }     布林運算樹 —— 可以回頭改運算元的參數
     *   { type:'mesh' }                已烘成網格 —— 參數回不去了
     */
    this.src = opts.src ?? { type: 'box', ...PRIM_DEFAULTS.box };

    /**
     * 上次生成網格時的錯誤訊息，沒問題就是 null。
     * 布林運算可能失敗（函式庫沒載到、物件沒重疊到），
     * 但生成網格是在畫面更新途中被呼叫的 —— 若在這裡讓例外往外丟，
     * 整個介面會變白畫面。所以一律接住，改成畫面上的一行提示。
     */
    this.error = null;

    this.pos = opts.pos ? opts.pos.clone() : new THREE.Vector3();
    this.rot = opts.rot ? opts.rot.clone() : new THREE.Euler();
    this.scale = opts.scale ? opts.scale.clone() : new THREE.Vector3(1, 1, 1);

    this.color = opts.color ?? 0x6fa8dc;
    /** 板厚，單位 cm。只有 sheet 用得到，展開時算折彎補償要靠它。 */
    this.thickness = opts.thickness ?? 0.2;
    /** 縮放鎖定。帶料表的精確件不該被隨手拉大，跟 system 物件同樣的道理。 */
    this.lockScale = opts.lockScale ?? false;

    this._mesh = opts.mesh ?? null;   // 快取；參數物件是算出來的
  }

  get isParametric() { return this.src.type !== 'mesh'; }

  /** 這個物件是不是布林運算的結果 */
  get isBool() { return isBoolSrc(this.src); }

  /** 這個物件是不是陣列／鏡射 */
  get isArray() { return isArraySrc(this.src); }

  /**
   * 這個物件由幾份相同的東西組成。不是陣列就是 1。
   * 第 3 期展開要靠它出「一張圖 ×N」，第 8 期匯出備料也用得到。
   */
  get copies() { return this.isArray ? copyCount(this.src) : 1; }

  /**
   * 取得半邊網格。參數物件與布林物件會在第一次要用時才生成，
   * 生成完存在 _mesh 快取，改參數時由 invalidate() 清掉。
   *
   * 生成失敗不丟例外 —— 呼叫它的是畫面更新流程，丟出去就白畫面。
   * 改成記在 this.error，並退回一個看得到的替身。
   */
  mesh() {
    if (this._mesh) return this._mesh;

    try {
      this._mesh = buildSrc(this.src);
      this.error = null;
    } catch (e) {
      this.error = e.message || String(e);
      this._mesh = this._fallbackMesh();
    }
    return this._mesh;
  }

  /**
   * 布林算不出來時的替身：先試「第一個運算元」——
   * 那通常就是被挖孔的母體，看得出是哪個物件出問題。
   * 連它都失敗才退到小方塊。
   */
  _fallbackMesh() {
    // 布林 → 退回第一個運算元（通常就是被挖孔的母體）
    if (this.isBool && this.src.items && this.src.items.length) {
      try {
        const it = this.src.items[0];
        return buildSrc(it.src).transformed(itemMatrix(it));
      } catch (e) { /* 往下退 */ }
    }
    // 陣列 → 退回單獨一份，至少看得出原件長什麼樣
    if (this.isArray && this.src.child) {
      try {
        return buildSrc(this.src.child.src).transformed(itemMatrix(this.src.child));
      } catch (e) { /* 往下退 */ }
    }
    try { return placeholderMesh(); }
    catch (e) { return new Mesh(); }
  }

  /** 改了參數之後要呼叫，讓網格重新生成 */
  invalidate() {
    if (this.isParametric) { this._mesh = null; this.error = null; }
    return this;
  }

  /** 把參數物件轉成可自由編輯的網格（不可逆，跟 Blender 的 Convert to Mesh 一樣） */
  bake() {
    this.mesh();                 // 先確保算出來了
    this.src = { type: 'mesh' };
    return this;
  }

  matrix() {
    return new THREE.Matrix4().compose(
      this.pos,
      new THREE.Quaternion().setFromEuler(this.rot),
      this.scale
    );
  }

  toJSON() {
    const o = {
      id: this.id,
      name: this.name,
      kind: this.kind,
      // 一定要深拷貝：布林運算樹是巢狀的，淺拷貝會讓存下來的檔案
      // 跟記憶體裡的物件共用同一份 items，改一邊另一邊跟著動。
      // Undo 是靠 toJSON() 拍快照的，共用了就等於 Undo 失效。
      src: cloneSrc(this.src),
      pos: [r6(this.pos.x), r6(this.pos.y), r6(this.pos.z)],
      rot: [r6(this.rot.x), r6(this.rot.y), r6(this.rot.z)],
      scale: [r6(this.scale.x), r6(this.scale.y), r6(this.scale.z)],
      color: this.color,
      lockScale: this.lockScale
    };
    if (this.kind === KIND.SHEET) o.thickness = this.thickness;
    // 只有回不去參數的物件才需要把網格整包存下來
    if (!this.isParametric) o.mesh = this.mesh().toJSON();
    return o;
  }

  static fromJSON(d) {
    const o = new ModelObject({
      id: d.id,
      name: d.name,
      kind: d.kind,
      src: d.src,
      pos: new THREE.Vector3(...(d.pos || [0, 0, 0])),
      rot: new THREE.Euler(...(d.rot || [0, 0, 0])),
      scale: new THREE.Vector3(...(d.scale || [1, 1, 1])),
      color: d.color,
      thickness: d.thickness,
      lockScale: d.lockScale
    });
    if (d.mesh) o._mesh = Mesh.fromJSON(d.mesh);
    if (d.id >= _oid) _oid = d.id + 1;
    return o;
  }
}

const r6 = x => +Number(x).toFixed(6);

// ═══════════════════════════════════════════════════════
//  組運算樹
// ═══════════════════════════════════════════════════════

/**
 * 一個運算元要存進運算樹時的 src。
 * 已烘成網格的物件沒有參數可以重建，所以把網格資料整包帶進去。
 */
function srcForItem(obj) {
  if (obj.isParametric) return cloneSrc(obj.src);
  return { type: 'mesh', mesh: obj.mesh().toJSON() };
}

/**
 * 把幾個選取的物件組成一棵布林運算樹。
 *
 * ── 座標怎麼處理（這段最容易錯，寫清楚）──────────────
 * 結果物件直接**沿用第一個物件的位置與角度**，看起來就像
 * 「在 A 身上挖了一個洞」，A 不會莫名其妙跳走。
 *
 * 因此每個運算元存的是「相對於 A 的位置」，算法是
 *   相對變換 ＝ A的變換的反矩陣 × 自己的變換
 * A 自己算出來會是單位矩陣，符合直覺。
 *
 * 這樣之後移動整個結果物件時，孔會跟著母體一起走；
 * 而在面板上改某個運算元的位置，改的是它相對母體的位置。
 *
 * @param {ModelObject[]} objects 依選取順序，第一個是被減的母體
 * @param {string} op BOOL_OPS 之一
 */
export function boolSrcFrom(objects, op) {
  if (!objects || objects.length < 2) {
    throw new Error('布林運算至少要選兩個物件');
  }

  const base = objects[0];
  const inv = base.matrix().invert();

  const items = objects.map(o => {
    const local = new THREE.Matrix4().multiplyMatrices(inv, o.matrix());
    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    local.decompose(p, q, s);
    return makeItem(srcForItem(o), p, new THREE.Euler().setFromQuaternion(q), s, o.name);
  });

  return { type: 'bool', op, items };
}

// ═══════════════════════════════════════════════════════
//  組陣列
// ═══════════════════════════════════════════════════════

/**
 * 把一個物件變成陣列／鏡射。
 *
 * ── 預設值為什麼要看物件的大小 ──────────────────────
 * 如果間距寫死成 50cm，做一個 200cm 的橫料時三份會整個疊在一起，
 * 使用者第一眼看到的是「怎麼沒反應」。所以預設間距取
 * 「物件本身的尺寸 ＋ 10cm 空隙」，一按下去就看得出排開來了，
 * 再自己調成實際要的距離。
 *
 * 鏡射同理：對稱面預設放在物件的邊緣（offset ＝ 半個寬），
 * 所以鏡出來的那一份剛好貼著原件，一眼就懂鏡射在做什麼。
 * 要把對稱面移到機箱中心線之類的地方，改 offset 即可。
 *
 * @param {ModelObject} obj
 * @param {string} mode ARRAY_MODES 之一
 */
export function arraySrcFrom(obj, mode = ARRAY_MODES.LINEAR) {
  const size = obj.mesh().bounds().getSize(new THREE.Vector3());
  const gap = 10;
  const span = a => Math.max(a, 1) + gap;

  const node = {
    type: 'array',
    mode,
    ...cloneSrc(ARRAY_DEFAULTS[mode]),
    child: makeItem(srcForItem(obj), null, null, null, obj.name)
  };

  if (mode === ARRAY_MODES.LINEAR) {
    node.step = [+span(size.x).toFixed(3), 0, 0];
    node.step2 = [0, 0, +span(size.z).toFixed(3)];
  } else if (mode === ARRAY_MODES.MIRROR) {
    node.offset = +(size.x / 2).toFixed(3);
  } else if (mode === ARRAY_MODES.RADIAL) {
    // 繞物件自己的中心轉整圈，預設 8 份
    node.center = [0, 0, 0];
  }

  return node;
}

/**
 * 把陣列打散成一個個獨立物件。
 *
 * 資訊只能往下走：修飾器可以打散成獨立物件，獨立物件收不回修飾器。
 * 所以預設留在資訊多的那一端，需要各自微調時才打散。
 *
 * @returns {ModelObject[]} 尚未加進文件，由呼叫端決定怎麼放
 */
export function explodeArray(obj) {
  if (!obj.isArray) throw new Error('這個物件不是陣列');

  const node = obj.src;
  const mats = arrayMatrices(node);
  const childM = itemMatrix(node.child);
  const world = obj.matrix();

  return mats.map((m, i) => {
    // 世界變換 ＝ 物件本身 × 這一份的排列 × 子物件自己的擺放
    const full = new THREE.Matrix4()
      .multiplyMatrices(world, new THREE.Matrix4().multiplyMatrices(m, childM));

    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    full.decompose(p, q, s);

    return new ModelObject({
      name: `${obj.name} #${i + 1}`,
      kind: obj.kind,
      src: cloneSrc(node.child.src),
      pos: p,
      rot: new THREE.Euler().setFromQuaternion(q),
      scale: s,
      color: obj.color,
      thickness: obj.thickness,
      lockScale: obj.lockScale
    });
  });
}

// ═══════════════════════════════════════════════════════
//  整份文件
// ═══════════════════════════════════════════════════════

export class Doc {
  constructor() {
    this.head = { name: '未命名', date: today(), note: '' };
    this.objects = [];
  }

  add(obj) { this.objects.push(obj); return obj; }

  remove(obj) {
    const i = this.objects.indexOf(obj);
    if (i >= 0) this.objects.splice(i, 1);
    return this;
  }

  byId(id) { return this.objects.find(o => o.id === id) || null; }

  clear() { this.objects.length = 0; return this; }

  toJSON() {
    return {
      type: DOC_TYPE,
      v: DOC_VERSION,
      unit: UNIT,
      head: { ...this.head },
      objects: this.objects.map(o => o.toJSON())
    };
  }

  loadJSON(d) {
    const data = migrate(d);
    this.head = { ...this.head, ...(data.head || {}) };
    this.objects = (data.objects || []).map(ModelObject.fromJSON);
    return this;
  }

  static fromJSON(d) { return new Doc().loadJSON(d); }
}

function today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ═══════════════════════════════════════════════════════
//  版本轉換
// ═══════════════════════════════════════════════════════

/**
 * 把任何版本的檔案轉成目前版本。
 *
 * v1（第 1 期）→ v2（布林運算樹）→ v3（陣列與鏡射）
 * 這兩步都不用做任何事：舊版本的年代還沒有那些功能，
 * 檔案裡不可能出現 type:'bool' 或 type:'array'，
 * 其餘欄位的意義完全相同。
 * 之後若有真的要補欄位的版本，就寫在下面標示的地方。
 */
export function migrate(d) {
  if (!d || typeof d !== 'object') {
    throw new Error('這不是有效的檔案內容');
  }

  // 沒有 type 欄位的，可能是別的工具的檔案
  if (d.type && d.type !== DOC_TYPE) {
    throw new Error(`這是「${d.type}」格式的檔案，不是建模器的檔案`);
  }

  const v = d.v ?? 1;

  if (v > DOC_VERSION) {
    throw new Error(
      `檔案版本 v${v} 比這個程式（v${DOC_VERSION}）新，請更新程式後再開啟`
    );
  }

  // 單位防呆：日後若出現 mm 的檔案，在這裡換算，不要讓它默默混進來
  if (d.unit && d.unit !== UNIT) {
    throw new Error(`檔案單位是 ${d.unit}，這個程式只接受 ${UNIT}`);
  }

  // ── 未來的轉換寫在這裡 ──
  // v1 → v2 → v3 都不需要補任何欄位（見上方說明）
  // if (v < 4) { ...把 v3 補成 v4... }

  return d;
}

// ═══════════════════════════════════════════════════════
//  檔案讀寫
// ═══════════════════════════════════════════════════════

export function download(doc, filename) {
  const name = filename || `${doc.head.name || '未命名'}.json`;
  const blob = new Blob([JSON.stringify(doc.toJSON(), null, 1)],
    { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function openFile() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return reject(new Error('沒有選擇檔案'));
      const fr = new FileReader();
      fr.onload = () => {
        try { resolve(JSON.parse(String(fr.result))); }
        catch (e) { reject(new Error('檔案不是有效的 JSON：' + e.message)); }
      };
      fr.onerror = () => reject(new Error('讀取檔案失敗'));
      fr.readAsText(f);
    };
    input.click();
  });
}

// ── 自動暫存（跟現有兩個工具同樣的做法）──────────────
const AUTOSAVE_KEY = 'modeler_doc';

export function autosave(doc) {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(doc.toJSON()));
    return true;
  } catch (e) {
    return false;   // 私密瀏覽或空間滿了，不是致命錯誤
  }
}

export function loadAutosave() {
  try {
    const s = localStorage.getItem(AUTOSAVE_KEY);
    return s ? JSON.parse(s) : null;
  } catch (e) {
    return null;
  }
}
