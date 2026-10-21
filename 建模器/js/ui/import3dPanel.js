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
import { readModel, cleanModel, edgeCheck, guessUnit, guessUp, toParts, UNIT_CM, UNIT_LABEL } from '../build/import3d.js';
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
    /** split ＝ 一個部分一個物件（預設，跟匯入線稿一樣）*/
    this.opt = { split: true, ...loadOpt() };
    this.fileName = '';
    this.read = null;            // 讀出來、清理過的
    this.unit = '';              // '' ＝ 照猜的
    this.up = '';                // '' ＝ 照猜的
    this.cmFix = 0;              // 手動校正：1 個檔案單位 ＝ 幾 cm；0 ＝ 照單位
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
    this.unit = ''; this.up = ''; this.cmFix = 0;
    const r = readModel(name, buf);
    this.read = r.ok ? { ...cleanModel(r), ok: true } : r;
    if (this.read.ok) this.read.check = edgeCheck(this.read.faces);
    this._render();
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
    const s = this._setting();
    const parts = toParts(r, { cmPerUnit: s.cmPerUnit, up: s.up, split: this.opt.split !== false });
    this.sum.textContent = `${r.faces.length} 個面、${r.points.length} 個點、${parts.length} 個物件`;
    this.body.appendChild(this._sizeCard());

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
    const s = this._setting();
    const parts = toParts(r, { cmPerUnit: s.cmPerUnit, up: s.up, split: this.opt.split !== false });
    const objs = [];
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const mesh = Mesh.fromFaceList(p.points.map(q => new THREE.Vector3(q[0], q[1], q[2])), p.faces);
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
    if (this.app.toast) {
      this.app.toast(`已匯入「${this.fileName}」：${objs.length} 個網格物件、${r.faces.length} 個面，${f(z.w)} × ${f(z.h)} × ${f(z.d)} cm（鏡頭已拉到它們）`
        + '　之後用建模器改它（拉點線面、刀具、布林…）');
    }
    this.close();
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
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v, d) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };
function loadOpt() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; }
}
function save(o) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) { /* 無所謂 */ }
}
