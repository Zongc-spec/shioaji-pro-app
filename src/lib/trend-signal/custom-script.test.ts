// src/lib/trend-signal/custom-script.test.ts — App 真執行器跑產出的單檔（docs/trend-signal-pro-custom.js），
// 依主圖週期驗證原意「5m 是主趨勢並判斷進出場，1m 是精準進出場」：
//   1m 主圖：原模型，與 Web 的 runTrendSignal 逐值相同（三核心 × 三進場模式）
//   5m 主圖：與 1m 主圖同一組 5m 訊號；三核心 × 三進場模式都有 5m 提示與虛擬部位；
//            IMMEDIATE 和 1m 主圖同一根成交、同價、同一個初始停損；未宣告微型參數時用 5m 預設
//   15m／60m／日K：只有該週期的趨勢線（高週期輔助），沒有訊號、提示、進出場與風控
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCustom, type BarsInput, type CustomRunResult } from '../custom-runtime';
import type { Candle } from '../types/market';
import { aggregate } from '../utils/kbars';
import { computeAppCustomTsp, M5_MICRO_DEFAULTS } from './app-custom';
import { frameFromChart } from './chart-custom';
import { configFromParams } from './config';
import { projectCustomTsp } from './custom-adapter';
import { lastAtOrBefore } from './core/bars';
import { runTrendSignal } from './engine';
import { sessionLabels, T, walkBars } from './fixtures.test-harness';
import { trendTrack } from './trend/signals';
import type { TrendSignalResult } from './types';

const SOURCE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/trend-signal-pro-custom.js'), 'utf8');
const DAY = 86400;
const KEYS = ['多方趨勢線', '空方趨勢線', 'BUY', 'SELL', '失效', '微型提示', '結構提示',
    '初始停損', '目前停損', '保本價', '1R', '2R', '3R', '虛擬進場多', '虛擬進場空',
    '虛擬停損出場', '虛擬2R出場', '虛擬3R出場', '虛擬反轉失效出場'];
const TREND = ['多方趨勢線', '空方趨勢線'];
const LEVELS = ['初始停損', '目前停損', '保本價', '1R', '2R', '3R'];
const ALGOS = [0, 1, 2];

const toInput = (bars: Candle[]): BarsInput => ({
    time: bars.map((b) => b.time), open: bars.map((b) => b.open), high: bars.map((b) => b.high),
    low: bars.map((b) => b.low), close: bars.map((b) => b.close), volume: bars.map((b) => b.volume),
});
const setNow = (now: number) => vi.setSystemTime((now - 8 * 3600) * 1000);
function script(bars: Candle[], params: Record<string, number>, now: number): CustomRunResult {
    setNow(now);
    const result = runCustom(SOURCE, toInput(bars), params);
    expect(result.error).toBeUndefined();
    expect(result.order).toEqual(KEYS);
    return result;
}
const nulls = (n: number) => new Array<number | null>(n).fill(null);
const marked = (ser: (number | null)[]) => ser.flatMap((v, i) => (v !== null ? [i] : []));

// 1m／5m：4 個交易日（日夜盤）的 1m，收盤後計算（最後一根也已收）
const labels = sessionLabels('2026-09-01', 4);
const m1 = walkBars(labels, 11, { regime: 60 });
const chart5 = aggregate(m1, 5);
const closedAt = labels.at(-1)! + 300;
const web = (params: Record<string, number>): TrendSignalResult => runTrendSignal({ bars1m: m1, live: null, asOf: labels.at(-1)! + 240,
    securityType: 'FUT', symbol: 'TMF', contractMonth: 'CUSTOM', tick: 1, pointValue: 10, taxRate: 0.00002, config: configFromParams(params) });

/** 最後一段連續趨勢（同方向、同盤、相鄰桶；日K只看方向）的起點索引 */
function lastSegmentStart(times: number[], dir: string[], session: string[], step: number | null) {
    let start = dir.length - 1;
    while (start > 0 && dir[start - 1] === dir.at(-1)
        && (step === null || (times[start]! - times[start - 1]! === step && session[start] === session[start - 1]))) start--;
    return start;
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); });
afterEach(() => { vi.useRealTimers(); });

describe('1m 主圖：原模型（5m 主趨勢＋1m 精準進出場），與 Web 逐值相同', () => {
    it.each(ALGOS.flatMap((algo) => [0, 1, 2].map((entryMode) => [algo, entryMode] as const)))('核心 %i／進場 %i', (algo, entryMode) => {
        const params = { algo, entryMode, qty: 3, budget: 100000, riskHistory: 1 };
        const res = web(params);
        expect(res.signals.length).toBeGreaterThan(3);
        expect(res.trades.length).toBeGreaterThan(0);
        const app = script(m1, params, closedAt);
        const times = m1.map((b) => b.time);
        const expected = projectCustomTsp(res, times, times.at(-1)!, true);
        for (const key of KEYS.filter((k) => !TREND.includes(k))) expect(app.outputs[key]).toEqual(expected[key]);
        // 獨立核對：訊號落在 5m 收盤那根 1m、提示落在觸發的 1m、成交價與初始停損在成交那根 1m
        const at = (ts: number[]) => ts.map((t) => times.indexOf(t)).sort((a, b) => a - b);
        expect(marked(app.outputs.BUY!)).toEqual(at(res.signals.filter((s) => s.kind === 'BUY').map((s) => s.barTime)));
        expect(marked(app.outputs.SELL!)).toEqual(at(res.signals.filter((s) => s.kind === 'SELL').map((s) => s.barTime)));
        expect(marked(app.outputs['微型提示']!)).toEqual(at(res.entries.filter((e) => e.mode === 'MICRO_TREND').map((e) => e.barTime)));
        expect(marked(app.outputs['結構提示']!)).toEqual(at(res.entries.filter((e) => e.mode === 'PRICE_STRUCTURE').map((e) => e.barTime)));
        for (const trade of res.trades) {
            const i = times.indexOf(trade.fillTime);
            expect(app.outputs[trade.direction === 'LONG' ? '虛擬進場多' : '虛擬進場空']![i]).toBe(trade.fillPrice);
            expect(app.outputs['初始停損']![i]).toBe(trade.plan.stop);
        }
        // 趨勢線是 5m 主趨勢，只畫最後一段（宿主折線會跨空值連線）
        const b5 = res.m5.bars;
        const start = lastSegmentStart(b5.map((b) => b.time), res.t5.dir, res.m5.session, 300);
        m1.forEach((b, i) => {
            const j = lastAtOrBefore(b5, b.time);
            const show = b.time >= b5[start]!.time;
            expect(app.outputs['多方趨勢線']![i]).toBe(show && res.t5.dir[j] === 'LONG' ? res.t5.line[j]! : null);
            expect(app.outputs['空方趨勢線']![i]).toBe(show && res.t5.dir[j] === 'SHORT' ? res.t5.line[j]! : null);
        });
        expect(app.hints['多方趨勢線']).toMatchObject({ kind: 'line', width: 2 });
    });
});

describe('5m 主圖：同一組 5m 主趨勢；三核心 × 三進場模式的提示與虛擬部位都以 5m K 棒計算', () => {
    const MODES = ['IMMEDIATE', 'MICRO_TREND', 'PRICE_STRUCTURE'] as const;
    const times5 = chart5.map((b) => b.time);
    const at5 = (ts: number[]) => ts.map((t) => times5.indexOf(t)).sort((a, b) => a - b);
    const app5 = (params: Record<string, number>) => {
        setNow(closedAt);
        const app = computeAppCustomTsp(toInput(chart5), params, closedAt);
        expect(app.mode).toBe('m5');
        return { app, res: app.result as Exclude<typeof app.result, TrendSignalResult | null> };
    };

    it.each(ALGOS)('核心 %i：BUY／SELL／失效與 1m 主圖相同，趨勢線是同一條 5m 線', (algo) => {
        const res = web({ algo });
        expect(chart5).toEqual(res.m5.bars);
        const app = script(chart5, { algo }, closedAt);
        const put = (ts: { barTime: number; v: number }[]) => {
            const out = nulls(times5.length);
            for (const x of ts) out[times5.indexOf(x.barTime)] = x.v;
            return out;
        };
        expect(app.outputs.BUY).toEqual(put(res.signals.filter((s) => s.kind === 'BUY').map((s) => ({ barTime: s.barTime, v: s.close }))));
        expect(app.outputs.SELL).toEqual(put(res.signals.filter((s) => s.kind === 'SELL').map((s) => ({ barTime: s.barTime, v: s.close }))));
        expect(app.outputs['失效']).toEqual(put(res.invalidations.map((x) => ({ barTime: x.barTime, v: chart5[x.index]!.close }))));
        const start = lastSegmentStart(times5, res.t5.dir, res.m5.session, 300);
        chart5.forEach((_, k) => {
            const show = k >= start;
            expect(app.outputs['多方趨勢線']![k]).toBe(show && res.t5.dir[k] === 'LONG' ? res.t5.line[k]! : null);
            expect(app.outputs['空方趨勢線']![k]).toBe(show && res.t5.dir[k] === 'SHORT' ? res.t5.line[k]! : null);
        });
    });

    it.each(ALGOS)('核心 %i：IMMEDIATE 的第一筆虛擬部位和 1m 主圖同一根成交、同價、同一個初始停損與 R（都依已收的 5m）', (algo) => {
        const params = { algo, budget: 100000, qty: 1 };
        const first1m = web(params).trades[0]!;
        const { app, res } = app5(params);
        const first5m = res.trades[0]!;
        expect(first5m.signalId.endsWith(`|${first1m.signalTime}|${first1m.direction === 'LONG' ? 'BUY' : 'SELL'}`)).toBe(true);
        expect(first5m.fillAt).toBe(first1m.fillAt);
        expect(first5m.fillPrice).toBe(first1m.fillPrice);
        const plan = (p: typeof first1m.plan) => [p.stop, p.stopBasis, p.riskPoints, p.r1, p.r2, p.r3, p.breakevenStop];
        expect(plan(first5m.plan)).toEqual(plan(first1m.plan));
        // 單檔輸出與直接呼叫相同
        expect(script(chart5, params, closedAt).outputs).toEqual(app.outputs);
    });

    it.each(ALGOS.flatMap((algo) => [0, 1, 2].map((entryMode) => [algo, entryMode] as const)))('核心 %i／進場 %i：有該模式的虛擬部位，在提示的下一根 5m 開盤成交；圖上的提示點就是提示事件', (algo, entryMode) => {
        const params = { algo, entryMode, budget: 100000, qty: 1, riskHistory: 1 };
        const { res } = app5(params);
        expect(res.entries.some((e) => e.mode === 'MICRO_TREND')).toBe(true);
        expect(res.entries.some((e) => e.mode === 'PRICE_STRUCTURE')).toBe(true);
        expect(res.trades.length).toBeGreaterThan(0);
        for (const t of res.trades) {
            expect(t.entryMode).toBe(MODES[entryMode]);
            const hint = res.entries.find((e) => e.id === t.entryId)!;
            expect(t.fillAt).toBe(hint.barTime);
            expect(t.fillTime).toBe(hint.barTime + 300);
            expect(t.fillPrice).toBe(chart5[times5.indexOf(t.fillTime)]!.open + (t.direction === 'LONG' ? 1 : -1));
        }
        const out = script(chart5, params, closedAt).outputs;
        expect(marked(out['微型提示']!)).toEqual(at5(res.entries.filter((e) => e.mode === 'MICRO_TREND').map((e) => e.barTime)));
        expect(marked(out['結構提示']!)).toEqual(at5(res.entries.filter((e) => e.mode === 'PRICE_STRUCTURE').map((e) => e.barTime)));
        for (const t of res.trades) {
            expect(out[t.direction === 'LONG' ? '虛擬進場多' : '虛擬進場空']![times5.indexOf(t.fillTime)]).toBe(t.fillPrice);
            expect(out['初始停損']![times5.indexOf(t.fillTime)]).toBe(t.plan.stop);
        }
    });

    it('微型參數：未宣告時用 5m 預設；宣告了就照用（與主趨勢相同的值會讓微型趨勢等於主趨勢，不再有微型提示）', () => {
        const micro = (params: Record<string, number>) => app5(params).res.entries.filter((e) => e.mode === 'MICRO_TREND');
        const same = { 0: { microStMult: 3 }, 1: { microDcLength: 20 }, 2: { microKamaHyst: 0.3 } } as const;
        for (const algo of ALGOS) {
            const auto = micro({ algo });
            expect(auto.length).toBeGreaterThan(0);
            expect(micro({ algo, ...M5_MICRO_DEFAULTS })).toEqual(auto);
            expect(micro({ algo, ...same[algo as 0 | 1 | 2] })).toEqual([]);
        }
    });
});

describe('15m／60m／日K：只畫該週期趨勢線作高週期輔助', () => {
    function chartBars(minutes: number): Candle[] {
        const daily = Array.from({ length: 280 }, (_, i) => T('2025-01-01') + i * DAY).filter((t) => ![0, 6].includes(new Date(t * 1000).getUTCDay()));
        const ls = minutes === 1440 ? daily : [...new Set(sessionLabels('2026-08-03', 40).map((t) => Math.ceil(t / (minutes * 60)) * minutes * 60))].slice(0, 360);
        return walkBars(ls, 11, { regime: 24, drift: 8, vol: 4 });
    }
    it.each([15, 60, 1440])('%im：趨勢線是該週期 TrendCore 的最後一段，其餘輸出全為空', (minutes) => {
        const bars = chartBars(minutes);
        const now = bars.at(-1)!.time + (minutes === 1440 ? 43200 : -10);
        const params = { budget: 100000, qty: 3 };
        const app = script(bars, params, now);
        for (const key of KEYS.filter((k) => !TREND.includes(k))) expect(app.outputs[key]).toEqual(nulls(bars.length));
        const frame = frameFromChart(toInput(bars), params, now);
        const track = trendTrack(frame.series, frame.config.trend);
        const start = lastSegmentStart(frame.confirmed.map((b) => b.time), track.dir, frame.series.session, frame.daily ? null : frame.seconds);
        const mapped = bars.map((b) => frame.mapTime(b.time));
        let shown = 0;
        mapped.forEach((time, i) => {
            let j = frame.confirmed.length - 1;
            while (j >= 0 && frame.confirmed[j]!.time > Math.min(time, frame.asOf)) j--;
            const show = j >= start && j >= 0;
            const long = show && track.dir[j] === 'LONG' ? track.line[j] ?? null : null;
            const short = show && track.dir[j] === 'SHORT' ? track.line[j] ?? null : null;
            expect(app.outputs['多方趨勢線']![i]).toBe(long);
            expect(app.outputs['空方趨勢線']![i]).toBe(short);
            if (long !== null || short !== null) shown++;
        });
        expect(shown).toBeGreaterThan(0);
    });

    it('日K：當天的大幅高低變動不改變已收的趨勢線', () => {
        const bars = chartBars(1440);
        const now = bars.at(-1)!.time + 43200;
        const changed = bars.map((b, i) => i === bars.length - 1 ? { ...b, high: b.high + 10000, low: b.low - 10000 } : b);
        const before = script(bars, {}, now);
        const after = script(changed, {}, now);
        for (const key of TREND) expect(after.outputs[key]!.slice(0, -1)).toEqual(before.outputs[key]!.slice(0, -1));
    });
});

describe('單檔的顯示與錯誤界線', () => {
    it('預設只畫目前持倉的風控線（line）；riskHistory=1 改畫各筆部位持倉期間（points）', () => {
        const params = { budget: 100000, qty: 3 };
        const res = web(params);
        const app = script(m1, params, closedAt);
        const open = res.snapshot.trade?.status === 'OPEN' ? res.snapshot.trade : null;
        for (const key of LEVELS) {
            expect(app.hints[key]?.kind).toBe('dashed');
            m1.forEach((b, i) => { if (!open || b.time < open.fillTime) expect(app.outputs[key]![i]).toBeNull(); });
        }
        const history = script(m1, { ...params, riskHistory: 1 }, closedAt);
        for (const key of LEVELS) expect(history.hints[key]?.kind).toBe('points');
        expect(marked(history.outputs['初始停損']!).length).toBeGreaterThan(0);
    });

    it('非法商品規格、chartTf、riskHistory 透過執行器明確報錯（1m 與 5m 主圖都一樣）', () => {
        for (const bars of [m1, chart5]) {
            setNow(closedAt);
            const invalid: Record<string, number>[] = [{ tick: NaN }, { pointValue: Infinity }, { taxRate: -1 }, { chartTf: 0.5 }, { chartTf: 1441 }, { riskHistory: 2 }];
            for (const params of invalid) expect(runCustom(SOURCE, toInput(bars), params).error).toBeTruthy();
        }
    });

    it('空白與單根資料仍提供 19 條輸出（全為空）', () => {
        for (const bars of [[], [m1[0]!], [chart5[0]!]]) {
            const app = script(bars, {}, T('2026-10-20T10:00:00'));
            for (const key of KEYS) expect(app.outputs[key]).toEqual(bars.map(() => null));
        }
    });

    it('單檔不包含網路、持久儲存或原生送單入口', () => {
        expect(SOURCE).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|localStorage|__TAURI_INTERNALS__|place_order|cancel_order|update_price)\b/);
    });
});
