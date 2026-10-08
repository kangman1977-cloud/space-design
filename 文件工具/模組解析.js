'use strict';
/* ============================================================
 *  模組解析 — 把 建模器/js/ 底下每一支 ES 模組【真的解析一次】
 *  建立 2026-10-08（kang 決定列進存檔前的機械檢查）
 *
 *  ── 為什麼有這支 ────────────────────────────────
 *  ES 模組只要有一個語法錯（最常見的是「重複宣告」），
 *  **整份檔案一行都不跑**，而症狀完全看不出病因
 *  （2026-08-28 整個網頁掛掉，`PROJECT_LOG.md` 檔頭第 1 條）。
 *
 *  ⚠ 原本守這一類的是「模組圖真的載入一次」那道
 *  （`import('./js/main.js')`），**⛔ 但它走不完整個圖**：
 *  Node 解析到 `view/scene.js` 的
 *  `three/addons/controls/OrbitControls.js` 就停在
 *  `ERR_PACKAGE_PATH_NOT_EXPORTED` —— 還沒走到的檔案一支都沒解析。
 *  `toolbar.js` 反引號提前結束字串那次【實證 2026-08-31】、
 *  查 bug E 組改 `select.js` 那次【2026-10-08】，都是靠這種解析才查得到。
 *
 *  ⭐ 這支用 `vm.SourceTextModule`：**只解析、⛔ 不去找 import 的目標**，
 *  所以不受缺套件影響，每一支都一定解析得到。
 *
 *  ── ⚠ 它抓得到什麼、抓不到什麼（⛔ 要老實寫出來）────
 *  抓得到：解析階段的錯 —— 重複宣告、字串／括號沒收好、
 *          模組裡不准用的寫法（嚴格模式）、重複 export。
 *  ⛔ 抓不到：① import 了對方沒有 export 的名字（那是「連結」階段）
 *          ② 執行期的錯（`const` 宣告前使用之類）—— 這兩類它都放行。
 *  ⚠ 原本那道「模組圖真的載入一次」⛔ 也抓不到 ①：它在解析途中就停了，
 *  走不到連結那一步【實測 2026-10-08：在 `main.js` 的 import 加一個不存在的名字，
 *  它照樣說 OK】。
 *
 *  ── 用法 ────────────────────────────────────────
 *    node 文件工具/模組解析.js
 *
 *  `vm.SourceTextModule` 要 `--experimental-vm-modules` 才有；
 *  沒帶的話這支會自己帶上旗標重跑一次，⛔ 不必手打。
 *
 *  回傳碼：0 ＝ 全部解析通過　1 ＝ 有解析失敗（會逐一列出）
 * ============================================================ */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

if (typeof vm.SourceTextModule !== 'function') {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath,
    ['--experimental-vm-modules', '--disable-warning=ExperimentalWarning', __filename, ...process.argv.slice(2)],
    { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const ROOT = path.join(__dirname, '..');
const JS_DIR = path.join(ROOT, '建模器', 'js');

function listJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(p));
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

const files = listJs(JS_DIR);
const bad = [];
for (const f of files) {
  const rel = path.relative(ROOT, f).split(path.sep).join('/');
  try {
    new vm.SourceTextModule(fs.readFileSync(f, 'utf8'), { identifier: rel });
  } catch (e) {
    bad.push({ rel, msg: String(e && e.message).split('\n')[0], stack: String(e && e.stack) });
  }
}

if (bad.length === 0) {
  console.log(`✅ ${files.length} 支模組全部解析通過`);
  process.exit(0);
}
console.log(`🔴 ${bad.length}／${files.length} 支模組解析失敗：`);
for (const b of bad) console.log(`  ${b.rel}${lineOf(b.rel)}\n    ${b.msg}`);
process.exit(1);

/**
 * `vm.SourceTextModule` 的錯誤⛔ 不帶行號，只好另外找。
 * ⭐ `node --check` 對【副檔名 `.mjs`】會當模組解析、而且印出「檔名:行號」
 * （對 `.js` 它是瞎的 —— `PROJECT_LOG.md`「沙箱能做什麼」那張表）。
 * ⚠ 只拿它的行號，⛔ 判準仍是上面的 `SourceTextModule`。
 */
function lineOf(rel) {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const tmp = path.join(os.tmpdir(), `模組解析-${process.pid}.mjs`);
  try {
    fs.copyFileSync(path.join(ROOT, rel), tmp);
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    const m = /\.mjs:(\d+)/.exec(r.stderr || '');
    return m ? `:${m[1]}` : '';
  } catch { return ''; }
  finally { try { fs.unlinkSync(tmp); } catch {} }
}
