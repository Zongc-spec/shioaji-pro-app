// src/lib/trend-signal/engine.test.ts — 整合驗收：A2 回放不重繪、A3 交替、A6 模組獨立、
// A8 週期切換不漂移、A9 確定性，以及規格必驗案例 1（未觸發不進場）、2（5m 反向立即平倉）、
// 4（未收完的 K 棒臨時反轉不產生訊號）。
import { describe, expect, it } from 'vitest';
import { aggregate } from '../utils/kbars';
import { DEFAULT_CONFIG } from './config';
import { firstAfter, lastAtOrBefore } from './core/bars';
import { runTrendSignal } from './engine';
import { sessionLabels, walkBars } from './fixtures.test-harness';
import { chartBucket, projectLines, projectMarkers } from './project';
import type { TrendSignal, TrendSignalConfig, TrendSignalInput, TrendSignalResult } from './types';

const labels = sessionLabels('2026-09-01', 4);
const m1 = walkBars(labels, 11, { regime: 60 });
const end = labels.at(-1)!;
const input = (over: Partial<TrendSignalInput> = {}): TrendSignalInput => ({
    bars1m: m1,
    asOf: end,
    securityType: 'FUT',
    symbol: 'TMFR1',
    contractMonth: '202609',
    tick: 1,
    pointValue: 10,
    config: DEFAULT_CONFIG,
    ...over,
});
const cfg = (patch: (c: TrendSignalConfig) => TrendSignalConfig) => patch(structuredClone(DEFAULT_CONFIG));
const core = (s: TrendSignal) => ({ id: s.id, kind: s.kind, barTime: s.barTime, close: s.close, line: s.line, atr: s.atr, index: s.index });
const full = runTrendSignal(input());

it('合成資料足以產生多個訊號、各模式觸發與虛擬部位（測試不空轉）', () => {
    expect(full.signals.length).toBeGreaterThan(8);
    for (const mode of ['IMMEDIATE', 'MICRO_TREND', 'PRICE_STRUCTURE'] as const) {
        expect(full.entries.some((e) => e.mode === mode && e.status === 'TRIGGERED')).toBe(true);
    }
    expect(full.trades.length).toBeGreaterThan(3);
});

it('A9 確定性：同一輸入兩次輸出完全相同', () => {
    expect(runTrendSignal(input())).toEqual(full);
});

it('A3 BUY／SELL 嚴格交替', () => {
    for (let i = 1; i < full.signals.length; i++) expect(full.signals[i]!.kind).not.toBe(full.signals[i - 1]!.kind);
});

describe('A2 回放不重繪', () => {
    const steps: TrendSignalResult[] = [];
    for (let k = 400; k < labels.length; k += 23) steps.push(runTrendSignal(input({ asOf: labels[k]! })));
    it('任一時點已出現的訊號，之後逐欄相同', () => {
        for (const r of steps) {
            expect(r.signals).toEqual(full.signals.filter((s) => s.barTime <= r.asOf));
        }
    });
    it('已定案（非 PENDING）的進場事件之後不變', () => {
        const byId = new Map(full.entries.map((e) => [e.id, e]));
        for (const r of steps) {
            for (const e of r.entries) if (e.status !== 'PENDING') expect(e).toEqual(byId.get(e.id));
        }
    });
    it('已發生的虛擬成交、出場與停損變更之後不變', () => {
        const byId = new Map(full.trades.map((t) => [t.id, t]));
        for (const r of steps) {
            for (const t of r.trades) {
                const f = byId.get(t.id)!;
                expect(t.fillPrice).toBe(f.fillPrice);
                expect(t.fills).toEqual(f.fills.filter((x) => x.time <= r.asOf));
                expect(t.stopHistory).toEqual(f.stopHistory.filter((x) => x.time <= r.asOf));
            }
        }
    });
});

describe('A6 模組獨立：訊號只由趨勢參數決定', () => {
    const base = full.signals.map(core);
    it.each([
        ['進場窗口', cfg((c) => ({ ...c, entry: { ...c.entry, windowBars: 1 } }))],
        ['1m 微型趨勢倍數', cfg((c) => ({ ...c, entry: { ...c.entry, microMult: 2.5 } }))],
        ['結構轉折參數', cfg((c) => ({ ...c, entry: { ...c.entry, pivotLeft: 4, pivotRight: 3, minPullbackAtr: 2 } }))],
        ['風控採用模式', cfg((c) => ({ ...c, entry: { ...c.entry, mode: 'PRICE_STRUCTURE' } }))],
        ['風控預算與口數', cfg((c) => ({ ...c, risk: { ...c.risk, budget: 300, qty: 5, stopAtr: 3 } }))],
        ['EMA 註記週期', cfg((c) => ({ ...c, note: { ...c.note, emaPeriod: 50 } }))],
    ])('改變%s，訊號逐筆相同', (_n, config) => {
        expect(runTrendSignal(input({ config })).signals.map(core)).toEqual(base);
    });
    it('關閉 15m／60m（只影響註記），訊號逐筆相同', () => {
        expect(runTrendSignal(input({ skipHtf: true })).signals.map(core)).toEqual(base);
    });
    it('改變趨勢參數才會改變訊號（對照組）', () => {
        const other = runTrendSignal(input({ config: cfg((c) => ({ ...c, trend: { ...c.trend, stMult: 2 } })) }));
        expect(other.signals.map(core)).not.toEqual(base);
    });
});

describe('A8 週期切換不漂移', () => {
    it('主圖 1m/5m/15m/60m：每個訊號都落在包含其收棒時間的那根 K 棒', () => {
        for (const tf of [1, 5, 15, 60]) {
            const chart = aggregate(full.m1.bars, tf);
            const marks = projectMarkers(full, new Set(chart.map((b) => b.time)), tf, []);
            const sigs = marks.filter((m) => m.kind === 'BUY' || m.kind === 'SELL');
            expect(sigs.map((m) => m.time)).toEqual(full.signals.map((s) => chartBucket(s.barTime, tf)));
        }
    });
    it('5m 主圖的趨勢線就是 5m 結果；1m 主圖每根只用當時已收的 5m', () => {
        const c5 = aggregate(full.m1.bars, 5);
        const l5 = projectLines(full, c5, 5);
        c5.forEach((b, i) => {
            const j = lastAtOrBefore(full.m5.bars, b.time);
            expect(l5.up[i]!.value ?? l5.down[i]!.value).toBe(full.t5.line[j]);
        });
        const l1 = projectLines(full, full.m1.bars, 1);
        full.m1.bars.forEach((b, i) => {
            const j = lastAtOrBefore(full.m5.bars, b.time);
            if (j >= 0) expect(full.m5.bars[j]!.time).toBeLessThanOrEqual(b.time);
            expect(l1.up[i]!.value ?? l1.down[i]!.value).toBe(j >= 0 ? full.t5.line[j] : undefined);
        });
    });
});

describe('規格必驗案例', () => {
    it('案例 4：進行中的 K 棒臨時暴漲暴跌，不影響訊號與進場事件', () => {
        const asOf = labels[2000]!;
        const quiet = runTrendSignal(input({ asOf }));
        const spike = runTrendSignal(input({ asOf, live: { time: asOf + 60, open: 1, high: 999999, low: 1, close: 999999, volume: 1 } }));
        expect(spike.signals).toEqual(quiet.signals);
        expect(spike.entries).toEqual(quiet.entries);
    });
    it('案例 1：每筆虛擬部位都來自已觸發的事件；未觸發的訊號（含逾期）沒有部位', () => {
        for (const mode of ['IMMEDIATE', 'MICRO_TREND', 'PRICE_STRUCTURE'] as const) {
            const r = runTrendSignal(input({ config: cfg((c) => ({ ...c, entry: { ...c.entry, mode } })) }));
            const entryById = new Map(r.entries.map((e) => [e.id, e]));
            const sigById = new Map(r.signals.map((s) => [s.id, s]));
            for (const t of r.trades) {
                const e = entryById.get(t.entryId)!;
                expect(e).toMatchObject({ mode, status: 'TRIGGERED' });
                expect(t.fillTime).toBeGreaterThan(e.barTime!);
                expect(t.fillTime).toBeLessThanOrEqual(sigById.get(t.signalId)!.sessionEnd);
            }
            const traded = new Set(r.trades.map((t) => t.signalId));
            for (const e of r.entries) if (e.mode === mode && e.status !== 'TRIGGERED') expect(traded.has(e.signalId)).toBe(false);
        }
    });
    it('案例 2：每次 5m 反向平倉都在反向訊號收棒後的第一根 1m 開盤', () => {
        // 預設停損（1.5 × 1m ATR）通常先於 5m 翻轉觸發；用寬停損讓反向平倉實際出現
        const r = runTrendSignal(input({ config: cfg((c) => ({ ...c, risk: { ...c.risk, stopAtr: 5, budget: 1_000_000 } })) }));
        let reversals = 0;
        for (const t of r.trades) {
            for (const f of t.fills) {
                if (f.reason !== 'REVERSAL') continue;
                reversals++;
                const s = r.signals.find((x) => x.direction !== t.direction && x.barTime < f.time && r.m1.bars[firstAfter(r.m1.bars, x.barTime)]!.time === f.time);
                expect(s).toBeDefined();
            }
        }
        expect(reversals).toBeGreaterThan(0);
    });
});
