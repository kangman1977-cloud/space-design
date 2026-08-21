/**
 * select.js — 選取與變換
 *
 * 這一整套是第 0 期在 iPad 上實測過的做法，原封不動搬過來：
 *   - 用「移動 8px 內、450ms 內」分辨「點一下」與「拖曳」
 *   - 拖 gizmo 時關掉視角旋轉，不然兩個會打架
 *   - 手指裝置把 gizmo 放大 1.5 倍
 *
 * 沿用你在觸控改造時定下的原則：
 * **事件入口分開，動作邏輯共用。** 滑鼠與觸控走同一組函式，
 * 所以兩邊的結果保證一致，以後要改也只改一處。
 */

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

const TAP_MOVE = 8;      // px
const TAP_TIME = 450;    // ms

export class Selection {
  /**
   * @param {SceneView} view
   * @param {object} hooks
   * @param {() => void} hooks.onChange      選取內容變了
   * @param {(committing:boolean) => void} hooks.onTransform 變換中／變換結束
   */
  constructor(view, hooks = {}) {
    this.view = view;
    this.hooks = hooks;

    /** 已選取的 ModelObject id，有順序 */
    this.ids = [];
    this.multi = false;

    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._down = null;
    this._doc = null;

    this._initGizmo();
    this._initPointer();
  }

  _initGizmo() {
    const v = this.view;
    const tc = new TransformControls(v.camera, v.canvas);
    this.tc = tc;                 // setSnap() 會用到，必須先指派

    tc.setSize(isTouch() ? 1.5 : 1.0);
    this.setSnap(1);

    tc.addEventListener('dragging-changed', e => {
      v.orbit.enabled = !e.value;
      if (!e.value) this._writeBack(true);      // 放手 → 記一步 Undo
    });

    tc.addEventListener('objectChange', () => this._writeBack(false));

    // r16x 之後 gizmo 本身要另外掛進場景
    const helper = tc.getHelper ? tc.getHelper() : tc;
    v.scene.add(helper);
    this.helper = helper;
  }

  /** 把 gizmo 拖出來的變換寫回文件 */
  _writeBack(committing) {
    const node = this.tc.object;
    if (!node || !this._doc) return;
    const obj = this._doc.byId(node.userData.modelId);
    if (!obj) return;

    obj.pos.copy(node.position);
    obj.rot.copy(node.rotation);
    if (!obj.lockScale) obj.scale.copy(node.scale);
    else node.scale.copy(obj.scale);           // 鎖住的就彈回去

    if (this.hooks.onTransform) this.hooks.onTransform(committing);
  }

  _initPointer() {
    const cv = this.view.canvas;

    cv.addEventListener('pointerdown', e => {
      this._down = { x: e.clientX, y: e.clientY, t: performance.now() };
    });

    cv.addEventListener('pointerup', e => {
      const d = this._down;
      this._down = null;
      if (!d) return;

      const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      const dt = performance.now() - d.t;

      // 拖曳過、按太久、或正在操作 gizmo → 不算點選
      if (dist > TAP_MOVE || dt > TAP_TIME) return;
      if (this.tc.dragging) return;

      this.pick(e.clientX, e.clientY, e.shiftKey || this.multi);
    });
  }

  // ── 選取 ──────────────────────────────────────────

  bindDoc(doc) { this._doc = doc; }

  /** 螢幕座標 → 打到哪個物件 */
  hitTest(clientX, clientY) {
    const cv = this.view.canvas;
    const r = cv.getBoundingClientRect();
    this._ndc.x = ((clientX - r.left) / r.width) * 2 - 1;
    this._ndc.y = -((clientY - r.top) / r.height) * 2 + 1;
    this._ray.setFromCamera(this._ndc, this.view.camera);

    const hits = this._ray.intersectObjects(this.view.pickables, true);
    for (const h of hits) {
      const id = this.view.modelIdOf(h.object);
      if (id !== null) return id;
    }
    return null;
  }

  pick(clientX, clientY, additive) {
    const id = this.hitTest(clientX, clientY);

    if (id === null) {
      if (!additive) this.set([]);
      return;
    }
    if (additive) this.toggle(id);
    else this.set([id]);
  }

  set(ids) {
    this.ids = ids.filter(id => this._doc && this._doc.byId(id));
    this._refresh();
  }

  toggle(id) {
    const i = this.ids.indexOf(id);
    const next = this.ids.slice();
    if (i >= 0) next.splice(i, 1); else next.push(id);
    this.set(next);
  }

  clear() { this.set([]); }

  selectAll() {
    if (this._doc) this.set(this._doc.objects.map(o => o.id));
  }

  get objects() {
    if (!this._doc) return [];
    return this.ids.map(id => this._doc.byId(id)).filter(Boolean);
  }

  /** 最後選的那個 —— gizmo 掛在它身上，參數面板也顯示它 */
  get active() {
    const list = this.objects;
    return list.length ? list[list.length - 1] : null;
  }

  get count() { return this.ids.length; }

  /** 選取內容或文件變動後，重新套用高亮與 gizmo */
  _refresh() {
    const v = this.view;
    const sel = new Set(this.ids);

    for (const [id, node] of v.byId) {
      node.material.emissive.setHex(sel.has(id) ? 0x2a4a7a : 0x000000);
    }

    const act = this.active;
    const node = act ? v.nodeOf(act.id) : null;

    if (node) {
      this.tc.attach(node);
      this.tc.showX = this.tc.showY = this.tc.showZ = true;
      // 鎖定縮放的物件不給縮放把手（跟 system 物件同樣的做法）
      if (act.lockScale && this.tc.getMode() === 'scale') this.tc.setMode('translate');
    } else {
      this.tc.detach();
    }

    if (this.hooks.onChange) this.hooks.onChange(this);
  }

  /** 文件被外力改過（Undo、讀檔）之後呼叫 */
  revalidate() {
    this.ids = this.ids.filter(id => this._doc && this._doc.byId(id));
    this._refresh();
  }

  // ── gizmo ─────────────────────────────────────────

  setMode(mode) {
    const act = this.active;
    if (mode === 'scale' && act && act.lockScale) return false;
    this.tc.setMode(mode);
    return true;
  }

  get mode() { return this.tc.getMode(); }

  /**
   * 吸附格距，單位 cm。0 ＝ 關閉。
   * 跟平面規劃器的網格吸附是同一件事，價值在「尺寸乾不乾淨」。
   */
  setSnap(step) {
    this.snapStep = step;
    this.tc.setTranslationSnap(step > 0 ? step : null);
    this.tc.setRotationSnap(step > 0 ? THREE.MathUtils.degToRad(15) : null);
    this.tc.setScaleSnap(step > 0 ? 0.05 : null);
  }

  get dragging() { return !!this.tc.dragging; }
}

export function isTouch() {
  return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}
