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
    note: '折不了，所有折線一律變成切割線，各片分開下料再組裝',
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
export const DEFAULT_MATERIAL = 'steel';

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
