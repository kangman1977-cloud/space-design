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
 * @param {object} opt { material, k, flatTolDeg }
 * @returns {{ok:boolean, reason?:string, pieces, warnings, stats, rule}}
 */
export function unfoldObject(obj, opt = {}) {
  const material = opt.material || DEFAULT_MATERIAL;
  const rule = makeRule(material, obj.thickness, { k: opt.k });

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

  const r = unfoldMesh(mesh, rule, { flatTolDeg: opt.flatTolDeg });

  // 陣列的份數要乘上去：12 支一樣的橫料 ＝ 一張圖 ×12。
  // 這是第 2 期把陣列做成修飾器、而不是複製成 12 個物件的理由。
  const copies = obj.copies || 1;
  if (copies > 1) for (const p of r.pieces) p.qty *= copies;

  for (const p of r.pieces) p.owner = obj.name;

  return {
    ok: true,
    pieces: r.pieces,
    warnings: [...warn, ...r.warnings],
    stats: { ...r.stats, total: r.pieces.reduce((n, p) => n + p.qty, 0) },
    rule
  };
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
export function billOfMaterials(pieces, rule) {
  return pieces.map(p => ({
    名稱: p.name,
    數量: p.qty,
    材質: rule ? rule.label : '',
    板厚cm: rule ? rule.thickness : '',
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
