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
    cur = { pts: [{ x: nx, y: ny }], closed: false };
    subpaths.push(cur);
    sx = nx; sy = ny;
  };
  const push = (nx, ny) => {
    if (!cur) start(x, y);
    const last = cur.pts[cur.pts.length - 1];
    // 同一個點連著出現沒有意義，而且會讓後面的繞向計算除以零
    if (Math.abs(last.x - nx) > 1e-12 || Math.abs(last.y - ny) > 1e-12) {
      cur.pts.push({ x: nx, y: ny });
    }
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
      case 'L': {
        const nx = num(), ny = num();
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        push(x, y);
        px = py = null;
        break;
      }
      case 'H': {
        const nx = num();
        x = rel ? x + nx : nx;
        push(x, y);
        px = py = null;
        break;
      }
      case 'V': {
        const ny = num();
        y = rel ? y + ny : ny;
        push(x, y);
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
        for (const p of flattenCubic(x, y, c1x, c1y, c2x, c2y, ex, ey, tol)) push(p.x, p.y);
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
        for (const p of flattenQuad(x, y, cx, cy, ex, ey, tol)) push(p.x, p.y);
        px = cx; py = cy;
        x = ex; y = ey;
        break;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num();
        const large = num(), sweep = num();
        const a2 = num(), b2 = num();
        const ex = rel ? x + a2 : a2, ey = rel ? y + b2 : b2;
        for (const p of flattenArc(x, y, rx, ry, rot, large, sweep, ex, ey, tol)) {
          push(p.x, p.y);
        }
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
            cur.pts.push({ x: sx, y: sy });
          }
          // 收尾之後，起點與終點是同一個點，存的時候不重複存
          if (cur.pts.length > 1) {
            const f = cur.pts[0], l2 = cur.pts[cur.pts.length - 1];
            if (Math.abs(f.x - l2.x) < 1e-9 && Math.abs(f.y - l2.y) < 1e-9) cur.pts.pop();
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

  return {
    subpaths: subpaths.filter(s => s.pts.length >= 2),
    cmds: [...used].join(''),
    errors
  };
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
  rx = Math.abs(rx); ry = Math.abs(ry);
  // 半徑是 0 ＝ 退化成直線，規格明講要這樣處理
  if (rx < 1e-12 || ry < 1e-12) return [{ x: x1, y: y1 }];

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

  /**
   * 每一段最多轉幾度，由弦高決定：半徑 r 的弧轉 θ，弦高 ＝ r(1−cos(θ/2))。
   * 反過來 θ ＝ 2·acos(1 − tol/r)。橢圓取長軸算，是保守的一邊。
   */
  const r = Math.max(rx, ry);
  const step = tol >= r ? Math.PI : 2 * Math.acos(Math.max(-1, 1 - tol / r));
  const n = Math.max(1, Math.ceil(Math.abs(dth) / step));

  const out = [];
  for (let k = 1; k <= n; k++) {
    const t = th0 + dth * (k / n);
    const ex = rx * Math.cos(t), ey = ry * Math.sin(t);
    out.push({ x: cosP * ex - sinP * ey + cx, y: sinP * ex + cosP * ey + cy });
  }
  // 收尾用給定的終點，避免浮點誤差讓路徑接不起來
  out[out.length - 1] = { x: x1, y: y1 };
  return out;
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
