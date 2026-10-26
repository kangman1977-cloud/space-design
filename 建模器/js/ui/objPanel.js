/**
 * objPanel.js — 「匯出 OBJ」視窗（網格核心第五批 a，2026-10-23 → `規格\建模器-網格核心.md` 第 8 節）。
 *
 * 給 Blender、Rhino、SketchUp 用。數學在 `out/obj.js` `toOBJ()`；這裡只決定**寫哪些物件、什麼樣子**：
 * · 有選就只匯出選到的、沒選就全部（跟展開圖一樣）；
 * · 照**畫面上看到的樣子** —— 開放的網格有厚度就加厚（跟 `scene.js` 畫面用同一個判斷 `shellThickness()`，⛔ 另寫一套）。
 * 選項（單位、多邊形／三角形、指定存放位置）記在這個瀏覽器（跟匯出 STL 一樣），預設 mm、多邊形照原樣。
 */
import { toOBJ, OBJ_UNITS } from '../out/obj.js';
import { saveBlob, textBlob, safeName, TYPES } from '../out/save.js';

const LS_KEY = 'modeler_exportobj';

export class ObjPanel {
  constructor(app) {
    this.app = app;
    this.opt = { unit: 'mm', triangulate: false, askPath: true, ...loadOpt() };
    if (!OBJ_UNITS[this.opt.unit]) this.opt.unit = 'mm';
    this._build();
  }

  _build() {
    const el = document.createElement('div');
    el.id = 'objWin';
    el.className = 'uwWin';
    el.hidden = true;
    el.innerHTML = `
      <div class="uwBack"></div>
      <div class="uwBox">
        <div class="uwHead">
          <b>匯出 OBJ</b>
          <span class="uwSum" id="obSum"></span>
          <button class="mini" id="obClose" title="關閉：關掉這個視窗、回到 3D 畫面（設定會記住）">關閉</button>
        </div>
        <div class="uwBar">
          <span class="lbl">單位</span><select id="obUnit"></select>
          <span class="lbl">面</span><select id="obTri" title="面：多邊形照原樣（建議），或全部拆成三角形（給只認三角形的軟體）">
            <option value="0">多邊形照原樣（建議）</option>
            <option value="1">全部拆成三角形（給只認三角形的軟體）</option>
          </select>
          <label class="uwCk" title="存檔時跳「另存新檔」讓你選資料夾"><input type="checkbox" id="obAsk"> 指定存放位置</label>
          <span class="sp"></span>
          <button id="obGo" title="存 OBJ：照上面的單位與面存成 OBJ 檔">存 OBJ</button>
        </div>
        <div class="uwBody" id="obBody"></div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    const $ = id => el.querySelector('#' + id);
    this.body = $('obBody');
    this.sum = $('obSum');
    const unit = $('obUnit');
    for (const k of Object.keys(OBJ_UNITS)) {
      const o = document.createElement('option');
      o.value = k; o.textContent = OBJ_UNITS[k].label;
      unit.appendChild(o);
    }
    unit.value = this.opt.unit;
    unit.title = 'OBJ 檔本身沒有單位欄位，這裡選的單位會寫在檔頭註解。Blender 讀 OBJ 把 1 當 1 公尺 ⇒ 給 Blender 用選 m';
    unit.onchange = () => { this.opt.unit = unit.value; this.run(); };
    const tri = $('obTri');
    tri.value = this.opt.triangulate ? '1' : '0';
    tri.onchange = () => { this.opt.triangulate = tri.value === '1'; this.run(); };
    const ask = $('obAsk');
    ask.checked = !!this.opt.askPath;
    ask.onchange = () => { this.opt.askPath = ask.checked; saveOpt(this.opt); };
    $('obGo').onclick = () => this._save();
    $('obClose').onclick = () => this.close();
    el.querySelector('.uwBack').onclick = () => this.close();
  }

  open() { this.el.hidden = false; this.run(); }
  close() { this.el.hidden = true; }
  get isOpen() { return !this.el.hidden; }

  /** 要寫的物件：有選就只寫選到的、沒選就全部；照畫面上的樣子（開放的網格有厚度就加厚）*/
  _items() {
    const picked = this.app.sel.objects;
    const objs = picked.length ? picked : this.app.doc.objects;
    return objs.map(o => {
      let mesh = o.smoothMesh(), shelled = false;     // 第八批 8a：有平滑細分的照平滑後的（kang「⑤ 量測列印剖面看平滑後」）
      const t = this.app.view.shellThickness(o);
      if (t > 0) { try { mesh = o.sheetShell(mesh, t); shelled = true; } catch (e) { /* 加厚失敗就照原樣寫 */ } }   // 第三輪第一批 ③：跟畫面同一支
      return { name: o.name, mesh, matrix: o.matrix(), shelled, obj: o };
    });
  }

  run() {
    saveOpt(this.opt);
    const items = this._items();
    const r = toOBJ(items, this.opt);
    this.result = r;
    const all = this.app.doc.objects.length;
    const only = this.app.sel.objects.length && items.length < all ? `只匯出選到的 ${items.length} 個（共 ${all} 個；沒選東西就是全部）　` : '';
    this.sum.textContent = r.objects ? `${only}${r.objects} 個物件、${r.verts} 個點、${r.faces} 個面　單位 ${r.unit}` : '沒有可以匯出的東西';
    this.body.innerHTML = '';
    const note = (msg, cls = 'uwSkip') => { const d = document.createElement('div'); d.className = cls; d.textContent = msg; this.body.appendChild(d); };
    note('OBJ 是給 Blender、Rhino、SketchUp 這類軟體用的。多邊形照原樣寫（有洞的面照它的小面寫），標了平滑的曲面寫成平滑群組。Y 朝上。');
    note('Blender：讀 OBJ 把 1 當 1 公尺 ⇒ 請把上面的單位選成 m。Rhino：匯入時選「OBJ 的 Y 當 Rhino 的 Z」。SketchUp：匯入時選跟這裡一樣的單位。');
    note('不會帶出去：切開／折的標記、不准切、參數（尺寸）、做法歷程 —— 業界的軟體看不懂，這些留在專案檔。');
    for (const it of items) {
      const m = it.mesh;
      note(`「${it.name}」${m.faces.length} 個面${it.shelled ? '（照畫面上的樣子加厚）' : ''}`);
    }
  }

  async _save() {
    if (!this.result || !this.result.objects) return;
    const items = this._items();
    const r = toOBJ(items, { ...this.opt, date: new Date().toISOString().slice(0, 10) });
    const base = items.length === 1 ? safeName(items[0].name, '模型') : safeName(this.app.head && this.app.head.name, '模型');
    await saveBlob(textBlob(r.text, 'model/obj'), `${base}.obj`, TYPES.obj, this.opt.askPath);
  }
}

function loadOpt() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch (e) { return {}; }
}
function saveOpt(o) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) { /* 無所謂 */ }
}
