'use strict';
/* ============================================================
 *  狀態行數 — 量 STATUS.md 裡【會長大的那兩節】
 *  建立 2026-09-02
 *
 *  ── 為什麼是這兩節，⛔ 不是全檔 ────────────────────
 *  舊的警報線是「全檔 276 行」，而 2026-09-02 量出 307 行裡
 *  **190 行是固定的**（動手前檢查表、穩定參考、落點規則、鐵律索引…）。
 *
 *  🔴 拿全檔行數當線 ＝ 讓「該有的紀律」跟「該搬走的垃圾」一起被算，
 *  而壓力會落在**比較好砍的那一邊** —— 也就是紀律那一邊。
 *  ⚠ 那一天當場應驗：AI 為了壓行數，建議刪掉兩塊
 *  **內容根本沒壞**的規則（kang 剛定調、正在用的），
 *  理由寫在它自己的話裡：「丙必做，因為少了它壓不下來」。
 *  ⭐ 而 kang 一句話照出來：「所以不是為了守住 276 限制而做的決定?」
 *
 *  ⇒ 線只盯**會長大的那兩節**，就⛔ 不可能再逼出那種建議。
 *  〔完整推導 → `PROJECT_LOG.md`「`STATUS.md` 的 276 行是【警報線】」那一節〕
 *
 *  ── 用法 ────────────────────────────────────────
 *    node 文件工具/狀態行數.js
 *
 *  回傳碼：0 ＝ 在線內　2 ＝ 超線（要停下來報告，⛔ 不准自己砍）
 * ============================================================ */

const { readFileSync, existsSync } = require('node:fs');
const { join, dirname } = require('node:path');

const ROOT = dirname(__dirname);
const FILE = join(ROOT, 'STATUS.md');

/** 🔴 會長大的節。⚠ 節名改了要跟著改這裡（⛔ 它是靠標題開頭比對的）。 */
const GROWING = ['## ⏳ 待實測', '## 真待辦'];
/** 警報線（合計行數）。kang 2026-09-02 定。 */
const LIMIT = 90;

if (!existsSync(FILE)) {
  console.log(`❌ 找不到 ${FILE}`);
  process.exit(1);
}

const lines = readFileSync(FILE, 'utf8').split(/\r?\n/);

/** 切出每一個 `## ` 節：回傳 [{title, from, count}] */
const secs = [];
lines.forEach((ln, i) => {
  if (ln.startsWith('## ')) secs.push({ title: ln, from: i, count: 0 });
});
secs.forEach((s, k) => {
  const end = k + 1 < secs.length ? secs[k + 1].from : lines.length;
  s.count = end - s.from - 1;          // ⛔ 不含 `## ` 標題那一行
});

const isGrowing = t => GROWING.some(g => t.startsWith(g));

let grow = 0, fixed = 0;
console.log('\n🔴 STATUS.md 的節\n');
for (const s of secs) {
  const g = isGrowing(s.title);
  if (g) grow += s.count; else fixed += s.count;
  const mark = g ? '🔴 會長大' : '　 固定  ';
  console.log(`  ${mark}  ${String(s.count).padStart(4)} 行  ${s.title.slice(3, 40)}`);
}

const head = secs.length ? secs[0].from : lines.length;
fixed += head;

console.log('');
console.log(`  會長大的兩節合計：${grow} 行　（警報線 ${LIMIT}）`);
console.log(`  固定的部分：      ${fixed} 行　⛔ 不列入判斷`);
console.log(`  全檔：            ${lines.length} 行　⚠ 參考用，⛔ 不當否決的理由`);
console.log('');

if (grow > LIMIT) {
  console.log(`  🔴 超線 ${grow - LIMIT} 行 —— 【停下來報告】，⛔ 不准自己動手砍。`);
  console.log('     報告要列：哪幾塊可以移出、各幾行、權威版在哪個檔的哪一節，然後等 kang 決定。\n');
  process.exit(2);
}
console.log('  ✅ 在線內。\n');
