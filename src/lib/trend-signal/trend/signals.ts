// src/lib/trend-signal/trend/signals.ts — 趨勢方向（含暖身）、趨勢切換訊號、
// 高週期關係與只供顯示的註記／強度。只依賴 core 的已收 K 棒與趨勢參數，
// 不讀任何進場時機或風控資訊。

import { ema, rsi } from '../../indicators';
import type { Candle } from '../../types/market';
import { alignPoints } from '../core/bars';
import type { Alignment, NoteParams, SignalNotes, TfSeries, TrendDir, TrendParams, TrendTrack } from '../types';
import { ALGORITHMS } from './algorithms';

/** 某週期的趨勢線與方向；自資料起點的暖身根數內一律 UNKNOWN */
export function trendTrack(series: TfSeries, p: TrendParams): TrendTrack {
    const algo = ALGORITHMS[p.algo];
    const raw = algo.compute(series.bars, p);
    const warm = algo.warmup(p);
    const dir: TrendDir[] = raw.dir.map((d, i) => (i < warm || d === 0 ? 'UNKNOWN' : d === 1 ? 'UP' : 'DOWN'));
    const line = raw.line.map((v, i) => (dir[i] === 'UNKNOWN' ? undefined : v));
    return { tf: series.tf, algo: p.algo, line, dir, stopLine: algo.stopLine };
}

/** BUY = 已收棒方向由 DOWN 轉 UP；SELL 鏡像。UNKNOWN → 有方向不是訊號。 */
export function switchAt(dir: TrendDir[], i: number): 'BUY' | 'SELL' | null {
    if (i < 1) return null;
    const prev = dir[i - 1];
    const cur = dir[i];
    if (prev === 'DOWN' && cur === 'UP') return 'BUY';
    if (prev === 'UP' && cur === 'DOWN') return 'SELL';
    return null;
}

/** 高週期與 5m 的關係：同向 ALIGN、反向 DIVERGE、任一方未知 NEUTRAL */
export function alignmentOf(htf: TrendDir, m5: TrendDir): Alignment {
    if (htf === 'UNKNOWN' || m5 === 'UNKNOWN') return 'NEUTRAL';
    return htf === m5 ? 'ALIGN' : 'DIVERGE';
}

/** 第 i 根的方向已持續幾根（含 i）；未知為 null */
export function trendAge(dir: TrendDir[], i: number): number | null {
    const d = dir[i];
    if (i < 0 || d === undefined || d === 'UNKNOWN') return null;
    let j = i;
    while (j > 0 && dir[j - 1] === d) j--;
    return i - j + 1;
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

/** 收盤對 EMA 與 EMA 斜率是否與訊號同向（規格 §1.1 的條件，只當註記） */
export function emaNote(
    bars: Candle[],
    emaV: (number | undefined)[],
    i: number,
    kind: 'BUY' | 'SELL',
    slopeBars: number,
): SignalNotes['ema'] {
    const e = emaV[i];
    const ePrev = i >= slopeBars ? emaV[i - slopeBars] : undefined;
    if (e === undefined || ePrev === undefined) return 'UNKNOWN';
    const c = bars[i]!.close;
    const up = c > e && e > ePrev;
    const down = c < e && e < ePrev;
    if (kind === 'BUY') return up ? 'WITH' : down ? 'AGAINST' : 'MIXED';
    return down ? 'WITH' : up ? 'AGAINST' : 'MIXED';
}

export function emaSeries(bars: Candle[], p: NoteParams): (number | undefined)[] {
    return alignPoints(bars, ema(bars, p.emaPeriod));
}

export function rsiSeries(bars: Candle[], p: NoteParams): (number | undefined)[] {
    return alignPoints(bars, rsi(bars, p.rsiPeriod));
}
