/**
 * exportPanel.js — 3D 列印匯出視窗
 *
 * ── 這個視窗真正的價值不是「匯出」，是「先講清楚印不印得出來」──
 * 匯出 STL 本身只是把三角形寫成檔案，三十行就寫得完。
 * 值錢的是上面那張檢查表：封閉嗎、法向對嗎、幾塊、多大。
 *
 * 切片軟體遇到破面通常只會說「模型有問題」，或乾脆默默印出空殼，
 * 等你發現已經浪費了幾小時料與機時。這裡在**送出去之前**就講，
 * 而且講得出是哪裡的問題 —— 因為半邊結構本來就知道邊界在哪。
 *
 * 介面沿用展開視窗那一套（同一組 .uw* 樣式），
 * 使用者不必再學一次怎麼操作。
 */

import { triangles, dropToBed, printCheck, toSTLBinary, toSTLAscii, STL_UNITS }
  from '../out/stl.js';
import { saveBlob, saveMany, textBlob, binaryBlob, safeName, canChoosePath, TYPES }
  from '../out/save.js';

const LS_KEY = 'modeler_export3d';

export class ExportPanel {
  /** @param {object} app { doc, sel, head } */
  constructor(app) {
    this.app = app;
    this.opt = {
      unit: 'mm', format: 'binary', group: 'one', askPath: true, ...loadOpt()
    };
    this.items = [];
    this._build();
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'exportWin';
    el.className = 'uwWin';
    el.hidden = true;
    el.innerHTML = `
      <div class="uwBack"></div>
      <div class="uwBox">
        <div class="uwHead">
          <b>3D 列印匯出</b>
          <span class="uwSum" id="exSum"></span>
          <button class="mini" id="exClose">關閉</button>
        </div>
        <div class="uwBar">
          <span class="lbl">單位</span><select id="exUnit"></select>
          <span class="lbl">格式</span><select id="exFmt">
            <option value="binary">二進位（檔案小，建議）</option>
            <option value="ascii">ASCII（看得懂，除錯用）</option>
          </select>
          <span class="lbl">多個物件</span><select id="exGroup">
            <option value="one">合成一個檔，保持相對位置</option>
            <option value="each">每個物件一個檔</option>
          </select>
          <label class="uwCk"><input type="checkbox" id="exAsk"> 指定存放位置</label>
          <span class="sp"></span>
          <button id="exGo">匯出 STL</button>
        </div>
        <div class="uwBody" id="exBody"></div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;

    const $ = id => el.querySelector('#' + id);
    this.body = $('exBody');
    this.sum = $('exSum');

    const unit = $('exUnit');
    for (const k of Object.keys(STL_UNITS)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = STL_UNITS[k].label;
      unit.appendChild(o);
    }
    unit.value = this.opt.unit;
    unit.title = 'STL 檔案本身沒有單位欄位，切片軟體一律當 mm 讀。'
      + '選 cm 的話模型會小十倍，除非對方明確要 cm，否則請用 mm';
    unit.onchange = () => { this.opt.unit = unit.value; this.run(); };

    const fmt = $('exFmt');
    fmt.value = this.opt.format;
    fmt.onchange = () => { this.opt.format = fmt.value; saveOpt(this.opt); };

    const grp = $('exGroup');
    grp.value = this.opt.group;
    grp.onchange = () => { this.opt.group = grp.value; saveOpt(this.opt); };

    this.askIn = $('exAsk');
    this.askIn.checked = !!this.opt.askPath;
    this.askIn.parentElement.title = canChoosePath()
      ? '存檔時跳「另存新檔」讓你選資料夾'
      : '這個開啟方式不支援（瀏覽器只在 https 或 localhost 開放此功能），'
        + '會自動退回一般下載';
    if (!canChoosePath()) this.askIn.parentElement.classList.add('off');
    this.askIn.onchange = () => { this.opt.askPath = this.askIn.checked; saveOpt(this.opt); };

    $('exClose').onclick = () => this.close();
    el.querySelector('.uwBack').onclick = () => this.close();
    $('exGo').onclick = () => this._save();

    window.addEventListener('keydown', e => {
      if (!this.el.hidden && e.key === 'Escape') this.close();
    });
  }

  open() { this.el.hidden = false; this.run(); }
  close() { this.el.hidden = true; }
  get isOpen() { return !this.el.hidden; }

  // ── 準備資料 ────────────────────────────────────────

  /**
   * 每個物件算出「最終要匯出的網格」與三角形。
   *
   * **開放的曲面一定要先加厚。** 零厚度的面直接丟給切片軟體，
   * 會得到一個沒有體積的東西，切出來是空的。
   * 加厚用現成的 mesh.shell()，跟畫面上顯示厚度走同一個函式。
   *
   * ── 判斷依據是「網格開不開放」，不是物件的 kind ──────
   * 2026-08-22 從 `kind === SHEET` 改過來。`kind` 是使用者在下拉選單裡
   * 隨手可改的標籤，封閉與否才是幾何事實 —— 跟「板件不該做布林聯集」
   * （踩過的坑第 8 條）是同一條原則。
   *
   * 用標籤判斷實際會出錯：把封閉的方塊標成板件（在「實體不能展開」
   * 那道門還在的時候，這是繞過去的唯一辦法），加厚會得到
   * **兩個互不相連的盒子**（內外各一個，實測體積 2777.79 cm³），
   * 而不是一個空心盒。封閉的東西本來就有體積，不必也不該加厚。
   */
  run() {
    saveOpt(this.opt);
    const picked = this.app.sel.objects;
    const objs = picked.length ? picked : this.app.doc.objects;
    const s = STL_UNITS[this.opt.unit].scale;

    this.items = objs.map(o => {
      let mesh = o.mesh();
      let shelled = false;
      if (!mesh.isClosed() && o.thickness > 0) {
        try { mesh = mesh.shell(o.thickness); shelled = true; }
        catch (e) { /* 加厚失敗就照原樣，檢查表會報「不封閉」 */ }
      }
      const tris = dropToBed(triangles(mesh, { matrix: o.matrix(), scale: s }));
      return { obj: o, mesh, tris, shelled, check: printCheck(mesh, tris) };
    });

    this._render();
  }

  _render() {
    this.body.innerHTML = '';
    const n = this.items.length;
    const tri = this.items.reduce((a, i) => a + i.tris.length, 0);
    const bad = this.items.filter(i => !i.check.ok).length;

    this.sum.textContent = n
      ? `${n} 個物件　${tri.toLocaleString()} 個三角形　`
        + (bad ? `⚠ ${bad} 個印不出來` : '全部可以列印')
      : '沒有可以匯出的物件';

    if (!n) {
      this.body.appendChild(box('uwSkip', '目前文件裡沒有物件。'
        + '先加一個基本體，或選取要匯出的物件再開這個視窗。'));
      return;
    }

    // 單位選錯是最容易發生又最難發現的錯，所以常駐提醒
    if (this.opt.unit !== 'mm') {
      this.body.appendChild(box('uwWarn',
        '⚠ 目前輸出單位是 cm。STL 檔案沒有單位欄位，'
        + '切片軟體一律當 mm 讀 —— 這個檔丟進去模型會變成十分之一大。'
        + '除非對方明確要 cm，否則請改回 mm。'));
    }

    for (const it of this.items) this.body.appendChild(this._card(it));

    this.body.appendChild(box('uwSkip',
      '匯出時會自動做三件事：公分換算成所選單位、'
      + '把 Y 軸向上轉成列印用的 Z 軸向上、整組落到平台 Z=0。'
      + '開放的面（平板、折板）會依板厚自動加厚，否則印出來是空的；'
      + '封閉的實體本來就有體積，不會也不該加厚。'));
  }

  _card(it) {
    const c = it.check;
    const u = STL_UNITS[this.opt.unit].label;
    const card = document.createElement('div');
    card.className = 'uwCard';

    const f = v => (Math.round(v * 100) / 100).toLocaleString();
    const rows = [
      ['外框', `${f(c.size.x)} × ${f(c.size.y)} × ${f(c.size.z)} ${u}`],
      ['體積', `${f(c.volume)} ${u}³`],
      ['三角形', c.triangles.toLocaleString()],
      ['封閉', c.closed ? '是' : '否'],
      ['獨立塊', c.components],
      ['尤拉數 χ', c.euler]
    ];

    card.innerHTML =
      `<div class="uwTitle">
         <div class="nm">${esc(it.obj.name)}
           <span class="exTag ${c.ok ? 'good' : 'bad'}">${c.ok ? '可以列印' : '印不出來'}</span>
         </div>
         ${it.shelled ? '<div class="dim">開放的面，已依板厚 '
            + f(it.obj.thickness) + ' cm 自動加厚</div>' : ''}
       </div>
       <table class="exTab">${rows.map(r =>
         `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table>`;

    for (const i of c.issues) {
      card.appendChild(box(i.level === 'bad' ? 'uwWarn' : 'uwSkip',
        (i.level === 'bad' ? '✗ ' : '⚠ ') + i.text));
    }
    return card;
  }

  // ── 匯出 ────────────────────────────────────────────

  /**
   * 內容一律同步準備好，才去 await 存檔 ——
   * showSaveFilePicker() 要在使用者手勢還有效時呼叫（見 out/save.js）。
   */
  async _save() {
    if (!this.items.length) return;

    const bin = this.opt.format === 'binary';
    const u = STL_UNITS[this.opt.unit].label;
    const head = `modeler unit=${u} ${new Date().toISOString().slice(0, 10)}`;
    const mk = (tris, name) => bin
      ? binaryBlob(toSTLBinary(tris, { header: head }), 'model/stl')
      : textBlob(toSTLAscii(tris, { name }), 'model/stl');

    if (this.opt.group === 'one' || this.items.length === 1) {
      // 合成一個檔：各物件的三角形直接接在一起（它們已經帶著世界座標），
      // 再整組落到平台上，相對位置因此完全保留
      const all = [];
      for (const it of this.items) for (const t of it.tris) all.push(t);
      dropToBed(all);
      await saveBlob(mk(all, this._base()), `${this._base()}_${u}.stl`,
        TYPES.stl, this.opt.askPath);
      return;
    }

    const jobs = this.items.map((it, i) => ({
      name: `${this._base()}_${String(i + 1).padStart(2, '0')}_`
          + `${safeName(it.obj.name, '物件')}_${u}.stl`,
      blob: mk(it.tris, it.obj.name)
    }));
    const n = await saveMany(jobs, this.opt.askPath);
    if (n > 1) this.sum.textContent = `已存 ${n} 個 STL。　` + this.sum.textContent;
  }

  _base() {
    const head = this.app.head || {};
    return safeName(`模型_${head.name || '未命名'}`, '模型');
  }
}

// ═══════════════════════════════════════════════════════

function box(cls, msg) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = msg;
  return d;
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function loadOpt() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch (e) { return {}; }
}
function saveOpt(o) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) { /* 無所謂 */ }
}
