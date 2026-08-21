/**
 * scene.js — three.js 場景
 *
 * 職責只有一件事：把文件（Doc）的內容畫出來。
 * 它不改文件、不管操作邏輯，只負責「同步」——
 * 文件變了就呼叫 sync()，畫面自己追上。
 *
 * 這樣切開的好處：文件模型完全不依賴 three.js，
 * 所以核心邏輯（半邊結構、區域合併、將來的展開）
 * 可以在沒有瀏覽器的環境下測試。第 1 期的自我驗證就是這樣跑的。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class SceneView {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1e23);

    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 20000);
    this.camera.position.set(320, 260, 340);

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.set(0, 40, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 20;
    this.orbit.maxDistance = 6000;
    this.orbit.maxPolarAngle = Math.PI * 0.495;

    this._buildEnvironment();

    /** ModelObject.id → THREE.Mesh */
    this.byId = new Map();
    /** 場景中所有可點選的物件 */
    this.pickables = [];

    this.showEdges = true;
    this.wireframe = false;

    this._fps = { acc: 0, n: 0, last: performance.now(), value: 0 };
  }

  _buildEnvironment() {
    this.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x30343c, 0.9));

    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(280, 460, 220);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 500;
    Object.assign(sun.shadow.camera, {
      left: -s, right: s, top: s, bottom: -s, far: 2000
    });
    sun.shadow.camera.updateProjectionMatrix();   // 改了範圍一定要重算，不然陰影會被裁掉
    this.scene.add(sun);
    this.sun = sun;

    // 地板網格：每格 10cm，共 600cm
    this.grid = new THREE.GridHelper(600, 60, 0x5a6272, 0x343a44);
    this.scene.add(this.grid);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600),
      new THREE.ShadowMaterial({ opacity: 0.26 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.05;
    floor.receiveShadow = true;
    this.scene.add(floor);
  }

  // ── 同步 ──────────────────────────────────────────

  /**
   * 讓畫面追上文件的內容。
   * 有變動就呼叫，多呼叫幾次不會有副作用。
   */
  sync(doc) {
    const alive = new Set();

    for (const obj of doc.objects) {
      alive.add(obj.id);
      let node = this.byId.get(obj.id);

      if (!node) {
        node = this._createNode(obj);
        this.byId.set(obj.id, node);
        this.scene.add(node);
      }
      this._updateNode(node, obj);
    }

    // 文件裡沒有了的，從場景移掉
    for (const [id, node] of [...this.byId]) {
      if (!alive.has(id)) {
        this.scene.remove(node);
        this._disposeNode(node);
        this.byId.delete(id);
      }
    }

    this.pickables = [...this.byId.values()];
  }

  _createNode(obj) {
    const mat = new THREE.MeshStandardMaterial({
      color: obj.color,
      roughness: 0.62,
      metalness: 0.04,
      // 初值；每次 _updateNode() 會依「開放且未加厚」重新決定（見下方）
      side: THREE.FrontSide,
      wireframe: this.wireframe
    });

    const node = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    node.castShadow = true;
    node.receiveShadow = true;
    node.userData.modelId = obj.id;

    // 稜線：讓造型看得清楚，也讓「合併成幾片」這件事看得見
    const line = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x11151a, transparent: true, opacity: 0.55 })
    );
    line.name = 'edges';
    line.raycast = () => {};      // 線不要參與點選
    node.add(line);

    node.userData.geomKey = null;
    return node;
  }

  /**
   * 板件要不要在畫面上加厚，以及加多少。
   *
   * 資料裡的板件是一張**沒有厚度的中性面**（日誌第 3 個關鍵決定），
   * 展開要靠它。但畫面上一張紙看不出板厚設對沒有、折彎處長什麼樣，
   * 所以顯示時才依板厚把它撐開。
   *
   * 這仍然符合「畫面是文件的投影，自己不存狀態」——
   * 加厚的結果只活在 GPU 上，文件一個位元組都沒動。
   *
   * 面數太多時放棄加厚：加厚會讓面數變成兩倍多，而且每次都要重算。
   * 真的做到那個規模時，看不看得到板厚已經不是重點了。
   */
  _shellThickness(obj) {
    /**
     * 順序有意義：先擋掉便宜的條件，再問網格。
     *
     * `isClosed()` 對**封閉**網格必須掃完所有半邊才能確定（開放的通常第一條
     * 就命中）。板厚 0 與面數過多這兩個條件不必碰網格就答得出來，
     * 所以放前面 —— 這樣常見情況（實體沒填板厚）根本不會走到掃描。
     */
    const t = Number(obj.thickness) || 0;
    if (t <= 1e-6) return 0;

    const mesh = obj.mesh();
    if (mesh.faces.length > 20000) return 0;

    // 判斷依據是網格開不開放，不是 kind 這個標籤（理由見 exportPanel.js）。
    // 封閉的東西本來就有厚度，再加厚只會多畫一層看不見的內殼。
    if (mesh.isClosed()) return 0;

    return t;
  }

  _updateNode(node, obj) {
    // 只有網格真的換過才重建 geometry —— 拖曳時每幀重建會很慢。
    // 板厚也要一起比對，不然改了板厚畫面不會更新。
    const mesh = obj.mesh();
    const shellT = this._shellThickness(obj);

    if (node.userData.geomKey !== mesh || node.userData.shellT !== shellT) {
      node.geometry.dispose();
      node.geometry = (shellT > 0 ? mesh.shell(shellT) : mesh).toGeometry();

      const edges = node.getObjectByName('edges');
      edges.geometry.dispose();
      edges.geometry = new THREE.EdgesGeometry(node.geometry, 1);

      node.userData.geomKey = mesh;
      node.userData.shellT = shellT;
    }

    node.position.copy(obj.pos);
    node.rotation.copy(obj.rot);
    node.scale.copy(obj.scale);

    node.material.color.setHex(obj.color);
    node.material.wireframe = this.wireframe;
    /**
     * 只有「開放而且沒加厚」的面需要雙面繪製 —— 否則從背面看會是透明的。
     * 加厚之後已經封閉，封閉的東西也本來就不需要。
     *
     * 判斷用網格開不開放，不是 obj.kind（那只是標籤，見 exportPanel.js）。
     * 用標籤判斷的話，把封閉方塊標成板件會讓它整個變雙面繪製，
     * 多畫一倍的面又看不出差別。
     */
    node.material.side = (shellT === 0 && !obj.mesh().isClosed())
      ? THREE.DoubleSide : THREE.FrontSide;
    node.getObjectByName('edges').visible = this.showEdges && !this.wireframe;
  }

  _disposeNode(node) {
    node.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }

  /** 把畫面上的物件對回文件裡的物件 id */
  modelIdOf(object3D) {
    let o = object3D;
    while (o && o.userData.modelId === undefined) o = o.parent;
    return o ? o.userData.modelId : null;
  }

  nodeOf(objId) { return this.byId.get(objId) || null; }

  // ── 顯示選項 ──────────────────────────────────────

  setWireframe(on) {
    this.wireframe = on;
    for (const n of this.byId.values()) {
      n.material.wireframe = on;
      n.getObjectByName('edges').visible = this.showEdges && !on;
    }
  }

  setShowEdges(on) {
    this.showEdges = on;
    for (const n of this.byId.values()) {
      n.getObjectByName('edges').visible = on && !this.wireframe;
    }
  }

  setGridVisible(on) { this.grid.visible = on; }

  /** 把鏡頭拉到看得見全部東西的位置 */
  frameAll(doc) {
    const box = new THREE.Box3();
    for (const n of this.byId.values()) box.expandByObject(n);
    if (box.isEmpty()) {
      this.camera.position.set(320, 260, 340);
      this.orbit.target.set(0, 40, 0);
    } else {
      const c = box.getCenter(new THREE.Vector3());
      const r = box.getSize(new THREE.Vector3()).length() / 2 || 100;
      const dist = r / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.15;
      const dir = new THREE.Vector3(0.8, 0.65, 0.85).normalize();
      this.camera.position.copy(c).addScaledVector(dir, dist);
      this.orbit.target.copy(c);
    }
    this.orbit.update();
    void doc;
  }

  // ── 畫面 ──────────────────────────────────────────

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  render() {
    const now = performance.now();
    const dt = now - this._fps.last;
    this._fps.last = now;
    this._fps.acc += dt;
    this._fps.n++;
    if (this._fps.acc >= 500) {
      this._fps.value = Math.round(1000 / (this._fps.acc / this._fps.n));
      this._fps.acc = 0;
      this._fps.n = 0;
    }

    this.orbit.update();
    this.renderer.render(this.scene, this.camera);
  }

  get fps() { return this._fps.value; }
  get triangles() { return this.renderer.info.render.triangles; }
}
