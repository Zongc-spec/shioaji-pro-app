// src/lib/trend-signal/config.ts — Trend Signal Pro 參數：指標設定視窗的
// 數值參數（ParamDef）⇄ 引擎設定，以及計算版本與設定指紋（訊號 ID 用）。

import type { ParamDef } from '../indicator-defs';
import type { TrendSignalConfig } from './types';

export const TSP_TYPE = 'trend-signal-pro';
/** 計算規則版本：改動任何訊號／風控規則都要升版，舊訊號 ID 才不會混淆 */
export const TSP_ALGO_VERSION = 'tsp-1.0.0';

/** V1 交易權限：只觀察。啟用任何發單能力需另行授權（規格 §0.5） */
export const TSP_PERMISSIONS = {
    read_only: true,
    auto_entry: false,
    auto_exit: false,
} as const;

// 設定視窗依此順序顯示；前綴說明參數屬於哪個週期
export const TSP_PARAMS: ParamDef[] = [
    { key: 'stPeriod', label: '5m｜SuperTrend ATR 週期', def: 10, min: 1, max: 100 },
    { key: 'stMult', label: '5m｜SuperTrend 倍數', def: 3, min: 0.5, max: 10, step: 0.5 },
    { key: 'emaPeriod', label: '5m｜EMA 週期', def: 21, min: 2, max: 200 },
    { key: 'atrPeriod', label: '5m｜ATR 週期（移動停損）', def: 14, min: 1, max: 100 },
    { key: 'candidateBars', label: '5m｜候選有效 K 棒數', def: 3, min: 1, max: 20 },
    { key: 'ema1m', label: '1m｜EMA 週期', def: 9, min: 2, max: 100 },
    { key: 'kdPeriod', label: '1m｜KD RSV 週期', def: 9, min: 1, max: 100 },
    { key: 'kdK', label: '1m｜KD K 平滑', def: 3, min: 1, max: 50 },
    { key: 'kdD', label: '1m｜KD D 平滑', def: 3, min: 1, max: 50 },
    { key: 'touchTol', label: '1m｜回測容差（× ATR14）', def: 0.25, min: 0, max: 2, step: 0.05 },
    { key: 'kdChase', label: '1m｜KD 追價上限（100 = 關）', def: 80, min: 50, max: 100 },
    { key: 'volFilter', label: '1m｜成交量濾網（0 關 / 1 開）', def: 0, min: 0, max: 1 },
    { key: 'budget', label: '風控｜每筆風險預算 NT$', def: 1000, min: 100, max: 1000000, step: 100 },
    { key: 'feePerSide', label: '風控｜單邊手續費 NT$/口', def: 12, min: 0, max: 1000 },
    { key: 'slipTicks', label: '風控｜滑價緩衝（tick/邊）', def: 1, min: 0, max: 20 },
    { key: 'qty', label: '風控｜計畫口數上限', def: 1, min: 1, max: 50 },
    { key: 'swingBars', label: '風控｜擺動高低點 K 棒數（1m）', def: 5, min: 3, max: 30 },
    { key: 'stopAtr', label: '風控｜初始停損 ATR 倍數（1m）', def: 1.5, min: 0.5, max: 5, step: 0.1 },
    { key: 'trailAtr', label: '風控｜移動停損 ATR 倍數（5m）', def: 1.2, min: 0.5, max: 5, step: 0.1 },
    { key: 'singleExit', label: '風控｜單口出場（1 追蹤 / 2 2R / 3 3R）', def: 1, min: 1, max: 3 },
    { key: 'tierMode', label: '風控｜多口分配（0 規格表 / 1 自訂）', def: 0, min: 0, max: 1 },
    { key: 'tp2Lots', label: '風控｜自訂 2R 停利口數', def: 1, min: 0, max: 50 },
    { key: 'tp3Lots', label: '風控｜自訂 3R 停利口數', def: 1, min: 0, max: 50 },
];

const DEFAULTS: Record<string, number> = Object.fromEntries(
    TSP_PARAMS.map((p) => [p.key, p.def]),
);

// 參數值超出範圍時夾回範圍內（設定視窗與 Agent 服務都已驗證，這裡是最後防線）
function param(p: Record<string, number>, key: string): number {
    const def = TSP_PARAMS.find((d) => d.key === key)!;
    const v = p[key];
    if (typeof v !== 'number' || !Number.isFinite(v)) return def.def;
    return Math.min(def.max, Math.max(def.min, v));
}

export function configFromParams(p: Record<string, number> = {}): TrendSignalConfig {
    const singleExit = Math.round(param(p, 'singleExit'));
    return {
        stPeriod: Math.round(param(p, 'stPeriod')),
        stMult: param(p, 'stMult'),
        emaPeriod: Math.round(param(p, 'emaPeriod')),
        emaSlopeBars: 2,
        atrPeriod: Math.round(param(p, 'atrPeriod')),
        candidateBars: Math.round(param(p, 'candidateBars')),
        ema1m: Math.round(param(p, 'ema1m')),
        atr1m: 14,
        kdPeriod: Math.round(param(p, 'kdPeriod')),
        kdK: Math.round(param(p, 'kdK')),
        kdD: Math.round(param(p, 'kdD')),
        touchTol: param(p, 'touchTol'),
        kdChase: param(p, 'kdChase'),
        volumeFilter: param(p, 'volFilter') >= 1,
        volumeLookback: 20,
        keyBars: 20,
        budget: param(p, 'budget'),
        feePerSide: param(p, 'feePerSide'),
        slipTicks: Math.round(param(p, 'slipTicks')),
        qty: Math.round(param(p, 'qty')),
        swingBars: Math.round(param(p, 'swingBars')),
        stopAtr: param(p, 'stopAtr'),
        trailAtr: param(p, 'trailAtr'),
        singleExit: singleExit === 2 ? 2 : singleExit === 3 ? 3 : 1,
        tierMode: param(p, 'tierMode') >= 1 ? 'custom' : 'auto',
        tp2Lots: Math.round(param(p, 'tp2Lots')),
        tp3Lots: Math.round(param(p, 'tp3Lots')),
    };
}

export const DEFAULT_CONFIG: TrendSignalConfig = configFromParams(DEFAULTS);

// FNV-1a 32-bit — 設定指紋只求穩定、短，不做安全用途
function fnv1a(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

/** 計算版本 + 設定指紋：同設定同版本 → 同 ID，換參數就是另一組訊號 */
export function configKey(cfg: TrendSignalConfig): string {
    const keys = Object.keys(cfg).sort() as (keyof TrendSignalConfig)[];
    return `${TSP_ALGO_VERSION}#${fnv1a(JSON.stringify(keys.map((k) => [k, cfg[k]])))}`;
}
