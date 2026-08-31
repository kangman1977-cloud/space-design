/**
 * appver.js — 「抓最新版」：確認我現在跑的，是不是伺服器上最新的那一份
 *
 * ═══════════════════════════════════════════════════════
 * 🔴🔴 為什麼需要這一支（2026-08-31，kang 提的）
 * ═══════════════════════════════════════════════════════
 *
 * 同一天，「**原始碼是對的 ≠ 那台裝置拿到的是這份原始碼**」這件事
 * **換了三張臉**，每一次的症狀都跟病因完全對不起來：
 *
 * | 第幾次 | 在哪 | 機制 |
 * |---|---|---|
 * | 一 | 本機測試伺服器 | ⛔ 不送 `Cache-Control` → 瀏覽器自己猜「檔案年齡的 10%」 |
 * | 二 | 平板 | 拿到**新的 `main.js` ＋ 舊的 `scene.js`**（ES 模組是一個檔一個檔抓的）|
 * | 三 | 線上版 | GitHub Pages 送 `Cache-Control: max-age=600` —— **10 分鐘內連問都不問** |
 *
 * ⚠ 第二次那個最毒：**按鈕、提示、資料全對，而畫圖那一半的函式
 * 根本還不存在** —— ⛔ 不會報錯，⛔ 也沒有任何徵兆。
 *
 * kang 的原話：「如果我將網頁加入主畫面後…會因為快取的原因…
 * 　造成畫面看起來沒有更新的誤判…對嗎?」——**對。**
 * ⭐ 而**主畫面模式（`display: standalone`）連重新整理鈕都沒有**，
 * 所以他連「強制重整」這條退路都走不了。
 *
 * ⇒ **這一支把「你要猜」變成「它會講」。**
 * 〔規則：修法要是**機制**，⛔ 不可以是**紀律** —— 紀律會破，
 * 　而今天光是 AI 自己就在同一件事上栽了三次〕
 *
 * ═══════════════════════════════════════════════════════
 * 🔴 它真正有效的動作是哪一個（這一段決定它可不可靠）
 * ═══════════════════════════════════════════════════════
 *
 * > **真正有效的是「把瀏覽器的快取換成最新的」—— 這一定會成功。**
 * > 「有沒有新版」的比對**只是為了決定要不要順便重新載入**。
 *
 * ⇒ **就算比對漏報，使用者再按一次、或手動重整，一定拿得到新的。**
 * ⭐ 這個分工很重要：**可靠性⛔ 不依賴那個比對準不準**。
 *
 * ── ⚠ 比對用「檔案大小」，而它會漏報 ──────────────────
 * ⛔ 我們沒有辦法讀到「現在正在跑的那份程式碼的內容」，
 * 但 `performance` 有記著**它載入時的位元組數**（`encodedBodySize`）。
 * ⇒ 拿它跟重抓回來的長度比。
 *
 * 🔴 **誠實的但書：某次改動如果剛好沒有改變檔案大小，這裡會漏報**
 * （說「已經最新」而其實不是）。⭐ 照鐵律三「**誤報比漏報更糟**」，
 * 這個方向是對的 —— 而且漏報的代價很小（再按一次就好），
 * ⛔ 但**不可以假裝它是完美的**，所以介面上要講出來。
 *
 * ── ⛔ 為什麼不用 Service Worker ────────────────────────
 * 那會**多一層自己也會出錯的快取**，而我們正在解決的就是快取問題。
 * ⚠ 查過了：這個專案**⛔ 沒有任何 Service Worker、⛔ 沒有 Cache Storage**
 * —— 遇到快取問題**⛔ 不要往 PWA 那邊查**，就是普通的 HTTP 快取。
 *
 * ── ⛔ 為什麼不重抓 lib/ ────────────────────────────────
 * `lib/` 是 three.js 與 manifold（約 892KB），**幾乎不會變** ——
 * 每次多抓它們是純粹的浪費。⚠ 真的換了 three.js 的那一天，
 * 手動強制重整一次即可（那種事一年不會有幾次）。
 */

/**
 * 這一頁到底載入了哪些「我們自己寫的」檔。
 *
 * ⚠ **⛔ 不要寫死一份清單** —— 檔案會增減，而寫死的清單**會漂**，
 * 到時候新加的模組不會被檢查，⛔ 而且沒有任何徵兆。
 * ⭐ 改成**問瀏覽器「你剛才實際載入了什麼」**（`performance`），
 * 這樣清單永遠是對的。
 * 〔規則：⛔ 會過期的東西一律現查，不存〕
 */
function loadedOwnFiles() {
  const here = new URL('.', document.baseURI).href;   // 建模器/ 這一層
  const out = [];

  for (const e of performance.getEntriesByType('resource')) {
    // 只看自己的 js（⛔ 不含 lib/），而且要跟這一頁同一個來源
    if (!e.name.startsWith(here)) continue;
    if (!e.name.endsWith('.js')) continue;
    if (e.name.includes('/lib/')) continue;
    out.push({ url: e.name, size: e.encodedBodySize | 0 });
  }

  /**
   * ⚠ **`index.html` 本身也要算進來** —— 按鈕與欄位住在那裡。
   * 🔴 少了它就會出現「程式是新的、介面是舊的」，
   * 而那正是**今天第二次那張臉**的形狀（半新半舊最難查）。
   * ⭐ 它是導覽請求，⛔ 不在 `resource` 裡，所以另外補進來；
   * 大小拿不到（填 -1 ＝「⛔ 不比對，只負責把快取換掉」）。
   */
  out.push({ url: document.baseURI, size: -1 });
  return out;
}

/**
 * 按下「抓最新版」時做的事。
 *
 * @param {(done:number, total:number) => void} [onProgress] 抓到第幾個了
 * @returns {Promise<{ok:boolean, changed:number, total:number,
 *                    stamp:string|null, error:string|null,
 *                    unknown:number}>}
 *   `changed` ＞ 0 ⇒ 有新版，呼叫端應該重新載入
 *   `unknown` ＝ 拿不到原本大小、⛔ 沒辦法比對的檔數（要老實講出來）
 */
export async function fetchLatest(onProgress) {
  const files = loadedOwnFiles();
  let changed = 0;
  let unknown = 0;
  let stamp = null;
  let done = 0;

  for (const f of files) {
    let res;
    try {
      /**
       * 🔴 **`cache: 'reload'` 是這一支的核心。**
       * 它的意思是「**⛔ 不准用快取，去伺服器拿，而且把拿到的
       * 存回快取**」—— 後半段才是重點：**下一次重新載入時，
       * 瀏覽器手上已經是新的了**。
       *
       * ⚠ **⛔ 不可以用 `no-store`** —— 那個是「拿了也不要存」，
       * 比對得出結果，**但快取沒被換掉，重載之後還是舊的**。
       */
      res = await fetch(f.url, { cache: 'reload' });
    } catch (e) {
      /**
       * ⚠ **連不上要老實說，⛔ 不可以吞掉。**
       * 吞掉的話使用者會看到「已經是最新版」——
       * 而那是**假的保證**，比什麼都不講更糟（誤報比漏報更糟）。
       */
      return { ok: false, changed: 0, total: files.length, stamp: null,
               unknown: 0, error: '連不上伺服器：' + (e && e.message ? e.message : e) };
    }

    if (!res.ok) {
      return { ok: false, changed: 0, total: files.length, stamp: null,
               unknown: 0, error: `伺服器回應 ${res.status}（${f.url.split('/').pop()}）` };
    }

    const text = await res.text();
    const now = new Blob([text]).size;          // 位元組數，⛔ 不是字數

    if (f.size < 0) {
      unknown++;                                 // index.html：只換快取，⛔ 不比對
    } else if (f.size !== now) {
      changed++;
    }

    // 版本時間：用 main.js 的最後修改時間當作「你現在跑的是哪一版」
    if (f.url.endsWith('/main.js')) {
      const lm = res.headers.get('last-modified');
      if (lm) {
        const d = new Date(lm);
        if (!isNaN(d)) {
          const p = n => String(n).padStart(2, '0');
          stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
            + ` ${p(d.getHours())}:${p(d.getMinutes())}`;
        }
      }
    }

    done++;
    if (onProgress) onProgress(done, files.length);
  }

  return { ok: true, changed, total: files.length, stamp, unknown, error: null };
}
