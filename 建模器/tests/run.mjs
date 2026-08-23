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
const { summarize, SURFACE } = await import('../js/core/region.js');
const { buildPrim, bendDevelopedLength, isSheetPrim, defaultSrc }
  = await import('../js/build/prim.js');
const { initCSG, csgError, BOOL_OPS } = await import('../js/build/bool.js');
const { arrayMatrices, ARRAY_MODES } = await import('../js/build/array.js');
const io = await import('../js/core/io.js');
const THREE = await import('three');
// toolbar.js 只在 Panel 的建構子裡碰 DOM，模組層級沒有，所以匯入得進來。
// topologyCheck 是刻意抽出來的純函式，就是為了能在這裡測。
const { topologyCheck } = await import('../js/ui/toolbar.js');
// 第 3 期。展開核心與規則同樣不碰 DOM，畫圖也刻意拆成
// 「決定畫什麼」與「怎麼畫出來」，前者是純資料，測得到。
const { neutralRadius, bendAllowance } = await import('../js/build/prim.js');
const { makeRule, MATERIALS, MATERIAL_KEYS, DEFAULT_MATERIAL }
  = await import('../js/unfold/rules.js');
const { unfoldMesh } = await import('../js/unfold/flatten.js');
// part.js 是文件物件與展開引擎之間的轉接層，不碰 DOM，所以測得到
const { unfoldObject } = await import('../js/unfold/part.js');
const seam = await import('../js/unfold/seam.js');
const { drawProgram, toSVG, titleLines, labelWidth } = await import('../js/out/sheet.js');
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
        printCheck, STL_UNITS } = await import('../js/out/stl.js');
// 第 6 期第一刀。移動頂點與改完之後的連帶重算，全部是純幾何、不碰 DOM。
const edit = await import('../js/core/edit.js');

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
  ok('DXF 表格數量宣告正確',
    dxf.includes('\r\n2\r\nLAYER\r\n70\r\n7\r\n'),
    'CUT/FOLD/BEND/DIM/TEXT/JOIN 六個圖層 ＋ 圖層 0');

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
  eq('DXF LINE 數 ＝ 起點數', (dxf.match(/\r\nLINE\r\n/g) || []).length,
    (dxf.match(/\r\n11\r\n/g) || []).length);
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
    ['圓角方塊', 'roundBox', { w: 60, h: 45, d: 40, r: 6, segR: 4 }]
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
   * ⚠ 面內位置不動。
   *
   * 貼合只負責「貼平」，不會把兩個面的中心對在一起 ——
   * 那會讓東西突然飛到模型另一頭，而使用者只是想讓它貼上去。
   * 這一項在盯「有沒有偷偷把中心對齊」：沿著法線的距離該歸零，
   * 但**垂直於法線的那兩個方向不該被動到**。
   */
  {
    const A = mkA();
    A.rot.set(0, 0, 0);                        // 已經正對，只差距離
    A.pos.set(120, 17, -9);
    const fA = faceAt(A, V3(-20, 0, 0));
    const fB = faceAt(B, V3(30, 0, 0));
    const r = M.mateFaceToFace(A, M.faceFrame(A, fA), M.faceFrame(B, fB));
    near('貼合後 Y 沒有被動到', r.pos.y, 17, 1e-12);
    near('貼合後 Z 沒有被動到', r.pos.z, -9, 1e-12);
    ok('貼合後 X 有被推過去', Math.abs(r.pos.x - 120) > 1);
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
  eq('方塊總邊數', [...m.edges()].length, 18);
  /**
   * 18 條邊裡有 6 條是三角化產生的共面對角線，畫面上看不到
   * （scene.js 畫稜線用 EdgesGeometry(geometry, 1)，只畫轉折 > 1 度的）。
   * 可標記的必須剛好是看得見的那 12 條 ——
   * 讓人標到看不見的邊，結果會是「一個面被斜切成兩半」，
   * 正確但絕對不是他要的，而且他不知道自己點了什麼。
   */
  eq('可標記的邊 ＝ 看得見的稜線', seam.markableEdges(m).length, 12);

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
  // 沒封閉的路徑擠不出實體，但畫面上看不出來 —— 一定要擋下來並講清楚
  const s = `<svg width="10cm" height="10cm" viewBox="0 0 100 100">`
    + `<path d="M0,0 H50 V50"/></svg>`;
  const r = prof.readSVG(s, { tolMm: 0.2 });
  ok('沒封閉的路徑會被擋下來', !r.ok);
  ok('而且講得出是「沒有封閉」', r.errors.join('').includes('封閉'), r.errors.join('|'));
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

  // ── 負值 ＝ 往內凹 ──
  {
    const m = buildPrim('box', { w: 60, h: 45, d: 40 });
    const r = edit.extrudeFace(m, topOf(m), -15);
    near('負值往內凹：108000 − 60×40×15', r.mesh.volume(), 72000, 1e-6);
    ok('凹進去也還是封閉、χ＝2', r.mesh.isClosed() && chi(r.mesh) === 2);
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

console.log(`\n  通過 ${pass}　失敗 ${fail}\n`);
if (fail) {
  console.log('  失敗項目：');
  for (const f of fails) console.log('    · ' + f);
  console.log('');
  process.exit(1);
}
console.log('  全部通過。\n');
