// src/lib/trend-signal/trigger/modes.ts — 三種獨立的 1m 進場時機（只決定時機，
// 不改變 5m 訊號；空單皆完全鏡像）：
//   IMMEDIATE        5m 收棒即觸發（比較基準）
//   MICRO_TREND      1m 微型趨勢由反向轉回與 5m 同向
//   PRICE_STRUCTURE  5m 訊號後形成並確認回檔轉折，之後收盤突破回檔起點
// 轉折點以左右各 n 根判定，右側 n 根收盤後才算確認；不使用任何未來轉折。

import type { Candle } from '../../types/market';
import type { EntryEvent, EntryParams, TrendDir, TrendSignal } from '../types';
import { entryEvent, windowIndexes, type SignalWindow } from './window';

export function immediateEntry(id: string, sig: TrendSignal, w: SignalWindow, asOf: number): EntryEvent {
    // 訊號落在該盤最後一根 5m：窗口為空，不跨盤進場
    if (w.end <= sig.barTime) return entryEvent(id, 'IMMEDIATE', sig, w, null, asOf);
    return entryEvent(id, 'IMMEDIATE', sig, w, { barTime: sig.barTime, refPrice: sig.close, reason: '5m 收棒立即' }, asOf);
}

export function microTrendEntry(
    id: string,
    sig: TrendSignal,
    w: SignalWindow,
    m1: Candle[],
    micro: TrendDir[],
    asOf: number,
): EntryEvent {
    const want: TrendDir = sig.direction === 'LONG' ? 'UP' : 'DOWN';
    const against: TrendDir = want === 'UP' ? 'DOWN' : 'UP';
    for (const m of windowIndexes(m1, w)) {
        if (micro[m - 1] === against && micro[m] === want) {
            const bar = m1[m]!;
            return entryEvent(id, 'MICRO_TREND', sig, w, {
                barTime: bar.time,
                refPrice: bar.close,
                reason: `1m 微型趨勢由${against === 'DOWN' ? '空' : '多'}轉回${want === 'UP' ? '多' : '空'}`,
            }, asOf);
        }
    }
    return entryEvent(id, 'MICRO_TREND', sig, w, null, asOf, '等待 1m 微型趨勢回檔後轉回同向');
}

export interface Pivot {
    index: number;
    price: number;
    /** 確認所在的 K 棒索引（index + 右側根數） */
    confirm: number;
}

/** 已確認轉折：左側 left 根嚴格較低（高）、右側 right 根不高於（不低於）。
 *  bars 只含已收 K 棒，所以每個轉折都在 confirm 那根收盤時才成立。 */
export function pivots(bars: Candle[], left: number, right: number, kind: 'high' | 'low'): Pivot[] {
    const out: Pivot[] = [];
    for (let j = left; j + right < bars.length; j++) {
        const v = kind === 'high' ? bars[j]!.high : bars[j]!.low;
        let ok = true;
        for (let k = j - left; k < j && ok; k++) {
            const x = kind === 'high' ? bars[k]!.high : bars[k]!.low;
            ok = kind === 'high' ? v > x : v < x;
        }
        for (let k = j + 1; k <= j + right && ok; k++) {
            const x = kind === 'high' ? bars[k]!.high : bars[k]!.low;
            ok = kind === 'high' ? v >= x : v <= x;
        }
        if (ok) out.push({ index: j, price: v, confirm: j + right });
    }
    return out;
}

/** 最後一個 confirm ≤ m 的轉折索引（pivots 依 index 排序，confirm 同樣遞增）；沒有回 -1 */
function lastConfirmed(ps: Pivot[], m: number): number {
    let lo = 0;
    let hi = ps.length - 1;
    let ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (ps[mid]!.confirm <= m) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

/** 已確認且 index < before 的最後一個轉折 */
function latestBefore(ps: Pivot[], m: number, before: number): Pivot | undefined {
    for (let k = lastConfirmed(ps, m); k >= 0; k--) {
        if (ps[k]!.index < before) return ps[k];
    }
    return undefined;
}

export function priceStructureEntry(
    id: string,
    sig: TrendSignal,
    w: SignalWindow,
    m1: Candle[],
    atr1: (number | undefined)[],
    highs: Pivot[],
    lows: Pivot[],
    p: EntryParams,
    asOf: number,
): EntryEvent {
    const long = sig.direction === 'LONG';
    // 回檔轉折：多單為轉折低點、空單為轉折高點；起點為它之前最近的反向轉折
    const pull = long ? lows : highs;
    const start = long ? highs : lows;
    let waiting = '等待 5m 訊號後的回檔轉折確認';
    for (const m of windowIndexes(m1, w)) {
        // 最新已確認的回檔轉折，必須形成於 5m 訊號之後
        const k = lastConfirmed(pull, m);
        const pl = k >= 0 ? pull[k]! : undefined;
        if (!pl || !(m1[pl.index]!.time > sig.barTime)) continue;
        // 收盤跌破（站上）回檔轉折：結構失效，等下一個回檔轉折
        let broken = false;
        for (let k = pl.index + 1; k <= m && !broken; k++) {
            broken = long ? m1[k]!.close < pl.price : m1[k]!.close > pl.price;
        }
        if (broken) {
            waiting = '回檔轉折已被跌破（站上），等待新的回檔轉折';
            continue;
        }
        const ph = latestBefore(start, m, pl.index);
        if (!ph) continue;
        // 回檔起點取兩個轉折之間的極值（乾淨結構時就是 ph 本身）
        let top = long ? -Infinity : Infinity;
        for (let k = ph.index; k <= pl.index; k++) {
            top = long ? Math.max(top, m1[k]!.high) : Math.min(top, m1[k]!.low);
        }
        const depth = long ? top - pl.price : pl.price - top;
        const a = atr1[m];
        if (a === undefined || depth < p.minPullbackAtr * a) {
            waiting = '回檔深度不足';
            continue;
        }
        waiting = `回檔轉折 ${pl.price} 已確認，等待收盤${long ? '突破' : '跌破'} ${top}`;
        const c = m1[m]!.close;
        if (long ? c > top : c < top) {
            return entryEvent(id, 'PRICE_STRUCTURE', sig, w, {
                barTime: m1[m]!.time,
                refPrice: c,
                reason: `回檔轉折 ${pl.price} 確認後，收盤 ${c} ${long ? '突破' : '跌破'}回檔起點 ${top}`,
            }, asOf);
        }
    }
    return entryEvent(id, 'PRICE_STRUCTURE', sig, w, null, asOf, waiting);
}
