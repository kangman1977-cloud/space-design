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
import { Doc, ModelObject, KIND, download, openFile, autosave, loadAutosave }
  from './core/io.js';
import { defaultSrc, PRIM_SPECS } from './build/prim.js';
import { History } from './core/history.js';
import { SceneView } from './view/scene.js';
import { Selection, isTouch } from './view/select.js';
import { Panel, fillPrimMenu } from './ui/toolbar.js';

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
  onEdit: label => { view.sync(doc); commit(label); }
};

const panel = new Panel(app);

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
    kind: type === 'plate' ? KIND.SHEET : KIND.SOLID,
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

  const act = sel.active;
  $('sInfo').textContent = act
    ? `${act.name}　X ${f1(act.pos.x)}　Y ${f1(act.pos.y)}　Z ${f1(act.pos.z)} cm`
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

function boot() {
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

  if (restored) toast(`接續上次的 ${doc.objects.length} 個物件`);
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
boot();
setMode('translate');
loop();

// 開發時方便在主控台看東西
window.APP = app;
