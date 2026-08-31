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
import { nearestMarkableEdge, nearestFace, nearestVertex, canMarkSeams, markableEdges }
  from '../unfold/seam.js';
import { objectsInRect, elementsInRect, normRect } from '../core/screen.js';
/**
 * ⭐ **預覽用的拉直走的是生成時同一支函式** —— 預覽跟結果因此不可能不一樣。
 * ⚠ **單向相依**：`prim.js` ⛔ 沒有 import 這一支（它不認識畫面）。
 */
import { flattenPenPath, penIsSmooth, penSetHandle,
         penNearestOnPath, penAddAnchor, penRemoveAnchor } from '../build/prim.js';
import { worldBounds } from '../core/align.js';
import { guideSnapDelta, sameGuideHits } from '../core/guideSnap.js';
import { elementVerts, elementCenter, regionBoundaryEdges, elementBasis,
         snapshotVerts, restoreVerts, applyElementTransform, regionOf,
         remapElements }
  from '../core/edit.js';
import { measureLabels } from '../core/measure.js';

/**
 * 🔴 **鋼筆鎖角度時，方向只能落在幾度的倍數。**
 *
 * ⭐ **45 度是 Illustrator 的 Shift**，⛔ 不是我挑的 ——
 * 它給的是水平／垂直／四條斜的，共 8 個方向。
 * ⚠ **這只是預設值** —— 工具列有欄位可以改（kang 2026-08-29 要的：
 * 「我是希望角度可以輸入數值」）。做六角形打 30、做十二角打 15。
 */
const PEN_SNAP_DEG = 45;

const TAP_MOVE = 8;      // px
const TAP_TIME = 450;    // ms

/**
 * 「快點兩下」的門檻。
 *
 * ⚠ **`DOUBLE_TAP_MOVE` 比 `TAP_MOVE` 鬆**：兩下是兩次獨立的按下，
 * 手指本來就會偏一點；而 `TAP_MOVE` 管的是**同一次按下**中途有沒有移動，
 * 那件事嚴格得多。⛔ 不要為了「少一個常數」把兩者合用。
 */
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_MOVE = 16;   // px

/**
 * 🔴 **「畫線／點選」是主鍵那一顆，其餘的鍵不歸刀具管。**
 *
 * `PointerEvent.button === 0` ＝ 桌機左鍵，也是**觸控與觸控筆的主要接觸點**
 * （兩者按下時都回 0）—— 所以一個常數同時涵蓋三種輸入，
 * ⛔ 不必為 `pointerType` 各寫一段（坑第 31 條）。
 *
 * ⚠ 刀具模式下右鍵是**轉視角**、中鍵是**縮放**（見 `scene.js` 的
 * `setDrawInput()`），那兩顆按下去刀具要當作沒看到。
 */
const DRAW_BUTTON = 0;

/**
 * 🔴 **面數超過這個就不問「指到哪個面」**（hover 專用）。
 *
 * ── 這個數字是量出來的，⛔ 不是猜的 ────────────────────
 * 【實證 · 沙箱量的】`nearestFace()` 每次呼叫的成本（它內部每次都跑
 * `computeNormals()`，所以是 O(面數)，而且是線性的）：
 *
 * | 面數 | 每次 | 佔一幀（16.7ms） |
 * |---|---|---|
 * | 512 | 0.32 ms | 1.9% |
 * | 1922 | 1.04 ms | 6.2% |
 * | 3042 | 1.69 ms | 10.1% |
 * | 4610 | 2.40 ms | 14.4% |
 * | 8706 | 4.50 ms | 26.9% |
 *
 * 換算下來大約 **0.52 µs／面**。給 hover 的預算訂 **2 ms**（一幀的 12%），
 * 換算是 3846 面 —— **取 3500 留一點餘裕**。
 *
 * ⚠ **`VERT_DOTS_MAX = 5000` 是猜的**（日誌自己註明「沒有量過」）——
 * ⛔ 這一個不要再犯同一個病。
 *
 * ⭐ **點與邊不受這條限制**：點是 0.089 ms（8064 個點），
 * 邊是 1.6 ms（16768 條），兩個都遠比面便宜。
 *
 * ⚠ **平板不必納入考量** —— 手指沒碰到螢幕就沒有 hover 事件，
 * 這條路在平板上根本不會被走到。
 */
const HOVER_FACE_MAX = 3500;

/**
 * 點多近才算點到那條邊，單位 px。
 * 觸控要放寬 —— 手指比游標粗得多，這跟平面規劃器的 HGRAB
 * （桌機 2px／觸控 14px）是同一件事。
 */
const EDGE_GRAB_PX = 14;
const EDGE_GRAB_PX_TOUCH = 26;

/**
 * 🔴 **參考線吸附的容許距離，單位 px**（第 2 階段，2026-09-01）。
 *
 * ⚠ **⛔ 這個數字是我挑的，⛔ 不是量出來的** —— 挑 8 的依據是
 * 它跟上面 `TAP_MOVE`（8px，「這算輕點還是拖」的門檻）同一個量級，
 * 而那一個是 kang 實測過手感的。
 * 🔴 **⏳ 要請 kang 實測是不是「太黏」或「吸不到」再調** ——
 * ⛔ 不要為想像中的數字辯護〔鐵律：推論不是權威事實〕。
 *
 * ⭐ **⛔ 桌機與觸控⛔ 沒有分兩個值**（跟 `EDGE_GRAB_PX` 不一樣）：
 * 那一個要的是「手指點得到一條細線」，而這一個是
 * **拖到附近會不會自己貼上去** —— 手指粗細跟它無關。
 */
const GUIDE_SNAP_PX = 8;

/**
 * 🔴 **「顯示點」一次最多標幾個點。**
 *
 * 超過就不畫，並且**講出來** —— ⛔ 硬畫下去讓平板卡死是最糟的做法。
 *
 * ⚠ **這個數字是猜的，沒有量過。** kang 2026-08-25 問「電腦不夠好
 * 會不會當機」時挑的：桌機幾乎確定沒問題（點是整批交給顯示卡的，
 * 成本遠低於模型本身的三角形），但**平板的顯示晶片弱很多，而沙箱
 * 連畫面都驗不了**。
 * → **等 kang 在平板上實測，照真實結果調**。⛔ 不要為想像中的數字辯護。
 */
export const VERT_DOTS_MAX = 5000;

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
     * 🔴 **刀具模式。** 開著時點畫面不是選東西，是**定切線的兩個端點**。
     *
     * kang 2026-08-25：「刀具我是想要是**自由切**」——
     * 切一刀要打數值，這一顆是照你在畫面上點的兩個位置切。
     *
     * ⚠ **再按一次按鈕就取消**（kang 選的，跟貼合同一個做法）——
     * 平板沒有 Esc，⛔ 不可以只給鍵盤的出路。
     */
    this.knifeMode = false;

    /**
     * 🔴 **一筆畫：按住拖過表面，交點自動變成切點**（kang 2026-08-26 批准）。
     *
     * ⭐ **兩種輸入並存，⛔ 不做成模式切換** —— 底下 `pointerup` 那道
     * `if (dist > TAP_MOVE || dt > TAP_TIME) return;` **本來就分得出**
     * 「輕點」與「拖曳」，拖曳目前只是被丟掉，接起來就好。
     * 同一次切線裡兩種還可以混用（先拖一段，再輕點補幾個精準的位置）。
     *
     * 這裡只存**取樣**（物件本地座標）。把它變成切點是
     * `core/stroke.js` 的事，而且**只在放開手的那一刻算一次** ——
     * `nearestFace()` 是 O(面數)，⛔ 絕對不可以放進 `pointermove`（坑第 22 條）。
     */
    this._stroke = null;

    /**
     * 上一次刀具輕點的時間與位置，用來認「快點兩下」。
     *
     * ⚠ **慢慢再點同一處還是「取消最後一點」，一格都沒變**（kang 拍板）——
     * 快慢是唯一的差別，所以只需要記一個時間。
     */
    this._lastKnifeTap = null;

    /**
     * 🔴 **吸中點：切點自動落在邊的正中間。**
     *
     * ⚠ **開關要有兩條路**（kang 2026-08-26 拍板）：桌機按 `Shift`，
     * 或按工具列那顆開關 —— **平板沒有 Shift 鍵**，
     * 只做 Shift 等於那一項在平板上不存在。
     * 〔跟「框選做成模式不做成 Shift＋拖曳」同一個理由〕
     */
    this.knifeSnapMid = false;

    /**
     * 🔴 **鋼筆模式**（2026-08-29 加）。開著的時候，點畫面⛔ 不是選物件，
     * 而是**在地板上放錨點**。
     */
    this.penMode = false;
    /**
     * 🔴 **參考線模式**（2026-08-31 加）。開著的時候⛔ 不拖物件
     * （gizmo 收起來），控制列那一組才出得來。⚠ 第 1 階段⛔ 還不能點線。
     */
    this.guideMode = false;
    /** 下一個錨點強制是尖角（工具列那顆「尖角」切換鈕） */
    this.penCorner = false;
    /**
     * 🔴 **鎖角度**（kang 2026-08-29 要的）。
     *
     * > **他的原話：「按 SHIFT..可以是限制角度的線..而不是自由角度的線..
     * > 　這樣在作造型時..角度某些狀況下才能互相平行」**
     *
     * ⚠ **兩條路都算數**：這顆開關，或桌機按著 `Shift` ——
     * 跟 `吸中點` 完全同一個做法（**平板沒有 Shift，開關是唯一的路**）。
     */
    this.penSnapAngle = false;
    /**
     * 鎖角度時，方向只能落在幾度的倍數。**工具列那個欄位寫進來。**
     * ⭐ 預設 45（Illustrator 的 Shift）；做六角形要 30、做八角形要 45。
     */
    this.penSnapDeg = PEN_SNAP_DEG;
    /**
     * 🔴🔴 **不封口**（kang 2026-08-30 拍板的第 ③ 件，2026-08-31）。
     *
     * 開著的時候這支鋼筆畫的是**一條線**，⛔ 不是一個圍起來的形狀 ——
     * 收尾之後拿去做**板**（沿線加厚）或**牆**（沿線立起來）。
     *
     * ⚠ **這裡只管兩件看得見的事**：**回到第一個點⛔ 不接起來**、
     * **預覽⛔ 不畫閉合那一段**。
     * 🔴 **幾何那一半⛔ 不在這裡** —— 權威版是 `prim.js` 的 `BUILDERS.pen`，
     * 它照物件身上的 `src.open` 決定走哪條路。
     * ⭐ 所以 `takePen()` 交出去的東西**一個字都沒變**。
     */
    this.penNoClose = false;
    /** 正在畫的那一條：{ a:[], hi:[], ho:[] }，⛔ 還沒變成物件 */
    this._pen = null;
    /**
     * 🔴🔴 **已經畫完的【其他】路徑**（第 3 階段「做洞」，2026-08-30）。
     * ⛔ **不含**正在畫／正在改的那一條 —— 那一條永遠是 `_pen`。
     *
     * ⭐ **為什麼這樣分，⛔ 不是存成一個陣列加一個索引**：
     * 既有的每一支（`_penAddAnchor`／`_penSetLastHandle`／`penUndo`／
     * 命中測試／預覽）**都是對 `_pen` 操作的** ——
     * 保持「目前這一條就叫 `_pen`」，那些**一行都不用改**。
     * 🔴 要改別條時就**把兩者交換**（`_penSwitchTo()`），
     * ⛔ 不是到處加「現在是第幾條」的判斷。
     * 〔坑第 31 條：與其讓兩條路對齊，不如換一個只有一條路的定義〕
     */
    this._penDone = [];
    /** 按下去的當下記起來的東西（⛔ 不可以事後從 e 補算，鍵與位置都是初始狀態） */
    this._penDown = null;
    /** 上一次鋼筆輕點的時間與位置，用來認「快點兩下」＝ 收尾 */
    this._lastPenTap = null;
    /** 游標底下那個錨點的索引（⛔ 沒有就是 −1）。⭐ 指到會變大 */
    this._penHover = -1;
    /** 這一次按下去是不是壓在第一個錨點上（＝ 要閉合） */
    this._penClosing = false;
    /**
     * 🔴 **這一段曲線已經「確定」了嗎**（kang 2026-08-29 第四次退回定的）。
     *
     * > **他的原話：「左鍵重疊了曲線與第三點的確認..
     * > 　因此要變成滑鼠右鍵來確定曲線..左鍵是第三點的位置確定」**
     *
     * ⚠ **⛔ 這 ⛔ 不是「還沒存下來」** —— 錨點與把手放開手就定案了。
     * 它管的是**畫面**：確定之前，那條線會一直跟著游標跑
     * （看起來「還在開放狀態」）；**確定之後就停住**，
     * 使用者才能安心去找下一個點的位置。
     *
     * 🔴 **放下一個點時自動解除** —— 新的一段本來就又是開放的。
     */
    this._penParked = false;

    /**
     * 🔴🔴 **`改點` 模式**（第 2 階段，kang 2026-08-29 拍板）。
     *
     * > **開著 ＝ 點錨點是「選它、拖它」；關著 ＝ 維持原本的畫法。**
     *
     * ⚠ **⛔ 為什麼要一顆看得見的按鈕，不用「點中間的錨點就自動切」**：
     * 【實證】`pointerdown` 那三支已經把**第 0 個**（閉合）與**最後一個**
     * （轉尖角）吃掉了，中間那些**掉進 `else` 會在原地放一個新點**。
     * 中間那些也拿去當選取的話，**路徑附近就再也放不了新點**。
     * ⭐ 跟 `尖角` 那顆同一條路：**一顆看得見的切換鈕，桌機平板同一套。**
     */
    this.penEdit = false;
    /** `改點` 模式下選到的錨點索引（⛔ 沒有就是 −1）。把手只畫這一個的 */
    this._penSel = -1;
    /** 正在拖錨點：{ i, gx, gz, ax, az } —— 按下去當下的游標與錨點座標 */
    this._penDragA = null;
    /** 正在拖把手：{ i, side:'in'|'out' } */
    this._penDragH = null;

    /**
     * 🔴 **「點畫面不是為了選物件」的模式** —— gizmo 與它的輔助線要收起來。
     *
     * ⚠ **抽成一個 getter 是刻意的**：加刀具的時候發現這個判斷
     * （`!seamMode && !mateMode`）**散在五個地方**，而第四種模式一來
     * 就要五處都記得改 —— 那是靠紀律，遲早漏掉一處，
     * 而漏掉的症狀是「箭頭擋在畫面中間」這種很難聯想到原因的東西。
     * 〔坑第 31 條：與其讓幾條路對齊，不如換一個只有一條路的定義〕
     */

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

    /**
     * 編輯模式（第 6 期第一刀）。開著時點畫面選的是**物件裡的點／邊／面**，
     * 而 gizmo 掛在選到的那個元素上，拖它就是拉那個元素。
     *
     * ── 跟分片、貼合的差別 ────────────────────────────
     * 那兩個模式都把 gizmo **收起來**（箭頭會擋住要點的表面）。
     * 編輯不能收 —— 它就是要用 gizmo 來拉。折衷做法是：
     * **還沒選到元素之前不掛**，選到了才掛到那個元素上。
     * 所以進入模式的當下畫面是乾淨的，可以放心點。
     */
    this.editMode = false;
    /** 'auto' | 'vertex' | 'edge' | 'face' —— 選取過濾器 */
    this.editFilter = 'auto';

    /**
     * 🔴 **指到哪就亮哪（hover）**：游標底下的那個元素，⛔ 不是選取。
     *
     * kang 2026-08-26 提出並拍板。它補的是坑第 21 條那個洞 ——
     * 他做方塊 12 條邊圓角時「就是不行」，病因是**漏選一條看不出來**。
     *
     * 🔴 **唯一的硬規則：算它一定要呼叫 `pickElement()` 本人。**
     * ⛔ 不可以另寫一套「找最近的」—— 兩套的話畫面說會選到 A、
     * 按下去選到 B，那**比沒有提示更糟**（坑第 31 條）。
     *
     * ⚠ **`_hoverRaf` 是節流用的**：`pointermove` 一秒可以來上百次，
     * 而算一次最貴要 2ms —— **一幀最多算一次**就夠了（坑第 22 條）。
     */
    this._hover = null;
    this._hoverRaf = 0;
    this._hoverAt = null;

    /**
     * 🔴 **目前選到的子元素，有順序的陣列。順序即 active（最後一筆）。**
     *
     * ── 為什麼是陣列而不是一個欄位 ────────────────────────
     * 物件層本來就是這個寫法（`ids` 有順序、`active` 取最後一個），
     * 而 Blender 的 select history 也是「最後一筆就是 active」。
     * 好處是**取消選取時自然退回上一個**，不必寫任何特別處理。
     *
     * ⚠ **`editSel` 保留成 getter，回傳最後一筆。**
     * 外面有五個地方在讀它（`main.js` 四處、`toolbar.js` 一處），
     * 而它們要的一直都是「active 那一個」—— 改成 getter，那五處一行都不用動。
     *
     * ⚠ **同一次多選裡型別必須一致**（kang 2026-08-24 拍板）。
     * 過濾器本來就是四選一互斥的，而混型別會讓法向、中心、面板、
     * 擠出把關全部要多處理一種情況 —— 而想不出真的會混選的場景。
     * 點到不同型別就當成**重新開始**。
     */
    this.editSels = [];

    /**
     * 中心（變換三個概念的第三個）：`'median'` ＝ 全部的重心、
     * `'active'` ＝ 最後點的那一個元素自己的重心。
     * **單選時兩者是同一個點**，所以它是跟多選一起才有意義的。
     */
    this.editPivot = 'median';

    /**
     * 🔴 **顯示點的開關**（kang 2026-08-25 要的）。
     * 預設**開**：「邊上加點」加出來的點沒有它就等於看不見。
     * ⚠ 而開關本身就是效能的保險 —— 覺得卡就關掉，不必等人修。
     */
    this.showVertexDots = true;

    /**
     * 🔴 **標尺寸：把量到的數字畫在 3D 畫面上**（量測第 2 步）。
     *
     * kang 2026-08-27 拍板做成**三段可切換**，⛔ 不是開關 ——
     * 他的原話：「**是不是有一個選項可以變換標示..不然一起出現可能會很擠**」。
     *
     * | 值 | 選 32 條邊時畫面上 |
     * |---|---|
     * | `'off'` | 一個字都沒有 |
     * | `'total'`（預設）| **1 個字**在重心：「32 條邊／總長 156.83 cm」|
     * | `'each'` | **32 個字**，每條邊中間各一個：「4.90 cm」|
     *
     * 預設 `'total'` 也是 kang 選的：**永遠只有一個字，不可能擠**，
     * 而且一選到東西就看得到 —— ⛔ 預設關掉的話這個功能等於不存在（坑第 21 條）。
     */
    this.measureMode = 'total';

    /**
     * 🔴 **量圓：把選到的那一圈當成圓，報半徑／段數／弦長**（量測第 4 步）。
     *
     * ⛔ **預設關，而且它一定要是開關** —— 自動顯示就等於**自動判斷
     * 「這一圈是不是圓」，而那個判斷目前無解**：正多邊形的頂點永遠共圓、
     * 矩形的四個角也永遠共圓〔實證：方塊每個面都被判成圓〕。
     * 自動報的話會在方塊的四條邊上報一個半徑 36.06 的圓 —— **那是誤報**
     * （坑第 18 條：誤報會讓人學會忽略整個欄位）。
     *
     * ⭐ **開關就是繞過那個判準的方式**，跟 `變成正圓` 同一招：
     * **使用者按了它又選了這一圈，就表示他要問這一圈的圓。**
     */
    this.showCircle = false;

    /**
     * gizmo 掛的那個替身。
     *
     * TransformControls 只能掛 Object3D，而「一個頂點」不是 Object3D。
     * 所以放一個空的 Object3D 在元素的重心上，拖它、讀它的位移、
     * 再把位移寫回頂點座標。
     *
     * ⚠ **它是 node 的子節點，不是場景的子節點。** 這樣 `_proxy.position`
     * 直接就是網格自己的座標系（node 帶著 obj.pos / rot / scale），
     * 不必每次自己做 worldToLocal —— 也就不會有「忘了處理縮放」那種錯。
     */
    this._proxy = new THREE.Object3D();
    this._proxy.name = 'editProxy';

    /**
     * 🔴 **箭頭朝哪**：`'world'` ＝ 世界 XYZ（原本唯一的選擇）、
     * `'normal'` ＝ 選到的那個元素自己的座標系（Z 是法向）。
     *
     * 「擠出好像沒用」「斜面推不動」「拉不出梯形」根源都是**只有世界 XYZ**。
     * 變換其實是三個正交的概念 —— **種類 × 方向 × 中心**，這是「方向」。
     * 〔`外部參考-Blender編輯.md` 第 3 節〕
     *
     * 中心見 `editPivot`（多選做出來之後才有意義，2026-08-24 補上）。
     */
    this.editSpace = 'world';

    /**
     * 🔴 **一次拖曳的初始狀態**（Blender 那個 `iloc` 的同一件事）。
     *
     * `{verts, base, start:{pos,quat}, cancelled}` —— 拖曳開始時拍一份，
     * 之後**每一幀都從這份重算**，不是疊在上一幀的結果上。
     *
     * 舊做法是增量累加，而它是被逼出來的：頂點一動元素重心也跟著跑，
     * 拿絕對值算會每幀重複套用一次，一拖就飛出去。
     * 記了初始值之後那個問題自動消失，而且**取消、旋轉縮放、打數字
     * 全部變成免費的**。
     *
     * 放手之後刻意**不清掉** —— 數值輸入框要拿它把精確數字套回初始座標。
     * 換選取、換方向、換種類才清。
     */
    this._drag = null;

    this._initGizmo();
    this._initPointer();
    this._initEditKeys();
  }

  _initGizmo() {
    const v = this.view;
    const tc = new TransformControls(v.camera, v.canvas);
    this.tc = tc;                 // 三支 setSnap*() 會用到，必須先指派

    tc.setSize(isTouch() ? 1.5 : 1.0);
    /**
     * ⚠ **這三個預設值⛔ 不可以動** —— 2026-08-31 拆開之前，
     * 一支 `setSnap(1)` 就是設出這三個值（旋轉 15 度、縮放 0.05 寫死在裡面）。
     * 拆開只是讓它們**各自開得了關、填得了數字**，⛔ 不是改預設行為。
     */
    this.setSnap(1);              // 移動 1cm
    this.setSnapRot(15);          // 旋轉 15 度
    this.setSnapScale(0.05);      // 縮放 0.05 倍
    /**
     * 🔴 **參考線吸附預設是【關】的**（第 2 階段，2026-09-01）。
     * ⚠ 理由是**⛔ 沒有參考線的人不該感覺到任何改變** ——
     * 而且它跟上面那個格距⛔ 不一樣：格距是一直都在的通用行為，
     * 這一個是「我特地放了一條線」之後才要的。
     */
    this.snapGuides = false;
    /** 上一次吸中哪幾條（⛔ 只給高亮比對用，⛔ 不是真相來源） */
    this._guideHits = null;

    tc.addEventListener('dragging-changed', e => {
      v.orbit.enabled = !e.value;
      if (e.value) {                             // 按下去 → 拍一份初始狀態
        if (this.editSel) this._beginEditDrag();
        return;
      }
      if (this.editSel) {                        // 放手 → 記一步 Undo
        /**
         * 拖到一半按 Esc 取消過的話，座標已經被還原了，
         * 這一下**不能再記一步 Undo** —— 記了就會多出一步「什麼都沒做」，
         * 而使用者按 Undo 會以為壞掉了。
         */
        if (this._drag && this._drag.cancelled) { this._rebaseProxy(); return; }
        this._writeBackEdit(true);
      } else {
        this._writeBack(true);
      }
    });

    tc.addEventListener('objectChange', () => {
      if (this.editSel) this._writeBackEdit(false);
      else this._writeBack(false);
    });

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
    /**
     * ⚠ **一定要問 `tc.object`，不能問物件的 node。**
     * 編輯模式下 gizmo 掛的是替身，而替身**自己帶著方向**
     * （方向切到「法向」時），跟 node 的旋轉不是同一個。
     * 問錯對象的症狀是 X／Y／Z 三個字跟箭頭錯開 ——
     * 而那正是最需要看清楚哪根是哪根的時候。
     */
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

    /**
     * ⚠ **順序：先寫回、再吸附。** `worldBounds(obj)` 是拿 `obj.matrix()`
     * 去轉外框的，而 `matrix()` 讀的就是上面那三行剛寫進去的值 ——
     * 🔴 **⛔ 不可以把吸附挪到前面**，那樣算到的會是**上一幀**的外框。
     */
    this._applyGuideSnap(node, obj, committing);

    if (this.hooks.onTransform) this.hooks.onTransform(committing);
  }

  /**
   * 🔴 **把物件吸到參考線上**（第 2 階段，2026-09-01）。
   *
   * ── 吸物件的哪裡：**邊緣 ＋ 中心** ────────────────────
   * `worldBounds(obj)` 的 `min`／`center`／`max`，每個軸各挑最近的一條。
   * 🔴 **⛔ 絕對不可以拿 `obj.pos` 去吸** —— 網格不一定以原點為中心
   * （折板、布林結果、陣列都可能偏一邊），拿 `pos` 對齊
   * **畫面上看起來就會沒對齊**。〔`align.js` 檔頭已經釘死過這個坑〕
   *
   * ── 容許距離用**螢幕像素** ─────────────────────────
   * 見 `scene.js` 的 `pxPerWorld()`。
   *
   * ⚠ **只在【移動】模式吸** —— 旋轉與縮放時外框每一幀都在變形，
   * 吸上去會變成「東西自己抖」，而使用者⛔ 不會知道是吸附在動它。
   */
  _applyGuideSnap(node, obj, committing) {
    if (!this.snapGuides || this.tc.getMode() !== 'translate') {
      this._reportGuideHits(null);
      return;
    }
    const guides = this._doc && this._doc.guides;
    if (!guides) { this._reportGuideHits(null); return; }

    const b = worldBounds(obj);
    if (b.isEmpty()) { this._reportGuideHits(null); return; }

    /** 世界單位的容許值 ＝ 像素容許值 ÷（像素／世界） */
    const center = b.getCenter(new THREE.Vector3());
    const pxPer = this.view.pxPerWorld ? this.view.pxPerWorld(center) : 0;
    if (!(pxPer > 0)) { this._reportGuideHits(null); return; }
    const tol = GUIDE_SNAP_PX / pxPer;

    const { delta, hits } = guideSnapDelta(b, guides, tol);

    if (delta.x || delta.y || delta.z) {
      node.position.x += delta.x;
      node.position.y += delta.y;
      node.position.z += delta.z;
      obj.pos.copy(node.position);
    }

    /**
     * ⚠ **放手的那一下要把高亮收掉** —— 留著的話畫面上會有一條
     * 一直亮著的線，而使用者會以為那是另一種狀態。
     */
    this._reportGuideHits(committing ? null : hits);
  }

  /**
   * 通知畫面「現在吸著哪幾條」。
   *
   * ⚠ **⛔ 一樣就不要重送** —— `objectChange` 一秒會來幾十次，
   * 每次都重建那幾條高亮線是「每幀迴圈裡的東西」（鐵律四），
   * 而且畫面會閃。
   */
  _reportGuideHits(hits) {
    const next = hits && hits.length ? hits : null;
    if (sameGuideHits(this._guideHits, next)) return;
    this._guideHits = next;
    if (this.hooks.onGuideSnap) this.hooks.onGuideSnap(next);
  }

  /**
   * 鎖著視角、而這一次拖曳**看起來就是想轉視角** → 講一句（**同一次拖只講一次**）。
   *
   * ── 🔴🔴 【哪一顆鍵算「想轉視角」】要問 OrbitControls，⛔ 不可以寫死 ──
   * 【實證 2026-09-01，我開的實測清單第 9 項本來會直接失敗】
   * 第一版寫死「只看**左鍵**」，⚠ 而**刀具與鋼筆模式下轉視角的鍵是右鍵**
   * （`setDrawInput()` 把 `RIGHT` 換成了 `ROTATE`）——
   * 所以在那兩個模式下鎖著、右鍵怎麼拖都**不會有任何訊息**。
   * ⭐ 正解是**直接問 `orbit.mouseButtons` 現在誰是 `ROTATE`**，
   * ⛔ 不要自己記第二份〔同一條規則只寫一次，在程式上一樣成立〕。
   * ⇒ 這樣也**⛔ 不必再排除 `penMode`／`_stroke`**：畫線用的是左鍵，
   * 而那時候左鍵**本來就不是 `ROTATE`**，自然不會誤報。
   *
   * ── ⚠ 還要排掉哪些「其實不是想轉視角」的拖曳 ────────────
   * · 在拖 gizmo（`tc.dragging`）—— 那是在搬東西
   * · 框選模式 —— 空白處拖是拉框，⛔ 本來就不轉
   *   （⚠ 框選也會擋旋轉，但那⛔ 不是「視角鎖定」，講出來會是誤報）
   * ⇒ **⛔ 排錯的代價是「誤報」，而誤報比漏報更糟**（鐵律三）。
   *
   * ⚠ **要移動超過 `TAP_MOVE` 才算** —— 點一下（選取／取消選取）
   * ⛔ 不是想轉視角，那樣會變成點哪裡都跳訊息。
   */
  _tellIfViewLocked(e) {
    if (!this.view.viewLocked) return;
    const d = this._down;
    if (!d || d.told) return;
    if (this.tc.dragging || this.marqueeMode) return;

    const mb = this.view.orbit.mouseButtons;
    const rotateBtn = mb.LEFT === THREE.MOUSE.ROTATE ? 0
      : mb.MIDDLE === THREE.MOUSE.ROTATE ? 1
        : mb.RIGHT === THREE.MOUSE.ROTATE ? 2 : -1;
    if (d.button !== rotateBtn) return;

    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < TAP_MOVE) return;
    d.told = true;
    if (this.hooks.onViewLockedDrag) this.hooks.onViewLockedDrag();
  }

  _initPointer() {
    const cv = this.view.canvas;

    cv.addEventListener('pointerdown', e => {
      /**
       * 🔴 **哪一顆鍵，在按下去的當下就記起來。**
       *
       * ⚠ **⛔ 不可以等到 `pointerup` 再問** —— 那正是
       * 「`TransformControls.axis` 是『滑鼠現在停在哪根把手上』」踩過的坑
       * （2026-08-25）：**鍵也是初始狀態的一部分**。
       *
       * 🔴 **這一條是 kang 2026-08-26 實測抓到的**：原本四個監聽
       * **完全沒有分是哪一顆鍵**，所以右鍵拖的時候 OrbitControls 在轉視角、
       * 一筆畫的取樣器**同時也在記線** —— 他的原話：「跟轉視角功能撞一起」。
       * ⚠ 沙箱驗不了這種事：資料層算出來的切點完全正確，錯的是「誰該收這個手勢」。
       */
      this._down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };

      /**
       * 🔴 **第二根手指／第二顆鍵按下來 ＝ 這是轉視角，不是畫線。**
       *
       * ⚠ **平板上這一條才是重點**：兩指轉視角時，**第一根手指早就
       * 開始畫線了** —— 不砍掉的話轉個視角就會憑空多出一條切線。
       * 〔桌機的對應情形：左鍵按著再按右鍵〕
       *
       * ⭐ **⛔ 不用一個「現在有幾根手指」的集合去擋** —— 那種集合
       * 只要漏收一次 `pointerup` 就會永遠卡住（症狀是「突然就畫不了了」）。
       * 這裡問的是「**畫到一半又有人按下來**」，**它自己會清乾淨**。
       */
      if (this._stroke) {
        this._stroke = null;
        /**
         * ⚠ 叫 `abandoned` 不叫 `cancelled`，是為了跟 `this._drag.cancelled`
         * （拖曳中按 `Esc` 反悔）分開 —— 兩件不同的事用同一個字，
         * 下一個人讀到會以為是同一回事。
         */
        this._down.abandoned = true;
        if (this.hooks.onKnifeStrokeMove) this.hooks.onKnifeStrokeMove(null);
      }

      /**
       * 🔴 **刀具模式：按下主鍵才開始記一筆畫。**
       * ⚠ 這時候還不知道使用者要輕點還是要拖 —— 兩種都先當成拖，
       * 放開手再用 `TAP_MOVE`／`TAP_TIME` 分。
       * ⛔ 不要在這裡就決定，那等於逼使用者先宣告他要做哪一種。
       *
       * ⭐ `button === 0` 同時涵蓋**桌機左鍵**與**觸控／觸控筆的主要接觸點**
       * （兩者按下時都是 0）—— ⛔ 不必為 `pointerType` 各寫一段（坑第 31 條）。
       */
      if (this.knifeMode && !this.tc.dragging && e.button === DRAW_BUTTON) {
        const h = this._surfaceHit(e.clientX, e.clientY);
        this._stroke = h ? { obj: h.obj, node: h.node, pts: [h.pLocal], world: [h.world] } : null;
      }
      /**
       * 🔴 **鋼筆：按下去先記起來，⛔ 這時候還不決定是「點」還是「拖」。**
       * ⚠ 判準跟刀具同一條（`TAP_MOVE`／`TAP_TIME`），
       * ⛔ 不要在這裡就決定 —— 那等於逼使用者先宣告他要做哪一種。
       */
      if (this.penMode && !this.tc.dragging && e.button === DRAW_BUTTON) {
        const g = this._groundAt(e.clientX, e.clientY);
        this._penDown = g
          ? { x: e.clientX, y: e.clientY, t: performance.now(), g }
          : null;
        /**
         * 🔴🔴 **點在「按下去的當下」就出現，⛔ 不是等到放開手。**
         *
         * 【kang 2026-08-29 回報】舊版在 `pointerup` 才建錨點，
         * 結果**按下去畫面上什麼都沒有** —— 他的原話：
         * 「**我不先點一次滑鼠怎麼產生點..怎麼拉線**」。
         *
         * ⚠ **那 ⛔ 不是他不懂手勢** —— Illustrator 也是按下就放點，
         * 但**它按下的那一刻點就畫出來了，所以「拖」有東西可拉**。
         * **漏的是回饋，⛔ 不是手勢。**
         *
         * ⭐ 先當尖角放下去；拖的話 `pointermove` 再把把手補上。
         */
        /**
         * 🔴🔴 **`改點` 模式完全接管這一下，⛔ 之後一個新點都不放。**
         *
         * ⚠ **一定要先把 `_penDown` 清掉** —— 留著的話 `pointermove`
         * 會掉進「正在拖最後一個錨點的把手」那一支，
         * **把已經畫好的東西改掉，而畫面上看起來只是在拖**。
         * 〔2026-08-29 第四次退回的病因就是 `_penDown` 沒被清掉〕
         */
        if (this.penEdit) {
          this._penDown = null;
          this._penDownEdit(e, g);
        }
        /**
         * 🔴 **壓在第一個錨點上 ＝ 要閉合，⛔ 這一下不放新點。**
         *
         * ⭐ **這是 Adobe 官方文件寫的收尾方式**（2026-08-29 讀原文）：
         * > 「Position the Pen tool over the first anchor point, which appears
         * > hollow. A small circle appears next to the Pen tool pointer…
         * > Select or drag to close the path.」
         *
         * ⚠ **⛔ 不是先放點再退掉** —— 那樣中間會閃一下多出來的點。
         */
        else if (g && this._penHitAnchor(e.clientX, e.clientY) === 0
            && this.penCount >= 3) {
          /**
           * 🔴🔴 **開著「不封口」時⛔ 不接起來，而且要講原因。**
           *
           * ⚠ **⛔ 不可以安靜地放一個新點上去** —— 那會在起點上疊一個
           * 看不出來的重複點（坑第 21 條）。
           * ⭐ **⛔ 也不做「接起來變成一圈框」** —— 閉合 ＋ 往兩側 ＝ 一圈框，
           * 那是 kang 2026-08-30 標 ⏭ 刻意不做的東西，
           * 而且它跟 `內縮` 做得出來的重疊〔功能之間的定位不可以互相模糊〕。
           */
          if (this.penNoClose) {
            if (this.hooks.onPenNoClose) this.hooks.onPenNoClose();
          } else {
            /**
             * ⚠ **要記下按下的位置** —— 閉合也可以用拖的（見 `pointerup`），
             * 而把手就是「按下的位置 → 放開的位置」。
             */
            this._penClosing = { x: e.clientX, y: e.clientY, g };
          }
        } else if (g && this.penCount >= 1
                   && this._penHitAnchor(e.clientX, e.clientY) === this.penCount - 1) {
          /**
           * 🔴 **壓在「剛畫好的那個點」上 ＝ 要把它轉成尖角**（曲線接直線）。
           * ⚠ **⛔ 這一下不放新點** —— 跟閉合同一個道理。
           */
          this._penConvert = { x: e.clientX, y: e.clientY, g };
        } else if (g) {
          this._penClosing = false;
          /** ⭐ 新的一段本來就又是開放的 */
          this._penParked = false;
          /** 🔴 鎖角度：把「上一個錨點 → 這裡」的方向吸到 45 度的倍數 */
          const sp = this._penSnapPoint(g.x, g.z, e);
          this._penDown.g = { x: sp.x, z: sp.z, world: this._penDown.g.world };
          this._penAddAnchor(sp.x, sp.z, 0, 0);
          if (this.hooks.onPenAdd) this.hooks.onPenAdd(this.penCount);
        }
      }
      if (this.marqueeMode && !this.tc.dragging) {
        const r = this._toCanvasPx(e.clientX, e.clientY);
        this._marq = { ax: r.x, ay: r.y, bx: r.x, by: r.y };
        // 抓住指標，這樣拖出畫布外再放開也收得到事件
        if (cv.setPointerCapture) { try { cv.setPointerCapture(e.pointerId); } catch (err) { /* 舊瀏覽器沒有就算了 */ } }
        this._drawMarquee();
      }
    });

    cv.addEventListener('pointermove', e => {
      /**
       * 🔴🔴 **鎖著視角還想拖著轉 → 一定要講一句**（2026-09-01）。
       *
       * ⚠ **⛔ 安靜地沒反應是最糟的做法** —— 使用者過一陣子會忘記自己鎖了，
       * 然後「怎麼轉不動」會被當成**程式壞了**〔坑第 21 條那一類〕。
       * ⭐ 那顆按鈕亮著是**看得到的**，但講一句是**問得到的**，兩個都要。
       */
      this._tellIfViewLocked(e);

      /**
       * 🔴 **鋼筆也要看得見自己畫到哪** —— 游標那一段要跟著跑，
       * 而**按住拖的時候要看得到把手把線拉彎**，
       * ⛔ 否則「拖出圓滑」這件事使用者完全感覺不到（坑第 21 條）。
       */
      if (this.penMode && this._pen && this._pen.a.length) {
        const g = this._groundAt(e.clientX, e.clientY);
        if (!g) { /* 相機在地板底下，打不到 */ }
        /** 🔴 `改點`：拖錨點／拖把手／只是指著看 —— 三件事都在那一支裡 */
        else if (this.penEdit) { this._penMoveEdit(e, g); }
        else if (this._penConvert) {
          /**
           * 🔴 **在剛畫好的那個點上拖出把手時，要看得見那根把手在長。**
           * ⚠ ⛔ 少了這一段又是「調一條看不見的線」——
           * 那個病 2026-08-29 已經踩過一次（閉合那一輪），⛔ 不要再犯。
           * ⭐ **只改出把手，⛔ 不動進把手** —— 上一段一格都不能變。
           */
          const cvi = this.penCount - 1;
          const hh = this._snapIf(e,
            g.x - this._penConvert.g.x, g.z - this._penConvert.g.z);
          this._pen.ho[cvi * 2] = hh.dx;
          this._pen.ho[cvi * 2 + 1] = hh.dz;
          const av = this._penWorld(cvi);
          this._drawPenPreview(null,
            new THREE.Vector3(av.x + hh.dx, 0, av.z + hh.dz), { handleAt: cvi });
        }
        else if (this._penClosing) {
          /**
           * 🔴🔴 **拖著閉合時，改的是【第一個錨點的進把手】，
           * ⛔ 絕對不是最後一個錨點的把手。**
           *
           * 〔kang 2026-08-29 第六次提，⛔ 又是我漏的〕
           * ⚠ **`pointerdown` 不管有沒有壓在第一個錨點，都會設 `_penDown`** ——
           * 所以舊版拖著閉合時會掉進下面那一支，去改**最後一個錨點**的把手。
           * 🔴 **後果**：他拖著要調「最後一點 → 第一點」那一段，
           * **結果被改的是「倒數第二點 → 最後一點」那一段**。
           * 他的原話：「第 4 點與第 5 點的曲線應該不能被控制..但是..是會被控制到的」。
           *
           * ⭐ **這一支一定要排在 `_penDown` 前面** —— 閉合時兩個都是真的。
           */
          const hc = this._snapIf(e,
            g.x - this._penClosing.g.x, g.z - this._penClosing.g.z);
          this._penSetFirstInHandle(hc.dx, hc.dz);
          /**
           * 🔴 **而且預覽要「連起來」畫** —— 否則他在調一條看不見的線。
           * 〔他的原話：「我看不到第 5 與第 1 點閉合的曲線」〕
           */
          /**
           * ⚠ **把手的端點是「游標所在」，⛔ 不是錨點自己**（那長度會是 0）。
           * 按下去的位置就在錨點上，所以「錨點 → 游標」正好就是這根把手。
           */
          const b0 = this._penWorld(0);
          this._drawPenPreview(null,
            new THREE.Vector3(b0.x + hc.dx, 0, b0.z + hc.dz),
            { closed: true, handleAt: 0 });
        }
        else if (this._penDown) {
          /**
           * 🔴 **正在拖：把手就是「按下去的位置 → 現在的位置」。**
           * ⭐ 曲線因此**拖的當下就彎**，⛔ 不是放開才知道。
           */
          const h = this._snapIf(e, g.x - this._penDown.g.x, g.z - this._penDown.g.z);
          this._penSetLastHandle(h.dx, h.dz);
          /**
           * ⚠ **鎖住之後預覽的把手也要畫在鎖住的位置**，
           * ⛔ 不可以還畫在游標上 —— 那會讓人以為沒鎖到。
           */
          const a0 = this._penWorld(Math.floor(this._pen.a.length / 2) - 1);
          this._drawPenPreview(null,
            new THREE.Vector3(a0.x + h.dx, 0, a0.z + h.dz));
        } else {
          const h = this._penHitAnchor(e.clientX, e.clientY);
          if (h !== this._penHover) {
            this._penHover = h;
            if (this.hooks.onPenHover) this.hooks.onPenHover(h, this.penCount);
          }
          /**
           * 🔴🔴 **鎖角度時，游標那一段的預覽也要畫在鎖住的位置。**
           *
           * 〔kang 2026-08-29 回報：「線段應該同步呈現被限制角度的方式..
           * 　這樣才能較準確的直觀操作」〕
           * ⚠ **舊版只在「按下去的那一刻」才鎖** —— 之前那條線還是直直指著
           * 游標，所以**使用者根本看不到點會落在哪**，等於要他盲射。
           * ⭐ 判準跟放點時**共用同一支 `_penSnapPoint()`**，
           * ⛔ 不各算一次 —— 預覽跟結果因此不可能不一樣（坑第 31 條）。
           *
           * ⚠ **hover 的判定仍然用原始游標位置**（上面那幾行）——
           * 「我指到哪個點」跟「線會落在哪」是兩件事。
           */
          let tip = g.world;
          if (!this._penParked) {
            const sp = this._penSnapPoint(g.x, g.z, e);
            if (sp.x !== g.x || sp.z !== g.z) tip = new THREE.Vector3(sp.x, 0, sp.z);
          }
          this._drawPenPreview(this._penParked ? null : tip);
        }
      }

      /**
       * 🔴 **一筆畫要看得見自己畫到哪** —— 沒有預覽就是「放開手才知道
       * 切到哪」（坑第 21 條：有時候看起來沒作用的操作要持續顯示它有沒有作用）。
       *
       * ⚠ **這裡只做 raycast，⛔ 不算切點** —— 算切點要跑 `nearestFace()`，
       * 那是 O(面數)，放進 `pointermove` 就是坑第 22 條。
       * 切點統一在放開手時算一次。
       */
      if (this._stroke) {
        const h = this._surfaceHit(e.clientX, e.clientY);
        /** ⚠ 只收同一個物件上的取樣：混著收會做出跨物件的線（改到沒在看的物件）*/
        if (h && h.obj === this._stroke.obj) {
          this._stroke.pts.push(h.pLocal);
          this._stroke.world.push(h.world);
          if (this.hooks.onKnifeStrokeMove) {
            this.hooks.onKnifeStrokeMove(this._stroke.world);
          }
        }
      }
      /**
       * 🔴 **hover：只在編輯模式、而且沒有正在做別的事的時候算。**
       * ⚠ 拖曳中（gizmo／框選／一筆畫）算它沒有意義，只是白花時間。
       */
      if (this.editMode && !this.tc.dragging && !this._stroke && !this._marq && !this._down) {
        this._queueHover(e.clientX, e.clientY);
      } else if (this._hover) {
        this._setHover(null);
      }

      if (!this._marq) return;
      const r = this._toCanvasPx(e.clientX, e.clientY);
      this._marq.bx = r.x; this._marq.by = r.y;
      this._drawMarquee();
    });

    /** 游標離開畫布 → 那個「指著」的狀態就不成立了，⛔ 不要留在畫面上 */
    cv.addEventListener('pointerleave', () => this._setHover(null));

    cv.addEventListener('pointercancel', () => {
      this._endMarquee(null, false);
      this._stroke = null;
      if (this.hooks.onKnifeStrokeMove) this.hooks.onKnifeStrokeMove(null);
    });

    cv.addEventListener('pointerup', e => {
      const d = this._down;
      this._down = null;
      const stroke = this._stroke;
      this._stroke = null;
      if (!d) return;

      const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      const dt = performance.now() - d.t;

      /**
       * 🔴 **一筆畫：拖得夠遠就是畫線，不是點選。**
       *
       * ⚠ 判準借用下面那道現成的 `TAP_MOVE` —— ⛔ 不要另外定一個門檻。
       * 兩個門檻遲早會不一致，而症狀是「有時候變成點選、有時候變成畫線」，
       * 使用者只會覺得這個工具不可靠（坑第 31 條）。
       *
       * ⚠ **`TAP_TIME` 不算在內**：慢慢地、仔細地描一條線是很正常的事，
       * 按太久就把它當成輕點會讓人白畫一次。
       */
      if (stroke && dist > TAP_MOVE) {
        if (this.hooks.onKnifeStrokeMove) this.hooks.onKnifeStrokeMove(null);
        if (this.hooks.onKnifeStroke) {
          this.hooks.onKnifeStroke(stroke.obj, stroke.pts, this._wantSnapMid(e));
        }
        return;
      }
      if (stroke && this.hooks.onKnifeStrokeMove) this.hooks.onKnifeStrokeMove(null);

      /**
       * 🔴 **被第二根手指／第二顆鍵砍掉的那一次，放開手也什麼都不做。**
       * ⚠ 少了這一條，「兩指轉視角」放開時會**憑空多一個切點**
       * （沒移動的話下面會把它當成輕點）。
       */
      if (d.abandoned) return;

      /**
       * 框選：拖得夠遠才算框選，否則當成一般的點一下。
       * 不分這一刀的話，框選模式下就再也點不到單一物件了。
       */
      if (this._marq) {
        this._endMarquee(e, dist > TAP_MOVE);
        if (dist > TAP_MOVE) return;
      }

      /**
       * 🔴🔴 **鋼筆一定要放在「拖曳過就不算點選」那道之前。**
       *
       * 〔kang 2026-08-29 第四次退回，⛔ 我前三次都沒抓到 —— 這是根本原因〕
       * 下面那一行是給「點選」用的：
       *     if (dist > TAP_MOVE || dt > TAP_TIME) return;
       * 而**鋼筆的「按住拖」必定超過 `TAP_MOVE`** ——
       * 所以放在它後面的話，**放開手的清理永遠走不到**。
       *
       * 🔴 **後果**：`_penDown` 一直留著 → 之後每一次移動游標都還被當成
       * 「正在拖」→ **上一個錨點的把手被改寫成「指向游標」**，
       * 直到使用者按下左鍵才停。
       *
       * ⚠ **而那正是 kang 描述的一切**：
       * 「不點左鍵，曲線會一直處於開放狀態」（**曲線真的還在變**）、
       * 「左鍵重疊了曲線與第三點的確認」（**那一按同時停住曲線又放下一點**）。
       *
       * ⚠ **⛔ 我前一輪的「實測」量錯了東西**：我量錨點數（1→2→2，看起來正常），
       * **而病在把手的數值**。【實證】存下來的把手 ＝ 整條弦（長 47.5，
       * 比半徑 32 還大、方向也不是切線），⛔ 不是我拖出來的那一段。
       * 🔴 **量錯量，就會得到「邏輯是對的」這個錯誤結論。**
       *
       * ── 手勢的分工（kang 2026-08-29 指定）──────────────────
       * **左鍵 ＝ 放點**（位置定案）　**右鍵按一下 ＝ 確定這一段曲線**
       * ⚠ **右鍵「拖」仍然是轉視角** —— 用移動距離分。
       */
      if (this.penMode) {
        /**
         * 🔴 **`改點` 模式：這一支只負責結束拖曳**，
         * ⛔ 完全不碰放點／閉合／收尾那一整套。
         * ⚠ 右鍵在這個模式下什麼都不做 —— `確定曲線` 是**畫的時候**的事。
         */
        if (this.penEdit) { this._penUpEdit(e, d, dist); return; }
        /** 右鍵按一下 ＝ 確定曲線；右鍵拖 ＝ 轉視角，⛔ 不可以一起吃掉 */
        if (d.button === 2) {
          if (dist <= TAP_MOVE && this._pen && this._pen.a.length) this.parkPen();
          return;
        }
        const d0 = this._penDown;
        this._penDown = null;
        if (!d0 || d.button !== DRAW_BUTTON) return;

        /**
         * 🔴 **曲線接直線：點一下剛畫好的那個點，把它轉成尖角。**
         *
         * ⭐ **Adobe 官方步驟，⛔ 不是我發明的**（2026-08-29 讀原文）：
         * > 「Position the Pen tool over the selected endpoint…
         * > 　**Select the anchor point to convert the smooth point to a
         * > 　corner point.** Reposition… and click to complete the
         * > 　**straight** segment.」
         *
         * ── 🔴 它補的是一個真的缺口（kang 2026-08-29 發現）─────────
         * 拖出一個圓滑點時，**進把手與出把手是一起長出來的**（那就是平滑）。
         * 所以「1→2 拖成曲線」之後 **`ho[1]` 也有值** ——
         * 下一段 2→3 就算只點一下，**它那一端還是彎的**。
         * ⚠ 他的原話：「1 與 2 曲線..2 與 3 依樣會是曲線」。
         *
         * ── ⚠ 只清「出把手」，⛔ 不動「進把手」──────────────────
         * `hi` 管的是**已經畫好的那一段**。動它的話，
         * **為了接下一段會把上一段改掉** —— 跟閉合那一條同一個道理。
         *
         * ⚠ **它跟 `尖角` 那顆按鈕⛔ 不是同一件事**：
         * 那顆管的是「**接下來要放的點**」，這裡管的是「**已經放好的那個點**」。
         */
        if (this._penConvert) {
          const cv0 = this._penConvert;
          this._penConvert = false;
          const ci = this.penCount - 1;
          const had = Math.hypot(this._pen.ho[ci * 2], this._pen.ho[ci * 2 + 1]) > 1e-9;
          if (dist > TAP_MOVE) {
            /**
             * 🔴 **按住拖 ＝ 幫這個點長出出把手 → 下一段是曲線**（直線接曲線）。
             *
             * ⭐ **Adobe 原文，⛔ 不是我發明的**：
             * > 「Select the anchor point **and drag the direction line**
             * > 　that appears to set the slope of the curved segment
             * > 　you want to create.」
             *
             * ⚠ **⛔ 只設出把手** —— 上一段一格都不能變。
             * 〔鐵律二：性質由兩端決定 —— 這裡刻意**只碰該碰的那一端**〕
             * ⚠ 拖曳中 `pointermove` 已經一路在設了，這裡只補最後一次
             * （放開的位置才是最終值）。
             */
            const g2 = this._groundAt(e.clientX, e.clientY);
            if (g2) {
              const hh = this._snapIf(e, g2.x - cv0.g.x, g2.z - cv0.g.z);
              this._pen.ho[ci * 2] = hh.dx;
              this._pen.ho[ci * 2 + 1] = hh.dz;
            }
            this._drawPenPreview();
            if (this.hooks.onPenConvert) this.hooks.onPenConvert(had, true);
            return;
          }
          this._pen.ho[ci * 2] = 0;
          this._pen.ho[ci * 2 + 1] = 0;
          this._drawPenPreview();
          if (this.hooks.onPenConvert) this.hooks.onPenConvert(had, false);
          return;
        }

        /**
         * 🔴 **壓在第一個錨點上 → 閉合並收尾。而且⛔ 閉合也可以用拖的。**
         *
         * ⭐ **Adobe 官方原文就是這樣寫的**（2026-08-29 讀到）：
         * > 「Position the Pen tool over the first anchor point…
         * > 　**Select _or drag_ to close the path.**」
         *
         * ── 🔴 它補的是一個真的缺口（kang 2026-08-29 發現，我重現＋量到）──
         * **閉合那一段 ＝ 最後一點的出把手 ＋ 第一點的進把手**。
         * 而**第一點的進把手在「第一次放那個點」時就被決定了** ——
         * 那時使用者根本還不知道最後要怎麼接回來。
         * 【實證】第一個點只是點一下（最自然的畫法）→ `hi[0]` ＝ **0**
         * → 閉合那一段一端有把手、一端沒有 → **只彎一半，接回起點時是直的**，
         * 畫出來的圓**右上角被切掉一塊**。
         *
         * ── ⚠ 只設「進把手」，⛔ 不動「出把手」 ────────────────
         * `ho[0]` 已經被用在**第一段**（0→1）上了。動它的話，
         * **為了接尾巴會把頭改掉** —— 而使用者已經調好第一段了。
         * ⭐ `hi[0]` **只影響閉合那一段**，所以動它是安全的。
         * 〔比 Illustrator 保守：它閉合時兩根一起動，因為它的錨點永遠是平滑的〕
         */
        if (this._penClosing) {
          const c0 = this._penClosing;
          this._penClosing = false;
          if (dist > TAP_MOVE) {
            const g1 = this._groundAt(e.clientX, e.clientY);
            if (g1) this._penSetFirstInHandle(g1.x - c0.g.x, g1.z - c0.g.z);
          }
          if (this.hooks.onPenFinish) this.hooks.onPenFinish();
          return;
        }

        const now = performance.now();
        const lt = this._lastPenTap;
        const isDouble = !!lt && (now - lt.t) < DOUBLE_TAP_MS
                      && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) <= DOUBLE_TAP_MOVE;
        this._lastPenTap = { x: e.clientX, y: e.clientY, t: now };
        if (isDouble) {
          /** ⚠ 第二下的 `pointerdown` 也放了一個錨點，⛔ 一定要退掉 */
          this.penUndo();
          if (this.hooks.onPenFinish) this.hooks.onPenFinish();
          return;
        }

        /**
         * ⚠ 錨點在 `pointerdown` 就放好了，這裡⛔ 不再放一次。
         * 移動距離小於 `TAP_MOVE` ＝ 只是點了一下 → 把手歸零（尖角）。
         */
        if (dist <= TAP_MOVE) this._penSetLastHandle(0, 0);
        this._drawPenPreview();
        return;
      }

      // 拖曳過、按太久、或正在操作 gizmo → 不算點選
      if (dist > TAP_MOVE || dt > TAP_TIME) return;
      if (this.tc.dragging) return;

      if (this.editMode) {
        // 加選重用物件層那一顆「加選」與 Shift —— 同一件事一個入口
        this.pickEdit(e.clientX, e.clientY, e.shiftKey || this.multi);
        return;
      }
      /**
       * 🔴 **刀具：點的是畫面上的位置，不是東西。**
       * ⚠ 要放在 `seamMode`／`mateMode` 前面沒關係（互斥），
       * 但**一定要在 `pick()` 前面** —— 否則會變成選物件。
       */
      if (this.knifeMode) {
        /**
         * 🔴 **右鍵／中鍵在刀具模式下是轉視角與縮放，⛔ 不可以順便加一個切點。**
         *
         * ⚠ 判準用**按下去時記的那顆鍵**（`d.button`），⛔ 不是 `e.button` ——
         * 理由跟上面 `pointerdown` 那一段一樣：鍵是初始狀態的一部分。
         *
         * ⚠ **這個限制只加在刀具模式裡。** 物件選取那條路
         * （下面的 `pick()`）本來就不分鍵，而那是 kang 已經驗過的行為 ——
         * ⛔ 不要順手把它一起改掉。
         */
        if (d.button !== DRAW_BUTTON) return;
        if (this.hooks.onKnifePick) {
          /**
           * 🔴 **快點兩下 ＝ 閉合迴圈並切下去；慢慢再點一次 ＝ 取消最後一點。**
           * 〔kang 2026-08-26 拍板。**逐點按的行為一格都沒變** ——
           * 　快慢是唯一的差別〕
           *
           * ⚠ **時間與位置兩個條件都要**：只看時間的話，快速連點兩個
           * 不同的位置會被誤判成閉合；只看位置的話，就跟「取消最後一點」
           * 完全分不開。
           */
          const now = performance.now();
          const lt = this._lastKnifeTap;
          const isDouble = !!lt && (now - lt.t) < DOUBLE_TAP_MS
                        && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) <= DOUBLE_TAP_MOVE;
          this._lastKnifeTap = { x: e.clientX, y: e.clientY, t: now };
          this.hooks.onKnifePick(
            this.pickEdgePoint(e.clientX, e.clientY, this._wantSnapMid(e)),
            { double: isDouble }
          );
        }
        return;
      }
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

    // 按著 Shift 或開著「加選」就是往現有選取上加，跟點選的規矩一致
    const additive = (e && e.shiftKey) || this.multi;

    /**
     * 🔴 **編輯模式下框的是子元素，不是物件。**
     *
     * ⚠ 這是對照表上列著的缺口：「框選 ✅ 物件層級 —— **編輯模式下
     * 框選子元素沒有**」。而多選只能一個一個點正是選取那一組要解的病。
     */
    if (this.editMode) { this._marqueeEdit(rect, box, additive); return; }

    const entries = this._doc.objects.map(o => ({ id: o.id, box: worldBounds(o) }));
    const hits = objectsInRect(entries, rect, this.view.camera, box.width, box.height);
    this.set(additive ? [...new Set([...this.ids, ...hits])] : hits);
    if (this.hooks.onMarquee) this.hooks.onMarquee(hits.length);
  }

  /**
   * 🔴 **框選子元素（編輯模式）。**
   *
   * ── 🔴 連背面一起選（kang 2026-08-26 拍板）─────────────
   * 跟刀具那條「**點到哪切到哪**」同一個作風，而且**選一整條經線、
   * 選一整圈**這種事本來就要包含背面。
   *
   * ⚠ **代價是會選到看不見的東西** —— 所以**一定要講出數量**
   * （坑第 11、21 條）。⛔ 不可以安靜地多選一堆。
   *
   * ── ⚠ 一次只框一個物件 ────────────────────────────────
   * 框到的元素屬於哪個網格必須是確定的 —— 跨物件的話後面每一個
   * 編輯動作都會問「這是誰的索引」。這條跟刀具那條
   * 「一次只切一個物件」是同一個理由。
   *
   * ── ⚠ 判準跟過濾器連動 ────────────────────────────────
   * 過濾器是「邊」就只框邊。`'auto'` 時**優先給邊** ——
   * 一框下去同時選到點、邊、面的話型別會混，而多選規定同型別。
   * 〔⭐ 選邊是這顆按鈕的主要用途：12 條邊圓角、一整條經線都是邊〕
   */
  _marqueeEdit(rect, box, additive) {
    const obj = this.active;
    if (!obj || obj.isParametric) {
      if (this.hooks.onMarqueeEdit) this.hooks.onMarqueeEdit(null);
      return;
    }
    const node = this.view.nodeOf(obj.id);
    if (!node) return;
    node.updateMatrixWorld(true);
    const mesh = obj.mesh();
    const toWorld = p => node.localToWorld(p.clone());
    const f = this.editFilter;

    const items = { verts: [], edges: [], faces: [] };
    if (f === 'vertex') {
      for (const v of mesh.verts) {
        if (v.he) items.verts.push({ el: { obj, kind: 'vertex', vert: v }, pts: [toWorld(v.p)] });
      }
    } else if (f === 'face') {
      mesh.computeNormals();
      for (const face of mesh.faces) {
        const vs = mesh.faceVerts(face);
        if (!vs.length) continue;
        const c = new THREE.Vector3();
        for (const v of vs) c.add(v.p);
        c.divideScalar(vs.length);
        items.faces.push({ el: { obj, kind: 'face', face }, pts: [toWorld(c)] });
      }
    } else {
      /** `'auto'` 與 `'edge'` 都走邊 —— 判準用 `isMarkable()`，⛔ 不另寫一套 */
      for (const he of markableEdges(mesh)) {
        items.edges.push({
          el: { obj, kind: 'edge', he },
          pts: [toWorld(he.v.p), toWorld(he.to.p)]
        });
      }
    }

    const got = elementsInRect(items, rect, this.view.camera, box.width, box.height);
    const els = [...got.verts, ...got.edges, ...got.faces];
    for (const el of els) el.mesh = mesh;

    if (!additive) this.editSels = [];
    for (const el of els) {
      /** 同一次多選裡型別必須一致 —— 跟 `pickEdit()` 同一條規矩 */
      if (this.editSels.length && this.editSels[0].kind !== el.kind) continue;
      if (this.editSels.some(x => this._sameHover(x, el))) continue;
      this.editSels.push(el);
    }
    if (this.editSels.length) { this._attachEditProxy(); }
    this._drawEditMark();
    if (this.hooks.onMarqueeEdit) {
      this.hooks.onMarqueeEdit({ added: els.length, total: this.editSels.length, kind: els[0] && els[0].kind });
    }
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
    /**
     * 🔴 **⛔ 這裡不可以直接寫 `orb.enableRotate`**（2026-09-01 改）——
     * 視角鎖定也要擋旋轉，兩個人各寫各的的話，
     * **關掉框選會把還鎖著的視角偷偷解開**（實測抓到）。
     * ⇒ 一律登記到 `setRotateBlock()`，⛔ 那是唯一在寫它的地方。
     */
    this.view.setRotateBlock('marquee', this.marqueeMode);
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
   * @param {string} opt.only 只接受這一種：'vertex' / 'edge' / 'face'。
   *        不給 ＝ 維持原本的「點 → 邊 → 面，小的先」自動判斷。
   *        編輯模式的選取過濾器走這個 —— **平板沒有鍵盤可以按 1/2/3
   *        切換元素類型，只能做成按鈕**（跟分片、框選同一個做法）。
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

    const only = opt.only;

    if (opt.vertex && (!only || only === 'vertex')) {
      const nv = nearestVertex(mesh, pLocal);
      if (nv) {
        const s = toPx(nv.vert.p);
        if (Math.hypot(r.x - s.x, r.y - s.y) <= grab) {
          return { obj, kind: 'vertex', vert: nv.vert };
        }
      }
      /**
       * 指定只要點的時候，**點不到就回 null，不要往下掉到邊或面**。
       * 掉下去的話使用者按了「點」卻選到一個面 —— 那比什麼都沒選中更糟，
       * 因為他會以為自己點中了，然後拉錯東西（坑第 20 條那個家族）。
       */
      if (only === 'vertex') return null;
    }

    if (!only || only === 'edge') {
      const near = nearestMarkableEdge(mesh, pLocal);
      if (near) {
        const a = toPx(near.he.v.p), b = toPx(near.he.to.p);
        if (distPointSeg2(r.x, r.y, a.x, a.y, b.x, b.y) <= grab) {
          return { obj, kind: 'edge', he: near.he };
        }
      }
      if (only === 'edge') return null;
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

  /**
   * ⛔ **`screenRay()` 已於 2026-08-26 刪除。**
   *
   * 它是刀具**第一版**的入口（螢幕座標 → 一條世界射線 → `planeFromTwoRays()`）。
   * 那一版被 kang 實測否決，而這一支跟著沒有人呼叫了。
   *
   * ⚠ **它原本不在待辦的那三個殘骸裡** —— 是清殘骸時 grep 才發現的**第四個**。
   * 〔又一次印證：殘骸要用 grep 找，⛔ 不要照清單推〕
   *
   * 🔴 **一筆畫不會把它挖回來**：一筆畫要的是「射線打到**模型表面**的哪一點」
   * （`_surfaceHit()`），不是「一條射線的起點與方向」。
   */

  /**
   * 🔴 **刀具：點畫面 → 吸到最近的那條邊，並算出「邊上的哪個位置」。**
   *
   * ── 為什麼一定要吸到邊上 ────────────────────────────
   * 一條線要把面切開，**它的兩端一定得落在那個面的邊上** ——
   * 端點停在面中間是接不起來的（那一頭會懸空，網格拓撲不允許）。
   *
   * ⚠ 這其實跟使用者要的一致：要切開一個面，那條線本來就得
   * 從一邊走到另一邊。
   *
   * ── ⚠ `nearestMarkableEdge()` 只回「哪條邊」，不回「邊上哪裡」──────
   * 後者要自己投影算（很短）。⛔ 不要另外寫一套「找最近的邊」——
   * 判準一律用 `isMarkable()`，那是「畫面上看得見的邊」的唯一定義
   * （全選邊那一輪定的，坑第 20 條）。
   *
   * @returns {null|{obj, a:number, b:number, p:THREE.Vector3, world:THREE.Vector3}}
   *          `a`／`b` ＝ 那條邊兩端的頂點索引；`p` ＝ 本地座標的落點
   */
  /**
   * 射線打到模型表面的哪一點。
   *
   * ⚠ **抽出來是刻意的**：`pickEdgePoint()` 與一筆畫的取樣做的是
   * **同一件事的前半段**，兩份會漂（坑第 31 條）。
   *
   * @returns {null|{obj, node, pLocal:THREE.Vector3, world:THREE.Vector3}}
   */
  _surfaceHit(clientX, clientY) {
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
    const node = this.view.nodeOf(id);
    if (!obj || !node) return null;

    return { obj, node, pLocal: node.worldToLocal(hit.point.clone()), world: hit.point.clone() };
  }

  /**
   * 這一下要不要吸中點。
   *
   * 🔴 **兩條路都算數**：工具列那顆開關，或桌機按著 `Shift`。
   * ⚠ 平板沒有 `Shift`，所以開關那條路**不是方便，是唯一的路**。
   */
  _wantSnapMid(e) {
    return this.knifeSnapMid || !!(e && e.shiftKey);
  }

  /**
   * 這一下鋼筆要不要鎖角度。⚠ 跟 `_wantSnapMid()` 同一套：
   * **開關或 `Shift`**，平板只有開關那條路。
   */
  _wantPenSnap(e) {
    return this.penSnapAngle || !!(e && e.shiftKey);
  }

  /**
   * 🔴 **把一個向量的方向吸到最近的 45 度倍數，⛔ 長度不變。**
   *
   * ⭐ **長度不變是刻意的** —— 使用者拖多遠就是多遠，
   * ⛔ 只有方向被鎖住。改成「投影到那條射線」會讓拖曳時長度自己縮，
   * 那看起來像沒跟上手。
   */
  /** 要鎖就鎖，不要就原樣回 —— 三個呼叫點共用，⛔ 不各寫一份 */
  _snapIf(e, dx, dz) {
    return this._wantPenSnap(e) ? this._snapAngle(dx, dz) : { dx, dz };
  }

  _snapAngle(dx, dz) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) return { dx, dz };
    const deg = Number.isFinite(this.penSnapDeg) && this.penSnapDeg > 0
      ? this.penSnapDeg : PEN_SNAP_DEG;
    const step = Math.PI * deg / 180;
    const a = Math.round(Math.atan2(dz, dx) / step) * step;
    return { dx: Math.cos(a) * len, dz: Math.sin(a) * len };
  }

  /**
   * 放點時要不要把「上一個錨點 → 這裡」的方向鎖住。
   * ⚠ **第一個點沒有「上一個」**，所以⛔ 不鎖。
   */
  _penSnapPoint(x, z, e) {
    if (!this._wantPenSnap(e) || !this._pen || this._pen.a.length < 2) {
      return { x, z };
    }
    const n = Math.floor(this._pen.a.length / 2);
    const px = this._pen.a[(n - 1) * 2], pz = this._pen.a[(n - 1) * 2 + 1];
    const s2 = this._snapAngle(x - px, z - pz);
    return { x: px + s2.dx, z: pz + s2.dz };
  }

  // ── 指到哪就亮哪（hover）────────────────────────────

  /**
   * 記下座標，**一幀最多算一次**。
   *
   * ⭐ 判準跟 `sel.active` 那次同一招：**與其在每個事件都算一次，
   * 不如換成「該畫的時候才算」**。`pointermove` 一秒上百次，
   * 而畫面一秒也才 60 幀 —— 多算的部分**沒有任何人看得到**。
   */
  _queueHover(clientX, clientY) {
    this._hoverAt = { x: clientX, y: clientY };
    if (this._hoverRaf) return;
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = 0;
      const at = this._hoverAt;
      if (at) this._runHover(at.x, at.y);
    });
  }

  /**
   * 🔴 **算「現在指到什麼」—— 呼叫的是選取本人那一支。**
   *
   * ⚠ **跟過濾器連動不是取巧**：過濾器**本來就已經決定了
   * 「你現在選得到什麼」**。過濾器是「點」卻去算面，算出來的東西
   * 使用者根本選不到 —— 那才是說謊。
   *
   * ⚠ 順便也是最有效的那道保險：只問點的話最貴 0.089 ms。
   */
  _runHover(clientX, clientY) {
    const f = this.editFilter;
    let only = f === 'auto' ? null : f;

    /**
     * 🔴 **面太多就不問面**（`HOVER_FACE_MAX`，量出來的）。
     * ⚠ 這時候把 `only` 收成 `'edge'`，**⛔ 不是整個放棄** ——
     * 點與邊很便宜，而它們正是選取最常用的兩種。
     */
    if (only === null || only === 'face') {
      const act = this.active;
      const n = act && !act.isParametric ? act.mesh().faces.length : 0;
      if (n > HOVER_FACE_MAX) only = (f === 'face') ? 'none' : 'edge';
    }
    if (only === 'none') { this._setHover(null); return; }

    const el = this.pickElement(clientX, clientY, {
      vertex: f === 'auto' || f === 'vertex',
      requireMarkable: true,
      only
    });
    this._setHover(el && el.kind !== 'blocked' ? el : null);
  }

  /** 換人才重畫 —— ⛔ 每一幀都重建一次標記是白工（坑第 22 條） */
  _setHover(el) {
    if (this._sameHover(this._hover, el)) return;
    this._hover = el;
    this._drawEditMark();
  }

  /**
   * 兩次 hover 指的是不是同一個東西。
   *
   * ⚠ **比的是元素物件本身**（`vert`／`he`／`face`），⛔ 不比索引 ——
   * 網格一被重建索引就變了，而那時候元素物件也換了，所以物件比較才是對的。
   * ⚠ 邊要連 `twin` 一起認：同一條邊有兩個 half-edge 物件。
   */
  _sameHover(a, b) {
    if (!a || !b) return a === b;
    if (a.kind !== b.kind || a.obj !== b.obj) return false;
    if (a.kind === 'vertex') return a.vert === b.vert;
    if (a.kind === 'face') return a.face === b.face;
    return a.he === b.he || a.he === (b.he && b.he.twin);
  }

  /**
   * @param {boolean} [snapMid] 吸到那條邊的正中間
   */
  pickEdgePoint(clientX, clientY, snapMid = false) {
    const h = this._surfaceHit(clientX, clientY);
    if (!h) return null;
    const { obj, node, pLocal } = h;

    const mesh = obj.mesh();
    const near = nearestMarkableEdge(mesh, pLocal);
    if (!near || !near.he) return null;

    /** 投影到那條邊上 → 邊上的落點 */
    const a = near.he.v.p, b = near.he.to.p;
    const ab = b.clone().sub(a);
    const L2 = ab.lengthSq();
    let s = L2 > 0 ? pLocal.clone().sub(a).dot(ab) / L2 : 0;
    s = Math.max(0, Math.min(1, s));
    /** 🔴 吸中點：**只換這一個數字**，其餘一格都不動 */
    if (snapMid) s = 0.5;
    const p = a.clone().lerp(b, s);

    const vi = mesh._vertIndex();
    return {
      obj,
      a: vi.get(near.he.v.id),
      b: vi.get(near.he.to.id),
      p,
      world: node.localToWorld(p.clone())
    };
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

  /**
   * 最後選的那個 —— gizmo 掛在它身上，參數面板也顯示它。
   *
   * 🔴 **編輯模式下只要選了元素，就以「那個元素屬於哪個物件」為準。**
   *
   * ⚠ **這一條是 kang 2026-08-25 實測抓到的，而且症狀比看起來嚴重。**
   * 在這之前，「選了哪個物件」（`ids`）與「選了哪個面」（`editSels`）是
   * **兩份分開記的東西**，而編輯模式下點一個面**只會更新後者** ——
   * `pickEdit()` 從來不碰 `ids`。於是同一個畫面上：
   *
   *   · 擠出／壓平／環切／內縮／導角／刪除面 → 看元素 → **亮著**
   *   · 切一刀／全選邊／法向／補洞           → 看 `active` → **灰的**
   *
   * 使用者只點了一次，卻得到兩種相反的答案，而畫面上看不出原因。
   *
   * 🔴 **不灰的時候更糟**：`active` 可能還留著上一個物件（例如 Undo
   * 叫回東西之前選的那個方塊），而元素選在另一個物件上 ——
   * 按下「切一刀」**會去切一個使用者根本沒在看的物件**，
   * 而且形狀改對了、也沒有任何錯誤，只是改錯了對象。
   *
   * ⭐ **解法刻意不是「在每個寫入點補一行同步」**：`editSels` 有九個
   * 寫入點，補九行是靠紀律維持，下次有人加第十個就又破了。
   * 改成**只有一條路的定義** —— 問 `active` 的時候當場算，
   * 沒有第二份資料，也就沒有東西會不同步。〔坑第 31 條：與其小心地
   * 讓兩條路對齊，不如換一個只有一條路的定義〕
   *
   * ⚠ 離開編輯模式時 `setEditMode(false)` 會清掉 `editSels`，
   * 所以**編輯模式以外的行為一格都沒變**。
   *
   * ⚠ 取 `[0]` 而不是最後一個：同一次多選裡**跨物件是擋掉的**
   * （見 `pickEdit()` 的 `objReset`），所以整批本來就同屬一個物件。
   */
  get active() {
    if (this.editSels.length) return this.editSels[0].obj;
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

    /**
     * 編輯模式：gizmo 掛在**子元素的替身**上，不是掛在物件上。
     * 還沒選到元素之前不掛 —— 三支箭頭會擋住要點的表面。
     */
    if (this.editMode) {
      if (this.editSel) this._attachEditProxy();
      else this.tc.detach();
      if (this.hooks.onChange) this.hooks.onChange(this);
      return;
    }

    // 分片模式下不掛 gizmo。放在這裡是因為 _refresh() 會在選取變動、
    // Undo、讀檔之後重跑，只在 setSeamMode() 裡收一次是收不乾淨的。
    if (node && !this.inPickMode) {
      this.tc.attach(node);
      /**
       * ⚠ **一定要把 space 設回世界。**
       * 編輯模式的「法向」方向是靠把 space 切成 `local` 做到的，
       * 而 `space` 是 gizmo 自己的狀態，離開編輯模式不會自己還原 ——
       * 不設回來的話，接著拖一般物件時箭頭會沿**物件自己的軸**走，
       * 而使用者根本不知道自己什麼時候換過方向。
       */
      this.tc.space = 'world';
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
    /**
     * ⚠ 子元素選取一定要清掉。Undo／讀檔會**換掉整個 mesh 物件**，
     * 而 editSel 抓的是舊網格裡的 Vertex／HalfEdge／Face 參考 ——
     * 那些物件還活著（JS 不會回收被引用的東西），拖曳照樣「成功」，
     * 只是改的是一份**已經不在文件裡的網格**。
     * 畫面完全沒反應，資料也沒錯，最難查的那一種。
     *
     * 但**不能一律清掉** —— `commit()` 每記一步 Undo 也會走到這裡，
     * 而那條路上網格根本沒換人（`hist.commit()` 只是拍快照）。
     * 一律清的話，每拉一下就得重選一次元素，那個功能沒人會用。
     *
     * 判準是**網格物件還是不是同一個**，不是「物件還在不在」——
     * 物件還在但網格被換掉，正是最危險的那一種，而它從外面看不出來。
     */
    if (this.editSel) {
      const o = this._doc && this._doc.byId(this.editSel.obj.id);
      if (!o || o.mesh() !== this.editSel.mesh) this.clearEditSel();
      else this._drawEditMark();      // 座標可能變了，標示要跟著走
    }
    this._refresh();
  }

  /**
   * 網格被拆掉重建之後，把整份選取搬到新網格上。
   *
   * 🔴 **這一支只給「拆掉重建」那條路用**（面合併，日後的刪除面／環切／導角）。
   * 配對規則在 `edit.js` 的 `remapElements()`，靠的是重建時交出來的 `remap`
   * （舊索引 → 新索引），所以是**精確配對**，不是猜的。
   *
   * ⛔ **不要拿它救 Undo／讀檔。** 那兩條路換上來的是**另一個模型狀態**，
   * 索引不保證對得起來 —— 那裡就該老實清掉（`revalidate()` 在做）。
   *
   * ⚠ 搬不過去的會掉掉（例如那個面已經被合併進別的面了）。
   * 所以回傳少掉幾個，呼叫端要在少掉時講一句 ——
   * **選取安靜地變少最讓人不敢相信工具**（坑第 11、21 條）。
   *
   * @returns {{kept:number, dropped:number}}
   */
  remapEditSels(obj, oldMesh, newMesh, remap) {
    const before = this.editSels.length;
    if (!before || !obj || !oldMesh || !newMesh) return { kept: 0, dropped: 0 };

    const moved = remapElements(oldMesh, newMesh, this.editSels, remap)
      .map(e => ({ ...e, obj }));
    this.editSels = moved;
    this._drag = null;
    if (moved.length) { this._attachEditProxy(); this._drawEditMark(); }
    else this.clearEditSel();
    return { kept: moved.length, dropped: before - moved.length };
  }

  /**
   * 切換中心：`'median'`（全部的重心）／`'active'`（最後點的那一個）。
   * 單選時兩者是同一個點，所以介面上要講清楚它是給多選用的。
   */
  setEditPivot(pivot) {
    this.editPivot = pivot === 'active' ? 'active' : 'median';
    this._drag = null;              // 中心變了，上一次拖曳的基準就不同了
    if (this.editSel) { this._rebaseProxy(); this._drawEditMark(); }
    return this.editPivot;
  }

  // ── gizmo ─────────────────────────────────────────

  setMode(mode) {
    /**
     * 編輯模式下的限制跟物件層不同：judgement 在 `editModeAllowed()`，
     * 只擋**點**（一個頂點繞自己轉或縮放都不會改變任何座標）。
     * 擋下來要**回傳 false 讓呼叫端說一句** —— 按了沒反應是最糟的回饋。
     */
    if (this.editMode) {
      if (this.editSel && !this.editModeAllowed(mode)) return false;
      this._drag = null;            // 換了種類，上一次拖曳的量沒有意義了
      this.tc.setMode(mode);
      return true;
    }
    const act = this.active;
    if (mode === 'scale' && act && act.lockScale) return false;
    this.tc.setMode(mode);
    return true;
  }

  get mode() { return this.tc.getMode(); }

  /**
   * ── 吸附：三種變換各自一支（2026-08-31 拆開）──────────
   *
   * 🔴 **原本是一支 `setSnap(step)` 同時設三件事**：
   * 移動用參數值、**旋轉寫死 15 度、縮放寫死 0.05**，
   * 而後兩者**只跟著「開／關」走，跟參數無關**。
   *
   * ⚠ **那個形狀有兩個問題**，kang 2026-08-31 兩個都碰到了：
   * ① 想打 2.5cm 這種非整數的格距，四顆固定按鈕給不了；
   * ② 想要「**位置吸得死死的、但角度能微微斜一點**」——
   *    一個總開關做不到（反過來也一樣：角度鎖 90 度、位置自由）。
   *
   * ⭐ **拆開之後三個各自獨立**。初始值刻意維持 1cm／15 度／0.05
   * 完全不變 —— 這一輪改的是「能不能自己填」，⛔ 不是預設行為。
   *
   * ⚠ **`snapStep` 這個欄位名⛔ 不可以改** —— 它有兩個下游讀者
   * （擠出的預設距離與那顆按鈕的 title，見 `main.js`）。
   *
   * ✘ **縮放刻意只留開關、⛔ 不開放自由輸入**（kang 2026-08-31 收回：
   * 「既然縮放較複雜..這就不要處理...維持目前的機制」）——
   * 「0.05 倍一格」是等差，而「一次放大兩倍」是等比，
   * **兩種需求用同一個欄位表達不出來**，要開放得先重想單位。
   */

  /** 移動的吸附格距，單位 cm。0 ＝ 關閉。 */
  setSnap(step) {
    this.snapStep = step;
    this.tc.setTranslationSnap(step > 0 ? step : null);
  }

  /** 旋轉的吸附格距，單位**度**。0 ＝ 關閉。 */
  setSnapRot(deg) {
    this.snapRot = deg;
    this.tc.setRotationSnap(deg > 0 ? THREE.MathUtils.degToRad(deg) : null);
  }

  /** 縮放的吸附格距，單位**倍**。0 ＝ 關閉。 */
  setSnapScale(mult) {
    this.snapScale = mult;
    this.tc.setScaleSnap(mult > 0 ? mult : null);
  }

  /**
   * 🔴 **吸到參考線**（第 2 階段，2026-09-01）。
   *
   * ── ⛔ 為什麼⛔ 不能用上面那個 `setTranslationSnap()` ────────
   * 那是 three.js 內建的「**位移量的整數倍**」——
   * 參考線放在 **47.3** 就永遠吸不到。
   * ⇒ 只能掛在 `objectChange` 上自己算（見 `_applyGuideSnap`）。
   *
   * ── 🔴 兩個吸附同時開著時，**參考線贏**（kang 2026-09-01 拍板）──
   * three.js 先把位移吸成 1cm 的整數倍，**我們接著再把它挪到線上** ——
   * ⭐ 所以順序天然就是「參考線覆蓋格距」，⛔ 不必去關掉誰。
   * ⚠ 對照組（沒選的兩個）是「格距贏」與「開一個就自動關另一個」。
   */
  setSnapGuides(on) {
    this.snapGuides = !!on;
    if (!this.snapGuides) this._reportGuideHits(null);
    return this.snapGuides;
  }

  get dragging() { return !!this.tc.dragging; }

  /**
   * 切換分片模式。
   *
   * 一定要把 gizmo 收起來 —— 它的三支箭頭會擋在物件前面，
   * 而分片模式要點的是物件表面上的邊。不收的話使用者會一直
   * 點到箭頭然後把東西拖走，而那看起來就像「分片功能沒反應」。
   */
  // ── 編輯模式（拉點／拉邊／拉面）────────────────────

  /**
   * 切換編輯模式。離開時一定要把子元素選取清乾淨 ——
   * 留著的話 gizmo 會繼續掛在替身上，而使用者以為自己在拖物件。
   */
  setEditMode(on) {
    this.editMode = !!on;
    if (!this.editMode) this.clearEditSel();
    this.tc.enabled = !this.inPickMode;
    this._refresh();
    if (this.helper) this.helper.visible = !this.inPickMode;
    return this.editMode;
  }

  /**
   * 選取過濾器：只選點／只選邊／只選面／自動。
   *
   * 🔴 **清掉「不合這個型別的」，留下合的。**
   * 原本是**全部清掉**，理由是「按了『面』卻還掛著一個點的 gizmo，畫面在騙人」——
   * 那個理由只需要清掉不合的那些。多選之後全部清掉不能接受：
   * **選了六條邊，再按一下「邊」就全沒了。**
   * 〔照 Blender 的 select mode clean：換模式時清掉「這個模式撐不住的」〕
   *
   * @returns {{filter:string, dropped:number}} 少掉幾個，呼叫端要講一句 ——
   *          選取安靜地變少是最讓人不敢相信工具的事（坑第 11、21 條）
   */
  setEditFilter(kind) {
    this.editFilter = kind || 'auto';
    const before = this.editSels.length;
    if (this.editFilter !== 'auto') {
      this.editSels = this.editSels.filter(e => e.kind === this.editFilter);
    }
    const dropped = before - this.editSels.length;
    if (dropped) this._drag = null;               // 成員變了，快照對不上了
    if (this.editSels.length) { this._attachEditProxy(); this._drawEditMark(); }
    else this.clearEditSel();
    return { filter: this.editFilter, dropped };
  }

  /** 最後點的那一個 ＝ active。gizmo 掛它、面板顯示它、擠出用它。 */
  get editSel() {
    return this.editSels.length ? this.editSels[this.editSels.length - 1] : null;
  }

  /** 選了幾個子元素 */
  get editCount() { return this.editSels.length; }

  clearEditSel() {
    this.editSels = [];
    this._drag = null;              // 快照跟著選取走，選取沒了就對不上任何東西
    if (this._proxy.parent) this._proxy.parent.remove(this._proxy);
    this.view.clearPickMarks();
    /**
     * 🔴 **這一支⛔ 不走 `_drawEditMark()`**（它直接清標記），
     * 所以量測的字要在這裡自己收掉 —— ⛔ 漏掉的症狀是
     * **選取已經沒了，數字還賴在畫面上**（坑第 21 條的反面）。
     * ⭐ 呼叫 `refreshMeasureLabels()` 而不是 `view.clearMeasureLabels()`：
     * 那一支**讀當下狀態自己算**，⛔ 不必在這裡再抄一次「什麼時候該清」。
     */
    this.refreshMeasureLabels();
    this.tc.detach();
  }

  /**
   * 編輯模式下點一下畫面。
   *
   * 擋掉參數物件的理由跟分片一模一樣：參數體存檔只存 `{type:'box',w:60…}`，
   * 開檔時網格重新生成，改過的座標就沒了。而它在同一次開著的時候又是好的
   * —— 這種「用起來正常、存檔重開才發現不見了」是最糟的失敗。
   */
  pickEdit(clientX, clientY, additive) {
    const f = this.editFilter;
    const el = this.pickElement(clientX, clientY, {
      vertex: f === 'auto' || f === 'vertex',
      requireMarkable: true,
      only: f === 'auto' ? null : f,
    });

    if (!el) {
      /**
       * 加選開著時點空白處**不要清掉** —— 使用者正在一個一個累積，
       * 而點空一下多半是沒點準。清掉的話他得從頭再選六條邊。
       * （物件層的 `pick()` 早就是這個規則：`if (!additive) this.set([])`）
       */
      if (!additive) this.clearEditSel();
      if (this.hooks.onEditPick) this.hooks.onEditPick(null);
      return;
    }
    if (el.kind === 'blocked') {
      this.clearEditSel();
      if (this.hooks.onEditPick) this.hooks.onEditPick(el);
      return;
    }

    // 記下當下的網格物件。revalidate() 靠它分辨「網格被換掉了沒」
    el.mesh = el.obj.mesh();

    let note = '';
    if (additive && this.editSels.length) {
      const cur = this.editSels[0];
      if (cur.kind !== el.kind) {
        /**
         * 🔴 **同一次多選裡型別必須一致。** 型別不合就當成重新開始，
         * 並且**講一句** —— 安靜地把六條邊換成一個面，
         * 使用者會以為加選壞了（坑第 11 條「沉默地退回是最糟的做法」）。
         */
        this.editSels = [];
        note = 'kindReset';
      } else if (cur.obj !== el.obj) {
        // 跨物件也不行：變換寫回的是「某一個網格」的頂點座標
        this.editSels = [];
        note = 'objReset';
      } else {
        const i = this._findEditSel(el);
        if (i >= 0) {
          /**
           * 再點一次同一個 ＝ 取消選它。
           * **active 因此自然退回上一個**，不必寫任何特別處理 ——
           * 那正是「順序即 active」這個做法換來的。
           */
          this.editSels.splice(i, 1);
          this._drag = null;
          if (this.editSels.length) { this._attachEditProxy(); this._drawEditMark(); }
          else this.clearEditSel();
          if (this.hooks.onEditPick) this.hooks.onEditPick(null, { removed: true });
          return;
        }
      }
    } else if (!additive) {
      this.editSels = [];
    }

    this.editSels.push(el);
    this._drag = null;              // 成員變了，上一次的快照對不上了
    this._attachEditProxy();
    this._drawEditMark();

    /**
     * ⚠ **這一行只是為了畫面一致，正確性不靠它** —— `active` 那個 getter
     * 已經保證了（見上面那段長註解）。
     *
     * 沒有它的話，左下角會寫「已選 0」，而右邊面板同時寫著
     * 「選到一個面…在方塊 3 上」——**兩個數字互相打臉**（鐵律三），
     * 而且那個物件不會被高亮，使用者看不出自己正在動哪一個。
     * kang 就是看著這個畫面問「我沒有去選擇其他物件」的。
     *
     * ⛔ **不要把它複製到其他寫入點去** —— 那就退回「九個地方各補一行」，
     * 也就是這次要根治的那個病。
     */
    if (!(this.ids.length === 1 && this.ids[0] === el.obj.id)) this.set([el.obj.id]);

    if (this.hooks.onEditPick) this.hooks.onEditPick(el, { note });
  }

  /**
   * 這個元素已經在選取裡了嗎（回索引，沒有則 −1）。
   *
   * ⚠ **比的是元素物件本身**（`vert`／`he`／`face` 的參考），不是 id 也不是座標。
   * 邊要連 `twin` 一起比 —— 同一條邊有兩條半邊，而 `nearestMarkableEdge()`
   * 回哪一條取決於點在哪一側。不比 twin 的話，同一條邊會被選進去兩次，
   * 而**畫面上完全看不出來**（兩條半邊畫出來是同一條線），
   * 只有拖的時候發現走了兩倍距離。
   */
  _findEditSel(el) {
    /**
     * ⚠ **面要比「共面區域」，不能比三角形。**
     * 方塊的頂面是 2 個三角形 —— 點左半邊與點右半邊會得到**不同的 `Face` 物件**，
     * 而使用者眼中那是同一個面。比三角形的話同一個面會被選進去兩次，
     * 而**畫面上完全看不出來**（標示畫的是區域邊界，兩份疊在一起），
     * 只有「選了幾個」那個數字會說謊（坑第 20 條）。
     */
    let sameFaces = null;
    if (el.kind === 'face' && el.face) {
      sameFaces = new Set(regionOf(el.obj.mesh(), el.face).faces);
    }
    return this.editSels.findIndex(e => {
      if (e.kind !== el.kind) return false;
      if (el.kind === 'vertex') return e.vert === el.vert;
      if (el.kind === 'face') return sameFaces ? sameFaces.has(e.face) : false;
      // 同一條邊有兩條半邊，`nearestMarkableEdge()` 回哪一條取決於點在哪一側
      return e.he === el.he || e.he === el.he.twin;
    });
  }

  /**
   * 直接指定要選哪一個面（不經過點選）。
   *
   * 擠出面之後用它把**新長出來的蓋子**選起來，箭頭立刻停在上面，
   * 使用者可以無縫接著用「拉面」調到想要的長度 —— 這就是「擠出只負責
   * 長出來、調整交給已經驗過的拉面」那個分工的接縫。
   *
   * ⚠ 一定要在 `commit()` **之後**呼叫。`commit()` 會走 `revalidate()`，
   * 而擠出換掉了整個網格物件，那裡會把子元素選取清掉（本來就該清，
   * 因為舊的 Face 參考已經不在文件裡了）。先選後 commit 等於白做。
   */
  selectFace(obj, face) {
    if (!obj || !face) { this.clearEditSel(); return false; }
    this.editSels = [{ obj, kind: 'face', face, mesh: obj.mesh() }];
    this._drag = null;
    this._attachEditProxy();
    this._drawEditMark();
    if (this.hooks.onChange) this.hooks.onChange(this);
    return true;
  }

  /**
   * 直接指定要選哪幾個面（不經過點選）。
   *
   * 「選相似」用它把**同一類的面**一次選起來（例如球的全部 32 片 seg）。
   *
   * ⚠ **這一支是 2026-08-27 才補的，在那之前只有單數的 `selectFace()`** ——
   * 因為在那之前**沒有任何一條路會一次選好幾個面**：擠出、內縮一次都只吃
   * 一個面。⛔ 所以它不是「早就該有卻漏寫」，是選相似第一次需要它。
   *
   * ⚠ 跟 `selectEdges()` 一樣，一定要在 `commit()` **之後**呼叫。
   *
   * @param {object} obj
   * @param {object[]} faces
   * @returns {number} 實際選起來的個數
   */
  selectFaces(obj, faces) {
    const list = (faces || []).filter(Boolean);
    if (!obj || !list.length) { this.clearEditSel(); return 0; }
    const mesh = obj.mesh();
    this.editSels = list.map(face => ({ obj, kind: 'face', face, mesh }));
    this._drag = null;
    this._attachEditProxy();
    this._drawEditMark();
    if (this.hooks.onChange) this.hooks.onChange(this);
    return this.editSels.length;
  }

  /**
   * 直接指定要選哪幾條邊（不經過點選）。
   *
   * 環切之後用它把**新切出來的那一圈邊**整圈選起來，箭頭立刻停在上面，
   * 使用者可以無縫接著拉 —— 跟擠出之後自動選中新蓋子（方案 C）同一個分工：
   * **環切只負責加線，改形狀交給已經驗過的「拉邊」。**
   *
   * ⚠ 跟 `selectFace()` 一樣，一定要在 `commit()` **之後**呼叫 ——
   * `commit()` 會走 `revalidate()`，而環切換掉了整個網格物件，
   * 那裡會把子元素選取清掉（本來就該清，舊的 HalfEdge 參考已經不在文件裡了）。
   *
   * @param {object} obj
   * @param {HalfEdge[]} hes
   * @returns {number} 實際選起來的條數
   */
  selectEdges(obj, hes) {
    const list = (hes || []).filter(Boolean);
    if (!obj || !list.length) { this.clearEditSel(); return 0; }
    const mesh = obj.mesh();
    this.editSels = list.map(he => ({ obj, kind: 'edge', he, mesh }));
    this._drag = null;
    this._attachEditProxy();
    this._drawEditMark();
    if (this.hooks.onChange) this.hooks.onChange(this);
    return this.editSels.length;
  }

  /**
   * 直接指定要選哪幾個點（不經過點選）。
   *
   * 「邊上加點」之後用它把**新加的那幾個點**選起來 ——
   * 點很小，不標出來使用者根本看不到加在哪（坑第 21 條）。
   *
   * ⚠ **選取順序就是傳進來的順序**，而「多點連接」是**照順序連的** ——
   * 所以呼叫端如果一次加了好幾個點，要在提示裡講清楚
   * 「要照自己的順序連就重新點一次」，⛔ 不要讓使用者以為程式排的順序
   * 就是他想要的（坑第 24 條：結果不唯一就要講）。
   *
   * ⚠ 跟 `selectEdges()` 一樣，一定要在 `commit()` **之後**呼叫。
   *
   * @param {object} obj
   * @param {Vertex[]} verts
   * @returns {number} 實際選起來的個數
   */
  selectVerts(obj, verts) {
    const list = (verts || []).filter(Boolean);
    if (!obj || !list.length) { this.clearEditSel(); return 0; }
    const mesh = obj.mesh();
    this.editSels = list.map(vert => ({ obj, kind: 'vertex', vert, mesh }));
    this._drag = null;
    this._attachEditProxy();
    this._drawEditMark();
    if (this.hooks.onChange) this.hooks.onChange(this);
    return this.editSels.length;
  }

  /**
   * 把替身擺到元素重心上、轉成目前選的方向，並把 gizmo 掛過去。
   *
   * ── 方向是怎麼做到的（而且沒有動 TransformControls）────────
   * `TransformControls` 的 `space` 只有 `world` 與 `local` 兩種，
   * 而 `local` 取的是**掛著那個物件的世界四元數**。替身是我們自己的
   * 空 Object3D，所以**把方向基底寫進替身的 quaternion ＋ space 設 local**，
   * 箭頭就朝法向了 —— 不必去改它的自訂軸向（那不是它原生擅長的事）。
   *
   * 方向是「世界」時 space 維持 `world`，行為跟原本一模一樣：
   * 替身雖然掛在 node 底下，箭頭仍然朝世界 XYZ。
   * ⚠ 這一點不能偷懶改成「一律 local ＋ 單位四元數」——
   * 物件本身轉過角度時，那會變成沿**物件的軸**走，不是世界軸。
   */
  _attachEditProxy() {
    const el = this.editSel;                 // active，決定掛在哪個物件底下
    const node = el && this.view.nodeOf(el.obj.id);
    if (!node) { this.clearEditSel(); return; }

    if (this._proxy.parent !== node) node.add(this._proxy);
    this._rebaseProxy();
    this.tc.attach(this._proxy);
    this._applyModeLimit();
  }

  /**
   * 把替身重新對準目前的元素（重心 ＋ 方向），並清掉上一次拖曳的快照。
   *
   * 每次「元素動過了」都要叫 —— 放手之後、取消之後、換方向之後。
   * 不重新對準的話，替身會留在上一次的位置與角度，
   * 而**畫面上箭頭的位置就跟它實際會做的事對不起來**。
   */
  _rebaseProxy() {
    const el = this.editSel;
    if (!el) return;
    const mesh = el.obj.mesh();
    /**
     * 🔴 **中心與方向吃的是整份選取，不是 active 那一個。**
     * `elementCenter()` 依 `editPivot` 決定要不要只看 active，
     * `elementBasis()` 則是「法向取全部的和、切線照 active」——
     * 那兩個規則的家在 `edit.js`，這裡只負責把整份傳過去。
     */
    const sels = this.editSels;

    this._proxy.position.copy(elementCenter(mesh, sels, 0.5, this.editPivot));
    this._proxy.scale.set(1, 1, 1);

    if (this.editSpace === 'normal') {
      const b = elementBasis(mesh, sels);
      /**
       * 算不出法向基底（零面積面、孤立點…）→ **退回世界，並且說出來**。
       * 沉默地退回是最糟的做法：使用者會以為「法向」這顆按鈕壞了。
       * 〔坑第 11 條。Blender 那條退化鏈也是同一個原則：永遠有答案〕
       */
      this._proxy.quaternion.copy(b.quat);
      this.tc.space = b.ok ? 'local' : 'world';
      this.lastBasisOk = b.ok;
    } else {
      this._proxy.quaternion.identity();
      this.tc.space = 'world';
      this.lastBasisOk = true;
    }
    /**
     * ⚠ **這裡刻意不清 `_drag`。**
     * `commit()` 會走 `revalidate()` → `_refresh()` → 這一支，
     * 也就是**每放一次手都會經過這裡**。在這裡清掉的話，
     * 放手之後就再也打不了數字了 —— 而那正是最需要打數字的時候。
     * 清掉的時機是「這份快照對不上了」：換選取、換方向、換種類。
     */
  }

  /**
   * 種類（移動／旋轉／縮放）依 kind 設限。
   *
   * ⚠ **原本這裡是一行「一律切回 translate」，而那一行鎖死了整個第 6 期。**
   * 它的理由（「把一個頂點旋轉 30 度沒有意義」）**對點成立，對面完全不成立** ——
   * 梯形、收尖、斜面推拉全被那一行擋在門外。
   * 〔`外部參考調查.md` 第 1 節把它列為「推論出來的東西」的頭號證據〕
   *
   * 所以現在只鎖**點**：一個頂點沒有大小也沒有方向，繞自己轉或縮放
   * 都不會改變任何座標，給了只會讓人拖半天沒反應。
   */
  _applyModeLimit() {
    const el = this.editSel;
    if (el && el.kind === 'vertex' && this.tc.getMode() !== 'translate') {
      this.tc.setMode('translate');
    }
  }

  /** 這個 kind 給不給這種變換（介面拿去決定按鈕要不要灰掉） */
  editModeAllowed(mode) {
    if (!this.editSels.length) return false;
    // 型別在同一次多選裡一定一致，所以問 active 就等於問全部
    return this.editSel.kind !== 'vertex' || mode === 'translate';
  }

  /**
   * 切換方向（世界／法向）。回傳實際生效的方向 ——
   * 要求法向但算不出來時會退回世界，而**回傳值就是真話**，
   * 呼叫端據此更新按鈕與提示，畫面不會說謊。
   */
  setEditSpace(space) {
    this.editSpace = space === 'normal' ? 'normal' : 'world';
    this._drag = null;              // 換了方向，上一次拖曳的軸向就對不上了
    if (this.editSel) {
      this._rebaseProxy();
      if (this.editSpace === 'normal' && !this.lastBasisOk) this.editSpace = 'world';
    }
    return this.editSpace;
  }

  /**
   * 把選到的元素標出來（黃色，沿用貼合那一套）。
   *
   * ⚠ **這不是裝飾。** 點與邊都很細，沒有標示的話使用者無從確認
   * 點中的是不是他想要的那一個 —— 拉出來不如預期時，他分不清是
   * 「選錯了」還是「程式算錯了」。kang 在貼合那一輪實測就回報過這件事
   * （坑第 24 條）：**正確不等於可用，可用的前提是使用者驗得出來。**
   */
  /**
   * 🔴 **顯示點：把選到那個物件所有的點標出來。**
   *
   * kang 2026-08-25：「角點還可以分辨..但是**新增的點**..
   * 除非開線框才可以找的到位置」——「邊上加點」加在邊中間的點
   * 沒有任何視覺線索，等於加了卻不知道加在哪（坑第 21 條）。
   *
   * ⚠ **只在編輯模式、而且過濾器吃得到點的時候畫**（`點` 或 `自動`）。
   * 過濾器切在「邊」「面」時點根本選不到，標出來只是雜訊。
   *
   * 🔴 **點太多就不畫，而且要講出來**（`VERT_DOTS_MAX`）——
   * ⛔ 硬畫下去讓平板卡死是最糟的做法（坑第 11 條的反面：
   * 不是沉默退回，是沉默地把畫面弄壞）。
   * ⚠ **上限是猜的，沒有量過** —— 等 kang 在平板上實測再照真實結果調。
   *
   * @returns {{shown:number, total:number, tooMany:boolean}}
   */
  refreshVertexDots() {
    const obj = this.active;
    const on = this.showVertexDots && this.editMode && obj
            && (this.editFilter === 'vertex' || this.editFilter === 'auto');
    if (!on) { this.view.clearVertexDots(); return { shown: 0, total: 0, tooMany: false }; }

    const node = this.view.nodeOf(obj.id);
    const mesh = obj.mesh();
    if (!node || !mesh) { this.view.clearVertexDots(); return { shown: 0, total: 0, tooMany: false }; }

    const total = mesh.verts.length;
    if (total > VERT_DOTS_MAX) {
      this.view.clearVertexDots();
      return { shown: 0, total, tooMany: true };
    }

    node.updateMatrixWorld(true);
    this.view.setVertexDots(mesh.verts.map(v => node.localToWorld(v.p.clone())));
    return { shown: total, total, tooMany: false };
  }

  /**
   * 🔴 **量測第 2 步：把選到的尺寸標到 3D 畫面上。**
   *
   * kang 2026-08-25 拍板「**只有選到的才顯示**」——
   * 所以它跟選取綁在一起，掛在 `_drawEditMark()` 底下，
   * ⭐ **⛔ 不另外開一條「選取變了要通知我」的鏈** —— 那一支已經是
   * 十六個寫入點共同的出海口，再開一條就是第二份會漂的東西（坑第 31 條）。
   *
   * ⛔ **數字不在這裡算**，一律問 `measureLabels()`（純函式、測得到，
   * 而且跟右邊面板同一個 `measureSelection()` 來源）。
   *
   * @returns {{shown:number,total:number,tooMany:boolean}}
   *          `tooMany` ＝ 超過上限整批沒畫，**呼叫端必須講出實際數量**
   */
  refreshMeasureLabels() {
    const none = { shown: 0, total: 0, tooMany: false, hudText: '' };
    const act = this.editSel;
    const on = this.measureMode !== 'off' && this.editMode && act;

    const give = r => { this.hooks.onMeasure?.(r); return r; };
    if (!on) { this.view.clearMeasureLabels(); return give(none); }

    const node = this.view.nodeOf(act.obj.id);
    const mesh = act.obj.mesh();
    if (!node || !mesh) { this.view.clearMeasureLabels(); return give(none); }

    node.updateMatrixWorld(true);
    const r = measureLabels(mesh, this.editSels, node.matrixWorld, {
      mode: this.measureMode, pivot: this.editPivot,
      /**
       * ⭐ **現算，⛔ 不存**：`量圓` 只是一個旗標，每次重畫都重新問
       * `toCircle(dryRun)` —— 選取一變數字自然就對，
       * ⛔ 沒有第二份資料，也就沒有東西會不同步（坑第 31 條）。
       */
      circle: this.showCircle
    });

    /**
     * 🔴 **`'total'` ⛔ 不畫進 3D 場景** —— 它是畫面左下角那一塊。
     * 〔kang 2026-08-27 實測退回：「顯示集中在 XYZ 控制軸..這樣很難選」——
     * 　那個字站在重心上，而 gizmo 掛的就是同一個點，兩者一定搶位置〕
     *
     * ⚠ **這一支 ⛔ 不碰 DOM**：它是 view 層，只把字交出去，
     * 由 `main.js` 的 `updateMeasureBox()` 寫進 `#measureBox`。
     */
    const hudText = this.measureMode === 'total' ? (r.items[0]?.text || '') : '';
    if (this.measureMode === 'total') this.view.clearMeasureLabels();
    else this.view.setMeasureLabels(r.items);

    return give({ shown: r.shown, total: r.total, tooMany: r.tooMany, hudText });
  }

  /**
   * 換「標尺寸」的模式。
   *
   * ⏭ **`'each'` 目前沒有任何介面在傳進來**（kang 2026-08-27 決定
   * 「每一個先暫時收起來…會在跟你說想法」）——
   * ⛔ **這裡刻意還收得下它**，等他的想法回來時 ⛔ 不必再改這一支。
   * 🔴 ⚠ 但這代表「寫好了而使用者按不到」，⛔ 不可以安靜地留著：
   * 日誌待辦有一條掛著它，`index.html` 那顆按鈕上面的註解也寫了。
   *
   * ⚠ 換完要立刻重畫，⛔ 不能等下一次選取變動 —— 那就是一顆按了沒反應的按鈕。
   */
  setMeasureMode(mode) {
    this.measureMode = (mode === 'off' || mode === 'each') ? mode : 'total';
    return this.refreshMeasureLabels();
  }

  /**
   * 開關「量圓」。
   * ⚠ 換完要立刻重畫，⛔ 不能等下一次選取變動 —— 那就是一顆按了沒反應的按鈕。
   */
  setShowCircle(on) {
    this.showCircle = !!on;
    return this.refreshMeasureLabels();
  }

  _drawEditMark() {
    this.refreshVertexDots();
    this.refreshMeasureLabels();
    const act = this.editSel;
    const node = act && this.view.nodeOf(act.obj.id);
    if (!node) { this.view.clearPickMarks(); return; }

    node.updateMatrixWorld(true);
    const toWorld = p => node.localToWorld(p.clone());
    const mesh = act.obj.mesh();
    const marks = [];

    /**
     * 🔴 **選取的每一個都要畫，而且 active 用不同顏色（橘）。**
     * 中心（「最後選的」那個模式）與法向的切線**都只看 active** ——
     * 分不出哪一個是 active，「箭頭為什麼朝那邊」就沒有答案（坑第 24 條）。
     */
    for (const el of this.editSels) {
      const role = el === act ? 'active' : 'src';

      if (el.kind === 'vertex') {
        marks.push({ kind: 'vertex', points: [toWorld(el.vert.p)], role });

      } else if (el.kind === 'edge') {
        marks.push({
          kind: 'edge', points: [toWorld(el.he.v.p), toWorld(el.he.to.p)], role
        });

      } else if (el.kind === 'face') {
        /**
         * 面：畫**共面區域的邊界邊**，一條邊一個 mark。
         *
         * ⚠ 不可以拿 `elementVerts()` 那份頂點去串成迴圈 —— 它是從 Set 出來的，
         * **順序是任意的**，方塊的一個正方形面會被畫成蝴蝶結。
         * 〔2026-08-23 kang 實測截圖抓到。幾何是對的，畫出來的意思是錯的〕
         */
        for (const [a, b] of regionBoundaryEdges(mesh, el.face)) {
          marks.push({ kind: 'edge', points: [toWorld(a.p), toWorld(b.p)], role });
        }
      }
    }

    /**
     * 🔴 **指到的那個東西：變大，⛔ 不換顏色**（kang 2026-08-26 拍板）。
     *
     * ⭐ **已經選到的就疊在原本那個標記上**（`hover: true`），
     * 於是「黃色又變大」＝「已經選到，而且你正指著它」。
     * ⚠ 這正是不用顏色的理由：兩個狀態會同時發生，
     * 換顏色的話那一刻要決定誰贏，而那個決定怎麼做都會騙人。
     *
     * 沒被選到的則另外加一個 `role:'hover'` 的白色標記。
     */
    this._appendHoverMark(marks);

    this.view.setPickMarks(marks);
  }

  /** 把 hover 疊到既有標記上，或另外加一個 */
  _appendHoverMark(marks) {
    const h = this._hover;
    if (!h) return;
    const node = this.view.nodeOf(h.obj.id);
    if (!node) return;
    node.updateMatrixWorld(true);
    const toWorld = p => node.localToWorld(p.clone());

    /** 已經選到了 → 疊上去就好，⛔ 不要再畫一份（會有 z-fighting） */
    const already = this.editSels.some(el => this._sameHover(el, h));
    if (already) {
      for (const m of marks) m.hover = m.hover || this._markIsFor(m, h, toWorld);
      if (marks.some(m => m.hover)) return;
    }

    if (h.kind === 'vertex') {
      marks.push({ kind: 'vertex', points: [toWorld(h.vert.p)], role: 'hover', hover: true });
    } else if (h.kind === 'edge') {
      marks.push({
        kind: 'edge', points: [toWorld(h.he.v.p), toWorld(h.he.to.p)],
        role: 'hover', hover: true
      });
    } else if (h.kind === 'face') {
      const mesh = h.obj.mesh();
      for (const [a, b] of regionBoundaryEdges(mesh, h.face)) {
        marks.push({
          kind: 'edge', points: [toWorld(a.p), toWorld(b.p)], role: 'hover', hover: true
        });
      }
    }
  }

  /**
   * 這個既有標記畫的是不是 hover 指到的那個元素。
   *
   * ⚠ 用**世界座標端點比對**，因為 `marks` 裡存的已經是座標、不是元素了。
   * 容許值取 `1e-9`：那是同一個 `Vector3` 經過同一條換算的差距，
   * ⛔ 不是「差不多就好」的容許值。
   */
  _markIsFor(m, h, toWorld) {
    if (h.kind === 'vertex') {
      return m.kind === 'vertex' && m.points[0].distanceTo(toWorld(h.vert.p)) < 1e-9;
    }
    if (h.kind === 'edge' && m.kind === 'edge') {
      const a = toWorld(h.he.v.p), b = toWorld(h.he.to.p);
      const [p, q] = m.points;
      return (p.distanceTo(a) < 1e-9 && q.distanceTo(b) < 1e-9)
          || (p.distanceTo(b) < 1e-9 && q.distanceTo(a) < 1e-9);
    }
    return false;
  }

  /**
   * 拖曳開始 → 拍一份初始狀態。**這是整個互動模型的地基。**
   *
   * 記的是三樣東西：受影響的頂點、它們現在的座標、以及替身此刻的位姿。
   * 之後每一幀都拿這三樣重算一次，不疊在上一幀的結果上。
   */
  _beginEditDrag() {
    const el = this.editSel;
    if (!el) { this._drag = null; return; }
    const verts = elementVerts(el.obj.mesh(), this.editSels);
    this._drag = {
      verts,
      base: snapshotVerts(verts),
      start: {
        pos: this._proxy.position.clone(),
        quat: this._proxy.quaternion.clone(),
        /**
         * 🔴 **軸要在這裡記下來，⛔ 不可以事後去問 `tc.axis`。**
         *
         * ⚠ **kang 2026-08-25 實測抓到的**：拖完箭頭，數值欄看得到數字，
         * 但去改那個數字「**似乎沒作用**」——「似乎」兩個字是關鍵，
         * 因為它**有時候會動、有時候不會**。
         *
         * 原因：`TransformControls` 的 `axis` 是**滑鼠停在哪根把手上**，
         * 不是「這次在拖哪根軸」。放手之後只要指標掃過空白處，
         * 它就被清成 `null`（`TransformControls.js` 有三個地方清它）——
         * 於是 `editDragValue()` 回 `null`，打的數字被丟掉。
         * 而如果指標是**直接從把手移出畫布**到工具列，畫布收不到
         * `pointermove`，`axis` 就還留著 —— **所以會時好時壞。**
         *
         * ⭐ 這跟「記初始座標、每幀從初始值重算」是同一條：
         * **軸也是這次拖曳的初始狀態的一部分**，不是可以事後再問的東西。
         * 〔日誌：記初始值的價值不是手感，是正確性〕
         */
        axis: this.tc.axis,
        mode: this.tc.getMode()
      },
      cancelled: false
    };
  }

  /**
   * 拖曳替身 → 把變換寫回頂點座標。
   *
   * 🔴 **從初始座標重算，不是增量累加。**
   * 舊做法是「這一幀的 proxy 位置減掉上一幀」，而它是被逼出來的：
   * 頂點跟著移動之後元素重心也跑到 proxy 的新位置，拿絕對值算會每幀
   * 重複套用一次，一拖就飛出去。記了初始值之後**那個問題自動消失**，
   * 而且旋轉與縮放才做得對 —— 增量累加沒辦法正確累積旋轉。
   *
   * ⚠ **拖曳中不跑 refreshAfterEdit()。** 它走訪所有的邊，是 O(邊數)，
   * 而這支每一幀都會跑。放進熱路徑就是坑第 3、22 條的第三次。
   * 放手時（committing）才跑一次，由呼叫端在 onEditDrag 裡做。
   */
  _writeBackEdit(committing) {
    const el = this.editSel;
    if (!el) return;
    const d = this._drag;
    /**
     * 沒有快照就什麼都不做。會走到這裡的只有一種情況：
     * `objectChange` 比 `dragging-changed` 早一步送到（換 three.js 版本
     * 時順序可能變）。**寧可這一幀不動，也不要拿錯的基準去算** ——
     * 拿舊基準算出來的東西不會報錯，只會把模型悄悄改成另一個形狀。
     */
    if (!d || d.cancelled) return;

    applyElementTransform(d.verts, d.base, d.start, {
      pos: this._proxy.position,
      quat: this._proxy.quaternion,
      scale: this._proxy.scale
    });
    this.view.markGeomDirty();        // 沒有這行，畫面不會更新（見 scene.js）

    if (committing) {
      this._drawEditMark();
      /**
       * ⚠ 快照**刻意留著**（不 rebase）—— 放手之後數值輸入框還要拿它
       * 把精確數字套回初始座標。替身重新對準的時機改由呼叫端決定，
       * 因為它要先跑完連帶重算與 commit。
       */
    }
    if (this.hooks.onEditDrag) this.hooks.onEditDrag(committing, el);
  }

  /**
   * 拖到一半反悔 → 把初始座標寫回去。
   *
   * **取消不是一個功能，是「什麼都不做」** —— 這正是記初始值換來的東西。
   * 增量累加的年代做不到：程式手上根本沒有「沒動過的樣子」。
   *
   * @returns {boolean} 有沒有真的取消掉什麼
   */
  cancelEditDrag() {
    const d = this._drag;
    if (!d || d.cancelled) return false;
    restoreVerts(d.verts, d.base);
    d.cancelled = true;
    this._proxy.position.copy(d.start.pos);
    this._proxy.quaternion.copy(d.start.quat);
    this._proxy.scale.set(1, 1, 1);
    this.view.markGeomDirty();
    this._drawEditMark();
    return true;
  }

  /**
   * 目前這一次拖曳「在哪根軸上做了多少」。給數值輸入框顯示用。
   *
   * ⚠ **只在拉單一一根箭頭時才給得出數字。** 拉平面把手或螢幕空間把手時
   * 沒有「一個值」這種東西，回 `null`，介面要據此把輸入框停掉並說明 ——
   * **沉默地顯示一個看起來像數字的東西，比沒有數字更糟**（坑第 20 條）。
   *
   * @returns {{axis:string, mode:string, value:number, unit:string}|null}
   */
  editDragValue() {
    const d = this._drag;
    /**
     * 🔴 **軸與種類都讀「拖曳開始時記下來的」，⛔ 不要讀 `tc.axis`。**
     * 理由寫在 `_beginEditDrag()` 那段長註解裡（kang 抓到的「時好時壞」）。
     *
     * ⚠ 種類也要比對：拖完之後如果去按了「旋轉」，這份位移快照就對不上了，
     * 這時**老實回 `null`**，讓呼叫端說「先拉一下箭頭」——
     * ⛔ 不要拿位移的快照去算旋轉的數字（那會是一個沒有人驗得出來的數）。
     */
    const axis = d && d.start ? d.start.axis : null;
    if (!d || !axis || !['X', 'Y', 'Z'].includes(axis)) return null;
    if (d.start.mode && d.start.mode !== this.tc.getMode()) return null;
    const mode = d.start.mode || this.tc.getMode();

    if (mode === 'translate') {
      const dir = this._axisDir(axis, d.start.quat);
      const off = new THREE.Vector3().subVectors(this._proxy.position, d.start.pos);
      return { axis, mode, value: off.dot(dir), unit: 'cm' };
    }
    if (mode === 'scale') {
      return { axis, mode, value: this._proxy.scale[axis.toLowerCase()], unit: '倍' };
    }
    // 旋轉：把「從初始到現在」的四元數換成繞那根軸轉了幾度
    const dq = d.start.quat.clone().invert().premultiply(this._proxy.quaternion);
    const e = new THREE.Euler().setFromQuaternion(dq, 'XYZ');
    return { axis, mode, value: THREE.MathUtils.radToDeg(e[axis.toLowerCase()]), unit: '°' };
  }

  /**
   * 把一個精確的數字套到目前這一次拖曳上（取代拖出來的量）。
   *
   * **這跟拖曳走的是同一段程式** —— 兩者都只是「拿一個位姿去套那份初始座標」，
   * 差別只在位姿是拖出來的還是打出來的。記初始值之後這件事是免費的。
   *
   * 下料尺寸本來就是**打出來的**，不是拖出來的。
   *
   * @returns {boolean} 有沒有套上去
   */
  applyEditNumber(num) {
    const d = this._drag;
    const info = this.editDragValue();
    if (!d || !info || !Number.isFinite(num)) return false;

    const k = info.axis.toLowerCase();
    if (info.mode === 'translate') {
      this._proxy.position.copy(d.start.pos)
        .addScaledVector(this._axisDir(info.axis, d.start.quat), num);
    } else if (info.mode === 'scale') {
      /**
       * ⚠ **0 是合法的，不要擋。**
       * 沿**法向**縮到 0 就是「壓平」—— 一個完全合理而且有用的操作
       * （工具列那顆「壓平」底下走的就是這條路）。
       * 沿切線縮到 0 才可能把面壓成零面積，而那件事已經有人管：
       * `refreshAfterEdit()` 會回報 `degenerate` 並跳提醒。
       *
       * 〔原本這裡有一行 `if (num === 0) return false`，而且是**沉默地拒絕** ——
       * 　打了 0 按 Enter 什麼都不會發生，也不講為什麼（坑第 11 條）。
       * 　**程式沒資格替人決定做不做得出來**（跟 `nonPlanarFaces()` 只提醒不擋同一條）。〕
       */
      this._proxy.scale.set(1, 1, 1);
      this._proxy.scale[k] = num;
    } else {
      const e = new THREE.Euler(0, 0, 0, 'XYZ');
      e[k] = THREE.MathUtils.degToRad(num);
      this._proxy.quaternion.copy(d.start.quat)
        .multiply(new THREE.Quaternion().setFromEuler(e));
    }

    applyElementTransform(d.verts, d.base, d.start, {
      pos: this._proxy.position,
      quat: this._proxy.quaternion,
      scale: this._proxy.scale
    });
    this.view.markGeomDirty();
    this._drawEditMark();
    if (this.hooks.onEditDrag) this.hooks.onEditDrag(true, this.editSel);
    return true;
  }

  /**
   * 一根箭頭在**替身的父座標系**（＝網格自己的座標系）裡指向哪。
   *
   * 位移是寫進 `_proxy.position` 的，而那是父座標系的量 ——
   * 所以要換算的是「世界／替身」到「父」，不是到世界。
   *
   * ⚠ **要問的是拖曳開始時那一份四元數，不是替身現在的。**
   * 放手之後替身會重新對準（幾何變了，法向也跟著變），
   * 拿新的去換算，打進去的數字就會沿著**另一根軸**走 ——
   * 而數字看起來完全正常。
   */
  _axisDir(axis, quat) {
    const u = new THREE.Vector3(
      axis === 'X' ? 1 : 0, axis === 'Y' ? 1 : 0, axis === 'Z' ? 1 : 0);
    if (this.tc.space === 'local') {
      return u.applyQuaternion(quat || this._proxy.quaternion);
    }
    // 世界方向 → 父座標系：除掉 node 的世界旋轉
    const node = this._proxy.parent;
    if (!node) return u;
    const q = new THREE.Quaternion();
    node.getWorldQuaternion(q);
    return u.applyQuaternion(q.invert());
  }

  /**
   * Esc ＝ 取消這一次拖曳。
   *
   * ⚠ 掛在 window 的 capture 階段，而且**只在真的正在拖的時候才吃掉事件** ——
   * 否則會把 `main.js` 那個「Esc 清除選取」整個蓋掉，
   * 而那看起來會像「Esc 有時候沒作用」，是最難查的一種。
   */
  _initEditKeys() {
    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !this.tc.dragging || !this.editSel) return;
      if (this.cancelEditDrag()) {
        e.stopPropagation();
        e.preventDefault();
        if (this.hooks.onEditCancel) this.hooks.onEditCancel();
      }
    }, true);
  }

  /**
   * 貼合模式。跟分片一樣要把 gizmo 收起來 ——
   * 三支箭頭會擋在物件前面，而這裡要點的是物件表面上的點／邊／面。
   */
  /** 見建構子 `knifeMode` 上方那段：這個判斷原本散在五個地方 */
  /**
   * ⚠ **鋼筆一定要算進來**（2026-08-29 加）—— 否則畫的時候 gizmo 還掛著，
   * 而 gizmo 會把按下去的事件吃掉，第一筆就畫不出來。
   */
  get inPickMode() {
    return this.seamMode || this.mateMode || this.knifeMode || this.penMode
      || this.guideMode;
  }

  /**
   * 🔴 **參考線模式**（2026-08-31 第 1 階段）。
   *
   * ── 為什麼它也算 `inPickMode` ────────────────────────
   * ⚠ **⛔ 這一階段還沒有任何東西要「點」**（線是打數字加的）——
   * 但它照樣要進來，理由是**另一半**：`inPickMode` 會把 gizmo 收起來
   * （`tc.enabled = false`）。**參考線那一排開著的時候⛔ 不應該拖得動物件** ——
   * 那是規格上寫的「跟拖物件會不會打架」那條。
   *
   * ⭐ 而**第 3 階段要點線的時候，這個閘門已經在了**，⛔ 不必再改一次。
   *
   * ⚠ **⛔ 不要順手接 `setDrawInput()`**（刀具與鋼筆那一對接了）——
   * 那是「左鍵空出來給畫、轉視角換到右鍵」，而這一階段
   * **左鍵完全沒有用途**，接了只會讓轉視角莫名其妙變成右鍵。
   */
  setGuideMode(on) {
    this.guideMode = !!on;
    this.tc.enabled = !this.inPickMode;
    this._refresh();
    if (this.helper) this.helper.visible = !this.inPickMode;
    return this.guideMode;
  }

  setMateMode(on) {
    this.mateMode = !!on;
    this.tc.enabled = !this.inPickMode;
    this._refresh();
    if (this.helper) this.helper.visible = !this.inPickMode;
    return this.mateMode;
  }

  /**
   * 🔴 **刀具模式。**
   *
   * ⚠ **gizmo 一定要關掉** —— 開著的話那三根箭頭會擋在畫面中間，
   * 而使用者正要在那附近點兩下定切線。跟貼合、分片同一個理由。
   */
  setKnifeMode(on) {
    this.knifeMode = !!on;
    this.tc.enabled = !this.inPickMode;
    this._refresh();
    if (this.helper) {
      this.helper.visible = !this.inPickMode;
    }
    /**
     * 🔴 **「按住拖」在刀具模式下要讓給一筆畫，轉視角換到右鍵／兩指。**
     *
     * ⚠ **這是唯一的入口。** 進出刀具有四條路
     * （`toggleKnifeMode`／`cancelKnifeMode`／`exitOtherModes`／切完自動退出），
     * 在那四處各寫一次還原就是靠紀律 —— 漏掉一處的症狀是
     * **離開刀具之後左鍵再也轉不動視角**，而且沒有任何錯誤。
     * 〔坑第 31 條：與其讓好幾條路對齊，不如換一個只有一條路的定義〕
     */
    if (this.view && this.view.setDrawInput) this.view.setDrawInput(this.knifeMode);
    /** 換模式就把上一次輕點的時間忘掉，⛔ 不要讓它跨模式湊成一次「雙擊」 */
    this._lastKnifeTap = null;
    this._stroke = null;
    return this.knifeMode;
  }

  /**
   * 🔴 **鋼筆模式**（kang 2026-08-27 決定要做，⛔ 畫在地板上）。
   *
   * ⭐ **手勢那一層跟刀具完全一樣，而且是同一支函式**
   * （`setDrawInput()`）：左鍵／單指空出來給畫，轉視角換到右鍵／兩指。
   * ⛔ 不要在這裡另寫一份 —— 那就是兩條要對齊的路（坑第 31 條）。
   *
   * ⚠ **離開時一定要把畫到一半的東西丟掉** —— 留著的話下次進來會接續
   * 畫上一次的半條線，而畫面上什麼都看不到（坑第 21 條）。
   */
  setPenMode(on) {
    this.penMode = !!on;
    this.tc.enabled = !this.inPickMode;
    this._refresh();
    if (this.helper) this.helper.visible = !this.inPickMode;
    if (this.view && this.view.setDrawInput) this.view.setDrawInput(this.penMode);
    if (!this.penMode && this.view && this.view.clearPenPreview) {
      this.view.clearPenPreview();
    }
    this._pen = null;
    this._penDown = null;
    this._lastPenTap = null;
    this._penHover = -1;
    this._penClosing = false;
    this._penParked = false;
    this._penConvert = false;
    /**
     * ⚠ **`改點` 也要一起關掉** —— 留著的話下次進鋼筆會直接是改點模式，
     * 而**那時候一個錨點都還沒有，按下去什麼都不會發生**（坑第 21 條）。
     */
    this.penEdit = false;
    this._penSel = -1;
    this._penDragA = null;
    this._penDragH = null;
    /** ⚠ 其他那幾條也要丟掉 —— 留著的話下次進來會接續上一次的形狀 */
    this._penDone = [];
    return this.penMode;
  }

  /**
   * 🔴 **確定這一段曲線。** 右鍵按一下與工具列那顆按鈕**共用這一支**。
   * ⚠ 兩條路指向同一個狀態，⛔ 不要各記一份（坑第 31 條）——
   * `吸中點` 那顆就是同一個做法。
   */
  parkPen() {
    if (!this._pen || !this._pen.a.length) return false;
    this._penParked = true;
    this._drawPenPreview();
    if (this.hooks.onPenPark) this.hooks.onPenPark(this.penCount);
    return true;
  }

  /** 現在畫到幾個錨點（呼叫端拿去決定按鈕給不給按、提示怎麼講） */
  get penCount() { return this._pen ? Math.floor(this._pen.a.length / 2) : 0; }

  /**
   * 🔴🔴 **一條路徑至少要幾個錨點 —— 封不封口不一樣。**
   *
   * | | 最少 | 為什麼 |
   * |---|---|---|
   * | 封起來 | **3** | 兩個點**圍不出面積**，擠出會失敗 |
   * | 不封口 | **2** | 兩個點就是**一條直線** —— 那是一片完全正常的板／牆 |
   *
   * 🔴 **這一條是 2026-08-31 開線上版實測時撞到的**：
   * 舊的 `>= 6`（＝ 3 個錨點）寫死在**五個地方**
   * （`takePen`／`peekPen`／`penNewPath`／`loadPen`，加上 `main.js` 兩顆按鈕），
   * 所以**畫一條兩點的直牆，收工時會被整條丟掉**，
   * 而訊息還說「至少要放 3 個點才圍得出一個形狀」——
   * ⚠ **那句話對封閉是對的，對一條線是胡說**。
   * ⭐ 現在全部改成問這一支，⛔ 不要再寫死數字。
   */
  get penMinPts() { return this.penNoClose ? 2 : 3; }

  /**
   * 🔴 **把畫好的東西交出去，並清空。** 呼叫端負責建物件。
   * ⚠ **少於 3 個錨點回 `null`** —— 兩個點圍不出面積，擠出會失敗。
   */
  /**
   * 🔴 **把目前這一條收起來，開始畫新的一條**（`加一條`，2026-08-30）。
   *
   * ⭐ **畫的時候按、跟事後進 `編輯路徑` 再按，走的是同一支** ——
   * ⛔ 沒有第二條路。
   *
   * ⚠ **少於 3 個錨點不給收** —— 那條圍不出形狀，收進去只會變成垃圾。
   * @returns {{ok:boolean, n?:number, reason?:string}} `n` ＝ 收完之後共幾條
   */
  penNewPath() {
    const min = this.penMinPts;
    if (!this._pen || this._pen.a.length < min * 2) {
      return { ok: false, reason: `目前這一條還不到 ${min} 個點 —— 先把它畫完` };
    }
    this._penDone.push(this._pen);
    this._pen = null;
    this._penSel = -1;
    this._penDragA = null;
    this._penDragH = null;
    this._penParked = false;
    this._penHover = -1;
    this._drawPenPreview();
    return { ok: true, n: this._penDone.length + 1 };
  }

  /** 目前總共幾條路徑（含正在畫的那一條）。呼叫端拿去講話與決定按鈕狀態 */
  get penPathCount() {
    return this._penDone.length + (this._pen && this._pen.a.length ? 1 : 0);
  }

  /**
   * 🔴 **換去改第 `k` 條**（`_penDone` 的索引）——**把它跟 `_pen` 交換**。
   * ⭐ 交換之後「目前這一條」仍然叫 `_pen`，
   * 所以底下每一支⛔ 都不必知道有第幾條這回事。
   */
  _penSwitchTo(k) {
    if (k < 0 || k >= this._penDone.length) return false;
    const cur = this._pen;
    this._pen = this._penDone[k];
    if (cur && cur.a.length) this._penDone[k] = cur;
    else this._penDone.splice(k, 1);
    return true;
  }

  /**
   * 🔴 **把畫好的東西交出去，並清空。** 呼叫端負責建物件。
   *
   * ⚠ **2026-08-30 起回的是【一疊路徑】，⛔ 不再是一條** ——
   * 做洞需要第二條。⭐ 只有一條時就是長度 1 的陣列，
   * ⛔ 呼叫端不必分兩種情形。
   *
   * ⚠ **少於 3 個錨點的那些會被丟掉**（圍不出面積）；
   * **一條都不剩就回 `null`**。
   */
  takePen() {
    /** ⚠ **最少幾個點要問 `penMinPts`** —— ⛔ 不可以寫死 3（見那一則） */
    const need = this.penMinPts * 2;
    const all = [];
    for (const p of this._penDone) {
      if (p && p.a.length >= need) all.push({ closed: true, a: p.a, hi: p.hi, ho: p.ho });
    }
    const p = this._pen;
    if (p && p.a.length >= need) all.push({ closed: true, a: p.a, hi: p.hi, ho: p.ho });
    this._pen = null;
    this._penDone = [];
    this._penDown = null;
    this._lastPenTap = null;
    this._penHover = -1;
    this._penClosing = false;
    this._penParked = false;
    this._penConvert = false;
    this._penSel = -1;
    this._penDragA = null;
    this._penDragH = null;
    if (this.view && this.view.clearPenPreview) this.view.clearPenPreview();
    return all.length ? all : null;
  }

  /**
   * 🔴 **讀出目前這一條，⛔ 但不清空**（`改點` 拖完要把形狀存回物件）。
   *
   * ⚠ **⛔ 不要為了省事改用 `takePen()` 再 `loadPen()` 回去** ——
   * 那中間有一瞬間 `_pen` 是 null，而 `_penSel`／把手全會被清掉，
   * 症狀是「**拖一下，選取就跳掉了**」。
   */
  peekPen() {
    const cp = p => ({ closed: true, a: p.a.slice(), hi: p.hi.slice(), ho: p.ho.slice() });
    const need = this.penMinPts * 2;
    const all = [];
    for (const p of this._penDone) if (p && p.a.length >= need) all.push(cp(p));
    if (this._pen && this._pen.a.length >= need) all.push(cp(this._pen));
    return all.length ? all : null;
  }

  /** 退掉最後一個錨點（畫錯時往回一步）。回傳還剩幾個 */
  penUndo() {
    if (!this._pen) return 0;
    this._pen.a.splice(-2); this._pen.hi.splice(-2); this._pen.ho.splice(-2);
    if (!this._pen.a.length) this._pen = null;
    this._drawPenPreview();
    return this.penCount;
  }

  /**
   * 🔴 **放一個錨點。** `hx/hy` 是**出把手**（相對錨點）。
   *
   * ⭐ **進把手 ＝ 出把手的反向** —— 那就是「平滑」的定義，
   * 而使用者拖出來的那一根本來就只有一個方向。
   * ⚠ **尖角就是兩邊都 0** —— ⛔ 不必另外存旗標（`isPenCorner()` 認得）。
   */
  _penAddAnchor(x, z, hx, hy) {
    if (!this._pen) this._pen = { a: [], hi: [], ho: [] };
    const smooth = Math.hypot(hx, hy) > 1e-9 && !this.penCorner;
    this._pen.a.push(x, z);
    this._pen.hi.push(smooth ? -hx : 0, smooth ? -hy : 0);
    this._pen.ho.push(smooth ? hx : 0, smooth ? hy : 0);
    this._drawPenPreview();
  }

  /**
   * 🔴 **把最後一個錨點的把手設成這個值**（拖曳中一直被呼叫）。
   *
   * ⭐ **進把手 ＝ 出把手的反向** —— 那就是「平滑」的定義。
   * ⚠ **`尖角` 開著就一律 0** —— 那顆是 Alt 的替代品（kang 2026-08-29 選的）。
   */
  _penSetLastHandle(hx, hy) {
    if (!this._pen || !this._pen.a.length) return;
    const i = Math.floor(this._pen.a.length / 2) - 1;
    const smooth = Math.hypot(hx, hy) > 1e-9 && !this.penCorner;
    this._pen.hi[i * 2] = smooth ? -hx : 0;
    this._pen.hi[i * 2 + 1] = smooth ? -hy : 0;
    this._pen.ho[i * 2] = smooth ? hx : 0;
    this._pen.ho[i * 2 + 1] = smooth ? hy : 0;
  }

  /**
   * 🔴 **把「目前最後一個錨點」的出把手清掉。**
   *
   * 〔kang 2026-08-29 第八次提，⛔ 又是我漏的一段〕
   * ⚠ **`尖角` 那顆按鈕原本只管「接下來放的那個點」** ——
   * 而那一段（最後一點 → 下一點）**還吃著最後一點的出把手**，
   * 所以**直線要再下一段才出現**。他的原話：
   * 「就算我按『尖角』..做出來的還是曲線..必須要到 3 與 4 時..才會變成直線」。
   *
   * ⭐ **⛔ 只清出把手，不動進把手** —— 上一段一格都不能變。
   * @returns {boolean} 有沒有真的清掉東西
   */
  penCutOutHandle() {
    if (!this._pen || !this._pen.a.length) return false;
    const i = Math.floor(this._pen.a.length / 2) - 1;
    if (Math.hypot(this._pen.ho[i * 2], this._pen.ho[i * 2 + 1]) < 1e-9) return false;
    this._pen.ho[i * 2] = 0;
    this._pen.ho[i * 2 + 1] = 0;
    this._drawPenPreview();
    return true;
  }

  /**
   * 🔴 **只設第一個錨點的「進把手」**（閉合時拖出來的那一根）。
   *
   * ⚠ **⛔ 不碰它的出把手** —— 那一根管的是第一段（0→1），
   * 而使用者早就調好了。理由的完整版在 `pointerup` 的閉合那一段。
   * ⚠ `尖角` 開著就一律 0（跟 `_penSetLastHandle()` 同一條）。
   */
  _penSetFirstInHandle(hx, hy) {
    if (!this._pen || !this._pen.a.length) return;
    const on = Math.hypot(hx, hy) > 1e-9 && !this.penCorner;
    this._pen.hi[0] = on ? hx : 0;
    this._pen.hi[1] = on ? hy : 0;
  }

  // ═══════════════════════════════════════════════════════
  //  🔴 第 2 階段：`改點`（回頭拉點、拉把手）
  //     kang 2026-08-29 拍板的三件事都在這一區：
  //       ① 連動與否是【錨點的屬性】，⛔ 不是拖曳規則
  //       ② ⛔ 完全不碰原點與 pos／rot／scale
  //       ③ 物件留著（半透明），⛔ 不隱藏
  // ═══════════════════════════════════════════════════════

  /**
   * 🔴 **開關 `改點`。⛔ 不要直接設 `penEdit`** ——
   * 關掉的時候**選取與那兩根把手一定要跟著收掉並重畫**，
   * 否則把手會留在畫面上，而它已經碰不到了（坑第 21 條的反面：
   * 畫面上有的東西一定要是真的）。
   */
  setPenEdit(on) {
    this.penEdit = !!on;
    if (!this.penEdit) this._penSel = -1;
    this._penDragA = null;
    this._penDragH = null;
    this._drawPenPreview();
    return this.penEdit;
  }

  /** `改點` 模式下選到第幾個錨點（⛔ 沒有就是 −1）。呼叫端拿去決定按鈕狀態 */
  get penSel() { return this._penSel; }

  /**
   * 這個錨點是不是圓滑的（呼叫端拿去決定提示怎麼講）。
   * ⚠ **對外只開這一支** —— `_penIsSmooth()` 不檢查範圍，⛔ 不要直接給外面用。
   */
  penIsSmoothAt(i) {
    if (!this._pen || i < 0 || i >= this.penCount) return false;
    return this._penIsSmooth(i);
  }

  /**
   * 🔴 **把一條既有的路徑載回來改**（右側面板 `編輯路徑` 走這一支）。
   *
   * ⚠ **一定要 `slice()` 複製** —— 直接指過來的話，
   * **使用者按取消也已經把物件的資料改掉了**，而畫面上看不出來。
   *
   * @param {{a:number[], hi:number[], ho:number[]}} path 世界座標的錨點與把手
   * @returns {number} 載進來幾個錨點（⛔ 少於 3 個回 0 並且不載）
   */
  loadPen(paths) {
    /**
     * ⚠ **這一支要在 `penNoClose` 擺好之後才呼叫** —— 一條兩點的直牆
     * 才進得來（`editPenPath()` 就是照這個順序）。
     */
    const need = this.penMinPts * 2;
    const list = (Array.isArray(paths) ? paths : [paths])
      .filter(p => p && Array.isArray(p.a) && p.a.length >= need)
      .map(p => ({ a: p.a.slice(), hi: p.hi.slice(), ho: p.ho.slice() }));
    if (!list.length) return 0;
    /** ⚠ **最後一條當成「目前這一條」** —— 其餘進 `_penDone` */
    this._pen = list.pop();
    this._penDone = list;
    this._penSel = -1;
    this._penDragA = null;
    this._penDragH = null;
    /** ⚠ 載進來的是**已經畫完**的東西，⛔ 不要有一條線黏著游標跑 */
    this._penParked = true;
    this._drawPenPreview();
    return this.penPathCount;
  }

  /**
   * 這個錨點是不是圓滑的。
   * 🔴 **規則的權威版在 `build/prim.js` 的 `penIsSmooth()`**，
   * ⛔ 這裡只是轉手 —— `select.js` 碰 DOM，寫在這裡就測不到
   * 〔鐵律二：判定邏輯抽成不碰 DOM 的純函式〕。
   */
  _penIsSmooth(i) {
    return this._pen ? penIsSmooth(this._pen, i) : false;
  }

  /** 把手端點的世界座標（長度 0 ＝ 那一根不存在，回 null） */
  _penHandleWorld(i, side) {
    if (!this._pen) return null;
    const h = side === 'in' ? this._pen.hi : this._pen.ho;
    const dx = h[i * 2], dz = h[i * 2 + 1];
    if (Math.hypot(dx, dz) < 1e-9) return null;
    return new THREE.Vector3(this._pen.a[i * 2] + dx, 0, this._pen.a[i * 2 + 1] + dz);
  }

  /**
   * 🔴 **游標下面有沒有把手的端點**（⛔ 只測「選到的」那個錨點的兩根）。
   *
   * ⚠ **⛔ 不要測全部錨點的把手** —— 那樣畫面上會有一堆端點，
   * 而且**指到哪一根完全不可預期**。選到誰就只有誰的把手可以碰。
   *
   * ⚠ 門檻跟 `_penHitAnchor()` 同一個（12 px），⛔ 不另定一個 ——
   * 兩個門檻遲早會不一致（坑第 31 條）。
   */
  _penHitHandle(clientX, clientY) {
    const i = this._penSel;
    if (!this._pen || i < 0 || i >= this.penCount) return null;
    const r = this._toCanvasPx(clientX, clientY);
    let best = null, bestD = 12;
    for (const side of ['in', 'out']) {
      const w = this._penHandleWorld(i, side);
      if (!w) continue;
      const v = w.clone().project(this.view.camera);
      const px = (v.x + 1) / 2 * r.w, py = (-v.y + 1) / 2 * r.h;
      const dd = Math.hypot(px - r.x, py - r.y);
      if (dd < bestD) { bestD = dd; best = { i, side }; }
    }
    return best;
  }

  /**
   * 設一根把手，另一根照這個錨點本來是什麼決定跟不跟。
   * 🔴 **規則的權威版在 `build/prim.js` 的 `penSetHandle()`**（含
   * 「長度⛔ 不連動」與「`smooth` 要在改之前問」兩則），⛔ 這裡只是轉手。
   */
  _penSetHandleLinked(i, side, dx, dz) {
    if (this._pen) penSetHandle(this._pen, i, side, dx, dz);
  }

  /**
   * 🔴 **尖角⇄圓滑互換**（`改點` 模式下按 `尖角` 那一顆走這裡）。
   *
   * ⚠ **同一顆按鈕在兩個模式下管不同的東西，而⛔ 這不是定位糊掉**：
   * 它管的一直是「**把手要不要存在**」。差別只在對象 ——
   * 畫的時候是「接下來要放的點」，`改點` 的時候是「**選到的那個點**」。
   * ⭐ 而 `改點` 模式下根本沒有「接下來要放的點」這種東西。
   *
   * 🔴 **⛔ 沒有把手的點，這一支長不出把手來** —— 方向不唯一
   * （坑第 24 條：補不到唯一就明講，⛔ 不要猜）。要長就在它身上**按住拖**。
   *
   * @returns {'corner'|'need-drag'|null} 呼叫端照這個講話
   */
  penToggleCornerAt() {
    const i = this._penSel;
    if (!this._pen || i < 0 || i >= this.penCount) return null;
    const has = Math.hypot(this._pen.hi[i * 2], this._pen.hi[i * 2 + 1]) > 1e-9
             || Math.hypot(this._pen.ho[i * 2], this._pen.ho[i * 2 + 1]) > 1e-9;
    if (!has) return 'need-drag';
    this._pen.hi[i * 2] = 0; this._pen.hi[i * 2 + 1] = 0;
    this._pen.ho[i * 2] = 0; this._pen.ho[i * 2 + 1] = 0;
    this._drawPenPreview();
    return 'corner';
  }

  /**
   * 🔴 **游標下面有沒有壓在【線上】**（第 3 階段：點線上 ＝ 加一個點）。
   *
   * ⚠ **門檻一定要用【螢幕距離】，⛔ 不是形狀座標的 cm** ——
   * cm 會隨縮放變，拉遠之後「靠得夠近」就變成不可能達成的條件
   * （跟 `_penHitAnchor()` 同一條，⛔ 不要各定一個）。
   * ⭐ 做法：先在地板座標找到最近的那一點，**再把它投影回螢幕**量距離。
   */
  _penHitSegment(clientX, clientY, g) {
    if (!this._pen || !g) return null;
    const r = penNearestOnPath(this._pen, g.x, g.z);
    if (!r) return null;
    const w = new THREE.Vector3(r.p.x, 0, r.p.y).project(this.view.camera);
    const c = this._toCanvasPx(clientX, clientY);
    const px = (w.x + 1) / 2 * c.w, py = (-w.y + 1) / 2 * c.h;
    return Math.hypot(px - c.x, py - c.y) <= 12 ? r : null;
  }

  /**
   * 🔴 **`改點` 專用：跑遍【所有】路徑找錨點**（做洞之後可能有好幾條）。
   *
   * ⚠ **⛔ 畫的模式不可以用這一支** —— 閉合、轉尖角判斷的是
   * 「**這一條**的第一個／最後一個錨點」，跨路徑就全錯了。
   *
   * ⭐ **做法是暫時把 `_pen` 換過去再問一次**，⛔ 不是複製一份命中測試 ——
   * 兩份遲早會不一致（坑第 31 條）。⚠ 問完**一定要換回來**。
   *
   * @returns {{k:number, i:number}|null} `k` ＝ −1 表示就在目前這一條
   */
  _penHitAnchorAny(clientX, clientY) {
    const i0 = this._penHitAnchor(clientX, clientY);
    if (i0 >= 0) return { k: -1, i: i0 };
    const cur = this._pen;
    for (let k = 0; k < this._penDone.length; k++) {
      this._pen = this._penDone[k];
      const i = this._penHitAnchor(clientX, clientY);
      this._pen = cur;
      if (i >= 0) return { k, i };
    }
    return null;
  }

  /** 同上，但找的是**線上**（點線上 ＝ 加一個點）。⚠ 一樣要換回來 */
  _penHitSegmentAny(clientX, clientY, g) {
    const s0 = this._penHitSegment(clientX, clientY, g);
    if (s0) return { k: -1, seg: s0 };
    const cur = this._pen;
    for (let k = 0; k < this._penDone.length; k++) {
      this._pen = this._penDone[k];
      const s = this._penHitSegment(clientX, clientY, g);
      this._pen = cur;
      if (s) return { k, seg: s };
    }
    return null;
  }

  /**
   * `改點` 的按下去：**把手 → 錨點 → 線上 → 空白**，四層。
   *
   * ⚠ **順序⛔ 不可以動**：
   * ① **把手**排最前 —— 它的端點常常離錨點很近，排後面就永遠碰不到；
   * ② **錨點**排線上前面 —— 錨點本來就在線上，⛔ 不然點錨點會變成加一個點；
   * ③ **線上** ＝ 加一個點（⛔ 不必按鈕）；
   * ④ 都不是 ＝ 放掉選取。
   */
  _penDownEdit(e, g) {
    if (!g || !this._pen) return;
    const hh = this._penHitHandle(e.clientX, e.clientY);
    if (hh) { this._penDragH = hh; return; }
    const ha = this._penHitAnchorAny(e.clientX, e.clientY);
    if (ha) {
      /** ⚠ 命中在別條 → **換過去**，換完「目前這一條」仍然叫 `_pen` */
      if (ha.k >= 0) this._penSwitchTo(ha.k);
      const ia = ha.i;
      this._penSel = ia;
      this._penDragA = {
        i: ia, gx: g.x, gz: g.z,
        ax: this._pen.a[ia * 2], az: this._pen.a[ia * 2 + 1]
      };
      if (this.hooks.onPenEditPick) this.hooks.onPenEditPick(ia, this.penCount);
      this._drawPenPreview();
      return;
    }
    /**
     * 🔴 **壓在線上 ＝ 在那裡插一個錨點，而形狀⛔ 一格都不變。**
     * ⭐ 走 `penAddAnchor()`（de Casteljau），⛔ 不是插一個尖角點 ——
     * 使用者要的是「多一個**可以調**的點」，⛔ 不是改形狀。
     */
    const hs = this._penHitSegmentAny(e.clientX, e.clientY, g);
    if (hs) {
      if (hs.k >= 0) this._penSwitchTo(hs.k);
      const seg = hs.seg;
      const r = penAddAnchor(this._pen, seg.seg, seg.t);
      if (r.ok) {
        this._penSel = r.at;
        /** ⚠ 加完就**直接進入拖曳** —— 使用者多半是想把它拉到別的地方 */
        this._penDragA = {
          i: r.at, gx: g.x, gz: g.z,
          ax: this._pen.a[r.at * 2], az: this._pen.a[r.at * 2 + 1]
        };
        if (this.hooks.onPenEditAdd) this.hooks.onPenEditAdd(r.at, this.penCount);
        if (this.hooks.onPenEditChange) this.hooks.onPenEditChange();
        this._drawPenPreview();
        return;
      }
    }
    /** ⚠ 點空白處 ＝ 放掉選取。⛔ 不要「什麼都不做」——
     *  那樣把手會一直掛在畫面上，使用者不知道怎麼收（坑第 21 條）*/
    this._penSel = -1;
    this._drawPenPreview();
  }

  /**
   * 🔴 **刪掉選到的那個錨點**（工具列 `刪點` 走這一支）。
   *
   * ⭐ 兩側那兩段會**擬合**成一段（kang 2026-08-29 選的做法）——
   * 規則的權威版在 `build/prim.js` 的 `penRemoveAnchor()`。
   * ⚠ **擬合失敗會退回「直接接」，而那件事一定要講出來** ——
   * 所以這裡把 `fitted` 原封不動交給呼叫端。
   *
   * @returns {{ok:boolean, fitted?:boolean, reason?:string}}
   */
  penDeleteSel() {
    const i = this._penSel;
    if (!this._pen || i < 0 || i >= this.penCount) {
      return { ok: false, reason: '先點一個錨點，再按「刪點」' };
    }
    /** ⚠ 下限要**傳下去** —— 不封口的話 2 個點還是一條線（見 `penMinPts`） */
    const r = penRemoveAnchor(this._pen, i, 24, this.penMinPts);
    if (!r.ok) return r;
    this._penSel = -1;
    this._penDragA = null;
    this._penDragH = null;
    this._drawPenPreview();
    return r;
  }

  /** `改點` 的移動：拖錨點／拖把手／只是指著看 —— 三件事 */
  _penMoveEdit(e, g) {
    if (this._penDragA) {
      /**
       * 🔴 **搬錨點。把手是【相對錨點】的量，所以⛔ 什麼都不必做**
       * —— 兩根自動跟著走，形狀平移不變形。
       * 〔測試釘著這一條：拖完 `hi`／`ho` 一格不變〕
       */
      const d = this._snapIf(e, g.x - this._penDragA.gx, g.z - this._penDragA.gz);
      const i = this._penDragA.i;
      this._pen.a[i * 2] = this._penDragA.ax + d.dx;
      this._pen.a[i * 2 + 1] = this._penDragA.az + d.dz;
      this._drawPenPreview();
      return;
    }
    if (this._penDragH) {
      const i = this._penDragH.i;
      const d = this._snapIf(e,
        g.x - this._pen.a[i * 2], g.z - this._pen.a[i * 2 + 1]);
      this._penSetHandleLinked(i, this._penDragH.side, d.dx, d.dz);
      this._drawPenPreview();
      return;
    }
    const h = this._penHitAnchor(e.clientX, e.clientY);
    if (h !== this._penHover) {
      this._penHover = h;
      if (this.hooks.onPenHover) this.hooks.onPenHover(h, this.penCount);
    }
    this._drawPenPreview();
  }

  /**
   * `改點` 的放開手：**結束拖曳，真的動過才叫呼叫端重建形狀**。
   *
   * ⚠ **⛔ 不可以每次 `pointermove` 都重建** —— 擠出重建是 O(點數)，
   * 放進每一幀就是坑第 22 條。拖的時候只更新那條線（便宜），
   * **放開手才讓形狀跟上**。
   */
  _penUpEdit(e, d, dist) {
    const moved = !!(this._penDragA || this._penDragH) && dist > TAP_MOVE;
    this._penDragA = null;
    this._penDragH = null;
    this._drawPenPreview();
    if (moved && this.hooks.onPenEditChange) this.hooks.onPenEditChange();
  }

  /**
   * 預覽線。⚠ `_buildLineOverlay()` 吃的是**兩兩一組的線段**，
   * ⛔ 不是連續折線 —— 串錯的話會多畫一堆不存在的線。
   */
  /**
   * @param {THREE.Vector3} extra 游標那一段的終點（⛔ 已確定時不給）
   * @param {THREE.Vector3} handleAt 把手的端點
   * @param {{closed?:boolean, handleAt?:number}} [opt]
   *        `closed` ＝ 連著閉合那一段一起畫（拖著閉合時要）
   *        `handleAt` ＝ 把手掛在第幾個錨點（預設最後一個）
   */
  _drawPenPreview(extra, handleAt, opt = {}) {
    if (!this.view || !this.view.setPenPreview) return;
    if (!this._pen || !this._pen.a.length) {
      if (this.view.clearPenPreview) this.view.clearPenPreview();
      return;
    }
    const pts = [];
    const dots = [];
    const n = Math.floor(this._pen.a.length / 2);
    for (let i = 0; i < n; i++) {
      dots.push(this._penWorld(i));
    }
    /**
     * 已經放好的那幾段（照拉直之後的樣子畫，⛔ 不要畫成直線騙人）。
     * ⚠ **`改點` 模式一律畫閉合的** —— 那裡改的是**已經畫完**的形狀，
     * 少畫最後那一段的話，看起來像是東西破了一個口。
     * 🔴 **除非這支鋼筆本來就不封口** —— 那它「破了一個口」正是實情，
     * ⛔ 畫成接起來的才是騙人（2026-08-31）。
     */
    const flat = this._penFlatWorld(
      !this.penNoClose && (!!opt.closed || this.penEdit));
    for (let i = 0; i + 1 < flat.length; i++) { pts.push(flat[i], flat[i + 1]); }
    /**
     * 🔴 **其他那幾條也要畫出來**（做洞之後可能有好幾條，2026-08-30）。
     * ⚠ ⛔ 不畫的話，按了 `加一條` 之後**前一條會整個消失** ——
     * 使用者只會以為它不見了（坑第 21 條）。
     * ⭐ 一樣**暫時把 `_pen` 換過去**再問，⛔ 不複製一份拉直的邏輯。
     */
    if (this._penDone.length) {
      const cur = this._pen;
      for (const other of this._penDone) {
        if (!other || other.a.length < 4) continue;
        this._pen = other;
        const f = this._penFlatWorld(!this.penNoClose);
        for (let i = 0; i + 1 < f.length; i++) { pts.push(f[i], f[i + 1]); }
        const m = Math.floor(other.a.length / 2);
        for (let i = 0; i < m; i++) dots.push(this._penWorld(i));
      }
      this._pen = cur;
    }
    /** 游標那一段（還沒放下去的） */
    if (extra) { pts.push(this._penWorld(n - 1), extra); }
    /**
     * 🔴 **正在拖的那一根把手要畫出來** —— 兩端各畫一段，
     * 使用者才看得到「我拉出了多長、往哪邊」。
     * ⚠ ⛔ 少了它，「拖」在畫面上跟「沒動」分不出來（坑第 21 條）。
     *
     * 🔴🔴 **⛔ 但它一定要放在自己的那一組，不可以跟路徑混在一起。**
     * 【kang 2026-08-29 第三次退回，附截圖】混在一起的話，
     * 把手的端點會畫成**跟錨點一模一樣的方塊**，
     * 而使用者看到就會以為「下一個點已經產生了」→ 按下去 →
     * 真的多一個點 → 只能按「退一點」。
     * ⭐ 樣式的差別與完整理由在 `scene.js` 的 `setPenPreview()`。
     */
    const hpts = [], hdots = [];
    if (handleAt) {
      const a = this._penWorld(opt.handleAt === undefined ? n - 1 : opt.handleAt);
      hpts.push(a, handleAt);
      hpts.push(a, new THREE.Vector3(2 * a.x - handleAt.x, 0, 2 * a.z - handleAt.z));
      hdots.push(handleAt);
    }
    /**
     * 🔴 **`改點`：選到的那個錨點的兩根把手【一直畫著】**，
     * ⛔ 不是只有拖的時候才畫 —— 看不到就碰不到。
     *
     * ⚠ **⛔ 只畫選到的那一個** —— 全部都畫的話畫面上一團端點，
     * 而且**指到哪一根完全不可預期**（`_penHitHandle()` 同一條）。
     * ⚠ 長度 0 的那一根⛔ 不畫（`_penHandleWorld()` 回 null）——
     * 畫出來會是一個疊在錨點上的點，跟「這裡有兩個點」分不出來。
     */
    if (this.penEdit && this._penSel >= 0 && this._penSel < n) {
      const av = this._penWorld(this._penSel);
      for (const side of ['in', 'out']) {
        const hw = this._penHandleWorld(this._penSel, side);
        if (hw) { hpts.push(av, hw); hdots.push(hw); }
      }
    }
    /**
     * 🔴 **游標底下那個錨點要變大**〔kang 2026-08-29 要的〕。
     * ⭐ 尺寸與「只變大⛔ 不換色」的規則在 `scene.js` 的 `setPenPreview()`。
     */
    const hot = (this._penHover >= 0 && this._penHover < n)
      ? this._penWorld(this._penHover) : null;
    this.view.setPenPreview(pts, dots, hot, hpts, hdots);
  }

  /**
   * 螢幕座標 → 地板上的一點。
   * ⚠ NDC 的換算跟 `pickElement()` **完全一樣**，⛔ 不要自己另寫一套
   * —— 那一套已經處理過畫布不佔滿視窗的情形（`_toCanvasPx()`）。
   */
  _groundAt(clientX, clientY) {
    if (!this.view || !this.view.groundPoint) return null;
    const r = this._toCanvasPx(clientX, clientY);
    return this.view.groundPoint((r.x / r.w) * 2 - 1, -(r.y / r.h) * 2 + 1);
  }

  /**
   * 🔴 **游標下面有沒有錨點**（回索引，沒有回 −1）。
   *
   * ⚠ **判準用螢幕距離，⛔ 不用世界距離** —— 世界距離會隨縮放變，
   * 拉遠之後「靠得夠近」就變成不可能達成的條件。
   * ⭐ 12 px 跟畫出來的點（11 px）差不多大，指得準也點得到。
   */
  _penHitAnchor(clientX, clientY) {
    if (!this._pen || !this._pen.a.length) return -1;
    const r = this._toCanvasPx(clientX, clientY);
    const n = Math.floor(this._pen.a.length / 2);
    let best = -1, bestD = 12;
    for (let i = 0; i < n; i++) {
      const v = this._penWorld(i).project(this.view.camera);
      const px = (v.x + 1) / 2 * r.w, py = (-v.y + 1) / 2 * r.h;
      const d = Math.hypot(px - r.x, py - r.y);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  _penWorld(i) {
    return new THREE.Vector3(this._pen.a[i * 2], 0, this._pen.a[i * 2 + 1]);
  }

  /** 把目前這一條拉直成世界座標的點串（預覽用；⛔ 不影響存下來的資料） */
  _penFlatWorld(closed) {
    /**
     * ⭐ **拉直走的是 `flattenPenPath()` 本人，⛔ 不是另寫一份近似的** ——
     * 預覽看到的形狀因此**跟按下去做出來的完全一樣**。
     * 〔坑第 31 條：預覽跟結果各算一次，就是兩條要對齊的路〕
     */
    return flattenPenPath(
      { closed: !!closed, a: this._pen.a, hi: this._pen.hi, ho: this._pen.ho }
    ).map(p => new THREE.Vector3(p.x, 0, p.y));
  }

  setSeamMode(on) {
    this.seamMode = !!on;
    this.tc.enabled = !this.inPickMode;
    /**
     * 一定要重跑 _refresh()，它才會依照新的模式決定掛不掛 gizmo。
     * 少了這一行，離開分片模式後 gizmo 不會回來 —— 要等下次點選才復原，
     * 而使用者只會覺得「東西不能拖了」。
     */
    this._refresh();
    if (this.helper) this.helper.visible = !this.inPickMode;
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
