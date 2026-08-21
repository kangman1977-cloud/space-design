/**
 * save.js — 把檔案存到使用者指定的位置
 *
 * ── 為什麼不是三行就好 ──────────────────────────────
 * 「產生一個 <a download> 然後 click()」看起來三行就能寫完，
 * 但實際上有一整排地雷，這個檔案就是把它們一次踩完的成果。
 * 做法直接沿用「組裝系統結構說明表」裡驗證過的那一套，
 * 兩個工具的存檔行為因此完全一致。
 *
 * ── 踩過的地雷 ──────────────────────────────────────
 *
 * **1. <a> 沒掛進 DOM，Chrome 會忽略 download 檔名**
 * 實際結果是存成「尚未確認的 636844.DXF」—— Chrome 自己的暫存名，
 * 副檔名還被改成大寫。使用者拿到的檔案 Illustrator 認不得，
 * 看起來就像「程式匯出壞掉」，其實檔案內容完全正確。
 * → 一定要 appendChild 之後再 click，click 完再移除。
 *
 * **2. blob URL 回收太快，下載會半途中斷**
 * 原本 1 秒就 revoke，留下一堆 .crdownload 檔。改成 5 秒。
 *
 * **3. 連續下載多個檔案會被瀏覽器擋掉**
 * 一次要存好幾片的 SVG 時，Chrome 只放行第一個。
 * → 每個錯開 250ms。
 *
 * **4. await 會吃掉使用者手勢**
 * showSaveFilePicker() 必須在使用者按下按鈕的手勢還有效時呼叫。
 * 如果先 await 別的東西（例如非同步產圖），手勢就過期了，
 * 瀏覽器會直接拒絕。
 * → **資料一律同步準備好，picker 是第一個 await**。
 *
 * ── 指定位置有前提 ──────────────────────────────────
 * File System Access API 只在**安全環境**可用（https 或 localhost）。
 * 本機用 http://<內網IP>:8080/ 開不算安全環境，會自動退回一般下載；
 * 線上版（GitHub Pages 是 https）才選得了位置。
 */

const canSaveAs  = () => typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
const canPickDir = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

/** 這個瀏覽器／開啟方式支不支援指定位置 —— 面板要據此顯示提示 */
export function canChoosePath() { return canSaveAs(); }

/** 檔名裡不能出現的字元。Windows 的限制最嚴，照它來就通吃。 */
export function safeName(s, dflt = '未命名') {
  return String(s ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || dflt;
}

/** showSaveFilePicker 的檔案類型描述。副檔名寫對，存出來才不會被亂加。 */
export const TYPES = {
  dxf:  [{ description: 'DXF 圖檔',  accept: { 'application/dxf': ['.dxf'] } }],
  svg:  [{ description: 'SVG 向量圖', accept: { 'image/svg+xml': ['.svg'] } }],
  csv:  [{ description: 'CSV 檔',    accept: { 'text/csv': ['.csv'] } }],
  json: [{ description: 'JSON 檔',   accept: { 'application/json': ['.json'] } }],
  png:  [{ description: 'PNG 圖檔',  accept: { 'image/png': ['.png'] } }]
};

let warned = false;

/**
 * 指定位置失敗時的提示。只講一次，講清楚為什麼、以及怎麼辦。
 * 沉默地退回一般下載是最糟的做法 —— 使用者會以為勾選壞掉了。
 */
function fallbackNote(e) {
  if (warned) return;
  warned = true;
  console.warn('File System Access 不可用：', e);
  if (typeof alert === 'function') {
    alert('這個開啟方式沒辦法直接指定路徑，已改用一般下載。\n\n'
      + '原因：瀏覽器只在「安全環境」開放這個功能。\n'
      + '用內網 IP（http://192.168...）開屬於非安全環境，線上版（https）才可以。\n\n'
      + '若想每次都選位置，可到 Chrome 設定 →「下載內容」→\n'
      + '開啟「下載前詢問每個檔案的儲存位置」。');
  }
}

/**
 * 一般下載。**三個細節都不能省**（理由見檔頭）：
 * 掛進 DOM、click 後移除、5 秒才回收 URL。
 */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 5000);
}

/**
 * 存一個檔案。勾了「指定存放位置」而且環境允許，就跳另存新檔。
 *
 * @param {Blob} blob     要存的內容（**必須已經同步準備好**）
 * @param {string} name   建議檔名，含副檔名
 * @param {Array} types   TYPES 之一
 * @param {boolean} ask   使用者有沒有勾「指定存放位置」
 * @returns {Promise<boolean>} false ＝ 使用者按了取消
 */
export async function saveBlob(blob, name, types, ask) {
  if (ask && canSaveAs()) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name, types });
      const w = await h.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if (e && e.name === 'AbortError') return false;   // 使用者取消，不是錯誤
      fallbackNote(e);
    }
  }
  downloadBlob(blob, name);
  return true;
}

/**
 * 一次存多個檔案。
 *
 * 勾了指定位置就讓使用者選**一次**資料夾，整批寫進去 ——
 * 五片就跳五次另存新檔是不能用的介面。
 * 退回一般下載時每個錯開 250ms，否則瀏覽器只放行第一個。
 *
 * @param {Array<{name:string, blob:Blob}>} jobs 必須已經同步準備好
 * @returns {Promise<number>} 實際存了幾個；-1 ＝ 使用者取消
 */
export async function saveMany(jobs, ask) {
  if (!jobs.length) return 0;
  if (jobs.length === 1) {
    const ok = await saveBlob(jobs[0].blob, jobs[0].name, guessTypes(jobs[0].name), ask);
    return ok ? 1 : -1;
  }

  if (ask && canPickDir()) {
    let dir = null;
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (e) {
      if (e && e.name === 'AbortError') return -1;
      fallbackNote(e);
    }
    if (dir) {
      let n = 0;
      for (const j of jobs) {
        const fh = await dir.getFileHandle(j.name, { create: true });
        const w = await fh.createWritable();
        await w.write(j.blob);
        await w.close();
        n++;
      }
      return n;
    }
  }

  jobs.forEach((j, i) => setTimeout(() => downloadBlob(j.blob, j.name), i * 250));
  return jobs.length;
}

function guessTypes(name) {
  const ext = String(name).toLowerCase().split('.').pop();
  return TYPES[ext] || TYPES.json;
}

/** 文字 → Blob。UTF-8 一律寫進 type，中文才不會被當成系統編碼。 */
export function textBlob(text, mime) {
  return new Blob([text], { type: `${mime};charset=utf-8` });
}
