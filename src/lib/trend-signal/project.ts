// src/lib/trend-signal/project.ts — 把 Trend Signal Pro 結果投影到目前主圖週期的
// K 棒：5m 趨勢線（每根主圖 K 棒取「當時最新已收的 5m」，不偷看未收的 5m）
// 與訊號標記（依原始收盤時間落在包含它的主圖 K 棒）。

import type { IndicatorPoint } from '../indicators';
import type { Candle } from '../types/market';
import { aggregate } from '../utils/kbars';
import { lastAtOrBefore } from './core/bars';
import { exitText } from './risk/virtual';
import { emaSeries, trendTrack } from './trend/signals';
import type { EntryMode, TrendSignalConfig, TrendSignalResult } from './types';

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
        const v = j >= 0 ? res.t5.line[j] : undefined;
        const d = j >= 0 ? res.t5.dir[j] : 'UNKNOWN';
        const e = j >= 0 ? res.ema5[j] : undefined;
        up.push(v !== undefined && d === 'UP' ? { time: b.time, value: v } : { time: b.time });
        down.push(v !== undefined && d === 'DOWN' ? { time: b.time, value: v } : { time: b.time });
        ema.push(e !== undefined ? { time: b.time, value: e } : { time: b.time });
    }
    return { up, down, ema };
}

/** 沒有 canonical 1m 結果的圖表（例：回測圖）：只能從手上的 1m／5m K 棒自己算 5m
 *  趨勢線，視所有 K 棒為已收；15m 以上無法還原 5m，不畫。原生 K 線圖不走這裡。 */
export function standaloneLines(bars: Candle[], tfMinutes: number, cfg: TrendSignalConfig): ProjectedLines {
    const empty = { up: [], down: [], ema: [] };
    if (bars.length === 0 || tfMinutes > 5 || 5 % tfMinutes !== 0) return empty;
    const m5 = tfMinutes === 5 ? bars : aggregate(bars, 5);
    const t5 = trendTrack({ tf: 5, bars: m5, lastMinute: m5.map((b) => b.time), session: m5.map(() => '') }, cfg.trend);
    const ema5 = emaSeries(m5, cfg.note);
    const up: IndicatorPoint[] = [];
    const down: IndicatorPoint[] = [];
    const ema: IndicatorPoint[] = [];
    for (const b of bars) {
        const j = lastAtOrBefore(m5, b.time);
        const v = j >= 0 ? t5.line[j] : undefined;
        const d = j >= 0 ? t5.dir[j] : 'UNKNOWN';
        up.push(v !== undefined && d === 'UP' ? { time: b.time, value: v } : { time: b.time });
        down.push(v !== undefined && d === 'DOWN' ? { time: b.time, value: v } : { time: b.time });
        const e = j >= 0 ? ema5[j] : undefined;
        ema.push(e !== undefined ? { time: b.time, value: e } : { time: b.time });
    }
    return { up, down, ema };
}

export type MarkerKind = 'BUY' | 'SELL' | 'ENTRY_LONG' | 'ENTRY_SHORT' | 'EXIT_LONG' | 'EXIT_SHORT';

export interface TspMarker {
    id: string;
    time: number;
    kind: MarkerKind;
    text: string;
}

const MODE_TAG: Record<EntryMode, string> = {
    IMMEDIATE: 'I',
    MICRO_TREND: 'M',
    PRICE_STRUCTURE: 'S',
    PULLBACK_KD: 'K',
};

/** 標記只放在主圖確實存在的 K 棒上（僅日盤時夜盤訊號不畫）。entryModes：
 *  要畫進場觸發的模式（IMMEDIATE 與 5m 箭頭同時出現，通常不另畫）。 */
export function projectMarkers(
    res: TrendSignalResult,
    chartTimes: Set<number>,
    tfMinutes: number,
    entryModes: EntryMode[],
): TspMarker[] {
    if (tfMinutes >= 1440) return [];
    const out: TspMarker[] = [];
    const push = (id: string, t: number, kind: MarkerKind, text: string) => {
        const time = chartBucket(t, tfMinutes);
        if (chartTimes.has(time)) out.push({ id, time, kind, text });
    };
    for (const s of res.signals) push(s.id, s.barTime, s.kind, s.kind);
    for (const e of res.entries) {
        if (e.status !== 'TRIGGERED' || e.barTime === null || !entryModes.includes(e.mode)) continue;
        push(e.id, e.barTime, e.direction === 'LONG' ? 'ENTRY_LONG' : 'ENTRY_SHORT', MODE_TAG[e.mode]);
    }
    for (const vt of res.trades) {
        for (const f of vt.fills) {
            push(`${vt.id}|${f.time}|${f.reason}`, f.time, vt.direction === 'LONG' ? 'EXIT_LONG' : 'EXIT_SHORT', exitText(f.reason));
        }
    }
    return out.sort((a, b) => a.time - b.time);
}
