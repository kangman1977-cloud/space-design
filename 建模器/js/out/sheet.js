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
   * 往內縮的方向用「邊的法線朝向片的重心」那一側，所以不管
   * 這條邊在輪廓的哪個方位，號碼都會落在料上面。
   */
  if (opt.showJoints !== false && piece.joints && piece.joints.length) {
    const cx = piece.outline.reduce((s, p) => s + p.x, 0) / (piece.outline.length || 1);
    const cy = piece.outline.reduce((s, p) => s + p.y, 0) / (piece.outline.length || 1);
    const IN = 1.8;                         // 往內縮多少 cm

    for (const j of piece.joints) {
      const mx = (j.a.x + j.b.x) / 2, my = (j.a.y + j.b.y) / 2;
      let nx = -(j.b.y - j.a.y), ny = j.b.x - j.a.x;
      const L = Math.hypot(nx, ny) || 1;
      nx /= L; ny /= L;
      // 法線有兩個方向，取指向重心的那一個
      if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }
      text('joint', mx + nx * IN, my + ny * IN, j.num, 1.8, 'middle');
    }
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
      const l1 = `${fmt(Math.abs(b.angle))}°　R${fmt(b.ri)}`;
      const l2 = `${dir}${b.isArc ? `　弧長 ${fmt(b.x1 - b.x0)}` : '　尖角'}`;
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
    items
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
  if (rule.label) spec.push(rule.label);
  if (rule.thickness) spec.push(`板厚 ${fmt(rule.thickness)} cm`);
  if (rule.k !== undefined) spec.push(`K ${rule.k}`);
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
    out.push(`接合編號 ${piece.joints.length} 處　同號碼的邊接在一起`);
  }

  const arcs = piece.bends.filter(b => b.isArc).length;
  const sharp = piece.bends.length - arcs;
  if (piece.bends.length) {
    out.push(`折彎 ${piece.bends.length} 道（圓弧 ${arcs}、尖角 ${sharp}）`);
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
  const prog = drawProgram(piece, opt);
  const b = prog.box;
  const title = titleLines(piece, opt);
  const head = 1.2 * title.length + 1.5;

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
  const win = window.open('', '_blank');
  if (!win) return false;

  // 內嵌進 HTML 時要把 XML 宣告拿掉 —— 那一行只有獨立的 .svg 檔需要，
  // 出現在 HTML 內文裡反而會被當成文字印出來
  const pages = pieces.map(p =>
    `<div class="page">${toSVG(p, opt).replace(/^<\?xml[^>]*\?>\s*/, '')}</div>`).join('\n');

  win.document.write(`<!doctype html><html><head><meta charset="utf-8">
<title>展開圖</title>
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
