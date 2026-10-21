// src/lib/trend-signal/trend/mtf.ts — MtfContext（V1.1 §2）：任一真實時點 t「當時已知」的
// 某週期狀態。只取 label ≤ t 的已收 K 棒（不向前洩漏未收的高週期）；那一根不是前一個
// 桶（換盤後尚未收第一根、資料缺洞）即標為 stale。15m／60m 只當輔助，不回寫 5m。

import { freshAt, lastAtOrBefore } from '../core/bars';
import type { TfSeries, TrendState, TrendTrack } from '../types';

export interface TfAt {
    /** label ≤ t 的最後一根；沒有為 -1 */
    index: number;
    state: TrendState;
    barTime: number | null;
    stale: boolean;
    /** 那一根缺少正規交易分鐘（高週期只標示，不排除） */
    incomplete: boolean;
}

export function tfAt(series: TfSeries, track: TrendTrack, t: number): TfAt {
    const index = lastAtOrBefore(series.bars, t);
    const barTime = index >= 0 ? series.bars[index]!.time : null;
    return {
        index,
        state: index >= 0 ? track.dir[index]! : 'UNKNOWN',
        barTime,
        stale: !freshAt(barTime, t, series.tf),
        incomplete: index >= 0 && series.missing[index]! > 0,
    };
}
