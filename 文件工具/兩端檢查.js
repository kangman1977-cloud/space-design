'use strict';
/* ============================================================
 *  兩端檢查 — HTML 的初始狀態與 JS 的開關，是不是同一個機制
 *  建立 2026-08-31
 *
 *  ── 為什麼有這支 ────────────────────────────────
 *  【實證 2026-08-31，我自己推了一個壞的版本上線】
 *  介面編排第 2 段把 `updateBar()` 裡 45 個 `disabled = 條件`
 *  改成 `hidden = 條件`。⛔ 而那些按鈕在 `index.html` 裡
 *  **本來就帶著 `disabled` 屬性當初始狀態** ——
 *  原本是 `updateBar()` 每次把它改回 `false`，改完之後
 *  **再也沒有人去清它** → 34 顆按鈕【看得到、永遠按不下去】。
 *
 *  🔴 這正是鐵律二：**性質由「兩端」決定時，只改一端 ＝ 沒改。**
 *  兩端是：① `index.html` 的初始屬性　② JS 的每次指派。
 *
 *  ⚠ **當時的三道機械檢查全部放它過關**，我甚至還特地跑了一道
 *  「⛔ 沒有元件同時被 disabled 又被 hidden」—— 而那道**只看 js/ 那一端**。
 *  ⇒ **檢查本身犯了跟程式一模一樣的錯。**
 *
 *  ── 🔴 它只問結構，⛔ 不問語意 ────────────────────
 *  `目次產生器.js` 的檔頭立過一條界線，這支必須遵守：
 *
 *  > 機械檢查只能問「這件事成不成立」（二元、由系統給答案），
 *  > ⛔ 不能問「這兩段文字是不是同一件事」（那是語意，會誤報）。
 *
 *  ⚠ **第一版問錯了**：我問「JS 有沒有【任何地方】會清掉這個 disabled」——
 *  那是語意，所以它在 `editNum` 上**當場誤報**（那支用區域變數
 *  `box.disabled = …` 設，id 字串附近根本沒有 `disabled` 這個字）。
 *
 *  ⭐ **正確的問法是二元的**：
 *
 *  > 這個元件在 HTML 裡用 A 機制表達「不可用」，
 *  > 而 JS 卻用 B 機制開關它 —— **A ≠ B 就是錯**，
 *  > ⛔ 完全不必知道「JS 有沒有清 A」。
 *
 *  這樣 `editNum`（HTML disabled ＋ JS 也是 disabled）就不會被點名。
 *
 *  ── ⚠ 它看得懂什麼、看不懂什麼（⛔ 要老實寫出來）────
 *  看得懂：`$('id').hidden = …`／`$('id').disabled = …`
 *          `for (const id of ['a','b',…]) $(id).hidden = …`（同一行）
 *  ⛔ 看不懂：區域變數（`const b = $('x'); b.hidden = …`）、
 *          `querySelectorAll` 掃一批、跨行的陣列迴圈。
 *
 *  🔴 **看不懂的一律【漏報】，⛔ 不猜** —— 誤報比漏報更糟（坑第 18 條）。
 *  ⇒ 通過⛔ 不代表「一定沒事」，但**被點名的一定是真的錯**。
 *
 *  ── 用法 ────────────────────────────────────────
 *    node 文件工具/兩端檢查.js
 *
 *  回傳碼：0 ＝ 沒有兩端打架　1 ＝ 有（會逐一列出）
 * ============================================================ */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** 要檢查的「一個 HTML ＋ 它的那些 JS」。日後多一個工具就多一列 */
const TARGETS = [
  {
    name: '建模器',
    html: '建模器/index.html',
    js: [
      '建模器/js/main.js',
      '建模器/js/ui/toolbar.js',
      '建模器/js/ui/exportPanel.js',
      '建模器/js/ui/importPanel.js',
      '建模器/js/ui/slicePanel.js',
      '建模器/js/ui/unfoldPanel.js'
    ]
  }
];

/**
 * 兩個互斥的「不可用」機制。
 * ⚠ 同一個元件**兩種都用**是可以的（鋼筆那幾顆就是：
 * `hidden` ＝ 只在鋼筆模式出現、`disabled` ＝ 在模式裡但點數不夠）——
 * ⭐ **所以判準⛔ 不是「兩種都有就錯」**，
 * 是「**HTML 只寫了 A，而 JS 只開關 B**」。
 */
const PROPS = ['hidden', 'disabled'];

/** HTML：每個有 id 的表單元件，開頭標籤裡寫了哪些機制 */
function scanHTML(src) {
  const out = new Map();
  const re = /<(button|input|select|textarea)\s+([^>]*)>/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const attrs = m[2];
    const id = (attrs.match(/\bid="([\w-]+)"/) || [])[1];
    if (!id) continue;
    const has = PROPS.filter(p => new RegExp('(^|\\s)' + p + '(\\s|=|$)').test(attrs));
    out.set(id, new Set(has));
  }
  return out;
}

/** JS：每個 id 被指派過哪些機制 */
function scanJS(src) {
  const out = new Map();
  const add = (id, p) => {
    if (!out.has(id)) out.set(id, new Set());
    out.get(id).add(p);
  };
  for (const p of PROPS) {
    // 直接的：$('id').hidden = …
    const re = new RegExp("\\$\\('([\\w-]+)'\\)\\s*\\.\\s*" + p + "\\s*=", 'g');
    let m;
    while ((m = re.exec(src)) !== null) add(m[1], p);
    // 同一行的陣列迴圈：for (const id of ['a','b']) $(id).hidden = …
    for (const line of src.split('\n')) {
      if (!new RegExp('\\$\\(\\w+\\)\\s*\\.\\s*' + p + '\\s*=').test(line)) continue;
      const arr = line.match(/\[([^\]]*)\]/);
      if (!arr) continue;
      for (const q of arr[1].matchAll(/'([\w-]+)'/g)) add(q[1], p);
    }
  }
  return out;
}

let bad = 0;
console.log('\n🔴 兩端檢查：HTML 的初始狀態 vs JS 的開關\n');

for (const t of TARGETS) {
  const html = scanHTML(fs.readFileSync(path.join(ROOT, t.html), 'utf8'));
  const js = new Map();
  for (const f of t.js) {
    for (const [id, set] of scanJS(fs.readFileSync(path.join(ROOT, f), 'utf8'))) {
      if (!js.has(id)) js.set(id, new Set());
      for (const p of set) js.get(id).add(p);
    }
  }

  const hits = [];
  for (const [id, hset] of html) {
    if (!hset.size) continue;              // HTML 沒寫初始狀態 → 這支不管
    const jset = js.get(id);
    if (!jset || !jset.size) continue;     // JS 完全沒開關它 → 看不懂，⛔ 漏報
    /** 🔴 判準：HTML 寫的那些，JS 一個都沒開關 → 兩端在講不同的事 */
    const shared = [...hset].filter(p => jset.has(p));
    if (!shared.length) {
      hits.push({ id, html: [...hset].join('+'), js: [...jset].join('+') });
    }
  }

  console.log(`── ${t.name} ──  HTML 有初始狀態的元件 ${[...html].filter(x => x[1].size).length} 個`);
  if (!hits.length) {
    console.log('   ✅ 沒有兩端打架的\n');
  } else {
    bad += hits.length;
    for (const h of hits) {
      console.log(`   🔴 ${h.id}：HTML 寫 ${h.html}，而 JS 開關的是 ${h.js}`
        + `　→ ⛔ 沒有人會清掉 HTML 那個，它會永遠卡住`);
    }
    console.log('');
  }
}

if (bad) {
  console.log(`  🔴 ${bad} 個元件的兩端在講不同的事。`);
  console.log('  ⭐ 修法：把 HTML 的初始屬性換成 JS 真正在開關的那一個。\n');
  process.exit(1);
}
console.log('  全部通過。');
console.log('  ⚠ 通過⛔ 不代表一定沒事 —— 區域變數與 querySelectorAll 這支看不懂，'
  + '它一律漏報⛔ 不猜。\n');
