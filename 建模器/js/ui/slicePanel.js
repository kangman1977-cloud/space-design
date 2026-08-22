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

import { sliceMany, stackBounds, AXES, AXIS_KEYS, DEFAULT_AXIS, FIT_TOL }
  from '../slice/section.js';
import { findPegs, checkPegs, pegsForSlice, PEG_DEFAULTS } from '../slice/pegs.js';
import { sliceProgram, sliceTitleLines, renderCanvas, progSVG, printSVGs }
  from '../out/sheet.js';
import { sliceDXF, UNITS } from '../out/dxf.js';
import { saveBlob, textBlob, safeName, canChoosePath, TYPES } from '../out/save.js';

const LS_KEY = 'modeler_slice';

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
      unit: 'mm',
      askPath: true,
      ...loadOpt()
    };
    if (!Array.isArray(this.opt.bands) || !this.opt.bands.length) {
      this.opt.bands = [{ t: 1.0, n: '', holes: PEG_DEFAULTS.count }];
    }
    // 舊的存檔沒有 holes 這個欄位，補上預設值
    for (const b of this.opt.bands) if (b.holes == null) b.holes = PEG_DEFAULTS.count;
    this.result = null;
    this.pegs = null;
    this._build();
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
          <span class="sp"></span>
          <span class="lbl">DXF 單位</span><select id="slUnit"></select>
          <label class="uwCk"><input type="checkbox" id="slAsk"> 指定存放位置</label>
          <span class="sp"></span>
          <button id="slPrint">列印</button>
          <button id="slSvg">存 SVG</button>
          <button id="slDxf">存 DXF</button>
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

    this.askIn = $('slAsk');
    this.askIn.checked = !!this.opt.askPath;
    this.askIn.parentElement.title = canChoosePath()
      ? '存檔時跳「另存新檔」讓你選資料夾'
      : '這個開啟方式不支援（瀏覽器只在 https 或 localhost 開放此功能），'
        + '本機用內網 IP 開會自動退回一般下載。線上版可以用';
    if (!canChoosePath()) this.askIn.parentElement.classList.add('off');
    this.askIn.onchange = () => { this.opt.askPath = this.askIn.checked; save(this.opt); };

    $('slClose').onclick = () => this.close();
    el.querySelector('.uwBack').onclick = () => this.close();
    $('slPrint').onclick = () => this._print();
    $('slSvg').onclick = () => this._saveSVG();
    $('slDxf').onclick = () => this._saveDXF();

    window.addEventListener('keydown', e => {
      if (!this.el.hidden && e.key === 'Escape') this.close();
    });
  }

  open() { this.el.hidden = false; this.run(); }
  close() { this.el.hidden = true; }
  get isOpen() { return !this.el.hidden; }

  // ── 算一次並重畫 ────────────────────────────────────

  run() {
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
      ? sliceMany(meshes, { axis: this.opt.axis, bands: this.opt.bands })
      : { ok: false, reason: '目前文件裡沒有物件。' };

    this.pegs = (this.result.ok && this.result.slices.length)
      ? findPegs(this.result.slices, {
          d: this.opt.d, gap: this.opt.gap,
          counts: this.opt.bands.map(b => b.holes)
        })
      : null;

    this.frame = (this.result.ok && this.result.slices.length)
      ? stackBounds(this.result.slices) : null;

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
      this.body.appendChild(box('uwWarn',
        st.diff > 0
          ? `⚠ 還差 ${f(st.diff)} cm 沒疊到（模型 ${f(st.height)}、`
            + `目前只疊到 ${f(st.used)}）。做出來會矮一截 ——`
            + '把某一段的片數加上去，或把最後一段設成「剩下」。'
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
        + `　最糟的那一片離邊緣還剩 ${f(chk.worst)} cm`
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

    // ── 預覽 ──
    const n = Math.min(r.slices.length, PREVIEW_MAX);
    for (let i = 0; i < n; i++) this.body.appendChild(this._card(r.slices[i]));
    if (r.slices.length > n) {
      this.body.appendChild(box('uwSkip',
        `預覽只畫前 ${n} 片（共 ${r.slices.length} 片），匯出不受影響。`));
    }
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

  /** 一片一張小圖。共用框，所以孔在每張圖上都落在同一個位置。 */
  _card(slice) {
    const card = document.createElement('div');
    card.className = 'uwCard';

    const opt = { ...this._progOpt(), pegs: this._pegsOf(slice) };
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
    const base = { ...this._progOpt(), head: this.app.head };
    printSVGs(
      this.result.slices.map(s => {
        const opt = { ...base, pegs: this._pegsOf(s) };
        return progSVG(sliceProgram(s, opt), sliceTitleLines(s, opt));
      }),
      '剖面分切');
  }

  async _saveSVG() {
    if (!this._has()) return;
    // 一疊全部裝在一張 SVG 裡沒有意義（每片都要單獨排版），
    // 但一片一個檔在 45 片時是 45 次下載 —— 所以 SVG 走列印那條路，
    // 這裡只存「整疊排開」的一張，當作對照用的總覽。
    const s = this.result.slices[0];
    const opt = { ...this._progOpt(), head: this.app.head, pegs: this._pegsOf(s) };
    const blob = textBlob(progSVG(sliceProgram(s, opt), sliceTitleLines(s, opt)),
      'image/svg+xml');
    await saveBlob(blob, `${this._base()}_第1片.svg`, TYPES.svg, this.opt.askPath);
  }

  async _saveDXF() {
    if (!this._has()) return;
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
}

function box(cls, msg) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = msg;
  return d;
}

const f = v => String(Math.round(v * 100) / 100);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v, dflt) => { const x = parseFloat(v); return Number.isFinite(x) ? x : dflt; };

function loadOpt() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch (e) { return {}; }
}
function save(o) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) { /* 無所謂 */ }
}
