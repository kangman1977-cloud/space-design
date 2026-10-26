/**
 * do.js — AI 協作第二步：「做」
 *
 * 🔴 kang 2026-10-26「同意」（→ `AI協作-設計方向.md`「第二步「做」：動工前查到的」、規格 `規格\建模器-AI協作.md`）：
 * ① 甲 通用的六個指令（照畫面上的字找、真的去按那一顆、真的改那一格）② 乙 視窗裡的設定一段開始問一次、那一段做完改回原本的
 * ③ 甲「看」一起補（物件面板的紅字藍字、體積 → `assist.js`）。
 * 掛在 `window.AI` 底下（跟第一步的「看」「指給你看」同一個）：
 *
 * | 名字 | 做什麼 |
 * |---|---|
 * | `AI.選物件(名字, 加選)` | 跟在畫面上點一下同一支（`sel.set()`）|
 * | `AI.按(按鈕的字, {kang說好})` | 照字找到那一顆按下去 |
 * | `AI.填(名字, 值, {kang說好})` | 照名字找到旁邊那一格，打值、送出 |
 * | `AI.選(名字, 選項, {kang說好})` | 下拉選那一個 |
 * | `AI.勾(名字, 開關, {kang說好})` | 勾選格按一下（已經是那樣就不動）|
 * | `AI.等(秒)` | 等算完（畫面上的「正在…」不見）|
 * | `AI.這一段(要做什麼)` | kang 說好之後才叫：這一段裡改視窗設定不用一個一個問，AI 記下原本的值 |
 * | `AI.這一段結束({留著})` | 這一段改過的視窗設定改回原本的（kang 要留的寫在 `留著`）|
 *
 * 🔴 規則（定案：規則）：
 * - **走跟滑鼠、鍵盤同一條路**：真的 `click()`、改值再送 `input`／`change`；⛔ 直接改程式裡的值
 * - **滑鼠點不到的，指令也不做**：開著視窗（`.uwWin` 整個畫面蓋住）⇒ 只找最上面那個視窗裡的；選物件要點 3D 畫面 ⇒ 視窗開著就不做
 * - 每一步進復原紀錄、名字前面「AI：」（包 `hist.commit` —— 所有改模型的路最後都走這一支）
 * - **跳出「確定嗎？」就停下來**，回那一句話、⛔ 替 kang 按（kang 說好才用 `{ kang說好: true }` 按）
 * - 會丟東西或改到 kang 電腦上的（新建、讀檔、存檔、匯入、匯出、存 SVG／DXF／試片、列印）⇒ 沒給 `kang說好` 不按
 * - 視窗裡的格子 ＝「跟人走」的設定 ⇒ 沒有 `這一段`、也沒給 `kang說好` 不改
 */

import { findTarget, controlOf, lookState, lookText, readWindows, toastWords, readPanel } from './assist.js';

/** 會丟東西或改到 kang 電腦上的（按鈕上的字）*/
export const ASK_BUTTONS = [/^新建$/, /^讀檔$/, /^存檔$/, /^匯入/, /^匯出/, /^存[ 試]/, /^列印$/, /^下載/];
export const needAsk = text => ASK_BUTTONS.some(r => r.test(String(text).trim()));
/** 復原紀錄的名字前面加「AI：」（已經有就不重複）*/
export const aiLabel = label => (typeof label === 'string' && label && !label.startsWith('AI：') ? 'AI：' + label : label);

const visible = el => !!el && el.offsetParent !== null && !el.closest('[hidden]');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const winOf = el => el.closest('.uwWin');
const winName = w => { const h = w && w.querySelector('.uwHead b'); return h ? h.textContent.trim() : (w ? w.id : ''); };

/**
 * 掛上第二步的指令。回傳要放進 `window.AI` 的那幾個（`assist.js` `install(app, extra)`）。
 * @param {object} app main.js 的 app（doc、sel、hist）
 */
export function install(app) {
  let ai = 0;
  const hist = app.hist, orig = hist.commit.bind(hist);
  hist.commit = (label, opt) => orig(ai > 0 ? aiLabel(label) : label, opt);

  const look = () => lookText(lookState(app, readWindows(document), toastWords(document.getElementById('toast')), readPanel(document)));
  const asking = () => { const w = readWindows(document).find(x => x.視窗 === '詢問'); return w ? `「${w.摘要}」（${w.按鈕.join('／')}）` : null; };
  /** 滑鼠點得到的範圍：開著的視窗裡最上面那個（z-index 大的、一樣大就後開的）；沒有 ⇒ 整頁 */
  const topWin = () => {
    const ws = [...document.querySelectorAll('.uwWin')].filter(w => !w.hidden);
    let top = null, z = -Infinity;
    for (const w of ws) { const k = Number(getComputedStyle(w).zIndex) || 0; if (k >= z) { z = k; top = w; } }
    return top;
  };
  const report = async (did, extra = {}) => {
    await sleep(60);
    const q = asking();
    return { 好了: true, 做了: did, ...(q ? { 停下來問: q } : {}), 上一步: hist.undoLabel, 畫面: look(), ...extra };
  };
  /** 每一個指令：先看是不是正在問 kang（滑鼠也點不到後面）；做的時候改模型 ⇒ 復原紀錄「AI：」*/
  const act = (fn, opt = {}) => async (...args) => {
    const q = asking();
    const kangOK = args.length && args[args.length - 1] && args[args.length - 1].kang說好;
    if (q && !(opt.answer && kangOK)) return { 好了: false, 停下來問: q, 原因: '畫面上正在問「確定嗎？」—— 等 kang 回答（kang 說好再用 { kang說好: true } 按那一顆）' };
    ai++;
    try { return await fn(...args); } finally { ai--; }
  };
  /** 照字找：先找滑鼠點得到的（最上面那個視窗裡）；找到的在後面被蓋住 ⇒ 講出來 */
  const find = (q, sel) => {
    const pick = root => {
      const els = [...root.querySelectorAll(sel)].filter(visible);
      const i = findTarget(els.map(e => ({ text: e.textContent.trim(), title: e.title || '' })), q);
      return i < 0 ? null : els[i];
    };
    const w = topWin();
    const el = pick(w || document);
    if (el || !w) return { el };
    const behind = pick(document);
    return { el: null, why: behind ? `「${q}」在後面，被「${winName(w)}」視窗蓋住了（滑鼠也點不到）—— 先關掉那個視窗` : null };
  };
  /** 名字旁邊那一格：label 綁的、或同一排排在名字後面第一個看得到的（`.lbl` 那種 span 也算）*/
  const fieldOf = (lab, tags) => {
    if (!lab) return null;
    const c = lab.tagName === 'LABEL' ? controlOf(lab) : null;
    if (c) return c;
    const row = lab.parentElement;
    return row ? [...row.querySelectorAll(tags)].find(x => visible(x) && x.type !== 'checkbox' && (lab.compareDocumentPosition(x) & 4)) || null : null;
  };

  // ── 一段：kang 說好之後，這一段裡改視窗設定不用一個一個問；結束時改回原本的 ──
  let seg = null;
  const rec = (c, 名字, kind) => {
    if (!seg || !winOf(c) || seg.改過.some(r => r.el === c)) return;
    seg.改過.push({ el: c, 名字, kind, 視窗: winOf(c), 原本: kind === 'checked' ? c.checked : c.value });
  };
  /** 視窗裡的格子 ⇒ 要嘛在「這一段」裡、要嘛 kang 說好；回傳 null ＝ 可以改 */
  const gate = (c, 名字, opt) => (winOf(c) && !seg && !opt.kang說好
    ? { 好了: false, 要先問: `「${名字}」是「${winName(winOf(c))}」視窗裡的設定（跟人走、會記住）—— 先問 kang：一段開始時講「這一段我會改…」，說好再叫 AI.這一段(…)；只改這一格就用 { kang說好: true }` }
    : null);
  const setValue = (c, v) => {
    c.focus();
    c.value = String(v);
    c.dispatchEvent(new Event('input', { bubbles: true }));
    c.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const optText = (c, v) => { const o = [...c.options].find(x => x.value === v); return o ? o.text : v; };

  const 選物件 = act(async (名字, 加選 = false) => {
    const o = app.doc.objects.find(x => x.name === 名字) || app.doc.objects.find(x => x.name.includes(名字));
    if (!o) return { 好了: false, 原因: `找不到叫「${名字}」的物件（有：${app.doc.objects.map(x => x.name).join('、') || '沒有'}）` };
    const w = topWin();
    if (w) return { 好了: false, 原因: `「${winName(w)}」視窗開著，點不到 3D 畫面（滑鼠也點不到）—— 先關掉那個視窗` };
    // 跟在畫面上點一下同一支（select.js pick → set；按著 Shift 點 ⇒ toggle）；加選已經選著的 ⇒ 不動（⛔ 像 Shift 點那樣取消掉）
    if (!加選) app.sel.set([o.id]);
    else if (!app.sel.ids.includes(o.id)) app.sel.toggle(o.id);
    return report(`${加選 ? '加選' : '選'}了「${o.name}」`);
  });

  const 按 = act(async (字, opt = {}) => {
    const { el, why } = find(字, 'button');
    if (!el) return { 好了: false, 原因: why || `畫面上找不到「${字}」這一顆（可能要先打開某個視窗、或先選物件）` };
    const t = el.textContent.trim();
    if (needAsk(t) && !opt.kang說好) return { 好了: false, 要先問: `「${t}」會丟東西或改到 kang 電腦上的檔 —— 先問 kang，說好再用 { kang說好: true }` };
    // 「確定嗎？」的取消／確定：act() 一開始就擋了（kang 說好才走得到這裡）
    if (el.disabled) return { 好了: false, 原因: `「${t}」現在不能按${el.title ? '：' + el.title : ''}` };
    el.click();
    return report(`按了「${t}」`);
  }, { answer: true });

  const 填 = act(async (名字, 值, opt = {}) => {
    const { el: lab, why } = find(名字, 'label, .lbl');
    const c = fieldOf(lab, 'input');
    if (!c || c.tagName !== 'INPUT') return { 好了: false, 原因: why || `找不到「${名字}」那一格` };
    const g = gate(c, 名字, opt);
    if (g) return g;
    if (c.disabled || c.readOnly) return { 好了: false, 原因: `「${名字}」那一格現在不能改${c.title ? '：' + c.title : ''}` };
    rec(c, 名字, 'value');
    setValue(c, 值);
    return report(`「${名字}」改成 ${值}`);
  });

  const 選 = act(async (名字, 選項, opt = {}) => {
    const { el: lab, why } = find(名字, 'label, .lbl');
    const c = fieldOf(lab, 'select');
    if (!c || c.tagName !== 'SELECT') return { 好了: false, 原因: why || `找不到「${名字}」那個下拉` };
    const o = [...c.options].find(x => x.text === 選項 || x.value === 選項) || [...c.options].find(x => x.text.includes(選項));
    if (!o) return { 好了: false, 原因: `「${名字}」沒有「${選項}」這個選項（有：${[...c.options].map(x => x.text).join('／')}）` };
    const g = gate(c, 名字, opt);
    if (g) return g;
    if (c.disabled) return { 好了: false, 原因: `「${名字}」現在不能改${c.title ? '：' + c.title : ''}` };
    rec(c, 名字, 'value');
    setValue(c, o.value);
    return report(`「${名字}」選「${o.text}」`);
  });

  const 勾 = act(async (名字, 開 = true, opt = {}) => {
    const { el: lab, why } = find(名字, 'label');
    /** 勾選格包在名字裡／名字綁的／⚠ 跟名字並排（物件面板「平滑細分」就是這樣，本機抓到）⇒ 同一排名字後面第一個 */
    const row = lab && lab.parentElement;
    const cb = lab && (lab.querySelector('input[type=checkbox]') || (lab.control && lab.control.type === 'checkbox' ? lab.control : null)
      || (row ? [...row.querySelectorAll('input[type=checkbox]')].find(x => visible(x) && (lab.compareDocumentPosition(x) & 4)) : null));
    if (!cb) return { 好了: false, 原因: why || `找不到「${名字}」那個勾選格` };
    const g = gate(cb, 名字, opt);
    if (g) return g;
    if (cb.disabled) return { 好了: false, 原因: `「${名字}」現在不能改${cb.title ? '：' + cb.title : ''}` };
    rec(cb, 名字, 'checked');
    if (cb.checked !== !!開) cb.click();                                    // 真的按一下（跟滑鼠同一個 click）
    return report(`「${名字}」${開 ? '勾了' : '取消'}`);
  });

  const 等 = async (秒 = 60) => {
    const t0 = Date.now();
    while (Date.now() - t0 < 秒 * 1000) {
      const busy = [...document.querySelectorAll('.uwBusy')].some(visible)
        || /正在/.test([...document.querySelectorAll('.bcp [data-k="out"]')].filter(visible).map(e => e.textContent).join(''));
      if (!busy) { await sleep(150); return { 好了: true, 等了秒: (Date.now() - t0) / 1000, 畫面: look() }; }
      await sleep(300);
    }
    return { 好了: false, 原因: `等了 ${秒} 秒還沒算完` };
  };

  const 這一段 = 要做什麼 => {
    if (seg) return { 好了: false, 原因: `上一段「${seg.說明}」還沒結束 —— 先叫 AI.這一段結束()` };
    seg = { 說明: String(要做什麼 || ''), 改過: [] };
    return { 好了: true, 這一段: seg.說明, 提醒: '這一段裡改視窗設定不用再一個一個問；做完叫 AI.這一段結束()，改過的會改回原本的' };
  };

  const 這一段結束 = act(async (opt = {}) => {
    if (!seg) return { 好了: false, 原因: '沒有在「這一段」裡' };
    const keep = new Set(opt.留著 || []);
    const back = seg.改過.filter(r => !keep.has(r.名字)).reverse();
    /** ⚠ 改回原本的也走同一條路 ⇒ 那個視窗要開著（關著的時候送出去，會在看不到的地方重算）*/
    const shut = [...new Set(back.filter(r => !r.el.isConnected || r.視窗.hidden).map(r => winName(r.視窗) || r.名字))];
    if (shut.length) return { 好了: false, 原因: `「${shut.join('」「')}」視窗關著，改不回去 —— 打開那個視窗再叫 AI.這一段結束()（這一段還沒結束）` };
    const done = [];
    for (const r of back) {
      if (r.kind === 'checked') { if (r.el.checked !== r.原本) r.el.click(); done.push(`「${r.名字}」${r.原本 ? '勾回去' : '取消勾'}`); }
      else if (r.el.value !== r.原本) { setValue(r.el, r.原本); done.push(`「${r.名字}」改回 ${r.el.tagName === 'SELECT' ? optText(r.el, r.原本) : r.原本}`); }
    }
    const s = seg;
    seg = null;
    return report(done.length ? `這一段「${s.說明}」結束：${done.join('、')}` : `這一段「${s.說明}」結束：沒有要改回的`,
      { 改回: done, 留著: s.改過.filter(r => keep.has(r.名字)).map(r => r.名字) });
  });

  return { 選物件, 按, 填, 選, 勾, 等, 這一段, 這一段結束 };
}
