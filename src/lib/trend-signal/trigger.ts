// src/lib/trend-signal/trigger.ts — 1m 精準觸發（規格 §1.2）：在 5m 候選內，
// 最近兩根已收 1m 曾回測 EMA 或當盤 VWAP（容差 × 1m ATR），最新一根收盤
// 站回 EMA，且 KD 在最新一根交叉。只看已收 K 棒；空單完全鏡像。

import type { Candle } from '../types/market';
import type { Direction, M1Indicators, TrendSignalConfig } from './types';

export type SetupStage = 'NO_DATA' | 'WAIT_PULLBACK' | 'WAIT_RECLAIM' | 'WAIT_KD' | 'READY';

export interface SetupEval {
    stage: SetupStage;
    touched: 'EMA' | 'VWAP' | 'BOTH' | null;
    /** 回測那兩根的最低價（多）／最高價（空） */
    pullback: number | undefined;
    chase: boolean;
    volumeOk: boolean;
}

function touches(bar: Candle, level: number | undefined, tol: number): boolean {
    return level !== undefined && bar.low <= level + tol && bar.high >= level - tol;
}

/** 在已收 1m 索引 m 評估 dir 方向的進場條件 */
export function evalSetup(
    bars: Candle[],
    ind: M1Indicators,
    m: number,
    dir: Direction,
    cfg: TrendSignalConfig,
): SetupEval {
    const none: SetupEval = { stage: 'NO_DATA', touched: null, pullback: undefined, chase: false, volumeOk: true };
    if (m < 1) return none;
    const atr = ind.atr[m];
    const ema = ind.ema[m];
    const k = ind.k[m];
    const d = ind.d[m];
    const kPrev = ind.k[m - 1];
    const dPrev = ind.d[m - 1];
    if (atr === undefined || ema === undefined || k === undefined || d === undefined || kPrev === undefined || dPrev === undefined) {
        return none;
    }
    const tol = cfg.touchTol * atr;
    let byEma = false;
    let byVwap = false;
    let pullback: number | undefined;
    for (const j of [m - 1, m]) {
        const b = bars[j]!;
        const e = touches(b, ind.ema[j], tol);
        const v = touches(b, ind.vwap[j], tol);
        if (e || v) {
            const p = dir === 'LONG' ? b.low : b.high;
            pullback = pullback === undefined ? p : dir === 'LONG' ? Math.min(pullback, p) : Math.max(pullback, p);
        }
        byEma ||= e;
        byVwap ||= v;
    }
    const touched = byEma && byVwap ? 'BOTH' : byEma ? 'EMA' : byVwap ? 'VWAP' : null;
    const close = bars[m]!.close;
    const reclaim = dir === 'LONG' ? close > ema : close < ema;
    const cross = dir === 'LONG' ? k > d && kPrev <= dPrev : k < d && kPrev >= dPrev;
    const chase = cfg.kdChase < 100 && (dir === 'LONG' ? k >= cfg.kdChase : k <= 100 - cfg.kdChase);
    let volumeOk = true;
    if (cfg.volumeFilter) {
        const from = m - cfg.volumeLookback;
        if (from < 0) volumeOk = false;
        else {
            let sum = 0;
            for (let j = from; j < m; j++) sum += bars[j]!.volume;
            volumeOk = bars[m]!.volume >= sum / cfg.volumeLookback;
        }
    }
    const stage: SetupStage = !touched ? 'WAIT_PULLBACK' : !reclaim ? 'WAIT_RECLAIM' : !cross ? 'WAIT_KD' : 'READY';
    return { stage, touched, pullback, chase, volumeOk };
}
