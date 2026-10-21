// src/lib/trend-signal/trend/trend.test.ts — TrendCore（候選 A SuperTrend、B KAMA、C Donchian＋ATR）
// 的驗收性質：A1 不偷看未來、A3 每次狀態切換只有一個事件、A4 線與收盤同側、A5 棘輪、
// A7 起點不變（暖身後）、A10 數值對照（獨立的參考實作或手算值），以及 MtfContext。
import { describe, expect, it } from 'vitest';
import { atr, donchian, supertrend } from '../../indicators';
import type { Candle } from '../../types/market';
import { alignPoints, buildTf } from '../core/bars';
import { DEFAULT_CONFIG } from '../config';
import { sessionLabels, T, walkBars } from '../fixtures.test-harness';
import type { TfSeries, TrendAlgoId, TrendParams, TrendState } from '../types';
import { ALGORITHMS, kamaLine } from './algorithms';
import { tfAt } from './mtf';
import { alignmentOf, emaNote, invalidAt, switchAt, trendAge, trendTrack } from './signals';

const labels = sessionLabels('2026-09-01', 14);
const raw = walkBars(labels, 7, { regime: 120 });
const m5: TfSeries = buildTf(raw, 5, 'FUT', Infinity);
const bars5 = m5.bars;
const params = (algo: TrendAlgoId): TrendParams => ({ ...DEFAULT_CONFIG.trend, algo });
const series = (b: Candle[]): TfSeries => ({ tf: 5, bars: b, lastMinute: b.map((x) => x.time), session: b.map(() => ''), sessionEnd: b.map(() => Infinity) });

describe('A10 數值對照', () => {
    it('SuperTrend 方向與線值等於既有 supertrend()（暖身後）', () => {
        const tr = trendTrack(m5, params('supertrend'));
        const ref = supertrend(bars5, 10, 3);
        const warm = ALGORITHMS.supertrend.warmup(params('supertrend'));
        for (let i = warm; i < bars5.length; i++) {
            const up = ref.up[i]!.value;
            const down = ref.down[i]!.value;
            expect(tr.dir[i]).toBe(up !== undefined ? 'LONG' : 'SHORT');
            expect(tr.line[i]).toBe(up ?? down);
        }
        expect(tr.dir.slice(0, warm).every((d) => d === 'UNKNOWN')).toBe(true);
    });

    it('Donchian＋ATR 等於以既有 donchian()／atr() 建的參考狀態機', () => {
        const p = params('donchian');
        const n = p.dcLength;
        const k = p.dcAtrMult;
        const tr = trendTrack(m5, p);
        const ch = donchian(bars5, n); // 第 j 個點對應 bars[j + n − 1] 的通道（含當根）
        const a = alignPoints(bars5, atr(bars5, 14));
        const warm = ALGORITHMS.donchian.warmup(p);
        let st: TrendState = 'UNKNOWN';
        let band = Number.NaN;
        let longs = 0;
        let neutrals = 0;
        for (let i = n; i < bars5.length; i++) {
            const av = a[i];
            if (av === undefined) continue;
            const prevHigh = ch.upper[i - n]!.value!; // bars[i − 1] 的通道 = 前 n 根
            const prevLow = ch.lower[i - n]!.value!;
            const nowHigh = ch.upper[i - n + 1]!.value!; // bars[i] 的通道 = 含當根的近 n 根
            const nowLow = ch.lower[i - n + 1]!.value!;
            const c = bars5[i]!.close;
            if (c > prevHigh && st !== 'LONG') [st, band] = ['LONG', nowHigh - k * av];
            else if (c < prevLow && st !== 'SHORT') [st, band] = ['SHORT', nowLow + k * av];
            else if (st === 'LONG') band = Math.max(band, nowHigh - k * av);
            else if (st === 'SHORT') band = Math.min(band, nowLow + k * av);
            else st = 'NEUTRAL';
            if ((st === 'LONG' && c < band) || (st === 'SHORT' && c > band)) st = 'NEUTRAL';
            if (i < warm) continue;
            expect(tr.dir[i]).toBe(st);
            expect(tr.line[i]).toBe(st === 'NEUTRAL' ? undefined : band);
            if (st === 'LONG') longs++;
            if (st === 'NEUTRAL') neutrals++;
        }
        // 合成資料要同時出現趨勢與失效，對照才不空轉
        expect(longs).toBeGreaterThan(100);
        expect(neutrals).toBeGreaterThan(20);
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

    it('A3 每次狀態切換只產生一個事件：進入 LONG／SHORT 為 BUY／SELL、進入 NEUTRAL 為失效', () => {
        const seq: string[] = [];
        for (let i = 0; i < bars5.length; i++) {
            const kind = switchAt(full.dir, i);
            const inv = invalidAt(full.dir, i);
            const cur = full.dir[i]!;
            const prev = i > 0 ? full.dir[i - 1]! : 'UNKNOWN';
            const changed = prev !== 'UNKNOWN' && prev !== cur;
            expect(kind !== null && inv !== null).toBe(false);
            expect(kind !== null || inv !== null).toBe(changed);
            if (kind) expect(cur).toBe(kind === 'BUY' ? 'LONG' : 'SHORT');
            if (kind) seq.push(kind);
            if (inv) seq.push(`INVALID_${inv}`);
        }
        expect(seq.filter((k) => k === 'BUY' || k === 'SELL').length).toBeGreaterThan(5);
        // 同一種訊號之間一定隔著反向訊號或該方向的失效：不會連續兩次 BUY 卻沒有離開 LONG
        for (let i = 1; i < seq.length; i++) {
            if (seq[i] === 'BUY') expect(seq[i - 1]).not.toBe('BUY');
            if (seq[i] === 'SELL') expect(seq[i - 1]).not.toBe('SELL');
            if (seq[i] === 'INVALID_LONG') expect(seq[i - 1]).toBe('BUY');
            if (seq[i] === 'INVALID_SHORT') expect(seq[i - 1]).toBe('SELL');
        }
    });

    it('A7 起點不變：從後段起點計算，暖身後狀態與線值（差 ≤ 0.5）相同', () => {
        const warm = ALGORITHMS[algo].warmup(p);
        for (const s of [137, 400, 911]) {
            const sub = trendTrack(series(bars5.slice(s)), p);
            for (let i = warm; i < sub.dir.length; i++) {
                if (sub.dir[i] === 'UNKNOWN' || full.dir[s + i] === 'UNKNOWN') continue;
                expect(sub.dir[i]).toBe(full.dir[s + i]);
                if (sub.line[i] !== undefined) expect(Math.abs(sub.line[i]! - full.line[s + i]!)).toBeLessThanOrEqual(0.5);
            }
        }
    });

    if (algo !== 'kama') {
        it('A4 LONG 時收盤不低於線、SHORT 時不高於線；NEUTRAL 沒有線', () => {
            for (let i = 0; i < bars5.length; i++) {
                const v = full.line[i];
                if (full.dir[i] === 'NEUTRAL' || full.dir[i] === 'UNKNOWN') expect(v).toBeUndefined();
                if (v === undefined) continue;
                const c = bars5[i]!.close;
                if (full.dir[i] === 'LONG') expect(c).toBeGreaterThanOrEqual(v);
                if (full.dir[i] === 'SHORT') expect(c).toBeLessThanOrEqual(v);
            }
        });
        it('A5 棘輪：同一段 LONG 內線值不下降、SHORT 內不上升', () => {
            for (let i = 1; i < bars5.length; i++) {
                const a = full.line[i - 1];
                const b = full.line[i];
                if (a === undefined || b === undefined || full.dir[i] !== full.dir[i - 1]) continue;
                if (full.dir[i] === 'LONG') expect(b).toBeGreaterThanOrEqual(a);
                if (full.dir[i] === 'SHORT') expect(b).toBeLessThanOrEqual(a);
            }
        });
    } else {
        it('KAMA 不輸出 NEUTRAL（只在多空之間翻轉）', () => {
            expect(full.dir.includes('NEUTRAL')).toBe(false);
        });
    }
});

it('SuperTrend 也不輸出 NEUTRAL；只有 Donchian＋ATR 會失效', () => {
    expect(trendTrack(m5, params('supertrend')).dir.includes('NEUTRAL')).toBe(false);
    expect(trendTrack(m5, params('donchian')).dir.includes('NEUTRAL')).toBe(true);
});

it('Donchian＋ATR：進入 LONG 的那一根收盤一定突破前 n 根最高價（SHORT 鏡像）', () => {
    const p = params('donchian');
    const tr = trendTrack(m5, p);
    let checked = 0;
    for (let i = p.dcLength; i < bars5.length; i++) {
        const k = switchAt(tr.dir, i);
        if (!k) continue;
        const prev = bars5.slice(i - p.dcLength, i);
        const c = bars5[i]!.close;
        if (k === 'BUY') expect(c).toBeGreaterThan(Math.max(...prev.map((b) => b.high)));
        else expect(c).toBeLessThan(Math.min(...prev.map((b) => b.low)));
        checked++;
    }
    expect(checked).toBeGreaterThan(5);
});

describe('訊號工具', () => {
    it('SHORT／NEUTRAL → LONG 是 BUY；UNKNOWN → LONG 不是（暖身結束不算切換）', () => {
        expect(switchAt(['UNKNOWN', 'LONG'], 1)).toBeNull();
        expect(switchAt(['SHORT', 'LONG'], 1)).toBe('BUY');
        expect(switchAt(['NEUTRAL', 'LONG'], 1)).toBe('BUY');
        expect(switchAt(['LONG', 'SHORT'], 1)).toBe('SELL');
        expect(switchAt(['NEUTRAL', 'SHORT'], 1)).toBe('SELL');
        expect(switchAt(['LONG', 'LONG'], 1)).toBeNull();
        expect(switchAt(['LONG', 'NEUTRAL'], 1)).toBeNull();
    });
    it('LONG／SHORT → NEUTRAL 是失效（不是反向訊號）', () => {
        expect(invalidAt(['LONG', 'NEUTRAL'], 1)).toBe('LONG');
        expect(invalidAt(['SHORT', 'NEUTRAL'], 1)).toBe('SHORT');
        expect(invalidAt(['NEUTRAL', 'NEUTRAL'], 1)).toBeNull();
        expect(invalidAt(['UNKNOWN', 'NEUTRAL'], 1)).toBeNull();
    });
    it('高週期關係與趨勢年齡', () => {
        expect(alignmentOf('LONG', 'LONG')).toBe('ALIGN');
        expect(alignmentOf('SHORT', 'LONG')).toBe('DIVERGE');
        expect(alignmentOf('UNKNOWN', 'LONG')).toBe('NEUTRAL');
        expect(alignmentOf('NEUTRAL', 'LONG')).toBe('NEUTRAL');
        expect(trendAge(['UNKNOWN', 'LONG', 'LONG', 'SHORT', 'SHORT', 'SHORT'], 5)).toBe(3);
        expect(trendAge(['LONG', 'NEUTRAL', 'NEUTRAL'], 2)).toBe(2);
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

describe('MtfContext：時點 t 當時已知的高週期', () => {
    const m15 = buildTf(raw, 15, 'FUT', Infinity);
    const t15 = trendTrack(m15, params('supertrend'));
    it('只取 label ≤ t 的已收 K 棒（09:05 看到的是 09:00 那根 15m，不是 09:15）', () => {
        const t = T('2026-09-02T09:05:00');
        const at = tfAt(m15, t15, t);
        expect(at.barTime).toBe(T('2026-09-02T09:00:00'));
        expect(at.state).toBe(t15.dir[at.index]);
        expect(at.stale).toBe(false);
    });
    it('換盤後第一根收棒前，上一盤的 15m 標為過期', () => {
        const at = tfAt(m15, t15, T('2026-09-02T08:50:00'));
        expect(at.barTime).toBe(T('2026-09-02T05:00:00'));
        expect(at.stale).toBe(true);
    });
});
