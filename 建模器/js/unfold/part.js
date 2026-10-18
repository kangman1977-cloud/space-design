/**
 * part.js — 文件物件與展開引擎之間的轉接層
 *
 * flatten.js 只認識「網格 ＋ 規則」，不認識 ModelObject；
 * rules.js 只認識材料。兩邊都不該知道文件長什麼樣子。
 * 這個檔案負責把 ModelObject 翻譯成它們看得懂的東西，
 * 再把結果翻回文件的語言（份數、名稱、料表）。
 *
 * 這樣做的好處在第 5、7 期會很明顯：展開引擎換掉演算法，
 * 這裡不用改；文件格式加欄位，flatten.js 也不用改。
 */

import * as THREE from 'three';
import { makeRule, DEFAULT_MATERIAL } from './rules.js';
import { unfoldMesh } from './flatten.js';

/**
 * 展開一個物件。
 *
 * @param {ModelObject} obj
 * @param {object} opt { material, flatTolDeg }
 * @returns {{ok:boolean, reason?:string, pieces, warnings, stats, rule}}
 */
export function unfoldObject(obj, opt = {}) {
  const material = opt.material || DEFAULT_MATERIAL;
  /**
   * ⚠ 〔2026-08-23 不再傳 `k`〕展開流程已經沒有任何東西會用到 K 因子。
   * 詳見 `js/unfold/rules.js` 檔頭與 `PROJECT_LOG.md`「尺寸的依據」。
   */
  const rule = makeRule(material, obj.thickness);

  /**
   * ⚠ 這裡**刻意沒有**「不是板件就拒絕展開」這道門。2026-08-22 拿掉的。
   *
   * 原本擋著，理由是「展開的前提是有板厚的一張料，實體要先抽殼」。
   * 那是鈑金的思路：鐵板折彎時中性層長度不變，所以資料要存中性面，
   * 而實體沒有中性面可言。
   *
   * 但這套工具實際的做法是**切開再接合**（珍珠板、發泡板、木板、壓克力），
   * 接縫銑 45 度斜接，板厚由斜面自動吸收 —— 所以每一片就是切到
   * **外緣尺寸**，而實體的網格本來就是外表面。**直接展開它就是正確答案。**
   *
   * 實測佐證：60×45×40 的實體方塊，展開得到十字型 145×210、
   * 面積 13800 ＝ 2×(60×45 + 60×40 + 45×40)，精確。
   * 擋著的時候使用者只能手動把種類改成「板件」繞過去 ——
   * 得到的數字一模一樣，證明擋的只是標籤，不是幾何。
   *
   * 至於「這一片攤不攤得平」「尺寸可不可信」，flatten.js 有自己的判斷
   * （radialFolds、overlap），不需要靠 kind 這個標籤來猜。
   */

  let mesh = obj.mesh();
  const warn = [];

  /**
   * 縮放要吃進去，否則圖面跟實際做出來的東西不一樣大。
   * 但非等比縮放會把圓弧壓成橢圓，折彎半徑就不再是一個數字，
   * 展開長度也算不準 —— 這種情況只能如實告知。
   */
  const s = obj.scale;
  if (Math.abs(s.x - 1) > 1e-9 || Math.abs(s.y - 1) > 1e-9 || Math.abs(s.z - 1) > 1e-9) {
    mesh = mesh.transformed(new THREE.Matrix4().makeScale(s.x, s.y, s.z));
    const uniform = Math.abs(s.x - s.y) < 1e-9 && Math.abs(s.y - s.z) < 1e-9;
    if (!uniform) {
      warn.push('這個物件被非等比縮放過，圓弧會變成橢圓，展開長度只是近似值。'
              + '建議改參數而不是拉縮放');
    }
  }

  /** `opt.mode`：`'dart'` ＝ 省道打版（2026-10-12）；沒給 ＝ 精確分片（原本的路）*/
  const r = unfoldMesh(mesh, rule, { flatTolDeg: opt.flatTolDeg, mode: opt.mode });

  /**
   * 🔴 **陣列的份數⛔ 再乘一次**（2026-10-19 實驗 T3／T7 抓到：份數被平方）。
   *
   * ⚠ 這裡原本寫 `p.qty *= obj.copies` —— 那是「陣列只算一份網格」那個年代的寫法。
   * **現在 `obj.mesh()` 已經把每一份都放進去了**（`build/array.js` `evalArrayTree()`：
   * 板件 `Mesh.merge(copies)`、實體 `unionMeshes(copies)`），
   * 而 `unfoldMesh()` 本來就會把一樣的片併成一張圖 ×N（`flatten.js` `groupIdentical()`）。
   * ⇒ 再乘一次就是 N²：排列 2 份出 4 片、3 份出 9 片、鏡射出 4 片、2 × 3 網格的三角片 ×72。
   *
   * ⭐ **片數只由「實際攤的那份網格」決定**（鐵律二：性質由兩端決定 —— 這裡的兩端是
   * 陣列造網格的那一端、展開數片的這一端；網格那一端改了，這一端要跟著拿掉）。
   * ⭐ 重疊的實體陣列聯集成一塊之後也就對了：一塊就是一塊，⛔ 再乘份數。
   * 〔守門的測試：`tests/run.mjs`「陣列展開的片數」—— 陣列物件 vs 同一份網格烤成的物件，片數與面積要一樣〕
   */

  /**
   * 🔴 **每一片帶著自己的規則（材質＋板厚）**（2026-10-08 查 bug 找到的）。
   * 多個物件一起展開時，整份結果只有一個 `rule`（第一個物件的）——
   * 0.5 與 1.0 的板一起展開，DXF／CSV／標題欄**全部寫 0.5**，而那是要交給師傅的。
   * ⭐ 出圖的地方一律先看 `p.rule`，沒有才用整份的。
   */
  for (const p of r.pieces) { p.owner = obj.name; p.rule = rule; }

  return {
    ok: true,
    pieces: r.pieces,
    /**
     * 程式自己補剪的邊（智慧分切的提案用，2026-10-13）—— 一律是**物件自己那份網格**的邊。
     * ⚠ 縮放過的物件展開的是套了縮放的另一份網格（上面的 `transformed()`）：頂點順序不變，照頂點編號對回來。
     */
    autoEdges: mesh === obj.mesh() ? (r.autoEdges || []) : mapEdgesBack(r.autoEdges || [], mesh, obj.mesh()),
    keepCut: r.keepCut || 0,
    warnings: [...warn, ...r.warnings],
    stats: { ...r.stats, total: r.pieces.reduce((n, p) => n + p.qty, 0) },
    rule
  };
}

/** `transformed()` 出來的網格上的邊 → 原本網格上同一條邊（頂點順序一樣，照頂點編號配對）*/
function mapEdgesBack(hes, from, to) {
  const idx = new Map(from.verts.map((v, i) => [v.id, i]));
  const tIdx = new Map(to.verts.map((v, i) => [v.id, i]));
  const byPair = new Map();
  for (const he of to.edges()) {
    const a = tIdx.get(he.v.id), b = tIdx.get(he.to.id);
    byPair.set(`${Math.min(a, b)}-${Math.max(a, b)}`, he);
  }
  const out = [];
  for (const he of hes) {
    const a = idx.get(he.v.id), b = idx.get(he.to.id);
    const t = byPair.get(`${Math.min(a, b)}-${Math.max(a, b)}`);
    if (t) out.push(t);
  }
  return out;
}

/**
 * 一次展開多個物件，並把結果併成一份。
 * 不同物件之間不合併相同的片 —— 名稱要對得回原件，
 * 現場才知道這張圖是哪個零件。
 */
export function unfoldMany(objs, opt = {}) {
  const pieces = [];
  const warnings = [];
  const skipped = [];
  let rule = null;

  for (const o of objs) {
    const r = unfoldObject(o, opt);
    rule = rule || r.rule;
    if (!r.ok) { skipped.push(`${o.name}：${r.reason}`); continue; }
    for (const p of r.pieces) {
      p.name = objs.length > 1 ? `${o.name}－${p.name}` : `${o.name}`;
      pieces.push(p);
    }
    for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
  }

  /**
   * 🔴 **片號 P01、P02…：DXF、CSV、畫面卡片用同一個號碼**（2026-10-08 查 bug E9，kang 決定）。
   * DXF 用的是舊版格式（R12），標題只能放英文數字 —— 中文名稱會變成「-」，
   * 師傅拿到圖分不出哪片是哪片。⭐ 圖上寫片號，CSV 第一欄也寫片號、旁邊是中文名稱，一對就知道。
   */
  pieces.forEach((p, i) => { p.no = pieceNo(i + 1); });

  return {
    pieces, warnings, skipped, rule,
    stats: {
      pieces: pieces.length,
      total: pieces.reduce((n, p) => n + p.qty, 0),
      area: pieces.reduce((a, p) => a + p.area * p.qty, 0),
      arcBends: pieces.reduce((n, p) => n + p.bends.filter(b => b.isArc).length, 0),
      sharpBends: pieces.reduce((n, p) => n + p.bends.filter(b => !b.isArc).length, 0)
    }
  };
}

/**
 * 備料明細：一片一列。可直接匯出 CSV，
 * 欄位刻意跟「組裝系統結構說明表」的備料表對齊，日後好合併。
 */
/** 片號的寫法只有這一個家：P01、P02 … P100 */
export function pieceNo(n) { return 'P' + String(n).padStart(2, '0'); }

export function billOfMaterials(pieces, rule) {
  return pieces.map((p, i) => ({
    片號: p.no || pieceNo(i + 1),
    名稱: p.name,
    數量: p.qty,
    材質: (p.rule || rule) ? (p.rule || rule).label : '',
    板厚cm: (p.rule || rule) ? (p.rule || rule).thickness : '',
    展開長cm: round(p.width),
    展開寬cm: round(p.height),
    單片面積cm2: round(p.area),
    總面積cm2: round(p.area * p.qty),
    折彎道數: p.bends.length,
    備註: p.warnings.join('；')
  }));
}

export function bomCSV(pieces, rule) {
  const rows = billOfMaterials(pieces, rule);
  if (!rows.length) return '';
  const keys = Object.keys(rows[0]);
  const esc = v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [keys.join(','), ...rows.map(r => keys.map(k => esc(r[k])).join(','))].join('\r\n');
}

const round = v => Math.round(v * 100) / 100;
