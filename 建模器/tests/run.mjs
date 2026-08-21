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
const { buildPrim } = await import('../js/build/prim.js');
const { initCSG, csgError, BOOL_OPS } = await import('../js/build/bool.js');
const io = await import('../js/core/io.js');
const THREE = await import('three');

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

section('結果');
console.log(`\n  通過 ${pass}　失敗 ${fail}\n`);
if (fail) {
  console.log('  失敗項目：');
  for (const f of fails) console.log('    · ' + f);
  console.log('');
  process.exit(1);
}
console.log('  全部通過。\n');
