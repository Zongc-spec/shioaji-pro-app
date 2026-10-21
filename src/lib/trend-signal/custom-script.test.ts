// 真正 App 執行器跑產出的單檔；數值預期來自本圖核心交易與獨立逐根投影。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCustom, type BarsInput, type CustomRunResult } from '../custom-runtime';
import type { Candle } from '../types/market';
import { frameFromChart, runChartSignal } from './chart-custom';
import { sessionLabels, T, walkBars } from './fixtures.test-harness';
import { trendTrack } from './trend/signals';

const SOURCE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/trend-signal-pro-custom.js'), 'utf8');
const DAY = 86400;
const KEYS = ['多方趨勢線', '空方趨勢線', 'BUY', 'SELL', '失效', '本圖微型提示', '本圖結構提示',
    '初始停損', '目前停損', '保本價', '1R', '2R', '3R', '虛擬進場多', '虛擬進場空',
    '虛擬停損出場', '虛擬2R出場', '虛擬3R出場', '虛擬反轉失效出場'];
const LEVELS = ['初始停損', '目前停損', '保本價', '1R', '2R', '3R'];
const toInput = (bars: Candle[]): BarsInput => ({
    time: bars.map((b) => b.time), open: bars.map((b) => b.open), high: bars.map((b) => b.high),
    low: bars.map((b) => b.low), close: bars.map((b) => b.close), volume: bars.map((b) => b.volume),
});
function chartBars(minutes: number): Candle[] {
    const labels = minutes === 1440
        ? Array.from({ length: 280 }, (_, i) => T('2025-01-01') + i * DAY)
            .filter((t) => ![0, 6].includes(new Date(t * 1000).getUTCDay()))
        : [...new Set(sessionLabels('2026-08-03', 40).map((t) => Math.ceil(t / (minutes * 60)) * minutes * 60))].slice(0, 360);
    return walkBars(labels, 11, { regime: 24, drift: 8, vol: 4 });
}
const samples = new Map([1, 5, 15, 60, 1440].map((minutes) => [minutes, chartBars(minutes)]));
const setNow = (now: number) => vi.setSystemTime((now - 8 * 3600) * 1000);
function script(bars: Candle[], params: Record<string, number>, now: number): CustomRunResult {
    setNow(now);
    const result = runCustom(SOURCE, toInput(bars), params);
    expect(result.error).toBeUndefined();
    expect(result.order).toEqual(KEYS);
    return result;
}

/** 不呼叫 projectCustomTsp：獨立從事件、部位生命週期與生效停損建立預期。 */
function expectNumericProjection(app: CustomRunResult, frame: ReturnType<typeof frameFromChart>, result: ReturnType<typeof runChartSignal>, bars: Candle[]) {
    const mapped = bars.map((b) => frame.daily ? b.time + DAY : b.time);
    const marks = Object.fromEntries(KEYS.filter((key) => !LEVELS.includes(key) && !key.endsWith('趨勢線'))
        .map((key) => [key, mapped.map((): number | null => null)]));
    const put = (key: string, time: number, price: number) => {
        mapped.forEach((t, i) => { if (t === time) marks[key]![i] = price; });
    };
    for (const s of result.signals) put(s.kind, s.barTime, s.close);
    for (const x of result.invalidations) put('失效', x.barTime, frame.confirmed[x.index]!.close);
    for (const e of result.entries) {
        if (e.mode === 'MICRO_TREND') put('本圖微型提示', e.barTime, e.refPrice);
        if (e.mode === 'PRICE_STRUCTURE') put('本圖結構提示', e.barTime, e.refPrice);
    }
    for (const vt of result.trades) {
        put(vt.direction === 'LONG' ? '虛擬進場多' : '虛擬進場空', vt.fillTime, vt.fillPrice);
        for (const fill of vt.fills) {
            const key = fill.reason === 'TP2R' ? '虛擬2R出場' : fill.reason === 'TP3R' ? '虛擬3R出場'
                : ['REVERSAL', 'TREND_INVALID'].includes(fill.reason) ? '虛擬反轉失效出場' : '虛擬停損出場';
            put(key, fill.time, fill.price);
        }
    }
    for (const [key, expected] of Object.entries(marks)) expect(app.outputs[key]).toEqual(expected);
    mapped.forEach((time, i) => {
        const active = result.trades.filter((vt) => vt.fillTime <= time && (vt.closedAt === null || vt.closedAt >= time)).at(-1);
        const stop = active?.stopHistory.filter((s) => s.time <= time).at(-1)?.stop;
        const expected = active ? [active.plan.stop, stop ?? active.plan.stop, active.plan.breakevenStop, active.plan.r1, active.plan.r2, active.plan.r3] : LEVELS.map(() => null);
        LEVELS.forEach((key, j) => expect(app.outputs[key]![i]).toBe(expected[j]));
    });
    const track = trendTrack(frame.series, frame.config.trend);
    expect(result.t5).toEqual(track);
    const last = track.dir.length - 1;
    let start = last;
    while (start > 0 && track.dir[start - 1] === track.dir[last]
        && (frame.daily || (frame.confirmed[start]!.time - frame.confirmed[start - 1]!.time === frame.seconds
            && frame.series.session[start] === frame.series.session[start - 1]))) start--;
    mapped.forEach((time, i) => {
        let j = frame.confirmed.length - 1;
        while (j >= 0 && frame.confirmed[j]!.time > Math.min(time, frame.asOf)) j--;
        const show = j >= start && j >= 0;
        expect(app.outputs['多方趨勢線']![i]).toBe(show && track.dir[j] === 'LONG' ? track.line[j] ?? null : null);
        expect(app.outputs['空方趨勢線']![i]).toBe(show && track.dir[j] === 'SHORT' ? track.line[j] ?? null : null);
    });
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

describe.each([1, 5, 15, 60, 1440])('產出單檔在 App 真執行器：%im', (minutes) => {
    it.each([0, 1, 2].flatMap((algo) => [0, 1, 2].map((entryMode) => [algo, entryMode] as const)))('核心 %i／進場 %i 的圖線、成交價與停損歷史逐根一致', (algo, entryMode) => {
        const bars = samples.get(minutes)!;
        const now = bars.at(-1)!.time + (minutes === 1440 ? 43200 : -10);
        const params = { algo, entryMode, budget: 100000, qty: 3, riskHistory: 1 };
        const frame = frameFromChart(toInput(bars), params, now);
        const core = runChartSignal(frame);
        expect(core.signals.length).toBeGreaterThan(0);
        if (entryMode === 0) expect(core.trades.length).toBeGreaterThan(0);
        const app = script(bars, params, now);
        expectNumericProjection(app, frame, core, bars);
        expect(app.hints['多方趨勢線']?.kind).toBe('line');
        for (const key of LEVELS) expect(app.hints[key]?.kind).toBe('points');
        for (const key of KEYS.slice(13)) expect(app.hints[key]?.kind).toBe('points');
        for (const vt of core.trades) {
            expect(vt.realizedNtd).toBeCloseTo(vt.realizedPoints * 10 - vt.costNtd, 8);
            expect(vt.fillAt).toBe(vt.fillTime - minutes * 60);
        }
    });
});

describe('單檔的顯示與錯誤界線', () => {
    it('預設只畫目前持倉風控線；歷史進出 marker 仍保留且用 points', () => {
        const bars = samples.get(15)!;
        const now = bars.at(-1)!.time - 10;
        const params = { budget: 100000, qty: 3 };
        const core = runChartSignal(frameFromChart(toInput(bars), params, now));
        const app = script(bars, params, now);
        const open = core.snapshot.trade?.status === 'OPEN' ? core.snapshot.trade : null;
        for (const key of LEVELS) {
            expect(app.hints[key]?.kind).toBe('line');
            bars.forEach((b, i) => { if (!open || b.time < open.fillTime) expect(app.outputs[key]![i]).toBeNull(); });
        }
        expect(core.trades.some((vt) => vt.status === 'CLOSED')).toBe(true);
        for (const vt of core.trades) {
            expect(app.outputs[vt.direction === 'LONG' ? '虛擬進場多' : '虛擬進場空']![bars.findIndex((b) => b.time === vt.fillTime)]).toBe(vt.fillPrice);
        }
    });

    it('當前日線的大幅高低變動不提前發訊號、提示或確認停利', () => {
        const bars = samples.get(1440)!;
        const now = bars.at(-1)!.time + 43200;
        const changed = bars.map((b, i) => i === bars.length - 1 ? { ...b, high: b.high + 10000, low: b.low - 10000 } : b);
        const before = script(bars, { riskHistory: 1 }, now);
        const after = script(changed, { riskHistory: 1 }, now);
        for (const key of ['BUY', 'SELL', '失效', '本圖微型提示', '本圖結構提示', '虛擬2R出場', '虛擬3R出場']) expect(after.outputs[key]).toEqual(before.outputs[key]);
        for (const key of ['BUY', 'SELL', '失效', '本圖微型提示', '本圖結構提示', '虛擬2R出場', '虛擬3R出場']) expect(after.outputs[key]!.at(-1)).toBeNull();
    });

    it('非法 metadata、chartTf、riskHistory 透過執行器明確報錯', () => {
        const bars = samples.get(5)!;
        setNow(bars.at(-1)!.time);
        const invalid: Record<string, number>[] = [{ tick: NaN }, { pointValue: Infinity }, { taxRate: -1 }, { chartTf: 0.5 }, { chartTf: 1441 }, { riskHistory: 2 }];
        for (const params of invalid) {
            expect(runCustom(SOURCE, toInput(bars), params).error).toBeTruthy();
        }
    });

    it('空白與單根暖身仍提供19輸出，不以5m拒絕替代支援任意週期', () => {
        for (const bars of [[], [samples.get(60)![0]!]]) {
            const app = script(bars, { chartTf: 60 }, T('2026-10-20T10:00:00'));
            for (const key of KEYS) expect(app.outputs[key]).toEqual(bars.map(() => null));
        }
    });

    it('單檔不包含網路、持久儲存或原生送單入口', () => {
        expect(SOURCE).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|localStorage|__TAURI_INTERNALS__|place_order|cancel_order|update_price)\b/);
    });
});
