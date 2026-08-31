"""
平板測試伺服器 —— 跟 `python -m http.server` 一樣，但【禁止快取】。

════════════════════════════════════════════════════════════
🔴🔴 這支的存在理由（2026-08-31，實際發生過，花掉一整輪）
════════════════════════════════════════════════════════════

【症狀】kang 的平板走 `http://<內網IP>:8080/建模器/`：
  · 左側直條的 `參考線` 按鈕【在】
  · 按下去那一組【出得來】
  · 加一條線，提示說【加了】，再按一次說【已經有了】
  · ⛔ 而畫面上一條線都沒有
  · 同一台平板走【線上版】（GitHub Pages）→ ✅ 完全正常
  · 同一份程式在電腦上（localhost）→ ✅ 完全正常

【病因】`python -m http.server` 會送 `Last-Modified`，
  但⛔ 不送 `Cache-Control`。瀏覽器碰到「沒有 Cache-Control」時，
  會用一條標準的推測規則（RFC 9111 §4.2.2 heuristic freshness）：

      可以放心用多久 ≈（現在 − 這個檔上次被改的時間）× 10%

  ⭐ 而這條規則正好把檔案分成兩半：

  | 檔 | 多久改一次 | 推測有效期 | 平板拿到的 |
  |---|---|---|---|
  | main.js / index.html | 每一輪都改 → 幾分鐘前 | 幾分鐘 | 新的 |
  | scene.js | 那陣子很久沒動 → 好幾天前 | 好幾小時 | 【舊的】 |

  ⇒ 平板同時拿到【新的 main.js】與【舊的 scene.js】：
    · 按鈕、加線、提示 → 住在 main.js → 全部正常
    · 把線畫出來（syncGuides）→ 住在 scene.js →
      那支函式在舊版【根本不存在】→ 什麼都不畫，⛔ 而且不會報錯

🔴 **症狀跟病因完全對不起來**，這是這個專案第二次踩到同一類的坑
   （第一次是 2026-08-28：`node --check` 對 ES 模組是瞎的，
   整個網頁一行都不跑，而工具列看起來完全正常）。

⚠ **⛔ 不要靠「記得清快取」解決** —— 那是紀律，它會再破。
   這支程式讓伺服器【每次都說「不准存」】，機制上就不會再發生。

════════════════════════════════════════════════════════════
用法
════════════════════════════════════════════════════════════

  由 `平板測試-啟動伺服器.bat` 呼叫，⛔ 平常不必自己跑。
  要自己跑：  py -3 版控工具/平板伺服器.py 8080
  （工作目錄要是專案根目錄 —— .bat 已經 cd 過去了）

⚠ **⛔ 不要拿它當正式的伺服器**：它沒有任何安全設定，
   只在你自己的區域網路裡分享這個資料夾，用完就把視窗關掉。
"""

import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    """跟內建的一樣，只多做一件事：每個回應都貼上「不准存」。"""

    def end_headers(self):
        # no-store：連存都不要存（比 no-cache 更強，no-cache 是「存了但每次要問」）
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')       # 給很舊的瀏覽器看的
        self.send_header('Expires', '0')
        super().end_headers()

    def send_head(self):
        """
        ⚠ **304 也要擋掉，⛔ 光送 `no-store` 不夠。**

        瀏覽器如果還是帶了 `If-Modified-Since` 過來（例如使用者按重新整理），
        內建的實作會回 **304 Not Modified** —— 而 304 的意思正是
        「**你手上那份還能用**」，那就是我們要消滅的行為。
        ⇒ 先把條件式請求的標頭拔掉，內建的實作就只會回完整的 200。
        """
        for h in ('If-Modified-Since', 'If-None-Match'):
            while h in self.headers:
                del self.headers[h]
        return super().send_head()

    def log_message(self, fmt, *args):
        # 只印路徑，⛔ 不印一長串預設格式 —— 平板測試時要看的是「它真的來抓了嗎」
        sys.stderr.write("  %s\n" % (fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print()
    print("  分享的資料夾：%s" % os.getcwd())
    print("  連接埠：%d　【已關閉快取：平板一定拿得到最新的檔】" % port)
    print()
    ThreadingHTTPServer(('0.0.0.0', port), NoCacheHandler).serve_forever()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\n  伺服器已停止。\n")
