/**
 * curved.js — 智慧分切第三步：格子曲面的整齊切法候選（長條／環帶／花瓣）（2026-10-13 → `規格\建模器-智慧分切.md`「第三步」）
 *
 * 只**列候選**（每一種 ＝ 一組要切的邊），⛔ 判斷好壞 —— 好壞交給 `propose.js` 用真的展開程式攤過再比。
 * ⛔ 改網格：只讀。邊一律用「頂點編號配對」當鑰匙（`clone()`／`transformed()` 都保持頂點順序 ⇒ 複製品上也對得到）。
 *
 * ── 找格子 ──────────────────────────────────────────────
 * 一塊曲面（`propose.js` 分出來的「塊」）裡任取一條邊，用分片模式現成的「同方向的全部」（`seamLoopEdges(…,'all')`）
 * 找出方向 A 的每一條線；再取一條跟它不同方向的邊，找出方向 B。⛔ 寫新的走訪。
 * 合起來蓋住這一塊大部分的邊 ⇒ 是格子曲面；否則 `null`（自由形狀，照第二步）。
 * 只找得到一個方向（圓柱側面只有一段高：每條直線就一格）⇒ `B` 是空的，只列長條。
 *
 * ── 候選（kang 2026-10-13 定的三種；「不加」由 `propose.js` 自己加）──────────
 *   · 長條／環帶：一個方向的線全切；線是繞一圈的 ⇒ 每一片會是一個環，再加切另一個方向的一條讓它攤得開
 *     （名稱：線兩頭收在一點（例如經線）叫「長條」，線繞一圈（例如緯線）叫「環帶」）
 *   · 花瓣：一個方向的線全切，但**每一條線留一格**在「花心」旁邊連著。花心 ＝ 線收在一起的那一點（極點），
 *     或另一個方向的某一條線（例如圓環的外圈）。尖端那一頭可以再切另一個方向的一條（不切／正中間／最遠），一朵分成兩朵
 *   🔴 **量到的兩條**（沙箱，規格第三步第 0 節）：每一條只能留**一格**（留兩格 ⇒ 那一點四周都連著，程式又要補剪）；
 *      球的花瓣只能停在極點前**一段**（⇒ 花心就是極點本身）
 */

import { edgeLoop, seamLoopEdges } from '../core/selectops.js';

/** 花心是「另一個方向的線」時最多試幾個位置 —— 圓環 12×32 全試會到上百次展開 */
const MAX_SPINES = 8;
/** 走線時不限「畫面上看得見的邊」（見 `gridOf` 裡的說明）*/
const LOOSE = { markableOnly: false };

/**
 * @param {Mesh} mesh
 * @param {Set<number>} faceIds 這一塊的面
 * @returns {null | {A: Loop[], B: Loop[]}}
 *   Loop ＝ `{ edges: {key, a, b}[], closed }`（a、b 是頂點 id；key 是頂點編號配對）
 */
export function gridOf(mesh, faceIds) {
  const idx = mesh._vertIndex();
  const key = h => { const a = idx.get(h.v.id), b = idx.get(h.to.id); return a < b ? `${a}-${b}` : `${b}-${a}`; };
  const inBlock = h => h.face && h.twin && h.twin.face && faceIds.has(h.face.id) && faceIds.has(h.twin.face.id);
  const edges = [...mesh.edges()].filter(inBlock);
  if (edges.length < 8) return null;
  /** 兩頭都是四價點、兩側都是四邊形的邊才當起點 —— 從球的極點那一圈（三角形）旁邊出發，「同方向的全部」只走得出一條 */
  const four = v => mesh.vertOutgoing(v).length === 4;
  const quad = f => mesh.faceLoop(f).length === 4;
  const good = h => four(h.v) && four(h.to) && quad(h.face) && quad(h.twin.face);

  const family = seed => {
    const loops = [];
    const seen = new Set();
    // ⚠ 從 seed 跟它的另一側各走一次：`edgeRing()` 沒繞成一圈時只走得了一頭（球的緯線只走到一半）
    // ⚠ `markableOnly: false`：每走一條都要重算一次「看得見的邊」，齒輪 20 塊曲面會算到 20 秒；而且這裡本來就只看這一塊裡的邊
    for (const e of [...seamLoopEdges(mesh, seed, 'all', LOOSE), ...seamLoopEdges(mesh, seed.twin, 'all', LOOSE)]) {
      if (!inBlock(e) || seen.has(key(e))) continue;
      const L = edgeLoop(mesh, e, LOOSE);
      const hes = L.hes.filter(inBlock);
      if (!hes.length) continue;
      for (const h of hes) seen.add(key(h));
      loops.push({ edges: hes.map(h => ({ key: key(h), a: h.v.id, b: h.to.id })), closed: L.closed && hes.length === L.hes.length });
    }
    return loops;
  };

  const seed = edges.find(good) || edges[0];
  const A = family(seed);
  if (A.length < 2) {
    // 圓錐側面只有一段高：每條邊都從尖端放射出去（走不出「同方向」）⇒ 每條自己是一條線，只列長條
    const apex = [edges[0].v.id, edges[0].to.id].find(v => edges.every(h => h.v.id === v || h.to.id === v));
    if (apex === undefined) return null;
    return { A: edges.map(h => ({ edges: [{ key: key(h), a: h.v.id, b: h.to.id }], closed: false })), B: [] };
  }
  const aKeys = new Set(A.flatMap(l => l.edges.map(e => e.key)));
  let seed2 = null;
  for (const f of [seed.face, seed.twin.face]) {
    for (const h of mesh.faceLoop(f)) if (inBlock(h) && !aKeys.has(key(h)) && good(h)) { seed2 = h; break; }
    if (seed2) break;
  }
  let B = seed2 ? family(seed2).filter(l => !l.edges.some(e => aKeys.has(e.key))) : [];
  if (B.length < 2) B = [];                                      // 只有一個方向（例如圓柱側面只有一段高）⇒ 只列長條
  const covered = aKeys.size + B.reduce((n, l) => n + l.edges.length, 0);
  if (covered < edges.length * 0.9) return null;                 // 蓋不住大部分 ⇒ ⛔ 是格子
  return { A, B };
}

/**
 * 列出這一塊的候選（兩個方向各一套）。
 * @returns {{kind: 'strip'|'band'|'petal', label: string, keys: Set<string>}[]}
 */
export function candidatesOf(grid) {
  const out = [];
  const seenSets = new Set();
  const add = (kind, label, keys) => {
    const s = new Set(keys);
    const sig = [...s].sort().join('|');
    if (seenSets.has(sig)) return;                                 // 兩種寫法剛好一樣 ⇒ 只留一份
    seenSets.add(sig);
    out.push({ kind, label, keys: s });
  };

  for (const [A, B] of grid.B.length ? [[grid.A, grid.B], [grid.B, grid.A]] : [[grid.A, []]]) {
    const allA = A.flatMap(l => l.edges.map(e => e.key));
    const closed = A.every(l => l.closed);
    const keysOf = l => l.edges.map(e => e.key);

    // ── 長條／環帶 ──
    if (!closed) add('strip', '長條', allA);
    else if (B.length) add('band', '環帶', [...allA, ...keysOf(B[0])]);
    if (!B.length) continue;

    // ── 花瓣 ──
    const loopOfVert = new Map();
    B.forEach((l, i) => l.edges.forEach(e => { loopOfVert.set(e.a, i); loopOfVert.set(e.b, i); }));
    const adj = B.map(() => new Set());
    for (const l of A) for (const e of l.edges) {
      const p = loopOfVert.get(e.a), q = loopOfVert.get(e.b);
      if (p !== undefined && q !== undefined && p !== q) { adj[p].add(q); adj[q].add(p); }
    }
    const bfs = starts => {
      const d = new Map(starts.map(s => [s, 1]));
      const queue = [...starts];
      while (queue.length) {
        const x = queue.shift();
        for (const y of adj[x]) if (!d.has(y)) { d.set(y, d.get(x) + 1); queue.push(y); }
      }
      return d;
    };
    /** 尖端那一頭再切哪一條：不切／正中間／最遠 */
    const tipsOf = (dist, spine) => {
      const maxD = Math.max(...dist.values());
      const at = want => [...dist.entries()].find(([i, d]) => d === want && i !== spine);
      const tips = [null];
      const mid = at(Math.round(maxD / 2)), far = at(maxD);
      if (mid) tips.push(mid[0]);
      if (far && (!mid || far[0] !== mid[0])) tips.push(far[0]);
      return tips;
    };
    /** `spine` ＝ 花心那條 B 線的編號（花心是極點時 ⇒ -1）—— 尖端那一刀⛔ 切在花心上 */
    const petal = (kept, dist, spine = -1) => {
      const keptSet = new Set(kept);
      const base = allA.filter(k => !keptSet.has(k));
      for (const t of tipsOf(dist, spine)) add('petal', '花瓣', t === null ? base : [...base, ...keysOf(B[t])]);
    };

    // 花心一：A 的線收在一起的那一點（三條以上的線以它為端點）—— 例如球的極點
    const ends = new Map();
    for (const l of A) {
      if (l.closed) continue;
      const deg = new Map();
      for (const e of l.edges) { deg.set(e.a, (deg.get(e.a) || 0) + 1); deg.set(e.b, (deg.get(e.b) || 0) + 1); }
      for (const [v, n] of deg) if (n === 1) ends.set(v, (ends.get(v) || 0) + 1);
    }
    //   每一個極點各當一次花心，有兩個以上 ⇒ 再試「全部一起」（球：南北兩朵花，赤道切開）
    //   每個極點都有一條線切到底（⛔ 留那一格）⇒ 極點那一圈三角形才攤得開（沙箱：補剪 0）
    const poles = [...ends].filter(([, n]) => n >= 3).map(([v]) => v);
    const spines = poles.map(v => [v]);
    if (poles.length > 1) spines.push(poles);
    for (const ps of spines) {
      const kept = [], first = new Set();
      for (const pole of ps) {
        let skipped = false;
        for (const l of A) for (const e of l.edges) {
          if (e.a !== pole && e.b !== pole) continue;
          const other = e.a === pole ? e.b : e.a;
          if (loopOfVert.has(other)) first.add(loopOfVert.get(other));
          if (!skipped) { skipped = true; continue; }
          kept.push(e.key);
        }
      }
      if (first.size) petal(kept, bfs([...first]));
    }

    // 花心二：B 的某一條線（例如圓環的外圈）—— 每條 A 線留「花心那一點往同一側鄰線」的那一格
    const step = Math.max(1, Math.ceil(B.length / MAX_SPINES));
    for (let s = 0; s < B.length; s += step) {
      const n1 = [...adj[s]][0];
      if (n1 === undefined) continue;
      const kept = [];
      for (const l of A) {
        const e = l.edges.find(x => {
          const p = loopOfVert.get(x.a), q = loopOfVert.get(x.b);
          return (p === s && q === n1) || (p === n1 && q === s);
        });
        if (e) kept.push(e.key);
      }
      if (kept.length) petal(kept, bfs([s]), s);
    }
  }
  return out;
}
