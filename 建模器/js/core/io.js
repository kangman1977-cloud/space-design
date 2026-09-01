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
import { mergeCoplanarFaces, recenterMesh, shiftMeshOrigin } from './edit.js';
import { buildPrim, PRIM_DEFAULTS, shapeBounds, shiftShape, penBounds, shiftPenPaths }
  from '../build/prim.js';
import { evalBoolTree, isBoolSrc, makeItem, itemMatrix }
  from '../build/bool.js';
import { evalArrayTree, isArraySrc, arrayMatrices, copyCount,
         ARRAY_MODES, ARRAY_DEFAULTS } from '../build/array.js';

export const DOC_TYPE = 'model-doc';
export const DOC_VERSION = 4;
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
 *
 * ── 板厚為什麼要傳進來 ──────────────────────────────
 * 折板的中性面半徑 ＝ 內側 R ＋ K × 板厚，所以生成幾何要知道板厚。
 * 板厚是 ModelObject 的屬性，不是 src 的一部分（同一份參數換個板厚
 * 就是另一件事，不該有兩份各自為政的板厚）。
 * 遞迴時用閉包把它帶下去，bool.js 與 array.js 完全不必知道有這回事。
 *
 * @param {object} src
 * @param {number} t 板厚 cm，只有折板用得到
 */
export function buildSrc(src, t = 0) {
  if (!src || !src.type) throw new Error('物件沒有來源資料');

  if (isBoolSrc(src)) return evalBoolTree(src, s => buildSrc(s, t));
  if (isArraySrc(src)) return evalArrayTree(src, s => buildSrc(s, t));

  if (src.type === 'mesh') {
    if (src.mesh) return Mesh.fromJSON(src.mesh);
    throw new Error('這個網格物件沒有幾何資料');
  }

  return buildPrim(src.type, src, t);
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
      this._mesh = buildSrc(this.src, this.thickness);
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
        return buildSrc(it.src, this.thickness).transformed(itemMatrix(it));
      } catch (e) { /* 往下退 */ }
    }
    // 陣列 → 退回單獨一份，至少看得出原件長什麼樣
    if (this.isArray && this.src.child) {
      try {
        return buildSrc(this.src.child.src, this.thickness)
          .transformed(itemMatrix(this.src.child));
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

  /**
   * 直接換掉網格。**拆掉重建型的編輯專用**（目前只有擠出面）。
   *
   * 拉點／拉邊／拉面是就地改頂點座標，網格物件不換人，所以不需要這一支。
   * 擠出面會新增頂點與面，只能整個重建，重建出來的是**另一個 Mesh 物件**。
   *
   * ⚠ 只對已經 `bake()` 過的網格物件有意義。參數物件換了也沒用 ——
   * `invalidate()` 或下次開檔就會照參數重生，改動靜靜消失。
   * 擋這件事是呼叫端的責任（跟分片用同一個 `canMarkSeams()` 判準）。
   */
  setMesh(m) {
    this._mesh = m;
    this.error = null;
    return this;
  }

  /**
   * 把參數物件轉成可自由編輯的網格（不可逆，跟 Blender 的 Convert to Mesh 一樣）。
   *
   * 🔴 **順便把三角化還原成多邊形**（2026-08-24 加）。
   *
   * ── 為什麼放在這裡，而不是給使用者一顆按鈕 ────────────────
   * 參數體全是跟 three.js 借的三角形（方塊 12 個、32 段圓柱 128 個），
   * 而使用者眼中方塊是 6 個面。那個落差平常由 `planarRegions()` 每次現算補掉，
   * **只有環切例外** —— 它要「從一條邊跨到對面那條邊」，而三角形沒有「對面」。
   *
   * 本來做成一顆「面合併」按鈕，**那是錯的判斷**：
   * 它按下去**畫面上沒有任何地方會變**（線框畫的是送給顯示卡的三角形，
   * 而 GPU 只吃三角形，四邊形一定會被拆開；稜線檢視則兩邊都濾掉共面的邊）。
   * 一個看不出作用的按鈕就是坑第 21 條 —— kang 實測當場被它騙到。
   *
   * **它是程式內部的整理，不是使用者的功能。** 而「轉成可編輯網格」
   * 的意思本來就是「從現在起這是一個可以自由編輯的網格」——
   * 順手整理乾淨完全合理，而且**它不改變幾何**（體積面積實測精確不變）。
   *
   * ⚠ 併不動就維持原狀（環形區域、三角形其實不共面的區域），
   * 那是 `mergeCoplanarFaces()` 自己的兩道防護，這裡不必判斷。
   */
  bake() {
    const m = this.mesh();       // 先確保算出來了
    this.src = { type: 'mesh' };
    const r = mergeCoplanarFaces(m);
    if (r.ok) this._mesh = r.mesh;
    return this;
  }

  /**
   * 🔴🔴 **把板厚【烤進網格】，再變成網格物件**（2026-08-30，kang 問出來的）。
   *
   * > **他的原話：「平板與折板確實也可以轉成網格…但鈑件厚度並不受網格的控制」**
   *
   * ⚠ **跟 `bake()` 的差別只有一個**：先 `shell(thickness)`。
   * ⭐ `shell()` 是現成的 —— 畫面上顯示厚度、匯出 STL 走的都是同一支。
   *
   * ── 🔴 之後會變成什麼（【實證】2026-08-30 沙箱）──────────
   * 一片 100×60、板厚 1 的平板：
   *
   * | | 網格 | 展開出來的 |
   * |---|---|---|
   * | **之前** | 2 個面、⛔ 不封閉、體積 0 | **100 × 60**（輪廓 4 個點）|
   * | **之後** | 8 個面、封閉、體積 6000 | **202 × 260**（輪廓 12 個點）|
   *
   * 🔴 **展開⛔ 沒有「走不了」** —— ⚠ **只是攤出來的是【一個盒子】**：
   * 上下各一片 100×60 ＋ 四條 1 cm 寬的邊（202 ＝ 100＋1＋1＋100）。
   * ⭐ **那⛔ 不是壞掉** —— 想做「用紙板組的中空扁盒」的話，那正是要的東西。
   * 〔⚠ AI 一開始說「展開走不了」，那是**推論**；是 kang 質疑
   * 　「變成網格後我如果分片，不也是可以展開？」才量出真相〕
   *
   * ── ⭐ ⛔ 不必改 `kind`、也⛔ 不必清 `thickness` ──────────
   * 畫面（`scene.js` 的 `_shellThickness()`）與匯出（`exportPanel.js`）
   * **判的都是 `mesh.isClosed()`，⛔ 不是 `kind` 這個標籤** ——
   * 而 `shell()` 出來的**是封閉的**，所以**⛔ 不會被加厚第二次**。
   * 〔坑第 8、30 條：判斷依據用**幾何事實**，⛔ 不用使用者可改的標籤〕
   *
   * @returns {{ok:boolean, reason?:string, volume?:number, faces?:number}}
   */
  bakeShelled() {
    const t = Number(this.thickness) || 0;
    if (t <= 1e-6) {
      return { ok: false,
        reason: '板厚是 0 —— 先把上面的「板厚」填一個大於 0 的數字' };
    }
    const m = this.mesh();
    /**
     * ⚠ **封閉的東西本來就有厚度，再加厚只會多畫一層看不見的內殼** ——
     * 【實證見 `exportPanel.js` 檔頭】用標籤判斷會做出**兩個互不相連的盒子**。
     */
    if (m.isClosed()) {
      return { ok: false,
        reason: '這個物件本來就是封閉的實體，⛔ 不必加厚 —— 直接按「轉成可編輯網格」' };
    }
    let s;
    try { s = m.shell(t); }
    catch (e) { return { ok: false, reason: '加厚失敗：' + (e.message || String(e)) }; }
    this.src = { type: 'mesh' };
    const r = mergeCoplanarFaces(s);
    this._mesh = r.ok ? r.mesh : s;
    return { ok: true, volume: this._mesh.volume(), faces: this._mesh.faces.length };
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
/** 這個物件是不是「匯進來的線稿」，而且裡面不只一個形狀 */
export function canExplodeShapes(obj) {
  return !!(obj && obj.src && obj.src.type === 'extrude'
    && Array.isArray(obj.src.shapes) && obj.src.shapes.length > 1);
}

/**
 * 把一個匯入件拆成「一個形狀一個物件」。
 *
 * ── 為什麼需要這個 ──────────────────────────────────
 * 一份 SVG 預設可以合成一個物件（相對位置是在 Illustrator 排好的版面，
 * 合著才不會被動到）。但合著就沒辦法個別移動旋轉 ——
 * 日誌裡曾經寫「要拆的人可以用現成的『打散』」，**那句話是錯的**：
 * 打散當時只對陣列有效，匯入件按不到那顆按鈕。這裡把那個退路補上。
 *
 * **版面完全維持原樣**：每個新物件的原點放在它自己的中心
 * （所以 gizmo 在中心、旋轉縮放也繞著中心），
 * 位置則是它原本所在的地方，經過母物件的變換算到世界座標。
 */
export function explodeShapes(obj) {
  if (!canExplodeShapes(obj)) throw new Error('這個物件沒有多個形狀可以拆');

  const world = obj.matrix();

  return obj.src.shapes.map((s, i) => {
    const b = shapeBounds(s);
    // 形狀中心在母物件的本地座標；SVG 的 (x,y) 對應世界的 (x,z)
    const full = new THREE.Matrix4().multiplyMatrices(
      world, new THREE.Matrix4().makeTranslation(b.cx, 0, b.cy));

    const p = new THREE.Vector3();
    const q = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    full.decompose(p, q, sc);

    return new ModelObject({
      name: s.name ? `${obj.name}－${s.name}` : `${obj.name} #${i + 1}`,
      kind: obj.kind,
      src: {
        ...obj.src,
        shapes: [shiftShape(s, -b.cx, -b.cy)]      // 幾何置中，不靠搬物件抵銷
      },
      pos: p,
      rot: new THREE.Euler().setFromQuaternion(q),
      scale: sc,
      color: obj.color,
      thickness: obj.thickness,
      lockScale: obj.lockScale
    });
  });
}

/**
 * 🔴 **原點置中：把物件的原點搬到它自己的包圍盒中心，⛔ 而東西一格都不動。**
 *
 * ── 🔴 「原點置中」跟「幾何跳開」⛔ 不是同一件事 ────────────
 * 【這一則是 2026-08-29 翻掉一個既有誤解才寫的】
 * `separateSelected()` 的註解原本寫「位置刻意不動…跳開反而難對回去」，
 * **把兩件事綁在一起了**。⭐ 而**證明就在它自己拿來對照的 `explodeShapes()`**：
 * 那一支 `shiftShape(s, -b.cx, -b.cy)` 旁邊白紙黑字寫著
 * 「**幾何置中，⛔ 不靠搬物件抵銷**」——
 * **幾何往回移 −中心、`pos` 往前移 ＋中心，淨結果世界位置一格都沒變。**
 *
 * ── 🔴 為什麼一定要走矩陣，⛔ 不可以寫 `pos.add(center)` ────────
 * `center` 是**本地座標**，而 `pos` 是**世界座標**。
 * **物件只要有旋轉或縮放，兩者就對不起來** ——
 * 例如轉了 90 度，本地的 +Y 在世界是 +Z，直接相加會把東西搬到別的地方去。
 * ⭐ 所以照 `explodeShapes()` 那一招：
 * **`matrix() × translate(center)` 再 `decompose()`** —— 讓矩陣自己算。
 * 🔴 **測試釘著「rot ≠ 0 時世界包圍盒精確不變」，就是在守這一行。**
 *
 * ── ⚠ 它只對「網格物件」有意義 ──────────────────────────
 * 參數物件（還沒 `轉成可編輯網格`）的形狀是**照參數重新生成**的，
 * 改了頂點留不住。⛔ 所以參數物件擋下來，讓呼叫端講原因。
 *
 * @param {ModelObject} obj **就地修改**（網格與 pos／rot／scale 都會變）
 * @returns {{ok:boolean, reason?:string, moved?:boolean,
 *            offset?:THREE.Vector3}}
 */
/**
 * 🔴🔴 **呼叫端注意：這一支【就地改頂點座標】，⛔ 網格物件不會換人。**
 *
 * ⇒ **畫面那一半一定要自己喊 `view.markGeomDirty()`**，
 * 否則 `scene.js` 的 `_updateNode()` **察覺不到**（它只看「網格換人／
 * 板厚變了／有人喊 dirty」），而症狀⛔ 不是「沒反應」——
 * **是東西會整個跳走**：`obj.pos` 更新了但幾何還是舊的，
 * 那個位移沒有被抵銷。〔kang 2026-09-01 回報，實際發生過〕
 *
 * ⚠ 鋼筆那條路走 `invalidate()`（網格會換人），⛔ 不受這條影響。
 */
export function recenterOrigin(obj) {
  if (!obj) return { ok: false, reason: '沒有選到物件' };
  /**
   * 🔴 **鋼筆是參數物件，但它置得了中 —— 因為要搬的東西就是參數本身。**
   *
   * ⚠ **⛔ 這一段原本不存在，而那是一個 bug**〔kang 2026-08-29 回報：
   * 「鋼筆建立好的物件..XYZ 方向軸並沒有在物件中心」〕：
   * `finishPen()` 確實呼叫了這一支，**但它第一行就把 `pen` 當成
   * 「參數物件」擋掉了，什麼都沒做**，而且⛔ 沒有任何人看到那句 reason。
   *
   * ⭐ **擋參數物件本來是對的**（改頂點留不住，會被下次生成蓋掉）——
   * **錯的是把「所有參數物件」一視同仁**。鋼筆的形狀就是那串錨點，
   * **搬錨點 ＝ 搬參數 ＝ 留得住**。
   * 〔跟 `explodeShapes()` 搬輪廓是同一招：**幾何置中，⛔ 不靠搬物件抵銷**〕
   *
   * ⚠ **形狀座標的 (x, y) 對到世界的 (x, z)** —— 跟擠出件同一套對應。
   */
  if (obj.src && obj.src.type === 'pen') {
    const b = penBounds(obj.src.paths);
    if (!b.ok) return { ok: false, reason: '這支鋼筆還沒有畫出任何點' };
    if (Math.abs(b.cx) < 1e-9 && Math.abs(b.cy) < 1e-9) {
      return { ok: true, moved: false, offset: new THREE.Vector3() };
    }
    shiftPenPaths(obj.src.paths, -b.cx, -b.cy);
    obj.invalidate();
    const off = new THREE.Vector3(b.cx, 0, b.cy);
    const full = new THREE.Matrix4().multiplyMatrices(
      obj.matrix(), new THREE.Matrix4().makeTranslation(off.x, off.y, off.z));
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    full.decompose(p, q, sc);
    obj.pos.copy(p); obj.rot.setFromQuaternion(q); obj.scale.copy(sc);
    return { ok: true, moved: true, offset: off };
  }
  if (obj.src && obj.src.type !== 'mesh') {
    return { ok: false, reason: '這個物件還是參數物件 —— 先在右側面板按「轉成可編輯網格」' };
  }
  const mesh = obj.mesh();
  if (!mesh || !mesh.verts.length) return { ok: false, reason: '這個物件沒有幾何' };

  const r = recenterMesh(mesh);
  if (!r.moved) return { ok: true, moved: false, offset: r.offset };
  applyOriginShift(obj, r.offset);
  return { ok: true, moved: true, offset: r.offset };
}

/**
 * 🔴 **頂點搬完之後，把物件的變換補回去 —— 東西才會留在原地。**
 *
 * 🔴 **⛔ 不可以寫成 `obj.pos.add(offset)`**：`offset` 是**網格自己的**
 * 座標系的量，而物件可能**轉過角度、縮放過** —— 直接加到 `pos` 上
 * 等於把本地的量當成世界的量用，**物件會飛到別的地方**。
 * ⭐ 讓矩陣自己算：**原本的變換 × 往「本地的 offset」平移**。
 *
 * ⚠ 抽成一支是因為 `recenterOrigin()` 與 `setOriginTo()` 兩邊都要，
 * 而**同一條規則只寫一次**。
 */
function applyOriginShift(obj, offset) {
  const full = new THREE.Matrix4().multiplyMatrices(
    obj.matrix(),
    new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z));

  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  full.decompose(p, q, s);

  obj.pos.copy(p);
  obj.rot.setFromQuaternion(q);
  obj.scale.copy(s);
}

/**
 * 🔴🔴 **把原點搬到【你在畫面上點的那個地方】**
 * （2026-09-01，kang 要的；⛔ 不新增「基準點」那個狀態）。
 *
 * > **為什麼用「原點」⛔ 不另開一個基準點**：原點是**物件本來就有的資料**
 * > ⇒ 存檔、Undo、切換物件**全部免費**，而且**箭頭早就畫在原點上**。
 * > 另開一個狀態的話，上面每一條都要重新決定，還要想它畫成什麼樣子。
 *
 * ⚠ **⛔ 東西一格都不動**，只有原點（箭頭站的位置）換地方 ——
 * 跟 `recenterOrigin()` 是同一個承諾，也是同一段矩陣重算。
 *
 * ⚠ **⛔ 呼叫端記得 `view.markGeomDirty()`** —— 這一支**就地改頂點座標**，
 * 網格物件⛔ 不換人，畫面察覺不到〔2026-09-01 `原點置中` 實際踩過，
 * 規則的家在 `規格\建模器-核心架構.md`〕。
 *
 * @param {ModelObject} obj
 * @param {THREE.Vector3} worldPoint 你點到的那個位置（**世界座標**）
 */
export function setOriginTo(obj, worldPoint) {
  if (!obj) return { ok: false, reason: '沒有選到物件' };
  if (!worldPoint) return { ok: false, reason: '沒有點到東西' };

  /**
   * ⚠ **鋼筆這裡⛔ 不支援**（`recenterOrigin()` 支援它，因為那是「搬參數」）——
   * 這一支搬的是**頂點**，而鋼筆的形狀是那串錨點，改頂點留不住。
   * ⭐ 訊息要**講得出出路**〔坑第 11 條：講了問題就要給解法〕。
   */
  if (obj.src && obj.src.type !== 'mesh') {
    return {
      ok: false,
      reason: '這個物件還是參數物件 —— 先在右側面板按「轉成可編輯網格」'
    };
  }

  const mesh = obj.mesh();
  if (!mesh || !mesh.verts.length) return { ok: false, reason: '這個物件沒有幾何' };

  /**
   * 🔴 **世界座標 → 網格自己的座標系**（物件可能轉過、縮放過）。
   * ⛔ 不轉的話點在哪原點就跑到哪 —— 而那是**世界的那個位置**，
   * ⛔ 不是你點到的那個角。
   */
  const local = worldPoint.clone()
    .applyMatrix4(obj.matrix().clone().invert());

  const r = shiftMeshOrigin(mesh, local);
  if (!r.moved) return { ok: true, moved: false, offset: r.offset };

  applyOriginShift(obj, r.offset);
  return { ok: true, moved: true, offset: r.offset };
}

/**
 * 🔴 **鋼筆路徑：本地 → 世界**（`編輯路徑` 用，第 2 階段 2026-08-29）。
 *
 * ⚠ **形狀的 (x, y) 對到世界的 (x, z)** —— 跟擠出件、跟 `recenterOrigin()`
 * 裡那一段同一套對應。
 *
 * ⚠ **⛔ 這一支不處理旋轉**：呼叫它的時候物件已經被**暫時攤平**
 * （`rot` 歸零、`pos.y` 歸零）了，所以只剩 `pos` 與 `scale` 兩層。
 * 〔kang 2026-08-29 拍板：編輯時暫時把物件攤平〕
 *
 * ⚠ **已知限制**：非等比縮放（`scale.x ≠ scale.z`）時角度會被拉歪，
 * 所以「鎖角度」的度數跟畫面上量到的角度會差一點。
 * ⛔ 這是座標系本身的事，⛔ 不要為了它去動 `scale`。
 *
 * ⚠ **⛔ 寫在這裡而不是 `main.js`，是因為 `main.js` 碰 DOM 就測不到** ——
 * 而**往返要一個數字都不差**正是這一組最危險的地方。
 */
export function penPathToWorld(path, obj) {
  const sx = obj.scale.x, sz = obj.scale.z;
  const a = [], hi = [], ho = [];
  for (let i = 0; i < path.a.length; i += 2) {
    a.push(path.a[i] * sx + obj.pos.x, path.a[i + 1] * sz + obj.pos.z);
    hi.push(path.hi[i] * sx, path.hi[i + 1] * sz);
    ho.push(path.ho[i] * sx, path.ho[i + 1] * sz);
  }
  return { closed: true, a, hi, ho };
}

/**
 * 世界 → 本地（`penPathToWorld()` 的反向）。
 * ⚠ **縮放 0 除不得 → 回 `null`**，讓呼叫端擋下來講原因，
 * ⛔ 不要回一堆 `Infinity` 進去（那會安靜地毀掉整條路徑）。
 */
export function penPathToLocal(p, obj) {
  const sx = obj.scale.x, sz = obj.scale.z;
  if (Math.abs(sx) < 1e-9 || Math.abs(sz) < 1e-9) return null;
  const a = [], hi = [], ho = [];
  for (let i = 0; i < p.a.length; i += 2) {
    a.push((p.a[i] - obj.pos.x) / sx, (p.a[i + 1] - obj.pos.z) / sz);
    hi.push(p.hi[i] / sx, p.hi[i + 1] / sz);
    ho.push(p.ho[i] / sx, p.ho[i + 1] / sz);
  }
  return { closed: true, a, hi, ho };
}

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

/**
 * 🔴 **參考線：三個方向各一串公分數。**
 *
 * ── ⛔ 為什麼⛔ 不按「視角」分 ────────────────────────
 * kang 要的是「**針對每個視角做參考線**」，而在 3D 裡那件事會自己合併：
 * 一條螢幕上的線其實是**一個平面**，所以前視拉的直線（X＝某個數）
 * 跟上視拉的直線**是同一個東西**，只是從兩個方向看它。
 *
 * ⇒ 只有 **X／Y／Z 三種**，而每一種**同時出現在兩個視角裡**。
 * 〔kang 2026-08-31 拍板「共用」。完整推導在 `規格\建模器-參考線.md`〕
 *
 * ── ⚠ ⛔ 它不是物件 ──────────────────────────────
 * ⛔ 不進 `objects`、⛔ 不生網格、⛔ 不被展開、⛔ 不被 3D 列印檢查看到。
 * ⭐ 所以它**⛔ 不會踩到待辦裡「丙 只當參考線」那個卡點**
 * （那一條卡在「兩種 KIND 都會產生網格，會被誤報不封閉」）。
 */
export const GUIDE_AXES = ['x', 'y', 'z'];

/** 空的三串。⚠ 每次都要新的物件，⛔ 不可以共用同一份（會被兩個 Doc 共寫） */
export function emptyGuides() {
  return { x: [], y: [], z: [] };
}

/**
 * 把讀進來的東西整成乾淨的三串：
 * 只留有限的數字、排序、**去掉重複**。
 *
 * ⚠ **去重是必要的，⛔ 不是潔癖**：兩條疊在同一個位置的線，
 * 畫面上**看起來只有一條**，而下拉裡會出現兩列一模一樣的選項 ——
 * 使用者刪掉一條會發現「線還在」，那看起來就是壞掉。
 */
export function normalizeGuides(raw) {
  const out = emptyGuides();
  if (!raw || typeof raw !== 'object') return out;
  for (const ax of GUIDE_AXES) {
    const arr = Array.isArray(raw[ax]) ? raw[ax] : [];
    const seen = new Set();
    for (const v of arr) {
      /**
       * 🔴🔴 **⛔ 不可以只寫 `Number.isFinite(Number(v))`。**
       *
       * ⚠ `Number(null)` 是 **0**、`Number('')` 也是 **0**、
       * `Number(true)` 是 **1** —— 而 **0 是完全合法的參考線位置**
       * （原點那一條），所以⛔ 沒有辦法用「值等於 0」把它們濾掉。
       * ⇒ 一個 `null` 會**安靜地變成一條在原點的線**。
       *
       * 【實證 2026-08-31】這是**測試抓到的**，⛔ 不是我想到的 ——
       * 我原本寫的就是 `Number(v)` 那一版，而它在 `{x:[..., null, ...]}`
       * 上多長出一條 `0`。
       *
       * ✅ 正解是**先看型別再轉**：只有數字、以及去掉空白後⛔ 不是空的字串
       * 才有資格被轉換。
       */
      const n = typeof v === 'number' ? v
        : (typeof v === 'string' && v.trim() !== '') ? Number(v)
        : NaN;
      if (!Number.isFinite(n)) continue;
      // 對到 0.001 cm ＝ 10 微米。比這更近的兩條線⛔ 沒有人分得出來
      const k = Math.round(n * 1000);
      if (seen.has(k)) continue;
      seen.add(k);
      out[ax].push(k / 1000);
    }
    out[ax].sort((a, b) => a - b);
  }
  return out;
}

export class Doc {
  constructor() {
    this.head = { name: '未命名', date: today(), note: '' };
    this.objects = [];
    /** 參考線。⚠ 它跟 `objects` 平行，⛔ 不是 objects 的一種 */
    this.guides = emptyGuides();
  }

  add(obj) { this.objects.push(obj); return obj; }

  remove(obj) {
    const i = this.objects.indexOf(obj);
    if (i >= 0) this.objects.splice(i, 1);
    return this;
  }

  byId(id) { return this.objects.find(o => o.id === id) || null; }

  /**
   * ⚠ **`clear()` 刻意⛔ 不清參考線。**
   * 呼叫它的是「刪掉所有物件」那條路，而參考線是**版面的東西**，
   * ⛔ 不是模型的一部分 —— 把模型換掉、格線還在，才是使用者預期的。
   * 要清參考線有自己的一支：`clearGuides()`。
   */
  clear() { this.objects.length = 0; return this; }

  /** 加一條。回傳 true ＝ 真的加了，false ＝ 同一個位置已經有了 */
  addGuide(ax, v) {
    if (!GUIDE_AXES.includes(ax) || !Number.isFinite(v)) return false;
    const before = this.guides[ax].length;
    this.guides[ax] = normalizeGuides({ [ax]: [...this.guides[ax], v] })[ax];
    return this.guides[ax].length > before;
  }

  /** 刪一條。⚠ 用「最接近」找，⛔ 不用嚴格相等 —— 浮點數對不起來 */
  removeGuide(ax, v) {
    if (!GUIDE_AXES.includes(ax)) return false;
    const i = this.guides[ax].findIndex(g => Math.abs(g - v) < 5e-4);
    if (i < 0) return false;
    this.guides[ax].splice(i, 1);
    return true;
  }

  /** @param {string} [ax] 只清一個方向；不給就三個都清 */
  clearGuides(ax) {
    if (ax) { if (GUIDE_AXES.includes(ax)) this.guides[ax] = []; }
    else this.guides = emptyGuides();
    return this;
  }

  guideCount() {
    return GUIDE_AXES.reduce((n, ax) => n + this.guides[ax].length, 0);
  }

  /**
   * 🔴 **`guides` ⛔ 沒有跳版號，這是刻意的。**
   *
   * `migrate()` 只擋 `v > DOC_VERSION`，**多出來的欄位它不看** ——
   * 所以 v4 的檔案帶著 `guides` 存出去，**在還沒更新的程式上照樣開得起來**
   * （只是看不到參考線）。跳成 v5 反而會把舊分頁擋在門外。
   *
   * ⭐ 判準是這個專案自己立的：**v4 是第一個「真的要動資料」的版本**
   * （`migrateBendSrc` 把 `b.r` 換算成 `b.ri`），而這一次
   * ⛔ 不動任何既有欄位的意義。日後真的要改 `guides` 的形狀再跳。
   */
  toJSON() {
    return {
      type: DOC_TYPE,
      v: DOC_VERSION,
      unit: UNIT,
      head: { ...this.head },
      objects: this.objects.map(o => o.toJSON()),
      guides: normalizeGuides(this.guides)
    };
  }

  loadJSON(d) {
    const data = migrate(d);
    this.head = { ...this.head, ...(data.head || {}) };
    this.objects = (data.objects || []).map(ModelObject.fromJSON);
    /**
     * ⚠ **一定要走 `normalizeGuides()`，⛔ 不可以直接接手那個物件**：
     * ① 舊檔沒有這一欄（給空的）；
     * ② 別人手改過的檔可能塞字串或 null 進來；
     * ③ **⛔ 不重新指派的話，Undo 的快照會跟現在的 Doc 共用同一個陣列**
     *    —— 那會讓「復原」什麼都沒還原。
     */
    this.guides = normalizeGuides(data.guides);
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
 * 折板：v3 的 `r`（中性面半徑）→ v4 的 `ri`（內側圓角）＋ `k`（K 因子）
 *
 * ── 為什麼要換 ──────────────────────────────────────
 * 中性層是算出來的，現場量不到；師傅講「折 R3」、圖面標的、
 * 模具標的，全部都是**內側圓角**。存內側 R 才對得上現實。
 *
 * ── 幾何完全不變 ────────────────────────────────────
 * 換算走 ri ＝ r − K×t，生成時再算回 rn ＝ ri + K×t ＝ r，
 * 所以舊檔開起來形狀跟以前一模一樣，展開長度也一樣。
 * （測試裡有一項專門盯這件事。）
 *
 * ri 會被夾在 0 以上：板很厚而原本的 r 很小時算出負數，
 * 那代表這個舊檔的 r 本來就不可能是中性層半徑，當成尖角折最安全。
 */
function migrateBendSrc(src, t, k) {
  if (!src || typeof src !== 'object') return;

  if (src.type === 'bend' && Array.isArray(src.bends)) {
    if (src.k === undefined) src.k = k;
    for (const b of src.bends) {
      if (!b || b.ri !== undefined) continue;
      const r = Number(b.r) || 0;
      b.ri = r < 1e-9 ? 0 : Math.max(0, r - src.k * t);
      delete b.r;
    }
  }
  // 折板可能藏在布林運算樹或陣列裡
  if (Array.isArray(src.items)) for (const it of src.items) migrateBendSrc(it.src, t, k);
  if (src.child) migrateBendSrc(src.child.src, t, k);
}

/**
 * 把任何版本的檔案轉成目前版本。
 *
 * v1（第 1 期）→ v2（布林運算樹）→ v3（陣列與鏡射）
 * 這兩步都不用做任何事：舊版本的年代還沒有那些功能，
 * 檔案裡不可能出現 type:'bool' 或 type:'array'，
 * 其餘欄位的意義完全相同。
 *
 * v3 → v4（展開與 K 因子）是第一個真的要動資料的版本，見 migrateBendSrc。
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

  // v1 → v2 → v3 不需要補任何欄位（見上方說明）

  if (v < 4) {
    const K = PRIM_DEFAULTS.bend.k;
    for (const o of (d.objects || [])) {
      // 板厚沒寫的用 ModelObject 的預設值，跟不轉換時看到的形狀一致
      migrateBendSrc(o.src, Number(o.thickness) || 0.2, K);
    }
  }

  // ── 未來的轉換寫在這裡 ──
  // if (v < 5) { ...把 v4 補成 v5... }

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
