// src/lib/trend-signal/trigger/window.ts — 1m 進場提示的共同範圍（V1.1 §4）。一段 5m 趨勢
// 從 BUY／SELL 收棒之後開始，直到 5m 狀態離開該方向（反向、失效）為止都可提示；
// windowBars > 0 時只取翻轉後 N 根 5m（可選的 post-flip window，不跨盤）。
// 每根 1m 只看 label ≤ 它的最後一根已收 5m：那根不是前一個 5m 桶（換盤後尚未收第一根、
// 資料缺洞）就是過期，不提示。每盤最後一根 1m 不提示：下一根開盤已是下一盤，無法成交。

import type { Candle } from '../../types/market';
import { firstAfter, freshAt } from '../core/bars';
import { wallIso } from '../core/session';
import type { EntryEvent, EntryMode, TrendSignal, TrendState } from '../types';

export interface SegmentInputs {
    m1: Candle[];
    /** 每根 1m 所屬交易時段的收盤 label */
    m1SessionEnd: number[];
    m5: Candle[];
    dir5: TrendState[];
    windowBars: number;
}

export interface TrendSegment {
    signal: TrendSignal;
    /** 可提示的 1m 索引（遞增） */
    bars: number[];
    /** 5m 離開訊號方向的那一根收棒時間；尚未發生為 null */
    endedAt: number | null;
    endState: TrendState | null;
    /** post-flip 窗口最後一個可提示的 1m label（含）；整段趨勢為 Infinity */
    windowEnd: number;
}

/** 只讀已確認的 5m 狀態：段落的結束點是 5m 收棒時就已知的事實，不含未來資訊 */
export function trendSegment(sig: TrendSignal, inp: SegmentInputs): TrendSegment {
    const { m1, m5, dir5 } = inp;
    let k = sig.index + 1;
    while (k < m5.length && dir5[k] === sig.direction) k++;
    const endedAt = k < m5.length ? m5[k]!.time : null;
    const windowEnd = inp.windowBars > 0
        ? Math.min(sig.barTime + inp.windowBars * 300, sig.sessionEnd)
        : Number.POSITIVE_INFINITY;
    const bars: number[] = [];
    let j = sig.index; // label ≤ 這根 1m 的最後一根 5m
    for (let m = firstAfter(m1, sig.barTime); m < m1.length; m++) {
        const t = m1[m]!.time;
        if ((endedAt !== null && t >= endedAt) || t > windowEnd) break;
        while (j + 1 < m5.length && m5[j + 1]!.time <= t) j++;
        if (!freshAt(m5[j]!.time, t, 5) || t >= inp.m1SessionEnd[m]!) continue;
        bars.push(m);
    }
    return { signal: sig, bars, endedAt, endState: endedAt !== null ? dir5[k]! : null, windowEnd };
}

/** 段落在 asOf 已不再提示的原因；仍可提示為 null */
export function segmentClosed(seg: TrendSegment, asOf: number, windowBars: number): string | null {
    if (seg.endedAt !== null && seg.endedAt <= asOf) {
        if (seg.endState === 'NEUTRAL') return '5m 趨勢失效（NEUTRAL），停止提示';
        if (seg.endState === 'UNKNOWN') return '5m 狀態未知，停止提示';
        return '5m 已反向，停止提示';
    }
    if (seg.windowEnd <= asOf) return `已過翻轉後 ${windowBars} 根 5m（post-flip 窗口）`;
    return null;
}

/** 提示 ID：所屬 5m 訊號＋模式＋觸發 1m 時間＋進場參數指紋 */
export function hintEvent(
    seg: TrendSegment,
    mode: EntryMode,
    key: string,
    seq: number,
    barTime: number,
    refPrice: number,
    reason: string,
): EntryEvent {
    const sig = seg.signal;
    return {
        id: `${sig.id}|${mode}|${wallIso(barTime)}#${key}`,
        kind: sig.direction === 'LONG' ? 'POTENTIAL_ENTRY_LONG' : 'POTENTIAL_ENTRY_SHORT',
        mode,
        signalId: sig.id,
        direction: sig.direction,
        barTime,
        refPrice,
        seq,
        reason,
    };
}
