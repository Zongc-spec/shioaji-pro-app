// src/lib/trend-signal/engine.test.ts — 整合驗收：A2 回放不重繪、A3 每次切換一個事件、A6 模組獨立、
// A8 週期切換不漂移、A9 確定性、三個 TrendCore 都能跑；Gate 1 的資料缺洞、歷史回補、隔夜；
// Gate 2 的 1m 提示只在 5m 同向且未過期時出現；規格必驗案例 1（沒有提示不進場）、
// 2（5m 反向／失效立即平倉）、4（未收完的 K 棒臨時反轉不產生訊號）。
import { describe, expect, it } from 'vitest';
import { aggregate } from '../utils/kbars';
import { configFromParams, DEFAULT_CONFIG } from './config';
import { firstAfter, freshAt, lastAtOrBefore } from './core/bars';
import { runTrendSignal } from './engine';
import { sessionLabels, walkBars } from './fixtures.test-harness';
import { chartBucket, GAP_COLOR, projectLines, projectMarkers, splitTrendLines } from './project';
import type { TrendAlgoId, TrendSignal, TrendSignalConfig, TrendSignalInput, TrendSignalResult } from './types';

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
    taxRate: 0.00002,
    config: DEFAULT_CONFIG,
    ...over,
});
const cfg = (patch: (c: TrendSignalConfig) => TrendSignalConfig) => patch(structuredClone(DEFAULT_CONFIG));
const withAlgo = (algo: TrendAlgoId) => cfg((c) => ({ ...c, trend: { ...c.trend, algo } }));
const core = (s: TrendSignal) => ({ id: s.id, kind: s.kind, barTime: s.barTime, close: s.close, line: s.line, atr: s.atr, index: s.index });
const full = runTrendSignal(input());

it('合成資料足以產生多個訊號、各模式提示（含同段多次）與虛擬部位（測試不空轉）', () => {
    expect(full.signals.length).toBeGreaterThan(8);
    for (const mode of ['IMMEDIATE', 'MICRO_TREND', 'PRICE_STRUCTURE'] as const) {
        expect(full.entries.some((e) => e.mode === mode)).toBe(true);
    }
    expect(full.entries.some((e) => e.mode === 'MICRO_TREND' && e.seq > 1)).toBe(true);
    expect(full.trades.length).toBeGreaterThan(3);
});

it('A9 確定性：同一輸入兩次輸出完全相同（重算相同 signal ID）', () => {
    expect(runTrendSignal(input())).toEqual(full);
});

it('V1.0 已存實例的舊參數鍵（windowBars=3、microMult=1）不沿用：V1.1 預設為整段趨勢、1m 倍數 3', () => {
    const c = configFromParams({ windowBars: 3, microMult: 1 });
    expect(c.entry).toMatchObject({ windowBars: 0, microMult: 3 });
    expect(configFromParams({ hintWindow: 3, microStMult: 1 }).entry).toMatchObject({ windowBars: 3, microMult: 1 });
});

describe.each(['supertrend', 'donchian', 'kama'] as TrendAlgoId[])('TrendCore %s 接上整條管線', (algo) => {
    const r = runTrendSignal(input({ config: withAlgo(algo) }));
    it('有訊號；1m 微型趨勢與 5m 同一演算法家族', () => {
        expect(r.signals.length).toBeGreaterThan(3);
        expect(r.t1.algo).toBe(algo);
        expect(r.t5.algo).toBe(algo);
    });
    it('A3 每次狀態切換只有一個事件：只有會輸出 NEUTRAL 的演算法有失效事件', () => {
        const ev = [...r.signals.map((s) => ({ t: s.barTime, k: s.kind as string })), ...r.invalidations.map((x) => ({ t: x.barTime, k: `INV_${x.from}` }))]
            .sort((a, b) => a.t - b.t);
        expect(new Set(ev.map((e) => e.t)).size).toBe(ev.length);
        for (let i = 1; i < ev.length; i++) {
            if (ev[i]!.k === 'BUY') expect(ev[i - 1]!.k).not.toBe('BUY');
            if (ev[i]!.k === 'SELL') expect(ev[i - 1]!.k).not.toBe('SELL');
        }
        if (algo === 'donchian') expect(r.invalidations.length).toBeGreaterThan(0);
        else expect(r.invalidations).toEqual([]);
    });
});

describe('A2 回放不重繪', () => {
    const steps: TrendSignalResult[] = [];
    for (let k = 400; k < labels.length; k += 23) steps.push(runTrendSignal(input({ asOf: labels[k]! })));
    it('任一時點已出現的訊號與失效，之後逐欄相同', () => {
        for (const r of steps) {
            expect(r.signals).toEqual(full.signals.filter((s) => s.barTime <= r.asOf));
            expect(r.invalidations).toEqual(full.invalidations.filter((x) => x.barTime <= r.asOf));
        }
    });
    it('1m 提示產生後不變，也不會事後補出更早的提示', () => {
        for (const r of steps) expect(r.entries).toEqual(full.entries.filter((e) => e.barTime <= r.asOf));
    });
    it('Donchian＋ATR 也不重繪（含失效事件）', () => {
        const c = withAlgo('donchian');
        const all = runTrendSignal(input({ config: c }));
        for (let k = 500; k < labels.length; k += 97) {
            const r = runTrendSignal(input({ asOf: labels[k]!, config: c }));
            expect(r.signals).toEqual(all.signals.filter((s) => s.barTime <= r.asOf));
            expect(r.invalidations).toEqual(all.invalidations.filter((x) => x.barTime <= r.asOf));
            expect(r.entries).toEqual(all.entries.filter((e) => e.barTime <= r.asOf));
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
        ['提示範圍（post-flip 窗口）', cfg((c) => ({ ...c, entry: { ...c.entry, windowBars: 1 } }))],
        ['1m 微型趨勢參數', cfg((c) => ({ ...c, entry: { ...c.entry, microMult: 2.5, microDcLength: 10, microKamaHyst: 0.6 } }))],
        ['結構轉折參數', cfg((c) => ({ ...c, entry: { ...c.entry, pivotLeft: 4, pivotRight: 3, minPullbackAtr: 2 } }))],
        ['風控採用模式（含先前策略假說）', cfg((c) => ({ ...c, entry: { ...c.entry, mode: 'PULLBACK_KD' } }))],
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
    it('風控採用模式不改變任何提示 ID（只增減是否計算先前策略假說）', () => {
        const r = runTrendSignal(input({ config: cfg((c) => ({ ...c, entry: { ...c.entry, mode: 'MICRO_TREND' } })) }));
        expect(r.entries.map((e) => e.id)).toEqual(full.entries.map((e) => e.id));
        expect(full.entries.some((e) => e.mode === 'PULLBACK_KD')).toBe(false);
    });
});

describe('Gate 2：1m 提示只在 5m 同向、未過期時出現（不與 5m BUY／SELL 混淆）', () => {
    for (const algo of ['supertrend', 'donchian', 'kama'] as TrendAlgoId[]) {
        it(`${algo}：每個提示的當時 5m 狀態與提示同向且未過期，不在該盤最後一根`, () => {
            const r = runTrendSignal(input({ config: withAlgo(algo) }));
            const sigById = new Map(r.signals.map((s) => [s.id, s]));
            expect(r.entries.length).toBeGreaterThan(0);
            for (const e of r.entries) {
                const s = sigById.get(e.signalId)!;
                expect(e.direction).toBe(s.direction);
                expect(e.kind).toBe(e.direction === 'LONG' ? 'POTENTIAL_ENTRY_LONG' : 'POTENTIAL_ENTRY_SHORT');
                if (e.mode === 'IMMEDIATE') {
                    expect(e.barTime).toBe(s.barTime);
                    continue;
                }
                expect(e.barTime).toBeGreaterThan(s.barTime);
                const j = lastAtOrBefore(r.m5.bars, e.barTime);
                expect(r.t5.dir[j]).toBe(e.direction);
                expect(freshAt(r.m5.bars[j]!.time, e.barTime, 5)).toBe(true);
                const i1 = lastAtOrBefore(r.m1.bars, e.barTime);
                expect(e.barTime).toBeLessThan(r.m1.sessionEnd[i1]!);
            }
        });
    }
    it('post-flip 窗口：所有提示都在翻轉後 N 根 5m 內、且不跨盤', () => {
        const r = runTrendSignal(input({ config: cfg((c) => ({ ...c, entry: { ...c.entry, windowBars: 3 } })) }));
        const sigById = new Map(r.signals.map((s) => [s.id, s]));
        for (const e of r.entries) {
            const s = sigById.get(e.signalId)!;
            expect(e.barTime).toBeLessThanOrEqual(Math.min(s.barTime + 900, s.sessionEnd));
        }
        expect(r.entries.length).toBeLessThan(full.entries.length);
    });
});

describe('Gate 1：資料缺洞、歷史回補、隔夜', () => {
    // 第二個交易日 10:00–10:40 的 1m 缺失（例：斷線）
    const gapFrom = labels.findIndex((t) => new Date(t * 1000).toISOString().startsWith('2026-09-02T10:01'));
    const gapTo = labels.findIndex((t) => new Date(t * 1000).toISOString().startsWith('2026-09-02T10:40'));
    const gapped = m1.filter((_, i) => i < gapFrom || i > gapTo);
    const g = runTrendSignal(input({ bars1m: gapped }));
    const gapStart = m1[gapFrom]!.time;
    const gapEnd = m1[gapTo]!.time;
    it('缺洞前的訊號與提示不受影響；缺洞內沒有任何事件', () => {
        expect(g.signals.filter((s) => s.barTime < gapStart)).toEqual(full.signals.filter((s) => s.barTime < gapStart));
        expect(g.entries.filter((e) => e.barTime < gapStart)).toEqual(full.entries.filter((e) => e.barTime < gapStart));
        expect(g.signals.some((s) => s.barTime >= gapStart && s.barTime <= gapEnd)).toBe(false);
        expect(g.entries.some((e) => e.barTime >= gapStart && e.barTime <= gapEnd)).toBe(false);
    });
    it('缺洞後第一根 5m 收棒前 5m 過期：不產生 1m 提示', () => {
        const resume = gapped.find((b) => b.time > gapEnd)!.time;
        const firstClose = g.m5.bars.find((b) => b.time >= resume)!.time;
        expect(g.entries.some((e) => e.mode !== 'IMMEDIATE' && e.barTime >= resume && e.barTime < firstClose)).toBe(false);
    });
    it('歷史回補：補齊資料後重算，結果與完整資料一次算出的完全相同（沒有殘留狀態）', () => {
        expect(runTrendSignal(input({ bars1m: [...gapped, ...m1.slice(gapFrom, gapTo + 1)] }))).toEqual(full);
    });
    it('隔夜／午休換盤：新盤第一根 5m 收棒前沒有 1m 提示', () => {
        for (const e of full.entries) {
            if (e.mode === 'IMMEDIATE') continue;
            const i1 = lastAtOrBefore(full.m1.bars, e.barTime);
            const sessStart = full.m1.bars.findIndex((b, k) => full.m1.session[k] === full.m1.session[i1]);
            const firstClose = full.m5.bars.find((b) => b.time >= full.m1.bars[sessStart]!.time)!.time;
            expect(e.barTime).toBeGreaterThanOrEqual(firstClose);
        }
    });
});

describe('A8 週期切換不漂移', () => {
    it('主圖 1m/5m/15m/60m：每個訊號都落在包含其收棒時間的那根 K 棒', () => {
        for (const tf of [1, 5, 15, 60]) {
            const chart = aggregate(full.m1.bars, tf);
            const marks = projectMarkers(full, new Set(chart.map((b) => b.time)), tf, []);
            const sigs = marks.filter((m) => m.kind === 'BUY' || m.kind === 'SELL');
            expect(sigs.map((m) => m.time)).toEqual(full.signals.map((s) => chartBucket(s.barTime, tf)));
            expect(sigs.every((m) => m.text.startsWith('5m '))).toBe(true);
        }
    });
    it('1m 提示換到 5m 以上主圖仍標示原始 1m 觸發時間（不與 BUY／SELL 混淆）', () => {
        const chart = aggregate(full.m1.bars, 15);
        const marks = projectMarkers(full, new Set(chart.map((b) => b.time)), 15, ['MICRO_TREND']);
        const hints = marks.filter((m) => m.kind === 'ENTRY_LONG' || m.kind === 'ENTRY_SHORT');
        const micro = full.entries.filter((e) => e.mode === 'MICRO_TREND');
        expect(hints.length).toBe(micro.length);
        for (const m of hints) {
            const e = micro.find((x) => x.id === m.id)!;
            expect(m.time).toBe(chartBucket(e.barTime, 15));
            expect(m.text).toMatch(/^ENTRY M \d\d:\d\d$/);
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

describe('趨勢線斷線（lightweight-charts 折線不因 whitespace 斷開）', () => {
    it('看得見的線段兩端都在同一段同方向區間：翻轉、失效時不畫連接線', () => {
        for (const algo of ['supertrend', 'donchian'] as TrendAlgoId[]) {
            const r = runTrendSignal(input({ config: withAlgo(algo) }));
            const times = r.m5.bars.map((b) => b.time);
            const { up, down } = splitTrendLines(times, r.t5.line, r.t5.dir);
            let visible = 0;
            for (let i = 0; i + 1 < times.length; i++) {
                if (up[i]!.value !== undefined && up[i]!.color === undefined) {
                    visible++;
                    expect([r.t5.dir[i], r.t5.dir[i + 1]]).toEqual(['LONG', 'LONG']);
                }
                if (down[i]!.value !== undefined && down[i]!.color === undefined) {
                    expect([r.t5.dir[i], r.t5.dir[i + 1]]).toEqual(['SHORT', 'SHORT']);
                }
            }
            expect(visible).toBeGreaterThan(50);
        }
    });
    it('非生效側與每段最後一點透明，點值就是當下的趨勢線；NEUTRAL 沒有點', () => {
        const { up, down } = splitTrendLines([1, 2, 3, 4], [10, 11, 20, 19], ['LONG', 'LONG', 'SHORT', 'SHORT']);
        expect(up).toEqual([{ time: 1, value: 10 }, { time: 2, value: 11, color: GAP_COLOR }, { time: 3, value: 20, color: GAP_COLOR }, { time: 4, value: 19, color: GAP_COLOR }]);
        expect(down).toEqual([{ time: 1, value: 10, color: GAP_COLOR }, { time: 2, value: 11, color: GAP_COLOR }, { time: 3, value: 20 }, { time: 4, value: 19 }]);
        expect(splitTrendLines([1], [undefined], ['UNKNOWN']).up).toEqual([{ time: 1 }]);
        const n = splitTrendLines([1, 2, 3], [10, undefined, 12], ['LONG', 'NEUTRAL', 'LONG']);
        expect(n.up).toEqual([{ time: 1, value: 10, color: GAP_COLOR }, { time: 2 }, { time: 3, value: 12 }]);
    });
});

describe('規格必驗案例', () => {
    it('案例 4：進行中的 K 棒臨時暴漲暴跌，不影響訊號與提示', () => {
        const asOf = labels[2000]!;
        const quiet = runTrendSignal(input({ asOf }));
        const spike = runTrendSignal(input({ asOf, live: { time: asOf + 60, open: 1, high: 999999, low: 1, close: 999999, volume: 1 } }));
        expect(spike.signals).toEqual(quiet.signals);
        expect(spike.entries).toEqual(quiet.entries);
    });
    it('案例 1：每筆虛擬部位都來自風控採用模式的提示，在提示之後、同一盤內成交', () => {
        for (const mode of ['IMMEDIATE', 'MICRO_TREND', 'PRICE_STRUCTURE'] as const) {
            const r = runTrendSignal(input({ config: cfg((c) => ({ ...c, entry: { ...c.entry, mode } })) }));
            const entryById = new Map(r.entries.map((e) => [e.id, e]));
            for (const t of r.trades) {
                const e = entryById.get(t.entryId)!;
                expect(e.mode).toBe(mode);
                expect(t.fillTime).toBeGreaterThan(e.barTime);
                const i1 = lastAtOrBefore(r.m1.bars, e.barTime);
                expect(t.fillTime).toBeLessThanOrEqual(r.m1.sessionEnd[i1]!);
            }
            // 沒有該模式提示的趨勢段沒有部位
            const hinted = new Set(r.entries.filter((e) => e.mode === mode).map((e) => e.signalId));
            for (const t of r.trades) expect(hinted.has(t.signalId)).toBe(true);
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
    it('案例 2（失效）：Donchian＋ATR 的 5m 失效平倉在失效收棒後的第一根 1m 開盤', () => {
        const r = runTrendSignal(input({ config: cfg((c) => ({ ...c, trend: { ...c.trend, algo: 'donchian' }, risk: { ...c.risk, stopAtr: 5, budget: 1_000_000 } })) }));
        let exits = 0;
        for (const t of r.trades) {
            for (const f of t.fills) {
                if (f.reason !== 'TREND_INVALID') continue;
                exits++;
                const x = r.invalidations.find((v) => v.from === t.direction && v.barTime < f.time && r.m1.bars[firstAfter(r.m1.bars, v.barTime)]!.time === f.time);
                expect(x).toBeDefined();
            }
        }
        expect(exits).toBeGreaterThan(0);
    });
    it('期交稅：已實現損益 = 點數 × 每點價值 − 手續費 − 兩邊期交稅', () => {
        const t = full.trades.find((x) => x.status === 'CLOSED' && x.fills.length === 1)!;
        const f = t.fills[0]!;
        const sign = t.direction === 'LONG' ? 1 : -1;
        const tax = Math.round(t.fillPrice * 10 * f.qty * 0.00002) + Math.round(f.price * 10 * f.qty * 0.00002);
        expect(t.realizedNtd).toBeCloseTo(sign * (f.price - t.fillPrice) * f.qty * 10 - 24 * f.qty - tax, 6);
    });
});
