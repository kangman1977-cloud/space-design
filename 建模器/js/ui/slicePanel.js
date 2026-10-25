/**
 * slicePanel.js — 剖面分切視窗
 *
 * 第三條生產路徑的介面：把立體切成一疊板，每片一張輪廓，
 * 切完照號碼疊起來黏合。
 *
 * ── 這個視窗上最重要的東西不是預覽圖，是那兩行數字 ────────
 * 「疊到多高 / 模型多高」與「定位孔最糟的那一片還剩多少」。
 * 前者決定東西做出來是不是正確的高度，後者決定串不串得起來，
 * 而兩者都是切完料才會發現的錯 —— 所以要在按匯出之前就講。
 *
 * 介面沿用展開視窗那一套（同一組 .uw* 樣式），不必再學一次。
 * 算什麼在 slice/，畫什麼在 out/，這裡只收設定、排結果、接按鈕。
 */

import { sliceMany, stackBounds, AXES, AXIS_KEYS, DEFAULT_AXIS, FIT_TOL, TINY_PIECE_CM, MIN_GLUE_CM2, isHollowSheet, sheetNotes, uncutObjects }
  from '../slice/section.js';
import { findPegs, checkPegs, pegsForSlice, pegSpans, peg1Cover, manualPegs, holesFromAuto, PEG_DEFAULTS } from '../slice/pegs.js';
import { sliceProgram, sliceTitleLines, renderCanvas, progSVG, printSVGs }
  from '../out/sheet.js';
import { sliceDXF, sliceBoardDXF, fitDXF, UNITS } from '../out/dxf.js';
import { saveBlob, saveMany, textBlob, safeName, canChoosePath, TYPES } from '../out/save.js';
import { sliceBoards, sliceBoardTitle, NEST_DEFAULTS } from '../out/nest.js';
import { StackView } from './stackView.js';
import { interlockMany, INTERLOCK_DEFAULTS, SPINE_N_MAX, suggestRibs, topOutline } from '../slice/interlock.js';
import { RibMapView } from './ribMapView.js';
import { fitComb, fitSVG, FIT_DEFAULTS, FIT_N_MIN, FIT_N_MAX } from '../slice/fitTest.js';
import { PegMapView } from './pegMapView.js';
import { smoothExitNote, smoothFlipNote } from '../out/smoothNote.js';

const LS_KEY = 'modeler_slice';
/** 展開圖的設定（排版那一包第一次沿用它，kang 2026-10-14）*/
const LS_UNFOLD = 'modeler_unfold';

/** 預覽最多畫幾片。再多就只是拖慢畫面，數字與匯出不受影響。 */
const PREVIEW_MAX = 120;

export class SlicePanel {
  /** @param {object} app { doc, sel, head } */
  constructor(app) {
    this.app = app;
    this.opt = {
      axis: DEFAULT_AXIS,
      // n 空字串 ＝ 剩下的填滿；holes ＝ 這一段要幾個孔
      bands: [{ t: 1.0, n: '', holes: PEG_DEFAULTS.count }],
      d: PEG_DEFAULTS.d,
      gap: PEG_DEFAULTS.gap,
      tinyCm: TINY_PIECE_CM,
      minGlueCm2: MIN_GLUE_CM2,
      unit: 'mm',
      askPath: true,
      ...loadOpt()
    };
    /**
     * 🔴 **做法：疊層／互卡**（2026-10-24 第二輪第六批 6a，kang「放在剖面分切視窗「做法：疊層／互卡」…預設照表」）。
     * 做法、側面方向跟模型走（新建、開檔回到疊層、自動）；板厚、肋間距、槽寬加減、槽各佔幾成、槽口張開跟人走。
     */
    if (this.opt.method !== 'interlock') this.opt.method = 'stack';
    this.opt.il = { ...INTERLOCK_DEFAULTS, ...(this.opt.il || {}) };
    /** 6b 試卡片（kang「…預設照表（7 格、每格 0.1 mm…）」）：幾格、每格差 ⇒ 跟人走（跟槽寬加減一起記著）*/
    this.opt.fit = { ...FIT_DEFAULTS, ...(this.opt.fit || {}) };
    if (!Array.isArray(this.opt.bands) || !this.opt.bands.length) {
      this.opt.bands = [{ t: 1.0, n: '', holes: PEG_DEFAULTS.count }];
    }
    // 舊的存檔沒有 holes 這個欄位，補上預設值
    for (const b of this.opt.bands) if (b.holes == null) b.holes = PEG_DEFAULTS.count;
    /**
     * 🔴 **排版到板子上**（2026-10-14，kang：「展開圖有可以設定排版…剖面分切也要有」）。
     * 板子設定**各自記**；⭐ 第一次（剖面這邊還沒有）就**沿用展開圖現在的**，⛔ 讓人再打一次（kang 選的）。
     */
    if (!this.opt.nest) {
      let u = null;
      try { u = (JSON.parse(localStorage.getItem(LS_UNFOLD)) || {}).nest || null; } catch (e) { /* 沒有就用預設 */ }
      this.opt.nest = { ...NEST_DEFAULTS, ...(u || {}) };
    } else {
      this.opt.nest = { ...NEST_DEFAULTS, ...this.opt.nest };
    }
    /**
     * 🔴 **立體預覽**（2026-10-24 第二輪第五批 5b，kang「方案一…預設＋可以調照表」）：
     * 收起來、拉開、只看有問題的、原模型 ⇒ 跟人走（跟孔徑一起記著）；只看第幾片 ⇒ 跟模型走（`resetForNewDoc()`）。
     */
    this.opt.stack3d = { open: true, explode: false, faint: false, ghost: true, ...(this.opt.stack3d || {}) };
    this.result = null;
    this.pegs = null;
    this._build();
    this.stack3d = new StackView(this.opt.stack3d, () => save(this.opt), i => this._jumpCard(i));
    /**
     * 🔴 **手動放孔**（2026-10-24 第二輪第五批 5c，kang「方案二孔位圖…預設＋可以調照表」）：
     * `opt.manualPegs` ＝ `{ axis, holes }`；沒有 ＝ 自動（預設）。跟分段表一樣**跟模型走**：記在瀏覽器、
     * 新建、開檔、換切片方向就清掉回到自動；⛔ 存進專案檔（⑤-24 說好之後再說的那件）。
     */
    this.pegMap = new PegMapView({
      onManual: () => this._toManual(),
      onAuto: () => this._toAuto(),
      onChange: holes => this._setHoles(holes)
    });
    /**
     * 🔴 **肋位圖**（2026-10-25 第二輪第六批 6c，kang「肋可以挪＋側面 1～3 片，肋位圖，要「幫我挪有問題的肋」按鈕（按了才算），預設照表」）：
     * `opt.manualRibs` ＝ `{ spineAx, spines, ribs }`（世界座標 cm）；沒有 ＝ 自動（預設：側面照片數放、肋等間距）。
     * 跟 5c 手動的孔一樣**跟模型走**：記在瀏覽器、新建、開檔、換側面方向就清掉回到自動；⛔ 存進專案檔。
     */
    this.ribMap = new RibMapView({
      onManual: () => this._toManualRibs(),
      onAuto: () => this._toAutoRibs(),
      onChange: c => this._setRibs(c),
      onSuggest: () => this._suggestRibs()
    });
    this._ribNote = '';
    this._outline = null; this._outlineKey = '';
  }

  // ── 畫面骨架 ────────────────────────────────────────

  _build() {
    const el = document.createElement('div');
    el.id = 'sliceWin';
    el.className = 'uwWin';
    el.hidden = true;
    el.innerHTML = `
      <div class="uwBack"></div>
      <div class="uwBox">
        <div class="uwHead">
          <b>剖面分切</b>
          <span class="uwSum" id="slSum"></span>
          <button class="mini" id="slClose">關閉</button>
        </div>
        <div class="uwBar">
          <span class="lbl">做法</span><select id="slMethod"><option value="stack">疊層</option><option value="interlock">互卡（側面＋橫肋）</option></select>
          <span class="sp"></span>
          <span class="slMode" id="slStackOnly">
          <span class="lbl">切片軸</span><select id="slAxis"></select>
          <span class="sp"></span>
          <span class="lbl">孔徑 cm</span>
          <input type="number" id="slD" step="0.05" min="0" style="width:70px">
          <span class="lbl">淨距 cm</span>
          <input type="number" id="slGap" step="0.1" min="0" style="width:70px">
          <span class="lbl">小塊提醒 cm</span>
          <input type="number" id="slTiny" step="0.1" min="0" style="width:60px">
          <span class="lbl">黏著提醒 cm²</span>
          <input type="number" id="slGlue" step="0.05" min="0" style="width:60px">
          <label class="uwCk" title="勾了：每一片取那一段厚度裡最大的外形（寧大勿小，疊好之後再磨），比板子薄的部分不會不見。沒勾：取每一片正中間的截面（曲面還原得最準）"><input type="checkbox" id="slMax"> 照最大外形切</label>
          </span>
          <span class="sp"></span>
          <span class="lbl">板件</span><select id="slSheet" title="板件（種類是「板件」的開放曲面，例如旋轉成形的燈罩）怎麼切：空心 ＝ 照它的板厚切成一圈一圈的環（跟 3D 列印一樣）；實心 ＝ 被那一圈包住的地方都算料（以前的做法）"><option value="hollow">空心（照板厚）</option><option value="solid">實心</option></select>
          <span class="sp"></span>
          <span class="lbl">DXF 單位</span><select id="slUnit"></select>
          <label class="uwCk"><input type="checkbox" id="slAsk"> 指定存放位置</label>
          <span class="sp"></span>
          <button id="slPrint">列印</button>
          <button id="slSvg">存 SVG</button>
          <button id="slDxf">存 DXF</button>
        </div>
        <div class="uwBar" id="slILBar" title="互卡：正中間一片側面＋一排等間距的肋，交叉的地方各開一半的槽卡在一起（不用膠、不用串桿）">
          <span class="lbl">側面</span><select id="slILSpine"><option value="auto">自動（挑掉下來少的那邊）</option><option value="x">從 X 切</option><option value="z">從 Z 切</option></select><select id="slILSpineN"><option value="1">1 片</option><option value="2">2 片</option><option value="3">3 片</option></select>
          <span class="lbl">板厚 cm</span><input type="number" id="slILT" step="0.1" min="0.05" style="width:60px">
          <span class="lbl">肋間距 cm</span><input type="number" id="slILSp" step="0.5" min="0.2" style="width:60px">
          <span class="lbl">槽寬加減 cm</span><input type="number" id="slILAdj" step="0.01" style="width:64px">
          <span class="lbl">肋那邊佔</span><input type="number" id="slILShare" step="0.1" min="0.1" max="0.9" style="width:56px">
          <span class="lbl">槽口張開 cm</span><input type="number" id="slILFlare" step="0.05" min="0" style="width:60px">
          <span class="sp"></span>
          <span class="lbl">試卡片</span><input type="number" id="slFitN" step="1" min="3" max="9" style="width:44px"><span class="lbl">格　每格差 mm</span><input type="number" id="slFitStep" step="0.05" min="0.01" style="width:56px">
          <button id="slFit">存試卡片</button>
        </div>
        <div class="uwBar" title="排版：把很多片自動擺進一張一張板子裡，存 SVG／DXF 時一張板一個檔。不同板厚的片放在不同張。關掉就回到原本的存法（SVG 一片一個檔、DXF 全部一個檔）">
          <label class="uwCk"><input type="checkbox" id="slNest"> 排版到板子上</label>
          <span class="lbl">板寬</span><input type="number" id="slNW" min="1" step="1" style="width:64px">
          <span class="lbl">板高</span><input type="number" id="slNH" min="1" step="1" style="width:64px">
          <span class="lbl">間距</span><input type="number" id="slNG" min="0" step="0.5" style="width:52px">
          <span class="lbl">cm</span>
          <label class="uwCk" title="板材有紋路時（木板）轉了方向會不一樣 —— 需要時才打開"><input type="checkbox" id="slNR"> 可以轉 90°</label>
        </div>
        <div class="uwBody" id="slBody"></div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;

    const $ = id => el.querySelector('#' + id);
    this.body = $('slBody');
    this.sum = $('slSum');

    const ax = $('slAxis');
    for (const k of AXIS_KEYS) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = AXES[k].label;
      ax.appendChild(o);
    }
    ax.value = this.opt.axis;
    ax.title = '沿哪個方向一片一片切下去。疊層件通常是 Y（水平切），'
             + '因為那樣每一片都是平放在板材上';
    ax.onchange = () => { this.opt.axis = ax.value; this.run(); };

    /**
     * 🔴 **照最大外形切（寧大勿小）**（2026-10-19，實驗 T2：帽簷 0.4 cm 遇到 1 cm 的板整個不見）。
     * kang：「三條都照你的建議做」—— 預設⛔ 勾（照舊取中間），漏掉時 `sliceMany()` 會講；勾了 ⇒ `slabShadow()`。
     */
    const mx = $('slMax');
    mx.checked = !!this.opt.maxOutline;
    mx.onchange = () => { this.opt.maxOutline = mx.checked; this.run(); };

    /**
     * 🔴 **板件：空心（照板厚）／實心**（第三輪第一批 ②，kang 2026-10-26「② 丙 板件空心／實心一格、預設空心」）。
     * 以前板件（開放曲面）照「被一圈包住就是料」切 ⇒ T18 燈罩 60 片切成實心圓片（約 3 萬 cm³），同一個物件 3D 列印卻是 2 mm 空心殼。
     * 預設空心：板件先照板厚加厚（跟 3D 列印、畫面同一支 `sheetShell()`）再切 ⇒ 一圈一圈的環；疊層、互卡都照這一格。跟人走。
     */
    const sh = $('slSheet');
    sh.value = this.opt.sheet === 'solid' ? 'solid' : 'hollow';
    sh.onchange = () => { this.opt.sheet = sh.value; this.run(); };

    const unit = $('slUnit');
    for (const k of Object.keys(UNITS)) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = UNITS[k].label;
      unit.appendChild(o);
    }
    unit.value = this.opt.unit;
    unit.title = '雷切／CNC 廠通常收 mm';
    unit.onchange = () => { this.opt.unit = unit.value; save(this.opt); };

    this.dIn = $('slD');
    this.dIn.value = this.opt.d;
    this.dIn.title = '串桿的直徑。竹籤大概 0.3、M4 螺桿 0.4、M5 螺桿 0.5';
    this.dIn.onchange = () => {
      this.opt.d = num(this.dIn.value, PEG_DEFAULTS.d);
      this.run();
    };

    this.gapIn = $('slGap');
    this.gapIn.value = this.opt.gap;
    this.gapIn.title = '孔的邊緣離料的邊緣至少要留多少。留太少疊起來會裂開';
    this.gapIn.onchange = () => {
      this.opt.gap = num(this.gapIn.value, PEG_DEFAULTS.gap);
      this.run();
    };

    /** 第二輪 ②-7（kang「小塊門檻預設 1 cm、可以改」）：跟人走（跟孔徑、淨距一起記著）；0 ＝ 不提醒小塊 */
    this.tinyIn = $('slTiny');
    this.tinyIn.value = this.opt.tinyCm;
    this.tinyIn.title = `外框短邊比這個還小的塊要提醒（容易斷、容易掉）。預設 ${TINY_PIECE_CM} cm；填 0 ＝ 不提醒`;
    this.tinyIn.onchange = () => {
      this.opt.tinyCm = Math.max(0, num(this.tinyIn.value, TINY_PIECE_CM));
      this.run();
    };

    /** 第二輪第五批 5a（kang「只黏一點點的門檻預設 0.25 cm² 可以改」）：跟人走；0 ＝ 不提醒只黏一點點（掉下來的照樣講）*/
    this.glueIn = $('slGlue');
    this.glueIn.value = this.opt.minGlueCm2;
    this.glueIn.title = `相鄰兩片黏到的面積比這個小就提醒「只黏一點點，容易斷」，排版預覽塗黃。預設 ${MIN_GLUE_CM2} cm²（約 5 × 5 mm）；填 0 ＝ 不提醒`;
    this.glueIn.onchange = () => {
      this.opt.minGlueCm2 = Math.max(0, num(this.glueIn.value, MIN_GLUE_CM2));
      this.run();
    };

    this.askIn = $('slAsk');
    this.askIn.checked = !!this.opt.askPath;
    this.askIn.parentElement.title = canChoosePath()
      ? '存檔時跳「另存新檔」讓你選資料夾'
      : '這個開啟方式不支援（瀏覽器只在 https 或 localhost 開放此功能），'
        + '本機用內網 IP 開會自動退回一般下載。線上版可以用';
    if (!canChoosePath()) this.askIn.parentElement.classList.add('off');
    this.askIn.onchange = () => { this.opt.askPath = this.askIn.checked; save(this.opt); };

    // ── 排版（跟展開圖同一套寫法）──
    const N = this.opt.nest;
    const nestIn = { on: $('slNest'), w: $('slNW'), h: $('slNH'), gap: $('slNG'), rotate: $('slNR') };
    nestIn.on.checked = !!N.on; nestIn.rotate.checked = !!N.rotate;
    nestIn.w.value = N.w; nestIn.h.value = N.h; nestIn.gap.value = N.gap;
    const nestChanged = () => {
      N.on = nestIn.on.checked; N.rotate = nestIn.rotate.checked;
      /** 填錯（空白、0、負數）就退回上一個能用的值 —— ⛔ 不讓排版算出一個不存在的板子 */
      for (const k of ['w', 'h']) { const v = +nestIn[k].value; if (v > 0) N[k] = v; else nestIn[k].value = N[k]; }
      const gv = +nestIn.gap.value; if (gv >= 0) N.gap = gv; else nestIn.gap.value = N.gap;
      save(this.opt);
      if (this.result) this._render();
    };
    for (const k of Object.keys(nestIn)) nestIn[k].onchange = nestChanged;

    /** 6a：做法、互卡那一排 */
    ensureModeStyle();
    const meth = $('slMethod');
    meth.value = this.opt.method;
    meth.title = '疊層：一片一片疊起來黏、串桿對位。互卡：正中間一片側面＋一排肋，開槽卡在一起，用料只有疊層的 2 成左右';
    meth.onchange = () => { this.opt.method = meth.value; this._applyMethod(); this.stack3d.reset(); this.run(); };     // 零件整個換掉 ⇒ 立體預覽的「只看第幾片」回到全部（本機抓到）
    const IL = this.opt.il;
    const ilIn = { spine: $('slILSpine'), spineN: $('slILSpineN'), t: $('slILT'), spacing: $('slILSp'), slotAdj: $('slILAdj'), share: $('slILShare'), flare: $('slILFlare') };
    this.ilIn = ilIn;
    ilIn.spine.title = '側面從哪個方向切正中間。自動 ＝ X、Z 兩個方向都切一次，挑掉下來少的那邊（一樣多就挑水平方向比較窄的那一邊：袋鼠、野牛、汽車都是側面；飛機翼展比機身長，會挑沿著機身的那邊）';
    ilIn.spineN.title = `側面幾片（1～${SPINE_N_MAX}）。預設 ${INTERLOCK_DEFAULTS.spineN} 片（正中間）；2 片 ＝ 寬的 1/3、2/3；3 片 ＝ 1/4、1/2、3/4 —— 腳張開的（樹蛙）多片比較撐得住，一般的模型 1 片就夠`;
    ilIn.t.title = `板厚（也是槽寬）。預設 ${INTERLOCK_DEFAULTS.t} cm`;
    ilIn.spacing.title = `肋每幾 cm 一片。預設 ${INTERLOCK_DEFAULTS.spacing} cm`;
    ilIn.slotAdj.title = '槽寬 ＝ 板厚 ＋ 這個數字。正的比較鬆、負的比較緊。程式不會自動補切口（切口由人工處理），第一次先試鬆緊';
    ilIn.share.title = '交叉的地方，肋那邊的槽佔幾成（0.5 ＝ 一半一半）';
    ilIn.flare.title = `槽口每邊張開多少（45°），比較好插。預設 ${INTERLOCK_DEFAULTS.flare} cm；0 ＝ 不張開`;
    for (const k of Object.keys(ilIn)) {
      ilIn[k].value = IL[k];
      ilIn[k].onchange = () => {
        if (k === 'spine') IL.spine = ilIn.spine.value;
        else if (k === 'spineN') IL.spineN = +ilIn.spineN.value;
        if (k === 'spine' || k === 'spineN') this.opt.manualRibs = null;     // 6c：換側面方向、片數 ⇒ 手動挪過的肋清掉回到自動
        else { const v = parseFloat(ilIn[k].value); if (Number.isFinite(v)) IL[k] = v; else ilIn[k].value = IL[k]; }
        this.run();
      };
    }
    /**
     * 6b 試卡片：幾格、每格差 —— 填錯（空白、超出 3～9、0 或負的）退回上一個能用的值；改了只重畫（⛔ 重切）。
     * 中間那格 ＝ 現在的「槽寬加減」，所以挑好填回去、再存一次就以新的數字為中間。
     */
    const fitIn = { n: $('slFitN'), stepMm: $('slFitStep') };
    fitIn.n.title = `試卡片一排幾格（${FIT_N_MIN}～${FIT_N_MAX}）。預設 ${FIT_DEFAULTS.n}`;
    fitIn.stepMm.title = `試卡片每一格的槽寬差幾 mm。預設 ${FIT_DEFAULTS.stepMm} mm`;
    for (const k of Object.keys(fitIn)) {
      fitIn[k].value = this.opt.fit[k];
      fitIn[k].onchange = () => {
        const v = parseFloat(fitIn[k].value);
        const okv = k === 'n' ? Number.isInteger(v) && v >= FIT_N_MIN && v <= FIT_N_MAX : v > 0;
        if (okv) this.opt.fit[k] = v; else fitIn[k].value = this.opt.fit[k];
        save(this.opt);
        if (this.result) this._render();
      };
    }
    $('slFit').title = '先切這一片試槽的鬆緊：一排幾格、每格槽寬差一點，中間那格 ＝ 現在的槽寬加減。存成單獨一個 DXF（不跟零件放在一起 —— 先切它、挑好數字再切零件）';
    $('slFit').onclick = () => this._saveFit();
    this._applyMethod();

    $('slClose').onclick = () => this.close();
    el.querySelector('.uwBack').onclick = () => this.close();
    $('slPrint').onclick = () => this._print();
    $('slSvg').onclick = () => this._saveSVG();
    $('slDxf').onclick = () => this._saveDXF();

    window.addEventListener('keydown', e => {
      // ⚠ 關掉之後⛔ 不再往下傳 —— 不然主畫面的 Esc 會接著清掉選取（2026-10-08 E2）
      if (!this.el.hidden && e.key === 'Escape') { e.stopImmediatePropagation(); this.close(); return; }
      // 5c：孔位圖選到孔時 Delete 刪孔（⚠ 主畫面那邊視窗開著時本來就⛔ 接 Delete —— 這裡再擋一次，⛔ 往下傳）
      if (!this.el.hidden && this.pegMap.onKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
      // 6c：肋位圖選到肋時 Delete 刪肋（同上）
      else if (!this.el.hidden && this.ribMap.onKey(e)) { e.preventDefault(); e.stopImmediatePropagation(); }
    });
  }

  /** 6a：疊層才有的那幾格（切片軸、孔徑…）、互卡才有的那一排，照做法藏起來 */
  _applyMethod() {
    const il = this.opt.method === 'interlock';
    this.el.querySelector('#slStackOnly').hidden = il;
    this.el.querySelector('#slILBar').hidden = !il;
  }

  open() { this.el.hidden = false; this.run(); }
  close() { this.el.hidden = true; }
  get isOpen() { return !this.el.hidden; }

  /**
   * 🔴 **新建、開檔 ⇒ 跟著模型走的設定回到預設**（綜合評估 ⑤-24，2026-10-20，kang「同意你的建議」）。
   * 以前整包記在瀏覽器 ⇒ 補測新建一個方塊，帶出了 T6 的「1 cm × 2 ＋ 0.5 cm」。
   * | 回到預設（跟模型走）| 照舊記著（跟人走）|
   * |---|---|
   * | 切的方向、分段表（板厚、片數、孔數）、照最大外形切 | 孔徑、離邊、DXF 單位、存檔時選資料夾、排版的板子 |
   * ⭐ 業界的分法一樣：Fusion 360 單位跟著每一份設計、另有一份「我的預設」給新設計（Autodesk 官方教學）。
   * ⚠ 存進檔案、開檔時還原那一份分段表 ⇒ 要改存檔格式，之後再說（`實驗-綜合評估.md` ⑤-24）。
   */
  resetForNewDoc() {
    this.opt.axis = DEFAULT_AXIS;
    this.opt.bands = [{ t: 1.0, n: '', holes: PEG_DEFAULTS.count }];
    this.opt.maxOutline = false;
    this.opt.manualPegs = null;     // 5c：手動的孔跟模型走
    this.opt.method = 'stack';      // 6a：做法、側面方向跟模型走
    this.opt.il.spine = 'auto';
    this.opt.manualRibs = null;     // 6c：手動挪過的肋跟模型走
    this._ribNote = '';
    this._outline = null; this._outlineKey = '';
    const $ = id => this.el.querySelector('#' + id);
    $('slMethod').value = 'stack';
    $('slILSpine').value = 'auto';
    this._applyMethod();
    $('slAxis').value = this.opt.axis;
    $('slMax').checked = false;
    this.result = null;
    this.pegs = null;
    this.stack3d.reset();
    save(this.opt);
    if (this.isOpen) this.run();
  }

  // ── 算一次並重畫 ────────────────────────────────────

  /**
   * 🔴 **先講「正在算」、下一輪才算**（2026-10-24，第二輪 ⑤-1；跟匯入視窗同一招）。
   * 以前按「剖面分切」或改設定就直接算：汽車（54 萬面）畫面停住 6.9 秒、什麼字都沒有，看起來像當掉。
   * ⚠ 算的時候畫面照樣停住（同一條執行緒）—— 只是先講；連續改好幾次只算最後一次。
   * ⚠ ⛔ 用 requestAnimationFrame 等畫面：視窗在背景時它不會跑 ⇒ 永遠不算。
   */
  run() {
    clearTimeout(this._runT);
    showBusy(this.body, '正在算剖面…（大的模型要幾秒，算的時候畫面會停住）');
    this._runT = setTimeout(() => this._runNow(), BUSY_MS);
  }

  _runNow() {
    /** 5c：換了切片方向 ⇒ 手動的孔清掉回到自動 —— ⚠ 要在存之前清（本機抓到：先存後清，重新整理又跑回來）*/
    if (this.opt.manualPegs && this.opt.manualPegs.axis !== this.opt.axis) this.opt.manualPegs = null;
    save(this.opt);
    const picked = this.app.sel.objects;
    const objs = picked.length ? picked : this.app.doc.objects;

    // 切的是世界座標下的樣子 —— 物件被搬過、轉過、縮放過都要吃進去，
    // 否則圖跟畫面上看到的東西不一樣大也不一樣位置。
    const hollow = this.opt.sheet !== 'solid';      // 第三輪第一批 ②：板件預設照板厚切成空心
    const shelledT = [];
    const pairs = objs.map(o => {
      try {
        let m = o.smoothMesh();     // 第八批 8a：有平滑細分的照平滑後的（kang「⑤ 量測列印剖面看平滑後」）
        if (hollow && isHollowSheet(o, m)) { m = o.sheetShell(m, o.thickness); shelledT.push(+o.thickness); }
        return [o, m.transformed(o.matrix())];
      }
      catch (e) { return null; }
    }).filter(Boolean);
    const meshes = pairs.map(p => p[1]);

    this.objs = objs;
    this.meshes = meshes;     // 6c：幫我挪、肋位圖的外形要用
    const il = this.opt.method === 'interlock';
    this.result = !meshes.length ? { ok: false, reason: '目前文件裡沒有物件。' }
      : il ? interlockMany(meshes, this._ilOpt())     // 6a：互卡（6c：手動挪過的位置）
      : sliceMany(meshes, { axis: this.opt.axis, bands: this.opt.bands, maxOutline: !!this.opt.maxOutline, tinyCm: this.opt.tinyCm, minGlueCm2: this.opt.minGlueCm2 });
    this._sheetNotes = sheetNotes(this.result, shelledT, il);
    /** 第三輪第二批 A：有平滑細分的照平滑後的切，講跟展開圖差多少（三個出口同一句）*/
    this._smoothNotes = [...objs.map(o => smoothExitNote(o, 'slice')), ...objs.map(o => smoothFlipNote(o, 'slice'))].filter(Boolean);     // 第三輪第三批 ②-6：翻面也講

    /** 5c：手動放過孔（同一個切片方向，上面已經清過別的方向的）⇒ 用手動的（孔留著、重新檢查）*/
    this.pegs = (this.result.ok && this.result.slices.length && !il)     // 6a：互卡沒有定位孔
      ? (this.opt.manualPegs
          ? manualPegs(this.result.slices, this.opt.manualPegs.holes, { d: this.opt.d, gap: this.opt.gap })
          : findPegs(this.result.slices, {
              d: this.opt.d, gap: this.opt.gap,
              counts: this.opt.bands.map(b => b.holes)
            }))
      : null;
    this._peg1 = this.result.ok ? peg1Cover(this.pegs, this.result.slices) : null;     // 第三輪第三批 ②-5
    /**
     * 第三輪第三批 ②-11（kang 2026-10-26「照你的建議」）：疊層每一片在中間切 ⇒ 比一片還薄、剛好夾在兩刀之間的物件
     *（T19 平躺在地上的底線 0～0.2 cm）一片都切不到、結果裡直接不見 ⇒ 講是哪一個、怎麼辦。互卡、照最大外形切⛔ 這個問題。
     */
    this._uncut = (this.result.ok && this.result.slices.length && !il && !this.opt.maxOutline)
      ? uncutObjects(pairs.map(([o, m]) => ({ name: o.name, mesh: m })), this.result.slices, this.opt.axis) : [];

    this.frame = (this.result.ok && this.result.slices.length)
      ? stackBounds(this.result.slices) : null;
    if (this.result.ok) this.stack3d.setResult(this.result.slices, il ? this.result.axis : this.opt.axis, meshes);

    this._render();
  }

  _render() {
    this.body.innerHTML = '';
    const r = this.result;

    if (!r.ok) {
      this.sum.textContent = '切不出東西';
      this.body.appendChild(box('uwSkip', r.reason
        + '　（沒選東西就切全部；要切單一物件請先選取它）'));
      return;
    }

    const st = r.stats;
    if (r.method === 'interlock') {
      this.sum.textContent = `互卡　側面 ${st.spines} 片＋肋 ${st.ribs} 片${this.opt.manualRibs ? '（手動挪過）' : ''}　板厚 ${f(st.t)} cm　槽寬 ${f(st.slotW)} cm`;
      this.stack3d.setRods([], this.opt.d);
      this.body.appendChild(this.stack3d.el);
      this.stack3d.refresh();
      this._renderInterlock();
      return;
    }
    this.sum.textContent = `${st.count} 片　`
      + `板厚 ${st.thickKinds.map(t => f(t) + 'cm').join('、')}　`
      + `疊高 ${f(st.used)} / 模型 ${f(st.height)} cm`;

    /** 5b：立體預覽放在最上面（設定那兩排下面、提示上面）—— 同一個元素接回來，⛔ 每次開新的 WebGL */
    this.stack3d.setRods(this._rods(), this.opt.d);     // 5c：定位孔的桿子也畫上去
    this.body.appendChild(this.stack3d.el);
    this.stack3d.refresh();

    this.body.appendChild(this._bandTable());

    /**
     * 差額：這是這個視窗最重要的一行，做出來高度對不對全看它。
     *
     * 門檻用 FIT_TOL（0.1mm），不是浮點數的 1e-6。
     * 實測踩過：布林聯集出來的物件座標帶著 1e-4 的殘留，
     * 於是跳出「**還差 0 cm 沒疊到**」—— 一句自相矛盾的警告，
     * 而使用者只能看著它猜到底哪裡不對。
     * 誤報一次，整個警告欄就不值得信了（坑第 18 條）。
     */
    if (Math.abs(st.diff) > FIT_TOL) {
      /**
       * ⚠ **建議要照情況講，⛔ 不是永遠叫人「設成剩下」**（2026-10-08 查 bug E7）。
       * 板厚被擋下來時（片數超過上限），那一段**本來就是「剩下」**，
       * 這句建議會讓人以為自己哪裡沒設好。
       */
      const bands = (r.plan && r.plan.bands) || [];
      const last = this.opt.bands[this.opt.bands.length - 1];
      const lastRest = !!last && (last.n === '' || last.n === null || last.n === undefined || last.n === 'rest');
      const why = bands.some(b => b.bad)
        ? '有一段被擋下來了，原因看下面那一行 ⚠。'
        : lastRest
          /**
           * 給數字（2026-10-24，第二輪 ⑤-2）：以前只寫「換一個整除得了的板厚」—— 板子是買現成的，⛔ 建議怪板厚；
           * 改成縮放模型：縮成「現在疊到的高度」或「再多一片的高度」就剛好疊滿（汽車 12.35 ⇒ 12 或 13 cm）。
           */
          ? `最後一段已經是「剩下」—— 差的是不到一片（${f(last.t)} cm）的零頭：`
            + `把模型高度縮放成 ${f(st.used)} cm（縮小 ${pct(1 - st.used / st.height)}%）`
            + `或 ${f(st.used + +last.t)} cm（放大 ${pct((st.used + +last.t) / st.height - 1)}%）就剛好疊滿，或接受矮一點。`
          : '把某一段的片數加上去，或把最後一段設成「剩下」。';
      this.body.appendChild(box('uwWarn',
        st.diff > 0
          ? `⚠ 還差 ${f(st.diff)} cm 沒疊到（模型 ${f(st.height)}、`
            + `目前只疊到 ${f(st.used)}）。做出來會矮一截 —— ${why}`
          : `⚠ 疊過頭 ${f(-st.diff)} cm（模型只有 ${f(st.height)}）。`
            + '超出的那幾片會切到空的地方。'));
    }

    for (const w of r.warnings) this.body.appendChild(box('uwWarn', '⚠ ' + w));
    for (const n of this._sheetNotes || []) this.body.appendChild(box('uwSkip', n));     // 第三輪第一批 ②
    for (const n of this._smoothNotes || []) this.body.appendChild(box(n.level === 'caution' ? 'uwCaution' : 'uwSkip', n.text));     // 第三輪第二批 A
    /** 第三輪第三批 ②-11：一片都切不到的物件 */
    if (this._uncut && this._uncut.length) {
      const ax = this.opt.axis === 'y' ? '高' : this.opt.axis.toUpperCase();
      const cs = r.slices.slice(0, 2).map(s => f(s.coord)).join('、');
      this.body.appendChild(box('uwCaution', this._uncut.map(u => `「${u.name}」（${ax} ${f(u.lo)}～${f(u.hi)} cm）`).join('、')
        + `沒有切到任何一片（每一片在中間切：${cs}…）—— 勾「照最大外形切」就會疊進去，或把它的板厚、位置改到切得到的地方`));
    }

    // 定位孔
    const g = this.pegs;
    if (g && !g.ok) {
      this.body.appendChild(box('uwWarn', '⚠ 定位孔：' + g.reason));
    } else if (g && g.manual) {
      /** 5c：手動的孔 —— 講幾根、串起來幾片、最糟的那一片 */
      const chk = checkPegs(r.slices, s => pegsForSlice(g, s), { d: this.opt.d, gap: this.opt.gap });
      const solid = r.slices.filter(s => s.loops.length).length;
      this.body.appendChild(box(g.warnings.length ? 'uwWarn' : 'uwSkip',
        (g.warnings.length ? '⚠ ' : '') + `定位孔（手動）　${g.holes.length} 根　⌀${f(this.opt.d)} cm　`
        + `串起來的 ${solid - g.skipped.length}／${solid} 片`
        + (Number.isFinite(chk.worst) ? `　最糟的那一片孔邊離邊緣還剩 ${f(chk.worst - this.opt.d / 2)} cm` : '')));
      for (const w of g.warnings) this.body.appendChild(box('uwWarn', '⚠ ' + w));
    } else if (g) {
      const chk = checkPegs(r.slices, s => pegsForSlice(g, s),
        { d: this.opt.d, gap: this.opt.gap });
      this.body.appendChild(box(chk.ok ? 'uwSkip' : 'uwWarn',
        (chk.ok ? '定位孔　' : '⚠ 定位孔　')
        /** 第三輪第三批 ②-5：有片不打孔 ⇒ 照實寫穿過哪幾片（⛔ 寫「通到底」）；串不起來的只列不打孔以外的 */
        + (this._peg1 ? `孔① (${f(g.base.x)}, ${f(g.base.y)}) 穿過第 ${this._peg1.on} 片（第 ${this._peg1.off} 片不打孔）　` : `孔① (${f(g.base.x)}, ${f(g.base.y)}) 通到底　`)
        + `⌀${f(this.opt.d)} cm　`
        + g.bands.map(b => `段${b.band + 1} ${b.pegs.length} 孔`).join('　')
        /** ⚠ 2026-10-19（實驗 T6：`實驗-綜合評估.md` ②-10）報「孔邊」離邊緣多遠 —— `worst` 是孔中心的（判斷本身有算孔半徑，只是顯示的數字多了半個孔）*/
        + `　最糟的那一片孔邊離邊緣還剩 ${f(chk.worst - this.opt.d / 2)} cm`
        + (chk.ok ? '' : (bad => bad.length ? `　→ 第 ${bad.join('、')} 片串不起來` : '')(chk.bad.filter(i => !(this._peg1 && this._peg1.skipped.includes(i)))))));
      // 紅色只留給「程式做不到你要求的事」；你自己選的後果用藍色說明
      for (const w of g.warnings) this.body.appendChild(box('uwWarn', '⚠ ' + w));
      for (const n of g.notes) this.body.appendChild(box('uwSkip', n));
    }
    /** 5c：孔位圖（手動放孔）—— 接在定位孔的說明後面；同一個元素接回來 */
    if (g && g.ok) {
      this.pegMap.setState(r.slices, g, { d: this.opt.d, gap: this.opt.gap },
        g.manual ? this.opt.manualPegs.holes : []);
      this.body.appendChild(this.pegMap.el);
      this.pegMap.refresh();
    }

    this.body.appendChild(box('uwSkip',
      '定位孔畫在切割層，跟輪廓一起切下去 —— 分成獨立圖層的話，'
      + '廠商只留切割層丟給機器時會漏切，整疊就串不起來。'
      + '層號印在第 1 孔正下方且永遠正著寫，疊的時候讓號碼朝同一邊，'
      + '整疊就不會翻 180 度。'
      + '不同板厚的切割線分在不同圖層（CUT_T10、CUT_T20…），'
      + '上機時一次只開一層、鋪對應厚度的板。'));

    if (this.opt.nest.on) this._renderBoards();

    // ── 預覽 ──
    const n = Math.min(r.slices.length, PREVIEW_MAX);
    for (let i = 0; i < n; i++) this.body.appendChild(this._card(r.slices[i]));
    if (r.slices.length > n) {
      this.body.appendChild(box('uwSkip',
        `預覽只畫前 ${n} 片（共 ${r.slices.length} 片），匯出不受影響。`));
    }
    this.stack3d.draw();     // 卡片排上去之後可能多了捲軸、變窄 ⇒ 照新的寬再畫一次
  }

  /**
   * 🔴 **互卡的結果**（6a）：提醒（紅框）、說明（藍框）、怎麼切怎麼組（藍框）、排版、每塊零件一張卡片。
   * ⛔ 分段表、⛔ 定位孔（互卡靠槽卡住）。
   */
  _renderInterlock() {
    const r = this.result, st = r.stats, il = this.opt.il;
    for (const w of r.warnings) this.body.appendChild(box('uwWarn', '⚠ ' + w));
    for (const n of r.notes || []) this.body.appendChild(box('uwSkip', n));
    for (const n of this._sheetNotes || []) this.body.appendChild(box('uwSkip', n));     // 第三輪第一批 ②
    for (const n of this._smoothNotes || []) this.body.appendChild(box(n.level === 'caution' ? 'uwCaution' : 'uwSkip', n.text));     // 第三輪第二批 A
    this.body.appendChild(box('uwSkip',
      `互卡：側面從 ${st.spineAx.toUpperCase()} 切${st.spines === 1 && !this.opt.manualRibs ? '正中間（1 片）' : `（${st.spines} 片）`}＋肋沿 ${st.ribAx.toUpperCase()} ${this.opt.manualRibs ? '照肋位圖手動挪過的位置' : `每 ${f(st.spacing)} cm`}（${st.ribs} 片）；`
      + `槽寬 ${f(st.slotW)} cm（板厚 ${f(st.t)} ${+il.slotAdj ? (il.slotAdj > 0 ? '＋ ' : '− ') + f(Math.abs(il.slotAdj)) : '＋ 0'}）、肋那邊佔 ${f(il.share * 10)} 成、槽口每邊張開 ${f(il.flare)} cm。`
      + '槽已經挖在輪廓上，跟輪廓一起在切割層。零件編號：S ＝ 側面、R1、R2… ＝ 肋（照順序排）。'
      + '⚠ 槽寬沒有補切口（切口由人工處理）—— 第一次切先存一片試卡片試一下鬆緊（下面那張）。'));
    /** 6c：肋位圖 —— 接在說明後面、試卡片前面；同一個元素接回來 */
    this.ribMap.setState(r, this._topOutline(), !!this.opt.manualRibs, this._ribNote);
    this._ribNote = '';     // 「幫我挪」的結果講一次就好
    this.body.appendChild(this.ribMap.el);
    this.ribMap.refresh();
    this._applyRibManual();
    this.body.appendChild(this._fitCard());
    if (this.opt.nest.on) this._renderBoards();
    const n = Math.min(r.slices.length, PREVIEW_MAX);
    for (let i = 0; i < n; i++) this.body.appendChild(this._card(r.slices[i]));
    this.stack3d.draw();
  }

  /** 分段表：一行一段，「板厚 × 片數」。片數留空 ＝ 剩下的填滿。 */
  _bandTable() {
    const wrap = document.createElement('div');
    wrap.className = 'uwBomWrap';
    wrap.innerHTML = '<h3>分段（一段一種板厚，由下往上疊）</h3>';

    const tb = document.createElement('table');
    tb.className = 'uwBom';
    const bands = this.result.plan.bands;
    tb.innerHTML = '<tr><th>段</th><th>板厚 cm</th><th>片數</th><th>孔的數量</th>'
      + '<th>片號</th><th>這段高度 cm</th><th></th></tr>';

    this.opt.bands.forEach((b, i) => {
      const info = bands[i] || { n: 0, from: 0, to: 0 };
      const got = this.pegs && this.pegs.ok
        ? (this.pegs.bands.find(q => q.band === i) || {}).pegs : null;
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i + 1}</td>
        <td><input type="number" step="0.1" min="0.01" value="${b.t}" style="width:70px"></td>
        <td><input type="text" value="${b.n === '' || b.n == null ? '' : b.n}"
             placeholder="剩下" style="width:70px"></td>
        <td><input type="number" step="1" min="1" max="6" value="${b.holes}"
             style="width:60px">
          <span class="dim">${got && got.length !== +b.holes
            ? `　實際 ${got.length}` : ''}</span></td>
        <td>${info.n ? `${info.from} ~ ${info.to}` : '—'}</td>
        <td>${f(info.n * (+b.t || 0))}</td>
        <td><button class="mini" ${this.opt.bands.length < 2 ? 'disabled' : ''}>刪</button></td>`;

      const [tIn, nIn, hIn] = tr.querySelectorAll('input');
      tIn.title = '這一段用幾公分厚的板';
      nIn.title = '這一段要幾片。留空 ＝ 用剩下的高度能塞幾片就幾片';
      hIn.title = '這一段的片要鑽幾個孔。孔① 是通到底的那根桿子，每一段都有；'
        + '多出來的孔只穿得過這一段的片，所以只要在這一段成立就好 —— '
        + '中段可以拉得很開，頭尾小片給 1 個就夠';
      tIn.onchange = () => { b.t = num(tIn.value, 1); this.run(); };
      nIn.onchange = () => {
        const v = nIn.value.trim();
        b.n = v === '' ? '' : Math.max(0, Math.floor(+v) || 0);
        this.run();
      };
      hIn.onchange = () => {
        b.holes = Math.min(6, Math.max(1, Math.floor(num(hIn.value, 2)) || 1));
        this.run();
      };
      tr.querySelector('button').onclick = () => {
        this.opt.bands.splice(i, 1);
        this.run();
      };
      tb.appendChild(tr);
    });

    wrap.appendChild(tb);

    const add = document.createElement('button');
    add.className = 'mini';
    add.textContent = '＋ 加一段';
    add.style.marginTop = '6px';
    add.onclick = () => {
      const last = this.opt.bands[this.opt.bands.length - 1];
      // 新增的一段接手「剩下」，原本那段改成固定片數，
      // 否則兩段都想吃剩下的，結果是新的那段永遠是 0 片
      if (last && (last.n === '' || last.n == null)) {
        const info = this.result.plan.bands[this.opt.bands.length - 1];
        last.n = info ? info.n : 0;
      }
      this.opt.bands.push({ t: last ? last.t : 1.0, n: '',
        holes: last ? last.holes : PEG_DEFAULTS.count });
      this.run();
    };
    wrap.appendChild(add);
    return wrap;
  }

  /** 排版：照目前的設定把這一疊擺進板子裡（⛔ 存結果 —— 設定一改就重排）。畫面、SVG、DXF、列印共用 */
  _sheets(marks = false) {
    const N = this.opt.nest;
    const sheets = sliceBoards(this.result.slices,
      { w: N.w, h: N.h, gap: N.gap, rotate: N.rotate },
      { pegsOf: s => this._pegsOf(s), pegD: this.opt.d, marks });     // marks：只有畫面預覽塗（5a）；存檔、列印⛔ 塗
    return sheets.map((sh, i) => ({ ...sh, title: sliceBoardTitle(sh, i, sheets.length) }));
  }

  /** 🔴 排版預覽：放在每片卡片的上面 —— 先看要幾張板、每張擺了哪幾片 */
  _renderBoards() {
    const N = this.opt.nest;
    const sheets = this._sheets(true);
    const big = sheets.filter(x => x.board.oversize).length;
    const normal = sheets.length - big;
    /** 每種板厚各幾張 —— 上機時一種厚度鋪一次料 */
    const byT = [];
    for (const sh of sheets) {
      if (sh.board.oversize) continue;
      const g = byT.find(q => q.t === sh.t);
      if (g) g.n++; else byT.push({ t: sh.t, n: 1 });
    }
    this.body.appendChild(box(big ? 'uwWarn' : 'uwSkip',
      (normal ? `排版：需要 ${normal} 張 ${f(N.w)} × ${f(N.h)} cm 的板子`
                + (byT.length > 1 ? `（${byT.map(g => `板厚 ${f(g.t)} cm ${g.n} 張`).join('、')}）` : '')
              : `排版：沒有一片擺得進 ${f(N.w)} × ${f(N.h)} cm 的板子`)
      + (big ? `　⚠ ${normal ? '另有 ' : ''}${big} 片比板子還大，各自單獨一張（要換大板或再切小）` : '')
      + '　不同板厚的片放在不同張　存 SVG／DXF 時一張板一個檔'));
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

  /** 一份「畫什麼」畫成 canvas */
  _canvas(prog, maxH) {
    const maxW = Math.min(1100, Math.max(360, this.body.clientWidth - 56));
    const px = Math.max(0.5, Math.min(maxW / prog.box.w, maxH / prog.box.h));
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

  /** 一片一張小圖。共用框，所以孔在每張圖上都落在同一個位置。 */
  _card(slice) {
    const card = document.createElement('div');
    card.className = 'uwCard';
    card.dataset.slice = slice.index;     // 5b：立體預覽點一片 ⇒ 跳到這裡

    const opt = { ...this._progOpt(), ...this._ownFrame(slice), pegs: this._pegsOf(slice), pegSpans: pegSpans(this.pegs, slice), peg1: this._peg1, marks: true };     // 5a：卡片上塗掉下來／只黏一點點的塊；5c：手動的孔寫穿過第幾片
    const lines = sliceTitleLines(slice, { ...opt, head: this.app.head });
    const h = document.createElement('div');
    h.className = 'uwTitle';
    h.innerHTML = lines.map((s, i) =>
      `<div class="${s.startsWith('⚠') ? 'bad' : (i === 0 ? 'nm' : 'dim')}">${esc(s)}</div>`
    ).join('');
    card.appendChild(h);

    const prog = sliceProgram(slice, opt);
    const maxW = Math.min(640, Math.max(240, this.body.clientWidth - 56));
    const px = Math.max(1, Math.min(maxW / prog.box.w, 300 / prog.box.h));

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

  /**
   * 5b：立體預覽點到第 ○ 片 ⇒ 卡片捲到畫面中間、框起來一下。
   * 卡片只畫前 `PREVIEW_MAX` 片 —— 後面的沒有卡片，就在上面講一聲。
   */
  _jumpCard(i) {
    const card = this.body.querySelector(`.uwCard[data-slice="${i}"]`);
    if (!card) { this.stack3d.pickEl.textContent = `第 ${i} 片（卡片只畫前 ${PREVIEW_MAX} 片）`; return; }
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    card.classList.add('uwHit');
    clearTimeout(this._hitT);
    this._hitT = setTimeout(() => card.classList.remove('uwHit'), 1600);
  }

  // ── 肋位圖（6c）──────────────────────────────────────

  /** 這一次切互卡要用的設定：手動挪過 ⇒ 帶上側面方向、位置 */
  _ilOpt() {
    const m = this.opt.manualRibs;
    return m ? { ...this.opt.il, spine: m.spineAx, spineCoords: m.spines, ribCoords: m.ribs } : this.opt.il;
  }

  /** 手動挪肋時「肋間距」「側面幾片」變灰（要改先按「回到自動」）*/
  _applyRibManual() {
    const m = !!this.opt.manualRibs;
    for (const k of ['spacing', 'spineN']) {
      this.ilIn[k].disabled = m;
      if (!this.ilIn[k].dataset.tip) this.ilIn[k].dataset.tip = this.ilIn[k].title;     // 原本的說明留著，回到自動時換回來
      this.ilIn[k].title = m ? '手動挪過肋 —— 要改這一格，先按肋位圖的「回到自動」' : this.ilIn[k].dataset.tip;
    }
  }

  /** 肋位圖的外形（從下到上切 7 層）：模型沒變就不重算（汽車要一兩秒）*/
  _topOutline() {
    const r = this.result, b = r.bounds;
    const key = `${this.objs.map(o => o.id).join(',')}:${['x', 'y', 'z'].map(k => b.min[k].toFixed(3) + '/' + b.max[k].toFixed(3)).join(',')}:${r.stats.area.toFixed(1)}`;
    if (key !== this._outlineKey || !this._outline) { this._outlineKey = key; this._outline = topOutline(this.meshes); }
    return this._outline;
  }

  /** 按「手動挪肋」：現在的位置先放上去（畫出來一模一樣），之後改的都是這一份 */
  _toManualRibs() {
    const r = this.result;
    if (!r || !r.ok || r.method !== 'interlock') return;
    // 6d：切到空的那片側面也留著（肋位圖畫虛線）—— ⛔ 留的話手動時就再也拖不到紅點上（線上先驗抓到）
    this.opt.manualRibs = { spineAx: r.axis, spines: (r.stats.spineCoordsWanted || r.stats.spineCoords).slice(), ribs: r.ribInfo.map(q => q.coord) };
    save(this.opt);
    this._keepScroll(() => this._render());
  }

  /** 按「回到自動」：丟掉手動挪過的，側面照片數放、肋等間距 */
  _toAutoRibs() {
    this.opt.manualRibs = null;
    this._ribNote = '';
    this._rerun();
  }

  /** 肋位圖改了（拖完、打位置、加、刪）：重切 */
  _setRibs(c) {
    this.opt.manualRibs = { spineAx: this.result.axis, spines: c.spines, ribs: c.ribs };
    this._ribNote = '';
    this._rerun();
  }

  /** 重切、停在原本的位置（肋位圖在中間，⛔ 跳回最上面）*/
  _rerun() {
    const top = this.body.scrollTop;
    this.ribMap.say('正在重切…（大的模型要幾秒）');
    clearTimeout(this._runT);
    this._runT = setTimeout(() => { this._runNow(); this.body.scrollTop = top; }, BUSY_MS);
  }

  _keepScroll(fn) { const top = this.body.scrollTop; fn(); this.body.scrollTop = top; }

  /**
   * 「幫我挪有問題的肋」：按了才算（汽車要 20 秒左右，先講正在算）—— 結果變成手動的位置，放在圖上給人看、還可以再改。
   */
  _suggestRibs() {
    if (!this.result || !this.result.ok || !this.meshes) return;
    const top = this.body.scrollTop;
    this.ribMap.say('正在試挪有問題的肋…（每試一次要整個重切，大的模型要十幾二十秒，算的時候畫面會停住）');
    clearTimeout(this._runT);
    this._runT = setTimeout(() => {
      const s = suggestRibs(this.meshes, this._ilOpt());
      if (!s) { this._ribNote = '幫我挪：切不出東西 —— 沒挪'; this._runNow(); return; }
      const fmt = v => (v > 0 ? '＋' : '−') + f(Math.abs(v));
      const sumT = o => `掉下來 ${o.loose} 塊、卡不牢 ${o.weak} 處${o.conflicts ? `、組不起來 ${o.conflicts} 片` : ''}`;
      this._ribNote = s.moves.length
        ? `幫我挪：挪了 ${s.moves.map(m => `肋 ${m.n}（${fmt(m.to - m.from)} cm）`).join('、')}；${sumT(s.before)} → ${sumT(s.after)} —— 這只是建議，還可以再拖或按「回到自動」`
        : `幫我挪：每一片有問題的肋往左右試過 0.5、1 cm，沒有找到更好的位置（${sumT(s.before)}）—— 沒挪`;
      if (s.moves.length) this.opt.manualRibs = { spineAx: this.result.axis, spines: s.spineCoords, ribs: s.ribCoords };
      this._runNow();
      this.body.scrollTop = top;
    }, BUSY_MS);
  }

  // ── 手動放孔（5c）────────────────────────────────────

  /** 按「手動放孔」：自動找的孔先換成手動的一份（畫出來一模一樣），之後改的都是這一份 */
  _toManual() {
    if (!this.result || !this.result.ok || !this.pegs || !this.pegs.ok) return;
    const holes = holesFromAuto(this.pegs, this.result.slices);
    this._setHoles(holes);
  }

  /** 按「回到自動」：丟掉手動的，重新自動找 */
  _toAuto() {
    this.opt.manualPegs = null;
    this.run();
  }

  /** 孔改了：重新排每一片的孔、重畫（⛔ 重切 —— 切的結果沒變）*/
  _setHoles(holes) {
    this.opt.manualPegs = { axis: this.opt.axis, holes };
    save(this.opt);
    this.pegs = manualPegs(this.result.slices, holes, { d: this.opt.d, gap: this.opt.gap });
    const top = this.body.scrollTop;
    this._render();
    this.body.scrollTop = top;      // 重畫之後停在原本的位置（孔位圖在中間，⛔ 跳回最上面）
  }

  /** 立體預覽的桿子：每一個孔在連續有它的那幾片 ⇒ 一根；手動加的藍色 */
  _rods() {
    const g = this.pegs;
    if (!g || !g.ok || !this.result || !this.result.ok) return [];
    if (!g.manual) return holesFromAuto(g, this.result.slices).map(h => ({ ...h, manual: false }));
    const out = [];
    for (const h of g.holes) {
      let run = null;
      for (const s of this.result.slices) {
        if (h.drilled.includes(s.index)) { if (!run) run = { x: h.x, y: h.y, from: s.index, to: s.index, manual: !h.auto }; else run.to = s.index; }
        else if (run) { out.push(run); run = null; }
      }
      if (run) out.push(run);
    }
    return out;
  }

  /** 6a 互卡：每塊零件用自己的外框（側面、肋大小差很多，⛔ 共用一個框）；疊層 ⇒ 空的（照共用的框）*/
  _ownFrame(s) {
    if (!s.axis) return {};
    return { origin: { x: s.bounds.minX, y: s.bounds.minY }, frame: { w: s.bounds.w, h: s.bounds.h } };
  }

  /** 出圖用的共同參數。預覽、SVG、DXF 三邊一定要用同一份。 */
  _progOpt() {
    const fr = this.frame || { minX: 0, minY: 0, w: 0, h: 0 };
    return {
      origin: { x: fr.minX, y: fr.minY },
      frame: { w: fr.w, h: fr.h },
      pegD: this.opt.d,
      total: this.result.ok ? this.result.slices.length : 0
    };
  }

  /**
   * 這一片要鑽哪幾個孔。**每一片不一定一樣多** ——
   * 孔① 每一片都有，其餘的孔只屬於它那一段。
   */
  _pegsOf(slice) {
    return (this.pegs && this.pegs.ok) ? pegsForSlice(this.pegs, slice) : [];
  }

  // ── 匯出 ────────────────────────────────────────────

  _print() {
    if (!this._has()) return;
    let ok;
    if (this.opt.nest.on) {
      ok = printSVGs(this._sheets().map(sh => progSVG(sh.prog, sh.title)), '剖面排版');
    } else {
      const base = { ...this._progOpt(), head: this.app.head };
      ok = printSVGs(
        this.result.slices.map(s => {
          const opt = { ...base, ...this._ownFrame(s), pegs: this._pegsOf(s), pegSpans: pegSpans(this.pegs, s), peg1: this._peg1 };
          return progSVG(sliceProgram(s, opt), sliceTitleLines(s, opt));
        }),
        '剖面分切');
    }
    if (ok === false) { this._say(PRINT_BLOCKED); if (this.app.toast) this.app.toast(PRINT_BLOCKED, true); }
  }

  /**
   * 🔴 **存 SVG**（2026-10-14 改，kang：「DXF 可以全部匯出，但是 SVG 只能匯出一個檔案」）。
   * 原本只存第 1 片（理由：一片一個檔太多次下載）—— 現在：
   * 排版開著 ⇒ **一張板一個檔**；關著 ⇒ **一片一個檔**（kang 選的）。
   * 勾了「指定存放位置」只選一次資料夾（`saveMany()`）。內容一律先同步準備好才 await（手勢）。
   */
  async _saveSVG() {
    if (!this._has()) return;
    if (this.opt.nest.on) {
      const jobs = this._sheets().map((sh, i) => ({
        name: `${this._base()}_板${String(i + 1).padStart(2, '0')}_t${f(sh.t)}.svg`,
        blob: textBlob(progSVG(sh.prog, sh.title), 'image/svg+xml')
      }));
      const n = await saveMany(jobs, this.opt.askPath);
      if (n > 1) this._say(`已存 ${n} 個 SVG（一張板一個檔）。`);
      return;
    }
    const base = { ...this._progOpt(), head: this.app.head };
    const jobs = this.result.slices.map(s => {
      const opt = { ...base, ...this._ownFrame(s), pegs: this._pegsOf(s), pegSpans: pegSpans(this.pegs, s), peg1: this._peg1 };
      return {
        name: `${this._base()}_第${String(s.index).padStart(2, '0')}片.svg`,
        blob: textBlob(progSVG(sliceProgram(s, opt), sliceTitleLines(s, opt)), 'image/svg+xml')
      };
    });
    const n = await saveMany(jobs, this.opt.askPath);
    if (n > 1) this._say(`已存 ${n} 個 SVG（一片一個檔）。`);
  }

  async _saveDXF() {
    if (!this._has()) return;
    if (this.opt.nest.on) {
      // 🔴 排版開著：一張板一個檔（跟展開圖一樣）。標題只能英數（R12）
      const sheets = this._sheets();
      const jobs = sheets.map((sh, i) => ({
        name: `${this._base()}_板${String(i + 1).padStart(2, '0')}_t${f(sh.t)}.dxf`,
        blob: textBlob(sliceBoardDXF(sh, {
          unit: this.opt.unit,
          title: `SHEET ${i + 1}/${sheets.length}  t=${f(sh.t)}cm  ${f(sh.board.w)}x${f(sh.board.h)}cm`
            + (sh.board.oversize ? '  OVERSIZE' : '')
            + '  ' + sh.board.items.map(it => it.piece.no).join(' ')
        }), 'application/dxf')
      }));
      const n = await saveMany(jobs, this.opt.askPath);
      if (n > 1) this._say(`已存 ${n} 個 DXF（一張板一個檔）。`);
      return;
    }
    const fr = this.frame;
    const blob = textBlob(sliceDXF(this.result.slices, {
      unit: this.opt.unit,
      origin: { x: fr.minX, y: fr.minY },
      frame: { w: fr.w, h: fr.h },
      pegsOf: s => this._pegsOf(s),
      pegD: this.opt.d,
      axis: this.opt.axis,
      head: this.app.head
    }), 'application/dxf');
    await saveBlob(blob, `${this._base()}.dxf`, TYPES.dxf, this.opt.askPath);
  }

  /**
   * 6b：互卡結果裡的試卡片預覽 —— 長怎樣、怎麼用（按上面一排的「存試卡片」存檔）。
   * 中間那格（現在的設定）粗字；槽寬 ≤ 0 的那一格紅字、⛔ 挖。
   */
  _fitCard() {
    const fit = fitComb(this.opt.il, this.opt.fit);
    const d = document.createElement('div');
    d.className = 'uwSkip slFitCard';
    const lo = fit.slots[0].text, hi = fit.slots[fit.n - 1].text;
    d.innerHTML = `<b>試卡片</b>（先切這一片試鬆緊，按上面一排的「存試卡片」存成單獨一個 DXF）：`
      + `一排 ${fit.n} 格、每格槽寬差 ${f(fit.step * 10)} mm，槽寬 ＝ 板厚 ${f(fit.t)} ＋ 下面的數字（${esc(lo)} ～ ${esc(hi)} cm）；`
      + `中間那格（粗字）＝ 現在的槽寬加減。${f(fit.W)} × ${f(fit.H)} cm。<br>`
      + '拿同一塊板子的邊插進每一格，挑「插得進去、放手不會掉」那一格，把它下面的數字填進「槽寬加減」—— 再存一次試卡片，就以新的數字為中間再試一次。'
      + (fit.skipped.length ? `<br>⚠ ${esc(fit.skipped.join('、'))} 那幾格槽寬變成 0 以下，沒有挖（紅字）—— 把槽寬加減調大一點。` : '')
      + `<div style="margin-top:6px;overflow:auto">${fitSVG(fit)}</div>`;
    return d;
  }

  /** 6b：存試卡片 —— 單獨一個 DXF（跟零件分開：先切它、挑好數字再切零件）。跟模型無關，模型切不出來也存得了 */
  async _saveFit() {
    const fit = fitComb(this.opt.il, this.opt.fit);
    const head = this.app.head || {};
    const blob = textBlob(fitDXF(fit, { unit: this.opt.unit, head }), 'application/dxf');
    await saveBlob(blob, `${safeName(`試卡片_${head.name || '未命名'}_t${f(fit.t)}`, '試卡片')}.dxf`, TYPES.dxf, this.opt.askPath);
  }

  _base() {
    const head = this.app.head || {};
    return safeName(`剖面_${head.name || '未命名'}_${this.opt.axis}軸`, '剖面分切');
  }

  _has() {
    return !!(this.result && this.result.ok && this.result.slices.length);
  }

  _say(msg) { this.sum.textContent = msg + '　' + this.sum.textContent; }
}

/** 6a：疊層才有、互卡才有的那幾格照做法藏起來 —— 樣式由程式自己帶（⛔ 寫在 index.html，同 5b 那一課）*/
function ensureModeStyle() {
  if (document.getElementById('slModeStyle')) return;
  const st = document.createElement('style');
  st.id = 'slModeStyle';
  st.textContent = '.slMode { display: contents; }\n.slMode[hidden] { display: none; }';
  document.head.appendChild(st);
}

function box(cls, msg) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = msg;
  return d;
}

/** 第二輪 ⑤-1：最上面放一行「正在算」（已經有就換字）；算完畫結果時 body 整個清掉、它就跟著不見 */
const BUSY_MS = 30;
function showBusy(body, msg) {
  let b = body.querySelector('.uwBusy');
  if (!b) { b = box('uwSkip uwBusy', msg); body.prepend(b); }
  else b.textContent = msg;
}

const f = v => String(Math.round(v * 100) / 100);
const pct = v => String(Math.round(v * 1000) / 10);     // 0.0283 ⇒ 2.8
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v, dflt) => { const x = parseFloat(v); return Number.isFinite(x) ? x : dflt; };

function loadOpt() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch (e) { return {}; }
}
function save(o) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) { /* 無所謂 */ }
}

/**
 * 列印視窗被瀏覽器擋掉（`printSVGs()` 回傳 false）⇒ 講出來（2026-10-19，補測：`實驗-綜合評估.md` ②-13）。
 * ⚠ 以前兩個面板都沒看回傳值 ⇒ 按了完全沒反應，跟「壞了」分不出來。
 */
const PRINT_BLOCKED = '瀏覽器擋掉了列印視窗 —— 請在網址列允許這個網站開彈出視窗，或改用「存 SVG」再用別的程式印';
