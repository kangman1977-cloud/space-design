/**
 * pegMapView.js — 剖面分切視窗裡的「孔位圖」（手動放孔）
 *
 * 🔴 第二輪第五批 5c（2026-10-24，kang「5c 照你的建議：方案二孔位圖，一根手動的孔從點的位置往上下找連續放得下的片
 * （可以再縮短），預設＋可以調照表」→ `規格\建模器-剖面分切.md`「手動放孔」；三種放法的對照在 `實驗-綜合評估-第二輪.md` 5c）。
 *
 * 全部片疊在一起從上面看：越綠 ＝ 那裡串得起越多片；所有片的外框淡淡疊在一起；紫色 ＝ 從自動換過來的孔、藍色 ＝ 手動加的、橘色 ＝ 選到的。
 * | 動作 | 做法 |
 * |---|---|
 * | 加 | 點空白的地方 ⇒ 那裡往上下找「連續放得下」的片（最長的那一段）；放不下 ⇒ ⛔ 加、講為什麼 |
 * | 選 | 點孔 |
 * | 移動 | 拖（拖到放不下的地方就停在最後放得下的位置）；或打 x、y |
 * | 縮短 | 打「第 ○～○ 片」（只能在放得下的範圍裡）|
 * | 刪 | 「刪」按鈕或 Delete |
 * 要算的東西在 `slice/pegs.js`（`fitRun()`、`holeMap()`，node 測得到）；這裡只管畫面、滑鼠。
 * ⚠ 同 5b：樣式由程式自己帶（⛔ 寫在 index.html —— 剛上傳時可能拿到舊的主頁面）；元素每次重排接回去、⛔ 重做。
 */

import { fitRun, holeMap } from '../slice/pegs.js';
import { insideDepth, listNums } from '../slice/section.js';

const HEIGHT = 320;
const COLORS = { auto: '#8e44ad', manual: '#2f7fe0', sel: '#ff8800' };

const CSS = [
  '.slm { margin: 0 0 14px; border: 1px solid #333944; border-radius: 8px; background: #1c1f25; overflow: hidden; }',
  '.slmBar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 6px 10px; font-size: 12px; }',
  '.slmBar b { font-size: 12.5px; }',
  '.slmBar .lbl { font-size: 11px; color: #8b93a1; }',
  '.slmBar input[type=number] { padding: 4px 6px; border-radius: 5px; border: 1px solid #3f4550; background: #191c21; color: #e8eaed; }',
  '.slmSel[hidden], .slmView[hidden] { display: none; }',
  '.slmSel { display: contents; }',
  '.slmView { position: relative; border-top: 1px solid #2c313a; background: #fff; }',
  '.slmView canvas { display: block; width: 100%; height: ' + HEIGHT + 'px; cursor: crosshair; touch-action: none; }',
  '.slmSay { padding: 6px 10px; font-size: 12px; line-height: 1.6; color: #c9d1dc; border-top: 1px solid #2c313a; }',
  '.slmSay .bad { color: #f0b8b8; }',
].join('\n');

function ensureStyle() {
  if (document.getElementById('slmStyle')) return;
  const st = document.createElement('style');
  st.id = 'slmStyle';
  st.textContent = CSS;
  document.head.appendChild(st);
}

export class PegMapView {
  /**
   * @param {object} cb { onManual(), onAuto(), onChange(holes) }
   */
  constructor(cb) {
    this.cb = cb;
    this.slices = null; this.res = null; this.opt = { d: 0.5, gap: 0.8 };
    this.holes = [];
    this.sel = -1;
    this.map = null; this._mapKey = null;
    this.msg = '';
    this._build();
  }

  _build() {
    ensureStyle();
    const el = document.createElement('div');
    el.className = 'slm';
    el.innerHTML = `
      <div class="slmBar">
        <b>定位孔</b>
        <button class="mini" data-k="mode"></button>
        <span class="lbl" data-k="hint"></span>
        <span class="slmSel" data-k="selBox">
          <span class="lbl">選到的孔　x</span><input type="number" data-k="x" step="0.1" style="width:64px">
          <span class="lbl">y</span><input type="number" data-k="y" step="0.1" style="width:64px">
          <span class="lbl">穿過第</span><input type="number" data-k="from" step="1" min="1" style="width:52px">
          <span class="lbl">～</span><input type="number" data-k="to" step="1" min="1" style="width:52px"><span class="lbl">片</span>
          <button class="mini" data-k="del">刪</button>
        </span>
      </div>
      <div class="slmView" data-k="view"><canvas></canvas></div>
      <div class="slmSay" data-k="say"></div>`;
    this.el = el;
    const $ = k => el.querySelector(`[data-k="${k}"]`);
    this.$ = $;
    this.cv = el.querySelector('canvas');

    $('mode').onclick = () => (this.manual ? this.cb.onAuto() : this.cb.onManual());
    $('del').onclick = () => this._delete();
    for (const k of ['x', 'y']) $(k).onchange = () => {
      const h = this.holes[this.sel];
      if (!h) return;
      const v = parseFloat($(k).value);
      if (!Number.isFinite(v)) { this._fields(); return; }
      if (!this._moveTo(this.sel, k === 'x' ? v : h.x, k === 'y' ? v : h.y)) {
        this.msg = `（${k === 'x' ? v : h.x}, ${k === 'y' ? v : h.y}）這裡放不下這根孔 —— 沒動`;
        this._fields();
      } else this.msg = '';     // ⚠ 上一句「這裡放不下」要清掉（本機看到：移好了那句還掛著）
      this._commit();
    };
    for (const k of ['from', 'to']) $(k).onchange = () => this._setRange(k, Math.floor(+$(k).value));

    // 點、拖
    let drag = -1, moved = false;
    this.cv.addEventListener('pointerdown', e => {
      if (!this.manual || !this.map) return;
      const [x, y] = this._toModel(e);
      const hit = this._hitHole(e);
      if (hit >= 0) { this.sel = drag = hit; moved = false; this.cv.setPointerCapture(e.pointerId); this.msg = ''; this._fields(); this.draw(); return; }
      this._add(x, y);
    });
    this.cv.addEventListener('pointermove', e => {
      if (drag < 0) return;
      const [x, y] = this._toModel(e);
      if (this._moveTo(drag, x, y)) { moved = true; this.msg = ''; this._fields(); this.draw(); }
    });
    const up = () => { if (drag >= 0 && moved) this._commit(); drag = -1; };
    this.cv.addEventListener('pointerup', up);
    this.cv.addEventListener('pointercancel', up);
    window.addEventListener('resize', () => { if (this.el.isConnected) this.draw(); });
  }

  get manual() { return !!(this.res && this.res.manual); }

  /** slicePanel 每次算完或改完孔都叫它；畫面元素由 slicePanel 接回視窗之後再 refresh() */
  setState(slices, res, opt, holes) {
    this.slices = slices; this.res = res; this.opt = opt;
    this.holes = (holes || []).map(h => ({ ...h }));
    if (this.sel >= this.holes.length) this.sel = -1;
  }

  /** 孔位圖：切的結果或孔徑、淨距變了才重算（汽車約 4 秒）；先講「正在算」、下一輪才算 */
  refresh() {
    const $ = this.$;
    $('mode').textContent = this.manual ? '回到自動' : '手動放孔';
    $('mode').title = this.manual
      ? '丟掉手動改的孔，回到程式自動找的孔'
      : '打開孔位圖：自己加孔、拖動、刪掉（自動找的孔會先放上去）';
    $('hint').textContent = this.manual
      ? '點空白處加孔（往上下找連續放得下的片）、點孔再拖、選到的孔可以打數字或刪'
      : '現在是自動找的孔';
    $('view').hidden = !this.manual;
    this._fields();
    if (!this.manual) { this._say(); return; }
    const key = this.slices && `${this.slices.length}:${this.slices.map(s => s.loops.length).join(',')}:${this.opt.d}:${this.opt.gap}:${this._sliceSig()}`;
    if (key !== this._mapKey) {
      this._mapKey = key;
      this.map = null;
      this.say('正在算孔位圖…（大的模型要幾秒，算的時候畫面會停住）');
      clearTimeout(this._t);
      this._t = setTimeout(() => {
        this.map = holeMap(this.slices, this.opt);
        this.draw();
        this._say();
      }, 30);
      return;
    }
    this.draw();
    this._say();
  }

  _sliceSig() {
    // 同樣片數但切的位置變了（例如改板厚）也要重算
    return this.slices.map(s => `${s.z0.toFixed(3)}/${s.area.toFixed(2)}`).join(',');
  }

  get need() { return this.opt.d / 2 + this.opt.gap; }

  // ── 改孔 ────────────────────────────────────────────

  _add(x, y) {
    const r = fitRun(this.slices, x, y, this.need);
    if (!r) { this.msg = this._why(x, y); this._say(); return; }
    this.holes.push({ x: snap(x), y: snap(y), from: r.from, to: r.to });
    this.sel = this.holes.length - 1;
    this.msg = '';
    this._commit();
  }

  /** 移到 (x, y)：原本的範圍都放得下就留著；不然從原本範圍的中間那片往上下找；都不行 ⇒ ⛔ 動、回 false */
  _moveTo(i, x, y) {
    const h = this.holes[i];
    const solid = this.slices.filter(s => s.loops.length && s.index >= h.from && s.index <= h.to);
    if (solid.length && solid.every(s => insideDepth(s.loops, x, y) >= this.need)) {
      Object.assign(h, { x: snap(x), y: snap(y), auto: false });
      return true;
    }
    const mid = solid.length ? solid[Math.floor(solid.length / 2)].index : null;
    const r = (mid != null && fitRun(this.slices, x, y, this.need, mid)) || fitRun(this.slices, x, y, this.need);
    if (!r) return false;
    Object.assign(h, { x: snap(x), y: snap(y), from: r.from, to: r.to, auto: false });
    return true;
  }

  /** 縮短：只能在「這個位置連續放得下」的範圍裡 */
  _setRange(k, v) {
    const h = this.holes[this.sel];
    if (!h || !Number.isFinite(v)) { this._fields(); return; }
    const max = fitRun(this.slices, h.x, h.y, this.need, k === 'from' ? h.to : h.from)
      || { from: h.from, to: h.to };
    let from = k === 'from' ? v : h.from, to = k === 'to' ? v : h.to;
    from = Math.max(max.from, Math.min(from, max.to));
    to = Math.max(max.from, Math.min(to, max.to));
    if (from > to) [from, to] = [to, from];
    this.msg = (from !== (k === 'from' ? v : h.from) || to !== (k === 'to' ? v : h.to))
      ? `這個位置只放得下第 ${max.from}～${max.to} 片 —— 範圍改成第 ${from}～${to} 片` : '';
    Object.assign(h, { from, to, auto: false });
    this._commit();
  }

  _delete() {
    if (this.sel < 0) return;
    this.holes.splice(this.sel, 1);
    this.sel = -1;
    this.msg = '';
    this._commit();
  }

  /** Delete 鍵（slicePanel 的 keydown 轉過來；⚠ 主畫面那邊視窗開著時本來就不接 Delete）*/
  onKey(e) {
    if (!this.manual || this.sel < 0 || !this.el.isConnected) return false;
    if (e.key !== 'Delete' && e.key !== 'Backspace') return false;
    const t = e.target.tagName;
    if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return false;
    this._delete();
    return true;
  }

  _commit() { this.cb.onChange(this.holes.map(h => ({ ...h }))); }

  /** 點到放不下的地方：講為什麼（這裡離料邊不到淨距；或每一片在這裡都沒料）*/
  _why(x, y) {
    const best = Math.max(...this.slices.filter(s => s.loops.length).map(s => insideDepth(s.loops, x, y)));
    return best <= 0
      ? `（${f(x)}, ${f(y)}）這裡每一片都沒有料 —— 沒加`
      : `（${f(x)}, ${f(y)}）這裡放不下：孔邊離料邊最多只剩 ${f(best - this.opt.d / 2)} cm（要 ${f(this.opt.gap)} cm）—— 沒加；往綠色的地方點`;
  }

  // ── 畫 ──────────────────────────────────────────────

  _frame() {
    const m = this.map, W = Math.max(200, this.cv.clientWidth), H = HEIGHT, pad = 12;
    const s = Math.min((W - 2 * pad) / m.box.w, (H - 2 * pad) / m.box.h);
    const ox = (W - m.box.w * s) / 2 - m.box.minX * s, oy = (H + m.box.h * s) / 2 + m.box.minY * s;
    return { W, H, s, X: x => ox + x * s, Y: y => oy - y * s, inv: (px, py) => [(px - ox) / s, (oy - py) / s] };
  }

  _toModel(e) {
    const b = this.cv.getBoundingClientRect();
    return this._frame().inv(e.clientX - b.left, e.clientY - b.top);
  }

  _hitHole(e) {
    const b = this.cv.getBoundingClientRect(), V = this._frame();
    const px = e.clientX - b.left, py = e.clientY - b.top;
    let best = -1, bd = 10;
    this.holes.forEach((h, i) => { const d = Math.hypot(V.X(h.x) - px, V.Y(h.y) - py); if (d < bd) { bd = d; best = i; } });
    return best;
  }

  draw() {
    if (!this.manual || !this.map || !this.el.isConnected) return;
    const V = this._frame(), m = this.map;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = Math.round(V.W * dpr); this.cv.height = Math.round(V.H * dpr);
    const g = this.cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#fff'; g.fillRect(0, 0, V.W, V.H);
    // 綠：每一格串得起幾片
    const cw = m.step * V.s;
    m.ys.forEach((y, j) => m.xs.forEach((x, i) => {
      const c = m.counts[j * m.xs.length + i];
      if (!c) return;
      g.fillStyle = `rgba(30,150,80,${(0.08 + 0.6 * c / m.n).toFixed(3)})`;
      g.fillRect(V.X(x) - cw / 2, V.Y(y) - cw / 2, cw + 0.5, cw + 0.5);
    }));
    // 所有片的外框淡淡疊在一起
    g.strokeStyle = 'rgba(0,0,0,.14)'; g.lineWidth = 0.7;
    for (const s of this.slices) for (const l of s.loops) {
      g.beginPath();
      l.pts.forEach((p, i) => (i ? g.lineTo(V.X(p.x), V.Y(p.y)) : g.moveTo(V.X(p.x), V.Y(p.y))));
      g.closePath(); g.stroke();
    }
    // 孔
    const r = Math.max(5, this.opt.d / 2 * V.s);
    this.holes.forEach((h, i) => {
      g.beginPath(); g.arc(V.X(h.x), V.Y(h.y), r, 0, Math.PI * 2);
      g.fillStyle = '#fff'; g.fill();
      g.lineWidth = i === this.sel ? 3 : 2;
      g.strokeStyle = i === this.sel ? COLORS.sel : (h.auto ? COLORS.auto : COLORS.manual);
      g.stroke();
      g.fillStyle = '#333'; g.font = '11px sans-serif';
      g.fillText(String(i + 1), V.X(h.x) + r + 2, V.Y(h.y) - r);
    });
  }

  _fields() {
    const $ = this.$, h = this.holes[this.sel];
    $('selBox').hidden = !this.manual || !h;
    if (!h) return;
    $('x').value = h.x; $('y').value = h.y; $('from').value = h.from; $('to').value = h.to;
  }

  say(text) { this.$('say').textContent = text; }

  _say() {
    const el = this.$('say');
    if (!this.manual || !this.res) { el.textContent = ''; el.hidden = true; return; }
    el.hidden = false;
    const res = this.res;
    const solid = this.slices.filter(s => s.loops.length);
    const lines = [];
    if (this.msg) lines.push(`<span class="bad">${esc(this.msg)}</span>`);
    const h = res.holes && res.holes[this.sel];
    if (h) {
      lines.push(`孔 ${this.sel + 1}（${f(h.x)}, ${f(h.y)}）穿過第 ${h.from}～${h.to} 片`
        + (h.miss.length ? `，<span class="bad">第 ${listNums(h.miss)} 片放不下、不打</span>` : '')
        + (h.drilled.length ? `；孔邊離料邊最少 ${f(minIn(this.slices, h) - this.opt.d / 2)} cm` : ''));
    }
    const covered = solid.length - res.skipped.length;
    lines.push(`${this.holes.length} 根孔，串起來的 ${covered}／${solid.length} 片`
      + (res.skipped.length ? `；沒有孔：第 ${listNums(res.skipped)} 片` : '；每一片都有孔')
      + (res.narrow.length ? `（第 ${listNums(res.narrow)} 片窄到放不下這個孔 —— 要把孔徑或淨距調小）` : ''));
    el.innerHTML = lines.join('<br>');
  }
}

function minIn(slices, h) {
  let d = Infinity;
  for (const s of slices) if (h.drilled.includes(s.index)) d = Math.min(d, insideDepth(s.loops, h.x, h.y));
  return d;
}

const snap = v => { const x = Math.round(v * 100) / 100; return x === 0 ? 0 : x; };
const f = v => String(Math.round(v * 100) / 100);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
