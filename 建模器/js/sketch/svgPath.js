/**
 * svgPath.js — 把 SVG 的路徑轉成折線
 *
 * 只做一件事：讀 `<path>` 的 `d` 屬性，把裡面的直線、貝茲曲線、圓弧
 * 攤平成一串點。**不碰 DOM、不碰檔案、不知道單位是什麼**，
 * 所以整支在 Node 裡用數學對得了答案。
 *
 * ── 為什麼不用瀏覽器內建的 SVG 解析 ──────────────────────
 * 瀏覽器有 `SVGPathElement.getPointAtLength()`，拿來取樣很方便，
 * 而且一定「正確」。但那樣這一段就只能在瀏覽器裡跑 ——
 * 而這個專案的規矩是：**能用數學驗的就一定要驗**（沙箱開不了瀏覽器）。
 *
 * 自己寫兩百行，換來的是圓的周長對不對得上 2πr、弦高誤差有沒有超標，
 * 這些都在回歸測試裡盯著。出錯的時候測試會擋下來，
 * 而不是等 kang 切完料才發現。
 *
 * ── 攤平的精度用「弦高誤差」表示，不是「切幾段」──────────
 * 「切 16 段」是憑感覺的數字，同一個設定套在 5mm 的小圓角和 2m 的大弧上
 * 意義完全不同。弦高（sagitta）＝ 弧線跟它的弦最遠差多少，
 * **是個看得懂、量得到的長度**，直接對應「這個轉角做出來會不會有稜」。
 * 跟坑第 26 條同一條教訓：判準要挑有物理意義的量。
 *
 * 單位是「SVG 的使用者單位」，換算成 cm 是 profile.js 的事。
 */

/** 預設弦高誤差。單位是 SVG 使用者單位，由呼叫端換算過再傳進來。 */
export const DEFAULT_TOL = 0.2;

/**
 * 幾度以上算「真轉角」。
 *
 * ── 這個旗標是這支檔案最值錢的產出，比座標還值錢 ──────────
 * 貝茲曲線的錨點**自己知道**它是平滑點還是轉角：平滑點的進出控制把手
 * 是共線的，轉角才會岔開。攤平成折線之後這個資訊就沒了 ——
 * 剩下一串一模一樣的頂點，下游只能從角度大小去猜。
 *
 * 實測 kang 的一個 S 字外框：真轉角 9 個，但攤平後有 196 個轉折點。
 * 下游（展開圖）因此標了 196 道折彎、398 個接合編號，整張圖變成一團綠色。
 * 帶著這個旗標的話，展開就自動是「9 道折線、10 段」。
 *
 * **這不是演算法問題，是資訊問題。** 上游知道的事，不要在中途丟掉。
 * （對照坑第 10 條：那次是資訊真的不存在，所以只能保守；這次是我丟掉的。）
 *
 * 3° 這個值抄自 kang 已經在用的 `SideUnfold.jsx`——
 * 那支程式產出的圖他驗過很多次了，沒有理由另外發明一個數字。
 */
export const DEFAULT_CORNER_DEG = 3;

/** 遞迴細分的上限。防呆用，正常的路徑遠遠用不到。 */
const MAX_DEPTH = 20;

/**
 * 解析一條 `d` 屬性。
 *
 * @param {string} d
 * @param {object} opt { tol } 弦高誤差
 * @returns {{subpaths:Array, cmds:string, errors:Array}}
 *   subpaths 每個是 { pts:[{x,y}], closed:boolean }
 */
export function parsePath(d, opt = {}) {
  const tol = opt.tol > 0 ? opt.tol : DEFAULT_TOL;
  const cornerDeg = opt.cornerDeg >= 0 ? opt.cornerDeg : DEFAULT_CORNER_DEG;
  const tokens = tokenize(String(d || ''));
  const subpaths = [];
  const errors = [];
  const used = new Set();

  let cur = null;                 // 目前這條子路徑
  let x = 0, y = 0;               // 目前位置
  let sx = 0, sy = 0;             // 這條子路徑的起點（Z 要回到這裡）
  let px = null, py = null;       // 上一段曲線的控制點，S/T 接續要用
  let lastCmd = '';

  const start = (nx, ny) => {
    cur = { pts: [{ x: nx, y: ny, corner: false }], closed: false, anch: [] };
    cur.anch.push({ i: 0, inT: null, outT: null });
    subpaths.push(cur);
    sx = nx; sy = ny;
  };
  const push = (nx, ny) => {
    if (!cur) start(x, y);
    const last = cur.pts[cur.pts.length - 1];
    // 同一個點連著出現沒有意義，而且會讓後面的繞向計算除以零
    if (Math.abs(last.x - nx) > 1e-12 || Math.abs(last.y - ny) > 1e-12) {
      cur.pts.push({ x: nx, y: ny, corner: false });
    }
  };

  /**
   * ── 錨點與切線 ──────────────────────────────────────
   * 只有**錨點**（指令的起訖點）才可能是轉角；中間細分出來的點永遠不是。
   * `segOut` 記下離開目前錨點的切線，`segIn` 記下抵達新錨點的切線，
   * 兩者比一比就知道那個錨點是平滑點還是轉角。
   */
  const segOut = (tx, ty) => {
    if (!cur) start(x, y);
    const a = cur.anch[cur.anch.length - 1];
    if (a) a.outT = [tx, ty];
  };
  const segIn = (tx, ty) => {
    if (!cur) return;
    cur.anch.push({ i: cur.pts.length - 1, inT: [tx, ty], outT: null });
  };

  let i = 0;
  const num = () => {
    const v = tokens[i++];
    if (typeof v !== 'number') { errors.push(`「${lastCmd}」後面的數字不夠`); return 0; }
    return v;
  };

  while (i < tokens.length) {
    let cmd = tokens[i];
    if (typeof cmd === 'number') {
      /**
       * 數字直接接在後面 ＝ 重複上一個指令（SVG 的隱含重複規則）。
       * M 後面重複的是 L、m 後面重複的是 l —— 這一條漏掉的話，
       * 多邊形會少掉除了第一個點以外的**所有**點，
       * 而且畫面上只剩一條線，很容易被當成「檔案有問題」。
       */
      cmd = lastCmd === 'M' ? 'L' : (lastCmd === 'm' ? 'l' : lastCmd);
      if (!cmd) { errors.push('路徑不是以指令開頭'); break; }
    } else {
      i++;
    }
    used.add(cmd);
    const rel = cmd >= 'a' && cmd <= 'z';
    const C = cmd.toUpperCase();

    switch (C) {
      case 'M': {
        const nx = num(), ny = num();
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        start(x, y);
        px = py = null;
        break;
      }
      case 'L': case 'H': case 'V': {
        let nx = x, ny = y;
        if (C === 'L') { const a = num(), b = num(); nx = rel ? x + a : a; ny = rel ? y + b : b; }
        else if (C === 'H') { const a = num(); nx = rel ? x + a : a; }
        else { const b = num(); ny = rel ? y + b : b; }
        segOut(nx - x, ny - y);
        push(nx, ny);
        segIn(nx - x, ny - y);       // 直線的進出切線是同一個方向
        x = nx; y = ny;
        px = py = null;
        break;
      }
      case 'C': case 'S': {
        let c1x, c1y;
        if (C === 'S') {
          // 平滑接續：第一個控制點是「上一段的第二控制點對目前點的鏡射」
          if (lastCmd && 'CScs'.includes(lastCmd) && px !== null) {
            c1x = 2 * x - px; c1y = 2 * y - py;
          } else { c1x = x; c1y = y; }
        } else {
          const a = num(), b = num();
          c1x = rel ? x + a : a; c1y = rel ? y + b : b;
        }
        const a2 = num(), b2 = num(), a3 = num(), b3 = num();
        const c2x = rel ? x + a2 : a2, c2y = rel ? y + b2 : b2;
        const ex = rel ? x + a3 : a3, ey = rel ? y + b3 : b3;
        // 控制點跟端點重合時（直線化的貝茲）退而用弦當切線
        segOut(...pick(c1x - x, c1y - y, c2x - x, c2y - y, ex - x, ey - y));
        for (const p of flattenCubic(x, y, c1x, c1y, c2x, c2y, ex, ey, tol)) push(p.x, p.y);
        segIn(...pick(ex - c2x, ey - c2y, ex - c1x, ey - c1y, ex - x, ey - y));
        px = c2x; py = c2y;
        x = ex; y = ey;
        break;
      }
      case 'Q': case 'T': {
        let cx, cy;
        if (C === 'T') {
          if (lastCmd && 'QTqt'.includes(lastCmd) && px !== null) {
            cx = 2 * x - px; cy = 2 * y - py;
          } else { cx = x; cy = y; }
        } else {
          const a = num(), b = num();
          cx = rel ? x + a : a; cy = rel ? y + b : b;
        }
        const a2 = num(), b2 = num();
        const ex = rel ? x + a2 : a2, ey = rel ? y + b2 : b2;
        segOut(...pick(cx - x, cy - y, ex - x, ey - y));
        for (const p of flattenQuad(x, y, cx, cy, ex, ey, tol)) push(p.x, p.y);
        segIn(...pick(ex - cx, ey - cy, ex - x, ey - y));
        px = cx; py = cy;
        x = ex; y = ey;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num();
        const large = num(), sweep = num();
        const a2 = num(), b2 = num();
        const ex = rel ? x + a2 : a2, ey = rel ? y + b2 : b2;
        /**
         * 圓弧的切線用**解析式**算，不用第一段弦去估。
         * 粗略取樣時第一段弦的方向會偏掉半個分段角，而轉角門檻只有 3°——
         * 用弦估的話，一段大圓弧的起點會被誤判成轉角。
         */
        const t = arcTangents(x, y, rx, ry, rot, large, sweep, ex, ey);
        segOut(t.t0[0], t.t0[1]);
        for (const p of flattenArc(x, y, rx, ry, rot, large, sweep, ex, ey, tol)) {
          push(p.x, p.y);
        }
        segIn(t.t1[0], t.t1[1]);
        px = py = null;
        x = ex; y = ey;
        break;
      }
      case 'Z': {
        if (cur) {
          cur.closed = true;
          /**
           * Z 是「回到子路徑起點」。攤平之後最後一個點若已經跟起點重合，
           * 就不要再補一次 —— 重複的點會讓面積公式多算一段長度 0 的邊，
           * 值是對的，但點數對不上，測試會不好寫。
           */
          const last = cur.pts[cur.pts.length - 1];
          if (Math.abs(last.x - sx) > 1e-9 || Math.abs(last.y - sy) > 1e-9) {
            segOut(sx - x, sy - y);            // 隱含的一段直線回到起點
            cur.pts.push({ x: sx, y: sy, corner: false });
            segIn(sx - x, sy - y);
          }
          /**
           * 收尾之後起點與終點是同一個點，只存一份。
           * **那個被丟掉的錨點帶著「進來的切線」，要交給第一個錨點** ——
           * 不交的話，起點永遠沒有 inT，就會被當成開放端點、一律算轉角。
           * 一個閉合的圓因此會多出一個假的折線。
           */
          if (cur.pts.length > 1) {
            const f = cur.pts[0], l2 = cur.pts[cur.pts.length - 1];
            if (Math.abs(f.x - l2.x) < 1e-9 && Math.abs(f.y - l2.y) < 1e-9) {
              cur.pts.pop();
              const la = cur.anch[cur.anch.length - 1];
              if (la && la.i === cur.pts.length) {
                cur.anch.pop();
                if (cur.anch[0]) cur.anch[0].inT = la.inT;
              }
            }
          }
        }
        x = sx; y = sy;
        cur = null;              // 下一個指令要另起一條（SVG 規定 Z 之後回到起點）
        px = py = null;
        break;
      }
      default:
        errors.push(`看不懂的指令「${cmd}」`);
        i = tokens.length;
        break;
    }
    lastCmd = cmd;
  }

  const out = subpaths.filter(s => s.pts.length >= 2);
  for (const sp of out) markCorners(sp, cornerDeg);

  return {
    subpaths: out,
    cmds: [...used].join(''),
    errors,
    corners: out.reduce((n, s) => n + s.pts.filter(p => p.corner).length, 0)
  };
}

/**
 * 判定每個錨點是不是真轉角，並把旗標寫回點上。
 *
 * 判準跟 kang 的 `SideUnfold.jsx` 一樣：比較「進來的切線」與「出去的切線」。
 * 平滑點的兩條切線共線（夾角 0），轉角才會岔開。
 *
 * 開放路徑的頭尾一律算轉角 —— 那裡本來就是形狀的端點。
 */
function markCorners(sp, deg) {
  for (const a of sp.anch) {
    if (a.i < 0 || a.i >= sp.pts.length) continue;
    if (!a.inT || !a.outT) {
      if (!sp.closed) sp.pts[a.i].corner = true;   // 開放路徑的端點
      continue;
    }
    if (Math.abs(turnDeg(a.inT, a.outT)) >= deg) sp.pts[a.i].corner = true;
  }
}

/** 從方向 u 轉到方向 v 轉了幾度（−180 ~ 180）。 */
export function turnDeg(u, v) {
  if (!u || !v) return 0;
  if (Math.hypot(u[0], u[1]) < 1e-12 || Math.hypot(v[0], v[1]) < 1e-12) return 0;
  let d = Math.atan2(v[1], v[0]) - Math.atan2(u[1], u[0]);
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d * 180 / Math.PI;
}

/** 依序挑第一個不是零向量的，當切線用。控制點跟端點重合時要退而求其次。 */
function pick(...v) {
  for (let i = 0; i + 1 < v.length; i += 2) {
    if (Math.hypot(v[i], v[i + 1]) > 1e-12) return [v[i], v[i + 1]];
  }
  return [1, 0];
}

// ═══════════════════════════════════════════════════════
//  切詞
// ═══════════════════════════════════════════════════════

/**
 * 把 `d` 切成「指令字母」與「數字」的序列。
 *
 * SVG 的數字寫法比看起來麻煩：`1-2` 是兩個數（負號當分隔）、
 * `.5.5` 也是兩個數（第二個點開始就是下一個數）、還有 `1e-3` 這種指數。
 * Illustrator 為了省位元組**一定**會用這些寫法，
 * 用 `split(/[\s,]/)` 那種切法會靜靜地少掉一半的數字。
 */
function tokenize(d) {
  const out = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(d)) !== null) {
    if (m[1]) out.push(m[1]);
    else out.push(parseFloat(m[2]));
  }
  return out;
}

// ═══════════════════════════════════════════════════════
//  攤平
// ═══════════════════════════════════════════════════════

/**
 * 三次貝茲攤平。用遞迴細分，判準是**控制點離弦最遠有多少**。
 *
 * 為什麼用這個判準：貝茲曲線一定落在它四個控制點圍出來的凸包裡，
 * 所以「控制點離弦很近」⇒「曲線離弦更近」。
 * 這是保守的估計 —— 寧可多切幾段，也不要少切之後才發現轉角有稜。
 *
 * 回傳**不含起點**（起點是上一段的終點，已經在串列裡了）。
 */
export function flattenCubic(x0, y0, x1, y1, x2, y2, x3, y3, tol, depth = 0) {
  if (depth < MAX_DEPTH && !isFlatCubic(x0, y0, x1, y1, x2, y2, x3, y3, tol)) {
    // de Casteljau 對半切
    const x01 = (x0 + x1) / 2, y01 = (y0 + y1) / 2;
    const x12 = (x1 + x2) / 2, y12 = (y1 + y2) / 2;
    const x23 = (x2 + x3) / 2, y23 = (y2 + y3) / 2;
    const xa = (x01 + x12) / 2, ya = (y01 + y12) / 2;
    const xb = (x12 + x23) / 2, yb = (y12 + y23) / 2;
    const xm = (xa + xb) / 2, ym = (ya + yb) / 2;
    return [
      ...flattenCubic(x0, y0, x01, y01, xa, ya, xm, ym, tol, depth + 1),
      ...flattenCubic(xm, ym, xb, yb, x23, y23, x3, y3, tol, depth + 1)
    ];
  }
  return [{ x: x3, y: y3 }];
}

/**
 * 🔴🔴 **三次貝茲【分割】—— 在參數 t 處切成【數學上等價】的兩段。**
 * （2026-08-29 加，鋼筆第 3 階段「加一個錨點」用）
 *
 * ⚠ **⛔ 這跟上面那支 `flattenCubic()` 的「細分」不是同一件事**：
 * | | 做什麼 | 資訊 |
 * |---|---|---|
 * | **細分** `flattenCubic` | 一段曲線 → **一串折線** | **掉了**（回不去） |
 * | **分割** 這一支 | 一段曲線 → **兩段曲線** | **一個點都不差** |
 *
 * ⭐ **那正是「加一個錨點」要的東西**：使用者的意思是
 * 「我要在這裡多一個**可以調**的點」，⛔ 不是「我要改形狀」。
 * 🔴 **判準因此驗得出來：加點前後【面積一格不變】。**
 *
 * 走的是 de Casteljau —— `flattenCubic()` 裡面那一段**寫死 `t=0.5`** 的版本，
 * 這裡把 `t` 開放出來。⛔ 不是另寫一套數學。
 *
 * @returns {{a:number[], b:number[], mid:{x:number,y:number}}}
 *          `a`／`b` 各 8 個數（x0,y0,x1,y1,x2,y2,x3,y3），`mid` ＝ 切點
 */
export function splitCubic(x0, y0, x1, y1, x2, y2, x3, y3, t) {
  const L = (a, b) => a + (b - a) * t;
  const x01 = L(x0, x1), y01 = L(y0, y1);
  const x12 = L(x1, x2), y12 = L(y1, y2);
  const x23 = L(x2, x3), y23 = L(y2, y3);
  const xa = L(x01, x12), ya = L(y01, y12);
  const xb = L(x12, x23), yb = L(y12, y23);
  const xm = L(xa, xb), ym = L(ya, yb);
  return {
    a: [x0, y0, x01, y01, xa, ya, xm, ym],
    b: [xm, ym, xb, yb, x23, y23, x3, y3],
    mid: { x: xm, y: ym }
  };
}

/** 三次貝茲在參數 t 處的點。⚠ 分割與擬合都要用，⛔ 不要各寫一份。 */
export function cubicAt(x0, y0, x1, y1, x2, y2, x3, y3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return { x: a * x0 + b * x1 + c * x2 + d * x3,
           y: a * y0 + b * y1 + c * y2 + d * y3 };
}

/**
 * 🔴 **曲線上離某一點最近的地方**（「點在線上 ＝ 加一個點」要用）。
 *
 * ⚠ **⛔ 沒有閉式解** —— 那是一個五次方程式。所以先粗取樣、再局部細化，
 * 這是標準做法。⭐ 24 段 ＋ 三輪細化，實際精度遠好過命中門檻（12 px）。
 *
 * @returns {{t:number, dist:number, p:{x:number,y:number}}}
 */
export function nearestOnCubic(px, py, x0, y0, x1, y1, x2, y2, x3, y3, samples = 24) {
  const at = t => cubicAt(x0, y0, x1, y1, x2, y2, x3, y3, t);
  const d2 = p => (p.x - px) * (p.x - px) + (p.y - py) * (p.y - py);
  let bt = 0, bd = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples, dd = d2(at(t));
    if (dd < bd) { bd = dd; bt = t; }
  }
  /**
   * 🔴🔴 **細化走【三分搜尋】，⛔ 不是「每輪把步長除以 4 再試兩邊」。**
   *
   * 〔2026-08-29 實測踩到，而且第一次的診斷也是錯的〕
   * ⚠ **那種寫法追不上初始誤差**：粗取樣的 `t` 最多差**半格**（≈ 0.021），
   * 而「步長每輪 /4」能移動的**總距離**是
   * 0.0104 ＋ 0.0026 ＋ … ≈ **0.0139 —— 比 0.021 小**。
   * 🔴 **所以⛔ 不管加幾輪都追不上**（我一開始以為三輪改六輪就好，那是錯的）。
   *
   * ⭐ 三分搜尋是**縮區間**，⛔ 不是「往旁邊試一步」——
   * 每輪區間 ×2/3，40 輪後 (2/3)⁴⁰ × (2/24) ≈ 1e-8，**跟初始誤差無關**。
   *
   * ⚠ 判準看**位置**⛔ 不看 `t`：`t` 差 0.0017 在那條測試曲線上
   * （速度約 60 cm／單位）**就是 0.1 cm**（坑第 26 條）。
   */
  let lo = Math.max(0, bt - 1 / samples), hi = Math.min(1, bt + 1 / samples);
  for (let k = 0; k < 40; k++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    if (d2(at(m1)) < d2(at(m2))) hi = m2; else lo = m1;
  }
  bt = (lo + hi) / 2;
  bd = d2(at(bt));
  return { t: bt, dist: Math.sqrt(bd), p: at(bt) };
}

/** 二次貝茲。升階成三次再走同一條路，不必另外寫一份細分。 */
export function flattenQuad(x0, y0, cx, cy, x1, y1, tol) {
  return flattenCubic(
    x0, y0,
    x0 + 2 / 3 * (cx - x0), y0 + 2 / 3 * (cy - y0),
    x1 + 2 / 3 * (cx - x1), y1 + 2 / 3 * (cy - y1),
    x1, y1, tol);
}

function isFlatCubic(x0, y0, x1, y1, x2, y2, x3, y3, tol) {
  const dx = x3 - x0, dy = y3 - y0;
  const L = Math.hypot(dx, dy);
  if (L < 1e-12) {
    // 起點與終點重合（整圈的貝茲）。此時弦沒有方向，改量控制點離起點多遠。
    return Math.hypot(x1 - x0, y1 - y0) <= tol && Math.hypot(x2 - x0, y2 - y0) <= tol;
  }
  const d1 = Math.abs((x1 - x0) * dy - (y1 - y0) * dx) / L;
  const d2 = Math.abs((x2 - x0) * dy - (y2 - y0) * dx) / L;
  return Math.max(d1, d2) <= tol;
}

/**
 * 圓弧（A 指令）攤平。
 *
 * SVG 的圓弧是「端點式」的：只給終點、半徑、要走大弧還是小弧、順時針還是逆時針。
 * 要取樣得先換算成「圓心式」（圓心、起訖角）。這一段是 SVG 規格附錄的標準做法，
 * 照著走就好 —— 自己另外發明一套的話，大弧／小弧那四種組合一定會有一種是錯的。
 */
export function flattenArc(x0, y0, rx, ry, rotDeg, large, sweep, x1, y1, tol) {
  const A = arcCenter(x0, y0, rx, ry, rotDeg, large, sweep, x1, y1);
  if (!A) return [{ x: x1, y: y1 }];

  /**
   * 每一段最多轉幾度，由弦高決定：半徑 r 的弧轉 θ，弦高 ＝ r(1−cos(θ/2))。
   * 反過來 θ ＝ 2·acos(1 − tol/r)。橢圓取長軸算，是保守的一邊。
   */
  const r = Math.max(A.rx, A.ry);
  const step = tol >= r ? Math.PI : 2 * Math.acos(Math.max(-1, 1 - tol / r));
  const n = Math.max(1, Math.ceil(Math.abs(A.dth) / step));

  const out = [];
  for (let k = 1; k <= n; k++) out.push(arcPoint(A, A.th0 + A.dth * (k / n)));
  // 收尾用給定的終點，避免浮點誤差讓路徑接不起來
  out[out.length - 1] = { x: x1, y: y1 };
  return out;
}

/**
 * 圓弧在起點與終點的切線方向。
 *
 * 用解析式算，不用第一段／最後一段的弦去估 —— 粗略取樣時弦的方向會偏掉
 * 半個分段角，而轉角門檻只有 3°，一段大圓弧的端點會被誤判成轉角。
 */
export function arcTangents(x0, y0, rx, ry, rotDeg, large, sweep, x1, y1) {
  const A = arcCenter(x0, y0, rx, ry, rotDeg, large, sweep, x1, y1);
  if (!A) return { t0: [x1 - x0, y1 - y0], t1: [x1 - x0, y1 - y0] };
  return { t0: arcTangent(A, A.th0), t1: arcTangent(A, A.th0 + A.dth) };
}

function arcPoint(A, t) {
  const ex = A.rx * Math.cos(t), ey = A.ry * Math.sin(t);
  return { x: A.cosP * ex - A.sinP * ey + A.cx, y: A.sinP * ex + A.cosP * ey + A.cy };
}

function arcTangent(A, t) {
  const dx = -A.rx * Math.sin(t), dy = A.ry * Math.cos(t);
  const s = A.dth >= 0 ? 1 : -1;
  return [s * (A.cosP * dx - A.sinP * dy), s * (A.sinP * dx + A.cosP * dy)];
}

/**
 * SVG 的「端點式」圓弧換算成「圓心式」。
 * 這一段是規格附錄的標準做法，照著走就好 —— 自己另外發明一套的話，
 * 大弧／小弧 × 順時針／逆時針那四種組合一定會有一種是錯的。
 */
function arcCenter(x0, y0, rx, ry, rotDeg, large, sweep, x1, y1) {
  rx = Math.abs(rx); ry = Math.abs(ry);
  // 半徑是 0 ＝ 退化成直線，規格明講要這樣處理
  if (rx < 1e-12 || ry < 1e-12) return null;

  const phi = rotDeg * Math.PI / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);

  const dx2 = (x0 - x1) / 2, dy2 = (y0 - y1) / 2;
  const x1p = cosP * dx2 + sinP * dy2;
  const y1p = -sinP * dx2 + cosP * dy2;

  // 半徑太小裝不下這兩個端點時，規格要求等比放大到剛好裝得下
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }

  const sign = (large !== sweep) ? 1 : -1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const co = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = co * (rx * y1p) / ry;
  const cyp = co * -(ry * x1p) / rx;

  const cx = cosP * cxp - sinP * cyp + (x0 + x1) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y1) / 2;

  const ang = (ux, uy, vx, vy) => {
    const d = (Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1;
    let a = Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy) / d)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const th0 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dth > 0) dth -= 2 * Math.PI;
  if (sweep && dth < 0) dth += 2 * Math.PI;

  return { cx, cy, rx, ry, cosP, sinP, th0, dth };
}

// ═══════════════════════════════════════════════════════
//  量測（測試與介面都要用）
// ═══════════════════════════════════════════════════════

/** 折線總長。閉合的話把回到起點那一段也算進去。 */
export function polyLength(pts, closed = false) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (closed && pts.length > 2) {
    L += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  }
  return L;
}

/** 鞋帶公式。逆時針為正（SVG 的 y 軸向下，所以視覺上會反過來）。 */
export function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}
