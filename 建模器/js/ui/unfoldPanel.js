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
import { drawProgram, renderCanvas, titleLines, toSVG, printPieces, sameFolds, progSVG, printSVGs } from '../out/sheet.js';
import { packBoards, boardProgram, boardTitle, NEST_DEFAULTS } from '../out/nest.js';
import { seamCount } from '../unfold/seam.js';
import { toDXF, boardDXF, UNITS } from '../out/dxf.js';
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
      /**
       * 🔴 〔2026-08-23 拿掉 `k`〕展開面板不再有 K 因子輸入框。
       * K 是金屬中性層的模型，而且它已經不影響圖上任何一個數字 ——
       * 留一個什麼都不做的控制項比拿掉更糟。
       * kang：「不應該在真實尺寸中出現」。
       * ⚠ 舊的偏好設定裡若還存著 `k`，讀進來也沒有人會用它。
       */
      material: DEFAULT_MATERIAL, unit: 'mm', askPath: true, ...loadOpt()
    };
    /**
     * 🔴 **排版設定**（2026-10-09，kang 拍板）—— 記在瀏覽器裡，下次打開照上次的板子大小。
     * ⚠ 舊的偏好設定裡沒有這一項 ⇒ 用 `NEST_DEFAULTS` 補齊（預設開、240 × 120、間距 1、⛔ 不轉）。
     */
    this.opt.nest = { ...NEST_DEFAULTS, ...(this.opt.nest || {}) };
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
          <span class="sp"></span>
          <span class="lbl">DXF 單位</span><select id="uwUnit"></select>
          <label class="uwCk"><input type="checkbox" id="uwAsk"> 指定存放位置</label>
          <label class="uwCk" title="一片上的折線全部一樣（同方向、同角度）時，圖上只畫線，角度寫成卡片上的一行。上折下折混在一起的那片照樣每道標字"><input type="checkbox" id="uwFold"> 相同的折線合成一行</label>
          <span class="sp"></span>
          <button id="uwPrint">列印</button>
          <button id="uwSvg">存 SVG</button>
          <button id="uwDxf">存 DXF</button>
          <button id="uwCsv">備料 CSV</button>
        </div>
        <div class="uwBar" title="排版：把很多片自動擺進一張一張板子裡，存 SVG／DXF 時一張板一個檔。關掉就回到原本的存法（SVG 一片一個檔、DXF 排成一長條）">
          <label class="uwCk"><input type="checkbox" id="uwNest"> 排版到板子上</label>
          <span class="lbl">板寬</span><input type="number" id="uwNW" min="1" step="1" style="width:64px">
          <span class="lbl">板高</span><input type="number" id="uwNH" min="1" step="1" style="width:64px">
          <span class="lbl">間距</span><input type="number" id="uwNG" min="0" step="0.5" style="width:52px">
          <span class="lbl">cm</span>
          <label class="uwCk" title="布、木皮有紋路（布紋、木紋），轉了方向會不一樣 —— 所以預設關，需要時才打開"><input type="checkbox" id="uwNR"> 可以轉 90°</label>
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

    /**
     * 🔴 **相同的折線合成一行**（2026-10-09，kang 拍板：做開關、整個視窗共用）。
     * 預設在 `open()` 決定：有自己標過切線的物件（打版）→ 勾；都沒有 → 不勾（原本的展開圖一個字都不變）。
     * ⚠ ⛔ 不存進 localStorage —— 每次打開照「這次展開的是什麼」重新決定。
     */
    // ── 排版 ──
    const N = this.opt.nest;
    const nestIn = { on: $('uwNest'), w: $('uwNW'), h: $('uwNH'), gap: $('uwNG'), rotate: $('uwNR') };
    nestIn.on.checked = !!N.on; nestIn.rotate.checked = !!N.rotate;
    nestIn.w.value = N.w; nestIn.h.value = N.h; nestIn.gap.value = N.gap;
    const nestChanged = () => {
      N.on = nestIn.on.checked; N.rotate = nestIn.rotate.checked;
      /** 填錯（空白、0、負數）就退回上一個能用的值 —— ⛔ 不讓排版算出一個不存在的板子 */
      for (const k of ['w', 'h']) { const v = +nestIn[k].value; if (v > 0) N[k] = v; else nestIn[k].value = N[k]; }
      const gv = +nestIn.gap.value; if (gv >= 0) N.gap = gv; else nestIn.gap.value = N.gap;
      saveOpt(this.opt);
      if (this.result) this._render(this.result, this.objs);
    };
    for (const k of Object.keys(nestIn)) nestIn[k].onchange = nestChanged;

    this.foldIn = $('uwFold');
    this.foldIn.onchange = () => { if (this.result) this._render(this.result, this.objs); };

    $('uwClose').onclick = () => this.close();
    el.querySelector('.uwBack').onclick = () => this.close();

    $('uwPrint').onclick = () => this._print();
    $('uwSvg').onclick = () => this._saveSVG();
    $('uwDxf').onclick = () => this._saveDXF();
    $('uwCsv').onclick = () => this._saveCSV();

    window.addEventListener('keydown', e => {
      // ⚠ 關掉之後⛔ 不再往下傳 —— 不然主畫面的 Esc 會接著清掉選取（2026-10-08 E2）
      if (!this.el.hidden && e.key === 'Escape') { e.stopImmediatePropagation(); this.close(); }
    });

    saveOpt(this.opt);
  }

  // ── 開關 ────────────────────────────────────────────

  open() {
    this.el.hidden = false;
    this.foldIn.checked = this._targets().some(hasSeams);
    this.run();
  }

  /** 這次要展開的物件：沒選東西就整份文件 —— 一個案子通常就是要全部出圖 */
  _targets() {
    const picked = this.app.sel.objects;
    return picked.length ? picked : this.app.doc.objects;
  }

  /** 卡片、SVG、列印、DXF 共用的選項 —— ⛔ 不要各組一份 */
  _drawOpt(extra = {}) {
    return {
      rule: this.result && this.result.rule, head: this.app.head,
      foldSummary: this.foldIn.checked, ...extra
    };
  }

  close() { this.el.hidden = true; }

  get isOpen() { return !this.el.hidden; }

  // ── 算一次並重畫 ────────────────────────────────────

  run() {
    saveOpt(this.opt);
    const objs = this._targets();
    const r = unfoldMany(objs, { material: this.opt.material });
    this.result = r;
    this.objs = objs;
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

    /**
     * 🔴 **打版的東西把「相同的折線合成一行」關掉 → 講一句**
     * （kang 2026-10-09：「如果要關閉...就如實作一個提醒告知」）。
     * ⚠ 只在「有自己標過切線的物件、而且真的有片會被合成」時講 —— 方塊那種原本就不勾，⛔ 不要天天跳提醒。
     */
    const could = r.pieces.filter(p => sameFolds(p)).length;
    if (!this.foldIn.checked && could && (objs || []).some(hasSeams)) {
      this.body.appendChild(box('uwWarn',
        `⚠ 已關閉「相同的折線合成一行」：有 ${could} 種片的折線全部一樣，每道都會標角度，長條上的字會很多`));
    }

    if (!r.pieces.length) {
      if (!r.skipped.length) {
        this.body.appendChild(box('uwSkip',
          `目前選了 ${objs.length} 個物件，但沒有一個是板件。`
          + '請先選一個「板件 sheet」（平板或折板），或把物件的種類改成板件。'));
      }
      return;
    }

    if (this.opt.nest.on) this._renderBoards(r);
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

  /** 排版：照目前的設定把這次的片擺進板子裡（⛔ 不存結果 —— 設定一改就重排）*/
  _nest() {
    const N = this.opt.nest;
    return packBoards(this.result.pieces, { w: N.w, h: N.h, gap: N.gap, rotate: N.rotate });
  }

  /** 每張板的「畫什麼」與標題 —— 畫面、SVG、DXF、列印共用，⛔ 不各排一次 */
  _boardSheets() {
    const nest = this._nest();
    const opt = this._drawOpt({ label: p => p.no });
    const n = nest.boards.length;
    return nest.boards.map((b, i) => ({
      board: b, prog: boardProgram(b, opt), title: boardTitle(b, i, n, opt)
    }));
  }

  /** 🔴 排版預覽：放在每片卡片的上面 —— 先看要幾張板、每張擺了哪幾片 */
  _renderBoards(r) {
    if (!r.pieces.length) return;
    const N = this.opt.nest;
    const sheets = this._boardSheets();
    const big = sheets.filter(x => x.board.oversize).length;
    const head = box(big ? 'uwWarn' : 'uwSkip',
      `排版：需要 ${sheets.length - big} 張 ${fmt(N.w)} × ${fmt(N.h)} cm 的板子`
      + (big ? `　⚠ 另有 ${big} 片比板子還大，各自單獨一張（要換大板或再切小）` : '')
      + '　存 SVG／DXF 時一張板一個檔');
    this.body.appendChild(head);
    for (const sh of sheets) {
      const card = document.createElement('div');
      card.className = 'uwCard';
      const h = document.createElement('div');
      h.className = 'uwTitle';
      h.innerHTML = sh.title.map((s, i) =>
        `<div class="${s.startsWith('⚠') ? 'bad' : (i === 0 ? 'nm' : 'dim')}">${esc(s)}</div>`).join('');
      card.appendChild(h);
      card.appendChild(this._canvas(sh.prog, 300));
      this.body.appendChild(card);
    }
  }

  /** 一份「畫什麼」畫成 canvas（卡片與排版預覽共用）*/
  _canvas(prog, maxH) {
    const maxW = Math.min(1100, Math.max(360, this.body.clientWidth - 56));
    const px = Math.max(1, Math.min(maxW / prog.box.w, maxH / prog.box.h));
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
    return cv;
  }

  /** 一片一張卡：上面是圖，下面是這一片的重點數字 */
  _card(piece, rule) {
    const card = document.createElement('div');
    card.className = 'uwCard';

    const lines = titleLines(piece, this._drawOpt({ rule }));
    const h = document.createElement('div');
    h.className = 'uwTitle';
    h.innerHTML = lines.map((s, i) =>
      `<div class="${s.startsWith('⚠') ? 'bad' : (i === 0 ? 'nm' : 'dim')}">${esc(s)}</div>`
    ).join('');
    card.appendChild(h);

    const prog = drawProgram(piece, this._drawOpt({ rule }));
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
    if (this.opt.nest.on) {
      printSVGs(this._boardSheets().map(sh => progSVG(sh.prog, sh.title)), '排版');
      return;
    }
    printPieces(this.result.pieces, this._drawOpt());
  }

  /**
   * 匯出的共同規矩：**內容一律同步準備好，才去 await 存檔**。
   * showSaveFilePicker() 要在使用者按鈕的手勢還有效時呼叫，
   * 先 await 別的東西手勢就過期，瀏覽器會直接拒絕（見 out/save.js）。
   */
  async _saveSVG() {
    if (!this._has()) return;
    if (this.opt.nest.on) {
      // 🔴 排版開著：一張板一個檔（kang 2026-10-09）
      const jobs = this._boardSheets().map((sh, i) => ({
        name: `${this._base()}_板${String(i + 1).padStart(2, '0')}.svg`,
        blob: textBlob(progSVG(sh.prog, sh.title), 'image/svg+xml')
      }));
      const n = await saveMany(jobs, this.opt.askPath);
      if (n > 1) this._say(`已存 ${n} 個 SVG（一張板一個檔）。`);
      return;
    }
    const opt = this._drawOpt();
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
    if (this.opt.nest.on) {
      // 🔴 排版開著：一張板一個檔（kang 2026-10-09）。標題只能英數（R12）
      const sheets = this._boardSheets();
      const jobs = sheets.map((sh, i) => ({
        name: `${this._base()}_板${String(i + 1).padStart(2, '0')}.dxf`,
        blob: textBlob(boardDXF(sh.prog, {
          unit: this.opt.unit,
          title: `SHEET ${i + 1}/${sheets.length}  ${fmt(sh.board.w)}x${fmt(sh.board.h)}cm`
            + (sh.board.oversize ? '  OVERSIZE' : '')
            + '  ' + sh.board.items.map(it => it.piece.no).join(' ')
        }), 'application/dxf')
      }));
      const n = await saveMany(jobs, this.opt.askPath);
      if (n > 1) this._say(`已存 ${n} 個 DXF（一張板一個檔）。`);
      return;
    }
    // 一個 DXF 裝全部的片、沿 X 排開 —— 雷切廠要的是一張料上排好版
    const blob = textBlob(toDXF(this.result.pieces, this._drawOpt({ unit: this.opt.unit })),
      'application/dxf');
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

/** 這個物件有沒有自己標過切線（＝ 打版那一類）。參數物件標不了，網格算不出來也當沒有 */
function hasSeams(o) {
  if (!o || o.isParametric) return false;
  try { return seamCount(o.mesh()) > 0; } catch (e) { return false; }
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
