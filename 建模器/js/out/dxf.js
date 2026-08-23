/**
 * dxf.js — 展開圖輸出成 DXF
 *
 * ── 為什麼是 R12 這個 1992 年的老格式 ──────────────────
 * 因為要送出去給別人開。雷切廠、CNC 廠、鐵工廠手上的軟體版本
 * 從 AutoCAD 2024 到十幾年前的免費看圖軟體都有。
 * R12 是所有這些軟體**一定**讀得懂的最大公約數，
 * 而且是純文字，出了問題可以直接用記事本打開看。
 *
 * ── 只用 LINE 和 TEXT 兩種實體 ──────────────────────
 * LWPOLYLINE 是 R14 才有的；POLYLINE/VERTEX/SEQEND 雖然 R12 有，
 * 但寫錯一個 SEQEND 整個檔就打不開。
 * 一條線就寫一個 LINE，檔案大一點，但沒有任何軟體會讀不懂。
 * 這是刻意的取捨：**送出去的檔案，穩比小重要**。
 *
 * ── 骨架不能省（2026-08-21 實際踩到）──────────────────
 * 第一版只寫了 HEADER／TABLES(只有 LAYER)／ENTITIES 三段。
 * 這在規格上合法，AutoCAD 讀得動，**但 Illustrator 直接跳錯誤視窗**。
 * 原因是它用的是很舊的匯入器，會去找這些東西：
 *
 *   LTYPE 表    圖層寫了線型 CONTINUOUS，表裡沒定義就停住
 *   STYLE 表    TEXT 實體隱含引用字型樣式 STANDARD，找不到就報錯
 *   BLOCKS 區段 就算是空的也要有
 *   圖層 0      永遠存在的預設圖層，缺了有些軟體會當成檔案壞掉
 *
 * → **教訓**：「規格上合法」跟「別人的軟體讀得動」是兩回事。
 *   要送出去的檔案，寧可多寫這幾十行骨架。
 *
 * 另外拿掉了 $INSUNITS —— 那是 R14 才有的變數，
 * 寫在 AC1009 的檔頭裡是時代錯亂。單位改成標在圖上的文字。
 *
 * ── 圖層 ────────────────────────────────────────────
 *   CUT    切割線 —— 雷切機真的要切的就只有這一層
 *   FOLD   折線   —— 折床看的參考線，不能切
 *   BEND   折彎區 —— 圓弧折彎的起訖線與中心線
 *   DIM    尺寸線
 *   TEXT   文字說明
 *   JOIN   接合編號 —— 這條邊要跟哪一條接回去（同號碼配對）
 * 分層的意義：廠商可以只留 CUT 層丟給機器，其餘關掉。
 * 全部畫在同一層的話，折線會被當成切割線切下去，整片報廢。
 *
 * JOIN 特別重要要獨立一層：它是**給組裝的人看的**，不是給機器的。
 * 而且進 Illustrator 之後使用者要重新排版，那時候把 JOIN 關掉
 * 排完再開回來，比在一堆數字裡找方便得多。
 *
 * ── 單位 ────────────────────────────────────────────
 * 專案內部一律 cm，但雷切／CNC 廠幾乎都收 mm。
 * 所以輸出時換算，並寫進 $INSUNITS 讓對方軟體自己認。
 */

const COLOR = { CUT: 7, FOLD: 3, BEND: 5, DIM: 8, TEXT: 8, JOIN: 3 };

/** 剖面分切用的圖層顏色。切割層依板厚各一層，名字由 cutLayer() 產生。 */
const SLICE_COLOR = { NUM: 30, TEXT: 8 };
const CUT_COLORS = [7, 1, 5, 3, 6, 4, 2];

/**
 * 單位換算：專案內部 cm → 輸出單位。
 * R12 的檔頭沒有記錄單位的地方（$INSUNITS 是 R14 才有的），
 * 所以幾何直接換算成目標單位，並在圖上標一行文字說明。
 */
export const UNITS = {
  mm: { scale: 10, label: 'mm' },
  cm: { scale: 1,  label: 'cm' }
};

/**
 * 把展開結果轉成 DXF 文字。
 *
 * @param {object[]} pieces flatten.js 的 pieces
 * @param {object} opt { unit:'mm'|'cm', head:{name,date,no}, rule, gap }
 * @returns {string}
 */
export function toDXF(pieces, opt = {}) {
  const U = UNITS[opt.unit] || UNITS.mm;
  const s = U.scale;
  const gap = (opt.gap ?? 5) * s;              // 片與片之間留的間距
  const out = new Writer();

  // ── 各片沿 X 排開，彼此不重疊 ──
  const laid = [];
  let x = 0, maxY = 0;
  for (const p of pieces) {
    laid.push({ p, ox: x, oy: 0 });
    x += p.width * s + gap;
    maxY = Math.max(maxY, p.height * s);
  }

  out.header(0, 0, x, maxY);
  out.tables(Object.keys(COLOR).map(n => [n, COLOR[n]]));
  out.blocks();
  out.beginEntities();

  const th = (opt.rule && opt.rule.thickness) || 0;
  const mat = (opt.rule && opt.rule.label) || '';
  /**
   * ⚠ 〔2026-08-23 拿掉 K 因子〕原本這裡有 `const kf = opt.rule.k`，
   * DXF 標題會印 ` K0.5`。K 是金屬中性層的模型，主力材料用不到，
   * 而且它已經不影響圖上任何一個數字 —— 印出來只會讓人以為有關。
   * kang：「不應該在真實尺寸中出現」。
   */

  for (const { p, ox, oy } of laid) {
    const X = pt => ox + pt.x * s;
    const Y = pt => oy + pt.y * s;

    // 切割線：外輪廓與內孔
    for (const loop of [p.outline, ...p.holes]) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        out.line('CUT', X(a), Y(a), X(b), Y(b));
      }
    }

    // 折線。圓弧折彎帶內部那些線是網格切出來的，不是真的折線，
    // 畫出來只會讓師傅困惑，所以只畫折彎區的起訖線（下面那段）。
    for (const f of p.folds) {
      if (f.isArcEdge) continue;
      out.line('FOLD', X(f.a), Y(f.a), X(f.b), Y(f.b));
    }

    // 折彎區：起線、訖線、中心線
    const y0 = oy, y1 = oy + p.height * s;
    for (const b of p.bends) {
      if (!b.isArc) continue;
      out.line('BEND', ox + b.x0 * s, y0, ox + b.x0 * s, y1);
      out.line('BEND', ox + b.x1 * s, y0, ox + b.x1 * s, y1);
      const cx = ox + (b.x0 + b.x1) / 2 * s;
      // r ＝ 網格量出來的半徑。〔2026-08-23 從 b.ri（K 推的內側 R）改過來〕
      out.text('BEND', cx, y1 + 1.2 * s, 0.8 * s,
        `${round(b.angle)}deg R${round(b.r)}`);
    }
    for (const b of p.bends) {
      if (b.isArc) continue;
      out.text('BEND', ox + b.x0 * s, y1 + 1.2 * s, 0.8 * s,
        `${round(b.angle)}deg R0`);
    }

    /**
     * 接合編號：這條邊要跟哪一條接回去。同號碼配對。
     * 位置跟預覽圖一致 —— 邊的中點往片內縮，因為外面已經被
     * 尺寸與折彎標註佔滿了（坑第 12 條：讀不出來的標示比沒有更糟）。
     */
    if (p.joints && p.joints.length) {
      let cx = 0, cy = 0;
      for (const q of p.outline) { cx += q.x; cy += q.y; }
      cx /= (p.outline.length || 1); cy /= (p.outline.length || 1);
      const IN = 1.8;

      for (const j of p.joints) {
        const mx = (j.a.x + j.b.x) / 2, my = (j.a.y + j.b.y) / 2;
        let nx = -(j.b.y - j.a.y), ny = j.b.x - j.a.x;
        const L = Math.hypot(nx, ny) || 1;
        nx /= L; ny /= L;
        if ((cx - mx) * nx + (cy - my) * ny < 0) { nx = -nx; ny = -ny; }
        out.text('JOIN', ox + (mx + nx * IN) * s, oy + (my + ny * IN) * s,
                 1.4 * s, String(j.num));
      }
    }

    // 尺寸：整片外框（DXF 的標註實體版本差異大，直接畫線＋文字最保險）
    dimLine(out, ox, oy - 2.5 * s, ox + p.width * s, oy - 2.5 * s,
      `${round(p.width)}`, s);
    dimLine(out, ox - 2.5 * s, oy, ox - 2.5 * s, oy + p.height * s,
      `${round(p.height)}`, s);

    // 標題：這一片是什麼、要做幾片、什麼材料
    const title = `${p.name} x${p.qty}`
      + (mat ? `  ${mat}` : '')
      + (th ? ` t${round(th)}` : '');
    out.text('TEXT', ox, oy - 5 * s, 1.0 * s, ascii(title));
    out.text('TEXT', ox, oy - 7 * s, 0.7 * s, `unit=${U.label}`);
  }

  out.end();
  return out.text_;
}

// ═══════════════════════════════════════════════════════
//  剖面分切
// ═══════════════════════════════════════════════════════

/**
 * 切割線的圖層名 —— **依板厚各一層**。
 *
 * ── 為什麼一定要這樣分 ──────────────────────────────
 * DXF 是一堆輪廓線，但機器切的是一塊**實體板**。
 * 20 片裡有 5 片要從 1cm 板上切、7 片要從 2cm 板上切，
 * 現場就得上兩次料：鋪 1cm 板切那 5 片，換 2cm 板再切那 7 片。
 * 不可能把 20 片全部鋪在同一塊板上一次切完。
 *
 * 那個區分必須在檔案裡看得見，而且**弄不丟**。
 * 靠位置分區是不行的 —— kang 的 DXF 會先進 Illustrator 重新排版，
 * 片一被搬走，分區就沒了。**圖層跟著物件走，怎麼搬都不會變。**
 * 廠商要切 1cm 板就只開 CUT_T10 這一層，切完換料再開 CUT_T20。
 *
 * 命名：板厚換算成 mm，小數點寫成底線（DXF R12 的圖層名不能有點）。
 *   1.0cm → CUT_T10　　2.0cm → CUT_T20　　0.35cm → CUT_T3_5
 */
export function cutLayer(thicknessCm) {
  const mm = Math.round(thicknessCm * 100) / 10;      // cm → mm，留一位小數
  return 'CUT_T' + String(mm).replace('.', '_');
}

/**
 * 一疊剖面轉成 DXF。一個檔裝全部，同板厚的排在同一區塊。
 *
 * @param {object[]} slices section.js 的 slices
 * @param {object} opt {
 *   unit:'mm'|'cm', origin:{x,y}, frame:{w,h},
 *   pegs:[{x,y}], pegD, head, gap
 * }
 */
export function sliceDXF(slices, opt = {}) {
  const U = UNITS[opt.unit] || UNITS.mm;
  const s = U.scale;
  const gap = (opt.gap ?? 4) * s;

  const o0 = opt.origin || { x: 0, y: 0 };
  const frame = opt.frame || { w: 0, h: 0 };
  const cw = frame.w * s + gap;
  const ch = frame.h * s + gap;
  /**
   * 每一片的孔不一定一樣多：孔①通到底，其餘的孔只屬於那一段。
   * 所以這裡收的是「給一片、回傳它的孔」的函式，不是一個固定的陣列。
   */
  const pegsOf = typeof opt.pegsOf === 'function'
    ? opt.pegsOf : () => (opt.pegs || []);
  const pr = ((opt.pegD || 0) / 2) * s;

  // ── 依板厚分組。同一種板厚的片排在一起，順序照片號。 ──
  const groups = [];
  for (const sl of slices) {
    const t = Math.round(sl.t * 100) / 100;
    let g = groups.find(q => q.t === t);
    if (!g) { g = { t, list: [] }; groups.push(g); }
    g.list.push(sl);
  }
  groups.sort((a, b) => a.t - b.t);
  for (const g of groups) g.list.sort((a, b) => a.index - b.index);

  // ── 排版：一組一個方塊區，區內盡量排成方形，一列列往下 ──
  const laid = [];
  const titles = [];
  let y = 0;

  for (const g of groups) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(g.list.length)));
    const rows = Math.ceil(g.list.length / cols);

    y -= 3 * s;                       // 區塊標題那一行的高度
    titles.push({ x: 0, y, text: `t=${round(g.t)}cm  ${g.list.length} pcs  `
      + `layer ${cutLayer(g.t)}` });
    y -= 1.5 * s;

    for (let i = 0; i < g.list.length; i++) {
      const r = Math.floor(i / cols), c = i % cols;
      laid.push({ sl: g.list[i], t: g.t, ox: c * cw, oy: y - (r + 1) * ch });
    }
    y -= rows * ch + gap;
  }

  // 全部往上推到第一象限。負座標本身合法，但有些老軟體的匯入器
  // 會把整張圖擺到看不見的地方，使用者以為檔案是空的。
  const minY = Math.min(0, ...laid.map(l => l.oy), ...titles.map(t => t.y));
  const shift = -minY + gap;
  const maxX = Math.max(0, ...laid.map(l => l.ox + frame.w * s));
  const maxY = Math.max(...laid.map(l => l.oy + frame.h * s), ...titles.map(t => t.y)) + shift;

  // ── 圖層表：切割層依板厚各一層 ──
  const layers = groups.map((g, i) => [cutLayer(g.t), CUT_COLORS[i % CUT_COLORS.length]]);
  layers.push(['NUM', SLICE_COLOR.NUM], ['TEXT', SLICE_COLOR.TEXT]);

  const out = new Writer();
  out.header(0, 0, maxX, maxY + 12 * s);   // 上面還要放幾行說明文字
  out.tables(layers);
  out.blocks();
  out.beginEntities();

  for (const t of titles) out.text('TEXT', t.x, t.y + shift, 1.2 * s, t.text);

  for (const { sl, t, ox, oy } of laid) {
    const L = cutLayer(t);
    const X = p => ox + (p.x - o0.x) * s;
    const Y = p => oy + shift + (p.y - o0.y) * s;

    for (const loop of sl.loops) {
      for (let i = 0; i < loop.pts.length; i++) {
        const a = loop.pts[i], b = loop.pts[(i + 1) % loop.pts.length];
        out.line(L, X(a), Y(a), X(b), Y(b));
      }
    }

    /**
     * 定位孔畫在**同一個切割層**，不另外分一層。
     * 分開的話，廠商只開切割層丟給機器時孔會漏掉，
     * 而漏掉的後果是整疊串不起來 —— 整批料報廢。
     * 它本來就是要切掉的東西，就該跟輪廓在一起。
     */
    const pegs = pegsOf(sl) || [];
    if (pr > 0) for (const p of pegs) out.circle(L, X(p), Y(p), pr);

    // 層號：孔①正下方，固定位置，同時當朝向記號。
    // 用孔①而不是這一段的其他孔，因為只有孔①在每一片上都在同一個地方。
    const a0 = pegs.length ? { x: X(pegs[0]), y: Y(pegs[0]) } :
      { x: ox + frame.w * s / 2, y: oy + shift + frame.h * s / 2 };
    const size = Math.max(0.9 * s, Math.min(2.4 * s, Math.min(frame.w, frame.h) * s * 0.08));
    out.text('NUM', a0.x, a0.y - Math.max(pr * 2.4, size * 1.4), size,
      `#${String(sl.index).padStart(2, '0')} t${round(t)}`);
  }

  // 檔頭說明：這張圖怎麼用。ASCII 才不會在別人的軟體變亂碼。
  const head = opt.head || {};
  const note = [
    `SLICE STACK  ${slices.length} pcs  unit=${U.label}`,
    `axis=${opt.axis || 'y'}  peg dia=${round((opt.pegD || 0) * s)}${U.label}`,
    'peg #1 (same spot on every piece) is the through rod;',
    'extra pegs belong to one thickness group only',
    'cut one thickness at a time: enable only that CUT_T** layer',
    'stack in number order, keep the numbers facing the same way'
  ];
  if (head.name) note.unshift(`job: ${head.name}${head.date ? '  ' + head.date : ''}`);
  note.forEach((n, i) => out.text('TEXT', 0, maxY + (note.length - i) * 2 * s, 1.2 * s, n));

  out.end();
  return out.text_;
}

/** 簡單的尺寸線：兩端箭頭用短斜線代替，中間放數字 */
function dimLine(out, x1, y1, x2, y2, label, s) {
  out.line('DIM', x1, y1, x2, y2);
  const tick = 0.5 * s;
  out.line('DIM', x1 - tick, y1 - tick, x1 + tick, y1 + tick);
  out.line('DIM', x2 - tick, y2 - tick, x2 + tick, y2 + tick);
  out.text('DIM', (x1 + x2) / 2, (y1 + y2) / 2 + 0.4 * s, 0.8 * s, label);
}

/**
 * DXF 的 TEXT 實體只保證 ASCII 讀得對。
 * 中文在 R12 沒有統一的編碼約定，不同軟體開出來不是亂碼就是空白，
 * 所以送出去的圖一律用英數，中文留在螢幕與列印用的展開圖上。
 */
function ascii(str) {
  return String(str).replace(/[^\x20-\x7E]/g, '-').replace(/-+/g, '-').trim();
}

const round = v => String(Math.round(v * 100) / 100);

// ═══════════════════════════════════════════════════════
//  DXF 寫入器
// ═══════════════════════════════════════════════════════

/**
 * DXF 是「群組碼 ＋ 值」一行一個的格式：
 *   0        ← 群組碼（0 代表「接下來是一個實體」）
 *   LINE     ← 值
 *   8        ← 群組碼 8 是圖層名
 *   CUT      ← 值
 * 全部都是純文字，行尾必須是 CRLF（有些老軟體只吃 CRLF）。
 */
class Writer {
  constructor() { this.text_ = ''; }

  put(code, value) { this.text_ += `${code}\r\n${value}\r\n`; }

  num(code, v) { this.put(code, (+v).toFixed(4)); }

  header(minX, minY, maxX, maxY) {
    this.put(0, 'SECTION'); this.put(2, 'HEADER');
    this.put(9, '$ACADVER'); this.put(1, 'AC1009');       // AC1009 ＝ R12
    this.put(9, '$INSBASE'); this.num(10, 0); this.num(20, 0); this.num(30, 0);
    this.put(9, '$EXTMIN'); this.num(10, minX); this.num(20, minY); this.num(30, 0);
    this.put(9, '$EXTMAX'); this.num(10, maxX); this.num(20, maxY); this.num(30, 0);
    this.put(9, '$LIMMIN'); this.num(10, minX); this.num(20, minY);
    this.put(9, '$LIMMAX'); this.num(10, maxX); this.num(20, maxY);
    this.put(0, 'ENDSEC');
  }

  /**
   * 表格區段。順序有意義：**LTYPE 一定要排在 LAYER 前面**，
   * 因為圖層會引用線型，引用的東西必須先定義。
   */
  tables(layers) {
    this.put(0, 'SECTION'); this.put(2, 'TABLES');

    // ── 線型：只用一種實線 ──
    this.put(0, 'TABLE'); this.put(2, 'LTYPE'); this.put(70, 1);
    this.put(0, 'LTYPE');
    this.put(2, 'CONTINUOUS');
    this.put(70, 0);
    this.put(3, 'Solid line');
    this.put(72, 65);        // 65 ＝ 字元 'A'，線型定義的固定開頭
    this.put(73, 0);         // 沒有虛線段
    this.num(40, 0);         // 總長 0
    this.put(0, 'ENDTAB');

    // ── 圖層。一定要含圖層 0：那是 DXF 永遠存在的預設圖層，
    //    缺了有些軟體會判定檔案損壞。──
    this.put(0, 'TABLE'); this.put(2, 'LAYER'); this.put(70, layers.length + 1);
    for (const [name, color] of [['0', 7], ...layers]) {
      this.put(0, 'LAYER');
      this.put(2, name);
      this.put(70, 0);
      this.put(62, color);
      this.put(6, 'CONTINUOUS');
    }
    this.put(0, 'ENDTAB');

    // ── 文字樣式。TEXT 實體隱含引用 STANDARD，
    //    沒定義的話 Illustrator 會直接拒絕整個檔案。──
    this.put(0, 'TABLE'); this.put(2, 'STYLE'); this.put(70, 1);
    this.put(0, 'STYLE');
    this.put(2, 'STANDARD');
    this.put(70, 0);
    this.num(40, 0);         // 固定字高 0 ＝ 由每個 TEXT 自己指定
    this.num(41, 1);         // 寬度比例
    this.num(50, 0);         // 傾斜角
    this.put(71, 0);         // 不鏡射
    this.num(42, 2.5);       // 上次用的字高
    this.put(3, 'txt');      // 字型檔
    this.put(4, '');         // 大字型檔（中日韓用，這裡不用）
    this.put(0, 'ENDTAB');

    this.put(0, 'ENDSEC');
  }

  /**
   * 圖塊區段。我們沒有任何圖塊，但這一段**不能省** ——
   * 舊的匯入器（Illustrator 就是）會照順序找 BLOCKS，找不到就中止。
   */
  blocks() {
    this.put(0, 'SECTION'); this.put(2, 'BLOCKS');
    this.put(0, 'ENDSEC');
  }

  beginEntities() { this.put(0, 'SECTION'); this.put(2, 'ENTITIES'); }

  line(layer, x1, y1, x2, y2) {
    this.put(0, 'LINE');
    this.put(8, layer);
    this.num(10, x1); this.num(20, y1); this.num(30, 0);
    this.num(11, x2); this.num(21, y2); this.num(31, 0);
  }

  /**
   * 圓。R12 就有 CIRCLE 實體，所有軟體都讀得懂，
   * 不需要拿一堆短線去逼近 —— 逼近的圓進 CNC 會被當成多邊形切，
   * 孔的內壁會有稜線，串桿就塞不順了。
   */
  circle(layer, x, y, r) {
    this.put(0, 'CIRCLE');
    this.put(8, layer);
    this.num(10, x); this.num(20, y); this.num(30, 0);
    this.num(40, r);
  }

  text(layer, x, y, h, str) {
    this.put(0, 'TEXT');
    this.put(8, layer);
    this.num(10, x); this.num(20, y); this.num(30, 0);
    this.num(40, h);
    this.put(1, ascii(str));
    this.put(7, 'STANDARD');   // 明寫樣式名，不要靠預設值
  }

  end() { this.put(0, 'ENDSEC'); this.put(0, 'EOF'); }
}
