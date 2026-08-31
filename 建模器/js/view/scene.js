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

/**
 * 🔴 **指到的東西「變大」多少**（kang 2026-08-26 拍板：只變大，⛔ 不換顏色）。
 *
 * 點：一般的選取小球是半徑 1.4，指到變 2.6 —— **差不多兩倍才看得出來**，
 * 再大就會蓋住旁邊的角。
 * 邊：0.35 的細圓柱。⚠ ⛔ 不可以改用 `linewidth`，那個在這一版
 * 完全沒有作用（見 `setPickMarks()` 裡的實證）。
 *
 * 單位是 cm（世界座標）。
 */
const HOVER_VERT_R = 2.6;
const HOVER_EDGE_R = 0.35;

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
     * 🔴 **轉得到模型底下。⛔ 不要改回 90 度。**
     *
     * ── 舊版是 `Math.PI / 2`，理由是「擋得住鑽到地板下面」──────
     * ⚠ **那個理由只想到「畫面好不好看」，⛔ 從頭到尾沒有想到「編輯」** ——
     * 相機鎖在水平線以上 ＝ **模型底面的點／邊／面永遠點不到**。
     * 〔kang 2026-08-29 回報：「我沒辦法轉到模型的底，這樣點線面選不到」〕
     *
     * ⭐ **這是「一條規則在第二個場景變成例外」的又一例**（環切之於
     * 「共面的邊不該存在」是第一例）——「刻意的」⛔ 不等於「對的」。
     *
     * ── 🔴 為什麼「先用旋轉模式把物件轉過來」⛔ 不是可接受的替代 ────
     * **旋轉模式改的是資料，⛔ 不是視角**：`rot` 會存進檔案（`io.js:262`）。
     * 而 `toolbar.js` 自己早就寫下代價：
     * > 「物件一被搬動或**旋轉**，這個數字就跟『**切一刀**』『對齊』『貼合』
     * > 『**剖面分切**』**對不起來**，而畫面上完全看不出來」（坑第 20 條）
     *
     * ⚠ **工具本身沒壞** —— `切一刀` 吃的是 `worldBounds(obj)`，照定義是對的。
     * 錯的是「我以為模型還在原本的姿勢」。**風險不在轉不回來**
     * （面板有「旋轉 度」欄位，打 0 就精確歸零），**在忘記轉回來**。
     *
     * ── ⚠ 為什麼是 `- 1e-4`，⛔ 不是剛好 `Math.PI` ─────────────
     * **正下方會撞到跟正上方一模一樣的病** —— 視線與 up 向量平行時
     * OrbitControls 算不出水平方位角，**畫面會突然轉一圈**。
     * ⭐ 這一招 `setView()` 的上視圖早就用了（那裡是 `v.set(0, 1, 1e-4)`），
     * ⛔ 這裡照抄同一個量，不要自己另訂一個。
     *
     * ⚠ **正側／正視圖仍然對得準** —— 90 度那一格還在範圍內，
     * ⛔ 放寬上限不會讓它停不到水平。〔舊註解擔心的 `Math.PI * 0.495`
     * 是**下限太小**的問題，跟這次放寬上限是兩件事〕
     *
     * 🔴 **`scene.js` 沙箱測不到（測試一項都沒涵蓋它）** ——
     * 這一行只能靠真的轉一次。
     */
    this.orbit.maxPolarAngle = Math.PI - 1e-4;

    this._buildEnvironment();

    /** ModelObject.id → THREE.Mesh */
    this.byId = new Map();
    /** 場景中所有可點選的物件 */
    this.pickables = [];

    this.showEdges = true;
    this.wireframe = false;
    /**
     * 參考線畫不畫。⚠ **預設開** —— 加了一條線卻看不到，
     * ⛔ 跟「這顆按鈕壞了」分不出來（坑第 21 條）。
     * 線本身的家在 `doc.guides`，這裡只管**畫不畫**。
     */
    this.guidesVisible = true;
    this._guides = null;

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
    /**
     * 🔴 **表面上那一條一條的斜紋，是物體把自己誤判成「被自己擋住」。**
     * 〔kang 2026-08-27 回報：「面的顏色有時候會出現一條一條的紋路」〕
     *
     * **算式**：影子貼圖 2048 像素要涵蓋 `s*2` ＝ 1000 cm
     * → **一個像素約 0.49 cm**。比對深度時只要誤差超過它，
     * 表面就會一格一格地判成陰影 —— 規律的細斜紋（shadow acne）。
     *
     * 🔴 **病因是「⛔ 沒設容許值」，⛔ 不是陰影開錯了。**
     * ⚠ 這正是坑第 25／26 條那條規則的第三個現場：
     * **浮點數的相等（這裡是大小）判斷一律要有容許值，
     * 而且要挑一個有物理意義的量去比** —— 這裡的物理量就是
     * 「一個影子像素在世界裡有多大」＝ 0.49 cm。
     *
     * ── 為什麼方塊不會、球與平板會（kang 實測的三個事實）──────
     * **面跟陽光越斜，同一個影子像素跨越的深度差就越大。**
     * 方塊六個面都是軸對齊的，角度單純；**球面上一定有一整圈
     * 「幾乎與陽光平行」的區域**，那裡最嚴重；平板則是面積大、
     * 同一片面跨過很多個影子像素。
     *
     * ── 兩個參數的分工，⛔ 不要只設一個 ─────────────────
     * | | 做什麼 | 副作用 |
     * |---|---|---|
     * | `bias` | 比對前把深度往內縮一點（**貼圖空間**，無單位） | 太大 → 影子脫離物體，看起來浮在空中（peter-panning） |
     * | `normalBias` | 取樣點沿**面的法向**推開（**世界單位 ＝ cm**） | 太大 → 薄板的影子會漏光 |
     *
     * ⭐ **曲面靠 `normalBias` 才治得好** —— 它跟著法向走，
     * 正好對上「越斜越嚴重」那個病因；`bias` 是全域固定量，治不了斜面。
     *
     * ⚠ **這兩個數字沙箱驗不了**（連畫面都跑不起來）——
     * 🔴 **要調就照 kang 實際看到的結果調，⛔ 不要為想像中的數字辯護。**
     * 調整順序：先只動 `normalBias`（0.3 → 0.8），還有紋路再碰 `bias`。
     */
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;

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

    /**
     * 🔴 **參考線也在這裡重畫。**
     *
     * ⚠ **⛔ 不可以只在「按了加一條」的時候畫** —— `Undo` 走的是
     * `hist.set → doc.loadJSON() → view.sync(doc)`，⛔ 不經過任何按鈕。
     * 掛在 `sync()` 裡，**復原、讀檔、開新檔三條路一次全涵蓋**。
     * 〔鐵律二的同一個形狀：兩端都要，只改一端 ＝ 沒改〕
     */
    this.syncGuides(doc);
    /**
     * ⚠ **一定要放在 `sync()` 的最後重套一次** —— 編輯路徑的時候
     * 每拖一下都會 `sync()`，⛔ 不重套的話半透明會在第一次重建時掉回不透明，
     * 而那正是「拖到一半東西突然擋住線」。
     */
    this._applyGhost();
  }

  /**
   * 🔴 **把某一個物件變半透明**（`編輯路徑` 用，kang 2026-08-29 拍板）。
   *
   * > **⛔ 不隱藏** —— 隱藏了就看不到自己在改什麼，
   * > 那跟「從頭畫一次」沒有兩樣。
   *
   * @param {string|null} id 要變透明的物件 id（`null` ＝ 全部還原）
   */
  setGhost(id) {
    this._ghostId = id || null;
    this._applyGhost();
  }

  _applyGhost() {
    const gid = this._ghostId || null;
    for (const [oid, node] of this.byId) {
      const on = gid !== null && oid === gid;
      const m = node.material;
      if (!m || !!m.transparent === on) continue;
      m.transparent = on;
      m.opacity = on ? 0.28 : 1;
      /**
       * ⚠ **`depthWrite` 要跟著關** —— 不關的話半透明的面還是會把
       * 它後面的線擋掉，看起來就像「沒有變透明」。
       */
      m.depthWrite = !on;
      m.needsUpdate = true;
    }
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
  /**
   * ⚠ **順手清掉破洞的紅線** —— 幾何一變，那些線就可能是謊話了
   * （補洞之後紅線還在，使用者會以為沒補成功）。
   * 🔴 **這是「加新功能時順手檢查舊訊息有沒有過期」那條的預防版**：
   * ⛔ 與其日後記得在每個編輯功能裡清一次，不如綁在
   * 「**幾何變了**」這個每次都會走到的訊號上（坑第 31 條）。
   */
  markGeomDirty() { this._geomDirty = true; this.clearIssuePreview(); }

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

  // ── 參考線 ────────────────────────────────────────

  /**
   * 🔴 **參考線：一條螢幕上的線，在 3D 裡是一個平面。**
   *
   * ── 為什麼畫成「井字」而⛔ 不是一片半透明的面 ──────────
   * 半透明的面會**把模型的顏色染掉**，而參考線是**輔助**、⛔ 不是內容 ——
   * 染色會讓人以為模型變了。所以每個平面只畫**四條邊 ＋ 一個十字**：
   * 從任何一個正交視角看過去，它投影出來**就是一條直線**（正是 PS 的樣子），
   * 而斜看的時候看得出它是一個平面 —— ⭐ 那正好解釋了「三個視角共用」
   * 這件事，⛔ 不必用文字說明。
   *
   * ── 尺寸跟著地板走 ──────────────────────────────
   * 地板網格是 600cm（見 `_initLights` 那段）。參考線用同一個範圍，
   * ⚠ **⛔ 不要另外寫一個數字** —— 兩個數字遲早會不一樣，
   * 而使用者只會看到「參考線比地板短一截」。
   *
   * ── 顏色 ────────────────────────────────────────
   * 青色 `0x2ad4d4`（kang 2026-08-31 選的，＝ Photoshop 的參考線顏色）。
   * ⚠ **跟「切一刀預覽」是同一個值** —— 容許它的理由：
   * 切一刀那個是**短暫的**，而且兩者形狀完全不同
   * （切一刀是模型表面上的一圈，參考線是貫穿場景的一個平面框）。
   */
  syncGuides(doc) {
    this.clearGuides();
    const g = doc && doc.guides;
    if (!g) return;

    const R = 300;                       // ＝ 地板 600cm 的一半
    const seg = [];                      // ⚠ LineSegments：每兩點一段
    const push = (a, b) => { seg.push(a, b); };
    const V = (x, y, z) => new THREE.Vector3(x, y, z);

    /**
     * 一個平面畫五樣東西：四條邊 ＋ 中央的十字。
     * @param {(u:number, v:number) => THREE.Vector3} at 平面上的座標 → 世界座標
     */
    const frame = at => {
      push(at(-R, -R), at(R, -R));
      push(at(R, -R), at(R, R));
      push(at(R, R), at(-R, R));
      push(at(-R, R), at(-R, -R));
      push(at(-R, 0), at(R, 0));         // 十字：橫
      push(at(0, -R), at(0, R));         // 十字：直
    };

    for (const v of g.x || []) frame((u, w) => V(v, w, u));
    for (const v of g.y || []) frame((u, w) => V(u, v, w));
    for (const v of g.z || []) frame((u, w) => V(u, w, v));

    if (!seg.length) return;
    this._guides = this._buildLineOverlay('guides', seg, null, 0x2ad4d4);
    if (!this._guides) return;
    /**
     * ⚠ **`renderOrder` 要比另外那幾種預覽低**（它們是 7／8）——
     * 參考線是**一直都在**的東西，⛔ 不可以蓋住「你現在正在做的那件事」。
     */
    this._guides.traverse(o => { if (o.renderOrder) o.renderOrder = 5; });
    /**
     * ⚠ **⛔ 不要再 `scene.add()` 一次** —— `_buildLineOverlay()` 自己
     * 最後一行就加進場景了。多加一次 three.js ⛔ 不會報錯，
     * 但那個節點會**被登記兩次**，移除時只清掉一份 —— 線會留在畫面上。
     */
    this._guides.visible = this.guidesVisible;
  }

  clearGuides() {
    if (!this._guides) return;
    this.scene.remove(this._guides);
    this._guides.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this._guides = null;
  }

  /**
   * ⚠ **關掉只是⛔ 不畫，線還在（存檔也還在）。**
   * 這跟「全部清掉」是兩回事 —— 呼叫端的訊息要講清楚，
   * 否則使用者會以為線被刪了（坑第 21 條的反面：看不見 ≠ 不存在）。
   */
  setGuidesVisible(on) {
    this.guidesVisible = !!on;
    if (this._guides) this._guides.visible = this.guidesVisible;
    return this.guidesVisible;
  }

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
  /**
   * 一段細圓柱，用來當「有厚度的線」。
   *
   * ⚠ 半徑是**世界單位（cm）**，所以拉遠會變細 —— 跟既有的選取小球
   * （`SphereGeometry(1.4)`）同一個行為，⛔ 不要為 hover 另發明一套。
   * 〔「顯示點」用的是固定螢幕像素，那是因為它要在拉遠時還找得到；
   * 　hover 是「你的游標就在那裡」，本來就在看得清楚的距離〕
   *
   * @returns {THREE.Mesh|null} 長度 0 的段回 null（畫出來是一個看不見的點）
   */
  _tube(a, b, r, col) {
    const dir = new THREE.Vector3().subVectors(b, a);
    const len = dir.length();
    if (!(len > 1e-6)) return null;
    const geo = new THREE.CylinderGeometry(r, r, len, 8, 1, true);
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      color: col, depthTest: false
    }));
    mesh.position.copy(a).addScaledVector(dir, 0.5);
    /** 圓柱預設沿 +Y，轉到 a→b 的方向 */
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0), dir.clone().normalize()
    );
    mesh.renderOrder = 7;
    return mesh;
  }

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
      /**
       * 🔴 **`hover` 是一個旗標，⛔ 不是第四種顏色**（kang 2026-08-26 拍板）。
       *
       * 理由是**兩個狀態會同時發生**：你正指著一個**已經選到**的元素。
       * 用顏色的話那一刻要決定誰贏；**變大則可以疊加** ——
       * 黃色又變大 ＝「已經選到，而且你正指著它」。
       * ⚠ 而畫面上顏色已經有五種意思了，再加一種只會更難讀。
       *
       * 沒被選到的元素被指到時走 `role:'hover'` → 白色，
       * 跟「顯示點」同一個顏色（那本來就是「這裡有一個元素」的意思）。
       */
      const col = m.role === 'dst' ? 0x3ad07a
                : m.role === 'active' ? 0xff8c1a
                : m.role === 'hover' ? 0xffffff
                : 0xffd23f;

      if (m.kind === 'vertex') {
        // 點要畫得夠大才看得見，但太大會蓋住旁邊的角
        const s = new THREE.Mesh(
          new THREE.SphereGeometry(m.hover ? HOVER_VERT_R : 1.4, 12, 8),
          new THREE.MeshBasicMaterial({ color: col, depthTest: false })
        );
        s.position.copy(m.points[0]);
        s.renderOrder = m.hover ? 7 : 6;
        g.add(s);
      } else if (m.hover) {
        /**
         * 🔴 **指到的邊要變粗 —— 而「變粗」不能用 `linewidth`。**
         *
         * 【實證 · 讀過 `lib/three/three.core.min.js`】
         * **這一版的渲染器一次都沒有呼叫 `gl.lineWidth()`（grep：0 次）。**
         * `LineBasicMaterial.linewidth` 存得進去，但**永遠不會被套用** ——
         * 改了它畫面上什麼都不會變（坑第 21 條那種按了沒反應的東西）。
         *
         * → 所以真的要粗，就得畫成**有厚度的東西**：一段細圓柱。
         * ⚠ 只有 hover 走這條路，而 hover **一次只有一個元素**，
         * ⛔ 不會變成「每條選取的邊都建一個 Mesh」（坑第 22 條）。
         */
        const pts = m.points;
        const close = m.kind === 'face';
        for (let i = 0; i < pts.length - (close ? 0 : 1); i++) {
          const t = this._tube(pts[i], pts[(i + 1) % pts.length], HOVER_EDGE_R, col);
          if (t) g.add(t);
        }
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
    this._knifePrev = this._buildLineOverlay('knifePreview', worldPts, dots, 0xff8c1a);
  }

  /**
   * 🔴 **「切一刀」的即時預覽：打數字的當下就看得到會切在哪條線上。**
   *
   * ⚠ **它跟刀具是同一個病的兩張臉** —— 刀具那邊是「點兩個位置看不出
   * 往深處切到哪」，這邊是「打一個座標看不出那個平面落在模型的哪裡」。
   * 兩個都是坑第 21 條：**看不到作用的操作沒有人敢按。**
   *
   * ⭐ 算的那一半（`planeCrossSegments()`）**早就寫好而且測過了**，
   * 只是刀具改設計之後沒有人在呼叫它 —— 這一輪把它接上來，
   * ⛔ 不是留著一支沒人用的函式假裝還有退路（坑第 34 條）。
   *
   * 顏色刻意跟刀具的橘色分開（青色）：兩個功能同時只會出現一個，
   * 但**它們的意思不同** —— 橘色是「你指定的位置」，青色是「程式算出來的結果」。
   */
  setCutPreview(worldPts) {
    this.clearCutPreview();
    this._cutPrev = this._buildLineOverlay('cutPreview', worldPts, null, 0x2ad4d4);
  }

  clearCutPreview() {
    if (!this._cutPrev) return;
    this.scene.remove(this._cutPrev);
    this._cutPrev.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this._cutPrev = null;
  }

  /**
   * 🔴 **破洞在哪裡：把模型上「只有一邊有面」的邊標出來。**
   *
   * ⚠ **它跟另外兩種預覽是同一個病的第三張臉**（坑第 21 條）——
   * 「3D 列印」面板**早就在說「不是封閉的，有 N 條邊界邊」**，
   * 但**只給數字，指不出來在哪**，使用者只能自己一條一條找。
   *
   * ⭐ **顏色用紅色，跟另外兩種分開**，因為它的意思是第三種：
   * 橘色 ＝ 你指定的位置、青色 ＝ 程式算出來的結果、
   * **紅色 ＝ 這裡有問題**。
   *
   * ⚠ **它 ⛔ 不是選取** —— 選取那條路要為邊界邊開第二個例外
   * （`isMarkable()` 刻意擋掉它們），而使用者要的只是看得到。
   */
  setHolePreview(worldPts) {
    this._setIssuePreview('holePreview', worldPts, 0xff2d55);
  }

  /**
   * 🔴 **非流形邊在哪裡：把「被 3 個以上的面共用」的邊標出來。**
   *
   * ⚠ **⛔ 它跟破洞不是同一種病，所以 ⛔ 不共用紅色。**
   *
   * | | 是什麼 | 怎麼修 |
   * |---|---|---|
   * | **紅色（破洞）** | 只有一邊有面 | 按 `補洞` |
   * | **紫色（非流形）** | 一條邊被 3 個以上的面共用 | 🔴 **`補洞` 補不了它** —— 要自己刪掉多餘的面或分開 |
   *
   * ⚠ **兩者長得一模一樣（都是模型上的一條線）**，所以顏色是使用者
   * 唯一分得出來的線索 —— ⛔ 不要為了省一個顏色把它們畫成一樣。
   * 〔顏色的第四種意思：橘＝你指定的、青＝程式算出來的、
   * 　紅＝這裡破了、**紫＝這裡黏在一起了**〕
   */
  setNonManifoldPreview(worldPts) {
    this._setIssuePreview('nonManifoldPreview', worldPts, 0xb44cff);
  }

  /**
   * 🔴 **兩種「這裡有問題」的標示共用同一個槽，⛔ 不是各存各的。**
   *
   * ⚠ **理由是清除路徑**：這個 overlay 有**兩條**清除路徑
   * （`markGeomDirty()` 與 `exportPanel.open()`），
   * 而每多一個欄位就要在那兩條路上各補一行 —— **兩份一定會漂**，
   * 漏掉的症狀是「舊的標示賴著不走」，而畫面上看起來像新標的。
   * 〔坑第 31 條：與其讓好幾條路對齊，不如換一個只有一條路的定義〕
   *
   * ⭐ **同一時間只顯示一種是對的**：使用者一次修一種病，
   * 兩種疊在一起反而分不出哪條線是哪種。
   */
  _setIssuePreview(name, worldPts, color) {
    this.clearIssuePreview();
    this._issuePrev = this._buildLineOverlay(name, worldPts, null, color);
  }

  clearIssuePreview() {
    if (!this._issuePrev) return;
    this.scene.remove(this._issuePrev);
    this._issuePrev.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this._issuePrev = null;
  }

  /**
   * 兩種預覽共用的那一段。
   *
   * ⚠ **抽出來是刻意的**：原本要為「切一刀」再抄一份同樣的 45 行，
   * 而兩份一定會漂（坑第 31 條：與其讓兩條路對齊，不如只留一條路）。
   */
  _buildLineOverlay(name, worldPts, dots, color) {
    const g = new THREE.Group();
    g.name = name;

    /** 段落：⚠ `LineSegments`（每兩點一段），⛔ 不是 `Line` */
    if (worldPts && worldPts.length >= 2) {
      const pos = new Float32Array(worldPts.length * 3);
      worldPts.forEach((p, i) => {
        pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const ln = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color,
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
        color, size: 11, sizeAttenuation: false, depthTest: false
      }));
      pts.renderOrder = 8;
      g.add(pts);
    }

    if (!g.children.length) return null;
    g.traverse(o => { o.raycast = () => {}; });
    this.scene.add(g);
    return g;
  }

  // ═══════════════════════════════════════════════════════
  //  量測第 2 步：把數字畫到 3D 畫面上
  // ═══════════════════════════════════════════════════════

  /**
   * 🔴 **把量測的字擺到 3D 場景裡。**
   *
   * ── ⛔ 為什麼不畫在螢幕座標上 ────────────────────────────
   * `index.html` 那段墓碑註解寫得很清楚：刀具第一版就是**畫在螢幕上**，
   * 而切點是**模型上的位置** —— 一轉視角就對不上（症狀是「預覽一直亂跳」），
   * 那個疊層已經整個移除了。**量測的字指的也是模型上的位置**，
   * ⛔ 不會把同一個坑再挖一次。
   *
   * ── 做法照 `select.js` 的三個軸標 ────────────────────────
   * canvas 畫字 → `CanvasTexture` → `Sprite`，`depthTest:false`。
   * ⭐ 那一套 kang 已經實測過了，⛔ 不另外發明第二種畫字的方式。
   *
   * ⚠ **跟軸標的兩個差別，都是刻意的**：
   * 1. **數量會隨選取成長**（軸標永遠是 3 個）→ 所以要 `dispose()`
   *    舊的材質與貼圖，⛔ 漏掉就是記憶體一路長上去，**而畫面完全正常**。
   *    上限由 `measureLabels()` 的 `MEASURE_LABELS_MAX` 擋在前面。
   * 2. **字底下加一層半透明深底**。軸標是單一個字母、又跟拉桿同色系，
   *    只描邊就夠；量測是一串數字，疊在亮面上光靠描邊讀不出來。
   *
   * @param {{text:string,pos:THREE.Vector3}[]} items `measureLabels()` 回的
   */
  setMeasureLabels(items) {
    this.clearMeasureLabels();
    if (!items || !items.length) return;

    const g = new THREE.Group();
    g.name = 'measureLabels';
    for (const it of items) {
      if (!it || !it.pos) continue;
      const sp = this._makeTextSprite(String(it.text ?? ''));
      sp.position.copy(it.pos);
      g.add(sp);
    }
    if (!g.children.length) return;

    g.traverse(o => { o.raycast = () => {}; });   // ⛔ 不參與點選，否則會擋住物件
    this.scene.add(g);
    this._measureLabels = g;
    /** 立刻擺一次大小，⛔ 不要等下一幀 —— 那一幀會看到字忽大忽小閃一下 */
    this._syncMeasureLabelScale();
  }

  clearMeasureLabels() {
    if (!this._measureLabels) return;
    this.scene.remove(this._measureLabels);
    this._measureLabels.traverse(o => {
      if (o.material) {
        // 🔴 貼圖要自己 dispose，⛔ `material.dispose()` 不會連 map 一起收
        if (o.material.map) o.material.map.dispose();
        o.material.dispose();
      }
    });
    this._measureLabels = null;
  }

  /** 一串字（可含 `\n`）→ 一個 Sprite。⚠ 字級與留白都是 canvas 的像素，跟世界座標無關 */
  _makeTextSprite(text) {
    const FS = 44;                 // canvas 上的字級（px）
    const LINE = Math.round(FS * 1.28);
    const PAD_X = 18, PAD_Y = 10;
    const lines = text.split('\n');

    const cv = document.createElement('canvas');
    const g = cv.getContext('2d');
    const font = `600 ${FS}px "Noto Sans TC", Arial, sans-serif`;
    g.font = font;
    let w = 0;
    for (const s of lines) w = Math.max(w, g.measureText(s).width);

    cv.width = Math.ceil(w) + PAD_X * 2;
    cv.height = LINE * lines.length + PAD_Y * 2;

    // ⚠ 改過 canvas 尺寸之後 context 會被重設，字型要重新指定
    g.font = font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';

    /** 半透明深底：亮面上的白字光靠描邊讀不出來 */
    const r = 12;
    g.fillStyle = 'rgba(20,23,28,0.78)';
    g.beginPath();
    g.moveTo(r, 0);
    g.arcTo(cv.width, 0, cv.width, cv.height, r);
    g.arcTo(cv.width, cv.height, 0, cv.height, r);
    g.arcTo(0, cv.height, 0, 0, r);
    g.arcTo(0, 0, cv.width, 0, r);
    g.fill();

    g.lineWidth = 5;
    g.strokeStyle = 'rgba(0,0,0,0.85)';
    g.fillStyle = '#ffe07a';        // 跟「選到的東西」那個黃色同一家
    lines.forEach((s, i) => {
      const y = PAD_Y + LINE * i + LINE / 2;
      g.strokeText(s, cv.width / 2, y);
      g.fillText(s, cv.width / 2, y);
    });

    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthTest: false, depthWrite: false
    }));
    /** 99：畫在模型上面，但**讓在 gizmo 的 X／Y／Z 底下**（那三個字是 100）*/
    sp.renderOrder = 99;
    sp.userData.aspect = cv.width / cv.height;
    sp.userData.rows = lines.length;
    return sp;
  }

  /**
   * 每一幀把字調成「不管拉遠拉近都一樣大」。
   *
   * 🔴 **⛔ 不可以只擺一次就不管** —— 不調的話字會跟著模型一起縮，
   * 拉遠就小到讀不出來，而使用者看到的是「這個功能有時候沒作用」
   * （鐵律：那多半是狀態依賴，這裡的狀態是相機距離）。
   *
   * 算法照抄 `select.js` `syncGizmoLabels()` 那一段（它又是照抄
   * TransformControls 的）——⭐ **兩處用同一個 factor，字才不會跟箭頭脫節**。
   *
   * ⚠ **每一幀跑，所以裡面只有固定次數的向量運算**，
   * 而且總數被 `MEASURE_LABELS_MAX` 擋住，⛔ 不會隨模型大小成長（坑第 22 條）。
   */
  _syncMeasureLabelScale() {
    const g = this._measureLabels;
    if (!g) return;
    const cam = this.camera;

    /** 單行字要佔畫面的比例（factor 的倍數）。比軸標小一點 —— 那是一串數字不是一個字母 */
    const LABEL_H = 0.055;

    let orthoFactor = 0;
    const camPos = new THREE.Vector3();
    if (cam.isOrthographicCamera) {
      orthoFactor = (cam.top - cam.bottom) / cam.zoom;
    } else {
      cam.getWorldPosition(camPos);
    }

    for (const sp of g.children) {
      const factor = cam.isOrthographicCamera
        ? orthoFactor
        : sp.position.distanceTo(camPos)
          * Math.min(1.9 * Math.tan(Math.PI * cam.fov / 360) / cam.zoom, 7);
      const h = factor * LABEL_H * (sp.userData.rows || 1);
      sp.scale.set(h * (sp.userData.aspect || 2), h, 1);
    }
  }

  /**
   * 🔴 **刀具模式下把「按住拖」讓給一筆畫，轉視角換到別的手勢。**
   *
   * ── ⚠ 為什麼一定要換，不能兩個並存 ──────────────────
   * 「按住拖一條線」跟「按住拖轉視角」是**同一個動作**。
   * 不換的話一筆畫永遠拿不到那個手勢，而模型還會跟著轉。
   *
   * ── 【實證 · 讀過 `lib/three/addons/controls/OrbitControls.js`】───
   * ```
   * 行 358   mouseButtons = { LEFT: ROTATE, MIDDLE: DOLLY, RIGHT: PAN }
   * 行 371   touches      = { ONE: ROTATE, TWO: DOLLY_PAN }
   * 行 1646  每次按下都重新讀 mouseButtons → 執行時改就生效
   * 行 1720  滑鼠 switch 的 default 是 state = NONE
   * 行 1820  觸控 switch 的 default 也是 state = NONE
   * ```
   * → **設成一個無效值（`-1`）＝ 那個手勢什麼都不做**，
   *   而 `MOUSE.ROTATE` 與 `TOUCH.ROTATE` 都是 `0`，所以 `-1` 不會撞到任何一個。
   *
   * | | 平常 | 刀具模式下 |
   * |---|---|---|
   * | 桌機左鍵拖 | 轉視角 | **一筆畫** |
   * | 桌機右鍵拖 | 平移 | **轉視角** |
   * | 平板單指／觸控筆 | 轉視角 | **一筆畫** |
   * | 平板兩指 | 縮放＋平移 | **轉視角＋縮放**（`DOLLY_ROTATE`）|
   *
   * ⭐ **平板那兩列才是重點** —— `touches` 跟 `mouseButtons` 是分開的兩個設定，
   * 所以「筆用來畫、兩指用來轉」是直接成立的，不是勉強擠出來的。
   *
   * ⚠ **⛔ 不要拿 `Ctrl`／`Shift`／`Cmd` 當一筆畫的開關** ——
   * 【實證 · 同一支檔案行 1677】`MOUSE.ROTATE` 分支裡那三個修飾鍵**已經被佔用**
   * （按著會變成平移）。
   *
   * 🔴 **這是「進模式改設定、離開還原」的狀態，所以只有一個入口**
   * （`select.js` 的 `setKnifeMode()`）—— ⛔ 不要在進出刀具的每一處各寫一次還原
   * （坑第 31 條：與其讓好幾條路對齊，不如換一個只有一條路的定義）。
   */
  /**
   * 🔴 **地板上的一點：把螢幕座標打到 y ＝ 0 那個平面。**
   *
   * ── 為什麼鋼筆要它 ──────────────────────────────────
   * 鋼筆是**畫在地板上**的（kang 2026-08-27 拍板，跟 `匯入線稿` 同一條路）。
   * ⚠ 而 `pickElement()` 那條路是**打到模型上** —— 地板上什麼都沒有，
   * 打不到任何 `pickables`。**⛔ 兩者不能混用。**
   *
   * ⭐ 回傳 **(x, z)**，⛔ 不是 (x, y) —— 地板上的兩個軸在世界裡是 X 與 Z，
   * 而擠出件的輪廓也正是用 (x, z) 對應到 SVG 的 (x, y)
   * （`importPanel._makeObj()` 那一行註解寫著同一件事）。
   *
   * ⚠ **相機轉到地板底下時打不到**（射線跟平面同向）→ 回 `null`，
   * ⛔ 不硬給一個點。〔2026-08-29 起相機轉得到底下了，這件事會真的發生〕
   *
   * @returns {{x:number, z:number, world:THREE.Vector3}|null}
   */
  groundPoint(ndcX, ndcY) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const p = new THREE.Vector3();
    const hit = ray.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p);
    if (!hit) return null;
    return { x: p.x, z: p.z, world: p.clone() };
  }

  /**
   * 鋼筆的預覽線。⚠ 跟刀具是**兩個獨立的疊層**，⛔ 不共用同一個物件 ——
   * 兩個模式不會同時開，但共用的話關掉一個會把另一個也清掉。
   */
  /**
   * @param {THREE.Vector3[]} worldPts **路徑**的線段（兩兩一組）
   * @param {THREE.Vector3[]} dots     **錨點**
   * @param {THREE.Vector3}   hot      游標底下那個錨點（會畫大一號）
   * @param {THREE.Vector3[]} handlePts **把手**的線段（兩兩一組）
   * @param {THREE.Vector3[]} handleDots 把手的端點
   */
  setPenPreview(worldPts, dots, hot, handlePts, handleDots) {
    this.clearPenPreview();
    this._penPrev = this._buildLineOverlay('penPreview', worldPts, dots, 0x59d97b);

    /**
     * 🔴🔴 **把手一定要跟「路徑＋錨點」長得不一樣。**
     *
     * 〔kang 2026-08-29 第三次退回，附截圖 —— 而**截圖就是證據**〕
     * 舊版把把手的線塞進路徑那一組、把手的端點塞進錨點那一組，
     * 用**同樣的顏色、同樣的粗細、同樣大小的方塊**畫。
     * → **畫面上看起來就是「下一個點已經在那裡了，路徑也已經連過去了」。**
     *
     * 🔴 **而使用者會按下去，正是因為畫面告訴他那裡有一個點** ——
     * 那一按才真的產生下一個錨點，落在他只是想「確定」的位置。
     * ⚠ **他必須按「退一點」才能繼續** —— 那是這個誤導的實際代價。
     *
     * ⭐ **⛔ 邏輯本來就是對的**（2026-08-29 線上版逐步實測：
     * 按下→拖→放開，錨點數 1→2→2，**放開⛔ 不會多一個點**）——
     * **說謊的是畫面，⛔ 不是狀態機。**
     *
     * ── ⚠ 這裡刻意違反「只變大，⛔ 不換顏色」那一條 ──────────
     * 那條規則管的是**同一種東西的 hover**（指到的邊 vs 沒指到的邊）。
     * 而這裡要分的是**兩種不同的東西**：路徑 vs 控制桿。
     * ⭐ Illustrator 自己就是這樣分的：方向線**細**、方向點**小**，
     * 一眼就看得出「這是控制桿，⛔ 不是路徑」。
     */
    if (this._penPrev && handlePts && handlePts.length >= 2) {
      const pos = new Float32Array(handlePts.length * 3);
      handlePts.forEach((p, i) => {
        pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const ln = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
        color: 0x2f7f52,          // 比路徑暗一階
        transparent: true, opacity: 0.75,
        depthTest: false
      }));
      ln.renderOrder = 6;         // ⚠ 壓在路徑底下，⛔ 不要蓋住形狀
      ln.raycast = () => {};
      this._penPrev.add(ln);
    }
    if (this._penPrev && handleDots && handleDots.length) {
      const dp = new Float32Array(handleDots.length * 3);
      handleDots.forEach((p, i) => {
        dp[i * 3] = p.x; dp[i * 3 + 1] = p.y; dp[i * 3 + 2] = p.z;
      });
      const dg = new THREE.BufferGeometry();
      dg.setAttribute('position', new THREE.BufferAttribute(dp, 3));
      /** ⭐ **5 px ＝ 錨點（11 px）的一半以下** —— 大小就分得出來 */
      const pt = new THREE.Points(dg, new THREE.PointsMaterial({
        color: 0x2f7f52, size: 5, sizeAttenuation: false, depthTest: false
      }));
      pt.renderOrder = 6;
      pt.raycast = () => {};
      this._penPrev.add(pt);
    }
    /**
     * 🔴 **游標底下那個點要變大。**〔kang 2026-08-29 要的：
     * 「當滑鼠遇到點要能夠有略變大的呈現..不然很難判斷」〕
     *
     * ⭐ **只變大，⛔ 不換顏色** —— 跟編輯模式的「指到哪就亮哪」同一條規則
     * （換顏色的話就沒辦法跟「已經選到」疊加）。
     * ⚠ 另外開一個 `Points`，⛔ 不去改原本那一組的 `size`：
     * 一個 `PointsMaterial` 只有一個尺寸，混在一起就全部一起變大。
     */
    if (this._penPrev && hot) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position',
        new THREE.BufferAttribute(new Float32Array([hot.x, hot.y, hot.z]), 3));
      const pt = new THREE.Points(g, new THREE.PointsMaterial({
        color: 0x59d97b, size: 20, sizeAttenuation: false, depthTest: false
      }));
      pt.renderOrder = 9;
      pt.raycast = () => {};
      this._penPrev.add(pt);
    }
  }

  clearPenPreview() {
    if (!this._penPrev) return;
    this.scene.remove(this._penPrev);
    this._penPrev.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this._penPrev = null;
  }

  /**
   * 🔴 **把「畫」的手勢整組換掉：左鍵／單指空出來給畫，轉視角換到右鍵／兩指。**
   *
   * ⚠ **⛔ 這一支原本叫 `setKnifeInput()`**（2026-08-29 改名）——
   * 鋼筆要的是**一模一樣的東西**，而**兩個模式各留一份就是兩條要對齊的路**
   * （坑第 31 條）。⭐ 名字改成講「它做什麼」，⛔ 不是「誰在用」。
   *
   * ⭐ **平板那兩列才是重點**：`touches` 跟 `mouseButtons` 是分開的兩個設定，
   * 少改一個的話平板上單指會變成轉視角，畫不出東西。
   */
  setDrawInput(on) {
    /** 一個無效值 ＝ 那個手勢什麼都不做（兩個 switch 的 default 都是 NONE） */
    const NONE = -1;
    if (on) {
      if (this._orbitSaved) return;          // 已經切過了，⛔ 不可以再存一次
      this._orbitSaved = {
        mouseButtons: { ...this.orbit.mouseButtons },
        touches: { ...this.orbit.touches }
      };
      this.orbit.mouseButtons = {
        LEFT: NONE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE
      };
      this.orbit.touches = { ONE: NONE, TWO: THREE.TOUCH.DOLLY_ROTATE };
    } else {
      if (!this._orbitSaved) return;         // 本來就沒切，沒有東西要還原
      this.orbit.mouseButtons = this._orbitSaved.mouseButtons;
      this.orbit.touches = this._orbitSaved.touches;
      this._orbitSaved = null;
    }
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
    /**
     * ⚠ **一定要在 `orbit.update()` 之後**：阻尼還在動的那幾幀相機還會再移，
     * 先算的話字的大小會慢一幀 —— 轉視角時看起來就是「字在抖」。
     * ⭐ 掛在這裡是因為 `render()` 是每一幀**必經的唯一入口**，
     * ⛔ 不必再開第二條同步鏈（坑第 31 條）。
     */
    this._syncMeasureLabelScale();
    this.renderer.render(this.scene, this.camera);
  }

  get fps() { return this._fps.value; }
  /**
   * ⛔ **`get triangles()` 已於 2026-08-26 刪除，⛔ 不要加回來。**
   *
   * 它回傳的是 `renderer.info.render.triangles` ——
   * **上一幀顯示卡實際畫出去的三角形數**，會隨視角、線框模式、
   * gizmo 在不在、陰影而變。
   *
   * 🔴 而狀態列的標籤寫的是「三角形」，人讀到的是「這個模型有多複雜」——
   * **標籤跟數字的意思對不起來**（坑第 20 條），kang 的說法是「數字…亂跳」。
   *
   * → 狀態列改用 `mesh.triangleCount()`（模型的屬性，穩定）。
   * ⚠ 真的要「這一幀畫了幾個」再回來接 `renderer.info`，
   * 但那時候**標籤要跟著改**，⛔ 不可以再叫「三角形」。
   */
}
