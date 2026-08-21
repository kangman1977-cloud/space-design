/**
 * history.js — Undo / Redo
 *
 * 用「整份快照」的方式做，不是記錄每個動作的反向操作。
 *
 * ── 為什麼選快照 ────────────────────────────────────
 * 反向操作省記憶體，但每加一個新功能就要多寫一個對應的「反做」，
 * 漏掉一個就會出現「復原之後檔案壞掉」這種最難查的錯。
 * 快照笨一點，但永遠不會錯 —— 而且我們的模型是幾百 KB 的等級，
 * 存 60 步也才幾十 MB，划算。
 *
 * 如果哪天模型大到快照吃不消，再換成差異式，介面不用改。
 */

export class History {
  /**
   * @param {object} io
   * @param {() => any} io.get 取得目前狀態（要能被 JSON 序列化）
   * @param {(state:any) => void} io.set 套用狀態
   * @param {number} [io.limit=60] 最多記幾步
   */
  constructor({ get, set, limit = 60 }) {
    this._get = get;
    this._set = set;
    this.limit = limit;
    this.stack = [];
    this.index = -1;
    this._muted = false;
    this.onChange = null;      // 由介面掛上去，用來更新按鈕的可按狀態
  }

  /** 記錄起始狀態。載入新檔或重設場景後呼叫。 */
  reset(label = '開始') {
    this.stack = [{ label, state: this._snapshot() }];
    this.index = 0;
    this._fire();
  }

  /**
   * 把「現在」記成一步。
   * 在動作完成之後呼叫，label 寫使用者看得懂的話（會顯示在介面上）。
   */
  commit(label) {
    if (this._muted) return;

    // 走過 undo 之後又做了新動作 → 砍掉前面那條分岔
    if (this.index < this.stack.length - 1) {
      this.stack.length = this.index + 1;
    }

    this.stack.push({ label, state: this._snapshot() });

    if (this.stack.length > this.limit) {
      this.stack.shift();
    }
    this.index = this.stack.length - 1;
    this._fire();
  }

  undo() {
    if (!this.canUndo) return null;
    this.index--;
    return this._apply();
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
