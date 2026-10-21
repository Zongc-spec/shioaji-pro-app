import { describe, expect, it } from 'vitest';
import type { BarsInput } from '../custom-runtime';
import type { Candle } from '../types/market';
import { aggregate } from '../utils/kbars';
import { configFromParams, DEFAULT_CONFIG } from './config';
import { computeCustomTsp, inputFromCustomBars, projectCustomTsp } from './custom-adapter';
import { buildTf, lastAtOrBefore } from './core/bars';
import { runTrendSignal } from './engine';
import { sessionLabels, T, walkBars } from './fixtures.test-harness';
import { planRisk } from './risk/plan';
import { runVirtual } from './risk/virtual';
import type { EntryEvent, TrendSignal, TrendSignalResult, VirtualTrade } from './types';

const KEYS = [
    '多方趨勢線', '空方趨勢線', 'BUY', 'SELL', '失效', '1m 微型提示', '1m 結構提示',
    '初始停損', '目前停損', '保本價', '1R', '2R', '3R', '虛擬進場多', '虛擬進場空',
    '虛擬停損出場', '虛擬2R出場', '虛擬3R出場', '虛擬反轉失效出場',
];
const LEVELS = ['初始停損', '目前停損', '保本價', '1R', '2R', '3R'];
const MARKS = KEYS.slice(13);
const toInput = (bars: Candle[]): BarsInput => ({
    time: bars.map((b) => b.time), open: bars.map((b) => b.open), high: bars.map((b) => b.high),
    low: bars.map((b) => b.low), close: bars.map((b) => b.close), volume: bars.map((b) => b.volume),
});
const bar = (time: number, open = 100, high = 110, low = 90, close = 100): Candle =>
    ({ time, open, high, low, close, volume: 10 });
const t0 = T('2026-10-20T09:00:00');
const times = Array.from({ length: 8 }, (_, i) => t0 + i * 60);
const sample = walkBars(sessionLabels('2026-09-01', 4), 11, { regime: 60 });
const INVALID_METADATA: [string, number][] = [
    ['tick', 0], ['tick', -1], ['tick', NaN], ['tick', Infinity],
    ['pointValue', 0], ['pointValue', -10], ['pointValue', NaN], ['pointValue', Infinity],
    ['taxRate', -0.01], ['taxRate', NaN], ['taxRate', Infinity],
];
const PARAM_CASES: Record<string, number>[] = [
    { entryMode: 0, qty: 1, singleExit: 2, budget: 100000 },
    { entryMode: 1, qty: 3, tierMode: 1, tp2Lots: 1, tp3Lots: 1, budget: 100000, stopAtr: 2, trailAtr: 1.5 },
    { entryMode: 2, qty: 2, budget: 100000, hintWindow: 3, pivotLeft: 3, pivotRight: 2, minPullbackAtr: 1 },
    { entryMode: 3, qty: 1, singleExit: 3, budget: 100, slipTicks: 2, feePerSide: 21 },
];

function emptyResult(): TrendSignalResult {
    return runTrendSignal({
        bars1m: [], asOf: times.at(-1)!, securityType: 'FUT', symbol: 'TMF', contractMonth: 'CUSTOM',
        tick: 1, pointValue: 10, taxRate: 0.00002, config: structuredClone(DEFAULT_CONFIG),
    });
}
function trade(patch: Partial<VirtualTrade> = {}): VirtualTrade {
    const plan = planRisk({
        direction: 'LONG', entry: 101, entryBasis: 'fill', swing: 91, atr: 10,
        tick: 1, pointValue: 10, taxRate: 0.00002,
        cfg: { ...DEFAULT_CONFIG.risk, budget: 100000, qty: 3 },
    });
    return {
        id: 'long', entryId: 'entry-long', entryMode: 'IMMEDIATE', signalId: 'signal-long',
        direction: 'LONG', signalTime: times[0]!, fillTime: times[1]!, fillAt: times[0]!, fillPrice: 101,
        plan, qty: 3, openQty: 0, stop: 106, stopKind: 'breakeven',
        stopHistory: [{ time: times[1]!, stop: plan.stop, reason: 'initial' }, { time: times[3]!, stop: 106, reason: 'breakeven' }],
        trailing: false, hit: { r1: times[2]!, r2: null, r3: null }, extreme: 131, fills: [],
        status: 'CLOSED', exitReason: 'BREAKEVEN_STOP', closedAt: times[4]!,
        realizedPoints: 0, costNtd: 0, realizedNtd: 0, warnings: [], ...patch,
    };
}

describe('自訂指標輸入的 1m 與商品規格界線', () => {
    it('盤中只以後一根確認前一根，最後一根維持 live，不以牆鐘補認收棒', () => {
        const candles = times.slice(0, 4).map((t) => bar(t));
        const input = inputFromCustomBars(toInput(candles), {}, times[3]! + 180)!;
        expect(input.bars1m).toEqual(candles.slice(0, -1));
        expect(input.live).toEqual(candles.at(-1));
        expect(input.asOf).toBe(times[2]);
        expect(input).toMatchObject({ securityType: 'FUT', symbol: 'TMF', contractMonth: 'CUSTOM', tick: 1, pointValue: 10, taxRate: 0.00002 });
        expect(input.config.risk.feePerSide).toBe(12);
    });

    it('收盤 240 秒定盤寬限加 10 秒之前不確認末棒；門檻到達才確認', () => {
        const end = T('2026-10-20T13:45:00');
        const candles = [bar(end - 60), bar(end), bar(end + 60)];
        const before = inputFromCustomBars(toInput(candles), {}, end + 249)!;
        expect(before.bars1m).toEqual(candles.slice(0, -1));
        expect(before.live).toEqual(candles.at(-1));
        const after = inputFromCustomBars(toInput(candles), {}, end + 250)!;
        expect(after.bars1m).toEqual(candles);
        expect(after.live).toBeNull();
        expect(after.asOf).toBe(end + 240);
        expect(inputFromCustomBars(toInput(candles), {}, end + 86400)!.asOf).toBe(end + 240);
    });

    it('排序與同 label 更新保留最後提供的有效 OHLCV，不修改呼叫端陣列', () => {
        const old = bar(times[1]!, 100, 110, 90, 100);
        const update = bar(times[1]!, 101, 112, 90, 111);
        const bars = toInput([bar(times[2]!), old, bar(times[0]!), update]);
        const original = structuredClone(bars);
        const input = inputFromCustomBars(bars, {}, times[2]!)!;
        expect(input.bars1m).toEqual([bar(times[0]!), update]);
        expect(input.live).toEqual(bar(times[2]!));
        expect(bars).toEqual(original);
    });

    it('僅 0／1 根有效資料為暖身不足，仍輸出全部具名的空序列', () => {
        for (const candles of [[], [bar(times[0]!)]]) {
            const r = computeCustomTsp(toInput(candles), {}, times[0]!);
            expect(r.input).toBeNull();
            expect(r.result).toBeNull();
            expect(r.order).toEqual(KEYS);
            for (const key of KEYS) expect(r.outputs[key]).toEqual(candles.map(() => null));
        }
    });

    it('5m OHLC 無法還原 1m 停損路徑，及全缺 60 秒證據時明確拒絕', () => {
        expect(() => inputFromCustomBars(toInput(aggregate(sample, 5)), {}, sample.at(-1)!.time)).toThrow();
        expect(() => inputFromCustomBars(toInput([bar(times[0]!), bar(times[2]!), bar(times[4]!)]), {}, times[5]!)).toThrow();
    });

    it.each(INVALID_METADATA)('非法商品 metadata %s=%s 拒絕，不能悄悄改用預設成本', (key, value) => {
        expect(() => inputFromCustomBars(toInput(sample), { [key]: value }, sample.at(-1)!.time)).toThrow();
    });

    it('允許明確商品與費用覆寫，零稅率亦有效', () => {
        const input = inputFromCustomBars(toInput(sample), { tick: 0.5, pointValue: 50, taxRate: 0, feePerSide: 25 }, sample.at(-1)!.time)!;
        expect(input).toMatchObject({ tick: 0.5, pointValue: 50, taxRate: 0 });
        expect(input.config.risk.feePerSide).toBe(25);
    });

    it('欄長不一致、非有限 OHLCV、錯誤高低與負量均拒絕', () => {
        const invalid: BarsInput[] = [];
        const valid = toInput(times.slice(0, 3).map((t) => bar(t)));
        invalid.push({ ...valid, close: [100] });
        for (const field of ['time', 'open', 'high', 'low', 'close', 'volume'] as const) {
            for (const value of [NaN, Infinity]) {
                const input = structuredClone(valid);
                input[field][1] = value;
                invalid.push(input);
            }
        }
        invalid.push({ ...valid, high: [110, 99, 110] });
        invalid.push({ ...valid, low: [90, 101, 90] });
        invalid.push({ ...valid, volume: [10, -1, 10] });
        for (const input of invalid) expect(() => inputFromCustomBars(input, {}, times[3]!)).toThrow();
        for (const now of [NaN, Infinity]) expect(() => inputFromCustomBars(valid, {}, now)).toThrow();
    });

    it('未來一小時的資料不能成為已收或即時價格；目前分鐘的收盤 label 可當 live', () => {
        const now = times[2]! - 10;
        const valid = inputFromCustomBars(toInput(times.slice(0, 3).map((t) => bar(t))), {}, now)!;
        expect(valid.live?.time).toBe(times[2]);
        const future = toInput([bar(times[0]!), bar(times[1]!), bar(times[2]! + 3600)]);
        const filtered = inputFromCustomBars(future, {}, now)!;
        expect(filtered.bars1m).toEqual([bar(times[0]!)]);
        expect(filtered.live).toEqual(bar(times[1]!));
        expect(inputFromCustomBars(toInput([bar(times[2]! + 3600), bar(times[2]! + 3660)]), {}, now)).toBeNull();
    });
});

describe.each([0, 1, 2])('自訂入口與共用核心逐值比對（algo=%i）', (algo) => {
    it.each(PARAM_CASES)('entry/risk=%j', (patch) => {
        const params = { algo, ...patch, riskHistory: 1 };
        const now = sample.at(-1)!.time - 10;
        const input = inputFromCustomBars(toInput(sample), params, now)!;
        const expected = runTrendSignal({
            bars1m: sample.slice(0, -1), live: sample.at(-1)!, asOf: sample.at(-2)!.time,
            securityType: 'FUT', symbol: 'TMF', contractMonth: 'CUSTOM', tick: 1, pointValue: 10,
            taxRate: 0.00002, config: configFromParams(params),
        });
        const computed = computeCustomTsp(toInput(sample), params, now);
        expect(input.bars1m).toEqual(sample.slice(0, -1));
        expect(computed.result).toEqual(expected);
        expect(computed.outputs).toEqual(projectCustomTsp(expected, sample.map((b) => b.time)));
        expect(computed.order).toEqual(KEYS);
        for (const key of LEVELS) expect(computed.hints[key]?.kind).toBe('points');
        for (const key of MARKS) expect(computed.hints[key]?.kind).toBe('points');
        sample.forEach((b, i) => {
            const j = lastAtOrBefore(expected.m5.bars, Math.min(b.time, expected.asOf));
            const direction = j >= 0 ? expected.t5.dir[j] : 'UNKNOWN';
            expect(computed.outputs['多方趨勢線']![i]).toBe(direction === 'LONG' ? expected.t5.line[j] : null);
            expect(computed.outputs['空方趨勢線']![i]).toBe(direction === 'SHORT' ? expected.t5.line[j] : null);
        });
        expect(expected.signals.length).toBeGreaterThan(0);
        if (patch.entryMode === 0) {
            expect(expected.trades.length).toBeGreaterThan(0);
            expect(computed.outputs['目前停損']!.some((value) => value !== null)).toBe(true);
            expect(computed.outputs['虛擬進場多']!.some((value) => value !== null)
                || computed.outputs['虛擬進場空']!.some((value) => value !== null)).toBe(true);
        }
        expect(computed).toEqual(computeCustomTsp(toInput(sample), params, now));
    });
});

describe('風控歷史投影反例', () => {
    it('依 stopHistory 生效 label 畫出停損，不能把最後停損回填；成交前與平倉後空手不畫', () => {
        const vt = trade();
        const out = projectCustomTsp({ ...emptyResult(), trades: [vt] }, times);
        expect(out['目前停損']).toEqual([null, vt.plan.stop, vt.plan.stop, 106, 106, null, null, null]);
        expect(out['初始停損']).toEqual([null, vt.plan.stop, vt.plan.stop, vt.plan.stop, vt.plan.stop, null, null, null]);
        expect(out['保本價']).toEqual([null, vt.plan.breakevenStop, vt.plan.breakevenStop, vt.plan.breakevenStop, vt.plan.breakevenStop, null, null, null]);
        for (const [name, price] of [['1R', vt.plan.r1], ['2R', vt.plan.r2], ['3R', vt.plan.r3]] as const) {
            expect(out[name]).toEqual([null, price, price, price, price, null, null, null]);
        }
        expect(out['虛擬進場多']).toEqual([null, 101, null, null, null, null, null, null]);
        expect(out['虛擬進場多']![0]).toBeNull(); // fillAt = 前棒 label；不能前視畫在此處。
    });

    it('同根 2R／3R 分批出場分欄保留實際出場價，非布林或 high/low 代理值', () => {
        const vt = trade({
            fills: [
                { time: times[3]!, at: 'intrabar', price: 161, qty: 1, reason: 'TP2R' },
                { time: times[3]!, at: 'intrabar', price: 191, qty: 1, reason: 'TP3R' },
                { time: times[4]!, at: 'open', price: 105, qty: 1, reason: 'BREAKEVEN_STOP' },
            ],
        });
        const out = projectCustomTsp({ ...emptyResult(), trades: [vt] }, times);
        expect(out['虛擬2R出場']).toEqual([null, null, null, 161, null, null, null, null]);
        expect(out['虛擬3R出場']).toEqual([null, null, null, 191, null, null, null, null]);
        expect(out['虛擬停損出場']).toEqual([null, null, null, null, 105, null, null, null]);
    });

    it.each(['REVERSAL', 'TREND_INVALID'] as const)('同根 %s 平舊多單並開新空單，兩個 marker 均留存且風控價位屬新單', (reason) => {
        const old = trade({ fills: [{ time: times[4]!, at: 'open', price: 98, qty: 3, reason }], exitReason: reason });
        const nextPlan = planRisk({
            direction: 'SHORT', entry: 97, entryBasis: 'fill', swing: 111, atr: 10,
            tick: 1, pointValue: 10, cfg: DEFAULT_CONFIG.risk,
        });
        const next = trade({
            id: 'short', direction: 'SHORT', fillTime: times[4]!, fillAt: times[3]!, fillPrice: 97,
            plan: nextPlan, qty: 1, openQty: 1, stop: nextPlan.stop, stopKind: 'initial',
            stopHistory: [{ time: times[4]!, stop: nextPlan.stop, reason: 'initial' }],
            status: 'OPEN', closedAt: null, exitReason: null,
        });
        const out = projectCustomTsp({ ...emptyResult(), trades: [old, next] }, times);
        expect(out['虛擬反轉失效出場']![4]).toBe(98);
        expect(out['虛擬進場空']![4]).toBe(97);
        expect(out['目前停損']![4]).toBe(nextPlan.stop);
        expect(out['1R']![4]).toBe(nextPlan.r1);
        expect(out['目前停損']![3]).toBe(106);
    });

    it('亂序且重複的圖表 label 仍映回每個原始索引；相同時間不遺失 marker', () => {
        const vt = trade({ fills: [{ time: times[4]!, at: 'intrabar', price: 105, qty: 3, reason: 'BREAKEVEN_STOP' }] });
        const order = [4, 0, 3, 1, 4, 7, 2];
        const result = { ...emptyResult(), trades: [vt] };
        const sorted = projectCustomTsp(result, times);
        const shuffled = projectCustomTsp(result, order.map((i) => times[i]!));
        for (const key of KEYS) expect(shuffled[key]).toEqual(order.map((i) => sorted[key]![i]));
        expect(shuffled['虛擬停損出場']).toEqual([105, null, null, null, 105, null, null]);
    });

    it('visibleThrough 截斷其後所有訊號與價位；沒有持倉的結果不畫風控價位', () => {
        const out = projectCustomTsp({ ...emptyResult(), trades: [trade()] }, times, times[2]!);
        for (const key of KEYS) expect(out[key]!.slice(3)).toEqual([null, null, null, null, null]);
        const flat = projectCustomTsp(emptyResult(), times);
        for (const key of [...LEVELS, ...MARKS]) expect(flat[key]).toEqual(times.map(() => null));
    });
});

describe('未收棒虛擬風控因果', () => {
    it('預設只顯示仍持有部位的風控，歷史成交點保留；空手時不殘留上一筆停損', () => {
        const closed = trade();
        const open = trade({ id: 'current', fillTime: times[5]!, fillAt: times[4]!, status: 'OPEN', openQty: 3, closedAt: null,
            stopHistory: [{ time: times[5]!, stop: 80, reason: 'initial' }] });
        const base = emptyResult();
        const active = { ...base, trades: [closed, open], snapshot: { ...base.snapshot, trade: open } };
        const current = projectCustomTsp(active, times, Infinity, false);
        expect(current['初始停損']!.slice(0, 5)).toEqual(times.slice(0, 5).map(() => null));
        expect(current['目前停損']!.slice(5)).toEqual([80, 80, 80]);
        expect(current['虛擬進場多']![1]).toBe(closed.fillPrice);
        const flat = projectCustomTsp({ ...active, snapshot: { ...base.snapshot, trade: null } }, times, Infinity, false);
        for (const key of LEVELS) expect(flat[key]).toEqual(times.map(() => null));
    });
    it('live 可觸發保護停損，但高點觸及 1R/2R/3R 不能提前停利或移動停損', () => {
        const m1 = Array.from({ length: 40 }, (_, i) => bar(t0 + (i + 1) * 60));
        const asOf = m1.at(-1)!.time;
        const m5 = buildTf(m1, 5, 'FUT', asOf);
        const signal: TrendSignal = {
            id: 'buy-live', kind: 'BUY', direction: 'LONG', barTime: asOf, index: 7,
            session: '2026-10-20D', sessionEnd: T('2026-10-20T13:45:00'), close: 100, line: undefined, atr: undefined,
            notes: { ema: 'UNKNOWN', m15: 'UNKNOWN', m60: 'UNKNOWN', m15Align: 'NEUTRAL', m60Align: 'NEUTRAL', m15BarTime: null, m60BarTime: null, m15Stale: false, m60Stale: false, m15Incomplete: false, m60Incomplete: false },
        };
        const entry: EntryEvent = {
            id: 'entry-live', kind: 'POTENTIAL_ENTRY_LONG', direction: 'LONG', mode: 'IMMEDIATE',
            signalId: signal.id, barTime: asOf, refPrice: 100, seq: 1, reason: 'synthetic-live',
        };
        const run = (live: Candle) => runVirtual({
            m1, asOf, live, m1SessionEnd: buildTf(m1, 1, 'FUT', asOf).sessionEnd, m5,
            t5: { tf: 5, algo: 'supertrend', line: m5.bars.map(() => undefined), dir: m5.bars.map(() => 'LONG'), stopLine: true },
            signals: [signal], invalidations: [], entries: [entry],
            cfg: { ...DEFAULT_CONFIG.risk, budget: 100000, qty: 3 }, tick: 1, pointValue: 10, taxRate: 0.00002, key: 'test-live',
        });
        const target = run(bar(asOf + 60, 100, 250, 95, 240)).trades[0]!;
        expect(target.fillPrice).toBe(101);
        expect(target.plan.r3).toBeLessThan(250);
        expect(target).toMatchObject({ status: 'OPEN', openQty: 3, hit: { r1: null, r2: null, r3: null }, fills: [] });
        expect(target.stopHistory).toHaveLength(1);
        const stop = run(bar(asOf + 60, 100, 250, 60, 70)).trades[0]!;
        expect(stop.exitReason).toBe('STOP');
        expect(stop.fills[0]).toMatchObject({ time: asOf + 60, at: 'intrabar', price: stop.plan.stop - 1, qty: 3 });
        const out = projectCustomTsp({ ...emptyResult(), asOf, trades: [stop] }, [asOf, asOf + 60]);
        expect(out['虛擬進場多']).toEqual([null, 101]);
        expect(out['虛擬停損出場']).toEqual([null, stop.fills[0]!.price]);
        expect(out['虛擬2R出場']).toEqual([null, null]);
        expect(out['虛擬3R出場']).toEqual([null, null]);
    });
});
