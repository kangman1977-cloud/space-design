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
  if (!sel.setMode(m)) { toast('這個物件鎖定了縮放', true); return; }
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
