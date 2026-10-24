/**
 * fitTest.js — 試卡片：先切一小片試槽的鬆緊
 *
 * 🔴 第二輪第六批 6b（2026-10-24，kang「6b 照你的建議：甲 梳子一片，A 互卡那一排多一顆「存試卡片」單獨一個檔，
 * 預設照表（7 格、每格 0.1 mm、中間 ＝ 現在的槽寬加減、字寫要填的數字）」
 * → `規格\建模器-剖面分切.md`「試卡片」；查到的、量表 → `實驗-綜合評估-第二輪.md`「6b 試卡片：動工前查到的」）。
 *
 * 一塊梳子，一排 n 個槽，每格槽寬差 step；中間那格 ＝ 現在的「槽寬加減」。
 * 每一格寫「要填進槽寬加減的數字」（cm）—— 人拿同一塊板子的邊插，挑剛好的那格，數字照抄回去。
 * ⛔ 程式自己算、自己改槽寬（切口補償人工處理，kang 2026-08-23）。
 *
 * | 怎麼做 | 規矩 |
 * |---|---|
 * | 槽 | 跟互卡一樣：從頂邊開到一半深、槽口張開 `flare`（45°）、`cutSlots()` 挖 |
 * | 大小 | 格距 max(1.5 cm, 3 × 板厚)、高 max(3 cm, 4 × 板厚)（沙箱量過：板厚 0.5、7 格 ＝ 12 × 3 cm）|
 * | 太窄 | 槽寬 ≤ 0（加減負太多）那一格⛔ 挖、講出來 |
 *
 * 純幾何，不碰 DOM，測得到。單位 cm。
 */

import { signedArea, loopsBounds } from './section.js';
import { cutSlots } from '../build/bool.js';

export const FIT_DEFAULTS = {
  n: 7,          // 幾格
  stepMm: 0.1    // 每格差幾 mm
};
export const FIT_N_MIN = 3, FIT_N_MAX = 9;

/** 0.01 ⇒ "+0.01"、-0.02 ⇒ "-0.02"、0 ⇒ "0.00"（ASCII 減號：DXF 只保證 ASCII）；每格差不是 0.1 mm 的倍數就多一位 */
export function fitLabel(d, dec = 2) {
  const v = Math.round(d * 10 ** dec) / 10 ** dec;
  return (v > 0 ? '+' : v < 0 ? '-' : '') + Math.abs(v).toFixed(dec);
}

/**
 * @param {{t:number, slotAdj?:number, flare?:number}} il 互卡那一排（板厚、槽寬加減、槽口張開）
 * @param {{n?:number, stepMm?:number}} opt
 * @returns {{t, n, step, adj, W, H, pitch, dec, slots:{x:number, d:number, w:number, text:string, cut:boolean}[], skipped:string[],
 *   slice:object}} slice 樣子跟剖面的片一樣（loops、area、bounds、t、tag 'FIT'、label '試卡片'），出圖照用
 */
export function fitComb(il, opt = {}) {
  const t = Math.max(0.01, +il.t || 0.5);
  const adj = +il.slotAdj || 0;
  const f = Math.max(0, +il.flare || 0);
  const n = Math.min(FIT_N_MAX, Math.max(FIT_N_MIN, Math.round(+opt.n || FIT_DEFAULTS.n)));
  const step = Math.max(0.0001, (+opt.stepMm || FIT_DEFAULTS.stepMm) / 10);
  // 每格差 0.1 mm 的倍數 ⇒ 字寫到 0.01 cm；不是（例如 0.05 mm）⇒ 多一位
  const dec = Math.abs(step * 100 - Math.round(step * 100)) < 1e-6 && Math.abs(adj * 100 - Math.round(adj * 100)) < 1e-6 ? 2 : 3;
  const pitch = Math.max(1.5, 3 * t), W = pitch * (n + 1), H = Math.max(3, 4 * t);
  const slots = [], cuts = [], skipped = [];
  for (let i = 0; i < n; i++) {
    const d = Math.round((adj + (i - (n - 1) / 2) * step) * 1e6) / 1e6;
    const w = t + d, x = pitch * (i + 1), text = fitLabel(d, dec);
    const cut = w > 0.005;
    slots.push({ x, d, w, text, cut });
    if (!cut) { skipped.push(text); continue; }
    const L = x - w / 2, R = x + w / 2;
    cuts.push([{ x: L, y: H / 2 }, { x: R, y: H / 2 }, { x: R, y: H + 1 }, { x: L, y: H + 1 }]);
    if (f > 0) cuts.push([{ x: L, y: H - f }, { x: R, y: H - f }, { x: R + f, y: H }, { x: R + f, y: H + f }, { x: L - f, y: H + f }, { x: L - f, y: H }]);
  }
  const pcs = cutSlots([[{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]], cuts);
  const loops = pcs.flatMap(pc => pc.map(pts => { const a = signedArea(pts); return { pts, area: a, isHole: a < 0 }; }));
  const slice = {
    index: 0, tag: 'FIT', label: '試卡片', t, band: 0, z0: -t / 2, z1: t / 2,
    loops, area: loops.reduce((a, l) => a + l.area, 0), bounds: loopsBounds(loops), glue: [], open: 0
  };
  return { t, n, step, adj, W, H, pitch, dec, slots, skipped, slice };
}

/** 字的位置、大小（cm）：每一格槽的正下方 */
export function fitTextAt(fit, s) {
  return { x: s.x, y: fit.H * 0.22, size: Math.min(0.4, fit.pitch * 0.25) };
}

/** 畫面上的預覽（SVG 字串；1 cm ＝ k px）。綠字 ＝ 要填的數字、中間那格（現在的設定）粗一點 */
export function fitSVG(fit, k = 30) {
  const P = p => `${(p.x * k).toFixed(1)},${((fit.H - p.y) * k).toFixed(1)}`;
  const d = fit.slice.loops.map(l => 'M' + l.pts.map(P).join('L') + 'Z').join('');
  const mid = (fit.n - 1) / 2;
  const txt = fit.slots.map((s, i) => {
    const a = fitTextAt(fit, s);
    return `<text x="${(a.x * k).toFixed(1)}" y="${((fit.H - a.y) * k).toFixed(1)}" font-size="${Math.max(10, a.size * k).toFixed(0)}" text-anchor="middle" fill="${s.cut ? '#0a7' : '#c00'}"${i === mid ? ' font-weight="bold"' : ''}>${s.text}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${(fit.W * k + 2).toFixed(0)}" height="${(fit.H * k + 2).toFixed(0)}" viewBox="-1 -1 ${(fit.W * k + 2).toFixed(0)} ${(fit.H * k + 2).toFixed(0)}">`
    + `<path d="${d}" fill="#f4ead8" stroke="#222" stroke-width="1" fill-rule="evenodd"/>${txt}</svg>`;
}
