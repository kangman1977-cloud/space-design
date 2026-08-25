/**
 * toolbar.js — 右側面板（物件屬性 ＋ 結構分析）
 *
 * 「結構分析」那一區是第 1 期的重點展示。
 * 半邊結構、平面區域合併、曲率判定這些東西本身是看不見的，
 * 把它們的數字攤在面板上，才驗得出來到底有沒有做對 ——
 * 也順便預告了展開引擎將來會依據什麼做判斷。
 */

import { PRIM_SPECS, defaultSrc, PRIM_TYPES, defaultBend, bendDevelopedLength,
         bendAllowance, neutralRadius } from '../build/prim.js';
import { KIND, canExplodeShapes } from '../core/io.js';
import { summarize, SURFACE } from '../core/region.js';
import { BOOL_OPS, BOOL_LABEL, BOOL_SYMBOL, isBoolSrc } from '../build/bool.js';
import { ARRAY_MODES, ARRAY_LABEL, AXES, isArraySrc, withMode }
  from '../build/array.js';
import { seamCount, markableEdges, clearSeams, seamBlockReason } from '../unfold/seam.js';
import { elementVerts, elementCenter, nonPlanarFaces, degenerateFaces }
  from '../core/edit.js';
import { measureSelection, fmtCm } from '../core/measure.js';
import { unfoldObject } from '../unfold/part.js';
import { alignPositions, distributePositions, spacePositions, currentGaps,
         worldBounds, AXIS_KEYS, ALIGN, ALIGN_LABEL } from '../core/align.js';

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
      </section>`;

    this.form = this.root.querySelector('#pForm');
    this.empty = this.root.querySelector('#pEmpty');
    this.anaBody = this.root.querySelector('#anaBody');
    this.root.querySelector('#anaRun').onclick = () => this.analyse(true);
  }

  // ═══════════════════════════════════════════════════
  //  物件屬性
  // ═══════════════════════════════════════════════════

  refresh() {
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
      this.form.hidden = true;
      this.anaBody.className = 'empty';
      this.anaBody.textContent = '選一個物件後按「重新計算」';
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

    // 網格生成失敗（多半是布林算不出來）先講清楚，再讓人去改參數
    if (obj.error) {
      this.form.appendChild(bad('這個物件目前算不出來：' + obj.error));
    }

    if (many) {
      this.form.appendChild(note(`已選 ${this.app.sel.count} 個，以下編輯最後選的「${obj.name}」`));
      this._alignBox();
    }

    this._rowText('名稱', obj.name, v => { obj.name = v; this._edit('改名稱'); });

    this._rowSelect('種類', obj.kind, [
      [KIND.SOLID, '實體 solid'],
      [KIND.SHEET, '板件 sheet']
    ], v => {
      obj.kind = v;
      this._edit('改種類');
    }, '板件是要拿去展開的東西（有厚度、可折彎）；實體是有體積的量體');

    if (obj.kind === KIND.SHEET) {
      // 板厚會改變折彎的中性層位置，也就會改變形狀與展開長度，
      // 所以一定要 invalidate() 讓網格重生，不能只改數字。
      this._rowNum('板厚 cm', obj.thickness, { min: 0.01, step: 0.1 }, v => {
        obj.thickness = v;
        obj.invalidate();
        this.analysisCache.delete(obj.id);
        this._edit('改板厚');
      }, '折彎補償與展開長度都要用它算：中性層半徑 ＝ 內側R ＋ K×板厚');
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
          if (!confirm(`會變成 ${obj.copies} 個獨立物件，而且收不回來，確定嗎？`)) return;
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
            obj.src[f.key] = f.int ? Math.round(v) : v;
            obj.invalidate();
            this.analysisCache.delete(obj.id);
            this._edit('改' + f.label);
          }, f.hint);
        }
      }
      this._rowBtn(`打散成 ${obj.src.shapes.length} 個獨立物件`,
        '每個形狀變成可以各自移動、旋轉、縮放的物件。'
        + '版面維持原樣，而且每個物件的原點都在自己的中心。'
        + '拆開之後就不再是同一份稿了，收不回來。', () => {
          if (!confirm(`會變成 ${obj.src.shapes.length} 個獨立物件，`
            + '而且收不回來，確定嗎？')) return;
          this.app.onExplode(obj);
        });

    } else if (obj.isParametric) {
      const spec = PRIM_SPECS[obj.src.type];
      if (spec) {
        this.form.appendChild(head(spec.label + ' 參數'));
        for (const f of spec.fields) {
          this._rowNum(f.label, obj.src[f.key], f, v => {
            obj.src[f.key] = f.int ? Math.round(v) : v;
            obj.invalidate();
            this.analysisCache.delete(obj.id);
            this._edit('改' + f.label);
          }, f.hint);
        }
        if (spec.hasBends) this._bendList(obj);
        this._rowBtn('轉成可編輯網格', '不可逆。轉了之後就不能再改上面的參數，但可以做面編輯', () => {
          obj.bake();
          this._edit('轉成網格');
        });
      }
    } else {
      this.form.appendChild(note('這個物件已經是網格，沒有參數可以改'));
    }

    // ── 位置 ──
    this.form.appendChild(head('位置 cm'));
    this._rowVec3(obj.pos, ['X', 'Y', 'Z'], () => this._edit('改位置'));

    this.form.appendChild(head('旋轉 度'));
    this._rowVec3(obj.rot, ['X', 'Y', 'Z'], () => this._edit('改旋轉'), true);

    this.form.appendChild(head('縮放 倍'));
    this._rowVec3(obj.scale, ['X', 'Y', 'Z'], () => this._edit('改縮放'), false,
      obj.lockScale);

    this._rowCheck('鎖定縮放', obj.lockScale, v => {
      obj.lockScale = v;
      this._edit(v ? '鎖定縮放' : '解除鎖定');
    }, '鎖定後不給縮放把手。帶料表的精確件應該鎖住，避免圖面與實際用料不符');

    this._rowColor('顏色', obj.color, v => { obj.color = v; this._edit('改顏色'); });
  }

  _edit(label) {
    this.app.onEdit(label);
    this.refresh();
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
   * 沒有做「對齊至關鍵物件」，因為 3D 裡沒有「最後點的那個要當基準」
   * 這個既有慣例，貿然做反而難猜。真的需要再加。
   */
  _alignBox() {
    const objs = this.app.sel.objects;
    if (objs.length < 2) return;

    this.form.appendChild(head('對齊'));

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
          alignPositions(this.app.sel.objects, ax, mode),
          `對齊 ${ALIGN_LABEL[ax][mode]}`);
        r.appendChild(b);
      }
      this.form.appendChild(r);
    }

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
    const g = currentGaps(objs, 'x');
    if (g.length) {
      this.form.appendChild(note(
        'X 空隙 ' + g.map(v => round(v)).join('　') + ' cm'));
    }
  }

  /**
   * 把算好的新位置套上去。
   *
   * align.js 的函式一律不改動任何東西，只回傳新位置 —— 套用這一步
   * 刻意留在這裡，因為只有這裡知道要記一步 Undo、要重畫、要講一句話。
   */
  _applyPositions(list, label) {
    const objs = this.app.sel.objects;
    if (list.length !== objs.length) return;
    let moved = 0;
    objs.forEach((o, i) => {
      if (o.pos.distanceToSquared(list[i]) > 1e-18) moved++;
      o.pos.copy(list[i]);
    });
    this._edit(label);
    if (this.app.toast) this.app.toast(`${label}：移動了 ${moved} 個物件`);
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
      + `${many ? (sel.editPivot === 'active' ? '中心（最後選的）' : '中心（重心）') : '重心'} `
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
        `${deg.length} 個面被壓成零面積 —— 多半是擠出來的那一段又被拉回原位了。`
        + '拉回去就恢復，資料沒壞。'
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

    const box = document.createElement('div');
    box.className = 'note';
    box.innerHTML = pieces === null
      ? `已標記 <b>${n}</b> / ${total} 條邊　（片數算不出來）`
      : `展開後 <b>${pieces}</b> 片　已標記 <b>${n}</b> / ${total} 條邊`;
    this.form.appendChild(box);

    this.form.appendChild(note(
      '點稜線＝從那裡切開／取消；點面的中央＝把那個面整圈切開。'
      + '標了片數沒變是正常的 —— 要切到能把面分開才會多一片。'
    ));

    if (n > 0) {
      this._rowBtn(`清除全部標記（${n} 條）`,
        '回到自動判斷。取消標記是把決定交還給材料規則，不是強迫它折起來', () => {
          clearSeams(obj.mesh());
          this.app.view.markSeamsDirty();
          this._edit('清除分片標記');
        });
    }
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
    total.textContent = `總共 ${obj.copies} 份`
      + (src.mode === ARRAY_MODES.MIRROR ? '（其中一份是鏡像，展開圖要翻面）' : '');
    wrap.appendChild(total);

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
      this._rowArr3('旋轉中心 cm', src.center, ['X', 'Y', 'Z'], false,
        () => this._rebuild(obj, '改旋轉中心'),
        '相對於物件自己的原點。法蘭螺栓孔通常留 0，讓孔繞著中心排');

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
    for (const f of spec.fields) {
      this._rowNum(f.label, src[f.key], f, v => {
        src[f.key] = f.int ? Math.round(v) : v;
        this._rebuild(obj, '改' + f.label);
      });
    }
  }

  /** 運算樹被改過 → 清掉快取重算，然後照一般編輯流程走 */
  _rebuild(obj, label) {
    obj.invalidate();
    this.analysisCache.delete(obj.id);
    this._edit(label);
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
      if (Number.isFinite(v)) on(v);
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
       * ⚠ **表面積與體積是網格自己的座標算的，沒有含物件的縮放。**
       * 縮放不是 1 的時候那兩個數字會偏，所以下面會多印一行講出來 ——
       * ⛔ 不可以讓它安靜地錯（坑第 18 條：誤報比漏報更糟，
       * 但**沉默的錯報是最糟的**）。真的要修是另一件事，已開待辦。
       */
      const sc = obj.scale;
      const b = worldBounds(obj);
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
        area: mesh.area(),
        volume: v.closed ? mesh.volume() : null,
        size: b.isEmpty() ? null
          : { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z },
        scaled: Math.abs(sc.x - 1) > 1e-9 || Math.abs(sc.y - 1) > 1e-9
             || Math.abs(sc.z - 1) > 1e-9
      };
      this.analysisCache.set(obj.id, data);
      this._renderAnalysis(data);
    }, 16);
  }

  _renderAnalysis(d) {
    const { v, s } = d;
    const t = topologyCheck(v, s.totalDefect);

    // 極小的負值（-1e-16 之類）顯示成 -0.0000 很難看也容易被誤會，先歸零
    const defect = Math.abs(s.totalDefect) < 5e-5 ? 0 : s.totalDefect;

    this.anaBody.className = '';
    this.anaBody.innerHTML = `
      <table class="ana">
        <tr><th colspan="2" class="grp">拓 撲</th></tr>
        <tr><td>頂點 / 邊 / 面</td><td>${v.V} / ${v.E} / ${v.F}</td></tr>
        <tr><td title="封閉網格的尤拉數 χ ＝ 2×分開的實體數 − 2×貫穿孔數。一個沒有洞的實體是 2，挖穿一個孔變 0，兩塊分開的實體是 4。開放的殼是 1。χ 一定是偶數，出現奇數就表示結構接錯了">尤拉數 V−E+F</td>
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

        <tr><td title="共面且相鄰的三角形已合併。展開時一片就是一個單位">平面區域</td>
            <td>${s.regions} 片<span class="dim"> ← ${v.F} 個三角形合併而來</span></td></tr>
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
        ${d.scaled
          ? `<tr><td colspan="2" class="dim2">⚠ 這個物件被縮放過，上面的表面積與體積
                 <b>沒有含縮放</b>（外框有）。要正確的數字請先把縮放併進網格</td></tr>` : ''}
      </table>
      <div class="anaFoot">計算耗時 ${d.ms} ms</div>`;
  }
}

// ═══════════════════════════════════════════════════════
//  拓撲判定
// ═══════════════════════════════════════════════════════

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
    // 開放的殼（板件）：一片沒有洞的板子是 1。
    // 角虧總和的高斯–博內版本含邊界積分項，這裡不做判定，
    // 免得給出似是而非的數字。
    return {
      genus: null,
      eulerOK: v.euler === 1,
      eulerNote: '開放的殼應為 1',
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
