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
import { Mesh } from '../core/mesh.js';
import { ModelObject, KIND, recenterOrigin } from '../core/io.js';
import { worldBounds, unionBounds, freeSpot } from '../core/align.js';

const LS_KEY = 'modeler_import3d';
/** 面超過這麼多就提醒：分片、展開會慢（減面是第三步，還沒做）*/
const MANY_FACES = 20000;

export class Import3DPanel {
  /** @param {object} app { doc, sel, onEdit, toast, view } */
  constructor(app) {
    this.app = app;
    /**
     * split ＝ 一個部分一個物件（預設，跟匯入線稿一樣）；micro ＝ 清掉極小的碎面（預設開，kang 選甲）；
     * planes ＝ 平面上的小塊怎麼辦（`PLANE_MODES`，預設照建議 —— 網格核心第五批 b ②）
     */
    this.opt = { split: true, micro: true, planes: 'suggest', ...loadOpt() };
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
          <button class="mini" id="i3Close">關閉</button>
        </div>
        <div class="uwBar">
          <button id="i3Pick">選檔案（.stl／.obj／.glb）…</button>
          <span class="lbl" id="i3File">還沒選檔案</span>
          <span class="sp"></span>
          <span class="lbl">單位</span>
          <select id="i3Unit"></select>
          <span class="lbl">朝上</span>
          <select id="i3Up"></select>
          <label class="uwCk"><input type="checkbox" id="i3Split"> 一個部分一個物件</label>
          <span class="sp"></span>
          <button id="i3Go" disabled>匯入成網格物件</button>
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
    this._judged = null;
    this._solid = null;
    this.solidMode = '';           // '' ＝ 照建議（換檔案清回來）
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
    const needFill = check.holes > 0, needUnion = check.comps > 1;
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
   * 會建立的部分（cm、Y 朝上）；碎面打開的話每個部分先清（`collapseShort()`）。
   * 預覽與匯入用同一支 ⇒ 視窗寫的就是匯進去的。
   * 🔴 **先判斷每一片平面、再清碎面**（網格核心第五批 b ②）：照原檔一格一格的平面，它的點清碎面⛔ 動；
   * 每個部分多帶 `grid`（那幾片平面裡面的線，匯入時標 `hard`）。
   */
  _parts() {
    const pick = this._solidPick(), r = pick.read, s = this._setting();
    const split = this.opt.split !== false;
    let parts = toParts(r, { cmPerUnit: s.cmPerUnit, up: s.up, split });
    const micro = { on: this.opt.micro !== false, ...this._microTol(), collapsed: 0, kept: 0, removed: 0, maxMove: 0 };
    const mode = PLANE_MODES[this.opt.planes] ? this.opt.planes : 'suggest';
    /**
     * 判斷只看角度與比例，跟單位、朝上無關 ⇒ 同一個檔、同一種拆法只判一次（大的模型要幾秒，⛔ 每改一個設定就重來）。
     * ⚠ `toParts()` 換單位、朝上只動座標，面的編號不變 —— 所以快取用拆法當鑰匙就夠。
     */
    if (!this._judged || this._judged.split !== split || this._judged.solid !== pick.mode) this._judged = { split, solid: pick.mode, list: parts.map(judgePlanes) };
    const planes = { mode, cut: 0, grid: 0, cutFaces: 0, gridFaces: 0, kept: 0, keptFaces: 0 };
    parts = parts.map((p, i) => {
      const j = this._judged.list[i], regs = keptRegions(j, mode);
      for (const k of ['cut', 'grid', 'cutFaces', 'gridFaces']) planes[k] += j[k];
      planes.kept += regs.length;
      for (const g of regs) planes.keptFaces += g.faces.length;
      let q = p, from = p.faces.map((_, k) => k);
      if (micro.on) {
        q = collapseShort(p, micro.tol, regs.length ? keepVerts(p, regs) : null);
        from = q.from;
        micro.collapsed += q.stats.collapsed; micro.kept += q.stats.kept; micro.removed += q.stats.removed;
        micro.maxMove = Math.max(micro.maxMove, q.stats.maxMove);
      }
      return { ...q, grid: gridEdges(q, regs, from) };
    });
    return { parts, micro, planes, solid: pick.mode };
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
      t.push(`${i.united} 塊聯集成 ${i.pieces} 個實體`);
      if (i.overlap > 0) t.push(`重疊 ${Math.round(i.overlap * 1000) / 10}%`);
      if (i.dropped) t.push(`丟掉 ${i.dropped} 塊碎屑`);
      if (i.kept) t.push(`${i.kept} 塊有隔板照原樣另外放`);
      t.push(i.kept ? '聯集的那些匯入後是一個物件' : '匯入後是一個物件');
    }
    return t.join('　');
  }

  /** 小圖：畫好放進 `el`（同一個做法、同一個朝上只畫一次）*/
  _thumbInto(el, mode, w, h) {
    const s = this._setting(), key = `${mode}|${s.up}|${w}`;
    const sol = this._solid;
    const put = url => { el.innerHTML = ''; const img = document.createElement('img'); img.src = url; img.width = w; img.height = h; el.appendChild(img); };
    if (sol.thumbs[key]) { put(sol.thumbs[key]); return; }
    el.textContent = '畫圖中…';
    requestAnimationFrame(() => {
      if (this._solid !== sol) return;
      const url = thumbURL(sol.variants[mode].read, s, w, h);
      if (url) { sol.thumbs[key] = url; put(url); } else el.textContent = '畫不出來';
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
    if (pl.kept && this.opt.micro !== false) res.textContent += '（照原檔的平面，清碎面不會動它）';
    return d;
  }

  /** 碎面那一列：勾不勾、門檻、清了多少（照實講）*/
  _microRow(m) {
    const d = document.createElement('div');
    d.className = 'uwSkip';
    d.innerHTML = `
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <label style="display:inline-flex;gap:4px;align-items:center;cursor:pointer"><input type="checkbox" id="i3Micro"> 清掉極小的碎面：比</label>
        <input type="number" id="i3MicroMm" step="0.01" min="0" style="width:70px" placeholder="${mm(m.auto)}" value="${this.microMm > 0 ? this.microMm : ''}">
        <span>mm 短的邊縮掉（空白 ＝ 自動：最長的那一邊 ÷ ${MICRO_DIV} ＝ ${mm(m.auto)} mm）</span>
      </div>
      <div id="i3MicroRes" style="margin-top:4px"></div>`;
    const ck = d.querySelector('#i3Micro'), inp = d.querySelector('#i3MicroMm'), res = d.querySelector('#i3MicroRes');
    ck.checked = m.on;
    ck.parentElement.title = '模型上很窄、很小的面（看不到，但展開時會報「重疊」）：比門檻短的邊兩端合到中點，小的面跟著不見。'
      + '縮了會弄出破洞、讓面翻過去的那一條就不縮。不要清就取消勾選';
    inp.title = '空白 ＝ 自動（照模型大小，放大縮小都清掉同樣的碎面）。自己打一個 mm 就照你的；打得太大會把真的細節也縮掉 —— 看下面寫的「形狀最多動」';
    inp.disabled = !m.on;
    ck.onchange = () => { this.opt.micro = ck.checked; save(this.opt); this._render(); };
    inp.onchange = () => { this.microMm = Math.max(0, num(inp.value, 0)); this._render(); };
    if (!m.on) res.textContent = '不清：照檔案原樣匯入';
    else if (!m.collapsed) res.textContent = `沒有比 ${mm(m.tol)} mm 短、縮了不會壞的邊 —— 不用清`;
    else res.textContent = `縮掉 ${m.collapsed} 條很短的邊、少 ${m.removed} 個面，形狀最多動 ${mm(m.maxMove)} mm`;
    if (m.on && m.kept) res.textContent += `；另有 ${m.kept} 條比門檻短，但縮了會弄出破洞或讓面翻過去，留著`;
    return d;
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
    this.goBtn.disabled = false;
    const { parts, micro, planes, solid } = this._parts();
    const nFaces = parts.reduce((n, p) => n + p.faces.length, 0);
    this.sum.textContent = `${nFaces} 個面、${parts.length} 個物件`;
    this.body.appendChild(this._sizeCard());
    if (this._solid) this.body.appendChild(this._solidRow(solid));
    if (planes.cut + planes.grid) this.body.appendChild(this._planeRow(planes));
    this.body.appendChild(this._microRow(micro));

    // 清理、檢查：照實講
    const st = r.stats, ck = r.check;
    const cleaned = [];
    if (st.merged) cleaned.push(`位置一樣的點合成一個：${st.merged} 個`);
    if (st.dup) cleaned.push(`重複的面拿掉：${st.dup} 個（有的檔把同一個面寫了兩次）`);
    if (st.degen) cleaned.push(`壞掉的面（少於 3 個不同的點）拿掉：${st.degen} 個`);
    if (cleaned.length) this.body.appendChild(box('uwSkip', '自動清理 —— ' + cleaned.join('；')));
    const bad = [];
    if (ck.open) bad.push(`有 ${ck.open} 條邊只接一個面（模型有破洞，或本來就是開口的面）`);
    if (ck.nonManifold) bad.push(`有 ${ck.nonManifold} 條邊被三個以上的面共用（接不起來，分片、展開可能怪怪的）`);
    if (ck.flipped) bad.push(`有 ${ck.flipped} 條邊兩邊的面繞的方向不一致（有面翻過來了）`);
    for (const b of bad) this.body.appendChild(box('uwWarn', '⚠ ' + b + ' —— 程式不自己補，匯進來之後照實看'));
    if (!bad.length) this.body.appendChild(box('uwSkip', '檢查：沒有破洞、沒有接不起來的邊、面的方向一致'));
    if (r.faces.length > MANY_FACES) {
      this.body.appendChild(box('uwWarn', `⚠ 面很多（${r.faces.length} 個）：分片、智慧分切、展開會比較慢 —— 找面少一點的模型（low poly）比較好改`));
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
    return p.name === base ? base : `${base}－${p.name || i + 1}`;
  }

  /**
   * 匯入：每個部分建一個網格物件（原點在自己的中心），整組的相對位置照原樣；
   * 整組底部放在地板上，照新物件的規則擺在畫面中間的空位（⛔ 跟原有的東西疊在一起），鏡頭拉過去。
   */
  _import() {
    const r = this.read;
    if (!r || !r.ok) return;
    const { parts, micro } = this._parts();
    const objs = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const mesh = Mesh.fromFaceList(p.points.map(q => new THREE.Vector3(q[0], q[1], q[2])), p.faces);
      markGrid(mesh, p.grid);                            // 照原檔一格一格的平面：格線看得見（網格核心第五批 b ②）
      const o = new ModelObject({ name: this._name(p, i), kind: KIND.SOLID, src: { type: 'mesh' }, mesh });
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
    for (const o of objs) this.app.doc.objects.push(o);
    this.app.sel.set(objs.map(o => o.id));
    this.app.onEdit(`匯入 3D 模型（${objs.length} 個物件）`);
    if (this.app.view) this.app.view.frameAll(this.app.doc, objs.map(o => o.id));
    const z = this._sizeCm();
    const nFaces = parts.reduce((n, p) => n + p.faces.length, 0);
    if (this.app.toast) {
      this.app.toast(`已匯入「${this.fileName}」：${objs.length} 個網格物件、${nFaces} 個面，${f(z.w)} × ${f(z.h)} × ${f(z.d)} cm`
        + (micro.on && micro.removed ? `（清掉 ${micro.removed} 個極小的碎面）` : '')
        + (this._solidPick().mode !== 'raw' ? `（${SOLID_MODES[this._solidPick().mode]}）` : '')
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
function thumbURL(read, s, w, h) {
  try {
    if (!_thumbR) _thumbR = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    const R = _thumbR;
    R.setPixelRatio(1);
    R.setSize(w, h, false);
    const [p] = toParts(read, { cmPerUnit: s.cmPerUnit, up: s.up, split: false });
    const pos = [];
    for (const f of p.faces) for (let k = 1; k + 1 < f.length; k++) for (const i of [f[0], f[k], f[k + 1]]) pos.push(...p.points[i]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x8fb3e8, side: THREE.DoubleSide })));
    const cnt = new Map();
    for (const f of p.faces) for (let k = 0; k < f.length; k++) { const a = f[k], b = f[(k + 1) % f.length], key = a < b ? a + '-' + b : b + '-' + a; cnt.set(key, (cnt.get(key) || 0) + 1); }
    const red = [], orange = [];
    for (const [key, n] of cnt) { if (n === 2) continue; const [a, b] = key.split('-').map(Number); (n === 1 ? red : orange).push(...p.points[a], ...p.points[b]); }
    const lines = [];
    for (const [arr, col] of [[red, 0xff3b30], [orange, 0xff9f0a]]) {
      if (!arr.length) continue;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: col, depthTest: false }));
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
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
function loadOpt() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
}
function save(o) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) { /* 無所謂 */ }
}
