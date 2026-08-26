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
         explodeShapes, download, openFile, autosave, loadAutosave }
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
         flattenElements, mergeCoplanarFaces, loopCut, edgeRing,
         recalcNormalsOutside, flipNormals, insetFaces, bevelEdges,
         deleteFaces, fillHoles, bisect, worldAxisPlane, connectVertsPath,
         splitFaceByEdges, subdivideEdges, separateAlongEdges,
         knifePath, planeCrossSegments,
         BEVEL_MAX_SEG, PLANAR_TOL_CM } from './core/edit.js';
import { strokeToPicks } from './core/stroke.js';
import { edgeLoop, sharpEdges, similarTo } from './core/selectops.js';
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
  /** 刀具：點下去吸到最近的邊，`hit` 帶著那條邊與邊上的落點 */
  onKnifePick: (hit, info) => knifePick(hit, info),
  /** 一筆畫：畫的當下只更新預覽（⛔ 這裡不算切點，見 `stroke.js` 檔頭） */
  onKnifeStrokeMove: pts => drawKnifeStroke(pts),
  /** 一筆畫：放開手 → 交點變成切點，**接到既有的那一串後面** */
  onKnifeStroke: (obj, pts, snapMid) => knifeStroke(obj, pts, snapMid),
  onTransform: committing => {
    view.sync(doc);
    if (committing) commit('變換物件');
    else updateBar();
  },
  onSeamPick: hit => seamPick(hit),
  onMatePick: el => matePick(el),
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
  onExplode: obj => explodeSelected(obj),
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

$('mate').onclick = () => toggleMateMode();
$('seam').onclick = () => toggleSeamMode();
$('edit').onclick = () => toggleEditMode();
$('extrude').onclick = () => extrudeSelected();
$('flatten').onclick = () => flattenSelected();
$('loopCut').onclick = () => loopCutSelected();
$('selRing').onclick = () => selectRingFromEdge();
$('selLoop').onclick = () => selectLoopFromEdge();
$('selAllEdges').onclick = () => selectAllEdges();
$('selSharp').onclick = () => selectSharpEdges();
$('selSimilar').onclick = () => selectSimilar();
$('inset').onclick = () => insetSelected();
$('bevel').onclick = () => bevelSelected();
$('delFace').onclick = () => deleteFacesSelected();
$('fillHoles').onclick = () => fillHolesOnSelected();
$('bisect').onclick = () => bisectSelected();
$('knife').onclick = () => toggleKnifeMode();
$('knifeCancel').onclick = () => cancelKnifeMode();
$('knifeSnapMid').onclick = () => toggleKnifeSnapMid();
$('separate').onclick = () => separateSelected();
$('vertDots').onclick = () => toggleVertexDots();
$('subdivEdge').onclick = () => subdivideEdgesSelected();
$('connectVerts').onclick = () => connectVertsSelected();
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
  if (keep !== 'knife' && sel.knifeMode) {
    sel.setKnifeMode(false); $('knife').classList.remove('on');
    knifePicks = []; hideKnifeLine();
  }
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

function cancelKnifeMode() {
  sel.setKnifeMode(false);
  $('knife').classList.remove('on');
  knifePicks = [];
  hideKnifeLine();
  panel.refresh();
  updateBar();
  toast('已離開刀具');
}

/**
 * 點一下 → 加一個位置。
 *
 * ⚠ **再點同一個地方一次 ＝ 取消最後那一點**（kang 同意的），
 * 跟編輯模式「再點一次取消選取」同一條規則 —— ⛔ 不要另發明一種。
 */
function knifePick(hit, info = {}) {
  /**
   * 🔴 **快點兩下 ＝ 從這裡接回起點，然後切下去。**
   *
   * ⚠ **要放在最前面**，⛔ 不可以排在「再點同一處 ＝ 取消最後一點」後面 ——
   * 雙擊的第二下本來就落在剛剛那一點上，排後面會先被當成取消。
   * 〔kang 2026-08-26 拍板：快慢是唯一的差別，逐點按的行為一格都沒變〕
   */
  if (info.double && knifePicks.length >= 2) { knifeCloseLoop(); return; }
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

  const last = knifePicks[knifePicks.length - 1];
  if (last && last.world.distanceTo(hit.world) < 0.5) {
    knifePicks.pop();
    drawKnifePicks();
    updateBar();
    toast(knifePicks.length ? `取消最後一點，還有 ${knifePicks.length} 個`
                            : '取消最後一點');
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
  const sameEdge = (first.a === last.a && first.b === last.b)
                || (first.a === last.b && first.b === last.a);
  if (!sameEdge) {
    knifePicks.push({ ...first, p: first.p.clone(), world: first.world.clone() });
    drawKnifePicks();
  }
  toast(sameEdge ? '起點跟終點已經在同一條邊上，直接切下去'
                 : `閉合迴圈（${knifePicks.length} 個位置）`);
  knifeApply();
}

/** 真的切下去 */
function knifeApply() {
  const obj = knifePicks.length ? knifePicks[0].obj : null;
  if (!obj) { toast('先在模型上點兩個以上的位置', true); return; }

  const r = knifePath(obj.mesh(), knifePicks.map(k => ({ a: k.a, b: k.b, p: k.p })));
  if (!r.ok) { toast(r.reason, true); return; }

  const segs = r.segments;
  knifePicks = [];
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
  $('gEditXf').hidden = false;
  const got = sel.selectEdges(obj, hes);
  syncModeButtons();
  panel.refresh();
  updateBar();
  updateEditNum();

  const bits = [segs > 1 ? `已切開 ${segs} 段` : '已切開'];
  if (got) bits.push(`新的 ${got} 條線已選起來 —— 要拆成兩個物件就按「分離」`);
  toast(bits.join('　'));
}

function toggleEditMode() {
  if (!sel.editMode) exitOtherModes('edit');
  const on = sel.setEditMode(!sel.editMode);
  $('edit').classList.toggle('on', on);
  /**
   * 「方向」與「數值」只在編輯模式下有意義，所以整組跟著開關。
   * 平常不佔工具列的寬 —— 工具列每多一顆按鈕，平板上就更容易把
   * 後面的整組擠掉（`.grp` 那條 flex-wrap 註解講的同一件事）。
   */
  $('gEditXf').hidden = !on;
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

function setEditFilter(kind) {
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
  const many = sel.editCount > 1;
  toast(got === 'active'
    ? (many ? '中心改成「最後點的那一個」（畫成橘色的那個）'
            : '中心改成「最後點的那一個」。⚠ 只選一個時它跟「重心」是同一個點，看不出差別')
    : '中心改成「全部選取頂點的重心」');
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
   * ⚠ **位置刻意不動**：每一塊都沿用原物件的變換，網格座標一格都不改 ——
   * 分離之後畫面上什麼都不會跳，只是變成兩個物件。
   * 〔對照 `explodeShapes()`：那一支會置中，因為它拆的是本來就各自獨立
   * 　的形狀；這裡拆的是同一個東西的兩半，跳開反而難對回去〕
   */
  const made = r.meshes.map((m, i) => new ModelObject({
    name: `${obj.name}－${i + 1}`,
    kind: obj.kind,
    src: { type: 'mesh' },
    mesh: m,
    pos: obj.pos, rot: obj.rot, scale: obj.scale,
    color: obj.color, thickness: obj.thickness, lockScale: obj.lockScale
  }));

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
  const before = obj.mesh().volume();
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
   */
  bits.push(`體積 ${before.toFixed(2)} → ${r.mesh.volume().toFixed(2)} cm³`);
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
}

for (const b of document.querySelectorAll('.snapBtn')) {
  b.onclick = () => {
    const s = Number(b.dataset.s);
    sel.setSnap(s);
    for (const x of document.querySelectorAll('.snapBtn')) {
      x.classList.toggle('on', Number(x.dataset.s) === s);
    }
    toast(s > 0 ? `吸附 ${s}cm` : '吸附關閉');
  };
}

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
  $('del').disabled = sel.count === 0;
  $('dup').disabled = sel.count === 0;

  // 布林要兩個以上的物件；陣列一個就夠。兩者都要函式庫已載好
  const canDoBool = sel.count >= 2 && csgReady();
  for (const id of ['bUnion', 'bSub', 'bInt']) $(id).disabled = !canDoBool;

  // 陣列一個物件就夠。板件的陣列不需要布林函式庫，所以不綁 csgReady
  for (const id of ['aLinear', 'aRadial', 'aMirror']) $(id).disabled = sel.count < 1;

  /**
   * 擠出：**選到一個面才給按**。
   *
   * 灰掉比按了跳錯誤訊息好 —— 使用者一眼就知道「還缺一步」，
   * 而不是按下去被罵。`title` 也跟著換，滑過去就講得出缺什麼。
   */
  const face = sel.editMode && sel.editSel && sel.editSel.kind === 'face';
  $('extrude').disabled = !face;
  $('extrude').title = face
    ? `從選到的面長出新的一段（先長 ${sel.snapStep > 0 ? sel.snapStep : 1} cm，再用箭頭拉）`
    : (sel.editMode ? '先選一個面（把過濾器切到「面」比較好點）'
                    : '先按「拉點線面」進入編輯模式，再選一個面');

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
  $('inset').disabled = !face;
  $('insetW').disabled = !face;
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
  $('delFace').disabled = !face;
  $('delFace').title = face
    ? (sel.editCount > 1
        ? `把選到的 ${sel.editCount} 個面拿掉。⚠ 網格會變開放，之後不能做布林（可以用「補洞」補回來）`
        : '把這個面拿掉，那裡會變成一個洞。⚠ 網格會變開放（可以用「補洞」補回來）')
    : (sel.editMode ? '先選一個面（可以開「加選」選好幾個）'
                    : '先按「拉點線面」進入編輯模式，再選面');

  const canFill = sel.active && !sel.active.isParametric;
  $('fillHoles').disabled = !canFill;
  $('fillHoles').title = !sel.active
    ? '先選一個物件'
    : (sel.active.isParametric
        ? '參數物件補了也留不住（開檔會照參數重新生成）。要補請先按「轉成可編輯網格」'
        : '把這個物件上所有的洞補起來。⚠ 板件（一張沒有厚度的面）按了會被封起來，那時體積會是 0');

  $('flatten').disabled = !face;
  $('flatten').title = face
    ? (sel.editCount > 1
        ? `把選到的 ${sel.editCount} 個面壓到同一個平面上，然後自動併成一個面。⚠ 形狀會變`
        : '把這個面壓平。⚠ 本來就是平的話不會有動作')
    : (sel.editMode ? '先選一個面（可以開「加選」選好幾個）'
                    : '先按「拉點線面」進入編輯模式，再選面');

  /**
   * 環切：**選到一條邊才給按**。
   *
   * ⚠ 一次只能一條 —— 起點不同，繞出來的圈就不同，
   * 選了三條要繞哪一圈**結果不唯一，而不唯一就不猜**（鐵律三，坑第 24 條）。
   */
  const edge1 = sel.editMode && sel.editSel && sel.editSel.kind === 'edge'
             && sel.editCount === 1;
  $('loopCut').disabled = !edge1;
  $('loopCutN').disabled = !edge1;
  /**
   * 導角：**選到邊就給按**（一條或好幾條都行）。
   * 跟環切「一次只能一條」不同 —— 相鄰的邊一起導才有角落，
   * 那正是它主要的用途。
   */
  const edgeAny = sel.editMode && sel.editCount > 0
    && sel.editSels.every(e => e.kind === 'edge');
  $('bevel').disabled = !edgeAny;
  $('bevelW').disabled = !edgeAny;
  $('bevelSeg').disabled = !edgeAny;
  $('bevel').title = edgeAny
    ? (sel.editCount > 1
        ? `把選到的 ${sel.editCount} 條邊都換成斜切面，相鄰的地方角落會自動長出來`
        : '把這條邊換成一片斜切面。相鄰的邊一起選，角落會自動長出來')
    : (sel.editMode ? '先選邊（可以開「加選」選好幾條）'
                    : '先按「拉點線面」進入編輯模式，再選邊');

  $('selRing').disabled = !edge1;
  $('selRing').title = edge1
    ? '從這條邊【橫著跨過】四邊形繞一圈全部選起來（也可以先按它看環切會切在哪）'
    : (sel.editMode ? '先選一條邊' : '先按「拉點線面」進入編輯模式，再選一條邊');

  /**
   * 選一條線：條件跟「選一圈」一模一樣（正好選到一條邊）——
   * ⚠ 兩顆的差別在**走法**，不在**能不能按**。
   */
  $('selLoop').disabled = !edge1;
  $('selLoop').title = edge1
    ? '從這條邊【順著同一條線】走到底（球的一條經線＝從極走到極）'
    : (sel.editMode ? '先選一條邊' : '先按「拉點線面」進入編輯模式，再選一條邊');

  /**
   * 全選邊：**選到物件就給按，不必先選任何邊** ——
   * 它就是拿來取代「一條一條點」的。
   */
  const canAll = sel.editMode && !!sel.active;
  $('selAllEdges').disabled = !canAll;
  $('selAllEdges').title = canAll
    ? '把這個物件所有看得見的邊一次選起來（方塊 12 條）。要做整個物件的導角／圓角就先按它'
    : '先按「拉點線面」進入編輯模式，再選一個物件';

  /**
   * 選轉角：**跟「全選邊」同一個條件** —— 選到物件就給按，不必先選邊。
   * ⚠ 它掃的是整個物件，種子不是「現在選到哪一條」。
   */
  $('selSharp').disabled = !canAll;
  $('sharpDeg').disabled = !canAll;
  $('selSharp').title = canAll
    ? '把所有【折起來】的邊一次選起來（夾角大於旁邊那個度數）。標分片切割線的捷徑'
    : '先按「拉點線面」進入編輯模式，再選一個物件';

  /**
   * 選相似：**一定要先選到一個元素當範本** ——
   * 「相似」是跟誰相似，沒有範本就沒有答案（坑第 24 條）。
   * ⚠ 種子是 **active（最後選的那一個）**，跟「中心＝最後選的」同一套。
   */
  const canSimilar = sel.editMode && !!sel.editSel;
  $('selSimilar').disabled = !canSimilar;
  $('similarMode').disabled = !canSimilar;
  $('selSimilar').title = canSimilar
    ? `跟【最後選的那一個${sel.editSel.kind === 'edge' ? '邊' : sel.editSel.kind === 'face' ? '面' : '點'}】同一類的全部選起來`
    : (sel.editMode ? '先選一個面或一條邊當範本'
                    : '先按「拉點線面」進入編輯模式，再選一個面或一條邊');

  /**
   * 任意切線：**選到物件就給按，不必選任何元素** ——
   * 它切的是整個物件，位置由旁邊的軸與座標決定。
   */
  const canBisect = sel.editMode && !!sel.active;
  $('bisect').disabled = !canBisect;
  $('bisectAxis').disabled = !canBisect;
  $('bisectAt').disabled = !canBisect;
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
   * 🔴 **按鈕文字要講出「現在按下去會發生什麼」。**
   * 同一顆按鈕在模式裡是「切下去」、在模式外是「進入刀具」——
   * ⛔ 一直寫「刀具」的話，使用者不知道點滿兩個之後該按誰（坑第 21 條）。
   */
  $('knife').textContent = sel.knifeMode
    ? (knifePicks.length >= 2 ? `切下去（${knifePicks.length} 點）` : '刀具（點兩個以上）')
    : '刀具';
  $('knifeCancel').hidden = !sel.knifeMode;
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
  $('separate').disabled = !edgeAnySel;
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
  $('subdivEdge').disabled = !edgeSome;
  $('subdivN').disabled = !edgeSome;
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
  $('connectVerts').disabled = !manyVerts;
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
   * 面上加線：**正好選到兩條邊才給按。**
   * ⚠ 跟「連接兩點」的差別在**吃什麼**（那顆吃點、這顆吃邊），
   * 所以 title 要把「現在差什麼」講清楚 —— 兩顆長得很像，
   * 灰掉的原因不講，使用者會以為按錯顆（坑第 11、21 條）。
   */
  const twoEdges = sel.editMode && sel.editCount === 2
    && sel.editSels.every(e => e.kind === 'edge');
  $('splitFace').disabled = !twoEdges;
  $('splitFaceT').disabled = !twoEdges;
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
  $('fixNormals').disabled = !fixable;
  $('flipNormals').disabled = !fixable;
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

window.addEventListener('resize', () => view.resize());
view.resize();
setMode('translate');
loop();
boot();   // 非同步：要先等布林函式庫載完才碰文件

// 開發時方便在主控台看東西
window.APP = app;
