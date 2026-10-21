// src/lib/trend-signal/core/feed.test.ts — 即時資料路徑（逐筆成交、心跳、斷線重連、歷史補抓）的
// 已收判定與凍結：已確認的分鐘不被晚到成交或更新歷史改寫；資料沒涵蓋前不確認；以腳本化的成交
// 串流回放，任何時點已出現的訊號／提示／成交之後都不變，也不會事後補出更早的事件。
import { describe, expect, it } from 'vitest';
import type { Candle } from '../../types/market';
import { DEFAULT_CONFIG } from '../config';
import { runTrendSignal } from '../engine';
import { rng, sessionLabels, T, walkBars } from '../fixtures.test-harness';
import type { TrendSignalResult } from '../types';
import { HEARTBEAT_WAIT_SEC, LiveFeed, type FeedSnapshot } from './feed';
import type { TickLike } from './live';

const labels = sessionLabels('2026-09-01', 4);
const m1 = walkBars(labels, 11, { regime: 60 });
const at = (s: string) => T(s);
const idx = (t: number) => m1.findIndex((b) => b.time === t);
const run = (bars: Candle[], asOf: number, live: Candle | null = null): TrendSignalResult =>
    runTrendSignal({ bars1m: bars, live, asOf, securityType: 'FUT', symbol: 'TMFR1', contractMonth: '202609', tick: 1, pointValue: 10, config: DEFAULT_CONFIG });
const runSnap = (s: FeedSnapshot) => run(s.bars, s.asOf, s.live);

/** 一根 1m 的四筆成交（開→低／高→高／低→收），都落在 (label − 60, label) 之內 */
function ticksOf(b: Candle): TickLike[] {
    const up = b.close >= b.open;
    const v = Math.max(4, b.volume);
    const q = Math.floor(v / 4);
    return [
        { time: b.time - 55, price: b.open, volume: q },
        { time: b.time - 40, price: up ? b.low : b.high, volume: q },
        { time: b.time - 25, price: up ? b.high : b.low, volume: q },
        { time: b.time - 5, price: b.close, volume: v - 3 * q },
    ];
}

describe('P1 回歸：已確認的分鐘不被晚到成交改寫', () => {
    // 審查發現（V1.1 933d165）：02:40 收棒後，同分鐘晚到的成交只改 10 點，就讓原本沒有訊號的 02:40 新增 SELL
    const k = idx(at('2026-09-02T02:40:00'));
    const bar = m1[k]!;
    const late: TickLike = { time: bar.time - 1, price: bar.close - 10, volume: 1 };

    it('對照：那根 1m 收盤 −10 點時，5m 02:40 確實會翻成 SELL（舊行為把晚到成交併進已收 K 棒）', () => {
        expect(run(m1.slice(0, k + 1), bar.time).signals.some((s) => s.barTime === bar.time)).toBe(false);
        const mod = { ...bar, low: Math.min(bar.low, late.price), close: late.price };
        const r = run([...m1.slice(0, k), mod], bar.time);
        expect(r.signals.find((s) => s.barTime === bar.time)?.kind).toBe('SELL');
    });

    it('心跳確認 02:40 之後到的同分鐘成交被忽略並計數；訊號不變', () => {
        const feed = new LiveFeed('FUT');
        feed.observe(1, null, bar.time - 120);
        feed.setHistory(m1.slice(0, k), m1[k - 1]!.time + 20);
        for (const t of ticksOf(bar)) feed.onTick(t, 1, t.time + 1);
        // 02:40 之後沒有新成交，但 02:40:15 的心跳證明那之前的資料都已送達
        feed.observe(1, bar.time + 15, bar.time + 16);
        const s1 = feed.snapshot(bar.time + 16);
        expect(s1.asOf).toBeGreaterThanOrEqual(bar.time);
        expect(s1.pendingFrom).toBeNull();
        const r1 = runSnap(s1);
        expect(r1.m1.bars.at(-1)).toEqual(bar);
        expect(r1.signals.some((s) => s.barTime === bar.time)).toBe(false);
        feed.commit(s1.asOf);
        feed.onTick(late, 1, bar.time + 20);
        const s2 = feed.snapshot(bar.time + 21);
        expect(s2.lateTicks).toBe(1);
        expect(s2.bars.filter((b) => b.time <= s1.asOf)).toEqual(s1.bars.filter((b) => b.time <= s1.asOf));
        expect(runSnap(s2).signals).toEqual(r1.signals);
    });

    it('確認之前到的同分鐘成交照常併入（那時還不算已收）', () => {
        const feed = new LiveFeed('FUT');
        feed.observe(1, null, bar.time - 120);
        feed.setHistory(m1.slice(0, k), m1[k - 1]!.time + 20);
        for (const t of ticksOf(bar)) feed.onTick(t, 1, t.time + 1);
        feed.onTick(late, 1, bar.time + 2);
        feed.observe(1, bar.time + 15, bar.time + 16);
        const s = feed.snapshot(bar.time + 16);
        expect(s.lateTicks).toBe(0);
        expect(s.bars.at(-1)).toMatchObject({ time: bar.time, close: late.price });
    });
});

describe('資料涵蓋才確認', () => {
    const day = (hm: string) => at(`2026-09-02T${hm}:00`);
    const kStart = idx(day('10:00'));

    function streamUntil(feed: LiveFeed, epoch: number, fromIdx: number, toTime: number) {
        for (let i = fromIdx; i < m1.length && m1[i]!.time - 60 < toTime; i++) {
            for (const t of ticksOf(m1[i]!)) if (t.time < toTime) feed.onTick(t, epoch, t.time + 1);
        }
    }

    it('斷線期間不確認；重連後等補抓的歷史涵蓋缺口與重連那一分鐘，結果與完整資料相同', () => {
        const feed = new LiveFeed('FUT');
        feed.observe(1, null, day('09:59') - 30);
        feed.setHistory(m1.slice(0, kStart + 1), day('10:00') + 20); // 伺服器涵蓋到 10:00
        streamUntil(feed, 1, kStart + 1, day('10:26') + 30); // 10:26:30 斷線
        const during = feed.snapshot(day('10:31') + 5);
        expect(during.asOf).toBeLessThan(day('10:27'));
        expect(during.pendingFrom).toBe(day('10:27'));
        expect(during.historyWantedAt).toBe(day('10:27') + 10);
        expect(during.live).toBeNull();
        const rDuring = runSnap(during);
        expect(rDuring.m5.bars.some((b) => b.time === day('10:30'))).toBe(false);
        feed.commit(during.asOf);
        // 10:33:05 重新連上（epoch 2），之後的成交照常送達
        feed.observe(2, null, day('10:33') + 5);
        streamUntil(feed, 2, idx(day('10:34')), day('10:45') + 30);
        const before = feed.snapshot(day('10:33') + 30);
        expect(before.pendingFrom).toBe(day('10:27'));
        // 第一次補抓（10:33:30 請求）涵蓋到 10:33；10:34 那一分鐘只有 10:33:05 之後的成交，仍要等
        feed.setHistory(m1.slice(idx(day('08:46')), idx(day('10:33')) + 1), day('10:33') + 30, true);
        const mid = feed.snapshot(day('10:34') + 5);
        expect(mid.pendingFrom).toBe(day('10:34'));
        feed.setHistory(m1.slice(idx(day('08:46')), idx(day('10:34')) + 1), day('10:34') + 30, true);
        feed.observe(2, day('10:45') + 40, day('10:45') + 41);
        const after = feed.snapshot(day('10:45') + 41);
        expect(after.pendingFrom).toBeNull();
        expect(after.asOf).toBeGreaterThanOrEqual(day('10:45'));
        const truth = run(m1, after.asOf);
        const r = runSnap(after);
        const upTo = (t: number) => t <= after.asOf;
        expect(r.m1.bars).toEqual(truth.m1.bars.filter((b) => upTo(b.time)));
        expect(r.signals).toEqual(truth.signals.filter((s) => upTo(s.barTime)));
        expect(r.entries).toEqual(truth.entries.filter((e) => upTo(e.barTime)));
    });

    it('更新歷史不改寫已確認的分鐘；確認之後的分鐘照新資料', () => {
        const feed = new LiveFeed('FUT');
        feed.observe(1, null, day('09:00'));
        feed.setHistory(m1.slice(0, kStart + 1), day('10:00') + 20);
        const s = feed.snapshot(day('10:00') + 20);
        feed.commit(s.asOf);
        const edited = m1.slice(0, kStart + 6).map((b) => ({ ...b, close: b.close + 1 }));
        feed.setHistory(edited, day('10:05') + 20);
        const s2 = feed.snapshot(day('10:05') + 20);
        expect(s2.bars.filter((b) => b.time <= s.asOf)).toEqual(m1.slice(0, kStart + 1));
        expect(s2.bars.filter((b) => b.time > s.asOf)).toEqual(edited.slice(kStart + 1));
    });

    it('安靜市場：沒有成交、只有心跳時照常確認（沒有成交的分鐘不必等）', () => {
        const feed = new LiveFeed('FUT');
        feed.observe(1, null, day('09:59') - 30);
        feed.setHistory(m1.slice(0, kStart + 1), day('10:00') + 20);
        for (const t of ticksOf(m1[kStart + 1]!)) feed.onTick(t, 1, t.time + 1); // 10:01 有成交，之後沒有
        feed.observe(1, day('10:04') + 15, day('10:04') + 16);
        const s = feed.snapshot(day('10:04') + 16);
        expect(s.pendingFrom).toBeNull();
        expect(s.asOf).toBeGreaterThanOrEqual(day('10:04'));
        // 10:05 結束 10 秒、下一次心跳（10:05:15）之前：只是還沒確認，不算缺資料（不顯示補齊中、不補抓）
        const waiting = feed.snapshot(day('10:05') + 10);
        expect(waiting.asOf).toBeLessThan(day('10:05'));
        expect(waiting.pendingFrom).toBeNull();
        expect(waiting.historyWantedAt).toBeNull();
        feed.observe(1, day('10:05') + 15, day('10:05') + 16);
        expect(feed.snapshot(day('10:05') + 16)).toMatchObject({ pendingFrom: null, asOf: day('10:05') + 5 });
        // 之後串流沒有成交也沒有心跳：10:06 結束後過了一次心跳週期，當成可能卡住，改等補抓
        expect(feed.snapshot(day('10:06') + HEARTBEAT_WAIT_SEC - 1).pendingFrom).toBeNull();
        expect(feed.snapshot(day('10:06') + HEARTBEAT_WAIT_SEC).pendingFrom).toBe(day('10:06'));
    });

    it('共用快取的舊歷史：請求時刻到串流起點之間的分鐘要等補抓', () => {
        const feed = new LiveFeed('FUT');
        feed.setHistory(m1.slice(0, idx(day('09:30')) + 1), day('09:30') + 20); // 主圖 09:30 抓的快取
        feed.observe(1, null, day('10:00') + 3); // TSP 10:00:03 才開始收逐筆
        streamUntil(feed, 1, idx(day('10:01')), day('10:03') + 10);
        const s = feed.snapshot(day('10:03') + 10);
        expect(s.pendingFrom).toBe(day('09:31'));
        expect(s.asOf).toBeLessThan(day('09:31'));
    });
});

describe('回放不重繪：模擬即時資料路徑', () => {
    it('逐筆成交＋心跳＋隨機晚到成交＋一次斷線：已出現的事件之後逐欄相同，也不會補出更早的事件', () => {
        const r = rng(7);
        const from = idx(at('2026-09-02T08:46:00'));
        const to = idx(at('2026-09-02T23:00:00'));
        const outage = [at('2026-09-02T11:14:20'), at('2026-09-02T11:17:40')];
        type Ev = { t: number; kind: 'tick'; tick: TickLike } | { t: number; kind: 'hb' } | { t: number; kind: 'compute' };
        const evs: Ev[] = [];
        for (let i = from; i <= to; i++) {
            const b = m1[i]!;
            for (const tick of ticksOf(b)) evs.push({ t: tick.time, kind: 'tick', tick });
            // 約 8% 的分鐘有一筆晚到 3–40 秒的同分鐘成交（±10 點）
            if (r() < 0.08) evs.push({ t: b.time + 3 + Math.floor(r() * 37), kind: 'tick', tick: { time: b.time - 2, price: b.close + (r() < 0.5 ? -10 : 10), volume: 1 } });
        }
        for (let t = m1[from]!.time - 60; t <= m1[to]!.time + 60; t += 30) evs.push({ t, kind: 'hb' });
        for (let t = m1[from]!.time; t <= m1[to]!.time + 60; t += 60) evs.push({ t: t + 7, kind: 'compute' });
        evs.sort((a, b) => a.t - b.t || (a.kind === 'compute' ? 1 : 0) - (b.kind === 'compute' ? 1 : 0));

        const feed = new LiveFeed('FUT');
        let epoch = 1;
        let down = false;
        let lastHb: number | null = null;
        let patchAt = -Infinity;
        let patches = 0;
        feed.observe(epoch, null, m1[from]!.time - 120);
        feed.setHistory(m1.slice(0, from), m1[from]!.time - 60 + 20);
        const results: TrendSignalResult[] = [];
        for (const ev of evs) {
            const nowDown = ev.t >= outage[0]! && ev.t < outage[1]!;
            if (down && !nowDown) epoch++; // 重新連上
            down = nowDown;
            if (down) continue; // 斷線期間成交與心跳都收不到
            if (ev.kind === 'tick') feed.onTick(ev.tick, epoch, ev.t);
            else if (ev.kind === 'hb') lastHb = ev.t;
            else {
                feed.observe(epoch, lastHb, ev.t);
                let s = feed.snapshot(ev.t);
                if (s.historyWantedAt !== null && ev.t >= s.historyWantedAt && ev.t - patchAt >= 15) {
                    // 伺服器資料：請求時刻以前收完的分鐘（含晚到成交以外的原始成交）
                    patchAt = ev.t;
                    patches++;
                    feed.setHistory(m1.slice(from - 300, idx(Math.floor((ev.t - 60) / 60) * 60 + 60)), ev.t, true);
                    s = feed.snapshot(ev.t);
                }
                results.push(runSnap(s));
                feed.commit(s.asOf);
            }
        }
        expect(results.length).toBeGreaterThan(600);
        expect(feed.snapshot(m1[to]!.time + 120).lateTicks).toBeGreaterThan(0);
        expect(patches).toBeGreaterThan(0);
        const finalR = results.at(-1)!;
        expect(finalR.asOf).toBeGreaterThanOrEqual(m1[to]!.time);
        expect(finalR.signals.length).toBeGreaterThan(5);
        expect(finalR.entries.length).toBeGreaterThan(10);
        // 每一次計算的已確認事件，在之後的每一次計算都逐欄相同；之後也不會出現 barTime ≤ 該次 asOf 的新事件
        for (let a = 0; a < results.length - 1; a++) {
            const ra = results[a]!;
            const rb = results[a + 1]!;
            const upTo = <E extends { barTime: number }>(xs: E[]) => xs.filter((x) => x.barTime <= ra.asOf);
            expect(upTo(rb.signals)).toEqual(upTo(ra.signals));
            expect(upTo(rb.invalidations)).toEqual(upTo(ra.invalidations));
            expect(upTo(rb.entries)).toEqual(upTo(ra.entries));
            const fills = (x: TrendSignalResult) => x.trades.flatMap((t) => t.fills.filter((f) => f.time <= ra.asOf).map((f) => `${t.id}|${f.time}|${f.price}|${f.qty}|${f.reason}`));
            expect(fills(rb)).toEqual(fills(ra));
        }
        // 約 840 次重算：單獨執行約 3.5 秒，完整測試的平行負載下需要較長逾時
    }, 60_000);
});
