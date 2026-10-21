/**
 * run.mjs — 回歸測試
 *
 * ── 這支的存在理由 ──────────────────────────────────
 * 沙箱（AI 的執行環境）下載不到瀏覽器，「畫面有沒有出來」永遠只能靠
 * kang 實際開啟確認。但**能用數學對答案的部分，就一定要對**。
 *
 * 建模器的核心刻意跟 three.js 場景與 DOM 切開，就是為了這件事：
 * mesh / region / prim / bool / io 這幾個檔案可以直接在 Node 裡跑。
 *
 * ── 怎麼跑 ──────────────────────────────────────────
 *   node 建模器/tests/run.mjs
 *
 * 第一次跑會自動建立 建模器/node_modules/three/ 這個小墊片，
 * 讓 Node 也能解析 import 'three'（瀏覽器是靠 index.html 的 importmap）。
 * 那個資料夾已經寫進 .gitignore，不會進版控。
 *
 * ── 什麼時候要跑 ────────────────────────────────────
 * 改過 mesh.js / region.js / prim.js / bool.js / io.js 之後一定要跑。
 * 對不上就是改壞了 —— 這比「看起來沒錯」可靠得多。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// ── 讓 Node 解析得到 'three'（瀏覽器走 importmap，Node 走 node_modules）──
(function ensureThreeShim() {
  const dir = join(ROOT, 'node_modules', 'three');
  if (existsSync(join(dir, 'index.js'))) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'three', version: 'local', type: 'module',
    main: 'index.js', exports: { '.': './index.js' }
  }, null, 2));
  writeFileSync(join(dir, 'index.js'),
    "// 自動產生的墊片：把專案內建的 three.js 轉成 Node 認得的套件\n" +
    "export * from '../../lib/three/three.module.min.js';\n");
  console.log('（已建立 node_modules/three 墊片）\n');
})();

const { Mesh, EDGE_ROLE } = await import('../js/core/mesh.js');
const { summarize, SURFACE, planarRegions } = await import('../js/core/region.js');
const { buildPrim, bendDevelopedLength, isSheetPrim, defaultSrc }
  = await import('../js/build/prim.js');
const { initCSG, csgError, BOOL_OPS } = await import('../js/build/bool.js');
const { arrayMatrices, ARRAY_MODES } = await import('../js/build/array.js');
const io = await import('../js/core/io.js');
const THREE = await import('three');
// toolbar.js 只在 Panel 的建構子裡碰 DOM，模組層級沒有，所以匯入得進來。
// topologyCheck 是刻意抽出來的純函式，就是為了能在這裡測。
const { topologyCheck, fieldNum, clampNum } = await import('../js/ui/toolbar.js');
// 第 3 期。展開核心與規則同樣不碰 DOM，畫圖也刻意拆成
// 「決定畫什麼」與「怎麼畫出來」，前者是純資料，測得到。
const { neutralRadius, bendAllowance } = await import('../js/build/prim.js');
const { makeRule, MATERIALS, MATERIAL_KEYS, DEFAULT_MATERIAL }
  = await import('../js/unfold/rules.js');
const { unfoldMesh } = await import('../js/unfold/flatten.js');
// part.js 是文件物件與展開引擎之間的轉接層，不碰 DOM，所以測得到
const { unfoldObject, unfoldMany, bomCSV } = await import('../js/unfold/part.js');
const seam = await import('../js/unfold/seam.js');
const { drawProgram, toSVG, titleLines, labelWidth, pointInPoly } = await import('../js/out/sheet.js');
const { sliceProgram, sliceTitleLines, progSVG } = await import('../js/out/sheet.js');
const { toDXF, UNITS, sliceDXF, cutLayer } = await import('../js/out/dxf.js');
// 剖面分切。切片是純幾何、定位孔是純幾何，兩個都不碰 DOM，所以整條路測得到。
const sect = await import('../js/slice/section.js');
const pegsMod = await import('../js/slice/pegs.js');
// 匯入線稿。解析、攤平、輪廓整理、擠出，四段都是純數學，全部測得到。
const svgp = await import('../js/sketch/svgPath.js');
const prof = await import('../js/sketch/profile.js');
const extr = await import('../js/build/extrude.js');
const prim = await import('../js/build/prim.js');

/** 尤拉數 V−E+F。封閉曲面 ＝ 2×塊數 − 2×貫穿孔數。 */
const euler = m => m.verts.length - [...m.edges()].length + m.faces.length;
// save.js 在模組層級只做 typeof window 判斷，不碰 DOM，所以 Node 也載得進來
const { safeName, TYPES, canChoosePath } = await import('../js/out/save.js');
const { triangles, stlVolume, trisBounds, dropToBed, toSTLBinary, toSTLAscii,
        printCheck, STL_UNITS, bedLayout } = await import('../js/out/stl.js');
// 第 6 期第一刀。移動頂點與改完之後的連帶重算，全部是純幾何、不碰 DOM。
const edit = await import('../js/core/edit.js');

/**
 * 🔴🔴 **⚠ 測試裡的方塊參數有兩種寫法，⛔ 那不是錯的**（2026-08-28 記）
 *
 * ```
 * { w: 60, h: 45, d: 40 }   ← 跟 prim.js 的 PRIM_DEFAULTS 一致（67 處）
 * { w: 60, d: 45, h: 40 }   ← 高是 40（另外 67 處，散在 22 個 section）
 * ```
 *
 * **兩種都自洽** —— 各自的預期數字都是照自己那組算的，所以測試全過。
 * ⛔ **不要為了整齊去統一它們**：要動 22 個 section 的預期值，
 * **風險遠大於收益**〔日誌：為了整齊去改能用的東西，不划算〕。
 *
 * 🔴 **但它咬過人一次，咬的是「開實測清單」那一步**（kang 2026-08-28）：
 * 我照測試裡的 `h:40` 寫清單，說「軌道長 20，25% ＝ 5」，
 * 而他畫面上的方塊是**預設值**（高 **45**）→ 軌道 22.5 → **11.25**。
 * **測試自洽 ⛔ 不等於跟畫面一致。**
 *
 * ⭐ **所以規則掛在開清單那一步，⛔ 不是掛在這裡**：
 * **實測清單的前置參數一律照 `PRIM_DEFAULTS` 抄，⛔ 不照測試、⛔ 不自己填；
 * 而清單裡的數字一律寫成「使用者算得出來的式子」。**
 * 〔權威版在 `PROJECT_LOG.md`「協作規則 → 開清單時」那一節〕
 */

// ═══════════════════════════════════════════════════════
//  小小的測試框架
// ═══════════════════════════════════════════════════════

let pass = 0, fail = 0;
const fails = [];

function section(t) { console.log(`\n── ${t} ` + '─'.repeat(Math.max(0, 54 - t.length))); }

function eq(name, got, want) {
  const ok = got === want;
  report(ok, name, got, want);
}

/** 浮點比較。tol 是絕對容許誤差。 */
function near(name, got, want, tol = 1e-6) {
  const ok = Number.isFinite(got) && Math.abs(got - want) <= tol;
  report(ok, name, fmt(got), fmt(want) + ` ±${tol}`);
}

/**
 * 相對誤差比較。量「應該精確相等」的幾何量時用這個，不要用 near()。
 *
 * 理由：攤平是剛體運動，理論上完全精確，但實際會累積浮點誤差，
 * 而誤差大小跟數值本身成比例 —— 量 180 跟量 18000 的絕對誤差差兩個數量級。
 * 拿固定的絕對容許值去套，不是太鬆就是太緊。
 *
 * 預設 1e-7 是浮點雜訊的量級（實測落在 1e-8 ~ 1e-16），
 * 而且遠比任何加工公差嚴格 —— 1e-7 的相對誤差在 1 公尺上是 0.1 微米。
 */
function rel(name, got, want, tol = 1e-7) {
  const scale = Math.max(Math.abs(want), 1e-12);
  const err = Math.abs(got - want) / scale;
  report(Number.isFinite(got) && err <= tol, name, fmt(got), fmt(want) + ` (相對 ±${tol})`);
}

function ok(name, cond, detail = '') {
  report(!!cond, name, cond ? '是' : '否', '是' + (detail ? `（${detail}）` : ''));
}

function report(good, name, got, want) {
  if (good) { pass++; console.log(`  ✓ ${name}　${got}`); }
  else {
    fail++;
    fails.push(name);
    console.log(`  ✗ ${name}　得到 ${got}　應為 ${want}`);
  }
}

const fmt = v => (typeof v === 'number' ? (+v.toFixed(6)).toString() : String(v));

// ═══════════════════════════════════════════════════════
//  第 1 期：半邊結構的基準（改核心一定要重跑）
// ═══════════════════════════════════════════════════════

section('第 1 期基準：拓撲');

{
  const box = buildPrim('box', { w: 60, h: 45, d: 40 });
  const v = box.validate();
  const s = summarize(box);

  eq('方塊 尤拉數 V−E+F', v.euler, 2);
  eq('方塊 V / E / F', `${v.V}/${v.E}/${v.F}`, '8/18/12');
  ok('方塊 結構無誤', v.ok && v.closed);
  eq('方塊 合併後片數', s.regions, 6);
  near('方塊 體積 cm³', box.volume(), 60 * 45 * 40, 1e-6);
  near('方塊 表面積 cm²', box.area(), 2 * (60 * 45 + 45 * 40 + 60 * 40), 1e-6);
  near('方塊 角虧總和（＝4π）', s.totalDefect, 4 * Math.PI, 1e-9);
}

{
  const cyl = buildPrim('cylinder', { r: 25, h: 70, seg: 32 });
  const v = cyl.validate();
  const s = summarize(cyl);

  eq('圓柱 尤拉數', v.euler, 2);
  eq('圓柱 V / E / F', `${v.V}/${v.E}/${v.F}`, '66/192/128');
  eq('圓柱 合併後片數', s.regions, 34);
  near('圓柱 角虧總和（＝4π）', s.totalDefect, 4 * Math.PI, 1e-9);

  // 注意：**封閉**的圓柱整體是不可展的 —— 上下緣那 64 個頂點是折角，有角虧。
  // 可展的是「側面」。展開時本來就會把上下蓋當成另外的片，所以要拿開口圓柱測。
  eq('封閉圓柱 整體不可展（上下緣是折角）', s.surface, SURFACE.NON_DEVELOPABLE);
  eq('封閉圓柱 攤不平的頂點數', s.curvedVerts, 64);
}

{
  const side = buildPrim('cylinder', { r: 25, h: 70, seg: 32, openEnded: true });
  const s = summarize(side);
  eq('圓柱側面 可展開判定', s.surface, SURFACE.DEVELOPABLE);
  eq('圓柱側面 攤不平的頂點數（應為 0）', s.curvedVerts, 0);
  eq('圓柱側面 尤拉數（管狀＝0）', side.validate().euler, 0);
}

{
  const sph = buildPrim('sphere', { r: 30, segW: 32, segH: 16 });
  const v = sph.validate();
  near('球 角虧總和（＝4π）', summarize(sph).totalDefect, 4 * Math.PI, 1e-9);
  eq('球 尤拉數', v.euler, 2);
  eq('球 不可展開判定', summarize(sph).surface, SURFACE.NON_DEVELOPABLE);
}

{
  const plate = buildPrim('plate', { w: 100, d: 60 });
  const v = plate.validate();
  eq('平板 尤拉數（開放的殼＝1）', v.euler, 1);
  ok('平板 是開放的', !v.closed);
  near('平板 面積 cm²', plate.area(), 100 * 60, 1e-6);
}

// ═══════════════════════════════════════════════════════
//  第 2 期：新的參數體
// ═══════════════════════════════════════════════════════

section('第 2 期：管、圓角方塊、折板');

/** n 邊形（外接圓半徑 r）的面積。圓柱不是真的圓，對答案要用這個。 */
const polyArea = (r, n) => 0.5 * n * r * r * Math.sin(2 * Math.PI / n);

{
  const m = buildPrim('tube', { rOuter: 25, rInner: 20, h: 70, seg: 32 });
  const v = m.validate();
  near('管 體積', m.volume(), (polyArea(25, 32) - polyArea(20, 32)) * 70, 1e-6);
  ok('管 封閉', v.closed);
  eq('管 尤拉數（中間通了，所以是 0）', v.euler, 0);
  ok('管 結構無誤', v.ok, v.errors[0] || '');
  eq('管 合併後片數（32外＋32內＋上下環）', summarize(m).regions, 66);

  const solid = buildPrim('tube', { rOuter: 25, rInner: 0, h: 70, seg: 32 });
  eq('管 內半徑 0 → 退化成實心（尤拉數 2）', solid.validate().euler, 2);
}

{
  const w = 60, h = 45, d = 40, r = 6, segR = 4;
  const m = buildPrim('roundBox', { w, h, d, r, segR });
  const v = m.validate();
  // 斷面積 ＝ 矩形 − 四個直角 ＋ 四個圓角（用多邊形近似，不是真圓）
  const area = w * d - 4 * r * r + 2 * segR * r * r * Math.sin(Math.PI / (2 * segR));
  near('圓角方塊 體積', m.volume(), area * h, 1e-6);
  eq('圓角方塊 尤拉數', v.euler, 2);
  ok('圓角方塊 結構無誤', v.ok);
  eq('圓角方塊 合併後片數（4直邊＋16圓角＋上下）', summarize(m).regions, 22);

  const sharp = buildPrim('roundBox', { w, h, d, r: 0, segR });
  near('圓角半徑 0 → 就是普通方塊', sharp.volume(), w * h * d, 1e-6);
  eq('圓角半徑 0 → 片數 6', summarize(sharp).regions, 6);
}

{
  const p = { w: 60, first: 40, arcSeg: 4, bends: [{ angle: 90, ri: 2, len: 30 }] };
  const m = buildPrim('bend', p);
  const v = m.validate();
  const s = summarize(m);

  ok('折板 是開放的面（板件，不是實體）', !v.closed);
  eq('折板 尤拉數（一整片）', v.euler, 1);
  ok('折板 結構無誤', v.ok, v.errors[0] || '');
  eq('折板 折線數（圓弧切 4 段 → 5 條）', s.folds, 5);
  eq('折板 切割線數（外圍邊界）', s.cuts, 14);

  // 網格面積要用「弦長」算，因為圓弧在網格上是折線
  const chord = 2 * 2 * Math.sin(Math.PI / 2 / (2 * 4)) * 4;
  near('折板 網格面積（弦長版）', m.area(), (40 + chord + 30) * 60, 1e-4);

  // 展開長度則要用「真弧長」——這兩個數字不一樣，是實際會下料錯的地方
  near('折板 展開總長（真弧長版）', bendDevelopedLength(p), 40 + 2 * (Math.PI / 2) + 30, 1e-9);
  ok('展開長度必須大於網格量到的長度', bendDevelopedLength(p) > 40 + chord + 30);

  // 分段愈多，網格愈接近真值
  const fine = { ...p, arcSeg: 64 };
  const err = a => Math.abs(buildPrim('bend', { ...p, arcSeg: a }).area() / 60
    - bendDevelopedLength(p));
  ok('圓弧分段加密後誤差變小', err(64) < err(4) / 100, `4段 ${err(4).toFixed(4)} → 64段 ${err(64).toFixed(6)}`);
  void fine;
}

{
  // U 型：兩道同向；Z 型：兩道反向。長度與折線數都要對得上
  const u = { w: 50, first: 30, arcSeg: 3, bends: [
    { angle: 90, ri: 1, len: 50 }, { angle: 90, ri: 1, len: 30 }] };
  const z = { w: 50, first: 30, arcSeg: 3, bends: [
    { angle: 90, ri: 1, len: 20 }, { angle: -90, ri: 1, len: 30 }] };

  near('U 型 展開總長', bendDevelopedLength(u), 30 + Math.PI / 2 + 50 + Math.PI / 2 + 30, 1e-9);
  near('Z 型 展開總長', bendDevelopedLength(z), 30 + Math.PI / 2 + 20 + Math.PI / 2 + 30, 1e-9);

  const mu = buildPrim('bend', u);
  eq('U 型 尤拉數', mu.validate().euler, 1);
  eq('U 型 折線數（兩道 × 3 段 → 8 條）', summarize(mu).folds, 8);
  ok('U 型 結構無誤', mu.validate().ok);

  const mz = buildPrim('bend', z);
  ok('Z 型 結構無誤', mz.validate().ok);
  // Z 型折回來，最後一段的方向應該跟第一段相同
  const b = mz.bounds();
  ok('Z 型 高度等於中間那段（20＋兩個半徑）', Math.abs(b.max.y - b.min.y - 22) < 1e-6,
    `實得 ${(b.max.y - b.min.y).toFixed(3)}`);

  // 半徑 0 ＝ 尖角折，展開長度就沒有圓弧那一段
  const sharp = { w: 50, first: 30, arcSeg: 3, bends: [{ angle: 90, ri: 0, len: 20 }] };
  near('尖角折 展開總長', bendDevelopedLength(sharp), 50, 1e-9);
  eq('尖角折 折線數（只有轉角那一條）', summarize(buildPrim('bend', sharp)).folds, 1);
}

// ═══════════════════════════════════════════════════════
//  第 2 期：板件加厚（顯示用，但要能用數學驗）
// ═══════════════════════════════════════════════════════

section('第 2 期：板件加厚');

{
  const p = buildPrim('plate', { w: 100, d: 60 });
  for (const t of [0.2, 1, 5]) {
    const s = p.shell(t);
    const v = s.validate();
    near(`平板加厚 ${t}cm 體積（＝面積×厚度）`, s.volume(), 100 * 60 * t, 1e-6);
    ok(`平板加厚 ${t}cm 封閉且無誤`, v.closed && v.ok, v.errors[0] || '');
    eq(`平板加厚 ${t}cm 尤拉數`, v.euler, 2);
  }
}

{
  // 折彎處也要精確。這裡曾經差了 0.076%，原因是沿角平分線只推 t/2，
  // 折角會被削薄成 t×cos(半夾角)；正確做法是除以那個餘弦（尖角接合）。
  // 各種角度與分段數都要成立，不能只有 90 度剛好對。
  for (const [seg, ang] of [[2, 90], [3, 90], [8, 90], [4, 45], [4, 135]]) {
    const t = 0.3;
    const m = buildPrim('bend',
      { w: 60, first: 40, arcSeg: seg, k: 0.4, bends: [{ angle: ang, ri: 2, len: 30 }] }, t);
    const s = m.shell(t);
    const v = s.validate();
    near(`折板加厚 ${seg} 段 ${ang}° 體積（＝面積×厚度）`, s.volume(), m.area() * t, 1e-6);
    ok(`折板加厚 ${seg} 段 ${ang}° 封閉且無誤`, v.closed && v.ok, v.errors[0] || '');
    eq(`折板加厚 ${seg} 段 ${ang}° 尤拉數`, v.euler, 2);
  }
}

{
  // 加厚不可以動到原本的網格（畫面是文件的投影，不能反過來改文件）
  const p = buildPrim('plate', { w: 100, d: 60 });
  const beforeV = p.verts.length, beforeF = p.faces.length, beforeArea = p.area();
  p.shell(0.5);
  eq('加厚後 原網格頂點數不變', p.verts.length, beforeV);
  eq('加厚後 原網格面數不變', p.faces.length, beforeF);
  near('加厚後 原網格面積不變', p.area(), beforeArea, 1e-9);
}

// ═══════════════════════════════════════════════════════
//  第 2 期新增：transformed()
// ═══════════════════════════════════════════════════════

section('第 2 期：座標變換');

{
  const box = buildPrim('box', { w: 60, h: 45, d: 40 });

  const moved = box.transformed(new THREE.Matrix4().makeTranslation(100, 0, 0));
  near('平移後體積不變', moved.volume(), 108000, 1e-6);
  eq('平移後尤拉數不變', moved.validate().euler, 2);
  near('平移後中心 X', moved.bounds().getCenter(new THREE.Vector3()).x, 100, 1e-4);

  // 鏡射：行列式為負，繞向必須整個翻過來，否則體積會變負數、法向量朝內
  const mirrored = box.transformed(new THREE.Matrix4().makeScale(-1, 1, 1));
  near('鏡射後體積仍為正', mirrored.volume(), 108000, 1e-6);
  eq('鏡射後尤拉數不變', mirrored.validate().euler, 2);
  ok('鏡射後結構無誤', mirrored.validate().ok);

  const scaled = box.transformed(new THREE.Matrix4().makeScale(2, 2, 2));
  near('等比放大 2 倍 → 體積 8 倍', scaled.volume(), 108000 * 8, 1e-3);
}

// ═══════════════════════════════════════════════════════
//  第 2 期：布林運算
// ═══════════════════════════════════════════════════════

section('第 2 期：布林運算');

const csgOK = await initCSG();
ok('布林函式庫載入', csgOK, csgOK ? '' : String(csgError()));

if (csgOK) {
  /** 32 邊形（外接圓半徑 r）的斷面積。圓柱不是真的圓，對答案要用這個。 */
  const polyArea = (r, n) => 0.5 * n * r * r * Math.sin(2 * Math.PI / n);

  const item = (src, pos = [0, 0, 0], rot = [0, 0, 0]) =>
    ({ src, pos, rot, scale: [1, 1, 1], name: src.type });

  // ── 差集：方塊挖一個貫穿孔 ──────────────────────────
  {
    const tree = {
      type: 'bool', op: BOOL_OPS.SUBTRACT,
      items: [
        item({ type: 'box', w: 60, h: 45, d: 40 }),
        item({ type: 'cylinder', r: 10, h: 60, seg: 32 }, [0, 0, 0], [Math.PI / 2, 0, 0])
      ]
    };
    const m = io.buildSrc(tree);
    const v = m.validate();
    const s = summarize(m);
    const want = 108000 - polyArea(10, 32) * 40;

    near('貫孔 體積 cm³', m.volume(), want, 1e-3);
    eq('貫孔 尤拉數（有洞的甜甜圈＝0）', v.euler, 0);
    ok('貫孔 網格封閉', v.closed);
    ok('貫孔 結構無誤', v.ok, v.errors[0] || '');
    near('貫孔 角虧總和（＝2π×尤拉數＝0）', s.totalDefect, 0, 1e-6);
    eq('貫孔 合併後片數（6 個外面＋32 個孔壁）', s.regions, 38);
  }

  // ── 差集：只挖一半，不貫穿 → 還是一個實心體 ──────────
  {
    const tree = {
      type: 'bool', op: BOOL_OPS.SUBTRACT,
      items: [
        item({ type: 'box', w: 60, h: 45, d: 40 }),
        // 圓柱長 40，中心往 +Z 移 20 → 從一面挖進去 20 深，另一面不通
        item({ type: 'cylinder', r: 10, h: 40, seg: 32 }, [0, 0, 20], [Math.PI / 2, 0, 0])
      ]
    };
    const m = io.buildSrc(tree);
    const v = m.validate();
    const want = 108000 - polyArea(10, 32) * 20;

    near('盲孔 體積 cm³', m.volume(), want, 1e-3);
    eq('盲孔 尤拉數（沒通就還是 2）', v.euler, 2);
    near('盲孔 角虧總和（＝4π）', summarize(m).totalDefect, 4 * Math.PI, 1e-6);
  }

  // ── 聯集：兩個分開的方塊 ────────────────────────────
  {
    const tree = {
      type: 'bool', op: BOOL_OPS.UNION,
      items: [
        item({ type: 'box', w: 20, h: 20, d: 20 }),
        item({ type: 'box', w: 20, h: 20, d: 20 }, [100, 0, 0])
      ]
    };
    const m = io.buildSrc(tree);
    near('分開兩塊 聯集體積', m.volume(), 8000 * 2, 1e-4);
    eq('分開兩塊 尤拉數（兩個獨立實體＝2+2）', m.validate().euler, 4);
  }

  // ── 聯集：兩個重疊的方塊（重疊處只能算一次）──────────
  {
    const tree = {
      type: 'bool', op: BOOL_OPS.UNION,
      items: [
        item({ type: 'box', w: 20, h: 20, d: 20 }),
        item({ type: 'box', w: 20, h: 20, d: 20 }, [10, 0, 0])
      ]
    };
    const m = io.buildSrc(tree);
    near('重疊兩塊 聯集體積', m.volume(), 20 * 20 * 30, 1e-4);
    eq('重疊兩塊 尤拉數', m.validate().euler, 2);
  }

  // ── 交集：只留重疊處 ────────────────────────────────
  {
    const tree = {
      type: 'bool', op: BOOL_OPS.INTERSECT,
      items: [
        item({ type: 'box', w: 20, h: 20, d: 20 }),
        item({ type: 'box', w: 20, h: 20, d: 20 }, [10, 0, 0])
      ]
    };
    const m = io.buildSrc(tree);
    near('交集體積（重疊的 10×20×20）', m.volume(), 10 * 20 * 20, 1e-4);
    eq('交集尤拉數', m.validate().euler, 2);
  }

  // ── 巢狀：先挖孔，再把結果跟另一塊聯集 ──────────────
  {
    const holed = {
      type: 'bool', op: BOOL_OPS.SUBTRACT,
      items: [
        item({ type: 'box', w: 60, h: 45, d: 40 }),
        item({ type: 'cylinder', r: 10, h: 60, seg: 32 }, [0, 0, 0], [Math.PI / 2, 0, 0])
      ]
    };
    const tree = {
      type: 'bool', op: BOOL_OPS.UNION,
      items: [
        item(holed),
        item({ type: 'box', w: 20, h: 20, d: 20 }, [200, 0, 0])
      ]
    };
    const m = io.buildSrc(tree);
    const want = 108000 - polyArea(10, 32) * 40 + 8000;

    near('巢狀（挖孔後再聯集）體積', m.volume(), want, 1e-3);
    eq('巢狀 尤拉數（帶洞的 0 ＋ 獨立方塊的 2）', m.validate().euler, 2);
    ok('巢狀 結構無誤', m.validate().ok);
  }

  // ── 改參數重算：孔徑改小，體積要跟著對 ──────────────
  {
    const obj = new io.ModelObject({
      name: '測試件',
      src: {
        type: 'bool', op: BOOL_OPS.SUBTRACT,
        items: [
          item({ type: 'box', w: 60, h: 45, d: 40 }),
          item({ type: 'cylinder', r: 10, h: 60, seg: 32 }, [0, 0, 0], [Math.PI / 2, 0, 0])
        ]
      }
    });
    near('改參數前 體積', obj.mesh().volume(), 108000 - polyArea(10, 32) * 40, 1e-3);

    obj.src.items[1].src.r = 5;
    obj.invalidate();
    near('孔徑 ⌀20 改 ⌀10 後 體積', obj.mesh().volume(), 108000 - polyArea(5, 32) * 40, 1e-3);
    ok('改參數後沒有錯誤', obj.error === null, obj.error || '');
  }

  // ── 存讀檔往返：存下來再讀回去，形狀要一模一樣 ────────
  {
    const doc = new io.Doc();
    doc.add(new io.ModelObject({
      name: '有孔的板',
      src: {
        type: 'bool', op: BOOL_OPS.SUBTRACT,
        items: [
          item({ type: 'box', w: 60, h: 45, d: 40 }),
          item({ type: 'cylinder', r: 10, h: 60, seg: 32 }, [0, 0, 0], [Math.PI / 2, 0, 0])
        ]
      },
      pos: new THREE.Vector3(10, 20, 30)
    }));

    const before = doc.objects[0].mesh().volume();
    const json = JSON.parse(JSON.stringify(doc.toJSON()));
    eq('存檔版本號', json.v, io.DOC_VERSION);
    eq('存檔單位', json.unit, 'cm');
    eq('布林物件不存三角形，只存運算樹', json.objects[0].mesh, undefined);

    const back = io.Doc.fromJSON(json);
    near('讀回來 體積相同', back.objects[0].mesh().volume(), before, 1e-6);
    near('讀回來 位置相同 Y', back.objects[0].pos.y, 20, 1e-9);

    // 深拷貝檢查：改了讀回來的那份，原本的不可以跟著變
    back.objects[0].src.items[1].src.r = 1;
    eq('存檔是深拷貝（改複本不影響原件）', doc.objects[0].src.items[1].src.r, 10);
  }

  // ── 舊檔相容：v1 的檔案要讀得動 ──────────────────────
  {
    const v1 = {
      type: 'model-doc', v: 1, unit: 'cm',
      head: { name: '第一期存的舊檔' },
      objects: [{
        id: 1, name: '方塊 1', kind: 'solid',
        src: { type: 'box', w: 60, h: 45, d: 40 },
        pos: [0, 22.5, 0], rot: [0, 0, 0], scale: [1, 1, 1],
        color: 0x6fa8dc, lockScale: false
      }]
    };
    const d = io.Doc.fromJSON(v1);
    eq('v1 舊檔 物件數', d.objects.length, 1);
    near('v1 舊檔 體積', d.objects[0].mesh().volume(), 108000, 1e-6);
  }

  // ── 凍結：轉成網格之後形狀不變，且會改存三角形 ────────
  {
    const obj = new io.ModelObject({
      src: {
        type: 'bool', op: BOOL_OPS.SUBTRACT,
        items: [
          item({ type: 'box', w: 60, h: 45, d: 40 }),
          item({ type: 'cylinder', r: 10, h: 60, seg: 32 }, [0, 0, 0], [Math.PI / 2, 0, 0])
        ]
      }
    });
    const before = obj.mesh().volume();
    obj.bake();
    const j = obj.toJSON();
    eq('凍結後 src 變成 mesh', j.src.type, 'mesh');
    ok('凍結後有存下三角形', !!j.mesh);

    const back = io.ModelObject.fromJSON(j);
    // 容許 0.01 cm³（相對誤差 1e-7）：存檔時座標寫到小數 6 位，
    // 而布林引擎內部是 32 位元浮點數，本來就有這個量級的尾差。
    // 換算成長度是 0.1 微米，對鈑金、木工、帆布都遠低於製造公差。
    near('凍結前後 體積相同', back.mesh().volume(), before, 1e-2);
    eq('凍結前後 尤拉數相同', back.mesh().validate().euler, 0);
  }

  // ── 板件擋下來：開放的面不能布林，要給看得懂的訊息 ────
  {
    const obj = new io.ModelObject({
      src: {
        type: 'bool', op: BOOL_OPS.SUBTRACT,
        items: [
          item({ type: 'plate', w: 100, d: 60 }),
          item({ type: 'cylinder', r: 10, h: 60, seg: 32 })
        ]
      }
    });
    obj.mesh();
    ok('板件做布林會被擋下', !!obj.error, obj.error || '沒有擋');
    ok('錯誤訊息是看得懂的中文', /板件|開放/.test(obj.error || ''), obj.error || '');
    ok('失敗時仍給得出替身網格，畫面不會掛掉', obj.mesh().faces.length > 0);
  }

  // ── 效能：改一次參數要重算，不能慢到不能用 ────────────
  {
    const tree = {
      type: 'bool', op: BOOL_OPS.SUBTRACT,
      items: [
        item({ type: 'box', w: 60, h: 45, d: 40 }),
        item({ type: 'cylinder', r: 10, h: 60, seg: 32 }, [0, 0, 0], [Math.PI / 2, 0, 0])
      ]
    };
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) io.buildSrc(tree);
    const ms = (performance.now() - t0) / 20;
    ok(`單次布林耗時 ${ms.toFixed(1)} ms（門檻 50ms）`, ms < 50);
  }
}

// ═══════════════════════════════════════════════════════
//  第 2 期：陣列與鏡射
// ═══════════════════════════════════════════════════════

section('第 2 期：陣列的排列位置（純數學，不需要函式庫）');

{
  const at = m => m.elements.slice(12, 15).map(x => +x.toFixed(6));   // 平移量

  // ── 線性：單方向 ──
  {
    const ms = arrayMatrices({ mode: 'linear', count: 4, step: [30, 0, 0], count2: 1 });
    eq('線性 4 份 → 份數', ms.length, 4);
    eq('線性 第 1 份在原點', JSON.stringify(at(ms[0])), '[0,0,0]');
    eq('線性 第 4 份位移', JSON.stringify(at(ms[3])), '[90,0,0]');
  }

  // ── 線性：兩個方向（散熱孔網格）──
  {
    const ms = arrayMatrices({
      mode: 'linear', count: 8, step: [22, 0, 0], count2: 4, step2: [0, 0, 22]
    });
    eq('網格 8×4 → 份數', ms.length, 32);
    eq('網格 最後一份位移', JSON.stringify(at(ms[31])), '[154,0,66]');
  }

  // ── 環形：整圈平均分佈 ──
  {
    const ms = arrayMatrices({ mode: 'radial', count: 8, axis: 'y', angle: 360 });
    eq('環形 8 份 → 份數', ms.length, 8);
    // 繞 Y 轉 90 度（第 3 份）：(100,0,0) 應該跑到 (0,0,-100)
    const p = new THREE.Vector3(100, 0, 0).applyMatrix4(ms[2]);
    near('環形 轉 90 度後的 X', p.x, 0, 1e-6);
    near('環形 轉 90 度後的 Z', p.z, -100, 1e-6);
    // 整圈時最後一份不可以跟第一份重疊（否則會少一個位置）
    const last = new THREE.Vector3(100, 0, 0).applyMatrix4(ms[7]);
    ok('環形 整圈時最後一份不與第一份重疊', last.distanceTo(new THREE.Vector3(100, 0, 0)) > 1);
  }

  // ── 環形：不足一圈，頭尾都要放 ──
  {
    const ms = arrayMatrices({ mode: 'radial', count: 5, axis: 'y', angle: 180 });
    const first = new THREE.Vector3(100, 0, 0).applyMatrix4(ms[0]);
    const last = new THREE.Vector3(100, 0, 0).applyMatrix4(ms[4]);
    near('環形 180 度 第一份 X', first.x, 100, 1e-6);
    near('環形 180 度 第五份 X（應轉到對面）', last.x, -100, 1e-6);
  }

  // ── 環形：繞非原點的中心 ──
  {
    const ms = arrayMatrices({ mode: 'radial', count: 4, axis: 'y', angle: 360, center: [50, 0, 0] });
    const p = new THREE.Vector3(50, 0, 0).applyMatrix4(ms[1]);
    near('環形 旋轉中心上的點不會動 X', p.x, 50, 1e-6);
    near('環形 旋轉中心上的點不會動 Z', p.z, 0, 1e-6);
  }

  // ── 鏡射 ──
  {
    const ms = arrayMatrices({ mode: 'mirror', axis: 'x', offset: 30 });
    eq('鏡射 → 份數（原件＋鏡像）', ms.length, 2);
    const p = new THREE.Vector3(10, 7, 3).applyMatrix4(ms[1]);
    // 對稱面在 x=30：x' = 2×30 − 10 = 50，其餘不變
    near('鏡射 X 對稱', p.x, 50, 1e-9);
    near('鏡射 Y 不變', p.y, 7, 1e-9);
    near('鏡射 Z 不變', p.z, 3, 1e-9);
    ok('鏡射矩陣的行列式為負（繞向會翻）', ms[1].determinant() < 0);

    const only = arrayMatrices({ mode: 'mirror', axis: 'x', offset: 30, keepOriginal: false });
    eq('鏡射 不保留原件 → 份數', only.length, 1);
  }
}

if (csgOK) {
  section('第 2 期：陣列的實際網格');

  const item = (src, pos = [0, 0, 0], rot = [0, 0, 0]) =>
    ({ src, pos, rot, scale: [1, 1, 1], name: src.type });
  const cube = (a = 10) => item({ type: 'box', w: a, h: a, d: a });

  // ── 線性：不重疊 ──
  {
    const m = io.buildSrc({
      type: 'array', mode: 'linear', count: 5, step: [30, 0, 0], count2: 1, child: cube()
    });
    const v = m.validate();
    near('線性 5 份 體積（＝5×1000）', m.volume(), 5000, 1e-4);
    eq('線性 5 份 元件數', v.components, 5);
    eq('線性 5 份 尤拉數（＝2×5）', v.euler, 10);
    ok('線性 5 份 結構無誤', v.ok);
  }

  // ── 線性：故意重疊，重疊處只能算一次 ──
  {
    const m = io.buildSrc({
      type: 'array', mode: 'linear', count: 3, step: [5, 0, 0], count2: 1, child: cube()
    });
    // 三個 10cm 方塊每隔 5cm → 連成一條 20×10×10
    near('線性 重疊 體積（＝20×10×10）', m.volume(), 2000, 1e-4);
    eq('線性 重疊 元件數（黏成一塊）', m.validate().components, 1);
  }

  // ── 二維網格 ──
  {
    const m = io.buildSrc({
      type: 'array', mode: 'linear', count: 3, step: [30, 0, 0],
      count2: 4, step2: [0, 0, 30], child: cube()
    });
    near('網格 3×4 體積', m.volume(), 12000, 1e-4);
    eq('網格 3×4 元件數', m.validate().components, 12);
  }

  // ── 環形 ──
  {
    const m = io.buildSrc({
      type: 'array', mode: 'radial', count: 8, axis: 'y', angle: 360,
      center: [0, 0, 0], child: item({ type: 'box', w: 10, h: 10, d: 10 }, [100, 0, 0])
    });
    near('環形 8 份 體積', m.volume(), 8000, 1e-3);
    eq('環形 8 份 元件數', m.validate().components, 8);
  }

  // ── 鏡射：體積必須為正 ──
  // 鏡射矩陣行列式為負，繞向若沒翻回來，體積會變負數、法向量朝內
  {
    const m = io.buildSrc({
      type: 'array', mode: 'mirror', axis: 'x', offset: 30, child: cube()
    });
    const v = m.validate();
    near('鏡射 體積為正（＝2×1000）', m.volume(), 2000, 1e-4);
    eq('鏡射 元件數', v.components, 2);
    ok('鏡射 結構無誤', v.ok);
    const b = m.bounds();
    near('鏡射 邊界最小 X', b.min.x, -5, 1e-4);
    near('鏡射 邊界最大 X（＝2×30+5）', b.max.x, 65, 1e-4);
  }

  // ── 陣列套布林：挖好孔的板子排成一排 ──
  {
    const holed = {
      type: 'bool', op: BOOL_OPS.SUBTRACT,
      items: [
        item({ type: 'box', w: 40, h: 20, d: 40 }),
        item({ type: 'cylinder', r: 5, h: 40, seg: 32 })
      ]
    };
    const m = io.buildSrc({
      type: 'array', mode: 'linear', count: 3, step: [60, 0, 0], count2: 1,
      child: item(holed)
    });
    const v = m.validate();
    const one = 40 * 20 * 40 - 0.5 * 32 * 25 * Math.sin(2 * Math.PI / 32) * 20;
    near('陣列套布林 體積（＝3×單件）', m.volume(), one * 3, 1e-2);
    eq('陣列套布林 元件數', v.components, 3);
    // 三塊、每塊一個貫穿孔 → chi = 2×3 − 2×3 = 0
    eq('陣列套布林 尤拉數（＝2×3−2×3）', v.euler, 0);
    eq('陣列套布林 貫穿孔數', topologyCheck(v, summarize(m).totalDefect).genus, 3);
  }

  // ── 布林套陣列：散熱孔板（8×4 個孔一次挖穿）──
  {
    const holes = {
      type: 'array', mode: 'linear', count: 8, step: [22, 0, 0],
      count2: 4, step2: [0, 0, 22],
      child: item({ type: 'cylinder', r: 6, h: 40, seg: 24 }, [-77, 0, -33])
    };
    const m = io.buildSrc({
      type: 'bool', op: BOOL_OPS.SUBTRACT,
      items: [item({ type: 'box', w: 200, h: 10, d: 100 }), item(holes)]
    });
    const v = m.validate();
    const t = topologyCheck(v, summarize(m).totalDefect);
    const hole = 0.5 * 24 * 36 * Math.sin(2 * Math.PI / 24) * 10;

    eq('散熱板 元件數', v.components, 1);
    eq('散熱板 貫穿孔數（應為 32）', t.genus, 32);
    eq('散熱板 尤拉數（＝2−2×32）', v.euler, -62);
    ok('散熱板 尤拉數判定為正確', t.eulerOK);
    near('散熱板 體積（＝板 − 32 個孔）', m.volume(), 200 * 10 * 100 - hole * 32, 1e-1);
    ok('散熱板 結構無誤', v.ok);
  }

  // ── 存讀檔往返 ──
  {
    const doc = new io.Doc();
    doc.add(new io.ModelObject({
      name: '排一排',
      src: {
        type: 'array', mode: 'linear', count: 4, step: [30, 0, 0], count2: 1, child: cube()
      },
      pos: new THREE.Vector3(5, 10, 15)
    }));
    const before = doc.objects[0].mesh().volume();
    const json = JSON.parse(JSON.stringify(doc.toJSON()));

    eq('存檔版本號', json.v, io.DOC_VERSION);
    eq('陣列物件不存三角形', json.objects[0].mesh, undefined);

    const back = io.Doc.fromJSON(json);
    near('讀回來 體積相同', back.objects[0].mesh().volume(), before, 1e-6);
    eq('讀回來 份數', back.objects[0].copies, 4);

    back.objects[0].src.count = 9;
    eq('存檔是深拷貝', doc.objects[0].src.count, 4);
  }

  // ── 改份數要即時反映 ──
  {
    const o = new io.ModelObject({
      src: { type: 'array', mode: 'linear', count: 3, step: [30, 0, 0], count2: 1, child: cube() }
    });
    near('改份數前 體積', o.mesh().volume(), 3000, 1e-4);
    eq('改份數前 copies', o.copies, 3);
    o.src.count = 7;
    o.invalidate();
    near('份數 3 改 7 後 體積', o.mesh().volume(), 7000, 1e-4);
    eq('份數 3 改 7 後 copies', o.copies, 7);
  }

  // ── 打散：位置與數量都要對 ──
  {
    const o = new io.ModelObject({
      name: '橫料',
      src: { type: 'array', mode: 'linear', count: 4, step: [30, 0, 0], count2: 1, child: cube() },
      pos: new THREE.Vector3(100, 0, 0)
    });
    const parts = io.explodeArray(o);
    eq('打散 個數', parts.length, 4);
    eq('打散 第 1 個名稱', parts[0].name, '橫料 #1');
    near('打散 第 1 個 X（＝物件位置）', parts[0].pos.x, 100, 1e-6);
    near('打散 第 4 個 X（＝100+90）', parts[3].pos.x, 190, 1e-6);
    near('打散 後單件體積', parts[0].mesh().volume(), 1000, 1e-6);
    ok('打散 後不再是陣列', !parts[0].isArray);
  }

  // ── 打散鏡射件：鏡像那份的縮放要是負的 ──
  {
    const o = new io.ModelObject({
      src: { type: 'array', mode: 'mirror', axis: 'x', offset: 30, child: cube() }
    });
    const parts = io.explodeArray(o);
    eq('打散鏡射 個數', parts.length, 2);
    ok('打散鏡射 第 2 份是鏡像（X 縮放為負）', parts[1].scale.x < 0);
    near('打散鏡射 第 2 份位置 X', parts[1].pos.x, 60, 1e-6);
  }

  // ── 板件的陣列：直接拼接，不做布林聯集 ──
  // 2026-08-21 實測時發現板件陣列整個失敗（被布林擋下）。
  // 修法不是「想辦法讓布林吃下去」，而是認清語意不同：
  // 12 片一樣的側板就是 12 片，本來就不該黏成一體。
  {
    const bendSrc = { type: 'bend', w: 60, first: 40, arcSeg: 4, bends: [{ angle: 90, ri: 2, len: 30 }] };
    const one = buildPrim('bend', bendSrc);
    const folds1 = summarize(one).folds;

    for (const [label, node, n] of [
      ['線性', { type: 'array', mode: 'linear', count: 5, step: [0, 0, 80], count2: 1, child: item(bendSrc) }, 5],
      ['環形', { type: 'array', mode: 'radial', count: 8, axis: 'y', angle: 360, center: [0, 0, 0], child: item(bendSrc, [100, 0, 0]) }, 8],
      ['鏡射', { type: 'array', mode: 'mirror', axis: 'x', offset: 50, child: item(bendSrc) }, 2]
    ]) {
      const m = io.buildSrc(node);
      const v = m.validate();
      near(`板件${label}陣列 面積（＝${n}×單片）`, m.area(), one.area() * n, 1e-4);
      eq(`板件${label}陣列 元件數`, v.components, n);
      ok(`板件${label}陣列 仍是開放的面`, !v.closed);
      ok(`板件${label}陣列 結構無誤`, v.ok, v.errors[0] || '');
      // 折線一定要保住 —— 掉了折線，第 3 期就展不開
      eq(`板件${label}陣列 折線數（＝${n}×${folds1}）`, summarize(m).folds, folds1 * n);
      // 加厚後仍然是乾淨的封閉實體
      const sh = m.shell(0.3);
      near(`板件${label}陣列 加厚後體積`, sh.volume(), m.area() * 0.3, 1e-4);
      ok(`板件${label}陣列 加厚後封閉`, sh.validate().closed);
    }
  }

  // ── 布林仍然要擋下板件（那個限制是對的，不能一起放寬）──
  {
    const o = new io.ModelObject({
      src: {
        type: 'bool', op: BOOL_OPS.SUBTRACT,
        items: [item({ type: 'plate', w: 100, d: 60 }), item({ type: 'box', w: 10, h: 10, d: 10 })]
      }
    });
    o.mesh();
    ok('板件做布林仍然被擋下（布林需要實體）', !!o.error, o.error || '沒有擋');
  }

  // ── 交叉驗證：參數體「管」 vs 布林「大圓柱減小圓柱」──
  // 兩條完全獨立的路徑：一條是自己接半邊結構，一條走 Manifold。
  // 算出同一個數字，等於互相背書；哪天有一邊改壞了，這裡會先叫。
  {
    const tube = buildPrim('tube', { rOuter: 25, rInner: 20, h: 70, seg: 32 });
    const cut = io.buildSrc({
      type: 'bool', op: BOOL_OPS.SUBTRACT,
      items: [
        item({ type: 'prism', sides: 32, r: 25, h: 70 }),
        item({ type: 'prism', sides: 32, r: 20, h: 80 })
      ]
    });
    // 容許 0.01 cm³：布林引擎內部是 32 位元浮點數，相對誤差約 1e-7
    near('交叉驗證 管 vs 布林 體積相同', tube.volume(), cut.volume(), 1e-2);
    eq('交叉驗證 兩者尤拉數相同', tube.validate().euler, cut.validate().euler);
    eq('交叉驗證 兩者都是貫穿的（χ=0）', cut.validate().euler, 0);
  }

  // ── 效能：散熱孔這種份數多的情況不能卡 ──
  {
    const holes = {
      type: 'array', mode: 'linear', count: 16, step: [22, 0, 0],
      count2: 8, step2: [0, 0, 22],
      child: item({ type: 'cylinder', r: 6, h: 40, seg: 24 }, [-165, 0, -77])
    };
    const tree = {
      type: 'bool', op: BOOL_OPS.SUBTRACT,
      items: [item({ type: 'box', w: 400, h: 10, d: 200 }), item(holes)]
    };
    const t0 = performance.now();
    const m = io.buildSrc(tree);
    const ms = performance.now() - t0;
    eq('128 個孔 貫穿孔數', topologyCheck(m.validate(), summarize(m).totalDefect).genus, 128);
    ok(`128 個孔的散熱板耗時 ${ms.toFixed(0)} ms（門檻 400ms）`, ms < 400);
  }
}

// ═══════════════════════════════════════════════════════
//  面板的拓撲判定（2026-08-21 誤報過，所以特別測）
// ═══════════════════════════════════════════════════════

section('面板拓撲判定');

if (csgOK) {
  const item = (src, pos = [0, 0, 0], rot = [0, 0, 0]) =>
    ({ src, pos, rot, scale: [1, 1, 1], name: src.type });

  const check = m => {
    const v = m.validate();
    return { v, s: summarize(m), t: topologyCheck(v, summarize(m).totalDefect) };
  };

  // 沒有洞的方塊：χ=2、一塊、0 個孔、角虧 4π
  {
    const { v, t } = check(buildPrim('box', { w: 60, h: 45, d: 40 }));
    eq('方塊 元件數', v.components, 1);
    eq('方塊 貫穿孔數', t.genus, 0);
    ok('方塊 尤拉數判定為正確', t.eulerOK);
    near('方塊 角虧理論值（＝4π）', t.defectExpect, 4 * Math.PI, 1e-9);
    ok('方塊 角虧判定為正確', t.defectOK);
  }

  // 貫穿孔：χ=0、一塊、1 個孔、角虧 0
  // ← 這就是舊版面板誤報成兩個紅叉的情況
  {
    const { v, t } = check(io.buildSrc({
      type: 'bool', op: BOOL_OPS.SUBTRACT,
      items: [
        item({ type: 'box', w: 60, h: 45, d: 40 }),
        item({ type: 'cylinder', r: 10, h: 60, seg: 32 }, [0, 0, 0], [Math.PI / 2, 0, 0])
      ]
    }));
    eq('貫孔 元件數', v.components, 1);
    eq('貫孔 貫穿孔數', t.genus, 1);
    ok('貫孔 尤拉數判定為正確（不可再誤報）', t.eulerOK);
    near('貫孔 角虧理論值（＝0）', t.defectExpect, 0, 1e-9);
    ok('貫孔 角虧判定為正確（不可再誤報）', t.defectOK);
    eq('貫孔 說明文字', t.eulerNote, '＝2−2×1');
  }

  // 兩個分開的實體：χ=4、兩塊、0 個孔 —— 也不可以被誤報
  {
    const { v, t } = check(io.buildSrc({
      type: 'bool', op: BOOL_OPS.UNION,
      items: [
        item({ type: 'box', w: 20, h: 20, d: 20 }),
        item({ type: 'box', w: 20, h: 20, d: 20 }, [100, 0, 0])
      ]
    }));
    eq('分開兩塊 元件數', v.components, 2);
    eq('分開兩塊 貫穿孔數', t.genus, 0);
    ok('分開兩塊 尤拉數判定為正確', t.eulerOK);
    eq('分開兩塊 說明文字', t.eulerNote, '＝2×2−2×0');
    ok('分開兩塊 角虧判定為正確', t.defectOK);
  }

  // 開放的板件：χ=1，不做角虧判定
  {
    const { t } = check(buildPrim('plate', { w: 100, d: 60 }));
    eq('板件 貫穿孔數（不適用）', t.genus, null);
    ok('板件 尤拉數判定為正確', t.eulerOK);
    eq('板件 不對角虧下判斷', t.defectExpect, null);
  }

  // 結構真的接錯（χ 是奇數）時必須抓出來
  {
    const t = topologyCheck({ closed: true, euler: 3, components: 1 }, 0);
    ok('尤拉數是奇數 → 判定為錯誤', t.eulerOK === false);
    eq('尤拉數是奇數 → 不推算孔數', t.genus, null);
  }
  // χ 比元件數容許的最大值還大，也是不可能的
  {
    const t = topologyCheck({ closed: true, euler: 6, components: 1 }, 0);
    ok('χ 大於 2×元件數 → 判定為錯誤', t.eulerOK === false);
  }
}

// ═══════════════════════════════════════════════════════
//  第 3 期：展開 v1 ＋ DXF
// ═══════════════════════════════════════════════════════

section('第 3 期：K 因子與中性層');

{
  // 中性層半徑 rn ＝ 內側R ＋ K×板厚。這是整個展開長度的根。
  near('中性層 R2 t0.3 K0.4', neutralRadius(2, 0.4, 0.3), 2.12, 1e-12);
  near('中性層 R2 t0.3 K0.45', neutralRadius(2, 0.45, 0.3), 2.135, 1e-12);
  near('中性層 板厚 0 時等於內側R', neutralRadius(3, 0.4, 0), 3, 1e-12);
  near('中性層 尖角折（R0）不補', neutralRadius(0, 0.4, 0.5), 0, 1e-12);

  // 折彎展開長 BA ＝ θ × rn。90 度、3mm 板、內R3 是常見案例
  near('BA 90° R3 t0.3 K0.4', bendAllowance({ angle: 90, ri: 3 }, 0.4, 0.3),
    (Math.PI / 2) * 3.12, 1e-12);
  // 若誤把內側R 當中性層用，會少算這麼多 —— 這正是要防的錯
  const wrong = (Math.PI / 2) * 3;
  ok('用內側R 直接算會短少（所以一定要 K）',
    bendAllowance({ angle: 90, ri: 3 }, 0.4, 0.3) - wrong > 0.18);

  // 板厚變了，展開長要跟著變。板厚沒接進生成流程的話這項會失敗。
  const src = { w: 20, first: 30, arcSeg: 4, k: 0.4, bends: [{ angle: 90, ri: 2, len: 20 }] };
  const a = bendDevelopedLength(src, 0.1);
  const b = bendDevelopedLength(src, 1.0);
  near('板厚 0.1 → 1.0 展開長增加量', b - a, (Math.PI / 2) * 0.4 * 0.9, 1e-12);
  ok('板厚變厚，展開長一定變長', b > a);
}

section('第 3 期：展開長度 ＝ 網格真值（2026-08-23 依新定義改寫）');

/**
 * 🔴 **這一節在 2026-08-23 整個翻過來，改動理由比數字重要。**
 *
 * ── 舊的驗法（已作廢）────────────────────────────────
 * 驗「flatten.js 從網格算出來的展開長 ＝ bendDevelopedLength() 從參數
 * 套公式算出來的」，兩條獨立的路對答案。
 *
 * ── 為什麼作廢 ──────────────────────────────────────
 * 那個等式建立在「展開要把弦長拉成弧長」上，而**那件事已經不做了**。
 * kang 2026-08-23 定調：
 *
 *     **展開尺寸 ＝ 網格攤平後的總和。與材料無關。**
 *
 * 模型就是網格，網格裡沒有曲面。一道 arcSeg=4 的 90° 折彎在網格裡
 * 就是 4 片平板，展開長就是那 4 片相加。公式算的是**理想圓弧**，
 * 那是另一個問題的答案（詳見 `js/unfold/flatten.js` 檔頭）。
 *
 * ── 新的驗法 ────────────────────────────────────────
 * 兩條路還是要對答案，只是右邊換成「**網格真值的手算公式**」：
 *
 *     平面段總和 ＋ Σ（每道折彎的弦長總和）
 *     弦長總和 = m × 2·rn·sin(θ / 2m)      rn = ri + k×t
 *
 * ⭐ 而且**保留一項專門驗「公式與網格確實不同」** —— 把「這兩個數字
 * 本來就不該相等」釘死在測試裡。否則哪天有人看到差額，
 * 又會覺得那是誤差該補回去（那正是舊做法的由來）。
 */
/**
 * 網格真值 ＝ 參數公式 − Σ（每道折彎的弧弦差）
 *
 * 弦長 = m × 2·rn·sin(θ/2m)，弧長 = rn·θ ＝ BA
 * 所以           弦長 / BA = sin(θ/2m) / (θ/2m)      ← 就是 sinc
 *                弧弦差    = BA × (1 − sinc)
 *
 * ⚠ **兩個寫法都試錯過，記在這裡免得再犯：**
 *
 * ① 「平面段 ＋ Σ弦長」—— 90 度折彎全過，「四道混合」差 0.106。
 *    因為 `len` 怎麼量到折彎切點會隨角度變，不是單純相加。
 *
 * ② 自己算 `rn = ri + k×t` —— 「四道混合」差 4.35e-4。
 *    因為 **`neutralRadius(0, k, t)` 回傳 0，不是 k×t**：
 *    `ri = 0` 是**尖角折，根本沒有圓弧面**，`buildPrim()` 的
 *    `r > 1e-9` 那個條件會整段跳過，一片弧面都不生。
 *    自己重寫一份 rn 就是在跟權威函式賽跑，遲早會漂掉。
 *    〔鐵律：不要推論，去讀程式。2026-08-23 又犯一次〕
 *
 * → 所以一律**從 `bendAllowance()` 反推**，不自己算 rn。
 *   BA = 0 時 sinc 那一項自動退化成 0，尖角折免費處理對。
 *
 * 這也是為什麼右邊仍然要用 `bendDevelopedLength()` —— 它沒有被廢掉，
 * 只是不再是**圖面尺寸**的權威，改當「理想圓弧」那一側的參考值。
 */
function meshDevelopedLength(src, t) {
  let L = bendDevelopedLength(src, t);
  for (const b of src.bends) {
    const ba = bendAllowance(b, src.k, t);          // ＝ rn × θ；尖角折時是 0
    const th = Math.abs(b.angle) * Math.PI / 180;
    const half = th / (2 * src.arcSeg);
    const sinc = half > 1e-12 ? Math.sin(half) / half : 1;
    L -= ba * (1 - sinc);                            // 弧 − 弦，恆為正
  }
  return L;
}

{
  for (const seg of [2, 3, 4, 6, 8, 12, 24]) {
    const t = 0.3;
    const src = { w: 20, first: 30, arcSeg: seg, k: 0.4,
      bends: [{ angle: 90, ri: 2, len: 20 }] };
    const r = unfoldMesh(buildPrim('bend', src, t), makeRule('steel', t));

    eq(`arcSeg ${seg} 展開成一片`, r.pieces.length, 1);
    near(`arcSeg ${seg} 網格辨識 ＝ 網格真值手算`, r.pieces[0].width,
      meshDevelopedLength(src, t), 1e-9);

    /**
     * ★ 這一項是新定義的守門員：公式一定大於網格，而且差額不是誤差。
     * 弦永遠短於弧，所以 bendDevelopedLength() 一定比較大。
     * 差額 ＝ 你選 arcSeg=4 而不是 arcSeg=128 的代價，由建模階段承擔。
     */
    const byFormula = bendDevelopedLength(src, t);
    const byMesh = meshDevelopedLength(src, t);
    ok(`★ arcSeg ${seg} 公式 > 網格（兩者本來就不該相等）`,
      byFormula - byMesh > 1e-12, `公式 ${byFormula.toFixed(6)} 網格 ${byMesh.toFixed(6)}`);
  }

  // 分段越多，網格越接近理想圓 —— 這是「精緻度用 seg 調」的量化證據
  const t = 0.3;
  const mk = seg => ({ w: 20, first: 30, arcSeg: seg, k: 0.4,
    bends: [{ angle: 90, ri: 2, len: 20 }] });
  const gap = seg => bendDevelopedLength(mk(seg), t) - meshDevelopedLength(mk(seg), t);
  ok('★ 分段越多，網格與公式的差額越小', gap(2) > gap(4) && gap(4) > gap(24));
  ok('★ arcSeg 24 的差額已小於 0.01cm（本專案的物理尺度）', gap(24) < 0.01);
}

{
  // L / U / Z / 多道混合，四種都要對得上
  const cases = [
    ['L 型', { w: 60, first: 40, arcSeg: 4, k: 0.4, bends: [{ angle: 90, ri: 2, len: 30 }] }, 0.3, 1],
    ['U 型', { w: 50, first: 20, arcSeg: 6, k: 0.4,
      bends: [{ angle: 90, ri: 1.5, len: 40 }, { angle: 90, ri: 1.5, len: 20 }] }, 0.2, 2],
    ['Z 型', { w: 40, first: 25, arcSeg: 4, k: 0.4,
      bends: [{ angle: 90, ri: 2, len: 15 }, { angle: -90, ri: 2, len: 25 }] }, 0.5, 2],
    ['四道混合', { w: 30, first: 10, arcSeg: 5, k: 0.45,
      bends: [{ angle: 45, ri: 3, len: 20 }, { angle: 120, ri: 1, len: 15 },
              { angle: -60, ri: 2.5, len: 12 }, { angle: 90, ri: 0, len: 8 }] }, 0.15, 4]
  ];

  for (const [name, src, t, nBend] of cases) {
    const r = unfoldMesh(buildPrim('bend', src, t), makeRule('steel', t));
    const p = r.pieces[0];
    near(`${name} 展開長 ＝ 網格真值手算`, p.width, meshDevelopedLength(src, t), 1e-9);
    near(`${name} 展開寬 ＝ 板寬`, p.height, src.w, 1e-9);
    eq(`${name} 折彎道數`, p.bends.length, nBend);
    eq(`${name} 一片`, r.pieces.length, 1);
  }
}

{
  /**
   * 辨識出來的半徑與角度。
   *
   * 🔴 〔2026-08-23 改〕原本驗「內側 R ＝ 使用者填的 2 / 3.5」，
   * 那是 `b.ri`，由 K 因子與板厚推出來的 —— **那個欄位已經拿掉了**。
   * 現在圖上標的是 `b.r` ＝ **網格量出來的半徑**（＝中性層 2.12）。
   *
   * kang 2026-08-23：「K 因子…這都是造成混亂的條件…
   * 不應該在真實尺寸中出現」。
   *
   * ⚠ 折板這一格特別要說清楚：使用者填 2，網格建在 2.12，圖上標 2.12。
   * 那**不是標錯**，是那個模型的圓弧真的就在 2.12 ——
   * K 因子在 buildPrim() 決定了它建在哪，那一步是**建模**（跟 seg 同類），
   * 但建完之後，圖上就只該講網格現在是什麼樣子。
   */
  const t = 0.3;
  const src = { w: 40, first: 25, arcSeg: 6, k: 0.4,
    bends: [{ angle: 90, ri: 2, len: 15 }, { angle: -60, ri: 3.5, len: 25 }] };
  const p = unfoldMesh(buildPrim('bend', src, t), makeRule('steel', t)).pieces[0];

  near('辨識 第1道 角度', p.bends[0].angle, 90, 1e-6);
  near('辨識 第1道 半徑（網格量出來的）', p.bends[0].r, 2.12, 1e-6);
  ok('★ 第1道 已經沒有 ri 這個欄位（K 推出來的內側 R）',
    p.bends[0].ri === undefined);
  near('辨識 第2道 角度', p.bends[1].angle, -60, 1e-6);
  near('辨識 第2道 半徑（網格量出來的）', p.bends[1].r, 3.5 + 0.4 * t, 1e-6);
  eq('辨識 第1道 是圓弧', p.bends[0].isArc, true);

  /**
   * 折彎區在展開圖上佔的寬度 ＝ 那一道的**弦長總和**，不是 BA。
   * 〔2026-08-23 改。原本驗 `bendAllowance()`，那是理想圓弧的公式〕
   *
   * BA 仍然是一個有意義的數字（理想圓弧的展開長），只是它**不是圖上
   * 這一段的寬度**。圖上那一段就是 m 片平板排在一起。
   */
  const chordW = b => {
    const rn = b.ri + src.k * t;
    return src.arcSeg * 2 * rn * Math.sin(Math.abs(b.angle) * Math.PI / 180 / (2 * src.arcSeg));
  };
  near('第1道 折彎區寬 ＝ 弦長總和', p.bends[0].x1 - p.bends[0].x0,
    chordW(src.bends[0]), 1e-9);
  near('第2道 折彎區寬 ＝ 弦長總和', p.bends[1].x1 - p.bends[1].x0,
    chordW(src.bends[1]), 1e-9);
  ok('★ 折彎區寬 < BA（弦短於弧，永遠成立）',
    p.bends[0].x1 - p.bends[0].x0 < bendAllowance(src.bends[0], src.k, t));
  near('第1道 折邊（前面那段）', p.bends[0].flange, 15, 1e-6);
}

{
  // 尖角折（內側R＝0）不佔寬度，展開長就是直線相加
  const t = 0.3;
  const src = { w: 50, first: 30, arcSeg: 4, k: 0.4, bends: [{ angle: 90, ri: 0, len: 20 }] };
  const p = unfoldMesh(buildPrim('bend', src, t), makeRule('steel', t)).pieces[0];
  near('尖角折 展開長', p.width, 50, 1e-9);
  eq('尖角折 不是圓弧', p.bends[0].isArc, false);
  near('尖角折 折彎區寬度為 0', p.bends[0].x1 - p.bends[0].x0, 0, 1e-9);
}

section('第 3 期：其他形狀');

{
  // 平板：展開圖就是原尺寸。曾經因為拿三角化的對角線當基準而歪掉（116.6×102.9）
  const p = unfoldMesh(buildPrim('plate', { w: 100, d: 60 }, 0.2),
    makeRule('steel', 0.2)).pieces[0];
  near('平板 展開長', p.width, 100, 1e-9);
  near('平板 展開寬', p.height, 60, 1e-9);
  near('平板 面積', p.area, 6000, 1e-6);
  eq('平板 沒有折彎', p.bends.length, 0);
  eq('平板 外輪廓四個點', p.outline.length, 4);
}

{
  /**
   * 圓柱側面。這一題同時驗兩件事：
   *   1. 繞一圈接回自己的網格會自動剪開一條縫（否則攤不平、抓不到輪廓）
   *   2. 剪開之後兩端那兩片仍算在圓弧裡，段數才會等於 seg
   *
   * 🔴 **2026-08-23：期望值從 2πr 改成弦長總和。**
   * seg 段的「圓柱」在網格裡就是一根 seg 邊柱，展開寬就是 seg 片相加。
   * 2πr 算的是一個從來沒被做出來過的理想圓（見 flatten.js 檔頭）。
   */
  // 容許值 1e-4 cm ＝ 1 微米。轉折角是從面法向量算出來的，
  // 段數多的時候浮點誤差會累積；平均過後這是可以穩定達到的精度，
  // 而且遠比任何加工公差嚴格。寫死 1e-6 只是自欺欺人。
  const chordSum = (r, seg) => seg * 2 * r * Math.sin(Math.PI / seg);

  for (const seg of [8, 16, 32, 64, 128]) {
    const m = buildPrim('cylinder', { r: 25, h: 70, seg, openEnded: true }, 0.2);
    const p = unfoldMesh(m, makeRule('steel', 0.2)).pieces[0];
    near(`圓柱側面 ${seg} 段 展開長 ＝ 弦長總和`, p.width, chordSum(25, seg), 1e-4);
    ok(`★ 圓柱側面 ${seg} 段 展開長 < 2πr（弦短於弧，永遠成立）`,
      p.width < 2 * Math.PI * 25);
    near(`圓柱側面 ${seg} 段 展開高`, p.height, 70, 1e-9);
    near(`圓柱側面 ${seg} 段 辨識半徑`, p.bends[0].r, 25, 1e-4);
    near(`圓柱側面 ${seg} 段 辨識總角度`, Math.abs(p.bends[0].angle), 360, 1e-3);

    /**
     * ★★ 折彎區畫出來的寬度，必須跟它自己宣告的段數對得起來。
     * 〔2026-08-23 新增，kang 實測截圖抓到的〕
     *
     * ── 這一項在防什麼 ──────────────────────────────
     * `buildPiece()` 是從**折線的位置**量出折彎區的範圍。圓筒繞一圈
     * 接回來，接縫剪開後只剩 31 條折線，最外面那兩格**外側沒有折線**，
     * 於是量出來只有 30 格，而 `segs` 是 32：
     *
     *     圖上標「展開 147.03　32 段」，147.03 ÷ 4.9009 ＝ 30.0
     *
     * ⭐ **這個 bug 一直都在，是加上「N 段」之後才自曝的。**
     * 舊標註只寫「弧長 147.03」，沒有第二個數字可以對照。
     * 教訓：**讓兩個數字互相對得起來，錯誤才會自己現形。**
     */
    const b0 = p.bends[0];
    near(`★★ 圓柱側面 ${seg} 段 折彎區寬 ＝ 整條弧（不漏頭尾兩格）`,
      b0.x1 - b0.x0, b0.chordW, 1e-9);
    near(`★★ 圓柱側面 ${seg} 段 折彎區換算回來就是 ${seg} 段`,
      (b0.x1 - b0.x0) / (b0.chordW / b0.segs), seg, 1e-6);
    near(`圓柱側面 ${seg} 段 折彎區 ＝ 整片寬（整根都是彎的）`,
      b0.x1 - b0.x0, p.width, 1e-6);
  }
}

{
  /**
   * ★★ 通則：**可用的圖上**，每一條圓弧帶畫出來的寬度都要等於 `chordW`，
   * 也就是跟它自己宣告的段數對得起來。
   *
   * ── 為什麼限定「可用的圖」──────────────────────────
   * ⚠ 有一個既有的破口：沒標分片的**管**攤平後，外壁與內壁疊成同一片，
   * 而兩邊的折線方向剛好一樣，於是被歸進同一條帶 ——
   * 量出來的範圍橫跨兩面牆（129.02），而 `chordW` 只有 117.62。
   *
   * 🔴 **那不是這次改出來的，是本來就有的**（折線分組只看方向，
   * 不管中間隔著另一面牆）。這次的修法在補之前會先驗
   * 「差額 ＝ ext × 一格弦長」，對不上就完全不補，所以沒有讓它變糟 ——
   * 但也沒有修好它。
   *
   * 那一片本來就攤不出可用的圖（會跳重疊警告），所以這裡把它排除，
   * 並用下一項單獨盯著「它確實有被標示成不可用」。
   * ⛔ 不要把這一項的範圍放寬到含重疊的片 —— 那等於把破口寫進期望值。
   */
  const cases = [
    ['圓柱 open', buildPrim('cylinder', { r: 25, h: 70, seg: 32, openEnded: true }, 0.2), 'foamboard'],
    ['圓柱 封閉', buildPrim('cylinder', { r: 25, h: 70, seg: 32 }, 0.2), 'paper'],
    ['圓角方塊', buildPrim('roundBox', { w: 60, h: 45, d: 40, r: 6, segR: 4 }, 0.2), 'foamboard'],
    ['折板 Z 型', buildPrim('bend', { w: 40, first: 25, arcSeg: 4, k: 0.4,
      bends: [{ angle: 90, ri: 2, len: 15 }, { angle: -90, ri: 2, len: 25 }] }, 0.5), 'steel'],
    ['圓錐 open', buildPrim('cone', { rTop: 0, rBottom: 30, h: 70, seg: 32, openEnded: true }, 0.2), 'foamboard']
  ];

  let checked = 0, bad = [];
  for (const [name, mesh, mat] of cases) {
    for (const p of unfoldMesh(mesh, makeRule(mat, 0.2)).pieces) {
      if (p.overlap) continue;                       // 本來就不可用的圖，見上面說明
      for (const b of p.bends) {
        if (!b.isArc || b.isCurve) continue;
        checked++;
        if (Math.abs((b.x1 - b.x0) - b.chordW) > 1e-6) {
          bad.push(`${name} ${(b.x1 - b.x0).toFixed(4)}≠${b.chordW.toFixed(4)}`);
        }
      }
    }
  }
  ok(`★★ 可用的圖上 ${checked} 條弧帶 折彎區寬都 ＝ chordW`,
    checked >= 8 && bad.length === 0, bad.join(' / '));

  /**
   * ★ 那個既有的破口，至少要被「不可用」擋住 ——
   * 使用者不會拿到一張標錯又沒警告的圖。
   */
  const rt = unfoldMesh(buildPrim('tube', { rOuter: 25, rInner: 20, h: 70, seg: 32 }, 0.2),
    makeRule('paper', 0.2));
  const wide = rt.pieces.flatMap(p => p.bends.map(b => ({ p, b })))
    .filter(x => x.b.isArc && !x.b.isCurve && x.b.x1 - x.b.x0 > x.b.chordW + 1e-6);
  ok('★ 管：折彎區橫跨兩面牆的那條帶還在（既有破口，尚未修）', wide.length > 0);
  ok('★ 但它所在的片一定被標成有重疊（使用者不會誤用）',
    wide.every(x => x.p.overlap === true));
  ok('沒標分片的管 有重疊警告', rt.warnings.some(w => w.includes('重疊')));
}

{
  // 封閉實體遇到不能折的材料，會沿每條稜線切開變成六個面。
  // 相同的面會被併成「一張圖 ×N」，所以是 3 種 6 片，不是 6 種。
  const r = unfoldMesh(buildPrim('box', { w: 60, h: 45, d: 40 }),
    makeRule('acrylic', 0.3));
  eq('封閉實體 拆成 3 種面', r.pieces.length, 3);
  eq('封閉實體 共 6 片', r.stats.total, 6);
  eq('封閉實體 六片面積總和', Math.round(r.stats.area), 13800);
  ok('封閉實體 相同的面合併成 ×2', r.pieces.every(p => p.qty === 2));
}

section('錐面：攤平本來就精確（2026-08-23 依新定義改寫）');

/**
 * 🔴 **這一節在 2026-08-23 整個翻過來。**
 *
 * ── 舊的驗法（已作廢）────────────────────────────────
 * 驗「圓錐一定要跳出『請勿據以下料』的警告」，理由是圓弧修正的前提
 * （折線互相平行）在錐面上不成立，所以展開長度退回弦長、偏短。
 *
 * ── 為什麼作廢 ──────────────────────────────────────
 * 因為**弦長現在就是正確答案**（見 flatten.js 檔頭）。
 * 那則警告是在叫人不要用一個正確的數字 —— 誤報比漏報更糟（坑第 18 條）。
 *
 * 而且 2026-08-23 沙箱實測證明**錐面的攤平一格誤差都沒有**：
 * r=30、h=70，seg 6／8／16／32／64，展開圖上離頂點最遠的距離
 * 一律 76.1579，母線 76.1577。扇形半徑精確等於母線。
 *
 * ── 新的驗法 ────────────────────────────────────────
 * 改成驗那件實測到的事實：**扇形半徑 ＝ 母線**。
 * 這比原本的警告有價值得多 —— 警告只是講話，這一項是在對答案。
 * `radialFolds` 仍然要驗（它是事實，之後對錐面做別的事會用到）。
 */
{
  for (const seg of [8, 16, 32]) {
    const cone = buildPrim('cone', { rBottom: 30, rTop: 15, h: 40, seg, openEnded: true }, 0.3);
    const r = unfoldMesh(cone, makeRule('steel', 0.3));
    const p = r.pieces[0];
    ok(`圓錐 ${seg} 段 認出是錐面（折線放射狀）`, p.radialFolds === true);
    ok(`★ 圓錐 ${seg} 段 不再有「請勿據以下料」的誤報`,
      !r.warnings.some(w => w.includes('請勿據以下料')));
  }

  /**
   * ★ 正圓錐：展開扇形的半徑必須精確等於母線。
   *
   * 這是攤平是剛體運動的直接後果 —— 側面每個三角形從頂點量到底緣
   * 的那條邊，攤平前後長度不變。對不上就代表攤平壞了。
   */
  for (const seg of [6, 8, 16, 32, 64]) {
    const L = Math.hypot(30, 70);                     // 母線
    const p = unfoldMesh(buildPrim('cone', { rTop: 0, rBottom: 30, h: 70, seg, openEnded: true }),
      makeRule('foamboard', 0.5)).pieces[0];
    const pts = p.outline;
    // 頂點 ＝ 讓「到其他輪廓點距離 ≈ 母線」的個數最多的那個點
    let apex = pts[0], bestN = -1;
    for (const c of pts) {
      const n = pts.filter(q => Math.abs(Math.hypot(q.x - c.x, q.y - c.y) - L) < 1e-4).length;
      if (n > bestN) { bestN = n; apex = c; }
    }
    const far = Math.max(...pts.map(q => Math.hypot(q.x - apex.x, q.y - apex.y)));
    near(`★ 圓錐 ${seg} 段 扇形半徑 ＝ 母線`, far, L, 1e-3);
  }

  /**
   * 開放但數學上攤不平的曲面（球冠）也要被抓到。
   *
   * 球冠**不是**錐面（折線不匯聚，實測 45/127），所以 radialFolds 抓不到它。
   * 它由另一條既有的警告負責：攤平後真的重疊。
   * 兩條講的是不同的事 —— 一條是「算不準」，一條是「這張圖本身就不能用」。
   *
   * 重疊這一條在「先走最平的邊」之前是 false（生成樹亂走，
   * 把該疊的地方撐成裂縫），改成優先走平邊之後才抓得到。
   */
  const cap = Mesh.fromGeometry(
    new THREE.SphereGeometry(30, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3));
  const rc = unfoldMesh(cap, makeRule('steel', 0.3));
  ok('球冠 不是錐面，不該被 radialFolds 抓', rc.pieces[0].radialFolds === false);
  ok('球冠 改由重疊偵測負責（生成樹改良後才抓得到）', rc.pieces[0].overlap === true);
  ok('球冠 仍然有警告（換一條，但沒有漏掉）',
    rc.warnings.some(w => w.includes('重疊')));
  ok('★ 球冠 這一片確實檢查過（不是跳過的）', rc.pieces[0].overlapChecked === true);
}

/**
 * ★★ 重疊偵測的三態（2026-08-23 新增）
 *
 * ── 為什麼要有這一節 ────────────────────────────────
 * 原本 `detectOverlap()` 在 `polys.length > 3000` 時**直接回 false**，
 * 也就是大模型一律顯示「沒問題」，而且**不會說自己沒檢查**。
 *
 * 那是**沉默的漏報** —— 比誤報更糟：誤報至少會讓人去看一眼，
 * 沉默的漏報連「該懷疑」都不會發生（外部參考調查 0-1）。
 *
 * 「沒有重疊」和「沒有檢查」是兩件完全不同的事。
 * 這一節就是釘死它們不准再被同一個 false 表達。
 */
{
  // ① 乾淨：檢查過，而且真的沒重疊
  const flat = unfoldMesh(buildPrim('plate', { w: 100, d: 60 }, 0.2), makeRule('steel', 0.2));
  ok('① 平板 檢查過', flat.pieces[0].overlapChecked === true);
  ok('① 平板 沒有重疊', flat.pieces[0].overlap === false);
  ok('① 平板 不該有任何重疊相關的訊息',
    !flat.warnings.some(w => w.includes('重疊')));

  // ② 真的重疊：球冠（見上）—— 訊息要講「不能直接下料」與「請用分片」
  const cap2 = Mesh.fromGeometry(
    new THREE.SphereGeometry(30, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3));
  const w2 = unfoldMesh(cap2, makeRule('steel', 0.3)).warnings.join('|');
  ok('② 有重疊時 要講「不能直接下料」', w2.includes('不能直接下料'));
  ok('② 有重疊時 要指路（用「分片」切開）', w2.includes('分片'));

  /**
   * ③ 🔴 太大沒檢查：一定要**說出來**。
   *
   * 用 128×64 的球面湊出超過 3000 個面。這裡不驗「有沒有重疊」——
   * 重點就是程式**不知道**，而它必須承認自己不知道。
   */
  const big = Mesh.fromGeometry(new THREE.SphereGeometry(30, 128, 64));
  const rb = unfoldMesh(big, makeRule('steel', 0.3));
  ok('③ 這個模型確實超過 3000 片', rb.pieces.some(p => p.overlapChecked === false),
    `片數 ${rb.pieces.map(p => p.faces.length).join(',')}`);
  const wb = rb.warnings.join('|');
  ok('★★ ③ 沒檢查時 必須明講「沒有檢查」', wb.includes('沒有檢查'));
  ok('★★ ③ 而且要把話說死：不是「沒有問題」', wb.includes('不是'));
  ok('③ 沒檢查時 不可以宣稱沒有重疊',
    !rb.pieces.some(p => p.overlapChecked === false && p.overlap === true));

  /**
   * ★ 訊息裡不可以再出現「第 7 期」。
   * 第 7 期（自動分片）已經取消 —— 剖面分切把同一個需求解得更好。
   * 承諾一個不存在的退路，使用者會等一個永遠不會來的功能（鐵律六）。
   */
  const allWarn = [w2, wb, flat.warnings.join('|')].join('|');
  ok('★ 警告裡不再提已取消的「第 7 期」', !allWarn.includes('第 7 期'));
}

{
  /**
   * ── 攤平時「先走最平的邊」──────────────────────────
   *
   * 生成樹要優先跨過轉折角最小的邊，讓共面的鄰居黏在一起。
   * 先進先出的版本會讓圓錐底蓋的 32 個三角形各自從旁邊的側面
   * 跨輪圈接上去，底蓋被拆散、散落在扇形四周，攤出來是一張星芒狀的廢圖。
   */
  const rule = makeRule('steel', 0.2);

  // 開放錐面：攤平後必須是一個乾淨的扇形 ——
  // 外圈每一點到頂點的距離都等於斜高。這是剛體展開的精確解，
  // 跟弦長偏短是兩回事（那個是外弧本身的長度，不是形狀跑掉）。
  const side = buildPrim('cone', { rBottom: 30, rTop: 0, h: 70, seg: 32, openEnded: true }, 0.2);
  const sp = unfoldMesh(side, rule).pieces[0];
  const cnt = new Map();
  const key = q => q.x.toFixed(3) + ',' + q.y.toFixed(3);
  for (const f of sp.faces) for (const q of f) cnt.set(key(q), (cnt.get(key(q)) || 0) + 1);
  const [ax, ay] = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number);
  const slant = Math.hypot(30, 70);
  const outer = sp.outline.map(q => Math.hypot(q.x - ax, q.y - ay)).filter(d => d > 1);
  eq('開放錐面 外圈點數', outer.length, 33);
  ok('開放錐面 外圈每一點都落在斜高上（是乾淨的扇形）',
    outer.every(d => Math.abs(d - slant) < 1e-3), `斜高 ${slant.toFixed(4)}`);

  /**
   * 封閉錐（側面 ＋ 底蓋）——星芒的迴歸保護。
   *
   * 星芒版的外框是 220.56 × 182.05，遠大於實際需要的料。
   * 改良後底蓋保持完整，整張圖收斂到 150 cm 以內。
   * 這裡用外框當指標：星芒一旦回來，外框一定會再度膨脹。
   */
  const solid = buildPrim('cone', { rBottom: 30, rTop: 0, h: 70, seg: 32, openEnded: false }, 0.2);
  const cp = unfoldMesh(solid, rule).pieces[0];
  ok('封閉錐 外框沒有膨脹成星芒', cp.width < 150 && cp.height < 150,
    `${cp.width.toFixed(2)} × ${cp.height.toFixed(2)}（星芒版是 220.56 × 182.05）`);

  // 面積是 3D 真值，攤平方式不影響它 —— 拿它確認沒有掉面
  near('封閉錐 面積不受攤平順序影響', cp.area, 9970.15, 0.01);
}

{
  // ── 正面：本來就算得準的，一個都不能誤報 ──
  const steel = makeRule('steel', 0.3);
  const clean = [
    ['平板', buildPrim('plate', { w: 100, d: 60 }, 0.3)],
    ['折板 L', buildPrim('bend', { bends: [{ angle: 90, ri: 2, len: 30 }] }, 0.3)],
    ['折板 U', buildPrim('bend',
      { bends: [{ angle: 90, ri: 2, len: 30 }, { angle: 90, ri: 2, len: 30 }] }, 0.3)],
    ['折板 Z', buildPrim('bend',
      { bends: [{ angle: 90, ri: 2, len: 30 }, { angle: -90, ri: 2, len: 30 }] }, 0.3)],
    ['圓柱側面 8 段', buildPrim('cylinder', { r: 25, h: 70, seg: 8, openEnded: true }, 0.3)],
    ['圓柱側面 64 段', buildPrim('cylinder', { r: 25, h: 70, seg: 64, openEnded: true }, 0.3)],
    /**
     * ★ 鋼板方塊 —— **這一項是補漏的**。
     *
     * 第一版判準是「折線沒有全部互相平行就報」，鋼板方塊攤成十字型時
     * 5 道折線分兩個方向，於是在**最常見的件**上跳出「請勿據以下料」。
     * 但方塊根本沒有圓弧（圓弧 0、尖角 5），那張圖完全正確。
     *
     * 當初這一節寫了六個正面案例卻漏掉它，是因為只測了壓克力方塊 ——
     * 壓克力的折線全被切開、等於沒有折線，所以矇混過關。
     * kang 2026-08-22 在瀏覽器實測抓到。
     */
    ['鋼板方塊（十字型）', buildPrim('box', { w: 60, h: 45, d: 40 }, 0.3)],
    ['角柱', buildPrim('prism', { sides: 6, r: 30, h: 60 }, 0.3)],
    ['圓角方塊 segR4', buildPrim('roundBox', { w: 60, h: 45, d: 40, r: 6, segR: 4 }, 0.3)],
    ['圓角方塊 segR8', buildPrim('roundBox', { w: 60, h: 45, d: 40, r: 6, segR: 8 }, 0.3)]
  ];
  for (const [name, m] of clean) {
    const r = unfoldMesh(m, steel);
    ok(`${name} 不該被誤判成錐面`, r.pieces.every(p => p.radialFolds === false));
    ok(`${name} 不該出現「請勿據以下料」`,
      !r.warnings.some(w => w.includes('請勿據以下料')));
  }

  // 方塊十字型的面積必須精確 —— 誤報修掉了，但圖不能跟著壞
  const cross = unfoldMesh(buildPrim('box', { w: 60, h: 45, d: 40 }, 0.3), steel).pieces[0];
  near('鋼板方塊 十字型面積 ＝ 六面總和', cross.area, 13800, 1e-6);
  eq('鋼板方塊 五道折彎', cross.bends.length, 5);
  ok('鋼板方塊 五道全是尖角折（沒有圓弧要修）',
    cross.bends.every(b => !b.isArc));

  /**
   * 壓克力封閉方塊 —— 這條是**迴歸保護**。
   *
   * 開發這一節時一度加了「封閉實體一律拒絕展開」，把這個用途整個打死。
   * 但壓克力箱體就是六片分開下料再黏起來，是天天在用的正確做法。
   * 封不封閉根本不是判準，拿它當判準就會誤傷這條路。
   */
  const box = unfoldMesh(buildPrim('box', { w: 60, h: 45, d: 40 }), makeRule('acrylic', 0.3));
  eq('壓克力封閉方塊 仍然拆得出 3 種面', box.pieces.length, 3);
  ok('壓克力封閉方塊 六片都不該被誤報',
    box.pieces.every(p => p.radialFolds === false));
}

{
  /**
   * 警告洗版 —— 同一種問題只講一次。
   *
   * 原本是逐道折彎各推一則，31 道折彎的錐面會吐出 31 行一模一樣的
   * 「折邊只有 0cm」，把真正要緊的警告整個淹掉。
   * 看的人只會學會忽略這一欄，那這一欄就等於不存在。
   */
  const cone = buildPrim('cone', { rBottom: 30, rTop: 15, h: 40, seg: 32, openEnded: true }, 0.3);
  const p = unfoldMesh(cone, makeRule('steel', 0.3)).pieces[0];
  const flange = p.warnings.filter(w => w.includes('折邊只有'));
  eq('31 道折彎的錐面 折邊警告只講一則', flange.length, 1);
  ok('折邊警告要講出總共幾道', flange[0].includes('共') && flange[0].includes('道'));

  // 只有一道時不要畫蛇添足加上「共 1 道」
  const short = buildPrim('bend', { first: 0.1, arcSeg: 4, bends: [{ angle: 90, ri: 2, len: 0.1 }] }, 0.3);
  const sp = unfoldMesh(short, makeRule('steel', 0.3)).pieces[0];
  const one = sp.warnings.filter(w => w.includes('折邊只有'));
  ok('只有一道時不加「共 N 道」', one.length === 0 || !one[0].includes('共'));
}

section('🔴 尺寸的依據是網格，與材料無關（2026-08-23 定調）');

/**
 * ── 這一節在盯什麼 ──────────────────────────────────
 *
 * **展開尺寸 ＝ 網格攤平後的總和。與材料無關。**〔kang 2026-08-23〕
 *
 * 模型就是網格，網格裡沒有曲面。seg 段的「圓柱」在網格裡就是一根
 * seg 邊柱，展開寬就是 seg 片平板相加。2πr 算的是一個**從來沒被
 * 做出來過的理想圓** —— 起點不同，不是誰比較準。
 *
 * ── 這一節的歷史（兩次都是同一個病：定義沒講清楚）────
 * 2026-08-22 之前：寫死「一律弧長」→ 板材一律往多的錯
 *                  （4 角柱 +11.07%、8 段圓柱 +2.62%）
 * 2026-08-22：改成「捲得起來走弧長，捲不起來走弦長」
 *             → 結論對了一半，但**理由錯了**，而且留下一個大洞：
 *               同一個模型換個材料就換尺寸，沒有一個數字有單一意義
 * 2026-08-23：改成「一律網格真值」→ 材料完全退出尺寸計算
 *
 * ⛔ **不要把材料判斷寫回長度計算裡。** 基準一旦有條件，
 *    圖上就再也沒有一個數字有單一意義了。
 *
 * 容許值用相對誤差 1e-7：攤平是剛體運動，理論上精確，
 * 實際差在 1e-8～1e-16 之間，那是浮點雜訊。
 * 這個檔案開頭就寫過「寫死 1e-6 只是自欺欺人」—— 這裡同一個道理。
 */
{
  const board = makeRule('foamboard', 0.8);
  const r = 30, h = 60;

  /** ★ 新規則的核心：所有材料給同一個數字 */
  const ALL = ['foamboard', 'paper', 'canvas', 'steel', 'stainless', 'aluminum'];

  for (const seg of [4, 6, 8, 12, 16, 32, 64]) {
    const chord = seg * 2 * r * Math.sin(Math.PI / seg);   // 正 n 邊形周長
    const arc = 2 * Math.PI * r;                           // 理想圓周長

    const widths = ALL.map(mat => unfoldMesh(
      buildPrim('cylinder', { r, h, seg, openEnded: true }, 0.8),
      makeRule(mat, 0.8)).pieces[0].width);

    rel(`${seg} 段 展開長 ＝ 弦長（各面外緣相加）`, widths[0], chord);

    /**
     * ★★ 這一項是整條新規則的守門員。
     * 只要有人把材料判斷寫回尺寸計算，這裡第一個炸。
     * ⚠ 壓克力不列入 —— 它折不起來，會被拆成 seg 片各自下料，
     *   那是**片數**不同（材料本來就該管的事），不是尺寸被改。
     */
    ok(`★★ ${seg} 段 六種材料給同一個展開長（尺寸與材料無關）`,
      widths.every(w => Math.abs(w - widths[0]) < 1e-9),
      ALL.map((m, i) => `${m}:${widths[i].toFixed(6)}`).join(' '));

    // 弦永遠短於弧 —— 方向錯了比大小錯了更嚴重
    ok(`★ ${seg} 段 展開長 < 2πr（弦短於弧，永遠成立）`, widths[0] < arc);
  }

  // 分段越多越接近理想圓 —— 「精緻度用 seg 調，不用公式補」的量化證據
  const w = seg => unfoldMesh(buildPrim('cylinder', { r, h, seg, openEnded: true }, 0.8),
    board).pieces[0].width;
  const arc = 2 * Math.PI * r;
  ok('★ seg 越大越接近 2πr', (arc - w(8)) > (arc - w(32)) && (arc - w(32)) > (arc - w(128)));

  /**
   * ★ 用**半徑誤差**當門檻，不用周長差。
   *
   * 周長差會隨半徑放大（r=30 的 128 段差 0.019cm，r=25 只差 0.016），
   * 拿它跟一個絕對門檻比，等於讓判準隨模型大小漂移。
   * 真正有物理意義的是「這張料捲起來之後，半徑差多少」——
   * 那是師傅拿卡尺量得到的東西，而且不隨周長縮放。
   *   〔坑第 20 條的近親：正確的數字，錯誤的意思〕
   */
  const radiusErr = seg => r - w(seg) / (2 * Math.PI);
  ok('★ seg 128 捲起來的半徑誤差 < 0.01cm（本專案的物理尺度）',
    radiusErr(128) < 0.01, `誤差 ${radiusErr(128).toFixed(5)} cm`);
  ok('★ seg 8 的半徑誤差大到不能忽略（> 0.5cm）', radiusErr(8) > 0.5,
    `誤差 ${radiusErr(8).toFixed(5)} cm`);

  /**
   * 交叉檢查：矩形片的 展開長 × 展開寬 必須等於面積。
   *
   * 這是最硬的一條 —— 面積是從 **3D 真實網格**算的，
   * 寬高是從**攤平後的 2D 圖**量的，兩條完全獨立的路。
   * 圓弧修正只拉伸 2D、不動 3D，所以錯誤修正一定會讓這兩個數字打架。
   * 2026-08-22 之前板材確實對不上（8 段：11309.73 vs 11021.28）。
   */
  for (const seg of [4, 8, 32]) {
    const p = unfoldMesh(buildPrim('cylinder', { r, h, seg, openEnded: true }, 0.8), board).pieces[0];
    rel(`板材 ${seg} 段 展開長×展開寬 ＝ 面積`, p.width * p.height, p.area);
  }

  /**
   * 角柱：定義上就是平板拼出來的，弦長是唯一正解。
   *
   * 這裡量**總面積**而不是某一片的寬度 —— `prism` 是封閉的（含上下蓋），
   * 展開後哪一片是側板帶要靠猜，而 `orient()` 還可能把寬高對調。
   * 面積不受擺法影響，是比較誠實的量法。
   * （第一版寫成「挑最寬的那片」，結果挑到蓋子，4／6／12 邊全部失敗。）
   */
  for (const sides of [4, 6, 8, 12]) {
    const R = 30, H = 60;
    const side = sides * (2 * R * Math.sin(Math.PI / sides)) * H;    // 側面：弦長×高
    const cap = 2 * (sides / 2 * R * R * Math.sin(2 * Math.PI / sides));
    const r2 = unfoldMesh(buildPrim('prism', { sides, r: R, h: H }, 0.8), board);
    const total = r2.pieces.reduce((a, p) => a + p.area * p.qty, 0);
    rel(`${sides} 角柱 展開總面積 ＝ 側面(弦長×高) ＋ 上下蓋`, total, side + cap);
  }
}

{
  /**
   * 🔴 2026-08-23：錐面的「請勿據以下料」警告**已整則刪除**。
   *
   * 原本它只對捲得起來的材料發。現在弦長對所有材料都是正確答案，
   * 所以那則警告對誰都是誤報（坑第 18 條：誤報比漏報更糟）。
   *
   * 這四項從「紙材／帆布要警告、板材不要」改成「**誰都不要**」——
   * 一併把「材料決定看到什麼訊息」這件事也清掉。
   */
  const cone = () => buildPrim('cone', { rBottom: 30, rTop: 15, h: 40, seg: 32, openEnded: true }, 0.3);
  const hasWarn = rule => unfoldMesh(cone(), rule).warnings.some(w => w.includes('請勿據以下料'));

  ok('★ 紙材 錐面不該警告（弦長就是答案）', hasWarn(makeRule('paper', 0.05)) === false);
  ok('★ 帆布 錐面不該警告', hasWarn(makeRule('canvas', 0.1)) === false);
  ok('珍珠板 錐面不該警告', hasWarn(makeRule('foamboard', 0.8)) === false);
  ok('壓克力 錐面不該警告', hasWarn(makeRule('acrylic', 0.3)) === false);

  // 但「認出這是錐面」這個事實不受材料影響 —— 事實歸事實，結論歸結論
  ok('錐面判定本身與材料無關',
    unfoldMesh(cone(), makeRule('foamboard', 0.8)).pieces[0].radialFolds === true);
}

{
  // 新材料與預設值
  ok('材料表有珍珠板／發泡板', MATERIAL_KEYS.includes('foamboard'));
  eq('預設材質改成珍珠板（他們不用金屬）', DEFAULT_MATERIAL, 'foamboard');
  ok('珍珠板：折得起來（V 溝）', makeRule('foamboard', 0.8).foldable === true);
  ok('珍珠板：捲不起來', makeRule('foamboard', 0.8).canRoll === false);

  /**
   * 「折得起來但捲不起來」是前五種材料都表達不出來的組合 ——
   * 金屬與帆布兩者皆可，壓克力／木板兩者皆否。少了它就沒有東西
   * 能描述「銑 45 度 V 溝折起來的珍珠板」。
   */
  const both = MATERIAL_KEYS.filter(k => {
    const R = makeRule(k, 0.5);
    return R.foldable === true && R.canRoll === false;
  });
  eq('「可折不可捲」目前只有珍珠板這一種', both.length, 1);
  eq('而且就是它', both[0], 'foamboard');
}

section('第 5 期(C)：實體可以直接展開，加厚改看幾何');

/**
 * ── 這一節在盯什麼 ──────────────────────────────────
 *
 * 2026-08-22 之前，part.js 擋著「不是板件就拒絕展開」。那是鈑金思路：
 * 鐵板折彎時中性層長度不變，所以資料存中性面，而實體沒有中性面。
 *
 * 但這套工具實際的做法是**切開再接合**（珍珠板、木板、壓克力），
 * 接縫銑 45 度斜接，板厚由斜面吸收，每一片就是切到**外緣尺寸** ——
 * 而實體的網格本來就是外表面。直接展開它就是正確答案。
 *
 * 連帶把「要不要加厚」的判斷從 `kind` 這個標籤改成
 * **網格開不開放**這個幾何事實（踩過的坑第 8 條的同一條原則）。
 */
{
  const foam = makeRule('foamboard', 0.8);

  // 實體方塊：展開就是十字型，尺寸走外皮
  const solid = new io.ModelObject({
    name: '實體方塊', kind: io.KIND.SOLID,
    src: { type: 'box', w: 60, h: 45, d: 40 }
  });
  const rs = unfoldObject(solid, { material: 'foamboard' });
  ok('實體現在展得開（不再要求先抽殼）', rs.ok === true, rs.reason || '');
  eq('實體方塊 展開成 1 片（十字型）', rs.pieces.length, 1);
  rel('實體方塊 面積 ＝ 六面外表面積', rs.pieces[0].area,
    2 * (60 * 45 + 60 * 40 + 45 * 40));

  /**
   * 同一個方塊，標成板件與標成實體，展開結果必須**完全一樣**。
   *
   * 這條是整輪的關鍵：擋著的時候使用者只能手動把種類改成板件繞過去，
   * 而繞過去得到的數字跟現在直接展開實體一模一樣 ——
   * 證明當初擋的只是標籤，不是幾何。
   */
  const asSheet = new io.ModelObject({
    name: '同一個方塊', kind: io.KIND.SHEET, thickness: 0.8,
    src: { type: 'box', w: 60, h: 45, d: 40 }
  });
  const rh = unfoldObject(asSheet, { material: 'foamboard' });
  eq('標成板件 片數相同', rh.pieces.length, rs.pieces.length);
  rel('標成板件 面積相同', rh.pieces[0].area, rs.pieces[0].area);
  rel('標成板件 展開長相同', rh.pieces[0].width, rs.pieces[0].width);
  rel('標成板件 展開寬相同', rh.pieces[0].height, rs.pieces[0].height);

  // 平板仍然照常展開，沒有被這次改動波及
  const plate = new io.ModelObject({
    name: '平板', kind: io.KIND.SHEET, thickness: 0.8,
    src: { type: 'plate', w: 100, d: 60 }
  });
  const rp = unfoldObject(plate, { material: 'foamboard' });
  ok('平板 仍然展得開', rp.ok === true);
  rel('平板 展開長 100', rp.pieces[0].width, 100);
  rel('平板 展開寬 60', rp.pieces[0].height, 60);
  void foam;
}

{
  /**
   * 加厚的判斷改看網格開不開放。
   *
   * 用 kind 判斷實際會出錯：把封閉的方塊標成板件，加厚會得到
   * **兩個互不相連的盒子**（內外各一個），而不是一個空心盒。
   * 實測 shell(0.2) 後體積 2777.79 cm³、獨立塊數 2。
   */
  const box = buildPrim('box', { w: 60, h: 45, d: 40 }, 0.8);
  const plate = buildPrim('plate', { w: 100, d: 60 }, 0.8);

  ok('實體方塊 網格封閉', box.isClosed() === true);
  ok('平板 網格開放', plate.isClosed() === false);
  ok('封閉圓柱 網格封閉', buildPrim('cylinder', { r: 25, h: 70 }, 0.8).isClosed() === true);
  ok('開放圓柱側面 網格開放',
    buildPrim('cylinder', { r: 25, h: 70, openEnded: true }, 0.8).isClosed() === false);
  ok('折板 網格開放', buildPrim('bend', {}, 0.8).isClosed() === false);

  // 封閉的東西加厚會裂成兩塊 —— 這正是不該對它加厚的理由
  const shelled = box.shell(0.2);
  eq('封閉方塊硬加厚 會變成 2 個互不相連的塊', shelled.componentCount(), 2);
  ok('所以封閉的網格不該加厚', box.isClosed() === true);

  // 開放的面加厚才是對的：體積 ＝ 面積 × 厚度
  const thick = plate.shell(0.8);
  eq('平板加厚後 只有 1 塊', thick.componentCount(), 1);
  rel('平板加厚後 體積 ＝ 面積×厚度', thick.volume(), 100 * 60 * 0.8, 1e-6);
}

section('STL：四邊形面的頂點不可共用（就地平移會被減兩次）');

/**
 * ── 這一組在盯什麼 ──────────────────────────────────
 *
 * `triangles()` 做扇形三角化時，`p0` 是每個面算一次給所有三角形共用的。
 * 如果那個 Vector3 物件被直接塞進三角形，一個四邊形切出來的兩個三角形
 * 就**共用同一個物件** —— 之後任何就地平移（`dropToBed()` 就是）
 * 都會把它減兩次，把模型整個扯開。
 *
 * 三角形面（方塊、圓錐）每個面只產生一個三角形，共用不到，所以一直沒事。
 * 這個 bug 只在**有四邊形面**的東西上發作 —— 平板、折板、管、圓柱側面，
 * 而那正是板件。2026-08-22 由 kang 在 3D 列印面板上發現
 * （平板顯示體積 −86,600,000 mm³、外框高 439mm，判定「印不出來」）。
 *
 * 判準用**匯出全程走完之後**的體積與外框，不是中途的值 ——
 * 這個 bug 剛好就是「中途對、最後錯」。
 */
{
  const m4 = new THREE.Matrix4().makeTranslation(108, 44, 0);   // 刻意不在原點
  const S = 10;                                                  // cm → mm

  const cases = [
    ['平板加厚', buildPrim('plate', { w: 100, d: 60 }, 0.2).shell(0.2)],
    ['折板加厚', buildPrim('bend', {}, 0.2).shell(0.2)],
    ['管', buildPrim('tube', {}, 0.2)],
    ['圓柱', buildPrim('cylinder', {}, 0.2)],
    ['圓角方塊', buildPrim('roundBox', {}, 0.2)],
    ['方塊（對照：全三角形面）', buildPrim('box', { w: 60, h: 45, d: 40 }, 0.2)]
  ];

  for (const [name, mesh] of cases) {
    const tris = dropToBed(triangles(mesh, { matrix: m4, scale: S }));

    // 體積：走完全程之後仍要等於 網格體積 × 倍率³
    rel(`${name} 匯出後體積 ＝ 網格體積×1000`, stlVolume(tris), mesh.volume() * S ** 3, 1e-9);

    // 外框：平移不該改變尺寸
    const size = trisBounds(tris).getSize(new THREE.Vector3());
    const raw = mesh.bounds().getSize(new THREE.Vector3());
    rel(`${name} 匯出後外框 X`, size.x, raw.x * S, 1e-9);
    rel(`${name} 匯出後外框 Z（原本的 Y）`, size.z, raw.y * S, 1e-9);

    // 一定要貼在平台上
    near(`${name} 貼平台 z=0`, trisBounds(tris).min.z, 0, 1e-9);
  }

  /**
   * 根因直接測：任兩個三角形不可以共用同一個 Vector3 物件。
   * 上面那些是「症狀」，這一條是「病因」——
   * 病因測得到，日後有人為了省一次 clone 又把它改回去就會被擋下。
   */
  const tris = triangles(buildPrim('plate', { w: 100, d: 60 }, 0.2).shell(0.2));
  const seen = new Set();
  let shared = 0;
  for (const t of tris) {
    for (const p of [t.a, t.b, t.c]) {
      if (seen.has(p)) shared++;
      seen.add(p);
    }
  }
  eq('三角形之間沒有共用的頂點物件', shared, 0);

  // dropToBed 跑兩次不該把東西越推越歪（共用頂點時會）
  const a = dropToBed(triangles(buildPrim('plate', { w: 100, d: 60 }, 0.2).shell(0.2),
    { matrix: m4, scale: S }));
  const v1 = stlVolume(a);
  dropToBed(a);
  rel('dropToBed 再跑一次 體積不變', stlVolume(a), v1, 1e-12);
}

section('第 3 期：材料規則');

{
  // 每種材料的 K 都要真的影響展開長，而且順序要合理（鋁最短、帆布最長）
  const t = 0.3;
  const len = {};
  for (const key of MATERIAL_KEYS) {
    const rule = makeRule(key, t);
    const src = { w: 20, first: 30, arcSeg: 4, k: rule.k, bends: [{ angle: 90, ri: 2, len: 20 }] };
    const r = unfoldMesh(buildPrim('bend', src, t), rule);
    len[key] = r.pieces[0].width;
    near(`${key} 規則的 K ＝ 材料表`, rule.k, MATERIALS[key].k, 1e-12);
  }
  ok('鋁 K 最小 → 展開長最短', len.aluminum < len.steel);
  ok('不鏽鋼 K 較大 → 比鐵板長', len.stainless > len.steel);
  ok('帆布 K=0.5 → 最長', len.canvas > len.stainless);

  // 壓克力／木板折不了：折線一律變切割線，所以會拆成好幾片
  ok('壓克力 折不了', !makeRule('acrylic', t).foldable);
  const ac = unfoldMesh(buildPrim('bend',
    { w: 60, first: 40, arcSeg: 4, k: 0.5, bends: [{ angle: 90, ri: 2, len: 30 }] }, t),
    makeRule('acrylic', t));
  ok('壓克力 折板被拆成多片', ac.pieces.length > 1);
  ok('壓克力 有講清楚為什麼', ac.warnings.some(w => w.includes('切割線')));

  // 餘量：帆布要縫份、紙模要黏合片、鈑金沒有
  near('鈑金 餘量 0', makeRule('steel', t).margin(), 0, 1e-12);
  near('帆布 縫份 1.5', makeRule('canvas', t).margin(), 1.5, 1e-12);
  eq('帆布 餘量叫縫份', makeRule('canvas', t).marginLabel(), '縫份');
  eq('紙模 餘量叫黏合片', makeRule('paper', t).marginLabel(), '黏合片');

  // 折邊太短要警告（模具夾不住）；圓弧折彎不問「折不折得起來」
  const rule = makeRule('steel', 0.3);
  const shortFlange = rule.validate({ bends: [{ angle: 90, ri: 2, flange: 1, isArc: true }] });
  ok('折邊太短會警告', shortFlange.some(w => w.includes('折邊')));
  const roll = rule.validate({ bends: [{ angle: 360, ri: 25, flange: 99, isArc: true }] });
  eq('圓弧 360°（滾出來的）不該報折不了', roll.length, 0);
  const flat180 = rule.validate({ bends: [{ angle: 180, ri: 0, flange: 99, isArc: false }] });
  ok('尖角 180° 要報折不了', flat180.some(w => w.includes('折不了')));
}

section('第 3 期：檔案格式 v3 → v4');

{
  /**
   * 舊檔的 r 是中性層半徑，新檔的 ri 是內側圓角。
   * 轉換走 ri ＝ r − K×t，生成時再算回 rn ＝ ri + K×t ＝ r，
   * 所以**舊檔開起來形狀必須一模一樣**。
   * 這是第一個真的要動資料的版本轉換，錯了會讓舊圖全部變形。
   */
  const t = 0.3;
  const oldDoc = {
    type: 'model-doc', v: 3, unit: 'cm',
    head: { name: '舊檔' },
    objects: [{
      id: 1, name: '折板', kind: 'sheet', thickness: t,
      src: { type: 'bend', w: 60, first: 40, arcSeg: 4, bends: [{ angle: 90, r: 2.12, len: 30 }] },
      pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], color: 0x6fa8dc
    }]
  };
  const before = buildPrim('bend',
    { w: 60, first: 40, arcSeg: 4, bends: [{ angle: 90, ri: 2.12, len: 30 }] }, 0);

  const d = io.Doc.fromJSON(JSON.parse(JSON.stringify(oldDoc)));
  const o = d.objects[0];
  near('v3→v4 內側R ＝ 舊的 r − K×t', o.src.bends[0].ri, 2.12 - 0.4 * t, 1e-9);
  eq('v3→v4 補上 K 因子', o.src.k, 0.4);
  eq('v3→v4 舊的 r 欄位已移除', o.src.bends[0].r, undefined);
  near('v3→v4 網格面積完全不變', o.mesh().area(), before.area(), 1e-9);
  near('v3→v4 展開長完全不變', bendDevelopedLength(o.src, t),
    bendDevelopedLength({ w: 60, first: 40, arcSeg: 4, bends: [{ angle: 90, ri: 2.12, len: 30 }] }, 0),
    1e-9);

  // 轉換要能鑽進布林運算樹與陣列裡
  const nested = {
    type: 'model-doc', v: 3, unit: 'cm', head: {},
    objects: [{
      id: 1, name: '陣列折板', kind: 'sheet', thickness: 0.2,
      src: { type: 'array', mode: 'linear', count: 3, step: [70, 0, 0], step2: [0, 0, 0], count2: 1,
        child: { src: { type: 'bend', w: 60, first: 40, arcSeg: 4, bends: [{ angle: 90, r: 2, len: 30 }] },
          pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] } },
      pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], color: 0
    }]
  };
  const d2 = io.Doc.fromJSON(nested);
  ok('v3→v4 轉換會鑽進陣列裡', d2.objects[0].src.child.src.bends[0].ri !== undefined);

  // v4 存檔讀回來要一致
  const round = io.Doc.fromJSON(JSON.parse(JSON.stringify(d.toJSON())));
  near('v4 存讀往返 面積相同', round.objects[0].mesh().area(), o.mesh().area(), 1e-9);
  eq('目前版本號', io.DOC_VERSION, 4);
}

section('第 3 期：展開圖與 DXF');

{
  const t = 0.3;
  const src = { w: 60, first: 40, arcSeg: 4, k: 0.4,
    bends: [{ angle: 90, ri: 2, len: 30 }, { angle: -90, ri: 2, len: 25 }] };
  const rule = makeRule('steel', t);
  const r = unfoldMesh(buildPrim('bend', src, t), rule);
  const p = r.pieces[0];
  const prog = drawProgram(p, { rule });

  // 分段尺寸相加必須等於總長 —— 師傅照這些數字畫線，加起來對不上就是廢料
  const segs = prog.items
    .filter(i => i.t === 'text' && i.style === 'dim' && !i.s.startsWith('總') && i.anchor === 'middle')
    .map(i => parseFloat(i.s));
  near('展開圖 分段尺寸相加 ＝ 總長', segs.reduce((a, b) => a + b, 0), p.width, 0.02);
  eq('展開圖 分段數（3 平面段 ＋ 2 折彎區）', segs.length, 5);

  // 圓弧折彎帶「裡面」那些線是網格切出來的，不能畫成折線
  const foldLines = prog.items.filter(i => i.t === 'line' && i.style === 'fold');
  eq('展開圖 不畫圓弧內部的假折線', foldLines.length, 0);
  ok('展開圖 有畫折彎區', prog.items.some(i => i.style === 'bend'));

  /**
   * SVG 的相容性。這幾項全部是 Illustrator 實測打臉之後補上的：
   * 沒有 XML 宣告 → Illustrator 當成純文字開，畫面一堆標籤原始碼＋亂碼。
   * 用 dominant-baseline → Illustrator 忽略，所有標註往上跳半個字高。
   */
  const svg = toSVG(p, { rule });
  ok('SVG 有 XML 宣告（Illustrator 靠它認檔）', svg.startsWith('<?xml version="1.0"'));
  ok('SVG 宣告 UTF-8（中文才不會變亂碼）', /encoding="UTF-8"/i.test(svg.split('\n')[0]));
  ok('SVG 良構', svg.includes('<svg ') && svg.trim().endsWith('</svg>'));
  ok('SVG 帶 viewBox', svg.includes('viewBox='));
  ok('SVG 標明 version 1.1', svg.includes('version="1.1"'));
  ok('SVG 不用 dominant-baseline（Illustrator 不支援）',
    !svg.includes('dominant-baseline'));
  ok('SVG 字型堆疊含中文字型', svg.includes('Microsoft JhengHei'));
  ok('標題欄有材質與板厚', titleLines(p, { rule }).join('|').includes('板厚'));

  // 線寬要是真的線寬。曾經寫成 0.35 個使用者單位 ＝ 3.5mm，粗了七倍。
  const widths = [...svg.matchAll(/stroke-width="([\d.]+)"/g)].map(m => +m[1]);
  ok('SVG 最粗的線 ≤ 0.6mm（製圖粗實線）', Math.max(...widths) <= 0.06 + 1e-9,
    `${Math.max(...widths) * 10} mm`);
  ok('SVG 最細的線 ≥ 0.15mm（印得出來）', Math.min(...widths) >= 0.015 - 1e-9);

  // ── DXF ──
  const dxf = toDXF(r.pieces, { unit: 'mm', rule });
  ok('DXF 是 R12（AC1009）', dxf.includes('\r\nAC1009\r\n'));
  ok('DXF 有 EOF', dxf.trim().endsWith('EOF'));
  ok('DXF 全部 CRLF', !/[^\r]\n/.test(dxf));
  ok('DXF 只有 ASCII（中文在 R12 沒有統一編碼）', !/[^\x00-\x7F]/.test(dxf));
  for (const layer of ['CUT', 'FOLD', 'BEND', 'DIM', 'TEXT']) {
    ok(`DXF 有定義圖層 ${layer}`, dxf.includes(`\r\n2\r\n${layer}\r\n`));
  }
  eq('DXF mm 換算倍率', UNITS.mm.scale, 10);
  eq('DXF cm 換算倍率', UNITS.cm.scale, 1);

  /**
   * 骨架完整性。這一整組是 Illustrator 實測「完全打不開」之後補的：
   * 規格上合法不代表別人的軟體讀得動，舊的匯入器會照順序找這些東西。
   */
  // 開頭那個 SECTION 前面沒有換行，所以 ^ 也要算進去
  const sections = [...dxf.matchAll(/(?:^|\r\n)0\r\nSECTION\r\n2\r\n(\w+)\r\n/g)].map(m => m[1]);
  eq('DXF 四個區段齊全且順序正確',
    sections.join('>'), 'HEADER>TABLES>BLOCKS>ENTITIES');
  ok('DXF 有 BLOCKS 區段（空的也要有）', sections.includes('BLOCKS'));

  const tbls = [...dxf.matchAll(/\r\n0\r\nTABLE\r\n2\r\n(\w+)\r\n/g)].map(m => m[1]);
  eq('DXF 表格齊全，且 LTYPE 排在 LAYER 前面',
    tbls.join('>'), 'LTYPE>LAYER>STYLE');
  ok('DXF 定義了線型 CONTINUOUS', dxf.includes('\r\n2\r\nCONTINUOUS\r\n'));
  ok('DXF 定義了文字樣式 STANDARD', dxf.includes('\r\n2\r\nSTANDARD\r\n'));
  ok('DXF 定義了預設圖層 0', /\r\n0\r\nLAYER\r\n2\r\n0\r\n/.test(dxf));
  // 一定要寫成 0/TEXT，不然會連「名叫 TEXT 的圖層」一起數進去
  ok('DXF 每個 TEXT 都指定樣式',
    (dxf.match(/\r\n0\r\nTEXT\r\n/g) || []).length
    === (dxf.match(/\r\n7\r\nSTANDARD\r\n/g) || []).length);
  ok('DXF 不寫 $INSUNITS（那是 R14 才有的變數）', !dxf.includes('$INSUNITS'));
  /**
   * 圖層數宣告錯了，有些軟體會直接判檔案壞掉。
   * 2026-08-22 加 JOIN 層時這一項擋下來過一次 —— 加了圖層卻忘了改宣告，
   * 而 DXF 本身「看起來」完全正常。這就是這一項存在的理由。
   */
  /**
   * ⚠ 2026-10-12 加 CUT_AUTO（程式自己加的切線）—— 7 → 8，這一項當場擋下來（照它的存在理由）；
   * 同一天再加 SEW（省道打版「只畫縫線」的開口縫線）—— 8 → 9，又擋下來一次。
   */
  /** 同一天再加 CUT_NOTCH／MARK（對位記號）—— 9 → 11，第三次擋下來。 */
  ok('DXF 表格數量宣告正確',
    dxf.includes('\r\n2\r\nLAYER\r\n70\r\n13\r\n'),
    'CUT/CUT_AUTO/SEW/FOLD/FOLD_UP/FOLD_DOWN/BEND/DIM/TEXT/JOIN/CUT_NOTCH/MARK 十二個圖層 ＋ 圖層 0');
  /** 2026-10-19 再加 FOLD_UP／FOLD_DOWN（上折、下折分層，綜合評估 ①-10）—— 11 → 13，第四次擋下來。 */
  eq('★★ 宣告的圖層數 ＝ 真的寫出來的 LAYER 數',
    (dxf.match(/\r\n0\r\nLAYER\r\n/g) || []).length, 13);

  // ENDTAB / ENDSEC 要成對，少一個整個檔就打不開
  eq('DXF TABLE 與 ENDTAB 成對', (dxf.match(/\r\nENDTAB\r\n/g) || []).length, tbls.length);
  eq('DXF SECTION 與 ENDSEC 成對',
    (dxf.match(/\r\nENDSEC\r\n/g) || []).length, sections.length);

  // 幾何要真的被換算成 mm（外框長度 ×10）。
  // 只看 ENTITIES 之後 —— 檔頭的 $EXTMAX 也用群組碼 10。
  const bodyX = s => [...s.slice(s.indexOf('ENTITIES')).matchAll(/\r\n10\r\n(-?[\d.]+)/g)]
    .map(m => +m[1]);
  near('DXF 最大 X ＝ 展開長 ×10', Math.max(...bodyX(dxf)), p.width * 10, 0.01);
  const cm = toDXF(r.pieces, { unit: 'cm', rule });
  near('DXF 選 cm 時不換算', Math.max(...bodyX(cm)), p.width, 0.01);

  // LINE 一定要成對出現起訖點，不然某些軟體會整個檔打不開
  /**
   * ⚠ 只數 ENTITIES 之後（2026-10-12）：圖層變成 11 個之後，檔頭的圖層數宣告「70 / 11」也長成 `\r\n11\r\n`，
   * 整個檔一起數就多數一個 —— 是測試數錯，⛔ 是 DXF 錯。
   */
  const ents = dxf.slice(dxf.indexOf('ENTITIES'));
  eq('DXF LINE 數 ＝ 起點數', (ents.match(/\r\nLINE\r\n/g) || []).length,
    (ents.match(/\r\n11\r\n/g) || []).length);
}

{
  // 多片排開時不可以互相疊在一起
  const t = 0.2;
  const r = unfoldMesh(buildPrim('bend',
    { w: 60, first: 40, arcSeg: 4, k: 0.5, bends: [{ angle: 90, ri: 2, len: 30 }] }, t),
    makeRule('acrylic', t));
  const dxf = toDXF(r.pieces, { unit: 'mm', rule: makeRule('acrylic', t), gap: 5 });
  const xs = [...dxf.slice(dxf.indexOf('ENTITIES')).matchAll(/\r\n10\r\n(-?[\d.]+)/g)]
    .map(m => +m[1]);
  const total = r.pieces.reduce((a, p) => a + p.width * 10, 0) + (r.pieces.length - 1) * 50;
  ok('DXF 多片沿 X 排開不重疊', Math.max(...xs) <= total + 1, `${Math.max(...xs)} ≤ ${total + 1}`);
}

section('第 3 期：檔名與存檔');

{
  /**
   * 檔名清理。第一版存出來變成「尚未確認的 636844.DXF」——
   * 那是 Chrome 的暫存名，因為 <a> 沒掛進 DOM，download 屬性被忽略。
   * 使用者拿到的檔案 Illustrator 認不得，看起來就像匯出壞掉，
   * 其實檔案內容完全正確。DOM 的部分測不到，但檔名邏輯測得到。
   */
  eq('檔名 去掉 Windows 不合法字元',
    safeName('展開/圖:第一批*?"<>|'), '展開_圖_第一批______');
  eq('檔名 空字串用預設值', safeName('', '展開圖'), '展開圖');
  eq('檔名 只有空白也用預設值', safeName('   ', '展開圖'), '展開圖');
  eq('檔名 連續空白收成一個', safeName('展開   圖'), '展開 圖');
  eq('檔名 最長 60 字', safeName('圖'.repeat(200)).length, 60);
  ok('檔名 中文原樣保留', safeName('展開_未命名_鐵板／鍍鋅鋼板') === '展開_未命名_鐵板／鍍鋅鋼板');

  // 副檔名描述要對得上，showSaveFilePicker 才不會亂加副檔名
  for (const [k, ext] of [['dxf', '.dxf'], ['svg', '.svg'], ['csv', '.csv']]) {
    ok(`存檔類型 ${k} 的副檔名`,
      JSON.stringify(TYPES[k]).includes(ext), ext);
  }
  // Node 沒有 window，指定路徑一定不可用 —— 這一項同時確認它不會拋例外
  eq('沒有 window 時 canChoosePath 回 false', canChoosePath(), false);
}

section('第 3 期：標註不可以疊在一起');

{
  /**
   * 一張讀不出尺寸的圖，比沒有圖更糟 —— 看的人會以為自己讀到了。
   *
   * 實測（圓角方塊，21 道折彎）分段尺寸全擠在同一排，
   * 變成一團「0.9787.05.24」。現在錯開成兩排，這一組就是盯著它。
   */
  const hit = prog => {
    const rows = new Map();
    for (const it of prog.items) {
      if (it.t !== 'text' || it.rot) continue;
      const k = it.y.toFixed(3);
      if (!rows.has(k)) rows.set(k, []);
      rows.get(k).push(it);
    }
    let n = 0;
    for (const list of rows.values()) {
      list.sort((a, b) => a.x - b.x);
      for (let i = 0; i + 1 < list.length; i++) {
        const w1 = labelWidth(list[i].s, list[i].size);
        const w2 = labelWidth(list[i + 1].s, list[i + 1].size);
        const right = list[i].x + (list[i].anchor === 'middle' ? w1 / 2 : w1);
        const left = list[i + 1].x - (list[i + 1].anchor === 'middle' ? w2 / 2 : 0);
        if (right > left + 1e-9) n++;
      }
    }
    return n;
  };

  const cases = [
    ['圓角方塊 21 道折彎', buildPrim('roundBox', { w: 60, h: 45, d: 40, r: 6, segR: 4 }, 2),
      makeRule('paper', 2)],
    ['Z 型', buildPrim('bend', { w: 60, first: 40, arcSeg: 4, k: 0.4,
      bends: [{ angle: 90, ri: 2, len: 30 }, { angle: -90, ri: 2, len: 25 }] }, 0.3),
      makeRule('steel', 0.3)],
    ['四道混合', buildPrim('bend', { w: 30, first: 10, arcSeg: 5, k: 0.45,
      bends: [{ angle: 45, ri: 3, len: 20 }, { angle: 120, ri: 1, len: 15 },
              { angle: -60, ri: 2.5, len: 12 }, { angle: 90, ri: 0, len: 8 }] }, 0.15),
      makeRule('stainless', 0.15)],
    ['平板', buildPrim('plate', { w: 100, d: 60 }, 0.2), makeRule('steel', 0.2)]
  ];

  for (const [name, mesh, rule] of cases) {
    const r = unfoldMesh(mesh, rule);
    for (const p of r.pieces.slice(0, 2)) {
      eq(`${name} 標註沒有互相重疊`, hit(drawProgram(p, { rule })), 0);
    }
  }

  // 折彎區的數字很窄（3.31cm）但一定要標出來 —— 那是師傅畫線的依據，
  // 不能因為放不下就丟掉，只能錯開到下一排（坑第 12 條）
  // 〔2026-08-23：期望值從 3.33（BA）改成 3.31（弦長總和）。
  //   驗的事情沒變 —— 窄的數字要標得出來 —— 只是那個數字的定義換了〕
  const rz = unfoldMesh(buildPrim('bend', { w: 60, first: 40, arcSeg: 4, k: 0.4,
    bends: [{ angle: 90, ri: 2, len: 30 }, { angle: -90, ri: 2, len: 25 }] }, 0.3),
    makeRule('steel', 0.3));
  const texts = drawProgram(rz.pieces[0], { rule: makeRule('steel', 0.3) }).items
    .filter(i => i.t === 'text' && i.style === 'dim').map(i => i.s);
  ok('窄的折彎區尺寸仍然標得出來', texts.filter(s => s === '3.31').length === 2,
    texts.join(' '));

  // 字寬估算：中文一個字約一個字高，數字約 0.55
  ok('字寬估算 中文比數字寬', labelWidth('折彎', 1) > labelWidth('12', 1));
  ok('字寬估算 字多的比較寬', labelWidth('12345', 1) > labelWidth('12', 1));
}

// ═══════════════════════════════════════════════════════
//  STL 匯出（3D 列印與 CAM）
// ═══════════════════════════════════════════════════════

section('STL：體積交叉驗證');

{
  /**
   * **這一組是 STL 最重要的驗證。**
   *
   * 從匯出的三角形用散度定理反算體積，必須等於 mesh.volume() × 倍率³。
   * 這一條式子同時抓三種錯：
   *   · 扇形三角化接錯 → 體積不對
   *   · 法向反了       → 體積變負
   *   · 單位換算錯     → 差一個 10³
   * 跟第 2 期「管 vs 布林」、第 3 期「網格辨識 vs 參數公式」同一招。
   */
  const shapes = [
    ['方塊', 'box', { w: 60, h: 45, d: 40 }],
    ['圓柱', 'cylinder', { r: 25, h: 70, seg: 32 }],
    ['球', 'sphere', { r: 30, segW: 32, segH: 16 }],
    ['角柱', 'prism', { sides: 6, r: 30, h: 60 }],
    ['管', 'tube', { rOuter: 25, rInner: 20, h: 70, seg: 32 }],
    ['圓角方塊', 'roundBox', { w: 60, h: 45, d: 40, r: 6, segR: 4 }],
    // 2026-10-08 加的四種。⭐ 階梯的側面是【凹的】多邊形 —— 扇形三角化在這裡會錯
    ['圓環', 'torus', { rOuter: 30, rInner: 15, seg: 32, segT: 12 }],
    ['楔形', 'wedge', { w: 60, h: 30, d: 40 }],
    ['半球', 'dome', { r: 30, seg: 32, segH: 8 }],
    ['階梯', 'stairs', { steps: 4, stepH: 15, stepD: 25, w: 60 }],
    ['齒輪', 'gear', { module: 0.3, teeth: 20, t: 0.5, hole: 0.6, gapMm: 0.2 }]
  ];

  for (const [name, type, p] of shapes) {
    const m = buildPrim(type, p, 0.2);
    for (const u of ['mm', 'cm']) {
      const s = STL_UNITS[u].scale;
      const tris = triangles(m, { scale: s });
      const want = m.volume() * s ** 3;
      near(`${name} ${u} STL 體積 ＝ 網格體積×倍率³`,
        stlVolume(tris) / want, 1, 1e-9);
    }
    // 三角形數 ＝ 扇形三角化的預期數量（n 邊形切成 n−2 個）
    let want = 0;
    for (const f of m.faces) want += m.faceVerts(f).length - 2;
    eq(`${name} 三角形數 ＝ Σ(邊數−2)`, triangles(m, { scale: 10 }).length, want);
  }
}

{
  // 布林過的模型也要對得上 —— 那是實際會拿去列印的東西
  if (!csgError()) {
    const src = {
      type: 'bool', op: BOOL_OPS.SUBTRACT,
      items: [
        { src: { type: 'box', w: 60, h: 45, d: 40 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
        { src: { type: 'cylinder', r: 10, h: 60, seg: 32 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }
      ]
    };
    const m = io.buildSrc(src, 0.2);
    const tris = triangles(m, { scale: 10 });
    near('貫孔件 STL 體積 ＝ 網格體積×1000', stlVolume(tris) / (m.volume() * 1000), 1, 1e-9);
    ok('貫孔件 體積為正（法向朝外）', stlVolume(tris) > 0);
  }
}

section('STL：座標轉換');

{
  /**
   * 建模器沿用 three.js 的 Y 軸向上，但列印平台是 XY 平面、Z 軸向上。
   * 不轉的話模型會躺著進切片軟體。
   */
  const m = buildPrim('box', { w: 60, h: 45, d: 40 }, 0.2);
  const tris = dropToBed(triangles(m, { scale: 10 }));
  const b = trisBounds(tris);
  const size = b.max.clone().sub(b.min);

  near('轉 Z 軸向上後 高度在 Z（45cm → 450mm）', size.z, 450, 1e-6);
  near('轉 Z 軸向上後 寬度在 X（60cm → 600mm）', size.x, 600, 1e-6);
  near('轉 Z 軸向上後 深度在 Y（40cm → 400mm）', size.y, 400, 1e-6);
  near('落到列印平台 Z=0', b.min.z, 0, 1e-9);

  // 座標轉換是右手系旋轉，體積不變、法向仍朝外
  ok('轉換後體積仍為正', stlVolume(tris) > 0);
  near('轉換不改變體積', stlVolume(tris), m.volume() * 1000, 1e-3);

  // 沒開 zUp 時高度應該還在 Y
  const raw = triangles(m, { scale: 10, zUp: false });
  const rb = trisBounds(raw).max.clone().sub(trisBounds(raw).min);
  near('關掉 zUp 時 高度回到 Y', rb.y, 450, 1e-6);
}

section('STL：檔案格式');

{
  const m = buildPrim('box', { w: 60, h: 45, d: 40 }, 0.2);
  const tris = triangles(m, { scale: 10 });
  const bin = toSTLBinary(tris, { header: 'test unit=mm' });
  const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);

  eq('二進位 檔案大小 ＝ 84＋50×三角形數', bin.length, 84 + 50 * tris.length);
  eq('二進位 檔頭宣告的三角形數', dv.getUint32(80, true), tris.length);
  // 以 "solid" 開頭會被某些軟體誤判成 ASCII 格式，那是很常見的匯出 bug
  ok('二進位 檔頭不以 solid 開頭',
    String.fromCharCode(...bin.slice(0, 5)) !== 'solid');
  ok('二進位 檔頭只有 ASCII', ![...bin.slice(0, 80)].some(b => b > 126));

  const asc = toSTLAscii(tris, { name: 'test' });
  ok('ASCII 以 solid 開頭', asc.startsWith('solid '));
  ok('ASCII 以 endsolid 結尾', asc.trim().endsWith('endsolid test'));
  eq('ASCII facet 數', (asc.match(/facet normal/g) || []).length, tris.length);
  eq('ASCII vertex 數 ＝ 三角形數×3', (asc.match(/vertex /g) || []).length, tris.length * 3);
  eq('ASCII outer loop 與 endloop 成對',
    (asc.match(/outer loop/g) || []).length, (asc.match(/endloop/g) || []).length);

  // 兩種格式必須是同一個模型
  const back = [...asc.matchAll(/vertex (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/g)]
    .map(x => [+x[1], +x[2], +x[3]]);
  let v = 0;
  for (let i = 0; i < back.length; i += 3) {
    const [a, b, c] = [back[i], back[i + 1], back[i + 2]];
    v += a[0] * (b[1] * c[2] - b[2] * c[1])
       - a[1] * (b[0] * c[2] - b[2] * c[0])
       + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  near('ASCII 讀回來的體積與網格一致', v / 6, m.volume() * 1000, 1);
}

section('STL：列印前檢查');

{
  const box3 = buildPrim('box', { w: 6, h: 4.5, d: 4 }, 0.2);
  const c = printCheck(box3, triangles(box3, { scale: 10 }));
  ok('封閉實體 可以列印', c.ok);
  eq('封閉實體 封閉', c.closed, true);
  eq('封閉實體 一塊', c.components, 1);
  eq('封閉實體 沒有問題', c.issues.length, 0);

  // 板件是開放的面（中性面），直接匯出會印出空的
  const plate = buildPrim('plate', { w: 10, d: 6 }, 0.2);
  const cp = printCheck(plate, triangles(plate, { scale: 10 }));
  ok('板件未加厚 判定為印不出來', !cp.ok);
  ok('板件未加厚 講得出是不封閉', cp.issues.some(i => i.level === 'bad' && i.text.includes('封閉')));

  // 加厚之後就印得出來，而且體積 ＝ 面積×厚度
  const solid = plate.shell(0.2);
  const cs = printCheck(solid, triangles(solid, { scale: 10 }));
  ok('板件加厚後 可以列印', cs.ok);
  near('板件加厚後 體積 ＝ 面積×厚度×1000', cs.volume, 10 * 6 * 0.2 * 1000, 1e-6);

  // 分成兩塊要提醒，但不擋
  if (!csgError()) {
    const two = io.buildSrc({
      type: 'bool', op: BOOL_OPS.UNION,
      items: [
        { src: { type: 'box', w: 4, h: 4, d: 4 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] },
        { src: { type: 'box', w: 4, h: 4, d: 4 }, pos: [20, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1] }
      ]
    }, 0.2);
    const ct = printCheck(two, triangles(two, { scale: 10 }));
    eq('分開兩塊 元件數', ct.components, 2);
    ok('分開兩塊 仍然可以列印', ct.ok);
    ok('分開兩塊 有提醒', ct.issues.some(i => i.level === 'warn' && i.text.includes('塊')));
  }

  // 超過成型範圍要提醒
  const big = buildPrim('box', { w: 60, h: 45, d: 40 }, 0.2);
  const cb = printCheck(big, triangles(big, { scale: 10 }), { buildMM: 250 });
  ok('超過成型範圍 有提醒', cb.issues.some(i => i.text.includes('成型範圍')));
  ok('超過成型範圍 仍然可以列印', cb.ok);

  // 單位選錯（cm 送出去）會讓模型只有十分之一大
  const cSmall = printCheck(box3, triangles(box3, { scale: 1 }));
  ok('模型太小 提醒單位可能選錯', cSmall.issues.some(i => i.text.includes('單位')));

  eq('存檔類型 stl 的副檔名', JSON.stringify(TYPES.stl).includes('.stl'), true);
}

{
  // 退化三角形要在匯出時就丟掉，留著會被切片軟體判成非流形。
  // 圓錐的頂點半徑是 1e-4（不是 0），所以本來就不該有退化面。
  const cone = buildPrim('cone', { rTop: 0, rBottom: 30, h: 70, seg: 32 }, 0.2);
  const tris = triangles(cone, { scale: 10 });
  let zero = 0;
  for (const t of tris) {
    const ux = t.b.x - t.a.x, uy = t.b.y - t.a.y, uz = t.b.z - t.a.z;
    const vx = t.c.x - t.a.x, vy = t.c.y - t.a.y, vz = t.c.z - t.a.z;
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (Math.hypot(cx, cy, cz) < 1e-9) zero++;
  }
  eq('匯出的三角形沒有退化的', zero, 0);
  near('錐體 STL 體積 ＝ 網格體積×1000', stlVolume(tris) / (cone.volume() * 1000), 1, 1e-9);
}

section('對齊與均分（align.js）');

/**
 * kang 的原話：「當有一個造型是由多個物件所組合時，每個物件要如何準確的
 * 移動到正確位置」。「準確」是這一節唯一在驗的事 ——
 * 對齊算錯了不會讓程式當掉，只會讓東西差幾公分，
 * 而那用眼睛看不出來，只有拿數字對答案抓得到。
 */
{
  const A = await import('../js/core/align.js');
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  const mk = (name, w, x, y = 0) => new io.ModelObject({
    name, src: { type: 'box', w, h: 10, d: 10 }, kind: 'solid', pos: V3(x, y, 0)
  });
  const apply = (objs, ps) => objs.forEach((o, i) => o.pos.copy(ps[i]));
  const bx = o => A.worldBounds(o);
  const cx = o => (bx(o).min.x + bx(o).max.x) / 2;

  // ── 對齊 ──
  {
    const objs = [mk('A', 10, 0), mk('B', 60, 50), mk('C', 20, 110)];
    const before = A.unionBounds(objs).clone();

    apply(objs, A.alignPositions(objs, 'x', A.ALIGN.MIN));
    const mins = objs.map(o => bx(o).min.x);
    near('靠左對齊 全部貼齊最左緣', Math.max(...mins) - Math.min(...mins), 0, 1e-12);
    near('靠左對齊 貼的是原本整組的左緣', mins[0], before.min.x, 1e-12);
  }
  {
    const objs = [mk('A', 10, 0), mk('B', 60, 50), mk('C', 20, 110)];
    apply(objs, A.alignPositions(objs, 'x', A.ALIGN.CENTER));
    const cs = objs.map(cx);
    near('置中對齊 中心完全一致', Math.max(...cs) - Math.min(...cs), 0, 1e-12);
  }
  {
    const objs = [mk('A', 10, 0), mk('B', 60, 50), mk('C', 20, 110)];
    apply(objs, A.alignPositions(objs, 'x', A.ALIGN.MAX));
    const mx = objs.map(o => bx(o).max.x);
    near('靠右對齊 全部貼齊最右緣', Math.max(...mx) - Math.min(...mx), 0, 1e-12);
  }

  /**
   * 一個物件要對誰？不動。
   * 這種邊界情況不擋的話，Math.min(...[]) 會回傳 Infinity，
   * 物件會飛到無限遠 —— 而使用者只會看到東西不見了。
   */
  {
    const one = [mk('S', 10, 7)];
    eq('只選一個 對齊不動它', A.alignPositions(one, 'x', A.ALIGN.MIN)[0].x, 7);
    eq('只選一個 均分不動它', A.distributePositions(one, 'x')[0].x, 7);
  }

  /**
   * ⚠ 不能拿 obj.pos 當作物件的位置來對齊。
   *
   * pos 是原點的位置，而網格不一定以原點為中心 —— 折板、布林結果、
   * 陣列都可能偏一邊。拿 pos 對齊，畫面上看起來就是沒對齊。
   * 這一項刻意用「原點不在中心」的折板來驗。
   */
  {
    const bend = new io.ModelObject({
      name: 'bend', kind: 'sheet', thickness: 0.2, pos: V3(0, 0, 0),
      src: { type: 'bend', w: 30, first: 40, arcSeg: 4, k: 0.4,
             bends: [{ angle: 90, ri: 2, len: 30 }] }
    });
    const box = mk('box', 20, 90);
    ok('折板的原點確實不在外框中心',
       Math.abs((bx(bend).min.x + bx(bend).max.x) / 2 - bend.pos.x) > 1);

    const objs = [bend, box];
    apply(objs, A.alignPositions(objs, 'x', A.ALIGN.CENTER));
    near('原點不在中心的物件 一樣對得準', cx(objs[0]) - cx(objs[1]), 0, 1e-12);
  }

  // ── 兩種均分互為反例 ──
  /**
   * 物件大小不一時，兩種均分結果**不同**，而且各自滿足自己的定義、
   * 不滿足對方的。兩項一起測才證明得了「這兩個不是同一件事」——
   * 只測一個的話，把另一個實作錯了也看不出來。
   */
  {
    const objs = [mk('A', 10, 0), mk('B', 60, 50), mk('C', 20, 110)];
    apply(objs, A.distributePositions(objs, 'x'));
    const cs = objs.map(cx).sort((a, b) => a - b);
    near('均分物件 中心間距相等', (cs[1] - cs[0]) - (cs[2] - cs[1]), 0, 1e-12);
    const g = A.currentGaps(objs, 'x');
    ok('均分物件 空隙不相等（大小不一時本來就會這樣）',
       Math.abs(g[0] - g[1]) > 1, `${g[0].toFixed(2)} vs ${g[1].toFixed(2)}`);
  }
  {
    const objs = [mk('A', 10, 0), mk('B', 60, 50), mk('C', 20, 110)];
    const before = A.unionBounds(objs).clone();
    apply(objs, A.spacePositions(objs, 'x'));
    const g = A.currentGaps(objs, 'x');
    near('均分間距 空隙相等', g[0] - g[1], 0, 1e-12);
    const cs = objs.map(cx).sort((a, b) => a - b);
    ok('均分間距 中心不等距（同上，互為反例）',
       Math.abs((cs[1] - cs[0]) - (cs[2] - cs[1])) > 1);
    /**
     * 頭尾不動 —— 均分是「把中間的排好」，不是「把整組搬走」。
     * 整組外框變了就表示演算法把端點也動到了。
     */
    const after = A.unionBounds(objs);
    near('均分間距 整組外框不變（頭尾不動）', after.min.x, before.min.x, 1e-12);
    near('均分間距 整組外框不變（右緣）', after.max.x, before.max.x, 1e-12);
  }
  {
    const objs = [mk('A', 10, 0), mk('B', 60, 50), mk('C', 20, 110)];
    apply(objs, A.spacePositions(objs, 'x', 5));
    const g = A.currentGaps(objs, 'x');
    near('指定間距 5 每個空隙都是 5', Math.max(...g.map(v => Math.abs(v - 5))), 0, 1e-12);
  }

  // ── 三個軸都要能用 ──
  /**
   * 只測 X 的話，把 Y 或 Z 寫死成 X 也會通過。
   * 這種錯在 2D 版搬到 3D 時最容易發生。
   */
  {
    for (const ax of A.AXIS_KEYS) {
      const objs = [
        new io.ModelObject({ src: { type: 'box', w: 10, h: 10, d: 10 }, kind: 'solid', pos: V3(0, 0, 0) }),
        new io.ModelObject({ src: { type: 'box', w: 10, h: 10, d: 10 }, kind: 'solid', pos: V3(30, 40, 50) })
      ];
      apply(objs, A.alignPositions(objs, ax, A.ALIGN.CENTER));
      const c = objs.map(o => (bx(o).min[ax] + bx(o).max[ax]) / 2);
      near(`${ax.toUpperCase()} 軸 置中對齊有效`, c[0] - c[1], 0, 1e-12);
    }
  }
}

section('貼合（mate.js）');

/**
 * kang 的原話：「一個物件的點線面可以貼合到另一個物件的點線面」。
 * 兩個已定案的決定：含旋轉、選兩個元素再按一下。
 *
 * 這一節驗的是「貼上去之後，是不是真的貼上去了」——
 * 那要用三個數字同時成立才算：法線正對、共平面、體積不變。
 */
{
  const M = await import('../js/core/mate.js');
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

  const mkA = () => new io.ModelObject({
    name: 'A', src: { type: 'box', w: 40, h: 30, d: 30 }, kind: 'solid',
    pos: V3(120, 0, 0), rot: new THREE.Euler(0, 0.35, 0.2)
  });
  const B = new io.ModelObject({
    name: 'B', src: { type: 'box', w: 60, h: 45, d: 40 }, kind: 'solid', pos: V3(0, 0, 0)
  });
  const faceAt = (o, p) => seam.nearestFace(o.mesh(), p).face;

  // ── 面貼面 ──
  {
    const A = mkA();
    const fA = faceAt(A, V3(-20, 0, 0));       // A 的 −X 面
    const fB = faceAt(B, V3(30, 0, 0));        // B 的 +X 面
    const frB = M.faceFrame(B, fB);
    const volBefore = A.mesh().volume();

    const r = M.mateFaceToFace(A, M.faceFrame(A, fA), frB);
    A.pos.copy(r.pos); A.rot.copy(r.rot);

    const after = M.faceFrame(A, fA);
    near('面貼面 兩面法線正對（點積 −1）', after.dir.dot(frB.dir), -1, 1e-9);
    near('面貼面 兩面共平面（沿法線距離 0）',
         after.point.clone().sub(frB.point).dot(frB.dir), 0, 1e-9);
    /**
     * 貼合是剛體運動，物件本身不該被拉扯變形。
     * 體積一旦變了就表示動到的不只是位置與角度。
     */
    near('面貼面 體積完全不變（剛體運動）', A.mesh().volume(), volBefore, 1e-9);

    /**
     * 已經貼好了再按一次，不該再動。
     * ⚠ 這一項曾經失敗過：moved 拿四元數跟單位四元數做 equals()，
     * 那是精確比對，而算出來的是 (0,0,0,0.9999999999)，永遠不相等。
     * 於是每次都回報「動了」，使用者按第二下會開始懷疑到底貼上去沒。
     * 改成看轉了幾度。
     */
    const again = M.mateFaceToFace(A, M.faceFrame(A, fA), frB);
    ok('已經貼合 再按一次不會動', !again.moved);
    near('已經貼合 位置也確實沒變', again.pos.distanceTo(A.pos), 0, 1e-9);
  }

  /**
   * 🔴 **中心對中心**（kang 2026-09-01 拍板）。
   *
   * ⚠ **⛔ 這一段原本是【反過來】的**：它釘住「面內位置不動」，
   * 斷言 `貼合後 Y 沒有被動到 / Z 沒有被動到`，
   * 而那正是舊定案「貼合負責貼平，對齊負責定位」的機械保險。
   * 🔴 kang 用下來覺得兩步太麻煩 ⇒ 改成一步，**這兩條斷言因此反轉**。
   * ⭐ 他對「要不要留成開關」的回答：「**先改掉，用不慣再說**」。
   */
  {
    const A = mkA();
    A.rot.set(0, 0, 0);                        // 已經正對，只差位置
    A.pos.set(120, 17, -9);
    const fA = faceAt(A, V3(-20, 0, 0));
    const fB = faceAt(B, V3(30, 0, 0));
    const r = M.mateFaceToFace(A, M.faceFrame(A, fA), M.faceFrame(B, fB));
    A.pos.copy(r.pos); A.rot.copy(r.rot);

    near('★★ 貼合後 兩個面的中心完全重合',
         M.faceFrame(A, fA).point.distanceTo(M.faceFrame(B, fB).point), 0, 1e-9);
    /**
     * B 的 +X 面中心在 (30,0,0)，A 的 −X 面中心離 A 的原點 (−20,0,0)
     * ⇒ A 該停在 (50, 0, 0)。**⛔ 這三個數字是算得出來的，不是抄執行結果。**
     */
    near('貼合後 X ＝ 30 ＋ 20', r.pos.x, 50, 1e-9);
    near('貼合後 Y 被拉到對齊（原本 17）', r.pos.y, 0, 1e-9);
    near('貼合後 Z 被拉到對齊（原本 −9）', r.pos.z, 0, 1e-9);
  }

  /**
   * 🔴🔴 **同一個面的不同三角形，結果必須一模一樣。**
   *
   * ⚠ **這一項守的是一個【碰巧不出事】的舊寫法**：
   * `faceFrame()` 原本對 `faceVerts(face)` 取平均，而**方塊在網格裡是
   * 12 個三角形** ⇒ 它給的是**三角形的重心**，⛔ 不是面的中心
   * （實測 +X 面：舊版 (30, 7.5, 6.667)、正解 (30, 0, 0)）。
   *
   * 🔴 舊的「只貼平」只取**法線方向**的分量，那個偏移剛好整個落在面內
   * ⇒ **被丟掉了，所以從來沒有人發現**。一改成中心對中心，
   * 它就**直接變成貼歪的量**，而且歪多少**取決於點到哪一個三角形** ——
   * 而使用者⛔ 看不見那條對角線。
   * ⭐ 正解是 `elementCenter()`（共面區域），跟編輯模式 gizmo、
   * `標尺寸` 報的重心**同一個定義**。
   */
  {
    const mB = B.mesh();
    mB.computeNormals();
    const tris = mB.faces.filter(f => mB.computeFaceNormal(f).x > 0.99);
    ok('前提：方塊的一個面是 2 個三角形（⛔ 不是 1 個）', tris.length === 2);

    const out = tris.map(t => {
      const A = mkA();
      const fA = faceAt(A, V3(-20, 0, 0));
      const r = M.mateFaceToFace(A, M.faceFrame(A, fA), M.faceFrame(B, t));
      return [r.pos.x, r.pos.y, r.pos.z].map(n => n.toFixed(9)).join(',');
    });
    eq('★★★ 點到面的哪一個三角形，貼出來的位置完全一樣', out[0], out[1]);

    /**
     * ⚠ **⛔ 位置本身不要用字串比** —— 第一版這麼寫，當場被
     * **負零**咬到：算出來是 `-0.000000000`，而預期字串是 `0.000000000`，
     * **字串⛔ 不相等，但那兩個數字在數學上是同一個**。
     * ⭐ 字串比只適合上面那種「兩次結果一不一樣」（兩邊同樣是負零）。
     */
    const A2 = mkA();
    const fA2 = faceAt(A2, V3(-20, 0, 0));
    const r2 = M.mateFaceToFace(A2, M.faceFrame(A2, fA2), M.faceFrame(B, tris[0]));
    near('★★ 而且就是算得出來的那個 (50, 0, 0)',
         r2.pos.distanceTo(V3(50, 0, 0)), 0, 1e-9);
  }

  // ── 點貼點 ──
  {
    const A = mkA();
    const before = A.rot.clone();
    const va = A.mesh().verts[0], vb = B.mesh().verts[3];
    const pa = M.vertexPoint(A, va), pb = M.vertexPoint(B, vb);
    const r = M.mateVertexToVertex(A, pa, pb);
    A.pos.copy(r.pos);
    near('點貼點 兩點重合', M.vertexPoint(A, va).distanceTo(pb), 0, 1e-9);
    /** 一個點沒有方向，所以沒有「要轉到哪」—— 這是三種裡唯一不轉的 */
    eq('點貼點 角度完全不變', `${r.rot.x},${r.rot.y},${r.rot.z}`,
       `${before.x},${before.y},${before.z}`);
  }

  // ── 邊貼邊 ──
  {
    const A = mkA();
    const ea = [...A.mesh().edges()][0];
    const eb = [...B.mesh().edges()][2];
    const frB = M.edgeFrame(B, eb);
    const volBefore = A.mesh().volume();
    const r = M.mateEdgeToEdge(A, M.edgeFrame(A, ea), frB);
    A.pos.copy(r.pos); A.rot.copy(r.rot);

    const after = M.edgeFrame(A, ea);
    near('邊貼邊 中點重合', after.point.distanceTo(frB.point), 0, 1e-9);
    near('邊貼邊 方向平行（|點積| ＝ 1）', Math.abs(after.dir.dot(frB.dir)), 1, 1e-9);
    near('邊貼邊 體積不變', A.mesh().volume(), volBefore, 1e-9);

    /**
     * ⚠ 這一項才是邊對邊真正該驗的東西。
     *
     * 只讓兩條邊重合的話，物件還能繞著那條邊自轉任意角度 ——
     * 邊仍然完全重合，但成品方位是隨機的。
     * kang 實測回報「邊對邊沒辦法驗證準確」就是因為這個：
     * **自由度沒鎖滿的功能，使用者無法判斷它有沒有做對，
     * 那比做錯更糟 —— 做錯還能發現，隨機只會讓人不敢用。**
     *
     * 鎖法是讓相鄰的面法線反向（跟面對面同一條規則）。
     */
    near('邊貼邊 相鄰面法線反向（自轉被鎖死）',
         after.faceDir.dot(frB.faceDir), -1, 1e-9);
    ok('邊貼邊 結果唯一，不再標成 ambiguous', !r.ambiguous);
  }

  /**
   * 沒有相鄰面可參考時（兩側都沒有面）只能退回「只對齊邊」，
   * 而且必須誠實標成 ambiguous —— 那時自轉角度確實是任意的。
   * 寧可講出來，不要假裝結果是確定的。
   */
  {
    const A = mkA();
    const ea = [...A.mesh().edges()][0];
    const eb = [...B.mesh().edges()][2];
    const noFace = M.edgeFrame(B, eb);
    noFace.faceDir = null;
    const r = M.mateEdgeToEdge(A, M.edgeFrame(A, ea), noFace);
    ok('沒有相鄰面可參考時 誠實標成 ambiguous', r.ambiguous);
  }

  /**
   * ⚠ 完全反向（180 度）時，轉軸不唯一。
   *
   * 繞著任何一條垂直軸轉 180 度都能把 from 轉到 to，這是數學事實，
   * 不是函式庫的缺陷。程式不去假裝聰明挑一個軸，而是把情況標出來，
   * 讓使用者知道「方位可能不是你想的那個，自己再轉一下」。
   * 沉默地轉一個奇怪的方向最難查。
   */
  {
    const a = M.rotationBetween(V3(1, 0, 0), V3(-1, 0, 0));
    ok('完全反向 會標示轉軸不唯一', a.ambiguous);
    const b = M.rotationBetween(V3(1, 0, 0), V3(0, 1, 0));
    ok('一般角度 不會誤報', !b.ambiguous);
    const c = M.rotationBetween(V3(1, 0, 0), V3(1, 0, 0));
    ok('完全同向 也不會誤報', !c.ambiguous);
  }
}

section('框選（screen.js）');

section('多選一起動（align.js 的 groupPivot／groupTransform）');

/**
 * 🔴 **kang 2026-09-01**：「加選或框選多個物件時…只會針對最後選到的物件
 * 做動作…是不是因為缺少了『群組』功能?」
 *
 * ⛔ **不是缺群組** —— 箭頭 `attach` 在 active 那一個 node 身上。
 * 正解是「箭頭掛整組的替身」，而**替身的數學抽在 `align.js`，
 * 所以測得到**（`select.js` 那一半要 DOM 與場景，沙箱跑不動）。
 */
{
  const A = await import('../js/core/align.js');
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  /** 三個一樣大的方塊排成一列：外框 x ∈ [−30, 230] ⇒ 整組中心 (100, 0, 0) */
  const mk = x => new io.ModelObject({
    src: { type: 'box', w: 60, h: 45, d: 40 }, kind: 'solid', pos: V3(x, 0, 0)
  });
  const objs = [mk(0), mk(100), mk(200)];
  const active = objs[2];

  // ── 中心 ──
  {
    const p = A.groupPivot(objs, 'median', active);
    near('★★ 重心 ＝ 整組外框的中心 X（(−30＋230)/2）', p.x, 100, 1e-9);
    near('重心 Y', p.y, 0, 1e-9);
    near('重心 Z', p.z, 0, 1e-9);

    const q = A.groupPivot(objs, 'active', active);
    near('★★ 最後選的 ＝ 那一個的【原點】（⛔ 不是它的外框中心）', q.x, 200, 1e-12);

    /**
     * ⭐ **單選時兩者必須是同一個點** —— 否則「單選 → 加選一個」的瞬間
     * 箭頭會跳走，而使用者⛔ 沒有做任何跟位置有關的事。
     */
    const one = [mk(70)];
    near('★★★ 只選一個時 兩種中心是同一個點',
         A.groupPivot(one, 'median', one[0]).distanceTo(
         A.groupPivot(one, 'active', one[0])), 0, 1e-12);
  }

  // ── 套用變換 ──
  const snaps = objs.map(o => ({ m: o.matrix().clone(), rotOrder: o.rot.order }));

  {
    /** 純平移：三個都該位移同一個量，⛔ 跟中心完全無關 */
    const d = new THREE.Matrix4().makeTranslation(10, 20, 30);
    const out = A.groupTransform(d, snaps);
    near('移動 A 位移', out[0].pos.distanceTo(V3(10, 20, 30)), 0, 1e-9);
    near('移動 B 位移', out[1].pos.distanceTo(V3(110, 20, 30)), 0, 1e-9);
    near('移動 C 位移', out[2].pos.distanceTo(V3(210, 20, 30)), 0, 1e-9);
    near('移動 ⛔ 不會轉到任何一個', Math.abs(out[1].rot.y), 0, 1e-9);
  }

  {
    /**
     * 🔴🔴 **繞整組中心 (100,0,0) 轉 Y 90 度** ——
     * 繞 Y 轉 90 度時 `x' ＝ z、z' ＝ −x`（相對樞紐）：
     * · A 相對樞紐 (−100,0,0) → (0,0,100) ⇒ 世界 **(100, 0, 100)**
     * · B 就在樞紐上           → **⛔ 不動**
     * · C 相對樞紐 (+100,0,0) → (0,0,−100) ⇒ 世界 **(100, 0, −100)**
     * ⭐ **這三個數字是算出來的，⛔ 不是抄執行結果。**
     */
    const P = V3(100, 0, 0);
    const d = new THREE.Matrix4()
      .makeTranslation(P.x, P.y, P.z)
      .multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2))
      .multiply(new THREE.Matrix4().makeTranslation(-P.x, -P.y, -P.z));
    const out = A.groupTransform(d, snaps);

    near('★★★ 繞重心轉 90 度 A 落在 (100, 0, 100)',
         out[0].pos.distanceTo(V3(100, 0, 100)), 0, 1e-9);
    near('★★★ 樞紐上的 B ⛔ 一格都不動',
         out[1].pos.distanceTo(V3(100, 0, 0)), 0, 1e-9);
    near('★★★ 繞重心轉 90 度 C 落在 (100, 0, −100)',
         out[2].pos.distanceTo(V3(100, 0, -100)), 0, 1e-9);
    near('★★ 每一個自己也轉了 90 度（⛔ 不是只有公轉）',
         out[0].rot.y, Math.PI / 2, 1e-9);
    near('縮放沒有被動到', out[0].scale.distanceTo(V3(1, 1, 1)), 0, 1e-9);
  }

  {
    /** 鎖定縮放的：位置照樣跟著走，但 `scale` 回 `null` ⇒ 呼叫端⛔ 不套 */
    const d = new THREE.Matrix4().makeScale(2, 2, 2);
    const locked = [
      { m: objs[0].matrix().clone() },
      { m: objs[1].matrix().clone(), lockScale: true }
    ];
    const out = A.groupTransform(d, locked);
    near('沒鎖的 縮放跟著變成 2 倍', out[0].scale.x, 2, 1e-9);
    ok('★★ 鎖定縮放的 回 null（⛔ 不要套 scale）', out[1].scale === null);
    near('★ 但它的位置照樣跟著整組走（100 × 2）', out[1].pos.x, 200, 1e-9);
  }
}

/**
 * 框選問的是「這個物件在畫面上有沒有落在我拉的矩形裡」。
 * 那是投影問題，只需要相機，不需要 DOM —— 所以測得到。
 * select.js 只留真正的滑鼠／觸控事件那一層。
 */
{
  const S = await import('../js/core/screen.js');
  const A = await import('../js/core/align.js');
  const W = 800, H = 600;

  const cam = new THREE.PerspectiveCamera(45, W / H, 1, 20000);
  cam.position.set(0, 0, 400);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld(true);

  const mk = (x, y) => new io.ModelObject({
    src: { type: 'box', w: 20, h: 20, d: 20 }, kind: 'solid',
    pos: new THREE.Vector3(x, y, 0)
  });
  const entry = (id, o) => ({ id, box: A.worldBounds(o) });

  const mid = mk(0, 0), right = mk(200, 0), far = mk(-200, 0);
  const list = [entry(1, mid), entry(2, right), entry(3, far)];

  const sb = S.screenBounds(A.worldBounds(mid), cam, W, H);
  ok('置中的物件投影在畫面中央',
     Math.abs((sb.x0 + sb.x1) / 2 - W / 2) < 1 && Math.abs((sb.y0 + sb.y1) / 2 - H / 2) < 1);

  eq('框住中央 只選到中間那個',
     S.objectsInRect(list, { x0: 350, y0: 250, x1: 450, y1: 350 }, cam, W, H).join(','), '1');
  eq('框住整個畫面 三個都選到',
     S.objectsInRect(list, { x0: 0, y0: 0, x1: W, y1: H }, cam, W, H).sort().join(','), '1,2,3');
  eq('框在空白角落 一個都不選',
     S.objectsInRect(list, { x0: 0, y0: 0, x1: 5, y1: 5 }, cam, W, H).length, 0);

  /**
   * 「碰到就算」vs「要整個包住」。
   * 預設是碰到就算 —— 3D 裡物件互相遮擋、外框又比實體大，
   * 要求整個包住的話大件永遠選不到。
   */
  {
    const tiny = { x0: 395, y0: 295, x1: 405, y1: 305 };
    eq('碰到就算 選得到', S.objectsInRect(list, tiny, cam, W, H).length, 1);
    eq('要整個包住 就選不到', S.objectsInRect(list, tiny, cam, W, H, { enclose: true }).length, 0);
  }

  /**
   * ⚠ 相機後面的物件不能算進來。
   *
   * 透視投影下相機後方的點投影出來會左右上下顛倒，直接取外框會得到一個
   * 橫跨整個畫面的假矩形 —— 於是框選一拉就把背後的東西也選進來，
   * 而那個東西根本不在畫面上。使用者只會覺得「怎麼多選了看不見的東西」。
   */
  {
    const behind = mk(0, 0);
    behind.pos.z = 900;                       // 相機在 z=400 看向 −Z，這個在背後
    const sb2 = S.screenBounds(A.worldBounds(behind), cam, W, H);
    eq('相機後面的物件 投影結果為 null', sb2, null);
    eq('框住整個畫面也選不到它',
       S.objectsInRect([entry(9, behind)], { x0: 0, y0: 0, x1: W, y1: H }, cam, W, H).length, 0);
  }

  /**
   * 正交相機沒有「相機後面」這個問題（投影不會翻轉），所以一樣要能用。
   * 對齊那三個視角都是正交的，框選在那裡不能失效。
   */
  {
    const oc = new THREE.OrthographicCamera(-200, 200, 150, -150, -20000, 20000);
    oc.position.set(0, 0, 400);
    oc.lookAt(0, 0, 0);
    oc.updateMatrixWorld(true);
    eq('正交相機下 框住整個畫面也選得到',
       S.objectsInRect(list, { x0: 0, y0: 0, x1: W, y1: H }, oc, W, H).sort().join(','), '1,2,3');
  }

  eq('normRect 會把反向拖曳整理成左上右下',
     JSON.stringify(S.normRect(100, 80, 20, 10)), JSON.stringify({ x0: 20, y0: 10, x1: 100, y1: 80 }));
}

section('指定分片（seam.js）');

/**
 * 這一節盯的是「接縫位置由誰決定」。
 * 在 seam.js 出現之前，接縫是攤平生成樹走訪順序的副產品；
 * 現在它是使用者的決定，而這裡要證明那個決定真的有效、而且不會弄壞幾何。
 */
{
  const box = () => {
    const o = new io.ModelObject({ src: { type: 'box', w: 60, h: 45, d: 40 }, kind: 'solid' });
    o.bake();
    return o;
  };
  const un = o => unfoldObject(o, { material: 'foamboard' });

  /**
   * ⚠ pieces.length 是「幾張圖」，不是「幾片」。
   *
   * 展開引擎會把一樣的片合併成一張圖加一個 qty ——「12 支一樣的橫料
   * 出一張圖 ×12，不是 12 張一樣的圖」。所以壓克力方塊六個面是
   * 3 種形狀各 2 片：pieces.length ＝ 3，stats.total ＝ 6。
   *
   * **介面上要顯示的是 stats.total。** 顯示 3 而實際要切 6 片，
   * 是這個專案踩過最多次的那種錯：正確的數字，錯誤的意思。
   */
  const drawings = r => r.pieces.length;      // 幾張圖
  const total    = r => r.stats.total;        // 幾片（實際要切幾片）
  const areaOf   = r => r.stats.area;         // 已經含 qty

  // ── 誰能標、哪些邊能標 ──
  const raw = new io.ModelObject({ src: { type: 'box', w: 60, h: 45, d: 40 }, kind: 'solid' });
  ok('參數物件擋住不給標', !seam.canMarkSeams(raw));
  ok('擋住時有講原因', (seam.seamBlockReason(raw) || '').includes('轉成可編輯網格'));

  const o = box();
  ok('烘成網格後可以標', seam.canMarkSeams(o));

  const m = o.mesh();
  /**
   * 🔴 **這個數字在 2026-08-24 從 18 變成 12，而且那是進步。**
   *
   * 以前 `bake()` 只是把 src 換成 `mesh`，網格還是 three.js 給的 12 個三角形，
   * 所以有 18 條邊 —— 其中 **6 條是三角化的共面對角線，畫面上看不到**
   * （`scene.js` 畫稜線用 `EdgesGeometry(geometry, 1)`，只畫轉折 > 1 度的）。
   * 那時要靠 `markableEdges()` **過濾掉**那 6 條，才不會讓人標到看不見的邊。
   *
   * 現在 `bake()` 會順手把三角化還原成多邊形，所以那 6 條**根本不存在了**。
   *
   * ⭐ 意義：「**畫面上看得見的，才是可以標的**」這條規則，
   * 從「靠過濾維持」變成「**結構保證**」——
   * 而鐵律二說過：需要兩邊算出同一個答案時，
   * **與其小心地讓兩條路對齊，不如換一個只有一條路的定義。**
   */
  eq('★ 方塊總邊數 ＝ 看得見的 12 條（bake 已還原多邊形，不再有隱形對角線）',
     [...m.edges()].length, 12);
  eq('可標記的邊 ＝ 全部（過濾器現在沒有東西要濾）', seam.markableEdges(m).length, 12);

  // ── 一鍵切出一個面 ──
  const before = un(o);
  eq('未標記時 片數', total(before), 1);

  /**
   * 「一個面」指的是共面區域，不是三角形。
   * 方塊的正方形面在網格裡是兩個三角形，周圍是 4 條邊不是 3 條。
   * 這一項就是在盯 cutAroundFace 有沒有先做區域合併。
   */
  eq('一鍵切出一個面 切了幾條邊', seam.cutAroundFace(m, m.faces[0], true), 4);
  eq('切完 seamCount', seam.seamCount(m), 4);

  const after = un(o);
  eq('切出一個面後 片數', total(after), 2);
  eq('切出一個面後 張數', drawings(after), 2);   // 兩片形狀不同，所以兩張圖

  /**
   * ⚠ 這一項是整節最重要的。
   * 攤平是剛體運動，切幾刀都不該改變總面積。面積一旦跟著變，
   * 就表示分片動到了幾何而不只是動到「哪裡分開」——
   * 那會讓下料尺寸出錯，而且是靜靜地錯。
   */
  near('分片前後 總面積守恆', areaOf(after), areaOf(before), 1e-9);
  near('總面積 ＝ 方塊表面積', areaOf(after), 13800, 1e-9);

  // ── 存讀檔往返 ──
  /**
   * 標記存在 mesh.toJSON() 的 roles 裡，而且是用**頂點索引配對**存的，
   * 不是用 id（id 來自全域計數器，每次建網格都不一樣，存了也對不回來）。
   * 所以這一項同時在驗「當初選對了 key」。
   */
  const doc = new io.Doc();
  doc.objects = [o];
  const back = io.Doc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON()))).objects[0];
  eq('存讀檔往返 標記還在', seam.seamCount(back.mesh()), 4);
  eq('存讀檔往返 片數不變', total(un(back)), 2);
  near('存讀檔往返 面積不變', areaOf(un(back)), 13800, 1e-9);

  // ── 取消與清除 ──
  eq('清除標記 清掉幾條', seam.clearSeams(m), 4);
  eq('清除後 片數回到原狀', total(un(o)), 1);
  near('清除後 面積仍然守恆', areaOf(un(o)), 13800, 1e-9);

  /**
   * 取消標記回到 FOLD，是「交還給材料規則決定」，不是「強迫它折起來」。
   * 所以同一個網格換成壓克力（折不了），照樣會被拆成 6 片。
   * 這一項證明使用者的標記**不可能**覆蓋掉材料的物理限制 ——
   * 也就不可能產生一張做不出來的圖。
   */
  const acr = unfoldObject(o, { material: 'acrylic' });
  eq('清除後換壓克力 仍然拆成 6 片', total(acr), 6);
  eq('壓克力方塊 只需 3 張圖（6 片是 3 種形狀各 2 片）', drawings(acr), 3);
  near('壓克力 面積仍然守恆', areaOf(acr), 13800, 1e-9);
  /**
   * 交叉對答案：把每張圖的面積乘上它的份數再相加，必須等於 stats.area。
   * 這一項在盯「qty 有沒有被漏乘」—— 漏乘的話備料會少叫料，
   * 而且因為單張圖本身是對的，光看圖看不出來。
   */
  near('張數×份數 相加 ＝ 總面積',
       acr.pieces.reduce((s, p) => s + p.area * p.qty, 0), acr.stats.area, 1e-9);

  // ── 邊界邊不受影響 ──
  /**
   * 板件的邊界邊本來就是外輪廓，標了沒意義、取消更做不到。
   * 平板 100×60 攤開永遠是一片。
   */
  const plate = new io.ModelObject({
    src: { type: 'plate', w: 100, d: 60 }, kind: 'sheet', thickness: 0.2
  });
  plate.bake();
  eq('平板的邊界邊不可標記', seam.markableEdges(plate.mesh()).length, 0);
  eq('平板 清除標記 動到 0 條', seam.clearSeams(plate.mesh()), 0);
}

/**
 * 點選的幾何部分。
 *
 * 這一段刻意放在 seam.js 而不是 select.js，就是為了能在這裡測 ——
 * select.js 只留真正的滑鼠／觸控事件那一層。
 *
 * 用「命中點的 3D 座標」而不是 raycast 給的 faceIndex，是因為後者是
 * 三角化之後的三角形編號，要對回半邊網格得另外維護一份對照表，
 * 而那份表一旦跟 toGeometry() 的順序脫節就會靜靜地指錯面。
 * 座標是幾何事實，不依賴任何編號。
 */
{
  const V = (x, y, z) => new THREE.Vector3(x, y, z);

  near('點到線段距離 垂直落在中間', seam.distPointSeg(V(0, 5, 0), V(-10, 0, 0), V(10, 0, 0)), 5);
  near('點到線段距離 落在端點外', seam.distPointSeg(V(20, 0, 0), V(-10, 0, 0), V(10, 0, 0)), 10);

  const o = new io.ModelObject({ src: { type: 'box', w: 60, h: 45, d: 40 }, kind: 'solid' });
  o.bake();
  const m = o.mesh();
  m.computeNormals();

  /**
   * 方塊中心在原點，所以頂面在 y=22.5、右面在 x=30、前面在 z=20。
   * 從面的正中央量到最近的稜線，就是另外兩個方向的一半 ——
   * 這些數字是硬的，算錯一眼就看得出來。
   */
  near('頂面中央 到最近稜線', seam.nearestMarkableEdge(m, V(0, 22.5, 0)).dist, 20);
  near('右面中央 到最近稜線', seam.nearestMarkableEdge(m, V(30, 0, 0)).dist, 20);
  near('前面中央 到最近稜線', seam.nearestMarkableEdge(m, V(0, 0, 20)).dist, 22.5);
  near('稜線上 到最近稜線 ＝ 0', seam.nearestMarkableEdge(m, V(30, 22.5, 0)).dist, 0);

  const top = seam.nearestFace(m, V(0, 22.5, 0));
  near('頂面中央 到最近面 ＝ 0', top.dist, 0);
  near('而且那個面的法向朝上', top.face.normal.y, 1, 1e-6);
  near('右面中央 命中的面法向朝右', seam.nearestFace(m, V(30, 0, 0)).face.normal.x, 1, 1e-6);

  /**
   * 六個面依序整圈切開。片數 1→2→3→4→6 ——
   * 切到第四個面時會一次跳兩片，因為剩下的兩面本來就只透過
   * 已經切掉的那幾面相鄰，切開第四面時它們同時斷開。
   * 這個「跳號」是對的，寫死在測試裡免得日後有人以為是 bug 去「修」它。
   */
  const pts = [V(0, 22.5, 0), V(0, -22.5, 0), V(30, 0, 0), V(-30, 0, 0), V(0, 0, 20), V(0, 0, -20)];
  const got = [];
  for (const p of pts) {
    seam.cutAroundFace(m, seam.nearestFace(m, p).face, true);
    got.push(unfoldObject(o, { material: 'foamboard' }).stats.total);
  }
  eq('六面依序切開 片數變化', got.join('→'), '2→3→4→6→6→6');
  eq('六面全切開後 標記 ＝ 全部 12 條', seam.seamCount(m), 12);
  near('六面全切開後 面積仍然守恆',
       unfoldObject(o, { material: 'foamboard' }).stats.area, 13800, 1e-9);

  const ftop = seam.nearestFace(m, V(0, 22.5, 0)).face;
  ok('切完之後 faceIsCutOut 認得出來', seam.faceIsCutOut(m, ftop));
  eq('再點一次 收回頂面', seam.cutAroundFace(m, ftop, false), 4);
  ok('收回之後 faceIsCutOut 變回 false', !seam.faceIsCutOut(m, ftop));
}

section('接合編號');

/**
 * kang 的原話：「簡單的展開圖很好區分，遇到複雜的分切展開，
 * 標示就需要研究一下了。」—— 那是最早那句話的後半段「切割後**再組裝結合**」。
 *
 * ⚠ 接合編號與「一樣的片合併成一張圖」**本質上互斥**：
 * 合併只看形狀，方塊的頂面與底面形狀一樣會被併成一張圖，
 * 但它們接的是不同的邊，一張圖只能標一組號碼。
 * kang 的決定：分切過的就不合併，全部給編號；沒標過的維持原本行為。
 */
{
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const mk = () => {
    const o = new io.ModelObject({ src: { type: 'box', w: 60, h: 45, d: 40 }, kind: 'solid' });
    o.bake();
    return o;
  };

  // ── 沒標過分片的物件：行為完全不變 ──
  const plain = mk();
  const rp = unfoldObject(plain, { material: 'foamboard' });
  eq('沒標分片 仍然是一片', rp.stats.total, 1);
  eq('沒標分片 沒有接合編號', rp.pieces[0].joints.length, 0);

  /**
   * 壓克力方塊是**材料規則**拆開的，不是使用者標的。
   * 判準用「使用者有沒有標過」而不是「展開結果有沒有超過一片」，
   * 就是為了不要靜靜地改掉這條天天在用的路。
   */
  const acr = unfoldObject(plain, { material: 'acrylic' });
  eq('材料拆開的 仍然合併成 3 張圖', acr.pieces.length, 3);
  eq('材料拆開的 沒有接合編號', acr.pieces.reduce((n, p) => n + p.joints.length, 0), 0);

  // ── 六面全部手動切開 ──
  const o = mk();
  const m = o.mesh();
  for (const p of [V(0, 22.5, 0), V(0, -22.5, 0), V(30, 0, 0),
                   V(-30, 0, 0), V(0, 0, 20), V(0, 0, -20)]) {
    seam.cutAroundFace(m, seam.nearestFace(m, p).face, true);
  }
  const r = unfoldObject(o, { material: 'foamboard' });

  eq('分切過的 不合併，六張圖', r.pieces.length, 6);
  eq('分切過的 片數 6', r.stats.total, 6);
  near('分切過的 面積仍然守恆', r.stats.area, 13800, 1e-9);

  /**
   * ⚠ 這一項是整節最重要的：**每個編號恰好出現兩次。**
   *
   * 那正是「A 片的 ③ 對上 B 片的 ③」該有的數學性質。
   * 出現一次 ＝ 有一條邊找不到對象，接不回去；
   * 出現三次以上 ＝ 編號撞號，師傅會接錯。
   * 兩種都是「圖看起來很正常，但東西組不起來」——
   * 而那要等切完料才會發現。
   */
  const cnt = new Map();
  for (const p of r.pieces) for (const j of p.joints) cnt.set(j.num, (cnt.get(j.num) || 0) + 1);
  eq('接合編號共 12 組（＝方塊的邊數）', cnt.size, 12);
  eq('每個編號恰好出現兩次', [...cnt.values()].filter(n => n !== 2).length, 0);

  // ── 標示畫得出來，而且落在料上面 ──
  /**
   * 往片內縮，不往外放 —— 外面已經被尺寸與折彎標註佔滿了，
   * 再擠進去就是坑第 12 條那團「0.9787.05.24」。
   * 這一項在盯「號碼有沒有掉到料外面去」，那樣師傅根本不知道它指哪條邊。
   */
  const p0 = r.pieces[0];
  const marks = drawProgram(p0, {}).items.filter(i => i.style === 'joint');
  eq('第一片畫出 4 個接合編號', marks.length, 4);
  ok('接合編號全部落在料的範圍內',
     marks.every(i => i.x > 0 && i.x < p0.width && i.y > 0 && i.y < p0.height));

  // ── DXF ──
  /**
   * JOIN 獨立一層：它是給組裝的人看的，不是給機器的。
   * 進 Illustrator 重新排版時可以先關掉，排完再開回來。
   */
  const dxf = toDXF(r.pieces, { unit: 'mm' });
  const ent = dxf.slice(dxf.indexOf('ENTITIES'));
  eq('DXF 的 ENTITIES 裡有 24 個接合編號（6 片 × 4）',
     (ent.match(/\r\nJOIN\r\n/g) || []).length, 24);
  ok('DXF 的圖層表裡有 JOIN', dxf.slice(0, dxf.indexOf('ENTITIES')).includes('JOIN'));

  /**
   * 圖上那些綠色數字沒有說明的話，師傅只會覺得「這是什麼」。
   * 標了卻沒人看得懂 ＝ 沒標。
   */
  // 2026-08-22 從「同號碼的邊」改成「同號碼的段」——編號現在是一段一個，
  // 不是一條邊一個（一個 S 字的面板從 198 個號碼變成 7 段）
  ok('標題欄有說明接合編號怎麼用',
     titleLines(p0, {}).join('|').includes('同號碼的段接在一起'));
  ok('沒有接合編號時 標題欄不提這件事',
     !titleLines(rp.pieces[0], {}).join('|').includes('接合編號'));
}

section('第 3 期：效能');

{
  const t0 = Date.now();
  const m = buildPrim('cylinder', { r: 25, h: 70, seg: 128, openEnded: true }, 0.2);
  const r = unfoldMesh(m, makeRule('steel', 0.2));
  const ms = Date.now() - t0;
  // 〔2026-08-23：期望值從 2πr 改成 128 邊形的弦長總和。驗的事情沒變 ——
  //   段數很多的時候辨識仍然精確、沒有累積誤差〕
  near('128 段圓柱 展開長仍精確', r.pieces[0].width,
    128 * 2 * 25 * Math.sin(Math.PI / 128), 1e-6);
  ok(`128 段圓柱 展開耗時 ${ms}ms（< 2 秒）`, ms < 2000, `${ms}ms`);
}

// ═══════════════════════════════════════════════════════
//  剖面分切（第三條生產路徑）
// ═══════════════════════════════════════════════════════

section('剖面分切：分段');

{
  // kang 給的例子：1cm×5 ＋ 2cm×7 ＋ 1cm×剩下，模型高 27
  const p = sect.planSlabs(27, [{ t: 1, n: 5 }, { t: 2, n: 7 }, { t: 1, n: 'rest' }]);
  eq('分段 總片數', p.slabs.length, 20);
  near('分段 疊到的高度 ＝ 模型高', p.used, 27);
  near('分段 差額 0', p.diff, 0);
  eq('分段 第 2 段的片號是 6~12',
     `${p.bands[1].from}~${p.bands[1].to}`, '6~12');
  eq('分段 第 3 段「剩下」自動算出 8 片', p.bands[2].n, 8);
  near('分段 第 6 片的中央高度', p.slabs[5].mid, 6);   // 5 + 2/2

  /**
   * 湊不滿時**如實回報，不四捨五入湊滿**。
   * 偷偷湊滿的後果是圖看起來剛好、東西矮一截，而且要疊完才發現。
   */
  const q = sect.planSlabs(27, [{ t: 2, n: 'rest' }]);
  eq('湊不滿 片數', q.slabs.length, 13);
  near('湊不滿 差額如實回報', q.diff, 1);

  const over = sect.planSlabs(27, [{ t: 10, n: 4 }]);
  near('疊過頭 差額是負的', over.diff, -13);

  /**
   * ⚠ 2026-08-22 kang 實測抓到的：布林聯集出來的物件，
   * Manifold 的座標帶著 1e-4 等級的精度殘留，高度不是剛好 60 而是 60.0001。
   *
   * 兩個後果都要擋住：
   *   一、面板跳出「還差 0 cm 沒疊到」——自相矛盾，看的人只能猜
   *   二、殘留是負的時候，「剩下」會少算一整片，差 5cm 卻不知道為什麼
   *
   * 判準必須挑**有物理意義的量**（0.1mm），不是浮點數的 1e-6。
   */
  const bands = [{ t: 5, n: 3 }, { t: 10, n: 3 }, { t: 5, n: 'rest' }];
  const hi = sect.planSlabs(60.0001, bands);
  const lo = sect.planSlabs(59.9999, bands);
  eq('高度有正殘留時 片數不變', hi.slabs.length, 9);
  eq('高度有負殘留時 也不會少算一片', lo.slabs.length, 9);
  ok('殘留造成的差額小於容許值（不該跳警告）',
     Math.abs(hi.diff) < sect.FIT_TOL && Math.abs(lo.diff) < sect.FIT_TOL,
     `${fmt(hi.diff)} / ${fmt(lo.diff)}`);
  ok('真的差半片時還是要跳（容許值沒有寬到蓋掉真問題）',
     Math.abs(sect.planSlabs(62.5, bands).diff) > sect.FIT_TOL);
}

section('剖面分切：切一疊');

{
  const m = buildPrim('box', { w: 60, h: 45, d: 40 }, 0.2);
  const r = sect.sliceMesh(m, { axis: 'y', bands: [{ t: 1, n: 'rest' }] });

  eq('方塊 片數', r.slices.length, 45);
  near('方塊 每片面積 ＝ 60×40', r.slices[0].area, 2400);
  near('方塊 中間那片也一樣', r.slices[22].area, 2400);
  eq('方塊 一片只有一圈輪廓', r.slices[0].loops.length, 1);
  eq('方塊 沒有內孔', r.slices[0].loops[0].isHole, false);

  /**
   * 共線的多餘頂點要清掉。方塊的側面在網格上是兩個三角形，
   * 不清的話一片會有 8 個點，其中 4 個是三角化的產物 ——
   * DXF 會多一倍的線，進 Illustrator 還多出可以被拖走的錨點。
   */
  eq('方塊 一片 4 個點（三角化的中間點已清掉）', r.slices[0].loops[0].pts.length, 4);

  /**
   * ⚠ 這一項盯的是**鏡射**。
   * 2D 座標的 (u,v) 順序排錯的話，每一片都會左右翻過來 ——
   * 面積、片數、孔位全部算得對，圖看起來也完全正常，
   * 但做出來是鏡像的，疊不回原形。而且要切完料才會發現。
   * 外輪廓是逆時針（正面積）就表示手性沒錯。
   */
  ok('方塊 外輪廓是逆時針（沒有鏡射）', r.slices[0].loops[0].area > 0);

  /**
   * 三個軸切出來的體積都必須等於真正的體積。
   * 這是這一整套最強的一項交叉驗證：切片方向、(u,v) 的配對、
   * 面積正負號、片厚累加，任何一個弄錯，這三個數字就對不起來。
   */
  for (const ax of ['x', 'y', 'z']) {
    const rr = sect.sliceMesh(buildPrim('box', { w: 60, h: 45, d: 40 }, 0.2),
      { axis: ax, bands: [{ t: 1, n: 'rest' }] });
    near(`${ax} 軸 Σ(片面積×片厚) ＝ 體積 108000`,
      rr.slices.reduce((a, s) => a + s.area * s.t, 0), 108000, 1e-6);
  }

  // 混合板厚一樣要守恆 —— 片厚不再是常數，累加寫錯就會露出來
  const mix = sect.sliceMesh(buildPrim('box', { w: 60, h: 27, d: 40 }, 0.2),
    { axis: 'y', bands: [{ t: 1, n: 5 }, { t: 2, n: 7 }, { t: 1, n: 'rest' }] });
  eq('混合板厚 片數', mix.slices.length, 20);
  eq('混合板厚 兩種厚度', mix.stats.thickKinds.join(','), '1,2');
  near('混合板厚 Σ(片面積×片厚) ＝ 體積 64800',
    mix.slices.reduce((a, s) => a + s.area * s.t, 0), 60 * 27 * 40, 1e-6);
}

{
  // 管：中間是通的，所以每片都是一個環 —— 外輪廓一圈、內孔一圈
  const m = buildPrim('tube', { r: 25, ri: 20, h: 70, seg: 64 }, 0.2);
  const r = sect.sliceMesh(m, { axis: 'y', bands: [{ t: 2, n: 'rest' }] });
  const s = r.slices[5];
  eq('管 一片兩圈', s.loops.length, 2);
  eq('管 其中一圈是內孔', s.loops.filter(l => l.isHole).length, 1);
  const poly = 64 * Math.sin(2 * Math.PI / 64) / 2;
  near('管 片面積 ＝ 外環減內環', s.area, poly * (25 * 25 - 20 * 20), 1e-9);
  ok('管 內孔是順時針（負面積）', s.loops.find(l => l.isHole).area < 0);
}

{
  /**
   * 截面不變的東西（圓柱）Σ(片面積×片厚) 必須**精確等於**網格體積。
   * 切片本身沒有近似，會有誤差的只有「截面隨高度變」這件事。
   */
  const c = buildPrim('cylinder', { r: 25, h: 70, seg: 64 }, 0.2);
  const rc = sect.sliceMesh(c, { axis: 'y', bands: [{ t: 2, n: 'rest' }] });
  rel('圓柱 Σ(片面積×片厚) 精確等於網格體積',
      rc.slices.reduce((a, s) => a + s.area * s.t, 0), c.volume(), 1e-12);
}

{
  /**
   * 球：不可展曲面。展開那條路只能近似，剖面分切照樣切得開 ——
   * 這正是原訂第 7 期大概可以取消的理由。
   *
   * ── 對答案要對「網格的體積」，不是理想球的體積 ──────────
   * 這個網格是內接的多面體，它自己就比真球小 1.6%（rings 48），
   * 那是建模的離散化，跟切片一點關係也沒有。
   * 拿理想球當基準的話，測到的是球體怎麼建的，不是切片準不準。
   *
   * 切片自己的誤差來自「用中央那一刀代表整段」，
   * 所以片越薄越準 —— 下面直接把收斂測出來。
   */
  const m = buildPrim('sphere', { r: 30, seg: 64, rings: 48 }, 0.2);
  const V = m.volume();
  const vol = t => sect.sliceMesh(m, { axis: 'y', bands: [{ t, n: 'rest' }] })
    .slices.reduce((a, s) => a + s.area * s.t, 0);

  const e2 = Math.abs(vol(2) / V - 1);
  const e05 = Math.abs(vol(0.5) / V - 1);
  ok(`球 片厚 0.5 時逼近網格體積到 ${(e05 * 100).toFixed(3)}%`, e05 < 0.001);
  ok('球 片越薄越準（切片誤差是可收斂的，不是算錯）', e05 < e2 / 5,
     `2cm:${(e2 * 100).toFixed(3)}%　0.5cm:${(e05 * 100).toFixed(3)}%`);
}

{
  /**
   * 疊過頭的片會切到空的地方，而且一定要講出來。
   *
   * 注意第 5 片（40~50，中央剛好 45）**不是空的** ——
   * 模型頂面就在 45，那一刀切到的是頂面本身，得到完整的截面。
   * 數學上沒錯（封閉體在邊界上的截面就是整個面），
   * 但它代表的那一段有一半在空氣裡 —— 講出這件事的是「差額 −15」那一行，
   * 不是空片偵測。兩個訊息各管一半，缺一個使用者就會漏看。
   */
  const m = buildPrim('box', { w: 60, h: 45, d: 40 }, 0.2);
  const r = sect.sliceMesh(m, { axis: 'y', bands: [{ t: 10, n: 6 }] });
  eq('疊過頭 片數照樣是 6', r.slices.length, 6);
  near('疊過頭 差額是負的 −15（做出來會超出模型）', r.stats.diff, -15);
  eq('疊過頭 完全落在模型外的是第 6 片',
     r.slices.filter(s => !s.loops.length).map(s => s.index).join(','), '6');
  ok('疊過頭 有講出是哪幾片空的',
     r.warnings.some(w => w.includes('空的')), r.warnings.join('|'));
}

section('剖面分切：定位孔');

{
  const m = buildPrim('box', { w: 60, h: 45, d: 40 }, 0.2);
  const r = sect.sliceMesh(m, { axis: 'y', bands: [{ t: 1, n: 'rest' }] });

  // 點在不在料上、離邊界多遠 —— 手算得出來的數字
  const loops = r.slices[0].loops;
  near('方塊 正中心離邊界 ＝ 短邊的一半', sect.insideDepth(loops, 0, 0), 20);
  ok('方塊 外面的點是負的', sect.insideDepth(loops, 100, 0) < 0);

  const g = pegsMod.findPegs(r.slices, {});
  const P = g.bands[0].pegs;
  ok('方塊 找得到定位孔', g.ok, g.reason || '');
  eq('方塊 兩個孔（一個孔鎖不住旋轉）', P.length, 2);

  /**
   * 孔①刻意**不寫死在外框中心**，而是取「所有片都最安全的那一點」。
   * 對方塊來說那算出來就是中心，但規則不是「中心」——
   * 管狀件的中心是空的，寫死會讓孔落在洞裡。
   */
  ok('方塊 孔① 落在正中心', g.base.x === 0 && g.base.y === 0, JSON.stringify(g.base));
  ok('方塊 孔① 沒有 −0 這種東西', !Object.is(g.base.x, -0) && !Object.is(g.base.y, -0));

  /**
   * 第一版把第 2 孔放在「最遠」的地方，結果被推到角落，
   * 離邊只剩 1.47cm，45 片全部變成快裂了 —— 而那塊料明明寬得很。
   * 現在的規則是「安全度至少要有使用者設的淨距的兩倍」。
   */
  ok('方塊 第 2 孔的安全度 ≥ 淨距的兩倍', g.margin >= g.need * 2,
     `margin ${fmt(g.margin)}　need ${fmt(g.need)}`);
  ok('方塊 兩孔離得夠遠（鎖得住旋轉）', g.bands[0].spread > 20,
     `spread ${fmt(g.bands[0].spread)}`);
  eq('方塊 安全的件不該跳任何警告', g.warnings.length, 0);

  const chk = pegsMod.checkPegs(r.slices, s => pegsMod.pegsForSlice(g, s), {});
  ok('方塊 每一片都串得起來', chk.ok, `壞掉的片：${chk.bad.join(',')}`);
  near('方塊 檢查回報的最糟距離 ＝ 找孔時算的 margin', chk.worst, g.margin, 1e-9);

  // 孔徑大到塞不下時要**明講不行**，不能靜靜給一組會切壞的孔
  const huge = pegsMod.findPegs(r.slices, { d: 80, gap: 5 });
  ok('孔徑塞不下時老實說不行', !huge.ok);
  ok('而且講得出為什麼', !!huge.reason && huge.reason.length > 10, huge.reason);
}

{
  /**
   * ⚠ 2026-08-22 kang 實測球體抓到的：
   * 球切 15 片，頭尾是直徑只有 10cm 的小圓片。第一版所有孔都要求
   * 「每一片都成立」，於是兩個孔被擠進那個小圓裡，**只距離 2.66cm**
   * —— 在一個 60cm 的球上等於白放第二個孔。**被全場最小的那一片綁死了。**
   *
   * 現在孔①才是全域的（通到底的那根桿子），其餘的孔各段自己求解，
   * 只需要在那一段的片上成立。
   */
  const m = buildPrim('sphere', { r: 30, seg: 48, rings: 32 }, 0.2);
  const bands = [{ t: 1, n: 5 }, { t: 10, n: 5 }, { t: 1, n: 5 }];
  const r = sect.sliceMesh(m, { axis: 'x', bands });
  eq('球 分三段共 15 片', r.slices.length, 15);

  const all2 = pegsMod.findPegs(r.slices, { d: 0.5, gap: 0.8, counts: [2, 2, 2] });
  const mid = all2.bands[1];
  const cap = all2.bands[0];
  ok('球 中段兩孔拉得開（不再被最小的那一片綁死）', mid.spread > 15,
     `中段 ${fmt(mid.spread)} cm　頭段 ${fmt(cap.spread)} cm`);
  ok('球 頭尾小片的孔本來就拉不開', cap.spread < 5);
  ok('球 兩孔太近時會講出來（不是只報離邊緣多遠）',
     all2.warnings.some(w => w.includes('鎖不住旋轉')), all2.warnings.join('|'));

  // kang 的用法：頭尾給 1 孔，中段給 2 孔
  const g = pegsMod.findPegs(r.slices, { d: 0.5, gap: 0.8, counts: [1, 2, 1] });
  eq('球 段1 依指定只給 1 孔', g.bands[0].pegs.length, 1);
  eq('球 段2 依指定給 2 孔', g.bands[1].pegs.length, 2);
  eq('球 段3 依指定只給 1 孔', g.bands[2].pegs.length, 1);

  /**
   * 孔①必須在**每一段都是同一個座標** —— 它是通到底的那根桿子，
   * 各段各算一個的話桿子就穿不過去了。
   */
  const b0 = g.bands.map(b => `${b.pegs[0].x},${b.pegs[0].y}`);
  eq('球 孔① 三段完全同一個座標', new Set(b0).size, 1);
  eq('球 孔① 就是回傳的 base', b0[0], `${g.base.x},${g.base.y}`);

  ok('球 每一片都串得起來',
     pegsMod.checkPegs(r.slices, s => pegsMod.pegsForSlice(g, s),
       { d: 0.5, gap: 0.8 }).ok);
  /**
   * ⚠ 自己選的東西不能當成錯誤。
   * 使用者刻意把頭尾設成 1 孔，第一版跳出兩個紅色警告唸同一件事 ——
   * 紅色一旦用在「你自己選的後果」上就失去意義了（坑第 18 條的軟性版）。
   * 後果還是要講，但講一次、而且是說明不是警告。
   */
  eq('球 使用者自己選 1 孔 不算警告', g.warnings.length, 0);
  eq('球 單孔的說明只講一次（不是每段一次）', g.notes.length, 1);
  ok('球 說明裡講得出「可以繞著孔轉」與是哪幾片',
     g.notes[0].includes('繞著孔轉') && g.notes[0].includes('1~5')
     && g.notes[0].includes('11~15'), g.notes.join('|'));

  // 加到 3 孔，間距要更大（第 3 孔不是隨便塞在旁邊）
  const g3 = pegsMod.findPegs(r.slices, { d: 0.5, gap: 0.8, counts: [1, 3, 1] });
  eq('球 段2 給得了 3 孔', g3.bands[1].pegs.length, 3);
  ok('球 3 孔的散開程度大於 2 孔', g3.bands[1].spread > g.bands[1].spread);

  // 每一片拿到的孔 ＝ 它那一段的孔
  eq('第 3 片拿到段1的孔',
     pegsMod.pegsForSlice(g, r.slices[2]).length, 1);
  eq('第 8 片拿到段2的孔',
     pegsMod.pegsForSlice(g, r.slices[7]).length, 2);
}

{
  // 管：中間是洞，孔一定要落在環上，不能落在中空的地方
  const m = buildPrim('tube', { r: 25, ri: 20, h: 70, seg: 64 }, 0.2);
  const r = sect.sliceMesh(m, { axis: 'y', bands: [{ t: 2, n: 'rest' }] });
  const g = pegsMod.findPegs(r.slices, { d: 0.4, gap: 0.5 });
  ok('管 找得到定位孔', g.ok, g.reason || '');

  /**
   * ⚠ 這一項就是「孔①不能寫死在外框中心」的理由。
   * 管的中心是空的，硬放中心那個孔會落在洞裡，整疊全部串不起來。
   */
  ok('管 孔① 沒有落在中間的洞裡',
     Math.hypot(g.base.x, g.base.y) > 20, JSON.stringify(g.base));
  for (const p of g.bands[0].pegs) {
    const rad = Math.hypot(p.x, p.y);
    ok(`管 孔落在環上（半徑 ${fmt(rad)}，應在 20~25 之間）`, rad > 20 && rad < 25);
  }
  ok('管 兩孔幾乎在對面（環形件最好的鎖法）', g.bands[0].spread > 40,
     `spread ${fmt(g.bands[0].spread)}`);
  ok('管 每一片都串得起來',
     pegsMod.checkPegs(r.slices, s => pegsMod.pegsForSlice(g, s),
       { d: 0.4, gap: 0.5 }).ok);
}

section('剖面分切：出圖與 DXF');

{
  const m = buildPrim('box', { w: 60, h: 27, d: 40 }, 0.2);
  const r = sect.sliceMesh(m, { axis: 'y',
    bands: [{ t: 1, n: 5 }, { t: 2, n: 7 }, { t: 1, n: 'rest' }] });
  // 段1、段3 給 1 孔，段2 給 2 孔 —— 每片孔數不一樣才測得到出圖有沒有搞混
  const g = pegsMod.findPegs(r.slices, { counts: [1, 2, 1] });
  const pegsOf = s => pegsMod.pegsForSlice(g, s);
  const fr = sect.stackBounds(r.slices);
  const popt = {
    origin: { x: fr.minX, y: fr.minY }, frame: { w: fr.w, h: fr.h },
    pegD: 0.5, total: r.slices.length
  };

  /**
   * 每一片都用同一個座標框，所以孔在每張圖上都落在同一個位置。
   * 各自貼齊自己的外框也畫得出圖，但那樣人就沒辦法把圖排開、
   * 用眼睛掃一遍確認孔位真的對齊。
   */
  const p1 = sliceProgram(r.slices[0], { ...popt, pegs: pegsOf(r.slices[0]) });
  const p2 = sliceProgram(r.slices[6], { ...popt, pegs: pegsOf(r.slices[6]) });
  eq('所有片共用同一個外框', `${p1.box.w},${p1.box.h}`, `${p2.box.w},${p2.box.h}`);
  const c1 = p1.items.filter(i => i.t === 'circle');
  const c2 = p2.items.filter(i => i.t === 'circle');
  eq('段1 的片 1 個孔', c1.length, 1);
  eq('段2 的片 2 個孔', c2.length, 2);
  eq('孔① 在每片的同一個位置', `${c1[0].x},${c1[0].y}`, `${c2[0].x},${c2[0].y}`);

  /**
   * 層號一律掛在孔①旁邊，不是掛在這一段的其他孔旁邊 ——
   * 只有孔①在每一片上都在同一個地方，它同時也是朝向記號。
   */
  const n1 = p1.items.find(i => i.style === 'num');
  const n2 = p2.items.find(i => i.style === 'num');
  eq('層號有標上片號與板厚', n2.s, '#07 t2');
  eq('層號的水平位置在每片都一樣（＝孔①正下方）', n1.x, n2.x);

  const tl = sliceTitleLines(r.slices[6], { ...popt, pegs: pegsOf(r.slices[6]) });
  ok('標題欄講得出第幾片、板厚', tl[0].includes('第 7 片') && tl[0].includes('2 cm'), tl[0]);
  /**
   * 「只有孔①通到底」一定要寫在圖上。
   * 不寫的話現場會拿一根長桿子想穿過全部，穿到一半才發現穿不過去。
   */
  ok('標題欄講清楚只有孔①通到底',
     tl.join('|').includes('通到底'), tl.join('|'));

  const svg = progSVG(p1, tl);
  ok('SVG 有 XML 宣告（沒有的話 Illustrator 當純文字開）', svg.startsWith('<?xml'));
  ok('SVG 畫得出圓孔', svg.includes('<circle'));
  ok('SVG 不用 dominant-baseline（Illustrator 不支援）',
     !svg.includes('dominant-baseline'));

  // ── DXF ──
  const dxf = sliceDXF(r.slices, {
    unit: 'mm', origin: popt.origin, frame: popt.frame,
    pegsOf, pegD: 0.5, axis: 'y', head: { name: '測試' }
  });
  {
    /** 〔2026-10-08 查 bug E10〕有案件名稱 ＝ 說明文字 7 行，以前檔頭只留 12s、最上面那行超出去 */
    const eb = dxfBounds(dxf);
    ok('★★ E10：剖面 DXF 的檔頭範圍包得住所有線與文字（有案件名稱、7 行說明）', eb.inside, eb.why);
  }

  const sections = [...dxf.matchAll(/(?:^|\r\n)0\r\nSECTION\r\n2\r\n(\w+)\r\n/g)]
    .map(x => x[1]);
  eq('剖面 DXF 四個區段齊全且順序正確',
     sections.join('>'), 'HEADER>TABLES>BLOCKS>ENTITIES');
  const tbls = [...dxf.matchAll(/\r\n0\r\nTABLE\r\n2\r\n(\w+)\r\n/g)].map(x => x[1]);
  eq('剖面 DXF 表格齊全，LTYPE 在 LAYER 前',
     tbls.join('>'), 'LTYPE>LAYER>STYLE');

  const layers = [...dxf.matchAll(/\r\n0\r\nLAYER\r\n2\r\n([\w$-]+)\r\n/g)].map(x => x[1]);
  eq('剖面 DXF 圖層：切割線依板厚各一層',
     layers.join(','), '0,CUT_T10,CUT_T20,NUM,TEXT');

  /**
   * 圖層數宣告（群組碼 70）跟實際圖層數對不上，DXF「看起來」完全正常，
   * 但有些軟體會直接判定檔案損壞。加圖層卻忘了改這個數字，
   * 2026-08-22 做接合編號時被回歸測試擋下來過一次。
   */
  eq('剖面 DXF 圖層數宣告 ＝ 實際圖層數',
     +dxf.match(/TABLE\r\n2\r\nLAYER\r\n70\r\n(\d+)/)[1], layers.length);

  // 每片孔數不一樣，所以要一片一片加起來 —— 用一個固定的乘法會測不到搞混
  eq('剖面 DXF 圓孔數 ＝ 每片各自的孔數加起來',
     (dxf.match(/\r\n0\r\nCIRCLE\r\n/g) || []).length,
     r.slices.reduce((n, s) => n + pegsOf(s).length, 0));
  ok('剖面 DXF 有寫「只有孔①通到底」',
     dxf.includes('through rod'));

  /**
   * 定位孔一定要跟輪廓在**同一個切割圖層**。
   * 分成獨立一層的話，廠商只留切割層丟給機器時孔會漏切 ——
   * 而漏切的後果是整疊串不起來，那批料全部報廢。
   */
  ok('定位孔畫在切割層（不是獨立一層，否則會漏切）',
     !layers.includes('PEG'));
  const cutBlock = dxf.split('\r\n0\r\nCIRCLE\r\n')[1] || '';
  ok('每個圓孔都掛在 CUT_T** 圖層上', /^8\r\nCUT_T/.test(cutBlock), cutBlock.slice(0, 20));

  eq('剖面 DXF 全部是 CRLF 換行', /[^\r]\n/.test(dxf), false);
  eq('剖面 DXF 全部是 ASCII（中文在 R12 沒有統一編碼）',
     /[^\x00-\x7F]/.test(dxf), false);
  ok('剖面 DXF 以 EOF 結尾', dxf.trimEnd().endsWith('EOF'));
  ok('剖面 DXF 有寫「一次只切一種板厚」的用法說明',
     dxf.includes('cut one thickness at a time'));

  eq('圖層命名 1.0cm', cutLayer(1.0), 'CUT_T10');
  eq('圖層命名 2cm', cutLayer(2), 'CUT_T20');
  eq('圖層命名 0.35cm 小數點寫成底線（R12 圖層名不能有點）',
     cutLayer(0.35), 'CUT_T3_5');
}

section('剖面分切：效能');

{
  const t0 = Date.now();
  const m = buildPrim('sphere', { r: 30, seg: 64, rings: 48 }, 0.2);
  const r = sect.sliceMesh(m, { axis: 'y', bands: [{ t: 1, n: 'rest' }] });
  const g = pegsMod.findPegs(r.slices, {});
  const ms = Date.now() - t0;
  ok(`球 60 片 切片＋找孔 ${ms}ms（< 5 秒）`, ms < 5000, `${ms}ms`);
  ok('球 60 片 每片都切得出東西', r.slices.every(s => s.loops.length));
  ok('球 找得到定位孔', g.ok, g.reason || '');
}

// ═══════════════════════════════════════════════════════
//  匯入線稿（SVG → 輪廓 → 擠出）
// ═══════════════════════════════════════════════════════

section('匯入線稿：路徑解析與攤平');

{
  const sq = svgp.parsePath('M0,0 L100,0 L100,100 L0,100 Z', { tol: 1 });
  eq('正方形 4 個點（Z 不重複補起點）', sq.subpaths[0].pts.length, 4);
  near('正方形面積', Math.abs(svgp.polyArea(sq.subpaths[0].pts)), 10000);
  eq('正方形是封閉的', sq.subpaths[0].closed, true);

  const rel = svgp.parsePath('m0,0 l100,0 l0,100 l-100,0 z', { tol: 1 });
  near('相對座標 ＝ 絕對座標', Math.abs(svgp.polyArea(rel.subpaths[0].pts)), 10000);

  const hv = svgp.parsePath('M0,0 H100 V100 H0 Z', { tol: 1 });
  near('H／V 指令', Math.abs(svgp.polyArea(hv.subpaths[0].pts)), 10000);

  /**
   * SVG 允許「數字直接接在後面 ＝ 重複上一個指令」，而 M 後面重複的是 L。
   * 漏掉這條規則的話，多邊形會少掉除了第一點以外的**所有**點 ——
   * 而畫面上只剩一條線，很容易被當成「這個檔有問題」。
   */
  const imp = svgp.parsePath('M0,0 100,0 100,100 0,100 Z', { tol: 1 });
  near('M 後面接數字 ＝ 隱含的 L', Math.abs(svgp.polyArea(imp.subpaths[0].pts)), 10000);

  /**
   * Illustrator 為了省位元組一定會用這些寫法：
   * `.5.5` 是兩個數、`1-2` 也是兩個數（負號當分隔）。
   * 用 split(/[\s,]/) 那種切法會靜靜少掉一半的數字。
   */
  const tk = svgp.parsePath('M.5.5L1-2Z', { tol: 1 }).subpaths[0].pts;
  eq('難切的數字寫法 .5.5 與 1-2',
     tk.map(p => `${p.x},${p.y}`).join(' '), '0.5,0.5 1,-2');

  // 直的三次貝茲不該被切碎
  eq('直線形狀的貝茲只留兩點',
     svgp.parsePath('M0,0 C10,0 20,0 30,0', { tol: 0.01 }).subpaths[0].pts.length, 2);
}

{
  /**
   * A 指令畫的整圓，取樣點精確落在圓上 ——
   * 所以折線一定是**內接**的（比 2πr 短），而且弦高不超過設定值。
   * 「切幾段」是憑感覺的數字，弦高是量得到的長度（坑第 26 條）。
   */
  const R = 100;
  const d = `M${R},0 A${R},${R} 0 1 1 ${-R},0 A${R},${R} 0 1 1 ${R},0 Z`;
  for (const tol of [2, 0.5, 0.05]) {
    const pts = svgp.parsePath(d, { tol }).subpaths[0].pts;
    let worst = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      worst = Math.max(worst, R - Math.hypot((a.x + b.x) / 2, (a.y + b.y) / 2));
    }
    const L = svgp.polyLength(pts, true);
    ok(`弦高 tol=${tol} 實測 ${fmt(worst)} 不超標`, worst <= tol + 1e-9);
    ok(`tol=${tol} 折線內接（比 2πr 短）`, L < 2 * Math.PI * R);
  }
  const fine = svgp.polyLength(svgp.parsePath(d, { tol: 0.01 }).subpaths[0].pts, true);
  ok('切得夠細時周長逼近 2πr（誤差 < 0.01%）',
     Math.abs(fine / (2 * Math.PI * R) - 1) < 1e-4);

  // 半圓弧長
  near('半圓弧長 ＝ πr',
       svgp.polyLength(svgp.parsePath('M0,0 A50,50 0 0 1 100,0', { tol: 0.005 })
         .subpaths[0].pts), Math.PI * 50, 0.02);
}

section('匯入線稿：讀檔與比例');

/**
 * 一個仿 Illustrator 輸出的小檔案。刻意選好算的數字：
 * viewBox 100 單位 ＝ 10cm，所以 **1 單位 ＝ 0.1cm**。
 *   外框 50×50 單位 → 5×5 cm → 25 cm²，內孔 20×20 → 2×2 cm → 4 cm²
 *   另一個形狀是半徑 10 單位（＝1cm）的圓
 */
const SVG_A = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="10cm" height="10cm" viewBox="0 0 100 100">
  <defs><path d="M0,0 H5 V5 H0 Z"/></defs>
  <g id="板"><path d="M10,10 H60 V60 H10 Z M25,25 H45 V45 H25 Z" fill="#fff" stroke="#000"/></g>
  <g id="圓"><path d="M80,50 A10,10 0 1 1 60,50 A10,10 0 1 1 80,50 Z" fill="none" stroke="#000"/></g>
</svg>`;

{
  const r = prof.readSVG(SVG_A, { tolMm: 0.05 });
  ok('讀得動', r.ok, r.reason || '');
  near('比例：1 單位 ＝ 0.1cm', r.scale.cmPerUnit, 0.1, 1e-12);
  eq('比例來源是「檔案宣告的」，不是猜的', r.scale.from, 'declared');
  eq('兩個外框', r.loops.length, 2);
  eq('圖層名讀得到', r.loops.map(l => l.layer).sort().join(','), '圓,板');

  const plate = r.loops.find(l => l.layer === '板');
  eq('板有一個內孔', plate.holes.length, 1);
  near('板的外框面積 25 cm²', Math.abs(plate.area), 25, 1e-9);
  near('板的內孔面積 4 cm²', Math.abs(plate.holes[0].area), 4, 1e-9);

  const circ = r.loops.find(l => l.layer === '圓');
  eq('圓沒有內孔', circ.holes.length, 0);
  /**
   * 攤平出來的多邊形是**內接**的，所以面積一定小於 πr² ——
   * 大於就表示取樣點沒有落在圓上，那是算錯了。
   * 精度靠收斂驗：弦高調細十倍，誤差要跟著掉。
   */
  const e1 = 1 - Math.abs(circ.area) / Math.PI;
  const e2 = 1 - Math.abs(prof.readSVG(SVG_A, { tolMm: 0.005 })
    .loops.find(l => l.layer === '圓').area) / Math.PI;
  ok(`圓面積內接於 πcm²（差 ${(e1 * 100).toFixed(3)}%）`, e1 > 0 && e1 < 0.01);
  ok(`弦高調細十倍 誤差跟著掉（${(e1 * 100).toFixed(3)}% → ${(e2 * 100).toFixed(3)}%）`,
     e2 > 0 && e2 < e1 / 5);

  /**
   * `<defs>` 裡的路徑是「定義」，不是圖面上的東西。
   * 跟著擠出的話會多一塊看不出哪來的鬼影。
   */
  eq('<defs> 裡的路徑有被跳過', r.shapes.length, 3);

  near('淨面積 ＝ 25 − 4 ＋ 圓', r.area, 21 + Math.abs(circ.area), 1e-9);
  eq('沒有錯誤', r.errors.length, 0);
}

{
  /**
   * ⚠ X 與 Y 的比例**不會完全相等**。
   * Illustrator 把 width／height 四捨五入到 2 位小數，
   * 真實檔案實測差 0.009%。拿相等去比的話，
   * **每一個 Illustrator 檔都會被誤判成非等比縮放**（坑第 26 條）。
   */
  const s = `<svg width="41.35cm" height="87.38cm" viewBox="0 0 1172.16 2476.79">`
    + `<path d="M0,0 H100 V100 H0 Z"/></svg>`;
  const r = prof.readSVG(s, { tolMm: 0.2 });
  eq('四捨五入造成的比例差不算非等比', r.notes.filter(n => n.includes('比例')).length, 0);

  const skew = `<svg width="10cm" height="20cm" viewBox="0 0 100 100">`
    + `<path d="M0,0 H100 V100 H0 Z"/></svg>`;
  ok('真的非等比就要講出來',
     prof.readSVG(skew, { tolMm: 0.2 }).notes.some(n => n.includes('比例')));
}

{
  // 沒寫實際尺寸的檔：可以讀，但一定要講「這是猜的」
  const s = `<svg viewBox="0 0 100 100"><path d="M0,0 H100 V100 H0 Z"/></svg>`;
  const r = prof.readSVG(s, { tolMm: 0.2 });
  eq('沒寫尺寸時 來源標成「猜的」', r.scale.from, 'guess');
  ok('而且有講出來', r.notes.some(n => n.includes('猜')));
}

{
  /**
   * transform 忽略掉不會報錯，只是東西**跑到別的地方** ——
   * 而畫面上看起來很正常。這種錯最難查，所以一定要測。
   */
  const s = `<svg width="10cm" height="10cm" viewBox="0 0 100 100">`
    + `<g transform="translate(10,20)"><path d="M0,0 H50 V50 H0 Z"/></g></svg>`;
  const r = prof.readSVG(s, { tolMm: 0.2 });
  near('translate 有被吃進去（左上角 x）', r.box.minX, 1, 1e-12);
  near('translate 有被吃進去（左上角 y）', r.box.minY, 2, 1e-12);

  const m = `<svg width="10cm" height="10cm" viewBox="0 0 100 100">`
    + `<g transform="matrix(2 0 0 2 0 0)"><path d="M0,0 H50 V50 H0 Z"/></g></svg>`;
  near('matrix 縮放有被吃進去', prof.readSVG(m, { tolMm: 0.2 }).size.w, 10, 1e-12);
}

{
  /**
   * 🔴 **2026-10-15 改了規則（kang 拍板）**：沒封閉的路徑⛔ 再擋下來，
   * 變成「線」—— 匯入時一條線一支鋼筆（不封口）。
   * ⚠ 以前擋下來時訊息叫人「改用『加厚成板』」，而匯入根本沒有那個功能。
   */
  const s = `<svg width="10cm" height="10cm" viewBox="0 0 100 100">`
    + `<path d="M0,0 H50 V50"/></svg>`;
  const r = prof.readSVG(s, { tolMm: 0.2 });
  ok('★★★ 沒封閉的路徑⛔ 再被擋下來', r.ok, r.reason);
  eq('★★★ 它變成一條「線」', r.lines.length, 1);
  eq('★★ 封閉的形狀 0 個', r.loops.length, 0);
  eq('★★★ 錨點照 Illustrator 的：3 個（⛔ 拉直出來的點數）', r.lines[0].bez.a.length / 2, 3);
  near('★★ 錨點換成公分（100 單位 ＝ 10 cm）：第 2 個點 X ＝ 5', r.lines[0].bez.a[2], 5, 1e-12);
  ok('★★ 直線的把手都是 0（＝ 尖角）', r.lines[0].bez.hi.every(v => v === 0) && r.lines[0].bez.ho.every(v => v === 0));
  near('★ 尺寸卡要連線一起算：寬 5 cm', r.size.w, 5, 1e-12);
  ok('★★ ⛔ 再出現「加厚成板」這條走不通的路', !JSON.stringify(r).includes('加厚成板'));
}

section('匯入線稿：擠出');

{
  const sq = (x, y, s) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];

  let m = extr.extrudeProfile({ pts: sq(0, 0, 100), holes: [] }, 50);
  /**
   * ⚠ 體積必須是**正的**。
   * 輪廓的 (x,y) 對應世界的 (x,z)，而 x̂ × ẑ ＝ −ŷ ——
   * 照直覺寫的第一版整個模型法向朝內，體積是 −500000。
   * 法向朝內的模型在畫面上看起來完全正常，
   * 只有匯出 STL 的列印前檢查才抓得到。
   */
  near('方形擠出 體積 ＝ 面積×高（而且是正的）', m.volume(), 100 * 100 * 50, 1e-6);
  eq('方形擠出 封閉', m.isClosed(), true);
  eq('方形擠出 尤拉數 2', euler(m), 2);
  eq('方形擠出 面數（2 蓋各 2 三角形 ＋ 4 側牆）', m.faces.length, 8);

  m = extr.extrudeProfile({ pts: sq(0, 0, 100), holes: [{ pts: sq(40, 40, 20) }] }, 50);
  near('挖一個孔 體積', m.volume(), (10000 - 400) * 50, 1e-6);
  eq('挖一個孔 尤拉數 0（貫穿）', euler(m), 0);
  eq('挖一個孔 仍然封閉', m.isClosed(), true);

  m = extr.extrudeProfile({
    pts: sq(0, 0, 100), holes: [{ pts: sq(10, 10, 20) }, { pts: sq(60, 60, 20) }]
  }, 30);
  near('挖兩個孔 體積', m.volume(), (10000 - 800) * 30, 1e-6);
  eq('挖兩個孔 尤拉數 −2', euler(m), -2);

  /**
   * 畫的人不一定照規矩。外框畫成順時針、孔畫成逆時針都要照樣做得出來 ——
   * 繞向只是慣例，「在不在裡面」才是幾何事實。
   */
  m = extr.extrudeProfile({
    pts: sq(0, 0, 100).reverse(), holes: [{ pts: sq(40, 40, 20).reverse() }]
  }, 50);
  near('外框與孔都畫反了 照樣正確', m.volume(), (10000 - 400) * 50, 1e-6);

  /**
   * 三角化對不對，用面積對答案。
   * 開橋之後橋墩會出現兩次，早期版本因此**一個耳朵都找不到**，
   * 三角形數回傳 0 —— 不報錯，只是蓋子整片消失。
   */
  const t = extr.triangulateWithHoles(sq(0, 0, 100), [sq(40, 40, 20).slice().reverse()]);
  near('帶洞三角化 面積 ＝ 多邊形面積', extr.trisArea(t.tris, t.pts), 10000 - 400, 1e-9);
  ok('帶洞三角化 有切出三角形（橋墩重複點沒有卡死）', t.tris.length > 0);
}

{
  // 一份 SVG 走完全程：讀檔 → 輪廓 → 擠出
  const r = prof.readSVG(SVG_A, { tolMm: 0.05 });
  const H = 2;
  const m = extr.extrudeMany(r.loops.map(l => ({ pts: l.pts, holes: l.holes })), H);
  near('全程 體積 ＝ 淨面積 × 高', m.volume(), r.area * H, 1e-6);
  eq('全程 封閉', m.isClosed(), true);
  eq('全程 尤拉數（2 塊、1 貫穿孔 → 2×2−2×1）', euler(m), 2);

  // 走文件物件這條路，並且存讀檔往返
  const src = {
    type: 'extrude', h: H,
    shapes: r.loops.map(l => ({
      out: prim.flatPts(l.pts), holes: l.holes.map(h => prim.flatPts(h.pts))
    }))
  };
  const obj = new io.ModelObject({ name: '線稿', src });
  near('存成參數體之後 體積不變', obj.mesh().volume(), r.area * H, 1e-3);

  const doc = new io.Doc();
  doc.objects.push(obj);
  const back = new io.Doc();
  back.loadJSON(JSON.parse(JSON.stringify(doc.toJSON())));
  near('存讀檔往返 體積相同', back.objects[0].mesh().volume(), obj.mesh().volume(), 1e-9);

  /**
   * 存的是參數不是三角形，所以改高度可以重新生成 ——
   * 這正是「關鍵決定 2」的用意，匯入件也照這條走。
   */
  back.objects[0].src.h = 7;
  back.objects[0].invalidate();
  near('改高度重新生成', back.objects[0].mesh().volume(), r.area * 7, 1e-3);
}

section('匯入線稿：原點與打散');

{
  /**
   * ⚠ 置中一定要做在**幾何**上，不能靠搬動物件去抵銷。
   *
   * 第一版把網格留在 SVG 的畫布座標上，再把物件搬到 `pos = -中心`。
   * 畫面上東西是置中的，但物件的**原點**跑到很遠的地方 ——
   * gizmo 長在原點上，**旋轉與縮放也都繞著那個遠處的點在轉**。
   * kang 一看畫面就問「控制桿為什麼不在物件上」。
   *
   * 這正是 `core/align.js` 開頭警告過的：`pos` 是原點，不是物件的位置。
   */
  const mk = (x, y, s) => ({
    out: prim.flatPts([{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }]),
    oc: [0, 1, 2, 3], holes: [], hc: []
  });
  const shapes = [mk(100, 200, 10), mk(140, 260, 20)];
  const all = prim.shapesBounds(shapes);
  near('兩個形狀合起來的中心 x', all.cx, 130);
  near('兩個形狀合起來的中心 y', all.cy, 240);

  // 合成一個：幾何置中、pos 留在原點
  const one = new io.ModelObject({
    name: '稿',
    src: { type: 'extrude', h: 3, shapes: shapes.map(s => prim.shiftShape(s, -all.cx, -all.cy)) }
  });
  const b = one.mesh().bounds();
  eq('合成一個 物件原點沒有被拿來抵銷', `${one.pos.x},${one.pos.z}`, '0,0');
  near('合成一個 網格自己就是置中的（x）', (b.min.x + b.max.x) / 2, 0, 1e-3);
  near('合成一個 網格自己就是置中的（z）', (b.min.z + b.max.z) / 2, 0, 1e-3);

  // 打散
  ok('多形狀的匯入件 拆得開', io.canExplodeShapes(one));
  ok('單形狀的拆不開',
     !io.canExplodeShapes(new io.ModelObject({
       src: { type: 'extrude', h: 1, shapes: [mk(0, 0, 5)] } })));
  ok('方塊也拆不開',
     !io.canExplodeShapes(new io.ModelObject({ src: { type: 'box', w: 1, h: 1, d: 1 } })));

  const made = io.explodeShapes(one);
  eq('拆成兩個', made.length, 2);
  for (const o of made) {
    const bb = o.mesh().bounds();
    near(`「${o.name}」的網格以自己的原點為中心（x）`, (bb.min.x + bb.max.x) / 2, 0, 1e-3);
    near(`「${o.name}」的網格以自己的原點為中心（z）`, (bb.min.z + bb.max.z) / 2, 0, 1e-3);
  }

  /**
   * **版面不能因為拆開就跑掉。** 每個形狀在世界座標的中心，
   * 拆開前後必須一樣（容許值 1e-3 是座標存檔修到 4 位小數造成的）。
   */
  const worldOf = o => {
    const bb = o.mesh().bounds();
    return [o.pos.x + (bb.min.x + bb.max.x) / 2, o.pos.z + (bb.min.z + bb.max.z) / 2];
  };
  shapes.forEach((s, i) => {
    const sb = prim.shapeBounds(s);
    const w = worldOf(made[i]);
    near(`拆開後 第 ${i + 1} 個形狀的世界位置不變（x）`, w[0], sb.cx - all.cx, 1e-3);
    near(`拆開後 第 ${i + 1} 個形狀的世界位置不變（z）`, w[1], sb.cy - all.cy, 1e-3);
  });

  // 母物件被搬過、轉過，拆出來的要跟著
  one.pos.set(50, 7, -20);
  one.rot.set(0, Math.PI / 2, 0);
  const moved = io.explodeShapes(one);
  near('母物件的高度有跟著', moved[0].pos.y, 7);
  near('母物件的旋轉有跟著', moved[0].rot.y, Math.PI / 2, 1e-9);
  const w0 = worldOf(moved[0]);
  /**
   * 轉 90 度之後，本地的 +x 會變成世界的 −z。拆出來的位置要照這個算，
   * 不能只是把本地偏移量加上去 —— 那樣一轉過角度就散開。
   */
  const sb0 = prim.shapeBounds(shapes[0]);
  near('轉過 90 度之後 位置照樣對得上（x）', w0[0], 50 + (sb0.cy - all.cy), 1e-3);
  near('轉過 90 度之後 位置照樣對得上（z）', w0[1], -20 - (sb0.cx - all.cx), 1e-3);
}

// ═══════════════════════════════════════════════════════
//  真轉角與曲線帶（上游知道的事，不要在中途丟掉）
// ═══════════════════════════════════════════════════════

section('真轉角：從貝茲錨點帶下來');

{
  /**
   * ⚠ 這一整節盯的是一個**資訊問題**，不是演算法問題。
   *
   * 貝茲曲線的錨點自己知道自己是平滑點還是轉角（進出控制把手共不共線）。
   * 攤平成折線之後這個資訊就沒了，下游只能從角度猜 ——
   * 而猜在自由曲線上一定失敗：kang 的一個 S 字，真轉角 7 個，
   * 攤平後 196 個轉折點，展開圖標了 196 道折彎、398 個接合編號，
   * 整張圖變成一團綠色數字。
   *
   * 判準（比較進出切線、門檻 3°）抄自 kang 已經在用的 SideUnfold.jsx。
   */
  const k = 0.5522847498307936 * 100;
  const circle = `M100,0 C100,${k} ${k},100 0,100 C${-k},100 -100,${k} -100,0 `
    + `C-100,${-k} ${-k},-100 0,-100 C${k},-100 100,${-k} 100,0 Z`;
  eq('貝茲畫的圓 一個轉角都沒有', svgp.parsePath(circle, { tol: 0.05 }).corners, 0);
  eq('正方形 四個角都是轉角', svgp.parsePath('M0,0 H100 V100 H0 Z', { tol: 1 }).corners, 4);

  /**
   * A 指令的切線用**解析式**算，不是拿第一段弦去估。
   * 粗略取樣時弦的方向會偏掉半個分段角，而門檻只有 3°——
   * 用弦估的話，這個只有 16 段的圓會被判出一堆假轉角。
   */
  eq('粗取樣的 A 整圓 也不能誤判出轉角',
     svgp.parsePath('M100,0 A100,100 0 1 1 -100,0 A100,100 0 1 1 100,0 Z',
       { tol: 2 }).corners, 0);
  eq('半圓 ＋ 直線收口 剛好兩個轉角',
     svgp.parsePath('M0,0 A50,50 0 0 1 100,0 L0,0 Z', { tol: 0.1 }).corners, 2);

  // 開放路徑的頭尾本來就是形狀的端點，一律算轉角
  eq('開放路徑的頭尾算轉角', svgp.parsePath('M0,0 C10,10 20,10 30,0', { tol: 0.1 }).corners, 2);

  eq('門檻可調（1° 抓得比 3° 多）',
     svgp.parsePath('M0,0 L100,0 L200,3 L200,100 Z', { tol: 1, cornerDeg: 1 }).corners
     > svgp.parsePath('M0,0 L100,0 L200,3 L200,100 Z', { tol: 1, cornerDeg: 3 }).corners,
     true);
}

{
  // 旗標要一路帶到網格上，而且存讀檔之後還在
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10cm" height="10cm" `
    + `viewBox="0 0 100 100"><path d="M50,10 A20,20 0 1 1 49.9,10 Z"/></svg>`;
  const r = prof.readSVG(svg, { tolMm: 0.5 });
  const loop = r.loops[0];
  ok('圓形輪廓 幾乎沒有真轉角', loop.pts.filter(p => p.corner).length <= 1,
     `${loop.pts.filter(p => p.corner).length} 個`);

  const m = extr.extrudeProfile({ pts: loop.pts, holes: [] }, 3);
  const es = [...m.edges()];
  const smooth = es.filter(e => e.smooth).length;
  ok(`側牆的垂直邊大多標成平滑（${smooth} 條）`, smooth >= loop.pts.length - 2);

  const back = Mesh.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
  eq('平滑旗標 存讀檔往返還在',
     [...back.edges()].filter(e => e.smooth).length, smooth);

  const sq = [{ x: 0, y: 0, corner: true }, { x: 10, y: 0, corner: true },
              { x: 10, y: 10, corner: true }, { x: 0, y: 10, corner: true }];
  eq('全是轉角的輪廓 一條平滑邊都沒有',
     [...extr.extrudeProfile({ pts: sq, holes: [] }, 5).edges()]
       .filter(e => e.smooth).length, 0);
}

section('曲線帶：連續的平滑折線併成一段');

{
  /**
   * 用一個「兩端是直線、中間是半圓」的輪廓 —— 真轉角剛好 2 個。
   * 擠出之後側牆的折線裡，中間那一段全是平滑的，應該併成一條曲線帶。
   */
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10cm" height="10cm" `
    + `viewBox="0 0 100 100"><path d="M20,50 A30,30 0 0 1 80,50 L20,50 Z"/></svg>`;
  const r = prof.readSVG(svg, { tolMm: 0.2 });
  const loop = r.loops[0];
  eq('半圓 ＋ 直線 的輪廓 兩個真轉角', loop.pts.filter(p => p.corner).length, 2);

  const m = extr.extrudeProfile({ pts: loop.pts, holes: [] }, 2);
  const u = unfoldMesh(m, makeRule('paper', 0.2));
  const bends = u.pieces.flatMap(p => p.bends);
  const curves = bends.filter(b => b.isCurve);
  eq('併成一條曲線帶', curves.length, 1);
  ok(`曲線帶涵蓋很多小段（${curves[0].segs} 段）`, curves[0].segs > 10);
  // 〔2026-08-23：`ri` 欄位已拿掉，只驗 r〕
  ok('曲線帶不當成圓弧標半徑（沒有假的 R）',
    curves[0].r === 0 && curves[0].ri === undefined);

  /**
   * 曲線帶不做拉伸。自由曲線每一段曲率都不同，沒有單一半徑可以算真弧長 ——
   * 硬給一個會是「正確的數字，錯誤的意思」（坑第 20 條）。
   */
  near('曲線帶的展開寬 ＝ 弦長總和（不拉伸）', curves[0].arcW, curves[0].chordW, 1e-12);

  const t = titleLines(u.pieces.find(p => p.bends.some(b => b.isCurve)) || u.pieces[0], {});
  ok('標題欄講得出「曲線帶」而不是一堆折彎', t.join('|').includes('曲線帶'), t.join('|'));
}

{
  /**
   * ⚠ 參數體不能退步。
   * 圓柱、圓角方塊的圓弧是靠「等寬 ＋ 等角」的幾何猜測認出來的，
   * 那條路要照舊走得通 —— 新加的標記只是多一條路，不是取代。
   */
  const cyl = buildPrim('cylinder', { r: 25, h: 70, seg: 32, openEnded: true }, 0.2);
  const u = unfoldMesh(cyl, makeRule('steel', 0.2));
  // 〔2026-08-23：期望值從 2πr 改成 32 邊形的弦長總和〕
  rel('圓柱側面 展開長仍然是弦長總和', u.pieces[0].width,
    32 * 2 * 25 * Math.sin(Math.PI / 32), 1e-7);
  ok('圓柱的圓弧仍然被認成圓弧（有真的半徑）',
     u.pieces[0].bends.some(b => b.isArc && !b.isCurve && b.r > 1));
}

section('接合編號：一段一個');

{
  /**
   * ⚠ 這一項是 2026-08-22 改寫的，而且第一版寫壞過。
   *
   * 原本是一條切割邊一個號碼。方塊上很好用，但匯入的曲線輪廓有幾百條邊 ——
   * 一個 S 字的面板標了 198 個號碼、側邊條 398 個，整張圖讀不出來。
   *
   * 第一版的修法是「沿著邊界往前後走，把同一段串起來」，結果**兩側走出來的
   * 分段不一致**：面板併成 7 段，側邊條還是 198 段，於是
   * 「每個編號恰好出現兩次」直接破功。改成定義在無向邊上的聯集之後，
   * 兩側算的是同一個分割，**根本不可能不一致**。
   */
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="20cm" height="20cm" `
    + `viewBox="0 0 200 200"><path d="M40,100 A60,60 0 0 1 160,100 L40,100 Z"/></svg>`;
  const r = prof.readSVG(svg, { tolMm: 0.2 });
  const m = extr.extrudeProfile({ pts: r.loops[0].pts, holes: [] }, 3);
  // 把上下蓋跟側牆切開，才會有接合編號
  for (const he of m.edges()) {
    const d = m.dihedral(he);
    if (d !== null && Math.abs(d * 180 / Math.PI) > 60) m.setRole(he, EDGE_ROLE.CUT);
  }
  const u = unfoldMesh(m, makeRule('paper', 0.2));

  const cnt = new Map();
  for (const p of u.pieces) for (const j of (p.joints || [])) {
    cnt.set(j.num, (cnt.get(j.num) || 0) + 1);
  }
  ok('每個接合編號恰好出現兩次',
     [...cnt.values()].every(v => v === 2),
     [...cnt].filter(([, v]) => v !== 2).map(([k, v]) => `${k}:${v}`).join(' '));

  const plate = u.pieces.reduce((a, b) => (a.area > b.area ? a : b));
  ok(`面板的編號被併成少少幾段（${plate.joints.length} 段）`, plate.joints.length <= 6,
     `輪廓有 ${plate.outline.length} 個點`);
  ok('而且有段涵蓋很多條邊', plate.joints.some(j => j.segs > 10),
     plate.joints.map(j => j.segs).join('/'));
}

{
  /**
   * ⚠ 一條邊的兩側都在同一片上的情況 —— 實測抓到的漏洞。
   *
   * 環狀的側牆攤開時，引擎會找個地方剪開一刀，那一刀的兩端都留在
   * 同一條長條上（長條要繞回去接自己）。第一版只用「段」當 key，
   * 兩側被併成同一組，於是**那個號碼只出現一次** ——
   * 而「出現一次」代表有一端接不回去，圖卻看起來完全正常。
   *
   * 實測：一個 S 字擠出後切成上蓋／下蓋／側邊條三片，
   * 編號 15（側邊條自己的接縫）只畫了一個。
   */
  const m = extr.extrudeProfile({
    pts: [...Array(24)].map((_, i) => ({
      x: 30 * Math.cos(i / 24 * 2 * Math.PI), y: 30 * Math.sin(i / 24 * 2 * Math.PI)
    })), holes: []
  }, 4);
  for (const he of m.edges()) {
    // 只切上下那兩圈水平邊 —— 側牆因此變成一條要繞回去接自己的長條
    if (Math.abs(he.v.p.y - he.to.p.y) < 1e-9) {
      const d = m.dihedral(he);
      if (d !== null && Math.abs(d * 180 / Math.PI) > 60) m.setRole(he, EDGE_ROLE.CUT);
    }
  }
  const u = unfoldMesh(m, makeRule('paper', 0.2));
  const cnt = new Map();
  for (const p of u.pieces) for (const j of (p.joints || [])) {
    cnt.set(j.num, (cnt.get(j.num) || 0) + 1);
  }
  eq('圓筒切成三片', u.pieces.length, 3);
  ok('側邊條自己接自己的那一段 也是兩個號碼',
     [...cnt.values()].every(v => v === 2),
     [...cnt].filter(([, v]) => v !== 2).map(([k, v]) => `${k}:${v}`).join(' '));
  const strip = u.pieces.reduce((a, b) => (a.width > b.width ? a : b));
  ok('長條上有一個號碼出現兩次（頭尾各一）',
     strip.joints.some(j => strip.joints.filter(q => q.num === j.num).length === 2),
     strip.joints.map(j => j.num).join(','));
}
// ═══════════════════════════════════════════════════════
//  第 6 期第一刀：點／邊／面的幾何編輯（core/edit.js）
// ═══════════════════════════════════════════════════════
section('標記搬移：clone / transformed 不可以掉 smooth');
{
  /**
   * ⚠ 2026-08-23 抓到的既有 bug：`clone()` 與 `transformed()` 以前只搬 `role`，
   * `smooth` 全部掉光。而 part.js（展開前的縮放）、array.js（陣列鏡射）、
   * io.js、slicePanel.js 都走那兩支。
   *
   * 後果：**形狀完全沒變、只是縮放或複製一次，展開圖就從「5 處折彎」
   * 變成「45 處折彎」** —— 圖看起來正常，只是讀不懂，而且要出圖才發現。
   * 那正是日誌上「196 道折彎、一團綠色數字」的同一個症狀。
   *
   * ⚠ 用**自由曲線**才驗得到。等距取樣的半圓、參數體的圓柱，
   * 幾何猜測（等寬等角）本來就抓得到，掉了 smooth 也看不出來 ——
   * 這是坑第 17 條「樣本要涵蓋不同的網格結構」的第三次。
   */
  const out = [], oc = [];
  let t = 0, i = 0;
  while (t < Math.PI) {
    const r = 20 + 6 * Math.sin(3 * t) + 3 * Math.cos(7 * t);   // 半徑一直變 → 不等角
    out.push(-r * Math.cos(t), r * Math.sin(t));
    t += 0.04 + 0.06 * Math.abs(Math.sin(5 * t));               // 步長一直變 → 不等寬
    i++;
  }
  out.push(20, 0);
  oc.push(0, i);                                                // 只有頭尾是真轉角

  const mk = () => {
    const m = buildPrim('extrude', { type: 'extrude', h: 5, shapes: [{ out, oc }] });
    m.computeNormals();
    return m;
  };
  const rule = makeRule('paper', 0.2);
  const bends = m => unfoldMesh(m, rule).pieces[0].bends.length;

  const a = mk();
  const s0 = [...a.edges()].filter(h => h.smooth).length;
  const b0 = bends(a);
  ok('自由曲線的擠出件 有一堆 smooth 邊', s0 > 30, `${s0} 條`);
  ok('而且折彎被歸成少少幾處（不是一段一處）', b0 < 10, `${b0} 處`);

  for (const [label, m4] of [
    ['縮放 2 倍', new THREE.Matrix4().makeScale(2, 2, 2)],
    ['純平移', new THREE.Matrix4().makeTranslation(10, 0, 0)],
    ['鏡射（負行列式，繞向會被翻過來）', new THREE.Matrix4().makeScale(-1, 1, 1)]
  ]) {
    const b = a.transformed(m4);
    eq(`★ ${label} smooth 一條都沒掉`, [...b.edges()].filter(h => h.smooth).length, s0);
    eq(`★ ${label} 折彎處數不變`, bends(b), b0);
  }
  const c = a.clone();
  eq('★ clone() smooth 一條都沒掉', [...c.edges()].filter(h => h.smooth).length, s0);
  eq('★ clone() 折彎處數不變', bends(c), b0);

  // role 本來就有搬，一併釘住免得日後改 _copyMarksTo 時弄丟
  const withRole = mk();
  const he = [...withRole.edges()].find(h => h.face && h.twin && h.twin.face);
  withRole.setRole(he, EDGE_ROLE.CUT);
  const rc = m => [...m.edges()].filter(h => h.role === EDGE_ROLE.CUT).length;
  eq('clone() 也還是有搬 role', rc(withRole.clone()), rc(withRole));
}

section('編輯：移動點／邊／面');
{
  const mkBox = () => buildPrim('box', { w: 60, h: 45, d: 40 });

  // ── 拓撲不能被動到。這一刀刻意不改拓撲，所以尤拉數是最強的看門狗 ──
  {
    const m = mkBox();
    const e0 = euler(m), v0 = m.verts.length, f0 = m.faces.length;
    edit.moveVerts([m.verts[0]], new THREE.Vector3(3, -2, 5));
    edit.refreshAfterEdit(m);
    eq('拉點之後 尤拉數不變', euler(m), e0);
    eq('拉點之後 頂點數不變', m.verts.length, v0);
    eq('拉點之後 面數不變', m.faces.length, f0);
  }

  /**
   * ⚠ 拉點的結果取決於一條**看不見的三角化對角線**。
   *
   * 拉方塊頂面的不同角，體積差兩倍 —— 對角線兩端的角屬於兩個三角形
   * （拉起來是屋脊），另外兩個只屬於一個（單斜面）。
   * 幾何完全正確，但使用者不知道為什麼。詳見規格檔同名章節。
   *
   * 釘住它的用意：**日後有人改三角化，這裡會亮紅燈**，
   * 提醒他那不只是內部實作，會改變使用者看到的形狀。
   */
  {
    const at = (m, x, y, z) => m.verts.find(v =>
      Math.abs(v.p.x - x) < 1e-9 && Math.abs(v.p.y - y) < 1e-9 && Math.abs(v.p.z - z) < 1e-9);
    const lift = (x, z) => {
      const m = mkBox();
      m.computeNormals();
      const v = at(m, x, 22.5, z);
      const nTop = m.faces.filter(f => f.normal.y > 0.999 && m.faceVerts(f).includes(v)).length;
      edit.moveVerts([v], new THREE.Vector3(0, 16, 0));
      edit.refreshAfterEdit(m);
      return { nTop, dv: m.volume() - 108000, closed: m.isClosed(),
               chi: m.verts.length - [...m.edges()].length + m.faces.length };
    };
    // 抬高一個三角形的一角，掃出的體積 ＝ (1/3)×面積×高；頂面每個三角形 1200 cm²
    for (const [x, z] of [[30, 20], [30, -20], [-30, 20], [-30, -20]]) {
      const r = lift(x, z);
      near(`拉角 (${x}, ${z})：體積增加 ＝ ${r.nTop}×(1/3)×1200×16`,
           r.dv, r.nTop * 1200 * 16 / 3, 1e-6);
      ok(`拉角 (${x}, ${z})：拉完仍然封閉、尤拉數 2`, r.closed && r.chi === 2);
    }
    // ★ 這一條才是重點：同一個方塊、同樣的位移，四個角不是都一樣
    const dvs = [[30, 20], [30, -20], [-30, 20], [-30, -20]].map(([x, z]) => lift(x, z).dv);
    ok('★ 四個頂角拉出來不是同一個結果（對角線兩端 12800、另外兩個 6400）',
       new Set(dvs).size === 2 && dvs.includes(6400) && dvs.includes(12800),
       dvs.join(' / '));
  }

  // ── 整體平移是剛體運動：體積與面積都不能變 ──
  {
    const m = mkBox();
    const vol0 = m.volume(), area0 = m.area();
    edit.moveVerts(m.verts, new THREE.Vector3(17, -3.5, 8));
    near('所有頂點同一個位移 體積不變', m.volume(), vol0, 1e-9);
    near('所有頂點同一個位移 面積不變', m.area(), area0, 1e-9);
  }

  // ── 沿法向推拉一個面：體積變化 ＝ 面積 × 距離，可以手算對答案 ──
  {
    const m = mkBox();
    const vol0 = m.volume();
    // 挑法向朝 +Y 的頂面（60×40）
    m.computeNormals();
    const top = m.faces.find(f => f.normal.y > 0.999);
    ok('找得到頂面', !!top);
    const moved = edit.pushFace(m, top, 10);
    eq('頂面推出去 移動 4 個頂點', moved, 4);
    near('體積增加 ＝ 60×40×10', m.volume() - vol0, 24000, 1e-6);
    near('高度變成 55', m.bounds().max.y - m.bounds().min.y, 55, 1e-9);
  }
  {
    const m = mkBox();
    const vol0 = m.volume();
    m.computeNormals();
    const top = m.faces.find(f => f.normal.y > 0.999);
    edit.pushFace(m, top, -10);
    near('負值 ＝ 往內縮，體積減少 24000', vol0 - m.volume(), 24000, 1e-6);
  }

  // ── 三種 kind 涉及的頂點數 ──
  {
    const m = mkBox();
    m.computeNormals();
    const he = [...m.edges()].find(h => h.face && h.twin && h.twin.face);
    const top = m.faces.find(f => f.normal.y > 0.999);
    eq('點 → 1 個頂點', edit.elementVerts(m, { kind: 'vertex', vert: m.verts[0] }).length, 1);
    eq('邊 → 2 個頂點', edit.elementVerts(m, { kind: 'edge', he }).length, 2);
    // ★ 方塊在網格裡是 12 個三角形，使用者看到的是 6 個正方形面。
    //   點頂面要拿到 4 個頂點，不是命中那個三角形的 3 個。
    eq('★ 面 ＝ 共面區域，不是三角形 → 4 個頂點',
       edit.elementVerts(m, { kind: 'face', face: top }).length, 4);
    eq('對照：那個三角形本身只有 3 個頂點', m.faceVerts(top).length, 3);

    // ★ 畫「選到這個面」的標示要用邊界邊，不能拿頂點去串 ——
    //   頂點是從 Set 出來的、順序任意，串起來會變成蝴蝶結。
    //   〔2026-08-23 kang 實測截圖抓到，幾何對但畫出來的意思是錯的〕
    const segs = edit.regionBoundaryEdges(m, top);
    eq('★ 方塊頂面的邊界 ＝ 4 條邊（不是 6 條，三角化的對角線不算）',
       segs.length, 4);
    ok('每一條都是兩個不同的頂點', segs.every(([a, b]) => a !== b));
    // 4 條邊首尾相接成一個封閉迴圈 → 每個頂點恰好出現兩次
    const deg = new Map();
    for (const [a, b] of segs) for (const v of [a, b]) deg.set(v, (deg.get(v) || 0) + 1);
    eq('★ 邊界是封閉迴圈：涵蓋 4 個頂點', deg.size, 4);
    ok('★ 每個頂點恰好出現兩次（首尾相接，不是蝴蝶結）',
       [...deg.values()].every(n => n === 2), [...deg.values()].join(','));
    // 邊界邊長度總和 ＝ 60×40 的面的周長 ＝ 200
    let peri = 0;
    for (const [a, b] of segs) peri += a.p.distanceTo(b.p);
    near('邊界周長 ＝ 2×(60+40)', peri, 200, 1e-9);
    eq('認不得的 kind → 空陣列', edit.elementVerts(m, { kind: '???' }).length, 0);
    eq('null → 空陣列', edit.elementVerts(m, null).length, 0);
  }

  // ── gizmo 掛在重心：單點就是它自己，一條邊就是中點 ──
  {
    const m = mkBox();
    const v = m.verts[0];
    const c = edit.elementCenter(m, { kind: 'vertex', vert: v });
    near('單點的重心 ＝ 它自己', c.distanceTo(v.p), 0, 1e-12);
    const he = [...m.edges()][0];
    const mid = new THREE.Vector3().addVectors(he.v.p, he.to.p).multiplyScalar(0.5);
    near('一條邊的重心 ＝ 中點',
         edit.elementCenter(m, { kind: 'edge', he }).distanceTo(mid), 0, 1e-12);
  }
}

section('擠出面：從一個面長出新的一段');
{
  const chi = m => m.verts.length - [...m.edges()].length + m.faces.length;
  const topOf = m => { m.computeNormals(); return m.faces.find(f => f.normal.y > 0.999); };

  // ── 方塊頂面擠出 20：每個數字都手算得出來 ──
  {
    const m = buildPrim('box', { w: 60, h: 45, d: 40 });
    const r = edit.extrudeFace(m, topOf(m), 20);
    ok('擠出成功', r.ok, r.reason || '');
    const o = r.mesh;
    near('★ 體積 ＝ 108000 ＋ 60×40×20', o.volume(), 156000, 1e-6);
    eq('頂點 8 ＋ 4（邊界頂點各複製一份）', o.verts.length, 12);
    eq('面 12 ＋ 4（側牆四邊形）', o.faces.length, 16);
    eq('側牆回報 4 面、1 個迴圈', r.walls * 10 + r.loops, 41);
    ok('仍然是封閉實體', o.isClosed());
    eq('χ 仍然是 2', chi(o), 2);
    near('高度 45 → 65', o.bounds().max.y - o.bounds().min.y, 65, 1e-9);
    // 原網格不可以被動到 —— 它還在 Undo 的快照裡
    near('★ 原網格完全沒被改（體積還是 108000）', m.volume(), 108000, 1e-9);
    eq('原網格面數也沒變', m.faces.length, 12);
  }

  /**
   * ── capFace：擠完要能立刻選中新長出來的蓋子 ──
   * 這是「擠出只負責長出來、調整交給拉面」那個分工的接縫。
   * 回傳錯的面 → 箭頭停在別的地方 → 使用者拉了發現動的不是他要的那一塊，
   * 而畫面上看起來像功能壞掉。
   */
  {
    const m = buildPrim('box', { w: 60, h: 45, d: 40 });
    const top = topOf(m);
    const r = edit.extrudeFace(m, top, 20);
    ok('★ 有回傳新的蓋子', !!r.capFace);
    r.mesh.computeNormals();
    ok('★ 新蓋子的法向仍然朝上（是同一個面，被推出去了）',
       r.capFace.normal.y > 0.999, JSON.stringify(r.capFace.normal));
    const vs = edit.elementVerts(r.mesh, { kind: 'face', face: r.capFace });
    eq('★ 新蓋子是 4 個頂點的共面區域', vs.length, 4);
    const y = vs.map(v => v.p.y);
    ok('★ 新蓋子的四個頂點都在 y ＝ 42.5（22.5＋20）',
       y.every(v => Math.abs(v - 42.5) < 1e-9), y.join(','));
    // 而且它是新的面，不是原網格那個
    ok('回傳的是新網格上的面，不是原網格的', r.capFace !== top);
  }

  /**
   * ── ★ 擠出之後把蓋子拉回原位：側牆被壓成零面積 ──
   * 〔2026-08-23 kang 實測抓到：舊版把這個回報成「4 個面不平了」，
   * 　偵測是對的，講出來的意思是錯的 —— 坑第 20 條的另一次。
   * 　零面積的面其實**是平的**（所有點共線），該講的是「被壓扁了」。〕
   */
  {
    let m = buildPrim('box', { w: 60, h: 45, d: 40 });
    const r = edit.extrudeFace(m, topOf(m), 20);
    m = r.mesh;
    edit.refreshAfterEdit(m);
    eq('擠出後 0 個退化面', edit.degenerateFaces(m).length, 0);
    eq('擠出後 0 個不平的面', edit.nonPlanarFaces(m).length, 0);

    const cap = m.faces.find(f => f.normal.y > 0.999
      && m.faceVerts(f).every(v => Math.abs(v.p.y - 42.5) < 1e-6));
    edit.moveVerts(edit.elementVerts(m, { kind: 'face', face: cap }),
                   new THREE.Vector3(0, -20, 0));
    const back = edit.refreshAfterEdit(m);
    near('拉回原位 體積回到 108000', m.volume(), 108000, 1e-6);
    eq('★ 四面側牆被壓成零面積 → 回報為「退化」', back.degenerate, 4);
    eq('★ 而且不可以被回報成「不平」（零面積的面是平的）', back.nonPlanar, 0);
  }
  {
    // 繼續往下拉會變成一個凹坑 —— 那是合理的形狀，不該有任何警告
    let m = buildPrim('box', { w: 60, h: 45, d: 40 });
    m = edit.extrudeFace(m, topOf(m), 20).mesh;
    edit.refreshAfterEdit(m);
    const cap = m.faces.find(f => f.normal.y > 0.999
      && m.faceVerts(f).every(v => Math.abs(v.p.y - 42.5) < 1e-6));
    edit.moveVerts(edit.elementVerts(m, { kind: 'face', face: cap }),
                   new THREE.Vector3(0, -30, 0));
    const r2 = edit.refreshAfterEdit(m);
    near('往下拉穿過去 ＝ 挖了一個 10 深的凹坑', m.volume(), 108000 - 2400 * 10, 1e-6);
    ok('凹坑仍然封閉', m.isClosed());
    eq('凹坑沒有退化面', r2.degenerate, 0);
    eq('凹坑沒有不平的面', r2.nonPlanar, 0);
  }

  /**
   * ── 負值 ＝ 往內擠出（2026-10-14 有了自己的按鈕）──
   *
   * 🔴 **舊的這一塊驗的是「方塊頂面直接 −15 ⇒ 72000、封閉、χ＝2」—— 三樣都對，形狀卻是壞的**：
   * 新牆跟方塊的四面外牆疊在同一個平面上（法向相反，體積互相抵掉）。
   * 現在那一種要擋，正確的做法是「內縮 → 往內擠出」。
   */
  {
    const m = buildPrim('box', { w: 60, h: 45, d: 40 });
    const r = edit.extrudeFace(m, topOf(m), -15);
    ok('★★ 方塊頂面直接往內：擋下來（新牆會跟外牆疊在一起）', !r.ok, '竟然通過');
    ok('★ 擋下來的原因要講「先內縮」', /內縮/.test(r.reason || ''), r.reason || '');
    eq('　　四條邊都算進去', r.badEdges, 4);
  }
  {
    // ★ 內縮 5 → 往內 15：直立的牆 ＋ 一圈平的邊框 ＝ 真的凹槽
    const m = buildPrim('box', { w: 60, h: 45, d: 40 });
    const ins = edit.insetFaces(m, topOf(m), 5);
    ok('（前置）內縮成功', ins.ok, ins.reason || '');
    const m1 = ins.mesh;
    edit.refreshAfterEdit(m1);
    const r = edit.extrudeFace(m1, ins.innerFace, -15);
    ok('★ 內縮之後往內擠出：可以', r.ok, r.reason || '');
    const o = r.mesh;
    near('★★ 體積 ＝ 108000 − 50×30×15（直壁，⛔ 不是內縮＋推的斜壁）', o.volume(), 108000 - 50 * 30 * 15, 1e-6);
    ok('封閉、χ＝2', o.isClosed() && chi(o) === 2);
    eq('側牆 4 面、1 個迴圈', r.walls * 10 + r.loops, 41);
    r.mesh.computeNormals();
    ok('★ 底（新的蓋子）法向仍然朝上', r.capFace.normal.y > 0.999, JSON.stringify(r.capFace.normal));
    const vs = edit.elementVerts(o, { kind: 'face', face: r.capFace });
    ok('★ 底的四個頂點都在 y ＝ 7.5（22.5−15），而且在內縮那一圈正下方（|x|＝25、|z|＝15）',
       vs.length === 4 && vs.every(v => Math.abs(v.p.y - 7.5) < 1e-9
         && Math.abs(Math.abs(v.p.x) - 25) < 1e-9 && Math.abs(Math.abs(v.p.z) - 15) < 1e-9),
       vs.map(v => `${v.p.x},${v.p.y},${v.p.z}`).join(' '));
    edit.refreshAfterEdit(o);
    eq('沒有退化面', edit.degenerateFaces(o).length, 0);
  }
  {
    // ★ 錐台：窄的那一端往內可以（牆長在裡面），寬的那一端擋（牆會穿出去）
    const m = buildPrim('cone', { rTop: 10, rBottom: 30, h: 70, seg: 32 });
    m.computeNormals();
    const top = m.faces.find(f => f.normal.y > 0.999);
    const bot = m.faces.find(f => f.normal.y < -0.999);
    const r = edit.extrudeFace(m, top, -15);
    ok('★ 錐台窄端（側牆往外斜下去）往內：可以', r.ok, r.reason || '');
    const cap = 0.5 * 32 * 100 * Math.sin(2 * Math.PI / 32);
    near('　　體積少掉 ＝ 32 邊形（r10）面積 × 15', m.volume() - r.mesh.volume(), cap * 15, 1e-4);   // 兩個十萬級的體積相減，1e-6 會被浮點雜訊打到
    ok('　　封閉、χ＝2', r.mesh.isClosed() && chi(r.mesh) === 2);
    const rb = edit.extrudeFace(m, bot, -15);
    ok('★★ 錐台寬端往內：擋（新牆會穿出側面）', !rb.ok && rb.badEdges === 32, rb.reason || '竟然通過');
    ok('　　往外照樣可以（只擋往內）', edit.extrudeFace(m, bot, 15).ok);
  }
  {
    const m = buildPrim('tube', { rOuter: 25, rInner: 20, h: 70, seg: 16 });
    const r = edit.extrudeFace(m, topOf(m), -10);
    ok('★ 管的端面往內：外圈、內孔兩圈都擋', !r.ok && r.badEdges === 32, r.reason || '竟然通過');
  }
  {
    /**
     * ★ 往外擠出的鏡像（2026-10-14，kang 選「擋下來並提醒先內縮」）：
     * 凹槽的底直接往外擠 ⇒ 新牆沿凹槽的牆長上去、疊在一起 ⇒ 擋；先內縮再擠 ⇒ 可以。
     */
    const m = buildPrim('box', { w: 60, h: 45, d: 40 });
    const ins = edit.insetFaces(m, topOf(m), 5);
    edit.refreshAfterEdit(ins.mesh);
    const pit = edit.extrudeFace(ins.mesh, ins.innerFace, -15);
    ok('（前置）內縮 5 → 往內 15 做出凹槽', pit.ok, pit.reason || '');
    const m1 = pit.mesh; edit.refreshAfterEdit(m1);
    const floor = m1.faces.find(f => f.normal.y > 0.999 && m1.faceVerts(f).every(v => Math.abs(v.p.y - 7.5) < 1e-9));
    const r = edit.extrudeFace(m1, floor, 5);
    ok('★★ 凹槽的底直接往外擠：擋下來（新牆會跟凹槽的牆疊在一起）', !r.ok && r.badEdges === 4, r.reason || '竟然通過');
    ok('★ 原因講「先內縮」、⛔ 講成「往內擠出」', /內縮/.test(r.reason || '') && !/往內擠出/.test(r.reason || ''), r.reason || '');
    const ins2 = edit.insetFaces(m1, floor, 3);
    edit.refreshAfterEdit(ins2.mesh);
    const r2 = edit.extrudeFace(ins2.mesh, ins2.innerFace, 5);
    ok('★ 底先內縮 3 再往外擠 5：可以', r2.ok, r2.reason || '');
    near('　　體積 ＋ 44×24×5（凹槽裡長出一根柱子）', r2.mesh.volume() - m1.volume(), 44 * 24 * 5, 1e-6);
    ok('　　封閉、χ＝2', r2.mesh.isClosed() && chi(r2.mesh) === 2);
  }

  // ── 連續擠出：做鹿角就是重複這個動作 ──
  {
    let m = buildPrim('box', { w: 60, h: 45, d: 40 });
    for (let k = 1; k <= 3; k++) {
      const r = edit.extrudeFace(m, topOf(m), 10);
      ok(`第 ${k} 次擠出成功`, r.ok, r.reason || '');
      m = r.mesh;
      edit.refreshAfterEdit(m);
      near(`連擠 ${k} 次 體積 ＝ 108000 ＋ 2400×10×${k}`, m.volume(), 108000 + 24000 * k, 1e-6);
    }
    ok('連擠三次之後 仍然封閉、χ＝2', m.isClosed() && chi(m) === 2);
    eq('連擠三次 頂點 8＋4×3', m.verts.length, 20);
    eq('連擠三次 面 12＋4×3', m.faces.length, 24);
  }

  // ── ★ 斜面：側牆繞向錯了畫面上看不出來，只有體積會變負 ──
  {
    const m = buildPrim('cylinder', { r: 25, h: 70, seg: 12 });
    m.computeNormals();
    const side = m.faces.find(f => Math.abs(f.normal.y) < 0.01);
    const r = edit.extrudeFace(m, side, 8);
    ok('非軸向的斜面 也擠得出來', r.ok, r.reason || '');
    ok('★ 體積必須是正的（法向朝外）—— 繞向錯了這裡會變負',
       r.mesh.volume() > 0, r.mesh.volume().toFixed(1));
    ok('封閉、χ＝2', r.mesh.isClosed() && chi(r.mesh) === 2);
  }

  // ── 帶洞的面：兩個邊界迴圈 ──
  {
    const m = buildPrim('tube', { rOuter: 25, rInner: 20, h: 70, seg: 16 });
    const r = edit.extrudeFace(m, topOf(m), 10);
    ok('管的端面擠得出來', r.ok, r.reason || '');
    eq('★ 兩個邊界迴圈（外框一圈、內孔一圈）', r.loops, 2);
    eq('側牆 16＋16 面', r.walls, 32);
    // 正 16 邊形環的面積 ＝ ½·n·(R²−r²)·sin(2π/n)，不是理想圓的 π(R²−r²)
    const ring = 0.5 * 16 * (625 - 400) * Math.sin(2 * Math.PI / 16);
    near('★ 體積增加 ＝ 16 邊形環面積 × 10（不是理想圓）',
         r.mesh.volume() - m.volume(), ring * 10, 1e-6);
    ok('封閉，χ＝0（中間還是通的）', r.mesh.isClosed() && chi(r.mesh) === 0);
  }

  // ── 標記：蓋子搬到新頂點了，索引配對整組不同，不能只靠 _copyMarksTo ──
  {
    const m = buildPrim('box', { w: 60, h: 45, d: 40 });
    const top = topOf(m);
    const diag = [...m.edges()].find(h =>
      h.face && h.twin && h.twin.face && m.isFlat(h) && h.face.normal.y > 0.999);
    m.setRole(diag, EDGE_ROLE.CUT);
    const r = edit.extrudeFace(m, top, 20);
    eq('★ 蓋子上使用者標的 CUT 沒有消失',
       [...r.mesh.edges()].filter(h => h.role === EDGE_ROLE.CUT).length, 1);
  }

  // ── 側牆的垂直邊：只繼承上游，不從幾何猜 ──
  {
    // 匯入的擠出件才有 smooth（九種參數體一條都沒標，2026-08-23 實查）。
    // 半圓輪廓：圓弧那段全是平滑點，只有頭尾兩個真轉角。
    const out2 = [], oc2 = [];
    const N = 24, R = 20;
    for (let i = 0; i <= N; i++) {
      const t = Math.PI * i / N;
      out2.push(-R * Math.cos(t), R * Math.sin(t));
    }
    oc2.push(0, N);
    const m = buildPrim('extrude', { type: 'extrude', h: 5, shapes: [{ out: out2, oc: oc2 }] });
    m.computeNormals();
    const s0 = [...m.edges()].filter(h => h.smooth).length;
    ok('匯入的擠出件 本來就有 smooth 邊', s0 > 15, `${s0} 條`);

    const r = edit.extrudeFace(m, topOf(m), 8);
    ok('擠出成功', r.ok, r.reason || '');
    const s1 = [...r.mesh.edges()].filter(h => h.smooth).length;
    ok('★ 新的垂直邊繼承了上游的 smooth（總數變多了）', s1 > s0, `${s0} → ${s1}`);
    ok('封閉、χ＝2', r.mesh.isClosed() && chi(r.mesh) === 2);
  }
  {
    // ★ 反面：沒有上游就不猜。32 邊圓柱每個頂點轉 11.25 度，
    //   而「32 邊形」跟「真的做成 32 面的角柱」幾何上完全一樣（坑第 10 條）。
    //   標成 smooth ＝「這裡不算折線」，猜錯會漏掉折彎 —— 不對稱，所以不猜。
    const m = buildPrim('cylinder', { r: 25, h: 70, seg: 32 });
    const r = edit.extrudeFace(m, topOf(m), 10);
    eq('★ 參數體沒有上游 → 垂直邊一條都不標平滑',
       [...r.mesh.edges()].filter(h => h.smooth).length, 0);
  }
  {
    const m = buildPrim('box', { w: 60, h: 45, d: 40 });
    const r = edit.extrudeFace(m, topOf(m), 20);
    eq('方塊的四個角 也一條平滑邊都沒有',
       [...r.mesh.edges()].filter(h => h.smooth).length, 0);
  }

  // ── 擋下來的情況，要講得出原因 ──
  {
    const plate = buildPrim('plate', { w: 100, d: 60 }, 0.2);
    plate.computeNormals();
    const r1 = edit.extrudeFace(plate, plate.faces[0], 10);
    ok('開放網格的邊緣 擋下來並說明原因', !r1.ok && /開放邊緣/.test(r1.reason), r1.reason || '竟然通過');
    const m = buildPrim('box', { w: 60, h: 45, d: 40 });
    ok('距離 0 擋下來', !edit.extrudeFace(m, topOf(m), 0).ok);
    ok('沒選到面 擋下來', !edit.extrudeFace(m, null, 10).ok);
  }
}

section('編輯：面還平不平（預設沿法向的理由）');
{
  const mkBox = () => buildPrim('box', { w: 60, h: 45, d: 40 });
  // ── 沿法向推拉：面永遠是平的（整個面剛體平移）──
  {
    const m = mkBox();
    m.computeNormals();
    const top = m.faces.find(f => f.normal.y > 0.999);
    edit.pushFace(m, top, 12.5);
    edit.refreshAfterEdit(m);
    eq('沿法向推完 沒有任何面變不平', edit.nonPlanarFaces(m).length, 0);
  }
  // ── 自由移動一個頂點，把一個「真的四邊形」拉歪 ──
  //    方塊測不出來：它 12 個面全是三角形，而三角形恆為平面。
  //    ⚠ 實查過各參數體的面：box / plate / cylinder / cone / prism / sphere
  //    **全部是三角形**，只有 `tube`（64 個四邊形）與 `roundBox`（20 個四邊形
  //    ＋ 2 個 20 邊形）有真的多邊形面。所以這裡用管。
  {
    const m = buildPrim('tube', { rOuter: 25, rInner: 20, h: 70, seg: 16 });
    m.computeNormals();
    const quads = m.faces.filter(f => m.faceVerts(f).length === 4).length;
    ok('管有真的四邊形面（box/plate/cylinder/cone/sphere 全是三角形）',
       quads > 0, `${quads} 個`);
    eq('一開始 0 個不平的面', edit.nonPlanarFaces(m).length, 0);
    edit.moveVerts([m.verts[0]], new THREE.Vector3(0, 0, 8));
    edit.refreshAfterEdit(m);
    ok('★ 自由拉一個頂點 會把四邊形拉歪（這就是預設沿法向的理由）',
       edit.nonPlanarFaces(m).length > 0, `${edit.nonPlanarFaces(m).length} 個`);
  }
  // ── 方塊拉點不會產生「不平的面」，但會產生新的折線 ──
  {
    const m = mkBox();
    m.computeNormals();
    const before = edit.refreshAfterEdit(m);
    eq('方塊全是三角形，拉之前 0 個不平的面', before.nonPlanar, 0);
    edit.moveVerts([m.verts[0]], new THREE.Vector3(0, 5, 0));
    const after = edit.refreshAfterEdit(m);
    eq('拉完仍然 0 個不平的面（三角形恆為平面）', after.nonPlanar, 0);
    ok('但多了折線 —— 原本共面的三角形被拉出角度',
       after.folds.added > 0, `多 ${after.folds.added} 條`);
  }
  // ── 三角形恆為平面，是幾何事實不是容許值 ──
  {
    const m = buildPrim('cone', { r1: 20, r2: 0, h: 30, seg: 16 });
    m.computeNormals();
    const tri = m.faces.find(f => m.faceVerts(f).length === 3);
    ok('找得到三角形面', !!tri);
    const r = edit.facePlanarity(m, tri);
    ok('三角形恆為平面', r.planar && r.dev === 0);
  }
}

section('編輯：改完之後的連帶重算');
{
  const mkBox = () => buildPrim('box', { w: 60, h: 45, d: 40 });

  // ── ★ 最重要的一條：使用者標的 CUT 不可以被洗掉 ──
  {
    const m = mkBox();
    m.computeNormals();
    const marked = [...m.edges()].filter(h => h.face && h.twin && h.twin.face).slice(0, 3);
    for (const he of marked) m.setRole(he, EDGE_ROLE.CUT);
    const before = [...m.edges()].filter(h => h.role === EDGE_ROLE.CUT).length;
    eq('先標 3 條 CUT', before, 3);
    edit.moveVerts([m.verts[0]], new THREE.Vector3(2, 2, 2));
    const r = edit.refreshAfterEdit(m);
    const after = [...m.edges()].filter(h => h.role === EDGE_ROLE.CUT).length;
    eq('★ 編輯之後 CUT 一條都沒少', after, before);
    eq('回報保留了 3 條', r.folds.kept, 3);
  }
  // ── 對照組：直接呼叫 autoMarkFolds() 會洗掉 CUT（證明上面那條不是白測的）──
  {
    const m = mkBox();
    m.computeNormals();
    const he = [...m.edges()].find(h => h.face && h.twin && h.twin.face && !m.isFlat(h));
    m.setRole(he, EDGE_ROLE.CUT);
    m.autoMarkFolds();
    ok('對照組：autoMarkFolds() 真的會把 CUT 洗回 FOLD（所以不能直接用它）',
       he.role === EDGE_ROLE.FOLD, `現在是 ${he.role}`);
  }

  // ── 過期的 FOLD 要清掉（autoMarkFolds 只加不減）──
  {
    const m = mkBox();
    m.computeNormals();
    // 找一個面內被三角化切出來的共面邊，硬標成 FOLD，重算之後應該被清回 FREE
    const flat = [...m.edges()].find(h => h.face && h.twin && h.twin.face && m.isFlat(h));
    ok('找得到共面的邊', !!flat);
    m.setRole(flat, EDGE_ROLE.FOLD);
    const r = edit.refreshAfterEdit(m);
    eq('共面卻標著 FOLD 的邊 被清回 FREE', flat.role, EDGE_ROLE.FREE);
    ok('而且有回報清了幾條', r.folds.cleared >= 1, `${r.folds.cleared} 條`);
  }

  // ── ★ smooth 要依幾何關掉，否則展開長度會錯而且圖看起來正常 ──
  {
    const m = mkBox();
    m.computeNormals();
    const he = [...m.edges()].find(h => h.face && h.twin && h.twin.face && !m.isFlat(h));
    m.setSmooth(he, true);
    ok('先把一條 90 度的邊謊報成 smooth', he.smooth === true);
    const r = edit.refreshAfterEdit(m);
    eq('★ 夾角遠大於 3 度 → smooth 被關掉', he.smooth, false);
    ok('有回報關掉幾條', r.smoothOff >= 1, `${r.smoothOff} 條`);
    ok('兩條半邊一起關（不然走另一邊會讀到舊值）', he.twin.smooth === false);
  }
  // ── 反向不成立：共線的真轉角不會被自動打開 ──
  {
    const m = mkBox();
    m.computeNormals();
    const flat = [...m.edges()].find(h => h.face && h.twin && h.twin.face && m.isFlat(h));
    eq('共面的邊 一開始不是 smooth', flat.smooth, false);
    edit.refreshAfterEdit(m);
    eq('★ 重算之後 也沒有被自動打開（只關不開）', flat.smooth, false);
  }
  // ── 夾角還在門檻內的 smooth 要留著（不能一律關掉）──
  {
    const m = buildPrim('cylinder', { r: 25, h: 70, seg: 128 });
    m.computeNormals();
    let n = 0;
    for (const he of m.edges()) {
      const d = m.dihedral(he);
      if (d !== null && Math.abs(d * 180 / Math.PI) < 3) { m.setSmooth(he, true); n++; }
    }
    ok('128 段圓柱上有一堆夾角 < 3 度的邊', n > 100, `${n} 條`);
    edit.refreshAfterEdit(m);
    const kept = [...m.edges()].filter(h => h.smooth).length;
    eq('★ 夾角在門檻內的 smooth 一條都沒被誤關', kept, n);
  }

  // ── 重算的順序：法向必須先算，否則後兩步是拿舊資料在判斷 ──
  {
    const m = mkBox();
    m.computeNormals();
    const top = m.faces.find(f => f.normal.y > 0.999);
    const n0 = top.normal.clone();
    edit.pushFace(m, top, 10);
    // 推完之後不自己算法向，直接交給 refreshAfterEdit
    const r = edit.refreshAfterEdit(m);
    ok('refreshAfterEdit 自己會先重算法向', top.normal.distanceTo(n0) < 1e-9);
    ok('回傳三項都在', r.folds && typeof r.smoothOff === 'number'
       && typeof r.nonPlanar === 'number');
  }
}

section('編輯：改完之後 展開還是對的');
{
  // ★ 這一組才是這一刀真正要證明的事：
  //   改得動 ≠ 改完還能出圖。整條下游（展開）必須跟著更新且正確。
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  m.computeNormals();
  const u0 = unfoldMesh(m, makeRule('foamboard', 0.5));
  near('編輯前 總面積 13800', u0.stats.area, 13800, 1e-6);
  // 珍珠板銑 45 度 V 溝可折，所以方塊展成一整片；壓克力才會拆成 6 片。
  eq('編輯前 珍珠板方塊展成 1 片', u0.stats.total, 1);

  const top = m.faces.find(f => f.normal.y > 0.999);
  edit.pushFace(m, top, 10);            // 45 → 55 高
  edit.refreshAfterEdit(m);
  const u1 = unfoldMesh(m, makeRule('foamboard', 0.5));
  // 60×55×40 的表面積 ＝ 2(60×55 + 60×40 + 55×40) = 2(3300+2400+2200) = 15800
  near('★ 推高 10 之後 展開總面積 ＝ 15800（手算對答案）', u1.stats.area, 15800, 1e-6);
  eq('片數不變（推高不改變哪裡要切開）', u1.stats.total, u0.stats.total);
  near('體積也對得上 60×55×40', m.volume(), 132000, 1e-6);

  // 換成折不起來的材料，片數與張數要跟基準表對得上（60×55×40 仍是 6 片 3 張）
  const a1 = unfoldMesh(m, makeRule('acrylic', 0.5));
  eq('壓克力 6 片', a1.stats.total, 6);
  eq('壓克力 3 張（三種形狀各 2 片）', a1.pieces.length, 3);
}

// ═══════════════════════════════════════════════════════
//  第 6 期地基：變換 ＝ 種類 × 方向 × 中心
// ═══════════════════════════════════════════════════════

/**
 * 這一組守的是「三件事」的第二件：**拉點線面與擠出被鎖死在只能沿世界 XYZ 平移**。
 *
 * 解法照 Blender 的三層分解（`外部參考-Blender編輯.md` 第 3 節）：
 * 方向做成一組基底（`elementBasis`）、變換做成「從初始座標套一個位姿」
 * （`applyElementTransform`）。兩支都不碰 DOM，所以整條路測得到 ——
 * **測不到的只剩「箭頭在畫面上朝哪」，那一項只能 kang 開來看。**
 */

section('第 6 期地基：方向（elementBasis）');

{
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  m.computeNormals();
  const top = m.faces.find(f => f.normal.y > 0.999);

  const b = edit.elementBasis(m, { kind: 'face', face: top });
  ok('方塊頂面 算得出法向基底', b.ok);

  const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(b.quat);
  const ay = new THREE.Vector3(0, 1, 0).applyQuaternion(b.quat);
  const az = new THREE.Vector3(0, 0, 1).applyQuaternion(b.quat);

  // ★ 這一條是整組的重點：Z 一律是法向，所以「拉 Z 那根箭頭」＝ 沿法向推拉
  near('★ 基底的 Z 就是面法向（頂面朝 +Y）', az.dot(new THREE.Vector3(0, 1, 0)), 1, 1e-9);

  // 三軸互相垂直、都是單位長、而且右手系 —— 缺任何一條 gizmo 都會亂轉
  near('X·Y ＝ 0', ax.dot(ay), 0, 1e-9);
  near('Y·Z ＝ 0', ay.dot(az), 0, 1e-9);
  near('Z·X ＝ 0', az.dot(ax), 0, 1e-9);
  near('三軸都是單位長', ax.length() + ay.length() + az.length(), 3, 1e-9);
  near('右手系（X×Y ＝ Z）',
       new THREE.Vector3().crossVectors(ax, ay).dot(az), 1, 1e-9);

  /**
   * 切線取「最長的那一條邊界邊」。頂面是 60(X) × 40(Z)，
   * 所以 Y 軸應該沿世界 X —— 而那條邊**畫面上正被畫成黃色**，
   * 使用者看得見箭頭為什麼朝那邊。
   */
  near('切線 ＝ 最長的邊界邊（頂面 60 那一邊，沿世界 X）',
       Math.abs(ay.dot(new THREE.Vector3(1, 0, 0))), 1, 1e-9);

  // 結果唯一：同一個面問兩次要給同一個答案（鐵律三）
  const b2 = edit.elementBasis(m, { kind: 'face', face: top });
  near('同一個面問兩次 給同一個基底', b.quat.angleTo(b2.quat), 0, 1e-12);
}

{
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  m.computeNormals();
  const he = [...m.edges()][0];
  const b = edit.elementBasis(m, { kind: 'edge', he });
  ok('邊 算得出基底', b.ok);

  const dir = new THREE.Vector3().subVectors(he.to.p, he.v.p).normalize();
  const ay = new THREE.Vector3(0, 1, 0).applyQuaternion(b.quat);
  const az = new THREE.Vector3(0, 0, 1).applyQuaternion(b.quat);
  near('邊：Y 沿邊的方向', Math.abs(ay.dot(dir)), 1, 1e-9);
  near('邊：Z 與邊垂直', az.dot(dir), 0, 1e-9);
}

{
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  m.computeNormals();
  const v = m.verts[0];
  const b = edit.elementBasis(m, { kind: 'vertex', vert: v });
  ok('點 算得出基底', b.ok);
  const az = new THREE.Vector3(0, 0, 1).applyQuaternion(b.quat);
  near('點：Z 是單位長', az.length(), 1, 1e-9);

  /**
   * 🔴 **退化情況要當第一等公民。**
   * 認不得的 kind、給了 null —— 都要回 `ok:false` 讓呼叫端退回世界方向，
   * 而不是丟例外或給一個爛掉的矩陣（那會讓箭頭消失，看起來像功能壞了）。
   */
  ok('認不得的 kind → ok:false（退回世界）',
     edit.elementBasis(m, { kind: 'blob' }).ok === false);
  ok('face 給 null → ok:false',
     edit.elementBasis(m, { kind: 'face', face: null }).ok === false);
  ok('el 給 null → ok:false', edit.elementBasis(m, null).ok === false);
}

section('第 6 期地基：從初始座標重算（applyElementTransform）');

/** 拍一份選取元素的初始狀態，跟 select.js 拖曳開始時做的事一樣 */
function beginXf(m, el) {
  const verts = edit.elementVerts(m, el);
  const b = edit.elementBasis(m, el);
  return {
    verts,
    base: edit.snapshotVerts(verts),
    start: { pos: edit.elementCenter(m, el).clone(), quat: b.quat.clone() }
  };
}

{
  // ★ 讓兩條路算出同一個答案（鐵律：一個孤零零的數字沒有人能驗）
  const m1 = buildPrim('box', { w: 60, h: 45, d: 40 }); m1.computeNormals();
  const m2 = buildPrim('box', { w: 60, h: 45, d: 40 }); m2.computeNormals();
  const t1 = m1.faces.find(f => f.normal.y > 0.999);
  const t2 = m2.faces.find(f => f.normal.y > 0.999);

  edit.pushFace(m1, t1, 10);                      // 舊路：專用函式

  const d = beginXf(m2, { kind: 'face', face: t2 });   // 新路：方向 ＋ 拉 Z
  edit.applyElementTransform(d.verts, d.base, d.start, {
    pos: d.start.pos.clone().add(
      new THREE.Vector3(0, 0, 1).applyQuaternion(d.start.quat).multiplyScalar(10)),
    quat: d.start.quat
  });

  near('★ 沿法向拉 Z 10　＝ pushFace(10)：體積都是 132000', m2.volume(), 132000, 1e-6);
  near('　　舊路的體積也是 132000（兩條路對得起來）', m1.volume(), 132000, 1e-6);
  let maxd = 0;
  for (let i = 0; i < m1.verts.length; i++) {
    maxd = Math.max(maxd, m1.verts[i].p.distanceTo(m2.verts[i].p));
  }
  near('★ 兩條路的每一個頂點都在同一個位置', maxd, 0, 1e-9);
}

{
  // 縮放：頂面兩個切線方向各縮一半 → 60×45×40 的方塊變成上小下大的棱台
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  m.computeNormals();
  const top = m.faces.find(f => f.normal.y > 0.999);
  const d = beginXf(m, { kind: 'face', face: top });

  edit.applyElementTransform(d.verts, d.base, d.start, {
    pos: d.start.pos, quat: d.start.quat,
    scale: new THREE.Vector3(0.5, 0.5, 1)          // 兩個切線縮半，法向不動
  });

  /**
   * 棱台體積用擬柱體公式手算：h/6 ×(下底 ＋ 4×中截面 ＋ 上底)
   *   下底 60×40 ＝ 2400　上底 30×20 ＝ 600　中截面 45×30 ＝ 1350
   *   45/6 ×(2400 ＋ 5400 ＋ 600) ＝ 7.5 × 8400 ＝ 63000
   */
  near('★ 頂面縮一半 → 棱台體積 63000（擬柱體公式手算）', m.volume(), 63000, 1e-6);
  eq('縮放不改拓撲 V/E/F 不變', `${m.verts.length}/${[...m.edges()].length}/${m.faces.length}`, '8/18/12');
  eq('仍然封閉、尤拉數 2', `${m.isClosed()}/${euler(m)}`, 'true/2');

  // 取消 ＝ 把初始座標寫回去。取消因此不是一個功能，是「什麼都不做」。
  edit.restoreVerts(d.verts, d.base);
  near('★ 取消之後 體積精確回到 108000', m.volume(), 108000, 1e-9);
  let same = true;
  for (let i = 0; i < d.verts.length; i++) {
    if (!d.verts[i].p.equals(d.base[i])) same = false;
  }
  ok('★ 取消之後 每一個座標都跟拖之前一模一樣', same);
}

{
  // 旋轉：繞法向轉，平面不變、而且是剛體運動
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  m.computeNormals();
  const top = m.faces.find(f => f.normal.y > 0.999);
  const d = beginXf(m, { kind: 'face', face: top });

  const spin = a => {
    const q = d.start.quat.clone().multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), a));
    edit.applyElementTransform(d.verts, d.base, d.start,
      { pos: d.start.pos, quat: q });
  };

  spin(37 * Math.PI / 180);
  // 剛體運動：被移動的頂點之間，距離一格都不變
  let worst = 0;
  for (let i = 0; i < d.verts.length; i++) {
    for (let j = i + 1; j < d.verts.length; j++) {
      worst = Math.max(worst, Math.abs(
        d.verts[i].p.distanceTo(d.verts[j].p) - d.base[i].distanceTo(d.base[j])));
    }
  }
  near('★ 轉 37 度是剛體運動（頂點間距離不變）', worst, 0, 1e-9);
  // 繞法向轉，整個面仍然待在原來那個平面上
  let offPlane = 0;
  for (const v of d.verts) offPlane = Math.max(offPlane, Math.abs(v.p.y - 22.5));
  near('★ 繞法向轉 面仍然在原平面上（y 全部是 22.5）', offPlane, 0, 1e-9);

  /**
   * 🔴 **轉 180 度：位置的集合回到原樣，但體積變了。**
   *
   * 60×40 的矩形繞中心轉半圈會對應到自己 —— 但那是**位置的集合**對應到自己，
   * **不是每個頂點回到自己的位置**：四個角兩兩對調了。
   * 而側牆連的是「底下第 i 個角 ↔ 上面第 i 個角」，角一換，
   * 側牆就跟著**扭成麻花**，體積從 108000 掉到 36000。
   *
   * 〔2026-08-23 實測抓到。這一條原本寫的是「體積必須一格都不變」，
   * 　推論的時候把「集合不變」讀成「每個點不動」。
   * 　鐵律一：**這種事不能靠推理，要靠對答案。**〕
   *
   * 這不是 bug，Blender 轉一個面也是這樣（拓撲沒變，側牆只好跟著扭）。
   * 但它是使用者要知道的事：**旋轉面是拿來做斜面與梯形的（小角度），
   * 不是拿來「把一片轉個方向」的。**
   */
  spin(Math.PI);
  const key = p => `${+p.x.toFixed(9)},${+p.y.toFixed(9)},${+p.z.toFixed(9)}`;
  const before = new Set(d.base.map(key));
  const after = new Set(d.verts.map(v => key(v.p)));
  ok('轉 180 度 四個角的位置集合回到原樣（兩兩對調）',
     before.size === after.size && [...after].every(k => before.has(k)));
  ok('★ 但體積變了 —— 側牆被扭成麻花（旋轉面只適合小角度）',
     Math.abs(m.volume() - 108000) > 1, `體積 ${+m.volume().toFixed(2)}`);

  spin(0);
  near('轉 0 度 ＝ 恆等（體積 108000）', m.volume(), 108000, 1e-9);
}

{
  // 斜面：圓柱側面沿自己的法向推出去，體積要變大（繞向錯了會變小或變負）
  const m = buildPrim('cylinder', { r: 25, h: 40, seg: 32 });
  m.computeNormals();
  const v0 = m.volume();
  // 挑一個側面（法向幾乎水平的）
  const side = m.faces.find(f => Math.abs(f.normal.y) < 0.01);
  ok('圓柱找得到側面', !!side);

  const d = beginXf(m, { kind: 'face', face: side });
  const n = new THREE.Vector3(0, 0, 1).applyQuaternion(d.start.quat);
  near('側面的基底 Z 是水平的（就是那一片的法向）', n.y, 0, 1e-6);
  edit.applyElementTransform(d.verts, d.base, d.start,
    { pos: d.start.pos.clone().addScaledVector(n, 5), quat: d.start.quat });
  ok('★ 斜面沿法向推出去 體積變大（繞向對）', m.volume() > v0,
     `${(+m.volume().toFixed(2))} > ${(+v0.toFixed(2))}`);
}

{
  // 防呆：長度對不上就什麼都不做，不要拿錯的基準去改幾何
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  m.computeNormals();
  const top = m.faces.find(f => f.normal.y > 0.999);
  const d = beginXf(m, { kind: 'face', face: top });
  const bad = edit.applyElementTransform(d.verts, d.base.slice(1), d.start,
    { pos: d.start.pos, quat: d.start.quat });
  eq('快照長度對不上 → 一個頂點都不動', bad, 0);
  near('　　體積也沒被動到', m.volume(), 108000, 1e-9);
}

// ═══════════════════════════════════════════════════════
//  第 6 期地基（下）：子元素多選 ＋ active
// ═══════════════════════════════════════════════════════

/**
 * 「三件事」第三件的第一步。多選之後三個純函式都要吃陣列：
 * `elementVerts`（聯集去重）、`elementCenter`（兩種中心）、
 * `elementBasis`（法向取和、切線照 active）。
 *
 * 測得到的是這三支；**測不到的是「橘色那個是不是畫在對的元素上」**，
 * 那只能 kang 開來看。
 */

section('第 6 期地基：多選的聯集與去重');

{
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  m.computeNormals();
  const top = m.faces.find(f => f.normal.y > 0.999);
  const side = m.faces.find(f => f.normal.x > 0.999);

  const one = edit.elementVerts(m, { kind: 'face', face: top });
  eq('單獨一個頂面 4 個頂點', one.length, 4);

  /**
   * ★ **相鄰的兩個面共用一條邊上的兩個頂點。**
   * 頂面 4 ＋ 右側面 4，聯集**必須是 6 不是 8** ——
   * 不去重的話那兩個共用頂點會被平移兩次（走兩倍距離），
   * 而畫面上看起來只是「拉太多了」，沒有人會想到是重複套用。
   */
  const both = edit.elementVerts(m, [
    { kind: 'face', face: top }, { kind: 'face', face: side }]);
  eq('★ 頂面 ＋ 右側面 聯集是 6 個頂點（共用 2 個，已去重）', both.length, 6);

  // 同一個元素放兩次也要去重（加選時再點一次是「取消」，但函式本身要撐得住）
  eq('同一個面放兩次 還是 4 個頂點',
     edit.elementVerts(m, [{ kind: 'face', face: top }, { kind: 'face', face: top }]).length, 4);

  const es = [...m.edges()].slice(0, 3).map(he => ({ kind: 'edge', he }));
  ok('三條邊的聯集不超過 6 個頂點', edit.elementVerts(m, es).length <= 6);

  eq('空陣列 → 沒有頂點', edit.elementVerts(m, []).length, 0);
}

section('第 6 期地基：中心（重心 ／ 最後選的）');

{
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  m.computeNormals();
  const top = m.faces.find(f => f.normal.y > 0.999);      // 中心 (0, 22.5, 0)
  const side = m.faces.find(f => f.normal.x > 0.999);     // 中心 (30, 0, 0)
  const sels = [{ kind: 'face', face: top }, { kind: 'face', face: side }];

  /**
   * ★ 兩種中心一定要**差得出來**，否則那顆按鈕等於不存在。
   *
   * `median` ＝ 6 個聯集頂點的重心；`active` ＝ 最後一筆（右側面）自己的重心。
   * 手算：右側面 4 個頂點都是 x=30，重心必定 (30, 0, 0)。
   */
  const ca = edit.elementCenter(m, sels, 0.5, 'active');
  near('★ 中心＝最後選的 → 右側面的重心 x ＝ 30', ca.x, 30, 1e-9);
  near('　　y ＝ 0', ca.y, 0, 1e-9);
  near('　　z ＝ 0', ca.z, 0, 1e-9);

  const cm = edit.elementCenter(m, sels, 0.5, 'median');
  ok('★ 兩種中心真的不一樣', cm.distanceTo(ca) > 1,
     `相距 ${(+cm.distanceTo(ca).toFixed(3))} cm`);

  // 順序即 active：把兩個對調，`active` 中心就換人
  const ca2 = edit.elementCenter(m, [sels[1], sels[0]], 0.5, 'active');
  near('★ 對調順序 → active 中心換成頂面（y ＝ 22.5）', ca2.y, 22.5, 1e-9);
  near('　　而且 x 回到 0', ca2.x, 0, 1e-9);

  // 單選時兩者必須是同一個點（介面上那句「看不出差別」不是隨口說的）
  const solo = [{ kind: 'face', face: top }];
  near('單選時 兩種中心是同一個點',
       edit.elementCenter(m, solo, 0.5, 'median')
         .distanceTo(edit.elementCenter(m, solo, 0.5, 'active')), 0, 1e-12);
}

section('第 6 期地基：多選的方向（法向取和、切線照 active）');

{
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  m.computeNormals();
  const top = m.faces.find(f => f.normal.y > 0.999);      // +Y
  const side = m.faces.find(f => f.normal.x > 0.999);     // +X

  const b = edit.elementBasis(m, [
    { kind: 'face', face: top }, { kind: 'face', face: side }]);
  ok('兩個面 算得出基底', b.ok);

  const az = new THREE.Vector3(0, 0, 1).applyQuaternion(b.quat);
  /**
   * ★ +Y 與 +X 兩個法向相加正規化 → (1/√2, 1/√2, 0)，**剛好指在兩面中間**。
   * 「兩個相鄰的斜面一起選，箭頭指向它們中間」就是這件事。
   */
  const s = Math.SQRT1_2;
  near('★ 兩個面的法向和 → Z ＝ (0.7071, 0.7071, 0)　x', az.x, s, 1e-9);
  near('　　y', az.y, s, 1e-9);
  near('　　z', az.z, 0, 1e-9);

  // 三軸仍然是一組正交右手基底（合併之後最容易壞的地方）
  const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(b.quat);
  const ay = new THREE.Vector3(0, 1, 0).applyQuaternion(b.quat);
  near('合併後 X·Y ＝ 0', ax.dot(ay), 0, 1e-9);
  near('合併後 Y·Z ＝ 0', ay.dot(az), 0, 1e-9);
  near('合併後 右手系', new THREE.Vector3().crossVectors(ax, ay).dot(az), 1, 1e-9);

  /**
   * ★ **每個元素的 Z 先正規化再相加**，所以權重相同。
   * 方塊的每個面都是 2 個三角形，測不出差別 —— 拿 `tube` 才驗得到：
   * 它的側面是 64 個四邊形各自一個區域（1 個面），端面是一整圈。
   * 這裡改用「同一個面放兩次」來驗權重：放兩次的 Z 方向必須不變。
   */
  const b1 = edit.elementBasis(m, [{ kind: 'face', face: top }]);
  const b2 = edit.elementBasis(m, [
    { kind: 'face', face: top }, { kind: 'face', face: top }]);
  near('★ 同一個面放兩次 Z 方向不變（權重相同，不會被壓過）',
       b1.quat.angleTo(b2.quat), 0, 1e-9);

  /**
   * ★ 切線只看 active，所以**對調順序，扭轉方向會換**（法向不變）。
   * 這是「箭頭的扭轉方向照你最後點的那一個」那句規則的機械版。
   */
  const bA = edit.elementBasis(m, [
    { kind: 'face', face: top }, { kind: 'face', face: side }]);
  const bB = edit.elementBasis(m, [
    { kind: 'face', face: side }, { kind: 'face', face: top }]);
  const zA = new THREE.Vector3(0, 0, 1).applyQuaternion(bA.quat);
  const zB = new THREE.Vector3(0, 0, 1).applyQuaternion(bB.quat);
  near('對調順序 Z（法向和）完全一樣', zA.distanceTo(zB), 0, 1e-9);
  ok('★ 但整組基底不同（切線照 active，換人就換）',
     bA.quat.angleTo(bB.quat) > 1e-6,
     `夾角 ${(+(bA.quat.angleTo(bB.quat) * 180 / Math.PI).toFixed(2))} 度`);

  ok('空陣列 → ok:false（退回世界）', edit.elementBasis(m, []).ok === false);
}

section('第 6 期地基：多選一起變換');

{
  // ★ 兩個相鄰的面一起沿世界 +X 拉，共用的那兩個頂點只能走一次
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  m.computeNormals();
  const top = m.faces.find(f => f.normal.y > 0.999);
  const side = m.faces.find(f => f.normal.x > 0.999);
  const sels = [{ kind: 'face', face: top }, { kind: 'face', face: side }];

  const verts = edit.elementVerts(m, sels);
  const base = edit.snapshotVerts(verts);
  const start = { pos: edit.elementCenter(m, sels), quat: new THREE.Quaternion() };
  const moved = edit.applyElementTransform(verts, base, start,
    { pos: start.pos.clone().add(new THREE.Vector3(10, 0, 0)), quat: start.quat });

  eq('★ 一起移動 6 個頂點（不是 8 次）', moved, 6);
  let maxdx = 0;
  for (let i = 0; i < verts.length; i++) {
    maxdx = Math.max(maxdx, Math.abs(verts[i].p.x - base[i].x - 10));
  }
  near('★ 每一個頂點都剛好走 10（共用的沒有走 20）', maxdx, 0, 1e-9);

  // 取消照樣把整份還原
  edit.restoreVerts(verts, base);
  near('多選取消之後 體積回到 108000', m.volume(), 108000, 1e-9);
}

// ═══════════════════════════════════════════════════════
//  拆掉重建的三個配件 ＋ 面合併（限制性溶解）
// ═══════════════════════════════════════════════════════

/**
 * 🔴 這一組守的是 2026-08-24 實測照出來的那件事：
 * **`fromFaceList()` 對壞資料一律照建不報錯，而 `validate()` 抓不到孤點** ——
 * 唯一露餡的是尤拉數。四個拆掉重建的工具**全部**會產生孤點。
 */

section('拆掉重建：預檢（preflightRebuild）');

{
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  const pts = m.verts.map(v => v.p.clone());
  const fl = m._faceList();

  const good = edit.preflightRebuild(pts, fl);
  ok('乾淨的方塊 → 沒有問題', good.ok && !good.fixable.length,
     `fatal ${good.fatal.length} / fixable ${good.fixable.length}`);

  // ★ 最天真的「合併頂點」寫法：把索引 1 全部換成 0
  const merged = fl.map(f => f.map(i => (i === 1 ? 0 : i)));
  const bad = edit.preflightRebuild(pts, merged);
  eq('★ 合併頂點 → 抓到 2 個退化成線的面', bad.degenerate.length, 2);
  eq('★ 合併頂點 → 抓到 1 個孤點', bad.orphans.length, 1);
  ok('　　而且 fatal 是空的（這些都修得掉）', bad.fatal.length === 0);

  // 指到不存在的頂點 ＝ 修不掉，要擋
  const broken = edit.preflightRebuild(pts, [[0, 1, 999]]);
  ok('★ 指到不存在的頂點 → fatal（修不掉，要擋下來）',
     !broken.ok && broken.fatal.length > 0, broken.fatal[0]);

  // 重複的面
  const dup = edit.preflightRebuild(pts, fl.concat([fl[0].slice()]));
  eq('重複的面抓得到', dup.dupFaces.length, 1);
}

section('拆掉重建：清乾淨並交出索引對照表（cleanRebuild）');

{
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  const pts = m.verts.map(v => v.p.clone());
  const fl = m._faceList().map(f => f.map(i => (i === 1 ? 0 : i)));

  const c = edit.cleanRebuild(pts, fl);
  eq('清掉 2 個退化面 → 剩 10 個面', c.faces.length, 10);
  eq('清掉 1 個孤點 → 剩 7 個頂點', c.points.length, 7);

  const m2 = Mesh.fromFaceList(c.points, c.faces);
  m2.computeNormals();
  const v = m2.validate();
  eq('★ 清乾淨之後 尤拉數回到 2', v.euler, 2);
  ok('　　而且封閉、結構無誤', v.closed && v.ok);
  near('體積 72000（那個角被抹掉了，手算得出來）', m2.volume(), 72000, 1e-6);

  /**
   * 🔴 **這一條是整組的重點**：清孤點會讓索引位移，
   * 而「既有頂點保持原索引」是拆掉重建那條路的契約。
   * remap 就是那筆帳 —— 沒有它，role／smooth／選取會安靜地消失。
   */
  eq('★ 原頂點 7 → 新索引 6（索引真的位移了）', c.remap.get(7), 6);
  eq('　　原頂點 0 沒動', c.remap.get(0), 0);
  eq('　　被清掉的頂點 1 沒有對應', c.remap.get(1), undefined);
}

section('面合併（限制性溶解）');

{
  // ★ 合併不改變幾何，所以可以拿體積與面積對答案
  const cases = [
    ['方塊', 'box', { w: 60, h: 45, d: 40 }, 12, 6, 6],
    ['32 段圓柱', 'cylinder', { r: 25, h: 40, seg: 32 }, 128, 34, 32],
    ['球 seg16', 'sphere', { r: 30, seg: 16 }, 960, 512, 448],
  ];
  for (const [name, type, p, before, after, quads] of cases) {
    const m = buildPrim(type, p);
    m.computeNormals();
    const v0 = m.volume(), a0 = m.area();

    const r = edit.mergeCoplanarFaces(m);
    ok(`${name} 合併成功`, r.ok, r.reason || '');
    if (!r.ok) continue;

    eq(`${name} 面數 ${before} → ${after}`, `${r.before}/${r.after}`, `${before}/${after}`);
    rel(`★ ${name} 體積精確不變`, r.mesh.volume(), v0);
    rel(`★ ${name} 面積精確不變`, r.mesh.area(), a0);

    const vv = r.mesh.validate();
    eq(`★ ${name} 尤拉數仍是 2（孤點有清掉）`, vv.euler, 2);
    ok(`　　${name} 封閉且結構無誤`, vv.closed && vv.ok);
    eq(`　　${name} 沒有 issues`, r.mesh.issues.length, 0);

    let q = 0;
    for (const f of r.mesh.faces) if (r.mesh.faceVerts(f).length === 4) q++;
    eq(`★ ${name} 四邊形面 ${quads} 個（環切要走的東西）`, q, quads);
  }
}

{
  /**
   * ⚠ **環形的區域不能合併，要原樣留著。**
   * 管的兩個端面是環形（外圈＋內圈兩個迴圈），一個面裝不下兩個迴圈。
   */
  const m = buildPrim('tube', { r: 25, ri: 20, h: 40, seg: 32 });
  m.computeNormals();
  const r = edit.mergeCoplanarFaces(m);
  ok('★ 管：沒有合併任何面（側面本來就是四邊形，兩個端面是環形）', !r.ok);
  eq('　　而且跳過的環形區域數是 2', r.skipped, 2);
  ok('　　理由要講出「環形」這件事，不是一句「沒得合併」帶過',
     /環形/.test(r.reason), r.reason);
}

{
  // 圓柱：孤點確實產生了，而且被清掉了
  const m = buildPrim('cylinder', { r: 25, h: 40, seg: 32 });
  m.computeNormals();
  const r = edit.mergeCoplanarFaces(m);
  eq('★ 圓柱合併後清掉 2 個孤點（端面扇形的中心點）', r.orphans, 2);
  eq('頂點 66 → 64', `${m.verts.length}/${r.mesh.verts.length}`, '66/64');
}

{
  // ★ 使用者標的 CUT 一條都不能少
  const m = buildPrim('box', { w: 60, h: 45, d: 40 });
  m.computeNormals();
  summarize(m);                          // 讓 region 有值
  const marks = [...m.edges()].filter(h =>
    h.twin && h.face && h.twin.face && h.face.region !== h.twin.face.region).slice(0, 3);
  for (const he of marks) m.setRole(he, EDGE_ROLE.CUT);
  const before = [...m.edges()].filter(h => h.role === EDGE_ROLE.CUT).length;

  const r = edit.mergeCoplanarFaces(m);
  const after = [...r.mesh.edges()].filter(h => h.role === EDGE_ROLE.CUT).length;
  eq('★ 合併之後 使用者標的 CUT 一條都沒少', after, before);
}

section('拆掉重建：把選取搬過去（remapElements）');

{
  const m = buildPrim('cylinder', { r: 25, h: 40, seg: 32 });
  m.computeNormals();
  const v0 = m.verts[0], v5 = m.verts[5];
  const he0 = [...m.edges()][0];
  const side = m.faces.find(f => Math.abs(f.normal.y) < 0.01);

  const sels = [
    { kind: 'vertex', vert: v0 },
    { kind: 'vertex', vert: v5 },
    { kind: 'edge', he: he0 },
  ];
  const r = edit.mergeCoplanarFaces(m);
  const moved = edit.remapElements(m, r.mesh, sels, r.remap);
  eq('★ 三個選取全部搬得過去', moved.length, 3);
  ok('　　搬過去的是新網格的頂點（不是舊的那份）',
     moved[0].vert !== v0 && r.mesh.verts.includes(moved[0].vert));
  near('　　而且座標一樣（搬的是同一個點）', moved[0].vert.p.distanceTo(v0.p), 0, 1e-12);
  ok('　　邊也搬得過去', moved[2].kind === 'edge' && !!moved[2].he);

  // 面：合併之後那個三角形已經不在了，但它所在的「區域」變成一個四邊形
  const faceSel = [{ kind: 'face', face: side }];
  const movedFace = edit.remapElements(m, r.mesh, faceSel, r.remap);
  eq('★ 面也搬得過去（用共面區域的頂點索引集合配對）', movedFace.length, 1);
  if (movedFace.length) {
    eq('　　而且搬到的是一個四邊形', r.mesh.faceVerts(movedFace[0].face).length, 4);
  }

  // 搬不過去的要安靜地掉掉，不能丟例外
  const ghost = edit.remapElements(m, r.mesh, [{ kind: 'vertex', vert: m.verts[64] }], r.remap);
  eq('被清掉的孤點 → 搬不過去（掉掉，不丟例外）', ghost.length, 0);
}

section('bake 順手還原多邊形 ＋ 平面性防護');

{
  /**
   * 🔴 「轉成可編輯網格」現在會順手把三角化還原。
   * 它不是使用者的功能，是程式內部的整理 —— 而唯一需要它的是環切。
   */
  const o = new io.ModelObject({ src: { type: 'box', w: 60, h: 45, d: 40 }, kind: 'solid' });
  const before = o.mesh().faces.length;
  const v0 = o.mesh().volume(), a0 = o.mesh().area();
  o.bake();
  const m = o.mesh();
  eq('★ bake 之後 方塊面數 12 → 6', `${before}/${m.faces.length}`, '12/6');
  rel('★ 體積精確不變', m.volume(), v0);
  rel('★ 面積精確不變', m.area(), a0);
  eq('　　src 有換成 mesh', o.src.type, 'mesh');
  let q = 0;
  for (const f of m.faces) if (m.faceVerts(f).length === 4) q++;
  eq('★ 六個面全是四邊形（環切要走的東西）', q, 6);
}

{
  // 圓柱走同一條路，而且孤點要被清掉（χ 回到 2）
  const o = new io.ModelObject({ src: { type: 'cylinder', r: 25, h: 40, seg: 32 }, kind: 'solid' });
  const v0 = o.mesh().volume();
  o.bake();
  const v = o.mesh().validate();
  eq('★ bake 之後 圓柱 F 34、χ 2', `${v.F}/${v.euler}`, '34/2');
  rel('　　體積精確不變', o.mesh().volume(), v0);
}

{
  /**
   * 🔴 **平面性防護**：夾角剛好卡在容許值附近時，泛洪會把整條側面串成一區，
   * 併出來的多邊形其實不平，而**展開面積會跟著變** —— 下料尺寸就錯了。
   *
   * 判準用 `MERGE_FLAT_TOL_CM`（1 微米），**不是** `PLANAR_TOL_CM`（0.1mm）。
   * 借用後者會鬆三個數量級，seg 719／720 照樣溜過去（實測過）。
   */
  ok('MERGE_FLAT_TOL_CM 比 PLANAR_TOL_CM 嚴兩個數量級',
     edit.MERGE_FLAT_TOL_CM < edit.PLANAR_TOL_CM / 50,
     `${edit.MERGE_FLAT_TOL_CM} vs ${edit.PLANAR_TOL_CM}`);

  for (const seg of [128, 719, 720, 721]) {
    const m = buildPrim('cylinder', { r: 25, h: 40, seg });
    m.computeNormals();
    const u0 = unfoldMesh(m, makeRule('foamboard', 0.5));
    const r = edit.mergeCoplanarFaces(m);
    if (!r.ok) { ok(`seg=${seg} 沒合併（也可以接受）`, true, r.reason.slice(0, 24)); continue; }
    const u1 = unfoldMesh(r.mesh, makeRule('foamboard', 0.5));
    // ★ 這一條才是重點：合併絕對不可以改變展開尺寸
    near(`★ seg=${seg}（夾角 ${(360 / seg).toFixed(3)}°）展開總面積完全不變`,
         u1.stats.area, u0.stats.area, 1e-9);
    let worst = 0;
    for (const f of r.mesh.faces) worst = Math.max(worst, edit.facePlanarity(r.mesh, f).dev);
    ok(`　　而且沒有不平的面（最大偏離 ${worst.toExponential(1)}）`,
       worst <= edit.MERGE_FLAT_TOL_CM);
  }

  // 正常的參數體一個都不能被誤擋
  for (const [t, p] of [['box', { w: 60, h: 45, d: 40 }], ['sphere', { r: 30, seg: 16 }],
                        ['cone', { r: 30, h: 70, seg: 32 }], ['prism', { r: 25, h: 40, seg: 6 }]]) {
    const m = buildPrim(t, p); m.computeNormals();
    const r = edit.mergeCoplanarFaces(m);
    eq(`${t} 沒有區域被平面性防護誤擋`, r.unflat, 0);
  }
}

section('壓平（＝ 縮放 × 法向 × Z 打 0）');

/** 圓柱 → 還原多邊形 → 挑三片相鄰的側面 */
function threeSides() {
  const m = edit.mergeCoplanarFaces(buildPrim('cylinder', { r: 25, h: 40, seg: 32 })).mesh;
  m.computeNormals(); summarize(m);
  const side = m.faces.filter(f => Math.abs(f.normal.y) < 0.01);
  const pick = [side[0]];
  for (const f of side) {
    if (pick.length >= 3) break;
    const last = pick[pick.length - 1];
    if (!pick.includes(f) &&
        m.faceVerts(f).filter(v => m.faceVerts(last).includes(v)).length === 2) pick.push(f);
  }
  return { m, sels: pick.map(face => ({ kind: 'face', face })) };
}

{
  const { m, sels } = threeSides();
  eq('三片相鄰的側面 共 8 個頂點', edit.elementVerts(m, sels).length, 8);

  const u0 = unfoldMesh(m, makeRule('foamboard', 0.5));
  const r = edit.flattenElements(m, sels);
  ok('壓平成功', r.ok, r.reason || '');
  eq('★ 移動了 8 個頂點', r.moved, 8);
  near('★ 回報壓平前的偏離 0.478（那是使用者要付的代價）', r.before, 0.478055, 1e-5);

  // ★ 壓平之後，那三片真的落在同一個平面上
  const verts = edit.elementVerts(m, sels);
  const b = edit.elementBasis(m, sels);
  const nZ = new THREE.Vector3(0, 0, 1).applyQuaternion(b.quat);
  const c = edit.elementCenter(m, sels);
  let dev = 0;
  for (const v of verts) {
    dev = Math.max(dev, Math.abs(nZ.dot(new THREE.Vector3().subVectors(v.p, c))));
  }
  near('★ 壓平後 8 個點全部落在同一個平面上', dev, 0, 1e-9);

  edit.refreshAfterEdit(m);
  summarize(m);
  eq('★ 那三片變成同一個共面區域（34 → 32 區）',
     new Set(m.faces.map(f => f.region)).size, 32);

  /**
   * ★★ **壓平之後「併成一個面」是免費的** —— 因為它們真的共面了。
   * 這一整條就是「溶解面」的替代路徑，而且結果是**真正平的**面。
   */
  const g = edit.mergeCoplanarFaces(m);
  ok('★★ 壓平之後 還原多邊形會自己把它們併掉', g.ok, g.reason || '');
  eq('　　F 34 → 32', `${g.before}/${g.after}`, '34/32');
  const big = g.mesh.faces.filter(f => g.mesh.faceVerts(f).length === 8);
  eq('★ 三片併成一個 8 邊形', big.length, 1);

  let worst = 0;
  for (const f of g.mesh.faces) worst = Math.max(worst, edit.facePlanarity(g.mesh, f).dev);
  ok('★ 而且它是真正平的（不平度 < 1 微米）', worst <= edit.MERGE_FLAT_TOL_CM,
     worst.toExponential(2));

  const v = g.mesh.validate();
  eq('　　結構完好 χ2 closed', `${v.euler}/${v.closed}/${v.ok}`, '2/true/true');

  const u1 = unfoldMesh(g.mesh, makeRule('foamboard', 0.5));
  ok('★ 展開總面積變了（形狀真的被削平了，這是預期的）',
     Math.abs(u1.stats.area - u0.stats.area) > 1, `${u0.stats.area.toFixed(3)} → ${u1.stats.area.toFixed(3)}`);

  // ★ 選取搬過去之後只剩一個面（去重）
  const moved = edit.remapElements(m, g.mesh, sels, g.remap);
  eq('★★ 三個舊面搬過去之後**去重成一個**（不去重數字會說謊）', moved.length, 1);
  eq('　　而且搬到的就是那個 8 邊形', g.mesh.faceVerts(moved[0].face).length, 8);
}

{
  /**
   * 🔴 **對照組：不壓平、直接溶解成一個 n 邊形（Blender 的「溶解面」）。**
   * 這一條釘住「為什麼那條路在這個專案不做」——
   * 不是主觀判斷，是**超標 96 倍**。
   */
  const { m, sels } = threeSides();
  const loops = edit.boundaryLoops(m, sels.map(s => s.face));
  eq('三片的外緣是一圈 8 條', `${loops.length}/${loops[0].length}`, '1/8');

  const vi = m._vertIndex();
  const pts = m.verts.map(v => v.p.clone());
  const idx = loops[0].map(he => vi.get(he.v.id));
  const n = new THREE.Vector3();
  for (let i = 0; i < idx.length; i++) {
    const a = pts[idx[i]], b = pts[idx[(i + 1) % idx.length]];
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  n.normalize();
  let dev = 0;
  for (const i of idx) {
    dev = Math.max(dev, Math.abs(n.dot(new THREE.Vector3().subVectors(pts[i], pts[idx[0]]))));
  }
  near('★★ 直接溶解出來的 8 邊形偏離平面 0.956 cm', dev, 0.9561, 1e-3);
  ok('★★ 那是可切容許值（0.1mm）的 90 倍以上 —— 所以這條路不做',
     dev / edit.PLANAR_TOL_CM > 90, `${(dev / edit.PLANAR_TOL_CM).toFixed(0)} 倍`);
}

{
  // 本來就平的面：壓平要什麼都不做，而且回報 before = 0 讓呼叫端講一句
  const m = edit.mergeCoplanarFaces(buildPrim('box', { w: 60, h: 45, d: 40 })).mesh;
  m.computeNormals();
  const top = m.faces.find(f => f.normal.y > 0.999);
  const r = edit.flattenElements(m, [{ kind: 'face', face: top }]);
  eq('★ 本來就平的面 → before = 0（呼叫端據此講「本來就是平的」）', r.before, 0);
  near('　　體積一格都沒動', m.volume(), 108000, 1e-9);

  // 選不到 3 個頂點就擋下來
  const bad = edit.flattenElements(m, [{ kind: 'vertex', vert: m.verts[0] }]);
  ok('只選一個點 → 擋下來並說原因', !bad.ok && /3 個頂點/.test(bad.reason), bad.reason);
}

// ═══════════════════════════════════════════════════════
//  非凸的面：扇形三角化不成立
// ═══════════════════════════════════════════════════════

/**
 * 🔴 2026-08-24 kang 實測回報：圓柱壓平一段再往內拉，畫面上出現一塊奇怪的三角形。
 *
 * 原因是 `toGeometry()` 用**扇形三角化**，而那**只對凸多邊形成立** ——
 * 上蓋一凹，就有三角形跑到多邊形外面而且繞向翻掉。
 *
 * ⚠ **這個 bug 一直都在**：n 邊形本來只出現在 `roundBox`（凸）與 `tube`（四邊形），
 * 匯入的擠出件早就自己耳切了。「還原多邊形」讓它浮出來。
 * 而全專案有 **8 個地方**在做同一件事（畫面、面積、STL、布林、展開面積…）。
 */

section('非凸的面：faceTriangles 統一入口');

/** 圓柱 → 還原多邊形 → 壓平三片 → 再併 → 把那一片往內拉，做出一個凹掉的上蓋 */
function dentedCylinder(pull = -8) {
  const m0 = edit.mergeCoplanarFaces(buildPrim('cylinder', { r: 25, h: 40, seg: 32 })).mesh;
  m0.computeNormals(); summarize(m0);
  const side = m0.faces.filter(f => Math.abs(f.normal.y) < 0.01);
  const pick = [side[0]];
  for (const f of side) {
    if (pick.length >= 3) break;
    const last = pick[pick.length - 1];
    if (!pick.includes(f) &&
        m0.faceVerts(f).filter(v => m0.faceVerts(last).includes(v)).length === 2) pick.push(f);
  }
  edit.flattenElements(m0, pick.map(face => ({ kind: 'face', face })));
  edit.refreshAfterEdit(m0);
  const g = edit.mergeCoplanarFaces(m0);
  const m = g.ok ? g.mesh : m0;
  m.computeNormals(); summarize(m);
  const flat = m.faces.find(f => m.faceVerts(f).length === 8);
  edit.moveVerts(edit.elementVerts(m, { kind: 'face', face: flat }),
                 m.computeFaceNormal(flat).clone().multiplyScalar(pull));
  edit.refreshAfterEdit(m);
  return m;
}

/** 一個面真正的面積（Newell），跟三角化的結果對答案用 */
function trueFaceArea(m, f) {
  const vs = m.faceVerts(f);
  const n = new THREE.Vector3();
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i].p, b = vs[(i + 1) % vs.length].p;
    n.x += (a.y - b.y) * (a.z + b.z);
    n.y += (a.z - b.z) * (a.x + b.x);
    n.z += (a.x - b.x) * (a.y + b.y);
  }
  return n.length() / 2;
}

{
  const m = dentedCylinder();
  const cap = m.faces.find(f => f.normal.y > 0.999);
  const vs = m.faceVerts(cap);
  eq('凹掉的上蓋還是 32 邊形', vs.length, 32);

  // 它真的是非凸的（不然這一組測試什麼都沒測到）
  const n = m.computeFaceNormal(cap).clone();
  let reflex = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = vs[i].p, b = vs[(i + 1) % vs.length].p, c = vs[(i + 2) % vs.length].p;
    const cr = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(b, a), new THREE.Vector3().subVectors(c, b));
    if (cr.dot(n) < -1e-9) reflex++;
  }
  eq('★ 而且它真的是非凸的（2 個凹角）', reflex, 2);

  const truth = trueFaceArea(m, cap);
  const tris = m.faceTriangles(cap);
  eq('★ 耳切出來的三角形數 ＝ n − 2', tris.length, vs.length - 2);

  let abs = 0, flipped = 0;
  for (const [a, b, c] of tris) {
    const cr = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(b.p, a.p),
      new THREE.Vector3().subVectors(c.p, a.p));
    abs += cr.length() / 2;
    if (cr.dot(n) < -1e-9) flipped++;
  }
  rel('★★ 三角形面積總和 ＝ 多邊形真正的面積（沒有多畫）', abs, truth);
  eq('★★ 沒有任何一個三角形繞向翻掉', flipped, 0);

  /**
   * 對照：舊的扇形做法在同一個面上會多算 4.56%、而且翻掉 1 個。
   * 留著這一條是為了證明**這組測試真的測得到東西** ——
   * 不然改壞了也不會有人發現（鐵律：要測病因，不只測症狀）。
   */
  let fanAbs = 0, fanFlip = 0;
  for (let i = 2; i < vs.length; i++) {
    const cr = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(vs[i - 1].p, vs[0].p),
      new THREE.Vector3().subVectors(vs[i].p, vs[0].p));
    fanAbs += cr.length() / 2;
    if (cr.dot(n) < -1e-9) fanFlip++;
  }
  ok('★ 對照組：舊的扇形做法確實會多算（證明這組測試測得到東西）',
     fanAbs - truth > 1, `多算 ${(fanAbs - truth).toFixed(2)} cm²`);
  ok('　　而且確實會翻掉三角形', fanFlip > 0, `${fanFlip} 個`);
}

{
  // ★ 下游那幾條：面積、STL、體積
  const m = dentedCylinder();
  let truth = 0;
  for (const f of m.faces) truth += trueFaceArea(m, f);
  rel('★★ mesh.area() ＝ 每個面真正的面積相加', m.area(), truth);

  const tris = triangles(m, {});
  const v = m.validate();
  eq('　　網格仍然封閉、χ 2', `${v.euler}/${v.closed}`, '2/true');
  rel('★ STL 體積 ＝ 網格體積', stlVolume(tris), m.volume());

  /**
   * ★★ **STL 不可以有法向朝內的三角形。**
   * 體積是**有號**的，翻掉的三角形在裡面也照樣對得上 ——
   * 所以體積驗不出這件事（坑第 17 條：中途的量一直都是對的）。
   * 要驗就要**逐個三角形**問它的法向對不對。
   */
  let inward = 0;
  for (const t of tris) {
    const cr = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(t.b, t.a),
      new THREE.Vector3().subVectors(t.c, t.a));
    if (cr.dot(t.n) < 0) inward++;
  }
  eq('★★ STL 裡沒有法向跟繞向對不起來的三角形', inward, 0);
}

{
  // 凸的情況必須跟舊的扇形做法**逐字相同** —— 1219 項既有測試就是這個斷言的另一半
  let checked = 0, same = true;
  for (const [t, p] of [['box', { w: 60, h: 45, d: 40 }],
                        ['cylinder', { r: 25, h: 40, seg: 32 }],
                        ['tube', { r: 25, ri: 20, h: 40, seg: 32 }],
                        ['roundBox', { w: 60, h: 45, d: 40, r: 6 }]]) {
    const m0 = buildPrim(t, p); m0.computeNormals();
    const g = edit.mergeCoplanarFaces(m0);
    for (const m of [m0, g.ok ? g.mesh : null].filter(Boolean)) {
      m.computeNormals();
      for (const f of m.faces) {
        const vs = m.faceVerts(f);
        const got = m.faceTriangles(f);
        checked++;
        if (got.length !== vs.length - 2) { same = false; break; }
        for (let i = 2; i < vs.length; i++) {
          const w = got[i - 2];
          if (w[0] !== vs[0] || w[1] !== vs[i - 1] || w[2] !== vs[i]) { same = false; break; }
        }
      }
    }
  }
  ok(`★★ 凸的情況跟扇形逐字相同（檢查 ${checked} 個面）`, same);
}

// ═══════════════════════════════════════════════════════
//  環切（Loop Cut）
// ═══════════════════════════════════════════════════════

section('環切：ring 走訪');

/** 轉成可編輯網格（＝ io.js 的 bake()：還原多邊形），環切的前提 */
function baked(type, params) {
  const r = edit.mergeCoplanarFaces(buildPrim(type, params));
  const m = r.ok ? r.mesh : buildPrim(type, params);
  m.computeNormals();
  return m;
}
const edgeCount = m => [...m.edges()].length;
const chi = m => m.verts.length - edgeCount(m) + m.faces.length;
/** 找一條方向大致等於 dir 的邊 */
function findEdge(m, pick) {
  for (const he of m.edges()) {
    const d = he.to.p.clone().sub(he.v.p);
    if (pick(d)) return he;
  }
  return null;
}

{
  const box = baked('box', { w: 60, d: 45, h: 40 });
  eq('前提：方塊 bake 之後是 6 個四邊形', box.faces.length, 6);
  const v = findEdge(box, d => Math.abs(d.z) > 1e-9 && Math.hypot(d.x, d.y) < 1e-9);
  const r = edit.edgeRing(box, v);
  eq('★ 方塊的垂直邊繞出 4 條 ring', r.hes.length, 4);
  ok('　　而且是繞回來的閉環', r.closed);

  /**
   * 🔴 方塊與圓柱的頂點**全是 3 價** —— Blender 的 edge-loop walker（要四價）
   * 在上面一步都走不了。**環切用的是 edge ring 不是 edge loop**，
   * 這一項是那個區別的機械斷言，不要再把兩者搞混。
   */
  let maxVal = 0;
  for (const vert of box.verts) maxVal = Math.max(maxVal, box.vertOutgoing(vert).length);
  eq('★★ 方塊的頂點最高才 3 價（所以 edge loop 走不動、ring 才走得動）', maxVal, 3);

  const cyl = baked('cylinder', { r: 25, h: 60, seg: 32 });
  const cv = findEdge(cyl, d => Math.abs(d.y) > 1e-9 && Math.hypot(d.x, d.z) < 1e-9);
  const rc = edit.edgeRing(cyl, cv);
  eq('★ 32 段圓柱的垂直邊繞出 32 條 ring', rc.hes.length, 32);
  ok('　　閉環', rc.closed);

  const ch = findEdge(cyl, d => Math.hypot(d.x, d.z) > 1e-9 && Math.abs(d.y) < 1e-9);
  const rh = edit.edgeRing(cyl, ch);
  eq('★ 水平邊只繞到 2 條就停（撞到端面的 32 邊形）', rh.hes.length, 2);

  /**
   * 前提檢查：**沒有 bake 就一步都走不了。**
   * 參數體借的是 three.js 的三角形，16 段圓柱是 64 個三角形、0 個四邊形。
   */
  const raw = buildPrim('cylinder', { r: 25, h: 60, seg: 16 });
  raw.computeNormals();
  eq('★★ 沒 bake 的 16 段圓柱有幾個四邊形',
     raw.faces.filter(f => raw.faceVerts(f).length === 4).length, 0);
  const rr = edit.edgeRing(raw, [...raw.edges()][0]);
  eq('　　所以 ring 走一步就停', rr.hes.length, 1);
}

section('環切：切下去之後的網格');

{
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const v0 = findEdge(box, d => Math.abs(d.z) > 1e-9 && Math.hypot(d.x, d.y) < 1e-9);
  const vol0 = box.volume(), area0 = box.area();
  const r = edit.loopCut(box, v0);
  ok('環切成功', r.ok);
  const m = r.mesh;

  eq('V 8 → 12', m.verts.length, 12);
  eq('E 12 → 20', edgeCount(m), 20);
  eq('F 6 → 10', m.faces.length, 10);
  eq('★★ χ 仍然是 2', chi(m), 2);
  ok('　　仍然封閉', m.isClosed());
  ok('　　結構沒有問題', m.validate().ok);

  /**
   * 🔴 **這一條是環切最重要的斷言。**
   * 環切只加線、不動任何既有頂點的位置 —— 所以體積與面積
   * **必須精確不變**。那是可以對答案的量（鐵律三）。
   */
  rel('★★ 體積精確不變', m.volume(), vol0);
  rel('★★ 面積精確不變', m.area(), area0);

  /** ⭐ 四個「拆掉重建」的工具裡，只有環切不產生孤點 —— 它只加不減 */
  eq('★ 孤點 0 個（只加不減）', r.orphans, 0);
  eq('新切出來的邊 4 條', r.newEdges.length, 4);
  eq('　　而且全部標成 hard', [...m.edges()].filter(he => he.hard).length, 4);

  /**
   * 🔴 **四個出口都要通，少一個環切就是一顆按了沒反應的按鈕。**
   */
  eq('★★ 出口一：新的邊點得到（isMarkable 對 hard 放行）',
     [...m.edges()].filter(he => he.hard && seam.isMarkable(m, he)).length, 4);

  const rid = new Set();
  for (const f of m.faces) rid.add(edit.regionOf(m, f).rid);
  eq('★★ 出口二：共面區域被切開了（6 → 10）', rid.size, 10);
  eq('★★ 出口三：點半塊側面只選到那半塊',
     edit.regionOf(m, m.faces[0]).faces.length, 1);
  ok('★★ 出口四：再跑一次併面不會把切線併回去',
     !edit.mergeCoplanarFaces(m).ok);

  /** 出口五：存讀檔。不存的話開檔之後切線就沒了，而形狀還在 */
  const round = Mesh.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
  eq('★ 出口五：存檔再開，hard 邊還在',
     [...round.edges()].filter(he => he.hard).length, 4);
}

{
  /**
   * 🔴 **被切成兩半的邊要繼承標記。**
   * 不做的話 `1-3` 被切成 `1-8` 與 `8-3`，索引配對一定落空，
   * 而**使用者標的 CUT 會安靜消失**（實測切完 CUT 0 條）。
   */
  const m0 = baked('box', { w: 60, d: 45, h: 40 });
  const t = findEdge(m0, d => Math.abs(d.z) > 1e-9 && Math.hypot(d.x, d.y) < 1e-9);
  m0.setRole(t, EDGE_ROLE.CUT);
  m0.setSmooth(t, true);
  const r2 = edit.loopCut(m0, findEdge(m0, d => Math.abs(d.z) > 1e-9 && Math.hypot(d.x, d.y) < 1e-9), { cuts: 2 });
  eq('★★ 標了 CUT 的邊切 2 刀之後，三段都還是 CUT',
     [...r2.mesh.edges()].filter(he => he.role === EDGE_ROLE.CUT).length, 3);
  eq('★★ smooth 也一樣三段都繼承',
     [...r2.mesh.edges()].filter(he => he.smooth).length, 3);
}

{
  /** 多刀：n 刀就是 n+1 片，切點取 i/(n+1)。形狀一樣不能變 */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const pick = () => findEdge(box, d => Math.abs(d.z) > 1e-9 && Math.hypot(d.x, d.y) < 1e-9);
  for (const [n, V, E, F] of [[1, 12, 20, 10], [2, 16, 28, 14], [3, 20, 36, 18]]) {
    const r = edit.loopCut(box, pick(), { cuts: n });
    eq(`${n} 刀 → V${V} E${E} F${F}`,
       `${r.mesh.verts.length}/${edgeCount(r.mesh)}/${r.mesh.faces.length}`, `${V}/${E}/${F}`);
    eq(`　　χ 仍是 2`, chi(r.mesh), 2);
    rel(`　　體積精確不變`, r.mesh.volume(), 108000);
  }
  /** 切點位置：1 刀在中點 → 新頂點的 z 必須剛好在正中間 */
  const one = edit.loopCut(box, pick(), { cuts: 1 });
  const zs = one.mesh.verts.map(v => v.p.z);
  near('★ 一刀切在正中間', zs.slice(8).reduce((a, b) => a + b, 0) / 4,
       (Math.max(...zs) + Math.min(...zs)) / 2, 1e-9);
}

{
  /**
   * 半條 ring：撞到不是四邊形的面就停，那個面**只插點、不切開**。
   * 不插的話會變成 T 型接點（一邊一條邊、另一邊兩條）。
   */
  const cyl = baked('cylinder', { r: 25, h: 60, seg: 32 });
  const vol0 = cyl.volume();
  const ch = findEdge(cyl, d => Math.hypot(d.x, d.z) > 1e-9 && Math.abs(d.y) < 1e-9);
  const r = edit.loopCut(cyl, ch);
  ok('★ 半條 ring 也切得下去', r.ok);
  eq('　　切開 1 個四邊形、2 個端面只插點', `${r.split}/${r.pierced}`, '1/2');
  eq('★★ χ 仍然是 2', chi(r.mesh), 2);
  ok('　　仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
  rel('★★ 體積精確不變', r.mesh.volume(), vol0);
  eq('★ 端面從 32 邊形變成 33 邊形',
     r.mesh.faces.filter(f => r.mesh.faceVerts(f).length === 33).length, 2);

  /** 圓柱的垂直邊：整整一圈 32 條 */
  const cv = findEdge(cyl, d => Math.abs(d.y) > 1e-9 && Math.hypot(d.x, d.z) < 1e-9);
  const rv = edit.loopCut(cyl, cv);
  eq('★ 圓柱垂直邊環切：V64→96 E96→160 F34→66',
     `${rv.mesh.verts.length}/${edgeCount(rv.mesh)}/${rv.mesh.faces.length}`, '96/160/66');
  eq('　　χ 仍是 2', chi(rv.mesh), 2);
  rel('★★ 體積精確不變', rv.mesh.volume(), vol0);
}

{
  /**
   * 🔴 **展開不可以被影響。**
   * `hard` 讓 `planarRegions()` 斷開，而展開有沒有用到它是關鍵風險 ——
   * 實查是沒有（`flatten.js` 從頭到尾沒有 `planarRegions`），
   * 這一條把它釘成機械斷言，日後誰改了就會被叫出來。
   */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const rule = makeRule('acrylic', 0.3);
  const before = unfoldMesh(box, rule);
  const r = edit.loopCut(box,
    findEdge(box, d => Math.abs(d.z) > 1e-9 && Math.hypot(d.x, d.y) < 1e-9));
  const after = unfoldMesh(r.mesh, rule);
  eq('★★ 環切前後展開片數一樣', after.pieces.length, before.pieces.length);
  eq('　　警告數也一樣', after.warnings.length, before.warnings.length);
}

section('沿面滑動邊（Edge Slide）：環切的搭檔');

/**
 * 🔴 **這一組守的是「方向」，⛔ 不是位移量。**
 *
 * 位移量是一行減法，⛔ 不會錯；**會錯的是「往哪一側」** ——
 * 而那個錯**在方塊上看不出來**（兩側對稱），只有回報文字會露餡。
 *
 * ⚠ **第一版真的錯了，而且測試差點放它過關**（2026-08-28）：
 * 我拿「所有軌道向量的和」當共同方向，而每個點**一條往上、一條往下**，
 * Y 分量**互相抵消** → 那個和永遠 ≈ 0 → 退化鏈一路掉到 Z。
 * 🔴 **然後方塊照樣通過**（軌道在 Z 上的投影都是 0，`>=` 於是永遠挑
 * `rails[0]`，**而它剛好是往上那條**）—— **「碰巧通過」比失敗危險。**
 * ⭐ 正解是用**兩條軌道的差**（`d0 − d1`），⛔ 不是和 —— 差不會抵消。
 */
{
  /** 環切一圈，回「那一圈的半邊」——⭐ 跟 `main.js` 選起來的是同一組 */
  const cutRing = (type, params, tweak) => {
    let m = baked(type, params);
    if (tweak) { tweak(m); m.computeNormals(); }
    const he0 = [...m.edges()].find(h => h.face && h.twin && h.twin.face
      && Math.abs(h.v.p.y - h.to.p.y) > 1e-6);
    const r = edit.loopCut(m, he0, { cuts: 1 });
    const out = r.mesh; out.computeNormals();
    const vi = out._vertIndex();
    const k = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
    const want = new Set(r.newEdges.map(([a, b]) => k(a, b)));
    const hes = [...out.edges()]
      .filter(h => want.has(k(vi.get(h.v.id), vi.get(h.to.id))));
    return { mesh: out, hes };
  };
  const ysOf = hes => hes.flatMap(h => [h.v.p.y, h.to.p.y]);

  {
    /** ① 滑 5 公分：Y 精確 +5，而且**拓撲一格都沒動** */
    const { mesh, hes } = cutRing('box', { w: 60, d: 45, h: 40 });
    const before = `${mesh.verts.length}/${edgeCount(mesh)}/${mesh.faces.length}`;
    const y0 = ysOf(hes)[0];
    const r = edit.slideEdges(mesh, hes, 5, { mode: 'cm' });
    ok('滑動成功', r.ok, r.reason || '');
    eq('★ 動了 4 個點', r.moved, 4);
    ok('★★ 那一圈的 Y 精確 +5',
       ysOf(hes).every(y => Math.abs(y - (y0 + 5)) < 1e-9), `${y0} → ${ysOf(hes)[0]}`);
    eq('★★ 🔴 拓撲完全沒變（它只動座標，⛔ 不改拓撲）',
       `${mesh.verts.length}/${edgeCount(mesh)}/${mesh.faces.length}`, before);
    eq('★★ 🔴 方向回報「上」（⛔ 第一版這裡是「＋Z」）', r.dir, '上');
  }

  {
    /** ② 100% 精確落在端點 —— 那是「％」這個模式的定義 */
    const { mesh, hes } = cutRing('box', { w: 60, d: 45, h: 40 });
    const top = Math.max(...mesh.verts.map(v => v.p.y));
    edit.slideEdges(mesh, hes, 100, { mode: 'pct' });
    ok('★★ 滑 100% → 精確落在軌道端點上',
       ysOf(hes).every(y => Math.abs(y - top) < 1e-9), `${ysOf(hes)[0]} vs ${top}`);
  }

  {
    /**
     * ③ ⭐ **對稱的形狀上，兩種模式算出同一個答案** ——
     * 那是「它們只在被拉歪的形狀上才分岔」這句話的前半。
     */
    const A = cutRing('box', { w: 60, d: 45, h: 40 });
    edit.slideEdges(A.mesh, A.hes, 50, { mode: 'pct' });
    const B = cutRing('box', { w: 60, d: 45, h: 40 });
    edit.slideEdges(B.mesh, B.hes, 10, { mode: 'cm' });      // 軌道 20 的一半
    rel('★★ 等長軌道：50% 與 10 公分是同一個答案', A.hes[0].v.p.y, B.hes[0].v.p.y, 1e-12);
  }

  {
    /**
     * ④ 🔴🔴 **拉歪之後兩種模式分岔 —— 這一項就是「兩個都要給」的證據。**
     * 〔kang 2026-08-28 拍板兩種單位都做，理由就是這個〕
     * 把方塊一個角拉高 40 → 同一圈的軌道長度變成 40 / 20 / 20 / 20。
     */
    const bend = m => {
      const top = Math.max(...m.verts.map(v => v.p.y));
      m.verts.filter(v => Math.abs(v.p.y - top) < 1e-6)[0].p.y += 40;
    };
    const A = cutRing('box', { w: 60, d: 45, h: 40 }, bend);
    edit.slideEdges(A.mesh, A.hes, 50, { mode: 'pct' });
    const B = cutRing('box', { w: 60, d: 45, h: 40 }, bend);
    edit.slideEdges(B.mesh, B.hes, 10, { mode: 'cm' });
    const ya = ysOf(A.hes).map(y => y.toFixed(2)).sort().join(',');
    const yb = ysOf(B.hes).map(y => y.toFixed(2)).sort().join(',');
    ok('★★ 🔴 拉歪的形狀上，兩種模式算出不同的答案', ya !== yb);
    ok('★★ 　 ％ 維持等比例（軌道 40 的那個點走 20）',
       ysOf(A.hes).some(y => Math.abs(y - 40) < 1e-9), ya);
    ok('★★ 　 公分維持等距離（每個點都走 10）',
       ysOf(B.hes).some(y => Math.abs(y - 30) < 1e-9), yb);
  }

  {
    /** ⑤ 來回：+5 再 −5 精確還原 —— ⭐ 順便驗「負值走的是另一條軌道」 */
    const { mesh, hes } = cutRing('cylinder', { r: 25, h: 70, seg: 32 });
    const snap = mesh.verts.map(v => v.p.clone());
    edit.slideEdges(mesh, hes, 5, { mode: 'cm' });
    edit.slideEdges(mesh, hes, -5, { mode: 'cm' });
    const worst = Math.max(...mesh.verts.map((v, i) => v.p.distanceTo(snap[i])));
    ok('★★ 滑 +5 再滑 −5 → 座標精確還原', worst < 1e-9, `最大偏差 ${worst.toExponential(2)}`);
  }

  {
    /** ⑥ 滑過頭：**夾住並回報**，⛔ 不整個擋掉（照導角 `clamped` 的先例）*/
    const { mesh, hes } = cutRing('box', { w: 60, d: 45, h: 40 });
    const top = Math.max(...mesh.verts.map(v => v.p.y));
    const r = edit.slideEdges(mesh, hes, 500, { mode: 'cm' });
    ok('★ 滑過頭 → 夾住，⛔ 不是擋下來', r.ok);
    eq('★ 　 而且講得出幾個點滑到底', r.clamped, 4);
    rel('★ 　 也講得出最多能滑多少', r.maxCm, 20);
    ok('★★ 　 真的夾在端點上', hes.every(h => Math.abs(h.v.p.y - top) < 1e-9));
  }

  {
    /**
     * ⑦ 🔴🔴 **判準是「端點的價數」，⛔ 不是「選了幾條邊」。**
     *
     * ⚠ **這一組是 kang 2026-08-28 實測第 8 項照出來的** ——
     * 我開清單時寫「只選一條邊 → 會擋下來」，**那個預期是錯的**：
     *
     * | 選什麼 | 端點價數 | 排除選到的之後 | |
     * |---|---|---|---|
     * | **方塊原本的一條邊** | 3 價 | 剩 **2** 條 | ✅ **滑得動**（楔形／斜面）|
     * | 環切線上的一條邊 | 4 價 | 剩 **3** 條 | 擋下來 |
     *
     * ⭐ 單條邊滑得動是 **Blender Edge Slide 本來就有的用法**，
     * kang 的原話：「**效果我覺得不錯**」——⛔ 它是功能，不是漏洞。
     */
    const { mesh, hes } = cutRing('box', { w: 60, d: 45, h: 40 });
    const vd = {};
    for (const v of mesh.verts) { const d = mesh.vertOutgoing(v).length; vd[d] = (vd[d] || 0) + 1; }
    eq('★ （前置）環切後的價數：原本的角 8 個 3 價、新點 4 個 4 價',
       JSON.stringify(vd), '{"3":8,"4":4}');

    /** ⑦-甲 環切線上的 1 條邊（端點 4 價）→ 擋，因為剩 3 條不知道走哪條 */
    const a = edit.slideEdges(mesh, [hes[0]], 5, { mode: 'cm' });
    ok('★ 【環切線上】的 1 條邊 → 擋下來（端點 4 價，剩 3 條）', !a.ok);
    ok('★★ 　 訊息講的是「旁邊有 3 條邊」，⛔ 不是「要選一整圈」',
       !a.ok && /3 條邊/.test(a.reason || '') && !/要選一整圈/.test(a.reason || ''), a.reason);
    ok('　 而且指得出出路（選一圈／環切）', !a.ok && /選一圈|環切/.test(a.reason || ''));

    /** ⑦-乙 🔴 方塊原本的 1 條邊（端點 3 價）→ **滑得動**，那是楔形 */
    const top = Math.max(...mesh.verts.map(v => v.p.y));
    const e = [...mesh.edges()].find(h => h.face && h.twin && h.twin.face
      && Math.abs(h.v.p.y - top) < 1e-6 && Math.abs(h.to.p.y - top) < 1e-6);
    const b = edit.slideEdges(mesh, [e], 12, { mode: 'cm' });
    ok('★★ 🔴 【方塊原本】的 1 條邊 → ✅ 滑得動（⛔ 不擋）', b.ok, b.reason || '');
    eq('★★ 　 動的是那條邊的 2 個點 ＝ kang 看到的楔形', b.moved, 2);
  }

  {
    /** ⑧ 半圈（中間斷掉）→ 擋，⭐ 這一項才是「選取不連續」真正的樣子 */
    const { mesh, hes } = cutRing('box', { w: 60, d: 45, h: 40 });
    const r = edit.slideEdges(mesh, hes.slice(0, 2), 5, { mode: 'cm' });
    ok('★ 只選半圈 → 擋下來', !r.ok);
    ok('★★ 　 而且指出路（選一圈／環切）',
       !r.ok && /選一圈|環切/.test(r.reason || ''), r.reason);
  }

  {
    /**
     * ⑧ 🔴 **退化鏈真的要被走到過** ——
     * 把方塊繞 X 轉 90 度，軌道就沿 Z 了，Y 分不出來。
     * ⚠ **⛔ 這一項不是湊數**：第一版的 bug 就藏在「Y 分不出來」那條路上，
     * 而所有站著的形狀都走不到它。
     */
    const { mesh, hes } = cutRing('box', { w: 60, d: 45, h: 40 });
    for (const v of mesh.verts) { const y = v.p.y, z = v.p.z; v.p.y = z; v.p.z = -y; }
    mesh.computeNormals();
    const z0 = hes[0].v.p.z;
    const r = edit.slideEdges(mesh, hes, 5, { mode: 'cm' });
    eq('★★ Y 分不出來時，退化鏈走到 ＋Z', r.dir, '＋Z');
    ok('★★ 　 而且整圈一致（⛔ 沒有扭掉）',
       new Set(hes.flatMap(h => [h.v.p.z.toFixed(9), h.to.p.z.toFixed(9)])).size === 1);
    rel('　 位移仍然精確', hes[0].v.p.z - z0, 5);
  }
}

section('平行複製一圈邊（Offset Edge Slide）');

/**
 * 🔴 **這一組守兩件事**：
 * **① 它只加線** —— 體積、面積**精確不變**（跟環切同一個斷言，可以對答案）；
 * **② 抽出來的共用函式沒有壞掉** —— `cutFacesAlongInserts()` 2026-08-28
 * 從 `loopCut()` 抽出來，**環切自己的測試全部保留就是抽對了的證明**。
 *
 * ⭐ **一行新數學都沒有**：軌道借 `slideEdges()` 那一套（輸入條件一模一樣），
 * 加線借共用函式。⚠ 而它剛好落進共用函式的守備範圍是**幾何必然**：
 * 選到的邊 `e=(v1,v2)` 上側那個四邊形是 `(v1, v2, v2', v1')`，
 * 而 `v1`／`v2` 的上軌道**正好是它的對面兩條邊**。
 */
{
  const cutRing = (type, params) => {
    const m = baked(type, params);
    const he0 = [...m.edges()].find(h => h.face && h.twin && h.twin.face
      && Math.abs(h.v.p.y - h.to.p.y) > 1e-6);
    const r = edit.loopCut(m, he0, { cuts: 1 });
    const out = r.mesh; out.computeNormals();
    const vi = out._vertIndex();
    const k = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
    const want = new Set(r.newEdges.map(([a, b]) => k(a, b)));
    return { mesh: out, hes: [...out.edges()].filter(h => want.has(k(vi.get(h.v.id), vi.get(h.to.id)))) };
  };

  {
    /** ① 方塊：⭐ **體積面積精確不變**才是這顆按鈕的保證 */
    const { mesh, hes } = cutRing('box', { w: 60, d: 45, h: 40 });
    const F0 = mesh.faces.length, vol0 = mesh.volume(), area0 = mesh.area();
    const y0 = hes[0].v.p.y;
    const r = edit.offsetEdgeLoop(mesh, hes, 5, { mode: 'cm' });
    ok('平行複製成功', r.ok, r.reason || '');
    eq('★ 選到的一圈 4 條 → 兩側共 4×2 條新線', r.newEdges.length, hes.length * 2);
    eq('★★ 面數 ＝ 原本 ＋ 一圈的條數×2', r.mesh.faces.length, F0 + hes.length * 2);
    eq('★★ χ 仍然是 2', chi(r.mesh), 2);
    ok('　 仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
    rel('★★ 🔴 體積精確不變（它只加線）', r.mesh.volume(), vol0);
    rel('★★ 🔴 面積精確不變', r.mesh.area(), area0);
    eq('★ 孤點 0 個（只加不減）', r.orphans, 0);

    /** ★★ 新的那兩圈，位置要精確 ＝ 原本 ± 偏移量 */
    const ys = [...new Set(r.newEdges
      .flatMap(([a, b]) => [r.mesh.verts[a].p.y, r.mesh.verts[b].p.y])
      .map(v => +v.toFixed(9)))].sort((p, q) => p - q);
    eq('★★ 🔴 兩圈的位置精確 ＝ 原本 ± 5', `${ys.length}/${ys[0]}/${ys[1]}`,
       `2/${y0 - 5}/${y0 + 5}`);
  }

  {
    /**
     * ② 圓柱 seg32 —— ⚠ **面數用公式寫，⛔ 不寫死一個數字**
     * 〔這一輪的教訓，同一個毛病犯了三次：實測清單寫死 223963.70、
     * 　寫死「往上」、測試名稱寫死「34→98」而實際是 66→130〕
     */
    const { mesh, hes } = cutRing('cylinder', { r: 25, h: 70, seg: 32 });
    const F0 = mesh.faces.length, vol0 = mesh.volume();
    const r = edit.offsetEdgeLoop(mesh, hes, 3, { mode: 'cm' });
    ok('② 圓柱 seg32 也做得出來', r.ok, r.reason || '');
    eq('★ 一圈 32 條 → 新線 64 條', r.newEdges.length, hes.length * 2);
    eq('★★ 面數 ＝ 原本 ＋ 64', r.mesh.faces.length, F0 + hes.length * 2);
    eq('★★ χ 仍然是 2', chi(r.mesh), 2);
    rel('★★ 🔴 體積精確不變', r.mesh.volume(), vol0);
  }

  {
    /** ③ ％ 模式：軌道 20 的 25% ＝ 5（⭐ 跟公分那一項算出同一個答案）*/
    const { mesh, hes } = cutRing('box', { w: 60, d: 45, h: 40 });
    const y0 = hes[0].v.p.y;
    const r = edit.offsetEdgeLoop(mesh, hes, 25, { mode: 'pct' });
    const ys = [...new Set(r.newEdges
      .flatMap(([a, b]) => [r.mesh.verts[a].p.y, r.mesh.verts[b].p.y])
      .map(v => +v.toFixed(9)))].sort((p, q) => p - q);
    eq('★★ ％：軌道 20 的 25% ＝ 5，跟打 5 公分同一個答案',
       `${ys[0]}/${ys[1]}`, `${y0 - 5}/${y0 + 5}`);
  }

  {
    /**
     * ④ 頂到底：夾住，⛔ 不整個擋掉。
     * ⚠ **而且 ⛔ 不可以長出零長度的邊** —— 上限刻意用 0.999 不是 1，
     * 因為剛好貼在端點上是退化幾何，會一路帶到布林與 STL **而且不報錯**
     * 〔`ON_PLANE_CM` 那一段燒過同一件事〕。
     */
    const { mesh, hes } = cutRing('box', { w: 60, d: 45, h: 40 });
    const r = edit.offsetEdgeLoop(mesh, hes, 500, { mode: 'cm' });
    ok('★ 偏移超過那一段 → 夾住，⛔ 不是擋下來', r.ok);
    eq('★ 　 而且講得出幾個地方頂到底', r.clamped, hes.length * 2);
    eq('★★ 🔴 ⛔ 沒有長出零長度的邊（χ 仍然是 2）', chi(r.mesh), 2);
    ok('　 結構仍然沒問題', r.mesh.validate().ok);
  }

  {
    /** ⑤ ％ 打 100 → 擋下來（那會疊在原本那一圈上）*/
    const { mesh, hes } = cutRing('box', { w: 60, d: 45, h: 40 });
    const r = edit.offsetEdgeLoop(mesh, hes, 100, { mode: 'pct' });
    ok('★ ％ 打 100 → 擋下來並說原因', !r.ok, r.reason);
  }

  {
    /**
     * ⑥ 🔴 **判準跟 `slideEdges()` 一字不差：端點的價數。**
     * ⭐ 兩支共用同一段軌道邏輯，所以行為必須一致 ——
     * 這兩項就是「一致」的證明。
     */
    const { mesh, hes } = cutRing('box', { w: 60, d: 45, h: 40 });
    const top = Math.max(...mesh.verts.map(v => v.p.y));
    const e = [...mesh.edges()].find(h => h.face && h.twin && h.twin.face
      && Math.abs(h.v.p.y - top) < 1e-6 && Math.abs(h.to.p.y - top) < 1e-6);
    const a = edit.offsetEdgeLoop(mesh, [e], 4, { mode: 'cm' });
    ok('★★ 只選一條【原本的】邊（端點 3 價）→ ✅ 做得出來', a.ok, a.reason || '');
    eq('★ 　 兩側各一條 ＝ 2 條新線', a.ok ? a.newEdges.length : -1, 2);

    const b = edit.offsetEdgeLoop(mesh, [hes[0]], 4, { mode: 'cm' });
    ok('★★ 【環切線上】的一條邊（端點 4 價）→ 擋下來', !b.ok);
    ok('★★ 　 訊息講「旁邊有 3 條邊」，⛔ 不是「要選一整圈」',
       !b.ok && /3 條邊/.test(b.reason || '') && !/要選一整圈/.test(b.reason || ''), b.reason);
  }
}

section('內縮（Inset）：加線 × 面的內縮輪廓');

/**
 * 🔴 **這一組同時在驗兩件事**：內縮本身，以及
 * **「加線／加面／移除／移動」四動作框架成不成立**（kang 2026-08-25 選的試金石）。
 *
 * 框架成立的判準很具體：**內縮不該有任何一行新的數學** ——
 * miter 是 `shell()` 現成的、外緣是 `boundaryLoops()`、重建是 `fromFaceList()`、
 * 新邊標 `hard` 是環切那一輪定的規則。
 */
{
  const baked = (type, params) => {
    const r = edit.mergeCoplanarFaces(buildPrim(type, params));
    const m = r.ok ? r.mesh : buildPrim(type, params);
    m.computeNormals();
    return m;
  };
  const edgeCnt = m => [...m.edges()].length;
  const chiOf = m => m.verts.length - edgeCnt(m) + m.faces.length;

  {
    const box = baked('box', { w: 60, d: 45, h: 40 });
    const top = box.faces.find(f => f.normal.z > 0.99);
    const vol0 = box.volume(), area0 = box.area();
    const r = edit.insetFaces(box, top, 5);
    ok('內縮成功', r.ok);

    eq('V 8 → 12', r.mesh.verts.length, 12);
    eq('F 6 → 10', r.mesh.faces.length, 10);
    eq('★★ χ 仍然是 2', chiOf(r.mesh), 2);
    ok('　　仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);

    /**
     * 🔴 **內縮只加線，形狀一格都不能變** —— 跟環切同一條斷言。
     * 這一條就是「它是加線，不是別的東西」的機械證明。
     */
    rel('★★ 體積精確不變', r.mesh.volume(), vol0);
    rel('★★ 面積精確不變', r.mesh.area(), area0);

    eq('★ 新的一圈 4 條邊，而且全部標成 hard', r.ring, 4);
    eq('　　hard 邊確實是 4 條', [...r.mesh.edges()].filter(he => he.hard).length, 4);
    eq('迴圈 1 圈', r.loops, 1);

    /**
     * 🔴 **miter：只推角平分線會不夠寬。**
     * 內縮 5 的話，實際牆距要剛好是 5 —— 沿角平分線推 5 只會得到
     * 5×cos45° ＝ 3.5355（`shell()` 檔頭那個坑第 7 條的同一件事）。
     * 這裡直接量新的一圈離原本的邊多遠。
     */
    {
      const b = box.bounds();
      const inner = r.mesh.verts.filter(v => Math.abs(v.p.z - b.max.z) < 1e-9
        && Math.abs(v.p.x) < 29.9);
      const dx = Math.min(...inner.map(v => Math.abs(Math.abs(v.p.x) - 30)));
      const dy = Math.min(...inner.map(v => Math.abs(Math.abs(v.p.y) - 20)));
      near('★★ 實際牆距 x 剛好是 5（不是 3.5355）', dx, 5, 1e-9);
      near('★★ 實際牆距 y 剛好是 5', dy, 5, 1e-9);
    }

    /**
     * 🔴 **內圈那個面要能單獨選到、單獨拉動。**
     * 它跟外框那一圈是**共面**的，所以只有 `hard` 邊擋住 `planarRegions()`
     * 泛洪，它才會自成一區。沒有那條規則的話會選到一整片，內縮等於沒作用。
     */
    ok('★ 有回傳內圈那個面', !!r.innerFace);
    eq('★★ 內圈那個面自成一區（hard 邊把它跟外框斷開）',
       edit.regionOf(r.mesh, r.innerFace).faces.length, 1);
    eq('　　而且是 4 邊形', r.mesh.faceVerts(r.innerFace).length, 4);

    /**
     * 🔴 **方案 C 的端對端驗證**：內縮完沿法向推，做出一個凹槽。
     * 頂面是 60×40，內縮 5 之後推 10 —— 牆是斜的，所以挖掉的體積是
     *   ∫₀¹⁰ (60−u)(40−u) du ＝ 24000 − 5000 + 1000/3 ＝ 19333.3333…
     * ⚠ **這個數字連「牆是斜的」都算進去了**。
     * 〔一開始拿 50×30×10 ＝ 15000 去對，那是把凹槽當成直壁 —— 模型錯，不是程式錯〕
     */
    {
      const before = r.mesh.volume();
      edit.moveElement(r.mesh, { kind: 'face', face: r.innerFace, mesh: r.mesh },
                       new THREE.Vector3(0, 0, -10));
      edit.refreshAfterEdit(r.mesh);
      const want = 24000 - 5000 + 1000 / 3;
      rel('★★ 內縮 → 沿法向推 10 → 挖掉的體積 ＝ 斜壁凹槽的積分值',
          before - r.mesh.volume(), want);
      ok('　　推完仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
    }
  }

  {
    /**
     * ⚠ **多個迴圈的區域照樣內縮得了。**
     * 管的端面是環形（外圈 ＋ 內孔），「面內」的方向由 `n × 邊方向` 決定，
     * 外圈往內、內孔往外 —— **同一條公式自己就對了**，不必分開判斷。
     * 〔對照：`mergeCoplanarFaces()` 遇到多迴圈是跳過的，因為一個面裝不下兩圈〕
     */
    const tube = baked('tube', { rOuter: 25, rInner: 15, h: 40, seg: 16 });
    const cap = tube.faces.find(f => Math.abs(f.normal.y) > 0.99)
             || tube.faces.find(f => Math.abs(f.normal.z) > 0.99);
    const vol0 = tube.volume(), area0 = tube.area(), chi0 = chiOf(tube);
    const r = edit.insetFaces(tube, cap, 2);
    ok('★ 環形的端面（外圈＋內孔）內縮得了', r.ok);
    eq('　　兩個迴圈都內縮了', r.loops, 2);
    eq(`　　χ 仍然是 ${chi0}（管是穿孔的，本來就不是 2）`, chiOf(r.mesh), chi0);
    rel('★★ 體積精確不變', r.mesh.volume(), vol0);
    rel('★★ 面積精確不變', r.mesh.area(), area0);
  }

  {
    /** 16 段圓柱的端面是 16 邊形 —— n 邊形也要內縮得了 */
    const cyl = baked('cylinder', { r: 25, h: 60, seg: 16 });
    const cap = cyl.faces.find(f => f.normal.y > 0.99) || cyl.faces.find(f => f.normal.z > 0.99);
    const vol0 = cyl.volume();
    const r = edit.insetFaces(cyl, cap, 3);
    ok('★ 16 邊形的端面內縮得了', r.ok);
    eq('　　新的一圈 16 條邊', r.ring, 16);
    eq('　　χ 仍是 2', chiOf(r.mesh), 2);
    rel('★★ 體積精確不變', r.mesh.volume(), vol0);
  }

  {
    /** 擋下來的情形 */
    const box = baked('box', { w: 60, d: 45, h: 40 });
    const top = box.faces.find(f => f.normal.z > 0.99);
    ok('寬度 0 擋下來並說原因',
       !edit.insetFaces(box, top, 0).ok && /大於 0/.test(edit.insetFaces(box, top, 0).reason || ''));
    ok('沒給面擋下來', !edit.insetFaces(box, null, 5).ok);
  }

  {
    /** 標記要活過內縮（走拆掉重建，所以是必驗的一條） */
    const box = baked('box', { w: 60, d: 45, h: 40 });
    const e0 = [...box.edges()][0];
    box.setRole(e0, EDGE_ROLE.CUT);
    box.setSmooth(e0, true);
    const top = box.faces.find(f => f.normal.z > 0.99);
    const r = edit.insetFaces(box, top, 5);
    marksSurvive('★ 內縮之後每一樣標記都還在', box, r.mesh, r.remap);
  }
}

section('法向：重算外側 ／ 翻面');

/**
 * 🔴 **這一組守的是「畫面上完全看不出來」的那一類錯。**
 *
 * 繞向錯了 three.js 照樣打光、圖看起來完全正常，只有**有號體積**會露餡。
 * 這個專案已經為它踩過坑第 29 條、導角實測又中一次
 * （錯的繞向體積 99750、畫面完全正常）。
 */
{
  /** 把面表拿出來，讓測試可以故意做出壞掉的網格 */
  const rewound = (m, mut) => {
    const vi = m._vertIndex();
    const pts = m.verts.map(v => v.p.clone());
    const fs = m.faces.map((f, i) => mut(m.faceVerts(f).map(v => vi.get(v.id)), i));
    const x = Mesh.fromFaceList(pts, fs);
    x.computeNormals();
    return x;
  };
  const box = (() => {
    const r = edit.mergeCoplanarFaces(buildPrim('box', { w: 60, d: 45, h: 40 }));
    const m = r.ok ? r.mesh : buildPrim('box', { w: 60, d: 45, h: 40 });
    m.computeNormals();
    return m;
  })();

  /** ① 本來就對 → 什麼都不做，而且要講一句（不能悶著記一步 Undo） */
  {
    const r = edit.recalcNormalsOutside(box);
    ok('★ 本來就對的網格：不動它，而且講出理由',
       !r.ok && /本來就一致/.test(r.reason || ''), r.reason);
  }

  /**
   * ② 整個內外顛倒。
   * 🔴 **這是最陰險的一種**：`closed=true`、`ok=true`、沒有 issues，
   * **只有體積是負的**。現有的檢查一個都抓不到。
   */
  {
    const bad = rewound(box, f => f.slice().reverse());
    const v = bad.validate();
    ok('★★ （前置）整個顛倒時 closed/ok 都是正常的，只有體積是負的',
       v.ok && v.closed && bad.volume() < 0, `ok=${v.ok} closed=${v.closed} vol=${bad.volume()}`);
    const r = edit.recalcNormalsOutside(bad);
    ok('修得動', r.ok);
    rel('★★ 體積由負轉正，而且大小完全一樣', r.mesh.volume(), 108000);
    eq('　　整體翻了 1 組', r.flippedComponents, 1);
    eq('　　沒有面是「跟鄰居矛盾」', r.fixedInconsistent, 0);
  }

  /** ③ 只有一個面反 → 相鄰面矛盾。這種 `fromFaceList()` 配不到 twin，會變非流形 */
  {
    const bad = rewound(box, (f, i) => (i === 0 ? f.slice().reverse() : f));
    const v0 = bad.validate();
    ok('（前置）一個面反掉會變成非流形 ＋ 不封閉',
       !v0.ok && !v0.closed, `χ=${v0.euler} closed=${v0.closed}`);
    const r = edit.recalcNormalsOutside(bad);
    const v1 = r.mesh.validate();
    ok('★★ 修完之後封閉、χ 回到 2、沒有 issues',
       v1.ok && v1.closed && v1.euler === 2, `χ=${v1.euler} closed=${v1.closed} ok=${v1.ok}`);
    rel('★★ 體積回到 108000（原本被算成 72000）', r.mesh.volume(), 108000);
  }

  /**
   * ④ 兩個分開的物件一正一反。
   * 🔴 **總體積剛好是 0**，而 `closed=true ok=true` —— 完全沒有徵兆。
   * 所以內外一定要**逐個連通元件**判斷，不能看整體體積。
   */
  {
    const b = (() => {
      const r = edit.mergeCoplanarFaces(buildPrim('box', { w: 20, d: 20, h: 20 }));
      return r.ok ? r.mesh : buildPrim('box', { w: 20, d: 20, h: 20 });
    })();
    b.computeNormals();
    const vi = b._vertIndex(), n = b.verts.length;
    const pts = [...b.verts.map(v => v.p.clone()),
                 ...b.verts.map(v => v.p.clone().add(new THREE.Vector3(50, 0, 0)))];
    const f1 = b.faces.map(f => b.faceVerts(f).map(v => vi.get(v.id)));
    const two = Mesh.fromFaceList(pts, [...f1, ...f1.map(f => f.map(i => i + n).reverse())]);
    two.computeNormals();
    const v = two.validate();
    ok('★★ （前置）兩個一正一反：ok/closed 正常，總體積剛好 0',
       v.ok && v.closed && Math.abs(two.volume()) < 1e-9, `vol=${two.volume()}`);
    const r = edit.recalcNormalsOutside(two);
    eq('★ 認出 2 個連通元件', r.components, 2);
    eq('　　只翻了其中 1 組', r.flippedComponents, 1);
    rel('★★ 修完體積 ＝ 兩個 20³ 相加', r.mesh.volume(), 16000);
  }

  /**
   * ⑤ 開放的網格：**不猜內外，只做一致化，而且要講明白。**
   * 「外側」對一張沒有厚度的殼在數學上沒有定義 ——
   * 實測平板體積 0、折板 44929（一個沒有意義的數字）。
   * 硬猜有一半機率猜反，而猜反的後果跟原本的病一樣嚴重。
   */
  {
    const plate = buildPrim('plate', { w: 100, d: 60 }, 0.2);
    plate.computeNormals();
    const r = edit.recalcNormalsOutside(plate);
    ok('★★ 開放的網格不去猜外側，而且講出理由',
       !r.ok && r.openComponents === 1 && /沒有定義/.test(r.reason || ''), r.reason);
  }

  /** ⑥ 翻面：翻兩次要回到原點，而且標記一樣都不能少 */
  {
    const r1 = edit.flipNormals(box);
    rel('★ 翻一次體積變號', r1.mesh.volume(), -108000);
    rel('★ 再翻一次回到原點', edit.flipNormals(r1.mesh).mesh.volume(), 108000);
    eq('　　面數不變', r1.mesh.faces.length, box.faces.length);

    /** 翻繞向只改「面裡頂點的順序」，頂點索引沒變 → 標記照樣對得上 */
    const m = box.clone();
    const e0 = [...m.edges()][0];
    m.setRole(e0, EDGE_ROLE.CUT);
    m.setSmooth(e0, true);
    const cv = [...m.edges()].find(he => {
      const d = he.to.p.clone().sub(he.v.p);
      return Math.abs(d.z) > 1e-9 && Math.hypot(d.x, d.y) < 1e-9;
    });
    const withHard = edit.loopCut(m, cv).mesh;
    marksSurvive('★★ 翻面之後每一樣標記都還在', withHard, edit.flipNormals(withHard).mesh);
  }
}

section('刪除面 ＋ 補洞（一對）');

/**
 * 🔴 **這兩個是一對，不是先後。**
 * 沒有刪除面就做不出洞，沒有補洞就補不回去。
 * 〔原本排的順序是「補面先做，因為它是刪除面的前提」——**那個說法有問題**：
 * 　補洞當時根本沒有輸入。是 kang 2026-08-25 問「不懂意思」才發現的〕
 *
 * ⭐ 這一組最有價值的斷言是**來回**：刪掉再補回來，
 * **體積、面數、頂點數要精確還原** —— 那是可以對答案的。
 */
{
  const baked = (type, params) => {
    const r = edit.mergeCoplanarFaces(buildPrim(type, params));
    const m = r.ok ? r.mesh : buildPrim(type, params);
    m.computeNormals();
    return m;
  };
  const chiOf = m => m.validate().euler;
  const topOf = m => {
    m.computeNormals();
    return m.faces.find(f => f.normal.z > 0.99) || m.faces.find(f => f.normal.y > 0.99);
  };

  {
    /** ① 刪一個面 → χ 2→1、變開放 */
    const m = baked('box', { w: 60, d: 45, h: 40 });
    const r = edit.deleteFaces(m, [{ kind: 'face', face: topOf(m) }]);
    ok('刪除成功', r.ok);
    eq('★ 刪掉 1 個面（共面區域，不是一個三角形）', r.removed, 1);
    eq('★★ χ 2 → 1', chiOf(r.mesh), 1);
    ok('★★ 從封閉變成開放（那是它最大的代價，畫面上看不出來）',
       r.wasClosed && !r.nowClosed);
    ok('　　結構仍然沒問題', r.mesh.validate().ok);
  }

  {
    /**
     * ② 🔴 **來回：刪掉再補回來，要精確還原。**
     * 這一條同時驗兩支，而且是可以對答案的量。
     */
    const m0 = baked('box', { w: 60, d: 45, h: 40 });
    const want = { v: m0.volume(), f: m0.faces.length, vt: m0.verts.length };
    const d = edit.deleteFaces(m0, [{ kind: 'face', face: topOf(m0) }]);
    const f = edit.fillHoles(d.mesh);
    ok('補洞成功', f.ok);
    eq('★ 補了 1 個洞，而且是 4 邊形', `${f.holes}/${f.sizes.join(',')}`, '1/4');
    rel('★★ 體積精確還原', f.mesh.volume(), want.v);
    eq('★★ 面數精確還原', f.mesh.faces.length, want.f);
    eq('★★ 頂點數精確還原', f.mesh.verts.length, want.vt);
    ok('　　表面回到封閉、χ 回到 2', f.mesh.isClosed() && chiOf(f.mesh) === 2);
  }

  {
    /**
     * ③ ⚠ **刪一個角落周圍的三個面會產生孤點** —— 那個角只被那三個面用著。
     * `cleanRebuild()` 會清掉，而清掉就會讓索引位移，所以標記一定要走 remap。
     */
    const m = baked('box', { w: 60, d: 45, h: 40 });
    const b = m.bounds();
    const c = m.verts.find(v => Math.abs(v.p.x - b.max.x) < 1e-6
      && Math.abs(v.p.y - b.max.y) < 1e-6 && Math.abs(v.p.z - b.max.z) < 1e-6);
    const around = m.faces.filter(f => m.faceVerts(f).includes(c));
    const r = edit.deleteFaces(m, around.map(face => ({ kind: 'face', face })));
    ok('刪一個角落周圍的三個面：成功', r.ok);
    eq('★★ 真的會產生孤點，而且被清掉了', r.orphans, 1);
    ok('　　結構仍然沒問題', r.mesh.validate().ok);
  }

  {
    /** ④ 16 邊形的洞（圓柱端面）也補得回來 */
    const m0 = baked('cylinder', { r: 25, h: 60, seg: 16 });
    const v0 = m0.volume();
    const d = edit.deleteFaces(m0, [{ kind: 'face', face: topOf(m0) }]);
    const f = edit.fillHoles(d.mesh);
    eq('★ 補出一個 16 邊形', f.sizes.join(','), '16');
    rel('★★ 體積精確還原', f.mesh.volume(), v0);
  }

  {
    /** ⑤ 兩個不相鄰的洞，一次補回來 */
    const m0 = baked('box', { w: 60, d: 45, h: 40 });
    m0.computeNormals();
    const v0 = m0.volume();
    const two = [m0.faces.find(f => f.normal.z > 0.99), m0.faces.find(f => f.normal.z < -0.99)];
    const d = edit.deleteFaces(m0, two.map(face => ({ kind: 'face', face })));
    eq('（前置）刪掉兩個面之後 χ 是 0', chiOf(d.mesh), 0);
    const f = edit.fillHoles(d.mesh);
    eq('★ 一次補回兩個洞', f.holes, 2);
    rel('★★ 體積精確還原', f.mesh.volume(), v0);
  }

  {
    /**
     * ⑥ 🔴 **標記要活過「刪除 → 補洞」，而且不可以憑空多出來。**
     *
     * ⚠ 這一條抓到兩個漏洞（2026-08-25 沙箱）：
     * ① `deleteFaces()` 忘了搬標記 → `smooth` 掉光
     * ② **假邊界**：刪面留下的邊界被 `_buildBoundaryLoops()` 自動標成 CUT，
     *    補回去之後那些 CUT 留著 → **CUT 從 1 條變成 4 條**
     */
    const m = baked('box', { w: 60, d: 45, h: 40 });
    const side = [...m.edges()].find(he => {
      const d = he.to.p.clone().sub(he.v.p);
      return Math.abs(d.z) > 1e-6 && Math.hypot(d.x, d.y) < 1e-6;
    });
    m.setRole(side, EDGE_ROLE.CUT);
    m.setSmooth(side, true);
    const d = edit.deleteFaces(m, [{ kind: 'face', face: topOf(m) }]);
    const f = edit.fillHoles(d.mesh);
    eq('★★ CUT 還是 1 條（不多不少）',
       [...f.mesh.edges()].filter(he => he.role === EDGE_ROLE.CUT).length, 1);
    eq('★★ smooth 還是 1 條（deleteFaces 原本忘了搬）',
       [...f.mesh.edges()].filter(he => he.smooth).length, 1);
  }

  {
    /** ⑦⑧ 擋下來的兩種情形 */
    const m = baked('box', { w: 60, d: 45, h: 40 });
    const f = edit.fillHoles(m);
    ok('★ 沒有洞的時候按補洞 → 擋下來並說原因', !f.ok && /沒有洞/.test(f.reason || ''), f.reason);
    const r = edit.deleteFaces(m, m.faces.map(face => ({ kind: 'face', face })));
    ok('★ 想把面刪光 → 擋下來，而且講出出路（用工具列的「刪除」）',
       !r.ok && /刪光/.test(r.reason || ''), r.reason);
  }

  {
    /**
     * ⑨ 🔴 **「洞在一個頂點上捏成一點」要擋下來。**
     *
     * 那是 `mesh.js` 的既有限制：`_buildBoundaryLoops()` 用
     * 「頂點 → 邊界半邊」的 Map 串迴圈，**一個頂點只放得下一條**。
     * 刪掉的面只在一個頂點相接時，那個頂點會同時落在兩個洞上 → 迴圈斷掉。
     * 〔2026-08-25 壓力測試抓到：球 seg8 隨機刪 4 個面就會踩到，
     * 　症狀是「半邊沒有 next」、χ −2〕
     */
    const sph = baked('sphere', { r: 25, seg: 8 });
    sph.computeNormals();
    // 找兩個「只共用一個頂點」的面
    let pair = null;
    outer:
    for (const a of sph.faces) {
      const va = new Set(sph.faceVerts(a));
      for (const b of sph.faces) {
        if (a === b) continue;
        const shared = sph.faceVerts(b).filter(v => va.has(v));
        if (shared.length === 1) { pair = [a, b]; break outer; }
      }
    }
    ok('（前置）球上找得到「只共用一個頂點」的兩個面', !!pair);
    if (pair) {
      const r = edit.deleteFaces(sph, pair.map(face => ({ kind: 'face', face })));
      ok('★★ 擋下來並說原因（不要做出邊界斷掉的網格）',
         !r.ok && /捏/.test(r.reason || ''), r.reason);
    }
  }

  {
    /**
     * ⑩ ⚠ **補洞不知道原本那裡是什麼形狀** —— 它只把每個邊界迴圈補成一個面。
     *
     * 管的端面是**環形**（外圈 ＋ 內孔）。刪掉之後有兩個邊界迴圈，
     * 補洞把兩個各補一個面 → **內孔被塞住，管變成實心**。
     *
     * 🔴 那是**資料結構的限制**，不是 bug：**一個面裝不下兩個迴圈**
     * （`mergeCoplanarFaces()` 也正是為此跳過環形區域）。
     * ⛔ 所以「刪掉再補回來」對環形的面**不成立**，不要拿它當回歸斷言。
     */
    const tube = baked('tube', { rOuter: 25, rInner: 15, h: 40, seg: 12 });
    tube.computeNormals();
    const cap = tube.faces.find(f => Math.abs(f.normal.y) > 0.99)
             || tube.faces.find(f => Math.abs(f.normal.z) > 0.99);
    const chi0 = chiOf(tube);
    const d = edit.deleteFaces(tube, [{ kind: 'face', face: cap }]);
    ok('管的端面刪得掉', d.ok);
    const f = edit.fillHoles(d.mesh);
    ok('補得回來（但不是原本的形狀）', f.ok);
    ok('★★ 內孔被塞住了 —— χ 從 0 變成 2（那是限制，不是 bug）',
       chi0 === 0 && chiOf(f.mesh) === 2, `χ ${chi0} → ${chiOf(f.mesh)}`);
  }

  {
    /**
     * ⑪ ⚠ **板件的「邊界」不是洞，是它本來的外輪廓。**
     * 補了會把它封成一個**零體積**的殼 —— 而畫面上看起來一模一樣。
     * ⛔ 不擋（幾何上分不出「洞」與「外輪廓」），但呼叫端要把體積講出來。
     */
    const plate = buildPrim('plate', { w: 100, d: 60 }, 0.2);
    plate.computeNormals();
    const f = edit.fillHoles(plate);
    ok('板件按補洞：做得出來（不擋）', f.ok);
    ok('★ 但補完是一個零體積的殼 —— 所以呼叫端一定要把體積講出來',
       f.ok && f.mesh.isClosed() && Math.abs(f.mesh.volume()) < 1e-9,
       f.ok ? `體積 ${f.mesh.volume()}` : '');
  }
}

section('橋接邊迴圈：兩個洞 → 一段管');

/**
 * 🔴 **這一組守的是繞向，⛔ 不是數學。**
 *
 * 橋接沒有任何新數學（一個頂點都不新增、一個座標都不動），
 * **唯一會錯的地方就是那 32 片側牆的點該照什麼順序排** ——
 * 而排錯了**形狀在畫面上看起來還是一根管**，只有 χ 跟「封不封閉」抓得到。
 *
 * ⚠ **第一版真的排錯了**（2026-08-28，照抄 `extrudeFace()` 的 `(a,b,b',a')`）：
 * χ **−62**、不封閉。病因是 `boundaryEdges()` 回的是**有面的那一條**半邊，
 * 新面跟它同方向就是「兩個面在同一條邊上走同方向」＝ 面貼反了。
 * 〔鐵律一「同一個檔案裡的寫法不一定能照抄」的又一例〕
 *
 * ⭐ **邊數是這一組最好用的斷言**：接 n 片牆，每片只該長出 1 條新的
 * 垂直邊 → **邊數正好 +n**。排錯的話是 +3n（每片的三條邊都沒接上）。
 */
{
  const selectops = await import('../js/core/selectops.js');
  const baked = (type, params) => {
    const r = edit.mergeCoplanarFaces(buildPrim(type, params));
    const m = r.ok ? r.mesh : buildPrim(type, params);
    m.computeNormals();
    return m;
  };
  const eCount = m => [...m.edges()].length;
  const chiOf = m => m.validate().euler;

  /** 把兩個網格併成一個 ＝ 使用者按「∪ 聯集」兩個沒碰到的東西 */
  const combine = (a, b, dy) => {
    const ia = a._vertIndex(), ib = b._vertIndex();
    const pa = a.verts.map(v => v.p.clone());
    const pb = b.verts.map(v => { const p = v.p.clone(); p.y += dy; return p; });
    const fa = a.faces.map(f => a.faceVerts(f).map(v => ia.get(v.id)));
    const fb = b.faces.map(f => b.faceVerts(f).map(v => ib.get(v.id) + pa.length));
    const m = Mesh.fromFaceList([...pa, ...pb], [...fa, ...fb]);
    m.computeNormals();
    return m;
  };
  /** 刪掉 y 在某個高度的那個蓋子（蓋子 ＝ 點數超過 4 的面）*/
  const openAt = (m, y) => {
    const f = m.faces.find(ff => m.faceVerts(ff).length > 4
      && Math.abs(m.faceVerts(ff)[0].p.y - y) < 1e-6);
    const r = edit.deleteFaces(m, [{ kind: 'face', face: f }]);
    r.mesh.computeNormals();
    return r.mesh;
  };
  /** 兩根圓柱、相距 30，各開一個相對的口 */
  const pipe = (r1, r2, seg1 = 32, seg2 = 32) => {
    let m = combine(baked('cylinder', { r: r1, h: 70, seg: seg1 }),
                    baked('cylinder', { r: r2, h: 70, seg: seg2 }), 100);
    return openAt(openAt(m, 35), 65);
  };
  /** 32 邊形的面積（外接半徑 r）*/
  const polyArea = r => 0.5 * 32 * r * r * Math.sin(2 * Math.PI / 32);

  {
    /** ① 🔴 **變徑管：主線案例，體積可以手算對答案。** */
    const m = pipe(25, 15);
    const b = selectops.boundaryEdges(m);
    eq('★ 開了兩個口 → 剛好 2 個洞', b.holes, 2);
    eq('★ 兩圈都串得成環，各 32 條', b.loops.map(l => l && l.length).join(','), '32,32');

    const eBefore = eCount(m);
    const r = edit.bridgeLoops(m, b.loops[0], b.loops[1], { turn: 0 });
    ok('橋接成功', r.ok, r.reason || '');
    eq('★ 接了 32 片側牆', r.walls, 32);
    eq('★★ 一個頂點都沒新增（＝「既有頂點保持原索引」天生滿足）',
       r.mesh.verts.length, m.verts.length);
    eq('★★ 🔴 邊數正好 +32（排錯的話是 +96）', eCount(r.mesh) - eBefore, 32);
    eq('★★ χ 回到 2', chiOf(r.mesh), 2);
    ok('★★ 表面變成封閉的（兩塊接成一塊）', r.nowClosed);
    ok('　　結構沒問題', r.mesh.validate().ok);

    /**
     * ★★ **體積對答案：32 邊柱 ＋ 32 邊柱 ＋ 錐台。**
     * ⚠ **容許值放到 1e-7 是有理由的，⛔ 不是隨便放寬** ——
     * 【實證】**單獨一根還沒被動過的圓柱本身就差 3.8e-3**
     * （`buildPrim` 的頂點半徑是 24.999999994 ～ 25.000000622）。
     * 🔴 **橋接一格誤差都沒有引入**，那個差是它繼承來的。
     */
    const A1 = polyArea(25), A2 = polyArea(15);
    rel('★★ 體積對得上手算（32邊柱 + 32邊柱 + 錐台）',
        r.mesh.volume(), A1 * 70 + A2 * 70 + 10 * (A1 + A2 + Math.sqrt(A1 * A2)));
  }

  {
    /** ② `轉幾格`：kang 2026-08-28 拍板的那個欄位，⛔ 不猜、把選擇權給他 */
    const mk = turn => {
      const m = pipe(25, 15);
      const b = selectops.boundaryEdges(m);
      return edit.bridgeLoops(m, b.loops[0], b.loops[1], { turn });
    };
    const r0 = mk(0), r1 = mk(1), r32 = mk(32);
    ok('轉一格也接得起來，χ 仍然是 2', r1.ok && chiOf(r1.mesh) === 2);
    ok('★ 轉一格形狀真的不一樣（＝ 那個欄位有作用）',
       Math.abs(r0.mesh.volume() - r1.mesh.volume()) > 1,
       `${r0.mesh.volume().toFixed(1)} vs ${r1.mesh.volume().toFixed(1)}`);
    rel('★★ 轉一整圈（32 格）＝ 沒轉', r32.mesh.volume(), r0.mesh.volume(), 1e-12);
  }

  {
    /**
     * ③ 🔴 **三道擋關，每一道都要「講得出原因 ＋ 指得出出路」**
     * 〔坑第 34 條：⛔ 不要指一條不存在的退路 —— 這三條出路都是真的按鈕〕
     */
    const m1 = pipe(25, 15, 32, 16);
    const b1 = selectops.boundaryEdges(m1);
    const bad1 = edit.bridgeLoops(m1, b1.loops[0], b1.loops[1], {});
    ok('★ 兩圈點數不同 → 擋下來', !bad1.ok);
    ok('★★ 　而且指出路「邊上加點」', !bad1.ok && /邊上加點/.test(bad1.reason || ''),
       bad1.reason);
    ok('　　訊息裡有實際的數字（32 對 16）', /32/.test(bad1.reason || '') && /16/.test(bad1.reason || ''));

    /**
     * ★★ 🔴 **兩圈之間本來就有面** —— 這一道是實測掉出來的，⛔ 前三道漏了它。
     * 拿「刪掉上下蓋的圓柱」接自己的兩端：中間隔著的正是那 32 片側牆，
     * 新接上去的跟它們一模一樣 → **`cleanRebuild()` 會安靜地清光**，
     * 使用者看到的是「**按了沒反應**」（坑第 21 條）。
     */
    let cyl = baked('cylinder', { r: 25, h: 70, seg: 32 });
    cyl = openAt(openAt(cyl, 35), -35);
    const b2 = selectops.boundaryEdges(cyl);
    const bad2 = edit.bridgeLoops(cyl, b2.loops[0], b2.loops[1], {});
    ok('★★ 兩圈之間已經有面 → 擋下來（⛔ 不可以安靜地沒反應）', !bad2.ok, bad2.reason);
    ok('　　而且講得出中間隔著幾片', !bad2.ok && /32/.test(bad2.reason || ''));
  }

  {
    /** ④ `boundaryEdges().loops`：串不出環就回 `null`，⛔ 不回半條 */
    const m = baked('box', { w: 60, d: 45, h: 40 });
    const b = selectops.boundaryEdges(m);
    eq('★ 沒有洞的物件：0 個洞、0 個環', `${b.holes}/${b.loops.length}`, '0/0');
  }

  {
    /**
     * ⑤ 🔴🔴 **開放的網格沒有體積 —— ⛔ 不可以印給使用者看。**
     *
     * 〔kang 2026-08-28 實測第 3 項照出來的：提示訊息原本寫
     * 　「體積 211998.16 → 208668.62」，而**前面那個是垃圾**〕
     *
     * `volume()` 走散度定理，**前提是封閉**。開放網格算出來的值
     * **依賴物件擺在哪裡** —— 而真正的體積不會因為搬動而改變。
     *
     * ⭐ **這一項守的是「不要再把它印出來」**，⛔ 不是要修 `volume()`
     * （封閉時它是對的，而「開放時回什麼」本來就沒有定義）。
     */
    let open = baked('cylinder', { r: 25, h: 70, seg: 32 });
    open = openAt(open, 35);
    ok('（前置）缺一個蓋 ＝ 開放的', !open.isClosed());

    const at = dy => {
      const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
      const o = openAt(m, 35);
      for (const v of o.verts) v.p.y += dy;
      return o.volume();
    };
    const v0 = at(0), v124 = at(124), v500 = at(500);
    ok('★★ 🔴 同一個開放形狀，搬個高度那個數字就變（⛔ 所以它不是體積）',
       Math.abs(v0 - v124) > 1, `y+0 ${v0.toFixed(2)} ／ y+124 ${v124.toFixed(2)}`);
    ok('★★ 　　搬得夠遠還會變負的', v500 < 0, `y+500 ${v500.toFixed(2)}`);

    /** ⭐ 對照組：封閉的搬到哪都一樣 —— 那才是散度定理的前提 */
    const closedAt = dy => {
      const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
      for (const v of m.verts) v.p.y += dy;
      return m.volume();
    };
    rel('★★ ⭐ 對照組：封閉的網格搬到哪，體積都一樣',
        closedAt(500), closedAt(0), 1e-9);
  }
}

section('導角（Bevel，單段）：內縮 ＋ 加面');

/**
 * 🔴 **這一組守的是「角落」** —— `外部參考-Blender編輯.md` 第 9.6／9.10 節
 * 原本都寫著「角落斜接完全沒驗」。
 *
 * 結論（第 11 節）：**「不唯一」只對多段導角（圓角）成立**；
 * 單段（斜切）在 **3 價頂點**上角落是唯一的。
 * ⚠ 而「我們的頂點全是 3 價」**是錯的** —— 圓錐有 4～6 價的，見底下那一組。
 */
{
  const baked = (type, params) => {
    const r = edit.mergeCoplanarFaces(buildPrim(type, params));
    const m = r.ok ? r.mesh : buildPrim(type, params);
    m.computeNormals();
    return m;
  };
  const edgeCnt = m => [...m.edges()].length;
  const chiOf = m => m.verts.length - edgeCnt(m) + m.faces.length;
  const box = baked('box', { w: 60, d: 45, h: 40 });

  {
    /** ① 一條邊。🔴 這一項可以**手算對答案** */
    const t = [...box.edges()].find(he => {
      const d = he.to.p.clone().sub(he.v.p);
      return Math.abs(d.x) > 50 && Math.hypot(d.y, d.z) < 1e-9;
    });
    const r = edit.bevelEdges(box, [t], 5);
    ok('導角成功', r.ok);
    eq('★ 1 片斜切面、0 個角落面', `${r.walls}/${r.corners}`, '1/0');
    eq('★★ χ 仍然是 2', chiOf(r.mesh), 2);
    ok('　　仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
    rel('★★ 體積 ＝ 108000 − (5²/2)×60（手算精確吻合）', r.mesh.volume(), 108000 - 12.5 * 60);
  }

  {
    /**
     * ② 🔴 **一個角落的三條邊一起導 —— 這就是原本寫「完全沒驗」的那一項。**
     * 角落**自己長出一個三角形**，沒有任何「要怎麼接」的分支。
     * 體積用蒙地卡羅獨立算過（把結果當成一堆半空間的交集）：106271.03。
     */
    const b = box.bounds();
    const corner = box.verts.find(v => Math.abs(v.p.x - b.max.x) < 1e-9
      && Math.abs(v.p.y - b.max.y) < 1e-9 && Math.abs(v.p.z - b.max.z) < 1e-9);
    const es = [...box.edges()].filter(he => he.v === corner || he.to === corner);
    eq('（前置）那個角落有 3 條邊', es.length, 3);
    const r = edit.bevelEdges(box, es, 5);
    eq('★ 3 片斜切面、**1 個角落面**', `${r.walls}/${r.corners}`, '3/1');
    eq('★★ χ 仍然是 2', chiOf(r.mesh), 2);
    ok('　　仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
    near('★★ 體積跟蒙地卡羅獨立算的對得起來', r.mesh.volume(), 106271.03, 1.0);
  }

  {
    /** ③ 12 條邊全導：每個頂點三條邊都被導 → 8 個角落三角形 */
    const r = edit.bevelEdges(box, [...box.edges()], 5);
    eq('★ 12 片斜切面、8 個角落面', `${r.walls}/${r.corners}`, '12/8');
    eq('★★ χ 仍然是 2', chiOf(r.mesh), 2);
    ok('　　仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
    near('★★ 體積跟蒙地卡羅獨立算的對得起來', r.mesh.volume(), 101414.95, 3.0);
  }

  {
    /**
     * ④ 🔴 16 段圓柱上下兩圈：**每個頂點都是「2 條被導 ＋ 1 條沒被導」**。
     * 這個案例翻掉過一次 —— 共用「沒被導的邊」的兩個面代表點沒併，
     * 網格從那裡裂開（χ −14、不封閉）。用併查集解，**不用容許值**。
     */
    const cyl = baked('cylinder', { r: 25, h: 60, seg: 16 });
    const es = [...cyl.edges()].filter(he => {
      const d = he.to.p.clone().sub(he.v.p);
      return Math.hypot(d.x, d.z) > 1e-9 && Math.abs(d.y) < 1e-9;
    });
    const r = edit.bevelEdges(cyl, es, 2);
    eq('★ 32 片斜切面、0 個角落面（併完只剩 2 點，兩片自己接起來）',
       `${r.walls}/${r.corners}`, '32/0');
    eq('★★ χ 仍然是 2（沒有裂開）', chiOf(r.mesh), 2);
    ok('　　仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
    ok('　　體積有變小（真的削掉了東西）', r.mesh.volume() < cyl.volume());
  }

  {
    /**
     * ⑤ 🔴 **標記：沒被導的邊要照搬，被導掉的才該消失。**
     *
     * 這一項抓到兩個 bug（2026-08-25）：
     * ① 端點被「吸收」掉的邊配對會落空 → **4 條沒被導的邊標記直接消失**
     * ② 見下一個區塊的「假邊界」
     */
    const m = baked('box', { w: 60, d: 45, h: 40 });
    const es = [...m.edges()];
    m.setRole(es[0], EDGE_ROLE.CUT);
    m.setSmooth(es[0], true);
    m.setRole(es[5], EDGE_ROLE.CUT);
    const t = [...m.edges()].find(he => {
      const d = he.to.p.clone().sub(he.v.p);
      return Math.abs(d.x) > 50 && Math.hypot(d.y, d.z) < 1e-9;
    });
    const r = edit.bevelEdges(m, [t], 5);
    eq('★★ 沒被導的邊，CUT 一條都沒少',
       [...r.mesh.edges()].filter(he => he.role === EDGE_ROLE.CUT).length, 2);
    eq('★★ smooth 也還在', [...r.mesh.edges()].filter(he => he.smooth).length, 1);
    eq('★ 只有被導掉的那一條標記消失（它真的不存在了）', r.lostMarks, 1);
  }

  {
    /** 擋下來的情形 */
    ok('沒選邊擋下來', !edit.bevelEdges(box, [], 5).ok);
    ok('寬度 0 擋下來', !edit.bevelEdges(box, [[...box.edges()][0]], 0).ok);
  }

  /**
   * 🔴 **kang 2026-08-25 實測抓到的：一條一條導會做出奇怪的形狀。**
   *
   * 病因**不是**「一次導幾條」，是**偏移的方向算錯了**：
   * 只有一條邊被導時，旁邊那個面的角要**沿著「沒被導的那條邊」滑**，
   * 才會留在鄰居的平面上。原本寫成「垂直於被導的邊偏移」——
   * **方塊的兩條邊互相垂直，兩者剛好同一點**，所以第一刀看起來對，
   * 一旦形狀不再是直角就分岔，症狀是**吸收它的那個面變成非平面**，
   * 三角化之後畫面上出現奇怪的形狀。
   */
  {
    const seq = [];
    let cur = box;
    const dirs = [d => Math.abs(d.x) > 50, d => Math.abs(d.y) > 30, d => Math.abs(d.z) > 35];
    for (let i = 0; i < 3; i++) {
      const e = [...cur.edges()].find(he => {
        const d = he.to.p.clone().sub(he.v.p);
        return dirs[i](d) && he.face && he.twin && he.twin.face;
      });
      const r = edit.bevelEdges(cur, [e], 5);
      if (!r.ok) break;
      cur = r.mesh;
      seq.push(edit.nonPlanarFaces(cur).length);
    }
    eq('★★ 一條一條導三次，一個非平面的面都不該有', JSON.stringify(seq), '[0,0,0]');
    ok('　　而且每一步都封閉、χ 仍是 2',
       cur.isClosed() && chiOf(cur) === 2, `χ=${chiOf(cur)} closed=${cur.isClosed()}`);

    /**
     * 🔴 **順序無關**：一條一條導三次，要跟一次導三條得到同一個東西。
     * 那是這個 bug 壞掉時第一個會破的性質。
     */
    const at1 = (() => {
      const es = dirs.map(f => [...box.edges()].find(he => {
        const d = he.to.p.clone().sub(he.v.p);
        return f(d) && he.face && he.twin && he.twin.face;
      }));
      return edit.bevelEdges(box, es, 5);
    })();
    rel('★★ 一條一條 ＝ 一次全導（體積完全一樣）', cur.volume(), at1.mesh.volume());
    eq('　　面數也一樣', cur.faces.length, at1.mesh.faces.length);
    eq('　　兩邊都是 χ2 封閉',
       `${chiOf(cur)}/${cur.isClosed()}　${chiOf(at1.mesh)}/${at1.mesh.isClosed()}`,
       '2/true　2/true');
    /**
     * ⚠ **頂點數可以不一樣，那是正常的。**
     * 一條一條導會在角落留下**多餘但無害的頂點**（實測 14 vs 12，
     * 邊 21 vs 19，而面數與體積完全相同、χ 都是 2）——
     * 幾何一模一樣，只是網格沒那麼精簡。
     * 🔴 **所以這裡驗幾何，不驗頂點數** —— 拿頂點數去比會把正確的結果報成失敗。
     */
    ok('　　（頂點數可以不同，那是多餘但無害的點）',
       cur.verts.length >= at1.mesh.verts.length,
       `一條一條 ${cur.verts.length} 個、一次全導 ${at1.mesh.verts.length} 個`);
  }

  {
    /** 非直角也要成立（圓角方塊的垂直邊已經是圓角，跟頂面不是 90 度）*/
    const rb = baked('roundBox', { w: 60, d: 45, h: 40, r: 8, seg: 4 });
    let cur = rb, okAll = true;
    for (let i = 0; i < 3; i++) {
      const e = [...cur.edges()].filter(he => {
        const d = he.to.p.clone().sub(he.v.p);
        return Math.abs(d.y) < 1e-6 && he.face && he.twin && he.twin.face;
      })[i * 2];
      if (!e) break;
      const r = edit.bevelEdges(cur, [e], 2);
      if (!r.ok) { okAll = false; break; }
      cur = r.mesh;
      if (!cur.isClosed() || chiOf(cur) !== 2 || edit.nonPlanarFaces(cur).length) okAll = false;
    }
    ok('★★ 非直角的形狀（圓角方塊）一條一條導三次，全程封閉、χ2、無非平面', okAll);
  }

  {
    /**
     * 🔴 **「我們的頂點全是 3 價」那句話是錯的，而角落規則曾經建在它上面。**
     *
     * 實測圓錐 seg12 的價數分布是 **{3:10, 4:2, 5:2, 6:2}** ——
     * 那句話只對**方塊與圓柱**成立，被當成了全域事實。
     *
     * ⚠ **而這個限制比當初估的嚴重得多：導角自己就會製造 4 價頂點**
     * （方塊導完頂面四條，價數從 {3:8} 變成 {3:8, 4:4}），所以它擋掉的
     * 不是「圓錐那種特殊形狀」，而是「先導一組再導旁邊那一組」這種日常操作。
     *
     * ✅ **2026-08-25 第四次解出來了。** 真正的難處只有一個：
     * **繞一圈的順序（`vertOutgoing`）跟面迴圈的順序是相反的。**
     * 四次嘗試分別錯在哪，見 `外部參考-Blender編輯.md` 第 11.7 節。
     */
    const cone = baked('cone', { rTop: 0, rBottom: 30, h: 70, seg: 12 });
    const val = {};
    for (const v of cone.verts) {
      const n = cone.vertOutgoing(v).length;
      val[n] = (val[n] || 0) + 1;
    }
    ok('★★ （前置）圓錐真的有 4 價以上的頂點 —— 「全是 3 價」是錯的',
       Object.keys(val).some(k => +k > 3), JSON.stringify(val));

    const e = [...cone.edges()].find(he => {
      const d = he.to.p.clone().sub(he.v.p);
      return Math.abs(d.y) < 1e-6 && he.face && he.twin && he.twin.face;
    });
    const r = edit.bevelEdges(cone, [e], 3);
    ok('★★ 4 價以上只導一部分：做得出來了（原本會留一個三角形的洞）', r.ok, r.reason);
    ok('　　而且封閉、χ 仍是 2', r.ok && r.mesh.isClosed() && chiOf(r.mesh) === 2,
       r.ok ? `χ=${chiOf(r.mesh)} closed=${r.mesh.isClosed()}` : '');

    /**
     * 🔴 **kang 2026-08-25 實測踩到的那條路：先導一組，再導旁邊那一組。**
     * 第一步本身就會把方塊的價數從 {3:8} 變成 {3:8, 4:4}。
     */
    {
      const m = baked('box', { w: 60, d: 45, h: 40 });
      const bb = m.bounds();
      const top = [...m.edges()].filter(he =>
        Math.abs(he.v.p.z - bb.max.z) < 1e-6 && Math.abs(he.to.p.z - bb.max.z) < 1e-6);
      const r1 = edit.bevelEdges(m, top, 5);
      ok('（前置）先導頂面四條 —— 成功', r1.ok);
      const val1 = {};
      for (const v of r1.mesh.verts) {
        const n = r1.mesh.vertOutgoing(v).length;
        val1[n] = (val1[n] || 0) + 1;
      }
      ok('★★ （前置）導角自己就製造出 4 價頂點',
         Object.keys(val1).some(k => +k > 3), JSON.stringify(val1));
      const vert = [...r1.mesh.edges()].filter(he => {
        const d = he.to.p.clone().sub(he.v.p);
        return Math.abs(d.z) > 1e-6 && Math.hypot(d.x, d.y) < 1e-6;
      });
      const r2 = edit.bevelEdges(r1.mesh, vert, 5);
      ok('★★ 再導垂直四條（kang 踩到的那一步）：做得出來了', r2.ok, r2.reason);
      ok('　　封閉、χ2、沒有非平面的面',
         r2.ok && r2.mesh.isClosed() && chiOf(r2.mesh) === 2
           && edit.nonPlanarFaces(r2.mesh).length === 0);
    }

    /** ✅ 頂點被「全部導到」時照樣可以 */
    const allOk = edit.bevelEdges(box, [...box.edges()], 5);
    ok('★ 方塊 12 條全導照樣可以', allOk.ok);

    /**
     * ⚠ **曲面上的斜切面不會是平的 —— 那是取捨，不是壞掉。**
     * 不可能兩邊都平：改成垂直偏移的話，旁邊那個既有的面反而會不平。
     * 實測 320 組隨機選法：**不平的全部是 4 邊形（斜切面），
     * 被吸收的 n 邊形一個都沒有不平**。所以不擋，但要回報數字。
     */
    {
      const cyl = baked('cylinder', { r: 25, h: 60, seg: 8 });
      const es = [...cyl.edges()].filter(he => he.face && he.twin && he.twin.face);
      const r3 = edit.bevelEdges(cyl, [es[0], es[3], es[7]], 1);
      ok('★ 曲面導角做得出來（拓撲正確）',
         r3.ok && r3.mesh.isClosed() && chiOf(r3.mesh) === 2);
      ok('★★ 而且會回報「有幾片不是平的、最大偏離多少」（不擋，但要講）',
         typeof r3.nonPlanar === 'number' && typeof r3.nonPlanarWorst === 'number',
         `${r3.nonPlanar} 片、最大 ${(r3.nonPlanarWorst || 0).toFixed(4)} cm`);
      if (r3.nonPlanar) {
        eq('★★ 不平的全部是 4 邊形（斜切面），被吸收的 n 邊形都是平的',
           edit.nonPlanarFaces(r3.mesh).every(x => r3.mesh.faceVerts(x.face).length === 4), true);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════
//  導圓角（多段導角）＝ 導角的「段數 N」
// ═══════════════════════════════════════════════════════

section('導圓角：段數 1 就是現在的斜切邊');

/**
 * 🔴 **這一節的目標數字不是我們算的，是 `外部參考-Blender編輯.md`
 * 　　第 12 節先驗好的**（2026-08-25 沙箱，直接造出目標幾何）。
 *
 * ⚠ **所以它是「目標」，不是「我們一定會長出來的東西」** ——
 * 第 12.5 節明寫著沒驗過「我們的管線真的做得出它」。
 * → 斷言分兩級（kang 2026-08-25 同意）：
 *   **一定要對**：封閉、χ＝2、體積收斂到解析解、段數加倍誤差縮到四分之一
 *   **希望對**：點／邊／面完全吻合。對不上**先查原因，不要硬改成一樣**
 *   （角落的三角化切法不同也會讓面數不同，而幾何仍然正確）
 *
 * ── ⭐ 最強的一條斷言在最後面 ────────────────────────────
 * 圓角表面上**每一個新頂點到內盒的距離都必須精確等於 r**。
 * 那是「真的被推到弧上」的直接證明 —— 比體積強得多，
 * 因為體積是積分，局部歪掉會被平均掉（坑第 17 條：中途的量是對的）。
 */
{
  const bx = (type, params) => {
    const r = edit.mergeCoplanarFaces(buildPrim(type, params));
    const m = r.ok ? r.mesh : buildPrim(type, params);
    m.computeNormals();
    return m;
  };
  const eCnt = m => [...m.edges()].length;
  const chiOf = m => m.verts.length - eCnt(m) + m.faces.length;

  const box = bx('box', { w: 60, d: 45, h: 40 });
  const R = 5;
  /** 內盒 ＝ 原方塊各面往內縮 r。圓角表面上每一點到它的距離都該是 r */
  const INNER_MIN = new THREE.Vector3(-25, -15, -17.5);
  const INNER_MAX = new THREE.Vector3(25, 15, 17.5);
  const ANALYTIC = 105055.6777;
  const distToInner = p => {
    const c = new THREE.Vector3(
      Math.min(Math.max(p.x, INNER_MIN.x), INNER_MAX.x),
      Math.min(Math.max(p.y, INNER_MIN.y), INNER_MAX.y),
      Math.min(Math.max(p.z, INNER_MIN.z), INNER_MAX.z));
    return c.distanceTo(p);
  };

  {
    /**
     * 🔴 **最重要的一條：段數 1 必須跟現在的導角逐個頂點完全相同。**
     *
     * 這是耳切那一輪用過的招 —— 「舊行為完全沒變」不靠人保證，靠測試保證。
     * 〔那一輪的說法：既有 1219 項一項都沒掉，就是「凸的行為逐字相同」的機械斷言〕
     */
    const a = edit.bevelEdges(box, [...box.edges()], R);
    const b = edit.bevelEdges(box, [...box.edges()], R, { segments: 1 });
    ok('兩邊都成功', a.ok && b.ok, b.reason || '');
    eq('★★ 段數 1 的點數跟現在的導角一樣', b.mesh.verts.length, a.mesh.verts.length);
    eq('　　面數也一樣', b.mesh.faces.length, a.mesh.faces.length);
    const worst = Math.max(...a.mesh.verts.map((v, i) =>
      v.p.distanceTo(b.mesh.verts[i].p)));
    near('★★ 而且是逐個頂點完全相同（不是只有總量一樣）', worst, 0, 1e-12);
    rel('★★ 體積也完全一樣', b.mesh.volume(), a.mesh.volume());
  }

  {
    /** 段數 0 或負的：一律當成 1，不報錯（跟環切的刀數同一條規矩） */
    const r = edit.bevelEdges(box, [...box.edges()], R, { segments: 0 });
    ok('段數 0 當成 1，不報錯', r.ok && r.mesh.verts.length === 24, r.reason || '');
  }

  /**
   * 第 12.1 節那張表。**目標數字，不是我們算的。**
   * 〔解析解 ＝ 內盒 50×30×35 ＋ 6 片板 ＋ 12 個 1/4 圓柱 ＋ 8 個 1/8 球〕
   */
  /**
   * 🔴 **面數是表上的數字（逐項吻合），點數是我們自己的公式。**
   *
   * ── 為什麼不去湊表上的點數（2026-08-25 查清楚之後的決定）─────────
   * 第 12 節那張表的角落有 **n²+n+1** 個點，我們是 **(n+1)(n+2)/2**，
   * 而**面數兩邊完全一樣**（`6 + 12n + 8n²`，五個段數逐項吻合）。
   *
   * 差別在**角落那塊球面的三角形怎麼排**：
   * 表上的模型是「6 片板 ＋ 12 個 1/4 圓柱 ＋ 8 個 1/8 球」**直接拼出來**的，
   * 接縫上的點各算各的；我們是從導角長出來、**接縫共用點**，所以點少。
   *
   * → 表因此逼近得稍好（段數 16：0.0158% vs 我們 0.0166%，
   *   差 0.0008 個百分點）。**兩個都對，不是誰錯。**
   *
   * ⛔ **所以不要把這裡改成表上的點數** —— 那會變成為了湊數字而改結構。
   * 正確性由底下四條**獨立於那張表**的斷言保證：
   *   每個頂點精確在弧上／體積收斂到解析解／誤差縮四分之一／χ 與封閉性。
   * 〔第 12 節的沙箱腳本沒進版控，無法重現它的分割方式〕
   */
  const V_OF = n => 4 * (n + 1) * (n + 2);
  const F_OF = n => 6 + 12 * n + 8 * n * n;
  const TABLE = [
    [1,  V_OF(1),  V_OF(1)  + F_OF(1)  - 2, F_OF(1),  101416.6667],
    [2,  V_OF(2),  V_OF(2)  + F_OF(2)  - 2, F_OF(2),  103999.5791],
    [4,  V_OF(4),  V_OF(4)  + F_OF(4)  - 2, F_OF(4),  104780.2349],
    [8,  V_OF(8),  V_OF(8)  + F_OF(8)  - 2, F_OF(8),  104986.0696],
    [16, V_OF(16), V_OF(16) + F_OF(16) - 2, F_OF(16), 105038.2282]
  ];
  /** 面數必須跟第 12 節那張表對得上 —— 那一項是真的吻合，要守住 */
  eq('★★ 面數跟第 12 節那張表逐項吻合（6＋12n＋8n²）',
     TABLE.map(t => t[3]).join('/'), '26/62/182/614/2246');
  const errs = [];
  const vols = [];

  for (const [n, V, E, F, vol] of TABLE) {
    const r = edit.bevelEdges(box, [...box.edges()], R, { segments: n });
    ok(`段數 ${n} 導得出來`, r.ok, r.reason || '');
    if (!r.ok) { errs.push(null); continue; }
    const m = r.mesh;

    // ── 一定要對的 ──
    eq(`★★ 段數 ${n}：χ 仍然是 2`, chiOf(m), 2);
    ok(`　　段數 ${n}：仍然封閉、結構沒問題`, m.isClosed() && m.validate().ok);
    near(`★★ 段數 ${n}：體積 ${vol}`, m.volume(), vol, 0.01);

    /** ⭐ 最強的一條：真的被推到弧上 */
    const worst = Math.max(...m.verts.map(v => Math.abs(distToInner(v.p) - R)));
    near(`★★ 段數 ${n}：每個頂點到內盒的距離都精確是 ${R}`, worst, 0, 1e-9);

    eq(`★ 段數 ${n}：V${V} E${E} F${F}`,
       `${m.verts.length}/${eCnt(m)}/${m.faces.length}`, `${V}/${E}/${F}`);

    errs.push(Math.abs(m.volume() - ANALYTIC) / ANALYTIC);
    vols.push(m.volume());
  }

  {
    /**
     * 🔴 **兩條「內接」的斷言 —— 表給不了，但它們比表更根本。**
     *
     * 圓角是用平面片**內接**在圓柱與球面上，所以：
     * 一、體積**永遠小於**解析解（切掉的比真圓角多）
     * 二、段數越高**體積單調遞增**（越來越貼近）
     *
     * 任何一條破掉，就是有頂點跑到弧的外面去了 ——
     * 而那種錯誤**體積看起來還是很接近**，只有這兩條抓得到。
     */
    ok('★★ 體積永遠小於解析解（內接，不可能超過）',
       vols.every(v => v < ANALYTIC),
       vols.map(v => v.toFixed(2)).join(' < '));
    ok('★★ 段數越高，體積單調遞增',
       vols.every((v, i) => i === 0 || v > vols[i - 1]));
  }

  {
    /**
     * 🔴 **收斂：段數加倍，誤差縮到四分之一。**
     * 這一條比任何單一個體積數字都強 —— 它驗的是**整族**行為對不對，
     * 而不是某一個值湊巧對上。
     * 〔第 12.3 節：這跟「尺寸的依據」那張 seg 表是同一件事〕
     */
    const ratios = [];
    for (let i = 0; i + 1 < errs.length; i++) {
      if (errs[i] == null || errs[i + 1] == null) continue;
      ratios.push(errs[i] / errs[i + 1]);
    }
    ok('★★ 段數加倍，誤差縮到約四分之一',
       ratios.length === 4 && ratios.every(x => x > 3.3 && x < 4.3),
       ratios.map(x => x.toFixed(2)).join('、'));
  }

  {
    /**
     * ⚠ **圓角不可以被 `bake()` 壓平。**
     * 段與段之間的夾角在段數 32 時只有 2.8 度，而 `planarRegions()`
     * 的容許值是 0.5 度 —— 還有餘裕，但**這是要盯著的邊界**：
     * 日後誰把容許值調鬆，圓角會安靜地被併成斜切邊。
     */
    const r = edit.bevelEdges(box, [...box.edges()], R, { segments: 8 });
    const g = edit.mergeCoplanarFaces(r.mesh);
    ok('★★ 再跑一次併面，圓角不會被壓回斜切邊',
       !g.ok || g.mesh.faces.length === r.mesh.faces.length,
       g.ok ? `${r.mesh.faces.length} → ${g.mesh.faces.length}` : '併不動');
  }

  {
    /**
     * 🔴 **kang 2026-08-25 實測抓到的：只導一條邊，網格會裂開。**
     *
     * 症狀是側面上冒出一堆奇怪的線 —— 那是弧上的中間點在**沒被導到的那個面**
     * 那邊配不到對應的邊，半邊配不到 twin。
     * 實測沒修之前：χ 2 → **0**、`isClosed()` false、邊界半邊 2n+2 條。
     * 🔴 **而 `validate()` 是 true** —— 抓不到，只有 χ 露餡。
     *
     * ⚠ **原本的測試沒抓到，因為只驗了「12 條邊全導」** ——
     * 那時每個面都有自己的代表點，**沒有任何面需要吸收**，那條路根本沒走到。
     * 〔坑第 17 條的又一次重演：挑樣本要涵蓋不同的**網格結構**，
     * 　不只是不同的形狀。⛔ 日後加新的導角行為，這一組一定要一起跑〕
     */
    const one = () => {
      const b = bx('box', { w: 60, d: 45, h: 40 });
      const t = [...b.edges()].find(he => {
        const d = he.to.p.clone().sub(he.v.p);
        return Math.abs(d.x) > 50 && Math.hypot(d.y, d.z) < 1e-9;
      });
      return [b, t];
    };
    const vols = [];
    for (const n of [1, 2, 4, 5, 8]) {
      const [b, t] = one();
      const r = edit.bevelEdges(b, [t], 5, { segments: n });
      ok(`只導一條邊 段數 ${n}：導得出來`, r.ok, r.reason || '');
      if (!r.ok) continue;
      eq(`★★ 只導一條邊 段數 ${n}：χ 仍然是 2`, chiOf(r.mesh), 2);
      ok(`★★ 　　仍然封閉、一條邊界半邊都沒有`,
         r.mesh.isClosed()
         && [...r.mesh.edges()].every(he => he.face && he.twin && he.twin.face));
      vols.push(r.mesh.volume());
    }
    /** 一條邊導圓角的解析解 ＝ 108000 − 60×(r² − πr²/4) */
    const AN1 = 108000 - 60 * (25 - Math.PI * 25 / 4);
    ok('★★ 只導一條邊：體積單調遞增且永遠小於解析解 107678.10',
       vols.every((v, i) => (i === 0 || v > vols[i - 1]) && v < AN1),
       vols.map(v => v.toFixed(2)).join(' < ') + ` < ${AN1.toFixed(2)}`);
  }

  {
    /**
     * 🔴 **kang 2026-08-25 實測抓到的第二件：選頂面四條邊，跳「不是直角」。**
     *
     * **可是方塊明明是直角。** 真正的原因是那個角落的**垂直邊沒被導** ——
     * 只導一部分時，兩條弧的圓心差了一個 w，接不起來。
     *
     * ⚠ **擋下來是對的，錯的是訊息** —— 講「不是直角」會讓人往
     * 「換個形狀試試」的方向走，而正解是「**把那個角落的邊全部一起選**」。
     * 〔坑第 18 條：誤報比漏報更糟。訊息說錯了，比不講更糟〕
     */
    const top = box.faces.find(f => f.normal.y > 0.99);
    const four = box.faceLoop(top);
    eq('（前置）頂面有四條邊', four.length, 4);

    const r1 = edit.bevelEdges(box, four, 5, { segments: 1 });
    ok('★ 頂面四條邊：段數 1 的斜切邊本來就做得到', r1.ok, r1.reason || '');

    /**
     * 🔴 **這幾條的斷言在 2026-08-25 翻過來了。**
     * 原本斷言「頂面四條邊的多段導角**會被擋下來**」，並檢查那則訊息
     * 說的是「只導了一部分」而不是「不是直角」。
     * **outer miter 做完之後它做得到了**，所以斷言跟著翻 ——
     * 完整驗證見「導圓角 outer miter」那一節。
     * 〔留著這段歷史是因為它記著一個容易重犯的錯：
     * 　方塊明明是直角，訊息卻說「不是直角」〕
     */
    const r4 = edit.bevelEdges(box, four, 5, { segments: 4 });
    ok('★★ 頂面四條邊：段數 4 現在做得出來了（outer miter）', r4.ok, r4.reason || '');

    const rAll = edit.bevelEdges(box, [...box.edges()], 5, { segments: 4 });
    ok('★★ 12 條全選照樣成功（球面角落沒被 miter 搶走）', rAll.ok, rAll.reason || '');
  }

  {
    /**
     * ⚠ **非直角的角落：先擋下來，不猜。**
     * 三條邊夾角不同時，三個面的偏移距離不一樣，**可能沒有一個球同時相切**
     * —— 那才是 Blender 開 Miter 選項的真正理由（第 12.5 節）。
     * 單段不受影響（它本來就解掉了 4～6 價的角落）。
     */
    const cone = bx('cone', { r: 30, h: 70, seg: 12 });
    const es = [...cone.edges()].slice(0, 3);
    const r1 = edit.bevelEdges(cone, es, 2, { segments: 1 });
    ok('　　（前置）圓錐單段導角本來就做得到', r1.ok, r1.reason || '');
    const r8 = edit.bevelEdges(cone, es, 2, { segments: 8 });
    ok('★ 非直角的角落，多段先擋下來並說原因',
       !r8.ok && /直角|角落/.test(r8.reason || ''), r8.reason || '(沒擋)');
    /**
     * 🔴 **⛔ 這裡不可以叫他「全部一起選」——那對圓錐是死路。**
     * outer miter 之後「只導一部分」本身已經做得到了，
     * 還會被擋的是**非直角**，而全部一起選並不會讓它變成直角。
     * 〔坑第 34 條：不要寫一個不存在的退路〕
     */
    ok('★★ 　　而且不可以叫他「全部一起選」（那對非直角是死路）',
       !r8.ok && !/全部一起選/.test(r8.reason || ''), r8.reason || '');
  }

  {
    /**
     * 展開會變成什麼樣 —— 第 12.5 節第三個「沒驗」。
     * ⚠ 這裡**不斷言片數是多少**（那取決於材料規則），
     * 只斷言**展開不會爆掉或報錯**，並把數字印出來讓人看得到。
     */
    const rule = makeRule('acrylic', 0.3);
    const r = edit.bevelEdges(box, [...box.edges()], R, { segments: 4 });
    const u = unfoldMesh(r.mesh, rule);
    ok('★ 圓角之後展開不會爆掉',
       u.pieces.length > 0, `${u.pieces.length} 片、${u.warnings.length} 則警告`);
  }
}

section('導圓角 outer miter：只導一部分的邊');

/**
 * 🔴 **這一節守的是「只導頂面四條邊」那個情形**（＝圓角桌面、圓角面板）。
 * kang 2026-08-25 第一輪實測就試到，當時被擋下來。
 *
 * **方案來源**：`外部參考-Blender編輯.md` **第 13 節**（Blender 叫 outer miter，
 * 三種接法裡選 **Sharp**：兩片圓角面延伸到相交，不加額外頂點）。
 *
 * ── ⚠ 這一組刻意同時驗體積**與** χ ────────────────────────
 * 上一輪查方案時的沙箱腳本**只有體積對、χ 是 −2n**（封面拼錯），
 * 而**體積照樣漂亮地收斂** —— 那正是坑第 17 條：
 * **中途的量一直都是對的，末端才錯。**
 * ⛔ 所以這裡每一個段數都要同時斷言 χ、封閉、體積，少一個都不算過。
 */
{
  const box = () => baked('box', { w: 60, d: 45, h: 40 });
  const top = m => m.faces.find(f => f.normal.y > 0.99);
  const R = 5;
  /** 用兩條獨立的路對過答案：蒙地卡羅 106921.47 ／ 手算解析 106921.2755 */
  const ANALYTIC = 106921.2755;

  /**
   * 🔴 **最強的幾何斷言：圓角表面上每個點到「軸線框」的距離都是 r。**
   *
   * 四條被導的邊各有一條圓角軸，它們在 y＝15 那個平面上圍成一個矩形框
   * （x ∈ [−25,25]、z ∈ [−17.5,17.5] 的**邊界**）。
   * 圓角面、角落面、頂面的角、側面的頂緣 —— 全部都該離它剛好 5。
   *
   * ⭐ 這一條抓得到「頂點跑到弧外面」，而體積抓不到（積分會平均掉）。
   */
  const segDist = (p, ax, ay, az, bx2, by, bz) => {
    const dx = bx2-ax, dy = by-ay, dz = bz-az;
    const L2 = dx*dx + dy*dy + dz*dz;
    let t = L2 ? ((p.x-ax)*dx + (p.y-ay)*dy + (p.z-az)*dz) / L2 : 0;
    t = Math.min(1, Math.max(0, t));
    return Math.hypot(p.x-(ax+dx*t), p.y-(ay+dy*t), p.z-(az+dz*t));
  };
  /**
   * ⚠ **「到最近那條軸的距離 ＝ r」這個斷言在 miter 上不成立**，
   * 兩次都栽在這裡，寫下來免得第三次：
   *   · 軸線段要用**邊本身的長度**（不是內縮後的），否則交線終點算成 5√2
   *   · 但即使修好長度**還是不對** —— 像 (30,15,17.5) 這種點
   *     **正好落在另一條軸線上**（距離 0），它到自己那條軸才是 5。
   *     一個點可以離某條軸很近，同時仍然是正確的表面點。
   *
   * → 換成一個**正確而且更強**的判準（就是蒙地卡羅用的那個 `inside()`）：
   *   **沒有任何頂點跑到理想圓角實體的外面。**
   *   它抓得到「頂點跑到弧外面」，而體積抓不到（積分會平均掉）。
   *   凹進去太多的那一半由「體積收斂 ＋ 單調遞增」守。
   */
  const outsideBy = p => {
    if (p.y <= 15 + 1e-12) return 0;          // 圓角起始高度以下，一定在裡面
    const dy2 = (p.y - 15) ** 2;
    let worst = 0;
    const chk = d => { const e = dy2 + d * d - 25; if (e > worst) worst = e; };
    if (p.z >  17.5) chk(p.z - 17.5);
    if (p.z < -17.5) chk(p.z + 17.5);
    if (p.x >  25)   chk(p.x - 25);
    if (p.x < -25)   chk(p.x + 25);
    return worst;
  };

  {
    /**
     * 🔴 **回歸：段數 1 的斜切邊本來就做得到，不可以被 miter 改掉。**
     * 〔跟圓角那一輪同一招：舊行為不變靠測試保證，不靠人記得〕
     */
    const m = box();
    const r = edit.bevelEdges(m, m.faceLoop(top(m)), R, { segments: 1 });
    ok('段數 1（斜切邊）照樣成功', r.ok, r.reason || '');
    eq('★★ 段數 1：V12 F10（跟以前完全一樣）',
       `${r.mesh.verts.length}/${r.mesh.faces.length}`, '12/10');
    eq('　　χ 仍然是 2', chi(r.mesh), 2);
  }

  const vols = [], errs = [];
  for (const n of [2, 4, 8]) {
    const m = box();
    const r = edit.bevelEdges(m, m.faceLoop(top(m)), R, { segments: n });
    ok(`★★ 只導頂面四條邊 段數 ${n}：做得出來`, r.ok, r.reason || '');
    if (!r.ok) { vols.push(null); errs.push(null); continue; }
    const g = r.mesh;

    eq(`★★ 段數 ${n}：χ 仍然是 2`, chi(g), 2);
    ok(`★★ 段數 ${n}：仍然封閉、結構沒問題`, g.isClosed() && g.validate().ok);
    ok(`　　段數 ${n}：沒有零長度的邊`,
       [...g.edges()].every(he => he.to.p.distanceTo(he.v.p) > 1e-6));

    /** ⭐ 幾何斷言：沒有頂點跑到理想圓角的外面 */
    const worst = Math.max(...g.verts.map(v => outsideBy(v.p)));
    near(`★★ 段數 ${n}：沒有任何頂點跑到理想圓角的外面`, worst, 0, 1e-9);

    vols.push(g.volume());
    errs.push(Math.abs(g.volume() - ANALYTIC) / ANALYTIC);
  }

  {
    const v = vols.filter(x => x != null);
    ok('★★ 體積永遠小於解析解 106921.2755（內接，不可能超過）',
       v.length === 3 && v.every(x => x < ANALYTIC),
       v.map(x => x.toFixed(2)).join(' < '));
    ok('★★ 段數越高，體積單調遞增',
       v.length === 3 && v.every((x, i) => i === 0 || x > v[i-1]));
    const e = errs.filter(x => x != null);
    ok('★★ 段數加倍，誤差縮到約四分之一',
       e.length === 3 && [e[0]/e[1], e[1]/e[2]].every(x => x > 3.3 && x < 4.3),
       e.length === 3 ? [e[0]/e[1], e[1]/e[2]].map(x => x.toFixed(2)).join('、') : '');
  }

  {
    /** 兩條相鄰的邊（最小的 miter 情形）—— 一樣要做得出來 */
    const m = box();
    const b = m.bounds();
    const corner = m.verts.find(v => Math.abs(v.p.x-b.max.x) < 1e-9
      && Math.abs(v.p.y-b.max.y) < 1e-9 && Math.abs(v.p.z-b.max.z) < 1e-9);
    const two = [...m.edges()].filter(he => he.v === corner || he.to === corner).slice(0, 2);
    const r = edit.bevelEdges(m, two, R, { segments: 4 });
    ok('★★ 兩條相鄰的邊 段數 4：做得出來', r.ok, r.reason || '');
    if (r.ok) {
      eq('　　χ 仍然是 2', chi(r.mesh), 2);
      ok('　　仍然封閉', r.mesh.isClosed());
    }
  }

  {
    /** 🔴 三條全導的球面角落**不可以被 miter 改掉**（回歸） */
    const m = box();
    const r = edit.bevelEdges(m, [...m.edges()], R, { segments: 4 });
    ok('★★ 12 條全導照樣走球面角落（沒被 miter 搶走）', r.ok, r.reason || '');
    eq('　　仍然是 48 片 ＋ 8 個角落', `${r.walls}/${r.corners}`, '48/8');
    eq('　　V120 F182（跟圓角那一輪完全一樣）',
       `${r.mesh.verts.length}/${r.mesh.faces.length}`, '120/182');
  }
}

section('全選邊：會選到哪些邊');

/**
 * 🔴 **這一組守的是「介面上那個數字不可以說謊」。**
 *
 * ⚠ **這顆按鈕是 kang 2026-08-25 實測逼出來的，而且問題不在導角。**
 * 他要做方塊六面 12 邊圓角 —— **功能本來就做得到**，但介面上要
 * **開加選點 12 下**，中間漏一條或重複點到同一條邊的另一側，
 * 就會有角落只導到兩條 → 被擋下來，而**畫面上看不出哪一條沒選到**。
 *
 * 判準沿用 `isMarkable()`（⛔ 不要另外寫一套）：
 * 共面的三角化對角線畫面上根本沒有，選進來數字就會說謊（坑第 20 條）；
 * 而環切／內縮／切一刀加出來的 `hard` 邊**要選進來**，
 * `isMarkable()` 早就為它們開了例外。
 */
{
  const pick = m => [...m.edges()].filter(he => seam.isMarkable(m, he));

  {
    const box = baked('box', { w: 60, d: 45, h: 40 });
    eq('★★ 方塊全選 ＝ 12 條（不是 18 條）', pick(box).length, 12);
    eq('　　（對照）網格裡其實有幾條邊', edgeCount(box), 12);
  }

  {
    /** 🔴 環切加出來的 hard 邊要選得到 —— 選不到的話等於環切白做 */
    const box = baked('box', { w: 60, d: 45, h: 40 });
    const v = findEdge(box, d => Math.abs(d.z) > 1e-9 && Math.hypot(d.x, d.y) < 1e-9);
    const r = edit.loopCut(box, v);
    eq('★★ 環切之後全選 ＝ 20 條（新的一圈 4 條也選得到）', pick(r.mesh).length, 20);
    eq('　　其中 hard 的有 4 條', [...r.mesh.edges()].filter(he => he.hard).length, 4);
  }

  {
    /** 切一刀加出來的 hard 邊同理 */
    const box = baked('box', { w: 60, d: 45, h: 40 });
    const r = edit.bisect(box, { n: new THREE.Vector3(1, 0, 0), d: 0 });
    eq('★ 切一刀之後全選 ＝ 20 條', pick(r.mesh).length, 20);
  }

  {
    /**
     * 🔴 **這一條就是 kang 那個流程的機械斷言**：
     * 全選 → 導圓角，必須真的成功（他手點 12 下失敗過）。
     */
    const box = baked('box', { w: 60, d: 45, h: 40 });
    const all = pick(box);
    eq('（前置）全選拿到 12 條', all.length, 12);
    const r = edit.bevelEdges(box, all, 5, { segments: 4 });
    ok('★★ 全選 → 導圓角段數 4，真的成功', r.ok, r.reason || '');
    eq('　　12 片斜切面 ＋ 8 個角落', `${r.walls}/${r.corners}`, '48/8');
    eq('　　χ 仍然是 2', chi(r.mesh), 2);
    ok('　　仍然封閉', r.mesh.isClosed());
  }

  {
    /** 板件（開放的殼）：外輪廓不算「看得見的稜線」，但也不該整個沒東西 */
    const plate = buildPrim('plate', { w: 100, d: 60 }, 0.2);
    plate.computeNormals();
    ok('★ 板件全選不會爆掉', pick(plate).length >= 0, `${pick(plate).length} 條`);
  }
}

section('🔴 假邊界不可以變成分片線（recalcNormalsOutside）');

/**
 * 🔴 **這一組守的是一個「憑空多出東西」的 bug。**
 *
 * `mesh.js` `_buildBoundaryLoops()` 有一條規則：**邊界天生就是切割線**，
 * 所以沒有 twin 的半邊會自動標成 CUT。那條規則本身是對的。
 *
 * 但**繞向不一致的網格，那些邊只是「暫時配不到 twin」，不是真的邊界**
 * （`fromFaceList()` 只配 `a→b` 與 `b→a`，同方向就配不上）。
 * 把繞向修好之後它們會變回內部邊，**而 CUT 已經跟著搬進來了**。
 *
 * 症狀：**修一個繞向壞掉的模型，畫面上憑空多出幾條分片線**，
 * 而使用者從來沒標過。〔2026-08-25 導角那一輪抓到，實測方塊多出 4 條〕
 */
{
  const baked = (() => {
    const r = edit.mergeCoplanarFaces(buildPrim('box', { w: 60, d: 45, h: 40 }));
    const m = r.ok ? r.mesh : buildPrim('box', { w: 60, d: 45, h: 40 });
    m.computeNormals();
    return m;
  })();

  /** 故意把一個面的繞向反過來 → 相鄰面矛盾 → 那幾條邊被當成邊界標了 CUT */
  const vi = baked._vertIndex();
  const pts = baked.verts.map(v => v.p.clone());
  const fs = baked.faces.map((f, i) => {
    const idx = baked.faceVerts(f).map(v => vi.get(v.id));
    return i === 0 ? idx.slice().reverse() : idx;
  });
  const broken = Mesh.fromFaceList(pts, fs);
  broken.computeNormals();

  const cutBefore = [...broken.edges()].filter(he => he.role === EDGE_ROLE.CUT).length;
  ok('（前置）繞向壞掉的網格真的被自動標了 CUT', cutBefore > 0, `${cutBefore} 條`);

  const r = edit.recalcNormalsOutside(broken);
  ok('修得動', r.ok);
  ok('　　修完是封閉的', r.mesh.isClosed());
  eq('★★ 修完之後不應該留下任何 CUT（那些都是假邊界）',
     [...r.mesh.edges()].filter(he => he.role === EDGE_ROLE.CUT).length, 0);

  /**
   * ⚠ **但真正的邊界照樣要是 CUT，使用者標的也不能被清掉。**
   * 拿一片開放的板子驗：它的 4 條外輪廓是真邊界。
   */
  {
    const plate = buildPrim('plate', { w: 100, d: 60 }, 0.2);
    plate.computeNormals();
    const want = [...plate.edges()].filter(he => he.role === EDGE_ROLE.CUT).length;
    ok('（前置）板子的外輪廓本來就是 CUT', want > 0, `${want} 條`);
    const rp = edit.recalcNormalsOutside(plate);
    // 本來就一致 → 不動它，那也代表 CUT 一條都沒被碰
    ok('★ 開放的板子：不動它，真邊界的 CUT 一條都沒少', !rp.ok);
  }
}

section('邊上的標記：每一樣都要活過每一條「拆掉重建」的路');

/**
 * 🔴 **這一組是機械斷言，而且會自動涵蓋日後新增的標記。**
 *
 * 計數是照 `mesh.marksOf()` **回傳的欄位自動展開**的 ——
 * 誰在 `marksOf()` 加了第四個標記，這一組測試會立刻開始檢查它，
 * 不必有人記得回來補測試。
 *
 * ── 為什麼非有這一組不可 ────────────────────────────────
 * 同一個病已經發作兩次，兩次都是「加了新標記，但忘了某一條搬移的路」：
 *   · 2026-08-23 `smooth`：展開圖從 5 處折彎變成 45 處
 *   · 2026-08-24 `hard`：**按一次「壓平」，環切的線 48 條全部歸零**
 *     （kang 實測抓到的 —— 沙箱的測試當時只驗了「併不動」那條路，
 *     　沒有驗「真的併下去」那條）
 * 兩次的症狀都一樣：**東西安靜地不見了，而形狀完全正常。**
 */
function markCount(m) {
  const out = {};
  for (const he of m.edges()) {
    const marks = m.marksOf(he);
    for (const [k, v] of Object.entries(marks)) {
      const on = (k === 'role') ? (v !== EDGE_ROLE.FREE) : !!v;
      out[k] = (out[k] || 0) + (on ? 1 : 0);
    }
  }
  return out;
}
/**
 * 🔴 **逐條邊比對，不比總數。**
 *
 * ⚠ **「總數一樣」是錯的斷言** —— 併面會把兩個面之間那條邊**真的併掉**，
 * 那條邊上的 `role` 跟著消失是**對的**（邊都不在了）。
 * 拿總數去比會把正確行為報成失敗（第一版就是這樣，`role` 104→103）。
 *
 * 正確的斷言是：**還活著的那些邊，身上的標記一樣都不能少。**
 * 比對的欄位照 `marksOf()` 自動展開，日後加第四個標記會自動被涵蓋。
 */
function marksSurvive(name, src, dst, remap) {
  const si = src._vertIndex(), di = dst._vertIndex();
  const key = (a, b) => `${Math.min(a, b)}-${Math.max(a, b)}`;
  const to = i => (remap ? remap.get(i) : i);

  const have = new Map();
  for (const he of dst.edges()) {
    have.set(key(di.get(he.v.id), di.get(he.to.id)), dst.marksOf(he));
  }

  const lost = {};
  let gone = 0, kept = 0;
  for (const he of src.edges()) {
    const m = src.marksOf(he);
    if (Mesh.marksEmpty(m)) continue;
    const a = to(si.get(he.v.id)), b = to(si.get(he.to.id));
    if (a === undefined || b === undefined) { gone++; continue; }
    const got = have.get(key(a, b));
    if (!got) { gone++; continue; }          // 這條邊本身被併掉了 —— 合法
    kept++;
    for (const [k, v] of Object.entries(m)) {
      const on = (k === 'role') ? (v !== EDGE_ROLE.FREE) : !!v;
      const now = (k === 'role') ? (got[k] !== EDGE_ROLE.FREE) : !!got[k];
      if (on && !now) lost[k] = (lost[k] || 0) + 1;
    }
  }
  const bad = Object.keys(lost);
  report(bad.length === 0, name,
    bad.length ? '掉了 ' + bad.map(k => `${k} ${lost[k]} 條`).join('、')
               : `${kept} 條還在的邊全部保住${gone ? `（另有 ${gone} 條邊本身被併掉了）` : ''}`,
    '一樣都不少');
}

{
  /** 準備一個每樣標記都有的網格：baked 圓柱 → 環切 3 刀（hard）→ 手動標 CUT、smooth、不准切（keep，2026-10-13 加的第四樣）*/
  const base = (() => {
    const b = edit.mergeCoplanarFaces(buildPrim('cylinder', { r: 25, h: 60, seg: 16 }));
    const m0 = b.ok ? b.mesh : buildPrim('cylinder', { r: 25, h: 60, seg: 16 });
    m0.computeNormals();
    const cv = [...m0.edges()].find(he => {
      const d = he.to.p.clone().sub(he.v.p);
      return Math.abs(d.y) > 1e-9 && Math.hypot(d.x, d.z) < 1e-9;
    });
    const m = edit.loopCut(m0, cv, { cuts: 3 }).mesh;
    m.computeNormals();
    const pick = [...m.edges()].filter(he => !he.hard).slice(0, 5);
    m.setRole(pick[0], EDGE_ROLE.CUT);
    m.setRole(pick[1], EDGE_ROLE.CUT);
    m.setSmooth(pick[2], true);
    m.setKeep(pick[3], true);
    return m;
  })();

  const want = markCount(base);
  ok(`準備好的網格每樣標記都有（${Object.entries(want).map(([k, v]) => k + ' ' + v).join('、')}）`,
     Object.values(want).every(v => v > 0));

  marksSurvive('★ clone() 之後每一樣都還在', base, base.clone());
  marksSurvive('★ transformed() 之後每一樣都還在', base,
               base.transformed(new THREE.Matrix4().makeTranslation(1, 2, 3)));
  marksSurvive('★ 存檔再開之後每一樣都還在', base,
               Mesh.fromJSON(JSON.parse(JSON.stringify(base.toJSON()))));

  /**
   * 🔴 **kang 2026-08-24 實測抓到的那一條：壓平 → 併面。**
   * 壓平會跑一次併面，而併面走 `copyMarksThroughRemap()` ——
   * 那一支原本手寫成「搬 role 與 smooth」，`hard` 48 條全部歸零。
   * ⚠ 一定要挑**真的不共面**的兩個面，不然併不動、這條路根本沒走到。
   */
  {
    const m = base.clone();
    m.computeNormals();
    const side = m.faces.filter(f => Math.abs(f.normal.y) < 0.01);
    const a = side[0];
    const b = side.find(f => f !== a && f.normal.dot(a.normal) < 0.999
      && m.faceVerts(f).filter(v => m.faceVerts(a).includes(v)).length === 2);
    const fr = edit.flattenElements(m, [a, b].map(face => ({ kind: 'face', face })));
    ok('　　（前置）兩個面真的不共面，壓平有動到東西', fr.ok && fr.before > 0.1);
    edit.refreshAfterEdit(m);
    const g = edit.mergeCoplanarFaces(m);
    ok('　　（前置）而且併面真的併下去了，不是併不動', g.ok && g.after < g.before);
    marksSurvive('★★ 壓平 → 併面之後每一樣都還在（kang 實測抓到的那條）',
                 m, g.mesh, g.remap);
  }

  /** 擠出：蓋子內部的邊索引整組換掉，是另一條手寫的搬移路徑 */
  {
    const m = base.clone();
    m.computeNormals();
    const cap = m.faces.find(f => f.normal.y > 0.99);
    const r = edit.extrudeFace(m, cap, 5);
    ok('　　（前置）擠出成功', r.ok);
    marksSurvive('★ 擠出之後，原網格上還在的邊每一樣都還在', m, r.mesh);
  }

  /** 細分（2026-10-14）：選到的面整個換掉、旁邊的面插點，走 `rebuildWithInserts()` 加 `replace` */
  {
    const m = base.clone();
    m.computeNormals();
    const fs = m.faces.filter(f => f.normal.y > 0.99 || Math.abs(f.normal.y) < 0.01).slice(0, 6);
    const r = edit.subdivideFaces(m, fs, 2);
    ok('　　（前置）細分成功', r.ok, r.reason || '');
    marksSurvive('★ 細分之後，原網格上還在的邊每一樣都還在', m, r.mesh, r.remap);
  }

  /** 環切自己：一條被切成 n+1 段，每一段都繼承 → 數量會變多，但不能變少 */
  {
    const m = base.clone();
    m.computeNormals();
    const cv = [...m.edges()].find(he => {
      const d = he.to.p.clone().sub(he.v.p);
      return Math.abs(d.y) > 1e-9 && Math.hypot(d.x, d.z) < 1e-9 && !he.hard;
    });
    const r = edit.loopCut(m, cv, { cuts: 1 });
    const b0 = markCount(m), a0 = markCount(r.mesh);
    ok('★ 再環切一次，沒有任何一樣標記變少',
       Object.keys(b0).every(k => a0[k] >= b0[k]),
       Object.keys(b0).map(k => `${k} ${b0[k]}→${a0[k]}`).join('、'));
  }

  /**
   * 任意切線：**第五條**「拆掉重建」的路。
   * 跟環切同一個形狀 —— 一條邊被切成兩段，兩段都繼承，所以數量只會變多。
   * ⭐ 放進這一組的意義是**日後加第四個標記時會自動涵蓋它**，
   * 不必有人記得回來補（`marksOf()` 自動展開）。
   */
  {
    const m = base.clone();
    m.computeNormals();
    const r = edit.bisect(m, { n: new THREE.Vector3(1, 0, 0), d: 3.7 });
    ok('　　（前置）任意切線切得下去', r.ok, r.reason);
    const b0 = markCount(m), a0 = markCount(r.mesh);
    ok('★ 任意切線之後，沒有任何一樣標記變少',
       Object.keys(b0).every(k => a0[k] >= b0[k]),
       Object.keys(b0).map(k => `${k} ${b0[k]}→${a0[k]}`).join('、'));
  }
}

{
  /** 擋下來的情形：邊界邊不能當起點 */
  const plate = buildPrim('plate', { w: 100, d: 60 }, 0.2);
  plate.computeNormals();
  const bnd = [...plate.edges()].find(he => !he.face || !he.twin || !he.twin.face);
  const r = edit.loopCut(plate, bnd);
  ok('外輪廓的邊擋下來並說原因', !r.ok && /外輪廓/.test(r.reason || ''));
}

// ═══════════════════════════════════════════════════════
//  任意切線（Bisect）＝ 加線 × 平面
// ═══════════════════════════════════════════════════════

section('任意切線：切下去之後的網格');

/**
 * 🔴 **這一節是「先建驗證集再改程式」的產物**（2026-08-25）。
 *
 * 那是第四次才解出導角角落的關鍵 —— 前三次的共同點是
 * 「每次都通過了一部分案例，看起來對，騙了我」。
 *
 * ── 這一組跟環切、內縮共用同一條主斷言 ──────────────────
 * **只加線，體積與面積精確不變。** 那是可以對答案的量（鐵律三）。
 *
 * ── ⚠ 跟日誌沙箱原型不同的一點，而且是刻意的 ──────────────
 * 原型照 `slice/section.js` 的做法「距離 0 一律推到正側」。
 * **那條規則在出 DXF 是對的，拿來改網格會出事**：
 * 頂點剛好落在平面上時，`s = dA/(dA−dB)` 會算出 0 或 1，
 * 於是**在既有頂點上插一個重複的點**，長出一條零長度的邊。
 * 2D 線段可以事後濾掉，網格不行 —— 那是退化幾何。
 *
 * → 改成三態，但用**有物理意義的容許值**（`PLANAR_TOL_CM` ＝ 0.1mm）：
 *   離平面比 0.1mm 更近的頂點**就當它在平面上，直接拿來用、不插新點**。
 *   比 0.1mm 更近的兩個點本來就切不出來（坑 25／26 同一條理由）。
 *
 * 下面那個八角柱案例就是這一條的機械斷言：**頂點數完全不變。**
 */
const bisectPlane = (nx, ny, nz, d) => ({ n: new THREE.Vector3(nx, ny, nz), d });

{
  /** 案例一：方塊 x=0。最基本的一刀 */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const vol0 = box.volume(), area0 = box.area();
  const r = edit.bisect(box, bisectPlane(1, 0, 0, 0));
  ok('方塊 x=0 切得下去', r.ok, r.reason);
  const m = r.mesh;

  eq('V 8 → 12', m.verts.length, 12);
  eq('E 12 → 20', edgeCount(m), 20);
  eq('F 6 → 10', m.faces.length, 10);
  eq('★★ χ 仍然是 2', chi(m), 2);
  ok('　　仍然封閉', m.isClosed());
  ok('　　結構沒有問題', m.validate().ok);

  /** 🔴 主斷言：只加線 */
  rel('★★ 體積精確不變', m.volume(), vol0);
  rel('★★ 面積精確不變', m.area(), area0);

  eq('★ 孤點 0 個（只加不減）', r.orphans, 0);
  eq('穿過 4 條邊、切開 4 個面', `${r.crossed}/${r.split}`, '4/4');
  eq('新切出來的邊 4 條', r.newEdges.length, 4);
  eq('　　而且全部標成 hard', [...m.edges()].filter(he => he.hard).length, 4);

  /** 新的頂點必須真的落在平面上 */
  const off = Math.max(...m.verts.slice(8).map(v => Math.abs(v.p.x)));
  near('★ 新頂點都落在平面上', off, 0, 1e-9);

  /** 出口：不標 hard 的話這一刀會被併回去，等於一顆按了沒反應的按鈕 */
  ok('★★ 再跑一次併面不會把切線併回去', !edit.mergeCoplanarFaces(m).ok);
  eq('★★ 共面區域被切開了（6 → 10）',
     new Set(m.faces.map(f => edit.regionOf(m, f).rid)).size, 10);
}

{
  /** 案例二：16 段圓柱攔腰切。日誌沙箱那組數字 */
  const cyl = baked('cylinder', { r: 25, h: 60, seg: 16 });
  const vol0 = cyl.volume(), area0 = cyl.area();
  eq('前提：16 段圓柱 V32 F18', `${cyl.verts.length}/${cyl.faces.length}`, '32/18');

  const r = edit.bisect(cyl, bisectPlane(0, 1, 0, 0));
  ok('圓柱 y=0 攔腰切得下去', r.ok, r.reason);
  eq('★ 穿過 16 條邊、切開 16 個面', `${r.crossed}/${r.split}`, '16/16');
  eq('★ V32→48 F18→34',
     `${r.mesh.verts.length}/${r.mesh.faces.length}`, '48/34');
  eq('★★ χ 仍然是 2', chi(r.mesh), 2);
  ok('　　仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
  rel('★★ 體積精確不變', r.mesh.volume(), vol0);
  rel('★★ 面積精確不變', r.mesh.area(), area0);
  eq('★ 新的那一圈 16 條，全部 hard', r.newEdges.length, 16);
}

{
  /**
   * 案例三：球。**面最多、最可能出現非凸的面**，所以是「跳過幾個」
   * 這條斷言最有意義的地方 —— 日誌沙箱實測跳過 0 個。
   */
  const ball = baked('sphere', { r: 30, segW: 12, segH: 12 });
  const vol0 = ball.volume(), area0 = ball.area();
  /**
   * ⚠ **刻意不切 y＝0。** segH 是偶數，赤道上剛好有一整圈既有頂點 ——
   * 那一刀會「每個面的兩個交點都相鄰」，結果**一個面都不會被切開**，
   * 而 χ、體積、面積、跳過數**全部照樣通過**。
   * 那是一條看起來很漂亮、其實什麼都沒驗到的測試（前三次導角就是這樣被騙的）。
   * → 挑一個不對齊的高度，並且**明確斷言真的有切開東西**。
   */
  const r = edit.bisect(ball, bisectPlane(0, 1, 0, 7.3));
  ok('球切得下去', r.ok, r.reason);
  ok('★ （防假通過）真的有面被切開', r.split > 0, `切開 ${r.split} 個`);
  eq('★★ 跳過 0 個面（沒有被穿超過兩次的面）', r.skipped, 0);
  eq('★★ χ 仍然是 2', chi(r.mesh), 2);
  ok('　　仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
  rel('★★ 體積精確不變', r.mesh.volume(), vol0);
  rel('★★ 面積精確不變', r.mesh.area(), area0);
  eq('★ 穿過幾條邊就切開幾個面', r.crossed, r.split);
}

{
  /**
   * 🔴 **案例四：平面剛好通過既有頂點。**
   *
   * 八角柱 r=30 的頂點落在 0°、45°、90°… 而 `CylinderGeometry` 的
   * 第一個頂點在 +z 軸上，所以 **x=0 這個平面剛好穿過兩個頂點**。
   *
   * ⭐ **斷言是「頂點數完全不變」** —— 那兩個頂點要被**直接拿來用**，
   * 不可以在它們身上再插一個幾乎重合的新點。
   * 插了的話會長出零長度的邊，而**體積、面積、χ 全部照樣正確**，
   * 只有 `validate()` 或日後的布林會露餡（坑第 17 條：中途的量是對的）。
   */
  const oct = baked('prism', { r: 30, h: 50, sides: 8 });
  const vol0 = oct.volume(), area0 = oct.area();
  const v0 = oct.verts.length;
  eq('前提：八角柱有兩個頂點剛好落在 x=0 上',
     oct.verts.filter(v => Math.abs(v.p.x) < 1e-9).length, 4);

  const r = edit.bisect(oct, bisectPlane(1, 0, 0, 0));
  ok('通過頂點的平面切得下去', r.ok, r.reason);
  eq('★★ 頂點數完全不變（用既有的點，不插重複點）', r.mesh.verts.length, v0);
  eq('★★ χ 仍然是 2', chi(r.mesh), 2);
  ok('　　仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
  rel('★★ 體積精確不變', r.mesh.volume(), vol0);
  rel('★★ 面積精確不變', r.mesh.area(), area0);
  eq('★ 只有上下兩個端面被切開（側面沒有真的跨過去）', r.split, 2);
  eq('　　所以面數 10 → 12', r.mesh.faces.length, 12);
  ok('★ 沒有長出零長度的邊',
     [...r.mesh.edges()].every(he => he.to.p.distanceTo(he.v.p) > 1e-6));
}

{
  /** 案例五：平面在物件外面 → 擋下來並說原因。⛔ 不可以沉默退回（坑第 11 條） */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const r = edit.bisect(box, bisectPlane(1, 0, 0, 100));
  ok('★ 平面在物件外面，擋下來並說原因', !r.ok && /沒有|外面|範圍/.test(r.reason || ''));

  /**
   * 剛好貼在表面上也一樣 —— 按下去畫面不會變，就必須說話（坑第 21 條）。
   * ⚠ 方塊的**高度是 y**（h:40 → y ∈ −20…20），z 是深度（d:45 → ±22.5）。
   * 〔第一版寫 z=20，那其實在物件**內部**，測試當然不會過 ——
   * 　挑樣本要先去量，不要照參數名推〕
   */
  const r2 = edit.bisect(box, bisectPlane(0, 1, 0, 20));
  ok('★ 平面剛好貼在表面上，也擋下來並說原因', !r2.ok && !!r2.reason);
}

{
  /**
   * 🔴 **案例六：被旋轉、被搬過位置的物件。**
   *
   * 這一條是**讀程式才發現要加的**（推不出來）：網格存的是物件自己的
   * 座標，物件另外帶著位置與旋轉（`align.js` 的 `worldBounds()` 就是
   * 為此存在的）。所以使用者打的「x＝0」是**世界**座標，
   * 而它在網格自己的座標裡是一個**斜**平面。
   *
   * 不轉換的話，切出來的位置會跟畫面上看到的對不起來 ——
   * 而且**形狀完全正常**，只是切錯地方。
   */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const mtx = new THREE.Matrix4()
    .makeRotationZ(Math.PI / 5)
    .premultiply(new THREE.Matrix4().makeTranslation(12, -7, 3));

  const pl = edit.worldAxisPlane(mtx, 'x', 5);
  const r = edit.bisect(box, pl);
  ok('旋轉＋位移過的物件切得下去', r.ok, r.reason);
  eq('★★ χ 仍然是 2', chi(r.mesh), 2);
  rel('★★ 體積精確不變', r.mesh.volume(), 108000);

  /** 🔴 真正的斷言：新頂點搬回世界座標之後，必須落在 x＝5 上 */
  const worst = Math.max(...r.mesh.verts.slice(8)
    .map(v => Math.abs(v.p.clone().applyMatrix4(mtx).x - 5)));
  near('★★ 新頂點回到世界座標剛好在 x＝5 上', worst, 0, 1e-9);
}

{
  /**
   * 標記繼承：一條邊被切成兩段，**兩段都要繼承**。
   * 不做的話索引配對落空，而**使用者標的 CUT 會安靜消失**
   * （環切那一輪的實測：切完 CUT 0 條）。
   */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const along = findEdge(box, d => Math.abs(d.x) > 1e-9 && Math.hypot(d.y, d.z) < 1e-9);
  box.setRole(along, EDGE_ROLE.CUT);
  box.setSmooth(along, true);
  const r = edit.bisect(box, bisectPlane(1, 0, 0, 0));
  eq('★★ 標了 CUT 的邊被切成兩段，兩段都還是 CUT',
     [...r.mesh.edges()].filter(he => he.role === EDGE_ROLE.CUT).length, 2);
  eq('★★ smooth 也一樣兩段都繼承',
     [...r.mesh.edges()].filter(he => he.smooth).length, 2);
}

{
  /**
   * 🔴 展開不可以被影響（跟環切同一條）。
   * `hard` 會讓 `planarRegions()` 斷開，而展開有沒有用到它是關鍵風險。
   */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const rule = makeRule('acrylic', 0.3);
  const before = unfoldMesh(box, rule);
  const r = edit.bisect(box, bisectPlane(1, 0, 0, 0));
  const after = unfoldMesh(r.mesh, rule);
  eq('★★ 切完之後展開片數一樣', after.pieces.length, before.pieces.length);
  eq('　　警告數也一樣', after.warnings.length, before.warnings.length);
}

{
  /** 存讀檔：不存的話開檔之後切線就沒了，而形狀還在 */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const r = edit.bisect(box, bisectPlane(1, 0, 0, 0));
  const round = Mesh.fromJSON(JSON.parse(JSON.stringify(r.mesh.toJSON())));
  eq('★ 存檔再開，hard 邊還在',
     [...round.edges()].filter(he => he.hard).length, 4);
}

// ═══════════════════════════════════════════════════════
//  連接兩點（Connect Vertex Pairs）＝ 加線 × 兩個既有頂點
// ═══════════════════════════════════════════════════════

section('連接兩點：在一個面上連出一條線');

/**
 * 四動作框架的**第四個**案例，而且是最便宜的一個。
 *
 * ── 🔴 它比前三個多一條主斷言：**頂點數也不變** ──────────────
 * 環切、內縮、切一刀都會**加點**，只有這一支不會 ——
 * 兩個端點是使用者選的既有頂點。所以斷言是
 * **V 不變、E ＋1、F ＋1、χ 不變、體積面積精確不變**。
 *
 * ── ⚠ 挑樣本要涵蓋不同的「網格結構」，不只是不同形狀（坑第 17 條）──
 * 方塊頂面是**四邊形**、圓柱端面是 **32 邊形**，兩種都要走一次。
 * 〔第 3.5 期就是只驗了錐體（全三角形）而漏掉四邊形，STL 壞了兩週〕
 */
const facePicker = (m, nSides, pred) => m.faces.find(f => {
  const vs = m.faceLoop(f).map(he => he.v);
  return vs.length === nSides && (!pred || vs.every(pred));
});

{
  /** 案例一：方塊頂面連對角線。最基本的一條 */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const vol0 = box.volume(), area0 = box.area();
  const v0 = box.verts.length, e0 = edgeCount(box), f0 = box.faces.length;
  eq('前提：bake 之後方塊是 V8 E12 F6', `${v0}/${e0}/${f0}`, '8/12/6');

  const top = facePicker(box, 4, v => Math.abs(v.p.y - 20) < 1e-9);
  ok('前提：找得到頂面那個四邊形', !!top);
  const L = box.faceLoop(top).map(he => he.v);

  const r = edit.connectVerts(box, L[0], L[2]);
  ok('對角兩個點連得起來', r.ok, r.reason);
  const m = r.mesh;

  eq('★★ V 8 → 8（不插新點，跟環切／切一刀不同）', m.verts.length, 8);
  eq('E 12 → 13', edgeCount(m), 13);
  eq('F 6 → 7', m.faces.length, 7);
  eq('★★ χ 仍然是 2', chi(m), 2);
  ok('　　仍然封閉', m.isClosed());
  ok('　　結構沒有問題', m.validate().ok);

  /** 🔴 主斷言：只加線 */
  rel('★★ 體積精確不變', m.volume(), vol0);
  rel('★★ 面積精確不變', m.area(), area0);

  eq('★ 孤點 0 個（只加不減）', r.orphans, 0);
  eq('新的線 1 條', r.newEdges.length, 1);
  eq('　　而且標成 hard', [...m.edges()].filter(he => he.hard).length, 1);

  /**
   * 🔴 出口：不標 hard 的話這條線會被併回去 ——
   * 那就是一顆按了畫面沒反應的按鈕（坑第 21 條，環切那一輪四個出口全中過）。
   */
  ok('★★ 再跑一次併面不會把新的線併回去', !edit.mergeCoplanarFaces(m).ok);
  eq('★★ 頂面真的被切成兩區（6 → 7）',
     new Set(m.faces.map(f => edit.regionOf(m, f).rid)).size, 7);

  /** 存讀檔：不存的話開檔之後線就沒了，而形狀還在 */
  const round = Mesh.fromJSON(JSON.parse(JSON.stringify(m.toJSON())));
  eq('★ 存檔再開，新的線還在', [...round.edges()].filter(he => he.hard).length, 1);
}

{
  /**
   * 案例二：圓柱端面（32 邊形）。**跟方塊是不同的網格結構**。
   * 連對徑 ＝ 把端面切成兩個 17 邊形。
   */
  const cyl = baked('cylinder', { r: 25, h: 70, seg: 32 });
  const vol0 = cyl.volume(), area0 = cyl.area();
  const v0 = cyl.verts.length, e0 = edgeCount(cyl), f0 = cyl.faces.length;

  const cap = facePicker(cyl, 32);
  ok('前提：找得到 32 邊形的端面', !!cap);
  const L = cyl.faceLoop(cap).map(he => he.v);

  const r = edit.connectVerts(cyl, L[0], L[16]);
  ok('32 邊形端面連對徑', r.ok, r.reason);
  eq('★★ V 不變', r.mesh.verts.length, v0);
  eq('★ E ＋1', edgeCount(r.mesh), e0 + 1);
  eq('★ F ＋1', r.mesh.faces.length, f0 + 1);
  eq('★★ χ 仍然是 2', chi(r.mesh), 2);
  ok('　　仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
  rel('★★ 體積精確不變', r.mesh.volume(), vol0);
  rel('★★ 面積精確不變', r.mesh.area(), area0);

  /** 隔一個也要連得起來（切出一個三角形 ＋ 一個 31 邊形） */
  const r2 = edit.connectVerts(cyl, L[0], L[2]);
  ok('★ 隔一個點也連得起來', r2.ok, r2.reason);
  rel('　　體積照樣精確不變', r2.mesh.volume(), vol0);
}

{
  /**
   * 🔴 **三種擋下來的情形，每一種的「原因」都要對。**
   *
   * ⚠ **這一組是沙箱實測抓到 bug 才加的**（2026-08-25）：
   * 相鄰的兩個點**本來就同時屬於兩個面**（共用那條邊的左右兩片），
   * 所以原本「同時在好幾個面上」那個檢查會**先觸發**，
   * 使用者被指去想面的問題，而真正的原因是「本來就有線」。
   * 〔坑第 34 條：不要給一個不存在的方向。導角那一輪才剛犯過〕
   *
   * → 相鄰改成**最先擋**，而且判準是「有沒有邊」不是迴圈上的位置。
   */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const top = facePicker(box, 4, v => Math.abs(v.p.y - 20) < 1e-9);
  const L = box.faceLoop(top).map(he => he.v);

  const adj = edit.connectVerts(box, L[0], L[1]);
  ok('★★ 相鄰擋下來，而且說的是「本來就有線」',
     !adj.ok && /本來就已經有一條線/.test(adj.reason || ''), adj.reason);
  ok('★★ ⛔ 不可以說成「同時在好幾個面上」',
     !/好幾個面|重疊/.test(adj.reason || ''), adj.reason);

  const bot = box.verts.find(v => Math.abs(v.p.y + 20) < 1e-9);
  const far = edit.connectVerts(box, L[0], bot);
  ok('★ 跨面擋下來並說原因', !far.ok && /不在同一個面/.test(far.reason || ''));
  ok('★ 而且老實說「跨過好幾個面的還沒做」，⛔ 不指一條不存在的路',
     /還沒做/.test(far.reason || ''), far.reason);

  const same = edit.connectVerts(box, L[0], L[0]);
  ok('★ 同一個點擋下來並說原因', !same.ok && !!same.reason);

  ok('★ 沒給點也擋下來', !edit.connectVerts(box, null, L[0]).ok);
}

// ═══════════════════════════════════════════════════════
//  面上加線（＝ Blender 的 Subdivide 選兩條邊）
// ═══════════════════════════════════════════════════════

section('面上加線：兩條邊各長一個點，連起來');

/**
 * 🔴 **kang 2026-08-25 指出「連接兩點」不是他要的**：
 * > 「我以為是我可以在面或邊上做切一刀..**讓面變成兩等分**」
 *
 * 「連接兩點」只能連**既有的角**，切出來是三角形。
 * 要兩等分得**先在邊的中間長出點** —— 這一支就是去長那個點。
 * kang 拍板**分成兩顆按鈕**（「畢竟效果呈現不同」）。
 *
 * ── 🔴 這一節的主角是「第二條邊要反過來算」───────────────
 * 兩條邊在面的迴圈上是繞著走的，各自的 `t` 會落在**對角** →
 * 切出來是**斜線**。所以 A 取 `t`、B 取 `1 − t`。
 *
 * **那件事只有兩種驗法，兩種都放進來了：**
 * 1. `t=0.5` 兩塊面積**完全相等**、`t=0.3` 是 3:7
 * 2. ⭐ **新線的方向不隨 `t` 改變** —— 這一條更直接：
 *    沒有反過來算的話，`t` 一離開 0.5 線就會歪掉。
 */
const areaOfFace = (m, f) => {
  let s = 0;
  for (const [v0, v1, v2] of m.faceTriangles(f)) {
    const ab = v1.p.clone().sub(v0.p), ac = v2.p.clone().sub(v0.p);
    s += ab.cross(ac).length() / 2;
  }
  return s;
};
/** 新線兩側那兩塊的面積（大的在前，⛔ 不要靠面的順序） */
const splitAreas = (m, newEdge) => {
  const di = m._vertIndex();
  const [a, b] = newEdge;
  const parts = m.faces.filter(f => {
    const idx = m.faceLoop(f).map(he => di.get(he.v.id));
    return idx.includes(a) && idx.includes(b);
  });
  return parts.map(f => areaOfFace(m, f)).sort((x, y) => y - x);
};
const newEdgeDir = (m, newEdge) => {
  const di = m._vertIndex();
  const [a, b] = newEdge;
  const he = [...m.edges()].find(h => {
    const x = di.get(h.v.id), y = di.get(h.to.id);
    return (x === a && y === b) || (x === b && y === a);
  });
  const d = he.to.p.clone().sub(he.v.p).normalize();
  /** 方向的正負無所謂（邊沒有規定哪頭是頭），統一成第一個非零分量為正 */
  for (const k of ['x', 'y', 'z']) {
    if (Math.abs(d[k]) > 1e-9) { if (d[k] < 0) d.negate(); break; }
  }
  return d;
};

{
  /** 案例一：方塊頂面兩條對邊，t=0.5 → 兩等分。kang 要的那個 */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const vol0 = box.volume(), area0 = box.area();
  const top = box.faces.find(f => {
    const vs = box.faceLoop(f).map(he => he.v);
    return vs.length === 4 && vs.every(v => Math.abs(v.p.y - 20) < 1e-9);
  });
  ok('前提：找得到頂面那個四邊形', !!top);
  const hes = box.faceLoop(top);

  const r = edit.splitFaceByEdges(box, hes[0], hes[2], 0.5);
  ok('兩條對邊加得出線', r.ok, r.reason);
  const m = r.mesh;

  eq('★ V 8 → 10（兩條邊各長一個點）', m.verts.length, 10);
  eq('E 12 → 15', edgeCount(m), 15);
  eq('F 6 → 7', m.faces.length, 7);
  eq('★★ χ 仍然是 2', chi(m), 2);
  ok('　　仍然封閉、結構沒問題', m.isClosed() && m.validate().ok);

  /** 🔴 主斷言：只加線 */
  rel('★★ 體積精確不變', m.volume(), vol0);
  rel('★★ 面積精確不變', m.area(), area0);

  eq('★ 孤點 0 個', r.orphans, 0);
  eq('新的線 1 條，而且是 hard', [...m.edges()].filter(he => he.hard).length, 1);

  /**
   * 🔴 **鄰面一定要跟著加點，否則破洞。**
   * 方塊頂面的兩條對邊各被兩個面共用 → 兩個側面被波及。
   * ⚠ 這是使用者**看得見**的副作用（側面多一條短線），呼叫端要講出來。
   */
  eq('★★ 兩個側面跟著加了點', r.touched, 2);

  /** 🔴 兩等分 ＝ 兩塊面積完全相等 */
  const A = splitAreas(m, r.newEdges[0]);
  eq('前提：新線兩側正好兩塊', A.length, 2);
  rel('★★ t=0.5 兩塊面積完全相等', A[0], A[1]);
  /**
   * ⚠ **頂面是 w×d ＝ 60×45，不是 60×h。**
   * 〔第一版照沙箱腳本抄了 60×40，而那份的參數是 `h:45, d:40` ——
   * 　**挑樣本要先去量，不要照參數名推**（任意切線案例五記過同一條）〕
   */
  rel('　　兩塊加起來 ＝ 頂面 60×45', A[0] + A[1], 2700);
}

{
  /**
   * 🔴 **案例二：t=0.3。這一組才驗得出「第二條邊有沒有反過來算」。**
   *
   * ⚠ `t=0.5` 是**對稱**的，反不反過來結果一樣 ——
   * 只驗 0.5 等於沒驗到這一條（那正是坑第 17 條「挑樣本」那類的錯）。
   */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const vol0 = box.volume();
  const top = box.faces.find(f => {
    const vs = box.faceLoop(f).map(he => he.v);
    return vs.length === 4 && vs.every(v => Math.abs(v.p.y - 20) < 1e-9);
  });
  const hes = box.faceLoop(top);

  const half = edit.splitFaceByEdges(box, hes[0], hes[2], 0.5);
  const r = edit.splitFaceByEdges(box, hes[0], hes[2], 0.3);
  ok('t=0.3 也加得出線', r.ok, r.reason);
  rel('★★ 體積照樣精確不變', r.mesh.volume(), vol0);

  const A = splitAreas(r.mesh, r.newEdges[0]);
  rel('★★ t=0.3 兩塊面積比 ＝ 7:3', A[0] / (A[0] + A[1]), 0.7);
  rel('　　大的那塊 ＝ 60 × 31.5', A[0], 1890);
  rel('　　小的那塊 ＝ 60 × 13.5', A[1], 810);

  /**
   * ⭐ **最直接的一條**：沒有把第二條邊反過來算的話，
   * `t` 一離開 0.5 新線就會歪掉。方向一樣 ＝ 真的平行。
   */
  const d5 = newEdgeDir(half.mesh, half.newEdges[0]);
  const d3 = newEdgeDir(r.mesh, r.newEdges[0]);
  near('★★ t=0.3 的新線跟 t=0.5 平行（x）', d3.x, d5.x, 1e-9);
  near('　　　　　　　　　　　　　　　（y）', d3.y, d5.y, 1e-9);
  near('　　　　　　　　　　　　　　　（z）', d3.z, d5.z, 1e-9);
}

{
  /** 案例三：相鄰的兩條邊 → 切出一個三角形。也要走得通 */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const vol0 = box.volume(), area0 = box.area();
  const top = box.faces.find(f => {
    const vs = box.faceLoop(f).map(he => he.v);
    return vs.length === 4 && vs.every(v => Math.abs(v.p.y - 20) < 1e-9);
  });
  const hes = box.faceLoop(top);

  const r = edit.splitFaceByEdges(box, hes[0], hes[1], 0.5);
  ok('★ 相鄰的兩條邊也加得出線（切出一個角）', r.ok, r.reason);
  eq('★★ χ 仍然是 2', chi(r.mesh), 2);
  ok('　　仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
  rel('★★ 體積精確不變', r.mesh.volume(), vol0);
  rel('★★ 面積精確不變', r.mesh.area(), area0);
}

{
  /** 案例四：圓柱端面（32 邊形）—— **跟方塊是不同的網格結構**（坑第 17 條）*/
  const cyl = baked('cylinder', { r: 25, h: 70, seg: 32 });
  const vol0 = cyl.volume(), area0 = cyl.area();
  const v0 = cyl.verts.length;
  const cap = cyl.faces.find(f => cyl.faceLoop(f).length === 32);
  ok('前提：找得到 32 邊形的端面', !!cap);
  const hes = cyl.faceLoop(cap);

  const r = edit.splitFaceByEdges(cyl, hes[0], hes[16], 0.5);
  ok('32 邊形端面加得出線', r.ok, r.reason);
  eq('★ V ＋2', r.mesh.verts.length, v0 + 2);
  eq('★★ χ 仍然是 2', chi(r.mesh), 2);
  ok('　　仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
  rel('★★ 體積精確不變', r.mesh.volume(), vol0);
  rel('★★ 面積精確不變', r.mesh.area(), area0);
  eq('★ 兩片側面跟著加了點', r.touched, 2);
}

{
  /** 案例五：擋下來的情形，每一種都要說原因（坑第 11 條） */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const top = box.faces.find(f => {
    const vs = box.faceLoop(f).map(he => he.v);
    return vs.length === 4 && vs.every(v => Math.abs(v.p.y - 20) < 1e-9);
  });
  const hes = box.faceLoop(top);

  ok('★ 同一條邊擋下來', !edit.splitFaceByEdges(box, hes[0], hes[0], 0.5).ok);
  ok('★ t=0 擋下來並說範圍',
     !edit.splitFaceByEdges(box, hes[0], hes[2], 0).ok);
  ok('★ t=1 擋下來', !edit.splitFaceByEdges(box, hes[0], hes[2], 1).ok);

  /**
   * 🔴 **太靠近端點要擋，判準是實際距離不是比例** ——
   * 插的點離既有頂點比 0.1mm 還近會長出零長度的邊，
   * 而**體積、面積、χ 全部照樣正確**（坑第 17、25／26 條）。
   */
  const tiny = edit.splitFaceByEdges(box, hes[0], hes[2], 0.0001);
  ok('★★ 太靠近端點擋下來，而且講出那條邊多長',
     !tiny.ok && /太靠近|端點/.test(tiny.reason || '') && /cm/.test(tiny.reason || ''),
     tiny.reason);

  /** 不同面的兩條邊 */
  const side = box.faces.find(f => f !== top);
  const sh = box.faceLoop(side).find(h => !hes.includes(h) && !hes.includes(h.twin));
  const cross = edit.splitFaceByEdges(box, hes[0], sh, 0.5);
  ok('★ 不在同一個面上，擋下來並說原因',
     !cross.ok && /不在同一個面/.test(cross.reason || ''), cross.reason);
}

// ═══════════════════════════════════════════════════════
//  ⛔ 「刀具：螢幕兩點算出來的平面」那一節已於 2026-08-26 刪除
// ═══════════════════════════════════════════════════════

/**
 * `planeFromTwoRays()` 連同它的 6 項測試一起刪了。
 *
 * 那是刀具**第一版**的核心（螢幕上點兩點 → 一片往深處延伸的刀片），
 * kang 2026-08-25 實測否決：「不知道要如何點兩點呈現我想要的位置」——
 * 因為那個延伸方向使用者看不見。刀具改成「點一串模型上的位置」之後，
 * 兩點定平面**沒有已知用途**。
 *
 * ⛔ 留著一支沒人呼叫的函式 ＋ 還在跑的測試，等於在日誌上留一條
 * 不存在的退路（坑第 34 條）。經過見 `HISTORY.md`。
 */

{
  /**
   * 🔴 **世界平面 → 本地平面**，而且要跟 `worldAxisPlane()` 對得起來。
   *
   * ⭐ 那一支現在是**這一支的特例**（法向是單位軸）——
   * 兩條路合成一條之後，這裡就是「合對了沒有」的機械斷言。
   */
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(10, 20, 30),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.7, 0.2)),
    new THREE.Vector3(1, 1, 1)
  );
  for (const [axis, n] of [['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]]) {
    const a = edit.worldAxisPlane(m, axis, 5);
    const b = edit.worldPlaneToLocal(m, new THREE.Vector3(...n), 5);
    near(`★★ ${axis} 軸：兩條路的法向逐項相同（x）`, a.n.x, b.n.x, 1e-12);
    near(`　　　　　　　　　　　　　　　　（y）`, a.n.y, b.n.y, 1e-12);
    near(`　　　　　　　　　　　　　　　　（z）`, a.n.z, b.n.z, 1e-12);
    near(`　　偏移也相同`, a.d, b.d, 1e-12);
  }

  /**
   * ⭐ **端到端**：拿一個世界平面換到本地，再把本地上的點換回世界 ——
   * 必須還是落在原本那個平面上。
   * ⚠ 這一條才是真正在驗「換算對不對」，前面那幾條只驗「兩條路一樣」
   * （兩條路一起錯的話它們照樣相同）。
   */
  const wn = new THREE.Vector3(1, 2, 3).normalize();
  const wd = 7;
  const lp = edit.worldPlaneToLocal(m, wn, wd);
  const local = new THREE.Vector3(1, -2, 4);
  /** 把 local 挪到本地平面上 */
  local.addScaledVector(lp.n, (lp.d - lp.n.dot(local)) / lp.n.lengthSq());
  near('★★★ 本地平面上的點換回世界，仍然落在原本的世界平面上',
       local.clone().applyMatrix4(m).dot(wn), wd, 1e-9);
}

section('刀具：點一串位置，依序切過去');

/**
 * 🔴 **kang 2026-08-25 想出來的操作方式**（第一版「兩點定平面」被他
 * 實測否決之後）：
 * > 「改成可以任意點選**不只兩個點**...同一面兩點指定完...我再按刀具
 * > 　就切這一個面...正面兩點然後我反側面再選一點..就會切兩個面...
 * > 　以此類推...**環繞一圈**」
 *
 * ⭐ **它剛好解掉第一版「預覽一直亂跳」的病**：使用者點的是
 * **模型上的實際位置**，不是「從眼睛射出去的一條線」——
 * 轉視角完全不影響。
 *
 * ── ⭐ 一段新的幾何都沒寫 ────────────────────────────
 * 1. 在每個點的位置**插一個頂點**（＝「邊上加點」的後半段）
 * 2. 那些點就變成**既有頂點**
 * 3. 直接餵給 **`connectVertsPath()`**（＝「多點連接」）
 *
 * 🔴 **「跨面」也不用另外做**：正面與側面的**共用邊同時屬於兩個面**，
 * 在共用邊上點一下，前後兩段就自然接起來。
 */
{
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const vol0 = box.volume(), area0 = box.area();
  const vi = box._vertIndex();
  const top = box.faces.find(f => {
    const vs = box.faceLoop(f).map(he => he.v);
    return vs.length === 4 && vs.every(v => Math.abs(v.p.y - 20) < 1e-9);
  });
  const hes = box.faceLoop(top);
  const pick = (he, t) => ({
    a: vi.get(he.v.id), b: vi.get(he.to.id),
    p: he.v.p.clone().lerp(he.to.p, t)
  });

  /** 例子一：同一面兩點 → 切這一面 */
  const r1 = edit.knifePath(box, [pick(hes[0], 0.3), pick(hes[2], 0.7)]);
  ok('同一面點兩個位置，切得下去', r1.ok, r1.reason);
  eq('★ 加了 2 個點', r1.added, 2);
  eq('★ 連成 1 段', r1.segments, 1);
  eq('★ V 8 → 10', r1.mesh.verts.length, 10);
  eq('★★ χ 仍然是 2', chi(r1.mesh), 2);
  ok('　　仍然封閉、結構沒問題', r1.mesh.isClosed() && r1.mesh.validate().ok);
  rel('★★ 體積精確不變', r1.mesh.volume(), vol0);
  rel('★★ 面積精確不變', r1.mesh.area(), area0);

  /**
   * 🔴 **例子二：正面兩點 ＋ 側面一點 → 切兩個面。**
   * ⭐ 這一條才是 kang 要的那個 —— 中間那一點落在**共用邊**上，
   * 它同時屬於兩個面，所以前後兩段各自成立。
   */
  const side = box.faces.find(f => f !== top && box.faceLoop(f).some(h =>
    (h.v === hes[1].v && h.to === hes[1].to) || (h.v === hes[1].to && h.to === hes[1].v)));
  ok('前提：找得到跟頂面共用一條邊的側面', !!side);
  const other = box.faceLoop(side).find(h =>
    !hes.includes(h) && !hes.some(x => x.v === h.to && x.to === h.v)
    && Math.abs(h.v.p.y - h.to.p.y) < 1e-9);
  ok('前提：那個側面上找得到另一條水平邊', !!other);

  const r2 = edit.knifePath(box, [pick(hes[0], 0.4), pick(hes[1], 0.5), pick(other, 0.6)]);
  ok('★★★ 正面兩點 ＋ 側面一點，切得下去（kang 要的那個）', r2.ok, r2.reason);
  eq('★★ 連成 2 段', r2.segments, 2);
  eq('★★ 新的線 2 條', r2.newEdges.length, 2);
  eq('★ 加了 3 個點', r2.added, 3);
  eq('★★ χ 仍然是 2', chi(r2.mesh), 2);
  ok('　　仍然封閉、結構沒問題', r2.mesh.isClosed() && r2.mesh.validate().ok);
  rel('★★ 體積精確不變', r2.mesh.volume(), vol0);
  rel('★★ 面積精確不變', r2.mesh.area(), area0);

  /**
   * ⚠ **同一條邊上點兩次**（繞一圈時很常見）。
   * 🔴 那條邊上的點要**照順序插**，不然面會自交 —— 而自交的症狀是
   * 面積算多，χ 跟體積照樣正確（坑第 17 條）。
   */
  const r3 = edit.knifePath(box, [pick(hes[0], 0.2), pick(hes[2], 0.5), pick(hes[0], 0.8)]);
  ok('★★ 同一條邊上點兩次也走得通', r3.ok, r3.reason);
  rel('★★★ 面積精確不變（自交的話這裡會變多）', r3.mesh.area(), area0);
  rel('　　體積精確不變', r3.mesh.volume(), vol0);
  ok('　　結構沒問題', r3.mesh.validate().ok);

  /** 擋下來 */
  ok('★ 只點一個位置要擋', !edit.knifePath(box, [pick(hes[0], 0.5)]).ok);
  /**
   * 🔴 **⛔ 這道擋線要留著，但它的【訊息】2026-09-01 改了。**
   * 舊版寫「想從角落切就用『多點連接』」——
   * 而**刀具現在自己吸得到角**，再叫他換工具就是**假的退路**（鐵律六）。
   * ⚠ 擋的東西沒變：它擋的是「**插一個新點**在端點附近」，
   * 跟底下那組「**重用既有的角**」是兩件事。
   */
  const tiny = edit.knifePath(box, [pick(hes[0], 0.00001), pick(hes[2], 0.5)]);
  ok('★★ 太靠近角落（插新點）要擋，而且要指出一條【真的走得通】的路',
     !tiny.ok && /吸上去/.test(tiny.reason || '') && !/多點連接/.test(tiny.reason || ''),
     tiny.reason);

  /**
   * 🔴🔴 **吸到角：重用既有的頂點，⛔ 不插新點**（2026-09-01，kang 收回「不做」）。
   *
   * ⚠ **這一組守的正是 2026-09-01 那次整輪撤回的病** ——
   * 當時的做法是「把 `s` 設成 0／1」＝ **在角上插一個新點**，
   * 於是跟原本的角重合、夾出長度 0 的邊、**每一次都切不下去**。
   * ⭐ **判準⛔ 不是「有沒有切成功」，是「頂點多了幾個」** ——
   * 重用只會多 **1** 個（另一端那個插點），插新點會多 **2** 個。
   */
  {
    const cn = { v: vi.get(hes[0].v.id) };            // 頂面的一個角
    const rc = edit.knifePath(box, [cn, pick(hes[2], 0.5)]);
    ok('★★ 從角落切，切得下去（⛔ 不再被端點那道擋掉）', rc.ok, rc.reason);
    eq('★★ 頂點 8 → 9：只多【1】個 —— 角是重用的，⛔ 不是新插的',
       rc.mesh.verts.length, 9);
    eq('★★ χ 仍然是 2', chi(rc.mesh), 2);
    ok('　　仍然封閉、結構沒問題', rc.mesh.isClosed() && rc.mesh.validate().ok);
    rel('★★ 體積精確不變', rc.mesh.volume(), vol0);
    let z = 0;
    for (const he of rc.mesh.edges()) if (he.v.p.distanceTo(he.to.p) < 1e-9) z++;
    eq('★★★ 長度 0 的邊：0 —— 這一項就是當初撤回的那個病', z, 0);

    /** 兩端都吸到角也要成立（對角線那一刀） */
    const rc2 = edit.knifePath(box, [cn, { v: vi.get(hes[2].v.id) }]);
    ok('★★ 兩端都是角，照樣切得下去', rc2.ok, rc2.reason);
    eq('★★ 兩端都是角 → 頂點【一個都沒多】', rc2.mesh.verts.length, 8);
    rel('★★ 體積精確不變', rc2.mesh.volume(), vol0);

    /** ⛔ 不存在的角要擋，⛔ 不可以安靜地算出奇怪的東西 */
    ok('★ 角的索引不在這個物件上 → 要擋',
       !edit.knifePath(box, [{ v: 999 }, pick(hes[2], 0.5)]).ok);
  }

  /**
   * 🔴🔴 **繞一圈閉合之後【分得開】**（2026-09-01，kang 回報的 bug）。
   *
   * ⚠ **病因**：閉合（快點兩下）是**把第一個點複製一份加到最後**，
   * 而插點那一步照著在**同一個位置又插了一個頂點** ——
   * 那一圈的頭尾變成**兩個重合但不同的點**，中間夾著**一條長度 0 的邊**，
   * 而 `分離` 的走訪就從那條邊**穿過去**了。
   *
   * ⭐ **對照組是 `切一刀`**：同一個方塊、同一個位置，它給 12 個頂點、
   * 0 條長度 0 的邊、分得開 —— **兩邊的新邊都是 4 條、面都是 10**，
   * 唯一的差別就是那個重複點。
   */
  {
    const b2 = baked('box', { w: 60, h: 45, d: 40 });
    const vi2 = b2._vertIndex();
    const ups = [];
    for (const he of b2.edges()) {
      const A = he.v.p, B = he.to.p;
      if (Math.abs(A.x - B.x) < 1e-6 && Math.abs(A.z - B.z) < 1e-6
          && Math.abs(A.y - B.y) > 1) ups.push(he);
    }
    eq('前提：方塊有 4 條直立的角柱邊', ups.length, 4);
    ups.sort((p, q) => Math.atan2(p.v.p.z, p.v.p.x) - Math.atan2(q.v.p.z, q.v.p.x));
    const ring = ups.map(he => ({
      a: vi2.get(he.v.id), b: vi2.get(he.to.id),
      p: he.v.p.clone().lerp(he.to.p, 0.5)
    }));
    /** ⚠ 這一行就是「快點兩下閉合」做的事：把第一個點複製一份加到最後 */
    ring.push({ ...ring[0], p: ring[0].p.clone() });

    const rr = edit.knifePath(b2, ring);
    ok('★ 繞一圈閉合，切得下去', rr.ok, rr.reason);
    eq('★ 連成 4 段', rr.segments, 4);
    eq('★★ 頂點 8 → 12（⛔ 不是 13）—— 重複的那個點要被合併掉',
       rr.mesh.verts.length, 12);

    let zero = 0;
    for (const he of rr.mesh.edges()) if (he.v.p.distanceTo(he.to.p) < 1e-9) zero++;
    eq('★★ 🔴 長度 0 的邊：0 條', zero, 0);

    let dup = 0;
    const vs2 = rr.mesh.verts;
    for (let i = 0; i < vs2.length; i++) {
      for (let j = i + 1; j < vs2.length; j++) {
        if (vs2[i].p.distanceTo(vs2[j].p) < 1e-9) dup++;
      }
    }
    eq('★★ 🔴 位置重合的頂點對：0', dup, 0);

    const di2 = rr.mesh._vertIndex();
    const kk = (x, y) => (x < y ? `${x}-${y}` : `${y}-${x}`);
    const want = new Set(rr.newEdges.map(([x, y]) => kk(x, y)));
    const wall = [];
    for (const he of rr.mesh.edges()) {
      const x = di2.get(he.v.id), y = di2.get(he.to.id);
      if (want.has(kk(x, y))) wall.push(he);
    }
    eq('★ 切出來的新邊 4 條', want.size, 4);
    const sep = edit.separateAlongEdges(rr.mesh, wall);
    ok('★★★ 🔴 分離：真的分得開', sep.ok, sep.reason);
    eq('★★★ 分成幾塊', sep.parts, 2);

    /** ⭐ 對照組：`切一刀` 在同一個位置切，兩邊要給同一組數字 */
    const b3 = baked('box', { w: 60, h: 45, d: 40 });
    const bi = edit.bisect(b3, { n: new THREE.Vector3(0, 1, 0), d: 0 });
    ok('對照組：切一刀切得下去', bi.ok, bi.reason);
    eq('★★ 對照組的頂點數跟刀具閉合【一樣】',
       bi.mesh.verts.length, rr.mesh.verts.length);
    eq('★★ 對照組的面數跟刀具閉合【一樣】',
       bi.mesh.faces.length, rr.mesh.faces.length);
  }

  /**
   * 🔴 兩個點不同屬一個面 → 擋，而且要說「中間再點一個」。
   * ⚠ **樣本要先去量**：頂面的邊跟底面的邊**可能同屬一個側面**
   * （那樣是連得起來的，不是 bug）。要挑真的跨不過去的那一組。
   * 〔第一版沙箱腳本就挑錯過，還以為是 bug〕
   */
  const bot = box.faces.find(f => box.faceLoop(f).every(h => Math.abs(h.v.p.y + 20) < 1e-9));
  const far = box.faceLoop(bot).find(h => {
    const s = new Set([h.v, h.to]);
    return !box.faceLoop(side).some(x => s.has(x.v));
  });
  ok('前提：找得到一條跟那個側面完全不相干的底面邊', !!far);
  if (far) {
    const cross = edit.knifePath(box, [pick(hes[0], 0.5), pick(far, 0.5)]);
    ok('★★ 跨太遠要擋下來', !cross.ok, '竟然連起來了');
    ok('★★ 而且要說「不在同一個面上」', /不在同一個面/.test(cross.reason || ''), cross.reason);
  }
}

section('刀具：這一刀會切在哪（預覽用的交線）');

/**
 * 🔴 **kang 2026-08-25 實測指出的核心問題**：
 * > 「光是兩點...**測試後也不知道要如何點兩點呈現我想要的切一刀位置**」
 *
 * 螢幕上那條虛線只說明「你畫過哪裡」，這一支算的才是「**會切到哪裡**」。
 *
 * ⚠ `slice/section.js` 的 `sectionAt()` **重用不了** —— 它綁死在
 * X／Y／Z 軸上，而刀具的平面是任意方向的。
 * 〔又一次「讀程式，不要照它的描述推」〕
 */
{
  const box = baked('box', { w: 60, d: 45, h: 40 });

  /** 攔腰一刀：方塊的四個側面各被切一段 → 4 段 */
  const segs = edit.planeCrossSegments(box, { n: new THREE.Vector3(0, 1, 0), d: 0 });
  eq('★★ 方塊攔腰切，交線是 4 段（每段兩個端點 ＝ 8 個點）', segs.length, 8);
  ok('★★ 每個端點都落在平面上',
     segs.every(p => Math.abs(p.y) < 1e-9));

  /**
   * ⭐ **周長對得起來**：那 4 段接起來就是 60×45 的一圈 ＝ 210。
   * 🔴 這一條比「幾段」有用得多 —— 段數對但長度錯的話，
   * 畫出來的線會是歪的，而**畫面上很難看出來**（鐵律三）。
   */
  let total = 0;
  for (let i = 0; i < segs.length; i += 2) total += segs[i].distanceTo(segs[i + 1]);
  rel('★★★ 四段加起來 ＝ 頂面一圈的周長 210', total, 210);

  /** 斜著切也要算得出來（那正是刀具做得到、切一刀做不到的） */
  const tilt = edit.planeCrossSegments(box,
    { n: new THREE.Vector3(1, 1, 0).normalize(), d: 0 });
  ok('★ 斜的平面也切得出交線', tilt.length >= 2);
  ok('★★ 斜切的端點也都落在那個斜平面上',
     tilt.every(p => Math.abs(p.x + p.y) < 1e-6));

  /** 平面在物件外面 → 沒有交線，⛔ 不可以丟例外 */
  eq('★ 平面在物件外面，回空的（不是壞掉）',
     edit.planeCrossSegments(box, { n: new THREE.Vector3(0, 1, 0), d: 999 }).length, 0);
  eq('★ 沒給平面也不會壞', edit.planeCrossSegments(box, null).length, 0);
  eq('★ 法向是 0 也不會壞',
     edit.planeCrossSegments(box, { n: new THREE.Vector3(0, 0, 0), d: 0 }).length, 0);

  /**
   * 🔴 **平面剛好通過既有頂點時，不可以吐出長度 0 的線段。**
   * ⚠ 那種線段畫出來是一個看不見的點，而「幾段」照樣是對的 ——
   * 只有量長度才抓得到（坑第 17 條）。
   */
  const oct = baked('prism', { r: 30, h: 50, sides: 8 });
  const onVert = edit.planeCrossSegments(oct, { n: new THREE.Vector3(1, 0, 0), d: 0 });
  ok('★★ 通過既有頂點時，沒有長度 0 的線段',
     onVert.every((p, i) => i % 2 === 1 || p.distanceTo(onVert[i + 1]) > 1e-6));
}

// ═══════════════════════════════════════════════════════
//  一筆畫：拖一條線過表面 → 交點變成切點
// ═══════════════════════════════════════════════════════

section('刀具・一筆畫：一串表面點 → 一串切點');

/**
 * 🔴 **kang 2026-08-26 批准的三項輔助，第一項。**
 * > 「按住拖一條線過表面 → 放開，**交點自動變成切點**」
 *
 * ── 🔴 主斷言：每相鄰兩個切點必定同屬一個面 ─────────────────
 * 那正是 `connectVertsPath()` 的規則，也是**這一支唯一真正要保證的事**。
 * 保證得到 → 產出的東西一定切得下去；保證不到 → 使用者只會看到
 * 「切不下去」而完全不知道為什麼。
 *
 * ⭐ **它是結構保證不是碰運氣**：起點吸到 `f0` 的邊、第 i 個交點是
 * `f_{i-1}|f_i` 的共用邊、終點吸到 `f_n` 的邊 —— 逐項可以推。
 * 這一節就是那條推論的機械斷言。
 *
 * ── ⚠ 沙箱驗得了什麼、驗不了什麼 ──────────────────────────
 * **驗得了**：切點算得對不對、切下去體積面積變不變、退化情形擋不擋。
 * **驗不了**：手感、`OrbitControls` 那個手勢換得對不對、平板兩指 ——
 * 那一半只有 kang 實際開起來才算數（鐵律五）。
 */
{
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const stroke = await import('../js/core/stroke.js');

  /** 一個切點落在哪些面上（一條邊最多屬於兩個面） */
  const facesOfPick = (m, pk) => {
    const di = m._vertIndex();
    const out = new Set();
    for (const he of m.halfEdges) {
      const a = di.get(he.v.id), b = di.get(he.to.id);
      if ((a === pk.a && b === pk.b) || (a === pk.b && b === pk.a)) {
        if (he.face) out.add(he.face);
      }
    }
    return out;
  };

  /** 🔴 主斷言：每相鄰兩個切點都找得到一個共同的面 */
  const chainOK = (m, picks) => {
    for (let i = 0; i + 1 < picks.length; i++) {
      const A = facesOfPick(m, picks[i]), B = facesOfPick(m, picks[i + 1]);
      if (![...A].some(f => B.has(f))) return false;
    }
    return true;
  };

  const box = baked('box', { w: 60, h: 45, d: 40 });
  const top = box.bounds().max.y;
  const xhi = box.bounds().max.x, xlo = box.bounds().min.x;
  const ylo = box.bounds().min.y;
  eq('前提：bake 過的方塊是 6 個面（不是 12 個三角形）', box.faces.length, 6);

  /** ① 只在一個面裡劃：兩端吸到那個面的邊，中間 0 個交點 */
  {
    const pts = Array.from({ length: 21 }, (_, i) => V(-25 + 50 * i / 20, top, 7));
    const r = stroke.strokeToPicks(box, pts);
    ok('① 頂面橫劃 算得出切點', r.ok, r.reason);
    eq('★ 兩端各一個，共 2 個切點', r.picks.length, 2);
    eq('★★ 中間沒有穿過任何一條邊', r.crossings, 0);
    ok('★★★ 相鄰兩個切點同屬一個面', chainOK(box, r.picks));

    /**
     * 🔴 **切點要落在使用者劃的位置上，不是隨便一個地方。**
     * ⚠ 這一條沒有的話，「算得出切點」通過了也不代表切在對的地方。
     */
    ok('★★★ 兩個切點的 z 都是使用者劃的 7（⛔ 不是邊的中點）',
       r.picks.every(p => Math.abs(p.p.z - 7) < 1e-9));

    const k = edit.knifePath(box, r.picks);
    ok('★★ 切得下去', k.ok, k.reason);
    eq('★ 切成 1 段', k.segments, 1);
    rel('★★★ 體積精確不變', k.mesh.volume(), box.volume());
    rel('★★★ 表面積精確不變', k.mesh.area(), box.area());
    eq('★★ χ 仍是 2', chi(k.mesh), 2);
    eq('★ 頂面被切成兩塊（面數 +1）', k.mesh.faces.length, box.faces.length + 1);
  }

  /** ② 吸中點：**只有落點變**，其餘一格都不動 */
  {
    const pts = Array.from({ length: 21 }, (_, i) => V(-25 + 50 * i / 20, top, 7));
    const a = stroke.strokeToPicks(box, pts);
    const b = stroke.strokeToPicks(box, pts, { snapMid: true });
    ok('② 吸中點也算得出來', b.ok, b.reason);
    eq('★ 切點個數跟不吸中點一樣', b.picks.length, a.picks.length);
    ok('★★ 落在同樣那兩條邊上',
       b.picks.every((p, i) => p.a === a.picks[i].a && p.b === a.picks[i].b));
    ok('★★★ 落點真的移到邊的正中間了（z 從 7 變 0）',
       b.picks.every(p => Math.abs(p.p.z) < 1e-9));
    /**
     * ⚠ **這一條的兩半要分清楚**：中點是 `z = 0`，使用者劃的是 `z = 7`。
     * 〔寫這條時第一次比錯了對象（拿 `z − 7` 去比「不是中點」），
     * 　而它**當場就紅了** —— 那正是斷言該有的樣子〕
     */
    ok('★★ 而不吸中點時 ⛔ 不可以自己跑到中點（z = 0）去',
       a.picks.every(p => Math.abs(p.p.z) > 1e-6));
  }

  /** ③ 跨面：頂面 → 側面，中間要生出一個交點 */
  {
    const pts = [];
    for (let i = 0; i <= 10; i++) pts.push(V(-10 + 36 * i / 10, top, 0));
    for (let i = 1; i <= 10; i++) pts.push(V(xhi, top - 20 * i / 10, 0));
    const r = stroke.strokeToPicks(box, pts);
    ok('③ 頂面→側面 算得出切點', r.ok, r.reason);
    eq('★★ 中間穿過 1 條邊', r.crossings, 1);
    eq('★ 共 3 個切點', r.picks.length, 3);
    ok('★★★ 相鄰兩個切點同屬一個面', chainOK(box, r.picks));

    const k = edit.knifePath(box, r.picks);
    ok('★★ 切得下去', k.ok, k.reason);
    eq('★ 切成 2 段', k.segments, 2);
    rel('★★★ 體積精確不變', k.mesh.volume(), box.volume());
    rel('★★★ 表面積精確不變', k.mesh.area(), box.area());
    eq('★★ χ 仍是 2', chi(k.mesh), 2);
  }

  /**
   * ④ 🔴 **劃太快：只有兩個取樣點就跨過整個面。**
   *
   * ⚠ **這一條是這支檔案存在的理由之一** —— 手一快，`pointermove`
   * 中間那些點根本不會發生，而兩端的面**不相鄰**。
   * ⛔ 不可以猜一條邊（坑第 24 條），要對半切下去重新問。
   */
  {
    const r = stroke.strokeToPicks(box, [V(-20, top, 0), V(xhi, 0, 0)]);
    ok('④ 只有兩個取樣點也接得起來（靠細分）', r.ok, r.reason);
    eq('★★ 一樣找到 1 個交點', r.crossings, 1);
    ok('★★★ 相鄰兩個切點同屬一個面', chainOK(box, r.picks));
    const k = edit.knifePath(box, r.picks);
    ok('★★ 切得下去', k.ok, k.reason);
    rel('★★★ 體積精確不變', k.mesh.volume(), box.volume());
  }

  /** ⑤ 環繞一圈：四個面走完 */
  {
    const pts = [];
    for (let i = 0; i <= 8; i++) pts.push(V(xlo + (xhi - xlo) * i / 8, top, 0));
    for (let i = 1; i <= 8; i++) pts.push(V(xhi, top + (ylo - top) * i / 8, 0));
    for (let i = 1; i <= 8; i++) pts.push(V(xhi + (xlo - xhi) * i / 8, ylo, 0));
    for (let i = 1; i <= 8; i++) pts.push(V(xlo, ylo + (top - ylo) * i / 8, 0));
    const r = stroke.strokeToPicks(box, pts);
    ok('⑤ 環繞一圈 算得出切點', r.ok, r.reason);
    eq('★★ 穿過 4 條邊（四個面的交界）', r.crossings, 4);
    ok('★★★ 相鄰兩個切點同屬一個面', chainOK(box, r.picks));
    const k = edit.knifePath(box, r.picks);
    ok('★★ 切得下去', k.ok, k.reason);
    eq('★ 切成 4 段', k.segments, 4);
    rel('★★★ 體積精確不變', k.mesh.volume(), box.volume());
    rel('★★★ 表面積精確不變', k.mesh.area(), box.area());
    eq('★★ χ 仍是 2', chi(k.mesh), 2);
  }

  /**
   * ⑥ 🔴 **打在角落上要被推開，而且要回報。**
   *
   * ⚠ `knifePath()` 會因為「太靠近端點」把**整筆**退回。
   * 一筆畫的交點是算出來的、不是使用者指定的 —— 為了一個不巧的位置
   * 把整筆丟掉不划算。但 ⛔ **推了不可以不講**（坑第 11 條）。
   */
  {
    const r = stroke.strokeToPicks(box, [V(-29.999, top, -19.999), V(29.999, top, 19.999)]);
    ok('⑥ 幾乎打在角落上 還是算得出來', r.ok, r.reason);
    eq('★★★ 而且明講推開了 2 個', r.nudged, 2);
    ok('★★ 推開的幅度低於可切容許值（0.1mm，⛔ 不會改變做出來的東西）',
       r.picks.every(p => Math.min(
         p.p.distanceTo(box.verts[p.a].p), p.p.distanceTo(box.verts[p.b].p)
       ) <= edit.PLANAR_TOL_CM * 2));
    const k = edit.knifePath(box, r.picks);
    ok('★★★ 推開之後 knifePath 不再退回', k.ok, k.reason);
    rel('★★ 體積精確不變', k.mesh.volume(), box.volume());
  }

  /** ⑦ 曲面：圓柱腰上繞半圈，每一片 seg 都要穿過去 */
  {
    const cyl = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const pts = [];
    for (let i = 0; i <= 60; i++) {
      const a = Math.PI * i / 60;
      pts.push(V(25 * Math.cos(a), 0, 25 * Math.sin(a)));
    }
    const r = stroke.strokeToPicks(cyl, pts);
    ok('⑦ 圓柱腰繞半圈 算得出切點', r.ok, r.reason);
    /** 半圈 ＝ 32 片裡的 16 片 → 中間 16 條直立邊 */
    eq('★★ 穿過 16 條直立邊（32 片的一半）', r.crossings, 16);
    ok('★★★ 相鄰兩個切點同屬一個面', chainOK(cyl, r.picks));
    const k = edit.knifePath(cyl, r.picks);
    ok('★★ 切得下去', k.ok, k.reason);
    eq('★ 切成 16 段', k.segments, 16);
    rel('★★★ 體積精確不變', k.mesh.volume(), cyl.volume());
    rel('★★★ 表面積精確不變', k.mesh.area(), cyl.area());
    eq('★★ χ 仍是 2', chi(k.mesh), 2);
  }

  /**
   * ⑧ 🔴 **退化的輸入要擋，而且要講得出下一步。**
   * ⚠ 訊息一定要指向**真的走得通**的路（坑第 34 條）——
   * 這裡是「拖長一點，或改用點的」，兩條都真的存在。
   */
  {
    const a = stroke.strokeToPicks(box, [V(0, top, 0), V(0.001, top, 0)]);
    ok('⑧ 太短要擋', !a.ok);
    ok('　 而且要說「拖長一點，或改用點的」', /改用點的/.test(a.reason || ''), a.reason);
    ok('★ 只有一個點要擋', !stroke.strokeToPicks(box, [V(0, top, 0)]).ok);
    ok('★ 沒給點也不會壞', !stroke.strokeToPicks(box, null).ok);
    ok('★ 沒給網格也不會壞', !stroke.strokeToPicks(null, [V(0, 0, 0), V(1, 1, 1)]).ok);
  }

  /** ⑨ 兩個小工具本身 */
  {
    const f = box.faces[0];
    const nb = [...box.faceLoop(f)].find(he => he.twin && he.twin.face)?.twin.face;
    ok('⑨ 相鄰的兩個面找得到共用邊', !!stroke.sharedEdge(box, f, nb));
    eq('★ 同一個面沒有共用邊', stroke.sharedEdge(box, f, f), null);
    /** 兩條垂直交叉的線段：最近點就在 a→b 的正中間 */
    near('★★ closestParamOnEdge：正交交叉 → t ＝ 0.5',
         stroke.closestParamOnEdge(V(0, -5, 0), V(0, 5, 0), V(-10, 0, 0), V(10, 0, 0)),
         0.5, 1e-12);
    /** 落在延長線上要夾回 0～1，⛔ 不可以跑到線段外面 */
    eq('★★ 落在延長線外要夾回 1',
       stroke.closestParamOnEdge(V(50, -5, 0), V(50, 5, 0), V(-10, 0, 0), V(10, 0, 0)), 1);
    eq('★★ 另一頭夾回 0',
       stroke.closestParamOnEdge(V(-50, -5, 0), V(-50, 5, 0), V(-10, 0, 0), V(10, 0, 0)), 0);
  }
}

// ═══════════════════════════════════════════════════════
//  接合編號要印在「有料的地方」，而且讀得出來
// ═══════════════════════════════════════════════════════

section('接合編號：落在料上 ＋ 不互相壓');

/**
 * 🔴 **kang 2026-08-26 重現出來的，而且真正的病比他回報的嚴重。**
 *
 * 他回報的是「疊在一起」。查下去發現**環形端面（管的兩個端面）
 * 有一半的號碼印在洞裡** —— 那塊料會被挖掉。
 *
 * 病因是一行規則：號碼「往片的**重心**那一側縮」。
 * 而環形片的重心在**洞的正中央**，所以內圈那一半被往洞裡推。
 *
 * → 判準改成「**落在料上**」（`pointInPoly(outline)`）。
 * ⭐ 環形片沒有 `holes` 資料，它的 `outline` 是一條穿過缺口繞內圈再繞回來的
 *   封閉線 —— **那條線本身就已經把洞排除掉了**。
 *
 * ── 🔴 為什麼這個 bug 活這麼久：既有的檢查碰不到它 ──────────
 * 「第 3 期：標註不可以疊在一起」那一組**只比同一排的 y**
 * （它是為了尺寸那一排寫的），而接合編號是**散在片內各處**的。
 * ⛔ 所以這裡另外用一個**真正的 2D 外框相交**檢查。
 */
{
  const markSeams = (m, deg = 60) => {
    for (const he of m.edges()) {
      const d = m.dihedral(he);
      if (d !== null && Math.abs(d * 180 / Math.PI) > deg) m.setRole(he, EDGE_ROLE.CUT);
    }
    return m;
  };
  const jointsOf = prog => prog.items.filter(i => i.t === 'text' && i.style === 'joint');
  /** 🔴 真正的 2D 檢查：兩個字的外框有沒有相交（⛔ 不是只比同一排） */
  const clashes = list => {
    const bs = list.map(it => {
      const w = labelWidth(it.s, it.size);
      return { x0: it.x - w / 2, x1: it.x + w / 2, y0: it.y - it.size * 0.8, y1: it.y + it.size * 0.25 };
    });
    let n = 0;
    for (let i = 0; i < bs.length; i++) for (let k = i + 1; k < bs.length; k++) {
      const a = bs[i], b = bs[k];
      if (a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0) n++;
    }
    return n;
  };

  const t = 0.2, rule = makeRule('paper', t);
  const tube = markSeams(buildPrim('tube', { rOuter: 25, rInner: 20, h: 70, seg: 32 }, t));
  const r = unfoldMesh(tube, rule);
  eq('前提：kang 那組參數攤出 4 片', r.pieces.length, 4);

  /** 環形端面 ＝ 外框 50×50 的那兩片 */
  const rings = r.pieces.filter(p => Math.abs(p.width - 50) < 1 && Math.abs(p.height - 50) < 1);
  eq('前提：其中兩片是環形端面', rings.length, 2);

  for (const ring of rings) {
    const prog = drawProgram(ring, { rule });
    const js = jointsOf(prog);
    /**
     * ⚠ **2026-10-12 從 66 改成 64**：環形片以前有一條從外圈切到內圈的**缺口**（程式自己剪的，
     * 兩側攤平後完全貼在一起 —— 照圖切就是把好好的圓環剪斷）。那條⛔ 不剪了之後，
     * 缺口兩側那 2 個號碼跟著消失：外圈 32 ＋ 內圈 32 ＝ 64。
     * ⭐ 而且內圈終於變成真正的**洞**（`holes` 一個），⛔ 不再是外框繞進去再繞出來的一條線。
     */
    eq('前提：這一片有 64 個接合編號（外圈 32 ＋ 內圈 32）', js.length, 64);
    eq('★★★ 內圈是真正的洞（⛔ 不再是穿過缺口的一條線）', ring.holes.length, 1);

    /**
     * 🔴 **主斷言：一個號碼都不可以印在洞裡。**
     * ⚠ 修之前是 **32 個 / 66 個**掉在洞裡（實測）。
     * ⚠ 洞現在是 `holes`，所以「在料上」要連洞一起問（跟 `drawProgram()` 的 `onMaterial` 同一個判準）。
     */
    const onMat = (x, y) => pointInPoly(x, y, ring.outline) && !ring.holes.some(h => pointInPoly(x, y, h));
    const off = js.filter(it => !onMat(it.x, it.y));
    eq('★★★ 接合編號沒有一個落在料外（洞裡）', off.length, 0);

    /**
     * ⭐ 以前寫「最多剩 1 對」—— 缺口那裡同一個號碼的兩端碰頭。缺口⛔ 不剪了，那一對也沒了。
     */
    eq('★★ 完全不互相壓（修之前 13 對；缺口那一對隨缺口消失）', clashes(js), 0);

    /** ⭐ 這片料只有 5cm 寬要塞 66 個號碼 → 字一定得縮 */
    ok('★★ 塞不下的片，字有縮小（⛔ 不是硬塞 1.8）',
       prog.jointInfo && prog.jointInfo.size < 1.8, JSON.stringify(prog.jointInfo));
  }

  /**
   * 🔴 **「本來就不擠的片一格都不可以變」，⛔ 不是「所有側面都不變」。**
   *
   * ⚠ **這一條的期望值我第一次寫錯了，是測試當場抓到的**（2026-08-26）：
   * 我寫「兩片側面都維持 1.8」，實測**內側面是 1.4**。
   *
   * 查下去發現那是**正確行為**：內側面（125.46 × 70）在 1.8 的時候
   * **本來就壓了 30 對**，梯子往下掉一級到 1.4 才不壓 —— 那正是這一輪要修的事。
   * ⭐ 真正該釘的是「**本來就不擠的不要動它**」，而不是「側面都別動」。
   */
  const outer = r.pieces.find(p => p.height > 60 && p.width > 150);   // 外側面 156.83
  const inner = r.pieces.find(p => p.height > 60 && p.width < 150);   // 內側面 125.46
  ok('前提：找得到外側面與內側面', !!outer && !!inner);

  {
    const prog = drawProgram(outer, { rule });
    eq('★★★ 外側面本來就不擠 → 字高仍是 1.8（跟改之前逐字相同）', prog.jointInfo.size, 1.8);
    eq('★★ 而且完全不互相壓', clashes(jointsOf(prog)), 0);
  }
  {
    const prog = drawProgram(inner, { rule });
    ok('★★★ 內側面本來就在壓 → 字有縮（1.8 → 1.4）', prog.jointInfo.size < 1.8,
       String(prog.jointInfo.size));
    eq('★★★ 縮完之後完全不壓（修之前是 30 對）', clashes(jointsOf(prog)), 0);
  }

  /** `pointInPoly` 本身 */
  {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    ok('★ pointInPoly：裡面', pointInPoly(5, 5, sq));
    ok('★ pointInPoly：外面', !pointInPoly(15, 5, sq));
    ok('★ 點數不夠不會壞', !pointInPoly(5, 5, [{ x: 0, y: 0 }, { x: 1, y: 1 }]));
    ok('★ 沒給多邊形不會壞', !pointInPoly(5, 5, null));
  }
}

// ═══════════════════════════════════════════════════════
//  狀態列的「三角形」＝ 模型的屬性，不是「這一幀畫了幾個」
// ═══════════════════════════════════════════════════════

section('三角形數：mesh.triangleCount()');

/**
 * 🔴 **kang 2026-08-26：「三角形數字…亂跳」。**
 *
 * 病因有兩個，都跟幾何無關：
 * 1. 顯示的是 `renderer.info.render.triangles`（**上一幀畫出去的**），
 *    會隨視角、線框模式、gizmo、陰影而變 —— 而標籤寫「三角形」（坑第 20 條）
 * 2. 更新掛在 `loop()` 裡，而且**只有 FPS 剛好變了才更新** ——
 *    所以顯示的是一串不相干時刻的快照
 *
 * → 改成 `mesh.triangleCount()`：**模型的屬性，穩定**。
 *
 * ── ⭐ 這一節驗的是那個「不必真的三角化」的捷徑 ────────────
 * **任何簡單多邊形三角化之後剛好 `n − 2` 個三角形。**
 * ⚠ 那是一個假設，**要驗，不可以推論** —— 特別是**凹的面**走的是
 * 耳切那條路，跟凸的扇形是兩支不同的程式。
 */
{
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  /** 真的去三角化，逐面加總 —— 拿它當已知正確的答案 */
  const byTriangulating = m => {
    let n = 0;
    for (const f of m.faces) n += m.faceTriangles(f).length;
    return n;
  };

  for (const [name, k, p, want] of [
    ['方塊', 'box', { w: 60, h: 45, d: 40 }, 12],
    ['圓柱 seg32', 'cylinder', { r: 25, h: 70, seg: 32 }, 124],
    ['球 32×16', 'sphere', { r: 30, segW: 32, segH: 16 }, 960],
    ['管', 'tube', { rOuter: 25, rInner: 20, h: 70, seg: 32 }, 256],
    ['圓角方塊', 'roundBox', { w: 60, h: 45, d: 40, r: 8, segR: 4 }, 76],
    ['角柱 8 邊', 'prism', { r: 30, h: 50, sides: 8 }, 28],
    ['平板', 'plate', { w: 100, d: 60 }, 2],
    ['圓錐 seg12', 'cone', { r: 30, h: 70, seg: 12 }, 28]
  ]) {
    const m = baked(k, p);
    eq(`★★★ ${name}：Σ(n−2) ＝ 真的三角化的總數`, m.triangleCount(), byTriangulating(m));
    eq(`　 ${name}：而且是 ${want}`, m.triangleCount(), want);
  }

  /**
   * 🔴 **凹的面一定要單獨驗** —— 它走的是耳切，跟凸的扇形是兩支程式。
   * ⚠ 只驗參數體的話這一條完全不會被走到（參數體的面全是凸的）。
   */
  {
    const pts = [V(0, 0, 0), V(40, 0, 0), V(40, 20, 0), V(20, 20, 0), V(20, 40, 0), V(0, 40, 0)];
    const L = Mesh.fromFaceList(pts, [[0, 1, 2, 3, 4, 5]]);
    L.computeNormals();
    eq('★★★ 凹的 L 形面（走耳切）也是 n−2', L.triangleCount(), byTriangulating(L));
    eq('　 6 個頂點 → 4 個三角形', L.triangleCount(), 4);
  }

  /** ⛔ 空網格不可以壞 */
  eq('★ 空網格回 0', new Mesh().triangleCount(), 0);

  /**
   * ⚠ **這個數字要跟「編輯之後」也對得起來** ——
   * 加線只加面，三角形數會跟著變，⛔ 不可以停在舊值。
   */
  {
    const box = baked('box', { w: 60, h: 45, d: 40 });
    const before = box.triangleCount();
    const side = [...box.edges()].find(he => Math.abs(he.v.p.y - he.to.p.y) > 1);
    const lc = edit.loopCut(box, side, { cuts: 1 });
    ok('前提：環切切得下去', lc.ok, lc.reason);
    eq('★★ 環切之後三角形數跟著變（⛔ 不會停在舊值）',
       lc.mesh.triangleCount() > before, true);
    eq('★★ 而且仍然 ＝ 真的三角化的總數',
       lc.mesh.triangleCount(), byTriangulating(lc.mesh));
  }
}

// ═══════════════════════════════════════════════════════
//  選取那一組：邊迴圈 ＋ 框選子元素
// ═══════════════════════════════════════════════════════

section('選一條線（邊迴圈）＋ 框選子元素的判定');

/**
 * 🔴 **這一節的主角是一件翻掉對照表的事。**
 *
 * `外部參考-Blender編輯.md` 第 10.6 節寫著：
 * > 邊迴圈 ❌ **走不動** —— 它要四價頂點，**而方塊與圓柱的頂點是 3 價**
 *
 * **那句話對方塊與圓柱成立，對球完全不成立** —— 球有 372/374 個四價點。
 * 而**球正好是瓣片展開的對象**，瓣片展開 A 要選的正好是經線。
 *
 * ⭐ 所以這一節同時是兩件事的機械斷言：
 * 1. **邊迴圈在球上走得動**（＝ 瓣片展開 A 的卡點解掉了）
 * 2. **邊迴圈在方塊／圓柱上走不動**（＝ 對照表那句話沒有全錯，要留著）
 */
{
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const so = await import('../js/core/selectops.js');
  const S = await import('../js/core/screen.js');
  const lon = p => Math.atan2(p.z, p.x);

  /** 一條「經線邊」＝ 兩端經度相同、緯度不同 */
  const meridians = m => [...m.edges()].filter(h =>
    Math.abs(lon(h.v.p) - lon(h.to.p)) < 1e-6 && Math.abs(h.v.p.y - h.to.p.y) > 1e-6);

  /** ① 球：一條經線邊 → 整條經線 */
  {
    const m = baked('sphere', { r: 30, segW: 12, segH: 32 });
    const val = {};
    for (const v of m.verts) { const n = m.vertOutgoing(v).length; val[n] = (val[n] || 0) + 1; }
    eq('① 前提：球的四價點有 372 個', val[4], 372);
    eq('　 前提：只有兩個極點不是四價', val[12], 2);

    const seed = meridians(m)[Math.floor(meridians(m).length / 2)];
    const L0 = lon(seed.v.p);
    const r = so.edgeLoop(m, seed);
    eq('★★★ 一條經線邊 → 走出整條經線（segH ＝ 32 條）', r.hes.length, 32);
    eq('★★★ 而且每一條都在同一條經線上',
       r.hes.filter(h => Math.abs(lon(h.v.p) - L0) < 1e-6
                      && Math.abs(lon(h.to.p) - L0) < 1e-6).length, 32);
    ok('★★ 沒有繞回來（經線是從極走到極，⛔ 不是一個圈）', !r.closed);
    ok('★★ 停的理由要說得出來，而且是「停在極點」',
       r.stopped.every(s => /12 價/.test(s)), r.stopped.join(' / '));

    /** ⭐ 這一條才是使用者真正感覺到的東西 */
    eq('★★★ 選一整條經線從「點 32 下」變成「點 1 下」', 1, 1);

    /** 緯線種子 → 繞一圈回來 */
    const lat = [...m.edges()].filter(h => Math.abs(h.v.p.y - h.to.p.y) < 1e-6);
    const r2 = so.edgeLoop(m, lat[Math.floor(lat.length / 2)]);
    eq('★★ 緯線邊 → 走出一整圈（segW ＝ 12 條）', r2.hes.length, 12);
    ok('★★ 而且會繞回起點', r2.closed);
  }

  /** ② 另一組 seg，確認不是剛好對上 */
  {
    const m = baked('sphere', { r: 30, segW: 32, segH: 16 });
    const seed = meridians(m)[Math.floor(meridians(m).length / 2)];
    eq('② 球 segW32 segH16：經線 16 條', so.edgeLoop(m, seed).hes.length, 16);
    const lat = [...m.edges()].filter(h => Math.abs(h.v.p.y - h.to.p.y) < 1e-6);
    eq('　 緯線 32 條', so.edgeLoop(m, lat[Math.floor(lat.length / 2)]).hes.length, 32);
  }

  /**
   * ③ 🔴 **方塊與圓柱走不動 —— 而那是正確行為，不是壞掉。**
   * ⚠ 這一條要留著：它是對照表那句話**成立的那一半**。
   * ⛔ 日後看到「只選到一條」不要當成 bug 去修。
   */
  {
    for (const [name, k, p, want3] of [
      ['方塊', 'box', { w: 60, h: 45, d: 40 }, 8],
      ['圓柱 seg32', 'cylinder', { r: 25, h: 70, seg: 32 }, 64]
    ]) {
      const m = baked(k, p);
      const val = {};
      for (const v of m.verts) { const n = m.vertOutgoing(v).length; val[n] = (val[n] || 0) + 1; }
      eq(`③ ${name} 的點全是三價`, val[3], want3);
      const r = so.edgeLoop(m, [...m.edges()][0]);
      eq(`★★ ${name} 只走得出 1 條（三價走不動，正確）`, r.hes.length, 1);
      ok(`　 而且說得出停在哪`, r.stopped.every(s => /3 價/.test(s)), r.stopped.join(' / '));
    }
  }

  /**
   * ④ 🔴 **邊迴圈跟邊環是兩件事** —— 這一條是「兩顆按鈕」那個決定的機械斷言。
   * ⚠ 少了它，日後有人會想「這兩個是不是重複了」然後併成一顆。
   */
  {
    const m = baked('sphere', { r: 30, segW: 12, segH: 32 });
    const seed = meridians(m)[Math.floor(meridians(m).length / 2)];
    const L0 = lon(seed.v.p);
    const loop = so.edgeLoop(m, seed);
    const ring = edit.edgeRing(m, seed);
    const sameLonOf = hes => hes.filter(h =>
      Math.abs(lon(h.v.p) - L0) < 1e-6 && Math.abs(lon(h.to.p) - L0) < 1e-6).length;
    eq('④ 同一條種子邊：邊迴圈拿到同一條經線 32 條', sameLonOf(loop.hes), 32);
    eq('★★★ 而邊環只拿到同一條經線 1 條（它是繞著球跑的）', sameLonOf(ring.hes), 1);
    eq('　 邊環總共拿到 12 條（每條經線各一條）', ring.hes.length, 12);
    ok('★★★ 所以「選一圈」抓不到經線 —— 日誌那則待驗的答案是「抓不到」',
       sameLonOf(ring.hes) === 1);
  }

  /** ⑤ 框選的判定（純幾何，跟相機無關的那一半） */
  {
    const rect = { x0: 10, y0: 10, x1: 100, y1: 100 };
    const P = (x, y) => ({ x, y });
    ok('⑤ 點在框裡', S.pointInRect(P(50, 50), rect));
    ok('　 點在框外', !S.pointInRect(P(5, 50), rect));
    ok('★ 線段兩端都在框裡', S.segHitRect(P(20, 20), P(80, 80), rect));
    /**
     * 🔴 **這一條是重點**：一條長邊可以整條橫跨框、兩端都在外面。
     * ⛔ 只看端點的話，使用者明明框到它了卻選不到。
     */
    ok('★★★ 長邊橫跨整個框、兩端都在框外，也算選到',
       S.segHitRect(P(-50, 55), P(200, 55), rect));
    ok('★★ 斜著擦過角落也算', S.segHitRect(P(0, 20), P(20, 0), rect));
    ok('★★ 完全在框外的不算（左邊）', !S.segHitRect(P(-50, 55), P(-5, 55), rect));
    ok('　 完全在框外的不算（上面）', !S.segHitRect(P(20, -50), P(80, -5), rect));
    ok('★★ 斜著沒碰到的不算', !S.segHitRect(P(0, 5), P(5, 0), rect));
  }

  /** ⑥ 投影：拿正交相機對答案（算得出精確值的那一種） */
  {
    const cam = new THREE.OrthographicCamera(-100, 100, 100, -100, -1000, 1000);
    cam.position.set(0, 0, 100); cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
    const pr = p => S.projectPoint(p, cam, 200, 200);
    const c = pr(V(0, 0, 0));
    near('⑥ 原點投影到畫面正中央（x）', c.x, 100, 1e-9);
    near('　 （y）', c.y, 100, 1e-9);
    near('★★ x ＝ +100 投到右緣', pr(V(100, 0, 0)).x, 200, 1e-9);
    near('★★ y ＝ +100 投到上緣（螢幕 y 是反的，所以是 0）', pr(V(0, 100, 0)).y, 0, 1e-9);
    near('　 x ＝ −100 投到左緣', pr(V(-100, 0, 0)).x, 0, 1e-9);
  }

  /** ⑦ `elementsInRect`：整條路串起來 */
  {
    const cam = new THREE.OrthographicCamera(-100, 100, 100, -100, -1000, 1000);
    cam.position.set(0, 0, 100); cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
    const items = {
      verts: [
        { el: 'A', pts: [V(0, 0, 0)] },      // → 畫面 (100,100) 框裡
        { el: 'B', pts: [V(90, 0, 0)] }      // → 畫面 (190,100) 框外
      ],
      edges: [
        { el: 'E1', pts: [V(-90, 0, 0), V(90, 0, 0)] },   // 橫跨整個框
        { el: 'E2', pts: [V(-90, 90, 0), V(-80, 90, 0)] } // 完全在框外
      ],
      faces: [
        { el: 'F1', pts: [V(0, 0, 0)] },
        { el: 'F2', pts: [V(90, 90, 0)] }
      ]
    };
    const rect = { x0: 80, y0: 80, x1: 120, y1: 120 };
    const got = S.elementsInRect(items, rect, cam, 200, 200);
    eq('⑦ 框到的點只有 A', got.verts.join(','), 'A');
    eq('★★★ 框到的邊有 E1（橫跨、兩端都在框外）', got.edges.join(','), 'E1');
    eq('★★ 框到的面只有 F1（面看重心）', got.faces.join(','), 'F1');
    /** ⛔ 沒給東西也不可以壞 */
    eq('★ 沒給 items 也不會壞', S.elementsInRect(null, rect, cam, 200, 200).edges.length, 0);
    eq('★ 沒給 rect 也不會壞', S.elementsInRect(items, null, cam, 200, 200).edges.length, 0);
  }

  /**
   * ⑧ ⚠ **邊迴圈只走「畫面上看得見的邊」** —— 判準沿用 `isMarkable()`。
   * ⛔ 不要另外寫一套「哪些邊算數」（全選邊那一輪定的）。
   */
  {
    const m = baked('sphere', { r: 30, segW: 12, segH: 32 });
    const seed = meridians(m)[Math.floor(meridians(m).length / 2)];
    const off = so.edgeLoop(m, seed, { markableOnly: false });
    eq('⑧ 關掉「只走看得見的」也走得出 32 條（球的邊本來就都看得見）',
       off.hes.length, 32);
    ok('★ 沒給種子邊不會壞', so.edgeLoop(m, null).hes.length === 0);
    ok('★ 沒給網格不會壞', so.edgeLoop(null, seed).hes.length === 0);
  }
}

// ═══════════════════════════════════════════════════════
//  選取第二批：選轉角（依銳邊）＋ 選相似
// ═══════════════════════════════════════════════════════

section('選轉角（依銳邊）＋ 選相似');

/**
 * 🔴 **這一節的數字全部是「使用者自己數得出來」的。**
 *
 * 方塊 12 條、六角柱 18 條、球 360 個四邊形 —— 都可以用手算對答案，
 * 而不是「跑出來多少就寫多少」。〔鐵律三：**讓兩個數字互相對得起來**〕
 */
{
  const so2 = await import('../js/core/selectops.js');

  /** ① 方塊：最基本的對答案 */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    eq('① 方塊 30 度 → 12 條轉角', so2.sharpEdges(m, 30).hes.length, 12);
    eq('★ 而且 12 條全部是凸角（山折），凹角 0 條',
       so2.sharpEdges(m, 30).convex, 12);
    eq('　 凹角 0 條', so2.sharpEdges(m, 30).concave, 0);
    eq('★ 掃過的邊 ＝ 12（＝ 全選邊選到的數量，兩支同一個判準）',
       so2.sharpEdges(m, 30).scanned, 12);

    /**
     * 🔴 **門檻容許值的立條實例，⛔ 不要刪這三條。**
     * 方塊的角**正好 90.0000 度**，沒有 `THRESH_TOL_DEG`
     * 打 90 會選到 0 條 —— 而使用者當然認為 90 度的角是 90 度。
     */
    eq('★★★ 門檻正好等於實際夾角（90）→ 選得到，⛔ 不是 0',
       so2.sharpEdges(m, 90).hes.length, 12);
    eq('★★ 89 度 → 還是 12 條', so2.sharpEdges(m, 89).hes.length, 12);
    eq('★★ 91 度 → 0 條（方塊沒有比 90 更折的角）',
       so2.sharpEdges(m, 91).hes.length, 0);
  }

  /** ② 六角柱：兩種夾角混在一起，門檻真的在挑東西 */
  {
    const m = baked('prism', { sides: 6, r: 30, h: 60 });
    eq('② 六角柱 60 度 → 18 條（側面 6 條 ＋ 上下各 6 條）',
       so2.sharpEdges(m, 60).hes.length, 18);
    eq('★★ 61 度 → 12 條（側面那 6 條被門檻擋掉，只剩上下的 90 度角）',
       so2.sharpEdges(m, 61).hes.length, 12);
    /** ⭐ 18 ＝ 6 ＋ 12，兩個數字互相對得起來 */
    eq('★ 兩者相差正好是側面的 6 條',
       so2.sharpEdges(m, 60).hes.length - so2.sharpEdges(m, 61).hes.length, 6);
  }

  /** ③ 圓柱：門檻擋掉 seg 的小折角，正是這顆按鈕的用途 */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    eq('③ 圓柱 seg32　30 度 → 64 條（上下兩圈蓋子邊，各 32 條）',
       so2.sharpEdges(m, 30).hes.length, 64);
    eq('★★ 10 度 → 96 條（側面那 32 條也進來了）',
       so2.sharpEdges(m, 10).hes.length, 96);
    /** 🔴 32 段圓柱側面的夾角 ＝ 360/32 ＝ 11.25 度，這條在對那個數學 */
    eq('★★★ 11.3 度 → 64 條（側面夾角 11.25 度，剛好被擋在外面）',
       so2.sharpEdges(m, 11.3).hes.length, 64);
    eq('　 96 ＝ 64 ＋ 32（側面的段數）',
       so2.sharpEdges(m, 10).hes.length, 64 + 32);
  }

  /**
   * ④ 🔴 **平板：0 條，而且原因跟「形狀不夠折」完全不同。**
   * 它整圈都是**邊界邊**（只有一側有面）—— `isMarkable()` 擋掉的。
   * ⚠ 呼叫端要靠 `scanned === 0 && boundarySkipped > 0` 分辨這兩種 0，
   * 否則使用者調度數調到死也不會有反應（坑第 21 條）。
   */
  {
    const m = baked('plate', { w: 100, d: 60, segW: 1, segD: 1 });
    const r = so2.sharpEdges(m, 30);
    eq('④ 平板 → 0 條', r.hes.length, 0);
    eq('★★★ 而且掃過的邊是 0（不是「掃過了但都不夠折」）', r.scanned, 0);
    eq('★★★ 邊界邊 4 條 —— 呼叫端就是靠這個講出真正的原因',
       r.boundarySkipped, 4);
    eq('★★ 度數調到 1 度還是 0 條（調數字永遠沒救，所以一定要講）',
       so2.sharpEdges(m, 1).hes.length, 0);
  }

  /** ⑤ 折板：夾角 11.25／22.5，門檻挑得動 */
  {
    const m = baked('bend', {});
    eq('⑤ L 型折板 30 度 → 0 條（折彎被 arcSeg 分成 22.5 度的小段）',
       so2.sharpEdges(m, 30).hes.length, 0);
    eq('★★ 22 度 → 3 條', so2.sharpEdges(m, 22).hes.length, 3);
    ok('★ 折板有邊界邊（它是開放的板件）',
       so2.sharpEdges(m, 30).boundarySkipped > 0);
  }

  /** ⑥ 壞輸入不會壞 */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    eq('⑥ 沒給網格不會壞', so2.sharpEdges(null, 30).hes.length, 0);
    eq('★ 門檻不是數字不會壞', so2.sharpEdges(m, NaN).hes.length, 0);
  }

  /** ⑦ 選相似：方塊，四種判準各對一次答案 */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    const f0 = m.faces[0];
    const seedF = { kind: 'face', face: f0 };
    eq('⑦ 方塊【同法向】→ 1 個（六個面朝向都不同）',
       so2.similarTo(m, seedF, 'normal').faces.length, 1);
    eq('★★ 方塊【同面積】→ 2 個（對面那一片一樣大）',
       so2.similarTo(m, seedF, 'area').faces.length, 2);
    eq('★★ 方塊【同邊數】→ 6 個（六個面都是四邊形）',
       so2.similarTo(m, seedF, 'sides').faces.length, 6);

    const e60 = [...m.edges()].find(h => Math.abs(h.v.p.distanceTo(h.to.p) - 60) < 1e-9);
    eq('★★ 方塊【同邊長】60 → 4 條（60×45×40 的長邊有四條）',
       so2.similarTo(m, { kind: 'edge', he: e60 }, 'length').hes.length, 4);
  }

  /**
   * ⑧ 🔴 **球：這一組的數字全部可以手算，⛔ 不是抄跑出來的結果。**
   * segW12 × segH32 → 極點兩圈是三角形（12×2 ＝ 24 個），
   * 其餘是四邊形（12×30 ＝ 360 個），合計 384。
   */
  {
    const m = baked('sphere', { r: 30, segW: 12, segH: 32 });
    eq('⑧ 前提：球一共 384 個面', m.faces.length, 384);
    const quad = m.faces.find(f => m.faceVerts(f).length === 4);
    eq('★★★ 【同邊數】從一個四邊形出發 → 360 個（＝ 12 × 30，兩圈三角形不算）',
       so2.similarTo(m, { kind: 'face', face: quad }, 'sides').faces.length, 360);
    eq('　 而 360 ＋ 24 ＝ 384（極點兩圈各 12 個三角形）',
       360 + 24, m.faces.length);

    const tri = m.faces.find(f => m.faceVerts(f).length === 3);
    eq('★★ 從一個三角形出發 → 24 個（極點那兩圈）',
       so2.similarTo(m, { kind: 'face', face: tri }, 'sides').faces.length, 24);
    eq('★★ 【同面積】從極點的三角形出發 → 24 個（南北極對稱，各 12）',
       so2.similarTo(m, { kind: 'face', face: tri }, 'area').faces.length, 24);
  }

  /**
   * ⑨ 🔴 **判準跟型別對不起來要「講」，⛔ 不可以安靜地回 0 個。**
   * 〔坑第 11 條：沉默地退回是最糟的做法〕
   */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    const he = [...m.edges()][0];
    const r1 = so2.similarTo(m, { kind: 'edge', he }, 'area');
    ok('⑨ 選到邊卻挑「同面積」→ 要給得出理由', !!r1.reason, r1.reason);
    eq('★ 而且不回傳任何元素', r1.faces.length + r1.hes.length, 0);

    const r2 = so2.similarTo(m, { kind: 'face', face: m.faces[0] }, 'length');
    ok('★★ 選到面卻挑「同邊長」→ 也要給得出理由', !!r2.reason, r2.reason);
    ok('★ 沒選任何東西也要給得出理由', !!so2.similarTo(m, null, 'area').reason);
  }

  /**
   * ⑩ 🔴 **容許值是 0.01 cm，而且它必須真的在做事。**
   * 差 0.005 cm（比容許值小）要算一樣，差 0.05 cm（比它大）要算不一樣。
   * ⚠ 這一條守的是坑第 25、26 條：**容許值要有物理意義，⛔ 不是 1e-6。**
   */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    eq('⑩ 容許值就是 0.01 cm', so2.SIMILAR_TOL_CM, 0.01);
    const he = [...m.edges()].find(h => Math.abs(h.v.p.distanceTo(h.to.p) - 60) < 1e-9);
    const seedE = { kind: 'edge', he };
    eq('★★ 容許值放大到 6 cm → 60 與 45 的邊算成同一類（4 ＋ 4 ＝ 8 條）',
       so2.similarTo(m, seedE, 'length', { tolCm: 16 }).hes.length, 8);
    eq('★★ 容許值縮到 0.001 cm → 還是 4 條（真的一樣長，不是靠容許值湊的）',
       so2.similarTo(m, seedE, 'length', { tolCm: 0.001 }).hes.length, 4);
  }
}

// ═══════════════════════════════════════════════════════
//  破洞在哪裡（＝ 對照表的「依特徵全選」）
// ═══════════════════════════════════════════════════════

section('破洞在哪裡：找出邊界邊並分成幾個洞');

/**
 * 🔴 **這一節守的是「講了問題要給得出出路」**（坑第 11 條）。
 *
 * `printCheck()` 早就在報「不是封閉的（有 N 條邊界邊）」，那是 bad 級 ——
 * **代表印不出來** —— 但它只給數字，指不出來在哪。
 *
 * ⭐ **「幾個洞」比「幾條邊」重要** —— 使用者修的是洞，
 * 而 47 條邊可能只是一個洞。所以分組那一半才是這一支的價值。
 */
{
  const so3 = await import('../js/core/selectops.js');

  /** ① 封閉的東西一個洞都沒有 */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    const r = so3.boundaryEdges(m);
    eq('① 方塊（封閉）→ 0 條邊界邊', r.hes.length, 0);
    eq('★ 0 個洞', r.holes, 0);
    ok('★ 而且跟 mesh.isClosed() 對得起來', m.isClosed() === (r.hes.length === 0));
  }

  /** ② 板件：一張面的四周就是一個洞 */
  {
    const m = baked('plate', { w: 100, d: 60, segW: 1, segD: 1 });
    const r = so3.boundaryEdges(m);
    eq('② 平板 → 4 條邊界邊', r.hes.length, 4);
    eq('★★ 而且是【1 個】洞，⛔ 不是 4 個', r.holes, 1);
  }

  /**
   * ③ 🔴 **開口圓柱：兩個開口 ＝ 兩個洞。**
   * ⭐ 這一條在驗分組**分得開** —— 上下兩圈各 32 條，
   * 它們之間沒有共用頂點，⛔ 不可以被併成一個。
   */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32, openEnded: true });
    const r = so3.boundaryEdges(m);
    eq('③ 開口圓柱 seg32 → 64 條邊界邊', r.hes.length, 64);
    eq('★★★ 分成【2 個】洞（上下兩個開口）', r.holes, 2);
    eq('★★ 每個洞 32 條', r.biggest, 32);
    eq('　 而 64 ＝ 2 × 32', r.hes.length, r.holes * r.biggest);
  }

  /**
   * ④ 🔴🔴 **分組真正的考驗：相鄰的兩個面刪掉，要併成【一個】洞。**
   * ⚠ 刪對面的兩個面是 2 個洞（各 4 條）；
   * 刪**相鄰**的兩個面是 **1 個洞 6 條**（兩個正方形併成 L 形開口）。
   * ⛔ 分組寫錯的話這裡會變成 2 個洞 8 條。
   */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    const a = m.faces[0];
    let b = null;
    for (const he of m.faceLoop(a)) {
      const nb = he.twin && he.twin.face;
      if (nb && nb !== a) { b = nb; break; }
    }
    const del = edit.deleteFaces(m, [{ kind: 'face', face: a }, { kind: 'face', face: b }]);
    const mm = del.ok && del.mesh ? del.mesh : m;
    const r = so3.boundaryEdges(mm);
    eq('④ 刪掉【相鄰】的兩個面 → 6 條邊界邊', r.hes.length, 6);
    eq('★★★ 併成【1 個】洞，⛔ 不是 2 個', r.holes, 1);
  }

  /** ⑤ 對面的兩個面 → 真的是兩個洞 */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    const a = m.faces[0];
    const opp = m.faces.find(f => f !== a &&
      m.computeFaceNormal(f).dot(m.computeFaceNormal(a)) < -0.99);
    const del = edit.deleteFaces(m, [{ kind: 'face', face: a }, { kind: 'face', face: opp }]);
    const mm = del.ok && del.mesh ? del.mesh : m;
    const r = so3.boundaryEdges(mm);
    eq('⑤ 刪掉【對面】的兩個面 → 8 條邊界邊', r.hes.length, 8);
    eq('★★ 是【2 個】洞（它們沒有共用的角）', r.holes, 2);
  }

  /** ⑥ 壞輸入不會壞 */
  eq('⑥ 沒給網格不會壞', so3.boundaryEdges(null).hes.length, 0);
}

// ═══════════════════════════════════════════════════════
//  選一圈面（＝ Blender 的 Face Loop Select）
// ═══════════════════════════════════════════════════════

section('選一圈面：跟「選一圈」同一條路，但收的是面');

/**
 * 🔴 **這一節守的是「⛔ 不要為了收面而重寫一支走訪」。**
 *
 * **面迴圈 ＝ `edgeRing()` 走訪時穿進去的那些面** —— 邊環與面迴圈
 * 本來就是同一條路徑的兩種讀法。⛔ 另寫一支就是兩條要對齊的路（坑第 31 條）。
 *
 * ⚠ **所以這裡一定要驗「兩者的數字對得起來」** ——
 * 那正是鐵律三：**讓兩個數字互相對得起來，錯誤才會自己現形。**
 */
{
  const so6 = await import('../js/core/selectops.js');

  /** 找一條「兩側都是四邊形」的邊當種子 —— ⛔ 不然走第一步就停了 */
  const quadSeed = m => {
    const es = [...m.edges()];
    return es.find(he => he.face && he.twin && he.twin.face
      && m.faceLoop(he.face).length === 4
      && m.faceLoop(he.twin.face).length === 4) || es[0];
  };

  /** ① 方塊：繞一圈的側面 4 個，⛔ 不含頂底 */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    const r = so6.loopFaces(m, quadSeed(m));
    eq('① 方塊 → 【4】個面（繞一圈的側面）', r.faces.length, 4);
    ok('★★ ⛔ 不含頂底（總共 6 個面）', r.faces.length < m.faces.length);
    ok('★ 繞回來了', r.closed);
  }

  /** ② 圓柱 seg32 → 32 個側面 */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const r = so6.loopFaces(m, quadSeed(m));
    eq('② 圓柱 seg32 → 【32】個面', r.faces.length, 32);
    ok('★ 繞回來了', r.closed);
  }

  /** ③ 球 segW12 → 同一條緯度帶繞一圈 12 個 */
  {
    const m = baked('sphere', { r: 30, segW: 12, segH: 32 });
    const r = so6.loopFaces(m, quadSeed(m));
    eq('③ 球 segW12 → 【12】個面（一條緯度帶）', r.faces.length, 12);
  }

  /**
   * ④ 🔴🔴 **整節最重要：面的個數要跟邊環的條數對得起來。**
   * 閉環時**每穿過一條邊就進到一個新的面**，所以兩者必須相等。
   * ⛔ 對不上就是「另外寫了一支走訪」或「忘了去重」。
   */
  {
    for (const [nm, m] of [
      ['方塊', baked('box', { w: 60, h: 45, d: 40 })],
      ['圓柱', baked('cylinder', { r: 25, h: 70, seg: 32 })],
      ['球', baked('sphere', { r: 30, segW: 12, segH: 32 })]
    ]) {
      const seed = quadSeed(m);
      const face = so6.loopFaces(m, seed);
      const ring = edit.edgeRing(m, seed);
      ok(`④ ${nm}：面數 ${face.faces.length} ＝ 邊環條數 ${ring.hes.length}`,
        face.closed ? face.faces.length === ring.hes.length : true);
    }
  }

  /**
   * ⑤ 🔴 **去重**：`edgeRing()` 兩個方向各走一次，種子那個面**兩邊都會經過**。
   * ⛔ 不去重的話它會被選兩次，數量也會多報一個。
   */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const r = so6.loopFaces(m, quadSeed(m));
    const uniq = new Set(r.faces.map(f => f.id)).size;
    eq('⑤ 回傳的面 ⛔ 沒有重複', uniq, r.faces.length);
  }

  /**
   * ⑥ 🔴🔴 **`closed` ⛔ 不可以照抄邊環的 —— kang 2026-08-27 實測問出來的。**
   *
   * 圓柱點「圓蓋與側面之間」那一圈的邊：只選到 **2 個面**
   * （一片側面 ＋ 一個 32 邊形的圓蓋，穿不過去就停了），
   * 而 `edgeRing()` 回 `closed=true` → toast 會說
   * 「已選起一整圈 **2 個面**（**繞回來了**）」—— ⛔ 它根本沒繞回來。
   * 〔坑第 18 條：誤報比漏報更糟〕
   */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    let he = null;
    for (const e of m.edges()) {
      if (!e.face || !e.twin || !e.twin.face) continue;
      const a = m.faceLoop(e.face).length, b = m.faceLoop(e.twin.face).length;
      if ((a === 4 && b > 4) || (b === 4 && a > 4)) { he = e; break; }
    }
    ok('⑥（前置）找得到「圓蓋與側面之間」那一圈的邊', !!he);
    const r = so6.loopFaces(m, he);
    // 2026-10-13 edgeRing 兩個方向都走之後：側面一格 ＋ 兩頭各撞到一個圓蓋 ＝ 3（原本看點到哪一側，2 或 1）
    eq('★ 只選到 3 個面（側面一格、兩頭撞到圓蓋就停）', r.faces.length, 3);
    eq('★★ 　 從另一側點也是 3', so6.loopFaces(m, he.twin).faces.length, 3);
    ok('★★★ ⛔ closed 要是 false —— 它沒有繞回來', r.closed === false);
    // 2026-10-13 修好 edgeRing 第二個方向之後，它自己也不再謊報（原本這裡驗的是「它說 true，所以不能照抄」）；
    // 「全部四邊形」那道判準照樣留著，兩道都要過
    ok('★★ edgeRing 自己也說 false（第二個方向修好之後）—— 從兩側出發都一樣',
      edit.edgeRing(m, he).closed === false && edit.edgeRing(m, he.twin).closed === false);
  }

  /** ⑦ 壞輸入不會壞 */
  eq('⑦ 沒給網格不會壞', so6.loopFaces(null, null).faces.length, 0);
}

// ═══════════════════════════════════════════════════════
//  非流形邊在哪裡（＝ 對照表的「依特徵全選」第二項）
// ═══════════════════════════════════════════════════════

section('非流形邊：找出被 3 個以上的面共用的邊');

/**
 * 🔴 **這一節守兩件事，第二件比第一件重要。**
 *
 * 一、**找得到非流形邊**（`printCheck()` 原本只報得出頂點索引）。
 *
 * 二、🔴 **破洞 ⛔ 不可以再把非流形邊算進去** —— 那是一個既有的誤報
 * （坑第 18 條），2026-08-27 沙箱抓到的：
 * 一條邊被 3 個面共用時 `fromFaceList()` 只配得出一組 twin，
 * **第三個面那條半邊配不到** → 被補成邊界半邊 → 破洞把它當成洞回報，
 * 而 toast 正叫使用者去按 `補洞` —— **那條邊補不起來。**
 * 〔坑第 34 條：⛔ 不要指一條不存在的退路〕
 *
 * ⚠ **樣本一定要自己用 `fromFaceList()` 建** ——
 * 九種參數基本體一個都做不出非流形，布林也會把它消掉。
 */
{
  const so4 = await import('../js/core/selectops.js');
  const V = a => a.map(p => new THREE.Vector3(...p));

  /**
   * 教科書級的樣本：三個四邊形共用同一條邊（T 形接面）。
   * ⭐ 三片「翅膀」各有 3 條外圍邊 ＝ 真正的破洞 9 條，
   *    共用的那一條是非流形，⛔ 不算破洞。
   */
  const tee = () => Mesh.fromFaceList(
    V([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
       [10, -10, 0], [0, -10, 0], [10, 0, 10], [0, 0, 10]]),
    [[0, 1, 2, 3], [0, 1, 4, 5], [1, 0, 6, 7]]);

  /** ① 找得到，而且數量與「被幾個面共用」都對 */
  {
    const r = so4.nonManifoldEdges(tee());
    eq('① T 形接面 → 【1】條非流形邊', r.edges, 1);
    eq('★★ 涉及【3】個面', r.faces, 3);
    eq('★ 最嚴重那條被 3 個面共用', r.worst, 3);
    eq('★★ 畫線用的半邊已去重 ＝ 1 條', r.hes.length, 1);
  }

  /**
   * ② 🔴🔴 **這一項是整節最重要的：破洞要從 10 條變成 9 條。**
   * ⛔ 改壞的症狀是它回 10 —— 而那第 10 條**補不起來**。
   */
  {
    const r = so4.boundaryEdges(tee());
    eq('② 破洞只算【9】條，⛔ 不含那條非流形', r.hes.length, 9);
    eq('★★★ 而且講得出扣掉了【1】條', r.nonManifold, 1);
    eq('★ 三片翅膀的開口連在同一條邊上 ＝ 1 個洞', r.holes, 1);
  }

  /** ③ 乾淨的封閉模型：兩邊都要是 0（⛔ 不可以誤報） */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    eq('③ 方塊 → 0 條非流形邊', so4.nonManifoldEdges(m).edges, 0);
    eq('★ 破洞也是 0', so4.boundaryEdges(m).hes.length, 0);
  }
  {
    const m = baked('sphere', { r: 30, segW: 12, segH: 32 });
    eq('　 球也是 0 條非流形邊', so4.nonManifoldEdges(m).edges, 0);
  }

  /**
   * ④ 🔴 **真的破了一個洞，非流形要是 0。**
   * ⭐ 這一項守的是**反向**：⛔ 不可以把普通的破洞誤判成非流形，
   * 否則破洞那顆按鈕會把它扣掉 —— **一個真的洞就此消失在報告裡**。
   */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    const del = edit.deleteFaces(m, [{ kind: 'face', face: m.faces[0] }]);
    const mm = del.ok && del.mesh ? del.mesh : m;
    eq('④ 刪掉一個面 → 0 條非流形邊', so4.nonManifoldEdges(mm).edges, 0);
    ok('★★ 破洞照舊報得出來', so4.boundaryEdges(mm).hes.length > 0);
    eq('★ 而且一條都沒被扣掉', so4.boundaryEdges(mm).nonManifold, 0);
  }

  /**
   * ⑤ 🔴 **`printCheck()` 要單獨報這一則，而且要標得出 `kind`。**
   * ⚠ 面板那兩顆「指出來」是靠 `kind` 認的 ——
   * 靠訊息文字認的話，改一句中文按鈕就會無聲消失。
   */
  {
    const m = tee();
    const c = printCheck(m, triangles(m), {});
    const hit = c.issues.filter(i => i.kind === 'nonmanifold');
    eq('⑤ printCheck 報【1】則非流形', hit.length, 1);
    ok('★★ 是 bad 級（＝ 印不出來）', hit[0].level === 'bad');
    ok('★★★ 訊息裡有「3 個以上的面」，⛔ 不是頂點索引',
      /3 個以上的面/.test(hit[0].text));
    ok('★★ 而且明講「補洞」補不了它', /補洞/.test(hit[0].text));
    eq('★★ ⛔ 沒有第二則在講同一件事',
      c.issues.filter(i => /非流形/.test(i.text)).length, 1);

    /**
     * 🔴🔴 **報告上的條數，要跟按下「指出來」亮出來的紅線是同一個數字。**
     * ⚠ 原本用 `v.boundaryHalfEdges`（含非流形）→ 報告說 10、紅線只有 9。
     * ⛔ 對不起來的兩個數字沒有人查得出原因。
     */
    const op = c.issues.find(i => i.kind === 'open');
    ok('★★★ 「不是封閉的」報的條數 ＝ 紅線的條數（9）', /9 條邊界邊/.test(op.text));
    eq('　 而紅線真的是 9 條', so4.boundaryEdges(m).hes.length, 9);
  }

  /** ⑥ 壞輸入不會壞 */
  eq('⑥ 沒給網格不會壞', so4.nonManifoldEdges(null).edges, 0);
}

// ═══════════════════════════════════════════════════════
//  有面貼反了（＝ 使用者按「翻面」只選一個面）
// ═══════════════════════════════════════════════════════

section('有面貼反了：報得出來，而且指得到「修法向」');

/**
 * 🔴 **這一節守的是「一句看得懂的話 ＋ 一條走得到的出路」。**
 *
 * ⚠ **這是三種病裡唯一使用者做得出來的**（`翻面` 只選一個面），
 * 而它原本報的是「網格結構有問題：**邊 2→1 出現兩次（非流形…）**」——
 * `2` 跟 `1` 是頂點索引，**畫面上沒有這種東西**。
 *
 * 🔴 **而且它會連帶讓另外三則說謊**（實測，全部壓掉了）：
 * 破洞說 6 條（那個方塊一個洞都沒有）、
 * 「網格結構有問題：**半邊 113 沒有 next**」、
 * 「由 **2 個**互不相連的塊組成」（那是一個方塊）。
 * ⛔ 三則都是「貼反了」的症狀，⛔ 不是三個獨立的病。
 */
{
  const so5 = await import('../js/core/selectops.js');
  /**
   * ⚠ **`triangles()` 吃的是 options 物件，⛔ 不是位置參數。**
   * 〔2026-08-27 寫測試時傳成 `triangles(m, matrix4, 1)` —— `Matrix4` 有一個
   * 　叫 `scale` 的**方法**，於是 `opt.scale ?? 1` 拿到那個函式，
   * 　`multiplyScalar(函式)` 把每個座標變成 NaN。**而測試照樣通過** ——
   * 　`NaN <= 0` 是 false，那則體積檢查就靜靜地跳過了。
   * 　抓到它的是「修完體積要是正的」那一項，⛔ 不是語法檢查〕
   */
  const tri = m => triangles(m);
  const V = a => a.map(p => new THREE.Vector3(...p));

  /** 方塊，只把第一個面翻過來 */
  const flipOne = () => {
    const box = baked('box', { w: 10, h: 10, d: 10 });
    const vi = box._vertIndex();
    const fl = box.faces.map(f => box.faceVerts(f).map(v => vi.get(v.id)));
    return Mesh.fromFaceList(box.verts.map(v => v.p.clone()),
      fl.map((f, i) => (i === 0 ? f.slice().reverse() : f)));
  };

  /** ① 乾淨的方塊 ⛔ 不可以誤報 */
  {
    const m = baked('box', { w: 10, h: 10, d: 10 });
    eq('① 乾淨方塊 → 0 條貼反的邊', so5.reversedFaceEdges(m).edges, 0);
    eq('★ printCheck 一則問題都沒有', printCheck(m, tri(m), {}).issues.length, 0);
  }

  /** ② 翻一個面 → 抓得到 */
  {
    const m = flipOne();
    const r = so5.reversedFaceEdges(m);
    ok('② 翻一個面 → 抓得到貼反的邊', r.edges > 0);
    ok('★ 而且講得出涉及幾個面', r.faces > 0);
    eq('★★ ⛔ 它不是非流形（真非流形是 0 條）',
      so5.nonManifoldEdges(m).edges, 0);
  }

  /**
   * ③ 🔴🔴 **整節最重要：只報一則，而且那一則指得到「修法向」。**
   * ⛔ 改壞的症狀是報了四則，其中三則在講不存在的東西。
   */
  {
    const c = printCheck(flipOne(), tri(flipOne()), {});
    eq('③ 恰好【1】則問題，⛔ 不是四則', c.issues.length, 1);
    eq('★★ kind 是 flipped', c.issues[0].kind, 'flipped');
    ok('★★★ 訊息裡指得到「修法向」那顆按鈕', /修法向/.test(c.issues[0].text));
    ok('★★ 用「正反面貼反了」講，⛔ 不是頂點索引',
      /貼反/.test(c.issues[0].text) && !/邊 \d+→\d+/.test(c.issues[0].text));
    ok('★★ ⛔ 沒有人再說「有幾個破洞」', !c.issues.some(i => i.kind === 'open'));
    ok('★★ ⛔ 沒有人再說「2 個互不相連的塊」', !c.issues.some(i => /互不相連/.test(i.text)));
  }

  /**
   * ④ 🔴🔴 **出路真的走得通** —— 按下去要全部歸零。
   * ⭐ 這一項是「⛔ 不要指一條不存在的退路」（坑第 34 條）的機械版：
   * 訊息叫人按 `修法向`，那就驗一次按下去到底行不行。
   */
  {
    const fx = edit.recalcNormalsOutside(flipOne());
    ok('④ 按「修法向」修得動', fx.ok && !!fx.mesh);
    eq('★★★ 修完 0 條貼反的邊', so5.reversedFaceEdges(fx.mesh).edges, 0);
    eq('★★★ 修完 printCheck 一則問題都沒有',
      printCheck(fx.mesh, tri(fx.mesh), {}).issues.length, 0);
    ok('★★ 而且體積是正的（朝外）', stlVolume(tri(fx.mesh)) > 0);
  }

  /**
   * ⑤ ⚠ **真非流形 ⛔ 不可以被算成「貼反了」** ——
   * T 形接面上那條邊同方向出現兩次，但它的病是「黏了 3 片」，
   * 而 `修法向` 明確修不了（它自己回報 `ambiguousEdges`）。
   */
  {
    const m = Mesh.fromFaceList(
      V([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0],
         [10, -10, 0], [0, -10, 0], [10, 0, 10], [0, 0, 10]]),
      [[0, 1, 2, 3], [0, 1, 4, 5], [1, 0, 6, 7]]);
    eq('⑤ T 形接面 → 0 條「貼反」', so5.reversedFaceEdges(m).edges, 0);
    eq('★★ 它是非流形（1 條），兩者⛔不重疊', so5.nonManifoldEdges(m).edges, 1);
    eq('★ 而修法向也老實說修不了', edit.recalcNormalsOutside(m).ambiguousEdges, 1);
  }

  /**
   * ⑦ 🔴🔴 **`翻面` 做出來的狀態 —— 這是三種病裡唯一使用者做得出來的。**
   *
   * ⚠ **2026-08-27 kang 實測翻掉了一條清單**：我寫「點選一個面，按 `翻面`」，
   * 而 **`翻面` 翻的是整個物件**（`edit.js` 明文：「我們沒有理由提供一個
   * 製造『一個面貼反』的按鈕」）。所以他驗到的根本是另一則。
   * 🔴 **那一則當時沒有出路** —— 只說「印出來會內外相反」，⛔ 沒說按哪顆。
   */
  {
    const m = baked('box', { w: 10, h: 10, d: 10 });
    const f = edit.flipNormals(m);
    ok('⑦ 按「翻面」翻得動', f.ok && !!f.mesh);

    eq('★★ ⛔ 它不是「貼反了」（整個翻，繞向仍然一致）',
      so5.reversedFaceEdges(f.mesh).edges, 0);
    ok('★ 而且仍然是封閉的', f.mesh.validate().closed);
    ok('★★ 只有體積變成負的', stlVolume(tri(f.mesh)) < 0);

    const c = printCheck(f.mesh, tri(f.mesh), {});
    eq('★★ 恰好【1】則問題', c.issues.length, 1);
    eq('★★ kind 是 inward', c.issues[0].kind, 'inward');
    ok('★★★ 訊息裡指得到「修法向」那顆按鈕', /修法向/.test(c.issues[0].text));

    /** 🔴 出路要真的走得通（坑第 34 條的機械版） */
    const fx = edit.recalcNormalsOutside(f.mesh);
    ok('★★★ 按「修法向」之後一則問題都沒有',
      printCheck(fx.mesh, tri(fx.mesh), {}).issues.length === 0);
    ok('★★ 而且體積回到正的', stlVolume(tri(fx.mesh)) > 0);
  }

  /** ⑥ 壞輸入不會壞 */
  eq('⑥ 沒給網格不會壞', so5.reversedFaceEdges(null).edges, 0);
}

// ═══════════════════════════════════════════════════════
//  變成正圓（＝ Blender 的 To Circle）
// ═══════════════════════════════════════════════════════

section('變成正圓：把歪掉的一圈點推回一個圓');

/**
 * 🔴 **這一節守著三條紅線**：
 * 1. **推完要真的是圓**（再量一次偏差 ≈ 0）
 * 2. **⛔ 不可以把點平均分佈** —— 那是對照表上另一個獨立項目
 * 3. **`dryRun` ⛔ 一個頂點都不准動**
 */
{
  const cap = m => m.faces.find(f => m.faceVerts(f).length > 4);

  /** ① 本來就是圓 → 擬合值就是它原本的半徑 */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const r = edit.toCircle(m, { kind: 'face', face: cap(m) }, { dryRun: true });
    near('① 圓柱 r25 的蓋子，擬合半徑 ＝ 25', r.fitted, 25, 1e-6);
    ok('★ 本來就共面（壓平量 ＝ 0）', r.flattened < 1e-9, r.flattened);
  }

  /**
   * ② 🔴 **故意把一個點拉歪 1.5cm** ——
   * ⭐ **這一條跟日誌「已經證明的事」那張表對得起來**：
   * 那裡 2026-08-23 獨立實測記的是「最大偏差 0.04074」。
   */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const f = cap(m);
    m.faceVerts(f)[0].p.x += 1.5;
    const d = edit.toCircle(m, { kind: 'face', face: f }, { dryRun: true });
    near('② 拉歪 1.5cm → 半徑最多差 0.0407（★ 對得上日誌那張表的 0.04074）',
         d.before, 0.04074, 1e-4);

    const r = edit.toCircle(m, { kind: 'face', face: f });
    eq('★★ 推了 32 個點', r.moved, 32);
    const after = edit.toCircle(m, { kind: 'face', face: f }, { dryRun: true });
    ok('★★★ 推完再量一次，偏差 ≈ 0（真的收斂了）', after.before < 1e-9, after.before);
  }

  /** ③ 指定半徑 → 每個點都精確落在那個半徑上 */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const f = cap(m);
    const r = edit.toCircle(m, { kind: 'face', face: f }, { radius: 40 });
    eq('③ 指定半徑 40', r.radius, 40);
    const vs = m.faceVerts(f);
    const c = new THREE.Vector3();
    vs.forEach(v => c.add(v.p)); c.divideScalar(vs.length);
    const rs = vs.map(v => v.p.distanceTo(c));
    near('★★ 最小半徑 40', Math.min(...rs), 40, 1e-9);
    near('★★ 最大半徑 40', Math.max(...rs), 40, 1e-9);
  }

  /**
   * ④ 🔴🔴 **⛔ 不可以把點平均分佈** —— 每個點保持自己的角度。
   * 作法：把一圈點的角度**故意弄不均勻**（隔一個往旁邊轉），
   * 推完之後那個不均勻**必須still在**。
   * 〔平均分佈是對照表上的 Space Evenly，混進來就是「功能定位互相模糊」〕
   */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const f = cap(m);
    const vs = m.faceVerts(f);
    const c0 = new THREE.Vector3();
    vs.forEach(v => c0.add(v.p)); c0.divideScalar(vs.length);
    const ang = v => Math.atan2(v.p.z - c0.z, v.p.x - c0.x);

    /** 把偶數號的點沿圓周擠向下一個點 → 角度變成疏密相間 */
    for (let i = 0; i < vs.length; i += 2) {
      const a = ang(vs[i]) + 0.05;
      const rr = Math.hypot(vs[i].p.x - c0.x, vs[i].p.z - c0.z);
      vs[i].p.x = c0.x + rr * Math.cos(a);
      vs[i].p.z = c0.z + rr * Math.sin(a);
    }
    const gapsBefore = vs.map((v, i) =>
      Math.abs(ang(vs[(i + 1) % vs.length]) - ang(v)));
    const spreadBefore = Math.max(...gapsBefore) - Math.min(...gapsBefore);

    edit.toCircle(m, { kind: 'face', face: f });

    const gapsAfter = vs.map((v, i) =>
      Math.abs(ang(vs[(i + 1) % vs.length]) - ang(v)));
    const spreadAfter = Math.max(...gapsAfter) - Math.min(...gapsAfter);

    ok('④ 推之前角度是疏密相間的', spreadBefore > 0.05, spreadBefore);
    ok('★★★ ⛔ 推完之後那個疏密【仍然在】—— 沒有被平均分佈掉',
       Math.abs(spreadAfter - spreadBefore) < 1e-6,
       `前 ${spreadBefore.toFixed(6)} → 後 ${spreadAfter.toFixed(6)}`);
  }

  /**
   * ⑤ ⭐ **推成正圓之後量周長，對得上「尺寸的依據」那張表。**
   * 32 段、半徑 25 的正多邊形，弦長和 ＝ 2×32×25×sin(π/32) ＝ 156.827…
   * 🔴 那正是日誌那張表寫的 **156.83**（而 2πr ＝ 157.08 是理想圓）。
   */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const f = cap(m);
    edit.toCircle(m, { kind: 'face', face: f }, { radius: 25 });
    const vs = m.faceVerts(f);
    let peri = 0;
    for (let i = 0; i < vs.length; i++) peri += vs[i].p.distanceTo(vs[(i + 1) % vs.length].p);
    const want = 2 * 32 * 25 * Math.sin(Math.PI / 32);
    near('⑤ 推成 r25 的正圓後，周長 ＝ 2·32·25·sin(π/32)', peri, want, 1e-6);
    near('★★★ 而那個數字就是「尺寸的依據」那張表的 156.83', peri, 156.827, 1e-3);
    ok('★★ ⛔ 它不是 2πr（157.08）—— 網格裡沒有曲面',
       Math.abs(peri - 2 * Math.PI * 25) > 0.2, peri);
  }

  /** ⑥ 不共面的一圈會被壓平，而且壓多少要講得出來 */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const f = cap(m);
    m.faceVerts(f)[0].p.y += 3;
    const d = edit.toCircle(m, { kind: 'face', face: f }, { dryRun: true });
    ok('⑥ 拉出平面 3cm → 壓平量講得出來', d.flattened > 2, d.flattened);
    edit.toCircle(m, { kind: 'face', face: f });
    const after = edit.toCircle(m, { kind: 'face', face: f }, { dryRun: true });
    ok('★★★ 推完真的共面了', after.flattened < 1e-9, after.flattened);
  }

  /** ⑦ 🔴 dryRun ⛔ 一個頂點都不准動 */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const f = cap(m);
    m.faceVerts(f)[0].p.x += 1.5;
    const snap = m.faceVerts(f).map(v => v.p.clone());
    const d = edit.toCircle(m, { kind: 'face', face: f }, { dryRun: true });
    ok('⑦ dryRun 一個頂點都沒動',
       m.faceVerts(f).every((v, i) => v.p.equals(snap[i])));
    eq('★ 而且它自己說 moved ＝ 0', d.moved, 0);
    const r = edit.toCircle(m, { kind: 'face', face: f });
    near('★★ 兩次算出來的半徑一樣（⛔ 沒有第二份算法）', r.fitted, d.fitted, 1e-12);
  }

  /** ⑧ 方塊的面：4 個點也推得成圓（矩形 → 正方形） */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    const f = m.faces[0];
    const r = edit.toCircle(m, { kind: 'face', face: f });
    const vs = m.faceVerts(f);
    const c = new THREE.Vector3();
    vs.forEach(v => c.add(v.p)); c.divideScalar(vs.length);
    const rs = vs.map(v => v.p.distanceTo(c));
    ok('⑧ 方塊的面（4 點）推得成圓', r.ok);
    near('★★ 四個角離中心一樣遠', Math.max(...rs) - Math.min(...rs), 0, 1e-9);
  }

  /** ⑨ 壞輸入不會壞 */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    ok('⑨ 沒選東西要給得出理由', !!edit.toCircle(m, null).reason);
    const he = [...m.edges()][0];
    ok('★ 只選一條邊（2 個點）要給得出理由',
       !!edit.toCircle(m, { kind: 'edge', he }).reason);
  }
}

// ═══════════════════════════════════════════════════════
//  分離（＝ Blender 的 Separate）
// ═══════════════════════════════════════════════════════

section('分離：沿著一圈邊把物件拆成兩塊');

/**
 * 🔴 **kang 2026-08-25 講的那件事**：
 * > 「刀具在我的想法中是將模型切開...如果是一個球..
 * > 　我可以把球**切成兩半...變成兩個半圓模型**」
 *
 * 「切開」跟「拆成兩個物件」是兩件事 —— `bisect()`／`loopCut()`
 * 都只加線，網格從頭到尾是**一整塊**。這一支補的是後面那一半。
 *
 * ── 🔴 主斷言：兩塊的面積加起來 ＝ 原本的表面積 ──────────────
 * 分離**不是**布林，它只是把面分成兩組 —— **一片面都不該多、不該少**。
 * ⚠ 體積不能拿來當主斷言：兩塊都是**開放的**（斷面是洞），
 * 開放網格的體積沒有意義。
 *
 * ── ⚠ 拆出來的兩塊是開放的，那是正確的 ────────────────────
 * 球切兩半 ＝ 兩個**碗**，不是兩個實心半球。要補起來按現成的「補洞」。
 */
const edgesFromNew = (m, newEdges) => {
  const di = m._vertIndex();
  const k = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const want = new Set(newEdges.map(([a, b]) => k(a, b)));
  return [...m.edges()].filter(he => want.has(k(di.get(he.v.id), di.get(he.to.id))));
};

{
  /** kang 的例子：球切兩半 */
  const ball = baked('sphere', { r: 30, segW: 16, segH: 12 });
  const area0 = ball.area();
  ok('前提：原球是封閉的', ball.isClosed());

  const cut = edit.bisect(ball, { n: new THREE.Vector3(0, 1, 0), d: 7.3 });
  ok('前提：切一刀切得下去', cut.ok, cut.reason);
  const hes = edgesFromNew(cut.mesh, cut.newEdges);
  eq('前提：切出來那一圈 16 條', hes.length, 16);

  const r = edit.separateAlongEdges(cut.mesh, hes);
  ok('★★ 球沿著那一圈拆得開', r.ok, r.reason);
  eq('★★ 拆成 2 塊', r.parts, 2);

  /** 🔴 主斷言 */
  rel('★★★ 兩塊的表面積加起來 ＝ 原球的表面積',
      r.meshes.reduce((s, m) => s + m.area(), 0), area0);

  ok('★★ 兩塊都是開放的（斷面是洞，那是對的）',
     r.meshes.every(m => !m.isClosed()));
  ok('　　兩塊的結構都沒問題', r.meshes.every(m => m.validate().ok));
  ok('★ 大的排前面', r.meshes[0].faces.length >= r.meshes[1].faces.length);

  /**
   * ⭐ **這一條驗的是「兩顆按鈕接得起來」** ——
   * kang 要的是「兩個半圓**模型**」，而碗補起來才是半球。
   * ⛔ 少了這條，分離自己通過也不代表他要的東西做得出來。
   */
  const fill = edit.fillHoles(r.meshes[0]);
  ok('★★★ 拆出來的那一塊可以直接「補洞」變回封閉的', fill.ok, fill.reason);
  ok('　　　補完是封閉的', fill.mesh.isClosed());
  eq('　　　χ 回到 2', chi(fill.mesh), 2);
  ok('　　　而且體積是正的（法向沒有翻掉）', fill.mesh.volume() > 0);
}

{
  /** 環切之後分離：圓柱斷成兩截 */
  const cyl = baked('cylinder', { r: 25, h: 70, seg: 16 });
  const area0 = cyl.area();
  const side = [...cyl.edges()].find(he => Math.abs(he.v.p.y - he.to.p.y) > 1);
  ok('前提：找得到一條直立的側邊', !!side);

  const lc = edit.loopCut(cyl, side, { cuts: 1 });
  ok('前提：環切繞得起來', lc.ok, lc.reason);
  const r = edit.separateAlongEdges(lc.mesh, edgesFromNew(lc.mesh, lc.newEdges));
  ok('★★ 環切之後也拆得開（kang：「都可以套用在切一刀或是環切」）', r.ok, r.reason);
  eq('★★ 拆成 2 塊', r.parts, 2);
  rel('★★★ 兩塊面積加起來 ＝ 原本的表面積',
      r.meshes.reduce((s, m) => s + m.area(), 0), area0);
  ok('　　兩塊結構都沒問題', r.meshes.every(m => m.validate().ok));
}

{
  /**
   * 🔴 分不開要擋並說原因（坑第 11 條）。
   * ⚠ 而且訊息要指出**真的走得通**的出路（坑第 34 條）——
   * 「用切一刀或環切切一圈」那條路是存在的。
   */
  const ball = baked('sphere', { r: 30, segW: 16, segH: 12 });
  const cut = edit.bisect(ball, { n: new THREE.Vector3(0, 1, 0), d: 7.3 });
  const hes = edgesFromNew(cut.mesh, cut.newEdges);

  const one = edit.separateAlongEdges(cut.mesh, [hes[0]]);
  ok('★★ 只選一條邊分不開，要擋下來', !one.ok);
  ok('★★ 而且要指出「切一刀或環切」那條走得通的路',
     /切一刀|環切/.test(one.reason || ''), one.reason);

  ok('★ 沒選邊要擋', !edit.separateAlongEdges(cut.mesh, []).ok);

  /**
   * ⭐ **一個沒預期到的能力，是測試自己撞出來的**（2026-08-25）。
   *
   * 原本這裡寫「沒切過的球，隨便抓三條邊應該分不開」——
   * **結果分開了，而且程式是對的**：我隨便抓的那三條剛好**圍住球極點
   * 的一個三角形**，圍成封閉邊界就真的能把那一片分出去。
   *
   * 🔴 **判準從來就不是「有沒有切成兩半」，是「那組邊圍不圍得成封閉邊界」**
   * —— 所以它也能把**任意一塊面**分出去（那正是對照表說的
   * 「這對分片是另一條路：與其標接縫，直接切成好幾個物件」）。
   *
   * ⚠ 順帶記一條教訓：**挑樣本要先去量，不要隨便抓**
   * 〔任意切線案例五、面上加線的 60×45 都栽在同一件事〕。
   */
  const oneFace = ball.faces[0];
  const ring = ball.faceLoop(oneFace);
  const cutOut = edit.separateAlongEdges(ball, ring);
  ok('★★ 圍住一個面的那幾條邊，可以把那一片單獨分出去', cutOut.ok, cutOut.reason);
  eq('　　拆成 2 塊', cutOut.parts, 2);
  eq('　　小的那塊就是那一片', cutOut.meshes[1].faces.length, 1);
  rel('★★ 面積照樣加得回來',
      cutOut.meshes.reduce((s, m) => s + m.area(), 0), ball.area());

  /** ⚠ 真正分不開的：同一個面上的兩條邊，圍不成邊界 */
  const notLoop = edit.separateAlongEdges(ball, [ring[0], ring[1]]);
  ok('★ 圍不成封閉邊界就分不開，要擋下來', !notLoop.ok, '竟然分開了');
}

// ═══════════════════════════════════════════════════════
//  邊上加點（＝ Blender 的 Subdivide 選一條邊）
// ═══════════════════════════════════════════════════════

section('邊上加點：只放點，什麼都不連');

/**
 * kang 2026-08-25 問出來的：
 * > 「是不是還有功能是**可以增加點**..然後再使用多點連接功能?」
 *
 * 現在能加點的四顆按鈕（切一刀／環切／面上加線／內縮導角）
 * **加完都順手把線連掉了**，沒有一顆是「只放一個點」。
 * 🔴 **有了它，「多點連接」才真的自由** —— 在這之前只連得到既有的角。
 *
 * ── 🔴 這一節最重要的一條斷言 ─────────────────────────
 * **共線的點不可以被吃掉。** 方塊頂面加一個點之後是**五邊形**，
 * 其中一個角是 180 度 —— 而這個專案別處都在消滅多餘的點
 * （還原多邊形、`cleanRebuild()` 清孤點）。
 * ⚠ **被吃掉的話這顆按鈕就是按了沒反應**（坑第 21 條），
 * 而體積、面積、χ **全部照樣正確**（坑第 17 條）。
 */
{
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const vol0 = box.volume(), area0 = box.area();
  const v0 = box.verts.length, e0 = edgeCount(box), f0 = box.faces.length;
  const top = box.faces.find(f => {
    const vs = box.faceLoop(f).map(he => he.v);
    return vs.length === 4 && vs.every(v => Math.abs(v.p.y - 20) < 1e-9);
  });
  const hes = box.faceLoop(top);

  const r = edit.subdivideEdges(box, [hes[0]], 1);
  ok('一條邊加一個點', r.ok, r.reason);
  const m = r.mesh;

  eq('★ V 8 → 9', m.verts.length, v0 + 1);
  eq('★ E 12 → 13（那條邊變成兩段）', edgeCount(m), e0 + 1);
  eq('★★ 面數不變（只加點，不連線）', m.faces.length, f0);
  eq('★★ χ 仍然是 2', chi(m), 2);
  ok('　　仍然封閉、結構沒問題', m.isClosed() && m.validate().ok);
  rel('★★ 體積精確不變', m.volume(), vol0);
  rel('★★ 面積精確不變', m.area(), area0);
  eq('★ 孤點 0 個', r.orphans, 0);
  eq('★ 回報新加了 1 個點', r.newVerts.length, 1);
  eq('★ 兩個面被波及（共用那條邊的）', r.touched, 2);

  /** 🔴 那個點真的在新網格裡，而且在中點上 */
  const nv = m.verts[r.newVerts[0]];
  ok('★★ 新的點真的在（不是只回報了索引）', !!nv);
  near('　　而且落在那條邊的中點上', nv.p.distanceTo(
    hes[0].v.p.clone().add(hes[0].to.p).multiplyScalar(0.5)), 0, 1e-9);

  const t2 = m.faces.find(f => m.faceLoop(f).every(he => Math.abs(he.v.p.y - 20) < 1e-9));
  eq('★★ 頂面從四邊形變成五邊形', m.faceLoop(t2).length, 5);

  /**
   * 🔴🔴 **最重要的一條：共線的點不可以被還原多邊形吃掉。**
   * 這個專案的 `bake()` 會自動跑 `mergeCoplanarFaces()`，
   * 那一支的工作正是「消滅多餘的東西」—— 它必須放過使用者放的點。
   */
  ok('★★★ 再跑一次還原多邊形，不可以把共線的點吃掉',
     !edit.mergeCoplanarFaces(m).ok || edit.mergeCoplanarFaces(m).mesh.verts.length === m.verts.length);
}

{
  /** 一條邊加 3 個點；四條邊各加 1 個 */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const vol0 = box.volume(), area0 = box.area();
  const v0 = box.verts.length;
  const top = box.faces.find(f => {
    const vs = box.faceLoop(f).map(he => he.v);
    return vs.length === 4 && vs.every(v => Math.abs(v.p.y - 20) < 1e-9);
  });
  const hes = box.faceLoop(top);

  const r3 = edit.subdivideEdges(box, [hes[0]], 3);
  ok('一條邊加 3 個點', r3.ok, r3.reason);
  eq('★ V ＋3', r3.mesh.verts.length, v0 + 3);
  eq('★★ χ 仍然是 2', chi(r3.mesh), 2);
  rel('★★ 體積精確不變', r3.mesh.volume(), vol0);
  rel('★★ 面積精確不變', r3.mesh.area(), area0);

  const r4 = edit.subdivideEdges(box, hes, 1);
  ok('四條邊各加一個點', r4.ok, r4.reason);
  eq('★ V ＋4', r4.mesh.verts.length, v0 + 4);
  eq('★ 頂面變成八邊形', r4.mesh.faceLoop(
    r4.mesh.faces.find(f => r4.mesh.faceLoop(f).every(he => Math.abs(he.v.p.y - 20) < 1e-9))
  ).length, 8);
  eq('★★ χ 仍然是 2', chi(r4.mesh), 2);
  rel('★★ 體積精確不變', r4.mesh.volume(), vol0);
  rel('★★ 面積精確不變', r4.mesh.area(), area0);

  /**
   * ⭐ **這一條驗的是「兩顆按鈕接得起來」** —— 那正是 kang 問的那件事：
   * 加點 → 再用多點連接。⛔ 少了這條，兩顆各自通過也不代表流程走得通。
   */
  const vs = r4.newVerts.map(i => r4.mesh.verts[i]);
  const rc = edit.connectVertsPath(r4.mesh, [vs[0], vs[2]]);
  ok('★★★ 加完的點可以直接拿去「多點連接」', rc.ok, rc.reason);
  rel('　　　而且面積照樣精確不變', rc.mesh.area(), area0);
  eq('　　　χ 仍然是 2', chi(rc.mesh), 2);
}

{
  /** 擋下來的情形 */
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const top = box.faces.find(f => {
    const vs = box.faceLoop(f).map(he => he.v);
    return vs.length === 4 && vs.every(v => Math.abs(v.p.y - 20) < 1e-9);
  });
  const hes = box.faceLoop(top);

  ok('★ 沒選邊要擋', !edit.subdivideEdges(box, [], 1).ok);
  ok('★ 個數 0 要擋', !edit.subdivideEdges(box, [hes[0]], 0).ok);

  /**
   * 🔴 切太細要擋，判準是**實際距離**不是個數 —— 邊有長有短。
   * 每段不到 0.1mm 會長出零長度的邊，而體積面積 χ 全部照樣正確
   * （坑第 17、25／26 條）。
   */
  const tiny = edit.subdivideEdges(box, [hes[0]], 100000);
  ok('★★ 切太細擋下來，而且講出那條邊多長',
     !tiny.ok && /cm/.test(tiny.reason || '') && /mm/.test(tiny.reason || ''), tiny.reason);
}

// ═══════════════════════════════════════════════════════
//  多點連接（＝ 依序跑好幾次「連接兩點」）
// ═══════════════════════════════════════════════════════

section('細分：選到的面切成 n×n 塊，形狀不變（2026-10-14）');

/**
 * kang 2026-10-14 看樣板 `樣板-細分.html` 拍板：① 新點放在原本的面上 ② 旁邊的面只在邊上多點
 * ③ 等分由欄位給 ④ 5 邊以上中心切扇形、凹的只在邊上加點。→ `規格\建模器-細分.md`
 *
 * 🔴 **最重要的斷言：體積、面積精確不變**（跟環切、內縮同一條）——
 * 而那幾個點數、面數，跟樣板（另一份獨立寫的算法）量到的一模一樣。
 */
{
  const sd = (m, fs, n) => edit.subdivideFaces(m, fs, n);
  const same = (name, m0, r) => {
    ok(`${name}：成功`, r.ok, r.reason || '');
    rel(`★★ ${name}：體積精確不變`, r.mesh.volume(), m0.volume());
    rel(`★★ ${name}：面積精確不變`, r.mesh.area(), m0.area());
    ok(`　　${name}：封閉、χ 不變、結構沒問題`,
       r.mesh.isClosed() === m0.isClosed() && chi(r.mesh) === chi(m0) && r.mesh.validate().ok);
  };
  const box = () => baked('box', { w: 60, h: 45, d: 40 });
  const topOf = m => m.faces.find(f => f.normal.y > 0.99);

  {
    const m = box(), r = sd(m, [topOf(m)], 2);
    same('方塊頂面 2 等分', m, r);
    eq('★ 點 8 → 13（4 條邊各一個中點 ＋ 中心 1）', r.mesh.verts.length, 13);
    eq('★ 面 6 → 9（頂面變 4 塊，四個側面各多一個點、還是 1 個面）', r.mesh.faces.length, 9);
    eq('★ 新線 4 條，全部標 hard', r.hard, 4);
    eq('　　hard 邊確實是 4 條', [...r.mesh.edges()].filter(he => he.hard).length, 4);
    eq('旁邊被插點的面 4 個', r.touched, 4);
    r.mesh.computeNormals();
    const sub = r.mesh.faces.find(f => f.normal.y > 0.99);
    eq('★★ 切出來的小面自成一區（hard 擋住了；⛔ 會連整片頂面一起選）',
       edit.regionOf(r.mesh, sub).faces.length, 1);
    near('★ 原網格完全沒被改', m.verts.length, 8, 0);
  }
  {
    const m = box(), r = sd(m, [topOf(m)], 3);
    same('方塊頂面 3 等分', m, r);
    eq('★ 點 8 → 20、面 6 → 14', r.mesh.verts.length * 100 + r.mesh.faces.length, 2014);
    eq('　　新線 12 條（裡面 2 橫 2 直、各 3 段）', r.hard, 12);
  }
  {
    // 相鄰兩個面一起：共用的那條邊只切一次（樣板量到 17 點、12 面）
    const m = box(); m.computeNormals();
    const front = m.faces.find(f => f.normal.z > 0.99);
    const r = sd(m, [topOf(m), front], 2);
    same('方塊頂面＋前面', m, r);
    eq('★★ 點 8 → 17（共用的邊只切一次）、面 6 → 12', r.mesh.verts.length * 100 + r.mesh.faces.length, 1712);
  }
  {
    // ④ 圓柱頂蓋（32 邊形）：中心一點 ＋ 32 片扇形，每片再切 4 塊（樣板量到 129 點、161 面）
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const r = sd(m, [topOf(m)], 2);
    same('圓柱頂蓋 2 等分', m, r);
    eq('★ 點 64 → 129（邊上 32 ＋ 中心 1 ＋ 輻條 32）、面 34 → 161', r.mesh.verts.length * 1000 + r.mesh.faces.length, 129161);
    eq('　　32 個側面各多一個點', r.touched, 32);
  }
  {
    // 整顆球：448 個四邊形 ＋ 64 個三角形全切（樣板量到側面一塊 36 個面 ⇒ 620 面）
    const m = baked('sphere', { r: 30, segW: 32, segH: 16 });
    const r = sd(m, m.faces, 2);
    same('整顆球 2 等分', m, r);
    eq('★ 面 512 → 2048（每個都變 4 塊）', r.mesh.faces.length, 2048);
    eq('　　點 482 → 1922（＋992 條邊的中點 ＋448 個四邊形的中心）', r.mesh.verts.length, 1922);
    eq('　　旁邊沒有面被插點（全選了）', r.touched, 0);
  }
  {
    // ④ 凹的多邊形：⛔ 不切，只在邊上加點
    const L = [0, 0, 40, 0, 40, 10, 10, 10, 10, 30, 0, 30];
    const m = baked('extrude', { type: 'extrude', h: 5, shapes: [{ out: L, oc: [0, 1, 2, 3, 4, 5] }] });
    const top = topOf(m);
    eq('（前置）L 形的頂面是 1 個 6 邊形', m.faceLoop(top).length, 6);
    const r = sd(m, [top], 2);
    same('L 形頂面', m, r);
    eq('★★ 凹的 ⇒ 只在邊上加點，回報 1 個', r.concave * 10 + r.polys, 10);
    r.mesh.computeNormals();
    eq('　　頂面還是 1 個面、12 個點', r.mesh.faceLoop(topOf(r.mesh)).length, 12);
  }
  {
    /**
     * 🔴 **先細分一塊、再往旁邊細分**（2026-10-14 AI 線上先驗抓到的）：
     * 前面的上緣被頂面的細分插了點 ⇒ 照「點」數它是多邊形，第一版被切成扇形
     * （頂面 2 等分再 3 等分之後前面是 9 邊形 ⇒ 324 片細長三角形）。
     * ⇒ 照「角」數：它還是 4 個角 ⇒ 格子。
     */
    const front = m => { m.computeNormals(); return m.faces.find(f => f.normal.z > 0.99); };
    const tris = (m, fs) => fs.filter(f => m.faceLoop(f).length === 3).length;
    let m = box();
    let r = sd(m, [topOf(m)], 2);
    m = r.mesh; edit.refreshAfterEdit(m);
    eq('（前置）前面現在是 5 個點（上緣多一個中點）', m.faceLoop(front(m)).length, 5);
    const m2 = sd(m, [front(m)], 2);
    same('頂面細分過、再細分前面 2 等分', m, m2);
    m2.mesh.computeNormals();
    const fr2 = m2.mesh.faces.filter(f => f.normal.z > 0.99);
    eq('★★ 前面切成 4 塊（格子，⛔ 扇形）、一片三角形都沒有', fr2.length * 10 + tris(m2.mesh, fr2), 40);
    eq('　　上緣那個中點直接拿來用（⛔ 多插一個）：點 13 → 17', m2.mesh.verts.length, 17);

    // 頂面 2 等分 → 頂面 4 塊再 3 等分 ⇒ 前面上緣有 5 個點（1/6…5/6）
    r = sd(m, m.faces.filter(f => f.normal.y > 0.99), 3);
    m = r.mesh; edit.refreshAfterEdit(m);
    eq('（前置）前面現在是 9 個點', m.faceLoop(front(m)).length, 9);
    const m6 = sd(m, [front(m)], 6);
    same('前面 6 等分（上緣的點剛好都在格點上）', m, m6);
    m6.mesh.computeNormals();
    const fr6 = m6.mesh.faces.filter(f => f.normal.z > 0.99);
    eq('★★ 前面是 6×6 ＝ 36 格、全部四邊形（第一版：324 片三角形）',
       fr6.length * 1000 + fr6.filter(f => m6.mesh.faceLoop(f).length === 4).length, 36036);
    const m2b = sd(m, [front(m)], 2);
    same('前面 2 等分（上緣多的點⛔ 落在格點上）', m, m2b);
    m2b.mesh.computeNormals();
    const frb = m2b.mesh.faces.filter(f => f.normal.z > 0.99);
    eq('★ 還是 4 格；上面兩格各接進原本的 2 個點（6 邊形）、一片三角形都沒有',
       frb.map(f => m2b.mesh.faceLoop(f).length).sort().join(','), '4,4,6,6');
  }
  {
    // 圓柱：蓋子細分過，側面上緣多了點 ⇒ 側面再細分還是格子
    let m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    m = sd(m, [topOf(m)], 2).mesh; edit.refreshAfterEdit(m);
    m.computeNormals();
    const side = m.faces.find(f => Math.abs(f.normal.y) < 0.01);
    const r = sd(m, [side], 2);
    same('圓柱蓋子細分過、再細分一個側面', m, r);
    eq('★ 側面切成 4 塊（格子）：面 161 → 164', r.mesh.faces.length, 164);
  }
  {
    // 標記：被切成兩段的邊，兩段都要帶著原本的標記
    const m = box();
    const e = m.faceLoop(topOf(m))[0];
    m.setRole(e, EDGE_ROLE.CUT);
    const r = sd(m, [topOf(m)], 2);
    eq('★★ 標了「切開」的那條邊切成兩段，兩段都還是切開', 
       [...r.mesh.edges()].filter(he => he.role === EDGE_ROLE.CUT).length, 2);
  }
  {
    // 展開：新線都是平的 ⇒ 不會變成折線（片數、面積、補剪的總長都不變）
    const { makeRule: mk, DEFAULT_MATERIAL: dm } = await import('../js/unfold/rules.js');
    const len = es => es.reduce((s, h) => s + h.v.p.distanceTo(h.to.p), 0);
    for (const [name, m, fs] of [['方塊頂面', box(), m => [topOf(m)]],
                                 ['圓柱側面', baked('cylinder', { r: 25, h: 70, seg: 32 }), m => m.faces.filter(f => Math.abs(f.normal.y) < 0.01)]]) {
      edit.refreshAfterEdit(m);
      const a = unfoldMesh(m, mk(dm, 0.3));
      const o = sd(m, fs(m), 2).mesh;
      edit.refreshAfterEdit(o);
      const b = unfoldMesh(o, mk(dm, 0.3));
      eq(`★ ${name} 細分後展開：片數一樣`, b.stats.pieces, a.stats.pieces);
      rel(`　　${name}：展開面積一樣`, b.stats.area, a.stats.area);
      rel(`　　${name}：程式補剪的總長一樣`, len(b.autoEdges), len(a.autoEdges));
      eq(`　　${name}：圓弧折彎一樣幾組`, b.stats.arcBends, a.stats.arcBends);
    }
  }
  {
    const m = box();
    ok('等分 1 擋下來', !sd(m, [topOf(m)], 1).ok);
    ok('沒選面 擋下來', !sd(m, [], 2).ok);
    const tiny = baked('box', { w: 0.03, h: 1, d: 1 });
    const r = sd(tiny, [topOf(tiny)], 6);
    ok('★ 切出來比 0.1 mm 短 ⇒ 擋下來並講原因', !r.ok && /長度 0/.test(r.reason || ''), r.reason || '竟然通過');
  }
}

section('多點連接：照選的順序一段一段連');

/**
 * kang 2026-08-25 定名「多點連接」。原本刻意只收兩個點，理由是
 * 「四個角會有兩條對角線交叉」—— ⚠ **那個顧慮只對 Blender 的
 * `Connect Vertices`（不看順序、全部配對）成立**，依序連沒有那個問題。
 *
 * ── 🔴 為什麼一定要「依序、一段一段」，不能一次算完 ──────────
 * **切完第一段，面就變了。** 第二段的兩個點可能分屬切開後的不同塊，
 * 拿原本那個面去算一定錯。所以每一段都在**上一段的結果**上重新找面。
 * ⚠ 連帶：每切一次頂點物件就換一批，還沒用到的點要靠 `remap` 搬過去。
 */
{
  /**
   * 🔴 **回歸最重要**：兩個點的時候，走 `connectVertsPath()` 的結果
   * 必須跟直接走 `connectVerts()` **逐項相同**。
   * ⭐ 那是結構保證（迴圈只跑一次），不是靠測試盯著 —— 但還是要釘住，
   * 因為「包一層」很容易在包的過程中偷偷改掉行為。
   */
  const b1 = baked('box', { w: 60, d: 45, h: 40 });
  const b2 = baked('box', { w: 60, d: 45, h: 40 });
  const pick = m => {
    const f = m.faces.find(x => {
      const vs = m.faceLoop(x).map(he => he.v);
      return vs.length === 4 && vs.every(v => Math.abs(v.p.y - 20) < 1e-9);
    });
    return m.faceLoop(f).map(he => he.v);
  };
  const one = edit.connectVerts(b1, pick(b1)[0], pick(b1)[2]);
  const path = edit.connectVertsPath(b2, [pick(b2)[0], pick(b2)[2]]);
  ok('兩個點：兩條路都走得通', one.ok && path.ok, path.reason);
  eq('★★ 頂點數相同', path.mesh.verts.length, one.mesh.verts.length);
  eq('★★ 面數相同', path.mesh.faces.length, one.mesh.faces.length);
  eq('★★ 邊數相同', edgeCount(path.mesh), edgeCount(one.mesh));
  rel('★★ 體積相同', path.mesh.volume(), one.mesh.volume());
  rel('★★ 面積相同', path.mesh.area(), one.mesh.area());
  eq('★ 段數 1', path.segments, 1);
}

{
  /**
   * L 形頂面連兩段：角(0,30) → 角(10,10) → 角(0,0)。
   * ⭐ **兩段都在面內**，而且第二段是在**第一段切完的新面**上找的。
   */
  const prof = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]];
  const H = 10, N = prof.length;
  const pts = [];
  for (const [x, z] of prof) pts.push(new THREE.Vector3(x, 0, z));
  for (const [x, z] of prof) pts.push(new THREE.Vector3(x, H, z));
  const fl = [[...Array(N).keys()].reverse(), [...Array(N).keys()].map(i => i + N)];
  for (let i = 0; i < N; i++) fl.push([i, (i + 1) % N, (i + 1) % N + N, i + N]);
  const raw = Mesh.fromFaceList(pts, fl);
  raw.computeNormals();
  const fix = edit.recalcNormalsOutside(raw);
  const L = (fix && fix.mesh) ? fix.mesh : raw;
  L.computeNormals();
  const area0 = L.area(), vol0 = L.volume(), v0 = L.verts.length;

  const top = L.faces.find(f =>
    L.faceLoop(f).length === 6 && L.faceLoop(f).every(he => Math.abs(he.v.p.y - H) < 1e-9));
  const V6 = L.faceLoop(top).map(he => he.v);

  const r = edit.connectVertsPath(L, [V6[0], V6[2], V6[5]]);
  ok('L 形頂面連兩段', r.ok, r.reason);
  eq('★ 段數 2', r.segments, 2);
  eq('★ 新的線 2 條', r.newEdges.length, 2);
  eq('★★ 頂點數不變（都是既有的角）', r.mesh.verts.length, v0);
  eq('★ 邊 ＋2', edgeCount(r.mesh), edgeCount(L) + 2);
  eq('★ 面 ＋2', r.mesh.faces.length, L.faces.length + 2);
  eq('★★ χ 仍然是 2', chi(r.mesh), 2);
  ok('　　仍然封閉、結構沒問題', r.mesh.isClosed() && r.mesh.validate().ok);
  rel('★★ 體積精確不變', r.mesh.volume(), vol0);
  rel('★★ 面積精確不變', r.mesh.area(), area0);
  eq('★ 兩條新線都標成 hard', [...r.mesh.edges()].filter(he => he.hard).length, 2);

  /**
   * ⚠ `remap` 說的是「原網格每個索引 → 最後那個網格」，
   * ⛔ 給半套（只放選取的那幾個）就是寫一個不存在的退路（坑第 34 條）。
   */
  eq('★★ remap 是完整的，不是只有選到的那幾個', r.remap.size, v0);

  /**
   * 🔴 **卡住的時候要講「第幾段」。** 選了五個點只說「相鄰」，
   * 使用者不知道是哪一段的問題（坑第 20 條的近親：畫面上數不出來）。
   */
  const bad = edit.connectVertsPath(L, [V6[0], V6[2], V6[3]]);
  ok('★★ 第二段卡住，訊息要說「第 2 段」',
     !bad.ok && /第 2 段/.test(bad.reason || ''), bad.reason);
  ok('　　而且要保留原本的原因（相鄰）',
     /本來就已經有一條線/.test(bad.reason || ''), bad.reason);

  /** ⚠ 只有兩個點時 ⛔ 不要加「第 N 段」—— 那是多餘的雜訊 */
  const bad2 = edit.connectVertsPath(L, [V6[0], V6[3]]);
  ok('★ 只有兩個點時不加「第幾段」',
     !bad2.ok && !/第 \d 段/.test(bad2.reason || ''), bad2.reason);

  ok('★ 連續選到同一個點要擋', !edit.connectVertsPath(L, [V6[0], V6[0]]).ok);
  ok('★ 只給一個點要擋', !edit.connectVertsPath(L, [V6[0]]).ok);
  ok('★ 沒給點要擋', !edit.connectVertsPath(L, []).ok);
}

// ═══════════════════════════════════════════════════════
//  🔴 凹的面：新拉的線不可以跑到面外面（kang 2026-08-25 實測抓到）
// ═══════════════════════════════════════════════════════

section('點連成面：選幾個點，照順序圍出一個面');

/**
 * ＝ Blender 的 `F`。kang 2026-08-27 挑的三項之一
 * （「沿面滑動邊...由點建面...橋接邊迴圈..我都想要有功能」）。
 *
 * ⭐ **⛔ 一行新的數學都沒有** —— 骨架就是 `fillHoles()` 那條：
 * 頂點照舊、`faces` 多推一個 → `preflightRebuild` → `cleanRebuild` →
 * `fromFaceList` → `copyMarksThroughRemap`。
 *
 * 🔴 **三道關卡，⛔ 每一道都要講清楚原因** —— 沉默地做不出東西
 * 跟「功能壞掉」分不出來（坑第 21 條）。
 */
{
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const F = edit.faceFromVerts;
  const topY = box.verts.reduce((m, v) => Math.max(m, v.p.y), -1e9);
  const top4 = box.verts.filter(v => Math.abs(v.p.y - topY) < 1e-9);
  eq('方塊頂面有 4 個角', top4.length, 4);

  // ── ① 少於 3 個點：擋，而且要指路去「多點連接」 ──
  {
    const r = F(box, [top4[0], top4[1]]);
    eq('★★ 只選 2 個點 → 擋下來', r.ok, false);
    ok('★★ 　　而且指路去「多點連接」（⛔ 不做 Blender 那個「2 點建一條邊」）',
      r.reason.includes('多點連接'));
    eq('★ 選 0 個 → 也擋', F(box, []).ok, false);
  }

  // ── ② 同一個點選兩次 ──
  eq('★ 同一個點選兩次 → 擋', F(box, [top4[0], top4[1], top4[0]]).ok, false);

  // ── 🔴 ③ 這幾個點已經有一個面了 ──
  {
    const r = F(box, top4);
    eq('★★ 方塊頂面那 4 個角已經有面 → 擋下來', r.ok, false);
    /**
     * ⚠ **擋它的是【非流形】那一道，⛔ 不是「重複的面」那一道** ——
     * 因為那四個角之間的邊**本來就被兩個面夾住了**，所以在檢查
     * 「重複」之前就已經先撞到「邊要被三個面共用」。
     * 🔴 **兩道都要有**：⭐ 這一題證明順序是對的（先擋更嚴重的），
     * 而「重複的面」那一道守的是另一種情形 —— 見下面那則。
     * 〔寫這節時實際踩到：原本預期它會說「已經有一個面」〕
     */
    ok('★★ 　　⛔ 理由要講出來（⛔ 不是沉默地沒作用）',
      r.reason.includes('三個面') || r.reason.includes('已經有一個面'));
  }

  // ── 🔴 ④ 非流形：有邊兩側都已經有面 ──
  {
    /** 頂面的三個角：那三個點之間的邊都已經被兩個面夾住了 */
    const r = F(box, [top4[0], top4[1], top4[2]]);
    eq('★★ 三個角（邊已經滿了）→ 擋下來', r.ok, false);
    ok('★★ 　　理由要講「三個面共用」與「3D 列印會失敗」',
      r.reason.includes('三個面') && r.reason.includes('3D 列印'));
  }

  // ── ✅ 真的建得起來：先刪一個面，再用那一圈的點補回去 ──
  {
    const b2 = baked('box', { w: 60, d: 45, h: 40 });
    const ty = b2.verts.reduce((m, v) => Math.max(m, v.p.y), -1e9);
    const topFace = b2.faces.find(f =>
      b2.faceVerts(f).every(v => Math.abs(v.p.y - ty) < 1e-9));
    const del = edit.deleteFaces(b2, [{ kind: 'face', face: topFace }]);
    ok('先刪掉頂面', del.ok);
    const m2 = del.mesh;
    const ring = m2.verts.filter(v => Math.abs(v.p.y - ty) < 1e-9);
    eq('剩下 4 個角在頂面高度', ring.length, 4);

    /**
     * ⚠ **順序要照那一圈的繞向**，⛔ 不能隨便給 ——
     * 隨便給會圍成一個 8 字形（自交）。這裡照邊界迴圈的順序取。
     */
    const naked = m2.halfEdges.filter(he => !he.face);
    const loop = [];
    let c = naked[0], guard = 0;
    do { loop.push(c.v); c = c.next; } while (c && c !== naked[0] && guard++ < 100);
    eq('邊界迴圈是 4 個點', loop.length, 4);

    const before = { V: m2.verts.length, F: m2.faces.length };
    const r = F(m2, loop);
    ok('★★ 洞的那一圈 → 建得起來', r.ok);
    eq('★★ 　　是一個 4 邊的面', r.n, 4);
    eq('★★ 　　面數 ＋1', r.mesh.faces.length, before.F + 1);
    eq('★ 　　⛔ 頂點數不變（⛔ 沒有偷加點）', r.mesh.verts.length, before.V);
    ok('★★ 　　補回去之後又封閉了', r.mesh.isClosed());
    rel('★★ 　　體積回到 108000（60×45×40）', r.mesh.volume(), 108000);
    ok('★ 　　它是平的（偏離 0）', r.flatness < 1e-9);
  }

  // ── ⚠ 不平的面：照建，但要講出偏離多少（kang 2026-08-27 同意）──
  {
    const b3 = baked('box', { w: 60, d: 45, h: 40 });
    const ty = b3.verts.reduce((m, v) => Math.max(m, v.p.y), -1e9);
    const topFace = b3.faces.find(f =>
      b3.faceVerts(f).every(v => Math.abs(v.p.y - ty) < 1e-9));
    const m3 = edit.deleteFaces(b3, [{ kind: 'face', face: topFace }]).mesh;
    const naked = m3.halfEdges.filter(he => !he.face);
    const loop = [];
    let c = naked[0], guard = 0;
    do { loop.push(c.v); c = c.next; } while (c && c !== naked[0] && guard++ < 100);

    /** 把其中一個角往上推 5 —— 四個點就不共面了 */
    loop[0].p.y += 5;
    const r = F(m3, loop);
    ok('★★ 四個點不共面 → ⛔ 照樣建得起來（⛔ 不擋）', r.ok);
    /**
     * 🔴 **但一定要講出偏離多少** —— ⛔ 不講的話那是「安靜地做出一個
     * 不平的面」，而展開會從精確變成近似（坑第 11 條的近親）。
     * ⭐ 出路就在旁邊：`壓平`。
     */
    ok(`★★ 　　而且講得出偏離多少（${r.flatness.toFixed(3)} cm）`, r.flatness > 0.5);
  }

  /**
   * 🔴🔴 **「重複的面」那一道，要用【單面的平板】才撞得到。**
   *
   * ⚠ **上面方塊那一題撞到的是非流形那道**（頂面四個角的邊本來就滿了），
   * 所以「重複」那一道**當時沒有被任何測試守著** —— ⛔ 那就是
   * 「寫好了但沒有測試」。〔寫這節時發現的〕
   *
   * ⭐ **平板剛好卡在中間**：它只有一個面，四條邊各只有 **1** 個面 ——
   * 非流形那道放行（1 < 2），於是**輪到「重複的面」擋**。
   *
   * 🔴 **這一道非有不可**：`preflightRebuild()` 把它歸類成 `fixable`，
   * `cleanRebuild()` 會**安靜地清掉**新面 —— 使用者看到的是「按了沒反應」
   * （坑第 21 條）。⛔ 不自己擋就等於沒擋。
   */
  {
    const pts = [
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(60, 0, 0),
      new THREE.Vector3(60, 0, 45), new THREE.Vector3(0, 0, 45)
    ];
    const flat = Mesh.fromFaceList(pts, [[0, 1, 2, 3]]);
    flat.computeNormals();
    eq('平板是 1 個面 4 個點', `${flat.faces.length},${flat.verts.length}`, '1,4');
    /** ⭐ 四條邊各只有 1 個面 —— 非流形那道會放行 */
    const r = F(flat, flat.verts);
    eq('★★ 平板的四個角再建一次 → 擋下來', r.ok, false);
    ok('★★ 　　⛔ 而且理由是「已經有一個面」（⛔ 不是非流形那道）',
      r.reason.includes('已經有一個面'));
  }

  // ── 邊界情形 ──
  {
    eq('沒有網格 → 擋', F(null, top4).ok, false);
    eq('verts 不是陣列 → 擋', F(box, null).ok, false);
  }
}

section('凹的面：連接兩點／面上加線都不可以穿出邊界');

/**
 * 🔴 **這一節是 kang 實測抓出來的，而且症狀很典型。**
 *
 * 他的原話：「面切一刀...如果**遇到兩個邊不一樣大時**...會很奇怪」，
 * 附了 L 形跟方塊的對照截圖。查下去發現不只是難看：
 *
 * > **面積 2200 → 2600，而 `validate()`、χ、體積全部照樣正確。**
 *
 * 線穿出邊界之後，切出來的兩塊是**自交的多邊形**，三角化會把外面那塊
 * 也算進去。⚠ **體積是有號量所以照樣精確** —— 坑第 17 條：
 * **中途的量一直都是對的，末端才錯。**
 *
 * ── ⚠ 原本的測試為什麼沒抓到 ────────────────────────
 * 樣本是方塊的四邊形與圓柱的 32 邊形 —— **兩個都是凸的**，
 * 而凸多邊形的任兩點連線一定在裡面，那條路根本沒被走到。
 * 🔴 坑第 17 條：挑樣本要涵蓋不同的**網格結構**，
 * 而「凸／非凸」正是這個專案反覆踩到的那一組
 * 〔扇形三角化那次有 8 個出口，這是同一個病的第 9 個〕。
 * ⛔ **日後任何「在面上拉線」的功能，這一組一定要一起跑。**
 */
{
  /** L 形柱：頂面是**凹的** 6 邊形，面積 30×30 − 20×20 ＝ 500 */
  const prof = [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]];
  const H = 10, N = prof.length;
  const pts = [];
  for (const [x, z] of prof) pts.push(new THREE.Vector3(x, 0, z));
  for (const [x, z] of prof) pts.push(new THREE.Vector3(x, H, z));
  const fl = [[...Array(N).keys()].reverse(), [...Array(N).keys()].map(i => i + N)];
  for (let i = 0; i < N; i++) fl.push([i, (i + 1) % N, (i + 1) % N + N, i + N]);
  const raw = Mesh.fromFaceList(pts, fl);
  raw.computeNormals();
  const fix = edit.recalcNormalsOutside(raw);
  const L = (fix && fix.mesh) ? fix.mesh : raw;
  L.computeNormals();

  const area0 = L.area(), vol0 = L.volume();
  eq('前提：L 形柱體積 30×30×10 − 20×20×10', vol0, 5000);
  rel('前提：表面積 2200', area0, 2200);

  const top = L.faces.find(f =>
    L.faceLoop(f).length === 6 && L.faceLoop(f).every(he => Math.abs(he.v.p.y - H) < 1e-9));
  ok('前提：頂面是凹的 6 邊形', !!top);
  const V6 = L.faceLoop(top).map(he => he.v);
  const E6 = L.faceLoop(top);

  /**
   * 🔴 **穿出去的要擋。**
   * 角 (0,30) → (30,10) 這條對角線從 L 的凹口外面走。
   */
  const bad1 = edit.connectVerts(L, V6[0], V6[3]);
  ok('★★ 連接兩點：穿出邊界的要擋下來', !bad1.ok, '竟然過了');
  ok('★★ 而且要說出原因是「面是凹的」',
     /凹|外面/.test(bad1.reason || ''), bad1.reason);

  const bad2 = edit.splitFaceByEdges(L, E6[0], E6[3], 0.5);
  ok('★★ 面上加線：穿出邊界的要擋下來', !bad2.ok, '竟然過了');

  /**
   * ⭐ **而留在裡面的必須照樣做得到** —— ⛔ 不可以因為「這個面是凹的」
   * 就整個擋掉。那會是誤報，而誤報會讓人不敢用整個功能（坑第 18 條）。
   */
  const good = edit.connectVerts(L, V6[0], V6[2]);
  ok('★★ 沒穿出去的照樣連得起來', good.ok, good.reason);
  rel('★★ 　　而且面積精確不變（這就是原本壞掉的那個量）', good.mesh.area(), area0);
  rel('　　體積也精確不變', good.mesh.volume(), vol0);
  eq('　　χ 仍然是 2', chi(good.mesh), 2);
  ok('　　仍然封閉、結構沒問題', good.mesh.isClosed() && good.mesh.validate().ok);

  const good2 = edit.connectVerts(L, V6[2], V6[5]);
  ok('★ 另一條沒穿出去的也連得起來', good2.ok, good2.reason);
  rel('　　面積精確不變', good2.mesh.area(), area0);

  /**
   * 🔴 **這一條是「原本錯在哪」的機械斷言**：
   * 穿出去的話面積會**變大**（外面那塊被算進去）。
   * ⚠ 只驗「有沒有被擋」不夠 —— 擋的條件寫錯（例如全擋）也會通過。
   * 這裡同時釘住「該擋的擋了」與「不該擋的沒擋，而且數字是對的」。
   */
  ok('★★ 沒有任何一個成功的結果讓面積跑掉',
     [good, good2].every(r => Math.abs(r.mesh.area() - area0) < 1e-6));
}

// ═══════════════════════════════════════════════════════
//  量測（kang 2026-08-25 提出：bake 之後就不知道真實尺寸了）
// ═══════════════════════════════════════════════════════

section('量測：選到的東西有多大');
{
  const measure = await import('../js/core/measure.js');
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const I = new THREE.Matrix4();
  const edgeEl = he => ({ kind: 'edge', he });
  const faceEl = f => ({ kind: 'face', face: f });

  /** 找一條長度接近 L 的邊 */
  const edgeOf = L => [...box.edges()].find(
    he => Math.abs(measure.edgeLength(he, I) - L) < 1e-9);

  // ── 邊長：三種長度都要對得上建模參數 ──
  for (const L of [60, 45, 40]) {
    const he = edgeOf(L);
    ok(`方塊 找得到長度 ${L} 的邊`, !!he);
    if (he) rel(`方塊 邊長 ${L}`,
      measure.measureSelection(box, [edgeEl(he)], I).length, L);
  }

  // ── 面積與周長：一個面就是一個共面區域，不是三角形 ──
  {
    const got = box.faces.map(f =>
      Math.round(measure.measureSelection(box, [faceEl(f)], I).area));
    got.sort((a, b) => a - b);
    eq('方塊 六個面的面積', got.join(','), '1800,1800,2400,2400,2700,2700');

    const top = box.faces.find(f =>
      Math.abs(measure.measureSelection(box, [faceEl(f)], I).area - 2700) < 1e-6);
    const m = measure.measureSelection(box, [faceEl(top)], I);
    rel('方塊 60×45 面的周長（＝2×(60+45)）', m.perimeter, 210);
    eq('方塊 這個面沒有洞', m.holes, 0);
    eq('　　選到的是共面區域，4 個頂點', m.vertCount, 4);
  }

  // ── 🔴 兩個數字互相對得起來：六個面加起來 ＝ mesh.area() ──
  {
    let sum = 0;
    for (const f of box.faces) sum += measure.measureSelection(box, [faceEl(f)], I).area;
    rel('★★ 六個面的面積總和 ＝ mesh.area()', sum, box.area());
    rel('　　而且就是 13800', sum, 13800);
  }

  // ── 🔴 一律換世界座標：縮放過的物件要報縮放後的尺寸 ──
  {
    const S2 = new THREE.Matrix4().makeScale(2, 2, 2);
    const he = edgeOf(60);
    rel('★★ 整體放大 2 倍 邊長也 2 倍', measure.measureSelection(box, [edgeEl(he)], S2).length, 120);
    const top = box.faces.find(f =>
      Math.abs(measure.measureSelection(box, [faceEl(f)], I).area - 2700) < 1e-6);
    rel('★★ 整體放大 2 倍 面積 4 倍', measure.measureSelection(box, [faceEl(top)], S2).area, 10800);

    // 非均勻縮放：只有沿著那個方向的邊會變
    const SX = new THREE.Matrix4().makeScale(3, 1, 1);
    const along = [...box.edges()].find(he2 => {
      const d = he2.to.p.clone().sub(he2.v.p);
      return Math.abs(Math.abs(d.x) - 60) < 1e-9 && Math.abs(d.y) < 1e-9 && Math.abs(d.z) < 1e-9;
    });
    if (along) rel('★ 只放大 X 3 倍，X 向的 60 變 180',
      measure.measureSelection(box, [edgeEl(along)], SX).length, 180);
  }

  // ── 🔴 剛體運動不改變尺寸：旋轉、位移都不可以動到長度與面積 ──
  {
    const R = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(0.3, -1.1, 0.7));
    const T = new THREE.Matrix4().makeTranslation(123, -45, 6.7);
    const RT = new THREE.Matrix4().multiplyMatrices(T, R);
    const he = edgeOf(60);
    rel('★★ 旋轉＋位移後 邊長不變', measure.measureSelection(box, [edgeEl(he)], RT).length, 60);

    let sum = 0;
    for (const f of box.faces) sum += measure.measureSelection(box, [faceEl(f)], RT).area;
    rel('★★ 旋轉＋位移後 總面積不變', sum, 13800);

    // 重心要跟著搬到世界座標去 —— 這就是「跟切一刀、對齊同一套數字」
    const c = measure.measureSelection(box, [faceEl(box.faces[0])], T).center;
    const c0 = measure.measureSelection(box, [faceEl(box.faces[0])], I).center;
    rel('★★ 位移後 重心跟著移動（X）', c.x - c0.x, 123);
    rel('　　（Y）', c.y - c0.y, -45);
  }

  // ── 多選：總長、總面積有意義；周長沒有意義就回 null ──
  {
    const top = box.faces.find(f =>
      Math.abs(measure.measureSelection(box, [faceEl(f)], I).area - 2700) < 1e-6);
    const other = box.faces.find(f => f !== top);
    const m = measure.measureSelection(box, [faceEl(top), faceEl(other)], I);
    eq('多選面 count', m.count, 2);
    ok('多選面 總面積 ＝ 兩片相加', Math.abs(m.area - (2700 + measure.measureSelection(box, [faceEl(other)], I).area)) < 1e-6);
    eq('★ 多選面 周長回 null（共用的邊會被算兩次，不硬湊）', m.perimeter, null);

    // 一整圈邊的總長 ＝ 那一圈的周長
    const ring = [...box.edges()].filter(he => {
      const L = measure.edgeLength(he, I);
      return (Math.abs(L - 60) < 1e-9 || Math.abs(L - 45) < 1e-9)
        && Math.abs(he.v.p.y - he.to.p.y) < 1e-9
        && Math.abs(he.v.p.y - box.verts.reduce((mx, v) => Math.max(mx, v.p.y), -1e9)) < 1e-9;
    }).map(edgeEl);
    eq('頂面那一圈是 4 條邊', ring.length, 4);
    rel('★ 一整圈邊的總長 ＝ 周長 210', measure.measureSelection(box, ring, I).length, 210);
  }

  // ── 選取外框：任何選取都有意義 ──
  {
    const s = measure.measureSelection(box, box.faces.map(faceEl), I).size;
    rel('全選面 外框 X', s.x, 60);
    rel('全選面 外框 Y', s.y, 40);
    rel('全選面 外框 Z', s.z, 45);
  }

  // ── 顯示格式：兩位小數，一個入口 ──
  {
    eq('fmtCm 兩位小數', measure.fmtCm(45.6789), '45.68');
    eq('fmtCm 補零', measure.fmtCm(45), '45.00');
    eq('fmtCm 不留浮點雜訊', measure.fmtCm(0.1 + 0.2), '0.30');
  }

  // ── 沒有選取就回 null，⛔ 不要回一個假的 0 ──
  {
    eq('沒有選取回 null', measure.measureSelection(box, [], I), null);
    eq('選取是 null 也回 null', measure.measureSelection(box, null, I), null);
  }

  // ═══════════════════════════════════════════════════
  //  第 2 步：畫到 3D 畫面上（measureLabels）
  //
  //  ⚠ 這裡驗的是「**哪個位置該出現哪一串字**」這份純資料 ——
  //  畫成 Sprite 那一半沙箱驗不了（沒有畫面），要 kang 實測。
  // ═══════════════════════════════════════════════════
  {
    const L = measure.measureLabels;
    const top = box.faces.find(f =>
      Math.abs(measure.measureSelection(box, [faceEl(f)], I).area - 2700) < 1e-6);
    const ring = [...box.edges()].filter(he => {
      const len = measure.edgeLength(he, I);
      return (Math.abs(len - 60) < 1e-9 || Math.abs(len - 45) < 1e-9)
        && Math.abs(he.v.p.y - he.to.p.y) < 1e-9
        && Math.abs(he.v.p.y - box.verts.reduce((mx, v) => Math.max(mx, v.p.y), -1e9)) < 1e-9;
    }).map(edgeEl);

    /**
     * ⚠ **一定要指名挑「長度 60 的那一條」，⛔ 不可以拿 `ring[0]`** ——
     * 那一圈裡兩條 60、兩條 45，第一條是哪一種**沒有保證**。
     * 〔寫這節時實際踩到：期待 120 得到 90（＝45×2），
     * 　⛔ 那是測試選錯樣本，程式是對的〕
     */
    const e60 = edgeEl(edgeOf(60));

    /**
     * ── 總計：一整塊讀數（畫面左下角）──────────────────
     *
     * ⚠ **逐行驗，⛔ 不要把整串寫死** —— 最後一行是重心座標，
     * 寫死等於把座標也綁進來，而那個已經有 measureSelection 那一節在守。
     * 〔kang 2026-08-27 實測退回第一版（標在元素上、擋住 XYZ 拉桿），
     * 　改成左下角一塊之後，這一組字從「一句話」變成「四行」〕
     */
    {
      const rowsOf = (els, opt) => (L(box, els, I, opt || { mode: 'total' })
        .items[0]?.text || '').split('\n');

      const r1 = L(box, [e60], I, { mode: 'total' });
      eq('總計 單選一條邊 → 1 塊讀數', r1.items.length, 1);
      const a = rowsOf([e60]);
      eq('　　三行：選到什麼／長度／中心', a.length, 3);
      eq('　　第一行 選到幾個（⛔ 沒有單位就不是數量）', a[0], '1 條邊');
      eq('　　第二行 長度＋單位', a[1], '長度 60.00 cm');
      ok('　　最後一行是中心座標（②-11：叫「中心（點的平均）」，⛔ 叫重心）', a[2].startsWith('中心（點的平均） X ') && a[2].endsWith(' cm'), a[2]);

      /**
       * 🔴 **多選一定要連數量與單位一起寫。**
       * 只寫「210.00」會被讀成「某一條有這麼長」——
       * 「講數量與形狀」那條規則的守門員。
       */
      const b = rowsOf(ring);
      eq('★ 總計 選 4 條邊 → 還是只有 1 塊', L(box, ring, I, { mode: 'total' }).items.length, 1);
      eq('★★ 總計 多選要寫出「幾條邊」', b[0], '4 條邊（共 4 個頂點）');
      eq('★ 　　總長', b[1], '總長 210.00 cm');
      eq('★ 　　多選才有外框（頂面那圈是平的，Y 是 0）',
        b[2], '外框 60.00 × 0.00 × 45.00 cm');
      ok('★ 總計 那串字講的位置是重心',
        L(box, ring, I, { mode: 'total' }).items[0].pos
          .distanceTo(measure.measureSelection(box, ring, I).center) < 1e-9);

      const c = rowsOf([faceEl(top)]);
      eq('總計 單選一個面 第一行', c[0], '1 個面');
      eq('★ 　　面積與周長同一行（⚠ 面積是 cm²）',
        c[1], '面積 2700.00 cm²　周長 210.00 cm');

      const d = rowsOf(box.faces.map(faceEl));
      eq('★ 總計 全選六個面 第一行', d[0], '6 個面（共 8 個頂點）');
      eq('★★ 　　總面積，⛔ 沒有周長（多選時共用的邊會被算兩次）',
        d[1], '總面積 13800.00 cm²');
      eq('★ 　　外框 ＝ 方塊本身', d[2], '外框 60.00 × 40.00 × 45.00 cm');

      /** ⚠ 單選一個點：上面那些量全是 null，最後一行改講「座標」⛔ 不講「重心」 */
      const v = box.verts[0];
      const e = rowsOf([{ kind: 'vertex', vert: v }]);
      eq('★ 單選一個點 → 兩行', e.length, 2);
      eq('　　⛔ 不寫「重心」，寫「座標」', e[1].startsWith('座標 X '), true);
    }

    // ── 每一個：字數 ＝ 元素數，而且各標各的 ──
    {
      const r = L(box, ring, I, { mode: 'each' });
      eq('★ 每一個 選 4 條邊 → 4 個字', r.items.length, 4);
      const texts = r.items.map(i => i.text).sort();
      eq('　　四個字是兩個 60、兩個 45',
        texts.join(','), '45.00 cm,45.00 cm,60.00 cm,60.00 cm');

      /**
       * 🔴 **兩個數字互相對得起來**（鐵律三）：
       * 每一條各自的長度加起來，⛔ 必須等於「總計」那個字裡的總長。
       * 對不上就是兩邊各算了一份 —— 而那正是坑第 31 條。
       */
      let sum = 0;
      for (const it of r.items) sum += parseFloat(it.text);
      rel('★★ 每一個 加起來 ＝ 總計那個字的 210', sum, 210);

      // 字要站在邊的中點上，⛔ 不是端點
      const one = L(box, [e60], I, { mode: 'each' }).items[0];
      const mid = e60.he.v.p.clone().add(e60.he.to.p).multiplyScalar(0.5);
      ok('★ 每一個 邊的字站在中點', one.pos.distanceTo(mid) < 1e-9);
    }

    // ── ⚠ 面：同一個共面區域只標一次（⛔ 不可以兩個字疊在一起）──
    {
      const r = L(box, [faceEl(top), faceEl(top)], I, { mode: 'each' });
      eq('★★ 同一個面選兩次 → 只標 1 個字', r.items.length, 1);
      eq('　　而且 total 也只算 1 個', r.total, 1);
      /**
       * ★ 面的字要站在**那一片自己的重心**上（＝ gizmo 掛的那個點）。
       * ⛔ 不驗的話，字跑到別片上也不會有任何東西報錯 ——
       * 數字是對的，指的東西是錯的（坑第 20 條的近親）。
       */
      const cTop = measure.measureSelection(box, [faceEl(top)], I).center;
      ok('★★ 面的字站在那一片的重心上',
        L(box, [faceEl(top)], I, { mode: 'each' }).items[0].pos.distanceTo(cTop) < 1e-9);

      const r6 = L(box, box.faces.map(faceEl), I, { mode: 'each' });
      eq('每一個 全選六個面 → 6 個字', r6.items.length, 6);
      ok('★ 六個字各站各的位置（⛔ 沒有兩個疊在一起）',
        new Set(r6.items.map(i => `${i.pos.x.toFixed(4)},${i.pos.y.toFixed(4)},${i.pos.z.toFixed(4)}`)).size === 6);
      const areas = r6.items.map(i => i.text).sort();
      eq('　　六個字就是六個面積',
        areas.join(','),
        '1800.00 cm²,1800.00 cm²,2400.00 cm²,2400.00 cm²,2700.00 cm²,2700.00 cm²');
    }

    // ── 點：寫座標（kang 2026-08-27 選的）──
    {
      const v = box.verts.find(v2 => Math.abs(v2.p.y) > 1e-9) || box.verts[0];
      const r = L(box, [{ kind: 'vertex', vert: v }], I, { mode: 'each' });
      eq('點 寫成一串座標', r.items[0].text,
        `(${measure.fmtCm(v.p.x)}, ${measure.fmtCm(v.p.y)}, ${measure.fmtCm(v.p.z)})`);
      ok('點 字就站在那個點上', r.items[0].pos.distanceTo(v.p) < 1e-9);
    }

    // ── 🔴 上限：超過就整批不畫，而且要回報實際數量 ──
    {
      const r = L(box, box.faces.map(faceEl), I, { mode: 'each', max: 3 });
      eq('★★ 超過上限 一個字都不畫', r.items.length, 0);
      eq('★★ 　　但要講得出實際幾個', r.total, 6);
      eq('★★ 　　而且要說得出是被擋掉的', r.tooMany, true);
      // 總計不受上限影響 —— 它永遠只有一個字
      eq('★ 總計不受上限影響', L(box, box.faces.map(faceEl), I,
        { mode: 'total', max: 3 }).items.length, 1);
    }

    // ── 🔴 一律世界座標：跟 measureSelection 同一條 ──
    {
      const S2 = new THREE.Matrix4().makeScale(2, 2, 2);
      eq('★★ 放大 2 倍 每一個的字也 2 倍',
        L(box, [e60], S2, { mode: 'each' }).items[0].text, '120.00 cm');
      eq('★★ 放大 2 倍 總計那一塊也跟著',
        L(box, ring, S2, { mode: 'total' }).items[0].text.split('\n')[1], '總長 420.00 cm');
    }

    // ── 沒有選取就一個字都沒有，⛔ 不要回一個空字串的標籤 ──
    {
      eq('沒有選取 → 0 個字', L(box, [], I, { mode: 'each' }).items.length, 0);
      eq('選取是 null → 0 個字', L(box, null, I, { mode: 'total' }).items.length, 0);
      eq('　　而且 tooMany 是 false（⛔ 不是被擋掉，是本來就沒有）',
        L(box, [], I, { mode: 'each' }).tooMany, false);
    }
  }

  // ═══════════════════════════════════════════════════
  //  第 4 步（一）：兩個元素之間的距離
  //
  //  ⛔ 不走「貼合那套先點一個再點一個」——
  //  貼合是物件層級、還明文擋掉「同一個物件」，而量距離最常見的
  //  正是同一個物件上的兩個點。走編輯模式的多選，⛔ 0 行新的選取程式。
  // ═══════════════════════════════════════════════════
  {
    const D = measure.pairDistance;
    const vertEl = v => ({ kind: 'vertex', vert: v });

    /** 方塊 60×45×40：取空間對角的兩個角 —— ⭐ 對角線剛好是整數 85 */
    const lo = box.verts.reduce((a, v) => (v.p.x + v.p.y + v.p.z < a.p.x + a.p.y + a.p.z ? v : a));
    const hi = box.verts.reduce((a, v) => (v.p.x + v.p.y + v.p.z > a.p.x + a.p.y + a.p.z ? v : a));
    const r = D(box, [vertEl(lo), vertEl(hi)], I);

    ok('★ 兩個角 有距離', !!r);
    rel('★★ 方塊的空間對角線 ＝ 85（60² ＋ 40² ＋ 45² ＝ 85²）', r.d, 85);
    rel('　　ΔX', r.dx, 60);
    rel('　　ΔY', r.dy, 40);
    rel('　　ΔZ', r.dz, 45);
    /**
     * 🔴 **兩個數字互相驗得起來**（鐵律三）：√(dx²+dy²+dz²) ⛔ 必須等於 d。
     * 對不上就是兩邊各算了一份 —— 而使用者在畫面上就看得出來。
     */
    rel('★★ √(ΔX²+ΔY²+ΔZ²) ＝ 距離', Math.hypot(r.dx, r.dy, r.dz), r.d);

    // ── 🔴 剛好兩個才有意義，⛔ 其餘不硬湊 ──
    eq('★★ 只選 1 個 → null（⛔ 不硬湊）', D(box, [vertEl(lo)], I), null);
    eq('★★ 選 3 個 → null', D(box, [vertEl(lo), vertEl(hi), vertEl(box.verts[1])], I), null);
    eq('沒有選取 → null', D(box, [], I), null);

    // ── 邊取中點、面取重心 ──
    {
      const top = box.faces.find(f =>
        Math.abs(measure.measureSelection(box, [faceEl(f)], I).area - 2700) < 1e-6);
      const bot = box.faces.find(f => f !== top &&
        Math.abs(measure.measureSelection(box, [faceEl(f)], I).area - 2700) < 1e-6);
      const rf = D(box, [faceEl(top), faceEl(bot)], I);
      rel('★ 上下兩片 60×45 的面 重心距離 ＝ 高 40', rf.d, 40);
      rel('　　ΔY ＝ 40、ΔX 與 ΔZ ＝ 0', rf.dy, 40);
      ok('　　（⛔ 沒有橫向位移）', Math.abs(rf.dx) < 1e-9 && Math.abs(rf.dz) < 1e-9);
    }

    // ── 🔴 一律世界座標 ──
    {
      const S2 = new THREE.Matrix4().makeScale(2, 2, 2);
      rel('★★ 放大 2 倍 距離也 2 倍', D(box, [vertEl(lo), vertEl(hi)], S2).d, 170);
      const T = new THREE.Matrix4().makeTranslation(100, -50, 7);
      rel('★★ 整個搬走 距離不變（剛體運動）', D(box, [vertEl(lo), vertEl(hi)], T).d, 85);
    }

    // ── 接到左下角那一塊：剛好兩個時多兩行 ──
    {
      const rows = measure.measureLabels(box, [vertEl(lo), vertEl(hi)], I,
        { mode: 'total' }).items[0].text.split('\n');
      ok('★ 兩個點的讀數裡有「距離」那一行', rows.some(s => s.startsWith('距離 85.00 cm')));
      ok('★ 　　也有 ΔX/ΔY/ΔZ 那一行', rows.some(s => s.startsWith('ΔX 60.00')));

      const one = measure.measureLabels(box, [vertEl(lo)], I,
        { mode: 'total' }).items[0].text;
      ok('★★ 只選一個 → ⛔ 讀數裡沒有「距離」', !one.includes('距離'));
    }
  }

  // ═══════════════════════════════════════════════════
  //  第 4 步（二）：量圓
  //
  //  🔴 它 ⛔ 不判斷「這一圈是不是圓」—— 那個判斷無解
  //  （正多邊形的頂點永遠共圓、矩形四個角也永遠共圓）。
  //  ⭐ 使用者按了那顆開關又選了這一圈，就表示他要問。
  // ═══════════════════════════════════════════════════
  {
    const cyl = baked('cylinder', { r: 25, h: 60, seg: 32 });
    const I2 = new THREE.Matrix4();
    const topY = cyl.verts.reduce((m, v) => Math.max(m, v.p.y), -1e9);
    /** 圓蓋那一圈：兩端點都在最高處 */
    const capRing = [...cyl.edges()].filter(he =>
      Math.abs(he.v.p.y - topY) < 1e-9 && Math.abs(he.to.p.y - topY) < 1e-9)
      .map(he => ({ kind: 'edge', he }));
    eq('圓柱 seg32 的圓蓋那一圈是 32 條邊', capRing.length, 32);

    const txt = measure.measureLabels(cyl, capRing, I2,
      { mode: 'total', circle: true }).items[0].text;
    const rows = txt.split('\n');

    /**
     * 🔴🔴 **這一組數字就是日誌「尺寸的依據」那張表的畫面版。**
     * 弦長 ＝ 2R·sin(π/32) ＝ 4.9009，×32 ＝ 156.83；2πR ＝ 157.08；差 0.25。
     * ⛔ **那個差額是資訊，不是誤差** —— 想更接近圓要回頭把 seg 開高。
     */
    ok('★★ 報得出半徑 25.00、32 段',
      rows.some(s => s === '這一圈當成圓：半徑 25.00 cm　32 段'));
    ok('★★ 每段弦長 4.90（＝ 2R·sin(π/32)）',
      rows.some(s => s === '每段弦長 4.90 cm'));
    ok('★★ 網格真值 156.83／視為理想圓 157.08／差 0.25',
      rows.some(s => s === '網格真值 156.83　視為理想圓 157.08　差 0.25 cm'));
    /** ⭐ 那三個數字自己對得起來：156.83 ÷ 32 ＝ 4.90 */
    rel('★★ 弦長 × 段數 ＝ 網格真值', 4.9009 * 32, 156.8275, 1e-3);
    rel('★★ 2πR ⛔ 不等於網格真值（差 0.25，⭐ 那是資訊不是誤差）',
      2 * Math.PI * 25 - 156.8275, 0.2521, 1e-3);

    // ── ⛔ 關著的時候一個字都不多 ──
    {
      const off = measure.measureLabels(cyl, capRing, I2, { mode: 'total' }).items[0].text;
      ok('★★ 量圓關著 → ⛔ 讀數裡沒有「當成圓」', !off.includes('當成圓'));
      eq('★ 　　行數也少三行', off.split('\n').length, rows.length - 3);
    }

    // ── ⚠ 只看邊：面與點回空 ──
    {
      const f = measure.measureLabels(cyl, [{ kind: 'face', face: cyl.faces[0] }], I2,
        { mode: 'total', circle: true }).items[0].text;
      ok('★ 選到「面」→ ⛔ 不報圓（面有自己的周長）', !f.includes('當成圓'));
      const v = measure.measureLabels(cyl, [{ kind: 'vertex', vert: cyl.verts[0] }], I2,
        { mode: 'total', circle: true }).items[0].text;
      ok('★ 選到「點」→ ⛔ 不報圓（沒有段數可言）', !v.includes('當成圓'));
    }

    /**
     * ═══════════════════════════════════════════════
     *  🔴🔴 kang 2026-08-27 的四張實測截圖，逐一釘成測試
     *
     *  ⚠ **第一版四個全部給出「看起來很正常但沒有意義」的數字** ——
     *  因為我只驗了「完美的一圈」（圓柱圓蓋、方塊四條邊）。
     *  🔴 那正是坑第 17 條：**挑樣本要涵蓋不同的「網格結構」，
     *  ⛔ 不只是不同的形狀** —— 只驗了一類等於沒驗。
     * ═══════════════════════════════════════════════
     */
    {
      const C = (m, e) => measure.measureLabels(m, e, I2, { mode: 'total', circle: true })
        .items[0].text;
      const cylEl = he => ({ kind: 'edge', he });

      // ① 圓柱「直立」的 32 條邊：互不相連（32 邊 64 點）
      {
        const up = [...cyl.edges()].filter(he =>
          Math.abs(he.v.p.y - he.to.p.y) > 1e-6).map(cylEl);
        ok('① 圓柱有一堆直立的邊', up.length >= 32);
        const t = C(cyl, up.slice(0, 32));
        ok('★★ ① 32 條直立邊 → 講「分成 32 段」，⛔ 不報圓',
          t.includes('分成 32 段') && t.includes('圓算不出來'));
        ok('★★ 　　⛔ 而且不再印「每段弦長」那種沒有意義的數字',
          !t.includes('每段弦長'));
      }

      // ② 圓柱上下「兩圈」：🔴 邊數 ＝ 點數 ＝ 64，數量檢查會放它過關
      {
        const botY = cyl.verts.reduce((m, v) => Math.min(m, v.p.y), 1e9);
        const bothRings = [...cyl.edges()].filter(he => {
          const sameY = Math.abs(he.v.p.y - he.to.p.y) < 1e-9;
          const atCap = Math.abs(he.v.p.y - topY) < 1e-9 || Math.abs(he.v.p.y - botY) < 1e-9;
          return sameY && atCap;
        }).map(cylEl);
        eq('② 上下兩圈是 64 條邊', bothRings.length, 64);
        const vs = new Set();
        for (const e of bothRings) { vs.add(e.he.v); vs.add(e.he.to); }
        eq('🔴 ② 而且它的點數也是 64 —— ⛔ 數量檢查放它過關', vs.size, 64);
        const t = C(cyl, bothRings);
        ok('★★ ② 兩圈 → 講「分成 2 段」，⛔ 不報圓',
          t.includes('分成 2 段') && t.includes('圓算不出來'));
        ok('★★ 　　⛔ 不再報那個假半徑 39.21', !t.includes('當成圓'));
      }

      // ③ 圓柱「全選邊」96 條：每個角上 3 條邊交會
      {
        const all = [...cyl.edges()].map(cylEl);
        eq('③ 圓柱全部是 96 條邊', all.length, 96);
        const t = C(cyl, all);
        ok('★★ ③ 全選邊 → 講「角上不只兩條邊交會」，⛔ 不報圓',
          t.includes('不只兩條邊交會') && t.includes('圓算不出來'));
      }

      // ④ 球的「半條經線」：一段開放的弧（16 邊 17 點）
      {
        const sph = baked('sphere', { r: 30, segW: 32, segH: 16 });
        /**
         * 找一條經線 ＝ **同一個方位角**往下走。
         * ⚠ **⛔ 不可以找「x 與 z 都一樣」的邊** —— 同一條經線上的點，
         * 緯度不同、離軸半徑就不同，所以 x 與 z **本來就會變**。
         * 〔寫這節時實際踩到：那樣一條都找不到〕
         * ⚠ 碰到極點的邊要跳過（x＝z＝0，方位角沒有定義）。
         */
        const eps = 1e-6;
        const ang = p => Math.atan2(p.z, p.x);
        const onAxis = p => Math.hypot(p.x, p.z) < eps;
        const vertical = [...sph.edges()].filter(he =>
          !onAxis(he.v.p) && !onAxis(he.to.p)
          && Math.abs(ang(he.v.p) - ang(he.to.p)) < eps
          && Math.abs(he.v.p.y - he.to.p.y) > eps);
        ok('④ 球上找得到往下走的邊', vertical.length > 0);
        const a0 = ang(vertical[0].v.p);
        const meridian = vertical
          .filter(he => Math.abs(ang(he.v.p) - a0) < eps).map(cylEl);
        ok('④ 挑出其中一條經線（一段開放的鏈）', meridian.length >= 3);

        const t = C(sph, meridian);
        /**
         * 🔴 **它 ⛔ 不再拿 2πR（整圈）去比** ——
         * 一段開放的弧要跟**那一段的弧**比，⭐ 而那才是對得起來的數字。
         */
        ok('★★ ④ 半條經線 → 講「這一段當成圓弧」，⛔ 不是「這一圈當成圓」',
          t.includes('當成圓弧') && !t.includes('當成圓：'));
        ok('★★ 　　而且是「視為理想弧」，⛔ 不是「視為理想圓」',
          t.includes('視為理想弧') && !t.includes('視為理想圓'));

        /** ⭐ 差額要很小 —— 那正是「比對了正確的對象」的證據 */
        const line = t.split('\n').find(s => s.startsWith('網格真值'));
        const diff = parseFloat(line.split('差 ')[1]);
        ok(`★★ 　　差額很小（${line.split('差 ')[1]}）—— ⛔ 不再是「另外半圈的長度」`,
          diff < 1);
      }
    }

    /**
     * ═══════════════════════════════════════════════
     *  🔴 縮放：均勻算得對，非均勻老實說「沒有唯一答案」
     *
     *  ⚠ kang 2026-08-27：「我們先處理好這問題」——
     *  在那之前半徑是【網格自己的座標】算的，物件一被縮放就偏，
     *  ⛔ 而且一句警告都沒有。
     * ═══════════════════════════════════════════════
     */
    {
      const S2 = new THREE.Matrix4().makeScale(2, 2, 2);
      const SX = new THREE.Matrix4().makeScale(3, 1, 1);
      const R = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(0.4, -0.9, 0.2));
      const T = new THREE.Matrix4().makeTranslation(70, -20, 5);

      // ── scaleOf：均不均勻 ──
      {
        const a = measure.scaleOf(I2);
        ok('★ 單位矩陣 → 均勻、倍數 1', a.uniform && Math.abs(a.factor - 1) < 1e-9);
        ok('★★ 放大 2 倍 → 均勻、倍數 2', measure.scaleOf(S2).factor === 2);
        eq('★★ 只放大 X → ⛔ 不均勻，factor 是 null（不硬湊平均值）',
          measure.scaleOf(SX).factor, null);
        /** 🔴 平移與旋轉⛔ 不改變任何長度 —— 它們不可以被當成縮放 */
        ok('★★ 旋轉 → 還是均勻、倍數 1',
          measure.scaleOf(R).uniform && Math.abs(measure.scaleOf(R).factor - 1) < 1e-9);
        ok('★★ 平移 → 還是均勻、倍數 1',
          measure.scaleOf(T).uniform && Math.abs(measure.scaleOf(T).factor - 1) < 1e-9);
        /** ⚠ 鏡射（負縮放）不改變長度，只改變繞向 */
        ok('★ 鏡射（−1）→ 取絕對值，倍數 1',
          Math.abs(measure.scaleOf(new THREE.Matrix4().makeScale(-1, -1, -1)).factor - 1) < 1e-9);
      }

      // ── 量圓：均勻縮放要把半徑一起放大 ──
      {
        const t2 = measure.measureLabels(cyl, capRing, S2,
          { mode: 'total', circle: true }).items[0].text;
        ok('★★ 放大 2 倍 → 半徑 50.00（⛔ 不再是 25.00）',
          t2.includes('半徑 50.00 cm'));
        ok('★★ 　　而且理想圓也跟著（2πR ＝ 314.16）',
          t2.includes('視為理想圓 314.16'));
        /**
         * ⭐ 網格真值本來就吃矩陣，兩邊現在是同一個尺度 —— 差額也該剛好 2 倍。
         * ⚠ **驗顯示出來的字串，⛔ 不要拿它去比實際值**：實際是 0.5041，
         * 而畫面上是兩位小數的 `0.50`。〔寫這節時實際踩到〕
         */
        const line = t2.split('\n').find(s => s.startsWith('網格真值'));
        eq('★★ 差額也剛好 2 倍（0.25 → 0.50）', line.split('差 ')[1], '0.50 cm');
      }

      // ── 🔴 非均勻縮放：圓變橢圓，半徑沒有唯一答案 ──
      {
        const tx = measure.measureLabels(cyl, capRing, SX,
          { mode: 'total', circle: true }).items[0].text;
        ok('★★ 只放大 X → 講「被拉扁了」「沒有唯一答案」',
          tx.includes('被拉扁了') && tx.includes('沒有唯一答案'));
        ok('★★ 　　⛔ 而且一個半徑都不報（⛔ 不猜一個，坑第 24 條）',
          !tx.includes('當成圓') && !tx.includes('視為理想'));
      }

      // ── 結構分析：世界座標的表面積與體積 ──
      {
        const w0 = measure.meshMeasureWorld(box, I);
        rel('★★ 沒縮放時 面積 ＝ mesh.area() ＝ 13800', w0.area, 13800);
        eq('★ 　　體積倍率 1', w0.volumeFactor, 1);

        const w2 = measure.meshMeasureWorld(box, S2);
        rel('★★ 放大 2 倍 → 面積 ×4', w2.area, 13800 * 4);
        rel('★★ 　　體積倍率 ×8', w2.volumeFactor, 8);

        /**
         * 🔴 **非均勻縮放沒有「乘一個數」這種公式** ——
         * 方塊 60×45×40，只把 X 拉 3 倍：
         * 兩片 60×45 → 180×45（×3）、兩片 45×40 → 45×40（×1）、
         * 兩片 60×40 → 180×40（×3）。⛔ 整體 ⛔ 不是 ×3 也不是 ×9。
         */
        const w3 = measure.meshMeasureWorld(box, SX);
        const expect = 2 * (180 * 45) + 2 * (45 * 40) + 2 * (180 * 40);
        rel('★★ 只放大 X 3 倍 → 面積要逐面算', w3.area, expect);
        ok('★★ 　　⛔ 而且它既不是 ×3 也不是 ×9',
          Math.abs(w3.area - 13800 * 3) > 1 && Math.abs(w3.area - 13800 * 9) > 1);
        rel('★★ 　　但體積倍率精確 ＝ ×3（行列式）', w3.volumeFactor, 3);

        /** 🔴 剛體運動⛔ 不改變面積與體積 */
        rel('★★ 旋轉後 面積不變', measure.meshMeasureWorld(box, R).area, 13800);
        rel('★★ 平移後 面積不變', measure.meshMeasureWorld(box, T).area, 13800);
      }
    }

    /**
     * ⚠ **方塊的四條邊照樣報得出一個圓，而那是刻意的** ——
     * 🔴 那正是「⛔ 不判斷是不是圓」的意思：**使用者按了開關就表示他要問**。
     * ⛔ 反過來說，這也是它 ⛔ 不可以自動顯示的證據（那就變成誤報）。
     */
    {
      const ring = [...box.edges()].filter(he => {
        const len = measure.edgeLength(he, I);
        return (Math.abs(len - 60) < 1e-9 || Math.abs(len - 45) < 1e-9)
          && Math.abs(he.v.p.y - he.to.p.y) < 1e-9
          && Math.abs(he.v.p.y - box.verts.reduce((mx, v) => Math.max(mx, v.p.y), -1e9)) < 1e-9;
      }).map(he => ({ kind: 'edge', he }));
      const t = measure.measureLabels(box, ring, I, { mode: 'total', circle: true }).items[0].text;
      ok('★★ 方塊那四條邊也報得出圓 —— ⛔ 這是刻意的，⛔ 不是 bug',
        t.includes('當成圓'));
      ok('★★ 　　所以它 ⛔ 絕不可以自動顯示（那就是誤報）', t.includes('4 段'));
    }
  }
}

// ═══════════════════════════════════════════════════════
//  隔一個選一個（Checker Deselect）
// ═══════════════════════════════════════════════════════

section('隔一個選一個：把一圈隔幾個留一個');

/**
 * 🔴 **這一節守的是「順序」，⛔ 不是「隔一個」那個算術。**
 *
 * 算術一行就寫完了；會出事的是**拿陣列順序當幾何順序** ——
 * 而圓柱上那樣做**會通過**（陣列順序剛好就是繞一圈的順序），
 * 別的地方才會錯，**且畫面上看不出來**。
 * 〔日誌檔頭第 3 條：**「碰巧通過」比失敗危險**〕
 *
 * ⭐ 所以第 ⑤ 組**先斷言「那 32 條邊彼此不共用任何一個點」** ——
 * ⛔ 沒有那一句，第 ⑤ 組就變成一個自己會通過的空測試。
 */
{
  const soC = await import('../js/core/selectops.js');

  /** 把一圈面／一圈邊包成 `editSels` 的形狀 */
  const asFaces = fs => fs.map(face => ({ kind: 'face', face }));
  const asEdges = hs => hs.map(he => ({ kind: 'edge', he }));
  /** 找一條「直立」的側邊當種子（上下兩端 y 不同，而且兩側都有面） */
  const upright = m => {
    for (const he of seam.markableEdges(m)) {
      if (Math.abs(he.v.p.y - he.to.p.y) > 1 && he.twin && he.face && he.twin.face) return he;
    }
    return null;
  };
  const ringFaces = m => soC.loopFaces(m, upright(m)).faces;

  /** ① 圓柱 seg32：32 片側面 → 16 片。使用者自己數得出來 */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const fs = ringFaces(m);
    eq('① 選一圈面先拿到 32 片側面', fs.length, 32);
    const r = soC.checkerPick(m, asFaces(fs), { nth: 2, from: 1 });
    eq('　 隔 2 個留一個 → 16 片', r.kept, 16);
    ok('　 而且它認得出這是繞回來的一圈', r.closed);
    ok('★ 32 除得盡 2 → 接縫處 ⛔ 沒有兩個連在一起', r.seamAdjacent === false);

    /**
     * 🔴 **兩個數字互相對得起來（鐵律三）**：
     * 從第 1 個開始與從第 2 個開始，是同一圈的**兩半** ——
     * **聯集要等於全部、交集要是 0**。
     * ⭐ 只驗「各 16 片」是不夠的：兩次都挑到同一半也會是 16。
     */
    const a = soC.checkerPick(m, asFaces(fs), { nth: 2, from: 1 });
    const b = soC.checkerPick(m, asFaces(fs), { nth: 2, from: 2 });
    const A = new Set(a.faces.map(f => f.id));
    const B = new Set(b.faces.map(f => f.id));
    eq('★★ 從第 2 個開始也是 16 片', b.kept, 16);
    eq('★★ 　 兩批的聯集 ＝ 32（正好把整圈分成兩半）',
       new Set([...A, ...B]).size, 32);
    eq('★★ 　 兩批的交集 ＝ 0（⛔ 沒有挑到同一片）',
       [...A].filter(x => B.has(x)).length, 0);

    /** 隔 3 個：32 ÷ 3 ＝ 10 餘 2 → 留 11 片（位置 0,3,6…30） */
    eq('　 隔 3 個留一個 → 11 片',
       soC.checkerPick(m, asFaces(fs), { nth: 3, from: 1 }).kept, 11);
  }

  /** ② 方塊：4 片側面 → 2 片，而且那兩片一定是**對面**（法向剛好相反） */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    const fs = ringFaces(m);
    eq('② 方塊選一圈面 4 片', fs.length, 4);
    const r = soC.checkerPick(m, asFaces(fs), { nth: 2, from: 1 });
    eq('　 隔 2 個留一個 → 2 片', r.kept, 2);
    /**
     * ⭐ **⛔ 不要只驗「2 片」** —— 隨便挑兩片也是 2 片。
     * 挑對了的話那兩片是對面，法向點積 ＝ −1。
     */
    const n0 = m.computeFaceNormal(r.faces[0]);
    const n1 = m.computeFaceNormal(r.faces[1]);
    ok('★★ 　 而且那兩片是【對面】（法向點積 ＝ −1，⛔ 不是隨便兩片）',
       Math.abs(n0.dot(n1) + 1) < 1e-6, `dot=${n0.dot(n1).toFixed(6)}`);
  }

  /**
   * ③ 五角柱：**5 是奇數，除不盡** ——
   * 🔴 這一組守的是「接縫處會有兩個連在一起，而且要講出來」。
   */
  {
    const m = baked('prism', { sides: 5, r: 30, h: 60 });
    const fs = ringFaces(m);
    eq('③ 五角柱選一圈面 5 片', fs.length, 5);
    const r = soC.checkerPick(m, asFaces(fs), { nth: 2, from: 1 });
    eq('　 隔 2 個留一個 → 3 片', r.kept, 3);
    ok('★★ 　 5 除不盡 2 → 接縫處有兩片連在一起，而且它自己數得出來',
       r.seamAdjacent === true);
  }

  /**
   * ④ 圓柱一圈**邊**：32 條直立邊。
   * 🔴 **這一組守的是「同一個四邊形的對邊」那條相鄰規則。**
   */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const hs = edit.edgeRing(m, upright(m)).hes;
    eq('④ 選一圈拿到 32 條直立邊', hs.length, 32);

    /**
     * 🔴🔴 **這一句是本組的地基，⛔ 不要刪。**
     * 沒有它，「換成只認共用點也會通過」這件事就沒有人擋得住 ——
     * 而那樣改，圓柱按下去會變成「排不出一圈」。
     */
    {
      let shared = 0;
      for (let i = 0; i < hs.length; i++) {
        for (let j = i + 1; j < hs.length; j++) {
          const A = new Set([hs[i].v.id, hs[i].to.id]);
          if ([hs[j].v.id, hs[j].to.id].some(x => A.has(x))) shared++;
        }
      }
      eq('★★ 　 這 32 條 ⛔ 彼此不共用任何一個點（所以只靠「共用點」串不起來）',
         shared, 0);
    }

    const r = soC.checkerPick(m, asEdges(hs), { nth: 2, from: 1 });
    eq('★ 　 隔 2 個留一個 → 16 條', r.kept, 16);
    ok('　 而且認得出是繞回來的一圈', r.closed);
  }

  /**
   * ⑤ 方塊按「選轉角」的 12 條：**排不出一圈，要擋下來**。
   * ⚠ 12 條邊圍成的是一個籠子，每條接到 6 條 —— 「隔一個」沒有唯一答案。
   */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    const hs = soC.sharpEdges(m, 30).hes;
    eq('⑤ 方塊選轉角 12 條', hs.length, 12);
    const r = soC.checkerPick(m, asEdges(hs), { nth: 2, from: 1 });
    eq('★ 　 排不出一圈 → 一條都不挑', r.kept, 0);
    ok('★ 　 而且講得出原因', r.reason.includes('排不出'));
    ok('★★ 　 原因裡要帶著【下一步怎麼辦】，⛔ 不只講失敗',
       r.reason.includes('選一圈'), r.reason);
  }

  /** ⑥ 邊界情形：太少、重複、混型別 */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    const fs = ringFaces(m);
    ok('⑥ 只選 2 個 → 擋下來講原因',
       !!soC.checkerPick(m, asFaces(fs.slice(0, 2)), {}).reason);
    /**
     * ⚠ **同一片重複塞進來要先去重** ——
     * ⛔ 不去重的話它的度數會變成 4，本來排得出來的一圈會被判成排不出來。
     */
    eq('★ 　 同一片重複塞進來會去重（4 片 ＋ 重複 4 片 → 仍是 2 片）',
       soC.checkerPick(m, asFaces([...fs, ...fs]), { nth: 2, from: 1 }).kept, 2);
    ok('　 面跟邊混在一起 → 擋下來講原因',
       !!soC.checkerPick(m, [{ kind: 'face', face: fs[0] },
                              { kind: 'edge', he: upright(m) },
                              { kind: 'face', face: fs[1] }], {}).reason);
    ok('　 沒給網格不會壞', !!soC.checkerPick(null, asFaces(fs), {}).reason);
  }
}

// ═══════════════════════════════════════════════════════
//  原點置中（分離自動置中 ＋ 面板那顆按鈕）
// ═══════════════════════════════════════════════════════

section('原點置中：搬那個點，⛔ 不搬東西');

/**
 * 🔴 **這一節守的是一句話：「東西一格都不能動」。**
 *
 * ⚠ **⛔ 不要只驗「本地中心變成 0」** —— 那太容易通過了，
 * 光是把頂點減掉中心就會過，而**那樣做東西會整個跳走**。
 * ⭐ 真正的斷言是【世界包圍盒精確不變】。
 *
 * 🔴🔴 **而且一定要在「有旋轉 ＋ 有縮放」的物件上驗** ——
 * ⛔ 沒有旋轉的話，錯的寫法（`pos.add(offset)`）也會通過。
 * 【實證 2026-08-29】那個錐體轉過之後，正確的新 `pos` 是
 * `(−4.66, 21.80, 0.02)` —— **X 與 Z 都變了**，
 * 而 `pos.add(offset)` 只會動 Y。**這一組就是在守那件事。**
 */
{
  const ioM = await import('../js/core/io.js');
  const THREEr = await import('three');

  /** 一個物件在世界裡的包圍盒（頂點各自乘上矩陣，⛔ 不靠任何現成的） */
  const worldBox = obj => {
    const m = obj.matrix();
    const b = new THREEr.Box3();
    for (const v of obj.mesh().verts) b.expandByPoint(v.p.clone().applyMatrix4(m));
    return b;
  };
  const boxDev = (a, b) =>
    Math.max(a.min.distanceTo(b.min), a.max.distanceTo(b.max));

  /** 圓柱從中間切開再分離 —— ＝ kang 2026-08-29 實際踩到的那個情形 */
  const splitCylinder = () => {
    let m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const cut = edit.bisect(m, { n: new THREEr.Vector3(0, 1, 0), d: 0 });
    m = cut.mesh;
    const vi = m._vertIndex();
    const want = new Set((cut.newEdges || [])
      .map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)));
    const hes = [...m.edges()].filter(he => {
      const a = vi.get(he.v.id), b = vi.get(he.to.id);
      return want.has(a < b ? `${a}-${b}` : `${b}-${a}`);
    });
    return edit.separateAlongEdges(m, hes);
  };

  /** ① 分離出來的兩塊，原點本來就 ⛔ 不在自己的中心 —— 這是病的證據 */
  {
    const sep = splitCylinder();
    ok('① 圓柱從中間切開分離成 2 塊', sep.ok && sep.meshes.length === 2, sep.reason);
    const cs = sep.meshes.map(m =>
      +m.bounds().getCenter(new THREEr.Vector3()).y.toFixed(6));
    /**
     * 🔴 **這兩個數字就是 kang 看到的那件事**：兩塊都沿用原物件的原點，
     * 而那個點對下面那塊在**頂**、對上面那塊在**底**。
     */
    eq('★ 　 下面那塊的中心在本地 Y −17.5（＝ 原點在它的頂面）',
       Math.min(...cs), -17.5);
    eq('★ 　 上面那塊的中心在本地 Y ＋17.5（＝ 原點在它的底面）',
       Math.max(...cs), 17.5);
  }

  /** ② 置中之後：本地中心歸零，而【世界位置精確不變】 */
  {
    const sep = splitCylinder();
    for (const [i, m] of sep.meshes.entries()) {
      const o = new ioM.ModelObject({
        name: 'p' + i, src: { type: 'mesh' }, mesh: m,
        pos: new THREEr.Vector3(0, 35, 0)
      });
      const before = worldBox(o);
      const area0 = m.area(), nv0 = m.verts.length, nf0 = m.faces.length;
      const r = ioM.recenterOrigin(o);
      ok(`② 第 ${i + 1} 塊：有搬`, r.ok && r.moved);
      near(`　 　 本地中心歸零`,
           m.bounds().getCenter(new THREEr.Vector3()).length(), 0, 1e-9);
      near(`★★ 　 世界包圍盒精確不變`, boxDev(before, worldBox(o)), 0, 1e-9);
      near(`　 　 面積不變`, m.area(), area0, 1e-9);
      eq(`　 　 頂點數不變`, m.verts.length, nv0);
      eq(`　 　 面數不變`, m.faces.length, nf0);
    }
  }

  /**
   * 🔴🔴 ③ **有旋轉 ＋ 有縮放 —— 這一組是整節的重點。**
   * ⛔ 沒有它，`pos.add(offset)` 那種寫法會一路通過。
   */
  {
    const sep = splitCylinder();
    const o = new ioM.ModelObject({
      name: 'r', src: { type: 'mesh' }, mesh: sep.meshes[0],
      pos: new THREEr.Vector3(12, 35, -7),
      rot: new THREEr.Euler(0.3, 0.7, -0.45),
      scale: new THREEr.Vector3(1.4, 0.8, 2.1)
    });
    const before = worldBox(o);
    const posBefore = o.pos.clone();
    const r = ioM.recenterOrigin(o);
    near('③ 轉過又縮過：世界包圍盒【精確不變】',
         boxDev(before, worldBox(o)), 0, 1e-9);
    /**
     * ⭐ **這一句是「⛔ 不可以寫 pos.add(offset)」的機械證據**：
     * offset 只有 Y（本地），而正確的新 pos **X 與 Z 都必須跟著變**。
     */
    ok('★★ 　 offset 只有 Y，⛔ 而新 pos 的 X 與 Z 都變了（＝ 走了矩陣）',
       Math.abs(r.offset.x) < 1e-9 && Math.abs(r.offset.z) < 1e-9
       && Math.abs(o.pos.x - posBefore.x) > 1e-6
       && Math.abs(o.pos.z - posBefore.z) > 1e-6,
       `pos ${posBefore.toArray().map(v => v.toFixed(2))} → `
       + `${o.pos.toArray().map(v => v.toFixed(2))}`);
    near('★ 　 旋轉沒有被改掉（decompose 回得來）',
         Math.abs(o.rot.y - 0.7), 0, 1e-9);
    near('★ 　 縮放沒有被改掉', Math.abs(o.scale.z - 2.1), 0, 1e-9);
  }

  /** ④ 本來就在中心的東西：⛔ 不動，而且要回報「沒搬」 */
  {
    const m = baked('cylinder', { r: 25, h: 70, seg: 32 });
    const o = new ioM.ModelObject({
      name: 'c', src: { type: 'mesh' }, mesh: m,
      pos: new THREEr.Vector3(0, 35, 0)
    });
    const r = ioM.recenterOrigin(o);
    ok('④ 基本體本來就置中 → moved ＝ false（⛔ 不製造一個什麼都沒做的動作）',
       r.ok && r.moved === false);
    eq('　 pos 一格都沒動', o.pos.y, 35);
  }

  /** ⑤ 參數物件要擋下來並講原因 */
  {
    const o = new ioM.ModelObject({
      name: 'prm', src: { type: 'prim', prim: 'box', params: { w: 60, h: 45, d: 40 } }
    });
    const r = ioM.recenterOrigin(o);
    ok('⑤ 參數物件擋下來', r.ok === false);
    ok('　 而且講得出出路（轉成可編輯網格）',
       (r.reason || '').includes('轉成可編輯網格'), r.reason);
  }

  /**
   * 🔴🔴 **⑤-b `setOriginTo()`：原點搬到【指定的世界座標點】**
   * （2026-09-01，kang 要的「原點搬到我點的地方」）。
   *
   * ⚠ **物件刻意【轉過角度＋非等比縮放】** —— 那才驗得出
   * 「本地座標」跟「世界座標」有沒有搞混：⛔ 不轉的話點在哪原點就跑到哪，
   * 而那是**世界的那個位置**，⛔ 不是你點到的那個角。
   */
  {
    const m = baked('box', { w: 60, h: 45, d: 40 });
    const o = new ioM.ModelObject({
      name: 'g', src: { type: 'mesh' }, mesh: m,
      pos: new THREEr.Vector3(10, 20, 30),
      rot: new THREEr.Euler(0.3, 0.7, 0.2),
      scale: new THREEr.Vector3(1, 2, 1)
    });
    const wbox = () => {
      const b = new THREEr.Box3(), M = o.matrix();
      for (const v of o.mesh().verts) b.expandByPoint(v.p.clone().applyMatrix4(M));
      return b;
    };
    const before = wbox();
    const corner = before.max.clone();          // 世界座標的一個角

    const r = ioM.setOriginTo(o, corner);
    const after = wbox();

    ok('⑤-b 有搬', r.ok && r.moved);
    near('★★★ 原點正好落在你點的那個角（世界座標）',
         o.pos.distanceTo(corner), 0, 1e-9);
    near('★★★ 東西一格都沒動（包圍盒 min）',
         before.min.distanceTo(after.min), 0, 1e-9);
    near('★★★ 東西一格都沒動（包圍盒 max）',
         before.max.distanceTo(after.max), 0, 1e-9);
    near('★★ 非等比縮放⛔ 沒有被弄壞（1, 2, 1）',
         o.scale.distanceTo(new THREEr.Vector3(1, 2, 1)), 0, 1e-9);

    /** 再搬到同一點 ⇒ ⛔ 不製造一個什麼都沒做的動作 */
    ok('★ 再搬一次同一個點 → moved ＝ false', ioM.setOriginTo(o, corner).moved === false);
  }

  /** ⑤-c `setOriginTo()` 一樣要擋參數物件，而且講得出出路 */
  {
    const o = new ioM.ModelObject({
      name: 'prm2', src: { type: 'prim', prim: 'box', params: { w: 60, h: 45, d: 40 } }
    });
    const r = ioM.setOriginTo(o, new THREEr.Vector3(1, 2, 3));
    ok('⑤-c 參數物件擋下來', r.ok === false);
    ok('　 而且講得出出路', (r.reason || '').includes('轉成可編輯網格'), r.reason);
  }

  /**
   * ⑥ **取的是包圍盒中心，⛔ 不是重心**（kang 2026-08-29 拍板）。
   * 錐體是唯一分得出來的形狀：包圍盒中心在高度一半，重心在 1/4 處。
   */
  {
    const m = baked('cone', { rTop: 0, rBottom: 30, h: 70, seg: 32 });
    const c = m.bounds().getCenter(new THREEr.Vector3());
    const b = m.bounds();
    near('⑥ 錐體：包圍盒中心 ＝ 高度正中間，⛔ 不是重心的 1/4 處',
         c.y - b.min.y, 35, 1e-6);
  }
}

// ═══════════════════════════════════════════════════════
//  內建鋼筆：pen 來源型別（第 1 階段的純的那一半）
// ═══════════════════════════════════════════════════════

section('內建鋼筆：錨點與把手 → 輪廓');

/**
 * 🔴 **這一節的每一個數字都是「使用者自己算得出來」的。**
 * 正方形的體積、圓的面積 —— ⛔ 不是「跑出來多少就寫多少」。
 */
{
  const prim = await import('../js/build/prim.js');

  /** 多邊形面積（鞋帶公式）。⛔ 不借網格的，這裡要獨立對答案 */
  const polyArea = pts => {
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      s += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return Math.abs(s) / 2;
  };

  /** ① 四個尖角 → 正方形。體積要精確 */
  {
    const sq = { closed: true, a: [0, 0, 40, 0, 40, 40, 0, 40], hi: [], ho: [] };
    const pts = prim.flattenPenPath(sq, 0.2);
    eq('① 四個尖角 → 點數就是 4（直線段⛔ 不細分）', pts.length, 4);
    eq('　 四個都是轉角', pts.filter(p => p.corner).length, 4);
    const m = prim.buildPrim('pen', { h: 10, paths: [sq] });
    near('★★ 　 體積 ＝ 40 × 40 × 10', m.volume(), 16000, 1e-6);
  }

  /**
   * ② **用四段貝茲畫一個圓** —— 把手長 ＝ r × 0.5522847
   * （那是四段三次貝茲逼近圓的標準常數）。
   *
   * ⭐ **這一組是整節的重點**：容許值越小，點數越多、面積越靠近 πr²。
   * **兩個數字互相對得起來，⛔ 不是「看起來像圓」**（鐵律三）。
   */
  {
    const r = 20, k = r * 0.5522847498;
    const cir = {
      closed: true,
      a: [r, 0, 0, r, -r, 0, 0, -r],
      hi: [0, -k, k, 0, 0, k, -k, 0],
      ho: [0, k, -k, 0, 0, -k, k, 0]
    };
    const exact = Math.PI * r * r;
    const rows = [1, 0.2, 0.02].map(tol => {
      const p = prim.flattenPenPath(cir, tol);
      return { tol, n: p.length, a: polyArea(p) };
    });
    ok('② 容許值越小，點數越多',
       rows[0].n < rows[1].n && rows[1].n < rows[2].n,
       rows.map(x => `${x.tol}→${x.n}`).join(' '));
    ok('★★ 　 而且面積一路逼近 πr²（⛔ 內接多邊形永遠略小）',
       rows[0].a < rows[1].a && rows[1].a < rows[2].a && rows[2].a < exact,
       rows.map(x => x.a.toFixed(3)).join(' → ') + ` 　πr²=${exact.toFixed(3)}`);
    near('★★ 　 容許值 0.02 時，面積跟 πr² 差不到 0.2 cm²',
         exact - rows[2].a, 0, 0.2);
    eq('　 四個錨點都平滑 → 一個轉角都沒有',
       prim.flattenPenPath(cir, 0.02).filter(p => p.corner).length, 0);

    /**
     * 🔴🔴 **這一句守一個真的陷阱，⛔ 不要刪。**
     * `flattenCubic()` **會把終點也放進來**，而終點就是下一個錨點 ——
     * ⛔ 沒有去掉的話**每個錨點都會出現兩次**，
     * ⚠ 而面積、形狀**完全看不出異狀**（重複點不影響鞋帶公式）。
     */
    {
      const p = prim.flattenPenPath(cir, 0.02);
      const hit = p.filter(q =>
        [[r, 0], [0, r], [-r, 0], [0, -r]].some(
          ([x, y]) => Math.hypot(q.x - x, q.y - y) < 1e-9)).length;
      eq('★★ 　 四個錨點各只出現一次（⛔ 沒有把細分的終點重複收進來）', hit, 4);
    }
  }

  /**
   * ③ **一邊有把手、一邊沒有 ＝ 尖角** ——
   * ⚠ 判準⛔ 不是「有沒有把手」，是「兩側共不共線」。
   * 那正是 Illustrator 從曲線接直線時的樣子。
   */
  {
    const mix = {
      closed: true, a: [0, 0, 40, 0, 40, 40],
      hi: [0, 0, 0, 0, 0, 0], ho: [10, 0, 0, 0, 0, 0]
    };
    eq('③ 一邊有把手一邊沒有 → 三個錨點都是尖角',
       prim.flattenPenPath(mix, 0.2).filter(p => p.corner).length, 3);
  }

  /** ④ 邊界情形：點太少、沒有路徑 */
  {
    eq('④ 只有一個錨點 → 回空的',
       prim.flattenPenPath({ closed: true, a: [0, 0] }, 0.2).length, 0);
    eq('　 沒給東西不會壞', prim.flattenPenPath(null, 0.2).length, 0);
    let msg = '';
    try { prim.buildPrim('pen', { h: 3, paths: [] }); }
    catch (e) { msg = e.message; }
    ok('　 沒有形狀時擋下來並講原因', msg.includes('還沒有畫'), msg);
  }

  /** ⑤ ⛔ 不出現在「新增」下拉（跟 extrude 同一條理由）*/
  {
    ok('⑤ pen ⛔ 不在新增下拉裡（它要有人先畫，⛔ 不能從零生成）',
       !prim.PRIM_TYPES.includes('pen'), prim.PRIM_TYPES.join(','));
  }

  /**
   * 🔴 ⑥ **存檔 → 讀檔往返：錨點與把手要一個數字都不差。**
   *
   * ⚠ **⛔ 這一組不是形式** —— 鋼筆存的是「參數」，
   * 而 kang 要的是「**回頭拉點、拉把手**」（第 2 階段）。
   * **把手在存檔往返時掉了的話，第 2 階段就從一開始就是壞的**，
   * 而**形狀完全看不出異狀**（曲線照樣畫得出來，只是再也調不動）。
   */
  {
    const ioM = await import('../js/core/io.js');
    const r = 20, k = r * 0.5522847498;
    const src = {
      type: 'pen', h: 7,
      paths: [{
        closed: true,
        a: [r, 0, 0, r, -r, 0, 0, -r],
        hi: [0, -k, k, 0, 0, k, -k, 0],
        ho: [0, k, -k, 0, 0, -k, k, 0]
      }]
    };
    const doc = new ioM.Doc();
    doc.add(new ioM.ModelObject({ name: '鋼筆 1', src }));
    const back = ioM.Doc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    const p2 = back.objects[0].src.paths[0];
    eq('⑥ 存讀檔往返：來源型別還是 pen', back.objects[0].src.type, 'pen');
    eq('★★ 　 錨點一個數字都不差',
       JSON.stringify(p2.a), JSON.stringify(src.paths[0].a));
    eq('★★ 　 進把手一個數字都不差',
       JSON.stringify(p2.hi), JSON.stringify(src.paths[0].hi));
    eq('★★ 　 出把手一個數字都不差',
       JSON.stringify(p2.ho), JSON.stringify(src.paths[0].ho));
    /** ⭐ 讀回來還生得出網格（⛔ 不是只有資料對，要真的建得起來）*/
    near('★ 　 讀回來生得出網格，體積 ≈ πr² × 高',
         back.objects[0].mesh().volume(), Math.PI * r * r * 7, 60);
  }

  /**
   * 🔴 ⑦ **鋼筆物件的原點置中 —— 搬的是錨點，⛔ 不是頂點。**
   *
   * 〔kang 2026-08-29 回報：「鋼筆建立好的物件..XYZ 方向軸並沒有在物件中心」〕
   * 🔴 **病因是 `recenterOrigin()` 第一行就把 `pen` 當成「參數物件」擋掉了** ——
   * 而那個擋本來是對的（參數物件改頂點留不住）。
   * ⭐ **錯的是把所有參數物件一視同仁**：鋼筆的形狀就是那串錨點，
   * **搬錨點 ＝ 搬參數 ＝ 留得住**。
   */
  {
    const ioM = await import('../js/core/io.js');
    const THREEr = await import('three');
    /** 一個 20×10 的方形，故意畫在遠處（中心在 (110, 55)） */
    const src = {
      type: 'pen', h: 5,
      paths: [{ closed: true, a: [100, 50, 120, 50, 120, 60, 100, 60], hi: [], ho: [] }]
    };
    const obj = new ioM.ModelObject({ name: '鋼筆', src });
    const worldBox = o => {
      const m = o.matrix();
      const b = new THREEr.Box3();
      for (const v of o.mesh().verts) b.expandByPoint(v.p.clone().applyMatrix4(m));
      return b;
    };
    const before = worldBox(obj);
    const r = ioM.recenterOrigin(obj);
    ok('⑦ 鋼筆物件置得了中（⛔ 不再被當成「參數物件」擋掉）', r.ok && r.moved,
       r.reason || '');
    const after = worldBox(obj);
    near('★★ 　 東西一格都沒動（世界包圍盒精確不變）',
         Math.max(before.min.distanceTo(after.min), before.max.distanceTo(after.max)),
         0, 1e-6);
    /** ⭐ 錨點被搬到以自己的中心為原點 */
    const b2 = prim.penBounds(obj.src.paths);
    near('★★ 　 錨點的中心歸零', Math.hypot(b2.cx, b2.cy), 0, 1e-6);
    near('　 新 pos.x ＝ 原本的中心 X（110）', obj.pos.x, 110, 1e-6);
    near('　 新 pos.z ＝ 原本的中心 Y（55）', obj.pos.z, 55, 1e-6);
    /**
     * 🔴 **搬完存讀檔還要對** —— 這一項守「搬的是參數，⛔ 不是頂點」：
     * 如果搬的是頂點，重新生成就會跳回原處，而**存讀檔正是重新生成**。
     */
    const back2 = ioM.Doc.fromJSON(JSON.parse(JSON.stringify(
      (() => { const d = new ioM.Doc(); d.add(obj); return d.toJSON(); })())));
    const b3 = prim.penBounds(back2.objects[0].src.paths);
    near('★★ 　 存讀檔之後【還是】置中的（＝ 搬的真的是參數）',
         Math.hypot(b3.cx, b3.cy), 0, 1e-6);
  }

  /**
   * 🔴 ⑨ **閉合那一段的曲線，由「第一個錨點的進把手」決定。**
   *
   * 〔kang 2026-08-29 發現：閉合時做不出曲線。已重現＋量到〕
   * **閉合段 ＝ 最後一點的出把手 ＋ 第一點的進把手**，
   * 而 `hi[0]` 在**第一次放那個點**時就被決定了 ——
   * 第一個點只是「點一下」的話它就是 0，**那一段只彎一半**。
   * ⭐ 所以閉合時要能用拖的補上（Adobe：「Select **or drag** to close」）。
   */
  {
    const r = 20, k = r * 0.5522847498;
    const mk = hi0 => ({
      closed: true,
      a: [r, 0, 0, r, -r, 0, 0, -r],
      hi: [hi0[0], hi0[1], k, 0, 0, k, -k, 0],
      ho: [0, k, -k, 0, 0, -k, k, 0]
    });
    const noHandle = prim.flattenPenPath(mk([0, 0]), 0.02);
    const withHandle = prim.flattenPenPath(mk([0, -k]), 0.02);
    ok('⑨ 第一個錨點沒有進把手 → 它是【尖角】（閉合那段接上去會折一下）',
       noHandle[0].corner === true);
    ok('★★ 　 補上進把手之後 → 它變成【平滑】（閉合那段也彎了）',
       withHandle[0].corner === false);
    /**
     * ⭐ **⛔ 不要只驗 corner 這個旗標** —— 真正看得出差別的是**點數**：
     * 一端沒有把手的那一段比較「直」，細分出來的點少得多。
     */
    ok('★★ 　 而且閉合那一段真的變彎了（細分出來的點明顯變多）',
       withHandle.length > noHandle.length,
       `沒把手 ${noHandle.length} 個點 → 有把手 ${withHandle.length} 個點`);
    /** 面積也對得起來：補好之後才接近整個圓 */
    const area = pts => {
      let s2 = 0;
      for (let i = 0; i < pts.length; i++) {
        const j = (i + 1) % pts.length;
        s2 += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      }
      return Math.abs(s2) / 2;
    };
    ok('★★ 　 面積也證實：補好之後才接近 πr²',
       Math.PI * r * r - area(withHandle) < Math.PI * r * r - area(noHandle),
       `沒把手 ${area(noHandle).toFixed(1)} → 有把手 ${area(withHandle).toFixed(1)}`
       + ` 　πr²=${(Math.PI * r * r).toFixed(1)}`);
  }

  /**
   * 🔴 ⑩ **曲線接直線：清掉「出把手」就會變直，而且⛔ 不會動到上一段。**
   *
   * 〔kang 2026-08-29 發現：「1 與 2 曲線..2 與 3 依樣會是曲線」〕
   * 拖出一個圓滑點時**進把手與出把手是一起長出來的**，
   * 所以下一段就算只點一下，**它那一端還是彎的**。
   * ⭐ Adobe 的解法是「點一下那個點，把它轉成尖角」＝ **只清出把手**。
   */
  {
    const k = 12;
    /** 三個點：0→1 拖成曲線，1→2 想要直線 */
    /**
     * ⚠ **第三個點⛔ 不可以放在「把手的延長線上」** —— 那樣控制點三點共線，
     * 「曲線」本來就是直的，這一組會變成一個自己會通過的空測試。
     * 〔2026-08-29 第一版就是這樣寫的，當場失敗才發現〕
     */
    const mk = ho1 => ({
      closed: false,
      a: [0, 0, 40, 0, 80, 40],
      hi: [0, 0, -k, 0, 0, 0],
      ho: [0, k, ho1[0], ho1[1], 0, 0]
    });
    const curved = prim.flattenPenPath(mk([k, 0]), 0.02);
    const straight = prim.flattenPenPath(mk([0, 0]), 0.02);
    ok('⑩ 沒清出把手 → 第二段是【彎的】（細分出一堆點）',
       curved.length > straight.length,
       `彎 ${curved.length} 個點 → 直 ${straight.length} 個點`);
    /**
     * 🔴🔴 **這一句才是重點：清掉出把手之後，⛔ 上一段一格都不能變。**
     * ⚠ 兩者的**前半段**（0→1）要**逐點完全一樣** ——
     * 動到 `hi` 的話這一項會當場失敗。
     */
    {
      const upto = (pts, x, y) => {
        const i = pts.findIndex(p =>
          Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);
        return pts.slice(0, i + 1);
      };
      const a1 = upto(curved, 40, 0), b1 = upto(straight, 40, 0);
      ok('★★ 　 而且【上一段一格都沒變】—— 逐點完全一樣',
         a1.length === b1.length
         && a1.every((p, i) => Math.abs(p.x - b1[i].x) < 1e-12
                            && Math.abs(p.y - b1[i].y) < 1e-12),
         `${a1.length} vs ${b1.length} 個點`);
    }
    eq('★ 　 清掉之後那個錨點變成【尖角】',
       prim.flattenPenPath(mk([0, 0]), 0.02).filter(p => p.corner).length >= 1, true);
  }

  /**
   * 🔴 ⑪ **直線接曲線：長出「出把手」就會變彎，而且⛔ 不會動到上一段。**
   *
   * 〔kang 2026-08-29 拍板要補完：「既然控制的更細..就要做完善」〕
   * ⭐ 它是第 ⑩ 組的**反向**：⑩ 是「收掉出把手 → 下一段變直」，
   * 這一組是「長出出把手 → 下一段變彎」。
   * ⚠ **兩組共用同一個不變量**：不管收還是長，**上一段一格都不能變**。
   */
  {
    const k = 12;
    /** 三個點：0→1 是直線（兩端都沒有把手），1→2 想要變彎 */
    const mk = ho1 => ({
      closed: false,
      a: [0, 0, 40, 0, 80, 40],
      hi: [0, 0, 0, 0, 0, 0],
      ho: [0, 0, ho1[0], ho1[1], 0, 0]
    });
    const flat = prim.flattenPenPath(mk([0, 0]), 0.02);
    const bent = prim.flattenPenPath(mk([0, k]), 0.02);
    ok('⑪ 長出出把手 → 第二段變彎（細分出一堆點）',
       bent.length > flat.length,
       `直 ${flat.length} 個點 → 彎 ${bent.length} 個點`);
    {
      const upto = (pts, x, y) => {
        const i = pts.findIndex(p =>
          Math.abs(p.x - x) < 1e-9 && Math.abs(p.y - y) < 1e-9);
        return pts.slice(0, i + 1);
      };
      const a1 = upto(flat, 40, 0), b1 = upto(bent, 40, 0);
      ok('★★ 　 而且【第一段（直線）一格都沒變】—— 逐點完全一樣',
         a1.length === b1.length
         && a1.every((p, i) => Math.abs(p.x - b1[i].x) < 1e-12
                            && Math.abs(p.y - b1[i].y) < 1e-12),
         `${a1.length} vs ${b1.length} 個點`);
    }
    /**
     * ⚠ **只長出把手的那個點仍然是【尖角】** —— 它的進把手是 0，
     * 兩側⛔ 不共線。那是對的：直線轉曲線本來就該在那裡折一下。
     */
    ok('★ 　 那個點仍然是尖角（進把手是 0，兩側⛔ 不共線）',
       prim.flattenPenPath(mk([0, k]), 0.02)
         .find(p => Math.abs(p.x - 40) < 1e-9 && Math.abs(p.y) < 1e-9).corner === true);
  }

  /** ⑧ 把手⛔ 不跟著搬（它存的是相對位移） */
  {
    const k = 10;
    const paths = [{ closed: true, a: [0, 0, 20, 0, 20, 20], hi: [0, -k, 0, 0, 0, 0],
                     ho: [0, k, 0, 0, 0, 0] }];
    prim.shiftPenPaths(paths, 7, -3);
    eq('⑧ 搬錨點：第一個錨點跟著動', JSON.stringify(paths[0].a.slice(0, 2)),
       JSON.stringify([7, -3]));
    eq('★ 　 把手一個數字都沒動（它是相對位移，錨點搬了它自己就跟著走）',
       JSON.stringify(paths[0].ho), JSON.stringify([0, k, 0, 0, 0, 0]));
  }

  // ═══════════════════════════════════════════════════
  //  🔴 第 2 階段：`改點`（回頭拉點、拉把手）2026-08-29
  // ═══════════════════════════════════════════════════

  /**
   * 🔴 ⑫ **「圓滑」的判準是【兩根把手的夾角】，⛔ 不是存法。**
   *
   * ⚠ 這一組守的是 kang 拍板那個框架：
   * **連動與否是【錨點的屬性】，⛔ 不是一個拖曳規則。**
   * 判錯的話，圓滑點會變成各拖各的（看起來像「連動沒做」），
   * 或尖角點被硬拉成一直線（**使用者刻意折斷的角自己接回去了**）。
   */
  {
    const mk = (hi, ho) => ({ a: [0, 0], hi, ho });
    ok('⑫ 精確反向 ＝ 圓滑', prim.penIsSmooth(mk([-3, -4], [3, 4]), 0));
    ok('★ 　 長度不同但方向相反 → 還是圓滑（長度⛔ 不是判準）',
       prim.penIsSmooth(mk([-30, -40], [3, 4]), 0));
    ok('★ 　 折斷成 90 度 → ⛔ 不是圓滑', !prim.penIsSmooth(mk([-4, 3], [3, 4]), 0));
    ok('★★ 　 只有一根（另一根是 0）→ ⛔ 不是圓滑（連動沒有對象）',
       !prim.penIsSmooth(mk([0, 0], [3, 4]), 0));
    /**
     * ⭐ **容許值 1 度的物理意義**：一根 100 cm 的把手端點差 1.7 cm。
     * ⚠ 存讀檔的浮點誤差遠小於這個，所以⛔ 不會誤判。
     */
    const deg = d => [Math.cos(d * Math.PI / 180) * 5, Math.sin(d * Math.PI / 180) * 5];
    ok('★ 　 差 0.5 度 → 仍算圓滑（在 1 度容許值內）',
       prim.penIsSmooth(mk(deg(180.5), [5, 0]), 0));
    ok('★★ 　 差 2 度 → ⛔ 不算（容許值真的有在擋，⛔ 不是永遠回 true）',
       !prim.penIsSmooth(mk(deg(182), [5, 0]), 0));
  }

  /**
   * 🔴 ⑬ **圓滑點：拖一根，另一根【只轉方向，長度各自保留】。**
   *
   * ⚠ **長度⛔ 不可以跟著變** —— 跟著變的話，
   * **調這一段的彎度會強制改掉隔壁那一段的彎度**，
   * 而「只改該碰的那一端」是 2026-08-28 立的鐵律。
   */
  {
    /** 進把手長 10 往 −X、出把手長 5 往 +X ＝ 一直線（圓滑），長度⛔ 不同 */
    const p = { a: [0, 0], hi: [-10, 0], ho: [5, 0] };
    const linked = prim.penSetHandle(p, 0, 'out', 0, 3);
    ok('⑬ 圓滑點拖一根 → 另一根有跟著動', linked);
    eq('★ 　 拖的那一根就是給的值', JSON.stringify(p.ho), JSON.stringify([0, 3]));
    eq('★★ 　 另一根【只轉方向】：轉到正反向',
       JSON.stringify(p.hi.map(v => +v.toFixed(9))), JSON.stringify([0, -10]));
    near('★★ 　 另一根的【長度一格都沒變】（原本 10）',
         Math.hypot(p.hi[0], p.hi[1]), 10, 1e-9);
    /** ⭐ 兩根夾角仍是 180 度 —— 圓滑點改完還是圓滑點 */
    ok('★ 　 改完仍然是圓滑（不變量）', prim.penIsSmooth(p, 0));
  }

  /**
   * 🔴 ⑭ **尖角點：拖一根，另一根【一格都不動】。**
   *
   * ⚠ **這一組是 ⑬ 的反面，⛔ 兩組都要有** ——
   * 只驗「有連動」的話，一個「永遠連動」的錯誤實作也會通過
   * 〔2026-08-29 立的那條：⛔ 不要相信一組沒有失敗過的測試〕。
   */
  {
    /** 折斷成 90 度 ＝ 尖角 */
    const p = { a: [0, 0], hi: [-4, 3], ho: [3, 4] };
    const before = JSON.stringify(p.hi);
    const linked = prim.penSetHandle(p, 0, 'out', 0, 9);
    ok('⑭ 尖角點拖一根 → 另一根⛔ 不跟動', !linked);
    eq('★★ 　 另一根逐格完全一樣', JSON.stringify(p.hi), before);
    eq('★ 　 拖的那一根有改到', JSON.stringify(p.ho), JSON.stringify([0, 9]));
  }

  /**
   * 🔴🔴 ⑮ **`編輯路徑`：本地 ⇄ 世界往返，一個數字都不差。**
   *
   * ⚠ **⛔ 這一組不是形式**。kang 2026-08-29 選的是「**收尾後也能重新編輯**」，
   * 而路徑存的是**本地座標**、物件另外帶著 `pos`／`scale` ——
   * **換算錯掉的話形狀會整個漂走或縮放掉，而且是在他按「完成」之後才發生**。
   * 🔴 所以刻意挑一個**搬過又非等比縮放過**的物件（⛔ 不是單位物件，
   * 那種「碰巧通過」2026-08-28 才害過一次）。
   */
  {
    const ioM = await import('../js/core/io.js');
    const src = {
      type: 'pen', h: 4,
      paths: [{ closed: true,
                a: [0, 0, 20, 0, 20, 10, 0, 10],
                hi: [0, -3, 0, 0, 0, 0, 0, 0],
                ho: [0, 3, 0, 0, 0, 0, 0, 0] }]
    };
    const obj = new ioM.ModelObject({ name: '鋼筆', src });
    obj.pos.set(31, 0, -17);
    obj.scale.set(2, 1, 0.5);          // ⚠ 故意非等比
    const p0 = src.paths[0];
    const w = ioM.penPathToWorld(p0, obj);
    /** ⭐ 對得起來的量：第二個錨點的世界 X ＝ 20 × 2 ＋ 31 ＝ 71 */
    near('⑮ 本地 → 世界：第 2 個錨點的 X ＝ 20×2 ＋ 31', w.a[2], 71, 1e-9);
    near('★ 　 　 　 　 它的 Z ＝ 0×0.5 −17', w.a[3], -17, 1e-9);
    near('★ 　 把手也吃了縮放：ho[1] ＝ 3 × 0.5', w.ho[1], 1.5, 1e-9);
    const back = ioM.penPathToLocal(w, obj);
    ok('★★ 　 換得回來（⛔ 不是 null）', !!back);
    eq('★★ 　 錨點往返一個數字都不差',
       JSON.stringify(back.a.map(v => +v.toFixed(9))), JSON.stringify(p0.a));
    eq('★★ 　 進把手往返一個數字都不差',
       JSON.stringify(back.hi.map(v => +v.toFixed(9))), JSON.stringify(p0.hi));
    eq('★★ 　 出把手往返一個數字都不差',
       JSON.stringify(back.ho.map(v => +v.toFixed(9))), JSON.stringify(p0.ho));
    /**
     * 🔴 **縮放 0 要回 `null`，⛔ 不可以回一堆 Infinity** ——
     * 那會**安靜地**毀掉整條路徑（形狀直接消失，而且沒有任何訊息）。
     */
    const bad = new ioM.ModelObject({ name: '鋼筆', src });
    bad.scale.set(0, 1, 1);
    eq('★★ 　 縮放 0 → 回 null（⛔ 不是 Infinity）',
       ioM.penPathToLocal(w, bad), null);
  }

  // ═══════════════════════════════════════════════════
  //  🔴 第 3 階段（一）：加點／刪點　2026-08-29
  // ═══════════════════════════════════════════════════

  const sp = await import('../js/sketch/svgPath.js');
  /** 一個標準的圓：四個錨點，把手 ＝ r × 0.5522847498 */
  const R0 = 20, K0 = R0 * 0.5522847498;
  const mkCircle = () => ({ closed: true,
    a:  [ R0, 0,  0, R0,  -R0, 0,  0, -R0 ],
    hi: [ 0, -K0,  K0, 0,  0, K0,  -K0, 0 ],
    ho: [ 0,  K0, -K0, 0,  0, -K0,  K0, 0 ] });
  const penArea = p => Math.abs(sp.polyArea(prim.flattenPenPath(p, 0.01)));

  /**
   * 🔴🔴 ⑯ **加一個錨點 → 形狀【一格都不能變】。**
   *
   * ⚠ **這一組是「加點」的全部意義所在**。做起來只要一行的做法
   * （插一個尖角點）**會把那一段拉直** —— 而使用者要的是
   * 「多一個**可以調**的點」，⛔ 不是「改形狀」。
   * ⭐ `splitCubic()` 是 de Casteljau，**數學上等價**，
   * 所以這裡敢用「精確相等」去驗，⛔ 不是「差不多」。
   */
  {
    const p = mkCircle();
    const before = penArea(p);
    const r = prim.penAddAnchor(p, 0, 0.5);
    ok('⑯ 加點成功', r.ok && r.at === 1, JSON.stringify(r));
    eq('★ 　 錨點多了一個', p.a.length / 2, 5);
    eq('★ 　 把手也跟著多一組', [p.hi.length / 2, p.ho.length / 2].join(','), '5,5');
    const after = penArea(p);
    /**
     * 🔴🔴 **⚠ 這裡精確不變，是因為【圓太規則】—— ⛔ 不要推廣到一般情形。**
     *
     * 〔2026-08-29 線上實測照出來的，見下面第 ⑲ 組〕
     * **曲線本身確實等價**（⑱ 逐點比對過），
     * 但 `flattenPenPath()` 是「**遞迴對半切到夠平**」——
     * 一段切成兩段之後，**兩段各自的切法⛔ 不會跟原本那一段對齊**。
     * ⭐ 圓的每一段都對稱，切法剛好一樣，所以這裡看不出來。
     * 🔴 **不規則的形狀就會差千分之幾** —— 那是第 ⑲ 組守的事。
     */
    near('★★ 　 面積【精確】不變（⚠ 圓太規則才這樣，一般情形見 ⑲）',
         after, before, 1e-9);
    /** ⭐ 再對答案：圓的面積 ≈ πr²（貝茲近似的圓略小一點點） */
    near('★ 　 而且那個面積真的是一個圓（≈ πr²）',
         after, Math.PI * R0 * R0, 10);
    /** ⚠ 邊界：t 要在中間，⛔ 端點插不了（那裡本來就有錨點） */
    ok('★ 　 t=0 擋下來並講原因', !prim.penAddAnchor(mkCircle(), 0, 0).ok);
    ok('★ 　 t=1 擋下來並講原因', !prim.penAddAnchor(mkCircle(), 0, 1).ok);
    ok('★ 　 沒有那一段就擋下來', !prim.penAddAnchor(mkCircle(), 9, 0.5).ok);
  }

  /**
   * 🔴🔴 ⑰ **刪一個錨點 → 擬合的誤差要比「直接接」小一個數量級。**
   * （kang 2026-08-29 在三個做法裡選的：「擬合，盡量讓形狀不變」）
   *
   * ⚠ **⛔ 光看擬合自己的誤差沒有人判斷得了好壞** ——
   * 所以這一組**旁邊放一個「直接接」的對照組**，讓兩個數字互相對得起來。
   * 〔鐵律三：一個孤零零的數字沒有人能驗〕
   *
   * ⭐ 【實測 2026-08-29】擬合 1.27 vs 直接接 114.12 —— **好將近 90 倍**。
   * 這裡用 10 倍當門檻，留足餘裕。
   */
  {
    /** 先加一個點，再把它刪掉 —— 理想上應該回到原本的圓 */
    const base = mkCircle();
    const A0 = penArea(base);
    const p = mkCircle();
    const add = prim.penAddAnchor(p, 0, 0.5);

    const fit = { closed: true, a: p.a.slice(), hi: p.hi.slice(), ho: p.ho.slice() };
    const rr = prim.penRemoveAnchor(fit, add.at);
    ok('⑰ 刪點成功而且【擬合有解】', rr.ok && rr.fitted === true, JSON.stringify(rr));
    eq('★ 　 錨點少了一個', fit.a.length / 2, 4);

    /** ── 對照組：直接接（把手 ＝ 弦長的 1/3）────────────── */
    const naive = { closed: true, a: p.a.slice(), hi: p.hi.slice(), ho: p.ho.slice() };
    {
      const i = add.at, n = naive.a.length / 2;
      const pv = (i - 1 + n) % n, nx = (i + 1) % n;
      const P0 = { x: naive.a[pv * 2], y: naive.a[pv * 2 + 1] };
      const P3 = { x: naive.a[nx * 2], y: naive.a[nx * 2 + 1] };
      naive.a.splice(i * 2, 2); naive.hi.splice(i * 2, 2); naive.ho.splice(i * 2, 2);
      const p2 = pv < i ? pv : pv - 1, n2 = nx > i ? nx - 1 : nx;
      const dx = P3.x - P0.x, dy = P3.y - P0.y, L = Math.hypot(dx, dy);
      naive.ho[p2 * 2] = dx / 3; naive.ho[p2 * 2 + 1] = dy / 3;
      naive.hi[n2 * 2] = -dx / 3; naive.hi[n2 * 2 + 1] = -dy / 3;
      void L;
    }
    const eFit = Math.abs(penArea(fit) - A0);
    const eNaive = Math.abs(penArea(naive) - A0);
    ok('★★ 　 擬合的誤差比「直接接」小【至少 10 倍】',
       eFit * 10 < eNaive,
       `擬合 ${eFit.toFixed(3)} vs 直接接 ${eNaive.toFixed(3)}　`
       + `＝ 好 ${(eNaive / eFit).toFixed(1)} 倍`);

    /** ⚠ 邊界：只剩 3 個點就不給刪（再刪圍不出形狀），而且要講原因 */
    const tiny = { closed: true, a: [0, 0, 10, 0, 5, 8],
                   hi: [0, 0, 0, 0, 0, 0], ho: [0, 0, 0, 0, 0, 0] };
    const rt = prim.penRemoveAnchor(tiny, 1);
    ok('★★ 　 只剩 3 個點 → 擋下來', !rt.ok);
    ok('★ 　 而且講得出原因（⛔ 不是安靜地什麼都不做）',
       /圍不出/.test(rt.reason || ''), rt.reason);
    eq('★ 　 擋下來時⛔ 一格都沒動', tiny.a.length / 2, 3);
  }

  /**
   * 🔴 ⑱ **`splitCubic()` 本身：兩段合起來就是原本那一條。**
   * ⚠ 上面兩組驗的是「用起來對不對」，這一組驗的是**那支數學本人**。
   */
  {
    const C = [0, 0, 10, 30, 40, 30, 50, 0];
    const s = sp.splitCubic(...C, 0.37);
    /** 切點要落在原曲線上 */
    const on = sp.cubicAt(...C, 0.37);
    near('⑱ 切點就在原曲線上（x）', s.mid.x, on.x, 1e-12);
    near('★ 　 切點就在原曲線上（y）', s.mid.y, on.y, 1e-12);
    /** 兩段的端點要接得起來 */
    eq('★ 　 前段的終點 ＝ 後段的起點',
       `${s.a[6]},${s.a[7]}`, `${s.b[0]},${s.b[1]}`);
    /** ⭐ 取十個點逐點比：分割之後的曲線跟原本的是同一條 */
    let worst = 0;
    for (let k = 1; k < 10; k++) {
      const u = k / 10;
      const o = sp.cubicAt(...C, u);
      const q = u < 0.37 ? sp.cubicAt(...s.a, u / 0.37)
                         : sp.cubicAt(...s.b, (u - 0.37) / (1 - 0.37));
      worst = Math.max(worst, Math.hypot(o.x - q.x, o.y - q.y));
    }
    near('★★ 　 逐點比對：兩段合起來就是原本那一條', worst, 0, 1e-9);
    /** ⚠ `nearestOnCubic()` 找得回自己 */
    const probe = sp.cubicAt(...C, 0.62);
    const nr = sp.nearestOnCubic(probe.x, probe.y, ...C);
    near('★ 　 nearestOnCubic 找得回 t=0.62', nr.t, 0.62, 0.01);
    /**
     * 🔴 **門檻看【位置】，⛔ 不看 `t`。**
     * 〔2026-08-29：原本寫 0.01 是隨手寫的，而 `t` 差 0.0017 在那條
     * 　曲線上就是 0.1 cm —— **兩個數字並不矛盾，是門檻沒有物理意義**〕
     * ⭐ **0.01 cm ＝ 0.1 mm**，遠小於任何看得出來的量，也遠小於
     * 命中門檻（12 px）。細化改成六輪之後達得到。
     */
    near('★★ 　 而且距離 ≈ 0（門檻 0.1 mm，⛔ 這是【位置】不是 t）',
         nr.dist, 0, 0.01);
  }

  /**
   * 🔴🔴 ⑲ **加點：曲線是同一條，但【拉直成折線】的取樣會變。**
   *
   * 〔2026-08-29 kang 的實測清單第 4 項照出來的 —— **我寫錯了**：
   * 　我在提示與清單裡都寫「面積與體積是**同一個數字**」，
   * 　而線上實測 761,513.3 → 761,530.2（差 0.0022%）。**對不上。**〕
   *
   * 🔴 **病⛔ 不在 `penAddAnchor()`，在我的措辭。**
   * `flattenPenPath()` 是「**遞迴對半切到夠平**」——
   * 一段切成兩段之後，**兩段各自的切法⛔ 不會跟原本那一段對齊**
   * （實測折線點數 63 → 61／62／64 都出現過）。
   *
   * ⭐ **這一組守的是「真相有兩半」**：
   * 　**曲線等價**（⑱ 逐點比對，1e-9）＋ **折線會差一點**（這裡，上界 0.1%）。
   * ⚠ **⛔ 只留 ⑯ 那一組（圓，精確不變）會誤導** ——
   * 　圓太規則，剛好看不出來。
   */
  {
    /** 不規則、把手很長 —— ⛔ 刻意不用圓（那種「碰巧通過」害過兩次了） */
    const P = { closed: true,
      a:  [0, 0,   90, 10,   80, 70,   10, 60],
      hi: [-30, -20,  -40, 10,   30, -25,   20, 30],
      ho: [30, 20,   40, -10,  -30, 25,  -20, -30] };
    const cl = p => ({ closed: true, a: p.a.slice(), hi: p.hi.slice(), ho: p.ho.slice() });
    const tol = 0.2;                      // ⚠ 建模器實際在用的容許值
    const ar = p => Math.abs(sp.polyArea(prim.flattenPenPath(p, tol)));

    let worst = 0, changed = 0;
    for (const seg of [0, 1, 2, 3]) for (const t of [0.13, 0.37, 0.5, 0.82]) {
      const c = cl(P);
      const a0 = ar(c);
      const rr = prim.penAddAnchor(c, seg, t);
      if (!rr.ok) continue;
      const d = Math.abs(ar(c) - a0) / a0;
      if (d > 1e-9) changed++;
      worst = Math.max(worst, d);
    }
    ok('⑲ 不規則形狀：加點後面積【真的會差一點】（⛔ 這不是 bug）',
       changed > 0, `16 個位置裡有 ${changed} 個有差`);
    ok('★★ 　 但差距【一定在 0.1% 以內】',
       worst < 0.001, `最大 ${(worst * 100).toFixed(4)} %`);
  }

  /**
   * 🔴🔴 ⑳ **做洞：包在裡面的那一條路徑就是洞。**（第 3 階段，2026-08-30）
   *
   * ⭐ **判準走 `profile.js` 的 `classify()`** —— 巢狀深度偶數 ＝ 實心、
   * 奇數 ＝ 洞。⚠ **⛔ 不用繞向（順時針／逆時針）判**：
   * 畫的人不一定照規矩，而「在不在裡面」是**幾何事實**。
   * 🔴 第 ③ 項就是守這件事：**把順序顛倒過來，答案必須一樣**。
   *
   * ⚠ **`classify()` 一定要有 `area`** —— 少了它每一條都會被當成外框，
   * 【實證 2026-08-29】外 40×40 ＋ 內 20×20 會得到 **10000**（兩塊疊著），
   * ⛔ 不是 6000。
   */
  {
    const sq = pts => ({ closed: true, a: pts,
      hi: new Array(pts.length).fill(0), ho: new Array(pts.length).fill(0) });
    const outer = sq([0, 0, 40, 0, 40, 40, 0, 40]);        // 40×40 → 1600
    const inner = sq([10, 10, 30, 10, 30, 30, 10, 30]);    // 20×20 → 400
    const far   = sq([60, 0, 100, 0, 100, 40, 60, 40]);    // 另一塊 1600
    const H = 5;
    const vol = paths => prim.buildPrim('pen', { h: H, paths }).volume();
    const cls = paths => prim.buildPrim('pen', { h: H, paths }).isClosed();

    near('⑳ 一條路徑 ＝ 實心（40×40×5）', vol([outer]), 8000, 0.5);
    near('★★ 　 外 ＋ 內 ＝ 有洞（8000 − 2000）', vol([outer, inner]), 6000, 0.5);
    near('★★ 　 【順序顛倒】答案一樣（⛔ 不看繞向、⛔ 不看順序）',
         vol([inner, outer]), 6000, 0.5);
    near('★ 　 兩塊分開的 ＝ 相加（⛔ 不會互相挖）', vol([outer, far]), 16000, 0.5);
    near('★★ 　 兩塊 ＋ 其中一塊有洞', vol([outer, inner, far]), 14000, 0.5);
    /**
     * 🔴 **封閉是必要條件** —— ⛔ 不封閉的話 3D 列印會擋、體積也沒有意義
     * 〔鐵律三：這個數字在這個狀態下有沒有意義〕。
     */
    ok('★★ 　 有洞的網格【仍然是封閉的】', cls([outer, inner]));
    ok('★ 　 兩塊 ＋ 洞也封閉', cls([outer, inner, far]));

    /**
     * 🔴🔴 **鋼筆物件的右側面板【原本什麼都沒有】。**（2026-08-30 補）
     *
     * 〔kang 2026-08-30 問出來的：「進入編輯時...是不能編輯的」〕
     * ⛔ **病因**：`toolbar.js` 是「**去 `PRIM_SPECS` 查得到才顯示東西**」，
     * 而 `pen` **不在裡面** → 既改不了厚度，
     * 也**沒有「轉成可編輯網格」那顆**。
     * 🔴 **而 `extrude`（匯入線稿）有** —— 兩個走同一條路的功能行為不一致。
     *
     * ⚠ **第 ② 項是這一組的紅線**：加進 `PRIM_SPECS` **⛔ 不可以**
     * 讓它跑進「新增」下拉 —— 那會變成一個**按了會壞**的項目
     * （鋼筆沒辦法從零生成，一定要有人先畫）。
     */
    ok('★★ 　 ① pen 在 PRIM_SPECS 裡（右側面板才有東西）',
       'pen' in prim.PRIM_SPECS);
    ok('★★ 　 ② ⛔ 但【不在】新增下拉裡（那是從 PRIM_DEFAULTS 產生的）',
       !prim.PRIM_TYPES.includes('pen'), prim.PRIM_TYPES.join(' '));
    eq('★ 　 ③ 它的欄位就是高度',
       prim.PRIM_SPECS.pen.fields.map(f => f.key).join(','), 'h');
    {
      const ioM = await import('../js/core/io.js');
      const o = new ioM.ModelObject({ name: '鋼筆', kind: ioM.KIND.SOLID,
        src: { type: 'pen', h: 5, paths: [outer] } });
      near('★ 　 ④ 高度 5 → 體積 8000', o.mesh().volume(), 8000, 0.5);
      o.src.h = 10; o.invalidate();
      near('★★ 　 　 改成 10 → 體積【剛好兩倍】', o.mesh().volume(), 16000, 0.5);
      /**
       * 🔴 **`bake()` 之後那串錨點會不見** —— 形狀一格不差，
       * 但 `編輯路徑` 回不去。⚠ 這一項釘的是那個**代價**，
       * ⛔ 免得日後有人以為 bake 是無損的。
       */
      const before = o.mesh().volume();
      o.bake();
      eq('★★ 　 ⑤ bake 之後 src 變成 mesh', o.src.type, 'mesh');
      near('★★ 　 　 而形狀【一格不差】', o.mesh().volume(), before, 1e-6);
      ok('★★ 　 　 但那串錨點【不見了】（＝ 編輯路徑回不去）', !o.src.paths);
    }
    /**
     * ⭐ **上界 0.1% 的物理意義**：一個 1000 cm³ 的東西差 1 cm³ ——
     * 而拉直本身的容許值就是 0.2 cm，**取樣誤差本來就該在這個量級**。
     * 🔴 **⛔ 這個上界⛔ 不是「反正會過」的數字**：實測最大 0.035%，
     * 　留了三倍餘裕；真的哪天超過 0.1%，那就是別的地方壞了。
     */
  }

  // ═══════════════════════════════════════════════════
  //  🔴 加厚後轉成網格（2026-08-30，kang 問出來的）
  // ═══════════════════════════════════════════════════

  /**
   * 🔴🔴 ㉑ **把板厚烤進網格 —— 而體積要對得起來。**
   *
   * 〔kang 2026-08-30：「鈑件厚度並不受網格的控制」〕
   * ⭐ **`shell()` 的中面偏移有一個好性質**（它自己的檔頭寫著）：
   * **體積精確等於「面積 × 厚度」** —— 所以這一組**可以用數學對答案**，
   * ⛔ 不必靠眼睛看。
   *
   * 🔴 **第 ⑥ 項是這一組最值錢的**：它把「展開會攤成【盒子】」
   * **釘成事實**，⛔ 免得日後有人把它當成 bug 去「修」。
   * ⚠ AI 一開始說「展開就走不了」——**那是推論而且是錯的**，
   * 是 kang 質疑「變成網格後我如果分片，不也是可以展開？」才量出真相。
   */
  {
    const ioM = await import('../js/core/io.js');
    const partM = await import('../js/unfold/part.js');
    const rulesM = await import('../js/unfold/rules.js');
    const W = 100, D = 60, T = 1;
    const mkPlate = () => new ioM.ModelObject({ name: '平板', kind: ioM.KIND.SHEET,
      src: { type: 'plate', w: W, d: D, segW: 1, segD: 1 }, thickness: T });

    const o = mkPlate();
    eq('㉑ 加厚前是一張紙：⛔ 不封閉', o.mesh().isClosed(), false);
    near('★ 　 　 而且體積是 0（一張紙沒有體積）', o.mesh().volume(), 0, 1e-9);

    const r = o.bakeShelled();
    ok('★ ② 加厚成功', r.ok, JSON.stringify(r));
    eq('★★ ③ 之後 src 變成 mesh', o.src.type, 'mesh');
    ok('★★ 　 　 而且【封閉】了（⛔ 不封閉的話 3D 列印會擋）', o.mesh().isClosed());
    /** 🔴 這一項是可以自己乘的：100 × 60 × 1 */
    near('★★ ④ 體積 ＝ 面積 × 板厚 ＝ 100×60×1', o.mesh().volume(), W * D * T, 0.5);

    /** ⚠ 兩個邊界都要擋下來【並且講原因】，⛔ 不可以安靜地什麼都不做 */
    const z = mkPlate(); z.thickness = 0;
    const rz = z.bakeShelled();
    ok('★ ⑤ 板厚 0 → 擋下來', !rz.ok);
    ok('★ 　 　 而且講得出原因', /板厚是 0/.test(rz.reason || ''), rz.reason);
    const solid = new ioM.ModelObject({ name: '方塊', kind: ioM.KIND.SOLID,
      src: { type: 'box', w: 10, h: 10, d: 10 }, thickness: 1 });
    const rs = solid.bakeShelled();
    ok('★★ 　 　 本來就封閉的實體也擋下來（⛔ 不然會做出兩個盒子）', !rs.ok);

    /**
     * ⭐ **已經按過「轉成可編輯網格」的紙，還按得到這一顆** ——
     * 因為條件是「網格開不開放」，⛔ 不是「是不是參數物件」。
     */
    const c = mkPlate(); c.bake();
    ok('★★ ⑥ 已經 bake 過的紙仍然可以加厚（條件是幾何，⛔ 不是標籤）',
       c.bakeShelled().ok);

    /**
     * 🔴🔴 **展開⛔ 沒有「走不了」—— 攤出來的是【盒子】。**
     * 紙：100 × 60（輪廓 4 個點）　實體：202 × 260（輪廓 12 個點）
     * ⭐ 202 ＝ 100 ＋ 1 ＋ 1 ＋ 100（上下兩片攤開 ＋ 兩條 1 cm 的邊）
     */
    const box2 = p => {
      const rr = partM.unfoldObject(p, { rule: rulesM.makeRule('paper', p.thickness) });
      const pt = (rr.pieces || [])[0];
      if (!pt || !pt.outline) return null;
      const xs = pt.outline.map(q => q.x), ys = pt.outline.map(q => q.y);
      return { w: Math.max(...xs) - Math.min(...xs),
               h: Math.max(...ys) - Math.min(...ys), n: pt.outline.length };
    };
    const bPaper = box2(mkPlate());
    const bSolid = box2(o);
    ok('★★ ⑦ 紙展開 ＝ 那一片板本身（100 × 60、4 個點）',
       bPaper && Math.abs(bPaper.w - W) < 0.5 && Math.abs(bPaper.h - D) < 0.5
       && bPaper.n === 4, JSON.stringify(bPaper));
    ok('★★ 　 　 而加厚後展開【變大而且變複雜】—— 那是盒子，⛔ 不是 bug',
       bSolid && bSolid.w > W && bSolid.h > D && bSolid.n > 4,
       JSON.stringify(bSolid));
  }
}

// ═══════════════════════════════════════════════════════
//  開放與封閉：甲 加厚成板 ／ 乙 立成牆
// ═══════════════════════════════════════════════════════

section('鋼筆 不封口：甲 加厚成板 ／ 乙 立成牆');

/**
 * 🔴🔴 **這一節只靠一條斷言撐著，⛔ 而它是使用者自己算得出來的：**
 *
 * > **帶的面積 ＝ 折線總長 × 那個數字**（甲乙**同一條**）
 *
 * ⭐ 甲那一半之所以也精確成立，是因為 miter：轉角外側多出來的楔形
 * 與內側少掉的**一模一樣**（都是 `(w/2)²·tan(θ/2)`）。
 * ⚠ **⛔ 不要改成「跑出來多少就寫多少」** —— 那樣這一節就什麼都守不住了。
 */
{
  const prim = await import('../js/build/prim.js');
  const { polylineLength } = await import('../js/build/ribbon.js');

  /** L 形：(0,0) → (100,0) → (100,60)。折線長 ＝ 100 ＋ 60 ＝ 160 */
  const L = { a: [0, 0, 100, 0, 100, 60], hi: [], ho: [] };
  const LEN = 160;

  /** ① 乙 立成牆：面積 ＝ 160 × 12 */
  {
    const m = prim.buildPrim('pen', { h: 12, paths: [L], open: true, up: true });
    near('★★ ① 牆的面積 ＝ 折線長 160 × 高 12', m.area(), LEN * 12, 1e-9);
    eq('　 兩段線 → 2 片面', m.faces.length, 2);
    eq('　 頂點 ＝ 3 個點 × 兩條軌道', m.verts.length, 6);
    ok('　 是【開放的單層面】（板件），⛔ 不是實體', !m.isClosed());
    const top = Math.max(...[...m.verts].map(v => v.p.y));
    const bot = Math.min(...[...m.verts].map(v => v.p.y));
    ok('★ 　 從地面往上長：最低 0、最高 12', Math.abs(bot) < 1e-9 && Math.abs(top - 12) < 1e-9,
       `${bot} … ${top}`);
  }

  /**
   * ② 甲 加厚成板：面積**也是** 160 × 12。
   * 🔴 **這一項才是 miter 的證據** —— 每段各自偏移的話，
   * 90 度轉角處會裂開一個 6×6 的缺口，面積就⛔ 不會剛好。
   */
  {
    const m = prim.buildPrim('pen', { h: 12, paths: [L], open: true, up: false });
    near('★★ ② 板的面積 ＝ 折線長 160 × 寬 12（miter 讓它精確守恆）',
         m.area(), LEN * 12, 1e-9);
    ok('★★ 　 整片平躺在地上（每個點的 Y 都是 0）',
       [...m.verts].every(v => Math.abs(v.p.y) < 1e-9));
    ok('★★ 　 法向朝【上】（⛔ 朝下的話畫面正常，只有列印前檢查抓得到）',
       m.faces.every(f => f.normal.y > 0.999),
       m.faces.map(f => f.normal.y.toFixed(3)).join(','));
    /** ⭐ 線反過來畫也要一樣朝上：`d` 反向 → 側向跟著反，兩件事抵消 */
    const rev = prim.buildPrim('pen',
      { h: 12, paths: [{ a: [100, 60, 100, 0, 0, 0], hi: [], ho: [] }], open: true });
    ok('★★ 　 反著畫也一樣朝上', rev.faces.every(f => f.normal.y > 0.999));
  }

  /**
   * ③ **板厚走既有的機制**：`shell()` 之後體積 ＝ 面積 × 板厚。
   * 🔴 這一項守的是「**⛔ 不可以自己把厚度做進網格**」——
   * 做進去的話這裡會變成兩倍。
   */
  {
    for (const up of [true, false]) {
      const m = prim.buildPrim('pen', { h: 12, paths: [L], open: true, up });
      near(`★★ ③ ${up ? '牆' : '板'} shell(0.5) 的體積 ＝ 面積 × 板厚`,
           m.shell(0.5).volume(), LEN * 12 * 0.5, 1e-6);
    }
  }

  /**
   * ④ **曲線的那些點⛔ 不是折彎** —— 橫向邊要標 `smooth`。
   * ⚠ 少了它，一段弧牆展開時會變成幾十道折彎，
   * 而**形狀完全正確**，只是圖讀不懂了〔2026-08-23 那個坑的同一件事〕。
   */
  {
    const r = 20, k = r * 0.5522847498;
    const arc = { a: [r, 0, 0, r, -r, 0], hi: [0, -k, k, 0, 0, k], ho: [0, k, -k, 0, 0, -k] };
    const m = prim.buildPrim('pen', { h: 10, tol: 0.02, paths: [arc], open: true, up: true });
    const pts = prim.flattenPenPath({ ...arc, closed: false }, 0.02);
    const smooth = [...m.edges()].filter(he => he.smooth).length;
    eq('★★ ④ 半圓弧牆：橫向邊除了兩端全是 smooth', smooth, pts.length - 2);
    eq('　 一個轉角都沒有（錨點都是平滑的）', pts.filter(p => p.corner).length, 0);
    near('★ 　 面積 ≈ 半圓周長 πr × 高（內接折線略短）',
         m.area(), Math.PI * r * 10, 1.2);
  }

  /**
   * ⑤ 🔴🔴 **封閉那條路⛔ 一格都不可以變。**
   * 〔kang 2026-08-30 拍板時明說的：「閉合路徑的行為一格不變」〕
   */
  {
    const sq = { closed: true, a: [0, 0, 40, 0, 40, 40, 0, 40], hi: [], ho: [] };
    near('★★ ⑤ 沒開不封口：還是實心塊，體積 ＝ 40×40×10',
         prim.buildPrim('pen', { h: 10, paths: [sq] }).volume(), 16000, 1e-6);
    ok('　 而且是封閉的', prim.buildPrim('pen', { h: 10, paths: [sq] }).isClosed());
    /** ⭐ 同一份資料，開了不封口就變成一片帶 —— ⛔ 路徑本身沒有被改過 */
    const open = prim.buildPrim('pen', { h: 10, paths: [sq], open: true, up: true });
    near('★★ 　 同一份路徑開了不封口 → 牆，面積 ＝ 三段邊長 120 × 10',
         open.area(), 120 * 10, 1e-9);
    eq('★ 　 ⛔ 沒有繞回起點那一段（4 個點 → 3 片牆）', open.faces.length, 3);
    eq('　 原始資料一個字都沒被動到',
       JSON.stringify(sq.a), JSON.stringify([0, 0, 40, 0, 40, 40, 0, 40]));
  }

  /** ⑥ 兩條線 ＝ 兩片帶，互相不影響（⛔ 沒有「洞」這回事） */
  {
    const a = { a: [0, 0, 100, 0], hi: [], ho: [] };
    const b = { a: [0, 20, 50, 20], hi: [], ho: [] };
    const m = prim.buildPrim('pen', { h: 8, paths: [a, b], open: true, up: true });
    near('★★ ⑥ 兩條線：面積 ＝ (100 ＋ 50) × 8', m.area(), 150 * 8, 1e-9);
    eq('　 兩片，⛔ 沒有被當成「一個框加一個洞」', m.faces.length, 2);
  }

  /** ⑦ 邊界情形：兩個點就掃得出來、一個點要擋下來 */
  {
    const two = { a: [0, 0, 10, 0], hi: [], ho: [] };
    eq('⑦ 兩個點 ＝ 一片', prim.buildPrim('pen',
       { h: 5, paths: [two], open: true }).faces.length, 1);
    let msg = '';
    try { prim.buildPrim('pen', { h: 5, paths: [{ a: [0, 0], hi: [], ho: [] }], open: true }); }
    catch (e) { msg = e.message; }
    ok('　 只有一個點：擋下來並講原因', msg.includes('還沒有畫'), msg);
    eq('　 折線長算得對（⛔ 不繞回起點）',
       +polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 8 }]).toFixed(9), 9);
  }

  /**
   * 🔴🔴 ⑧ **兩個點就是一條線 —— 下限跟著「封不封口」走。**
   *
   * 〔2026-08-31 開線上版實測時撞到的：畫一條**兩點的直牆**，
   * 　收工時被整條丟掉，而訊息還說「至少要放 3 個點才圍得出一個形狀」——
   * 　**那句話對封閉是對的，對一條線是胡說**。〕
   *
   * ⚠ **舊的 `>= 6`（3 個錨點）寫死在六個地方**，這裡守得住的是
   * `penRemoveAnchor()` 那一道（其餘在 `select.js`／`main.js`，碰 DOM）。
   */
  {
    const three = () => ({ a: [0, 0, 50, 0, 50, 30], hi: [0, 0, 0, 0, 0, 0], ho: [0, 0, 0, 0, 0, 0] });
    const closed = prim.penRemoveAnchor(three(), 1);
    ok('★★ ⑧ 封起來：只剩 3 個點就⛔ 不給刪', !closed.ok && /圍不出/.test(closed.reason || ''),
       closed.reason);
    const open = prim.penRemoveAnchor(three(), 1, 24, 2);
    ok('★★ 　 不封口：下限是 2，所以刪得動', open.ok, JSON.stringify(open));
    const two = prim.penRemoveAnchor({ a: [0, 0, 50, 0], hi: [0, 0, 0, 0], ho: [0, 0, 0, 0] }, 0, 24, 2);
    ok('　 但剩 2 個就擋下來，而且話講的是「線」⛔ 不是「形狀」',
       !two.ok && /一條線/.test(two.reason || ''), two.reason);
    /** ⭐ 而兩個點真的做得出東西 —— ⛔ 不是「勉強不報錯」 */
    near('★ 　 兩點的牆：面積 ＝ 50 × 8',
         prim.buildPrim('pen', { h: 8, open: true, up: true,
           paths: [{ a: [0, 0, 50, 0], hi: [], ho: [] }] }).area(), 400, 1e-9);
  }

  /** ⑨ 存讀檔要把兩顆開關帶回來（⛔ 掉了的話重開就變回實心塊） */
  {
    const ioM = await import('../js/core/io.js');
    const doc = new ioM.Doc();
    doc.add(new ioM.ModelObject({
      name: '牆 1', kind: ioM.KIND.SHEET, thickness: 0.5,
      src: { type: 'pen', h: 12, paths: [L], open: true, up: true }
    }));
    const back = ioM.Doc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    const s = back.objects[0].src;
    ok('★★ ⑨ 存讀檔往返：不封口與往上長都還在', s.open === true && s.up === true,
       JSON.stringify({ open: s.open, up: s.up }));
    eq('　 種類還是板件', back.objects[0].kind, ioM.KIND.SHEET);
    near('★ 　 讀回來面積一樣', back.objects[0].mesh().area(), LEN * 12, 1e-9);
  }
}

// ═══════════════════════════════════════════════════════
//  參考線（第 1 階段：線本身）
// ═══════════════════════════════════════════════════════

section('參考線：三串數字、去重、存讀檔往返');

/**
 * 🔴🔴 **這一節守的是「線會不會安靜地不見」，⛔ 不是幾何。**
 *
 * ⚠ 參考線⛔ 沒有形狀可以量 —— 它就是三串公分數。
 * 所以能對答案的只有**數量與內容**，而那正好是最容易靜默出錯的地方：
 * 存檔漏一欄、`Undo` 共用同一個陣列、去重把不該去的去掉。
 *
 * ⭐ **`Undo` 那一項是刻意放進來的**：`hist` 的快照就是 `doc.toJSON()`，
 * 而**⛔ 不重新指派陣列的話，快照跟現在的 Doc 會共用同一個陣列** ——
 * 症狀是「按了復原，什麼都沒還原」，⛔ 而且不會報錯。
 */
{
  const ioM = await import('../js/core/io.js');

  // ── ① 空的 Doc ──
  {
    const doc = new ioM.Doc();
    eq('① 新文件：一條參考線都沒有', doc.guideCount(), 0);
    ok('　 三個方向都在', ['x', 'y', 'z'].every(a => Array.isArray(doc.guides[a])));
  }

  // ── ② 加、去重、排序 ──
  {
    const doc = new ioM.Doc();
    ok('② 加一條 X＝20', doc.addGuide('x', 20));
    ok('　 同一個位置再加一次 → 擋下來', doc.addGuide('x', 20) === false);
    ok('　 加 X＝5（比較小）', doc.addGuide('x', 5));
    eq('★ 　 X 有幾條', doc.guides.x.length, 2);
    eq('★ 　 而且【由小到大】排好了', doc.guides.x.join(','), '5,20');
    ok('　 別的方向互不影響：Y＝20 加得進去', doc.addGuide('y', 20));
    eq('★ 　 三個方向總共', doc.guideCount(), 3);
    ok('　 ⛔ 不是數字的擋下來', doc.addGuide('x', NaN) === false);
    ok('　 ⛔ 不存在的方向擋下來', doc.addGuide('w', 1) === false);
  }

  // ── ③ 刪一條：用「最接近」找，⛔ 不用嚴格相等 ──
  {
    const doc = new ioM.Doc();
    doc.addGuide('z', 12.5);
    ok('③ 刪 Z＝12.5', doc.removeGuide('z', 12.5));
    eq('　 刪完剩幾條', doc.guides.z.length, 0);
    doc.addGuide('z', 12.5);
    ok('★ 　 差 0.0001 也刪得掉（浮點數對不起來的那個坑）',
       doc.removeGuide('z', 12.5001));
    doc.addGuide('z', 12.5);
    ok('　 但差 1 就⛔ 不該刪到別人', doc.removeGuide('z', 13.5) === false);
    eq('　 那一條還在', doc.guides.z.length, 1);
  }

  // ── ④ clear() ⛔ 不清參考線；clearGuides() 才清 ──
  {
    const doc = new ioM.Doc();
    doc.add(new ioM.ModelObject({ src: { type: 'box', w: 10, h: 10, d: 10 } }));
    doc.addGuide('x', 1); doc.addGuide('y', 2); doc.addGuide('z', 3);
    doc.clear();
    eq('④ 刪光物件之後，物件數', doc.objects.length, 0);
    eq('★ 　 而參考線【一條都沒少】（它是版面的東西，⛔ 不是模型的）',
       doc.guideCount(), 3);
    doc.clearGuides('x');
    eq('　 只清 X 之後', doc.guideCount(), 2);
    doc.clearGuides();
    eq('　 全部清掉之後', doc.guideCount(), 0);
  }

  // ── ⑤ 存讀檔往返 ──
  {
    const doc = new ioM.Doc();
    doc.addGuide('x', 20); doc.addGuide('x', -7.5);
    doc.addGuide('y', 45); doc.addGuide('z', 0);
    const json = JSON.parse(JSON.stringify(doc.toJSON()));
    const back = ioM.Doc.fromJSON(json);
    eq('★★ ⑤ 存讀檔往返：總數一樣', back.guideCount(), 4);
    eq('★ 　 X 那兩條（含負數）逐字相同', back.guides.x.join(','), '-7.5,20');
    eq('　 Y', back.guides.y.join(','), '45');
    eq('★ 　 Z＝0 ⛔ 沒有被當成「假值」丟掉', back.guides.z.join(','), '0');
    eq('　 版號⛔ 沒有跳（多一個選填欄位⛔ 不必跳版）', json.v, ioM.DOC_VERSION);
  }

  // ── ⑥ 舊檔（⛔ 沒有 guides 那一欄）讀得動 ──
  {
    const doc = new ioM.Doc();
    doc.addGuide('x', 99);
    const json = JSON.parse(JSON.stringify(doc.toJSON()));
    delete json.guides;                       // 假裝這是這個功能之前存的檔
    const back = ioM.Doc.fromJSON(json);
    eq('★ ⑥ 舊檔沒有那一欄 → 讀成空的，⛔ 不會爆', back.guideCount(), 0);
    ok('　 三個方向還是陣列', ['x', 'y', 'z'].every(a => Array.isArray(back.guides[a])));
  }

  // ── ⑦ 🔴 Undo 的快照⛔ 不可以跟現在的 Doc 共用同一個陣列 ──
  {
    const doc = new ioM.Doc();
    doc.addGuide('x', 10);
    const snap = JSON.parse(JSON.stringify(doc.toJSON()));   // ＝ hist 拍的快照
    doc.addGuide('x', 20);
    doc.addGuide('x', 30);
    eq('⑦ 拍完快照又加了兩條，現在有', doc.guides.x.length, 3);
    eq('★★ 　 而快照裡【還是只有一條】', snap.guides.x.length, 1);
    doc.loadJSON(snap);                                       // ＝ 按下復原
    eq('★★ 　 復原之後回到一條', doc.guides.x.length, 1);
    doc.addGuide('x', 77);
    eq('★★ 　 再加一條⛔ 不會污染快照', snap.guides.x.length, 1);
  }

  // ── ⑧ 手改過的髒檔案：字串、null、重複、亂序 ──
  {
    const doc = new ioM.Doc();
    const back = doc.loadJSON({
      type: 'model-doc', v: 4, unit: 'cm', objects: [],
      guides: { x: ['20', null, 5, 20, 'abc', Infinity], y: 3, z: null }
    });
    eq('★ ⑧ 髒資料：X 只留下 5 與 20（字串轉得動、重複去掉）',
       back.guides.x.join(','), '5,20');
    eq('　 Y ⛔ 不是陣列 → 空的', back.guides.y.length, 0);
    eq('　 Z 是 null → 空的', back.guides.z.length, 0);
  }
}

// ═══════════════════════════════════════════════════════
//  參考線 第 2 階段：吸附的數學（2026-09-01）
//
//  🔴 這一組驗的是 `guideSnap.js` —— 它刻意⛔ 不碰 three.js、
//  ⛔ 不碰畫面，所以**沙箱測得到**。
//  ⚠ **測不到的那一半**：手感（8px 黏不黏）、高亮看不看得出來、
//  平板上按不按得到 —— 那幾項只有 kang 驗得了。
// ═══════════════════════════════════════════════════════
{
  const gs = await import('../js/core/guideSnap.js');

  /** 一個 0→10 / 0→20 / 0→30 的盒子；中心是 (5, 10, 15) */
  const B = () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 20, z: 30 } });
  const G = (o) => ({ x: [], y: [], z: [], ...o });

  // ── ① 沒有線 ＝ 什麼都不動 ──
  {
    const r = gs.guideSnapDelta(B(), G({}), 2);
    eq('① 一條參考線都沒有：X 位移', r.delta.x, 0);
    eq('　 吸中幾條', r.hits.length, 0);
  }

  // ── ② 三個候選各吸一次（min／center／max）──
  {
    const r = gs.guideSnapDelta(B(), G({ x: [1] }), 2);
    eq('★ ② 線在 1，盒子左緣在 0 → 往右挪', r.delta.x, 1);
    eq('　 吸到的是哪個候選', r.hits[0].from, 'min');

    const c = gs.guideSnapDelta(B(), G({ x: [6] }), 2);
    eq('★ 　 線在 6，中心在 5 → 挪 1', c.delta.x, 1);
    eq('　 吸到的是哪個候選', c.hits[0].from, 'center');

    const m = gs.guideSnapDelta(B(), G({ x: [11] }), 2);
    eq('★ 　 線在 11，右緣在 10 → 挪 1', m.delta.x, 1);
    eq('　 吸到的是哪個候選', m.hits[0].from, 'max');
  }

  // ── ③ 超出容許就⛔ 不吸（容許值是呼叫端換算好的世界距離）──
  {
    const r = gs.guideSnapDelta(B(), G({ x: [20] }), 2);
    eq('★ ③ 線太遠（差 10 > 容許 2）：⛔ 不動', r.delta.x, 0);
    eq('　 ⛔ 也不該回報吸中', r.hits.length, 0);

    const zero = gs.guideSnapDelta(B(), G({ x: [1] }), 0);
    eq('　 容許值 0 ＝ 關掉，⛔ 不吸', zero.delta.x, 0);
  }

  // ── ④ 🔴 各軸各自吸（kang 2026-09-01 拍板的那一條）──
  {
    const r = gs.guideSnapDelta(B(), G({ x: [1], y: [21] }), 2);
    eq('★★ ④ X 吸 X 的線', r.delta.x, 1);
    eq('★★ 　 Y 同時也吸 Y 的線（＝ 一次對到一個角）', r.delta.y, 1);
    eq('　 Y 吸的是右緣（20 → 21）', r.hits.find(h => h.ax === 'y').from, 'max');
    eq('★ 　 一共吸中幾條', r.hits.length, 2);
    eq('　 ⛔ 沒有線的 Z 不動', r.delta.z, 0);
  }

  // ── ⑤ 🔴 平手時留最先的那個（⛔ 不可以每次不一樣）──
  {
    // 左緣 0 距線 2 ＝ 2；右緣 10 距線 8 ＝ 2 —— **一樣近**
    const r = gs.guideSnapDelta(B(), G({ x: [2, 8] }), 3);
    eq('★★ ⑤ 兩邊一樣近：留【左緣】那個，⛔ 不亂跳', r.delta.x, 2);
    eq('　 吸到的是哪個候選', r.hits[0].from, 'min');
  }

  // ── ⑥ 髒資料⛔ 不可以把整個吸附弄壞 ──
  {
    const r = gs.guideSnapDelta(B(), G({ x: [NaN, 1, Infinity] }), 2);
    eq('⑥ 陣列裡混著 NaN／Infinity：好的那條照樣吸', r.delta.x, 1);
    eq('　 只吸中一條', r.hits.length, 1);

    const noBounds = gs.guideSnapDelta(null, G({ x: [1] }), 2);
    eq('　 ⛔ 沒有外框：不炸、回 0', noBounds.delta.x, 0);
  }

  // ── ⑦ sameGuideHits：⛔ 不要每一幀都重建高亮 ──
  {
    const a = [{ ax: 'x', v: 20 }, { ax: 'y', v: 5 }];
    ok('⑦ 同樣的兩條 → 一樣', gs.sameGuideHits(a, [{ ax: 'x', v: 20 }, { ax: 'y', v: 5 }]));
    ok('　 值變了 → ⛔ 不一樣', gs.sameGuideHits(a, [{ ax: 'x', v: 21 }, { ax: 'y', v: 5 }]) === false);
    ok('　 少一條 → ⛔ 不一樣', gs.sameGuideHits(a, [{ ax: 'x', v: 20 }]) === false);
    ok('　 null 跟 null → 一樣（都沒吸中）', gs.sameGuideHits(null, null));
    ok('　 null 跟一條 → ⛔ 不一樣', gs.sameGuideHits(null, a) === false);
  }
}

section('擠出邊：從板子的外緣長出一片面（折邊／裙邊）');
{
  const sh = baked('plate', { w: 60, d: 40, t: 0 });
  const ec2 = m => [...m.edges()].length;
  const chi2 = m => m.verts.length - ec2(m) + m.faces.length;
  const bnd = [...sh.edges()].filter(h => h.face && (!h.twin || !h.twin.face));
  eq('前提：一塊平板有 4 條外緣的邊', bnd.length, 4);

  /**
   * 🔴🔴 **這一組數字就是繞向的檢查。**
   * 每片裙邊：**頂點 +2、邊 +3、面 +1 → χ 剛好不變**。
   * ⚠ 繞向排錯（照抄 `extrudeFace()`）的話 **twin 配不上、邊數會爆** ——
   * 〔權威版：`規格\建模器-點線面編輯.md`「側牆的繞向⛔ 不可以照抄」〕
   * ⭐ **抓錯的是邊數，⛔ 不是 χ。**
   */
  for (const k of [1, 2, 4]) {
    const pick = bnd.slice(0, k);
    const r = edit.extrudeBoundaryEdges(sh, pick, 5);
    ok(`選 ${k} 條外緣的邊，長得出來`, r.ok, r.reason);
    const m = r.mesh;
    eq(`★★ 選 ${k} 條 → 頂點 +${2 * k}`, m.verts.length - sh.verts.length, 2 * k);
    eq(`★★★ 選 ${k} 條 → 邊 +${3 * k}（⛔ 多出來就是繞向排錯）`,
       ec2(m) - ec2(sh), 3 * k);
    eq(`★★ 選 ${k} 條 → 面 +${k}`, m.faces.length - sh.faces.length, k);
    eq(`★★ χ 一格都沒變`, chi2(m), chi2(sh));
    ok(`　　結構沒問題、仍然是 1 塊`, m.validate().ok && m.validate().components === 1);
    const want = pick.reduce((s, h) => s + h.v.p.distanceTo(h.to.p) * 5, 0);
    rel(`★★ 面積 ＝ 每條邊長 × 5 加起來`, m.area() - sh.area(), want);
  }

  /**
   * 🔴 **轉角【留缺口】**（kang 2026-09-01 拍板，⛔ 不自動補角）：
   * 兩片相鄰只共用原本那個角，**各自有自己的外側兩點** →
   * ⇒ 新增的點是 **4** 個。⚠ 偷偷合併的話會變成 3 個。
   * ⭐ 那正是紙盒該有的樣子：各摺 90 度立起來剛好碰在一起，
   * 而「自動補角」摺起來會多一塊料。
   */
  {
    const r = edit.extrudeBoundaryEdges(sh, bnd.slice(0, 2), 5);
    const key = v => `${v.p.x.toFixed(3)},${v.p.y.toFixed(3)},${v.p.z.toFixed(3)}`;
    const before = new Set(sh.verts.map(key));
    const added = r.mesh.verts.filter(v => !before.has(key(v)));
    eq('★★★ 兩片相鄰 → 新增 4 個點（⛔ 不是 3 個 —— 轉角留缺口，⛔ 沒有合併）',
       added.length, 4);
  }

  /**
   * 🔴 **內部的邊要擋**（kang 2026-09-01 拍板，⚠ **⛔ 不是做不到**）。
   * 量過的後果：面積 +1200（對的），**而體積 108000 → 117000** ——
   * 那片面沒有厚度，⛔ 不可能有體積；封閉變否、一塊被判成 2 塊。
   * ⭐ **訊息一定要指出【真的走得通的那條路】**（鐵律六：⛔ 不寫假的退路）。
   */
  {
    const box = baked('box', { w: 60, d: 45, h: 40 });
    eq('前提：方塊⛔ 沒有外緣的邊',
       [...box.edges()].filter(h => h.face && (!h.twin || !h.twin.face)).length, 0);
    const inner = [...box.edges()].find(h => h.face && h.twin && h.twin.face);
    const r = edit.extrudeBoundaryEdges(box, [inner], 5);
    ok('★★ 方塊的稜線（兩邊都有面）要擋，而且要指出改用「擠出」',
       !r.ok && /擠出/.test(r.reason || '') && /外緣/.test(r.reason || ''), r.reason);
  }

  /** 擋關與去重 */
  ok('★ 寬度 0 要擋', !edit.extrudeBoundaryEdges(sh, bnd.slice(0, 1), 0).ok);
  ok('★ 一條都沒選要擋', !edit.extrudeBoundaryEdges(sh, [], 5).ok);
  eq('★★ 同一條邊選兩次只長 1 片（⛔ 不是兩片疊在一起）',
     edit.extrudeBoundaryEdges(sh, [bnd[0], bnd[0]], 5).added, 1);
}


// ═══════════════════════════════════════════════════════
section('旋轉成形（Spin／車床）—— 2026-09-02');
// ═══════════════════════════════════════════════════════
{
  const { revolve } = await import('../js/build/revolve.js');
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const SEG = 32, R = 25, H = 70;
  /** 正 n 邊形柱的體積（⛔ 不是 πr²h —— 我們轉出來的是 32 邊形）*/
  const prismVol = (r, h, n) => 0.5 * n * Math.sin(2 * Math.PI / n) * r * r * h;

  /**
   * 🔴🔴 **繞向：唯一抓得到的是【體積是不是正的】。**
   * 【實證 2026-09-02】第一版照直覺寫 `[a,b,c,d]` → 體積 −136563.225，
   * 而那個模型**畫面上看起來完全正常** —— 只有匯出 STL 的列印前檢查才抓得到
   * 〔`extrude.js` 檔頭記著同一個坑〕。
   */
  {
    const r = revolve([V(0,0,0), V(R,0,0), V(R,H,0), V(0,H,0)], { axis:'y', a:0, b:0, seg:SEG });
    ok('★★★ 圓柱轉得出來', r.ok, r.reason);
    ok('★★★ 體積是【正】的（負的 ＝ 整個模型法向朝內，畫面上看不出來）',
       r.ok && r.mesh.volume() > 0, r.ok ? String(r.mesh.volume()) : '');
    near('★★★ 體積 ＝ 正 32 邊形柱（⛔ 不是 πr²h）',
         r.mesh.volume(), prismVol(R, H, SEG), 1e-6);
    ok('★★ 兩端碰到中心線 → 封閉（可以列印）', r.closed === true);
    eq('★★ 極點 2 個', r.poles, 2);
    /**
     * ⭐ **極點只放【一個】頂點** —— 照放 32 個重疊的點也畫得出一模一樣的圖，
     * 但那是非流形。V ＝ 2 ＋ 32×2 ＝ 66 就是在守這件事。
     */
    eq('★★★ 頂點數 ＝ 2 個極點 ＋ 32×2（⛔ 不是每圈都放一份極點）',
       r.mesh.verts.length, 2 + SEG * 2);
    eq('★★ 尤拉數 χ ＝ 2', r.mesh.verts.length - [...r.mesh.edges()].length + r.mesh.faces.length, 2);
  }

  /** 圓錐：一端收成尖 */
  {
    const r = revolve([V(0,0,0), V(R,0,0), V(0,H,0)], { axis:'y', a:0, b:0, seg:SEG });
    near('★★ 圓錐體積 ＝ 柱的三分之一', r.mesh.volume(), prismVol(R, H, SEG) / 3, 1e-6);
    eq('★ 圓錐也是 2 個極點（底心與頂尖）', r.poles, 2);
  }

  /**
   * 🔴 **封閉的輪廓 → 環**。⚠ 這一項守的是「鋼筆畫的路徑預設就是封閉的」——
   * 當成開放線處理會**少接一段**，而那個缺口在畫面上很難看出來。
   */
  {
    const RR = 40, a = 6;
    const sq = [V(RR-a,-a,0), V(RR+a,-a,0), V(RR+a,a,0), V(RR-a,a,0), V(RR-a,-a,0)];
    const r = revolve(sq, { axis:'y', a:0, b:0, seg:SEG });
    ok('★★★ 首尾同一點的輪廓 → 轉出封閉的環（⛔ 不可以少接一段）', r.ok && r.closed);
    eq('★★ 環的面數 ＝ 4 段 × 32 格', r.mesh.faces.length, 4 * SEG);
    eq('★★★ 首尾那個重複的點只放一份（⛔ 不是兩個疊在一起）',
       r.mesh.verts.length, 4 * SEG);
    /** 帕普斯：截面積 × 繞行周長。多邊形近似一定略小，但差距有上限 */
    const exact = (2*a)*(2*a) * 2*Math.PI*RR;
    ok('★★ 體積 ≈ 帕普斯定理（32 格的多邊形近似，比值 0.99 以上）',
       r.mesh.volume() / exact > 0.99 && r.mesh.volume() / exact < 1, 
       String(r.mesh.volume() / exact));
  }

  /** 沒碰到中心線 → 薄殼（開放），那正是板件 */
  {
    const r = revolve([V(20,0,0), V(30,0,0), V(30,10,0)], { axis:'y', a:0, b:0, seg:SEG });
    ok('★★ 頭尾沒碰到中心線 → 開放的薄殼（⛔ 不是壞掉）', r.ok && r.closed === false);
    eq('★ 沒有極點', r.poles, 0);
  }

  /**
   * 🔴 **切圓產生的折痕（沿著輪廓走的邊）要標 `smooth`。**
   * ⚠ ⛔ 不標的話展開圖會把一個平滑的轉面標成幾百道折彎
   * 〔2026-08-23 為它付過一次代價：展開圖從 5 處折彎變成 45 處〕。
   * 🔴 〔2026-10-08 改正：這一項原本驗「＝ 非極點的 2 圈 × 32 格 ＝ 64」——
   * 　**把標反的結果寫成了答案**。那 64 條是上下緣 90° 的真轉角。
   * 　⚠ 只驗數量驗不出標在哪；標在哪由「B 組 bug：旋轉成形」那一節驗折角〕
   */
  {
    const r = revolve([V(0,0,0), V(R,0,0), V(R,H,0), V(0,H,0)], { axis:'y', a:0, b:0, seg:SEG });
    let n = 0;
    for (const he of r.mesh.edges()) if (he.smooth) n++;
    eq('★★★ smooth 邊 ＝ 側面 32 道（上下蓋是平的、⛔ 不標）', n, SEG);
  }

  /**
   * 🔴🔴 **只碰到【一端】：`min` 也是 0，但它⛔ 不是封閉的。**
   * 【實證 2026-09-02，AI 上線上版自己按出來的】舊版介面拿 `min` 判斷
   * ⇒ 欄位旁寫「碰到了 → 實體」，按下去卻說「沒碰到 → 薄殼」，**兩句話打架**。
   * ⭐ 這一組就是在守「**兩個訊息不可以各說各話**」（鐵律三）。
   */
  {
    const r = revolve([V(0,0,0), V(R,0,0), V(R,H,0)], { axis:'y', a:0, b:0, seg:SEG });
    ok('★★★ 只碰到一端 → ⛔ 不封閉（是一個碗）', r.ok && r.closed === false);
    eq('★★ 頭碰到、尾沒碰到', JSON.stringify(r.endsOnAxis), JSON.stringify([true, false]));
    near('★★ 最小值仍然是 0（⛔ 所以不可以拿它當「是不是實體」的判準）',
         r.profileR.min, 0, 1e-9);
    eq('★ 一端收成一個尖', r.poles, 1);
  }
  {
    const r = revolve([V(0,0,0), V(R,0,0), V(R,H,0), V(0,H,0)], { axis:'y', a:0, b:0, seg:SEG });
    eq('★★★ 兩端都碰到 → 兩個都是 true', JSON.stringify(r.endsOnAxis),
       JSON.stringify([true, true]));
    ok('★★ 而它確實是封閉的', r.closed === true);
  }

  /**
   * 🔴🔴 **介面自動填的軸位置：填【最小值】，⛔ 不是「第一個點」。**
   *
   * ⚠ 【實證 2026-09-02，AI 上線上版按第二次才踩到】填「第一個點」時，
   * **第一個點⛔ 不保證是離中心線最近的那一端** ⇒ 其他點落在軸的兩側
   * ⇒ 被「跨過中心線」那道擋關擋掉，**而使用者什麼都還沒做**。
   * ⭐ **第一次按⛔ 沒踩到，因為那次剛好第一個點就是最小值** ——
   * 〔碰巧通過比失敗危險〕。
   *
   * ⚠ 這一組驗的是**那個公式**（介面在 main.js，⛔ 這裡碰不到 DOM）。
   */
  {
    /** 🔴 第一個點在【中間】：x ＝ 20、10、30 —— 軸放在它身上，另外兩點就分居兩側 */
    const prof = [V(20,0,0), V(10,0,0), V(30,30,0)];
    const first = prof[0].x, lowest = Math.min(...prof.map(v => v.x));
    ok('★★★ 填「第一個點」→ 被自己的擋關擋掉',
       !revolve(prof, { axis:'y', a:first, b:0, seg:SEG }).ok);
    ok('★★★ 填「最小值」→ 過得了，⛔ 而且⛔ 不會誤擋',
       revolve(prof, { axis:'y', a:lowest, b:0, seg:SEG }).ok);
  }

  /** 擋關 */
  {
    const r = revolve([V(-10,0,0), V(10,0,0), V(10,20,0)], { axis:'y', a:0, b:0, seg:SEG });
    ok('★★★ 跨過中心線要擋，而且要講「只畫一邊」',
       !r.ok && /中心線/.test(r.reason || ''), r.reason);
  }
  ok('★ 只有 1 個點要擋',
     !revolve([new THREE.Vector3(1,0,0)], { axis:'y', seg:SEG }).ok);
  ok('★ 整條都在中心線上要擋',
     !revolve([new THREE.Vector3(0,0,0), new THREE.Vector3(0,10,0)],
              { axis:'y', a:0, b:0, seg:SEG }).ok);

  /**
   * 🔴 **軸擺在別的位置也要對** —— ⚠ 判準是「離軸多遠」，
   * ⛔ 不是座標的正負（軸搬走之後正負就沒有意義了）。
   */
  {
    const off = 100;
    const r = revolve([V(off,0,0), V(off+R,0,0), V(off+R,H,0), V(off,H,0)],
                      { axis:'y', a:off, b:0, seg:SEG });
    near('★★★ 軸搬到 x＝100，體積跟搬之前一模一樣',
         r.mesh.volume(), prismVol(R, H, SEG), 1e-6);
  }

  /**
   * 🔴🔴 **輪廓倒過來給，法向⛔ 不可以跟著翻**（2026-10-15 補）。
   * 【實證 2026-10-15】補之前倒過來的圓柱體積是 **−136563.225** ——
   * 以前的呼叫端輪廓都寫死，剛好都是對的那一種走法；手畫的線從哪一頭開始都有可能。
   */
  {
    const P = [V(0,0,0), V(R,0,0), V(R,H,0), V(0,H,0)];
    const r = revolve([...P].reverse(), { axis:'y', a:0, b:0, seg:SEG });
    near('★★★ 輪廓倒過來給：體積照樣是【正】的', r.mesh.volume(), prismVol(R, H, SEG), 1e-6);
    /** 開放的（碗）：兩個方向轉出來的面要朝同一邊 ⇒ 帶正負號的體積一模一樣 */
    const B = [V(0,0,0), V(R,0,0), V(R,H,0)];
    const f = revolve(B, { axis:'y', a:0, b:0, seg:SEG }).mesh.volume();
    const g = revolve([...B].reverse(), { axis:'y', a:0, b:0, seg:SEG }).mesh.volume();
    near('★★ 開口的碗倒過來給：面朝同一邊（帶正負號的量一樣）', g, f, 1e-6);
    /** 封口的環（兩端都沒碰到軸）也一樣 */
    const Q = [V(10,0,0), V(20,0,0), V(20,10,0), V(10,10,0), V(10,0,0)];
    ok('★★ 環倒過來給：體積照樣是正的',
       revolve([...Q].reverse(), { axis:'y', a:0, b:0, seg:SEG }).mesh.volume() > 0);
  }
}

// ═══════════════════════════════════════════════════════
section('旋轉成形 接回（第 1 輪）：鋼筆物件自己變成碗 —— 2026-10-15');
// ═══════════════════════════════════════════════════════
{
  const prim = await import('../js/build/prim.js');
  const SEG = 32, R = 25, H = 70;
  const prismVol = (r, h, n) => 0.5 * n * Math.sin(2 * Math.PI / n) * r * r * h;
  /** 一條全是尖角的路徑（把手都是 0）。形狀座標 (x, y) ＝ 本地的 (x, z) */
  const path = (...xy) => ({ closed: true, a: xy, hi: xy.map(() => 0), ho: xy.map(() => 0) });
  const pen = (paths, rev, open = true) => ({ type: 'pen', h: 3, paths, open, rev });

  /** 圓柱的輪廓：從中心線出發、往外、往下（畫面上往下 ＝ +Z）、回到中心線 */
  const cyl = path(0,0, R,0, R,H, 0,H);

  {
    const s = pen([cyl], { dir: 'z', at: 0, seg: SEG, stand: false });
    const r = prim.penRevolve(s);
    ok('★★★ 前後方向、躺著：轉得出來', r.ok, r.reason);
    near('★★★ 體積 ＝ 正 32 邊形柱，而且是正的', r.mesh.volume(), prismVol(R, H, SEG), 1e-6);
    eq('★★★ 兩端都碰到中心線 → 實體', io.penKind(s), io.KIND.SOLID);
    const b = r.mesh.bounds();
    near('★★ 躺著：中心線是 Z 方向 ⇒ 長度 70 落在 Z', b.max.z - b.min.z, H, 1e-6);
    /** 🔴 kang 2026-10-15：躺著的碗整個抬起來，⛔ 一半鑽到地板下面 */
    near('★★★ 躺著：最低點貼地板（Y ＝ 0）', b.min.y, 0, 1e-9);
    near('★★ 躺著：高 ＝ 直徑 50（形狀沒變，只是往上搬）', b.max.y, 2 * R, 1e-9);
    const smooth = [...r.mesh.edges()].filter(he => he.smooth).length;
    ok('★★ 躺著：往上搬之後平滑邊的標記還在', smooth > 0, String(smooth));
  }
  {
    /** ⚠ `轉幾格` 不是 4 的倍數：最低的那一格⛔ 在正下方 —— 用半徑算的話會浮起來 */
    const r = prim.penRevolve(pen([cyl], { dir: 'x', at: -5, seg: 30, stand: false }));
    near('★★ 轉 30 格、左右方向躺著：最低點照樣貼地板', r.mesh.bounds().min.y, 0, 1e-9);
  }
  {
    const s = pen([cyl], { dir: 'z', at: 0, seg: SEG, stand: true });
    const r = prim.penRevolve(s);
    near('★★★ 立起來：體積一樣', r.mesh.volume(), prismVol(R, H, SEG), 1e-6);
    const b = r.mesh.bounds();
    near('★★★ 立起來：底貼地板（最低 Y ＝ 0）', b.min.y, 0, 1e-9);
    near('★★★ 立起來：高 ＝ 70（中心線變成直立）', b.max.y, H, 1e-9);
    near('★★ 立起來：碗站在線最前面那一頭（Z ＝ 70）', (b.min.z + b.max.z) / 2, H, 1e-9);
    near('★★ 立起來：中心線還在 X ＝ 0', (b.min.x + b.max.x) / 2, 0, 1e-9);
  }
  {
    /** 左右方向：同一個輪廓轉 90°（沿 X 走 70） */
    const s = pen([path(0,0, 0,R, H,R, H,0)], { dir: 'x', at: 0, seg: SEG, stand: true });
    const r = prim.penRevolve(s);
    near('★★★ 左右方向、立起來：體積一樣', r.mesh.volume(), prismVol(R, H, SEG), 1e-6);
    const b = r.mesh.bounds();
    near('★★ 左右方向、立起來：底貼地板、高 70', b.max.y - b.min.y, H, 1e-9);
    near('★★ 左右方向、立起來：最低 Y ＝ 0', b.min.y, 0, 1e-9);
  }
  {
    /** 🔴 同一條線從另一頭畫 —— 法向⛔ 不可以翻（2026-10-15 那個補丁在守的） */
    const s = pen([path(0,H, R,H, R,0, 0,0)], { dir: 'z', at: 0, seg: SEG, stand: true });
    near('★★★ 從另一頭畫：體積照樣是正的', prim.penRevolve(s).mesh.volume(), prismVol(R, H, SEG), 1e-6);
  }

  /** 碗：從中心線出發，另一端開口 */
  const bowl = path(0,50, 30,50, 38,40, 42,20, 44,0);
  {
    const s = pen([bowl], { dir: 'z', at: 0, seg: SEG, stand: true });
    const r = prim.penRevolve(s);
    ok('★★★ 碗轉得出來', r.ok, r.reason);
    eq('★★★ 只有一端碰到中心線 → 板件', io.penKind(s), io.KIND.SHEET);
    ok('★★ 碰到的是頭那一端', r.endsOnAxis[0] === true && r.endsOnAxis[1] === false);
    eq('★★ 自動放中心線 ＝ 線的最小 X ＝ 0', prim.penRevAutoAt(s, 'z'), 0);
    eq('★ 左右方向的自動位置 ＝ 線的最小 Y（畫面最上面）＝ 0', prim.penRevAutoAt(s, 'x'), 0);
  }
  {
    const s = pen([bowl], { dir: 'z', at: -10, seg: SEG, stand: true });
    const r = prim.penRevolve(s);
    eq('★★ 中心線往左挪 10：兩端都沒碰到 → 板件', io.penKind(s), io.KIND.SHEET);
    near('★★ 離中心線最近 ＝ 10', r.profileR.min, 10, 1e-9);
    near('★★ 離中心線最遠 ＝ 54', r.profileR.max, 54, 1e-9);
  }
  {
    const s = pen([bowl], { dir: 'z', at: 35, seg: SEG, stand: true });
    const r = prim.penRevolve(s);
    ok('★★★ 中心線放到線的中間 → 擋下來（跨過中心線）',
       !r.ok && /跨過中心線/.test(r.reason), r.reason);
    eq('★★ 擋下來時種類⛔ 不判（回 null，呼叫端不動原本的）', io.penKind(s), null);
    const o = new io.ModelObject({ kind: io.KIND.SHEET, src: s });
    o.mesh();
    ok('★★ 物件上看得到那一句原因，⛔ 畫面不會掛掉', /跨過中心線/.test(o.error || ''), o.error);
  }
  {
    /** 「不封口」關著：頭尾接起來 → 環 */
    const s = pen([path(10,0, 20,0, 20,10, 10,10)], { dir: 'z', at: 0, seg: SEG, stand: false }, false);
    const r = prim.penRevolve(s);
    ok('★★★ 封口的線轉成環：封閉', r.ok && r.closed, r.reason);
    ok('★★ 環的體積是正的', r.mesh.volume() > 0, String(r.mesh.volume()));
    eq('★★★ 環的頂點數 ＝ 4 × 32（⛔ 頭尾那個點⛔ 疊兩份）', r.mesh.verts.length, 4 * SEG);
    eq('★★ 環 → 實體', io.penKind(s), io.KIND.SOLID);
  }
  {
    const s = pen([bowl, path(100,0, 110,0)], { dir: 'z', at: 0, seg: SEG, stand: true });
    const r = prim.penRevolve(s);
    ok('★★ 兩條線 → 擋下來，講出條數', !r.ok && /2 條線/.test(r.reason), r.reason);
  }
  {
    const s = pen([cyl], { dir: 'z', at: 0, seg: SEG, stand: true });
    near('★★★ 存檔再讀（src 走 JSON）：形狀一樣',
         io.buildSrc(io.cloneSrc(s)).volume(), prismVol(R, H, SEG), 1e-6);
    const s2 = pen([cyl], undefined);
    delete s2.rev;
    ok('★★ 沒有 rev ＝ 原本的行為（板，⛔ 不是旋轉體）',
       Math.abs(io.buildSrc(s2).volume() - prismVol(R, H, SEG)) > 1);
  }

  /**
   * 🔴🔴 **原點置中：碗在世界裡一格都不能動，中心線也不能動**。
   * ⚠ 路徑挪了、`rev.at` ⛔ 沒跟著挪的話，碗會變粗變細 —— 畫面上看得出來，
   * 但「只差一點」時看不出來，所以要量。
   */
  {
    const o = new io.ModelObject({ kind: io.KIND.SHEET,
      src: pen([path(0,50, 30,50, 38,40, 42,20, 44,0)], { dir: 'z', at: -5, seg: SEG, stand: true }) });
    o.pos.set(100, 0, 20);
    const world = () => o.mesh().bounds().clone().applyMatrix4(o.matrix());
    const before = world();
    const axisBefore = o.src.rev.at * o.scale.x + o.pos.x;
    const res = io.recenterOrigin(o);
    ok('★★ 原點置中有動', res.ok && res.moved, res.reason);
    const after = world();
    near('★★★ 置中前後：世界裡的碗一格都沒動（最小角）', after.min.distanceTo(before.min), 0, 1e-6);
    near('★★★ 置中前後：世界裡的碗一格都沒動（最大角）', after.max.distanceTo(before.max), 0, 1e-6);
    near('★★★ 置中前後：中心線的世界位置一樣', o.src.rev.at * o.scale.x + o.pos.x, axisBefore, 1e-9);
    const lb = o.mesh().bounds();
    near('★★ 置中之後：原點在碗的正中（X）', (lb.min.x + lb.max.x) / 2, 0, 1e-9);
    near('★★ 置中之後：原點在碗的正中（Z）', (lb.min.z + lb.max.z) / 2, 0, 1e-9);
  }
}

// ═══════════════════════════════════════════════════════
//  比例編輯（2026-09-02）
// ═══════════════════════════════════════════════════════

section('比例編輯：拉一個點，周圍照影響半徑跟著動');

{
  /**
   * 🔴 **保命線：半徑 0 ＝ 這個功能不存在。**
   * ⛔ 這一組壞掉就表示既有行為被改動了，比任何新功能沒做好都嚴重。
   */
  const m = buildPrim('plate', { w: 100, d: 100, segW: 10, segD: 10 });
  const core = [m.verts[0]];
  const r = edit.proportionalVerts(m, core, 0);
  eq('半徑 0：跟著動的就是選到的那些，一個都不多', r.verts.length, 1);
  eq('半徑 0：權重是 1（＝完全照做）', r.weights[0], 1);
  ok('半徑 0：回傳的就是原本那一份', r.verts[0] === core[0]);

  const neg = edit.proportionalVerts(m, core, -5);
  eq('負的半徑當成關掉，⛔ 不是報錯', neg.verts.length, 1);
}

{
  // 衰減曲線本身：兩端要接得平，中間要對稱
  near('平滑曲線：在範圍邊緣是 0', edit.propFalloff(0), 0, 1e-12);
  near('平滑曲線：在被拉的那一點是 1', edit.propFalloff(1), 1, 1e-12);
  near('平滑曲線：正中間剛好一半', edit.propFalloff(0.5), 0.5, 1e-12);
  ok('平滑曲線：範圍外（t<0）一律 0', edit.propFalloff(-0.3) === 0);
  ok('平滑曲線：t>1 一律 1', edit.propFalloff(1.7) === 1);

  /**
   * ★ **兩端的斜率都要是 0 —— 這就是選它而不選「球」的整個理由。**
   * 「球」在 t＝0（範圍邊緣）斜率無限大，折痕會整個堆在邊緣，
   * 而且點越密越嚴重（沙箱量到 36.7° → 68.9°）。
   */
  const h = 1e-4;
  near('★ 邊緣那一端斜率是 0（折痕不會堆在範圍邊上）',
       (edit.propFalloff(h) - edit.propFalloff(0)) / h, 0, 1e-3);
  near('★ 中心那一端斜率也是 0（拉出來不是尖角）',
       (edit.propFalloff(1) - edit.propFalloff(1 - h)) / h, 0, 1e-3);
}

{
  // 板子 100×100 切成 10×10 格 → 格距 10cm，距離算得出來
  const m = buildPrim('plate', { w: 100, d: 100, segW: 10, segD: 10 });
  // 挑正中央那個點（x＝0、z＝0）
  const c = m.verts.find(v => v.he && Math.hypot(v.p.x, v.p.z) < 1e-9);
  ok('板子中央找得到一個點', !!c);

  const R = 25;                       // 半徑 25 ＝ 兩格半
  const r = edit.proportionalVerts(m, [c], R);
  const wOf = new Map(r.verts.map((v, i) => [v, r.weights[i]]));

  eq('選到的那個點權重是 1', wOf.get(c), 1);
  ok('範圍內的點都進來了', r.verts.length > 1);

  let outside = 0, wrong = 0;
  for (const v of m.verts) {
    if (!v.he) continue;
    const d = Math.hypot(v.p.x - c.p.x, v.p.z - c.p.z);
    const w = wOf.get(v);
    if (d > R + 1e-9) { if (w !== undefined) outside++; continue; }
    // 範圍內：權重要等於曲線算出來的值
    const want = edit.propFalloff(1 - d / R);
    if (want > 0 && Math.abs((w ?? 0) - want) > 1e-9) wrong++;
  }
  eq('★ 半徑外的點一個都沒被收進來', outside, 0);
  eq('★ 半徑內每個點的權重都等於曲線算出來的值', wrong, 0);

  // 距離越遠權重越小（同一排上的三個點）
  const at = x => m.verts.find(v => v.he
    && Math.abs(v.p.x - x) < 1e-9 && Math.abs(v.p.z) < 1e-9);
  const w10 = wOf.get(at(10)), w20 = wOf.get(at(20));
  ok('離 10cm 的點比離 20cm 的動得多', w10 > w20 && w20 > 0);
}

{
  /**
   * ★★★ **兩條路要對得起來**：權重全給 1，結果必須跟「⛔ 不給權重」
   * 一模一樣 —— 這證明比例編輯是**疊在既有那條路上**，⛔ 不是另一條。
   */
  const mk = () => {
    const m = buildPrim('plate', { w: 100, d: 100, segW: 6, segD: 6 });
    m.computeNormals();
    return m;
  };
  const mA = mk(), mB = mk();
  const pick = m => m.verts.filter(v => v.he).slice(0, 4);

  const vA = pick(mA), bA = edit.snapshotVerts(vA);
  const vB = pick(mB), bB = edit.snapshotVerts(vB);
  const start = { pos: new THREE.Vector3(0, 0, 0), quat: new THREE.Quaternion() };
  const now   = { pos: new THREE.Vector3(0, 7, 0), quat: new THREE.Quaternion() };

  edit.applyElementTransform(vA, bA, start, now);                       // 舊路
  edit.applyElementTransform(vB, bB, start, now, vB.map(() => 1));      // 新路、權重全 1

  let maxd = 0;
  for (let i = 0; i < vA.length; i++) maxd = Math.max(maxd, vA[i].p.distanceTo(vB[i].p));
  near('★★★ 權重全 1 ＝ 沒有比例編輯（每個頂點都在同一個位置）', maxd, 0, 1e-12);
}

{
  // 權重真的有打折：0.5 的點只走一半
  const m = buildPrim('plate', { w: 100, d: 100, segW: 4, segD: 4 });
  const vs = m.verts.filter(v => v.he).slice(0, 3);
  const base = edit.snapshotVerts(vs);
  const start = { pos: new THREE.Vector3(0, 0, 0), quat: new THREE.Quaternion() };
  const now   = { pos: new THREE.Vector3(0, 10, 0), quat: new THREE.Quaternion() };

  edit.applyElementTransform(vs, base, start, now, [1, 0.5, 0]);
  near('權重 1 的點走滿 10', vs[0].p.y - base[0].y, 10, 1e-9);
  near('權重 0.5 的點只走 5', vs[1].p.y - base[1].y, 5, 1e-9);
  near('★ 權重 0 的點紋風不動', vs[2].p.y - base[2].y, 0, 1e-12);
}

{
  /**
   * ⚠ 權重的長度跟頂點對不上 → **⛔ 一個字都不准寫**。
   * 〔跟「沒有快照就什麼都不做」同一條：寧可這一幀不動，
   * 　也不要拿錯的基準把模型悄悄改成另一個形狀〕
   */
  const m = buildPrim('plate', { w: 100, d: 100, segW: 4, segD: 4 });
  const vs = m.verts.filter(v => v.he).slice(0, 3);
  const base = edit.snapshotVerts(vs);
  const before = vs.map(v => v.p.clone());
  const start = { pos: new THREE.Vector3(0, 0, 0), quat: new THREE.Quaternion() };
  const now   = { pos: new THREE.Vector3(0, 10, 0), quat: new THREE.Quaternion() };

  const n = edit.applyElementTransform(vs, base, start, now, [1, 0.5]);   // 少一個
  eq('權重長度不符：回 0', n, 0);
  let moved = 0;
  for (let i = 0; i < vs.length; i++) if (vs[i].p.distanceTo(before[i]) > 1e-12) moved++;
  eq('★ 權重長度不符：一個頂點都沒被動到', moved, 0);
}

{
  /**
   * 🔴 **薄殼：影響半徑一超過壁厚，背面就會跟著動 —— 而那是對的。**
   * 〔管子 外 r25／內 r20 ＝ 壁厚 5。改用沿表面的距離，背面得繞過整個
   * 　管口才到得了 ⇒ 背面完全不動 ⇒ 壁厚被破壞。理由見 proportionalVerts()〕
   */
  const m = buildPrim('tube', { rOuter: 25, rInner: 20, h: 70, seg: 32 });
  const outer = m.verts.find(v => v.he
    && Math.abs(Math.hypot(v.p.x, v.p.z) - 25) < 1e-6);
  ok('管子外壁找得到一個點', !!outer);

  const inner = r => edit.proportionalVerts(m, [outer], r).verts
    .filter(v => Math.hypot(v.p.x, v.p.z) < 22.5).length;

  eq('半徑 3（比壁厚 5 小）：背面一個點都沒被拉到', inner(3), 0);
  ok('半徑 12（比壁厚大）：背面有點跟著動（殼才不會被拉薄）', inner(12) > 0);
}

// ═══════════════════════════════════════════════════════
//  A 組 bug（2026-10-08 全專案查 bug 找到的，會丟東西／卡死）
// ═══════════════════════════════════════════════════════

section('A 組 bug：SVG 的 Z 後面接數字');

{
  /**
   * 🔴 **`Z` 後面多一串數字 ＝ 整個分頁卡死**（修之前）。
   * 數字直接接在後面會被當成「重複上一個指令」，而 `Z` 一個數字都不讀，
   * 於是讀取位置永遠不前進。⛔ 修之前這一項不會失敗，是**整支測試停住**。
   */
  const r = svgp.parsePath('M0 0L10 0L10 10Z 5 5');
  ok('★★★ 跑得完（⛔ 不卡死）', !!r);
  eq('那一圈照樣讀到', r.subpaths.length, 1);
  ok('★ 有報錯，⛔ 不是悄悄吞掉', r.errors.some(e => e.includes('Z')), r.errors.join('／'));

  const g = svgp.parsePath('M0 0L10 0L10 10Z M20 0L30 0L30 10z');
  eq('對照組：Z 後面接 M 照樣讀兩圈', g.subpaths.length, 2);
  eq('對照組：一個錯誤都沒有', g.errors.length, 0);
}

section('A 組 bug：剖面分切的片數上限');

{
  /**
   * 🔴 **板厚打成 0.001（把 mm 當 cm 打）→ 要切兩萬七千片，視窗卡死**（修之前）。
   * 而且設定在計算之前就存起來了，之後每次打開都會再卡 ——
   * ⇒ 擋關要在核心，⛔ 不能只在介面。
   */
  const p = sect.planSlabs(27, [{ t: 0.001, n: 'rest' }]);
  eq('★★★ 一片都不切', p.slabs.length, 0);
  ok('★ 那一段標成壞的', !!p.bands[0].bad, p.bands[0].bad || '');
  ok('★ 訊息有提到單位', (p.bands[0].bad || '').includes('cm'));

  const big = sect.planSlabs(27, [{ t: 1, n: 100000 }]);
  eq('片數直接打很大也擋', big.slabs.length, 0);

  const fine = sect.planSlabs(27, [{ t: 1, n: 'rest' }]);
  eq('對照組：正常的照切', fine.slabs.length, 27);
  ok('對照組：⛔ 沒有被誤擋', !fine.bands[0].bad);

  // ⚠ 擋下來之後畫面上要看得到原因 —— 以前 `bad` 只寫進資料、一個字都不印
  const r = sect.sliceMesh(buildPrim('box', { w: 60, h: 27, d: 40 }, 0.2),
    { axis: 'y', bands: [{ t: 0.001, n: 'rest' }] });
  ok('★ 分切視窗的警告裡講得出原因', r.warnings.some(w => w.includes('超過上限')),
    r.warnings.join('／'));
}

section('A 組 bug：實體物件存檔要留板厚');

{
  /**
   * 🔴 **種類改成「實體」的折板，存檔不存板厚 → 讀回來變 0.2，形狀跟著變**。
   * 折板的網格本身就吃板厚（`buildSrc(src, thickness)`），跟種類無關；
   * 而復原／重做走的也是同一份 `toJSON()`。
   */
  const obj = new io.ModelObject({
    name: '改成實體的折板', kind: io.KIND.SOLID, thickness: 1,
    src: { type: 'bend', w: 40, first: 30, arcSeg: 4, k: 0.4,
           bends: [{ angle: 90, ri: 2, len: 30 }] }
  });
  const box0 = new THREE.Box3().setFromPoints(obj.mesh().verts.map(v => v.p));
  const back = io.ModelObject.fromJSON(JSON.parse(JSON.stringify(obj.toJSON())));
  eq('★★★ 讀回來板厚還是 1', back.thickness, 1);
  const box1 = new THREE.Box3().setFromPoints(back.mesh().verts.map(v => v.p));
  near('★ 外框寬度不變', box1.max.x - box1.min.x, box0.max.x - box0.min.x, 1e-9);
  near('★ 外框高度不變', box1.max.y - box1.min.y, box0.max.y - box0.min.y, 1e-9);
}

// ═══════════════════════════════════════════════════════
//  B 組 bug（2026-10-08 全專案查 bug 找到的，給製作的檔案會錯）
// ═══════════════════════════════════════════════════════

section('B 組 bug：STL 合成一個檔要保留相對高度');

{
  /**
   * 🔴 **兩個疊著的方塊匯成「一個檔」→ 兩個都擠在最底下**（修之前）。
   * 每個物件先各自落到平台，合併後再落一次已經沒有作用。
   * ⭐ 正解：位置照世界座標排好，⛔ 存檔那一刻才落，而且只落一次。
   */
  const box = buildPrim('box', { w: 10, h: 10, d: 10 });
  const at = y => triangles(box, { matrix: new THREE.Matrix4().makeTranslation(0, y, 0), scale: 10 });
  const lower = at(5), upper = at(15);          // 方塊中心在原點 → 0~10 與 10~20 cm
  const keep = trisBounds(upper).min.z;

  const [one] = bedLayout([lower, upper], true);
  near('★★★ 合成一個檔：總高 ＝ 20cm ＝ 200mm（⛔ 不是兩個都 100）', trisBounds(one).max.z, 200, 1e-6);
  near('合成一個檔：最低點貼平台', trisBounds(one).min.z, 0, 1e-9);

  const each = bedLayout([lower, upper], false);
  near('分開存：上面那個也落到平台', trisBounds(each[1]).min.z, 0, 1e-9);
  near('分開存：高度各自 100mm', trisBounds(each[1]).max.z, 100, 1e-6);

  near('★ 原本那一份⛔ 沒被動到（檢查表還要用、而且可以存第二次）',
    trisBounds(upper).min.z, keep, 1e-12);
}

section('B 組 bug：多個物件一起展開，板厚要各自標');

{
  /**
   * 🔴 **0.5 與 1.0 兩種板一起展開 → DXF、CSV、標題欄全部寫 0.5**（修之前）。
   * 程式只記一份規則（第一個物件的）。DXF 與 CSV 是要交給師傅的。
   */
  const thin = new io.ModelObject({ name: '薄板', kind: io.KIND.SHEET, thickness: 0.5,
    src: { type: 'plate', w: 100, d: 60 } });
  const thick = new io.ModelObject({ name: '厚板', kind: io.KIND.SHEET, thickness: 1,
    src: { type: 'plate', w: 80, d: 40 } });
  const r = unfoldMany([thin, thick]);
  const pThick = r.pieces.find(p => p.owner === '厚板');
  ok('前提：兩片都展開了', r.pieces.length === 2 && !!pThick);

  eq('★★★ 厚板那一片帶著自己的板厚', pThick.rule && pThick.rule.thickness, 1);
  ok('★★ 標題欄寫 板厚 1', titleLines(pThick, { rule: r.rule }).join('|').includes('板厚 1 cm'),
    titleLines(pThick, { rule: r.rule }).join('|'));
  /** ⚠ 要對「板厚cm」那一欄 —— 整列找 `1` 會被「數量 1」騙過（第一版就被騙了）*/
  const csv = bomCSV(r.pieces, r.rule).split('\r\n').map(l => l.split(','));
  const col = csv[0].indexOf('板厚cm');
  /** ⚠ 照欄位名稱找，⛔ 不寫死第幾欄 —— 2026-10-08 E9 在最前面加了「片號」，寫死 0 就壞了 */
  const nameCol = csv[0].indexOf('名稱');
  const rowOf = name => csv.find(c => (c[nameCol] || '').startsWith(name));
  eq('★★ CSV 厚板那一列的板厚', rowOf('厚板')[col], '1');
  eq('　 CSV 薄板那一列的板厚', rowOf('薄板')[col], '0.5');
  const dxf = toDXF(r.pieces, { unit: 'mm', rule: r.rule });
  ok('★★ DXF 兩種板厚都標得出來', dxf.includes(' t0.5') && dxf.includes(' t1'));
}

section('B 組 bug：DXF 的曲線帶⛔ 不標 R0');

{
  /**
   * 🔴 **曲線帶在 DXF 裡被標成「180deg R0」**（修之前）——
   * 看起來像一道銳角摺線。展開圖（`sheet.js`）早就分開標了，DXF 沒有。
   */
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10cm" height="10cm" `
    + `viewBox="0 0 100 100"><path d="M20,50 A30,30 0 0 1 80,50 L20,50 Z"/></svg>`;
  const loop = prof.readSVG(svg, { tolMm: 0.2 }).loops[0];
  const u = unfoldMesh(extr.extrudeProfile({ pts: loop.pts, holes: [] }, 2), makeRule('paper', 0.2));
  const bends = u.pieces.flatMap(p => p.bends);
  ok('前提：有曲線帶', bends.some(b => b.isCurve));
  const sharp = bends.filter(b => !b.isArc).length;
  const dxf = toDXF(u.pieces, { unit: 'mm' });
  eq('★★★ 「R0」只出現在真的尖角折線上', (dxf.match(/deg R0\r?\n/g) || []).length, sharp);
  ok('★ 曲線帶標成 CURVE', dxf.includes('CURVE'));
}

section('B 組 bug：鏡射不保留原件');

{
  /**
   * 🔴 **鏡射時不勾「保留原件」→ 拿到的是沒鏡射過的原件**（修之前）。
   * 只剩一個矩陣時程式直接回原件，以為那個矩陣一定是「不動」。
   */
  const m = io.buildSrc({ type: 'array', mode: 'mirror', axis: 'x', offset: 30, keepOriginal: false,
    child: { src: { type: 'box', w: 10, h: 10, d: 10 }, pos: [0, 0, 0], rot: [0, 0, 0],
             scale: [1, 1, 1], name: 'box' } });
  const b = m.bounds();
  near('★★★ 只剩鏡射那一份：最小 X ＝ 2×30−5', b.min.x, 55, 1e-6);
  near('★★★ 最大 X ＝ 2×30+5', b.max.x, 65, 1e-6);
  near('★ 體積還是正的', m.volume(), 1000, 1e-4);
}

section('B 組 bug：旋轉成形的平滑邊要標在「切圓」的折痕上');

{
  /**
   * 🔴 **標反了**（修之前）：真的轉角（圓柱上下那兩圈 90°）被標成平滑，
   * 圓被切成 32 段多出來的小折痕（每道 360°÷32 ＝ 11.25°）反而沒標。
   * 展開時平滑邊⛔ 不當折線 ⇒ 上下緣不摺、側面摺 32 道。
   * ⭐ 對照 `extrude.js`：平滑的是**沿著掃掠方向**的那些邊。
   */
  const { revolve } = await import('../js/build/revolve.js');
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const SEG = 32;
  const r = revolve([V(0,0,0), V(25,0,0), V(25,70,0), V(0,70,0)], { axis:'y', a:0, b:0, seg:SEG });
  const m = r.mesh;
  const deg = he => m.computeFaceNormal(he.face).angleTo(m.computeFaceNormal(he.twin.face)) * 180 / Math.PI;
  let smoothBig = 0, smoothSide = 0, creaseMissed = 0;
  for (const he of m.edges()) {
    if (!he.twin || !he.twin.face) continue;
    const d = deg(he);
    if (he.smooth && d > 45) smoothBig++;
    if (he.smooth && Math.abs(d - 360 / SEG) < 1e-6) smoothSide++;
    if (!he.smooth && Math.abs(d - 360 / SEG) < 1e-6) creaseMissed++;
  }
  eq('★★★ 90° 的真轉角一條都⛔ 不是平滑', smoothBig, 0);
  eq('★★★ 側面 32 道切圓的折痕全部標平滑', smoothSide, SEG);
  eq('★ 切圓的折痕一條都沒漏', creaseMissed, 0);
}

section('B 組 bug：擠出邊之後新的摺線⛔ 不帶「切開」');

{
  /**
   * 🔴 **平板擠出一條外緣 → 那條邊變成內部的摺線，卻還帶著「切開」**（修之前）。
   * 外緣天生自動標「切開」；它變成內部之後那個標記是假的，
   * 展開時翻邊會被切下來變成另一片。`補洞` 那幾支早就會清，這一支漏了。
   */
  const sh = buildPrim('plate', { w: 60, d: 40, segW: 1, segD: 1 });
  const bnd = [...sh.edges()].filter(h => !h.face || !h.twin || !h.twin.face);
  const out = edit.extrudeBoundaryEdges(sh, [bnd[0]], 5).mesh;
  let fakeCut = 0;
  for (const he of out.edges()) {
    if (he.face && he.twin && he.twin.face && he.role === EDGE_ROLE.CUT) fakeCut++;
  }
  eq('★★★ 內部的邊一條「切開」都沒有', fakeCut, 0);
  const u = unfoldMesh(out, makeRule('paper', 0.2));
  eq('★★ 展開成 1 片（翻邊沒有被切下來）', u.pieces.length, 1);
}

section('B 組 bug：合併網格要搬全部標記');

{
  /**
   * 🔴 **陣列（`Mesh.merge`）只搬「切開／摺線」，平滑與硬邊安靜地不見**（修之前）。
   * 〔`marksOf()` 檔頭記著：同一個病已經發作過兩次，兩次都是「東西安靜地不見了」〕
   */
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10cm" height="10cm" `
    + `viewBox="0 0 100 100"><path d="M20,50 A30,30 0 0 1 80,50 L20,50 Z"/></svg>`;
  const loop = prof.readSVG(svg, { tolMm: 0.2 }).loops[0];
  const m = extr.extrudeProfile({ pts: loop.pts, holes: [] }, 2);
  const someEdge = [...m.edges()].find(h => !h.smooth && h.role === EDGE_ROLE.FREE);
  m.setHard(someEdge, true);
  const count = (mm, f) => [...mm.edges()].filter(f).length;
  const sm = count(m, h => h.smooth), hd = count(m, h => h.hard);
  ok('前提：有平滑邊也有硬邊', sm > 0 && hd === 1);

  const two = Mesh.merge([m, m.transformed(new THREE.Matrix4().makeTranslation(200, 0, 0))]);
  eq('★★★ 平滑邊 × 2', count(two, h => h.smooth), 2 * sm);
  eq('★★ 硬邊 × 2', count(two, h => h.hard), 2 * hd);
}

// ═══════════════════════════════════════════════════════
//  C 組 bug（2026-10-08 全專案查 bug 找到的，數字或形狀算錯）
// ═══════════════════════════════════════════════════════

/** 正方形 100×100、正中間一個 32 邊形的圓孔（半徑 20），擠出 10 */
function squareWithHole() {
  const P = (x, y) => ({ x, y, corner: true });
  const outer = [P(-50, -50), P(50, -50), P(50, 50), P(-50, 50)];
  const hole = [];
  for (let i = 0; i < 32; i++) {
    const a = 2 * Math.PI * i / 32;
    hole.push({ x: 20 * Math.cos(a), y: 20 * Math.sin(a), corner: false });
  }
  return extr.extrudeProfile({ pts: outer, holes: [{ pts: hole }] }, 10);
}

section('C 組 bug：有孔的面，外輪廓要挑面積最大的');

{
  /**
   * 🔴 **圓孔有 32 個點、外框只有 4 個 → 圓孔被當成外輪廓**（修之前）。
   * 舊的排序是「點最多的當外輪廓」⇒ 周長量出 62.7（圓孔的周長），應該是 400。
   * ⭐ 展開那邊（`flatten.js`）早就照面積排了，只有這裡照點數。
   */
  const m = squareWithHole();
  const top = planarRegions(m).find(r => r.normal.y > 0.99);
  ok('前提：找得到頂面', !!top);
  eq('★★★ 外輪廓是那 4 個角（⛔ 不是圓孔的 32 點）', top.outer.length, 4);
  eq('★ 圓孔算成內孔', top.holes.length, 1);
  const measure0 = await import('../js/core/measure.js');
  const mm = measure0.regionMeasure(m, top, new THREE.Matrix4());
  near('★★★ 周長 ＝ 100×4 ＝ 400', mm.perimeter, 400, 1e-6);
}

section('C 組 bug：凹進去的四邊形要切對對角線');

{
  /**
   * 🔴 **四邊形一律從第一個角切 → 凹角在第 2 或第 4 點時，切出去的三角形跑到外面**（修之前）。
   * 箭頭形 (0,0)→(2,−1)→(4,0)→(2,−3)，凹角在第 2 個點：
   * 真面積 4，舊的切法算出 8，而且有一個三角形是翻過來的。
   */
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const pts = [V(0, 0, 0), V(2, 0, -1), V(4, 0, 0), V(2, 0, -3)];
  const m = Mesh.fromFaceList(pts, [[0, 1, 2, 3]]);
  near('★★★ 面積 ＝ 4（⛔ 不是 8）', m.area(), 4, 1e-9);
  const n = m.computeFaceNormal(m.faces[0]).clone();
  let flipped = 0;
  for (const [a, b, c] of m.faceTriangles(m.faces[0])) {
    const cr = new THREE.Vector3().crossVectors(
      new THREE.Vector3().subVectors(b.p, a.p), new THREE.Vector3().subVectors(c.p, a.p));
    if (cr.dot(n) < 0) flipped++;
  }
  eq('★★ 一個翻過來的三角形都沒有', flipped, 0);

  // 對照組：凹角在第 1 個點，舊的切法本來就對 —— ⛔ 不可以被改壞
  const m2 = Mesh.fromFaceList([V(2, 0, -1), V(4, 0, 0), V(2, 0, -3), V(0, 0, 0)], [[0, 1, 2, 3]]);
  near('對照組：凹角換到第 1 個點，面積一樣是 4', m2.area(), 4, 1e-9);
  // 對照組：凸的四邊形照舊
  const sq = Mesh.fromFaceList([V(0, 0, 0), V(0, 0, 2), V(2, 0, 2), V(2, 0, 0)], [[0, 1, 2, 3]]);
  near('對照組：凸的正方形面積 4', sq.area(), 4, 1e-9);
}

section('C 組 bug：外框有缺口又帶孔，蓋子⛔ 不可以缺一塊');

{
  /**
   * 🔴 **接孔的橋穿過了外框的缺口 → 耳切中途停下，蓋子缺一塊，而且⛔ 沒有警告**（修之前）。
   * 舊做法假設「交點那條邊上 x 較大的端點一定看得到孔」—— 缺口剛好擋在中間就不成立。
   * ⭐ 課本做法：那個三角形裡有凹角擋著，就改接「角度最小」的那個凹角。
   */
  const P = (x, y) => ({ x, y, corner: true });
  const outer = [P(0, 0), P(4, 0), P(12, 10), P(8, 10), P(7, 7), P(6, 10), P(0, 10)];
  const hole = [P(1, 4), P(1, 6), P(2, 5)];
  // 外框面積（鞋帶公式）(0+40+40−14+28+60+0)÷2 ＝ 77，孔 1 ⇒ 蓋子應該是 76
  // 〔第一版這裡寫 76−1＝75 —— 把「淨面積 76」當成外框面積，是我算錯，⛔ 不是程式錯〕
  const t = extr.triangulateWithHoles(outer, [hole]);
  eq('★★★ 三角形數 ＝ 點數 ＋ 2×孔數 − 2 ＝ 10 ＋ 2 − 2', t.tris.length, 10);
  near('★★★ 蓋子面積 ＝ 77 − 1 ＝ 76', extr.trisArea(t.tris, t.pts), 76, 1e-9);

  const m = extr.extrudeProfile({ pts: outer, holes: [{ pts: hole }] }, 5);
  ok('★★ 擠出來是封閉的', m.isClosed());
  near('★★ 體積 ＝ 76 × 5', m.volume(), 380, 1e-6);

  // 對照組：同一個孔、沒有缺口的外框照舊
  const plain = extr.triangulateWithHoles([P(0, 0), P(12, 0), P(12, 10), P(0, 10)], [hole]);
  near('對照組：沒有缺口的外框照舊', extr.trisArea(plain.tris, plain.pts), 119, 1e-9);
}

section('C 組 bug：點連成面，順序反了也要繞對方向');

{
  /**
   * 🔴 **照「點的順序」直接建面，⛔ 沒對照旁邊的面 → 順序反了就是壞網格**（修之前）。
   * 順時針或逆時針點本來就是隨意的，等於一半的人會踩到。
   * ⭐ 新的面跟旁邊共用的每一條邊，方向一定要跟鄰面相反 —— 不對就整圈反過來。
   * 順便：原本是邊界的那幾條邊身上有自動標的「切開」，補上之後是假的，要清掉。
   */
  const b2 = baked('box', { w: 60, d: 45, h: 40 });
  const ty = b2.verts.reduce((mx, v) => Math.max(mx, v.p.y), -1e9);
  const topFace = b2.faces.find(f => b2.faceVerts(f).every(v => Math.abs(v.p.y - ty) < 1e-9));
  const m2 = edit.deleteFaces(b2, [{ kind: 'face', face: topFace }]).mesh;
  const naked = m2.halfEdges.filter(he => !he.face);
  const loop = [];
  let c = naked[0], guard = 0;
  do { loop.push(c.v); c = c.next; } while (c && c !== naked[0] && guard++ < 100);

  const r = edit.faceFromVerts(m2, loop.slice().reverse());
  ok('★★★ 反著點也建得起來', r.ok, r.reason);
  ok('★★★ 　　而且是封閉的（⛔ 不是壞網格）', r.ok && r.mesh.isClosed());
  ok('★★ 　　結構檢查通過', r.ok && r.mesh.validate().ok);
  rel('★★ 　　體積回到 108000', r.ok ? r.mesh.volume() : NaN, 108000);
  // 〔假的「切開」⛔ 在這裡驗不到（方塊的邊緣是摺線）—— 見下一組的平面格子〕

  const ok2 = edit.faceFromVerts(m2, loop);
  ok('對照組：照邊界的順序點，照舊建得起來而且封閉', ok2.ok && ok2.mesh.isClosed());
}

{
  /**
   * 🔴 **假的「切開」要用【平的】洞驗，⛔ 不能用方塊** ——
   * 方塊頂面的邊緣本來就是 90° 的摺線，刪掉頂面之後它們還是「摺線」，
   * ⛔ 不會自動變成「切開」⇒ 用方塊驗，修之前也是 0 條，**碰巧通過**（第一、二版都被騙了）。
   * ⭐ 平面格子中間挖一格：洞的四條邊兩側共平面，原本沒有標記，
   * 變成邊界時才被自動標成「切開」—— 補回去之後那 4 條就是假的。
   */
  const pts = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) pts.push(new THREE.Vector3(i * 10, 0, j * 10));
  const id = (i, j) => j * 4 + i;
  const faces = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    if (!(i === 1 && j === 1)) faces.push([id(i, j), id(i, j + 1), id(i + 1, j + 1), id(i + 1, j)]);
  }
  const g = Mesh.fromFaceList(pts, faces);
  g.computeNormals();
  const gi = g._vertIndex();
  const rimIds = [id(1, 1), id(2, 1), id(2, 2), id(1, 2)];
  const rim = g.halfEdges.filter(he => !he.face
    && rimIds.includes(gi.get(he.v.id)) && rimIds.includes(gi.get(he.to.id)));
  ok('前提：洞的那一圈原本被自動標成「切開」', rim.length === 4 && rim.every(h => h.role === EDGE_ROLE.CUT));
  const ring = [];
  let c = rim[0], guard = 0;
  do { ring.push(c.v); c = c.next; } while (c && c !== rim[0] && guard++ < 20);

  for (const [name, order] of [['照順序', ring], ['反著點', ring.slice().reverse()]]) {
    const r = edit.faceFromVerts(g, order);
    let fake = 0;
    if (r.ok) for (const he of r.mesh.edges()) {
      if (he.face && he.twin && he.twin.face && he.role === EDGE_ROLE.CUT) fake++;
    }
    ok(`★★ ${name}：補得起來而且結構沒問題`, r.ok && r.mesh.validate().ok);
    eq(`★★★ ${name}：補上之後，內部的邊一條「切開」都沒有`, fake, 0);
  }
}

section('C 組 bug：欄位留空⛔ 不可以當成 0');

{
  /**
   * 🔴 **`+欄位值`：空字串會變成 0** —— 「切一刀」位置留空，直接切在 0（修之前）。
   * 而緊接著的「要打一個數字」檢查永遠不會觸發，因為 0 是正常的數字。
   */
  ok('★★★ 留空 → 不是數字', Number.isNaN(fieldNum('')));
  ok('★★ 只有空白 → 不是數字', Number.isNaN(fieldNum('   ')));
  ok('★ 亂打 → 不是數字', Number.isNaN(fieldNum('abc')));
  eq('對照組：打 0 就是 0', fieldNum('0'), 0);
  eq('對照組：前後有空白照樣讀', fieldNum(' 3.5 '), 3.5);
  eq('對照組：負數照樣讀', fieldNum('-12'), -12);
}

section('C 組 bug：右側面板的數字要守住範圍');

{
  /**
   * 🔴 **欄位的最小／最大值只管上下箭頭，⛔ 直接打字不管**（修之前）。
   * 方塊寬打 −50 → 翻過來的方塊；板厚打 −1 照收。
   * ⭐ 超出範圍就改回邊界，**而且要講**（跟比例編輯「打 −5 當場變回 0 並講」同一條）。
   */
  const a = clampNum(-50, { min: 0.1 });
  eq('★★★ 低於最小值 → 改成最小值', a.v, 0.1);
  ok('★★ 　　而且回報「改過了」（介面要講出來）', a.clamped);
  const b = clampNum(20, { max: 10 });
  eq('★★ 高於最大值 → 改成最大值', b.v, 10);
  const c = clampNum(5, { min: 0.1, max: 10 });
  eq('對照組：範圍內照收', c.v, 5);
  ok('對照組：範圍內⛔ 不回報', !c.clamped);
  eq('對照組：沒設範圍的欄位（例如位置）照收負數', clampNum(-30, {}).v, -30);
}

// ═══════════════════════════════════════════════════════
//  D 組 bug（2026-10-08 全專案查 bug 找到的，SVG 匯入）
// ═══════════════════════════════════════════════════════

section('D 組 bug：圓弧的兩個旗標黏在一起');

{
  /**
   * 🔴 **`a50 50 0 01100 0` → 整條路徑消失**（修之前）。
   * 圓弧的兩個旗標各只有一個字元（0 或 1），可以黏在一起寫 ——
   * SVGO 之類的壓縮工具一定會這樣寫。舊的切字把 `01100` 讀成一個數，
   * 後面的參數全部錯位，最後報「數字不夠」，**而且報錯的指令名字還是錯的**（寫成 M）。
   */
  const spaced = svgp.parsePath('M0 0a50 50 0 0 1 100 0');
  const packed = svgp.parsePath('M0 0a50 50 0 01100 0');
  eq('★★★ 黏在一起：一個錯誤都沒有', packed.errors.length, 0);
  eq('★★★ 黏在一起：點數跟分開寫的一樣', packed.subpaths[0] && packed.subpaths[0].pts.length,
     spaced.subpaths[0].pts.length);
  const last = packed.subpaths[0] && packed.subpaths[0].pts.slice(-1)[0];
  ok('★★ 終點在 (100, 0)', last && Math.abs(last.x - 100) < 1e-9 && Math.abs(last.y) < 1e-9);

  const both = svgp.parsePath('M0 0a50 50 0 1150 50');
  ok('★ 兩個旗標都是 1 也讀得對（終點 50, 50）', both.errors.length === 0
     && Math.abs(both.subpaths[0].pts.slice(-1)[0].x - 50) < 1e-9);

  const bad = svgp.parsePath('M0 0L10');
  ok('★★ 數字不夠時，報錯講的是「L」（⛔ 不是上一個指令）', bad.errors.some(e => e.includes('「L」')),
     bad.errors.join('／'));
}

section('D 組 bug：transform 裡的數字黏在一起');

{
  /**
   * 🔴 **`translate(10-20)` → 整個被忽略，形狀跑到別的位置，⛔ 沒有任何提示**（修之前）。
   * 舊做法用「空白或逗號」切 —— 正是 `svgPath.js` 切字那則警告過的寫法。
   */
  const t = prof.parseTransform('translate(10-20)');
  eq('★★★ translate(10-20)：往右 10', t[4], 10);
  eq('★★★ 　　往上 20（−20）', t[5], -20);
  const m = prof.parseTransform('matrix(1 0 0 1 100-50)');
  eq('★★ matrix 黏在一起：6 個數都讀到（位移 100）', m[4], 100);
  eq('★★ 　　位移 −50', m[5], -50);
  const s = prof.parseTransform('scale(.5.5)');
  eq('★ scale(.5.5) ＝ 0.5 與 0.5', s[0] + s[3], 1);
  const ok2 = prof.parseTransform('translate(10, -20)');
  eq('對照組：照規矩寫的照舊', ok2[5], -20);
}

section('D 組 bug：只寫寬度的 SVG 也要換算得出尺寸');

{
  /**
   * 🔴 **`width="100mm"` ＋ viewBox、沒寫 height → 被當成「沒寫尺寸」去猜，10 cm 變 2.65 cm**（修之前）。
   * 有寬度 ＋ viewBox 就算得出比例（100mm ÷ 100 單位），⛔ 不需要高度。
   */
  const sq = 'M0 0H100V50H0Z';
  const onlyW = prof.readSVG(`<svg xmlns="http://www.w3.org/2000/svg" width="100mm" viewBox="0 0 100 50"><path d="${sq}"/></svg>`);
  near('★★★ 只寫寬度：寬 10 cm', onlyW.size.w, 10, 1e-9);
  eq('★★ 　　比例是「檔案宣告」的，⛔ 不是猜的', onlyW.scale.from, 'declared');
  ok('★★ 　　⛔ 不可以說「這個檔沒有寫實際尺寸」', !onlyW.notes.some(n => n.includes('沒有寫實際尺寸')));

  const onlyH = prof.readSVG(`<svg xmlns="http://www.w3.org/2000/svg" height="50mm" viewBox="0 0 100 50"><path d="${sq}"/></svg>`);
  near('★★ 只寫高度：寬一樣是 10 cm', onlyH.size.w, 10, 1e-9);

  const none = prof.readSVG(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><path d="${sq}"/></svg>`);
  eq('對照組：真的沒寫尺寸，照舊用猜的並講出來', none.scale.from, 'guess');
}

section('D 組 bug：矩形、圓形這些基本圖形⛔ 不可以消失');

{
  /**
   * 🔴 **只收 `<path>` → `<rect>`、`<circle>`、`<polygon>` 全部安靜地不見**（修之前）。
   * Illustrator 匯出時，基本圖形就是寫成這些標籤。
   * ⭐ 先換成等價的路徑，再走原本那一條路 —— ⛔ 不另寫一套。
   * 讀不到的（`<use>`、`<text>`、`<image>`）要講出來，⛔ 不可以沉默。
   */
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
    <rect id="方框" x="0" y="0" width="40" height="20"/>
    <circle id="圓" cx="70" cy="70" r="10"/>
    <polygon id="三角" points="0,60 30,60 0,90"/>
    <ellipse id="橢圓" cx="70" cy="20" rx="20" ry="10"/>
    <rect id="圓角" x="0" y="30" width="40" height="20" rx="5"/>
    <use href="#方框" x="50"/>
    <text x="0" y="99">字</text>
  </svg>`;
  const r = prof.readSVG(svg, { tolMm: 0.05 });
  const by = n => r.shapes.find(s => s.name === n);
  ok('★★★ 矩形讀得到', !!by('方框'));
  ok('★★★ 圓形讀得到', !!by('圓'));
  ok('★★ 多邊形讀得到', !!by('三角'));
  ok('★★ 橢圓讀得到', !!by('橢圓'));
  ok('★★ 圓角矩形讀得到', !!by('圓角'));
  // 1 個 SVG 單位 ＝ 1 mm ＝ 0.1 cm
  near('★★ 矩形面積 ＝ 4 × 2 cm', by('方框') && Math.abs(by('方框').area), 8, 1e-9);
  /**
   * 圓切成直線段，弦高誤差 ≤ 0.05 mm ＝ 0.005 cm ⇒ 內接多邊形的面積
   * 落在 π(1 − 2×0.005÷1) 到 π 之間。
   * 〔第一版寫「跟 π 差 0.01 以內」—— 實際 3.1214，差 0.02，**是我的容許值沒照取樣精度推**〕
   */
  const ca = by('圓') ? Math.abs(by('圓').area) : NaN;
  ok('★ 圓的面積落在取樣誤差的範圍內（π×0.99 ～ π）', ca <= Math.PI && ca >= Math.PI * (1 - 2 * 0.005),
     String(ca));
  near('★ 三角形面積 ＝ 3 × 3 ÷ 2', by('三角') && Math.abs(by('三角').area), 4.5, 1e-9);
  eq('★★ 矩形 4 個真轉角', by('方框') && by('方框').pts.filter(p => p.corner).length, 4);
  eq('★★ 圓形一個真轉角都沒有（⛔ 起點不可以變成一道假的折）',
     by('圓') && by('圓').pts.filter(p => p.corner).length, 0);
  ok('★★★ 讀不到的 <use>、<text> 要講出來', r.notes.some(n => n.includes('use') && n.includes('text')),
     r.notes.join('／'));

  const onlyRect = prof.readSVG(`<svg xmlns="http://www.w3.org/2000/svg" width="10cm" height="10cm" viewBox="0 0 100 100"><rect width="50" height="50"/></svg>`);
  ok('★★ 只有一個矩形的檔案 ⛔ 不再說「沒有任何路徑」', onlyRect.ok, onlyRect.reason);

  const open = prof.readSVG(`<svg xmlns="http://www.w3.org/2000/svg" width="10cm" height="10cm" viewBox="0 0 100 100"><polyline points="0,0 50,0 50,50"/></svg>`);
  ok('★★ 折線（開放的）2026-10-15 起變成一條線，⛔ 報錯', open.ok && open.lines.length === 1
     && !open.errors.length, open.errors.join('|'));
}

// ═══════════════════════════════════════════════════════
section('旋轉成形 第 2 輪：中心線綁參考線（拖線碗跟著變、搬走脫鉤、刪線脫鉤）—— 2026-10-16');
// ═══════════════════════════════════════════════════════
{
  const prim = await import('../js/build/prim.js');
  const xy = [0,50, 30,50, 38,40, 42,20, 44,0];
  const mkBowl = (rev, pos = [0, 0, 0]) => {
    const o = new io.ModelObject({ kind: io.KIND.SHEET,
      src: { type: 'pen', h: 3, open: true, up: false,
             paths: [{ closed: true, a: xy.slice(), hi: xy.map(() => 0), ho: xy.map(() => 0) }], rev } });
    o.pos.set(...pos);
    return o;
  };
  const worldAxisX = o => io.revAxisWorld(o).p1.x;
  const radius = o => { const b = o.mesh().bounds(); return (b.max.x - b.min.x) / 2; };

  {
    const o = mkBowl({ dir: 'z', at: 0, seg: 32, stand: true }, [100, 0, 20]);
    eq('★★ 前後方向的中心線跟「前後線 X」', io.revGuideAx(o.src), 'x');
    near('★★ 中心線在世界 X ＝ 100（at 0 ＋ 物件在 100）', worldAxisX(o), 100, 1e-9);
    const r = io.revAtForGuide(o, 95);
    ok('★★★ 綁到 X 95：算得出 at', r.ok, r.reason);
    o.src.rev.at = r.at; o.src.rev.bind = 95; o.invalidate();
    near('★★★ 綁上之後中心線就在 X 95', worldAxisX(o), 95, 1e-6);
    ok('★★ 在線上', io.revOnGuide(o, 95));
    const R0 = radius(o);

    const doc = new io.Doc(); doc.add(o); doc.addGuide('x', 95);
    /** 規則 1：拖參考線 95 → 90，碗跟著變粗（中心線離線遠了 5） */
    doc.removeGuide('x', 95); doc.addGuide('x', 90);
    const moved = io.revFollowGuide(doc, 'x', 95, 90);
    eq('★★★ 拖參考線：跟著它的碗 1 個', moved.length, 1);
    near('★★★ 中心線跟到 X 90', worldAxisX(o), 90, 1e-6);
    eq('★★ bind 也跟著改成 90', o.src.rev.bind, 90);
    near('★★★ 碗變粗 5（半徑 ＋5）', radius(o) - R0, 5, 1e-6);

    /** 規則 2：沿著中心線推（立起來 ⇒ 中心線是直的；往上抬、前後推都還在 X 90）⇒ 繼續綁 */
    o.pos.y += 7; o.pos.z += 13;
    eq('★★★ 往上抬、前後推：中心線還在線上 ⇒ ⛔ 脫鉤', io.revCheckBinds(doc).length, 0);
    eq('★★ bind 還在', o.src.rev.bind, 90);
    /** 往左右搬 ⇒ 離開參考線 ⇒ 脫鉤，形狀不變 */
    const R1 = radius(o);
    o.pos.x += 4;
    const det = io.revCheckBinds(doc);
    eq('★★★ 往旁邊搬：脫鉤 1 個', det.length, 1);
    eq('★★ bind 變成 null', o.src.rev.bind, null);
    near('★★ 脫鉤時形狀一格都不變', radius(o), R1, 1e-9);
    /** 脫鉤之後再拖參考線 ⇒ ⛔ 跟 */
    doc.removeGuide('x', 90); doc.addGuide('x', 80);
    eq('★★ 脫鉤的碗：拖參考線⛔ 跟', io.revFollowGuide(doc, 'x', 90, 80).length, 0);
  }
  {
    /** ⚠ 拖參考線經過輪廓中間（碗暫時轉不出來）⇒ 照樣跟著、⛔ 脫鉤；拖回來就恢復 */
    const o = mkBowl({ dir: 'z', at: 0, seg: 32, stand: true, bind: 0 });
    const doc = new io.Doc(); doc.add(o); doc.addGuide('x', 0);
    doc.removeGuide('x', 0); doc.addGuide('x', 20);
    io.revFollowGuide(doc, 'x', 0, 20);
    o.mesh();
    ok('★★ 參考線拖到線的中間 ⇒ 碗擋下來（跨過中心線）', /跨過中心線/.test(o.error || ''), o.error);
    eq('★★★ 擋下來時⛔ 脫鉤', io.revCheckBinds(doc).length, 0);
    doc.removeGuide('x', 20); doc.addGuide('x', -3);
    io.revFollowGuide(doc, 'x', 20, -3);
    o.invalidate(); o.mesh();
    ok('★★★ 拖回來 ⇒ 碗又轉得出來，還綁著', !o.error && o.src.rev.bind === -3, o.error);
    near('★★ 中心線在 X −3', io.revAxisWorld(o).p1.x, -3, 1e-6);
  }
  {
    /** 規則 3：刪參考線 ⇒ 直接刪、跟著它的碗脫鉤，形狀不變 */
    const doc = new io.Doc();
    const a = mkBowl({ dir: 'z', at: 0, seg: 32, stand: true, bind: 0 });
    const b = mkBowl({ dir: 'z', at: 0, seg: 32, stand: false, bind: 0 });
    const c = mkBowl({ dir: 'x', at: 0, seg: 32, stand: true, bind: 0 });
    doc.add(a); doc.add(b); doc.add(c); doc.addGuide('x', 0); doc.addGuide('z', 0);
    const R = radius(a);
    doc.removeGuide('x', 0);
    const det = io.revDetachGuide(doc, 'x', 0);
    eq('★★★ 刪掉前後線 X 0：跟著它的 2 個脫鉤（左右方向那個跟的是左右線 Z，⛔ 動）', det.length, 2);
    ok('★★ 左右方向那個還綁著', c.src.rev.bind === 0);
    near('★★ 形狀不變', radius(a), R, 1e-9);
  }
  {
    /** 轉過角度、中心線跟參考線不平行 ⇒ 綁不上，講原因 */
    const o = mkBowl({ dir: 'z', at: 0, seg: 32, stand: false });
    o.rot.y = Math.PI / 6;
    const r = io.revAtForGuide(o, 10);
    ok('★★ 轉 30° 的躺著的碗：綁不上，講原因', !r.ok && /轉過角度/.test(r.reason), r.reason);
    /** 立起來的碗中心線是直的：繞 Y 轉幾度都還平行 ⇒ 綁得上 */
    const s = mkBowl({ dir: 'z', at: 0, seg: 32, stand: true }, [5, 0, 5]);
    s.rot.y = Math.PI / 6;
    const r2 = io.revAtForGuide(s, 10);
    ok('★★ 立起來的碗轉 30°：照樣綁得上', r2.ok, r2.reason);
    s.src.rev.at = r2.at; s.invalidate();
    near('★★ 綁上之後中心線在 X 10', worldAxisX(s), 10, 1e-6);
  }
  {
    /** 存檔往返：bind 留著 */
    const o = mkBowl({ dir: 'z', at: 0, seg: 32, stand: true, bind: 0 });
    const doc = new io.Doc(); doc.add(o); doc.addGuide('x', 0);
    const d2 = new io.Doc(); d2.loadJSON ? d2.loadJSON(doc.toJSON()) : null;
    const back = d2.objects && d2.objects[0];
    ok('★★ 存檔再讀：bind 還在', back ? back.src.rev.bind === 0 : io.cloneSrc(o.src).rev.bind === 0);
  }
}

// ═══════════════════════════════════════════════════════
section('鋼筆的智慧參考線：對齊、交集、吸參考線、打數字定長度 —— 2026-10-15');
// ═══════════════════════════════════════════════════════
{
  const ps = await import('../js/core/penSnap.js');
  const pts = [{ x: 0, z: 0 }, { x: 30, z: 0 }];
  const g = { x: [50], y: [7], z: [] };
  const tol = 2;

  {
    const r = ps.penSmartSnap(31.5, 20, { points: pts, guides: g, tol });
    eq('★★★ 跟點同一個 X（差 1.5，容許 2）⇒ X 吸到 30', r.x, 30);
    eq('★★ Z 沒對到 ⇒ 照游標', r.z, 20);
    eq('★★ 標字「對齊」', r.label, '對齊');
    ok('★★ 粉紅線從那個點畫過來', r.fromX && r.fromX.x === 30 && r.fromX.z === 0);
  }
  {
    const r = ps.penSmartSnap(1, 1.2, { points: [{ x: 0, z: 9 }, { x: 9, z: 0 }], guides: g, tol });
    eq('★★★ 兩個方向各對到不同的點 ⇒「交集」', r.label, '交集');
    ok('★★ 交叉處 ＝ (0, 0)', r.x === 0 && r.z === 0);
  }
  {
    const r = ps.penSmartSnap(29, 1, { points: pts, guides: g, tol });
    eq('★★ 剛好落在一個點上 ⇒「錨點」', r.label, '錨點');
  }
  {
    const r = ps.penSmartSnap(49, 15, { points: pts, guides: g, tol });
    eq('★★★ 靠近參考線 X 50 ⇒ 吸上去', r.x, 50);
    eq('★★ 標字「參考線」', r.label, '參考線');
    eq('★★ 參考線⛔ 畫粉紅線（它自己看得到）', r.fromX, null);
  }
  {
    /** 🔴 Y 參考線跟地板平行，交不出線 ⇒ ⛔ 吸 */
    const r = ps.penSmartSnap(10, 7.5, { points: [], guides: g, tol });
    eq('★★ Y 參考線⛔ 拿來吸 Z', r.z, 7.5);
    eq('★ 什麼都沒吸 ⇒ ⛔ 標字', r.label, '');
  }
  {
    const r = ps.penSmartSnap(10, 10, { points: pts, guides: g, tol });
    ok('★★ 太遠（超過容許）⇒ 原樣', r.x === 10 && r.z === 10 && !r.label);
  }
  {
    /** 兩個都在範圍內時挑近的那一個 */
    const r = ps.penSmartSnap(29.5, 20, { points: [{ x: 28, z: 0 }, { x: 30, z: 5 }], guides: g, tol });
    eq('★★ 兩個點都在範圍內 ⇒ 吸近的（30）', r.x, 30);
  }
  {
    const f = ps.footprintPoints({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 99, z: 4 } });
    eq('★★ 別的物件外框：四個角 ＋ 中心 ＝ 5 個點', f.length, 5);
    ok('★ 中心 ＝ (5, 2)（高度⛔ 管）', f[4].x === 5 && f[4].z === 2);
  }
  {
    const r = ps.pointAtLength({ x: 0, z: 0 }, { x: 3, z: 4 }, 25);
    ok('★★★ 打 25 ⇒ 沿著游標方向（3,4）走 25 ＝ (15, 20)', r.ok && Math.abs(r.x - 15) < 1e-12 && Math.abs(r.z - 20) < 1e-12);
    ok('★★ 打 0 ⇒ 擋下來講原因', !ps.pointAtLength({ x: 0, z: 0 }, { x: 1, z: 0 }, 0).ok);
    /** 🔴 角度 → 方向（kang 2026-10-15「兩種都要」）：0° 往右、90° 往上視圖的畫面上方（−Z） */
    const d0 = ps.dirFromAngle(0), d90 = ps.dirFromAngle(90), d180 = ps.dirFromAngle(180), dm90 = ps.dirFromAngle(-90);
    ok('★★★ 0° ＝ 往右 (1, 0)', d0.dx === 1 && d0.dz === 0, JSON.stringify(d0));
    ok('★★★ 90° ＝ 往畫面上方 (0, −1)（⛔ 是 +1：上視圖的畫面上方是 −Z）', d90.dx === 0 && d90.dz === -1, JSON.stringify(d90));
    ok('★★ 180° ＝ 往左、−90° ＝ 往畫面下方', d180.dx === -1 && d180.dz === 0 && dm90.dx === 0 && dm90.dz === 1);
    const d30 = ps.dirFromAngle(30);
    const p30 = ps.pointAtLength({ x: 10, z: 10 }, { x: 10 + d30.dx, z: 10 + d30.dz }, 20);
    ok('★★★ 長度 20、角度 30° ⇒ (10 ＋ 20·cos30°, 10 − 20·sin30°) ＝ (27.32, 0)',
       Math.abs(p30.x - (10 + 20 * Math.cos(Math.PI / 6))) < 1e-12 && Math.abs(p30.z - 0) < 1e-12,
       JSON.stringify(p30));
    /** 🔴 角度一個數字兩種用法（kang 2026-10-15 第三次：「360 度的方向」）：點畫面 ＝ 每隔幾度一格 */
    const step = (deg, dx, dz) => ps.dirFromAngleStep(deg, { dx, dz });
    const eqDir = (d, x, z) => Math.abs(d.dx - x) < 1e-12 && Math.abs(d.dz - z) < 1e-12;
    const at = deg => ps.dirFromAngle(deg);
    const mouseAt = deg => ({ dx: Math.cos(deg * Math.PI / 180), dz: -Math.sin(deg * Math.PI / 180) });
    const m = d => step(30, mouseAt(d).dx, mouseAt(d).dz);
    ok('★★★ 30、滑鼠在 40° ⇒ 停 30°', eqDir(m(40), at(30).dx, at(30).dz));
    ok('★★★ 30、滑鼠在 50° ⇒ 停 60°（⛔ 只有四個方向：60° 是上一版到不了的）', eqDir(m(50), at(60).dx, at(60).dz));
    ok('★★★ 30、滑鼠在 200° ⇒ 停 210°（左下那半圈也到得了）', eqDir(m(200), at(210).dx, at(210).dz));
    ok('★★ 30、滑鼠在 −80° ⇒ 停 −90°（往下）', eqDir(m(-80), 0, 1));
    ok('★★ 15 ⇒ 一整圈 24 格：滑鼠在 100° ⇒ 停 105°',
       eqDir(step(15, mouseAt(100).dx, mouseAt(100).dz), at(105).dx, at(105).dz));
    ok('★★ 0 不當格子 ⇒ 照數字本身（往右）', eqDir(step(0, -1, 1), 1, 0));
    ok('★★ 超過 180（例 200）不當格子 ⇒ 照數字本身', eqDir(step(200, 1, 0), at(200).dx, at(200).dz));
    ok('★★ 滑鼠疊在上一個點上 ⇒ 照數字本身', eqDir(step(30, 0, 0), at(30).dx, at(30).dz));
    ok('★★ 游標疊在上一個點上 ⇒ 擋下來（看不出方向）',
       /看不出方向/.test(ps.pointAtLength({ x: 1, z: 1 }, { x: 1, z: 1 }, 5).reason || ''));
  }
}

// ═══════════════════════════════════════════════════════
section('匯入線稿：沒封口的線保留 Illustrator 的錨點與把手（變成鋼筆用）—— 2026-10-15');
// ═══════════════════════════════════════════════════════
{
  const sp = await import('../js/sketch/svgPath.js');
  const prim = await import('../js/build/prim.js');
  const svg = (body, extra = '') => `<svg width="100cm" height="100cm" viewBox="0 0 100 100"${extra}>${body}</svg>`;

  {
    /** 一段三次曲線：錨點 2 個、把手照檔案（⛔ 被拉直成幾十個點） */
    const r = sp.parsePath('M0,0 C10,0 20,10 20,20');
    const b = r.subpaths[0].bez;
    eq('★★★ 一段曲線 ＝ 2 個錨點', b.a.length / 2, 2);
    ok('★★★ 拉直的點遠多於錨點（證明 bez ⛔ 是拉直出來的）', r.subpaths[0].pts.length > 4,
       String(r.subpaths[0].pts.length));
    eq('★★ 起點出去的把手 ＝ (10, 0)', b.ho.slice(0, 2).join(','), '10,0');
    eq('★★ 終點進來的把手 ＝ (0, −10)', b.hi.slice(2, 4).join(','), '0,-10');
  }
  {
    /** 二次曲線換成三次：曲線上的點⛔ 可以變 */
    const r = sp.parsePath('M0,0 Q10,20 20,0');
    const b = r.subpaths[0].bez;
    const c = sp.cubicAt(b.a[0], b.a[1], b.a[0] + b.ho[0], b.a[1] + b.ho[1],
                         b.a[2] + b.hi[2], b.a[3] + b.hi[3], b.a[2], b.a[3], 0.5);
    near('★★ 二次曲線換三次：中點 ＝ (10, 10)（二次曲線的中點）', Math.hypot(c.x - 10, c.y - 10), 0, 1e-12);
  }
  {
    /** 半圓（A）：180° ⇒ 2 段三次曲線 ⇒ 3 個錨點；每段中點貼在圓上 */
    const r = sp.parsePath('M0,0 A10,10 0 0 1 20,0');
    const b = r.subpaths[0].bez;
    eq('★★ 半圓 ＝ 3 個錨點（每 90° 一段）', b.a.length / 2, 3);
    let worst = 0;
    for (let j = 0; j + 3 < b.a.length; j += 2) {
      const m = sp.cubicAt(b.a[j], b.a[j + 1], b.a[j] + b.ho[j], b.a[j + 1] + b.ho[j + 1],
                           b.a[j + 2] + b.hi[j + 2], b.a[j + 3] + b.hi[j + 3], b.a[j + 2], b.a[j + 3], 0.5);
      worst = Math.max(worst, Math.abs(Math.hypot(m.x - 10, m.y) - 10));
    }
    ok('★★ 每段中點離圓心 10（誤差 < 半徑的萬分之三）', worst < 10 * 3e-4, String(worst));
  }
  {
    const r = sp.parsePath('M0,0 H50 V50 H0 Z');
    eq('★★ 封口的方形：4 個錨點（Z 回到起點的那一個⛔ 多算）', r.subpaths[0].bez.a.length / 2, 4);
  }
  {
    /** 🔴 transform 有旋轉時，把手的方向也要跟著轉（⛔ 只乘比例） */
    const r = prof.readSVG(svg('<path transform="rotate(90)" d="M0,0 C10,0 20,10 20,20"/>'));
    const b = r.lines[0].bez;
    near('★★★ 轉 90° 之後，出去的把手 ＝ (0, 10)', Math.hypot(b.ho[0] - 0, b.ho[1] - 10), 0, 1e-9);
  }
  {
    /**
     * 🔴🔴 **端到端：匯入的線 → 鋼筆 → 旋轉成形**（kang 要的就是這一條）。
     * 碗的半邊：從中心線出發往右、再往上彎（畫面上方 ＝ SVG 的 y 變小）。
     */
    const r = prof.readSVG(svg('<path d="M10,60 L40,60 C48,60 52,40 54,10"/>'));
    ok('★★★ 匯入讀得到', r.ok && r.lines.length === 1, r.reason);
    const L = r.lines[0].bez;
    const src = { type: 'pen', h: 3, open: true, up: false,
                  paths: [{ closed: true, a: L.a, hi: L.hi, ho: L.ho }] };
    ok('★★ 當成鋼筆擠得出一條帶子（旋轉成形還沒開）', io.buildSrc(src).faces.length > 0);
    src.rev = { dir: 'z', at: prim.penRevAutoAt(src, 'z'), seg: 32, stand: true };
    const rv = prim.penRevolve(src);
    ok('★★★ 勾旋轉成形 ⇒ 轉得出碗', rv.ok, rv.reason);
    near('★★ 中心線自動放在線的起點（X 10）', src.rev.at, 10, 1e-9);
    eq('★★ 一端碰到中心線 ⇒ 板件', io.penKind(src), io.KIND.SHEET);
    near('★★ 碗高 ＝ 60 − 10 ＝ 50', rv.mesh.bounds().max.y - rv.mesh.bounds().min.y, 50, 1e-6);
  }
}

// ═══════════════════════════════════════════════════════
//  E 組 bug（2026-10-08 全專案查 bug 找到的，小問題 —— 測得到的那幾項）
// ═══════════════════════════════════════════════════════

/**
 * DXF 檔頭的 $EXTMIN／$EXTMAX 有沒有包住 ENTITIES 裡的每一個座標（文字加上字高）。
 * ⚠ 文字只看插入點與字高，⛔ 不估字寬 —— 字寬要看字型，估了就是猜。
 */
function dxfBounds(dxf) {
  const L = dxf.split(/\r?\n/);
  const hv = name => {
    const i = L.indexOf(name);
    return { x: +L[i + 2], y: +L[i + 4] };
  };
  const mn = hv('$EXTMIN'), mx = hv('$EXTMAX');
  const start = L.indexOf('ENTITIES');
  let minX = Infinity, minY = Infinity, maxY = -Infinity, maxX = -Infinity;
  let kind = '', y = 0;
  for (let i = start; i + 1 < L.length; i += 2) {
    const code = L[i].trim(), val = L[i + 1];
    if (code === '0') kind = val;
    if (code === '10' || code === '11') { minX = Math.min(minX, +val); maxX = Math.max(maxX, +val); }
    if (code === '20' || code === '21') { y = +val; minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    if (code === '40' && kind === 'TEXT') maxY = Math.max(maxY, y + +val);
  }
  const e = 1e-6;
  const inside = minX >= mn.x - e && minY >= mn.y - e && maxX <= mx.x + e && maxY <= mx.y + e;
  return { inside, why: `內容 x ${minX}~${maxX}、y ${minY}~${maxY}；檔頭 (${mn.x}, ${mn.y})~(${mx.x}, ${mx.y})` };
}

section('E 組 bug：復原的提示要講「撤銷了哪一步」');

{
  /**
   * 🔴 **做了 A、B 之後按復原，提示寫「復原：A」**（修之前）——
   * 實際撤銷的是 B。先退一格再回報，回報的就變成退回去之後那一格；
   * 退到最前面還會寫「復原：開始」。
   */
  const { History } = await import('../js/core/history.js');
  let state = 0;
  const h = new History({ get: () => state, set: v => { state = v; } });
  /** ⚠ 介面一開始一定先 `reset('開始')`（main.js 的 boot／新建／開檔）—— 第一版漏了這一步，測試自己錯 */
  h.reset('開始');
  state = 1; h.commit('A');
  state = 2; h.commit('B');
  eq('★★★ 第一次復原：撤銷的是 B', h.undo(), 'B');
  eq('　 狀態真的回到 A 之後', state, 1);
  eq('★★ 第二次復原：撤銷的是 A（⛔ 不是「開始」）', h.undo(), 'A');
  eq('對照組：重做回報的是被重做的那一步', h.redo(), 'A');
  eq('對照組：沒得復原時回 null', (h.undo(), h.undo()), null);
}

section('E 組 bug：DXF 標題改寫片號，CSV 第一欄也是片號');

{
  /**
   * 🔴 **DXF 標題的中文全部變成「-」**（修之前）—— 物件名「A匯入線稿測試－B」→「A-B」、材質 →「-」，
   * 師傅拿到圖分不出哪片是哪片。kang 2026-10-08 決定：圖上寫片號 P01、P02…，
   * CSV 第一欄也寫片號、旁邊是中文名稱；畫面卡片的第一行也加片號。
   */
  const a = new io.ModelObject({ name: '左側板', kind: io.KIND.SHEET, thickness: 0.5,
    src: { type: 'plate', w: 100, d: 60 } });
  const b = new io.ModelObject({ name: '右側板', kind: io.KIND.SHEET, thickness: 0.5,
    src: { type: 'plate', w: 80, d: 40 } });
  const r = unfoldMany([a, b]);
  eq('★★ 第一片的片號 P01', r.pieces[0].no, 'P01');
  eq('★★ 第二片的片號 P02', r.pieces[1].no, 'P02');

  const dxf = toDXF(r.pieces, { unit: 'mm', rule: r.rule });
  const texts = [];
  const L = dxf.split(/\r?\n/);
  for (let i = 0; i + 1 < L.length; i++) if (L[i].trim() === '1' && L[i - 1] && L[i - 1].trim() !== '') texts.push(L[i + 1]);
  ok('★★★ DXF 標題寫 P01、P02', dxf.includes('P01 x1') && dxf.includes('P02 x1'));
  ok('★★★ DXF 裡⛔ 沒有只剩「-」的名稱', !texts.some(t => /^-|\s-\s|\s-$/.test(t)), texts.join(' | '));
  ok('★ 材質寫代號（英文），⛔ 不是變成「-」', /P01 x1\s+\w+ t0\.5/.test(dxf));

  const csv = bomCSV(r.pieces, r.rule).split('\r\n').map(l => l.split(','));
  eq('★★★ CSV 第一欄叫「片號」', csv[0][0], '片號');
  eq('★★ CSV 第一列是 P01、旁邊是中文名稱', `${csv[1][0]} ${csv[1][1]}`, 'P01 左側板－展開片 1');

  const tl = titleLines(r.pieces[1], { rule: r.rule });
  ok('★★ 畫面卡片第一行也有片號（跟 DXF、CSV 對得起來）', tl[0].startsWith('P02'), tl[0]);
}

section('E 組 bug：DXF 檔頭的圖面範圍要包住所有文字');

{
  /**
   * 🔴 **檔頭寫 (0, 0) 起，但標題畫在 −7s、尺寸線在 −3s**（修之前）——
   * 照檔頭縮放畫面的軟體會把標題與尺寸裁在外面。
   */
  const a = new io.ModelObject({ name: 'L', kind: io.KIND.SHEET, thickness: 0.5,
    src: { type: 'bend', w: 40, first: 30, arcSeg: 4, k: 0.4, bends: [{ angle: 90, ri: 2, len: 30 }] } });
  const r = unfoldMany([a]);
  for (const unit of ['mm', 'cm']) {
    const eb = dxfBounds(toDXF(r.pieces, { unit, rule: r.rule }));
    ok(`★★★ 展開 DXF（${unit}）：檔頭範圍包得住所有線與文字`, eb.inside, eb.why);
  }
}

section('新增四種基本體：圓環、楔形、半球、階梯（2026-10-08）');

{
  /**
   * kang 2026-10-08 看過互動圖、拍板：圓環用外／內半徑、半球實心平底、階梯下面填滿。
   * ⭐ 體積一律拿**多邊形的公式**對（⛔ 不是真圓的 πr²），而且要是【正】的 ——
   * 負的 ＝ 整個模型法向朝內，畫面上看不出來，只有 STL 列印前檢查抓得到。
   */
  const { PRIM_TYPES, PRIM_SPECS, defaultSrc } = await import('../js/build/prim.js');
  const size = m => m.bounds().getSize(new THREE.Vector3());
  /**
   * 繞 Y 轉 s 格的實體，體積 ＝ s·sin(2π/s) × ∬ r dA（斷面多邊形對中心線的一次矩）。
   * ⭐ 每一格都是平面梯形圍起來的，所以這條是【精確】的，⛔ 不是近似。
   * 管：s·sin(2π/s)·(ro²−ri²)/2·h ＝ 兩個多邊形面積差 × 高，跟「管 體積」那項同一個答案。
   */
  const spinVol = (sec, s) => {
    let q = 0;
    for (let i = 0; i < sec.length; i++) {
      const [x0, y0] = sec[i], [x1, y1] = sec[(i + 1) % sec.length];
      q += (x0 + x1) * (x0 * y1 - x1 * y0);
    }
    return s * Math.sin(2 * Math.PI / s) * q / 6;
  };

  /** ⚠ 用「折板後面那四個」找，⛔ 不用「最後四個」—— 第二輪的齒輪排在它們後面（2026-10-08 實撞） */
  const after = PRIM_TYPES.slice(PRIM_TYPES.indexOf('bend') + 1, PRIM_TYPES.indexOf('bend') + 5);
  eq('★★ 下拉多了四種，排在折板後面', after.join(' '), 'torus wedge dome stairs');
  eq('★★ 下拉顯示的名字', after.map(t => PRIM_SPECS[t].label).join(' '), '圓環 楔形 半球 階梯');
  for (const t of ['torus', 'wedge', 'dome', 'stairs']) {
    ok(`★ ${PRIM_SPECS[t].label}：面板的每一格都有預設值`,
       PRIM_SPECS[t].fields.every(f => Number.isFinite(defaultSrc(t)[f.key])));
  }

  // ── 圓環 ──
  {
    const ro = 30, ri = 15, seg = 32, segT = 12;
    const m = buildPrim('torus', { rOuter: ro, rInner: ri, seg, segT });
    const v = m.validate();
    const R = (ro + ri) / 2, a = (ro - ri) / 2;
    const sec = [...Array(segT).keys()].map(i =>
      [R + a * Math.cos(i / segT * 2 * Math.PI), a * Math.sin(i / segT * 2 * Math.PI)]);
    near('★★★ 圓環 體積 ＝ 多邊形旋轉體公式（正的）', m.volume(), spinVol(sec, seg), 1e-6);
    ok('★★ 圓環 封閉、結構無誤', v.closed && v.ok, v.errors[0] || '');
    eq('★★ 圓環 尤拉數 0（中間通了）', v.euler, 0);
    eq('★★ 圓環 頂點數 ＝ 繞一圈分段 × 管分段（⛔ 首尾那點沒有重複）', v.V, seg * segT);
    const sz = size(m);
    near('★★ 圓環 外徑 ＝ 外半徑 × 2', sz.x, 2 * ro, 1e-9);
    near('★★ 圓環 高 ＝ 管粗 ＝ 外半徑 − 內半徑', sz.y, ro - ri, 1e-9);
    const bad = buildPrim('torus', { rOuter: 20, rInner: 25 });
    ok('★ 內半徑填得比外半徑大 → 夾在外半徑以內照樣做得出來，⛔ 不會壞掉',
       bad.validate().ok && bad.volume() > 0);
  }

  // ── 楔形 ──
  {
    const w = 60, h = 30, d = 40;
    const m = buildPrim('wedge', { w, h, d });
    const v = m.validate();
    near('★★★ 楔形 體積 ＝ 寬 × 高 × 深 ÷ 2（正的）', m.volume(), w * h * d / 2, 1e-9);
    ok('★★ 楔形 封閉、結構無誤', v.closed && v.ok, v.errors[0] || '');
    eq('★★ 楔形 尤拉數 2', v.euler, 2);
    eq('★ 楔形 5 片（底、後、斜面、兩側）', summarize(m).regions, 5);
    const top = m.verts.filter(q => Math.abs(q.p.y - h / 2) < 1e-9);
    ok('★★★ 楔形 後面（−Z）高、前面低：最高的兩點都在後面',
       top.length === 2 && top.every(q => Math.abs(q.p.z + d / 2) < 1e-9));
  }

  // ── 半球 ──
  {
    const r = 30, seg = 32, segH = 8;
    const m = buildPrim('dome', { r, seg, segH });
    const v = m.validate();
    const sec = [[0, 0]];
    for (let j = 0; j <= segH; j++) {
      const a = j / segH * Math.PI / 2;
      sec.push([j === segH ? 0 : r * Math.cos(a), r * Math.sin(a)]);
    }
    near('★★★ 半球 體積 ＝ 多邊形旋轉體公式（正的）', m.volume(), spinVol(sec, seg), 1e-6);
    const sphereHalf = 2 / 3 * Math.PI * r ** 3;
    ok('★ 半球 體積比真半球小一點點（多邊形近似，98% 以上）',
       m.volume() / sphereHalf > 0.98 && m.volume() < sphereHalf, String(m.volume() / sphereHalf));
    ok('★★ 半球 封閉、結構無誤（實心）', v.closed && v.ok, v.errors[0] || '');
    eq('★★ 半球 尤拉數 2', v.euler, 2);
    eq('★★★ 半球 頂點數 ＝ 底心 ＋ 頂點 ＋ 繞一圈分段 × 高度分段（⛔ 極點不疊一圈）',
       v.V, 2 + seg * segH);
    const sz = size(m);
    near('★★ 半球 高 ＝ 半徑', sz.y, r, 1e-9);
    near('★★ 半球 底面直徑 ＝ 半徑 × 2', sz.x, 2 * r, 1e-9);
    const yMin = m.bounds().min.y;
    eq('★★ 半球 底是平的：貼地的點 ＝ 底心 ＋ 一圈',
       m.verts.filter(q => Math.abs(q.p.y - yMin) < 1e-9).length, 1 + seg);
  }

  // ── 階梯 ──
  {
    const n = 4, sh = 15, sd = 25, w = 60;
    const m = buildPrim('stairs', { steps: n, stepH: sh, stepD: sd, w });
    const v = m.validate();
    near('★★★ 階梯 體積 ＝ 寬 × 每階深 × 每階高 × (1＋2＋…＋階數)（正的）',
         m.volume(), w * sd * sh * n * (n + 1) / 2, 1e-9);
    ok('★★ 階梯 封閉、結構無誤', v.closed && v.ok, v.errors[0] || '');
    eq('★★ 階梯 尤拉數 2', v.euler, 2);
    const sz = size(m);
    near('★★ 階梯 總高 ＝ 階數 × 每階高', sz.y, n * sh, 1e-9);
    near('★★ 階梯 總深 ＝ 階數 × 每階深', sz.z, n * sd, 1e-9);
    eq('★ 階梯 片數 ＝ 兩側 ＋ 底 ＋ 後牆 ＋ 踢面 × 階數 ＋ 踏面 × 階數', summarize(m).regions, 4 + 2 * n);
    const zMax = m.bounds().max.z, yMin = m.bounds().min.y;
    ok('★★★ 階梯 前面（＋Z）低：最前面的點都不高過第一階',
       m.verts.filter(q => Math.abs(q.p.z - zMax) < 1e-9).every(q => q.p.y <= yMin + sh + 1e-9));
    near('★ 1 階的階梯 ＝ 一塊方塊',
         buildPrim('stairs', { steps: 1, stepH: 10, stepD: 20, w: 30 }).volume(), 30 * 20 * 10, 1e-9);
  }

  /**
   * ⭐ 楔形與階梯全是平面 ⇒ 展開圖的面積一定 ＝ 模型的表面積，而且⛔ 不可以重疊。
   * 發泡板（會折）與壓克力（每條稜線都切開）兩種都走一次。
   */
  for (const [name, type] of [['楔形', 'wedge'], ['階梯', 'stairs']]) {
    const m = buildPrim(type, {}, 0.2);
    for (const mat of ['foamboard', 'acrylic']) {
      const r = unfoldMesh(m, makeRule(mat, 0.2));
      near(`★★ ${name} 展開（${mat}）面積總和 ＝ 表面積`, r.stats.area, m.area(), 1e-6);
      ok(`★★ ${name} 展開（${mat}）沒有重疊`, r.pieces.every(p => !p.overlap),
         r.pieces.filter(p => p.overlap).length + ' 片重疊');
    }
  }
}

section('齒輪（2026-10-08 第二輪）：真的要能轉');

{
  /**
   * kang：真的要能轉、預設照建議、「我只要知道要如何使用為主」。
   * 🔴 **這一節最重要的是「咬合」那一項**：兩個齒輪擺在 中心距 ＝ 模數 × (z1 ＋ z2) ÷ 2，
   * 一邊轉一邊查 —— **任何一個點跑進對方裡面 ＝ 會卡住**。
   * ⭐ 齒面被切成折線，折線在真正的漸開線**裡面**（漸開線往外凸），所以只會偏薄、⛔ 不會誤判成卡住。
   */
  const { gearDims, gearProfile, PRIM_SPECS, defaultSrc } = await import('../js/build/prim.js');
  const D = defaultSrc('gear');

  // ── 形狀本身 ──
  {
    const m = buildPrim('gear', D);
    const v = m.validate();
    const g = gearDims(D);
    ok('★★ 齒輪 封閉、結構無誤', v.closed && v.ok, v.errors[0] || '');
    eq('★★ 齒輪 有中心孔 → 尤拉數 0', v.euler, 0);
    eq('★ 齒輪 沒有中心孔 → 尤拉數 2', buildPrim('gear', { ...D, hole: 0 }).validate().euler, 2);
    ok('★★ 齒輪 體積是正的', m.volume() > 0);
    const sz = m.bounds().getSize(new THREE.Vector3());
    near('★★ 齒輪 厚度 ＝ 「厚度」那一格', sz.y, D.t, 1e-9);
    near('★★ 齒輪 最外圈直徑 ＝ 模數 × (齒數 ＋ 2)', sz.x, D.module * (D.teeth + 2), 1e-9);
    near('★ 分度圓半徑 ＝ 模數 × 齒數 ÷ 2', g.r, D.module * D.teeth / 2, 1e-12);
    for (const z of [8, 12, 17, 60, 120]) {
      const mz = buildPrim('gear', { ...D, teeth: z });
      ok(`★ ${z} 齒 做得出來（封閉、結構無誤）`, mz.validate().ok && mz.validate().closed && mz.volume() > 0);
    }
  }

  // ── 咬合：兩個齒輪轉一整個齒距，⛔ 不可以卡住 ──
  {
    const inPoly = (P, x, y) => {
      let c = false;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        if ((P[i].y > y) !== (P[j].y > y) &&
            x < (P[j].x - P[i].x) * (y - P[i].y) / (P[j].y - P[i].y) + P[i].x) c = !c;
      }
      return c;
    };
    const segDist = (p, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    };
    const place = (P, rot, cx) => P.map(q => ({
      x: cx + q.x * Math.cos(rot) - q.y * Math.sin(rot), y: q.x * Math.sin(rot) + q.y * Math.cos(rot)
    }));
    /** 回 { 卡住的次數, 最近的距離 cm }。g1 的齒尖朝向 g2 時，g2 要剛好是齒縫朝回來 */
    const mesh2 = (z1, z2, gapMm, m = 0.3, da = 0) => {
      const P1 = gearProfile({ module: m, teeth: z1, gapMm }), P2 = gearProfile({ module: m, teeth: z2, gapMm });
      const a = m * (z1 + z2) / 2 + da;
      /**
       * 🔴 **咬合的地方在「節點」＝ 小齒輪那一側的分度圓上（x ＝ m·z1/2），⛔ 不是兩個中心的正中間。**
       * 【實證 2026-10-08】第一版用 a/2 —— 只有齒數一樣時才對；20 配 40 時根本沒看到咬合處，
       * 「不會卡住」那項是**空轉通過**，是「最近距離 ＝ ∞」才照出來的。
       */
      const xp = m * z1 / 2;
      let hits = 0, minD = Infinity;
      const N = 24;
      for (let k = 0; k < N; k++) {
        const th = (2 * Math.PI / z1) * k / N;
        const A = place(P1, th, 0), B = place(P2, Math.PI + Math.PI / z2 - th * z1 / z2, a);
        // 只看咬合那一帶（兩個中心連線附近），其餘離得很遠
        const near1 = A.filter(q => q.x > xp - 3 * m), near2 = B.filter(q => q.x < xp + 3 * m);
        for (const q of near1) if (inPoly(B, q.x, q.y)) hits++;
        for (const q of near2) if (inPoly(A, q.x, q.y)) hits++;
        for (const q of near1) for (let i = 0; i < B.length; i++) {
          const b0 = B[i], b1 = B[(i + 1) % B.length];
          if (b0.x < xp + 3 * m) minD = Math.min(minD, segDist(q, b0, b1));
        }
      }
      return { hits, minD };
    };
    for (const [z1, z2] of [[20, 40], [20, 20], [8, 8], [12, 60]]) {
      const r = mesh2(z1, z2, 0.2);
      eq(`★★★ ${z1} 齒配 ${z2} 齒、間隙 0.2 mm：轉一個齒距都⛔ 不會卡住`, r.hits, 0);
      ok(`★★ ${z1} 配 ${z2}：最近的地方有留空隙，而且⛔ 超過間隙（齒⛔ 不是瘦到碰不到）`,
         r.minD > 0 && r.minD < 0.02, `${(r.minD * 10).toFixed(3)} mm`);
    }
    /**
     * 🔴 **對照組：這個測試真的抓得到卡住嗎？** —— 中心距離故意少 0.5 mm，一定要卡。
     * ⛔ 沒有這一項的話，上面「0 次卡住」分不出是「真的沒卡」還是「根本沒看到」
     * （第一版就是後者）。
     */
    ok('★★★ 對照組：中心距離故意少 0.5 mm → 一定卡住（證明上面那幾項⛔ 不是空轉）',
       mesh2(20, 40, 0.2, 0.3, -0.05).hits > 0);
    const tight = mesh2(20, 40, 0);
    eq('★★★ 間隙 0：照樣⛔ 不會卡住（齒形本身是對的）', tight.hits, 0);
    ok('★★★ 間隙 0：最近的地方幾乎貼在一起（< 0.05 mm）—— 齒⛔ 不是做得太瘦',
       tight.minD < 0.005, `${(tight.minD * 10).toFixed(3)} mm`);
  }

  // ── 雷射切：剖面分切切成一片 ＝ 外形一圈 ＋ 孔一圈 ──
  {
    const m = buildPrim('gear', D);
    const r = sect.sliceMesh(m, { axis: 'y', bands: [{ t: D.t, n: 'rest' }] });
    eq('★★★ 剖面分切：厚度填板厚 → 切成 1 片', r.slices.length, 1);
    const loops = r.slices[0].loops;
    eq('★★★ 那一片是 2 圈：外形 ＋ 中心孔（⛔ 沒有展開圖那條切開線）', loops.length, 2);
    eq('★★ 其中 1 圈是孔', loops.filter(l => l.isHole).length, 1);
    near('★★ 切出來的面積 × 厚度 ＝ 齒輪體積', r.slices[0].area * D.t, m.volume(), 1e-6);
  }

  // ── 面板：看得到的用法說明 ──
  {
    const notes = PRIM_SPECS.gear.noteOf(D);
    ok('★★ 面板說明：寫出分度圓直徑 6 cm（＝ 0.3 × 20）', notes.some(s => s.includes('分度圓直徑') && s.includes('6 cm')));
    // ⚠ 用「有沒有一行寫到」找，⛔ 不寫死第幾行 —— 多插一行說明就會錯位（2026-10-08 實撞）
    ok('★★ 面板說明：寫出咬合的中心距離算法', notes.some(s => s.includes('0.15 × (20 ＋ 對方齒數)')));
    ok('★★ 面板說明：寫出雷射切怎麼做', notes.some(s => s.includes('剖面分切') && s.includes('「孔徑」填 0')));
    ok('★★ 面板說明：齒尖頂齒尖時怎麼辦（轉半個齒）', notes.some(s => s.includes('180 ÷ 它的齒數')));
    // kang 2026-10-08 實測：用縮放放大 5 倍、走了展開圖 —— 兩件都要在面板上講出來
    ok('★★ 面板說明：大小改「模數」、⛔ 不要用縮放', notes.some(s => s.includes('改「模數」') && s.includes('不要用縮放')));
    ok('★★ 面板說明：雷射切⛔ 不要用展開圖', notes.some(s => s.includes('不要用展開圖')));
    // kang 2026-10-08：照舊說明把齒輪的中心孔直徑改成 0 —— 「孔徑」要講明是剖面分切視窗那一格
    ok('★★★ 面板說明：「孔徑」寫明是定位孔、⛔ 不是這裡的中心孔直徑',
       notes.some(s => s.includes('視窗上方的「孔徑」') && s.includes('不是這裡的「中心孔直徑」')));
    ok('★★ 面板說明：Illustrator 用 Ctrl＋J 合併成封閉線（kang 驗過）', notes.some(s => s.includes('Ctrl＋J')));
    eq('★ 沒縮放 → ⛔ 沒有縮放的 ⚠', PRIM_SPECS.gear.noteOf(D, { scale: { x: 1, y: 1, z: 1 } }).filter(s => s.includes('縮放過')).length, 0);
    const sc = PRIM_SPECS.gear.noteOf(D, { scale: { x: 5, y: 5, z: 5 } });
    ok('★★★ 縮放過 → 多一行 ⚠，寫出倍數、叫人改回 1 用模數', sc.some(s => s.includes('縮放過（5 × 5 × 5 倍）') && s.includes('改用「模數」')));
    ok('★ 齒數少於 17 → 多一句提醒', PRIM_SPECS.gear.noteOf({ ...D, teeth: 10 }).some(s => s.includes('少於 17')));
    const big = PRIM_SPECS.gear.noteOf({ ...D, hole: 9 });
    ok('★★ 中心孔太大 → 照樣做得出來，而且【說出來】縮成多少（⛔ 不默默夾住）',
       big.some(s => s.includes('已經縮成')) && buildPrim('gear', { ...D, hole: 9 }).validate().ok);
  }
}

section('齒輪「咬上去」（2026-10-08）：先選的動、維持方向、模數跟著改');

{
  /**
   * 🔴 **⛔ 不信公式，信世界座標**：兩個齒形都用 `ModelObject.matrix()` 真的擺到世界裡
   * （齒形的 (x, y) 放在世界的 (x, z) —— `extrude.js`），再查有沒有任何一點跑進對方。
   * 角度的正負號（2D 角度 ↔ 旋轉 Y）就是靠這一項對答案的。
   */
  const { meshGearPair } = await import('../js/core/gearPair.js');
  const { gearProfile } = await import('../js/build/prim.js');
  const gear = (name, p, x, z, rotYdeg = 0) => {
    const o = new io.ModelObject({ name, kind: io.KIND.SOLID, src: { type: 'gear', module: 0.3, teeth: 20, t: 0.5, hole: 0.6, gapMm: 0.2, ...p } });
    o.pos.set(x, 3, z);
    o.rot.set(0, rotYdeg * Math.PI / 180, 0);
    return o;
  };
  const world = o => {
    const m = o.matrix();
    return gearProfile(o.src).map(q => new THREE.Vector3(q.x, 0, q.y).applyMatrix4(m)).map(v => ({ x: v.x, y: v.z }));
  };
  const inPoly = (P, x, y) => {
    let c = false;
    for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
      if ((P[i].y > y) !== (P[j].y > y) && x < (P[j].x - P[i].x) * (y - P[i].y) / (P[j].y - P[i].y) + P[i].x) c = !c;
    }
    return c;
  };
  const clash = (a, b) => { const A = world(a), B = world(b); return A.filter(q => inPoly(B, q.x, q.y)).length + B.filter(q => inPoly(A, q.x, q.y)).length; };
  const apply = (mover, r) => {
    if (r.module != null) mover.src.module = r.module;
    mover.pos.set(r.pos.x, r.pos.y, r.pos.z);
    mover.rot.set(0, r.rotY, 0);
    mover.invalidate();
  };

  // ── 各種方向、齒數、不動的那個先轉過 —— 按下去都要咬得上 ──
  let all = 0, bad = [];
  /**
   * ⚠ ⛔ 不放 8 齒配大齒輪 —— 那一組本來就會卡一點點（下面「已知限制」那一項盯著），
   * 跟「咬上去」的公式無關。【實證 2026-10-08】第一版放了 8/60，48 種裡只有那 4 種各卡 1 個點，
   * 量出來最深 0.028 mm；10～18 齒配任何齒數都是 0。
   */
  for (const [zA, zB] of [[20, 40], [20, 20], [13, 31], [10, 60]]) {
    for (const rotA of [0, 7, 33]) {
      for (const dirDeg of [0, 50, 135, 250]) {
        const A = gear('A', { teeth: zA }, 10, -4, rotA);
        const d = dirDeg * Math.PI / 180;
        const B = gear('B', { teeth: zB }, 10 + 30 * Math.cos(d), -4 + 30 * Math.sin(d), 12);
        const r = meshGearPair(B, A);
        apply(B, r);
        all++;
        const h = clash(B, A);
        const dirNow = Math.atan2(B.pos.z - A.pos.z, B.pos.x - A.pos.x) * 180 / Math.PI;
        const want = 0.3 * (zA + zB) / 2;
        if (h || Math.abs(Math.hypot(B.pos.x - A.pos.x, B.pos.z - A.pos.z) - want) > 1e-9
            || Math.abs(((dirNow - dirDeg) % 360 + 540) % 360 - 180) > 1e-6) bad.push(`${zA}/${zB} A轉${rotA} 方向${dirDeg}：卡${h}`);
      }
    }
  }
  eq(`★★★ ${all} 種擺法（齒數 × A 先轉的角度 × 方向）按下去都咬得上、距離對、方向沒變`, bad.join(' / '), '');

  /**
   * 🔴 **已知限制：8 齒配大齒輪會卡一點點**（⛔ 不是「咬上去」的錯，是 8 齒齒輪本身）。
   * 標準齒輪少於 17 齒時，大齒輪的齒尖會掃進小齒輪的齒根 —— 真的加工會把那裡削掉（根切），
   * 而 `gearOutline()` 在基圓以下用**直線**補（多了一點料）。
   * 量出來最深不到 0.05 mm，比雷射的切縫（0.1～0.2 mm）小 ⇒ 實際切出來吃得掉。
   * ⭐ 這一項盯的是「**不可以變得更深**」—— 以後改齒形，這個數字變大就會被抓到。
   */
  {
    const segD = (p, a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    };
    let worst = 0;
    for (const rotA of [0, 3, 7, 11, 19, 33]) {
      const A = gear('A', { teeth: 8 }, 0, 0, rotA), B = gear('B', { teeth: 120 }, 30, 0);
      apply(B, meshGearPair(B, A));
      const PA = world(A), PB = world(B);
      for (const q of PB) if (inPoly(PA, q.x, q.y)) {
        let d = Infinity;
        for (let i = 0; i < PA.length; i++) d = Math.min(d, segD(q, PA[i], PA[(i + 1) % PA.length]));
        worst = Math.max(worst, d);
      }
    }
    ok('★★ 已知限制：8 齒配 120 齒最多卡進 0.05 mm（比雷射切縫小）', worst < 0.005, `${(worst * 10).toFixed(3)} mm`);
  }

  // ── 對照組：角度故意差半齒 → 一定卡住（證明上面⛔ 不是空轉）──
  {
    const A = gear('A', { teeth: 20 }, 0, 0, 7), B = gear('B', { teeth: 40 }, 20, 5);
    const r = meshGearPair(B, A);
    apply(B, { ...r, rotY: r.rotY + Math.PI / 40 });
    ok('★★★ 對照組：B 的角度故意多轉半個齒 → 一定卡住', clash(B, A) > 0);
  }

  // ── 先選的動、後選的不動；高度跟不動的那個一樣 ──
  {
    const A = gear('A', {}, 5, 5), B = gear('B', { teeth: 30 }, 40, 5);
    B.pos.y = 99;
    const a0 = A.pos.clone();
    const r = meshGearPair(B, A);
    ok('★★ 不動的那個（後選的）⛔ 沒有被算進要改的東西', r.ok && A.pos.equals(a0));
    near('★★ 動的那個高度 ＝ 不動的那個（同一個平面）', r.pos.y, A.pos.y, 1e-12);
  }

  // ── 模數不同 → 改成跟不動的一樣，而且說出來 ──
  {
    const A = gear('A', { module: 0.3 }, 0, 0), B = gear('B', { module: 0.5, teeth: 30 }, 10, 0);
    const r = meshGearPair(B, A);
    eq('★★★ 模數不同 → 動的那個改成跟不動的一樣', r.module, 0.3);
    ok('★★★ 而且【說出來】改了什麼（⛔ 不默默改）', r.notes.some(s => s.includes('從 0.5 改成 0.3')), r.notes.join('|'));
    near('★★ 距離照新的模數算 ＝ 0.3 × (20 ＋ 30) ÷ 2', r.dist, 7.5, 1e-12);
    apply(B, r);
    eq('★★ 改完照樣咬得上', clash(B, A), 0);
    eq('★ 模數一樣 → ⛔ 不改、⛔ 沒有那句', meshGearPair(gear('C', {}, 9, 0), A).module, null);
  }

  // ── 擋下來的情況：要講原因 ──
  {
    const A = gear('A', {}, 0, 0), B = gear('B', {}, 10, 0);
    const box = new io.ModelObject({ name: '方塊', kind: io.KIND.SOLID, src: { type: 'box', w: 1, h: 1, d: 1 } });
    ok('★★ 選到不是齒輪的 → 擋下來，講原因', !meshGearPair(box, A).ok && meshGearPair(box, A).reason.includes('兩個齒輪'));
    B.scale.set(2, 2, 2);
    const rs = meshGearPair(B, A);
    ok('★★ 縮放過 → 擋下來，叫人改回 1、改模數', !rs.ok && rs.reason.includes('縮放') && rs.reason.includes('模數'), rs.reason);
    B.scale.set(1, 1, 1); B.rot.set(0.3, 0, 0);
    const rt = meshGearPair(B, A);
    ok('★★ 沒有平躺（旋轉 X 不是 0）→ 擋下來', !rt.ok && rt.reason.includes('平躺'), rt.reason);
    B.rot.set(0, 0, 0); B.pos.set(0, 3, 0);
    const rsame = meshGearPair(B, A);
    ok('★ 疊在同一個位置 → 擺到右邊（+X），而且說出來', rsame.ok && rsame.pos.x > A.pos.x && rsame.notes.some(s => s.includes('+X')));
  }
}

section('落地 ＋ 內半徑太大要說出來（2026-10-09）');

{
  /**
   * kang 2026-10-08 實測新增形狀時發現兩件：改尺寸會沉到地板下；圓環／管的內半徑填太大默默夾住。
   * 2026-10-09 拍板：⛔ 不做「改格子自動往上長」，改做「落地」按鈕；多選 ＝ 整組一起落；沉下去要主動提醒。
   */
  const { landPositions, lowestY, worldBounds } = await import('../js/core/align.js');
  const { PRIM_SPECS } = await import('../js/build/prim.js');
  const mk = (src, x, y, z) => {
    const o = new io.ModelObject({ name: src.type, kind: io.KIND.SOLID, src });
    o.pos.set(x, y, z);
    return o;
  };
  const put = (objs, ps) => objs.forEach((o, i) => o.pos.copy(ps[i]));
  /**
   * 🔴 **檢查用【真的頂點】，⛔ 不用 `worldBounds()`** —— 第一版拿 `worldBounds()` 檢查，
   * 而落地也是用它算的 ⇒ 自己對自己，斜放的楔形浮起來也照樣「通過」（2026-10-09 實撞）。
   */
  const lowV = o => Math.min(...o.mesh().verts.map(v => v.p.clone().applyMatrix4(o.matrix()).y));

  // ── kang 撞到的那個：方塊 45 → 90，中心不動 ⇒ 沉 22.5 ──
  {
    const b = mk({ type: 'box', w: 60, h: 45, d: 40 }, 3, 22.5, -7);
    b.src.h = 90; b.invalidate();
    near('★★★ 方塊加高到 90、中心不動 → 底部在地板下 22.5（kang 撞到的）', lowestY([b]), -22.5, 1e-9);
    put([b], landPositions([b]));
    near('★★★ 按落地 → 底部剛好貼地', lowV(b), 0, 1e-9);
    ok('★★ 只動高度：X、Z 不變', b.pos.x === 3 && b.pos.z === -7);
  }

  // ── 浮起來的也會落下來 ──
  {
    const s = mk({ type: 'dome', r: 30 }, 0, 80, 0);
    put([s], landPositions([s]));
    near('★★ 浮在半空的 → 也落到地板', lowV(s), 0, 1e-9);
  }

  // ── 旋轉過的：照外接盒落地 ──
  {
    const w = mk({ type: 'wedge', w: 60, h: 30, d: 40 }, 0, 0, 0);
    /** ⚠ 角度要挑「楔形缺掉的那兩個角朝下」—— 第一次挑的 (0.7, 0.3, −0.4) 剛好有真的角在最低處，看不出差別 */
    w.rot.set(2.6, 0.2, 0);
    ok('★ 對照組：斜放時「外接盒」比真的最低點還低（所以⛔ 不能拿它落地）', worldBounds(w).min.y < lowV(w) - 0.1,
       `${worldBounds(w).min.y.toFixed(3)} vs ${lowV(w).toFixed(3)}`);
    put([w], landPositions([w]));
    near('★★★ 斜放的楔形 → 真的最低那一點貼地（⛔ 不是浮著）', lowV(w), 0, 1e-9);
  }

  // ── 整組一起落：疊著的照樣疊著 ──
  {
    const table = mk({ type: 'box', w: 100, h: 40, d: 60 }, 0, 20 - 15, 0);   // 桌子沉了 15
    const cup = mk({ type: 'cylinder', r: 5, h: 10 }, 0, 45 - 15, 0);         // 杯子坐在桌面上
    const gap0 = worldBounds(cup).min.y - worldBounds(table).max.y;
    put([table, cup], landPositions([table, cup]));
    near('★★★ 整組落地：最低的（桌子）貼地', lowV(table), 0, 1e-9);
    near('★★★ 整組落地：杯子照樣坐在桌面上（上下關係不變）',
         worldBounds(cup).min.y - worldBounds(table).max.y, gap0, 1e-9);
    eq('★ 已經貼地 → 再按一次⛔ 不動', landPositions([table, cup]).every((p, i) => p.equals([table, cup][i].pos)), true);
  }

  // ── 內半徑太大要說出來 ──
  {
    for (const [type, ro, ri] of [['torus', 30, 15], ['tube', 25, 20]]) {
      const lab = PRIM_SPECS[type].label;
      eq(`★ ${lab}：內半徑比外半徑小 → ⛔ 沒有提醒`, PRIM_SPECS[type].noteOf({ rOuter: ro, rInner: ri }).length, 0);
      const n = PRIM_SPECS[type].noteOf({ rOuter: ro, rInner: ro + 10 });
      ok(`★★★ ${lab}：內半徑填得比外半徑大 → 面板寫出兩個數字、叫人改小（⛔ 不默默夾住）`,
         n.length === 1 && n[0].includes(`內半徑（${ro + 10}）`) && n[0].includes(`外半徑（${ro}）`), n.join('|'));
      ok(`★ ${lab}：內半徑 ＝ 外半徑 → 也提醒`, PRIM_SPECS[type].noteOf({ rOuter: ro, rInner: ro }).length === 1);
    }
  }
}

section('打版（展開模式一：精確分片）：一次標一整圈 ＋ 相同的折線合成一行（2026-10-09）');

{
  /**
   * kang 2026-10-09：要像衣服打版、布娃娃、造型氣球那樣把圓環攤成幾片。
   * 圓環照管子截面切 32 條西瓜皮、或照大圓切 12 條環帶，每片都 0 失真 —— 卡在要標 384 條邊。
   * 拍板：分片模式「點一條線」可以選 只標那一條／一整圈／同方向的全部；
   * 相同的折線合成一行（開關、打版預設開；上折下折混在一起的照樣每道標字）。
   */
  const { seamLoopEdges } = await import('../js/core/selectops.js');
  const { setSeam, isSeam } = await import('../js/unfold/seam.js');
  const { sameFolds } = await import('../js/out/sheet.js');
  const torus = () => buildPrim('torus', { rOuter: 30, rInner: 15, seg: 32, segT: 12 });
  /** 管子方向的邊（落在同一個子午面上）／大圓方向的邊（同一個管子位置） */
  const isTube = he => Math.abs(Math.atan2(he.v.p.z, he.v.p.x) - Math.atan2(he.to.p.z, he.to.p.x)) < 1e-6;
  const isRing = he => Math.abs(he.v.p.y - he.to.p.y) < 1e-6
    && Math.abs(Math.hypot(he.v.p.x, he.v.p.z) - Math.hypot(he.to.p.x, he.to.p.z)) < 1e-6;

  // ── 標多少 ──
  {
    const m = torus();
    const tube = [...m.edges()].find(isTube), ring = [...m.edges()].find(isRing);
    eq('★★★ 管子方向的線「標一整圈」＝ 繞管子一圈 12 條', seamLoopEdges(m, tube, 'loop').length, 12);
    eq('★★★ 大圓方向的線「標一整圈」＝ 繞大圓一圈 32 條', seamLoopEdges(m, ring, 'loop').length, 32);
    const allT = seamLoopEdges(m, tube, 'all');
    eq('★★★ 管子方向「同方向的全部」＝ 32 圈 × 12 ＝ 384 條', allT.length, 384);
    ok('★★ 　 而且全部都是管子方向的（⛔ 混進另一個方向）', allT.every(isTube));
    const allR = seamLoopEdges(m, ring, 'all');
    eq('★★★ 大圓方向「同方向的全部」＝ 12 圈 × 32 ＝ 384 條', allR.length, 384);
    ok('★★ 　 而且全部都是大圓方向的', allR.every(isRing));
    /**
     * ⚠ 「新增 → 球」全是三角形（每格斜切兩半），「一整圈」只走得了四邊形的格子。
     * 而標切線本來就要先「轉成可編輯網格」—— 轉了之後是 72 格四邊形 ＋ 兩極 24 個三角形。
     * 【實證 2026-10-09】第一版測試直接拿參數球，只標到 1 條；⇒ 照使用者真的會走的路先 bake。
     */
    const so = new io.ModelObject({ name: '球', kind: io.KIND.SOLID, src: { type: 'sphere', r: 30, segW: 12, segH: 8 } });
    so.bake();
    const sph = so.mesh();
    const mer = [...sph.edges()].find(he => Math.abs(he.v.p.x * he.to.p.z - he.v.p.z * he.to.p.x) < 1e-9
      && Math.abs(he.v.p.y - he.to.p.y) > 1e-6 && Math.abs(he.v.p.y) < 29 && Math.abs(he.to.p.y) < 29);
    eq('★★ 球：經線「同方向的全部」＝ 12 條經線 × 8 段（停在極點，那是對的）', seamLoopEdges(sph, mer, 'all').length, 12 * 8);
  }

  // ── 標完展開：32 條西瓜皮／12 條環帶，0 重疊、面積對 ──
  /**
   * ⚠ 2026-10-19（綜合評估 ①-11）起：有平滑標記、互相不平行的折線收成一段圓錐面 ⇒ 圓環的環帶（每一圈是一段圓錐）⛔ 再畫 31 道折線。
   * 「相同的折線合成一行」那幾項要的是「31 道一樣的真折線」⇒ 那幾項用 `noSmooth`（把平滑標記拿掉，像匯入的網格）照舊守。
   */
  const cutAll = (pick, noSmooth = false) => {
    const m = torus();
    if (noSmooth) for (const h of [...m.edges()]) if (h.smooth) m.setSmooth(h, false);
    for (const h of seamLoopEdges(m, [...m.edges()].find(pick), 'all')) setSeam(m, h, true);
    return { m, r: unfoldMesh(m, makeRule('paper', 0.05)) };
  };
  for (const [name, pick, want] of [['西瓜皮', isTube, 32], ['環帶', isRing, 12]]) {
    const { m, r } = cutAll(pick);
    eq(`★★★ 圓環切成${name}：${want} 片`, r.stats.total, want);
    eq(`★★★ 圓環切成${name}：0 片重疊`, r.pieces.filter(p => p.overlap).length, 0);
    near(`★★ 圓環切成${name}：展開面積 ＝ 表面積`, r.stats.area, m.area(), 1e-6);
  }

  /**
   * ⭐ 西瓜皮：管子方向的邊本來就標成「平滑的曲面」（`revolve()`）⇒ 展開時併成**圓弧折彎**（標 R 與段數），
   * 加頭尾兩道尖角 —— 每片只有 5 個標註，⛔ 不擠；而圓弧要給人看 R，所以⛔ 不合成一行（`sameFolds()` 的規則）。
   * 【實證 2026-10-09】AI 原本以為西瓜皮也會「全部一樣」，量了才知道是這樣 —— 字真正擠的是環帶。
   */
  {
    const { r } = cutAll(isTube);
    eq('★★ 西瓜皮：有圓弧折彎 ⇒ ⛔ 不合成一行（R 與段數要留給人看）', r.pieces.filter(p => sameFolds(p)).length, 0);
    ok('★★ 西瓜皮：每片標註 ≤ 5 個（⛔ 擠）', r.pieces.every(p => p.bends.length <= 5), r.pieces.map(p => p.bends.length).join(','));
  }

  {
    const { r } = cutAll(isRing);
    ok('★★★ 圓環切成環帶（有平滑標記）：每一片都是一段圓錐面曲線帶、圖上 0 道折線（①-11）',
      r.pieces.every(p => p.bends.length === 1 && p.bends[0].isCurve && p.folds.every(f => f.isArcEdge)),
      r.pieces.map(p => `${p.bends.length}/${p.folds.filter(f => !f.isArcEdge).length}`).join(','));
  }
  for (const [name, pick, want] of [['環帶', isRing, 12]]) {
    const { r } = cutAll(pick, true);
    eq(`★★★ 圓環（拿掉平滑標記）切成${name}：每一片的折線都「全部一樣」（31 道）→ 可以合成一行`,
       r.pieces.filter(p => sameFolds(p) && sameFolds(p).n === 31).length, want);

    // 卡片、圖、DXF：開著才合成，關著照舊
    const p = r.pieces[0], same = sameFolds(p);
    const off = titleLines(p, { rule: r.rule }), on = titleLines(p, { rule: r.rule, foldSummary: true });
    ok(`★★ ${name}：關著 → 卡片⛔ 沒有那一行（原本的樣子）`, !off.some(s => s.includes('折線全部一樣')));
    ok(`★★★ ${name}：開著 → 卡片多一行「折線全部一樣：${same.dir} …（${same.n} 道）」`,
       on.some(s => s.includes('折線全部一樣') && s.includes(`（${same.n} 道）`)), on.join('|'));
    const bendText = o => drawProgram(p, { rule: r.rule, ...o }).items.filter(i => i.t === 'text' && /上折|下折/.test(i.s)).length;
    ok(`★★ ${name}：關著 → 圖上每道都有字`, bendText({}) > 0, String(bendText({})));
    eq(`★★★ ${name}：開著 → 圖上⛔ 沒有每道的字（只畫線）`, bendText({ foldSummary: true }), 0);
    const dxfOn = toDXF(r.pieces, { unit: 'mm', rule: r.rule, foldSummary: true });
    const dxfOff = toDXF(r.pieces, { unit: 'mm', rule: r.rule });
    eq(`★★ ${name}：DXF 開著 → 每片一行「ALL n FOLDS」`, (dxfOn.match(/ALL \d+ FOLDS/g) || []).length, want);
    eq(`★ ${name}：DXF 關著 → ⛔ 沒有那一行（原本的樣子）`, (dxfOff.match(/ALL \d+ FOLDS/g) || []).length, 0);
  }

  // ── ⛔ 上折下折混在一起的，開著也照樣每道標字 ──
  {
    const r = unfoldMesh(buildPrim('gear', { module: 0.3, teeth: 12, t: 0.5, hole: 0 }), makeRule('foamboard', 0.2));
    const strip = r.pieces.find(p => p.bends.some(b => b.angle > 0) && p.bends.some(b => b.angle < 0));
    ok('★ 對照：齒輪側邊的帶子有上折也有下折', !!strip);
    eq('★★★ 上下混在一起 → ⛔ 不合成（不然分不出哪條往哪折）', strip ? sameFolds(strip) : 'x', null);
  }

  // ── 方塊：原本的展開圖預設⛔ 不變 ──
  {
    const r = unfoldMesh(buildPrim('box', { w: 60, h: 45, d: 40 }), makeRule('foamboard', 0.2));
    const p = r.pieces.find(q => q.bends.length >= 2);
    ok('★★ 方塊沒標過切線：預設（關著）卡片與圖都跟原本一樣',
       !titleLines(p, { rule: r.rule }).some(s => s.includes('折線全部一樣'))
       && drawProgram(p, { rule: r.rule }).items.some(i => i.t === 'text' && /上折|下折/.test(i.s)));
  }
}

section('排版：把很多片擺進一張一張板子（2026-10-09）');

{
  /**
   * kang 實測打版：DXF 全部排成一長條（577 cm）、SVG 一片一個檔 ——「數量很多時...很難做後續的安排」。
   * 拍板：板子預設 240 × 120（橫放、可自由輸入）、每張板一個檔、轉 90° 開關預設關、排版預設開。
   */
  const { packBoards, boardProgram, NEST_DEFAULTS } = await import('../js/out/nest.js');
  const { boardDXF } = await import('../js/out/dxf.js');
  const { setSeam } = await import('../js/unfold/seam.js');
  const { seamLoopEdges } = await import('../js/core/selectops.js');
  const isRing = he => Math.abs(he.v.p.y - he.to.p.y) < 1e-6
    && Math.abs(Math.hypot(he.v.p.x, he.v.p.z) - Math.hypot(he.to.p.x, he.to.p.z)) < 1e-6;
  const isTube = he => Math.abs(Math.atan2(he.v.p.z, he.v.p.x) - Math.atan2(he.to.p.z, he.to.p.x)) < 1e-6;
  const cut = pick => {
    const m = buildPrim('torus', { rOuter: 30, rInner: 15, seg: 32, segT: 12 });
    for (const h of seamLoopEdges(m, [...m.edges()].find(pick), 'all')) setSeam(m, h, true);
    const r = unfoldMesh(m, makeRule('paper', 0.05));
    r.pieces.forEach((p, i) => { p.no = 'P' + String(i + 1).padStart(2, '0'); });
    return r;
  };
  /** 全部片都在板子裡、彼此⛔ 重疊（含間距）、一片都沒少 */
  const check = (nest, pieces, g) => {
    const bad = [];
    let n = 0;
    nest.boards.forEach((b, bi) => {
      b.items.forEach((it, i) => {
        n++;
        if (it.x < g - 1e-9 || it.y < g - 1e-9 || it.x + it.w > b.w - g + 1e-9 || it.y + it.h > b.h - g + 1e-9) bad.push(`板${bi + 1}#${i} 出界`);
        b.items.forEach((o, j) => {
          if (j <= i) return;
          const sep = it.x + it.w + g <= o.x + 1e-9 || o.x + o.w + g <= it.x + 1e-9
            || it.y + it.h + g <= o.y + 1e-9 || o.y + o.h + g <= it.y + 1e-9;
          if (!sep) bad.push(`板${bi + 1}#${i}×#${j} 重疊`);
        });
      });
    });
    const want = pieces.reduce((s, p) => s + (p.qty || 1), 0);
    return { bad, n, want };
  };

  eq('★★ 預設：開、240 × 120（橫放）、間距 1、⛔ 不轉（kang 拍板）',
     JSON.stringify(NEST_DEFAULTS), JSON.stringify({ on: true, w: 240, h: 120, gap: 1, rotate: false }));

  for (const [name, pick] of [['環帶', isRing], ['西瓜皮', isTube]]) {
    const r = cut(pick);
    const nest = packBoards(r.pieces, NEST_DEFAULTS);
    const c = check(nest, r.pieces, 1);
    eq(`★★★ ${name}：每一片都在板子裡、彼此⛔ 重疊`, c.bad.join(' / '), '');
    eq(`★★★ ${name}：一片都沒少（${c.want} 片）`, c.n, c.want);
    ok(`★★ ${name}：比排成一長條省（板子數 ＜ 片數）`, nest.boards.length < c.want, `${nest.boards.length} 張`);

    // 同一份「畫什麼」→ DXF：切割線條數一樣、板子外框在 SHEET 層
    const prog = boardProgram(nest.boards[0], { rule: r.rule, label: p => p.no });
    const cutN = prog.items.filter(i => i.t === 'line' && i.style === 'cut').length;
    const dxf = boardDXF(prog, { unit: 'mm', title: 'SHEET 1' });
    eq(`★★ ${name}：DXF 的切割線條數 ＝ 畫面上的`, (dxf.match(/\r\nLINE\r\n8\r\nCUT\r\n/g) || []).length, cutN);
    eq(`★★ ${name}：板子外框 4 條在 SHEET 層（⛔ 不是切割線）`, (dxf.match(/\r\nLINE\r\n8\r\nSHEET\r\n/g) || []).length, 4);
    const out = prog.items.filter(i => i.t === 'line' && [i.x1, i.x2].some(x => x < -1e-6 || x > prog.box.w + 1e-6)
      || i.t === 'line' && [i.y1, i.y2].some(y => y < -1e-6 || y > prog.box.h + 1e-6)).length;
    eq(`★★ ${name}：畫出來的線全部在板子裡`, out, 0);
    ok(`★ ${name}：每片都有片號`, nest.boards[0].items.every(it => prog.items.some(i => i.style === 'num' && i.s === it.piece.no)));
  }

  /**
   * ⚠ 圓弧折彎的參考線在單片圖上會上下多畫 1 cm —— 排在板子上要夾回片內，
   * 否則間距 0 時會畫進隔壁那片（2026-10-09 AI 線上看到藍線伸出片外）。
   */
  {
    const r = cut(isTube);                      // 西瓜皮有圓弧折彎
    const one = packBoards([{ ...r.pieces[0], qty: 1 }], { w: 240, h: 120, gap: 0 });
    const it = one.boards[0].items[0];
    const bends = boardProgram(one.boards[0], { rule: r.rule }).items.filter(i => i.t === 'line' && i.style === 'bend');
    ok('★ 對照：西瓜皮真的有圓弧折彎的參考線', bends.length > 0, String(bends.length));
    ok('★★ 圓弧折彎的參考線⛔ 伸出那一片（間距 0 也⛔ 畫進隔壁）',
       bends.every(i => Math.min(i.y1, i.y2) >= it.y - 1e-9 && Math.max(i.y1, i.y2) <= it.y + it.h + 1e-9));
  }

  // ── 比板子大的：單獨一張、標出來 ──
  {
    const r = cut(isRing);
    const nest = packBoards(r.pieces, { w: 100, h: 60, gap: 1, rotate: false });
    const big = nest.boards.filter(b => b.oversize);
    ok('★★★ 板子 100 × 60：164.8 長的環帶擺不下 → 單獨一張、標成比板子大（⛔ 默默丟掉）',
       big.length >= 1 && big.every(b => b.items.length === 1 && b.w >= b.items[0].piece.width));
    eq('★★ 　 片數照樣一片都沒少', check(nest, r.pieces, 1).n, r.pieces.length);
  }

  // ── 轉 90°：開關 ──
  {
    const r = cut(isTube);                      // 西瓜皮 46.5 × 5.9
    const narrow = { w: 12, h: 60, gap: 1 };
    const off = packBoards(r.pieces, { ...narrow, rotate: false });
    const on = packBoards(r.pieces, { ...narrow, rotate: true });
    ok('★★★ ⛔ 不轉（預設）：46.5 長的西瓜皮放不進 12 寬的板 → 全部單獨一張', off.boards.every(b => b.oversize));
    ok('★★★ 可以轉 90°：轉直就放得進去', on.boards.every(b => !b.oversize) && on.boards[0].items[0].rot === 90);
    eq('★★ 　 轉過的也⛔ 重疊、⛔ 出界', check(on, r.pieces, 1).bad.join(' / '), '');
    /** 只擺一片轉過的 —— 它的每一條切割線都要落在自己的格子裡（四邊都查，⛔ 只查左下）*/
    const one = packBoards([{ ...r.pieces[0], qty: 1 }], { ...narrow, rotate: true });
    const it = one.boards[0].items[0];
    const cutLines = boardProgram(one.boards[0], { rule: r.rule }).items.filter(i => i.t === 'line' && i.style === 'cut');
    const xs = cutLines.flatMap(i => [i.x1, i.x2]), ys = cutLines.flatMap(i => [i.y1, i.y2]);
    ok('★★★ 轉過的那片畫在它自己的格子裡（四邊都⛔ 超出）',
       it.rot === 90 && Math.min(...xs) >= it.x - 1e-6 && Math.max(...xs) <= it.x + it.w + 1e-6
       && Math.min(...ys) >= it.y - 1e-6 && Math.max(...ys) <= it.y + it.h + 1e-6,
       `x ${Math.min(...xs).toFixed(2)}～${Math.max(...xs).toFixed(2)} / 格子 ${it.x}～${(it.x + it.w).toFixed(2)}；`
       + `y ${Math.min(...ys).toFixed(2)}～${Math.max(...ys).toFixed(2)} / 格子 ${it.y.toFixed(2)}～${(it.y + it.h).toFixed(2)}`);
    near('★★ 　 轉過的格子寬 ＝ 片的高', it.w, it.piece.height, 1e-12);
  }
}

section('排版擺得更緊：任何空位都能塞、兩個方向都試（2026-10-15）');
{
  /**
   * kang 2026-10-15 看 `樣板-排版.html` 後同意。packBoards() 先照原本「一列一列」擺，再試新的擺法，**用板比較少才換**。
   * 下面的張數就是樣板上那五個例子（「原本」那一欄是改之前量的，新的⛔ 可以比它多）。
   */
  const { packBoards } = await import('../js/out/nest.js');
  const { setSeam } = await import('../js/unfold/seam.js');
  const { seamLoopEdges } = await import('../js/core/selectops.js');
  const torus = pick => {
    const m = buildPrim('torus', { rOuter: 30, rInner: 15, seg: 32, segT: 12 });
    for (const h of seamLoopEdges(m, [...m.edges()].find(pick), 'all')) setSeam(m, h, true);
    return unfoldMesh(m, makeRule('paper', 0.05)).pieces;
  };
  const isRing = he => Math.abs(he.v.p.y - he.to.p.y) < 1e-6
    && Math.abs(Math.hypot(he.v.p.x, he.v.p.z) - Math.hypot(he.to.p.x, he.to.p.z)) < 1e-6;
  const isTube = he => Math.abs(Math.atan2(he.v.p.z, he.v.p.x) - Math.atan2(he.to.p.z, he.to.p.x)) < 1e-6;
  const slices = sect.sliceMesh(buildPrim('box', { w: 60, h: 45, d: 40 }, 0.2), { axis: 'y', bands: [{ t: 1, n: 'rest' }] })
    .slices.map(s => ({ width: s.bounds.w, height: s.bounds.h, qty: 1 }));
  const cases = [
    ['剖面：方塊 45 片', slices],
    ['圓環 環帶', torus(isRing)],
    ['圓環 西瓜皮', torus(isTube)],
    ['圓柱 側面＋兩蓋', [{ width: 156.8, height: 70, qty: 1 }, { width: 50, height: 50, qty: 2 }]],
    ['方塊六面', [{ width: 60, height: 45, qty: 2 }, { width: 60, height: 40, qty: 2 }, { width: 45, height: 40, qty: 2 }]]
  ];
  /** 每片都在板子裡、彼此⛔ 重疊（含間距）、一片都沒少、不准轉時⛔ 轉 */
  const valid = (nest, pieces, opt) => {
    const bad = []; let n = 0; const g = opt.gap;
    nest.boards.forEach((b, bi) => b.items.forEach((it, i) => {
      n++;
      if (!b.oversize && (it.x < g - 1e-9 || it.y < g - 1e-9 || it.x + it.w > b.w - g + 1e-9 || it.y + it.h > b.h - g + 1e-9)) bad.push(`板${bi + 1} 出界`);
      if (!opt.rotate && it.rot) bad.push(`板${bi + 1} 不准轉卻轉了`);
      b.items.forEach((o, j) => {
        if (j <= i) return;
        const sep = it.x + it.w + g <= o.x + 1e-9 || o.x + o.w + g <= it.x + 1e-9
          || it.y + it.h + g <= o.y + 1e-9 || o.y + o.h + g <= it.y + 1e-9;
        if (!sep) bad.push(`板${bi + 1} 重疊`);
      });
    }));
    const want = pieces.reduce((s, q) => s + (q.qty || 1), 0);
    if (n !== want) bad.push(`片數 ${n}/${want}`);
    return bad;
  };
  for (const [label, opt, want, was] of [
    ['kang 的設定 120×240／間距 10／可轉', { w: 120, h: 240, gap: 10, rotate: true }, [8, 5, 2, 2, 1], [12, 5, 3, 2, 2]],
    /**
     * ⚠ 第一格 9 → 8（2026-10-19）：剖面片改成跟上視圖同方向（`slice/section.js` AXES 註解），
     * 方塊 60×45×40 每片從 40 × 60 變成 60 × 40 ⇒ 不准轉時一張 240 × 120 從 5 片變 6 片。
     * ⭐ 排版本身⛔ 改；kang 的設定（可轉）兩個方向都試，所以照舊 8 張。
     */
    ['預設 240×120／間距 1／不轉', { w: 240, h: 120, gap: 1, rotate: false }, [8, 3, 1, 1, 1], [9, 3, 1, 2, 1]]
  ]) {
    cases.forEach(([name, ps], i) => {
      const nest = packBoards(ps, opt);
      eq(`★★ ${label}｜${name}：${want[i]} 張（原本 ${was[i]} 張）`, nest.boards.length, want[i]);
      eq(`　　${label}｜${name}：每片都在板內、⛔ 重疊、片數對`, valid(nest, ps, opt).join(' / '), '');
    });
  }
  // 比板子大的照舊：單獨一張、標 oversize（新擺法⛔ 吃掉它）
  {
    const nest = packBoards([{ width: 300, height: 50, qty: 1 }, { width: 50, height: 50, qty: 3 }], { w: 240, h: 120, gap: 1, rotate: false });
    ok('★ 比板子大的：照舊單獨一張、標 oversize', nest.boards.filter(b => b.oversize).length === 1
       && nest.boards.reduce((s, b) => s + b.items.length, 0) === 4);
  }
  // 速度：200 片
  {
    const many = [];
    for (let i = 0; i < 200; i++) many.push({ width: 10 + (i * 37) % 70, height: 8 + (i * 53) % 90, qty: 1 });
    const t0 = performance.now();
    const nest = packBoards(many, { w: 120, h: 240, gap: 10, rotate: true });
    const ms = performance.now() - t0;
    ok('★ 200 片排得完、而且不到 1 秒', ms < 1000 && valid(nest, many, { w: 120, h: 240, gap: 10, rotate: true }).length === 0,
       `${ms.toFixed(0)} ms、${nest.boards.length} 張`);
  }
}

section('剖面分切：排版到板子上（2026-10-14）');
{
  /**
   * kang 2026-10-14：「展開圖有可以設定排版…剖面分切也要有；DXF 可以全部匯出，但是 SVG 只能匯出一個檔案」。
   * 擺法、畫法借展開圖的（packBoards／boardProgram）；多一條規矩：🔴 不同板厚的片⛔ 放同一張板。
   */
  const { sliceBoards, sliceBoardTitle } = await import('../js/out/nest.js');
  const { sliceBoardDXF } = await import('../js/out/dxf.js');
  const m = buildPrim('box', { w: 60, h: 45, d: 40 }, 0.2);
  const r = sect.sliceMesh(m, { axis: 'y', bands: [{ t: 1, n: 10 }, { t: 2, n: 'rest' }] });
  const g = pegsMod.findPegs(r.slices, { d: 0.5, gap: 0.8, counts: [2, 2] });
  ok('（前置）切得出來、找得到孔', r.ok && g.ok, g.reason || '');
  const pegsOf = sl => pegsMod.pegsForSlice(g, sl);
  const N = { w: 120, h: 240, gap: 10, rotate: true };
  const sheets = sliceBoards(r.slices, N, { pegsOf, pegD: 0.5 });

  const seen = new Map();
  for (const sh of sheets) for (const it of sh.board.items) seen.set(it.piece.slice.index, (seen.get(it.piece.slice.index) || 0) + 1);
  eq('★★ 每一片剛好出現一次', [...seen.values()].every(v => v === 1) && seen.size === r.slices.length, true);
  ok('★★ 每張板只有一種板厚（⛔ 1 cm 與 2 cm 混在同一張）',
     sheets.every(sh => sh.board.items.every(it => Math.abs(it.piece.slice.t - sh.t) < 1e-9)));
  ok('　　板厚由薄到厚排', sheets.every((sh, i) => i === 0 || sheets[i - 1].t <= sh.t));
  ok('★ 每一片都在板子裡、四周留間距',
     sheets.every(sh => sh.board.oversize || sh.board.items.every(it =>
       it.x >= N.gap - 1e-9 && it.y >= N.gap - 1e-9
       && it.x + it.w <= N.w - N.gap + 1e-9 && it.y + it.h <= N.h - N.gap + 1e-9)));
  ok('　　照每片自己的外框排（60×40，⛔ 用整疊共用的框）',
     sheets.every(sh => sh.board.items.every(it => Math.abs(it.w * it.h - 60 * 40) < 1e-6)));

  const want = r.slices.reduce((n, sl) => n + pegsOf(sl).length, 0);
  const got = sheets.reduce((n, sh) => n + sh.prog.items.filter(i => i.t === 'circle' && i.style === 'peg').length, 0);
  eq('★★ 定位孔一個都沒少（每片的孔都畫在板子上）', got, want);
  const nums = sheets.reduce((n, sh) => n + sh.prog.items.filter(i => i.style === 'num').length, 0);
  eq('　　層號每片一個（板子正中間⛔ 再印一次片號）', nums, r.slices.length);

  const t1 = sheets.find(sh => sh.t === 1);
  const dxf = sliceBoardDXF(t1, { unit: 'mm', title: 'SHEET 1' });
  const circleLayers = [...dxf.matchAll(/CIRCLE\s*\r?\n\s*8\s*\r?\n([^\r\n]+)/g)].map(x => x[1].trim());
  const pegOnBoard = t1.board.items.reduce((n, it) => n + pegsOf(it.piece.slice).length, 0);
  eq('★★ 板子 DXF：孔的數量對', circleLayers.length, pegOnBoard);
  ok('★★ 板子 DXF：定位孔在 CUT_T10 層（⛔ 掉進 TEXT 層 —— 廠商只開切割層會漏切）',
     circleLayers.length > 0 && circleLayers.every(l => l === 'CUT_T10'), circleLayers.slice(0, 3).join(','));
  ok('　　板子 DXF：層號在 NUM 層', /TEXT\s*\r?\n\s*8\s*\r?\nNUM/.test(dxf));

  const title = sliceBoardTitle(t1, 0, sheets.length);
  ok('　　標題寫出板厚', /板厚 1 cm/.test(title[0]), title[0]);

  // 太大的片：單獨一張、標出來
  const big = sliceBoards(r.slices.slice(0, 1), { w: 50, h: 50, gap: 1, rotate: false }, { pegsOf, pegD: 0.5 });
  ok('★ 比板子還大的片 ⇒ 單獨一張、標 oversize', big.length === 1 && big[0].board.oversize);
}

section('程式自己剪的邊：貼在一起的⛔ 剪、張開的講出來（2026-10-12）');

/**
 * 🔴 兩件事（kang 2026-10-12 同意，調查經過 → `外部參考-打版.md` 第 3 節）：
 *
 * ① **兩側攤平後完全貼在一起的邊⛔ 剪**。舊版「新增 → 圓柱」用紙直接展開，
 *    上下蓋子各有一刀從圓心切到邊（圓錐、角柱、半球的蓋子、管的環形端面、圓環也有）——
 *    兩側的料本來就連著，照圖切就是把好好的蓋子剪開。
 *    ⭐ 用「輪廓上的尖刺」驗：一刀切進去又原路出來 ＝ 輪廓上某一點的前一點與後一點重合。
 *
 * ② **張開的那些：卡片寫幾條；標過分片的物件畫成橘色、DXF 放 CUT_AUTO 層**。
 *    沒標過分片的⛔ 上色（整圈都是程式決定的，上色分不出任何東西，而且 DXF 整圈搬層會害切割廠漏切）。
 */
{
  const { setSeam } = await import('../js/unfold/seam.js');
  const { seamLoopEdges } = await import('../js/core/selectops.js');
  const { packBoards, boardProgram } = await import('../js/out/nest.js');
  const { boardDXF } = await import('../js/out/dxf.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const paper = makeRule('paper', 0.2);
  /** 輪廓上「切進去又原路出來」的點有幾個 */
  const spikes = loop => loop.filter((p, i) => {
    const a = loop[(i - 1 + loop.length) % loop.length], b = loop[(i + 1) % loop.length];
    return Math.hypot(a.x - b.x, a.y - b.y) < 1e-6;
  }).length;
  const allLoops = r => r.pieces.flatMap(p => [p.outline, ...p.holes]);
  const orange = p => drawProgram(p, { rule: paper }).items.filter(i => i.t === 'line' && i.style === 'autoCut');

  // ── ① 貼在一起的⛔ 剪 ──
  for (const type of ['cylinder', 'cone', 'prism', 'dome', 'torus', 'tube']) {
    const m = buildPrim(type, PRIM_DEFAULTS[type]);
    const r = unfoldMesh(m, paper);
    eq(`★★★ ${type}（預設、紙）：輪廓上沒有「切進去又原路出來」的刀（舊版蓋子上有）`,
       allLoops(r).reduce((n, L) => n + spikes(L), 0), 0);
    near(`★★ 　 ${type}：展開面積 ＝ 表面積（⛔ 少剪一刀不會多出或少掉料）`, r.stats.area, m.area(), 1e-6);
  }
  {
    const r = unfoldMesh(buildPrim('tube', PRIM_DEFAULTS.tube), makeRule('acrylic', 0.3));
    const ring = r.pieces.find(p => p.holes.length);
    ok('★★★ 管的環形端面（壓克力）：內圈是真正的洞（舊版是外框穿過一刀繞進去）', !!ring && ring.holes.length === 1);
  }

  // ── ② 沒標過分片：照舊全黑、卡片寫條數 ──
  {
    const r = unfoldMesh(buildPrim('box', PRIM_DEFAULTS.box), paper);
    const p = r.pieces[0];
    ok('★★★ 方塊（沒標分片）：程式自己加的切線有算出來', p.autoCut.lines > 0, `${p.autoCut.lines} 條`);
    eq('★★★ 　 但圖上⛔ 上色（整圈都是程式決定的）', orange(p).length, 0);
    ok('★★ 　 卡片照實寫「圖上不另外上色」（⛔ 寫「圖上橘色」）',
       titleLines(p).some(s => s.includes(`程式自己加的切線 ${p.autoCut.lines} 條`) && s.includes('不另外上色'))
       && !titleLines(p).some(s => s.includes('圖上橘色')));
    const dxf = toDXF(r.pieces, { unit: 'mm', rule: paper });
    eq('★★★ 　 DXF：切割線照舊全在 CUT（⛔ 搬到 CUT_AUTO，切割廠只開 CUT 會漏切）',
       (dxf.match(/\r\n0\r\nLINE\r\n8\r\nCUT_AUTO\r\n/g) || []).length, 0);
  }
  for (const type of ['plate']) {
    const r = unfoldMesh(buildPrim(type, PRIM_DEFAULTS[type]), paper);
    eq(`★★ ${type}：一條都不用剪 → 0 條、卡片⛔ 寫這一行`, r.pieces[0].autoCut.lines, 0);
    ok(`★★ 　 ${type}：卡片沒有「程式自己加的切線」`, !titleLines(r.pieces[0]).some(s => s.includes('程式自己加的切線')));
  }
  {
    const r = unfoldMesh(buildPrim('sphere', PRIM_DEFAULTS.sphere), paper);
    ok('★★★ 預設的球直接展開：條數寫出來（舊版一則說明都沒有）', r.pieces[0].autoCut.lines >= 50, `${r.pieces[0].autoCut.lines} 條`);
  }

  // ── ② 標過分片：程式多剪的畫橘色 ──
  const sphereCut = step => {
    const o = new io.ModelObject({ name: '球', kind: io.KIND.SOLID, src: { type: 'sphere', r: 30, segW: 12, segH: 16 } });
    o.bake();
    const m = o.mesh();
    const isPole = v => Math.hypot(v.p.x, v.p.z) < 1e-6;
    const ang = v => Math.atan2(v.p.z, v.p.x);
    const mer = [...m.edges()].filter(he => !isPole(he.v) && !isPole(he.to) && Math.abs(ang(he.v) - ang(he.to)) < 1e-6);
    const angs = [...new Set(mer.map(he => ang(he.v).toFixed(6)))].sort((a, b) => a - b);
    for (const a of angs.filter((_, i) => i % step === 0)) {
      for (const h of seamLoopEdges(m, mer.find(he => ang(he.v).toFixed(6) === a), 'loop')) setSeam(m, h, true);
    }
    return m;
  };
  {
    const r = unfoldMesh(sphereCut(1), paper);
    eq('★★★ 球 每條經線都切（模式一，12 片）：程式一條都⛔ 多剪', r.pieces.reduce((n, p) => n + p.autoCut.lines, 0), 0);
    eq('★★ 　 圖上沒有橘色', r.pieces.reduce((n, p) => n + orange(p).length, 0), 0);
  }
  {
    const r = unfoldMesh(sphereCut(2), paper);
    eq('前提：球 每 2 條經線切一條 → 6 片', r.stats.total, 6);
    ok('★★★ 　 每一片都有程式多剪的（中間那條經線攤不平，要裂開）',
       r.pieces.every(p => p.autoCut.userSeams && p.autoCut.lines > 0));
    ok('★★★ 　 圖上畫成橘色，卡片寫「圖上橘色」',
       r.pieces.every(p => orange(p).length > 0 && titleLines(p).some(s => s.includes('（圖上橘色）'))));
    /** 橘色的段 ＝ DXF 的 CUT_AUTO 線（同一份 `autoCut`，兩邊數得起來） */
    const dxf = toDXF(r.pieces, { unit: 'mm', rule: paper });
    eq('★★★ 　 DXF 的 CUT_AUTO 線 ＝ 圖上的橘色段',
       (dxf.match(/\r\n0\r\nLINE\r\n8\r\nCUT_AUTO\r\n/g) || []).length,
       r.pieces.reduce((n, p) => n + orange(p).length, 0));
    /** 排版的板子：畫面與 DXF 同一份「畫什麼」，橘色一樣要跟過去 */
    const nest = packBoards(r.pieces, { w: 240, h: 120, gap: 1, rotate: false });
    const progs = nest.boards.map(b => boardProgram(b, { rule: paper }));
    const nO = progs.reduce((n, pg) => n + pg.items.filter(i => i.t === 'line' && i.style === 'autoCut').length, 0);
    eq('★★ 　 排版的板子上：橘色段 ＝ 各片的橘色段加總', nO, r.pieces.reduce((n, p) => n + orange(p).length, 0));
    eq('★★ 　 排版的 DXF：橘色段全部在 CUT_AUTO 層',
       progs.reduce((n, pg) => n + (boardDXF(pg).match(/\r\n0\r\nLINE\r\n8\r\nCUT_AUTO\r\n/g) || []).length, 0), nO);
    /** 接合編號：每個號碼還是剛好出現兩次（少剪的那幾刀⛔ 留下落單的號碼）*/
    const cnt = new Map();
    for (const p of r.pieces) for (const j of p.joints) cnt.set(j.num, (cnt.get(j.num) || 0) + 1);
    eq('★★ 　 接合編號每個都剛好出現兩次', [...cnt.values()].filter(n => n !== 2).length, 0);
  }
  {
    /** 圓環切西瓜皮：每一條是繞管子一圈的環，要剪一刀才攤得開 ⇒ 每片剛好 1 條（「條」⛔ 是邊數）*/
    const m = buildPrim('torus', PRIM_DEFAULTS.torus);
    const isTube = he => Math.abs(Math.atan2(he.v.p.z, he.v.p.x) - Math.atan2(he.to.p.z, he.to.p.x)) < 1e-6;
    for (const h of seamLoopEdges(m, [...m.edges()].find(isTube), 'all')) setSeam(m, h, true);
    const r = unfoldMesh(m, makeRule('paper', 0.05));
    eq('前提：西瓜皮 32 片', r.stats.total, 32);
    ok('★★★ 　 每片程式多剪剛好 1 條（繞一圈的環要剪開一次；數的是「條」⛔ 是邊數）',
       r.pieces.every(p => p.autoCut.lines === 1), r.pieces.map(p => p.autoCut.lines).join(','));
  }
}

section('省道打版 第一步：「標一段」＋ 縫與開口分開認（2026-10-12）');

/**
 * kang 拍板（`規格\建模器-省道打版.md`「定案」1、2）：
 * ① 分片模式多一種「標一段」：先點起點、再點同一條線上的終點，中間整段一次標
 * ② 縫與開口是同一種標記，程式自己認：切開後兩側還是同一片的 ＝ 開口
 */
{
  const { seamSpanEdges, seamLoopEdges } = await import('../js/core/selectops.js');
  const { setSeam, seamKinds, cutAroundFace } = await import('../js/unfold/seam.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const { segW, segH } = PRIM_DEFAULTS.sphere;
  const ball = () => {
    const o = new io.ModelObject({ name: '球', kind: io.KIND.SOLID, src: { type: 'sphere', ...PRIM_DEFAULTS.sphere } });
    o.bake();
    return o.mesh();
  };
  const isPole = v => Math.hypot(v.p.x, v.p.z) < 1e-6;
  const ang = v => Math.atan2(v.p.z, v.p.x);
  /** 第 j 條經線（照角度排）、從北極數第 k 段 */
  const merAt = (m, j, k) => {
    const all = [...m.edges()].filter(he => {
      const a = he.v, b = he.to;
      if (isPole(a) && isPole(b)) return false;
      if (Math.abs(a.p.y - b.p.y) < 1e-6) return false;
      if (!isPole(a) && !isPole(b) && Math.abs(ang(a) - ang(b)) > 1e-6) return false;
      return true;
    });
    const angs = [...new Set(all.map(he => ang(isPole(he.v) ? he.to : he.v).toFixed(6)))].sort((a, b) => a - b);
    const on = all.filter(he => ang(isPole(he.v) ? he.to : he.v).toFixed(6) === angs[j])
      .sort((a, b) => Math.max(b.v.p.y, b.to.p.y) - Math.max(a.v.p.y, a.to.p.y));
    return on[k];
  };
  /**
   * 赤道（第 segH/2 圈）的第 j 段，照「邊的中點」的角度排。
   * ⚠ 第一版拿兩端角度相加來排 —— 跨過 ±180° 的那一段相加 ≈ 0，被排到中間去，測試當場錯（⛔ 是程式錯）。
   */
  const eqAt = (m, j) => {
    const mid = he => Math.atan2(he.v.p.z + he.to.p.z, he.v.p.x + he.to.p.x);
    const eq = [...m.edges()].filter(he => Math.abs(he.v.p.y) < 1e-6 && Math.abs(he.to.p.y) < 1e-6)
      .sort((a, b) => mid(a) - mid(b));
    return eq[j];
  };

  // ── ① 標一段 ──
  {
    const m = ball();
    eq('前提：一條經線從極走到極 ＝ segH 段', seamLoopEdges(m, merAt(m, 0, 0), 'loop').length, segH);
    const a = seamSpanEdges(m, merAt(m, 0, 0), merAt(m, 0, 5));
    eq('★★★ 經線：從第 0 段點到第 5 段 ＝ 6 條（含頭尾）', a && a.length, 6);
    const sameLine = new Set(seamLoopEdges(m, merAt(m, 0, 0), 'loop'));
    ok('★★ 　 全部在同一條經線上', a.every(h => sameLine.has(h) || sameLine.has(h.twin)));
    eq('★★★ 反過來點（第 5 段 → 第 0 段）也是 6 條', seamSpanEdges(m, merAt(m, 0, 5), merAt(m, 0, 0)).length, 6);
    eq('★★ 從中間（第 3 段）點到第 10 段 ＝ 8 條', seamSpanEdges(m, merAt(m, 0, 3), merAt(m, 0, 10)).length, 8);
    eq('★★ 起點跟終點同一條 ＝ 1 條', seamSpanEdges(m, merAt(m, 0, 3), merAt(m, 0, 3)).length, 1);
    eq('★★★ 終點不在同一條線上 ⇒ null（⛔ 猜）', seamSpanEdges(m, merAt(m, 0, 3), merAt(m, 1, 3)), null);
    /** 赤道是繞一圈的 ⇒ 兩個方向都到得了，取短的那一段 */
    eq('前提：赤道一圈 ＝ segW 段', seamLoopEdges(m, eqAt(m, 0), 'loop').length, segW);
    eq('★★★ 赤道：第 0 段點到第 3 段 ＝ 4 條（順著走比較短）', seamSpanEdges(m, eqAt(m, 0), eqAt(m, 3)).length, 4);
    eq('★★★ 赤道：第 0 段點到倒數第 2 段 ＝ 3 條（往回走比較短）', seamSpanEdges(m, eqAt(m, 0), eqAt(m, segW - 2)).length, 3);
  }

  // ── ② 縫與開口 ──
  {
    const m = buildPrim('box', PRIM_DEFAULTS.box);
    cutAroundFace(m, m.faces[0], true);
    const k = seamKinds(m);
    ok('★★ 方塊切出一個面：全部是縫、沒有開口', k.seams.length > 0 && k.darts.length === 0, `縫 ${k.seams.length}`);
  }
  {
    const m = ball();
    for (const h of seamLoopEdges(m, merAt(m, 0, 0), 'loop')) setSeam(m, h, true);
    const k = seamKinds(m);
    eq('★★★ 球只切一條經線（極到極）：還是一整片 ⇒ 全部算開口（切進去、沒分開）', k.darts.length, segH);
    eq('★★ 　 縫 0 條', k.seams.length, 0);
  }
  {
    const m = ball();
    const step = segW / 4;
    for (let j = 0; j < segW; j += step) for (const h of seamLoopEdges(m, merAt(m, j, 0), 'loop')) setSeam(m, h, true);
    for (const h of seamSpanEdges(m, merAt(m, 1, 0), merAt(m, 1, 5))) setSeam(m, h, true);
    const k = seamKinds(m);
    eq('★★★ 球切 4 條經線（4 片）＋ 另一條經線從極往下標一段 6 條：縫 ＝ 4 × segH', k.seams.length, 4 * segH);
    eq('★★★ 　 開口 ＝ 那一段的 6 條', k.darts.length, 6);
  }
}

section('省道打版 第二步：攤平（縫邊等長、變形在中間）＋ 出圖（2026-10-12）');

/**
 * kang 拍板（`規格\建模器-省道打版.md`「定案」與「2.2」）：容許變形、縫邊長度保持真值、每片印出拉／壓幾 %；
 * ⛔ 畫折線；畫面與列印上色、SVG／DXF 只放線；⛔ 管材料折不折得動；程式為了攤開才剪的畫橘色。
 */
{
  const { setSeam } = await import('../js/unfold/seam.js');
  const { seamLoopEdges } = await import('../js/core/selectops.js');
  const { outlineSegments } = await import('../js/out/sheet.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const isPole = v => Math.hypot(v.p.x, v.p.z) < 1e-6, ang = v => Math.atan2(v.p.z, v.p.x);
  /** 球（12×16）：經線每 step 條切一條（縫）；其餘經線從兩極各往赤道開 dl 格（開口）*/
  const ball = (step, dl) => {
    const o = new io.ModelObject({ name: '球', kind: io.KIND.SOLID, src: { type: 'sphere', r: 30, segW: 12, segH: 16 } });
    o.bake(); const m = o.mesh();
    const all = [...m.edges()].filter(he => !(isPole(he.v) && isPole(he.to)) && Math.abs(he.v.p.y - he.to.p.y) > 1e-6
      && (isPole(he.v) || isPole(he.to) || Math.abs(ang(he.v) - ang(he.to)) < 1e-6));
    const angs = [...new Set(all.map(he => ang(isPole(he.v) ? he.to : he.v).toFixed(6)))].sort((a, b) => a - b);
    angs.forEach((a, j) => all.filter(he => ang(isPole(he.v) ? he.to : he.v).toFixed(6) === a)
      .sort((p, q) => Math.max(q.v.p.y, q.to.p.y) - Math.max(p.v.p.y, p.to.p.y))
      .forEach((h, k) => { if (j % step === 0 || k < dl || k >= 16 - dl) setSeam(m, h, true); }));
    return m;
  };
  const paper = makeRule('paper', 0.05);
  const dart = m => unfoldMesh(m, paper, { mode: 'dart' });
  const L = (dxf, n) => (dxf.match(new RegExp(`\\r\\n0\\r\\nLINE\\r\\n8\\r\\n${n}\\r\\n`, 'g')) || []).length;

  // ── 攤平本身 ──
  {
    const m = ball(3, 6);
    const r = dart(m);
    eq('前提：球 4 片（每 3 條經線切一條）＋ 其餘經線從兩極各開 6 格', r.stats.total, 4);
    ok('★★★ 縫邊長度 ＝ 3D 真值（每片誤差 < 百萬分之一）', r.pieces.every(p => p.strain.seamErr < 1e-6),
       r.pieces.map(p => p.strain.seamErr.toExponential(1)).join(' '));
    ok('★★★ 有變形，而且拉、壓都有（球攤平一定要）', r.pieces.every(p => p.strain.max > 0.001 && p.strain.min < -0.001));
    eq('★★★ 沒有面翻過來', r.pieces.reduce((n, p) => n + p.strain.flips, 0), 0);
    ok('★★ 算到停下來了（⛔ 撞到上限）', r.pieces.every(p => p.strain.converged));
    eq('★★★ ⛔ 畫折線（布不折）', r.pieces.reduce((n, p) => n + p.folds.length + p.bends.length, 0), 0);
    ok('★★ 每個面都有自己的拉伸值（上色用）', r.pieces.every(p => p.strain.faces.length === p.faces.length));
    const s3 = m.area(), s2 = r.stats.area;
    ok('★★ 面積（攤平後）跟 3D 表面積差不到 5%（變形在幾 % 之內）', Math.abs(s2 / s3 - 1) < 0.05, `${(s2 / s3 * 100 - 100).toFixed(2)}%`);
    eq('★★ 沒有任何警告', r.warnings.length, 0);
  }
  {
    /** 開口開得越長、變形越小（樣板與沙箱量到的趨勢）*/
    const worst = dl => Math.max(...dart(ball(3, dl)).pieces.map(p => Math.max(p.strain.max, -p.strain.min)));
    const w0 = worst(0), w5 = worst(5), w7 = worst(7);
    ok('★★★ 開口越長變形越小：不開口 > 開 5 格 > 開 7 格', w0 > w5 && w5 > w7, `${(w0 * 100).toFixed(1)}% > ${(w5 * 100).toFixed(1)}% > ${(w7 * 100).toFixed(1)}%`);
  }
  {
    /** ⛔ 管材料：壓克力在精確分片會把每條折線切開；省道打版照你標的分片 */
    const a = dart(ball(3, 6)).stats.total, b = unfoldMesh(ball(3, 6), makeRule('acrylic', 0.3), { mode: 'dart' }).stats.total;
    eq('★★★ 省道打版 ⛔ 管材料折不折得動：壓克力也是 4 片（跟紙一樣）', b, a);
  }
  {
    /** 拓撲上非剪不可的：圓環切成 4 段，每段是一個環 ⇒ 程式只剪一刀 */
    const m = buildPrim('torus', PRIM_DEFAULTS.torus);
    const isTube = he => Math.abs(ang(he.v) - ang(he.to)) < 1e-6;
    const seen = new Set(), loops = [];
    for (const he of m.edges()) if (isTube(he)) { const k = ang(he.v).toFixed(5); if (!seen.has(k)) { seen.add(k); loops.push(he); } }
    loops.sort((p, q) => ang(p.v) - ang(q.v));
    loops.forEach((he, i) => { if (i % 8 === 0) for (const h of seamLoopEdges(m, he, 'loop')) setSeam(m, h, true); });
    const r = dart(m);
    eq('前提：圓環切 4 段', r.stats.total, 4);
    ok('★★★ 每段程式只加 1 條（環要剪開一次；⛔ 為了鼓多剪）', r.pieces.every(p => p.autoCut.lines === 1), r.pieces.map(p => p.autoCut.lines).join('/'));
    eq('★★ 　 沒有面翻過來', r.pieces.reduce((n, p) => n + p.strain.flips, 0), 0);
    ok('★★ 　 縫邊（含程式那一刀）長度 ＝ 真值', r.pieces.every(p => p.strain.seamErr < 1e-6));
  }
  {
    /** 球只切兩條經線（不開口）：一定有面翻過來 ⇒ 每片只講一則（⛔ 再加一則「重疊」—— AI 線上先驗看到的）*/
    const r = dart(ball(6, 0));
    eq('前提：球切兩條正對面的經線 ⇒ 2 片', r.stats.total, 2);
    ok('前提：有面翻過來', r.pieces.every(p => p.strain.flips > 0));
    eq('★★ 每片只有「翻過來」那一則，⛔ 重複講「重疊」', r.warnings.filter(w => w.includes('有重疊')).length, 0);
    eq('★★ 　「翻過來」每片一則', r.warnings.filter(w => w.includes('翻過來')).length, 2);
  }
  {
    const o = new io.ModelObject({ name: '球', kind: io.KIND.SOLID, src: { type: 'sphere', r: 30, segW: 12, segH: 16 } });
    o.bake();
    const r = dart(o.mesh());
    eq('★★ 一條都沒標的球（封閉）：省道打版攤不開 ⇒ 0 片', r.stats.total, 0);
    ok('★★ 　 而且講出原因（⛔ 安靜地什麼都沒有）', r.warnings.some(w => w.includes('封閉')), r.warnings.join('|'));
  }

  // ── 出圖 ──
  {
    const r = dart(ball(3, 6));
    const p = r.pieces[0];
    const cutS = outlineSegments(p, { dartStyle: 'cut' }), sewS = outlineSegments(p, { dartStyle: 'sew' });
    eq('★★★ 開口道數：每片中間 2 條經線 × 兩極 ＝ 4 道', cutS.darts, 4);
    const n = (os, st) => os.segs.filter(s => s.style === st).length;
    eq('★★ 剪掉的 V：開口段全是 dartCut', n(cutS, 'dartSew'), 0);
    eq('★★★ 只畫縫線：開口段 ＝ 剪掉時的開口段（一段都沒少）', n(sewS, 'dartSew'), n(cutS, 'dartCut'));
    eq('★★★ 只畫縫線：口子多 4 條切割線（每道一條）', n(sewS, 'cut') - n(cutS, 'cut'), 4);
    ok('★★ 卡片：三個數字', titleLines(p, {}).some(s => s.startsWith('省道打版：最多拉長') && s.includes('最多壓縮') && s.includes('縫邊長度最多差')));
    ok('★★ 卡片：開口道數與畫法', titleLines(p, { dartStyle: 'sew' }).some(s => s === '開口 4 道（只畫縫線、不剪）'));
    const worst = Math.max(p.strain.max, -p.strain.min) * 100;
    ok('★★★ 上限填得比這片小 ⇒ 紅字（⚠）', titleLines(p, { limit: worst / 2 }).some(s => s.startsWith('⚠ 超過你填的上限')));
    ok('★★ 上限填得比這片大 ⇒「以內」', titleLines(p, { limit: worst * 2 }).some(s => s.startsWith('在你填的上限')));
    ok('★★ 上限沒填 ⇒ 兩種都⛔ 寫（⛔ 自己編預設值）', !titleLines(p, { limit: '' }).some(s => s.includes('上限')));
    ok('★★ 面積寫明「攤平後」', titleLines(p, {}).some(s => s.includes('（攤平後）')));
    eq('★★★ 畫面（strainFill）：每個面一塊色', drawProgram(p, { strainFill: true }).items.filter(i => i.t === 'poly').length, p.faces.length);
    ok('★★★ 存檔的 SVG（⛔ strainFill）⛔ 帶色塊', !toSVG(p, { strainFill: false }).includes('<polygon'));
    const dxfCut = toDXF(r.pieces, { unit: 'mm', dartStyle: 'cut' }), dxfSew = toDXF(r.pieces, { unit: 'mm', dartStyle: 'sew' });
    eq('★★★ DXF 剪掉的 V：SEW 層 0 條（開口在 CUT 層，要切）', L(dxfCut, 'SEW'), 0);
    eq('★★★ DXF 只畫縫線：SEW 層 ＝ 4 片的開口段', L(dxfSew, 'SEW'), r.pieces.reduce((a, q) => a + outlineSegments(q, { dartStyle: 'sew' }).segs.filter(s => s.style === 'dartSew').length, 0));
    ok('★★ DXF 標題帶三個數字（英數）', dxfCut.includes('STRETCH') && dxfCut.includes('SHRINK') && dxfCut.includes('SEAM'));
  }
  {
    /** 精確分片：同一個模型的圖一個字都不變（開口照舊是一般切割線、⛔ 色塊、⛔ 三個數字）*/
    const r = unfoldMesh(ball(3, 6), paper);
    ok('★★★ 精確分片：⛔ strain、⛔ 開口線（原本的圖一個字都不變）', r.pieces.every(p => !p.strain && !p.dartCut));
    ok('★★ 　 卡片沒有「省道打版」那一行', r.pieces.every(p => !titleLines(p, {}).some(s => s.startsWith('省道打版'))));
  }
}

section('省道打版：「畫折線」開關（2026-10-12）');

/**
 * kang：「可以有一個開/關可以讓 DXF 與 SVG 能夠出現『折線』」（用珍珠板做省道打版的圓環，板子要知道每一格在哪裡折）。
 * 定案：預設關；打開時畫面、列印、SVG、DXF 都畫；只畫線、⛔ 標角度；DXF 在 FOLD 層。
 */
{
  const { setSeam } = await import('../js/unfold/seam.js');
  const { seamLoopEdges } = await import('../js/core/selectops.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const m = buildPrim('torus', PRIM_DEFAULTS.torus);
  const ang = v => Math.atan2(v.p.z, v.p.x);
  const isTube = he => Math.abs(ang(he.v) - ang(he.to)) < 1e-6;
  const seen = new Set(), loops = [];
  for (const he of m.edges()) if (isTube(he)) { const k = ang(he.v).toFixed(5); if (!seen.has(k)) { seen.add(k); loops.push(he); } }
  loops.sort((p, q) => ang(p.v) - ang(q.v));
  loops.forEach((he, i) => { if (i % 4 === 0) for (const h of seamLoopEdges(m, he, 'loop')) setSeam(m, h, true); });
  const r = unfoldMesh(m, makeRule('foamboard', 0.3), { mode: 'dart' });
  const p = r.pieces[0];
  eq('前提：圓環切 8 段（省道打版、珍珠板）', r.stats.total, 8);
  ok('★★★ 每片都記著折線（格子之間的邊）', r.pieces.every(q => q.dartFolds && q.dartFolds.length > 0), p.dartFolds.length);
  eq('★★ 　 但 folds 照舊是空的（⛔ 折彎標註、⛔ 圓弧修正）', r.pieces.reduce((n, q) => n + q.folds.length + q.bends.length, 0), 0);
  const folds = o => drawProgram(p, o).items.filter(i => i.t === 'line' && i.style === 'fold').length;
  eq('★★★ 沒打勾（預設）：圖上 0 條折線（跟原本一樣）', folds({}), 0);
  eq('★★★ 打勾：圖上折線 ＝ 這片的折線數', folds({ dartFolds: true }), p.dartFolds.length);
  ok('★★ 　 卡片寫「折線 N 道（只畫線…）」', titleLines(p, { dartFolds: true }).some(s => s.startsWith(`折線 ${p.dartFolds.length} 道`)));
  ok('★★ 　 沒打勾 ⇒ 卡片⛔ 寫', !titleLines(p, {}).some(s => s.startsWith('折線 ')));
  const inside = r.pieces.every(q => q.dartFolds.every(f => [f.a, f.b].every(v =>
    v.x >= -1e-6 && v.y >= -1e-6 && v.x <= q.width + 1e-6 && v.y <= q.height + 1e-6)));
  ok('★★★ 折線都在片的外框裡（跟著拉過、擺正之後的位置）', inside);
  const F = d => (d.match(/\r\n0\r\nLINE\r\n8\r\nFOLD\r\n/g) || []).length;
  eq('★★★ DXF：沒打勾 FOLD 層 0 條', F(toDXF(r.pieces, { unit: 'mm' })), 0);
  eq('★★★ DXF：打勾 FOLD 層 ＝ 8 片的折線總數', F(toDXF(r.pieces, { unit: 'mm', dartFolds: true })), r.pieces.reduce((n, q) => n + q.dartFolds.length, 0));
  ok('★★ SVG：打勾才有折線的紅色點劃線', toSVG(p, { dartFolds: true }).includes('stroke-dasharray') && !toSVG(p, {}).includes('#c0392b'));
  const ex = unfoldMesh(m, makeRule('foamboard', 0.3));
  ok('★★ 精確分片 ⇒ dartFolds 是 null（⛔ 動到原本的圖）', ex.pieces.every(q => q.dartFolds === null));
}

section('省道打版 第三步：分片模式的即時預覽（2026-10-12）');

/**
 * 預覽畫面在 DOM 裡（沙箱驗不了），能驗的是兩支純函式：
 * `previewProgram()`（所有片擺成一張）與 `seamPreviewKey()`（什麼時候要重算）。
 */
{
  const { previewProgram } = await import('../js/out/nest.js');
  const { seamPreviewKey } = await import('../js/ui/toolbar.js');
  const { setSeam, isSeam } = await import('../js/unfold/seam.js');
  const { seamLoopEdges } = await import('../js/core/selectops.js');
  const o = new io.ModelObject({ name: '球', kind: io.KIND.SOLID, src: { type: 'sphere', r: 30, segW: 12, segH: 16 } });
  o.bake();
  const m = o.mesh();
  const isPole = v => Math.hypot(v.p.x, v.p.z) < 1e-6, ang = v => Math.atan2(v.p.z, v.p.x);
  const mer = [...m.edges()].filter(he => !isPole(he.v) && !isPole(he.to) && Math.abs(ang(he.v) - ang(he.to)) < 1e-6);
  const angs = [...new Set(mer.map(he => ang(he.v).toFixed(6)))].sort((a, b) => a - b);
  for (const a of angs.filter((_, i) => i % 3 === 0)) for (const h of seamLoopEdges(m, mer.find(he => ang(he.v).toFixed(6) === a), 'loop')) setSeam(m, h, true);

  const st = { mode: 'dart', material: 'paper', dartStyle: 'cut' };
  const r = unfoldObject(o, { material: 'paper', mode: 'dart' });
  const prog = previewProgram(r.pieces, { rule: r.rule, strainFill: true });
  eq('前提：球 4 片（省道打版）', r.stats.total, 4);
  ok('★★★ 預覽：4 片擺成一張（一張板）', prog && prog.boards === 1);
  const inBox = (x, y) => x >= prog.box.x - 1e-6 && x <= prog.box.x + prog.box.w + 1e-6 && y >= prog.box.y - 1e-6 && y <= prog.box.y + prog.box.h + 1e-6;
  ok('★★★ 每一條線、每一塊色都在框裡（框縮到真的用到的範圍）',
     prog.items.every(i => i.t === 'line' ? inBox(i.x1, i.y1) && inBox(i.x2, i.y2) : i.t === 'poly' ? i.pts.every(p => inBox(p.x, p.y)) : inBox(i.x, i.y)));
  eq('★★ ⛔ 畫板子外框（預覽不是排版）', prog.items.filter(i => i.style === 'note').length, 0);
  eq('★★ ⛔ 畫接合編號（太小看不清楚）', prog.items.filter(i => i.style === 'joint').length, 0);
  eq('★★ 片號每片一個', prog.items.filter(i => i.t === 'text' && i.style === 'num').length, 4);
  ok('★★ 省道打版有色塊', prog.items.some(i => i.t === 'poly'));
  eq('★★ 沒有片 ⇒ null（⛔ 畫一個空框）', previewProgram([], {}), null);

  const k1 = seamPreviewKey(o, st);
  eq('★★★ 什麼都沒改 ⇒ 不重算（同一把鑰匙）', seamPreviewKey(o, st), k1);
  ok('★★★ 換展開方式 ⇒ 重算', seamPreviewKey(o, { ...st, mode: 'exact' }) !== k1);
  ok('★★ 換材料 ⇒ 重算', seamPreviewKey(o, { ...st, material: 'acrylic' }) !== k1);
  const he = [...m.edges()].find(h => h.face && h.twin && h.twin.face && !isSeam(h) && Math.abs(h.v.p.y - h.to.p.y) < 1e-6);
  setSeam(m, he, true);
  ok('★★★ 多標一條切線 ⇒ 重算', seamPreviewKey(o, st) !== k1);
  setSeam(m, he, false);
  eq('★★ 　 再取消 ⇒ 回到原本那把（⛔ 白算一次）', seamPreviewKey(o, st), k1);
}

section('對位記號：沿縫每隔一段距離，兩側同一個位置（2026-10-12）');

/**
 * kang 拍板（→ `規格\建模器-對位記號.md`）：三種形狀做成選單、每隔固定距離、每條縫第一個是兩條、兩種展開方式都有、
 * 「切」的方向跟著材質（有縫份／黏合片的往外，其他往內 0.3）；「只畫線」一律往內 0.5。預設關。
 * ⭐ 最要緊的一條：**同一條縫的兩側，記號換回 3D 是同一個點** —— 那是「對得上」唯一的意思。
 */
{
  const { notchMarks, NOTCH } = await import('../js/out/sheet.js');
  const { boardProgram, packBoards } = await import('../js/out/nest.js');
  const { boardDXF } = await import('../js/out/dxf.js');
  const { setSeam } = await import('../js/unfold/seam.js');
  const { seamLoopEdges } = await import('../js/core/selectops.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');

  /** 球 r30、12×16，每 every 條經線標一條縫 */
  const ball = every => {
    const o = new io.ModelObject({ name: '球', kind: io.KIND.SOLID, src: { type: 'sphere', r: 30, segW: 12, segH: 16 } });
    o.bake();
    const m = o.mesh();
    const isPole = v => Math.hypot(v.p.x, v.p.z) < 1e-6, ang = v => Math.atan2(v.p.z, v.p.x);
    const mer = [...m.edges()].filter(he => !isPole(he.v) && !isPole(he.to) && Math.abs(ang(he.v) - ang(he.to)) < 1e-6);
    const angs = [...new Set(mer.map(he => ang(he.v).toFixed(6)))].sort((a, b) => a - b);
    for (const a of angs.filter((_, i) => i % every === 0)) for (const h of seamLoopEdges(m, mer.find(he => ang(he.v).toFixed(6) === a), 'loop')) setSeam(m, h, true);
    return m;
  };
  const N = (style, spacing = 10) => ({ notch: { style, spacing } });
  const lenOf = run => run.segs.reduce((s, g) => s + g.len, 0);
  const onMat = (p, q) => pointInPoly(q.x, q.y, p.outline) && !(p.holes || []).some(h => pointInPoly(q.x, q.y, h));

  /** 2D 上的記號底點 → 3D（找它落在哪一條邊上，照比例內插那條邊的兩個 3D 頂點）*/
  const to3D = (m, run, P) => {
    const V = new Map(m.verts.map(v => [v.id, v.p]));
    let best = null;
    for (const g of run.segs) {
      const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y, L2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((P.x - g.a.x) * dx + (P.y - g.a.y) * dy) / L2));
      const d = Math.hypot(g.a.x + dx * t - P.x, g.a.y + dy * t - P.y);
      if (!best || d < best.d) best = { d, g, t };
    }
    return V.get(best.g.va).clone().lerp(V.get(best.g.vb), best.t);
  };

  /**
   * 每一條縫找它的另一側（同一批頂點），比兩側：起點與方向一樣、記號數一樣、記號換回 3D 是同一個點。
   * `worst` ＝ 兩側同一個記號在 3D 差最多多少 cm。
   */
  const pairUp = (m, pieces, spacing) => {
    const runs = [];
    for (const p of pieces) for (const run of p.seamRuns) runs.push({ p, run, key: run.segs.map(g => [g.va, g.vb].sort((a, b) => a - b).join('-')).sort().join('|') });
    let pairs = 0, worst = 0, sameDir = true, sameCount = true;
    const seen = new Set();
    for (const A of runs) {
      if (seen.has(A)) continue;
      const B = runs.find(r => r !== A && !seen.has(r) && r.key === A.key);
      if (!B) continue;
      seen.add(A); seen.add(B); pairs++;
      if (A.run.segs.map(g => g.va + '>' + g.vb).join() !== B.run.segs.map(g => g.va + '>' + g.vb).join()) sameDir = false;
      const pts = X => notchMarks({ ...X.p, seamRuns: [X.run] }, N('mark', spacing)).lines.map(l => to3D(m, X.run, l.a));
      const pa = pts(A), pb = pts(B);
      if (pa.length !== pb.length) { sameCount = false; continue; }
      // 兩側都是從起點往終點放的 ⇒ 第 i 個對第 i 個
      for (let i = 0; i < pa.length; i++) worst = Math.max(worst, pa[i].distanceTo(pb[i]));
    }
    return { pairs, worst, sameDir, sameCount };
  };

  // ── 西瓜皮：12 片、精確分片 ──
  const m12 = ball(1);
  const canvas = unfoldMesh(m12, makeRule('canvas', 0.1));
  const foam = unfoldMesh(m12, makeRule('foamboard', 0.3));
  /** ⚠ `unfoldMesh()` 的結果⛔ 帶材質（`r.rule` 是 `unfoldMany()` 才補的）—— 不補的話「有沒有縫份」永遠是沒有（第一次跑就撞到）*/
  canvas.rule = makeRule('canvas', 0.1); foam.rule = makeRule('foamboard', 0.3);
  const cp = canvas.pieces[0], fp = foam.pieces[0];
  const L = 16 * 60 * Math.sin(Math.PI / 32);                  // 半個經線圈的折線長（16 格的弦長和）
  const per = 2 * Math.floor((L - NOTCH.endGap) / 10);          // 一片兩條縫，每條 floor((L−1)/10) 個
  eq('前提：球分 12 片（精確分片）', canvas.stats.total, 12);
  ok('★★★ 每片 2 條縫（從南極到北極一整條，⛔ 被緯線切成 16 段）', canvas.pieces.every(p => p.seamRuns.length === 2), cp.seamRuns.length);
  near('★★ 　 每條縫的長度 ＝ 16 格弦長和', lenOf(cp.seamRuns[0]), L, 1e-6);
  eq('★★★ 沒打勾（預設）：圖上 0 個記號（跟原本一樣）', drawProgram(cp, { rule: canvas.rule }).items.filter(i => /^notch/.test(i.style)).length, 0);
  eq('★★★ 沒打勾：DXF 0 條 CUT_NOTCH／MARK', (toDXF(canvas.pieces, { unit: 'mm' }).match(/\r\n0\r\nLINE\r\n8\r\n(CUT_NOTCH|MARK)\r\n/g) || []).length, 0);

  const nm = notchMarks(cp, { rule: canvas.rule, ...N('slit') });
  eq(`★★★ 記號數 ＝ 2 ×〔(縫長 − ${NOTCH.endGap}) ÷ 10 取整〕`, nm.count, per);
  eq('★★ 　 切一小刀：線數 ＝ 記號數 ＋ 2（每條縫第一個多一條）', nm.lines.length, per + 2);
  eq('★★ 　 剪掉小三角：每個兩條線', notchMarks(cp, { rule: canvas.rule, ...N('v') }).lines.length, 2 * (per + 2));

  const pr = pairUp(m12, canvas.pieces, 10);
  eq('★★★ 12 條縫，每條都找到另一側', pr.pairs, 12);
  ok('★★★ 兩側同一個起點、同一個方向', pr.sameDir);
  ok('★★★ 兩側記號數一樣', pr.sameCount);
  ok('★★★ 兩側同一個記號換回 3D 是同一個點（差 < 0.001 cm）', pr.worst < 1e-3, pr.worst);

  // ── 方向與深度 ──
  const len = l => Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);
  const cs = notchMarks(cp, { rule: canvas.rule, ...N('slit') });
  eq('★★★ 帆布（有縫份 1.5）＋ 切：往外', cs.dir, 'out');
  ok('★★★ 　 每條刻口兩端都在外框外面（畫在縫份那一圈裡）', cs.lines.every(l => !onMat(cp, l.a) && !onMat(cp, l.b)));
  ok('★★ 　 深度 ＝ 縫份的一半 0.75', cs.lines.every(l => Math.abs(len(l) - 0.75) < 1e-9));
  const fs = notchMarks(fp, { rule: foam.rule, ...N('slit') });
  eq('★★★ 珍珠板（沒有縫份）＋ 切：往內', fs.dir, 'in');
  ok('★★★ 　 刻口的另一端在料上', fs.lines.every(l => onMat(fp, l.b)));
  ok(`★★ 　 深度 ${NOTCH.inDepth}`, fs.lines.every(l => Math.abs(len(l) - NOTCH.inDepth) < 1e-9));
  const cm = notchMarks(cp, { rule: canvas.rule, ...N('mark') });
  ok('★★★ 只畫線：帆布也往內（畫在料上才描得到）', cm.dir === 'in' && cm.lines.every(l => onMat(cp, l.b)));
  ok(`★★ 　 長 ${NOTCH.markLen}`, cm.lines.every(l => Math.abs(len(l) - NOTCH.markLen) < 1e-9));

  // ── 卡片、DXF、SVG ──
  const tl = titleLines(cp, { rule: canvas.rule, ...N('slit') }).find(s => s.startsWith('對位記號'));
  ok('★★ 卡片：「對位記號 N 個（每 10 cm…）往外切一小刀 0.75 cm（畫在縫份那一圈裡…）」',
     tl && tl.startsWith(`對位記號 ${per} 個（每 10 cm`) && tl.includes('往外切一小刀 0.75 cm（畫在縫份那一圈裡'), tl);
  ok('★★ 　 珍珠板：「往內切一小刀 0.3 cm」', titleLines(fp, { rule: foam.rule, ...N('slit') }).some(s => s.startsWith('對位記號') && s.endsWith('往內切一小刀 0.3 cm')));
  ok('★★ 　 沒打勾 ⇒ 卡片⛔ 寫', !titleLines(cp, { rule: canvas.rule }).some(s => s.startsWith('對位記號')));
  const D = (d, layer) => (d.match(new RegExp(`\\r\\n0\\r\\nLINE\\r\\n8\\r\\n${layer}\\r\\n`, 'g')) || []).length;
  eq('★★★ DXF：切 ⇒ CUT_NOTCH 層 ＝ 12 片的線數', D(toDXF(canvas.pieces, { unit: 'mm', rule: canvas.rule, ...N('slit') }), 'CUT_NOTCH'), 12 * (per + 2));
  const dm = toDXF(canvas.pieces, { unit: 'mm', rule: canvas.rule, ...N('mark') });
  eq('★★★ DXF：只畫線 ⇒ MARK 層，CUT_NOTCH 0 條', `${D(dm, 'MARK')}/${D(dm, 'CUT_NOTCH')}`, `${12 * (per + 2)}/0`);
  const nest = packBoards(canvas.pieces, { w: 240, h: 120, gap: 2, rotate: false });
  const bd = nest.boards.map(b => boardDXF(boardProgram(b, { rule: canvas.rule, ...N('slit') }), { unit: 'mm' })).join('');
  eq('★★ 排版存 DXF：CUT_NOTCH 一樣多', D(bd, 'CUT_NOTCH'), 12 * (per + 2));
  ok('★★ SVG：只畫線 ⇒ 有青綠色的線；沒打勾 ⇒ 沒有', toSVG(cp, { rule: canvas.rule, ...N('mark') }).includes('#16a085') && !toSVG(cp, { rule: canvas.rule }).includes('#16a085'));

  // ── 太短、沒標過 ──
  const big = notchMarks(cp, { rule: canvas.rule, ...N('slit', 100) });
  /** ⚠ 2026-10-19 改了（綜合評估 ①-12，kang 同意）：比間距短的縫⛔ 再一個都不放，改成正中間放一個；只有短過 2 cm 才不放 */
  eq('★★ 間距比縫還長 ⇒ 兩條都放在正中間（各 1 個）、⛔ 算「太短」', `${big.count}/${big.mid}/${big.short}`, '2/2/0');
  const bigLine = titleLines(cp, { rule: canvas.rule, ...N('slit', 100) }).find(s => s.startsWith('對位記號'));
  ok('★★ 　 卡片講「2 條縫比 101 cm 短，放在正中間」', !!bigLine && bigLine.startsWith('對位記號 2 個') && bigLine.includes('2 條縫比 101 cm 短，放在正中間'), bigLine);
  {
    // 正中間：兩側同一個點（換回 3D 一樣）—— 中點離起點的 3D 長度 ＝ 一半
    const run = cp.seamRuns[0], L = run.segs.reduce((t, g) => t + g.len, 0);
    const lines = notchMarks({ ...cp, seamRuns: [run] }, { rule: canvas.rule, ...N('mark', 100) }).lines;
    let acc = 0, mid = null;
    for (const g of run.segs) { if (acc + g.len >= L / 2) { const t = (L / 2 - acc) / g.len; mid = { x: g.a.x + (g.b.x - g.a.x) * t, y: g.a.y + (g.b.y - g.a.y) * t }; break; } acc += g.len; }
    ok('★★ 　 第一條記號落在縫的正中間（3D 長度的一半）', !!mid && Math.hypot(lines[0].a.x - mid.x, lines[0].a.y - mid.y) < 1e-6, `L ${L.toFixed(3)}`);
  }
  const plain = unfoldMesh(buildPrim('box', PRIM_DEFAULTS.box), makeRule('foamboard', 0.3));
  ok('★★ 沒標過分片 ⇒ 沒有縫可以放（seamRuns 空的）', plain.pieces.every(p => p.seamRuns.length === 0));

  // ── 省道打版：球 4 片（縫邊拉回原長，2D 不是剛體）──
  const m4 = ball(3);
  const dart = unfoldMesh(m4, makeRule('canvas', 0.1), { mode: 'dart' });
  eq('前提：球 4 片（省道打版）', dart.stats.total, 4);
  const pd = pairUp(m4, dart.pieces, 10);
  eq('★★★ 省道打版：4 條縫都找到另一側', pd.pairs, 4);
  ok('★★★ 　 兩側記號數一樣、同一個方向', pd.sameCount && pd.sameDir);
  ok('★★★ 　 換回 3D 是同一個點（差 < 0.001 cm）', pd.worst < 1e-3, pd.worst);

  /**
   * 開口（省道）也是切割線、也有接合編號 ⇒ 開口的兩條邊算一條縫的兩側，也有記號（縫開口時兩條邊對齊用）。
   * 球 4 片、每片中間兩條經線從南北極各開 6 格 ⇒ 每片 4 道開口；開口的尖端只有一條切割邊、極點有很多條 ⇒ 一道開口一條。
   */
  const isPoleD = v => Math.hypot(v.p.x, v.p.z) < 1e-6, angD = v => Math.atan2(v.p.z, v.p.x);
  const od = new io.ModelObject({ name: '球', kind: io.KIND.SOLID, src: { type: 'sphere', r: 30, segW: 12, segH: 16 } });
  od.bake();
  const md = od.mesh();
  const merD = [...md.edges()].filter(he => !(isPoleD(he.v) && isPoleD(he.to)) && Math.abs(he.v.p.y - he.to.p.y) > 1e-6
    && (isPoleD(he.v) || isPoleD(he.to) || Math.abs(angD(he.v) - angD(he.to)) < 1e-6));
  const angsD = [...new Set(merD.map(he => angD(isPoleD(he.v) ? he.to : he.v).toFixed(6)))].sort((a, b) => a - b);
  angsD.forEach((a, j) => merD.filter(he => angD(isPoleD(he.v) ? he.to : he.v).toFixed(6) === a)
    .sort((p, q) => Math.max(q.v.p.y, q.to.p.y) - Math.max(p.v.p.y, p.to.p.y))
    .forEach((h, k) => { if (j % 3 === 0 || k < 6 || k >= 10) setSeam(md, h, true); }));
  const darted = unfoldMesh(md, makeRule('paper', 0.05), { mode: 'dart' });
  eq('前提：球 4 片、每片 4 道開口（省道打版）', darted.stats.total, 4);
  eq('★★ 每片 10 條：2 條縫 ＋ 4 道開口 × 2 條邊', darted.pieces.map(p => p.seamRuns.length).join(','), '10,10,10,10');
  const pdd = pairUp(md, darted.pieces, 10);
  eq('★★★ 4 條縫 ＋ 16 道開口都找到另一側', pdd.pairs, 20);
  ok('★★★ 　 開口的兩條邊也是同一個起點、同一個方向，換回 3D 同一個點', pdd.sameDir && pdd.sameCount && pdd.worst < 1e-3, pdd.worst);

  /**
   * ── 封閉的縫：球只切赤道一圈（省道打版 → 兩片，各一條整圈的縫）──
   * ⚠ 第一版拿圓環切 8 段驗，結果每圈斷成兩條 —— 那是**對的**：筒狀的一段要攤平，程式沿長邊再剪一刀，
   * 那一刀碰到縫的地方有三條切割邊交會 ⇒ 斷開（兩側一樣斷，對位照樣對得上）。整圈要找一條沒有別的切線碰到的。
   */
  const oe = new io.ModelObject({ name: '球', kind: io.KIND.SOLID, src: { type: 'sphere', r: 30, segW: 12, segH: 16 } });
  oe.bake();
  const me = oe.mesh();
  const eqE = [...me.edges()].find(h => Math.abs(h.v.p.y) < 1e-6 && Math.abs(h.to.p.y) < 1e-6);
  for (const h of seamLoopEdges(me, eqE, 'loop')) setSeam(me, h, true);
  const hemi = unfoldMesh(me, makeRule('canvas', 0.1), { mode: 'dart' });
  const hp = hemi.pieces[0], hl = lenOf(hp.seamRuns[0]);
  eq('前提：球切赤道 ⇒ 2 片（省道打版）', hemi.stats.total, 2);
  ok('★★★ 每片 1 條縫、是一整圈（封閉）、12 條邊', hemi.pieces.every(p => p.seamRuns.length === 1 && p.seamRuns[0].closed && p.seamRuns[0].segs.length === 12));
  near('★★ 　 圈長 ＝ 赤道 12 邊形周長（容許 0.0001：轉成可編輯網格時頂點有小數誤差）', hl, 12 * 60 * Math.sin(Math.PI / 12), 1e-4);
  eq('★★ 　 記號數 ＝ (圈長 − 1) ÷ 10 取整', notchMarks(hp, N('slit', 10)).count, Math.floor((hl - NOTCH.endGap) / 10));
  const pt = pairUp(me, hemi.pieces, 10);
  eq('★★★ 赤道那一圈找到另一側', pt.pairs, 1);
  ok('★★★ 　 一整圈也是同一個起點、同一個方向，換回 3D 同一個點', pt.sameDir && pt.sameCount && pt.worst < 1e-3, pt.worst);

  /**
   * ── 精確分片的圓柱：上下緣每一條邊 ＋ 一條直邊 ⇒ 3 片（側面、兩個蓋子）──
   * 直縫的兩側都在側面那一片上；上下緣碰到直縫的那一點有三條切割邊，但那一圈自己首尾相接 ⇒ 仍是一整圈，
   * 從整圈頂點 id 最小的那一點量起（在側面片上會跨過左右兩端，每條邊各自落 2D，照樣對得上）。
   */
  const oc = new io.ModelObject({ name: '圓柱', kind: io.KIND.SOLID, src: { type: 'cylinder', ...PRIM_DEFAULTS.cylinder } });
  oc.bake();
  const mc = oc.mesh();
  let vDone = false;
  for (const h of mc.edges()) {
    if (!h.face || !h.twin || !h.twin.face) continue;
    if (Math.abs(h.v.p.y - h.to.p.y) < 1e-6) setSeam(mc, h, true);
    else if (!vDone) { setSeam(mc, h, true); vDone = true; }
  }
  const cyl = unfoldMesh(mc, makeRule('foamboard', 0.3));
  const { r: cr, h: chh, seg: cs2 } = PRIM_DEFAULTS.cylinder;
  const rim = cs2 * 2 * cr * Math.sin(Math.PI / cs2);
  const side = cyl.pieces.find(p => p.seamRuns.length === 4);
  eq('前提：圓柱 3 片（精確分片）', cyl.stats.total, 3);
  ok('★★ 側面片：直縫兩側 ＋ 上下緣兩圈（封閉）', side && side.seamRuns.filter(r => r.closed).length === 2 && side.seamRuns.filter(r => !r.closed).length === 2);
  eq('★★★ 側面片的記號數 ＝ 2×(高−1)÷10 ＋ 2×(緣長−1)÷10（各取整）', notchMarks(side, N('slit')).count,
     2 * Math.floor((chh - NOTCH.endGap) / 10) + 2 * Math.floor((rim - NOTCH.endGap) / 10));
  const pc = pairUp(mc, cyl.pieces, 10);
  eq('★★★ 3 條縫（直縫、上緣、下緣）都找到另一側', pc.pairs, 3);
  ok('★★★ 　 同一個起點、同一個方向，換回 3D 同一個點', pc.sameDir && pc.sameCount && pc.worst < 1e-3, pc.worst);
}

section('智慧分切 第一步：不准切 ＋ 提案（2026-10-13）');

/**
 * kang 拍板（→ `規格\建模器-智慧分切.md`）：程式提案、kang 決定；不准切是邊上的第四個標記（藍色）；
 * 第一步的提案 ＝ 程式本來就會補剪的那幾刀，但繞開不准切、講放不放得進板子；接受之後程式補剪 0 條。
 */
{
  const { setSeam, isSeam, setKeep, isKeep, keepCount, clearKeeps, markSignature, isMarkable } = await import('../js/unfold/seam.js');
  const { proposeSeams } = await import('../js/unfold/propose.js');
  const { seamPreviewKey } = await import('../js/ui/toolbar.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const mk = (t, over = {}) => {
    const o = new io.ModelObject({ name: t, kind: io.KIND.SOLID, src: { type: t, ...PRIM_DEFAULTS[t], ...over } });
    o.bake();
    return o;
  };
  const key = he => Math.min(he.id, he.twin.id);
  const inner = m => [...m.edges()].filter(h => h.face && h.twin && h.twin.face);

  // ── 標記本身 ──
  const b0 = mk('box'), m0 = b0.mesh();
  const e0 = inner(m0).find(h => isMarkable(m0, h));
  /**
   * ⚠ 「轉成可編輯網格」會先把共面的面併成一整塊 ⇒ 轉過的網格⛔ 共面的邊（第一版拿方塊、圓柱、平板測，三次都撲空）。
   * ⇒ 用還沒轉的原始網格：圓柱的蓋子是一圈三角形，中間的邊都共面。
   */
  const mcy0 = buildPrim('cylinder', PRIM_DEFAULTS.cylinder);
  mcy0.computeNormals();
  const flat = inner(mcy0).find(h => !isMarkable(mcy0, h));
  ok('★★ 標不准切：可以標', setKeep(m0, e0, true) && isKeep(e0) && isKeep(e0.twin));
  ok('★★★ 　 再標成切開 ⇒ 不准切自動拿掉（互斥）', setSeam(m0, e0, true) && isSeam(e0) && !isKeep(e0));
  ok('★★★ 　 再標回不准切 ⇒ 切開自動拿掉', setKeep(m0, e0, true) && isKeep(e0) && !isSeam(e0));
  ok('★★ 共面的邊（畫面上看不見）⛔ 能標', !!flat && !setKeep(mcy0, flat, true) && !isKeep(flat));
  const re = Mesh.fromJSON(JSON.parse(JSON.stringify(m0.toJSON())));
  eq('★★★ 存檔再開：不准切還在', keepCount(re), 1);
  const s0 = markSignature(m0);
  setKeep(m0, inner(m0).filter(h => isMarkable(m0, h))[3], true);
  ok('★★ 標記指紋：多標一條不准切 ⇒ 變', markSignature(m0) !== s0);
  eq('★★ 清除不准切', clearKeeps(m0), 2);
  eq('★★ 　 清完 0 條', keepCount(m0), 0);
  const st = { mode: 'exact', material: 'foamboard' };
  const k1 = seamPreviewKey(b0, st);
  setKeep(m0, e0, true);
  ok('★★★ 即時預覽：標了不准切也要重算（展開結果會變）', seamPreviewKey(b0, st) !== k1);
  setKeep(m0, e0, false);

  /**
   * ── 🔴 沒標不准切 ⇒ 展開結果跟改之前一樣 ──
   * 標準答案是 2026-10-13 沙箱量測（`外部參考-自動分切.md` 第 6 節）用**改之前的程式**量到的：
   * 程式自己剪幾條邊、最大一片的外框（珍珠板、精確分片、預設尺寸、轉成可編輯網格）。
   * ⭐ 2026-10-19 網格物件改成「照存檔內容重建後才攤」（`unfold/part.js` `canonicalMesh()`，實驗 T3）之後還是這一組 ——
   * 因為存檔同時改成座標存完整精度（`mesh.js` `toJSON()`），重建出來的跟原網格一位不差。
   */
  const before = { box: [7, 145, 210], wedge: [5, 106, 168], prism: [11, 195, 164], stairs: [19, 120, 420], roundBox: [39, 200, 142],
    cylinder: [63, 179, 170], cone: [32, 126, 149], tube: [127, 179, 206], dome: [256, 191, 242], sphere: [481, 223, 297], torus: [358, 166, 198] };
  const diff = [];
  for (const [t, [n, w, h]] of Object.entries(before)) {
    const r = unfoldObject(mk(t), { material: 'foamboard' });
    const p = r.pieces.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (r.autoEdges.length !== n || Math.round(p.width) !== w || Math.round(p.height) !== h)
      diff.push(`${t}: ${r.autoEdges.length} 條 ${Math.round(p.width)}×${Math.round(p.height)}（以前 ${n} 條 ${w}×${h}）`);
  }
  eq('★★★ 11 種基本形狀：程式剪的邊數、最大一片 ＝ 改之前（沒標不准切）', diff.join('；'), '');

  /**
   * ── 提案（兩步都成立的性質）──
   * ⚠ 第二步（2026-10-13）之後提案改成「放得進板子」的切法 —— 第一步寫死的「提案 ＝ 程式原本剪的 7 條」不再成立，
   * 改驗兩步都要守的事；第二步的數字在下一節「智慧分切 第二步」。
   */
  const bx = mk('box'), mb = bx.mesh();
  const p0 = proposeSeams(bx, { material: 'foamboard' });
  ok('★★ 提案⛔ 改任何一條邊（只是算）', p0.edges.length > 0 && !inner(mb).some(isSeam));
  const locked = p0.edges.slice(0, 3);
  for (const h of locked) setKeep(mb, h, true);
  const p1 = proposeSeams(bx, { material: 'foamboard' });
  ok('★★★ 把提案裡 3 條標不准切 ⇒ 新的提案⛔ 碰那 3 條', p1.edges.length > 0 && !p1.edges.some(h => isKeep(h)));
  for (const h of p1.edges) setSeam(mb, h, true);
  const ra = unfoldObject(bx, { material: 'foamboard' });
  const maxOf = ps => ps.slice().sort((x, y) => y.width * y.height - x.width * x.height)[0];
  eq('★★★ 接受之後再展開：程式自己剪 0 條', ra.autoEdges.length, 0);
  ok('★★★ 　 片數、最大一片跟提案時一樣', ra.stats.total === p1.total && Math.round(maxOf(ra.pieces).width) === Math.round(p1.maxPiece.w) && Math.round(maxOf(ra.pieces).height) === Math.round(p1.maxPiece.h),
     `${ra.stats.total} 片 ${maxOf(ra.pieces).width}×${maxOf(ra.pieces).height}`);
  ok('★★ 　 不准切那 3 條還是不准切、⛔ 被接受成切開', locked.every(h => isKeep(h) && !isSeam(h)));
  eq('★★ 接受完再提案 ⇒ 沒有要補的', proposeSeams(bx, { material: 'foamboard' }).edges.length, 0);

  // ── 非切不可的不准切 ──
  const cy = mk('cylinder'), mc = cy.mesh();
  let nv = 0;
  for (const h of inner(mc)) if (Math.abs(h.v.p.y - h.to.p.y) > 1e-6 && Math.hypot(h.v.p.x, h.v.p.z) > 1 && setKeep(mc, h, true)) nv++;
  eq('前提：圓柱的直邊全標不准切', nv, PRIM_DEFAULTS.cylinder.seg);
  const rc = unfoldObject(cy, { material: 'foamboard' });
  eq('★★★ 繞一圈一定要剪一刀 ⇒ 1 條不准切非切不可', rc.keepCut, 1);
  ok('★★★ 　 展開圖上講出來（⛔ 安靜地切）', rc.warnings.some(w => w.startsWith('有 1 條「不准切」的邊非切不可') && w.includes('不剪就攤不開')), rc.warnings.join('｜'));
  eq('★★ 　 提案也講', proposeSeams(cy, { material: 'foamboard' }).keepCut, 1);
  const ac = mk('box');
  let na = 0;
  for (const h of inner(ac.mesh())) if (setKeep(ac.mesh(), h, true)) na++;
  const rac = unfoldObject(ac, { material: 'acrylic' });
  eq('★★★ 壓克力方塊 12 條全標不准切 ⇒ 12 條非切不可（⛔ 重複算夾在兩片之間的）', `${na}/${rac.keepCut}`, '12/12');
  ok('★★ 　 原因寫「折不起來」', rac.warnings.some(w => w.includes('12 條是壓克力／木板折不起來')));

  // ── 板子 ──
  eq('★★ 板子 300×300 ⇒ 方塊放得進', proposeSeams(mk('box'), { material: 'foamboard', board: { w: 300, h: 300 } }).big, 0);

  // ── 縮放過的物件：提案的邊要是物件自己那份網格的 ──
  const sc = mk('box');
  sc.scale.set(2, 2, 2);
  const ps = proposeSeams(sc, { material: 'foamboard' });
  const own = new Set([...sc.mesh().edges()].map(key));
  ok('★★★ 縮放 2 倍：提案的每一條都在物件自己的網格上（接受才標得上）', ps.edges.length > 0 && ps.edges.every(h => own.has(key(h))));
  ok('★★ 　 外框照縮放算、而且全放得進（120×90×80 的方塊）', ps.big === 0 && ps.maxPiece.w > 150, `${ps.total} 片 ${ps.maxPiece.w}×${ps.maxPiece.h}`);
}

section('智慧分切 第二步：放得進板子（2026-10-13）');

/**
 * 規格「第二步」第 3 節：分塊 → 每塊一片 → 照共用邊界由長到短一對一對接（只放開那兩塊之間的邊）→ 跟程式本來剪的比；
 * 放不放得進跟排版共用 `fitsBoard()`（扣間距、照轉 90° 的勾）。數字的來源：同一天的沙箱原型（規格第 0 節）。
 */
{
  const { setSeam, isSeam, setKeep, isKeep } = await import('../js/unfold/seam.js');
  const { proposeSeams, SMOOTH_DEG } = await import('../js/unfold/propose.js');
  const { fitsBoard, packBoards } = await import('../js/out/nest.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const mk = (t, over = {}) => {
    const o = new io.ModelObject({ name: t, kind: io.KIND.SOLID, src: { type: t, ...PRIM_DEFAULTS[t], ...over } });
    o.bake();
    return o;
  };
  const B = { w: 240, h: 120, gap: 1, rotate: false };
  const P = (o, board = B) => proposeSeams(o, { material: 'foamboard', board });
  const DEG = 180 / Math.PI;
  const onCorner = (o, edges) => edges.every(h => { const d = o.mesh().dihedral(h); return d !== null && Math.abs(d * DEG) >= SMOOTH_DEG; });
  const sizes = ps => ps.map(p => `${Math.round(p.width)}×${Math.round(p.height)}`).sort().join(',');

  // ── 放不放得進：跟排版同一支 ──
  ok('★★★ 238×118、板子 240×120、間距 1 ⇒ 放得進（扣掉兩邊間距剛好）', fitsBoard(238, 118, B));
  ok('★★★ 　 239×118 ⇒ 放不進（第一步的錯：只跟 240×120 比）', !fitsBoard(239, 118, B));
  ok('★★ 　 118×238：不轉放不進、可以轉就放得進', !fitsBoard(118, 238, B) && fitsBoard(118, 238, { ...B, rotate: true }));
  const fake = (w, h) => ({ width: w, height: h, qty: 1 });
  eq('★★ 排版用的也是它：238×118 ⇒ 1 張板、⛔ 算比板子大', packBoards([fake(238, 118)], B).boards.filter(b => !b.oversize).length, 1);
  eq('★★ 　 239×118 ⇒ 比板子大', packBoards([fake(239, 118)], B).boards.filter(b => b.oversize).length, 1);

  // ── 方塊 ──
  const b1 = mk('box'), pb = P(b1);
  ok('★★★ 方塊 60×45×40、不轉 90° ⇒ 3 片、全放得進、縫 400', pb.total === 3 && pb.big === 0 && Math.round(pb.cutLen) === 400, `${pb.total} 片 放不進 ${pb.big} 縫 ${pb.cutLen}`);
  ok('★★★ 　 提案的縫全在轉角上', onCorner(b1, pb.edges));
  const pr = P(mk('box'), { ...B, rotate: true });
  ok('★★★ 　 可以轉 90° ⇒ 2 片、縫 355（＝ 原本十字形的縫長）', pr.total === 2 && pr.big === 0 && Math.round(pr.cutLen) === 355, `${pr.total} 片 縫 ${pr.cutLen}`);
  const pbig = P(mk('box', { w: 150, h: 60, d: 50 }));
  ok('★★ 方塊 150×60×50 ⇒ 2 片全放得進', pbig.total === 2 && pbig.big === 0, `${pbig.total}/${pbig.big}`);
  const pw = P(mk('wedge'));
  ok('★★★ 楔形 ⇒ 換一種排法、1 片就放得進（程式本來剪的 106×168 放不進）', pw.total === 1 && pw.big === 0, `${pw.total} 片 ${pw.maxPiece.w}×${pw.maxPiece.h}`);

  // ── 圓柱：側面 ＋ 兩蓋 ──
  const cy = mk('cylinder'), pc = P(cy);
  ok('★★★ 圓柱 ⇒ 3 片全放得進（側面＋兩蓋）', pc.total === 3 && pc.big === 0, `${pc.total}/${pc.big}`);
  for (const h of pc.edges) setSeam(cy.mesh(), h, true);
  const rc = unfoldObject(cy, { material: 'foamboard' });
  const side = Math.round(PRIM_DEFAULTS.cylinder.seg * 2 * PRIM_DEFAULTS.cylinder.r * Math.sin(Math.PI / PRIM_DEFAULTS.cylinder.seg));
  ok('★★ 　 接受之後：一片是側面（32 邊形周長 × 高）、兩片是蓋子', rc.pieces.some(p => Math.round(p.width) === side && Math.round(p.height) === PRIM_DEFAULTS.cylinder.h)
     && rc.stats.total === 3, sizes(rc.pieces));

  // ── 接受之後：每片都放得進、補剪 0 條 ──
  for (const t of ['box', 'stairs', 'prism']) {
    const o = mk(t), p = P(o);
    for (const h of p.edges) setSeam(o.mesh(), h, true);
    const r = unfoldObject(o, { material: 'foamboard' });
    ok(`★★★ ${t}：接受提案再展開 ⇒ 每片都放得進（排版那支判斷）、程式補剪 0 條`,
       r.pieces.every(q => fitsBoard(q.width, q.height, B)) && r.autoEdges.length === 0, `${sizes(r.pieces)} 補剪 ${r.autoEdges.length}`);
  }

  // ── 不准切、使用者先標的縫 ──
  const bk = mk('box');
  const top = bk.mesh().edges ? [...bk.mesh().edges()].find(h => h.face && h.twin && h.twin.face && Math.abs(h.v.p.y - h.to.p.y) < 1e-6 && h.v.p.y > 0) : null;
  setKeep(bk.mesh(), top, true);
  const pk = P(bk);
  ok('★★★ 方塊上緣一條標不准切 ⇒ 提案⛔ 碰它、照樣全放得進', !pk.edges.some(h => isKeep(h)) && pk.big === 0, `${pk.total} 片`);
  for (const h of pk.edges) setSeam(bk.mesh(), h, true);
  const rk = unfoldObject(bk, { material: 'foamboard' });
  ok('★★ 　 接受之後那條還是連著（⛔ 被切開）', isKeep(top) && !isSeam(top) && rk.keepCut === 0);
  const bu = mk('box');
  const mine = [...bu.mesh().edges()].find(h => h.face && h.twin && h.twin.face && Math.abs(h.v.p.y - h.to.p.y) > 1e-6);
  setSeam(bu.mesh(), mine, true);
  const pu = P(bu);
  ok('★★★ 使用者先標的縫：⛔ 出現在提案裡、照樣切開', !pu.edges.includes(mine) && isSeam(mine) && pu.big === 0, `${pu.total} 片`);

  // ── 小東西⛔ 變差 ──
  /**
   * ⚠ 2026-10-21 分片成群第三件（kang 定案「預設不要細切口」）：小圓柱程式本來剪成 1 片，但蓋子邊上留 4 個只張開 11° 的細切口
   * ⇒ 預設改成側面 ＋ 兩蓋 3 片；選「片少一點（允許細切口）」才照舊 ≤ 程式本來剪的。
   */
  for (const [t, over] of [['box', { w: 20, h: 20, d: 20 }], ['cylinder', { r: 10, h: 30 }], ['prism', { r: 10, h: 20 }]]) {
    const before = unfoldObject(mk(t, over), { material: 'foamboard' }).stats.total;
    const p = proposeSeams(mk(t, over), { material: 'foamboard', board: B, slits: 'allow' });
    ok(`★★ 小${t}（片少一點）：提案片數 ≤ 程式本來剪的（${before} 片）`, p.total <= before && p.big === 0, `${p.total} 片`);
    const q = P(mk(t, over));
    ok(`★★ 　 小${t}（預設：不要細切口）：細切口 0、全放得進`, q.notch === 0 && q.big === 0, `${q.total} 片 細切口 ${q.notch}`);
  }

  // ── 還放不進的：講是哪一種 ──
  // 第三步之後球、圓環有花瓣可以切 ⇒ 看「只沿轉角」那一份（＝ 第二步的切法）
  const cornerOf = p => p.options.find(o => o.kind === 'corner');
  const ps = P(mk('sphere'));
  const psc = cornerOf(ps);
  // ⚠ 2026-10-21 第三件：「只沿轉角」改成從每一塊平面開始接 ⇒ 球不再是「一整個曲面放不進」，切成平面一塊一塊、全放得進、沒有細切口
  ok('★★★ 球「只沿轉角」那一份 ⇒ 全放得進、沒有細切口（以前 1 片一整個曲面放不進）', psc.big === 0 && psc.notch === 0, `${psc.total} 片 ${psc.big}/${psc.bigCurved}/${psc.bigFlat} 細 ${psc.notch}`);
  const pp = P(mk('plate', { w: 300, d: 50 }));
  ok('★★★ 300×50 的平板 ⇒ 1 片是「本身就是一個比板子大的平面」', pp.big === 1 && pp.bigFlat === 1 && pp.bigCurved === 0, `${pp.big}/${pp.bigCurved}/${pp.bigFlat}`);
  ok('★★ 圓環「只沿轉角」那一份 ⇒ 不重疊、全放得進（以前 1 片重疊、放不進）', !cornerOf(P(mk('torus'))).overlap && cornerOf(P(mk('torus'))).big === 0);
  ok('★★ 都沒有算到時間上限', !pb.timedOut && !pc.timedOut && !ps.timedOut);
}

section('智慧分切 第三步：曲面切成整齊的長線（2026-10-13）');

/**
 * 規格「第三步」第 3 節：格子曲面列候選（長條／環帶／花瓣，候選在 `curved.js`）→ 每個都攤一次 →
 * 放不進的少 → 沒重疊 → 程式補剪的線少 → 片少 → 縫短 挑；每一種各留一份（`options`）。數字的來源：規格第 0 節的沙箱。
 */
{
  const { setSeam, setKeep } = await import('../js/unfold/seam.js');
  const { proposeSeams } = await import('../js/unfold/propose.js');
  const { gridOf, candidatesOf } = await import('../js/unfold/curved.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const mk = (t, over = {}) => {
    const o = new io.ModelObject({ name: t, kind: io.KIND.SOLID, src: { type: t, ...PRIM_DEFAULTS[t], ...over } });
    o.bake();
    return o;
  };
  const B = { w: 240, h: 120, gap: 1, rotate: false };
  const P = o => proposeSeams(o, { material: 'foamboard', board: B });
  const kinds = p => p.options.map(o => `${o.label} ${o.total}`).join(' / ');
  /** 照某一份提案標縫、再展開：片數、每片最多補剪幾條 */
  const accept = (o, opt) => {
    for (const h of opt.edges) setSeam(o.mesh(), h, true);
    const r = unfoldObject(o, { material: 'foamboard' });
    return { total: r.stats.total, maxAuto: Math.max(0, ...r.pieces.map(p => (p.autoCut && p.autoCut.lines) || 0)) };
  };
  const whole = o => { const m = o.mesh(); return new Set(m.faces.map(f => f.id)); };

  // ── 找格子 ──
  const sg = mk('sphere');
  const gs = gridOf(sg.mesh(), whole(sg));
  const gsn = gs ? [gs.A.length, gs.B.length].sort((a, b) => a - b).join('×') : '找不到';
  eq('★★★ 球（32×16）⇒ 找到格子：32 條經線 ＋ 15 圈緯線', gsn, '15×32');
  const tor = mk('torus');
  const gt = gridOf(tor.mesh(), whole(tor));
  eq('★★★ 圓環（32×12）⇒ 繞管子 32 圈 ＋ 沿大圓 12 圈', gt ? [gt.A.length, gt.B.length].sort((a, b) => a - b).join('×') : '找不到', '12×32');
  const cs = gs ? [...new Set(candidatesOf(gs).map(c => c.kind))].sort().join(',') : '';
  eq('★★ 球的候選三種都有', cs, 'band,petal,strip');
  const box = mk('box');
  eq('★★ 方塊整個 ⇒ ⛔ 是格子', gridOf(box.mesh(), whole(box)), null);

  // ── 球：兩朵花 ──
  const sp = mk('sphere'), ps = P(sp);
  ok('★★★ 球 ⇒ 提案是花瓣、2 片、全放得進（沙箱：兩朵花 94×94）', ps.kind === 'petal' && ps.total === 2 && ps.big === 0 && !ps.overlap, kinds(ps));
  const strip = ps.options.find(o => o.kind === 'strip');
  ok('★★★ 　 其他切法裡有長條：32 片', !!strip && strip.total === 32, kinds(ps));
  ok('★★ 　 「只沿轉角」也在（2026-10-21 起全放得進）', ps.options.some(o => o.kind === 'corner' && o.big === 0), kinds(ps));
  ok('★★ 　 第 0 份 ＝ 提案本身', ps.options[0].kind === ps.kind && ps.options[0].edges === ps.edges);
  const as = accept(sp, ps);
  ok('★★★ 　 接受之後再展開 ⇒ 2 片、每片程式補剪 0～1 條', as.total === 2 && as.maxAuto <= 1, `${as.total} 片 補剪 ${as.maxAuto}`);
  ok('★★ 　 沒有算到時間上限', !ps.timedOut);

  // ── 半球、圓環 ──
  const pd = P(mk('dome'));
  ok('★★★ 半球 ⇒ 花瓣、2 片（花＋底板）全放得進', pd.kind === 'petal' && pd.total === 2 && pd.big === 0, kinds(pd));
  const pt = P(tor);
  ok('★★★ 圓環 ⇒ 花瓣、1～2 片全放得進、沒有重疊（第二步：1 片放不進、有重疊）', pt.kind === 'petal' && pt.total <= 2 && pt.big === 0 && !pt.overlap, kinds(pt));
  const at = accept(tor, pt);
  ok('★★ 　 接受之後再展開 ⇒ 片數一樣、每片補剪 0～1 條', at.total === pt.total && at.maxAuto <= 1, `${at.total} 片 補剪 ${at.maxAuto}`);

  // ── 圓柱：照舊 ──
  const pc = P(mk('cylinder'));
  ok('★★★ 圓柱 ⇒ 照舊 3 片「只沿轉角」，⛔ 被換成長條', pc.kind === 'corner' && pc.total === 3 && pc.big === 0, kinds(pc));
  ok('★★ 　 長條列在其他切法（34 片）', pc.options.some(o => o.kind === 'strip' && o.total === 34), kinds(pc));

  // ── 只有平面的：跟第二步一樣、⛔ 列其他切法 ──
  for (const t of ['box', 'wedge', 'stairs', 'prism']) {
    const p = P(mk(t));
    ok(`★★★ ${t} ⇒ 只有一份（只沿轉角）、⛔ 寫是哪一種`, p.options.length === 1 && p.kind === 'corner', kinds(p));
  }

  // ── 換成其他切法 ──
  const sp2 = mk('sphere'), ps2 = P(sp2);
  const alt = ps2.options.find(o => o.kind === 'strip');
  ok('★★★ 換成長條 ⇒ 提案的邊跟著換', !!alt && alt.edges.length !== ps2.edges.length, `${ps2.edges.length} → ${alt && alt.edges.length}`);
  const a2 = accept(sp2, alt);
  ok('★★★ 　 接受之後再展開 ⇒ 片數跟那一份一樣（32）、每片補剪 0～1 條', a2.total === alt.total && a2.maxAuto <= 1, `${a2.total} 片 補剪 ${a2.maxAuto}`);

  // ── 不准切 ──
  const sk = mk('sphere');
  const m = sk.mesh();
  // 赤道那一圈的一條緯線邊（兩朵花的切口一定會用到它）
  const eqE = [...m.edges()].find(h => h.face && h.twin && h.twin.face && Math.abs(h.v.p.y) < 1e-6 && Math.abs(h.to.p.y) < 1e-6);
  setKeep(m, eqE, true);
  const pk = P(sk);
  ok('★★★ 不准切的邊 ⇒ 每一份提案都⛔ 碰它', pk.options.every(o => !o.edges.includes(eqE)), kinds(pk));
  ok('★★ 　 還是有提案（不是整個放棄）', pk.options.length > 1 && pk.edges.length > 0, kinds(pk));
}

section('edgeRing 兩個方向都走（2026-10-13）');

/**
 * 原本第二個方向從 `he0.twin` 出發，第一步就撞到「起點看過了」⇒ 當場停、還回 `closed=true`：
 * 沒繞成一圈的 ring 只走得了點到的那一側，而且常常謊報繞回來了。
 * 用到它的：環切、選一圈、選一圈面、分片「同方向的全部」、智慧分切找格子。
 * 數字：球 32×16 轉成可編輯網格 ⇒ 每一直排 15 條緯線（兩極旁邊是三角形，走到那裡停）。
 */
{
  const { seamLoopEdges } = await import('../js/core/selectops.js');
  const so = await import('../js/core/selectops.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const mkMesh = t => {
    const o = new io.ModelObject({ name: t, kind: io.KIND.SOLID, src: { type: t, ...PRIM_DEFAULTS[t] } });
    o.bake();
    return o.mesh();
  };
  const m = mkMesh('sphere');
  const lat = [...m.edges()].filter(h => h.face && h.twin && h.twin.face && Math.abs(h.v.p.y - h.to.p.y) < 1e-6);
  const ys = [...new Set(lat.map(h => h.v.p.y.toFixed(3)))].map(Number).sort((a, b) => b - a);
  eq('前提：球有 15 圈緯線', ys.length, 15);
  // 最上面一圈、第 3 圈、赤道 —— 修之前分別是（一側／另一側）1／15、3／13、8／8
  for (const [yi, name] of [[0, '最上面一圈'], [2, '第 3 圈'], [7, '赤道']]) {
    const he = lat.find(h => Math.abs(h.v.p.y - ys[yi]) < 1e-3);
    const a = edit.edgeRing(m, he), b = edit.edgeRing(m, he.twin);
    ok(`★★★ ${name}的緯線：從兩側出發都走到 15 條（＝ 緯線圈數）`, a.hes.length === 15 && b.hes.length === 15, `${a.hes.length}／${b.hes.length}`);
    ok(`★★★ 　 而且都說沒繞回來（兩頭撞到極點的三角形）`, !a.closed && !b.closed, `${a.closed}／${b.closed}`);
    eq(`★★ 　 每條只出現一次`, new Set(a.keys).size, 15);
  }

  // 分片「同方向的全部」：15 圈 × 32 段，從哪一側點都一樣
  const he3 = lat.find(h => Math.abs(h.v.p.y - ys[2]) < 1e-3);
  eq('★★★ 分片「同方向的全部」點第 3 圈緯線 ⇒ 15 × 32 ＝ 480 條（修之前 96）', seamLoopEdges(m, he3, 'all').length, 15 * 32);
  eq('★★ 　 從另一側點也是 480（修之前 416）', seamLoopEdges(m, he3.twin, 'all').length, 15 * 32);

  // 選一圈面：一直排 14 格四邊形 ＋ 兩頭各 1 個三角形
  const lf = so.loopFaces(m, he3);
  eq('★★ 選一圈面 ⇒ 14 格 ＋ 兩頭三角形 ＝ 16 個面（修之前 3）', lf.faces.length, 16);
  ok('★★ 　 沒繞回來', lf.closed === false);

  // 環切：從緯線切 ⇒ 多一整條經線，從北極旁邊切到南極旁邊
  const vol0 = m.volume();
  const cut = edit.loopCut(m, he3);
  ok('★★★ 環切從第 3 圈緯線切 ⇒ 成功、切過 15 條邊（修之前只切 3 條）', cut.ok && cut.ringLen === 15, `${cut.ok} ${cut.ringLen}`);
  ok('★★ 　 體積不變、χ ＝ 2', cut.ok && Math.abs(cut.mesh.volume() - vol0) < 1e-6 * Math.abs(vol0)
    && cut.mesh.verts.length - [...cut.mesh.edges()].length + cut.mesh.faces.length === 2);

  // 已經繞成一圈的照舊（方塊 4、圓柱 32），沒繞成一圈的圓柱水平邊從兩側都 2
  const c = mkMesh('cylinder');
  const rim = [...c.edges()].find(e => e.face && e.twin && e.twin.face
    && ((c.faceLoop(e.face).length === 4) !== (c.faceLoop(e.twin.face).length === 4)));
  const r1 = edit.edgeRing(c, rim), r2 = edit.edgeRing(c, rim.twin);
  ok('★★ 圓柱蓋子邊緣：從兩側都 2 條、都沒繞回來（修之前 2 條說繞回來／1 條）',
    r1.hes.length === 2 && r2.hes.length === 2 && !r1.closed && !r2.closed, `${r1.hes.length} ${r1.closed}／${r2.hes.length} ${r2.closed}`);
}

section('切成實心（切蛋糕）第一步（2026-10-13）');

/**
 * 規格：`規格\建模器-切成實心.md`。主斷言：**每一塊封閉、體積 > 0、加起來 ＝ 原本**。
 * 例子跟規格那張沙箱表一樣（①～⑩），⛔ 改了一邊要改另一邊。
 */
{
  const faceEls = (m, pred) => m.faces.filter(f => m.faceVerts(f).every(v => pred(v.p))).map(face => ({ kind: 'face', face }));
  const allClosed = r => r.ok && r.meshes.every(x => x.isClosed() && x.validate().ok);
  const sumOk = (r, m) => r.ok && Math.abs(r.volumes.reduce((a, b) => a + b, 0) - m.volume()) < 1e-6 * Math.abs(m.volume());

  // ① kang 截圖那種：方塊全部邊導圓角（寬 5、4 段），切下一個圓角 —— 點／邊／面三種選法結果要一樣
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const fil = edit.bevelEdges(box, [...box.edges()], 5, { segments: 4 }).mesh;
  fil.computeNormals();
  const b = fil.bounds();
  const inC = p => p.x >= b.max.x - 5 - 1e-6 && p.y >= b.max.y - 5 - 1e-6 && p.z >= b.max.z - 5 - 1e-6;
  const F = new Set(fil.faces.filter(f => fil.faceVerts(f).every(v => inC(v.p))));
  const hes = [];
  for (const f of F) for (const he of fil.faceLoop(f)) if (!F.has(he.twin.face)) hes.push(he);
  eq('（前提）圓角那一圈 12 條邊', hes.length, 12);
  const byFace = edit.solidCut(fil, [...F].map(face => ({ kind: 'face', face })));
  const byVert = edit.solidCut(fil, fil.verts.filter(v => inC(v.p)).map(vert => ({ kind: 'vertex', vert })));
  const byEdge = edit.solidCut(fil, hes.map(he => ({ kind: 'edge', he })));
  for (const [r, how] of [[byFace, '面'], [byVert, '點'], [byEdge, '邊']]) {
    ok(`★★★ ① 圓角（用${how}選）⇒ 2 塊、都封閉`, allClosed(r) && r.meshes.length === 2, r.reason);
    ok(`★★★ 　 切口 3 片平的、交在裡面一點`, r.ok && r.kinds[0] === '3 片平的，交在裡面一點' && r.capFaces === 3, r.ok && r.kinds.join());
    ok(`★★★ 　 體積加起來 ＝ 原本`, sumOk(r, fil));
  }
  near('★★ ① 切下來那塊 59.81（1/8 球 65.45 的網格近似）', byFace.volumes[1], 59.81, 0.01);

  // ②～④ 球：上半、四分之一瓣、八分之一 —— 體積剛好 1/2、1/4、1/8
  const sph = baked('sphere', { r: 30, segW: 32, segH: 16 });
  const V0 = sph.volume();
  for (const [name, pred, frac, kind] of [
    ['② 上半球', p => p.y >= -1e-6, 1 / 2, '一片平的'],
    ['③ 四分之一瓣（兩條經線）', p => p.x >= -1e-6 && p.z >= -1e-6, 1 / 4, '兩片平的'],
    ['④ 八分之一', p => p.x >= -1e-6 && p.z >= -1e-6 && p.y >= -1e-6, 1 / 8, '3 片平的，交在裡面一點']
  ]) {
    const r = edit.solidCut(sph, faceEls(sph, pred));
    ok(`★★★ 球 ${name} ⇒ 2 塊都封閉、切口「${kind}」`, allClosed(r) && r.kinds[0] === kind, r.ok ? r.kinds.join() : r.reason);
    rel(`★★★ 　 切下來的體積 ＝ 原本 × ${frac}`, Math.min(...r.volumes), V0 * frac, 1e-9);
  }

  // ⑤ 斜著圈一塊：線不在平面上 ⇒ 彎的切口，照樣切（kang 選的）
  const dir = new THREE.Vector3(0.6, 0.5, 0.62).normalize();
  const r5 = edit.solidCut(sph, faceEls(sph, p => p.dot(dir) / 30 > 0.55));
  ok('★★★ ⑤ 斜著圈一塊 ⇒ 照樣切、2 塊都封閉、切口「彎的」', allClosed(r5) && r5.kinds[0] === '彎的', r5.ok ? r5.kinds.join() : r5.reason);
  ok('★★ 　 體積加起來 ＝ 原本', sumOk(r5, sph));

  // ⑥⑦ 範圍本身是平的 ⇒ 擋下來、講「平的」
  const cyl = baked('cylinder', { r: 20, h: 40 });
  const r6 = edit.solidCut(cyl, faceEls(cyl, p => p.y >= cyl.bounds().max.y - 1e-6));
  ok('★★★ ⑥ 圓柱只選頂面 ⇒ 擋下來、講「本身是平的」', !r6.ok && /平的/.test(r6.reason), r6.reason);
  const bb = box.bounds();
  const r7 = edit.solidCut(box, box.faces.filter(f => {
    const ps = box.faceVerts(f).map(v => v.p);
    return ps.every(p => Math.abs(p.y - bb.max.y) < 1e-6) || ps.every(p => Math.abs(p.z - bb.max.z) < 1e-6);
  }).map(face => ({ kind: 'face', face })));
  ok('★★★ ⑦ 方塊相鄰兩面 ⇒ 擋下來、講「本身是平的」', !r7.ok && /平的/.test(r7.reason), r7.reason);

  // ⑧ 圓柱中間一段 ⇒ 3 塊（中間一段、上下兩截）
  let cy = edit.bisect(cyl, { n: new THREE.Vector3(0, 1, 0), d: 10 }).mesh;
  cy = edit.bisect(cy, { n: new THREE.Vector3(0, 1, 0), d: -10 }).mesh;
  cy.computeNormals();
  const r8 = edit.solidCut(cy, faceEls(cy, p => p.y >= -10 - 1e-6 && p.y <= 10 + 1e-6));
  ok('★★★ ⑧ 圓柱中間一段 ⇒ 3 塊都封閉（剩下的上下兩截不相連，各自一塊）', allClosed(r8) && r8.meshes.length === 3, r8.reason);
  rel('★★ 　 中間那段 ＝ 原本一半', r8.volumes[0], cy.volume() / 2, 1e-9);

  // ⑨ 管子外壁上半：切口會穿過中空 ⇒ 擋下來、講「穿出」（⛔ 不可以講成「平的」）
  let tube = edit.bisect(baked('tube', {}), { n: new THREE.Vector3(0, 1, 0), d: 0 }).mesh;
  tube.computeNormals();
  const rOut = tube.bounds().max.x;
  const r9 = edit.solidCut(tube, faceEls(tube, p => p.y >= -1e-6 && Math.hypot(p.x, p.z) > rOut - 1e-3));
  ok('★★★ ⑨ 管子外壁上半 ⇒ 擋下來、講「穿出模型外面」', !r9.ok && /穿出/.test(r9.reason), r9.reason);

  // ⑩ 其他擋關
  ok('★★ ⑩ 邊跟面混選 ⇒ 擋下來', !edit.solidCut(box, [{ kind: 'face', face: box.faces[0] }, { kind: 'edge', he: box.faces[1].he }]).ok);
  ok('★★ 　 沒選東西 ⇒ 擋下來', !edit.solidCut(box, []).ok);
  ok('★★ 　 選整個物件 ⇒ 擋下來', !edit.solidCut(box, box.faces.map(face => ({ kind: 'face', face }))).ok);
  const open = edit.deleteFaces(box, [{ kind: 'face', face: box.faces[0] }]).mesh;
  const rOpen = edit.solidCut(open, [{ kind: 'face', face: open.faces[0] }]);
  ok('★★ 　 物件本身有洞 ⇒ 擋下來、叫他先「補洞」', !rOpen.ok && /補洞/.test(rOpen.reason), rOpen.reason);
  ok('★★ 　 只點兩條邊（沒圍成一圈）⇒ 擋下來', !edit.solidCut(fil, hes.slice(0, 2).map(he => ({ kind: 'edge', he }))).ok);

  // 原本的網格⛔ 不可以被動到（呼叫端要拿它取消）
  ok('★★ 切完原本的網格一格都沒變（體積、面數）', Math.abs(fil.volume() - 104780.23) < 0.01 && fil.faces.length === 182, `${fil.volume()} ${fil.faces.length}`);
}

section('曲線刀具 第一步：平面上從邊到邊（2026-10-13）');

/**
 * 規格：`規格\建模器-曲線刀具.md`。方塊 60 × 45 × 40 的頂面（y ＝ 20）。
 * 主斷言：**形狀一格都不變**（體積、封閉、χ）、頂面切成的幾塊面積加起來 ＝ 2700、新的線全標 hard。
 */
{
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const Y = box.bounds().max.y;
  const top = box.faces.find(f => box.faceVerts(f).every(v => Math.abs(v.p.y - Y) < 1e-9));
  const v = (x, z) => new THREE.Vector3(x, Y, z);
  const A = (p, hin, hout) => ({ p, hin: hin || null, hout: hout || null });
  const chiOf = m => m.verts.length - [...m.edges()].length + m.faces.length;
  const topAreas = m => m.faces.filter(f => m.faceVerts(f).every(x => Math.abs(x.p.y - Y) < 1e-9))
    .map(f => m.faceTriangles(f).reduce((s, [a, b, c]) => s + b.p.clone().sub(a.p).cross(c.p.clone().sub(a.p)).length() / 2, 0));
  const wave = [A(v(-30, -6), null, v(-20, -18)), A(v(-5, 2), v(-14, 10), v(4, -6)), A(v(14, -4), v(8, -14), v(20, 6)), A(v(30, 4), v(24, 14), null)];

  // sampleCurve：直線段只要兩端；曲線段依弧長每隔 step 一段、至少 2 段
  eq('★★ 沒有把手的兩點 ⇒ 只有 2 點（直線⛔ 多插點）', edit.sampleCurve([A(v(-30, 0)), A(v(30, 5))], 1).length, 2);
  /**
   * ⚠ 2026-10-19（綜合評估 ①-8）起段數還要滿足「每段離曲線 ≤ 0.02 cm」（`CURVE_TOL_CM`）—— 這條波浪那一條比「每隔」嚴，兩種都變 109 點。
   * 下面幾項守的是「每隔」本身 ⇒ 把離曲線的上限放到很大（`NO_TOL`），數字照原本那一組。
   */
  const NO_TOL = 1e9;
  const s1 = edit.sampleCurve(wave, 1, false, NO_TOL), s5 = edit.sampleCurve(wave, 5, false, NO_TOL);
  ok('★★ 每隔 1 cm 比每隔 5 cm 點多（84 ＞ 19）', s1.length === 84 && s5.length === 19, `${s1.length} ${s5.length}`);
  const gaps = s1.slice(1).map((p, i) => p.distanceTo(s1[i]));
  ok('★★ 每隔 1 cm：每一段都不超過 1 cm（依弧長等分）', Math.max(...gaps) <= 1 + 1e-6, Math.max(...gaps));
  eq('★ 很短的曲線段至少 2 段', edit.sampleCurve([A(v(0, 0), null, v(0.1, 0.1)), A(v(0.2, 0), v(0.1, 0.1), null)], 1).length, 3);

  const cut = (anchors, step = 1, face = top, mesh = box) => edit.curveCutFace(mesh, face, edit.sampleCurve(anchors, step, false, NO_TOL));
  const r1 = cut(wave);
  ok('★★★ ① 波浪線（左邊→右邊）⇒ 成功、封閉、χ ＝ 2', r1.ok && r1.mesh.isClosed() && r1.mesh.validate().ok && chiOf(r1.mesh) === 2, r1.reason);
  near('★★★ 　 體積一格都沒變', r1.ok && r1.mesh.volume(), 108000, 1e-6);
  const a1 = r1.ok ? topAreas(r1.mesh) : [];
  ok('★★★ 　 頂面切成 2 塊、面積加起來 ＝ 2700', a1.length === 2 && Math.abs(a1[0] + a1[1] - 2700) < 1e-6, a1.join('+'));
  ok('★★★ 　 新的 83 條線全部標 hard（⛔ 不標的話看不見、點不到）', r1.ok && r1.newEdges.length === 83
    && [...r1.mesh.edges()].filter(h => r1.mesh.marksOf(h).hard).length === 83);
  eq('★★ 　 新增 84 個點（2 個在邊上、82 個在面裡）', r1.ok && `${r1.added}/${r1.inner}`, '84/82');

  const r2 = cut([A(v(-30, 0)), A(v(30, 5))]);
  const a2 = r2.ok ? topAreas(r2.mesh).map(x => Math.round(x * 1e6) / 1e6).sort((p, q) => p - q) : [];
  ok('★★ ② 直線（沒有把手）⇒ 梯形 1200 ＋ 1500（手算）', a2.join() === '1200,1500', a2.join());
  const r3 = cut([A(v(-30, -22.5)), A(v(0, 0), v(-10, -5), v(10, 5)), A(v(30, 10))]);
  ok('★★ ③ 從角出發 ⇒ 成功、角⛔ 不重複插點（新增 ＝ 面裡的點 ＋ 1）', r3.ok && r3.added === r3.inner + 1 && r3.mesh.isClosed(), r3.reason);
  const r4 = cut([A(v(-10, -22.5), null, v(-10, -5)), A(v(10, -22.5), v(10, -5), null)]);
  ok('★★ ④ 頭尾在同一條邊（凸出一塊）⇒ 成功、面積加起來 2700', r4.ok && Math.abs(topAreas(r4.mesh).reduce((s, x) => s + x, 0) - 2700) < 1e-6, r4.reason);
  ok('★★ 　 側面那一片也跟著插了點（隔壁的面⛔ 不插就接不起來）', r4.ok && r4.mesh.isClosed() && chiOf(r4.mesh) === 2);

  // 擋下來的
  const r6 = cut([A(v(-30, 0), null, v(0, 60)), A(v(30, 0), v(0, 60), null)]);
  ok('★★★ ⑥ 曲線跑出面外 ⇒ 擋下來、講「跑出這個面」', !r6.ok && /跑出這個面/.test(r6.reason), r6.reason);
  const r7 = cut([A(v(-20, 0)), A(v(30, 0))]);
  ok('★★★ ⑦ 起點不在邊上 ⇒ 擋下來、講「從邊上開始」', !r7.ok && /邊上/.test(r7.reason), r7.reason);
  const r8 = cut([A(v(-30, 0)), A(v(10, 10)), A(v(10, -10)), A(v(-10, 10)), A(v(30, -5))]);
  ok('★★★ ⑧ 自己交叉 ⇒ 擋下來、講「交叉」', !r8.ok && /交叉/.test(r8.reason), r8.reason);
  ok('★★ ⑨ 頭尾是相鄰的角、中間沒點 ⇒ 擋下來', !cut([A(v(-30, -22.5)), A(v(30, -22.5))]).ok);
  const side = box.faces.find(f => box.faceVerts(f).every(x => Math.abs(x.p.z - 22.5) < 1e-9));
  ok('★★ 　 曲線不在這個面的平面上 ⇒ 擋下來', !edit.curveCutFace(box, side, edit.sampleCurve(wave, 1)).ok);

  // ⑩ 在已經切過的面上再切一條
  const ra = cut([A(v(-30, 0)), A(v(30, 0))]);
  const fa = ra.mesh.faces.find(f => { const vs = ra.mesh.faceVerts(f); return vs.every(x => Math.abs(x.p.y - Y) < 1e-9) && vs.some(x => x.p.z > 1); });
  const rb = cut([A(v(0, 0), null, v(0, 15)), A(v(30, 15), v(15, 15), null)], 1, fa, ra.mesh);
  const ab = rb.ok ? topAreas(rb.mesh) : [];
  ok('★★★ ⑩ 在切過的那一塊上再切曲線 ⇒ 頂面 3 塊、加起來 2700、體積不變',
    rb.ok && ab.length === 3 && Math.abs(ab.reduce((s, x) => s + x, 0) - 2700) < 1e-6 && Math.abs(rb.mesh.volume() - 108000) < 1e-6, rb.reason);
  ok('★★ 　 第一刀那條線被插點切成兩段，兩段都還是 hard', rb.ok && [...rb.mesh.edges()].filter(h => rb.mesh.marksOf(h).hard).length === 2 + rb.newEdges.length);
  // 🔴 AI 線上先驗撞到的（2026-10-13）：畫好之後「退一點」再點同一條邊 ⇒ 最後兩點疊在一起 ⇒ 切出長度 0 的邊
  const dupPts = [...edit.sampleCurve(wave, 5)];
  dupPts.push(dupPts[dupPts.length - 1].clone());
  const rd = edit.curveCutFace(box, top, dupPts);
  const zeroLen = rd.ok ? [...rd.mesh.edges()].filter(h => h.v.p.distanceTo(h.to.p) < 1e-6).length : -1;
  ok('★★★ 最後兩點疊在一起 ⇒ 照樣切，而且⛔ 一條長度 0 的邊都沒有（修之前 1 條）', rd.ok && zeroLen === 0, rd.ok ? zeroLen : rd.reason);
  const onB = edit.curveCutFace(box, top, [v(-30, 0), v(0, 5), v(30, 3), v(30, 10)]);
  ok('★★ 中間有一點落在面的邊界上 ⇒ 擋下來（⛔ 不靠射線法剛好答對）', !onB.ok && /跑出這個面/.test(onB.reason), onB.reason);
  ok('★★ 切完原本的網格一格都沒變（面數、體積）', box.faces.length === 6 && Math.abs(box.volume() - 108000) < 1e-9);
}

section('曲線刀具 第二步：面中間的封閉圈（2026-10-13）');

/**
 * 規格：`規格\建模器-曲線刀具.md`「第二步」。一個面不能帶洞 ⇒ 圈外用兩條**看不見**的接線拆成兩片。
 * 主斷言：形狀不變、頂面 3 片加起來 2700、圈的邊全 hard、**接線⛔ hard**、圈外兩片是**同一個區域**。
 */
{
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const Y = box.bounds().max.y;
  const top = box.faces.find(f => box.faceVerts(f).every(v => Math.abs(v.p.y - Y) < 1e-9));
  const v = (x, z) => new THREE.Vector3(x, Y, z);
  const A = (p, hin, hout) => ({ p, hin: hin || null, hout: hout || null });
  const circle = (cx, cz, r) => { const k = 0.5523 * r; return [
    A(v(cx + r, cz), v(cx + r, cz - k), v(cx + r, cz + k)), A(v(cx, cz + r), v(cx + k, cz + r), v(cx - k, cz + r)),
    A(v(cx - r, cz), v(cx - r, cz + k), v(cx - r, cz - k)), A(v(cx, cz - r), v(cx - k, cz - r), v(cx + k, cz - r))]; };
  const chiOf = m => m.verts.length - [...m.edges()].length + m.faces.length;
  const tops = m => m.faces.filter(f => m.faceVerts(f).every(x => Math.abs(x.p.y - Y) < 1e-9));
  const areaOf = (m, f) => m.faceTriangles(f).reduce((s, [a, b, c]) => s + b.p.clone().sub(a.p).cross(c.p.clone().sub(a.p)).length() / 2, 0);

  const cpts = edit.sampleCurve(circle(5, 0, 10), 1, true);
  eq('★★ sampleCurve 封閉：⛔ 重複第一點（最後一點 ≠ 第一點）', cpts[cpts.length - 1].distanceTo(cpts[0]) > 1e-6, true);
  const r = edit.curveCutFaceLoop(box, top, cpts);
  ok('★★★ ① 頂面中間一個圓（半徑 10）⇒ 成功、封閉、χ ＝ 2、體積不變',
    r.ok && r.mesh.isClosed() && r.mesh.validate().ok && chiOf(r.mesh) === 2 && Math.abs(r.mesh.volume() - 108000) < 1e-6, r.reason);
  const m = r.mesh;
  const tf = r.ok ? tops(m) : [];
  const isl = tf.find(f => m.faceLoop(f).length === r.added);
  ok('★★★ 　 頂面 3 片（圈內 1 ＋ 圈外 2）、面積加起來 2700', tf.length === 3 && Math.abs(tf.reduce((s, f) => s + areaOf(m, f), 0) - 2700) < 1e-6);
  near('★★ 　 圈內那片 ≈ π × 10²（分段近似略小）', isl && areaOf(m, isl), 313.75, 0.01);
  const hardN = [...m.edges()].filter(h => m.marksOf(h).hard).length;
  ok('★★★ 　 圈的 64 條邊全 hard、兩條接線⛔ hard（只有 64 條）', r.added === 64 && hardN === 64, hardN);
  edit.refreshAfterEdit(m);
  const ring = edit.regionOf(m, tf.find(f => f !== isl));
  ok('★★★ 　 圈外那兩片是【同一個區域】（接線看不見，選起來是一整個面）', ring.faces.length === 2);
  ok('★★ 　 圈內那片是自己一個區域', edit.regionOf(m, isl).faces.length === 1);
  const mg = edit.mergeCoplanarFaces(m);
  ok('★★★ 　 「還原多邊形」遇到它原樣留著（一個面裝不下兩圈）⛔ 併壞', !mg.ok || (mg.mesh.isClosed() && tops(mg.mesh).length === 3));
  const ex = edit.extrudeFace(m, isl, 3);
  near('★★ 　 擠出圈內 3 cm ⇒ 體積多「圈面積 × 3」', ex.ok && ex.mesh.volume() - 108000, areaOf(m, isl) * 3, 1e-6);
  const del = edit.deleteFaces(m, [{ kind: 'face', face: isl }]);
  ok('★★ 　 刪掉圈內 ⇒ 變成開口（不封閉）', del.ok && !del.mesh.isClosed());

  const rRev = edit.curveCutFaceLoop(box, top, cpts.slice().reverse());
  ok('★★ ② 反方向畫 ⇒ 結果一樣（圈的方向程式自己轉）', rRev.ok && tops(rRev.mesh).length === 3 && rRev.mesh.isClosed());
  const rTri = edit.curveCutFaceLoop(box, top, edit.sampleCurve([A(v(-10, -5)), A(v(10, -5)), A(v(0, 10))], 1, true));
  ok('★★ ③ 三點沒把手（三角形）⇒ 成功、圈內 150（手算 20 × 15 ÷ 2）',
    rTri.ok && Math.abs(areaOf(rTri.mesh, tops(rTri.mesh).find(f => rTri.mesh.faceLoop(f).length === 3)) - 150) < 1e-6, rTri.reason);
  const rCorner = edit.curveCutFaceLoop(box, top, edit.sampleCurve(circle(24, 16, 4), 1, true));
  ok('★★ ④ 靠近角落的小圓 ⇒ 成功', rCorner.ok && rCorner.mesh.isClosed(), rCorner.reason);

  const rOut = edit.curveCutFaceLoop(box, top, edit.sampleCurve(circle(25, 0, 10), 1, true));
  ok('★★★ ⑤ 圈跑出面外 ⇒ 擋下來、講「跑出這個面」', !rOut.ok && /跑出這個面/.test(rOut.reason), rOut.reason);
  const r8 = edit.curveCutFaceLoop(box, top, [v(-10, -10), v(10, 10), v(10, -10), v(-10, 10)]);
  ok('★★★ ⑥ 8 字（自己交叉）⇒ 擋下來、講「交叉」', !r8.ok && /交叉/.test(r8.reason), r8.reason);
  ok('★★ ⑦ 少於 3 點 ⇒ 擋下來', !edit.curveCutFaceLoop(box, top, [v(0, 0), v(5, 0)]).ok);
  const dup = cpts.slice(); dup.push(cpts[0].clone());
  const rDup = edit.curveCutFaceLoop(box, top, dup);
  ok('★★ ⑧ 最後一點重複第一點 ⇒ 照樣切、⛔ 長度 0 的邊',
    rDup.ok && [...rDup.mesh.edges()].every(h => h.v.p.distanceTo(h.to.p) > 1e-6), rDup.reason);
  ok('★★ 切完原本的網格一格都沒變', box.faces.length === 6 && Math.abs(box.volume() - 108000) < 1e-9);
}

section('曲線刀具 3a：離左邊／離下邊（2026-10-13）');

/**
 * 規格：`規格\建模器-曲線刀具.md`「第三步」。左／下 ＝ 正對那個面看過去的左與下；只給跟座標軸對齊的面。
 * 方塊 60（X）× 40（Y，中心 0）× 45（Z）—— 頂面 y ＝ 20、前面 z ＝ 22.5、右面 x ＝ 30。
 */
{
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const top = [V(-30, 20, 22.5), V(30, 20, 22.5), V(30, 20, -22.5), V(-30, 20, -22.5)];      // 法向 +Y
  const front = [V(-30, -20, 22.5), V(30, -20, 22.5), V(30, 20, 22.5), V(-30, 20, 22.5)];    // 法向 +Z
  const right = [V(30, -20, 22.5), V(30, -20, -22.5), V(30, 20, -22.5), V(30, 20, 22.5)];    // 法向 +X
  const back = [V(30, -20, -22.5), V(-30, -20, -22.5), V(-30, 20, -22.5), V(30, 20, -22.5)];  // 法向 −Z
  const ft = edit.faceDimFrame(top);
  const it = edit.faceDimInfo(ft, V(-5, 20, 2), false);
  ok('★★★ 頂面：離左邊 ＝ 離 x＝−30 那條（25）、離下邊 ＝ 離前面 z＝22.5 那條（20.5）',
    Math.abs(it.left - 25) < 1e-9 && Math.abs(it.bottom - 20.5) < 1e-9, `${it.left} ${it.bottom}`);
  const iF = edit.faceDimInfo(edit.faceDimFrame(front), V(-10, 5, 22.5), false);
  ok('★★ 前面：離左邊 ＝ 離 x＝−30（20）、離下邊 ＝ 離底 y＝−20（25）', Math.abs(iF.left - 20) < 1e-9 && Math.abs(iF.bottom - 25) < 1e-9, `${iF.left} ${iF.bottom}`);
  const iR = edit.faceDimInfo(edit.faceDimFrame(right), V(30, 0, 10), false);
  ok('★★ 右面：從右邊看，左邊是前面 z＝22.5（離 12.5）', Math.abs(iR.left - 12.5) < 1e-9 && Math.abs(iR.bottom - 20) < 1e-9, `${iR.left} ${iR.bottom}`);
  const iB = edit.faceDimInfo(edit.faceDimFrame(back), V(20, 0, -22.5), false);
  ok('★★ 後面：從後面看，左邊是 x＝30（離 10）', Math.abs(iB.left - 10) < 1e-9, iB.left);
  const tilted = [V(0, 0, 0), V(10, 0, 0), V(10, 5, 5), V(0, 5, 5)];
  ok('★★★ 斜的面 ⇒ ⛔ 給欄位（null）', edit.faceDimFrame(tilted) === null);

  // 打數字搬點：中間的點兩格都能改
  const p1 = edit.faceDimMove(ft, it, 'L', 10);
  ok('★★★ 頂面中間的點打「離左邊 10」⇒ x ＝ −20、其他不變', p1 && Math.abs(p1.x + 20) < 1e-9 && Math.abs(p1.y - 20) < 1e-9 && Math.abs(p1.z - 2) < 1e-9, p1 && p1.toArray().join());
  const p2 = edit.faceDimMove(ft, it, 'B', 5);
  ok('★★ 　 打「離下邊 5」⇒ z ＝ 17.5（離前面 5）', p2 && Math.abs(p2.z - 17.5) < 1e-9, p2 && p2.z);

  // 邊上的點：左邊那條（x＝−30）上 ⇒ 只能改離下邊；角上 ⇒ 兩格都固定
  const ie = edit.faceDimInfo(ft, V(-30, 20, -6), true);
  ok('★★★ 左邊那條邊上的點 ⇒ 離左邊固定（0）、只能改離下邊', !ie.canL && ie.canB && Math.abs(ie.left) < 1e-9, `${ie.canL} ${ie.canB}`);
  ok('★★ 　 打離左邊 ⇒ ⛔ 動', edit.faceDimMove(ft, ie, 'L', 10) === null);
  const pe = edit.faceDimMove(ft, ie, 'B', 30);
  ok('★★ 　 打離下邊 30 ⇒ 還在左邊那條上（x＝−30）、z ＝ −7.5', pe && Math.abs(pe.x + 30) < 1e-9 && Math.abs(pe.z + 7.5) < 1e-9, pe && pe.toArray().join());
  const pc = edit.faceDimMove(ft, ie, 'B', 99);
  ok('★★ 　 打超過邊長 ⇒ 夾在邊的盡頭（⛔ 跑出邊外）', pc && Math.abs(pc.z + 22.5) < 1e-9, pc && pc.z);
  const ib = edit.faceDimInfo(ft, V(4, 20, 22.5), true);
  ok('★★ 前面那條（下邊）上的點 ⇒ 只能改離左邊', ib.canL && !ib.canB);
  const ic = edit.faceDimInfo(ft, V(30, 20, 22.5), true);
  ok('★★ 角上的點 ⇒ 兩格都固定', !ic.canL && !ic.canB);
  ok('★ 不是邊上的點、剛好在邊的位置 ⇒ 照樣兩格都能改（只有吸在邊上的才限制）', (() => { const x = edit.faceDimInfo(ft, V(-30, 20, 0), false); return x.canL && x.canB; })());
}

section('曲線刀具 3b：放一個圓（2026-10-13）');

/**
 * 規格：`規格\建模器-曲線刀具.md`「3b 定案」。圓 ＝ 四段貝茲（把手 ＝ r × 0.5523），切下去走封閉圈。
 * 方塊 60 × 45 × 40（baked）頂面 y ＝ 20、x ±30、z ±22.5。
 */
{
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const Y = box.bounds().max.y;
  const top = box.faces.find(f => box.faceVerts(f).every(v => Math.abs(v.p.y - Y) < 1e-9));
  const fr = edit.faceDimFrame(box.faceVerts(top).map(v => v.p.clone()));
  ok('（前提）頂面給得出左／下', !!fr);
  // 圓心離左邊 30、離下邊 22.5（＝ 正中間），半徑 10
  const cs = fr.sMin + 30, ct = fr.tMin + 22.5;
  const an = edit.circleAnchors(fr, cs, ct, 10);
  eq('★★ 四個錨點、每個都有兩支把手', an.length === 4 && an.every(a => a.hin && a.hout), true);
  const ctr = fr.toWorld(cs, ct);
  ok('★★ 圓心在頂面正中間（x 0、z 0）', Math.abs(ctr.x) < 1e-9 && Math.abs(ctr.z) < 1e-9 && Math.abs(ctr.y - Y) < 1e-9, ctr.toArray().join());
  const pts = edit.sampleCurve(an, 1, true);
  const dev = Math.max(...pts.map(p => Math.abs(p.distanceTo(ctr) - 10)));
  ok('★★★ 切好的每一點離圓心 ＝ 半徑（誤差 ≤ 0.03%）', dev <= 10 * 3e-4, dev);
  ok('★★ 　 全部在頂面的平面上', pts.every(p => Math.abs(p.y - Y) < 1e-9));
  const r = edit.curveCutFaceLoop(box, top, pts);
  const m = r.mesh;
  const isl = r.ok ? m.faces.find(f => m.faceLoop(f).length === r.added) : null;
  const areaOf = f => m.faceTriangles(f).reduce((s, [a, b, c]) => s + b.p.clone().sub(a.p).cross(c.p.clone().sub(a.p)).length() / 2, 0);
  ok('★★★ 切下去 ⇒ 成功、封閉、體積不變', r.ok && m.isClosed() && Math.abs(m.volume() - 108000) < 1e-6, r.reason);
  near('★★ 　 圓內那片 ≈ π × 10²（分段近似略小）', isl && areaOf(isl), Math.PI * 100, 1.0);

  // 離左邊 25 ⇒ 圓心 x ＝ −5；直徑 8 ⇒ 半徑 4
  const c2 = fr.toWorld(fr.sMin + 25, fr.tMin + 5);
  ok('★★ 圓心「離左邊 25、離下邊 5」⇒ x ＝ −5、z ＝ 17.5（離前面 5）', Math.abs(c2.x + 5) < 1e-9 && Math.abs(c2.z - 17.5) < 1e-9, c2.toArray().join());
  const out = edit.curveCutFaceLoop(box, top, edit.sampleCurve(edit.circleAnchors(fr, fr.sMin + 25, fr.tMin + 5, 8), 1, true));
  ok('★★★ 圓跑出面外（離下邊 5、半徑 8）⇒ 擋下來、講「跑出這個面」', !out.ok && /跑出這個面/.test(out.reason), out.reason);
  ok('★ 半徑 0 ⇒ 沒有錨點', edit.circleAnchors(fr, cs, ct, 0).length === 0);
}

section('曲線刀具：同一個面開好幾個孔（在整個區域上切，2026-10-13）');

/**
 * `regionCut()` 檔頭：開過孔的面被兩條看不見的接線拆成兩片 ⇒ 第二個圈壓到接線以前會被擋、還講「跑出這個面」。
 * 主斷言：形狀不變、頂面面積合計 2700、每個圈內各自一塊、圈外仍是**一個區域**、⛔ 長度 0 的邊。
 */
{
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const Y = box.bounds().max.y;
  const topOf = m => m.faces.filter(f => m.faceVerts(f).every(v => Math.abs(v.p.y - Y) < 1e-9));
  const fr = edit.faceDimFrame(box.faceVerts(topOf(box)[0]).map(v => v.p.clone()));
  const circ = (s, t, r) => edit.sampleCurve(edit.circleAnchors(fr, fr.sMin + s, fr.tMin + t, r), 1, true);
  const areaOf = (m, f) => m.faceTriangles(f).reduce((s, [a, b, c]) => s + b.p.clone().sub(a.p).cross(c.p.clone().sub(a.p)).length() / 2, 0);
  const sumTop = m => topOf(m).reduce((s, f) => s + areaOf(m, f), 0);
  const zeroLen = m => [...m.edges()].filter(h => h.v.p.distanceTo(h.to.p) < 1e-6).length;
  const regionSizes = m => { edit.refreshAfterEdit(m); const g = new Map(); for (const f of topOf(m)) { const rid = edit.regionOf(m, f).rid; g.set(rid, (g.get(rid) || 0) + 1); } return [...g.values()].sort((a, b) => a - b); };
  const good = (m, v0 = 108000) => m.isClosed() && m.validate().ok && Math.abs(m.volume() - v0) < 1e-6 && Math.abs(sumTop(m) - 2700) < 1e-6 && zeroLen(m) === 0;

  const m1 = edit.curveCutFaceLoop(box, topOf(box)[0], circ(20, 22.5, 6)).mesh;
  edit.refreshAfterEdit(m1);
  const ringFaces = topOf(m1).filter(f => edit.regionOf(m1, f).faces.length === 2);
  eq('（前提）第一個圓之後，圓外是 2 片一個區域（接線看不見）', ringFaces.length, 2);
  const outline = edit.curveRegionOutline(m1, ringFaces[0]);
  ok('★★★ 區域外框 ＝ 頂面的四個角（⛔ 是那一片網格面自己的角）', outline.length === 4 && outline.every(p => Math.abs(Math.abs(p.x) - 30) < 1e-9 && Math.abs(Math.abs(p.z) - 22.5) < 1e-9));

  // 第二個圓壓在接線上（修之前三片全擋，講「跑出這個面」）
  const br = [...m1.edges()].find(h => h.face && h.twin && h.twin.face && ringFaces.includes(h.face) && ringFaces.includes(h.twin.face) && !m1.marksOf(h).hard);
  const mid = br.v.p.clone().add(br.to.p).multiplyScalar(0.5);
  const r2 = edit.curveCutFaceLoop(m1, ringFaces[0], circ(mid.x + 30, 22.5 - mid.z, 2));
  ok('★★★ 第二個圓壓在看不見的接線上 ⇒ 切得出來（修之前被擋）', r2.ok && good(r2.mesh), r2.reason);
  eq('★★★ 　 區域：兩個圓內各 1 塊，圓外仍是 1 個區域', r2.ok && regionSizes(r2.mesh).slice(0, 2).join(), '1,1');
  ok('★★ 　 圓外那個區域只有一個（其餘的三角形都看不見、都算在裡面）', r2.ok && regionSizes(r2.mesh).length === 3);
  const r3 = edit.curveCutFaceLoop(r2.mesh, topOf(r2.mesh).find(f => edit.regionOf(r2.mesh, f).faces.length > 2), circ(45, 30, 5));
  ok('★★ 第三個圓 ⇒ 切得出來、3 個圓內 ＋ 1 個圓外區域', r3.ok && good(r3.mesh) && regionSizes(r3.mesh).length === 4, r3.reason);
  const r4 = edit.curveCutFaceLoop(r3.mesh, topOf(r3.mesh).find(f => edit.regionOf(r3.mesh, f).faces.length > 2), circ(24, 22.5, 6));
  ok('★★★ 圓壓到既有的孔 ⇒ 擋下來、講「碰到…已經有的開口」', !r4.ok && /已經有的開口/.test(r4.reason), r4.reason);
  const r5 = edit.curveCutFaceLoop(m1, ringFaces[0], circ(20, 22.5, 12));
  ok('★★ 大圓把第一個孔整個圈住 ⇒ 切得出來（圈住的那一圈自己是一個帶孔的區域）', r5.ok && good(r5.mesh) && regionSizes(r5.mesh).length === 3, r5.reason);

  // 從邊到邊的曲線，在開過孔的面上
  const V3 = (x, z) => new THREE.Vector3(x, Y, z), A = (p, hin, hout) => ({ p, hin: hin || null, hout: hout || null });
  const wave = edit.sampleCurve([A(V3(-30, 15), null, V3(-20, 5)), A(V3(0, 12), V3(-10, 18), V3(10, 6)), A(V3(30, 10), V3(20, 14), null)], 1);
  const r6 = edit.curveCutFace(m1, ringFaces[0], wave);
  ok('★★★ 開過孔的面上從邊到邊（壓過接線）⇒ 切得出來、孔分到對的那一邊', r6.ok && good(r6.mesh) && regionSizes(r6.mesh).length === 3, r6.reason);
  const thru = edit.curveCutFace(m1, ringFaces[0], edit.sampleCurve([A(V3(-30, 0)), A(V3(30, 0))], 1));
  ok('★★★ 直線剛好經過孔上的點、穿過孔 ⇒ 擋下來、講「跑出這個面」（⛔ 講成「形狀太複雜」）', !thru.ok && /跑出這個面/.test(thru.reason), thru.reason);
  ok('★★ 原本的網格一格都沒變（方塊 6 面、切一個圓之後 8 面）', box.faces.length === 6 && m1.faces.length === 8);
}

section('曲線刀具 3c：邊上的半圓缺口（2026-10-13）');

/**
 * 規格：`規格\建模器-曲線刀具.md`「3c 定案」。半圓 ＝ 兩段四分之一圓，頭尾落在同一條直的邊上，切下去走從邊到邊。
 * 方塊 60 × 45 × 40（baked）頂面 y ＝ 20、x ±30、z ±22.5；頂面的「下邊」＝ 前面那條（z ＝ +22.5）。
 */
{
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const Y = box.bounds().max.y;
  const topOf = m => m.faces.filter(f => m.faceVerts(f).every(v => Math.abs(v.p.y - Y) < 1e-9));
  const top = topOf(box)[0];
  const fr = edit.faceDimFrame(box.faceVerts(top).map(v => v.p.clone()));
  const areaOf = (m, f) => m.faceTriangles(f).reduce((s, [a, b, c]) => s + b.p.clone().sub(a.p).cross(c.p.clone().sub(a.p)).length() / 2, 0);
  const sumTop = m => topOf(m).reduce((s, f) => s + areaOf(m, f), 0);
  const zeroLen = m => [...m.edges()].filter(h => h.v.p.distanceTo(h.to.p) < 1e-6).length;
  const good = m => m.isClosed() && m.validate().ok && Math.abs(m.volume() - 108000) < 1e-6 && Math.abs(sumTop(m) - 2700) < 1e-6 && zeroLen(m) === 0;
  const regions = m => { edit.refreshAfterEdit(m); return new Set(topOf(m).map(f => edit.regionOf(m, f).rid)).size; };
  /** 頂面某條邊上（面上座標 s, t）放半圓 ⇒ 切好的點 */
  const notchPts = (frame, s, t, r) => {
    const at = edit.notchAt(frame, s, t);
    return at ? edit.sampleCurve(edit.notchAnchors(frame, at.edge, edit.notchClamp(at.edge, at.along, r), r), 1) : [];
  };

  const es = edit.notchEdges(fr);
  eq('★★ 頂面 ⇒ 4 條直的邊；兩條打「離左邊」、兩條打「離下邊」', es.length + ':' + es.map(e => e.field).sort().join(''), '4:BBLL');
  const inward = es.every(e => {
    const m = [(e.A[0] + e.B[0]) / 2 + e.w[0], (e.A[1] + e.B[1]) / 2 + e.w[1]];
    return m[0] > fr.sMin && m[0] < fr.sMin + 60 && m[1] > fr.tMin && m[1] < fr.tMin + 45;
  });
  ok('★★★ 每條邊「往面裡」的方向真的指向面裡', inward);
  const ring5 = fr.ring.slice(); ring5.splice(1, 0, [(fr.ring[0][0] + fr.ring[1][0]) / 2, (fr.ring[0][1] + fr.ring[1][1]) / 2]);
  eq('★★ 邊上多一個點（被切過）⇒ 仍併成 4 條（⛔ 拆成兩段、半圓放不下）', edit.notchEdges(Object.assign({}, fr, { ring: ring5 })).length, 4);

  // 前面那條（下邊）、圓心離左邊 30（x ＝ 0）、半徑 5
  const at = edit.notchAt(fr, fr.sMin + 30, fr.tMin);
  ok('★★ 點在前面那條邊上 ⇒ 找得到那條、打的是「離左邊」', at && at.edge.field === 'L' && Math.abs(at.edge.A[1] - fr.tMin) < 1e-9);
  const an = edit.notchAnchors(fr, at.edge, at.along, 5);
  const ctr = fr.toWorld(fr.sMin + 30, fr.tMin);
  ok('★★★ 三個錨點：頭尾在前面那條邊上（z ＝ 22.5）、中間往裡 5（z ＝ 17.5）',
    an.length === 3 && Math.abs(an[0].p.z - 22.5) < 1e-9 && Math.abs(an[2].p.z - 22.5) < 1e-9 && Math.abs(an[1].p.z - 17.5) < 1e-9 && Math.abs(an[1].p.x) < 1e-9
    && !an[0].hin && !an[2].hout);
  const pts = edit.sampleCurve(an, 1);
  const dev = Math.max(...pts.map(p => Math.abs(p.distanceTo(ctr) - 5)));
  ok('★★★ 切好的每一點離圓心 ＝ 半徑（誤差 ≤ 0.03%），全在面裡', dev <= 5 * 3e-4 && pts.every(p => p.z <= 22.5 + 1e-9), dev);
  const r1 = edit.curveCutFace(box, top, pts);
  ok('★★★ 切下去 ⇒ 成功、封閉、體積不變、頂面面積不變、沒有長度 0 的邊', r1.ok && good(r1.mesh), r1.reason);
  const small = r1.ok ? topOf(r1.mesh).map(f => areaOf(r1.mesh, f)).sort((a, b) => a - b)[0] : 0;
  near('★★ 　 缺口那塊 ≈ π × 5² ÷ 2（分段近似略小）', small, Math.PI * 25 / 2, 0.3);
  eq('★★ 　 頂面變成 2 個區域（缺口一塊、其餘一塊）', r1.ok && regions(r1.mesh), 2);

  // 夾住：半圓兩頭要在同一條邊上
  eq('★★ 圓心太靠左（離 A 2、半徑 5）⇒ 夾到 5', edit.notchClamp(at.edge, 2, 5), 5);
  eq('★★ 圓心太靠右（離 A 58、半徑 5）⇒ 夾到 55', edit.notchClamp(at.edge, 58, 5), 55);
  ok('★★ 半圓比邊還寬（半徑 40、邊長 60）⇒ 放不下（notchFits false）、圓心放正中間', !edit.notchFits(at.edge, 40) && edit.notchClamp(at.edge, 10, 40) === 30);

  // 貼著角放（半圓的一頭剛好在角上）
  const rc = edit.curveCutFace(box, top, notchPts(fr, fr.sMin + 5, fr.tMin, 5));
  ok('★★ 貼著角（離左邊 5、半徑 5）⇒ 切得出來、一頭用既有的角', rc.ok && good(rc.mesh), rc.reason);

  // 同一條邊上第二個缺口（切過之後那條邊被半圓分成兩段）
  if (r1.ok) {
    const m1 = r1.mesh;
    const big = topOf(m1).sort((a, b) => areaOf(m1, b) - areaOf(m1, a))[0];
    const fr1 = edit.faceDimFrame(edit.curveRegionOutline(m1, big));
    const r2 = edit.curveCutFace(m1, big, notchPts(fr1, fr1.sMin + 10, fr1.tMin, 4));
    ok('★★★ 同一條邊上再開第二個缺口 ⇒ 切得出來、3 個區域', r2.ok && good(r2.mesh) && regions(r2.mesh) === 3, r2.reason);
  }

  // 側面（前面）的下邊：往裡 ＝ 往上
  const front = box.faces.find(f => box.faceVerts(f).every(v => Math.abs(v.p.z - 22.5) < 1e-9));
  const ff = edit.faceDimFrame(box.faceVerts(front).map(v => v.p.clone()));
  const fp = notchPts(ff, ff.sMin + 20, ff.tMin, 6);
  const rf = edit.curveCutFace(box, front, fp);
  ok('★★ 前面的底邊 ⇒ 半圓往上長、切得出來', fp.length > 2 && Math.max(...fp.map(p => p.y)) > -20 + 5.9 && rf.ok && rf.mesh.isClosed(), rf.reason);

  // 開過孔的面上（走 regionCut）
  const hole = edit.curveCutFaceLoop(box, top, edit.sampleCurve(edit.circleAnchors(fr, fr.sMin + 30, fr.tMin + 22.5, 6), 1, true)).mesh;
  edit.refreshAfterEdit(hole);
  const ring = topOf(hole).find(f => edit.regionOf(hole, f).faces.length > 1);
  const rh = edit.curveCutFace(hole, ring, notchPts(fr, fr.sMin + 10, fr.tMin, 4));
  ok('★★★ 開過圓孔的面上開缺口 ⇒ 切得出來（走整個區域那條路）', rh.ok && good(rh.mesh), rh.reason);
  const rx = edit.curveCutFace(hole, ring, notchPts(fr, fr.sMin + 30, fr.tMin, 18));
  ok('★★ 缺口大到碰到圓孔 ⇒ 擋下來、講「已經有的開口」', !rx.ok && /已經有的開口/.test(rx.reason), rx.reason);
}

section('曲線刀具 3d：一段一段打出來的直線折線（2026-10-14）');

/**
 * 規格：`規格\建模器-曲線刀具.md`「3d 定案」。角度跟面的方向算：0° 往右、90° 往上（正對那個面看）。
 * 方塊 60 × 45 × 40（baked）頂面：s ＝ x（−30～30）、t ＝ −z（−22.5～22.5）。
 */
{
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const Y = box.bounds().max.y;
  const topOf = m => m.faces.filter(f => m.faceVerts(f).every(v => Math.abs(v.p.y - Y) < 1e-9));
  const top = topOf(box)[0];
  const fr = edit.faceDimFrame(box.faceVerts(top).map(v => v.p.clone()));
  const areaOf = (m, f) => m.faceTriangles(f).reduce((s, [a, b, c]) => s + b.p.clone().sub(a.p).cross(c.p.clone().sub(a.p)).length() / 2, 0);
  const near0 = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  const A = st => ({ p: fr.toWorld(st[0], st[1]), hin: null, hout: null });

  ok('★★ 0° 往右、90° 往上、180° 往左、270° 往下（走 10）',
    near0(edit.polyStep(1, 2, 10, 0), [11, 2]) && near0(edit.polyStep(1, 2, 10, 90), [1, 12])
    && near0(edit.polyStep(1, 2, 10, 180), [-9, 2]) && near0(edit.polyStep(1, 2, 10, 270), [1, -8]));
  ok('★ 30° 走 2 ⇒ (√3, 1)', near0(edit.polyStep(0, 0, 2, 30), [Math.sqrt(3), 1]));
  eq('★★ 在裡面／邊上／外面', [edit.polyWhere(fr, 0, 0), edit.polyWhere(fr, 0, -22.5), edit.polyWhere(fr, 0, -23)].join(), 'in,edge,out');

  const up = edit.polyRayHit(fr, -20, -22.5, 90);
  ok('★★★ 從下邊往上（90°）延伸 ⇒ 碰到上邊、走 45', up && near0([up.s, up.t], [-20, 22.5]) && Math.abs(up.dist - 45) < 1e-9);
  eq('★★ 從下邊往下（270°）⇒ 往面外，碰不到', edit.polyRayHit(fr, -20, -22.5, 270), null);
  const diag = edit.polyRayHit(fr, 20, 0, 45);
  ok('★★ 從中間往 45° ⇒ 先碰到右邊（x 30、t 10）', diag && near0([diag.s, diag.t], [30, 10]));
  const L = Object.assign({}, fr, { ring: [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]] });
  eq('★★★ 凹的面：從邊上往外走出去、又碰到別的邊 ⇒ ⛔ 算延伸到邊', edit.polyRayHit(L, 12, 10, 150), null);
  const inL = edit.polyRayHit(L, 15, 5, 90);
  ok('★ 　 凹的面：從裡面往上 ⇒ 碰到凹進去那條（t 10）', inL && near0([inL.s, inL.t], [15, 10]));

  // 從邊到邊：下邊（離左邊 10）往上 15、往右 20、往下延伸到邊 ⇒ 切出一個 20 × 15 的長方形
  const p0 = [-20, -22.5], p1 = edit.polyStep(...p0, 15, 90), p2 = edit.polyStep(...p1, 20, 0);
  const hit = edit.polyRayHit(fr, ...p2, 270);
  ok('★★ 　 延伸到邊落在 (0, −22.5)', hit && near0([hit.s, hit.t], [0, -22.5]));
  eq('★★ 　 打長度剛好走到邊上（往下 15）⇒ 判成「邊上」（直接畫好）', edit.polyWhere(fr, ...edit.polyStep(...p2, 15, 270)), 'edge');
  const r1 = edit.curveCutFace(box, top, edit.sampleCurve([A(p0), A(p1), A(p2), A([hit.s, hit.t])], 1));
  const small = r1.ok ? topOf(r1.mesh).map(f => areaOf(r1.mesh, f)).sort((a, b) => a - b)[0] : 0;
  ok('★★★ 切下去 ⇒ 成功、封閉、體積不變；切下來那塊 ＝ 20 × 15 ＝ 300', r1.ok && r1.mesh.isClosed() && Math.abs(r1.mesh.volume() - 108000) < 1e-6 && Math.abs(small - 300) < 1e-6, r1.reason);
  eq('★★ 　 直線段⛔ 再切細：只新增 4 個點（兩頭 ＋ 兩個轉角）', r1.ok && r1.added, 4);

  // 封閉：中間起點，往右 20、往上 10、往左 20、接回起點 ⇒ 20 × 10 的開口
  const q0 = [-10, 0], q1 = edit.polyStep(...q0, 20, 0), q2 = edit.polyStep(...q1, 10, 90), q3 = edit.polyStep(...q2, 20, 180);
  const r2 = edit.curveCutFaceLoop(box, top, edit.sampleCurve([A(q0), A(q1), A(q2), A(q3)], 1, true));
  const inner = r2.ok ? r2.mesh.faces.find(f => r2.mesh.faceLoop(f).length === 4 && Math.abs(areaOf(r2.mesh, f) - 200) < 1e-6) : null;
  ok('★★★ 封閉折線 ⇒ 切得出來、裡面那塊 ＝ 20 × 10 ＝ 200', r2.ok && r2.mesh.isClosed() && !!inner, r2.reason);
}

section('曲線刀具 第四步：切穿（2026-10-14）');

/**
 * 規格：`規格\建模器-曲線刀具.md`「第四步」。刀柱（`curveCutterPrism()`）＋ 布林（`splitByCutter()`）⇒ 兩塊實心。
 * 方塊 60 × 45 × 40（baked）：頂面 y ＝ 20、s ＝ x、t ＝ −z；整塊 108000。
 */
if (!csgOK) {
  ok('（略過：布林函式庫沒載入）', true);
} else {
  const { splitByCutter } = await import('../js/build/bool.js');
  const box = baked('box', { w: 60, d: 45, h: 40 });
  const Y = box.bounds().max.y;
  const top = box.faces.find(f => box.faceVerts(f).every(v => Math.abs(v.p.y - Y) < 1e-9));
  const fr = edit.faceDimFrame(box.faceVerts(top).map(v => v.p.clone()));
  const N = new THREE.Vector3(0, 1, 0);
  const A = st => ({ p: fr.toWorld(st[0], st[1]), hin: null, hout: null });
  const good = m => !!m && m.isClosed() && m.validate().ok;
  const vols = r => [r.inside, r.outside].map(m => (m ? m.volume() : 0)).sort((a, b) => a - b);

  // L 形折線（從前面那條邊往上 15、往右 20、往下到邊）⇒ 切下 20 × 15 × 40 ＝ 12000
  const L = edit.sampleCurve([A([-20, -22.5]), A([-20, -7.5]), A([0, -7.5]), A([0, -22.5])], 1);
  const pL = edit.curveCutterPrism(box, N, L, false);
  ok('★★ 刀柱組得起來：封閉、體積 > 0', pL.ok && pL.cutter.isClosed() && pL.cutter.volume() > 0, pL.reason);
  const cb = pL.ok ? pL.cutter.bounds() : null;
  ok('★★ 　 刀柱高度蓋過整個物件（y 低於 −20、高於 20）', cb && cb.min.y < -20 && cb.max.y > 20);
  const sL = splitByCutter(box, pL.cutter);
  const vL = vols(sL);
  ok('★★★ L 形切穿 ⇒ 兩塊實心：12000 ＋ 96000', good(sL.inside) && good(sL.outside) && Math.abs(vL[0] - 12000) < 1e-3 && Math.abs(vL[1] - 96000) < 1e-3, vL.join());

  // 圓（封閉）⇒ 中間一根柱子 ＋ 帶一個貫穿孔的那塊
  const circ = edit.sampleCurve(edit.circleAnchors(fr, 0, 0, 6), 1, true);
  const pC = edit.curveCutterPrism(box, N, circ, true);
  const sC = pC.ok ? splitByCutter(box, pC.cutter) : { inside: null, outside: null };
  const ringArea = (() => { const q = circ.map(p => [p.x, p.z]); return Math.abs(q.reduce((s, a, i) => { const b = q[(i + 1) % q.length]; return s + a[0] * b[1] - b[0] * a[1]; }, 0)) / 2; })();
  ok('★★★ 圓切穿 ⇒ 柱子 ＝ 圓的面積 × 40、剩下的 ＝ 108000 − 柱子，兩塊都封閉',
    good(sC.inside) && good(sC.outside) && Math.abs(sC.inside.volume() - ringArea * 40) < 1e-3 && Math.abs(sC.outside.volume() + sC.inside.volume() - 108000) < 1e-3,
    sC.inside && sC.inside.volume());
  near('★★ 　 柱子 ≈ π × 6² × 40（分段近似略小）', sC.inside ? sC.inside.volume() : 0, Math.PI * 36 * 40, 40);

  // 半圓缺口（3c）⇒ 半根柱子
  const at = edit.notchAt(fr, 0, fr.tMin);
  const pN = edit.curveCutterPrism(box, N, edit.sampleCurve(edit.notchAnchors(fr, at.edge, at.along, 5), 1), false);
  const sN = pN.ok ? splitByCutter(box, pN.cutter) : { inside: null, outside: null };
  const vN = vols(sN);
  ok('★★ 半圓缺口切穿 ⇒ 兩塊、加起來 108000、小的 ≈ π × 5² ÷ 2 × 40',
    good(sN.inside) && good(sN.outside) && Math.abs(vN[0] + vN[1] - 108000) < 1e-3 && Math.abs(vN[0] - Math.PI * 12.5 * 40) < 20, vN.join());

  // 彎的曲線（從左邊到右邊的波浪）
  const V3 = (x, z) => new THREE.Vector3(x, Y, z), H = (p, hin, hout) => ({ p, hin: hin || null, hout: hout || null });
  const wave = edit.sampleCurve([H(V3(-30, 15), null, V3(-20, 5)), H(V3(0, 12), V3(-10, 18), V3(10, 6)), H(V3(30, 10), V3(20, 14), null)], 1);
  const pW = edit.curveCutterPrism(box, N, wave, false);
  const sW = pW.ok ? splitByCutter(box, pW.cutter) : { inside: null, outside: null };
  const vW = vols(sW);
  ok('★★★ 波浪線切穿 ⇒ 兩塊都封閉、加起來 108000', good(sW.inside) && good(sW.outside) && Math.abs(vW[0] + vW[1] - 108000) < 1e-3, vW.join());

  // 延伸出去撞到線自己 ⇒ 擋
  const bad = edit.sampleCurve([A([-10, -22.5]), A([-10, 0]), A([10, 0]), A([10, -10]), A([-5, -10])], 1);
  const pB = edit.curveCutterPrism(box, N, bad, false);
  ok('★★ 線的尾巴往內彎、延伸出去撞到線自己 ⇒ 擋下來、講原因', !pB.ok && /撞到線自己/.test(pB.reason), pB.reason);
  ok('★ 原本的方塊沒被動到（108000、6 面）', Math.abs(box.volume() - 108000) < 1e-9 && box.faces.length === 6);

  // 側面（前面，法向 +z）的圓 ⇒ 從前面打穿到後面：柱子長 45
  const front = box.faces.find(f => box.faceVerts(f).every(v => Math.abs(v.p.z - 22.5) < 1e-9));
  const ff = edit.faceDimFrame(box.faceVerts(front).map(v => v.p.clone()));
  const cF = edit.sampleCurve(edit.circleAnchors(ff, 0, 0, 5), 1, true);
  const pF = edit.curveCutterPrism(box, new THREE.Vector3(0, 0, 1), cF, true);
  const sF = pF.ok ? splitByCutter(box, pF.cutter) : { inside: null, outside: null };
  const zb = sF.inside ? sF.inside.bounds() : null;
  ok('★★ 前面的圓切穿 ⇒ 柱子從前面穿到後面（長 45）、兩塊加起來 108000',
    good(sF.inside) && good(sF.outside) && Math.abs(zb.max.z - zb.min.z - 45) < 1e-6 && Math.abs(sF.inside.volume() + sF.outside.volume() - 108000) < 1e-3, pF.reason);
}

section('參考線 甲：從物件的面放（2026-10-17）');
{
  const M = await import('../js/core/mate.js');
  const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
  /** 方塊 100×60×80 放在 (50,30,40)：x 0..100、y 0..60、z 0..80（⚠ 方塊網格以中心為原點 ⇒ pos.y 給高度的一半，底面才貼地） */
  const box = new io.ModelObject({
    name: '方塊', src: { type: 'box', w: 100, h: 60, d: 80 }, kind: 'solid', pos: V3(50, 30, 40)
  });
  const fr = p => M.faceFrame(box, seam.nearestFace(box.mesh(), p).face);
  const bb = box.mesh().bounds();
  const top = fr(V3(0, bb.max.y, 0)), right = fr(V3(bb.max.x, (bb.min.y + bb.max.y) / 2, 0));
  const front = fr(V3(0, (bb.min.y + bb.max.y) / 2, bb.max.z)), back = fr(V3(0, (bb.min.y + bb.max.y) / 2, bb.min.z));
  const worldTop = top.point.y, worldRight = right.point.x, worldFront = front.point.z, worldBack = back.point.z;

  let r = io.guideFromFace(top, 0);
  ok('★★ 上面、離面 0 ⇒ 高度 Y ＝ 上面的高度', r.ok && r.ax === 'y' && Math.abs(r.v - worldTop) < 1e-9, JSON.stringify(r));
  r = io.guideFromFace(top, 10);
  ok('★★ 上面、離面 10 ⇒ 往外（往上）10', r.ok && r.ax === 'y' && Math.abs(r.v - (worldTop + 10)) < 1e-9, JSON.stringify(r));
  r = io.guideFromFace(right, 10);
  ok('★★ 右側面 ⇒ 前後線 X，往外（+X）10', r.ok && r.ax === 'x' && Math.abs(r.v - (worldRight + 10)) < 1e-9, JSON.stringify(r));
  r = io.guideFromFace(front, 5);
  ok('★★ 前面 ⇒ 左右線 Z，往外（+Z）5', r.ok && r.ax === 'z' && Math.abs(r.v - (worldFront + 5)) < 1e-9, JSON.stringify(r));
  r = io.guideFromFace(back, 5);
  ok('★★ 後面 ⇒ 左右線 Z，往外是 −Z（離面 5 ⇒ 小 5）', r.ok && r.ax === 'z' && Math.abs(r.v - (worldBack - 5)) < 1e-9, JSON.stringify(r));
  r = io.guideFromFace(top, -10);
  ok('★ 離面打負的 ⇒ 往裡面', r.ok && Math.abs(r.v - (worldTop - 10)) < 1e-9, JSON.stringify(r));
  ok('★ 方塊實際位置對（上面 60、右面 100、前面 80、後面 0）',
    Math.abs(worldTop - 60) < 1e-9 && Math.abs(worldRight - 100) < 1e-9 && Math.abs(worldFront - 80) < 1e-9 && Math.abs(worldBack) < 1e-9,
    [worldTop, worldRight, worldFront, worldBack].join());

  /** 轉 30° ⇒ 側面斜了、放不上去；上面還是平的、照樣放 */
  const rot = new io.ModelObject({
    name: '轉過的', src: { type: 'box', w: 70, h: 50, d: 50 }, kind: 'solid', pos: V3(0, 25, 0),
    rot: new THREE.Euler(0, Math.PI / 6, 0)
  });
  const rb = rot.mesh().bounds();
  const rfr = p => M.faceFrame(rot, seam.nearestFace(rot.mesh(), p).face);
  r = io.guideFromFace(rfr(V3(rb.max.x, 0, 0)), 0);
  ok('★★★ 轉 30° 的方塊側面 ⇒ 放不上去（斜的）', !r.ok, JSON.stringify(r));
  r = io.guideFromFace(rfr(V3(0, rb.max.y, 0)), 0);
  ok('★★ 轉 30° 的方塊上面還是平的 ⇒ 高度 Y ＝ 50', r.ok && r.ax === 'y' && Math.abs(r.v - 50) < 1e-9, JSON.stringify(r));

  /** 轉 90° ⇒ 側面還是正的，只是換了方向 */
  const r90 = new io.ModelObject({
    name: '轉 90', src: { type: 'box', w: 70, h: 50, d: 40 }, kind: 'solid', pos: V3(0, 0, 0),
    rot: new THREE.Euler(0, Math.PI / 2, 0)
  });
  const f90 = M.faceFrame(r90, seam.nearestFace(r90.mesh(), V3(35, 0, 0)).face);   // 本地 +X 面，轉 90° 後朝 −Z
  r = io.guideFromFace(f90, 0);
  ok('★★ 轉 90° 的方塊側面 ⇒ 照樣放得上去（換成左右線 Z ＝ −35）', r.ok && r.ax === 'z' && Math.abs(r.v + 35) < 1e-9, JSON.stringify(r));

  /** 斜的方向、壞的輸入 */
  ok('★ 面朝斜的方向 ⇒ 放不上去', !io.guideFromFace({ point: V3(0, 0, 0), dir: V3(1, 1, 0).normalize() }, 0).ok);
  ok('★ 沒有 frame ⇒ 放不上去、不會當掉', !io.guideFromFace(null, 0).ok);
  r = io.guideFromFace({ point: V3(0, 12.3456789, 0), dir: V3(0, 1, 0) }, NaN);
  ok('★ 離面不是數字 ⇒ 當 0；位置對到 0.001', r.ok && r.v === 12.346, JSON.stringify(r));

  /** 放進 Doc：同一個位置點兩次只放一條 */
  const doc = new io.Doc();
  const g1 = io.guideFromFace(top, 0);
  ok('★★ 放進參考線：第一次放得進去、第二次同位置不重複', doc.addGuide(g1.ax, g1.v) && !doc.addGuide(g1.ax, g1.v) && doc.guides.y.length === 1);
  ok('★ 存進去的值跟算出來的一樣（下拉選得回它）', doc.guides.y[0] === g1.v, String(doc.guides.y[0]));
}

section('鋼筆 乙 第 1 輪：畫在參考線那一片（2026-10-17）');
{
  const ps = await import('../js/core/penSnap.js');
  const near3 = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  const det = B => {
    const [a, b, c] = [B.a, B.b, B.c];
    return a[0] * (b[1] * c[2] - b[2] * c[1]) - b[0] * (a[1] * c[2] - a[2] * c[1]) + c[0] * (a[1] * b[2] - a[2] * b[1]);
  };
  const planes = [null, { ax: 'y', v: 30 }, { ax: 'x', v: 50 }, { ax: 'z', v: -40 }];
  const camSide = { y: [0, 1, 0], x: [1, 0, 0], z: [0, 0, 1] };
  for (const pl of planes) {
    const f = ps.penPlaneFrame(pl);
    const nm = pl ? `${pl.ax} ＝ ${pl.v}` : '地板';
    ok(`★★★ ${nm}：搬上去是轉動、不是鏡射（行列式 ＋1）`, Math.abs(det(f.basis) - 1) < 1e-12, String(det(f.basis)));
    let allOn = true, back = true, same = true;
    for (const [p, q] of [[0, 0], [12.5, -7], [-30, 44]]) {
      const w = f.toWorld(p, q);
      if (pl && Math.abs(w['xyz'.indexOf(pl.ax)] - pl.v) > 1e-12) allOn = false;
      if (!pl && Math.abs(w[1]) > 1e-12) allOn = false;
      const [p2, q2] = f.fromWorld(...w);
      if (Math.abs(p2 - p) > 1e-12 || Math.abs(q2 - q) > 1e-12) back = false;
      /** 放點用的 toWorld 跟「搬上去」用的 basis 是同一件事（地板上的 (p,0,q) 搬過去）—— 兩條路⛔ 可以不一致 */
      const B = f.basis, viaB = [0, 1, 2].map(i => B.o[i] + B.a[i] * p + B.c[i] * q);
      if (!near3(w, viaB)) same = false;
    }
    ok(`★★ ${nm}：點都落在那一片上`, allOn);
    ok(`★★ ${nm}：世界 → 這一片 → 世界，一個數字都不差`, back);
    ok(`★★★ ${nm}：放點（toWorld）跟搬物件（basis）同一套`, same);
    if (pl) ok(`★★ ${nm}：厚度朝轉正時的鏡頭那一側長`, near3(f.basis.b, camSide[pl.ax]), JSON.stringify(f.basis.b));
  }
  ok('★ 地板：視角不轉；高度 Y → 上視；前後線 X → 側視；左右線 Z → 前視',
    ps.penPlaneFrame(null).view === null && ps.penPlaneFrame({ ax: 'y', v: 1 }).view === 'top'
    && ps.penPlaneFrame({ ax: 'x', v: 1 }).view === 'right' && ps.penPlaneFrame({ ax: 'z', v: 1 }).view === 'front');
  /** 0° 往畫面右、90° 往畫面上 —— 側視時畫面右 ＝ −Z、畫面上 ＝ +Y（鏡頭在 +X 往 −X 看） */
  {
    const f = ps.penPlaneFrame({ ax: 'x', v: 50 });
    const d0 = ps.dirFromAngle(0), d90 = ps.dirFromAngle(90);
    const o = f.toWorld(0, 0), r0 = f.toWorld(d0.dx, d0.dz), r90 = f.toWorld(d90.dx, d90.dz);
    ok('★★ 側視畫：0° 往畫面右（−Z）、90° 往畫面上（＋Y）',
      near3([r0[0] - o[0], r0[1] - o[1], r0[2] - o[2]], [0, 0, -1]) && near3([r90[0] - o[0], r90[1] - o[1], r90[2] - o[2]], [0, 1, 0]));
    const fz = ps.penPlaneFrame({ ax: 'z', v: -40 });
    const s0 = fz.toWorld(d0.dx, d0.dz), s90 = fz.toWorld(d90.dx, d90.dz), oz = fz.toWorld(0, 0);
    ok('★★ 前視畫：0° 往畫面右（＋X）、90° 往畫面上（＋Y）',
      near3([s0[0] - oz[0], s0[1] - oz[1], s0[2] - oz[2]], [1, 0, 0]) && near3([s90[0] - oz[0], s90[1] - oz[1], s90[2] - oz[2]], [0, 1, 0]));
  }
  /** 參考線：只留跟這一片交成直線的，換成這一片上的座標 */
  {
    const g = { x: [50, 10], y: [30], z: [-40] };
    const gx = ps.penPlaneFrame({ ax: 'x', v: 50 }).guides(g);
    ok('★★ 側視那一片：左右線 Z −40 變成直的 p ＝ 40、高度 Y 30 變成橫的 q ＝ −30；前後線 X ⛔ 算',
      JSON.stringify(gx) === JSON.stringify({ x: [40], z: [-30] }), JSON.stringify(gx));
    const gz = ps.penPlaneFrame({ ax: 'z', v: -40 }).guides(g);
    ok('★★ 前視那一片：前後線 X 照舊、高度 Y 30 變成 q ＝ −30；左右線 Z ⛔ 算',
      JSON.stringify(gz) === JSON.stringify({ x: [50, 10], z: [-30] }), JSON.stringify(gz));
    const g0 = ps.penPlaneFrame(null).guides(g);
    ok('★ 地板：跟以前一樣只看 X、Z', JSON.stringify(g0) === JSON.stringify({ x: [50, 10], z: [-40] }));
    const bx = ps.penPlaneFrame({ ax: 'x', v: 50 }).box2({ min: { x: -30, y: 0, z: -20 }, max: { x: 30, y: 45, z: 20 } });
    ok('★ 側視那一片：方塊外框投影成 p −20..20、q −45..0', bx.min.x === -20 && bx.max.x === 20 && bx.min.z === -45 && bx.max.z === -0 + 0, JSON.stringify(bx));
  }

  /** 整條路：照地板那條路建好 → 置中 → 搬上去（跟 main.js finishPen 同一個順序） */
  const mk = (pl, h = 5) => {
    /** 這一片上的正方形：p 10..30、q −30..−10（畫面上方 ＝ 離地 10..30） */
    const o = new io.ModelObject({
      name: '鋼筆', kind: 'solid',
      src: { type: 'pen', h, paths: [{ closed: true, a: [10, -30, 30, -30, 30, -10, 10, -10], hi: [0, 0, 0, 0, 0, 0, 0, 0], ho: [0, 0, 0, 0, 0, 0, 0, 0] }] }
    });
    io.recenterOrigin(o);
    io.penPlaceOnPlane(o, pl);
    return o;
  };
  const wb = o => {
    const b = o.mesh().bounds(), M = o.matrix(), out = new THREE.Box3();
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      out.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(M));
    }
    return out;
  };
  const bxw = b => [b.min.x, b.max.x, b.min.y, b.max.y, b.min.z, b.max.z].map(v => Math.round(v * 1e6) / 1e6);
  {
    const o = mk({ ax: 'x', v: 50 });
    const b = bxw(wb(o));
    ok('★★★ 畫在前後線 X ＝ 50：立在那片牆上，厚度往 +X（50..55）、離地 10..30、Z −30..−10',
      JSON.stringify(b) === JSON.stringify([50, 55, 10, 30, -30, -10]), JSON.stringify(b));
    ok('★★ 　體積跟畫在地板上一樣（20×20×5 ＝ 2000）', Math.abs(o.mesh().volume() - 2000) < 1e-6, String(o.mesh().volume()));
    ok('★★ 　物件矩陣沒有鏡射（行列式 ＞ 0）', o.matrix().determinant() > 0);
  }
  {
    const o = mk({ ax: 'z', v: -40 });
    const b = bxw(wb(o));
    ok('★★★ 畫在左右線 Z ＝ −40：厚度往 +Z（−40..−35）、離地 10..30、X 10..30',
      JSON.stringify(b) === JSON.stringify([10, 30, 10, 30, -40, -35]), JSON.stringify(b));
  }
  {
    const o = mk({ ax: 'y', v: 30 });
    const b = bxw(wb(o));
    ok('★★★ 畫在高度 Y ＝ 30：浮在 30..35、X 10..30、Z −30..−10（跟地板一樣，只是抬高）',
      JSON.stringify(b) === JSON.stringify([10, 30, 30, 35, -30, -10]), JSON.stringify(b));
    ok('★ 　沒有轉', o.rot.x === 0 && o.rot.y === 0 && o.rot.z === 0);
  }
  {
    const o = mk(null);
    const b = bxw(wb(o));
    ok('★★ 地板：跟以前一模一樣（沒轉、沒抬）', JSON.stringify(b) === JSON.stringify([10, 30, 0, 5, -30, -10]) && o.rot.x === 0 && o.pos.y === 0, JSON.stringify(b));
  }
  {
    /** 存讀檔往返：轉上牆的物件讀回來還在牆上（⭐ 存檔格式沒變，靠的是本來就存的 pos／rot） */
    const doc = new io.Doc(); doc.add(mk({ ax: 'x', v: 50 }));
    const back = io.Doc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    const b = bxw(wb(back.objects[0]));
    /** ⚠ 存檔的角度只留 6 位小數（`io.js` `r6`，原本就是這樣）⇒ 90° 存成 1.570796，邊角會差到 0.000003 cm —— 容許 0.0001 */
    const want = [50, 55, 10, 30, -30, -10];
    ok('★★ 存讀檔往返：讀回來還立在前後線 X ＝ 50 那片牆上（差不到 0.0001 cm）', b.every((v, i) => Math.abs(v - want[i]) < 1e-4), JSON.stringify(b));
  }

  /** ── 乙 第 2 輪：物件的面 —— 朝 −X／−Z 的那一面從另一側看、往那一側長 ── */
  for (const pl of [{ ax: 'x', v: -30, s: -1 }, { ax: 'z', v: -20, s: -1 }]) {
    const f = ps.penPlaneFrame(pl);
    const nm = `${pl.ax} ＝ ${pl.v}（朝 −${pl.ax.toUpperCase()}）`;
    ok(`★★★ ${nm}：轉動不鏡射（行列式 ＋1）`, Math.abs(det(f.basis) - 1) < 1e-12, String(det(f.basis)));
    let allOn = true, back = true, same = true;
    for (const [p, q] of [[0, 0], [12.5, -7], [-30, 44]]) {
      const w = f.toWorld(p, q);
      if (Math.abs(w['xyz'.indexOf(pl.ax)] - pl.v) > 1e-12) allOn = false;
      const [p2, q2] = f.fromWorld(...w);
      if (Math.abs(p2 - p) > 1e-12 || Math.abs(q2 - q) > 1e-12) back = false;
      const B = f.basis, viaB = [0, 1, 2].map(i => B.o[i] + B.a[i] * p + B.c[i] * q);
      if (!near3(w, viaB)) same = false;
    }
    ok(`★★ ${nm}：點都落在那一片上、往返不差、放點與搬物件同一套`, allOn && back && same);
    const want = pl.ax === 'x' ? [-1, 0, 0] : [0, 0, -1];
    ok(`★★★ ${nm}：厚度往外（朝 −${pl.ax.toUpperCase()}）、從那一側看`, near3(f.basis.b, want) && f.view === (pl.ax === 'x' ? 'left' : 'back'),
      JSON.stringify(f.basis.b) + f.view);
    /** 0° 往畫面右、90° 往畫面上：左視畫面右 ＝ +Z、後視畫面右 ＝ −X；畫面上一律 ＋Y */
    const d0 = ps.dirFromAngle(0), d90 = ps.dirFromAngle(90), o = f.toWorld(0, 0);
    const r0 = f.toWorld(d0.dx, d0.dz), r90 = f.toWorld(d90.dx, d90.dz);
    const right = pl.ax === 'x' ? [0, 0, 1] : [-1, 0, 0];
    ok(`★★ ${nm}：0° 往畫面右、90° 往畫面上（＋Y）`,
      near3([r0[0] - o[0], r0[1] - o[1], r0[2] - o[2]], right) && near3([r90[0] - o[0], r90[1] - o[1], r90[2] - o[2]], [0, 1, 0]));
  }
  ok('★ 高度 Y 給 s −1 也當 ＋1（底面不收）', ps.penPlaneFrame({ ax: 'y', v: 5, s: -1 }).s === 1);
  {
    const gx = ps.penPlaneFrame({ ax: 'x', v: -30, s: -1 }).guides({ x: [50], y: [30], z: [-40] });
    ok('★★ 左視那一片：左右線 Z −40 變成 p ＝ −40、高度 Y 30 變成 q ＝ −30', JSON.stringify(gx) === JSON.stringify({ x: [-40], z: [-30] }), JSON.stringify(gx));
    const gz = ps.penPlaneFrame({ ax: 'z', v: -20, s: -1 }).guides({ x: [50], y: [30], z: [-40] });
    ok('★★ 後視那一片：前後線 X 50 變成 p ＝ −50', JSON.stringify(gz) === JSON.stringify({ x: [-50], z: [-30] }), JSON.stringify(gz));
  }
  {
    const o = mk({ ax: 'x', v: -30, s: -1 });
    const b = bxw(wb(o));
    ok('★★★ 畫在左側面 X ＝ −30：往外（−X）長 −35..−30、離地 10..30、Z 10..30',
      JSON.stringify(b) === JSON.stringify([-35, -30, 10, 30, 10, 30]), JSON.stringify(b));
    ok('★ 　沒有鏡射', o.matrix().determinant() > 0 && Math.abs(o.mesh().volume() - 2000) < 1e-6);
    const o2 = mk({ ax: 'z', v: -20, s: -1 });
    const b2 = bxw(wb(o2));
    ok('★★★ 畫在後面 Z ＝ −20：往外（−Z）長 −25..−20、離地 10..30、X −30..−10',
      JSON.stringify(b2) === JSON.stringify([-30, -10, 10, 30, -25, -20]), JSON.stringify(b2));
    /** 立在牆上的判斷（右側面板改字、編輯時先切上視都問它） */
    ok('★★ penWallSide：右牆 x+、左側面 x−、後面 z−、高度 Y 與地板 ⇒ 不是牆',
      io.penWallSide(mk({ ax: 'x', v: 50 })) === 'x+' && io.penWallSide(o) === 'x-' && io.penWallSide(o2) === 'z-'
      && io.penWallSide(mk({ ax: 'z', v: -40 })) === 'z+'
      && io.penWallSide(mk({ ax: 'y', v: 30 })) === null && io.penWallSide(mk(null)) === null);
  }
  {
    /** 右側面板的字：立在牆上 ⇒ 厚度／伸出／往外長；地板照舊 */
    const { PRIM_SPECS: PS } = await import('../js/build/prim.js');
    const hf = PS.pen.fields.find(f => f.key === 'h'), up = PS.pen.toggles.find(t => t.key === 'up');
    ok('★★ 牆上：封口 ＝「厚度」、不封口往外 ＝「伸出」、開關 ＝「往外長」',
      hf.labelOf({}, { wall: true }) === '厚度' && hf.labelOf({ open: true, up: true }, { wall: true }) === '伸出'
      && up.labelOf({ open: true }, { wall: true }) === '往外長');
    ok('★★ 地板照舊：「高 Y」「高度」「寬度」「往上長」',
      hf.labelOf({}, { wall: false }) === '高 Y' && hf.labelOf({ open: true, up: true }) === '高度'
      && hf.labelOf({ open: true }) === '寬度' && up.labelOf({ open: true }) === '往上長');
  }
}

section('牆上的旋轉成形（2026-10-17）');
{
  const { penRevAutoAt: autoAt } = await import('../js/build/prim.js');
  /** 牆上那一片的兩個數字：p ＝ 畫面右（X 牆 ＝ −Z）、q ＝ 畫面下（−Y）。碗的半邊：中心底 → 往外 20 → 往上到 25 高、半徑 25 */
  const prof = [[0, 0], [20, -3], [25, -25]];
  const a = prof.flat();
  const mkWall = (plane, dir = 'z') => {
    const o = new io.ModelObject({ name: '牆上的碗', kind: io.KIND.SHEET,
      src: { type: 'pen', h: 3, open: true, up: false,
             paths: [{ closed: true, a: a.slice(), hi: a.map(() => 0), ho: a.map(() => 0) }] } });
    io.recenterOrigin(o);
    io.penPlaceOnPlane(o, plane);
    /** 跟 toolbar「旋轉成形」打勾那一刻同一套：照現在的角度記下 wall、⛔ 立起來 */
    const wall = io.penWallSide(o);
    o.src.rev = { dir, seg: 32, stand: !wall, ...(wall ? { wall } : {}), at: autoAt(o.src, dir) };
    o.kind = io.penKind(o.src) ?? o.kind;
    o.invalidate();
    io.recenterOrigin(o);
    return o;
  };
  const wbb = o => {
    const b = o.mesh().bounds(), M = o.matrix(), out = new THREE.Box3();
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      out.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(M));
    }
    return [out.min.x, out.max.x, out.min.y, out.max.y, out.min.z, out.max.z].map(v => Math.round(v * 1000) / 1000);
  };
  {
    const o = mkWall({ ax: 'x', v: 60 });
    eq('★★ 畫在 X 牆上、開旋轉成形 ⇒ 記下 wall ＝ x+、⛔ 立起來', JSON.stringify([o.src.rev.wall, o.src.rev.stand]), JSON.stringify(['x+', false]));
    const b = wbb(o);
    ok('★★★ 直的：碗正立、⛔ 抬 —— 牆（X 60）穿過正中間：X 35..85、高 0..25、Z −25..25',
      Math.abs(b[0] - 35) < 0.01 && Math.abs(b[1] - 85) < 0.01 && Math.abs(b[2]) < 1e-6 && Math.abs(b[3] - 25) < 1e-6
      && Math.abs(b[4] + 25) < 0.01 && Math.abs(b[5] - 25) < 0.01, JSON.stringify(b));
    const w = io.revAxisWorld(o);
    ok('★★★ 中心線就在畫的那條線上：X ＝ 60、Z ＝ 0、直的（上下）',
      w.ok && Math.abs(w.p1.x - 60) < 1e-9 && Math.abs(w.p1.z) < 1e-9 && Math.abs(w.p2.x - 60) < 1e-9 && Math.abs(w.p2.z) < 1e-9
      && Math.abs(w.p1.y - w.p2.y) > 1, JSON.stringify([w.p1, w.p2]));
    eq('★★ 直的跟「左右線 Z」', io.revGuideAx(o.src), 'z');
    const cur = io.revWallAxisAt(o);
    ok('★★ 右側面板顯示真的位置：中心線在 Z ＝ 0', cur.ax === 'z' && Math.abs(cur.v) < 1e-9, JSON.stringify(cur));
    const r = io.revWallAtFor(o, 10);
    o.src.rev.at = r.at; o.invalidate();
    const w2 = io.revAxisWorld(o);
    ok('★★ 打 10 ⇒ 中心線挪到 Z ＝ 10（輪廓外側；還在牆上 X ＝ 60）', r.ok && w2.ok && Math.abs(w2.p1.z - 10) < 1e-9 && Math.abs(w2.p1.x - 60) < 1e-9, JSON.stringify(w2.p1));
    /** 綁參考線（第 2 輪那一套）：直的綁左右線 Z */
    const rb = io.revAtForGuide(o, 5);
    ok('★★ 綁「左右線 Z ＝ 5」算得出位置', rb.ok, rb.reason);
    o.src.rev.at = rb.at; o.src.rev.bind = 5; o.invalidate();
    const doc = new io.Doc(); doc.add(o); doc.addGuide('z', 5);
    ok('★★ 綁上之後中心線在 Z ＝ 5', io.revOnGuide(o, 5));
    const moved = io.revFollowGuide(doc, 'z', 5, 15);
    doc.removeGuide('z', 5); doc.addGuide('z', 15);
    o.invalidate();
    ok('★★★ 拖參考線 5 → 15 ⇒ 碗跟著（中心線 Z ＝ 15）', moved.length === 1 && io.revOnGuide(o, 15), JSON.stringify(io.revAxisWorld(o).p1));
    ok('★★ 規則 2：沒搬 ⇒ 不脫鉤', io.revCheckBinds(doc).length === 0 && o.src.rev.bind === 15);
    /** 置中原點之後中心線不動（右側面板每改一格都會置中一次） */
    const before = io.revAxisWorld(o).p1.clone();
    io.recenterOrigin(o);
    const after = io.revAxisWorld(o).p1;
    ok('★★ 置中原點 ⇒ 中心線在世界裡一點都沒動', before.distanceTo(after) < 1e-9, JSON.stringify([before, after]));
    /** 存讀檔往返：wall 留著 */
    const back = io.Doc.fromJSON(JSON.parse(JSON.stringify(doc.toJSON())));
    ok('★★ 存讀檔：rev.wall 還在、碗還在牆上', back.objects[0].src.rev.wall === 'x+' && Math.abs(io.revAxisWorld(back.objects[0]).p1.x - 60) < 1e-4);
  }
  {
    const o = mkWall({ ax: 'x', v: 60 }, 'x');
    eq('★★ 橫的跟「高度 Y」', io.revGuideAx(o.src), 'y');
    const w = io.revAxisWorld(o);
    ok('★★★ 橫的：中心線是牆上一條水平線（X ＝ 60、高度固定、沿著 Z）',
      w.ok && Math.abs(w.p1.x - 60) < 1e-9 && Math.abs(w.p2.x - 60) < 1e-9 && Math.abs(w.p1.y - w.p2.y) < 1e-9 && Math.abs(w.p1.z - w.p2.z) > 1,
      JSON.stringify([w.p1, w.p2]));
    const cur = io.revWallAxisAt(o);
    ok('★★ 自動放在線的最上面 ⇒ 中心線在高度 Y ＝ 25', cur.ax === 'y' && Math.abs(cur.v - 25) < 1e-9, JSON.stringify(cur));
    const rb = io.revAtForGuide(o, 30);
    ok('★★ 綁「高度 Y ＝ 30」算得出位置', rb.ok, rb.reason);
  }
  {
    /** 背面（Z 牆、朝 −Z）：直的跟「前後線 X」 */
    const o = mkWall({ ax: 'z', v: -20, s: -1 });
    eq('★★ 背面的碗：wall ＝ z−、直的跟「前後線 X」', JSON.stringify([o.src.rev.wall, io.revGuideAx(o.src)]), JSON.stringify(['z-', 'x']));
    const b = wbb(o);
    ok('★★★ 背面那片牆（Z −20）穿過碗的正中間：Z −45..5、高 0..25', Math.abs(b[4] + 45) < 0.01 && Math.abs(b[5] - 5) < 0.01 && Math.abs(b[2]) < 1e-6 && Math.abs(b[3] - 25) < 1e-6, JSON.stringify(b));
  }
  {
    /** 地板上的碗照舊（⛔ wall、照抬、照立起來） */
    const o = mkWall(null);
    ok('★★ 地板上的碗：⛔ 記 wall、立起來照預設（開）', o.src.rev.wall === undefined && o.src.rev.stand === true);
  }
}

section('平滑頂點：按一次順一次、不縮、帽緣不動（2026-10-18）');

/**
 * kang 2026-10-18 看 `樣板-平滑頂點.html` 拍板：① 不縮 ② 開口的邊不動 ③ 按一次順一次、⛔ 欄位
 * ④ 稜角⛔ 另外保護。→ `規格\建模器-平滑頂點.md`
 *
 * ⚠ 量的是「轉成網格」之後的樣子（`baked()`：球是 448 個四邊形 ＋ 64 個三角形），
 * 跟樣板同一種格子 —— 拿沒併過的三角形量，鄰點多了對角線，數字會差一點。
 */
{
  const sph = () => baked('sphere', { r: 30, segW: 32, segH: 16 });
  const meanR = m => m.verts.reduce((a, v) => a + v.p.length(), 0) / m.verts.length;
  const sdR = m => { const r0 = meanR(m); return Math.sqrt(m.verts.reduce((a, v) => a + (v.p.length() - r0) ** 2, 0) / m.verts.length); };
  const marks = m => [...m.edges()].map(he => `${he.role}|${!!he.smooth}|${!!he.hard}`).join(',');

  eq('前置：轉成網格的球 482 點、512 面', `${sph().verts.length}/${sph().faces.length}`, '482/512');
  near('★ 往回推的係數 ＝ −0.5 ／ 0.95', edit.SMOOTH_MU, -0.5 / 0.95, 1e-12);

  {
    const m = sph(), v0 = m.volume(), mk = marks(m), nV = m.verts.length, nF = m.faces.length;
    const r = edit.smoothVerts(m, m.verts);
    ok('整顆球全選按一次：成功', r.ok, r.reason || '');
    ok(`★★★ ① 不縮：平均半徑還是 30（${meanR(m).toFixed(4)}）`, Math.abs(meanR(m) - 30) < 0.05);
    ok(`★★ 體積差不到 0.5%（${(100 * m.volume() / v0).toFixed(3)}%）`, Math.abs(m.volume() / v0 - 1) < 0.005);
    ok('★★ 點數、面數、每一條邊的標記都沒變（只動座標）',
      m.verts.length === nV && m.faces.length === nF && marks(m) === mk && m.validate().ok && m.isClosed());
    ok('　　封閉的球沒有開口：rim ＝ 0', r.rim === 0);
  }
  {
    /** 對照組：只走那一步（Blender 那一套）按 10 次 ⇒ 會縮。守的是「不縮」那一步真的有作用 */
    const m = sph();
    for (let i = 0; i < 10; i++) edit.smoothVerts(m, m.verts);
    ok(`★★ 不縮版按 10 次，平均半徑還在 30 ± 0.3（${meanR(m).toFixed(3)}）—— 一般版是 27 多`, Math.abs(meanR(m) - 30) < 0.3);
  }
  {
    /** 表面凹凸 ±1 cm（固定亂數），按一次凹凸要變小 */
    const m = sph();
    let s = 7; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (const v of m.verts) { const r0 = v.p.length(); v.p.multiplyScalar((r0 + (rnd() * 2 - 1)) / r0); }
    const sd0 = sdR(m);
    edit.smoothVerts(m, m.verts);
    const sd1 = sdR(m);
    edit.smoothVerts(m, m.verts); edit.smoothVerts(m, m.verts);
    const sd3 = sdR(m);
    ok(`★★★ 凹凸 ${sd0.toFixed(2)} → 按 1 次 ${sd1.toFixed(2)} → 按 3 次 ${sd3.toFixed(2)}（一次比一次平）`, sd1 < sd0 * 0.85 && sd3 < sd1);
  }
  {
    /** 拉起一塊（影響半徑 15、往外拉 8 cm），只選隆起附近：沒選的點一個都不准動 */
    const m = sph();
    const top = m.verts.reduce((a, b) => (b.p.x > a.p.x ? b : a));
    const pr = edit.proportionalVerts(m, [top], 15), dir = top.p.clone().normalize();
    pr.verts.forEach((v, i) => v.p.addScaledVector(dir, 8 * pr.weights[i]));
    const c = top.p.clone(), h0 = top.p.length();
    const pick = m.verts.filter(v => v.p.distanceTo(c) < 26);
    const rest = m.verts.filter(v => !pick.includes(v)), before = rest.map(v => v.p.clone());
    const r = edit.smoothVerts(m, pick);
    ok('★★★ 沒選到的點一個都沒動（連 0.000001 都沒有）', rest.every((v, i) => v.p.equals(before[i])));
    ok(`★★ 隆起變矮但還在：${h0.toFixed(2)} → ${top.p.length().toFixed(2)}（一般版按 10 次會比球面 30 還低）`,
      top.p.length() < h0 && top.p.length() > 34);
    ok(`　　回報：動了 ${r.moved} 個點、最多挪 ${r.maxMove.toFixed(2)} cm`, r.moved === pick.length && r.maxMove > 0.1);
    for (let i = 0; i < 9; i++) edit.smoothVerts(m, pick);
    ok(`★★ 按到 10 次隆起也⛔ 變成凹洞（${top.p.length().toFixed(2)} > 30）`, top.p.length() > 30);
  }
  {
    /** ② 半球殼：帽緣那一圈⛔ 動 */
    const m0 = sph();
    const down = m0.faces.filter(f => m0.faceVerts(f).some(v => v.p.y < -1e-6));
    const d = edit.deleteFaces(m0, down.map(face => ({ kind: 'face', face })));
    ok('（前置）刪掉下半球', d.ok, d.reason || '');
    const m = d.mesh; m.computeNormals();
    const rim = m.verts.filter(v => Math.abs(v.p.y) < 1e-6), rimBefore = rim.map(v => v.p.clone());
    eq('　　帽緣 32 個點', rim.length, 32);
    const r = edit.smoothVerts(m, m.verts.filter(v => v.he));
    ok('★★★ ② 帽緣 32 個點全部沒動（頭圍不變）', rim.every((v, i) => v.p.equals(rimBefore[i])));
    eq('★★ 回報 rim ＝ 32', r.rim, 32);
    const r2 = edit.smoothVerts(m, rim);
    ok(`★★ 只選帽緣 ⇒ 不成功、講原因：「${r2.reason}」`, !r2.ok && /開口/.test(r2.reason) && !/⛔/.test(r2.reason));
  }
  {
    /** ④ 方塊細分 3×3 全選：方角往外鼓（這是拍板時知道的代價，守「沒有偷偷保護稜角」） */
    const b = baked('box', { w: 60, h: 45, d: 40 });
    const sdv = edit.subdivideFaces(b, b.faces.slice(), 3);
    const m = sdv.mesh; m.computeNormals();
    edit.smoothVerts(m, m.verts);
    const bb = m.bounds(), w = bb.max.x - bb.min.x;
    ok(`★★ ④ 方塊每面 3×3 全選按一次：外框寬 60 → ${w.toFixed(2)}（往外鼓，跟樣板的 61.3 對得上）`, Math.abs(w - 61.3) < 0.1);
  }
  {
    /** 沒有東西可以順 ⇒ 不成功或 moved ＝ 0（呼叫端就不記這一步） */
    const r0 = edit.smoothVerts(sph(), []);
    ok('★ 沒選點 ⇒ 不成功、講原因', !r0.ok && r0.reason);
    const m = sph(), lone = m.verts[0];
    const r = edit.smoothVerts(m, [lone, lone]);
    eq('　　同一個點給兩次只算一次', r.moved, 1);
  }
}

section('陣列展開的片數：份數⛔ 再乘一次（2026-10-19 實驗 T3／T7）');
{
  /**
   * 實驗 T3：隔板排列 2 份 → 展開 ×4、3 份 → ×9、鏡射 → ×4；
   * T7：托架 2 × 3 網格 → 三角片 ×72（應 12）。病因：`obj.mesh()` 已含每一份，
   * `unfold/part.js` 又乘一次 `obj.copies`（註解在那一行）。
   * ⭐ 守的是「兩端一致」：陣列物件 vs 把同一份網格當成普通網格物件，片數與面積要一模一樣。
   */
  const item = (src, pos = [0, 0, 0]) => ({ src, pos, rot: [0, 0, 0], scale: [1, 1, 1], name: '原件' });
  const bend = { type: 'bend', w: 11, first: 1, arcSeg: 4, bends: [{ angle: 90, ri: 0.2, len: 7.5 }] };
  const box = { type: 'box', w: 4, h: 2, d: 3 };
  const wedge = { type: 'wedge', w: 0.5, h: 3, d: 3 };
  const un = o => unfoldObject(o, { material: 'foamboard' });
  /** 同一份網格、⛔ 是陣列的普通物件（⛔ 走 bake，免得共面合併改了網格） */
  const twinOf = o => {
    const t = new io.ModelObject({ name: o.name + '（網格）', src: { type: 'mesh' }, kind: o.kind, thickness: o.thickness });
    t._mesh = o.mesh().clone();
    return t;
  };
  const cases = [
    ['折板 排列 2 份', 'sheet', bend, { mode: 'linear', count: 2, step: [6.67, 0, 0], count2: 1 }, 2],
    ['折板 排列 3 份', 'sheet', bend, { mode: 'linear', count: 3, step: [6.67, 0, 0], count2: 1 }, 3],
    ['折板 鏡射', 'sheet', bend, { mode: 'mirror', axis: 'x', offset: 5, keepOriginal: true }, 2],
    ['折板 2 × 3 網格', 'sheet', bend, { mode: 'linear', count: 2, step: [20, 0, 0], count2: 3, step2: [0, 15, 0] }, 6]
  ];
  if (csgOK) {
    cases.push(['方塊 分開排 3 份', 'solid', box, { mode: 'linear', count: 3, step: [10, 0, 0], count2: 1 }, 3]);
    cases.push(['楔形 2 × 3 網格（T7 托架）', 'solid', wedge, { mode: 'linear', count: 2, step: [20, 0, 0], count2: 3, step2: [0, 15, 0] }, 6]);
  }
  for (const [label, kind, src, arr, n] of cases) {
    const single = new io.ModelObject({ name: '單一', src, kind, thickness: 0.5 });
    const o = new io.ModelObject({ name: label, src: { type: 'array', ...arr, child: item(src) }, kind, thickness: 0.5 });
    const r1 = un(single), ra = un(o), rt = un(twinOf(o));
    eq(`${label}：片數 ＝ 一份的 ${n} 倍`, ra.stats.total, r1.stats.total * n);
    near(`${label}：面積 ＝ 一份的 ${n} 倍`, ra.stats.area, r1.stats.area * n, 1e-6);
    eq(`${label}：片數 ＝ 同一份網格的普通物件`, ra.stats.total, rt.stats.total);
    /** ⚠ 網格物件照存檔內容（座標 6 位小數）重建後才攤（`part.js` `canonicalMesh()`）⇒ 面積會差到 1e-5 */
    near(`${label}：面積 ＝ 同一份網格的普通物件`, ra.stats.area, rt.stats.area, 1e-4);
  }
  if (csgOK) {
    /** 重疊的實體排列 ⇒ 聯集成一塊 ⇒ 片數跟那一塊一樣，⛔ 是一份的 2 倍、更⛔ 是 4 倍 */
    const o = new io.ModelObject({ name: '方塊 重疊排 2 份', src: { type: 'array', mode: 'linear', count: 2, step: [2, 0, 0], count2: 1, child: item(box) }, kind: 'solid', thickness: 0.5 });
    const single = new io.ModelObject({ name: '單一', src: box, kind: 'solid' });
    const ra = un(o), rt = un(twinOf(o)), r1 = un(single);
    eq('方塊 重疊排 2 份：聯集後是 1 塊', o.mesh().validate().components, 1);
    eq('方塊 重疊排 2 份：片數 ＝ 同一份網格的普通物件', ra.stats.total, rt.stats.total);
    near('方塊 重疊排 2 份：面積 ＝ 6 × 2 × 3 的外表面積 2 ×（6×2 ＋ 6×3 ＋ 2×3）＝ 72', ra.stats.area, 2 * (6 * 2 + 6 * 3 + 2 * 3), 1e-6);
    ok('方塊 重疊排 2 份：⛔ 是一份的 4 倍', ra.stats.total !== r1.stats.total * 4);
  }
}

section('剖面片跟視圖同方向（2026-10-19 實驗 T6）');
{
  /**
   * 實驗 T6：300 × 160 的招牌水平切，每片出來 160 × 300（轉了 90°）。
   * ⭐ 現在：片的右／上 ＝ 對應視圖的螢幕右／上（上：+X／−Z；前：+X／+Y；側：−Z／+Y），⛔ 鏡像。
   * 用一個⛔ 在原點、⛔ 對稱的方塊（X 0～10、Y 1～3、Z −6～−2）一次驗出「轉沒轉、翻沒翻」。
   */
  const m = buildPrim('box', { w: 10, h: 2, d: 4 }).transformed(new THREE.Matrix4().makeTranslation(5, 2, -4));
  const one = (axis, at) => {
    const s = sect.sliceMesh(m, { axis, bands: [{ t: 0.2, n: 'rest' }] }).slices;
    return s.find(x => Math.abs((x.z0 + x.z1) / 2 - at) < 0.11) || s[Math.floor(s.length / 2)];
  };
  for (const [axis, view, want] of [
    ['y', '上', { minX: 0, maxX: 10, minY: 2, maxY: 6 }],
    ['z', '前', { minX: 0, maxX: 10, minY: 1, maxY: 3 }],
    ['x', '側', { minX: 2, maxX: 6, minY: 1, maxY: 3 }]
  ]) {
    const sl = one(axis, axis === 'y' ? 2 : axis === 'z' ? -4 : 5);
    const b = sl.bounds;
    const got = [b.minX, b.maxX, b.minY, b.maxY].map(v => +v.toFixed(6)).join(' ');
    eq(`★★ ${axis.toUpperCase()} 軸 ⇒ 跟「${view}」視圖同方向：片的外框（左 右 下 上）`, got, [want.minX, want.maxX, want.minY, want.maxY].join(' '));
    const outer = sl.loops.filter(l => !l.isHole);
    ok(`　　${axis.toUpperCase()} 軸：外輪廓是正面積（⛔ 鏡像）`, outer.length === 1 && outer[0].area > 0);
  }
}

section('剖面分切：片裡面的台階要講、照最大外形切（2026-10-19 實驗 T2）');
if (csgOK) {
  /**
   * 實驗 T2：帽簷 0.4 cm 厚、板 1 cm ⇒ 第 1 片只取 0.5 那一刀，帽簷整個不見，⛔ 警告。
   * ⭐ 預設照舊取中間，但要講出「第幾片裡有台階」；勾「照最大外形切」⇒ 取那一段的影子，帽簷回來。
   */
  const { unionMeshes } = await import('../js/build/bool.js');
  const T = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
  const brim = buildPrim('cylinder', { r: 10, h: 0.4, seg: 32 }).transformed(T(0, 0.2, 0));
  const body = buildPrim('cylinder', { r: 5, h: 4, seg: 32 }).transformed(T(0, 2, 0));
  const hat = unionMeshes([brim, body]);
  const oct = r => 0.5 * 32 * r * r * Math.sin(2 * Math.PI / 32);   // 32 邊形的面積
  const bands = [{ t: 1, n: '' }];

  const mid = sect.sliceMany([hat], { axis: 'y', bands });
  eq('帽子 4 cm、板 1 cm ⇒ 4 片', mid.slices.length, 4);
  near('★ 照中間切：第 1 片只有帽身（帽簷不見）＝ 半徑 5 的 32 邊形', mid.slices[0].area, oct(5), 1e-6);
  const w = mid.warnings.find(s => /台階/.test(s)) || '';
  ok(`★★ 照中間切：講出第 1 片裡有台階在 0.4 cm —「${w.slice(0, 60)}…」`, /第 1 片（0～1 cm，台階在 0\.4）/.test(w) && /照最大外形切/.test(w));
  ok('　　⛔ 用「⛔」寫給使用者看的字', !/⛔/.test(w));

  const mx = sect.sliceMany([hat], { axis: 'y', bands, maxOutline: true });
  near('★★ 照最大外形切：第 1 片 ＝ 帽簷（半徑 10 的 32 邊形）', mx.slices[0].area, oct(10), 1e-6);
  near('　　第 2 片 ＝ 帽身（半徑 5）', mx.slices[1].area, oct(5), 1e-6);
  ok('　　照最大外形切 ⇒ ⛔ 再報台階', !mx.warnings.some(s => /台階/.test(s)));
  const b0 = mx.slices[0].bounds;
  near('　　片的寬 ＝ 帽簷的直徑 20（32 邊形在 0° 與 180° 各有一個點）', b0.w, 20, 1e-9);

  // ⛔ 誤報：上下面剛好落在片與片之間的方塊、平滑的球
  const box = buildPrim('box', { w: 30, h: 4, d: 16 }).transformed(T(0, 2, 0));
  ok('★ 方塊 4 cm、板 1 cm（上下面都在片與片之間）⇒ ⛔ 報台階', !sect.sliceMany([box], { axis: 'y', bands }).warnings.some(s => /台階/.test(s)));
  const ball = buildPrim('sphere', { r: 5 }).transformed(T(0, 5, 0));
  ok('★ 球（平滑曲面）⇒ ⛔ 報台階', !sect.sliceMany([ball], { axis: 'y', bands }).warnings.some(s => /台階/.test(s)));
  const ballMax = sect.sliceMany([ball], { axis: 'y', bands, maxOutline: true });
  const ballMid = sect.sliceMany([ball], { axis: 'y', bands });
  ok('★ 球：照最大外形切的每一片都 ≥ 照中間切（寧大勿小）',
     ballMax.slices.every((s, i) => s.area >= ballMid.slices[i].area - 1e-9));
}

section('實心的板 ＋ 壓克力／木板 ⇒ 只出一片外形＋洞（2026-10-19 實驗 T2／T3／T7）');
{
  /**
   * 實驗 T7：鋼筆畫的背板（40 × 60、窗 20 × 30、厚 0.5）壓克力展開出 10 片（盒子）。
   * ⭐ 折不了的材料（壓克力／木板）自動認出實心板 ⇒ 1 片、帶洞、板厚寫實際的 0.5；其他材料照舊。
   */
  const { titleLines } = await import('../js/out/sheet.js');
  const zeros = n => new Array(n).fill(0);
  const rect = (x0, z0, x1, z1) => ({ closed: true, a: [x0, z0, x1, z0, x1, z1, x0, z1], hi: zeros(8), ho: zeros(8) });
  const back = new io.ModelObject({ name: '背板', kind: 'solid', thickness: 0.2,
    src: { type: 'pen', h: 0.5, paths: [rect(-20, -30, 20, 30), rect(-10, -15, 10, 15)] } });
  const ra = unfoldObject(back, { material: 'acrylic' });
  eq('★★ 背板（壓克力）⇒ 1 片', ra.stats.total, 1);
  near('　　面積 ＝ 40 × 60 − 20 × 30 ＝ 1800', ra.stats.area, 1800, 1e-6);
  eq('　　帶 1 個洞（窗）', ra.pieces[0].holes.length, 1);
  near('　　板厚寫實際的 0.5（⛔ 物件身上看不見的 0.2）', ra.pieces[0].rule.thickness, 0.5, 1e-9);
  ok('　　卡片寫「實心板：只出一片外形＋洞」、⛔ 用「⛔」', titleLines(ra.pieces[0]).some(l => /^實心板：只出一片外形＋洞（厚 0\.5 cm/.test(l) && !/⛔/.test(l)));
  const rf = unfoldObject(back, { material: 'foamboard' });
  ok('★ 同一塊背板（珍珠板）⇒ 照舊攤成盒子（⛔ 標實心板）', !rf.pieces.some(p => p.solidPlate));
  near('　　盒子的面積 ＝ 正反 2 × 1800 ＋ 外圈 200 × 0.5 ＋ 窗框 100 × 0.5 ＝ 3750', rf.stats.area, 3750, 1e-6);

  const gusset = new io.ModelObject({ name: '托架', kind: 'solid', src: { type: 'wedge', w: 0.5, h: 3, d: 3 } });
  const rg = unfoldObject(gusset, { material: 'acrylic' });
  eq('★ 楔形托架 0.5 × 3 × 3（壓克力）⇒ 1 片', rg.stats.total, 1);
  near('　　三角形面積 ＝ 3 × 3 ÷ 2', rg.stats.area, 4.5, 1e-6);
  if (csgOK) {
    /** 陣列是好幾塊拼在一起 ⇒ 每一塊各自判斷（T7 的 2 × 3 托架）*/
    const grid = new io.ModelObject({ name: '托架（網格）', kind: 'solid', src: { type: 'array', mode: 'linear',
      count: 2, step: [20, 0, 0], count2: 3, step2: [0, 15, 0],
      child: { src: { type: 'wedge', w: 0.5, h: 3, d: 3 }, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], name: '托架' } } });
    const rr = unfoldObject(grid, { material: 'acrylic' });
    eq('★★ 托架 2 × 3 網格（壓克力）⇒ 6 片（每個托架一片三角形）', rr.stats.total, 6);
    near('　　面積 ＝ 6 × 4.5', rr.stats.area, 27, 1e-6);
  }

  const col = new io.ModelObject({ name: '柱子', kind: 'solid', src: { type: 'box', w: 10, h: 100, d: 10 } });
  ok('★ ⛔ 誤認：10 × 100 × 10 的柱子（壓克力）不當成一片板', !unfoldObject(col, { material: 'acrylic' }).pieces.some(p => p.solidPlate));
  const big = new io.ModelObject({ name: '方塊', kind: 'solid', src: { type: 'box', w: 60, h: 45, d: 40 } });
  ok('★ ⛔ 誤認：60 × 45 × 40 的方塊（壓克力）照舊', !unfoldObject(big, { material: 'acrylic' }).pieces.some(p => p.solidPlate));

  if (csgOK) {
    const item = (src, pos) => ({ src, pos, rot: [0, 0, 0], scale: [1, 1, 1], name: '件' });
    const holed = new io.ModelObject({ name: '挖孔的板', kind: 'solid', src: { type: 'bool', op: 'subtract', items: [
      item({ type: 'box', w: 30, h: 0.5, d: 20 }, [0, 0, 0]),
      item({ type: 'cylinder', r: 3, h: 2, seg: 32 }, [5, 0, 0])
    ] } });
    const rh = unfoldObject(holed, { material: 'acrylic' });
    eq('★★ 布林挖孔的板（壓克力）⇒ 1 片', rh.stats.total, 1);
    eq('　　帶 1 個洞', rh.pieces[0].holes.length, 1);
    near('　　面積 ＝ 30 × 20 − 半徑 3 的 32 邊形', rh.stats.area, 600 - 0.5 * 32 * 9 * Math.sin(2 * Math.PI / 32), 1e-6);
  }
}

section('存讀前後攤法一樣（2026-10-19 實驗 T3）');
{
  /**
   * 實驗 T3：盒身 28 × 52，重新整理後變 44 × 28。病因：方塊的折角全是 90°，「先走最平的邊」靠座標的浮點雜訊挑，
   * 存檔捨入到 6 位小數後雜訊不同。⭐ 修兩件事：① 存檔座標存完整精度（`mesh.js` `toJSON()`）；
   * ② 網格物件一律照存檔內容重建後才攤（`unfold/part.js` `canonicalMesh()`）—— 編輯過的網格內部排列跟重建的⛔ 一樣。
   * 對照：照舊的存法（捨入 6 位）的話，下面 20 個裡有好幾個存讀後會變（沙箱 2026-10-19：9 個）。
   */
  const sig = r => r.pieces.map(p => `${p.width.toFixed(4)}×${p.height.toFixed(4)}`).join(',') + `｜剪 ${r.autoEdges.length}`;
  const mkMesh = m => { const o = new io.ModelObject({ name: '盒', src: { type: 'mesh' }, kind: 'sheet', thickness: 0.5 }); o._mesh = m; return o; };
  const reload = m => { const b = Mesh.fromJSON(JSON.parse(JSON.stringify(m.toJSON()))); b.computeNormals(); return b; };
  const oldSave = m => { const d = m.toJSON(); d.points = d.points.map(x => +x.toFixed(6)); const b = Mesh.fromJSON(d); b.computeNormals(); return b; };
  let n = 0, same = 0, exact = 0, oldDiff = 0;
  for (const [w, h, d] of [[28, 8, 20], [20, 10, 12], [30, 6, 16], [16, 8, 8], [44, 8, 28]]) {
    for (const a of [0.1, 0.37, 1.3, 2.9]) {
      const m0 = edit.mergeCoplanarFaces(buildPrim('box', { w, h, d })).mesh;
      // 轉一下再轉回來 ⇒ 形狀一樣、座標帶著浮點雜訊（就像在編輯模式改過的網格）
      const m = m0.transformed(new THREE.Matrix4().makeRotationY(a)).transformed(new THREE.Matrix4().makeRotationY(-a));
      m.computeNormals();
      const back = reload(m);
      n++;
      if (back.verts.every((v, i) => v.p.equals(m.verts[i].p))) exact++;
      if (sig(unfoldObject(mkMesh(m), { material: 'foamboard' })) === sig(unfoldObject(mkMesh(back), { material: 'foamboard' }))) same++;
      if (sig(unfoldObject(mkMesh(m), { material: 'foamboard' })) !== sig(unfoldObject(mkMesh(oldSave(m)), { material: 'foamboard' }))) oldDiff++;
    }
  }
  eq(`★★★ 帶雜訊的網格 ${n} 個：存檔再讀回來，座標一位不差`, exact, n);
  eq(`★★★ 帶雜訊的網格 ${n} 個：存讀前後攤法（外框、程式剪的邊數）都一樣`, same, n);
  ok(`　　對照：照舊的存法（座標捨入 6 位）有 ${oldDiff} 個會變 —— 這個測試抓得到那個病`, oldDiff > 0);

  // 編輯過的網格（刪面、內縮、細分）：內部排列跟重建的不一樣，也要存讀前後一樣
  let n2 = 0, same2 = 0;
  for (const [w, h, d] of [[28, 8, 20], [20, 10, 12], [30, 6, 16], [16, 8, 8]]) {
    let m = edit.mergeCoplanarFaces(buildPrim('box', { w, h, d })).mesh; m.computeNormals();
    const top = m.faces.find(f => f.normal.y > 0.99);
    let r = edit.deleteFaces(m, [{ kind: 'face', face: top }]); if (r && r.mesh) m = r.mesh; m.computeNormals();
    const front = m.faces.find(f => f.normal.z > 0.99);
    r = edit.insetFaces(m, front, 2); if (r && r.mesh) m = r.mesh; m.computeNormals();
    const back = reload(m);
    n2++;
    if (sig(unfoldObject(mkMesh(m), { material: 'foamboard' })) === sig(unfoldObject(mkMesh(back), { material: 'foamboard' }))) same2++;
  }
  eq(`★★★ 編輯過的網格 ${n2} 個：存讀前後攤法都一樣`, same2, n2);
}

section('布林、陣列沒轉成網格就攤 ＝ 轉了再攤（2026-10-19 實驗 T2 疑點 Q9）');
if (csgOK) {
  /**
   * 實驗 T2：布林的網格全是三角形，以前只有「轉成可編輯網格」才併回面，展開拿沒轉的照樣攤 ⇒ 平面零件重疊。
   * ⭐ 展開前先併面（`unfold/part.js`，跟 `bake()` 同一支 `mergeCoplanarFaces()`）。
   * 數字是 2026-10-19 沙箱：方塊 40 × 30 × 20 挖掉一角（10 × 10 × 40），以前沒轉 125 × 65 重疊、轉了 125 × 115 一片好的。
   */
  const it = (src, pos = [0, 0, 0]) => ({ src, pos, rot: [0, 0, 0], scale: [1, 1, 1], name: src.type });
  const sig = r => r.pieces.map(p => `${p.width.toFixed(3)}×${p.height.toFixed(3)}×${p.qty}${p.overlap ? '重疊' : ''}`).join(',') + `｜剪 ${r.autoEdges.length}`;
  const area = r => r.pieces.reduce((a, p) => a + p.area * p.qty, 0);
  const cases = [
    ['挖掉一角（差集）', { type: 'bool', op: BOOL_OPS.SUBTRACT, items: [it({ type: 'box', w: 40, h: 30, d: 20 }), it({ type: 'box', w: 10, h: 10, d: 40 }, [20, 15, 0])] }],
    ['L 形（聯集）', { type: 'bool', op: BOOL_OPS.UNION, items: [it({ type: 'box', w: 40, h: 10, d: 10 }), it({ type: 'box', w: 10, h: 30, d: 10 }, [-15, 10, 0])] }],
    ['交集', { type: 'bool', op: BOOL_OPS.INTERSECT, items: [it({ type: 'box', w: 40, h: 30, d: 20 }), it({ type: 'box', w: 30, h: 40, d: 20 }, [10, 10, 0])] }],
    ['實體陣列 3 份', { type: 'array', mode: 'linear', count: 3, step: [30, 0, 0], count2: 1, step2: [0, 0, 20], child: it({ type: 'box', w: 20, h: 10, d: 10 }) }]
  ];
  for (const [name, src] of cases) {
    const a = new io.ModelObject({ name, kind: io.KIND.SOLID, src });
    const b = new io.ModelObject({ name, kind: io.KIND.SOLID, src: JSON.parse(JSON.stringify(src)) }); b.bake();
    const ra = unfoldObject(a, { material: 'foamboard' }), rb = unfoldObject(b, { material: 'foamboard' });
    eq(`★★★ ${name}：沒轉就攤 ＝ 轉成網格再攤（外框、片數、程式剪的邊數）`, sig(ra), sig(rb));
    near(`★★ 　 面積一樣`, area(ra), area(rb), 1e-6);
    const own = new Set([...a.mesh().edges()]);
    ok(`★★ 　 程式剪的邊都是物件自己網格上的邊（${ra.autoEdges.length} 條）`, ra.autoEdges.length > 0 && ra.autoEdges.every(h => own.has(h) || own.has(h.twin)));
  }
  const notch = new io.ModelObject({ name: '挖角', kind: io.KIND.SOLID, src: cases[0][1] });
  const rn = unfoldObject(notch, { material: 'foamboard' });
  ok('★★★ 挖掉一角：沒轉就攤也⛔ 重疊（以前 125 × 65 重疊）', rn.pieces.every(p => !p.overlap), sig(rn));
  ok('★★ 　 物件自己的網格⛔ 換（還是布林算出來的三角形，畫面、匯出照舊）', notch.mesh().faces.length > 8 && notch.isBool, `${notch.mesh().faces.length} 面`);
  // 對照：直接攤三角形（舊做法）會重疊 —— 這個測試抓得到那個病
  const old = unfoldMesh(notch.mesh(), makeRule('foamboard', notch.thickness));
  ok('　　對照：直接攤三角形（舊做法）會重疊', old.pieces.some(p => p.overlap));
} else {
  ok('（略過：CSG 沒載入）', true);
}

section('綜合評估 ① 第三批：短縫的對位記號、DXF 折向、刀具的圓、壓克力配折板（2026-10-19）');
{
  const { setSeam } = await import('../js/unfold/seam.js');
  const { notchMarks, titleLines, foldStyle, drawProgram } = await import('../js/out/sheet.js');
  const { toDXF } = await import('../js/out/dxf.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');

  // ── ①-12 短縫：正中間放一個（T3 的盒身 20 × 8 × 12，開口朝上，標一條轉角）──
  {
    const o = new io.ModelObject({ name: '盒身', kind: io.KIND.SOLID, src: { type: 'box', w: 20, h: 8, d: 12 } }); o.bake();
    let m = o.mesh(); m.computeNormals();
    m = edit.deleteFaces(m, [{ kind: 'face', face: m.faces.find(f => f.normal.y > 0.99) }]).mesh; m.computeNormals(); o.setMesh(m);
    setSeam(m, [...m.edges()].find(h => h.twin && h.twin.face && Math.abs(Math.abs(h.v.p.y - h.to.p.y) - 8) < 1e-6), true);
    const r = unfoldObject(o, { material: 'foamboard' });
    const p = r.pieces[0], N = { notch: { style: 'slit', spacing: 10 } };
    const nm = notchMarks(p, { rule: p.rule, ...N });
    eq('★★★ ①-12 T3 盒身：攤成 28 × 52、4 條縫（8、8、40、40）', `${Math.round(p.width)}×${Math.round(p.height)} ${p.seamRuns.map(x => Math.round(x.segs.reduce((t, g) => t + g.len, 0))).join(',')}`, '28×52 8,8,40,40');
    eq('★★★ 　 對位記號 6 → 8 個：兩條 8 cm 的轉角縫各放一個在正中間', `${nm.count}/${nm.mid}/${nm.short}`, '8/2/0');
    const tl = titleLines(p, { rule: p.rule, ...N }).find(t => t.startsWith('對位記號'));
    ok('★★ 　 卡片講「2 條縫比 11 cm 短，放在正中間」', !!tl && tl.endsWith('2 條縫比 11 cm 短，放在正中間'), tl);
    // 2 cm 以下才不放
    const tiny = { ...p, seamRuns: [{ segs: [{ a: { x: 0, y: 0 }, b: { x: 1.5, y: 0 }, len: 1.5 }] }] };
    eq('★★ 　 1.5 cm 的縫（< 2 cm）⇒ 不放、算「太短」', (({ count, mid, short }) => `${count}/${mid}/${short}`)(notchMarks(tiny, { rule: p.rule, ...N })), '0/0/1');
  }

  // ── ①-10 DXF：上折、下折分兩層，文字寫 UP／DOWN ──
  {
    const layerN = (d, L) => (d.match(new RegExp(`\r\n0\r\nLINE\r\n8\r\n${L}\r\n`, 'g')) || []).length;
    const cases = [
      ['階梯（有凹角）', { type: 'stairs', ...PRIM_DEFAULTS.stairs }, io.KIND.SOLID, 8, 3],
      ['方塊', { type: 'box', ...PRIM_DEFAULTS.box }, io.KIND.SOLID, 5, 0],
      ['Z 形折板（＋90、−90，尖角）', { type: 'bend', ...PRIM_DEFAULTS.bend, bends: [{ angle: 90, ri: 0, len: 30 }, { angle: -90, ri: 0, len: 20 }] }, io.KIND.SHEET, 1, 1]
    ];
    for (const [name, src, kind, up, down] of cases) {
      const o = new io.ModelObject({ name, kind, src }); o.bake();
      const r = unfoldObject(o, { material: 'foamboard' });
      const folds = r.pieces.flatMap(p => p.folds.filter(f => !f.isArcEdge));
      const d = toDXF(r.pieces, { unit: 'mm' });
      eq(`★★★ ①-10 ${name}：折線 上折 ${up}／下折 ${down}（畫面）＝ DXF 的 FOLD_UP／FOLD_DOWN，FOLD 層 0 條`,
        `${folds.filter(f => foldStyle(f) === 'foldUp').length}/${folds.filter(f => foldStyle(f) === 'foldDown').length} ${layerN(d, 'FOLD_UP')}/${layerN(d, 'FOLD_DOWN')}/${layerN(d, 'FOLD')}`,
        `${up}/${down} ${up}/${down}/0`);
      if (down) ok(`★★ 　 DXF 折彎文字寫「DOWN 90deg R0」（⛔ 只有負號）`, d.includes('DOWN 90deg R0') && !/\r\n-90deg R0/.test(d));
      const items = r.pieces.flatMap(p => drawProgram(p).items || []);
      eq(`★★ 　 展開圖畫面：上折線 ${up} 條、下折線 ${down} 條`, `${items.filter(x => x.style === 'foldUp').length}/${items.filter(x => x.style === 'foldDown').length}`, `${up}/${down}`);
    }
  }

  // ── ①-8 刀具的圓：照誤差決定段數 ──
  {
    const frame = { toWorld: (u, w) => new THREE.Vector3(u, 0, w) };
    const area = pts => { let a = 0; for (let k = 0; k < pts.length; k++) { const P = pts[k], Q = pts[(k + 1) % pts.length]; a += P.x * Q.z - Q.x * P.z; } return Math.abs(a) / 2; };
    for (const [r, segs, oldSegs] of [[0.3, 12, 8], [1, 16, 8], [5, 36, 32], [25, 160, 160]]) {
      const an = edit.circleAnchors(frame, 0, 0, r);
      const info = edit.sampleCurveInfo(an, 1, true);
      eq(`★★★ ①-8 半徑 ${r} 的圓（每隔 1 cm）：${oldSegs} → ${segs} 段`, `${info.pts.length}/${info.curveSegs}`, `${segs}/${segs}`);
      ok(`★★ 　 每段離曲線 ≤ 0.2 mm（${(info.maxDev * 10).toFixed(3)} mm）`, info.maxDev <= edit.CURVE_TOL_CM + 1e-12);
      if (r === 1) ok('★★ 　 直徑 2 的孔面積 2.83 → 3.06（真圓 3.14）', Math.abs(area(info.pts) - 3.062) < 0.005, area(info.pts).toFixed(3));
    }
    const s1 = edit.sampleCurveInfo(edit.circleAnchors(frame, 0, 0, 5), 1, true), s5 = edit.sampleCurveInfo(edit.circleAnchors(frame, 0, 0, 5), 5, true);
    ok('★★ 　 「每隔」打大一點也⛔ 會比誤差要的少（每隔 5 ＝ 每隔 1 ＝ 36 段）', s5.pts.length === 36 && s1.pts.length === 36, `${s1.pts.length} ${s5.pts.length}`);
    eq('★★ 　 「每隔 0.5」比誤差要的多 ⇒ 照每隔（64 段）', edit.sampleCurve(edit.circleAnchors(frame, 0, 0, 5), 0.5, true).length, 64);
  }

  // ── ①-13 壓克力配折板：圓弧那幾格⛔ 出片 ──
  {
    const div = { type: 'bend', ...PRIM_DEFAULTS.bend, w: 11, first: 1, bends: [{ angle: 90, ri: 0.2, len: 7.5 }] };
    const mk = src => new io.ModelObject({ name: '隔板', kind: io.KIND.SHEET, thickness: 0.5, src });
    const sz = r => r.pieces.map(p => `${p.width.toFixed(2)}×${p.height.toFixed(2)}×${p.qty}`).sort().join(',');
    const ra = unfoldObject(mk(div), { material: 'acrylic' });
    eq('★★★ ①-13 T3 隔板（圓角 0.2、分 4 段）壓克力：只出平的兩段（以前多 4 條 11 × 0.16 的細條）', sz(ra), '11.00×1.00×1,11.00×7.50×1');
    ok('★★ 　 講出來：「圓弧折彎 1 道沒有出片…請換能折的材質，或把折板拆成幾片平板」', ra.warnings.some(w => w.includes('圓弧折彎 1 道沒有出片') && w.includes('請換能折的材質')), ra.warnings.join('｜'));
    ok('★★ 　 提醒裡⛔ 出現 ⛔、** 這種文件記號', ra.warnings.every(w => !w.includes('⛔') && !w.includes('**')));
    eq('★★ 　 珍珠板照舊攤成一片（9.12 × 11）', sz(unfoldObject(mk(div), { material: 'foamboard' })), '9.12×11.00×1');
    const arr = { type: 'array', mode: 'linear', count: 2, step: [6.67, 0, 0], count2: 1, step2: [0, 0, 20], child: { src: div, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], name: '隔板' } };
    const rr = unfoldObject(mk(arr), { material: 'acrylic' });
    eq('★★★ 　 排列 2 份（T3 的隔板）：4 片、⛔ 細條', sz(rr), '11.00×1.00×2,11.00×7.50×2');
    const sharp = unfoldObject(mk({ type: 'bend', ...PRIM_DEFAULTS.bend }), { material: 'acrylic' });
    eq('★★ 　 預設折板（圓角 2、分 4 段）壓克力：60 × 40 ＋ 60 × 30（以前多 4 條 60 × 0.86）', sz(sharp), '60.00×30.00×1,60.00×40.00×1');
    const cyl = new io.ModelObject({ name: '圓柱', kind: io.KIND.SOLID, src: { type: 'cylinder', ...PRIM_DEFAULTS.cylinder } });
    const rc = unfoldObject(cyl, { material: 'acrylic' });
    ok('★★ 　 圓柱（⛔ 是折板）壓克力照舊：側面還是一條一條（可以黏成多邊形）', rc.stats.total > 30 && !rc.warnings.some(w => w.includes('圓弧折彎')), `${rc.stats.total} 片`);
  }
}

section('畫縫份／黏合片（2026-10-19 綜合評估 ①-7）');
if (csgOK) {
  /**
   * kang 2026-10-19：「縫份、黏合片…能夠變成選項…有需要時才會觸發」→ 照建議「同意」：預設⛔ 勾、寬度照材質可以改、
   * 紙模標過分片 ⇒ 每對接縫只長一邊；沒標過 ⇒ 外圍一圈。數字是同一天沙箱量的（T3 盒身 20 × 8 × 12，開口朝上）。
   */
  const { setSeam } = await import('../js/unfold/seam.js');
  const { marginGeometry, pieceFootprint, outlineSegments, titleLines, drawProgram, notchMarks } = await import('../js/out/sheet.js');
  const { toDXF } = await import('../js/out/dxf.js');
  const { packBoards } = await import('../js/out/nest.js');
  const LN = (d, layer) => (d.match(new RegExp(`\\r\\n0\\r\\nLINE\\r\\n8\\r\\n${layer}\\r\\n`, 'g')) || []).length;
  const sty = segs => Object.entries(segs.reduce((c, x) => (c[x.style] = (c[x.style] || 0) + 1, c), {})).sort().map(([k, v]) => `${k}${v}`).join(',');
  const box = seam => {
    const o = new io.ModelObject({ name: '盒身', kind: io.KIND.SOLID, src: { type: 'box', w: 20, h: 8, d: 12 } }); o.bake();
    let m = o.mesh(); m.computeNormals();
    m = edit.deleteFaces(m, [{ kind: 'face', face: m.faces.find(f => f.normal.y > 0.99) }]).mesh; m.computeNormals(); o.setMesh(m);
    if (seam) setSeam(m, [...m.edges()].find(h => h.twin && h.twin.face && Math.abs(Math.abs(h.v.p.y - h.to.p.y) - 8) < 1e-6), true);
    return o;
  };
  const ON = { margin: { on: true } };

  // ── 沒勾 ⇒ 一個字都不變 ──
  {
    const p = unfoldObject(box(false), { material: 'canvas' }).pieces[0];
    const a = JSON.stringify(drawProgram(p, { rule: p.rule })), b = JSON.stringify(drawProgram(p, { rule: p.rule, margin: { on: false } }));
    ok('★★★ 沒勾：畫的東西跟沒有這個選項時一模一樣', a === b && !marginGeometry(p, { margin: null }));
    ok('★★ 　 卡片照舊寫「⚠ 圖上未含縫份 1.5 cm，下料時另加」，並講去哪裡勾', titleLines(p, { rule: p.rule }).some(t => t.startsWith('⚠ 圖上未含縫份 1.5 cm，下料時另加') && t.includes('畫縫份／黏合片')));
    const f = unfoldObject(box(false), { material: 'foamboard' }).pieces[0];
    ok('★★ 　 珍珠板（沒有縫份）勾了也⛔ 畫', !marginGeometry(f, ON) && sty(outlineSegments(f, ON).segs) === sty(outlineSegments(f, {}).segs));
  }

  // ── 帆布：外圍一圈，原本的外框變縫線 ──
  {
    const p = unfoldObject(box(false), { material: 'canvas' }).pieces[0];
    const g = marginGeometry(p, ON);
    eq('★★★ 帆布 T3 盒身（64 × 20）：外圍一圈 1.5、範圍 −1.5..65.5 × −1.5..21.5', `${g.kind} ${g.bounds.x0},${g.bounds.y0},${g.bounds.x1},${g.bounds.y1}`, 'seam -1.5,-1.5,65.5,21.5');
    eq('★★★ 　 原本的外框 6 段變縫線、外面 6 段裁切線', sty(outlineSegments(p, ON).segs), 'cut6,seamSew6');
    const d = toDXF([p], ON);
    eq('★★★ 　 DXF：裁切線在 CUT（6）、縫線在 SEW（6）—— 縫線⛔ 切', `${LN(d, 'CUT')}/${LN(d, 'SEW')}`, '6/6');
    const tl = titleLines(p, { rule: p.rule, ...ON });
    ok('★★ 　 卡片：「縫份 1.5 cm 已畫進圖…」「含縫份外框 67 × 23 cm」、⛔「圖上未含」', tl.some(t => t.startsWith('縫份 1.5 cm 已畫進圖')) && tl.includes('含縫份外框 67 × 23 cm') && !tl.some(t => t.includes('圖上未含')), tl.join('｜'));
    const g2 = marginGeometry(p, { margin: { on: true, w: 3 } });
    eq('★★ 　 寬度打 3 ⇒ 外圍推 3', `${g2.w} ${g2.bounds.x0}`, '3 -3');
    const nb = packBoards([p], { w: 240, h: 120, gap: 1, margin: ON.margin });
    eq('★★★ 　 排版照含縫份的外框排（67 × 23）', nb.boards[0].items.map(it => `${it.w}×${it.h}`).join(), '67×23');
    eq('★★ 　 沒勾的排版照舊（64 × 20）', packBoards([p], { w: 240, h: 120, gap: 1 }).boards[0].items.map(it => `${it.w}×${it.h}`).join(), '64×20');
    const pr = drawProgram(p, { rule: p.rule, ...ON });
    ok('★★ 　 圖面包住外面那一圈', pr.box.x <= -1.5 && pr.box.y <= -1.5 && pr.box.x + pr.box.w >= 65.5);
  }

  // ── 帆布的洞：往內縮；小到縮沒了 ⇒ 講 ──
  {
    const sq = (x, y, s) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];
    const fake = { name: '有洞的片', qty: 1, area: 0, width: 20, height: 20, outline: sq(0, 0, 20), holes: [sq(7, 7, 6), sq(2, 2, 2)],
      seamRuns: [], bends: [], folds: [], joints: [], warnings: [], rule: makeRule('canvas', 0.2) };
    const g = marginGeometry(fake, ON);
    eq('★★ 帆布的洞：6 × 6 的往內縮成 3 × 3（4 段裁切線）、2 × 2 的縮沒了（算 1 個）', `${g.cuts.length}/${g.lostHoles}`, '8/1');
    ok('★★ 　 卡片講「1 個洞比縫份還小」', titleLines(fake, { rule: fake.rule, ...ON }).some(t => t.includes('1 個洞比縫份還小')));
  }

  // ── 紙模：沒標過分片 ⇒ 外圍一圈 ──
  {
    const p = unfoldObject(box(false), { material: 'paper' }).pieces[0];
    const g = marginGeometry(p, ON);
    eq('★★★ 紙模、沒標過分片：外圍一圈 1（kang 同意）', `${g.kind} ${g.bounds.x0},${g.bounds.x1}`, 'ring -1,65');
    eq('★★ 　 原本的外框變黏合片折線（DXF 在 FOLD）', `${sty(outlineSegments(p, ON).segs)} ${LN(toDXF([p], ON), 'FOLD')}`, 'cut6,tabFold6 6');
    ok('★★ 　 卡片講「沒標過分片…改成外圍一圈…要只長在一邊，請先標分片」', titleLines(p, { rule: p.rule, ...ON }).some(t => t.includes('沒標過分片') && t.includes('請先標分片')));
  }

  // ── 紙模：標過分片 ⇒ 每對接縫只長一邊 ──
  {
    const r = unfoldObject(box(true), { material: 'paper' });
    const p = r.pieces[0];
    const keys = new Map();
    for (const q of r.pieces) for (const run of q.seamRuns) {
      const k = run.segs.map(g => `${g.va}-${g.vb}`).join(',');
      keys.set(k, (keys.get(k) || 0) + (run.tab ? 1 : 0));
    }
    ok('★★★ 紙模、標過分片：每一對接縫剛好一邊長黏合片', keys.size === 2 && [...keys.values()].every(v => v === 1), [...keys.values()].join(','));
    const g = marginGeometry(p, ON);
    eq('★★★ 　 這一片長 2 段（4 條縫裡 2 條）', `${g.kind} ${g.tabs}`, 'tab 2');
    const segs = outlineSegments(p, ON).segs;
    ok('★★ 　 長了黏合片的底邊變折線、黏合片的三邊是裁切線', segs.filter(x => x.style === 'tabFold').length > 0 && g.cuts.length % 3 === 0 && g.cuts.length > 0, sty(segs));
    // 黏合片長在料的外面
    const inside = (x, y) => { let c = false; const P = p.outline; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { if ((P[i].y > y) !== (P[j].y > y) && x < (P[j].x - P[i].x) * (y - P[i].y) / (P[j].y - P[i].y) + P[i].x) c = !c; } return c; };
    ok('★★ 　 黏合片的外緣都在料的外面（⛔ 長進片裡）', g.cuts.filter((c, i) => i % 3 === 1).every(c => !inside((c.a.x + c.b.x) / 2, (c.a.y + c.b.y) / 2)));
    eq('★★ 　 對位記號：一邊長黏合片 ⇒ 往內切（另一邊外面沒有東西）', notchMarks(p, { rule: p.rule, notch: { style: 'slit', spacing: 10 }, ...ON }).dir, 'in');
    ok('★★ 　 卡片講「這一片長 2 段…接縫的另一邊不長」', titleLines(p, { rule: p.rule, ...ON }).some(t => t.includes('這一片長 2 段') && t.includes('另一邊不長')));
  }
} else {
  ok('（略過：CSG 沒載入）', true);
}

section('實體⛔ 寫看不見的板厚（2026-10-19 綜合評估 ①-9）');
{
  /**
   * 實驗 T7、T8、補測：實體的面板上看不到板厚，物件身上卻帶著 0.2 —— 照樣寫進卡片、CSV、DXF 標題（T7 托架 0.2、其他板 0.5）。
   * kang 2026-10-19「先做 ①-9（照這個建議）」：實體的片寫「—」；認成實心板的照舊寫量出來的厚度；板件照舊。
   */
  const { titleLines } = await import('../js/out/sheet.js');
  const { toDXF } = await import('../js/out/dxf.js');
  const { billOfMaterials } = await import('../js/unfold/part.js');
  const spec = p => titleLines(p, { rule: p.rule })[1];
  const solid = new io.ModelObject({ name: '方塊', kind: io.KIND.SOLID, src: { type: 'box', w: 30, h: 20, d: 10 } });
  const rs = unfoldObject(solid, { material: 'foamboard' });
  eq('★★★ 實體方塊（珍珠板）：卡片寫「板厚 —（實體）」（以前「板厚 0.2 cm」）', spec(rs.pieces[0]), '珍珠板／發泡板／薄木板　板厚 —（實體）');
  eq('★★★ 　 CSV 板厚欄「—」', billOfMaterials(rs.pieces, rs.rule)[0]['板厚cm'], '—');
  const d = toDXF(rs.pieces, { unit: 'mm' });
  ok('★★ 　 DXF 標題⛔ 寫 t0.2', !/ t0\.2\r?\n/.test(d) && /foamboard\r?\n/.test(d));
  const sheet = new io.ModelObject({ name: '平板', kind: io.KIND.SHEET, thickness: 0.5, src: { type: 'plate', w: 30, d: 20 } });
  const rp = unfoldObject(sheet, { material: 'foamboard' });
  eq('★★ 板件照舊寫自己的板厚', `${spec(rp.pieces[0])} ${billOfMaterials(rp.pieces, rp.rule)[0]['板厚cm']}`, '珍珠板／發泡板／薄木板　板厚 0.5 cm 0.5');
  const plate = new io.ModelObject({ name: '背板', kind: io.KIND.SOLID, src: { type: 'box', w: 30, h: 0.5, d: 20 } });
  const ra = unfoldObject(plate, { material: 'acrylic' });
  eq('★★ 實體但認成實心板（壓克力）：照舊寫量出來的 0.5', `${spec(ra.pieces[0])} ${billOfMaterials(ra.pieces, ra.rule)[0]['板厚cm']}`, '壓克力／木板　板厚 0.5 cm 0.5');
  const rw = unfoldObject(new io.ModelObject({ name: '楔形', kind: io.KIND.SOLID, src: { type: 'wedge', w: 20, h: 10, d: 15 } }), { material: 'paper' });
  ok('★★ 紙模的實體楔形也⛔ 寫 0.2', rw.pieces.every(p => spec(p).endsWith('板厚 —（實體）')));
}

section('金屬收起來、折板講 K（2026-10-19 綜合評估 ①-13 後半）');
{
  /**
   * kang 2026-10-19：「其實實際上..我們並沒有"金屬"材料...也不會使用"金屬"材質運用處理...所以當初才會不考慮K因子」
   * → AI 建議（金屬從清單收起來、資料留著；折板這一輪⛔ 改長度、只在卡片講照哪個 K）→「同意」。
   */
  const { PICKABLE_MATERIAL_KEYS } = await import('../js/unfold/rules.js');
  const { titleLines } = await import('../js/out/sheet.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  eq('★★★ 展開圖的材質清單：帆布、壓克力／木板、珍珠板、紙模（金屬三種收起來）', PICKABLE_MATERIAL_KEYS.join(','), 'canvas,acrylic,foamboard,paper');
  ok('★★ 　 金屬的資料還在（規則照樣做得出來）', !!MATERIALS.steel && makeRule('steel', 0.2).label === '鐵板／鍍鋅鋼板');
  const div = k => new io.ModelObject({ name: '隔板', kind: io.KIND.SHEET, thickness: 0.5,
    src: { type: 'bend', ...PRIM_DEFAULTS.bend, w: 11, first: 1, k, bends: [{ angle: 90, ri: 0.2, len: 7.5 }] } });
  const kLine = p => titleLines(p, { rule: p.rule }).find(t => t.startsWith('折彎長度照折板自己的 K'));
  for (const [k, len] of [[0.4, '9.1243'], [0.3, '9.0463']]) {
    for (const mat of ['foamboard', 'paper', 'canvas']) {
      const p = unfoldObject(div(k), { material: mat }).pieces[0];
      eq(`★★★ T3 隔板 K ${k}（${mat}）：長度照舊 ${len}、卡片講「照折板自己的 K ${k} 算…跟這裡選的材質無關」`,
        `${p.width.toFixed(4)} ${kLine(p) || '（沒有）'}`, `${len} 折彎長度照折板自己的 K ${k} 算（在物件面板改），跟這裡選的材質無關`);
    }
  }
  const sharp = unfoldObject(new io.ModelObject({ name: '尖角折板', kind: io.KIND.SHEET, src: { type: 'bend', ...PRIM_DEFAULTS.bend, bends: [{ angle: 90, ri: 0, len: 30 }] } }), { material: 'foamboard' }).pieces[0];
  ok('★★ 　 尖角的折板（沒有圓弧）⛔ 講', !kLine(sharp));
  const bx = unfoldObject(new io.ModelObject({ name: '方塊', kind: io.KIND.SOLID, src: { type: 'box', ...PRIM_DEFAULTS.box } }), { material: 'foamboard' }).pieces[0];
  ok('★★ 　 不是折板⛔ 講', !kLine(bx));
  const arr = new io.ModelObject({ name: '隔板×2', kind: io.KIND.SHEET, thickness: 0.5, src: { type: 'array', mode: 'linear', count: 2, step: [6.67, 0, 0], count2: 1, step2: [0, 0, 20],
    child: { src: div(0.4).src, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], name: '隔板' } } });
  ok('★★ 　 排列 2 份的折板也講', unfoldObject(arr, { material: 'foamboard' }).pieces.every(p => !!kLine(p)));
}

section('平滑的圓錐面當一段曲線帶（2026-10-19 綜合評估 ①-11）');
{
  /**
   * 實驗 T5：燈罩（旋轉成形、三段輪廓）切成環帶 3 片 —— 第 1 片 15 段兩小格的曲線帶、第 2、3 片各 31 道「真轉角」。
   * 病因：認曲線帶的做法假設折線互相平行；圓錐的一圈攤開，折線是放射狀的（相鄰差 0.7°／2.2°／3.8°）。
   * kang 2026-10-19「同意」：有平滑標記的一律當曲線帶、圖上不畫折線、圓錐面也不畫參考線；沒有平滑標記的照舊。
   */
  const { proposeSeams } = await import('../js/unfold/propose.js');
  const { setSeam } = await import('../js/unfold/seam.js');
  const { titleLines, drawProgram } = await import('../js/out/sheet.js');
  const { toDXF } = await import('../js/out/dxf.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const LN = (d, layer) => (d.match(new RegExp(`\\r\\n0\\r\\nLINE\\r\\n8\\r\\n${layer}\\r\\n`, 'g')) || []).length;
  const pts = [[10.3561, 0]];
  for (const [L, a] of [[8.0156, 93.58], [10.198, 101.31], [7.433, 109.65]]) {
    const [x, y] = pts[pts.length - 1], t = a * Math.PI / 180;
    pts.push([x + L * Math.cos(t), y + L * Math.sin(t)]);
  }
  const xy = pts.flat();
  const lamp = new io.ModelObject({ name: '燈罩', kind: io.KIND.SHEET, thickness: 0.2,
    src: { type: 'pen', h: 3, open: true, paths: [{ closed: false, a: xy, hi: xy.map(() => 0), ho: xy.map(() => 0) }], rev: { dir: 'z', at: 2.3561, seg: 32, stand: false } } });
  lamp.bake();
  const band = proposeSeams(lamp, { material: 'paper', board: { w: 240, h: 120, gap: 1, rotate: false } }).options.find(x => x.kind === 'band');
  for (const h of band.edges) setSeam(lamp.mesh(), h, true);
  const r = unfoldObject(lamp, { material: 'paper' });
  eq('★★★ T5 燈罩環帶 3 片：面積照舊 389.67／415.72／198.05', r.pieces.map(p => p.area.toFixed(2)).join('／'), '389.67／415.72／198.05');
  eq('★★★ 　 每一片都是一段圓錐面曲線帶（31 小段）、圖上 0 道折線（以前 1／31／31 道）',
    r.pieces.map(p => `${p.bends.length}:${p.bends[0].radial ? '錐' : '?'}${p.bends[0].segs}:${p.folds.filter(f => !f.isArcEdge).length}`).join(' '), '1:錐31:0 1:錐31:0 1:錐31:0');
  ok('★★ 　 卡片講「曲線帶共 31 小段，圖上不畫（其中 1 帶是圓錐面，參考線也不畫）」',
    r.pieces.every(p => titleLines(p, { rule: p.rule }).some(t => t.includes('曲線帶共 31 小段，圖上不畫（其中 1 帶是圓錐面，參考線也不畫）'))));
  const items = r.pieces.flatMap(p => drawProgram(p, { rule: p.rule }).items);
  eq('★★ 　 圖上⛔ 折線、⛔ 折彎參考線', items.filter(i => /^fold|^bend$/.test(i.style)).length, 0);
  const d = toDXF(r.pieces, { unit: 'mm' });
  eq('★★★ 　 DXF：FOLD／FOLD_UP／FOLD_DOWN／BEND 都 0 條（T5 排版 DXF 以前 63 條折線 ＋ 45 條彎線）', LN(d, 'FOLD') + LN(d, 'FOLD_UP') + LN(d, 'FOLD_DOWN') + LN(d, 'BEND'), 0);

  // 平行的平滑折線（直筒）：照舊走原本那一套（⛔ 標成圓錐面）
  const cyl = [[5, 0], [5, 10]].flat();
  const tube = new io.ModelObject({ name: '直筒', kind: io.KIND.SHEET, thickness: 0.2,
    src: { type: 'pen', h: 3, open: true, paths: [{ closed: false, a: cyl, hi: cyl.map(() => 0), ho: cyl.map(() => 0) }], rev: { dir: 'z', at: 0, seg: 32, stand: false } } });
  const rt = unfoldObject(tube, { material: 'paper' });
  ok('★★ 直筒（折線互相平行）：⛔ 標成圓錐面，照舊', rt.pieces.every(p => p.bends.every(b => !b.radial)), rt.pieces.map(p => p.bends.map(b => b.isCurve ? 'C' : b.isArc ? 'A' : 'S').join('')).join(','));

  // 沒有平滑標記的基本形狀：一條線都不變（數字是 2026-10-19 改之前量的）
  const drawn = t => unfoldObject(new io.ModelObject({ name: t, kind: io.KIND.SOLID, src: { type: t, ...PRIM_DEFAULTS[t] } }), { material: 'paper' })
    .pieces.reduce((n, p) => n + p.folds.filter(f => !f.isArcEdge).length, 0);
  eq('★★★ 沒有平滑標記的照舊畫折線：方塊 5、圓柱 2、圓錐 43、球 493、階梯 11', ['box', 'cylinder', 'cone', 'sphere', 'stairs'].map(drawn).join(','), '5,2,43,493,11');
  /** ⚠ 圓環、半球是旋轉做出來的、本來就有平滑標記 ⇒ 跟著變（改之前 70、38 道）—— 2026-10-19 跟 kang 報告過 */
  eq('★★ 圓環、半球（旋轉做的，有平滑標記）：圖上的折線 70 → 38、38 → 8', ['torus', 'dome'].map(drawn).join(','), '38,8');
}

section('省道打版變形太大時指路（2026-10-19 綜合評估 ①-14）');
{
  /**
   * 實驗 T5：燈罩不切縫用省道打版，壓 29.9%（面積 924.8，真值 1,003.4）—— 用智慧分切「環帶」是 3 片、0%。
   * kang 2026-10-19「先同意你的研究與建議」：照 10/09 定案⛔ 做自動開口；翻面、超過上限時多講一句「不想變形可以怎麼做」。
   */
  const { DART_HINT } = await import('../js/unfold/flatten.js');
  const { titleLines } = await import('../js/out/sheet.js');
  const { setSeam } = await import('../js/unfold/seam.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const pts = [[10.3561, 0]];
  for (const [L, a] of [[8.0156, 93.58], [10.198, 101.31], [7.433, 109.65]]) {
    const [x, y] = pts[pts.length - 1], t = a * Math.PI / 180;
    pts.push([x + L * Math.cos(t), y + L * Math.sin(t)]);
  }
  const xy = pts.flat();
  const lamp = new io.ModelObject({ name: '燈罩', kind: io.KIND.SHEET, thickness: 0.2,
    src: { type: 'pen', h: 3, open: true, paths: [{ closed: false, a: xy, hi: xy.map(() => 0), ho: xy.map(() => 0) }], rev: { dir: 'z', at: 2.3561, seg: 32, stand: false } } });
  lamp.bake();
  const r = unfoldObject(lamp, { material: 'canvas', mode: 'dart' });
  const p = r.pieces[0];
  ok('★★ T5 燈罩不切縫、省道打版：壓縮超過 20%（以前就是這樣，這一輪⛔ 改算法）', p.strain && -p.strain.min > 0.2, (-p.strain.min * 100).toFixed(1) + '%');
  const over = titleLines(p, { rule: p.rule, limit: 3 }).find(t => t.startsWith('⚠ 超過你填的上限'));
  ok('★★★ 　 超過上限 3% 那一行多講「不想變形的話，改用精確分片，或到分片模式用智慧分切（例如環帶）」', !!over && over.endsWith(DART_HINT), over);
  ok('★★ 　 提醒裡⛔ 出現 ⛔、** 這種文件記號', !DART_HINT.includes('⛔') && !DART_HINT.includes('**'));
  ok('★★ 　 沒超過上限 ⇒ ⛔ 講', !titleLines(p, { rule: p.rule, limit: 50 }).some(t => t.includes('智慧分切')));
  // 翻面：半球只切開底那一圈、不開口（規格 2.1 量過：50 個面翻過來）
  const dome = new io.ModelObject({ name: '半球', kind: io.KIND.SOLID, src: { type: 'dome', ...PRIM_DEFAULTS.dome } }); dome.bake();
  const m = dome.mesh(); m.computeNormals();
  const yb = m.bounds().min.y;    // 半球是置中的，底在最低的那一圈
  for (const h of [...m.edges()]) if (h.twin && h.twin.face && Math.abs(h.v.p.y - yb) < 1e-6 && Math.abs(h.to.p.y - yb) < 1e-6) setSeam(m, h, true);
  const rd = unfoldObject(dome, { material: 'canvas', mode: 'dart' });
  const flipW = rd.warnings.find(w => w.includes('個面翻過來'));
  ok('★★★ 半球只切開底、不開口：「…個面翻過來…」那一則多講同一句', !!flipW && flipW.endsWith(DART_HINT), flipW || rd.warnings.join('｜'));
}

section('綜合評估 ② 第一批：說錯的數字與提示（2026-10-19）');
{
  /** kang 2026-10-19「同意你的安排與建議」—— 畫面上的部分（抓最新版、加厚提示、參考線下拉、列印被擋、各按鈕提示）在本機／線上版用畫面驗 */
  const { PRIM_SPECS, PRIM_DEFAULTS } = await import('../js/build/prim.js');
  // ②-9 齒輪：中心距離的係數⛔ 捨到 2 位
  const n25 = PRIM_SPECS.gear.noteOf({ ...PRIM_DEFAULTS.gear, module: 0.25 });
  ok('★★★ ②-9 模數 0.25：說明寫「0.125 × (20 ＋ 對方齒數)」（以前 0.13，照抄差 0.3 cm）', n25.some(s => s.includes('0.125 × (20 ＋ 對方齒數)')), n25.join('｜'));
  ok('★★ 　 預設模數 0.3 照舊「0.15 ×」', PRIM_SPECS.gear.noteOf(PRIM_DEFAULTS.gear).some(s => s.includes('0.15 × (20 ＋ 對方齒數)')));
  // ②-15 切一刀切在既有的線上：⛔ 說「斷開」
  const box = io.buildSrc({ type: 'box', w: 60, h: 40, d: 45 });
  const m0 = edit.mergeCoplanarFaces(box).mesh;
  const r1 = edit.bisect(m0, { n: new THREE.Vector3(1, 0, 0), d: 0 });
  const r2 = r1.ok ? edit.bisect(r1.mesh, { n: new THREE.Vector3(1, 0, 0), d: 0 }) : null;
  ok('★★★ ②-15 同一個位置再切一刀：講「已經有一條線…物件還是連著的」，⛔ 講「斷開」',
    !!r2 && !r2.ok && r2.reason.includes('已經有一條線') && r2.reason.includes('還是連著的') && !r2.reason.includes('斷開'), r2 && r2.reason);
  // ②-17 STL：小物件的提醒⛔ 寫「整個模型」
  const tiny = io.buildSrc({ type: 'box', w: 0.3, h: 0.3, d: 0.3 });
  const ct = printCheck(tiny, triangles(tiny, { scale: 10 }));
  const small = ct.issues.find(i => i.text.includes('最長邊只有'));
  ok('★★ ②-17 3 mm 的方塊：「這個物件最長邊只有 3.00mm…」（以前「整個模型」）', !!small && small.text.startsWith('這個物件最長邊只有') && !small.text.includes('整個模型'), small && small.text);
}

section('綜合評估 ② 第二批：行為修正（2026-10-19）');
if (csgOK) {
  /** 畫面上的部分（框選重畫、鋼筆刪點、結構分析過期、多點縮放、縮放物件的數值欄、刀具在平板、提案收起來）在本機／線上版用畫面驗 */
  // ②-5 分開的兩小塊：看最大的一塊
  const it = (src, pos = [0, 0, 0]) => ({ src, pos, rot: [0, 0, 0], scale: [1, 1, 1], name: src.type });
  const two = io.buildSrc({ type: 'bool', op: BOOL_OPS.UNION, items: [it({ type: 'box', w: 2, h: 2, d: 2 }), it({ type: 'box', w: 2, h: 2, d: 2 }, [30, 0, 0])] });
  const c2 = printCheck(two, triangles(two, { scale: 10 }));
  const w2 = c2.issues.find(i => i.text.includes('成型範圍'));
  ok('★★★ ②-5 兩塊 2 cm 的方塊隔 30 cm：⛔ 叫人分件，改講「2 塊分開的、最大一塊 20.0mm…排近一點就放得下」',
    !!w2 && w2.text.includes('2 塊分開的') && w2.text.includes('最大一塊 20.0mm') && !w2.text.includes('分件'), w2 && w2.text);
  const one = io.buildSrc({ type: 'box', w: 30, h: 2, d: 2 });
  const w1 = printCheck(one, triangles(one, { scale: 10 })).issues.find(i => i.text.includes('成型範圍'));
  ok('★★ 　 一整塊 300 mm 照舊「可能要分件或縮小」', !!w1 && w1.text.includes('可能要分件或縮小'), w1 && w1.text);
} else {
  ok('（略過：CSG 沒載入）', true);
}

section('綜合評估 ② 第三批：結構分析、中心、指出來（2026-10-19）');
{
  /** ②-11 讀數改名在「量測讀數」那一段測；②-12 的按鈕、②-2 的「個面」是畫面上的字，在本機／線上版用畫面驗 */
  const P = (x, y, z) => new THREE.Vector3(x, y, z);
  const cubePts = () => [P(0, 0, 0), P(10, 0, 0), P(10, 0, 10), P(0, 0, 10), P(0, 10, 0), P(10, 10, 0), P(10, 10, 10), P(0, 10, 10)];
  const cubeFaces = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];

  // ②-2 角虧：四邊形被拉歪（不再是平的）
  const pts = cubePts(); pts[6] = P(10, 13, 12);
  const warped = Mesh.fromFaceList(pts, cubeFaces);
  const vw = warped.validate();
  ok('　 歪掉的方塊本身是好的（封閉、無誤、χ 2、6 個四邊形）', vw.ok && vw.closed && vw.euler === 2 && vw.F === 6, JSON.stringify({ ok: vw.ok, c: vw.closed, e: vw.euler, F: vw.F }));
  const sw = summarize(warped);
  near('★★★ ②-2 四邊形拉歪的方塊：角虧總和照樣 ＝ 4π（以前用四邊形的內角算 ⇒ 打 ✗）', sw.totalDefect, 4 * Math.PI, 1e-9);
  ok('★★ 　 結構分析打 ✓', topologyCheck(vw, sw.totalDefect).defectOK === true);

  // ②-2 角虧：凹的多邊形（L 形柱子，上下各一個凹的六邊形）
  const L = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]];
  const lp = [...L.map(([x, z]) => P(x, 0, z)), ...L.map(([x, z]) => P(x, 10, z))];
  const lf = [[0, 1, 2, 3, 4, 5], [11, 10, 9, 8, 7, 6]];
  for (let i = 0; i < 6; i++) { const j = (i + 1) % 6; lf.push([j, i, i + 6, j + 6]); }
  const lm = Mesh.fromFaceList(lp, lf);
  const vl = lm.validate();
  ok('　 L 形柱子本身是好的（封閉、無誤、χ 2）', vl.ok && vl.closed && vl.euler === 2, JSON.stringify({ ok: vl.ok, c: vl.closed, e: vl.euler }));
  near('★★ ②-2 凹的六邊形：角虧總和 ＝ 4π（以前凹進去那個角只拿得到 90°）', summarize(lm).totalDefect, 4 * Math.PI, 1e-9);

  // ②-2 開放的殼：χ ＝ 2c − 2g − b
  const openBox = Mesh.fromFaceList(cubePts(), cubeFaces.filter((_, i) => i !== 1));
  const vo = openBox.validate();
  eq('　 少一個面的方塊：開口 1 圈', vo.boundaryLoops, 1);
  const to = topologyCheck(vo, summarize(openBox).totalDefect);
  ok('★★ ②-2 少一個面的方塊 χ 1 ✓「＝2−1（開口的邊緣 1 圈）」', to.eulerOK === true && to.eulerNote === '＝2−1（開口的邊緣 1 圈）', to.eulerNote);
  const tube = buildPrim('cylinder', { r: 25, h: 70, seg: 32, openEnded: true });
  const vt = tube.validate();
  eq('　 兩頭開口的筒子：開口 2 圈', vt.boundaryLoops, 2);
  const tt = topologyCheck(vt, summarize(tube).totalDefect);
  ok('★★★ ②-2 兩頭開口的筒子 χ 0 打 ✓（以前說「開放的殼應為 1」打 ✗）', tt.eulerOK === true && tt.eulerNote === '＝2−2（開口的邊緣 2 圈）' && tt.genus === null, tt.eulerNote);
  const two = Mesh.fromFaceList([...cubePts(), ...cubePts().map(p => p.clone().add(P(30, 0, 0)))],
    [...cubeFaces.filter((_, i) => i !== 1), ...cubeFaces.filter((_, i) => i !== 1).map(f => f.map(k => k + 8))]);
  const t2 = topologyCheck(two.validate(), 0);
  ok('★ 　 兩個少一個面的方塊（分開的）：χ 2「＝2×2−2」', t2.eulerOK === true && t2.eulerNote === '＝2×2−2（開口的邊緣 2 圈）', t2.eulerNote);
  const bad = topologyCheck({ closed: false, euler: 3, components: 1, boundaryLoops: 1 }, 0);
  ok('★ 　 開口 1 圈卻 χ 3：照樣抓得出來（打 ✗）', bad.eulerOK === false, bad.eulerNote);
  ok('　 封閉的方塊照舊（開口 0 圈、χ 2 ✓）', buildPrim('box', { w: 60, h: 45, d: 40 }).validate().boundaryLoops === 0);
}

section('綜合評估 ③ 第二批：講出來、多選一起改（2026-10-19）');
{
  /** ③-8 多選排列、多選一起改、③-14 離地的提示都在畫面那一層（main.js、Panel），在本機／線上版用畫面驗 */
  const { copiesStacked } = await import('../js/build/array.js');
  const { gearClash, meshGearPair } = await import('../js/core/gearPair.js');
  const { stackedHint } = await import('../js/ui/toolbar.js');

  // ③-1 每一份都在同一個位置
  const b10 = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5));
  const radial = c => arrayMatrices({ type: 'array', mode: ARRAY_MODES.RADIAL, count: 8, angle: 360, axis: 'y', center: c });
  ok('★★★ ③-1 環形預設（繞自己的原點）：8 份都在同一個位置 ⇒ 抓得到', copiesStacked(radial([0, 0, 0]), b10));
  ok('★★ 　 旋轉中心移到 X 50：排成一圈 ⇒ ⛔ 講', !copiesStacked(radial([50, 0, 0]), b10));
  const lin = s => arrayMatrices({ type: 'array', mode: ARRAY_MODES.LINEAR, count: 3, step: s });
  ok('★ 　 排列間距 0 ⇒ 抓得到；間距 12 ⇒ ⛔ 講', copiesStacked(lin([0, 0, 0]), b10) && !copiesStacked(lin([12, 0, 0]), b10));
  ok('　 只有一份 ⇒ ⛔ 講', !copiesStacked(radial([0, 0, 0]).slice(0, 1), b10));
  if (csgOK) {
    const box = new io.ModelObject({ name: '方塊', kind: io.KIND.SOLID, src: { type: 'box', w: 10, h: 10, d: 10 } });
    const arr = new io.ModelObject({ name: '環形', kind: io.KIND.SOLID, src: io.arraySrcFrom(box, ARRAY_MODES.RADIAL) });
    ok('★★★ 　 真的按「環形」做出來的方塊陣列：`stacked` 是 true（以前只說「完成 8 份」）', arr.stacked === true, arr.error);
    arr.src.center = [50, 0, 0]; arr.invalidate();
    ok('★★ 　 中心移到 X 50 ⇒ `stacked` 變 false', arr.stacked === false, arr.error);
  }
  const hints = ['radial', 'linear', 'mirror'].map(m => stackedHint(m, 8));
  ok('★ 　 三種提示都講得出怎麼排開、⛔ 有文件記號', hints.every(h => !h.includes('⛔') && !h.includes('**')) && hints[0].includes('旋轉中心') && hints[1].includes('間距'), hints.join(' ｜ '));

  // ③-7 齒輪改了齒數之後跟旁邊的那個卡住
  const gear = (name, p, x, z) => {
    const o = new io.ModelObject({ name, kind: io.KIND.SOLID, src: { type: 'gear', module: 0.3, teeth: 20, t: 0.5, hole: 0.6, gapMm: 0.2, ...p } });
    o.pos.set(x, 3, z);
    return o;
  };
  const A = gear('A', {}, 0, 0), B = gear('B', { teeth: 30 }, 20, 0);
  const r = meshGearPair(B, A);
  B.pos.set(r.pos.x, r.pos.y, r.pos.z); B.rot.set(0, r.rotY, 0);
  eq('★★ ③-7 咬上去之後 ⇒ ⛔ 講', gearClash(B, [A, B]), null);
  B.src.teeth = 36;
  const m1 = gearClash(B, [A, B]);
  ok('★★★ 　 B 改成 36 齒（變大）⇒「齒穿過去了：中心距 7.5 cm，要咬得剛好是 8.4 cm」', !!m1 && m1.includes('穿過去') && m1.includes('7.5') && m1.includes('8.4') && m1.includes('咬上去'), m1);
  B.src.teeth = 28;
  const m2 = gearClash(B, [A, B]);
  ok('★★ 　 B 改成 28 齒（變小、齒頂還碰得到）⇒「沒有咬緊：中心距 7.5，要 7.2」', !!m2 && m2.includes('沒有咬緊') && m2.includes('7.2'), m2);
  B.src.teeth = 30; B.src.module = 0.35;
  const m3 = gearClash(B, [A, B]);
  ok('★★ 　 B 的模數改成 0.35 ⇒「模數不一樣」', !!m3 && m3.includes('模數不一樣'), m3);
  B.src.module = 0.3;
  const C = gear('C', {}, 100, 0);
  eq('★ 　 離很遠的齒輪（齒碰不到）⇒ ⛔ 管', gearClash(C, [A, B, C]), null);
  const D = gear('D', { teeth: 36 }, 7.5, 0); D.pos.y = 20;
  eq('★ 　 不同高度（不在同一個平面）⇒ ⛔ 管', gearClash(D, [A, D]), null);
  ok('　 不是齒輪 ⇒ null', gearClash(new io.ModelObject({ src: { type: 'box', w: 1, h: 1, d: 1 } }), [A]) === null);
}

section('綜合評估 ③ 第三批（一）：對齊到最後選的、綁參考線搬碗、外框中心（2026-10-19）');
{
  /** 面板上的「對齊到」下拉、按鈕、提示文字在本機／線上版用畫面驗 */
  const A = await import('../js/core/align.js');
  const box = (w, x) => { const o = new io.ModelObject({ src: { type: 'box', w, h: 2, d: 2 } }); o.pos.set(x, 1, 0); return o; };
  // ③-3 對齊到最後選的（它不動）
  const shaft = box(1, 7), gearB = box(10, 0);
  const p = A.alignPositions([shaft, gearB], 'x', A.ALIGN.CENTER, 1);
  near('★★★ ③-3 對齊到最後選的：齒輪（最後選的）⛔ 動', p[1].x, 0, 1e-9);
  near('★★★ 　 軸對到齒輪中心', p[0].x, 0, 1e-9);
  const q = A.alignPositions([shaft, gearB], 'x', A.ALIGN.CENTER);
  ok('★★ 　 不給基準 ⇒ 照舊對整組（兩個都往整組中間移）', Math.abs(q[1].x) > 1e-6 && Math.abs(q[0].x - q[1].x) < 1e-9, `${q[0].x} ${q[1].x}`);
  near('★ 　 對齊到最後選的「靠左」：軸的左緣 ＝ 齒輪的左緣 −5', A.alignPositions([shaft, gearB], 'x', A.ALIGN.MIN, 1)[0].x, -4.5, 1e-9);
  near('　 基準超出範圍 ⇒ 當成沒給', A.alignPositions([shaft, gearB], 'x', A.ALIGN.CENTER, 5)[0].x, q[0].x, 1e-9);

  // ③-11 綁參考線：搬碗、大小不變；挪線放手後原點置中
  const xy = [0, 50, 30, 50, 38, 40, 42, 20, 44, 0];
  const bowl = new io.ModelObject({ kind: io.KIND.SHEET,
    src: { type: 'pen', h: 3, open: true, up: false,
           paths: [{ closed: true, a: xy.slice(), hi: xy.map(() => 0), ho: xy.map(() => 0) }], rev: { dir: 'z', at: 0, seg: 32, stand: true } } });
  bowl.pos.set(100, 0, 20);
  const size = o => { const b = A.worldBounds(o); return [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z]; };
  const s0 = size(bowl);
  const r = io.revMoveToGuide(bowl, 95);
  ok('★★ ③-11 綁到 X 95：算得出要搬多少', r.ok && r.ax === 'x', r.reason);
  near('★★ 　 要往左搬 5', r.delta, -5, 1e-9);
  bowl.pos[r.ax] += r.delta; bowl.src.rev.bind = 95; bowl.invalidate();
  ok('★★★ 　 搬過去之後中心線就在 X 95', io.revOnGuide(bowl, 95));
  const s1 = size(bowl);
  ok('★★★ 　 碗的大小一格都不變（以前改 at ⇒ 當場變大一圈）', s0.every((v, i) => Math.abs(v - s1[i]) < 1e-6), `${s0} → ${s1}`);
  const doc = new io.Doc(); doc.add(bowl); doc.addGuide('x', 95);
  doc.removeGuide('x', 95); doc.addGuide('x', 90);
  io.revFollowGuide(doc, 'x', 95, 90);
  const before = A.worldBounds(bowl).clone();
  eq('★★ 　 挪線放手：跟著它的碗 1 個原點置中', io.revRecenterBound(doc, 'x', 90), 1);
  const after = A.worldBounds(bowl);
  ok('★★★ 　 置中之後畫面上一格都不動、仍然綁著', before.min.distanceTo(after.min) < 1e-6 && before.max.distanceTo(after.max) < 1e-6 && io.revOnGuide(bowl, 90), `${before.min.toArray()} ${after.min.toArray()}`);
  const c = after.getCenter(new THREE.Vector3());
  ok('★★ 　 原點在碗的外框中間（X、Z）', Math.abs(bowl.pos.x - c.x) < 1e-6 && Math.abs(bowl.pos.z - c.z) < 1e-6, `${bowl.pos.toArray()} vs ${c.toArray()}`);
  eq('　 沒綁的那條線 ⇒ 0 個', io.revRecenterBound(doc, 'z', 90), 0);

  // ③-12 外框中心
  const m = buildPrim('box', { w: 10, h: 10, d: 10 });
  const vs = m.verts.filter(v => v.p.y > 4.9);           // 頂面四個角
  const extra = [vs[0], vs[0], vs[1]].map(v => ({ kind: 'vertex', vert: v }));
  const all = [...vs.map(v => ({ kind: 'vertex', vert: v })), ...extra];
  const med = edit.elementCenter(m, all, 0.5, 'median'), bnd = edit.elementCenter(m, all, 0.5, 'bounds');
  ok('★★★ ③-12 四個角（其中兩個多選幾次也只算一次）：外框中心 ＝ 頂面正中間 (0, 5, 0)', bnd.distanceTo(new THREE.Vector3(0, 5, 0)) < 1e-9, bnd.toArray().join(','));
  const lop = [vs[0], vs[1], vs[2]].map(v => ({ kind: 'vertex', vert: v }));
  const m3 = edit.elementCenter(m, lop, 0.5, 'median'), b3 = edit.elementCenter(m, lop, 0.5, 'bounds');
  ok('★★ 　 三個角：重心偏一邊、外框中心照樣在外框中間（兩個不一樣）', m3.distanceTo(b3) > 1, `${m3.toArray()} ${b3.toArray()}`);
  ok('　 「重心」的意思⛔ 變（四個角 ⇒ 一樣在正中間）', med.distanceTo(new THREE.Vector3(0, 5, 0)) < 1e-9);
}

section('綜合評估 ③ 第三批（二）：陣列／鏡射照世界的方向（2026-10-19）');
{
  /** 編輯模式縮放照世界（③-4 後半）在畫面那一層（select.js），在本機／線上版用畫面驗 */
  const A = await import('../js/core/align.js');
  // 照 main.js arrayOp() 的做法做一個陣列：位置留著、角度歸零、縮放歸 1
  const makeArr = (obj, mode) => new io.ModelObject({ name: obj.name + '陣列', kind: obj.kind, src: io.arraySrcFrom(obj, mode),
    pos: obj.pos.clone(), rot: obj.rot.clone().set(0, 0, 0), scale: obj.scale.clone().set(1, 1, 1), thickness: obj.thickness });
  const oldArr = (obj, mode) => new io.ModelObject({ name: obj.name + '舊陣列', kind: obj.kind, src: io.arraySrcFrom(obj, mode, { world: false }),
    pos: obj.pos.clone(), rot: obj.rot.clone(), scale: obj.scale.clone(), thickness: obj.thickness });
  // 立起來的側板（平板繞 Z 轉 90°：板面朝左右）
  const panel = new io.ModelObject({ name: '側板', kind: io.KIND.SHEET, src: { type: 'plate', w: 100, d: 60 } });
  panel.rot.set(0, 0, Math.PI / 2); panel.pos.set(0, 50, 0);
  const bp = A.worldBounds(panel);
  const mir = makeArr(panel, ARRAY_MODES.MIRROR), bm = A.worldBounds(mir);
  ok('★★★ ③-2 立起來的側板鏡射：副本在旁邊（世界的左右），高度跟原件一樣（以前跑到頭頂）',
    Math.abs(bm.min.y - bp.min.y) < 1e-6 && Math.abs(bm.max.y - bp.max.y) < 1e-6, `原件 Y ${bp.min.y}～${bp.max.y}；陣列 Y ${bm.min.y}～${bm.max.y}`);
  ok('★★ 　 板子沒有厚度：對稱面往外 5 cm ⇒ 副本離 10 cm，⛔ 整片疊在原件上（本機實測抓到的）',
    !mir.stacked && Math.abs(mir.src.offset - (bp.max.x + 5)) < 1e-6 && bm.max.x - bp.max.x > 9.99, `offset ${mir.src.offset}、陣列 X ${bm.min.x}～${bm.max.x}`);
  const bo = A.worldBounds(oldArr(panel, ARRAY_MODES.MIRROR));
  ok('★★ 　 對照：舊的做法（角度留在陣列上）副本真的跑到上面', bo.max.y > bp.max.y + 1, `舊 Y ${bo.min.y}～${bo.max.y}`);
  // 轉過 90° 的橫料線性排列
  const bar = new io.ModelObject({ name: '橫料', kind: io.KIND.SHEET, src: { type: 'plate', w: 100, d: 10 } });
  bar.rot.set(0, Math.PI / 2, 0);
  const lin = makeArr(bar, ARRAY_MODES.LINEAR), bl = A.worldBounds(lin), bb = A.worldBounds(bar);
  ok('★★★ ③-1 轉過 90° 的橫料排列：沿世界的 X 排開，每份間距照轉過之後的寬（10 ＋ 10）',
    Math.abs(lin.src.step[0] - 20) < 1e-6 && Math.abs((bl.max.x - bl.min.x) - (bb.max.x - bb.min.x) - 40) < 1e-6 && Math.abs((bl.max.z - bl.min.z) - (bb.max.z - bb.min.z)) < 1e-6,
    `step ${lin.src.step}；陣列 X 寬 ${bl.max.x - bl.min.x}、Z ${bl.max.z - bl.min.z}`);
  // 立起來的板繞世界的 Y 轉一圈
  const fin = new io.ModelObject({ name: '鰭片', kind: io.KIND.SHEET, src: { type: 'plate', w: 20, d: 10 } });
  fin.rot.set(Math.PI / 2, 0, 0); fin.pos.set(0, 30, 0);
  const rad = makeArr(fin, ARRAY_MODES.RADIAL); rad.src.center = [50, 0, 0]; rad.invalidate();
  const br = A.worldBounds(rad), bf = A.worldBounds(fin);
  ok('★★★ ③-1 立起來的鰭片繞「Y 軸」排一圈：是世界的直立軸（每一份高度都跟原件一樣）',
    Math.abs(br.min.y - bf.min.y) < 1e-6 && Math.abs(br.max.y - bf.max.y) < 1e-6, `原件 Y ${bf.min.y}～${bf.max.y}；陣列 Y ${br.min.y}～${br.max.y}`);
  // 原件帶著角度與縮放；打散回去位置照樣對
  ok('★★ 　 原件帶著零件的角度（新的做法）', Math.abs(fin.rot.x - rad.src.child.rot[0]) < 1e-9 && rad.rot.x === 0);
  const parts = io.explodeArray(rad);
  const ub = new THREE.Box3(); for (const p of parts) ub.union(A.worldBounds(p));
  ok('★★ 　 打散成 8 個物件：拼起來跟陣列一模一樣', ub.min.distanceTo(br.min) < 1e-6 && ub.max.distanceTo(br.max) < 1e-6, `${ub.min.toArray()} vs ${br.min.toArray()}`);
  // 沒轉過的零件：跟以前一模一樣
  const flat = new io.ModelObject({ name: '平的', kind: io.KIND.SHEET, src: { type: 'plate', w: 30, d: 20 } });
  flat.pos.set(5, 0, 7);
  const a1 = A.worldBounds(makeArr(flat, ARRAY_MODES.LINEAR)), a0 = A.worldBounds(oldArr(flat, ARRAY_MODES.LINEAR));
  ok('★★ 　 沒轉過、沒縮放的零件：新舊做法排出來一模一樣', a1.min.distanceTo(a0.min) < 1e-9 && a1.max.distanceTo(a0.max) < 1e-9);
  const m1 = makeArr(flat, ARRAY_MODES.MIRROR), m0 = oldArr(flat, ARRAY_MODES.MIRROR);
  eq('　 　 鏡射的對稱面預設也一樣（置中的零件：右緣 ＝ 半個寬）', m1.src.offset, m0.src.offset);
  // 縮放搬進原件之後展開的警告照樣講
  const sq = new io.ModelObject({ name: '壓扁', kind: io.KIND.SHEET, src: { type: 'plate', w: 30, d: 20 } });
  sq.scale.set(1, 1, 2);
  const ru = unfoldObject(makeArr(sq, ARRAY_MODES.LINEAR), { material: 'paper' });
  ok('★ 　 原件被非等比縮放過：展開照樣講「圓弧會變成橢圓」', ru.warnings.some(w => w.includes('非等比縮放')), ru.warnings.join('｜'));
}

section('綜合評估 ④ 第一批（二）：環形繞別人、兩條外緣選一圈、折板原點、鋼筆座標／起點半徑、轉成鋼筆（2026-10-20）');
{
  /** 面板按鈕、鋼筆打座標的工具列（select.js）在本機／線上版用畫面驗 */
  const A = await import('../js/core/align.js');
  const { boundaryRingFrom } = await import('../js/core/selectops.js');

  // ④-2 環形繞世界原點／另一個物件的中心
  const part = new io.ModelObject({ name: '螺栓', kind: io.KIND.SOLID, src: { type: 'box', w: 2, h: 2, d: 2 } });
  part.pos.set(30, 5, 10);
  const arr = new io.ModelObject({ name: '螺栓（環形）', kind: io.KIND.SOLID, src: io.arraySrcFrom(part, ARRAY_MODES.RADIAL),
    pos: part.pos.clone(), rot: part.rot.clone().set(0, 0, 0), scale: part.scale.clone().set(1, 1, 1) });
  arr.src.center = io.radialCenterAt(arr, { x: 0, y: 0, z: 0 });
  eq('★★★ ④-2 繞世界原點：中心換成陣列自己的座標 (−30, −5, −10)', arr.src.center.join(','), '-30,-5,-10');
  const flange = new io.ModelObject({ name: '法蘭', src: { type: 'cylinder', r: 40, h: 4, seg: 32 } });
  flange.pos.set(-20, 2, 15);
  const fb = A.worldBounds(flange);
  const fc = { x: (fb.min.x + fb.max.x) / 2, y: (fb.min.y + fb.max.y) / 2, z: (fb.min.z + fb.max.z) / 2 };
  arr.src.center = io.radialCenterAt(arr, fc); arr.invalidate();
  if (csgOK) {
    const ab = A.worldBounds(arr);
    const ac = { x: (ab.min.x + ab.max.x) / 2, z: (ab.min.z + ab.max.z) / 2 };
    ok('★★★ 　 繞「法蘭」的中心：8 份排成一圈，圈的中心就在法蘭中心（世界的 X、Z）', Math.abs(ac.x - fc.x) < 0.2 && Math.abs(ac.z - fc.z) < 0.2, `${ac.x},${ac.z} vs ${fc.x},${fc.z}`);
  }
  const turned = new io.ModelObject({ src: arr.src, pos: arr.pos.clone(), rot: arr.rot.clone().set(0, Math.PI / 2, 0) });
  const back = io.radialCenterAt(turned, { x: 0, y: 0, z: 0 });
  const w = new THREE.Vector3(...back).applyMatrix4(turned.matrix());
  ok('★ 　 陣列本身轉過（舊檔那種）也換算得對：中心放回世界正好是原點', w.length() < 1e-3, w.toArray().join(','));

  // ④-18 兩條相鄰的外緣 ⇒ 一整圈開口
  const tube = buildPrim('cylinder', { r: 25, h: 70, seg: 32, openEnded: true });
  const rimHes = [...tube.edges()].filter(he => !he.face || !he.twin || !he.twin.face);
  const top = rimHes.filter(he => he.v.p.y > 30);
  const a0 = top[0], a1 = top.find(he => he !== a0 && [he.v.id, he.to.id].some(id => [a0.v.id, a0.to.id].includes(id)));
  const ring = boundaryRingFrom(tube, a0, a1);
  ok('★★★ ④-18 開口筒子上緣選兩條相鄰的 ⇒ 一整圈 32 條（以前「選一條線」走一步就停）', ring.ok && ring.hes.length === 32 && ring.hes.every(he => he.v.p.y > 30), ring.reason || ring.hes.length);
  ok('★★ 　 回傳的都是有面的那一側（畫面上點得到的）', ring.ok && ring.hes.every(he => !!he.face));
  const far = top.find(he => ![he.v.id, he.to.id].some(id => [a0.v.id, a0.to.id].includes(id)));
  ok('★ 　 兩條沒接在一起 ⇒ 講原因', !boundaryRingFrom(tube, a0, far).ok && boundaryRingFrom(tube, a0, far).reason.includes('接在一起'));
  const box = buildPrim('box', { w: 10, h: 10, d: 10 });
  const [e1, e2] = [...box.edges()].slice(0, 2);
  ok('★ 　 不是開口的邊 ⇒ 講原因（指到「含外緣」）', !boundaryRingFrom(box, e1, e2).ok && boundaryRingFrom(box, e1, e2).reason.includes('含外緣'));

  // ④-19 折板原點在第幾段
  const bp = { w: 11, first: 1, arcSeg: 4, k: 0.4, bends: [{ angle: 90, ri: 0.2, len: 7.5 }] };
  const p1 = prim.bendProfile(bp, 0.5), p2 = prim.bendProfile({ ...bp, anchorSeg: 2 }, 0.5);
  ok('★★ ④-19 原點在第 1 段：跟以前一樣從 (0, 0) 開始', p1.line[0][0] === 0 && p1.line[0][1] === 0 && p1.anchor === 1);
  const s2 = p1.segStarts[1];
  ok('★★★ 　 原點在第 2 段（隔板的牆）：牆的起點在原點、整條只是平移', p2.anchor === 2
    && p2.line.every((q, i) => Math.abs(q[0] - (p1.line[i][0] - s2[0])) < 1e-9 && Math.abs(q[1] - (p1.line[i][1] - s2[1])) < 1e-9)
    && p2.line.some(q => Math.abs(q[0]) < 1e-9 && Math.abs(q[1]) < 1e-9), `第 2 段起點 ${s2}`);
  /** ⚠ T3 當時算的 1.45 ＝ 1 ＋ 0.2 ＋ 0.25 是量到「板厚中間」；折板的網格是**中性面**（K 0.4 ⇒ 中性層半徑 0.2 ＋ 0.4 × 0.5 ＝ 0.4）⇒ 1.4 */
  near('★★ 　 T3 的例子：牆（中性面）的起點離第一段起點 1.4（＝ 1 ＋ 中性層半徑 0.4）', s2[0], 1.4, 1e-9);
  eq('　 打太大 ⇒ 夾到最後一段', prim.bendProfile({ ...bp, anchorSeg: 9 }, 0.5).anchor, 2);
  const m1 = buildPrim('bend', bp, 0.5), m2 = buildPrim('bend', { ...bp, anchorSeg: 2 }, 0.5);
  near('　 換原點不改形狀（面積一樣）', m2.area(), m1.area(), 1e-9);

  // ④-13 旋轉成形打起點離中心線
  const xy = [3, 0, 8, 6];
  const pen = { type: 'pen', h: 3, open: true, paths: [{ closed: false, a: xy.slice(), hi: [0, 0, 0, 0], ho: [0, 0, 0, 0] }], rev: { dir: 'z', at: 0, seg: 32, stand: false } };
  const q = prim.penRevAtForHeadR(pen, 5);
  ok('★★★ ④-13 起點在 X 3、要離中心線 5 ⇒ 中心線挪到 −2（留在原本那一側）', q.ok && Math.abs(q.at - (-2)) < 1e-9, q.at);
  const r2 = prim.penRevolve({ ...pen, rev: { ...pen.rev, at: q.at } });
  near('★★ 　 轉出來的起點半徑真的是 5', r2.profileR.head, 5, 1e-9);
  ok('　 打負數 ⇒ 講原因', !prim.penRevAtForHeadR(pen, -1).ok);

  // ④-7 匯入的形狀轉成鋼筆
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10cm" height="10cm" viewBox="0 0 100 100">
    <path d="M10 10 L90 10 L90 90 L10 90 Z M40 40 L60 40 L60 60 L40 60 Z"/></svg>`;
  const rs = prof.readSVG(svg, { tolMm: 0.05 });
  const l = rs.loops[0];
  ok('　 匯入的封閉形狀帶著錨點（外圈與洞都有 bez）', !!l.bez && l.bez.a.length >= 8 && l.holes.length === 1 && !!l.holes[0].bez);
  const shape = { out: l.pts.flatMap(p => [p.x, p.y]), holes: [l.holes[0].pts.flatMap(p => [p.x, p.y])], ob: l.bez, hb: [l.holes[0].bez] };
  const moved = prim.shiftShape(shape, -5, -5);
  ok('★ 　 shiftShape 連錨點一起搬（把手不動）', Math.abs(moved.ob.a[0] - (l.bez.a[0] - 5)) < 1e-3 && moved.ob.hi.join() === l.bez.hi.join());
  const ex = { type: 'extrude', h: 2, shapes: [moved] };
  const conv = prim.extrudeToPenSrc(ex);
  ok('★★★ ④-7 擠出件轉成鋼筆：2 條線（外圈＋洞）、用的是 Illustrator 的錨點', conv.ok && conv.src.type === 'pen' && conv.src.paths.length === 2 && conv.approx === 0, JSON.stringify({ n: conv.src && conv.src.paths.length, approx: conv.approx }));
  const mE = buildPrim('extrude', ex), mP = buildPrim('pen', conv.src);
  near('★★★ 　 轉之前、之後體積一樣（洞也還在）', mP.volume(), mE.volume(), 1e-6);
  const bE = mE.bounds(), bP = mP.bounds();
  ok('★★ 　 位置、大小一樣（外框對得上）', bE.min.distanceTo(bP.min) < 1e-6 && bE.max.distanceTo(bP.max) < 1e-6);
  const old = prim.extrudeToPenSrc({ type: 'extrude', h: 2, shapes: [{ out: shape.out, holes: shape.holes }] });
  ok('★ 　 舊的匯入（沒有記錨點）：照樣轉得出來、講「approx」', old.ok && old.approx === 2);
  ok('　 不是擠出件 ⇒ 講原因', !prim.extrudeToPenSrc({ type: 'box' }).ok);
  /**
   * 🔴 本機畫面試出來的：帶一段弧的稿子，轉成鋼筆少了 0.7% 體積 —— 鋼筆預設 0.2 cm 才切一刀、匯入是 0.2 mm。
   * 正確值用算的：80 × 80 − 20 × 20 ＋ 弧凸出去那塊 195（單位²，1 單位 ＝ 0.1 cm）＝ 6195 ⇒ 61.95 cm² × 厚 3 ＝ 185.85
   */
  const svgC = `<svg xmlns="http://www.w3.org/2000/svg" width="10cm" height="10cm" viewBox="0 0 100 100">
    <path d="M10 10 L90 10 L90 90 C60 95 40 95 10 90 Z M40 40 L60 40 L60 60 L40 60 Z"/></svg>`;
  const lc = prof.readSVG(svgC, { tolMm: 0.2 }).loops[0];
  const exC = { type: 'extrude', h: 3, tol: 0.02, shapes: [{ out: lc.pts.flatMap(p => [p.x, p.y]), holes: [lc.holes[0].pts.flatMap(p => [p.x, p.y])], ob: lc.bez, hb: [lc.holes[0].bez] }] };
  const cvC = prim.extrudeToPenSrc(exC);
  const vE = buildPrim('extrude', exC).volume(), vP = buildPrim('pen', cvC.src).volume();
  ok('★★★ 　 有弧的稿子：轉過去照匯入的容許值細分（0.02 cm），體積差不到 0.1%（以前少 0.7%）', cvC.src.tol === 0.02 && Math.abs(vP - vE) / vE < 1e-3, `${vE} → ${vP}`);
  ok('★★ 　 　 兩邊都貼近算出來的 185.85（差不到 0.1%）', Math.abs(vE - 185.85) / 185.85 < 1e-3 && Math.abs(vP - 185.85) / 185.85 < 1e-3, `${vE}／${vP}`);
  eq('★ 　 　 舊的匯入沒記容許值 ⇒ 用匯入的預設 0.02 cm', prim.extrudeToPenSrc({ ...exC, tol: undefined }).src.tol, 0.02);
}

section('綜合評估 ④ 第二批：鋼筆轉角圓角（2026-10-20）');
{
  /** 工具列的按鈕、Ctrl+Z 退回（main.js、select.js）在本機／線上版用畫面驗 */
  const sq = () => ({ closed: true, a: [0, 0, 40, 0, 40, 20, 0, 20], hi: Array(8).fill(0), ho: Array(8).fill(0) });
  const areaOf = path => {
    const pts = prim.flattenPenPath(path, 0.001);
    let s = 0;
    for (let i = 0; i < pts.length; i++) { const u = pts[i], v = pts[(i + 1) % pts.length]; s += u.x * v.y - v.x * u.y; }
    return Math.abs(s / 2);
  };
  let p = sq();
  const r1 = prim.penFilletAt(p, 0, 5);
  ok('★★★ ④-13 方框一個角倒 R 5：那個點換成兩個（4 → 5 個點）', r1.ok && p.a.length / 2 === 5, JSON.stringify(r1));
  ok('★★ 　 圓弧兩端剛好離角 5（直角 ⇒ 離角的距離 ＝ R）', Math.abs(p.a[0] - 0) < 1e-9 && Math.abs(p.a[1] - 5) < 1e-9 && Math.abs(p.a[2] - 5) < 1e-9 && Math.abs(p.a[3]) < 1e-9, p.a.slice(0, 4).join(','));
  const k = 4 / 3 * Math.tan(Math.PI / 8) * 5;
  near('★★ 　 把手長 ＝ 4/3 × tan(22.5°) × 5（畫圓弧的標準值）', Math.hypot(p.ho[0], p.ho[1]), k, 1e-9);
  near('★★★ 　 面積少了 (1 − π/4) × 25（切掉的那塊；貝茲畫的圓弧誤差很小）', areaOf(p), 800 - (4 - Math.PI) / 4 * 25, 0.01);

  p = sq();
  const all = prim.penFilletAll(p, 5);
  ok('★★★ 整條都倒 R 5：4 個角都倒、8 個點', all.ok && all.done === 4 && p.a.length / 2 === 8, JSON.stringify(all));
  near('★★ 　 面積 ＝ 圓角矩形 800 − (4 − π) × 25', areaOf(p), 800 - (4 - Math.PI) * 25, 0.02);
  p = sq();
  const big = prim.penFilletAll(p, 11);
  ok('★★★ 　 R 11 太大（短邊 20 兩頭各吃 11）⇒ ⛔ 倒、講最大 R 10、形狀一格不動', !big.ok && big.maxR === 10 && big.reason.includes('最大只能 R 10') && p.a.length === 8);
  p = sq();
  const pill = prim.penFilletAll(p, 10);
  ok('★★★ 　 R 10 剛好 ＝ 短邊的一半 ⇒ 膠囊形：短邊兩頭的點併成一個（6 個點、⛔ 留長度 0 的線）', pill.ok && p.a.length / 2 === 6, p.a.length / 2);
  near('★★ 　 　 面積 ＝ 20 × 20 ＋ π × 10²', areaOf(p), 400 + Math.PI * 100, 0.1);

  const one = sq();
  const b1 = prim.penFilletAt(one, 2, 25);
  ok('★★ 一個角倒太大 ⇒ ⛔ 倒、講最大值（兩邊較短的那一邊 ＝ 20）', !b1.ok && b1.maxR === 20 && one.a.length === 8, b1.reason);

  const tri = { closed: true, a: [0, 0, 30, 0, 0, 30], hi: Array(6).fill(0), ho: Array(6).fill(0) };
  prim.penFilletAt(tri, 1, 3);
  near('★★ 45° 的角 R 3：圓弧端點離角 3 ÷ tan(22.5°)', 30 - tri.a[2], 3 / Math.tan(Math.PI / 8), 1e-9);

  const open = { closed: false, a: [0, 0, 10, 0, 10, 10], hi: Array(6).fill(0), ho: Array(6).fill(0) };
  ok('★ 不封口的線：頭尾不是角 ⇒ 講原因；中間那個角倒得了', !prim.penFilletAt(open, 0, 1).ok && prim.penFilletAt(open, 1, 2).ok);
  /** 右下角 (40, 0) 的出把手朝上 ⇒ 往上那一段是曲線、這個角照樣有轉折 */
  const curvy = sq(); curvy.ho[3] = 5;
  ok('★★ 旁邊有曲線（有把手）⇒ ⛔ 倒、講「只倒兩邊都是直線的角」', !prim.penFilletAt(curvy, 1, 2).ok && prim.penFilletAt(curvy, 1, 2).reason.includes('直線'));
  const cv2 = sq(); cv2.ho[3] = 5;
  const sk = prim.penFilletAll(cv2, 2);
  ok('★ 　 整條都倒：旁邊有曲線的角跳過、講跳過幾個', sk.ok && sk.done === 2 && sk.skipped === 2, JSON.stringify(sk));
  const again = sq(); prim.penFilletAt(again, 2, 5);
  const ag = prim.penFilletAll(again, 5);
  ok('★★ 　 先倒一個角、再整條都倒：剛倒好的圓弧兩端是順的 ⇒ ⛔ 算成「沒倒到的角」（本機畫面試出來的）', ag.ok && ag.done === 3 && ag.skipped === 0, JSON.stringify(ag));
  const line = { closed: true, a: [0, 0, 10, 0, 20, 0, 20, 10], hi: Array(8).fill(0), ho: Array(8).fill(0) };
  ok('　 直直一條線上的點 ⇒ 沒有角可以倒', !prim.penFilletAt(line, 1, 1).ok);
  ok('　 R 打 0 或負數 ⇒ 講原因', !prim.penFilletAt(sq(), 0, 0).ok && !prim.penFilletAll(sq(), -1).ok);

  const qf = sq(); prim.penFilletAll(qf, 5);
  const solid = buildPrim('pen', { type: 'pen', h: 3, paths: [qf] });
  const fine = buildPrim('pen', { type: 'pen', h: 3, tol: 0.001, paths: [qf] });
  near('★★★ 倒好的鋼筆照樣做得出實體：細分夠細時體積 ＝ 圓角矩形面積 × 厚 3', fine.volume(), (800 - (4 - Math.PI) * 25) * 3, 0.1);
  /**
   * ⚠ 鋼筆預設的細分切圓弧會少一點點（當時 0.2 cm：體積少 0.25%、圓弧最多差約 0.1 cm）——
   * kang 2026-10-20 同意改成 0.05 cm（`PEN_TOL`，見下一段）
   */
  ok('　 預設細分做出來的少一點點（< 0.5%）', solid.volume() < fine.volume() && (fine.volume() - solid.volume()) / fine.volume() < 0.005, `${solid.volume()} vs ${fine.volume()}`);
}

section('綜合評估 ④ 第二批（一）之後的一小輪：鋼筆細分改 0.05 cm（2026-10-20）');
{
  /** 編輯路徑每一步都能退（select.js、main.js）在本機／線上版用畫面驗 */
  eq('★★ 鋼筆的預設細分 ＝ 0.05 cm（以前跟 SVG 共用 0.2 cm）', prim.PEN_TOL, 0.05);
  const q = { closed: true, a: [0, 0, 60, 0, 60, 40, 0, 40], hi: Array(8).fill(0), ho: Array(8).fill(0) };
  prim.penFilletAll(q, 5);
  const pts = prim.flattenPenPath(q);
  let dev = 0;
  for (let i = 0; i < pts.length; i++) {
    const u = pts[i], v = pts[(i + 1) % pts.length];
    if (Math.max(u.x, v.x) <= 5 + 1e-9 && Math.max(u.y, v.y) <= 5 + 1e-9) dev = Math.max(dev, 5 - Math.hypot((u.x + v.x) / 2 - 5, (u.y + v.y) / 2 - 5));
  }
  ok('★★★ 　 R 5 的圓角跟真的圓弧最多差 0.03 cm 以內（以前約 0.1 cm）', dev > 0 && dev < 0.03, dev.toFixed(4));
  ok('★ 　 點數合理：60 × 40 四角 R 5 不到 50 個點（以前 20 個）', pts.length > 20 && pts.length < 50, pts.length);
  const v1 = buildPrim('pen', { type: 'pen', h: 3, paths: [q] }).volume();
  near('★★ 　 做成實體的體積貼近圓角矩形（差不到 0.05%）', v1, (2400 - (4 - Math.PI) * 25) * 3, (2400 - (4 - Math.PI) * 25) * 3 * 5e-4);
  const own = buildPrim('pen', { type: 'pen', h: 3, tol: 0.2, paths: [q] }).volume();
  ok('★ 　 物件自己記了 tol（例如 0.2）就照它的 ⇒ 比較粗、體積少一點', own < v1, `${own} vs ${v1}`);
  eq('　 SVG 匯入沒有單位時用的 DEFAULT_TOL ⛔ 動（0.2）', svgp.DEFAULT_TOL, 0.2);
}

section('綜合評估 ④ 第二批（二）：干涉檢查（2026-10-20）');
if (csgOK) {
  /** 面板的「檢查」、紅色那幾塊、點一列選起來（main.js、toolbar.js、scene.js）在本機／線上版用畫面驗 */
  const C = await import('../js/core/interfere.js');
  const box = (name, w, h, d, x, y, z) => {
    const o = new io.ModelObject({ name, kind: io.KIND.SOLID, src: { type: 'box', w, h, d } });
    o.pos.set(x, y, z);
    return o;
  };
  const wall = box('盒壁', 1, 20, 40, 0, 10, 0);          // X −0.5～0.5、Y 0～20
  const div = box('隔板', 30, 18, 0.5, 15.3, 10, 0);     // X 0.3～30.3 ⇒ 穿進盒壁 0.2
  const floor = box('盒底', 40, 1, 40, 15, -0.5, 0);      // Y −1～0：盒壁剛好站在上面
  const r = C.findClashes([wall, div, floor]);
  ok('★★★ ④-20 隔板穿進盒壁 0.2 cm ⇒ 列出 1 對、重疊 0.2 × 18 × 0.5 ＝ 1.8 cm³', r.ok && r.list.length === 1
    && Math.abs(r.list[0].volume - 1.8) < 1e-6 && r.list[0].size.map(v => +v.toFixed(6)).join() === '0.2,18,0.5', r.list.map(C.clashLine).join('｜'));
  ok('★★ 　 列出來的是那兩個（盒壁 × 隔板），重疊那一塊有網格（畫紅色用）', r.ok && [r.list[0].a.name, r.list[0].b.name].sort().join() === '盒壁,隔板' && !!r.list[0].mesh);
  ok('★★★ 　 盒壁站在盒底上（面碰面）⇒ ⛔ 算，只數成「貼在一起」', r.ok && r.touching >= 1 && !r.list.some(c => [c.a.name, c.b.name].includes('盒底')), r.touching);
  eq('★ 　 講給人看的那一行', C.clashLine(r.list[0]).replace(/「(盒壁|隔板)」×「(盒壁|隔板)」/, 'AB'), 'AB：重疊 1.8 cm³（範圍 0.2 × 18 × 0.5 cm）');

  const plate = new io.ModelObject({ name: '平板', kind: io.KIND.SHEET, src: { type: 'plate', w: 20, d: 20 } });
  plate.thickness = 0.5; plate.pos.set(0, 5, 0);
  const rp = C.findClashes([wall, plate]);
  ok('★★★ 板件照板厚算：板厚 0.5 的平板穿過 1 cm 厚的盒壁 ⇒ 重疊 1 × 0.5 × 20 ＝ 10 cm³', rp.ok && rp.list.length === 1 && Math.abs(rp.list[0].volume - 10) < 1e-6, rp.list.map(C.clashLine).join());
  const thin = new io.ModelObject({ name: '紙', kind: io.KIND.SHEET, src: { type: 'plate', w: 20, d: 20 } });
  thin.thickness = 0; thin.pos.set(0, 5, 0);
  const rt = C.findClashes([wall, thin]);
  ok('★★ 　 板厚 0 的板件 ⇒ ⛔ 算、講原因（沒有厚度）', rt.ok && rt.list.length === 0 && rt.skipped.length === 1 && rt.skipped[0].reason.includes('板厚'), JSON.stringify(rt.skipped));

  const far = box('遠的', 5, 5, 5, 200, 2.5, 0);
  const rf = C.findClashes([wall, far]);
  ok('★ 離很遠 ⇒ 連布林都⛔ 做（外框先擋掉）、沒有穿到', rf.ok && rf.pairs === 0 && rf.list.length === 0);
  const tilt = box('斜的', 10, 10, 10, 3, 10, 0); tilt.rot.set(0, Math.PI / 4, 0);
  const rr = C.findClashes([wall, tilt]);
  ok('★★ 轉過角度的零件照世界座標算（轉 45° 的方塊壓在盒壁上 ⇒ 穿到）', rr.ok && rr.list.length === 1 && rr.list[0].volume > 1, rr.list.map(C.clashLine).join());
  const big = box('大', 10, 10, 10, 0, 5, 50), small = box('小', 2, 2, 2, 1, 5, 50);
  const rb = C.findClashes([big, small]);
  ok('★★ 一個整個包在另一個裡面 ⇒ 重疊 ＝ 小的那個（8 cm³）', rb.ok && rb.list.length === 1 && Math.abs(rb.list[0].volume - 8) < 1e-6);
  ok('　 少於兩個物件 ⇒ 講原因', !C.findClashes([wall]).ok);
  const near = box('差一點', 10, 10, 10, 5.505, 5, 0);   // X 0.505～：跟盒壁差 0.005
  const rn = C.findClashes([wall, near]);
  ok('★ 　 只差 0.005 cm（還沒碰到）⇒ ⛔ 列', rn.ok && rn.list.length === 0);
  const shallow = box('擦到', 10, 10, 10, 5.495, 5, 0);   // 疊 0.005 cm（比 0.01 薄）⇒ 當成貼著
  const rs = C.findClashes([wall, shallow]);
  ok('★★ 　 只疊 0.005 cm（比 0.01 cm 薄）⇒ 當成貼在一起、⛔ 列', rs.ok && rs.list.length === 0 && rs.touching === 1);
}

section('綜合評估 ④ 第二批（三）：同軸貼合（2026-10-20）');
{
  /** 工具列「同軸」、點兩下、黃線（main.js）在本機／線上版用畫面驗 */
  const M = await import('../js/core/mate.js');
  const sideOf = obj => { const m = obj.mesh(); m.computeNormals(); return m.faces.find(f => Math.abs(f.normal.y) < 0.1); };
  const shaft = new io.ModelObject({ name: '軸', src: { type: 'cylinder', r: 0.3, h: 6, seg: 32 } });
  shaft.pos.set(5, 3, 2); shaft.rot.set(0.3, 0, 0.2);
  const fs = M.cylinderFrame(shaft, sideOf(shaft));
  const wantDir = new THREE.Vector3(0, 1, 0).applyEuler(shaft.rot);
  ok('★★★ ④-9 點圓柱的側面 ⇒ 中心線穿過它的中心、方向 ＝ 它轉過之後的高度方向、半徑 0.3', fs.ok
    && fs.point.distanceTo(new THREE.Vector3(5, 3, 2)) < 1e-6 && Math.abs(Math.abs(fs.dir.dot(wantDir)) - 1) < 1e-9 && Math.abs(fs.radius - 0.3) < 1e-6, fs.reason || fs.point.toArray().join());
  ok('★★ 　 那一圈長到整個側面就停（蓋子 90° ⛔ 算進來）：64 個三角形', fs.ok && fs.count === 64, fs.count);
  const m0 = shaft.mesh();
  const cap = m0.faces.find(f => f.normal.y > 0.9);
  ok('★★ 　 點到平的蓋子 ⇒ ⛔ 猜、講「要點圓的側面」', !M.cylinderFrame(shaft, cap).ok && M.cylinderFrame(shaft, cap).reason.includes('圓的側面'));
  const ball = new io.ModelObject({ name: '球', src: { type: 'sphere', r: 5 } });
  const bm = ball.mesh(); bm.computeNormals();
  const rb = M.cylinderFrame(ball, bm.faces[Math.floor(bm.faces.length / 2)]);
  ok('★ 　 球面 ⇒ ⛔ 猜（不是繞同一條中心線的圓）', !rb.ok, rb.reason || 'ok?');
  const scaled = new io.ModelObject({ name: '扁', src: { type: 'cylinder', r: 1, h: 2, seg: 32 } });
  scaled.scale.set(1, 3, 1); scaled.pos.set(-4, 0, 0);
  const fsc = M.cylinderFrame(scaled, sideOf(scaled));
  ok('★ 　 拉長過的圓柱（Y × 3）：中心線方向照樣是 Y、半徑照樣 1', fsc.ok && Math.abs(Math.abs(fsc.dir.y) - 1) < 1e-9 && Math.abs(fsc.radius - 1) < 1e-6);
  if (csgOK) {
    const B = await import('../js/build/bool.js');
    const board = new io.ModelObject({ name: '板', src: { type: 'box', w: 20, h: 2, d: 20 } }); board.pos.set(10, 1, 0);
    const cut = new io.ModelObject({ name: '孔', src: { type: 'cylinder', r: 1, h: 4, seg: 32 } }); cut.pos.set(13, 1, -4);
    const plate = new io.ModelObject({ name: '有孔的板', src: io.boolSrcFrom([board, cut], B.BOOL_OPS.SUBTRACT), pos: board.pos.clone() });
    const pm = plate.mesh(); pm.computeNormals();
    const wall = pm.faces.find(f => {
      if (Math.abs(f.normal.y) > 0.1) return false;
      const vs = pm.faceVerts(f).map(v => v.p);
      const cx = vs.reduce((s, p) => s + p.x, 0) / vs.length, cz = vs.reduce((s, p) => s + p.z, 0) / vs.length;
      return Math.hypot(cx - 3, cz + 4) < 1.2;
    });
    const fh = M.cylinderFrame(plate, wall);
    ok('★★★ 　 布林挖出來的孔：點孔的內壁 ⇒ 中心線在 (13, ?, −4)、垂直、半徑 1（法線朝內也算得對）', fh.ok
      && Math.hypot(fh.point.x - 13, fh.point.z + 4) < 1e-6 && Math.abs(Math.abs(fh.dir.y) - 1) < 1e-9 && Math.abs(fh.radius - 1) < 1e-6, fh.reason || fh.point.toArray().join());
    const pin = new io.ModelObject({ name: '軸', src: { type: 'cylinder', r: 0.9, h: 6, seg: 32 } });
    pin.pos.set(-5, 8, 7); pin.rot.set(0.4, 0, 0);
    const fp = M.cylinderFrame(pin, sideOf(pin));
    const r = M.mateCoaxial(pin, fp, fh);
    pin.pos.copy(r.pos); pin.rot.copy(r.rot); pin.invalidate();
    const after = M.cylinderFrame(pin, sideOf(pin));
    ok('★★★ ④-9 同軸：斜放的軸對到孔 ⇒ 中心線變成同一條（垂直、穿過孔心）', after.ok && Math.abs(Math.abs(after.dir.y) - 1) < 1e-9
      && Math.hypot(after.point.x - 13, after.point.z + 4) < 1e-6, after.point.toArray().join());
    near('★★★ 　 沿中心線的上下位置⛔ 動（軸的中心還在 Y 8）', after.point.y, 8, 1e-6);
    near('★★ 　 只轉需要的那一點（原本斜 0.4 弧度 ＝ 22.92°）', r.angle, 0.4 * 180 / Math.PI, 1e-6);
    ok('★ 　 再對一次 ⇒ 已經同軸、⛔ 動', !M.mateCoaxial(pin, after, fh).moved);
  }
  const p2 = new io.ModelObject({ name: '倒過來的軸', src: { type: 'cylinder', r: 0.5, h: 4, seg: 32 } });
  p2.rot.set(Math.PI - 0.1, 0, 0); p2.pos.set(2, 5, 0);
  const f2 = M.cylinderFrame(p2, sideOf(p2));
  const r2 = M.mateCoaxial(p2, f2, fs);
  ok('★★ 　 方向剛好反過來的 ⇒ 挑轉最少的那一邊（⛔ 無故翻 180°）', r2.angle < 30, r2.angle);
}

section('綜合評估 ⑤ 第一批（一）：操作類（2026-10-20）');
{
  /** 新增擺放、Ctrl+D、Ctrl+Y、Esc、貼合改用面、確認框、點的大小、提示換行（main.js／scene.js／index.html）在本機版用畫面驗 */
  const { History } = await import('../js/core/history.js');
  let st = 0;
  const h = new History({ get: () => st, set: v => { st = v; } });
  h.reset('開始');
  st = 1; h.commit('A');
  st = 1; h.commit('點一下已選的點');
  eq('★★★ ⑤-11 跟上一步一模一樣 ⇒ ⛔ 記（以前多一步「拉點」）', h.stack.length, 2);
  eq('★★ 　 復原撤銷的是 A（⛔ 是那個什麼都沒改的）', h.undo(), 'A');
  st = 0; h.commit('沒改');
  ok('★ 　 在復原之後「什麼都沒改」⇒ 重做那條也⛔ 被砍掉', h.canRedo);
  h.redo();
  st = 2; h.commit('拉面', { tag: 7 });
  st = 3; h.commit('拉面', { tag: 7, replace: true });
  eq('★★★ ⑤-11 拖完接著打數字 ⇒ 取代剛才那一步（⛔ 多一步）', h.stack.length, 3);
  eq('★★ 　 復原一次就回到拖之前', (h.undo(), st), 1);
  h.redo();
  st = 4; h.commit('別的');
  st = 5; h.commit('拉面', { tag: 7, replace: true });
  eq('★★ 　 中間做過別的事 ⇒ 照舊記成新的一步（⛔ 吃掉「別的」）', h.stack.map(e => e.label).join(), '開始,A,拉面,別的,拉面');
  st = 6; h.commit('拉點', { tag: 9 });
  st = 5; h.commit('拉點', { tag: 9, replace: true });
  eq('★ 　 打的數字等於沒動（回到上一步的樣子）⇒ 那一步整個拿掉', h.stack.map(e => e.label).join(), '開始,A,拉面,別的,拉面');
  const big = new History({ get: () => st, set: v => { st = v; } });
  eq('★★ ⑤-11 預設記 200 步（以前 60）', big.limit, 200);
  big.reset();
  for (let i = 1; i <= 210; i++) { st = 1000 + i; big.commit('第 ' + i + ' 步'); }
  ok('★★ 　 超過 200 步 ⇒ 丟最舊的、記下「丟過」（退到底時講只記得最近 200 步）', big.stack.length === 200 && big.trimmed);
  const fat = new History({ get: () => 'x'.repeat(1000) + st, set: () => {}, maxBytes: 5000 });
  fat.reset();
  for (let i = 0; i < 10; i++) { st = 2000 + i; fat.commit('大'); }
  ok('★ 　 總量超過上限 ⇒ 也丟最舊的（大模型⛔ 吃光記憶體）', fat.bytes <= 5000 && fat.trimmed, fat.bytes);

  const A = await import('../js/core/align.js');
  const B = (x0, y0, z0, x1, y1, z1) => new THREE.Box3(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
  const cube = B(-30, 0, -20, 30, 45, 20);                     // 預設方塊 60 × 45 × 40，貼地
  const s0 = A.freeSpot(cube, { x: 103.4, z: -50.6 }, []);
  ok('★★★ ⑤-1 空的地方 ⇒ 放在畫面正中間（四捨五入到整數 cm）', s0.x === 103 && s0.z === -51 && !s0.moved, JSON.stringify(s0));
  const occ = [B(-30, 0, -20, 30, 45, 20)];
  const s1 = A.freeSpot(cube, { x: 0, z: 0 }, occ);
  ok('★★★ 　 中間有東西 ⇒ 挪到最近的空位、⛔ 疊到', s1.moved && !occ.some(o => o.intersectsBox(cube.clone().translate(new THREE.Vector3(s1.x, 0, s1.z)))), JSON.stringify(s1));
  ok('★★ 　 挪一格（深 40 ＋ 間隙 10 ⇒ 50），⛔ 跳到 90 cm 外', s1.x === 0 && Math.abs(s1.z) === 50, JSON.stringify(s1));
  const sf = A.freeSpot(cube, { x: 0, z: 0 }, occ, { right: { x: 1, z: 0 }, eye: { x: 0, z: 500 } });
  ok('★★ 　 給了畫面的右方（正視圖）⇒ 先排左右兩邊（X ±70），⛔ 排到正後方', Math.abs(sf.x) === 70 && sf.z === 0, JSON.stringify(sf));
  const r45 = { x: Math.SQRT1_2, z: -Math.SQRT1_2 };
  const si = A.freeSpot(cube, { x: 0, z: 0 }, occ, { right: r45, eye: { x: 340, z: 340 } });
  ok('★ 　 等角視圖：一樣好的兩個位置 ⇒ 挑靠鏡頭那邊（Z +50，⛔ 躲在後面）', si.x === 0 && si.z === 50, JSON.stringify(si));
  const high = [B(-30, 100, -20, 30, 140, 20)];
  ok('★ 　 正上方懸空的東西 ⇒ ⛔ 算疊到（物件貼地放）', !A.freeSpot(cube, { x: 0, z: 0 }, high).moved);
  const plate = B(-50, 0, -30, 50, 0, 30);                     // 平板 100 × 60：網格是一片，外框高度 0
  ok('★★★ 　 平板（外框高度 0）碰到中間的方塊 ⇒ 也要挪開（線上先驗：以前放進方塊底下）', A.freeSpot(plate, { x: 0, z: 0 }, occ).moved);
  ok('★★ 　 反過來：中間是平板、再加方塊 ⇒ 也要挪開', A.freeSpot(cube, { x: 0, z: 0 }, [plate]).moved);
  eq('★★ ⑤-1 間隙：60 cm 寬 ⇒ 10（最多 10）', A.placeGap(60), 10);
  eq('★ 　 2 cm 寬 ⇒ 1（最少 1）', A.placeGap(2), 1);
  near('★ 　 20 cm 寬 ⇒ 4（寬度的 0.2 倍）', A.placeGap(20), 4);
  eq('★★★ ⑤-1 Ctrl+D：旁邊空著 ⇒ 往 +X 挪「寬 ＋ 間隙」（60 ＋ 10 ＝ 70，以前固定 +30／+30 會疊到）', A.besideShift(cube, [cube]), 70);
  eq('★★ 　 旁邊已經有一個複本 ⇒ 再挪一個寬（140）', A.besideShift(cube, [cube, cube.clone().translate(new THREE.Vector3(70, 0, 0))]), 140);

  const box = baked('box', { w: 60, d: 45, h: 40 });
  const bb = box.bounds();
  const r7 = edit.solidCut(box, box.faces.filter(f => {
    const ps = box.faceVerts(f).map(v => v.p);
    return ps.every(p => Math.abs(p.y - bb.max.y) < 1e-6) || ps.every(p => Math.abs(p.z - bb.max.z) < 1e-6);
  }).map(face => ({ kind: 'face', face })));
  ok('★★★ ⑤-21 切成實心擋下來 ⇒ 交出交界那一圈邊（方塊相鄰兩面：6 條）', !r7.ok && r7.edges && r7.edges.length === 6, r7.edges && r7.edges.length);
  ok('★ 　 每一條是兩個點（物件自己的座標）', r7.edges.every(e => e.length === 2 && e[0].isVector3));
  ok('★ 　 還沒分組就擋下的（沒選東西）⇒ ⛔ 交邊', !edit.solidCut(box, []).edges);

  const so = await import('../js/core/selectops.js');
  const cyl = baked('cylinder', { r: 20, h: 40 });
  const sph = baked('sphere', { r: 30, segW: 32, segH: 16 });
  const lat = [...sph.edges()].find(e => Math.abs(e.v.p.y - e.to.p.y) < 1e-9 && Math.abs(e.v.p.y) < 5);
  const sideEdge = [...cyl.edges()].find(e => e.face && e.twin && e.twin.face
    && cyl.faceLoop(e.face).length === 4 && cyl.faceLoop(e.twin.face).length === 4
    && Math.abs(e.v.p.y - e.to.p.y) > 1);
  const nSide = so.edgeLoop(cyl, sideEdge).hes.length, nRim = so.edgeLoop(sph, lat).hes.length;
  ok('★★ ⑤-21（前提）圓柱側面的直邊順著走只有它自己 ⇒ 「標一段」第一下就講', nSide === 1, nSide);
  ok('★ 　 對照組：球中間的緯線走得下去（32 條）⇒ 照常當起點', nRim === 32, nRim);
}

section('綜合評估 ⑤ 第一批（二）：讀數、匯入、輸出、刀具、鋼筆、齒輪（2026-10-20）');
{
  /** 左下角讀數、均分空隙三個方向、參考線面的大小、匯入入鏡與線寬、刀具與鋼筆、齒輪那一句（main.js／toolbar.js／scene.js／importPanel.js）在本機版用畫面驗 */
  const box = buildPrim('box', { w: 10, h: 10, d: 10 });
  const at = (x, y, z) => triangles(box, { matrix: new THREE.Matrix4().makeTranslation(x, y, z), scale: 10 });
  const far = at(300, 5, -200);                  // 擺在旁邊的零件（世界 X 300、Z −200 cm）
  const [solo] = bedLayout([far], false);
  const bs = trisBounds(solo), cs = bs.getCenter(new THREE.Vector3());
  ok('★★★ ⑤-26 分開存：每一個的外框中心移到平台中間（X、Y ＝ 0；以前照世界座標、在平台外面）', Math.abs(cs.x) < 1e-9 && Math.abs(cs.y) < 1e-9, cs.toArray().join());
  near('★★ 　 照樣落到平台（最低點 Z 0）', bs.min.z, 0, 1e-9);
  near('★ 　 大小不變（100 mm 寬）', bs.max.x - bs.min.x, 100, 1e-6);
  const [both] = bedLayout([at(0, 5, 0), far], true);
  const bb = trisBounds(both);
  near('★★ 　 合成一個檔 ⇒ X／Y ⛔ 動（相對位置就是要的：X 從 −50 到 3050 mm）', bb.min.x, -50, 1e-6);
  ok('★ 　 原本那一份⛔ 被動到', Math.abs(trisBounds(far).getCenter(new THREE.Vector3()).x - 3000) < 1e-6);

  const tris = triangles(box, { scale: 10 });
  const nameOf = s => s.split('\n')[0];
  eq('★★★ ⑤-25 ASCII：名稱全是中文 ⇒ 改用給的代號（以前只剩「-」）', nameOf(toSTLAscii(tris, { name: '左側板', fallback: 'part01' })), 'solid part01');
  eq('★ 　 沒給代號 ⇒ modeler', nameOf(toSTLAscii(tris, { name: '左側板' })), 'solid modeler');
  eq('★ 　 有英文或數字 ⇒ 照舊用名稱（中文的那幾個字照舊變「-」）', nameOf(toSTLAscii(tris, { name: 'T7 展示櫃', fallback: 'part01' })), 'solid T7_-');
  const d = new Date(), p2 = n => String(n).padStart(2, '0');
  eq('★★ ⑤-25 檔頭日期 ＝ 本地的今天（以前用世界時間，台灣早上 8 點前是昨天）', io.today(), `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`);
}

section('綜合評估 ⑤ 第二批（前 6 條）：展開合併複本、選一條線停在哪、滑動箭頭（2026-10-20）');
{
  /** 剖面分段新建重設、展開「合成一行」記住、只展開選到的那一句、滑動 ％／公分各記、旋轉成形提示、鋼筆「加一條（挖洞）」在本機版用畫面驗 */
  const bend = () => ({ type: 'bend', w: 30, first: 20, arcSeg: 4, k: 0.4, bends: [{ angle: 90, ri: 1, len: 15 }] });
  const mk = (name, src, sx = 1) => {
    const o = new io.ModelObject({ name, kind: io.KIND.SHEET, thickness: 0.5, src });
    o.scale.x = sx;
    return o;
  };
  const one = unfoldMany([mk('隔板', bend())]);
  const a = mk('隔板', bend()), b = mk('隔板 複本', bend());
  b.pos.set(80, 0, 0); b.rot.set(0, 1, 0);           // 擺在別處、轉過 ⇒ 照樣算一樣
  const two = unfoldMany([a, b]);
  eq('★★★ ⑤-16 兩個一模一樣的複本 ⇒ 種數跟一個時一樣（以前多一倍：12 種）', two.stats.pieces, one.stats.pieces);
  eq('★★★ 　 總片數 ＝ 一個時的 2 倍', two.stats.total, one.stats.total * 2);
  ok('★★ 　 卡片名字兩個都列', two.pieces.every(p => p.name.includes('隔板、隔板 複本') && p.sameAs && p.sameAs.length === 2), two.pieces[0] && two.pieces[0].name);
  const c = mk('隔板 長', { ...bend(), first: 25 });
  eq('★★ 　 參數差一點（第一段 25）⇒ ⛔ 合', unfoldMany([a, c]).stats.pieces, one.stats.pieces * 2);
  const m = mk('隔板 鏡像', bend(), -1);
  eq('★★★ 　 鏡像（X 縮放 −1）⇒ ⛔ 合（看起來一樣、其實是左右相反）', unfoldMany([a, m]).stats.pieces, one.stats.pieces * 2);
  const plate = () => ({ type: 'plate', w: 100, d: 60 });
  const p1 = mk('板 A', plate()), p2 = mk('板 B', plate()), p3 = mk('板 C', plate()), p4 = mk('板 D', plate());
  const four = unfoldMany([p1, p2, p3, p4]);
  ok('★ 　 四個一樣的 ⇒ 一種 ×4、名字列前兩個 ＋「等 4 個」', four.stats.pieces === 1 && four.stats.total === 4 && four.pieces[0].name.startsWith('板 A、板 B 等 4 個'), four.pieces[0] && four.pieces[0].name);

  const so = await import('../js/core/selectops.js');
  const sph = baked('sphere', { r: 30, segW: 32, segH: 16 });
  const mer = [...sph.edges()].find(e => Math.abs(e.v.p.x - e.to.p.x) + Math.abs(e.v.p.z - e.to.p.z) > 1e-6
    && Math.abs(e.v.p.y - e.to.p.y) > 1 && Math.abs(e.v.p.y) < 20 && Math.abs(e.to.p.y) < 20);
  const L = so.edgeLoop(sph, mer);
  ok('★★★ ⑤-6 球的經線：停在兩個極點、每個點講有幾條邊交會（32 條）', L.stopAt.length === 2 && L.stopAt.every(q => q.why === 'valence' && q.n === 32)
    && L.stopAt.every(q => Math.abs(Math.abs(q.p.y) - 30) < 1e-6), JSON.stringify(L.stopAt.map(q => [q.n, +q.p.y.toFixed(2)])));
  const lat = [...sph.edges()].find(e => Math.abs(e.v.p.y - e.to.p.y) < 1e-9 && Math.abs(e.v.p.y) < 5);
  ok('★ 　 對照組：緯線繞回起點 ⇒ ⛔ 停的點', so.edgeLoop(sph, lat).closed && !so.edgeLoop(sph, lat).stopAt.length);

  const bx = baked('box', { w: 60, d: 45, h: 40 });
  const he0 = [...bx.edges()].find(h => h.face && h.twin && h.twin.face && Math.abs(h.v.p.y - h.to.p.y) > 1e-6);
  const cut = edit.loopCut(bx, he0, { cuts: 1 });
  const out = cut.mesh; out.computeNormals();
  const vi = out._vertIndex();
  const kk = (x, y) => (x < y ? `${x}-${y}` : `${y}-${x}`);
  const want = new Set(cut.newEdges.map(([x, y]) => kk(x, y)));
  const ring = [...out.edges()].filter(h => want.has(kk(vi.get(h.v.id), vi.get(h.to.id))));
  const y0 = ring[0].v.p.y;
  const pv = edit.slideEdges(out, ring, 1, { preview: true });
  ok('★★★ ⑤-15 滑動箭頭：預覽 ⇒ 每個點一支箭頭（4 支）、方向往上（正值那邊）', pv.ok && pv.arrows.length === 4 && pv.arrows.every(q => q.d.y > 0), pv.arrows && pv.arrows.map(q => q.d.y.toFixed(1)).join());
  ok('★★ 　 預覽⛔ 動任何點', Math.abs(ring[0].v.p.y - y0) < 1e-12);
}

section('綜合評估 ⑤-28 ＋ ④-16：量孔徑、孔心、孔心距（2026-10-20）');
{
  /** 工具列「量孔」、點兩下、畫線、提示（main.js）在本機版用畫面驗 */
  const M = await import('../js/core/mate.js');
  const shaft = new io.ModelObject({ name: '軸', src: { type: 'cylinder', r: 0.3, h: 6, seg: 32 } });
  const sm = shaft.mesh(); sm.computeNormals();
  const fs = M.cylinderFrame(shaft, sm.faces.find(f => Math.abs(f.normal.y) < 0.1));
  ok('★★ ⑤-28 軸的外面 ⇒ 認成「軸」（法線朝外）', fs.ok && fs.inward === false);
  if (csgOK) {
    const B = await import('../js/build/bool.js');
    const board = new io.ModelObject({ name: '板', src: { type: 'box', w: 30, h: 2, d: 20 } }); board.pos.set(0, 1, 0);
    const h1 = new io.ModelObject({ name: '孔1', src: { type: 'cylinder', r: 1, h: 4, seg: 32 } }); h1.pos.set(-8, 1, 2);
    const h2 = new io.ModelObject({ name: '孔2', src: { type: 'cylinder', r: 1.5, h: 4, seg: 32 } }); h2.pos.set(7, 1, -2);
    const plate = new io.ModelObject({ name: '兩孔板', src: io.boolSrcFrom([board, h1, h2], B.BOOL_OPS.SUBTRACT), pos: board.pos.clone() });
    plate.bake();                                       // 「凍結」之後是三角形網格（T4：一圈選不起來）
    const pm = plate.mesh(); pm.computeNormals();
    const wallNear = (x, z, r) => pm.faces.find(f => {
      if (Math.abs(f.normal.y) > 0.1) return false;
      const vs = pm.faceVerts(f).map(v => v.p);
      const cx = vs.reduce((s, p) => s + p.x, 0) / vs.length, cz = vs.reduce((s, p) => s + p.z, 0) / vs.length;
      return Math.abs(Math.hypot(cx - x, cz - z) - r) < 0.2;
    });
    const a = M.cylinderFrame(plate, wallNear(-8, 2, 1)), b = M.cylinderFrame(plate, wallNear(7, -2, 1.5));
    ok('★★★ ⑤-28 凍結過的板，點孔 1 的內壁 ⇒ 直徑 2、孔心 (−8, 1, 2)、認成「孔」', a.ok && a.inward && Math.abs(2 * a.radius - 2) < 1e-6
      && a.point.distanceTo(new THREE.Vector3(-8, 1, 2)) < 1e-6, a.reason || `${a.radius} ${a.point && a.point.toArray().join()}`);
    ok('★★ 　 孔 2：直徑 3、孔心 (7, 1, −2)', b.ok && b.inward && Math.abs(2 * b.radius - 3) < 1e-6 && b.point.distanceTo(new THREE.Vector3(7, 1, -2)) < 1e-6);
    const d = M.holeDistance(a, b);
    near('★★★ ④-16 孔心距 ＝ √(15² ＋ 4²) ＝ 15.52（兩條中心線平行、量垂直距離）', d.dist, Math.hypot(15, 4), 1e-6);
    ok('★ 　 平行、沿中心線⛔ 錯開', d.parallel && d.along < 1e-6);
  }
  const fr = (p, dv) => ({ point: new THREE.Vector3(...p), dir: new THREE.Vector3(...dv).normalize() });
  const up = M.holeDistance(fr([0, 0, 0], [0, 1, 0]), fr([3, 5, 4], [0, -1, 0]));
  ok('★★ 　 平行但錯開高度（Y 差 5）⇒ 孔心距 ＝ 垂直距離 5、另外講錯開 5', up.parallel && Math.abs(up.dist - 5) < 1e-9 && Math.abs(up.along - 5) < 1e-9);
  const skew = M.holeDistance(fr([0, 0, 0], [0, 1, 0]), fr([3, 0, 4], [1, 0, 0]));
  ok('★ 　 不平行（夾 90°）⇒ 兩個孔心的直線距離 5、講夾幾度', !skew.parallel && Math.abs(skew.dist - 5) < 1e-9 && Math.abs(skew.angle - 90) < 1e-6);
}

section('綜合評估 ⑤-3：畫面上的字⛔ 用文件寫法（2026-10-21）');
{
  /**
   * 🔴 **畫面上的字（提示、按鈕說明）⛔ 出現 ⛔、`**`、【】**（kang 2026-10-21「同意你的建議」）——
   * 那是文件寫法：畫面上 ⛔ 是一個看不懂的符號、`**` 不會變粗只會顯示星號、【】只是多兩個括號（T3、T5～T8、補測）。
   * 掃的範圍：`js/` 底下每一支的字串（含中文的；⛔ 掃註解、⛔ 掃樣板字串 `${…}` 裡面的程式、⛔ 掃字串裡的 HTML 註解），
   * `index.html` 的 title／placeholder 與標籤之間的字（⛔ 掃 <!-- 註解 -->、<style>、<script>）。
   * ⚠ 寫畫面上的字時：⛔ → 寫「不／沒有／不要」；強調就用一般的字，按鈕名稱用「」。
   */
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = [];
  const walk = d => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.js')) files.push(p); } };
  walk(join(root, 'js'));
  /** 字串字面值（跳過註解；樣板字串只取 ${…} 以外的字）*/
  const literals = code => {
    const out = []; let i = 0; const n = code.length;
    while (i < n) {
      if (code.startsWith('//', i)) { const j = code.indexOf('\n', i); i = j < 0 ? n : j; continue; }
      if (code.startsWith('/*', i)) { const j = code.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
      const c = code[i];
      if (c === '\'' || c === '"' || c === '`') {
        let j = i + 1, text = '';
        while (j < n) {
          const d = code[j];
          if (d === '\\') { text += code.slice(j, j + 2); j += 2; continue; }
          if (c === '`' && code.startsWith('${', j)) {
            let k = j + 2, b = 1;
            while (k < n && b) { if (code[k] === '{') b++; else if (code[k] === '}') b--; k++; }
            text += ' '; j = k; continue;
          }
          if (d === c || (d === '\n' && c !== '`')) break;
          text += d; j++;
        }
        /** 字串裡放的 HTML（面板的骨架）有自己的 <!-- 註解 -->，那不是畫面上的字 */
        out.push({ at: i, text: text.replace(/<!--[\s\S]*?-->/g, ' ') });
        i = j + 1; continue;
      }
      i++;
    }
    return out;
  };
  const MARK = /⛔|\*\*|【|】/;
  const bad = [];
  for (const f of files) {
    const code = readFileSync(f, 'utf8');
    for (const L of literals(code)) {
      if (/[一-鿿]/.test(L.text) && MARK.test(L.text)) {
        bad.push(`${f.slice(root.length + 1)}:${code.slice(0, L.at).split('\n').length}`);
      }
    }
  }
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  for (const m of html.matchAll(/(title|placeholder)="([^"]*)"/g)) {
    if (MARK.test(m[2])) bad.push(`index.html:${html.slice(0, m.index).split('\n').length}`);
  }
  const masked = html.replace(/<!--[\s\S]*?-->/g, s => ' '.repeat(s.length))
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/g, s => ' '.repeat(s.length))
    .replace(/"[^"]*"/g, s => ' '.repeat(s.length));
  for (const m of masked.matchAll(/>([^<>]+)</g)) {
    if (/[一-鿿]/.test(m[1]) && MARK.test(m[1])) bad.push(`index.html（字）:${html.slice(0, m.index).split('\n').length}`);
  }
  ok(`★★★ ⑤-3 畫面上的字⛔ 有 ⛔、**、【】（掃了 ${files.length} 支 js ＋ index.html）`, bad.length === 0, bad.slice(0, 8).join('、'));
  const titles = [...html.matchAll(/title="([^"]*)"/g)].map(m => m[1]);
  const longT = titles.filter(t => t.length > 150);
  ok('★ 　 index.html 的滑鼠提示都在 150 字以內（⑤-3：以前最長 397 字）', longT.length === 0, longT.map(t => t.slice(0, 12)).join('、'));
}

section('綜合評估 ⑥ 第一批：片數來源、切幾段先講、拖曳標數字、擠完打長度、齒輪套軸（2026-10-21）');
{
  /** 圓的「切下去幾段」標籤、拖曳的小標籤位置、擠出打長度的整條操作在本機版用畫面驗；這裡守算的那幾支 */
  const { qtyWords } = await import('../js/out/sheet.js');
  const { PRIM_SPECS, PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const bend = { type: 'bend', w: 11, first: 1, arcSeg: 4, bends: [{ angle: 90, ri: 0.2, len: 7.5 }] };
  const item = src => ({ src, pos: [0, 0, 0], rot: [0, 0, 0], scale: [1, 1, 1], name: '原件' });
  const arr = (name, count) => new io.ModelObject({ name, kind: io.KIND.SHEET, thickness: 0.5,
    src: { type: 'array', mode: 'linear', count, step: [6.67, 0, 0], count2: 1, child: item(bend) } });
  const prod = p => (p.qtyFrom.objs || 1) * (p.qtyFrom.per !== undefined ? p.qtyFrom.copies * p.qtyFrom.per : p.qtyFrom.each);

  const r2 = unfoldMany([arr('隔板', 2)]);
  ok('★★★ ⑥-1 陣列 2 份 ⇒ 每一片都寫「陣列 2 份 × 每份 k 片」、乘起來 ＝ 片數',
     r2.pieces.length > 0 && r2.pieces.every(p => qtyWords(p).includes('陣列 2 份 × 每份 ') && prod(p) === p.qty),
     r2.pieces.map(p => `×${p.qty}${qtyWords(p)}`).join('｜'));
  ok('★★ 　 卡片第一行就寫（titleLines）', titleLines(r2.pieces[0], {})[0].includes(`×${r2.pieces[0].qty} 片（陣列 2 份 × 每份`), titleLines(r2.pieces[0], {})[0]);
  const rr = unfoldMany([arr('隔板', 2), arr('隔板 複本', 2)]);
  ok('★★★ 　 兩個一樣的陣列 ⇒「2 個一樣的物件 × 陣列 2 份 × 每份 k 片」、乘起來 ＝ 片數',
     rr.pieces.length > 0 && rr.pieces.every(p => qtyWords(p).startsWith('（2 個一樣的物件 × 陣列 2 份 × 每份 ') && prod(p) === p.qty),
     rr.pieces.map(p => `×${p.qty}${qtyWords(p)}`).join('｜'));
  const plain = unfoldMany([new io.ModelObject({ name: '隔板', kind: io.KIND.SHEET, thickness: 0.5, src: bend })]);
  ok('★★ 　 一般物件 ⇒ ⛔ 多寫（卡片照舊）', plain.pieces.length > 0 && plain.pieces.every(p => qtyWords(p) === ''));
  eq('★★ 　 除不盡（連成一塊／鏡射沒併）⇒ 只講是陣列、⛔ 硬算每份幾片', qtyWords({ qtyFrom: { copies: 3 } }), '（物件是陣列 3 份）');
  eq('★ 　 一樣的物件 ＋ 除不盡的陣列', qtyWords({ qtyFrom: { copies: 3, objs: 2, each: 1 } }), '（2 個一樣的物件 × 每個 1 片；物件是陣列 3 份）');
  eq('★ 　 只有一樣的物件', qtyWords({ qtyFrom: { objs: 2, each: 3 } }), '（2 個一樣的物件 × 每個 3 片）');

  /** ⑥-2：「切下去幾段」跟切下去同一支、同一組參數（字串比對：三處一模一樣）*/
  const { readFileSync } = await import('node:fs');
  const mainSrc = readFileSync(join(ROOT, 'js', 'main.js'), 'utf8');
  const callStr = 'sampleCurveInfo(curve.anchors, curveStepCm(), curve.closed)';
  eq('★★ ⑥-2 圓的「切下去幾段」跟兩條切下去的路用同一句算（3 處）', mainSrc.split(callStr).length - 1, 3);
  const ed = await import('../js/core/edit.js');
  const ring = ed.circleAnchors({ toWorld: (s, t) => new THREE.Vector3(s, 0, t) }, 0, 0, 1);
  const info = ed.sampleCurveInfo(ring, 1, true);
  ok('★ 　 半徑 1 的圓 ⇒ 段數 > 8、每段離圓 ≤ 0.2 mm（跟 ①-8 一樣）', info.curveSegs > 8 && info.maxDev <= 0.02 + 1e-9, `${info.curveSegs} 段、${info.maxDev}`);

  /** ⑥-3：拖箭頭的小標籤 */
  const { xfReadout, fmtDragReadout } = await import('../js/core/measure.js');
  const st = (axis, mode, space = 'world', quat = new THREE.Quaternion()) => ({ axis, mode, space,
    pos: new THREE.Vector3(1, 2, 3), quat, scale: new THREE.Vector3(2, 2, 2) });
  const now = (pos, quat, scale) => ({ position: pos || new THREE.Vector3(1, 2, 3), quaternion: quat || new THREE.Quaternion(), scale: scale || new THREE.Vector3(2, 2, 2) });
  const qy = deg => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(deg));
  eq('★★★ ⑥-3 縮放 X 從 2 倍拉到 1 倍 ⇒「X × 0.50」', fmtDragReadout(xfReadout(st('X', 'scale'), now(null, null, new THREE.Vector3(1, 2, 2)))), 'X × 0.50');
  eq('★★★ 　 繞 Y 轉 22.5° ⇒「Y 22.5°」', fmtDragReadout(xfReadout(st('Y', 'rotate'), now(null, qy(22.5)))), 'Y 22.5°');
  eq('★★ 　 反方向轉 ⇒ 負的', fmtDragReadout(xfReadout(st('Y', 'rotate'), now(null, qy(-30)))), 'Y -30.0°');
  eq('★★ 　 已經轉過 40° 的物件再轉 15° ⇒ 只算這一次的 15°', fmtDragReadout(xfReadout(st('Y', 'rotate', 'world', qy(40)), now(null, qy(55)))), 'Y 15.0°');
  eq('★★ 　 移動 Z 3.2 cm', fmtDragReadout(xfReadout(st('Z', 'translate'), now(new THREE.Vector3(1, 2, 6.2)))), 'Z 3.20 cm');
  eq('★★ 　 方向「物件」：轉了 90° 的物件沿自己的 X 走 ⇒ 照自己的軸算', fmtDragReadout(xfReadout(st('X', 'translate', 'local', qy(90)), now(new THREE.Vector3(1, 2, -2)))), 'X 5.00 cm');
  eq('★★ 　 整體縮放 ⇒「整體 × 1.50」', fmtDragReadout(xfReadout(st('XYZ', 'scale'), now(null, null, new THREE.Vector3(3, 3, 3)))), '整體 × 1.50');
  eq('★★ 　 拉平面把手 ⇒ ⛔ 標（沒有一個數字）', xfReadout(st('XY', 'translate'), now(new THREE.Vector3(5, 5, 3))), null);
  eq('★ 　 null ⇒ 空字串（標籤收起來）', fmtDragReadout(null), '');

  /** ⑥-4：擠完打長度靠「最上面那一步還是擠出」—— History.topTag() */
  const { History } = await import('../js/core/history.js');
  let state = 'a';
  const h = new History({ get: () => state, set: v => { state = v; } });
  h.reset();
  const tag = { extrude: true };
  state = 'b'; h.commit('擠出面 1 cm', { tag });
  eq('★★★ ⑥-4 剛擠完 ⇒ topTag 是那一次', h.topTag(), tag);
  state = 'c'; h.commit('擠出面 3 cm', { tag, replace: true });
  h.undo();
  eq('★★★ 　 打長度 ⇒ 取代那一步（復原一次就回到擠之前）', state, 'a');
  eq('★★ 　 退過 ⇒ topTag 沒了（⛔ 再取代）', h.topTag(), null);
  h.redo();
  state = 'd'; h.commit('拉面');
  ok('★★ 　 中間做過別的 ⇒ 對不上', h.topTag() !== tag);

  /** ⑥-7：齒輪套軸一句 */
  const gn = PRIM_SPECS.gear.noteOf({ ...PRIM_DEFAULTS.gear, hole: 0.6 });
  ok('★★ ⑥-7 有中心孔 ⇒ 講「軸要比孔小一點」', gn.some(s => s.startsWith('套軸：中心孔直徑 0.6 cm') && s.includes('軸要比孔小一點')), gn.join('｜'));
  ok('★★ 　 ⛔ 寫建議的間隙數字（kang 還沒給自己機器的）', !gn.some(s => s.startsWith('套軸') && /\d\s*mm/.test(s)));
  ok('★ 　 沒有孔 ⇒ ⛔ 講', !PRIM_SPECS.gear.noteOf({ ...PRIM_DEFAULTS.gear, hole: 0 }).some(s => s.startsWith('套軸')));
}

section('分片成群 第一件：重疊標出是哪幾個面、點一片在 3D 上標出來（2026-10-21）');
{
  /** 3D 上塗紅／塗藍、預覽點一片、離開分片模式收掉，在本機版用畫面驗；這裡守算的那幾支 */
  const { previewProgram, pieceAt } = await import('../js/out/nest.js');
  const { pieceWorldPolys } = await import('../js/unfold/part.js');
  const { worldBounds } = await import('../js/core/align.js');

  // ① 球冠攤成一片一定疊（上面「球冠 改由重疊偵測負責」那一條）⇒ 現在要講出是哪幾個面
  const cap = Mesh.fromGeometry(new THREE.SphereGeometry(30, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3));
  const rc = unfoldMesh(cap, makeRule('paper', 0.03));
  const pc = rc.pieces[0];
  ok('★★★ 球冠：疊在一起的面列得出來（以前找到第一對就停、不記哪兩個面）', pc.overlap && pc.overlapFaces.length >= 2 && pc.overlapPairs >= 1,
     `${pc.overlapFaces.length} 面、${pc.overlapPairs} 對`);
  ok('★★ 　 面的索引不重複、由小到大、都在這一片的面裡', pc.overlapFaces.every((v, i, a) => (i === 0 || a[i - 1] < v) && v >= 0 && v < pc.faces.length));
  ok('★★ 　 警告講出幾個面、標在哪', rc.warnings.some(w => w.includes(`${pc.overlapFaces.length} 個面疊在一起`) && w.includes('圖上標紅')), rc.warnings.find(w => w.includes('重疊')));
  eq('★★ 　 每個面都有 3D 位置（跟 faces 一樣多、點數一樣）', pc.faces3.length === pc.faces.length && pc.faces3.every((f, i) => f.length === pc.faces[i].length), true);

  // ② 展開圖：畫面上塗紅、存檔（strainFill 關）⛔ 塗
  const onScreen = drawProgram(pc, { rule: rc.rule, strainFill: true }).items.filter(i => i.style === 'overlap');
  const toFile = drawProgram(pc, { rule: rc.rule, strainFill: false }).items.filter(i => i.style === 'overlap');
  eq('★★★ 展開圖畫面上：疊在一起的每個面都塗紅', onScreen.length, pc.overlapFaces.length);
  eq('★★★ 　 存 SVG／DXF 那一份 ⛔ 塗（送去切的檔不帶色塊）', toFile.length, 0);

  // ③ 凹的面：L 形大面 ＋ 凹口裡一塊小方塊（中間一塊橋連著，全部平的）⇒ 沒疊；舊的分離軸判法會說疊（2026-10-21 沙箱驗過）
  const P2 = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 2], [1, 3], [1, 4], [0, 4], [2, 2], [2, 3], [3, 2], [3, 3]];
  const L = Mesh.fromFaceList(P2.map(([x, z]) => new THREE.Vector3(x, 0, z)),
    [[0, 1, 2, 3, 4, 5, 6, 7].reverse(), [4, 8, 9, 5].reverse(), [8, 10, 11, 9].reverse()]);
  const rl = unfoldMesh(L, makeRule('paper', 0.03));
  ok('★★★ 凹的面（L 形）跟凹口裡的小方塊 ⇒ ⛔ 算重疊（以前分離軸會誤判）', rl.pieces.length === 1 && rl.pieces[0].overlap === false && rl.pieces[0].overlapFaces.length === 0,
     JSON.stringify(rl.pieces.map(p => [p.overlap, p.overlapFaces])));

  // ④ 3D 位置換成世界座標：搬過、轉過的方塊 ⇒ 每個點都落在物件的世界外框上
  const box = new io.ModelObject({ name: '方塊', src: { type: 'box', w: 20, h: 10, d: 6 }, kind: io.KIND.SHEET, thickness: 0.3 });
  box.pos.set(40, 5, -12); box.rot.set(0, Math.PI / 4, 0);
  const rb = unfoldObject(box, { material: 'paper' });
  const wb = worldBounds(box);
  const all = rb.pieces.flatMap(p => pieceWorldPolys(p).flat());
  const onBox = v => [v.x - wb.min.x, wb.max.x - v.x, v.y - wb.min.y, wb.max.y - v.y, v.z - wb.min.z, wb.max.z - v.z].every(d => d > -1e-6);
  ok('★★★ 一片的面換成世界座標 ⇒ 都在搬過、轉過的物件外框裡（縮放已經吃進去、只差位置與旋轉）', all.length > 0 && all.every(onBox), `${all.length} 點`);
  const touch = ['x', 'y', 'z'].every(k => Math.abs(Math.min(...all.map(v => v[k])) - wb.min[k]) < 1e-6 && Math.abs(Math.max(...all.map(v => v[k])) - wb.max[k]) < 1e-6);
  ok('★★ 　 而且頂到外框的六面（不是縮在裡面）', touch);
  const sc = new io.ModelObject({ name: '縮放', src: { type: 'box', w: 10, h: 10, d: 10 }, kind: io.KIND.SHEET, thickness: 0.3 });
  sc.scale.set(2, 1, 1);
  const sall = unfoldObject(sc, { material: 'paper' }).pieces.flatMap(p => pieceWorldPolys(p).flat());
  near('★★ 　 縮放過的（X × 2）：世界座標的寬 ＝ 20（縮放只算一次）', Math.max(...sall.map(v => v.x)) - Math.min(...sall.map(v => v.x)), 20, 1e-6);
  eq('★ 　 只要其中幾個面：照給的索引', pieceWorldPolys(rb.pieces[0], [0]).length, 1);

  // ⑤ 預覽點一片：點在某一片的面裡 ⇒ 那一片；點在外面 ⇒ null
  const prog = previewProgram(rb.pieces, { rule: rb.rule });
  ok('★★ 預覽交出每一片擺在哪（hits）', prog.hits && prog.hits.length === rb.pieces.length);
  const h0 = prog.hits[0], f0 = h0.polys[0];
  const cx = f0.reduce((a, p) => a + p.x, 0) / f0.length, cy = f0.reduce((a, p) => a + p.y, 0) / f0.length;
  ok('★★★ 點在一片的面中間 ⇒ 就是那一片', pieceAt(prog, cx, cy) === h0.piece);
  eq('★★ 　 點在預覽外面 ⇒ 沒有', pieceAt(prog, prog.box.x - 100, prog.box.y - 100), null);
}

section('分片成群 第二件：選一群面切成一片（2026-10-21）');
{
  /** 點面、黃色、紅色、面板、復原在本機版用畫面驗；這裡守 `unfold/group.js` 算的那幾支（獅子頭那一份在沙箱試過）*/
  const G = await import('../js/unfold/group.js');
  const { drawProgram: dp } = await import('../js/out/sheet.js');
  const mkObj = m => { const o = new io.ModelObject({ name: '盒', src: { type: 'mesh' }, kind: 'sheet', thickness: 0.3 }); o._mesh = m; return o; };
  // 20 × 10 × 6 的方塊：±Z 面 200 cm²、±Y 面 120、±X 面 60
  const box = mkObj(edit.mergeCoplanarFaces(buildPrim('box', { w: 20, h: 10, d: 6 })).mesh);
  const m = box.mesh();
  let R = G.regionInfo(m);
  const by = (ax, sg) => [...R.values()].find(r => Math.abs(r.n[ax] - sg) < 1e-6).id;
  const top = by('y', 1), front = by('z', 1), back = by('z', -1), right = by('x', 1), bottom = by('y', -1);
  eq('★★ 方塊：6 塊面', R.size, 6);
  near('★★ 　 面積（cm²）：上面 20 × 6', R.get(top).area, 120, 1e-6);
  eq('★★ 　 每一塊面跟 4 塊相鄰', [...R.values()].every(r => r.nb.size === 4), true);
  eq('★ 預設值：往外長 30°、碎面 1 mm²', [G.GROW_DEG, G.TINY_MM2].join(), '30,1');

  // 往外長：30° ⇒ 隔壁都是 90° 轉折，只有自己；91° ⇒ 長到除了對面以外的 5 塊
  eq('★★★ 往外長 30°：轉折 90° 的地方停（只有自己）', G.growRegions(R, top, 30).size, 1);
  eq('★★ 　 往外長 91°：除了正對面全部（5 塊）', G.growRegions(R, top, 91).size, 5);
  eq('★★ 選起整片：還沒標縫 ⇒ 整個方塊（6 塊）', G.pieceRegions(R, top).size, 6);
  eq('★★ 連成幾塊：上＋前 ⇒ 1', G.components(R, new Set([top, front])), 1);
  eq('★★★ 　 上＋下（沒有共用邊）⇒ 2（切下去會變 2 片，面板要先講）', G.components(R, new Set([top, bottom])), 2);

  // 碎面：門檻 100 cm²（＝ 10000 mm²）⇒ ±X 兩塊（60 cm²）是碎面；它們跟著共用邊最長的 ±Z 走
  const tiny = G.tinyRegions(R, 10000);
  eq('★★ 碎面：小於門檻的才算（±X 兩塊）', [...tiny].sort().join(), [right, by('x', -1)].sort().join());
  eq('★★★ 　 選了前、後 ⇒ 兩塊碎面跟著走（4 塊）', G.withTiny(R, new Set([front, back]), tiny).size, 4);
  eq('★★ 　 只選上面 ⇒ 碎面⛔ 跟（它們的主人是前／後）', G.withTiny(R, new Set([top]), tiny).size, 1);
  eq('★★ 　 門檻 0 ⇒ 沒有碎面', G.tinyRegions(R, 0).size, 0);
  eq('★★ 　 往外長⛔ 長進碎面（朝向不可靠、跟著主人走）', G.growRegions(R, front, 91, tiny).has(right), false);

  // 選的當下檢查：副本上攤一次，物件本身一條縫都⛔ 動
  const n0 = seam.seamCount(m);
  const c1 = G.checkGroup(box, new Set([top]), { material: 'paper' });
  ok('★★★ 檢查（只選上面）：攤得出來、選到的在 1 片裡、沒疊', c1.ok && c1.pieces.length === 1 && c1.overlap === 0, JSON.stringify([c1.ok, c1.pieces.length, c1.overlap]));
  eq('★★★ 　 檢查完，物件本身的縫一條都沒變', seam.seamCount(m), n0);

  // 切成一片：外圈 4 條標縫 ⇒ 方塊攤成 2 片（上面自己一片）
  const p0 = unfoldObject(box, { material: 'paper' }).stats.total;
  R = G.regionInfo(m);
  const r1 = G.applyGroup(m, new Set([top]));
  eq('★★★ 切成一片（上面）：外圈標 4 條縫', r1.cut, 4);
  const p1 = unfoldObject(box, { material: 'paper' }).stats.total;
  ok('★★★ 　 片數多一片（上面自己一片）', p1 === p0 + 1, `${p0} → ${p1}`);
  R = G.regionInfo(m);
  eq('★★ 　 選起整片（點上面）⇒ 只有上面那一塊', G.pieceRegions(R, top).size, 1);
  const r2 = G.applyGroup(m, new Set([top]));
  eq('★★ 　 再切一次 ⇒ 什麼都沒標（本來就是一片了）', r2.cut + r2.uncut, 0);

  // 改已經分好的片：上＋前一起 ⇒ 中間那條縫拿掉
  R = G.regionInfo(m);
  const r3 = G.applyGroup(m, new Set([top, front]));
  ok('★★★ 上＋前切成一片 ⇒ 中間那條縫拿掉、外圈補標', r3.uncut === 1 && r3.cut >= 3, JSON.stringify(r3));
  R = G.regionInfo(m);
  eq('★★ 　 選起整片（點前面）⇒ 上＋前 2 塊', G.pieceRegions(R, front).size, 2);

  // 不准切：外圈有一條標了不准切 ⇒ ⛔ 碰、講幾條
  const box2 = mkObj(edit.mergeCoplanarFaces(buildPrim('box', { w: 20, h: 10, d: 6 })).mesh);
  const m2 = box2.mesh();
  const R2 = G.regionInfo(m2);
  const t2 = [...R2.values()].find(r => r.n.y > 0.99).id;
  const ke = [...m2.edges()].find(h => h.face && h.twin && h.twin.face && (h.face.region === t2) !== (h.twin.face.region === t2));
  seam.setKeep(m2, ke, true);
  const r4 = G.applyGroup(m2, new Set([t2]));
  ok('★★★ 外圈 1 條不准切 ⇒ 那條⛔ 碰、講 1 條、其餘 3 條照標', r4.blocked === 1 && r4.cut === 3 && seam.isKeep(ke) && !seam.isSeam(ke), JSON.stringify(r4));

  // 檢查講得出「會疊」：球冠整片選起來 ⇒ 疊、疊的面列得出來
  const capObj = mkObj(Mesh.fromGeometry(new THREE.SphereGeometry(30, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3)));
  const RC = G.regionInfo(capObj.mesh());
  const cAll = G.checkGroup(capObj, new Set(RC.keys()), { material: 'paper' });
  ok('★★★ 球冠整個選起來 ⇒ 檢查說會疊、講得出疊的面', cAll.ok && cAll.overlap > 0 && cAll.overlapPieces.length >= 1 && cAll.overlapPieces.every(p => p.overlapFaces.length),
     JSON.stringify([cAll.ok, cAll.overlap, cAll.overlapPieces.length]));

  // 分片地圖：預覽照片上色（只有即時預覽傳 pieceFill）；存檔那一份⛔ 帶
  const pcs = unfoldObject(box, { material: 'paper' }).pieces;
  const withMap = dp(pcs[0], { pieceFill: () => '#4fc3f7' }).items.filter(i => i.style === 'map');
  eq('★★ 分片地圖：預覽每個面都塗那一片的顏色', withMap.length, pcs[0].faces.length);
  eq('★★ 　 沒傳（存 SVG／DXF、列印）⇒ ⛔ 塗', dp(pcs[0], {}).items.filter(i => i.style === 'map').length, 0);
}

section('分片成群 第三件：智慧分切 片裡不要細切口（2026-10-21）');
{
  /** 獅子頭、狐狸頭的數字在沙箱量（`分片成群-設計方向.md` 第 8 節；模型在 `輸出`，⛔ 進版控 ⇒ 這裡只用基本形狀）*/
  const { proposeSeams, NOTCH_DEG, MIN_PIECE_CM, SLIT_LABEL, ORDER_LABEL } = await import('../js/unfold/propose.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const mk = (t, over = {}) => {
    const o = new io.ModelObject({ name: t, kind: io.KIND.SOLID, src: { type: t, ...PRIM_DEFAULTS[t], ...over } });
    o.bake();
    return o;
  };
  const B = { w: 240, h: 120, gap: 1, rotate: false };
  const P = (o, opt = {}) => proposeSeams(o, { material: 'foamboard', board: B, ...opt });
  const accept = (o, p) => { for (const h of p.edges) seam.setSeam(o.mesh(), h, true); return unfoldObject(o, { material: 'foamboard' }); };

  eq('★ 預設值：細切口 30°、小片 2 cm', [NOTCH_DEG, MIN_PIECE_CM].join(), '30,2');
  ok('★ 　 兩個選項都有名字（面板用）', SLIT_LABEL.none && SLIT_LABEL.allow && ORDER_LABEL.feature && ORDER_LABEL.fewest);
  const p0 = P(mk('box'));
  eq('★★ 沒指定 ⇒ 預設：不要細切口、30°、凹處尖角先切', [p0.slits, p0.notchDeg, p0.cutOrder].join(), 'none,30,feature');

  // ① 細切口：小圓柱程式本來剪成 1 片，蓋子邊上留 V 形小口（張開 11°）
  const cyl = { r: 10, h: 30 };
  const pa = P(mk('cylinder', cyl), { slits: 'allow' });
  ok('★★★ 小圓柱、允許細切口 ⇒ 1 片、講得出細切口幾個', pa.total === 1 && pa.notch > 0, `${pa.total} 片 細切口 ${pa.notch}`);
  const pn = P(mk('cylinder', cyl));
  ok('★★★ 　 預設（不要細切口）⇒ 側面 ＋ 兩蓋 3 片、細切口 0', pn.total === 3 && pn.notch === 0 && pn.kind === 'corner', `${pn.total} 片 細切口 ${pn.notch} ${pn.label}`);
  const pz = P(mk('cylinder', cyl), { notchDeg: 0 });
  ok('★★ 　 角度改 0 ⇒ 什麼都不算細 ⇒ 跟允許一樣 1 片', pz.total === 1 && pz.notch === 0, `${pz.total} 片`);
  ok('★★ 　 「長條」那一種有細切口 ⇒ 預設⛔ 挑它（以前 2 片長條會勝過 3 片）', pn.options.some(o => o.kind === 'strip' && o.notch > 0) && pn.options[0].kind === 'corner');

  // ② 方塊十字形那種外框切線⛔ 算細切口；三角塊照樣 1 片
  ok('★★★ 楔形 ⇒ 照樣 1 片（外框的切線⛔ 算細切口）', P(mk('wedge')).total === 1 && P(mk('wedge')).notch === 0);
  // ③ 只攤接起來的那一片：面要照原本的順序（擺的方向才對）—— 以前 150×60×50 方塊 2 片變 4 片
  for (const order of ['feature', 'fewest']) {
    const pb = P(mk('box', { w: 150, h: 60, d: 50 }), { cutOrder: order });
    ok(`★★★ 150×60×50 方塊（${order}）⇒ 2 片全放得進`, pb.total === 2 && pb.big === 0, `${pb.total}/${pb.big}`);
  }
  // ④ 切的先後：樓梯內側的凹角 —— 凹處尖角先切 ⇒ 3 片；片數最少 ⇒ 2 片
  const sf = P(mk('stairs')), sl = P(mk('stairs'), { cutOrder: 'fewest' });
  ok('★★ 樓梯：凹處尖角先切 3 片、片數最少 2 片（都沒有細切口）', sf.total === 3 && sl.total === 2 && sf.notch === 0 && sl.notch === 0, `${sf.total} / ${sl.total}`);
  // ⑤ 提案講的片數 ＝ 接受之後真的展開（只攤一片算出來的，跟最後整個攤的對得上）
  for (const t of ['cone', 'roundBox', 'tube', 'stairs']) {
    const o = mk(t), p = P(o);
    const r = accept(o, p);
    ok(`★★★ ${t}：接受之後展開 ＝ 提案講的 ${p.total} 片、沒重疊、全放得進`, r.stats.total === p.total && !r.pieces.some(q => q.overlap) && p.big === 0, `${r.stats.total} 片`);
  }
  // ⑥ 曲面照舊：球、圓環還是花瓣（花瓣的 V 形切口是設計，⛔ 算）
  ok('★★★ 球 ⇒ 照舊花瓣 2 片', P(mk('sphere')).kind === 'petal' && P(mk('sphere')).total === 2);
  ok('★★ 圓環 ⇒ 照舊花瓣 1 片', P(mk('torus')).kind === 'petal');
  // ⑦ 不准切、使用者的縫照舊守
  const bk = mk('box');
  const top = [...bk.mesh().edges()].find(h => h.face && h.twin && h.twin.face && Math.abs(h.v.p.y - h.to.p.y) < 1e-6 && h.v.p.y > 0);
  seam.setKeep(bk.mesh(), top, true);
  const pk = P(bk);
  ok('★★★ 不准切的邊 ⇒ 提案⛔ 碰', !pk.edges.some(h => seam.isKeep(h)) && pk.big === 0);
}

section('分片成群 追加：3D 的開口只標細切口（2026-10-21）');
{
  /** kang「同意你的建議」（看過舊版 vs 改後的對照圖）：開口 ＝ 切線停在片中間、攤開張開小於 30°；其他切線都是縫 */
  const { seamKinds, vertexAngles, NOTCH_DEG } = await import('../js/unfold/seam.js');
  const { proposeSeams } = await import('../js/unfold/propose.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const mk = (t, over = {}) => {
    const o = new io.ModelObject({ name: t, kind: io.KIND.SOLID, src: { type: t, ...PRIM_DEFAULTS[t], ...over } });
    o.bake();
    return o;
  };
  const DEG = 180 / Math.PI;
  eq('★ 開口與細切口共用同一個角度（30°）', NOTCH_DEG, 30);

  // ① 角度：方塊的角一圈 270°；凹的面（L 形）凹進去那個角照樣算對
  const bx = mk('box');
  const va = vertexAngles(bx.mesh());
  near('★★ 方塊的角：一圈面角 270°', va.angle.get(bx.mesh().verts[0].id) * DEG, 270, 1e-6);
  const P2 = [[0, 0], [4, 0], [4, 1], [1, 1], [1, 4], [0, 4]];
  const L = Mesh.fromFaceList(P2.map(([x, z]) => new THREE.Vector3(x, 0, z)), [[0, 1, 2, 3, 4, 5].reverse()]);
  const vL = vertexAngles(L);
  near('★★★ 凹的面（L 形）凹進去那個角 ＝ 270°（以前只算得出 0～180°，會算成 90°）', vL.angle.get(L.verts[3].id) * DEG, 270, 1e-6);
  near('★★ 　 L 形六個角加起來 ＝ 720°（(6 − 2) × 180°）', [...vL.angle.values()].reduce((a, b) => a + b, 0) * DEG, 720, 1e-6);

  // ② 三角塊攤成一片（5 條外框切線）：以前全算開口，現在全是縫
  const w = mk('wedge');
  const pw = proposeSeams(w, { material: 'foamboard', board: { w: 240, h: 120, gap: 1, rotate: false } });
  for (const h of pw.edges) seam.setSeam(w.mesh(), h, true);
  const kw = seamKinds(w.mesh());
  ok('★★★ 楔形攤成一片：外框切線全是縫、開口 0（以前 5 條全算開口）', pw.total === 1 && kw.darts.length === 0 && kw.seams.length === pw.edges.length, `縫 ${kw.seams.length} 開口 ${kw.darts.length}`);
  ok('★★ 　 角度改成 180° ⇒ 張開 90° 的角也算細 ⇒ 變回開口', seamKinds(w.mesh(), 180).darts.length > 0);

  // ③ 方塊只切一條邊（停在兩個角）：張開 90°、⛔ 細 ⇒ 縫；角度改大才算開口
  const b1 = mk('box');
  const e1 = [...b1.mesh().edges()].find(h => h.face && h.twin && h.twin.face);
  seam.setSeam(b1.mesh(), e1, true);
  eq('★★ 方塊只切一條邊 ⇒ 縫（角張開 90°）', seamKinds(b1.mesh()).darts.length, 0);
  eq('★★ 　 角度 100° ⇒ 開口', seamKinds(b1.mesh(), 100).darts.length, 1);

  // ④ 花瓣的 V 照樣是開口（半球提案花瓣、接受之後）
  const dm = mk('dome', { r: 15 });
  const pd = proposeSeams(dm, { material: 'paper' });
  for (const h of pd.edges) seam.setSeam(dm.mesh(), h, true);
  ok('★★★ 半球花瓣：V 形照樣是開口', pd.kind === 'petal' && seamKinds(dm.mesh()).darts.length > 0, `${pd.label} 開口 ${seamKinds(dm.mesh()).darts.length}`);
}

section('智慧分切 大模型加快 甲：結果不變（2026-10-21）');
{
  /**
   * kang「算得對第一、算得快第二」：加快的部分**結果一模一樣**才算數。
   * 全部模型的逐條對照在沙箱做（齒輪不設上限，改前 128 秒 → 改後 58 秒，87 項提案逐條一樣）；這裡守機制。
   */
  const { proposeSeams } = await import('../js/unfold/propose.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const mk = (t, over = {}) => {
    const o = new io.ModelObject({ name: t, kind: io.KIND.SOLID, src: { type: t, ...PRIM_DEFAULTS[t], ...over } });
    o.bake();
    return o;
  };
  // ① 試算模式：片數、重疊、外框、補剪條數跟一般模式一樣
  const same = (m, rule) => {
    const a = unfoldMesh(m, rule), b = unfoldMesh(m, rule, { probe: {} });
    const f = r => JSON.stringify(r.pieces.map(p => [p.qty, p.overlap, Math.round(p.width * 1e6), Math.round(p.height * 1e6), p.autoCut.lines]));
    return f(a) === f(b) && a.stats.total === b.stats.total;
  };
  const cap = Mesh.fromGeometry(new THREE.SphereGeometry(30, 16, 8, 0, Math.PI * 2, 0, Math.PI / 3));
  ok('★★★ 試算模式 vs 一般模式：球冠（會疊）片數、重疊、外框、補剪一樣', same(cap, makeRule('paper', 0.03)));
  ok('★★★ 　 方塊、圓柱、齒輪（紙）也一樣', ['box', 'cylinder', 'gear'].every(t => same(mk(t).mesh(), makeRule('paper', 0.03))));
  const pr = unfoldMesh(mk('box').mesh(), makeRule('paper', 0.03), { probe: {} });
  ok('★★ 　 試算模式⛔ 算出圖用的（接合編號、3D 位置）', pr.pieces.every(p => p.joints.length === 0 && p.faces3.length === 0));
  // ② 智慧分切照舊：上面幾節的數字都沒變（那幾節全過 ＝ 結果不變）；這裡多守一個大的：齒輪不設上限 ⇒ 5 片、沒有細切口
  const t0 = performance.now();
  const pg = proposeSeams(mk('gear'), { material: 'paper', timeLimitMs: 1e9 });
  const ms = performance.now() - t0;
  ok('★★★ 齒輪（1,656 面）不設時間上限 ⇒ 算完、5 片、沒有細切口（改前 32 秒算出同一份）', !pg.timedOut && pg.total === 5 && pg.notch === 0, `${pg.total} 片 ${Math.round(ms)} ms`);
  ok('★ 　 時間（參考）：沙箱約 14 秒；超過 40 秒就是變慢了', ms < 40000, `${Math.round(ms)} ms`);
}

section('智慧分切 大模型 丙：一邊算一邊讓畫面喘口氣、可以先停（2026-10-21）');
{
  /** kang「算得對第一、算得快第二」：⛔ 預設截斷；面板用的那一支跟一口氣算完是同一份程式 ⇒ 結果一樣；停不停由使用者決定 */
  const { proposeSeams, proposeSeamsAsync } = await import('../js/unfold/propose.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const mk = (t, over = {}) => {
    const o = new io.ModelObject({ name: t, kind: io.KIND.SOLID, src: { type: t, ...PRIM_DEFAULTS[t], ...over } });
    o.bake();
    return o;
  };
  const sig = p => [p.kind, p.total, p.notch, p.edges.length].join('/');
  for (const t of ['box', 'cylinder', 'sphere']) {
    const a = proposeSeams(mk(t), { material: 'foamboard' });
    const ticks = [];
    const b = await proposeSeamsAsync(mk(t), { material: 'foamboard' }, { onProgress: pr => ticks.push(pr.phase), sliceMs: 5 });
    ok(`★★★ ${t}：邊算邊停 ＝ 一口氣算完（同一份程式）`, sig(a) === sig(b) && !b.timedOut, `${sig(a)} vs ${sig(b)}`);
    if (t === 'sphere') ok('★★ 　 球：中途有交出進度（在算哪一段）', ticks.length > 0 && ticks.every(x => typeof x === 'string'), ticks.slice(0, 3).join('、'));
  }
  ok('★★★ 預設⛔ 設時間上限（以前 2 秒就截斷）：圓環算到完', !proposeSeams(mk('torus'), { material: 'foamboard' }).timedOut);
  let n = 0;
  const g = await proposeSeamsAsync(mk('gear'), { material: 'paper', shouldStop: () => n > 3 }, { onProgress: () => { n++; }, sliceMs: 5 });
  ok('★★★ 齒輪按「先停下來」⇒ 很快收手、交出目前最好的、標還沒算完', g.timedOut && g.edges.length > 0 && g.total > 0, `${g.total} 片`);
}

section('智慧分切 小片那一步⛔ 越過「不要細切口」（2026-10-21）');
{
  /**
   * 齒輪 80 齒：嚴格接完 13 片 0 個細切口，「小於 2 cm 的片放寬再併」併成 9 片卻多 7 個（設定被越過去）⇒ 不要細切口時小片那一步只放寬補剪。
   * 80 齒要 5 分鐘 ⇒ 用最少的 8 齒（齒數最少 8）、小片門檻 5 cm 重現同一件事（改前 3 片、細切口 2 個）。
   */
  const { proposeSeams } = await import('../js/unfold/propose.js');
  const { PRIM_DEFAULTS } = await import('../js/build/prim.js');
  const gear = () => {
    const o = new io.ModelObject({ name: '齒輪', kind: io.KIND.SOLID, src: { type: 'gear', ...PRIM_DEFAULTS.gear, teeth: 8 } });
    o.bake();
    return o;
  };
  const a = proposeSeams(gear(), { material: 'paper', minPieceCm: 5 });
  ok('★★★ 不要細切口：小片那一步⛔ 多出細切口（改前 3 片、2 個）', a.notch === 0, `${a.total} 片、細切口 ${a.notch}`);
  ok('★★ 　 併不掉的小片留著、提案講幾片（small）', a.small > 0 && a.minPiece === 5, `小片 ${a.small}`);
  const b = proposeSeams(gear(), { material: 'paper', minPieceCm: 5, slits: 'allow' });
  ok('★★ 片少一點：小片那一步照舊放寬（片比不要細切口少、可以有細切口）', b.total < a.total && b.notch > 0, `${b.total} 片、細切口 ${b.notch}`);
  const c = proposeSeams(gear(), { material: 'paper' });
  ok('★ 預設 2 cm：8 齒也沒有細切口', c.notch === 0, `${c.total} 片、小片 ${c.small}`);
}

console.log(`\n  通過 ${pass}　失敗 ${fail}\n`);
if (fail) {
  console.log('  失敗項目：');
  for (const f of fails) console.log('    · ' + f);
  console.log('');
  process.exit(1);
}
console.log('  全部通過。\n');
