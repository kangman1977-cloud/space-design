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
 * 分組照 kang 眼睛看到的那一排（工具列的小標題、右側面板「工具」區的小標題〔介面第二輪 1a：寫「工具：…」〕、左邊工具、物件面板的小標題、視窗的標題）；
 * 「編輯」那一大組（`#gEdit`，拉點線面、鋼筆、刀具、曲線刀具、旋轉成形都在裡面）再照代號的開頭細分（`SUBGROUP`）。
 * ⚠ 這一支只讀畫面、⛔ 改模型、⛔ 按東西。
 */

import { infoOf } from './catalogInfo.js';

const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
const ns = t => String(t || '').replace(/\s+/g, '');

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
  /** 1b（kang 2026-10-27）：「工具」區自己的按鈕（拉出來、放回面板、收起）⇒ 歸「工具」大組（⛔ 落到「右邊面板：…」）*/
  if (!grp && el.closest('#toolFloat, #pTools')) return '工具';
  /** 2a：每一格左上角的視角選單（疊在 3D 畫面上）*/
  if (el.closest('#paneUI')) return '畫面：每一格的視角';
  /** 圖層 2a（kang 2026-10-28）：面板分頁、圖層清單（面板那一頁或拉出來的浮動視窗）⇒ 歸「圖層」（⛔ 跟著擺哪裡變）*/
  if (el.closest('#pTabs')) return '右邊面板：分頁';
  if (el.closest('#pLayers, #layerFloat')) return '圖層';
  if (grp) {
    /**
     * 介面第二輪 1a（kang 2026-10-27）：跟著選取／工具的 9 組在 #toolBox 裡 ——
     * 平常在右側面板最上面的「工具」區、面板收起來時回到工具列 ⇒ 一律寫「工具：…」（照組，⛔ 跟著現在擺哪裡變）
     */
    const head = el.closest('#toolBox') ? '工具：' : '工具列：';
    if (grp.id === 'gEdit') return head + subgroupOf(el.id);
    const l = grp.querySelector('.lbl');
    return head + (l ? clean(l.textContent) : grp.id || '其他');
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
 * 整張地圖：網頁裡每一顆（藏起來的也列）；每一筆帶著那一顆的元素（`el`，給指定是哪一個用）。
 * @param {Document|Element} root
 */
export function walk(root) {
  const out = [], seen = new Set();
  for (const el of root.querySelectorAll('button, select, input, textarea')) {
    if (el.type === 'hidden' || el.type === 'file') continue;
    if (el.closest('.aiTip')) continue;                                  // Claude 自己的「知道了」⛔ 算
    const where = whereOf(el), name = nameOf(el);
    let key = keyOf(el, where, name);
    if (seen.has(key)) { let i = 2; while (seen.has(key + '#' + i)) i++; key += '#' + i; }
    seen.add(key);
    // 說明：自己的、或外面那一小排的（滑鼠停在格子上，瀏覽器跳的就是最近那一層的 title）；整個視窗、整排工具列、整個面板的⛔ 算
    const tEl = el.title ? el : el.closest('[title]');
    const title = clean(tEl && !(tEl.matches && tEl.matches('.uwWin, .grp, #pForm, #rail, #panel, body')) ? tEl.title : '');
    const e = {
      代號: key, 在哪: where, 種類: KIND(el), 字: name, 說明: title,
      選項: el.tagName === 'SELECT' ? [...el.options].map(o => clean(o.text)) : null,
      看得到: visible(el), 不能按: !!el.disabled
    };
    const inf = infoOf(e);                                               // b 輪：前提、規格、核對（catalogInfo.js 照組寫的表）
    out.push({ ...e, 前提: inf.前提, 規格: inf.規格, 核對: inf.核對, el });
  }
  return out;
}

/**
 * 整張地圖（給 AI 看的，不帶元素）。
 * @param {Document|Element} root
 * @returns {{代號:string, 在哪:string, 種類:string, 字:string, 說明:string, 選項:string[]|null, 看得到:boolean, 不能按:boolean, 前提:string, 規格:string, 核對:string}[]}
 */
export function collect(root) {
  return walk(root).map(({ el, ...e }) => e);
}

/** 格子旁邊的名字那一個元素（綁的 label、或緊挨著前面的 .lbl／label／span）；框的時候連名字一起框 */
export function nameElOf(el) {
  if (el.labels && el.labels[0]) return el.labels[0];
  const q = el.previousElementSibling;
  return q && q.matches && q.matches('.lbl, label, span') && clean(q.textContent) ? q : null;
}

/** 指定的那一個寫成一句話（回給 AI 的訊息用）*/
export const qText = q => (q && typeof q === 'object' ? (q.代號 || (q.在哪 ? q.在哪 + '｜' : '') + (q.字 || '')) : String(q));

/**
 * 🔴 b 輪 ④ 甲（kang 2026-10-27）：指定是哪一個。q ＝ 代號、{代號}、{在哪, 字}、或只給字。
 * 只給字：看得到的字一樣（空白不算）只有一個 ⇒ 那一個；**好幾個 ⇒ 不猜**（照 Playwright：找到好幾個就不做）；一個都沒有 ⇒ null（照舊的找法）。
 * 以前只給「X」框到的是「寬 X」（a 輪線上先驗抓到）。
 * @param {*} q
 * @param {Document|Element} [root] 滑鼠點得到的範圍（最上面那個視窗）；外面的 ⇒ `在外面`
 * @param {(el:Element)=>boolean} [accept] 只要哪幾種（按 ⇒ 按鈕、填 ⇒ 格子…）
 * @returns {null | {el:Element, entry:object} | {好幾個:object[]} | {藏著:object} | {在外面:object} | {沒有:true}}
 */
export function resolve(q, root = document, accept = () => true) {
  const L = walk(document).filter(x => accept(x.el));
  const inRoot = x => root === document || root.contains(x.el);
  let hits;
  if (q && typeof q === 'object') {
    hits = q.代號 ? L.filter(x => x.代號 === q.代號) : L.filter(x => ns(x.字) === ns(q.字) && (!q.在哪 || x.在哪.includes(q.在哪)));
  } else {
    hits = L.filter(x => x.代號 === String(q));
    if (!hits.length) {
      const v = L.filter(x => x.看得到 && inRoot(x) && ns(x.字) === ns(q));
      if (!v.length) return null;
      return v.length > 1 ? { 好幾個: v } : { el: v[0].el, entry: v[0] };
    }
  }
  if (!hits.length) return { 沒有: true };
  const vis = hits.filter(x => x.看得到);
  if (vis.length > 1) return { 好幾個: vis };
  const h = vis[0] || hits[0];
  if (!h.看得到) return { 藏著: h };
  if (!inRoot(h)) return { 在外面: h };
  return { el: h.el, entry: h };
}

/** resolve() 沒找到一個的時候回給 AI 的那一句 */
export function resolveWhy(q, r) {
  const s = qText(q);
  if (r.好幾個) return `「${s}」有 ${r.好幾個.length} 個地方：${r.好幾個.map(x => x.在哪).join('、')} —— 不猜，用 {在哪:'…', 字:'${typeof q === 'object' ? q.字 || '' : s}'} 或代號指定（代號：${r.好幾個.map(x => x.代號).join('、')}）`;
  if (r.藏著) return `「${s}」現在藏著 —— 要先：${r.藏著.前提 || '（地圖沒寫，看規格）'}`;
  if (r.沒有) return `地圖裡沒有「${s}」（試 AI.功能('${s}') 找）`;
  return '';
}

/** 舊的找法也找不到的時候：藏著的裡面有沒有字一樣的 ⇒ 講要先做什麼 */
export function hiddenHint(q, accept = () => true) {
  if (q && typeof q === 'object') return '';
  const h = walk(document).filter(x => accept(x.el) && !x.看得到 && ns(x.字) === ns(q));
  return h.length ? `「${q}」現在藏著 —— 要先：${[...new Set(h.map(x => x.前提 || '（地圖沒寫）'))].join('；或 ')}` : '';
}

/**
 * 照字找：字一樣 → 字開頭一樣 → 字或說明或代號裡有，三種都回、照這個順序排（同一種裡看得到的排前面）；
 * 比的時候空白⛔ 算（「寬」找得到「寬 X」—— 本機抓到：只回字一樣的，找「寬」只回展開圖那一格、漏了方塊的寬 X）。
 * @param {ReturnType<typeof collect>} list
 */
export function lookup(list, q) {
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

/**
 * 「看」攤平成一行一欄（物件、視窗照名字、⛔ 照第幾個 —— 多一個物件時不會整串錯位）
 * @returns {Object<string, *>}
 */
export function flatLook(o, p = '', out = {}) {
  if (Array.isArray(o)) o.forEach((v, i) => flatLook(v, p + '[' + (v && typeof v === 'object' && (v.名稱 || v.視窗) ? (v.名稱 || v.視窗) : i) + ']', out));
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) flatLook(v, p ? p + '.' + k : k, out);
  else out[p] = o;
  return out;
}

/** 前後兩次「看」差在哪（「最近的提示」另外講，⛔ 算在改到裡）*/
export function diffLook(a, b) {
  const A = flatLook(a), B = flatLook(b), out = [];
  for (const k of new Set([...Object.keys(A), ...Object.keys(B)])) {
    if (k === '最近的提示' || A[k] === B[k]) continue;
    const f = v => (v === undefined ? '（沒有）' : typeof v === 'string' ? `「${v}」` : String(v));
    out.push(`${k}：${f(A[k])} → ${f(B[k])}`);
  }
  return out;
}

/**
 * 🔴 b 輪 ② 甲：`AI.核對()` —— 每叫一次就跟上一次比、再記下現在的；第一次只記。
 * 「看」裡沒有一個數字變 ⇒ 講「設定類的看按鈕亮不亮、上面那行提示」（沙箱：吸附 5 比不出來）。
 * @param {() => object} look `AI.看`
 */
export function makeCheck(look) {
  let last = null;
  return () => {
    const now = look();
    if (!last) { last = now; return { 好了: true, 記下了: true, 說明: '記下現在的樣子；做完再叫一次 AI.核對() 就比出改到什麼' }; }
    const d = diffLook(last, now);
    last = now;
    return { 好了: true, 共: d.length, 改到: d, ...(d.length ? {} : { 沒變: '「看」裡沒有一個數字變 —— 設定類的看按鈕亮不亮、上面那行提示' }), 提示: now.最近的提示 || '' };
  };
}

/** 掛上去的那兩個（`assist.js` `install(app, extra)` 一起放進 `window.AI`；`AI.核對` 要用「看」，在 assist.js 掛）*/
export function install() {
  return {
    功能地圖: (opt = {}) => { const l = collect(document); return opt.只要看得到 ? l.filter(x => x.看得到) : l; },
    功能: q => {
      const hits = lookup(collect(document), q);
      if (!hits.length) return { 好了: false, 原因: `地圖裡沒有「${q}」（試別的字，或 AI.功能地圖() 看全部）` };
      const same = hits.filter(x => ns(x.字) === ns(q)).length, rest = hits.length - same;
      const tip = [same > 1 ? `「${q}」這個字有 ${same} 個地方 —— 照「在哪」挑` : '', rest && same ? `其他 ${rest} 個是字開頭一樣、或字與說明裡有（排在後面）` : ''].filter(Boolean).join('；');
      return { 好了: true, 共: hits.length, 字一樣: same, ...(tip ? { 提醒: tip } : {}), 結果: hits.slice(0, 12) };
    }
  };
}
