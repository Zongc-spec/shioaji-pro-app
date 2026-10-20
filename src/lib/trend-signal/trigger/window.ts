// src/lib/trend-signal/trigger/window.ts — 1m 進場時機的共同規則：5m 訊號後
// windowBars 根 5m 內、不跨盤別；反向訊號確認即提前結束。只評估已收 1m。

import type { Candle } from '../../types/market';
import { firstAfter } from '../core/bars';
import type { EntryEvent, EntryMode, EntryStatus, TrendSignal } from '../types';

export interface SignalWindow {
    /** 第一根 label > 訊號時間的 1m 索引 */
    from: number;
    /** 最後一個允許觸發的 1m label（含） */
    end: number;
    /** 下一個（反向）訊號的收棒時間：此時刻起窗口結束；尚未出現為 Infinity */
    cancelAt: number;
}

/** next 是 sig 之後的下一個訊號（訊號嚴格交替，必為反向）；只有已確認的
 *  訊號會出現在清單上，所以這裡不含未來資訊 */
export function signalWindow(sig: TrendSignal, next: TrendSignal | undefined, m1: Candle[], windowBars: number): SignalWindow {
    return {
        from: firstAfter(m1, sig.barTime),
        end: Math.min(sig.barTime + windowBars * 300, sig.sessionEnd),
        cancelAt: next?.barTime ?? Number.POSITIVE_INFINITY,
    };
}

/** 窗口內可評估的已收 1m 索引（早於反向訊號） */
export function windowIndexes(m1: Candle[], w: SignalWindow): number[] {
    const out: number[] = [];
    for (let m = w.from; m < m1.length; m++) {
        const t = m1[m]!.time;
        if (t > w.end || t >= w.cancelAt) break;
        out.push(m);
    }
    return out;
}

/** 沒有觸發時的狀態：反向訊號已確認 → CANCELLED；窗口已過 → EXPIRED；否則 PENDING */
export function untriggeredStatus(w: SignalWindow, asOf: number): Exclude<EntryStatus, 'TRIGGERED'> {
    if (w.cancelAt <= w.end && w.cancelAt <= asOf) return 'CANCELLED';
    if (w.end <= asOf) return 'EXPIRED';
    return 'PENDING';
}

const UNTRIGGERED: Record<Exclude<EntryStatus, 'TRIGGERED'>, string> = {
    CANCELLED: '5m 反向訊號已確認，窗口結束',
    EXPIRED: '窗口內條件未成立',
    PENDING: '等待條件',
};

export function entryEvent(
    id: string,
    mode: EntryMode,
    sig: TrendSignal,
    w: SignalWindow,
    hit: { barTime: number; refPrice: number; reason: string } | null,
    asOf: number,
    waiting?: string,
): EntryEvent {
    if (hit) {
        return { id, mode, signalId: sig.id, direction: sig.direction, status: 'TRIGGERED', ...hit, windowEnd: w.end };
    }
    const status = untriggeredStatus(w, asOf);
    return {
        id,
        mode,
        signalId: sig.id,
        direction: sig.direction,
        status,
        barTime: null,
        refPrice: null,
        windowEnd: w.end,
        reason: status === 'PENDING' && waiting ? waiting : UNTRIGGERED[status],
    };
}
