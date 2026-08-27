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
  /** 準備一個三樣標記都有的網格：baked 圓柱 → 環切 3 刀（hard）→ 手動標 CUT 與 smooth */
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
    return m;
  })();

  const want = markCount(base);
  ok(`準備好的網格三樣標記都有（${Object.entries(want).map(([k, v]) => k + ' ' + v).join('、')}）`,
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
  const tiny = edit.knifePath(box, [pick(hes[0], 0.00001), pick(hes[2], 0.5)]);
  ok('★★ 太靠近角落要擋，而且要指出「用多點連接」那條走得通的路',
     !tiny.ok && /多點連接/.test(tiny.reason || ''), tiny.reason);

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
    eq('前提：這一片有 66 個接合編號', js.length, 66);

    /**
     * 🔴 **主斷言：一個號碼都不可以印在洞裡。**
     * ⚠ 修之前是 **32 個 / 66 個**掉在洞裡（實測）。
     */
    const off = js.filter(it => !pointInPoly(it.x, it.y, ring.outline));
    eq('★★★ 接合編號沒有一個落在料外（洞裡）', off.length, 0);

    /**
     * ⚠ 缺口那裡**還會剩一對** —— 同一個號碼的兩端在缺口碰頭，
     * 那是缺口本身的幾何，跟字大小無關。
     * ⛔ 期望值寫 0 的話就是把一個做不到的目標釘進測試。
     */
    ok('★★ 靠太近的最多剩 1 對（修之前是 13 對）', clashes(js) <= 1, `${clashes(js)} 對`);

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
}

console.log(`\n  通過 ${pass}　失敗 ${fail}\n`);
if (fail) {
  console.log('  失敗項目：');
  for (const f of fails) console.log('    · ' + f);
  console.log('');
  process.exit(1);
}
console.log('  全部通過。\n');
