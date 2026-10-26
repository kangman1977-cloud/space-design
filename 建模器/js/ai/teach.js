/**
 * teach.js — AI 協作第三步：「一步一步教」
 *
 * 🔴 kang 2026-10-27「第三步照你的建議：① 甲 ② 甲 ③ 甲 ④ 甲 ⑤ 甲」（→ `AI協作-設計方向.md`「第三步「一步一步教」：動工前查到的」、
 * 規格 `規格\建模器-AI協作.md`「第三步」）。教學模式：Claude 把按鈕框起來、**kang 自己按**、Claude 核對。
 *
 * | 給 AI 的 | 做什麼 |
 * |---|---|
 * | `AI.教學開始(要教什麼)` | 開始記 kang 按了哪一顆（④ 甲：只在教學時開著、只記不擋、不存）|
 * | `AI.等kang按(要框的, 一行字, {秒, 進度})` | 框起來（同「指給你看」）→ 等 kang 按（① 甲：同一回合等，一次最多 40 秒）→ 回按對了／按了別的／沒按 |
 * | `AI.繼續等(秒)` | 上一步沒等到 ⇒ 不重框、接著等（kang 在兩次之間按了也接得到）|
 * | `AI.等kang選(物件名字, 一行字, {秒, 進度})` | 3D 畫面上框那個物件（同「指物件」）→ 等 kang 點它 |
 * | `AI.教學紀錄()` | 這一次教了哪幾步、按對按錯、花幾秒（② 甲 照表現放手時看這個）|
 * | `AI.教學結束()` | 收掉框、停止記錄（⑤ 甲 kang 說「停」也叫這個）|
 *
 * ③ 甲：按錯了回「按的是哪一顆」＋「改到模型了沒」—— Claude 講出來、框留著；改到了就問 kang 要不要復原，⛔ 自己復原。
 * ⑤ 甲：`進度`（例「第 1／6 大步・第 2 顆」）寫在那一行字前面；kang 說「略過」⇒ Claude 用第二步的指令幫忙做（照樣核對）。
 * ⚠ 只讀、只記：⛔ 擋 kang 的點擊、⛔ 改模型（框、等、記錄而已）。
 */

import { walk } from './catalog.js';

/** 一次最多等幾秒（頁面工具一次呼叫最多 45 秒；沙箱量的）*/
export const MAX_WAIT = 40;

/** 那一行字前面加進度 */
export const withProgress = (進度, text) => (進度 ? `${進度}：${text || ''}` : (text || ''));

/**
 * 這一下等到了什麼。⚠ 先看框住那一顆（`按了沒`），再看別的（記錄）—— 同一下兩個都會記到。
 * @param {{pressed:object|null, recs:object[], undoBefore:string|null, undoNow:string|null}} s
 * @returns {object|null} null ＝ 還沒按，繼續等
 */
export function judge({ pressed, recs, undoBefore, undoNow }) {
  if (pressed) return { 結果: '按對了', ...(pressed.值 !== undefined ? { 值: pressed.值 } : {}) };
  if (recs && recs.length) {
    const c = recs[recs.length - 1];
    return { 結果: '按了別的', 按的: { 字: c.字, 在哪: c.在哪, 代號: c.代號 }, 改到模型: undoNow !== undoBefore, 框還在: true };
  }
  return null;
}

/**
 * 掛上第三步的指令。回傳要放進 `window.AI` 的那幾個（`assist.js` `install(app, extra)`）。
 * 框、按了沒、指物件、看用 `window.AI` 上第一步的那幾個（叫的時候才拿，掛的順序不影響）。
 * @param {object} app main.js 的 app（hist）
 */
export function install(app) {
  let on = false, 主題 = '', recs = [], log = [], cur = null;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const undo = () => (app.hist ? app.hist.undoLabel : null);

  /** ④：kang 按了哪一顆 —— 只記、⛔ 擋（capture 階段只看，事件照常往下傳）*/
  const rec = e => {
    if (!on) return;
    const t = e.target, el = t && t.closest && t.closest('button, input, select, textarea');
    if (!el || el.closest('.aiTip')) return;                              // Claude 自己的「知道了」⛔ 算
    if (e.type === 'click' && el.tagName !== 'BUTTON' && el.type !== 'checkbox') return;   // 格子點一下還沒改 ⇒ 等 change
    const x = walk(document).find(y => y.el === el);
    recs.push({ 代號: x ? x.代號 : el.id || '', 字: x ? x.字 : (el.textContent || '').trim(), 在哪: x ? x.在哪 : '',
      ...(e.type === 'change' ? { 值: el.type === 'checkbox' ? el.checked : el.value } : {}), 時間: Date.now() });
  };
  document.addEventListener('click', rec, true);
  document.addEventListener('change', rec, true);

  const need = () => (on ? null : { 好了: false, 原因: '還沒開始教學 —— 先叫 AI.教學開始(要教什麼)' });

  /** 等：每 0.3 秒看一次；最多 秒（≤ 40）*/
  const waitFor = async (check, 秒) => {
    const t0 = Date.now(), lim = Math.min(Math.max(Number(秒) || MAX_WAIT, 1), MAX_WAIT) * 1000;
    while (Date.now() - t0 < lim) {
      const r = check();
      if (r) return { ...r, 秒: Math.round((Date.now() - t0) / 100) / 10 };
      await sleep(300);
    }
    return null;
  };
  const finish = (r, waited) => {
    const out = r || { 結果: '沒按', 等了秒: waited, 框還在: true, 說明: '框還在；kang 按好之後叫 AI.繼續等()，或請 kang 說一聲' };
    if (cur) {
      log.push({ 步: cur.步, 要: cur.要, 結果: out.結果, ...(out.按的 ? { 按的: out.按的.字 + '@' + out.按的.在哪 } : {}), 秒: out.秒 });
      if (r && /對了$/.test(r.結果)) { if (cur.kind === 'obj') window.AI.收掉(); cur = null; }
      else if (r) {                                                     // 按錯了：框留著，下一次只看這之後按的（⛔ 一直回同一下）
        cur.n0 = recs.length; cur.undoBefore = undo();
        if (cur.kind === 'obj') cur.selBefore = window.AI.看().選取.物件.join();
      }
    }
    return { 好了: true, ...out };
  };
  const check = () => {
    if (!cur) return null;
    if (cur.kind === 'obj') {
      const s = window.AI.看().選取.物件;
      if (s.includes(cur.要)) return { 結果: '選對了' };
      if (s.length && s.join() !== cur.selBefore) return { 結果: '選了別的', 按的: { 字: s.join('、'), 在哪: '3D 畫面', 代號: '' }, 改到模型: undo() !== cur.undoBefore };
    }
    return judge({ pressed: cur.kind === 'ctrl' ? window.AI.按了沒() : null, recs: recs.slice(cur.n0), undoBefore: cur.undoBefore, undoNow: undo() });
  };

  return {
    教學開始: (要教什麼 = '') => { on = true; 主題 = String(要教什麼); recs = []; log = []; cur = null; return { 好了: true, 教學: 主題, 提醒: '開始記 kang 按了哪一顆（只記、不擋）；教完叫 AI.教學結束()' }; },
    教學結束: () => { window.AI.收掉(); const n = log.length, ok = log.filter(x => x.結果 === '按對了' || x.結果 === '選對了').length; on = false; recs = []; cur = null; return { 好了: true, 教學: 主題, 教了幾步: n, 對: ok, 紀錄: log.slice() }; },
    教學紀錄: () => ({ 教學: 主題, 開著: on, 記了幾下: recs.length, 紀錄: log.slice() }),
    等kang按: async (q, text, opt = {}) => {
      const n = need(); if (n) return n;
      const p = window.AI.指給你看(q, withProgress(opt.進度, text));
      if (!p.好了) return p;                                              // 藏著 ⇒ 前提；好幾個 ⇒ 不猜（第 b 輪）
      cur = { kind: 'ctrl', 要: p.框住, 步: opt.進度 || '', n0: recs.length, undoBefore: undo() };
      const r = await waitFor(check, opt.秒);
      return finish(r, Math.min(Number(opt.秒) || MAX_WAIT, MAX_WAIT));
    },
    等kang選: async (名字, text, opt = {}) => {
      const n = need(); if (n) return n;
      const p = window.AI.指物件(名字, withProgress(opt.進度, text));
      if (!p.好了) return p;
      cur = { kind: 'obj', 要: 名字, 步: opt.進度 || '', n0: recs.length, undoBefore: undo(), selBefore: window.AI.看().選取.物件.join() };
      const r = await waitFor(check, opt.秒);
      return finish(r, Math.min(Number(opt.秒) || MAX_WAIT, MAX_WAIT));
    },
    繼續等: async (秒) => {
      const n = need(); if (n) return n;
      if (!cur) return { 好了: false, 原因: '沒有在等的那一步（上一步已經接到了，或還沒框）' };
      const r = await waitFor(check, 秒);
      return finish(r, Math.min(Number(秒) || MAX_WAIT, MAX_WAIT));
    }
  };
}
