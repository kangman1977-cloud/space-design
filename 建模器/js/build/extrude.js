/**
 * extrude.js — 把 2D 封閉輪廓擠出成 3D 實體
 *
 * 輪廓躺在**地面（XZ 平面）**上，往上（+Y）長出高度 ——
 * 跟這個建模器其他東西一樣，Y 是向上的那個軸。
 * 輪廓的 (x, y) 對應世界的 (x, z)，沒有翻面（見 profile.js 的說明）。
 *
 * ── 為什麼自己寫三角化，不拿布林去挖洞 ────────────────────
 * 「外框擠出來，再用布林把每個洞減掉」也做得出同樣的東西，
 * 而且 Manifold 保證結果封閉。但那樣一個有 20 個內孔的描圖輪廓
 * 就要跑 20 次布林，而且讓「擠出一個方形」這種最單純的操作
 * 也依賴 WASM 載不載得到。
 *
 * 耳切法（ear clipping）大約一百多行，而且**驗得動**：
 * 三角形數量必須等於 n−2、三角形面積總和必須等於多邊形面積。
 * 寫完之後草圖擠出、加厚成板都用得到同一份。
 *
 * 單位 cm。不碰 DOM，Node 裡測得到。
 */

import * as THREE from 'three';
import { Mesh } from '../core/mesh.js';
import { triangulateWithHoles } from '../core/triangulate.js';

/**
 * 擠出。
 *
 * @param {object} profile { pts:[{x,y}], holes:[{pts}] } —— 一個外框加它的內孔
 * @param {number} h 高度 cm
 * @param {object} opt { base 底面高度 }
 * @returns {Mesh}
 */
export function extrudeProfile(profile, h, opt = {}) {
  return extrudeMany([profile], h, opt);
}

/**
 * 一次擠出多個外框（每個可以有自己的內孔），合成一個網格。
 *
 * 分開的外框直接放在同一個網格裡，**不做布林聯集** ——
 * 它們本來就不相連，聯集只是白跑一趟。這跟「板件陣列直接拼接」
 * （踩過的坑第 8 條）是同一個判斷。
 */
export function extrudeMany(profiles, h, opt = {}) {
  const H = +h;
  if (!(Math.abs(H) > 1e-9)) throw new Error('擠出高度不能是 0');
  const base = opt.base || 0;
  const y0 = base, y1 = base + H;

  const points = [];
  const faces = [];
  const smoothPairs = [];        // 側牆上「不是真轉角」的那些垂直邊

  for (const prof of profiles) {
    const outer = ensureDir(prof.pts, true);
    const holes = (prof.holes || []).map(hh => ensureDir(hh.pts || hh, false));

    // ── 頂面與底面的三角化 ──
    const flat = triangulateWithHoles(outer, holes);
    if (!flat.tris.length) continue;

    const ring = flat.pts;                        // 三角化用的完整點集（含孔）
    const n = ring.length;
    const iBot = points.length;
    for (const p of ring) points.push(new THREE.Vector3(p.x, y0, p.y));
    const iTop = points.length;
    for (const p of ring) points.push(new THREE.Vector3(p.x, y1, p.y));

    /**
     * ── 繞向 ──────────────────────────────────────────
     * 輪廓的 (x, y) 對應世界的 (x, z)，而 **x̂ × ẑ ＝ −ŷ** ——
     * 所以「在 (x,z) 裡逆時針」的一圈，法向是朝**下**的，
     * 跟直覺相反。照直覺寫的第一版整個模型法向朝內，
     * 體積算出來是 −500000。
     *
     * 這種事不靠推理，靠對答案：測試盯著「體積 ＝ 面積 × 高」，
     * 而且是**正的**。法向朝內的模型在畫面上看起來完全正常，
     * 只有匯出 STL 時的列印前檢查才會抓到（第 3.5 期做的那個）。
     */
    for (const t of flat.tris) {
      faces.push([iBot + t[0], iBot + t[1], iBot + t[2]]);   // 底：朝下（−Y）
      faces.push([iTop + t[0], iTop + t[2], iTop + t[1]]);   // 頂：朝上（+Y）
    }

    // ── 側牆 ──
    // 每一圈（外框與各個孔）各自繞一圈，相鄰兩點拉出一個四邊形。
    let off = 0;
    for (const loop of [outer, ...holes]) {
      const L = loop.length;
      for (let i = 0; i < L; i++) {
        const a = off + i, b = off + (i + 1) % L;
        faces.push([iBot + b, iBot + a, iTop + a, iTop + b]);
        /**
         * 側牆的**垂直邊**對應輪廓上的一個點。那個點不是真轉角的話，
         * 這條邊就是「曲線被切成折線」的產物，不是造型上真的有一道折。
         * 記下來，展開時才不會把一段平滑的曲線標成一百多道折彎。
         */
        if (!loop[i].corner) smoothPairs.push([iBot + a, iTop + a]);
      }
      off += L;
    }
  }

  if (!faces.length) throw new Error('這個輪廓三角化不出任何面');
  const mesh = Mesh.fromFaceList(points, faces);

  // 建好之後才標得到邊 —— 用「頂點索引配對」找，跟存讀檔同一套做法
  if (smoothPairs.length) {
    const idx = new Map(mesh.verts.map((v, i) => [v.id, i]));
    const byPair = new Map();
    for (const he of mesh.edges()) {
      const a = idx.get(he.v.id), b = idx.get(he.to.id);
      byPair.set(`${Math.min(a, b)}-${Math.max(a, b)}`, he);
    }
    for (const [a, b] of smoothPairs) {
      const he = byPair.get(`${Math.min(a, b)}-${Math.max(a, b)}`);
      if (he) mesh.setSmooth(he, true);
    }
  }
  return mesh;
}

/**
 * 讓外框逆時針、內孔順時針。
 *
 * 畫的人不一定照規矩，而繞向錯了的話：三角化會失敗、側牆法向會朝內。
 * 統一到一個方向之後，後面全部不用再問「這一圈是哪個方向」。
 */
function ensureDir(pts, wantCCW) {
  const clean = dedupe(pts);
  const a = shoelace(clean);
  return (a >= 0) === wantCCW ? clean : clean.slice().reverse();
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last.x - p.x) > 1e-12 || Math.abs(last.y - p.y) > 1e-12) {
      out.push({ x: p.x, y: p.y, corner: !!p.corner });   // 旗標一定要跟著複製
    }
  }
  while (out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.abs(f.x - l.x) < 1e-12 && Math.abs(f.y - l.y) < 1e-12) out.pop();
    else break;
  }
  return out;
}

export function shoelace(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}
// ═══════════════════════════════════════════════════════
//  帶洞的多邊形三角化 → 已搬到 core/triangulate.js
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **耳切那一整段（原第 159–323 行）2026-08-24 搬到 `core/triangulate.js`。**
 *
 * 搬走的理由：**`mesh.js` 也需要它**（非凸的 n 邊形不能用扇形三角化），
 * 而 `extrude.js` 匯入 `mesh.js` —— 留在這裡會造成循環依賴。
 *
 * 逐字搬，一個字都沒改（165 行 / 6215 bytes / md5 54e206726bd481859460e8bd16b13ae1）。
 * `triangulateWithHoles` / `earClip` / `trisArea` 現在從那邊 re-export，
 * **所以原本 import 這個檔的地方一行都不用改**（測試就是這樣進來的）。
 */
export { triangulateWithHoles, earClip, trisArea } from '../core/triangulate.js';
