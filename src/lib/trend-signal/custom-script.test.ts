// src/lib/trend-signal/custom-script.test.ts — docs/trend-signal-pro-custom.js（桌面版「自訂指標」用的
// 單檔版本）以 App 的自訂指標執行器（custom-runtime）執行，與原生 Trend Signal Pro 逐根對照：
// 5m 主圖的趨勢線、BUY／SELL、失效；1m 主圖的 5m 投影、訊號位置與 MICRO_TREND／PRICE_STRUCTURE 提示；
// 進行中的 K 棒不產生訊號。三個 TrendCore 都比。
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCustom, type BarsInput } from '../custom-runtime';
import type { Candle } from '../types/market';
import { aggregate, wallClockToUtc } from '../utils/kbars';
import { DEFAULT_CONFIG } from './config';
import { lastAtOrBefore } from './core/bars';
import { runTrendSignal } from './engine';
import { sessionLabels, walkBars } from './fixtures.test-harness';
import type { EntryMode, TrendAlgoId, TrendSignalConfig, TrendSignalResult } from './types';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(resolve(here, '../../../docs/trend-signal-pro-custom.js'), 'utf8');

const ALGO_INDEX: Record<TrendAlgoId, number> = { supertrend: 0, donchian: 1, kama: 2 };
const ALGOS: TrendAlgoId[] = ['supertrend', 'donchian', 'kama'];
const KEYS = ['多方趨勢線', '空方趨勢線', 'BUY', 'SELL', '失效', '1m 微型提示', '1m 結構提示'];

const labels = sessionLabels('2026-09-01', 4);
const m1 = walkBars(labels, 11, { regime: 60 });
const end = labels.at(-1)!;

const toInput = (bars: Candle[]): BarsInput => ({
    time: bars.map((b) => b.time),
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: bars.map((b) => b.close),
    volume: bars.map((b) => b.volume),
});
/** 把系統時間設成台灣牆鐘 now（腳本用它判斷該盤是否已收盤） */
const setNow = (now: number) => vi.setSystemTime((now - 8 * 3600) * 1000);
/** 收盤（含定盤寬限）之後：最後一根也算收完，與原生 asOf ＝ 同一時刻相同 */
const closedAt = end + 300;
const cfgFor = (algo: TrendAlgoId, patch: (c: TrendSignalConfig) => TrendSignalConfig = (c) => c) =>
    patch({ ...structuredClone(DEFAULT_CONFIG), trend: { ...DEFAULT_CONFIG.trend, algo } });
const native = (config: TrendSignalConfig, bars = m1, asOf = end): TrendSignalResult =>
    runTrendSignal({ bars1m: bars, asOf, securityType: 'FUT', symbol: 'TMFR1', contractMonth: '202609', tick: 1, pointValue: 10, config });
function script(bars: Candle[], params: Record<string, number>, now: number) {
    setNow(now);
    const r = runCustom(SOURCE, toInput(bars), params);
    if (r.error) throw new Error(r.error);
    expect(r.order).toEqual(KEYS);
    return r.outputs;
}
const marked = (ser: (number | null)[]) => ser.flatMap((v, i) => (v !== null ? [i] : []));
const indexOfTime = (bars: Candle[], times: number[]) => times.map((t) => bars.findIndex((b) => b.time === t));

/** 1m 主圖：每根（含進行中的那一根）只看當時已收的 5m；訊號落在 5m 收盤那根 1m；提示落在觸發的 1m */
function expectOneMinuteParity(res: TrendSignalResult, bars: Candle[], out: Record<string, (number | null)[]>) {
    bars.forEach((b, i) => {
        const j = lastAtOrBefore(res.m5.bars, Math.min(b.time, res.asOf));
        const d = j >= 0 ? res.t5.dir[j] : 'UNKNOWN';
        expect(out['多方趨勢線']![i]).toBe(d === 'LONG' ? res.t5.line[j]! : null);
        expect(out['空方趨勢線']![i]).toBe(d === 'SHORT' ? res.t5.line[j]! : null);
    });
    const at = (kind: 'BUY' | 'SELL') => indexOfTime(bars, res.signals.filter((s) => s.kind === kind).map((s) => s.barTime));
    expect(marked(out.BUY!)).toEqual(at('BUY'));
    expect(marked(out.SELL!)).toEqual(at('SELL'));
    expect(marked(out['失效']!)).toEqual(indexOfTime(bars, res.invalidations.map((x) => x.barTime)));
    const hints = (mode: EntryMode) => indexOfTime(bars, res.entries.filter((e) => e.mode === mode).map((e) => e.barTime)).sort((a, b) => a - b);
    expect(marked(out['1m 微型提示']!)).toEqual(hints('MICRO_TREND'));
    expect(marked(out['1m 結構提示']!)).toEqual(hints('PRICE_STRUCTURE'));
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(() => {
    vi.useRealTimers();
});

describe.each(ALGOS)('自訂指標版 %s 與原生逐根相同', (algo) => {
    const config = cfgFor(algo);
    const res = native(config, m1, closedAt);

    it('5m 主圖：趨勢線、BUY／SELL、失效', () => {
        const chart5 = aggregate(m1, 5);
        expect(chart5).toEqual(res.m5.bars);
        const out = script(chart5, { algo: ALGO_INDEX[algo] }, closedAt);
        chart5.forEach((_, i) => {
            const d = res.t5.dir[i];
            expect(out['多方趨勢線']![i]).toBe(d === 'LONG' ? res.t5.line[i]! : null);
            expect(out['空方趨勢線']![i]).toBe(d === 'SHORT' ? res.t5.line[i]! : null);
        });
        expect(marked(out.BUY!)).toEqual(res.signals.filter((s) => s.kind === 'BUY').map((s) => s.index));
        expect(marked(out.SELL!)).toEqual(res.signals.filter((s) => s.kind === 'SELL').map((s) => s.index));
        expect(marked(out['失效']!)).toEqual(res.invalidations.map((x) => x.index));
        // 5m 主圖不畫 1m 提示
        expect(marked(out['1m 微型提示']!)).toEqual([]);
        expect(res.signals.length).toBeGreaterThan(3);
    });

    it('1m 主圖：5m 投影、訊號位置、MICRO_TREND／PRICE_STRUCTURE 提示', () => {
        const out = script(m1, { algo: ALGO_INDEX[algo] }, closedAt);
        expectOneMinuteParity(res, m1, out);
        expect(res.entries.filter((e) => e.mode === 'MICRO_TREND').length).toBeGreaterThan(0);
        expect(res.entries.filter((e) => e.mode === 'PRICE_STRUCTURE').length).toBeGreaterThan(0);
    });
});

describe('其他設定與邊界', () => {
    it('post-flip 窗口（hintWindow = 3 根 5m）', () => {
        const res = native(cfgFor('supertrend', (c) => ({ ...c, entry: { ...c.entry, windowBars: 3 } })), m1, closedAt);
        expectOneMinuteParity(res, m1, script(m1, { hintWindow: 3 }, closedAt));
    });

    it('非預設參數：Donchian(10)＋ATR×2、1m Donchian(10)、結構轉折 3／2、最小回檔 1 ATR', () => {
        const res = native(cfgFor('donchian', (c) => ({
            ...c,
            trend: { ...c.trend, dcLength: 10, dcAtrMult: 2 },
            entry: { ...c.entry, microDcLength: 10, pivotLeft: 3, pivotRight: 2, minPullbackAtr: 1 },
        })), m1, closedAt);
        const params = { algo: 1, dcLength: 10, dcAtrMult: 2, microDcLength: 10, pivotLeft: 3, pivotRight: 2, minPullbackAtr: 1 };
        expectOneMinuteParity(res, m1, script(m1, params, closedAt));
        expect(res.invalidations.length).toBeGreaterThan(0);
    });

    it('進行中的 K 棒（後面還沒有下一根、也還沒收盤）不產生訊號與提示：與原生在同一時點相同', () => {
        for (const k of [900, 1555, 2210]) {
            const bars = m1.slice(0, k + 2); // 第 k+1 根是進行中的 1m
            const asOf = labels[k]! + 20;
            const res = native(cfgFor('supertrend'), bars, asOf);
            expect(res.m1.bars).toHaveLength(k + 1);
            const out = script(bars, {}, asOf + 10);
            expectOneMinuteParity(res, bars, out);
            for (const key of ['BUY', 'SELL', '失效', '1m 微型提示', '1m 結構提示']) expect(out[key]![k + 1]).toBeNull();
        }
    });

    it('缺分鐘的 5m 一樣排除（審查 P1：13:10 只剩 13:06）', () => {
        const drop = new Set(['13:07', '13:08', '13:09', '13:10'].map((hm) => wallClockToUtc(`2026-09-02T${hm}:00`)));
        const gapped = m1.filter((b) => !drop.has(b.time));
        const res = native(cfgFor('supertrend'), gapped, closedAt);
        expect(res.gaps).toHaveLength(1);
        expectOneMinuteParity(res, gapped, script(gapped, {}, closedAt));
    });

    it('5m 桶內缺 1m 之後一樣不提示（2026-09-03 缺 12:28，12:29 的微型提示消失）', () => {
        const t = (hm: string) => wallClockToUtc(`2026-09-03T${hm}:00`);
        const gapped = m1.filter((b) => b.time !== t('12:28'));
        const before = native(cfgFor('supertrend'), m1, closedAt);
        const res = native(cfgFor('supertrend'), gapped, closedAt);
        expect(before.entries.some((e) => e.mode === 'MICRO_TREND' && e.barTime === t('12:29'))).toBe(true);
        expect(res.entries.some((e) => e.barTime === t('12:29'))).toBe(false);
        expectOneMinuteParity(res, gapped, script(gapped, {}, closedAt));
    });

    it('驗證用的 300 根 1m 樣本可執行（編輯器驗證只要求 plot() 有輸出）', () => {
        const out = script(m1.slice(0, 300), {}, closedAt);
        expect(Object.keys(out)).toEqual(KEYS);
    });
});
