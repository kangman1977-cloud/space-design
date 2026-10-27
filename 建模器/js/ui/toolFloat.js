/**
 * toolFloat.js — 「工具」區拉出來之後的浮動視窗（介面第二輪 1b）
 *
 * 🔴 kang 2026-10-27「照建議」（→ `介面編排-設計方向.md`「1b 動工前查到的」、`規格\建模器-工具區.md`「1b」）：
 *   ① 按鈕「拉出來」「放回面板」② 一開始在 3D 畫面左上角 ③ 寬 300（跟面板一樣，綁好的組不重排）、高跟著內容、最高到畫面，
 *   可以收成一條 ④ 拉出來時面板最上面留一條 ⑤ 面板收起來自動浮、打開時看當初怎麼浮出來的；有沒有拉出來、放哪、收不收記在瀏覽器。
 *
 * 這一支只管「視窗本身」：建出來、拖、夾在畫面裡、算高度。放什麼進去、什麼時候出現由 main.js `placeTools()` 決定。
 * ⚠ 建模器裡原本沒有可以拖的視窗（`.uwWin` 都是蓋滿整個畫面）—— 這是第一個。
 */

export const FLOAT_W = 300;
const HEAD_KEEP = 40;   // 拖到邊邊時，標題列至少要留在畫面裡的高度（拖得回來）

/**
 * 純算（測試直接叫）：位置夾在畫面裡 —— 整個寬度放得下就整個放進來；標題列一定看得到（才拖得回來）。
 * @param {{x:number,y:number}} pos 想放的左上角（畫面座標）
 * @param {{w:number}} size 視窗寬
 * @param {{w:number,h:number}} view 畫面（innerWidth、innerHeight）
 */
export function clampPos(pos, size, view) {
  const maxX = Math.max(0, view.w - size.w), maxY = Math.max(0, view.h - HEAD_KEEP);
  return { x: Math.round(Math.min(Math.max(0, pos.x), maxX)), y: Math.round(Math.min(Math.max(0, pos.y), maxY)) };
}

/**
 * 建出浮動視窗（還沒放進任何東西、先藏著）。
 * @param {{onFold:Function, onDock:Function, onMoved:Function}} h 收一條、放回面板、拖完放開（給新位置）
 */
export function makeFloat(h) {
  const el = document.createElement('div');
  el.id = 'toolFloat';
  el.hidden = true;
  el.innerHTML = '<div class="tfHead"><b>工具</b><span class="tfBtns">'
    + '<button id="tfFold" class="mini" title="收成一條：只留標題列（「工具」兩個字），畫面看得比較多；再按一次展開">收起 ▴</button>'
    + '<button id="tfDock" class="mini" title="放回面板：工具回到右側面板最上面「工具」那一區（面板收著的話會一起打開）">放回面板 ↘</button>'
    + '</span></div><div class="tfBody"></div>';
  document.body.appendChild(el);
  const head = el.querySelector('.tfHead'), body = el.querySelector('.tfBody');
  const fold = el.querySelector('#tfFold'), dock = el.querySelector('#tfDock');
  fold.onclick = () => h.onFold();
  dock.onclick = () => h.onDock();

  /** 拖標題列（按鈕上按下去⛔ 算拖）；滑鼠、手指同一套（pointer）*/
  head.addEventListener('pointerdown', e => {
    if (e.target.closest('button') || e.button > 0) return;
    e.preventDefault();
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = ev => {
      const p = clampPos({ x: ev.clientX - dx, y: ev.clientY - dy }, { w: el.offsetWidth }, { w: innerWidth, h: innerHeight });
      el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
      fitHeight(el);
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      h.onMoved({ x: parseFloat(el.style.left) || 0, y: parseFloat(el.style.top) || 0 });
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
  });
  return { el, head, body, fold, dock };
}

/** 內容最高到畫面底下（留一點邊），超過就在視窗裡捲 */
export function fitHeight(el) {
  const body = el.querySelector('.tfBody'), head = el.querySelector('.tfHead');
  const top = el.getBoundingClientRect().top;
  body.style.maxHeight = Math.max(120, innerHeight - top - head.offsetHeight - 12) + 'px';
}

/**
 * 擺到該擺的位置：記住的位置（夾在畫面裡），沒有就 3D 畫面左上角（左側直條右邊、工具列下面，各留 12）。
 * @param {Element} el 浮動視窗
 * @param {{x:number,y:number}|null} saved 記住的位置
 * @param {Element} stage 3D 畫面那一塊（`#stage`）
 */
export function placeFloat(el, saved, stage) {
  const r = stage.getBoundingClientRect();
  const want = saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) ? saved : { x: r.left + 12, y: r.top + 12 };
  const p = clampPos(want, { w: el.offsetWidth || FLOAT_W }, { w: innerWidth, h: innerHeight });
  el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
  fitHeight(el);
}
