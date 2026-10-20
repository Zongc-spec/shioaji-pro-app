// 進場時機模式量測（研究量測，不在 CI 執行）：以實際出貨的引擎
// （src/lib/trend-signal/engine.ts）跑整年 TMF 1m，比較 IMMEDIATE、MICRO_TREND、
// PRICE_STRUCTURE、舊假說 PULLBACK_KD 的觸發率、延遲與相對 IMMEDIATE 的進場價差。
// 進場價 = 觸發 K 棒的下一根 1m 開盤（未計滑價）。只量測時機，不是策略損益。
// 用法同 characterize.char.ts（TSP_CHAR_CSV / TSP_CHAR_OUT）。
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { wallClockToUtc } from '../../../src/lib/utils/kbars';
import { runTrendSignal } from '../../../src/lib/trend-signal/engine';
import { DEFAULT_CONFIG } from '../../../src/lib/trend-signal/config';
import { firstAfter } from '../../../src/lib/trend-signal/core/bars';
import type { EntryMode, TrendAlgoId, TrendSignalConfig } from '../../../src/lib/trend-signal/types';
import type { Candle } from '../../../src/lib/types/market';

const CSV = process.env.TSP_CHAR_CSV ?? '';
const OUT = process.env.TSP_CHAR_OUT ?? tmpdir();
const FROM = wallClockToUtc('2025-09-01T00:00:00');
const TO = wallClockToUtc('2026-09-01T23:59:59');

const median = (xs: number[]) => {
    if (!xs.length) return Number.NaN;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
const p10 = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(0.1 * (s.length - 1))]! : Number.NaN;
};
const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');

test('entry modes', () => {
    if (!CSV) throw new Error('請以 TSP_CHAR_CSV 指定 1m CSV 路徑');
    const lines = readFileSync(CSV, 'utf8').split('\n');
    const m1: Candle[] = [];
    for (let k = 1; k < lines.length; k++) {
        const l = lines[k];
        if (!l) continue;
        const [dt, o, h, lo, c, v] = l.split(',');
        const t = wallClockToUtc(dt!);
        if (t < FROM || t > TO) continue;
        m1.push({ time: t, open: +o!, high: +h!, low: +lo!, close: +c!, volume: +v! });
    }
    const asOf = m1[m1.length - 1]!.time;
    const variants: [string, EntryMode, (c: TrendSignalConfig) => TrendSignalConfig][] = [
        ['IMMEDIATE', 'IMMEDIATE', (c) => c],
        ['MICRO_TREND 1m ST 倍數 0.75', 'MICRO_TREND', (c) => ({ ...c, entry: { ...c.entry, microMult: 0.75 } })],
        ['MICRO_TREND 1m ST 倍數 1.0（預設）', 'MICRO_TREND', (c) => c],
        ['MICRO_TREND 1m ST 倍數 1.5', 'MICRO_TREND', (c) => ({ ...c, entry: { ...c.entry, microMult: 1.5 } })],
        ['MICRO_TREND 1m ST 倍數 3', 'MICRO_TREND', (c) => ({ ...c, entry: { ...c.entry, microMult: 3 } })],
        ['PRICE_STRUCTURE 回檔 ≥ 0', 'PRICE_STRUCTURE', (c) => ({ ...c, entry: { ...c.entry, minPullbackAtr: 0 } })],
        ['PRICE_STRUCTURE 回檔 ≥ 0.5 ATR（預設）', 'PRICE_STRUCTURE', (c) => c],
        ['PRICE_STRUCTURE 回檔 ≥ 1 ATR', 'PRICE_STRUCTURE', (c) => ({ ...c, entry: { ...c.entry, minPullbackAtr: 1 } })],
        ['PULLBACK_KD（舊假說）', 'PULLBACK_KD', (c) => c],
    ];
    let md = '';
    const json: Record<string, unknown[]> = {};
    for (const algo of ['supertrend', 'donchian', 'kama'] as TrendAlgoId[]) {
        const base: TrendSignalConfig = { ...DEFAULT_CONFIG, trend: { ...DEFAULT_CONFIG.trend, algo } };
        let baseline: Map<string, number> | null = null;
        let big: Set<string> | null = null;
        let failed: Set<string> | null = null;
        let total = 0;
        const rows: unknown[] = [];
        md += `\n### ${algo}\n\n| 模式 | 觸發% | 延遲中位(分) | 改善中位(ATR) | 改善平均(ATR) | 改善P10(ATR) | 大行情改善平均(ATR) | 進場後30分逆向中位(ATR) | 大行情錯過% | 失敗訊號避開% |\n|---|---|---|---|---|---|---|---|---|---|\n`;
        for (const [name, mode, tweak] of variants) {
            const cfg = tweak(base);
            const r = runTrendSignal({ bars1m: m1, asOf, securityType: 'FUT', symbol: 'TMFR1', contractMonth: 'R1', tick: 1, pointValue: 10, config: cfg });
            const bars = r.m1.bars;
            const sigs = r.signals;
            // 大行情：訊號到下一個訊號之間順向 > 3 × 5m ATR
            if (!big) {
                big = new Set();
                failed = new Set();
                for (let k = 0; k < sigs.length; k++) {
                    const s = sigs[k]!;
                    const end = sigs[k + 1]?.index ?? r.m5.bars.length - 1;
                    let best = 0;
                    for (let j = s.index + 1; j <= end; j++) {
                        const b = r.m5.bars[j]!;
                        best = Math.max(best, s.direction === 'LONG' ? b.high - s.close : s.close - b.low);
                    }
                    if (s.atr !== undefined && best > 3 * s.atr) big.add(s.id);
                    // 失敗訊號：30 分鐘（6 根 5m）內就出現反向訊號
                    const nx = sigs[k + 1];
                    if (nx && nx.index - s.index <= 6) failed.add(s.id);
                }
                total = sigs.length;
            }
            const sigById = new Map(sigs.map((s) => [s.id, s]));
            const entryPx = new Map<string, number>();
            const delay: number[] = [];
            const mae: number[] = [];
            let hits = 0;
            let bigMissed = 0;
            let failedAvoided = 0;
            for (const e of r.entries) {
                if (e.mode !== mode) continue;
                const s = sigById.get(e.signalId)!;
                if (e.status !== 'TRIGGERED') {
                    if (big.has(s.id)) bigMissed++;
                    if (failed!.has(s.id)) failedAvoided++;
                    continue;
                }
                const n = firstAfter(bars, e.barTime!);
                if (n >= bars.length || bars[n]!.time > s.sessionEnd) {
                    if (big.has(s.id)) bigMissed++;
                    if (failed!.has(s.id)) failedAvoided++;
                    continue;
                }
                hits++;
                const px = bars[n]!.open;
                entryPx.set(s.id, px);
                delay.push((bars[n]!.time - 60 - s.barTime) / 60);
                let worst = 0;
                for (let j = n; j < Math.min(bars.length, n + 30); j++) {
                    worst = Math.max(worst, s.direction === 'LONG' ? px - bars[j]!.low : bars[j]!.high - px);
                }
                if (s.atr) mae.push(worst / s.atr);
            }
            if (!baseline) baseline = entryPx;
            const impr: number[] = [];
            const bigImpr: number[] = [];
            for (const [id, px] of entryPx) {
                const p0 = baseline.get(id);
                const s = sigById.get(id)!;
                if (p0 === undefined || !s.atr) continue;
                const v = ((s.direction === 'LONG' ? 1 : -1) * (p0 - px)) / s.atr;
                impr.push(v);
                if (big.has(id)) bigImpr.push(v);
            }
            const row = {
                name,
                signals: total,
                hitPct: (100 * hits) / total,
                delayMin: median(delay),
                imprMedian: median(impr),
                imprMean: mean(impr),
                imprP10: p10(impr),
                bigImprMean: mean(bigImpr),
                mae30: median(mae),
                bigMissedPct: (100 * bigMissed) / big.size,
                failedAvoidedPct: (100 * failedAvoided) / failed!.size,
            };
            rows.push(row);
            md += `| ${name} | ${f(row.hitPct, 1)} | ${f(row.delayMin, 1)} | ${f(row.imprMedian)} | ${f(row.imprMean)} | ${f(row.imprP10)} | ${f(row.bigImprMean)} | ${f(row.mae30)} | ${f(row.bigMissedPct, 1)} | ${f(row.failedAvoidedPct, 1)} |\n`;
        }
        md += `\n訊號 ${total}；大行情（順向 > 3 ATR）${big?.size ?? 0}；失敗訊號（30 分鐘內反向）${failed?.size ?? 0}\n`;
        json[algo] = rows;
    }
    writeFileSync(`${OUT}/entry-modes.md`, md);
    writeFileSync(`${OUT}/entry-modes.json`, JSON.stringify(json, null, 2));
});
