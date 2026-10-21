// src/lib/trend-signal/trigger/trigger.test.ts — EntryTiming（V1.1 §4）：提示範圍＝整段 5m 同向
// 狀態（可選 post-flip 窗口），5m 反向／失效即停止、換盤後與資料缺洞時 5m 過期不提示、
// 5m 桶內缺 1m 之後不提示、每盤最後一根不提示；IMMEDIATE 每段一次、MICRO_TREND 每次「反向／中性後轉回同向」都提示、
// PRICE_STRUCTURE 只用已確認轉折且提示後要有新的回檔轉折；空單鏡像；先前策略假說只在選用時計算。
import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { buildTf, holeBefore } from '../core/bars';
import { DEFAULT_CONFIG } from '../config';
import { T } from '../fixtures.test-harness';
import type { EntryParams, TrendSignal, TrendState } from '../types';
import { computeEntries } from './entries';
import { immediateHints, microTrendHints, pivots, priceStructureHints } from './modes';
import { evalSetup, pullbackKdHints, type KdIndicators } from './pullback-kd';
import { segmentClosed, trendSegment } from './window';

const t0 = T('2026-10-20T09:00:00');
const P: EntryParams = { ...DEFAULT_CONFIG.entry, minPullbackAtr: 0.5 };
const at = (t: number, o: number, h: number, l: number, c: number): Candle => ({ time: t, open: o, high: h, low: l, close: c, volume: 10 });
const bar = (i: number, o: number, h: number, l: number, c: number) => at(t0 + 60 * i, o, h, l, c);
const flat = (n: number, px = 100) => Array.from({ length: n }, (_, i) => bar(i, px, px + 1, px - 1, px));

function signal(kind: 'BUY' | 'SELL', barTime: number, m1: Candle[], over: Partial<TrendSignal> = {}): TrendSignal {
    const m5 = buildTf(m1, 5, 'FUT', Infinity);
    const index = m5.bars.findIndex((b) => b.time === barTime);
    if (index < 0) throw new Error('訊號必須落在 5m 收棒');
    return {
        id: `sig-${kind}-${barTime}`,
        kind,
        direction: kind === 'BUY' ? 'LONG' : 'SHORT',
        barTime,
        index,
        session: m5.session[index]!,
        sessionEnd: m5.sessionEnd[index]!,
        close: m5.bars[index]!.close,
        line: undefined,
        atr: undefined,
        notes: { ema: 'UNKNOWN', m15: 'UNKNOWN', m60: 'UNKNOWN', m15Align: 'NEUTRAL', m60Align: 'NEUTRAL', m15BarTime: null, m60BarTime: null, m15Stale: false, m60Stale: false, m15Incomplete: false, m60Incomplete: false },
        ...over,
    };
}

/** dir5At(t) 給每根 5m 的狀態（預設整段與訊號同向） */
function segOf(sig: TrendSignal, m1: Candle[], dir5At?: (t: number) => TrendState, windowBars = 0) {
    const m5 = buildTf(m1, 5, 'FUT', Infinity).bars;
    const dir5 = m5.map((b) => dir5At?.(b.time) ?? sig.direction);
    return trendSegment(sig, { m1, m1SessionEnd: buildTf(m1, 1, 'FUT', Infinity).sessionEnd, m1Hole: holeBefore(m1, 'FUT'), m5, dir5, windowBars });
}
const labelsOf = (m1: Candle[], idx: number[]) => idx.map((m) => m1[m]!.time);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k);

describe('提示範圍（整段 5m 趨勢）', () => {
    const m1 = flat(40); // 09:00–09:39
    const s = signal('BUY', t0 + 600, m1); // 5m 09:10
    it('訊號收棒後到 5m 離開該方向為止；反向那一根 5m 收棒起不再提示', () => {
        const seg = segOf(s, m1, (t) => (t >= t0 + 1500 ? 'SHORT' : 'LONG'));
        expect(labelsOf(m1, seg.bars)).toEqual(range(11, 24).map((i) => t0 + 60 * i));
        expect(seg).toMatchObject({ endedAt: t0 + 1500, endState: 'SHORT' });
        expect(segmentClosed(seg, t0 + 1500, 0)).toContain('反向');
    });
    it('5m 失效（NEUTRAL）同樣停止，原因不同', () => {
        const seg = segOf(s, m1, (t) => (t >= t0 + 1500 ? 'NEUTRAL' : 'LONG'));
        expect(seg.endState).toBe('NEUTRAL');
        expect(segmentClosed(seg, t0 + 1500, 0)).toContain('失效');
    });
    it('5m 仍同向：整段都可提示（不受 15 分鐘限制）', () => {
        const seg = segOf(s, m1);
        expect(seg.bars.length).toBe(m1.length - 11);
        expect(segmentClosed(seg, m1.at(-1)!.time, 0)).toBeNull();
    });
    it('可選 post-flip 窗口：只取翻轉後 N 根 5m，且不超過該盤收盤', () => {
        const seg = segOf(s, m1, undefined, 2);
        expect(labelsOf(m1, seg.bars)).toEqual(range(11, 20).map((i) => t0 + 60 * i));
        expect(segmentClosed(seg, t0 + 1200, 2)).toContain('post-flip');
        const close = T('2026-10-20T13:45:00');
        const late = Array.from({ length: 15 }, (_, i) => at(close - 60 * (14 - i), 100, 101, 99, 100));
        const sl = signal('BUY', T('2026-10-20T13:35:00'), late);
        expect(segOf(sl, late, undefined, 5).windowEnd).toBe(close);
    });
    it('每盤最後一根 1m 不提示；換盤後第一根 5m 收棒前 5m 過期，不提示（隔夜）', () => {
        const dayEnd = T('2026-10-20T13:45:00');
        const day = Array.from({ length: 15 }, (_, i) => at(dayEnd - 60 * (14 - i), 100, 101, 99, 100)); // 13:31–13:45
        const night = Array.from({ length: 12 }, (_, i) => at(T('2026-10-20T15:01:00') + 60 * i, 100, 101, 99, 100)); // 15:01–15:12
        const m = [...day, ...night];
        const seg = segOf(signal('BUY', T('2026-10-20T13:35:00'), m), m);
        const hm = labelsOf(m, seg.bars).map((t) => new Date(t * 1000).toISOString().slice(11, 16));
        expect(hm).toEqual(['13:36', '13:37', '13:38', '13:39', '13:40', '13:41', '13:42', '13:43', '13:44', '15:05', '15:06', '15:07', '15:08', '15:09', '15:10', '15:11', '15:12']);
    });
    it('資料缺洞：缺整根 5m 時過期不提示；缺口所在的 5m 桶剩下的 1m 也不提示；下一根 5m 收棒後恢復', () => {
        const gap = m1.filter((b) => b.time < t0 + 960 || b.time > t0 + 1620); // 缺 09:16–09:27
        const seg = segOf(signal('BUY', t0 + 600, gap), gap);
        const mins = labelsOf(gap, seg.bars).map((t) => (t - t0) / 60);
        // 09:30 的桶（09:26–09:30）缺 09:26、09:27：09:28–09:30 不提示
        expect(mins).toEqual([...range(11, 15), ...range(31, 39)]);
    });
    it('5m 桶內缺 1m：缺口之後到該桶收盤不提示，缺口之前照常（因果，不看未來）', () => {
        const gap = m1.filter((b) => b.time !== t0 + 1020); // 缺 09:17
        const seg = segOf(signal('BUY', t0 + 600, gap), gap);
        const mins = labelsOf(gap, seg.bars).map((t) => (t - t0) / 60);
        expect(mins).toEqual([...range(11, 16), ...range(21, 39)]);
    });
});

describe('IMMEDIATE', () => {
    const m1 = flat(20);
    it('5m 收棒即提示一次，參考價為訊號收盤', () => {
        const s = signal('BUY', t0 + 600, m1, { close: 123 });
        const r = immediateHints(segOf(s, m1), 'k');
        expect(r.hints).toHaveLength(1);
        expect(r.hints[0]).toMatchObject({ kind: 'POTENTIAL_ENTRY_LONG', barTime: t0 + 600, refPrice: 123, mode: 'IMMEDIATE', seq: 1 });
    });
    it('訊號落在該盤最後一根：不提示（不跨盤進場）', () => {
        const end = T('2026-10-20T13:45:00');
        const late = Array.from({ length: 10 }, (_, i) => at(end - 60 * (9 - i), 100, 101, 99, 100));
        expect(immediateHints(segOf(signal('BUY', end, late), late), 'k').hints).toEqual([]);
    });
});

describe('MICRO_TREND', () => {
    const m1 = flat(30);
    const s = signal('BUY', t0 + 600, m1); // 1m index 10
    const dirs = (spec: Record<number, TrendState>, base: TrendState = 'LONG'): TrendState[] => m1.map((_, i) => spec[i] ?? base);
    const run = (micro: TrendState[], sig = s, dir5At?: (t: number) => TrendState, windowBars = 0) =>
        microTrendHints(segOf(sig, m1, dir5At, windowBars), m1, micro, 'k').hints;

    it('訊號後 1m 先反向、再轉回同向的那一根提示', () => {
        expect(run(dirs({ 12: 'SHORT', 13: 'SHORT' })).map((e) => e.barTime)).toEqual([m1[14]!.time]);
    });
    it('整段趨勢內每次回檔後轉回都提示（含中性），第幾次遞增', () => {
        const hints = run(dirs({ 12: 'SHORT', 13: 'SHORT', 18: 'NEUTRAL', 22: 'SHORT' }));
        expect(hints.map((e) => [e.barTime, e.seq])).toEqual([[m1[14]!.time, 1], [m1[19]!.time, 2], [m1[23]!.time, 3]]);
        expect(hints[1]!.reason).toContain('中性');
        expect(new Set(hints.map((e) => e.id)).size).toBe(3);
    });
    it('1m 一直同向（沒有回檔）不提示 — 不是「已同向就進場」', () => {
        expect(run(dirs({}))).toEqual([]);
    });
    it('轉回發生在訊號那一根（含之前）不算；訊號後第一根轉回才算', () => {
        expect(run(dirs({ 9: 'SHORT' }))).toEqual([]);
        expect(run(dirs({ 9: 'SHORT', 10: 'SHORT' })).map((e) => e.barTime)).toEqual([m1[11]!.time]);
    });
    it('UNKNOWN → 同向不算轉回', () => {
        expect(run(dirs({ 12: 'UNKNOWN' }))).toEqual([]);
    });
    it('5m 反向或失效之後的轉回不提示', () => {
        const micro = dirs({ 16: 'SHORT' });
        expect(run(micro)).toHaveLength(1);
        expect(run(micro, s, (t) => (t >= t0 + 900 ? 'SHORT' : 'LONG'))).toEqual([]);
        expect(run(micro, s, (t) => (t >= t0 + 900 ? 'NEUTRAL' : 'LONG'))).toEqual([]);
    });
    it('post-flip 窗口外的轉回不提示', () => {
        expect(run(dirs({ 16: 'SHORT' }), s, undefined, 1)).toEqual([]);
        expect(run(dirs({ 12: 'SHORT' }), s, undefined, 1)).toHaveLength(1);
    });
    it('空單鏡像', () => {
        const ss = signal('SELL', t0 + 600, m1);
        const hints = run(dirs({ 12: 'LONG' }, 'SHORT'), ss);
        expect(hints.map((e) => [e.barTime, e.kind])).toEqual([[m1[13]!.time, 'POTENTIAL_ENTRY_SHORT']]);
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
    type Ohlc = [number, number, number, number];
    // 0–10 平盤，訊號在 index 10（09:10）。第一段：高點 13（108，15 確認）→ 回檔低點 16（101，18 確認）
    // → 19 收 109 突破 108。第二段：高點 21（114，23 確認）→ 回檔低點 24（106，26 確認）→ 27 收 115 突破 114
    const path: Ohlc[] = [
        ...Array.from({ length: 11 }, () => [100, 101, 99, 100] as Ohlc),
        [100, 103, 100, 102], [102, 105, 102, 104], [104, 108, 104, 107],
        [107, 107, 104, 105], [105, 105, 102, 103], [103, 104, 101, 102],
        [102, 104, 102, 103], [103, 105, 102, 104],
        [104, 110, 104, 109], [109, 112, 108, 111],
        [111, 114, 110, 113], [113, 113, 109, 110], [110, 111, 107, 108], [108, 109, 106, 107],
        [107, 110, 107, 109], [109, 112, 108, 111],
        [111, 116, 111, 115], [115, 117, 114, 116],
    ];
    const m1 = path.map(([o, h, l, c], i) => bar(i, o, h, l, c));
    const s = signal('BUY', m1[10]!.time, m1);
    const run = (bars: Candle[], p: EntryParams = P, sig?: TrendSignal) => {
        const g = sig ?? signal('BUY', m1[10]!.time, bars);
        return priceStructureHints(segOf(g, bars), bars, atr(bars.length), pivots(bars, 2, 2, 'high'), pivots(bars, 2, 2, 'low'), p, 'k');
    };
    const idx = (bars: Candle[], hints: { barTime: number }[]) => hints.map((e) => bars.findIndex((b) => b.time === e.barTime));

    it('回檔轉折確認後，收盤突破回檔起點才提示；提示後要有新的回檔轉折才再提示', () => {
        const r = run(m1);
        expect(idx(m1, r.hints)).toEqual([19, 27]);
        expect(r.hints.map((e) => [e.refPrice, e.seq])).toEqual([[109, 1], [115, 2]]);
        expect(r.hints[0]!.reason).toContain('108');
        expect(r.hints[1]!.reason).toContain('114');
    });
    it('提示後沒有新的回檔轉折：價格續漲也不再提示', () => {
        const up = [...m1.slice(0, 21), ...Array.from({ length: 8 }, (_, k) => bar(21 + k, 111 + 2 * k, 113 + 2 * k, 111 + 2 * k, 113 + 2 * k))];
        expect(idx(up, run(up).hints)).toEqual([19]);
    });
    it('轉折尚未確認時，即使收盤已越過高點也不提示（不使用未來轉折）', () => {
        // index 17 大漲收在 109 > 108：但低點 index 16 要到 index 18 收盤才確認，
        // index 18 收 104 未突破，第一個「已確認且突破」的是 index 19
        const early = m1.map((b, i) => (i === 17 ? bar(i, 102, 110, 102, 109) : b));
        const first = idx(early, run(early).hints)[0];
        expect(first).not.toBe(17);
        expect(first).toBe(19);
    });
    it('回檔轉折在 5m 訊號之前形成不算（第一段不提示，第二段才提示）', () => {
        const sLate = signal('BUY', m1[20]!.time, m1);
        expect(idx(m1, run(m1, P, sLate).hints)).toEqual([27]);
    });
    it('收盤跌破已確認的回檔轉折 → 結構失效，之後的突破不提示', () => {
        const broken = m1.map((b, i) => (i === 19 ? bar(i, 103, 104, 100, 100.5) : b)).slice(0, 21);
        expect(run(broken).hints).toEqual([]);
        expect(run(broken).waiting).toContain('跌破');
        expect(idx(m1, run(m1.slice(0, 21)).hints)).toEqual([19]);
    });
    it('回檔深度低於門檻不提示', () => {
        expect(run(m1, { ...P, minPullbackAtr: 4.5 }).hints).toEqual([]); // 深度 7、8 < 4.5 × 2
    });
    it('空單鏡像：反彈轉折確認後跌破反彈起點', () => {
        const mirror = m1.map((b) => ({ ...b, open: 300 - b.open, high: 300 - b.low, low: 300 - b.high, close: 300 - b.close }));
        const ss = signal('SELL', mirror[10]!.time, mirror);
        const hints = run(mirror, P, ss).hints;
        expect(idx(mirror, hints)).toEqual([19, 27]);
        expect(hints.every((e) => e.direction === 'SHORT')).toBe(true);
    });
    it('訊號 ID 只依觸發時間與參數：重算相同', () => {
        expect(run(m1).hints.map((e) => e.id)).toEqual(run(m1).hints.map((e) => e.id));
        expect(s.id).toBe(signal('BUY', m1[10]!.time, m1).id);
    });
});

describe('先前策略假說／未驗證（PULLBACK_KD）', () => {
    const m1 = flat(30);
    const s = signal('BUY', t0 + 600, m1);
    const ind = (crosses: number[], k = 60, kPrev = 40): KdIndicators => ({
        ema: m1.map(() => 99.5),
        atr: m1.map(() => 2),
        vwap: m1.map(() => undefined),
        k: m1.map((_, i) => (crosses.includes(i) ? k : kPrev)),
        d: m1.map(() => 50),
    });
    it('回測 EMA、站回、KD 黃金交叉才提示；每次交叉都提示', () => {
        expect(evalSetup(m1, ind([12]), 12, 'LONG').stage).toBe('READY');
        const hints = pullbackKdHints(segOf(s, m1), m1, ind([12, 20]), 'k').hints;
        expect(hints.map((e) => [e.barTime, e.seq])).toEqual([[m1[12]!.time, 1], [m1[20]!.time, 2]]);
        expect(hints[0]!.reason).toContain('先前策略假說／未驗證');
    });
    it('K ≥ 80 追價過濾', () => {
        expect(pullbackKdHints(segOf(s, m1), m1, ind([12], 85), 'k').hints).toEqual([]);
    });
});

describe('computeEntries', () => {
    const m1 = flat(40);
    const s5 = buildTf(m1, 5, 'FUT', Infinity);
    const s1 = buildTf(m1, 1, 'FUT', Infinity);
    const sig = signal('BUY', t0 + 600, m1);
    const base = {
        signals: [sig],
        m1,
        m1Session: s1.session,
        m1SessionEnd: s1.sessionEnd,
        m1Hole: holeBefore(m1, 'FUT'),
        m5: s5.bars,
        dir5: s5.bars.map((): TrendState => 'LONG'),
        micro: m1.map((_, i): TrendState => (i === 15 ? 'SHORT' : 'LONG')),
        asOf: m1.at(-1)!.time,
        key: 'k',
    };
    it('IMMEDIATE、MICRO_TREND、PRICE_STRUCTURE 一律計算；先前策略假說只在風控選用時計算（預設 OFF）', () => {
        const off = computeEntries({ ...base, p: P });
        expect(Object.keys(off.states).sort()).toEqual(['IMMEDIATE', 'MICRO_TREND', 'PRICE_STRUCTURE']);
        expect(off.entries.some((e) => e.mode === 'PULLBACK_KD')).toBe(false);
        const on = computeEntries({ ...base, p: { ...P, mode: 'PULLBACK_KD' } });
        expect(on.states.PULLBACK_KD).toBeDefined();
    });
    it('最新一段的狀態：提示次數、最近一次、是否仍可提示', () => {
        const r = computeEntries({ ...base, p: P });
        expect(r.states.MICRO_TREND).toMatchObject({ active: true, hints: 1 });
        expect(r.states.MICRO_TREND!.last!.barTime).toBe(m1[16]!.time);
        const ended = computeEntries({ ...base, p: P, dir5: s5.bars.map((b): TrendState => (b.time >= t0 + 1500 ? 'NEUTRAL' : 'LONG')) });
        expect(ended.states.IMMEDIATE).toMatchObject({ active: false });
        expect(ended.states.IMMEDIATE!.waiting).toContain('失效');
    });
    it('沒有 5m 訊號：沒有提示', () => {
        expect(computeEntries({ ...base, signals: [], p: P })).toEqual({ entries: [], states: {} });
    });
    it('目前這根 5m 已缺 1m：狀態說明資料不完整', () => {
        const gap = m1.filter((b) => b.time !== t0 + 60 * 37); // 缺 09:37，最後一根 09:39
        const g1 = buildTf(gap, 1, 'FUT', Infinity);
        const r = computeEntries({ ...base, m1: gap, m1Session: g1.session, m1SessionEnd: g1.sessionEnd, m1Hole: holeBefore(gap, 'FUT'), micro: gap.map((): TrendState => 'LONG'), asOf: gap.at(-1)!.time, p: P });
        expect(r.states.MICRO_TREND!.waiting).toContain('資料不完整');
    });
});
