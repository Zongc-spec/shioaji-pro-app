// src/lib/trend-signal/trigger/entries.ts — EntryTiming 組裝：對每段 5m 趨勢計算各候選的
// 1m 提示（IMMEDIATE、MICRO_TREND、PRICE_STRUCTURE 一律計算以便比較；先前策略假說
// PULLBACK_KD 只有風控採用它時才算）。只讀已確認的 5m 狀態與已收 1m，不改寫 5m。

import { atr } from '../../indicators';
import type { Candle } from '../../types/market';
import { alignPoints, freshAt } from '../core/bars';
import type { EntryEvent, EntryMode, EntryModeState, EntryParams, TrendSignal, TrendState } from '../types';
import { immediateHints, microTrendHints, pivots, priceStructureHints, type ModeResult } from './modes';
import { kdIndicators, pullbackKdHints } from './pullback-kd';
import { segmentClosed, trendSegment, type TrendSegment } from './window';

export interface EntryInputs {
    signals: TrendSignal[];
    /** 已收 1m */
    m1: Candle[];
    m1Session: string[];
    m1SessionEnd: number[];
    /** 每根 1m 所屬 5m 桶在它之前是否已缺 1m */
    m1Hole: boolean[];
    /** 已收 5m 與其 TrendCore 狀態 */
    m5: Candle[];
    dir5: TrendState[];
    /** 1m 微型趨勢狀態（與 m1 對齊） */
    micro: TrendState[];
    asOf: number;
    p: EntryParams;
    /** 進場參數指紋（提示 ID 用） */
    key: string;
    chartMinutes?: number;
}

export interface EntryOutput {
    entries: EntryEvent[];
    /** 最新一段 5m 趨勢在各模式的狀態 */
    states: Partial<Record<EntryMode, EntryModeState>>;
}

export function computeEntries(inp: EntryInputs): EntryOutput {
    const { signals, m1, p, asOf } = inp;
    if (signals.length === 0) return { entries: [], states: {} };
    const atr1 = alignPoints(m1, atr(m1, 14));
    const highs = pivots(m1, p.pivotLeft, p.pivotRight, 'high');
    const lows = pivots(m1, p.pivotLeft, p.pivotRight, 'low');
    const kd = p.mode === 'PULLBACK_KD' ? kdIndicators(m1, inp.m1Session) : null;
    const entries: EntryEvent[] = [];
    let seg: TrendSegment | null = null;
    let latest: [EntryMode, ModeResult][] = [];
    for (const sig of signals) {
        seg = trendSegment(sig, { m1, m1SessionEnd: inp.m1SessionEnd, m1Hole: inp.m1Hole, m5: inp.m5, dir5: inp.dir5, windowBars: p.windowBars, chartMinutes: inp.chartMinutes });
        latest = [
            ['IMMEDIATE', immediateHints(seg, inp.key)],
            ['MICRO_TREND', microTrendHints(seg, m1, inp.micro, inp.key)],
            ['PRICE_STRUCTURE', priceStructureHints(seg, m1, atr1, highs, lows, p, inp.key)],
        ];
        if (kd) latest.push(['PULLBACK_KD', pullbackKdHints(seg, m1, kd, inp.key)]);
        for (const [, r] of latest) entries.push(...r.hints);
    }
    const closed = segmentClosed(seg!, asOf, p.windowBars);
    const fresh = freshAt(inp.m5[inp.m5.length - 1]?.time, asOf, inp.chartMinutes ?? 5);
    const hole = inp.m1Hole[m1.length - 1] === true;
    const states: Partial<Record<EntryMode, EntryModeState>> = {};
    for (const [mode, r] of latest) {
        states[mode] = {
            mode,
            active: closed === null,
            hints: r.hints.length,
            last: r.hints[r.hints.length - 1] ?? null,
            waiting: closed ?? (!fresh
                ? '5m 狀態過期（換盤或缺資料），等待下一根 5m 收棒'
                : hole ? '這根 5m 已缺 1m（資料不完整），等待下一根完整的 5m 收棒' : r.waiting),
        };
    }
    return { entries, states };
}
