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

import * as THREE from 'three';
import { triangles, bedLayout, printCheck, toSTLBinary, toSTLAscii, STL_UNITS }
  from '../out/stl.js';
import { DEFAULT_MIN_WALL_MM, DEFAULT_OVERHANG_DEG } from '../out/printShape.js';
import { to3MF } from '../out/threemf.js';
import { saveBlob, saveMany, textBlob, binaryBlob, safeName, canChoosePath, TYPES }
  from '../out/save.js';
import { boundaryEdges, nonManifoldEdges, reversedFaceEdges } from '../core/selectops.js';
import { fillHoles, holeInfo } from '../core/edit.js';
import { today } from '../core/io.js';
import { BED_MM, MARGIN_MM } from '../out/bedCut.js';

/**
 * 🔴 **洞小於表面的幾 % 算「小洞」⇒ 預設建議補洞；大於 ⇒ 預設建議加厚成殼**（2026-10-22，kang「實體有洞時照你的建議：
 * 列印視窗先問『補洞』還是『加厚成殼』，預設照洞的大小建議一個」）。
 * 量過的【已查證 · 沙箱】：頭盔前片、左片 0.00%、盒子誤刪一小格 0.32% ⇒ 該補；杯子、沒蓋的盒子 20～30%、碗、燈罩 50～66% ⇒ 該加厚；
 * 帽殼刪底一小圈 8.4% 看用途。⚠ 頭盔右片缺了整個底面 40% 卻該補 —— 大小猜不準的那一種，所以兩顆都給、提示講明。
 */
export const SMALL_HOLE_RATIO = 0.02;

const LS_KEY = 'modeler_export3d';

export class ExportPanel {
  /** @param {object} app { doc, sel, head } */
  constructor(app) {
    this.app = app;
    this.opt = {
      unit: 'mm', format: 'binary', group: 'one', askPath: true,
      minWallMM: DEFAULT_MIN_WALL_MM, overhangDeg: DEFAULT_OVERHANG_DEG,     // 第二輪第四批：跟人走（換噴嘴、換機器才改）
      bedMM: [...BED_MM], marginMM: MARGIN_MM,                                 // 第九批 9a：平台寬深高、留邊（跟人走）
      ...loadOpt()
    };
    this.cutPage = null;      // 第九批 9a：第一次按「切成放得下的塊」才載入（它帶 3D 小畫面，node 的測試載不到）
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
            <option value="3mf">3MF（檔案裡寫了單位、多個物件各有名字）</option>
          </select>
          <span class="lbl">多個物件</span><select id="exGroup">
            <option value="one">合成一個檔，保持相對位置</option>
            <option value="each">每個物件一個檔</option>
          </select>
          <label class="uwCk"><input type="checkbox" id="exAsk"> 指定存放位置</label>
          <span class="sp"></span>
          <button id="exGo">匯出 STL</button>
        </div>
        <div class="uwBar">
          <span class="lbl">最薄的牆 mm</span>
          <input type="number" id="exWall" step="0.1" min="0" style="width:60px">
          <span class="lbl">懸空角度 °</span>
          <input type="number" id="exOver" step="5" min="0" max="89" style="width:60px">
          <span class="lbl">平台 寬</span><input type="number" id="exBedW" step="1" min="10" style="width:60px">
          <span class="lbl">深</span><input type="number" id="exBedD" step="1" min="10" style="width:60px">
          <span class="lbl">高</span><input type="number" id="exBedH" step="1" min="10" style="width:60px"><span class="lbl">mm</span>
          <span class="lbl">切塊留邊</span><input type="number" id="exMargin" step="1" min="0" style="width:48px"><span class="lbl">mm</span>
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
    /** 第二輪第四批：多一個 3MF（kang「3MF 多一個格式、預設照舊 STL」）；按鈕跟著寫是哪一種 */
    this.goBtn = $('exGo');
    const label = () => { this.goBtn.textContent = this.opt.format === '3mf' ? '匯出 3MF' : '匯出 STL'; };
    label();
    /** 第九批 9b：切塊頁開著時改格式⛔ 重畫（不然切塊頁被換掉、卻還開著）—— 存試片照新的格式存；回到檢查表時才重畫 */
    fmt.onchange = () => { this.opt.format = fmt.value; label(); saveOpt(this.opt); if (!(this.cutPage && this.cutPage.active)) this._render(); };

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

    /**
     * 🔴 **兩個數字可以改、跟人走**（2026-10-24，第二輪第四批；kang「牆太薄預設 0.9 mm 可以改…懸空預設 45° 可以改」）。
     */
    const wall = $('exWall');
    wall.value = this.opt.minWallMM;
    wall.title = `比這個薄的地方黃色提醒。預設 ${DEFAULT_MIN_WALL_MM} mm ＝ 0.4 噴嘴印兩圈；0.6 噴嘴約 1.2、樹脂機約 0.4`;
    wall.onchange = () => { this.opt.minWallMM = Math.max(0, num(wall.value, DEFAULT_MIN_WALL_MM)); this.run(); };
    const over = $('exOver');
    over.value = this.opt.overhangDeg;
    over.title = `朝下、離垂直超過這個角度的面算懸空（藍色說明，切片軟體會加支撐）。預設 ${DEFAULT_OVERHANG_DEG}°；散熱好的機器可以到 60°`;
    over.onchange = () => { this.opt.overhangDeg = Math.min(89, Math.max(0, num(over.value, DEFAULT_OVERHANG_DEG))); this.run(); };
    /**
     * 🔴 **平台寬、深、高、切塊留邊：可以改、跟人走**（2026-10-25，第二輪第九批 9a；kang「同意你的建議」③ —— 以前寫死 250）。
     * 放不放得下照這三個（先試轉方向）；切塊時每一段不超過平台減留邊。
     */
    ['exBedW', 'exBedD', 'exBedH'].forEach((id, k) => {
      const inp = $(id);
      inp.value = this.opt.bedMM[k];
      inp.title = `列印機能印的${['寬', '深', '高'][k]}（mm）。預設 ${BED_MM[k]}；看你的機器規格（例如 220、256、300）`;
      inp.onchange = () => { const v = num(inp.value, BED_MM[k]); this.opt.bedMM[k] = v >= 10 ? v : BED_MM[k]; inp.value = this.opt.bedMM[k]; this.run(); };
    });
    const mg = $('exMargin');
    mg.value = this.opt.marginMM;
    mg.title = `切成放得下的塊時，每一塊比平台再小多少（mm）。預設 ${MARGIN_MM}`;
    mg.onchange = () => { this.opt.marginMM = Math.max(0, num(mg.value, MARGIN_MM)); mg.value = this.opt.marginMM; this.run(); };

    $('exClose').onclick = () => this.close();
    el.querySelector('.uwBack').onclick = () => this.close();
    $('exGo').onclick = () => this._save();

    window.addEventListener('keydown', e => {
      // ⚠ 關掉之後⛔ 不再往下傳 —— 不然主畫面的 Esc 會接著清掉選取（2026-10-08 E2）
      if (!this.el.hidden && e.key === 'Escape') { e.stopImmediatePropagation(); this.close(); }
    });
  }

  /**
   * ⚠ **開視窗時清掉上一次標的紅線** —— 使用者回來重新檢查了，
   * 舊的標記還留著只會分不清哪次是哪次。
   * 〔另一條清除路徑在 `scene.js` 的 `markGeomDirty()`：幾何一變就清〕
   */
  open() { this.app.view.clearIssuePreview(); this.fix = new Map(); this.el.hidden = false; this.run(); }
  close() { if (this.cutPage) this.cutPage.close(); this.el.hidden = true; }
  /** 第九批 9a：「切成放得下的塊」那一頁（第一次用到才載入）*/
  async _openCut(it) {
    if (!this.cutPage) {
      try { const { BedCutPage } = await import('./bedCutPage.js'); this.cutPage = new BedCutPage(this); }
      catch (e) { this.app.toast('切塊那一頁載入不了：' + e.message, true); return; }
    }
    this.cutPage.open(it);
  }
  /** 給「切成放得下的塊」那一頁存設定 */
  saveOpt() { saveOpt(this.opt); }
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
  /**
   * 🔴 **先講「正在檢查」、下一輪才算**（2026-10-24，第二輪 ⑤-1；跟剖面分切同一招 → `slicePanel.js` `run()`）。
   * 以前按「3D 列印」汽車（54 萬面）畫面停住 14 秒、什麼字都沒有。⚠ 算的時候畫面照樣停住，只是先講。
   */
  run() {
    clearTimeout(this._runT);
    showBusy(this.body, '正在檢查模型…（大的模型要十幾秒，算的時候畫面會停住）');
    if (this.cutPage) this.cutPage.close();       // 第九批 9a：改了上面的設定 ⇒ 回到檢查表
    this._runT = setTimeout(() => this._runNow(), BUSY_MS);
  }

  _runNow() {
    saveOpt(this.opt);
    const picked = this.app.sel.objects;
    const objs = picked.length ? picked : this.app.doc.objects;
    const s = STL_UNITS[this.opt.unit].scale;

    if (!this.fix) this.fix = new Map();
    this.items = objs.map(o => {
      let mesh = o.smoothMesh();          // 第八批 8a：有平滑細分的照平滑後的（kang「⑤ 量測列印剖面看平滑後」）
      let shelled = false;
      let holes = null;                       // 實體有真的洞 ⇒ { holes, ratio, choice, suggest, filled, fillErr }
      if (!mesh.isClosed() && o.thickness > 0) {
        if (o.kind === 'sheet') {
          try { mesh = mesh.shell(o.thickness); shelled = true; }
          catch (e) { /* 加厚失敗就照原樣，檢查表會報「不封閉」 */ }
        } else {
          /**
           * 🔴 **實體：先看是哪一種「沒封口」，再決定**（2026-10-22，`實驗-綜合評估-第二輪.md` ①-1、②-1）。
           * ⚠ 以前一律先加厚再檢查 ⇒ 沒有破洞的汽車（三面共用的邊）、只有幾個小洞的頭盔都被做成兩層殼；
           * 面翻過來的頭盔左片被加厚之後，檢查表講成「357 條三面共用」「半邊沒有 next」，⛔ 叫人按「修法向」。
           * 現在：面翻過來 ⇒ 不動，檢查表照實講、叫人按「修法向」；沒有真的洞（只是三面共用）⇒ 不動；
           * 有真的洞 ⇒ 照洞的大小預設「補洞」或「加厚成殼」，卡片上兩顆都給，按一下換（只影響這次匯出，模型本身不改）。
           * ⛔ 改板件：板件本來就是一張面，照舊依板厚加厚。
           */
          const flipped = reversedFaceEdges(mesh).edges > 0;
          const info = flipped ? null : holeInfo(mesh);
          if (info && info.holes) {
            const suggest = info.ratio < SMALL_HOLE_RATIO ? 'fill' : 'shell';
            const choice = this.fix.get(o.id) || suggest;
            holes = { holes: info.holes, ratio: info.ratio, suggest, choice, filled: 0, fillErr: '' };
            if (choice === 'fill') {
              const r = fillHoles(mesh);
              if (r.ok) { mesh = r.mesh; holes.filled = r.holes; }
              else holes.fillErr = r.reason;
            } else {
              try { mesh = mesh.shell(o.thickness); shelled = true; }
              catch (e) { /* 加厚失敗就照原樣，檢查表會報「不封閉」 */ }
            }
          }
        }
      }
      /**
       * ⚠ **這裡⛔ 不落平台** —— 存檔時才由 `bedLayout()` 決定怎麼落
       * （合成一個檔要整組一起落，才保得住疊在一起的相對高度）。
       * 列印前檢查只看形狀與體積，跟高度無關。
       */
      const tris = triangles(mesh, { matrix: o.matrix(), scale: s });
      return { obj: o, mesh, tris, shelled, holes, scale: s,
        check: printCheck(mesh, tris, { mmPerUnit: 10 / s, minWallMM: this.opt.minWallMM, overhangDeg: this.opt.overhangDeg, bedMM: this.opt.bedMM }) };
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

    // 單位選錯是最容易發生又最難發現的錯，所以常駐提醒（3MF 檔案裡寫了單位 ⇒ ⛔ 這個問題）
    if (this.opt.unit !== 'mm' && this.opt.format !== '3mf') {
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
      + '封閉的實體本來就有體積，不會也不該加厚；'
      + '實體有洞時照洞的大小先建議「補洞」或「加厚成殼」，卡片上可以換（只影響這次匯出）。'));
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
         ${it.shelled && it.obj.kind === 'sheet'
            ? '<div class="dim">開放的面，已依板厚 ' + f(it.obj.thickness) + ' cm 自動加厚</div>' : ''}
         ${it.holes ? this._holeNote(it, f) : ''}
       </div>
       <table class="exTab">${rows.map(r =>
         `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table>`;

    /**
     * 🔴 **紅字叫人「把洞補起來」，就要指得出洞在哪**（綜合評估 ②-12，2026-10-19）。
     * 實體沒封口會先被加厚 ⇒ 加厚後是封閉的 ⇒ 下面那則「不是封閉的」不會出現 ⇒
     * 原本的「指出來」**永遠走不到**。⇒ 紅字後面也放一顆，按下去一樣畫紅線。
     * ⛔ 不改自動加厚本身（kang 同意只加按鈕）。
     */
    const openNote = card.querySelector('.uwOpenSolid');
    if (openNote) {
      /** 補洞 ⇄ 加厚成殼：按一下換、重算這張卡（2026-10-22，kang「列印視窗先問」）*/
      const other = it.holes.choice === 'fill' ? 'shell' : 'fill';
      const sw = document.createElement('button');
      sw.className = 'mini';
      sw.textContent = other === 'fill' ? '改成補洞' : '改成加厚成殼';
      sw.title = other === 'fill'
        ? '這次匯出先把洞補起來再印（模型本身不改；要永久補起來按工具列「補洞」）'
        : '這次匯出照板厚加厚成一層殼（像碗、燈罩那種故意開口的）';
      sw.onclick = () => { this.fix.set(it.obj.id, other); this.run(); };
      openNote.appendChild(document.createTextNode(' '));
      openNote.appendChild(sw);
      openNote.appendChild(document.createTextNode(' '));
      openNote.appendChild(this._pointBtn(
        '把沒封口的地方在畫面上標成紅線，並關掉這個視窗',
        () => this._showHoles(it.obj)));
    }

    for (const i of c.issues) {
      /** 第二輪第四批：'caution' ＝ 黃色提醒（牆太薄、面互相穿過去），跟紅色「印不出來」、藍色說明分開 */
      const b = box(i.level === 'bad' ? 'uwWarn' : i.level === 'caution' ? 'uwCaution' : 'uwSkip',
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
      /** 形狀三項的「指出來」：把那些三角形的邊框畫在畫面上（顏色各一種，`scene.js` `setFacePreview()`）*/
      if (FACE_KINDS[i.kind] && c.shape) {
        const k = FACE_KINDS[i.kind];
        b.appendChild(document.createTextNode(' '));
        b.appendChild(this._pointBtn(`把${k.what}的地方在畫面上用${k.colorName}框起來，並關掉這個視窗`,
          () => this._showFaces(it, i.kind)));
      }
      /** 第九批 9a：放不下平台、轉方向也不行 ⇒ 切成放得下的塊（封閉、方向對的才切得了）*/
      if (i.kind === 'toobig') {
        const btn = document.createElement('button');
        btn.className = 'mini';
        btn.textContent = '切成放得下的塊';
        btn.title = '照平台大小切開、接面加定位銷；先看拉開的圖和數字，按「切開」才會改模型';
        if (!c.ok) { btn.disabled = true; btn.title = '先把上面紅色的問題修好（封閉、方向對的實體才切得了）'; }
        btn.onclick = () => this._openCut(it);
        b.appendChild(document.createTextNode(' '));
        b.appendChild(btn);
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

  /**
   * 實體有真的洞時那一句（2026-10-22）：有幾個洞、佔表面多少、這次怎麼處理、哪一個是建議的。
   * ⚠ 大小猜不準的那一種（缺了整個底面的實心零件，洞很大卻該補）要講出來，讓人知道可以換。
   */
  _holeNote(it, f) {
    const h = it.holes;
    const pct = h.ratio * 100 < 0.01 ? '不到 0.01' : (Math.round(h.ratio * 1000) / 10).toLocaleString();
    const head = `⚠ 這個實體有 ${h.holes} 個洞（佔表面 ${pct}%）—— `;
    const tag = c => (h.suggest === c ? '（照洞的大小建議的）' : '（你選的）');
    let body;
    if (h.choice === 'fill') {
      body = h.fillErr
        ? `補洞沒有成功：${esc(h.fillErr)}；這次照原樣、沒有加厚`
        : `這次匯出先把 ${h.filled} 個洞補起來再印${tag('fill')}。模型本身沒有改，要永久補起來按工具列「補洞」`;
    } else {
      body = `這次匯出照板厚 ${f(it.obj.thickness)} cm 加厚成一層殼${tag('shell')}，像碗、燈罩那種故意開口的；`
        + '板厚在右邊物件面板改。如果它是缺了一面的實心零件，請改成補洞';
    }
    return `<div class="bad uwOpenSolid">${head}${body}</div>`;
  }

  /**
   * 🔴 **形狀三項指出來**（2026-10-24，第二輪第四批）：檢查表量的是匯出的三角形（mm、Z 朝上），
   * ⇒ 換回世界座標（`triangles()` 的 Y 朝上 → Z 朝上反過來、除掉單位）再畫。
   * ⚠ 板件量的是加厚之後的殼 ⇒ 框的是殼的面（畫面上看到的也是加厚的樣子）。
   */
  _showFaces(it, kind) {
    const k = FACE_KINDS[kind], ids = it.check.shape[k.key].tris, s = it.scale;
    const W = p => new THREE.Vector3(p.x / s, p.z / s, -p.y / s);
    const pts = [];
    for (const i of ids) {
      const t = it.tris[i], a = W(t.a), b = W(t.b), c = W(t.c);
      pts.push(a, b, b, c, c, a);
    }
    this.close();                       // ⚠ 先關視窗再畫（同 `_showHoles()`）
    this.app.view.setFacePreview(pts, k.color);
    this.app.toast(`已用${k.colorName}框出 ${ids.length.toLocaleString()} 個${k.what}的三角形`
      + (kind === 'thin' && it.check.shape.thin.sampled ? '（面太多，只框抽到的那些）' : ''));
  }

  /** 三顆「指出來」共用的按鈕。⚠ `mini` 是這組面板既有的樣式，⛔ 不要發明新的 */
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
    const mesh = obj.smoothMesh();      // 第八批 8a：跟檢查表同一份（平滑後的）
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
    const mesh = obj.smoothMesh();      // 第八批 8a：跟檢查表同一份（平滑後的）
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
    /** ⑤-25（2026-10-20）：檔頭日期用本地的今天（以前 `toISOString()` 是世界時間，早上 8 點前會寫成昨天）*/
    const head = `modeler unit=${u} ${today()}`;
    const mk = (tris, name, fallback) => bin
      ? binaryBlob(toSTLBinary(tris, { header: head }), 'model/stl')
      : textBlob(toSTLAscii(tris, { name, fallback }), 'model/stl');

    const together = this.opt.group === 'one' || this.items.length === 1;

    /**
     * 🔴 **3MF**（2026-10-24，第二輪第四批）：合成一個檔 ⇒ 一個檔裡每個物件各一個、各有名字，整組一起落（相對位置照舊）；
     * 每個物件一個檔 ⇒ 跟 STL 一樣各自移到平台中間。單位寫在檔案裡。
     */
    if (this.opt.format === '3mf') {
      const unitKey = this.opt.unit;
      const mk3 = parts => binaryBlob(to3MF(parts, { unit: unitKey }), 'model/3mf');
      if (together) {
        let zMin = Infinity;
        for (const it of this.items) for (const t of it.tris) zMin = Math.min(zMin, t.a.z, t.b.z, t.c.z);
        const parts = this.items.map(it => ({ name: it.obj.name,
          tris: it.tris.map(t => ({ a: shiftZ(t.a, zMin), b: shiftZ(t.b, zMin), c: shiftZ(t.c, zMin) })) }));
        await saveBlob(mk3(parts), `${this._base()}_${u}.3mf`, TYPES['3mf'], this.opt.askPath);
        return;
      }
      const laid3 = bedLayout(this.items.map(it => it.tris), false);
      const jobs3 = this.items.map((it, i) => ({
        name: `${this._base()}_${String(i + 1).padStart(2, '0')}_${safeName(it.obj.name, '物件')}_${u}.3mf`,
        blob: mk3([{ name: it.obj.name, tris: laid3[i] }])
      }));
      const n3 = await saveMany(jobs3, this.opt.askPath);
      if (n3 > 1) this.sum.textContent = `已存 ${n3} 個 3MF。　` + this.sum.textContent;
      return;
    }

    // 各物件的三角形帶著世界座標；合成一個檔時整組一起落，相對位置因此完全保留
    const laid = bedLayout(this.items.map(it => it.tris), together);

    if (together) {
      await saveBlob(mk(laid[0], this._base(), 'model'), `${this._base()}_${u}.stl`,
        TYPES.stl, this.opt.askPath);
      return;
    }

    const jobs = this.items.map((it, i) => ({
      name: `${this._base()}_${String(i + 1).padStart(2, '0')}_`
          + `${safeName(it.obj.name, '物件')}_${u}.stl`,
      blob: mk(laid[i], it.obj.name, `part${String(i + 1).padStart(2, '0')}`)
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

/** 形狀三項：「指出來」的顏色（⛔ 跟紅＝破洞、紫＝黏在一起、橘＝你指定的、青＝程式算的 重複）*/
const FACE_KINDS = {
  thin: { key: 'thin', what: '太薄', color: 0xffd400, colorName: '黃框' },
  cross: { key: 'cross', what: '面互相穿過去', color: 0xff5fd2, colorName: '粉紅框' },
  overhang: { key: 'overhang', what: '懸空', color: 0x3fa9ff, colorName: '藍框' }
};

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

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v, dflt) => { const x = parseFloat(v); return Number.isFinite(x) ? x : dflt; };
const shiftZ = (p, dz) => new THREE.Vector3(p.x, p.y, p.z - dz);

function loadOpt() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch (e) { return {}; }
}
function saveOpt(o) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) { /* 無所謂 */ }
}
