/**
 * unfoldPanel.js — 展開視窗
 *
 * 一個蓋在畫面上的視窗：左邊設定（材質、K、單位），
 * 右邊是一片一片的展開圖預覽，下面是備料明細。
 *
 * ── 為什麼不做在右側面板裡 ──────────────────────────
 * 展開圖是要拿去下料的圖，一定要看得夠大才看得清楚尺寸。
 * 塞進 300px 寬的側欄，數字小到看不見，等於沒出圖。
 *
 * ── 這個檔案只負責介面 ──────────────────────────────
 * 展開怎麼算在 unfold/，圖怎麼畫在 out/。
 * 這裡只做三件事：收設定、把結果排出來、按鈕接到匯出函式。
 */

import { MATERIALS, MATERIAL_KEYS, DEFAULT_MATERIAL } from '../unfold/rules.js';
import { unfoldMany, bomCSV } from '../unfold/part.js';
import { drawProgram, renderCanvas, titleLines, toSVG, printPieces } from '../out/sheet.js';
import { toDXF, UNITS } from '../out/dxf.js';
import { saveBlob, saveMany, textBlob, safeName, canChoosePath, TYPES }
  from '../out/save.js';

const LS_KEY = 'modeler_unfold';

export class UnfoldPanel {
  /**
   * @param {object} app { doc, sel, head }
   */
  constructor(app) {
    this.app = app;
    this.opt = {
      material: DEFAULT_MATERIAL, k: null, unit: 'mm', askPath: true, ...loadOpt()
    };
    this.result = null;
    this._build();
  }

  // ── 建立畫面骨架 ────────────────────────────────────

  _build() {
    const el = document.createElement('div');
    el.id = 'unfoldWin';
    el.className = 'uwWin';        // 樣式與 3D 匯出視窗共用
    el.hidden = true;
    el.innerHTML = `
      <div class="uwBack"></div>
      <div class="uwBox">
        <div class="uwHead">
          <b>展開圖</b>
          <span class="uwSum" id="uwSum"></span>
          <button class="mini" id="uwClose">關閉</button>
        </div>
        <div class="uwBar">
          <span class="lbl">材質</span><select id="uwMat"></select>
          <span class="lbl">K 因子</span><input type="number" id="uwK" step="0.05" min="0" max="0.5" style="width:70px">
          <button class="mini" id="uwKreset" title="改回這個材質的建議值">用建議值</button>
          <span class="sp"></span>
          <span class="lbl">DXF 單位</span><select id="uwUnit"></select>
          <label class="uwCk"><input type="checkbox" id="uwAsk"> 指定存放位置</label>
          <span class="sp"></span>
          <button id="uwPrint">列印</button>
          <button id="uwSvg">存 SVG</button>
          <button id="uwDxf">存 DXF</button>
          <button id="uwCsv">備料 CSV</button>
        </div>
        <div class="uwBody" id="uwBody"></div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;

    const $ = id => el.querySelector('#' + id);
    this.body = $('uwBody');
    this.sum = $('uwSum');

    const mat = $('uwMat');
    for (const k of MATERIAL_KEYS) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = MATERIALS[k].label;
      o.title = MATERIALS[k].note;
      mat.appendChild(o);
    }
    mat.value = this.opt.material;
    mat.onchange = () => {
      this.opt.material = mat.value;
      this.opt.k = null;                 // 換材質就回到那個材質的建議 K
      this._syncK();
      this.run();
    };
    this.matSel = mat;

    const unit = $('uwUnit');
    for (const k of Object.keys(UNITS)) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = UNITS[k].label;
      unit.appendChild(o);
    }
    unit.value = this.opt.unit;
    unit.title = '雷切／CNC 廠通常收 mm；要跟建模器內部一致就選 cm';
    unit.onchange = () => { this.opt.unit = unit.value; saveOpt(this.opt); };

    // ── 指定存放位置 ──
    // 這個功能只在安全環境（https 或 localhost）可用。本機用內網 IP 開
    // 屬於非安全環境，所以直接把狀況寫在提示裡，不要讓人以為是壞掉。
    this.askIn = $('uwAsk');
    this.askIn.checked = !!this.opt.askPath;
    this.askIn.parentElement.title = canChoosePath()
      ? '存檔時跳「另存新檔」讓你選資料夾。關閉則直接存到瀏覽器預設下載資料夾'
      : '這個開啟方式不支援（瀏覽器只在 https 或 localhost 開放此功能），'
        + '本機用內網 IP 開會自動退回一般下載。線上版可以用';
    if (!canChoosePath()) this.askIn.parentElement.classList.add('off');
    this.askIn.onchange = () => {
      this.opt.askPath = this.askIn.checked;
      saveOpt(this.opt);
    };

    this.kIn = $('uwK');
    this.kIn.title = '中性層落在板厚的幾成（從內側量起）。'
      + '下料長度 ＝ 直段 ＋ 各折彎的 θ×(內側R ＋ K×板厚)';
    this.kIn.onchange = () => {
      const v = parseFloat(this.kIn.value);
      this.opt.k = Number.isFinite(v) ? v : null;
      this.run();
    };
    $('uwKreset').onclick = () => { this.opt.k = null; this._syncK(); this.run(); };

    $('uwClose').onclick = () => this.close();
    el.querySelector('.uwBack').onclick = () => this.close();

    $('uwPrint').onclick = () => this._print();
    $('uwSvg').onclick = () => this._saveSVG();
    $('uwDxf').onclick = () => this._saveDXF();
    $('uwCsv').onclick = () => this._saveCSV();

    window.addEventListener('keydown', e => {
      if (!this.el.hidden && e.key === 'Escape') this.close();
    });

    this._syncK();
  }

  _syncK() {
    const m = MATERIALS[this.opt.material] || MATERIALS[DEFAULT_MATERIAL];
    this.kIn.value = this.opt.k ?? m.k;
    saveOpt(this.opt);
  }

  // ── 開關 ────────────────────────────────────────────

  open() {
    this.el.hidden = false;
    this.run();
  }

  close() { this.el.hidden = true; }

  get isOpen() { return !this.el.hidden; }

  // ── 算一次並重畫 ────────────────────────────────────

  run() {
    saveOpt(this.opt);
    // 沒選東西就展開整份文件 —— 一個案子通常就是要全部出圖
    const picked = this.app.sel.objects;
    const objs = picked.length ? picked : this.app.doc.objects;
    const r = unfoldMany(objs, { material: this.opt.material, k: this.opt.k ?? undefined });
    this.result = r;
    this._render(r, objs);
  }

  _render(r, objs) {
    this.body.innerHTML = '';

    const s = r.stats;
    this.sum.textContent = r.pieces.length
      ? `${s.pieces} 種、共 ${s.total} 片　總面積 ${fmt(s.area / 10000)} m²　`
        + `折彎 ${s.arcBends + s.sharpBends} 道`
      : '沒有可以展開的東西';

    for (const msg of r.skipped) this.body.appendChild(box('uwSkip', msg));
    for (const w of r.warnings) this.body.appendChild(box('uwWarn', '⚠ ' + w));

    if (!r.pieces.length) {
      if (!r.skipped.length) {
        this.body.appendChild(box('uwSkip',
          `目前選了 ${objs.length} 個物件，但沒有一個是板件。`
          + '請先選一個「板件 sheet」（平板或折板），或把物件的種類改成板件。'));
      }
      return;
    }

    for (const p of r.pieces) this.body.appendChild(this._card(p, r.rule));

    // ── 備料明細 ──
    const tb = document.createElement('table');
    tb.className = 'uwBom';
    tb.innerHTML = '<tr><th>名稱</th><th>數量</th><th>展開長 cm</th><th>展開寬 cm</th>'
      + '<th>單片面積 cm²</th><th>折彎</th></tr>'
      + r.pieces.map(p => `<tr><td>${esc(p.name)}</td><td>${p.qty}</td>`
        + `<td>${fmt(p.width)}</td><td>${fmt(p.height)}</td>`
        + `<td>${fmt(p.area)}</td><td>${p.bends.length}</td></tr>`).join('');
    const wrap = document.createElement('div');
    wrap.className = 'uwBomWrap';
    wrap.innerHTML = '<h3>備料明細</h3>';
    wrap.appendChild(tb);
    this.body.appendChild(wrap);
  }

  /** 一片一張卡：上面是圖，下面是這一片的重點數字 */
  _card(piece, rule) {
    const card = document.createElement('div');
    card.className = 'uwCard';

    const lines = titleLines(piece, { rule, head: this.app.head });
    const h = document.createElement('div');
    h.className = 'uwTitle';
    h.innerHTML = lines.map((s, i) =>
      `<div class="${s.startsWith('⚠') ? 'bad' : (i === 0 ? 'nm' : 'dim')}">${esc(s)}</div>`
    ).join('');
    card.appendChild(h);

    const prog = drawProgram(piece, { rule });
    const maxW = Math.min(1100, Math.max(360, this.body.clientWidth - 56));
    const px = Math.max(1.5, Math.min(maxW / prog.box.w, 420 / prog.box.h));

    const cv = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.ceil(prog.box.w * px * dpr);
    cv.height = Math.ceil(prog.box.h * px * dpr);
    cv.style.width = Math.ceil(prog.box.w * px) + 'px';
    cv.style.height = Math.ceil(prog.box.h * px) + 'px';

    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    renderCanvas(ctx, prog, px);
    card.appendChild(cv);

    return card;
  }

  // ── 匯出 ────────────────────────────────────────────

  _print() {
    if (!this._has()) return;
    printPieces(this.result.pieces, { rule: this.result.rule, head: this.app.head });
  }

  /**
   * 匯出的共同規矩：**內容一律同步準備好，才去 await 存檔**。
   * showSaveFilePicker() 要在使用者按鈕的手勢還有效時呼叫，
   * 先 await 別的東西手勢就過期，瀏覽器會直接拒絕（見 out/save.js）。
   */
  async _saveSVG() {
    if (!this._has()) return;
    const opt = { rule: this.result.rule, head: this.app.head };
    // 多片時每片一個檔，檔名帶編號與片名，現場才對得起來
    const jobs = this.result.pieces.map((p, i) => ({
      name: `${this._base()}_${String(i + 1).padStart(2, '0')}_`
          + `${safeName(p.name, '展開片')}.svg`,
      blob: textBlob(toSVG(p, opt), 'image/svg+xml')
    }));
    const n = await saveMany(jobs, this.opt.askPath);
    if (n > 1) this._say(`已存 ${n} 個 SVG。`);
  }

  async _saveDXF() {
    if (!this._has()) return;
    // 一個 DXF 裝全部的片、沿 X 排開 —— 雷切廠要的是一張料上排好版
    const blob = textBlob(toDXF(this.result.pieces, {
      unit: this.opt.unit, rule: this.result.rule, head: this.app.head
    }), 'application/dxf');
    await saveBlob(blob, `${this._base()}.dxf`, TYPES.dxf, this.opt.askPath);
  }

  async _saveCSV() {
    if (!this._has()) return;
    // 開頭那個 BOM 是給 Excel 看的：沒有它 Excel 會用系統編碼開，中文變亂碼
    const blob = textBlob('﻿' + bomCSV(this.result.pieces, this.result.rule),
      'text/csv');
    await saveBlob(blob, `${this._base()}_備料.csv`, TYPES.csv, this.opt.askPath);
  }

  /** 檔名的共同前綴：案件名 ＋ 材質，一眼看得出是哪一批 */
  _base() {
    const head = this.app.head || {};
    const mat = this.result && this.result.rule ? this.result.rule.label : '';
    return safeName(`展開_${head.name || '未命名'}${mat ? '_' + mat : ''}`, '展開圖');
  }

  _say(msg) { this.sum.textContent = msg + '　' + this.sum.textContent; }

  _has() { return !!(this.result && this.result.pieces.length); }
}

function box(cls, msg) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = msg;
  return d;
}

const fmt = v => String(Math.round(v * 100) / 100);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 檔名清理統一走 out/save.js 的 safeName()，不要各寫一份

function loadOpt() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch (e) { return {}; }
}
function saveOpt(o) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) { /* 無所謂 */ }
}
