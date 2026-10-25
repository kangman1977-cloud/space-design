/**
 * bedCutPage.js — 3D 列印視窗裡的「切成放得下的塊」那一頁
 *
 * 🔴 第二輪第九批 9a（2026-10-25，kang「同意你的建議」→ 規格 `規格\建模器-STL匯出.md`「切成放得下的塊」）：
 * 卡片上「放不下平台、轉方向也不行」那一則旁邊一顆「切成放得下的塊」⇒ 這一頁：
 * 先看拉開的立體圖與數字 ⇒ 改刀的位置、插銷的大小、切法 ⇒「切開」變成畫面上的物件（插銷另一個物件、Ctrl+Z 收得回來）。
 *
 * | 項目 | 預設 | 可以調 |
 * |---|---|---|
 * | 切法 | 挑位置（插銷放得下、斷面分成的塊最少；面多要算一陣子、有進度、可以先停）| 平均切（快）|
 * | 刀的位置 | 照切法 | 每一刀打數字（mm，從外框的左邊／底下／後面算起）|
 * | 銷 | ⌀6、孔深 8、孔比銷每邊大 0.2、每個接面最多 2 根、放不下換小一號 | 都可以改（跟人走）|
 * | 小一號的每邊大（第三輪第二批 ④）| ⌀3、⌀1.75 都是 0.15 | 一號一格（勾「放不下換小一號」才出現，跟人走）|
 * | 試片（9b；第三輪第二批 ③）| 7 格、每格 0.05 mm、中間 ＝ 那一號自己的每邊大、**印這次切塊用到的那幾號** | 格數 3～9、每格差、試片印：這次用到的／只有主要那一號／全部（跟人走）；「存試片」單獨一個檔 |
 *
 * 算的東西在 `out/bedCut.js`、`build/bool.js` `cutBody()`；這裡只管畫面。
 * ⚠ 實體轉成 Manifold 一次就留著（大模型轉一次好幾秒），離開這一頁、關視窗一定要 `close()`。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { openCut, planCuts, placeDowels, dowelSpecs, segments, fitBed, AXIS_NAME, DOWEL, SMALLER, smallClear,
  COUPON, COUPON_N_MIN, COUPON_N_MAX, couponPlan, couponWhich } from '../out/bedCut.js';
import { couponSolids } from '../build/bool.js';
import { triangles, bedLayout, toSTLBinary, toSTLAscii, STL_UNITS } from '../out/stl.js';
import { to3MF } from '../out/threemf.js';
import { saveBlob, binaryBlob, textBlob, TYPES } from '../out/save.js';
import { today } from '../core/io.js';

const HEIGHT = 300;
const COLORS = [0xe68c46, 0x5aa0dc, 0x78be6e, 0xdc6e96, 0xc8be5a, 0x9678d2, 0x5ac8be, 0xd2966e, 0xa0a0a0, 0xf07864, 0x6e8cc8, 0xb4d278];
const FROM = ['左邊', '底下', '後面'];      // 世界 x、y、z 的最小那一頭

export class BedCutPage {
  /** @param {object} panel ExportPanel（body、opt、app、run()）*/
  constructor(panel) {
    this.panel = panel;
    this.s = null;
  }
  get active() { return !!this.s; }

  /** 卡片上按「切成放得下的塊」 */
  async open(it) {
    this.close();
    const p = this.panel;
    const world = it.mesh.transformed(it.obj.matrix());
    let cut;
    try { cut = openCut(world, it.obj.name); }
    catch (e) {
      p.app.toast(`切不了：${e.message} —— 先把模型修成封閉的實體（「補洞」「修法向」）再切`, true);
      return;
    }
    this.s = { it, obj: it.obj, body: cut.body, bb: cut.bb, grid: null, cuts: null, res: null, busy: false, stop: false, secs: 0 };
    this._frame();
    await this._plan();
  }

  close() {
    if (!this.s) return;
    try { this.s.body.close(); } catch (e) { /* 已釋放過，忽略 */ }
    this.s.stop = true;
    this.s = null;
    if (this.gl) { this._clearScene(); }
  }

  get _opt() {
    const o = this.panel.opt;
    if (!o.dowel) o.dowel = { ...DOWEL };
    /** 第三輪第二批 ④：9a 存的沒有這一格；⚠ `{ ...DOWEL }` 的陣列跟預設共用一份 ⇒ 換成自己的（不然改一格會改到預設）*/
    if (!Array.isArray(o.dowel.smallClearMM) || o.dowel.smallClearMM === DOWEL.smallClearMM) o.dowel.smallClearMM = SMALLER.map((s, i) => smallClear(o.dowel, i));
    if (!o.cutMode) o.cutMode = 'smart';
    if (!o.coupon) o.coupon = { ...COUPON };
    if (!o.coupon.which) { o.coupon.which = couponWhich(o.coupon); delete o.coupon.smaller; }     // 第三輪第二批 ③：9b 存的是勾選格
    return o;
  }

  // ── 畫面骨架 ──────────────────────────────────────────
  _frame() {
    const p = this.panel, o = this._opt, d = o.dowel;
    p.body.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'bcp';
    el.innerHTML = `
      <div class="uwBar">
        <b>切成放得下的塊：${esc(this.s.obj.name)}</b>
        <span class="sp"></span>
        <button class="mini" data-k="back">回到檢查表</button>
      </div>
      <div class="uwBar">
        <span class="lbl">切法</span><select data-k="mode">
          <option value="smart">挑位置（插銷放得下、零碎少；面多要算一陣子）</option>
          <option value="even">平均切（快）</option>
        </select>
      </div>
      <div class="uwBar" title="另外印一根銷、兩邊各挖一個孔；兩個切面都是平的，切面朝下印不用支撐">
        <span class="lbl">定位銷 ⌀ mm</span><input type="number" data-k="d" step="0.5" min="1" style="width:56px">
        <span class="lbl">孔深 mm</span><input type="number" data-k="depth" step="1" min="2" style="width:56px">
        <span class="lbl">孔比銷每邊大 mm</span><input type="number" data-k="clear" step="0.05" min="0" style="width:60px">
        <span class="lbl">每個接面最多</span><input type="number" data-k="per" step="1" min="1" max="6" style="width:48px"><span class="lbl">根</span>
        <label class="uwCk" title="⌀${DOWEL.dMM} 放不下的地方換 ${SMALLER.map(s => '⌀' + s.dMM).join(' → ')}（⌀1.75 可以剪一段耗材當銷）"><input type="checkbox" data-k="smaller"> 放不下換小一號</label>
        <span data-k="sbox">${SMALLER.map((s, i) => `<span class="lbl" data-k="sl${i}">⌀${s.dMM} 每邊大 mm</span><input type="number" data-k="sc${i}" step="0.05" min="0" style="width:60px" title="⌀${s.dMM} 的孔比銷每邊大多少（試片 ⌀${s.dMM} 那一排挑好的數字填這裡）">`).join('')}</span>
      </div>
      <div class="uwBar" title="先印這個：一排孔、每格孔比銷每邊大一點點，旁邊刻著數字；插插看挑剛好的那一格，把數字填回上面那一號的每邊大">
        <span class="lbl">試片（先印這個挑鬆緊）格數</span><input type="number" data-k="cn" step="1" min="${COUPON_N_MIN}" max="${COUPON_N_MAX}" style="width:48px">
        <span class="lbl">每格差 mm</span><input type="number" data-k="cstep" step="0.01" min="0.01" style="width:60px">
        <span class="lbl">試片印</span><select data-k="cwhich" title="小的縮得比較多，要分開試；預設只印這次切塊真的用到的那幾號">
          <option value="used">這次用到的</option><option value="main">只有主要那一號</option><option value="all">全部（含小一號）</option></select>
        <button class="mini" data-k="coupon">存試片</button>
      </div>
      <div class="uwBar" data-k="cuts"></div>
      <div class="bcpView" style="height:${HEIGHT}px;position:relative;border:1px solid #333944;border-radius:8px;overflow:hidden;background:#15181d">
        <span style="position:absolute;right:8px;bottom:6px;font-size:11px;color:#8b93a1;pointer-events:none">拉開來畫，每塊一個顏色　左鍵拖：轉　滾輪：拉近</span>
      </div>
      <div data-k="out"></div>
      <div class="uwBar"><span class="sp"></span><button data-k="go">切開</button></div>`;
    p.body.appendChild(el);
    this.el = el;
    const $ = k => el.querySelector(`[data-k="${k}"]`);
    this.$ = $;
    $('back').onclick = () => { this.close(); p.run(); };
    $('mode').value = o.cutMode;
    $('mode').onchange = () => { o.cutMode = $('mode').value; p.saveOpt(); this._plan(); };
    const numIn = (k, key, min) => {
      $(k).value = d[key];
      $(k).onchange = () => { const v = parseFloat($(k).value); if (Number.isFinite(v) && v >= min) d[key] = v; $(k).value = d[key]; p.saveOpt(); this._compute(); };
    };
    numIn('d', 'dMM', 1); numIn('depth', 'depthMM', 2); numIn('clear', 'clearMM', 0); numIn('per', 'per', 1);
    $('smaller').checked = !!d.smaller;
    $('smaller').onchange = () => { d.smaller = $('smaller').checked; p.saveOpt(); this._smallBox(); this._compute(); };
    /** 第三輪第二批 ④：小一號一號一格（勾了「放不下換小一號」、比主要那一號小的才出現）*/
    SMALLER.forEach((s, i) => {
      $('sc' + i).value = smallClear(d, i);
      $('sc' + i).onchange = () => { const v = parseFloat($('sc' + i).value); if (Number.isFinite(v) && v >= 0) d.smallClearMM[i] = v; $('sc' + i).value = smallClear(d, i); p.saveOpt(); this._compute(); };
    });
    this._smallBox();
    $('go').onclick = () => this._apply();
    const cp = o.coupon;
    $('cn').value = cp.n;
    $('cn').onchange = () => { const v = Math.round(parseFloat($('cn').value)); if (v >= COUPON_N_MIN && v <= COUPON_N_MAX) cp.n = v; $('cn').value = cp.n; p.saveOpt(); };
    $('cstep').value = cp.stepMM;
    $('cstep').onchange = () => { const v = parseFloat($('cstep').value); if (Number.isFinite(v) && v > 0) cp.stepMM = v; $('cstep').value = cp.stepMM; p.saveOpt(); };
    $('cwhich').value = couponWhich(cp);
    $('cwhich').onchange = () => { cp.which = $('cwhich').value; p.saveOpt(); };
    $('coupon').onclick = () => this._saveCoupon();
  }

  /** 小一號那幾格：勾了「放不下換小一號」、而且比主要那一號小才顯示 */
  _smallBox() {
    const d = this._opt.dowel;
    SMALLER.forEach((s, i) => { const on = !!d.smaller && s.dMM < d.dMM - 1e-9; this.$('sl' + i).hidden = !on; this.$('sc' + i).hidden = !on; });
  }

  _busy(msg, canStop) {
    const out = this.$('out');
    out.innerHTML = '';
    const b = document.createElement('div');
    b.className = 'uwSkip';
    b.textContent = msg;
    if (canStop) {
      const st = document.createElement('button');
      st.className = 'mini';
      st.textContent = '先停，改用平均切';
      st.onclick = () => { if (this.s) this.s.stop = true; };
      b.appendChild(document.createTextNode(' '));
      b.appendChild(st);
    }
    out.appendChild(b);
    this.$('go').disabled = true;
  }

  // ── 規劃（切幾刀、刀放哪）────────────────────────────
  async _plan() {
    const s = this.s; if (!s) return;
    const o = this._opt;
    s.stop = false; s.busy = true;
    const t0 = Date.now();
    this._busy(o.cutMode === 'smart' ? '正在挑刀的位置…' : '正在切…', o.cutMode === 'smart');
    await new Promise(r => setTimeout(r, 30));
    if (this.s !== s) return;
    let r;
    try {
      r = await planCuts(s.body, s.bb, { bedMM: o.bedMM, marginMM: o.marginMM, mode: o.cutMode, dowel: o.dowel }, {
        progress: (a, b) => { if (this.s === s) this._busy(`正在挑刀的位置… ${Math.min(99, Math.round(a / b * 100))}%（面多的模型要一陣子）`, true); },
        stopped: () => this.s !== s || s.stop
      });
    } catch (e) { if (this.s === s) this._busy('切不了：' + e.message, false); return; }
    if (this.s !== s) return;
    s.grid = r.grid; s.cuts = r.cuts; s.stopped = r.stopped; s.secs = (Date.now() - t0) / 1000; s.busy = false;
    this._cutInputs();
    this._compute();
  }

  /** 每一刀一格數字（mm，從外框的左邊／底下／後面算起）*/
  _cutInputs() {
    const s = this.s, row = this.$('cuts');
    row.innerHTML = '';
    const lbl = t => { const x = document.createElement('span'); x.className = 'lbl'; x.textContent = t; return x; };
    row.appendChild(lbl('刀的位置（mm，從外框的一頭算起）'));
    for (let a = 0; a < 3; a++) {
      if (!s.cuts[a].length) continue;
      const len = (s.bb.max[a] - s.bb.min[a]) * 10;
      row.appendChild(lbl(`${AXIS_NAME[a]}（全長 ${len.toFixed(1)}，從${FROM[a]}）`));
      s.cuts[a].forEach((c, i) => {
        const inp = document.createElement('input');
        inp.type = 'number'; inp.step = '1'; inp.style.width = '70px';
        inp.value = ((c - s.bb.min[a]) * 10).toFixed(1);
        inp.onchange = () => {
          const v = parseFloat(inp.value);
          if (Number.isFinite(v) && v > 0 && v < len) s.cuts[a][i] = s.bb.min[a] + v / 10;
          inp.value = ((s.cuts[a][i] - s.bb.min[a]) * 10).toFixed(1);
          s.edited = true;
          this._compute();
        };
        row.appendChild(inp);
      });
    }
  }

  // ── 放插銷、切開（預覽就是真的切出來的那一份）─────────
  _compute() {
    const s = this.s; if (!s || !s.cuts || s.busy) return;
    const o = this._opt;
    let pd, sp;
    try {
      pd = placeDowels(s.body, s.bb, s.cuts, o.dowel);
      sp = s.body.split(pd.dowels.map(x => ({ a: x.a, p: x.p, r: x.r, depth: x.depth })), s.cuts);
    } catch (e) { this._busy('切不了：' + e.message, false); return; }
    const bedU = o.bedMM;
    const fits = sp.pieces.map(m => {
      const pts = m.verts.map(v => [v.p.x * 10, -v.p.z * 10, v.p.y * 10]);
      return fitBed(pts, bedU);
    });
    s.res = { pd, pieces: sp.pieces, fits, specs: dowelSpecs(pd.dowels), socketVol: sp.socketVol };
    this._out();
    this._draw();
  }

  _out() {
    const s = this.s, r = s.res, o = this._opt, out = this.$('out');
    out.innerHTML = '';
    const line = (cls, txt) => { const d = document.createElement('div'); d.className = cls; d.textContent = txt; out.appendChild(d); return d; };
    const size = [0, 1, 2].map(k => (s.bb.max[k] - s.bb.min[k]) * 10);
    const ax = [0, 1, 2].filter(a => s.cuts[a].length).map(a => `${AXIS_NAME[a]}切 ${s.cuts[a].length} 刀`).join('、');
    line('uwSkip', `外框 ${size[0].toFixed(1)} × ${size[2].toFixed(1)} × ${size[1].toFixed(1)} mm（寬 × 深 × 高），`
      + `平台 ${o.bedMM.join(' × ')} mm、留邊 ${o.marginMM} mm ⇒ ${ax}（${s.grid.n[0] * s.grid.n[1] * s.grid.n[2]} 格）`
      + (o.cutMode === 'smart' && !s.stopped ? `；挑位置花了 ${s.secs.toFixed(1)} 秒` : '')
      + (s.stopped ? '；挑到一半停了，先用平均切' : '') + (s.edited ? '；刀的位置你改過' : ''));
    // 每一塊放不放得下
    const big = [], turn = [];
    r.fits.forEach((f, i) => { if (!f.asIs && !f.turn) big.push(i + 1); else if (!f.asIs) turn.push(i + 1); });
    const tiny = r.pieces.map((m, i) => [i + 1, Math.abs(m.volume())]).filter(x => x[1] < 1);
    const lim = [0, 1, 2].map(a => segments(s.cuts[a], s.bb.min[a], s.bb.max[a]).map(x => x * 10));
    line(big.length ? 'uwWarn' : 'uwSkip', `切成 ${r.pieces.length} 塊：`
      + (big.length ? `第 ${big.join('、')} 塊還是放不下平台（刀改得太偏？每一段要比平台短）`
        : turn.length ? `第 ${turn.join('、')} 塊要轉方向才放得下（在切片軟體裡轉），其他照原樣就放得下` : '每一塊照原樣就放得下')
      + (tiny.length ? `；有 ${tiny.length} 塊很小（不到 1 cm³：第 ${tiny.map(x => x[0]).join('、')} 塊）` : '')
      + `；每一段長 ${[0, 1, 2].filter(a => s.cuts[a].length).map(a => AXIS_NAME[a] + ' ' + lim[a].map(x => x.toFixed(0)).join('／')).join('，')} mm`);
    // 插銷
    const pd = r.pd;
    const smaller = pd.joints.reduce((x, j) => x + j.smaller, 0);
    line('uwSkip', r.specs.length
      ? `定位銷（另外印，切開時多一個物件）：${r.specs.map(x => `⌀${x.dMM} × ${+x.lenMM.toFixed(1)} mm ${x.n} 根`).join('、')}`
        + (smaller ? `；⌀${o.dowel.dMM} 放不下的 ${smaller} 根換了小一號` : '')
        + `；孔比銷每邊大 ${r.specs.map(x => (r.specs.length > 1 || x.dMM !== o.dowel.dMM ? `⌀${x.dMM} ` : '') + this._clearOf(x.dMM)).join('、')} mm（太緊就加、會晃就減）`
      : '一根定位銷都放不下 —— 只能黏');
    const bad = pd.joints.filter(j => j.noRoom);
    if (bad.length) {
      line('uwCaution', `有 ${bad.length} 個接面${o.dowel.smaller ? '連最小的銷' : '銷'}都放不下，只能黏：`
        + bad.map(j => `${AXIS_NAME[j.a]}那一刀（從${FROM[j.a]} ${((j.c - s.bb.min[j.a]) * 10).toFixed(0)} mm）`).join('、')
        + (o.dowel.smaller ? '' : ' —— 勾「放不下換小一號」試試'));
    }
    this.$('go').disabled = false;
  }

  // ── 立體預覽 ─────────────────────────────────────────
  _gl() {
    if (this.gl) { if (!this.gl.r.domElement.isConnected) this.el.querySelector('.bcpView').prepend(this.gl.r.domElement); return true; }
    let r;
    try { r = new THREE.WebGLRenderer({ antialias: true }); }
    catch (e) { return false; }
    r.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x15181d);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x6a5c4a, 1.5));
    const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(3, 5, 4); scene.add(sun);
    const cam = new THREE.PerspectiveCamera(35, 1, 0.05, 5000);
    const ctl = new OrbitControls(cam, r.domElement);
    this.gl = { r, scene, cam, ctl, group: null };
    ctl.addEventListener('change', () => this._render());
    this.el.querySelector('.bcpView').prepend(r.domElement);
    return true;
  }

  _clearScene() {
    const g = this.gl && this.gl.group;
    if (!g) return;
    this.gl.scene.remove(g);
    g.traverse(x => { if (x.geometry) x.geometry.dispose(); if (x.material) x.material.dispose(); });
    this.gl.group = null;
  }

  _draw() {
    if (!this._gl()) return;
    this._clearScene();
    const s = this.s, g = new THREE.Group();
    const ctr = new THREE.Vector3((s.bb.min[0] + s.bb.max[0]) / 2, (s.bb.min[1] + s.bb.max[1]) / 2, (s.bb.min[2] + s.bb.max[2]) / 2);
    s.res.pieces.forEach((m, i) => {
      const pos = [], idx = [];
      const vi = m._vertIndex();
      for (const v of m.verts) pos.push(v.p.x, v.p.y, v.p.z);
      for (const f of m.faces) for (const [a, b, c] of m.faceTriangles(f)) idx.push(vi.get(a.id), vi.get(b.id), vi.get(c.id));
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: COLORS[i % COLORS.length], roughness: 0.75, flatShading: true }));
      geo.computeBoundingBox();
      const c = geo.boundingBox.getCenter(new THREE.Vector3());
      mesh.position.copy(c.sub(ctr).multiplyScalar(0.3));
      g.add(mesh);
    });
    this.gl.group = g;
    this.gl.scene.add(g);
    const box = new THREE.Box3().setFromObject(g);
    const key = s.res.pieces.length + ':' + s.obj.id;
    if (key !== this._home) {
      this._home = key;
      const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3()).length() || 1;
      this.gl.ctl.target.copy(c);
      this.gl.cam.position.copy(c).add(new THREE.Vector3(0.9, 0.8, 1.2).normalize().multiplyScalar(sz * 1.25));
      this.gl.cam.near = sz / 200; this.gl.cam.far = sz * 50; this.gl.cam.updateProjectionMatrix();
      this.gl.ctl.update();
    }
    this._render();
  }

  _render() {
    if (!this.gl || !this.el || !this.el.isConnected) return;
    const view = this.el.querySelector('.bcpView');
    const w = Math.max(200, view.clientWidth), h = HEIGHT;
    const sz = this.gl.r.getSize(new THREE.Vector2());
    if (sz.x !== w || sz.y !== h) { this.gl.r.setSize(w, h, false); this.gl.r.domElement.style.width = '100%'; this.gl.r.domElement.style.height = h + 'px'; this.gl.cam.aspect = w / h; this.gl.cam.updateProjectionMatrix(); }
    this.gl.r.render(this.gl.scene, this.gl.cam);
  }

  // ── 9b 試片 ─────────────────────────────────────────
  /**
   * 試片的檔案內容（照上面選的格式、單位）。⚠ 一律同步做好再 await 存檔（`showSaveFilePicker()` 要在按的那一下呼叫）。
   * @returns {{blob:Blob, name:string, type:object, plan:object}}
   */
  /** 這一號的每邊大（mm）：主要那一號照「孔比銷每邊大」、小一號照各自那一格 */
  _clearOf(dMM) {
    const d = this._opt.dowel, i = SMALLER.findIndex(s => Math.abs(s.dMM - dMM) < 1e-9);
    return Math.abs(dMM - d.dMM) < 1e-9 || i < 0 ? d.clearMM : smallClear(d, i);
  }

  /** 這次切塊用到的 ⌀（mm，大的在前）；還沒切好 ⇒ null */
  _usedSizes() {
    const r = this.s && this.s.res;
    return r ? [...new Set(r.pd.dowels.map(x => x.dMM))].sort((a, b) => b - a) : null;
  }

  couponFile() {
    const p = this.panel, o = this._opt;
    const plan = couponPlan(o.dowel, o.coupon, this._usedSizes());
    if (plan.none) return { plan };
    const parts = couponSolids(plan).map(x => ({ name: x.name, tris: triangles(x.mesh, { zUp: false, scale: STL_UNITS[o.unit].scale / 10 }) }));
    const u = STL_UNITS[o.unit].label;
    const name = `${p._base()}_試片_${plan.rows.map(r => '⌀' + r.dMM).join('_')}_${u}`;     // 第三輪第二批（②-9）：照印了哪幾排
    if (o.format === '3mf') return { blob: binaryBlob(to3MF(parts, { unit: o.unit }), 'model/3mf'), name: name + '.3mf', type: TYPES['3mf'], plan };
    const tris = bedLayout(parts.map(x => x.tris), true)[0];
    const blob = o.format === 'binary'
      ? binaryBlob(toSTLBinary(tris, { header: `modeler unit=${u} ${today()} fit coupon` }), 'model/stl')
      : textBlob(toSTLAscii(tris, { name: 'fit_coupon', fallback: 'coupon' }), 'model/stl');
    return { blob, name: name + '.stl', type: TYPES.stl, plan };
  }

  async _saveCoupon() {
    let f;
    try { f = this.couponFile(); }
    catch (e) { this.panel.app.toast('試片做不出來：' + e.message, true); return; }
    if (f.plan.none) {
      this.panel.app.toast(`這次切塊一根銷都沒有用到（接面都只能黏），試片用不到 —— 要印的話，把「試片印」改成「只有主要那一號」或「全部」`, true);
      return;
    }
    await saveBlob(f.blob, f.name, f.type, this.panel.opt.askPath);
    const rows = f.plan.rows, d = this._opt.dowel;
    const field = r => Math.abs(r.dMM - d.dMM) < 1e-9 ? '「孔比銷每邊大」' : `「⌀${r.dMM} 每邊大」`;
    this.panel.app.toast(`已存試片${f.plan.which === 'used' && this._usedSizes() ? '（這次切塊用到的）' : ''}：${rows.map(r => `⌀${r.dMM} 孔每邊大 ${r.clears[0].toFixed(2)}～${r.clears[r.clears.length - 1].toFixed(2)} mm（${r.clears.length} 格）`).join('、')}＋${rows.length === 1 ? '一根銷' : '每排一根銷'}`
      + (rows.length === 1 ? `　印出來插插看，把剛好那一格刻的數字填進${field(rows[0])}（.15 ＝ 0.15）`
        : `　印出來插插看，每一排剛好那一格刻的數字填回自己那一號：${rows.map(r => `⌀${r.dMM} 填${field(r)}`).join('、')}（.15 ＝ 0.15）`)
      + (f.plan.skipped ? `　⚠ 每邊大算出來小於 0 的 ${f.plan.skipped} 格沒有挖（把中間的數字調大或每格差調小）` : '')
      + (rows.some(r => r.dMM < 2) ? '　⌀1.75 那一排也可以直接剪一段耗材插' : ''));
  }

  // ── 切開 ─────────────────────────────────────────────
  _apply() {
    const s = this.s; if (!s || !s.res) return;
    const p = this.panel;
    const made = p.app.applyBedCut(s.obj, s.res.pieces, s.res.specs, s.bb);
    if (!made) return;
    this.close();
    p.run();
  }
}

const esc = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
