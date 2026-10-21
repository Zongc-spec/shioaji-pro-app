// 新資料驗證（研究量測，不在 CI 執行）：tsp-1.2.0 定案後才抓的 TMFR1 1m（2026-09-01 16:22 之後），檢驗事前寫定的兩條規則。
//   TSP_CHAR_CSV  兩年研究用的 tmf_1m_clean.csv（只取 2026-08-25 之前當暖身）
//   TSP_FRESH_CSV 新抓的 TMFR1 1m（同格式；2026-08-25 起）
//   TSP_CHAR_OUT  輸出目錄
// 比較（1 口、手續費 12／邊、滑價 1 tick／邊、期交稅 0.00002／邊）：
//   A tsp-1.2.0 預設（stopTf 5、預算 NT$2,500）；B 舊預設（stopTf 1、NT$1,000）；C 為 A＋夜盤不開新倉（夜盤提示不進虛擬部位，訊號照算）
// 事前規則（看新資料之前寫定）：
//   判定 1：A 在 9 組（三核心 × 三進場）中至少 6 組每筆成本後損益優於 B，且 9 組合計較高 → 新資料支持 tsp-1.2.0 的改動
//   判定 2：C 在 9 組中至少 6 組每筆優於 A，且 9 組合計較高 → 「夜盤不開新倉」列為預設候選（是否採用由使用者決定）
// 5m 主圖只回報。只算新資料期間成交且已平倉的部位。這不是策略驗證，也不保證未來績效。
import { readFileSync, writeFileSync } from 'node:fs';
import { aggregate, wallClockToUtc } from '../../../src/lib/utils/kbars';
import { runTrendSignal } from '../../../src/lib/trend-signal/engine';
import { configFromParams, riskKey, TREND_ALGOS, ENTRY_MODES } from '../../../src/lib/trend-signal/config';
import { frameFromChart, runChartSignal } from '../../../src/lib/trend-signal/chart-custom';
import { M5_MICRO_DEFAULTS } from '../../../src/lib/trend-signal/app-custom';
import { tradingSessionOf } from '../../../src/lib/trend-signal/core/session';
import { runVirtual } from '../../../src/lib/trend-signal/risk/virtual';
import type { BarsInput } from '../../../src/lib/custom-runtime';
import type { EntryEvent, TrendSignalResult, VirtualTrade } from '../../../src/lib/trend-signal/types';
import type { Candle } from '../../../src/lib/types/market';

const T = (s: string) => wallClockToUtc(s);
const FRESH_FROM = T('2026-09-01T16:22:00'); // 兩年 CSV 的最後一根（抓取時未收完）；成交時間晚於它才算新資料
const SPLICE = T('2026-08-25T00:00:00');
const COST = { feePerSide: 12, slipTicks: 1, taxRate: 0.00002 };
const MODES = [0, 1, 2];

function load(path: string, keep: (t: number) => boolean): Candle[] {
    const out: Candle[] = [];
    const lines = readFileSync(path, 'utf8').split('\n');
    for (let k = 1; k < lines.length; k++) {
        const l = lines[k];
        if (!l) continue;
        const [dt, o, h, lo, c, v] = l.split(',');
        const time = T(dt!);
        if (keep(time)) out.push({ time, open: +o!, high: +h!, low: +lo!, close: +c!, volume: +v! });
    }
    return out;
}
const toInput = (bars: Candle[]): BarsInput => ({
    time: bars.map((b) => b.time), open: bars.map((b) => b.open), high: bars.map((b) => b.high),
    low: bars.map((b) => b.low), close: bars.map((b) => b.close), volume: bars.map((b) => b.volume),
});
const night = (e: EntryEvent) => tradingSessionOf('FUT', e.barTime).key.endsWith('N');

interface Stats { trades: number; perTrade: number; tStat: number; net: number; winPct: number; holdMin: number }
function stats(all: VirtualTrade[], upTo: number): Stats {
    const closed = all.filter((t) => t.status === 'CLOSED' && t.fillTime > FRESH_FROM && t.fillTime <= upTo);
    const nets = closed.map((t) => t.realizedNtd);
    const n = nets.length;
    const net = nets.reduce((a, b) => a + b, 0);
    const avg = n ? net / n : Number.NaN;
    const sd = n > 1 ? Math.sqrt(nets.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1)) : Number.NaN;
    const hold = closed.map((t) => (t.closedAt! - t.fillTime) / 60 + 1).sort((a, b) => a - b);
    return { trades: n, perTrade: avg, tStat: sd > 0 ? avg / (sd / Math.sqrt(n)) : Number.NaN, net, winPct: n ? (100 * nets.filter((x) => x > 0).length) / n : Number.NaN,
        holdMin: n ? hold[n >> 1]! : Number.NaN };
}
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const int = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—');
const cell = (s: Stats) => `${s.trades}／${f(s.perTrade)}（${f(s.tStat, 2)}）`;

test('fresh data after 2026-09-01', () => {
    const fresh = load(process.env.TSP_FRESH_CSV!, () => true);
    const m1 = [...load(process.env.TSP_CHAR_CSV!, (t) => t < SPLICE), ...fresh];
    const asOf = m1.at(-1)!.time;
    const params = (algo: number, entryMode: number, extra: Record<string, number> = {}) =>
        ({ algo, entryMode, qty: 1, feePerSide: COST.feePerSide, slipTicks: COST.slipTicks, ...extra });
    const run = (bars: Candle[], p: Record<string, number>) => runTrendSignal({ bars1m: bars, asOf, securityType: 'FUT', symbol: 'TMFR1', contractMonth: 'R1',
        tick: 1, pointValue: 10, taxRate: COST.taxRate, config: configFromParams(p) });
    // 與出貨引擎同一個 RiskPlanner 步驟，只把夜盤提示拿掉
    const rerun = (res: TrendSignalResult, p: Record<string, number>, keep: (e: EntryEvent) => boolean) => {
        const cfg = configFromParams(p);
        return runVirtual({ m1: res.m1.bars, m1SessionEnd: res.m1.sessionEnd, live: null, asOf: res.asOf, m5: res.m5, t5: res.t5,
            signals: res.signals, invalidations: res.invalidations, entries: res.entries.filter((e) => e.mode === cfg.entry.mode && keep(e)),
            cfg: cfg.risk, tick: 1, pointValue: 10, taxRate: COST.taxRate, key: riskKey(cfg) }).trades;
    };

    const rows: string[] = [];
    const chartRows: string[] = [];
    const json: Record<string, unknown> = { freshFrom: '2026-09-01 16:22（不含）', asOf: new Date(asOf * 1000).toISOString().slice(0, 16), bars: m1.length, freshBars: fresh.length };
    const r: Record<string, { A: Stats; B: Stats; C: Stats; nightShare: number }> = {};
    let replayOk = true, warmupSame = true;
    for (const algo of [0, 1, 2]) {
        for (const mode of MODES) {
            const pA = params(algo, mode);
            const resA = run(m1, pA);
            // 檢查：不過濾時重跑 RiskPlanner 要與引擎逐筆相同；只用新資料暖身時新資料期間的部位要相同
            if (JSON.stringify(rerun(resA, pA, () => true)) !== JSON.stringify(resA.trades)) replayOk = false;
            const short = run(fresh, pA).trades.filter((t) => t.fillTime > FRESH_FROM).map((t) => [t.fillTime, t.fillPrice, t.closedAt, t.realizedNtd]);
            if (JSON.stringify(short) !== JSON.stringify(resA.trades.filter((t) => t.fillTime > FRESH_FROM).map((t) => [t.fillTime, t.fillPrice, t.closedAt, t.realizedNtd]))) warmupSame = false;
            const A = stats(resA.trades, asOf);
            const B = stats(run(m1, params(algo, mode, { stopTf: 1, budget: 1000 })).trades, asOf);
            const C = stats(rerun(resA, pA, (e) => !night(e)), asOf);
            const freshTrades = resA.trades.filter((t) => t.status === 'CLOSED' && t.fillTime > FRESH_FROM);
            const nightShare = freshTrades.length ? (100 * freshTrades.filter((t) => tradingSessionOf('FUT', t.fillTime).key.endsWith('N')).length) / freshTrades.length : Number.NaN;
            r[`${algo}/${mode}`] = { A, B, C, nightShare };
            rows.push(`| ${TREND_ALGOS[algo]} | ${ENTRY_MODES[mode]} | ${cell(B)} | ${cell(A)} | ${cell(C)} | ${f(nightShare)} | ${f(A.holdMin, 0)} |`);
            const chart = runChartSignal(frameFromChart(toInput(aggregate(m1, 5)), { ...M5_MICRO_DEFAULTS, ...pA }, asOf + 86400));
            chartRows.push(`| ${TREND_ALGOS[algo]} | ${ENTRY_MODES[mode]} | ${cell(stats(chart.trades, asOf))} |`);
        }
    }
    const judge = (better: (x: (typeof r)[string]) => boolean, a: 'A' | 'C', b: 'A' | 'B') => {
        const cnt = Object.values(r).filter(better).length;
        const ta = Object.values(r).reduce((s, x) => s + x[a].net, 0);
        const tb = Object.values(r).reduce((s, x) => s + x[b].net, 0);
        return { cnt, ta, tb, ok: cnt >= 6 && ta > tb };
    };
    const j1 = judge((x) => x.A.perTrade > x.B.perTrade, 'A', 'B');
    const j2 = judge((x) => x.C.perTrade > x.A.perTrade, 'C', 'A');
    const verdict = [
        `檢查：不過濾時重跑 RiskPlanner 與引擎逐筆相同 ${replayOk ? '是' : '否'}；只用新資料暖身時新資料期間的部位相同 ${warmupSame ? '是' : '否'}`,
        `判定 1（A vs B）：每筆較好 ${j1.cnt}/9；9 組合計 A ${int(j1.ta)}、B ${int(j1.tb)} → ${j1.ok ? '支持' : '不支持'}`,
        `判定 2（C vs A）：每筆較好 ${j2.cnt}/9；9 組合計 C ${int(j2.ta)}、A ${int(j2.tb)} → ${j2.ok ? '列為預設候選' : '不列為候選'}`,
    ];
    Object.assign(json, { results: r, verdict, replayOk, warmupSame });
    let md = `# 新資料驗證（TMFR1 1m，成交時間晚於 2026-09-01 16:22，到 ${new Date(asOf * 1000).toISOString().slice(0, 16).replace('T', ' ')}）\n\n`;
    md += `${verdict.map((v) => `- ${v}`).join('\n')}\n\n`;
    md += `筆數／每筆 NT$（t 值）：\n\n| 核心 | 進場 | B 舊預設 | A tsp-1.2.0 | C A＋夜盤不開新倉 | A 夜盤成交% | A 持有中位(分) |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}\n\n`;
    md += `5m 主圖（App 5m 路徑，tsp-1.2.0 預設，只回報）：\n\n| 核心 | 進場 | 筆數／每筆 NT$（t 值） |\n|---|---|---|\n${chartRows.join('\n')}\n`;
    writeFileSync(`${process.env.TSP_CHAR_OUT}/fresh-2026-09.md`, md);
    writeFileSync(`${process.env.TSP_CHAR_OUT}/fresh-2026-09.json`, JSON.stringify(json, null, 2));
});
