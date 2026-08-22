/**
 * importPanel.js — 匯入線稿（SVG）
 *
 * 在 Illustrator 裡畫好的線稿丟進來，擠出成 3D 物件。
 *
 * ── 這個視窗的主角是「尺寸」，不是「單位」──────────────────
 * 最容易靜靜出錯的是比例：SVG 內部是「使用者單位」，跟公分的關係
 * 要靠 width／height 對 viewBox 算出來。算錯的話**圖一模一樣、
 * 東西做出來大小全錯**，而且要切完料才發現。
 *
 * 所以確認視窗不問「這是什麼單位」—— 單位是抽象的，看到「mm」
 * 還得在腦子裡換算一次才知道對不對。它問的是「**這樣大小對嗎**」，
 * 把換算後的實際外框用大字寫出來。「我那個明明 40 公分寬，
 * 怎麼變成 4 公分」是一眼就抓得到的。
 *
 * 三層，一層比一層可靠：
 *   一、讀檔案自己宣告的（Illustrator 存 SVG 會寫）—— 這不是猜，是讀
 *   二、讀不到就講「這個檔沒寫尺寸」，不偷偷給預設值
 *   三、還是不對，直接輸入「整體寬度應該是幾公分」反算比例
 *
 * 算什麼在 sketch/ 與 build/，這裡只收設定、排結果、接按鈕。
 */

import { readSVG, UNIT_KEYS } from '../sketch/profile.js';
import { flatPts, cornerIdx } from '../build/prim.js';
import { ModelObject, KIND } from '../core/io.js';

const LS_KEY = 'modeler_import';

export class ImportPanel {
  /** @param {object} app { doc, sel, hist, onEdit, toast } */
  constructor(app) {
    this.app = app;
    this.opt = { tolMm: 0.2, h: 3, unit: '', ...loadOpt() };
    this.text = '';
    this.fileName = '';
    this.result = null;
    this.cmPerUnit = 0;          // 手動校正用；0 ＝ 照檔案算
    this._build();
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'importWin';
    el.className = 'uwWin';
    el.hidden = true;
    el.innerHTML = `
      <div class="uwBack"></div>
      <div class="uwBox">
        <div class="uwHead">
          <b>匯入線稿</b>
          <span class="uwSum" id="imSum"></span>
          <button class="mini" id="imClose">關閉</button>
        </div>
        <div class="uwBar">
          <button id="imPick">選 SVG 檔…</button>
          <span class="lbl" id="imFile">還沒選檔案</span>
          <span class="sp"></span>
          <span class="lbl">曲線精度 mm</span>
          <input type="number" id="imTol" step="0.05" min="0.01" style="width:70px">
          <span class="lbl">擠出高度 cm</span>
          <input type="number" id="imH" step="0.5" min="0.05" style="width:70px">
          <span class="sp"></span>
          <button id="imGo" disabled>匯入成 3D 物件</button>
        </div>
        <div class="uwBody" id="imBody"></div>
      </div>
      <input type="file" id="imFileIn" accept=".svg,image/svg+xml" hidden>`;
    document.body.appendChild(el);
    this.el = el;

    const $ = id => el.querySelector('#' + id);
    this.body = $('imBody');
    this.sum = $('imSum');
    this.fileLbl = $('imFile');
    this.goBtn = $('imGo');

    this.tolIn = $('imTol');
    this.tolIn.value = this.opt.tolMm;
    this.tolIn.title = '曲線攤平成折線時，弧跟弦最遠差多少。'
      + '0.2mm 對雷切綽綽有餘；要更圓滑就調小，點數會變多';
    this.tolIn.onchange = () => {
      this.opt.tolMm = num(this.tolIn.value, 0.2);
      save(this.opt); this.run();
    };

    this.hIn = $('imH');
    this.hIn.value = this.opt.h;
    this.hIn.title = '往上擠出多高。匯入之後在右側面板還可以改';
    this.hIn.onchange = () => { this.opt.h = num(this.hIn.value, 3); save(this.opt); };

    const fin = $('imFileIn');
    $('imPick').onclick = () => fin.click();
    fin.onchange = async () => {
      const f = fin.files && fin.files[0];
      if (!f) return;
      this.fileName = f.name;
      this.text = await f.text();
      this.cmPerUnit = 0;                 // 換檔案就把手動校正清掉
      this.opt.unit = '';
      this.fileLbl.textContent = f.name;
      this.run();
      fin.value = '';                     // 同一個檔再選一次也要觸發
    };

    $('imClose').onclick = () => this.close();
    el.querySelector('.uwBack').onclick = () => this.close();
    this.goBtn.onclick = () => this._import();

    window.addEventListener('keydown', e => {
      if (!this.el.hidden && e.key === 'Escape') this.close();
    });
  }

  open() { this.el.hidden = false; this.run(); }
  close() { this.el.hidden = true; }
  get isOpen() { return !this.el.hidden; }

  // ── 讀一次並重畫 ────────────────────────────────────

  run() {
    if (!this.text) {
      this.result = null;
      this.sum.textContent = '';
      this.goBtn.disabled = true;
      this.body.innerHTML = '';
      this.body.appendChild(box('uwSkip',
        '按「選 SVG 檔」挑一個 Illustrator 匯出的線稿。'
        + '匯出設定建議：樣式「簡報屬性」、**取消勾選「回應式」**'
        + '（勾了會把尺寸資訊拿掉）、物件 ID 用「圖層名稱」。'
        + '圖上如果有文字，先在 Illustrator 裡「建立外框」。'));
      return;
    }

    this.result = readSVG(this.text, {
      tolMm: this.opt.tolMm,
      unit: this.opt.unit || undefined,
      cmPerUnit: this.cmPerUnit || undefined
    });
    this._render();
  }

  _render() {
    const r = this.result;
    this.body.innerHTML = '';
    this.goBtn.disabled = !r.ok;

    if (r.reason && !r.loops) {
      this.sum.textContent = '讀不到東西';
      this.body.appendChild(box('uwWarn', '⚠ ' + r.reason));
      return;
    }

    const pieces = r.loops.length;
    const holes = r.loops.reduce((n, l) => n + l.holes.length, 0);
    this.sum.textContent = `${pieces} 個形狀　內孔 ${holes} 個　`
      + `淨面積 ${f(r.area)} cm²`;

    // ── 主角：換算後的實際大小 ──
    this.body.appendChild(this._sizeCard(r));

    for (const e of r.errors) this.body.appendChild(box('uwWarn', '⚠ ' + e));
    for (const n of r.notes) this.body.appendChild(box('uwSkip', n));

    if (r.loops.length) this.body.appendChild(this._preview(r));

    // ── 一形狀一列 ──
    const tb = document.createElement('table');
    tb.className = 'uwBom';
    tb.innerHTML = '<tr><th>形狀</th><th>圖層</th><th>點數</th><th>內孔</th>'
      + '<th>面積 cm²</th><th>外框 cm</th></tr>'
      + r.loops.map(l => {
        const b = bnds(l.pts);
        return `<tr><td>${esc(l.name)}</td><td>${esc(l.layer)}</td>`
          + `<td>${l.pts.length}</td><td>${l.holes.length}</td>`
          + `<td>${f(Math.abs(l.area) - l.holes.reduce((s, h) => s + Math.abs(h.area), 0))}</td>`
          + `<td>${f(b.w)} × ${f(b.h)}</td></tr>`;
      }).join('');
    const wrap = document.createElement('div');
    wrap.className = 'uwBomWrap';
    wrap.innerHTML = '<h3>讀到的形狀</h3>';
    wrap.appendChild(tb);
    this.body.appendChild(wrap);
  }

  /**
   * 尺寸卡。這是整個視窗最重要的東西 ——
   * 使用者唯一需要核對的就是這兩個數字。
   */
  _sizeCard(r) {
    const card = document.createElement('div');
    card.className = 'uwCard';
    const bad = r.scale.from === 'guess';

    card.innerHTML = `
      <div class="uwTitle">
        <div class="nm">換算後的實際大小</div>
      </div>
      <div style="font-size:26px;font-weight:600;color:${bad ? '#e8b84b' : '#7dd87d'};
                  margin:2px 0 6px;letter-spacing:.5px">
        ${f(r.size.w)} × ${f(r.size.h)} <span style="font-size:15px">cm</span>
      </div>
      <div style="color:#8b93a1;font-size:12px;margin-bottom:10px">
        來源：${esc(r.scale.label)}　1 個 SVG 單位 = ${r.scale.cmPerUnit.toFixed(5)} cm
      </div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <span class="lbl">不對的話 → 這張圖的整體寬度其實是</span>
        <input type="number" id="imW" step="0.1" min="0.01" style="width:90px"
               value="${(Math.round(r.size.w * 100) / 100)}">
        <span class="lbl">cm</span>
        <button class="mini" id="imFix">照這個校正</button>
        <span class="sp"></span>
        <span class="lbl">或直接指定來源單位</span>
        <select id="imUnit"></select>
      </div>`;

    const sel = card.querySelector('#imUnit');
    for (const u of ['', ...UNIT_KEYS]) {
      const o = document.createElement('option');
      o.value = u;
      o.textContent = u === '' ? '（照檔案）' : u;
      sel.appendChild(o);
    }
    sel.value = this.opt.unit || '';
    sel.onchange = () => {
      this.opt.unit = sel.value;
      this.cmPerUnit = 0;
      save(this.opt);
      this.run();
    };

    card.querySelector('#imFix').onclick = () => {
      const want = num(card.querySelector('#imW').value, 0);
      if (!(want > 0) || !(r.size.w > 0)) return;
      /**
       * 反算比例：目前算出來的寬度 × 倍率 ＝ 你說的寬度。
       * 用「整體寬度」而不是「拉一段已知長度」，是因為整體寬度
       * 你一定知道，而且不必在圖上精準地拉線。
       */
      this.cmPerUnit = r.scale.cmPerUnit * (want / r.size.w);
      this.opt.unit = '';
      this.run();
      if (this.app.toast) this.app.toast(`比例已校正，整體寬度設為 ${want} cm`);
    };

    return card;
  }

  /** 預覽：外框畫實線，內孔畫虛線 —— 一眼看得出洞有沒有被認出來 */
  _preview(r) {
    const card = document.createElement('div');
    card.className = 'uwCard';
    const W = Math.max(1e-6, r.size.w), H = Math.max(1e-6, r.size.h);
    const maxW = Math.min(760, Math.max(280, this.body.clientWidth - 56));
    const px = Math.max(0.5, Math.min(maxW / W, 420 / H));

    const cv = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.ceil(W * px * dpr);
    cv.height = Math.ceil(H * px * dpr);
    cv.style.width = Math.ceil(W * px) + 'px';
    cv.style.height = Math.ceil(H * px) + 'px';

    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);

    const X = v => (v - r.box.minX) * px;
    const Y = v => (v - r.box.minY) * px;      // SVG 的 y 向下，畫布也是，不翻
    const draw = (pts, style) => {
      ctx.beginPath();
      pts.forEach((p, i) => i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y)));
      ctx.closePath();
      ctx.setLineDash(style === 'hole' ? [4, 3] : []);
      ctx.strokeStyle = style === 'hole' ? '#c0392b' : '#111';
      ctx.lineWidth = style === 'hole' ? 1 : 1.4;
      ctx.stroke();
    };
    for (const l of r.loops) {
      draw(l.pts, 'cut');
      for (const h of l.holes) draw(h.pts, 'hole');
    }

    card.innerHTML = '<div class="uwTitle"><div class="dim">'
      + '外框實線、內孔紅色虛線。洞沒被認出來的話這裡看得到</div></div>';
    card.appendChild(cv);
    return card;
  }

  // ── 匯入 ────────────────────────────────────────────

  /**
   * 一份 SVG **匯成一個物件**，不是一個形狀一個物件。
   *
   * 理由是它們的相對位置有意義（那是你在 Illustrator 裡排好的版面）。
   * 拆成多個物件的話，位置雖然還在，但一移動就散了。
   * 要拆開的人可以用現成的「打散」，合起來的人卻沒辦法把散掉的排回去。
   */
  _import() {
    const r = this.result;
    if (!r || !r.ok) return;

    const src = {
      type: 'extrude',
      h: this.opt.h,
      from: this.fileName || 'SVG',
      shapes: r.loops.map(l => ({
        out: flatPts(l.pts),
        oc: cornerIdx(l.pts),                       // 真轉角的索引，一定要一起存
        holes: l.holes.map(h => flatPts(h.pts)),
        hc: l.holes.map(h => cornerIdx(h.pts))
      }))
    };

    const obj = new ModelObject({
      name: baseName(this.fileName) || '匯入線稿',
      kind: KIND.SOLID,
      src
    });

    /**
     * 把輪廓的中心移到原點。
     * 不移的話物件會落在 SVG 畫布的座標上（可能離原點好幾公尺），
     * 匯入後畫面上「什麼都沒有」—— 東西在很遠的地方。
     */
    const b = bnds(r.loops.flatMap(l => l.pts));
    obj.pos.set(-(b.minX + b.maxX) / 2, 0, -(b.minY + b.maxY) / 2);

    try {
      obj.mesh();
      if (obj.error) throw new Error(obj.error);
    } catch (e) {
      this.body.prepend(box('uwWarn', '⚠ 擠不出來：' + (e.message || e)));
      return;
    }

    this.app.doc.objects.push(obj);
    this.app.sel.set([obj.id]);
    this.app.onEdit(`匯入線稿 ${obj.name}`);
    if (this.app.toast) {
      this.app.toast(`已匯入「${obj.name}」：${r.loops.length} 個形狀，`
        + `${f(r.size.w)} × ${f(r.size.h)} × ${f(this.opt.h)} cm`);
    }
    this.close();
  }
}

function box(cls, msg) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = msg;
  return d;
}

function bnds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX > maxX) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

const baseName = s => String(s || '').replace(/\.[^.]+$/, '');
const f = v => String(Math.round(v * 100) / 100);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };

function loadOpt() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch (e) { return {}; }
}
function save(o) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) { /* 無所謂 */ }
}
