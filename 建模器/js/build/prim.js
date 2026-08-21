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
  tube:     { rOuter: 25, rInner: 20, h: 70, seg: 32 },
  roundBox: { w: 60, h: 45, d: 40, r: 6, segR: 4 },
  plate:    { w: 100, d: 60, segW: 1, segD: 1 },
  bend:     {
    w: 60,           // 板寬（沿 Z）
    first: 40,       // 第一段長度
    arcSeg: 4,       // 每個折彎圓弧分幾段
    bends: [{ angle: 90, r: 2, len: 30 }]   // 一道折彎 ＝ L 型
  }
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
  tube: {
    label: '管',
    fields: [
      { key: 'rOuter', label: '外半徑', min: 0.1, step: 1 },
      { key: 'rInner', label: '內半徑', min: 0, step: 1 },
      { key: 'h',      label: '高',     min: 0.1, step: 1 },
      { key: 'seg',    label: '分段',   min: 3, max: 128, step: 1, int: true }
    ]
  },
  roundBox: {
    label: '圓角方塊',
    fields: [
      { key: 'w',    label: '寬 X',     min: 0.1, step: 1 },
      { key: 'h',    label: '高 Y',     min: 0.1, step: 1 },
      { key: 'd',    label: '深 Z',     min: 0.1, step: 1 },
      { key: 'r',    label: '圓角半徑', min: 0, step: 0.5 },
      { key: 'segR', label: '圓角分段', min: 1, max: 32, step: 1, int: true }
    ]
  },
  plate: {
    label: '平板',
    sheet: true,
    fields: [
      { key: 'w', label: '寬 X', min: 0.1, step: 1 },
      { key: 'd', label: '深 Z', min: 0.1, step: 1 }
    ]
  },
  bend: {
    label: '折板',
    sheet: true,
    /** bends（折彎序列）是動態長度的，面板另外處理，不放在 fields 裡 */
    fields: [
      { key: 'w',      label: '板寬 Z',   min: 0.1, step: 1 },
      { key: 'first',  label: '第一段長', min: 0.1, step: 1 },
      { key: 'arcSeg', label: '圓弧分段', min: 1, max: 24, step: 1, int: true }
    ],
    hasBends: true
  }
};

/** 這個基本體天生就是板件（要展開的東西），新增時直接設成 sheet */
export function isSheetPrim(type) {
  return !!(PRIM_SPECS[type] && PRIM_SPECS[type].sheet);
}

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
  },

  /**
   * 管（中空圓柱）。
   *
   * three.js 沒有現成的中空圓柱，自己接半邊結構反而更乾淨 ——
   * 不必經過三角形再焊回來，側面直接就是四邊形。
   *
   * 這個基本體還有一個附加用途：**交叉驗證布林**。
   * 參數直接算出來的體積，應該跟「大圓柱減小圓柱」布林出來的
   * 完全一致，對不上就代表其中一邊有問題。
   */
  tube(p) {
    const D = PRIM_DEFAULTS.tube;
    const ro = num(p.rOuter, D.rOuter);
    const ri = Math.max(0, Math.min(num(p.rInner, D.rInner), ro - 1e-4));
    const h = num(p.h, D.h);
    const n = int(p.seg, D.seg);

    // 內徑等於 0 就退化成實心圓柱，交給角柱那條路走
    if (ri < 1e-6) return BUILDERS.prism({ sides: n, r: ro, h });

    const y0 = -h / 2, y1 = h / 2;
    const pts = [];
    for (const [r, y] of [[ro, y1], [ro, y0], [ri, y1], [ri, y0]]) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r));
      }
    }
    const OT = 0, OB = n, IT = 2 * n, IB = 3 * n;   // 外上／外下／內上／內下

    const faces = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push([OT + i, OT + j, OB + j, OB + i]);   // 外側面
      faces.push([IT + j, IT + i, IB + i, IB + j]);   // 內側面（法向朝軸心）
      faces.push([OT + j, OT + i, IT + i, IT + j]);   // 頂部環
      faces.push([OB + i, OB + j, IB + j, IB + i]);   // 底部環
    }

    const m = Mesh.fromFaceList(pts, faces);
    m.autoMarkFolds();
    return m;
  },

  /**
   * 圓角方塊 ＝ 圓角矩形的斷面沿 Y 擠出。
   *
   * 只在四條垂直邊倒圓角，不做角落的球面。護罩、機櫃、機箱外觀
   * 幾乎都是這種形狀，而且**圓角是可展的圓柱面** ——
   * 第 3 期展開時可以精確攤平，是很好的驗證題材。
   */
  roundBox(p) {
    const D = PRIM_DEFAULTS.roundBox;
    const w = num(p.w, D.w), h = num(p.h, D.h), d = num(p.d, D.d);
    const segR = int(p.segR, D.segR, 1);
    // 圓角不能大於半個短邊，否則輪廓會自交
    const r = Math.max(0, Math.min(num(p.r, D.r), Math.min(w, d) / 2 - 1e-6));

    return extrudeProfile(roundRectProfile(w, d, r, segR), h);
  },

  /**
   * 折板 —— 第 3 期鈑金展開的主角。
   *
   * ── 為什麼做成「序列」而不是寫死 L 型／U 型 ────────
   * 實際的鈑金件常常折三、四道。寫死只能做兩種形狀，
   * 序列則是同一套邏輯涵蓋全部：
   *   L 型 ＝ 一道折彎
   *   U 型 ＝ 兩道同向折彎
   *   Z 型 ＝ 兩道反向折彎（角度一正一負）
   * 而且第 3 期展開讀的就是這個序列，不必再反推。
   *
   * ── 這是開放的面，不是實體 ──────────────────────────
   * 日誌第 3 個關鍵決定：板件用「面 ＋ 厚度屬性」描述。
   * 這裡產生的是**中性面**，厚度是 ModelObject 的屬性，
   * 畫面上的厚度由 mesh.shell() 在顯示時加上去。
   * 折彎半徑 r 指的也是中性面的半徑。
   *
   * ── 折線會自動標出來 ────────────────────────────────
   * 圓弧被分成 arcSeg 段，段與段之間不共面，
   * autoMarkFolds() 會把它們標成折線（fold）。
   * 這是半邊結構的「邊角色」欄位第一次真正派上用場。
   */
  bend(p) {
    const D = PRIM_DEFAULTS.bend;
    const w = num(p.w, D.w);
    const first = num(p.first, D.first);
    const arcSeg = int(p.arcSeg, D.arcSeg, 1);
    const bends = Array.isArray(p.bends) && p.bends.length ? p.bends : D.bends;

    // ── 先在 XY 平面走出斷面折線 ──
    let x = 0, y = 0;          // 目前位置
    let dx = 1, dy = 0;        // 目前方向
    const line = [[x, y]];

    const advance = len => {
      x += dx * len; y += dy * len;
      line.push([x, y]);
    };

    advance(first);

    for (const b of bends) {
      const deg = num(b && b.angle, 90);
      const rad = THREE.MathUtils.degToRad(deg);
      const r = Math.max(0, num(b && b.r, 0));
      const len = Math.max(0, num(b && b.len, 0));

      if (r > 1e-9 && Math.abs(rad) > 1e-9) {
        // 圓心在垂直於行進方向、朝轉彎那一側，距離 r
        const s = Math.sign(rad);
        const cx = x - dy * r * s;
        const cy = y + dx * r * s;
        const a0 = Math.atan2(y - cy, x - cx);

        for (let k = 1; k <= arcSeg; k++) {
          const a = a0 + (rad / arcSeg) * k;
          x = cx + Math.cos(a) * r;
          y = cy + Math.sin(a) * r;
          line.push([x, y]);
        }
      }

      // 轉向（半徑 0 就是尖角折）
      const c = Math.cos(rad), sn = Math.sin(rad);
      const ndx = dx * c - dy * sn;
      const ndy = dx * sn + dy * c;
      dx = ndx; dy = ndy;

      if (len > 0) advance(len);
    }

    // ── 沿 Z 擠成面（中性面，沒有厚度）──
    const pts = [];
    for (const [px, py] of line) pts.push(new THREE.Vector3(px, py, -w / 2));
    for (const [px, py] of line) pts.push(new THREE.Vector3(px, py, w / 2));

    const n = line.length;
    const faces = [];
    for (let i = 0; i < n - 1; i++) {
      faces.push([i, i + 1, i + 1 + n, i + n]);
    }

    const m = Mesh.fromFaceList(pts, faces);
    m.autoMarkFolds();
    return m;
  }
};

// ═══════════════════════════════════════════════════════
//  斷面工具
// ═══════════════════════════════════════════════════════

/**
 * 圓角矩形的輪廓點（在 XZ 平面，繞著中心一圈）。
 * r ＝ 0 就退化成四個直角。
 */
function roundRectProfile(w, d, r, segR) {
  const hw = w / 2, hd = d / 2;
  if (r < 1e-9) {
    return [[hw, hd], [-hw, hd], [-hw, -hd], [hw, -hd]];
  }

  const out = [];
  // 四個圓角的圓心與起始角度（角度以 (x, z) 為準）
  const corners = [
    [hw - r, hd - r, 0],
    [-hw + r, hd - r, 90],
    [-hw + r, -hd + r, 180],
    [hw - r, -hd + r, 270]
  ];

  for (const [cx, cz, a0] of corners) {
    for (let k = 0; k <= segR; k++) {
      const a = THREE.MathUtils.degToRad(a0 + (90 / segR) * k);
      out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
    }
  }
  return out;
}

/**
 * 把一個閉合的 XZ 斷面沿 Y 擠出，做成封閉實體。
 * 頂面與底面各留成一整片多邊形（不切成三角形），
 * 這樣平面區域合併之後看起來才乾淨。
 */
function extrudeProfile(profile, h) {
  const n = profile.length;
  const y0 = -h / 2, y1 = h / 2;

  const pts = [];
  for (const [px, pz] of profile) pts.push(new THREE.Vector3(px, y1, pz));
  for (const [px, pz] of profile) pts.push(new THREE.Vector3(px, y0, pz));

  const faces = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push([i, j, j + n, i + n]);           // 側面
  }
  faces.push([...Array(n).keys()].reverse());     // 頂面
  faces.push([...Array(n).keys()].map(i => i + n));   // 底面

  const m = Mesh.fromFaceList(pts, faces);
  m.autoMarkFolds();
  return m;
}

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
  // 深拷貝：折板的 bends 是陣列，淺拷貝會讓所有折板共用同一份
  return JSON.parse(JSON.stringify({ type, ...PRIM_DEFAULTS[type] }));
}

/** 折板預設的一道折彎，介面按「加一道」時用 */
export function defaultBend() {
  return { angle: 90, r: 2, len: 30 };
}

/**
 * 折板的展開總長（沿中性面量），單位 cm。
 *
 * ── 一定要用真正的弧長 ──────────────────────────────
 * 圓弧在網格上被切成 arcSeg 段直線，**弦長比弧長短**。
 * arcSeg=4、90 度彎時，弦長總和只有弧長的 99.4%。
 * 拿網格去量展開長度，每道折彎都會少算一點，
 * 折三道就差到零點幾公分 —— 雷切下去才發現就來不及了。
 *
 * 所以展開長度一律用 r × θ 算，這也是第 3 期出圖要用的數字。
 * （目前 r 指的是中性面半徑；等第 3 期做 K 因子時，
 *   中性面位置會改由板厚與 K 值決定，那時只要改這一個函式。）
 */
export function bendDevelopedLength(p) {
  const D = PRIM_DEFAULTS.bend;
  const bends = Array.isArray(p.bends) && p.bends.length ? p.bends : D.bends;
  let len = num(p.first, D.first);

  for (const b of bends) {
    const rad = Math.abs(THREE.MathUtils.degToRad(num(b && b.angle, 90)));
    const r = Math.max(0, num(b && b.r, 0));
    len += r * rad + Math.max(0, num(b && b.len, 0));
  }
  return len;
}

export const PRIM_TYPES = Object.keys(PRIM_DEFAULTS);
