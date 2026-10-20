/**
 * toolbar.js — 右側面板（物件屬性 ＋ 結構分析）
 *
 * 「結構分析」那一區是第 1 期的重點展示。
 * 半邊結構、平面區域合併、曲率判定這些東西本身是看不見的，
 * 把它們的數字攤在面板上，才驗得出來到底有沒有做對 ——
 * 也順便預告了展開引擎將來會依據什麼做判斷。
 */

import { PRIM_SPECS, defaultSrc, PRIM_TYPES, defaultBend, bendDevelopedLength,
         bendAllowance, neutralRadius, PEN_REV_DEFAULTS, penRevAutoAt, penRevolve, bendProfile, penRevAtForHeadR,
         extrudeToPenSrc }
  from '../build/prim.js';
import { KIND, canExplodeShapes, recenterOrigin, penKind, revMoveToGuide, penWallSide, radialCenterAt,
         revGuideAx, revWallAxisAt, revWallAtFor } from '../core/io.js';
import { summarize, SURFACE } from '../core/region.js';
import { BOOL_OPS, BOOL_LABEL, BOOL_SYMBOL, isBoolSrc } from '../build/bool.js';
import { ARRAY_MODES, ARRAY_LABEL, AXES, isArraySrc, withMode }
  from '../build/array.js';
import { seamCount, markableEdges, clearSeams, seamBlockReason, seamKinds,
         keepCount, clearKeeps, markSignature } from '../unfold/seam.js';
import { renderCanvas } from '../out/sheet.js';
import { previewProgram, pieceAt } from '../out/nest.js';

/** 分片的即時預覽開關（2026-10-12）—— 記在瀏覽器裡；讀不到就當開（預設開）*/
const SEAM_PREVIEW_KEY = 'modeler_seam_preview';
/**
 * 分片地圖（2026-10-21，`分片成群-設計方向.md` 第二件）：每一片一個顏色，3D 與即時預覽同一個顏色。
 * 顏色照 `樣板-分片地圖.html`（kang 點過）；片比顏色多 ⇒ 從頭再輪一次。⚠ ⛔ 用黃（選面）、紅（會疊）、紫（點到的那一片）。
 */
const SEAM_MAP_KEY = 'modeler_seam_map';
const PIECE_PAL = ['#4fc3f7', '#81c784', '#ffb74d', '#4db6ac', '#f06292', '#aed581', '#7986cb', '#ffd180', '#90a4ae', '#64b5f6', '#dce775', '#a1887f', '#80cbc4', '#ce93d8'];
function seamMapOn() {
  try { return localStorage.getItem(SEAM_MAP_KEY) !== 'off'; } catch (e) { return true; }
}
function seamPreviewOn() {
  try { return localStorage.getItem(SEAM_PREVIEW_KEY) !== 'off'; } catch (e) { return true; }
}
/** 網格物件 → 編號（Undo／改參數會換掉整個網格，換了就要重算）*/
const meshUid = new WeakMap();
let meshUidNext = 1;
/**
 * 預覽要不要重算：物件、網格本人、縮放、**哪幾條是切線**、展開方式、材料。
 * 切線用「邊 id 的雜湊 ＋ 條數」—— 走一遍邊是 O(邊數)，跟面板本來就在做的 `seamCount()` 同一級。
 */
export function seamPreviewKey(obj, st) {
  const mesh = obj.mesh();
  if (!meshUid.has(mesh)) meshUid.set(mesh, meshUidNext++);
  /** ⚠ 不准切也會改展開結果（攤平先走它）⇒ 指紋連不准切一起算（`markSignature()`，2026-10-13）*/
  const s = obj.scale || {};
  return [obj.id, meshUid.get(mesh), s.x, s.y, s.z, markSignature(mesh), st.mode, st.material].join('|');
}
const fmtPct = v => `${Math.round(v * 1000) / 10}%`;
import { elementVerts, elementCenter, nonPlanarFaces, degenerateFaces }
  from '../core/edit.js';
import { measureSelection, fmtCm, meshMeasureWorld } from '../core/measure.js';
import { clashLine } from '../core/interfere.js';
import { unfoldObject, pieceWorldPolys } from '../unfold/part.js';
import { landPositions, lowestY } from '../core/align.js';
import { alignPositions, distributePositions, spacePositions, currentGaps,
         worldBounds, AXIS_KEYS, ALIGN, ALIGN_LABEL } from '../core/align.js';
import { fetchLatest } from '../core/appver.js';
import { meshGearPair, gearClash } from '../core/gearPair.js';

const SURFACE_TEXT = {
  [SURFACE.PLANAR]: '平面',
  [SURFACE.DEVELOPABLE]: '可展開（有精確解）',
  [SURFACE.NON_DEVELOPABLE]: '不可展開（需切分近似）'
};

export class Panel {
  /**
   * @param {object} app { doc, view, sel, hist, onEdit(label), onDirty() }
   */
  constructor(app) {
    this.app = app;
    this.root = document.getElementById('panel');
    this.analysisCache = new Map();   // ModelObject.id → 分析結果
    /**
     * 布林運算樹裡哪些運算元是展開的。key 是「物件id:0.1.2」這種路徑。
     * 面板每次改動都整個重建，不記著的話一改參數就全部收合，很難用。
     */
    this.openItems = new Set();
    this._build();
  }

  _build() {
    this.root.innerHTML = `
      <section id="pObj">
        <h2>物件</h2>
        <div id="pEmpty" class="empty">還沒有選取物件<br><span>點一下畫面中的物件</span></div>
        <div id="pForm" hidden></div>
      </section>
      <section id="pAna">
        <h2>結構分析 <button id="anaRun" class="mini">重新計算</button></h2>
        <div id="anaBody" class="empty">選一個物件後按「重新計算」</div>
      </section>
      <!-- 干涉檢查（綜合評估 ④-20，2026-10-20）：跟程式版本一樣，不管有沒有選到物件都在 -->
      <section id="pClash">
        <h2>干涉檢查 <button id="clashRun" class="mini" title="查零件有沒有穿進彼此裡面：沒選東西（或只選一個）就查全部，選了兩個以上就只查選到的。板件照板厚算；只是貼在一起不算">檢查</button></h2>
        <div id="clashBody" class="empty">按「檢查」<br><span>沒選東西就查全部；選了兩個以上只查選到的</span></div>
      </section>
      <!--
        🔴🔴 程式版本（2026-08-31，kang 提的）。⛔ 這一段⛔ 不可以用反引號！
        （它住在一個 template literal 裡面 —— 見這一段底下那則註解）

        ⭐ 放這裡⛔ 不是隨便挑的：refresh() 只動 pForm／pEmpty／anaBody，
        所以這一塊【不管有沒有選到物件都會在】——
        而你要按它的時機正是「畫面剛載入、什麼都還沒選」。

        ⚠ ⛔ 不放工具列：版面是這個專案最稀缺的資源
        （頂端 bar 花了四段才從 346px 壓到 103px、左側直條只剩 27.5px），
        而這顆是【偶爾才按一次】的東西。

        ⭐ kang 拍板它是永久功能，⛔ 不是開發期的臨時品 ——
        他的理由：「也許未來使用一段時間..還會請你再優化」。
        ⇒ 所以名字與說明都用【永久的意思】：
        「確認我現在跑的，是不是最新的那一版」。
      -->
      <section id="pVer">
        <h2>程式版本 <button id="verGet" class="mini">抓最新版</button></h2>
        <div id="verBody" class="empty">按「抓最新版」<br><span>剛上傳完想馬上看新版時用</span></div>
      </section>`;

    this.form = this.root.querySelector('#pForm');
    this.empty = this.root.querySelector('#pEmpty');
    this.anaBody = this.root.querySelector('#anaBody');
    this.root.querySelector('#anaRun').onclick = () => this.analyse(true);

    this.clashBody = this.root.querySelector('#clashBody');
    this.root.querySelector('#clashRun').onclick = () => {
      if (this.app.runClash) this.app.runClash();
      this.renderClash();
    };

    this.verBody = this.root.querySelector('#verBody');
    this.root.querySelector('#verGet').onclick = () => this.fetchLatestVersion();
  }

  /**
   * 🔴🔴 **上面那一大段 HTML 住在一個 template literal（反引號字串）裡面
   * —— 所以【裡面的註解一個反引號都不可以出現】。**
   *
   * ⚠ **【實證 2026-08-31】我在那則 HTML 註解裡照平常的習慣寫了
   * `` `refresh()` `` 這種標記，字串當場被提前結束**，
   * 錯誤是 `SyntaxError: Unexpected identifier 'refresh'` ——
   * ⛔ 訊息指著 200 行以外的地方，完全看不出病因在註解裡。
   *
   * ⭐ **抓到它的是「真的解析一次」那道**（`vm.SourceTextModule`），
   * ⛔ 四道機械檢查裡的另外三道都放它過關。
   * 〔又一次：語法錯在 ES 模組裡會讓整份檔案一行都不跑〕
   */

  /**
   * 🔴 **抓最新版**：把瀏覽器的快取換成伺服器上最新的，
   * 有變就重新載入。⭐ 病因與做法的完整說明在 `core/appver.js` 的檔頭。
   *
   * ⚠ **三種結果都要講出來** —— 尤其是「連不上」：
   * 吞掉錯誤而顯示「已經是最新版」是**假的保證**，
   * 比什麼都不講更糟（鐵律三：誤報比漏報更糟）。
   */
  async fetchLatestVersion() {
    const btn = this.root.querySelector('#verGet');
    const say = (html, cls = 'empty') => {
      this.verBody.className = cls;
      this.verBody.innerHTML = html;
    };

    btn.disabled = true;
    say('抓取中…');

    let r;
    try {
      r = await fetchLatest((done, total) => say(`抓取中… ${done} / ${total}`));
    } catch (e) {
      btn.disabled = false;
      say(`🔴 出錯了<br><span>${String(e && e.message ? e.message : e)}</span>`);
      return;
    }

    if (!r.ok) {
      btn.disabled = false;
      /**
       * ⚠ **⛔ 不可以寫「已經是最新版」** —— 我們**根本沒問到**。
       * 講「⛔ 沒辦法確認」才是誠實的。
       */
      say(`🔴 沒辦法確認<br><span>${r.error}</span>`);
      return;
    }

    if (r.changed > 0) {
      /**
       * ⭐ **講一句再重載** —— 畫面突然自己重來一次，
       * ⛔ 不講的話跟「當掉了」分不出來（坑第 21 條）。
       * ⚠ **⛔ 不會弄丟東西**：每做完一步都有自動暫存。
       */
      say(`✅ 抓到新版（${r.changed} 個檔有變）<br><span>正在重新載入…</span>`);
      setTimeout(() => location.reload(), 700);
      return;
    }

    btn.disabled = false;
    /**
     * ⚠ **要把「這個判斷會漏報」講出來，⛔ 不要給假的保證。**
     * 比對用的是**檔案大小** —— 某次改動如果剛好沒改變大小，這裡會說
     * 「已經最新」而其實不是。⭐ 但**快取已經被換成新的了**，
     * 所以「再按一次或手動重整」一定拿得到新的（見 `appver.js` 檔頭）。
     */
    say(`✅ 已經是最新版${r.stamp ? `<br><span>版本 ${r.stamp}</span>` : ''}`
      + `<br><span>⚠ 比對的是檔案大小；快取已換新，重整一次一定是最新的</span>`);
  }

  // ═══════════════════════════════════════════════════
  //  物件屬性
  // ═══════════════════════════════════════════════════

  /**
   * 干涉檢查的結果清單（④-20）。一列 ＝ 一對穿到的零件，點下去 ＝ 選起那兩個、拉近入鏡（`app.clashPick()`）。
   * ⚠ 形狀改過 ⇒ 清單留著但標「形狀改過了」、⛔ 點（紅色已經收掉 —— `main.js` `clashStale()`）。
   */
  renderClash() {
    const b = this.clashBody;
    if (!b) return;
    const r = this.app.getClash ? this.app.getClash() : null;
    b.innerHTML = '';
    if (!r) {
      b.className = 'empty';
      b.innerHTML = '按「檢查」<br><span>沒選東西就查全部；選了兩個以上只查選到的</span>';
      return;
    }
    b.className = '';
    const head = document.createElement('div');
    head.className = 'note';
    head.textContent = (r.stale ? '形狀改過了 —— 再按一次「檢查」看新的結果。上一次：' : '')
      + `${r.scope === 'sel' ? '選到的' : '全部'} ${r.checked} 個物件，`
      + (r.list.length ? `${r.list.length} 對穿進去了（重疊的地方畫成紅色；點一列就選起那兩個）` : '沒有零件穿進彼此裡面')
      + (r.touching ? `；${r.touching} 對只是貼在一起（不算）` : '');
    b.appendChild(head);
    r.list.forEach((c, i) => {
      const btn = document.createElement('button');
      btn.className = 'clashItem';
      btn.textContent = clashLine(c);
      btn.disabled = !!r.stale;
      btn.onclick = () => this.app.clashPick(i);
      btn.style.cssText = 'display:block;width:100%;text-align:left;margin:4px 0;white-space:normal';
      b.appendChild(btn);
    });
    for (const s of r.skipped) {
      const d = document.createElement('div');
      d.className = 'note';
      d.textContent = `沒辦法算：「${s.name}」${s.reason}`;
      b.appendChild(d);
    }
  }

  refresh() {
    this.renderClash();
    /**
     * 分片的紅（疊在一起的面）、紫（預覽點到的那一片）先收掉 —— 還在分片模式、預覽還開著的話，
     * `_seamPreview()` 會照目前的結果馬上再標回來（快取命中是同步畫）；不在了就保持收起來（⛔ 留著舊的紅）。
     */
    if (this.app.view && this.app.view.setFaceMarks) {
      this.app.view.setFaceMarks('overlap', null);
      this.app.view.setFaceMarks('piece', null);
      this.app.view.setFaceMarks('map', null);
    }
    const obj = this.app.sel.active;
    const many = this.app.sel.count > 1;
    /**
     * 編輯模式選的是**子元素**，物件本身並沒有被選取（`sel.active` 是 null）。
     * 所以那個早退不能照走 —— 走了的話，使用者明明選了一個面，
     * 面板卻寫著「還沒有選取物件」。**畫面在否認他剛做的事。**
     */
    const editing = this.app.sel.editMode;

    if (!obj && !editing) {
      this.empty.hidden = false;
      this.empty.innerHTML = '還沒有選取物件<br><span>點一下畫面中的物件</span>';
      this.anaBody.className = 'empty';
      this.anaBody.textContent = '選一個物件後按「重新計算」';
      this._caseBox();
      return;
    }

    this.empty.hidden = true;
    this.form.hidden = false;
    this.form.innerHTML = '';
    this._target = this.form;      // 表單元件預設加到這裡；巢狀區塊會暫時換掉

    if (editing) this._editBox();

    if (!obj) {
      this.anaBody.className = 'empty';
      this.anaBody.textContent = '選一個物件後按「重新計算」';
      return;
    }

    /**
     * 🔴 **結構分析的數字要跟著目前的物件**（2026-10-19，實驗 T4：`實驗-綜合評估.md` ②-4）。
     * ⚠ 以前改了參數只清掉快取、畫面上的表格照舊留著 ⇒ 改了孔徑還一直顯示 162.9；換選另一個物件也還掛著上一個的。
     * ⭐ 有這個物件算好的 ⇒ 畫那一份；沒有 ⇒ 講「按重新計算」（⛔ 自動算：面數多時要幾百毫秒，`analyse()` 檔頭）。
     */
    const cachedAna = this.analysisCache.get(obj.id);
    if (cachedAna) {
      if (this._anaShown !== cachedAna) this._renderAnalysis(cachedAna);
    } else if (this.anaBody.textContent !== '計算中…') {
      /** 這個物件算過、後來改了 ⇒「形狀改過了」；沒算過 ⇒「按重新計算」（換物件時也要換這一句 —— 本機版按過才抓到）*/
      const msg = this._anaFor === obj.id
        ? '形狀改過了 —— 按「重新計算」看新的數字'
        : '按「重新計算」看這個物件的結構';
      if (this._anaShown || this.anaBody.textContent !== msg) {
        this.anaBody.className = 'empty';
        this.anaBody.textContent = msg;
      }
      this._anaShown = null;
    }

    // 網格生成失敗（多半是布林算不出來）先講清楚，再讓人去改參數
    if (obj.error) {
      this.form.appendChild(bad('這個物件目前算不出來：' + obj.error));
    }

    /**
     * 🔴 **多選時，種類、板厚、顏色「N 個一起改」**（綜合評估 ③-8，2026-10-19，kang 同意）。
     * 以前多選改顏色只改到最後選的那一個 —— 上面有一句「以下編輯最後選的」，但顏色在最底下、很容易沒看到（T7）。
     * ⭐ 只放這三個「每個物件都有、意思也一樣」的欄位；名稱、位置、參數照舊只改最後選的（物件種類不同，參數也不同）。
     * ⚠ 板厚只改「看得到板厚欄的那種」（板件、或沒封口的實體）—— 封口的實體用不到板厚，偷偷改它沒有意義。
     */
    const all = many ? this.app.sel.objects : [obj];
    const together = (label, n) => (n > 1 ? `${label}（${n} 個一起改）` : label);
    const thickTargets = all.filter(o => o.kind === KIND.SHEET || !meshClosed(o));
    const setThickness = v => {
      for (const o of thickTargets) {
        o.thickness = v;
        o.invalidate();
        this.analysisCache.delete(o.id);
      }
      this._edit(thickTargets.length > 1 ? `改板厚（${thickTargets.length} 個）` : '改板厚');
    };

    if (many) {
      this.form.appendChild(note(`已選 ${this.app.sel.count} 個：種類、板厚、顏色是 ${this.app.sel.count} 個一起改；`
        + `其他欄位只改最後選的「${obj.name}」`));
      this._gearPairBox();
      this._alignBox();
    }

    this._rowText('名稱', obj.name, v => { obj.name = v; this._edit('改名稱'); });

    this._rowSelect(together('種類', all.length), obj.kind, [
      [KIND.SOLID, '實體 solid'],
      [KIND.SHEET, '板件 sheet']
    ], v => {
      for (const o of all) o.kind = v;
      this._edit(all.length > 1 ? `改種類（${all.length} 個）` : '改種類');
    }, '板件是要拿去展開的東西（有厚度、可折彎）；實體是有體積的量體');

    if (obj.kind === KIND.SHEET) {
      // 板厚會改變折彎的中性層位置，也就會改變形狀與展開長度，
      // 所以一定要 invalidate() 讓網格重生，不能只改數字。
      this._rowNum(together('板厚 cm', thickTargets.length), obj.thickness, { min: 0.01, step: 0.1 }, setThickness,
        '折彎補償與展開長度都要用它算：中性層半徑 ＝ 內側R ＋ K×板厚');
    } else if (!meshClosed(obj)) {
      /**
       * 🔴 **沒封口的實體也看得到板厚**（2026-10-19，`實驗-綜合評估.md` ①-9，kang「先做 ①-9（照這個建議）」）。
       * ⚠ 畫面與 3D 列印判的是「網格封不封閉」（⛔ 看種類），沒封口就照板厚加厚成殼 ——
       * 以前實體的板厚欄藏起來，刪過面的方塊就被看不見的 0.2 加厚，改都改不了（補測：36,008 mm³「可以列印」）。
       */
      this._rowNum(together('板厚 cm', thickTargets.length), obj.thickness, { min: 0.01, step: 0.1 }, setThickness,
        '這個實體沒有封口（例如刪過面）：畫面與 3D 列印都照這個厚度加厚成一層殼。要實心的話請把洞補起來');
    }

    // ── 分片（只有分片模式開著才顯示）──
    if (this.app.sel.seamMode) this._seamBox(obj);

    // ── 參數（可回頭改的才有）──
    if (obj.isBool) {
      this._boolSection(obj);
      this._freezeBtn(obj, '運算元的參數');

    } else if (obj.isArray) {
      this._arraySection(obj);
      this._rowBtn(`打散成 ${obj.copies} 個獨立物件`,
        '每一份變成可以各自搬動、各自改參數的物件。' +
        '但打散之後就不再是「同一件 ×N」了，備料時會被當成不同的件。' +
        '資訊只能往下走，所以能不打散就不要打散。', () => {
          /** ⚠ 2026-10-19（實驗 T6：`實驗-綜合評估.md` ②-15）以前寫「收不回來」—— Ctrl+Z 收得回來；真正回不去的是「之後不再是同一組」 */
          if (!confirm(`會變成 ${obj.copies} 個獨立物件，之後不會再自動合回同一組（要反悔可以馬上按 Ctrl+Z），確定嗎？`)) return;
          this.app.onExplode(obj);
        });
      this._freezeBtn(obj, '排列方式與份數');

    } else if (canExplodeShapes(obj)) {
      /**
       * 匯進來的線稿裡有好幾個形狀。合著的好處是版面鎖住不會被動到，
       * 但要個別移動旋轉就得拆開。拆開之後版面完全一樣，
       * 只是變成幾個各自有原點的物件。
       *
       * 這顆按鈕原本不存在 —— 日誌裡卻寫了「要拆的人可以用現成的打散」，
       * 那是一個不存在的退路（2026-08-22 kang 問了才發現）。
       */
      const spec = PRIM_SPECS[obj.src.type];
      if (spec) {
        this.form.appendChild(head(spec.label + ' 參數'));
        for (const f of spec.fields) {
          this._rowNum(f.label, obj.src[f.key], f, v => {
            const was = this._onFloor(obj);       // ③-14
            obj.src[f.key] = f.int ? Math.round(v) : v;
            obj.invalidate();
            this.analysisCache.delete(obj.id);
            this._edit('改' + f.label);
            this._afterParam(obj, was);
          }, f.hint);
        }
      }
      this._rowBtn(`打散成 ${obj.src.shapes.length} 個獨立物件`,
        '每個形狀變成可以各自移動、旋轉、縮放的物件。'
        + '版面維持原樣，而且每個物件的原點都在自己的中心。'
        + '拆開之後就不再是同一份稿了（Ctrl+Z 可以復原）。', () => {
          if (!confirm(`會變成 ${obj.src.shapes.length} 個獨立物件，`
            + '之後不會再自動合回同一份稿（要反悔可以馬上按 Ctrl+Z），確定嗎？')) return;
          this.app.onExplode(obj);
        });
      this._toPenBtn(obj);    // ④-7

    } else if (obj.isParametric) {
      const spec = PRIM_SPECS[obj.src.type];
      if (spec) {
        this.form.appendChild(head(spec.label + ' 參數'));
        /**
         * 🔴 **開關要畫在數字前面** —— 它決定下面那個數字**叫什麼名字**
         * （鋼筆：厚度／高度／寬度）。⛔ 反過來的話使用者是先看到
         * 一個標籤，改了上面的開關才發現它變了。
         */
        /** 🔴 乙 第 2 輪：鋼筆立在牆上 ⇒ 欄位名字換成「厚度／往外長」（`io.js` `penWallSide()`） */
        const ctx = { wall: obj.src && obj.src.type === 'pen' && !!penWallSide(obj) };
        for (const t of spec.toggles || []) {
          if (t.when && !t.when(obj.src)) continue;
          this._rowCheck(t.labelOf ? t.labelOf(obj.src, ctx) : t.label, obj.src[t.key], v => {
            const was = this._onFloor(obj);       // ③-14
            obj.src[t.key] = !!v;
            /**
             * 🔴🔴 **`不封口` 一開，這個物件就⛔ 不再是實體了。**
             * 開放的單層面**種類要跟著變成板件**，否則：
             * 板厚欄位看不到（厚薄改不了）、3D 列印會說它不封閉。
             * ⚠ **⛔ 不要只改 `src`** —— 那正是「性質由兩端決定，
             * 只改一端 ＝ 沒改」（鐵律二）。
             */
            if (t.key === 'open') obj.kind = penKind(obj.src) ?? obj.kind;
            obj.invalidate();
            this.analysisCache.delete(obj.id);
            this._edit('改' + t.label);
            this._afterParam(obj, was);
          }, t.hint);
        }
        for (const f of spec.fields) {
          if (f.when && !f.when(obj.src)) continue;
          const lab = f.labelOf ? f.labelOf(obj.src, ctx) : f.label;
          this._rowNum(lab, obj.src[f.key], f, v => {
            const was = this._onFloor(obj);       // ③-14：改之前貼不貼地
            /**
             * ④-19：折板改「原點在第幾段」⇒ 整個斷面平移了 ⇒ 把位置補回去，**板子在畫面上一格都不動**，只換原點。
             * 斷面在物件自己的 XY 平面 ⇒ 位移照物件的角度與縮放換到世界（矩陣的前兩欄）。
             */
            if (obj.src.type === 'bend' && f.key === 'anchorSeg') {
              const before = bendProfile(obj.src, obj.thickness);
              const after = bendProfile({ ...obj.src, anchorSeg: Math.round(v) }, obj.thickness);
              const a = before.segStarts[before.anchor - 1], b = after.segStarts[after.anchor - 1];
              const dx = b[0] - a[0], dy = b[1] - a[1];
              const e = obj.matrix().elements;
              obj.pos.x += e[0] * dx + e[4] * dy;
              obj.pos.y += e[1] * dx + e[5] * dy;
              obj.pos.z += e[2] * dx + e[6] * dy;
            }
            obj.src[f.key] = f.int ? Math.round(v) : v;
            obj.invalidate();
            this.analysisCache.delete(obj.id);
            this._edit('改' + lab);
            this._afterParam(obj, was);           // ③-14 離地、③-7 齒輪卡住 ⇒ 講出來
          }, f.hintOf ? f.hintOf(obj.src, ctx) : f.hint);
        }
        if (obj.src.type === 'pen') this._penRevBox(obj);
        /**
         * ⭐ **看得到的用法說明**（2026-10-08 為齒輪加的）。
         * ⚠ ⛔ 不可以只靠 `hint` —— 那是滑鼠移上去才出現的提示，平板上看不到。
         * 改格子會走 `_edit()` → `refresh()` 重畫，所以這幾行永遠跟著格子的數字。
         */
        for (const s of spec.noteOf ? spec.noteOf(obj.src, obj) : []) this.form.appendChild(note(s));
        if (spec.hasBends) this._bendList(obj);
        if (obj.src.type === 'extrude') this._toPenBtn(obj);    // ④-7
        /**
         * ⚠ **鋼筆物件要多講一句** —— 它比別的參數物件多失去一樣東西：
         * **那串錨點**。轉了之後 `編輯路徑` 那顆會消失，
         * ⛔ 錨點、把手、加洞全部回不去。
         * 〔實證 2026-08-30：`bake()` 之後 `src.paths` 不見了，
         * 　而形狀一格不差（體積 6000 → 6000）〕
         */
        const isPen = obj.src.type === 'pen';
        this._rowBtn('轉成可編輯網格',
          '不可逆。轉了之後就不能再改上面的參數，但可以做面編輯'
          + (isPen
              ? '。⚠ 鋼筆物件轉了之後那串錨點就不見了——'
                + '「編輯路徑」會消失，改錨點、拉把手、加洞全部回不去。'
                + '⭐ 形狀本身一格都不會變'
              : ''),
          () => {
            /** ⑤-12（2026-10-20，kang「照建議」）：照「凍結」的寫法先問一句（T5 按下去才發現參數全沒了）*/
            if (!confirm('轉成網格之後就不能再改上面的參數了'
              + (isPen ? '，而且那串錨點會不見（「編輯路徑」回不去，形狀本身不會變）' : '')
              + '（要反悔可以馬上按 Ctrl+Z），確定嗎？')) return;
            obj.bake();
            this._edit('轉成網格');
            /**
             * 🔴 **⛔ 不可以安靜地做完** —— 按下去之後右側面板整個換掉、
             * `編輯路徑` 消失，⛔ 不講的話跟「壞了」分不出來（坑第 21 條）。
             */
            if (isPen) {
              this.app.toast('已經轉成網格：現在可以拉點線面、導角、環切了　'
                + '⚠ 但那串錨點已經不在了 ——「編輯路徑」回不去，'
                + '厚度也不能再改（形狀本身一格都沒變）');
            }
          });
      }
    } else {
      this.form.appendChild(note('這個物件已經是網格，沒有參數可以改'));
    }

    /**
     * 🔴🔴 **加厚後轉成網格**（2026-08-30，kang 問出來的）。
     *
     * > **他的原話：「鈑件厚度並不受網格的控制…是否也能夠針對厚度
     * > 　也可以轉成可以編輯網格」**
     *
     * ── 為什麼是【另一顆】，⛔ 不是改掉上面那顆 ──────────────
     * 兩顆的代價不同，而差別落在 kang 最在意的地方（做得出東西）：
     * **`轉成可編輯網格`** → 網格還是**一張紙** → 展開圖就是那一片板
     * **這一顆**　　　　　 → 網格變成**實體** → 側面導角、開孔做得到
     *
     * ⚠ **⛔ 不要寫「展開就走不了」——【那是錯的】**（AI 說過一次，
     * 被 kang 當場質疑「分片不也可以展開？」）。
     * 【實證】展開**走得動**，只是攤出來的是**盒子**：
     * 一片 100×60、板厚 1 → 展開後 **202 × 260**（⛔ 不是 100×60）。
     *
     * ── ⚠ 條件是「網格開放」，⛔ 不是 `kind === SHEET` ────────
     * `kind` 是使用者在下拉裡隨手可改的標籤，**封閉與否才是幾何事實**
     * 〔跟 `scene.js`／`exportPanel.js` 判的是同一件事，坑第 8、30 條〕。
     * ⭐ 所以**已經按過「轉成可編輯網格」的板子也還按得到這一顆**。
     */
    if (obj.thickness > 0 && !obj.mesh().isClosed()) {
      this._rowBtn('加厚後轉成網格',
        '把「板厚」那個數字烤進網格裡，變成真正的實體 —— '
        + '之後側面導角、在側面開孔才做得到。⚠ 不可逆。'
        + '⭐ 展開仍然走得動，但攤出來的是盒子的展開圖'
        + '（一片 100×60、板厚 1 → 展開後是 202×260 的六片攤開），'
        + '不再是原本那一片板',
        () => {
          /** ⑤-12：先問一句（理由同上一顆）*/
          if (!confirm('板厚會烤進網格裡、變成實體：之後就不能再改板厚，展開圖也會變成盒子的展開'
            + '（要反悔可以馬上按 Ctrl+Z），確定嗎？')) return;
          const before = obj.mesh().faces.length;
          const r = obj.bakeShelled();
          if (!r.ok) { this.app.toast(r.reason, true); return; }
          this._edit('加厚後轉成網格');
          /**
           * 🔴 **⛔ 不可以安靜地做完** —— 面板整個換掉、參數欄位消失，
           * ⛔ 不講的話跟「壞了」分不出來（坑第 21 條）。
           * ⭐ **講出「面數」與「體積」** —— 那是他對得起來的量
           * （體積 ＝ 面積 × 板厚，`shell()` 的檔頭寫著這個性質）。
           */
          const f = n => Math.round(n * 100) / 100;
          /**
           * ⚠ 2026-10-19（實驗 T1：`實驗-綜合評估.md` ②-6）體積要乘物件的縮放 —— 以前報網格自己的（293），
           * 3D 列印報的是乘過縮放的（371），同一頂帽差 26%。跟結構分析的 `volumeFactor` 同一個乘法（`core/measure.js`）。
           */
          const sc = obj.scale, vol = r.volume * Math.abs(sc.x * sc.y * sc.z);
          this.app.toast(`已經加厚成實體：面數 ${before} → ${r.faces}、`
            + `體積 ${f(vol)} cm³（＝ 面積 × 板厚${vol !== r.volume ? '，含物件的縮放' : ''}）　`
            + '⚠ 展開現在會攤成盒子，不再是原本那一片板');   // 畫面上的字⛔ 用「⛔」（2026-10-19 順手改）
        });
    }

    /**
     * 🔴 **編輯路徑時，位置／旋轉／縮放先鎖住**（2026-10-08 查 bug E4）。
     * 那時物件被暫時攤平（轉回 0°、放到地上），在這裡改的是**攤平後**的值；
     * 按「完成」時程式把進來前的角度與高度放回去 ⇒ 剛改的值被蓋掉，
     * 而且歷史紀錄裡留下一份攤平的樣子（完成之後按復原會看到它躺在地上）。
     */
    const pathEditing = !!(this.app.isPenEditing && this.app.isPenEditing(obj));
    if (pathEditing) {
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = '正在編輯路徑：位置、旋轉、縮放先鎖住 —— 按「完成」之後再改';
      this.form.appendChild(note);
    }

    // ── 位置 ──
    this.form.appendChild(head('位置 cm'));
    this._rowVec3(obj.pos, ['X', 'Y', 'Z'], () => this._edit('改位置'), false, pathEditing);

    /**
     * 🔴 **落地**（2026-10-09，kang 拍板做按鈕、⛔ 不做自動往上長 —— 理由在 `core/align.js` 的 `landPositions()`）。
     * 只在**單選**時放這裡；多選時是「整組落地」，放在對齊那一塊（⛔ 同一顆按鈕兩種意思會讓人猜）。
     * ⭐ 沉在地板下才多一行 ⚠（kang 拍板要主動提醒）；浮起來⛔ 不提醒 —— 疊在別的東西上面常常是故意的。
     */
    if (!many && !pathEditing) {
      const low = lowestY([obj]);
      if (low < -1e-3) this.form.appendChild(note(`⚠ 底部在地板下 ${+(-low).toFixed(2)} cm —— 按「落地」貼回地板`));
      this._rowBtn('落地（底部貼到地板）',
        '只動高度（Y），X、Z 不變。改了尺寸、縮放、旋轉之後沉下去或浮起來都能用',
        () => this._applyPositions(landPositions(this.app.sel.objects), '落地'));
    }

    /**
     * 🔴 **原點置中：把箭頭的那個點搬到物件正中間，⛔ 而東西一格都不動。**
     *
     * ── 為什麼放在這裡，⛔ 不放工具列 ────────────────────
     * 它是**物件屬性**的操作（就在「位置」底下最合理），而且
     * 【實測 2026-08-29】工具列在 **1024×768 平板橫向已經吃掉 51% 畫面高度**。
     *
     * ── ⚠ 只對網格物件給按 ────────────────────────────
     * 參數物件的形狀是照參數重新生成的，改了頂點留不住 ——
     * `recenterOrigin()` 自己也會擋，這裡只是先不畫出來。
     */
    if (obj.src && obj.src.type === 'mesh') {
      this._rowBtn('原點置中',
        '把箭頭（旋轉與縮放的中心）搬到這個物件的正中間。'
        + '⚠ 東西不會動一格，只有那個點會換位置。'
        + '「分離」出來的塊常常原點在邊上，轉起來會繞著邊轉',
        () => {
          const r = recenterOrigin(obj);
          if (!r.ok) { this.app.toast(r.reason, true); return; }
          /**
           * ⚠ **已經在中心也要講一句** —— 一顆按下去畫面上什麼都不變的
           * 按鈕，⛔ 跟「壞了」分不出來（坑第 21 條）。
           */
          if (!r.moved) { this.app.toast('原點本來就在正中間，沒有東西要搬'); return; }
          /**
           * ⚠ **講出「搬了多遠」** —— 那是使用者對得起來的量：
           * 圓柱從中間分離，下面那塊會是 Y 半個高度。
           */
          const f = n => (Math.round(n * 100) / 100);
          this.app.toast('原點已經搬到正中間　'
            + `（那個點移了 X ${f(r.offset.x)}、Y ${f(r.offset.y)}、`
            + `Z ${f(r.offset.z)} cm）　⚠ 東西本身一格都沒動`);
          /**
           * 🔴🔴 **⛔ 少了這一行，畫面上東西會整個位移**（kang 2026-09-01 回報）。
           *
           * `recenterOrigin()` 是**就地改頂點座標**，⛔ 網格物件沒有換人 ——
           * 而 `scene.js` 的 `_updateNode()` 只在三種情況重建幾何：
           * **網格換人／板厚變了／有人喊 `markGeomDirty()`**。
           * ⇒ 前兩個都察覺不到 ⇒ **幾何不重建**。
           *
           * ⚠ **症狀⛔ 不是「畫面沒反應」，而是【東西會跳走】**：
           * `obj.pos` 已經更新了（node 跟著搬），但幾何還是舊的、
           * **那個位移沒有被抵銷** ⇒ 物件整個位移，而箭頭跟著新的 pos ⇒
           * 看起來就是「**原點置中沒有作用**」。重整之後網格從存檔重建
           * （換了新物件）才恢復正常 —— 而那正是 kang 描述的三個步驟。
           *
           * ⭐ **同一條規則的鄰居就在這一支裡**：`清除分片標記` 喊的是
           * `markSeamsDirty()`。**改了幾何的按鈕，自己負責喊。**
           * 〔查證過 `toolbar.js` 其餘的按鈕：`轉成網格`／`凍結成網格` 走
           * 　`bake()`，**那會換掉整個網格物件**，所以察覺得到 —— ⛔ 不必喊〕
           */
          this.app.view.markGeomDirty();
          this._edit('原點置中');
        });

      /**
       * 🔴🔴 **原點搬到你點的地方**（2026-09-01，kang 要的）。
       *
       * ── 為什麼放這裡，⛔ 不放工具列 ──────────────────
       * 跟 `原點置中` 完全一樣的理由：它是**這個物件的**操作，
       * 而工具列在 1024×768 平板橫向已經吃掉 51% 畫面高度，
       * **左側直條也只剩一顆的空間**〔2026-08-31 量過〕。
       *
       * ⚠ **它是一個【開關】** —— 按下去進入「點一下模型」的狀態，
       * 點到就做完並自動退出。⭐ **再按一次 ＝ 取消**，
       * 所以按鈕的字要跟著狀態換，⛔ 不然使用者不知道自己還在那個狀態裡。
       */
      /**
       * ⚠ **按下去之後那個字⛔ 不可以太長 —— 面板放不下就【破格】。**
       * 【實證 2026-09-01，kang 截圖】第一版寫
       * 「⋯ 點模型上的一個角／邊／面（再按一次取消）」**二十個字，撐爆了**。
       *
       * 🔴 **⛔ 判準⛔ 不是「感覺短一點」，是量過的**：
       * **這個面板上既有的按鈕最長 7 個字**
       * （`轉成可編輯網格`／`加厚後轉成網格`）⇒ **⛔ 不要超過它**。
       * ⚠ 第二版寫「⋯ 點一個角／邊／面」**還是 9 個字**，⛔ 一樣會破。
       *
       * ⭐ **⛔ 資訊不必塞進按鈕**：「點什麼」「怎麼取消」講在 `title`
       * 與按下去的提示裡，按鈕只要短到看得出「**現在在等你點**」就夠了。
       */
      const picking = this.app.sel.originMode;
      this._rowBtn(picking ? '⋯ 請點模型' : '原點搬到⋯',
        '按下去之後，在模型上點一個角、一條邊或一個面，'
        + '原點（旋轉與縮放的中心）就搬到那裡。'
        + '⚠ 東西不會動一格，只有那個點會換位置。'
        + '⭐ 想讓板子繞著某一條邊翻起來（像門的鉸鏈）就先把原點釘到那條邊。'
        + '⚠ 不想改了就再按一次這一顆取消',
        () => {
          const on = !this.app.sel.originMode;
          if (on) this.app.exitOtherModes('origin');
          this.app.sel.setOriginMode(on);
          this.refresh();
          if (on) {
            this.app.toast('在模型上點一個角、一條邊或一個面 —— '
              + '原點就會搬到那裡（東西不會動）　'
              + '⚠ 不想改了就再按一次那一顆取消');
          }
        });
    }

    /**
     * 🔴🔴 **編輯路徑：回頭改鋼筆畫出來那一串錨點**（第 2 階段，2026-08-29）。
     *
     * ── 為什麼放在這裡，⛔ 不放工具列 ────────────────────
     * 跟 `原點置中` 同一條理由：它是**這個物件的**操作，
     * 而工具列在 1024×768 平板橫向已經吃掉 51% 畫面高度。
     *
     * ── ⚠ 只有 `pen` 物件有這一顆 ──────────────────────
     * 按過「轉成可編輯網格」的話 `src.type` 已經變成 `mesh`，
     * **那一串錨點就不在了** —— 那時這一顆⛔ 不出現（⛔ 不是按了才講）。
     */
    if (obj.src && obj.src.type === 'pen') {
      this._rowBtn('編輯路徑',
        '回頭改這支鋼筆的錨點：拖點＝搬位置、拖把手＝調曲線。'
        + '⚠ 編輯的時候這個物件會暫時攤平並變半透明，按「完成」就轉回去。'
        + '原點不會被動到',
        () => this.app.onEditPenPath(obj));
      /**
       * 🔴 **加一條（挖洞）**（綜合評估 ⑤-8，2026-10-20，kang「同意你的建議」）：一按就進「編輯路徑」＋「加一條」。
       * 以前點回起點就收工，要挖洞得自己進編輯路徑、再找「加一條」（T7）。
       * ⭐ 業界：Illustrator 封口後鋼筆還開著、挖洞另外做「複合路徑」（Adobe 官方說明）；我們封口就長成立體，所以收工照舊、這裡一步接回去。
       * ⚠ 只給封口的、⛔ 給旋轉成形（旋轉成形的線挖洞沒有意思）。
       */
      if (!obj.src.open && !obj.src.rev) {
        this._rowBtn('加一條（挖洞）',
          '接著在這個形狀上再畫一條：畫在裡面＝ 挖一個洞；畫在外面＝ 同一個物件裡多一塊。'
          + '畫完按「完成」',
          () => this.app.onAddPenHole(obj));
      }
    }

    this.form.appendChild(head('旋轉 度'));
    this._rowVec3(obj.rot, ['X', 'Y', 'Z'], () => this._edit('改旋轉'), true, pathEditing);

    this.form.appendChild(head('縮放 倍'));
    this._rowVec3(obj.scale, ['X', 'Y', 'Z'], () => this._edit('改縮放'), false,
      obj.lockScale || pathEditing);
    /**
     * ④-12（2026-10-19，kang「同意你的安排與建議」）：**整體縮放打一個數字** —— 打 2 ⇒ 三個方向都**乘** 2
     * （比例照舊：原本 1 × 1.5 × 1 會變 2 × 3 × 2）。打完欄位回到 1（它是「再乘多少」，⛔ 是目前的大小）。
     * 鎖定縮放、編輯路徑中照舊不給改。
     */
    if (!obj.lockScale && !pathEditing) {
      this._rowNum('整體 ×', 1, { step: 0.1, min: 0.001 }, v => {
        if (!(v > 0) || Math.abs(v - 1) < 1e-12) { this.refresh(); return; }
        obj.scale.multiplyScalar(v);
        this._edit(`整體縮放 ×${+v.toFixed(4)}`);
      }, '三個方向一起乘這個倍數（比例不變）。打 2 ＝ 放大兩倍、打 0.5 ＝ 縮成一半；打完欄位回到 1');
    }

    this._rowCheck('鎖定縮放', obj.lockScale, v => {
      obj.lockScale = v;
      this._edit(v ? '鎖定縮放' : '解除鎖定');
    }, '鎖定後不給縮放把手。帶料表的精確件應該鎖住，避免圖面與實際用料不符');

    /** ③-8：多選時一起改（見上面「種類、板厚、顏色」那則）*/
    this._rowColor(together('顏色', all.length), obj.color, v => {
      for (const o of all) o.color = v;
      this._edit(all.length > 1 ? `改顏色（${all.length} 個）` : '改顏色');
    });
  }

  /**
   * 🔴🔴 **鋼筆物件的「旋轉成形」**（2026-10-15，第 1 輪接回）。
   *
   * ⭐ **放在右側面板，⛔ 不放回工具列**（2026-09-02 收起來的那 8 個控制項還註解在
   * `index.html`）：它現在是**這支鋼筆自己的一個模式**（丙-1.5），⛔ 不是
   * 「選一串東西 → 按一顆鈕 → 長出新物件」 —— 跟 `編輯路徑`、`原點置中`
   * 同一條理由：是這個物件的事，而工具列在平板橫向已經吃掉一半高度。
   *
   * ⚠ **中心線那一格是【世界座標】**，跟參考線同一套 ——
   * 放一條參考線、在這裡打同一個數字，中心線就在那條線上（第 2 輪才會「綁住」）。
   * 換算照 `penPathToWorld()`：**只算位置與縮放，⛔ 不算旋轉**（同一個已知限制）。
   *
   * ⚠ 改中心線／方向／立起來之後**原點重新置中**（對碗，⛔ 不是對線）——
   * ⛔ 不置中的話箭頭與旋轉中心會落在碗的邊上。
   */
  _penRevBox(obj) {
    const src = obj.src;
    const rev = src.rev;
    const after = (label, msg) => {
      obj.kind = penKind(src) ?? obj.kind;
      obj.invalidate();
      if (label !== '改轉幾格') recenterOrigin(obj);
      this.analysisCache.delete(obj.id);
      this._edit(label);
      if (msg) this.app.toast(msg);
    };

    this.form.appendChild(head('旋轉成形'));
    this._rowCheck('旋轉成形', !!rev, on => {
      /**
       * 🔴 **牆上的旋轉成形**（kang 2026-10-17：開旋轉成形那一刻記下）——
       * 物件這時候立在牆上（`penWallSide`）⇒ `rev.wall` 記下是哪一面；之後⛔ 跟著角度改
       *（改了碗會突然跳一下）。牆上的碗⛔ 立起來（`stand` 關）。
       */
      const wall = on ? penWallSide(obj) : null;
      if (on) {
        src.rev = { ...PEN_REV_DEFAULTS, ...(wall ? { stand: false, wall } : {}),
                    at: penRevAutoAt(src, PEN_REV_DEFAULTS.dir) };
      } else delete src.rev;
      /**
       * ⑤-9（2026-10-20，kang「同意你的建議」）：**預設照舊放在線的最左邊，提示講清楚那一頭會怎樣、怎麼改**。
       * ⚠ 預設⛔ 改：取最小值是踩過才定的（取別的點常被「跨過中心線」自己擋掉，`規格\建模器-旋轉成形.md`）。
       * T5：燈罩上口收成尖頂、要自己算中心線 X ⇒ 指到 ④-13 的「起點離中心線 cm」那一格。
       * ⭐ 業界：Rhino、Fusion 360 都要人自己指中心線（官方說明）；我們先自動放、再讓人改，所以提示要把「放在哪」講出來。
       */
      const r1 = on ? penRevolve(src) : null;
      const pr = r1 && r1.ok && r1.profileR;
      const tip = !pr ? '' : pr.head < 1e-6
        ? '　⚠ 起點剛好在中心線上 ⇒ 那一頭收成尖頂（碗底就是這樣封起來的）；要那一頭開口（燈罩上口），在底下「起點離中心線 cm」打半徑'
        : pr.tail < 1e-6 ? '　終點剛好在中心線上 ⇒ 那一頭封起來；要開口就在底下改「中心線在」' : '';
      after(on ? '開旋轉成形' : '關旋轉成形', on
        ? '旋轉成形：開。這條線繞著中心線轉一圈 —— 中心線先自動放在線的最左邊，'
          + '底下可以改。線還留著：按「編輯路徑」改線，碗會跟著變' + tip
        : '旋轉成形：關。回到原本的板／牆／實心塊（線沒有動）');
    }, '開 ＝ 這條線繞一根中心線轉一圈，長成碗、罩、瓶、燈罩、圓頂。'
      + '線還留著，按「編輯路徑」改線，碗會跟著變。'
      + '關 ＝ 回到原本的板／牆／實心塊');
    if (!rev) return;

    const isZ = rev.dir !== 'x';
    const s = isZ ? obj.scale.x : obj.scale.z;
    const p0 = isZ ? obj.pos.x : obj.pos.z;
    /** 🔴 牆上的碗（kang 2026-10-17：方向叫直的／橫的、位置顯示真的位置、⛔ 顯示「立起來」） */
    const wall = !!rev.wall;

    this._rowSelect('中心線方向', isZ ? 'z' : 'x', wall ? [
      ['z', '直的（碗正立）'],
      ['x', '橫的（沿著牆的水平線）']
    ] : [
      ['z', '前後（Z 方向）'],
      ['x', '左右（X 方向）']
    ], v => {
      rev.dir = v === 'x' ? 'x' : 'z';
      /** ⚠ 換方向之後舊的位置⛔ 沒有意義（量的是另一個座標）⇒ 重新自動放一次；跟著的參考線也換了一種 ⇒ 脫鉤 */
      rev.at = penRevAutoAt(src, rev.dir);
      rev.bind = null;
      after('改中心線方向', wall
        ? '中心線換成' + (rev.dir === 'x' ? '橫的' : '直的') + '，位置重新自動放在線的最' + (rev.dir === 'x' ? '上面' : '左邊')
        : '中心線換成' + (rev.dir === 'x' ? '左右' : '前後')
          + '方向，位置重新自動放在線的最' + (rev.dir === 'x' ? '上面' : '左邊'));
    }, wall
      ? '這條線畫在牆上：中心線也在那片牆上。直的 ＝ 一條上下的線（碗正立）；橫的 ＝ 一條沿著牆的水平線（碗橫躺）。'
        + '碗一半在牆前、一半在牆後'
      : '中心線一定躺在地板上（線畫在地板上，中心線要跟它在同一個平面才轉得出東西）。'
        + '從上面看：前後 ＝ 畫面上下那個方向，左右 ＝ 畫面左右那個方向');

    /**
     * 🔴 **第 2 輪：中心線跟著一條參考線**（kang 2026-10-16 同意「右側面板多一個下拉」）。
     * ⭐ 跟參考線工具列那個下拉同一種用法：列出同方向的參考線，選一條就綁上、選「不跟」就脫鉤。
     * ⚠ 前後方向的中心線只能跟「前後線 X」、左右方向只能跟「左右線 Z」—— 另一種跟它垂直，綁不上。
     */
    const gax = revGuideAx(src);
    const gname = { x: '前後線 X', y: '高度 Y', z: '左右線 Z' }[gax];
    const glist = (this.app.doc && this.app.doc.guides && this.app.doc.guides[gax]) || [];
    const bound = rev.bind !== null && rev.bind !== undefined;
    /**
     * ⚠ 2026-10-19（實驗 T5、T7：`實驗-綜合評估.md` ②-8）下拉要在 0.001 內找「綁著的是哪一條」，⛔ 用字串完全相等：
     * 參考線存的是捨到 0.001 的（`io.js` `normalizeGuides()`，刻意的），綁定記的是沒捨的（2.3561 vs 2.356）⇒
     * 以前找不到相同字串就顯示「不跟」，其實還綁著（`revCheckBinds()` 也是用 0.001 判斷）。
     */
    const boundTo = bound ? glist.reduce((best, g) => (Math.abs(g - rev.bind) <= 0.001 + 1e-9
      && (best === null || Math.abs(g - rev.bind) < Math.abs(best - rev.bind)) ? g : best), null) : null;
    this._rowSelect('中心線跟著', boundTo !== null ? String(boundTo) : bound ? String(rev.bind) : '', [
      ['', '不跟（打數字）'],
      ...glist.map(g => [String(g), `${gname} ＝ ${round(g)}`])
    ], v => {
      if (v === '') {
        rev.bind = null;
        after('中心線不跟參考線', '中心線不跟參考線了：之後拖參考線不會再影響這個碗（形狀不變）');
        return;
      }
      const c = +v;
      /**
       * 🔴 ③-11（2026-10-19，kang「照建議」）：綁上去那一刻**搬碗、⛔ 改中心線** ⇒ 大小一格都不變
       * （以前用 `revAtForGuide()` 改 `rev.at` ⇒ 碗當場變大一圈，T5）。之後拖參考線才變粗變細。
       */
      const r = revMoveToGuide(obj, c);
      if (!r.ok) { this.app.toast(r.reason, true); this.refresh(); return; }
      obj.pos[r.ax] += r.delta;
      rev.bind = c;
      const moved = Math.abs(r.delta) > 1e-6 ? `碗整個搬過去 ${round(Math.abs(r.delta))} cm、大小不變` : '碗本來就在線上';
      after('中心線綁參考線', `中心線跟著 ${gname} ＝ ${round(c)}：${moved}。之後拖那條參考線，碗會當場跟著變粗變細；`
        + '把碗搬離那條線（或刪掉那條線）就自動脫鉤，形狀不變');
    }, glist.length
      ? `選一條 ${gname}，碗就整個搬到那條線上（大小不變）並跟著它：之後拖那條參考線，碗會當場跟著變粗變細。`
        + '沿著中心線推、往上抬都還跟著；搬離那條線、或刪掉那條線就自動脫鉤（形狀不變）'
      : `還沒有 ${gname} 參考線 —— 先按左側「參考線」加一條，這裡就選得到`);

    if (wall) {
      /**
       * 🔴 牆上的碗：顯示**真的位置**（世界座標，跟參考線同一套），⛔ 照地板那條算法（那條⛔ 管角度 —— 不準）。
       */
      const cur = revWallAxisAt(obj);
      this._rowNum(`中心線在 ${gax === 'y' ? '高度 Y' : gax.toUpperCase()} ＝`, round(cur.v), { step: 0.5 }, v => {
        const r = revWallAtFor(obj, v);
        if (!r.ok) { this.app.toast(r.reason, true); return; }
        const was = bound;
        rev.bind = null;
        rev.at = r.at;
        after('改中心線位置', was ? '自己打了中心線的位置：已經不跟參考線了' : undefined);
      }, '單位 cm，世界座標（跟參考線同一套）—— 打一條參考線的數字，中心線就在那條線上。'
        + '⚠ 自己打數字就不跟參考線了（要跟就用上面那個下拉）');
    } else this._rowNum(isZ ? '中心線在 X ＝' : '中心線在 Z ＝', +rev.at * s + p0, { step: 0.5 }, v => {
      if (Math.abs(s) < 1e-9) {
        this.app.toast('這個物件有一軸的縮放是 0，中心線放不上去 —— 先把縮放改回來', true);
        return;
      }
      /** ⚠ 自己打數字 ＝ 不跟參考線了（兩個地方各管一份位置，遲早不一致 —— 坑第 31 條） */
      const was = bound;
      rev.bind = null;
      rev.at = (v - p0) / s;
      after('改中心線位置', was ? '自己打了中心線的位置：已經不跟參考線了' : undefined);
    }, '單位 cm，跟參考線同一套座標。⚠ 自己打數字就不跟參考線了（要跟就用上面那個下拉）。'
      + '⚠ 物件轉過角度時這一格不準');

    /**
     * ④-13（2026-10-20）：**直接打「起點離中心線多遠」**（燈罩上口的半徑）—— 線不動、只挪中心線（`prim.js` `penRevAtForHeadR()`）。
     * 單位是畫面上的 cm（除以物件的縮放才是線自己的長度）；跟「中心線在」那格一樣，自己打就不跟參考線了。
     */
    const r0 = penRevolve(src);
    if (r0.ok && r0.profileR && Math.abs(s) > 1e-9) {
      this._rowNum('起點離中心線 cm', round(r0.profileR.head * Math.abs(s)), { min: 0, step: 0.5 }, v => {
        const q = penRevAtForHeadR(src, v / Math.abs(s));
        if (!q.ok) { this.app.toast(q.reason, true); return; }
        const was = bound;
        rev.bind = null;
        rev.at = q.at;
        after('改起點離中心線', `起點離中心線改成 ${round(v)} cm（線沒動、只挪了中心線，碗跟著變大變小）`
          + (was ? '　自己打了數字：已經不跟參考線了' : ''));
      }, '輪廓第一個點（起點）離中心線多遠，單位 cm —— 燈罩、碗的那一圈口的半徑。'
        + '線一格都不動、只挪中心線（留在原本那一邊）。⚠ 自己打數字就不跟參考線了');
    }

    this._rowNum('轉幾格', rev.seg, { min: 3, max: 360, step: 1, int: true }, v => {
      rev.seg = Math.round(v);
      after('改轉幾格');
    }, '轉一圈分成幾格。跟圓柱的「分段」同一個意思：越多越圓、面越多');

    if (wall) {
      this.form.appendChild(note('畫在牆上：中心線就在你畫的那條線上，碗一半在牆前、一半在牆後（不抬、不立起來）'));
    } else this._rowCheck('立起來', !!rev.stand, on => {
      rev.stand = !!on;
      after(on ? '立起來' : '躺下', on
        ? '立起來：開。中心線轉成直立、底貼地板 —— '
          + (isZ ? '畫面上方那一頭朝上' : '畫面右邊那一頭朝上')
        : '立起來：關。照畫的樣子躺在地板上轉');
    }, '開 ＝ 中心線轉成直立、底貼地板。前後方向時，上視圖畫面上方那一頭朝上；'
      + '左右方向時，畫面右邊那一頭朝上（反了就把物件轉 180 度）。'
      + '關 ＝ 照畫的樣子躺著。這個選擇會記住：之後改線還是一樣');

    /**
     * 🔴 **結果講給他看，⛔ 不要讓他按了才知道**（照 `切一刀` 的 `bisectRange` 那條理由）。
     * ⭐ 判準跟 `penKind()` 讀的是**同一份** `penRevolve()` 回傳 ——
     * 「碰到幾端」與「實體還是板件」⛔ 不各算一次〔2026-09-02 兩句話打架的教訓〕。
     */
    const r = penRevolve(src);
    if (!r.ok) {
      this.form.appendChild(note(`轉不出來：${r.reason}`));
      return;
    }
    const k = Math.abs(s);
    const f = x => round(x * k);
    this.form.appendChild(note(`離中心線 ${f(r.profileR.min)} ～ ${f(r.profileR.max)} cm`));
    const [h0, h1] = r.endsOnAxis;
    this.form.appendChild(note(
      r.closedProfile
        ? '「不封口」關著：頭尾接起來轉成一個環 → 實體（可以 3D 列印）'
        : (h0 && h1)
          ? '兩端都碰到中心線 → 封閉的實體（可以 3D 列印）'
          : (h0 || h1)
            ? '只有一端碰到中心線 → 有底的碗（板件，厚薄用上面的「板厚」）'
            : '兩端都沒碰到中心線 → 兩頭開口，像燈罩（板件，厚薄用上面的「板厚」）'));
  }

  _edit(label) {
    this.app.onEdit(label);
    this.refresh();
  }

  /**
   * 🔴 **匯入的形狀「轉成鋼筆」**（綜合評估 ④-7，2026-10-20，kang「同意你的安排與建議」）——
   * 轉了之後右側面板有「編輯路徑」：改點、拉把手、加洞（T6 招牌字）。換算在 `prim.js` `extrudeToPenSrc()`。
   * ⭐ 位置、大小⛔ 動（同一套 2D 座標與厚度）；記一步復原。舊的匯入沒有記錨點 ⇒ 講一句「點會比較多」。
   * ⚠ 好幾個形狀合在一起的 ⇒ 變成一支有好幾條線的鋼筆（裡面的線還是洞）；要各自改請先「打散」。
   */
  _toPenBtn(obj) {
    this._rowBtn('轉成鋼筆（可以改點、加洞）',
      '把這個匯入的形狀換成鋼筆物件：之後按「編輯路徑」就能改錨點、拉把手、多畫一圈當洞。'
      + '位置與大小不變（Ctrl+Z 可以復原）。好幾個形狀合在一起的會變成一支有好幾條線的鋼筆 —— 要各自改請先「打散」', () => {
        const r = extrudeToPenSrc(obj.src);
        if (!r.ok) { this.app.toast(r.reason, true); return; }
        obj.src = r.src;
        obj.invalidate();
        this.analysisCache.delete(obj.id);
        this._edit('轉成鋼筆');
        this.app.toast(`已轉成鋼筆：${r.src.paths.length} 條線、${r.anchors} 個錨點 —— 按右側「編輯路徑」就能改點、加洞`
          + (r.approx ? `　⚠ 其中 ${r.approx} 條是舊的匯入、沒有記曲線的把手：每個轉折都變成一個點（形狀一樣、點比較多）` : ''));
      });
  }

  /**
   * 🔴 **案件名稱可以填**（綜合評估 ④-19，2026-10-19，kang「同意你的安排與建議」）。
   * 展開圖、剖面分切、DXF 的標題都印「案件：○○ 日期」，存檔、匯出的檔名也用它 ——
   * 但以前**沒有任何地方可以改**，每張圖都印「案件：未命名」（T3）。
   * ⭐ 放在「沒選東西」時的右側面板（⛔ 加到工具列：工具列換行會讓按鈕跑位）；
   * 改了記一步復原（`commit()` 的快照就是整份文件，含案件資料）。日期是新建那天（③-6），只顯示、⛔ 給改。
   */
  _caseBox() {
    const doc = this.app.doc;
    const h = doc && doc.head;
    if (!h) { this.form.hidden = true; return; }
    this.form.hidden = false;
    this.form.innerHTML = '';
    this._target = this.form;
    this.form.appendChild(head('案件'));
    this._rowText('名稱', h.name || '', v => {
      const name = String(v || '').trim() || '未命名';
      if (name === h.name) return;
      h.name = name;
      this._edit('改案件名稱');
      if (this.app.toast) this.app.toast(`案件名稱：${name}　展開圖、剖面分切、DXF 的標題和存檔的檔名都會用它`);
    });
    this.form.appendChild(note(`日期 ${h.date || '—'}（按「新建」時自動填今天）。展開圖、剖面分切、DXF 的標題印「案件：名稱　日期」`));
  }

  // ═══════════════════════════════════════════════════
  //  對齊與均分
  // ═══════════════════════════════════════════════════

  /**
   * 對齊面板。**只有選兩個以上才出現** —— 一個物件要對誰？
   *
   * kang 要的是「多個物件組合時，每個物件準確移動到正確位置」，
   * 而他給的參考是 Illustrator 的對齊面板。
   *
   * 版面照那個面板的分組：對齊物件 → 均分物件 → 均分間距。
   * 差別是這裡多一個軸，所以每一組是三列（X／Y／Z）而不是兩排按鈕。
   *
   * ── 基準是「整組選取的外框」──────────────────────────
   * 對應 Illustrator 的「對齊至：選取範圍」。靠左＝全部貼到最左那個的左緣。
   * ⚠ 這裡原本寫「沒有做『對齊至關鍵物件』」—— 2026-10-19（綜合評估 ③-3）已經做了：
   * 「對齊到」下拉選「最後選的」⇒ 它不動、其他的對過去（預設照舊是整組）。
   */
  _alignBox() {
    const objs = this.app.sel.objects;
    if (objs.length < 2) return;

    this.form.appendChild(head('對齊'));

    /**
     * 🔴 **對齊到：整組／最後選的**（綜合評估 ③-3，2026-10-19，kang「照建議」）。
     * ⭐ 預設維持「整組」（以前怎麼用就怎麼用）；選「最後選的」⇒ 最後選的那個⛔ 動、其他的對過去
     * （T9：把軸對到齒輪中心，齒輪不該被移走）。跟「咬上去」「貼合」一樣是「對到後選的那一個」。
     * ⚠ 只記在這一次開著的頁面裡（⛔ 存檔）—— 換了一組選取也照樣沿用，重新整理回到「整組」。
     */
    const actName = this.app.sel.active ? this.app.sel.active.name : '';
    this._rowSelect('對齊到', this.alignTo || 'group', [
      ['group', '整組的外框'],
      ['active', `最後選的「${actName}」（它不動）`]
    ], v => { this.alignTo = v; this.refresh(); },
    '整組的外框：全部對到整組最左／中間／最右；最後選的：最後點的那一個不動，其他的對到它');
    const anchorIdx = () => {
      if (this.alignTo !== 'active') return null;
      const list = this.app.sel.objects, act = this.app.sel.active;
      const i = list.indexOf(act);
      return i >= 0 ? i : null;
    };

    for (const ax of AXIS_KEYS) {
      const r = document.createElement('div');
      r.className = 'alignRow';
      const lb = document.createElement('label');
      lb.textContent = ax.toUpperCase();
      r.appendChild(lb);
      for (const mode of [ALIGN.MIN, ALIGN.CENTER, ALIGN.MAX]) {
        const b = document.createElement('button');
        b.textContent = ALIGN_LABEL[ax][mode];
        b.onclick = () => this._applyPositions(
          alignPositions(this.app.sel.objects, ax, mode, anchorIdx()),
          `對齊 ${ALIGN_LABEL[ax][mode]}${this.alignTo === 'active' ? `（到「${actName}」）` : ''}`);
        r.appendChild(b);
      }
      this.form.appendChild(r);
    }

    /** 🔴 **整組落地**（kang 2026-10-09 拍板：整組一起落，彼此的上下關係不變）。理由在 `landPositions()` */
    const low = lowestY(objs);
    if (low < -1e-3) this.form.appendChild(note(`⚠ 這一組最低的地方在地板下 ${+(-low).toFixed(2)} cm`));
    this._rowBtn('整組落地（最低的那一點貼到地板）',
      '整組一起上下搬，彼此的上下關係不變；只動高度（Y）',
      () => this._applyPositions(landPositions(this.app.sel.objects), '整組落地'));

    /**
     * 均分要三個以上才有意義 —— 兩個的話頭尾就是全部，動不了誰。
     * 不夠就直接說，不要放一顆按下去沒反應的按鈕（坑第 21 條）。
     */
    this.form.appendChild(head('均分'));
    if (objs.length < 3) {
      this.form.appendChild(note('均分要選三個以上'));
      return;
    }

    for (const ax of AXIS_KEYS) {
      const r = document.createElement('div');
      r.className = 'alignRow';
      const lb = document.createElement('label');
      lb.textContent = ax.toUpperCase();
      r.appendChild(lb);

      const b1 = document.createElement('button');
      b1.textContent = '均分物件';
      b1.title = '讓各物件的「中心」等距。大小一致時跟均分間距一樣';
      b1.onclick = () => this._applyPositions(
        distributePositions(this.app.sel.objects, ax), `${ax.toUpperCase()} 均分物件`);

      const b2 = document.createElement('button');
      b2.textContent = '均分間距';
      b2.title = '讓相鄰兩物件之間的「空隙」相等。大小不一時看起來對的是這個';
      b2.onclick = () => this._applyPositions(
        spacePositions(this.app.sel.objects, ax), `${ax.toUpperCase()} 均分間距`);

      r.append(b1, b2);
      this.form.appendChild(r);
    }

    /**
     * 目前的空隙如實列出來。
     *
     * 均分做完之後這排數字應該全部一樣 —— 使用者不必相信我，看數字就好。
     * 這跟分片的「展開後 N 片」是同一件事：**讓操作有沒有生效變成看得見的**。
     */
    /** ⑤-17（2026-10-20）：三個方向都列（以前只列 X ⇒ 往上疊、往後排的均分做完看不到有沒有生效，T7）*/
    for (const ax of ['x', 'y', 'z']) {
      const g = currentGaps(objs, ax);
      if (g.length) {
        this.form.appendChild(note(
          `${ax.toUpperCase()} 空隙 ` + g.map(v => round(v)).join('　') + ' cm'));
      }
    }
  }

  /**
   * 把算好的新位置套上去。
   *
   * align.js 的函式一律不改動任何東西，只回傳新位置 —— 套用這一步
   * 刻意留在這裡，因為只有這裡知道要記一步 Undo、要重畫、要講一句話。
   */
  /**
   * 齒輪「咬上去」（2026-10-08）。**剛好選兩個齒輪才出現。**
   * 🔴 **先選的動、後選的不動**（跟「貼合」一樣，kang 拍板）——
   * 按鈕上**把兩個名字寫出來**，⛔ 不讓人猜誰會動。計算在 `core/gearPair.js`。
   */
  _gearPairBox() {
    const objs = this.app.sel.objects;
    const isGear = o => !!(o.src && o.src.type === 'gear');
    /** 布林做出來的、母體（第一個）是齒輪 ⇒ 打過孔的齒輪（可能好幾層）*/
    const holedGear = src => !!src && src.type === 'bool' && !!src.items && !!src.items[0]
      && (src.items[0].src.type === 'gear' || holedGear(src.items[0].src));
    /**
     * ⑤-19（2026-10-20，kang「照建議」）：**選了兩個、其中有打過孔的齒輪 ⇒ 講為什麼沒有「咬上去」**。
     * 以前整塊不出現、也⛔ 講 ⇒ T9 打了中心孔的齒輪怎麼選都咬不上，看不出差在哪。
     * ⚠ 這一輪只講原因；要讓它咬得上，得改「從布林裡面讀出齒輪」的判斷結構（之後再說，`實驗-綜合評估.md` ⑤-19）。
     */
    if (objs.length === 2 && !objs.every(isGear) && objs.every(o => isGear(o) || holedGear(o.src))) {
      const holed = objs.filter(o => !isGear(o)).map(o => `「${o.name}」`).join('、');
      this.form.appendChild(head('齒輪'));
      this.form.appendChild(note(`${holed}是布林做出來的（齒輪打過孔，或跟別的東西併過）——「咬上去」要讀齒輪自己的齒數與模數，`
        + '布林過的物件讀不到，所以這裡沒有那顆按鈕。要咬：先把兩個齒輪咬好再打孔（或按 Ctrl+Z 退回打孔之前，咬好再打）'));
      return;
    }
    if (objs.length !== 2 || !objs.every(isGear)) return;
    const [mover, anchor] = objs;
    this.form.appendChild(head('齒輪'));
    this._rowBtn(`咬上去：把「${mover.name}」移過去咬住「${anchor.name}」`,
      '維持它現在在哪一邊，只調距離與角度；模數不一樣會改成一樣', () => {
        const r = meshGearPair(mover, anchor);
        /** ⛔ 擋下來時不可以沒反應 —— 講原因（坑第 21 條：按下去沒反應的按鈕） */
        if (!r.ok) { if (this.app.toast) this.app.toast('⚠ ' + r.reason); return; }
        if (r.module != null) mover.src.module = r.module;
        mover.pos.set(r.pos.x, r.pos.y, r.pos.z);
        mover.rot.set(0, r.rotY, 0);
        mover.invalidate();
        this.analysisCache.delete(mover.id);
        this._edit('咬上去');
        if (this.app.toast) {
          this.app.toast([`咬上去：中心距離 ${+r.dist.toFixed(3)} cm`, ...r.notes].join('；'));
        }
      });
    this.form.appendChild(note('先選的那個會動、後選的不動（跟「貼合」一樣）。'
      + '要換過來：重新選，先選要動的那個'));
  }

  _applyPositions(list, label) {
    const objs = this.app.sel.objects;
    if (list.length !== objs.length) return;
    /**
     * ⚠ 2026-10-19（實驗 T7：`實驗-綜合評估.md` ②-15）「沒動」的門檻放到 1e-6 cm（以前 1e-9：浮點誤差就算「動了」⇒ 本來就在地板上也說「移動了 10 個」）；
     * 一個都沒動 ⇒ ⛔ 記一步復原、講「沒有移動」。
     */
    let moved = 0;
    objs.forEach((o, i) => { if (o.pos.distanceToSquared(list[i]) > 1e-12) moved++; });
    if (!moved) {
      if (this.app.toast) this.app.toast(`${label}：已經在位置上了，沒有移動`);
      return;
    }
    /**
     * ③-3：講出**誰移了多少**（以前只說「移動了 2 個」⇒ 齒輪被移走 3.49 cm 也看不出來）。
     * 最多列 3 個，其餘講「等 N 個」；只列有動的那幾根軸。
     */
    const f = v => (Math.abs(v) < 0.005 ? null : `${v > 0 ? '+' : '−'}${+Math.abs(v).toFixed(2)}`);
    const who = [];
    objs.forEach((o, i) => {
      const d = list[i].clone().sub(o.pos);
      if (d.lengthSq() <= 1e-12) return;
      const parts = ['x', 'y', 'z'].map(k => (f(d[k]) ? `${k.toUpperCase()} ${f(d[k])}` : null)).filter(Boolean);
      who.push(`「${o.name}」${parts.join('、') || '（不到 0.01）'} cm`);
    });
    objs.forEach((o, i) => o.pos.copy(list[i]));
    this._edit(label);
    const more = who.length > 3 ? `等 ${who.length} 個` : '';
    if (this.app.toast) this.app.toast(`${label}：移動了 ${moved} 個物件 —— ${who.slice(0, 3).join('；')}${more}`);
  }

  // ═══════════════════════════════════════════════════
  //  分片
  // ═══════════════════════════════════════════════════

  /**
   * 分片區塊。
   *
   * ── 為什麼一定要顯示「目前幾片」──────────────────────
   * 因為**標一條邊通常什麼都不會發生**。實測：60×45×40 的方塊標 1 條邊，
   * 片數仍然是 1 —— 要切到足以把面的鄰接關係切斷才會多一片。
   *
   * 這在數學上完全正確，但使用者標了一條邊、畫面毫無反應，第一個念頭
   * 一定是「壞了」。而「讓人不敢相信工具給的東西」是這個專案踩過最多次
   * 的坑（第 5、18 條）。所以片數必須即時看得到。
   *
   * ── 顯示的是「片數」不是「張數」──────────────────────
   * 展開引擎會把一樣的片合併成一張圖加一個 qty（「12 支一樣的橫料出
   * 一張圖 ×12」）。所以 pieces.length 是張數，stats.total 才是片數。
   * 壓克力方塊：張數 3、片數 6。這裡顯示 stats.total ——
   * 顯示 3 而實際要切 6 片，是「正確的數字，錯誤的意思」。
   */
  /**
   * 編輯模式：面板顯示「現在選到什麼」。
   *
   * ⚠ **這不是裝飾。** toast 只講一次就消失了，而使用者拉到一半想確認
   * 「我剛剛選的到底是哪個」時，畫面上只剩一條黃線與三支箭頭 ——
   * 那分辨得出「選到的是邊還是面的外框」嗎？分辨不出。
   *
   * 座標如實列出來的理由跟「均分」那排空隙數字一樣：
   * **使用者不必相信程式，看數字就好**（坑第 24 條：可用的前提是驗得出來）。
   */
  _editBox() {
    const sel = this.app.sel;
    const FN = { auto: '自動', vertex: '點', edge: '邊', face: '面' };
    this.form.appendChild(head('編輯造型'));

    const el = sel.editSel;
    if (!el) {
      this.form.appendChild(note(
        `現在只選「${FN[sel.editFilter]}」。點物件上的一個元素，`
        + '箭頭會掛到它身上，拖它就是拉它。'
        + '要一次選好幾個就開「加選」（或按住 Shift）。'
      ));
      return;
    }

    const mesh = el.obj.mesh();
    const many = sel.editCount > 1;
    // 頂點數一律算**整份選取**的聯集 —— 相鄰的面共用頂點，
    // 「3 個面」不等於「3×4 個頂點」，而使用者最容易在這裡誤會
    const n = elementVerts(mesh, sel.editSels).length;

    /**
     * 🔴 **量測一律走 `measureSelection()`，而且它算的是世界座標。**
     *
     * ⚠ **這裡原本印的是網格自己的座標**（`elementCenter()` 沒乘矩陣）——
     * 物件一被搬動或旋轉，這個數字就跟「切一刀」「對齊」「貼合」
     * 「剖面分切」**對不起來**，而畫面上完全看不出來（坑第 20 條）。
     * kang 2026-08-25 為切一刀拍板的那條在這裡一樣適用：
     * **座標是空間裡的實際位置。**
     *
     * ⛔ 不要在這裡自己算長度或面積 —— 那支是純函式而且測得到（1606 項裡
     * 有一整節），這裡只負責畫。
     */
    const ms = measureSelection(mesh, sel.editSels, el.obj.matrix(), sel.editPivot);
    const c = ms ? ms.center : elementCenter(mesh, sel.editSels, 0.5, sel.editPivot);
    const f = v => fmtCm(v);

    const one = el.kind === 'vertex' ? '一個點'
      : el.kind === 'edge' ? '一條邊（2 個頂點）'
      // 「面」是共面區域不是三角形，這是使用者最容易誤會的一點，要講清楚
      : `一個面（共面區域，${n} 個頂點）`;
    const what = many
      ? `${sel.editCount} 個${FN[el.kind]}（共 ${n} 個頂點）`
      : one;

    const box = document.createElement('div');
    box.className = 'note';
    /**
     * 多選時一定要寫出**中心是哪一種** —— 「重心」與「最後選的」
     * 差別很具體（它決定縮放時東西往哪邊收），而畫面上只看得到
     * 一組箭頭，看不出程式用的是哪一個。
     */
    /**
     * 尺寸那一行 —— **kang 2026-08-25 要的東西就是這一行**：
     * 「轉換成編輯網格後，就無法正確知道真實尺寸，只有座標」。
     *
     * ⚠ **哪些量有意義是 `measureSelection()` 決定的**，這裡只管畫。
     * 例如多選面時 `perimeter` 是 `null`（共用的邊會被算兩次，
     * 那個數字沒有人驗得出來），⛔ 不要在這裡補一個湊數的。
     */
    const dim = [];
    if (ms) {
      if (ms.length !== null) {
        dim.push(`${many ? '總長' : '長度'} <b>${f(ms.length)}</b> cm`);
      }
      if (ms.area !== null) {
        dim.push(`${many ? '總面積' : '面積'} <b>${f(ms.area)}</b> cm²`);
      }
      if (ms.perimeter !== null) dim.push(`周長 <b>${f(ms.perimeter)}</b> cm`);
      if (ms.holes) dim.push(`<span class="dim2">（這個面上有 ${ms.holes} 個洞，周長只算外緣）</span>`);
      if (many) {
        dim.push(`外框 <b>${f(ms.size.x)}</b> × <b>${f(ms.size.y)}</b> × <b>${f(ms.size.z)}</b> cm`);
      }
    }

    box.innerHTML = `選到 <b>${what}</b>，在「${el.obj.name}」上<br>`
      + (dim.length ? dim.join('　') + '<br>' : '')
      /**
       * ②-11：這個點是頂點的平均，⛔ 叫「重心」；只選一個點就是它自己 ⇒「座標」
       * （三種說法都跟左下角讀數一樣，見 `measure.js`）
       */
      + `${!many && el.kind === 'vertex' ? '座標'
        : sel.editPivot === 'bounds' ? '中心（外框中心）'
        : many && sel.editPivot === 'active' ? '中心（最後選的）' : '中心（點的平均）'} `
      + `X <b>${f(c.x)}</b>　Y <b>${f(c.y)}</b>　Z <b>${f(c.z)}</b> cm`
      + (many ? '<br><span class="dim2">橘色的那個是最後選的（active）——'
              + '法向的扭轉方向與「最後選的」中心都看它</span>' : '');
    this.form.appendChild(box);

    /**
     * 形狀進了某些「要知道」的狀態就講出來 —— **只提醒不擋，而且不用紅色**。
     *
     * 紅色只留給「程式做不到你要求的事」（坑第 28 條）。這兩種都是
     * **使用者自己拉出來的結果**，他明確做的事被打紅叉，紅色就失去意義了。
     */
    const deg = degenerateFaces(mesh);
    if (deg.length) {
      this.form.appendChild(note(
        /** ⚠ 2026-10-19（補測：`實驗-綜合評估.md` ②-17）⛔ 猜原因 —— 這裡只知道有幾個面壓扁了，⛔ 知道是怎麼壓扁的 */
        `${deg.length} 個面被壓扁成沒有面積（點都擠在同一條線或同一點上）。`
        + '資料沒壞，把那些點拉開或按 Ctrl+Z 就恢復。'
      ));
    }
    const np = nonPlanarFaces(mesh);
    if (np.length) {
      const worst = np.reduce((a, b) => (a.dev > b.dev ? a : b));
      this.form.appendChild(note(
        `${np.length} 個面不再是平的（最大偏離 ${f(worst.dev)} cm）。`
        + '展開會從精確變成近似；剖面分切與 3D 列印不受影響。'
        + '要保持平面就整個面一起拉 —— 一整片平移不會歪，'
        + '只動一個點或一條邊才會。'
      ));
    }
  }

  _seamBox(obj) {
    this.form.appendChild(head('分片'));

    const why = seamBlockReason(obj);
    if (why) {
      this.form.appendChild(bad(why));
      return;
    }

    const mesh = obj.mesh();
    const n = seamCount(mesh);
    const total = markableEdges(mesh).length;

    /**
     * 展開一次拿片數。128 段圓柱展開只要 2ms，所以即時算不會卡；
     * 真的算不出來也不能讓面板整個爆掉 —— 面板是使用者唯一的回饋管道。
     */
    let pieces = null;
    try {
      pieces = unfoldObject(obj, {}).stats.total;
    } catch (e) {
      pieces = null;
    }

    /**
     * 🔴 縫與開口分開數（2026-10-12）：3D 上兩種顏色，這裡也要對得起來
     * （鐵律三：讓兩個數字互相對得起來）。⚠ 只在有開口時才多講 —— 原本的用法一個字都不變。
     */
    const darts = n ? seamKinds(mesh).darts.length : 0;
    const keeps = keepCount(mesh);

    const box = document.createElement('div');
    box.className = 'note';
    box.innerHTML = (pieces === null
      ? `已標記 <b>${n}</b> / ${total} 條邊　（片數算不出來）`
      : `展開後 <b>${pieces}</b> 片　已標記 <b>${n}</b> / ${total} 條邊`)
      + (darts ? `<br>其中 <b>${darts}</b> 條是<b>開口</b>（切進去、沒有把片分開 —— 3D 上另一個顏色）` : '')
      + (keeps ? `<br>不准切 <b>${keeps}</b> 條（藍色）` : '');
    this.form.appendChild(box);

    /**
     * 🔴 **點下去是：標縫／選面**（2026-10-21，分片成群第二件，kang「同意你的建議與安排」）。
     * ⭐ 預設「標縫」＝ 原本的用法一格都沒變；「選面」＝ 選一群面、切成一片（`_groupBox()`）。
     */
    const g = this.app.getGroupState ? this.app.getGroupState(obj) : null;
    if (g) {
      this._rowSelect('點下去是', g.kind, [
        ['seam', '標縫（點稜線／點面的中央）'],
        ['group', '選面（選一群面、切成一片）']
      ], v => { this.app.setSeamPickKind(v); this.refresh(); },
      '標縫：一條一條標、或點面的中央整圈切開（原本的用法）。'
      + '選面：在 3D 上點面選一群（黃色），右邊馬上講這一群攤開會不會疊，滿意了按「切成一片」—— 外圈自動標縫');
    }

    if (g && g.kind === 'group') {
      this._groupBox(obj, g);
    } else {
      this.form.appendChild(note(
        '點稜線＝從那裡切開／取消；點面的中央＝把那個面整圈切開。'
        + '標了片數沒變是正常的 —— 要切到能把面分開才會多一片。'
      ));

      /**
       * 🔴 **點一條稜線時標多少**（2026-10-09，kang 拍板「兩種都要」）。
       * 打版（圓環、球切成一瓣一瓣）原本要點幾百下；「連同方向的全部」點 1 下。
       * ⭐ 預設「只標那一條」＝ 原本的用法。⚠ 走的是四邊形的格子 —— 三角形的地方會停。
       */
      if (this.app.getSeamLineMode) {
        /** ⭐ 「標一段」（2026-10-12，kang 拍板）：省道打版的開口 —— 從縫切進去、停在片中間 */
        this._rowSelect('點一條稜線時', this.app.getSeamLineMode(), [
          ['edge', '只標那一條'],
          ['loop', '標一整圈'],
          ['all', '連同方向的全部一起標'],
          ['span', '標一段（先點起點、再點終點）']
        ], v => { this.app.setSeamLineMode(v); this.refresh(); },
        '一整圈：沿著那條線走到底（繞一圈或走到頭）。'
        + '同方向的全部：跟它平行的每一圈都一起標 —— 圓環、球切成一瓣一瓣用這個。'
        + '標一段：先點起點那條邊（黃色），再點同一條線上要停的那條邊，中間整段一次標 —— 省道打版的開口用這個');
      }

      /**
       * 🔴 **「標成：切開／不准切」**（2026-10-13，智慧分切第一步；kang 選「面板上切換」）。
       * 上面「點一條稜線時」四種點法都跟著它走。⭐ 預設「切開」＝ 原本的用法一格都沒變。
       */
      if (this.app.getSeamMarkKind) {
        this._rowSelect('標成', this.app.getSeamMarkKind(), [
          ['cut', '切開（橘色）'],
          ['keep', '不准切（藍色）']
        ], v => { this.app.setSeamMarkKind(v); this.refresh(); },
        '不准切：這條邊要保持連著 —— 程式自己補剪、智慧分切提案都會繞開它。'
        + '⚠ 真的非切不可時（折不起來的材料、繞一圈的筒子一定要剪一刀）照樣切開，展開圖上會講幾條');
      }
    }

    if (n > 0 || keeps > 0) {
      const parts = [n ? `切開 ${n} 條` : '', keeps ? `不准切 ${keeps} 條` : ''].filter(Boolean).join('、');
      this._rowBtn(`清除全部標記（${parts}）`,
        '回到自動判斷。取消標記是把決定交還給材料規則，不是強迫它折起來', () => {
          /** ⑤-12（2026-10-20）：一條一條標的東西一下就沒了 ⇒ 先問一句（T8）*/
          if (!confirm(`會清掉全部的標記（${parts}）、回到自動判斷（要反悔可以馬上按 Ctrl+Z），確定嗎？`)) return;
          clearSeams(obj.mesh());
          clearKeeps(obj.mesh());
          this.app.view.markSeamsDirty();
          this._edit('清除分片標記');
        });
    }

    this._seamProposalBox(obj);
    this._seamPreview(obj);
  }

  /**
   * 🔴 **選一群面、切成一片**（2026-10-21，分片成群第二件；操作照 `樣板-分片地圖.html`）。
   * 狀態與動作在 `main.js`（`getGroupState()`…），計算在 `unfold/group.js`；這裡只講現況、給選法與兩個數字。
   * ⭐ 兩個數字都有預設（往外長 30°、碎面 1 mm²），可以改、記在瀏覽器裡（kang「穩定、有預設、也能彈性調整」）。
   */
  _groupBox(obj, g) {
    this.form.appendChild(head('分一片（選一群面）'));
    this._rowSelect('選法', g.method, [
      ['face', '點面：加進來／再點拿掉'],
      ['piece', '選起整片（被縫圍起來的那一片）'],
      ['grow', '往外長（相連、朝向差不多的一起選）']
    ], v => { this.app.setGroupOpt({ method: v }); this.refresh(); },
    '點面：一塊一塊加，點到選過的就拿掉。'
    + '選起整片：點一下 ⇒ 換成那一整片（要改已經分好的片：先選起來、再加減面、再切一次）。'
    + '往外長：從點的那塊面開始，相連、朝向跟它差不多的一起加進來（碰到縫、或轉折比下面的角度大就停）');
    if (g.method === 'grow') {
      this._rowNum('往外長：朝向差（度）', g.deg, { min: 1, max: 179, step: 5 },
        v => { this.app.setGroupOpt({ deg: v }); this.refresh(); },
        `預設 30°。小一點 ⇒ 只長到很平的那一片；大一點 ⇒ 連轉折大的也長過去（容易攤開會疊）`);
    }
    this._rowNum('碎面：小於（mm²）', g.tiny, { min: 0, max: 1000, step: 0.5 },
      v => { this.app.setGroupOpt({ tiny: v }); this.refresh(); },
      '預設 1 mm²。比這個小的面（錐體尖端、布林留下的細縫）不用自己選，會跟著旁邊共用邊最長的那一片走。填 0 ⇒ 不處理');

    const box = document.createElement('div');
    box.className = 'note';
    if (!g.count) {
      box.innerHTML = '還沒有選 —— 在 3D 上點面（黃色＝選到的）';
    } else {
      let t = `選了 <b>${g.count}</b> 塊面（${g.faces} 個網格面）`;
      if (g.tinyAdd) t += `，另有 <b>${g.tinyAdd}</b> 塊碎面跟著走`;
      if (g.comps > 1) t += `<br>⚠ 選的面沒有連在一起（分成 ${g.comps} 塊）—— 切下去會變 ${g.comps} 片`;
      if (g.check) {
        t += g.check.overlap
          ? `<br>✗ 這一群攤開<b>會疊</b>：${g.check.overlap} 個面（3D 上紅色）—— 拿掉紅色附近的面再試`
          : '<br>✓ 這一群攤得平、不會疊';
      }
      box.innerHTML = t;
    }
    this.form.appendChild(box);
    if (g.count) {
      this._rowBtn('切成一片', '外圈標縫、裡面原本的縫拿掉；標了「不准切」的邊不動（會講幾條）。要反悔按 Ctrl+Z', () => this.app.groupCut());
      this._rowBtn('取消選取', '黃色收起來，什麼都不改', () => this.app.groupClear());
    }
  }

  /**
   * 🔴 **智慧分切：提案**（2026-10-13，第一步 → `規格\建模器-智慧分切.md`）。
   * 提案的內容在 `unfold/propose.js`、狀態在 `main.js`（物件＋網格＋標記指紋，對不上就收起來）。
   * 面板只負責講：幾條、幾片、最大一片、放不放得進板子；還放不進的要講是哪一種（一整個曲面／一大片平面），⛔ 只講「放不進」。
   */
  _seamProposalBox(obj) {
    if (!this.app.proposeSeams) return;
    this.form.appendChild(head('智慧分切'));
    /**
     * 🔴 **三個設定**（2026-10-21，分片成群第三件，kang 定案 → `分片成群-設計方向.md` 第 8 節）。
     * ⭐ 預設：片裡不要細切口、張開小於 30° 算細、凹處尖角先切；改了而且正在看提案 ⇒ 馬上照新的重新提案。
     */
    if (this.app.getProposeOpt) {
      const po = this.app.getProposeOpt();
      this._rowSelect('片裡的切口', po.slits, [
        ['none', '不要細切口（片多一點）'],
        ['allow', '片少一點（允許細切口）']
      ], v => this.app.setProposeOpt({ slits: v }),
      '細切口 ＝ 切線走到片中間就停、攤開只張開一點點的 V 形切口 —— 組裝時要對準黏回去，很費工。'
      + '方塊攤成十字形那種外框的切線不算。'
      + '「片少一點」：允許細切口，片會少一兩片');
      /** ⚠ 「片少一點」時也顯示：提案照樣用這個角度數細切口給你看（藏起來的話面板寫「小於 30°」卻改不到）*/
      this._rowNum('細切口：張開小於（度）', po.notchDeg, { min: 0, max: 180, step: 5 },
        v => this.app.setProposeOpt({ notchDeg: v }),
        '預設 30°。V 形切口攤開張開的角度比這個小，就算細切口 —— 「不要細切口」時提案會避開它；改大 ⇒ 避開得多、片也多');
      this._rowSelect('切的先後', po.cutOrder, [
        ['feature', '凹處、尖角先切'],
        ['fewest', '片數最少']
      ], v => this.app.setProposeOpt({ cutOrder: v }),
      '凹處、尖角先切：平的、長的邊先接起來，凹進去的地方（眼窩、嘴巴）跟尖的轉角最後才接 ⇒ 縫多半落在凹處與轉角（Blender 紙模外掛預設也是這樣）。'
      + '片數最少：共用邊長的先接，片會少一兩片，但縫可能斜斜地跨過臉');
    }
    const cur = this.app.getSeamProposal(obj);
    if (cur && cur.stale) this.form.appendChild(note('標記改了，提案收起來了 —— 要再按一次「提案」'));
    const p = cur && cur.proposal;
    this._rowBtn(p ? '重新提案' : '智慧分切：提案',
      '程式照判準建議要從哪裡切開（青色虛線），你看過再決定接受、刪掉幾條、或取消。'
      + '沿轉角切、切到每片都放得進板子（照排版設定），片盡量少、縫盡量短；會繞開「不准切」。'
      + '一圈一圈的曲面（球、圓環…）會試花瓣、長條、環帶，挑切口最整齊的',
      () => this.app.proposeSeams(obj));
    if (!p) return;

    const b = p.board, fmt1 = v => String(Math.round(v * 10) / 10);
    const boardTxt = `${fmt1(b.w)}×${fmt1(b.h)}`;
    const cond = `照排版設定：間距 ${fmt1(b.gap)}、${b.rotate ? '可以轉 90°' : '不轉 90°'}`;
    const red = t => `<span style="color:#c0392b">${t}</span>`;
    /**
     * 還放不進的，**講是哪一種、為什麼**（第二步規格第 2 節；⛔ 只講「放不進」）。
     * 「第一版還不會為了板子多切」那句第二步拿掉了（兩個括號連在一起的那句也就沒了）。
     */
    const fitLines = [];
    if (!p.big) fitLines.push(`全部放得進 ${boardTxt} 板子（${cond}）`);
    else {
      if (p.bigCurved) fitLines.push(red(`有 <b>${p.bigCurved}</b> 片是一整個曲面、沒有轉角可以切，放不進`) + (p.nonGrid ? '' : ' —— 要換大板，或自己標縫切開'));
      if (p.bigFlat) fitLines.push(red(`有 <b>${p.bigFlat}</b> 片本身就是一個比板子大的平面`) + ' —— 要換大板，或自己標縫切開');
      const rest = p.big - p.bigCurved - p.bigFlat;
      if (rest > 0) fitLines.push(red(`有 <b>${rest}</b> 片放不進 ${boardTxt} 板子`) + `（${cond}）`);
    }
    if (p.overlap) fitLines.push(red('提案的片還有重疊') + (p.nonGrid ? '' : ' —— 自己標縫切開'));
    /** 細切口（第三件）：花瓣的 V 形切口是設計（沿經線切到極點附近），⛔ 講成問題 */
    if (p.edges.length && p.kind !== 'petal') {
      fitLines.push(p.notch
        ? `細切口 <b>${p.notch}</b> 個（攤開張開小於 ${fmt1(p.notchDeg)}° 的 V 形切口）` + (p.slits === 'none' ? ' —— 避不開的' : '')
        : '沒有細切口');
    }
    // 不是格子的曲面：只在結果還有問題時講（圓錐那種照沿轉角切就好好的，⛔ 多嘴）
    if (p.nonGrid && (p.big || p.overlap)) fitLines.push('這塊曲面不是一圈一圈的格子，還不會整齊地切 —— 照沿轉角的切法提案');
    if (p.timedOut) fitLines.push('算到 2 秒先交出目前最好的');
    const box = document.createElement('div');
    box.className = 'note';
    const lines = [];
    if (!p.edges.length && !p.removed) {
      lines.push('已經攤得開，沒有要補的縫。');
    } else {
      // 有曲面可以挑切法時才寫是哪一種（只有平面的物件⛔ 寫）
      const kind = p.options && p.options.length > 1 ? `<b>${p.label}</b>，` : '';
      lines.push(`提案 <b>${p.edges.length}</b> 條縫（青色虛線）：${kind}展開後 <b>${p.total}</b> 片`
        + (p.maxPiece ? `，最大一片 ${fmt1(p.maxPiece.w)}×${fmt1(p.maxPiece.h)}` : ''));
    }
    lines.push(...fitLines);
    if (p.removed) lines.push(`你拿掉了 ${p.removed} 條 —— 接受後展開時，程式會自己再補剪（橘色）；上面的片數是拿掉之前的`);
    if (p.keepCut) lines.push(`有 ${p.keepCut} 條「不准切」非切不可，照樣會切開`);
    if (p.unmarkable) lines.push(`有 ${p.unmarkable} 條在平面中間、標不上縫 —— 接受時會跳過`);
    if (p.dartMode) lines.push('提案用精確分片算（不能拉的材料）');
    box.innerHTML = lines.join('<br>');
    this.form.appendChild(box);
    if (p.edges.length) {
      this._rowBtn(`全部接受（${p.edges.length} 條）`, '提案的縫全部變成你標的切開（橘色）。一次復原就全部退回',
        () => this.app.acceptSeamProposal());
    }
    this._rowBtn('取消提案', '青色虛線收起來，什麼都不改', () => this.app.cancelSeamProposal());
    this.form.appendChild(note('點一條青色虛線 ＝ 從提案裡拿掉它。'));

    /** 其他切法（第三步規格第 2 節）：每一種一顆按鈕，點了就換成那一份（3D 上的青色虛線跟著換）*/
    const opts = p.options || [];
    if (opts.length > 1) {
      this.form.appendChild(note('其他切法（點一下就換成那一種）：'));
      opts.forEach((o, i) => {
        if (i === p.active) return;
        const bad = [o.big ? `${o.big} 片放不進` : '', o.overlap ? '有重疊' : ''].filter(Boolean).join('、');
        this._rowBtn(`${o.label}：${o.total} 片${bad ? `（${bad}）` : ''}`,
          `換成「${o.label}」：${o.edges.length} 條縫、縫總長 ${Math.round(o.cutLen)}${i === 0 ? '（這是程式最推薦的）' : ''}`,
          () => this.app.useSeamAlternative(i));
      });
    }
  }

  /**
   * 🔴 **分片模式的即時預覽**（2026-10-12，省道打版第三步；位置是 kang 選的方案一 → `規格\建模器-省道打版.md`）。
   *
   * - **開關**（kang：「是否可以做一個開/關..這樣就可以做一個彈性的選擇」）：預設開，記在瀏覽器裡
   * - **停手一下才算**（0.3 秒）：連點好幾條線不會每一下都算；算的時候寫「計算中…」
   * - **跟著展開圖視窗目前選的**展開方式、材料、開口畫法（`app.getUnfoldSettings()`）
   * - 結果照「物件＋網格＋哪幾條是切線＋展開方式＋材料」記一份：面板重畫（選取、捲動…）⛔ 重算
   * - 算一次超過 1 秒 ⇒ 講出來，提醒可以關掉（⛔ 安靜地卡）
   *
   * ⚠ 面板每次 `refresh()` 都整個重建，所以計時器到點時要先看畫布還在不在（⛔ 畫到一個已經被丟掉的畫布上）。
   */
  _seamPreview(obj) {
    if (!this.app.getUnfoldSettings) return;
    const on = seamPreviewOn();
    this._rowCheck('即時預覽', on, v => {
      try { localStorage.setItem(SEAM_PREVIEW_KEY, v ? 'on' : 'off'); } catch (e) { /* 無所謂 */ }
      this.refresh();
    }, '標一條線，下面馬上畫出展開的樣子（跟著展開圖視窗目前選的展開方式）。模型大、覺得頓就關掉');
    if (!on) return;
    const mapOn = seamMapOn();
    this._rowCheck('分片地圖（每一片一個顏色）', mapOn, v => {
      try { localStorage.setItem(SEAM_MAP_KEY, v ? 'on' : 'off'); } catch (e) { /* 無所謂 */ }
      this.refresh();
    }, '3D 上每一片塗一個顏色、預覽裡同一片同一個顏色 —— 看得出哪裡已經分好、哪一片很大。跟著即時預覽一起算');

    const st = this.app.getUnfoldSettings();
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin:4px 0 8px';
    const info = document.createElement('div');
    info.className = 'note';
    const cv = document.createElement('canvas');
    cv.style.cssText = 'display:block;width:100%;background:#fff;border-radius:4px;margin:4px 0';
    const big = document.createElement('button');
    big.className = 'wide';
    big.textContent = '放大 ⤢（打開展開圖）';
    big.title = '打開展開圖視窗 —— 存 SVG／DXF、列印都在那裡';
    big.onclick = () => this.app.openUnfold();
    wrap.append(info, cv, big);
    this._target.appendChild(wrap);

    const modeLabel = st.mode === 'dart' ? '省道打版' : '精確分片';
    const draw = pv => {
      const r = pv.r;
      const colOf = p => PIECE_PAL[r.pieces.indexOf(p) % PIECE_PAL.length];
      const prog = previewProgram(r.pieces, {
        rule: r.rule, strainFill: true, dartStyle: st.dartStyle, dartFolds: st.dartFolds,
        pieceFill: mapOn ? colOf : null
      });
      let txt = `預覽（${modeLabel}）：<b>${r.stats.total}</b> 片`;
      if (st.mode === 'dart' && r.pieces.length) {
        const mx = Math.max(...r.pieces.map(p => p.strain ? p.strain.max : 0));
        const mn = Math.min(...r.pieces.map(p => p.strain ? p.strain.min : 0));
        txt += `　最多拉 <b>${fmtPct(mx)}</b>　壓 <b>${fmtPct(-mn)}</b>`;
      }
      if (r.warnings.length) txt += `<br>⚠ ${r.warnings.length} 則警告 —— 放大看`;
      /**
       * 🔴 疊在一起的面：預覽與 3D 都標紅、講是哪幾片幾個面（2026-10-21，`分片成群-設計方向.md` 第一件）。
       * ⭐ 點預覽裡的一片 ⇒ 3D 上把那一片的面標紫（再點同一片 ⇒ 收起來；點空白 ⇒ 收起來）。
       */
      const ovP = r.pieces.filter(p => p.overlapFaces && p.overlapFaces.length);
      const no = p => p.no || 'P' + String(r.pieces.indexOf(p) + 1).padStart(2, '0');
      if (ovP.length) {
        txt += `<br>🔴 ${ovP.map(p => `${no(p)} 有 ${p.overlapFaces.length} 個面${p.overlapMore ? '以上' : ''}`).join('、')}疊在一起 —— 預覽與 3D 上標紅，在那附近切開`;
      }
      if (r.pieces.length) txt += '<br>點預覽裡的一片 ⇒ 3D 上標出那一片（紫）';
      if (pv.ms > 1000) txt += `<br>算一次要 ${(pv.ms / 1000).toFixed(1)} 秒 —— 覺得慢可以關掉即時預覽`;
      info.innerHTML = txt;
      const view = this.app.view;
      if (view && view.setFaceMarks) {
        view.setFaceMarks('overlap', ovP.flatMap(p => pieceWorldPolys(p, p.overlapFaces)));
        if (this._pvPick && !r.pieces.includes(this._pvPick)) this._pvPick = null;
        view.setFaceMarks('piece', this._pvPick ? pieceWorldPolys(this._pvPick) : null);
        /** 分片地圖：每一片的面塗那一片的顏色（看深度 —— 跟紅、紫、黃那幾層不一樣，見 `setFaceMarks()`）*/
        if (mapOn) {
          const polys = [], cols = [];
          for (const p of r.pieces) for (const poly of pieceWorldPolys(p)) { polys.push(poly); cols.push(colOf(p)); }
          view.setFaceMarks('map', polys, cols);
        } else view.setFaceMarks('map', null);
      }
      if (!prog) { cv.hidden = true; return; }
      const W = Math.max(200, cv.clientWidth || 270), H = Math.min(260, Math.max(120, W * prog.box.h / prog.box.w));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.ceil(W * dpr); cv.height = Math.ceil(H * dpr);
      cv.style.height = H + 'px';
      const ctx = cv.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      const px = Math.min(W / prog.box.w, H / prog.box.h);
      const ox = (W - prog.box.w * px) / 2, oy = (H - prog.box.h * px) / 2;
      ctx.translate(ox, oy);
      renderCanvas(ctx, prog, px);
      /** 點一片 ⇒ 3D 上標紫；畫布座標 → 預覽的 cm（`renderCanvas()` 的反算：X ＝ (x − box.x)·px、Y ＝ (box.y + box.h − y)·px）*/
      cv.style.cursor = 'pointer';
      cv.onclick = ev => {
        const rc = cv.getBoundingClientRect();
        const x = (ev.clientX - rc.left - ox) / px + prog.box.x;
        const y = prog.box.y + prog.box.h - (ev.clientY - rc.top - oy) / px;
        const hit = pieceAt(prog, x, y);
        const same = hit && hit === this._pvPick;
        this._pvPick = same ? null : hit;
        if (view && view.setFaceMarks) view.setFaceMarks('piece', this._pvPick ? pieceWorldPolys(this._pvPick) : null);
        if (this._pvPick) {
          this.app.toast(`${no(this._pvPick)}：${this._pvPick.faces.length} 個面 —— 3D 上標紫了（再點一次收起來）`);
        } else if (same) {
          this.app.toast(`${no(hit)}：紫色收起來了`);
        } else if (!hit) {
          this.app.toast('沒有點到任何一片 —— 點在片的線框裡面');
        }
      };
    };

    const key = seamPreviewKey(obj, st);
    if (this._pv && this._pv.key === key) { draw(this._pv); return; }
    info.textContent = `預覽（${modeLabel}）：計算中…`;
    clearTimeout(this._pvTimer);
    this._pvTimer = setTimeout(() => {
      if (!cv.isConnected) return;                 // 面板已經重建 —— 新的那一次自己會排
      const t0 = performance.now();
      let r;
      try { r = unfoldObject(obj, { material: st.material, mode: st.mode }); }
      catch (e) { info.textContent = '預覽算不出來：' + (e.message || e); return; }
      this._pv = { key, r, ms: performance.now() - t0 };
      draw(this._pv);
    }, 300);
  }

  /** 布林與陣列共用的「凍結成網格」 */
  _freezeBtn(obj, whatYouLose) {
    this._rowBtn('凍結成網格',
      '把目前算出來的形狀固定下來。之後開檔不用再算一次（快很多），' +
      `但就不能再回頭改${whatYouLose}了。確定不會再改的模型才凍結。`, () => {
        if (!confirm(`凍結之後就不能再改${whatYouLose}了，確定嗎？`)) return;
        obj.bake();
        this._edit('凍結成網格');
      });
  }

  // ═══════════════════════════════════════════════════
  //  布林運算樹
  // ═══════════════════════════════════════════════════

  /**
   * 顯示「這個形狀是怎麼算出來的」，並讓每個運算元都能就地改參數。
   *
   * 這是「存運算樹而不是存三角形」真正的價值所在 ——
   * 挖完孔之後老闆說孔要改大，在這裡把半徑一改就好，不必重做。
   */
  _boolSection(obj) {
    const src = obj.src;
    this.form.appendChild(head('布林運算'));

    const wrap = document.createElement('div');
    wrap.className = 'tree';
    this.form.appendChild(wrap);

    // 運算方式可以事後改：挖錯了想改成合併，不用重來
    const opRow = document.createElement('div');
    opRow.className = 'op';
    const lab = document.createElement('label');
    lab.textContent = '運算方式';
    lab.title = '差集＝從第一個挖掉其餘的；聯集＝合成一個；交集＝只留重疊處';
    const sel = document.createElement('select');
    for (const v of [BOOL_OPS.SUBTRACT, BOOL_OPS.UNION, BOOL_OPS.INTERSECT]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = `${BOOL_SYMBOL[v]}　${BOOL_LABEL[v]}`;
      if (v === src.op) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      src.op = sel.value;
      this._rebuild(obj, '改成' + BOOL_LABEL[sel.value]);
    };
    opRow.append(lab, sel);
    wrap.appendChild(opRow);

    this._boolItems(obj, src, wrap, String(obj.id));
  }

  /**
   * 列出一層的運算元。第一個是母體，其餘掛上運算符號。
   *
   * @param {string} path 展開狀態的記憶用鍵，形如 "12:0:1"
   */
  _boolItems(obj, node, parent, path) {
    const items = node.items || [];
    items.forEach((it, i) => {
      this._itemBox(obj, it, parent, `${path}:${i}`, {
        symbol: i === 0 ? '' : (BOOL_SYMBOL[node.op] || '?'),
        fallbackName: `運算元 ${i + 1}`,
        posHint: i === 0 ? '這是母體，位置固定在原點' : '相對於母體的位置'
      });
    });
  }

  // ═══════════════════════════════════════════════════
  //  折板的折彎序列
  // ═══════════════════════════════════════════════════

  /**
   * 一道折彎 ＝ 轉幾度、內圓角多大、轉完之後再走多長。
   * 想折幾道就加幾道：一道是 L 型，兩道同向是 U 型，
   * 兩道一正一負是 Z 型。
   */
  _bendList(obj) {
    const src = obj.src;
    if (!Array.isArray(src.bends)) src.bends = [defaultBend()];

    this.form.appendChild(head('折彎序列'));

    // 展開總長是這個功能最關鍵的產出：下料要照這個長度剪
    const t = obj.thickness || 0;
    const dev = document.createElement('div');
    dev.className = 'note';
    dev.title = '沿中性層量的總長度，用真正的弧長算（不是網格上的直線段）。'
      + '這就是下料要剪的長度';
    dev.textContent = `展開總長 ${round(bendDevelopedLength(src, t))} cm`
      + `　板寬 ${round(src.w)} cm　板厚 ${round(t)} cm　K ${round(src.k ?? 0.4)}`;
    this.form.appendChild(dev);

    const wrap = document.createElement('div');
    wrap.className = 'tree';
    this.form.appendChild(wrap);

    const prev = this._target;

    src.bends.forEach((b, i) => {
      const box = document.createElement('div');
      box.className = 'item';

      const headEl = document.createElement('div');
      headEl.className = 'itemHead';
      const sym = document.createElement('span');
      sym.className = 'sym';
      sym.textContent = String(i + 1);
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = `第 ${i + 1} 道`;
      const dims = document.createElement('span');
      dims.className = 'dims';
      dims.textContent = `${round(b.angle)}° R${round(b.ri)} → ${round(b.len)}`;
      headEl.append(sym, nm, dims);
      box.appendChild(headEl);

      const body = document.createElement('div');
      body.className = 'itemBody';
      box.appendChild(body);
      this._target = body;

      this._rowNum('角度 度', b.angle, { step: 15 }, v => {
        b.angle = v; this._rebuild(obj, '改折彎角度');
      }, '正負決定往哪邊折。兩道同向＝U 型，一正一負＝Z 型');
      this._rowNum('內側圓角 R', b.ri, { min: 0, step: 0.5 }, v => {
        b.ri = Math.max(0, v); this._rebuild(obj, '改折彎半徑');
      }, '模具的內側圓角，也就是圖面上標的那個 R。填 0 就是不帶圓角的尖角折。'
       + '下料用的中性層半徑由程式算：內側R ＋ K×板厚');
      this._rowNum('之後長度', b.len, { min: 0, step: 1 }, v => {
        b.len = Math.max(0, v); this._rebuild(obj, '改折後長度');
      }, '折完之後那一段的長度');

      // 把「內側R、K、板厚、算出來的展開弧長」四個數字一起攤出來，
      // 才看得出換算是怎麼來的 —— 這是結構分析面板同一套想法。
      const ba = document.createElement('div');
      ba.className = 'note';
      ba.title = '這一道折彎在展開圖上佔的長度：θ ×（內側R ＋ K×板厚）';
      ba.textContent = `這道展開弧長 ${round(bendAllowance(b, src.k ?? 0.4, t))} cm`
        + `　（中性層 R${round(neutralRadius(b.ri, src.k ?? 0.4, t))}）`;
      body.appendChild(ba);

      if (src.bends.length > 1) {
        this._rowBtn('移除這一道', '', () => {
          src.bends.splice(i, 1);
          this._rebuild(obj, '移除一道折彎');
        });
      }

      this._target = prev;
      wrap.appendChild(box);
    });

    this._rowBtn('＋ 加一道折彎', '折在最後面。想折幾道就加幾道', () => {
      src.bends.push(defaultBend());
      this._rebuild(obj, '加一道折彎');
    });
  }

  // ═══════════════════════════════════════════════════
  //  陣列與鏡射
  // ═══════════════════════════════════════════════════

  /**
   * 陣列面板。
   *
   * 特別把「總份數」放在最上面，因為那是這個功能真正的產出 ——
   * 第 3 期展開時會據此出「一張圖 ×N」，而不是 N 張一樣的圖。
   */
  _arraySection(obj) {
    const src = obj.src;
    this.form.appendChild(head('陣列'));

    const wrap = document.createElement('div');
    wrap.className = 'tree';
    this.form.appendChild(wrap);

    // ── 模式 ──
    const opRow = document.createElement('div');
    opRow.className = 'op';
    const lab = document.createElement('label');
    lab.textContent = '排列方式';
    lab.title = '線性＝沿方向等距排開；環形＝繞一個軸轉一圈；鏡射＝對稱複製';
    const sel = document.createElement('select');
    for (const v of [ARRAY_MODES.LINEAR, ARRAY_MODES.RADIAL, ARRAY_MODES.MIRROR]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = ARRAY_LABEL[v];
      if (v === src.mode) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      // withMode 會補上新模式缺少的欄位，已有的（例如份數）保留下來
      obj.src = withMode(src, sel.value);
      this._rebuild(obj, '改成' + ARRAY_LABEL[sel.value]);
    };
    opRow.append(lab, sel);
    wrap.appendChild(opRow);

    const prev = this._target;
    this._target = wrap;

    // ── 總份數 ──
    const total = document.createElement('div');
    total.className = 'note';
    /** ⚠ 鏡射不保留原件時只剩 1 份 ——「其中一份是鏡像」就不通了（2026-10-08 查 bug E8）*/
    total.textContent = `總共 ${obj.copies} 份`
      + (src.mode !== ARRAY_MODES.MIRROR ? ''
        : obj.copies === 1 ? '（只留鏡像那一份，展開圖要翻面）'
        : '（其中一份是鏡像，展開圖要翻面）');
    wrap.appendChild(total);
    /** ③-1：每一份都在同一個位置 ⇒ 講出來、講怎麼排開（以前只寫「總共 8 份」，其實 8 份疊在原地）*/
    if (obj.stacked) wrap.appendChild(bad(stackedHint(src.mode, obj.copies)));
    /**
     * ③-1、③-2（2026-10-19）：新做的陣列方向就是世界的方向（`io.js` `arraySrcFrom()`）；
     * 陣列物件本身轉過或縮放過（舊檔的陣列、或後來整個轉過）⇒ 方向跟著它自己的角度 —— 講一句，⛔ 讓人以為是世界的。
     */
    const turned = Math.abs(obj.rot.x) + Math.abs(obj.rot.y) + Math.abs(obj.rot.z) > 1e-9
      || Math.abs(obj.scale.x - 1) + Math.abs(obj.scale.y - 1) + Math.abs(obj.scale.z - 1) > 1e-9;
    if (turned) {
      wrap.appendChild(note('這個陣列本身轉過角度（或縮放過）：下面的 X／Y／Z 跟著它自己的角度走，不是世界的方向'));
    }

    // ── 各模式的參數 ──
    if (src.mode === ARRAY_MODES.RADIAL) {
      this._rowNum('份數', src.count, { min: 1, step: 1, int: true }, v => {
        src.count = Math.max(1, Math.round(v));
        this._rebuild(obj, '改份數');
      });
      this._rowSelect('繞哪個軸', src.axis || 'y',
        AXES.map(a => [a, a.toUpperCase() + ' 軸']),
        v => { src.axis = v; this._rebuild(obj, '改旋轉軸'); },
        'Y 軸＝像轉盤一樣水平轉；X／Z 軸＝像輪子一樣立著轉');
      this._rowNum('總角度', src.angle, { step: 15 }, v => {
        src.angle = v; this._rebuild(obj, '改總角度');
      }, '360＝繞滿一圈平均分佈；小於 360 時頭尾都會放一份');
      /** ③-1：「相對物件自己」直接寫在名稱上（以前只寫在滑鼠停上去的說明裡）*/
      this._rowArr3('旋轉中心（相對物件）cm', src.center, ['X', 'Y', 'Z'], false,
        () => this._rebuild(obj, '改旋轉中心'),
        '相對於物件自己的原點，不是世界座標。法蘭螺栓孔通常留 0，讓孔繞著中心排；'
        + '要讓一個零件繞成一圈，就把中心移到零件外面（例如 X 打 50 ＝ 繞著右邊 50 cm 那一點轉）');
      /**
       * ④-2 剩下的（2026-10-20）：一鍵把中心放到**世界原點**、或**另一個選到的物件的中心**（外框中間）——
       * 換算在 `io.js` `radialCenterAt()`。⚠ 算一次就定下來，那個物件之後搬走中心⛔ 跟。
       */
      const setCenter = (pt, what) => {
        src.center = radialCenterAt(obj, pt);
        this._rebuild(obj, `旋轉中心改成${what}`);
        if (this.app.toast) {
          this.app.toast(`旋轉中心改成${what}（換成相對物件 ＝ ${src.center.join(', ')}）`
            + '　算一次就定下來：那邊之後搬走，中心不會跟著');
        }
      };
      this._rowBtn('繞世界原點', '把旋轉中心放到世界的原點 (0, 0, 0)：零件繞著畫面正中間那一點排一圈',
        () => setCenter({ x: 0, y: 0, z: 0 }, '世界原點'));
      const others = this.app.sel.objects.filter(o => o !== obj);
      if (others.length === 1) {
        const other = others[0];
        this._rowBtn(`繞「${other.name}」的中心`,
          `把旋轉中心放到「${other.name}」的外框正中間（例如螺栓孔繞著法蘭排）`,
          () => {
            const b = worldBounds(other);
            setCenter({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 },
              `「${other.name}」的中心`);
          });
      } else {
        (this._target || this.form).appendChild(note('要繞另一個物件的中心轉：先點那個物件，再按住 Shift 加選這個陣列（最後選陣列），這裡就會多一顆按鈕'));
      }

    } else if (src.mode === ARRAY_MODES.MIRROR) {
      this._rowSelect('對稱面垂直於', src.axis || 'x',
        AXES.map(a => [a, a.toUpperCase() + ' 軸']),
        v => { src.axis = v; this._rebuild(obj, '改對稱軸'); },
        '選 X 軸＝左右鏡射；選 Z 軸＝前後鏡射');
      this._rowNum('對稱面位置', src.offset, { step: 1 }, v => {
        src.offset = v; this._rebuild(obj, '改對稱面位置');
      }, '相對物件中心的距離。預設放在物件邊緣，所以鏡出來的那份剛好貼著；'
       + '要以機箱中心線對稱，就把這裡改成物件中心到中心線的距離');
      this._rowCheck('保留原件', src.keepOriginal !== false, v => {
        src.keepOriginal = v;
        this._rebuild(obj, v ? '保留原件' : '只留鏡像');
      }, '取消勾選就只留下鏡像的那一份，用在「我要的是另一邊」的時候');

    } else {
      this._rowNum('份數', src.count, { min: 1, step: 1, int: true }, v => {
        src.count = Math.max(1, Math.round(v));
        this._rebuild(obj, '改份數');
      });
      this._rowArr3('間距 cm', src.step, ['X', 'Y', 'Z'], false,
        () => this._rebuild(obj, '改間距'),
        '每一份之間的距離。只想沿 X 排就只填 X');
      this._spanNote(src.count, src.step);

      this._rowNum('第二方向份數', src.count2, { min: 1, step: 1, int: true }, v => {
        src.count2 = Math.max(1, Math.round(v));
        this._rebuild(obj, '改第二方向份數');
      }, '填 1 就是單排。填 4 會變成網格 —— 散熱孔就是這樣排的');
      if ((src.count2 || 1) > 1) {
        this._rowArr3('第二方向間距 cm', src.step2, ['X', 'Y', 'Z'], false,
          () => this._rebuild(obj, '改第二方向間距'));
        this._spanNote(src.count2, src.step2);
      }
    }

    this._target = prev;

    // ── 被複製的東西 ──
    this.form.appendChild(head('複製的內容'));
    const childWrap = document.createElement('div');
    childWrap.className = 'tree';
    this.form.appendChild(childWrap);
    this._itemBox(obj, src.child, childWrap, `${obj.id}:child`, {
      symbol: '⧉',
      fallbackName: '原件',
      posHint: '相對於陣列原點的位置'
    });
  }

  /** 算給人看的總跨距，避免要自己心算「間距 × (份數−1)」 */
  _spanNote(count, step) {
    const n = Math.max(1, Math.round(count || 1)) - 1;
    if (n < 1 || !Array.isArray(step)) return;
    const len = Math.hypot(step[0] * n, step[1] * n, step[2] * n);
    if (len < 1e-9) return;
    const d = document.createElement('div');
    d.className = 'dim';
    d.style.margin = '-2px 0 6px';
    d.textContent = `頭尾總跨距 ${round(len)} cm`;
    (this._target || this.form).appendChild(d);
  }

  // ═══════════════════════════════════════════════════
  //  共用：一個可展開的子項
  // ═══════════════════════════════════════════════════

  /**
   * 布林的運算元、陣列的原件，長相與行為完全一樣，所以共用這一個。
   * 展開後依 src 的種類顯示內容，而且會遞迴 ——
   * 「挖好孔的板子排成一排」這種巢狀結構才能一路改到底。
   */
  _itemBox(obj, item, parent, key, opt = {}) {
    if (!item || !item.src) return;
    const open = this.openItems.has(key);

    const box = document.createElement('div');
    box.className = 'item';

    const headEl = document.createElement('div');
    headEl.className = 'itemHead';

    const sym = document.createElement('span');
    sym.className = 'sym';
    sym.textContent = opt.symbol || '';

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = item.name || opt.fallbackName || '內容';

    const dims = document.createElement('span');
    dims.className = 'dims';
    dims.textContent = describeSrc(item.src);

    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = open ? '▾' : '▸';

    headEl.append(sym, nm, dims, caret);
    headEl.onclick = () => {
      if (open) this.openItems.delete(key); else this.openItems.add(key);
      this.refresh();
    };
    box.appendChild(headEl);

    if (open) {
      const body = document.createElement('div');
      body.className = 'itemBody';
      box.appendChild(body);

      const prev = this._target;
      this._target = body;

      this._srcBody(obj, item.src, body, key);

      this._rowArr3('位置 cm', item.pos, ['X', 'Y', 'Z'], false,
        () => this._rebuild(obj, '改內容位置'), opt.posHint);
      this._rowArr3('旋轉 度', item.rot, ['X', 'Y', 'Z'], true,
        () => this._rebuild(obj, '改內容角度'));

      this._target = prev;
    }

    parent.appendChild(box);
  }

  /** 依 src 的種類把可以改的東西列出來。會遞迴。 */
  _srcBody(obj, src, container, key) {
    if (isBoolSrc(src)) {
      container.appendChild(note(`巢狀布林（${BOOL_LABEL[src.op] || src.op}，`
        + `${(src.items || []).length} 個運算元）`));
      this._boolItems(obj, src, container, key);
      return;
    }

    if (isArraySrc(src)) {
      container.appendChild(note(`巢狀陣列（${ARRAY_LABEL[src.mode] || src.mode}）`));
      this._itemBox(obj, src.child, container, `${key}:child`,
        { symbol: '⧉', fallbackName: '原件' });
      return;
    }

    if (src.type === 'mesh') {
      container.appendChild(note('這個內容已經是網格，沒有參數可以改'));
      return;
    }

    const spec = PRIM_SPECS[src.type];
    if (!spec) return;
    /** ⚠ 巢狀裡面也要照 `labelOf` 換名字，⛔ 不然同一個東西兩個地方兩種叫法 */
    for (const f of spec.fields) {
      const lab = f.labelOf ? f.labelOf(src) : f.label;
      this._rowNum(lab, src[f.key], f, v => {
        src[f.key] = f.int ? Math.round(v) : v;
        this._rebuild(obj, '改' + lab);
      });
    }
    /** ⚠ 巢狀裡面也要畫看得到的說明 —— 跟上面 `labelOf` 那則同一個理由 */
    for (const s of spec.noteOf ? spec.noteOf(src, obj) : []) container.appendChild(note(s));
  }

  /** 運算樹被改過 → 清掉快取重算，然後照一般編輯流程走 */
  _rebuild(obj, label) {
    const was = this._onFloor(obj);
    obj.invalidate();
    this.analysisCache.delete(obj.id);
    this._edit(label);
    this._afterParam(obj, was);
  }

  /**
   * 🔴 **改了參數（尺寸、齒數…）之後，講兩件「位置沒動、但關係變了」的事**（綜合評估 ③-14、③-7，2026-10-19，kang 同意）。
   *
   * ③-14 **原本貼地、改完離地**：參數物件以中心為原點，改高度後底部就跑掉（方塊 h 45 → 90 底部到 −22.5）。
   * ⭐ 照 kang 2026-10-09 的決定**⛔ 自動往上長**（會偷偷改掉對齊、貼合、咬上去擺好的位置，`align.js` `landPositions()`）——
   * 只講一句、請人按「落地」。⚠ 只在「改之前貼地」才講：浮在別的東西上面常常是故意的（面板那句也是這個規則）。
   *
   * ③-7 **齒輪跟咬著的那一個卡在一起**：程式⛔ 記「誰跟誰咬著」（`gearPair.js` 是算一次就擺好）⇒
   * 改齒數或模數後，對方⛔ 會跟、也⛔ 講。⇒ 看同一個高度、平放的其他齒輪：
   * 兩個齒頂圓重疊、而且中心距不等於 m ×（z1 ＋ z2）÷ 2 ⇒ 講出來、指到「咬上去」那顆按鈕。⛔ 記任何關係、⛔ 改存檔。
   */
  _afterParam(obj, wasOnFloor) {
    const msgs = [];
    if (wasOnFloor) {
      const low = lowestY([obj]);
      if (Math.abs(low) >= 1e-3) {
        msgs.push(`「${obj.name}」原本貼在地板上，改完之後${low > 0 ? '浮起來' : '沉下去'} ${+Math.abs(low).toFixed(2)} cm`
          + ' —— 要貼回地板就按右邊的「落地」');
      }
    }
    const g = gearClash(obj, this.app.doc.objects);
    if (g) msgs.push(g);
    if (msgs.length) this.app.toast(msgs.join('　'), true);
  }

  /** 改之前貼不貼地（③-14；跟面板「底部在地板下」那句同一個容許值）*/
  _onFloor(obj) {
    try { return Math.abs(lowestY([obj])) < 1e-3; } catch (e) { return false; }
  }

  // ── 表單元件 ──────────────────────────────────────

  _row(label, hint) {
    const r = document.createElement('div');
    r.className = 'row';
    const l = document.createElement('label');
    l.textContent = label;
    if (hint) l.title = hint;
    r.appendChild(l);
    (this._target || this.form).appendChild(r);
    return r;
  }

  _rowText(label, val, on) {
    const r = this._row(label);
    const i = document.createElement('input');
    i.type = 'text';
    i.value = val;
    i.onchange = () => on(i.value);
    r.appendChild(i);
  }

  _rowNum(label, val, opt, on, hint) {
    const r = this._row(label, hint);
    const i = document.createElement('input');
    i.type = 'number';
    i.value = round(val);
    if (opt.min !== undefined) i.min = opt.min;
    if (opt.max !== undefined) i.max = opt.max;
    i.step = opt.step ?? 1;
    // 用 change 而不是 input：逐字觸發會讓每打一個字就重建一次網格
    i.onchange = () => {
      const v = parseFloat(i.value);
      if (!Number.isFinite(v)) return;
      /** ⚠ 範圍只有箭頭會守 —— 打字進來的要自己擋，而且要講（`clampNum` 那則）*/
      const c = clampNum(v, opt);
      if (c.clamped) {
        i.value = round(c.v);
        this.app.toast(`「${label}」${c.v === opt.min ? '最小' : '最大'}是 ${round(c.v)}，`
          + `打的 ${round(v)} 已經改成 ${round(c.v)}`, true);
      }
      on(c.v);
    };
    r.appendChild(i);
  }

  _rowVec3(vec, labels, on, degrees = false, disabled = false) {
    const r = document.createElement('div');
    r.className = 'row vec';
    for (const k of ['x', 'y', 'z']) {
      const wrap = document.createElement('div');
      const s = document.createElement('span');
      s.textContent = labels[['x', 'y', 'z'].indexOf(k)];
      const i = document.createElement('input');
      i.type = 'number';
      i.step = degrees ? 5 : 1;
      i.disabled = disabled;
      i.value = round(degrees ? vec[k] * 180 / Math.PI : vec[k]);
      i.onchange = () => {
        const v = parseFloat(i.value);
        if (!Number.isFinite(v)) return;
        vec[k] = degrees ? v * Math.PI / 180 : v;
        on();
      };
      wrap.append(s, i);
      r.appendChild(wrap);
    }
    (this._target || this.form).appendChild(r);
  }

  /**
   * 跟 _rowVec3 一樣，但資料是純陣列 [x,y,z]（運算樹裡存的就是陣列，
   * 不是 THREE.Vector3，因為它要能直接寫進 JSON）。
   */
  _rowArr3(label, arr, labels, degrees, on, hint) {
    if (!Array.isArray(arr)) return;
    if (label) {
      const cap = document.createElement('div');
      cap.className = 'sub';
      cap.textContent = label;
      if (hint) cap.title = hint;
      (this._target || this.form).appendChild(cap);
    }
    const r = document.createElement('div');
    r.className = 'row vec';
    if (hint) r.title = hint;
    for (let k = 0; k < 3; k++) {
      const wrap = document.createElement('div');
      const s = document.createElement('span');
      s.textContent = labels[k];
      const i = document.createElement('input');
      i.type = 'number';
      i.step = degrees ? 5 : 1;
      i.value = round(degrees ? arr[k] * 180 / Math.PI : arr[k]);
      i.onchange = () => {
        const v = parseFloat(i.value);
        if (!Number.isFinite(v)) return;
        arr[k] = degrees ? v * Math.PI / 180 : v;
        on();
      };
      wrap.append(s, i);
      r.appendChild(wrap);
    }
    (this._target || this.form).appendChild(r);
  }

  _rowSelect(label, val, opts, on, hint) {
    const r = this._row(label, hint);
    const s = document.createElement('select');
    for (const [v, t] of opts) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      if (v === val) o.selected = true;
      s.appendChild(o);
    }
    s.onchange = () => on(s.value);
    r.appendChild(s);
  }

  _rowCheck(label, val, on, hint) {
    const r = this._row(label, hint);
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.checked = !!val;
    i.onchange = () => on(i.checked);
    r.appendChild(i);
  }

  _rowColor(label, val, on) {
    const r = this._row(label);
    const i = document.createElement('input');
    i.type = 'color';
    i.value = '#' + val.toString(16).padStart(6, '0');
    i.onchange = () => on(parseInt(i.value.slice(1), 16));
    r.appendChild(i);
  }

  _rowBtn(label, hint, on) {
    const b = document.createElement('button');
    b.className = 'wide';
    b.textContent = label;
    b.title = hint || '';
    b.onclick = on;
    (this._target || this.form).appendChild(b);
  }

  // ═══════════════════════════════════════════════════
  //  結構分析
  // ═══════════════════════════════════════════════════

  /**
   * 跑一次半邊結構的健康檢查與曲面判定。
   * 面數多的時候要花幾百毫秒，所以不自動跑，按按鈕才算，算完存起來。
   */
  analyse(force = false) {
    const obj = this.app.sel.active;
    if (!obj) return;

    if (!force && this.analysisCache.has(obj.id)) {
      this._renderAnalysis(this.analysisCache.get(obj.id));
      return;
    }

    this.anaBody.className = 'empty';
    this.anaBody.textContent = '計算中…';

    // 讓「計算中」有機會畫出來
    setTimeout(() => {
      const mesh = obj.mesh();
      const t0 = performance.now();
      const v = mesh.validate();
      const s = summarize(mesh);
      const ms = Math.round(performance.now() - t0);

      /**
       * 🔴 **外框是 bake 之後唯一還講得出「這東西多大」的東西。**
       * 參數物件的 `w/h/d` 在 `bake()` 之後就沒了（kang 2026-08-25 提的問題），
       * 而外框是從世界座標的頂點現算的，編輯過照樣算得出來。
       * ⭐ 借 `align.js` 的 `worldBounds()` —— 對齊、貼合、切一刀的範圍提示
       * 用的都是它，**四個地方看到的是同一套數字**。
       *
       * 🔴 **表面積與體積現在是世界座標的（2026-08-27 改）。**
       *
       * ⚠ 這裡原本用 `mesh.area()` / `mesh.volume()`，那是**網格自己的座標** ——
       * 物件被縮放過就會偏，當時的做法是「**多印一行講出來**」。
       * kang 2026-08-27：「**我們先處理好這問題**」→ 改成真的算對。
       *
       * ⭐ **體積是精確的**（× |sx·sy·sz|，＝ 矩陣的行列式）；
       * **面積逐個三角形重算**（⛔ 非均勻縮放下沒有「乘一個數」這種公式）。
       * ⚠ 兩者都在 `measure.js` 的 `meshMeasureWorld()`，
       * ⛔ 這裡不自己算 —— 它是純函式而且測得到。
       *
       * ⚠ **那一行「沒有含縮放」的警告已經整則刪掉** ——
       * ⛔ 留著就變成謊話（鐵律三：加新功能時順手檢查舊訊息有沒有過期）。
       */
      const b = worldBounds(obj);
      const w = meshMeasureWorld(mesh, obj.matrix());
      /**
       * ⚠ 這裡刻意**不用 `b.getSize(new THREE.Vector3())`** ——
       * `toolbar.js` 從頭到尾沒有 import three，而它是**測試載得進 Node 的**
       * 那幾支之一（`topologyCheck` 就是為此抽出來的）。
       * 為了印三個數字去背一個 three 依賴不划算，減一下就好。
       * 〔寫的時候真的寫成 `THREE.Vector3` 了，`node --check` **過**，
       * 　瀏覽器一開才會爆 —— 語法檢查不等於跑得動〕
       */
      const data = {
        name: obj.name, v, s, ms,
        area: w.area,
        volume: v.closed ? mesh.volume() * w.volumeFactor : null,
        size: b.isEmpty() ? null
          : { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z }
      };
      this.analysisCache.set(obj.id, data);
      this._renderAnalysis(data);
    }, 16);
  }

  _renderAnalysis(d) {
    /** 記住畫的是哪一份、哪個物件的（`refresh()` 拿來判斷要不要換掉 —— ②-4）*/
    this._anaShown = d;
    this._anaFor = this.app.sel.active ? this.app.sel.active.id : null;
    const { v, s } = d;
    const t = topologyCheck(v, s.totalDefect);

    // 極小的負值（-1e-16 之類）顯示成 -0.0000 很難看也容易被誤會，先歸零
    const defect = Math.abs(s.totalDefect) < 5e-5 ? 0 : s.totalDefect;

    this.anaBody.className = '';
    this.anaBody.innerHTML = `
      <table class="ana">
        <tr><th colspan="2" class="grp">拓 撲</th></tr>
        <tr><td>頂點 / 邊 / 面</td><td>${v.V} / ${v.E} / ${v.F}</td></tr>
        <tr><td title="封閉網格的尤拉數 χ ＝ 2×分開的實體數 − 2×貫穿孔數。一個沒有洞的實體是 2，挖穿一個孔變 0，兩塊分開的實體是 4，χ 一定是偶數。開放的殼再減掉開口的邊緣有幾圈：一片板子是 1，兩頭開口的筒子是 0">尤拉數 V−E+F</td>
            <td>${v.euler} ${mark(t.eulerOK)}<span class="dim"> ${t.eulerNote}</span></td></tr>
        ${t.genus !== null
          ? `<tr><td title="貫穿的洞有幾個。挖穿一個孔＝1，甜甜圈也是 1。沒挖穿的盲孔不算">貫穿孔數</td>
                 <td>${t.genus}</td></tr>`
          : ''}
        ${v.components > 1
          ? `<tr><td title="這個物件其實是幾塊彼此分開、沒有相連的實體。聯集兩個沒碰到的東西就會這樣">分開的實體</td>
                 <td>${v.components} 塊</td></tr>`
          : ''}
        <tr><td>是否封閉</td><td>${v.closed ? '封閉' : '開放（有邊界）'}</td></tr>
        <tr><td>結構檢查</td><td>${v.ok ? '無誤 ✓' : `<span class="bad">${v.errors.length} 項問題</span>`}</td></tr>

        <tr><th colspan="2" class="grp">展開相關</th></tr>

        <tr><td title="共面且相鄰的面已合併。展開時一片就是一個單位">平面區域</td>
            <td>${s.regions} 片<span class="dim"> ← ${v.F} 個面合併而來</span></td></tr>
        <tr><td title="用高斯曲率判定。可展開的才有精確解，不可展的必須切分近似">曲面判定</td>
            <td>${SURFACE_TEXT[s.surface] || s.surface}</td></tr>
        <tr><td title="360度減去頂點周圍所有夾角。高斯–博內定理：封閉曲面的總和恆等於 2π×尤拉數。沒有洞時就是常見的 4π">角虧總和</td>
            <td>${defect.toFixed(4)}${t.defectExpect !== null
              ? `<span class="dim"> 理論 2πχ = ${t.defectExpect.toFixed(4)}</span> ${mark(t.defectOK)}`
              : ''}</td></tr>
        <tr><td>攤不平的頂點</td><td>${s.curvedVerts} / ${v.V}</td></tr>
        <tr><td>折線 / 切割線</td><td>${s.folds} / ${s.cuts}</td></tr>

        <tr><th colspan="2" class="grp">尺寸</th></tr>
        ${d.size
          ? `<tr><td title="這個物件在空間裡佔的長寬高。跟對齊、貼合、切一刀的範圍提示是同一套數字">外框 X × Y × Z</td>
                 <td>${fmtCm(d.size.x)} × ${fmtCm(d.size.y)} × ${fmtCm(d.size.z)} cm</td></tr>` : ''}
        <tr><td>表面積</td><td>${fmt(d.area)} cm²</td></tr>
        ${d.volume !== null
          ? `<tr><td>體積</td><td>${fmt(d.volume)} cm³</td></tr>` : ''}
      </table>
      <div class="anaFoot">計算耗時 ${d.ms} ms</div>`;
  }
}

// ═══════════════════════════════════════════════════════
//  拓撲判定
// ═══════════════════════════════════════════════════════

/**
 * ③-1：陣列每一份都在同一個位置時要講的話（面板與「排列完成」的提示共用；純函式，測試載得到）。
 * ⚠ 畫面上的字，⛔ 用文件記號。
 */
export function stackedHint(mode, copies) {
  if (mode === 'radial') {
    return `⚠ 這 ${copies} 份全部在同一個位置：它們是繞物件自己的中心轉，只在原地自轉、沒有排成一圈。`
      + '要排成一圈，把下面的「旋轉中心」移到物件外面（例如 X 打 50）';
  }
  if (mode === 'mirror') {
    return '⚠ 鏡射出來的那一份跟原件疊在同一個位置（對稱面剛好在正中間）—— 把「對稱面位置」移到物件的邊上';
  }
  return `⚠ 這 ${copies} 份全部疊在同一個位置 —— 把間距改成不是 0`;
}

/**
 * 由拓撲數字推出「理論上應該是多少」，並判斷對不對。
 *
 * ── 這個函式為什麼要獨立出來 ────────────────────────
 * 第 1 期把「封閉 → 尤拉數 2、角虧總和 4π」直接寫死在畫面上。
 * 那時只有基本體，沒有東西挖得出洞，所以從沒出事。
 * 第 2 期一有布林運算，挖一個貫穿孔就變成 χ=0、角虧總和=0，
 * 寫死的判定把完全正確的結果打了兩個紅叉（2026-08-21 實際發生）。
 *
 * 所以改用正確的公式，而且抽成**不碰 DOM 的純函式**，
 * 這樣 tests/run.mjs 可以直接測它 —— 判定邏輯一旦寫錯，
 * 症狀是「數字明明對卻說錯」，那是最容易讓人失去信任的一種 bug。
 *
 * ── 用到的兩個定理 ──────────────────────────────────
 * 封閉可定向曲面：χ ＝ V−E+F ＝ 2c − 2g
 *   c ＝ 有幾個彼此分開的實體，g ＝ 貫穿孔總數（虧格）
 *   一個沒有洞的方塊 → χ=2；挖穿一個孔（等價於甜甜圈）→ χ=0；
 *   兩個分開的方塊（布林聯集很容易做出來）→ χ=4。
 *   所以「χ 應為 2」是錯的，正確的鐵律只有「χ 必為偶數」。
 * 高斯–博內定理：封閉曲面的角虧總和恆等於 2πχ。
 *   χ=2 時就是常見的 4π ≈ 12.5664。
 *
 * @param {object} v          mesh.validate() 的回傳（要有 components）
 * @param {number} totalDefect summarize() 算出的角虧總和
 */
export function topologyCheck(v, totalDefect) {
  if (!v.closed) {
    /**
     * 開放的殼：χ ＝ 2c − 2g − b（b ＝ 開口的邊緣有幾圈）。
     * 一片板子 b＝1 ⇒ 1；兩頭開口的筒子、挖一個洞的板子 b＝2 ⇒ 0。
     * 🔴 以前寫死「應為 1」⇒ 筒子、燈罩、有洞的板都被打 ✗（綜合評估 ②-2）。
     * 角虧總和的高斯–博內版本含邊界積分項，這裡照舊不做判定，
     * 免得給出似是而非的數字。
     */
    const c = v.components ?? 1;
    const b = v.boundaryLoops;
    if (!(b >= 1)) {
      return { genus: null, eulerOK: v.euler === 1, eulerNote: '一片板子應為 1', defectExpect: null, defectOK: null };
    }
    const g = (2 * c - b - v.euler) / 2;
    const valid = Number.isInteger(g) && g >= 0;
    const base = c === 1 ? `＝2−${b}` : `＝2×${c}−${b}`;
    const note = !valid ? `開口 ${b} 圈的殼不可能是這個值`
      : `${base}${g ? `−2×${g}` : ''}（開口的邊緣 ${b} 圈）`;
    return {
      genus: valid && g > 0 ? g : null,
      components: c,
      eulerOK: valid,
      eulerNote: note,
      defectExpect: null,
      defectOK: null
    };
  }

  const c = v.components ?? 1;
  const even = v.euler % 2 === 0;
  // χ = 2c − 2g 反推 g。g 為負數表示拓撲上不可能，一定是結構接錯了。
  const g = (2 * c - v.euler) / 2;
  const valid = even && Number.isInteger(g) && g >= 0;
  const defectExpect = 2 * Math.PI * v.euler;

  let note;
  if (!valid) note = '封閉曲面不可能是這個值';
  else if (c === 1) note = g === 0 ? '＝2，沒有貫穿孔' : `＝2−2×${g}`;
  else note = `＝2×${c}−2×${g}`;

  return {
    genus: valid ? g : null,
    components: c,
    eulerOK: valid,
    eulerNote: note,
    defectExpect,
    // 容許 1e-4：座標是 32 位元浮點數，上萬個頂點累加會有這個量級的尾差
    defectOK: Math.abs(totalDefect - defectExpect) < 1e-4
  };
}

// ═══════════════════════════════════════════════════════
//  上方工具列
// ═══════════════════════════════════════════════════════

/** 把「新增」下拉選單填上基本體 */
export function fillPrimMenu(selectEl) {
  for (const t of PRIM_TYPES) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = PRIM_SPECS[t] ? PRIM_SPECS[t].label : t;
    selectEl.appendChild(o);
  }
}

export { defaultSrc };

// ── 小工具 ────────────────────────────────────────────

/** 這個物件的網格封不封閉（算不出來當封閉 ⇒ ⛔ 多冒一個板厚欄）—— 跟畫面、3D 列印同一個判準（`mesh.isClosed()`）*/
function meshClosed(obj) {
  try { return obj.mesh().isClosed(); } catch (e) { return true; }
}

function head(text) {
  const h = document.createElement('div');
  h.className = 'sub';
  h.textContent = text;
  return h;
}

function note(text) {
  const n = document.createElement('div');
  n.className = 'note';
  n.textContent = text;
  return n;
}

/** 紅色的提示，用在算不出來這種需要處理的狀況 */
function bad(text) {
  const n = document.createElement('div');
  n.className = 'badNote';
  n.textContent = text;
  return n;
}

/**
 * 運算元的一行摘要，例如「⌀20 × 60」。
 * 展開之前就看得出誰是誰，不用一個個點開找。
 */
function describeSrc(src) {
  if (!src) return '';
  if (isBoolSrc(src)) return BOOL_LABEL[src.op] || '布林';
  if (isArraySrc(src)) return ARRAY_LABEL[src.mode] || '陣列';
  if (src.type === 'mesh') return '網格';

  const n = v => round(v);
  switch (src.type) {
    case 'box':      return `${n(src.w)}×${n(src.h)}×${n(src.d)}`;
    case 'plate':    return `${n(src.w)}×${n(src.d)}`;
    case 'cylinder': return `⌀${n(src.r * 2)}×${n(src.h)}`;
    case 'cone':     return `⌀${n(src.rBottom * 2)}→⌀${n(src.rTop * 2)}×${n(src.h)}`;
    case 'sphere':   return `⌀${n(src.r * 2)}`;
    case 'prism':    return `${n(src.sides)}角 ⌀${n(src.r * 2)}×${n(src.h)}`;
    case 'tube':     return `⌀${n(src.rOuter * 2)}/⌀${n(src.rInner * 2)}×${n(src.h)}`;
    case 'roundBox': return `${n(src.w)}×${n(src.h)}×${n(src.d)} R${n(src.r)}`;
    case 'bend':     return `${(src.bends || []).length} 道折　展開 ${round(bendDevelopedLength(src))}`;
    default:         return PRIM_SPECS[src.type] ? PRIM_SPECS[src.type].label : src.type;
  }
}

function mark(ok) {
  return ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>';
}

function round(v) {
  return Math.abs(v) < 1e-9 ? 0 : +Number(v).toFixed(4);
}

function fmt(v) {
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/**
 * 🔴 **讀一個數字欄位：留空就是「沒打」，⛔ 不是 0**（2026-10-08 查 bug 加的）。
 * `+欄位值` 會把空字串變成 0 —— 「切一刀」的位置留空，直接切在 0，
 * 而緊接著的「要打一個數字」檢查永遠不會觸發（0 是正常的數字）。
 * @param {string} s 欄位的 `value`
 * @returns {number} 讀不出數字一律回 NaN
 */
export function fieldNum(s) {
  const t = String(s ?? '').trim();
  return t === '' ? NaN : Number(t);
}

/**
 * 🔴 **把打進來的數字限制在欄位的範圍內**（2026-10-08 查 bug 加的）。
 * `<input min max>` 只管上下箭頭，⛔ 直接打字不管 —— 方塊寬打 −50 會得到翻過來的方塊。
 * ⭐ 回傳 `clamped` 讓介面**講出來**（跟比例編輯「打 −5 當場變回 0 並講」同一條）。
 * @param {number} v
 * @param {{min?:number, max?:number}} opt
 * @returns {{v:number, clamped:boolean}}
 */
export function clampNum(v, opt = {}) {
  let out = v;
  if (opt.min !== undefined && out < opt.min) out = opt.min;
  if (opt.max !== undefined && out > opt.max) out = opt.max;
  return { v: out, clamped: out !== v };
}
