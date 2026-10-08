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

import { drawProgram } from './sheet.js';

/** ⚠ 預設照 kang 2026-10-09 講的：120 × 240 橫放、轉 90° 關、間距 1 cm */
export const NEST_DEFAULTS = { on: true, w: 240, h: 120, gap: 1, rotate: false };

const EPS = 1e-9;

/**
 * @param {object[]} pieces 展開好的片（`qty` 幾片就擺幾份）
 * @param {{w,h,gap,rotate}} opt 板子寬、高（cm）、片與片／片與板邊的間距、可不可以轉 90°
 * @returns {{boards: {w,h,oversize,items:{piece,copy,x,y,w,h,rot}[]}[], count:number}}
 *   `x, y` ＝ 這一片外框的左下角（板子座標，Y 朝上）；`rot` 0 或 90
 */
export function packBoards(pieces, opt = {}) {
  const W = +opt.w > 0 ? +opt.w : NEST_DEFAULTS.w;
  const H = +opt.h > 0 ? +opt.h : NEST_DEFAULTS.h;
  const g = Math.max(0, Number.isFinite(+opt.gap) ? +opt.gap : NEST_DEFAULTS.gap);
  const fits = (w, h) => w <= W - 2 * g + EPS && h <= H - 2 * g + EPS;

  const todo = [];
  const oversize = [];
  for (const piece of pieces) {
    for (let copy = 0; copy < (piece.qty || 1); copy++) {
      const a = { w: piece.width, h: piece.height, rot: 0 };
      const b = { w: piece.height, h: piece.width, rot: 90 };
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
    const p = o.piece;
    out.push({
      w: p.width + 2 * g, h: p.height + 2 * g, oversize: true,
      items: [{ ...o, x: g, y: g, w: p.width, h: p.height, rot: 0 }]
    });
  }
  return { boards: out, count: todo.length + oversize.length, W, H, gap: g };
}

/**
 * 一張板子的「畫什麼」—— 跟 `drawProgram()` 同一種格式（Y 朝上的 cm）。
 * @param {object} board `packBoards()` 回傳的其中一張
 * @param {object} opt 傳給 `drawProgram()` 的（rule、foldSummary…）＋ `label(piece)`
 */
export function boardProgram(board, opt = {}) {
  const items = [];
  const line = (style, x1, y1, x2, y2) => items.push({ t: 'line', style, x1, y1, x2, y2 });

  // 板子外框：灰色、⛔ 不是切割線（SVG 是灰的註記色、DXF 在 SHEET 層）
  const { w: BW, h: BH } = board;
  line('note', 0, 0, BW, 0); line('note', BW, 0, BW, BH);
  line('note', BW, BH, 0, BH); line('note', 0, BH, 0, 0);

  for (const it of board.items) {
    const p = it.piece;
    const prog = drawProgram(p, { ...opt, showDims: false, showBendMarks: false });
    /** 片的座標（0..寬, 0..高）→ 板子座標；轉 90° ＝ 逆時針（(x, y) → (高 − y, x)） */
    const T = (x, y) => (it.rot
      ? { x: it.x + (p.height - y), y: it.y + x }
      : { x: it.x + x, y: it.y + y });
    /**
     * ⚠ 圓弧折彎的參考線（`bend`）在 `drawProgram()` 裡上下各多畫 1 cm（單片圖上好看）——
     * 排在板子上就會畫進隔壁那片或板邊外（間距 0 時一定會）。⇒ 夾回這一片的高度以內。
     * 【實證 2026-10-09】AI 在線上排版預覽看到藍線伸出片外才發現。
     */
    const clampY = y => Math.max(0, Math.min(p.height, y));
    for (let e of prog.items) {
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
  return { box: { x: 0, y: 0, w: BW, h: BH }, items };
}

/** 一張板子的標題（SVG 上方、畫面上那張卡片的說明）*/
export function boardTitle(board, i, n, opt = {}) {
  const labels = board.items.map(it => (opt.label ? opt.label(it.piece) : it.piece.no) || '').filter(Boolean);
  const out = [`第 ${i + 1} 張／共 ${n} 張　${fmt(board.w)} × ${fmt(board.h)} cm　${board.items.length} 片`];
  if (board.oversize) out.push('⚠ 這一片比板子還大 —— 單獨一張、照它自己的大小（要換大板或再切小）');
  if (labels.length) out.push(labels.join('、'));
  return out;
}

const fmt = v => String(Math.round(v * 100) / 100);
