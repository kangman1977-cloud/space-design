'use strict';
/* ============================================================
 *  目次產生器 — 讓索引「不可能漂」
 *  建立 2026-08-29
 *
 *  ── 為什麼有這支 ────────────────────────────────
 *  這個專案的目次一直是**手抄**的，而 2026-08-29 量出來它已經漂了：
 *    · `規格\建模器-點線面編輯.md` 目次寫「刀具的三項輔助 105 行」，
 *      實際 **212 行** —— 漂了一倍。
 *    · 目次宣稱 40 節，實際 41 節。
 *  🔴 代價不是「找不到」，是**用一個錯的份量去決定要不要讀那一節**。
 *
 *  ⭐ 而它 ⛔ 不是靠「檢查目次準不準」解決的，是靠**產生** ——
 *  2026-08-29 當天連續寫出三個誤報的檢查（`export async` 的正則、
 *  對照表「標 ⭐ 但有按鈕」9 項裡 7 項誤報、目次節名比對兩次），
 *  才看清楚一條界線：
 *
 *  > **機械檢查只能問「這件事成不成立」（二元、由系統給答案），
 *  > ⛔ 不能問「這兩段文字是不是同一件事」（那是語意，會誤報）。**
 *
 *  目次「準不準」是語意問題 → 會誤報；
 *  目次「由誰產生」是結構問題 → **產生的東西不需要被檢查**。
 *
 *  ── 用法 ────────────────────────────────────────
 *    node 文件工具/目次產生器.js <檔名>            重新產生並寫回
 *    node 文件工具/目次產生器.js <檔名> --check    只檢查是否過期，不寫入
 *    node 文件工具/目次產生器.js --all             對所有登記的檔案跑一遍
 *
 *  回傳碼：0 ＝ 已最新／已重產　2 ＝（--check）偵測到過期　1 ＝ 結構有問題
 *
 *  ── 目標檔要先具備的東西（只需做一次）──────────────
 *  在目次區塊前後各放一個標記（**⛔ 不要把標記字面值寫進內文**，
 *  否則下次切割會切錯位置、把正文吃掉）：
 *      起始標記 ＝ 角括號驚嘆號減減 空格 TOC:START 空格 減減角括號
 *      結束標記 ＝ 同上，START 換成 END
 *
 *  ⚠ 這支 ⛔ 不碰標記以外的任何一個字元，寫回後會自我否決確認。
 *
 *  ── 兩種目次（看目次裡有沒有「| 回答什麼 |」這個表頭欄決定）────
 *  ① 全自動（PROJECT_LOG／HISTORY）：一張 `| # | 節名 | 行 | 底下的小節 |`，整張重產。
 *  ② 保留人工欄（2026-10-13 加，`規格\建模器-點線面編輯.md`）：
 *     `| 節名 | 回答什麼 | 行 |`，可以分好幾張表（分類是人排的）。
 *     「回答什麼」是語意 → 只有人寫得出來，⛔ 產生器一個字都不碰；
 *     產生器只做兩件結構上的事：
 *       · 「行」重算（節名欄 ＝ 該節標題的一段子字串，⛔ 必須恰好對到 1 節，否則失敗）
 *       · 正文有、目次沒列的節 → 補進「還沒歸類」那張表，等人寫一句再搬去對的分類
 *         （那張表空了會自己消失；`--check` 看到它存在就回 2）
 * ============================================================ */

const fs = require('fs');
const path = require('path');

/* 刻意用字串相接組出標記：避免本檔的字面標記日後被整段複製進文件內文，
   變成「第二個結束標記」→ 下次切割就會切錯位置。〔ERP 2026-08-04 踩過〕 */
const START = '<!-- TOC:' + 'START -->';
const END = '<!-- TOC:' + 'END -->';

const ROOT = path.join(__dirname, '..');
/** 登記在案的目標檔（`--all` 會全部跑一遍）。
 *  ⛔ `STATUS.md` 刻意不在裡面 —— 它只有 163 行、一次讀得完，⛔ 不需要目次。 */
const TARGETS = ["PROJECT_LOG.md", "HISTORY.md", "規格/建模器-點線面編輯.md"];

/** ② 保留人工欄模式：「還沒歸類」那張表的標題（產生器靠這一行找到它）*/
const UNSORTED = '### ⚠ 還沒歸類（產生器補上的：請寫「回答什麼」，再整列搬到對的分類）';
/** 一列：| `節名` | 回答什麼 | 行 |　節名裡的反引號寫成 \` */
const HROW_RE = /^\| (`(?:\\`|[^`])*`) \| (.*) \| (\d+) \|$/;

function humanToc(rel, oldToc, secs) {
  const used = new Set();
  const lines = oldToc.split('\n').map((l) => {
    const m = l.match(HROW_RE);
    if (!m) return l;
    const key = m[1].slice(1, -1).replace(/\\`/g, '`');
    const hit = secs.filter(s => s.title.includes(key));
    if (hit.length !== 1) {
      die(`${rel}：目次的節名「${key}」對到 ${hit.length} 節，必須恰為 1。\n`
        + (hit.length ? hit.map(s => `       ·「${s.title.slice(0, 50)}」`).join('\n') + '\n       → 節名寫長一點，長到只對得到一節。'
          : '       → 那一節被刪掉或改名了；照正文現在的標題改目次那一格。'));
    }
    if (used.has(hit[0])) die(`${rel}：「${hit[0].title.slice(0, 40)}」在目次列了兩次`);
    used.add(hit[0]);
    return `| ${m[1]} | ${m[2]} | ${hit[0].rows} |`;
  });

  const missing = secs.filter(s => !used.has(s));
  let toc = lines.join('\n');
  if (missing.length) {
    console.warn(`\n[WARN] ${rel}：${missing.length} 節目次沒列，補進「還沒歸類」：`);
    missing.forEach(s => console.warn(`       · ${s.title.slice(0, 50)}`));
    const add = missing.map(s => `| \`${s.title.replace(/`/g, '\\`')}\` | （⚠ 還沒寫） | ${s.rows} |`).join('\n');
    if (toc.includes(UNSORTED)) {
      // 接在那張表最後一列後面
      const i = toc.indexOf(UNSORTED);
      const tail = toc.slice(i);
      const m = tail.match(/^[^]*?\|---\|---\|---\|\n(?:\|.*\n)*/);
      if (!m) die(`${rel}：「還沒歸類」那張表的格式壞了`);
      toc = toc.slice(0, i) + m[0] + add + '\n' + tail.slice(m[0].length);
    } else {
      toc = toc.replace(/\n*$/, '') + `\n\n${UNSORTED}\n\n| 節名 | 回答什麼 | 行 |\n|---|---|---|\n${add}\n\n`;
    }
  }
  // 「還沒歸類」表空了 → 整塊拿掉
  const emptyRe = new RegExp('\\n*' + UNSORTED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n\\n\\| 節名 \\| 回答什麼 \\| 行 \\|\\n\\|---\\|---\\|---\\|\\n(?!\\|)\\n*');
  toc = toc.replace(emptyRe, '\n\n');
  return toc;
}

const die = (msg) => { console.error(`\n[FAIL] ${msg}\n`); process.exit(1); };
const count = (s, sub) => s.split(sub).length - 1;

function run(rel, checkOnly) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) die(`找不到檔案：${rel}`);
  const src = fs.readFileSync(file, 'utf8');

  // ── 結構斷言（⛔ 全是二元判斷，沒有猜的成分）──
  if (count(src, START) !== 1) die(`${rel}：起始標記出現 ${count(src, START)} 次，必須恰為 1`);
  if (count(src, END) !== 1) {
    die(`${rel}：結束標記出現 ${count(src, END)} 次，必須恰為 1。\n`
      + '       最可能的成因＝有人把標記字串原樣寫進了目次內文。\n'
      + '       修法＝把那句話改成「目次區塊結束標記」之類的敘述，不要寫出字面值。');
  }
  const iS = src.indexOf(START), iE = src.indexOf(END);
  if (iE < iS) die(`${rel}：結束標記在起始標記前面`);

  const head = src.slice(0, iS);
  const oldToc = src.slice(iS + START.length, iE);
  const body = src.slice(iE + END.length);

  // ── 掃正文的 ## 節，以及每節底下的 ### 小節 ──
  const lines = body.split('\n');
  const idx = [];
  lines.forEach((l, i) => { if (l.startsWith('## ')) idx.push(i); });
  if (!idx.length) die(`${rel}：正文找不到任何 ## 節`);

  const secs = idx.map((i, k) => {
    const end = k + 1 < idx.length ? idx[k + 1] : lines.length;
    const chunk = lines.slice(i + 1, end);
    return {
      title: lines[i].slice(3).trim(),
      /** 🔴 行數的定義＝**該節內文的行數（不含 `## ` 標題行）**。
       *  這個定義同時寫在目次末，兩邊必須一致 —— 改了一邊就要改另一邊。 */
      rows: chunk.length,
      subs: chunk.filter(l => l.startsWith('### ')).map(l => l.slice(4).trim()),
    };
  });

  // ── 守恆：舊目次的每一列，正文都要找得到同名同位的節 ──
  const oldRows = [...oldToc.matchAll(/^\| (\d+) \| (.+?) \|/gm)].map(m => [Number(m[1]), m[2].trim()]);
  const lost = oldRows.filter(([n, t]) => !secs[n - 1] || secs[n - 1].title !== t);
  if (lost.length) {
    console.warn(`\n[WARN] ${rel}：${lost.length} 個舊目次標題與正文對不上（節被刪／搬動／改名）：`);
    lost.slice(0, 5).forEach(([n, t]) => console.warn(`       #${n}「${t.slice(0, 40)}…」`));
    console.warn('       → 刻意改的可忽略；不是刻意的請先查清楚再重跑。\n');
  }

  const total = secs.reduce((a, s) => a + s.rows, 0);
  const human = oldToc.includes('| 回答什麼 |');
  let newToc = human ? humanToc(rel, oldToc, secs) : autoToc(rel, oldToc, secs);
  newToc = newToc.replace(/共 \*\*\d+\*\* 節/, `共 **${secs.length}** 節`)
                 .replace(/內文合計 \*\*[\d,]+\*\* 行/, `內文合計 **${total}** 行`);

  /* ②「還沒歸類」還有列 ＝ 有節沒人寫「回答什麼」—— 行數對了也不算完成 */
  const unsorted = human && newToc.includes(UNSORTED);
  if (unsorted) console.warn(`  ⚠ ${rel}：「還沒歸類」那張表還有列 —— 寫「回答什麼」並搬到對的分類`);

  if (newToc === oldToc) {
    console.log(`  ✅ ${rel}：目次行數已是最新（${secs.length} 節／${total} 行）`);
    return unsorted && checkOnly ? 2 : 0;
  }
  if (checkOnly) {
    console.log(`  🔴 ${rel}：目次與正文不同步（正文現況 ${secs.length} 節／${total} 行）`);
    return 2;
  }

  // ── 寫入 ＋ 讀回自我否決 ──
  const out = head + START + newToc + END + body;
  fs.writeFileSync(file, out, 'utf8');
  const back = fs.readFileSync(file, 'utf8');
  if (back !== out) die(`${rel}：寫回內容與預期不符`);
  if (back.slice(back.indexOf(END) + END.length) !== body) die(`${rel}：🔴 正文被動到了（本支只該改目次區塊）`);
  if (count(back, END) !== 1) die(`${rel}：🔴 寫回後結束標記不只一個`);

  console.log(`  ✅ ${rel}：已重產（${secs.length} 節／${total} 行）— 自我否決通過：正文逐字未變`);
  return 0;
}

/** ① 全自動：整張 `| # | 節名 | 行 | 底下的小節 |` 重產 */
function autoToc(rel, oldToc, secs) {
  const rows = secs.map((s, i) => {
    /**
     * ⚠ **子節要列得夠多，⛔ 不能只列 3 個** —— 目次是這份冷檔唯一的索引，
     * 而**Grep 的前提是先知道那個字串存在**。
     * 上限 8：大部分節列得完；超過 8 個子節的節本身就大到要
     * 「先 Grep 節名進去、再在節內找」。
     */
    let sub = '—';
    if (s.subs.length) {
      sub = s.subs.length <= 8 ? s.subs.join('／')
        : s.subs.slice(0, 8).join('／') + `⋯（共 ${s.subs.length} 個）`;
    }
    return `| ${i + 1} | ${s.title} | ${s.rows} | ${sub} |`;
  });

  /* ⚠ 表格存在與否要**獨立判斷**，⛔ 不能用「取代前後相同」代替 ——
     目次已是最新時取代前後本來就相同，那樣寫會讓第二次執行必定誤報失敗。 */
  /** ⚠ 資料列用 `*` 不是 `+` —— 第一次裝上目次時表格是**空的**，
   *  用 `+` 會找不到而誤報「表格不存在」。〔2026-08-29 第一次跑就撞到〕 */
  const TABLE_RE = /(\|---\|---\|---\|---\|\n)(?:\|.*\n)*/;
  if (!TABLE_RE.test(oldToc)) die(`${rel}：找不到目次表格（表頭分隔列 |---|---|---|---| 不存在）`);

  return oldToc.replace(TABLE_RE, `$1${rows.join('\n')}\n`);
}

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const list = args.includes('--all') ? TARGETS : args.filter(a => !a.startsWith('--'));
if (!list.length) {
  console.error('用法：node 文件工具/目次產生器.js <檔名> [--check]　或　--all');
  process.exit(1);
}
let worst = 0;
for (const t of list) worst = Math.max(worst, run(t, checkOnly));
process.exit(worst);
