/**
 * threemf.js — 3MF 匯出（2026-10-24，第二輪第四批；kang「3MF 多一個格式、預設照舊 STL」→ `規格\建模器-STL匯出.md`）
 *
 * 為什麼多這個格式（`外部參考-3D列印與剖面分切.md` 第 6 節）：
 * - **檔案裡寫了單位**（`unit="millimeter"`）⇒ ⛔ 再猜「mm 還是 cm」（STL 沒有單位欄位，選錯會小十倍）
 * - **一個檔多個物件、各有名字** ⇒ 合成一個檔時切片軟體還分得出哪個是哪個
 * - 規格要求封閉、方向一致 —— 跟列印前檢查要的一樣
 *
 * 3MF ＝ 一個 zip：`[Content_Types].xml`、`_rels/.rels`、`3D/3dmodel.model`（3MF Core 規格 1.x）。
 * zip 用「不壓縮」（store）自己寫 —— ⛔ 為了它多載一個壓縮函式庫；檔案大一點，切片軟體照樣讀。
 * 純計算、⛔ 碰畫面。
 */

/** 匯出單位 → 3MF 的 unit 屬性 */
export const UNIT_3MF = { mm: 'millimeter', cm: 'centimeter' };

/**
 * @param {{name:string, tris:{a,b,c}[]}[]} parts 每一個物件的三角形（已換成匯出單位、Z 朝上、擺好位置）
 * @param {{unit?:string}} opt `unit` ＝ `STL_UNITS` 的鍵（mm／cm）
 * @returns {Uint8Array} .3mf 檔的內容
 */
export function to3MF(parts, opt = {}) {
  const unit = UNIT_3MF[opt.unit] || 'millimeter';
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>\n',
    `<model unit="${unit}" xml:lang="zh-TW" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n`,
    ' <metadata name="Application">網頁空間設計程式 建模器</metadata>\n <resources>\n');
  parts.forEach((p, k) => {
    const at = new Map(), vs = [], tri = [];
    const id = v => {
      const key = `${num(v.x)} ${num(v.y)} ${num(v.z)}`;
      let i = at.get(key);
      if (i === undefined) { i = vs.length; at.set(key, i); vs.push(key); }
      return i;
    };
    for (const t of p.tris) {
      const a = id(t.a), b = id(t.b), c = id(t.c);
      if (a === b || b === c || c === a) continue;       // 寫成文字後重疊的點 ⇒ 退化，3MF ⛔ 允許
      tri.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
    }
    out.push(`  <object id="${k + 1}" type="model" name="${xmlEsc(p.name || `物件 ${k + 1}`)}">\n   <mesh>\n    <vertices>\n`);
    for (const key of vs) { const [x, y, z] = key.split(' '); out.push(`     <vertex x="${x}" y="${y}" z="${z}"/>\n`); }
    out.push('    </vertices>\n    <triangles>\n');
    for (const t of tri) out.push('     ', t, '\n');
    out.push('    </triangles>\n   </mesh>\n  </object>\n');
  });
  out.push(' </resources>\n <build>\n');
  parts.forEach((p, k) => out.push(`  <item objectid="${k + 1}"/>\n`));
  out.push(' </build>\n</model>\n');

  const enc = new TextEncoder();
  return zipStore([
    ['[Content_Types].xml', enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
      + '</Types>')],
    ['_rels/.rels', enc.encode('<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>'
      + '</Relationships>')],
    ['3D/3dmodel.model', enc.encode(out.join(''))]
  ]);
}

/** 座標寫成文字：最多 6 位小數、去掉尾巴的 0、⛔ 寫 -0 */
function num(v) {
  const s = (Math.round(v * 1e6) / 1e6).toString();
  return s === '-0' ? '0' : s;
}

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══ zip（不壓縮）═══

let CRC_TABLE = null;
export function crc32(bytes) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** @param {[string, Uint8Array][]} files @returns {Uint8Array} */
export function zipStore(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;   // 固定的日期（內容一樣 ⇒ 檔案一樣）
  for (const [name, data] of files) {
    const nm = enc.encode(name), crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, DOS_TIME, true); local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true);
    local.setUint16(26, nm.length, true); local.setUint16(28, 0, true);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true); cen.setUint16(12, DOS_TIME, true); cen.setUint16(14, DOS_DATE, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true);
    cen.setUint16(28, nm.length, true); cen.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), nm, data);
    central.push(new Uint8Array(cen.buffer), nm);
    offset += 30 + nm.length + data.length;
  }
  const cenSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const outBytes = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of all) { outBytes.set(c, o); o += c.length; }
  return outBytes;
}
