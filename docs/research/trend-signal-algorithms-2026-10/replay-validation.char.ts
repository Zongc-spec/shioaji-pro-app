// 回放驗證（研究量測，不在 CI 執行）：以出貨引擎在真實 TMF 1m 上模擬實際運作 —
// 歷史起點固定在 20 天前（一天抓一次），asOf 每 3 分鐘前進一次，逐步比對：
//   1. 已出現的 5m 訊號與失效事件之後逐欄相同（不重繪）
//   2. 1m 提示（V1.1：產生即定案）之後不變，也不會事後補出更早的提示
//   3. 已發生的虛擬成交、出場與停損變更之後不變
//   4. 注入極端的進行中 K 棒：訊號與提示不受影響
//   5. 即時資料路徑（第二個 test，輸出 replay-live-feed.txt）：逐筆成交（帶累計量）、晚到成交、斷線與補抓都經過
//      App 同一個 LiveFeed，比對每次重算的已確認事件之後不變
// 三種核心演算法各跑兩段期間。用法同 characterize.char.ts（TSP_CHAR_CSV / TSP_CHAR_OUT）。
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { wallClockToUtc } from '../../../src/lib/utils/kbars';
import { runTrendSignal } from '../../../src/lib/trend-signal/engine';
import { DEFAULT_CONFIG } from '../../../src/lib/trend-signal/config';
import { LiveFeed } from '../../../src/lib/trend-signal/core/feed';
import type { TickLike } from '../../../src/lib/trend-signal/core/live';
import type { TrendAlgoId, TrendSignalResult } from '../../../src/lib/trend-signal/types';
import type { Candle } from '../../../src/lib/types/market';

const CSV = process.env.TSP_CHAR_CSV ?? '';
const OUT = `${process.env.TSP_CHAR_OUT ?? tmpdir()}/replay-validation.txt`;
const PERIODS: [string, string][] = [['2025-12-15T08:45:00', '2025-12-17T05:00:00'], ['2026-08-24T08:45:00', '2026-08-26T05:00:00']];
const STEP = 180;

test('replay validation', () => {
    if (!CSV) throw new Error('請以 TSP_CHAR_CSV 指定 1m CSV 路徑');
    const lines = readFileSync(CSV, 'utf8').split('\n');
    const all: Candle[] = [];
    for (let k = 1; k < lines.length; k++) {
        const l = lines[k];
        if (!l) continue;
        const [dt, o, h, lo, c, v] = l.split(',');
        all.push({ time: wallClockToUtc(dt!), open: +o!, high: +h!, low: +lo!, close: +c!, volume: +v! });
    }
    const out: string[] = [];
    for (const algo of ['supertrend', 'donchian', 'kama'] as TrendAlgoId[]) {
        const config = { ...DEFAULT_CONFIG, trend: { ...DEFAULT_CONFIG.trend, algo } };
        for (const [a, b] of PERIODS) {
            const from = wallClockToUtc(a);
            const to = wallClockToUtc(b);
            const bars = all.filter((x) => x.time > from - 20 * 86400 && x.time <= to);
            const run = (asOf: number, live: Candle | null = null): TrendSignalResult =>
                runTrendSignal({ bars1m: bars, live, asOf, securityType: 'FUT', symbol: 'TMFR1', contractMonth: 'R1', tick: 1, pointValue: 10, config });
            const final = run(to);
            const tradeById = new Map(final.trades.map((t) => [t.id, t]));
            let steps = 0;
            let sigChecks = 0;
            let entryChecks = 0;
            let fillChecks = 0;
            const bad: string[] = [];
            for (let asOf = from; asOf <= to; asOf += STEP) {
                steps++;
                const r = run(asOf);
                const prefix = final.signals.filter((s) => s.barTime <= asOf);
                sigChecks += r.signals.length + r.invalidations.length;
                if (JSON.stringify(r.signals) !== JSON.stringify(prefix)) bad.push(`signals @${asOf}`);
                if (JSON.stringify(r.invalidations) !== JSON.stringify(final.invalidations.filter((x) => x.barTime <= asOf))) bad.push(`invalidations @${asOf}`);
                entryChecks += r.entries.length;
                if (JSON.stringify(r.entries) !== JSON.stringify(final.entries.filter((e) => e.barTime <= asOf))) bad.push(`entries @${asOf}`);
                for (const t of r.trades) {
                    const f = tradeById.get(t.id);
                    fillChecks += t.fills.length + t.stopHistory.length;
                    if (!f || f.fillPrice !== t.fillPrice
                        || JSON.stringify(t.fills) !== JSON.stringify(f.fills.filter((x) => x.time <= asOf))
                        || JSON.stringify(t.stopHistory) !== JSON.stringify(f.stopHistory.filter((x) => x.time <= asOf))) {
                        bad.push(`trade ${t.id} @${asOf}`);
                    }
                }
                if (steps % 20 === 0) {
                    const spike = run(asOf, { time: Math.floor(asOf / 60) * 60 + 60, open: 1, high: 1e7, low: 1, close: 1e7, volume: 1 });
                    if (JSON.stringify(spike.signals) !== JSON.stringify(r.signals) || JSON.stringify(spike.entries) !== JSON.stringify(r.entries)) bad.push(`live spike @${asOf}`);
                }
            }
            out.push(`${algo} ${a}..${b}: steps=${steps} signals=${final.signals.filter((s) => s.barTime > from).length} invalid=${final.invalidations.filter((x) => x.barTime > from).length} gaps=${final.gaps.filter((g) => g.label > from).length} hints=${final.entries.filter((e) => e.barTime > from).length} trades=${final.trades.filter((t) => t.fillTime > from).length} 比對 訊號與失效=${sigChecks} 提示=${entryChecks} 成交與停損=${fillChecks} 不一致=${bad.length}${bad.length ? ` 例：${bad.slice(0, 3).join('；')}` : ''}`);
        }
    }
    writeFileSync(OUT, out.join('\n') + '\n');
});

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

// 即時資料路徑（審查 P1：晚到成交改寫已收 K 棒）：以真實 1m 產生逐筆成交，經 core/feed.ts 的
// LiveFeed（與 App 同一條路徑）組出 1m；逐筆帶當日累計量（tsp-1.1.3 起心跳不推進確認）、約 8% 的分鐘有一筆
// 晚到 3–40 秒的同分鐘成交（±10 點）、每段期間第一個日盤 10:12–10:17 斷線（重連後依需要補抓近兩天歷史）。
// 每 3 分鐘重算，比對每一次的已確認事件（barTime ≤ 該次 asOf）在之後每一次都逐欄相同。
test('live feed replay', () => {
    if (!CSV) throw new Error('請以 TSP_CHAR_CSV 指定 1m CSV 路徑');
    const lines = readFileSync(CSV, 'utf8').split('\n');
    const all: Candle[] = [];
    for (let k = 1; k < lines.length; k++) {
        const l = lines[k];
        if (!l) continue;
        const [dt, o, h, lo, c, v] = l.split(',');
        all.push({ time: wallClockToUtc(dt!), open: +o!, high: +h!, low: +lo!, close: +c!, volume: +v! });
    }
    const out: string[] = [];
    for (const algo of ['supertrend', 'donchian', 'kama'] as TrendAlgoId[]) {
        const config = { ...DEFAULT_CONFIG, trend: { ...DEFAULT_CONFIG.trend, algo } };
        for (const [a, b] of PERIODS) {
            const from = wallClockToUtc(a);
            const to = wallClockToUtc(b);
            const bars = all.filter((x) => x.time > from - 20 * 86400 && x.time <= to);
            const outage = [wallClockToUtc(`${a.slice(0, 10)}T10:12:20`), wallClockToUtc(`${a.slice(0, 10)}T10:17:40`)];
            let seed = 12345;
            const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
            type Ev = { t: number; kind: 'tick'; tick: TickLike } | { t: number; kind: 'compute' };
            const evs: Ev[] = [];
            let cum = 0;
            for (const bar of bars) {
                if (bar.time <= from) continue;
                for (const tick of ticksOf(bar)) evs.push({ t: tick.time, kind: 'tick', tick: { ...tick, totalVolume: (cum += tick.volume) } });
                if (rnd() < 0.08) evs.push({ t: bar.time + 3 + Math.floor(rnd() * 37), kind: 'tick', tick: { time: bar.time - 2, price: bar.close + (rnd() < 0.5 ? -10 : 10), volume: 1 } });
            }
            for (let t = from; t <= to; t += STEP) evs.push({ t: t + 7, kind: 'compute' });
            evs.sort((x, y) => x.t - y.t || (x.kind === 'compute' ? 1 : 0) - (y.kind === 'compute' ? 1 : 0));
            const feed = new LiveFeed('FUT');
            let epoch = 1;
            let down = false;
            let patchAt = -Infinity;
            let patches = 0;
            feed.observe(epoch, from - 120);
            feed.setHistory(bars.filter((x) => x.time <= from), from + 10);
            const results: TrendSignalResult[] = [];
            for (const ev of evs) {
                const nowDown = ev.t >= outage[0]! && ev.t < outage[1]!;
                if (down && !nowDown) epoch++;
                down = nowDown;
                if (down) continue;
                if (ev.kind === 'tick') feed.onTick(ev.tick, epoch, ev.t);
                else {
                    feed.observe(epoch, ev.t);
                    let s = feed.snapshot(ev.t);
                    if (s.historyWantedAt !== null && ev.t >= s.historyWantedAt && ev.t - patchAt >= 15) {
                        patchAt = ev.t;
                        patches++;
                        feed.setHistory(bars.filter((x) => x.time > ev.t - 2 * 86400 && x.time <= Math.floor(ev.t / 60) * 60), ev.t, true);
                        s = feed.snapshot(ev.t);
                    }
                    results.push(runTrendSignal({ bars1m: s.bars, live: s.live, asOf: s.asOf, securityType: 'FUT', symbol: 'TMFR1', contractMonth: 'R1', tick: 1, pointValue: 10, config }));
                    feed.commit(s.asOf);
                }
            }
            let checks = 0;
            const bad: string[] = [];
            for (let k = 0; k + 1 < results.length; k++) {
                const ra = results[k]!;
                const rb = results[k + 1]!;
                const upTo = <E extends { barTime: number }>(xs: E[]) => JSON.stringify(xs.filter((x) => x.barTime <= ra.asOf));
                const fills = (x: TrendSignalResult) => JSON.stringify(x.trades.flatMap((t) => t.fills.filter((f) => f.time <= ra.asOf).map((f) => [t.id, f])));
                checks += ra.signals.length + ra.invalidations.length + ra.entries.length;
                if (upTo(rb.signals) !== upTo(ra.signals)) bad.push(`signals @${ra.asOf}`);
                if (upTo(rb.invalidations) !== upTo(ra.invalidations)) bad.push(`invalidations @${ra.asOf}`);
                if (upTo(rb.entries) !== upTo(ra.entries)) bad.push(`entries @${ra.asOf}`);
                if (fills(rb) !== fills(ra)) bad.push(`fills @${ra.asOf}`);
            }
            const last = results[results.length - 1]!;
            out.push(`${algo} ${a}..${b}: steps=${results.length} 晚到成交忽略=${feed.snapshot(to + 120).lateTicks} 補抓=${patches} 最後確認=${new Date((last.asOf) * 1000).toISOString().slice(0, 16)} 比對事件=${checks} 不一致=${bad.length}${bad.length ? ` 例：${bad.slice(0, 3).join('；')}` : ''}`);
        }
    }
    writeFileSync(`${process.env.TSP_CHAR_OUT ?? tmpdir()}/replay-live-feed.txt`, out.join('\n') + '\n');
});
