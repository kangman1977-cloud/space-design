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
//  帶洞的多邊形三角化
// ═══════════════════════════════════════════════════════

/**
 * 把外框與內孔接成一個簡單多邊形，再耳切成三角形。
 *
 * 「接」的做法是**開橋**：從孔最右邊那個點往右射一條線，
 * 打到外框的某條邊，在那裡切開、把孔的一圈插進去，來回各走一次。
 * 接完之後洞就不存在了 —— 它變成一條寬度為 0 的縫。
 * 這是課本做法，因為它不需要任何額外的資料結構，
 * 而且結果仍然是一個簡單多邊形，耳切法直接就能吃。
 *
 * @returns {{pts:Array, tris:Array}} pts 依序是外框、孔1、孔2…（側牆要照這個順序）
 */
export function triangulateWithHoles(outer, holes) {
  const pts = [...outer];
  for (const h of holes) pts.push(...h);

  // 沒有孔就直接耳切
  if (!holes.length) return { pts, tris: earClip(outer.map((_, i) => i), pts) };

  // 索引版的外框，之後會被插入孔的索引
  let ring = outer.map((_, i) => i);
  let base = outer.length;
  const holeRings = holes.map(h => {
    const r = { start: base, len: h.length };
    base += h.length;
    return r;
  });

  /**
   * 孔要從**最右邊的那個**開始接。
   * 順序不對的話，後接的橋可能穿過先接的橋，接出一個自交的多邊形，
   * 而耳切法對自交的輸入會靜靜給出亂七八糟的三角形。
   */
  const order = holeRings
    .map((r, i) => ({ r, i, x: maxX(pts, r) }))
    .sort((a, b) => b.x - a.x);

  for (const { r } of order) {
    ring = bridgeHole(ring, r, pts);
    if (!ring) return { pts, tris: [] };
  }

  return { pts, tris: earClip(ring, pts) };
}

function maxX(pts, r) {
  let m = -Infinity;
  for (let i = 0; i < r.len; i++) m = Math.max(m, pts[r.start + i].x);
  return m;
}

/** 把一個孔接進外圈。回傳新的一圈索引。 */
function bridgeHole(ring, r, pts) {
  // 孔上最右邊的點
  let hi = 0;
  for (let i = 1; i < r.len; i++) if (pts[r.start + i].x > pts[r.start + hi].x) hi = i;
  const M = pts[r.start + hi];

  /**
   * 從 M 往 +x 射一條線，找最近的交點落在哪條邊上。
   * 只考慮「跨過 M 的 y」而且方向朝下的邊（那才是外圈朝右的那一側），
   * 這樣射線一定是從多邊形內部往外打。
   */
  let best = -1, bestX = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = pts[ring[i]], b = pts[ring[(i + 1) % ring.length]];
    if (a.y > M.y === b.y > M.y) continue;
    const t = (M.y - a.y) / (b.y - a.y);
    const x = a.x + t * (b.x - a.x);
    if (x < M.x - 1e-12) continue;
    if (x < bestX) { bestX = x; best = i; }
  }
  if (best < 0) return null;

  // 取那條邊上 x 較大的端點當橋墩 —— 它一定看得到 M
  const ia = ring[best], ib = ring[(best + 1) % ring.length];
  const bridge = pts[ia].x >= pts[ib].x ? best : (best + 1) % ring.length;

  const out = [];
  for (let i = 0; i <= bridge; i++) out.push(ring[i]);
  for (let k = 0; k <= r.len; k++) out.push(r.start + (hi + k) % r.len);
  out.push(ring[bridge]);
  for (let i = bridge + 1; i < ring.length; i++) out.push(ring[i]);
  return out;
}

/**
 * 耳切法。每次找一個「耳朵」（連續三點圍出的三角形裡沒有別的點）切掉。
 *
 * 這是 O(n²)，一千個點的描圖輪廓大約幾十毫秒，夠用。
 * 需要更快的時候再說 —— 不為想像中的問題先寫程式。
 */
export function earClip(ring, pts) {
  const idx = ring.slice();
  const tris = [];
  let guard = idx.length * idx.length + 16;

  while (idx.length > 3 && guard-- > 0) {
    let cut = -1;
    for (let i = 0; i < idx.length; i++) {
      const a = pts[idx[(i - 1 + idx.length) % idx.length]];
      const b = pts[idx[i]];
      const c = pts[idx[(i + 1) % idx.length]];
      if (cross(a, b, c) <= 0) continue;             // 凹角不可能是耳朵

      let ok = true;
      for (let j = 0; j < idx.length; j++) {
        if (j === i || j === (i - 1 + idx.length) % idx.length
          || j === (i + 1) % idx.length) continue;
        const p = pts[idx[j]];
        /**
         * ⚠ 要比**座標**，不能只比索引。
         *
         * 開橋之後，橋墩那兩個點會在這一圈裡出現兩次（那正是橋的意思）。
         * 只用索引排除的話，另一個副本會被當成「落在耳朵裡的點」，
         * 於是每一個角都不是耳朵，三角化直接回傳零個三角形 ——
         * 而它不會報錯，只會讓蓋子整片消失。實際踩到過。
         */
        if (same(p, a) || same(p, b) || same(p, c)) continue;
        if (inTriangle(p, a, b, c)) { ok = false; break; }
      }
      if (ok) { cut = i; break; }
    }

    /**
     * 找不到耳朵表示輸入不是簡單多邊形（自交、或橋開壞了）。
     * 這時候**不要硬切** —— 硬切會產生翻面的三角形，
     * 而那種模型在畫面上看起來正常，匯出 STL 才會被判「印不出來」。
     * 直接停下來，讓上層講出「這個輪廓有問題」。
     */
    if (cut < 0) break;

    const p = idx[(cut - 1 + idx.length) % idx.length];
    const q = idx[cut];
    const r = idx[(cut + 1) % idx.length];
    tris.push([p, q, r]);
    idx.splice(cut, 1);
  }

  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  return tris;
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

const same = (p, q) => Math.abs(p.x - q.x) < 1e-12 && Math.abs(p.y - q.y) < 1e-12;

function inTriangle(p, a, b, c) {
  const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
  return d1 >= 0 && d2 >= 0 && d3 >= 0;
}

/** 三角形面積總和。三角化對不對，用這個跟多邊形面積對答案。 */
export function trisArea(tris, pts) {
  let s = 0;
  for (const t of tris) {
    s += Math.abs(cross(pts[t[0]], pts[t[1]], pts[t[2]])) / 2;
  }
  return s;
}
