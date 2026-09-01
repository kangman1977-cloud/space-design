/**
 * revolve.js — 一條輪廓**繞一根軸轉一圈**，掃成網格
 * （＝ Blender 的 `Spin`，官方自己說它「常被稱為 lathe／車床工具」）
 *
 * 做出來的是碗、罩、瓶、燈罩、圓頂、輪圈、環 ——
 * 🔴 **這一整類在 2026-09-02 之前⛔ 建不出來**：`擠出` 只會沿直線長、⛔ 不會轉。
 *
 * ── ⭐ 它跟 `螺旋` 是同一個地基 ─────────────────────────
 * `螺旋（Screw）` ＝ 這一支 ＋ 一個「每轉一圈往上走多少」的欄位（`rise`）。
 * **`rise` ＝ 0 就是旋轉成形。** ⛔ 所以不要為螺旋另寫一支
 * 〔kang 2026-09-02 看過互動圖確認：「原來如此」〕。
 * ⚠ 這一輪**⛔ 沒有做 `rise`**，但參數位置留著，⛔ 不是忘了。
 *
 * ── 🔴 這一輪⛔ 沒有做的（⛔ 不要當成有）───────────────
 * **只轉半圈（`angle` < 360）＋ 兩端封口** —— kang 拍板要做，但排第 2 階段。
 * ⛔ 本檔目前**一律轉滿一圈**。
 *
 * ── 🔴🔴 側牆的繞向：⛔ 不可以照抄 `extrudeFace()` ───────────
 * 〔權威版在 `規格\建模器-點線面編輯.md`「側牆的繞向 ⛔ 不可以照抄 `extrudeFace()`」〕
 * ⭐ **而這一支的繞向⛔ 不靠推理，靠對答案**：測試盯著
 * 「**體積 ＝ 帕普斯定理算出來的值，而且是正的**」。
 * ⚠ `extrude.js` 檔頭記著同一個坑：法向朝內的模型**畫面上看起來完全正常**，
 * 只有匯出 STL 的列印前檢查才抓得到。
 *
 * ── ⚠ 極點：輪廓的端點落在軸上時，那一圈退化成【一個點】───
 * 碗底、圓頂的尖 —— 那裡**只放一個頂點**，四邊形退化成三角形。
 * 🔴 **⛔ 不可以照放 seg 個重疊的點**：那是 seg 個獨立頂點疊在一起，
 * 網格會變成非流形，而**畫面上看起來一模一樣**。
 *
 * 單位 cm。⛔ 不碰 DOM，Node 裡測得到。
 */

import * as THREE from 'three';
import { Mesh } from '../core/mesh.js';

/** ⚠ `seg` 照 `prim.js` 的 `PRIM_DEFAULTS.cylinder.seg` 抄，⛔ 不自己填一個數字 */
export const REVOLVE_DEFAULTS = { seg: 32 };

/** 落在軸上算「同一個點」的容許值（cm）。⚠ 跟 `mergeCoplanarFaces` 的 1 微米同一個數量級 */
const ON_AXIS_TOL = 1e-4;

const AXIS_DIR = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1]
};

/**
 * 軸的位置：兩個座標，⛔ 不是一個。
 *
 * 🔴 **`切一刀` 只要一個數字，因為它定的是一個【平面】；
 * 　 軸是一條【線】，要兩個。** ⚠ 介面上那兩欄的標籤跟著軸變。
 */
export const AXIS_FIELDS = {
  x: ['y', 'z'],
  y: ['x', 'z'],
  z: ['x', 'y']
};

/**
 * 一條輪廓繞軸轉一圈。
 *
 * @param {THREE.Vector3[]} pts 輪廓上的點，**照順序**（開放的一條線）
 * @param {object} opt
 *        `axis`  'x'｜'y'｜'z'（預設 'z'）
 *        `a`,`b` 軸的位置 —— 照 `AXIS_FIELDS[axis]` 那兩個座標
 *        `seg`   轉幾格（預設 32）
 * @returns {{ok:boolean, reason?:string, mesh?:Mesh,
 *            poles?:number, rings?:number, closed?:boolean,
 *            profileR?:{min:number,max:number}}}
 */
export function revolve(pts, opt = {}) {
  if (!Array.isArray(pts) || pts.length < 2) {
    return { ok: false, reason: '至少要有 2 個點才轉得出東西' };
  }

  const axis = AXIS_DIR[opt.axis] ? opt.axis : 'z';
  const seg = Math.max(3, Math.min(360, Math.round(+opt.seg || REVOLVE_DEFAULTS.seg)));

  /** 軸：方向 D（單位向量）＋ 軸上一點 O */
  const D = new THREE.Vector3(...AXIS_DIR[axis]);
  const O = new THREE.Vector3();
  const [fa, fb] = AXIS_FIELDS[axis];
  O[fa] = +opt.a || 0;
  O[fb] = +opt.b || 0;

  /**
   * 把每個點拆成「沿軸走多遠 t」＋「離軸的那一段 radial」。
   * ⭐ 旋轉 ＝ 只轉 `radial`，`t` 一動也不動。
   */
  const parts = pts.map(p => {
    const d = new THREE.Vector3().subVectors(p, O);
    const t = d.dot(D);
    const radial = d.clone().addScaledVector(D, -t);
    return { t, radial, r: radial.length() };
  });

  const pole = parts.map(q => q.r <= ON_AXIS_TOL);
  if (pole.every(Boolean)) {
    return { ok: false, reason: '這條線整條都在中心線上 —— 轉出來不會有東西' };
  }

  /**
   * 🔴 **擋關：輪廓跨過中心線的兩邊。**
   *
   * 【kang 2026-09-02 拍板】跨過去的話轉起來會自己穿過自己，
   * ⇒ **擋下來講原因，⛔ 不猜**〔補不到唯一就明講，坑第 24 條〕。
   *
   * ⭐ 判準是**方向**，⛔ 不是座標的正負 —— 座標的正負跟軸擺在哪有關，
   * 而「在不在同一側」問的是**離軸的那一段指向哪裡**。
   */
  const ref = parts.find(q => q.r > ON_AXIS_TOL).radial.clone().normalize();
  for (const q of parts) {
    if (q.r <= ON_AXIS_TOL) continue;
    if (q.radial.dot(ref) / q.r < -1e-9) {
      return {
        ok: false,
        reason: '這條線跨過中心線了 —— 請只畫中心線的一邊'
      };
    }
  }

  /**
   * 🔴 **輪廓本身是不是封閉的（首尾同一個位置）。**
   *
   * ⚠ **⛔ 這一段不是多餘的**：`鋼筆` 畫出來的路徑**預設就是封閉的**
   * （`io.js` 的 `penPathToWorld()` 回 `closed: true`），
   * 而封閉的輪廓轉出來是**環**（甜甜圈、輪圈）。
   * ⛔ 當成開放線處理的話會**少接一段**，⚠ 而那個缺口在畫面上很難看出來。
   *
   * ⭐ **⛔ 不可以叫呼叫端「把第一個點再附到最後」** —— 那會產生
   * **兩個重疊的頂點**，網格變成非流形，而畫面上一模一樣。
   */
  const closedProfile = pts.length >= 3 &&
    pts[0].distanceTo(pts[pts.length - 1]) <= ON_AXIS_TOL;
  /** 封閉時最後一個點跟第一個是同一個 —— ⛔ 不要放兩份 */
  const m = closedProfile ? pts.length - 1 : pts.length;
  if (m < 2) return { ok: false, reason: '至少要有 2 個點才轉得出東西' };
  const points = [];
  const faces = [];

  /** 極點各自只放一個頂點；其餘每一圈各放一個 */
  const poleIdx = new Array(m).fill(-1);
  for (let i = 0; i < m; i++) {
    if (!pole[i]) continue;
    poleIdx[i] = points.length;
    points.push(O.clone().addScaledVector(D, parts[i].t));
  }

  /** `idx[k][i]` ＝ 第 k 圈第 i 個點的頂點索引 */
  const idx = [];
  for (let k = 0; k < seg; k++) {
    const ang = Math.PI * 2 * k / seg;
    const row = new Array(m);
    for (let i = 0; i < m; i++) {
      if (pole[i]) { row[i] = poleIdx[i]; continue; }
      const rad = parts[i].radial.clone().applyAxisAngle(D, ang);
      row[i] = points.length;
      points.push(O.clone().addScaledVector(D, parts[i].t).add(rad));
    }
    idx.push(row);
  }

  /**
   * 側牆。
   * ⚠ **繞向是量出來的，⛔ 不是推的** —— 見檔頭那則與測試裡的體積斷言。
   */
  const ringPairs = [];      // 繞的方向那些邊（圓被切成折線的產物）→ 要標 smooth
  /** 封閉的輪廓要多接一段（`m−1` 回到 `0`）—— 那一段正是「環」的內圈 */
  const segsAlong = closedProfile ? m : m - 1;
  for (let k = 0; k < seg; k++) {
    const k2 = (k + 1) % seg;
    for (let i = 0; i < segsAlong; i++) {
      const i2 = (i + 1) % m;
      const a = idx[k][i], b = idx[k][i2];
      const c = idx[k2][i2], d = idx[k2][i];

      /**
       * 🔴 **這個順序是【量出來的】，⛔ 不是推的。**
       * 【實證 2026-09-02 沙箱】照直覺寫 `[a,b,c,d]` → 圓柱體積
       * **−136563.225**（應該是 +136563.225）＝ 整個模型法向朝內。
       * ⚠ 而那個模型**畫面上看起來完全正常** —— 只有匯出 STL 的
       * 列印前檢查才抓得到〔`extrude.js` 檔頭記著同一個坑〕。
       */
      if (pole[i] && pole[i2]) continue;             // 整段都在軸上 → 沒有面
      if (pole[i]) faces.push([c, b, a]);            // 這一端收成一個尖
      else if (pole[i2]) faces.push([d, b, a]);      // 另一端收成一個尖
      else faces.push([d, c, b, a]);

      if (!pole[i]) ringPairs.push([a, d]);
    }
    /** 開放的輪廓：最後一個點那一圈⛔ 還沒被上面標到（它不是任何一段的起點）*/
    if (!closedProfile && !pole[m - 1]) {
      ringPairs.push([idx[k][m - 1], idx[k2][m - 1]]);
    }
  }

  if (!faces.length) return { ok: false, reason: '這條線轉不出任何面' };

  const mesh = Mesh.fromFaceList(points, faces);
  mesh.computeNormals();

  /**
   * 🔴 **繞的方向那些邊一律標 `smooth`。**
   *
   * ⚠ **⛔ 不標的話展開圖會把一個平滑的轉面標成幾百道折彎**
   * —— `extrude.js` 的 `smoothPairs` 是同一件事，而這個專案
   * **2026-08-23 為了它付過一次代價**（展開圖從 5 處折彎變成 45 處）。
   * ⭐ 找邊的方式照 `extrude.js` 抄：**頂點索引配對**，⛔ 不靠半邊的順序。
   */
  if (ringPairs.length) {
    const vidx = new Map(mesh.verts.map((v, i) => [v.id, i]));
    const byPair = new Map();
    for (const he of mesh.edges()) {
      const a = vidx.get(he.v.id), b = vidx.get(he.to.id);
      byPair.set(`${Math.min(a, b)}-${Math.max(a, b)}`, he);
    }
    for (const [a, b] of ringPairs) {
      const he = byPair.get(`${Math.min(a, b)}-${Math.max(a, b)}`);
      if (he) mesh.setSmooth(he, true);
    }
  }

  let rmin = Infinity, rmax = 0;
  for (const q of parts) { if (q.r < rmin) rmin = q.r; if (q.r > rmax) rmax = q.r; }

  return {
    ok: true,
    mesh,
    poles: pole.filter(Boolean).length,
    rings: seg,
    closed: mesh.isClosed(),
    profileR: { min: rmin, max: rmax }
  };
}
