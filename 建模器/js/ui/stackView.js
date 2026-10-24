/**
 * stackView.js — 剖面分切視窗最上面的「立體預覽」（3D 小畫面）
 *
 * 🔴 第二輪第五批 5b（2026-10-24，kang「方案一（視窗最上面一塊 3D 小畫面），預設＋可以調照表」
 * → `規格\建模器-剖面分切.md`「疊板立體預覽」；三種擺法的對照在 `實驗-綜合評估-第二輪.md` 5b）。
 *
 * | 項目 | 預設 | 可以調 |
 * |---|---|---|
 * | 3D 小畫面 | 開著 | 收起來（跟人走）|
 * | 只看第 a～b 片 | 全部 | 兩格數字（跟模型走）|
 * | 拉開、只看有問題的 | 關 | 勾（跟人走）|
 * | 淡淡的原模型 | 開；超過 `GHOST_MAX_TRIS` 個三角形先不疊 | 勾（大模型勾了才疊，只記這一次）|
 * | 點一片 | 下面跳到那一片的卡片、框起來 | —— |
 *
 * 要算的東西在 `view/stackModel.js`（node 測得到）；這裡只管畫面、轉動、點選。
 * ⚠ 畫面跟著 `slicePanel._render()` 每次重排：**同一個元素拿回來再接上去**，⛔ 每次開一個新的 WebGL（開太多瀏覽器會丟掉舊的）。
 * ⚠ ⛔ 一直重畫：轉動、改設定才畫一次（OrbitControls 的 change）。存檔、列印⛔ 放它（跟 5a 的顏色一樣只在畫面）。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildStack, ghostOf, trisOf, disposeGroup, GHOST_MAX_TRIS } from '../view/stackModel.js';

const HEIGHT = 260;
/** 一開始從右前上方斜著看整疊 */
const VIEW_DIR = new THREE.Vector3(0.9, 0.7, 1.1).normalize();

export class StackView {
  /**
   * @param {object} opt 跟人走的設定（slicePanel 的 `opt.stack3d`，改了由 `onSave` 存）
   * @param {Function} onSave
   * @param {Function} onPick (片號) ⇒ 下面跳到那一片的卡片
   */
  constructor(opt, onSave, onPick) {
    this.opt = opt;
    this.onSave = onSave;
    this.onPick = onPick;
    this.range = { from: '', to: '' };      // 跟模型走（新建、開檔回到全部）
    this.ghostBig = false;                   // 大模型勾了原模型 —— 只記這一次
    this.slices = null; this.axis = 'y'; this.meshes = [];
    this.stack = null; this.ghost = null; this.sprites = [];
    this._frameKey = null;
    this._build();
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'slv';
    el.innerHTML = `
      <div class="slvBar">
        <b>立體預覽</b>
        <button class="mini" data-k="fold"></button>
        <span class="slvTools">
          <span class="lbl">只看第</span><input type="number" data-k="from" min="1" step="1" style="width:56px">
          <span class="lbl">～</span><input type="number" data-k="to" min="1" step="1" style="width:56px"><span class="lbl">片</span>
          <label class="uwCk" title="片跟片之間空一點，看得到每一片的上下面"><input type="checkbox" data-k="explode"> 拉開</label>
          <label class="uwCk" title="沒問題的片變淡，只看紅色（掉下來）、黃色（只黏一點點）"><input type="checkbox" data-k="faint"> 只看有問題的</label>
          <label class="uwCk" data-k="ghostLbl"><input type="checkbox" data-k="ghost"> 原模型</label>
          <button class="mini" data-k="home" title="回到一開始的角度">視角重來</button>
          <span class="lbl" data-k="info"></span>
        </span>
      </div>
      <div class="slvView" style="height:${HEIGHT}px">
        <span class="slvTip">左鍵拖：轉　滾輪：拉近　右鍵拖：移動　點一片：跳到它的卡片</span>
        <span class="slvPick" hidden></span>
      </div>`;
    this.el = el;
    const $ = k => el.querySelector(`[data-k="${k}"]`);
    this.$ = $;
    this.view = el.querySelector('.slvView');
    this.pickEl = el.querySelector('.slvPick');

    $('fold').onclick = () => { this.opt.open = !this.opt.open; this.onSave(); this._applyFold(); if (this.opt.open) this.refresh(); };
    for (const k of ['from', 'to']) $(k).onchange = () => {
      const v = Math.floor(+$(k).value);
      this.range[k] = $(k).value.trim() === '' || !(v > 0) ? '' : v;
      $(k).value = this.range[k];
      this.refresh();
    };
    for (const k of ['explode', 'faint']) {
      $(k).checked = !!this.opt[k];
      $(k).onchange = () => { this.opt[k] = $(k).checked; this.onSave(); this.refresh(); };
    }
    $('ghost').onchange = () => {
      const on = $('ghost').checked;
      if (this._ghostTris > GHOST_MAX_TRIS) { this.ghostBig = on; if (on) this.opt.ghost = true; }
      else this.opt.ghost = on;
      this.onSave();
      this.refresh();
    };
    $('home').onclick = () => { this._frameKey = null; this.refresh(); };
    this._applyFold();
  }

  _applyFold() {
    this.$('fold').textContent = this.opt.open ? '收起來' : '打開';
    this.el.querySelector('.slvTools').hidden = !this.opt.open;
    this.view.hidden = !this.opt.open;
  }

  /** WebGL 等第一次真的要畫才開（視窗沒開過就⛔ 佔一個）*/
  _gl() {
    if (this.r) return true;
    try {
      this.r = new THREE.WebGLRenderer({ antialias: true });
    } catch (e) {
      this.$('info').textContent = '這台電腦的瀏覽器畫不了 3D（WebGL 開不起來），下面的卡片照常';
      return false;
    }
    this.r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.view.prepend(this.r.domElement);
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x15181d);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x6a5c4a, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3);
    sun.position.set(3, 5, 4);
    this.scene.add(sun);
    this.cam = new THREE.PerspectiveCamera(35, 1, 0.05, 5000);
    this.ctl = new OrbitControls(this.cam, this.r.domElement);
    this.ctl.addEventListener('change', () => this.draw());
    this.ring = { loose: ringTexture('#e74c3c'), weak: ringTexture('#ef9f27') };
    // 點一下（⛔ 拖過）⇒ 那一片
    let down = null;
    this.r.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    this.r.domElement.addEventListener('click', e => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      this._pick(e);
    });
    window.addEventListener('resize', () => { if (this.el.isConnected) this.draw(); });
    return true;
  }

  /** 切完一次就給新的結果（slicePanel._runNow）*/
  setResult(slices, axis, meshes) {
    const axisChanged = axis !== this.axis;
    this.slices = slices; this.axis = axis; this.meshes = meshes || [];
    this._ghostTris = trisOf(this.meshes);
    if (axisChanged) this._frameKey = null;
    if (this.ghost) { this.scene.remove(this.ghost); disposeGroup(this.ghost); this.ghost = null; }
    // ⛔ 在這裡畫：slicePanel._render() 把元素接回視窗之後才叫 refresh()（沒接上量不到寬度）
  }

  /** 新建、開檔：範圍回到全部、視角重來 */
  reset() {
    this.range = { from: '', to: '' };
    this.ghostBig = false;
    this._frameKey = null;
  }

  refresh() {
    const $ = this.$;
    const n = this.slices ? this.slices.length : 0;
    $('from').value = this.range.from; $('to').value = this.range.to;
    $('from').placeholder = '1'; $('to').placeholder = String(n || '');
    const big = this._ghostTris > GHOST_MAX_TRIS;
    const ghostOn = !!this.opt.ghost && (!big || this.ghostBig);
    $('ghost').checked = ghostOn;
    $('ghostLbl').title = big
      ? `淡淡的原模型疊在板子後面，對照有沒有走樣。這個模型有 ${(this._ghostTris / 10000).toFixed(1)} 萬個三角形（超過 ${GHOST_MAX_TRIS / 10000} 萬），先不疊；要看就勾（只記這一次）`
      : '淡淡的原模型疊在板子後面，對照有沒有走樣';
    if (!this.opt.open || !n || !this.el.isConnected) return;
    if (!this._gl()) return;

    if (this.stack) { this.scene.remove(this.stack.group); disposeGroup(this.stack.group); }
    for (const s of this.sprites) { this.scene.remove(s); s.material.dispose(); }
    this.sprites = [];
    const from = this.range.from || 1, to = this.range.to || n;
    this.stack = buildStack(this.slices, this.axis, { from, to, explode: !!this.opt.explode, faint: !!this.opt.faint });
    this.scene.add(this.stack.group);
    for (const g of this.stack.rings) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.ring[g.kind], depthTest: false, transparent: true }));
      sp.position.copy(g.pos);
      sp.scale.setScalar(g.r * 2);
      sp.renderOrder = 10;
      this.scene.add(sp);
      this.sprites.push(sp);
    }

    if (ghostOn && !this.ghost) { this.ghost = ghostOf(this.meshes); this.scene.add(this.ghost); }
    if (this.ghost) this.ghost.visible = ghostOn && !this.opt.explode;     // 拉開之後位置對不上，先藏起來

    const loose = this.slices.reduce((a, s) => a + s.loops.filter(l => l.loose).length, 0);
    const glue = this.slices.reduce((a, s) => a + (s.glue || []).filter(g => g.with === s.index + 1).length, 0);
    $('info').textContent = `畫了 ${this.stack.shown} 片`
      + (loose ? `　🔴 掉下來 ${loose} 塊` : '') + (glue ? `　🟡 只黏一點點 ${glue} 處` : '')
      + (this.opt.explode && ghostOn ? '　（拉開時原模型先藏起來）' : '');

    // 換了模型、換了方向、拉開／收回、按「視角重來」才重新取景；改範圍、只看有問題的都留著人轉好的角度
    // ⚠ 拉開會高將近一倍 —— 不重新取景上面會被切掉（本機抓到）
    const key = `${this.axis}:${n}:${!!this.opt.explode}`;
    if (key !== this._frameKey) { this._frameKey = key; this._home(); }
    this.draw();
  }

  _home() {
    const all = buildStack(this.slices, this.axis, { explode: !!this.opt.explode });
    const c = all.box.getCenter(new THREE.Vector3()), s = all.box.getSize(new THREE.Vector3()).length() || 1;
    disposeGroup(all.group);
    this.ctl.target.copy(c);
    this.cam.position.copy(c).add(VIEW_DIR.clone().multiplyScalar(s * 1.3));
    this.cam.near = s / 200; this.cam.far = s * 50;
    this.cam.updateProjectionMatrix();
    this.ctl.update();
  }

  draw() {
    if (!this.r || !this.opt.open || !this.el.isConnected) return;
    const w = Math.max(200, this.view.clientWidth), h = HEIGHT;
    const sz = this.r.getSize(new THREE.Vector2());
    if (sz.x !== w || sz.y !== h) {
      // ⚠ 畫面的寬交給 CSS（100%）：下面的卡片長出捲軸會讓視窗窄 15 px，寫死寬度就會凸出去（本機抓到）
      this.r.setSize(w, h, false);
      this.cam.aspect = w / h; this.cam.updateProjectionMatrix();
    }
    this.r.render(this.scene, this.cam);
  }

  _pick(e) {
    const b = this.r.domElement.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((e.clientX - b.left) / b.width * 2 - 1, -(e.clientY - b.top) / b.height * 2 + 1), this.cam);
    const meshes = this.stack.group.children.filter(o => o.isMesh && o.userData.slice && !o.material.transparent);
    const hit = ray.intersectObjects(meshes, false)[0];
    this.pickEl.hidden = !hit;
    if (!hit) return;
    this.pickEl.textContent = `第 ${hit.object.userData.slice} 片`;
    this.onPick(hit.object.userData.slice);
  }
}

function ringTexture(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = color; g.lineWidth = 5;
  g.beginPath(); g.arc(32, 32, 28, 0, Math.PI * 2); g.stroke();
  return new THREE.CanvasTexture(c);
}
