// src/lib/trend-signal/config.ts — Trend Signal Pro 參數：指標設定視窗的
// 數值參數（ParamDef）⇄ 分模組的引擎設定，以及計算版本與各模組的參數指紋。

import type { ParamDef } from '../indicator-defs';
import type { EntryMode, EntryParams, NoteParams, RiskConfig, TrendAlgoId, TrendParams, TrendSignalConfig } from './types';

export const TSP_TYPE = 'trend-signal-pro';
/** 計算規則版本：改動任何訊號／進場／風控規則都要升版，舊 ID 才不會混淆。
 *  1.1.0：TrendCore 四態（含 NEUTRAL）與 Donchian＋ATR、整段趨勢的多次 1m 提示（V1.1）
 *  1.1.1：缺分鐘的 5m 不參與計算、5m 桶內缺分鐘後的 1m 不提示、即時資料以涵蓋判定已收並凍結
 *  1.1.2：停用重啟重設接收涵蓋、心跳不推進資料確認、補抓回應順序與多口進場稅分配修正 */
export const TSP_ALGO_VERSION = 'tsp-1.1.2';

/** V1 交易權限：只觀察。啟用任何發單能力需另行授權（規格 §0.5） */
export const TSP_PERMISSIONS = {
    read_only: true,
    auto_entry: false,
    auto_exit: false,
} as const;

export const TREND_ALGOS: TrendAlgoId[] = ['supertrend', 'donchian', 'kama'];
export const ENTRY_MODES: EntryMode[] = ['IMMEDIATE', 'MICRO_TREND', 'PRICE_STRUCTURE', 'PULLBACK_KD'];

// 設定視窗依此順序顯示；前綴說明參數屬於哪個模組
export const TSP_PARAMS: ParamDef[] = [
    { key: 'algo', label: '趨勢｜演算法（0 SuperTrend／1 Donchian／2 KAMA）', def: 0, min: 0, max: 2 },
    { key: 'stPeriod', label: '趨勢｜SuperTrend ATR 週期', def: 10, min: 1, max: 100 },
    { key: 'stMult', label: '趨勢｜SuperTrend 倍數（靈敏度，小＝快）', def: 3, min: 0.5, max: 10, step: 0.5 },
    { key: 'dcLength', label: '趨勢｜Donchian 突破週期', def: 20, min: 2, max: 200 },
    { key: 'dcAtrMult', label: '趨勢｜Donchian ATR 追蹤帶倍數（觸及＝趨勢失效）', def: 3, min: 0.5, max: 10, step: 0.5 },
    { key: 'kamaLength', label: '趨勢｜KAMA 效率比週期', def: 10, min: 2, max: 100 },
    { key: 'kamaFast', label: '趨勢｜KAMA 快速常數', def: 2, min: 1, max: 50 },
    { key: 'kamaSlow', label: '趨勢｜KAMA 慢速常數', def: 30, min: 2, max: 200 },
    { key: 'kamaHyst', label: '趨勢｜KAMA 翻轉遲滯（× ATR14）', def: 0.3, min: 0, max: 3, step: 0.05 },
    { key: 'emaPeriod', label: '註記｜EMA 週期（只標示，不影響訊號）', def: 21, min: 2, max: 200 },
    { key: 'entryMode', label: '進場｜風控採用（0 IMMEDIATE／1 MICRO_TREND／2 PRICE_STRUCTURE／3 先前策略假說・未驗證 EMA9·VWAP·KD）', def: 0, min: 0, max: 3 },
    // V1.1 語義改變的參數換了鍵名：V1.0 已存實例的 windowBars=3（15 分鐘窗口）、microMult=1 不沿用
    { key: 'hintWindow', label: '進場｜提示範圍（0 整段 5m 趨勢／N 翻轉後 N 根 5m）', def: 0, min: 0, max: 20 },
    { key: 'microStMult', label: '進場｜1m 微型趨勢 SuperTrend 倍數', def: 3, min: 0.25, max: 10, step: 0.25 },
    { key: 'microDcLength', label: '進場｜1m 微型趨勢 Donchian 週期', def: 20, min: 2, max: 200 },
    { key: 'microKamaHyst', label: '進場｜1m 微型趨勢 KAMA 遲滯（× ATR14）', def: 0.3, min: 0, max: 3, step: 0.05 },
    { key: 'pivotLeft', label: '進場｜結構轉折左側 K 棒', def: 2, min: 1, max: 10 },
    { key: 'pivotRight', label: '進場｜結構轉折右側確認 K 棒', def: 2, min: 1, max: 10 },
    { key: 'minPullbackAtr', label: '進場｜最小回檔（× 1m ATR14）', def: 0.5, min: 0, max: 5, step: 0.05 },
    { key: 'budget', label: '風控｜每筆風險預算 NT$', def: 1000, min: 100, max: 1000000, step: 100 },
    { key: 'feePerSide', label: '風控｜單邊手續費 NT$/口', def: 12, min: 0, max: 1000 },
    { key: 'slipTicks', label: '風控｜滑價緩衝（tick/邊）', def: 1, min: 0, max: 20 },
    { key: 'qty', label: '風控｜計畫口數上限', def: 1, min: 1, max: 50 },
    { key: 'swingBars', label: '風控｜擺動高低點 K 棒數（1m）', def: 5, min: 3, max: 30 },
    { key: 'stopAtr', label: '風控｜初始停損 ATR 倍數（1m）', def: 1.5, min: 0.5, max: 5, step: 0.1 },
    { key: 'trailAtr', label: '風控｜移動停損 ATR 倍數（5m）', def: 1.2, min: 0.5, max: 5, step: 0.1 },
    { key: 'singleExit', label: '風控｜單口出場（1 追蹤／2 2R／3 3R）', def: 1, min: 1, max: 3 },
    { key: 'tierMode', label: '風控｜多口分配（0 規格表／1 自訂）', def: 0, min: 0, max: 1 },
    { key: 'tp2Lots', label: '風控｜自訂 2R 停利口數', def: 1, min: 0, max: 50 },
    { key: 'tp3Lots', label: '風控｜自訂 3R 停利口數', def: 1, min: 0, max: 50 },
];

/** legend 只顯示趨勢核心參數 */
export const TSP_LABEL_PARAMS = ['stPeriod', 'stMult'];

const DEFAULTS: Record<string, number> = Object.fromEntries(TSP_PARAMS.map((p) => [p.key, p.def]));

// 參數值超出範圍時夾回範圍內（設定視窗與 Agent 服務都已驗證，這裡是最後防線）
function param(p: Record<string, number>, key: string): number {
    const def = TSP_PARAMS.find((d) => d.key === key)!;
    const v = p[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return def.def;
    return Math.min(def.max, Math.max(def.min, v));
}
const int = (p: Record<string, number>, key: string) => Math.round(param(p, key));

export function configFromParams(p: Record<string, number> = {}): TrendSignalConfig {
    const trend: TrendParams = {
        algo: TREND_ALGOS[int(p, 'algo')] ?? 'supertrend',
        stPeriod: int(p, 'stPeriod'),
        stMult: param(p, 'stMult'),
        dcLength: int(p, 'dcLength'),
        dcAtrMult: param(p, 'dcAtrMult'),
        kamaLength: int(p, 'kamaLength'),
        kamaFast: int(p, 'kamaFast'),
        kamaSlow: int(p, 'kamaSlow'),
        kamaHyst: param(p, 'kamaHyst'),
    };
    const note: NoteParams = { emaPeriod: int(p, 'emaPeriod'), emaSlopeBars: 2, atrPeriod: 14, rsiPeriod: 14, keyBars: 20 };
    const entry: EntryParams = {
        mode: ENTRY_MODES[int(p, 'entryMode')] ?? 'IMMEDIATE',
        windowBars: int(p, 'hintWindow'),
        microMult: param(p, 'microStMult'),
        microDcLength: int(p, 'microDcLength'),
        microKamaHyst: param(p, 'microKamaHyst'),
        pivotLeft: int(p, 'pivotLeft'),
        pivotRight: int(p, 'pivotRight'),
        minPullbackAtr: param(p, 'minPullbackAtr'),
    };
    const singleExit = int(p, 'singleExit');
    const risk: RiskConfig = {
        budget: param(p, 'budget'),
        feePerSide: param(p, 'feePerSide'),
        slipTicks: int(p, 'slipTicks'),
        qty: int(p, 'qty'),
        swingBars: int(p, 'swingBars'),
        stopAtr: param(p, 'stopAtr'),
        trailAtr: param(p, 'trailAtr'),
        singleExit: singleExit === 2 ? 2 : singleExit === 3 ? 3 : 1,
        tierMode: int(p, 'tierMode') >= 1 ? 'custom' : 'auto',
        tp2Lots: int(p, 'tp2Lots'),
        tp3Lots: int(p, 'tp3Lots'),
    };
    return { trend, note, entry, risk };
}

export const DEFAULT_CONFIG: TrendSignalConfig = configFromParams(DEFAULTS);

/** 1m 微型趨勢：與 5m 同一個 TrendCore 演算法，只換各演算法的靈敏度參數（V1.1 §4）；
 *  其餘參數（ATR 週期、KAMA 週期、Donchian 追蹤帶倍數）沿用趨勢設定 */
export function microParams(cfg: TrendSignalConfig): TrendParams {
    return { ...cfg.trend, stMult: cfg.entry.microMult, dcLength: cfg.entry.microDcLength, kamaHyst: cfg.entry.microKamaHyst };
}

// FNV-1a 32-bit — 參數指紋只求穩定、短，不做安全用途
function fnv1a(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

function fingerprint(obj: object): string {
    const entries = Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return fnv1a(JSON.stringify(entries));
}

/** 訊號只由趨勢參數決定：ID 只帶趨勢參數的指紋，改進場或風控參數不改訊號 ID */
export const trendKey = (cfg: TrendSignalConfig) => `${TSP_ALGO_VERSION}#${fingerprint(cfg.trend)}`;
/** 每種進場模式都會計算；「風控採用哪一個」不影響事件本身，不進指紋 */
export const entryKey = (cfg: TrendSignalConfig) => {
    const { mode: _mode, ...rest } = cfg.entry;
    return fingerprint(rest);
};
export const riskKey = (cfg: TrendSignalConfig) => fingerprint(cfg.risk);
export const configKey = (cfg: TrendSignalConfig) => `${trendKey(cfg)}.${fingerprint(cfg.note)}.${entryKey(cfg)}.${riskKey(cfg)}`;
