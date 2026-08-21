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
 * ── 版本相容 ────────────────────────────────────────
 * 每個檔案都帶 v 版本號，讀檔一律走 migrate()。
 * 現在只有 v1，但這個關卡從第一天就要在，
 * 不然等到有 v2 時，舊檔就打不開了。
 */

import * as THREE from 'three';
import { Mesh } from './mesh.js';
import { buildPrim, PRIM_DEFAULTS } from '../build/prim.js';

export const DOC_TYPE = 'model-doc';
export const DOC_VERSION = 1;
export const UNIT = 'cm';

/** 物件種類。sheet 是要拿去展開的板件，solid 是有體積的量體。 */
export const KIND = {
  SOLID: 'solid',
  SHEET: 'sheet'
};

let _oid = 1;

// ═══════════════════════════════════════════════════════
//  單一物件
// ═══════════════════════════════════════════════════════

export class ModelObject {
  constructor(opts = {}) {
    this.id = opts.id ?? _oid++;
    this.name = opts.name ?? '物件';
    this.kind = opts.kind ?? KIND.SOLID;

    /**
     * 來源。兩種可能：
     *   { type:'box', w, h, d }        參數物件 —— 可以回頭改參數
     *   { type:'mesh' }                已烘成網格 —— 參數回不去了
     */
    this.src = opts.src ?? { type: 'box', ...PRIM_DEFAULTS.box };

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

  /** 取得半邊網格。參數物件會在第一次要用時才生成。 */
  mesh() {
    if (!this._mesh) this._mesh = buildPrim(this.src.type, this.src);
    return this._mesh;
  }

  /** 改了參數之後要呼叫，讓網格重新生成 */
  invalidate() {
    if (this.isParametric) this._mesh = null;
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
      src: { ...this.src },
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
 * 現在只有 v1，所以看起來多此一舉 —— 但這個關卡必須從第一天就在。
 * 等到真的有 v2 的時候才補，舊檔就已經打不開了。
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
  // if (v < 2) { ...把 v1 補成 v2... }

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
