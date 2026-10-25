/**
 * smoothNote.js — 平滑細分的物件，三條出口（展開、剖面分切、3D 列印）講同一句「差多少」
 *
 * 🔴 第三輪第二批 A（2026-10-26，kang「① 乙 三個視窗都講 ② 差 ≥ 2% 黃字」→ 規格 `規格\建模器-平滑細分.md`「三條出口講差多少」）：
 * 展開照粗網格、列印與剖面照平滑後（第八批 ⑤，kang 定的），**一直都對 —— 但沒有一個出口視窗講兩邊差多少**。
 * T18 燈罩粗輪廓只有 4 個點，平滑照縮寬 −11%：紙模 32 cm、列印 28.45、疊層 28.45，哪個視窗都沒提醒。
 *
 * | 項目 | 做法 |
 * |---|---|
 * | 數字 | 跟物件面板「平滑前 → 平滑後」同一個算法（本地外框 × 縮放）⇒ 三個視窗、面板講的是同一個數字 |
 * | 一樣大（每一邊都差不到 0.01 mm）| 不講（方塊預設 30° 全部保持尖）|
 * | 差 < 2% | 藍字，只講數字 |
 * | 差 ≥ 2% | 黃字，建議勾「尺寸照原本的點（不縮）」；已經勾了就⛔ 再建議 |
 * | 勾了不縮、推不準 | 照樣講差多少，加「這個形狀勾了也推不準」|
 *
 * 🔴 第三輪第三批（2026-10-26，kang「② 甲 列印、剖面加黃字 ① 甲 只講做法」）：
 * - `smoothFlipNote()`：平滑時翻過來的小面，3D 列印卡片、剖面分切也講（以前只在物件面板；T16 列印只報「最薄 0.02 mm」，看不出跟翻面有關）
 * - `allKeptSharp()`：每一條有轉折的邊都保持尖 ⇒ 磨完跟原本一樣（T17 方塊拼的恐龍「寬一樣、高一樣、深一樣」沒講為什麼）
 *
 * 純計算、⛔ 碰畫面。
 */
import { CREASE } from '../core/mesh.js';

export const SMOOTH_WARN_PCT = 2;
const SAME_CM = 0.001;      // 0.01 mm 以內當一樣大
const AXN = ['寬', '高', '深'];

/** 物件的粗網格、平滑後外框（cm，乘縮放）與差多少；沒平滑、一樣大 ⇒ null */
export function smoothDiff(obj) {
  if (!obj || !obj.smoothed) return null;
  const info = obj.smoothInfo();
  if (!info) return null;
  const sc = obj.scale;
  const size = m => { const b = m.bounds(); return [(b.max.x - b.min.x) * Math.abs(sc.x), (b.max.y - b.min.y) * Math.abs(sc.y), (b.max.z - b.min.z) * Math.abs(sc.z)]; };
  const cage = size(obj.mesh()), smooth = size(info.mesh);
  const d = smooth.map((x, k) => x - cage[k]);
  if (d.every(x => Math.abs(x) < SAME_CM)) return null;
  const pct = smooth.map((x, k) => cage[k] > 1e-9 ? (x / cage[k] - 1) * 100 : 0);
  const k = pct.reduce((a, x, i) => Math.abs(x) > Math.abs(pct[a]) ? i : a, 0);
  const ip = info.interp;
  return { cage, smooth, pct, worstPct: Math.abs(pct[k]), worstMM: Math.max(...d.map(Math.abs)) * 10,
    keep: !!obj.subdKeep, interpFailed: !!(ip && !ip.ok) };
}

/**
 * 每一條有轉折的邊（兩側不在同一個平面上）都保持尖 ⇒ `{ n, maxDeg }`；有一條會磨圓、沒平滑、沒有轉折 ⇒ null。
 * 共面的邊（三角形的對角線）磨了也一樣平，不算。
 */
export function allKeptSharp(obj) {
  if (!obj || !obj.smoothed || !obj.smoothInfo()) return null;     // smoothInfo() 先把還沒判過的邊判好（`decideCreases()`）
  const m = obj.mesh();
  m.computeNormals();
  let n = 0, maxDeg = 0;
  for (const he of m.edges()) {
    const d = m.dihedral(he);
    if (d === null || Math.abs(d) * 180 / Math.PI <= 0.5) continue;
    const c = he.crease | 0;
    if (c !== CREASE.AUTO_SHARP && c !== CREASE.SHARP) return null;
    n++; maxDeg = Math.max(maxDeg, Math.abs(d) * 180 / Math.PI);
  }
  return n ? { n, maxDeg: Math.round(maxDeg) } : null;
}

/**
 * 平滑時翻過來的小面，出口（3D 列印、剖面分切）講一句黃字；沒有 ⇒ null。
 * @param {'print'|'slice'} where
 */
export function smoothFlipNote(obj, where) {
  if (!obj || !obj.smoothed) return null;
  const info = obj.smoothInfo();
  if (!info || !info.flipped) return null;
  return { level: 'caution', text: `「${obj.name}」平滑時有 ${info.flipped} 個小面翻過來（物件面板有紅字，可以在畫面上標出來）—— 那裡${where === 'slice' ? '切出來' : '印出來'}會有小瑕疵` };
}

const f2 = x => (Math.round(x * 100) / 100).toString();
const sz = a => a.map(f2).join(' × ');
const mm = x => x >= 10 ? Math.round(x).toString() : (Math.round(x * 10) / 10).toString();
/** 「寬 −11.1%、深 −11.1%」：差不到 0.05% 的那一邊不寫；sign ＝ 從哪一邊看（+1 平滑後比粗網格、−1 粗網格比平滑後）*/
function axes(df, sign) {
  const out = [];
  df.pct.forEach((p, k) => {
    const q = sign > 0 ? p : (df.smooth[k] > 1e-9 ? (df.cage[k] / df.smooth[k] - 1) * 100 : 0);
    const r = Math.round(q * 10) / 10;
    if (Math.abs(r) >= 0.1) out.push(`${AXN[k]} ${r > 0 ? '+' : '−'}${Math.abs(r)}%`);
  });
  return out.join('、') || '差不到 0.1%';
}

/**
 * 出口視窗那一句。
 * @param {object} obj ModelObject
 * @param {'unfold'|'print'|'slice'} where
 * @returns {{level:'note'|'caution', text:string}|null}
 */
export function smoothExitNote(obj, where) {
  const df = smoothDiff(obj);
  if (!df) return null;
  const warn = df.worstPct >= SMOOTH_WARN_PCT;
  const tail = df.interpFailed ? ' —— 這個形狀勾了「尺寸照原本的點（不縮）」也推不準，照縮的'
    : (warn && !df.keep) ? (where === 'unfold' ? ' —— 紙模會比印出來、切出來的大。要一樣大：物件面板勾「尺寸照原本的點（不縮）」'
      : ' —— 兩邊都要做的話，物件面板勾「尺寸照原本的點（不縮）」')
    : df.keep ? '；勾了「尺寸照原本的點」：原本的點在表面上，點跟點之間往外鼓一點' : '';
  const other = where === 'unfold' ? '3D 列印、剖面分切' : where === 'print' ? '剖面分切' : '3D 列印';
  const text = where === 'unfold'
    ? (warn ? `「${obj.name}」有平滑細分：展開照粗網格（${sz(df.cage)} cm），3D 列印、剖面分切照平滑後（${sz(df.smooth)} cm，${axes(df, 1)}）`
      : `「${obj.name}」有平滑細分：展開照粗網格，比 3D 列印、剖面分切${axes(df, -1)}（最多差 ${mm(df.worstMM)} mm）`)
    : (warn ? `「${obj.name}」照平滑後的尺寸（${sz(df.smooth)} cm，比粗網格${axes(df, 1)}）；${other}一樣、展開圖照粗網格 ${sz(df.cage)} cm`
      : `「${obj.name}」照平滑後的尺寸，比展開圖（粗網格）${axes(df, 1)}（最多差 ${mm(df.worstMM)} mm）`);
  return { level: warn ? 'caution' : 'note', text: text + tail };
}
