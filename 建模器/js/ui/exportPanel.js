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
import { boundaryEdges, nonManifoldEdges } from '../core/selectops.js';

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

  /**
   * ⚠ **開視窗時清掉上一次標的紅線** —— 使用者回來重新檢查了，
   * 舊的標記還留著只會分不清哪次是哪次。
   * 〔另一條清除路徑在 `scene.js` 的 `markGeomDirty()`：幾何一變就清〕
   */
  open() { this.app.view.clearIssuePreview(); this.el.hidden = false; this.run(); }
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
      const b = box(i.level === 'bad' ? 'uwWarn' : 'uwSkip',
        (i.level === 'bad' ? '✗ ' : '⚠ ') + i.text);

      /**
       * 🔴 **「不是封閉的」那一則要給得出出路。**
       *
       * ⚠ **這是這個檔案自己的檔頭承諾的事，而它一直沒做到** ——
       * 檔頭寫著「講得出是哪裡的問題，因為半邊結構本來就知道邊界在哪」，
       * **但這則訊息只給了「有 N 條邊界邊」這個數字。**
       * 使用者只能自己在幾百條線裡找。〔坑第 11 條：講了問題卻沒有出路〕
       *
       * → 加一顆「指出來」，按下去把破洞畫在 3D 畫面上（紅線）。
       */
      /**
       * 🔴 **兩則都給得出出路，靠 `kind` 認，⛔ 不再比對訊息的文字。**
       *
       * ⚠ **原本這裡寫的是 `/封閉/.test(i.text)`** —— 那是把按鈕綁在
       * 一句會被改寫的中文上，訊息文字一改按鈕就無聲消失
       * （坑第 21 條：按下去畫面上什麼都不會變的近親，這個更糟：**按鈕自己不見**）。
       * 現在 `printCheck()` 會標 `kind`，⛔ 新增訊息時記得一起標。
       */
      if (i.kind === 'open' && !c.closed) {
        b.appendChild(document.createTextNode(' '));
        b.appendChild(this._pointBtn(
          '把破掉的地方在畫面上標成紅線，並關掉這個視窗',
          () => this._showHoles(it.obj)));
      }
      if (i.kind === 'nonmanifold') {
        b.appendChild(document.createTextNode(' '));
        b.appendChild(this._pointBtn(
          '把黏在一起的邊在畫面上標成紫線，並關掉這個視窗',
          () => this._showNonManifold(it.obj)));
      }
      card.appendChild(b);
    }
    return card;
  }

  /** 兩顆「指出來」共用的按鈕。⚠ `mini` 是這組面板既有的樣式，⛔ 不要發明新的 */
  _pointBtn(title, onclick) {
    const btn = document.createElement('button');
    btn.className = 'mini';
    btn.textContent = '指出來';
    btn.title = title;
    btn.onclick = onclick;
    return btn;
  }

  /**
   * 🔴 **把這個物件的非流形邊畫在 3D 畫面上（紫線）。**
   *
   * ⚠ **⛔ 不要照抄 `_showHoles` 的 toast 講「用補洞可以補起來」** ——
   * **`補洞` 補不了非流形**（它補的是缺面，這裡是多面）。
   * 指一條不存在的退路正是坑第 34 條。
   *
   * ⚠ **一樣從 `obj.mesh()` 重算，⛔ 不用檢查表那份**（板件會被 `shell()`
   * 換成另一個網格，那上面的邊在畫面上不存在）。
   */
  _showNonManifold(obj) {
    const mesh = obj.mesh();
    const r = nonManifoldEdges(mesh);
    if (!r.hes.length) {
      this.app.toast('這個物件本身沒有非流形的邊 —— '
        + '報告裡那一則是加厚之後的網格才有的', true);
      return;
    }

    const m4 = obj.matrix();
    const pts = [];
    for (const he of r.hes) {
      pts.push(he.v.p.clone().applyMatrix4(m4), he.to.p.clone().applyMatrix4(m4));
    }
    /** ⚠ 順序不能反：先關視窗再畫線（關的路上有人會 `markGeomDirty()`） */
    this.close();
    this.app.view.setNonManifoldPreview(pts);

    this.app.toast(
      `已用紫線標出 ${r.edges} 條黏在一起的邊（涉及 ${r.faces} 個面，`
      + `最嚴重那條被 ${r.worst} 個面共用）　`
      + '這種要自己刪掉多餘的面，「補洞」補不了');
  }

  /**
   * 🔴 **把這個物件的破洞畫在 3D 畫面上。**
   *
   * ⚠ **⛔ 一律從 `obj.mesh()` 重算，⛔ 不用檢查表那份 `it.mesh`** ——
   * 板件會被 `shell()` 加厚成另一個網格，**那上面的邊在畫面上不存在**。
   * 〔坑第 30 條的同一類：判斷依據要用畫面上真的有的東西〕
   *
   * ⚠ **畫完要關掉這個視窗** —— 它有一層遮罩蓋住 3D 畫面，
   * 不關的話標了也看不到（那就等於沒標）。
   */
  _showHoles(obj) {
    const mesh = obj.mesh();
    const r = boundaryEdges(mesh);
    const view = this.app.view;

    if (!r.hes.length) {
      this.app.toast('這個物件本身沒有破洞 —— '
        + '報「不是封閉的」是因為它是一張沒有厚度的面，給它板厚就會自動加厚', true);
      return;
    }

    /** 本地 → 世界：跟刀具、切一刀的預覽同一套座標 */
    const m4 = obj.matrix();
    const pts = [];
    for (const he of r.hes) {
      pts.push(he.v.p.clone().applyMatrix4(m4), he.to.p.clone().applyMatrix4(m4));
    }
    /**
     * ⚠ **順序不能反：先關視窗，再畫線。**
     * 關視窗那條路上如果有人呼叫 `markGeomDirty()`，就會把剛畫的線清掉 ——
     * 那就變成「按了畫面上什麼都不會變」（坑第 21 條）。
     */
    this.close();
    view.setHolePreview(pts);

    /**
     * ⚠ **講「幾個洞」⛔ 不要只講「幾條邊」** —— 使用者修的是洞，
     * 而 47 條邊可能只是一個洞。〔「講數量與形狀」那條〕
     */
    this.app.toast(
      `已用紅線標出 ${r.holes} 個破洞（共 ${r.hes.length} 條邊，`
      + `最大那個洞 ${r.biggest} 條）　用「補洞」可以補起來`);
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
