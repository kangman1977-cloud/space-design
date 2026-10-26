/**
 * askBox.js — 建模器自己畫的「確定嗎？」小視窗（2026-10-21，kang「同意你的建議」→ `實驗-匯入狐狸存錢筒.md`「修的這一批」）
 *
 * 🔴 **⛔ 用瀏覽器自己的 `confirm()`**：有的瀏覽器（例如 Claude App 內建的瀏覽器窗格）
 * 會把它直接當成「取消」、不跳出來 ⇒ 按鈕按了沒反應（kang 在本機版按「清除全部標記」撞到）。
 * 這個框畫在頁面裡，哪一個瀏覽器、平板都一樣。
 *
 * 用法：`if (!(await ask('會清掉…，確定嗎？'))) return;`
 * Enter ＝ 確定、Esc 或點外面 ＝ 取消。開著的時候建模器的快捷鍵不作用（`isAskOpen()`）。
 */

let el = null, msgEl = null, okBtn = null, noBtn = null, done = null;

function build() {
  el = document.createElement('div');
  el.id = 'askWin';
  el.className = 'uwWin';
  el.hidden = true;
  el.style.zIndex = '80';                    // 蓋過其他視窗（.uwWin 是 60）
  el.innerHTML = `
    <div class="uwBack"></div>
    <div style="position:absolute;left:50%;top:30%;transform:translate(-50%,-50%);width:min(440px,92vw);
      background:#20232a;border:1px solid #3a3f48;border-radius:10px;box-shadow:0 12px 48px rgba(0,0,0,.5);padding:16px 18px">
      <div id="askMsg" style="font-size:13px;line-height:1.7;white-space:pre-wrap;margin-bottom:14px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button id="askNo" title="取消：不做，什麼都不改">取消</button>
        <button id="askOk" class="on" title="確定：照上面那一句做下去">確定</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  msgEl = el.querySelector('#askMsg');
  okBtn = el.querySelector('#askOk');
  noBtn = el.querySelector('#askNo');
  okBtn.onclick = () => finish(true);
  noBtn.onclick = () => finish(false);
  el.querySelector('.uwBack').onclick = () => finish(false);
  // 捕獲階段先攔：Enter／Esc 給這個框，其他鍵也⛔ 掉到建模器的快捷鍵
  window.addEventListener('keydown', e => {
    if (el.hidden) return;
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    e.stopImmediatePropagation();
  }, true);
}

function finish(v) {
  if (!el || el.hidden) return;
  el.hidden = true;
  const d = done; done = null;
  if (d) d(v);
}

/**
 * 問一句、等使用者按。
 * @param {string} message
 * @returns {Promise<boolean>} true ＝ 確定
 */
export function ask(message) {
  if (!el) build();
  if (done) finish(false);                   // 上一個還開著 ⇒ 當成取消
  msgEl.textContent = message;
  el.hidden = false;
  okBtn.focus();
  return new Promise(res => { done = res; });
}

/** 確認框開著嗎（建模器的快捷鍵要讓開）*/
export const isAskOpen = () => !!el && !el.hidden;
