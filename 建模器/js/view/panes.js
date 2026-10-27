/**
 * panes.js — 分割畫面的版面（介面第二輪 2a，純算、⛔ 碰 three.js，測試直接叫）
 *
 * 🔴 kang 2026-10-27「同意你的建議」（→ `介面編排-設計方向.md`「2a 動工前查到的」、`規格\建模器-分割畫面.md`）：
 *   版面可以選；每一格預設照 Rhino（四格「上｜透視／前｜側」）；前上側用正交、透視格透視；
 *   每一格左上角選看哪一面：透視、等角、前、後、左、右、上、下（「後、下、另一側」kang 問 ⇒ 放進這個選單）。
 *   樣板 `樣板-分割畫面.html` 就是照這張表排的。
 */

/** 版面：每一格是畫面的比例 [x, y, 寬, 高] ＋ 一開始看哪一面（null ＝ 沿用原本那一格）*/
export const LAYOUTS = {
  '1':  [[0, 0, 1, 1, null]],
  '2h': [[0, 0, .5, 1, 'persp'], [.5, 0, .5, 1, 'front']],
  '2v': [[0, 0, 1, .5, 'persp'], [0, .5, 1, .5, 'top']],
  '3l': [[0, 0, .6, 1, 'persp'], [.6, 0, .4, .5, 'top'], [.6, .5, .4, .5, 'front']],
  '4l': [[0, 0, .65, 1, 'persp'], [.65, 0, .35, 1 / 3, 'top'], [.65, 1 / 3, .35, 1 / 3, 'front'], [.65, 2 / 3, .35, 1 / 3, 'right']],
  '4t': [[0, 0, 1, .62, 'persp'], [0, .62, 1 / 3, .38, 'top'], [1 / 3, .62, 1 / 3, .38, 'front'], [2 / 3, .62, 1 / 3, .38, 'right']],
  '4':  [[0, 0, .5, .5, 'top'], [.5, 0, .5, .5, 'persp'], [0, .5, .5, .5, 'front'], [.5, .5, .5, .5, 'right']],
};

/** 下拉上的字（照樣板）*/
export const LAYOUT_NAMES = {
  '1': '單格', '2h': '左右兩格', '2v': '上下兩格', '3l': '一大兩小',
  '4l': '一大三小（左大）', '4t': '一大三小（上大）', '4': '四格',
};

/** 每一格左上角的視角選單（free ＝ 轉過、不是標準方向；只顯示、⛔ 能選）*/
export const VIEW_NAMES = {
  persp: '透視', iso: '等角', front: '前', back: '後', left: '左', right: '右', top: '上', bottom: '下', free: '自由',
};

/** 標準方向：從哪邊看（相機在目標點的哪一側；單位向量，上、下差一點點避開正上正下）*/
export const VIEW_DIRS = {
  front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0],
  top: [0, 1, 1e-4], bottom: [0, -1, 1e-4], iso: [0.8, 0.65, 0.85],
};

/** 格子之間的縫（px）*/
export const GAP = 2;

/**
 * 畫面 W × H（css px）裡每一格的位置。邊上⛔ 留縫、格子之間留 GAP。
 * @returns {{x:number,y:number,w:number,h:number,view:string|null}[]}
 */
export function paneRects(key, W, H) {
  const L = LAYOUTS[key] || LAYOUTS['1'];
  return L.map(([fx, fy, fw, fh, view]) => {
    const x0 = Math.round(fx * W), x1 = Math.round((fx + fw) * W);
    const y0 = Math.round(fy * H), y1 = Math.round((fy + fh) * H);
    const l = fx > 0 ? GAP / 2 : 0, r = fx + fw < 1 - 1e-9 ? GAP / 2 : 0;
    const t = fy > 0 ? GAP / 2 : 0, b = fy + fh < 1 - 1e-9 ? GAP / 2 : 0;
    return { x: x0 + l, y: y0 + t, w: Math.max(1, x1 - x0 - l - r), h: Math.max(1, y1 - y0 - t - b), view };
  });
}

/** 畫布裡的 (x, y) 落在第幾格（落在縫上 ⇒ 最近的那一格，⛔ 回 -1 讓點選失效）*/
export function paneIndexAt(rects, x, y) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - (r.x + r.w) : 0;
    const dy = y < r.y ? r.y - y : y > r.y + r.h ? y - (r.y + r.h) : 0;
    const d = dx + dy;
    if (d === 0) return i;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/** 這一格的標準方向是正交還是透視（前後左右上下 ⇒ 正交；透視 ⇒ 透視；等角 ⇒ 照原本）*/
export const wantsOrtho = view => (view === 'persp' ? false : view && view !== 'iso' && view !== 'free' ? true : null);
