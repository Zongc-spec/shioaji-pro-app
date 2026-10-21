import { describe, expect, it } from 'vitest';
import type { BarsInput } from '../custom-runtime';
import type { Candle } from '../types/market';
import { chartSession, computeChartCustomTsp, frameFromChart, inferChartMinutes, runChartSignal } from './chart-custom';
import { DEFAULT_CONFIG } from './config';
import { sessionLabels, T, walkBars } from './fixtures.test-harness';
import { runVirtual } from './risk/virtual';
import { trendTrack } from './trend/signals';
import type { EntryEvent, TrendSignal } from './types';

const DAY = 86400;
const toInput = (bars: Candle[]): BarsInput => ({
    time: bars.map((b) => b.time), open: bars.map((b) => b.open), high: bars.map((b) => b.high),
    low: bars.map((b) => b.low), close: bars.map((b) => b.close), volume: bars.map((b) => b.volume),
});
function chartBars(minutes: number): Candle[] {
    const daily = Array.from({ length: 280 }, (_, i) => T('2025-01-01') + i * DAY)
        .filter((t) => ![0, 6].includes(new Date(t * 1000).getUTCDay()));
    const labels = minutes === 1440 ? daily : [...new Set(sessionLabels('2026-08-03', 40)
        .map((t) => Math.ceil(t / (minutes * 60)) * minutes * 60))].slice(0, 360);
    return walkBars(labels, 11, { regime: 24, drift: 8, vol: 4 });
}
const nowFor = (bars: Candle[], minutes: number) => bars.at(-1)!.time + (minutes === 1440 ? 43200 : -10);
const LEVELS = ['初始停損', '目前停損', '保本價', '1R', '2R', '3R'];

describe('本圖週期輸入與時間界線', () => {
    it('以 GCD 而非最短間隔判定缺棒資料；午夜日線跨週末仍為 1440', () => {
        const base = T('2026-10-20T09:00:00');
        expect(inferChartMinutes([base, base + 600, base + 1500])).toBe(5);
        expect(inferChartMinutes([T('2026-10-16'), T('2026-10-19'), T('2026-10-20')])).toBe(1440);
        expect(inferChartMinutes([base, base + 600], 5)).toBe(5);
        for (const bad of [-1, 0.5, 1441, NaN, Infinity]) expect(() => inferChartMinutes([base], bad)).toThrow();
    });

    it('指定週期與 label 不對齊時拒絕，避免把 5m OHLC 假裝另一種週期', () => {
        expect(() => frameFromChart(toInput(chartBars(5)), { chartTf: 15 })).toThrow();
    });

    it('60m 的 14:00 label 歸日盤，06:00 label 歸前一夜盤', () => {
        expect(chartSession(T('2026-10-20T14:00:00'), 60)).toMatchObject({ key: '2026-10-20D', end: T('2026-10-20T13:45:00') });
        expect(chartSession(T('2026-10-21T06:00:00'), 60)).toMatchObject({ key: '2026-10-20N', end: T('2026-10-21T05:00:00') });
    });

    it('日線只在內部轉為日終；今天 OHLC 不得產生今天的已收訊號', () => {
        const bars = chartBars(1440);
        const now = nowFor(bars, 1440);
        const frame = frameFromChart(toInput(bars), {}, now);
        expect(frame.minutes).toBe(1440);
        expect(frame.confirmed.map((b) => b.time)).toEqual(bars.slice(0, -1).map((b) => b.time + DAY));
        expect(frame.live?.time).toBe(bars.at(-1)!.time + DAY);
        expect(frame.clock.openTime(frame.live!.time)).toBe(bars.at(-1)!.time);
        const changed = bars.map((b, i) => i === bars.length - 1 ? { ...b, high: b.high + 10000, low: b.low - 10000 } : b);
        const before = runChartSignal(frame);
        const after = runChartSignal(frameFromChart(toInput(changed), {}, now));
        expect(after.signals).toEqual(before.signals);
        expect(after.entries).toEqual(before.entries);
        expect(after.t5).toEqual(before.t5);
        const end = bars.at(-1)!.time + DAY;
        expect(frameFromChart(toInput(bars), {}, end + 9).live).not.toBeNull();
        expect(frameFromChart(toInput(bars), {}, end + 10).confirmed).toHaveLength(bars.length);
    });

    it.each([1, 5, 15, 60, 1440])('%im 的未來 OHLC 不可參與趨勢，亂序與重複映回原索引', (minutes) => {
        const bars = chartBars(minutes);
        const now = nowFor(bars, minutes);
        const baseline = computeChartCustomTsp(toInput(bars), {}, now);
        const indexes = [8, 3, 8, 0, ...bars.map((_, i) => i).filter((i) => i !== 8 && i !== 3 && i !== 0)];
        const shuffled = computeChartCustomTsp(toInput(indexes.map((i) => bars[i]!)), {}, now);
        expect(shuffled.result).toEqual(baseline.result);
        for (const key of baseline.order) expect(shuffled.outputs[key]).toEqual(indexes.map((i) => baseline.outputs[key]![i]));
        const future = { ...bars.at(-1)!, time: bars.at(-1)!.time + 40 * DAY, close: 99999, high: 100000 };
        const futureResult = computeChartCustomTsp(toInput([...bars, future]), {}, now);
        expect(futureResult.result).toEqual(baseline.result);
        for (const key of baseline.order) expect(futureResult.outputs[key]!.at(-1)).toBeNull();
    });
});

describe.each([1, 5, 15, 60, 1440])('本圖 %im 核心與輸出', (minutes) => {
    it.each([0, 1, 2])('核心 %i 直接用目前 OHLCV 重算，有實際虛擬交易', (algo) => {
        const bars = chartBars(minutes);
        const computed = computeChartCustomTsp(toInput(bars), { algo, budget: 100000, qty: 3, riskHistory: 1 }, nowFor(bars, minutes));
        expect(computed.frame.minutes).toBe(minutes);
        expect(computed.result.m5.bars).toEqual(computed.frame.confirmed);
        expect(computed.result.t5).toEqual(trendTrack(computed.frame.series, computed.frame.config.trend));
        expect(computed.result.signals.length).toBeGreaterThan(0);
        expect(computed.result.trades.length).toBeGreaterThan(0);
        expect(computed.outputs['初始停損']!.some((v) => v !== null)).toBe(true);
        expect(computed.order).toHaveLength(19);
        expect(computed.order).toContain('本圖微型提示');
        expect(computed.order).toContain('本圖結構提示');
        expect(computed.order).not.toContain('1m 微型提示');
        expect(computed.hints['多方趨勢線']?.kind).toBe('line');
        for (const key of LEVELS) expect(computed.hints[key]?.kind).toBe('points');
        for (const vt of computed.result.trades) {
            const history = vt.stopHistory.map((s) => s.stop);
            expect(history.every((s, i) => i === 0 || (vt.direction === 'LONG' ? s >= history[i - 1]! : s <= history[i - 1]!))).toBe(true);
            expect(vt.fillAt).toBe(vt.fillTime - minutes * 60);
            expect(vt.realizedNtd).toBeCloseTo(vt.realizedPoints * 10 - vt.costNtd, 8);
        }
    });
});

describe.each([0, 1, 2])('三核心與四種進場參數：algo=%i', (algo) => {
    it.each([0, 1, 2, 3])('mode=%i 只改下游進場／風控，保留本圖方向與訊號', (entryMode) => {
        const bars = chartBars(15);
        const now = nowFor(bars, 15);
        const baseline = computeChartCustomTsp(toInput(bars), { algo }, now);
        const changed = computeChartCustomTsp(toInput(bars), { algo, entryMode, qty: 3, budget: 100000, hintWindow: 3, stopAtr: 2, trailAtr: 1.5 }, now);
        expect(changed.result.signals).toEqual(baseline.result.signals);
        expect(changed.result.t5).toEqual(baseline.result.t5);
        expect(changed.result.trades.every((t) => t.entryMode === ['IMMEDIATE', 'MICRO_TREND', 'PRICE_STRUCTURE', 'PULLBACK_KD'][entryMode])).toBe(true);
        for (const key of LEVELS) expect(changed.hints[key]?.kind).toBe('line');
        const open = changed.result.snapshot.trade?.status === 'OPEN' ? changed.result.snapshot.trade : null;
        bars.forEach((b, i) => {
            if (!open || b.time < open.fillTime) for (const key of LEVELS) expect(changed.outputs[key]![i]).toBeNull();
        });
        const last = changed.result.t5.dir.length - 1;
        let start = last;
        while (start > 0 && changed.result.t5.dir[start - 1] === changed.result.t5.dir[last]
            && changed.frame.confirmed[start]!.time - changed.frame.confirmed[start - 1]!.time === 900
            && changed.frame.series.session[start] === changed.frame.series.session[start - 1]) start--;
        for (const key of ['多方趨勢線', '空方趨勢線']) expect(changed.outputs[key]!.slice(0, start).every((v) => v === null)).toBe(true);
    });
});

// 手刻訊號隔離 TrendCore，驗證 runVirtual 的時間、成交與風控語義。
function scenario(minutes: number, extra: [number, number, number, number][], opts: { missing?: boolean; live?: boolean; dailyWeekend?: boolean; priceOffset?: number } = {}) {
    const step = minutes * 60;
    const offset = opts.priceOffset ?? 0;
    const friday = T('2026-10-16') + DAY; // 日線 raw Friday 內部使用 Saturday 00:00 收盤 label。
    const labels = opts.dailyWeekend
        ? [...Array.from({ length: 40 }, (_, i) => friday - (39 - i) * DAY), T('2026-10-19') + DAY]
        : Array.from({ length: 40 + extra.length }, (_, i) => T('2026-10-20T09:00:00') + i * step + (opts.missing && i >= 40 ? step : 0));
    const candles = labels.map((time, i): Candle => {
        const [open, high, low, close] = i < 40 ? [100, 110, 90, 100] : extra[i - 40] ?? [100, 105, 95, 100];
        return { time, open: open + offset, high: high + offset, low: low + offset, close: close + offset, volume: 10 };
    });
    const live = opts.live ? candles.at(-1)! : null;
    const m1 = opts.live ? candles.slice(0, -1) : candles;
    const asOf = m1.at(-1)!.time;
    const series = { tf: minutes, bars: m1, lastMinute: m1.map((b) => b.time), session: m1.map(() => 'synthetic'), sessionEnd: m1.map(() => Infinity), missing: m1.map(() => 0) };
    const signal: TrendSignal = {
        id: 'synthetic-buy', kind: 'BUY', direction: 'LONG', index: 39, barTime: labels[39]!, session: 'synthetic', sessionEnd: Infinity,
        close: 100 + offset, line: undefined, atr: 20,
        notes: { ema: 'UNKNOWN', m15: 'UNKNOWN', m60: 'UNKNOWN', m15Align: 'NEUTRAL', m60Align: 'NEUTRAL', m15BarTime: null, m60BarTime: null, m15Stale: false, m60Stale: false, m15Incomplete: false, m60Incomplete: false },
    };
    const entry: EntryEvent = { id: 'synthetic-entry', kind: 'POTENTIAL_ENTRY_LONG', mode: 'IMMEDIATE', signalId: signal.id,
        direction: 'LONG', barTime: signal.barTime, refPrice: 100 + offset, seq: 1, reason: 'synthetic' };
    const next = new Map(labels.slice(0, -1).map((t, i) => [t, labels[i + 1]!]));
    return runVirtual({ m1, live, asOf, m1SessionEnd: series.sessionEnd, m5: series,
        t5: { tf: minutes, algo: 'supertrend', line: m1.map(() => undefined), dir: m1.map(() => 'LONG'), stopLine: true },
        signals: [signal], invalidations: [], entries: [entry], cfg: { ...DEFAULT_CONFIG.risk, budget: 100000, qty: 1 },
        tick: 1, pointValue: 10, taxRate: 0.00002, key: 'synthetic', clock: { baseLabel: `${minutes}m`, trendLabel: `${minutes}m`,
            openTime: (t) => t - step, isNext: (from, to) => opts.dailyWeekend ? next.get(from) === to : to === from + step } });
}

describe('本圖風控反例與手算', () => {
    it('日線 Friday 提示可在 Monday 可用日K開盤成交；盤中15m缺下一根則取消', () => {
        const weekendBars = walkBars([T('2026-10-16'), T('2026-10-19')], 11);
        const weekend = frameFromChart(toInput(weekendBars), {}, T('2026-10-19T12:00:00'));
        expect(weekend.clock.isNext(T('2026-10-17'), T('2026-10-20'))).toBe(true);
        expect(weekend.clock.openTime(T('2026-10-20'))).toBe(T('2026-10-19'));
        const daily = scenario(1440, [[100, 105, 95, 100]], { dailyWeekend: true });
        expect(daily.trades).toHaveLength(1);
        expect(daily.trades[0]).toMatchObject({ signalTime: T('2026-10-17'), fillTime: T('2026-10-20'), fillAt: T('2026-10-19'), fillPrice: 101 });
        const missing = scenario(15, [[100, 105, 95, 100]], { missing: true });
        expect(missing.trades).toEqual([]);
        expect(missing.events.some((e) => e.kind === 'WARN' && e.text.includes('缺資料'))).toBe(true);
    });

    it('15m 的 +1R 保本下一根生效，停損沿 stopHistory 單調且不追溯回填', () => {
        const vt = scenario(15, [[100, 105, 95, 100], [100, 135, 100, 130], [120, 125, 105, 110]]).trades[0]!;
        expect(vt.plan).toMatchObject({ entry: 101, stop: 71, riskPoints: 30, r1: 131, r2: 161, r3: 191 });
        expect(vt.stopHistory.map((s) => [s.time - vt.fillTime, s.stop, s.reason])).toEqual([[0, 71, 'initial'], [1800, 106, 'breakeven']]);
        expect(vt.fills[0]).toMatchObject({ price: 105, reason: 'BREAKEVEN_STOP' });
    });

    it('同棒停損與3R都觸及時停損優先，費稅依實際兩邊成交價手算', () => {
        const vt = scenario(60, [[100, 105, 95, 100], [100, 250, 60, 100]]).trades[0]!;
        expect(vt).toMatchObject({ fillPrice: 101, exitReason: 'STOP', hit: { r1: null, r2: null, r3: null } });
        expect(vt.fills).toEqual([{ time: vt.fillTime + 3600, at: 'intrabar', price: 70, qty: 1, reason: 'STOP' }]);
        // 稅 round(101×10×0.00002)+round(70×10×0.00002)=0；來回手續費24。
        expect(vt.costNtd).toBe(24);
        expect(vt.realizedNtd).toBe((70 - 101) * 10 - 24);
        const priced = scenario(60, [[100, 105, 95, 100], [100, 250, 60, 100]], { priceOffset: 23310 }).trades[0]!;
        expect(priced.fillPrice).toBe(23411);
        expect(priced.fills[0]?.price).toBe(23380);
        // round(23411×10×0.00002)=5；round(23380×10×0.00002)=5；手續費24。
        expect(priced.costNtd).toBe(34);
        expect(priced.realizedNtd).toBe((23380 - 23411) * 10 - 34);
    });

    it.each([15, 60, 1440])('%im live 可保護停損，不提前確認 target 或移動停損', (minutes) => {
        const target = scenario(minutes, [[100, 250, 95, 240]], { live: true }).trades[0]!;
        expect(target).toMatchObject({ status: 'OPEN', hit: { r1: null, r2: null, r3: null }, fills: [] });
        expect(target.stopHistory).toHaveLength(1);
        const stopped = scenario(minutes, [[100, 250, 60, 70]], { live: true }).trades[0]!;
        expect(stopped.exitReason).toBe('STOP');
        expect(stopped.fills[0]?.price).toBe(70);
    });
});
