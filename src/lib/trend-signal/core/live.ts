// src/lib/trend-signal/core/live.ts — 逐筆成交 → 即時 1m K 棒（canonical 1m 的
// 即時尾段）。歷史 1m 不可變；tick 只改寫歷史最後一根之後（或同一根）的
// 尾段，已經被更晚成交超越的分鐘不再改寫（已收 K 棒不重繪）。

import type { Candle } from '../../types/market';

/** 成交時間 τ（牆鐘秒）→ 所屬 1m 的收盤 label（與主圖即時桶同一公式） */
export const minuteLabel = (tau: number) => Math.floor(tau / 60) * 60 + 60;

export interface TickLike {
    /** 成交時間（牆鐘秒） */
    time: number;
    price: number;
    volume: number;
}

/** 把一筆成交併進尾段；回傳新陣列（不改寫輸入）。historyLast 是歷史的最後
 *  一根：同一分鐘的成交延續它，比它早的成交忽略。 */
export function mergeTick(tail: Candle[], historyLast: Candle | undefined, tick: TickLike): Candle[] {
    if (!Number.isFinite(tick.price) || !Number.isFinite(tick.time) || tick.price <= 0) return tail;
    const label = minuteLabel(tick.time);
    const last = tail[tail.length - 1] ?? historyLast;
    if (last && label < last.time) return tail; // 晚到的舊分鐘成交：該分鐘已收，不重繪
    const vol = Number.isFinite(tick.volume) && tick.volume > 0 ? tick.volume : 0;
    if (last && label === last.time) {
        const next: Candle = {
            ...last,
            high: Math.max(last.high, tick.price),
            low: Math.min(last.low, tick.price),
            close: tick.price,
            volume: last.volume + vol,
        };
        return tail.length > 0 ? [...tail.slice(0, -1), next] : [next];
    }
    return [...tail, { time: label, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: vol }];
}

/** 歷史 + 尾段：尾段覆蓋同 label 以後的歷史 K 棒 */
export function composeBars(history: Candle[], tail: Candle[]): Candle[] {
    if (tail.length === 0) return history;
    const first = tail[0]!.time;
    let cut = history.length;
    while (cut > 0 && history[cut - 1]!.time >= first) cut--;
    return history.slice(0, cut).concat(tail);
}

/** 歷史重新載入後的尾段：歷史最後一根之前的分鐘以伺服器 1m 為準；最後一根
 *  （載入當下可能仍在進行）以後保留即時組出的 K 棒 */
export function rebaseTail(tail: Candle[], history: Candle[]): Candle[] {
    const last = history[history.length - 1];
    if (!last) return tail;
    return tail.filter((b) => b.time >= last.time);
}
