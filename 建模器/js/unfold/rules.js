/**
 * rules.js — 材料規則
 *
 * ── 這個檔案在整個展開架構的哪一層 ──────────────────
 *
 *   ┌─ 材料規則（就是這個檔案，各材料互不相干）──────┐
 *   │  哪裡能折？補償多少？餘量？檢查什麼？           │
 *   └────────────────┬───────────────────────────────┘
 *                    │ 只把「規則」傳下去
 *   ┌────────────────▼───────────────────────────────┐
 *   │  幾何核心 flatten.js（完全不知道材料是什麼）    │
 *   │  區域合併 → 曲面分類 → 攤平 → 重疊偵測 → 分片   │
 *   └────────────────────────────────────────────────┘
 *
 * **判準**：這段邏輯需不需要知道材料是什麼？需要就寫在這裡，
 * 不需要就留在 flatten.js。
 *
 * 新增第五、第六種材料 ＝ 在 MATERIALS 多加一筆，
 * 幾何核心一行都不用動。這是「規則分開、幾何共用」原則的實作。
 *
 * ── 每個規則要回答四個問題 ──────────────────────────
 *   canFold(angleDeg)        這個角度折得起來嗎？折不起來就切開
 *   allowance(angleDeg, ri, t)  這一道折彎在展開圖上佔多長
 *   margin()                 每一片的外圍要放多少餘量（縫份、黏合片）
 *   validate(piece, t)       出圖前的檢查，回傳警告訊息陣列
 *
 * 單位一律 cm。
 */

import { neutralRadius } from '../build/prim.js';

const RAD = Math.PI / 180;

/**
 * 材料表。
 *
 * ── K 因子哪來的 ────────────────────────────────────
 * 折彎時外側被拉長、內側被壓縮，中間有一層長度不變，叫中性層。
 * K 就是中性層落在板厚的幾成（從內側量起）。
 * 這裡放的是各材料的**業界典型值**，實際要多少跟模具開口寬度、
 * 折彎方式都有關，所以面板上一定要能改 —— 值寫死等於騙人。
 *
 * ── 最小折邊哪來的 ──────────────────────────────────
 * 折邊太短的話夾不住、折不出來。經驗值是「內側R ＋ 板厚 ＋ 模具半開口」，
 * 模具開口一般取 8 倍板厚，所以簡化成 ri + t + 4t。
 * 這是**警告**不是禁止 —— 有些廠有特殊模具做得到。
 */
export const MATERIALS = {
  steel: {
    label: '鐵板／鍍鋅鋼板',
    k: 0.40,
    foldable: true,
    note: '軟鋼。防護罩、機箱、料槽最常用',
    minFlange: (ri, t) => ri + 5 * t
  },
  stainless: {
    label: '不鏽鋼',
    k: 0.45,
    foldable: true,
    note: '比軟鋼硬，回彈大，中性層比較靠外',
    minFlange: (ri, t) => ri + 6 * t
  },
  aluminum: {
    label: '鋁板',
    k: 0.35,
    foldable: true,
    note: '較軟，中性層比較靠內。折彎半徑太小會裂',
    minFlange: (ri, t) => ri + 4 * t,
    minRadius: (t) => t          // 鋁的內R 建議至少等於板厚，否則外側會裂
  },
  canvas: {
    label: '帆布／軟膜',
    k: 0.50,
    foldable: true,
    note: '軟料，中性層就在正中間。裁片外圍要放縫份',
    seam: 1.5,                   // 縫份 cm
    minFlange: () => 0
  },
  acrylic: {
    label: '壓克力／木板',
    k: 0.50,
    foldable: false,             // ★ 不能折：所有折線強制轉成切割線
    rollable: false,             // ★ 捲不起來：展開長走弦長，不做圓弧修正
    note: '折不了也捲不起來，所有折線一律變成切割線，各片分開下料再組裝',
    minFlange: () => 0
  },
  /**
   * 珍珠板／發泡板／薄木板 —— kang 他們的主力材料。
   *
   * 這一筆的存在，是為了表達一個前五種都表達不出來的組合：
   * **折得起來，但捲不起來。**
   *
   *   foldable: true   銑一道 45 度 V 溝（留薄皮）就折得起來，保持一整片
   *   rollable: false  板子捲不圓。網格上的「圓弧」對它而言
   *                    就是一圈實際要切的平板，長度是弦長不是弧長
   *
   * 前五種都沒有這個組合：金屬與帆布兩者皆可，壓克力／木板兩者皆否。
   * 少了這一筆，做角柱會被當成滾圓，展開長往多錯 4～11%。
   *
   * K 因子對它沒有意義 —— V 溝折是尖角，外皮長度不變，
   * 不存在中性層被拉伸的問題。留 0.5 只是因為欄位要有值。
   */
  foamboard: {
    label: '珍珠板／發泡板／薄木板',
    k: 0.50,
    foldable: true,
    rollable: false,
    note: '銑 45 度 V 溝可折，保持一整片；捲不起來，所以展開長走外皮弦長',
    minFlange: () => 0
  },
  paper: {
    label: '紙模打樣',
    k: 0.50,
    foldable: true,
    note: '折線保留成壓線，外圍自動加黏合片',
    tab: 1.0,                    // 黏合片寬度 cm
    minFlange: () => 0
  }
};

export const MATERIAL_KEYS = Object.keys(MATERIALS);

/**
 * 預設材質 ＝ 珍珠板／發泡板。
 *
 * 2026-08-22 從 `steel` 改過來。理由是這套工具實際的使用者做的是
 * 紙材、發泡板、珍珠板、木板、壓克力，**一種金屬都不用**。
 * 預設值錯了，最常見的操作就是最容易出錯的操作 ——
 * 拿預設的金屬去展開角柱，會被當成滾圓、展開長往多錯 4～11%。
 *
 * 金屬三種刻意保留，因為規則本身是對的，日後外發或混用時還用得到。
 */
export const DEFAULT_MATERIAL = 'foamboard';

/**
 * 做出一份規則物件交給 flatten.js。
 *
 * flatten.js 只會呼叫這四個方法，不會去讀 MATERIALS，
 * 所以之後就算材料表整個換掉，幾何核心也不受影響。
 *
 * @param {string} key      MATERIALS 的鍵
 * @param {number} t        板厚 cm
 * @param {object} override 使用者在面板上的覆寫，目前支援 { k }
 */
export function makeRule(key, t = 0.2, override = {}) {
  const M = MATERIALS[key] || MATERIALS[DEFAULT_MATERIAL];
  const k = Number.isFinite(+override.k) ? +override.k : M.k;
  const thick = Math.max(0, +t || 0);

  return {
    key: MATERIALS[key] ? key : DEFAULT_MATERIAL,
    label: M.label,
    note: M.note,
    k,
    thickness: thick,
    foldable: M.foldable,

    /**
     * 這個材料捲得起來嗎？
     *
     * 🔴 **⛔ 這個欄位已經不影響任何尺寸，而且不准再影響。**
     * 〔kang 2026-08-23 定調〕
     *
     *     **展開尺寸 ＝ 網格攤平後的總和。與材料無關。**
     *
     * ── 它以前做什麼（已作廢）───────────────────────────
     * `flatten.js` 的 `arcCorrection()` 會問它，捲得起來就把弦長
     * 拉成弧長。理由是「網格上的小面到底是離散化的產物還是實際要切的
     * 平板，幾何分不出來，只有材料分得出來」。
     *
     * ── 為什麼作廢（理由比結論重要）─────────────────────
     * 那個問題**問錯了**。模型就是網格，網格裡沒有曲面 ——
     * seg 段的「圓柱」在網格裡就是一根 seg 邊柱，
     * 它的展開寬度就是 seg 片平板相加。不需要分辨「代表什麼」，
     * 因為那些小面**就是**這個模型本身。
     *
     * 而錯的理由會傳染：它讓同一個模型換個材料就換尺寸，
     * 於是圖上沒有一個數字有單一意義。
     *
     * 想要更接近真正的圓 → **把 seg 開高**，那是建模階段的決定。
     *
     * ── 那軟性材料的伸長怎麼辦 ──────────────────────────
     * 那是**疊在真值之上的獨立一層**，像 `margin()` 那樣
     * 「圖上未含 X cm，下料時另加」—— 真值歸真值、補償歸補償。
     * **那一層目前不存在，而且刻意不預先開鉤子。**
     *
     * ── 欄位為什麼還留著 ────────────────────────────────
     * 材料表本身仍然需要描述「這個材料捲不捲得起來」（那是事實），
     * 而且拿掉欄位要動一票測試與 v4 舊檔相容 ——
     * 「為了整齊去改能用的東西，不划算」。
     * **但幾何核心已經一行都不問它了**（`flatten.js` 檔頭有清單）。
     */
    canRoll: M.rollable !== false,

    /**
     * 這個角度折得起來嗎？
     * 壓克力與木板一律折不起來 —— 這不是「補償多少」的問題，
     * 而是折線根本要變成切割線，展開圖上的線型與 DXF 圖層都不一樣。
     */
    canFold(angleDeg) {
      if (!M.foldable) return false;
      return Math.abs(angleDeg) > 0.5 && Math.abs(angleDeg) < 179.5;
    },

    /**
     * 一道折彎在展開圖上佔的長度（bend allowance）。
     *     BA = θ × (ri + K × t)
     * 跟 prim.js 的 bendAllowance 是同一條公式，
     * 差別只在這裡的 K 來自材料表、可被面板覆寫。
     */
    allowance(angleDeg, ri) {
      return Math.abs(angleDeg) * RAD * neutralRadius(ri, k, thick);
    },

    /** 中性層半徑，畫展開圖標註要用 */
    neutral(ri) { return neutralRadius(ri, k, thick); },

    /**
     * 每一片外圍的餘量：帆布是縫份、紙模是黏合片，鈑金是 0。
     * 幾何核心拿到的就只是一個數字，不必知道它叫縫份還是黏合片。
     */
    margin() {
      return M.seam || M.tab || 0;
    },

    /** 餘量是什麼東西，畫圖時要標字用 */
    marginLabel() {
      if (M.seam) return '縫份';
      if (M.tab) return '黏合片';
      return '';
    },

    /**
     * 出圖前的檢查。回傳警告字串陣列（空陣列＝沒問題）。
     *
     * 這裡只回報，不擋 —— 現場常有特殊模具或特殊做法，
     * 程式沒有資格替師傅決定做不做得出來。
     */
    validate(piece) {
      const out = [];
      if (!piece) return out;

      /**
       * 同一種問題只講一次，帶上處數與**最嚴重的那一道**。
       *
       * 原本是逐道折彎各推一則。31 道折彎的錐面實測會吐出
       * 31 行一模一樣的「折邊只有 0cm」，把真正要緊的警告整個淹掉 ——
       * 看的人只會學會忽略這一欄，那這一欄就等於不存在。
       *
       * 保留最嚴重的那一道而不是平均值：師傅要知道的是最糟會糟到哪裡。
       */
      const worst = new Map();
      const keep = (key, bad, msg) => {
        const hit = worst.get(key);
        if (!hit) { worst.set(key, { n: 1, bad, msg }); return; }
        hit.n++;
        if (bad < hit.bad) { hit.bad = bad; hit.msg = msg; }
      };

      for (const b of (piece.bends || [])) {
        const ri = b.ri ?? 0;

        // 圓弧折彎不必問「折得起來嗎」—— 它是滾出來的，
        // 一段一段慢慢彎，總角度 360° 的圓筒照樣做得出來。
        // canFold 問的是「一刀折下去」那種尖角折。
        if (!b.isArc && !this.canFold(b.angle)) {
          keep('fold', Math.abs(b.angle),
            `${M.label}折不了 ${fmt(b.angle)}°，這條已改成切割線`);
          continue;
        }
        if (M.minRadius && ri > 0 && ri < M.minRadius(thick) - 1e-9) {
          keep('radius', ri,
            `內側 R${fmt(ri)} 小於建議的 R${fmt(M.minRadius(thick))}（${M.label}折太小會裂）`);
        }
        const need = M.minFlange(ri, thick);
        if (b.flange !== undefined && need > 0 && b.flange < need - 1e-9) {
          keep('flange', b.flange,
            `折邊只有 ${fmt(b.flange)}cm，短於建議的 ${fmt(need)}cm，可能夾不住`);
        }
      }

      for (const h of worst.values()) {
        out.push(h.n > 1 ? `${h.msg}（共 ${h.n} 道，這是最嚴重的一道）` : h.msg);
      }

      if (thick <= 0) out.push('板厚是 0，折彎補償會全部算成 0');
      return out;
    }
  };
}

const fmt = v => (Math.round(v * 100) / 100).toString();
