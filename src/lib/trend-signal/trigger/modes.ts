// src/lib/trend-signal/trigger/modes.ts — EntryTiming 的獨立候選（只決定 5m 方向內的
// 1m 時機，不改變 5m 狀態；空單皆完全鏡像）：
//   IMMEDIATE        5m 收棒即提示，每段趨勢一次（比較基準）
//   MICRO_TREND      1m 微型趨勢（與 5m 同一 TrendCore 家族）由反向／中性轉回同向，每次都提示
//   PRICE_STRUCTURE  確認回檔轉折後收盤突破回檔起點；提示後要有新的回檔轉折才再提示
// 轉折點以左右各 n 根判定，右側 n 根收盤後才算確認；不使用任何未來轉折。

import type { Candle } from '../../types/market';
import type { EntryEvent, EntryParams, TrendState } from '../types';
import { hintEvent, type TrendSegment } from './window';

export interface ModeResult {
    hints: EntryEvent[];
    /** 段落仍有效時，目前在等什麼 */
    waiting: string;
}

const STATE_WORD: Record<TrendState, string> = { LONG: '多', SHORT: '空', NEUTRAL: '中性', UNKNOWN: '未知' };

export function immediateHints(seg: TrendSegment, key: string): ModeResult {
    const sig = seg.signal;
    // 訊號落在該盤最後一根 5m：下一根 1m 開盤已是下一盤，不提示
    if (sig.barTime >= sig.sessionEnd) return { hints: [], waiting: '訊號在該盤最後一根 5m，不跨盤進場' };
    return {
        hints: [hintEvent(seg, 'IMMEDIATE', key, 1, sig.barTime, sig.close, '5m 收棒立即（比較基準）')],
        waiting: '每段 5m 趨勢只提示一次',
    };
}

export function microTrendHints(seg: TrendSegment, m1: Candle[], micro: TrendState[], key: string): ModeResult {
    const want = seg.signal.direction;
    const hints: EntryEvent[] = [];
    for (const m of seg.bars) {
        const prev = micro[m - 1];
        if (micro[m] !== want || prev === undefined || prev === want || prev === 'UNKNOWN') continue;
        const bar = m1[m]!;
        hints.push(hintEvent(seg, 'MICRO_TREND', key, hints.length + 1, bar.time, bar.close, `1m 微型趨勢由${STATE_WORD[prev]}轉${STATE_WORD[want]}`));
    }
    const last = seg.bars[seg.bars.length - 1];
    const cur = last !== undefined ? micro[last] : undefined;
    const waiting = cur === undefined || cur === 'UNKNOWN'
        ? '等待 1m 微型趨勢'
        : cur === want ? '1m 已同向；等待回檔（反向或中性）後再轉回同向' : '1m 回檔中；等待轉回同向';
    return { hints, waiting };
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

export function priceStructureHints(
    seg: TrendSegment,
    m1: Candle[],
    atr1: (number | undefined)[],
    highs: Pivot[],
    lows: Pivot[],
    p: EntryParams,
    key: string,
): ModeResult {
    const long = seg.signal.direction === 'LONG';
    // 回檔轉折：多單為轉折低點、空單為轉折高點；起點為它之前最近的反向轉折
    const pull = long ? lows : highs;
    const start = long ? highs : lows;
    const hints: EntryEvent[] = [];
    // 回檔轉折必須形成在 5m 訊號（之後則是上一次提示）之後
    let after = seg.signal.barTime;
    let waiting = '等待 5m 訊號後的回檔轉折確認';
    // 目前回檔轉折是否已被收盤跌破（站上）：逐根累積，不重掃
    let plIndex = -1;
    let broken = false;
    let scanned = -1;
    let topKey = '';
    let top = 0;
    for (const m of seg.bars) {
        const k = lastConfirmed(pull, m);
        const pl = k >= 0 ? pull[k]! : undefined;
        if (!pl || !(m1[pl.index]!.time > after)) {
            waiting = hints.length > 0 ? '已提示；等待新的回檔轉折確認' : '等待 5m 訊號後的回檔轉折確認';
            continue;
        }
        if (pl.index !== plIndex) {
            plIndex = pl.index;
            broken = false;
            scanned = pl.index;
        }
        for (let q = scanned + 1; q <= m && !broken; q++) broken = long ? m1[q]!.close < pl.price : m1[q]!.close > pl.price;
        scanned = m;
        if (broken) {
            waiting = `回檔轉折 ${pl.price} 已被收盤${long ? '跌破' : '站上'}，等待新的回檔轉折`;
            continue;
        }
        const ph = latestBefore(start, m, pl.index);
        if (!ph) {
            waiting = '等待回檔起點（反向轉折）確認';
            continue;
        }
        // 回檔起點取兩個轉折之間的極值（乾淨結構時就是 ph 本身）
        if (topKey !== `${ph.index}:${pl.index}`) {
            topKey = `${ph.index}:${pl.index}`;
            top = long ? -Infinity : Infinity;
            for (let q = ph.index; q <= pl.index; q++) top = long ? Math.max(top, m1[q]!.high) : Math.min(top, m1[q]!.low);
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
            hints.push(hintEvent(seg, 'PRICE_STRUCTURE', key, hints.length + 1, m1[m]!.time, c,
                `回檔轉折 ${pl.price} 確認後，收盤 ${c} ${long ? '突破' : '跌破'}回檔起點 ${top}`));
            after = m1[m]!.time;
            waiting = '已提示；等待新的回檔轉折確認';
        }
    }
    return { hints, waiting };
}
