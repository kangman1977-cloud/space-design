/**
 * prim.js — 帶參數的基本體
 *
 * 每個基本體都是「一組參數 → 一個半邊網格」的函式。
 * 參數留在物件身上（存在 src），所以隨時可以改尺寸重新生成，
 * 這是參數化建模跟直接改網格最大的差別。
 *
 * ── 為什麼不直接用 three.js 的 BoxGeometry ──────────
 * 用了，但只當中間產物。three.js 的幾何體每個三角形各有各的頂點，
 * 位置一樣也是不同物件，沒有鄰接關係。
 * 一律走 Mesh.fromGeometry() 焊接成半邊結構之後才交出去。
 *
 * ── 分段數的取捨 ────────────────────────────────────
 * 圓柱的 seg 直接決定面數與展開後的片數。
 * 32 已經很圓，但如果要展開成鈑金，seg 就是實際要折的稜線數 ——
 * 那時候可能刻意只用 12 或 16。所以分段數是使用者參數，不是寫死的常數。
 *
 * 單位一律 cm。
 */

import * as THREE from 'three';
import { Mesh } from '../core/mesh.js';

/** 每種基本體的預設參數，介面直接拿這個當表單初值 */
export const PRIM_DEFAULTS = {
  box:      { w: 60, h: 45, d: 40 },
  cylinder: { r: 25, h: 70, seg: 32, openEnded: false },
  cone:     { rTop: 0, rBottom: 30, h: 70, seg: 32, openEnded: false },
  sphere:   { r: 30, segW: 32, segH: 16 },
  prism:    { sides: 6, r: 30, h: 60 },
  plate:    { w: 100, d: 60, segW: 1, segD: 1 }
};

/** 給介面用的清單：標籤、可調欄位、範圍 */
export const PRIM_SPECS = {
  box: {
    label: '方塊',
    fields: [
      { key: 'w', label: '寬 X', min: 0.1, step: 1 },
      { key: 'h', label: '高 Y', min: 0.1, step: 1 },
      { key: 'd', label: '深 Z', min: 0.1, step: 1 }
    ]
  },
  cylinder: {
    label: '圓柱',
    fields: [
      { key: 'r',   label: '半徑', min: 0.1, step: 1 },
      { key: 'h',   label: '高',   min: 0.1, step: 1 },
      { key: 'seg', label: '分段', min: 3, max: 128, step: 1, int: true }
    ]
  },
  cone: {
    label: '錐體',
    fields: [
      { key: 'rTop',    label: '上半徑', min: 0, step: 1 },
      { key: 'rBottom', label: '下半徑', min: 0, step: 1 },
      { key: 'h',       label: '高',     min: 0.1, step: 1 },
      { key: 'seg',     label: '分段',   min: 3, max: 128, step: 1, int: true }
    ]
  },
  sphere: {
    label: '球',
    fields: [
      { key: 'r',    label: '半徑', min: 0.1, step: 1 },
      { key: 'segW', label: '經線', min: 3, max: 128, step: 1, int: true },
      { key: 'segH', label: '緯線', min: 2, max: 64,  step: 1, int: true }
    ]
  },
  prism: {
    label: '角柱',
    fields: [
      { key: 'sides', label: '邊數',   min: 3, max: 64, step: 1, int: true },
      { key: 'r',     label: '外接圓', min: 0.1, step: 1 },
      { key: 'h',     label: '高',     min: 0.1, step: 1 }
    ]
  },
  plate: {
    label: '平板',
    fields: [
      { key: 'w', label: '寬 X', min: 0.1, step: 1 },
      { key: 'd', label: '深 Z', min: 0.1, step: 1 }
    ]
  }
};

// ═══════════════════════════════════════════════════════

/** three.js 幾何體 → 半邊網格。所有基本體的共同出口。 */
function toMesh(geometry) {
  const m = Mesh.fromGeometry(geometry);
  geometry.dispose();
  m.autoMarkFolds();        // 稜線先標成折線，之後由材料規則覆蓋
  return m;
}

const num = (v, dflt) => (Number.isFinite(+v) ? +v : dflt);
const int = (v, dflt, min = 3) => Math.max(min, Math.round(num(v, dflt)));

const BUILDERS = {
  box(p) {
    const d = PRIM_DEFAULTS.box;
    return toMesh(new THREE.BoxGeometry(
      num(p.w, d.w), num(p.h, d.h), num(p.d, d.d)
    ));
  },

  cylinder(p) {
    const d = PRIM_DEFAULTS.cylinder;
    const r = num(p.r, d.r);
    return toMesh(new THREE.CylinderGeometry(
      r, r, num(p.h, d.h), int(p.seg, d.seg), 1, !!p.openEnded
    ));
  },

  cone(p) {
    const d = PRIM_DEFAULTS.cone;
    // 半徑 0 會產生退化三角形，給一個極小值讓拓撲保持乾淨
    const rt = Math.max(num(p.rTop, d.rTop), 1e-4);
    const rb = Math.max(num(p.rBottom, d.rBottom), 1e-4);
    return toMesh(new THREE.CylinderGeometry(
      rt, rb, num(p.h, d.h), int(p.seg, d.seg), 1, !!p.openEnded
    ));
  },

  sphere(p) {
    const d = PRIM_DEFAULTS.sphere;
    return toMesh(new THREE.SphereGeometry(
      num(p.r, d.r), int(p.segW, d.segW), int(p.segH, d.segH, 2)
    ));
  },

  /** 角柱 ＝ 分段數很少的圓柱。六角柱、八角柱在鈑金件很常見。 */
  prism(p) {
    const d = PRIM_DEFAULTS.prism;
    const r = num(p.r, d.r);
    return toMesh(new THREE.CylinderGeometry(
      r, r, num(p.h, d.h), int(p.sides, d.sides), 1, false
    ));
  },

  /** 平板 ＝ 開放的單面，沒有厚度。板件（sheet）的預設起點。 */
  plate(p) {
    const d = PRIM_DEFAULTS.plate;
    const g = new THREE.PlaneGeometry(
      num(p.w, d.w), num(p.d, d.d),
      int(p.segW, d.segW, 1), int(p.segD, d.segD, 1)
    );
    g.rotateX(-Math.PI / 2);        // 讓它平躺在地面上，而不是站著
    return toMesh(g);
  }
};

/**
 * 依參數生成網格。
 * @param {string} type PRIM_DEFAULTS 裡的鍵
 * @param {object} params
 * @returns {Mesh}
 */
export function buildPrim(type, params = {}) {
  const fn = BUILDERS[type];
  if (!fn) throw new Error(`不認得的基本體類型：${type}`);
  return fn(params);
}

/** 產生一組帶預設值的參數（含 type，可直接當 src 用） */
export function defaultSrc(type) {
  if (!PRIM_DEFAULTS[type]) throw new Error(`不認得的基本體類型：${type}`);
  return { type, ...PRIM_DEFAULTS[type] };
}

export const PRIM_TYPES = Object.keys(PRIM_DEFAULTS);
