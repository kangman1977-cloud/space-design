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
  const kf = (opt.rule && opt.rule.k);

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
      out.text('BEND', cx, y1 + 1.2 * s, 0.8 * s,
        `${round(b.angle)}deg R${round(b.ri)}`);
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
      + (th ? ` t${round(th)}` : '')
      + (kf !== undefined ? ` K${kf}` : '');
    out.text('TEXT', ox, oy - 5 * s, 1.0 * s, ascii(title));
    out.text('TEXT', ox, oy - 7 * s, 0.7 * s, `unit=${U.label}`);
  }

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
