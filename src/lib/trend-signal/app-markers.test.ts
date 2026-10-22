import { describe, expect, it } from 'vitest';
import type { BarsInput } from '../custom-runtime';
import { aggregate } from '../utils/kbars';
import type { Candle } from '../types/market';
import { sessionLabels, walkBars } from './fixtures.test-harness';
import { computeAppCustomTsp } from './app-custom';
import type { ExitReason } from './types';

const source = walkBars(sessionLabels('2026-09-01', 4), 11, { regime: 60 });
const chart5 = aggregate(source, 5);
const toInput = (bars: Candle[]): BarsInput => ({
    time: bars.map((b) => b.time), open: bars.map((b) => b.open), high: bars.map((b) => b.high),
    low: bars.map((b) => b.low), close: bars.map((b) => b.close), volume: bars.map((b) => b.volume),
});
// 預期值逐字寫死，不沿用實作的對應：出場文字沿用部位方向（tsp-app-1.5.1），三角形依平倉動作
const EXIT_KEY: Record<ExitReason, string> = {
    STOP: '虛擬停損出場', BREAKEVEN_STOP: '虛擬停損出場', TRAIL_STOP: '虛擬停損出場',
    TP2R: '虛擬2R出場', TP3R: '虛擬3R出場', REVERSAL: '虛擬反轉失效出場', TREND_INVALID: '虛擬反轉失效出場',
};
const EXIT_TEXT: Record<'LONG' | 'SHORT', Record<ExitReason, string>> = {
    LONG: {
        STOP: 'Buy 停損出場', BREAKEVEN_STOP: 'Buy 保本停損出場', TRAIL_STOP: 'Buy 移動停損出場',
        TP2R: 'Buy 2R 出場', TP3R: 'Buy 3R 出場', REVERSAL: 'Buy 反轉出場', TREND_INVALID: 'Buy 反轉失效出場',
    },
    SHORT: {
        STOP: 'Sell 停損出場', BREAKEVEN_STOP: 'Sell 保本停損出場', TRAIL_STOP: 'Sell 移動停損出場',
        TP2R: 'Sell 2R 出場', TP3R: 'Sell 3R 出場', REVERSAL: 'Sell 反轉出場', TREND_INVALID: 'Sell 反轉失效出場',
    },
};

function compute(bars: Candle[], riskHistory = 0) {
    const now = bars.at(-1)!.time + 300;
    return computeAppCustomTsp(toInput(bars), { qty: 3, budget: 100_000, riskHistory }, now);
}

describe('TSP App marker metadata', () => {
    it.each([
        ['1m', source],
        ['5m', chart5],
    ] as const)('%s entries and all exits align to non-empty output slots; trend switches stay unmarked', (tf, bars) => {
        const app = compute(bars);
        const times = bars.map((b) => b.time);
        const idx = (time: number) => times.indexOf(time);
        const marker = (key: string, time: number) => app.hints[key]?.markers?.[idx(time)];
        const res = app.result!;
        expect(res.signals.some((s) => s.kind === 'BUY')).toBe(true);
        expect(res.signals.some((s) => s.kind === 'SELL')).toBe(true);

        for (const signal of res.signals) {
            expect(app.outputs[signal.kind]![idx(signal.barTime)]).toBe(signal.close);
            expect(marker(signal.kind, signal.barTime)).toBeNull();
        }
        expect(res.trades.length).toBeGreaterThan(0);
        for (const trade of res.trades) {
            const entrySide = trade.direction === 'LONG' ? 'Buy' : 'Sell';
            const exitSide = trade.direction === 'LONG' ? 'Sell' : 'Buy';
            const entryKey = trade.direction === 'LONG' ? '虛擬進場多' : '虛擬進場空';
            expect(app.outputs[entryKey]![idx(trade.fillTime)]).toBe(trade.fillPrice);
            expect(marker(entryKey, trade.fillTime)).toEqual({ side: entrySide, text: `${entrySide} 進場` });
            for (const fill of trade.fills) {
                const key = EXIT_KEY[fill.reason];
                const at = idx(fill.time);
                expect(app.outputs[key]![at]).not.toBeNull();
                expect(marker(key, fill.time)).toEqual({ side: exitSide, text: EXIT_TEXT[trade.direction][fill.reason] });
            }
        }
        for (const [key, values] of Object.entries(app.outputs)) {
            values.forEach((value, i) => {
                if (value === null) expect(app.hints[key]?.markers?.[i]).toBeNull();
            });
        }
        for (const key of ['初始停損', '目前停損', '保本價', '1R', '2R', '3R']) {
            expect(app.hints[key]?.kind).toBe('dashed');
        }
        expect(app.hints['目前停損']?.plot).toBe('step');
    });

    it('keeps historical risk points, suppresses auxiliary markers, and drops future empty slots', () => {
        const history = compute(source, 1);
        expect(history.hints['初始停損']?.kind).toBe('points');
        expect(history.hints['目前停損']?.kind).toBe('points');
        expect(history.hints['目前停損']?.plot).toBeUndefined();

        const future = { ...source.at(-1)!, time: source.at(-1)!.time + 60 };
        const withFuture = [...source, future];
        const now = source.at(-1)!.time - 1;
        const futureApp = computeAppCustomTsp(toInput(withFuture), { qty: 3, budget: 100_000 }, now);
        for (const key of futureApp.order) {
            expect(futureApp.outputs[key]!.at(-1)).toBeNull();
            expect(futureApp.hints[key]?.markers?.at(-1)).toBeNull();
        }

        const auxBars = aggregate(source, 15);
        const aux = compute(auxBars);
        expect(aux.mode).toBe('aux');
        const auxOutputs = aux.order.filter((k) => aux.outputs[k]!.some((v) => v !== null));
        expect(auxOutputs.length).toBeGreaterThan(0);
        expect(auxOutputs.every((k) => k === '多方趨勢線' || k === '空方趨勢線')).toBe(true);
        for (const key of aux.order) expect(aux.hints[key]?.markers?.every((m) => m === null)).toBe(true);
    });
});
