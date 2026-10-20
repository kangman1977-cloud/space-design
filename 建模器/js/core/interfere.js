/**
 * interfere.js — 干涉檢查：哪幾對零件穿進彼此裡面（綜合評估 ④-20，2026-10-20，kang「照建議」）
 *
 * ── kang 照建議定的四件事 ─────────────────────────────
 * ① **查哪些**：沒選（或只選一個）⇒ 全部；選了兩個以上 ⇒ 只查選到的（SolidWorks、Fusion 360 同一套）。
 * ② **只是貼在一起⛔ 算**：重疊的體積不到 `CLASH_MIN_VOL`、或範圍最薄的那一邊不到 `CLASH_MIN_DEPTH` ⇒ 當成貼著
 * 　 （兩套軟體預設也是⛔ 算；隔板站在盒底上不該被列出來）。只數幾對，⛔ 列。
 * ③ **板件照板厚算**：開放的網格（平板、折板）用跟畫面同一套 `mesh.shell(板厚)` 加厚成實體再算
 * 　 （`view/scene.js` `_shellThickness()` 的條件照抄 —— 畫面上看到多厚就算多厚）。
 * ④ 重疊那一塊畫成紅色 —— 在 `main.js`／`view/scene.js`，這一支只把那一塊交出去。
 *
 * ⚠ 陣列、布林做出來的物件整個算一個零件 ⇒ 它自己裡面的各份互相疊到⛔ 查。
 * ⭐ 先比外框（便宜）、外框真的有重疊的那幾對才做布林（貴）。
 * 單位一律 cm。
 */
import { overlapOf, csgReady } from '../build/bool.js';

/** 重疊體積小於這個 ⇒ 當成「貼在一起」（cm³） */
export const CLASH_MIN_VOL = 1e-3;
/** 重疊範圍最薄的那一邊小於這個 ⇒ 當成「貼在一起」（cm；數字捨入、面碰面算出來的薄片） */
export const CLASH_MIN_DEPTH = 0.01;
/** 跟畫面同一個門檻：面數太多的板件畫面上不加厚，這裡也⛔ 加（`scene.js` `_shellThickness()`） */
const SHELL_MAX_FACES = 20000;

/**
 * 這個物件拿來算干涉的**世界座標實體**。
 * @returns {{ok:boolean, mesh?:import('./mesh.js').Mesh, reason?:string, shelled?:boolean}}
 */
export function solidForClash(obj) {
  let m;
  try { m = obj.mesh(); }
  catch (e) { return { ok: false, reason: '形狀算不出來：' + (e.message || String(e)) }; }
  if (!m || !m.faces || !m.faces.length) return { ok: false, reason: '沒有形狀' };
  let local = m, shelled = false;
  if (!m.isClosed()) {
    const t = Number(obj.thickness) || 0;
    if (t <= 1e-6) return { ok: false, reason: '開放的面、板厚是 0 —— 沒有厚度算不出重疊' };
    if (m.faces.length > SHELL_MAX_FACES) return { ok: false, reason: `面太多（${m.faces.length}），加厚不了` };
    try { local = m.shell(t); shelled = true; }
    catch (e) { return { ok: false, reason: '照板厚加厚失敗：' + (e.message || String(e)) }; }
  }
  return { ok: true, mesh: local.transformed(obj.matrix()), shelled };
}

const boxOf = mesh => mesh.bounds();
/** 兩個外框在三個方向都重疊超過門檻才有可能穿到 */
const boxGap = (p, q, k) => Math.min(p.max[k], q.max[k]) - Math.max(p.min[k], q.min[k]);
const boxesMeet = (p, q) => ['x', 'y', 'z'].every(k => boxGap(p, q, k) > CLASH_MIN_DEPTH);
/** 外框碰在一起（某一邊剛好貼著或只疊一點點）⇒ 算「貼在一起」的那幾對 */
const boxesTouch = (p, q) => ['x', 'y', 'z'].every(k => boxGap(p, q, k) > -1e-6);

/**
 * 找出穿到的每一對。
 * @param {Array} objs 要查的物件（`ModelObject`）
 * @returns {{ok:boolean, reason?:string, list?:Array<{a, b, volume:number, size:number[], depth:number, mesh}>,
 *           pairs?:number, touching?:number, skipped?:Array<{name:string, reason:string}>}}
 */
export function findClashes(objs) {
  if (!csgReady()) return { ok: false, reason: '布林運算函式庫還沒載入完成，等一下再按' };
  if (!objs || objs.length < 2) return { ok: false, reason: '至少要有兩個物件才查得了' };
  const solids = [], skipped = [];
  for (const o of objs) {
    const s = solidForClash(o);
    if (s.ok) solids.push({ obj: o, mesh: s.mesh, box: boxOf(s.mesh) });
    else skipped.push({ name: o.name, reason: s.reason });
  }
  const list = [];
  let pairs = 0, touching = 0;
  for (let i = 0; i < solids.length; i++) {
    for (let j = i + 1; j < solids.length; j++) {
      const A = solids[i], B = solids[j];
      if (!boxesMeet(A.box, B.box)) {
        if (boxesTouch(A.box, B.box)) touching++;
        continue;
      }
      pairs++;
      let r;
      try { r = overlapOf(A.mesh, B.mesh, A.obj.name, B.obj.name); }
      catch (e) {
        skipped.push({ name: `${A.obj.name} × ${B.obj.name}`, reason: '算不出重疊：' + (e.message || String(e)) });
        continue;
      }
      if (!r.mesh) continue;
      const bb = r.mesh.bounds();
      const size = ['x', 'y', 'z'].map(k => bb.max[k] - bb.min[k]);
      const depth = Math.min(...size);
      if (r.volume < CLASH_MIN_VOL || depth < CLASH_MIN_DEPTH) { touching++; continue; }
      list.push({ a: A.obj, b: B.obj, volume: r.volume, size, depth, mesh: r.mesh });
    }
  }
  list.sort((p, q) => q.volume - p.volume);
  return { ok: true, list, pairs, touching, skipped, checked: solids.length };
}

/** 講給人看的一行（面板列表用；⛔ 文件寫法） */
export function clashLine(c) {
  const f = v => (Math.round(v * 100) / 100).toString();
  return `「${c.a.name}」×「${c.b.name}」：重疊 ${f(c.volume)} cm³（範圍 ${c.size.map(f).join(' × ')} cm）`;
}
