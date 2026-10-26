/**
 * shellBoss.js — 薄殼接縫的內側墊塊（第三輪第五批 5c ④-5）
 *
 * 🔴 kang 2026-10-26「5c 照你的建議：① 乙 殼的內側加墊塊 ② 甲 預設開、切塊頁一格可以取消」
 * （→ `實驗-綜合評估-第三輪.md`「第五批 5c」、規格 `規格\建模器-STL匯出.md`「薄殼的接面加內側墊塊」）。
 *
 * 為什麼：最小的銷 ⌀1.75 也要「⌀ ＋ 每邊間隙 ＋ 每邊料」≈ 4 mm 寬才放得下 ⇒ 3 mm 以下的殼哪裡都放不下
 * （T16 頭盔 3 mm 只放得進稜線、兩側和帽簷沒對位；T18 燈罩 2 mm 20 個接面全部只能黏）。
 * 做法：每一刀的斷面上、殼太薄放不下銷的那幾段，在殼的**內側**加小圓柱（橫跨刀面），銷直接打在墊塊中心。
 *
 * | 規則 | 做法 |
 * |---|---|
 * | 放哪 | 每一刀、每一個接面（刀面被別的刀分成的格子）裡、每一圈輪廓上**殼外側那一面**（往裡面 ＝ 朝物件中心）、殼厚不到「最小那一號放得下的寬」的那幾點；這一段總長的 1/4、3/4 各一個（那一點會凸出殼外 ⇒ 往中間找最近的、不凸的那一點）|
 * | 墊塊多大 | 照「墊塊用的那一號」（勾了放不下換小一號 ⇒ ⌀3；沒勾 ⇒ 主要那一號）：半徑 ＝ 孔半徑＋孔外的料＋0.1 mm、長 ＝ 兩邊孔深各多 1 mm；那一號放不下（斜的殼面凸出去、或退了碰不到殼）⇒ 換最小那一號（⌀1.75）再試 |
 * | ⛔ 凸出殼外 | 墊塊外緣離殼外面往內 0.5 mm 起；墊塊表面往遠離物件中心射線、一個面都沒打到 ＝ 在殼外面 ⇒ 再往內退 0.5 mm，退到 3 mm 還凸就不放（講幾個）|
 * | ⛔ 離開殼 | 往內退之後墊塊跟殼至少要重疊 0.5 mm（`minOverlap`）—— 本機抓到：燈罩斜的那一段退了 2.5 mm、殼只有 2 mm ⇒ 墊塊整個離開殼、切開變成 8 塊飄著的小碎塊 |
 * | 避開 | 離別的刀太近（同 `crossBand()`）、離已經放好的銷不到 2 cm 的不放 |
 * | 銷 | 直接打在墊塊中心（沙箱：交給原本挑銷的方法常常只挑中一個墊塊）|
 *
 * 沙箱 `輸出\第三輪第五批研究\b5c_probe.mjs`：頭盔 4 個接面都有、燈罩 20 個都有、碗 4 個都有；凸出殼外 0。單位 cm、世界座標。
 */

import * as THREE from 'three';
import { dowelMesh } from '../build/bool.js';
import { dowelTries, crossBand, CUT_UV_OF } from './bedCut.js';
import { sectionAt, AXES } from '../slice/section.js';

const KEYS = ['x', 'y', 'z'];
export const BOSS = { stepIn: 0.05, maxIn: 0.3, extraR: 0.01, extraLen: 0.1, nearDowel: 2, sample: 0.25, minOverlap: 0.05 };

/** 墊塊用哪一號：勾了放不下換小一號 ⇒ 第二號（⌀3）；沒勾 ⇒ 主要那一號 */
export function bossSpec(d) {
  const tries = dowelTries(d);
  return tries.length > 1 ? tries[1] : tries[0];
}
/** 孔半徑＋孔外的料（cm）—— 同 `bedCut.js` `keepOf()` */
export const keepOf = s => (s.dMM / 2 + s.clearMM + s.wallMM) / 10;

/** 射線檢查用：把網格做成 three 的 Mesh */
function rayMesh(mesh) {
  const pos = [];
  for (const f of mesh.faces) {
    const vs = mesh.faceVerts(f).map(v => v.p);
    for (let i = 1; i + 1 < vs.length; i++) pos.push(vs[0].x, vs[0].y, vs[0].z, vs[i].x, vs[i].y, vs[i].z, vs[i + 1].x, vs[i + 1].y, vs[i + 1].z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
}

/** 墊塊表面上的點往遠離物件中心射出去（只在刀面那個平面的方向），一個面都沒打到 ⇒ 那一點在殼外面 */
function pokesOut(obj, cen, s, r, half) {
  const rc = new THREE.Raycaster();
  const ax = [0, 0, 0]; ax[s.a] = 1;
  const e1 = s.a === 0 ? [0, 1, 0] : [1, 0, 0];
  const e2 = [ax[1] * e1[2] - ax[2] * e1[1], ax[2] * e1[0] - ax[0] * e1[2], ax[0] * e1[1] - ax[1] * e1[0]];
  const p = new THREE.Vector3(), dir = new THREE.Vector3();
  for (const h of [-half, -half / 2, 0, half / 2, half]) for (let k = 0; k < 16; k++) {
    const t = k / 16 * 2 * Math.PI;
    p.set(...[0, 1, 2].map(j => s.p[j] + ax[j] * h + r * (Math.cos(t) * e1[j] + Math.sin(t) * e2[j])));
    dir.copy(p).sub(cen); dir.setComponent(s.a, 0);
    if (dir.length() < 1e-9) continue;
    dir.normalize();
    rc.set(p, dir); rc.far = 1e4;
    if (!rc.intersectObject(obj).length) return true;
  }
  return false;
}

/** 2D：從 (px, py) 沿 n 走，打到輪廓（別的邊）的最近距離 ⇒ 那一點的殼厚 */
function thicknessAt(loops, px, py, n, skip) {
  let best = Infinity;
  for (const L of loops) {
    const P = L.pts;
    for (let i = 0; i < P.length; i++) {
      if (L === skip.L && i === skip.i) continue;
      const a = P[i], b = P[(i + 1) % P.length];
      const ex = b.x - a.x, ey = b.y - a.y, den = n[0] * ey - n[1] * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((a.x - px) * ey - (a.y - py) * ex) / den, u = ((a.x - px) * n[1] - (a.y - py) * n[0]) / den;
      if (t > 1e-6 && u >= 0 && u <= 1 && t < best) best = t;
    }
  }
  return best;
}

/**
 * 墊塊放哪。
 * @param {Mesh} mesh 世界座標（跟 `openCut()` 同一份）
 * @param {number[][]} cuts 三個軸的刀  @param {{min:number[],max:number[]}} bb 外框
 * @param {object} d 銷的設定（`DOWEL` 那一包）  @param {{a:number,p:number[]}[]} [dowels] 已經放好的銷（離它不到 2 cm 的不放）
 * @returns {{spots:{a:number,c:number,p:number[],ins:number,thick:number,joint:string}[], skipped:number, spec:object, r:number, half:number}}
 */
export function planBosses(mesh, cuts, bb, d, dowels = []) {
  const spec = bossSpec(d), tries = dowelTries(d);
  const keep = keepOf(spec), keepMin = Math.min(...tries.map(keepOf));
  const r = keep + BOSS.extraR, half = spec.depthMM / 10 + BOSS.extraLen;
  /** 先用墊塊那一號；放不下再換最小那一號（勾了放不下換小一號才有）*/
  const sizes = [spec, ...(tries.length > 2 && tries[tries.length - 1] !== spec ? [tries[tries.length - 1]] : [])]
    .map(sp => ({ spec: sp, keep: keepOf(sp), r: keepOf(sp) + BOSS.extraR, half: sp.depthMM / 10 + BOSS.extraLen }));
  const band = crossBand(tries, spec);
  const cen = new THREE.Vector3(...[0, 1, 2].map(k => (bb.min[k] + bb.max[k]) / 2));
  let obj = null;
  const spots = []; let skipped = 0;
  for (let a = 0; a < 3; a++) for (const c of cuts[a] || []) {
    const A = AXES[KEYS[a]], [U, W] = A.uv;
    const to3 = (u, v) => { const p = [0, 0, 0]; p[a] = c; for (let k = 0; k < 3; k++) if (k !== a) p[k] += u * U[k] + v * W[k]; return p; };
    const cu = U.reduce((s, w, k) => s + w * cen.getComponent(k), 0), cv = W.reduce((s, w, k) => s + w * cen.getComponent(k), 0);
    const cellOf = q3 => [0, 1, 2].filter(b => b !== a).map(b => (cuts[b] || []).filter(cb => q3[b] > cb).length).join(',');
    const sec = sectionAt(mesh, KEYS[a], c);
    sec.loops.forEach((L, li) => {
      const P = L.pts, n = P.length;
      if (n < 3) return;
      let ar = 0; for (let i = 0; i < n; i++) { const p = P[i], q = P[(i + 1) % n]; ar += p.x * q.y - q.x * p.y; }
      const ccw = ar > 0;
      const groups = new Map();
      for (let i = 0; i < n; i++) {
        const p = P[i], q = P[(i + 1) % n];
        const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy);
        if (len < 1e-9) continue;
        const nin = ccw ? [-dy / len, dx / len] : [dy / len, -dx / len];          // 往輪廓裡面（料那一邊）
        for (let s = 0; s < len; s += BOSS.sample) {
          const px = p.x + dx * s / len, py = p.y + dy * s / len;
          if (nin[0] * (cu - px) + nin[1] * (cv - py) <= 0) continue;              // 只要殼外側那一面（往裡面 ＝ 朝物件中心）
          const thick = thicknessAt(sec.loops, px, py, nin, { L, i });
          if (!(thick < 2 * keepMin)) continue;                                      // 放得下最小那一號 ⇒ 交給原本的銷
          const q3 = to3(px + nin[0] * keep, py + nin[1] * keep);
          let near = false;
          for (let b = 0; b < 3; b++) if (b !== a) for (const cb of cuts[b] || []) if (Math.abs(q3[b] - cb) < band) near = true;
          for (const dw of dowels) if (dw.a === a && Math.hypot(dw.p[0] - q3[0], dw.p[1] - q3[1], dw.p[2] - q3[2]) < BOSS.nearDowel) near = true;
          if (near) continue;
          const k = li + '|' + cellOf(q3);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push({ px, py, nin, thick, joint: `${a}|${c}|${cellOf(q3)}` });
        }
      }
      for (const cand of groups.values()) {
        if (cand.length < 2) continue;
        const used = [];
        for (const f of [0.25, 0.75]) {
          if (!obj) obj = rayMesh(mesh);
          /** 1/4、3/4 那一點會凸出殼外 ⇒ 往這一段的中間找（最多試 12 個點，每個點從 0.5 mm 往內退到 3 mm）；兩個⛔ 擠在一起 */
          const i0 = Math.min(cand.length - 1, Math.floor(f * cand.length)), mid = (cand.length - 1) / 2;
          const order = [];
          for (let k = 0; order.length < 12 && k < cand.length; k++) { const i = Math.round(i0 + (mid - i0) * k / Math.max(1, cand.length / 2)); if (!order.includes(i)) order.push(i); }
          let ok = null;
          for (const z of sizes) {
            for (const i of order) {
              const m = cand[i];
              for (let ins = BOSS.stepIn; ins <= BOSS.maxIn + 1e-9 && ins <= m.thick - BOSS.minOverlap + 1e-9 && !ok; ins += BOSS.stepIn) {
                const s = { a, c, p: to3(m.px + m.nin[0] * (z.keep + ins), m.py + m.nin[1] * (z.keep + ins)), ins, thick: m.thick, joint: m.joint, spec: z.spec, r: z.r, half: z.half };
                if (used.some(u => Math.hypot(u.p[0] - s.p[0], u.p[1] - s.p[1], u.p[2] - s.p[2]) < u.r + s.r + 0.2)) break;
                if (!pokesOut(obj, cen, s, z.r, z.half)) ok = s;
              }
              if (ok) break;
            }
            if (ok) break;
          }
          if (ok) { spots.push(ok); used.push(ok); } else skipped++;
        }
      }
    });
  }
  return { spots, skipped, spec, r, half };
}

/** 一個墊塊的網格（世界座標）：沿刀的軸、中心在 `s.p`；大小照它自己那一號（`s.r`、`s.half`）*/
export function bossMesh(s, r = s.r, half = s.half) {
  const m = dowelMesh(s.r || r, 2 * (s.half || half), [0, 0, 0]);
  const M = new THREE.Matrix4();
  if (s.a === 0) M.makeRotationZ(-Math.PI / 2); else if (s.a === 2) M.makeRotationX(Math.PI / 2);
  M.setPosition(...s.p);
  return m.transformed(M);
}

/** 墊塊裡的銷（跟 `placeDowels()` 的一樣格式）：打在墊塊中心 */
export function bossDowels(plan) {
  return plan.spots.map(x => { const s = x.spec || plan.spec; return { a: x.a, p: x.p.slice(), dMM: s.dMM, r: (s.dMM / 2 + s.clearMM) / 10, depth: s.depthMM / 10, boss: true }; });
}

/**
 * 接面加上墊塊：每一個墊塊算進它所在的那一個接面（同一刀、格子裡）—— `boss` 幾個、`covered` 有銷或有墊塊。
 * @param {{a:number,c:number,cell:number[],dowels:number,noRoom:number}[]} joints `placeDowels()` 的
 */
export function withBosses(joints, plan) {
  const out = joints.map(j => ({ ...j, boss: 0 }));
  for (const s of plan.spots) {
    const [ua, va] = CUT_UV_OF[s.a], u = s.p[ua], v = s.p[va];
    const j = out.find(x => x.a === s.a && Math.abs(x.c - s.c) < 1e-9 && x.cell && u >= x.cell[0] && u <= x.cell[2] && v >= x.cell[1] && v <= x.cell[3]);
    if (j) j.boss++;
  }
  for (const j of out) j.covered = j.dowels > 0 || j.boss > 0;
  return out;
}

/** 墊塊往殼裡面凸多少（mm）：外緣在殼外面往內 ins、直徑 2r ⇒ 凸 ins ＋ 2r − 殼厚 */
export const bossInwardMM = (x, r) => Math.max(0, (x.ins + 2 * (x.r || r) - x.thick) * 10);
