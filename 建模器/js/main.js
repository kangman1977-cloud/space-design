/**
 * main.js — 把各部分接起來
 *
 * 資料流是單向的：
 *
 *   操作 → 改 Doc → hist.commit() → view.sync(doc) → 畫面更新
 *
 * 畫面永遠是「文件的投影」，不會自己存狀態。
 * 所以 Undo 只要把文件換回舊的快照，畫面自然就跟著回去，
 * 不需要為每個功能各寫一套反向操作。
 */

import * as THREE from 'three';
import { Doc, ModelObject, KIND, boolSrcFrom, arraySrcFrom, explodeArray,
         explodeShapes, recenterOrigin, setOriginTo, download, openFile, autosave, loadAutosave,
         penPathToWorld, penPathToLocal, GUIDE_AXES }
  from './core/io.js';
import { defaultSrc, PRIM_SPECS, isSheetPrim } from './build/prim.js';
import { initCSG, csgReady, csgError, canBool, BOOL_OPS, BOOL_LABEL, BOOL_SYMBOL }
  from './build/bool.js';
import { ARRAY_MODES, ARRAY_LABEL } from './build/array.js';
import { History } from './core/history.js';
import { SceneView } from './view/scene.js';
import { Selection, isTouch, VERT_DOTS_MAX } from './view/select.js';
import { Panel, fillPrimMenu } from './ui/toolbar.js';
import { UnfoldPanel } from './ui/unfoldPanel.js';
import { setSeam, isSeam, cutAroundFace, faceIsCutOut, seamBlockReason, isMarkable }
  from './unfold/seam.js';
import { unfoldObject } from './unfold/part.js';
import { faceFrame, edgeFrame, vertexPoint,
         mateFaceToFace, mateEdgeToEdge, mateVertexToVertex } from './core/mate.js';
import { elementVerts, refreshAfterEdit, extrudeFace,
         flattenElements, mergeCoplanarFaces, loopCut, slideEdges, offsetEdgeLoop, edgeRing,
         recalcNormalsOutside, flipNormals, insetFaces, bevelEdges,
         deleteFaces, fillHoles, bridgeLoops, bisect, worldAxisPlane, connectVertsPath,
         splitFaceByEdges, subdivideEdges, separateAlongEdges,
         knifePath, planeCrossSegments, toCircle, faceFromVerts,
         extrudeBoundaryEdges,
         BEVEL_MAX_SEG, PLANAR_TOL_CM } from './core/edit.js';
import { fmtCm } from './core/measure.js';
import { strokeToPicks } from './core/stroke.js';
import { edgeLoop, sharpEdges, similarTo, loopFaces, boundaryEdges, checkerPick } from './core/selectops.js';
import { worldBounds } from './core/align.js';
import { ExportPanel } from './ui/exportPanel.js';
import { SlicePanel } from './ui/slicePanel.js';
import { ImportPanel } from './ui/importPanel.js';

const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════
//  組裝
// ═══════════════════════════════════════════════════════

const doc = new Doc();
const view = new SceneView($('cv'));

const sel = new Selection(view, {
  /**
   * ⚠ **`refreshVertexDots()` 要放在這裡**，不能只放在 `_drawEditMark()`：
   * 那一支只在「子元素選取」變動時走，而**只選到物件、還沒點任何元素**
   * 是最常見的起手式 —— 那時候白圈就該出現了。
   * 〔重複呼叫沒關係：1000 個點重建一次是微秒級，而這裡是事件驅動不是每幀〕
   */
  onChange: () => { sel.refreshVertexDots(); panel.refresh(); updateBar(); },
  /**
   * 量測讀數變了 → 重畫左下角那一塊。
   * ⚠ `select.js` 刻意**不碰 DOM**（它是 view 層），所以字從這裡進 HTML。
   * ⭐ 走 hook ⛔ 不是讓 main.js 自己去問，是因為重畫的時機
   * （選取變動、清空選取、換模式）**只有 select.js 知道**。
   */
  onMeasure: r => updateMeasureBox(r),
  /** 刀具：點下去吸到最近的邊，`hit` 帶著那條邊與邊上的落點 */
  onKnifePick: (hit, info) => knifePick(hit, info),
  /**
   * ⚠ **⛔ 這裡不再自己設按鈕文字**（2026-08-30 改）——
   * 文字的決定權統一在 `updateBar()`。
   * 🔴 **兩個地方各設一次就是兩條要對齊的路**：按了 `加一條` 之後
   * 目前這條明明是 0 個點，按鈕卻還停在「鋼筆 4」（實測照出來的）。
   */
  onPenAdd: () => updateBar(),
  onPenFinish: () => finishPen(),
  /**
   * 🔴 **指到第一個錨點時要講一句** —— Adobe 是用「游標旁出現小圓圈」，
   * 我們沒有自訂游標，⭐ 用提示訊息 ＋ 那個點變大來取代。
   * ⚠ ⛔ 不要每次移動都跳（會洗版）：只在「剛指到」那一下講。
   */
  onPenHover: (i, n) => {
    if (i === 0 && n >= 3) {
      toast('按下去就接回起點　⭐ 想讓最後那一段也是彎的，就【按住拖】');
    } else if (i === n - 1 && n >= 1) {
      toast('在這個點上：【點一下】＝ 下一段走直線、【按住拖】＝ 下一段走曲線');
    }
  },
  /**
   * ⚠ **確定曲線要講一句** —— 畫面上的變化是「那條線不再跟著游標跑」，
   * ⛔ 不講的話跟「當掉了」分不出來（坑第 21 條）。
   */
  onPenPark: n => toast(`這一段曲線固定了（${n} 個點）　`
    + '接下來按左鍵就是放下一個點'),
  /**
   * 🔴 **開著「不封口」時按到起點：⛔ 什麼都不做，但一定要講原因。**
   * ⚠ ⛔ 不講的話，使用者只會覺得「按了沒反應」（坑第 21 條）——
   * 而他按的那一下在別的狀態下是有作用的，這種沉默最難查。
   */
  onPenNoClose: () => toast('開著「不封口」時⛔ 不接起來 —— '
    + '這支鋼筆畫的是一條線。要圍成形狀請先關掉「不封口」', true),
  /**
   * ⚠ **轉尖角一定要講一句** —— 畫面上只有一根把手消失，
   * ⛔ 不講的話跟「按錯了」分不出來（坑第 21 條）。
   */
  onPenConvert: (had, dragged) => toast(dragged
    ? '這個點長出把手了 —— 接下來那一段會是【曲線】（已經畫好的那一段沒有變）'
    : (had
        ? '這個點轉成尖角了 —— 接下來那一段會是【直線】（已經畫好的那一段沒有變）'
        : '這個點本來就是尖角，接下來那一段本來就是直線')),
  /**
   * 🔴 **`改點`：選到一個錨點要講一句** —— 畫面上的變化只有「多了兩根把手」，
   * ⛔ 不講的話使用者不知道那兩根是可以拖的（坑第 21 條）。
   */
  onPenEditPick: (i, n) => {
    const sm = sel.penIsSmoothAt(i);
    toast(`選到第 ${i + 1} 個點（共 ${n} 個）　`
      + (sm
          ? '⭐ 這是【圓滑】的點：拖一根把手，另一根會跟著轉方向'
          : '⭐ 這是【尖角】的點：兩根把手各拖各的　'
            + '（在它身上按住拖就長得出把手）')
      + '　拖這個點本身＝搬位置');
  },
  /**
   * 🔴 **`改點`：放開手才重建形狀。**
   * ⚠ ⛔ 不可以每次移動都重建 —— 那是坑第 22 條（每幀迴圈裡的 O(點數)）。
   */
  onPenEditChange: () => applyPenEdit(),
  /**
   * 🔴 **點在線上 → 加了一個點。一定要講一句。**
   * ⚠ 加點**形狀一格都不變**（de Casteljau），所以**畫面上只多一個小點** ——
   * ⛔ 不講的話跟「按錯了、什麼都沒發生」分不出來（坑第 21 條）。
   */
  onPenEditAdd: (at, n) => toast(
    `在線上加了一個點（第 ${at + 1} 個，共 ${n} 個）　`
    + '⭐ 曲線還是同一條，形狀看不出差別 —— 這個點是拿來調的，拖它才會變　'
    + '⚠ 體積會差千分之幾（那是拉直成折線的取樣不同，⛔ 不是形狀變了）'),
  /** 一筆畫：畫的當下只更新預覽（⛔ 這裡不算切點，見 `stroke.js` 檔頭） */
  onKnifeStrokeMove: pts => drawKnifeStroke(pts),
  onKnifeMove: (i, hit) => knifeMoveTo(i, hit),
  onKnifeMoveEnd: ok => knifeMoveEnd(ok),
  /**
   * 🔴 **切點的位置**（給「游標靠近哪一顆」用）。
   * ⭐ **真相只有 `knifePicks` 一份**，`select.js` ⛔ 不存第二份 ——
   * 它問這裡〔跟參考線的 `guideAxis` 同一招〕。
   */
  knifePickPoints: () => knifePicks.map(k => k.world),
  /**
   * 🔴 **游標靠近的那一顆畫大一點**（2026-09-01，kang 提的）。
   *
   * ⚠ **索引可能已經失效**（切點被刪、切完了）—— 所以要問一次
   * `knifePicks[i]` 還在不在，⛔ 不可以直接拿來用。
   * ⭐ **⛔ 不 toast**：游標一動就跳訊息會吵死人，回饋走**畫面**。
   */
  onKnifeHot: i => view.setKnifeHotDot(
    i >= 0 && knifePicks[i] ? knifePicks[i].world : null),
  /** 一筆畫：放開手 → 交點變成切點，**接到既有的那一串後面** */
  onKnifeStroke: (obj, pts, snapMid) => knifeStroke(obj, pts, snapMid),
  onTransform: committing => {
    view.sync(doc);
    if (committing) commit('變換物件');
    else updateBar();
  },
  /**
   * 🔴 **拖曳中「現在正吸著哪幾條參考線」→ 把它們亮起來**（2026-09-01）。
   *
   * ⚠ **⛔ 這裡不 toast** —— `objectChange` 一秒會來幾十次，
   * 而拖曳的過程中一直跳訊息會蓋掉畫面也吵。
   * ⭐ 回饋走**畫面**（線變亮），⛔ 不走文字。〔kang 2026-09-01 選的〕
   */
  onGuideSnap: hits => view.setGuideHot(hits),
  /**
   * 🔴 **鎖著視角還想拖著轉 → 講一句**（2026-09-01）。
   * ⚠ **⛔ 安靜地沒反應**的話，使用者會以為程式壞了〔坑第 21 條那一類〕。
   * ⭐ 訊息要**講得出怎麼解開**，⛔ 不是只說「鎖住了」。
   */
  onViewLockedDrag: () => toast('視角鎖定中，所以轉不動　'
    + '⭐ 要轉的話按「視角」那一組的「鎖定」解開', true),

  // ── 參考線 第 3 階段：在畫面上點／拖（2026-09-01）──────────
  /**
   * ⭐ **方向的真相只有一份**（這支檔案上面那個 `guideAxis`）——
   * `select.js` ⛔ 不存第二份，它問這裡。
   */
  guideAxis: () => guideAxis,

  /**
   * 在畫面上點一下 → **生一條線在那裡**，⛔ 而且下拉自動選中它
   * （＝ 打數字加出來的那條走的是同一條路）。
   */
  onGuideAdd: (ax, v) => {
    if (!doc.addGuide(ax, v)) {
      toast(`那個位置已經有一條 ${GUIDE_AXIS_LABEL[ax]} 的參考線了`, true);
      return;
    }
    guidePicked = v;
    view.syncGuides(doc);
    syncGuideRow();
    commit('加參考線');
    toast(`參考線 ${GUIDE_AXIS_LABEL[ax]} ＝ ${fmtGuide(v)} cm　`
      + `這個方向現在有 ${doc.guides[ax].length} 條`);
  },

  /**
   * 🔴 **點到某條線 ＝ 在下拉裡選了它** —— 同一個狀態、同一個欄位，
   * ⛔ 不是另一套機制（規格檔第 3 階段那一條）。
   */
  onGuidePick: (ax, v) => {
    guidePicked = v;
    syncGuideRow();
    toast(`選到 ${GUIDE_AXIS_LABEL[ax]} ＝ ${fmtGuide(v)} cm　`
      + '⭐ 可以直接拖它，或在位置欄打精確數字');
  },

  /**
   * 拖著一條線走。**拖曳中一路改過去，放手才記一步 Undo。**
   *
   * ⚠ **拖曳中⛔ 不叫 `syncGuideRow()`** —— 那會把下拉整個重建，
   * 一秒幾十次會閃。⭐ 只更新**位置欄**（那是使用者盯著的那個數字）。
   *
   * @returns {boolean} 有沒有真的挪過去（撞到別條線就回 `false`）
   */
  onGuideDrag: (ax, from, to, committing) => {
    if (committing) {
      guidePicked = to;
      syncGuideRow();
      commit('挪參考線');
      toast(`參考線 ${GUIDE_AXIS_LABEL[ax]} → ${fmtGuide(to)} cm`);
      return true;
    }
    if (!doc.removeGuide(ax, from)) return false;
    if (!doc.addGuide(ax, to)) {
      doc.addGuide(ax, from);          // ⚠ 撞到別條 → 原封不動退回去
      return false;
    }
    guidePicked = to;
    view.syncGuides(doc);
    if (document.activeElement !== $('guideNum')) $('guideNum').value = fmtGuide(to);
    return true;
  },

  /**
   * 🔴 **這個視角看不出這個軸 → 講出來，⛔ 不可以安靜地沒反應。**
   * ⚠ 「我明明點了卻什麼都沒發生」是最糟的回饋〔坑第 21 條那一類〕。
   * ⭐ 訊息要**講得出該切到哪個視角**，⛔ 不是只說「不行」。
   */
  onGuideNoAxis: ax => toast(
    `這個視角看不出 ${GUIDE_AXIS_LABEL[ax]} 的位置　`
    + `⭐ 切到 ${GUIDE_AXIS_VIEW[ax]} 再點`, true),
  onSeamPick: hit => seamPick(hit),
  onMatePick: el => matePick(el),
  /** 🔴 原點指定：點到什麼就把原點搬到那裡（2026-09-01） */
  onOriginPick: el => originPick(el),
  onEditPick: (el, info) => editPick(el, info),
  onEditDrag: (committing, el) => editDrag(committing, el),
  onEditCancel: () => editCancelled(),
  // 框選要回報選到幾個，不然拉了一個空框跟拉到東西看起來一樣
  onMarquee: n => toast(n ? `框選到 ${n} 個物件` : '框選範圍內沒有物件', !n),
  /**
   * 🔴 **編輯模式框選子元素 —— 一定要講出數量。**
   *
   * ⚠ 它**連背面一起選**（kang 拍板），所以框到的東西**有一部分你看不見**。
   * 不講數量的話，使用者以為選了 6 條、實際上選了 12 條，
   * 而下一步（導角／分片）會照 12 條做 —— 那是最難查的那種錯
   * （坑第 11、21 條）。
   */
  onMarqueeEdit: r => {
    if (!r) { toast('先選一個已經轉成網格的物件，再框選它的點／邊／面', true); return; }
    if (!r.added) { toast('框選範圍內沒有東西', true); return; }
    const what = r.kind === 'vertex' ? '個點' : r.kind === 'face' ? '個面' : '條邊';
    toast(`框選到 ${r.added} ${what}（含轉過去才看得到的背面）　目前共選 ${r.total} 個`);
  }
});
sel.bindDoc(doc);

// 場景換相機（透視 ↔ 正交）時，gizmo 也要跟著換，否則拖曳方向會對不上畫面
view.onCameraChange = cam => sel.setCamera(cam);

const hist = new History({
  get: () => doc.toJSON(),
  set: state => {
    doc.loadJSON(state);
    view.sync(doc);
    sel.revalidate();
    panel.analysisCache.clear();
  },
  limit: 60
});

const app = {
  doc, view, sel, hist,
  get head() { return doc.head; },
  onEdit: label => { view.sync(doc); commit(label); },
  /**
   * 🔴 **右側面板也要收得掉那些互斥模式**（2026-09-01，原點指定要用）。
   * ⚠ **⛔ 不要讓面板自己去 `sel.setXxxMode(false)` 一個一個關** ——
   * 那會變成第二份互斥規則，而真相只有 `exitOtherModes()` 一份。
   */
  exitOtherModes: keep => exitOtherModes(keep),
  onExplode: obj => explodeSelected(obj),
  /** 🔴 右側面板的 `編輯路徑` —— 回頭改鋼筆物件那一串錨點（第 2 階段） */
  onEditPenPath: obj => editPenPath(obj),
  // 對齊之類的操作要回報「動了幾個」，否則按了沒感覺（坑第 21 條）
  toast: (msg, bad) => toast(msg, bad)
};

const panel = new Panel(app);
const unfoldWin = new UnfoldPanel(app);
const exportWin = new ExportPanel(app);
const sliceWin = new SlicePanel(app);
const importWin = new ImportPanel(app);

// ═══════════════════════════════════════════════════════
//  動作
// ═══════════════════════════════════════════════════════

function commit(label) {
  hist.commit(label);
  view.sync(doc);
  sel.revalidate();
  autosave(doc);
  updateBar();
}

function addPrim(type) {
  const spec = PRIM_SPECS[type];
  const obj = new ModelObject({
    name: (spec ? spec.label : type) + ' ' + (doc.objects.length + 1),
    src: defaultSrc(type),
    // 平板與折板天生就是要拿去展開的板件
    kind: isSheetPrim(type) ? KIND.SHEET : KIND.SOLID,
    color: PALETTE[doc.objects.length % PALETTE.length]
  });

  // 擺在不重疊的地方，並且讓底部貼齊地面
  const box = obj.mesh().bounds();
  const n = doc.objects.length;
  const ring = Math.floor(n / 6);
  const ang = (n % 6) * Math.PI / 3 + ring * 0.4;
  const r = ring === 0 && n === 0 ? 0 : 90 + ring * 90;
  obj.pos.set(Math.cos(ang) * r, -box.min.y, Math.sin(ang) * r);

  doc.add(obj);
  view.sync(doc);
  sel.set([obj.id]);
  commit('新增' + (spec ? spec.label : type));
  toast('新增：' + obj.name);
}

function deleteSelected() {
  /**
   * 🔴 **編輯模式下 `Delete` 一律擋下來。**
   *
   * 這是 2026-08-24 查程式時發現的地雷：使用者在編輯模式選了一個**面**，
   * 按 Delete 想刪那個面 —— 而這一支刪的是**整個物件**。
   * 可以 Undo，但那絕對不是他要的結果，而且他會嚇一跳。
   *
   * 擋下來並講清楚，比「刪掉再叫他 Undo」好得多 ——
   * 而「刪除面」本身還沒做（那是第 6 期剩下的工具之一，
   * 而且「刪除」與「溶解」是兩個不同的指令，結果不唯一就不要猜）。
   */
  if (sel.editMode) {
    toast(sel.editSel
      ? '編輯模式下不能用 Delete —— 它刪的是整個物件。「刪除面」還沒做，先按一次「拉點線面」離開編輯模式'
      : '編輯模式下不能用 Delete（它刪的是整個物件）。要刪物件請先離開編輯模式', true);
    return;
  }
  const list = sel.objects;
  if (!list.length) return;
  for (const o of list) doc.remove(o);
  sel.clear();
  commit(`刪除 ${list.length} 個物件`);
  toast(`刪除 ${list.length} 個物件`);
}

function duplicateSelected() {
  const list = sel.objects;
  if (!list.length) return;
  const made = [];
  for (const o of list) {
    const fresh = new ModelObject({
      name: o.name + ' 複本',
      kind: o.kind,
      src: JSON.parse(JSON.stringify(o.src)),
      pos: o.pos.clone().add(new THREE.Vector3(30, 0, 30)),
      rot: o.rot.clone(),
      scale: o.scale.clone(),
      color: o.color,
      thickness: o.thickness,
      lockScale: o.lockScale
    });
    // 已烘成網格的物件沒有參數可以重建，直接共用同一份網格資料
    if (!o.isParametric) fresh._mesh = o.mesh();
    doc.add(fresh);
    made.push(fresh.id);
  }
  view.sync(doc);
  sel.set(made);
  commit(`複製 ${made.length} 個物件`);
}

/**
 * 布林運算。第一個選取的物件是母體，其餘是拿來挖／併／交的。
 *
 * 產生的新物件存的是「運算樹」而不是算完的三角形，
 * 所以事後還能在面板上改孔徑、改孔的位置。
 */
function boolOp(op) {
  const list = sel.objects;

  const chk = canBool(list.map(o => o.mesh()), list.map(o => o.name));
  if (!chk.ok) { toast(chk.reason, true); return; }

  const base = list[0];
  const obj = new ModelObject({
    name: shortName(list, op),
    kind: base.kind,
    src: boolSrcFrom(list, op),
    pos: base.pos.clone(),
    rot: base.rot.clone(),
    scale: base.scale.clone(),
    color: base.color,
    thickness: base.thickness,
    lockScale: base.lockScale
  });

  // 先試算一次。算不出來就整個放棄，不要在文件裡留下一個壞掉的物件。
  obj.mesh();
  if (obj.error) { toast('布林運算失敗：' + obj.error, true); return; }

  for (const o of list) doc.remove(o);
  doc.add(obj);
  view.sync(doc);
  sel.set([obj.id]);
  panel.analysisCache.clear();
  commit(BOOL_LABEL[op]);
  toast(`${BOOL_LABEL[op]}完成：${list.length} 個物件 → 1 個`);
}

/** 名稱用符號串起來，太長就截短，不然狀態列會被撐爆 */
function shortName(list, op) {
  const s = ` ${BOOL_SYMBOL[op]} `;
  const full = list.map(o => o.name).join(s);
  return full.length <= 28 ? full : `${list[0].name}${s}…（${list.length} 個）`;
}

/**
 * 把選取的物件變成陣列／鏡射。
 *
 * 存的是「排列方式」而不是排完的結果，所以事後改份數、改間距
 * 都是動一個數字的事。也因為數量這個資訊留著，第 3 期展開時
 * 才有辦法出「一張圖 ×N」而不是 N 張一樣的圖。
 */
function arrayOp(mode) {
  const obj = sel.active;
  if (!obj) { toast('先選一個物件', true); return; }
  // 板件的陣列只是把副本拼在一起，用不到布林函式庫，所以不在這裡擋；
  // 真的需要而沒載到時，evalArrayTree 會給出明確的訊息

  const made = new ModelObject({
    name: obj.name + '（' + ARRAY_LABEL[mode] + '）',
    kind: obj.kind,
    src: arraySrcFrom(obj, mode),
    pos: obj.pos.clone(),
    rot: obj.rot.clone(),
    scale: obj.scale.clone(),
    color: obj.color,
    thickness: obj.thickness,
    lockScale: obj.lockScale
  });

  // 先試算一次，算不出來就整個放棄，不要在文件裡留下壞掉的物件
  made.mesh();
  if (made.error) { toast(ARRAY_LABEL[mode] + '失敗：' + made.error, true); return; }

  doc.remove(obj);
  doc.add(made);
  view.sync(doc);
  sel.set([made.id]);
  panel.analysisCache.clear();
  commit(ARRAY_LABEL[mode]);
  toast(`${ARRAY_LABEL[mode]}完成：${made.copies} 份。份數與間距可在右側面板調整`);
}

/** 把陣列打散成一個個獨立物件 */
function explodeSelected(obj) {
  // 陣列走陣列那條，匯入的多形狀件走形狀那條 —— 面板負責只在對的時候給按鈕
  const made = obj.isArray ? explodeArray(obj) : explodeShapes(obj);
  doc.remove(obj);
  for (const o of made) doc.add(o);
  view.sync(doc);
  sel.set(made.map(o => o.id));
  panel.analysisCache.clear();
  commit(`打散成 ${made.length} 個物件`);
  toast(`已打散成 ${made.length} 個獨立物件`);
}

function newDoc() {
  doc.clear();
  doc.head.name = '未命名';
  sel.clear();
  view.sync(doc);
  hist.reset('新建檔案');
  panel.analysisCache.clear();
  panel.refresh();
  updateBar();
  view.frameAll(doc);
}

async function loadFile() {
  try {
    const data = await openFile();
    doc.loadJSON(data);
    sel.clear();
    view.sync(doc);
    hist.reset('讀取檔案');
    panel.analysisCache.clear();
    panel.refresh();
    view.frameAll(doc);
    updateBar();
    toast(`已讀入 ${doc.objects.length} 個物件`);
  } catch (e) {
    toast('讀檔失敗：' + e.message, true);
  }
}

// ═══════════════════════════════════════════════════════
//  介面
// ═══════════════════════════════════════════════════════

const PALETTE = [0x6fa8dc, 0xe0a86f, 0x8fc98f, 0xd08f9e, 0xa89ad0, 0x7fc4c4];

fillPrimMenu($('primType'));

$('add').onclick = () => addPrim($('primType').value);
$('del').onclick = deleteSelected;
$('dup').onclick = duplicateSelected;

$('bUnion').onclick = () => boolOp(BOOL_OPS.UNION);
$('bSub').onclick   = () => boolOp(BOOL_OPS.SUBTRACT);
$('bInt').onclick   = () => boolOp(BOOL_OPS.INTERSECT);

$('aLinear').onclick = () => arrayOp(ARRAY_MODES.LINEAR);
$('aRadial').onclick = () => arrayOp(ARRAY_MODES.RADIAL);
$('aMirror').onclick = () => arrayOp(ARRAY_MODES.MIRROR);

/**
 * 標準視角。
 *
 * 切到正視／側視／上視時**自動打開正交投影** —— 因為那三個視角存在的
 * 意義就是精確對位，而透視投影下遠的東西看起來偏中間，對不準。
 * 切回等角時不自動關掉：使用者可能就是要正交的等角圖（很多 CAD 的預設）。
 */
for (const [id, v] of [['vFront', 'front'], ['vRight', 'right'],
                       ['vTop', 'top'], ['vIso', 'iso']]) {
  $(id).onclick = () => {
    if (v !== 'iso' && !view.isOrtho) setOrtho(true);
    view.setView(v);
    for (const k of ['vFront', 'vRight', 'vTop', 'vIso']) {
      $(k).classList.toggle('on', k === id);
    }
  };
}

$('vOrtho').onclick = () => setOrtho(!view.isOrtho);

function setOrtho(on) {
  const now = view.setProjection(on);
  $('vOrtho').classList.toggle('on', now);
  toast(now ? '正交投影：關掉近大遠小，可以照著畫面對位'
            : '透視投影：看整體量體用');
}

/**
 * 🔴🔴 **鎖定視角**（2026-09-01，kang 提的）。⛔ 只鎖「轉」。
 *
 * ⚠ **訊息一定要講出「平移與縮放還能用」** —— 否則使用者會以為
 * 整個畫面都動不了，而那⛔ 不是事實。
 */
$('vLock').onclick = () => {
  const now = view.setViewLock(!view.viewLocked);
  $('vLock').classList.toggle('on', now);
  toast(now
    ? '視角鎖定：拖曳⛔ 不再轉動畫面　⭐ 平移（右鍵拖／兩指）與縮放照樣可以用'
    : '視角解鎖：拖曳又可以轉了');
};

$('mate').onclick = () => toggleMateMode();
$('seam').onclick = () => toggleSeamMode();
$('edit').onclick = () => toggleEditMode();
$('extrude').onclick = () => extrudeSelected();
$('extrudeEdge').onclick = () => extrudeEdgesSelected();
$('efBoundary').onclick = () => {
  sel.includeBoundary = !sel.includeBoundary;
  /** ⚠ 關掉時把已經選到的外緣清掉 —— ⛔ 不清的話它們還留在選取裡，而使用者以為關了 */
  if (!sel.includeBoundary) sel.clearEditSel && sel.clearEditSel();
  updateBar();
  updateEditNum();
  toast(sel.includeBoundary
    ? '含外緣：開。板子最外圈那些線現在點得到了 —— 選好按「擠出邊」'
    : '含外緣：關。回到平常的行為（外圈點不到）');
};
$('flatten').onclick = () => flattenSelected();
$('toCircle').onclick = () => toCircleSelected();
$('loopCut').onclick = () => loopCutSelected();
$('slide').onclick = () => slideSelected();
$('offsetLoop').onclick = () => offsetLoopSelected();
/** 單顆切換：按鈕上的字就是目前的單位（⛔ 不用 class="on"，見 index.html 那則） */
$('slideUnit').onclick = () => {
  const b = $('slideUnit');
  const toPct = b.dataset.u === 'cm';
  b.dataset.u = toPct ? 'pct' : 'cm';
  b.textContent = toPct ? '％' : '公分';
  /**
   * ⚠ 換單位時把數字也換成該單位的合理預設，⛔ 不要留著上一個單位的值 ——
   * 「1」在公分是 1 公分、在 ％ 是 1%（幾乎看不出動靜），
   * 使用者會以為按鈕壞了（坑第 21 條）。
   */
  $('slideAmt').value = toPct ? 25 : 1;
  $('slideAmt').step = toPct ? 5 : 0.5;
};
$('selRing').onclick = () => selectRingFromEdge();
$('selLoop').onclick = () => selectLoopFromEdge();
$('selRingFaces').onclick = () => selectFaceRingFromEdge();
$('selAllEdges').onclick = () => selectAllEdges();
$('selSharp').onclick = () => selectSharpEdges();
$('selSimilar').onclick = () => selectSimilar();
$('selChecker').onclick = () => selectChecker();
$('inset').onclick = () => insetSelected();
$('bevel').onclick = () => bevelSelected();
$('delFace').onclick = () => deleteFacesSelected();
$('fillHoles').onclick = () => fillHolesOnSelected();
$('bridge').onclick = () => bridgeOnSelected();
$('bisect').onclick = () => bisectSelected();
$('knife').onclick = () => toggleKnifeMode();
$('pen').onclick = () => togglePenMode();
/**
 * 🔴 **控制列上的收工鈕。⛔ 它沒有自己的行為 —— 走的是工具鈕那一支。**
 *
 * ⚠ **⛔ 不要在這裡另寫一份「收工要做什麼」** —— 那就變成兩條要對齊的路
 * （坑第 31 條）。⭐ 跟 `確定曲線`／右鍵那一對同一個做法。
 * 〔為什麼要有這顆：工具鈕搬到左側直條之後，它的名字固定是「刀具」「鋼筆」，
 * 　⛔ 不再能靠它的文字告訴使用者「現在按下去是切下去／完成」〕
 */
$('toolDone').onclick = () => {
  if (sel.knifeMode) toggleKnifeMode();
  else if (sel.penMode) togglePenMode();
};
$('penCorner').onclick = () => togglePenCorner();
$('penEdit').onclick = () => togglePenEdit();
$('penDel').onclick = () => deletePenAnchor();
$('penAddPath').onclick = () => addPenPath();
$('penSnapDeg').oninput = () => {
  const d = +$('penSnapDeg').value;
  if (Number.isFinite(d) && d > 0) sel.penSnapDeg = d;
};
$('penSnap').onclick = () => {
  sel.penSnapAngle = !sel.penSnapAngle;
  updateBar();
  toast(sel.penSnapAngle
    ? `鎖角度：開。線與把手只能走 ${sel.penSnapDeg} 度的倍數`
      + '（桌機按住 Shift 也一樣）'
    : '鎖角度：關。方向自由');
};
/**
 * 🔴🔴 **開放與封閉的兩顆開關**（kang 2026-08-30 拍板的第 ③ 件）。
 *
 * ⚠ **`penUp` 的狀態放在 main.js，⛔ 不放 `select.js`** ——
 * 判準是「**畫的時候看不看得出差別**」：`不封口` 會改變畫的行為
 * （回到起點⛔ 不接起來、預覽⛔ 不畫閉合那一段），所以它在 `select.js`；
 * 而 `往上長` **對畫圖一點影響都沒有**，它只是收工時要帶走的一個參數。
 * ⛔ 放進去就變成 view 層存了一個它永遠用不到的東西。
 */
let penUpFlag = false;
/**
 * 🔴 **改既有物件的路徑時，這兩顆要【寫進那個物件】**（2026-08-31）——
 * ⛔ 只改預覽的話，畫面上的線變開了、東西卻還是實心塊
 * 〔坑第 31 條：預覽跟結果各算一次，就是兩條要對齊的路〕。
 */
function penFlagsToObject() {
  if (!penEditing) return;
  const obj = doc.objects.find(o => o.id === penEditing.id);
  if (!obj || !obj.src) return;
  obj.src.open = !!sel.penNoClose;
  obj.src.up = !!penUpFlag;
  obj.kind = obj.src.open ? KIND.SHEET : KIND.SOLID;
  obj.invalidate();
  view.sync(doc);
  panel.refresh();
}
$('penOpen').onclick = () => {
  sel.penNoClose = !sel.penNoClose;
  penFlagsToObject();
  updateBar();
  toast(sel.penNoClose
    ? '不封口：開。這支鋼筆畫的是【一條線】，回到起點也⛔ 不會接起來　'
      + `⭐ 收工後做成【${penUpFlag ? '牆（數字是高度）' : '板（數字是寬度）'}】，`
      + '厚薄改走物件的「板厚」'
    : '不封口：關。回到原本的行為 —— 頭尾接起來圍成形狀，往上擠成實心塊');
};
$('penUp').onclick = () => {
  penUpFlag = !penUpFlag;
  penFlagsToObject();
  updateBar();
  toast(penUpFlag
    ? '往上長：開。沿著線【立成一道牆】—— 旁邊的數字是【高度】'
    : '往上長：關。沿著線【加厚成一片板】平躺在地上 —— '
      + '旁邊的數字是【寬度】，線在正中間、兩側各一半');
};
$('penPark').onclick = () => {
  if (!sel.parkPen()) toast('還沒有畫任何點', true);
};
$('penUndo').onclick = () => {
  const n = sel.penUndo();
  toast(n ? `退掉一個點，還剩 ${n} 個` : '已經沒有點了');
  updateBar();
};
$('penCancel').onclick = () => cancelPenMode();
$('knifeCancel').onclick = () => cancelKnifeMode();
$('knifeUndoDel').onclick = () => undoKnifeDelete();
$('knifeSnapMid').onclick = () => toggleKnifeSnapMid();
$('separate').onclick = () => separateSelected();
$('vertDots').onclick = () => toggleVertexDots();
$('measureHud').onclick = () => toggleMeasureHud();
$('measureCircle').onclick = () => toggleMeasureCircle();
$('subdivEdge').onclick = () => subdivideEdgesSelected();
$('connectVerts').onclick = () => connectVertsSelected();
$('faceFromVerts').onclick = () => faceFromVertsSelected();
$('splitFace').onclick = () => splitFaceSelected();
/** 換軸要立刻換範圍提示 —— 不換的話那行字會變成謊話（鐵律三） */
$('bisectAxis').onchange = () => updateBisectRange();
/** ⚠ `oninput` 不是 `onchange`：要**打字的當下**就看得到預覽，不是按 Enter 才看到 */
$('bisectAt').oninput = () => updateCutPreview();
$('fixNormals').onclick = () => fixNormalsOnSelected();
$('flipNormals').onclick = () => flipNormalsOnSelected();
for (const b of document.querySelectorAll('.efBtn')) {
  b.onclick = () => setEditFilter(b.dataset.f);
}
for (const b of document.querySelectorAll('.spBtn')) {
  b.onclick = () => setEditSpace(b.dataset.s);
}
for (const b of document.querySelectorAll('.pvBtn')) {
  b.onclick = () => setEditPivot(b.dataset.p);
}
/**
 * 數值輸入：打完按 Enter（或離開欄位）就套上去。
 *
 * ⚠ `change` 事件在手機上是「離開欄位」才發，桌機是「按 Enter 或離開」。
 * 兩個都接才會兩邊行為一樣 —— 事件入口分開、動作邏輯共用，
 * 就是這個專案從第 0 期就在用的那條。
 */
$('editNum').addEventListener('keydown', e => {
  /**
   * 🔴 **Enter 只負責「離開欄位」，⛔ 不要在這裡直接套用。**
   *
   * ⚠ **kang 2026-08-25 實測抓到的**：打完數字按 Enter，數字有生效，
   * 但**接著會跳一句紅字**「先拉一下箭頭，程式才知道你要改哪一根軸」。
   *
   * 原因是這一支原本兩條路都直接套用，而按 Enter 會**兩條都走** ——
   * `keydown` 一次，瀏覽器接著又發 `change` 再一次。
   * 第一次成功、第二次就跳紅字，看起來像「做了又被打槍」。
   *
   * ⭐ 改成 `blur()` 之後**兩邊自然收斂成同一條路**：
   * 桌機按 Enter → 離開欄位 → `change`；手機點別的地方 → `change`。
   * 〔原本的註解說「兩個都接才會兩邊行為一樣」，方向對，
   * 　但**接成兩條會套用兩次** —— 正解是入口分開、**動作只走一條**〕
   */
  if (e.key === 'Enter') { e.preventDefault(); $('editNum').blur(); }
});
$('editNum').addEventListener('change', () => commitEditNumber());
$('unfold').onclick = () => unfoldWin.open();
$('slice').onclick = () => sliceWin.open();
$('importSvg').onclick = () => importWin.open();
$('export3d').onclick = () => exportWin.open();

$('undo').onclick = () => { const l = hist.undo(); if (l) toast('復原：' + l); updateBar(); };
$('redo').onclick = () => { const l = hist.redo(); if (l) toast('重做：' + l); updateBar(); };

$('mMove').onclick = () => setMode('translate');
$('mRot').onclick = () => setMode('rotate');
$('mScale').onclick = () => setMode('scale');

// ═══════════════════════════════════════════════════════
//  貼合
// ═══════════════════════════════════════════════════════

/**
 * 貼合模式：把一個物件的點／邊／面貼到另一個物件的點／邊／面。
 *
 * kang 的原話：「一個物件的點線面可以貼合到另一個物件的點線面」。
 * 跟工具列那個「吸附」不一樣 —— 那個是吸到 1／5／10cm 的網格，
 * 這個是吸到另一個物件的幾何。
 */
let matePick1 = null;

function toggleMateMode() {
  if (!sel.mateMode) exitOtherModes('mate');
  const on = sel.setMateMode(!sel.mateMode);
  $('mate').classList.toggle('on', on);
  matePick1 = null;
  view.clearPickMarks();
  panel.refresh();
  toast(on ? '貼合：先點「要移動的」物件的點／邊／面，再點目標。再按一次離開'
           : '已離開貼合模式');
}

const MATE_NAME = { vertex: '點', edge: '邊', face: '面' };

/**
 * 把點到的元素換算成世界座標的一組點，交給畫面標示出來。
 *
 * 面畫外框、邊畫線段、點畫一顆球。沒有這個的話，點與邊細到
 * 使用者根本無從確認自己點中的是不是想要的那一個。
 */
function mateMarkPoints(el) {
  const M = el.obj.matrix();
  if (el.kind === 'vertex') return [vertexPoint(el.obj, el.vert)];
  if (el.kind === 'edge') {
    return [el.he.v.p.clone().applyMatrix4(M), el.he.to.p.clone().applyMatrix4(M)];
  }
  return el.obj.mesh().faceVerts(el.face).map(v => v.p.clone().applyMatrix4(M));
}

/**
 * 貼合模式下點了畫面。第一下記起來，第二下就貼。
 *
 * 幾何全在 mate.js（不碰 DOM，測得到），這裡只負責流程與回報。
 */
function matePick(el) {
  if (!el || el.kind === 'blocked') return;

  if (!matePick1) {
    matePick1 = el;
    sel.set([el.obj.id]);
    view.setPickMarks([{ kind: el.kind, points: mateMarkPoints(el), role: 'src' }]);
    toast(`來源：「${el.obj.name}」的${MATE_NAME[el.kind]}（黃色）　接著點目標`);
    return;
  }

  /**
   * 同一個物件貼自己沒有意義，而且會把它轉到莫名其妙的方向。
   * 直接擋下來並重新開始，不要讓人以為功能壞了。
   */
  if (el.obj.id === matePick1.obj.id) {
    toast('目標要選另一個物件。已重新開始，請重點來源', true);
    matePick1 = null;
    view.clearPickMarks();
    return;
  }

  /**
   * 兩邊種類要一樣：點對點、邊對邊、面對面。
   * 「把一個點貼到一個面」在數學上做得到（點落到面上），但**面上哪裡？**
   * 沒有唯一答案，做出來的行為使用者猜不到。寧可講清楚，不要亂猜。
   */
  if (el.kind !== matePick1.kind) {
    toast(`要點同一種：來源是${MATE_NAME[matePick1.kind]}，目標也要點${MATE_NAME[matePick1.kind]}`, true);
    return;
  }

  const src = matePick1.obj;
  let r = null;

  if (el.kind === 'face') {
    r = mateFaceToFace(src,
      faceFrame(src, matePick1.face), faceFrame(el.obj, el.face));
  } else if (el.kind === 'edge') {
    r = mateEdgeToEdge(src,
      edgeFrame(src, matePick1.he), edgeFrame(el.obj, el.he));
  } else {
    r = mateVertexToVertex(src,
      vertexPoint(src, matePick1.vert), vertexPoint(el.obj, el.vert));
  }

  matePick1 = null;
  view.clearPickMarks();
  if (!r) return;

  if (!r.moved) { toast('已經貼合了，沒有東西需要移動'); return; }

  src.pos.copy(r.pos);
  src.rot.copy(r.rot);
  commit(`貼合（${MATE_NAME[el.kind]}）`);
  panel.refresh();

  /**
   * 180 度旋轉的軸不唯一，這是數學事實不是 bug。
   * 講出來讓人知道「轉出來的方位可能不是你想的那個，自己再轉一下就好」，
   * 比默默轉一個奇怪的方向好 —— 沉默地做怪事最難查。
   */
  toast(r.ambiguous
    ? `貼合完成。這次要轉 180 度，轉軸不唯一，方位若不對請自己再轉`
    : `貼合完成：「${src.name}」已貼到「${el.obj.name}」`);
}

// ═══════════════════════════════════════════════════════
//  原點指定：把原點搬到你點的那個角／邊／面（2026-09-01）
// ═══════════════════════════════════════════════════════

/**
 * 🔴🔴 **點到什麼，原點就搬到哪裡。**
 *
 * > **kang 要的**：繞著模型上某個特定的地方轉（門的鉸鏈那種）。
 * > ⭐ **⛔ 不新增「基準點」狀態**，擴充**物件本來就有的原點** ——
 * > 存檔、Undo、切換物件全部免費，箭頭也早就畫在原點上。
 *
 * ⚠ **代表點跟【貼合】同一組**（`mate.js` 的那三支）：
 * 點 ＝ 那個頂點／邊 ＝ 中點／面 ＝ 共面區域的中心。
 * ⛔ 不要在這裡自己再定義一次「一個面的中心是什麼」。
 *
 * ⚠ **一次性**：做完就自動退出 —— 這是一個動作，⛔ 不是一個要「收工」的模式。
 */
function originPick(el) {
  const done = () => { sel.setOriginMode(false); panel.refresh(); };

  if (!el || el.kind === 'blocked') {
    toast('這裡點不到東西 —— 請點模型上的一個角、一條邊或一個面', true);
    return;
  }

  /**
   * ⚠ **只能點【自己】那個物件** —— 點別人的角當自己的原點，
   * 東西會留在原地但原點跑到另一個物件上，畫面上完全看不懂那是什麼意思。
   * ⭐ 擋下來並講清楚，⛔ 不要默默照做〔坑第 24 條的同一家族〕。
   */
  const target = sel.active;
  if (!target) { done(); return; }
  if (el.obj.id !== target.id) {
    toast(`要點「${target.name}」自己身上的角／邊／面`, true);
    return;
  }

  /** 世界座標的代表點 —— 三種各自對應貼合已經驗過的那一支 */
  let p = null;
  if (el.kind === 'vertex') p = vertexPoint(el.obj, el.vert);
  else if (el.kind === 'edge') p = edgeFrame(el.obj, el.he).point;
  else if (el.kind === 'face') p = faceFrame(el.obj, el.face).point;
  if (!p) { done(); return; }

  const r = setOriginTo(target, p);
  if (!r.ok) { toast(r.reason, true); done(); return; }
  if (!r.moved) { toast('原點本來就在那裡，沒有東西要搬'); done(); return; }

  /**
   * ⚠ **⛔ 少了 `markGeomDirty()` 畫面上東西會整個跳走** ——
   * 這一支就地改頂點座標，網格物件⛔ 不換人，`_updateNode()` 察覺不到。
   * 〔2026-09-01 `原點置中` 實際踩過，規則的家在 `規格\建模器-核心架構.md`〕
   */
  view.markGeomDirty();

  const f = n => (Math.round(n * 100) / 100);
  toast(`原點已經搬到你點的那個${MATE_NAME[el.kind]}　`
    + `（那個點移了 X ${f(r.offset.x)}、Y ${f(r.offset.y)}、`
    + `Z ${f(r.offset.z)} cm）　⚠ 東西本身一格都沒動`);

  commit('原點搬到指定位置');
  done();
}

// ═══════════════════════════════════════════════════════
//  編輯造型（第 6 期第一刀）：拉點／拉邊／拉面
// ═══════════════════════════════════════════════════════

const EDIT_NAME = { vertex: '點', edge: '邊', face: '面' };
const FILTER_NAME = { auto: '自動', vertex: '點', edge: '邊', face: '面' };
/** Undo 標籤用。三種變換要分得出來，否則使用者不知道要退回哪一步 */
const XF_NAME = { translate: '拉', rotate: '轉', scale: '縮放' };

/**
 * 編輯模式：選物件裡的一個點／邊／面，用 gizmo 把它拉到想要的位置。
 *
 * ⚠ **這一刀不改拓撲**，所以做得到「把已經有的形狀捏形狀」，
 * 做不到鹿角那種「從一個面長出新的一段」（那是擠出面，第二刀）。
 */
/**
 * 三個「點畫面做別的事」的模式互斥。
 *
 * 不互斥的話，`pointerup` 的判斷鏈是照順序寫的，排前面那個會把後面的
 * 整個吃掉 —— 開著編輯就再也點不到分片，而按鈕看起來是亮的。
 * **畫面說「分片開著」，實際上沒有作用**，那比按鈕沒反應更難查。
 */
function exitOtherModes(keep) {
  if (keep !== 'edit' && sel.editMode) { sel.setEditMode(false); $('edit').classList.remove('on'); }
  if (keep !== 'seam' && sel.seamMode) { sel.setSeamMode(false); $('seam').classList.remove('on'); }
  if (keep !== 'mate' && sel.mateMode) {
    sel.setMateMode(false); $('mate').classList.remove('on');
    matePick1 = null; view.clearPickMarks();
  }
  if (keep !== 'pen' && sel.penMode) {
    /**
     * 🔴 **正在改既有物件的路徑 → 一定要走 `endPenEdit()`**，
     * ⛔ 不可以直接 `setPenMode(false)` ——
     * 那樣物件會**永遠停在攤平＋半透明的狀態**，而且看起來像是壞掉了。
     */
    if (penEditing) {
      endPenEdit(true);
    } else {
      sel.takePen(); sel.setPenMode(false);
      /** ⚠ ⛔ 不再改文字 —— 工具鈕的名字永遠是「鋼筆」（2026-08-31）*/
      $('pen').classList.remove('on');
    }
    /** ⚠ **⛔ 這裡不可以 `return`** —— 底下還有刀具要收，漏掉就是
     *  「畫面說刀具關了，實際上沒有」（這一支開頭那則講的正是這件事）*/
  }
  if (keep !== 'knife' && sel.knifeMode) {
    sel.setKnifeMode(false); $('knife').classList.remove('on');
    knifePicks = []; knifeDeleted = []; knifeMoving = null; hideKnifeLine();
  }
  /**
   * 🔴 **參考線也要收**（2026-08-31）。
   * ⚠ 它這一階段**⛔ 不吃畫面上的點擊**，所以⛔ 不會去搶 `pointerup` 那條鏈 ——
   * 但它會**把 gizmo 收起來**（`inPickMode`）。⛔ 不收的話就是
   * 「按了鋼筆，物件卻還是拖不動」，而**畫面上完全沒有線索**。
   */
  if (keep !== 'guide' && sel.guideMode) {
    sel.setGuideMode(false); $('guide').classList.remove('on');
  }
  /**
   * 🔴 **原點指定模式也要收**（2026-09-01）。
   * ⚠ 它的按鈕在**右側面板**（⛔ 不在工具列），所以這裡⛔ 沒有 classList 要清 ——
   * **面板下次 `refresh()` 會照 `sel.originMode` 重畫**。
   */
  if (keep !== 'origin' && sel.originMode) sel.setOriginMode(false);
  /**
   * ⚠ **⛔ 這裡⛔ 不要叫 `syncEditXfRow()`**（2026-09-01 加了又拿掉，記在這裡）。
   *
   * 🔴 **⛔ 兩個理由，第二個才是關鍵**：
   * ① **多餘** —— 上面每一支 `setXxxMode()` 都會 `_refresh()`
   *    → `hooks.onChange` → `updateBar()` → `syncEditXfRow()`。
   *    【已查證 · select.js setEditMode/setMateMode/setSeamMode…】
   * ② 🔴 **時機是錯的** —— 這一支跑在 `setMateMode(true)` **之前**，
   *    那時 `inPickMode` 還是 false ⇒ 在這裡刷，⛔ 收不掉貼合模式那一排。
   *
   * ⭐ **⛔ 我一開始的診斷是錯的**：以為「貼合那條路沒有叫 `updateBar()`」——
   * 那是**只看 `toggleMate()` 表面**得到的推論，⛔ 沒有追進 `setMateMode()`。
   * **真正的病因是 `gEditXf`（外層容器）從來不在 `updateBar()` 的管轄內**，
   * 而它只有 `toggleEditMode()` 會設。〔鐵律一：推論⛔ 不是權威事實〕
   */
}

/**
 * 🔴 **刀具：在模型上指一串位置，照那條路徑切開。**
 *
 * kang 2026-08-25：「切一刀是要用數值控制...**我不能真的自由切我想要
 * 的區塊**..但是刀具我是想要是**自由切**」。
 *
 * ── ⚠ 這一段的舊版本是錯的（2026-08-26 改） ─────────────
 * 舊版寫「底層還是 `bisect()`，差別只在平面從你點的兩個位置算出來
 * （`planeFromTwoRays()`）」—— **那是第一版**，而第一版早就被實測否決、
 * 程式也拿掉了。**日誌／註解會在功能長大之後變成謊話**（坑第 34 條的第二種長相）。
 *
 * **現在的底層是 `knifePath()`** ＝ 在每個位置插一個頂點 → `connectVertsPath()`
 * 依序連起來。⭐ 差別很重要：切點是**模型上的位置**，不是一片往螢幕深處
 * 延伸的刀片 —— 所以轉視角完全不影響，而且**切得出彎的路徑**，不只是平面。
 *
 * ── 兩種輸入並存（kang 2026-08-26 批准）───────────────
 * | 輸入 | 切點落在哪 |
 * |---|---|
 * | **輕點** | 吸到最近的邊，位置就是你指的地方（要精準用這個）|
 * | **一筆畫**（按住拖）| 你的線**穿過邊**的地方（快，但指不了邊上的哪一點）|
 *
 * **同一次切線裡可以混用**：先拖一段，再輕點補幾個精準的位置。
 *
 * ⚠ **它是這個專案第一個「畫面上連續點兩下」的編輯功能**，
 * 所以照貼合模式的骨架走（`exitOtherModes` 那一套），
 * ⛔ 不另開一種模式管理。
 */
let knifePicks = [];

/**
 * 🔴 **剛才刪掉的切點，照【刪掉的順序】疊著**（2026-09-01，`退一步` 用的）。
 *
 * 每一筆是 `{ i, pick }` —— `i` ＝ 它原本排第幾個。
 * ⭐ **記索引⛔ 不是記「最後面」**：kang 要的是**插回原來的位置**，
 * 接到尾巴的話那條線的形狀跟刪之前⛔ 不一樣。
 *
 * ⚠ **⛔ 它跟工具列的「復原」是兩件事**：切點根本⛔ 沒進復原清單
 * （`knifeApply()` 切下去之後才 `commit()`）——
 * 在刀具模式裡按「復原」會退掉**更早的某個模型動作**，那正是要避開的陷阱。
 * 〔照鋼筆 `退一點` 的先例，⛔ 不去動全域的復原〕
 *
 * 🔴 **離開刀具的四個出口都要清掉它**（`toggleKnifeMode`／`cancelKnifeMode`／
 * `knifeApply`／`exitOtherModes`）—— 留著的話下一次進刀具按「退一步」，
 * 會冒出**上一趟**的點。
 */
let knifeDeleted = [];

/**
 * 🔴🔴 **`knifePick()` 被叫過幾次**（2026-09-01，⛔ 這不是計數器，是「第幾下」）。
 *
 * ⚠ **它存在的唯一理由**：分辨「這一筆刪除是不是**同一次快點兩下的第一下**造成的」。
 * `knifeDeleteAt()` 記下當時的號碼，第二下就能用 `seq === 現在 - 1` 認出來。
 *
 * ⭐ **⛔ 刻意不用時間** —— 用時間就要把 `DOUBLE_TAP_MS` 從 `select.js`
 * 抄第二份過來，而「快慢的界線」只能有一個家（坑第 31 條）。
 * 序號⛔ 不需要知道那個界線：`select.js` 已經幫我們判好 `info.double` 了。
 */
let knifePickSeq = 0;

/**
 * 🔴 **正在搬的那一顆切點的【原值】**（2026-09-01，kang 提的）。
 * `null` ＝ 沒在搬。`{ i, orig }`，`orig` 是**搬之前那一顆的完整資料**。
 *
 * ⭐ **存原值⛔ 不是為了 Undo，是為了「彈回原位」**（kang 拍板①）——
 * 拖到吸不到邊的地方時**當場**還原，⛔ 不等放手：
 * 讓他**立刻看到「這裡不行」**，⛔ 而不是放開手才發現白拖一趟。
 *
 * 🔴 **kang 拍板②：搬動⛔ 不進 `退一步`。** 那顆按鈕只管刪除 ——
 * ⛔ 不要因為「順手做得到」就擴大一顆按鈕的意思，
 * 那會讓使用者永遠猜不到按下去會退掉什麼〔功能之間的定位不可以互相模糊〕。
 */
let knifeMoving = null;

function hideKnifeLine() {
  view.clearKnifePreview();
}

/**
 * 🔴 **把目前點過的位置與段落畫出來。**
 *
 * ⚠ **兩件事一起畫**：每個位置一顆小球、每一段一條線 ——
 * 只畫點看不出「連起來會長什麼樣」，只畫線看不出「點在哪」。
 *
 * ⛔ **不再用螢幕上的 SVG 疊層**（第一版那條虛線）：
 * 那是「畫面上的線」，而現在的點是**模型上的實際位置** ——
 * 畫在 3D 裡才會跟著模型走，而**那正是第一版「一直亂跳」的病根**。
 */
function drawKnifePicks() {
  /**
   * 🔴 **切點一變就把「剛才亮的是第幾顆」忘掉** ——
   * ⛔ 少了這一行，重畫之後那顆放大的**再也不會亮回來**
   * （`select.js` 的 `resetKnifeHot()` 上面寫了完整的病因）。
   */
  sel.resetKnifeHot();
  if (!knifePicks.length) { view.clearKnifePreview(); return; }
  const segs = [];
  for (let i = 0; i + 1 < knifePicks.length; i++) {
    segs.push(knifePicks[i].world.clone(), knifePicks[i + 1].world.clone());
  }
  view.setKnifePreview(segs, knifePicks.map(k => k.world.clone()));
}

/**
 * 🔴 **一筆畫進行中的預覽。**
 *
 * ⚠ **跟 `drawKnifePicks()` 分開畫，因為兩者的身分不同**：
 * 已經確定的切點是**結果**，正在畫的這一筆是**還沒送出的輸入**。
 * 混在一起的話，畫到一半放棄（拖出畫布外）會留下看起來像切點的線。
 *
 * ⛔ **仍然畫在 3D 裡，不回去用螢幕上的 SVG 疊層** ——
 * 第一版那條虛線失敗的原因正是「畫在螢幕上」，轉個視角就對不上了。
 */
function drawKnifeStroke(worldPts) {
  if (!worldPts || worldPts.length < 2) { drawKnifePicks(); return; }
  const segs = [];
  for (let i = 0; i + 1 < worldPts.length; i++) {
    segs.push(worldPts[i].clone(), worldPts[i + 1].clone());
  }
  /** 已經點好的那些位置照樣標著 —— 混用時才看得出「接在哪裡後面」 */
  view.setKnifePreview(segs, knifePicks.map(k => k.world.clone()));
}

/**
 * 🔴 **一筆畫放開手：交點變成切點，接到既有的那一串後面。**
 *
 * ⭐ **⛔ 不直接切下去。** kang 要的是「交點自動變成切點」，
 * 不是「畫完就切」—— 那樣就沒辦法**先拖一段、再輕點補幾個精準的位置**了
 * （兩種輸入並存是他拍板的）。
 */
function knifeStroke(obj, localPts, snapMid) {
  if (!obj) return;
  if (obj.isParametric) {
    toast('這個物件還是參數物件 —— 先在右側面板按「轉成可編輯網格」', true);
    drawKnifePicks();
    return;
  }
  const first = knifePicks[0];
  if (first && obj !== first.obj) {
    toast(`刀具一次只能切一個物件 —— 現在切的是「${first.obj.name}」`, true);
    drawKnifePicks();
    return;
  }

  const r = strokeToPicks(obj.mesh(), localPts, { snapMid });
  if (!r.ok) { toast(r.reason, true); drawKnifePicks(); return; }

  const node = view.nodeOf(obj.id);
  if (!node) { toast('這個物件現在不在畫面上', true); drawKnifePicks(); return; }

  /**
   * ⚠ **接上去之前先擋掉「跟上一點落在同一條邊」** ——
   * 混用時很常見（剛剛輕點的那條邊，正好就是這一筆的起點吸到的邊），
   * 而它會長出一條長度 0 的線。
   */
  const sameEdge = (x, y) =>
    (x.a === y.a && x.b === y.b) || (x.a === y.b && x.b === y.a);

  let added = 0;
  for (const pk of r.picks) {
    const last = knifePicks[knifePicks.length - 1];
    if (last && sameEdge(last, pk)) continue;
    knifePicks.push({
      obj, a: pk.a, b: pk.b, p: pk.p,
      world: node.localToWorld(pk.p.clone())
    });
    added++;
  }
  drawKnifePicks();
  updateBar();

  if (added < 2 && knifePicks.length < 2) {
    toast('這一筆只落下一個切點 —— 從一條邊劃到另一條邊，或改用點的', true);
    return;
  }
  /** 🔴 推開過就要講（坑第 11 條：⛔ 不可以安靜地改掉使用者的東西）*/
  const nudge = r.nudged
    ? `　有 ${r.nudged} 個太靠近角落，往內挪了 0.015 cm`
    : '';
  toast(`一筆畫落下 ${added} 個切點（穿過 ${r.crossings} 條邊）${nudge}`
      + `　共 ${knifePicks.length} 個　再按一次「刀具」就切下去`);
}

function toggleKnifeMode() {
  /** 已經在模式裡而且點滿兩個 → 這一按就是「切下去」 */
  if (sel.knifeMode && knifePicks.length >= 2) { knifeApply(); return; }
  if (sel.knifeMode) {
    toast('至少要點兩個位置才切得下去 —— 或按「取消」離開', true);
    return;
  }
  exitOtherModes('knife');
  sel.setKnifeMode(true);
  $('knife').classList.add('on');
  knifePicks = [];
  knifeDeleted = [];
  knifeMoving = null;
  drawKnifePicks();
  panel.refresh();
  updateBar();
  /**
   * ⚠ **一定要把「轉視角換手勢了」講出來**：使用者按住拖的時候
   * 模型不再跟著轉，那看起來就是「壞掉了」——
   * 而且 kang 驗的是畫面，不是原始碼（⛔ 不要用行話）。
   */
  toast('刀具：在模型上點你要切過的位置，或直接按住拖劃一條線（兩種可以混用）。'
      + '點完再按一次「刀具」就切下去，或在最後一點快點兩下接回起點。'
      + '⭐ 下錯了就【點那一個點】把它刪掉（游標靠近它會變大），刪錯按「退一步」；'
      + '【按住那個點拖】就是搬它（會一直吸在邊上，拖到模型的角上會吸住）。'
      + '轉視角改成：桌機按右鍵拖、平板兩指');
}

/**
 * 吸中點的開關。
 *
 * ⚠ **這顆不是「方便」，是平板唯一的路** —— 桌機的 `Shift` 在平板上不存在。
 * 兩條路指向同一個狀態（`sel.knifeSnapMid`），⛔ 不要各記一份（坑第 31 條）。
 */
function toggleKnifeSnapMid() {
  sel.knifeSnapMid = !sel.knifeSnapMid;
  updateBar();
  toast(sel.knifeSnapMid
    ? '吸中點：開。切點會落在邊的正中間'
    : '吸中點：關。切點落在你指的位置');
}

// ── 內建鋼筆 ───────────────────────────────────────────

/**
 * 🔴🔴 **正在「編輯路徑」的那個物件**（第 2 階段，2026-08-29）。
 * `null` ＝ 現在畫的是**新的一條**，⛔ 不是在改既有物件。
 *
 * 存的四樣都是**進去時的原值，出來一定要還原**：
 * | 欄 | 為什麼 |
 * |---|---|
 * | `rot` | 攤平（kang 拍板：編輯時暫時把物件攤平） |
 * | `posY` | 形狀畫在**地板**上，物件浮空的話線跟形狀對不起來 |
 * | `path` | 按**取消**要能整條還原 |
 * | `id` | ⛔ 不存物件本身 —— 中途被刪掉的話會抓到一個不在文件裡的殼 |
 */
let penEditing = null;

/**
 * 🔴 **`改點` 的開關**（工具列那一顆）。
 * ⚠ **點太少就擋下來講原因** —— 那時候沒有東西可以改。
 * 🔴 **最少幾個點問 `sel.penMinPts`**（封起來 3、不封口 2），⛔ 不寫死。
 */
function togglePenEdit() {
  if (sel.penCount < sel.penMinPts) {
    toast(`至少要有 ${sel.penMinPts} 個點才有東西可以改`, true);
    return;
  }
  sel.setPenEdit(!sel.penEdit);
  updateBar();
  toast(sel.penEdit
    ? '改點：開。點一個錨點＝選它、拖它＝搬位置、拖把手＝調曲線。'
      + '⛔ 這時候【不會】放新的點　⭐ 選到的那個點才看得到把手'
    : '改點：關。回到畫的模式，按左鍵就是放下一個點');
}

/**
 * 🔴 **加一條路徑**（工具列 `加一條`，第 3 階段·做洞）。
 *
 * ⭐ **畫的時候按、跟事後進 `編輯路徑` 再按，走的是同一支** ——
 * kang 2026-08-30 要「兩邊都做」，⭐ 而這樣做**只有一條路**
 * 〔坑第 31 條：與其讓兩條路對齊，不如換一個只有一條路的定義〕。
 *
 * ⚠ **⛔ 這裡不判「新的那條會不會變成洞」** —— 那是幾何的事，
 * `classify()` 在生成網格時判（巢狀深度偶數＝實心、奇數＝洞）。
 * 使用者畫在外面就是第二塊，畫在裡面就是洞，**⛔ 不必先宣告**。
 */
function addPenPath() {
  const r = sel.penNewPath();
  if (!r.ok) { toast(r.reason, true); return; }
  /** ⚠ `改點` 開著時要先關掉 —— 接下來是**畫**，⛔ 不是改 */
  if (sel.penEdit) sel.setPenEdit(false);
  updateBar();
  toast(`開始畫第 ${r.n} 條　`
      + '⭐ 畫在剛才那個形狀【裡面】＝ 挖一個洞；'
      + '畫在【外面】＝ 同一個物件裡多一塊');
}

/**
 * 🔴 **刪掉選到的那個錨點**（工具列 `刪點`，第 3 階段）。
 *
 * ⚠ **擬合失敗要講出來** —— kang 選的是「擬合，盡量讓形狀不變」，
 * 而擬合**有可能無解**（兩個切線方向幾乎平行時）。那時會退回「直接接」，
 * ⛔ 安靜地退路的話，使用者會以為形狀本來就該變那麼多。
 */
function deletePenAnchor() {
  const r = sel.penDeleteSel();
  if (!r.ok) { toast(r.reason, true); return; }
  applyPenEdit();
  updateBar();
  toast(r.fitted
    ? `刪掉一個點，剩 ${sel.penCount} 個　`
      + '⭐ 兩側那兩段已經【擬合】成一段 —— 形狀盡量保住了'
    : `刪掉一個點，剩 ${sel.penCount} 個　`
      + '⚠ 這一次【擬合無解】（兩邊的方向幾乎平行），'
      + '所以是直接接起來的 —— 形狀會比較明顯地變一下');
}

/**
 * 🔴 **從既有物件回來改它的路徑**（右側面板 `編輯路徑` 走這一支）。
 *
 * ⭐ **kang 2026-08-29 拍板的三件事都在這裡**：
 * ① 編輯時**暫時把物件攤平**（`rot` 歸零、`pos.y` 歸零）
 * ② ⛔ **完全不碰原點** —— 進來出去都不呼叫 `recenterOrigin()`
 * ③ 物件**留著但半透明**，⛔ 不隱藏（隱藏了就看不到自己在改什麼）
 */
function editPenPath(obj) {
  if (!obj || !obj.src || obj.src.type !== 'pen') {
    toast('只有鋼筆畫出來的物件改得了路徑　'
        + '⚠ 按過「轉成可編輯網格」的話，那串錨點就已經不在了', true);
    return;
  }
  /**
   * 🔴 **最少幾個點要看這個物件封不封口**（不封口的兩點就是一條直牆）——
   * ⛔ 不可以寫死 3，那會讓一條兩點的牆「路徑讀不出來」。
   */
  const minPts = obj.src.open ? 2 : 3;
  const list = (obj.src.paths || [])
    .filter(p => p && Array.isArray(p.a) && p.a.length >= minPts * 2);
  if (!list.length) {
    toast(`這支鋼筆的路徑讀不出來（少於 ${minPts} 個點）`, true);
    return;
  }
  if (Math.abs(obj.scale.x) < 1e-9 || Math.abs(obj.scale.z) < 1e-9) {
    toast('這個物件有一軸的縮放是 0，路徑攤不開 —— 先把縮放改回來', true);
    return;
  }
  exitOtherModes('pen');
  penEditing = {
    id: obj.id,
    rot: obj.rot.clone(),
    posY: obj.pos.y,
    /** ⚠ **全部路徑都要留一份** —— 按取消時要整個還原（做洞之後不只一條） */
    paths: list.map(p => ({ a: p.a.slice(), hi: p.hi.slice(), ho: p.ho.slice() })),
    /**
     * 🔴 **兩顆開關也要留一份**（2026-08-31）—— 編輯途中按得動它們，
     * 而「取消 ＝ 進來時的樣子」⛔ 不可以只還原一半。
     * ⚠ `kind` 也要留：`不封口` 會連動它。
     *
     * 🔴🔴 **工具列那兩顆的狀態也要留一份**（`barOpen`／`barUp`）——
     * ⚠ 進來時我會**照這個物件**把它們擺好，那是**程式改的**，
     * ⛔ 不是使用者按的。收工⛔ 不還原的話，他下一次畫新東西
     * 會莫名其妙變成一道牆 —— **而他從頭到尾沒按過那顆**。
     * ⭐ 這跟 `鎖角度` 不一樣：那顆一直是他自己按的，所以才可以黏著。
     */
    open: !!obj.src.open, up: !!obj.src.up, kind: obj.kind,
    barOpen: !!sel.penNoClose, barUp: !!penUpFlag
  };
  obj.rot.set(0, 0, 0);
  obj.pos.y = 0;
  view.sync(doc);
  view.setGhost(obj.id);
  /** ⚠ **順序不能換**：`setPenMode()` 會把 `_pen` 與 `penEdit` 都清掉 */
  sel.setPenMode(true);
  /**
   * 🔴 **進來改的是【這個物件】，開關就要照它的狀態擺**（2026-08-31）——
   * ⛔ 不照的話，一支不封口的鋼筆會被畫成接起來的，
   * **而使用者以為自己的線變成一圈了**（預覽與結果不一致，坑第 31 條）。
   */
  sel.penNoClose = !!obj.src.open;
  penUpFlag = !!obj.src.up;
  sel.loadPen(list.map(p => penPathToWorld(p, obj)));
  sel.setPenEdit(true);
  $('pen').classList.add('on');
  panel.refresh();
  updateBar();
  const np = list.reduce((s, p) => s + Math.floor(p.a.length / 2), 0);
  toast(`編輯「${obj.name}」的路徑（${list.length} 條、${np} 個點）　`
      + '點一個錨點＝選它、拖它＝搬位置、拖把手＝調曲線、點線上＝加一個點。'
      + '⭐ 按「加一條」可以再畫一條 —— **包在裡面的那條就是洞**。'
      + '⚠ 這個物件暫時被【攤平】而且變半透明，按「完成」就轉回原本的角度');
}

/**
 * 🔴 **拖完一下就把形狀跟上**（`onPenEditChange` 走這一支）。
 * ⚠ ⛔ 這裡**不 commit** —— 一整趟編輯算 undo 的一步，
 * 拖十下就存十步的話「還原」要按十次才回得去。
 */
function applyPenEdit() {
  if (!penEditing) return;
  const obj = doc.objects.find(o => o.id === penEditing.id);
  if (!obj || !obj.src || !obj.src.paths) return;
  const ps = sel.peekPen();
  if (!ps) return;
  const loc = ps.map(p => penPathToLocal(p, obj));
  /** ⚠ 有任何一條換不出本地座標就整批放棄，⛔ 不要寫一半進去 */
  if (loc.some(l => !l)) return;
  obj.src.paths = loc;
  obj.invalidate();
  view.sync(doc);
  updateBar();
}

/**
 * 🔴 **收工：把物件轉回去。**
 * @param {boolean} save `false` ＝ 取消，路徑整條還原成進來時的樣子
 */
function endPenEdit(save) {
  if (!penEditing) return;
  const st = penEditing;
  /** ⚠ **先清掉** —— 免得底下的流程又繞回 `applyPenEdit()` 跑一次 */
  penEditing = null;
  const obj = doc.objects.find(o => o.id === st.id);
  if (obj && obj.src && obj.src.paths) {
    let next = st.paths;
    if (save) {
      const ps = sel.peekPen();
      const loc = ps ? ps.map(p => penPathToLocal(p, obj)) : null;
      /** ⚠ 有任何一條換不出來就**整批保留原樣**，⛔ 不要寫一份壞掉的進去 */
      if (loc && !loc.some(l => !l)) next = loc;
    }
    obj.src.paths = next;
    /** 🔴 取消 ＝ 兩顆開關與種類也回到進來時的樣子（⛔ 不可以只還原路徑） */
    if (!save) {
      obj.src.open = st.open; obj.src.up = st.up; obj.kind = st.kind;
    }
    obj.rot.copy(st.rot);
    obj.pos.y = st.posY;
    obj.invalidate();
  }
  /** 🔴 工具列那兩顆回到**進來之前**的樣子（見 `penEditing` 那則） */
  sel.penNoClose = st.barOpen;
  penUpFlag = st.barUp;
  sel.takePen();
  sel.setPenMode(false);
  view.setGhost(null);
  view.sync(doc);
  $('pen').classList.remove('on');
  if (save) commit('編輯鋼筆路徑');
  panel.refresh();
  updateBar();
  toast(save
    ? '路徑改好了 —— 物件已經轉回原本的角度'
    : '取消了 —— 路徑回到編輯前的樣子');
}

/**
 * 🔴 **鋼筆：在地板上畫一個形狀，畫完直接變成可以拉厚度的物件。**
 * 〔kang 2026-08-27 決定要做；**畫在地板上**是他拍板的〕
 *
 * ⭐ **跟 `匯入線稿` 走同一條路** —— 形狀平躺在地板、往上拉厚度。
 * ⛔ 不另外發明一套，那是他現在已經在用的路。
 */
function togglePenMode() {
  /**
   * 🔴 **正在改既有物件的路徑時，這一顆是「完成」，⛔ 不是收尾建新物件。**
   * ⚠ ⛔ 少了這一行，按下去會用同一條路徑**再建一個新物件**。
   */
  if (penEditing) { endPenEdit(true); return; }
  if (sel.penMode) { finishPen(); return; }
  exitOtherModes('pen');
  sel.setPenMode(true);
  sel.penCorner = false;
  $('pen').classList.add('on');
  panel.refresh();
  updateBar();
  /**
   * ⚠ **一定要把「轉視角換手勢了」講出來** —— 跟刀具同一條理由：
   * 使用者按住拖的時候模型不再跟著轉，那看起來就是「壞掉了」。
   */
  toast('鋼筆：在地板上【點一下】放尖角、【按住拖】放圓滑（拖出來的就是把手）。'
      + '【右鍵按一下】＝ 確定這一段曲線（平板按「確定曲線」）。'
      + '【按住 Shift】＝ 鎖角度（度數在旁邊調，平板按「鎖角度」）。'
      + '畫完【回到第一個點按下去】就接起來（想讓最後那段也彎就按住拖）。'
      + '【換直線或曲線】：回到剛畫好的那個點 —— 點一下＝下一段直線、'
      + '按住拖＝下一段曲線。'
      + '（也可以在最後一點快點兩下）'
      + '　轉視角改成：桌機按右鍵拖、平板兩指');
}

/**
 * 收尾：把畫好的錨點變成一個 `pen` 物件。
 *
 * 🔴 **少於 3 個錨點圍不出面積** —— 擋下來並講原因，
 * ⛔ 不可以安靜地什麼都不做（坑第 21 條）。
 */
function finishPen() {
  /** ⚠ **保險絲**：改既有物件的路徑⛔ 不可以走到「建新物件」這條路 */
  if (penEditing) { endPenEdit(true); return; }
  /** ⚠ **2026-08-30 起 `takePen()` 回的是一疊路徑**（做洞要第二條） */
  const paths = sel.takePen();
  $('pen').classList.remove('on');
  sel.setPenMode(false);
  if (!paths) {
    panel.refresh(); updateBar();
    /** 🔴 **一條線只要 2 個點** —— ⛔ 對它講「圍得出形狀」是胡說 */
    toast(sel.penNoClose
      ? '至少要放 2 個點才有一條線 —— 這次畫的不算'
      : '至少要放 3 個點才圍得出一個形狀 —— 這次畫的不算', true);
    return;
  }
  const h = +$('penH').value;
  const open = !!sel.penNoClose;
  const up = open && penUpFlag;
  if (!Number.isFinite(h) || h <= 0) {
    toast(`${open ? (up ? '高度' : '寬度') : '厚度'}要打一個大於 0 的數字`, true);
    return;
  }
  /**
   * 🔴🔴 **不封口的做出來是【板件】，⛔ 不是實體。**
   * 它是一片**開放的單層面**，厚薄由物件的「板厚」在顯示時加上去
   * （`mesh.shell()`，跟平板、折板走的是同一支）。
   * ⚠ **種類⛔ 不跟著改的話**：板厚欄位根本看不到（那一格只在
   * `kind === SHEET` 時出現）、而 3D 列印會報「這個物件不封閉」——
   * **那是誤報**〔鐵律三：誤報比漏報更糟〕。
   */
  const obj = new ModelObject({
    name: `鋼筆 ${doc.objects.length + 1}`,
    kind: open ? KIND.SHEET : KIND.SOLID,
    src: open ? { type: 'pen', h, paths, open: true, up } : { type: 'pen', h, paths }
  });
  /**
   * ⚠ **原點置中，⛔ 不要讓它留在世界原點** —— 畫在遠處的形狀，
   * 原點留在 (0,0) 的話按旋轉會繞著老遠的地方轉。
   * 〔2026-08-29 剛立的那一則：原點就是旋轉與縮放的中心〕
   */
  doc.add(obj);
  recenterOrigin(obj);
  view.sync(doc);
  sel.set([obj.id]);
  commit('鋼筆');
  panel.refresh();
  updateBar();
  const n = paths.reduce((s, p) => s + Math.floor(p.a.length / 2), 0);
  /**
   * 🔴 **講出來的東西要跟做出來的一致** —— 開放的那條路
   * ⛔ 沒有「高」也⛔ 沒有「洞」，照抄實心塊那句話就是騙人。
   * ⭐ 而**面積是使用者對得了答案的量**（＝ 折線長 × 那個數字），
   * 所以那句話裡放的是面積，⛔ 不是體積（開放的網格算不出體積 ——
   * 那是 2026-08-28 那個假數字的教訓）。
   */
  if (open) {
    /** ⚠ `mesh()` 是**函式**⛔ 不是屬性；剛建好縮放還是 1，所以這就是真值 */
    const m = obj.mesh();
    const area = m ? m.area() : 0;
    toast(`已建立「${obj.name}」：${paths.length} 條線、${n} 個點、`
        + `${up ? '牆高' : '板寬'} ${h} cm　`
        + `⭐ 這是【板件】，面積 ${area.toFixed(2)} cm²（＝ 線長 × ${h}）—— `
        + '厚薄請改右側的「板厚」');
  } else {
    toast(`已建立「${obj.name}」：${paths.length} 條路徑、${n} 個點、高 ${h} cm　`
        + (paths.length > 1
            ? '⭐ 包在裡面的那條已經變成【洞】'
            : '⚠ 曲線是照容許值拉直成折線的（跟匯入線稿同一支）'));
  }
}

function cancelPenMode() {
  /** 🔴 改既有物件的路徑時，「取消」＝ 整條還原，⛔ 不是「剛才畫的不算」 */
  if (penEditing) { endPenEdit(false); return; }
  sel.takePen();
  sel.setPenMode(false);
  $('pen').classList.remove('on');
  panel.refresh();
  updateBar();
  toast('已離開鋼筆，剛才畫的不算');
}

/**
 * 尖角的開關。
 * ⚠ **它是 Alt 的替代品** —— Illustrator 按 Alt 折斷把手，⛔ 而平板上沒有 Alt。
 * 〔kang 2026-08-29 在三個選項裡挑的：一顆看得見的切換鈕，桌機平板同一套〕
 */
function togglePenCorner() {
  /**
   * 🔴 **`改點` 模式下，這一顆管的是【選到的那個點】**，
   * ⛔ 不是「接下來要放的點」。
   *
   * ⚠ **這⛔ 不是定位糊掉**（kang 為切一刀拍板的那條）：
   * 它管的一直是「**把手要不要存在**」，只是對象換了 ——
   * 而 `改點` 模式下**根本沒有「接下來要放的點」這種東西**。
   */
  if (sel.penEdit) {
    const r = sel.penToggleCornerAt();
    if (r === null) { toast('先點一個錨點，再按「尖角」', true); return; }
    if (r === 'need-drag') {
      toast('這個點本來就是尖角 —— 要讓它變圓滑，'
          + '在它身上【按住拖】就長得出把手（憑空長的話方向不唯一）');
      return;
    }
    applyPenEdit();
    toast('這個點轉成尖角了：兩根把手都收掉，它兩側都變直線');
    return;
  }
  sel.penCorner = !sel.penCorner;
  /**
   * 🔴🔴 **開的時候要「連目前這一段也一起變直」，⛔ 不能只管下一個點。**
   *
   * 〔kang 2026-08-29 第八次提〕舊版只讓**接下來放的那個點**沒有把手，
   * 而**那一段還吃著「目前最後一個錨點的出把手」** ——
   * 所以按了尖角，**直線要再下一段才出現**。他的原話：
   * 「就算我按『尖角』..做出來的還是曲線..必須要到 3 與 4 時..才會變成直線」。
   *
   * ⭐ **⛔ 只清出把手，不動進把手** —— 已經畫好的那一段一格都不變。
   * ⚠ 清掉之後**還原得回來**：在那個點上再「按住拖」就長回來
   * （Adobe 的「直線接曲線」那條路）。
   */
  const cut = sel.penCorner ? sel.penCutOutHandle() : false;
  updateBar();
  if (sel.penCorner) {
    toast(cut
      ? '尖角：開。【接下來那一段就是直線】—— 剛才那個點的把手已經收掉'
      : '尖角：開。接下來放的點一律是尖角（就算你用拖的）');
    return;
  }
  toast('尖角：關。按住拖就會放出圓滑的點');
}

function cancelKnifeMode() {
  sel.setKnifeMode(false);
  $('knife').classList.remove('on');
  knifePicks = [];
  knifeDeleted = [];
  knifeMoving = null;
  hideKnifeLine();
  panel.refresh();
  updateBar();
  toast('已離開刀具');
}

/**
 * 點一下 → 加一個位置。
 *
 * ⚠ **點在【已經放好的切點】上 ＝ 刪掉那一個**（kang 2026-09-01 拍板），
 * 跟編輯模式「再點一次取消選取」同一條規則 —— ⛔ 不要另發明一種。
 *
 * ── 🔴 2026-09-01 改掉的兩件事 ──────────────────────
 * | | 舊 | 新 |
 * |---|---|---|
 * | 刪得掉哪一顆 | **只有最後一顆** | **指到哪顆就哪顆** |
 * | 判定範圍 | 世界座標 `0.5` 公分（⚠ **模型拉遠就點不到**）| **螢幕距離**，
 *   跟「游標靠近會變大」同一個範圍 → 🔴 **看到它變大，按下去就一定刪得掉** |
 *
 * ⭐ **索引是 `select.js` 現算好送過來的**（`info.hotIdx`），
 * 這裡⛔ 不自己再算一次距離 —— 兩邊各算一份就會出現
 * 「亮的是這顆、刪掉的是另一顆」，而那是**誤報**（鐵律三）。
 */
function knifePick(hit, info = {}) {
  /**
   * 🔴 **快點兩下 ＝ 從這裡接回起點，然後切下去。**
   *
   * ⚠ **要放在最前面**，⛔ 不可以排在「再點同一處 ＝ 取消最後一點」後面 ——
   * 雙擊的第二下本來就落在剛剛那一點上，排後面會先被當成取消。
   * 〔kang 2026-08-26 拍板：快慢是唯一的差別，逐點按的行為一格都沒變〕
   */
  knifePickSeq++;

  if (info.double) {
    /**
     * 🔴🔴 **先把「這一次快點兩下的【第一下】誤刪掉的那一顆」放回來。**
     *
     * ⚠ **⛔ 這不是保險，是必要的** —— 【實證 2026-09-01，AI 上線先驗當場踩到】：
     * 快點兩下的第一下**⛔ 沒有辦法在當下知道自己是雙擊的第一下**
     * （`info.double` 只有第二下才是真），所以它一定會先走刪除那條路。
     * 🔴 **2 個點快點兩下 → 只剩 1 個，閉合完全沒發生。**
     *
     * ⚠ **舊版⛔ 沒有這個問題，是因為它的判定是「世界座標 0.5 公分」** ——
     * 第一下大多打不中；而新的判定是**螢幕 19 px**，**第一下幾乎必中**。
     * ⭐ **⛔ 教訓不是「雙擊很難」**：**放寬一個判定範圍，會把
     * 原本靠「打不中」而相安無事的兩條路撞在一起。**
     * 〔kang 拍板①：快點兩下維持原樣 —— 這一段就是在守那條〕
     */
    const d = knifeDeleted[knifeDeleted.length - 1];
    if (d && d.seq === knifePickSeq - 1) knifeRestoreLastDelete();
    if (knifePicks.length >= 2) { knifeCloseLoop(); return; }
  }

  /**
   * 🔴 **指到某一個切點 → 刪掉它，前後兩點直接接起來。**
   *
   * ⚠ **要排在 `!hit` 前面**：切點就長在邊上，⛔ 沒有理由讓
   * 「這一下有沒有吸到邊」去左右「刪不刪得掉」——
   * 而且刪點本來就跟「吸到哪條邊」無關。
   */
  const hi = Number.isInteger(info.hotIdx) ? info.hotIdx : -1;
  if (hi >= 0 && hi < knifePicks.length) { knifeDeleteAt(hi); return; }

  if (!hit) { toast('點在物件上 —— 那個位置會吸到最近的一條邊', true); return; }
  if (hit.obj.isParametric) {
    toast('這個物件還是參數物件 —— 先在右側面板按「轉成可編輯網格」', true);
    return;
  }
  /**
   * ⚠ **一次只切一個物件。** 混著點的話後面那些點的索引屬於別的網格，
   * 切下去會**改到使用者沒在看的物件** —— 那正是「選取有兩份資料」
   * 那一輪燒過的病（形狀改對了，只是改錯了對象）。
   */
  const first = knifePicks[0];
  if (first && hit.obj !== first.obj) {
    toast(`刀具一次只能切一個物件 —— 現在切的是「${first.obj.name}」`, true);
    return;
  }

  knifePicks.push(hit);
  drawKnifePicks();
  updateBar();
  toast(knifePicks.length < 2
    ? '再點下一個位置（點在同一個面的另一條邊上，就會切開那個面）'
    : `已點 ${knifePicks.length} 個位置　再按一次「刀具」就切下去`);
}

/**
 * 🔴 **刪掉第 `i` 個切點。**
 *
 * ⚠ **⛔ 不必自己接線**：`drawKnifePicks()` 每次都是照 `knifePicks`
 * 從頭畫一遍，所以「前後兩點接起來」是**免費掉出來的**，
 * ⛔ 不要另外寫一段去補那條線（那就會有第二份真相）。
 */
function knifeDeleteAt(i) {
  const [gone] = knifePicks.splice(i, 1);
  knifeDeleted.push({ i, pick: gone, seq: knifePickSeq });
  drawKnifePicks();
  updateBar();
  /**
   * ⚠ **講「第幾個」而不是「那個點」** —— kang 驗的是畫面，
   * 而畫面上唯一數得出來的量就是**順序與總數**（⛔ 不要用行話）。
   */
  const n = knifePicks.length;
  toast(n >= 2
    ? `刪掉第 ${i + 1} 個切點，還有 ${n} 個　按「退一步」可以放回原位`
    : `刪掉第 ${i + 1} 個切點，還有 ${n} 個 —— ⛔ 不到兩個切不下去`);
}

/**
 * 🔴 **拖曳中：把第 `i` 顆搬到新位置（每一次移動都會進來一次）。**
 *
 * ⚠ **`hit` 可能是 `null`** —— 拖到模型外、或那裡吸不到任何一條邊。
 * 那時候**當場彈回原位**（kang 拍板①），⛔ 不是留在最後一個有效的位置。
 *
 * ⚠ **一次只能切一個物件的規矩照舊** —— 拖到別的物件上也算「不行」。
 * ⛔ 少了這一道，切點的索引會屬於另一個網格，切下去會**改到他沒在看的物件**。
 *
 * ⭐ **⛔ 不記 Undo、⛔ 不進 `退一步`** —— 拖曳中一路改過去，
 * 而整趟拖曳在「切下去」之前本來就還不是文件的一部分。
 */
function knifeMoveTo(i, hit) {
  if (!knifePicks[i]) return;
  if (!knifeMoving) knifeMoving = { i, orig: knifePicks[i] };

  const ok = hit && !hit.obj.isParametric && hit.obj === knifePicks[0].obj;
  knifePicks[i] = ok ? hit : knifeMoving.orig;
  drawKnifePicks();
  updateBar();
}

/**
 * 🔴 **放開手（或被系統收走）。`ok=false` ＝ 這一趟不算，彈回原位。**
 *
 * ⚠ **⛔ 這裡不判「有沒有真的移動」** —— `select.js` 那邊
 * 沒超過 `TAP_MOVE` 根本不會叫這一支（那一下是「輕點 ＝ 刪掉」）。
 * 🔴 **兩邊各判一次的話遲早會不一致**，而症狀是「有時候刪、有時候搬」。
 */
function knifeMoveEnd(ok) {
  const mv = knifeMoving;
  knifeMoving = null;
  if (!mv) return;
  if (!ok && knifePicks[mv.i]) knifePicks[mv.i] = mv.orig;
  drawKnifePicks();
  updateBar();
  toast(ok
    ? `第 ${mv.i + 1} 個切點搬好了 —— 順序沒有變，它還是第 ${mv.i + 1} 個`
    : `第 ${mv.i + 1} 個切點彈回原位了 —— 那裡吸不到任何一條邊`, !ok);
}

/**
 * 🔴 **`退一步` 那顆按鈕：把剛才刪掉的那一顆放回【原來的位置】並講一句話。**
 *
 * ⚠ **真正動資料的是 `knifeRestoreLastDelete()`** —— 快點兩下那條路
 * 也走同一支，⛔ 只是不講話。這裡只負責「講什麼」。
 */
function undoKnifeDelete() {
  const r = knifeRestoreLastDelete();
  if (!r) { toast('⛔ 沒有刪掉的切點可以放回來', true); return; }
  toast(r.at === r.want
    ? `放回第 ${r.at + 1} 個，共 ${knifePicks.length} 個`
    : `原來那一格已經不在了，放到最後面 —— 第 ${r.at + 1} 個，共 ${knifePicks.length} 個`);
}

/**
 * 🔴 **真正放回去的那一支。⛔ 它不講話。**
 *
 * ⚠ **會講話的話快點兩下就會冒出一句「放回第 N 個」** ——
 * 而那一下使用者要的是「閉合並切下去」，⛔ 不是「有東西被放回來了」。
 * ⭐ 所以**動作與說明分開**：這裡只動資料，講什麼由呼叫的人決定。
 *
 * @returns {?{at:number, want:number}} `null` ＝ 沒有東西可以放回來
 */
function knifeRestoreLastDelete() {
  const last = knifeDeleted.pop();
  if (!last) return null;
  /**
   * ⚠ **索引要夾住**：刪完之後又點了新的點，原本的位置可能已經超過長度了 ——
   * 那時候放在最後面是唯一說得通的落點。
   * ⛔ 不夾的話 `splice()` 會安靜地把它塞到尾巴，而使用者以為它回到原位。
   */
  const at = Math.min(last.i, knifePicks.length);
  knifePicks.splice(at, 0, last.pick);
  drawKnifePicks();
  updateBar();
  return { at, want: last.i };
}

/**
 * 🔴 **閉合迴圈：把起點再接一次到最後，然後切下去。**
 *
 * ⚠ **不是把第一點的資料整個複製過去** —— `knifePath()` 會在那條邊上
 * **再插一個新頂點**，跟起點那個重疊卻不是同一個，切出來會多一條長度 0 的線。
 * 正確做法是**照樣傳一份 `{a,b,p}`**，讓 `knifePath()` 的「同一條邊上
 * 多個點要照順序排」那段自己處理 —— 它本來就在處理「繞一圈時同一條邊被點好幾次」。
 *
 * ⚠ 起點跟終點已經在同一條邊上時，再接一次只會長出長度 0 的線 → 直接切就好。
 */
function knifeCloseLoop() {
  const first = knifePicks[0];
  const last = knifePicks[knifePicks.length - 1];
  /**
   * ⚠ **吸到角那一種要另外認**（2026-09-01）：它⛔ 沒有 `a/b`，只有 `v`。
   * 🔴 **兩端是同一個角時再接一次 ＝ 同一個頂點連自己**，
   * ⛔ 不擋的話會長出一條長度 0 的線 —— 跟「同一條邊」那一種是同一個病。
   */
  const isV = k => Number.isInteger(k.v);
  const sameEdge = (isV(first) || isV(last))
    ? (isV(first) && isV(last) && first.v === last.v)
    : ((first.a === last.a && first.b === last.b)
    || (first.a === last.b && first.b === last.a));
  if (!sameEdge) {
    knifePicks.push({ ...first, p: first.p.clone(), world: first.world.clone() });
    drawKnifePicks();
  }
  if (knifeApply()) return;

  /**
   * 🔴🔴 **切不下去 → 把剛才那個「閉合副本」收回去。**
   *
   * ⚠ **⛔ 少了這一段就是 kang 2026-09-01 回報的那個 bug**：
   * 【實證，線上版按出來的】方塊上放 2 個相鄰邊的切點 → 快點兩下 →
   * `knifePath()` 擋下來（「這兩個點是相鄰的」），
   * **而副本留在 `knifePicks` 裡 → 憑空多一個切點**。
   * 🔴 而且**那一條路⛔ 沒有叫 `updateBar()`**，所以工具列寫「切下去（2 點）」、
   * 實際卻有 3 個 —— **兩個數字對不起來**（鐵律三）。
   *
   * ⚠ **⛔ 它不是「移動切點」那一輪造成的**，從 `knifeCloseLoop()`
   * 寫出來那天（2026-08-26）就在 —— **閉合失敗本來就少見，一直沒被碰到**。
   *
   * ⭐ **通則**：⛔ 不要「先改好資料再去試」——
   * **試失敗的那條路一定要把自己收乾淨**，⛔ 不可以留半成品給下一個動作。
   */
  if (!sameEdge) { knifePicks.pop(); drawKnifePicks(); }
  updateBar();
}

/**
 * 真的切下去。
 * @returns {boolean} `false` ＝ 切不下去（原因已經用 `toast` 講了）
 */
function knifeApply() {
  const obj = knifePicks.length ? knifePicks[0].obj : null;
  if (!obj) { toast('先在模型上點兩個以上的位置', true); return false; }

  /** ⚠ `v` ＝ 吸到角那一種（重用既有的頂點）—— ⛔ 漏掉它就會退回「插新點」那條壞路 */
  const r = knifePath(obj.mesh(),
    knifePicks.map(k => ({ a: k.a, b: k.b, p: k.p, v: k.v })));
  if (!r.ok) { toast(r.reason, true); return false; }

  const segs = r.segments;
  knifePicks = [];
  knifeDeleted = [];
  knifeMoving = null;
  hideKnifeLine();
  sel.setKnifeMode(false);
  $('knife').classList.remove('on');

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();
  commit(segs > 1 ? `刀具切 ${segs} 段` : '刀具切一刀');

  /** ⚠ 一定要在 commit() 之後才選 —— 跟切一刀、環切同一條理由 */
  const di = r.mesh._vertIndex();
  const want = new Set(r.newEdges.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)));
  const hes = [];
  for (const he of r.mesh.edges()) {
    const a = di.get(he.v.id), b = di.get(he.to.id);
    if (want.has(a < b ? `${a}-${b}` : `${b}-${a}`)) hes.push(he);
  }
  /**
   * 🔴 **切完自動進編輯模式並選起新的線** —— 接下來要做的事
   * （拉、分離）都在編輯模式裡，留在刀具模式等於逼使用者多按兩次。
   */
  if (!sel.editMode) { sel.setEditMode(true); $('edit').classList.add('on'); }
  /**
   * ⚠ **⛔ 這裡原本有一行 `$('gEditXf').hidden = false`，2026-09-01 拿掉了** ——
   * 那一排的規則現在只有一個家（`syncEditXfRow()`），而底下的 `updateBar()`
   * 會叫它。**⛔ 而且原本那行還是錯的順序**：它在 `selectEdges()` 之前，
   * 那時還沒選到任何邊 —— 硬開起來等於繞過「有沒有選到東西」那道閘門。
   */
  const got = sel.selectEdges(obj, hes);
  syncModeButtons();
  panel.refresh();
  updateBar();
  updateEditNum();

  const bits = [segs > 1 ? `已切開 ${segs} 段` : '已切開'];
  if (got) bits.push(`新的 ${got} 條線已選起來 —— 要拆成兩個物件就按「分離」`);
  toast(bits.join('　'));
  return true;
}

function toggleEditMode() {
  if (!sel.editMode) exitOtherModes('edit');
  const on = sel.setEditMode(!sel.editMode);
  $('edit').classList.toggle('on', on);
  /**
   * ⚠ **⛔ 這裡原本是 `$('gEditXf').hidden = !on`** —— 而**同一件事在別的
   * 兩個地方還各有一份**，結果 `exitOtherModes()` 那條路漏掉，
   * 整排就賴在物件模式的畫面上（2026-09-01 kang 的截圖照出來的）。
   * ⇒ 規則搬進 `syncEditXfRow()`，這裡靠底下的 `updateBar()` 叫它。
   */
  updateEditNum();
  syncModeButtons();
  /** ⚠ 離開編輯模式白圈要收掉 —— 那時候點根本選不到，留著就是雜訊 */
  sel.refreshVertexDots();
  panel.refresh();
  updateBar();
  toast(on
    ? `編輯模式：點一個${FILTER_NAME[sel.editFilter]}，再用箭頭把它拉走。再按一次「拉點線面」離開`
    : '已離開編輯模式');
}

/**
 * 切換箭頭朝哪：世界 XYZ ／ 選到那個元素自己的方向。
 *
 * 🔴 **這一顆解掉的是「擠出好像沒用、斜面推不動、拉不出梯形」那一整組。**
 * 它們的根源是同一件事 —— gizmo 只有世界 XYZ 一種方向。
 * 〔`外部參考-Blender編輯.md` 第 3 節：變換 ＝ 種類 × 方向 × 中心〕
 *
 * ⚠ 算不出法向基底時 `setEditSpace()` 會退回世界，而且**回傳真話** ——
 * 按鈕照回傳值更新，所以畫面上亮著的一定是實際生效的那一個。
 * 沉默地退回是最糟的做法（坑第 11 條）。
 */
function setEditSpace(want) {
  const got = sel.setEditSpace(want);
  for (const b of document.querySelectorAll('.spBtn')) {
    b.classList.toggle('on', b.dataset.s === got);
  }
  updateEditNum();
  if (got !== want) {
    toast('這個元素算不出法向（面積是零或孤立的點），先用世界方向', true);
    return;
  }
  toast(got === 'normal'
    ? '箭頭改朝元素自己的方向：藍色那根（Z）就是法向'
    : '箭頭改朝世界的 X／Y／Z');
}

/**
 * 把輸入框裡的數字套到剛才那一次拖曳上。
 *
 * **這跟拖曳走的是同一段程式** —— 都只是「拿一個位姿去套那份初始座標」。
 * 記了初始座標之後，「打數字」不是一個新功能，是同一件事的另一個入口。
 */
function commitEditNumber() {
  const v = parseFloat($('editNum').value);
  if (!Number.isFinite(v)) { updateEditNum(); return; }
  if (!sel.applyEditNumber(v)) {
    toast('先拉一下箭頭，程式才知道你要改哪一根軸', true);
    updateEditNum();
    return;
  }
  updateEditNum();
}

/**
 * 輸入框顯示「這一次拖曳在哪根軸上做了多少」。
 *
 * ⚠ 拉平面把手或螢幕空間把手時**沒有「一個值」這種東西**，
 * 這時停掉輸入框並把單位顯示成「—」。
 * 顯示一個看起來像數字、實際上沒有意義的東西，比沒有數字更糟（坑第 20 條）。
 */
function updateEditNum() {
  const box = $('editNum'), unit = $('editNumUnit'), lbl = $('editNumLbl');

  /**
   * 🔴 **標籤要跟著動作換**，⛔ 不要寫死「數值」。
   *
   * ⚠ kang 2026-08-25 的回報是「**看座標無法真正知道我移動多少**」——
   * 而位移量**一直都印在這個欄位裡**。功能沒有缺，缺的是
   * 「這個數字是什麼」講不出來（坑第 20 條：把內部的數字放上介面之前，
   * 先問這個數字的單位是什麼 —— 這裡連名字都沒講對）。
   */
  const NAME = { translate: '移動', rotate: '旋轉', scale: '縮放' };

  const info = sel.editMode ? sel.editDragValue() : null;
  if (!info) {
    box.disabled = true;
    box.value = '';
    unit.textContent = '—';
    if (lbl) lbl.textContent = '數值';
    return;
  }
  box.disabled = false;
  // 拖曳中不要覆蓋使用者正在打的字；只有沒聚焦時才跟著拖曳跑
  if (document.activeElement !== box) box.value = (+info.value.toFixed(4)).toString();
  unit.textContent = `${info.axis}　${info.unit}`;
  if (lbl) lbl.textContent = NAME[info.mode] || '數值';
}

/**
 * @param {string} kind 點／邊／面／自動
 * @param {boolean} [quiet] ⛔ 不要自己跳提示 —— 給「按鈕順手換模式」用。
 *        〔2026-08-27「選一圈面」加的：它換完模式**還要再講一句自己的話**，
 *        　兩則 toast 疊在一起後面那則會蓋掉前面那則。
 *        ⚠ **⛔ 不要因此另外抄一份切換流程** —— 這支還做了
 *        `refreshVertexDots()` 等四件事，抄一份就是兩條要對齊的路（坑第 31 條）〕
 */
function setEditFilter(kind, quiet = false) {
  const r = sel.setEditFilter(kind);
  for (const b of document.querySelectorAll('.efBtn')) {
    b.classList.toggle('on', b.dataset.f === kind);
  }
  /**
   * ⚠ 換過濾器要重畫點 —— 「顯示點」只在過濾器吃得到點時才畫
   * （點／自動）。不重畫的話切到「面」之後那些白圈還留在畫面上，
   * 而它們已經**點不到了** —— 畫面就開始騙人（坑第 20 條那個家族）。
   */
  sel.refreshVertexDots();
  panel.refresh();      // 面板寫著現在的過濾器與選到什麼，換了要跟著更新
  updateBar();
  updateEditNum();
  if (!sel.editMode) return;
  /**
   * ⚠ **少掉幾個一定要講。** 換過濾器會清掉「不合這個型別的」選取，
   * 而選取安靜地變少最讓人不敢相信工具 —— 他會以為加選壞了（坑第 11、21 條）。
   */
  if (quiet) return;
  toast(r.dropped
    ? `現在只選「${FILTER_NAME[kind]}」　已取消 ${r.dropped} 個不是${FILTER_NAME[kind]}的選取`
    : `現在只選「${FILTER_NAME[kind]}」`);
}

/**
 * 切換中心（變換三個概念的第三個）：全部的重心 ／ 最後點的那一個。
 *
 * **單選時兩者是同一個點**，所以要講清楚它是給多選用的 ——
 * 不然使用者按了沒看到任何變化，會以為這顆按鈕壞了（坑第 21 條）。
 */
function setEditPivot(want) {
  const got = sel.setEditPivot(want);
  for (const b of document.querySelectorAll('.pvBtn')) {
    b.classList.toggle('on', b.dataset.p === got);
  }
  updateEditNum();
  panel.refresh();

  /**
   * 🔴 **兩種模式講的東西⛔ 不一樣，話也要不一樣**（2026-09-01 補物件模式那半）。
   * ⚠ 編輯模式講的是**點邊面**，物件模式講的是**物件** ——
   * ⛔ 用同一句話會讓人以為自己在改別的東西〔跟 kang 講話：講畫面上的東西〕。
   */
  if (sel.editMode) {
    const many = sel.editCount > 1;
    toast(got === 'active'
      ? (many ? '中心改成「最後點的那一個」（畫成橘色的那個）'
              : '中心改成「最後點的那一個」。⚠ 只選一個時它跟「重心」是同一個點，看不出差別')
      : '中心改成「全部選取頂點的重心」');
  } else {
    toast(got === 'active'
      ? '中心改成「最後點的那一個物件」—— 其他物件會繞著它轉'
      : '中心改成「全部選到的物件的中間」');
  }
}

/**
 * 選到（或沒選到）一個子元素。
 *
 * 沒選到也要講一句 —— 開著過濾器「只選點」的時候，點空一下什麼都不會發生，
 * 而使用者無從分辨「我沒點準」跟「這個功能壞了」（坑第 21 條）。
 */
function editPick(el, info = {}) {
  if (!el) {
    /**
     * 取消選了一個（加選時再點一次同一個）也要講 ——
     * 不講的話「選取變少了」看起來跟「點歪了」一樣。
     */
    if (info.removed) {
      toast(sel.editCount
        ? `取消選了一個，還剩 ${sel.editCount} 個`
        : '已取消選取');
    }
    panel.refresh();
    updateBar();
    updateEditNum();
    return;
  }
  if (el.kind === 'blocked') { toast(seamBlockReason(el.obj), true); return; }

  /**
   * ⚠ **型別／物件不合而被重設時一定要講。**
   * 選了六條邊再點一個面，程式會把那六條丟掉重新開始 ——
   * 安靜地做這件事，使用者會以為加選壞了（坑第 11 條）。
   */
  if (info.note === 'kindReset') {
    toast(`同一次只能選同一種。已改成從這個${EDIT_NAME[el.kind]}重新開始`, true);
  } else if (info.note === 'objReset') {
    toast('不能跨物件多選（變換寫回的是某一個網格的座標）。已改成從這裡重新開始', true);
  }

  const n = sel.editCount;
  if (n > 1) {
    const vs = elementVerts(el.obj.mesh(), sel.editSels).length;
    // 講頂點數是因為相鄰的面共用頂點 —— 「3 個面」不等於「3×4 個頂點」
    toast(`已選 ${n} 個${EDIT_NAME[el.kind]}（共 ${vs} 個頂點）　橘色的是最後選的`);
  } else {
    let extra = '';
    if (el.kind === 'face') {
      const vs = elementVerts(el.obj.mesh(), el).length;
      // 講出頂點數，因為「面」是共面區域不是三角形，這是使用者最容易誤會的地方
      extra = `（共面區域，${vs} 個頂點）`;
    }
    if (!info.note) toast(`選到一個${EDIT_NAME[el.kind]}${extra}，用箭頭拉它`);
  }
  panel.refresh();
  /**
   * ⚠ 一定要叫 `updateBar()`。「擠出」那顆按鈕的啟用狀態靠它算，
   * 而 `pickEdit()` 是直接掛 gizmo、**沒有走 `_refresh()`**，
   * 所以 `onChange`（裡面才有 updateBar）不會被觸發。
   *
   * 少了這一行的症狀：選到面之後箭頭出來了，「擠出」卻還是灰的，
   * 要先拖一下 gizmo（走到 editDrag → updateBar）才會亮。
   * 〔2026-08-23 kang 實測抓到〕
   */
  updateBar();
  /**
   * 選到「點」時 gizmo 會被切回移動（`_applyModeLimit()`），
   * 而那條路沒經過 `setMode()` —— 按鈕要在這裡跟上，否則會亮錯。
   */
  syncModeButtons();
  updateEditNum();
}

/**
 * 拖曳中／放手。
 *
 * ⚠ **拖曳中只更新畫面，不做連帶重算。** `refreshAfterEdit()` 走訪所有的邊，
 * 是 O(邊數)，而拖曳中這支每一幀都會跑（坑第 3、22 條）。
 *
 * 放手時才跑一次，而且**非跑不可** —— 不跑的話法向、折線、`smooth`
 * 三件事同時變成謊話，展開長度會錯，而圖看起來完全正常。
 */
function editDrag(committing, el) {
  /**
   * ⚠ **拖曳中不重繪面板。** `panel.refresh()` 會把整個表單的 DOM 重建一次，
   * 而這支拖曳時每一幀都會跑 —— 那是坑第 22 條（熱路徑上的 O(全部)）的
   * DOM 版本。代價是拖曳中面板的座標是舊的，放手就會更新。
   */
  if (!committing) { view.sync(doc); updateBar(); updateEditNum(); return; }

  const r = refreshAfterEdit(el.obj.mesh());
  view.markGeomDirty();
  view.markSeamsDirty();      // 折線變了，接縫線也要重畫
  /**
   * Undo 的標籤要說出**做了哪一種變換**，不能一律叫「拉」。
   * 現在種類有三種，而 Undo 清單是使用者唯一能回頭對照的東西 ——
   * 三種都寫「拉面」的話，他分不出要退回哪一步。
   */
  const n = sel.editCount;
  commit(`${XF_NAME[sel.mode] || '拉'}${n > 1 ? `${n} 個` : ''}${EDIT_NAME[el.kind]}`);
  panel.refresh();
  updateEditNum();

  /**
   * ⚠ **一律用藍色，不用紅色。**
   *
   * 紅色只留給「程式做不到你要求的事」（坑第 28 條）。
   * 面被拉歪、側牆被壓扁，都是**使用者自己拉出來的結果** ——
   * 他明確做的事被程式打紅叉，紅色就失去意義了，
   * 下次真的有錯他也不會看。
   *
   * 折線的增減不講。那是每拉一下都會變的東西，講了只是雜訊；
   * 真正值得說的只有「這一下讓形狀進了某個要知道的狀態」。
   * 〔2026-08-23 kang 實測回報：反方向拉會跳一串紅字「少 13 條折線
   * 　多 10 條折線、13 個面已經不平了」，看不出那是不是壞掉了〕
   */
  const bits = [];
  if (r.degenerate) bits.push(`${r.degenerate} 個面被壓成零面積（拉回去就恢復）`);
  if (r.nonPlanar) bits.push(`${r.nonPlanar} 個面不再是平的（展開會變近似；剖面分切與 3D 列印不受影響）`);
  if (bits.length) toast(bits.join('　'));
}

/**
 * 拖到一半按 Esc 取消。
 *
 * **一定要講一句。** 取消之後畫面會彈回原樣，而「彈回原樣」跟
 * 「這一下根本沒作用」長得一模一樣 —— 使用者分不出是哪一種
 * （坑第 21 條：有時候看起來沒作用的操作，必須有東西持續告訴他有沒有作用）。
 *
 * 也不記 Undo：取消之後模型跟拖之前**完全一樣**，
 * 記一步「什麼都沒做」只會讓 Undo 清單多一格空的。
 */
function editCancelled() {
  view.sync(doc);
  panel.refresh();
  updateEditNum();
  updateBar();
  toast('已取消這一次拖曳');
}

/**
 * 擠出面：從選到的面長出新的一段。**做鹿角就是重複這個動作。**
 *
 * ── 為什麼是「先長一段，再用拉面調整」（kang 2026-08-23 選的方案 C）──
 * 另外兩條路各有代價：跳輸入框填距離不直觀；拖曳決定距離則是
 * **每拖一格就要重建一次網格**（擠出是拆掉重建，不是就地改座標），
 * 上千頂點的匯入件會卡，Undo 也難處理。
 *
 * C 的好處是**完全不需要新的拖曳邏輯**：擠出只負責「長出來」，
 * 調整走已經做好而且驗過的「拉面」。一個動作一件事。
 *
 * ── 預設距離為什麼用吸附格距 ────────────────────────────
 * 那是**使用者自己已經設定的尺度**，講得出物理意義（鐵律三：
 * 容許值與預設值要挑一個講得出物理意義的量）。而且擠完馬上用同樣的
 * 格距拉，數字會很乾淨。它只是起點，不是最終值。
 * 吸附關掉時退回 1cm —— 總得有個數字，而 0 會被 `extrudeFace` 擋掉。
 */
function extrudeSelected() {
  const el = sel.editSel;
  if (!el || el.kind !== 'face') {
    toast('先在編輯模式下選一個面，再按「擠出」', true);
    return;
  }
  /**
   * ⚠ **一次只擠一個面**（`extrudeFace()` 的既有範圍）。
   * 選了好幾個面時**擋下來並講清楚**，不要偷偷只擠 active 那一個 ——
   * 那會做出一個他沒要求的形狀，而畫面上看起來像「擠出怪怪的」。
   * 〔坑第 11 條：沉默地做別的事比不做更糟〕
   */
  if (sel.editCount > 1) {
    toast(`擠出一次只能一個面（現在選了 ${sel.editCount} 個）。點一下那個面單獨選它`, true);
    return;
  }
  const step = sel.snapStep > 0 ? sel.snapStep : 1;
  const obj = el.obj;

  const r = extrudeFace(obj.mesh(), el.face, step);
  if (!r.ok) { toast(r.reason, true); return; }

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();      // 折線變了（多了四圈側牆的邊）
  commit(`擠出面 ${step} cm`);

  /**
   * ⚠ 一定要在 commit() 之後才重選。commit() 會走 revalidate()，
   * 而擠出換掉了整個網格物件，那裡會把子元素選取清掉（本來就該清，
   * 舊的 Face 參考已經不在文件裡了）。先選後 commit 等於白做。
   *
   * 選的是**新長出來的蓋子**，不是原本那個面 —— 使用者接著要調的是
   * 新那一段的長度。〔這就是「擠出只負責長出來、調整交給拉面」的接縫〕
   */
  const got = sel.selectFace(obj, r.capFace);
  panel.refresh();

  toast(got
    ? `已擠出 ${step} cm（新增 ${r.walls} 面側牆）　用箭頭拉到想要的長度`
    : `已擠出 ${step} cm（新增 ${r.walls} 面側牆）`);
}

/**
 * 🔴 **擠出邊：從板子的外緣各長出一片面**（折邊、裙邊、擋板）。
 *
 * ── ⚠ 它⛔ 不是上面那顆的變形 ─────────────────────────
 * `extrudeFace()` **明文擋掉開放邊緣**，而這一顆**只吃開放邊緣** ——
 * 兩者的適用範圍**剛好相反**，⛔ 不要想著合成一顆。
 *
 * ⭐ **寬度⛔ 不新增第三個數字**：直接用「吸附」現在選的值，
 * 關掉時 1 cm —— **跟上面那顆一模一樣的作法**（kang 2026-09-01 點頭）。
 *
 * ⭐ 長完把**新的那幾片選起來** —— 跟環切、平行複製同一個作風，
 * 使用者接下來多半要用 `拉點線面` 把它們折起來。
 */
function extrudeEdgesSelected() {
  const el = sel.editSel;
  if (!el || el.kind !== 'edge') {
    toast('先在編輯模式下選板子外緣的邊，再按「擠出邊」', true);
    return;
  }
  const step = sel.snapStep > 0 ? sel.snapStep : 1;
  const obj = el.obj;
  const hes = sel.editSels.filter(e => e.kind === 'edge' && e.he).map(e => e.he);

  const r = extrudeBoundaryEdges(obj.mesh(), hes, step);
  if (!r.ok) { toast(r.reason, true); return; }

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();
  commit(r.added > 1 ? `擠出邊 ${r.added} 片 ${step} cm` : `擠出邊 ${step} cm`);

  /**
   * ⚠ 一定要在 `commit()` 之後才選 —— 跟擠出、環切、平行複製同一條理由：
   * `commit()` 走 `revalidate()`，而這裡換掉了整個網格物件。
   *
   * ⭐ **用座標對回去，⛔ 不用索引** —— `cleanRebuild()` 會重排。
   */
  const key3 = p => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`;
  const want = new Set(r.newFaceKeys || []);
  const picks = [];
  for (const f of r.mesh.faces) {
    const vs = r.mesh.faceVerts(f).map(v => key3(v.p));
    /** ⚠ 起點可能被重排到別的位置，所以每一種輪轉都要試 */
    for (let i = 0; i < vs.length; i++) {
      if (want.has(vs.slice(i).concat(vs.slice(0, i)).join('|'))) { picks.push(f); break; }
    }
  }
  const got = picks.length === 1 ? sel.selectFace(obj, picks[0]) : 0;
  panel.refresh();
  updateBar();
  updateEditNum();

  const bits = [r.added > 1 ? `已長出 ${r.added} 片，每片寬 ${step} cm`
                            : `已長出 1 片，寬 ${step} cm`];
  if (r.added > 1) {
    /** 🔴 轉角留缺口要主動講，⛔ 不要讓他以為是 bug（坑第 24 條） */
    bits.push('⚠ 轉角會留一個缺口 —— 那是對的，各摺 90 度立起來剛好碰在一起');
  }
  bits.push('接下來用「拉點線面」把它折到想要的角度');
  toast(bits.join('　'));
}

/**
 * 壓平：把選到的面壓到同一個平面上，然後**自動併成一個面**。
 *
 * ── 為什麼要這一顆（它不是新功能）────────────────────
 * 底下走的是「**縮放 × 法向 × Z 打 0**」，完全是現成的機制，一行新數學都沒有。
 * 存在的理由只是**讓它按得到** —— 那個組合沒有人猜得到。
 * 跟擠出的方案 C 同一個形狀：按一顆做一件固定的事。
 *
 * ── 為什麼壓完要自動併面 ────────────────────────────
 * kang 選了 3 個 seg，想把它們變成一個面。
 * 「不管夾角直接併成一個 n 邊形」（Blender 的溶解面）**實測偏離平面 0.9561 cm**，
 * 是可切容許值（0.1mm）的 **96 倍** —— 那不是近似，是做不出來。
 *
 * 壓平之後那幾片**真的共面**了，`mergeCoplanarFaces()` 就會自己併掉，
 * 而且是**真正平的**面、展開仍然精確。**所以併面是壓平的免費附贈。**
 *
 * ⚠ **形狀會變，這是它的本質。** 所以 toast 一定要講出「壓平前偏離多少」——
 * 那個數字就是他即將付出的代價，而且他自己驗得出來（坑第 24 條）。
 */
function flattenSelected() {
  const el = sel.editSel;
  if (!el || el.kind !== 'face') {
    toast('先在編輯模式下選面（可以開「加選」選好幾個），再按「壓平」', true);
    return;
  }
  const obj = el.obj;
  const oldMesh = obj.mesh();
  const n = sel.editCount;

  const r = flattenElements(oldMesh, sel.editSels, sel.editPivot);
  if (!r.ok) { toast(r.reason, true); return; }

  /**
   * ⚠ 本來就在同一個平面上時**什麼都不要做**，而且要講一句。
   * 悶著記一步「什麼都沒改」的 Undo，使用者會以為壞掉了。
   */
  if (r.before === 0) {
    toast(n > 1 ? `這 ${n} 個面本來就在同一個平面上，沒有東西要壓`
                : '這個面本來就是平的，沒有東西要壓');
    return;
  }

  refreshAfterEdit(oldMesh);

  /**
   * 壓平之後那幾片真的共面了 → 併掉它們。
   * ⚠ 併面會**換掉整個網格物件**，所以要走 `setMesh()` ＋ 搬選取，
   * 而且一定要在 `commit()` 之後才搬（擠出那一輪學到的）。
   */
  const g = mergeCoplanarFaces(oldMesh);
  let merged = 0;
  if (g.ok) {
    obj.setMesh(g.mesh);
    refreshAfterEdit(g.mesh);
    merged = g.before - g.after;
  }
  view.markGeomDirty();
  view.markSeamsDirty();
  commit(n > 1 ? `壓平 ${n} 個面` : '壓平一個面');

  if (g.ok) sel.remapEditSels(obj, oldMesh, g.mesh, g.remap);
  panel.refresh();
  updateBar();
  updateEditNum();

  /**
   * 講出「壓平前偏離多少」—— 那是他付出的代價，而且是他驗得出來的數字。
   * 只講「壓平了」等於沒講：形狀變了多少他看不出來。
   */
  const bits = [`已壓平${n > 1 ? ` ${n} 個面` : ''}（原本最遠偏離 ${r.before.toFixed(3)} cm）`];
  if (merged > 0) {
    const now = sel.editSel && sel.editSel.face
      ? obj.mesh().faceVerts(sel.editSel.face).length : 0;
    bits.push(now ? `已併成一個 ${now} 邊形` : `已併掉 ${merged} 個面`);
  }
  toast(bits.join('　'));
}

/**
 * 「變成正圓」那顆按鈕的狀態 ＋ **半徑欄位自動填入擬合值**。
 *
 * ── ⚠ 為什麼要記一個 key ────────────────────────────
 * `updateBar()` 會被很多事件呼叫，**每次都覆寫欄位會把使用者剛打的數字吃掉**。
 * 所以只在「**選取的內容真的變了**」的時候才填。
 * 〔坑第 21 條的反面：這次要小心的是「按了畫面上不該變的東西卻變了」〕
 */
let _circleKey = null;

function updateToCircleBtn() {
  const can = sel.editMode && sel.editCount > 0;
  let verts = [];
  if (can) {
    try { verts = elementVerts(sel.active.mesh(), sel.editSels); } catch { verts = []; }
  }
  const ok = verts.length >= 3;

  /** 🔴 2026-08-31 第 2 段：改成「沒輪到就不出現」，⛔ 不再變灰 */
  $('toCircle').hidden = !ok;
  $('circleR').hidden = !ok;
  $('toCircle').title = ok
    ? `把選到的 ${verts.length} 個點推回一個正圓（會先壓到同一個平面）`
    : (sel.editMode ? '至少要選到 3 個點 —— 選一個面，或開「加選」選一圈邊'
                    : '先按「拉點線面」進入編輯模式，再選一圈點或一個面');

  /** 選取沒變就不要碰欄位 */
  const key = ok ? verts.map(v => v.id).join(',') : null;
  if (key === _circleKey) return;
  _circleKey = key;
  if (!ok) return;

  /**
   * ⚠ **只是「量」，⛔ 一個點都不動** —— 靠 `toCircle()` 的 `dryRun`。
   * 〔⛔ 不要自己再算一次擬合：那就是「同一件事有兩份」，兩份一定會不同步〕
   */
  const probe = toCircle(sel.active.mesh(), sel.editSels, { dryRun: true });
  $('circleR').value = probe.ok ? probe.fitted.toFixed(3) : '';
}

/**
 * 🔴 **變成正圓：把選到的那一圈點推回一個正圓。**
 *
 * ⚠ **它做兩件事，兩件都要講出來**：① 壓到同一個平面 ② 推到同一個半徑。
 * 使用者付出的是兩種代價，只講一個等於沒講。
 *
 * ⚠ **本來就已經是圓、而且沒有指定新半徑時什麼都不做** ——
 * 悶著記一步「什麼都沒改」的 Undo，使用者會以為壞掉了（照壓平那支的規矩）。
 */
function toCircleSelected() {
  if (!sel.editMode || !sel.editCount) {
    toast('先在編輯模式下選一圈點或一個面，再按「變成正圓」', true);
    return;
  }
  const obj = sel.active;
  const oldMesh = obj.mesh();

  const typed = parseFloat($('circleR').value);
  const want = Number.isFinite(typed) && typed > 0 ? typed : undefined;

  /** 先量一次，決定要不要動手 */
  const probe = toCircle(oldMesh, sel.editSels, { radius: want, dryRun: true });
  if (!probe.ok) { toast(probe.reason, true); return; }

  /**
   * 「本來就圓」的判準用 0.01 cm ＝ **切得出來的精度**，
   * ⛔ 不是浮點數的尺度（坑第 25、26 條）。
   * ⚠ 但**指定了半徑就一定要照做** —— 他要從 25 變成 40 是合法的要求。
   */
  const already = probe.before < PLANAR_TOL_CM && probe.flattened < PLANAR_TOL_CM;
  const sameR = want === undefined || Math.abs(want - probe.fitted) < PLANAR_TOL_CM;
  if (already && sameR) {
    toast(`這一圈本來就已經是圓了（半徑 ${probe.fitted.toFixed(3)} cm）—— 沒有東西要推。`
        + '要改成別的大小就在旁邊打一個半徑');
    return;
  }

  const r = toCircle(oldMesh, sel.editSels, { radius: want });
  if (!r.ok) { toast(r.reason, true); return; }

  refreshAfterEdit(oldMesh);
  view.markGeomDirty();
  view.markSeamsDirty();
  commit(`變成正圓（半徑 ${r.radius.toFixed(2)}）`);
  panel.refresh();
  updateBar();
  updateEditNum();
  $('circleR').value = r.radius.toFixed(3);
  _circleKey = null;

  /**
   * 🔴 **兩種代價分開講，而且都是他驗得出來的數字。**
   * 〔鐵律三：讓兩個數字互相對得起來〕
   */
  const bits = [`已推成正圓：${r.moved} 個點，半徑 ${r.radius.toFixed(3)} cm`];
  if (r.before >= PLANAR_TOL_CM) bits.push(`原本半徑最多差 ${r.before.toFixed(3)} cm`);
  if (r.flattened >= PLANAR_TOL_CM) bits.push(`順便壓平了 ${r.flattened.toFixed(3)} cm`);
  if (want !== undefined && Math.abs(want - r.fitted) >= PLANAR_TOL_CM) {
    bits.push(`⚠ 你指定的 ${want} 跟最接近的 ${r.fitted.toFixed(3)} 差 ${Math.abs(want - r.fitted).toFixed(3)}，形狀會變比較多`);
  }
  toast(bits.join('　'));
}

/**
 * 環切：沿著選到的那條邊繞一整圈，在中間加上新的線。
 *
 * ── 它只加線，不改形狀 ──────────────────────────────────
 * 體積、面積、展開尺寸**精確不變**（實測方塊 108000.000000 →
 * 108000.000000）—— 那是可以對答案的，測試釘住了。
 * 改形狀是接下來「拉那一圈邊」的事。
 *
 * ── 跟擠出方案 C 同一個分工 ──────────────────────────────
 * 環切只負責加線，切完**自動把那一圈選起來**，接著用已經驗過的「拉邊」
 * 調到想要的位置。一個動作一件事，不需要新的拖曳邏輯。
 *
 * ⚠ **切完之後畫面上真的會多幾條線**（`scene.js` 特別補畫的），
 * 而且**半塊面點得到、拉得動**（`planarRegions()` 在 hard 邊斷開）——
 * 這三件事任何一件沒做，環切就是一顆按了什麼都不會發生的按鈕（坑第 21 條）。
 */
/**
 * 🔴 **沿面滑動：把選到的那一圈邊沿著表面挪位置**（＝ Blender 的 Edge Slide）。
 *
 * ── 它跟「拉點線面」差在哪（＝ 這顆按鈕存在的唯一理由）──────
 * 拉邊是往一個方向硬拉，**會離開表面**；
 * 滑動是沿著兩側原本就有的那條邊走，**永遠貼著表面**。
 *
 * ⚠ **它 ⛔ 不改拓撲**，所以 ⛔ 不必 `setMesh()` 換網格 ——
 * `slideEdges()` 就地改座標。但**形狀變了**，所以照樣要重算與 commit。
 *
 * 🔴 **選取刻意不動** —— 滑完那一圈還選著，使用者可以接著再滑一次
 * （打 5 再打 5 ＝ 走 10）。⭐ 這也是 `轉幾格`／`刀數` 那種「調到滿意」的作風。
 */
function slideSelected() {
  const el = sel.editSel;
  if (!el || el.kind !== 'edge') {
    toast('先在編輯模式下選一圈邊，再按「沿面滑動」（可以用「選一圈」或先按「環切」）', true);
    return;
  }
  const mode = $('slideUnit').dataset.u === 'pct' ? 'pct' : 'cm';
  const amt = +$('slideAmt').value;
  if (!Number.isFinite(amt) || amt === 0) {
    toast('滑動距離不能是 0', true);
    return;
  }

  const obj = el.obj;
  const mesh = obj.mesh();
  const hes = sel.editSels.filter(e => e.kind === 'edge' && e.he).map(e => e.he);

  const r = slideEdges(mesh, hes, amt, { mode });
  if (!r.ok) { toast(r.reason, true); return; }

  refreshAfterEdit(mesh);
  view.markGeomDirty();
  view.markSeamsDirty();
  commit(mode === 'pct' ? `沿面滑動 ${amt}%` : `沿面滑動 ${amt} cm`);
  panel.refresh();
  updateBar();
  updateEditNum();

  /**
   * 🔴 **一定要講「實際往哪邊」** —— 打數字沒有滑鼠可以指方向，
   * 使用者事先猜不到正值是哪一側。⭐ 看到不對就打負數，⛔ 不必重猜。
   */
  const bits = [`${r.moved} 個點沿著表面往「${r.dir}」滑了 ${r.appliedCm.toFixed(2)} cm`];
  if (mode === 'pct') bits.push(`（${amt}%）`);
  if (r.clamped) {
    bits.push(`⚠ 有 ${r.clamped} 個點滑到底了（最多只能滑 ${r.maxCm.toFixed(2)} cm）`);
  }
  toast(bits.join('　'));
}

/**
 * 🔴 **平行複製：在選到的那一圈邊，兩側各加一圈平行的線。**
 * （＝ Blender 的 Offset Edge Slide）做加強筋、邊框、溝槽。
 *
 * ── ⚠ 它跟 `沿面滑動` 吃同一種選取，但做的事相反 ────────
 * **滑動** ＝ 把那一圈**挪走**（形狀會變、只動座標）；
 * **這一顆** ＝ 在那一圈**兩側各加一圈**（形狀不變、只加線）。
 * 🔴 所以它**換掉整個網格**（要 `setMesh()`），而滑動不用。
 *
 * ⭐ 加完之後把**新的那兩圈選起來** —— 跟環切同一個作風，
 * 使用者接著多半要拉它們或再滑動。
 */
function offsetLoopSelected() {
  const el = sel.editSel;
  if (!el || el.kind !== 'edge') {
    toast('先在編輯模式下選一圈邊，再按「平行複製」（可以用「選一圈」或先按「環切」）', true);
    return;
  }
  const mode = $('slideUnit').dataset.u === 'pct' ? 'pct' : 'cm';
  const w = +$('offsetW').value;
  if (!Number.isFinite(w) || w <= 0) { toast('偏移量要大於 0', true); return; }

  const obj = el.obj;
  const oldMesh = obj.mesh();
  const hes = sel.editSels.filter(e => e.kind === 'edge' && e.he).map(e => e.he);

  const r = offsetEdgeLoop(oldMesh, hes, w, { mode });
  if (!r.ok) { toast(r.reason, true); return; }

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();      // 被切成兩半的邊如果標過 CUT，線段變兩截了
  commit(mode === 'pct' ? `平行複製 ${w}%` : `平行複製 ${w} cm`);

  /**
   * ⚠ 一定要在 `commit()` 之後才選 —— 跟環切、擠出同一條理由：
   * `commit()` 會走 `revalidate()`，而這裡換掉了整個網格物件，
   * 那裡會把子元素選取清掉。先選後 commit 等於白做。
   */
  const di = r.mesh._vertIndex();
  const want = new Set(r.newEdges.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)));
  const picked = [];
  for (const he of r.mesh.edges()) {
    const a = di.get(he.v.id), b = di.get(he.to.id);
    if (want.has(a < b ? `${a}-${b}` : `${b}-${a}`)) picked.push(he);
  }
  sel.selectEdges(obj, picked);
  panel.refresh();
  updateBar();
  updateEditNum();

  /**
   * 🔴 **講出「加了幾條」** —— 那個數字使用者自己驗得出來
   * （方塊一圈 4 條 → 兩側共 8 條、32 段圓柱 → 64 條）。
   * ⭐ 而**體積面積精確不變**才是這顆按鈕的保證，所以一起講。
   */
  const bits = [`已在兩側各加一圈，共 ${r.newEdges.length} 條新的線`];
  if (r.clamped) {
    bits.push(`⚠ 有 ${r.clamped} 個地方頂到底了（偏移量比那一段還長，已經停在端點）`);
  }
  bits.push(`體積 ${r.mesh.volume().toFixed(2)} cm³（⛔ 沒變，它只加線）`);
  toast(bits.join('　'));
}

function loopCutSelected() {
  const el = sel.editSel;
  if (!el || el.kind !== 'edge') {
    toast('先在編輯模式下選一條邊，再按「環切」', true);
    return;
  }
  if (sel.editCount > 1) {
    toast(`環切一次只能從一條邊出發（現在選了 ${sel.editCount} 個）。點一下那條邊單獨選它`, true);
    return;
  }
  const cuts = Math.max(1, Math.min(32, Math.round(+$('loopCutN').value || 1)));
  const obj = el.obj;
  const oldMesh = obj.mesh();

  const r = loopCut(oldMesh, el.he, { cuts });
  if (!r.ok) { toast(r.reason, true); return; }

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();      // 被切成兩半的邊如果標過 CUT，線段變兩截了
  commit(cuts > 1 ? `環切 ${cuts} 刀` : '環切');

  /**
   * ⚠ 一定要在 commit() 之後才選 —— 跟擠出同一條理由：
   * commit() 會走 revalidate()，而環切換掉了整個網格物件，
   * 那裡會把子元素選取清掉。先選後 commit 等於白做。
   *
   * 選的是**新切出來的那幾圈邊**，不是原本那條 —— 使用者接著要拉的是它們。
   */
  const di = r.mesh._vertIndex();
  const want = new Set(r.newEdges.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)));
  const hes = [];
  for (const he of r.mesh.edges()) {
    const a = di.get(he.v.id), b = di.get(he.to.id);
    if (want.has(a < b ? `${a}-${b}` : `${b}-${a}`)) hes.push(he);
  }
  const got = sel.selectEdges(obj, hes);
  panel.refresh();
  updateBar();
  updateEditNum();

  /**
   * 講出「繞了幾條、是不是繞回來」——**那兩個數字使用者自己驗得出來**
   * （方塊應該是 4、32 段圓柱應該是 32）。只講「切好了」等於沒講。
   * 沒繞回來要特別說一句：那多半是撞到三角形或多邊形停下來了，
   * **那是對的行為**，但看起來很像壞掉。
   */
  const bits = [`已環切${cuts > 1 ? ` ${cuts} 刀` : ''}　繞過 ${r.ringLen} 條邊`];
  if (!r.closed) bits.push('（沒有繞回來 —— 撞到不是四邊形的面就會停，那是正常的）');
  if (got) bits.push(`新的 ${got} 條邊已選起來，用箭頭直接拉`);
  toast(bits.join('　'));
}

/**
 * 全選邊：把這個物件所有「看得見的」邊一次選起來。
 *
 * 🔴 **這顆按鈕是 kang 2026-08-25 實測逼出來的，而且問題不在導角。**
 * 他要做方塊六面 12 邊圓角 —— **功能本來就做得到**（沙箱驗過段數 1～16），
 * 但介面上**要開加選點 12 下**，中間漏一條、或重複點到同一條邊的另一側，
 * 就會有角落只導到兩條 → 被擋下來，而**畫面上看不出哪一條沒選到**。
 * → 功能沒問題，**難的是選取**。那正是能力對照表第 10.7 節三大缺口之一
 * （「多選只能一個一個點，32 片 seg 要點 32 下」）。
 *
 * ⚠ **判準用 `isMarkable()`，不是「所有的邊」** ——
 * 共面的三角化對角線畫面上根本沒有，選進來使用者會看不懂數字
 * （方塊會變成 18 條而不是 12 條，坑第 20 條）。
 * 而環切／內縮／切一刀加出來的 `hard` 邊**要選進來**，
 * `isMarkable()` 已經為它們開了例外，所以這裡直接沿用同一支，
 * ⛔ 不要另外寫一套判斷。
 */
function selectAllEdges() {
  const obj = sel.active;
  if (!sel.editMode || !obj) {
    toast('先按「拉點線面」進入編輯模式，選到物件再按「全選邊」', true);
    return;
  }
  const mesh = obj.mesh();
  const hes = [...mesh.edges()].filter(he => isMarkable(mesh, he));
  if (!hes.length) {
    toast('這個物件沒有看得見的邊可以選', true);
    return;
  }
  const got = sel.selectEdges(obj, hes);
  panel.refresh();
  updateBar();
  updateEditNum();
  /**
   * 講出條數 —— **那個數字使用者自己驗得出來**（方塊應該是 12）。
   * 只講「選好了」等於沒講，而他正是因為數不出來才踩到坑的。
   */
  toast(`已選起 ${got} 條邊　接著可以按「導角」做整個物件的圓角`);
}

/**
 * 任意切線：用一個平面把整個物件切開，只加線、不改形狀。
 *
 * ⚠ **跟這一組其他按鈕不同，它不需要選任何元素** ——
 * 環切、內縮、導角都是「對選到的東西動手」，這一顆是「對整個物件動手」，
 * 位置由工具列的軸與座標決定。
 *
 * 🔴 **世界座標 → 物件自己的座標，一定要轉。**
 * 使用者打的是空間裡的位置（跟對齊、貼合、剖面分切同一套），
 * 而網格存的是物件自己的座標。物件被轉過的話，那個平面在網格裡是斜的。
 * 不轉就會切錯地方，**而且形狀完全正常**（`worldAxisPlane()` 的說明）。
 */
function bisectSelected() {
  const obj = sel.active;
  if (!sel.editMode || !obj) {
    toast('先按「拉點線面」進入編輯模式，選到物件再按「切一刀」', true);
    return;
  }
  const axis = $('bisectAxis').value;
  const at = +$('bisectAt').value;
  if (!Number.isFinite(at)) { toast('切割位置要打一個數字', true); return; }

  const oldMesh = obj.mesh();
  const r = bisect(oldMesh, worldAxisPlane(obj.matrix(), axis, at));
  if (!r.ok) { toast(r.reason, true); return; }

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();      // 被切成兩段的邊如果標過 CUT，線段變兩截了
  commit(`切一刀（${axis.toUpperCase()}＝${at}）`);

  /**
   * ⚠ 一定要在 commit() 之後才選 —— 跟環切、擠出同一條理由：
   * commit() 會走 revalidate()，而這裡換掉了整個網格物件，
   * 那裡會把子元素選取清掉。先選後 commit 等於白做。
   */
  const di = r.mesh._vertIndex();
  const want = new Set(r.newEdges.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)));
  const hes = [];
  for (const he of r.mesh.edges()) {
    const a = di.get(he.v.id), b = di.get(he.to.id);
    if (want.has(a < b ? `${a}-${b}` : `${b}-${a}`)) hes.push(he);
  }
  const got = sel.selectEdges(obj, hes);
  panel.refresh();
  updateBar();
  updateEditNum();

  /**
   * 講出「切開幾個面」——**那個數字使用者自己驗得出來**
   * （16 段圓柱攔腰切應該是 16）。只講「切好了」等於沒講。
   *
   * ⛔ 跳過的面一定要講（坑第 11 條：沉默地退回是最糟的做法）——
   * 那是「非凸的面被穿超過兩次」，切線會在那裡斷掉，
   * 使用者看到不完整的一圈線會以為程式壞了。
   */
  const bits = [`已切一刀　切開 ${r.split} 個面`];
  if (got) bits.push(`新的 ${got} 條邊已選起來，用箭頭直接拉`);
  if (r.skipped) {
    bits.push(`⚠ 有 ${r.skipped} 個面形狀太複雜（凹進去的）沒切開，`
            + '那裡的線會斷開 —— 換個位置切多半就過了');
  }
  toast(bits.join('　'));
}

/**
 * 🔴 **分離：沿著選到的那一圈邊，把物件拆成兩個。**
 *
 * kang 2026-08-25：「刀具在我的想法中是將模型切開...如果是一個球..
 * 我可以把球**切成兩半...變成兩個半圓模型**」。
 *
 * 🔴 **「切開」跟「拆成兩個物件」是兩件事** —— 切一刀／環切都只加線，
 * 網格從頭到尾是一整塊。這一顆補的是後面那一半。
 *
 * ⚠ **它跟同組其他按鈕最大的不同：會產生新物件。**
 * 所以走的是「打散」那條路（`doc.remove` ＋ `doc.add`），
 * ⛔ 不是 `obj.setMesh()`。
 */
function separateSelected() {
  const els = sel.editSels;
  if (!sel.editMode || !els.length) {
    toast('先用「切一刀」或「環切」切一圈，切完那圈會自動選中，再按「分離」', true);
    return;
  }
  if (els.some(e => e.kind !== 'edge')) {
    toast('「分離」要沿著一圈邊切開 —— 把過濾器切到「邊」，選那一圈線', true);
    return;
  }

  const obj = els[0].obj;
  const r = separateAlongEdges(obj.mesh(), els.map(e => e.he));
  if (!r.ok) { toast(r.reason, true); return; }

  /**
   * 🔴 **畫面上什麼都不跳，但每一塊的原點會落在自己的中心。**
   *
   * ⚠ **⛔ 這裡原本只寫「位置刻意不動」，而那句藏著一個誤解**
   * 〔2026-08-29 kang 回報翻掉的〕：舊註解寫
   * 「`explodeShapes()` 會置中…這裡拆的是同一個東西的兩半，跳開反而難對回去」
   * —— **它把「原點置中」跟「幾何跳開」當成同一件事，而它們不是。**
   *
   * ⭐ **證明就在它自己拿來對照的那一支**：`explodeShapes()` 的
   * `shiftShape(s, -b.cx, -b.cy)` 旁邊寫著「幾何置中，⛔ 不靠搬物件抵銷」——
   * **幾何往回移、`pos` 往前移，淨結果世界位置一格都沒變。**
   *
   * 🔴 **代價 ⛔ 不是難看**：原點就是**旋轉與縮放的中心**。
   * 舊行為下，圓柱從中間分離，**下面那塊的原點在它的頂面** ——
   * 按旋轉會繞著頂面轉。〔kang 2026-08-29 實際踩到〕
   *
   * ⚠ **先建物件再置中，⛔ 不可以先算好再塞** ——
   * `recenterOrigin()` 要讀 `obj.matrix()`（含 rot／scale），
   * 物件還沒建起來就沒有那個矩陣。
   */
  const made = r.meshes.map((m, i) => new ModelObject({
    name: `${obj.name}－${i + 1}`,
    kind: obj.kind,
    src: { type: 'mesh' },
    mesh: m,
    pos: obj.pos, rot: obj.rot, scale: obj.scale,
    color: obj.color, thickness: obj.thickness, lockScale: obj.lockScale
  }));
  for (const o of made) recenterOrigin(o);

  sel.clearEditSel();
  doc.remove(obj);
  for (const o of made) doc.add(o);
  view.sync(doc);
  sel.set(made.map(o => o.id));
  panel.analysisCache.clear();
  commit(`分離成 ${made.length} 個物件`);
  panel.refresh();
  updateBar();

  /**
   * 🔴 **一定要講「斷面是空的」。** 球切兩半是兩個**碗**不是兩個實心半球，
   * 而使用者八成期待後者 —— 不講的話他會以為程式做錯了（坑第 11、21 條）。
   * ⭐ 而且要指出那條**真的走得通**的出路（坑第 34 條）：「補洞」已經有了。
   */
  toast(`已分離成 ${made.length} 個物件　⚠ 切開的斷面是空的 —— `
      + '選一個物件按「補洞」就補起來');
}

/**
 * 🔴 **顯示點的開關**（kang 2026-08-25 要的）。
 *
 * > 「角點還可以分辨..但是**新增的點**..除非開線框才可以找的到位置」
 *
 * ⚠ **關掉的時候也要講一句。** 一顆按下去畫面上東西消失的按鈕，
 * 不講的話跟「壞了」分不出來（坑第 21 條）。
 *
 * 🔴 **點太多的時候要講出實際數量** —— 只說「太多了」使用者不知道
 * 差多少、也不知道該怎麼辦（坑第 20 條：把數字講出來）。
 */
function toggleVertexDots() {
  sel.showVertexDots = !sel.showVertexDots;
  $('vertDots').classList.toggle('on', sel.showVertexDots);
  const r = sel.refreshVertexDots();

  if (!sel.showVertexDots) { toast('點的標示關掉了'); return; }
  if (r.tooMany) {
    toast(`這個物件有 ${r.total} 個點，超過 ${VERT_DOTS_MAX} 個就不標了 —— `
        + '全部標出來會看不清楚，在平板上也可能變慢', true);
    return;
  }
  if (!sel.editMode) { toast('點的標示開了 —— 進「拉點線面」之後才看得到'); return; }
  if (sel.editFilter !== 'vertex' && sel.editFilter !== 'auto') {
    toast('點的標示開了 —— ⚠ 但現在的過濾器選不到點，切到「點」或「自動」才會顯示');
    return;
  }
  toast(r.shown ? `標出 ${r.shown} 個點` : '點的標示開了 —— 先選一個物件');
}

/**
 * 🔴 **量測讀數：把左下角那一塊填好**（量測第 2 步）。
 *
 * 那串字是 `measureLabels('total')` 產生的 —— ⛔ 這裡**不算任何數字**，
 * 只把換行變成 `<br>`。⭐ 跟右邊面板同一個 `measureSelection()` 來源。
 *
 * ⚠ **沒東西可寫就整塊藏起來**，⛔ 不要留一個空框在那裡
 * （一個永遠佔著位置的空盒子，比沒有它更讓人以為壞了）。
 *
 * 🔴 **第一行是「選到幾個」，⛔ 用灰色**（`mHead`）——
 * 它是**標題不是數字**，跟底下那些量放同一個顏色就分不出主從了。
 */
function updateMeasureBox(r) {
  const box = $('measureBox');
  const rows = (r && r.hudText) ? r.hudText.split('\n') : [];
  if (!rows.length) { box.hidden = true; box.innerHTML = ''; return; }

  box.hidden = false;
  box.innerHTML = rows
    .map((s, i) => i === 0
      ? `<div class="mHead">${esc(s)}</div>`
      // 數字加粗：一行裡文字與數字混著，不分開的話讀的人要自己找
      : `<div>${esc(s).replace(/(-?\d+\.\d+)/g, '<b>$1</b>')}</div>`)
    .join('');
}

/** ⚠ 這串字是程式產生的、⛔ 不含使用者輸入，但照樣跳脫 —— 物件名字日後可能被寫進來 */
function esc(s) {
  return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/**
 * 🔴 **標尺寸的開關**（量測第 2 步）。
 *
 * kang 2026-08-25 拍板「**只有選到的才顯示**」；
 * 2026-08-27 實測退回第一版的位置 ——「顯示集中在 XYZ 控制軸..這樣很難選」，
 * 所以讀數改到**畫面左下角**那一塊。
 *
 * ⚠ **關掉的時候也要講一句。** 一顆按下去畫面上東西消失的按鈕，
 * 不講的話跟「壞了」分不出來（坑第 21 條）。
 *
 * ⏭ **原本還有一段「每一個」，kang 決定先收起來** ——
 * `sel.setMeasureMode('each')` 還收得下，只是**目前沒有介面在傳它**。
 */
function toggleMeasureHud() {
  const on = sel.measureMode === 'off';
  const r = sel.setMeasureMode(on ? 'total' : 'off');
  $('measureHud').classList.toggle('on', on);

  if (!on) { toast('尺寸的讀數關掉了 —— ⚠ 右邊面板那一行不受影響'); return; }
  if (!sel.editMode) { toast('尺寸的讀數開了 —— 進「拉點線面」之後才看得到'); return; }
  if (!r.shown) { toast('尺寸的讀數開了 —— 先選一個點、邊或面'); return; }
  toast('尺寸的讀數開了 —— 在畫面左下角，FPS 那塊的右邊');
}

/**
 * 🔴 **量圓的開關**（量測第 4 步）。
 *
 * ⛔ **它不判斷「這一圈是不是圓」** —— 那個判斷無解（正多邊形的頂點
 * 永遠共圓、矩形四個角也永遠共圓）。**按了就表示他要問**，
 * 跟「變成正圓」繞過同一個判準的方式一樣。
 *
 * ⚠ **開了卻沒東西可報時要講一句** —— 一顆按下去畫面沒反應的按鈕
 * 跟壞掉分不出來（坑第 21 條）。而「⛔ 只對邊有效」是使用者猜不到的。
 */
function toggleMeasureCircle() {
  const on = !sel.showCircle;
  const r = sel.setShowCircle(on);
  $('measureCircle').classList.toggle('on', on);

  if (!on) { toast('量圓關掉了'); return; }
  if (sel.measureMode === 'off') {
    toast('量圓開了 —— ⚠ 但「標尺寸」是關的，左下角那塊不會出現。先把它打開', true);
    return;
  }
  if (!sel.editMode) { toast('量圓開了 —— 進「拉點線面」之後才看得到'); return; }
  const k = sel.editSel && sel.editSel.kind;
  if (k && k !== 'edge') {
    toast('量圓開了 —— ⚠ 它只看「邊」。選一整圈邊（例如圓柱的一個圓蓋）才報得出來');
    return;
  }
  toast('量圓開了 —— 選一整圈邊，左下角會多報半徑、幾段、每段弦長');
}

/**
 * 🔴 **邊上加點：在選到的邊上放點，什麼都不連。**
 *
 * ⭐ 它跟「多點連接」是**一組**，順序就是工作流程 ——
 * kang 2026-08-25 問出來的：「是不是還有功能是**可以增加點**..
 * 然後再使用多點連接功能?」在這之前，多點連接只連得到**既有的角**。
 */
function subdivideEdgesSelected() {
  const els = sel.editSels;
  if (!sel.editMode || !els.length) {
    toast('先按「拉點線面」進入編輯模式，把過濾器切到「邊」，選邊再按', true);
    return;
  }
  if (els.some(e => e.kind !== 'edge')) {
    toast('「邊上加點」只吃邊 —— 把上面的過濾器切到「邊」，再選邊', true);
    return;
  }
  const n = Math.max(1, Math.min(32, Math.round(+$('subdivN').value || 1)));

  const obj = els[0].obj;
  const oldMesh = obj.mesh();
  const r = subdivideEdges(oldMesh, els.map(e => e.he), n);
  if (!r.ok) { toast(r.reason, true); return; }

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();      // 一條邊被切成好幾段，標過 CUT 的線段也跟著分段
  commit(n > 1 ? `邊上加點（每條 ${n} 個）` : '邊上加點');

  /**
   * 🔴 **一定要把新加的點選起來** —— 點很小，不標出來使用者
   * 根本看不到加在哪，那就是一顆「按了好像沒反應」的按鈕（坑第 21 條）。
   */
  const verts = r.newVerts.map(i => r.mesh.verts[i]).filter(Boolean);
  const got = sel.selectVerts(obj, verts);
  panel.refresh();
  updateBar();
  updateEditNum();

  const bits = [`已加 ${r.newVerts.length} 個點　形狀沒有變`];
  if (got) bits.push('新的點已選起來');
  /**
   * ⚠ **順序要講清楚。** 「多點連接」是照選取順序連的，而這裡的順序是
   * **程式排的**（照選到的邊）—— 使用者八成想要別的順序。
   * ⛔ 不講的話他會直接按下去，然後得到一個莫名其妙的形狀（坑第 24 條）。
   */
  if (got > 2) {
    bits.push('⚠ 要用「多點連接」的話，順序是程式排的 —— 自己重新照順序點一次比較準');
  }
  if (r.touched > r.edges) {
    bits.push(`⚠ 旁邊的面也跟著多了點 —— 那是必須的，不然網格會破洞`);
  }
  toast(bits.join('　'));
}

/**
 * 🔴 **多點連接：選好幾個角，照選的順序一段一段連起來。**
 *
 * 四動作框架（加線／加面／移除／移動）的第四個案例 ——
 * 加線 × 一圈邊（環切）／面的內縮輪廓（內縮）／平面（切一刀）／
 * **既有頂點**（這一顆）。
 *
 * ⚠ **它跟同組其他按鈕的選取條件不同**：環切要**一條邊**、內縮與導角
 * 要**面或邊**、切一刀**什麼都不用選**，而這一顆要**兩個以上的點**。
 *
 * ⭐ **選取順序本來就有** —— `editSels` 是有順序的陣列
 * （「順序即 active」那一輪做的），橘色那個就是最後選的。
 *
 * ⚠ **原本刻意只收兩個**，理由是「四個角會有兩條對角線交叉在中間」——
 * 那個顧慮只對 Blender 的 **Pairs**（不看順序、全部配對）成立。
 * **依序連沒有那個問題**（kang 2026-08-25 定名「多點連接」後放寬）。
 */
function connectVertsSelected() {
  const els = sel.editSels;
  if (!sel.editMode || !els.length) {
    toast('先按「拉點線面」進入編輯模式，把過濾器切到「點」，選兩個以上的點再按', true);
    return;
  }
  if (els.some(e => e.kind !== 'vertex')) {
    toast('「多點連接」只吃點 —— 把上面的過濾器切到「點」，再選角', true);
    return;
  }
  if (els.length < 2) {
    toast('「多點連接」至少要選兩個點。開上面那顆「加選」或按 Shift 點第二個；'
        + '再點一次可以取消', true);
    return;
  }

  const obj = els[0].obj;
  const oldMesh = obj.mesh();
  const r = connectVertsPath(oldMesh, els.map(e => e.vert));
  if (!r.ok) { toast(r.reason, true); return; }

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();
  commit(r.segments > 1 ? `多點連接（${r.segments} 段）` : '多點連接');

  /**
   * ⚠ 一定要在 commit() 之後才選 —— 跟環切、切一刀、擠出同一條理由：
   * commit() 會走 revalidate()，而這裡換掉了整個網格物件，
   * 那裡會把子元素選取清掉。先選後 commit 等於白做。
   */
  const di = r.mesh._vertIndex();
  const want = new Set(r.newEdges.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)));
  const hes = [];
  for (const he of r.mesh.edges()) {
    const a = di.get(he.v.id), b = di.get(he.to.id);
    if (want.has(a < b ? `${a}-${b}` : `${b}-${a}`)) hes.push(he);
  }
  const got = sel.selectEdges(obj, hes);
  panel.refresh();
  updateBar();
  updateEditNum();

  /**
   * ⚠ **一定要講「形狀沒有變」**。這一顆跟環切、內縮一樣是「只加線」，
   * 而使用者按下去只會看到多一條線 —— 不講的話很容易以為它沒作用
   * 或是偷偷改了什麼（坑第 21 條）。
   */
  const bits = [r.segments > 1
    ? `已連好 ${r.segments} 段　形狀沒有變`
    : '已連接　多了一條線，形狀沒有變'];
  if (got) bits.push(`新的 ${got} 條線已選起來，用箭頭直接拉`);
  toast(bits.join('　'));
}

/**
 * 🔴 **點連成面：選好幾個點，照選取順序圍出一個面**（＝ Blender 的 `F`）。
 *
 * ⭐ 它跟旁邊兩顆是一組，但各做各的：
 * **`多點連接`** → 一串點變一串**線**；
 * **`補洞`** → 不必選，把每個**完整的一圈**邊界補成面；
 * **這一顆** → 一串點變**一個面**（補洞認不出的那種洞）。
 *
 * ⚠ **三種擋下來的情形，每一種都要講清楚原因**（少於 3 個點／
 * 有邊兩側都已經有面／這幾個點已經有面了）—— 幾何全在 `edit.js`，
 * ⛔ 這裡只負責流程與回報。
 *
 * ⚠ **不平的面照建，但要講出偏離多少**（kang 2026-08-27 同意）——
 * ⛔ 不擋是刻意的：可以先建再按 `壓平` 修，兩顆按鈕各司其職。
 */
function faceFromVertsSelected() {
  const els = sel.editSels;
  if (!sel.editMode || !els.length) {
    toast('先按「拉點線面」進入編輯模式，把過濾器切到「點」，選 3 個以上的點再按', true);
    return;
  }
  if (els.some(e => e.kind !== 'vertex')) {
    toast('「點連成面」只吃點 —— 把上面的過濾器切到「點」，再選角', true);
    return;
  }

  const obj = els[0].obj;
  const r = faceFromVerts(obj.mesh(), els.map(e => e.vert));
  if (!r.ok) { toast(r.reason, true); return; }

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();
  commit(`點連成面（${r.n} 個點）`);
  panel.refresh();
  updateBar();
  updateEditNum();

  /**
   * ⚠ **不平就講出來，⛔ 而且要給出路** —— 只說「不平」是講了問題沒給
   * 解法（坑第 11 條）。⭐ 出路就在旁邊：`壓平`。
   * 容許值用 0.01 cm（＝ 0.1mm，可切容許值），⛔ 不用 1e-6（那是浮點數的尺度）。
   */
  const bits = [`已建好一個 ${r.n} 邊的面`];
  if (r.flatness > 0.01) {
    bits.push(`⚠ 這個面不是平的（最大偏離 ${fmtCm(r.flatness)} cm）—— 想弄平就接著按「壓平」`);
  }
  toast(bits.join('　'));
}

/**
 * 🔴 **面上加線：選兩條邊，各長一個點再連起來。**
 *
 * ⚠ **它跟「連接兩點」是兩顆按鈕**（kang 2026-08-25 拍板：
 * 「畢竟效果呈現不同」）——
 * 連接兩點連的是**既有的角**（切出三角形），
 * 這一顆是在邊上**長出新的點**（切出矩形，也就是他要的「兩等分」）。
 */
function splitFaceSelected() {
  const els = sel.editSels;
  if (!sel.editMode || !els.length) {
    toast('先按「拉點線面」進入編輯模式，把過濾器切到「邊」，選兩條邊再按', true);
    return;
  }
  if (els.some(e => e.kind !== 'edge')) {
    toast('「面上加線」只吃邊 —— 把上面的過濾器切到「邊」，再選兩條邊', true);
    return;
  }
  if (els.length !== 2) {
    toast(`「面上加線」要正好選兩條邊，現在選了 ${els.length} 個。`
        + '開上面那顆「加選」或按 Shift 點第二條；再點一次可以取消', true);
    return;
  }

  const t = +$('splitFaceT').value;
  if (!Number.isFinite(t)) { toast('位置要打一個數字（0.5 ＝ 正中間）', true); return; }

  const obj = els[0].obj;
  const oldMesh = obj.mesh();
  const r = splitFaceByEdges(oldMesh, els[0].he, els[1].he, t);
  if (!r.ok) { toast(r.reason, true); return; }

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();      // 被插點的邊如果標過 CUT，線段變兩截了
  commit(t === 0.5 ? '面上加線（兩等分）' : `面上加線（${t}）`);

  /** ⚠ 一定要在 commit() 之後才選 —— 跟環切、切一刀、連接兩點同一條理由 */
  const di = r.mesh._vertIndex();
  const want = new Set(r.newEdges.map(([a, b]) => (a < b ? `${a}-${b}` : `${b}-${a}`)));
  const hes = [];
  for (const he of r.mesh.edges()) {
    const a = di.get(he.v.id), b = di.get(he.to.id);
    if (want.has(a < b ? `${a}-${b}` : `${b}-${a}`)) hes.push(he);
  }
  const got = sel.selectEdges(obj, hes);
  panel.refresh();
  updateBar();
  updateEditNum();

  /**
   * 🔴 **一定要講「旁邊的面也跟著多了一個點」** ——
   * 那是使用者**看得見**的副作用（側面多一條短線），
   * 不講的話他會以為程式亂加東西（坑第 11、21 條）。
   */
  const bits = [t === 0.5 ? '已在面上加線　切在正中間' : `已在面上加線　切在 ${t}`];
  if (got) bits.push('新的線已選起來，用箭頭直接拉');
  if (r.touched) {
    bits.push(`⚠ 旁邊 ${r.touched} 個面也跟著多了一個點 —— 那是必須的，不然網格會破洞`);
  }
  toast(bits.join('　'));
}

/**
 * 座標框旁邊那行範圍字。
 *
 * 🔴 **這不是裝飾。** 沒有它，使用者根本不知道該打什麼數字 ——
 * 座標是空間裡的實際位置，而物件被搬過之後更猜不到。
 * 鐵律三：「讓兩個數字互相對得起來，錯誤才會自己現形」——
 * 打的數字跟旁邊的範圍對不起來，當場就看得出來，不必按下去才知道。
 */
function updateBisectRange() {
  const span = $('bisectRange');
  const obj = sel.active;
  if (!obj) { span.textContent = ''; return; }
  const b = worldBounds(obj);
  if (b.isEmpty()) { span.textContent = ''; return; }
  const ax = $('bisectAxis').value;
  const f = x => (Math.round(x * 100) / 100);
  const lo = b.min[ax], hi = b.max[ax];
  span.textContent = `${ax.toUpperCase()}：${f(lo)} ～ ${f(hi)}`;

  /**
   * 🔴 **框裡的數字切不到，就換成範圍的中點。**（kang 2026-08-25 選的）
   *
   * ⚠ **這是 kang 實測第一次按就踩到的**：`index.html` 把預設值寫死
   * `value="0"`，而範圍是**照物件算出來的** —— 兩個數字沒有任何關聯，
   * 所以物件只要不跨過 0，**第一次按必定跳「沒有切到東西」**。
   * 那正是鐵律三反過來的樣子：範圍是算的、預設值是寫死的，對不起來。
   *
   * 🔴 **只在「現在這個數字切不到」時才改**，切得到就不動 ——
   * ⛔ 不可以每次都覆蓋，那會把使用者剛打好的數字吃掉。
   *
   * ⚠ **正在打字時完全不碰**（`activeElement`）：`updateBar()` 什麼時候會被
   * 呼叫不是這裡管得到的，打到一半被換掉是最惱人的那種 bug。
   *
   * 邊界要留 `PLANAR_TOL_CM` —— 剛好打在範圍的頭或尾等於「平面貼在表面上」，
   * `bisect()` 那邊會判成整個物件都在同一側，照樣切不到（三態的容許值）。
   * ⛔ 不要另外定一個容許值，它問的是同一件事。
   *
   * 〔厚度小於 2×容許值的板件：中點也切不到，這裡照樣填中點，
   * 　由 `bisect()` 去講原因 —— **那本來就是切不開的**，不是這裡要解的事〕
   */
  const el = $('bisectAt');
  if (document.activeElement !== el) {
    const at = +el.value;
    const t = PLANAR_TOL_CM;
    if (!Number.isFinite(at) || !(at > lo + t && at < hi - t)) {
      el.value = f((lo + hi) / 2);
    }
  }
  updateCutPreview();
}

/**
 * 🔴 **「切一刀」會切在模型的哪條線上 —— 打數字的當下就畫出來。**
 *
 * ⚠ **它補的是一個看不見的東西**：座標框裡打一個數字，那個平面到底
 * 落在模型的哪裡，使用者只能想像 —— 而 kang 為刀具講過同一件事
 * （「不知道要如何點兩點呈現我想要的位置」）。
 *
 * ⚠ 只在**編輯模式而且選到物件**時畫，其餘一律清掉 ——
 * 留在畫面上的舊預覽比沒有預覽更糟（它會描述一個已經不成立的狀態）。
 *
 * ⚠ 效能：`planeCrossSegments()` 是 O(面數)。這裡是**事件驅動**
 * （改軸、改數字、選取變動），⛔ 不在每幀迴圈裡（坑第 22 條）。
 */
function updateCutPreview() {
  const obj = sel.editMode ? sel.active : null;
  if (!obj) { view.clearCutPreview(); return; }
  const at = +$('bisectAt').value;
  if (!Number.isFinite(at)) { view.clearCutPreview(); return; }

  const m4 = obj.matrix();
  const local = worldAxisPlane(m4, $('bisectAxis').value, at);
  const segs = planeCrossSegments(obj.mesh(), local);
  if (!segs.length) { view.clearCutPreview(); return; }
  /** 本地 → 世界：畫面上是世界座標，跟量測面板那條規則同一套數字 */
  view.setCutPreview(segs.map(p => p.clone().applyMatrix4(m4)));
}

/**
 * 選一圈：從選到的那條邊繞出一整圈 edge ring，全部選起來。
 *
 * ⭐ **這顆按鈕幾乎是免費的** —— 走訪（`edgeRing()`）是環切那一輪寫好的，
 * 這裡只是「不切，只選」。而它補的是對照表上那個缺口：
 * **多選現在只能一個一個點，32 片 seg 要點 32 下。**
 *
 * 順帶還有一個用途：**按下去就看得到環切會切在哪** ——
 * 先看再切，比切完再 Undo 好。
 */
function selectRingFromEdge() {
  const el = sel.editSel;
  if (!el || el.kind !== 'edge') {
    toast('先在編輯模式下選一條邊，再按「選一圈」', true);
    return;
  }
  if (sel.editCount > 1) {
    toast(`選一圈一次只能從一條邊出發（現在選了 ${sel.editCount} 個）`, true);
    return;
  }
  const r = edgeRing(el.obj.mesh(), el.he);
  if (!r.hes.length) { toast('從這條邊繞不出一圈', true); return; }

  const got = sel.selectEdges(el.obj, r.hes);
  panel.refresh();
  updateBar();
  updateEditNum();
  toast(r.closed
    ? `已選起一整圈 ${got} 條邊（繞回來了）`
    : `已選起 ${got} 條邊（沒有繞回來 —— 撞到不是四邊形的面就會停，那是正常的）`);
}

/**
 * 🔴 **選一圈面：跟「選一圈」走同一條路，但選起來的是面。**
 *
 * ── ⭐ 走訪一行新的都沒有 ────────────────────────────
 * `loopFaces()` ＝ `edgeRing()` 走訪時穿進去的那些面。
 * **邊環與面迴圈本來就是同一條路徑的兩種讀法。**
 *
 * ── 🔴 為什麼種子是「一條邊」而不是「一個面」──────────────
 * **一個四邊形有兩個方向**，從面出發結果不唯一（坑第 24 條）。
 * ⚠ 這也是它跟 Blender 的差別：Blender 用「游標離哪條邊近」暗示方向，
 * 而我們的操作是平板優先 —— **明確點一條邊比猜游標位置可靠**。
 *
 * ── ⚠ 順序不能反：先換過濾器，再選面 ──────────────────
 * 🔴 `setEditFilter()` **會清掉不合型別的選取**（它自己回報 `dropped`）。
 * 反過來寫的話：選好 32 個面 → 切到「面」→ **32 個面全部被清光**，
 * 而畫面上什麼都不會發生。〔「東西安靜地不見了」那一類，坑第 21 條〕
 * ⛔ 所以 `el.obj` 與 `el.he` 一定要**先存起來**再切。
 */
function selectFaceRingFromEdge() {
  const el = sel.editSel;
  if (!el || el.kind !== 'edge') {
    toast('先在編輯模式下選一條邊，再按「選一圈面」', true);
    return;
  }
  if (sel.editCount > 1) {
    toast(`選一圈面一次只能從一條邊出發（現在選了 ${sel.editCount} 個）`, true);
    return;
  }

  /** ⚠ 先存 —— 下一行就會把選取清掉 */
  const obj = el.obj;
  const r = loopFaces(obj.mesh(), el.he);
  if (!r.faces.length) { toast('從這條邊繞不出一圈面', true); return; }

  setEditFilter('face', true);          // quiet：⛔ 它的提示會蓋掉下面那句
  const got = sel.selectFaces(obj, r.faces);
  panel.refresh();
  updateBar();
  updateEditNum();

  /**
   * ⚠ **講數量，而且講「面」** —— 沒有單位就不是數量。
   * 〔kang 2026-08-27 反問過「360 個甚麼?邊?」〕
   * ⭐ 順帶講一句模式換了，⛔ 不要讓他發現時以為自己按錯。
   */
  toast(r.closed
    ? `已選起一整圈 ${got} 個面（繞回來了）　上面那排已切到「面」`
    : `已選起 ${got} 個面（沒有繞回來 —— 撞到不是四邊形的面就會停，那是正常的）　`
      + '上面那排已切到「面」');
}

/**
 * 🔴 **選一條線：從選到的那條邊，順著同一條線一直走到底。**
 *
 * ── ⚠ 它跟「選一圈」是兩顆按鈕，而且是 kang 拍板的 ──────────
 * 〔2026-08-26。判準是他為「切一刀 vs 環切」定過的那條：
 * 　**功能之間的定位不可以互相模糊**〕
 *
 * | | 走法 | 球上選一條經線邊會拿到 |
 * |---|---|---|
 * | **選一圈**（邊環） | 橫著跨過四邊形 | **繞球一圈**，每條經線各一條 |
 * | **選一條線**（邊迴圈） | 順著同一條線走 | **整條經線**，從極走到極 |
 *
 * ⭐ **它解掉「瓣片展開 A」的卡點** —— 選一整條經線標成分片切割線，
 * 原本要點 384 條邊。
 * ⚠ 日誌原本寫「動工第一件事：實測『選一圈』抓不抓得到經線」——
 * **實測答案是抓不到**（只抓到 1 條），要的是這一支。
 */
function selectLoopFromEdge() {
  const el = sel.editSel;
  if (!el || el.kind !== 'edge') {
    toast('先在編輯模式下選一條邊，再按「選一條線」', true);
    return;
  }
  if (sel.editCount > 1) {
    toast(`選一條線一次只能從一條邊出發（現在選了 ${sel.editCount} 個）`, true);
    return;
  }
  const r = edgeLoop(el.obj.mesh(), el.he);
  if (!r.hes.length) { toast('從這條邊走不出一條線', true); return; }

  const got = sel.selectEdges(el.obj, r.hes);
  panel.refresh();
  updateBar();
  updateEditNum();

  /**
   * 🔴 **只選到一條時一定要講出原因** —— 否則那就是一顆
   * 「按了畫面上什麼都不會變」的按鈕（坑第 21 條）。
   * ⚠ 而在方塊與圓柱上**它本來就只會選到一條**（角是三價），
   * 那是正確行為，不是壞掉。
   */
  if (got <= 1) {
    toast('只選到這一條 —— 這條線的兩頭都撞到「不是四個邊交會」的點了。'
        + '方塊與圓柱的角就是這種點；球的經線才走得長', true);
    return;
  }
  toast(r.closed
    ? `已選起一整條 ${got} 條邊（繞回起點了）`
    : `已選起一整條 ${got} 條邊（兩頭停在不是四個邊交會的點，那是正常的）`);
}

/**
 * 🔴 **選轉角：依夾角一次選出所有折起來的邊。**
 *
 * ── ⭐ 它對分片是一條捷徑（對照表標 ⭐⭐）────────────────
 * 一次選出所有轉角，再決定哪幾條要標成切割線 —— ⛔ 不必一條一條點。
 *
 * ── ⚠ 平板按下去是 0 條，而那一定要講出原因 ───────────
 * 平板整圈都是**邊界邊**（只有一側有面），`isMarkable()` 早就擋掉了 ——
 * 理由是「它本來就是外輪廓」。**安靜地沒反應 ＝ 坑第 21 條**，
 * 所以這裡把 `boundarySkipped` 拿出來講。
 *
 * ── ⚠ 講數量，而且講得出使用者驗得出來的數字 ────────────
 * 方塊 30 度應該是 **12 條**、32 段圓柱應該是 **2 條**（上下兩圈，
 * 側面夾角只有 11.25 度）。⭐ **他數得出來的數字才有對答案的價值**
 * 〔「開清單時要講數量與形狀」那條〕。
 */
function selectSharpEdges() {
  const obj = sel.active;
  if (!sel.editMode || !obj) {
    toast('先按「拉點線面」進入編輯模式，選到物件再按「選轉角」', true);
    return;
  }
  const deg = +$('sharpDeg').value;
  if (!Number.isFinite(deg) || deg <= 0) {
    toast('「幾度以上算轉角」要打一個大於 0 的數字', true);
    return;
  }

  const r = sharpEdges(obj.mesh(), deg);
  if (!r.hes.length) {
    /**
     * 🔴 **兩種 0 條的原因完全不同，一定要分開講** ——
     * 「這個形狀沒有那麼折的地方」是調數字就有救，
     * 「整圈都是開口邊緣」是調數字永遠沒救。
     */
    if (r.scanned === 0 && r.boundarySkipped > 0) {
      toast(`沒有選到 —— 這個物件看得見的邊全部是【開口邊緣】`
          + `（${r.boundarySkipped} 條，只有一側有面，例如平板的四周）。`
          + `開口邊緣沒有夾角可以算，它本來就是外輪廓`, true);
    } else {
      toast(`沒有一條邊折得到 ${deg} 度（掃過 ${r.scanned} 條）。`
          + `把度數調小一點再按一次`, true);
    }
    return;
  }

  const got = sel.selectEdges(obj, r.hes);
  panel.refresh();
  updateBar();
  updateEditNum();

  const parts = [`已選起 ${got} 條轉角（${deg} 度以上，掃過 ${r.scanned} 條）`];
  /** 凹凸分開講：谷折那幾條在展開圖上是另一種折線，值得先看到 */
  if (r.convex && r.concave) parts.push(`凸角 ${r.convex} 條、凹角 ${r.concave} 條`);
  if (r.boundarySkipped) parts.push(`另有 ${r.boundarySkipped} 條開口邊緣沒有算進來`);
  toast(parts.join('　'));
}

/**
 * 🔴 **選相似：跟【最後選的】那一個同一類的，全部選起來。**
 *
 * ── ⚠ 種子是 active，不是第一個選的 ────────────────────
 * 跟「中心 ＝ 最後選的」「法向的切線看 active」同一套 ——
 * ⛔ 橘色那個元素的意義不可以在不同功能底下不一樣。
 *
 * ── ⚠ 判準跟型別對不起來時要講，⛔ 不可以安靜地回 0 個 ────
 * 〔坑第 11 條：沉默地退回是最糟的做法〕
 */
function selectSimilar() {
  const el = sel.editSel;
  if (!sel.editMode || !el) {
    toast('先在編輯模式下選一個面或一條邊當範本，再按「選相似」', true);
    return;
  }
  const mode = $('similarMode').value;
  const r = similarTo(el.obj.mesh(), el, mode);
  if (r.reason) { toast(r.reason, true); return; }

  const label = $('similarMode').selectedOptions[0].textContent;
  let got = 0;
  if (r.kind === 'face') got = sel.selectFaces(el.obj, r.faces);
  else got = sel.selectEdges(el.obj, r.hes);

  if (!got) { toast(`沒有找到${label}的元素（掃過 ${r.scanned} 個）`, true); return; }
  panel.refresh();
  updateBar();
  updateEditNum();

  /**
   * ⚠ **「1 個」要特別講** —— 那表示只選到範本自己，
   * 使用者會以為按鈕壞了（坑第 21 條）。
   */
  if (got === 1) {
    toast(`只選到 1 個 —— 這個物件上沒有其他${label}的`
        + `${r.kind === 'face' ? '面' : '邊'}（掃過 ${r.scanned} 個）`, true);
    return;
  }
  toast(`已依【${label}】選起 ${got} 個${r.kind === 'face' ? '面' : '邊'}`
      + `（掃過 ${r.scanned} 個）`);
}

/**
 * 🔴 **隔一個選一個：把選到的那一圈，隔幾個留一個。**
 *
 * ── 它拿來做什麼 ──────────────────────────────────────
 * **格柵鏤空**：`選一圈面` 32 片 → 這顆留 16 片 → `刪除面`。
 *
 * ── ⚠ 順序由 `checkerPick()` 自己排，⛔ 這裡不可以把陣列順序當幾何順序 ──
 * 理由（圓柱會碰巧通過、別的形狀會錯）寫在 `selectops.js` 那一支，
 * ⛔ 不在這裡抄第二份〔文件鐵律一：同一條規則只寫一次〕。
 *
 * ── 🔴 兩件一定要講出來的事 ──────────────────────────
 * ① **排不出一圈**：擋下來講原因 ＋ 講下一步（`reason` 自己帶著出路）。
 * ② **接縫處有兩個連在一起**（總數除不盡）：⛔ 不可以安靜地讓格柵少一格 ——
 *    使用者會以為是程式漏掉一片。
 */
function selectChecker() {
  const els = sel.editSels;
  if (!sel.editMode || !els.length) {
    toast('先在編輯模式下選好一圈面或一圈邊，再按「隔一個選一個」', true);
    return;
  }
  const obj = els[0].obj;
  const nth = +$('checkerNth').value;
  const from = +$('checkerFrom').value;
  if (!Number.isFinite(nth) || nth < 2) {
    toast('「隔幾個」要打一個 2 以上的數字（2 ＝ 留一個跳一個）', true);
    return;
  }
  if (!Number.isFinite(from) || from < 1) {
    toast('「從第幾個開始」要打 1 以上的數字', true);
    return;
  }

  const r = checkerPick(obj.mesh(), els, { nth, from });
  if (r.reason) { toast(r.reason, true); return; }

  const got = r.kind === 'face'
    ? sel.selectFaces(obj, r.faces)
    : sel.selectEdges(obj, r.hes);
  panel.refresh();
  updateBar();
  updateEditNum();

  const n = r.kind === 'face' ? '面' : '邊';
  const parts = [`${r.total} 個${n} → 留下 ${got} 個（隔 ${nth} 個留一個`
    + `${from > 1 ? `，從第 ${from} 個開始` : ''}）`];
  /**
   * 🔴 **接縫那一句 ⛔ 不可以省** —— 五角柱 5 個隔 2 留 3 個，
   * 其中兩個一定是連在一起的，而**畫面上看起來就像少挑了一格**。
   */
  if (r.seamAdjacent) {
    parts.push(`⚠ 繞回起點的地方有兩個連在一起 —— ${r.total} 個除不盡 ${nth}，`
      + `這是躲不掉的，⛔ 不是漏掉一個`);
  }
  if (!r.closed) parts.push('（這是一條，沒有繞回來）');
  toast(parts.join('　'));
}

/**
 * 內縮：沿著選到那個面的外緣，往面內長出一圈新的邊。
 *
 * ── 它只加線，形狀一格都不變 ────────────────────────────
 * 體積與面積**精確不變**（測試釘著）。要凹下去是下一步「拉面」的事。
 *
 * ── 為什麼不做 Blender 的 Depth（內縮同時往法向推）────────
 * kang 2026-08-25 選的，**跟擠出的方案 C 同一個形狀**：
 * 內縮只負責加線 → 內圈那個新面**自動選中** → 用已經驗過的
 * 「拉面 × 法向」推到想要的深度（還可以打精確數字）。
 * **一個動作一件事，零行新的拖曳邏輯**，而凹槽、面板開口、邊框全做得出來。
 *
 * 實測（方塊頂面 60×40）：內縮 5 再沿法向推 10，挖掉的體積是
 * ∫₀¹⁰(60−u)(40−u)du ＝ **19333.3333**，程式報的一模一樣 ——
 * 那是斜壁凹槽的真值，連牆是斜的都算進去了。
 */
function insetSelected() {
  const el = sel.editSel;
  if (!el || el.kind !== 'face') {
    toast('先在編輯模式下選一個面，再按「內縮」', true);
    return;
  }
  /**
   * ⚠ **一次只能一個面**（跟擠出同一條界線）。
   * 選了好幾個面時擋下來並講清楚 —— 多個不共面的面各自內縮是
   * Blender 的 Individual 模式，那是另一件事，還沒做。
   */
  if (sel.editCount > 1) {
    toast(`內縮一次只能一個面（現在選了 ${sel.editCount} 個）。點一下那個面單獨選它`, true);
    return;
  }
  const w = +$('insetW').value;
  if (!(w > 0)) { toast('內縮寬度要大於 0', true); return; }

  const obj = el.obj;
  const r = insetFaces(obj.mesh(), el.face, w);
  if (!r.ok) { toast(r.reason, true); return; }

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();
  commit(`內縮 ${w} cm`);

  /** ⚠ 一定要在 commit() 之後才選（跟擠出、環切同一條理由） */
  const got = r.innerFace ? sel.selectFace(obj, r.innerFace) : false;
  panel.refresh();
  updateBar();
  updateEditNum();

  const bits = [`已內縮 ${w} cm（新增 ${r.ring} 條邊${r.loops > 1 ? `、${r.loops} 圈` : ''}）`];
  /**
   * ⚠ 夾角接近 180 度時 miter 會爆掉，所以有 5 倍上限（`shell()` 的老規矩）。
   * 被夾住代表那幾個角**沒有推到你要求的寬度** —— 那是他驗得出來的差異，要講。
   */
  if (r.clamped) bits.push(`⚠ ${r.clamped} 個角太平（接近 180°），推距被限制在 5 倍以內`);
  if (got) bits.push('內圈那個面已選起來，用箭頭沿法向推就是凹槽');
  toast(bits.join('　'));
}

/**
 * 導角：把選到的邊換成一片斜切面，角落自己會長出來。
 *
 * ── ⚠ 刻意**不**自動選中新長出來的面 ──────────────────
 * 擠出／環切／內縮都會自動選中，但那條規則其實不是「一律自動選中」，
 * 而是「**自動選中你接下來八成要動的那個東西**」：
 * 擠出的初始距離只是佔位一定要調、環切的那一圈是拿來拉斜面的、
 * 內縮的內圈面是拿來推凹槽的。
 *
 * **導角不一樣**：寬度已經在輸入框給了，按下去形狀就完成了。
 * 而且它**一次可能長出很多片**（12 條邊全導 ＝ 12 片斜切 ＋ 8 個角落），
 * gizmo 會停在它們的共同重心 —— **也就是模型正中央，在裡面**，
 * 那不只是沒幫助，是擋住使用者看形狀。
 * 〔kang 2026-08-25 同意這個判斷〕
 *
 * ── 角落是唯一的，不必問使用者 ────────────────────────
 * Blender 為角落開了 Miter 三個選項，**那是因為多段導角（圓角）**。
 * 單段（斜切）在 3 價頂點上角落唯一 —— 而我們的頂點全是 3 價。
 * 推導與四個案例的數字見 `外部參考-Blender編輯.md` 第 11 節。
 */
function bevelSelected() {
  const els = sel.editSels.filter(e => e.kind === 'edge');
  if (!els.length) {
    toast('先在編輯模式下選一條邊（可以開「加選」選好幾條），再按「導角」', true);
    return;
  }
  if (els.length !== sel.editCount) {
    toast('導角只吃邊，選取裡混到了點或面。請只選邊', true);
    return;
  }
  const w = +$('bevelW').value;
  if (!(w > 0)) { toast('導角寬度要大於 0', true); return; }
  /** 段數：1 ＝ 斜切邊，2 以上 ＝ 圓角。**同一個功能的兩端，不是兩顆按鈕** */
  const segs = Math.max(1, Math.min(BEVEL_MAX_SEG, Math.round(+$('bevelSeg').value || 1)));

  const obj = els[0].obj;
  const r = bevelEdges(obj.mesh(), els.map(e => e.he), w, { segments: segs });
  if (!r.ok) { toast(r.reason, true); return; }

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();
  const what = segs > 1 ? `導圓角（${segs} 段）` : '導角';
  commit(els.length > 1 ? `${what} ${els.length} 條邊 ${w} cm` : `${what} ${w} cm`);

  /**
   * ⚠ 選取一定要清掉 —— 舊的 HalfEdge 參考已經不在文件裡了。
   * `commit()` 會走 `revalidate()` 自己清，這裡不再選新的東西（見檔頭）。
   */
  panel.refresh();
  updateBar();
  updateEditNum();

  /**
   * 🔴 **講出可以對答案的數字**：導了幾條邊、長出幾片斜切面、幾個角落面。
   * 使用者自己數得出來（一個角落三條邊一起導 → 3 片 ＋ 1 個角落），
   * 而**兩個數字互相對得起來，錯誤才會自己現形**（鐵律三）。
   */
  const bits = segs > 1
    ? [`已導圓角 ${r.edges} 條邊（${w} cm、${segs} 段）　新增 ${r.walls} 片`]
    : [`已導角 ${r.edges} 條邊（${w} cm）　新增 ${r.walls} 片斜切面`];
  if (r.corners) bits.push(`${r.corners} 個角落`);
  /**
   * 🔴 **段數越高越接近真圓，但量出來的永遠是網格真值。**
   * 這句跟「尺寸的依據」是同一條規則（第 12.3 節）——
   * ⛔ 不要拿理想圓去「修正」圓角尺寸。段數是**建模階段的決定**。
   * 講出來是為了讓使用者知道「不夠圓就把段數開高」，而不是回頭懷疑尺寸。
   */
  if (segs > 1) bits.push('要更圓就把段數調高（尺寸一律是量得到的真值）');
  if (r.clamped) bits.push(`⚠ ${r.clamped} 個角太平（接近 180°），推距被限制在 5 倍以內`);
  if (r.lostMarks) bits.push(`⚠ ${r.lostMarks} 條被導掉的邊，上面的標記跟著消失了（那條邊已經不存在）`);
  /**
   * 🔴 **曲面上導角，斜切面本身不會是平的 —— 那是取捨，不是壞掉。**
   * 不可能兩邊都平：改成垂直偏移的話，旁邊那個既有的面反而會不平，那更糟。
   * ⛔ **所以不擋，但一定要講** —— 板材要切的話那幾片得先壓平或改用剖面分切。
   * 方塊、圓柱那些常見情形本來就是平的，不會看到這句。
   * 〔坑第 18 條：誤報比漏報糟；鐵律三：把數字講出來讓他自己判斷〕
   */
  if (r.nonPlanar) {
    bits.push(`⚠ ${r.nonPlanar} 片斜切面不是平的（最大偏離 ${r.nonPlanarWorst.toFixed(3)} cm）`
            + ` —— 曲面導角本來就會這樣，要拿去切板材的話先壓平`);
  }
  toast(bits.join('　'));
}

/**
 * 刪除面：把選到的面拿掉，那裡就變成一個洞。
 *
 * ⚠ **代價一定要講清楚**：網格會變**開放**，之後不能再做布林運算
 * （`canBool` 擋開放件），展開與 STL 的行為也會變。
 * 而那件事**畫面上看不出來** —— 少一片的方塊從外面看跟完整的一模一樣。
 * 〔坑第 24 條的家族：使用者要知道自己付了什麼代價〕
 */
function deleteFacesSelected() {
  const els = sel.editSels.filter(e => e.kind === 'face');
  if (!els.length) {
    toast('先在編輯模式下選一個面（可以開「加選」選好幾個），再按「刪除面」', true);
    return;
  }
  if (els.length !== sel.editCount) {
    toast('刪除面只吃「面」，選取裡混到了點或邊。請只選面', true);
    return;
  }
  const obj = els[0].obj;
  const r = deleteFaces(obj.mesh(), els);
  if (!r.ok) { toast(r.reason, true); return; }

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();
  commit(els.length > 1 ? `刪除 ${els.length} 個面` : '刪除面');
  panel.refresh();
  updateBar();
  updateEditNum();

  const bits = [`已刪除 ${r.removed} 個面`];
  if (r.orphans) bits.push(`順手清掉 ${r.orphans} 個沒人用的頂點`);
  /**
   * 🔴 **「從封閉變成開放」是這個動作最大的代價，而且畫面上看不出來。**
   * 一定要講，而且要講出出路（「補洞」補得回來）。
   */
  if (r.wasClosed && !r.nowClosed) {
    bits.push('⚠ 現在是開放的（有洞）→ 不能再做布林運算，展開與 STL 的行為也會變。'
            + '要補回去按「補洞」');
  }
  toast(bits.join('　'));
}

/**
 * 補洞：把物件上**所有**的洞補起來。
 *
 * ── 為什麼不是「選一個洞補一個」──────────────────────
 * 🔴 **邊界邊在編輯模式下點不到** —— 挑邊走 `nearestMarkableEdge()`，
 * 而它明文排除邊界邊（對分片而言那是對的）。所以使用者選不到洞。
 * → 做成「全部補起來」，跟 Blender 的 Fill Holes 一樣。
 *
 * ⚠ **不需要進編輯模式**，選到物件就能按 —— 它處理的是整個物件。
 */
function fillHolesOnSelected() {
  const obj = sel.active;
  if (!obj) { toast('先選一個物件', true); return; }
  if (obj.isParametric) {
    toast('參數物件補了也留不住（開檔會照參數重新生成）。請先按「轉成可編輯網格」', true);
    return;
  }
  const r = fillHoles(obj.mesh());
  if (!r.ok) { toast(r.reason); return; }      // 藍色：這是說明，不是錯誤

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();
  commit(r.holes > 1 ? `補 ${r.holes} 個洞` : '補洞');
  panel.refresh();
  updateBar();

  const bits = [`已補 ${r.holes} 個洞（${r.sizes.map(n => `${n} 邊形`).join('、')}）`];
  if (r.nowClosed) bits.push('表面現在是封閉的');
  if (r.fakeSeams) bits.push(`順手清掉 ${r.fakeSeams} 條假的分片線（那是洞的邊界自動標的）`);
  /**
   * 🔴 **把體積講出來** —— 板件（本來就是一張沒有厚度的面）按了會被封起來，
   * 那時體積是 0，而**畫面上看起來跟原本一模一樣**。
   * 讓他看到那個 0，他自己就知道要 Undo（鐵律三）。
   *
   * 🔴 **⛔ 但只印「補完的」，⛔ 不印「補之前 → 補完」**
   * （2026-08-28 改；完整理由與實證見 `bridgeOnSelected()` 那則）：
   * **補之前必定是開的**（不然沒洞可補），而開放網格的 `volume()`
   * ⛔ 不是體積 —— 同一個形狀搬個高度那個數字就變，還會變負的。
   * ⚠ **這個假數字在補洞裡從一開始就存在，只是從來沒有人去對過它。**
   * ⭐ **而「零體積殼」那個警報完全不受影響** —— 它看的是補完那個數字。
   */
  bits.push(`體積 ${r.mesh.volume().toFixed(2)} cm³`);
  toast(bits.join('　'));
}

/**
 * 🔴 **橋接：物件上剛好兩個洞 → 中間長出一段管。**
 *
 * ── ⚠ 它 ⛔ 不從選取進來，跟 `補洞` 同一條理由 ────────────
 * **洞的邊緣點不到**（`nearestMarkableEdge()` 明文排除邊界邊）——
 * 而那正好就是要接的東西。所以做成「**問整個物件**」。
 * ⚠ **不需要進編輯模式。**
 *
 * ── 🔴 洞不是剛好兩個就擋下來（kang 2026-08-28 選的甲案）──────
 * ⛔ 不做「自動挑最近的兩個」——「**結果不唯一就不要猜**」（坑第 24 條），
 * 而 `補洞` 這條出路是**真的存在的**，所以講得出來要他怎麼辦。
 */
function bridgeOnSelected() {
  const obj = sel.active;
  if (!obj) { toast('先選一個物件', true); return; }
  if (obj.isParametric) {
    toast('參數物件接了也留不住（開檔會照參數重新生成）。請先按「轉成可編輯網格」', true);
    return;
  }
  const mesh = obj.mesh();
  const b = boundaryEdges(mesh);
  if (b.holes !== 2) {
    toast(b.holes === 0
      ? '這個物件沒有洞 —— 橋接是把兩個洞接成一段管。先用「刪除面」各開一個口'
      : `橋接一次只接兩個洞，這個物件有 ${b.holes} 個 —— 請先用「補洞」把不要的補掉`);
    return;
  }
  if (!b.loops[0] || !b.loops[1]) {
    toast('有一個洞的邊緣繞不回來（它在某個頂點上捏成一點），接不了');
    return;
  }

  const turn = Math.round(+$('bridgeTurn').value || 0);
  const r = bridgeLoops(mesh, b.loops[0], b.loops[1], { turn });
  if (!r.ok) { toast(r.reason); return; }        // 藍色：這是說明，不是錯誤

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();
  commit(turn ? `橋接（轉 ${turn} 格）` : '橋接');
  panel.refresh();
  updateBar();

  const bits = [`已接上 ${r.walls} 片側牆（兩圈各 ${r.n} 個點）`];
  if (turn) bits.push(`轉了 ${turn} 格`);
  if (r.nowClosed) bits.push('表面現在是封閉的');
  if (r.fakeSeams) bits.push(`順手清掉 ${r.fakeSeams} 條假的分片線（那是洞的邊界自動標的）`);
  /**
   * 🔴 **體積只印「接完的」，⛔ 不印「接之前 → 接完」。**
   *
   * ⚠ **這一版是改過的，⛔ 不要照直覺加回那個箭頭**
   * 〔kang 2026-08-28 實測第 3 項照出來的〕：
   *
   * > **接之前那個網格必定是開的**（兩個洞才接得起來），
   * > 而 `volume()` 走散度定理，**前提就是封閉** ——
   * > 開放網格算出來的值 ⛔ 不是體積。
   *
   * 【實證】同一個「缺一個蓋的圓柱」，只是擺在不同高度：
   * y+0 → 113802.69　y+50 → 81287.64　y+124 → 33165.36　**y+500 → −211347.85**。
   * 🔴 **形狀一模一樣、數字一直變，還會變負的。**
   * 〔封閉的網格搬到哪體積都一樣 —— 那正是散度定理的前提〕
   *
   * ⚠ **它比「少印一個數字」嚴重**：kang 畫面上原本寫
   * 「211998.16 → 208668.62」，看起來**體積少了 3329**，
   * 而真正的變化是 185725.99 → 208668.61 ＝ **多了**一段錐台。**方向是反的。**
   * 〔坑第 20 條的變體：這次不是單位錯，是**那個數字根本不是體積**〕
   *
   * ⭐ **接完的那個是真的**（`nowClosed` 保證了），所以它照樣對得起來：
   * 32邊柱 ＋ 32邊柱 ＋ 中間的錐台。
   */
  bits.push(`體積 ${r.mesh.volume().toFixed(2)} cm³`);
  toast(bits.join('　'));
}

/**
 * 🔴 修法向：把整個物件的面朝向重算成「一致而且朝外」。
 *
 * ── 為什麼這顆按鈕該存在 ────────────────────────────────
 * **繞向錯了畫面上完全看不出來**（three.js 雙面打光），但 STL 送去列印
 * 會被切片軟體判成非流形。而「3D 列印」面板**早就在報**這件事
 * （「法向朝內（體積算出來是負的），印出來會內外相反」）——
 * **卻沒有給任何修法**。講了問題卻沒有出路，那是坑第 11 條的近親。
 *
 * ⚠ **不需要進編輯模式**：它修的是整個物件，不是某一個元素。
 * ⚠ **參數物件擋下來** —— 參數體是我們自己生的，繞向本來就對；
 * 而且改了也留不住（`mesh()` 會照參數重生）。要修的一定是
 * 匯入的、布林算出來的、或編輯過的網格。
 */
function fixNormalsOnSelected() {
  const obj = sel.active;
  if (!obj) { toast('先選一個物件', true); return; }
  if (obj.isParametric) {
    toast('參數物件的繞向是程式自己生的，本來就正確；'
        + '而且改了也留不住（開檔會照參數重新生成）。'
        + '真的要修請先按「轉成可編輯網格」', true);
    return;
  }

  const oldMesh = obj.mesh();
  const r = recalcNormalsOutside(oldMesh);
  if (!r.ok) { toast(r.reason); return; }      // 藍色：這是說明，不是錯誤

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();
  commit('修正法向');
  panel.refresh();
  updateBar();

  /**
   * 🔴 **把「改了什麼」講出來，而且要讓兩個數字互相對得起來**（鐵律三）。
   * 使用者看不見繞向，所以他唯一能驗的就是**體積由負轉正** ——
   * 那個數字結構分析面板上就有，他自己對得起來。
   */
  const bits = [];
  if (r.fixedInconsistent) bits.push(`${r.fixedInconsistent} 個面的朝向跟鄰居互相矛盾，已經轉正`);
  if (r.flippedComponents) bits.push(`${r.flippedComponents} 個實體整個內外顛倒，已經翻回來`);
  if (r.openComponents) bits.push(`另有 ${r.openComponents} 個開放的殼沒有「外側」可言，只做了一致化`);
  if (r.ambiguousEdges) bits.push(`⚠ ${r.ambiguousEdges} 條邊被 3 個以上的面共用（真的非流形），這支修不了`);
  toast(`已修正法向：${bits.join('；')}　現在體積 ${r.mesh.volume().toFixed(2)} cm³`);
}

/**
 * 翻面：把整個物件的面朝向全部翻過來。
 *
 * ⚠ **刻意只做整個物件，不做選取的面** —— 翻一部分會做出
 * 「相鄰面互相矛盾」的網格，那正是「修法向」要修的病，
 * 沒有理由提供一顆製造它的按鈕。
 *
 * 它存在的理由是**開放的網格**：「外側」對一張沒有厚度的殼在數學上
 * 沒有定義，「修法向」不會去猜（猜反的後果跟原本的病一樣嚴重），
 * 所以留一個讓使用者自己決定的入口。
 */
function flipNormalsOnSelected() {
  const obj = sel.active;
  if (!obj) { toast('先選一個物件', true); return; }
  if (obj.isParametric) {
    toast('參數物件翻了也留不住（開檔會照參數重新生成）。'
        + '請先按「轉成可編輯網格」', true);
    return;
  }
  const r = flipNormals(obj.mesh());
  if (!r.ok) { toast(r.reason, true); return; }

  obj.setMesh(r.mesh);
  refreshAfterEdit(r.mesh);
  view.markGeomDirty();
  view.markSeamsDirty();
  commit('翻面');
  panel.refresh();
  updateBar();
  toast(`已把 ${r.faces} 個面全部翻過來　現在體積 ${r.mesh.volume().toFixed(2)} cm³`
      + '（負的代表朝內，再按一次就翻回去）');
}

// ═══════════════════════════════════════════════════════
//  分片
// ═══════════════════════════════════════════════════════

/**
 * 分片模式：自己決定展開圖從哪裡切開。
 *
 * kang 的原話：「立體造型必須做規劃，如何分配展開的區域，
 * 能夠依序讓 CNC 切割後再組裝結合。」
 *
 * 一個立方體可以六面展成一片（銑 45 度 V 溝折起來）、拆成三片、
 * 或六片全分開。**選哪一種是製造決定，不是計算結果** ——
 * 少一片就少一道對位誤差，但要多一道銑溝工序。
 */
function toggleSeamMode() {
  if (!sel.seamMode) exitOtherModes('seam');
  const on = sel.setSeamMode(!sel.seamMode);
  $('seam').classList.toggle('on', on);
  panel.refresh();
  if (on) {
    toast('分片模式：點稜線＝切開／取消，點面的中央＝整圈切開。再按一次「分片」離開');
  } else {
    toast('已離開分片模式');
  }
}

/**
 * 分片模式下點了畫面。實際的幾何判斷在 seam.js（測得到），
 * 這裡只負責「改了文件之後要做什麼」——記一步 Undo、更新畫面、講一句話。
 */
function seamPick(hit) {
  if (hit.kind === 'blocked') {
    toast(seamBlockReason(hit.obj), true);
    return;
  }

  const mesh = hit.obj.mesh();

  if (hit.kind === 'edge') {
    const on = !isSeam(hit.he);
    setSeam(mesh, hit.he, on);
    commitSeam(hit.obj, on ? '標記切割線' : '取消切割線');
    return;
  }

  if (hit.kind === 'face') {
    // 已經整圈切開的面再點一次就是收回來，所以這一顆是可切換的
    const on = !faceIsCutOut(mesh, hit.face);
    const n = cutAroundFace(mesh, hit.face, on);
    if (!n) { toast('這個面周圍沒有可標記的邊', true); return; }
    commitSeam(hit.obj, on ? `切出這個面（${n} 條邊）` : `收回這個面（${n} 條邊）`);
  }
}

/**
 * 標記完之後一定要講「現在幾片」。
 * 因為標一條邊通常什麼都不會發生 —— 要切到能把面的鄰接關係切斷才會多一片。
 * 不講的話使用者會以為功能壞掉（踩過的坑第 5、18 條那個病）。
 */
function commitSeam(obj, label) {
  // 一定要在 commit()（裡面會 view.sync）之前講，不然這一輪畫面不會重畫接縫
  view.markSeamsDirty();
  commit(label);
  panel.refresh();
  let msg = label;
  try {
    const r = unfoldObject(obj, {});
    msg += `　→ 展開 ${r.stats.total} 片`;
  } catch (e) { /* 算不出來就只講標記本身 */ }
  toast(msg);
}

function setMode(m) {
  if (!sel.setMode(m)) {
    /**
     * 兩個不同的拒絕理由，訊息一定要分開 ——
     * 講錯理由比不講更糟，使用者會去找一個不存在的問題。
     */
    toast(sel.editMode && sel.editSel && sel.editSel.kind === 'vertex'
      ? '一個「點」轉或縮放都不會改變任何座標。要做梯形／收尖請選「邊」或「面」'
      : '這個物件鎖定了縮放', true);
    return;
  }
  syncModeButtons();
  updateEditNum();
}

/**
 * 三顆模式按鈕跟著 gizmo 實際的狀態走。
 *
 * ⚠ **不能只在按下去的時候更新。** 選到一個「點」時 `_attachEditProxy()`
 * 會自己把 gizmo 切回移動，那條路沒有經過 `setMode()` ——
 * 不同步的話按鈕會亮在「旋轉」而箭頭是移動的，**畫面在騙人**。
 */
function syncModeButtons() {
  const m = sel.mode;
  for (const [id, mode] of [['mMove', 'translate'], ['mRot', 'rotate'], ['mScale', 'scale']]) {
    $(id).classList.toggle('on', mode === m);
  }
  /**
   * 🔴🔴 **吸附那一欄跟著模式換，掛在這裡⛔ 不是掛在 `updateBar()`。**
   *
   * ⚠ **`setMode()` ⛔ 沒有叫 `updateBar()`** —— 它只叫 `syncModeButtons()`
   * 與 `updateEditNum()`。寫在 `updateBar()` 裡的話，**按了模式鈕
   * 那一欄不會換**，而選取一變它又突然換了 —— 使用者看到的是
   * 「這個東西時靈時不靈」。〔鐵律二：性質由兩端決定〕
   *
   * ⭐ 而這一支有**四個**呼叫點，⛔ 不只 `setMode()`：選到一個「點」時
   * `_attachEditProxy()` 會自己把 gizmo 切回移動，那條路⛔ 不經過
   * `setMode()`。掛在這裡四個一次涵蓋。
   */
  syncSnapRow();
}

// ═══════════════════════════════════════════════════════
//  吸附
// ═══════════════════════════════════════════════════════

/**
 * 三種變換的吸附，各自一組。
 *
 * ⚠ **`unit` 是給人看的字，`set` 是真正動手的那一支** ——
 * ⛔ 不要把單位寫死在 toast 裡（舊版寫死 `cm`，旋轉一接上去就會說錯話）。
 *
 * `num: false` ＝ **這一種⛔ 不給自由輸入**（縮放）。理由見
 * `select.js` 的 `setSnapScale`：等差與等比兩種需求，
 * 同一個欄位表達不出來。
 */
const SNAP_KIND = {
  translate: { unit: 'cm', num: true,  get: () => sel.snapStep,  set: v => sel.setSnap(v) },
  rotate:    { unit: '度', num: true,  get: () => sel.snapRot,   set: v => sel.setSnapRot(v) },
  scale:     { unit: '倍', num: false, get: () => sel.snapScale, set: v => sel.setSnapScale(v) }
};

/**
 * gizmo 現在掛著沒有。
 *
 * 🔴 **條件要跟 `select.js` 掛 gizmo 的條件【一模一樣】** ——
 * 編輯模式看選到幾個**元素**，物件模式看選到幾個**物件**。
 * ⚠ 抽成一支是因為 `updateBar()` 與 `syncSnapRow()` 兩邊都要問，
 * 而**同一條規則只寫一次**（文件三鐵律之一，在程式碼上同樣成立）。
 *
 * 🔴🔴 **`inPickMode` 是 2026-09-01 補的 —— 上面那句話它自己⛔ 沒做到。**
 *
 * `_refresh()` 掛 gizmo 的真正條件是 **`node && !this.inPickMode`**，
 * 而這裡**只抄了前半**。⇒ 貼合／分片／刀具／鋼筆／參考線那幾個模式下，
 * gizmo 早就 `detach()` 了（⛔ 拖不動任何東西），
 * 而「方向」與「吸附」那兩排**照樣亮在畫面上**。
 *
 * ⚠ **⛔ 這個洞⛔ 不是這一輪弄出來的** —— 它一直都在，只是以前那一排
 * 在物件模式下反正是 hidden，**看不出來**。物件層級的方向一接上就浮出水面。
 * 〔kang 2026-09-01 實測第 8 項照出來的：按了「貼合」，方向那兩顆還在〕
 * ⭐ **同一個病的第二個受害者是吸附那四顆** —— 補在這裡兩邊一起好，
 * 因為它們問的本來就是同一支。
 */
function gizmoOff() {
  return sel.editMode ? sel.editCount === 0 : (sel.count === 0 || sel.inPickMode);
}

/**
 * 🔴🔴 **「方向／中心／數值」那一排長什麼樣 —— ⛔ 只寫這一支。**
 *
 * ── 為什麼要抽出來（2026-09-01，kang 的截圖照出來的）────────
 * 「先進編輯模式 → 直接按貼合」那條路，**整排留在物件模式的畫面上，
 * 按下去完全沒作用**。
 *
 * 🔴 **病因⛔ 不是「沒人呼叫」，是【管轄範圍缺一塊】**：
 * `updateBar()` 每條路都會跑到（`setXxxMode()` → `_refresh()` →
 * `hooks.onChange` → `updateBar()`），但它**只管那一排裡面的按鈕，
 * ⛔ 不管外層容器 `gEditXf`** —— 而容器只有 `toggleEditMode()`
 * 與刀具切完那處會設。⇒ **裡面的按鈕收了，殼還在。**
 *
 * ⚠ **⛔ 我第一版的診斷是錯的**（寫成「貼合那條路沒叫 `updateBar()`」）——
 * 那是只看 `toggleMate()` 表面的推論。〔鐵律一：推論⛔ 不是權威事實〕
 * ⭐ 現在**殼與裡面的按鈕都在這一支**，⛔ 沒有第二個地方碰它們。
 * 〔坑第 31 條：與其讓好幾條路對齊，不如換一個只有一條路的定義〕
 *
 * ── 三組的閘門⛔ 不一樣 ─────────────────────────────
 * | 這一組 | 什麼時候有作用 |
 * |---|---|
 * | **方向**（`.spBtn`）| **兩種模式都有** —— 物件層 2026-09-01 接上了 |
 * | **中心**（`.pvBtn`）| **兩種模式都有，但物件模式要【多選】才有意義** —— 2026-09-01 接上 |
 * | **數值**（`editNum*`）| ⛔ **只有編輯模式** —— `updateEditNum()` 第一行
 *   就是 `sel.editMode ? … : null`，物件模式下永遠 disabled |
 *
 * 🔴 **中心那兩顆在物件模式【選一個】時要收起來** ——
 * 單選時「重心」與「最後選的」**是同一個點**（都是那個物件的原點），
 * ⛔ 給兩顆按不出差別的按鈕，跟畫面說謊沒有兩樣〔鐵律三〕。
 *
 * ⭐ **⛔ 沒作用的就不要放在畫面上**：亮著卻不動，比按鈕不見更難查
 * 〔鐵律三：誤報比漏報更糟〕。
 */
function syncEditXfRow() {
  const off = gizmoOff();
  const edit = sel.editMode;

  $('gEditXf').hidden = off;

  for (const b of document.querySelectorAll('.spBtn')) b.hidden = off;
  /**
   * 🔴 **物件⛔ 沒有「法向」** —— 那是面／邊／點才有的東西。
   * 物件層級的同一顆講的是「**物件自己的角度**」，所以字要換。
   * ⚠ **⛔ 不要為它多開一顆按鈕**：兩邊是同一個概念（非世界方向），
   * 多一顆就是多一個要對齊的狀態，而工具列也擠不下。
   */
  $('spNormal').textContent = edit ? '法向' : '物件';
  $('spNormal').title = edit
    ? '箭頭朝選到那個元素自己的方向：藍色那根（Z）就是面的法向。推斜面、拉梯形靠這個'
    : '箭頭朝物件自己的方向：物件轉過角度之後箭頭跟著歪，拖動就是沿物件自己的軸走，不是沿世界的 X／Y／Z';

  /**
   * ⚠ **標籤要跟著按鈕一起收** —— ⛔ 不收的話會留下一個
   * 孤零零的「中心」兩個字，而它後面什麼都沒有。
   *
   * 🔴 **物件模式要【多選】才給**：單選時兩顆講的是同一個點。
   */
  const pivotOff = off || (!edit && sel.count < 2);
  $('pvLbl').hidden = pivotOff;
  for (const b of document.querySelectorAll('.pvBtn')) b.hidden = pivotOff;

  const editOnly = off || !edit;
  for (const id of ['editNumLbl', 'editNum', 'editNumUnit']) $(id).hidden = editOnly;
}

/**
 * 吸附那一欄：只留下目前模式的那一組，其餘收起來。
 *
 * ⭐ **四顆按鈕的 `on` 也在這裡對** —— 因為使用者可能打了一個
 * 按鈕上沒有的數字（2.5），那時候**四顆都不該亮**：
 * 亮著就是在說「你用的是這一顆給的值」，而那是假的。
 */
function syncSnapRow() {
  const m = sel.mode;
  const k = SNAP_KIND[m];
  const off = gizmoOff();
  const cur = k ? k.get() : 0;

  for (const b of document.querySelectorAll('.snapBtn')) {
    const mine = b.dataset.sm === m;
    b.hidden = off || !mine;
    b.classList.toggle('on', mine && Number(b.dataset.s) === cur);
  }

  /**
   * 🔴 **`吸到參考線` 跟那四顆走同一條顯示規則，但⛔ 不是同一群。**
   * 它是**獨立的開關**，⛔ 不是「格距的其中一個值」——
   * 所以 `on` 問的是 `sel.snapGuides`，⛔ 不是跟 `cur` 比大小。
   */
  const sg = $('snapGuide');
  sg.hidden = off || sg.dataset.sm !== m;
  sg.classList.toggle('on', !!sel.snapGuides);

  const showNum = !off && !!k && k.num;
  $('snapNum').hidden = !showNum;
  $('snapNumUnit').hidden = !showNum;
  if (showNum) {
    $('snapNumUnit').textContent = k.unit;
    // 正在打字時⛔ 不要覆蓋他打到一半的字〔照 updateEditNum 那條〕
    if (document.activeElement !== $('snapNum')) $('snapNum').value = String(cur);
  }
}

/**
 * 四顆按鈕 ＝ **把數字填進欄位的捷徑**，⛔ 不是另一套機制。
 * 〔跟 `editNum` 同一條：入口分開、動作只走一條〕
 */
for (const b of document.querySelectorAll('.snapBtn')) {
  b.onclick = () => applySnap(Number(b.dataset.s));
}

/**
 * 🔴 **吸到參考線：一顆獨立的開關**（2026-09-01，參考線第 2 階段）。
 *
 * ⚠ **開著但一條線都沒有的時候一定要講** —— 否則使用者按了、
 * 拖了、什麼都沒發生，然後以為這顆按鈕壞了。
 * 〔鐵律三：⛔ 不要讓「沒東西可吸」跟「吸附壞了」長得一樣〕
 */
$('snapGuide').onclick = () => {
  const on = sel.setSnapGuides(!sel.snapGuides);
  syncSnapRow();
  if (!on) { toast('吸到參考線：關'); return; }
  const n = doc.guideCount();
  toast(n
    ? `吸到參考線：開　目前有 ${n} 條　⭐ 物件的邊緣或中心靠近就會貼上去`
    : '吸到參考線：開　⚠ 目前一條參考線都沒有 —— 先按左邊的「參考線」加一條', !n);
};

/**
 * 🔴 **Enter 只負責「離開欄位」，⛔ 不要在這裡直接套用。**
 * 直接套用的話 `keydown` 一次、瀏覽器接著發的 `change` 再一次，
 * **同一個動作會走兩遍**（kang 2026-08-25 在 `editNum` 上實測抓到過）。
 */
$('snapNum').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('snapNum').blur(); }
});
$('snapNum').addEventListener('change', () => applySnap(Number($('snapNum').value)));

/**
 * 套用吸附格距。**兩個入口（按鈕／打字）都走這一支。**
 *
 * ⚠ **負數與 NaN 一律當成 0（＝關閉）** —— 打了 `-5` 之後
 * `setTranslationSnap(-5)` 會讓拖曳的行為變得無法解釋，
 * 而使用者⛔ 不會想到是自己那個減號造成的。
 */
function applySnap(v) {
  const k = SNAP_KIND[sel.mode];
  if (!k) return;
  const s = Number.isFinite(v) && v > 0 ? v : 0;
  k.set(s);
  syncSnapRow();
  const NAME = { translate: '移動', rotate: '旋轉', scale: '縮放' };
  toast(s > 0 ? `${NAME[sel.mode]}吸附 ${s} ${k.unit}` : `${NAME[sel.mode]}吸附關閉`);
}

// ═══════════════════════════════════════════════════════
//  參考線（第 1 階段：線本身）
// ═══════════════════════════════════════════════════════

/**
 * 🔴 **參考線：在指定的座標放一條線，用來對齊排列。**
 * kang 2026-08-31 拿 Photoshop「新參考線」的截圖來要的。
 *
 * ── 🔴 三個視角【共用】，⛔ 不是各自一組 ──────────────
 * 他原本要的是「針對每個視角做參考線」，而在 3D 裡那件事**會自己合併**：
 * 一條螢幕上的線其實是**一個平面**，所以「前視拉的直線」跟
 * 「上視拉的直線」**是同一個東西**，只是從兩個方向看它。
 * ⇒ 只有 X／Y／Z 三種，每一種同時出現在**兩個**視角裡。
 * 〔他看完推導後拍板「共用」。完整版在 `規格\建模器-參考線.md`〕
 *
 * ── ⭐ 欄位是唯一的真相，下拉是「選哪一條」──────────────
 * 選 `（新的）` → 打數字 → `加一條`；
 * 選現有的一條 → **欄位自動填上它的值** → 改數字 ＝ 挪它、`刪這條` ＝ 刪它。
 * 🔴 第 3 階段在畫面上點到某條線，就是**在這個下拉裡選了它** ——
 * ⛔ 不是另一套機制。
 *
 * ── Undo ⛔ 什麼都不用做 ────────────────────────────
 * `hist` 的快照就是 `doc.toJSON()`，而參考線在 `doc.guides` 裡。
 * 只要動完呼叫 `commit()`，復原就自動成立。
 */
let guideAxis = 'x';

/** 這一條的座標；`null` ＝ 下拉停在「（新的）」 */
let guidePicked = null;

const GUIDE_AXIS_LABEL = { x: 'X 左右', y: 'Y 上下', z: 'Z 前後' };

/**
 * 🔴 **哪個視角看得出這個軸**（第 3 階段，2026-09-01）。
 *
 * ⚠ 一個視角看得見**兩個**軸，看不見的那個正是**視線的方向**：
 * 前視看 XY（看不出 Z）、上視看 XZ（看不出 Y）、側視看 ZY（看不出 X）。
 * ⇒ 每個軸剛好有**兩個**視角點得到。
 *
 * ⭐ 這張表**只拿來講話**，⛔ 不拿來判斷 —— 判斷是問幾何
 * （`select.js` 的 `_axisValueAt()`），⛔ 不是比對視角名字。
 */
const GUIDE_AXIS_VIEW = { x: '「前」或「上」', y: '「前」或「側」', z: '「上」或「側」' };

/**
 * 把那一排刷成跟 `doc.guides` 一致。
 *
 * ⚠ **每一次動完都要叫** —— 加、刪、清、換方向、**還有 Undo**。
 * 🔴 Undo 那條路⛔ 不經過任何按鈕（`hist.set → loadJSON → view.sync`），
 * 所以它是靠 `updateBar()` 被叫到的（`commit()` 最後一行會叫）。
 */
function syncGuideRow() {
  const on = sel.guideMode;

  /**
   * 🔴🔴 **這裡藏的是【裡面那幾顆】，⛔ 不是那一組本身。**
   *
   * ⚠ **`hideEmptyGroups()` 跑在這一支後面**，而它是照
   * 「裡面還有沒有東西看得見」重設每一組的 `hidden`
   * 【已查證 · `main.js` 的 `hideEmptyGroups()`】——
   * ⇒ 我要是在這裡寫 `$('gGuide').hidden = !on`，
   * **它會在下一行把那一組又打開**，而且⛔ 不會報錯。
   *
   * 🔴 **這正是鐵律二的另一張臉**：兩個地方寫同一個元素的顯示條件，
   * 必然打架。⭐ 分工是「**這一支管裡面那幾顆，組別歸 `hideEmptyGroups()`**」
   * —— 工具列上其他每一組本來就是這樣運作的。
   */
  for (const b of document.querySelectorAll('.gaBtn')) {
    b.hidden = !on;
    b.classList.toggle('on', b.dataset.ga === guideAxis);
  }
  for (const id of ['guideList', 'guideNum', 'guideAdd', 'guideDel', 'guideClear']) {
    $(id).hidden = !on;
  }
  if (!on) return;

  const list = doc.guides[guideAxis] || [];
  /**
   * ⚠ **選中的那一條可能已經不在了**（按了刪除、或 Undo 把它還原掉）——
   * ⛔ 不清掉的話下拉會停在一個不存在的值，而 `刪這條` 按下去沒反應。
   */
  if (guidePicked !== null && !list.some(v => Math.abs(v - guidePicked) < 5e-4)) {
    guidePicked = null;
  }

  const box = $('guideList');
  box.innerHTML = '';
  box.appendChild(new Option(list.length ? '（新的）' : '（還沒有）', ''));
  for (const v of list) box.appendChild(new Option(`${fmtGuide(v)} cm`, String(v)));
  box.value = guidePicked === null ? '' : String(guidePicked);

  $('guideDel').disabled = guidePicked === null;
  $('guideClear').disabled = doc.guideCount() === 0;

  // 正在打字時⛔ 不要覆蓋他打到一半的字〔照 updateEditNum 那條〕
  if (document.activeElement !== $('guideNum')) {
    $('guideNum').value = guidePicked === null ? '' : String(guidePicked);
  }
}

/** ⚠ 尾巴的 0 砍掉：`20` ⛔ 不要印成 `20.0000` */
function fmtGuide(v) { return String(Math.round(v * 1000) / 1000); }

$('guide').onclick = function () {
  const on = !sel.guideMode;
  if (on) exitOtherModes('guide');
  sel.setGuideMode(on);
  this.classList.toggle('on', on);
  guidePicked = null;
  updateBar();
  /**
   * 🔴 **⛔ 不自動幫他鎖視角，但沒鎖就提醒一句**（kang 2026-09-01 拍板）。
   *
   * ⚠ **自動改使用者按過的狀態是這個專案踩過的坑** ——
   * 進 `編輯路徑` 時程式偷偷擺好工具列兩顆，收工⛔ 不還原的話
   * 他下一次畫新東西會莫名其妙變成一道牆，**而他從頭到尾沒按過那顆**。
   * ⭐ 所以這裡只**講**，⛔ 不動。
   */
  toast(on
    ? (view.viewLocked
        ? '參考線：切到「前／側／上」，在畫面上點一下就生一條；點到線可以拖著走'
        : '參考線：在畫面上點之前，先切到「前／側／上」　'
          + '⭐ 要拖線建議先按「視角」那一組的「鎖定」，不然畫面會跟著轉')
    : '參考線關閉');
};

for (const b of document.querySelectorAll('.gaBtn')) {
  b.onclick = () => {
    guideAxis = b.dataset.ga;
    guidePicked = null;          // 換了方向，上一個選擇沒有意義了
    syncGuideRow();
    toast(`參考線方向：${GUIDE_AXIS_LABEL[guideAxis]}　`
      + `這個方向現在有 ${doc.guides[guideAxis].length} 條`);
  };
}

$('guideList').onchange = () => {
  const raw = $('guideList').value;
  guidePicked = raw === '' ? null : Number(raw);
  syncGuideRow();
};

/**
 * 🔴 **Enter 只負責「離開欄位」，⛔ 不要在這裡直接套用。**
 * 直接套用的話 `keydown` 一次、瀏覽器接著發的 `change` 再一次，
 * **同一個動作會走兩遍**（kang 2026-08-25 在 `editNum` 上實測抓到過）。
 */
$('guideNum').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); $('guideNum').blur(); }
});

/**
 * 在欄位打數字：
 * - 下拉停在「（新的）」→ **只是填著**，⛔ 不動任何東西（要按「加一條」）
 * - 下拉選著某一條 → **把那一條挪過去**
 *
 * ⚠ **為什麼「新的」那一半刻意什麼都不做**：打數字的當下就自動加一條的話，
 * 打 `1` 想繼續打 `12` 的人會**先加出一條在 1 的線**。
 * ⭐ 分成「打」與「加」兩步是**故意的**，⛔ 不是漏做。
 */
$('guideNum').addEventListener('change', () => {
  if (guidePicked === null) return;
  const v = parseFloat($('guideNum').value);
  if (!Number.isFinite(v)) { syncGuideRow(); return; }
  if (Math.abs(v - guidePicked) < 5e-4) return;      // 沒動就不記一步 Undo

  const from = guidePicked;
  doc.removeGuide(guideAxis, from);
  if (!doc.addGuide(guideAxis, v)) {
    /**
     * ⚠ **那個位置已經有一條了** —— 剛才刪掉的要放回去，
     * ⛔ 否則使用者會發現「我只是打了個數字，結果少一條線」。
     */
    doc.addGuide(guideAxis, from);
    syncGuideRow();
    toast(`${fmtGuide(v)} cm 已經有一條參考線了，⛔ 沒有搬過去`, true);
    return;
  }
  guidePicked = v;
  commit('挪參考線');
  toast(`參考線 ${GUIDE_AXIS_LABEL[guideAxis]}：${fmtGuide(from)} → ${fmtGuide(v)} cm`);
});

$('guideAdd').onclick = () => {
  const v = parseFloat($('guideNum').value);
  if (!Number.isFinite(v)) {
    toast('先在「位置」打一個數字（單位 cm，可以是負的）', true);
    return;
  }
  if (!doc.addGuide(guideAxis, v)) {
    toast(`${fmtGuide(v)} cm 已經有一條參考線了`, true);
    return;
  }
  guidePicked = v;
  commit('加參考線');
  /**
   * ⭐ **講數量** —— 加了一條之後畫面上多一條青線，
   * 但在斜視角很容易被模型擋住而看不出來。數字對得起來就不會懷疑。
   */
  toast(`參考線 ${GUIDE_AXIS_LABEL[guideAxis]} ＝ ${fmtGuide(v)} cm　`
    + `這個方向現在有 ${doc.guides[guideAxis].length} 條`);
};

$('guideDel').onclick = () => {
  if (guidePicked === null) { toast('先在下拉裡選一條要刪的', true); return; }
  const v = guidePicked;
  if (!doc.removeGuide(guideAxis, v)) { syncGuideRow(); return; }
  guidePicked = null;
  commit('刪參考線');
  toast(`刪掉 ${GUIDE_AXIS_LABEL[guideAxis]} ＝ ${fmtGuide(v)} cm　`
    + `這個方向還有 ${doc.guides[guideAxis].length} 條`);
};

$('guideClear').onclick = () => {
  const n = doc.guideCount();
  if (!n) { toast('現在⛔ 沒有任何參考線'); return; }
  doc.clearGuides();
  guidePicked = null;
  commit('清掉全部參考線');
  /**
   * ⚠ **要講「三個方向都清了」** —— 使用者眼前只看得到目前這個方向的下拉，
   * 很容易以為只清了這一個。⭐ 而且要提醒 Undo 救得回來。
   */
  toast(`三個方向的參考線全部清掉了（共 ${n} 條）。按「復原」可以救回來`);
};

$('showGuides').onclick = function () {
  const on = view.setGuidesVisible(!view.guidesVisible);
  this.classList.toggle('on', on);
  /**
   * 🔴 **關掉的時候一定要講「線還在」** —— ⛔ 不講的話它跟「全部清掉」
   * 在畫面上是**一模一樣的**（線都不見了），而那兩件事⛔ 不可以混淆。
   */
  toast(on
    ? `顯示參考線（現在有 ${doc.guideCount()} 條）`
    : `參考線隱藏了 —— ⚠ 線還在、存檔也還在（共 ${doc.guideCount()} 條），⛔ 不是刪掉`);
};

$('marquee').onclick = function () {
  const on = sel.setMarqueeMode(!sel.marqueeMode);
  this.classList.toggle('on', on);
  toast(on ? '框選開啟：拖曳畫矩形，碰到的物件都選起來。滾輪縮放仍然可用'
           : '框選關閉：空白處拖曳恢復成旋轉視角');
};

$('multi').onclick = function () {
  sel.multi = !sel.multi;
  this.classList.toggle('on', sel.multi);
  toast(sel.multi ? '加選開啟' : '加選關閉');
};

$('wire').onclick = function () {
  this.classList.toggle('on');
  view.setWireframe(this.classList.contains('on'));
};
$('edges').onclick = function () {
  this.classList.toggle('on');
  view.setShowEdges(this.classList.contains('on'));
};
$('frame').onclick = () => view.frameAll(doc);

$('save').onclick = () => { download(doc); toast('已存檔'); };
$('load').onclick = loadFile;
$('newDoc').onclick = () => {
  if (doc.objects.length && !confirm('新建會清空目前內容，確定嗎？')) return;
  newDoc();
};

// 鍵盤（桌機）
window.addEventListener('keydown', e => {
  const t = e.target.tagName;
  if (t === 'INPUT' || t === 'SELECT' || t === 'TEXTAREA') return;

  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') {
    e.preventDefault();
    const l = e.shiftKey ? hist.redo() : hist.undo();
    if (l) toast((e.shiftKey ? '重做：' : '復原：') + l);
    updateBar();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); sel.selectAll(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); download(doc); toast('已存檔'); return; }

  if (k === 'w') setMode('translate');
  else if (k === 'e') setMode('rotate');
  else if (k === 'r') setMode('scale');
  else if (k === 'f') view.frameAll(doc);
  else if (k === 'delete' || k === 'backspace') deleteSelected();
  else if (k === 'escape') sel.clear();
});

// ── 狀態列 ────────────────────────────────────────────

/**
 * 🔴 **狀態列的「三角形」＝ 這些模型有幾個三角形，⛔ 不是「這一幀畫了幾個」。**
 *
 * 〔kang 2026-08-26 拍板改的。他的話：「**三角形數字…亂跳**」〕
 *
 * ── 舊的那個數字錯在哪 ────────────────────────────────
 * 原本用 `renderer.info.render.triangles`，那是**上一幀顯示卡實際畫出去的數量**：
 * 轉個視角就變（畫面外的被剔除）、切線框就掉（線框走的是線不是三角形）、
 * gizmo 在不在也算、連陰影那一趟也被算進去。
 * **而標籤寫的是「三角形」** —— 人讀到的是「這個模型有多複雜」。
 * 那是坑第 20 條：**把內部的數字放上介面之前，先問這個數字的單位是什麼。**
 *
 * ⚠ **而「亂跳」還有第二個原因**：舊的更新寫在 `loop()` 裡，
 * 而且**只有 FPS 數字剛好變了才順便更新** —— 所以它顯示的是
 * 一串不相干時刻的快照，中間跳過的完全看不到。那一行已經拿掉了。
 *
 * ⭐ 現在這個數字**只在模型真的變了才會變**，看得懂也對得起來。
 */
function modelTriangles() {
  let n = 0;
  for (const o of doc.objects) {
    const m = o.mesh && o.mesh();
    if (m) n += m.triangleCount();
  }
  return n;
}

function updateBar() {
  $('sObj').textContent = doc.objects.length;
  $('sSel').textContent = sel.count;
  $('sTri').textContent = modelTriangles().toLocaleString();
  $('sFps').textContent = view.fps || '–';

  $('undo').disabled = !hist.canUndo;
  $('redo').disabled = !hist.canRedo;
  $('del').hidden = sel.count === 0;
  $('dup').hidden = sel.count === 0;

  /**
   * 🔴 **布林與陣列 2026-08-31（第 4 段）改成「沒輪到就不出現」。**
   * ⚠ **條件一個字都沒改** —— 它們本來就是上下文命令，
   * 只是還停在「變灰」那個表達方式。
   */
  // 布林要兩個以上的物件；陣列一個就夠。兩者都要函式庫已載好
  const canDoBool = sel.count >= 2 && csgReady();
  for (const id of ['bUnion', 'bSub', 'bInt']) $(id).hidden = !canDoBool;

  // 陣列一個物件就夠。板件的陣列不需要布林函式庫，所以不綁 csgReady
  for (const id of ['aLinear', 'aRadial', 'aMirror']) $(id).hidden = sel.count < 1;

  /**
   * 🔴🔴 **方向／數值／吸附：沒選到東西就不出現**（2026-08-31，第 4 段）。
   *
   * ⚠ **⛔ 判準⛔ 不是「哪一顆變換工具亮著」** —— `移動／旋轉／縮放`
   * **永遠有一顆亮著**（預設是 `移動`），拿它當閘門等於沒做。
   * ⭐ **正確的判準是程式自己寫的**：**gizmo 只在選到東西時才掛上去**
   * （`select.js` 的 `_refresh()`：沒選到就 `tc.detach()`）——
   * 而這三組全部是「**拖 gizmo 時**」才有意義的參數：
   * 往哪個方向拉、繞哪裡轉、拖的時候吸幾公分、剛才拖了多少。
   *
   * 🔴 **⛔ 這一段是我先講錯、驗過才更正的** ——
   * 原本提議「跟著變換工具走」，而那三顆永遠有一顆亮著。
   */
  /**
   * ⚠ **條件要跟 `select.js` 掛 gizmo 的條件【一模一樣】**：
   * 編輯模式看的是**選到幾個元素**（gizmo 掛在元素的替身上），
   * 物件模式看的是**選到幾個物件**。⛔ 只寫 `sel.count === 0` 會讓
   * 「進了編輯模式但還沒點任何點」的時候，那三組還留在畫面上。
   */
  /**
   * ⚠ **這一條規則的家是 `gizmoOff()`**（就在「吸附」那一節上面）——
   * 2026-08-31 抽出去了，因為 `syncSnapRow()` 也要問同一件事，
   * 而**同一條規則只寫一次**。⛔ 不要在這裡就地重寫一份。
   */
  const off = gizmoOff();
  /**
   * ⚠ **`.pvBtn` 是我第一版漏掉的** —— 我照工具列的組別清單以為「方向」
   * 那四顆都是 `.spBtn`，實際是 **`.spBtn`（世界／法向）＋ `.pvBtn`（重心／
   * 最後選的）** 兩個 class。⇒ ⛔ 那一組因此永遠收不起來。
   * 🔴 **⛔ 這是「推論不是權威事實」** —— 後來是**問 DOM**
   * （列出 `#bar` 裡所有的 class）才確定的，⛔ 不是看清單猜的。
   */
  /**
   * 🔴 **`.spBtn` / `.pvBtn` / `editNum*` ＋ 外層的 `gEditXf`
   * 2026-09-01 一起交給 `syncEditXfRow()`。**
   * ⚠ 理由跟底下 `.snapBtn` 那則一模一樣：那一排的閘門現在**三組各不相同**
   * （方向兩種模式都有、中心與數值只有編輯模式）。
   * ⭐ **⛔ 關鍵是把外層容器也一起收進去** —— 以前這裡只管裡面的按鈕，
   * 殼歸 `toggleEditMode()` 管，而那正是「按了貼合整排還在」的病因。
   */
  syncEditXfRow();
  /**
   * 🔴 **`.snapBtn` 2026-08-31 從上面那個迴圈移出來，交給 `syncSnapRow()`。**
   * ⚠ 理由：吸附那一欄現在還要**再篩一次模式**，⛔ 不是單純的
   * 「有沒有選到東西」。留在上面的話，切到旋轉模式會把移動那四顆
   * 一起顯示出來 —— **兩個地方寫同一顆按鈕的顯示條件，必然會打架**。
   */
  syncSnapRow();
  /**
   * 🔴 **參考線那一排也在這裡刷新。**
   * ⚠ **⛔ 判準不是 `gizmoOff`** —— 參考線⛔ 不需要選任何物件，
   * 它的閘門是「在不在參考線模式」。⭐ 掛在這裡的理由是**Undo**：
   * 復原走 `hist.set → loadJSON → view.sync`，⛔ 不經過任何按鈕，
   * 而 `commit()` 最後一行會叫 `updateBar()` —— 這條路一起涵蓋。
   */
  syncGuideRow();

  /**
   * 擠出：**選到一個面才給按**。
   *
   * 灰掉比按了跳錯誤訊息好 —— 使用者一眼就知道「還缺一步」，
   * 而不是按下去被罵。`title` 也跟著換，滑過去就講得出缺什麼。
   */
  const face = sel.editMode && sel.editSel && sel.editSel.kind === 'face';
  $('extrude').hidden = !face;
  $('extrude').title = face
    ? `從選到的面長出新的一段（先長 ${sel.snapStep > 0 ? sel.snapStep : 1} cm，再用箭頭拉）`
    : (sel.editMode ? '先選一個面（把過濾器切到「面」比較好點）'
                    : '先按「拉點線面」進入編輯模式，再選一個面');

  /**
   * 🔴 **擠出邊：選到【邊】的時候才出現**（2026-09-01）。
   * ⚠ 它跟上面那顆是**互斥**的（一個吃面、一個吃邊），所以⛔ 不會同時冒出來。
   * ⭐ `title` 要把**現在的寬度**講出來 —— 那個數字來自「吸附」，
   * 而使用者⛔ 不會自己把兩件事連起來。
   */
  /**
   * 🔴 **「含外緣」只在「編輯模式 ＋ 過濾器吃得到邊」時才出現。**
   * ⚠ 其他時候它沒有意義，而一顆沒有意義的開關比沒有更糟（坑第 21 條）。
   */
  const edgeFilter = sel.editMode && (sel.editFilter === 'edge' || sel.editFilter === 'auto');
  $('efBoundary').hidden = !edgeFilter;
  $('efBoundary').classList.toggle('on', !!sel.includeBoundary);

  const anyEdge = sel.editMode && sel.editSel && sel.editSel.kind === 'edge';
  const ew = sel.snapStep > 0 ? sel.snapStep : 1;
  $('extrudeEdge').hidden = !anyEdge;
  $('extrudeEdge').title = anyEdge
    ? `從選到的【外緣】各長出一片面，寬 ${ew} cm（＝吸附現在的值）。長完可以再用「拉點線面」調`
    : (sel.editMode ? '先選至少一條板子外緣的邊（把過濾器切到「邊」）'
                    : '先按「拉點線面」進入編輯模式，再選外緣的邊');

  /**
   * 編輯模式下選到「點」時，旋轉與縮放要灰掉。
   *
   * ⚠ 這**不是**原本那條「一律鎖成移動」的復辟。差別很重要：
   * 原本那一行對**所有** kind 都鎖，把梯形、收尖、斜面推拉整組擋在門外
   * —— 而它的理由（「把一個頂點旋轉 30 度沒有意義」）**只對點成立**。
   * 現在只擋點，邊與面全開。
   *
   * 用灰掉而不是按了跳訊息：一眼就看得出「這個 kind 沒有這種變換」。
   */
  /**
   * 壓平：**選到面就給按**（一個或多個都行）。
   * 它動的是選取那幾片的頂點，跟擠出「一次只能一個」不同 ——
   * 壓平多個面本來就是它的主要用途（把好幾片 seg 壓成一個平面）。
   */
  /**
   * 內縮：**選到一個面才給按**（一次一個，跟擠出同一條界線）。
   */
  $('inset').hidden = !face;
  $('insetW').hidden = !face;
  $('inset').title = face
    ? (sel.editCount > 1
        ? `內縮一次只能一個面（現在選了 ${sel.editCount} 個）`
        : '沿著這個面的外緣往面內長一圈邊。只加線、形狀不變，內圈那個面會自動選中')
    : (sel.editMode ? '先選一個面（把過濾器切到「面」比較好點）'
                    : '先按「拉點線面」進入編輯模式，再選一個面');

  /**
   * 刪除面：**選到面就給按**（一個或多個都行）。
   * 補洞：**不需要進編輯模式**，選到非參數物件就能按 —— 它處理整個物件。
   */
  $('delFace').hidden = !face;
  $('delFace').title = face
    ? (sel.editCount > 1
        ? `把選到的 ${sel.editCount} 個面拿掉。⚠ 網格會變開放，之後不能做布林（可以用「補洞」補回來）`
        : '把這個面拿掉，那裡會變成一個洞。⚠ 網格會變開放（可以用「補洞」補回來）')
    : (sel.editMode ? '先選一個面（可以開「加選」選好幾個）'
                    : '先按「拉點線面」進入編輯模式，再選面');

  const canFill = sel.active && !sel.active.isParametric;
  $('fillHoles').hidden = !canFill;
  $('fillHoles').title = !sel.active
    ? '先選一個物件'
    : (sel.active.isParametric
        ? '參數物件補了也留不住（開檔會照參數重新生成）。要補請先按「轉成可編輯網格」'
        : '把這個物件上所有的洞補起來。⚠ 板件（一張沒有厚度的面）按了會被封起來，那時體積會是 0');

  /**
   * 橋接：跟 `補洞` 同一條規則（不必進編輯模式、非參數物件就給按）。
   * 🔴 **⛔ 不在這裡先數洞** —— 亮不亮只看「按不按得動」，
   * 「有幾個洞」是按下去之後才講的話。⚠ 每次 `updateBar()` 都去掃一遍
   * 邊界邊，那是**寫進每幀迴圈、而且會隨模型大小成長**的東西（坑第 22 條）。
   */
  $('bridge').hidden = !canFill;
  $('bridgeTurn').hidden = !canFill;
  $('bridge').title = !sel.active
    ? '先選一個物件'
    : (sel.active.isParametric
        ? '參數物件接了也留不住（開檔會照參數重新生成）。要接請先按「轉成可編輯網格」'
        : '把這個物件上剛好兩個洞接成一段管。⚠ 兩根管子請先按「∪ 聯集」合成一個物件，再各刪掉一個蓋子');

  $('flatten').hidden = !face;
  $('flatten').title = face
    ? (sel.editCount > 1
        ? `把選到的 ${sel.editCount} 個面壓到同一個平面上，然後自動併成一個面。⚠ 形狀會變`
        : '把這個面壓平。⚠ 本來就是平的話不會有動作')
    : (sel.editMode ? '先選一個面（可以開「加選」選好幾個）'
                    : '先按「拉點線面」進入編輯模式，再選面');

  updateToCircleBtn();

  /**
   * 環切：**選到一條邊才給按**。
   *
   * ⚠ 一次只能一條 —— 起點不同，繞出來的圈就不同，
   * 選了三條要繞哪一圈**結果不唯一，而不唯一就不猜**（鐵律三，坑第 24 條）。
   */
  const edge1 = sel.editMode && sel.editSel && sel.editSel.kind === 'edge'
             && sel.editCount === 1;
  $('loopCut').hidden = !edge1;
  $('loopCutN').hidden = !edge1;
  /**
   * 沿面滑動：**選到邊就給按**（⚠ 跟環切「一次只能一條」相反）——
   * 它吃的是**一整圈**，一條邊根本滑不動。
   * 🔴 **⛔ 不在這裡先檢查「是不是一整圈」** —— 那要走訪每個點的鄰邊，
   * 是 O(選取×價數)，而 `updateBar()` 每次選取變動都會跑（坑第 22 條）。
   * ⭐ 按下去才檢查，擋下來的訊息本來就講得出原因。
   */
  /**
   * ⚠ **⛔ 這個變數 ⛔ 不可以叫 `edgeAny`** —— 底下導角那一段已經用了那個名字，
   * 而它們在**同一個函式作用域**裡。
   * 🔴 【實證 2026-08-28】重複宣告 `const` 是 **SyntaxError**，
   * 而 ES 模組遇到它會**整組拒絕執行** —— 畫面上的症狀是
   * 「工具列在、CSS 也對，但一行 JS 都沒跑」，**⛔ 完全看不出是哪裡的錯**。
   */
  const slideOk = sel.editMode && sel.editSel && sel.editSel.kind === 'edge';
  $('slide').hidden = !slideOk;
  $('slideAmt').hidden = !slideOk;
  $('slideUnit').hidden = !slideOk;
  /**
   * 平行複製：**條件跟沿面滑動完全一樣**（吃同一種選取）——
   * ⭐ 所以借同一個 `slideOk`，⛔ 不重寫一份判斷式（坑第 31 條）。
   */
  $('offsetLoop').hidden = !slideOk;
  $('offsetW').hidden = !slideOk;
  $('offsetLoop').title = slideOk
    ? `在選到的 ${sel.editCount} 條邊兩側各加一圈平行的線。`
      + '只加線、形狀完全不變（體積面積精確不變）。做加強筋、邊框、溝槽'
    : (sel.editMode ? '先選邊（整圈用「選一圈」，或先按「環切」）'
                    : '先按「拉點線面」進入編輯模式，再選邊');
  /**
   * ⚠ **⛔ 這裡 ⛔ 不可以說「只選 1 條邊不行」** —— 【實證 2026-08-28】
   * **選一條邊照樣滑得動**（端點是 3 價時），做出楔形／斜面，
   * kang 實測後說「效果我覺得不錯」。判準是**端點的價數**，⛔ 不是選了幾條。
   * 🔴 舊文案會讓使用者**放棄一個做得到的操作**。
   */
  $('slide').title = slideOk
    ? `把選到的 ${sel.editCount} 條邊沿著表面挪位置，不會離開表面。`
      + '正值往上（或畫面上比較高的那一側），打負數往反方向。'
      + '整圈一起選就是挪切線；只選一條邊會把那條邊推成斜面'
    : (sel.editMode ? '先選邊（整圈用「選一圈」，或先按「環切」——切完那一圈會自動選中）'
                    : '先按「拉點線面」進入編輯模式，再選邊');
  /**
   * 導角：**選到邊就給按**（一條或好幾條都行）。
   * 跟環切「一次只能一條」不同 —— 相鄰的邊一起導才有角落，
   * 那正是它主要的用途。
   */
  const edgeAny = sel.editMode && sel.editCount > 0
    && sel.editSels.every(e => e.kind === 'edge');
  $('bevel').hidden = !edgeAny;
  $('bevelW').hidden = !edgeAny;
  $('bevelSeg').hidden = !edgeAny;
  $('bevel').title = edgeAny
    ? (sel.editCount > 1
        ? `把選到的 ${sel.editCount} 條邊都換成斜切面，相鄰的地方角落會自動長出來`
        : '把這條邊換成一片斜切面。相鄰的邊一起選，角落會自動長出來')
    : (sel.editMode ? '先選邊（可以開「加選」選好幾條）'
                    : '先按「拉點線面」進入編輯模式，再選邊');

  $('selRing').hidden = !edge1;
  $('selRing').title = edge1
    ? '從這條邊【橫著跨過】四邊形繞一圈全部選起來（也可以先按它看環切會切在哪）'
    : (sel.editMode ? '先選一條邊' : '先按「拉點線面」進入編輯模式，再選一條邊');

  /**
   * 選一條線：條件跟「選一圈」一模一樣（正好選到一條邊）——
   * ⚠ 兩顆的差別在**走法**，不在**能不能按**。
   */
  $('selLoop').hidden = !edge1;
  $('selLoop').title = edge1
    ? '從這條邊【順著同一條線】走到底（球的一條經線＝從極走到極）'
    : (sel.editMode ? '先選一條邊' : '先按「拉點線面」進入編輯模式，再選一條邊');

  /**
   * 選一圈面：條件跟另外兩顆一樣（正好選到一條邊）。
   * ⚠ **⛔ 不要因為它「選出來的是面」就改成要先選面** ——
   * 從一個面出發有兩個方向，結果不唯一（坑第 24 條）。
   */
  $('selRingFaces').hidden = !edge1;
  $('selRingFaces').title = edge1
    ? '跟「選一圈」走同一條路，但選起來的是【面】（一整圈側面）。按下去會自動切到「面」'
    : (sel.editMode ? '先選一條邊' : '先按「拉點線面」進入編輯模式，再選一條邊');

  /**
   * 全選邊：**選到物件就給按，不必先選任何邊** ——
   * 它就是拿來取代「一條一條點」的。
   */
  const canAll = sel.editMode && !!sel.active;
  $('selAllEdges').hidden = !canAll;
  $('selAllEdges').title = canAll
    ? '把這個物件所有看得見的邊一次選起來（方塊 12 條）。要做整個物件的導角／圓角就先按它'
    : '先按「拉點線面」進入編輯模式，再選一個物件';

  /**
   * 選轉角：**跟「全選邊」同一個條件** —— 選到物件就給按，不必先選邊。
   * ⚠ 它掃的是整個物件，種子不是「現在選到哪一條」。
   */
  $('selSharp').hidden = !canAll;
  $('sharpDeg').hidden = !canAll;
  $('selSharp').title = canAll
    ? '把所有【折起來】的邊一次選起來（夾角大於旁邊那個度數）。標分片切割線的捷徑'
    : '先按「拉點線面」進入編輯模式，再選一個物件';

  /**
   * 選相似：**一定要先選到一個元素當範本** ——
   * 「相似」是跟誰相似，沒有範本就沒有答案（坑第 24 條）。
   * ⚠ 種子是 **active（最後選的那一個）**，跟「中心＝最後選的」同一套。
   */
  const canSimilar = sel.editMode && !!sel.editSel;
  $('selSimilar').hidden = !canSimilar;
  $('similarMode').hidden = !canSimilar;
  $('selSimilar').title = canSimilar
    ? `跟【最後選的那一個${sel.editSel.kind === 'edge' ? '邊' : sel.editSel.kind === 'face' ? '面' : '點'}】同一類的全部選起來`
    : (sel.editMode ? '先選一個面或一條邊當範本'
                    : '先按「拉點線面」進入編輯模式，再選一個面或一條邊');

  /**
   * 隔一個選一個：**至少要選到 3 個** ——
   * ⚠ 它 ⛔ 不是「選到一個就能按」那一類：它挑的是**現在這一批**，
   * 而 2 個以下沒有「隔一個」可言（`checkerPick()` 自己也擋，這裡只是先變灰）。
   * ⭐ **⛔ 不在這裡預先算「排不排得出一圈」** —— 那要走一遍相鄰表，
   * 而這一段每次選取變動都會跑。按下去再講原因就好。
   */
  const canChecker = sel.editMode && sel.editCount >= 3;
  $('selChecker').hidden = !canChecker;
  $('checkerNth').hidden = !canChecker;
  $('checkerFrom').hidden = !canChecker;
  $('selChecker').title = canChecker
    ? `把現在這 ${sel.editCount} 個隔幾個留一個（做格柵鏤空）。`
      + '⚠ 要連成一圈或一條才算得出來'
    : (sel.editMode ? '先選好一圈面或一圈邊（至少 3 個），例如按「選一圈面」'
                    : '先按「拉點線面」進入編輯模式，再選好一圈面或一圈邊');

  /**
   * 任意切線：**選到物件就給按，不必選任何元素** ——
   * 它切的是整個物件，位置由旁邊的軸與座標決定。
   */
  const canBisect = sel.editMode && !!sel.active;
  $('bisect').hidden = !canBisect;
  $('bisectAxis').hidden = !canBisect;
  $('bisectAt').hidden = !canBisect;
  /**
   * ⚠ **範圍提示那個 span 也要跟著收** —— ⛔ 不收的話，`切一刀` 那一組
   * 整組不見了，卻留下一句孤零零的「Y：0 ～ 45」在工具列上。
   * 🔴 它原本⛔ 沒有被任何地方管顯示（只管文字），是第 2 段才需要的。
   */
  $('bisectRange').hidden = !canBisect;
  $('bisect').title = canBisect
    ? '在旁邊指定的位置用一個平面把整個物件切開，加上一圈新的線。'
      + '只加線不改形狀，切完那一圈會自動選中'
    : '先按「拉點線面」進入編輯模式，再選一個物件';
  updateBisectRange();

  /**
   * 連接兩點：**正好選到兩個點才給按。**
   *
   * ⚠ 這一顆的條件跟同組其他按鈕都不一樣，所以 title 要把
   * 「現在差什麼」講清楚 —— 灰掉的按鈕不說話，使用者只會覺得壞了
   * （坑第 11、21 條）。
   */
  /**
   * 🔴 **刀具：要先選好一個網格物件才進得去。**
   *
   * ⚠ **理由是進了刀具模式就選不了物件了** —— 那時候點畫面是定切線。
   * 所以「先按刀具再選物件」這條路根本不存在，⛔ 不可以讓他按進去
   * 才發現（坑第 11 條）。
   *
   * 🔴 **但模式開著的時候一定要可以按** —— 那是唯一的取消方式
   * （kang 選的：再按一次取消，平板沒有 Esc）。**鎖起來就出不去了。**
   */
  const canKnife = !!sel.active && !sel.active.isParametric;
  $('knife').disabled = !canKnife && !sel.knifeMode;
  /**
   * 🔴🔴 **「現在按下去會發生什麼」現在講在【控制列】，⛔ 不在工具鈕上。**
   * （2026-08-31 改；**kang 拍板：主工具在直條，其餘選了工具之後在控制列顯示**）
   *
   * ⚠ **⛔ 規則本身沒有變** —— 「按鈕文字要講出現在按下去會發生什麼」
   * 仍然成立（坑第 21 條），只是**負責講的那顆換人**：
   * 工具鈕講**身分**（永遠是「刀具」「鋼筆」），`#toolDone` 講**動作**。
   *
   * 🔴 **⛔ 不可以再對工具鈕寫 `textContent`** ——
   * 那幾顆裡面是 `<svg>` ＋ `<span class="lab">`，寫下去會**把圖示整個洗掉**，
   * ⚠ 而且**不會報錯**（`index.html` 的 `#rail` 註解寫著同一件事）。
   */
  const 收工 = sel.knifeMode
    ? (knifePicks.length >= 2 ? `切下去（${knifePicks.length} 點）` : null)
    : penEditing ? '完成'
    : sel.penMode ? '完成' : null;
  $('toolDone').hidden = !收工;
  if (收工) $('toolDone').textContent = 收工;
  /**
   * 狀態字：**⛔ 只講「做到哪」，⛔ 不講「該按誰」** —— 該按誰是上面那顆的事。
   * ⚠ 刀具點不到兩個時 `#toolDone` 不出現，所以那句話要由這裡講。
   */
  const 狀態 = sel.knifeMode
    ? (knifePicks.length >= 2 ? '' : `刀具：在模型上點兩個以上的位置（現在 ${knifePicks.length} 個）`)
    : sel.penMode
      ? (penEditing ? '正在改這條路徑'
         : sel.penCount ? `${sel.penCount} 個點`
           + (sel.penPathCount > 1 ? `．共 ${sel.penPathCount} 條` : '')
         : '在地板上點一下放第一個點')
      : '';
  $('toolState').hidden = !狀態;
  if (狀態) $('toolState').textContent = 狀態;
  /**
   * 🔴 **鋼筆那一組只在鋼筆模式裡出現** —— 跟刀具同一套做法。
   * ⚠ **`退一點` 要在還沒放點時變灰**，⛔ 不可以按下去什麼都不發生。
   */
  $('penCorner').hidden = !sel.penMode;
  $('penCorner').classList.toggle('on', !!sel.penCorner);
  /**
   * 🔴 **`改點` 那一顆**（第 2 階段）。
   * ⚠ **還沒有 3 個點就不給按** —— 那時候沒有東西可以改，
   * ⛔ 按下去什麼都不發生的按鈕就是坑第 21 條。
   */
  $('penEdit').hidden = !sel.penMode;
  $('penEdit').disabled = sel.penCount < sel.penMinPts;
  $('penEdit').classList.toggle('on', !!sel.penEdit);
  /**
   * 🔴 **`刪點` 只在 `改點` 開著時出現**（第 3 階段）。
   * ⚠ **兩個條件都要擋**：沒選到點、或只剩 3 個點 ——
   * ⛔ 按下去什麼都不發生的按鈕就是坑第 21 條。
   * ⭐ **加點⛔ 沒有按鈕**（點線上就是加），只有刪點需要一顆。
   */
  $('penDel').hidden = !(sel.penMode && sel.penEdit);
  $('penDel').disabled = sel.penSel < 0 || sel.penCount <= sel.penMinPts;
  /**
   * 🔴 **`加一條` 在鋼筆模式下一直看得到**（畫的時候、改的時候都要按得到）——
   * ⭐ 那正是 kang 要的「兩邊都做」，而它們是同一支。
   * ⚠ 目前這條不到 3 個點就變灰（收進去只會變成垃圾）。
   */
  $('penAddPath').hidden = !sel.penMode;
  $('penAddPath').disabled = sel.penCount < sel.penMinPts;
  /**
   * 🔴 **`改點` 開著的時候，這幾顆是「畫」用的，⛔ 一個都不該出現。**
   * ⚠ 留著的話使用者會按 `確定曲線`／`退一點`，而那是在改另一件事 ——
   * **兩個模式的按鈕混在同一排，定位就糊了**（kang 為切一刀拍板的那條）。
   */
  const penDrawing = sel.penMode && !sel.penEdit;
  /**
   * 🔴🔴 **兩顆開關**（第 ③ 件，2026-08-31）。
   *
   * ⚠ **`往上長` 只在 `不封口` 開著時才出現** —— 封起來的形狀沒有
   * 「往不往上長」這回事，擺在那裡就是一顆按了什麼都不會變的鈕（坑第 21 條）。
   */
  $('penOpen').hidden = !sel.penMode;
  $('penOpen').classList.toggle('on', !!sel.penNoClose);
  $('penUp').hidden = !(sel.penMode && sel.penNoClose);
  $('penUp').classList.toggle('on', !!penUpFlag);
  /**
   * ⚠ **兩個數字欄位一定要帶標籤** —— kang 2026-08-29 問
   * 「『尖角』旁的 3 是代表甚麼?」：`3` 是**厚度**、`45` 是**鎖角度的度數**，
   * 但它們都緊貼著按鈕，**看起來像是那顆按鈕的參數**。
   * 🔴 **他會問，就表示版面在誤導** —— 那是回饋，⛔ 不是他沒看清楚。
   *
   * 🔴 **而 2026-08-31 起那個標籤還會跟著開關換**（厚度／高度／寬度）——
   * 同一個欄位三種意思，⛔ 不換的話使用者會拿「厚度」去打牆高。
   */
  $('penHLbl').hidden = !sel.penMode;
  $('penHLbl').textContent = !sel.penNoClose ? '厚度' : (penUpFlag ? '高度' : '寬度');
  $('penH').hidden = !sel.penMode;
  $('penSnap').hidden = !sel.penMode;
  $('penSnap').classList.toggle('on', !!sel.penSnapAngle);
  $('penSnapDegLbl').hidden = !sel.penMode;
  $('penSnapDeg').hidden = !sel.penMode;
  $('penPark').hidden = !penDrawing;
  $('penPark').disabled = sel.penCount === 0;
  $('penUndo').hidden = !penDrawing;
  $('penUndo').disabled = sel.penCount === 0;
  $('penCancel').hidden = !sel.penMode;
  /**
   * 🔴 **`鋼筆` 那一顆的文字只在這裡決定，⛔ 別處不要再設一次。**
   *
   * ⚠ **改既有物件的路徑時它的意思是「完成」** —— ⛔ 一直寫「鋼筆 N」
   * 的話，使用者不知道按誰才收得了工（坑第 21 條，跟 `刀具` 同一條）。
   * ⚠ **按了 `加一條` 之後目前這條是 0 個點** —— 就要變回「鋼筆」，
   * ⛔ 不可以停在上一條的數字（2026-08-30 實測照出來的）。
   * ⭐ **兩條以上時後面掛一個「·N條」** —— 否則使用者看不出來
   * 自己已經在畫第幾條了。
   */
  /**
   * 🔴🔴 **⛔ 這裡原本寫 `$('pen').textContent = …`，2026-08-31 拿掉了。**
   *
   * `鋼筆` 已經是**左側直條上的工具**，它的名字**永遠是「鋼筆」** ——
   * 「畫到幾個點」與「按哪裡收工」搬到控制列（`#toolState`／`#toolDone`，
   * 就在這一支上面那一段）。
   *
   * ⚠ **⛔ 千萬不要把這一行加回來** —— 工具鈕裡面是 `<svg>` ＋ `<span class="lab">`，
   * 寫 `textContent` 會**把圖示整個洗掉，而且不會報錯**。
   * ⭐ 舊註解那句「按鈕文字要講出現在按下去會發生什麼」**仍然成立**，
   * 只是負責講的那顆換成 `#toolDone` 了。
   */
  $('pen').title = sel.penMode
    ? (sel.penEdit
        ? `改點模式：${sel.penCount} 個點。點一個點就選它，拖它＝搬位置、`
          + '拖把手＝調曲線。再按一次「改點」回到畫的模式'
        : `畫到 ${sel.penCount} 個點了。【點一下】＝ 尖角、【按住拖】＝ 圓滑，`
          + '最後一點【快點兩下】完成（或再按一次這顆）')
    : '鋼筆：在地板上畫一個形狀，畫完自動變成可以拉厚度的物件';

  $('knifeCancel').hidden = !sel.knifeMode;
  /**
   * 🔴 **`退一步` 只在刀具模式、而且真的刪過東西時才出現。**
   * ⚠ ⛔ 不用 `disabled`：一顆永遠灰著的按鈕使用者⛔ 不知道它什麼時候會亮
   * —— 照這一排其他顆的規矩用 `hidden`（2026-08-31 那 45 個就是這樣統一的）。
   */
  $('knifeUndoDel').hidden = !sel.knifeMode || !knifeDeleted.length;
  /**
   * 🔴 **吸中點只在刀具模式裡出現，而且開著的時候要看得出來。**
   * ⚠ 一顆按下去畫面上什麼都不變的開關就是坑第 21 條 ——
   * 這裡用跟其他模式一樣的 `.on` 樣式，⛔ 不另發明一種。
   */
  $('knifeSnapMid').hidden = !sel.knifeMode;
  $('knifeSnapMid').classList.toggle('on', !!sel.knifeSnapMid);
  $('knife').title = sel.knifeMode
    ? (knifePicks.length >= 2
        ? '照剛才點的位置切下去'
        : '在模型上點你要切過的位置，至少兩個')
    : canKnife
      ? '在模型上點你要切過的位置（會吸到最近的邊），點完再按一次就切下去。'
        + '同一個面點兩個位置就切開那個面；繞著模型一路點就能環繞切開'
      : !sel.active
        ? '先點一個物件，再按「刀具」'
        : '這個物件還是參數物件 —— 先在右側面板按「轉成可編輯網格」';

  /**
   * 分離：**選到邊就給按**。真正分不分得開由 `separateAlongEdges()` 判斷
   * 並講原因 —— ⛔ 介面不要自己再判一次那圈邊有沒有繞成一圈（坑第 31 條）。
   */
  const edgeAnySel = sel.editMode && sel.editCount > 0
    && sel.editSels.every(e => e.kind === 'edge');
  $('separate').hidden = !edgeAnySel;
  $('separate').title = edgeAnySel
    ? `沿著這 ${sel.editCount} 條邊把物件拆成兩個獨立的物件。`
      + '⚠ 斷面是空的，要補請按「補洞」'
    : !sel.editMode
      ? '先按「拉點線面」進入編輯模式'
      : sel.editCount === 0
        ? '先用「切一刀」或「環切」切一圈（切完會自動選中），再按這裡'
        : '「分離」要沿著一圈邊切開 —— 把過濾器切到「邊」';

  /**
   * 邊上加點：**選到邊就給按**（一條或好幾條都行）。
   * ⚠ 它跟「面上加線」都吃邊，差別是**這顆只加點、那顆會連起來**，
   * 所以兩顆的 title 要講得出差別，不然使用者不知道該按哪一顆。
   */
  const edgeSome = sel.editMode && sel.editCount > 0
    && sel.editSels.every(e => e.kind === 'edge');
  $('subdivEdge').hidden = !edgeSome;
  $('subdivN').hidden = !edgeSome;
  $('subdivEdge').title = edgeSome
    ? `在選到的 ${sel.editCount} 條邊上各放點，什麼都不連 —— `
      + '接著用「多點連接」把它們連成你要的形狀'
    : !sel.editMode
      ? '先按「拉點線面」進入編輯模式'
      : sel.editCount === 0
        ? '把上面的過濾器切到「邊」，然後選邊'
        : '這一顆只吃邊 —— 把上面的過濾器切到「邊」';

  const manyVerts = sel.editMode && sel.editCount >= 2
    && sel.editSels.every(e => e.kind === 'vertex');
  $('connectVerts').hidden = !manyVerts;
  $('connectVerts').title = manyVerts
    ? (sel.editCount > 2
        ? `照你選的順序把這 ${sel.editCount} 個點連成 ${sel.editCount - 1} 段，`
          + '面會被切開。形狀不會變'
        : '在這兩個點之間連一條線，把那個面切成兩塊。形狀不會變，新的線會自動選中')
    : !sel.editMode
      ? '先按「拉點線面」進入編輯模式'
      : sel.editCount === 0
        ? '把上面的過濾器切到「點」，然後選兩個以上的點（開「加選」或按 Shift 加選）'
        : sel.editSels.some(e => e.kind !== 'vertex')
          ? '這一顆只吃點 —— 把上面的過濾器切到「點」，再選角'
          : '至少要選兩個點';

  /**
   * 點連成面：**至少三個點**才圍得出面。
   * ⚠ 它跟「多點連接」吃同一種東西（點），差別只在**做出線還是面** ——
   * 所以灰掉的理由要把那件事講出來，⛔ 不然使用者會以為按錯顆。
   */
  const threeVerts = sel.editMode && sel.editCount >= 3
    && sel.editSels.every(e => e.kind === 'vertex');
  $('faceFromVerts').hidden = !threeVerts;
  $('faceFromVerts').title = threeVerts
    ? `照你選的順序，把這 ${sel.editCount} 個點圍成一個面`
      + (sel.editCount > 3 ? '。⚠ 它們不在同一個平面上的話會講出偏離多少' : '')
    : !sel.editMode
      ? '先按「拉點線面」進入編輯模式'
      : sel.editSels.some(e => e.kind !== 'vertex')
        ? '這一顆只吃點 —— 把上面的過濾器切到「點」，再選角'
        : `至少要選 3 個點才圍得出一個面（現在 ${sel.editCount} 個）。`
          + '只想連成線的話用「多點連接」';

  /**
   * 面上加線：**正好選到兩條邊才給按。**
   * ⚠ 跟「連接兩點」的差別在**吃什麼**（那顆吃點、這顆吃邊），
   * 所以 title 要把「現在差什麼」講清楚 —— 兩顆長得很像，
   * 灰掉的原因不講，使用者會以為按錯顆（坑第 11、21 條）。
   */
  const twoEdges = sel.editMode && sel.editCount === 2
    && sel.editSels.every(e => e.kind === 'edge');
  $('splitFace').hidden = !twoEdges;
  $('splitFaceT').hidden = !twoEdges;
  $('splitFace').title = twoEdges
    ? '在這兩條邊上各長一個點再連起來，把面切成兩塊。0.5 ＝ 正中間（兩等分）'
    : !sel.editMode
      ? '先按「拉點線面」進入編輯模式'
      : sel.editCount === 0
        ? '把上面的過濾器切到「邊」，然後選兩條邊（開「加選」或按 Shift 選第二條）'
        : sel.editSels.some(e => e.kind !== 'edge')
          ? '這一顆只吃邊 —— 把上面的過濾器切到「邊」，再選兩條邊'
          : `要正好兩條邊，現在選了 ${sel.editCount} 個`;

  /**
   * 法向那一組：**不需要進編輯模式**，選到物件就能按 ——
   * 它修的是整個物件，不是某一個元素。
   * ⚠ 參數物件灰掉：它的繞向是程式自己生的，而且改了也留不住。
   */
  const fixable = sel.active && !sel.active.isParametric;
  $('fixNormals').hidden = !fixable;
  $('flipNormals').hidden = !fixable;
  if (!sel.active) {
    $('fixNormals').title = $('flipNormals').title = '先選一個物件';
  } else if (sel.active.isParametric) {
    $('fixNormals').title = $('flipNormals').title =
      '參數物件的繞向本來就正確，而且改了也留不住（開檔會照參數重新生成）。'
      + '要修請先按「轉成可編輯網格」';
  } else {
    $('fixNormals').title = '把面的朝向重算成「一致而且朝外」。'
      + '⚠ 繞向錯了畫面上看不出來，但 STL 送去列印會被判成非流形';
    $('flipNormals').title = '把整個物件的面朝向全部翻過來。'
      + '板件那種沒有厚度的殼「外側」沒有定義，「修法向」不會猜，用這顆自己決定';
  }
  $('loopCut').title = edge1
    ? '沿著這條邊繞一整圈加上新的線。只加線不改形狀，切完那一圈會自動選中'
    : (sel.editMode
        ? (sel.editCount > 1 ? '環切一次只能從一條邊出發（現在選了好幾個）'
                             : '先選一條邊（把過濾器切到「邊」比較好點）')
        : '先按「拉點線面」進入編輯模式，再選一條邊');

  const vtx = sel.editMode && sel.editSel && sel.editSel.kind === 'vertex';
  for (const id of ['mRot', 'mScale']) {
    $(id).disabled = vtx;
    if (vtx) $(id).title = '一個「點」轉或縮放都不會改變任何座標。要做梯形／收尖請選「邊」或「面」';
    else $(id).removeAttribute('title');
  }

  /**
   * 展開：**有物件就開放**。沒選東西就展開全部，所以不看選取數量。
   *
   * 2026-08-22 之前的條件是「文件裡有板件」，實體一律不給展開。
   * 那是鈑金思路的殘留 —— 對切開再接合的板材（珍珠板、木板、壓克力）而言，
   * 實體的網格就是外表面，直接展開就是正確答案。
   * 擋著的時候使用者只能手動把種類改成板件繞過去，而得到的數字一模一樣。
   */
  const any = doc.objects.length > 0;
  /** ⚠ 這三顆⛔ 不跟著第 2 段換頁 —— 條件是「檔案裡有沒有物件」，
   *  ⛔ 不是「選到什麼」；而且底下那則註解 2026-08-22 就講過
   *  「擋在按鈕上使用者只看得到一顆灰掉的按鈕，不知道為什麼」*/
  $('unfold').disabled = !any;
  $('unfold').title = any
    ? '攤平成下料圖：含尺寸標註、折線，可列印或輸出 DXF 送雷切／CNC'
    : '目前沒有任何物件';

  // 3D 匯出：只要有物件就能匯出（實體、板件都可以）
  $('export3d').disabled = doc.objects.length === 0;

  /**
   * 剖面分切：跟展開同一條規矩 —— 有物件就開放，沒選就切全部。
   * 開放曲面切下去接不成封閉輪廓，但那是視窗裡講的事，不在這裡擋：
   * 擋在按鈕上的話使用者只看得到一顆灰掉的按鈕，不知道為什麼。
   */
  $('slice').disabled = !any;
  $('slice').title = any
    ? '切成一疊板，每片一張輪廓送 CNC，切完照號碼疊起來黏合'
    : '目前沒有任何物件';

  // 開著的時候跟著文件一起更新，改個板厚就能看到展開長跟著變
  if (unfoldWin.isOpen) unfoldWin.run();
  if (exportWin.isOpen) exportWin.run();
  if (sliceWin.isOpen) sliceWin.run();

  const act = sel.active;
  $('sInfo').textContent = act
    ? `${act.name}${act.copies > 1 ? ` ×${act.copies}` : ''}`
      + `　X ${f1(act.pos.x)}　Y ${f1(act.pos.y)}　Z ${f1(act.pos.z)} cm`
    : (hist.undoLabel ? '上一步：' + hist.undoLabel : '點一下物件選取它');

  /**
   * 🔴🔴 **過濾器（自動／點／邊／面）跟著 `拉點線面` 走**（2026-08-31，第 3 段）。
   *
   * ⚠ **它們是【那個工具的】過濾器** —— ⛔ 沒進編輯模式時，
   * 「只選邊」這句話沒有對象，按了什麼都不會發生（坑第 21 條）。
   * ⭐ 這正是 kang 拍板那條的直接應用：
   * **主工具在直條，其餘選了工具之後才在控制列顯示。**
   *
   * 🔴 **⛔ 不可以只藏那四顆** —— 前面那個「編輯」的組標籤也要收，
   * 而那是 `hideEmptyGroups()` 的事（它問「裡面還有沒有東西看得見」）。
   */
  for (const b of document.querySelectorAll('.efBtn')) b.hidden = !sel.editMode;

  hideEmptyGroups();
  updateHandles();
}

/**
 * 🔴🔴 **折疊條要【講話】** —— ⛔ 這不是裝飾。
 *
 * 第 2、4 段之後那條工具列是「**會隨選取長出東西**」的：
 * 收著的時候你選了一個面，`擠出` 確實出現了，**⛔ 但你看不到** ——
 * ⚠ **症狀跟壞掉一模一樣**（坑第 21 條）。
 * ⇒ 收起來時寫「**▸ 工具列　N 組可用**」，**N 隨選取變**，
 * 你就知道「現在裡面有東西」。
 *
 * ⚠ **N 要在 `hideEmptyGroups()` 之後算** —— 那一支才剛決定完誰看得見。
 */
function updateHandles() {
  /**
   * ⚠ **狀態用【兩個圖示互換】表示**（實心＝展開中、空心＝收起來）——
   * ⛔ 不用 `.on` 藍底：那在直條上的意思是「這個工具開著」，會混淆。
   * 🔴 **⛔ 也不要用 `textContent`／`innerHTML` 去換圖示** ——
   * 那會把 svg 洗掉，而且不會報錯〔今天已經踩過一次〕。
   */
  const face = (id, off) => {
    const b = $(id);
    b.querySelector('.ico-on').hidden = off;
    b.querySelector('.ico-off').hidden = !off;
  };

  const barOff = $('bar').hidden;
  const n = [...document.querySelectorAll('#bar .grp')].filter(g => !g.hidden).length;
  face('barToggle', barOff);
  /**
   * 🔴🔴 **收著時角上要有一個數字 —— ⛔ 這不是裝飾。**
   *
   * 第 2、4 段之後那條工具列是「**會隨選取長出東西**」的：
   * 收著的時候你選了一個面，`擠出` 確實出現了，**⛔ 但你看不到** ——
   * ⚠ **症狀跟壞掉一模一樣**（坑第 21 條）。
   * ⭐ 而直條的字只放得下 50px，「工具列 12」剛好爆掉 ⇒ 改用角標。
   * 〔kang 2026-08-31 在三個做法裡選的〕
   */
  const badge = $('barToggle').querySelector('.badge');
  badge.hidden = !(barOff && n > 0);
  if (!badge.hidden) badge.textContent = String(n);
  $('barToggle').title = barOff
    ? `工具列收起來了 —— 目前有 ${n} 組可以用（角上那個數字）。按一下展開`
    : '按一下把工具列收起來（畫面會變高）';

  const panelOff = $('panel').hidden;
  face('panelToggle', panelOff);
  $('panelToggle').title = panelOff
    ? '展開右邊的物件面板'
    : '收合右邊的物件面板（畫面會變寬 300px）';
}

/**
 * 🔴🔴 **整組都不見了，那個組標籤也要收起來**（2026-08-31，介面編排第 2 段）。
 *
 * ⚠ **⛔ 不收的話，工具列上會留下一堆孤兒標籤** ——
 * 「編輯」「選取」「加線」幾個字掛在那裡，右邊什麼都沒有。
 *
 * ⭐ **⛔ 這裡刻意⛔ 不列名單，而是問「裡面還有沒有東西看得見」** ——
 * 名單會過期（每加一顆按鈕就要記得回來改），而這個問法**永遠是對的**。
 * 〔跟「⛔ 會過期的數字一律現算，不存」同一條〕
 *
 * ⚠ **判準只看 button／input／select，⛔ 不看 span** ——
 * 那些 `.lbl` 本身就是標籤，拿它當「還有東西」會讓空組永遠收不起來。
 */
function hideEmptyGroups() {
  for (const g of document.querySelectorAll('#bar .grp')) {
    const live = [...g.querySelectorAll('button, input, select')]
      .some(el => !el.hidden);
    g.hidden = !live;
  }
}

const f1 = v => (Math.abs(v) < 1e-9 ? 0 : v).toFixed(1);

// ── 提示條 ────────────────────────────────────────────

let toastTimer = null;
function toast(msg, bad = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('bad', bad);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ═══════════════════════════════════════════════════════
//  啟動
// ═══════════════════════════════════════════════════════

async function boot() {
  // ── 先把布林函式庫載起來，再碰文件 ──────────────────
  // 它是 WebAssembly，一定是非同步的。但整個建模器的資料流是同步的，
  // 所以在這裡一次等完，之後 mesh() 就能維持同步、不必改寫每一處呼叫。
  // 而且暫存檔裡可能就有布林物件，沒載好就還原會變成一堆替身方塊。
  $('sInfo').textContent = '載入布林運算函式庫…';
  const csgOK = await initCSG();

  const saved = loadAutosave();
  let restored = false;

  if (saved) {
    try {
      doc.loadJSON(saved);
      restored = doc.objects.length > 0;
    } catch (e) {
      // 暫存壞掉不是致命問題，開個空白檔就好
      doc.clear();
    }
  }

  if (!restored) {
    doc.add(new ModelObject({
      name: '方塊 1', src: defaultSrc('box'), color: PALETTE[0],
      pos: new THREE.Vector3(0, 22.5, 0)
    }));
  }

  view.sync(doc);
  hist.reset(restored ? '接續上次' : '開始');
  panel.refresh();
  view.frameAll(doc);
  updateBar();

  if (!csgOK) {
    // 載不到就只是不能做布林，其餘功能照常。這種時候最怕的是
    // 整個介面掛掉卻不說為什麼，所以訊息要留久一點、講清楚怎麼辦。
    const why = csgError() ? csgError().message : '原因不明';
    toast('布林運算無法使用（' + why + '）。請確認是用伺服器開啟，不是雙擊檔案', true);
  } else if (restored) {
    toast(`接續上次的 ${doc.objects.length} 個物件`);
  }

  if (isTouch()) setTimeout(() => toast('單指轉視角　雙指縮放平移　點物件選取'), 900);
}

function loop() {
  requestAnimationFrame(loop);
  // gizmo 的大小是每一幀依相機距離重算的，所以三個軸標也要每一幀跟上。
  // 這一段是固定成本（三個 Sprite），不隨模型大小成長。
  sel.syncGizmoLabels();
  view.render();
  const fpsEl = $('sFps');
  if (fpsEl.textContent !== String(view.fps)) {
    fpsEl.textContent = view.fps || '–';
    /**
     * ⛔ **這裡不再更新「三角形」那一格**（2026-08-26）。
     * 它現在是**模型的屬性**，只有模型變了才會變，
     * 由 `updateBar()` 負責 —— ⛔ 不可以掛在每幀迴圈上。
     * 〔掛在這裡正是「亂跳」的第二個原因：它只有 FPS 剛好變了才更新，
     * 　所以顯示的是一串不相干時刻的快照〕
     */
  }
}

/* ═══════════════════════════════════════════════════════
 *  折疊：工具列與右側面板（2026-08-31，kang 提的小優化）
 * ═══════════════════════════════════════════════════════ */

/**
 * 🔴 **收合之後一定要叫 `view.resize()`。**
 * ⚠ `#stage` 變大了，但**視窗尺寸沒變 → ⛔ 不會有 resize 事件**，
 * 畫布會維持舊的大小：畫面被拉伸、而且**點下去的位置會偏掉**
 * （`pickElement()` 的 NDC 是照畫布尺寸算的）。
 * ⇒ ⛔ 這一行不是保險，是**必要**的。
 */
const LS_UI = 'modeler.ui.collapse';
function loadUI() {
  try { return JSON.parse(localStorage.getItem(LS_UI)) || {}; }
  catch (e) { return {}; }
}
function saveUI(o) {
  try { localStorage.setItem(LS_UI, JSON.stringify(o)); } catch (e) { /* 無所謂 */ }
}

function setCollapsed(which, on) {
  const el = $(which === 'bar' ? 'bar' : 'panel');
  el.hidden = !!on;
  const st = loadUI(); st[which] = !!on; saveUI(st);
  updateBar();
  /** ⚠ 版面改了才叫 —— 見上面那一則 */
  view.resize();
}

$('barToggle').onclick = () => setCollapsed('bar', !$('bar').hidden);
$('panelToggle').onclick = () => setCollapsed('panel', !$('panel').hidden);

/** 開場照上次的狀態擺（⛔ 不叫 setCollapsed，那會在還沒 updateBar 前跑） */
(function restoreUI() {
  const st = loadUI();
  $('bar').hidden = !!st.bar;
  $('panel').hidden = !!st.panel;
})();

window.addEventListener('resize', () => view.resize());
view.resize();
setMode('translate');
loop();
boot();   // 非同步：要先等布林函式庫載完才碰文件

// 開發時方便在主控台看東西
window.APP = app;
