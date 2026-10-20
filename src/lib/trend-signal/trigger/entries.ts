// src/lib/trend-signal/trigger/entries.ts — 對每個 5m 訊號計算所有進場模式的時機
// 事件（都會記錄以便比較；風控只採用設定的那一種）。只讀 5m 訊號與已收 1m。

import { atr } from '../../indicators';
import type { Candle } from '../../types/market';
import { alignPoints } from '../core/bars';
import type { EntryEvent, EntryMode, EntryParams, TrendDir, TrendSignal } from '../types';
import { immediateEntry, microTrendEntry, pivots, priceStructureEntry } from './modes';
import { kdIndicators, pullbackKdEntry } from './pullback-kd';
import { signalWindow } from './window';

export interface EntryInputs {
    signals: TrendSignal[];
    /** 已收 1m */
    m1: Candle[];
    m1Session: string[];
    /** 1m 微型趨勢方向（與 m1 對齊） */
    micro: TrendDir[];
    asOf: number;
    p: EntryParams;
    /** 進場參數指紋（事件 ID 用） */
    key: string;
}

export function computeEntries(inp: EntryInputs): EntryEvent[] {
    const { signals, m1, p, asOf } = inp;
    if (signals.length === 0) return [];
    const atr1 = alignPoints(m1, atr(m1, 14));
    const highs = pivots(m1, p.pivotLeft, p.pivotRight, 'high');
    const lows = pivots(m1, p.pivotLeft, p.pivotRight, 'low');
    const kd = kdIndicators(m1, inp.m1Session);
    const out: EntryEvent[] = [];
    signals.forEach((sig, k) => {
        const w = signalWindow(sig, signals[k + 1], m1, p.windowBars);
        const id = (mode: EntryMode) => `${sig.id}|${mode}#${inp.key}`;
        out.push(immediateEntry(id('IMMEDIATE'), sig, w, asOf));
        out.push(microTrendEntry(id('MICRO_TREND'), sig, w, m1, inp.micro, asOf));
        out.push(priceStructureEntry(id('PRICE_STRUCTURE'), sig, w, m1, atr1, highs, lows, p, asOf));
        out.push(pullbackKdEntry(id('PULLBACK_KD'), sig, w, m1, kd, asOf));
    });
    return out;
}
