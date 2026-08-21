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
    if (obj.isParametric) {
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

  // ── 表單元件 ──────────────────────────────────────

  _row(label, hint) {
    const r = document.createElement('div');
    r.className = 'row';
    const l = document.createElement('label');
    l.textContent = label;
    if (hint) l.title = hint;
    r.appendChild(l);
    this.form.appendChild(r);
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
    this.form.appendChild(r);
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
    this.form.appendChild(b);
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
    const eulerExpect = v.closed ? 2 : 1;
    const eulerOK = v.euler === eulerExpect;

    this.anaBody.className = '';
    this.anaBody.innerHTML = `
      <table class="ana">
        <tr><th colspan="2" class="grp">拓 撲</th></tr>
        <tr><td>頂點 / 邊 / 面</td><td>${v.V} / ${v.E} / ${v.F}</td></tr>
        <tr><td title="封閉網格 V−E+F 應該等於 2，開放的殼是 1。對不上就表示結構接錯了">尤拉數 V−E+F</td>
            <td>${v.euler} ${mark(eulerOK)}<span class="dim"> 應為 ${eulerExpect}</span></td></tr>
        <tr><td>是否封閉</td><td>${v.closed ? '封閉' : '開放（有邊界）'}</td></tr>
        <tr><td>結構檢查</td><td>${v.ok ? '無誤 ✓' : `<span class="bad">${v.errors.length} 項問題</span>`}</td></tr>

        <tr><th colspan="2" class="grp">展開相關</th></tr>

        <tr><td title="共面且相鄰的三角形已合併。展開時一片就是一個單位">平面區域</td>
            <td>${s.regions} 片<span class="dim"> ← ${v.F} 個三角形合併而來</span></td></tr>
        <tr><td title="用高斯曲率判定。可展開的才有精確解，不可展的必須切分近似">曲面判定</td>
            <td>${SURFACE_TEXT[s.surface] || s.surface}</td></tr>
        <tr><td title="360度減去頂點周圍所有夾角。封閉曲面的總和恆等於 4π ≈ 12.566">角虧總和</td>
            <td>${s.totalDefect.toFixed(4)}${v.closed
              ? `<span class="dim"> 理論 4π = 12.5664</span> ${mark(Math.abs(s.totalDefect - 4 * Math.PI) < 1e-4)}`
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

function mark(ok) {
  return ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>';
}

function round(v) {
  return Math.abs(v) < 1e-9 ? 0 : +Number(v).toFixed(4);
}

function fmt(v) {
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 });
}
