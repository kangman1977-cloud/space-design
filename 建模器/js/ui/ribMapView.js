/**
 * ribMapView.js — 剖面分切視窗裡的「肋位圖」（互卡：挪肋）
 *
 * 🔴 第二輪第六批 6c（2026-10-25，kang「6c 照你的建議：甲 肋可以挪＋側面 1～3 片，一 肋位圖，
 * 要「幫我挪有問題的肋」按鈕（按了才算），預設照表」→ `規格\建模器-剖面分切.md`「肋位圖」；
 * 四種做法的對照在 `實驗-綜合評估-第二輪.md` 6c）。
 *
 * 從上面看：模型的外形（從下到上切 7 層疊在一起）、藍粗線 ＝ 側面、灰線 ＝ 肋；紅 ＝ 那片肋有掉下來的塊、橘 ＝ 卡不牢、紫 ＝ 選到的。
 * 🔴 6d（2026-10-25，kang「小脊先不做，肋位圖加紅點（平常就畫），紅框那一句改成教人怎麼救」）：**紅點 ＝ 掉下來的塊在哪**
 * （`interlockMany()` 的 `looseDots`）—— 把側面拖到紅點上、再按幫我挪，腳張開的模型多半救得回來。
 * | 動作 | 做法（手動挪肋時）|
 * |---|---|
 * | 選 | 點一條線（側面或肋）|
 * | 挪 | 拖（放開才重切）；或打位置 |
 * | 加肋 | 點空白的地方（跟旁邊的肋至少隔 2 倍板厚）|
 * | 刪肋 | 「刪」按鈕或 Delete（側面的片數在上面那一排改，這裡⛔ 刪）|
 * | 幫我挪 | 程式試把有問題的肋往左右挪 0.5、1 cm（按了才算）—— 結果放在圖上、還可以再改 |
 * 要算的東西在 `slice/interlock.js`（`interlockMany()`、`suggestRibs()`、`topOutline()`，node 測得到）；這裡只管畫面、滑鼠。
 * ⚠ 同 5b、5c：樣式由程式自己帶（⛔ 寫在 index.html）；元素每次重排接回去、⛔ 重做。
 */

const HEIGHT = 300;
const COLORS = { spine: '#1a5fd0', rib: '#8a8f98', loose: '#d22', weak: '#e08a00', sel: '#8e44ad', outline: '#b9a27a' };

const CSS = [
  '.slr { margin: 0 0 14px; border: 1px solid #333944; border-radius: 8px; background: #1c1f25; overflow: hidden; }',
  '.slrBar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 10px; font-size: 12px; }',
  '.slrBar b { font-size: 12.5px; }',
  '.slrBar .lbl { font-size: 11px; color: #8b93a1; }',
  '.slrBar input[type=number] { padding: 4px 6px; border-radius: 5px; border: 1px solid #3f4550; background: #191c21; color: #e8eaed; }',
  '.slrSel[hidden] { display: none; }',
  '.slrSel { display: contents; }',
  '.slrView { position: relative; border-top: 1px solid #2c313a; background: #fff; }',
  '.slrView canvas { display: block; width: 100%; height: ' + HEIGHT + 'px; touch-action: none; }',
  '.slrView.edit canvas { cursor: crosshair; }',
  '.slrSay { padding: 6px 10px; font-size: 12px; line-height: 1.6; color: #c9d1dc; border-top: 1px solid #2c313a; }',
  '.slrSay .bad { color: #f0b8b8; }',
].join('\n');

function ensureStyle() {
  if (document.getElementById('slrStyle')) return;
  const st = document.createElement('style');
  st.id = 'slrStyle';
  st.textContent = CSS;
  document.head.appendChild(st);
}

export class RibMapView {
  /**
   * @param {object} cb { onManual(), onAuto(), onChange({spines, ribs}), onSuggest() }
   */
  constructor(cb) {
    this.cb = cb;
    this.res = null; this.outline = []; this.manual = false;
    this.spines = []; this.ribs = [];
    this.sel = null;            // { kind: 'rib'|'spine', i }
    this.msg = ''; this.note = '';
    this._build();
  }

  _build() {
    ensureStyle();
    const el = document.createElement('div');
    el.className = 'slr';
    el.innerHTML = `
      <div class="slrBar">
        <b>肋位圖</b>
        <button class="mini" data-k="mode"></button>
        <button class="mini" data-k="suggest" title="程式試把有掉下來、卡不牢的肋往左右挪 0.5、1 cm，比較好才留 —— 結果放在圖上，還可以再改。大的模型要算十幾秒">幫我挪有問題的肋</button>
        <span class="lbl" data-k="hint"></span>
        <span class="slrSel" data-k="selBox">
          <span class="lbl" data-k="selName"></span><input type="number" data-k="pos" step="0.1" style="width:72px"><span class="lbl">cm</span>
          <button class="mini" data-k="del">刪</button>
        </span>
      </div>
      <div class="slrView" data-k="view"><canvas></canvas></div>
      <div class="slrSay" data-k="say"></div>`;
    this.el = el;
    const $ = k => el.querySelector(`[data-k="${k}"]`);
    this.$ = $;
    this.cv = el.querySelector('canvas');

    $('mode').onclick = () => (this.manual ? this.cb.onAuto() : this.cb.onManual());
    $('suggest').onclick = () => this.cb.onSuggest();
    $('del').onclick = () => this._delete();
    $('pos').onchange = () => {
      const v = parseFloat($('pos').value);
      if (!this.sel || !Number.isFinite(v)) { this._fields(); return; }
      if (!this._moveTo(this.sel, v)) { this._fields(); this._say(); return; }
      this._commit();
    };

    // 點、拖（手動挪肋時）
    let drag = null, moved = false;
    this.cv.addEventListener('pointerdown', e => {
      if (!this.manual || !this.res) return;
      const hit = this._hit(e);
      if (hit) { this.sel = drag = hit; moved = false; this.cv.setPointerCapture(e.pointerId); this.msg = ''; this._fields(); this.draw(); this._say(); return; }
      this._add(e);
    });
    this.cv.addEventListener('pointermove', e => {
      if (!drag) return;
      const [x, z] = this._toModel(e);
      const c = this._lineAxis(drag.kind) === 'x' ? x : z;
      if (this._moveTo(drag, c, true)) { moved = true; this._fields(); this.draw(); }
    });
    const up = () => { if (drag && moved) this._commit(); drag = null; };
    this.cv.addEventListener('pointerup', up);
    this.cv.addEventListener('pointercancel', up);
    window.addEventListener('resize', () => { if (this.el.isConnected) this.draw(); });
  }

  /**
   * slicePanel 每次算完都叫它。
   * @param {object} res `interlockMany()` 的結果
   * @param {{x:number, z:number}[][]} outline `topOutline()`
   * @param {boolean} manual 手動挪過（肋位圖可以改）
   * @param {string} note 上一次「幫我挪」的結果（講一次）
   */
  setState(res, outline, manual, note) {
    const keep = this.sel && this._coordOf(this.sel);
    this.res = res; this.outline = outline || []; this.manual = !!manual;
    this.spines = (res.stats.spineCoordsWanted || res.stats.spineCoords).slice();     // 6d：切到空的那片也留著（虛線）
    this.ribs = res.ribInfo.map(q => q.coord);
    this.note = note || '';
    // 重切之後線的順序可能變了 ⇒ 用位置找回選到的那一條
    this.sel = null;
    if (keep != null && this.manual) {
      for (const kind of ['spine', 'rib']) {
        const i = this._list(kind).findIndex(c => Math.abs(c - keep.c) < 1e-6);
        if (i >= 0 && kind === keep.kind) this.sel = { kind, i };
      }
    }
  }

  refresh() {
    const $ = this.$;
    $('mode').textContent = this.manual ? '回到自動' : '手動挪肋';
    $('mode').title = this.manual
      ? '丟掉手動挪過的位置，回到等間距的肋（側面回到自動的位置）'
      : '自己挪肋：拖、打位置、點空白處加、刪（現在的位置會先放上去）';
    $('hint').textContent = this.manual
      ? '點一條線選起來再拖（放開才重切）、點空白處加一片肋、選到的可以打位置或刪'
      : '藍 ＝ 側面、灰 ＝ 肋、紅 ＝ 有掉下來（紅點 ＝ 掉下來的塊在哪）、橘 ＝ 卡不牢';
    this.el.querySelector('.slrView').classList.toggle('edit', this.manual);
    this._fields();
    this.draw();
    this._say();
  }

  // ── 座標 ────────────────────────────────────────────

  get spineAx() { return this.res ? this.res.axis : 'x'; }
  /** 這種線的位置是哪個座標：側面切 X ⇒ 側面在 x ＝ c；肋就在 z ＝ c（反過來也一樣）*/
  _lineAxis(kind) { const s = this.spineAx; return kind === 'spine' ? s : (s === 'x' ? 'z' : 'x'); }
  _list(kind) { return kind === 'spine' ? this.spines : this.ribs; }
  _coordOf(sel) { const c = this._list(sel.kind)[sel.i]; return c == null ? null : { kind: sel.kind, c }; }

  _frame() {
    const b = this.res.bounds, W = Math.max(200, this.cv.clientWidth), H = HEIGHT, pad = 18;
    const w = b.size.x || 1, h = b.size.z || 1;
    const s = Math.min((W - 2 * pad) / w, (H - 2 * pad) / h);
    const ox = (W - w * s) / 2 - b.min.x * s, oz = (H - h * s) / 2 - b.min.z * s;
    // 從上面看：右 ＝ +x、下 ＝ +z（前面在下面，跟主畫面的「上視圖」一樣）
    return { W, H, s, X: x => ox + x * s, Z: z => oz + z * s, inv: (px, pz) => [(px - ox) / s, (pz - oz) / s] };
  }

  _toModel(e) {
    const r = this.cv.getBoundingClientRect();
    return this._frame().inv(e.clientX - r.left, e.clientY - r.top);
  }

  /** 點到哪一條線（7 px 以內）—— 側面先 */
  _hit(e) {
    const r = this.cv.getBoundingClientRect(), V = this._frame();
    const px = e.clientX - r.left, pz = e.clientY - r.top;
    let best = null, bd = 7;
    for (const kind of ['spine', 'rib']) {
      const ax = this._lineAxis(kind);
      this._list(kind).forEach((c, i) => {
        const d = ax === 'x' ? Math.abs(V.X(c) - px) : Math.abs(V.Z(c) - pz);
        if (d < bd) { bd = d; best = { kind, i }; }
      });
    }
    return best;
  }

  // ── 改位置 ──────────────────────────────────────────

  get gap() { return 2 * (this.res ? this.res.stats.t : 0.5); }

  /** 挪到 c（只能在模型的範圍裡；肋跟旁邊的肋至少隔 2 倍板厚）；不行 ⇒ ⛔ 動、講為什麼、回 false */
  _moveTo(sel, c, quiet) {
    const ax = this._lineAxis(sel.kind), b = this.res.bounds;
    const v = snap(Math.min(b.max[ax], Math.max(b.min[ax], c)));
    const list = this._list(sel.kind);
    const near = list.some((q, j) => j !== sel.i && Math.abs(q - v) < this.gap);
    if (near) {
      if (!quiet) this.msg = `${ax} ＝ ${f(v)} 跟旁邊那一片太近（要隔 ${f(this.gap)} cm 以上，兩倍板厚）—— 沒動`;
      return false;
    }
    list[sel.i] = v;
    if (!quiet) this.msg = c !== v && (c < b.min[ax] || c > b.max[ax]) ? `超出模型的範圍 —— 放在邊上 ${ax} ＝ ${f(v)}` : '';
    return true;
  }

  _add(e) {
    const [x, z] = this._toModel(e);
    const ax = this._lineAxis('rib'), c = snap(ax === 'x' ? x : z), b = this.res.bounds;
    if (c < b.min[ax] || c > b.max[ax]) { this.msg = '點在模型外面 —— 沒加'; this._say(); return; }
    if (this.ribs.some(q => Math.abs(q - c) < this.gap)) {
      this.msg = `${ax} ＝ ${f(c)} 跟旁邊的肋太近（要隔 ${f(this.gap)} cm 以上，兩倍板厚）—— 沒加`; this._say(); return;
    }
    this.ribs.push(c);
    this.sel = { kind: 'rib', i: this.ribs.length - 1 };
    this.msg = '';
    this._commit();
  }

  _delete() {
    if (!this.sel) return;
    if (this.sel.kind === 'spine') { this.msg = '側面的片數在上面那一排改（要先按「回到自動」）—— 這裡只能挪側面'; this._say(); return; }
    if (this.ribs.length <= 1) { this.msg = '只剩一片肋 —— 不能再刪'; this._say(); return; }
    this.ribs.splice(this.sel.i, 1);
    this.sel = null;
    this.msg = '';
    this._commit();
  }

  /** Delete 鍵（slicePanel 的 keydown 轉過來；⚠ 主畫面那邊視窗開著時本來就不接 Delete）*/
  onKey(e) {
    if (!this.manual || !this.sel || !this.el.isConnected) return false;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return false;
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return false;
    this._delete();
    return true;
  }

  _commit() {
    this.cb.onChange({ spines: this.spines.slice(), ribs: this.ribs.slice() });
  }

  // ── 畫 ──────────────────────────────────────────────

  draw() {
    if (!this.res || !this.el.isConnected) return;
    const V = this._frame(), b = this.res.bounds;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = Math.round(V.W * dpr); this.cv.height = Math.round(V.H * dpr);
    const g = this.cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#fff'; g.fillRect(0, 0, V.W, V.H);
    // 外形：7 層淡淡疊在一起
    g.fillStyle = 'rgba(233,220,195,.35)'; g.strokeStyle = COLORS.outline; g.lineWidth = 0.6;
    for (const l of this.outline) {
      g.beginPath();
      l.forEach((p, i) => (i ? g.lineTo(V.X(p.x), V.Z(p.z)) : g.moveTo(V.X(p.x), V.Z(p.z))));
      g.closePath(); g.fill(); g.stroke();
    }
    const line = (kind, c, color, wd) => {
      const ax = this._lineAxis(kind);
      g.strokeStyle = color; g.lineWidth = wd; g.beginPath();
      if (ax === 'x') { g.moveTo(V.X(c), V.Z(b.min.z) - 8); g.lineTo(V.X(c), V.Z(b.max.z) + 8); }
      else { g.moveTo(V.X(b.min.x) - 8, V.Z(c)); g.lineTo(V.X(b.max.x) + 8, V.Z(c)); }
      g.stroke();
    };
    const label = (kind, c, text, color) => {
      const ax = this._lineAxis(kind);
      g.fillStyle = color; g.font = '11px sans-serif';
      if (ax === 'x') g.fillText(text, V.X(c) + 3, V.Z(b.min.z) - 9 + 10);
      else g.fillText(text, V.X(b.min.x) - 16, V.Z(c) - 3);
    };
    // 肋：照這一次切的結果上色（手動拖的時候還沒重切 ⇒ 灰）
    const info = this.res.ribInfo;
    this.ribs.forEach((c, i) => {
      const q = info.find(r => Math.abs(r.coord - c) < 1e-6);
      const isSel = this.sel && this.sel.kind === 'rib' && this.sel.i === i;
      const color = isSel ? COLORS.sel : q && q.loose ? COLORS.loose : q && q.weak ? COLORS.weak : COLORS.rib;
      line('rib', c, color, isSel ? 3 : (q && (q.loose || q.weak) ? 2.2 : 1.2));
      if (q && q.n) label('rib', c, String(q.n), color);
    });
    // 6d：紅點 ＝ 掉下來的塊在哪（平常就畫）；大小照面積、至少看得到（3～8 px）
    g.fillStyle = 'rgba(221,34,34,.75)';
    for (const d of this.res.looseDots || []) {
      g.beginPath(); g.arc(V.X(d.x), V.Z(d.z), Math.max(3, Math.min(8, Math.sqrt(d.area) * 2)), 0, Math.PI * 2); g.fill();
    }
    // 側面：標籤用切出來的零件編號（S、S1…）；切到空的地方 ⇒ 虛線、標「空的」（6d：人才知道它在哪、可以拖到紅點上）
    const kept = this.res.slices.filter(s => s.index < this.res.stats.spines);
    this.spines.forEach((c, i) => {
      const isSel = this.sel && this.sel.kind === 'spine' && this.sel.i === i;
      const part = kept.find(s => Math.abs(s.coord - c) < 1e-6);
      if (!part) g.setLineDash([6, 4]);
      line('spine', c, isSel ? COLORS.sel : COLORS.spine, part ? 3 : 2);
      g.setLineDash([]);
      label('spine', c, part ? part.tag : '（空的）', isSel ? COLORS.sel : COLORS.spine);
    });
  }

  _fields() {
    const $ = this.$, s = this.sel && this._coordOf(this.sel);
    $('selBox').hidden = !this.manual || !s;
    $('suggest').hidden = false;
    if (!s) return;
    const ax = this._lineAxis(this.sel.kind);
    const q = this.sel.kind === 'rib' && this.res.ribInfo.find(r => Math.abs(r.coord - s.c) < 1e-6);
    $('selName').textContent = this.sel.kind === 'spine'
      ? (() => {     // 6d：照切出來的零件叫（側面、側面 2…）；切到空的 ⇒「側面（空的）」
          const part = this.res.slices.find(q => q.index < this.res.stats.spines && Math.abs(q.coord - s.c) < 1e-6);
          return `選到的${part ? part.label : '側面（空的）'}　${ax} ＝`;
        })()
      : `選到的肋${q && q.n ? ' ' + q.n : ''}　${ax} ＝`;
    $('pos').value = Math.round(s.c * 100) / 100;     // 6d 本機看到：切出來的座標有浮點尾數（8.599999999999998）⇒ 顯示到 0.01
    $('del').hidden = this.sel.kind === 'spine';
  }

  /** slicePanel「正在算」時直接換字 */
  say(text) { const el = this.$('say'); el.hidden = false; el.textContent = text; }

  _say() {
    const el = this.$('say');
    if (!this.res) { el.textContent = ''; return; }
    el.hidden = false;
    const info = this.res.ribInfo.filter(q => !q.empty);
    const bad = info.filter(q => q.loose), weak = info.filter(q => !q.loose && q.weak);
    const lines = [];
    if (this.msg) lines.push(`<span class="bad">${esc(this.msg)}</span>`);
    if (this.note) lines.push(esc(this.note));
    const emptyS = this.spines.length - this.res.stats.spines;
    lines.push(`側面 ${this.res.stats.spines} 片${emptyS > 0 ? `（另有 ${emptyS} 片切到空的地方，畫成虛線${this.manual ? '，拖到有料的地方或紅點上' : '，按「手動挪肋」可以拖'}）` : ''}、肋 ${info.length} 片${this.manual ? '（手動挪過）' : '（等間距）'}`
      + (bad.length ? `；<span class="bad">有掉下來的：肋 ${bad.map(q => q.n).join('、')}</span>` : '')
      + (weak.length ? `；卡不牢：肋 ${weak.map(q => q.n).join('、')}` : '')
      + (!bad.length && !weak.length ? '；每一片肋都沒有掉下來、沒有卡不牢' : ''));
    /** 6d：有掉下來的塊 ⇒ 教人怎麼救（紅框那一句一樣的意思）*/
    if ((this.res.looseDots || []).length) {
      lines.push(`紅點 ＝ 掉下來的塊（${this.res.looseDots.length} 塊）—— 把「側面」改成 2～3 片、按「手動挪肋」把側面拖到紅點上，再按「幫我挪有問題的肋」`);
    }
    el.innerHTML = lines.join('<br>');
  }
}

const snap = v => { const x = Math.round(v * 10) / 10; return x === 0 ? 0 : x; };
const f = v => String(Math.round(v * 100) / 100);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
