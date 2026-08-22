/**
 * section.js — 剖面分切的幾何核心
 *
 * 用一組平行平面去切一個立體，每一刀得到一個或多個封閉輪廓。
 * 每個輪廓轉成 DXF 拿去 CNC 裁切，切出一疊板，照順序疊起來黏合，
 * 就長回原來的立體形狀。**片厚 ＝ 板材厚度。**
 *
 * ── 為什麼這條路值得做 ──────────────────────────────
 * 高斯絕妙定理說球面、環面、自由曲面**數學上不可能無失真展開**。
 * 展開那條路碰到它們只能近似。
 * 剖面分切完全繞過這個問題 —— 它不需要曲面可展，任何形狀都切得開，
 * 而且是精確的。
 *
 * ── 這個檔案完全不知道材料是什麼，也不碰 DOM ────────────
 * 跟 unfold/flatten.js 同一條原則。切片是純幾何，
 * 所以整個檔案在 Node 裡用數學對得了答案（片面積、片數、累計高度）。
 *
 * 單位一律 cm。
 */

import * as THREE from 'three';

/**
 * 三個切片軸。
 *
 * ── u、v 的順序不是隨便排的，排錯會出鏡射的圖 ────────────
 * 每個軸配一組 (u, v) 當作 2D 圖的橫軸與縱軸，而且必須滿足
 * **u × v ＝ 切片軸**（右手系）。滿足了，從 +軸 方向看下去
 * 逆時針就是正面積，切出來的片才是「正的」。
 *
 * 若把 u、v 對調，每一片都會左右翻過來 —— 圖看起來完全正常，
 * 面積、片數、孔位全部算得對，但**做出來的東西是鏡像的，疊不回原形**。
 * 而且要等切完料疊起來才會發現。所以這裡寫死並在測試裡盯住手性。
 */
export const AXES = {
  x: { key: 'x', label: 'X（從右邊切）', u: 'y', v: 'z', dir: [1, 0, 0] },
  y: { key: 'y', label: 'Y（水平切，最常用）', u: 'z', v: 'x', dir: [0, 1, 0] },
  z: { key: 'z', label: 'Z（從正面切）', u: 'x', v: 'y', dir: [0, 0, 1] }
};

export const AXIS_KEYS = ['y', 'x', 'z'];
export const DEFAULT_AXIS = 'y';

/** 頂點落在平面上時往正側推的量。見下方 sectionAt() 的說明。 */
const ON_PLANE = 1e-9;

/**
 * 「湊得剛剛好」的容許值，單位 cm。
 *
 * ── 為什麼不是 1e-6 ──────────────────────────────────
 * 第一版用 1e-6 當判準，實測（2026-08-22）在布林聯集出來的物件上
 * 跳出「**還差 0 cm 沒疊到**」——自相矛盾的一句話。
 * 成因是 Manifold 的輸出座標帶著 1e-4 等級的精度殘留，
 * 所以模型高度不是剛好 60 而是 60.0001。
 *
 * 1e-6 cm ＝ 十奈米。**那是浮點數的尺度，不是板材的尺度。**
 * 這個專案切的是珍珠板與壓克力，0.1mm 已經遠低於任何切得出來的東西。
 * 判準要挑一個**有物理意義的量**去比（坑第 25 條講過同一件事，
 * 那次是拿四元數分量比，這次是拿浮點誤差當公差）。
 *
 * 兩個地方都要用它：
 *   一、「剩下的填滿」算片數時 —— 差一點點不該少算一整片
 *   二、面板顯示差額警告時 —— 差一點點不該跳警告
 * 只改一邊的話，會變成「不跳警告，但少一片」，更難查。
 */
export const FIT_TOL = 0.01;

/** 串接輪廓時判斷「同一個點」的量化格線 */
const SNAP = 1e6;

// ═══════════════════════════════════════════════════════
//  一、分段：一段一段疊上去
// ═══════════════════════════════════════════════════════

/**
 * 把「板厚 × 片數」的分段表換算成一疊實際的位置。
 *
 * ── 為什麼是「疊上去」而不是「先分 N 片再改厚度」──────────
 * 模型的總高是固定的。若先說「分 20 片」再把中間幾片改成 2cm，
 * 總高就跟著變了 —— 那已經不是同一個模型。
 * 所以正確的順序是反過來：**你設每段的板厚與片數，
 * 程式算出疊到多高、離模型頂端還差多少。**
 *
 * 差額一律如實回報，**不四捨五入湊滿**。
 * 偷偷湊滿的後果是圖看起來剛剛好、東西做出來矮一截，
 * 而且要疊完才發現（跟坑第 5、25 條同一種傷害：讓人不敢相信數字）。
 *
 * @param {number} height 模型沿切片軸的總高（cm）
 * @param {Array} bands   [{ t:1.0, n:5 }, { t:2.0, n:7 }, { t:1.0, n:'rest' }]
 *                        n 給 'rest'（或 null）＝ 用剩下的高度能塞幾片就幾片
 * @returns {{slabs:Array, used:number, height:number, diff:number, bands:Array}}
 */
export function planSlabs(height, bands) {
  const list = (bands && bands.length) ? bands : [{ t: 1.0, n: 'rest' }];
  const slabs = [];
  const info = [];
  let used = 0;

  for (let bi = 0; bi < list.length; bi++) {
    const t = +list[bi].t;
    if (!(t > 0)) { info.push({ t, n: 0, from: 0, to: 0, bad: '板厚要大於 0' }); continue; }

    let n = list[bi].n;
    if (n === 'rest' || n === null || n === undefined || n === '') {
      // 剩下的填滿：能塞幾片就幾片，塞不滿的零頭留著（下面會顯示差額）。
      // 容許值加在分子上，這樣「差 0.0001 就滿一片」不會被無條件捨去掉一整片。
      n = Math.max(0, Math.floor((height - used + FIT_TOL) / t));
    }
    n = Math.max(0, Math.floor(+n) || 0);

    const from = slabs.length + 1;
    for (let i = 0; i < n; i++) {
      const z0 = used, z1 = used + t;
      slabs.push({
        index: slabs.length + 1,   // 片號從 1 開始，跟現場講「第幾片」一致
        band: bi,
        t, z0, z1,
        /**
         * 取這一片**正中央**的截面，不是底面。
         * 一塊 1cm 厚的板要代表 z0~z1 這一段立體，取中央的誤差是對稱的
         * （上半多切掉、下半多留下，互相抵銷）；取底面則整疊都往同一邊偏。
         * 順帶避開一件事：取底面時第一刀剛好落在模型最底端那個面上，
         * 那是最容易出退化輪廓的地方。
         */
        mid: (z0 + z1) / 2
      });
      used += t;
    }
    info.push({ t, n, from, to: slabs.length });
  }

  return {
    slabs,
    used,
    height,
    diff: height - used,      // 正 ＝ 還差這麼多沒疊到；負 ＝ 疊過頭了
    bands: info
  };
}

// ═══════════════════════════════════════════════════════
//  二、一刀：平面切網格 → 封閉輪廓
// ═══════════════════════════════════════════════════════

/**
 * 切一刀。
 *
 * @param {Mesh} mesh  半邊網格（**要先轉成世界座標**）
 * @param {string} axisKey 'x' | 'y' | 'z'
 * @param {number} coord 平面位置
 * @returns {{loops:Array, area:number, open:number}}
 *   loops 每個是 { pts:[{x,y}], area, isHole }
 *   area  這一刀的實心面積（外輪廓減掉內孔）
 *   open  沒接成封閉迴圈的線串數量；> 0 表示網格不封閉
 */
export function sectionAt(mesh, axisKey, coord) {
  const A = AXES[axisKey] || AXES[DEFAULT_AXIS];
  const K = A.key, U = A.u, V = A.v;
  const kv = new THREE.Vector3(...A.dir);

  const segs = [];

  for (const f of mesh.faces) {
    const vs = mesh.faceVerts(f);
    const n = vs.length;
    if (n < 3) continue;

    /**
     * ── 頂點剛好落在平面上怎麼辦 ──────────────────────
     * 距離是 0 的頂點會讓「有沒有跨過去」變成三態，
     * 每一種組合都要另外處理，而漏掉任何一種就會少一段線，
     * 輪廓接不起來 —— 而且只在某些高度發作，最難查。
     *
     * 標準解法：把 0 一律推到正側。這樣每條邊只有「跨」與「不跨」兩種，
     * 而且推的量遠小於任何有意義的尺寸，對結果沒有影響。
     * 整片貼在平面上的面會變成全正，自然不產生線段 —— 那正是我們要的。
     */
    const d = new Array(n);
    for (let i = 0; i < n; i++) {
      let x = vs[i].p[K] - coord;
      if (Math.abs(x) < ON_PLANE) x = ON_PLANE;
      d[i] = x;
    }

    // 沿著這個面的邊走一圈，記下所有穿過平面的點（順序就是繞行順序）
    const hits = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if ((d[i] < 0) === (d[j] < 0)) continue;
      const s = d[i] / (d[i] - d[j]);
      const a = vs[i].p, b = vs[j].p;
      hits.push({
        x: a[U] + (b[U] - a[U]) * s,
        y: a[V] + (b[V] - a[V]) * s
      });
    }
    if (hits.length < 2) continue;

    /**
     * 平面多邊形跟平面相交，穿越點一定是「進、出、進、出……」交替，
     * 所以照繞行順序兩兩配對就是正確的線段。
     * 三角形永遠只有 2 個點；四邊形凹進去時可能有 4 個，配對照樣成立。
     */
    const nn = f.normal;
    // 線段方向 ＝ 切片軸 × 面法向。
    // 這樣走出來的迴圈從 +軸 看下去是逆時針，實心在左手邊，
    // 內孔自然變成順時針 —— 外輪廓與內孔不必另外判斷包含關係。
    const t = new THREE.Vector3().crossVectors(kv, nn);
    const tu = t[U], tv = t[V];

    for (let i = 0; i + 1 < hits.length; i += 2) {
      let p = hits[i], q = hits[i + 1];
      if ((q.x - p.x) * tu + (q.y - p.y) * tv < 0) { const s = p; p = q; q = s; }
      if (Math.abs(q.x - p.x) < 1e-12 && Math.abs(q.y - p.y) < 1e-12) continue;
      segs.push({ a: p, b: q });
    }
  }

  return chain(segs);
}

/**
 * 把一堆有向線段串成封閉迴圈。
 *
 * 用量化過的座標當 key 找「下一段」。量化是必要的：
 * 同一個交點由相鄰兩個面各自算一次，浮點結果可能差在最後一兩位。
 */
function chain(segs) {
  const key = p => `${Math.round(p.x * SNAP)},${Math.round(p.y * SNAP)}`;
  const from = new Map();
  for (const s of segs) {
    const k = key(s.a);
    if (!from.has(k)) from.set(k, []);
    from.get(k).push(s);
  }

  const loops = [];
  let open = 0;
  const used = new Set();

  for (const s0 of segs) {
    if (used.has(s0)) continue;

    const pts = [s0.a];
    let cur = s0;
    used.add(cur);
    let closed = false;

    for (let guard = 0; guard < segs.length + 2; guard++) {
      pts.push(cur.b);
      const k = key(cur.b);
      if (k === key(s0.a)) { closed = true; pts.pop(); break; }

      const cand = (from.get(k) || []).find(s => !used.has(s));
      if (!cand) break;                 // 走到底接不下去 ＝ 網格不封閉
      used.add(cand);
      cur = cand;
    }

    if (!closed) { open++; continue; }

    const clean = dropCollinear(pts);
    if (clean.length < 3) continue;

    const a = signedArea(clean);
    if (Math.abs(a) < 1e-9) continue;   // 退化成一條線，丟掉
    loops.push({ pts: clean, area: a, isHole: a < 0 });
  }

  return {
    loops,
    area: loops.reduce((s, l) => s + l.area, 0),
    open
  };
}

/**
 * 拿掉共線的多餘頂點。
 *
 * 方塊的一個側面在網格上是兩個三角形，切下去會得到兩段首尾相接、
 * 方向完全一樣的線 —— 中間那個點是三角化的產物，不是形狀的一部分。
 * 留著的話 DXF 會多一倍的 LINE 實體，進 Illustrator 之後
 * 那個點還會變成一個可以被拖走的錨點。
 *
 * 判準用**面積**不用角度：三點圍出的三角形面積小於容許值就是共線。
 * 面積對「兩點很近」與「角度很小」同時有效，而角度對前者會誤判。
 * 容許值刻意設得極小（1e-9 cm²），只清掉真正共線的，不動任何曲線。
 */
function dropCollinear(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-12 && Math.abs(last.y - p.y) < 1e-12) continue;
    out.push(p);
  }
  if (out.length < 3) return out;

  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const a = out[(i - 1 + out.length) % out.length];
      const b = out[i];
      const c = out[(i + 1) % out.length];
      const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
      if (Math.abs(cross) / 2 < 1e-9) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** 鞋帶公式。逆時針為正。 */
export function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

// ═══════════════════════════════════════════════════════
//  三、整份：切成一疊
// ═══════════════════════════════════════════════════════

/**
 * 把一個網格切成一疊片。
 *
 * @param {Mesh} mesh 世界座標的半邊網格
 * @param {object} opt { axis, bands }
 * @returns {{ok, axis, plan, slices, warnings, stats}}
 */
export function sliceMesh(mesh, opt = {}) {
  return sliceMany([mesh], opt);
}

/**
 * 一次切多個網格，用**同一組平面**。
 *
 * 多物件一定要共用一組平面，不能各切各的：各自算自己的高度範圍的話，
 * 兩個物件的第 3 片會落在不同高度，疊起來就對不上了。
 * 所以高度範圍取全部物件的聯集，切出來的輪廓再合進同一片裡。
 *
 * @param {Mesh[]} meshes 世界座標的半邊網格
 */
export function sliceMany(meshes, opt = {}) {
  const axis = AXES[opt.axis] ? opt.axis : DEFAULT_AXIS;
  const A = AXES[axis];
  const warnings = [];
  const list = meshes.filter(Boolean);

  if (!list.length) return { ok: false, reason: '沒有可以切的物件。', axis };

  let lo = Infinity, hi = -Infinity;
  for (const m of list) {
    m.computeNormals();
    const b = m.bounds();
    lo = Math.min(lo, b.min[A.key]);
    hi = Math.max(hi, b.max[A.key]);
  }
  const height = hi - lo;

  if (!(height > 0)) {
    return { ok: false, reason: '這個物件沿切片軸沒有厚度，切不出東西。', axis };
  }

  const open = list.filter(m => !m.isClosed()).length;
  if (open) {
    /**
     * 開放曲面（板件）切下去得到的是斷掉的線串，不是封閉輪廓，
     * 沒辦法轉成「一片可以裁下來的板」。
     * 這裡不擋，但一定要講 —— 沉默地給一張接不起來的圖最糟。
     */
    warnings.push(`有 ${open} 個物件不是封閉的實體（是開放曲面），`
      + '剖面切出來的線接不成封閉輪廓。請先改成實體或做布林聯集。');
  }
  if (list.length > 1) {
    warnings.push(`一次切了 ${list.length} 個物件。若它們互相重疊，`
      + '重疊處會畫出兩圈線 —— 請先做布林聯集再切。');
  }

  const plan = planSlabs(height, opt.bands);
  const slices = [];
  let openTotal = 0;

  for (const s of plan.slabs) {
    const coord = lo + s.mid;
    const loops = [];
    let op = 0;
    for (const m of list) {
      const r = sectionAt(m, axis, coord);
      loops.push(...r.loops);
      op += r.open;
    }
    openTotal += op;
    slices.push({
      index: s.index,
      band: s.band,
      t: s.t,
      z0: lo + s.z0, z1: lo + s.z1,
      coord,
      loops,
      area: loops.reduce((a, l) => a + l.area, 0),
      open: op,
      bounds: loopsBounds(loops)
    });
  }

  if (openTotal > 0) {
    warnings.push(`有 ${openTotal} 條線接不成封閉輪廓，那些地方切不出可裁的片。`);
  }

  const empty = slices.filter(s => !s.loops.length).map(s => s.index);
  if (empty.length) {
    warnings.push(`第 ${listNums(empty)} 片切到空的地方（模型在那個高度沒有東西），`
      + '要嘛分段的總高超出模型，要嘛模型中間是斷開的。');
  }

  return {
    ok: true,
    axis,
    plan,
    slices,
    warnings,
    stats: {
      count: slices.length,
      height,
      used: plan.used,
      diff: plan.diff,
      area: slices.reduce((a, s) => a + s.area, 0),
      thickKinds: [...new Set(slices.map(s => r2(s.t)))].sort((a, b) => a - b)
    }
  };
}

/** 一疊片沿切片軸的總外框（排版與定位孔都要用） */
export function loopsBounds(loops) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const l of loops) {
    for (const p of l.pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (minX > maxX) return { minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0 };
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

/** 全部片合起來的外框 —— 定位孔要在這個範圍裡找 */
export function stackBounds(slices) {
  return loopsBounds(slices.flatMap(s => s.loops));
}

/**
 * 點在不在這一片的實心部分裡，離最近的邊有多遠。
 *
 * @returns {number} 正 ＝ 在料上，數字就是離邊界的距離；負 ＝ 在料外
 *
 * 用「射線交叉數」判斷內外（外輪廓逆時針、內孔順時針都一樣適用，
 * 因為內外只看穿過幾條邊，跟繞向無關），距離另外算。
 * 兩件事分開算比較笨，但**分開才驗得出來**：測試可以單獨盯
 * 「方塊中心到邊界 ＝ 一半」這種手算得出來的數字。
 */
export function insideDepth(loops, x, y) {
  let inside = false;
  let best = Infinity;

  for (const l of loops) {
    const pts = l.pts;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a.y > y) !== (b.y > y)) {
        const xx = a.x + (y - a.y) / (b.y - a.y) * (b.x - a.x);
        if (xx > x) inside = !inside;
      }
      const d = segDist(x, y, a.x, a.y, b.x, b.y);
      if (d < best) best = d;
    }
  }

  if (!isFinite(best)) return -Infinity;
  return inside ? best : -best;
}

function segDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const L = dx * dx + dy * dy;
  let t = L > 0 ? ((px - x1) * dx + (py - y1) * dy) / L : 0;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return Math.hypot(px - (x1 + dx * t), py - (y1 + dy * t));
}

/** 把 [1,2,3,7,8] 印成「1~3、7~8」——片一多，一長串數字沒人讀得完 */
export function listNums(ns) {
  if (!ns.length) return '';
  const out = [];
  let a = ns[0], b = ns[0];
  for (let i = 1; i <= ns.length; i++) {
    if (i < ns.length && ns[i] === b + 1) { b = ns[i]; continue; }
    out.push(a === b ? `${a}` : `${a}~${b}`);
    a = b = ns[i];
  }
  return out.join('、');
}

const r2 = v => Math.round(v * 100) / 100;
