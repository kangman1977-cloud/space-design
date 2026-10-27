/**
 * layerPanel.js — 右側面板「圖層」那一頁的清單（圖層與群組 2a）
 *
 * 🔴 kang 2026-10-28「照建議」（→ `圖層與群組-設計方向.md`「第二批定案」、`規格\建模器-圖層與群組.md`「2a」）：
 *   每一層一列：展開、👁（關／開）、🔒（鎖／解）、顏色、名字（點 ＝ 換成「目前這一層」）、幾個物件、刪掉；
 *   展開後每個物件一列：👁、🔒（物件自己的藏、鎖 —— 跟第一批同一份）、名字（點 ＝ 選它，Shift 加選）。
 *   目前這一層⛔ 能關、鎖、刪（Rhino 也是）；刪有東西的那一層 ⇒ 列下面跳出「一起刪掉／移到『預設』／取消」（⛔ 用瀏覽器的確認框）。
 *   底下一排：＋新圖層、改名（目前這一層）、移到「目前這一層」（選到的）、這一層全部改用圖層顏色。
 *
 * 這一支只管「畫清單、把按下去的事交給 main.js」；改資料、記一步復原、重畫由 `h` 那幾支做（同一條：`app.onEdit()`）。
 */

/** 純算（測試直接叫）：清單上每一列要畫什麼 */
export function layerRows(doc, selIds = []) {
  const sel = new Set(selIds);
  return doc.layers.map(L => {
    const objs = doc.objects.filter(o => doc.layerOf(o) === L);
    return {
      id: L.id, name: L.name, color: L.color, off: L.off, locked: L.locked,
      current: L.id === doc.currentLayer, count: objs.length,
      objects: objs.map(o => ({ id: o.id, name: o.name, hidden: !!o.hidden, locked: !!o.locked, selected: sel.has(o.id), group: o.group ?? null }))
    };
  });
}

const hex = c => '#' + (c >>> 0).toString(16).padStart(6, '0');

export class LayerPanel {
  /**
   * @param {Element} box 清單放哪（面板那一頁、或拉出來的浮動視窗）
   * @param {object} h { doc, sel, edit(label, fn), setCurrent(id), pick(id, add), toast(msg, bad) }
   */
  constructor(box, h) {
    this.box = box;
    this.h = h;
    this.open = new Set();          // 展開的那幾層（⛔ 存：開頁全部收著 ⇒ 物件很多也⛔ 擠）
    this.renaming = false;
    this.asking = null;             // 正在問「這一層有東西，要怎麼刪」的那一層 id
  }

  render() {
    const { doc, sel } = this.h;
    const rows = layerRows(doc, sel.ids);
    const b = this.box;
    b.innerHTML = '';
    for (const r of rows) {
      const row = el('div', 'lyRow' + (r.current ? ' cur' : ''));
      row.dataset.layer = r.id;
      const tw = btn('lyTw', this.open.has(r.id) ? '▾' : '▸', '展開／收起：列出這一層的物件');
      tw.onclick = () => { this.open.has(r.id) ? this.open.delete(r.id) : this.open.add(r.id); this.render(); };
      const eye = btn('lyIc' + (r.off ? ' off' : ''), '👁', r.current ? '目前這一層不能關（先點別一層當目前這一層）' : (r.off ? '打開這一層（看得到、點得到）' : '關掉這一層：這一層的物件看不到、點不到，沒選東西出圖時不算'));
      eye.disabled = r.current;
      eye.onclick = () => this.h.edit(r.off ? `打開圖層「${r.name}」` : `關掉圖層「${r.name}」`, () => { doc.layerById(r.id).off = !r.off; });
      const lk = btn('lyIc' + (r.locked ? ' lockOn' : ' off'), '🔒', r.current ? '目前這一層不能鎖（先點別一層當目前這一層）' : (r.locked ? '解開這一層' : '鎖住這一層：這一層的物件看得到（半透明）、點不到'));
      lk.disabled = r.current;
      lk.onclick = () => this.h.edit(r.locked ? `解開圖層「${r.name}」` : `鎖住圖層「${r.name}」`, () => { doc.layerById(r.id).locked = !r.locked; });
      const col = document.createElement('input');
      col.type = 'color'; col.className = 'lyCol'; col.value = hex(r.color);
      col.title = '這一層的顏色：物件的顏色選「跟圖層」才會用到';
      col.onchange = () => this.h.edit(`改圖層「${r.name}」的顏色`, () => { doc.layerById(r.id).color = parseInt(col.value.slice(1), 16); });
      let nm;
      if (r.current && this.renaming) {
        nm = document.createElement('input');
        nm.className = 'lyName'; nm.value = r.name;
        const done = ok => {
          if (!this.renaming) return;
          this.renaming = false;
          const v = nm.value.trim();
          if (ok && v && v !== r.name) this.h.edit(`圖層改名「${v}」`, () => { doc.layerById(r.id).name = v; });
          else this.render();
        };
        nm.onkeydown = e => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
        nm.onblur = () => done(true);
        setTimeout(() => { nm.focus(); nm.select(); }, 0);
      } else {
        nm = el('span', 'lyName', r.name);
        nm.title = r.current ? '目前這一層：新做的物件放這裡' : '點一下：換成「目前這一層」（新做的物件放這裡）';
        nm.onclick = () => this.h.setCurrent(r.id);
      }
      const ct = el('span', 'lyCt', String(r.count));
      row.append(tw, eye, lk, col, nm, ct);
      if (r.current) row.append(el('span', 'lyCur', '目前'));
      else {
        const del = btn('lyDel', '✕', '刪掉這一層（有物件的話先問要一起刪還是移到「預設」）');
        del.onclick = () => {
          if (!r.count) { this.h.edit(`刪掉圖層「${r.name}」`, () => doc.removeLayer(r.id, 'move')); return; }
          this.asking = this.asking === r.id ? null : r.id; this.render();
        };
        row.append(del);
      }
      b.appendChild(row);
      if (this.asking === r.id) {
        const q = el('div', 'lyAsk', `「${r.name}」有 ${r.count} 個物件：`);
        const a1 = btn('mini', '一起刪掉', '這一層和裡面的物件一起刪（按 Ctrl+Z 收得回來）');
        a1.onclick = () => { this.asking = null; this.h.edit(`刪掉圖層「${r.name}」和 ${r.count} 個物件`, () => doc.removeLayer(r.id, 'delete')); };
        const a2 = btn('mini', '移到「預設」', '只刪這一層，物件移到「預設」那一層（沒有「預設」就移到第一層）');
        a2.onclick = () => { this.asking = null; this.h.edit(`刪掉圖層「${r.name}」（物件移走）`, () => doc.removeLayer(r.id, 'move')); };
        const a3 = btn('mini', '取消', '不刪');
        a3.onclick = () => { this.asking = null; this.render(); };
        q.append(a1, a2, a3);
        b.appendChild(q);
      }
      if (!this.open.has(r.id)) continue;
      /**
       * 群組 2b：同一組的排在一起、上面一列「🔗 群組 N（幾個）」—— 點它 ＝ 整組選起來（組裡的那幾列點名字 ＝ 只選那一個）。
       * 一組跨好幾層時每一層各列它在這一層的那幾個。
       */
      const ordered = [], seenG = new Set();
      for (const o of r.objects) {
        if (o.group === null) { ordered.push(o); continue; }
        if (seenG.has(o.group)) continue;
        seenG.add(o.group);
        ordered.push({ head: o.group, n: doc.groupMembers(o.group).length });
        for (const m of r.objects) if (m.group === o.group) ordered.push({ ...m, inGrp: true });
      }
      for (const o of ordered) {
        if (o.head !== undefined) {
          const gr = el('div', 'lyObj lyGrp');
          const gn = el('span', 'lyName', `🔗 群組 ${o.head}（${o.n} 個）`);
          gn.title = '點一下：整組選起來（一組可以跨好幾層，這裡只列在這一層的）';
          gn.onclick = () => this.h.pickGroup(o.head);
          gr.append(gn);
          b.appendChild(gr);
          continue;
        }
        const orow = el('div', 'lyObj' + (o.inGrp ? ' inGrp' : '') + (o.selected ? ' sel' : '') + (o.hidden || o.locked || r.off || r.locked ? ' dim' : ''));
        const oe = btn('lyIc' + (o.hidden ? ' off' : ''), '👁', o.hidden ? '拿回來（看得到、點得到）' : '藏起來（跟「顯示」那一組的藏起來同一件事）');
        oe.onclick = () => this.h.edit(o.hidden ? `拿回「${o.name}」` : `藏起來「${o.name}」`, () => { const x = doc.byId(o.id); x.hidden = !o.hidden; if (!x.hidden) x.isoHidden = false; });
        const ol = btn('lyIc' + (o.locked ? ' lockOn' : ' off'), '🔒', o.locked ? '解開' : '鎖住（看得到、點不到）');
        ol.onclick = () => this.h.edit(o.locked ? `解開「${o.name}」` : `鎖住「${o.name}」`, () => { doc.byId(o.id).locked = !o.locked; });
        const on = el('span', 'lyName', o.name);
        on.title = '點一下：選它（按著 Shift 加選）；藏起來、鎖住、在關掉或鎖住的圖層裡的選不到';
        on.onclick = e => this.h.pick(o.id, e.shiftKey);
        orow.append(oe, ol, on);
        b.appendChild(orow);
      }
    }
    // 底下一排
    const bar = el('div', 'lyBtns');
    const add = btn('mini', '＋新圖層', '新增一層、並換成「目前這一層」（加在最下面）');
    add.onclick = () => this.h.edit('新增圖層', () => { const L = doc.addLayer(); doc.currentLayer = L.id; });
    const ren = btn('mini', '改名', '改「目前這一層」的名字（打完按 Enter）');
    ren.onclick = () => { this.renaming = true; this.render(); };
    const n = sel.ids.length, cur = doc.layerById(doc.currentLayer);
    const mv = btn('mini', `移到「${cur ? cur.name : ''}」`, '把選到的物件移到「目前這一層」');
    mv.disabled = !n;
    mv.onclick = () => this.h.edit(`移到圖層「${cur.name}」（${n} 個）`, () => { for (const id of sel.ids) { const o = doc.byId(id); if (o) o.layer = cur.id; } });
    const byL = btn('mini', '這一層全部用圖層顏色', '「目前這一層」的物件顏色全部改成「跟圖層」（物件自己的顏色留著，面板上改回「自己的」就回來）');
    byL.onclick = () => this.h.edit(`「${cur.name}」全部用圖層顏色`, () => { for (const o of doc.objects) if (doc.layerOf(o) === cur) o.colorByLayer = true; });
    bar.append(add, ren, mv, byL);
    b.appendChild(bar);
  }
}

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function btn(cls, text, title) { const e = el('button', cls, text); e.type = 'button'; if (title) e.title = title; return e; }
