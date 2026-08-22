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
import { nearestMarkableEdge, nearestFace, nearestVertex, canMarkSeams }
  from '../unfold/seam.js';
import { objectsInRect, normRect } from '../core/screen.js';
import { worldBounds } from '../core/align.js';

const TAP_MOVE = 8;      // px
const TAP_TIME = 450;    // ms

/**
 * 點多近才算點到那條邊，單位 px。
 * 觸控要放寬 —— 手指比游標粗得多，這跟平面規劃器的 HGRAB
 * （桌機 2px／觸控 14px）是同一件事。
 */
const EDGE_GRAB_PX = 14;
const EDGE_GRAB_PX_TOUCH = 26;

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

    /**
     * 分片模式。開著的時候，點畫面不是選物件，而是標接縫。
     * 兩種入口共用同一組動作 —— 又是「事件入口分開，動作邏輯共用」。
     */
    this.seamMode = false;

    /**
     * 貼合模式。點第一個元素＝來源，點第二個＝目標，選完立刻貼上去。
     * 「把**這個**貼到**那個**」，所以先點的那個會動。
     */
    this.mateMode = false;

    /**
     * 框選模式。開著時空白處拖曳畫矩形，不再旋轉視角。
     *
     * 做成模式而不是「Shift＋拖曳」，是 kang 選的 —— 平板沒有 Shift，
     * 而這個工具一開始就是桌機平板都要能用。跟「分片」同一個做法。
     */
    this.marqueeMode = false;
    this._marq = null;
    /** 框選矩形那個 div。沒有也不會壞，只是看不到框 */
    this.marqueeEl = document.getElementById('marqueeBox');

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

    this._initAxisLabels();
  }

  /**
   * gizmo 的三根拉桿旁邊標上 X / Y / Z。
   *
   * ── 為什麼要做 ──────────────────────────────────────
   * 顏色本來就分得開（紅綠藍），但「哪個顏色是哪個軸」要記，
   * 而這個建模器是 **Y 軸向上**、Z 是深度 —— 跟很多人習慣的
   * 「Z 向上」相反，所以憑印象猜一定會猜錯。
   * kang 實測後回報「操作上時常會搞錯 XYZ」。
   *
   * 標上去之後不必記也不必猜，看一眼就對得起來 ——
   * 跟輸入欄位那三個 X／Y／Z 是同一組字，中間不用再翻譯一次。
   *
   * ── 為什麼用 Sprite 而不是 HTML ──────────────────────
   * 字要跟著拉桿在 3D 裡轉。用 HTML 疊上去的話每一幀都要投影、
   * 還要處理被物件擋住的情形；Sprite 直接活在場景裡，
   * 而且跟 gizmo 用同一組 depthTest:false / renderOrder，
   * **拉桿看得到的地方，字就一定看得到**，兩者不會不同步。
   */
  _initAxisLabels() {
    const mk = (txt, color) => {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 128;
      const g = cv.getContext('2d');
      g.font = 'bold 92px "Noto Sans TC", Arial, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      // 先描一圈深色再填色：場景背景是深的、物件是亮的，
      // 只填色的話總有一種底色會讓字消失
      g.lineWidth = 10;
      g.strokeStyle = 'rgba(0,0,0,0.85)';
      g.strokeText(txt, 64, 68);
      g.fillStyle = color;
      g.fillText(txt, 64, 68);

      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthTest: false, depthWrite: false
      }));
      sp.renderOrder = 100;         // 跟 gizmo 一樣畫在最上面
      sp.visible = false;
      sp.raycast = () => {};        // 不參與點選，否則會擋到物件
      this.view.scene.add(sp);
      return sp;
    };

    /**
     * 顏色刻意跟 gizmo 的三根拉桿同色系（紅 X、綠 Y、藍 Z）。
     * 但不用純 0000ff —— 純藍在深色背景上幾乎看不見。
     * 取同色相亮一點的版本，關聯還在，字讀得出來。
     */
    this.axisLabels = {
      x: mk('X', '#ff4d4d'),
      y: mk('Y', '#4dff6a'),
      z: mk('Z', '#6b8cff')
    };
  }

  /**
   * 每一幀把三個字擺到拉桿尖端外面。
   *
   * 位置與大小都乘上 gizmo 自己算出來的 factor，所以字跟拉桿
   * **永遠等比例**，拉遠拉近、透視或正交都一樣大。
   * 這個 factor 的算法是照抄 TransformControls 裡那一段 ——
   * 自己另外訂一套的話，換 three.js 版本時字就會跟拉桿脫節。
   *
   * 這段在每一幀都跑，所以裡面只有固定次數的向量運算，
   * 沒有任何隨模型大小成長的東西（坑第 22 條）。
   */
  syncGizmoLabels() {
    const L = this.axisLabels;
    if (!L) return;

    const tc = this.tc;
    const node = tc.object;
    /**
     * 判準只看一件事：**gizmo 自己看不看得見**。
     * 不另外判斷「有沒有選取」「是不是分片模式」——
     * 那些條件已經決定了 helper.visible（attach／detach 會設它，
     * 分片與貼合模式也會），再抄一份到這裡，兩邊遲早會不一致，
     * 結果就是「箭頭在但字不見」或反過來。
     */
    if (!node || !this.helper.visible) {
      L.x.visible = L.y.visible = L.z.visible = false;
      return;
    }

    const cam = this.view.camera;
    const origin = new THREE.Vector3();
    node.getWorldPosition(origin);

    // ── 照抄 TransformControls 的縮放算法 ──
    let factor;
    if (cam.isOrthographicCamera) {
      factor = (cam.top - cam.bottom) / cam.zoom;
    } else {
      const camPos = new THREE.Vector3();
      cam.getWorldPosition(camPos);
      factor = origin.distanceTo(camPos)
        * Math.min(1.9 * Math.tan(Math.PI * cam.fov / 360) / cam.zoom, 7);
    }
    const unit = factor * tc.size / 4;      // gizmo 的一個本地單位有多大

    /**
     * 拉桿的箭頭本體在本地座標 0.5，錐頭再往外 0.1，所以尖端在 0.6。
     * 字放 0.78，剛好在尖端外面一點，不會疊在箭頭上。
     */
    const OUT = 0.78;
    const SIZE = 0.3;

    /**
     * 三個軸要不要跟著物件轉，判準必須跟 TransformControls 一模一樣。
     *
     * ⚠ **縮放模式永遠用物件的本地軸**，不管 space 設成什麼
     * （TransformControls 裡寫死的：scale always oriented to local rotation）。
     * 只看 space 的話，物件一旦轉過角度，縮放模式的字就會跟箭頭錯開 ——
     * 而那正是最需要看清楚哪根是哪根的時候。
     */
    const q = new THREE.Quaternion();
    if (tc.space === 'local' || tc.getMode() === 'scale') node.getWorldQuaternion(q);

    const dirs = {
      x: new THREE.Vector3(1, 0, 0),
      y: new THREE.Vector3(0, 1, 0),
      z: new THREE.Vector3(0, 0, 1)
    };
    for (const k of ['x', 'y', 'z']) {
      const d = dirs[k].applyQuaternion(q);
      const sp = L[k];
      sp.visible = true;
      sp.position.copy(origin).addScaledVector(d, unit * OUT);
      sp.scale.setScalar(unit * SIZE);
    }
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
      if (this.marqueeMode && !this.tc.dragging) {
        const r = this._toCanvasPx(e.clientX, e.clientY);
        this._marq = { ax: r.x, ay: r.y, bx: r.x, by: r.y };
        // 抓住指標，這樣拖出畫布外再放開也收得到事件
        if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 舊瀏覽器沒有就算了 */ } }
        this._drawMarquee();
      }
    });

    cv.addEventListener('pointermove', e => {
      if (!this._marq) return;
      const r = this._toCanvasPx(e.clientX, e.clientY);
      this._marq.bx = r.x; this._marq.by = r.y;
      this._drawMarquee();
    });

    cv.addEventListener('pointercancel', () => this._endMarquee(null, false));

    cv.addEventListener('pointerup', e => {
      const d = this._down;
      this._down = null;
      if (!d) return;

      const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      const dt = performance.now() - d.t;

      /**
       * 框選：拖得夠遠才算框選，否則當成一般的點一下。
       * 不分這一刀的話，框選模式下就再也點不到單一物件了。
       */
      if (this._marq) {
        this._endMarquee(e, dist > TAP_MOVE);
        if (dist > TAP_MOVE) return;
      }

      // 拖曳過、按太久、或正在操作 gizmo → 不算點選
      if (dist > TAP_MOVE || dt > TAP_TIME) return;
      if (this.tc.dragging) return;

      if (this.seamMode) { this.pickSeam(e.clientX, e.clientY); return; }
      if (this.mateMode) {
        const el = this.pickElement(e.clientX, e.clientY,
                                    { vertex: true, requireMarkable: false });
        if (el && this.hooks.onMatePick) this.hooks.onMatePick(el);
        return;
      }
      this.pick(e.clientX, e.clientY, e.shiftKey || this.multi);
    });
  }

  // ── 框選 ──────────────────────────────────────────

  _drawMarquee() {
    const el = this.marqueeEl;
    if (!el || !this._marq) return;
    const m = this._marq;
    const r = normRect(m.ax, m.ay, m.bx, m.by);
    el.hidden = false;
    el.style.left = r.x0 + 'px';
    el.style.top = r.y0 + 'px';
    el.style.width = (r.x1 - r.x0) + 'px';
    el.style.height = (r.y1 - r.y0) + 'px';
  }

  /**
   * 放開手，決定選到誰。
   *
   * 幾何判定全在 `core/screen.js`（不碰 DOM，測得到）；
   * 這裡只負責把畫布尺寸與相機交出去，再把結果套進選取。
   */
  _endMarquee(e, commit) {
    const m = this._marq;
    this._marq = null;
    if (this.marqueeEl) this.marqueeEl.hidden = true;
    if (!m || !commit || !this._doc) return;

    const cv = this.view.canvas;
    const box = cv.getBoundingClientRect();
    const rect = normRect(m.ax, m.ay, m.bx, m.by);

    const entries = this._doc.objects.map(o => ({ id: o.id, box: worldBounds(o) }));
    const hits = objectsInRect(entries, rect, this.view.camera, box.width, box.height);

    // 按著 Shift 或開著「加選」就是往現有選取上加，跟點選的規矩一致
    const additive = (e && e.shiftKey) || this.multi;
    this.set(additive ? [...new Set([...this.ids, ...hits])] : hits);
    if (this.hooks.onMarquee) this.hooks.onMarquee(hits.length);
  }

  /**
   * 切換框選模式。
   *
   * 只關掉旋轉與平移，**滾輪縮放留著** —— 框選時常常要先拉遠看全景，
   * 為了框一下還要退出模式再進來，用兩次就會放棄這個功能。
   */
  setMarqueeMode(on) {
    this.marqueeMode = !!on;
    const orb = this.view.orbit;
    orb.enableRotate = !this.marqueeMode;
    orb.enablePan = !this.marqueeMode;
    if (!this.marqueeMode) this._endMarquee(null, false);
    return this.marqueeMode;
  }

  // ── 分片模式的點選 ────────────────────────────────

  /** 螢幕座標 → 畫布內的 px 座標 */
  _toCanvasPx(clientX, clientY) {
    const r = this.view.canvas.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top, w: r.width, h: r.height };
  }

  /** 世界座標 → 畫布 px */
  _project(pWorld, r) {
    const v = pWorld.clone().project(this.view.camera);
    return { x: (v.x * 0.5 + 0.5) * r.w, y: (-v.y * 0.5 + 0.5) * r.h };
  }

  /**
   * 分片模式下點一下畫面。
   *
   * 判斷順序：
   *   1. 沒打到東西 → 什麼都不做
   *   2. 打到的物件不能標（參數物件）→ 回報原因，讓呼叫端跳提示
   *   3. 點得夠靠近某條可標記的邊 → 切換那條邊
   *   4. 否則 → 當成點在面上，切換「這個面整圈切開」
   *
   * 第 3、4 步的先後很重要：邊比面小得多，所以要先讓邊有機會被選中，
   * 邊搶不到才輪到面。反過來的話永遠點不到邊。
   */
  pickSeam(clientX, clientY) {
    const hook = this.hooks.onSeamPick;
    if (!hook) return;
    const el = this.pickElement(clientX, clientY, { vertex: false });
    if (!el) return;
    if (el.kind === 'blocked') { hook(el); return; }
    hook(el);
  }

  /**
   * 點畫面 → 打到哪一個頂點／邊／面。
   *
   * 分片與貼合共用這一組。判斷順序 **點 → 邊 → 面**，
   * 因為點比邊小、邊比面小 —— 反過來的話小的永遠搶不到。
   *
   * 幾何判斷全在 seam.js（不碰 DOM，測得到），這裡只負責把螢幕座標
   * 換算成物件本地座標，以及用 px 距離決定「算不算點中」。
   *
   * @param {object} opt.vertex 要不要考慮頂點（分片不需要）
   * @param {boolean} opt.requireMarkable 是否只接受可標記物件（分片才要）
   */
  pickElement(clientX, clientY, opt = {}) {
    const r = this._toCanvasPx(clientX, clientY);
    this._ndc.x = (r.x / r.w) * 2 - 1;
    this._ndc.y = -(r.y / r.h) * 2 + 1;
    this._ray.setFromCamera(this._ndc, this.view.camera);

    const hits = this._ray.intersectObjects(this.view.pickables, true);
    let hit = null, id = null;
    for (const h of hits) {
      const mid = this.view.modelIdOf(h.object);
      if (mid !== null) { hit = h; id = mid; break; }
    }
    if (!hit) return null;

    const obj = this._doc && this._doc.byId(id);
    if (!obj) return null;
    if (opt.requireMarkable !== false && !canMarkSeams(obj)) {
      return { obj, kind: 'blocked' };
    }

    const node = this.view.nodeOf(id);
    if (!node) return null;

    /**
     * 命中點換算到「物件本地座標」。
     * node 帶著 obj.scale，所以 worldToLocal 之後就是網格自己的座標系，
     * 跟 mesh.verts 裡存的是同一組數字 —— 不必再自己處理縮放。
     */
    const pLocal = node.worldToLocal(hit.point.clone());
    const mesh = obj.mesh();
    const grab = isTouch() ? EDGE_GRAB_PX_TOUCH : EDGE_GRAB_PX;
    // 3D 距離只用來挑候選；**是否算點中，一律用螢幕上的 px 距離判斷**，
    // 這樣不管拉遠拉近，手感都一樣。
    const toPx = pl => this._project(node.localToWorld(pl.clone()), r);

    if (opt.vertex) {
      const nv = nearestVertex(mesh, pLocal);
      if (nv) {
        const s = toPx(nv.vert.p);
        if (Math.hypot(r.x - s.x, r.y - s.y) <= grab) {
          return { obj, kind: 'vertex', vert: nv.vert };
        }
      }
    }

    const near = nearestMarkableEdge(mesh, pLocal);
    if (near) {
      const a = toPx(near.he.v.p), b = toPx(near.he.to.p);
      if (distPointSeg2(r.x, r.y, a.x, a.y, b.x, b.y) <= grab) {
        return { obj, kind: 'edge', he: near.he };
      }
    }

    const nf = nearestFace(mesh, pLocal);
    return nf ? { obj, kind: 'face', face: nf.face } : null;
  }

  // ── 選取 ──────────────────────────────────────────

  bindDoc(doc) { this._doc = doc; }

  /**
   * 場景換相機了（透視 ↔ 正交），gizmo 要跟著換。
   * 不換的話拖曳方向會對不上畫面，而且箭頭大小會算錯 ——
   * TransformControls 是拿相機去換算螢幕尺寸的。
   */
  setCamera(cam) {
    this.tc.camera = cam;
    /**
     * 點選不必處理 —— hitTest() 每次都是現讀 `this.view.camera`，
     * 而場景換相機時那個屬性就跟著換了。Raycaster 本身也認得正交相機。
     */
  }

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

    // 分片模式下不掛 gizmo。放在這裡是因為 _refresh() 會在選取變動、
    // Undo、讀檔之後重跑，只在 setSeamMode() 裡收一次是收不乾淨的。
    if (node && !this.seamMode && !this.mateMode) {
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

  /**
   * 切換分片模式。
   *
   * 一定要把 gizmo 收起來 —— 它的三支箭頭會擋在物件前面，
   * 而分片模式要點的是物件表面上的邊。不收的話使用者會一直
   * 點到箭頭然後把東西拖走，而那看起來就像「分片功能沒反應」。
   */
  /**
   * 貼合模式。跟分片一樣要把 gizmo 收起來 ——
   * 三支箭頭會擋在物件前面，而這裡要點的是物件表面上的點／邊／面。
   */
  setMateMode(on) {
    this.mateMode = !!on;
    this.tc.enabled = !this.mateMode && !this.seamMode;
    this._refresh();
    if (this.helper) this.helper.visible = !this.mateMode && !this.seamMode;
    return this.mateMode;
  }

  setSeamMode(on) {
    this.seamMode = !!on;
    this.tc.enabled = !this.seamMode && !this.mateMode;
    /**
     * 一定要重跑 _refresh()，它才會依照新的模式決定掛不掛 gizmo。
     * 少了這一行，離開分片模式後 gizmo 不會回來 —— 要等下次點選才復原，
     * 而使用者只會覺得「東西不能拖了」。
     */
    this._refresh();
    if (this.helper) this.helper.visible = !this.seamMode && !this.mateMode;
    return this.seamMode;
  }
}

export function isTouch() {
  return !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
}

/** 2D 的點到線段距離。分片模式判斷「點得夠不夠靠近那條邊」用。 */
function distPointSeg2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-9) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
