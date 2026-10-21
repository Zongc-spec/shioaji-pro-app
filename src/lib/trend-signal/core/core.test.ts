// src/lib/trend-signal/core/core.test.ts — 已收棒資料層：只有 label ≤ asOf 的 1m 算已收、
// 週期 K 棒與主圖 aggregate() 相同、交易時段（含收盤定盤）歸屬、即時 tick 組 1m 不重繪。
import { describe, expect, it } from 'vitest';
import { aggregate } from '../../utils/kbars';
import { pathBars, sessionLabels, T, walkBars } from '../fixtures.test-harness';
import { buildTf, completeOnly, confirmed1m, firstAfter, freshAt, holeBefore, lastAtOrBefore, tfBucket } from './bars';
import { composeBars, mergeTick, minuteLabel, rebaseTail } from './live';
import { isRegularMinute, isSessionOpen, tradingSessionOf } from './session';

describe('confirmed1m', () => {
    const bars = walkBars(sessionLabels('2026-10-19', 1), 1);
    it('只保留 label ≤ asOf 的 K 棒，回傳新陣列', () => {
        const asOf = T('2026-10-19T09:30:00');
        const out = confirmed1m(bars, asOf);
        expect(out.at(-1)!.time).toBe(asOf);
        expect(out.every((b) => b.time <= asOf)).toBe(true);
        expect(out).not.toBe(bars);
    });
    it('進行中的那一分鐘（label > asOf）不算已收', () => {
        const out = confirmed1m(bars, T('2026-10-19T09:30:59'));
        expect(out.at(-1)!.time).toBe(T('2026-10-19T09:30:00'));
    });
    it('未排序與重複 label 會正規化（後者覆蓋前者）', () => {
        const a = bars[3]!;
        const dup = { ...a, close: a.close + 99 };
        const out = confirmed1m([bars[5]!, a, bars[4]!, dup], Infinity);
        expect(out.map((b) => b.time)).toEqual([a.time, bars[4]!.time, bars[5]!.time]);
        expect(out[0]!.close).toBe(a.close + 99);
    });
});

describe('buildTf', () => {
    const labels = sessionLabels('2026-10-19', 2);
    const bars = walkBars(labels, 2);
    it('完整的週期 K 棒與主圖 aggregate() 完全相同', () => {
        for (const tf of [5, 15, 60] as const) {
            const asOf = labels.at(-1)!;
            const s = buildTf(bars, tf, 'FUT', asOf);
            expect(s.bars).toEqual(aggregate(bars, tf));
            expect(s.lastMinute.length).toBe(s.bars.length);
        }
    });
    it('最後一個未收完的桶不輸出', () => {
        const asOf = T('2026-10-19T09:13:00'); // 09:15 那根 5m 還差兩分鐘
        const s = buildTf(confirmed1m(bars, asOf), 5, 'FUT', asOf);
        expect(s.bars.at(-1)!.time).toBe(T('2026-10-19T09:10:00'));
    });
    it('收盤後（含定盤寬限）時段已結束：60m 殘桶 14:00 在 13:49 即確認', () => {
        const asOf = T('2026-10-19T13:49:00');
        const s = buildTf(confirmed1m(bars, asOf), 60, 'FUT', asOf);
        expect(s.bars.at(-1)!.time).toBe(T('2026-10-19T14:00:00'));
        const early = T('2026-10-19T13:46:00');
        expect(buildTf(confirmed1m(bars, early), 60, 'FUT', early).bars.at(-1)!.time).toBe(T('2026-10-19T13:00:00'));
    });
    it('每根記錄所屬交易時段與其收盤（夜盤跨午夜同一個 key）', () => {
        const s = buildTf(bars, 5, 'FUT', Infinity);
        const i = s.bars.findIndex((b) => b.time === T('2026-10-20T00:05:00'));
        const j = s.bars.findIndex((b) => b.time === T('2026-10-19T15:05:00'));
        expect(s.session[i]).toBe('2026-10-19N');
        expect(s.session[j]).toBe('2026-10-19N');
        expect(s.sessionEnd[i]).toBe(T('2026-10-20T05:00:00'));
        expect(s.sessionEnd[s.bars.findIndex((b) => b.time === T('2026-10-19T09:00:00'))]).toBe(T('2026-10-19T13:45:00'));
    });
});

describe('資料完整性（正規交易分鐘、缺分鐘計數、排除不完整的桶）', () => {
    it('正規交易分鐘：日盤 08:46–13:45、夜盤 15:01–05:00；收盤定盤寬限與週末不算', () => {
        expect(isRegularMinute('FUT', T('2026-10-20T08:46:00'))).toBe(true);
        expect(isRegularMinute('FUT', T('2026-10-20T08:45:00'))).toBe(false);
        expect(isRegularMinute('FUT', T('2026-10-20T13:45:00'))).toBe(true);
        expect(isRegularMinute('FUT', T('2026-10-20T13:46:00'))).toBe(false);
        expect(isRegularMinute('FUT', T('2026-10-20T15:01:00'))).toBe(true);
        expect(isRegularMinute('FUT', T('2026-10-21T05:00:00'))).toBe(true);
        expect(isRegularMinute('FUT', T('2026-10-21T05:01:00'))).toBe(false);
        expect(isRegularMinute('FUT', T('2026-10-24T02:00:00'))).toBe(true); // 週五夜盤
        expect(isRegularMinute('FUT', T('2026-10-24T09:00:00'))).toBe(false); // 週六
    });
    const labels = sessionLabels('2026-10-19', 1);
    const bars = walkBars(labels, 3);
    it('完整的 5m／15m／60m 缺 0；開盤第一根 60m（08:46–09:00）只要求 15 根', () => {
        for (const tf of [5, 15, 60] as const) expect(buildTf(bars, tf, 'FUT', Infinity).missing.every((m) => m === 0)).toBe(true);
    });
    it('桶內缺分鐘：計數正確，completeOnly 排除並列出缺口；收盤定盤桶（只有寬限分鐘）不算缺', () => {
        const drop = new Set([T('2026-10-19T10:27:00'), T('2026-10-19T10:28:00'), T('2026-10-19T10:29:00'), T('2026-10-19T10:30:00')]);
        const grace = { ...bars.find((b) => b.time === T('2026-10-19T13:45:00'))!, time: T('2026-10-19T13:47:00') };
        const gapped = [...bars.filter((b) => !drop.has(b.time) && b.time <= T('2026-10-19T13:45:00')), grace, ...bars.filter((b) => b.time > T('2026-10-19T13:45:00'))];
        const s5 = buildTf(gapped, 5, 'FUT', Infinity);
        expect(s5.missing[s5.bars.findIndex((b) => b.time === T('2026-10-19T10:30:00'))]).toBe(4);
        expect(s5.missing[s5.bars.findIndex((b) => b.time === T('2026-10-19T13:50:00'))]).toBe(0);
        const { series, gaps } = completeOnly(s5);
        expect(gaps).toEqual([{ tf: 5, label: T('2026-10-19T10:30:00'), missing: 4 }]);
        expect(series.bars.some((b) => b.time === T('2026-10-19T10:30:00'))).toBe(false);
        expect(series.bars).toHaveLength(s5.bars.length - 1);
        expect(series.missing.every((m) => m === 0)).toBe(true);
        const s60 = buildTf(gapped, 60, 'FUT', Infinity);
        expect(s60.missing[s60.bars.findIndex((b) => b.time === T('2026-10-19T11:00:00'))]).toBe(4);
    });
    it('holeBefore：1m 所屬 5m 桶在它之前已缺正規分鐘（只看之前；開盤、收盤定盤桶不誤判）', () => {
        expect(holeBefore(bars, 'FUT').every((x) => !x)).toBe(true);
        const drop = new Set(['08:46', '10:27', '10:29'].map((hm) => T(`2026-10-19T${hm}:00`)));
        const grace = { ...bars.find((b) => b.time === T('2026-10-19T13:45:00'))!, time: T('2026-10-19T13:47:00') };
        const gapped = [...bars.filter((b) => !drop.has(b.time) && b.time <= T('2026-10-19T13:45:00')), grace, ...bars.filter((b) => b.time > T('2026-10-19T13:45:00'))];
        const h = holeBefore(gapped, 'FUT');
        const at = (hm: string) => h[gapped.findIndex((b) => b.time === T(`2026-10-19T${hm}:00`))];
        expect(['08:47', '08:50', '08:51'].map(at)).toEqual([true, true, false]);
        expect(['10:26', '10:28', '10:30', '10:31'].map(at)).toEqual([false, true, true, false]);
        expect(at('13:47')).toBe(false);
    });
});

describe('freshAt（MtfContext 的過期判定）', () => {
    it('盤中：最後一根是前一個桶就不過期', () => {
        expect(tfBucket(T('2026-10-20T09:07:00'), 5)).toBe(T('2026-10-20T09:10:00'));
        expect(freshAt(T('2026-10-20T09:05:00'), T('2026-10-20T09:07:00'), 5)).toBe(true);
        expect(freshAt(T('2026-10-20T09:10:00'), T('2026-10-20T09:10:00'), 5)).toBe(true);
    });
    it('換盤：新盤第一根 5m 收棒前，上一盤的 5m 過期（隔夜、午休）', () => {
        expect(freshAt(T('2026-10-20T05:00:00'), T('2026-10-20T08:46:00'), 5)).toBe(false);
        expect(freshAt(T('2026-10-20T05:00:00'), T('2026-10-20T08:50:00'), 5)).toBe(false);
        expect(freshAt(T('2026-10-20T08:50:00'), T('2026-10-20T08:51:00'), 5)).toBe(true);
        expect(freshAt(T('2026-10-20T13:45:00'), T('2026-10-20T15:01:00'), 5)).toBe(false);
    });
    it('資料缺洞：缺整根 5m 即過期；沒有資料也算過期', () => {
        expect(freshAt(T('2026-10-20T09:00:00'), T('2026-10-20T09:07:00'), 5)).toBe(false);
        expect(freshAt(null, T('2026-10-20T09:07:00'), 5)).toBe(false);
        expect(freshAt(T('2026-10-20T09:00:00'), T('2026-10-20T09:40:00'), 60)).toBe(true);
    });
});

describe('lastAtOrBefore / firstAfter', () => {
    const bars = pathBars([60, 120, 180], [1, 2, 3]);
    it('二分搜尋邊界', () => {
        expect(lastAtOrBefore(bars, 59)).toBe(-1);
        expect(lastAtOrBefore(bars, 120)).toBe(1);
        expect(lastAtOrBefore(bars, 179)).toBe(1);
        expect(firstAfter(bars, 120)).toBe(2);
        expect(firstAfter(bars, 999)).toBe(3);
    });
});

describe('tradingSessionOf', () => {
    it('期貨日盤、夜盤與跨午夜', () => {
        expect(tradingSessionOf('FUT', T('2026-10-20T08:46:00')).key).toBe('2026-10-20D');
        expect(tradingSessionOf('FUT', T('2026-10-20T15:01:00')).key).toBe('2026-10-20N');
        expect(tradingSessionOf('FUT', T('2026-10-21T04:59:00')).key).toBe('2026-10-20N');
    });
    it('收盤定盤 K 棒（13:46–13:49、05:01–05:04）歸剛收的那一盤', () => {
        const d = tradingSessionOf('FUT', T('2026-10-20T13:46:00'));
        expect(d.key).toBe('2026-10-20D');
        expect(d.end).toBe(T('2026-10-20T13:45:00'));
        expect(tradingSessionOf('FUT', T('2026-10-21T05:01:00')).key).toBe('2026-10-20N');
    });
    it('週末開始的時段不算開盤；週五夜盤延續到週六清晨', () => {
        expect(isSessionOpen('FUT', T('2026-10-24T09:00:00'))).toBe(false); // 週六
        expect(isSessionOpen('FUT', T('2026-10-24T02:00:00'))).toBe(true); // 週五夜盤
        expect(isSessionOpen('FUT', T('2026-10-20T14:30:00'))).toBe(false); // 午間休市
        expect(isSessionOpen('FUT', T('2026-10-20T10:00:00'))).toBe(true);
    });
});

describe('mergeTick（即時 1m）', () => {
    const t0 = T('2026-10-20T09:00:00');
    const hist = pathBars([t0], [100]);
    it('成交時間 → 收盤 label：09:00:00–09:00:59 屬 09:01', () => {
        expect(minuteLabel(t0)).toBe(t0 + 60);
        expect(minuteLabel(t0 + 59)).toBe(t0 + 60);
    });
    it('同一分鐘延續歷史最後一根；新分鐘開新 K 棒；不改寫輸入', () => {
        const last = hist[0]!;
        const tail1 = mergeTick([], last, { time: t0 - 30, price: 105, volume: 2 });
        expect(tail1).toHaveLength(1);
        expect(tail1[0]).toMatchObject({ time: t0, high: 105, close: 105, volume: last.volume + 2 });
        expect(hist[0]!.close).toBe(100);
        const tail2 = mergeTick(tail1, last, { time: t0 + 5, price: 99, volume: 1 });
        expect(tail2.map((b) => b.time)).toEqual([t0, t0 + 60]);
        expect(tail2[1]).toMatchObject({ open: 99, high: 99, low: 99, close: 99, volume: 1 });
    });
    it('已被更晚成交超越的分鐘不再改寫（已收 K 棒不重繪）', () => {
        const tail = mergeTick([], undefined, { time: t0 + 70, price: 100, volume: 1 }); // 09:02
        expect(mergeTick(tail, undefined, { time: t0 + 10, price: 1, volume: 1 })).toBe(tail);
    });
    it('歷史 + 尾段：尾段覆蓋同 label 以後；重新載入後保留歷史最後一根之後', () => {
        const history = pathBars([60, 120, 180], [1, 2, 3]);
        const tail = pathBars([180, 240], [30, 40]);
        expect(composeBars(history, tail).map((b) => b.close)).toEqual([1, 2, 30, 40]);
        expect(rebaseTail(tail, pathBars([60, 120, 180, 240], [1, 2, 3, 4])).map((b) => b.time)).toEqual([240]);
    });
});
