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

import { MATERIALS, PICKABLE_MATERIAL_KEYS, DEFAULT_MATERIAL } from '../unfold/rules.js';
import { unfoldMany, bomCSV } from '../unfold/part.js';
import { drawProgram, renderCanvas, titleLines, toSVG, printPieces, sameFolds, progSVG, printSVGs, qtyWords } from '../out/sheet.js';
import { packBoards, boardProgram, boardTitle, NEST_DEFAULTS } from '../out/nest.js';
import { seamCount } from '../unfold/seam.js';
import { toDXF, boardDXF, UNITS } from '../out/dxf.js';
import { saveBlob, saveMany, textBlob, safeName, canChoosePath, TYPES }
  from '../out/save.js';
import { nonPlanarFaces } from '../core/edit.js';
import { ask } from './askBox.js';
import { smoothExitNote } from '../out/smoothNote.js';

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
        <div class="uwBar">
          <span class="lbl">展開方式</span>
          <select id="uwMode" title="精確分片：完全攤平、尺寸精確，攤不平的地方程式會自己剪開。省道打版：布、皮革這類能稍微伸縮的材料 —— 容許變形，縫邊長度保持真值，變形擠到片的中間，每片寫出最多拉長／壓縮幾 %">
            <option value="exact">精確分片（不變形）</option>
            <option value="dart">省道打版（容許變形）</option>
          </select>
          <span id="uwDartOpts" hidden>
            <span class="lbl">這個材料最多能拉</span><input type="number" id="uwLimit" min="0" step="0.5" placeholder="不填" style="width:64px"><span class="lbl">%</span>
            <span class="lbl">開口畫成</span>
            <select id="uwDartStyle">
              <option value="cut">剪掉的 V 形缺口</option>
              <option value="sew">只畫縫線（不剪）</option>
            </select>
            <label class="uwCk" title="把每一格之間的折線畫出來（畫面、列印、SVG、DXF 都畫；DXF 在 FOLD 層）。布不需要；珍珠板、發泡板這類要折的材料打開。只畫線、不標角度 —— 片有拉伸，位置是參考"><input type="checkbox" id="uwDartFold"> 畫折線</label>
          </span>
        </div>
        <div class="uwBar" title="沿著有接合編號的縫，每隔一段距離放一個記號，兩片拿起來接的時候記號對記號。只有標過分片的物件才有接合編號">
          <label class="uwCk"><input type="checkbox" id="uwNotch"> 對位記號</label>
          <span class="lbl">每隔</span><input type="number" id="uwNotchGap" min="1" step="0.5" style="width:56px"><span class="lbl">cm</span>
          <span class="lbl">畫成</span>
          <select id="uwNotchStyle" title="要切的（一小刀、小三角）：帆布、紙模這類圖上沒含縫份或黏合片的，往外切、畫在之後要加的那一圈裡；其他材質往內切 0.3 cm。只畫短線：一律往內 0.5 cm、不切">
            <option value="slit">切一小刀</option>
            <option value="v">剪掉小三角</option>
            <option value="mark">只畫短線、不切</option>
          </select>
        </div>
        <div class="uwBar" id="uwMarginBar" hidden title="帆布：每片外面多畫一圈縫份（實線是裁切線），原本的外框變成虛線的縫線。紙模：標過分片的，每一對接縫只在一邊長梯形黏合片；沒標過的，改成外圍一圈。只有帆布、紙模才有這一列">
          <label class="uwCk"><input type="checkbox" id="uwMargin"> 畫縫份／黏合片</label>
          <span class="lbl">寬</span><input type="number" id="uwMarginW" min="0.1" step="0.1" style="width:56px"><span class="lbl">cm</span>
        </div>
        <div class="uwBar" title="排版：把很多片自動擺進一張一張板子裡，存 SVG／DXF 時一張板一個檔。關掉就回到原本的存法（SVG 一片一個檔、DXF 排成一長條）">
          <label class="uwCk"><input type="checkbox" id="uwNest"> 排版到板子上</label>
          <select id="uwNPre" title="常用的大小：選了就把板寬、板高填好（紙模多半印在 A4、A3）。自己打數字就變「自訂」"></select>
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
    /**
     * ⚠ 記住的材質已經收起來了（金屬，2026-10-19 ①-13）或根本不存在 ⇒ 換回預設、第一次畫的時候講一句（⛔ 安靜地換）。
     */
    if (!PICKABLE_MATERIAL_KEYS.includes(this.opt.material)) {
      const was = MATERIALS[this.opt.material];
      if (was) this._matNote = `之前記住的材質是「${was.label}」—— 金屬已經從清單收起來（用不到），這次改用「${MATERIALS[DEFAULT_MATERIAL].label}」`;
      this.opt.material = DEFAULT_MATERIAL;
    }
    for (const k of PICKABLE_MATERIAL_KEYS) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = MATERIALS[k].label;
      o.title = MATERIALS[k].note;
      mat.appendChild(o);
    }
    mat.value = this.opt.material;
    mat.onchange = () => {
      this.opt.material = mat.value;
      this._syncMarginBar();
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
     * ⚠ ⛔ 存進 localStorage（換一份檔案就照內容重新決定）；同一份檔案開著時記住人自己勾的（⑤-16，見 `open()`）。
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
    for (const k of Object.keys(nestIn)) nestIn[k].onchange = () => { nestChanged(); syncPre(); };
    /**
     * 常用的板子大小（2026-10-21，T11：`實驗-匯入狐狸存錢筒.md` 可以增加 1 —— 紙模多半印在 A4、A3，以前要自己打）。
     * 只是幫忙填板寬、板高；預設板子照舊（⛔ 換材質就自動換板子 —— 記住的設定是使用者的）。橫的擺（寬 ≥ 高），跟預設 240 × 120 一樣。
     */
    const PRESETS = [['', '自訂'], ['29.7x21', 'A4（29.7 × 21）'], ['42x29.7', 'A3（42 × 29.7）'], ['59.4x42', 'A2（59.4 × 42）'], ['240x120', '大板（240 × 120）']];
    const preSel = $('uwNPre');
    for (const [v, t] of PRESETS) { const o = document.createElement('option'); o.value = v; o.textContent = t; preSel.appendChild(o); }
    const syncPre = () => { const k = `${N.w}x${N.h}`; preSel.value = PRESETS.some(p => p[0] === k) ? k : ''; };
    preSel.onchange = () => {
      if (!preSel.value) return;
      const [w, h] = preSel.value.split('x').map(Number);
      nestIn.w.value = w; nestIn.h.value = h;
      nestChanged();
    };
    syncPre();

    this.foldIn = $('uwFold');
    /** ⑤-16：人自己勾過 ⇒ 這一份檔案開著的時候記住（`open()`）；新建、開檔清掉（`resetForNewDoc()`）*/
    this._foldUser = null;
    this.foldIn.onchange = () => {
      this._foldUser = this.foldIn.checked;
      if (this.result) this._render(this.result, this.objs);
    };

    /**
     * 🔴 **展開方式**（2026-10-12，kang 拍板 → `規格\建模器-省道打版.md`「定案」3）。
     * ⭐ **預設精確分片**（原本的圖一個字都不變）；⚠ 選了省道打版之後，這一頁開著的期間都記得（⛔ 存進 localStorage ——
     * 下次打開照舊從精確分片開始，⛔ 讓人不知不覺拿到變形過的圖）。
     * 「最多能拉 %」與「開口畫成」記在瀏覽器裡；上限⛔ 給預設值（業界沒有一家公開 —— `外部參考-打版.md`）。
     */
    this.mode = 'exact';
    this.modeSel = $('uwMode');
    this.dartOpts = $('uwDartOpts');
    const lim = $('uwLimit'), dst = $('uwDartStyle');
    lim.value = this.opt.limit ?? '';
    dst.value = this.opt.dartStyle || 'cut';
    this.modeSel.onchange = () => {
      this.mode = this.modeSel.value;
      this.dartOpts.hidden = this.mode !== 'dart';
      this.run();
    };
    lim.onchange = () => {
      const v = lim.value.trim();
      this.opt.limit = v === '' || !(+v >= 0) ? '' : +v;
      lim.value = this.opt.limit;
      saveOpt(this.opt);
      if (this.result) this._render(this.result, this.objs);
    };
    dst.onchange = () => {
      this.opt.dartStyle = dst.value;
      saveOpt(this.opt);
      if (this.result) this._render(this.result, this.objs);
    };
    /**
     * 「畫折線」（2026-10-12，kang：珍珠板／發泡板做省道打版要知道每一格在哪裡折）。
     * 預設關（布不需要），記在瀏覽器裡；畫面、列印、SVG、DXF 一起 —— 「畫面看到什麼，存出去就是什麼」。
     */
    const dfd = $('uwDartFold');
    dfd.checked = !!this.opt.dartFolds;
    dfd.onchange = () => {
      this.opt.dartFolds = dfd.checked;
      saveOpt(this.opt);
      if (this.result) this._render(this.result, this.objs);
    };

    /**
     * 「對位記號」（2026-10-12，kang 拍板 → `規格\建模器-對位記號.md`）：預設關；
     * 間距、形狀記在瀏覽器裡。間距填錯（空白、小於 1）就退回上一個能用的值 —— ⛔ 讓記號擠成一團。
     */
    const nOn = $('uwNotch'), nGap = $('uwNotchGap'), nSt = $('uwNotchStyle');
    nOn.checked = !!this.opt.notchOn;
    nGap.value = this.opt.notchGap > 0 ? this.opt.notchGap : (this.opt.notchGap = 10);
    nSt.value = this.opt.notchStyle || (this.opt.notchStyle = 'slit');
    const notchChanged = () => {
      this.opt.notchOn = nOn.checked;
      const v = +nGap.value;
      if (v >= 1) this.opt.notchGap = v; else nGap.value = this.opt.notchGap;
      this.opt.notchStyle = nSt.value;
      saveOpt(this.opt);
      if (this.result) this._render(this.result, this.objs);
    };
    nOn.onchange = nGap.onchange = nSt.onchange = notchChanged;

    /**
     * 🔴 「畫縫份／黏合片」（2026-10-19，`實驗-綜合評估.md` ①-7，kang「能夠變成選項…有需要時才會觸發」→「同意」）。
     * ⭐ 預設⛔ 勾（原本的圖一個字都不變）；勾不勾、每種材質的寬度記在瀏覽器裡（寬度預設照材質：帆布 1.5、紙模 1）。
     * ⚠ 只有材質有縫份或黏合片時才出現這一列（`_syncMarginBar()`）—— 珍珠板、壓克力、金屬出現了只會讓人困惑。
     * 寬度填錯（空白、0、負數）⇒ 退回上一個能用的值。
     */
    this.marginBar = $('uwMarginBar');
    this.marginIn = $('uwMargin');
    this.marginW = $('uwMarginW');
    this.marginIn.checked = !!this.opt.marginOn;
    if (!this.opt.marginW || typeof this.opt.marginW !== 'object') this.opt.marginW = {};
    const marginChanged = () => {
      this.opt.marginOn = this.marginIn.checked;
      const v = +this.marginW.value;
      if (v > 0) this.opt.marginW[this.opt.material] = v; else this.marginW.value = this._marginWidth();
      saveOpt(this.opt);
      if (this.result) this._render(this.result, this.objs);
    };
    this.marginIn.onchange = this.marginW.onchange = marginChanged;
    this._syncMarginBar();

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
    /**
     * 🔴 **「相同的折線合成一行」：同一份檔案開著的時候記住人自己勾的**（綜合評估 ⑤-16，2026-10-20，kang「同意你的建議」）。
     * 沒勾過 ⇒ 照舊照內容決定（有自己標過切線的物件 → 勾）；新建、開檔 ⇒ 回到照內容決定（`resetForNewDoc()`）。
     * 〔更正：這裡以前寫「⛔ 不存」，查過那是 AI 自己的註解、⛔ 是 kang 定的；kang 2026-10-09 定的只有「做成開關、關掉要提醒」〕
     */
    this.foldIn.checked = this._foldUser != null ? this._foldUser : this._targets().some(hasSeams);
    /** 第三批 b：每次打開都重新列「不平的面」（上一次按的「照現在這樣」只管那一次） */
    this._unflatAccepted = false;
    this.run();
  }

  /** ⑤-16：換了一份檔案（新建、開檔）⇒ 「合成一行」回到照內容決定 */
  resetForNewDoc() { this._foldUser = null; }

  /** 這次要展開的物件：沒選東西就整份文件 —— 一個案子通常就是要全部出圖 */
  _targets() {
    const picked = this.app.sel.objects;
    return picked.length ? picked : this.app.doc.objects;
  }

  /** 這個材質的縫份／黏合片預設多寬（cm）；0 ＝ 沒有（鈑金、珍珠板、壓克力）*/
  _marginDefault() {
    const M = MATERIALS[this.opt.material] || {};
    return M.seam || M.tab || 0;
  }

  /** 目前要畫多寬：使用者打過的優先，沒打過照材質 */
  _marginWidth() {
    const v = this.opt.marginW && this.opt.marginW[this.opt.material];
    return v > 0 ? v : this._marginDefault();
  }

  /** 換材質時：這一列要不要出現、寬度欄換成這個材質的數字 */
  _syncMarginBar() {
    if (!this.marginBar) return;
    const has = this._marginDefault() > 0;
    this.marginBar.hidden = !has;
    if (has) this.marginW.value = this._marginWidth();
  }

  /**
   * 卡片、SVG、列印、DXF 共用的選項 —— ⛔ 不要各組一份。
   * ⚠ `strainFill`（省道打版的拉伸色塊）預設開 —— 畫面、列印要；**存 SVG／DXF 的地方明講 `strainFill: false`**
   * （kang 2026-10-12：送去切的檔只放線）。
   */
  _drawOpt(extra = {}) {
    return {
      rule: this.result && this.result.rule, head: this.app.head,
      foldSummary: this.foldIn.checked,
      dartStyle: this.opt.dartStyle || 'cut', limit: this.opt.limit ?? '', strainFill: true,
      dartFolds: !!this.opt.dartFolds,
      notch: this.opt.notchOn ? { style: this.opt.notchStyle || 'slit', spacing: this.opt.notchGap || 10 } : null,
      /** 畫縫份／黏合片（`out/sheet.js` `marginGeometry()`）：材質沒有縫份／黏合片時給了也不畫 */
      margin: this.opt.marginOn && this._marginDefault() > 0 ? { on: true, w: this._marginWidth() } : null,
      ...extra
    };
  }

  /**
   * ⚠ 關掉時通知一聲（2026-10-12）：分片模式的即時預覽「跟著這裡選的展開方式」——
   * 在這裡改了展開方式或材料，關掉之後右邊的預覽要跟著換（⛔ 留著舊的騙人）。
   */
  close() {
    this.el.hidden = true;
    if (this.app.onUnfoldClosed) this.app.onUnfoldClosed();
  }

  get isOpen() { return !this.el.hidden; }

  // ── 算一次並重畫 ────────────────────────────────────

  run() {
    saveOpt(this.opt);
    const objs = this._targets();
    const r = unfoldMany(objs, { material: this.opt.material, mode: this.mode });
    this.result = r;
    this.objs = objs;
    this._render(r, objs);
  }

  _render(r, objs) {
    this.body.innerHTML = '';

    const s = r.stats;
    /**
     * ⑤-16（2026-10-20）：**只展開選到的就講出來**（以前標題只有「1 種 1 片」，補測選了盒身以為整份只有一片）。
     * 沒選東西 ⇒ 展開整份，⛔ 多講。
     */
    const all = this.app.doc.objects.length, n = (objs || []).length;
    const only = this.app.sel.objects.length && n < all ? `只展開選到的 ${n} 個（共 ${all} 個；沒選東西就是全部）　` : '';
    this.sum.textContent = r.pieces.length
      ? only + `${s.pieces} 種、共 ${s.total} 片　總面積 ${fmt(s.area / 10000)} m²　`
        + `折彎 ${s.arcBends + s.sharpBends} 道`
      : only + '沒有可以展開的東西';

    if (this._matNote) { this.body.appendChild(box('uwSkip', this._matNote)); this._matNote = null; }
    this._renderUnflat(objs || []);
    for (const msg of r.skipped) this.body.appendChild(box('uwSkip', msg));
    for (const w of r.warnings) this.body.appendChild(box('uwWarn', '⚠ ' + w));
    /** 第三輪第二批 A：有平滑細分的 ⇒ 展開照粗網格，講跟列印、剖面差多少（kang「① 乙 三個視窗都講 ② 差 ≥ 2% 黃字」）*/
    for (const o of objs || []) { const sn = smoothExitNote(o, 'unfold'); if (sn) this.body.appendChild(box(sn.level === 'caution' ? 'uwCaution' : 'uwSkip', sn.text)); }

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

    /** 對位記號打勾了、卻一個都畫不出來 → 講原因（⛔ 讓人以為開關壞了） */
    if (this.opt.notchOn && r.pieces.length && !r.pieces.some(p => p.seamRuns && p.seamRuns.length)) {
      this.body.appendChild(box('uwSkip',
        '對位記號只畫在有接合編號的縫上 —— 這次展開的物件都沒有標過分片，所以一個都沒有'));
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
      + r.pieces.map(p => `<tr><td>${esc(p.name)}</td><td>${p.qty}${esc(qtyWords(p))}</td>`
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
    return packBoards(this.result.pieces, { w: N.w, h: N.h, gap: N.gap, rotate: N.rotate, margin: this._drawOpt().margin });
  }

  /** 每張板的「畫什麼」與標題 —— 畫面、SVG、DXF、列印共用，⛔ 不各排一次（存檔時傳 `{ strainFill: false }`）*/
  _boardSheets(extra = {}) {
    const nest = this._nest();
    const opt = this._drawOpt({ label: p => p.no, ...extra });
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
    const normal = sheets.length - big;
    /** ⚠ 全部都比板子大時⛔ 寫「需要 0 張」（數字對、意思怪 —— 2026-10-09 AI 線上看到的）*/
    const head = box(big ? 'uwWarn' : 'uwSkip',
      (normal ? `排版：需要 ${normal} 張 ${fmt(N.w)} × ${fmt(N.h)} cm 的板子`
              : `排版：沒有一片擺得進 ${fmt(N.w)} × ${fmt(N.h)} cm 的板子`)
      /**
       * ⚠ 2026-10-21（T11：`實驗-匯入狐狸存錢筒.md` 不足 4）：智慧分切「放得進板子」照**提案當下**的板子算 ——
       * 先提案、後改小板子就會放不下；回分片重新提案會照現在的板子切小（狐狸改 A3 只多 1 條縫就全部放得下）。
       */
      + (big ? `　⚠ ${normal ? '另有 ' : ''}${big} 片比板子還大，各自單獨一張（要換大板或再切小 —— `
        + '回「分片」按「智慧分切：提案」重新提案，會照現在的板子把大片切小）' : '')
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
    const ok = this.opt.nest.on
      ? printSVGs(this._boardSheets().map(sh => progSVG(sh.prog, sh.title)), '排版')
      : printPieces(this.result.pieces, this._drawOpt());
    if (ok === false) { this._say(PRINT_BLOCKED); if (this.app.toast) this.app.toast(PRINT_BLOCKED, true); }
  }

  /**
   * 匯出的共同規矩：**內容一律同步準備好，才去 await 存檔**。
   * showSaveFilePicker() 要在使用者按鈕的手勢還有效時呼叫，
   * 先 await 別的東西手勢就過期，瀏覽器會直接拒絕（見 out/save.js）。
   */
  async _saveSVG() {
    if (!this._has()) return;
    if (!(await this._unflatSaveOk())) return;
    if (this.opt.nest.on) {
      // 🔴 排版開著：一張板一個檔（kang 2026-10-09）
      const jobs = this._boardSheets({ strainFill: false }).map((sh, i) => ({
        name: `${this._base()}_板${String(i + 1).padStart(2, '0')}.svg`,
        blob: textBlob(progSVG(sh.prog, sh.title), 'image/svg+xml')
      }));
      const n = await saveMany(jobs, this.opt.askPath);
      if (n > 1) this._say(`已存 ${n} 個 SVG（一張板一個檔）。`);
      return;
    }
    const opt = this._drawOpt({ strainFill: false });
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
    if (!(await this._unflatSaveOk())) return;
    if (this.opt.nest.on) {
      // 🔴 排版開著：一張板一個檔（kang 2026-10-09）。標題只能英數（R12）
      const sheets = this._boardSheets({ strainFill: false });
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
    const blob = textBlob(toDXF(this.result.pieces, this._drawOpt({ unit: this.opt.unit, strainFill: false })),
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

  /**
   * 🔴 **輸出前檢查：不平的面**（網格核心第三批 b，kang 2026-10-23 → `規格\建模器-網格核心.md` 第 6 節）。
   * 有不平的面 ⇒ 最上面一條琥珀色的清單：每個面「拆開」「壓平」，或全部拆開／全部壓平／照現在這樣（近似）。
   * ⭐ **只提醒不擋**（早期定的：程式沒資格替人決定做不做得出來）⇒ 展開圖照樣畫，按「照現在這樣」就收成一行、
   * 　存 SVG／DXF 時還有不平的面再問一次（`_unflatSaveOk()`）。
   * 判斷照 `edit.js` `nonPlanarFaces()`（跟 3D 畫面的琥珀色、編輯提示同一支）。
   */
  _renderUnflat(objs) {
    const items = [];
    for (const obj of objs) for (const x of nonPlanarFaces(obj.mesh())) items.push({ obj, face: x.face, dev: x.dev });
    this._unflat = items;
    if (!items.length) return;
    const worst = items.reduce((m, x) => Math.max(m, x.dev), 0);
    const wrap = document.createElement('div');
    wrap.className = 'uwUnflat';
    const head = document.createElement('div');
    head.textContent = `有 ${items.length} 個面不平（最遠 ${worst.toFixed(3)} cm），展開圖上這幾片是近似的`;
    wrap.appendChild(head);
    const btn = (label, title, fn) => {
      const b = document.createElement('button');
      b.textContent = label; b.title = title; b.onclick = fn;
      return b;
    };
    if (this._unflatAccepted) {
      head.textContent += '（照現在這樣）';
      wrap.appendChild(btn('列出來', '再把不平的面列出來，選拆開或壓平', () => { this._unflatAccepted = false; this._render(this.result, this.objs); }));
      this.body.appendChild(wrap);
      return;
    }
    const SHOW = 20;
    const no = new Map();
    const table = document.createElement('table');
    for (const it of items.slice(0, SHOW)) {
      no.set(it.obj, (no.get(it.obj) || 0) + 1);
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = `${it.obj.name}・面 ${no.get(it.obj)}　偏離 ${it.dev.toFixed(3)} cm`;
      a.title = '在 3D 畫面選起這個面';
      a.onclick = e => { e.preventDefault(); this.app.unflatPick(it.obj, it.face); };
      td.appendChild(a);
      const tdB = document.createElement('td');
      tdB.append(btn('拆開', '沿最短的對角線拆到平，新的折線看得到；形狀不變', () => this.app.fixUnflat('split', [it])),
        btn('壓平', '把這個面壓平；形狀會變一點，旁邊的面可能跟著不平', () => this.app.fixUnflat('flatten', [it])));
      tr.append(td, tdB);
      table.appendChild(tr);
    }
    wrap.appendChild(table);
    if (items.length > SHOW) wrap.appendChild(box('dim', `……另外還有 ${items.length - SHOW} 個（用下面的「全部」一起處理）`));
    const row = document.createElement('div');
    row.append(btn('全部拆開', '每個不平的面都沿最短的對角線拆到平；形狀不變', () => this.app.fixUnflat('split', items)),
      btn('全部壓平', '每個不平的面都壓平；形狀會變一點', () => this.app.fixUnflat('flatten', items)),
      btn('照現在這樣（近似）', '不處理，照現在的樣子展開（這幾片的尺寸是近似的）；存 SVG／DXF 時會再問一次',
        () => { this._unflatAccepted = true; this._render(this.result, this.objs); }));
    wrap.appendChild(row);
    this.body.appendChild(wrap);
  }

  /** 存 SVG／DXF 前：還有不平的面 ⇒ 再問一次（第三批 b）。⚠ 按「照現在這樣」的那一次也要問 —— 那是看圖，存檔是交出去 */
  async _unflatSaveOk() {
    const items = this._unflat || [];
    if (!items.length) return true;
    const worst = items.reduce((m, x) => Math.max(m, x.dev), 0);
    return ask(`還有 ${items.length} 個面不平（最遠 ${worst.toFixed(3)} cm），存出來的這幾片是近似的。`
      + '照現在這樣存嗎？（要處理就按「取消」，用展開圖上方的「拆開」或「壓平」）');
  }
}

/** 這個物件有沒有自己標過切線（＝ 打版那一類）。參數物件標不了，網格算不出來也當沒有 */
function hasSeams(o) {
  if (!o || o.isParametric) return false;
  try { return seamCount(o.mesh()) > 0; } catch (e) { return false; }
}

/**
 * 列印視窗被瀏覽器擋掉（`printSVGs()` 回傳 false）⇒ 講出來（2026-10-19，補測：`實驗-綜合評估.md` ②-13）。
 * ⚠ 以前兩個面板都沒看回傳值 ⇒ 按了完全沒反應，跟「壞了」分不出來。
 */
const PRINT_BLOCKED = '瀏覽器擋掉了列印視窗 —— 請在網址列允許這個網站開彈出視窗，或改用「存 SVG」再用別的程式印';

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
