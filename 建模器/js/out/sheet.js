/**
 * sheet.js — 展開圖
 *
 * ── 一份圖，三種輸出 ────────────────────────────────
 * 螢幕預覽、列印／PNG、SVG 匯出，畫的內容必須完全一樣，
 * 否則螢幕上看到的跟印出來的不同，那張圖就不能信。
 *
 * 所以這裡沿用專案一貫的「入口分開、動作邏輯共用」：
 *
 *     drawProgram(piece)  ← 唯一決定「畫什麼」的地方
 *            │
 *     ┌──────┴──────┐
 *   renderCanvas   renderSVG      ← 只決定「怎麼畫出來」
 *
 * 中間那份程式是純資料（一堆線段與文字，座標單位 cm），
 * 不碰 DOM 也不碰 canvas，所以**在 Node 裡測得到**。
 * 這跟建模器核心跟 three.js 切開是同一個理由。
 *
 * y 軸向上（跟 DXF、跟一般製圖一致）；由算繪端負責翻轉。
 */

const R2 = v => Math.round(v * 100) / 100;
const fmt = v => R2(v).toString();

/**
 * 線型與顏色。改這裡就三種輸出一起改。
 *
 * ── w 的單位是 cm，而且是**真的線寬** ──────────────────
 * 這裡曾經寫成 0.35，而圖面 1 單位 ＝ 1cm，
 * 所以切割線印出來是 3.5mm 粗 —— 製圖標準大概 0.5mm，粗了七倍。
 * 現在一律照製圖慣例給值：粗實線 0.5mm、細線 0.25mm、尺寸線 0.18mm。
 *
 * ── minPx 是螢幕上的下限 ────────────────────────────
 * 一張 100cm 的圖縮到 1000px 的視窗裡是 10 px/cm，
 * 0.5mm 的線只有 0.5px —— 等於看不見。
 * 所以螢幕另外給一個像素下限，印出來才用真實線寬。
 */
export const STYLE = {
  cut:  { w: 0.050, minPx: 1.6, dash: null,        color: '#111', label: '切割線' },
  hole: { w: 0.040, minPx: 1.3, dash: null,        color: '#111', label: '內孔' },
  fold: { w: 0.030, minPx: 1.1, dash: [1.2, .5, .3, .5], color: '#c0392b', label: '折線' },
  bend: { w: 0.025, minPx: 1.0, dash: [0.8, 0.5],  color: '#2980b9', label: '折彎區' },
  dim:  { w: 0.018, minPx: 0.8, dash: null,        color: '#666',  label: '尺寸' },
  /**
   * 接合編號。用綠色是為了跟切割線（黑）、折線（紅）、折彎區（藍）、
   * 尺寸（灰）都分得開 —— 師傅在圖上找「號碼」時不必先分辨那是不是尺寸。
   */
  joint: { w: 0.020, minPx: 0.9, dash: null,       color: '#1e8449', label: '接合編號' },
  /**
   * 剖面分切用的兩個。
   *
   * peg 是定位孔 —— **它跟輪廓一樣是要被切掉的**，所以線寬比照切割線，
   * 顏色另外給是為了在螢幕上一眼認出來（紫色在這張圖上沒有別的東西用）。
   * num 是層號，只給人看。
   */
  peg:  { w: 0.045, minPx: 1.4, dash: null,        color: '#8e44ad', label: '定位孔' },
  num:  { w: 0.020, minPx: 0.9, dash: null,        color: '#b9770e', label: '層號' },
  text: { w: 0.018, minPx: 0.8, dash: null,        color: '#111',  label: '文字' },
  note: { w: 0.018, minPx: 0.8, dash: null,        color: '#888',  label: '註記' }
};

/**
 * 字型堆疊。SVG 會被丟進 Illustrator 或別人的電腦開，
 * 只寫 sans-serif 的話中文會掉字，所以把常見的中文字型都列上。
 *
 * **刻意不加引號。** CSS 允許不加引號的多字詞字型名，
 * 這樣屬性值裡就不會出現引號，XML 屬性怎麼包都不會打架 ——
 * 有些解析器碰到 `font-family='"A","B"'` 這種巢狀引號會直接放棄。
 * 又是同一條原則：要送出去的格式，用最保守的寫法。
 */
export const FONT = 'Noto Sans TC, Microsoft JhengHei, PingFang TC, sans-serif';

// ═══════════════════════════════════════════════════════
//  一、決定畫什麼（純資料，可在 Node 裡驗）
// ═══════════════════════════════════════════════════════

/**
 * 把一片展開圖轉成一串繪圖指令。
 *
 * @param {object} piece flatten.js 的 piece
 * @param {object} opt   { rule, head, showDims, showBendMarks }
 * @returns {{w:number, h:number, box:object, items:Array}}
 */
export function drawProgram(piece, opt = {}) {
  const items = [];
  /**
   * 接合編號最後用了多大的字、還剩幾對靠太近 —— 給面板的說明文字用。
   * ⚠ **縮了字一定要講出來**（坑第 11 條：⛔ 不可以安靜地改掉使用者看到的東西）。
   */
  let jointInfo = null;
  const showDims = opt.showDims !== false;
  const W = piece.width, H = piece.height;

  // 圖面留白：左邊放總寬尺寸，下方放兩排分段尺寸，上方放折彎標註。
  // 上方留多少由實際用到幾排決定（見下方 topUsed）。
  const pad = { l: 6, r: 3, t: 7, b: 12 };
  const line = (style, x1, y1, x2, y2) => items.push({ t: 'line', style, x1, y1, x2, y2 });
  const text = (style, x, y, s, size = 1.6, anchor = 'start') =>
    items.push({ t: 'text', style, x, y, s: String(s), size, anchor });

  // ── 輪廓與內孔 ──
  loop(items, piece.outline, 'cut');
  for (const h of piece.holes) loop(items, h, 'hole');

  // ── 折線 ──
  // 圓弧折彎帶「裡面」那些線是網格切出來的，不是真的要折的地方，
  // 畫出來只會讓師傅以為要折五道。只畫折彎區的起訖線。
  for (const f of piece.folds) {
    if (f.isArcEdge) continue;
    line('fold', f.a.x, f.a.y, f.b.x, f.b.y);
  }

  /**
   * ── 接合編號 ──────────────────────────────────────
   *
   * 「這條邊要跟誰接回去」。同一個號碼一定剛好出現兩次
   * （可能在兩片上，也可能在同一片的兩處），對起來就是了。
   *
   * 位置：那條邊的中點，**往片內縮一點**。
   * 不往外放是因為外面已經被尺寸標註與折彎標註佔滿了，
   * 再擠進去就會變成坑第 12 條那團「0.9787.05.24」——
   * 讀不出來的標示比沒有標示更糟。
   *
   * ── 🔴 判準是「落在料上」，⛔ 不是「往重心那一側」（2026-08-26 修）──
   *
   * ⚠ **舊版拿重心當方向，而那對環形片是錯的**：
   * 環形端面（管的兩個端面）**重心在洞的正中央**，所以
   * 內圈那一半的號碼被往洞裡推 —— **印在會被挖掉的料上**。
   *
   * 🔴 **實測（kang 2026-08-26 重現：管 r25/20、高 70、段數 32）**：
   * **66 個接合編號裡有 32 個落在內半徑 20 以內，也就是洞裡。**
   * 〔連帶的症狀才是他看到的「疊在一起」：內圈那一堆被擠進更小的圈裡〕
   *
   * ⭐ **環形片沒有 `holes` 資料**（實測 `holes.length === 0`）——
   * 它的 `outline` 是一條**從外圈穿過缺口繞到內圈再繞回來**的封閉線
   * （66 點 ＝ 外圈 32 ＋ 內圈 32 ＋ 缺口 2）。
   * **所以「在不在料上」直接問這條線就對了**，那條線本身已經把洞排除掉。
   *
   * ⚠ 兩側都在料上（很窄的片）或兩側都不在時，**退回舊的重心規則** ——
   * ⛔ 不要在那種情況硬選一邊，那是拿隨機當答案（坑第 24 條）。
   */
  if (opt.showJoints !== false && piece.joints && piece.joints.length) {
    const cx = piece.outline.reduce((s, p) => s + p.x, 0) / (piece.outline.length || 1);
    const cy = piece.outline.reduce((s, p) => s + p.y, 0) / (piece.outline.length || 1);

    /** 這個位置是不是在料上：在輪廓裡面，而且不在任何一個洞裡 */
    const onMaterial = (x, y) => {
      if (!pointInPoly(x, y, piece.outline)) return false;
      for (const h of (piece.holes || [])) if (pointInPoly(x, y, h)) return false;
      return true;
    };

    /** 用某一個字高排一遍，回傳每個號碼的落點 */
    const layout = size => piece.joints.map(j => {
      const mx = (j.a.x + j.b.x) / 2, my = (j.a.y + j.b.y) / 2;
      let nx = -(j.b.y - j.a.y), ny = j.b.x - j.a.x;
      const L = Math.hypot(nx, ny) || 1;
      nx /= L; ny /= L;
      /** ⭐ 內縮距離跟著字高走：字小就貼近邊，兩排才拉得開 */
      const IN = size;
      const ax = mx + nx * IN, ay = my + ny * IN;
      const bx = mx - nx * IN, by = my - ny * IN;
      const aOK = onMaterial(ax, ay), bOK = onMaterial(bx, by);
      if (aOK && !bOK) return { x: ax, y: ay, num: j.num };
      if (bOK && !aOK) return { x: bx, y: by, num: j.num };
      /** 分不出來 → 退回舊規則（朝重心那一側） */
      const toward = (cx - mx) * nx + (cy - my) * ny >= 0;
      return { x: toward ? ax : bx, y: toward ? ay : by, num: j.num };
    });

    /** 這一批號碼有幾對靠得太近（`labelWidth` 本身含一個字高的留白） */
    const clashes = (pos, size) => {
      const bs = pos.map(p => {
        const w = labelWidth(p.num, size);
        return { x0: p.x - w / 2, x1: p.x + w / 2, y0: p.y - size * 0.8, y1: p.y + size * 0.25 };
      });
      let n = 0;
      for (let i = 0; i < bs.length; i++) for (let k = i + 1; k < bs.length; k++) {
        const a = bs[i], b = bs[k];
        if (a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0) n++;
      }
      return n;
    };

    /**
     * 🔴 **塞不下才縮字，⛔ 不是全面改小。**
     *
     * ⚠ **為什麼要有這一段**（kang 2026-08-26 重現：管 r25/20、段數 32）：
     * 環形端面的料只有 **5 公分寬**（外半徑 25 − 內半徑 20），
     * 卻要放 **66 個號碼**，而字高 1.8 —— **物理上塞不下**。
     *
     * 實測（同一片）：字高 1.8 → 疊 42 對；1.2 → 16 對；**1.0 → 3 對**。
     * 而空間夠的片（內側面 125×70）**字高 1.2 就完全不疊**。
     *
     * ⭐ 所以逐級試，**第一個不擠的就用它** ——
     * 空間夠的片完全不受影響（1.8 就過，跟改之前逐字相同）。
     * ⛔ 一律改小會動到 kang 已經看得很順的那些圖
     * （「為了整齊去改能用的東西，不划算」）。
     *
     * ⚠ **最小只到 0.9**：再小紙上就讀不出來了，那就違反坑第 12 條的前半
     * （讀不出尺寸的圖比沒有圖更糟）。都塞不下就用最小的那一級，
     * **並且把「縮了」講出來** —— ⛔ 不可以安靜地縮（坑第 11 條）。
     */
    const LADDER = [1.8, 1.4, 1.1, 0.9];
    let best = null;
    for (const size of LADDER) {
      const pos = layout(size);
      const n = clashes(pos, size);
      if (!best || n < best.n) best = { size, pos, n };
      if (n === 0) break;
    }

    for (const p of best.pos) text('joint', p.x, p.y, p.num, best.size, 'middle');
    /** 呼叫端（面板的說明文字）要拿得到，才講得出來 */
    jointInfo = { size: best.size, clashes: best.n };
  }

  // ── 折彎區 ──
  for (const b of piece.bends) {
    if (!b.isArc) continue;
    line('bend', b.x0, 0, b.x0, H);
    line('bend', b.x1, 0, b.x1, H);
    // 中心線：折床對位用
    const cx = (b.x0 + b.x1) / 2;
    line('bend', cx, -1, cx, H + 1);
  }

  // ── 折彎標註（角度、內側 R、往哪折）──
  // 折彎多的件（例如四角都倒圓的護罩）標註會互相重疊，
  // 所以跟下方的分段尺寸一樣錯開成兩排，兩排都塞不下才略過。
  let topUsed = 0;
  if (opt.showBendMarks !== false) {
    const rows = [H + 2.2, H + 7.0];
    const rowEnd = [-Infinity, -Infinity];

    for (const b of [...piece.bends].sort((p, q) => p.x0 - q.x0)) {
      const cx = b.isArc ? (b.x0 + b.x1) / 2 : b.x0;
      const dir = b.angle > 0 ? '↑ 上折' : '↓ 下折';
      /**
       * 曲線帶跟真正的圓弧要分開講。
       *
       * 圓弧有唯一的半徑，標「R3」師傅看得懂；自由曲線（Illustrator
       * 畫出來的那種）每一段曲率都不同，**沒有一個 R 可言**。
       * 標一個算出來的假半徑比不標更糟 —— 那是坑第 20 條
       * 「正確的數字，錯誤的意思」：R0 是程式裡的預設值，
       * 不是這條曲線的半徑。
       */
      /**
       * ⚠ 這裡以前標 `R${b.ri}`（內側圓角，由 K 因子與板厚推出來），
       * 2026-08-23 改成 `R${b.r}` —— **網格量出來的半徑**。
       *
       * 舊的那個數字描述的是一個不存在的東西：K 因子從頭到尾沒有
       * 參與圓柱的建模（實測換 K 網格半徑一動也不動），可是圖上
       * 卻印 R24.9 而網格是 25.0。師傅會照著 24.9 做。
       * 〔坑第 20 條：正確的數字，錯誤的意思〕
       *
       * kang 2026-08-23：「K 因子…這都是造成混亂的條件…
       * 不應該在真實尺寸中出現」。
       */
      const l1 = b.isCurve
        ? `曲線　${fmt(b.x1 - b.x0)} cm`
        : `${fmt(Math.abs(b.angle))}°　R${fmt(b.r)}`;
      /**
       * ⚠ 這裡以前標「弧長 X」，2026-08-23 改成「展開 X　N 段」。
       *
       * 那個數字現在（而且從板材那條路以來一直）是**網格攤平後的寬度**，
       * 也就是 N 片平板相加，不是理想圓的弧長。叫它「弧長」是
       * 坑第 20 條：正確的數字，錯誤的意思 —— 看的人會以為程式
       * 已經幫他換算成真正的圓周了。
       *
       * 補上段數是因為那是判斷精緻度的依據：同樣 R25，
       * 32 段跟 128 段捲起來的半徑差 0.37mm。
       */
      const l2 = b.isCurve
        ? `${dir}　${b.segs} 段　共轉 ${fmt(Math.abs(b.angle))}°`
        : `${dir}${b.isArc ? `　展開 ${fmt(b.x1 - b.x0)}　${b.segs} 段` : '　尖角'}`;
      const half = Math.max(labelWidth(l1, 1.5), labelWidth(l2, 1.2)) / 2;

      let row = -1;
      for (let r = 0; r < rows.length; r++) {
        if (cx - half >= rowEnd[r]) { row = r; break; }
      }
      if (row < 0) continue;
      rowEnd[row] = cx + half;

      text('text', cx, rows[row], l1, 1.5, 'middle');
      text('note', cx, rows[row] + 2.2, l2, 1.2, 'middle');
      topUsed = Math.max(topUsed, rows[row] + 2.2 - H);
    }
  }

  // ── 尺寸 ──
  if (showDims) {
    // 分段尺寸：平面段與折彎區各自標長度，這是師傅畫線的依據
    const stops = [0];
    for (const b of piece.bends) {
      if (b.isArc) { stops.push(b.x0, b.x1); }
      else stops.push(b.x0);
    }
    stops.push(W);
    const uniq = [...new Set(stops.map(v => R2(v)))].sort((a, b) => a - b);

    /**
     * 分段數字放不下時改標在下面一排，不是直接丟掉。
     *
     * 實測（圓角方塊那種折彎很多的件）全部擠在同一排，
     * 變成一團「0.9787.05.24」完全讀不出來 ——
     * **一張讀不出尺寸的圖比沒有圖更糟**，看的人會以為自己讀到了。
     *
     * 但也不能因為放不下就不標：折彎區只有 3.33cm，
     * 那個數字正是師傅畫線要用的，丟掉等於這張圖不能下料。
     * 所以錯開成兩排，兩排都塞不下才放棄（並到備料明細去查）。
     */
    const rowY = [-2.5, -4.6];
    const rowEnd = [-Infinity, -Infinity];

    for (let i = 0; i + 1 < uniq.length; i++) {
      const a = uniq[i], b = uniq[i + 1];
      if (b - a < 0.05) continue;
      const label = fmt(b - a);
      const half = labelWidth(label, 1.3) / 2;
      const mid = (a + b) / 2;

      let row = -1;
      for (let r = 0; r < rowY.length; r++) {
        if (mid - half >= rowEnd[r]) { row = r; break; }
      }
      if (row >= 0) rowEnd[row] = mid + half;
      dim(items, a, rowY[row < 0 ? 0 : row], b, rowY[row < 0 ? 0 : row],
        row < 0 ? '' : label, 'h');
    }

    // 總長與總寬
    dim(items, 0, -7.6, W, -7.6, `總長 ${fmt(W)}`, 'h');
    dim(items, -3, 0, -3, H, `${fmt(H)}`, 'v');
  }

  const top = Math.max(pad.t, topUsed + 2);
  return {
    w: W, h: H,
    box: { x: -pad.l, y: -pad.b, w: W + pad.l + pad.r, h: H + pad.b + top },
    items,
    jointInfo
  };
}

function loop(items, pts, style) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    items.push({ t: 'line', style, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
}

/**
 * 估一串字有多寬（含左右各半個字的間隙）。
 *
 * 用「字數 × 字高 × 0.55」估：尺寸標註都是數字，等寬，估得夠準。
 * 中文字寬約一個字高，但標註不會出現中文，出現了也只是估得保守一點。
 */
/**
 * 一個點在不在多邊形裡（射線法）。
 *
 * ⚠ **⛔ 不要拿 `core/screen.js` 的那一支來用** —— 那一支問的是
 * 「投影到**螢幕**之後在不在框裡」，這一支問的是「在不在**圖面上**這片料裡」。
 * 兩件不同的事碰巧算法一樣，共用會讓下一個人以為它們必須一致。
 *
 * 給接合編號決定「往哪一側縮才是料上」用的，見上方那一節。
 */
export function pointInPoly(x, y, poly) {
  if (!poly || poly.length < 3) return false;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > y) !== (yj > y) &&
        x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-20) + xi) inside = !inside;
  }
  return inside;
}

export function labelWidth(label, size) {
  let n = 0;
  for (const ch of String(label)) n += ch.charCodeAt(0) > 0x2000 ? 1 : 0.55;
  return n * size + size;
}

/** 尺寸線：兩端斜線刻度（製圖慣例的建築式標註），中間放數字 */
function dim(items, x1, y1, x2, y2, label, kind) {
  const tick = 0.45;
  items.push({ t: 'line', style: 'dim', x1, y1, x2, y2 });
  items.push({ t: 'line', style: 'dim', x1: x1 - tick, y1: y1 - tick, x2: x1 + tick, y2: y1 + tick });
  items.push({ t: 'line', style: 'dim', x1: x2 - tick, y1: y2 - tick, x2: x2 + tick, y2: y2 + tick });

  if (!label) return;          // 放不下就只畫刻度

  if (kind === 'h') {
    items.push({ t: 'text', style: 'dim', x: (x1 + x2) / 2, y: y1 + 0.6,
      s: label, size: 1.3, anchor: 'middle' });
  } else {
    items.push({ t: 'text', style: 'dim', x: x1 - 0.6, y: (y1 + y2) / 2,
      s: label, size: 1.3, anchor: 'end', rot: -90 });
  }
}

/**
 * 標題欄的文字。展開圖沒有這幾行就不能下料 ——
 * 「這是哪一片、幾片、什麼材料、多厚、K 多少」缺一不可。
 */
export function titleLines(piece, opt = {}) {
  const rule = opt.rule || {};
  const head = opt.head || {};
  const out = [];

  out.push(`${piece.name}　×${piece.qty} 片`);
  const spec = [];
  /**
   * ⚠ 〔2026-08-23 拿掉 `K ${rule.k}`〕
   * K 因子是金屬中性層的模型，主力材料一種金屬都不用，
   * 而且它已經不影響圖上任何一個數字了。留著只會讓人以為
   * 圖上的尺寸跟它有關 —— 那正是要清掉的混淆。
   *
   * 材質與板厚**留著**，但它們是**案件資訊**，不是尺寸的依據：
   * 板厚不進展開圖（45° 斜接會把板厚吃掉），它的用途在展開圖之後
   * —— 銑 V 溝要多寬、STL 加厚。見 `規格\建模器-展開與分片.md`。
   */
  if (rule.label) spec.push(rule.label);
  if (rule.thickness) spec.push(`板厚 ${fmt(rule.thickness)} cm`);
  if (spec.length) out.push(spec.join('　'));

  out.push(`外框 ${fmt(piece.width)} × ${fmt(piece.height)} cm`
    + `　面積 ${fmt(piece.area)} cm²`);

  /**
   * 一定要講這一行。
   *
   * 圖上那些綠色數字如果沒有說明，師傅只會覺得「這是什麼」——
   * 而它正是「切完之後怎麼接回去」的唯一線索。
   * 標了卻沒人看得懂，等於沒標（坑第 12 條的另一面：
   * 那次是擠在一起讀不出來，這次是讀得出來但不知道意思）。
   */
  if (piece.joints && piece.joints.length) {
    const many = piece.joints.filter(j => (j.segs || 1) > 1).length;
    out.push(`接合編號 ${piece.joints.length} 段　同號碼的段接在一起`
      + (many ? `（有 ${many} 段是連續的曲線，整段一個號碼）` : ''));
  }

  const curves = piece.bends.filter(b => b.isCurve).length;
  const arcs = piece.bends.filter(b => b.isArc && !b.isCurve).length;
  const sharp = piece.bends.length - arcs - curves;
  if (piece.bends.length) {
    /**
     * 曲線帶要單獨列出來，而且要講它涵蓋幾段。
     * 不講的話「折彎 12 道」看起來很單純，但其中一條可能是 85 段的曲線 ——
     * 師傅需要知道那裡是滾的、不是折 12 道。
     */
    out.push(`折彎 ${piece.bends.length} 處`
      + `（曲線帶 ${curves}、圓弧 ${arcs}、真轉角 ${sharp}）`
      + (curves
        ? `　曲線帶共 ${piece.bends.filter(b => b.isCurve)
            .reduce((n, b) => n + b.segs, 0)} 小段，圖上不畫`
        : ''));
  }
  if (rule.margin && rule.margin() > 0) {
    out.push(`⚠ 圖上未含${rule.marginLabel()} ${fmt(rule.margin())} cm，下料時另加`);
  }
  if (head.name) out.push(`案件：${head.name}${head.date ? '　' + head.date : ''}`);

  for (const w of piece.warnings) out.push('⚠ ' + w);
  return out;
}

// ═══════════════════════════════════════════════════════
//  二、算繪到 Canvas
// ═══════════════════════════════════════════════════════

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} prog drawProgram 的產物
 * @param {number} px 每 cm 幾個像素
 */
export function renderCanvas(ctx, prog, px, opt = {}) {
  const b = prog.box;
  // 畫布座標：y 向下，所以整個翻過來
  const X = x => (x - b.x) * px;
  const Y = y => (b.y + b.h - y) * px;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  for (const it of prog.items) {
    const st = STYLE[it.style] || STYLE.cut;
    if (it.t === 'line') {
      ctx.beginPath();
      ctx.strokeStyle = st.color;
      // 螢幕上按真實線寬換算，但不得細於下限，否則縮小看就整條不見
      ctx.lineWidth = Math.max(st.minPx, st.w * px);
      ctx.setLineDash(st.dash ? st.dash.map(v => v * px) : []);
      ctx.moveTo(X(it.x1), Y(it.y1));
      ctx.lineTo(X(it.x2), Y(it.y2));
      ctx.stroke();
    } else if (it.t === 'circle') {
      ctx.beginPath();
      ctx.strokeStyle = st.color;
      ctx.lineWidth = Math.max(st.minPx, st.w * px);
      ctx.setLineDash([]);
      ctx.arc(X(it.x), Y(it.y), it.r * px, 0, Math.PI * 2);
      ctx.stroke();
    } else if (it.t === 'text') {
      ctx.save();
      ctx.setLineDash([]);
      ctx.fillStyle = st.color;
      ctx.font = `${Math.max(7, it.size * px)}px ${FONT}`;
      ctx.textAlign = it.anchor === 'middle' ? 'center' : (it.anchor === 'end' ? 'right' : 'left');
      ctx.textBaseline = 'middle';
      ctx.translate(X(it.x), Y(it.y));
      if (it.rot) ctx.rotate(it.rot * Math.PI / 180);
      ctx.fillText(it.s, 0, 0);
      ctx.restore();
    }
  }

  // 標題欄
  const lines = opt.title || [];
  if (lines.length) {
    ctx.setLineDash([]);
    ctx.fillStyle = '#111';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    let y = 6;
    lines.forEach((s, i) => {
      ctx.font = `${i === 0 ? 'bold ' : ''}${i === 0 ? 15 : 12}px "Noto Sans TC", sans-serif`;
      ctx.fillStyle = s.startsWith('⚠') ? '#c0392b' : '#111';
      ctx.fillText(s, 8, y);
      y += i === 0 ? 20 : 16;
    });
  }
  ctx.restore();
}

/** 把一片畫成一張 canvas（螢幕預覽與 PNG 匯出共用） */
export function pieceCanvas(piece, opt = {}) {
  const prog = drawProgram(piece, opt);
  const px = opt.px || fitScale(prog, opt.maxW || 1400, opt.maxH || 900);
  const title = titleLines(piece, opt);

  const cv = document.createElement('canvas');
  cv.width = Math.ceil(prog.box.w * px);
  cv.height = Math.ceil(prog.box.h * px) + 24 + title.length * 17;

  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.translate(0, 12 + title.length * 17);
  renderCanvas(ctx, prog, px);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  renderCanvas(ctx, { box: prog.box, items: [] }, px, { title });
  return cv;
}

function fitScale(prog, maxW, maxH) {
  return Math.max(1, Math.min(maxW / prog.box.w, maxH / prog.box.h));
}

// ═══════════════════════════════════════════════════════
//  三、算繪成 SVG
// ═══════════════════════════════════════════════════════

/**
 * SVG 是向量的，放多大都不糊，也丟得進 Illustrator 再編輯。
 * 尺寸用 cm 當單位直接寫進 width/height，
 * 所以印出來就是 1:1 的實際大小（前提是紙夠大）。
 *
 * ── 兩件被 Illustrator 打臉的事（2026-08-21）────────────
 *
 * **1. 一定要有 XML 宣告。**
 * 第一版直接從 `<svg` 開頭。瀏覽器認得，但 Illustrator 不認，
 * 它把整個檔案當成純文字開，畫面上就是一堆標籤原始碼；
 * 而且沒有編碼宣告，中文在 Big5 環境還會變亂碼。
 * → 開頭補 `<?xml version="1.0" encoding="UTF-8"?>`，兩個症狀一起解決。
 *
 * **2. Illustrator 不支援 dominant-baseline。**
 * 原本靠它把文字垂直置中，Illustrator 直接忽略，
 * 所有標註都會往上跳半個字高，尺寸數字跟尺寸線對不齊。
 * → 改成自己算基線位置。這是到處都通的做法，不依賴任何選用屬性。
 *
 * → **教訓**：要送出去給別的軟體開的格式，只能用最保守的寫法。
 *   「瀏覽器看起來對」不代表對。
 */
export function toSVG(piece, opt = {}) {
  return progSVG(drawProgram(piece, opt), titleLines(piece, opt));
}

/**
 * 把任何一份繪圖程式輸出成 SVG。
 *
 * 從 toSVG() 裡抽出來的，因為剖面分切也要用同一個算繪端 ——
 * 兩條路各寫一份 SVG 輸出，遲早會有一邊漏掉 Illustrator 的那兩個地雷。
 * 抽出來之後「怎麼畫出來」永遠只有這一份。
 */
export function progSVG(prog, title = []) {
  const b = prog.box;
  const head = title.length ? 1.2 * title.length + 1.5 : 0;

  const X = x => R2(x - b.x);
  const Y = y => R2(b.y + b.h - y + head);

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" `
    + `width="${R2(b.w)}cm" height="${R2(b.h + head)}cm" `
    + `viewBox="0 0 ${R2(b.w)} ${R2(b.h + head)}">`);
  out.push('<rect width="100%" height="100%" fill="#fff"/>');

  title.forEach((s, i) => {
    const size = i === 0 ? 1.1 : 0.9;
    out.push(`<text x="0.5" y="${R2(1.3 + i * 1.2)}" font-size="${size}" `
      + `font-family="${FONT}" fill="${s.startsWith('⚠') ? '#c0392b' : '#111'}"`
      + `${i === 0 ? ' font-weight="bold"' : ''}>${esc(s)}</text>`);
  });

  for (const it of prog.items) {
    const st = STYLE[it.style] || STYLE.cut;
    if (it.t === 'line') {
      out.push(`<line x1="${X(it.x1)}" y1="${Y(it.y1)}" x2="${X(it.x2)}" y2="${Y(it.y2)}" `
        + `stroke="${st.color}" stroke-width="${st.w}" stroke-linecap="round"`
        + (st.dash ? ` stroke-dasharray="${st.dash.join(' ')}"` : '') + '/>');
    } else if (it.t === 'circle') {
      out.push(`<circle cx="${X(it.x)}" cy="${Y(it.y)}" r="${R2(it.r)}" `
        + `fill="none" stroke="${st.color}" stroke-width="${st.w}"/>`);
    } else {
      const anchor = it.anchor === 'middle' ? 'middle' : (it.anchor === 'end' ? 'end' : 'start');
      // 垂直置中自己算：基線往下挪約 0.36 個字高，不用 dominant-baseline
      const ty = R2(Y(it.y) + it.size * 0.36);
      const tx = X(it.x);
      const rot = it.rot ? ` transform="rotate(${it.rot} ${tx} ${ty})"` : '';
      out.push(`<text x="${tx}" y="${ty}" font-size="${it.size}" `
        + `font-family="${FONT}" text-anchor="${anchor}" fill="${st.color}"`
        + `${rot}>${esc(it.s)}</text>`);
    }
  }

  out.push('</svg>');
  return out.join('\n');
}

const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ═══════════════════════════════════════════════════════
//  三之二、剖面分切的一片
// ═══════════════════════════════════════════════════════

/**
 * 把一片剖面轉成繪圖程式。跟 drawProgram() 是平行的兩個入口，
 * 產出的資料格式完全一樣，所以 renderCanvas / progSVG 一行都不用改。
 *
 * @param {object} slice section.js 的一片 { index, t, loops, area, bounds }
 * @param {object} opt {
 *    origin: {x,y}   全部片共用的座標原點（一律傳整疊外框的左下角）
 *    frame:  {w,h}   全部片共用的外框大小
 *    pegs:   [{x,y}] 定位孔中心（世界座標，跟 origin 同一個框）
 *    pegD:   number  孔徑
 *    total:  number  總片數，標題欄要用
 *    showDims, showNum
 * }
 */
export function sliceProgram(slice, opt = {}) {
  const items = [];
  const o0 = opt.origin || { x: slice.bounds.minX, y: slice.bounds.minY };
  const W = (opt.frame && opt.frame.w) || slice.bounds.w;
  const H = (opt.frame && opt.frame.h) || slice.bounds.h;
  const T = p => ({ x: p.x - o0.x, y: p.y - o0.y });

  /**
   * ── 所有片共用同一個座標框 ────────────────────────────
   * 每一片都可以各自貼齊自己的外框（圖會小一點），但那樣**孔跟輪廓的
   * 相對位置在每張圖上看起來都不一樣**，人就沒辦法用眼睛掃一遍
   * 確認「這一疊的孔位是不是真的對齊」。
   * 共用一個框的話，孔在每張圖上都落在同一個位置 —— 排開一看就知道對不對。
   */

  for (const l of slice.loops) {
    loop(items, l.pts.map(T), l.isHole ? 'hole' : 'cut');
  }

  /**
   * ── 定位孔畫在「切割」這一類，不另外分一層 ──────────────
   * 孔是**真的要切掉**的東西。分成獨立圖層的話，廠商只留切割層丟給機器時
   * 孔就漏掉了 —— 而漏掉的後果是整疊串不起來，全部報廢。
   * 顏色另外給，是為了在螢幕上分得出來；但它在製造上就是切割線。
   */
  const pegs = opt.pegs || [];
  const pr = (opt.pegD || 0) / 2;
  for (const p of pegs) {
    if (pr > 0) items.push({ t: 'circle', style: 'peg', ...T(p), r: pr });
  }

  /**
   * ── 層號放在第 1 孔的正下方 ──────────────────────────
   * 位置刻意固定，不放形心。因為它同時要當**朝向記號**：
   * 兩個一樣大的圓孔沒辦法阻止整疊翻 180 度，而對稱的件光看輪廓也看不出來。
   * 層號永遠在第 1 孔下面、永遠正著寫，疊的時候讓號碼朝同一邊就對了。
   */
  if (opt.showNum !== false) {
    const anchor = pegs.length ? T(pegs[0]) : { x: W / 2, y: H / 2 };
    const size = Math.max(0.9, Math.min(2.4, Math.min(W, H) * 0.08));
    items.push({
      t: 'text', style: 'num',
      x: anchor.x, y: anchor.y - Math.max(pr * 2.4, size * 1.4),
      s: `#${pad2(slice.index)} t${fmt(slice.t)}`,
      size, anchor: 'middle'
    });
  }

  if (opt.showDims !== false) {
    dim(items, 0, -2.5, W, -2.5, `${fmt(W)}`, 'h');
    dim(items, -2.5, 0, -2.5, H, `${fmt(H)}`, 'v');
  }

  const pad = { l: 5, r: 3, t: 3, b: 6 };
  return {
    w: W, h: H,
    box: { x: -pad.l, y: -pad.b, w: W + pad.l + pad.r, h: H + pad.b + pad.t },
    items
  };
}

/** 剖面分切的標題欄。缺了「第幾片、幾 mm 板」這張圖就不能用。 */
export function sliceTitleLines(slice, opt = {}) {
  const out = [];
  const holes = slice.loops.filter(l => l.isHole).length;

  out.push(`第 ${slice.index} 片${opt.total ? ` / 共 ${opt.total} 片` : ''}`
    + `　板厚 ${fmt(slice.t)} cm`);
  out.push(`輪廓 ${slice.loops.length - holes} 圈`
    + (holes ? `（另有內孔 ${holes} 個）` : '')
    + `　面積 ${fmt(slice.area)} cm²`
    + `　外框 ${fmt(slice.bounds.w)} × ${fmt(slice.bounds.h)} cm`);

  if (opt.pegs && opt.pegs.length) {
    /**
     * 只有孔①在每一片上都在同一個位置，是通到底的那根桿子。
     * 其餘的孔只屬於這一段 —— 這件事一定要寫出來，
     * 不然現場會拿一根長桿子想穿過全部，穿到一半才發現穿不過去。
     */
    out.push(`定位孔 ${opt.pegs.length} 個　⌀${fmt(opt.pegD || 0)} cm`
      + (opt.pegs.length > 1
        ? '　孔① 通到底（每一片都有），其餘只穿得過同一段的片'
        : '　孔① 通到底，每一片都有'));
  }
  if (opt.head && opt.head.name) {
    out.push(`案件：${opt.head.name}${opt.head.date ? '　' + opt.head.date : ''}`);
  }
  if (!slice.loops.length) out.push('⚠ 這一片是空的，切不出東西');
  if (slice.open) out.push(`⚠ 有 ${slice.open} 條線接不成封閉輪廓，這一片切不出來`);
  return out;
}

const pad2 = n => String(n).padStart(2, '0');

// ═══════════════════════════════════════════════════════
//  四、列印（A4 橫向，一片一頁）
// ═══════════════════════════════════════════════════════

/**
 * 跟「組裝系統結構說明表」同一套做法：另開一個視窗，
 * 把每一片放成一頁，交給瀏覽器自己的列印功能。
 *
 * 用 SVG 而不是點陣圖，因為列印機的解析度比螢幕高得多，
 * 點陣圖放到 A4 會糊掉。
 */
export function printPieces(pieces, opt = {}) {
  return printSVGs(pieces.map(p => toSVG(p, opt)), '展開圖');
}

/**
 * 一疊 SVG 一頁一張印出來。
 * 從 printPieces() 抽出來給剖面分切共用 —— 理由跟 progSVG() 一樣：
 * 頁面骨架（A4 橫向、分頁、把 XML 宣告拿掉）只該有一份。
 */
export function printSVGs(svgs, docTitle = '圖') {
  const win = window.open('', '_blank');
  if (!win) return false;

  // 內嵌進 HTML 時要把 XML 宣告拿掉 —— 那一行只有獨立的 .svg 檔需要，
  // 出現在 HTML 內文裡反而會被當成文字印出來
  const pages = svgs.map(s =>
    `<div class="page">${s.replace(/^<\?xml[^>]*\?>\s*/, '')}</div>`).join('\n');

  win.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>${esc(docTitle)}</title>
<style>
  @page { size: A4 landscape; margin: 8mm; }
  body { margin:0; font-family:"Noto Sans TC",sans-serif; }
  .page { page-break-after: always; padding: 4mm; }
  .page:last-child { page-break-after: auto; }
  svg { max-width:100%; height:auto; }
  @media screen { body { background:#eee; } .page { background:#fff; margin:8px auto; max-width:280mm; } }
</style></head><body>${pages}
<script>window.onload = function(){ setTimeout(function(){ window.print(); }, 300); };<\/script>
</body></html>`);
  win.document.close();
  return true;
}
