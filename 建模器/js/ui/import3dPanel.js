/**
 * import3dPanel.js — 匯入 3D 模型（STL／OBJ／GLB）當骨架（2026-10-21 → `規格\建模器-匯入3D模型.md`）
 *
 * 跟「匯入線稿」同一個想法：**這個視窗的主角是「這樣大小對嗎」**——STL、OBJ 檔裡都沒有寫單位，
 * 猜錯的話東西大十倍、小十倍，要做出來才發現。所以把換算後的長寬高用大字寫出來，
 * 不對就選單位，或直接打「整體高度其實是幾 cm」反算。
 * 另外多一個「哪一邊朝上」：3D 列印的檔常常 Z 朝上，建模器是 Y 朝上。
 *
 * 讀、清理、檢查都在 `build/import3d.js`；這裡只收設定、排結果、接按鈕。
 * 🔴 定位是「骨架」：匯進來之後用建模器改（kang 2026-10-21），⛔ 是主力。
 */

import * as THREE from 'three';
import { readModel, cleanModel, edgeCheck, guessUnit, guessUp, toParts, collapseShort, MICRO_DIV, UNIT_CM, UNIT_LABEL } from '../build/import3d.js';
import { judgePlanes, keptRegions, keepVerts, gridEdges, markGrid, PLANE_MODES } from '../build/importPlanes.js';
import { solidCheck, fillVariant, unionVariant, suggestSolid, SOLID_MODES } from '../build/importSolid.js';
import { shellFind, skinVariant, solidVariant, suggestShell, SHELL_MODES, AUTO_MAX_FACES } from '../build/importShell.js';
import { symmetryOf, symDecimate, SYM_ON, SYM_SHOW } from '../build/symmetry.js';
import { decimate, surfaceDev, CROSS_CAP } from '../build/decimate.js';
import { crossCheck } from '../out/printShape.js';
import { pairQuads } from '../build/quadify.js';
import { Mesh } from '../core/mesh.js';
import { ModelObject, KIND, recenterOrigin } from '../core/io.js';
import { worldBounds, unionBounds, freeSpot } from '../core/align.js';

const LS_KEY = 'modeler_import3d';
/** 面超過這麼多就提醒：分片、展開會慢 —— 可以用「減到 ___ 面」*/
const MANY_FACES = 20000;
/**
 * 面數那一區的三種（網格核心第五批 b ④；kang 2026-10-22 定、2026-10-24「第 ④ 小批照你的建議：減到 N 面時不保護格子、視窗用卡片、減到 N 面點了才算」）。
 * `clean` ＝ 清碎面：同一個門檻（最長邊 ÷ 500，或自己打的 mm）決定減多少、點放在誤差最小的位置（保形狀減面）
 */
export const FACE_MODES = { raw: '原樣（不減）', clean: '清碎面', reduce: '減到 ___ 面' };
/** 清碎面要減的超過這個比例 ⇒ 不自動清、建議原樣，要的話自己點（kang 10-22「超過一成停下來給 kang 看」）*/
export const CLEAN_MAX = 0.1;
/** 「減到 ___ 面」的快捷（kang 10-22 定）：3D 列印不減、剖面約 2 萬、展開紙模約 500 */
/** 三角形那一區（網格核心第五批 b ⑤；kang 10-22 定、10-23「只合平的」）*/
export const QUAD_MODES = { raw: '原樣（三角形）', pair: '兩兩合併' };
/**
 * 只留正面那一區的「正面朝」（建模器的方向：Y 朝上、+Z 朝前）；'' ＝ 自己猜（kang 2026-10-31 (b)）
 */
export const SHELL_FRONTS = { '+z': '前', '-z': '後', '+x': '右', '-x': '左', '+y': '上', '-y': '下' };
/**
 * 對稱減面的軸（建模器的方向）與兩半的名字：照 `[負的那一半, 正的那一半]`（kang 2026-10-31 (e)(f)：預設照左半（下、後））
 */
export const SYM_AXES = { x: ['左右', '左', '右'], y: ['上下', '下', '上'], z: ['前後', '後', '前'] };
export const REDUCE_PRESETS = [['給 3D 列印（不減）', 0], ['給剖面（約 2 萬面）', 20000], ['給展開、紙模（約 500 面）', 500]];

export class Import3DPanel {
  /** @param {object} app { doc, sel, onEdit, toast, view } */
  constructor(app) {
    this.app = app;
    /**
     * split ＝ 一個部分一個物件（預設，跟匯入線稿一樣）；〔micro ＝ 舊的「清掉極小的碎面」勾選 —— 第五批 b ④ 起改由面數那一區的卡片選，不再用〕；
     * planes ＝ 平面上的小塊怎麼辦（`PLANE_MODES`，預設照建議 —— 網格核心第五批 b ②）；
     * noCross ＝ 減到 ___ 面時不讓面互相穿過去（沒存過 ＝ 開；`_noCross()`）
     */
    this.opt = { split: true, planes: 'suggest', ...loadOpt() };
    this.fileName = '';
    this.read = null;            // 讀出來、清理過的
    this.unit = '';              // '' ＝ 照猜的
    this.up = '';                // '' ＝ 照猜的
    this.cmFix = 0;              // 手動校正：1 個檔案單位 ＝ 幾 cm；0 ＝ 照單位
    /** 碎面的門檻（mm）；0 ＝ 自動（最長邊 ÷ 500）。⛔ 記住：換一個模型大小就不一樣，換檔案清回自動 */
    this.microMm = 0;
    this._build();
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'import3dWin';
    el.className = 'uwWin';
    el.hidden = true;
    el.innerHTML = `
      <div class="uwBack"></div>
      <div class="uwBox">
        <div class="uwHead">
          <b>匯入 3D 模型</b>
          <span class="uwSum" id="i3Sum"></span>
          <button class="mini" id="i3Close" title="關閉：不匯入，關掉這個視窗">關閉</button>
        </div>
        <div class="uwBar">
          <button id="i3Pick" title="選檔案：從電腦挑一個 STL、OBJ 或 GLB 模型（先預覽，還不會放進畫面）">選檔案（.stl／.obj／.glb）…</button>
          <span class="lbl" id="i3File">還沒選檔案</span>
          <span class="sp"></span>
          <span class="lbl">單位</span>
          <select id="i3Unit"></select>
          <span class="lbl">朝上</span>
          <select id="i3Up"></select>
          <label class="uwCk"><input type="checkbox" id="i3Split"> 一個部分一個物件</label>
          <span class="sp"></span>
          <button id="i3Go" disabled title="匯入成網格物件：照上面的選擇放進畫面（先選檔才能按）">匯入成網格物件</button>
        </div>
        <div class="uwBody" id="i3Body"></div>
      </div>
      <input type="file" id="i3FileIn" accept=".stl,.obj,.glb,.gltf" hidden>`;
    document.body.appendChild(el);
    this.el = el;
    const $ = id => el.querySelector('#' + id);
    this.body = $('i3Body');
    this.sum = $('i3Sum');
    this.fileLbl = $('i3File');
    this.goBtn = $('i3Go');

    this.unitSel = $('i3Unit');
    this.unitSel.title = 'STL、OBJ 檔裡沒有寫單位，先照格式猜（STL ⇒ mm、GLB ⇒ m、OBJ 照大小猜）；看下面換算後的大小對不對';
    this.upSel = $('i3Up');
    this.upSel.title = '建模器是 Y 朝上；3D 列印的檔常常是 Z 朝上（站著的東西匯進來躺著 ⇒ 改這裡）';
    this.unitSel.onchange = () => { this.unit = this.unitSel.value; this.cmFix = 0; this._render(); };
    this.upSel.onchange = () => { this.up = this.upSel.value; this._render(); };

    this.splitIn = $('i3Split');
    this.splitIn.checked = this.opt.split !== false;
    this.splitIn.parentElement.title = '勾起來：檔案裡的每個部分（OBJ 的 o／g、GLB 的節點）變成一個物件，相對位置照原樣。'
      + '不勾：整個模型合成一個物件';
    this.splitIn.onchange = () => { this.opt.split = this.splitIn.checked; save(this.opt); this._render(); };

    const fin = $('i3FileIn');
    $('i3Pick').onclick = () => fin.click();
    fin.onchange = async () => {
      const f = fin.files && fin.files[0];
      if (!f) return;
      this.load(f.name, await f.arrayBuffer());
      fin.value = '';                     // 同一個檔再選一次也要觸發
    };
    $('i3Close').onclick = () => this.close();
    el.querySelector('.uwBack').onclick = () => this.close();
    this.goBtn.onclick = () => this._import();
    window.addEventListener('keydown', e => {
      if (!this.el.hidden && e.key === 'Escape') { e.stopImmediatePropagation(); this.close(); }
    });
  }

  open() { this.el.hidden = false; this._render(); }
  close() { this.el.hidden = true; }
  get isOpen() { return !this.el.hidden; }

  /** 讀一個檔（`ArrayBuffer`）；換檔案就把單位、朝上、校正清回「照猜的」*/
  load(name, buf) {
    this.fileName = name;
    this.fileLbl.textContent = name;
    this.unit = ''; this.up = ''; this.cmFix = 0; this.microMm = 0;
    const r = readModel(name, buf);
    this.read = r.ok ? { ...cleanModel(r), ok: true } : r;
    this._base = null;             // 拆好部分的原樣＋平面判斷（換檔案一定要清：鑰匙只有做法與拆法）
    this._solid = null;
    this.solidMode = '';           // '' ＝ 照建議（換檔案清回來）
    this._face = null;             // 面數那一區算好的（清碎面、減到 N 面）—— 換檔案清掉
    this.faceMode = '';            // '' ＝ 照建議
    this.reduceTarget = 0;         // 「減到 ___ 面」打的數字（0 ＝ 還沒打）
    this.quadMode = '';            // 三角形那一區：'' ＝ 照建議（兩兩合併）
    this._shell = null;            // 只留正面那一區算好的（換檔案清掉）
    this.shellMode = '';           // '' ＝ 照建議
    this.shellFront = '';          // '' ＝ 自己猜；否則 `SHELL_FRONTS` 的鍵（建模器的方向）
    this.shellFillBig = false;     // 實心：大的開口（像眼洞）也補起來（預設打穿）
    this.shellLook = false;        // 面很多（> AUTO_MAX_FACES）時按了「看看是不是薄殼」
    this._sym = null;              // 減到 ___ 面的「對稱」：量好的三個軸（換檔案清掉）
    this.symOn = null;             // null ＝ 照預設（最對稱的那一軸 ≥ SYM_ON 就勾）；true／false ＝ 自己勾的
    this.symAxis = '';             // '' ＝ 自動（最對稱的那一軸）；否則 'x'／'y'／'z'（建模器的方向）
    this.symSide = -1;             // 照哪一半：−1 ＝ 左（下、後）、+1 ＝ 右（上、前）
    if (this.read.ok) {
      this.read.check = edgeCheck(this.read.faces);
      this._startSolid();
    }
    this._render();
  }

  /**
   * 整理成實體（網格核心第五批 b ③a → `build/importSolid.js`）：先看每一塊的狀況、馬上畫出「原樣」；
   * 補洞、聯集要算（汽車聯集約 8 秒）⇒ 先讓視窗出來、寫「正在算」，下一輪再算、算完重畫。
   * 只跟檔案有關（單位、朝上、拆法都不影響）⇒ 一個檔只算一次。
   */
  _startSolid() {
    const r = this.read, check = solidCheck(r);
    const sol = { check, variants: { raw: { read: r, info: null } }, pending: false, suggest: { mode: 'raw', why: '' }, thumbs: {} };
    this._solid = sol;
    const needFill = check.holes > 0, needUnion = check.comps > 1 || check.partition > 0;   // 一塊有隔板的也要（③b：修好就是一個實體）
    sol.suggest = suggestSolid(check, null);
    if (!needFill && !needUnion) return;
    sol.pending = true;
    setTimeout(() => {
      if (this._solid !== sol) return;                  // 這中間換了檔案
      const safe = f => { try { return f(); } catch (e) { return { read: null, info: { why: '算的時候出錯：' + (e.message || e) } }; } };
      if (needFill) sol.variants.fill = safe(() => fillVariant(r));
      if (needUnion) sol.variants.union = safe(() => unionVariant(r));
      sol.suggest = suggestSolid(check, sol.variants.union || null);
      sol.pending = false;
      this._render();
    }, 30);
  }

  /** 現在用哪一個做法的結果（沒選 ＝ 照建議；那個做法算不出來 ⇒ 原樣）*/
  _solidPick() {
    const sol = this._solid;
    if (!sol) return { mode: 'raw', read: this.read };
    const mode = this.solidMode || sol.suggest.mode;
    const v = sol.variants[mode];
    return v && v.read ? { mode, read: v.read } : { mode: 'raw', read: this.read };
  }

  /** 現在用的：單位、朝上、1 個檔案單位幾 cm */
  _setting() {
    const r = this.read;
    const unit = this.unit || guessUnit(r.format, r.size);
    const up = this.up || guessUp(r.format);
    return { unit, up, cmPerUnit: this.cmFix || UNIT_CM[unit] };
  }

  /** 換算後（cm、Y 朝上）的長寬高：X 寬、Y 高、Z 深 */
  _sizeCm() {
    const r = this.read, s = this._setting();
    const [a, b, c] = r.size.map(v => v * s.cmPerUnit);
    return s.up === 'z' ? { w: a, h: c, d: b } : { w: a, h: b, d: c };
  }

  /** 碎面的門檻（cm）：自己打的 mm，或自動 ＝ 換算後最長的那一邊 ÷ 500 */
  _microTol() {
    const z = this._sizeCm();
    return { auto: Math.max(z.w, z.h, z.d) / MICRO_DIV, tol: this.microMm > 0 ? this.microMm / 10 : Math.max(z.w, z.h, z.d) / MICRO_DIV };
  }

  /**
   * 會建立的部分（cm、Y 朝上）。預覽與匯入用同一支 ⇒ 視窗寫的就是匯進去的。
   * 🔴 **先判斷每一片平面、再減面**（網格核心第五批 b ②）：照原檔一格一格的平面，清碎面⛔ 動它的點；每個部分多帶 `grid`（匯入時標 `hard`）。
   * 🔴 **面數**（第五批 b ④）：清碎面、減到 N 面要算很久（汽車 36～66 秒）⇒ 在檔案單位、Y 朝上算好存起來（`_faceWork()`），
   * 這裡只照現在的單位、朝上換座標（保形狀減面只看形狀、跟大小和轉向無關）；還沒算好的那個做法先用原樣、寫「正在算」。
   */
  _parts() {
    const spick = this._solidPick(), sh = this._shellState(spick), pick = this._shellPick(spick, sh), s = this._setting();
    const split = this.opt.split !== false;
    const base = this._faceBase(pick, split);
    const planesMode = PLANE_MODES[this.opt.planes] ? this.opt.planes : 'suggest';
    const planes = { mode: planesMode, cut: 0, grid: 0, cutFaces: 0, gridFaces: 0, kept: 0, keptFaces: 0 };
    base.judged.forEach((j, i) => {
      for (const k of ['cut', 'grid', 'cutFaces', 'gridFaces']) planes[k] += j[k];
      const regs = keptRegions(j, planesMode);
      planes.kept += regs.length;
      for (const g of regs) planes.keptFaces += g.faces.length;
    });
    const face = this._faceState(pick, split, planesMode);
    const mode = face.using;
    const done = mode === 'raw' ? null : face[mode];
    const conv = s.up === 'z' ? q => [q[0] * s.cmPerUnit, q[2] * s.cmPerUnit, -q[1] * s.cmPerUnit] : q => [q[0] * s.cmPerUnit, q[1] * s.cmPerUnit, q[2] * s.cmPerUnit];
    /**
     * 三角形那一區（第五批 b ⑤）：最後一步，在換算後（cm）兩兩合併 —— 只合合完還平的（0.01 cm），形狀不變、格線不受影響。
     * 很快（汽車 1.7 秒），但每次重畫都算太浪費 ⇒ 照「這一份面、這個比例」記住（比例會改 0.01 cm 等於檔案裡多長）。
     */
    if (!this._pairCache) this._pairCache = new WeakMap();
    const quad = { tris: 0, pairs: 0, faces: 0, quads: 0 };
    const pairedOf = (src, pts) => {
      let m = this._pairCache.get(src);
      if (!m) this._pairCache.set(src, m = new Map());
      if (!m.has(s.cmPerUnit)) m.set(s.cmPerUnit, pairQuads(pts, src.faces));
      return m.get(s.cmPerUnit);
    };
    const parts = base.parts.map((p, i) => {
      const src = done && done.parts ? done.parts[i] : p;
      const q = done && done.parts ? done.parts[i] : { ...p, grid: gridEdges(p, keptRegions(base.judged[i], planesMode), p.faces.map((_, k) => k)) };
      const pts = q.points.map(conv);
      quad.tris += q.faces.filter(f => f.length === 3).length;
      const pr = pairedOf(src, pts);
      quad.pairs += pr.pairs;
      return { ...q, points: pts, paired: pr.faces };
    });
    quad.suggest = quad.pairs ? 'pair' : 'raw';
    quad.using = (this.quadMode || quad.suggest) === 'pair' && quad.pairs ? 'pair' : 'raw';
    const out = parts.map(p => (quad.using === 'pair' ? { ...p, faces: p.paired } : p));
    for (const p of out) { quad.faces += p.faces.length; quad.quads += p.faces.filter(f => f.length === 4).length; }
    quad.rawParts = parts;
    return { parts: out, planes, solid: spick.mode, shell: sh, face, quad };
  }

  /**
   * 三角形那一區：兩張卡（原樣／兩兩合併），小圖畫出每一條線（看得出三角形還是四邊形），建議兩兩合併。
   * 沒有可以合的三角形（四邊形 OBJ、合完都不平）就只寫一行。最後寫一行 Instant Meshes（kang 10-22：先當外部轉換器）。
   */
  _quadRow(quad) {
    const d = document.createElement('div');
    d.className = 'uwSkip';
    if (!quad.pairs) {
      d.textContent = quad.tris ? `三角形：${quad.tris} 個，沒有「合完還平」的兩個可以合 —— 照原樣` : '三角形：沒有（照原樣）';
      return d;
    }
    const pct4 = Math.round(100 * quad.quads / (quad.faces || 1));
    const head = document.createElement('div');
    head.textContent = `三角形：${quad.tris} 個　建議「兩兩合併」：形狀完全不變（只合合完還平的），變成四邊形之後選一圈、環切比較走得動`;
    d.appendChild(head);
    const row = document.createElement('div');
    row.className = 'i3Cards';
    for (const mode of Object.keys(QUAD_MODES)) {
      const card = document.createElement('div');
      card.className = 'i3Card' + (mode === quad.using ? ' on' : '') + (mode === quad.suggest ? ' sug' : '');
      card.innerHTML = `<div class="i3Thumb"></div><b>${QUAD_MODES[mode]}${mode === quad.suggest ? '　（建議）' : ''}${mode === quad.using ? '　✓ 現在用這個' : ''}</b><div class="i3Nums"></div>`;
      const rawFaces = quad.rawParts.reduce((n, p) => n + p.faces.length, 0);
      const pairedFaces = rawFaces - quad.pairs;
      card.querySelector('.i3Nums').textContent = mode === 'raw'
        ? `${rawFaces} 個面（三角形 ${quad.tris} 個）`
        : `${pairedFaces} 個面（合了 ${quad.pairs} 對，四邊形約 ${mode === quad.using ? pct4 : Math.round(100 * quad.pairs / (pairedFaces || 1))}%）　不平的面 0（只合平的）`;
      card.title = '點卡片：用這個；點小圖：放大看（畫出每一條線）';
      card.onclick = () => { this.quadMode = mode; this._render(); };
      const th = card.querySelector('.i3Thumb');
      th.onclick = e => { e.stopPropagation(); this._bigQuadThumb(mode); };
      this._quadThumb(th, mode, quad, 200, 150);
      row.appendChild(card);
    }
    d.appendChild(row);
    const im = document.createElement('div');
    im.style.marginTop = '6px';
    im.textContent = '要整齊的四邊形（順著形狀排）：用 Instant Meshes（免費的外部程式）轉成 OBJ 再匯入 —— 建模器讀 OBJ 會照原樣保留四邊形';
    d.appendChild(im);
    return d;
  }

  /** 三角形那一區的小圖（畫出每一條線）：同一份面、同一個比例與朝上只畫一次 */
  _quadThumb(el, mode, quad, w, h) {
    const F = this._face, s = this._setting();
    if (!F.thumbs) F.thumbs = {};
    const parts = quad.rawParts.map(p => ({ points: p.points, faces: mode === 'pair' ? p.paired : p.faces }));
    this._thumbPut(el, F.thumbs, `quad|${mode}|${F.using}|${F.reduce ? F.reduce.target : 0}|${s.cmPerUnit}|${s.up}|${w}`, () => this._face === F, () => parts, w, h, true);
  }

  _bigQuadThumb(mode) {
    const { quad } = this._parts();
    const ov = document.createElement('div');
    ov.className = 'i3Big';
    ov.innerHTML = `<div><b>${QUAD_MODES[mode]}</b>　<span>灰線 ＝ 每一個面的邊；紅線 ＝ 破洞的邊；橘線 ＝ 三面以上共用的邊。點一下關掉</span></div><div class="i3BigImg"></div>`;
    ov.onclick = () => ov.remove();
    this.el.appendChild(ov);
    this._quadThumb(ov.querySelector('.i3BigImg'), mode, quad, 720, 540);
  }

  /**
   * 只留正面（面皮／實心）那一區的狀態（kang 2026-10-31「照你的建議」(a)～(k) → `build/importShell.js`）：
   * 接在整理成實體後面、拆部分與減面前面（先挑、再減 —— `三視圖導入-研究.md` 實驗 4、10）。
   * 換整理做法、朝上、正面、大開口補不補就重算（下一輪、算完重畫）；面很多的（> `AUTO_MAX_FACES`）按了「看看是不是薄殼」才算。
   * 整理成實體還在算 ⇒ 先不算（算完那邊會重畫）。
   */
  _shellState(spick) {
    const s = this._setting();
    const key = [spick.mode, s.up, this.shellFront, this.shellFillBig, this.shellLook].join('|');
    if (this._shell && this._shell.key === key) return this._shell;
    const read = spick.read, n = read.faces.length;
    const st = { key, pending: false, big: n > AUTO_MAX_FACES && !this.shellLook, find: null, variants: {}, suggest: { mode: 'raw', why: '' }, thumbs: {}, using: 'raw', error: '' };
    if (st.big) { this._shell = st; return st; }
    if (this._solid && this._solid.pending) { this._shell = null; st.pending = true; return st; }
    this._shell = st;
    st.pending = true;
    setTimeout(() => {
      if (this._shell !== st) return;                    // 這中間換了設定
      try {
        const height = s.up === 'z' ? read.size[2] : read.size[1];
        st.find = shellFind(read, { height, front: this.shellFront ? toFile(this.shellFront, s.up) : '' });
        if (st.find.shell) {
          st.variants.skin = skinVariant(read, st.find);
          st.variants.solid = solidVariant(st.variants.skin.read, st.find.front, { fillBig: this.shellFillBig });
          st.suggest = suggestShell(st.find, st.variants.solid);
        }
      } catch (e) {
        st.error = '算的時候出錯：' + (e.message || e);
      }
      st.pending = false;
      this._render();
    }, 30);
    return st;
  }

  /** 現在用哪一個（沒選 ＝ 照建議；那個做不了或還在算 ⇒ 原樣）；mode 帶著整理做法與這一區的設定（拆部分、減面照它重算）*/
  _shellPick(spick, sh) {
    const want = this.shellMode || sh.suggest.mode;
    const v = !sh.pending && sh.find && sh.find.shell ? sh.variants[want] : null;
    sh.using = v && v.read ? want : 'raw';
    return sh.using === 'raw' ? spick : { mode: `${spick.mode}|${sh.using}|${sh.key}`, read: v.read };
  }

  /**
   * 只留正面那一區：不是薄殼只寫一行；是薄殼 ⇒ 正面朝（自己猜、可以改）、大開口補不補、三張卡（原樣／面皮／實心）。
   * 實心做不了的卡變灰、寫原因（kang 2026-10-31 (h)）。
   */
  _shellRow(sh) {
    const d = document.createElement('div');
    d.className = 'uwSkip';
    const T = '只留正面（面皮／實心）：';
    if (sh.big) {
      d.innerHTML = `${T}面很多（超過 ${AUTO_MAX_FACES} 個），沒有自動看是不是薄殼（55 萬面約 30 秒）　<button class="mini" id="i3ShellLook">看看是不是薄殼</button>`;
      d.querySelector('#i3ShellLook').onclick = () => { this.shellLook = true; this._render(); };
      return d;
    }
    if (sh.pending || !sh.find) { d.textContent = T + (sh.error || '正在看是不是薄殼（量厚度，5 萬面約 1～2 秒）…'); return d; }
    const f = sh.find;
    if (!f.shell) { d.textContent = `${T}不是薄殼（兩面成對的薄牆只佔表面 ${pct(f.pairPct)}）⇒ 不用`; return d; }
    const s = this._setting();
    const guessName = SHELL_FRONTS[toModel(f.guess, s.up)];
    const head = document.createElement('div');
    head.textContent = `${T}是薄殼（兩面成對的薄牆佔表面 ${pct(f.pairPct)}、牆厚約 ${mm(f.wall * s.cmPerUnit)} mm）　`
      + `建議「${SHELL_MODES[sh.suggest.mode]}」：${sh.suggest.why}`;
    d.appendChild(head);
    const ctl = document.createElement('div');
    ctl.style.cssText = 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:4px 0';
    ctl.innerHTML = `<span>正面朝</span><select id="i3ShellFront"><option value="">自己猜（${guessName}）</option>`
      + Object.entries(SHELL_FRONTS).map(([k, t]) => `<option value="${k}">${t}</option>`).join('') + '</select>'
      + `<label class="uwCk"><input type="checkbox" id="i3ShellFill"${this.shellFillBig ? ' checked' : ''}> 實心：大的開口（像眼洞）也補起來</label>`;
    const fs = ctl.querySelector('#i3ShellFront');
    fs.value = this.shellFront;
    fs.title = '哪一面是正面（建模器的方向：前 ＝ 朝你）。自己猜的是從四面八方看、外面那一層的平均朝向；猜錯就選對的';
    fs.onchange = () => { this.shellFront = fs.value; this._render(); };
    const fb = ctl.querySelector('#i3ShellFill');
    fb.parentElement.title = '實心的背板：比外緣一圈的 1/10 長的開口（像面具的眼洞）預設打穿到背後；勾起來 ⇒ 也補起來（小洞一律補）';
    fb.onchange = () => { this.shellFillBig = fb.checked; this._render(); };
    d.appendChild(ctl);
    const row = document.createElement('div');
    row.className = 'i3Cards';
    const raw = this._solidPick().read;
    for (const mode of Object.keys(SHELL_MODES)) {
      const v = sh.variants[mode], ok = mode === 'raw' || (v && v.read);
      const card = document.createElement('div');
      card.className = 'i3Card' + (mode === sh.using ? ' on' : '') + (mode === sh.suggest.mode ? ' sug' : '');
      card.innerHTML = `<div class="i3Thumb"></div><b>${SHELL_MODES[mode]}${mode === sh.suggest.mode ? '　（建議）' : ''}${mode === sh.using ? '　✓ 現在用這個' : ''}</b><div class="i3Nums"></div>`;
      const nums = card.querySelector('.i3Nums');
      if (mode === 'raw') nums.textContent = `${raw.faces.length} 個面　內外兩層都留著（減面時兩層會擠在一起、列印太薄）`;
      else if (mode === 'skin') {
        const i = v.info, t = [`${i.faces} 個面　只留正面一層（開口的）`];
        if (i.holes) t.push(`${i.holes} 個開口`);
        if (i.dropped) t.push(`丟掉 ${i.dropped} 個沒連在一起的小面`);
        t.push(`匯入成面皮板件、板厚 ${mm(i.wall * s.cmPerUnit)} mm（量到的牆厚，往內長）`, '做紙模、面具選這個');
        nums.textContent = t.join('　');
      } else {
        const i = v.info, t = [];
        if (v.read) {
          t.push(`${i.faces} 個面　正面＋背板、封閉`);
          if (i.tunnels) t.push(`${i.tunnels} 個大開口打穿`);
          if (i.filled) t.push(`補了 ${i.filled} 個洞`);              // 勾了「大的開口也補起來」時眼洞也算在裡面 ⇒ ⛔ 寫「小洞」
          if (i.cross) t.push(`有 ${i.cross} 個三角形互相穿過去（不到千分之一；3D 列印前看一下）`);
          t.push('3D 列印、剖面、木拼圖選這個');
        } else t.push('做不了：' + i.why);
        nums.textContent = t.join('　');
      }
      if (ok) {
        card.title = '點卡片：用這個；點小圖：放大看';
        card.onclick = () => { this.shellMode = mode; this._render(); };
        const th = card.querySelector('.i3Thumb');
        th.onclick = e => { e.stopPropagation(); this._bigShellThumb(mode); };
        this._shellThumb(th, mode, 200, 150);
      } else card.classList.add('off');
      row.appendChild(card);
    }
    d.appendChild(row);
    return d;
  }

  /** 只留正面那一區的小圖（同一份設定、同一個朝上只畫一次）*/
  _shellThumb(el, mode, w, h) {
    const sh = this._shell, s = this._setting();
    const read = mode === 'raw' ? this._solidPick().read : sh.variants[mode].read;
    this._thumbPut(el, sh.thumbs, `${mode}|${s.up}|${w}`, () => this._shell === sh, () => toParts(read, { cmPerUnit: s.cmPerUnit, up: s.up, split: false }), w, h);
  }

  _bigShellThumb(mode) {
    const ov = document.createElement('div');
    ov.className = 'i3Big';
    ov.innerHTML = `<div><b>${SHELL_MODES[mode]}</b>　<span>紅線 ＝ 開口的邊；橘線 ＝ 三面以上共用的邊。點一下關掉</span></div><div class="i3BigImg"></div>`;
    ov.onclick = () => ov.remove();
    this.el.appendChild(ov);
    this._shellThumb(ov.querySelector('.i3BigImg'), mode, 720, 540);
  }

  /**
   * 減到 ___ 面的「對稱」：拆好部分之後量三個軸（只在一個部分時；5 萬面約 1 秒，下一輪算、算完重畫）。
   * 鑰匙跟拆部分一樣（整理做法、只留正面、拆法）⇒ 換了就重量。
   */
  _symState() {
    const base = this._base;
    if (!base) return null;
    if (this._sym && this._sym.key === base.key) return this._sym;
    const st = { key: base.key, pending: base.parts.length === 1, res: null, error: '', many: base.parts.length > 1 };
    this._sym = st;
    if (!st.pending) return st;
    setTimeout(() => {
      if (this._sym !== st) return;
      try {
        const p = base.parts[0], s = this._setting();
        let lo = Infinity, hi = -Infinity, k = s.up === 'z' ? 2 : 1;
        for (const q of p.points) { if (q[k] < lo) lo = q[k]; if (q[k] > hi) hi = q[k]; }
        st.res = symmetryOf(p, hi - lo);
      } catch (e) { st.error = '量對稱時出錯：' + (e.message || e); }
      st.pending = false;
      this._render();
    }, 30);
    return st;
  }

  /** 建模器的軸（'x'／'y'／'z'）→ 檔案的第幾軸、正負號（Z 朝上的檔：建模器 (x, y, z) ＝ 檔案 (x, z, −y)）*/
  _symFileAxis(m) {
    const z = this._setting().up === 'z';
    return m === 'x' ? { ax: 0, sg: 1 } : m === 'y' ? { ax: z ? 2 : 1, sg: 1 } : { ax: z ? 1 : 2, sg: z ? -1 : 1 };
  }

  /** 對稱的資訊（給卡片）：最對稱的軸、每一軸幾 %、現在選哪一軸、預設勾不勾、會不會出現 */
  _symInfo() {
    const st = this._sym;
    if (!st || st.pending || st.many || !st.res) return st ? { pending: st.pending, many: st.many, error: st.error } : null;
    const pctOf = m => st.res.axes[this._symFileAxis(m).ax].within;
    const autoAx = ['x', 'y', 'z'].reduce((a, b) => (pctOf(b) > pctOf(a) ? b : a));
    const ax = this.symAxis || autoAx, best = pctOf(autoAx);
    return { autoAx, ax, pct: pctOf, best, show: best >= SYM_SHOW, defaultOn: best >= SYM_ON };
  }

  /** 現在用不用對稱（勾了、出現、量好了）⇒ 檔案座標的軸、鏡射面、留哪一半、給卡片的名字；不用 ⇒ null */
  _symUse() {
    const inf = this._symInfo();
    if (!inf || !inf.show) return null;
    const on = this.symOn === null ? inf.defaultOn : this.symOn;
    if (!on) return null;
    const f = this._symFileAxis(inf.ax);
    const A = SYM_AXES[inf.ax];
    return { ax: f.ax, c: this._sym.res.axes[f.ax].c, side: this.symSide * f.sg, label: `${A[0]}對稱（照${this.symSide < 0 ? A[1] : A[2]}半）` };
  }

  /** 對稱的設定變了 ⇒ 減到 N 面要重算（量還沒好時也算一種狀態：好了再算一次）*/
  _symKey() {
    const u = this._symUse();
    return u ? `${u.ax}|${u.c}|${u.side}` : (this._sym && this._sym.pending ? 'pending' : '');
  }

  /** 減到 ___ 面時不讓面互相穿過去（預設開、記住；kang 2026-10-31 照 AI 建議）*/
  _noCross() { return this.opt.noCross !== false; }

  /** 拆好部分的原樣（檔案單位、Y 朝上）＋每一片平面的判斷；同一個做法、同一種拆法只算一次 */
  _faceBase(pick, split) {
    const key = pick.mode + '|' + split;
    if (!this._base || this._base.key !== key) {
      const parts = toParts(pick.read, { cmPerUnit: 1, up: 'y', split });
      this._base = { key, parts, judged: parts.map(judgePlanes) };
    }
    return this._base;
  }

  /**
   * 面數那一區的狀態：清碎面算好了沒、少幾 %、建議哪一個、現在用哪一個。
   * 清碎面一換檔、換整理做法、換拆法、換平面的選擇、換門檻就重算（下一輪、算完重畫）；減到 N 面點了才算。
   */
  _faceState(pick, split, planesMode) {
    const s = this._setting();
    const key = [pick.mode, split, planesMode, this.microMm, this.microMm > 0 ? s.cmPerUnit : ''].join('|');
    if (!this._face || this._face.key !== key) this._face = { key, clean: null, reduce: null };
    const F = this._face;
    const solidBusy = (this._solid && this._solid.pending) || (this._shell && this._shell.pending);    // 整理成實體、只留正面還在算 ⇒ 先不算
    if (!F.clean && !solidBusy) this._faceWork('clean');
    if (F.clean && F.clean.lazy && this.faceMode === 'clean' && !solidBusy) this._faceWork('clean');   // 超過一成的：點了才真的減
    if (!solidBusy) this._symState();
    const symBusy = this._sym && this._sym.pending;                    // 對稱還在量 ⇒ 減到 N 面先等（⛔ 先照一般減、量好又重減一次）
    if (this.reduceTarget > 0 && (!F.reduce || F.reduce.target !== this.reduceTarget || F.reduce.noCross !== this._noCross() || F.reduce.symKey !== this._symKey()) && !solidBusy && !symBusy) this._faceWork('reduce');
    const c = F.clean && (F.clean.parts || F.clean.lazy) ? F.clean : null;
    F.suggest = !c ? { mode: 'raw', why: F.clean && !F.clean.pending ? '' : '正在算清碎面…' }
      : !c.removed ? { mode: 'raw', why: '沒有比門檻短、清了不會壞的碎面 —— 不用清' }
      : c.ratio <= CLEAN_MAX ? { mode: 'clean', why: `只有 ${pct(c.ratio)} 是碎面，清掉之後表面離原本最多 ${mm(c.dev * s.cmPerUnit)} mm` }
      : { mode: 'raw', why: `清碎面會少 ${pct(c.ratio)}（超過一成，等於是減面）—— 不自動清，要的話點「清碎面」那張` };
    let using = this.faceMode || F.suggest.mode;
    if (using === 'reduce' && !(this.reduceTarget > 0)) using = 'raw';
    F.using = using;
    F.ready = using === 'raw' || !!(F[using] && F[using].parts);
    return F;
  }

  /**
   * 算清碎面或減到 N 面（下一輪算、算完重畫；換了檔案或設定就丟掉）。
   * 清碎面：門檻（自動 ＝ 最長邊 ÷ 500）先用「兩端合到中點」數出會剩幾個面（⇒ 減多少跟 10-21 驗收的門檻一樣），
   * 再用保形狀減面減到那個數（汽車：最多偏 0.1 mm → 0.005 mm）；照原檔的格子不動。
   * 減到 N 面：照每個部分的面數分配，⛔ 保護格子（kang：你都要少面了）；減不下去的照實講。
   * 減到 N 面預設「不讓面互相穿過去」（`_noCross()`；kang 2026-10-31「照你的建議」→ `三視圖導入-研究.md` 實驗 9）：
   * 減的時候就擋多出來的穿面（幾個部分共用一個比較次數上限 `CROSS_CAP`），減完再數一次還有幾個三角形穿過去、照實講。
   */
  _faceWork(kind) {
    const F = this._face;
    const full = kind === 'clean' && F.clean && F.clean.lazy;     // 先前只數過、現在點了要真的減
    const noCross = kind === 'reduce' && this._noCross();
    const symKey = kind === 'reduce' ? this._symKey() : '', symUse = kind === 'reduce' ? this._symUse() : null;
    if (F[kind] && !full && (kind === 'clean' || (F[kind].target === this.reduceTarget && F[kind].noCross === noCross && F[kind].symKey === symKey))) return;
    const target = this.reduceTarget, counted = full ? F.clean.goals : null;
    F[kind] = { pending: true, target, noCross, symKey };
    setTimeout(() => {
      if (this._face !== F) return;                       // 這中間換了設定
      const base = this._base, planesMode = PLANE_MODES[this.opt.planes] ? this.opt.planes : 'suggest';
      const s = this._setting();
      try {
        const total = base.parts.reduce((n, p) => n + p.faces.length, 0);
        let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (const p of base.parts) for (const q of p.points) for (let k = 0; k < 3; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; }
        const tol = this.microMm > 0 ? this.microMm / 10 / s.cmPerUnit : Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / MICRO_DIV;
        let left = 0, maxMove = 0, dev = 0;
        /**
         * 清碎面先數：照門檻用「兩端合到中點」數出每個部分會剩幾個面（汽車 13 秒）。
         * 超過一成 ⇒ 先停在這裡（`lazy`，不自動清），點了「清碎面」那張才真的減 —— 汽車省下 40 秒左右的白等。
         */
        const goals = kind === 'clean' ? (counted || base.parts.map((p, i) => {
          const regs = keptRegions(base.judged[i], planesMode);
          return collapseShort(p, tol, regs.length ? keepVerts(p, regs) : null).faces.length;
        })) : base.parts.map(p => Math.max(4, Math.round(target * p.faces.length / total)));
        if (kind === 'clean' && !counted) {
          const n = goals.reduce((a, b) => a + b, 0);
          if ((total - n) / total > CLEAN_MAX && this.faceMode !== 'clean') {
            F.clean = { lazy: true, goals, faces: n, removed: total - n, ratio: (total - n) / total, tol };
            this._render();
            return;
          }
        }
        let budget = CROSS_CAP, crossRefused = 0, crossCapped = false, symBad = '';
        const parts = base.parts.map((p, i) => {
          const regs = kind === 'clean' ? keptRegions(base.judged[i], planesMode) : [];
          const keep = regs.length ? keepVerts(p, regs) : null;
          const goal = goals[i];
          if (goal < p.faces.length && noCross && budget <= 0) crossCapped = true;      // 前面的部分已經比到上限 ⇒ 這一塊照原本的減
          const nc = noCross && budget > 0;
          /** 左右對稱（kang 2026-10-31 (a)～(i)）：只在一個部分時；做出來塊數、破洞變多 ⇒ 改用一般減面、講原因（(g)）*/
          let q = null;
          if (symUse && goal < p.faces.length) {
            const y = symDecimate(p, { target: goal, ax: symUse.ax, c: symUse.c, side: symUse.side, noCross: nc, crossCap: budget });
            if (y.bad) symBad = y.bad; else q = y;
          }
          if (!q) q = goal < p.faces.length ? decimate(p, { target: goal, keep, noCross: nc, crossCap: budget }) : { ...p, from: p.faces.map((_, k) => k), stats: { maxMove: 0 } };
          if (nc && q.stats.crossTests !== undefined) { budget -= q.stats.crossTests; crossRefused += q.stats.crossRefused; crossCapped = crossCapped || q.stats.crossCapped; }
          left += q.faces.length; maxMove = Math.max(maxMove, q.stats.maxMove);
          if (q.faces.length < p.faces.length) dev = Math.max(dev, surfaceDev(p, q));   // 表面離原本最多多遠（⛔ 用點搬了多遠 —— 點會沿著表面滑）
          return { ...q, grid: gridEdges(q, keptRegions(base.judged[i], planesMode).filter(() => kind === 'clean'), q.from) };
        });
        F[kind] = { target, noCross, symKey, sym: symUse && !symBad ? symUse.label : '', symBad, parts, faces: left, removed: total - left, ratio: total ? (total - left) / total : 0, maxMove, dev, tol, crossRefused, crossCapped };
        /** 減到 N 面：減完數還有幾個三角形穿過去（跟大小無關）；有的話再數原檔本來就有幾個（同一個檔只數一次）*/
        if (kind === 'reduce' && left < total) {
          const c = crossCheck(crossTris(parts));
          F[kind].cross = c;
          if (c.tris && !base.cross) base.cross = crossCheck(crossTris(base.parts));
        }
      } catch (e) {
        F[kind] = { target, error: '算的時候出錯：' + (e.message || e) };
      }
      this._render();
    }, 30);
  }

  /**
   * 整理成實體那一區：每個做法一張卡（小圖＋數字），建議的那張框起來、寫理由；點卡片換做法，點小圖放大
   * （kang 2026-10-22「數字＋每個做法一張小圖並排，建議的那張框起來，點小圖放大」）。
   * 一塊、封閉、乾淨的模型只寫一行，不出卡片。
   */
  _solidRow(using) {
    const sol = this._solid, ck = sol.check;
    const d = document.createElement('div');
    d.className = 'uwSkip';
    if (ck.comps === 1 && !ck.holes && !ck.partition) {
      d.textContent = '整理成實體：一塊、封閉、乾淨 ⇒ 照原樣就好';
      return d;
    }
    const head = document.createElement('div');
    const bits = [];
    if (ck.comps > 1) bits.push(`${ck.comps} 塊零件`);
    if (ck.holes) bits.push(`${ck.holes} 塊有破洞或面翻過來`);
    if (ck.partition) bits.push(`${ck.partition} 塊裡面有隔板（三面以上共用的邊）`);
    if (ck.cavities) bits.push(`其中 ${ck.cavities} 塊是包在裡面的空心（朝裡的內層）`);
    head.textContent = `整理成實體：${bits.join('、')}`
      + (sol.pending ? ' —— 正在算補洞、聯集（大的模型要幾秒）…' : `　建議「${SOLID_MODES[sol.suggest.mode]}」：${sol.suggest.why}`);
    d.appendChild(head);
    const row = document.createElement('div');
    row.className = 'i3Cards';
    for (const mode of Object.keys(SOLID_MODES)) {
      const v = sol.variants[mode];
      if (mode !== 'raw' && !v && !sol.pending) continue;             // 用不到的做法不放（沒有洞就沒有補洞）
      const card = document.createElement('div');
      card.className = 'i3Card' + (mode === using ? ' on' : '') + (!sol.pending && mode === sol.suggest.mode ? ' sug' : '');
      const ok = v && v.read;
      card.innerHTML = `<div class="i3Thumb"></div><b>${SOLID_MODES[mode]}${!sol.pending && mode === sol.suggest.mode ? '　（建議）' : ''}${mode === using ? '　✓ 現在用這個' : ''}</b><div class="i3Nums"></div>`;
      const nums = card.querySelector('.i3Nums');
      nums.textContent = !v ? '正在算…' : ok ? this._solidNums(mode, v) : '做不了：' + v.info.why;
      if (ok) {
        card.title = '點卡片：用這個做法；點小圖：放大看';
        card.onclick = () => { this.solidMode = mode; this._render(); };
        const th = card.querySelector('.i3Thumb');
        th.onclick = e => { e.stopPropagation(); this._bigThumb(mode); };
        this._thumbInto(th, mode, 200, 150);
      } else card.classList.add('off');
      row.appendChild(card);
    }
    d.appendChild(row);
    return d;
  }

  /** 卡片上的數字：面、破洞、三面共用、翻面（整理之後的），加上這個做法做了什麼 */
  _solidNums(mode, v) {
    if (!v.check) v.check = edgeCheck(v.read.faces);
    const e = v.check, t = [`${v.read.faces.length} 個面`];
    t.push(e.open ? `破洞邊 ${e.open}` : '沒有破洞');
    if (e.nonManifold) t.push(`三面共用 ${e.nonManifold}`);
    if (e.flipped) t.push(`方向不一致 ${e.flipped}`);
    const i = v.info;
    if (mode === 'fill') {
      if (i.holes) t.push(`補了 ${i.holes} 個洞`);
      if (i.turned) t.push(`轉正 ${i.turned} 個面`);
      if (i.flippedSolids) t.push(`${i.flippedSolids} 塊整個翻回來`);
      for (const f of i.failed) t.push('補不了 ' + f);
    }
    if (mode === 'union') {
      if (i.united > 1) t.push(`${i.united} 塊聯集成 ${i.pieces} 個實體`);     // 只有一塊（修好隔板的那一塊）不寫「1 塊聯集成 1 個」
      if (i.overlap > 0) t.push(`重疊 ${Math.round(i.overlap * 1000) / 10}%`);
      if (i.dropped) t.push(`丟掉 ${i.dropped} 塊碎屑`);
      if (i.partFixed) t.push(`修好 ${i.partFixed} 塊的隔板（修前修後剖面一樣）`);
      if (i.cavities) t.push(`留著 ${i.cavities} 個空心`);
      if (i.kept) {
        /** 沒修的照實講為什麼（kang 2026-10-24「其他照原樣另外放、講出來」）*/
        const s = i.partSkip || { many: 0, open: 0, section: 0 }, why = [];
        if (s.many) why.push(`${s.many} 塊隔板太多`);
        if (s.open) why.push(`${s.open} 塊修完還不封閉`);
        if (s.section) why.push(`${s.section} 塊修完剖面差太多（最多 ${Math.round(i.partSkipWorst * 1000) / 10}%，會丟掉真的料）`);
        const other = i.kept - s.many - s.open - s.section;
        if (other > 0) why.push(`${other} 塊補不起來`);
        t.push(`${i.kept} 塊照原樣另外放（${why.join('、')}）`);
      }
      t.push(i.kept ? '聯集的那些匯入後是一個物件' : '匯入後是一個物件');
    }
    return t.join('　');
  }

  /** 小圖：畫好放進 `el`（同一個做法、同一個朝上只畫一次）*/
  _thumbInto(el, mode, w, h) {
    const s = this._setting(), sol = this._solid;
    this._thumbPut(el, sol.thumbs, `${mode}|${s.up}|${w}`, () => this._solid === sol,
      () => toParts(sol.variants[mode].read, { cmPerUnit: s.cmPerUnit, up: s.up, split: false }), w, h);
  }

  /** 畫小圖的共用：有畫過就拿、沒有就下一輪畫（`alive()` 不成立 ＝ 換了檔案或設定，不畫）*/
  _thumbPut(el, cache, key, alive, getParts, w, h, wire = false) {
    const put = url => { el.innerHTML = ''; const img = document.createElement('img'); img.src = url; img.width = w; img.height = h; el.appendChild(img); };
    if (cache[key]) { put(cache[key]); return; }
    el.textContent = '畫圖中…';
    requestAnimationFrame(() => {
      if (!alive()) return;
      const url = thumbURL(getParts(), w, h, wire);
      if (url) { cache[key] = url; put(url); } else el.textContent = '畫不出來';
    });
  }

  /** 點小圖：放大看（再點一下關掉）*/
  _bigThumb(mode) {
    const ov = document.createElement('div');
    ov.className = 'i3Big';
    ov.innerHTML = `<div><b>${SOLID_MODES[mode]}</b>　<span>紅線 ＝ 破洞的邊；橘線 ＝ 三面以上共用的邊。點一下關掉</span></div><div class="i3BigImg"></div>`;
    ov.onclick = () => ov.remove();
    this.el.appendChild(ov);
    this._thumbInto(ov.querySelector('.i3BigImg'), mode, 720, 540);
  }

  /**
   * 平面上的小塊那一列：三選一、判出來的數字（照實講）。
   * 沒有「好幾塊拼成」的平面就不出現（柺杖這種低多邊形、STL 平的地方一定是三角形拼的 ⇒ 會出現、都是碎塊）。
   */
  _planeRow(pl) {
    const d = document.createElement('div');
    d.className = 'uwSkip';
    d.innerHTML = `
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span>平面上的小塊：</span>
        <select id="i3Planes">${Object.entries(PLANE_MODES).map(([k, t]) => `<option value="${k}">${t}${k === 'suggest' ? '（預設）' : ''}</option>`).join('')}</select>
      </div>
      <div id="i3PlanesRes" style="margin-top:4px"></div>`;
    const sel = d.querySelector('#i3Planes'), res = d.querySelector('#i3PlanesRes');
    sel.value = pl.mode;
    sel.title = '一片平面由好幾小塊拼成時：\n'
      + '・像匯出時自動切出來的碎塊（有三角形或細長的）⇒ 合成一個面，中間的線看不見\n'
      + '・像畫好的格子（全是方正的四邊形）⇒ 照原檔一格一格，格線看得見、點得到（跟建模器自己細分的一樣）\n'
      + '「照建議」每一片各自判斷；不對的話選「全部合成一個面」或「全部照原檔一格一格」。'
      + '照原檔的平面，清碎面不會動它的點';
    sel.onchange = () => { this.opt.planes = sel.value; save(this.opt); this._render(); };
    const n = pl.cut + pl.grid;
    if (pl.mode === 'merge') res.textContent = `${n} 片平面是好幾塊拼成的 ⇒ 全部合成一個面（中間的線看不見）`;
    else if (pl.mode === 'keep') res.textContent = `${n} 片平面是好幾塊拼成的 ⇒ 全部照原檔一格一格（${pl.keptFaces} 塊），格線看得見`;
    else {
      const t = [];
      if (pl.cut) t.push(`${pl.cut} 片像匯出時切的碎塊（有三角形或細長的）⇒ 合成一個面`);
      if (pl.grid) t.push(`${pl.grid} 片像畫好的格子（${pl.gridFaces} 塊）⇒ 照原檔一格一格，格線看得見`);
      res.textContent = `${n} 片平面是好幾塊拼成的：` + t.join('；');
    }
    if (pl.kept) res.textContent += '（照原檔的平面，清碎面不會動它）';
    return d;
  }

  /**
   * 面數那一區：三張卡（原樣／清碎面／減到 ___ 面），小圖＋數字，建議的那張框起來、寫理由；點卡片換、點小圖放大。
   * 清碎面的門檻（空白 ＝ 自動）放在卡片裡；減到 ___ 面打數字或按快捷才開始算（汽車要一分鐘左右）。
   */
  _faceRow(face, nRaw) {
    const s = this._setting(), m = this._microTol();
    const d = document.createElement('div');
    d.className = 'uwSkip';
    const head = document.createElement('div');
    head.textContent = `面數：原檔 ${nRaw} 個面` + (face.suggest.why ? `　建議「${FACE_MODES[face.suggest.mode]}」：${face.suggest.why}` : '');
    d.appendChild(head);
    const row = document.createElement('div');
    row.className = 'i3Cards';
    const parts = mode => mode === 'raw' ? null : face[mode];
    for (const mode of Object.keys(FACE_MODES)) {
      const r = parts(mode), ok = mode === 'raw' || (r && (r.parts || r.lazy));
      const card = document.createElement('div');
      const sugReady = face.clean && !face.clean.pending;            // 清碎面算好或數好了 ⇒ 建議才算數
      card.className = 'i3Card' + (mode === face.using ? ' on' : '') + (mode === face.suggest.mode && sugReady ? ' sug' : '');
      const title = mode === 'reduce' && this.reduceTarget > 0 ? `減到 ${this.reduceTarget} 面` : FACE_MODES[mode];
      card.innerHTML = `<div class="i3Thumb"></div><b>${title}${mode === face.suggest.mode && sugReady ? '　（建議）' : ''}${mode === face.using ? '　✓ 現在用這個' : ''}</b><div class="i3Nums"></div><div class="i3Ctl"></div>`;
      const nums = card.querySelector('.i3Nums'), ctl = card.querySelector('.i3Ctl'), th = card.querySelector('.i3Thumb');
      if (mode === 'raw') nums.textContent = `${nRaw} 個面　照檔案原樣`;
      else if (mode === 'reduce' && !(this.reduceTarget > 0)) nums.textContent = '打一個面數或按下面的快捷（按了才開始算）';
      else if (!r || r.pending) nums.textContent = '正在算…（面多的模型要一分鐘左右）';
      else if (r.error) nums.textContent = r.error;
      else if (r.lazy) nums.textContent = `會剩 ${r.faces} 個面（少 ${pct(r.ratio)}）　超過一成 —— 預設不清；點這張才開始算（面多的模型要一分鐘左右）`;
      else {
        const t = [`${r.faces} 個面（少 ${pct(r.ratio)}）`, `表面離原本最多 ${mm(r.dev * s.cmPerUnit)} mm`];
        if (mode === 'clean' && !r.removed) t[0] = '沒有比門檻短、清了不會壞的碎面';
        if (mode === 'reduce' && r.faces > this.reduceTarget * 1.05) t.push(`最少只能減到 ${r.faces} 個面（零件多、或再減會弄出破洞、讓面翻過去${r.crossRefused ? '、讓面互相穿過去' : ''}）`);
        if (mode === 'reduce' && r.crossCapped) t.push('這個模型零件互相穿過去太多，後面沒有再擋');
        if (mode === 'reduce' && r.sym) t.push(r.sym + ' —— 左右兩半的網格一模一樣');
        if (mode === 'reduce' && r.symBad) t.push(r.symBad + ' —— 改用一般減面');
        if (mode === 'reduce' && r.cross && r.cross.tris) {
          const was = this._base && this._base.cross;
          t.push(`還有 ${r.cross.tris} 個三角形互相穿過去${r.cross.cut ? '（太多、沒數完）' : ''}`
            + (was && was.tris ? `（原檔本來就有 ${was.tris} 個${was.cut ? '以上' : ''}）` : '')
            + (r.noCross ? '' : ' —— 勾下面的「不讓面互相穿過去」再減一次'));
        }
        if (mode === 'clean' && r.ratio > CLEAN_MAX) t.push('超過一成 —— 預設不清');
        nums.textContent = t.join('　');
      }
      if (mode === 'clean') {
        ctl.innerHTML = `比 <input type="number" class="i3MicroMm" step="0.01" min="0" style="width:60px" placeholder="${mm(m.auto)}" value="${this.microMm > 0 ? this.microMm : ''}"> mm 短的邊算碎面（空白 ＝ 自動：最長的那一邊 ÷ ${MICRO_DIV}）`;
        const inp = ctl.querySelector('input');
        inp.title = '空白 ＝ 自動（照模型大小）。自己打一個 mm 就照你的；打得太大會把真的細節也減掉 —— 看上面寫的「表面離原本最多」';
        inp.onclick = e => e.stopPropagation();
        inp.onchange = () => { this.microMm = Math.max(0, num(inp.value, 0)); this._render(); };
      }
      if (mode === 'reduce') {
        ctl.innerHTML = `<input type="number" class="i3Reduce" step="100" min="4" style="width:80px" placeholder="面數" value="${this.reduceTarget > 0 ? this.reduceTarget : ''}"> 面　`
          + REDUCE_PRESETS.map(([t, n], k) => `<button class="mini" data-k="${k}">${t}</button>`).join(' ')
          + `<br><label class="i3NoCrossLbl"><input type="checkbox" class="i3NoCross"${this._noCross() ? ' checked' : ''}> 不讓面互相穿過去（比較慢）</label>`
          + this._symCtl();
        const nc = ctl.querySelector('.i3NoCross');
        nc.parentElement.title = '減的時候，合了會讓面穿過別的面就不合（薄的殼內外兩層不會穿出來）。'
          + '原本就穿過去的不管。比較慢：5 萬面約多 2～3 倍時間';
        nc.parentElement.onclick = e => e.stopPropagation();
        nc.onchange = () => { this.opt.noCross = nc.checked; save(this.opt); this._render(); };
        this._symWire(ctl);
        const inp = ctl.querySelector('input');
        inp.onclick = e => e.stopPropagation();
        inp.onchange = () => { const n = Math.round(num(inp.value, 0)); this.reduceTarget = n >= 4 ? n : 0; this.faceMode = this.reduceTarget ? 'reduce' : ''; this._render(); };
        ctl.querySelectorAll('button').forEach(b => {
          b.onclick = e => { e.stopPropagation(); const n = REDUCE_PRESETS[+b.dataset.k][1]; if (!n) { this.faceMode = 'raw'; this._render(); return; } this.reduceTarget = n; this.faceMode = 'reduce'; this._render(); };
        });
      }
      if (ok) {
        card.title = '點卡片：用這個；點小圖：放大看';
        card.onclick = () => { if (mode === 'reduce' && !(this.reduceTarget > 0)) return; this.faceMode = mode; this._render(); };
        if (r && r.lazy) th.textContent = '點了才算、才畫';   // 只數過、還沒減 ⇒ 不畫（畫出來會是原樣，誤導）
        else {
          th.onclick = e => { e.stopPropagation(); this._bigFaceThumb(mode, title); };
          this._faceThumb(th, mode, 200, 150);
        }
      } else card.classList.add('off');
      row.appendChild(card);
    }
    d.appendChild(row);
    return d;
  }

  /**
   * 「對稱」那一行（kang 2026-10-31 (c)(d)(e)(f)(h)）：好幾個部分 ⇒ 變灰寫原因；最對稱的軸 < `SYM_SHOW` ⇒ 不出現；
   * ≥ `SYM_SHOW` ⇒ 勾選＋軸＋照哪一半，≥ `SYM_ON` 預設勾、不到的預設不勾並寫「會把不對稱的地方改成對稱」。
   */
  _symCtl() {
    const inf = this._symInfo();
    if (!inf) return '';
    if (inf.many) return '<br><label class="i3SymLbl" style="opacity:.55"><input type="checkbox" class="i3Sym" disabled> 對稱減面：好幾個部分時不能用（不勾上面的「一個部分一個物件」就可以）</label>';
    if (inf.pending) return '<br><span class="i3SymLbl">對稱減面：正在量左右對不對稱…</span>';
    if (inf.error) return `<br><span class="i3SymLbl">${esc(inf.error)}</span>`;
    if (!inf.show) return '';
    const on = this.symOn === null ? inf.defaultOn : this.symOn, A = SYM_AXES[inf.ax];
    const opt = m => `<option value="${m}"${this.symAxis === m ? ' selected' : ''}>${SYM_AXES[m][0]}（${pct(inf.pct(m))} 對稱）</option>`;
    return `<br><label class="i3SymLbl"><input type="checkbox" class="i3Sym"${on ? ' checked' : ''}> 對稱減面（比較快）</label> `
      + `<select class="i3SymAx"><option value=""${this.symAxis ? '' : ' selected'}>自動：${SYM_AXES[inf.autoAx][0]}（${pct(inf.best)} 對稱）</option>${['x', 'y', 'z'].map(opt).join('')}</select> `
      + `<select class="i3SymSide"><option value="-1"${this.symSide < 0 ? ' selected' : ''}>照${A[1]}半</option><option value="1"${this.symSide > 0 ? ' selected' : ''}>照${A[2]}半</option></select>`
      + (inf.defaultOn ? '' : `<br><span class="i3SymLbl">⚠ 只有 ${pct(inf.best)} 對稱 —— 勾了會把不對稱的地方改成對稱（看上面的「表面離原本最多」）</span>`);
  }

  _symWire(ctl) {
    const ck = ctl.querySelector('.i3Sym'), ax = ctl.querySelector('.i3SymAx'), sd = ctl.querySelector('.i3SymSide');
    if (ck && !ck.disabled) {
      ck.parentElement.title = '切一半減、鏡射接回：左右兩半的網格一模一樣、展開片左右成對（可以對折一起剪）、快一倍。'
        + '原本就對稱的形狀幾乎不變；不太對稱的會被改成對稱';
      ck.parentElement.onclick = e => e.stopPropagation();
      ck.onchange = () => { this.symOn = ck.checked; this._render(); };
    }
    for (const el of [ax, sd]) if (el) el.onclick = e => e.stopPropagation();
    if (ax) { ax.title = '鏡射面沿哪一個方向（建模器的方向：左右 ＝ X）；自動 ＝ 量起來最對稱的那一個'; ax.onchange = () => { this.symAxis = ax.value; this._render(); }; }
    if (sd) { sd.title = '另一半照這一半鏡射過去（很對稱的模型兩半一樣；不太對稱時挑比較好的那一半）'; sd.onchange = () => { this.symSide = +sd.value; this._render(); }; }
  }

  /** 面數卡片的小圖（換算後的樣子）*/
  _faceThumb(el, mode, w, h) {
    const F = this._face, s = this._setting(), base = this._base;
    if (!F.thumbs) F.thumbs = {};
    const r = mode === 'raw' ? null : F[mode];
    const conv = s.up === 'z' ? q => [q[0] * s.cmPerUnit, q[2] * s.cmPerUnit, -q[1] * s.cmPerUnit] : q => [q[0] * s.cmPerUnit, q[1] * s.cmPerUnit, q[2] * s.cmPerUnit];
    this._thumbPut(el, F.thumbs, `${mode}|${r ? r.target : 0}|${r && r.noCross ? 'nc' : ''}|${r ? r.symKey : ''}|${s.up}|${w}`, () => this._face === F,
      () => (r ? r.parts : base.parts).map(p => ({ points: p.points.map(conv), faces: p.faces })), w, h);
  }

  _bigFaceThumb(mode, title) {
    const ov = document.createElement('div');
    ov.className = 'i3Big';
    ov.innerHTML = `<div><b>${esc(title)}</b>　<span>紅線 ＝ 破洞的邊；橘線 ＝ 三面以上共用的邊。點一下關掉</span></div><div class="i3BigImg"></div>`;
    ov.onclick = () => ov.remove();
    this.el.appendChild(ov);
    this._faceThumb(ov.querySelector('.i3BigImg'), mode, 720, 540);
  }

  _fillSelects() {
    const r = this.read;
    const gU = guessUnit(r.format, r.size), gUp = guessUp(r.format);
    this.unitSel.innerHTML = '';
    for (const u of ['', ...Object.keys(UNIT_CM)]) {
      const o = document.createElement('option');
      o.value = u;
      o.textContent = u ? UNIT_LABEL[u] : `照猜的（${gU}）`;
      this.unitSel.appendChild(o);
    }
    this.unitSel.value = this.unit;
    this.upSel.innerHTML = '';
    for (const [v, t] of [['', `照猜的（${gUp.toUpperCase()} 朝上）`], ['y', 'Y 朝上'], ['z', 'Z 朝上']]) {
      const o = document.createElement('option');
      o.value = v; o.textContent = t;
      this.upSel.appendChild(o);
    }
    this.upSel.value = this.up;
  }

  _render() {
    this.body.innerHTML = '';
    const r = this.read;
    if (!r) {
      this.sum.textContent = '';
      this.goBtn.disabled = true;
      this.body.appendChild(box('uwSkip',
        '按「選檔案」挑一個 .stl、.obj 或 .glb。匯進來是「骨架」—— 之後用建模器改它。'
        + '顏色、貼圖不讀，只讀形狀。網路上的模型記得看授權（CC0 最省事；ND 不能改）。'));
      return;
    }
    if (!r.ok) {
      this.sum.textContent = '讀不到東西';
      this.goBtn.disabled = true;
      this.body.appendChild(box('uwWarn', '⚠ ' + r.reason));
      return;
    }
    this._fillSelects();
    const { parts, planes, solid, shell, face, quad } = this._parts();
    /** 選的面數做法還在算、只留正面還在算 ⇒ 匯入鈕先不能按（不然匯進去的是原樣、跟卡片上選的不一樣）*/
    const busy = !face.ready ? '面數那一區' : shell.pending ? '只留正面那一區' : '';
    this.goBtn.disabled = !!busy;
    this.goBtn.title = busy ? `${busy}還在算 —— 算好才能匯入` : '';
    const nFaces = parts.reduce((n, p) => n + p.faces.length, 0);
    this.sum.textContent = `${nFaces} 個面、${parts.length} 個物件` + (busy ? `（${busy}還在算）` : '');
    this.body.appendChild(this._sizeCard());
    if (this._solid) this.body.appendChild(this._solidRow(solid));
    this.body.appendChild(this._shellRow(shell));
    if (planes.cut + planes.grid) this.body.appendChild(this._planeRow(planes));
    this.body.appendChild(this._faceRow(face, this._base.parts.reduce((n, p) => n + p.faces.length, 0)));
    this.body.appendChild(this._quadRow(quad));

    // 清理、檢查：照實講
    const st = r.stats, ck = r.check;
    const cleaned = [];
    if (st.merged) cleaned.push(`位置一樣的點合成一個：${st.merged} 個`);
    if (st.dup) cleaned.push(`重複的面拿掉：${st.dup} 個（有的檔把同一個面寫了兩次）`);
    if (st.degen) cleaned.push(`壞掉的面（少於 3 個不同的點）拿掉：${st.degen} 個`);
    if (cleaned.length) this.body.appendChild(box('uwSkip', '自動清理 —— ' + cleaned.join('；')));
    /**
     * 這幾行講的是**原檔**。上面選了補洞或聯集（網格核心第五批 b ③a）⇒ 破洞、翻面那兩種會被處理 ——
     * 再寫「程式不自己補」就跟上面矛盾（線上先驗看到的）⇒ 改成講「原檔有…，上面選的做法會處理」；
     * 三面共用（隔板）這兩種做法都修不了，照舊警告。
     */
    /**
     * 三面共用（隔板）：③b 起選了「聯集」會修剖面比得過的那幾塊（線上先驗又看到「程式不自己補」跟上面矛盾）⇒
     * 有修好的就講「修好其中幾塊、其他照原樣」，一塊都沒修好才照舊警告。
     */
    const uinfo = solid === 'union' && this._solid && this._solid.variants.union ? this._solid.variants.union.info : null;
    const partFixed = uinfo ? uinfo.partFixed || 0 : 0;
    const bad = [];
    if (ck.open) bad.push([`有 ${ck.open} 條邊只接一個面（模型有破洞，或本來就是開口的面）`, true]);
    if (ck.nonManifold) bad.push([`有 ${ck.nonManifold} 條邊被三個以上的面共用（接不起來，分片、展開可能怪怪的）`, partFixed > 0]);
    if (ck.flipped) bad.push([`有 ${ck.flipped} 條邊兩邊的面繞的方向不一致（有面翻過來了）`, true]);
    for (const [b, fixable] of bad) {
      const part = /三個以上的面共用/.test(b);
      if (fixable && solid !== 'raw') {
        this.body.appendChild(box('uwSkip', part
          ? `原檔${b} —— 上面選了「${SOLID_MODES[solid]}」修好其中 ${partFixed} 塊的隔板${uinfo.kept ? `、${uinfo.kept} 塊照原樣` : ''}，處理之後的樣子看那張卡`
          : `原檔${b} —— 上面選了「${SOLID_MODES[solid]}」會處理，處理之後的樣子看那張卡`));
      } else this.body.appendChild(box('uwWarn', '⚠ ' + (solid !== 'raw' ? '原檔' : '') + b + ' —— 程式不自己補，匯進來之後照實看'));
    }
    if (!bad.length) this.body.appendChild(box('uwSkip', '檢查：沒有破洞、沒有接不起來的邊、面的方向一致'));
    if (nFaces > MANY_FACES) {
      this.body.appendChild(box('uwWarn', `⚠ 面很多（${nFaces} 個）：分片、智慧分切、展開會比較慢 —— 可以用上面的「減到 ___ 面」，或找面少一點的模型（low poly）`));
    }
    for (const n of r.notes) this.body.appendChild(box('uwSkip', n));

    // 一個部分一列
    const tb = document.createElement('table');
    tb.className = 'uwBom';
    tb.innerHTML = '<tr><th>物件</th><th>面</th><th>點</th><th>大小 cm（寬 × 高 × 深）</th></tr>'
      + parts.map((p, i) => {
        const b = bounds3(p.points);
        return `<tr><td>${esc(this._name(p, i))}</td><td>${p.faces.length}</td><td>${p.points.length}</td>`
          + `<td>${f(b.w)} × ${f(b.h)} × ${f(b.d)}</td></tr>`;
      }).join('');
    const wrap = document.createElement('div');
    wrap.className = 'uwBomWrap';
    wrap.innerHTML = '<h3>會建立的物件</h3>';
    wrap.appendChild(tb);
    this.body.appendChild(wrap);
  }

  /** 尺寸卡：整個視窗最重要的東西 —— 使用者唯一需要核對的就是這三個數字 */
  _sizeCard() {
    const s = this._setting(), z = this._sizeCm();
    const guessed = !this.unit && !this.cmFix;
    const card = document.createElement('div');
    card.className = 'uwCard';
    card.innerHTML = `
      <div class="uwTitle"><div class="nm">換算後的實際大小（寬 × 高 × 深）</div></div>
      <div style="font-size:26px;font-weight:600;color:${guessed ? '#e8b84b' : '#7dd87d'};margin:2px 0 6px;letter-spacing:.5px">
        ${f(z.w)} × ${f(z.h)} × ${f(z.d)} <span style="font-size:15px">cm</span>
      </div>
      <div style="color:#8b93a1;font-size:12px;margin-bottom:10px">
        ${this.cmFix ? '照你校正的比例' : `單位 ${UNIT_LABEL[s.unit]}${guessed ? '（猜的 —— 檔案裡沒有寫）' : ''}`}　${s.up.toUpperCase()} 朝上
      </div>
      <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">
        <span class="lbl">不對的話 → 整體高度其實是</span>
        <input type="number" id="i3H" step="0.1" min="0.01" style="width:90px" value="${Math.round(z.h * 100) / 100}">
        <span class="lbl">cm</span>
        <button class="mini" id="i3Fix">照這個校正</button>
      </div>`;
    card.querySelector('#i3Fix').onclick = () => {
      const want = num(card.querySelector('#i3H').value, 0);
      if (!(want > 0) || !(z.h > 0)) return;
      this.cmFix = s.cmPerUnit * (want / z.h);         // 目前的高 × 倍率 ＝ 你說的高
      this._render();
      if (this.app.toast) this.app.toast(`比例已校正，整體高度設為 ${want} cm`);
    };
    return card;
  }

  _name(p, i) {
    const base = baseName(this.fileName) || '匯入模型';
    if (!p.name) return base;
    if (p.name.startsWith('（')) return base + p.name;     // 第三輪第三批 ②-13：「（聯集）」「（另外放的 10 塊）」接在檔名後面
    return p.name === base ? base : `${base}－${p.name || i + 1}`;
  }

  /**
   * 匯入：每個部分建一個網格物件（原點在自己的中心），整組的相對位置照原樣；
   * 整組底部放在地板上，照新物件的規則擺在畫面中間的空位（⛔ 跟原有的東西疊在一起），鏡頭拉過去。
   */
  _import() {
    const r = this.read;
    if (!r || !r.ok) return;
    const { parts, face, quad, shell } = this._parts();
    if (!face.ready || shell.pending) return;               // 還在算（匯入鈕本來就不能按）
    /** 面皮 ⇒ 面皮板件（開放、板厚 ＝ 量到的牆厚、往內長；kang 2026-10-31 (g)）*/
    const skin = shell.using === 'skin', s = this._setting();
    const wall = skin ? Math.max(0.01, Math.round(shell.find.wall * s.cmPerUnit * 100) / 100) : 0;
    const objs = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const mesh = Mesh.fromFaceList(p.points.map(q => new THREE.Vector3(q[0], q[1], q[2])), p.faces);
      markGrid(mesh, p.grid);                            // 照原檔一格一格的平面：格線看得見（網格核心第五批 b ②）
      const o = new ModelObject(skin ? { name: this._name(p, i), kind: KIND.SHEET, src: { type: 'mesh' }, mesh, thickness: wall, shellIn: true }
        : { name: this._name(p, i), kind: KIND.SOLID, src: { type: 'mesh' }, mesh });
      recenterOrigin(o);                                 // 原點在自己的中心、位置照原樣
      objs.push(o);
    }
    // 整組：中心對到 X 0、Z 0，底部貼地 ⇒ 再找畫面中間的空位
    const all = unionBounds(objs);
    const cx = (all.min.x + all.max.x) / 2, cz = (all.min.z + all.max.z) / 2, dy = -all.min.y;
    for (const o of objs) { o.pos.x -= cx; o.pos.y += dy; o.pos.z -= cz; }
    const view = this.app.view;
    if (view && view.orbit && objs.length) {
      const t = view.orbit.target;
      const spot = freeSpot(unionBounds(objs), { x: t.x, z: t.z }, this.app.doc.objects.map(worldBounds));
      for (const o of objs) { o.pos.x += spot.x; o.pos.z += spot.z; }
    }
    for (const o of objs) this.app.doc.add(o);      // 圖層 2a：走 doc.add() ⇒ 放「目前這一層」（以前直接 push，⛔ 經過它）
    this.app.sel.set(objs.map(o => o.id));
    this.app.onEdit(`匯入 3D 模型（${objs.length} 個物件）`);
    if (this.app.view) this.app.view.frameAll(this.app.doc, objs.map(o => o.id));
    const z = this._sizeCm();
    const nFaces = parts.reduce((n, p) => n + p.faces.length, 0);
    if (this.app.toast) {
      this.app.toast(`已匯入「${this.fileName}」：${objs.length} 個網格物件、${nFaces} 個面，${f(z.w)} × ${f(z.h)} × ${f(z.d)} cm`
        + (face.using === 'clean' && face.clean.removed ? `（清碎面：少 ${face.clean.removed} 個面）` : '')
        + (face.using === 'reduce' ? `（減到 ${face.reduce.faces} 個面${face.reduce.sym ? '、' + face.reduce.sym : ''}）` : '')
        + (quad.using === 'pair' ? `（兩兩合併：合了 ${quad.pairs} 對）` : '')
        + (this._solidPick().mode !== 'raw' ? `（${SOLID_MODES[this._solidPick().mode]}）` : '')
        + (shell.using === 'skin' ? `（只留正面：面皮板件、板厚 ${mm(wall)} mm）` : shell.using === 'solid' ? '（只留正面：實心）' : '')
        + '（鏡頭已拉到它們）　之後用建模器改它（拉點線面、刀具、布林…）');
    }
    this.close();
  }
}

/**
 * 小圖：一個不顯示的畫布（整個建模器只開一個），把模型畫成圖片；破洞的邊畫紅、三面共用的邊畫橘 ——
 * 原樣跟補洞後一比就看得出補了哪裡。用換算後（cm、Y 朝上）的樣子、從斜上方看。
 */
let _thumbR = null;
function thumbURL(parts, w, h, wire = false) {
  try {
    if (!_thumbR) _thumbR = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    const R = _thumbR;
    R.setPixelRatio(1);
    R.setSize(w, h, false);
    // 好幾個部分合成一份畫（點的編號接著算）
    const p = { points: [], faces: [] };
    for (const q of parts) { const b = p.points.length; for (const x of q.points) p.points.push(x); for (const f of q.faces) p.faces.push(f.map(i => i + b)); }
    const pos = [];
    for (const f of p.faces) for (let k = 1; k + 1 < f.length; k++) for (const i of [f[0], f[k], f[k + 1]]) pos.push(...p.points[i]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x8fb3e8, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })));
    const cnt = new Map();
    for (const f of p.faces) for (let k = 0; k < f.length; k++) { const a = f[k], b = f[(k + 1) % f.length], key = a < b ? a + '-' + b : b + '-' + a; cnt.set(key, (cnt.get(key) || 0) + 1); }
    const red = [], orange = [], grey = [];
    /** `wire` ＝ 每一條線都畫（三角形那一區要看得出三角形還是四邊形）；線太多（20 萬條以上）就不畫，⛔ 卡住 */
    const drawAll = wire && cnt.size <= 200000;
    for (const [key, n] of cnt) {
      if (n === 2 && !drawAll) continue;
      const [a, b] = key.split('-').map(Number);
      (n === 1 ? red : n > 2 ? orange : grey).push(...p.points[a], ...p.points[b]);
    }
    const lines = [];
    for (const [arr, col] of [[grey, 0x2a3445], [red, 0xff3b30], [orange, 0xff9f0a]]) {
      if (!arr.length) continue;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      // 灰線（每一條邊）被前面的面擋住、背面的看不到；紅、橘（破洞、三面共用）照舊穿透 —— 藏在後面的也要看得到
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: col, depthTest: col === 0x2a3445 }));
      l.renderOrder = 1; scene.add(l); lines.push(g);
    }
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.1));
    const dl = new THREE.DirectionalLight(0xffffff, 1.2); dl.position.set(1, 2, 1.5); scene.add(dl);
    geo.computeBoundingSphere();
    const bs = geo.boundingSphere, cam = new THREE.PerspectiveCamera(30, w / h, bs.radius / 100, bs.radius * 100);
    const dist = bs.radius / Math.sin(THREE.MathUtils.degToRad(15)) * 1.05;
    cam.position.copy(bs.center).add(new THREE.Vector3(1, 0.8, 1.2).normalize().multiplyScalar(dist));
    cam.lookAt(bs.center);
    R.setClearColor(0x1b1f27, 1);
    R.render(scene, cam);
    const url = R.domElement.toDataURL('image/png');
    geo.dispose(); for (const g of lines) g.dispose();
    return url;
  } catch (e) {
    return null;
  }
}

function box(cls, msg) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = msg;
  return d;
}
function bounds3(pts) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  return { w: hi[0] - lo[0], h: hi[1] - lo[1], d: hi[2] - lo[2] };
}
const baseName = s => String(s || '').replace(/\.[^.]+$/, '');
const f = v => String(Math.round(v * 100) / 100);
/** cm → mm 的字（小的留到 0.001）*/
const mm = cm => String(Math.round(cm * 10 * 1000) / 1000);
const pct = x => (Math.round(x * 1000) / 10) + '%';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
/** 每個部分的面拆成三角形（點換成 {x,y,z}），給 `crossCheck` 數穿面（不同部分之間穿過去也算）*/
/**
 * 只留正面的方向：建模器（Y 朝上、+Z 朝前）↔ 檔案的座標。Z 朝上的檔：建模器 (x, y, z) ＝ 檔案 (x, z, −y)（`toParts()` 的換法）
 */
const M2F_Z = { '+x': '+x', '-x': '-x', '+y': '+z', '-y': '-z', '+z': '-y', '-z': '+y' };
function toFile(k, up) { return up === 'z' ? M2F_Z[k] : k; }
function toModel(k, up) { return up === 'z' ? Object.keys(M2F_Z).find(m => M2F_Z[m] === k) : k; }
function crossTris(parts) {
  const out = [];
  for (const p of parts) {
    const V = p.points.map(q => ({ x: q[0], y: q[1], z: q[2] }));
    for (const f of p.faces) for (let k = 1; k + 1 < f.length; k++) out.push({ a: V[f[0]], b: V[f[k]], c: V[f[k + 1]] });
  }
  return out;
}
function loadOpt() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
}
function save(o) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) { /* 無所謂 */ }
}
