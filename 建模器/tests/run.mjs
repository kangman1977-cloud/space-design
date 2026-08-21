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

const { Mesh } = await import('../js/core/mesh.js');
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
const { makeRule, MATERIALS, MATERIAL_KEYS } = await import('../js/unfold/rules.js');
const { unfoldMesh } = await import('../js/unfold/flatten.js');
const { drawProgram, toSVG, titleLines, labelWidth } = await import('../js/out/sheet.js');
const { toDXF, UNITS } = await import('../js/out/dxf.js');
// save.js 在模組層級只做 typeof window 判斷，不碰 DOM，所以 Node 也載得進來
const { safeName, TYPES, canChoosePath } = await import('../js/out/save.js');

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

section('第 3 期：展開長度交叉驗證（弧長 vs 弦長）');

{
  /**
   * 這一節是整個第 3 期最重要的驗證。
   *
   * flatten.js 是**從網格**辨識出圓弧折彎帶再算展開長，
   * bendDevelopedLength() 是**從參數**直接套公式。
   * 兩條完全獨立的路，算出來必須一模一樣 ——
   * 對不上就代表其中一邊有問題，這跟第 2 期「管 vs 布林」同一招。
   *
   * 同時要確認修正真的有在動：修正後的長度必須明顯大於弦長總和，
   * 不然「有沒有修正」根本測不出來。
   */
  for (const seg of [2, 3, 4, 6, 8, 12, 24]) {
    const t = 0.3;
    const src = { w: 20, first: 30, arcSeg: seg, k: 0.4,
      bends: [{ angle: 90, ri: 2, len: 20 }] };
    const r = unfoldMesh(buildPrim('bend', src, t), makeRule('steel', t));
    const want = bendDevelopedLength(src, t);

    eq(`arcSeg ${seg} 展開成一片`, r.pieces.length, 1);
    near(`arcSeg ${seg} 網格辨識 ＝ 參數公式`, r.pieces[0].width, want, 1e-9);

    // 弦長總和（沒修正時會得到的數字）
    const rn = 2 + 0.4 * t;
    const chord = seg * 2 * rn * Math.sin(Math.PI / 2 / seg / 2);
    ok(`arcSeg ${seg} 修正後確實比弦長長`, want - (50 + chord) > 1e-9);
  }
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
    near(`${name} 展開長 ＝ 參數公式`, p.width, bendDevelopedLength(src, t), 1e-9);
    near(`${name} 展開寬 ＝ 板寬`, p.height, src.w, 1e-9);
    eq(`${name} 折彎道數`, p.bends.length, nBend);
    eq(`${name} 一片`, r.pieces.length, 1);
  }
}

{
  // 辨識出來的內側 R 與角度必須跟輸入的一樣 —— 展開圖上標的就是這兩個數字
  const t = 0.3;
  const src = { w: 40, first: 25, arcSeg: 6, k: 0.4,
    bends: [{ angle: 90, ri: 2, len: 15 }, { angle: -60, ri: 3.5, len: 25 }] };
  const p = unfoldMesh(buildPrim('bend', src, t), makeRule('steel', t)).pieces[0];

  near('辨識 第1道 角度', p.bends[0].angle, 90, 1e-6);
  near('辨識 第1道 內側R', p.bends[0].ri, 2, 1e-6);
  near('辨識 第1道 中性層R', p.bends[0].r, 2.12, 1e-6);
  near('辨識 第2道 角度', p.bends[1].angle, -60, 1e-6);
  near('辨識 第2道 內側R', p.bends[1].ri, 3.5, 1e-6);
  eq('辨識 第1道 是圓弧', p.bends[0].isArc, true);

  // 折彎區在展開圖上佔的寬度 ＝ 那一道的 BA
  near('第1道 折彎區寬 ＝ BA', p.bends[0].x1 - p.bends[0].x0,
    bendAllowance(src.bends[0], src.k, t), 1e-9);
  near('第2道 折彎區寬 ＝ BA', p.bends[1].x1 - p.bends[1].x0,
    bendAllowance(src.bends[1], src.k, t), 1e-9);
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
   *   2. 剪開之後兩端那兩片仍算在圓弧裡，總長才會等於 2πr
   * 少算任何一項都會得到 157.0 而不是 157.08。
   */
  // 容許值 1e-4 cm ＝ 1 微米。轉折角是從面法向量算出來的，
  // 段數多的時候浮點誤差會累積；平均過後這是可以穩定達到的精度，
  // 而且遠比任何加工公差嚴格。寫死 1e-6 只是自欺欺人。
  for (const seg of [8, 16, 32, 64, 128]) {
    const m = buildPrim('cylinder', { r: 25, h: 70, seg, openEnded: true }, 0.2);
    const p = unfoldMesh(m, makeRule('steel', 0.2)).pieces[0];
    near(`圓柱側面 ${seg} 段 展開長 ＝ 2πr`, p.width, 2 * Math.PI * 25, 1e-4);
    near(`圓柱側面 ${seg} 段 展開高`, p.height, 70, 1e-9);
    near(`圓柱側面 ${seg} 段 辨識半徑`, p.bends[0].r, 25, 1e-4);
    near(`圓柱側面 ${seg} 段 辨識總角度`, Math.abs(p.bends[0].angle), 360, 1e-3);
  }
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
  ok('DXF 表格數量宣告正確',
    dxf.includes('\r\n2\r\nLAYER\r\n70\r\n6\r\n'), '5 個圖層 ＋ 圖層 0');

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

  // 折彎區的數字很窄（3.33cm）但一定要標出來 —— 那是師傅畫線的依據，
  // 不能因為放不下就丟掉，只能錯開到下一排
  const rz = unfoldMesh(buildPrim('bend', { w: 60, first: 40, arcSeg: 4, k: 0.4,
    bends: [{ angle: 90, ri: 2, len: 30 }, { angle: -90, ri: 2, len: 25 }] }, 0.3),
    makeRule('steel', 0.3));
  const texts = drawProgram(rz.pieces[0], { rule: makeRule('steel', 0.3) }).items
    .filter(i => i.t === 'text' && i.style === 'dim').map(i => i.s);
  ok('窄的折彎區尺寸仍然標得出來', texts.filter(s => s === '3.33').length === 2,
    texts.join(' '));

  // 字寬估算：中文一個字約一個字高，數字約 0.55
  ok('字寬估算 中文比數字寬', labelWidth('折彎', 1) > labelWidth('12', 1));
  ok('字寬估算 字多的比較寬', labelWidth('12345', 1) > labelWidth('12', 1));
}

section('第 3 期：效能');

{
  const t0 = Date.now();
  const m = buildPrim('cylinder', { r: 25, h: 70, seg: 128, openEnded: true }, 0.2);
  const r = unfoldMesh(m, makeRule('steel', 0.2));
  const ms = Date.now() - t0;
  near('128 段圓柱 展開長仍精確', r.pieces[0].width, 2 * Math.PI * 25, 1e-6);
  ok(`128 段圓柱 展開耗時 ${ms}ms（< 2 秒）`, ms < 2000, `${ms}ms`);
}

// ═══════════════════════════════════════════════════════

section('結果');
console.log(`\n  通過 ${pass}　失敗 ${fail}\n`);
if (fail) {
  console.log('  失敗項目：');
  for (const f of fails) console.log('    · ' + f);
  console.log('');
  process.exit(1);
}
console.log('  全部通過。\n');
