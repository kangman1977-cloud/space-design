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
import { EDGE_ROLE } from '../core/mesh.js';

export class SceneView {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1b1e23);

    /**
     * 兩台相機，隨時可以換。
     *
     * ── 為什麼一定要有正交相機 ──────────────────────────
     * kang 要的是「多個物件組合時，每個物件準確移動到正確位置」。
     * 透視投影下**遠的東西看起來比較小、比較靠中間**，所以兩個深度不同
     * 的物件就算 X 真的對齊了，畫面上看起來也不會齊。
     * 靠眼睛對位在透視圖裡根本辦不到 —— 這正是所有 CAD 都有正交視圖的原因。
     *
     * 透視留著，因為看整體量體、感覺空間還是它自然。
     */
    this.persp = new THREE.PerspectiveCamera(45, 1, 1, 20000);
    this.persp.position.set(320, 260, 340);

    this.ortho = new THREE.OrthographicCamera(-100, 100, 100, -100, -20000, 20000);
    this.ortho.position.copy(this.persp.position);

    this.camera = this.persp;
    /** 相機換人時通知外面（gizmo 要跟著換，否則拖曳會歪掉）*/
    this.onCameraChange = null;

    this.orbit = new OrbitControls(this.camera, canvas);
    this.orbit.target.set(0, 40, 0);
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.08;
    this.orbit.minDistance = 20;
    this.orbit.maxDistance = 6000;
    /**
     * 剛好 90 度，不是 89.1 度。
     * 原本是 `Math.PI * 0.495`，那樣**正側視圖差 0.9 度看不出來但對不準** ——
     * 而正視圖存在的意義就是「這條線到底齊了沒」。
     * 90 度一樣擋得住鑽到地板下面，只是剛好能停在水平。
     */
    this.orbit.maxPolarAngle = Math.PI / 2;

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
    this._seamsDirty = false;      // 這一輪已經全部重畫過了
    this._geomDirty = false;
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

    /**
     * 接縫：使用者標的分片切割線。
     *
     * 一定要跟一般稜線用不同顏色畫出來，否則使用者標了什麼完全看不見 ——
     * 而分片的重點就是「我決定從哪裡切開」。看不見等於沒有這個功能。
     *
     * 直接從半邊網格的頂點座標建線段，**不經過 toGeometry()**，
     * 所以不受三角化影響，也不受板件加厚（shell）影響 ——
     * 畫的就是資料裡那條邊本人。
     */
    const seams = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xff7a1a })
    );
    seams.name = 'seams';
    seams.raycast = () => {};
    seams.renderOrder = 2;
    node.add(seams);

    node.userData.geomKey = null;
    node.userData.seamKey = null;
    return node;
  }

  /**
   * 重建接縫線。
   *
   * ⚠ **絕對不能每次 sync() 都走訪一遍所有的邊。**
   *
   * sync() 在拖曳 gizmo 時是**每一幀**都會跑的。走訪所有邊是 O(邊數)，
   * 16,128 面的球有兩萬多條邊 —— 每幀掃一遍再組一個字串，手感直接毀掉。
   * 這跟踩過的坑第 3 條（曲率計算 O(頂點×面) 讓上萬面卡死）是同一種錯，
   * 差別只在這次是在畫面更新的熱路徑上。
   *
   * 所以只有兩種情況才重建：
   *   1. 網格換人了（改參數、Undo、讀檔 → mesh 物件不同）
   *   2. 有人明講「接縫改過了」（markSeamsDirty()）
   *
   * 標接縫本來就是使用者一次一下的動作，明講一聲的成本是零；
   * 反過來讓畫面每幀去猜有沒有變，成本卻是所有人一起付。
   */
  _updateSeams(node, obj) {
    const mesh = obj.mesh();
    const seams = node.getObjectByName('seams');
    const stale = node.userData.seamMesh !== mesh || this._seamsDirty;

    if (stale) {
      const pos = [];
      let n = 0;
      for (const he of mesh.edges()) {
        if (he.role !== EDGE_ROLE.CUT || !he.face || !he.twin || !he.twin.face) continue;
        pos.push(he.v.p.x, he.v.p.y, he.v.p.z, he.to.p.x, he.to.p.y, he.to.p.z);
        n++;
      }
      seams.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      seams.geometry = g;
      node.userData.seamMesh = mesh;
      node.userData.seamCount = n;
    }
    seams.visible = (node.userData.seamCount || 0) > 0 && !this.wireframe;
  }

  /**
   * 告訴畫面「接縫改過了，下次 sync() 要重畫」。
   * 標記／取消／清除之後一定要呼叫，否則畫面會停在舊的樣子 ——
   * 而使用者只會看到「我標了但沒反應」。
   */
  markSeamsDirty() { this._seamsDirty = true; }

  /**
   * 告訴畫面「網格的**座標**改過了，下次 sync() 要重建 geometry」。
   *
   * ⚠ **編輯（拉點／拉邊／拉面）非它不可。**
   * `_updateNode()` 用 `node.userData.geomKey !== mesh` 判斷要不要重建，
   * 而編輯是**就地改同一個 mesh 物件的頂點座標** —— 參考值一模一樣，
   * 那個判斷永遠是 false，畫面就會停在舊的樣子。
   * 使用者看到的是「我拉了但東西沒動」，而資料其實已經改了 ——
   * **畫面與資料不一致，比單純沒反應更難查。**
   *
   * 改參數、Undo、讀檔那幾條路不必呼叫：它們會換掉整個 mesh 物件，
   * `geomKey` 自然就對不上了。
   *
   * 跟 markSeamsDirty() 同一條理由：讓畫面每幀去猜有沒有變，
   * 成本是所有人一起付；明講一聲的成本是零（坑第 3、22 條）。
   */
  markGeomDirty() { this._geomDirty = true; }

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

    // _geomDirty ＝ 編輯就地改了頂點座標。mesh 物件沒換，所以前兩個條件
    // 都察覺不到 —— 少了它，拉點之後畫面不會更新（見 markGeomDirty）。
    if (node.userData.geomKey !== mesh || node.userData.shellT !== shellT
        || this._geomDirty) {
      node.geometry.dispose();
      node.geometry = (shellT > 0 ? mesh.shell(shellT) : mesh).toGeometry();

      const edges = node.getObjectByName('edges');
      edges.geometry.dispose();
      edges.geometry = new THREE.EdgesGeometry(node.geometry, 1);

      /**
       * 🔴 **環切加出來的邊要另外補畫。**
       *
       * `EdgesGeometry(geometry, 1)` 只畫轉折超過 1 度的邊 —— 那條規則
       * 本來是對的（它擋掉三角化的對角線，那些線畫面上本來就不存在）。
       * 但環切的線是**共面**的，所以一條都畫不出來。
       *
       * ⚠ 不補的話環切就是坑第 21 條：按下去畫面上沒有任何地方會變。
       * 「面合併」那顆按鈕已經被同一個坑騙過一次。
       *
       * **顏色跟一般稜線一樣**（kang 2026-08-24 決定）——
       * 它就是一條真的邊，跟方塊的棱線同等地位，沒有理由特別標起來。
       * 所以直接接在同一份 geometry 後面，不另開一層。
       *
       * ⚠ 加厚（板件）時不畫：那時畫面上是 `shell()` 出來的另一個網格，
       * 原網格的座標對不上。板件本來就不在第 6 期的支援範圍。
       */
      if (shellT === 0) {
        const extra = [];
        for (const he of mesh.edges()) {
          if (!he.hard) continue;
          extra.push(he.v.p.x, he.v.p.y, he.v.p.z, he.to.p.x, he.to.p.y, he.to.p.z);
        }
        if (extra.length) {
          const base = edges.geometry.getAttribute('position').array;
          const all = new Float32Array(base.length + extra.length);
          all.set(base, 0);
          all.set(extra, base.length);
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.BufferAttribute(all, 3));
          edges.geometry.dispose();
          edges.geometry = g;
        }
      }

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
    this._updateSeams(node, obj);
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
      // 張角一律取自透視相機 —— 正交相機沒有 fov，而視野範圍是從它回推的
      const dist = r / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 1.15;
      /**
       * 方向維持不變。原本寫死等角方向，但那會讓「切到正視圖 → 按全部入鏡」
       * 又轉回等角 —— 使用者剛選好的視角被搶走，而他只是想看全部。
       */
      const dir = new THREE.Vector3().subVectors(this.camera.position, this.orbit.target);
      if (dir.lengthSq() < 1e-9) dir.set(0.8, 0.65, 0.85);
      dir.normalize();
      this.camera.position.copy(c).addScaledVector(dir, dist);
      this.orbit.target.copy(c);
    }
    if (this.isOrtho) this._fitOrtho();
    this.orbit.update();
    void doc;
  }

  // ── 點選標示 ──────────────────────────────────────

  /**
   * 把「使用者剛剛點到的那個元素」畫出來。
   *
   * ── 為什麼一定要有 ────────────────────────────────
   * 面還好認，但**點與邊很細**，選完沒有標示的話使用者無從確認
   * 點中的是不是他想要的那一個 —— 貼合的結果不如預期時，
   * 他也分不清是「選錯了」還是「程式算錯了」。
   *
   * kang 2026-08-22 實測回報：面對面驗得出來，點對點與邊對邊
   * 「沒辦法驗證準確，不知道是不是操作有誤」。就是缺這個。
   *
   * 用世界座標直接畫，不掛在物件節點下 —— 這樣物件貼合移動時
   * 標示不會跟著跑掉，而是由呼叫端決定何時更新或清掉。
   */
  setPickMarks(marks) {
    this.clearPickMarks();
    if (!marks || !marks.length) return;

    const g = new THREE.Group();
    g.name = 'pickMarks';

    for (const m of marks) {
      /**
       * 三種角色三個顏色：
       *   `src`（黃）　　貼合的來源／編輯選到的元素
       *   `dst`（綠）　　貼合的目標
       *   `active`（橘）**多選裡最後點的那一個**
       *
       * ⚠ **active 不能借用綠色。** 綠色在貼合模式已經有意思了（目標），
       * 同一個顏色在兩個模式代表不同的東西，畫面就開始騙人 ——
       * 而使用者不會記得自己現在在哪個模式。多一個顏色比省一個顏色便宜。
       *
       * ⚠ **active 一定要看得出來，這不是裝飾。** 中心（「最後選的」那個模式）
       * 與法向的切線**都只看 active** —— 分不出哪一個是 active，
       * 「箭頭為什麼朝那邊」就變成一個沒有答案的問題（坑第 24 條）。
       */
      const col = m.role === 'dst' ? 0x3ad07a
                : m.role === 'active' ? 0xff8c1a
                : 0xffd23f;

      if (m.kind === 'vertex') {
        // 點要畫得夠大才看得見，但太大會蓋住旁邊的角
        const s = new THREE.Mesh(
          new THREE.SphereGeometry(1.4, 12, 8),
          new THREE.MeshBasicMaterial({ color: col, depthTest: false })
        );
        s.position.copy(m.points[0]);
        s.renderOrder = 6;
        g.add(s);
      } else {
        const pos = [];
        const pts = m.points;
        const close = m.kind === 'face';
        for (let i = 0; i < pts.length - (close ? 0 : 1); i++) {
          const a = pts[i], b = pts[(i + 1) % pts.length];
          pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        const ln = new THREE.LineSegments(
          geo, new THREE.LineBasicMaterial({ color: col, depthTest: false })
        );
        ln.renderOrder = 6;
        g.add(ln);
      }
    }

    // 標示不參與點選，否則會擋住底下真正要點的東西
    g.traverse(o => { o.raycast = () => {}; });
    this.scene.add(g);
    this._pickMarks = g;
  }

  clearPickMarks() {
    if (!this._pickMarks) return;
    this.scene.remove(this._pickMarks);
    this._pickMarks.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this._pickMarks = null;
  }

  /**
   * 🔴 **把一個物件所有的點標出來（編輯模式的「顯示點」）。**
   *
   * ── kang 2026-08-25 實測抓到的洞 ──────────────────────
   * > 「角點還可以分辨..但是**新增的點**..除非開線框才可以找的到位置」
   *
   * 「邊上加點」加在邊中間的點**沒有任何視覺線索** —— 角點還有轉折可認，
   * 中間的點什麼都沒有。等於加了點卻不知道加在哪（坑第 21 條）。
   *
   * ── 🔴 為什麼不能沿用 `setPickMarks()` 那條路 ────────────
   * 那一支**每個點做一顆 `SphereGeometry(1.4, 12, 8)`** ≈ 200 個三角形
   * 的獨立 Mesh。選取標記通常只有幾個，那樣寫沒問題；
   * **但拿來畫「全部的點」就是 1000 顆球、20 萬個三角形。**
   *
   * → 這裡用 `THREE.Points`：**整批一次交給顯示卡**，
   * 1000 個點的成本遠低於模型本身已經在畫的那些三角形。
   * 〔kang 問「電腦不夠好會不會當機」—— 點的資料 1000 個約 12KB，
   * 　不會爆記憶體；最壞是變慢，而開關就是最好的保險〕
   *
   * ── ⚠ `sizeAttenuation: false` 是刻意的 ─────────────────
   * 點的大小**固定在螢幕像素**，拉遠拉近都一樣看得到。
   * 現有的球會跟著遠近變大變小 —— 那對「選取標記」沒差（就那幾個），
   * 對「找點在哪」是致命的：拉遠一點就全部縮成看不見。
   *
   * ⚠ **只在網格或選取變動時呼叫**，⛔ 不要放進每幀迴圈（坑第 22 條）。
   *
   * @param {THREE.Vector3[]} worldPts 世界座標的點，空陣列 ＝ 清掉
   */
  setVertexDots(worldPts) {
    this.clearVertexDots();
    if (!worldPts || !worldPts.length) return;

    const pos = new Float32Array(worldPts.length * 3);
    worldPts.forEach((p, i) => { pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z; });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));

    const pts = new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffffff,
      size: 7,
      sizeAttenuation: false,     // ★ 固定螢幕大小
      depthTest: false            // 被面擋住的點也要看得到，否則背面的點找不到
    }));
    pts.renderOrder = 5;          // 在選取標記（6）底下 —— 選到的要蓋過一般的
    pts.raycast = () => {};       // ⚠ 不參與點選，否則會擋住底下真正要點的東西
    this.scene.add(pts);
    this._vertDots = pts;
  }

  /**
   * 🔴 **刀具的「這一刀會切在哪」預覽。**
   *
   * kang 2026-08-25：「不知道要如何點兩點呈現我想要的切一刀位置」——
   * 螢幕上那條虛線只說明「你畫過哪裡」，**這一條才說明「會切到哪裡」**。
   *
   * ⚠ 用 **`LineSegments`**（每兩個點一段），⛔ 不是 `Line` ——
   * 交線是一堆**各自獨立**的線段，串成連續折線會多畫一堆不存在的線。
   *
   * ⚠ 整批一個物件，跟「顯示點」同一個理由：
   * 這一支會被 pointermove 一直呼叫，⛔ 不可以每段建一個 Mesh。
   *
   * @param {THREE.Vector3[]} worldPts 兩兩一組的世界座標端點
   */
  setKnifePreview(worldPts, dots) {
    this.clearKnifePreview();
    const g = new THREE.Group();
    g.name = 'knifePreview';

    /** 段落：⚠ `LineSegments`（每兩點一段），⛔ 不是 `Line` */
    if (worldPts && worldPts.length >= 2) {
      const pos = new Float32Array(worldPts.length * 3);
      worldPts.forEach((p, i) => {
        pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const ln = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: 0xff8c1a,
        depthTest: false      // 背面那一段也要看得到，否則只看得到一半
      }));
      ln.renderOrder = 7;
      g.add(ln);
    }

    /**
     * 🔴 **點過的位置也要標出來。**
     * ⚠ 只畫線的話，**點了第一下之後畫面上什麼都沒有** ——
     * 那就是一顆按了沒反應的操作（坑第 21 條）。
     */
    if (dots && dots.length) {
      const dp = new Float32Array(dots.length * 3);
      dots.forEach((p, i) => {
        dp[i * 3] = p.x; dp[i * 3 + 1] = p.y; dp[i * 3 + 2] = p.z;
      });
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
      const pts = new THREE.Points(dg, new THREE.PointsMaterial({
        color: 0xff8c1a, size: 11, sizeAttenuation: false, depthTest: false
      }));
      pts.renderOrder = 8;
      g.add(pts);
    }

    if (!g.children.length) return;
    g.traverse(o => { o.raycast = () => {}; });
    this.scene.add(g);
    this._knifePrev = g;
  }

  clearKnifePreview() {
    if (!this._knifePrev) return;
    this.scene.remove(this._knifePrev);
    this._knifePrev.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this._knifePrev = null;
  }

  clearVertexDots() {
    if (!this._vertDots) return;
    this.scene.remove(this._vertDots);
    this._vertDots.geometry.dispose();
    this._vertDots.material.dispose();
    this._vertDots = null;
  }

  // ── 投影方式與標準視角 ────────────────────────────

  get isOrtho() { return this.camera === this.ortho; }

  /**
   * 切換透視／正交。
   *
   * 換的時候要把「現在在看什麼」原封不動帶過去，否則使用者按一下
   * 畫面整個跳掉，就得重新找方向。所以位置與朝向直接複製，
   * 正交的視野範圍再從透視的張角回推 ——
   * 目標點附近的東西看起來大小一樣，畫面幾乎不跳。
   */
  setProjection(ortho) {
    const want = ortho ? this.ortho : this.persp;
    if (want === this.camera) return this.isOrtho;

    const from = this.camera;
    want.position.copy(from.position);
    want.quaternion.copy(from.quaternion);

    if (ortho) this._fitOrtho();

    this.camera = want;
    this.orbit.object = want;
    this.orbit.update();
    this.resize();
    // gizmo 也要換相機，不然拖曳的方向會對不上畫面
    if (this.onCameraChange) this.onCameraChange(want);
    return this.isOrtho;
  }

  /** 依照目前與目標點的距離，算出正交相機該看多大範圍 */
  _fitOrtho() {
    const dist = this.ortho.position.distanceTo(this.orbit.target) || 100;
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2));
    const el = this.canvas.parentElement;
    const aspect = (el && el.clientHeight) ? el.clientWidth / el.clientHeight : 1;
    const halfW = halfH * aspect;
    Object.assign(this.ortho, {
      left: -halfW, right: halfW, top: halfH, bottom: -halfH
    });
    this.ortho.zoom = 1;
    this.ortho.updateProjectionMatrix();
  }

  /**
   * 標準視角。距離維持不變，只換方向。
   *
   * 上視圖刻意用 `Math.PI/2 - 1e-4` 而不是正上方：正上方時視線與 up 向量
   * 平行，OrbitControls 算不出水平方位角，畫面會突然轉一圈。
   * 差萬分之一度肉眼看不出來，但少一個會嚇到人的行為。
   */
  setView(which) {
    const t = this.orbit.target;
    const dist = this.camera.position.distanceTo(t) || 300;
    const dir = {
      front: [0, 0, 1],
      back:  [0, 0, -1],
      right: [1, 0, 0],
      left:  [-1, 0, 0],
      top:   [0, 1, 0],
      iso:   [0.8, 0.65, 0.85]
    }[which];
    if (!dir) return;

    const v = new THREE.Vector3(...dir).normalize();
    if (which === 'top') v.set(0, 1, 1e-4).normalize();

    this.camera.position.copy(t).addScaledVector(v, dist);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(t);
    if (this.isOrtho) this._fitOrtho();
    this.orbit.update();
  }

  // ── 畫面 ──────────────────────────────────────────

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    if (this.isOrtho) this._fitOrtho();
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
