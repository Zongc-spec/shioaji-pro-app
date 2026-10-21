// 回放驗證（研究量測，不在 CI 執行）：以出貨引擎在真實 TMF 1m 上模擬實際運作 —
// 歷史起點固定在 20 天前（一天抓一次），asOf 每 3 分鐘前進一次，逐步比對：
//   1. 已出現的 5m 訊號與失效事件之後逐欄相同（不重繪）
//   2. 1m 提示（V1.1：產生即定案）之後不變，也不會事後補出更早的提示
//   3. 已發生的虛擬成交、出場與停損變更之後不變
//   4. 注入極端的進行中 K 棒：訊號與提示不受影響
// 三種核心演算法各跑兩段期間。用法同 characterize.char.ts（TSP_CHAR_CSV / TSP_CHAR_OUT）。
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { wallClockToUtc } from '../../../src/lib/utils/kbars';
import { runTrendSignal } from '../../../src/lib/trend-signal/engine';
import { DEFAULT_CONFIG } from '../../../src/lib/trend-signal/config';
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
            out.push(`${algo} ${a}..${b}: steps=${steps} signals=${final.signals.filter((s) => s.barTime > from).length} invalid=${final.invalidations.filter((x) => x.barTime > from).length} hints=${final.entries.filter((e) => e.barTime > from).length} trades=${final.trades.filter((t) => t.fillTime > from).length} 比對 訊號與失效=${sigChecks} 提示=${entryChecks} 成交與停損=${fillChecks} 不一致=${bad.length}${bad.length ? ` 例：${bad.slice(0, 3).join('；')}` : ''}`);
        }
    }
    writeFileSync(OUT, out.join('\n') + '\n');
});
