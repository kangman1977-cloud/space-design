'use strict';
/* ============================================================
 *  模組解析 — 把建模器的 ES 模組【真的解析一次、再真的接起來一次】
 *  建立 2026-10-08（kang 決定列進存檔前的機械檢查）
 *  同日加「接起來」那一步，取代原本的「模組圖真的載入一次」（kang 決定）
 *
 *  ── 為什麼有這支 ────────────────────────────────
 *  ES 模組只要有一個語法錯（最常見的是「重複宣告」），
 *  **整份檔案一行都不跑**，而症狀完全看不出病因
 *  （2026-08-28 整個網頁掛掉，`PROJECT_LOG.md` 檔頭第 1 條）。
 *  向別支要一個「對方沒有的名字」也一樣 —— 瀏覽器在接的時候就失敗，一行都不跑。
 *
 *  ⚠ 原本守這一類的是「模組圖真的載入一次」（`import('./js/main.js')`），
 *  **⛔ 但它走不完整個圖**：Node 不認得網頁的 importmap，
 *  解析到 `view/scene.js` 的 `three/addons/controls/OrbitControls.js`
 *  就停在 `ERR_PACKAGE_PATH_NOT_EXPORTED` —— 還沒走到的檔案一支都沒解析，
 *  「接起來」那一步也根本沒走到。
 *  `toolbar.js` 反引號提前結束字串那次【實證 2026-08-31】、
 *  查 bug E 組改 `select.js` 那次【2026-10-08】，都是靠這種解析才查得到。
 *
 *  ⭐ 這支用 `vm.SourceTextModule`，分兩步：
 *  ① `js/` 底下**每一支**都解析一次（連沒被 import 到的也看）
 *  ② 從 `main.js` 開始，**照網頁的接法**接起來一次：
 *     `./`、`../` 相對於那一支；其餘查 `建模器/index.html` 的 importmap
 *     （⛔ 不另抄一份對照表）。three.js 那幾支也一起解析、一起接。
 *     ⛔ **不執行任何一行**。
 *
 *  ── ⚠ 它抓得到什麼、抓不到什麼（⛔ 要老實寫出來）────
 *  抓得到：① 解析階段的錯 —— 重複宣告、字串／括號沒收好、
 *            模組裡不准用的寫法（嚴格模式）、重複 export。
 *          ② 接的時候的錯 —— 要了對方沒有的名字、import 路徑指到不存在的檔、
 *            importmap 沒有對應的套件名。
 *  ⛔ 抓不到：③ 執行期的錯（`const` 宣告前使用之類）
 *          ④ 執行到才去抓的模組（`bool.js` 的 `import(MANIFOLD_URL)`）
 *          —— 這兩類它都放行。
 *  ⚠ 「接不上」時錯誤本身⛔ 不講是哪一支要的，位置是用文字搜尋找的
 *  （判準仍是「接不接得上」，位置只是幫忙看）。
 *
 *  ── 用法 ────────────────────────────────────────
 *    node 文件工具/模組解析.js
 *
 *  `vm.SourceTextModule` 要 `--experimental-vm-modules` 才有；
 *  沒帶的話這支會自己帶上旗標重跑一次，⛔ 不必手打。
 *
 *  回傳碼：0 ＝ 全部解析通過也全部接得上　1 ＝ 有錯（會列出檔名與行號）
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
const MODELER = path.join(ROOT, '建模器');
const JS_DIR = path.join(MODELER, 'js');
const ENTRY = path.join(JS_DIR, 'main.js');
const relOf = abs => path.relative(ROOT, abs).split(path.sep).join('/');
const firstLine = e => String(e && e.message).split('\n')[0];

function listJs(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listJs(p));
    else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out.sort();
}

// ── 第一步：每一支都解析一次 ──
const files = listJs(JS_DIR);
const bad = [];
for (const f of files) {
  try {
    new vm.SourceTextModule(fs.readFileSync(f, 'utf8'), { identifier: relOf(f) });
  } catch (e) {
    bad.push({ rel: relOf(f), msg: firstLine(e) });
  }
}
if (bad.length) {
  console.log(`🔴 ${bad.length}／${files.length} 支模組解析失敗（⛔ 解析沒過就不接）：`);
  for (const b of bad) console.log(`  ${b.rel}${lineOf(b.rel)}\n    ${b.msg}`);
  process.exit(1);
}
console.log(`✅ ${files.length} 支模組全部解析通過`);

// ── 第二步：從 main.js 照網頁的接法接起來一次（⛔ 不執行）── 呼叫在檔尾

async function linkAll() {
  const map = readImportMap();
  const mods = new Map();      // 絕對路徑 → 模組
  const absOf = new Map();     // 模組 → 絕對路徑
  const load = abs => {
    if (!mods.has(abs)) {
      const m = new vm.SourceTextModule(fs.readFileSync(abs, 'utf8'), { identifier: relOf(abs) });
      mods.set(abs, m);
      absOf.set(m, abs);
    }
    return mods.get(abs);
  };
  try {
    await load(ENTRY).link((spec, ref) => {
      const from = absOf.get(ref);
      const abs = resolveSpec(spec, from, map);
      const where = relOf(from) + importLine(from, spec);
      if (!abs) throw new LinkFail(where, `'${spec}' 在網頁的 importmap 裡沒有對應（瀏覽器會找不到它）`);
      if (!fs.existsSync(abs)) throw new LinkFail(where, `'${spec}' 指到的檔案不存在：${relOf(abs)}`);
      try { return load(abs); }
      catch (e) { throw new LinkFail(relOf(abs) + lineOf(relOf(abs)), `解析失敗：${firstLine(e)}`); }
    });
  } catch (e) {
    console.log('🔴 從 main.js 接起來的時候接不上：');
    if (e instanceof LinkFail) {
      console.log(`  ${e.where}\n    ${e.message}`);
      return false;
    }
    const m = /requested module '([^']+)' does not provide an export named '([^']+)'/.exec(e.message);
    if (!m) { console.log('    ' + firstLine(e)); return false; }
    console.log(`    '${m[1]}' 裡沒有一個叫 '${m[2]}' 的東西可以 import`);
    const hits = whoImports([...mods.keys()], m[1], m[2]);
    console.log(hits.length ? hits.map(h => '  ' + h).join('\n') : '  （文字搜尋沒找到是哪一支要的）');
    return false;
  }
  const inJs = [...mods.keys()].filter(a => a.startsWith(JS_DIR + path.sep));
  console.log(`✅ 從 main.js 接起來 ${mods.size} 支（js/ 底下 ${inJs.length} 支、外部 ${mods.size - inJs.length} 支），全部接得上`);
  const unreached = files.filter(f => !mods.has(f));
  if (unreached.length) console.log(`   ⚠ js/ 底下沒被接到的（只有解析過）：${unreached.map(relOf).join('、')}`);
  return true;
}

function LinkFail(where, message) { this.where = where; this.message = message; }

/** 網頁怎麼找外部套件，以 `建模器/index.html` 的 importmap 為準 */
function readImportMap() {
  const html = fs.readFileSync(path.join(MODELER, 'index.html'), 'utf8');
  const m = /<script type="importmap">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error('建模器/index.html 找不到 importmap');
  return JSON.parse(m[1]).imports || {};
}

/** 照瀏覽器的規則：./ ../ 相對於這一支；其餘查 importmap（完全相同優先，再找最長的「/」結尾前綴） */
function resolveSpec(spec, fromAbs, map) {
  if (/^\.{1,2}\//.test(spec)) return path.resolve(path.dirname(fromAbs), spec);
  if (Object.hasOwn(map, spec)) return path.resolve(MODELER, map[spec]);
  const key = Object.keys(map).filter(k => k.endsWith('/') && spec.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? path.resolve(MODELER, map[key] + spec.slice(key.length)) : null;
}

const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 一段「import／export … from 'spec'」的敘述（⛔ 跨過另一個 from） */
const stmtRe = spec =>
  new RegExp(`\\b(?:import|export)\\s(?:(?!\\bfrom\\b)[^;])*?\\bfrom\\s*['"]${esc(spec)}['"]`, 'g');
const lineAt = (src, i) => src.slice(0, i).split('\n').length;

function importLine(abs, spec) {
  const src = fs.readFileSync(abs, 'utf8');
  const m = stmtRe(spec).exec(src);
  return m ? `:${lineAt(src, m.index)}` : '';
}

/** 哪幾支向 spec 要了 name（name 是 default 的話，列出所有向 spec 要東西的） */
function whoImports(absList, spec, name) {
  const nameRe = new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`);
  const out = [];
  for (const abs of absList) {
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(stmtRe(spec))) {
      const n = name === 'default' ? null : nameRe.exec(m[0]);
      if (name === 'default' || n) out.push(`${relOf(abs)}:${lineAt(src, m.index + (n ? n.index : 0))}`);
    }
  }
  return out;
}

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

// ⚠ 放在檔尾：上面那幾個 const（stmtRe 之類）要先定義好
linkAll().then(ok => process.exit(ok ? 0 : 1));
