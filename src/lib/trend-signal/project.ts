// src/lib/trend-signal/project.ts — 把 Trend Signal Pro 結果投影到目前主圖週期的
// K 棒：5m 趨勢線（每根主圖 K 棒取「當時最新已收的 5m」，不偷看未收的 5m）
// 與訊號標記（依原始收盤時間落在包含它的主圖 K 棒）。

import type { IndicatorPoint } from '../indicators';
import type { Candle } from '../types/market';
import { aggregate } from '../utils/kbars';
import { lastAtOrBefore } from './core/bars';
import { exitText } from './risk/virtual';
import { emaSeries, trendTrack } from './trend/signals';
import type { EntryMode, TrendDir, TrendSignalConfig, TrendSignalResult } from './types';

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

/** 透明色：lightweight-charts 的折線不會因 whitespace 斷開，改以點顏色隱藏線段 */
export const GAP_COLOR = 'rgba(0, 0, 0, 0)';

/** 依方向拆成多／空兩條線。lightweight-charts 中「第 i−1 點 → 第 i 點」的線段使用
 *  第 i−1 點的顏色，所以：非生效側的點、以及每段生效區間的最後一點設為透明 —
 *  翻轉時不畫連接線，生效區間內的線段不受影響（只適用一般折線，不適用階梯線）。
 *  非生效側的點值沿用當下的趨勢線，讓讀值與縮放都對應實際的線。 */
export function splitTrendLines(
    times: number[],
    values: (number | undefined)[],
    dirs: TrendDir[],
): { up: IndicatorPoint[]; down: IndicatorPoint[] } {
    const up: IndicatorPoint[] = [];
    const down: IndicatorPoint[] = [];
    for (let i = 0; i < times.length; i++) {
        const time = times[i]!;
        const v = values[i];
        const d = dirs[i];
        if (v === undefined || d === undefined || d === 'UNKNOWN') {
            up.push({ time });
            down.push({ time });
            continue;
        }
        const next = dirs[i + 1];
        const ends = next !== undefined && next !== d;
        up.push(d === 'UP' && !ends ? { time, value: v } : { time, value: v, color: GAP_COLOR });
        down.push(d === 'DOWN' && !ends ? { time, value: v } : { time, value: v, color: GAP_COLOR });
    }
    return { up, down };
}

/** 日 K 以上沒有對應的 5m 收盤時間，不投影 */
export function projectLines(res: TrendSignalResult, chartBars: Candle[], tfMinutes: number): ProjectedLines {
    if (tfMinutes >= 1440) return { up: [], down: [], ema: [] };
    const m5 = res.m5.bars;
    const values: (number | undefined)[] = [];
    const dirs: TrendDir[] = [];
    const ema: IndicatorPoint[] = [];
    for (const b of chartBars) {
        // 進行中的主圖 K 棒只能用 asOf 之前已收的 5m
        const j = lastAtOrBefore(m5, Math.min(b.time, res.asOf));
        values.push(j >= 0 ? res.t5.line[j] : undefined);
        dirs.push(j >= 0 ? res.t5.dir[j]! : 'UNKNOWN');
        const e = j >= 0 ? res.ema5[j] : undefined;
        ema.push(e !== undefined ? { time: b.time, value: e } : { time: b.time });
    }
    return { ...splitTrendLines(chartBars.map((b) => b.time), values, dirs), ema };
}

/** 沒有 canonical 1m 結果的圖表（例：回測圖）：只能從手上的 1m／5m K 棒自己算 5m
 *  趨勢線，視所有 K 棒為已收；15m 以上無法還原 5m，不畫。原生 K 線圖不走這裡。 */
export function standaloneLines(bars: Candle[], tfMinutes: number, cfg: TrendSignalConfig): ProjectedLines {
    if (bars.length === 0 || tfMinutes > 5 || 5 % tfMinutes !== 0) return { up: [], down: [], ema: [] };
    const m5 = tfMinutes === 5 ? bars : aggregate(bars, 5);
    const t5 = trendTrack({ tf: 5, bars: m5, lastMinute: m5.map((b) => b.time), session: m5.map(() => '') }, cfg.trend);
    const ema5 = emaSeries(m5, cfg.note);
    const values: (number | undefined)[] = [];
    const dirs: TrendDir[] = [];
    const ema: IndicatorPoint[] = [];
    for (const b of bars) {
        const j = lastAtOrBefore(m5, b.time);
        values.push(j >= 0 ? t5.line[j] : undefined);
        dirs.push(j >= 0 ? t5.dir[j]! : 'UNKNOWN');
        const e = j >= 0 ? ema5[j] : undefined;
        ema.push(e !== undefined ? { time: b.time, value: e } : { time: b.time });
    }
    return { ...splitTrendLines(bars.map((b) => b.time), values, dirs), ema };
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
