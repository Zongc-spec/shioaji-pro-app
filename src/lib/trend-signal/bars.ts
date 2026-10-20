// src/lib/trend-signal/bars.ts — canonical confirmed-bar pipeline：
// 同一份 1m K 棒 → 已收 1m／5m／15m／60m，與當盤（交易時段）VWAP。
// 週期 K 棒直接用主圖的 aggregate()，確保 Dashboard 與切到該週期的
// 主圖是同一組 K 棒；進行中的 K 棒一律不進入任何計算。

import { CLOSE_GRACE } from '../intraday-session';
import type { IndicatorPoint } from '../indicators';
import type { SecurityType } from '../types/contract';
import type { Candle } from '../types/market';
import { aggregate } from '../utils/kbars';
import { tradingSessionOf } from './session';
import type { TfMinutes, TfSeries } from './types';

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
    const sessionOfLabel = new Map<number, string>();
    const sessionKey = (label: number) => {
        let k = sessionOfLabel.get(label);
        if (k === undefined) {
            k = tradingSessionOf(secType, label).key;
            sessionOfLabel.set(label, k);
        }
        return k;
    };
    if (tf === 1) {
        return { tf, bars: m1, lastMinute: m1.map((b) => b.time), session: m1.map((b) => sessionKey(b.time)) };
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
    const session = lastMinute.map((t) => sessionKey(t));
    const n = bars.length;
    if (n > 0) {
        const lastLabel = bars[n - 1]!.time;
        const lm = lastMinute[n - 1]!;
        const closedAt = tradingSessionOf(secType, lm).end + CLOSE_GRACE;
        if (!(lastLabel <= asOf || asOf >= closedAt)) {
            bars.pop();
            lastMinute.pop();
            session.pop();
        }
    }
    return { tf, bars, lastMinute, session };
}

/** IndicatorPoint[]（以時間為鍵）→ 與 bars 對齊的陣列 */
export function alignPoints(bars: Candle[], pts: IndicatorPoint[]): (number | undefined)[] {
    const at = new Map<number, number | undefined>();
    for (const p of pts) at.set(p.time, p.value);
    return bars.map((b) => at.get(b.time));
}

/** 當盤 VWAP：每個交易時段（日盤／夜盤）重新累積，跨午夜不重設 */
export function sessionVwap(bars: Candle[], session: string[]): (number | undefined)[] {
    const out: (number | undefined)[] = [];
    let key = '';
    let pv = 0;
    let vol = 0;
    for (let i = 0; i < bars.length; i++) {
        const b = bars[i]!;
        if (session[i] !== key) {
            key = session[i]!;
            pv = 0;
            vol = 0;
        }
        if (b.volume > 0) {
            pv += ((b.high + b.low + b.close) / 3) * b.volume;
            vol += b.volume;
        }
        out.push(vol > 0 ? pv / vol : undefined);
    }
    return out;
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
