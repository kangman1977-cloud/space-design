/**
 * obj.js — 匯出 Wavefront OBJ（網格核心第五批 a，2026-10-23 → `規格\建模器-網格核心.md` 第 8 節；
 * kang「照你的建議：第五批拆開，先做匯出 OBJ，預設照你寫的」）。
 *
 * ── 它拿來做什麼 ──────────────────────────────────────
 * 讓 Blender、Rhino、SketchUp 讀得進建模器做的模型（kang：建模器要能「吃」業界的模型，也要讓業界讀得進來）。
 * STL 只有三角形、沒有物件名字；OBJ 帶多邊形、物件名字、平滑群組。
 *
 * ── 寫什麼、不寫什麼 ──────────────────────────────────
 * · 每個物件一個 `o`（名字）；每個小面一個 `f` —— **多邊形照原樣**（Blender 匯出的預設也是
 * 　`export_triangulated_mesh=False`）；`triangulate` 打開才全部拆成三角形（給只認三角形的軟體）。
 * · 有洞的面照它的小面寫（OBJ 規定一個面不能帶洞；建模器有洞的面本來就是幾個小面＋看不見的邊）。
 * · 標了 `smooth` 的邊連起來的那幾片 ⇒ 一個平滑群組（`s 1`、`s 2`…），其他 `s off`。
 * · **單位**：OBJ 檔沒有單位欄位 ⇒ 照選的單位換算、寫在檔頭註解；預設 mm（跟 STL、DXF 一樣）。
 * 　Blender 讀 OBJ 把 1 當 1 公尺 ⇒ 給 Blender 選 m。
 * · **Y 朝上**：建模器本來就是 Y 朝上，⛔ 轉（OBJ 慣例、Blender 匯入的預設 `up_axis='Y'`）。
 * · ⛔ 帶：切開／折、不准切、參數、做法歷程（業界的軟體看不懂，留在專案檔）；⛔ 寫法向（Blender 自己會重算）。
 */
import * as THREE from 'three';

/** 建模器內部是 cm ⇒ 乘多少變成這個單位 */
export const OBJ_UNITS = {
  mm: { scale: 10, label: 'mm（公釐）' },
  cm: { scale: 1, label: 'cm（公分）' },
  m:  { scale: 0.01, label: 'm（公尺）—— 給 Blender 用選這個' },
  in: { scale: 1 / 2.54, label: 'in（英吋）' }
};

const fmt = v => {
  const s = (Math.round(v * 1e6) / 1e6).toString();
  return s === '-0' ? '0' : s;
};

/** OBJ 的名字是那一行剩下的全部 ⇒ ⛔ 換行；空的給一個 */
const objName = s => (String(s || '').replace(/[\r\n]+/g, ' ').trim() || '物件');

/**
 * 平滑群組：從一個小面出發、只穿過 `smooth` 的邊走得到的那幾片 ＝ 一群；碰不到任何 `smooth` 邊的面 ⇒ 0（`s off`）。
 * @returns {Map<Face, number>} 面 → 這個網格裡第幾群（從 1 起）；0 ＝ 不平滑
 */
export function smoothGroups(mesh) {
  const out = new Map();
  let n = 0;
  for (const f of mesh.faces) {
    if (out.has(f)) continue;
    if (!mesh.faceLoop(f).some(he => he.smooth && he.twin && he.twin.face)) { out.set(f, 0); continue; }
    n++;
    const stack = [f];
    out.set(f, n);
    while (stack.length) {
      const g = stack.pop();
      for (const he of mesh.faceLoop(g)) {
        const t = he.twin && he.twin.face;
        if (!he.smooth || !t || out.has(t)) continue;
        out.set(t, n);
        stack.push(t);
      }
    }
  }
  return out;
}

/**
 * 把幾個物件寫成一份 OBJ 文字。
 * @param {Array<{name:string, mesh:Mesh, matrix?:THREE.Matrix4}>} items 網格是本地座標、`matrix` 是物件的擺放
 * @param {{unit?:'mm'|'cm'|'m'|'in', triangulate?:boolean, date?:string}} [opt]
 * @returns {{text:string, objects:number, verts:number, faces:number, groups:number, unit:string}}
 */
export function toOBJ(items, opt = {}) {
  const unit = OBJ_UNITS[opt.unit] ? opt.unit : 'mm';
  const s = OBJ_UNITS[unit].scale;
  const tri = !!opt.triangulate;
  const lines = [
    `# 建模器匯出的 OBJ${opt.date ? `（${opt.date}）` : ''}`,
    `# 單位：${unit}（OBJ 本身沒有單位欄位；Blender 讀進來把 1 當 1 公尺 ⇒ 給 Blender 用請匯出成 m）`,
    '# 座標：Y 朝上（OBJ 慣例；Rhino 匯入請選「OBJ 的 Y 當 Rhino 的 Z」）',
    `# 面：${tri ? '全部拆成三角形' : '多邊形照原樣'}；有洞的面照它的小面寫`
  ];
  let base = 0, nv = 0, nf = 0, ng = 0;
  const p = new THREE.Vector3();
  for (const it of items) {
    const m = it.mesh;
    if (!m || !m.faces.length) continue;
    lines.push(`o ${objName(it.name)}`);
    const idx = new Map();
    m.verts.forEach((v, i) => {
      p.copy(v.p);
      if (it.matrix) p.applyMatrix4(it.matrix);
      p.multiplyScalar(s);
      idx.set(v, base + i + 1);
      lines.push(`v ${fmt(p.x)} ${fmt(p.y)} ${fmt(p.z)}`);
    });
    base += m.verts.length;
    nv += m.verts.length;
    /** 同一群的面排在一起寫，`s` 只在換群時寫一次 */
    const grp = smoothGroups(m);
    const order = [...m.faces].sort((a, b) => grp.get(a) - grp.get(b));
    let cur = null;
    for (const f of order) {
      const g = grp.get(f);
      const tag = g ? String(ng + g) : 'off';
      if (tag !== cur) { lines.push(`s ${tag}`); cur = tag; }
      const polys = tri ? m.faceTriangles(f) : [m.faceVerts(f)];
      for (const poly of polys) { lines.push('f ' + poly.map(v => idx.get(v)).join(' ')); nf++; }
    }
    ng += Math.max(0, ...grp.values());
  }
  return { text: lines.join('\n') + '\n', objects: items.filter(it => it.mesh && it.mesh.faces.length).length, verts: nv, faces: nf, groups: ng, unit };
}
