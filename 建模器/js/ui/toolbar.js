/**
 * toolbar.js — 右側面板（物件屬性 ＋ 結構分析）
 *
 * 「結構分析」那一區是第 1 期的重點展示。
 * 半邊結構、平面區域合併、曲率判定這些東西本身是看不見的，
 * 把它們的數字攤在面板上，才驗得出來到底有沒有做對 ——
 * 也順便預告了展開引擎將來會依據什麼做判斷。
 */

import { PRIM_SPECS, defaultSrc, PRIM_TYPES } from '../build/prim.js';
import { KIND } from '../core/io.js';
import { summarize, SURFACE } from '../core/region.js';
import { BOOL_OPS, BOOL_LABEL, BOOL_SYMBOL, isBoolSrc } from '../build/bool.js';

const SURFACE_TEXT = {
  [SURFACE.PLANAR]: '平面',
  [SURFACE.DEVELOPABLE]: '可展開（有精確解）',
  [SURFACE.NON_DEVELOPABLE]: '不可展開（需切分近似）'
};

export class Panel {
  /**
   * @param {object} app { doc, view, sel, hist, onEdit(label), onDirty() }
   */
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('panel');
    this.analysisCache = new Map();   // ModelObject.id → 分析結果
    /**
     * 布林運算樹裡哪些運算元是展開的。key 是「物件id:0.1.2」這種路徑。
     * 面板每次改動都整個重建，不記著的話一改參數就全部收合，很難用。
     */
    this.openItems = new Set();
    this._build();
  }

  _build() {
    this.root.innerHTML = `
      <section id="pObj">
        <h2>物件</h2>
        <div id="pEmpty" class="empty">還沒有選取物件<br><span>點一下畫面中的物件</span></div>
        <div id="pForm" hidden></div>
      </section>
      <section id="pAna">
        <h2>結構分析 <button id="anaRun" class="mini">重新計算</button></h2>
        <div id="anaBody" class="empty">選一個物件後按「重新計算」</div>
      </section>`;

    this.form = this.root.querySelector('#pForm');
    this.empty = this.root.querySelector('#pEmpty');
    this.anaBody = this.root.querySelector('#anaBody');
    this.root.querySelector('#anaRun').onclick = () => this.analyse(true);
  }

  // ═══════════════════════════════════════════════════
  //  物件屬性
  // ═══════════════════════════════════════════════════

  refresh() {
    const obj = this.app.sel.active;
    const many = this.app.sel.count > 1;

    if (!obj) {
      this.empty.hidden = false;
      this.empty.innerHTML = '還沒有選取物件<br><span>點一下畫面中的物件</span>';
      this.form.hidden = true;
      this.anaBody.className = 'empty';
      this.anaBody.textContent = '選一個物件後按「重新計算」';
      return;
    }

    this.empty.hidden = true;
    this.form.hidden = false;
    this.form.innerHTML = '';
    this._target = this.form;      // 表單元件預設加到這裡；巢狀區塊會暫時換掉

    // 網格生成失敗（多半是布林算不出來）先講清楚，再讓人去改參數
    if (obj.error) {
      this.form.appendChild(bad('這個物件目前算不出來：' + obj.error));
    }

    if (many) {
      this.form.appendChild(note(`已選 ${this.app.sel.count} 個，以下編輯最後選的「${obj.name}」`));
    }

    this._rowText('名稱', obj.name, v => { obj.name = v; this._edit('改名稱'); });

    this._rowSelect('種類', obj.kind, [
      [KIND.SOLID, '實體 solid'],
      [KIND.SHEET, '板件 sheet']
    ], v => {
      obj.kind = v;
      this._edit('改種類');
    }, '板件是要拿去展開的東西（有厚度、可折彎）；實體是有體積的量體');

    if (obj.kind === KIND.SHEET) {
      this._rowNum('板厚 cm', obj.thickness, { min: 0.01, step: 0.1 }, v => {
        obj.thickness = v; this._edit('改板厚');
      }, '展開時算折彎補償要用');
    }

    // ── 參數（可回頭改的才有）──
    if (obj.isBool) {
      this._boolSection(obj);
      this._rowBtn('凍結成網格',
        '把目前算出來的形狀固定下來。之後開檔不用再算一次布林（快很多），' +
        '但就不能再回頭改孔徑或位置了。確定不會再改的模型才凍結。', () => {
          if (!confirm('凍結之後就不能再改運算元的參數了，確定嗎？')) return;
          obj.bake();
          this._edit('凍結成網格');
        });

    } else if (obj.isParametric) {
      const spec = PRIM_SPECS[obj.src.type];
      if (spec) {
        this.form.appendChild(head(spec.label + ' 參數'));
        for (const f of spec.fields) {
          this._rowNum(f.label, obj.src[f.key], f, v => {
            obj.src[f.key] = f.int ? Math.round(v) : v;
            obj.invalidate();
            this.analysisCache.delete(obj.id);
            this._edit('改' + f.label);
          });
        }
        this._rowBtn('轉成可編輯網格', '不可逆。轉了之後就不能再改上面的參數，但可以做面編輯', () => {
          obj.bake();
          this._edit('轉成網格');
        });
      }
    } else {
      this.form.appendChild(note('這個物件已經是網格，沒有參數可以改'));
    }

    // ── 位置 ──
    this.form.appendChild(head('位置 cm'));
    this._rowVec3(obj.pos, ['X', 'Y', 'Z'], () => this._edit('改位置'));

    this.form.appendChild(head('旋轉 度'));
    this._rowVec3(obj.rot, ['X', 'Y', 'Z'], () => this._edit('改旋轉'), true);

    this.form.appendChild(head('縮放 倍'));
    this._rowVec3(obj.scale, ['X', 'Y', 'Z'], () => this._edit('改縮放'), false,
      obj.lockScale);

    this._rowCheck('鎖定縮放', obj.lockScale, v => {
      obj.lockScale = v;
      this._edit(v ? '鎖定縮放' : '解除鎖定');
    }, '鎖定後不給縮放把手。帶料表的精確件應該鎖住，避免圖面與實際用料不符');

    this._rowColor('顏色', obj.color, v => { obj.color = v; this._edit('改顏色'); });
  }

  _edit(label) {
    this.app.onEdit(label);
    this.refresh();
  }

  // ═══════════════════════════════════════════════════
  //  布林運算樹
  // ═══════════════════════════════════════════════════

  /**
   * 顯示「這個形狀是怎麼算出來的」，並讓每個運算元都能就地改參數。
   *
   * 這是「存運算樹而不是存三角形」真正的價值所在 ——
   * 挖完孔之後老闆說孔要改大，在這裡把半徑一改就好，不必重做。
   */
  _boolSection(obj) {
    const src = obj.src;
    this.form.appendChild(head('布林運算'));

    const wrap = document.createElement('div');
    wrap.className = 'tree';
    this.form.appendChild(wrap);

    // 運算方式可以事後改：挖錯了想改成合併，不用重來
    const opRow = document.createElement('div');
    opRow.className = 'op';
    const lab = document.createElement('label');
    lab.textContent = '運算方式';
    lab.title = '差集＝從第一個挖掉其餘的；聯集＝合成一個；交集＝只留重疊處';
    const sel = document.createElement('select');
    for (const v of [BOOL_OPS.SUBTRACT, BOOL_OPS.UNION, BOOL_OPS.INTERSECT]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = `${BOOL_SYMBOL[v]}　${BOOL_LABEL[v]}`;
      if (v === src.op) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      src.op = sel.value;
      this._rebuild(obj, '改成' + BOOL_LABEL[sel.value]);
    };
    opRow.append(lab, sel);
    wrap.appendChild(opRow);

    this._boolItems(obj, src, wrap, String(obj.id));
  }

  /**
   * 列出一層的運算元。item.src 本身也可能是布林，所以這裡是遞迴的 ——
   * 「先挖孔再跟別的合併」這種巢狀結構才能一路改到底。
   *
   * @param {string} path 展開狀態的記憶用鍵，形如 "12:0:1"
   */
  _boolItems(obj, node, parent, path) {
    const items = node.items || [];

    items.forEach((it, i) => {
      const key = `${path}:${i}`;
      const open = this.openItems.has(key);

      const box = document.createElement('div');
      box.className = 'item';

      // ── 標頭：第一個是母體，其餘掛上運算符號 ──
      const headEl = document.createElement('div');
      headEl.className = 'itemHead';

      const sym = document.createElement('span');
      sym.className = 'sym';
      sym.textContent = i === 0 ? '' : BOOL_SYMBOL[node.op] || '?';

      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = it.name || `運算元 ${i + 1}`;

      const dims = document.createElement('span');
      dims.className = 'dims';
      dims.textContent = describeSrc(it.src);

      const caret = document.createElement('span');
      caret.className = 'caret';
      caret.textContent = open ? '▾' : '▸';

      headEl.append(sym, nm, dims, caret);
      headEl.onclick = () => {
        if (open) this.openItems.delete(key); else this.openItems.add(key);
        this.refresh();
      };
      box.appendChild(headEl);

      // ── 展開後的內容 ──
      if (open) {
        const body = document.createElement('div');
        body.className = 'itemBody';
        box.appendChild(body);

        const prev = this._target;
        this._target = body;

        if (isBoolSrc(it.src)) {
          body.appendChild(note(`巢狀布林（${BOOL_LABEL[it.src.op] || it.src.op}，`
            + `${(it.src.items || []).length} 個運算元）`));
          this._boolItems(obj, it.src, body, key);

        } else if (it.src.type === 'mesh') {
          body.appendChild(note('這個運算元已經是網格，沒有參數可以改'));

        } else {
          const spec = PRIM_SPECS[it.src.type];
          if (spec) {
            for (const f of spec.fields) {
              this._rowNum(f.label, it.src[f.key], f, v => {
                it.src[f.key] = f.int ? Math.round(v) : v;
                this._rebuild(obj, '改' + f.label);
              });
            }
          }
        }

        // 位置與角度是相對於第一個運算元（母體）的，所以孔會跟著母體一起走
        this._rowArr3('位置 cm', it.pos, ['X', 'Y', 'Z'], false,
          () => this._rebuild(obj, '改運算元位置'),
          i === 0 ? '這是母體，位置固定在原點' : '相對於母體的位置');
        this._rowArr3('旋轉 度', it.rot, ['X', 'Y', 'Z'], true,
          () => this._rebuild(obj, '改運算元角度'));

        this._target = prev;
      }

      parent.appendChild(box);
    });
  }

  /** 運算樹被改過 → 清掉快取重算，然後照一般編輯流程走 */
  _rebuild(obj, label) {
    obj.invalidate();
    this.analysisCache.delete(obj.id);
    this._edit(label);
  }

  // ── 表單元件 ──────────────────────────────────────

  _row(label, hint) {
    const r = document.createElement('div');
    r.className = 'row';
    const l = document.createElement('label');
    l.textContent = label;
    if (hint) l.title = hint;
    r.appendChild(l);
    (this._target || this.form).appendChild(r);
    return r;
  }

  _rowText(label, val, on) {
    const r = this._row(label);
    const i = document.createElement('input');
    i.type = 'text';
    i.value = val;
    i.onchange = () => on(i.value);
    r.appendChild(i);
  }

  _rowNum(label, val, opt, on, hint) {
    const r = this._row(label, hint);
    const i = document.createElement('input');
    i.type = 'number';
    i.value = round(val);
    if (opt.min !== undefined) i.min = opt.min;
    if (opt.max !== undefined) i.max = opt.max;
    i.step = opt.step ?? 1;
    // 用 change 而不是 input：逐字觸發會讓每打一個字就重建一次網格
    i.onchange = () => {
      const v = parseFloat(i.value);
      if (Number.isFinite(v)) on(v);
    };
    r.appendChild(i);
  }

  _rowVec3(vec, labels, on, degrees = false, disabled = false) {
    const r = document.createElement('div');
    r.className = 'row vec';
    for (const k of ['x', 'y', 'z']) {
      const wrap = document.createElement('div');
      const s = document.createElement('span');
      s.textContent = labels[['x', 'y', 'z'].indexOf(k)];
      const i = document.createElement('input');
      i.type = 'number';
      i.step = degrees ? 5 : 1;
      i.disabled = disabled;
      i.value = round(degrees ? vec[k] * 180 / Math.PI : vec[k]);
      i.onchange = () => {
        const v = parseFloat(i.value);
        if (!Number.isFinite(v)) return;
        vec[k] = degrees ? v * Math.PI / 180 : v;
        on();
      };
      wrap.append(s, i);
      r.appendChild(wrap);
    }
    (this._target || this.form).appendChild(r);
  }

  /**
   * 跟 _rowVec3 一樣，但資料是純陣列 [x,y,z]（運算樹裡存的就是陣列，
   * 不是 THREE.Vector3，因為它要能直接寫進 JSON）。
   */
  _rowArr3(label, arr, labels, degrees, on, hint) {
    if (!Array.isArray(arr)) return;
    if (label) {
      const cap = document.createElement('div');
      cap.className = 'sub';
      cap.textContent = label;
      if (hint) cap.title = hint;
      (this._target || this.form).appendChild(cap);
    }
    const r = document.createElement('div');
    r.className = 'row vec';
    if (hint) r.title = hint;
    for (let k = 0; k < 3; k++) {
      const wrap = document.createElement('div');
      const s = document.createElement('span');
      s.textContent = labels[k];
      const i = document.createElement('input');
      i.type = 'number';
      i.step = degrees ? 5 : 1;
      i.value = round(degrees ? arr[k] * 180 / Math.PI : arr[k]);
      i.onchange = () => {
        const v = parseFloat(i.value);
        if (!Number.isFinite(v)) return;
        arr[k] = degrees ? v * Math.PI / 180 : v;
        on();
      };
      wrap.append(s, i);
      r.appendChild(wrap);
    }
    (this._target || this.form).appendChild(r);
  }

  _rowSelect(label, val, opts, on, hint) {
    const r = this._row(label, hint);
    const s = document.createElement('select');
    for (const [v, t] of opts) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      if (v === val) o.selected = true;
      s.appendChild(o);
    }
    s.onchange = () => on(s.value);
    r.appendChild(s);
  }

  _rowCheck(label, val, on, hint) {
    const r = this._row(label, hint);
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.checked = !!val;
    i.onchange = () => on(i.checked);
    r.appendChild(i);
  }

  _rowColor(label, val, on) {
    const r = this._row(label);
    const i = document.createElement('input');
    i.type = 'color';
    i.value = '#' + val.toString(16).padStart(6, '0');
    i.onchange = () => on(parseInt(i.value.slice(1), 16));
    r.appendChild(i);
  }

  _rowBtn(label, hint, on) {
    const b = document.createElement('button');
    b.className = 'wide';
    b.textContent = label;
    b.title = hint || '';
    b.onclick = on;
    (this._target || this.form).appendChild(b);
  }

  // ═══════════════════════════════════════════════════
  //  結構分析
  // ═══════════════════════════════════════════════════

  /**
   * 跑一次半邊結構的健康檢查與曲面判定。
   * 面數多的時候要花幾百毫秒，所以不自動跑，按按鈕才算，算完存起來。
   */
  analyse(force = false) {
    const obj = this.app.sel.active;
    if (!obj) return;

    if (!force && this.analysisCache.has(obj.id)) {
      this._renderAnalysis(this.analysisCache.get(obj.id));
      return;
    }

    this.anaBody.className = 'empty';
    this.anaBody.textContent = '計算中…';

    // 讓「計算中」有機會畫出來
    setTimeout(() => {
      const mesh = obj.mesh();
      const t0 = performance.now();
      const v = mesh.validate();
      const s = summarize(mesh);
      const ms = Math.round(performance.now() - t0);

      const data = {
        name: obj.name, v, s, ms,
        area: mesh.area(),
        volume: v.closed ? mesh.volume() : null
      };
      this.analysisCache.set(obj.id, data);
      this._renderAnalysis(data);
    }, 16);
  }

  _renderAnalysis(d) {
    const { v, s } = d;
    const t = topologyCheck(v, s.totalDefect);

    // 極小的負值（-1e-16 之類）顯示成 -0.0000 很難看也容易被誤會，先歸零
    const defect = Math.abs(s.totalDefect) < 5e-5 ? 0 : s.totalDefect;

    this.anaBody.className = '';
    this.anaBody.innerHTML = `
      <table class="ana">
        <tr><th colspan="2" class="grp">拓 撲</th></tr>
        <tr><td>頂點 / 邊 / 面</td><td>${v.V} / ${v.E} / ${v.F}</td></tr>
        <tr><td title="封閉網格的尤拉數 χ ＝ 2×分開的實體數 − 2×貫穿孔數。一個沒有洞的實體是 2，挖穿一個孔變 0，兩塊分開的實體是 4。開放的殼是 1。χ 一定是偶數，出現奇數就表示結構接錯了">尤拉數 V−E+F</td>
            <td>${v.euler} ${mark(t.eulerOK)}<span class="dim"> ${t.eulerNote}</span></td></tr>
        ${t.genus !== null
          ? `<tr><td title="貫穿的洞有幾個。挖穿一個孔＝1，甜甜圈也是 1。沒挖穿的盲孔不算">貫穿孔數</td>
                 <td>${t.genus}</td></tr>`
          : ''}
        ${v.components > 1
          ? `<tr><td title="這個物件其實是幾塊彼此分開、沒有相連的實體。聯集兩個沒碰到的東西就會這樣">分開的實體</td>
                 <td>${v.components} 塊</td></tr>`
          : ''}
        <tr><td>是否封閉</td><td>${v.closed ? '封閉' : '開放（有邊界）'}</td></tr>
        <tr><td>結構檢查</td><td>${v.ok ? '無誤 ✓' : `<span class="bad">${v.errors.length} 項問題</span>`}</td></tr>

        <tr><th colspan="2" class="grp">展開相關</th></tr>

        <tr><td title="共面且相鄰的三角形已合併。展開時一片就是一個單位">平面區域</td>
            <td>${s.regions} 片<span class="dim"> ← ${v.F} 個三角形合併而來</span></td></tr>
        <tr><td title="用高斯曲率判定。可展開的才有精確解，不可展的必須切分近似">曲面判定</td>
            <td>${SURFACE_TEXT[s.surface] || s.surface}</td></tr>
        <tr><td title="360度減去頂點周圍所有夾角。高斯–博內定理：封閉曲面的總和恆等於 2π×尤拉數。沒有洞時就是常見的 4π">角虧總和</td>
            <td>${defect.toFixed(4)}${t.defectExpect !== null
              ? `<span class="dim"> 理論 2πχ = ${t.defectExpect.toFixed(4)}</span> ${mark(t.defectOK)}`
              : ''}</td></tr>
        <tr><td>攤不平的頂點</td><td>${s.curvedVerts} / ${v.V}</td></tr>
        <tr><td>折線 / 切割線</td><td>${s.folds} / ${s.cuts}</td></tr>

        <tr><th colspan="2" class="grp">尺寸</th></tr>
        <tr><td>表面積</td><td>${fmt(d.area)} cm²</td></tr>
        ${d.volume !== null
          ? `<tr><td>體積</td><td>${fmt(d.volume)} cm³</td></tr>` : ''}
      </table>
      <div class="anaFoot">計算耗時 ${d.ms} ms</div>`;
  }
}

// ═══════════════════════════════════════════════════════
//  拓撲判定
// ═══════════════════════════════════════════════════════

/**
 * 由拓撲數字推出「理論上應該是多少」，並判斷對不對。
 *
 * ── 這個函式為什麼要獨立出來 ────────────────────────
 * 第 1 期把「封閉 → 尤拉數 2、角虧總和 4π」直接寫死在畫面上。
 * 那時只有基本體，沒有東西挖得出洞，所以從沒出事。
 * 第 2 期一有布林運算，挖一個貫穿孔就變成 χ=0、角虧總和=0，
 * 寫死的判定把完全正確的結果打了兩個紅叉（2026-08-21 實際發生）。
 *
 * 所以改用正確的公式，而且抽成**不碰 DOM 的純函式**，
 * 這樣 tests/run.mjs 可以直接測它 —— 判定邏輯一旦寫錯，
 * 症狀是「數字明明對卻說錯」，那是最容易讓人失去信任的一種 bug。
 *
 * ── 用到的兩個定理 ──────────────────────────────────
 * 封閉可定向曲面：χ ＝ V−E+F ＝ 2c − 2g
 *   c ＝ 有幾個彼此分開的實體，g ＝ 貫穿孔總數（虧格）
 *   一個沒有洞的方塊 → χ=2；挖穿一個孔（等價於甜甜圈）→ χ=0；
 *   兩個分開的方塊（布林聯集很容易做出來）→ χ=4。
 *   所以「χ 應為 2」是錯的，正確的鐵律只有「χ 必為偶數」。
 * 高斯–博內定理：封閉曲面的角虧總和恆等於 2πχ。
 *   χ=2 時就是常見的 4π ≈ 12.5664。
 *
 * @param {object} v          mesh.validate() 的回傳（要有 components）
 * @param {number} totalDefect summarize() 算出的角虧總和
 */
export function topologyCheck(v, totalDefect) {
  if (!v.closed) {
    // 開放的殼（板件）：一片沒有洞的板子是 1。
    // 角虧總和的高斯–博內版本含邊界積分項，這裡不做判定，
    // 免得給出似是而非的數字。
    return {
      genus: null,
      eulerOK: v.euler === 1,
      eulerNote: '開放的殼應為 1',
      defectExpect: null,
      defectOK: null
    };
  }

  const c = v.components ?? 1;
  const even = v.euler % 2 === 0;
  // χ = 2c − 2g 反推 g。g 為負數表示拓撲上不可能，一定是結構接錯了。
  const g = (2 * c - v.euler) / 2;
  const valid = even && Number.isInteger(g) && g >= 0;
  const defectExpect = 2 * Math.PI * v.euler;

  let note;
  if (!valid) note = '封閉曲面不可能是這個值';
  else if (c === 1) note = g === 0 ? '＝2，沒有貫穿孔' : `＝2−2×${g}`;
  else note = `＝2×${c}−2×${g}`;

  return {
    genus: valid ? g : null,
    components: c,
    eulerOK: valid,
    eulerNote: note,
    defectExpect,
    // 容許 1e-4：座標是 32 位元浮點數，上萬個頂點累加會有這個量級的尾差
    defectOK: Math.abs(totalDefect - defectExpect) < 1e-4
  };
}

// ═══════════════════════════════════════════════════════
//  上方工具列
// ═══════════════════════════════════════════════════════

/** 把「新增」下拉選單填上基本體 */
export function fillPrimMenu(selectEl) {
  for (const t of PRIM_TYPES) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = PRIM_SPECS[t] ? PRIM_SPECS[t].label : t;
    selectEl.appendChild(o);
  }
}

export { defaultSrc };

// ── 小工具 ────────────────────────────────────────────

function head(text) {
  const h = document.createElement('div');
  h.className = 'sub';
  h.textContent = text;
  return h;
}

function note(text) {
  const n = document.createElement('div');
  n.className = 'note';
  n.textContent = text;
  return n;
}

/** 紅色的提示，用在算不出來這種需要處理的狀況 */
function bad(text) {
  const n = document.createElement('div');
  n.className = 'badNote';
  n.textContent = text;
  return n;
}

/**
 * 運算元的一行摘要，例如「⌀20 × 60」。
 * 展開之前就看得出誰是誰，不用一個個點開找。
 */
function describeSrc(src) {
  if (!src) return '';
  if (isBoolSrc(src)) return BOOL_LABEL[src.op] || '布林';
  if (src.type === 'mesh') return '網格';

  const n = v => round(v);
  switch (src.type) {
    case 'box':      return `${n(src.w)}×${n(src.h)}×${n(src.d)}`;
    case 'plate':    return `${n(src.w)}×${n(src.d)}`;
    case 'cylinder': return `⌀${n(src.r * 2)}×${n(src.h)}`;
    case 'cone':     return `⌀${n(src.rBottom * 2)}→⌀${n(src.rTop * 2)}×${n(src.h)}`;
    case 'sphere':   return `⌀${n(src.r * 2)}`;
    case 'prism':    return `${n(src.sides)}角 ⌀${n(src.r * 2)}×${n(src.h)}`;
    default:         return PRIM_SPECS[src.type] ? PRIM_SPECS[src.type].label : src.type;
  }
}

function mark(ok) {
  return ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>';
}

function round(v) {
  return Math.abs(v) < 1e-9 ? 0 : +Number(v).toFixed(4);
}

function fmt(v) {
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 });
}
