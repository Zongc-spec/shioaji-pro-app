// src/lib/trend-signal/trigger/trigger.test.ts — 1m 進場時機：窗口不跨盤且遇反向訊號
// 結束、IMMEDIATE 立即、MICRO_TREND 必須「反向後轉回同向」、PRICE_STRUCTURE 只用已確認
// 轉折（右側 K 棒收盤後才成立）、空單鏡像、舊假說只作可選比較。
import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { DEFAULT_CONFIG } from '../config';
import { T } from '../fixtures.test-harness';
import type { EntryParams, TrendDir, TrendSignal } from '../types';
import { immediateEntry, microTrendEntry, pivots, priceStructureEntry } from './modes';
import { evalSetup, pullbackKdEntry, type KdIndicators } from './pullback-kd';
import { signalWindow, untriggeredStatus, windowIndexes } from './window';

const t0 = T('2026-10-20T09:00:00');
const P: EntryParams = { ...DEFAULT_CONFIG.entry, minPullbackAtr: 0.5 };
const bar = (i: number, o: number, h: number, l: number, c: number): Candle => ({ time: t0 + 60 * i, open: o, high: h, low: l, close: c, volume: 10 });
const flat = (n: number, px = 100) => Array.from({ length: n }, (_, i) => bar(i, px, px + 1, px - 1, px));

function signal(kind: 'BUY' | 'SELL', barTime: number, over: Partial<TrendSignal> = {}): TrendSignal {
    return {
        id: `sig-${kind}-${barTime}`,
        kind,
        direction: kind === 'BUY' ? 'LONG' : 'SHORT',
        barTime,
        index: 0,
        session: '2026-10-20D',
        sessionEnd: T('2026-10-20T13:45:00'),
        close: 100,
        line: 95,
        atr: 5,
        notes: { ema: 'UNKNOWN', m15: 'UNKNOWN', m60: 'UNKNOWN', m15Align: 'NEUTRAL', m60Align: 'NEUTRAL', m15BarTime: null, m60BarTime: null },
        ...over,
    };
}

describe('窗口', () => {
    const m1 = flat(40);
    it('訊號後 windowBars 根 5m，不超過該盤收盤', () => {
        const s = signal('BUY', t0 + 600);
        expect(signalWindow(s, undefined, m1, 3)).toMatchObject({ from: 11, end: t0 + 600 + 900 });
        const late = signal('BUY', T('2026-10-20T13:40:00'));
        expect(signalWindow(late, undefined, m1, 3).end).toBe(T('2026-10-20T13:45:00'));
    });
    it('反向訊號確認即結束：該時刻起的 1m 不評估', () => {
        const s = signal('BUY', t0 + 600);
        const w = signalWindow(s, signal('SELL', t0 + 900), m1, 3);
        expect(windowIndexes(m1, w).map((m) => m1[m]!.time)).toEqual([t0 + 660, t0 + 720, t0 + 780, t0 + 840]);
    });
    it('未觸發狀態：窗口未過 PENDING、過了 EXPIRED、反向已確認 CANCELLED', () => {
        const w = { from: 0, end: t0 + 900, cancelAt: Infinity };
        expect(untriggeredStatus(w, t0 + 600)).toBe('PENDING');
        expect(untriggeredStatus(w, t0 + 900)).toBe('EXPIRED');
        expect(untriggeredStatus({ ...w, cancelAt: t0 + 600 }, t0 + 700)).toBe('CANCELLED');
        expect(untriggeredStatus({ ...w, cancelAt: t0 + 600 }, t0 + 500)).toBe('PENDING');
    });
});

describe('IMMEDIATE', () => {
    it('5m 收棒即觸發，參考價為訊號收盤', () => {
        const s = signal('BUY', t0 + 600, { close: 123 });
        const e = immediateEntry('id', s, signalWindow(s, undefined, flat(20), 3), t0 + 600);
        expect(e).toMatchObject({ status: 'TRIGGERED', barTime: t0 + 600, refPrice: 123, mode: 'IMMEDIATE' });
    });
    it('訊號落在該盤最後一根：窗口為空，不跨盤進場', () => {
        const end = T('2026-10-20T13:45:00');
        const s = signal('BUY', end);
        expect(immediateEntry('id', s, signalWindow(s, undefined, flat(20), 3), end).status).toBe('EXPIRED');
    });
});

describe('MICRO_TREND', () => {
    const m1 = flat(30);
    const s = signal('BUY', t0 + 600); // 1m index 10
    const w = signalWindow(s, undefined, m1, 3);
    const dirs = (spec: Record<number, TrendDir>, base: TrendDir = 'UP'): TrendDir[] =>
        m1.map((_, i) => spec[i] ?? base);

    it('訊號後 1m 先反向、再轉回同向的那一根觸發', () => {
        const micro = dirs({ 12: 'DOWN', 13: 'DOWN' });
        const e = microTrendEntry('id', s, w, m1, micro, t0 + 1500);
        expect(e).toMatchObject({ status: 'TRIGGERED', barTime: m1[14]!.time });
    });
    it('1m 一直同向（沒有回檔）不觸發 — 不是「已同向就進場」', () => {
        expect(microTrendEntry('id', s, w, m1, dirs({}), t0 + 1500).status).toBe('EXPIRED');
    });
    it('轉回發生在訊號那一根（含之前）不算；訊號後第一根轉回才算', () => {
        expect(microTrendEntry('id', s, w, m1, dirs({ 9: 'DOWN' }), t0 + 1500).status).toBe('EXPIRED');
        expect(microTrendEntry('id', s, w, m1, dirs({ 9: 'DOWN', 10: 'DOWN' }), t0 + 1500).barTime).toBe(m1[11]!.time);
    });
    it('UNKNOWN → 同向不算轉回', () => {
        expect(microTrendEntry('id', s, w, m1, dirs({ 12: 'UNKNOWN' }), t0 + 1500).status).toBe('EXPIRED');
    });
    it('反向訊號先確認 → CANCELLED', () => {
        const w2 = signalWindow(s, signal('SELL', t0 + 900), m1, 3);
        expect(microTrendEntry('id', s, w2, m1, dirs({ 16: 'DOWN' }), t0 + 1500).status).toBe('CANCELLED');
    });
    it('空單鏡像', () => {
        const ss = signal('SELL', t0 + 600);
        const micro = dirs({ 12: 'UP' }, 'DOWN');
        expect(microTrendEntry('id', ss, w, m1, micro, t0 + 1500).barTime).toBe(m1[13]!.time);
    });
});

describe('pivots（已確認轉折）', () => {
    // lows: 10 9 8 7 8 9 10 → 低點在 index 3，右側兩根收盤後（index 5）才確認
    const lows = [10, 9, 8, 7, 8, 9, 10];
    const m1 = lows.map((l, i) => bar(i, l + 1, l + 2, l, l + 1));
    it('左側嚴格、右側不低於；confirm = index + right', () => {
        expect(pivots(m1, 2, 2, 'low')).toEqual([{ index: 3, price: 7, confirm: 5 }]);
    });
    it('右側 K 棒還沒收完就不存在（資料只到 index 4）', () => {
        expect(pivots(m1.slice(0, 5), 2, 2, 'low')).toEqual([]);
    });
});

describe('PRICE_STRUCTURE', () => {
    const atr = (n: number) => Array.from({ length: n }, () => 2);
    // 0–9 平盤，訊號在 index 9（09:09）；10–12 上漲到高點 index 12；13–15 回檔到低點 index 15；
    // 16–17 右側確認（低點於 index 17 確認）；18 收盤突破
    const path: [number, number, number, number][] = [
        ...Array.from({ length: 10 }, () => [100, 101, 99, 100] as [number, number, number, number]),
        [100, 103, 100, 102], [102, 105, 102, 104], [104, 108, 104, 107],
        [107, 107, 104, 105], [105, 105, 102, 103], [103, 104, 101, 102],
        [102, 104, 102, 103], [103, 105, 102, 104],
        [104, 110, 104, 109], [109, 112, 108, 111],
    ];
    const m1 = path.map(([o, h, l, c], i) => bar(i, o, h, l, c));
    const s = signal('BUY', m1[9]!.time);
    const w = signalWindow(s, undefined, m1, 3);
    const run = (bars: Candle[], p: EntryParams = P, sig = s, win = w) =>
        priceStructureEntry('id', sig, win, bars, atr(bars.length), pivots(bars, 2, 2, 'high'), pivots(bars, 2, 2, 'low'), p, bars.at(-1)!.time);

    it('回檔轉折確認後，收盤突破回檔起點才觸發', () => {
        const e = run(m1);
        expect(e).toMatchObject({ status: 'TRIGGERED', barTime: m1[18]!.time, refPrice: 109 });
        expect(e.reason).toContain('108');
    });
    it('轉折尚未確認時，即使收盤已越過高點也不觸發（不使用未來轉折）', () => {
        // index 16 大漲收在 109 > 108：但低點 index 15 要到 index 17 收盤才確認，
        // index 17 收 104 未突破，第一個「已確認且突破」的是 index 18
        const early = m1.map((b, i) => (i === 16 ? bar(i, 102, 110, 102, 109) : b));
        const e = run(early);
        expect(e.barTime).not.toBe(early[16]!.time);
        expect(e.barTime).toBe(early[18]!.time);
    });
    it('回檔轉折在 5m 訊號之前形成不算', () => {
        const sLate = signal('BUY', m1[16]!.time);
        const e = run(m1, P, sLate, signalWindow(sLate, undefined, m1, 3));
        expect(e.status).not.toBe('TRIGGERED');
    });
    it('收盤跌破回檔轉折 → 結構失效，之後的突破不觸發', () => {
        const broken = m1.map((b, i) => (i === 17 ? bar(i, 103, 103, 100, 100.5) : b));
        expect(run(broken.slice(0, 19)).status).not.toBe('TRIGGERED');
    });
    it('回檔深度低於門檻不觸發', () => {
        expect(run(m1, { ...P, minPullbackAtr: 4 }).status).not.toBe('TRIGGERED'); // 深度 6 < 4 × 2
    });
    it('空單鏡像：反彈轉折確認後跌破反彈起點', () => {
        const mirror = m1.map((b) => ({ ...b, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));
        const ss = signal('SELL', mirror[9]!.time);
        const e = run(mirror, P, ss, signalWindow(ss, undefined, mirror, 3));
        expect(e).toMatchObject({ status: 'TRIGGERED', barTime: mirror[18]!.time, direction: 'SHORT' });
    });
});

describe('PULLBACK_KD（舊假說，可選比較）', () => {
    const m1 = flat(30);
    const ind = (k: number, kPrev: number): KdIndicators => ({
        ema: m1.map(() => 99.5),
        atr: m1.map(() => 2),
        vwap: m1.map(() => undefined),
        k: m1.map((_, i) => (i === 12 ? k : kPrev)),
        d: m1.map(() => 50),
    });
    it('回測 EMA、站回、KD 黃金交叉才觸發', () => {
        expect(evalSetup(m1, ind(60, 40), 12, 'LONG').stage).toBe('READY');
        const s = signal('BUY', t0 + 600);
        expect(pullbackKdEntry('id', s, signalWindow(s, undefined, m1, 3), m1, ind(60, 40), t0 + 1500).barTime).toBe(m1[12]!.time);
    });
    it('K ≥ 80 追價過濾', () => {
        const s = signal('BUY', t0 + 600);
        expect(pullbackKdEntry('id', s, signalWindow(s, undefined, m1, 3), m1, ind(85, 40), t0 + 1500).status).toBe('EXPIRED');
    });
});
