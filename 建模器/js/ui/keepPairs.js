/**
 * keepPairs.js — 「工具」區裡，按鈕（或名字）跟它的數字格、單位綁成一組，要換行就整組一起換
 *
 * 🔴 介面第二輪 1a（kang 2026-10-27「同意你的建議」）：9 組搬進右側面板之後只有 300 寬 ⇒
 * 拉點線面選了面時有 7 處格子掉到下一行、跟它的按鈕分開（數值、影響半徑、選轉角、選相似、隔一個選一個、內縮、切一刀的座標），
 * `cm`、`公分` 也會單獨一行。kang 2026-08-29 看到過「鎖角度」的「度」被拆開，當時定「併進之後的功能介面討論」—— 就是這一次。
 *
 * ── 怎麼綁（照 2026-10-27 本機列出來的 37 個格子前後是什麼定的）──────────────
 * 一組 ＝ 前面的名字 ＋ 緊挨著的格子 ＋ 後面的單位：
 *   - 前面：往前收連著的名字（`span.lbl`，組名那一個⛔ 收）；沒收到名字 ⇒ 收前面那一顆按鈕（「內縮」＋寬度）；
 *     收到的名字是單位（度、cm…）⇒ 再收它前面那一顆按鈕（「鎖角度」＋「度」＋格子）
 *   - 格子：緊挨著的都算同一組（導角寬度＋段數、切一刀方向＋座標、隔一個選一個的兩格）
 *   - 後面：單位（`span.unit`）、單位按鈕（「公分」「cm」「mm」）、後面⛔ 接格子的名字（「Y：0 ～ 45」「cm 一段」）
 * ⚠ 名字後面接格子 ⇒ 它是下一組的名字，⛔ 收進這一組（「離左邊」「離下邊」各自一組，⛔ 黏成一長串塞不下）。
 *
 * ⭐ 只是外面多包一層 `span.keep`，元件本身一個都沒換 ⇒ 接好的功能、`updateBar()` 的出現／消失照舊；
 *   名字跟它的格子在同一層 ⇒ AI 幫手「名字旁邊那一格」（`ai/do.js` `fieldOf()`）照舊找得到。
 */

const UNIT_TEXT = /^(度|°|cm|mm|公分|%|％)$/;

/**
 * 純邏輯（測試直接叫）：一排子元件 ⇒ 哪幾段要綁成一組。
 * @param {{tag:string, cls?:string[], text?:string, type?:string}[]} kids 一組（.grp）裡的子元件，照順序
 * @returns {[number, number][]} 每一組的 [起, 迄]（含）
 */
export function keepRuns(kids) {
  const tag = k => String(k.tag || '').toUpperCase();
  const has = (k, c) => (k.cls || []).includes(c);
  const txt = k => String(k.text || '').trim();
  const isField = k => k && ((tag(k) === 'INPUT' && k.type !== 'hidden' && k.type !== 'file' && k.type !== 'checkbox') || tag(k) === 'SELECT');
  const isName = (k, i) => k && tag(k) === 'SPAN' && has(k, 'lbl') && i !== 0;           // 第 0 個是組名
  const isBtn = k => k && tag(k) === 'BUTTON';
  const isUnit = k => k && ((tag(k) === 'SPAN' && has(k, 'unit')) || (isBtn(k) && UNIT_TEXT.test(txt(k))));
  const runs = [];
  let used = -1;                                                       // 已經收進某一組的最後一個位置
  for (let i = 0; i < kids.length; i++) {
    if (!isField(kids[i]) || i <= used) continue;
    let s = i;
    while (s - 1 > used && isName(kids[s - 1], s - 1)) s--;
    const tookName = s < i;
    const unitName = tookName && UNIT_TEXT.test(txt(kids[s]));
    if (s - 1 > used && isBtn(kids[s - 1]) && (!tookName || unitName)) s--;
    let e = i;
    while (isField(kids[e + 1])) e++;
    for (;;) {
      const n = kids[e + 1];
      if (isUnit(n)) { e++; continue; }
      if (isName(n, e + 1) && !isField(kids[e + 2])) { e++; continue; }
      break;
    }
    runs.push([s, e]);
    used = e;
  }
  return runs;
}

/**
 * 在畫面上包起來（只做一次；已經包過的組⛔ 再包）。
 * @param {Element} root `#toolBox`
 */
export function bindKeep(root) {
  for (const g of root.querySelectorAll('.grp')) {
    if (g.dataset.keep) continue;
    g.dataset.keep = '1';
    const kids = [...g.children];
    const desc = kids.map(el => ({ tag: el.tagName, cls: [...el.classList], text: el.textContent, type: el.type }));
    for (const [s, e] of keepRuns(desc)) {
      const w = document.createElement('span');
      w.className = 'keep';
      g.insertBefore(w, kids[s]);
      for (let k = s; k <= e; k++) w.appendChild(kids[k]);
    }
  }
}
