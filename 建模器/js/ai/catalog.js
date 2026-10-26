/**
 * catalog.js — 功能地圖（第 a 輪：從畫面自動抽）
 *
 * 🔴 kang 2026-10-26「功能地圖照你的建議：① 甲 ② 乙 ③ 甲 ④ 甲」（→ `AI協作-設計方向.md`「功能地圖（第三步之前）」、
 * 規格 `規格\建模器-功能地圖.md`）：① 程式自動抽 —— 網頁裡**每一顆**按鈕、格子、下拉、勾選格都列出來（藏起來的也列，記「現在看得到嗎」），
 * 每次打開就是最新的，⛔ 一份手寫的清單（會跟按鈕對不上）。② 補說明、④ 做法在之後的 b、c 輪。
 *
 * 為什麼要：Claude 沒有被訓練過這個建模器（Blender 有），要知道「有哪些功能、在哪、什麼時候才出現」只能每次讀程式、量位置
 * （沙箱 `輸出\功能地圖研究\`：41 種狀態抓到 362 個、主頁面 51 個那幾種狀態都沒出現過、同一個字 32 個在好幾個地方）。
 *
 * | 給 AI 的 | 做什麼 |
 * |---|---|
 * | `AI.功能地圖()` | 全部：每一筆 `{代號, 在哪, 種類, 字, 說明, 選項, 看得到, 不能按}`；`{只要看得到: true}` ⇒ 只列現在畫面上有的 |
 * | `AI.功能(查詢)` | 照字、說明、代號找（字一樣 → 字開頭一樣 → 字或說明裡有）；同一個字在好幾個地方 ⇒ 全部列出來、各自寫在哪 |
 *
 * 分組照 kang 眼睛看到的那一排（工具列的小標題、左邊工具、物件面板的小標題、視窗的標題）；
 * 「編輯」那一大組（`#gEdit`，拉點線面、鋼筆、刀具、曲線刀具、旋轉成形都在裡面）再照代號的開頭細分（`SUBGROUP`）。
 * ⚠ 這一支只讀畫面、⛔ 改模型、⛔ 按東西。
 */

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();

/** `#gEdit` 裡照代號開頭分（沙箱數過：pen 31、curve 27、sel 10、rev 7、ef 6、knife 5…）；其他的歸「拉點線面：改造型」*/
export const SUBGROUP = [
  [/^pen/, '鋼筆'], [/^curve/, '曲線刀具'], [/^knife/, '刀具'], [/^rev/, '旋轉成形'],
  [/^ef/, '拉點線面：過濾'], [/^(sel|checker|similar|sharp)/, '拉點線面：選取'],
  [/^(edit|g[A-Z]|tool)/, '拉點線面']
];
export function subgroupOf(id) {
  for (const [re, name] of SUBGROUP) if (re.test(id || '')) return name;
  return '拉點線面：改造型';
}

/** 看得到：沒有藏起來、沒有在藏起來的那一層裡（同 `assist.js`）*/
const visible = el => !!el && el.offsetParent !== null && !el.closest('[hidden]');

/**
 * 這一顆在哪（kang 看得到的那一排或那個視窗）。
 * @param {Element} el
 */
export function whereOf(el) {
  const win = el.closest('.uwWin');
  if (win) {
    if (win.querySelector('#askMsg')) return '詢問視窗';
    const h = win.querySelector('.uwHead b');
    return '視窗：' + (h ? clean(h.textContent) : win.id) + (el.closest('.bcp') ? '／切塊頁' : '');
  }
  if (el.closest('#pForm')) {
    let p = el, sub = '';
    while (p && p.id !== 'pForm' && !sub) {
      for (let q = p.previousElementSibling; q; q = q.previousElementSibling) if (q.classList && q.classList.contains('sub')) { sub = clean(q.textContent); break; }
      p = p.parentElement;
    }
    return '物件面板' + (sub ? '：' + sub : '');
  }
  if (el.closest('#rail') || (el.classList && el.classList.contains('tool'))) return '左邊工具';
  const grp = el.closest('.grp');
  if (grp) {
    if (grp.id === 'gEdit') return '工具列：' + subgroupOf(el.id);
    const l = grp.querySelector('.lbl');
    return '工具列：' + (l ? clean(l.textContent) : grp.id || '其他');
  }
  const box = el.parentElement && el.parentElement.closest('[id]');   // 自己的 id ⛔ 算（要的是外面那一塊）
  return '右邊面板：' + (box ? box.id : '其他');
}

/** 說明的第一句（到第一個「：。，」為止）*/
const headOf = t => clean(t).split(/[：。，:]/)[0].slice(0, 24);
const btnText = b => { const lab = b.querySelector && b.querySelector('.lab'); return clean(lab ? lab.textContent : b.textContent); };

/**
 * 這一顆叫什麼：按鈕照上面的字（圖示按鈕照它的小標）；格子照綁的名字、或同一排**緊挨著**的前面那個名字；
 * 格子前面緊挨著一顆按鈕（「變成正圓」旁邊的半徑那種）⇒「按鈕的字：說明的第一句」（按鈕是數字那種只用說明）。
 * 往前找碰到別的格子就停（本機抓到：一直往前找會找到整排的小標「編輯」、或前一格的「Z」，19 格叫錯）。
 */
export function nameOf(el) {
  if (el.tagName === 'BUTTON') return btnText(el) || clean(el.getAttribute && el.getAttribute('aria-label'));
  const lab = el.labels && el.labels[0];
  if (lab) return clean(lab.textContent);
  for (let q = el.previousElementSibling; q; q = q.previousElementSibling) {
    if (q.tagName === 'BUTTON') {
      const b = btnText(q), h = headOf(el.title);
      if (!b || /^[\d.]+$/.test(b)) return h || b;
      return h ? b + '：' + h : b;
    }
    if (q.matches && q.matches('input, select, textarea')) break;
    if (q.matches && q.matches('.lbl, label, span')) { const t = clean(q.textContent); if (t) return t; }
  }
  return headOf(el.title) || clean(el.placeholder || '');
}

const KIND = el => (el.tagName === 'BUTTON' ? '按鈕' : el.tagName === 'SELECT' ? '下拉' : el.type === 'checkbox' ? '勾選' : el.type === 'radio' ? '單選' : '格子');

/** 代號：有 id 用 id；視窗裡用 視窗 id ＋ data-k；都沒有 ⇒ 在哪｜字 */
export function keyOf(el, where, name) {
  if (el.id) return el.id;
  const k = el.dataset && el.dataset.k, win = el.closest('.uwWin');
  if (k) return (win ? win.id + ':' : '') + k;
  return where + '｜' + name;
}

/**
 * 整張地圖：網頁裡每一顆（藏起來的也列）。
 * @param {Document|Element} root
 * @returns {{代號:string, 在哪:string, 種類:string, 字:string, 說明:string, 選項:string[]|null, 看得到:boolean, 不能按:boolean}[]}
 */
export function collect(root) {
  const out = [], seen = new Set();
  for (const el of root.querySelectorAll('button, select, input, textarea')) {
    if (el.type === 'hidden' || el.type === 'file') continue;
    if (el.closest('.aiTip')) continue;                                  // Claude 自己的「知道了」⛔ 算
    const where = whereOf(el), name = nameOf(el);
    let key = keyOf(el, where, name);
    if (seen.has(key)) { let i = 2; while (seen.has(key + '#' + i)) i++; key += '#' + i; }
    seen.add(key);
    const title = clean(el.title || (el.closest('label') && el.closest('label').title) || '');
    out.push({
      代號: key, 在哪: where, 種類: KIND(el), 字: name, 說明: title,
      選項: el.tagName === 'SELECT' ? [...el.options].map(o => clean(o.text)) : null,
      看得到: visible(el), 不能按: !!el.disabled
    });
  }
  return out;
}

/**
 * 照字找：字一樣 → 字開頭一樣 → 字或說明或代號裡有，三種都回、照這個順序排（同一種裡看得到的排前面）；
 * 比的時候空白⛔ 算（「寬」找得到「寬 X」—— 本機抓到：只回字一樣的，找「寬」只回展開圖那一格、漏了方塊的寬 X）。
 * @param {ReturnType<typeof collect>} list
 */
export function lookup(list, q) {
  const ns = t => String(t || '').replace(/\s+/g, '');
  const s = ns(q);
  if (!s) return [];
  const rank = x => {
    const w = ns(x.字);
    if (w === s || x.代號 === s) return 0;
    if (w.startsWith(s)) return 1;
    if (w.includes(s) || ns(x.說明).includes(s) || x.代號.includes(s)) return 2;
    return -1;
  };
  return list.map(x => [rank(x), x]).filter(([r]) => r >= 0)
    .sort((a, b) => a[0] - b[0] || (b[1].看得到 - a[1].看得到)).map(([, x]) => x);
}

/** 掛上去的那兩個（`assist.js` `install(app, extra)` 一起放進 `window.AI`）*/
export function install() {
  return {
    功能地圖: (opt = {}) => { const l = collect(document); return opt.只要看得到 ? l.filter(x => x.看得到) : l; },
    功能: q => {
      const hits = lookup(collect(document), q);
      if (!hits.length) return { 好了: false, 原因: `地圖裡沒有「${q}」（試別的字，或 AI.功能地圖() 看全部）` };
      const ns = t => String(t || '').replace(/\s+/g, ''), same = hits.filter(x => ns(x.字) === ns(q)).length, rest = hits.length - same;
      const tip = [same > 1 ? `「${q}」這個字有 ${same} 個地方 —— 照「在哪」挑` : '', rest && same ? `其他 ${rest} 個是字開頭一樣、或字與說明裡有（排在後面）` : ''].filter(Boolean).join('；');
      return { 好了: true, 共: hits.length, 字一樣: same, ...(tip ? { 提醒: tip } : {}), 結果: hits.slice(0, 12) };
    }
  };
}
