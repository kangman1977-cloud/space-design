/**
 * profile.js — 把一份 SVG 變成「可以擠出的封閉輪廓」
 *
 * 三件事：**讀出檔案裡的東西**、**換算成公分**、**講出哪裡有問題**。
 * 不碰 DOM、不碰檔案系統，收的是一個字串，所以在 Node 裡測得到。
 *
 * ── 為什麼自己掃標籤，不用瀏覽器的 DOMParser ────────────
 * 跟 svgPath.js 同一個理由：用了就只能在瀏覽器裡跑，而沙箱開不了瀏覽器。
 * 這裡不做完整的 XML 解析（那是另一個專案），只掃我們真正需要的東西：
 * `<svg>` 的尺寸、`<g>` 的巢狀與 id、`<path>` 的 d 與 transform。
 * 其餘一律略過。**`<defs>` / `<clipPath>` / `<mask>` / `<symbol>` 裡面的路徑
 * 會被跳過** —— 那些是定義，不是要畫出來的東西，跟著擠出就多一堆鬼影。
 *
 * ── 這裡最容易靜靜出錯的三件事 ──────────────────────────
 * 一、**尺寸**。SVG 內部座標是「使用者單位」，跟公分的關係要靠
 *     `width`／`height` 對 `viewBox` 算出來。算錯的話圖一模一樣、
 *     東西做出來大小全錯，而且要切完才發現。
 * 二、**transform**。Illustrator 有時候會把位移寫成 `<g transform="...">`。
 *     忽略它不會報錯，只是東西跑到別的地方 —— 而畫面上看起來很正常。
 * 三、**內孔**。哪一圈是洞不能靠路徑方向猜（畫的人不一定照規矩），
 *     用「包在幾層裡面」判斷才穩。
 */

import { parsePath, polyArea, polyLength, DEFAULT_TOL } from './svgPath.js';

/** SVG 的長度單位換算成公分。1in = 2.54cm、CSS 的 1px = 1/96 in。 */
const UNIT_CM = {
  cm: 1, mm: 0.1, q: 0.025,
  in: 2.54, pt: 2.54 / 72, pc: 2.54 / 6,
  px: 2.54 / 96, '': 2.54 / 96      // 沒寫單位 ＝ px
};

export const UNIT_KEYS = ['cm', 'mm', 'in', 'pt', 'px'];

/**
 * X 與 Y 的比例差多少以內算「一樣」。
 *
 * 不能用相等比較。Illustrator 把 width／height 四捨五入到 2 位小數，
 * 所以 41.35cm / 1172.16 與 87.38cm / 2476.79 **本來就不會完全相等**
 * （實測差 0.009%）。拿相等去比的話，每一個 Illustrator 檔都會被誤判成
 * 「非等比縮放」—— 又是坑第 26 條：判準要挑有物理意義的量。
 * 0.5% 遠大於四捨五入造成的差，又遠小於任何真的會影響形狀的變形。
 */
const SCALE_TOL = 0.005;

/**
 * 讀一份 SVG。
 *
 * @param {string} text  檔案內容
 * @param {object} opt   { tolMm 弦高誤差（mm）, unit 覆寫來源單位, cmPerUnit 直接指定比例 }
 * @returns {object} 見下方回傳說明
 */
export function readSVG(text, opt = {}) {
  const src = String(text || '');
  const doc = scanSVG(src);
  const notes = [];
  const errors = [];

  if (!doc.svg) return { ok: false, reason: '這不是一個 SVG 檔（找不到 <svg> 標籤）。' };
  if (!doc.paths.length) {
    return { ok: false, reason: '這個 SVG 裡沒有任何路徑（<path>）。'
      + '如果圖上是文字，請先在 Illustrator 裡「建立外框」再匯出。' };
  }

  // ── 一、比例 ──
  const scale = resolveScale(doc.svg, opt, notes);

  /**
   * 弦高誤差是「做出來看得出稜角嗎」，所以用**實際長度**（mm）表示，
   * 再換算回 SVG 的使用者單位。直接填「使用者單位」的話，
   * 同一個數字在 pt 檔與 mm 檔的意義差三倍。
   */
  const tolMm = opt.tolMm > 0 ? opt.tolMm : 0.2;
  const tol = scale.cmPerUnit > 0 ? (tolMm / 10) / scale.cmPerUnit : DEFAULT_TOL;

  // ── 二、路徑 → 公分座標的封閉輪廓 ──
  const shapes = [];
  const cmds = new Set();

  doc.paths.forEach((p, i) => {
    const r = parsePath(p.d, { tol });
    for (const c of r.cmds) cmds.add(c);
    for (const e of r.errors) errors.push(`${p.name || `第 ${i + 1} 條路徑`}：${e}`);

    for (const sp of r.subpaths) {
      const pts = sp.pts.map(q => {
        const w = apply(p.matrix, q.x, q.y);
        /**
         * SVG 的 y 軸向下，建模器的地面是 XZ 平面（Y 向上）。
         * 對應 x→x、y→z 之後，從上往下看的畫面跟 SVG 完全一樣 ——
         * **沒有鏡射**。這一點錯了的話東西做出來是反的，
         * 而且圖看起來完全正常（跟剖面分切的手性問題同一種）。
         */
        return { x: w.x * scale.cmPerUnit, y: w.y * scale.cmPerUnit };
      });
      shapes.push({
        name: p.name || `路徑 ${i + 1}`,
        layer: p.layer || '',
        pts,
        closed: sp.closed,
        area: polyArea(pts),
        length: polyLength(pts, sp.closed)
      });
    }
  });

  // ── 三、檢查 ──
  const open = shapes.filter(s => !s.closed);
  const tiny = shapes.filter(s => s.closed && Math.abs(s.area) < 1e-6);
  const usable = shapes.filter(s => s.closed && Math.abs(s.area) >= 1e-6);

  if (open.length) {
    errors.push(`有 ${open.length} 條路徑沒有封閉（${listNames(open)}），擠不出實體。`
      + '請在 Illustrator 裡把它們接起來，或改用「加厚成板」。');
  }
  if (tiny.length) notes.push(`有 ${tiny.length} 條路徑面積接近 0，已略過。`);

  const selfHits = [];
  for (const s of usable) {
    const hit = selfIntersects(s.pts);
    if (hit === null) notes.push(`「${s.name}」點數太多，略過自相交檢查。`);
    else if (hit) selfHits.push(s.name);
  }
  if (selfHits.length) {
    errors.push(`這幾條路徑自己跟自己交叉（${selfHits.join('、')}），`
      + '擠出來會是壞掉的實體。請先在 Illustrator 裡用「路徑管理員」整理。');
  }

  // ── 四、分外框與內孔 ──
  const loops = classify(usable);
  const box = bounds(usable.flatMap(s => s.pts));

  return {
    ok: errors.length === 0 && loops.length > 0,
    errors, notes,
    reason: errors[0] || (loops.length ? '' : '沒有任何封閉的輪廓。'),
    scale,
    tolMm,
    cmds: [...cmds].join(''),
    shapes, loops,
    box,
    /** 換算後的實際外框（cm）—— 這是給人核對的那個數字 */
    size: { w: box.maxX - box.minX, h: box.maxY - box.minY },
    area: loops.reduce((a, l) => a + Math.abs(l.area)
      - l.holes.reduce((b, h) => b + Math.abs(h.area), 0), 0)
  };
}

/**
 * 比例：檔案宣告的實際尺寸 ÷ viewBox 的單位數。
 *
 * 三種情況都要講清楚，**不能靜靜給一個預設值**：
 *   有 width/height ＋ viewBox → 算得出來，最可靠
 *   只有 width/height          → 使用者單位就是那個單位
 *   只有 viewBox               → **檔案沒說**，只能猜，一定要講
 */
function resolveScale(svg, opt, notes) {
  if (opt.cmPerUnit > 0) {
    return { cmPerUnit: opt.cmPerUnit, from: 'manual', label: '手動校正' };
  }

  const w = parseLen(svg.width), h = parseLen(svg.height);
  const vb = svg.viewBox;

  if (opt.unit && UNIT_CM[opt.unit] !== undefined) {
    // 使用者覆寫：把使用者單位當成他指定的那個單位
    return { cmPerUnit: UNIT_CM[opt.unit], from: 'override', label: `指定為 ${opt.unit}` };
  }

  if (w && vb && vb.w > 0 && h && vb.h > 0) {
    const sx = w.cm / vb.w, sy = h.cm / vb.h;
    const diff = Math.abs(sx - sy) / Math.max(sx, sy);
    if (diff > SCALE_TOL) {
      notes.push(`⚠ 這個檔的 X 與 Y 比例不一樣（差 ${(diff * 100).toFixed(2)}%），`
        + '匯入後形狀會被拉長或壓扁。取兩者平均。');
    }
    return {
      cmPerUnit: (sx + sy) / 2,
      from: 'declared',
      label: `檔案宣告 ${svg.width} × ${svg.height}`,
      declared: { w: w.cm, h: h.cm }
    };
  }

  if (w && !vb) {
    return { cmPerUnit: UNIT_CM[w.unit], from: 'declared', label: `檔案宣告單位 ${w.unit}` };
  }

  notes.push('⚠ 這個檔沒有寫實際尺寸（只有 viewBox），'
    + '所以下面的大小是**猜的**（照 CSS 的 96dpi 換算）。'
    + '請對照你原稿的尺寸，不對的話手動指定單位或拉一段已知長度校正。');
  return { cmPerUnit: UNIT_CM.px, from: 'guess', label: '檔案沒寫尺寸，猜 px' };
}

function parseLen(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(-?[\d.]+)\s*([a-zA-Z%]*)$/);
  if (!m) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === '%' || UNIT_CM[unit] === undefined) return null;
  return { n: +m[1], unit: unit || 'px', cm: +m[1] * UNIT_CM[unit] };
}

/**
 * 誰包在誰裡面。**巢狀深度是偶數 ＝ 實心，奇數 ＝ 洞。**
 *
 * 不用路徑的繞向判斷，因為畫的人不一定照規矩（Illustrator 的複合路徑
 * 靠方向，但手畫的、別人給的、轉檔過的都可能是亂的）。
 * 「在不在裡面」是幾何事實，繞向只是慣例。
 */
function classify(shapes) {
  const list = shapes.map(s => ({ ...s, depth: 0, holes: [] }));

  for (const a of list) {
    for (const b of list) {
      if (a === b) continue;
      if (Math.abs(b.area) <= Math.abs(a.area)) continue;    // 只可能被更大的包住
      if (pointInPoly(a.pts[0], b.pts)) a.depth++;
    }
  }

  const outers = list.filter(s => s.depth % 2 === 0);
  for (const h of list.filter(s => s.depth % 2 === 1)) {
    // 掛給「包住它、而且面積最小」的那個外框 —— 那就是它的直屬父層
    let best = null;
    for (const o of outers) {
      if (o.depth >= h.depth) continue;
      if (!pointInPoly(h.pts[0], o.pts)) continue;
      if (!best || Math.abs(o.area) < Math.abs(best.area)) best = o;
    }
    if (best) best.holes.push(h);
  }
  return outers;
}

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y)
      && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * 自相交檢查。O(n²)，點太多就放棄並講出來 ——
 * 沉默地跳過檢查跟沒有檢查一樣糟。
 * @returns {boolean|null} null ＝ 沒檢查
 */
function selfIntersects(pts, cap = 2000) {
  const n = pts.length;
  if (n > cap) return null;
  for (let i = 0; i < n; i++) {
    const a1 = pts[i], a2 = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;      // 首尾相接不算
      if (segCross(a1, a2, pts[j], pts[(j + 1) % n])) return true;
    }
  }
  return false;
}

function segCross(p1, p2, p3, p4) {
  const d = (q, r, s) => (r.x - q.x) * (s.y - q.y) - (r.y - q.y) * (s.x - q.x);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

function bounds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX > maxX) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

const listNames = arr => arr.slice(0, 5).map(s => s.name).join('、')
  + (arr.length > 5 ? ` 等 ${arr.length} 條` : '');

// ═══════════════════════════════════════════════════════
//  掃標籤
// ═══════════════════════════════════════════════════════

/** 不要畫出來的容器。裡面的路徑是「定義」，不是圖面上的東西。 */
const SKIP = new Set(['defs', 'clippath', 'mask', 'symbol', 'pattern', 'marker']);

/**
 * 掃出 `<svg>` 的尺寸與所有 `<path>`（含它的圖層名與累積的 transform）。
 *
 * 刻意只認得需要的東西。碰到看不懂的標籤就當成透明的容器往下走，
 * 這樣新版 Illustrator 多包一層什麼東西也不會整個讀不到。
 */
export function scanSVG(src) {
  const text = src.replace(/<!--[\s\S]*?-->/g, '');
  const paths = [];
  let svg = null;
  const stack = [];                       // 巢狀狀態：{ tag, matrix, name, skip }
  let top = { tag: '', matrix: IDENT, name: '', skip: false };

  const re = /<\s*(\/?)\s*([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)\s*>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase().replace(/^.*:/, '');
    const attrs = parseAttrs(m[3]);
    const selfClose = m[4] === '/';

    if (closing) { top = stack.pop() || top; continue; }

    if (tag === 'svg' && !svg) {
      svg = { width: attrs.width, height: attrs.height, viewBox: parseViewBox(attrs.viewbox) };
    }

    const name = attrs['data-name'] || attrs.id || '';
    const next = {
      tag,
      matrix: mul(top.matrix, parseTransform(attrs.transform)),
      name: name || top.name,
      skip: top.skip || SKIP.has(tag)
    };

    if (tag === 'path' && !next.skip && attrs.d) {
      paths.push({
        d: attrs.d,
        matrix: next.matrix,
        name: attrs['data-name'] || attrs.id || top.name || '',
        layer: top.name || ''
      });
    }

    if (!selfClose) { stack.push(top); top = next; }
  }

  return { svg, paths };
}

function parseAttrs(s) {
  const out = {};
  const re = /([a-zA-Z_:][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4];
  }
  return out;
}

function parseViewBox(s) {
  if (!s) return null;
  const v = String(s).trim().split(/[\s,]+/).map(Number);
  if (v.length < 4 || v.some(n => !Number.isFinite(n))) return null;
  return { x: v[0], y: v[1], w: v[2], h: v[3] };
}

// ── 2D 仿射矩陣 [a b c d e f]（跟 SVG 的 matrix() 同順序）──

const IDENT = [1, 0, 0, 1, 0, 0];

function mul(m1, m2) {
  if (m1 === IDENT) return m2;
  if (m2 === IDENT) return m1;
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}

function apply(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * `transform` 屬性。忽略它不會報錯，只是東西**跑到別的地方** ——
 * 而畫面上看起來很正常，所以一定要支援。
 */
export function parseTransform(s) {
  if (!s) return IDENT;
  let m = IDENT;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(s)) !== null) {
    const n = t[2].trim().split(/[\s,]+/).map(Number).filter(Number.isFinite);
    const k = t[1].toLowerCase();
    if (k === 'translate') m = mul(m, [1, 0, 0, 1, n[0] || 0, n[1] || 0]);
    else if (k === 'scale') m = mul(m, [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]);
    else if (k === 'matrix' && n.length >= 6) m = mul(m, n.slice(0, 6));
    else if (k === 'rotate') {
      const a = (n[0] || 0) * Math.PI / 180, c = Math.cos(a), s2 = Math.sin(a);
      const R = [c, s2, -s2, c, 0, 0];
      if (n.length >= 3) {
        m = mul(m, mul([1, 0, 0, 1, n[1], n[2]], mul(R, [1, 0, 0, 1, -n[1], -n[2]])));
      } else m = mul(m, R);
    } else if (k === 'skewx') m = mul(m, [1, 0, Math.tan((n[0] || 0) * Math.PI / 180), 1, 0, 0]);
    else if (k === 'skewy') m = mul(m, [1, Math.tan((n[0] || 0) * Math.PI / 180), 0, 1, 0, 0]);
  }
  return m;
}
