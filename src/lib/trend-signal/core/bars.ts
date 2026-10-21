// src/lib/trend-signal/core/bars.ts — canonical confirmed-bar pipeline：
// 同一份 1m K 棒 → 已收 1m／5m／15m／60m。週期 K 棒直接用主圖的
// aggregate()，確保 Dashboard 與切到該週期的主圖是同一組 K 棒；
// 進行中的 K 棒一律不進入任何計算。

import { CLOSE_GRACE } from '../../intraday-session';
import type { IndicatorPoint } from '../../indicators';
import type { SecurityType } from '../../types/contract';
import type { Candle } from '../../types/market';
import { aggregate } from '../../utils/kbars';
import { tradingSessionOf, type TradingSession } from './session';
import type { TfMinutes, TfSeries } from '../types';

/** label ≤ asOf 的 1m K 棒才算已收。回傳新陣列：未排序或 label 重複
 *  （後者覆蓋前者）的輸入先正規化。 */
export function confirmed1m(bars: Candle[], asOf: number): Candle[] {
    let sorted = true;
    for (let i = 1; i < bars.length; i++) {
        if (bars[i]!.time <= bars[i - 1]!.time) {
            sorted = false;
            break;
        }
    }
    const src = sorted ? bars : normalize(bars);
    let n = src.length;
    while (n > 0 && !(src[n - 1]!.time <= asOf)) n--;
    return src.slice(0, n);
}

function normalize(bars: Candle[]): Candle[] {
    const byTime = new Map<number, Candle>();
    for (const b of bars) byTime.set(b.time, b);
    return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** 由已收 1m 建立某週期的已收 K 棒。最後一個桶只有在 label ≤ asOf，
 *  或其所屬時段已收盤（含 CLOSE_GRACE）時才保留。 */
export function buildTf(
    m1: Candle[],
    tf: TfMinutes,
    secType: SecurityType,
    asOf: number,
): TfSeries {
    const sessionOfLabel = new Map<number, TradingSession>();
    const sessionOf = (label: number) => {
        let s = sessionOfLabel.get(label);
        if (s === undefined) {
            s = tradingSessionOf(secType, label);
            sessionOfLabel.set(label, s);
        }
        return s;
    };
    if (tf === 1) {
        const ss = m1.map((b) => sessionOf(b.time));
        return { tf, bars: m1, lastMinute: m1.map((b) => b.time), session: ss.map((s) => s.key), sessionEnd: ss.map((s) => s.end) };
    }
    const bars = aggregate(m1, tf);
    // 與 aggregate() 同一個收盤 label 公式，逐桶記下最後一根 1m
    const sec = tf * 60;
    const lastMinute: number[] = [];
    let j = -1;
    let cur = Number.NaN;
    for (const c of m1) {
        const bucket = Math.ceil(c.time / sec) * sec;
        if (bucket !== cur) {
            cur = bucket;
            j += 1;
        }
        lastMinute[j] = c.time;
    }
    const ss = lastMinute.map((t) => sessionOf(t));
    const session = ss.map((s) => s.key);
    const sessionEnd = ss.map((s) => s.end);
    const n = bars.length;
    if (n > 0) {
        const lastLabel = bars[n - 1]!.time;
        const closedAt = sessionEnd[n - 1]! + CLOSE_GRACE;
        if (!(lastLabel <= asOf || asOf >= closedAt)) {
            bars.pop();
            lastMinute.pop();
            session.pop();
            sessionEnd.pop();
        }
    }
    return { tf, bars, lastMinute, session, sessionEnd };
}

/** IndicatorPoint[]（以時間為鍵）→ 與 bars 對齊的陣列 */
export function alignPoints(bars: Candle[], pts: IndicatorPoint[]): (number | undefined)[] {
    const at = new Map<number, number | undefined>();
    for (const p of pts) at.set(p.time, p.value);
    return bars.map((b) => at.get(b.time));
}

/** 最後一根 label ≤ t 的索引（bars 依時間排序）；沒有回 -1 */
export function lastAtOrBefore(bars: Candle[], t: number): number {
    let lo = 0;
    let hi = bars.length - 1;
    let ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (bars[mid]!.time <= t) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

/** 第一根 label > t 的索引；沒有回 bars.length */
export function firstAfter(bars: Candle[], t: number): number {
    return lastAtOrBefore(bars, t) + 1;
}

/** 時點 t 所在的 tf 分鐘收盤桶（與 aggregate() 同一個 label 公式） */
export function tfBucket(t: number, tf: number): number {
    const sec = tf * 60;
    return Math.ceil(t / sec) * sec;
}

/** 時點 t 已知的最後一根 tf K 棒（label ≤ t）是否就是前一個桶或更新。否則中間缺了
 *  整根（換盤、資料缺洞），那根的狀態已過期，不能當「現在」的狀態用。 */
export function freshAt(lastLabel: number | null | undefined, t: number, tf: number): boolean {
    return lastLabel !== null && lastLabel !== undefined && lastLabel >= tfBucket(t, tf) - tf * 60;
}
