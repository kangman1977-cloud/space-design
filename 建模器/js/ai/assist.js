/**
 * assist.js — AI 協作第一步：「看」與「指給你看」
 *
 * 🔴 kang 2026-10-25（→ `AI協作-設計方向.md`、規格 `規格\建模器-AI協作.md`）：Claude 在 Claude 的 app 裡開著建模器，
 * 教 kang、跟 kang 一起做。第一步只做「看」與「指給你看」—— ⛔ 改模型、⛔ 改選取、⛔ 在畫面上多按鈕。
 * Claude 用頁面工具呼叫 `window.AI` 底下這幾個：
 *
 * | 名字 | 做什麼 |
 * |---|---|
 * | `AI.看()` | 現在的狀態（物件、選取、拉點線面、開著的視窗上寫的摘要與提醒、上一步）—— 一個物件 |
 * | `AI.看文字()` | 同上講成一段話（教學時讀出來用）|
 * | `AI.指給你看(按鈕的字, 一行字)` | 把那一顆框起來（外框輕輕閃）＋旁邊一行字；留到 kang 按了它或按「知道了」|
 * | `AI.指物件(物件名字, 一行字)` | 3D 畫面上那個物件畫橘色外框＋上面一行提示 |
 * | `AI.收掉()` | 框、字、橘色外框都收掉 |
 * | `AI.按了沒()` | kang 按了被框住的那一顆沒有；框的是名字＋旁邊那一格 ⇒ 改了沒、改成多少（教學核對用）|
 *
 * 定案（kang「同意你的建議」）：① 外框會輕輕閃＋一行字（不擋別的地方）② 留到按了那一顆或按「知道了」
 * ③「看」預設精簡：視窗上的檢查結果照畫面上的字讀（跟 kang 看到的一模一樣，⛔ 重算）—— 要檢查就打開那個視窗再看。
 *
 * 第二步「做」（kang 2026-10-26「同意」）：選物件、按、填、選、勾、等、這一段 在 `do.js`，一樣掛在 `window.AI` 底下；
 * 這一支只多兩樣「看」（③ 甲）：選著的物件**面板上的紅字、藍字**（`readPanel()`）、物件的**體積**（`objectInfo()`）。
 * ⚠ 這一支照舊 ⛔ 改模型、⛔ 改選取 —— 會動東西的都在 `do.js`。
 */

import * as THREE from 'three';
import { PRIM_SPECS } from '../build/prim.js';
import { resolve, resolveWhy, hiddenHint, nameElOf, qText, makeCheck } from './catalog.js';

const KIND_NAME = { solid: '實體', sheet: '板件' };
const TYPE_NAME = { mesh: '可編輯網格', bool: '布林', revolve: '旋轉成形' };
const EL_NAME = { vert: '點', edge: '邊', face: '面' };
const r2 = x => Math.round(x * 100) / 100;
const visible = el => !!el && el.offsetParent !== null && !el.closest('[hidden]');

/** 網格照物件的位置角度縮放換成世界座標之後的外框（cm）*/
function worldBox(m, m4) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const p = new THREE.Vector3();
  for (const v of m.verts) {
    p.copy(v.p).applyMatrix4(m4);
    const a = [p.x, p.y, p.z];
    for (let k = 0; k < 3; k++) { if (a[k] < lo[k]) lo[k] = a[k]; if (a[k] > hi[k]) hi[k] = a[k]; }
  }
  return { lo, hi, size: m.verts.length ? [0, 1, 2].map(k => r2(hi[k] - lo[k])) : [0, 0, 0] };
}

/**
 * 一個物件的資料（世界座標的外框，cm）。
 * 🔴 1b（2026-10-25 kang 實測抓到）：勾了平滑細分 ⇒ 另外報**平滑後**的外框與面數 —— 以前只報粗網格的（圓環 60 × 15 × 60、384 面），
 * 畫面、量測、出口用的卻是平滑後的（59.02 × 14.37 × 59.02、6,144 面）⇒ 拿「看」核對數字會對不上。
 */
export function objectInfo(o) {
  const m = o.mesh();
  const m4 = o.matrix();
  const { lo, hi, size } = worldBox(m, m4);
  const t = o.src && o.src.type;
  let smooth = null;
  const sm = o.smoothed ? o.smoothMesh() : m;
  if (o.smoothed) {
    const s = worldBox(sm, m4).size;
    smooth = { 磨幾次: o.subd, 外框cm: { 寬X: s[0], 高Y: s[1], 深Z: s[2] }, 面數: sm.faces.length };
  }
  /**
   * 第二步 ③ 甲（kang 2026-10-26）：報體積 —— 跟面板「結構分析」同一個算法（`toolbar.js` `analyse()`）：
   * 有平滑細分照平滑後的、封閉的才有、乘物件的縮放（|sx·sy·sz|）。開放的（板件、開口的殼）⛔ 報。
   */
  const vol = sm.isClosed() ? r2(sm.volume() * Math.abs(o.scale.x * o.scale.y * o.scale.z)) : null;
  return {
    名稱: o.name,
    種類: KIND_NAME[o.kind] || o.kind,
    形狀: (PRIM_SPECS[t] && PRIM_SPECS[t].label) || TYPE_NAME[t] || t,
    參數物件: !!o.isParametric,
    外框cm: { 寬X: size[0], 高Y: size[1], 深Z: size[2] },
    中心cm: m.verts.length ? [0, 1, 2].map(k => r2((lo[k] + hi[k]) / 2)) : [0, 0, 0],
    旋轉度: [o.rot.x, o.rot.y, o.rot.z].map(a => r2(a * 180 / Math.PI)),
    縮放: [o.scale.x, o.scale.y, o.scale.z].map(r2),
    ...(o.kind === 'sheet' ? { 板厚cm: o.thickness } : {}),
    ...(smooth ? { 平滑後: smooth } : {}),
    面數: m.faces.length,
    封閉: m.isClosed(),
    ...(vol !== null ? { 體積cm3: vol } : {}),
    ...(o.error ? { 錯誤: o.error } : {})
  };
}

/**
 * 開著的視窗：標題、上面那行摘要、卡片上的提醒（紅 ✗、黃、一般 ⚠ —— 一般提醒畫成灰藍框，⛔ 漏掉；純說明的灰藍框不算）。
 * 照畫面上的字讀 ⇒ 跟 kang 看到的一模一樣。
 */
export function readWindows(root) {
  const out = [];
  for (const el of root.querySelectorAll('.uwWin')) {
    if (el.hidden) continue;
    /** 1b（本機抓到）：「確定嗎？」那個詢問視窗（`askBox.js`）沒有標題 ⇒ 以前只報「askWin」；改成讀問的那句話和按鈕 */
    const askMsg = el.querySelector('#askMsg');
    if (askMsg) {
      out.push({ 視窗: '詢問', 摘要: askMsg.textContent.trim(), 提醒: [], 提醒共: 0, 按鈕: [...el.querySelectorAll('button')].map(b => b.textContent.trim()) });
      continue;
    }
    const head = el.querySelector('.uwHead b'), sum = el.querySelector('.uwSum');
    const notes = [];
    for (const x of el.querySelectorAll('.uwWarn, .uwCaution, .uwSkip')) {
      const s = x.textContent.trim();
      if (s && (/^[✗⚠]/.test(s) || x.classList.contains('uwWarn') || x.classList.contains('uwCaution'))) notes.push(s);
    }
    out.push({ 視窗: head ? head.textContent.trim() : el.id, 摘要: sum ? sum.textContent.trim() : '', 提醒: notes.slice(0, 8), 提醒共: notes.length });
  }
  return out;
}

/**
 * 畫面上面那一行提示（`#toast`）怎麼報（第三輪第三批 ②-8、②-12，kang 2026-10-26「③ 乙 消失的也報、標幾秒前」）：
 * 提示 2.6 秒就收掉，以前照那一格的字讀 ⇒ 消失之後還報成「最近的提示」（T16「改了角度還留著 142」、T18「改了中心線還寫終點在中心線上」都是這樣讀到的）。
 * 還在畫面上 ⇒ 照字；已經收掉 ⇒「（已經消失，3 秒前）…」（`dataset.at` ＝ 出現的時間，main.js `toast()` 記的）；沒有字 ⇒ ''。
 */
export function toastWords(el, now = Date.now()) {
  const t = (el && el.textContent) || '';
  if (!t) return '';
  if (el.classList && el.classList.contains('show')) return t;
  const at = Number(el.dataset && el.dataset.at);
  return Number.isFinite(at) && at > 0 ? `（已經消失，${Math.max(0, Math.round((now - at) / 1000))} 秒前）${t}` : `（已經消失）${t}`;
}

/**
 * 第二步 ③ 甲（kang 2026-10-26）：右邊物件面板上的字 —— 紅字（`.badNote`：算不出來、要處理的）、藍字（`.note`：說明）。
 * 照畫面上的字讀（同 `readWindows()`）；面板收著、或沒有選物件 ⇒ `null`。
 */
export function readPanel(root) {
  const f = root.querySelector('#pForm');
  if (!f || f.hidden) return null;
  const words = sel => [...f.querySelectorAll(sel)].filter(visible).map(x => x.textContent.trim()).filter(Boolean);
  return { 紅字: words('.badNote'), 藍字: words('.note') };
}

/** 「看」：現在的狀態（`windows` ＝ `readWindows()` 的結果、`panel` ＝ `readPanel()` 的；node 測試直接給）*/
export function lookState(app, windows = [], toast = '', panel = null) {
  const { doc, sel, hist } = app;
  const es = sel.editSels || [];
  const picked = es.length ? { [EL_NAME[es[0].kind] || es[0].kind]: es.length } : {};
  return {
    文件: { 名稱: (doc.head && doc.head.name) || '未命名', 物件數: doc.objects.length },
    模式: { 拉點線面: !!sel.editMode, 開著的視窗: windows },
    選取: { 物件: sel.objects.map(o => o.name), ...picked },
    物件: doc.objects.map(objectInfo),
    ...(panel && sel.active ? { 物件面板: { 物件: sel.active.name, ...panel } } : {}),
    復原紀錄: { 上一步: hist.undoLabel, 下一步: hist.redoLabel },
    最近的提示: toast
  };
}

/** 講成一段話 */
export function lookText(L) {
  const box = b => `${b.寬X} × ${b.高Y} × ${b.深Z} cm`;
  const objs = L.物件.map(o => `「${o.名稱}」${o.形狀}${o.種類 === '板件' ? `（板件 ${o.板厚cm} cm）` : ''} ${box(o.外框cm)}`
    + (o.平滑後 ? `（平滑細分磨 ${o.平滑後.磨幾次} 次，平滑後 ${box(o.平滑後.外框cm)}）` : '')).join('、');
  const sel = L.選取.物件.length ? `選著「${L.選取.物件.join('」「')}」` : '沒有選東西';
  const els = Object.entries(L.選取).filter(([k]) => k !== '物件').map(([k, n]) => `${n} 個${k}`).join('');
  const P = L.物件面板;
  return `畫面上有 ${L.文件.物件數} 個物件：${objs || '沒有'}。`
    + `${sel}${els ? `（選了 ${els}）` : ''}。`
    + (L.模式.拉點線面 ? '現在在「拉點線面」。' : '')
    + L.模式.開著的視窗.map(w => w.按鈕 ? `跳出詢問：「${w.摘要}」（${w.按鈕.join('／')}）。` : `開著「${w.視窗}」視窗${w.摘要 ? '：' + w.摘要 : ''}`
      + (w.提醒共 ? `；有 ${w.提醒共} 則提醒，第一則：${w.提醒[0].length > 80 ? w.提醒[0].slice(0, 80) + '…' : w.提醒[0]}` : '') + '。').join('')
    + (P ? (P.紅字.length ? `「${P.物件}」面板上的紅字：${P.紅字.map(s => `「${s}」`).join('')}。` : '')
      + (P.藍字.length ? `面板上有 ${P.藍字.length} 則說明（藍字）。` : '') : '')
    + (L.復原紀錄.上一步 ? `上一步是「${L.復原紀錄.上一步}」。` : '');
}

/**
 * 照「按鈕上的字」找那一顆：字完全一樣 → 說明（title）開頭一樣 → 字裡面有。只找看得到的。
 * @param {{text:string, title:string}[]} cands
 * @returns {number} 第幾個，找不到 -1
 */
export function findTarget(cands, q) {
  const s = String(q).trim();
  let i = cands.findIndex(c => c.text === s);
  if (i < 0) i = cands.findIndex(c => c.title && c.title.startsWith(s));
  if (i < 0) i = cands.findIndex(c => c.text && c.text.includes(s));
  return i;
}

// ═══════════════════════════════════════════════════════
//  畫面：框、一行字、3D 外框
// ═══════════════════════════════════════════════════════

export const POINT_COLOR = 0xff9d2e;
const CSS = [
  '.aiRing { position: fixed; z-index: 99998; border: 3px solid #ff9d2e; border-radius: 8px; pointer-events: none;',
  '  animation: aiPulse 1.2s ease-in-out infinite; }',
  '@keyframes aiPulse { 0%,100% { box-shadow: 0 0 0 3px rgba(255,157,46,.35); } 50% { box-shadow: 0 0 0 9px rgba(255,157,46,.08); } }',
  '.aiTip { position: fixed; z-index: 99999; max-width: 320px; background: #fff7ea; color: #3b2a12; border: 1px solid #ff9d2e;',
  '  border-radius: 8px; padding: 8px 10px; font-size: 13px; line-height: 1.5; box-shadow: 0 4px 14px rgba(0,0,0,.35); }',
  '.aiTip .who { font-weight: bold; color: #b85f00; margin-right: 4px; }',
  '.aiTip button { margin-left: 8px; font-size: 12px; }'
].join('\n');

/** 樣式由程式自己帶（同 `stackView.js`：剛上傳時舊的主頁面配新程式也不會亂）*/
function ensureStyle() {
  if (document.getElementById('aiAssistStyle')) return;
  const st = document.createElement('style');
  st.id = 'aiAssistStyle';
  st.textContent = CSS;
  document.head.appendChild(st);
}

/**
 * 🔴 1b（2026-10-25 kang 實測抓到）：找到的是**名字**（label）⇒ 連它旁邊要打字／要選的那一格一起框。
 * 以前只框得到「保持尖的轉折（°）」那幾個字，數字格本身沒有字找不到。
 * 先問 label 自己綁的那一格（`for` 或包在裡面），再找同一排（同一個上一層）裡、排在它後面第一個看得到的格子。
 * @returns {Element|null}
 */
export function controlOf(el) {
  if (!el || el.tagName !== 'LABEL') return null;
  if (el.control && el.control.type !== 'checkbox' && el.control.type !== 'radio') return el.control;
  if (el.control) return null;        // 勾選格包在 label 裡：label 本身就是要按的
  const row = el.parentElement;
  if (!row) return null;
  const all = [...row.querySelectorAll('input, select, textarea')];
  return all.find(c => c.type !== 'hidden' && visible(c) && (el.compareDocumentPosition(c) & 4)) || null;
}

/**
 * 掛上 `window.AI`。⚠ 只在瀏覽器（main.js 建好 app 之後）。
 * @param {object} app main.js 的 app（doc、sel、hist、view、toast）
 * @param {object} [extra] 第二步「做」的指令（`do.js` `install()` 回傳的），一起放進 `window.AI`
 */
export function install(app, extra = {}) {
  let ring = null, tip = null, target = null, field = null, onClick = null, onChange = null, pressed = null, objShown = false;

  const unpoint = () => {
    if (ring) ring.remove();
    if (tip) tip.remove();
    if (target && onClick) target.removeEventListener('click', onClick, true);
    if (field && onChange) field.removeEventListener('change', onChange, true);
    ring = tip = target = field = onClick = onChange = null;
    if (objShown) { app.view.clearIssuePreview(); objShown = false; }
  };

  const place = () => {
    if (!ring || !target) return;
    const a = target.getBoundingClientRect(), b = field ? field.getBoundingClientRect() : a;
    const r = { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
    r.width = r.right - r.left; r.height = r.bottom - r.top;
    Object.assign(ring.style, { left: r.left - 5 + 'px', top: r.top - 5 + 'px', width: r.width + 10 + 'px', height: r.height + 10 + 'px' });
    if (tip) {
      const below = r.bottom + 12 + tip.offsetHeight < innerHeight;
      Object.assign(tip.style, {
        left: Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, r.left)) + 'px',
        top: (below ? r.bottom + 12 : Math.max(8, r.top - 12 - tip.offsetHeight)) + 'px'
      });
    }
  };
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);

  const pointAt = (q, text) => {
    unpoint();
    ensureStyle();
    // 🔴 功能地圖 b 輪 ④ 甲：先照地圖指定（代號、{在哪, 字}、只給字又只有一個）；字一樣有好幾個 ⇒ 不猜
    const r = resolve(q);
    if (r && !r.el) return { 好了: false, 原因: resolveWhy(q, r), ...(r.好幾個 ? { 地方: r.好幾個.map(x => ({ 在哪: x.在哪, 代號: x.代號 })) } : {}) };
    if (r) {
      const el = r.el, isField = el.tagName !== 'BUTTON' && el.type !== 'checkbox' && el.type !== 'radio';
      target = isField ? nameElOf(el) || el : (el.tagName === 'BUTTON' ? el : el.closest('label') || el);
      field = isField ? el : null;
    } else {
      const els = [...document.querySelectorAll('button, select, input, label')].filter(visible);
      const i = findTarget(els.map(e => ({ text: e.textContent.trim(), title: e.title || '' })), q);
      if (i < 0) return { 好了: false, 原因: hiddenHint(q) || `畫面上找不到「${qText(q)}」（可能藏在收起來的那一排、或要先打開某個視窗）` };
      target = els[i];
      field = controlOf(target);
    }
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    ring = document.createElement('div');
    ring.className = 'aiRing';
    document.body.appendChild(ring);
    if (text) {
      tip = document.createElement('div');
      tip.className = 'aiTip';
      const who = document.createElement('span'); who.className = 'who'; who.textContent = 'Claude';
      const ok = document.createElement('button'); ok.className = 'mini'; ok.textContent = '知道了';
      ok.onclick = () => unpoint();
      tip.append(who, document.createTextNode(text), ok);
      document.body.appendChild(tip);
    }
    place();
    pressed = null;
    onClick = () => { pressed = { 按了: q, 時間: new Date().toLocaleTimeString() }; unpoint(); };
    if (field) {
      // 框的是名字＋旁邊那一格 ⇒ kang 改了那一格才算（點名字不算）；記下改成多少
      onChange = () => { pressed = { 改了: q, 值: field.value, 時間: new Date().toLocaleTimeString() }; unpoint(); };
      field.addEventListener('change', onChange, true);
    } else target.addEventListener('click', onClick, true);
    const where = r ? r.entry.在哪 + '：' : '';
    return { 好了: true, 框住: where + ((target.textContent.trim().slice(0, 30) || (target.title || '').slice(0, 30)) + (field && field !== target ? '＋旁邊那一格' : '')) };
  };

  const pointObj = (name, text) => {
    unpoint();
    const o = app.doc.objects.find(x => x.name === name);
    if (!o) return { 好了: false, 原因: `沒有叫「${name}」的物件` };
    const m4 = o.matrix(), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const p = new THREE.Vector3();
    for (const v of o.mesh().verts) { p.copy(v.p).applyMatrix4(m4); [p.x, p.y, p.z].forEach((x, k) => { if (x < lo[k]) lo[k] = x; if (x > hi[k]) hi[k] = x; }); }
    const c = [];
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) c.push(new THREE.Vector3(x, y, z));
    const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    app.view.setFacePreview(E.flatMap(([a, b]) => [c[a], c[b]]), POINT_COLOR);
    objShown = true;
    if (text) app.toast('Claude：' + text);
    return { 好了: true };
  };

  const look = () => lookState(app, readWindows(document), toastWords(document.getElementById('toast')), readPanel(document));

  window.AI = Object.freeze({
    看: look,
    看文字: () => lookText(look()),
    指給你看: pointAt,
    指物件: pointObj,
    收掉: () => { unpoint(); return { 好了: true }; },
    按了沒: () => pressed,
    核對: makeCheck(look),                       // 功能地圖 b 輪 ② 甲：跟上一次比改到什麼（catalog.js）
    ...extra
  });
}
