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

import { sliceMany, stackBounds, AXES, AXIS_KEYS, DEFAULT_AXIS, FIT_TOL, TINY_PIECE_CM, MIN_GLUE_CM2 }
  from '../slice/section.js';
import { findPegs, checkPegs, pegsForSlice, PEG_DEFAULTS } from '../slice/pegs.js';
import { sliceProgram, sliceTitleLines, renderCanvas, progSVG, printSVGs }
  from '../out/sheet.js';
import { sliceDXF, sliceBoardDXF, UNITS } from '../out/dxf.js';
import { saveBlob, saveMany, textBlob, safeName, canChoosePath, TYPES } from '../out/save.js';
import { sliceBoards, sliceBoardTitle, NEST_DEFAULTS } from '../out/nest.js';
import { StackView } from './stackView.js';

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
          <span class="sp"></span>
          <span class="lbl">DXF 單位</span><select id="slUnit"></select>
          <label class="uwCk"><input type="checkbox" id="slAsk"> 指定存放位置</label>
          <span class="sp"></span>
          <button id="slPrint">列印</button>
          <button id="slSvg">存 SVG</button>
          <button id="slDxf">存 DXF</button>
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

    $('slClose').onclick = () => this.close();
    el.querySelector('.uwBack').onclick = () => this.close();
    $('slPrint').onclick = () => this._print();
    $('slSvg').onclick = () => this._saveSVG();
    $('slDxf').onclick = () => this._saveDXF();

    window.addEventListener('keydown', e => {
      // ⚠ 關掉之後⛔ 不再往下傳 —— 不然主畫面的 Esc 會接著清掉選取（2026-10-08 E2）
      if (!this.el.hidden && e.key === 'Escape') { e.stopImmediatePropagation(); this.close(); }
    });
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
    const $ = id => this.el.querySelector('#' + id);
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
    save(this.opt);
    const picked = this.app.sel.objects;
    const objs = picked.length ? picked : this.app.doc.objects;

    // 切的是世界座標下的樣子 —— 物件被搬過、轉過、縮放過都要吃進去，
    // 否則圖跟畫面上看到的東西不一樣大也不一樣位置。
    const meshes = objs.map(o => {
      try { return o.mesh().transformed(o.matrix()); }
      catch (e) { return null; }
    }).filter(Boolean);

    this.objs = objs;
    this.result = meshes.length
      ? sliceMany(meshes, { axis: this.opt.axis, bands: this.opt.bands, maxOutline: !!this.opt.maxOutline, tinyCm: this.opt.tinyCm, minGlueCm2: this.opt.minGlueCm2 })
      : { ok: false, reason: '目前文件裡沒有物件。' };

    this.pegs = (this.result.ok && this.result.slices.length)
      ? findPegs(this.result.slices, {
          d: this.opt.d, gap: this.opt.gap,
          counts: this.opt.bands.map(b => b.holes)
        })
      : null;

    this.frame = (this.result.ok && this.result.slices.length)
      ? stackBounds(this.result.slices) : null;
    if (this.result.ok) this.stack3d.setResult(this.result.slices, this.opt.axis, meshes);

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
    this.sum.textContent = `${st.count} 片　`
      + `板厚 ${st.thickKinds.map(t => f(t) + 'cm').join('、')}　`
      + `疊高 ${f(st.used)} / 模型 ${f(st.height)} cm`;

    /** 5b：立體預覽放在最上面（設定那兩排下面、提示上面）—— 同一個元素接回來，⛔ 每次開新的 WebGL */
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

    // 定位孔
    const g = this.pegs;
    if (g && !g.ok) {
      this.body.appendChild(box('uwWarn', '⚠ 定位孔：' + g.reason));
    } else if (g) {
      const chk = checkPegs(r.slices, s => pegsForSlice(g, s),
        { d: this.opt.d, gap: this.opt.gap });
      this.body.appendChild(box(chk.ok ? 'uwSkip' : 'uwWarn',
        (chk.ok ? '定位孔　' : '⚠ 定位孔　')
        + `孔① (${f(g.base.x)}, ${f(g.base.y)}) 通到底　`
        + `⌀${f(this.opt.d)} cm　`
        + g.bands.map(b => `段${b.band + 1} ${b.pegs.length} 孔`).join('　')
        /** ⚠ 2026-10-19（實驗 T6：`實驗-綜合評估.md` ②-10）報「孔邊」離邊緣多遠 —— `worst` 是孔中心的（判斷本身有算孔半徑，只是顯示的數字多了半個孔）*/
        + `　最糟的那一片孔邊離邊緣還剩 ${f(chk.worst - this.opt.d / 2)} cm`
        + (chk.ok ? '' : `　→ 第 ${chk.bad.join('、')} 片串不起來`)));
      // 紅色只留給「程式做不到你要求的事」；你自己選的後果用藍色說明
      for (const w of g.warnings) this.body.appendChild(box('uwWarn', '⚠ ' + w));
      for (const n of g.notes) this.body.appendChild(box('uwSkip', n));
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

    const opt = { ...this._progOpt(), pegs: this._pegsOf(slice), marks: true };     // 5a：卡片上塗掉下來／只黏一點點的塊
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
          const opt = { ...base, pegs: this._pegsOf(s) };
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
      const opt = { ...base, pegs: this._pegsOf(s) };
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

  _base() {
    const head = this.app.head || {};
    return safeName(`剖面_${head.name || '未命名'}_${this.opt.axis}軸`, '剖面分切');
  }

  _has() {
    return !!(this.result && this.result.ok && this.result.slices.length);
  }

  _say(msg) { this.sum.textContent = msg + '　' + this.sum.textContent; }
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
