/**
 * propose.js — 智慧分切：程式提案縫（2026-10-13，第一步 → `規格\建模器-智慧分切.md`）
 *
 * kang 選的是「**程式提案、我決定**」：這裡只**算出建議**，⛔ 改任何一條邊 ——
 * 改是使用者按「全部接受」之後，`main.js` 照提案一條一條 `setSeam()`。
 * 純函式、⛔ 碰畫面 ⇒ 測試裡直接驗。
 *
 * ── 第一步的提案 ＝ 程式本來就會補剪的那幾刀 ──────────────────
 * 用**精確分片**攤一次（智慧分切先做不能拉的材料 —— `外部參考-自動分切.md` 第 5 節 Q1），
 * 攤平時「先走最平的邊」走不到的邊（圖上橘色那幾條）就是提案；它們已經繞開「不准切」
 * （`flatten.js` 攤平時不准切排最前面）。
 * ⭐ 接受之後那幾條變成使用者的縫，再攤一次會是**同樣的片**、程式補剪 0 條（測試守著）。
 * ⚠ **第一步還不會為了板子多切**（那是第二步）—— 放不進就照實講，⛔ 讓人以為程式判斷過了。
 *
 * ⚠ 第一步⛔ 照判準挑切法（沿轉角、連成長線、片少、縫短）——
 * 現在的「先走最平的邊」本來就把轉角留到最後剪（量過：方塊 100% 在轉角），其餘是第二、三步的事。
 */

import { unfoldObject } from './part.js';
import { isMarkable, markSignature } from './seam.js';

const EPS = 1e-6;

/**
 * @param {object} obj 已轉成可編輯網格的物件
 * @param {object} opt `{ material, board: { w, h, rotate } }`（材料、板子照展開圖視窗與排版設定）
 * @returns {{
 *   edges: HalfEdge[],      提案的邊（物件自己那份網格上、可以標的）
 *   unmarkable: number,     補剪的邊裡有幾條標不上（共面的邊 —— 接受時會跳過，要講）
 *   total: number,          接受之後展開幾片
 *   maxPiece: {w, h}|null,  最大一片的外框
 *   big: number,            幾片放不進板子
 *   keepCut: number,        標了不准切、還是非切不可的條數
 *   board: {w, h, rotate},
 *   sig: string,            提案當時的標記指紋（對不上 ⇒ 提案收起來）
 *   mesh                    提案當時的網格（換了 ⇒ 提案收起來）
 * }}
 */
export function proposeSeams(obj, opt = {}) {
  const board = { w: 240, h: 120, rotate: false, ...(opt.board || {}) };
  const r = unfoldObject(obj, { material: opt.material, mode: 'exact' });
  const mesh = obj.mesh();
  const auto = r.autoEdges || [];
  const edges = auto.filter(he => isMarkable(mesh, he));

  const fits = p => (p.width <= board.w + EPS && p.height <= board.h + EPS)
    || (board.rotate && p.height <= board.w + EPS && p.width <= board.h + EPS);
  let maxPiece = null;
  for (const p of r.pieces) {
    if (!maxPiece || p.width * p.height > maxPiece.w * maxPiece.h) maxPiece = { w: p.width, h: p.height };
  }

  return {
    edges,
    unmarkable: auto.length - edges.length,
    total: r.stats.total,
    maxPiece,
    big: r.pieces.filter(p => !fits(p)).reduce((n, p) => n + p.qty, 0),
    keepCut: r.keepCut || 0,
    board,
    sig: markSignature(mesh),
    mesh
  };
}
