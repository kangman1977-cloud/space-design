/**
 * nest.js — 排版：把展開好的很多片，擺進一張一張板子裡
 *
 * ── 為什麼有這支（kang 2026-10-09 實測打版時提的）──────────
 * 圓環切成 12 條環帶／24 條西瓜皮之後：
 * DXF 把全部片**往右排成一長條**（577 cm 寬，遠超過任何一張板子），
 * SVG **一片一個檔**（12 片 ＝ 12 個檔）—— 「分片會遇到數量很多時...很難做後續的安排」。
 *
 * kang 拍板（互動圖確認過）：
 * | 決定 | 內容 |
 * |---|---|
 * | 板子大小 | 預設 **寬 240 × 高 120 cm（橫放）**，可以自由輸入 |
 * | 存檔 | **每張板一個檔**（SVG、DXF 都是）|
 * | 轉 90° | **做成開關，預設關** —— 布、木皮有紋路，轉了方向會不一樣 |
 * | 預設 | 「排版到板子上」**預設開**；關掉就回到原本的存法 |
 *
 * ── 排法：一列一列擺（「最高的先放」）───────────────────
 * 每片用它的**外框**來排：從最高的開始，同一列擺到滿就換下一列，一張擺不下就開下一張。
 * ⚠ **⛔ 這不是「自動嵌套」**（形狀互相嵌進去省料）—— 彎彎的環帶之間會空一些。
 * 那個難很多，kang 知道、同意先用這個。
 * 比板子還大的片 ⇒ **單獨一張、照它自己的大小，而且標出來**（⛔ 不默默丟掉）。
 *
 * ── 一份「畫什麼」，兩種檔 ─────────────────────────────
 * `boardProgram()` 產出跟 `drawProgram()` 同一種格式（Y 朝上的 cm）——
 * SVG 走 `progSVG()`、DXF 走 `dxf.js` 的 `boardDXF()`、畫面走 `renderCanvas()`，**三個一定一致**。
 * 每一片的內容**直接拿 `drawProgram()` 的**（切割線、孔、折線、接合編號），
 * 只關掉尺寸與每道折線的字（板子上擠不下，而且尺寸在每片的卡片上）。
 *
 * 單位 cm。⛔ 不碰 DOM，Node 裡測得到。
 */

import { drawProgram, sliceProgram, pieceFootprint } from './sheet.js';

/**
 * 一片排版時佔多大（2026-10-19，`實驗-綜合評估.md` ①-7）：勾了畫縫份／黏合片（`opt.margin`）⇒ 含外面那一圈（`pieceFootprint()`）；
 * 沒勾 ⇒ 就是外框的寬、高（跟以前一樣）。
 */
function dimsOf(piece, opt = {}) {
  const f = pieceFootprint(piece, opt);
  return { w: f.x1 - f.x0, h: f.y1 - f.y0 };
}

/** ⚠ 預設照 kang 2026-10-09 講的：120 × 240 橫放、轉 90° 關、間距 1 cm */
export const NEST_DEFAULTS = { on: true, w: 240, h: 120, gap: 1, rotate: false };

const EPS = 1e-9;

/**
 * 🔴 **一片放不放得進板子** —— 排版與智慧分切的提案**共用這一支**（2026-10-13，智慧分切第二步）。
 * 標準：寬高 ≤ 板子寬高 − 2×間距（四周都要留間距）；`rotate` ⇒ 轉 90° 也算。
 * 【實證】第一步的提案只跟板寬板高比、⛔ 扣間距 —— 圓柱那片 179×120 提案說放得進、排版卻放不進。
 * ⇒ 一個判斷只寫一次（鐵律二），⛔ 各算各的。
 * @param {number} w 片的寬  @param {number} h 片的高
 * @param {{w,h,gap,rotate}} opt 跟 `packBoards()` 同一包
 */
export function fitsBoard(w, h, opt = {}) {
  const W = +opt.w > 0 ? +opt.w : NEST_DEFAULTS.w;
  const H = +opt.h > 0 ? +opt.h : NEST_DEFAULTS.h;
  const g = Math.max(0, Number.isFinite(+opt.gap) ? +opt.gap : NEST_DEFAULTS.gap);
  const ok = (a, b) => a <= W - 2 * g + EPS && b <= H - 2 * g + EPS;
  return ok(w, h) || (!!opt.rotate && ok(h, w));
}

/**
 * 🔴 **排版**：先照原本「一列一列」擺一次，再用「任何空位都能塞」擺幾次（`rectPack()`），
 * **用的板子比較少才換**（打平 ⇒ 留原本的，畫面一格都不變）。〔2026-10-15，kang 看 `樣板-排版.html` 後同意〕
 *
 * 【沙箱量的，kang 的設定 120×240、間距 10、可以轉】剖面方塊 45 片 12 → 8 張、圓環西瓜皮 3 → 2、方塊六面 2 → 1；
 * 【預設 240×120、間距 1、不轉】圓柱側面＋兩蓋 2 → 1。⇒ 「一列一列」浪費在兩個地方：
 * 可以轉時每片**固定轉成比較扁的**（⛔ 試另一個方向）、列跟列之間的空位⛔ 拿來用。
 *
 * ⚠ **仍然⛔ 是「自動嵌套」**（照真正的形狀互相嵌進去）—— 一律照外框。
 *
 * @param {object[]} pieces 展開好的片（`qty` 幾片就擺幾份）
 * @param {{w,h,gap,rotate}} opt 板子寬、高（cm）、片與片／片與板邊的間距、可不可以轉 90°
 * @returns {{boards: {w,h,oversize,items:{piece,copy,x,y,w,h,rot}[]}[], count:number}}
 *   `x, y` ＝ 這一片外框的左下角（板子座標，Y 朝上）；`rot` 0 或 90
 */
export function packBoards(pieces, opt = {}) {
  const shelf = shelfPack(pieces, opt);
  const best = rectPackBest(pieces, { w: shelf.W, h: shelf.H, gap: shelf.gap, rotate: !!opt.rotate, margin: opt.margin, rule: opt.rule });
  return best && best.boards.length < shelf.boards.length ? { ...best, W: shelf.W, H: shelf.H, gap: shelf.gap } : shelf;
}

/** 原本的擺法：一列一列、最高的先放（2026-10-09）。`packBoards()` 拿它當底，新的擺法要贏它才換 */
function shelfPack(pieces, opt = {}) {
  const W = +opt.w > 0 ? +opt.w : NEST_DEFAULTS.w;
  const H = +opt.h > 0 ? +opt.h : NEST_DEFAULTS.h;
  const g = Math.max(0, Number.isFinite(+opt.gap) ? +opt.gap : NEST_DEFAULTS.gap);
  /** 不轉的那一種放法放不放得進（轉 90° 的另外排一次候選）—— 判斷本身在 `fitsBoard()` */
  const fits = (w, h) => fitsBoard(w, h, { w: W, h: H, gap: g, rotate: false });

  const todo = [];
  const oversize = [];
  for (const piece of pieces) {
    const D = dimsOf(piece, opt);
    for (let copy = 0; copy < (piece.qty || 1); copy++) {
      const a = { w: D.w, h: D.h, rot: 0 };
      const b = { w: D.h, h: D.w, rot: 90 };
      const cand = (opt.rotate ? [a, b] : [a]).filter(o => fits(o.w, o.h));
      if (!cand.length) { oversize.push({ piece, copy }); continue; }
      // 可以轉時挑「比較扁」的放法 —— 一列比較矮，擺得比較多
      cand.sort((p, q) => p.h - q.h);
      todo.push({ piece, copy, ...cand[0] });
    }
  }

  // 最高的先放（同高的寬的先）—— 每一列的高度由第一片決定
  todo.sort((p, q) => (q.h - p.h) || (q.w - p.w));

  const boards = [];
  for (const it of todo) {
    let placed = false;
    for (const bd of boards) {
      for (const sh of bd.shelves) {
        if (sh.x + it.w <= W - g + EPS && it.h <= sh.h + EPS) {
          bd.items.push({ ...it, x: sh.x, y: sh.y });
          sh.x += it.w + g;
          placed = true;
          break;
        }
      }
      if (placed) break;
      const last = bd.shelves[bd.shelves.length - 1];
      const top = last.y + last.h + g;
      if (top + it.h <= H - g + EPS) {
        bd.shelves.push({ y: top, h: it.h, x: g + it.w + g });
        bd.items.push({ ...it, x: g, y: top });
        placed = true;
        break;
      }
    }
    if (!placed) {
      boards.push({ shelves: [{ y: g, h: it.h, x: g + it.w + g }], items: [{ ...it, x: g, y: g }] });
    }
  }

  /** 第一列擺在板子**上緣**（看起來比較順）：把 Y 上下翻過來 */
  const out = boards.map(bd => ({
    w: W, h: H, oversize: false,
    items: bd.items.map(it => ({ ...it, y: H - it.y - it.h }))
  }));
  /** 比板子還大的：單獨一張、照它自己的大小，⛔ 不轉 */
  for (const o of oversize) {
    const D = dimsOf(o.piece, opt);
    out.push({
      w: D.w + 2 * g, h: D.h + 2 * g, oversize: true,
      items: [{ ...o, x: g, y: g, w: D.w, h: D.h, rot: 0 }]
    });
  }
  return { boards: out, count: todo.length + oversize.length, W, H, gap: g };
}

// ── 新的擺法：任何空位都能塞（MaxRects）────────────────────────
// 每張板記一份「還空著的長方形」清單；放一片就把被它蓋到的空位切開、再把被別的空位整個包住的拿掉。
// 間距的算法跟原本一樣：每片往右、往上各多佔一個間距，空位從 (間距, 間距) 開始、到板子邊為止
// ⇒ 片與板邊、片與片之間都至少一個間距（跟 `fitsBoard()` 同一個標準）。

/** 這個空位放這個大小好不好（越小越好，兩個數字依序比）；放不下 ⇒ null */
function fitScore(fr, w, h, how) {
  if (w > fr.w + EPS || h > fr.h + EPS) return null;
  const lw = fr.w - w, lh = fr.h - h;
  if (how === 'bssf') return [Math.min(lw, lh), Math.max(lw, lh)];   // 剩下的短邊最短
  if (how === 'baf') return [fr.w * fr.h - w * h, Math.min(lw, lh)];  // 剩下的面積最小
  return [fr.y, fr.x];                                                // 越下面、越左邊
}
const better = (a, b) => a[0] < b[0] - EPS || (Math.abs(a[0] - b[0]) <= EPS && a[1] < b[1] - EPS);

/** 在 (x, y) 放一塊 w × h（含間距）：切開被蓋到的空位，拿掉被包住的 */
function takeRect(free, x, y, w, h) {
  const out = [];
  for (const f of free) {
    if (x >= f.x + f.w - EPS || x + w <= f.x + EPS || y >= f.y + f.h - EPS || y + h <= f.y + EPS) { out.push(f); continue; }
    if (x > f.x + EPS) out.push({ x: f.x, y: f.y, w: x - f.x, h: f.h });
    if (x + w < f.x + f.w - EPS) out.push({ x: x + w, y: f.y, w: f.x + f.w - x - w, h: f.h });
    if (y > f.y + EPS) out.push({ x: f.x, y: f.y, w: f.w, h: y - f.y });
    if (y + h < f.y + f.h - EPS) out.push({ x: f.x, y: y + h, w: f.w, h: f.y + f.h - y - h });
  }
  const inside = (a, b) => a.x >= b.x - EPS && a.y >= b.y - EPS && a.x + a.w <= b.x + b.w + EPS && a.y + a.h <= b.y + b.h + EPS;
  return out.filter((a, i) => !out.some((b, j) => j !== i && inside(a, b) && (!inside(b, a) || j < i)));
}

/**
 * 照一種順序、一種挑法、一種轉法擺一次。
 * `pol`：`'best'` 每片兩個方向都試、挑分數好的；`'tall'`／`'wide'` 整批先統一直放／橫放
 * （統一方向放不進空板時，那一片才改試另一個方向）——
 * 【沙箱實證】方塊六面在 120×240 只有「整批直放」排得進 1 張，每片各挑最好的反而排成 2 張。
 */
function rectPack(todo, W, H, g, rotate, how, pol) {
  const boards = [];
  for (const it of todo) {
    const all = [{ w: it.fw, h: it.fh, rot: 0 }];
    if (rotate) all.push({ w: it.fh, h: it.fw, rot: 90 });
    let ors = all;
    if (rotate && pol === 'tall') ors = [all[0].h >= all[1].h ? all[0] : all[1]];
    if (rotate && pol === 'wide') ors = [all[0].w >= all[1].w ? all[0] : all[1]];
    const pick = (free, list) => {
      let best = null;
      for (const o of list) for (const f of free) {
        const sc = fitScore(f, o.w + g, o.h + g, how);
        if (sc && (!best || better(sc, best.sc))) best = { sc, f, o };
      }
      return best;
    };
    let bd = null, b = null;
    for (const cand of boards) { b = pick(cand.free, ors); if (b) { bd = cand; break; } }
    if (!bd) {
      bd = { free: [{ x: g, y: g, w: W - g, h: H - g }], items: [] };
      b = pick(bd.free, ors) || pick(bd.free, all);
      if (!b) return null;                         // ⛔ 應該發生（`fitsBoard()` 已經篩過），保險
      boards.push(bd);
    }
    bd.free = takeRect(bd.free, b.f.x, b.f.y, b.o.w + g, b.o.h + g);
    bd.items.push({ ...it, x: b.f.x, y: b.f.y, w: b.o.w, h: b.o.h, rot: b.o.rot });
  }
  return boards;
}

/** 幾種順序 × 幾種挑法 × 幾種轉法各擺一次，留用板最少的（同樣多 ⇒ 先試到的）。格式跟 `shelfPack()` 一樣 */
function rectPackBest(pieces, opt) {
  const W = opt.w, H = opt.h, g = opt.gap;
  const todo = [], oversize = [];
  for (const piece of pieces) {
    const D = dimsOf(piece, opt);
    for (let copy = 0; copy < (piece.qty || 1); copy++) {
      if (fitsBoard(D.w, D.h, opt)) todo.push({ piece, copy, fw: D.w, fh: D.h });
      else oversize.push({ piece, copy });
    }
  }
  const area = it => it.fw * it.fh;
  const orders = [
    (a, b) => area(b) - area(a),
    (a, b) => Math.max(b.fw, b.fh) - Math.max(a.fw, a.fh),
    (a, b) => Math.min(b.fw, b.fh) - Math.min(a.fw, a.fh),
    (a, b) => (b.fw + b.fh) - (a.fw + a.fh),
    (a, b) => b.fh - a.fh
  ];
  let best = null;
  for (const pol of (opt.rotate ? ['best', 'tall', 'wide'] : ['best'])) {
    for (const ord of orders) {
      const list = todo.slice().sort(ord);
      for (const how of ['bssf', 'baf', 'bl']) {
        const bs = rectPack(list, W, H, g, opt.rotate, how, pol);
        if (bs && (!best || bs.length < best.length)) best = bs;
      }
    }
  }
  if (!best) return null;
  /** 跟原本一樣：第一列擺在板子**上緣**（Y 上下翻過來）；比板子大的照原本的規矩單獨一張 */
  const out = best.map(bd => ({
    w: W, h: H, oversize: false,
    items: bd.items.map(it => ({ ...it, y: H - it.y - it.h }))
  }));
  for (const o of oversize) {
    const D = dimsOf(o.piece, opt);
    out.push({
      w: D.w + 2 * g, h: D.h + 2 * g, oversize: true,
      items: [{ ...o, x: g, y: g, w: D.w, h: D.h, rot: 0 }]
    });
  }
  return { boards: out, count: todo.length + oversize.length };
}

/**
 * 一張板子的「畫什麼」—— 跟 `drawProgram()` 同一種格式（Y 朝上的 cm）。
 * @param {object} board `packBoards()` 回傳的其中一張
 * @param {object} opt 傳給 `drawProgram()` 的（rule、foldSummary…）＋ `label(piece)`
 *   ＋ `draw(piece)`（2026-10-14 剖面分切加的）：給了就用它畫每一片，⛔ 走 `drawProgram()` ——
 *   回傳一樣是「Y 朝上、從 (0,0) 到 (寬,高)」的那種格式（`sliceProgram()` 就是）
 */
export function boardProgram(board, opt = {}) {
  const items = [];
  /** 每一片的面擺到板子上之後在哪（2026-10-21，分片成群第一件：即時預覽點一片 ⇒ 知道點到哪一片）*/
  const hits = [];
  const line = (style, x1, y1, x2, y2) => items.push({ t: 'line', style, x1, y1, x2, y2 });

  // 板子外框：灰色、⛔ 不是切割線（SVG 是灰的註記色、DXF 在 SHEET 層）
  const { w: BW, h: BH } = board;
  line('note', 0, 0, BW, 0); line('note', BW, 0, BW, BH);
  line('note', BW, BH, 0, BH); line('note', 0, BH, 0, 0);

  for (const it of board.items) {
    const p = it.piece;
    const prog = opt.draw ? opt.draw(p) : drawProgram(p, { ...opt, showDims: false, showBendMarks: false });
    /**
     * 片的座標 → 板子座標；轉 90° ＝ 逆時針（(x, y) → (高 − y, x)）。
     * ⚠ 勾了縫份／黏合片：片佔的範圍是 `pieceFootprint()`（外面那一圈在 0 的左邊、下面）⇒ 先挪回 0 再擺（排版排的也是這個範圍）。
     */
    const F = opt.draw ? { x0: 0, y0: 0, x1: p.width, y1: p.height } : pieceFootprint(p, opt);
    const T = (x, y) => (it.rot
      ? { x: it.x + (F.y1 - y), y: it.y + (x - F.x0) }
      : { x: it.x + (x - F.x0), y: it.y + (y - F.y0) });
    /**
     * ⚠ 圓弧折彎的參考線（`bend`）在 `drawProgram()` 裡上下各多畫 1 cm（單片圖上好看）——
     * 排在板子上就會畫進隔壁那片或板邊外（間距 0 時一定會）。⇒ 夾回這一片的高度以內。
     * 【實證 2026-10-09】AI 在線上排版預覽看到藍線伸出片外才發現。
     */
    const clampY = y => Math.max(0, Math.min(p.height, y));
    if (p.faces) hits.push({ piece: p, polys: p.faces.map(poly => poly.map(q => T(q.x, q.y))) });
    for (let e of prog.items) {
      /** 省道打版的拉伸色塊（2026-10-12）：每個點搬到板子上 */
      if (e.t === 'poly') { items.push({ ...e, pts: e.pts.map(q => T(q.x, q.y)) }); continue; }
      if (e.t === 'line') {
        if (e.style === 'bend') e = { ...e, y1: clampY(e.y1), y2: clampY(e.y2) };
        const a = T(e.x1, e.y1), b = T(e.x2, e.y2);
        items.push({ ...e, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      } else {
        // 文字（接合編號）只搬位置、⛔ 不跟著轉 —— 數字保持正的才好讀
        const a = T(e.x, e.y);
        items.push({ ...e, x: a.x, y: a.y });
      }
    }
    // 片號放在外框正中間：跟卡片、CSV、DXF 標題是同一個號碼
    const s = opt.label ? opt.label(p) : (p.no || '');
    if (s) {
      items.push({
        t: 'text', style: 'num', s, anchor: 'middle',
        x: it.x + it.w / 2, y: it.y + it.h / 2,
        size: Math.max(0.8, Math.min(2.4, Math.min(it.w, it.h) * 0.3))
      });
    }
  }
  return { box: { x: 0, y: 0, w: BW, h: BH }, items, hits };
}

/**
 * 🔴 **分片模式的即時預覽：所有片擺成一張**（2026-10-12，省道打版第三步）。
 * ⭐ ⛔ 另寫一套擺法 —— 借排版的 `packBoards()`／`boardProgram()`：板子寬取「夠放最寬那片、而且大致方正」，
 * 高給到放得下全部（一張板），畫完再把板子外框拿掉、外框縮到真的用到的範圍。
 * 預覽太小，接合編號與尺寸都⛔ 畫（`showJoints: false`）。
 * @returns {{box, items}} 跟 `drawProgram()` 同一種格式；沒有片 ⇒ `null`
 */
export function previewProgram(pieces, opt = {}) {
  if (!pieces || !pieces.length) return null;
  const gap = 2;
  const maxW = Math.max(...pieces.map(p => p.width));
  const area = pieces.reduce((a, p) => a + (p.width + gap) * (p.height + gap) * (p.qty || 1), 0);
  const W = Math.max(maxW + 2 * gap, Math.sqrt(area) * 1.4);
  const nest = packBoards(pieces, { w: W, h: 1e7, gap, rotate: false });
  /**
   * 片號：預覽拿的是單一物件的展開（`unfoldObject()`），那條路⛔ 編片號（片號在 `unfoldMany()` 才編）——
   * 沒有就照順序補 P01、P02…（寫法跟 `part.js` 的 `pieceNo()` 一樣）。【實證 2026-10-12】測試抓到預覽一個片號都沒有。
   */
  const no = p => p.no || 'P' + String(pieces.indexOf(p) + 1).padStart(2, '0');
  const prog = boardProgram(nest.boards[0], { ...opt, showJoints: false, label: no });
  const items = prog.items.filter(i => i.style !== 'note');
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const take = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const i of items) {
    if (i.t === 'line') { take(i.x1, i.y1); take(i.x2, i.y2); }
    else if (i.t === 'poly') i.pts.forEach(p => take(p.x, p.y));
    else take(i.x, i.y);
  }
  return { box: { x: x0 - gap, y: y0 - gap, w: x1 - x0 + 2 * gap, h: y1 - y0 + 2 * gap }, items, boards: nest.boards.length, hits: prog.hits };
}

/** 一張板子的標題（SVG 上方、畫面上那張卡片的說明）*/
export function boardTitle(board, i, n, opt = {}) {
  const labels = board.items.map(it => (opt.label ? opt.label(it.piece) : it.piece.no) || '').filter(Boolean);
  const out = [`第 ${i + 1} 張／共 ${n} 張　${fmt(board.w)} × ${fmt(board.h)} cm　${board.items.length} 片`];
  if (board.oversize) out.push('⚠ 這一片比板子還大 —— 單獨一張、照它自己的大小（要換大板或再切小）');
  if (labels.length) out.push(labels.join('、'));
  return out;
}

/**
 * 🔴 **剖面分切的排版**（2026-10-14，kang：「展開圖有可以設定排版…剖面分切也要有」）。
 *
 * ⭐ 擺法、畫法⛔ 另寫：`packBoards()` ＋ `boardProgram()`（給 `draw` 換成 `sliceProgram()`）。
 * 剖面分切多一條規矩：🔴 **不同板厚的片⛔ 放同一張板** —— 一張板就是一種厚度的料
 * （原本 DXF 用圖層 CUT_T10／CUT_T20 分，排版時乾脆分在不同張）。
 *
 * 每一片照**它自己的外框**排（原本預覽與 DXF 是全部共用一個大框，孔才落在同一個位置好對照 ——
 * 排在板子上那個框只會浪費料）。定位孔、層號跟著片走（`sliceProgram()` 本來就畫）。
 * 層號已經畫在孔①下面 ⇒ 板子正中間⛔ 再印一次片號。
 * ⚠ 層號離孔①往下一段，孔①很靠近下緣時字會超出外框一點 —— 它是文字（DXF 在 NUM 層），⛔ 是切割線。
 *
 * @param {object[]} slices section.js 的 slices
 * @param {{w,h,gap,rotate}} nestOpt 跟 `packBoards()` 同一包
 * @param {{pegsOf?:Function, pegD?:number}} o 每一片的孔、孔徑
 * @returns {{t:number, board:object, prog:object}[]} 照板厚由薄到厚、同一種板厚照擺的順序
 */
export function sliceBoards(slices, nestOpt = {}, o = {}) {
  const groups = [];
  for (const sl of slices) {
    const t = Math.round(sl.t * 100) / 100;
    let g = groups.find(q => q.t === t);
    if (!g) { g = { t, list: [] }; groups.push(g); }
    g.list.push(sl);
  }
  groups.sort((a, b) => a.t - b.t);
  const sheets = [];
  for (const g of groups) {
    g.list.sort((a, b) => a.index - b.index);
    const pieces = g.list.map(sl => ({
      slice: sl, width: sl.bounds.w, height: sl.bounds.h, qty: 1,
      no: sl.tag || '#' + String(sl.index).padStart(2, '0')     // 6a 互卡：S、R1…
    }));
    const draw = p => sliceProgram(p.slice, {
      origin: { x: p.slice.bounds.minX, y: p.slice.bounds.minY },
      frame: { w: p.width, h: p.height },
      pegs: o.pegsOf ? (o.pegsOf(p.slice) || []) : [],
      pegD: o.pegD, showDims: false, marks: !!o.marks      // 5a：只有畫面預覽塗顏色
    });
    for (const board of packBoards(pieces, nestOpt).boards) {
      sheets.push({ t: g.t, board, prog: boardProgram(board, { draw, label: () => '' }) });
    }
  }
  return sheets;
}

/** 剖面排版一張板的標題：多一個「板厚」—— 上機時一張板鋪一種厚度的料 */
export function sliceBoardTitle(sheet, i, n) {
  const { board, t } = sheet;
  const out = [`第 ${i + 1} 張／共 ${n} 張　板厚 ${fmt(t)} cm　${fmt(board.w)} × ${fmt(board.h)} cm　${board.items.length} 片`];
  if (board.oversize) out.push('⚠ 這一片比板子還大 —— 單獨一張、照它自己的大小（要換大板或再切小）');
  out.push(board.items.map(it => it.piece.no).join('、'));
  return out;
}

const fmt = v => String(Math.round(v * 100) / 100);

/**
 * 預覽上這一點落在哪一片（2026-10-21，`分片成群-設計方向.md` 第一件：點預覽的一片 ⇒ 3D 上標出來）。
 * `prog` 是 `previewProgram()` 的結果、`(x, y)` 是它的座標（cm、Y 朝上）；落在某一片的任一個面裡 ⇒ 那一片，否則 null。
 */
export function pieceAt(prog, x, y) {
  if (!prog || !prog.hits) return null;
  const inPoly = P => {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      const a = P[i], b = P[j];
      if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  };
  for (const h of prog.hits) if (h.polys.some(inPoly)) return h.piece;
  return null;
}
