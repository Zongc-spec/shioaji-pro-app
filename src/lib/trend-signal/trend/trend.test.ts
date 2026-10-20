// src/lib/trend-signal/trend/trend.test.ts — 趨勢演算法與訊號的驗收性質：
// A1 不偷看未來、A3 BUY／SELL 交替、A4 線與收盤同側、A5 SuperTrend 棘輪、
// A7 起點不變（暖身後）、A10 數值對照（獨立的參考實作或手算值）。
import { describe, expect, it } from 'vitest';
import { donchian, supertrend } from '../../indicators';
import type { Candle } from '../../types/market';
import { buildTf } from '../core/bars';
import { DEFAULT_CONFIG } from '../config';
import { sessionLabels, walkBars } from '../fixtures.test-harness';
import type { TfSeries, TrendAlgoId, TrendParams } from '../types';
import { ALGORITHMS, kamaLine } from './algorithms';
import { alignmentOf, emaNote, switchAt, trendAge, trendTrack } from './signals';

const labels = sessionLabels('2026-09-01', 14);
const raw = walkBars(labels, 7, { regime: 120 });
const m5: TfSeries = buildTf(raw, 5, 'FUT', Infinity);
const bars5 = m5.bars;
const params = (algo: TrendAlgoId): TrendParams => ({ ...DEFAULT_CONFIG.trend, algo });
const series = (b: Candle[]): TfSeries => ({ tf: 5, bars: b, lastMinute: b.map((x) => x.time), session: b.map(() => '') });

describe('A10 數值對照', () => {
    it('SuperTrend 方向與線值等於既有 supertrend()（暖身後）', () => {
        const tr = trendTrack(m5, params('supertrend'));
        const ref = supertrend(bars5, 10, 3);
        const warm = ALGORITHMS.supertrend.warmup(params('supertrend'));
        for (let i = warm; i < bars5.length; i++) {
            const up = ref.up[i]!.value;
            const down = ref.down[i]!.value;
            expect(tr.dir[i]).toBe(up !== undefined ? 'UP' : 'DOWN');
            expect(tr.line[i]).toBe(up ?? down);
        }
        expect(tr.dir.slice(0, warm).every((d) => d === 'UNKNOWN')).toBe(true);
    });

    it('Donchian 方向等於以既有 donchian()（平移一根＝前 n 根）建的參考狀態機', () => {
        const n = 20;
        const tr = trendTrack(m5, params('donchian'));
        const ch = donchian(bars5, n); // 第 j 個點對應 bars[j + n - 1]，含當根
        let d = 0;
        for (let i = n; i < bars5.length; i++) {
            const hh = ch.upper[i - n]!.value!; // bars[i-1] 的通道 = 前 n 根
            const ll = ch.lower[i - n]!.value!;
            const c = bars5[i]!.close;
            if (c > hh) d = 1;
            else if (c < ll) d = -1;
            expect(tr.dir[i]).toBe(d === 0 ? 'UNKNOWN' : d === 1 ? 'UP' : 'DOWN');
            if (d !== 0) expect(tr.line[i]).toBe(d === 1 ? ll : hh);
        }
    });

    it('KAMA 線與手算值相同（n=2, fast=2, slow=4）', () => {
        const bars = [10, 11, 13, 12].map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 1 }));
        const k = kamaLine(bars, 2, 2, 4);
        expect(k[0]).toBeUndefined();
        expect(k[1]).toBeUndefined();
        // i=2：ER = 3/3 = 1 → sc = (2/3)² → 11 + 0.4444 × 2
        expect(k[2]).toBeCloseTo(11 + (4 / 9) * 2, 10);
        // i=3：ER = 1/3 → sc = (1/3 × (2/3 − 0.4) + 0.4)²
        const s = ((1 / 3) * (2 / 3 - 0.4) + 0.4) ** 2;
        expect(k[3]).toBeCloseTo(k[2]! + s * (12 - k[2]!), 10);
    });
});

describe.each(['supertrend', 'donchian', 'kama'] as TrendAlgoId[])('%s', (algo) => {
    const p = params(algo);
    const full = trendTrack(m5, p);

    it('A1 不偷看未來：只用 bars[0..i] 算出的第 i 根與全量相同', () => {
        for (const i of [200, 431, 777, bars5.length - 1]) {
            const prefix = trendTrack(series(bars5.slice(0, i + 1)), p);
            expect(prefix.dir[i]).toBe(full.dir[i]);
            expect(prefix.line[i]).toBe(full.line[i]);
        }
    });

    it('A3 BUY／SELL 嚴格交替、只在 DOWN↔UP 之間產生', () => {
        const kinds: string[] = [];
        for (let i = 0; i < bars5.length; i++) {
            const k = switchAt(full.dir, i);
            if (k) kinds.push(k);
        }
        expect(kinds.length).toBeGreaterThan(5);
        for (let i = 1; i < kinds.length; i++) expect(kinds[i]).not.toBe(kinds[i - 1]);
    });

    it('A7 起點不變：從後段起點計算，暖身後方向與線值（差 ≤ 0.5）相同', () => {
        const warm = ALGORITHMS[algo].warmup(p);
        for (const s of [137, 400, 911]) {
            const sub = trendTrack(series(bars5.slice(s)), p);
            for (let i = warm; i < sub.dir.length; i++) {
                if (sub.dir[i] === 'UNKNOWN' || full.dir[s + i] === 'UNKNOWN') continue;
                expect(sub.dir[i]).toBe(full.dir[s + i]);
                expect(Math.abs(sub.line[i]! - full.line[s + i]!)).toBeLessThanOrEqual(0.5);
            }
        }
    });

    if (algo !== 'kama') {
        it('A4 UP 時收盤不低於線、DOWN 時不高於線', () => {
            for (let i = 0; i < bars5.length; i++) {
                const v = full.line[i];
                if (v === undefined) continue;
                const c = bars5[i]!.close;
                if (full.dir[i] === 'UP') expect(c).toBeGreaterThanOrEqual(v);
                if (full.dir[i] === 'DOWN') expect(c).toBeLessThanOrEqual(v);
            }
        });
    }
});

it('A5 SuperTrend 棘輪：同一段 UP 內線值不下降、DOWN 內不上升', () => {
    const tr = trendTrack(m5, params('supertrend'));
    for (let i = 1; i < bars5.length; i++) {
        const a = tr.line[i - 1];
        const b = tr.line[i];
        if (a === undefined || b === undefined || tr.dir[i] !== tr.dir[i - 1]) continue;
        if (tr.dir[i] === 'UP') expect(b).toBeGreaterThanOrEqual(a);
        if (tr.dir[i] === 'DOWN') expect(b).toBeLessThanOrEqual(a);
    }
});

describe('訊號工具', () => {
    it('UNKNOWN → UP 不是訊號；DOWN → UP 是 BUY', () => {
        expect(switchAt(['UNKNOWN', 'UP'], 1)).toBeNull();
        expect(switchAt(['DOWN', 'UP'], 1)).toBe('BUY');
        expect(switchAt(['UP', 'DOWN'], 1)).toBe('SELL');
        expect(switchAt(['UP', 'UP'], 1)).toBeNull();
    });
    it('高週期關係與趨勢年齡', () => {
        expect(alignmentOf('UP', 'UP')).toBe('ALIGN');
        expect(alignmentOf('DOWN', 'UP')).toBe('DIVERGE');
        expect(alignmentOf('UNKNOWN', 'UP')).toBe('NEUTRAL');
        expect(trendAge(['UNKNOWN', 'UP', 'UP', 'DOWN', 'DOWN', 'DOWN'], 5)).toBe(3);
        expect(trendAge(['UNKNOWN'], 0)).toBeNull();
    });
    it('EMA 註記只描述收盤與 EMA 斜率，與訊號方向比較', () => {
        const bars = [1, 2, 3, 4].map((c, i) => ({ time: i, open: c, high: c, low: c, close: c + 10, volume: 1 }));
        const e = [undefined, 10, 11, 12];
        expect(emaNote(bars, e, 3, 'BUY', 2)).toBe('WITH');
        expect(emaNote(bars, e, 3, 'SELL', 2)).toBe('AGAINST');
        expect(emaNote(bars, e, 1, 'BUY', 2)).toBe('UNKNOWN');
    });
});
