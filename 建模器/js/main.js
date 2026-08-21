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
         download, openFile, autosave, loadAutosave }
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
  }
});
sel.bindDoc(doc);

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
  onExplode: obj => explodeSelected(obj)
};

const panel = new Panel(app);
const unfoldWin = new UnfoldPanel(app);

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
  const made = explodeArray(obj);
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

$('unfold').onclick = () => unfoldWin.open();

$('undo').onclick = () => { const l = hist.undo(); if (l) toast('復原：' + l); updateBar(); };
$('redo').onclick = () => { const l = hist.redo(); if (l) toast('重做：' + l); updateBar(); };

$('mMove').onclick = () => setMode('translate');
$('mRot').onclick = () => setMode('rotate');
$('mScale').onclick = () => setMode('scale');

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

  // 展開：文件裡有板件就開放。沒選東西就展開全部，所以不看選取數量。
  const anySheet = doc.objects.some(o => o.kind === KIND.SHEET);
  $('unfold').disabled = !anySheet;
  $('unfold').title = anySheet
    ? '把板件攤平成下料圖：含尺寸標註、折線、折彎補償，可列印或輸出 DXF 送雷切'
    : '目前沒有板件。加一個「平板」或「折板」，或把物件的種類改成板件';

  // 開著的時候跟著文件一起更新，改個板厚就能看到展開長跟著變
  if (unfoldWin.isOpen) unfoldWin.run();

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
