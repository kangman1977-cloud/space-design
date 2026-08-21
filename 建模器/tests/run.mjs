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
  const p = { w: 60, first: 40, arcSeg: 4, bends: [{ angle: 90, r: 2, len: 30 }] };
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
    { angle: 90, r: 1, len: 50 }, { angle: 90, r: 1, len: 30 }] };
  const z = { w: 50, first: 30, arcSeg: 3, bends: [
    { angle: 90, r: 1, len: 20 }, { angle: -90, r: 1, len: 30 }] };

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
  const sharp = { w: 50, first: 30, arcSeg: 3, bends: [{ angle: 90, r: 0, len: 20 }] };
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
  for (const [seg, ang] of [[1, 90], [3, 90], [8, 90], [4, 45], [4, 135]]) {
    const m = buildPrim('bend', { w: 60, first: 40, arcSeg: seg, bends: [{ angle: ang, r: 2, len: 30 }] });
    const t = 0.3;
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
    const bendSrc = { type: 'bend', w: 60, first: 40, arcSeg: 4, bends: [{ angle: 90, r: 2, len: 30 }] };
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

section('結果');
console.log(`\n  通過 ${pass}　失敗 ${fail}\n`);
if (fail) {
  console.log('  失敗項目：');
  for (const f of fails) console.log('    · ' + f);
  console.log('');
  process.exit(1);
}
console.log('  全部通過。\n');
