// src/lib/trend-signal/trend.ts — 各週期的趨勢狀態（SuperTrend + EMA 斜率）
// 與 5m 主控的 BUY/SELL。只吃已收 K 棒；指標全部沿用 indicators.ts 的
// 因果純函式（每根的值只依賴它之前的 K 棒）。

import { atr, ema, supertrend } from '../indicators';
import type { Candle } from '../types/market';
import { alignPoints } from './bars';
import type { Alignment, TrendSeries, TrendState } from './types';

export interface TrendParams {
    stPeriod: number;
    stMult: number;
    emaPeriod: number;
    emaSlopeBars: number;
    atrPeriod: number;
}

/** 狀態要等指標資料足夠且初值影響衰減後才判定；之前一律 UNKNOWN */
export function trendWarmup(p: TrendParams): number {
    return 2 * Math.max(p.stPeriod, p.emaPeriod) + p.emaSlopeBars;
}

export function computeTrend(bars: Candle[], p: TrendParams): TrendSeries {
    const n = bars.length;
    const st: (number | undefined)[] = new Array(n);
    const stUp: (boolean | undefined)[] = new Array(n);
    const r = supertrend(bars, p.stPeriod, p.stMult);
    for (let i = 0; i < n; i++) {
        const u = r.up[i]?.value;
        const d = r.down[i]?.value;
        st[i] = u ?? d;
        stUp[i] = u !== undefined ? true : d !== undefined ? false : undefined;
    }
    const emaV = alignPoints(bars, ema(bars, p.emaPeriod));
    const atrV = alignPoints(bars, atr(bars, p.atrPeriod));
    const warm = trendWarmup(p);
    const state: TrendState[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const e = emaV[i];
        const ePrev = i >= p.emaSlopeBars ? emaV[i - p.emaSlopeBars] : undefined;
        const up = stUp[i];
        if (i < warm || e === undefined || ePrev === undefined || up === undefined) {
            state[i] = 'UNKNOWN';
            continue;
        }
        const c = bars[i]!.close;
        if (up && c > e && e > ePrev) state[i] = 'LONG';
        else if (!up && c < e && e < ePrev) state[i] = 'SHORT';
        else state[i] = 'NEUTRAL';
    }
    return { st, stUp, ema: emaV, atr: atrV, state };
}

/** BUY = 已收棒狀態由非 LONG 轉為 LONG（SELL 鏡像）。暖身結束的第一個
 *  已知狀態不算轉換：UNKNOWN → LONG 是資料起點造成的，不是訊號。 */
export function transitionAt(state: TrendState[], i: number): 'BUY' | 'SELL' | null {
    if (i < 1) return null;
    const prev = state[i - 1]!;
    const cur = state[i]!;
    if (prev === 'UNKNOWN' || prev === cur) return null;
    if (cur === 'LONG') return 'BUY';
    if (cur === 'SHORT') return 'SELL';
    return null;
}

/** 高週期與 5m 的關係：同向 ALIGN、反向 DIVERGE、任一方無方向 NEUTRAL */
export function alignmentOf(htf: TrendState, m5: TrendState): Alignment {
    const dir = (s: TrendState) => s === 'LONG' || s === 'SHORT';
    if (!dir(htf) || !dir(m5)) return 'NEUTRAL';
    return htf === m5 ? 'ALIGN' : 'DIVERGE';
}

/** 最近 n 根已收 K 棒（含 i）的最高價與最低價 */
export function keyLevels(bars: Candle[], i: number, n: number): { high: number; low: number } | null {
    if (i < 0) return null;
    let high = -Infinity;
    let low = Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) {
        high = Math.max(high, bars[j]!.high);
        low = Math.min(low, bars[j]!.low);
    }
    return Number.isFinite(high) && Number.isFinite(low) ? { high, low } : null;
}
