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
  /**
   * 🔴 **程式自己加的切線**（2026-10-12，kang 同意）—— 照樣要切，線寬跟切割線一樣，
   * 只是換成橘色，看得出「這條不是你標的」。理由見 `flatten.js` 的 `piece.autoCut`。
   * DXF 放 `CUT_AUTO` 層（`dxf.js`）。
   */
  autoCut: { w: 0.050, minPx: 1.6, dash: null,      color: '#e67e22', label: '程式加的切線' },
  /**
   * 🔴 **省道打版的開口**（2026-10-12）。紫色 ＝ kang 在樣板上看過的開口顏色
   * （⚠ 3D 上改成黃綠是因為 3D 的紫色撞到「非流形邊」；展開圖上紫色沒有別的意思）。
   * `dartCut` 剪掉的 V 形缺口 —— 要切（DXF 在 CUT 層）；
   * `dartSew` 只畫縫線、不剪 —— 虛線，DXF 在 SEW 層（⛔ 是切割線）。
   */
  dartCut: { w: 0.050, minPx: 1.6, dash: null,      color: '#8e44ad', label: '開口（剪掉）' },
  dartSew: { w: 0.030, minPx: 1.2, dash: [0.6, 0.4], color: '#8e44ad', label: '開口縫線（不剪）' },
  hole: { w: 0.040, minPx: 1.3, dash: null,        color: '#111', label: '內孔' },
  fold: { w: 0.030, minPx: 1.1, dash: [1.2, .5, .3, .5], color: '#c0392b', label: '折線' },
  /**
   * 🔴 **上折、下折分兩種線**（2026-10-19，實驗 T3、T8：`實驗-綜合評估.md` ①-10，kang「同意你的安排與建議」）。
   * ⚠ 以前同一種紅線，方向只寫在折彎標註的字裡；DXF 只有線 ⇒ 送出去的檔看不出往哪邊折。
   * ⭐ 上折照舊點劃線、下折改虛線；DXF 分 `FOLD_UP`／`FOLD_DOWN` 兩層（`dxf.js`）。哪一種 ⇒ `foldStyle()`。
   */
  foldUp:   { w: 0.030, minPx: 1.1, dash: [1.2, .5, .3, .5], color: '#c0392b', label: '上折線' },
  /**
   * 🔴 **畫縫份／黏合片**（2026-10-19，`實驗-綜合評估.md` ①-7，kang「同意」）：勾了之後原本的外框變成這兩種（`marginGeometry()`）。
   * `seamSew` 帆布的縫線（外面那圈才是裁切線）—— DXF 在 SEW 層（⛔ 切）；`tabFold` 紙模黏合片的折線 —— DXF 在 FOLD 層。
   */
  seamSew:  { w: 0.030, minPx: 1.1, dash: [0.5, 0.3],        color: '#555',    label: '縫線（原本的外框）' },
  tabFold:  { w: 0.030, minPx: 1.1, dash: [0.4, 0.3],        color: '#7f8c8d', label: '黏合片折線' },
  foldDown: { w: 0.030, minPx: 1.1, dash: [0.7, 0.45],       color: '#c0392b', label: '下折線' },
  bend: { w: 0.025, minPx: 1.0, dash: [0.8, 0.5],  color: '#2980b9', label: '折彎區' },
  dim:  { w: 0.018, minPx: 0.8, dash: null,        color: '#666',  label: '尺寸' },
  /**
   * 接合編號。用綠色是為了跟切割線（黑）、折線（紅）、折彎區（藍）、
   * 尺寸（灰）都分得開 —— 師傅在圖上找「號碼」時不必先分辨那是不是尺寸。
   */
  joint: { w: 0.020, minPx: 0.9, dash: null,       color: '#1e8449', label: '接合編號' },
  /**
   * 🔴 **對位記號**（2026-10-12，`notchMarks()`）。
   * `notchCut` 要切（一小刀、小三角）—— 線寬、顏色跟切割線一樣（DXF 在 `CUT_NOTCH` 層）；
   * `notchMark` 只畫、⛔ 切 —— 青綠色，跟接合編號的綠、折線的紅分得開（DXF 在 `MARK` 層）。
   */
  notchCut:  { w: 0.050, minPx: 1.6, dash: null,   color: '#111',    label: '對位刻口（切）' },
  notchMark: { w: 0.030, minPx: 1.3, dash: null,   color: '#16a085', label: '對位記號（不切）' },
  /**
   * 剖面分切用的兩個。
   *
   * peg 是定位孔 —— **它跟輪廓一樣是要被切掉的**，所以線寬比照切割線，
   * 顏色另外給是為了在螢幕上一眼認出來（紫色在這張圖上沒有別的東西用）。
   * num 是層號，只給人看。
   */
  peg:  { w: 0.045, minPx: 1.4, dash: null,        color: '#8e44ad', label: '定位孔' },
  /** 剖面疊起來掉下來的塊（紅圈）、只黏一點點的塊（黃圈）—— 第二輪第五批 5a，**只在畫面預覽**（`sliceProgram()` 的 `marks`），⛔ 進 DXF、SVG */
  markLoose: { w: 0.06, minPx: 2, dash: null,        color: '#e74c3c', label: '掉下來的塊' },
  markWeak:  { w: 0.06, minPx: 2, dash: null,        color: '#ef9f27', label: '只黏一點點' },
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
import { csgReady, offsetLoop } from '../build/bool.js';
import { DART_HINT } from '../unfold/flatten.js';

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

  /**
   * ── 省道打版：每個面依拉／壓上色（2026-10-12）──
   * ⚠ **只在 `opt.strainFill` 時畫**：畫面與列印要；存 SVG／DXF ⛔ 要（送去切的檔⛔ 帶色塊 ——
   * kang 2026-10-12「依照你的建議處理」）。放在最前面 ⇒ 線畫在色塊上面。
   */
  /**
   * 分片地圖（2026-10-21，`分片成群-設計方向.md` 第二件）：每一片一個顏色、跟 3D 上同一個顏色 ——
   * 只有即時預覽傳 `opt.pieceFill`（片 → 顏色）；存 SVG／DXF、列印⛔ 傳 ⇒ 送去切的檔⛔ 帶色塊。
   * 放在拉伸色塊前面 ⇒ 省道打版的拉／壓顏色蓋在上面（那個比較要緊）。
   */
  const mapFill = opt.pieceFill ? opt.pieceFill(piece) : null;
  if (mapFill) piece.faces.forEach(poly => items.push({ t: 'poly', style: 'map', pts: poly, fill: mapFill }));
  if (opt.strainFill && piece.strain) {
    piece.faces.forEach((poly, i) => items.push({ t: 'poly', style: 'strain', pts: poly, fill: strainColor(piece.strain.faces[i]) }));
  }
  /**
   * 疊在一起的面塗紅（2026-10-21，`分片成群-設計方向.md` 第一件）—— 跟拉伸色塊同一個開關：畫面、列印、即時預覽有，
   * 存 SVG／DXF ⛔ 有（送去切的檔⛔ 帶色塊）。⚠ 有重疊的圖本來就不能下料，紅色是告訴你往哪裡切。
   */
  if (opt.strainFill && piece.overlapFaces && piece.overlapFaces.length) {
    for (const i of piece.overlapFaces) {
      if (piece.faces[i]) items.push({ t: 'poly', style: 'overlap', pts: piece.faces[i], fill: OVERLAP_FILL });
    }
  }

  // ── 輪廓與內孔（程式自己加的那幾段換成橘色、開口紫色：`outlineSegments()`）──
  for (const s of outlineSegments(piece, opt).segs) {
    items.push({ t: 'line', style: s.style, x1: s.a.x, y1: s.a.y, x2: s.b.x, y2: s.b.y });
  }

  /** 省道打版：「畫折線」打勾才畫（2026-10-12，`piece.dartFolds`）—— 只畫線、⛔ 標角度，跟精確分片的折線同一種線（DXF 在 FOLD 層）*/
  if (opt.dartFolds && piece.dartFolds) {
    for (const f of piece.dartFolds) line('fold', f.a.x, f.a.y, f.b.x, f.b.y);
  }

  /** 對位記號：「對位記號」打勾才畫（2026-10-12，`notchMarks()`）*/
  for (const l of notchMarks(piece, opt).lines) line(l.style, l.a.x, l.a.y, l.b.x, l.b.y);

  // ── 折線 ──
  // 圓弧折彎帶「裡面」那些線是網格切出來的，不是真的要折的地方，
  // 畫出來只會讓師傅以為要折五道。只畫折彎區的起訖線。
  for (const f of piece.folds) {
    if (f.isArcEdge) continue;
    line(foldStyle(f), f.a.x, f.a.y, f.b.x, f.b.y);
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
   * ⭐ 「在不在料上」＝ 在 `outline` 裡、而且不在任何一個 `holes` 裡（下面的 `onMaterial`）。
   * 〔2026-10-12 以前環形片**沒有** `holes`：它的 `outline` 是一條從外圈**穿過缺口**繞到內圈的線，
   * 　那條缺口是程式自己剪、兩側其實貼在一起的一刀。那一刀⛔ 不剪了之後內圈才變成真正的洞，
   * 　號碼也從 66 變 64。判準本來就連洞一起問，所以這裡一行都不用改。〕
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
    /** 圓錐面（`radial`，2026-10-19 ①-11）：折線是放射狀的，直的起訖線、中心線畫了只會誤導 ⇒ ⛔ 畫（卡片講）*/
    if (!b.isArc || b.radial) continue;
    line('bend', b.x0, 0, b.x0, H);
    line('bend', b.x1, 0, b.x1, H);
    // 中心線：折床對位用
    const cx = (b.x0 + b.x1) / 2;
    line('bend', cx, -1, cx, H + 1);
  }

  // ── 折彎標註（角度、內側 R、往哪折）──
  // 折彎多的件（例如四角都倒圓的護罩）標註會互相重疊，
  // 所以跟下方的分段尺寸一樣錯開成兩排，兩排都塞不下才略過。
  // ⭐ 「相同的折線合成一行」開著、而且這片的折線全部一樣 → 圖上只畫線，角度寫在卡片上（`sameFolds()`）
  let topUsed = 0;
  if (opt.showBendMarks !== false && !(opt.foldSummary && sameFolds(piece))) {
    const rows = [H + 2.2, H + 7.0];
    const rowEnd = [-Infinity, -Infinity];

    for (const b of [...piece.bends].sort((p, q) => p.x0 - q.x0)) {
      if (b.radial) continue;                      // 圓錐面：⛔ 標（寬度、方向都⛔ 有一個數字可言，卡片講）
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
  /** 勾了縫份／黏合片：圖面要包住外面那一圈（`marginGeometry()`）*/
  const fb = pieceFootprint(piece, opt);
  const bx0 = Math.min(-pad.l, fb.x0 - 1), by0 = Math.min(-pad.b, fb.y0 - 1);
  const bx1 = Math.max(W + pad.r, fb.x1 + 1), by1 = Math.max(H + top, fb.y1 + 1);
  return {
    w: W, h: H,
    box: { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 },
    items,
    jointInfo
  };
}

/**
 * 🔴 **輪廓與內孔的每一段要畫成哪一種線** —— 展開圖與 DXF 共用這一支（⛔ 各判斷一次，兩邊一定會漂）。
 *
 * | 線 | 什麼時候 |
 * |---|---|
 * | `cut`／`hole` | 一般切割線 |
 * | `autoCut` | 程式自己加的（只在標過分片的物件：`piece.autoCut.outline`）|
 * | `dartCut` | 省道打版的開口、「剪掉的 V 形缺口」（預設）|
 * | `dartSew` ＋ 口子一條 `cut` | 省道打版的開口、「只畫縫線（不剪）」：V 的兩邊畫虛線，口子用一條切割線接起來（布沒剪開）|
 *
 * ⭐ 「口子」怎麼認：開口在輪廓上是連續的一串開口段，從口子的一側走到尖端、再走回口子的另一側；
 * 口子的兩側是**同一個頂點**（`vids`）的兩個分身。⇒ 一串開口段裡，**走回起點那個頂點**就是一個開口的結束
 * （同一個口子連著好幾道開口時 —— 例如球的極點 —— 就這樣一道一道切開）。
 *
 * @param {object} opt `{ dartStyle: 'cut'|'sew' }`
 * @returns {{segs: {a,b,style}[], darts: number}} `darts` ＝ 開口有幾道
 */
export function outlineSegments(piece, opt = {}) {
  const segs = [];
  let darts = 0;
  const ac = piece.autoCut || {}, dc = piece.dartCut;
  const sew = opt.dartStyle === 'sew';
  const loops = [[piece.outline, 'cut', ac.outline, dc && dc.outline, dc && dc.vids],
    ...piece.holes.map((h, k) => [h, 'hole', ac.holes && ac.holes[k], dc && dc.holes[k], dc && dc.holeVids[k]])];
  /** 畫縫份／黏合片（`opt.margin`）：原本的外框換成縫線或折線、外面那圈的裁切線加在最後（`marginGeometry()`）*/
  const mg = marginGeometry(piece, opt);
  for (const [pts, base, auto, dart, vids] of loops) {
    const n = pts.length;
    const style0 = i => (auto && auto[i]) ? 'autoCut' : (dart && dart[i]) ? (sew ? 'dartSew' : 'dartCut') : base;
    const style = i => {
      const st = style0(i);
      if (!mg || st === 'dartCut' || st === 'dartSew') return st;
      return mg.over(pts[i], pts[(i + 1) % n], base) || st;
    };
    for (let i = 0; i < n; i++) segs.push({ a: pts[i], b: pts[(i + 1) % n], style: style(i) });
    if (!dart || !dart.some(Boolean)) continue;
    /**
     * 一道一道數開口（也是「只畫縫線」要接口子的地方）。
     * 從「前一段不是開口」的那一段開始（⛔ 從一道開口的中間開始數），把整圈攤成一條直的來走：
     * 第 b 點是口子（頂點 M）→ 往前走，第一個又是 M 的點 j ＝ 另一側的口子，b..j−1 全是開口段 ⇒ 一道。
     */
    const start = dart.findIndex((d, i) => d && !dart[(i - 1 + n) % n]);
    if (start < 0) continue;                                     // 整圈都是開口（不會發生，保險）
    const at = k => (start + k) % n;
    let k = 0;
    while (k < n) {
      if (!dart[at(k)]) { k++; continue; }
      const M = vids[at(k)];
      let j = k + 1;
      while (j < n && dart[at(j - 1)] && vids[at(j)] !== M) j++;
      if (j <= n && vids[at(j % n)] === M && dart[at(j - 1)]) {
        darts++;
        if (sew) segs.push({ a: pts[at(k)], b: pts[at(j % n)], style: base });
        k = j;
      } else {
        k = j;                                                   // 走不回口子（不是 V）：⛔ 硬接，往下找
      }
    }
  }
  if (mg) for (const c of mg.cuts) segs.push({ a: c.a, b: c.b, style: 'cut' });
  return { segs, darts };
}

/**
 * 🔴 **畫縫份／黏合片**（2026-10-19，實驗 T5、T8：`實驗-綜合評估.md` ①-7，kang「關於縫份、黏合片…能夠變成選項…有需要時才會觸發」→「同意」）。
 *
 * ⚠ 以前一律⛔ 畫，卡片寫「圖上未含…下料時另加」，紙模的材質說明卻寫「外圍自動加黏合片」—— 說明跟圖對不起來。
 * ⭐ 現在是展開圖上的勾選（`opt.margin = { on, w }`，預設⛔ 勾 ⇒ 原本的圖一個字都不變），只有材質有縫份／黏合片時才出現：
 *
 * | 情形 | 外面加什麼（裁切線）| 原本的外框變成 |
 * |---|---|---|
 * | 帆布（縫份）| 外框往外推 `w` 一整圈；每個洞往內縮 `w`（洞小到縮沒了 ⇒ 那個洞不留，卡片講）| 縫線 `seamSew` |
 * | 紙模、標過分片（有接合編號）| 每一對接縫**只在一邊**長梯形黏合片（`run.tab`，`unfold/part.js` 決定哪一邊）| 長了黏合片的那幾段變折線 `tabFold`，其他照舊切 |
 * | 紙模、沒標過分片 | 外框往外推 `w` 一整圈（kang 同意：勾了卻沒反應會讓人以為壞了）| 折線 `tabFold` |
 *
 * ⚠ 尺寸數字（外框、面積）照舊是完成線；卡片另外寫「含…外框」。排版照含縫份／黏合片的外框排（`pieceFootprint()`）。
 * ⚠ 一樣的片會算好幾次（畫面、SVG、DXF、排版）⇒ 算過的記在片上（⛔ 列舉，不會跟著存出去）。
 * ⚠ 黏合片⛔ 檢查會不會跟這一片自己或別的黏合片疊在一起（凹進去很深的地方可能會）。
 * @returns {null|{kind:'seam'|'tab'|'ring', w, label, cuts:{a,b}[], over:(a,b,base)=>string|null, bounds:{x0,y0,x1,y1}, tabs:number, lostHoles:number, notReady:boolean}}
 */
export function marginGeometry(piece, opt = {}) {
  const M = opt.margin;
  const rule = piece.rule || opt.rule || {};
  const def = rule.margin ? rule.margin() : 0;
  if (!M || !M.on || !(def > 0)) return null;
  const w = +M.w > 0 ? +M.w : def;
  const label = rule.marginLabel ? rule.marginLabel() : '';
  const hasRuns = !!(piece.seamRuns && piece.seamRuns.length);
  const kind = label === '黏合片' ? (hasRuns ? 'tab' : 'ring') : 'seam';
  const key = `${kind}|${w}|${(piece.seamRuns || []).map(r => (r.tab ? 1 : 0)).join('')}|${csgReady() ? 1 : 0}`;
  if (piece._margin && piece._margin.key === key) return piece._margin.geo;

  const W = piece.width, H = piece.height;
  const cuts = [];
  let tabs = 0, lostHoles = 0, notReady = false;
  const loopCuts = L => { for (let i = 0; i < L.length; i++) cuts.push({ a: L[i], b: L[(i + 1) % L.length] }); };
  let over = () => null;

  if (kind === 'seam' || kind === 'ring') {
    if (!csgReady()) notReady = true;
    else {
      for (const L of offsetLoop(piece.outline, w)) loopCuts(L);
      if (kind === 'seam') {
        for (const h of piece.holes) {
          const inner = offsetLoop(h, -w);
          if (!inner.length) lostHoles++;
          for (const L of inner) loopCuts(L);
        }
      }
    }
    /** 帆布：外框與洞都變縫線；紙模外圍一圈：只有外框變折線（洞照舊切）*/
    over = (a, b, base) => (notReady ? null : kind === 'seam' ? 'seamSew' : base === 'cut' ? 'tabFold' : null);
  } else {
    const onMaterial = (x, y) => {
      if (!pointInPoly(x, y, piece.outline)) return false;
      for (const h of (piece.holes || [])) if (pointInPoly(x, y, h)) return false;
      return true;
    };
    const bases = [];
    for (const run of piece.seamRuns) {
      if (!run.tab) continue;
      tabs++;
      for (const g of run.segs) {
        const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y, L = Math.hypot(dx, dy);
        if (!(L > 1e-9)) continue;
        const T = { x: dx / L, y: dy / L };
        let n = { x: -T.y, y: T.x };
        const mx = (g.a.x + g.b.x) / 2, my = (g.a.y + g.b.y) / 2, e = 0.05;
        if (onMaterial(mx + n.x * e, my + n.y * e)) n = { x: -n.x, y: -n.y };   // 往料的外面長
        const ins = Math.min(w, L / 4);                                          // 兩端斜進去（梯形）
        const a2 = { x: g.a.x + n.x * w + T.x * ins, y: g.a.y + n.y * w + T.y * ins };
        const b2 = { x: g.b.x + n.x * w - T.x * ins, y: g.b.y + n.y * w - T.y * ins };
        cuts.push({ a: g.a, b: a2 }, { a: a2, b: b2 }, { a: b2, b: g.b });
        bases.push(g);
      }
    }
    /** 外框上的這一段落在某一個黏合片的底邊上 ⇒ 變折線（外框可能把共線的點併掉，所以用「中點在不在底邊上」判斷）*/
    over = (a, b) => {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      for (const g of bases) {
        const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y, L2 = dx * dx + dy * dy;
        if (!(L2 > 0)) continue;
        const t = ((mx - g.a.x) * dx + (my - g.a.y) * dy) / L2;
        if (t < -1e-6 || t > 1 + 1e-6) continue;
        if (Math.hypot(g.a.x + dx * t - mx, g.a.y + dy * t - my) < 1e-6) return 'tabFold';
      }
      return null;
    };
  }

  const b = { x0: 0, y0: 0, x1: W, y1: H };
  for (const c of cuts) for (const q of [c.a, c.b]) {
    b.x0 = Math.min(b.x0, q.x); b.y0 = Math.min(b.y0, q.y); b.x1 = Math.max(b.x1, q.x); b.y1 = Math.max(b.y1, q.y);
  }
  const geo = { kind, w, label, cuts, over, bounds: b, tabs, lostHoles, notReady };
  Object.defineProperty(piece, '_margin', { value: { key, geo }, writable: true, configurable: true, enumerable: false });
  return geo;
}

/** 這一片佔多大（片的座標）：勾了縫份／黏合片 ⇒ 含外面那一圈；沒勾 ⇒ 0..寬、0..高。排版、DXF 一長條用它 */
export function pieceFootprint(piece, opt = {}) {
  const g = marginGeometry(piece, opt);
  return g ? g.bounds : { x0: 0, y0: 0, x1: piece.width, y1: piece.height };
}

/**
 * 對位記號的幾個固定尺寸（cm）。
 * `endGap` 離段尾不到這麼近的那一個⛔ 放（會跟端點的角疊在一起，端點本來就對得上）；
 * `double` 雙刻口兩條的間隔（服裝業約 1/4 吋）；`inDepth` 往內切多深；`markLen` 只畫線時的長度。
 */
export const NOTCH = { endGap: 1, double: 0.5, inDepth: 0.3, markLen: 0.5 };

/**
 * 一道折線畫哪一種線（2026-10-19，綜合評估 ①-10）：轉角正 ＝ 上折、負 ＝ 下折 —— 跟折彎標註「↑ 上折／↓ 下折」同一個判準（`b.angle > 0`）。
 * 角度 0（理論上不會有折線）⇒ 照舊 `fold`。
 */
export function foldStyle(f) {
  const a = f && f.angle;
  return a > 1e-9 ? 'foldUp' : a < -1e-9 ? 'foldDown' : 'fold';
}

/**
 * 🔴 **對位記號**（2026-10-12，kang 拍板 → `規格\建模器-對位記號.md`）—— 畫面、列印、SVG、DXF 共用這一支。
 *
 * 每一條有接合編號的縫（`piece.seamRuns`，兩側同一個起點、同一個方向），從起點量起每隔 `spacing` cm 放一個；
 * 每條第一個多畫一條（雙刻口），看得出哪一端對哪一端。
 * ⚠ 「一條縫」⛔ 是「同一個接合編號的一段」：接合編號走到折線就換號碼（球一格一個號碼），
 * 這裡只在三條以上切割邊交會處斷開 —— 理由見 `flatten.js` 的 `collectSeamRuns()`。距離用 **3D 長度**量、再照比例落到那條邊的 2D 上
 * ⇒ 兩側的記號換回 3D 是同一個點。
 *
 * | `style` | 畫什麼 | 方向 |
 * |---|---|---|
 * | `slit` 往內／外切一小刀 | 一條要切的線 | 材質有縫份或黏合片（`rule.margin()`）⇒ **往外**：畫在之後要加的那一圈裡，從那一圈的外緣往內切一半；沒有 ⇒ 往內 0.3 |
 * | `v` 剪掉小三角 | 兩條要切的線（三角形的兩邊；往內時底邊就是外框）| 同上 |
 * | `mark` 只畫短線、不切 | 一條只畫的線 | 一律往內 0.5（畫在料上才描得到）|
 *
 * ⚠ 「往內」用的是「落在料上」那一側（在外框裡、⛔ 在洞裡），跟接合編號同一個判準；分不出來才退回朝重心。
 *
 * @param {object} opt `{ notch: {style, spacing}, rule }`；⛔ 給 `notch` ⇒ 一條都不畫
 * @returns {{lines:{style,a,b}[], count:number, short:number, dir:'in'|'out', depth:number}}
 *          `count` 記號幾個（雙刻口算一個）；`short` 幾條縫太短（< 2 cm）沒有放；`mid` 幾條比間距短、放在正中間
 */
export function notchMarks(piece, opt = {}) {
  const N = opt.notch;
  const res = { lines: [], count: 0, short: 0, mid: 0, dir: 'in', depth: 0 };
  if (!N || !(N.spacing > 0) || !piece.seamRuns || !piece.seamRuns.length) return res;

  const rule = piece.rule || opt.rule || {};
  /**
   * 往外切的深度看「之後要加的那一圈」有多寬：勾了畫縫份／黏合片 ⇒ 照畫出來的寬度；
   * ⚠ 紙模一邊長黏合片（`tab`）⇒ 另一邊外面沒有東西 ⇒ 一律往內切（跟沒有縫份的材質一樣）。
   */
  const mgN = marginGeometry(piece, opt);
  const m = mgN ? (mgN.kind === 'tab' ? 0 : mgN.w) : (rule.margin ? rule.margin() : 0);
  const cut = N.style !== 'mark';
  const out = cut && m > 0;
  res.dir = out ? 'out' : 'in';
  res.depth = !cut ? NOTCH.markLen : out ? m / 2 : NOTCH.inDepth;
  const style = cut ? 'notchCut' : 'notchMark';
  const d = res.depth;

  const cx = piece.outline.reduce((s, p) => s + p.x, 0) / (piece.outline.length || 1);
  const cy = piece.outline.reduce((s, p) => s + p.y, 0) / (piece.outline.length || 1);
  const onMaterial = (x, y) => {
    if (!pointInPoly(x, y, piece.outline)) return false;
    for (const h of (piece.holes || [])) if (pointInPoly(x, y, h)) return false;
    return true;
  };
  const push = (a, b) => res.lines.push({ style, a, b });

  /** 在這一段縫上、離起點 s（3D 長度）的地方放一個 */
  const place = (run, s) => {
    let acc = 0;
    for (const g of run.segs) {
      if (acc + g.len < s - 1e-9) { acc += g.len; continue; }
      const t = g.len > 0 ? (s - acc) / g.len : 0;
      const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y, L = Math.hypot(dx, dy);
      if (!(L > 1e-9)) return;
      const P = { x: g.a.x + dx * t, y: g.a.y + dy * t };
      const T = { x: dx / L, y: dy / L };
      let n = { x: -T.y, y: T.x };
      const e = 0.05;
      const okA = onMaterial(P.x + n.x * e, P.y + n.y * e), okB = onMaterial(P.x - n.x * e, P.y - n.y * e);
      const inward = okA !== okB ? okA : (cx - P.x) * n.x + (cy - P.y) * n.y >= 0;
      if (!inward) n = { x: -n.x, y: -n.y };
      const at = (k, w = 0) => ({ x: P.x + n.x * k + T.x * w, y: P.y + n.y * k + T.y * w });
      if (!cut) push(at(0), at(d));
      else if (!out && N.style === 'v') { push(at(0, d / 2), at(d)); push(at(0, -d / 2), at(d)); }
      else if (!out) push(at(0), at(d));
      /** 往外：之後要加的那一圈外緣在 −m，刻口從那裡往完成線切一半（−m → −m/2） */
      else if (N.style === 'v') { push(at(-m, d / 2), at(-m + d)); push(at(-m, -d / 2), at(-m + d)); }
      else push(at(-m), at(-m + d));
      return;
    }
  };

  for (const run of piece.seamRuns) {
    const L = run.segs.reduce((s, g) => s + g.len, 0);
    const at = [];
    for (let k = 1; k * N.spacing <= L - NOTCH.endGap + 1e-9; k++) at.push(k * N.spacing);
    /**
     * 🔴 **比間距短的縫：正中間放一個**（2026-10-19，實驗 T3、T5、T8：`實驗-綜合評估.md` ①-12，kang「同意你的安排與建議」）。
     * ⚠ 以前一個都不放 —— 盒子 8 cm 的轉角縫（間距 10）最需要對齊，反而沒有。
     * ⭐ 正中間兩側量起來一樣，⛔ 管起點；離兩端都要 ≥ `endGap` ⇒ 縫至少 2 cm，再短才不放（卡片照舊講幾條）。
     */
    if (!at.length && L >= 2 * NOTCH.endGap - 1e-9) { at.push(L / 2); res.mid++; }
    if (!at.length) { res.short++; continue; }
    res.count += at.length;
    if (at[0] + NOTCH.double < L - 1e-9) at.push(at[0] + NOTCH.double);
    for (const s of at) place(run, s);
  }
  return res;
}

/** 卡片上那一行的後半：刻口長什麼樣、往哪邊、多深 */
function notchWords(style, r, rule) {
  if (style === 'mark') return `只畫短線、不切（往內 ${fmt(r.depth)} cm）`;
  const what = style === 'v' ? '剪掉小三角' : '切一小刀';
  if (r.dir === 'in') return `往內${what} ${fmt(r.depth)} cm`;
  const lb = rule.marginLabel ? rule.marginLabel() : '';
  return `往外${what} ${fmt(r.depth)} cm（畫在${lb}那一圈裡，加上${lb}之後剛好從邊上剪進來）`;
}

/**
 * 一圈點 → 一圈同一種線。⚠ 剖面分切（`sliceProgram()`）還在用 —— 展開圖改走 `outlineSegments()` 時
 * 一度把它刪掉，**測試當場抓到**（2026-10-12；模組解析抓不到執行期才找不到的名字）。
 */
function loop(items, pts, style) {
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    items.push({ t: 'line', style, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
  }
}

/** 疊在一起的面（`drawProgram()`）：半透明紅 ⇒ 底下的折線、切割線照樣看得到 */
export const OVERLAP_FILL = 'rgba(231, 76, 60, 0.45)';
/** 剖面疊起來掉下來的塊（紅）、只黏一點點的塊（黃）—— 第二輪第五批 5a，只在畫面預覽塗 */
export const STACK_LOOSE_FILL = 'rgba(231, 76, 60, 0.45)';
export const STACK_WEAK_FILL = 'rgba(239, 159, 39, 0.55)';

/** 拉伸 → 顏色：紅＝拉長、藍＝壓縮、白＝幾乎沒變；5% 以上全色（跟 `樣板-省道打版-點法.html` 同一套）*/
export function strainColor(e) {
  const t = Math.min(1, Math.abs(e || 0) / 0.05), m = a => Math.round(255 + (a - 255) * t);
  return e > 0 ? `rgb(${m(214)},${m(60)},${m(50)})` : `rgb(${m(40)},${m(110)},${m(220)})`;
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
/**
 * 🔴 **這一片的折線是不是「全部一樣」**（2026-10-09，kang 拍板「相同的折線合成一行」）。
 *
 * 起因：打版（圓環切成 32 條西瓜皮）每條約 11 道折線，每道都印「↑ 上折 30°　尖角」，字擠滿圖。
 * kang：只畫線，角度改成一行總表。
 *
 * 🔴🔴 **⛔ 只在「全部一樣」時才合成一行** —— 上折與下折畫的是**同一種紅線**（`STYLE.fold`），
 * 往哪折只寫在字裡。一片裡有上有下（例如齒輪側邊那條帶子）還合成一行，
 * 就分不出哪條往哪折 ⇒ 資訊不見了。所以那種照樣每道標字（kang 同意）。
 *
 * 全部一樣 ＝ ① 兩道以上 ② 全是尖角（⛔ 圓弧折彎、曲線帶 —— 那些要給師傅看 R 與段數）
 *          ③ 同一個方向 ④ 角度差不到 0.05°。
 * @returns {{dir:string, angle:number, n:number}|null}
 */
export function sameFolds(piece) {
  const bs = piece && piece.bends;
  if (!bs || bs.length < 2) return null;
  if (bs.some(b => b.isArc || b.isCurve)) return null;
  const a0 = bs[0].angle;
  const same = b => Math.sign(b.angle) === Math.sign(a0)
    && Math.abs(Math.abs(b.angle) - Math.abs(a0)) < 0.05;
  if (!bs.every(same)) return null;
  return { dir: a0 > 0 ? '↑ 上折' : '↓ 下折', angle: Math.abs(a0), n: bs.length };
}

/**
 * 片數從哪來（2026-10-21，綜合評估 ⑥-1）：「×8 片（2 個一樣的物件 × 陣列 2 份 × 每份 2 片）」。
 * 資料是 `unfold/part.js` 掛的 `qtyFrom`；沒有來源可講（一般物件）⇒ 空字串。
 * ⚠ 寫成乘式的每一項乘起來一定等於片數；乘不出來的（陣列除不盡）只另外講「是陣列 N 份」。
 */
export function qtyWords(piece) {
  const f = piece.qtyFrom;
  if (!f) return '';
  const mult = [];
  if (f.objs) mult.push(`${f.objs} 個一樣的物件`);
  if (f.copies && f.per !== undefined) mult.push(`陣列 ${f.copies} 份`, `每份 ${f.per} 片`);
  else if (f.objs) mult.push(`每個 ${f.each} 片`);
  let s = mult.length >= 2 ? mult.join(' × ') : '';
  if (f.copies && f.per === undefined) s += `${s ? '；' : ''}物件是陣列 ${f.copies} 份`;
  return s ? `（${s}）` : '';
}

export function titleLines(piece, opt = {}) {
  /** ⚠ 這一片自己的規則優先 —— 多個物件一起展開時板厚可能不一樣（2026-10-08）*/
  const rule = piece.rule || opt.rule || {};
  const head = opt.head || {};
  const out = [];

  /** ⚠ 片號放最前面 —— 跟 DXF 標題、CSV 第一欄是同一個號碼（2026-10-08 E9）*/
  out.push(`${piece.no ? piece.no + '　' : ''}${piece.name}　×${piece.qty} 片${qtyWords(piece)}`);
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
  /** 實體的片（`solidBody`，2026-10-19 ①-9）⛔ 寫物件身上看不見的 0.2 */
  if (piece.solidBody) spec.push('板厚 —（實體）');
  else if (rule.thickness) spec.push(`板厚 ${fmt(rule.thickness)} cm`);
  if (spec.length) out.push(spec.join('　'));
  /** 折板的折彎長度照折板自己的 K（2026-10-19 ①-13，`unfold/part.js` `bendK`）—— 跟展開圖選的材質無關，講出來 */
  if (piece.bendK !== undefined) out.push(`折彎長度照折板自己的 K ${fmt(piece.bendK)} 算（在物件面板改），跟這裡選的材質無關`);
  /** 🔴 實心的板只出一片外形＋洞（2026-10-19，`unfold/part.js` `solidPlate()`）—— 講出來，免得以為少了邊條 */
  if (piece.solidPlate) out.push(`實心板：只出一片外形＋洞（厚 ${fmt(piece.solidPlate.t)} cm，不是攤開的盒子）`);

  /** 省道打版的面積是**攤平後的**（布要買多少），跟 3D 表面積不一樣 —— 寫清楚是哪一個 */
  out.push(`外框 ${fmt(piece.width)} × ${fmt(piece.height)} cm`
    + `　面積 ${fmt(piece.area)} cm²${piece.strain ? '（攤平後）' : ''}`);

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

  /** 對位記號（2026-10-12）：打勾、而且這片有接合編號才講 —— 幾個、怎麼量、長什麼樣；太短沒放的也講 */
  if (opt.notch && piece.seamRuns && piece.seamRuns.length) {
    const nm = notchMarks(piece, opt), sp = opt.notch.spacing;
    const mid = nm.mid ? `；${nm.mid} 條縫比 ${fmt(sp + NOTCH.endGap)} cm 短，放在正中間` : '';
    const short = nm.short ? `；${nm.short} 條縫比 ${fmt(2 * NOTCH.endGap)} cm 短，沒有放` : '';
    out.push(nm.count
      ? `對位記號 ${nm.count} 個（每 ${fmt(sp)} cm，一條縫的兩側從同一端量起，每條縫第一個是兩條）　${notchWords(opt.notch.style, nm, rule)}${mid}${short}`
      : `對位記號 0 個：每條縫都比 ${fmt(2 * NOTCH.endGap)} cm 短`);
  }

  /**
   * 🔴 程式自己加的切線（2026-10-12，kang 同意）—— **⛔ 不打 ⚠**：
   * 方塊的十字形本來就要程式剪 7 條邊，打警告就是誤報。只如實寫數字，
   * 球那種一剪幾百條的（預設的球：93 條），數字本身就看得出不對勁。
   * ⚠ 只有標過分片的物件圖上才是橘色（理由見 `flatten.js` 的 `piece.autoCut`），
   * 所以兩種寫法 —— ⛔ 不可以在沒有橘色的圖上寫「圖上橘色」。
   */
  /**
   * 🔴 **省道打版的三個數字**（kang 2026-10-12 拍板：最多拉長、最多壓縮、縫邊長度最多差；填了上限、超過就紅字）。
   * ⚠ 上限沒填 ⇒ 只寫數字，⛔ 自己編一個預設值（各材料能拉幾 %，業界沒有一家公開 —— `外部參考-打版.md`）。
   */
  if (piece.strain) {
    const s = piece.strain, pc = v => `${fmt(v * 100)}%`;
    out.push(`省道打版：最多拉長 ${pc(s.max)}　最多壓縮 ${pc(-s.min)}　縫邊長度最多差 ${pc(s.seamErr)}`);
    const d = outlineSegments(piece, opt).darts;
    if (d) out.push(`開口 ${d} 道（${opt.dartStyle === 'sew' ? '只畫縫線、不剪' : '剪掉的 V 形缺口'}）`);
    if (opt.dartFolds && piece.dartFolds && piece.dartFolds.length) {
      out.push(`折線 ${piece.dartFolds.length} 道（只畫線、不標角度 —— 片有拉伸，位置是參考）`);
    }
    const lim = +opt.limit;
    if (opt.limit !== undefined && opt.limit !== '' && Number.isFinite(lim)) {
      const worst = Math.max(s.max, -s.min) * 100;
      out.push(worst > lim + 1e-9
        /** 2026-10-19 ①-14：多講「不想變形可以怎麼做」（`flatten.js` `DART_HINT`）*/
        ? `⚠ 超過你填的上限 ${fmt(lim)}%（這片最多 ${fmt(worst)}%）—— 多開幾道開口或多分幾片${DART_HINT}`
        : `在你填的上限 ${fmt(lim)}% 以內`);
    }
  }

  const ac = piece.autoCut || {};
  if (ac.lines) {
    out.push(ac.userSeams
      ? `程式自己加的切線 ${ac.lines} 條（圖上橘色）—— 要攤平才剪開的，不是你標的`
      : `程式自己加的切線 ${ac.lines} 條（沒標過分片的物件，圖上不另外上色）`);
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
          /** 圓錐面（2026-10-19 ①-11）：講出來 —— 參考線也⛔ 畫，免得以為漏了 */
          + (piece.bends.some(b => b.radial) ? `（其中 ${piece.bends.filter(b => b.radial).length} 帶是圓錐面，參考線也不畫）` : '')
        : ''));
  }
  /** ⭐ 「相同的折線合成一行」：圖上的每道角度拿掉了，所以這一行⛔ 不可以省 */
  const same = opt.foldSummary ? sameFolds(piece) : null;
  if (same) out.push(`折線全部一樣：${same.dir} ${fmt(same.angle)}°（${same.n} 道）—— 圖上只畫線`);
  const mgT = marginGeometry(piece, opt);
  if (mgT) {
    const fbT = mgT.bounds, lb = mgT.label, wv = fmt(mgT.w);
    if (mgT.notReady) out.push(`⚠ ${lb}要等運算模組載好才畫得出來（重新整理一次再開展開圖）`);
    else if (mgT.kind === 'seam') {
      out.push(`${lb} ${wv} cm 已畫進圖：外圍實線是裁切線、虛線（原本的外框）是縫線`
        + (mgT.lostHoles ? `；${mgT.lostHoles} 個洞比${lb}還小，那幾個洞沒有往內留${lb}` : ''));
    } else if (mgT.kind === 'ring') {
      out.push(`${lb} ${wv} cm：沒標過分片，${lb}改成外圍一圈（灰色虛線是折線）；要只長在一邊，請先標分片`);
    } else {
      out.push(mgT.tabs
        ? `${lb} ${wv} cm：這一片長 ${mgT.tabs} 段（灰色虛線是折線；接縫的另一邊不長）`
        : `${lb} ${wv} cm：這一片的接縫都由另一邊長${lb}`);
    }
    if (!mgT.notReady) out.push(`含${lb}外框 ${fmt(fbT.x1 - fbT.x0)} × ${fmt(fbT.y1 - fbT.y0)} cm`);
  } else if (rule.margin && rule.margin() > 0) {
    out.push(`⚠ 圖上未含${rule.marginLabel()} ${fmt(rule.margin())} cm，下料時另加（展開圖勾「畫縫份／黏合片」就會畫進圖）`);
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
    /** 省道打版的拉伸色塊（2026-10-12）：只填色、⛔ 描邊 */
    if (it.t === 'poly') {
      ctx.beginPath();
      it.pts.forEach((p, i) => i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y)));
      ctx.closePath();
      ctx.fillStyle = it.fill;
      ctx.fill();
      continue;
    }
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
    if (it.t === 'poly') {
      out.push(`<polygon points="${it.pts.map(p => `${X(p.x)},${Y(p.y)}`).join(' ')}" fill="${it.fill}" stroke="none"/>`);
      continue;
    }
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

  /**
   * 🔴 **疊起來掉下來的塊塗紅、只黏一點點的塗黃**（2026-10-24，第二輪第五批 5a；`slice/section.js` `stackCheck()` 記在輪廓上）。
   * ⚠ 只有畫面上的預覽（`opt.marks`）才塗；存 SVG、DXF、列印⛔ 塗（`poly` 在 DXF 本來就略過，SVG、列印由呼叫端不給 `marks`）。
   * 先塗再畫線 ⇒ 切割線照樣看得到。
   */
  if (opt.marks) {
    for (const l of slice.loops) {
      if (l.isHole || !(l.loose || l.weak)) continue;
      items.push({ t: 'poly', style: 'overlap', pts: l.pts.map(T), fill: l.loose ? STACK_LOOSE_FILL : STACK_WEAK_FILL });
      /**
       * ⚠ 再圈一圈：掉下來的多半是很小的塊（獅子頭 0.28 cm，在 30 cm 寬的卡片上只有 3 個像素）—— 光塗色看不到（本機抓到）。
       * 圈至少是整片外框的 4%。
       */
      const xs = l.pts.map(p => p.x), ys = l.pts.map(p => p.y);
      const b = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      b.w = b.maxX - b.minX; b.h = b.maxY - b.minY;
      const c = T({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 });
      if (l.loose) items.push({ t: 'circle', style: 'markLoose', x: c.x, y: c.y, r: Math.max(Math.hypot(b.w, b.h) / 2 + 0.2, Math.max(W, H) * 0.04) });
    }
    /**
     * 🔴 **只黏一點點：黃圈畫在黏的那一點**（2026-10-24 第五批 5b，kang「只塗小的那塊＋在黏的那一點畫圈，5a 的卡片也一起改」）。
     * 以前圈在塗黃的那塊外面 —— 汽車那一整片 409 cm² 的大板也塗黃、圈成一個大圈，看不出黏在哪。
     * 上下兩片的卡片都畫（`stackCheck()` 兩片都記在 `slice.glue`）；塗黃只塗小的那塊（`weak` 只記它）。
     */
    for (const g of slice.glue || []) {
      const c = T(g);
      items.push({ t: 'circle', style: 'markWeak', x: c.x, y: c.y, r: Math.max(W, H) * 0.04 });
    }
  }
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
      s: `${slice.tag || '#' + pad2(slice.index)} t${fmt(slice.t)}`,     // 6a 互卡：側面 S、肋 R1、R2…
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

  out.push((slice.label ? `${slice.label}（${slice.tag}）${opt.total ? `　互卡共 ${opt.total} 塊零件` : ''}` : `第 ${slice.index} 片${opt.total ? ` / 共 ${opt.total} 片` : ''}`)
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
    /** 5c 手動放孔：每一根穿過第幾片到第幾片（`slice/pegs.js` `pegSpans()`）—— ⛔ 寫「通到底」*/
    const spans = opt.pegSpans && opt.pegSpans.length === opt.pegs.length && opt.pegSpans.every(Boolean) ? opt.pegSpans : null;
    if (spans) out.push(`定位孔 ${opt.pegs.length} 個（手動）　⌀${fmt(opt.pegD || 0)} cm　`
      + spans.map((s, i) => `孔 ${i + 1} 穿過第 ${s.from}～${s.to} 片`).join('、'));
    /** 第三輪第三批 ②-5：自動的孔① 有片不打孔（`slice/pegs.js` `peg1Cover()`）⇒ ⛔ 寫「通到底、每一片都有」*/
    else if (opt.peg1) out.push(`定位孔 ${opt.pegs.length} 個　⌀${fmt(opt.pegD || 0)} cm`
      + `　孔① 穿過第 ${opt.peg1.on} 片（不是每一片都有）` + (opt.pegs.length > 1 ? '，其餘只穿得過同一段的片' : ''));
    else out.push(`定位孔 ${opt.pegs.length} 個　⌀${fmt(opt.pegD || 0)} cm`
      + (opt.pegs.length > 1
        ? '　孔① 通到底（每一片都有），其餘只穿得過同一段的片'
        : '　孔① 通到底，每一片都有'));
  }
  if (opt.head && opt.head.name) {
    out.push(`案件：${opt.head.name}${opt.head.date ? '　' + opt.head.date : ''}`);
  }
  if (!slice.loops.length) out.push('⚠ 這一片是空的，切不出東西');
  // 斷線的片補過了（網格核心第五批 b ⑥）⇒ ⛔ 再說「切不出來」（跟剖面分切視窗上面那一句打架）
  if (slice.open && slice.patched) out.push(`⚠ 有 ${slice.open} 條線接不起來，這一片的輪廓是補出來的（斷線頭尾接起來再一列一列掃），切之前看一下形狀`);
  else if (slice.open) out.push(`⚠ 有 ${slice.open} 條線接不成封閉輪廓，這一片切不出來`);
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
