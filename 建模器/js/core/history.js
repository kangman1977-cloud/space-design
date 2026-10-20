/**
 * history.js — Undo / Redo
 *
 * 用「整份快照」的方式做，不是記錄每個動作的反向操作。
 *
 * ── 為什麼選快照 ────────────────────────────────────
 * 反向操作省記憶體，但每加一個新功能就要多寫一個對應的「反做」，
 * 漏掉一個就會出現「復原之後檔案壞掉」這種最難查的錯。
 * 快照笨一點，但永遠不會錯 —— 而且我們的模型是幾百 KB 的等級，
 * 存 60 步也才幾十 MB，划算。〔2026-10-20 ⑤-11 改成 200 步＋總量上限，見建構子〕
 *
 * 如果哪天模型大到快照吃不消，再換成差異式，介面不用改。
 */

export class History {
  /**
   * @param {object} io
   * @param {() => any} io.get 取得目前狀態（要能被 JSON 序列化）
   * @param {(state:any) => void} io.set 套用狀態
   * @param {number} [io.limit=200] 最多記幾步
   * @param {number} [io.maxBytes=150e6] 全部的快照加起來最多多大（字數；超過就丟最舊的）
   *
   * ⑤-11（2026-10-20，kang「照建議」）：60 步 → **200 步**（T1、T4、T9 都退到底過）。
   * ⚠ 步數放大之後怕的是大模型 —— 一步 500 KB × 200 ＝ 100 MB ⇒ 另外加一道「總量」的上限，
   * 超過就先丟最舊的（小模型照樣記得滿 200 步）。
   */
  constructor({ get, set, limit = 200, maxBytes = 150e6 }) {
    this._get = get;
    this._set = set;
    this.limit = limit;
    this.maxBytes = maxBytes;
    this.stack = [];
    this.index = -1;
    this._muted = false;
    /** 最舊的幾步有沒有被丟掉過（退到底時講「只記得最近幾步」用）*/
    this.trimmed = false;
    this.onChange = null;      // 由介面掛上去，用來更新按鈕的可按狀態
  }

  /** 記錄起始狀態。載入新檔或重設場景後呼叫。 */
  reset(label = '開始') {
    this.stack = [{ label, state: this._snapshot() }];
    this.index = 0;
    this.trimmed = false;
    this._fire();
  }

  /**
   * 把「現在」記成一步。
   * 在動作完成之後呼叫，label 寫使用者看得懂的話（會顯示在介面上）。
   *
   * 🔴 **⑤-11（2026-10-20，kang「照建議」）兩條新規則**：
   * 1. **跟上一步一模一樣 ⇒ ⛔ 記**（點一下已經選的點、拖了又放回原位…以前都多一步「拉點」，
   *    按復原「什麼都沒變」，人會以為復原壞了）。⚠ 也⛔ 砍掉重做那條分岔 —— 什麼都沒做。
   * 2. **`replace` ＋ 同一個 `tag` ⇒ 取代最上面那一步**：拖完箭頭接著打數字，是「把剛才那一次改成精確的量」，
   *    ⛔ 是第二個動作（以前要按兩次復原才回到拖之前）。只在最上面那一步就是同一次拖曳時取代
   *    （中間做過別的事 ⇒ tag 對不上 ⇒ 照舊記成新的一步，⛔ 吃掉不相干的那一步）。
   *    取代完跟再前一步一樣（例如打 0）⇒ 這一步整個拿掉。
   *
   * @param {string} label
   * @param {{tag?:any, replace?:boolean}} [opt]
   */
  commit(label, opt = {}) {
    if (this._muted) return;
    const state = this._snapshot();
    const { tag = null, replace = false } = opt;

    const top = this.stack[this.index];
    if (replace && tag != null && top && top.tag === tag
        && this.index === this.stack.length - 1 && this.index > 0) {
      this.stack[this.index] = { label, state, tag };
      if (this.stack[this.index - 1].state === state) {
        this.stack.length = this.index;
        this.index--;
      }
      this._fire();
      return;
    }
    if (top && top.state === state) return;

    // 走過 undo 之後又做了新動作 → 砍掉前面那條分岔
    if (this.index < this.stack.length - 1) {
      this.stack.length = this.index + 1;
    }

    this.stack.push({ label, state, tag });

    while (this.stack.length > 2
        && (this.stack.length > this.limit || this.bytes > this.maxBytes)) {
      this.stack.shift();
      this.trimmed = true;
    }
    this.index = this.stack.length - 1;
    this._fire();
  }

  /**
   * 最上面那一步的 tag（停在最新那一步才有；退過 ⇒ `null`）。
   * ⑥-4（2026-10-21）：擠完打長度要確定「剛才那一步還是擠出、中間沒做別的」才取代它。
   */
  topTag() {
    const top = this.stack[this.index];
    return top && this.index === this.stack.length - 1 ? top.tag : null;
  }

  /**
   * ⚠ **回傳「被撤銷的那一步」的名字**，⛔ 不是退回去之後那一步（2026-10-08 查 bug 改的）。
   * 以前先退一格再回報 ⇒ 做了 A、B 之後按復原，提示寫「復原：A」（實際撤銷的是 B），
   * 退到最前面還會寫「復原：開始」。重做本來就對（前進一格，那一格就是被重做的）。
   */
  undo() {
    if (!this.canUndo) return null;
    const undone = this.stack[this.index].label;
    this.index--;
    this._apply();
    return undone;
  }

  redo() {
    if (!this.canRedo) return null;
    this.index++;
    return this._apply();
  }

  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.stack.length - 1; }

  /** 下一次按復原會撤銷掉的那個動作叫什麼 */
  get undoLabel() { return this.canUndo ? this.stack[this.index].label : null; }
  get redoLabel() { return this.canRedo ? this.stack[this.index + 1].label : null; }

  /**
   * 執行一段不該被記錄的操作（例如套用快照時本身觸發的變動）。
   */
  silent(fn) {
    const prev = this._muted;
    this._muted = true;
    try { return fn(); } finally { this._muted = prev; }
  }

  _snapshot() {
    return JSON.stringify(this._get());
  }

  _apply() {
    const entry = this.stack[this.index];
    this.silent(() => this._set(JSON.parse(entry.state)));
    this._fire();
    return entry.label;
  }

  _fire() {
    if (this.onChange) this.onChange(this);
  }

  /** 記憶體用量估算，除錯用 */
  get bytes() {
    return this.stack.reduce((s, e) => s + e.state.length, 0);
  }
}
