/**
 * pegs.js — 定位孔
 *
 * 切得再準，**人工疊合歪掉的量會遠大於切割精度**。
 * 50 片板子照輪廓切得再對，一片一片憑眼睛擺上去，最後還是歪的。
 * 所以一定要有對位基準。
 *
 * 選定位孔＋串桿，理由是兩個（kang 2026-08-22 確認）：
 *
 * **一、誤差不累積。** 用中心線對位時每一片是對著「下面那片」擺的，
 * 第 30 片的偏差是前 29 次的總和。用串桿的話每一片都對著**同一根桿子**，
 * 第 1 片與第 50 片的基準完全一樣。
 *
 * **二、定位孔是程式做得出來的東西。** 中心線與外部夾具主要是現場的事；
 * 孔的位置、孔徑、會不會撞到輪廓，全部是幾何計算，可以直接畫進 DXF。
 *
 * 代價是成品會留下孔 —— 但疊合之後本來就要補土打磨，孔一起補掉。
 *
 * ── 這個檔案存在的真正理由是那個「檢查」──────────────────
 * 孔必須落在**每一片的實心部分**裡。造型中間有洞、或某個高度收得很細時，
 * 固定位置的孔會落在材料外 —— **那一片就串不起來**。
 * 這是程式答得出來的問題（跟 STL 的列印前檢查同一種價值），
 * 而且必須做，不然使用者會切到一半才發現。
 *
 * ── 孔①通到底，其餘的孔只屬於那一段（2026-08-22 kang 提出）────
 *
 * 第一版所有孔都要求「每一片都成立」，實測球體時整個垮掉：
 * 球切 15 片，頭尾是直徑只有 10cm 的小圓片，兩個孔被擠進那個小圓裡，
 * **只距離 2.66cm** —— 在一個 60cm 的球上等於白放第二個孔。
 * 算得完全正確，但被全場最小的那一片綁死了。
 *
 * 現在的規則：
 *   孔①  全域求解，每一片都有 —— 這是**通到底的那根桿子**
 *   孔②③ 每一段各自求解，只需要在**那一段的片**上成立
 *
 * 代價講清楚：孔②③ 是那一段自己的短桿，穿不過沒有那個孔的片。
 * 換來的是中段可以把孔拉得很開，而頭尾小片給 1 孔就好
 * —— 反正球的頭尾是圓的，轉了也看不出來。
 *
 * 純幾何，不碰 DOM，測得到。單位 cm。
 */

import { insideDepth, stackBounds, listNums } from './section.js';

export const PEG_DEFAULTS = {
  d: 0.5,        // 孔徑 cm。串桿實際拿到什麼就填什麼，面板可改
  gap: 0.8,      // 孔的邊緣離料的邊緣至少要留多少，太薄會裂
  count: 2,      // 每段預設幾個孔。兩孔才鎖得住旋轉
  grid: 90       // 掃描格線的邊長格數。越大越可能找到刁鑽的位置，也越慢
};

/**
 * 自動找定位孔。
 *
 * @param {Array} slices sliceMesh() 的 slices（每片帶 band 欄位）
 * @param {object} opt { d, gap, count, grid, counts }
 *        counts —— 每段要幾個孔，索引 ＝ band。沒給就用 count。
 */
export function findPegs(slices, opt = {}) {
  const o = { ...PEG_DEFAULTS, ...opt };
  const need = o.d / 2 + o.gap;

  const solid = slices.filter(s => s.loops && s.loops.length);
  const empty = slices.filter(s => !s.loops || !s.loops.length).map(s => s.index);

  if (!solid.length) {
    return fail('沒有任何一片有實心的部分。', need, empty);
  }

  const box = stackBounds(solid);
  if (!(box.w > 0 && box.h > 0)) return fail('這一疊的外框是空的。', need, empty);

  const grid = makeGrid(box, o.grid, need);
  if (!grid.pts.length) {
    return fail('這一疊太小，塞不下這個孔徑。把孔徑或淨距調小。', need, empty);
  }

  // ── 孔①：全域。每一片都要有，因為它是通到底的那根桿子。 ──
  const all = scan(grid.pts, solid, need);
  if (!all.length) {
    return fail(`找不到一個位置能讓 ${solid.length} 片都串得起來`
      + `（孔徑 ${r2(o.d)}cm、淨距 ${r2(o.gap)}cm）。`
      + '把孔徑或淨距調小，或把分段拆細一點。', need, empty);
  }

  /**
   * 孔①取「最糟的那一片剩最多」的位置。
   *
   * ── 為什麼不直接寫死在外框中心 ────────────────────────
   * kang 原本的想法是「第一個孔一定在中心點」。對球、方塊這種件，
   * 這個規則算出來的答案就是中心（實測方塊給 (0,0)），
   * 但**管狀件的中心是空的** —— 硬放中心的話那個孔會落在洞裡，
   * 而那正是這個檔案要防的事。
   * 所以規則寫成「所有片都最安全的那一點」：想要的效果一樣拿得到，
   * 環形件也不會壞掉。
   *
   * 同分時取離外框中心近的那個。方塊這種件的最安全位置是一整條中線，
   * 上面每一點的安全度一模一樣，隨便挑會挑到線的一端 ——
   * 數字完全正確，但使用者看到孔不在正中間會以為算錯了。
   */
  all.sort((a, b) => (b.m - a.m)
    || (Math.hypot(a.x - grid.cx, a.y - grid.cy) - Math.hypot(b.x - grid.cx, b.y - grid.cy)));
  const base = { x: snap(all[0].x), y: snap(all[0].y) };
  base.m = minDepth(solid, base);

  // ── 每一段各自求它自己的額外孔 ──
  const diag = Math.hypot(box.w, box.h);
  const bandIds = [...new Set(slices.map(s => s.band || 0))].sort((a, b) => a - b);
  const bands = [];
  /**
   * ── 警告與說明要分開 ──────────────────────────────────
   * warnings ＝ **程式做不到你要求的事**（要 3 孔只放得下 2 孔、
   *             兩孔太近等於白放、有片是空的、孔快切到邊緣）
   * notes    ＝ **你自己選的後果**（選了 1 孔，那幾片就可以繞著孔轉）
   *
   * 第一版全部塞進 warnings，實測時使用者刻意把頭尾設成 1 孔，
   * 畫面就跳出兩個紅框唸同一件事。**自己選的東西被當成錯誤**，
   * 而且同一句話拆成兩框 —— 這是「誤報讓人學會忽略整個警告欄」
   * （坑第 18 條）的軟性版本，一樣會讓紅色失去意義。
   */
  const warnings = [];
  const notes = [];
  const singles = [];

  for (const bi of bandIds) {
    const list = solid.filter(s => (s.band || 0) === bi);
    const want = Math.max(1, Math.floor(
      (o.counts && o.counts[bi] != null) ? o.counts[bi] : o.count) || 1);
    const nums = list.map(s => s.index);
    const pegs = [{ x: base.x, y: base.y }];

    if (want > 1 && list.length) {
      const alive = scan(grid.pts, list, need);
      /**
       * 距離要爭取，安全度是**不能低於的** —— 但那條線要訂在哪？
       *
       * 第一版直接挑「最遠」的點，60×40 的方塊第 2 孔被推到角落，
       * 離邊只剩 1.47cm，45 片全部變成快裂了 —— 那塊料明明寬得很。
       *
       * 第二版改成「孔①安全度的四成」，結果反過來太保守：
       * 球的中段孔明明可以離邊緣留 2cm 還很安全，卻被綁在 8.8cm，
       * 間距因此少掉一半。而且那條線會**隨物件大小浮動**，
       * 同一個形狀放大兩倍，判準就跟著變 —— 講不出道理。
       *
       * 現在用**使用者自己設的淨距的兩倍**。
       * 淨距是他說「孔邊離料邊至少要留這麼多」的那個數字，
       * 要更多肉就把淨距調大 —— 程式不替他猜，也不隨物件大小飄。
       * 兩倍都找不到才降回最低門檻，而降了就會被下面的「容易裂」抓到。
       */
      const safe = need * 2;

      for (let k = 1; k < want; k++) {
        let best = null, bestScore = -1;
        for (const level of [safe, need]) {
          for (const p of alive) {
            if (p.m < level) continue;
            let dmin = Infinity;
            for (const q of pegs) dmin = Math.min(dmin, Math.hypot(p.x - q.x, p.y - q.y));
            if (dmin < need * 3) continue;     // 太近的不算，鎖不住旋轉
            if (dmin > bestScore) { bestScore = dmin; best = p; }
          }
          if (best) break;
        }
        if (!best) break;
        pegs.push({ x: snap(best.x), y: snap(best.y) });
      }
    }

    // 座標修到 0.01cm 之後**重算一次真正的安全度**。
    // 報一個沒有重新驗過的數字，跟沒驗一樣。
    const margin = Math.min(...pegs.map(p => minDepth(list, p)));
    const spread = pegs.length > 1 ? maxPairDist(pegs) : 0;

    bands.push({ band: bi, pegs, margin, spread, want, slices: nums });

    if (pegs.length < want) {
      warnings.push(`第 ${listNums(nums)} 片只放得下 ${pegs.length} 個孔`
        + `（要 ${want} 個）。`
        + (pegs.length === 1 ? '單孔串起來的那幾片可以繞著孔轉。' : ''));
    }
    /**
     * ⚠ 兩孔太近等於單孔 —— 這件事一定要講。
     *
     * 實測球體時兩孔只距離 2.66cm，而物件有 60cm 寬。
     * 面板當時只報「離邊緣還剩 1.71cm」，那個數字是安全的，
     * 但**間距不安全**，使用者看不出來。
     * 結果不唯一卻不講，使用者就驗不出對錯（坑第 24 條）。
     */
    if (pegs.length > 1 && spread < diag * 0.15) {
      warnings.push(`第 ${listNums(nums)} 片的孔只距離 ${r2(spread)} cm`
        + `（物件有 ${r2(diag)} cm 大），鎖不住旋轉，跟單孔差不多。`
        + '這一段給 1 孔就好，或把孔徑與淨距調小。');
    }
    // 使用者自己選 1 孔，不是失敗。後果要講，但講一次就好，也不該用紅色。
    if (pegs.length === 1 && want === 1 && list.length) singles.push(...nums);
  }

  if (singles.length) {
    notes.push(`第 ${listNums(singles.sort((a, b) => a - b))} 片是單孔`
      + '（你指定的），疊的時候可以繞著孔轉，靠層號或輪廓自己對正。');
  }

  if (empty.length) warnings.push(`第 ${listNums(empty)} 片是空的，串不起來。`);

  const margin = Math.min(...bands.map(b => b.margin));

  // 最吃緊的那幾片。「可以用」跟「剛好可以用」差很多。
  const tight = [];
  for (const s of solid) {
    const d = minDepth([s], ...pegsOfBand(bands, s.band || 0));
    if (d < need * 1.5) tight.push({ index: s.index, depth: d });
  }
  if (tight.length) {
    warnings.push(`第 ${listNums(tight.map(t => t.index))} 片的孔離邊緣只剩 `
      + `${r2(Math.min(...tight.map(t => t.depth)))} cm，容易裂。`);
  }

  return {
    ok: true,
    base: { x: base.x, y: base.y },
    bands,
    need, margin, empty, tight, warnings, notes,
    /** 全部片一共用到幾種孔位（＝ DXF 裡會出現幾個不同的圓心） */
    holeCount: bands.reduce((n, b) => Math.max(n, b.pegs.length), 0)
  };
}

/** 這一片要鑽哪幾個孔 ＝ 它所屬那一段的孔。孔①永遠在第一個。 */
export function pegsForSlice(res, slice) {
  if (!res || !res.ok) return [];
  const b = res.bands.find(q => q.band === (slice.band || 0));
  return b ? b.pegs : [{ ...res.base }];
}

/**
 * 檢查一組孔位。
 *
 * 分開寫是刻意的：**找孔位**與**檢查孔位**是兩件事，
 * 檢查這件事必須能單獨對答案（方塊中心的孔，每一片剩多少是手算得出來的），
 * 不然「找」的那一段出錯時沒有東西擋得住。
 *
 * @param {Function|Array} getPegs 給一片回傳它的孔；也可以直接給一個陣列
 */
export function checkPegs(slices, getPegs, opt = {}) {
  const o = { ...PEG_DEFAULTS, ...opt };
  const need = o.d / 2 + o.gap;
  const f = typeof getPegs === 'function' ? getPegs : () => getPegs;
  const rows = [];

  for (const s of slices) {
    const pegs = f(s) || [];
    const d = (s.loops && s.loops.length && pegs.length)
      ? minDepth([s], ...pegs) : -Infinity;
    rows.push({ index: s.index, depth: d, ok: d >= need });
  }

  const bad = rows.filter(r => !r.ok);
  return {
    ok: bad.length === 0,
    need, rows,
    bad: bad.map(r => r.index),
    worst: rows.length ? Math.min(...rows.map(r => r.depth)) : -Infinity
  };
}

// ═══════════════════════════════════════════════════════
//  底層：撒格點、掃描
// ═══════════════════════════════════════════════════════

/**
 * 格點從外框中心往兩邊長出去，**不是從左下角開始排**。
 *
 * 對稱的件（方塊、圓柱、管）最好的孔位就是正中心，而從角落起排的話
 * 中心不一定落在格點上，孔就會歪個 0.1 幾公分 ——
 * 數學上完全夠用，但使用者一看座標不是 0 就會懷疑程式算錯了。
 * 對稱撒點是零成本的，沒有理由不做。
 *
 * 全部的掃描共用同一份格點，所以孔①與各段的額外孔落在同一套座標上。
 */
function makeGrid(box, n, need) {
  const step = Math.max(box.w, box.h) / Math.max(4, n);
  const pad = need * 0.5;
  const cx = (box.minX + box.maxX) / 2, cy = (box.minY + box.maxY) / 2;
  const nx = Math.floor((box.w / 2 - pad) / step);
  const ny = Math.floor((box.h / 2 - pad) / step);
  const pts = [];
  for (let j = -ny; j <= ny; j++) {
    for (let i = -nx; i <= nx; i++) pts.push({ x: cx + i * step, y: cy + j * step });
  }
  return { pts, step, cx, cy };
}

/**
 * 掃描：每個格點記住「這一批片裡最糟的那一片還剩多少肉」。
 *
 * 沒有用什麼聰明的演算法（最大內切圓之類），因為真正要滿足的條件是
 * 「所有片同時成立」，那是很多個區域的交集，形狀可以任意奇怪、
 * 還可能是空的。掃描對這種問題最不會出錯，而且**答案的意義很清楚**
 * —— 面板上寫得出「最糟的那一片還剩 0.9cm」。
 *
 * 速度靠一件事撐住：格點一旦被某一片判死就直接剔除，不再參與後面的片。
 */
function scan(pts, slices, need) {
  let alive = pts.map(p => ({ x: p.x, y: p.y, m: Infinity }));
  for (const s of slices) {
    const keep = [];
    for (const p of alive) {
      const d = insideDepth(s.loops, p.x, p.y);
      if (d < need) continue;
      if (d < p.m) p.m = d;
      keep.push(p);
    }
    alive = keep;
    if (!alive.length) break;
  }
  return alive;
}

/** 這幾個孔在這幾片上，最糟的那一個離邊界多遠 */
function minDepth(slices, ...pegs) {
  let d = Infinity;
  for (const s of slices) {
    if (!s.loops || !s.loops.length) return -Infinity;
    for (const p of pegs) d = Math.min(d, insideDepth(s.loops, p.x, p.y));
  }
  return d;
}

function pegsOfBand(bands, bi) {
  const b = bands.find(q => q.band === bi);
  return b ? b.pegs : [];
}

function maxPairDist(pts) {
  let m = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      m = Math.max(m, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
    }
  }
  return m;
}

function fail(reason, need, empty) {
  return { ok: false, reason, need, empty: empty || [], bands: [], base: null,
           warnings: [], notes: [], holeCount: 0 };
}

// 修到 0.01cm。順手把 −0 換成 0 —— 那是浮點數的東西，
// 顯示在座標上只會讓人以為算錯了。
const snap = v => { const x = Math.round(v * 100) / 100; return x === 0 ? 0 : x; };
const r2 = v => Math.round(v * 100) / 100;
