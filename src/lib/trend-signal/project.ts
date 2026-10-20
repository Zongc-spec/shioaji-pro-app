// src/lib/trend-signal/project.ts — 把 Trend Signal Pro 結果投影到目前主圖
// 週期的 K 棒：5m 趨勢線（每根主圖 K 棒取「當時最新已收的 5m」，不偷看
// 未收的 5m）與訊號標記（依原始收盤時間落在包含它的主圖 K 棒）。

import type { IndicatorPoint } from '../indicators';
import type { Candle } from '../types/market';
import { lastAtOrBefore } from './bars';
import { exitText } from './engine';
import type { TrendSignalResult } from './types';

/** 時間 t 屬於主圖哪一根 K 棒（與 aggregate() 同一個收盤 label 公式） */
export function chartBucket(t: number, tfMinutes: number): number {
    if (tfMinutes <= 1) return t;
    if (tfMinutes >= 1440) return Math.floor(t / 86400) * 86400;
    const sec = tfMinutes * 60;
    return Math.ceil(t / sec) * sec;
}

export interface ProjectedLines {
    up: IndicatorPoint[];
    down: IndicatorPoint[];
    ema: IndicatorPoint[];
}

/** 日 K 以上沒有對應的 5m 收盤時間，不投影 */
export function projectLines(res: TrendSignalResult, chartBars: Candle[], tfMinutes: number): ProjectedLines {
    const up: IndicatorPoint[] = [];
    const down: IndicatorPoint[] = [];
    const ema: IndicatorPoint[] = [];
    if (tfMinutes >= 1440) return { up, down, ema };
    const m5 = res.m5.bars;
    for (const b of chartBars) {
        // 進行中的主圖 K 棒只能用 asOf 之前已收的 5m
        const j = lastAtOrBefore(m5, Math.min(b.time, res.asOf));
        const st = j >= 0 ? res.t5.st[j] : undefined;
        const stUp = j >= 0 ? res.t5.stUp[j] : undefined;
        const e = j >= 0 ? res.t5.ema[j] : undefined;
        up.push(st !== undefined && stUp === true ? { time: b.time, value: st } : { time: b.time });
        down.push(st !== undefined && stUp === false ? { time: b.time, value: st } : { time: b.time });
        ema.push(e !== undefined ? { time: b.time, value: e } : { time: b.time });
    }
    return { up, down, ema };
}

export type MarkerKind = 'BUY' | 'SELL' | 'TRIGGER_LONG' | 'TRIGGER_SHORT' | 'EXIT_LONG' | 'EXIT_SHORT';

export interface TspMarker {
    id: string;
    time: number;
    kind: MarkerKind;
    text: string;
}

/** 標記只放在主圖確實存在的 K 棒上（僅日盤時夜盤訊號不畫） */
export function projectMarkers(res: TrendSignalResult, chartTimes: Set<number>, tfMinutes: number): TspMarker[] {
    if (tfMinutes >= 1440) return [];
    const out: TspMarker[] = [];
    const push = (id: string, t: number, kind: MarkerKind, text: string) => {
        const time = chartBucket(t, tfMinutes);
        if (chartTimes.has(time)) out.push({ id, time, kind, text });
    };
    for (const s of res.signals) push(s.id, s.barTime, s.kind, s.kind);
    for (const t of res.triggers) {
        if (t.status !== 'ACCEPTED') continue;
        push(t.id, t.barTime, t.direction === 'LONG' ? 'TRIGGER_LONG' : 'TRIGGER_SHORT', '1m');
    }
    for (const vt of res.trades) {
        for (const f of vt.fills) {
            push(`${vt.id}|${f.time}|${f.reason}`, f.time, vt.direction === 'LONG' ? 'EXIT_LONG' : 'EXIT_SHORT', exitText(f.reason));
        }
    }
    return out.sort((a, b) => a.time - b.time);
}
