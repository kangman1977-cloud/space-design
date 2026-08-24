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
import { Selection, isTouch } from './view/select.js';
import { Panel, fillPrimMenu } from './ui/toolbar.js';
import { UnfoldPanel } from './ui/unfoldPanel.js';
import { setSeam, isSeam, cutAroundFace, faceIsCutOut, seamBlockReason }
  from './unfold/seam.js';
import { unfoldObject } from './unfold/part.js';
import { faceFrame, edgeFrame, vertexPoint,
         mateFaceToFace, mateEdgeToEdge, mateVertexToVertex } from './core/mate.js';
import { elementVerts, refreshAfterEdit, extrudeFace,
         flattenElements, mergeCoplanarFaces, loopCut } from './core/edit.js';
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
  onChange: () => { panel.refresh(); updateBar(); },
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
  onMarquee: n => toast(n ? `框選到 ${n} 個物件` : '框選範圍內沒有物件', !n)
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
  if (e.key === 'Enter') { e.preventDefault(); commitEditNumber(); }
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
  const box = $('editNum'), unit = $('editNumUnit');
  const info = sel.editMode ? sel.editDragValue() : null;
  if (!info) {
    box.disabled = true;
    box.value = '';
    unit.textContent = '—';
    return;
  }
  box.disabled = false;
  // 拖曳中不要覆蓋使用者正在打的字；只有沒聚焦時才跟著拖曳跑
  if (document.activeElement !== box) box.value = (+info.value.toFixed(4)).toString();
  unit.textContent = `${info.axis}　${info.unit}`;
}

function setEditFilter(kind) {
  const r = sel.setEditFilter(kind);
  for (const b of document.querySelectorAll('.efBtn')) {
    b.classList.toggle('on', b.dataset.f === kind);
  }
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

function updateBar() {
  $('sObj').textContent = doc.objects.length;
  $('sSel').textContent = sel.count;
  $('sTri').textContent = view.triangles.toLocaleString();
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
    $('sTri').textContent = view.triangles.toLocaleString();
  }
}

window.addEventListener('resize', () => view.resize());
view.resize();
setMode('translate');
loop();
boot();   // 非同步：要先等布林函式庫載完才碰文件

// 開發時方便在主控台看東西
window.APP = app;
