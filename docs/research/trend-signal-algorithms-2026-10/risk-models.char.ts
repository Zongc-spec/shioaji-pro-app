// 風控模型與 5m 主圖進場模式量測（研究量測，不在 CI 執行；用法同 characterize.char.ts：TSP_CHAR_CSV / TSP_CHAR_OUT）。
//   1. 風控模型（riskModel）0／1／2 × 三核心 × 三進場模式，1m 主圖（出貨引擎 runTrendSignal），樣本內／外成本後
//   2. 5m 主圖 MICRO_TREND 的微型靈敏度：5m 主圖上微型與主趨勢用同一組 K 棒，預設參數相同時永遠不會提示；
//      以「每段趨勢平均提示次數」對齊 1m 主圖的預設來選（只看頻率，不看損益）
//   3. 5m 主圖（App 單檔的 5m 路徑：chart-custom 在 aggregate(1m, 5) 上），用 2 選定的微型參數（5m 主圖的模型 0 與 1 相同）
//   4. 補充：預設預算 NT$1,000 下實際會成交的部位（超過預算的提示被拒絕），只回報、不參與採用規則
// 成本、期間切分與 Gate 5 相同（gate5-comparison.char.ts）；1–3 為 1 口、預算不設限，另報 1 口風險超過 NT$1,000 的比例。
//
// 事前寫定的採用規則（看結果之前）：新風控模型要在 9 組（三核心 × 三進場）中，樣本內與樣本外都至少 6 組的
// 每筆成本後損益優於模型 0，且兩段的 9 組總損益都較高，才改成預設；兩個都符合時取樣本內平均每筆改善較大者。
// 都不符合就維持模型 0。這不是策略驗證，也不保證未來績效。
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { aggregate, wallClockToUtc } from '../../../src/lib/utils/kbars';
import { runTrendSignal } from '../../../src/lib/trend-signal/engine';
import { configFromParams, TREND_ALGOS, ENTRY_MODES } from '../../../src/lib/trend-signal/config';
import { frameFromChart, runChartSignal } from '../../../src/lib/trend-signal/chart-custom';
import type { BarsInput } from '../../../src/lib/custom-runtime';
import type { EntryEvent, TrendSignal, VirtualTrade } from '../../../src/lib/trend-signal/types';
import type { Candle } from '../../../src/lib/types/market';

const CSV = process.env.TSP_CHAR_CSV ?? '';
const OUT = process.env.TSP_CHAR_OUT ?? tmpdir();
const T = (s: string) => wallClockToUtc(s);
const PERIODS = { IS: [T('2024-09-01T00:00:00'), T('2025-08-31T23:59:59')], OOS: [T('2025-09-01T00:00:00'), T('2026-09-01T23:59:59')] } as const;
type Period = keyof typeof PERIODS;
const inP = (p: Period, t: number) => t >= PERIODS[p][0] && t <= PERIODS[p][1];
const COST = { feePerSide: 12, slipTicks: 1, taxRate: 0.00002, tick: 1, pointValue: 10 };
const MODES = [0, 1, 2]; // IMMEDIATE、MICRO_TREND、PRICE_STRUCTURE
const RISK_MODELS = [0, 1, 2];
const DEFAULT_BUDGET = 1000;

const median = (xs: number[]) => {
    if (!xs.length) return Number.NaN;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const quantile = (xs: number[], q: number) => {
    if (!xs.length) return Number.NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};
const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const int = (x: number) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en-US') : '—');

function load(): Candle[] {
    if (!CSV) throw new Error('請以 TSP_CHAR_CSV 指定 1m CSV 路徑');
    const out: Candle[] = [];
    const lines = readFileSync(CSV, 'utf8').split('\n');
    for (let k = 1; k < lines.length; k++) {
        const l = lines[k];
        if (!l) continue;
        const [dt, o, h, lo, c, v] = l.split(',');
        out.push({ time: T(dt!), open: +o!, high: +h!, low: +lo!, close: +c!, volume: +v! });
    }
    return out;
}
const toInput = (bars: Candle[]): BarsInput => ({
    time: bars.map((b) => b.time), open: bars.map((b) => b.open), high: bars.map((b) => b.high),
    low: bars.map((b) => b.low), close: bars.map((b) => b.close), volume: bars.map((b) => b.volume),
});

interface Stats { trades: number; winPct: number; net: number; perTrade: number; tStat: number; grossPerTrade: number; pf: number; maxDd: number; holdMin: number; overBudgetPct: number; riskMedian: number; riskP90: number }

function stats(all: VirtualTrade[], p: Period): Stats {
    const closed = all.filter((t) => t.status === 'CLOSED' && inP(p, t.fillTime)).sort((a, b) => a.closedAt! - b.closedAt!);
    let eq = 0, peak = 0, dd = 0, wins = 0, gp = 0, gl = 0, gross = 0, over = 0;
    const nets: number[] = [];
    const hold: number[] = [];
    const risk: number[] = [];
    for (const t of closed) {
        eq += t.realizedNtd;
        nets.push(t.realizedNtd);
        peak = Math.max(peak, eq);
        dd = Math.max(dd, peak - eq);
        if (t.realizedNtd > 0) { wins++; gp += t.realizedNtd; } else gl -= t.realizedNtd;
        const slip = t.qty * COST.slipTicks + t.fills.reduce((n, x) => n + (x.reason === 'TP2R' || x.reason === 'TP3R' ? 0 : x.qty * COST.slipTicks), 0);
        gross += (t.realizedPoints + slip) * COST.pointValue;
        hold.push((t.closedAt! - t.fillTime) / 60 + 1);
        if (t.plan.riskPerLot > DEFAULT_BUDGET) over++;
        risk.push(t.plan.riskPerLot);
    }
    const n = closed.length;
    const avg = n ? eq / n : Number.NaN;
    const sd = n > 1 ? Math.sqrt(nets.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1)) : Number.NaN;
    return { trades: n, winPct: n ? (100 * wins) / n : Number.NaN, net: eq, perTrade: avg, tStat: sd > 0 ? avg / (sd / Math.sqrt(n)) : Number.NaN,
        grossPerTrade: n ? gross / n : Number.NaN, pf: gl > 0 ? gp / gl : Number.NaN, maxDd: dd, holdMin: median(hold), overBudgetPct: n ? (100 * over) / n : Number.NaN,
        riskMedian: median(risk), riskP90: quantile(risk, 0.9) };
}

/** 每段趨勢（期間內的訊號）平均的 MICRO_TREND 提示次數 */
function microPerSegment(signals: TrendSignal[], entries: EntryEvent[], p: Period) {
    const sigs = signals.filter((s) => inP(p, s.barTime));
    const ids = new Set(sigs.map((s) => s.id));
    const hints = entries.filter((e) => e.mode === 'MICRO_TREND' && ids.has(e.signalId)).length;
    return sigs.length ? hints / sigs.length : Number.NaN;
}

const statCols = '| 筆數 | 勝率% | 淨損益 NT$ | 每筆 NT$ | t 值 | 成本前每筆 NT$ | PF | 最大回撤 NT$ | 持有中位(分) | 1 口風險 > NT$1,000 % | 1 口風險中位 NT$ | 1 口風險 P90 NT$ |';
const statSep = '|---|---|---|---|---|---|---|---|---|---|---|---|';
const row = (s: Stats) => `| ${s.trades} | ${f(s.winPct)} | ${int(s.net)} | ${f(s.perTrade)} | ${f(s.tStat, 2)} | ${f(s.grossPerTrade)} | ${f(s.pf, 2)} | ${int(s.maxDd)} | ${f(s.holdMin, 0)} | ${f(s.overBudgetPct)} | ${int(s.riskMedian)} | ${int(s.riskP90)} |`;

test('risk models and 5m chart entry modes', () => {
    const m1 = load();
    const asOf = m1[m1.length - 1]!.time;
    const chart5 = aggregate(m1, 5);
    const nowWall = asOf + 86400;
    const json: Record<string, unknown> = { costs: COST, periods: { IS: '2024-09-01..2025-08-31', OOS: '2025-09-01..2026-09-01' } };
    const base = (algo: number, entryMode: number, riskModel: number, extra: Record<string, number> = {}) =>
        ({ algo, entryMode, riskModel, budget: 1e12, qty: 1, feePerSide: COST.feePerSide, slipTicks: COST.slipTicks, ...extra });

    // ---- 1m 主圖（出貨引擎）----
    const r1m: Record<string, Record<Period, Stats>> = {};
    const microRef: Record<number, number> = {};
    const lines1m: string[] = [];
    for (const algo of [0, 1, 2]) {
        for (const mode of MODES) {
            for (const rm of RISK_MODELS) {
                const res = runTrendSignal({ bars1m: m1, asOf, securityType: 'FUT', symbol: 'TMFR1', contractMonth: 'R1', tick: COST.tick,
                    pointValue: COST.pointValue, taxRate: COST.taxRate, config: configFromParams(base(algo, mode, rm)) });
                if (mode === 0 && rm === 0) microRef[algo] = microPerSegment(res.signals, res.entries, 'IS');
                const st = { IS: stats(res.trades, 'IS'), OOS: stats(res.trades, 'OOS') };
                r1m[`${algo}/${mode}/${rm}`] = st;
                for (const p of ['IS', 'OOS'] as Period[]) lines1m.push(`| ${TREND_ALGOS[algo]} | ${ENTRY_MODES[mode]} | ${rm} | ${p} ${row(st[p])}`);
            }
        }
    }
    json.oneMinute = r1m;
    json.microRef1m = microRef;

    // ---- 5m 主圖 MICRO_TREND 微型靈敏度（只看頻率）----
    const CAND: Record<number, [string, number[]]> = { 0: ['microStMult', [1, 1.5, 2, 2.5]], 1: ['microDcLength', [5, 7, 10, 14]], 2: ['microKamaHyst', [0.05, 0.1, 0.15, 0.2]] };
    const chosen: Record<number, Record<string, number>> = {};
    const calLines: string[] = [];
    for (const algo of [0, 1, 2]) {
        const [key, values] = CAND[algo]!;
        let best: { v: number; d: number } | null = null;
        for (const v of values) {
            const frame = frameFromChart(toInput(chart5), base(algo, 1, 0, { [key]: v }), nowWall);
            const res = runChartSignal(frame, { risk: false });
            const per = microPerSegment(res.signals, res.entries, 'IS');
            const d = Math.abs(per - microRef[algo]!);
            if (!best || d < best.d) best = { v, d };
            calLines.push(`| ${TREND_ALGOS[algo]} | ${key}=${v} | ${f(per, 2)} | ${f(microRef[algo]!, 2)} |`);
        }
        chosen[algo] = { [key]: best!.v };
    }
    json.microChosen5m = chosen;

    // ---- 5m 主圖（App 的 5m 路徑）----
    const r5m: Record<string, Record<Period, Stats>> = {};
    const lines5m: string[] = [];
    for (const algo of [0, 1, 2]) {
        for (const mode of MODES) {
            for (const rm of [0, 2]) {
                const frame = frameFromChart(toInput(chart5), base(algo, mode, rm, chosen[algo]), nowWall);
                const res = runChartSignal(frame);
                const st = { IS: stats(res.trades, 'IS'), OOS: stats(res.trades, 'OOS') };
                r5m[`${algo}/${mode}/${rm}`] = st;
                for (const p of ['IS', 'OOS'] as Period[]) lines5m.push(`| ${TREND_ALGOS[algo]} | ${ENTRY_MODES[mode]} | ${rm} | ${p} ${row(st[p])}`);
            }
        }
    }
    json.fiveMinute = r5m;

    // ---- 補充：預設預算 NT$1,000（1 口風險超過預算的提示被風控拒絕；不參與事前規則）----
    const rBudget: Record<string, Record<Period, Stats>> = {};
    const linesBudget: string[] = [];
    for (const algo of [0, 1, 2]) {
        for (const mode of MODES) {
            for (const [chart, rm] of [['1m', 0], ['1m', 1], ['5m', 0]] as const) {
                const params = base(algo, mode, rm, { budget: DEFAULT_BUDGET, ...(chart === '5m' ? chosen[algo] : {}) });
                const trades = chart === '1m'
                    ? runTrendSignal({ bars1m: m1, asOf, securityType: 'FUT', symbol: 'TMFR1', contractMonth: 'R1', tick: COST.tick,
                        pointValue: COST.pointValue, taxRate: COST.taxRate, config: configFromParams(params) }).trades
                    : runChartSignal(frameFromChart(toInput(chart5), params, nowWall)).trades;
                const st = { IS: stats(trades, 'IS'), OOS: stats(trades, 'OOS') };
                rBudget[`${chart}/${algo}/${mode}/${rm}`] = st;
                for (const p of ['IS', 'OOS'] as Period[]) linesBudget.push(`| ${chart} | ${TREND_ALGOS[algo]} | ${ENTRY_MODES[mode]} | ${rm} | ${p} ${row(st[p])}`);
            }
        }
    }
    json.defaultBudget = rBudget;

    // ---- 事前規則 ----
    const verdict: string[] = [];
    let adopt: number | null = null;
    let bestGain = -Infinity;
    for (const rm of [1, 2]) {
        const better = { IS: 0, OOS: 0 };
        const total = { IS: 0, OOS: 0, IS0: 0, OOS0: 0 };
        let gain = 0;
        for (const algo of [0, 1, 2]) for (const mode of MODES) {
            const a = r1m[`${algo}/${mode}/${rm}`]!;
            const b = r1m[`${algo}/${mode}/0`]!;
            for (const p of ['IS', 'OOS'] as Period[]) {
                if (a[p].perTrade > b[p].perTrade) better[p]++;
                total[p] += a[p].net;
                total[`${p}0` as 'IS0' | 'OOS0'] += b[p].net;
            }
            gain += a.IS.perTrade - b.IS.perTrade;
        }
        const ok = better.IS >= 6 && better.OOS >= 6 && total.IS > total.IS0 && total.OOS > total.OOS0;
        verdict.push(`模型 ${rm}：每筆優於模型 0 的組數 樣本內 ${better.IS}/9、樣本外 ${better.OOS}/9；9 組總損益 樣本內 ${int(total.IS)}（模型 0 ${int(total.IS0)}）、樣本外 ${int(total.OOS)}（模型 0 ${int(total.OOS0)}）；樣本內平均每筆改善 ${f(gain / 9)} 元 → ${ok ? '符合' : '不符合'}`);
        if (ok && gain / 9 > bestGain) { adopt = rm; bestGain = gain / 9; }
    }
    verdict.push(adopt === null ? '結論：維持模型 0' : `結論：預設改為模型 ${adopt}`);
    json.verdict = verdict;
    json.adopt = adopt;

    let md = `# 風控模型與 5m 主圖進場模式（TMF 1m，${new Date(m1[0]!.time * 1000).toISOString().slice(0, 10)}～${new Date(asOf * 1000).toISOString().slice(0, 10)}）\n\n`;
    md += `成本：手續費 ${COST.feePerSide} 元／邊、滑價 ${COST.slipTicks} tick／邊、期交稅 ${COST.taxRate}／邊、每點 ${COST.pointValue} 元、1 口、預算不設限。\n\n`;
    md += `## 事前規則判定\n\n${verdict.map((v) => `- ${v}`).join('\n')}\n\n`;
    md += `## 1. 1m 主圖（出貨引擎）\n\n| 核心 | 進場 | 風控模型 | 期間 ${statCols}\n|---|---|---|---${statSep}\n${lines1m.join('\n')}\n\n`;
    md += `## 2. 5m 主圖 MICRO_TREND 微型靈敏度（樣本內每段平均提示次數）\n\n| 核心 | 參數 | 5m 主圖 | 1m 主圖預設 |\n|---|---|---|---|\n${calLines.join('\n')}\n\n選定：${JSON.stringify(chosen)}\n\n`;
    md += `## 3. 5m 主圖（App 的 5m 路徑；模型 0 與 1 在 5m 主圖相同）\n\n| 核心 | 進場 | 風控模型 | 期間 ${statCols}\n|---|---|---|---${statSep}\n${lines5m.join('\n')}\n\n`;
    md += `## 4. 補充：預設預算 NT$${DEFAULT_BUDGET.toLocaleString('en-US')}（1 口風險超過預算的提示被拒絕；不參與事前規則）\n\n| 主圖 | 核心 | 進場 | 風控模型 | 期間 ${statCols}\n|---|---|---|---|---${statSep}\n${linesBudget.join('\n')}\n`;
    writeFileSync(`${OUT}/risk-models.md`, md);
    writeFileSync(`${OUT}/risk-models.json`, JSON.stringify(json, null, 2));
});
