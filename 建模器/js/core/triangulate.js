/**
 * triangulate.js — 多邊形三角化（耳切法）
 *
 * ── 為什麼獨立成一支 ────────────────────────────────
 * 這一段本來住在 `build/extrude.js`（匯入線稿時要把帶洞的輪廓切成三角形）。
 * 2026-08-24 搬出來，原因是 **`mesh.js` 也需要它**，
 * 而 `extrude.js` 匯入 `mesh.js` —— 反向依賴會造成循環。
 *
 * 這一支**不匯入任何東西**（連 three.js 都不用，它只吃 `{x,y}`），
 * 所以誰都可以用它。
 *
 * ── mesh.js 為什麼需要它 ───────────────────────────
 * 🔴 **扇形三角化只對凸多邊形成立。**
 * 一個凹進去的 n 邊形用扇形切，會產生**跑到多邊形外面、而且繞向翻掉**的三角形。
 *
 * 實測（2026-08-24，kang 回報的畫面）：圓柱壓平一段再往內拉，
 * 上蓋變成非凸的 32 邊形 —— 扇形切出來**多畫了 81.95 cm²（4.56%）**，
 * 其中 1 個三角形繞向是反的。
 *
 * 而那個 bug **一直都在，只是以前叫不出來**：
 * n 邊形本來只出現在 `roundBox`（20 邊形，凸）與 `tube`（四邊形），
 * 匯入的擠出件早就自己耳切成三角形了。
 * 「還原多邊形」讓每個共面區域都變成 n 邊形之後，它才浮出來。
 *
 * ── 搬移方式 ────────────────────────────────────────
 * **逐字搬，一個字都沒改**（`extrude.js` 原第 159–323 行，
 * 165 行 / 6215 bytes / md5 54e206726bd481859460e8bd16b13ae1）。
 * 專案的搬移鐵律：一律逐字搬 ＋ 機械斷言，不做「順手精簡改寫」——
 * 手寫重組會靜默掉東西，而且不會有任何東西報錯。
 */

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
