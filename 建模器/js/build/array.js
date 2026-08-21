/**
 * array.js — 陣列與鏡射
 *
 * ── 為什麼做成「修飾器」而不是直接複製出 N 個物件 ──
 * 因為公司真正要的是備料。
 *
 * 一個料架有 12 支一樣的橫料。第 3 期展開的時候，應該出
 * 「**一張圖 ×12**」，不是 12 張長得一模一樣的圖。
 * 這跟組裝系統結構說明表的「套數」是同一個概念。
 *
 * 反過來說，如果一開始就複製成 12 個獨立物件，事後要認出
 * 「這 12 個其實是同一件」就得去比對幾何，很難做對。
 * 資訊只能往下走，所以從資訊多的那一端開始，再提供「打散」。
 *
 * ── 資料形狀（跟布林同一套，所以能互相巢狀）──────────
 *
 *   {
 *     type: 'array',
 *     mode: 'linear' | 'radial' | 'mirror',
 *     child: { src, pos:[x,y,z], rot:[x,y,z], scale:[x,y,z], name },
 *
 *     // linear：兩個方向，散熱孔的 8×4 網格就是這樣來的
 *     count: 3,  step:  [50, 0, 0],
 *     count2: 1, step2: [0, 0, 50],
 *
 *     // radial：法蘭螺栓孔、輪盤
 *     count: 8, axis: 'y', angle: 360, center: [0, 0, 0],
 *
 *     // mirror：機箱左右側板
 *     axis: 'x', offset: 0, keepOriginal: true
 *   }
 *
 * child.src 本身可以是 bool 或 array，所以「挖好孔再排成一排」、
 * 「一排孔再拿去挖穿板子」都做得到。
 *
 * ── 這個檔案不碰 Manifold ────────────────────────────
 * 副本要聯集，但函式庫只准 bool.js 接觸（日誌「四個關鍵決定」第 4 條）。
 * 所以這裡呼叫 bool.js 開出來的 unionMeshes()。
 *
 * 單位一律 cm，角度欄位存「度」（存檔看得懂比較重要）。
 */

import * as THREE from 'three';
import { Mesh } from '../core/mesh.js';
import { unionMeshes, itemMatrix } from './bool.js';

export const ARRAY_MODES = {
  LINEAR: 'linear',
  RADIAL: 'radial',
  MIRROR: 'mirror'
};

export const ARRAY_LABEL = {
  linear: '線性陣列',
  radial: '環形陣列',
  mirror: '鏡射'
};

export const AXES = ['x', 'y', 'z'];
const AXIS_INDEX = { x: 0, y: 1, z: 2 };

/** 每種模式的預設值。介面拿這個當表單初值。 */
export const ARRAY_DEFAULTS = {
  linear: { count: 3, step: [50, 0, 0], count2: 1, step2: [0, 0, 50] },
  radial: { count: 8, axis: 'y', angle: 360, center: [0, 0, 0] },
  mirror: { axis: 'x', offset: 0, keepOriginal: true }
};

export function isArraySrc(src) {
  return !!src && src.type === 'array';
}

// ═══════════════════════════════════════════════════════
//  排列的位置（純幾何，不碰函式庫，所以測得到）
// ═══════════════════════════════════════════════════════

const num = (v, d) => (Number.isFinite(+v) ? +v : d);
const cnt = (v, d, min = 1) => Math.max(min, Math.round(num(v, d)));
const vec3 = (a, d) => (Array.isArray(a) && a.length === 3
  ? a.map((x, i) => num(x, d[i])) : d.slice());

/**
 * 算出每一份副本的擺放矩陣。第一個永遠是原件（單位矩陣）。
 *
 * 這是整個陣列功能的核心，而且是純數學 —— 抽出來就能在 Node 裡
 * 對答案，不必開瀏覽器。
 *
 * @returns {THREE.Matrix4[]}
 */
export function arrayMatrices(node) {
  switch (node.mode) {
    case ARRAY_MODES.RADIAL: return radialMatrices(node);
    case ARRAY_MODES.MIRROR: return mirrorMatrices(node);
    default:                 return linearMatrices(node);
  }
}

/** 總共會有幾份。展開與備料要靠它算數量。 */
export function copyCount(node) {
  return arrayMatrices(node).length;
}

function linearMatrices(node) {
  const d = ARRAY_DEFAULTS.linear;
  const n1 = cnt(node.count, d.count);
  const n2 = cnt(node.count2, d.count2);
  const s1 = vec3(node.step, d.step);
  const s2 = vec3(node.step2, d.step2);

  const out = [];
  for (let j = 0; j < n2; j++) {
    for (let i = 0; i < n1; i++) {
      out.push(new THREE.Matrix4().makeTranslation(
        s1[0] * i + s2[0] * j,
        s1[1] * i + s2[1] * j,
        s1[2] * i + s2[2] * j
      ));
    }
  }
  return out;
}

/**
 * 環形陣列。
 *
 * 「總角度」的兩種情形要分開，不然使用者會覺得少一個或多一個：
 *   整圈 360°：間隔 ＝ 360 / 份數（頭尾是同一個位置，不能重複放）
 *   不足一圈：間隔 ＝ 總角度 / (份數−1)（頭尾都要放，例如 180° 放 5 份
 *             會落在 0 45 90 135 180）
 */
function radialMatrices(node) {
  const d = ARRAY_DEFAULTS.radial;
  const n = cnt(node.count, d.count, 1);
  const total = num(node.angle, d.angle);
  const c = vec3(node.center, d.center);
  const k = AXIS_INDEX[node.axis] ?? AXIS_INDEX[d.axis];

  const isFull = Math.abs(Math.abs(total) - 360) < 1e-9;
  const stepDeg = n <= 1 ? 0 : (isFull ? total / n : total / (n - 1));

  const toCenter = new THREE.Matrix4().makeTranslation(c[0], c[1], c[2]);
  const back = new THREE.Matrix4().makeTranslation(-c[0], -c[1], -c[2]);

  const out = [];
  for (let i = 0; i < n; i++) {
    const rad = THREE.MathUtils.degToRad(stepDeg * i);
    const rot = new THREE.Matrix4();
    if (k === 0) rot.makeRotationX(rad);
    else if (k === 1) rot.makeRotationY(rad);
    else rot.makeRotationZ(rad);

    // 先移到旋轉中心 → 轉 → 移回去
    out.push(new THREE.Matrix4().multiplyMatrices(toCenter,
      new THREE.Matrix4().multiplyMatrices(rot, back)));
  }
  return out;
}

/**
 * 鏡射。對稱面垂直於指定軸、位在 axis ＝ offset 的地方。
 *
 * 鏡射矩陣的行列式是負的，面的繞向會整個翻過來 ——
 * 那是 mesh.transformed() 負責處理的（它偵測到就把頂點順序倒過來），
 * 這裡只管算矩陣。
 *
 * offset 預設 0，也就是以物件自己的中心為對稱面，
 * 跟布林運算元的座標規則一致（都相對物件本身，不是世界原點）。
 */
function mirrorMatrices(node) {
  const d = ARRAY_DEFAULTS.mirror;
  const k = AXIS_INDEX[node.axis] ?? AXIS_INDEX[d.axis];
  const offset = num(node.offset, d.offset);

  const out = [];
  if (node.keepOriginal !== false) out.push(new THREE.Matrix4());

  // x' = 2×offset − x：先鏡射（乘 −1）再平移 2×offset
  const s = [1, 1, 1]; s[k] = -1;
  const t = [0, 0, 0]; t[k] = 2 * offset;

  out.push(new THREE.Matrix4()
    .makeTranslation(t[0], t[1], t[2])
    .multiply(new THREE.Matrix4().makeScale(s[0], s[1], s[2])));

  return out;
}

// ═══════════════════════════════════════════════════════
//  求值
// ═══════════════════════════════════════════════════════

/**
 * 把一棵陣列樹算成網格。
 *
 * @param {object}   node       {type:'array', mode, child, ...}
 * @param {Function} buildChild (src) => Mesh，由 io.js 提供。
 *                              跟布林同樣的做法：這個檔案不必認識
 *                              box / cylinder / bool 是什麼。
 * @returns {Mesh}
 */
export function evalArrayTree(node, buildChild) {
  if (!isArraySrc(node)) throw new Error('這不是陣列');
  if (!node.child || !node.child.src) throw new Error('陣列沒有指定要複製什麼');

  const mats = arrayMatrices(node);
  if (!mats.length) throw new Error('陣列的份數是 0');

  // 只算一次原件，其餘都是同一份網格套不同矩陣
  const base = buildChild(node.child.src).transformed(itemMatrix(node.child));

  if (mats.length === 1) return base;

  const label = node.child.name || '原件';
  const copies = mats.map(m => base.transformed(m));

  /**
   * 實體與板件要分開處理，而且不是為了遷就函式庫，是因為**語意不同**：
   *
   *   實體 → 布林聯集。兩份重疊的地方只能算一次，接縫也要真的縫起來。
   *   板件 → 直接拼在一起，不合併。12 片一樣的側板就是 12 片，
   *          展開時要分開出圖；黏成一體反而讓第 3 期分不出來。
   *          板件是開放的面，本來也就沒有內外之分可以做布林。
   *
   * 判斷依據就是網格封不封閉，不是物件的 kind ——
   * kind 是使用者可以改的標籤，封閉與否才是幾何事實。
   */
  if (!base.validate().closed) return Mesh.merge(copies);

  return unionMeshes(copies, copies.map((_, i) => `${label} 第 ${i + 1} 份`));
}

/**
 * 建立一份預設的陣列參數（給介面切換模式時用）。
 * 已經有的欄位保留下來，這樣線性切到環形再切回來，數量不會被重設。
 */
export function withMode(node, mode) {
  return {
    ...ARRAY_DEFAULTS[mode],
    ...node,
    type: 'array',
    mode
  };
}
