// Gate 5 公平比較（研究量測，不在 CI 執行；V1.1 §6）：三個 TrendCore 候選（A SuperTrend、
// B KAMA＋ATR 遲滯、C Donchian＋ATR 追蹤帶）與各 1m EntryTiming 候選，全部用出貨引擎
// （src/lib/trend-signal/engine.ts）在同一份 TMF 1m、同一組成本下計算：
//   - 成本：手續費 12 元／邊、滑價 1 tick／邊、期交稅 0.00002／邊（元以下四捨五入），1 口
//   - 時序切分：樣本內 2024-09-01～2025-08-31、樣本外 2025-09-01～2026-09-01；不做任何參數
//     最佳化，敏感度參數只並列呈現（兩段各自報告，沒有用樣本外挑參數）
//   - 切分：日盤／夜盤（依成交所在盤）、月份型態（效率比高／低、波動高／低，以全期中位數分）
//   - 系統：「SAR」＝ IMMEDIATE 進場、只在 5m 反向／失效出場（停損放到 1000 × ATR，量測趨勢
//     訊號本身）；「預設風控」＝各進場模式＋出貨的預設停損、保本、移動停損
// 量測：翻轉密度、反應延遲、可成交性、成本後損益、回撤、提示的時機與價差。沒有 Universal
// Indicator 原版可重現的訊號資料，無法直接比較原版；本量測也不指定「最佳」。
// 用法同 characterize.char.ts（TSP_CHAR_CSV / TSP_CHAR_OUT）。
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { wallClockToUtc } from '../../../src/lib/utils/kbars';
import { atr } from '../../../src/lib/indicators';
import { runTrendSignal } from '../../../src/lib/trend-signal/engine';
import { DEFAULT_CONFIG } from '../../../src/lib/trend-signal/config';
import { alignPoints, lastAtOrBefore } from '../../../src/lib/trend-signal/core/bars';
import { tradingSessionOf } from '../../../src/lib/trend-signal/core/session';
import type { EntryMode, RiskConfig, TrendParams, TrendSignalConfig, TrendSignalResult, VirtualTrade } from '../../../src/lib/trend-signal/types';
import type { Candle } from '../../../src/lib/types/market';

const CSV = process.env.TSP_CHAR_CSV ?? '';
const OUT = process.env.TSP_CHAR_OUT ?? tmpdir();
const T = (s: string) => wallClockToUtc(s);
const PERIODS = { IS: [T('2024-09-01T00:00:00'), T('2025-08-31T23:59:59')], OOS: [T('2025-09-01T00:00:00'), T('2026-09-01T23:59:59')] } as const;
type Period = keyof typeof PERIODS;
const inP = (p: Period, t: number) => t >= PERIODS[p][0] && t <= PERIODS[p][1];
const POINT = 10;
const COST: Pick<RiskConfig, 'feePerSide' | 'slipTicks'> = { feePerSide: 12, slipTicks: 1 };
const TAX = 0.00002;

const median = (xs: number[]) => {
    if (!xs.length) return Number.NaN;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const quant = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(q * (s.length - 1))]! : Number.NaN;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN);
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

interface TradeStats {
    trades: number;
    winPct: number;
    net: number;
    perTrade: number;
    /** 每筆淨損益的 t 值（平均 ÷ 標準誤）：|t| < 2 表示與 0 沒有可分辨的差異 */
    tStat: number;
    /** 成本前每筆：加回手續費、期交稅與滑價（停利限價單沒有出場滑價） */
    grossPerTrade: number;
    pf: number;
    maxDd: number;
    holdBars: number;
}

function tradeStats(trades: VirtualTrade[], m1: Candle[]): TradeStats {
    const closed = trades.filter((t) => t.status === 'CLOSED').sort((a, b) => a.closedAt! - b.closedAt!);
    let eq = 0;
    let peak = 0;
    let dd = 0;
    let wins = 0;
    let gp = 0;
    let gl = 0;
    let gross = 0;
    const hold: number[] = [];
    const nets: number[] = [];
    for (const t of closed) {
        eq += t.realizedNtd;
        nets.push(t.realizedNtd);
        peak = Math.max(peak, eq);
        dd = Math.max(dd, peak - eq);
        if (t.realizedNtd > 0) {
            wins++;
            gp += t.realizedNtd;
        } else {
            gl -= t.realizedNtd;
        }
        const slip = t.qty * COST.slipTicks + t.fills.reduce((n, x) => n + (x.reason === 'TP2R' || x.reason === 'TP3R' ? 0 : x.qty * COST.slipTicks), 0);
        gross += (t.realizedPoints + slip) * POINT;
        hold.push(lastAtOrBefore(m1, t.closedAt!) - lastAtOrBefore(m1, t.fillTime) + 1);
    }
    const n = closed.length;
    const avg = n ? eq / n : Number.NaN;
    const sd = n > 1 ? Math.sqrt(nets.reduce((a, x) => a + (x - avg) ** 2, 0) / (n - 1)) : Number.NaN;
    return {
        trades: n,
        winPct: n ? (100 * wins) / n : Number.NaN,
        net: eq,
        perTrade: avg,
        tStat: sd > 0 ? avg / (sd / Math.sqrt(n)) : Number.NaN,
        grossPerTrade: n ? gross / n : Number.NaN,
        pf: gl > 0 ? gp / gl : Number.NaN,
        maxDd: dd,
        holdBars: median(hold),
    };
}

const statCols = '| 筆數 | 勝率% | 淨損益 NT$ | 每筆 NT$ | t 值 | 成本前每筆 NT$ | PF | 最大回撤 NT$ | 持有中位(1m 根) |';
const statSep = '|---|---|---|---|---|---|---|---|---|';
const statRow = (s: TradeStats) =>
    `| ${s.trades} | ${f(s.winPct)} | ${int(s.net)} | ${f(s.perTrade)} | ${f(s.tStat, 2)} | ${f(s.grossPerTrade)} | ${f(s.pf, 2)} | ${int(s.maxDd)} | ${f(s.holdBars, 0)} |`;

/** 月份型態：5m 收盤效率比（|月淨變動| ÷ Σ|逐根變動|）與平均 5m ATR，各以全期中位數二分 */
function monthRegimes(res: TrendSignalResult): Map<string, { trend: boolean; highVol: boolean; er: number; atr: number }> {
    const bars = res.m5.bars;
    const a = alignPoints(bars, atr(bars, 14));
    const by = new Map<string, { first: number; last: number; path: number; atrs: number[] }>();
    for (let i = 1; i < bars.length; i++) {
        const t = bars[i]!.time;
        if (!(inP('IS', t) || inP('OOS', t))) continue;
        const key = new Date(t * 1000).toISOString().slice(0, 7);
        let m = by.get(key);
        if (!m) {
            m = { first: bars[i - 1]!.close, last: 0, path: 0, atrs: [] };
            by.set(key, m);
        }
        m.last = bars[i]!.close;
        m.path += Math.abs(bars[i]!.close - bars[i - 1]!.close);
        if (a[i] !== undefined) m.atrs.push(a[i]!);
    }
    const rows = [...by].map(([k, m]) => ({ k, er: m.path > 0 ? Math.abs(m.last - m.first) / m.path : 0, atr: mean(m.atrs) }));
    const erMed = median(rows.map((r) => r.er));
    const atrMed = median(rows.map((r) => r.atr));
    return new Map(rows.map((r) => [r.k, { trend: r.er >= erMed, highVol: r.atr >= atrMed, er: r.er, atr: r.atr }]));
}
const monthOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 7);

/** TrendCore 本身的性質：翻轉密度、趨勢段長度、反應延遲（事後極值到訊號的根數與距離） */
function coreStats(res: TrendSignalResult, p: Period) {
    const m5 = res.m5;
    const days = new Set(m5.session.filter((k, i) => k.endsWith('D') && inP(p, m5.bars[i]!.time))).size;
    const sigs = res.signals.filter((s) => inP(p, s.barTime));
    const inv = res.invalidations.filter((x) => inP(p, x.barTime));
    // 所有狀態事件（訊號＋失效）依時間排序，量測每段長度與反應延遲
    const events = [...res.signals.map((s) => ({ i: s.index, s })), ...res.invalidations.map((x) => ({ i: x.index, s: null }))].sort((a, b) => a.i - b.i);
    const seg: number[] = [];
    const lagBars: number[] = [];
    const lagAtr: number[] = [];
    const a5 = alignPoints(m5.bars, atr(m5.bars, 14));
    for (let k = 1; k < events.length; k++) {
        const e = events[k]!;
        const prev = events[k - 1]!;
        if (e.s && inP(p, e.s.barTime)) {
            const nx = events[k + 1];
            if (nx) seg.push(nx.i - e.i);
            const long = e.s.direction === 'LONG';
            let best = long ? Infinity : -Infinity;
            let at = e.i;
            for (let j = prev.i + 1; j <= e.i; j++) {
                const b = m5.bars[j]!;
                if (long ? b.low < best : b.high > best) {
                    best = long ? b.low : b.high;
                    at = j;
                }
            }
            lagBars.push(e.i - at);
            const av = a5[e.i];
            if (av) lagAtr.push((long ? e.s.close - best : best - e.s.close) / av);
        }
    }
    return {
        days,
        signalsPerDay: days ? sigs.length / days : Number.NaN,
        invalidPerDay: days ? inv.length / days : Number.NaN,
        segMedian: median(seg),
        lagBarsMedian: median(lagBars),
        lagAtrMedian: median(lagAtr),
        lagAtrP90: quant(lagAtr, 0.9),
    };
}

/** 可成交性：有 IMMEDIATE 提示的訊號比例、提示被虛擬風控接受的比例、跨盤取消、成交價與參考價的跳動 */
function fillStats(res: TrendSignalResult, mode: EntryMode, p: Period) {
    const sigs = res.signals.filter((s) => inP(p, s.barTime));
    const hints = res.entries.filter((e) => e.mode === mode && inP(p, e.barTime));
    const imm = res.entries.filter((e) => e.mode === 'IMMEDIATE' && inP(p, e.barTime));
    const trades = res.trades.filter((t) => inP(p, t.fillTime));
    const byId = new Map(res.entries.map((e) => [e.id, e]));
    const gaps = trades.map((t) => {
        const e = byId.get(t.entryId)!;
        const open = t.direction === 'LONG' ? t.fillPrice - COST.slipTicks : t.fillPrice + COST.slipTicks;
        return Math.abs(open - e.refPrice);
    });
    const cancelled = res.events.filter((e) => e.kind === 'WARN' && e.text.includes('不跨盤') && inP(p, e.time)).length;
    return {
        immediatePct: sigs.length ? (100 * imm.length) / sigs.length : Number.NaN,
        acceptedPct: hints.length ? (100 * trades.length) / hints.length : Number.NaN,
        cancelled,
        gapMedian: median(gaps),
        gapP90: quant(gaps, 0.9),
    };
}

/** 1m 提示的時機（與風控無關）：有提示的趨勢段比例、每段提示數、第一次提示的延遲與相對 IMMEDIATE 的價差 */
function hintStats(res: TrendSignalResult, mode: EntryMode, p: Period) {
    const sigs = res.signals.filter((s) => inP(p, s.barTime));
    const hints = res.entries.filter((e) => e.mode === mode);
    const bySig = new Map<string, typeof hints>();
    for (const e of hints) {
        const l = bySig.get(e.signalId) ?? [];
        l.push(e);
        bySig.set(e.signalId, l);
    }
    const delay: number[] = [];
    const impr: number[] = [];
    let withHint = 0;
    let count = 0;
    for (const s of sigs) {
        const l = bySig.get(s.id);
        if (!l?.length) continue;
        withHint++;
        count += l.length;
        const first = l[0]!;
        delay.push((first.barTime - s.barTime) / 60);
        if (s.atr) impr.push(((s.direction === 'LONG' ? 1 : -1) * (s.close - first.refPrice)) / s.atr);
    }
    return {
        segPct: sigs.length ? (100 * withHint) / sigs.length : Number.NaN,
        perSeg: withHint ? count / withHint : Number.NaN,
        delayMedian: median(delay),
        imprMedian: median(impr),
        imprMean: mean(impr),
    };
}

interface Candidate {
    id: string;
    label: string;
    trend: TrendParams;
    primary: boolean;
}

test('gate 5 comparison', () => {
    const m1 = load();
    const asOf = m1[m1.length - 1]!.time;
    const base = DEFAULT_CONFIG.trend;
    const cands: Candidate[] = [
        { id: 'A', label: 'A SuperTrend(10,3)', trend: { ...base, algo: 'supertrend' }, primary: true },
        { id: 'B', label: 'B KAMA(10,2,30)+0.3', trend: { ...base, algo: 'kama' }, primary: true },
        { id: 'C', label: 'C Donchian(20)+ATR×3', trend: { ...base, algo: 'donchian' }, primary: true },
        { id: 'A2', label: 'A 敏感度 SuperTrend(10,2)', trend: { ...base, algo: 'supertrend', stMult: 2 }, primary: false },
        { id: 'A4', label: 'A 敏感度 SuperTrend(10,4)', trend: { ...base, algo: 'supertrend', stMult: 4 }, primary: false },
        { id: 'B15', label: 'B 敏感度 KAMA 遲滯 0.15', trend: { ...base, algo: 'kama', kamaHyst: 0.15 }, primary: false },
        { id: 'B60', label: 'B 敏感度 KAMA 遲滯 0.6', trend: { ...base, algo: 'kama', kamaHyst: 0.6 }, primary: false },
        { id: 'C10', label: 'C 敏感度 Donchian(10)+ATR×3', trend: { ...base, algo: 'donchian', dcLength: 10 }, primary: false },
        { id: 'C40', label: 'C 敏感度 Donchian(40)+ATR×3', trend: { ...base, algo: 'donchian', dcLength: 40 }, primary: false },
        { id: 'C2', label: 'C 敏感度 Donchian(20)+ATR×2', trend: { ...base, algo: 'donchian', dcAtrMult: 2 }, primary: false },
        { id: 'C4', label: 'C 敏感度 Donchian(20)+ATR×4', trend: { ...base, algo: 'donchian', dcAtrMult: 4 }, primary: false },
    ];
    const risk: RiskConfig = { ...DEFAULT_CONFIG.risk, ...COST, budget: 1e12, qty: 1 };
    const run = (trend: TrendParams, mode: EntryMode, r: RiskConfig): TrendSignalResult => {
        const config: TrendSignalConfig = { ...DEFAULT_CONFIG, trend, entry: { ...DEFAULT_CONFIG.entry, mode }, risk: r };
        return runTrendSignal({ bars1m: m1, asOf, securityType: 'FUT', symbol: 'TMFR1', contractMonth: 'R1', tick: 1, pointValue: POINT, taxRate: TAX, config });
    };
    const MODES: EntryMode[] = ['IMMEDIATE', 'MICRO_TREND', 'PRICE_STRUCTURE', 'PULLBACK_KD'];
    const MODE_LABEL: Record<EntryMode, string> = {
        IMMEDIATE: 'IMMEDIATE',
        MICRO_TREND: 'MICRO_TREND',
        PRICE_STRUCTURE: 'PRICE_STRUCTURE',
        PULLBACK_KD: 'PULLBACK_KD（先前策略假說／未驗證）',
    };
    const json: Record<string, unknown> = { costs: { ...COST, tax: TAX, pointValue: POINT, qty: 1 }, periods: { IS: '2024-09-01..2025-08-31', OOS: '2025-09-01..2026-09-01' } };
    let md = '';
    let regimes: ReturnType<typeof monthRegimes> | null = null;
    const core: string[] = [];
    const sar: string[] = [];
    const sarSplit: string[] = [];
    const modes: string[] = [];
    const hintsMd: string[] = [];
    const fills: string[] = [];
    const regimeMd: string[] = [];
    for (const c of cands) {
        const s = run(c.trend, 'IMMEDIATE', { ...risk, stopAtr: 1000 });
        regimes ??= monthRegimes(s);
        const entry: Record<string, unknown> = {};
        for (const p of ['IS', 'OOS'] as Period[]) {
            const cs = coreStats(s, p);
            core.push(`| ${c.label} | ${p} | ${f(cs.signalsPerDay, 2)} | ${f(cs.invalidPerDay, 2)} | ${f(cs.segMedian, 0)} | ${f(cs.lagBarsMedian, 0)} | ${f(cs.lagAtrMedian, 2)} | ${f(cs.lagAtrP90, 2)} |`);
            const st = tradeStats(s.trades.filter((t) => inP(p, t.fillTime)), m1);
            sar.push(`| ${c.label} | ${p} ${statRow(st)}`);
            entry[`core_${p}`] = cs;
            entry[`sar_${p}`] = st;
        }
        // 日夜盤（全期，依成交所在盤）
        const both = s.trades.filter((t) => inP('IS', t.fillTime) || inP('OOS', t.fillTime));
        for (const [name, pick] of [['日盤', false], ['夜盤', true]] as [string, boolean][]) {
            const st = tradeStats(both.filter((t) => tradingSessionOf('FUT', t.fillTime).night === pick), m1);
            sarSplit.push(`| ${c.label} | ${name} ${statRow(st)}`);
            entry[`sar_${pick ? 'night' : 'day'}`] = st;
        }
        if (c.primary) {
            // 月份型態（全期）
            for (const [name, pick] of [
                ['趨勢月（效率比高）', (k: string) => regimes!.get(k)?.trend === true],
                ['盤整月（效率比低）', (k: string) => regimes!.get(k)?.trend === false],
                ['高波動月', (k: string) => regimes!.get(k)?.highVol === true],
                ['低波動月', (k: string) => regimes!.get(k)?.highVol === false],
            ] as [string, (k: string) => boolean][]) {
                const st = tradeStats(both.filter((t) => pick(monthOf(t.fillTime))), m1);
                regimeMd.push(`| ${c.label} | ${name} ${statRow(st)}`);
                entry[`sar_regime_${name}`] = st;
            }
            for (const mode of MODES) {
                const r = run(c.trend, mode, risk);
                for (const p of ['IS', 'OOS'] as Period[]) {
                    const st = tradeStats(r.trades.filter((t) => inP(p, t.fillTime)), m1);
                    modes.push(`| ${c.label} | ${MODE_LABEL[mode]} | ${p} ${statRow(st)}`);
                    const hs = hintStats(r, mode, p);
                    hintsMd.push(`| ${c.label} | ${MODE_LABEL[mode]} | ${p} | ${f(hs.segPct)} | ${f(hs.perSeg, 2)} | ${f(hs.delayMedian, 0)} | ${f(hs.imprMedian, 2)} | ${f(hs.imprMean, 2)} |`);
                    const fs = fillStats(r, mode, p);
                    fills.push(`| ${c.label} | ${MODE_LABEL[mode]} | ${p} | ${f(fs.immediatePct)} | ${f(fs.acceptedPct)} | ${fs.cancelled} | ${f(fs.gapMedian, 0)} | ${f(fs.gapP90, 0)} |`);
                    entry[`${mode}_${p}`] = { trades: st, hints: hs, fill: fs };
                }
            }
        }
        json[c.id] = { label: c.label, trend: c.trend, ...entry };
    }
    // 1m 參數與提示範圍敏感度（預設風控）：微型趨勢靈敏度、V1.0 的 15 分鐘窗口對照整段趨勢
    const sens: [string, TrendParams, EntryMode, Partial<TrendSignalConfig['entry']>][] = [
        ['A MICRO_TREND 1m 倍數 1（V1.0 預設）', cands[0]!.trend, 'MICRO_TREND', { microMult: 1 }],
        ['A MICRO_TREND 1m 倍數 2', cands[0]!.trend, 'MICRO_TREND', { microMult: 2 }],
        ['A MICRO_TREND 1m 倍數 3（V1.1 預設）', cands[0]!.trend, 'MICRO_TREND', {}],
        ['A MICRO_TREND 1m 倍數 1＋窗口 3 根 5m（≈V1.0）', cands[0]!.trend, 'MICRO_TREND', { microMult: 1, windowBars: 3 }],
        ['A PRICE_STRUCTURE＋窗口 3 根 5m（≈V1.0）', cands[0]!.trend, 'PRICE_STRUCTURE', { windowBars: 3 }],
        ['B MICRO_TREND 1m 遲滯 0.15', cands[1]!.trend, 'MICRO_TREND', { microKamaHyst: 0.15 }],
        ['C MICRO_TREND 1m Donchian(10)', cands[2]!.trend, 'MICRO_TREND', { microDcLength: 10 }],
    ];
    const sensMd: string[] = [];
    for (const [name, trend, mode, patch] of sens) {
        const config: TrendSignalConfig = { ...DEFAULT_CONFIG, trend, entry: { ...DEFAULT_CONFIG.entry, mode, ...patch }, risk };
        const r = runTrendSignal({ bars1m: m1, asOf, securityType: 'FUT', symbol: 'TMFR1', contractMonth: 'R1', tick: 1, pointValue: POINT, taxRate: TAX, config });
        for (const p of ['IS', 'OOS'] as Period[]) {
            const st = tradeStats(r.trades.filter((t) => inP(p, t.fillTime)), m1);
            const hs = hintStats(r, mode, p);
            sensMd.push(`| ${name} | ${p} | ${f(hs.segPct)} | ${f(hs.perSeg, 2)} | ${f(hs.delayMedian, 0)} | ${f(hs.imprMean, 2)} ${statRow(st)}`);
            json[`sens ${name} ${p}`] = { trades: st, hints: hs };
        }
    }
    md += `# Gate 5 公平比較（TMF 1m，${new Date(m1[0]!.time * 1000).toISOString().slice(0, 10)}～${new Date(asOf * 1000).toISOString().slice(0, 10)}）\n\n`;
    md += `成本：手續費 ${COST.feePerSide} 元／邊、滑價 ${COST.slipTicks} tick／邊、期交稅 ${TAX}／邊、每點 ${POINT} 元、1 口。樣本內 2024-09-01～2025-08-31、樣本外 2025-09-01～2026-09-01。不做參數最佳化，不指定最佳；無法直接比較 Universal Indicator 原版。\n\n`;
    md += `## 1. TrendCore 性質（翻轉密度、趨勢段長度、反應延遲）\n\n| 候選 | 期間 | 訊號/日 | 失效/日 | 趨勢段中位(5m 根) | 延遲中位(5m 根) | 延遲中位(ATR) | 延遲 P90(ATR) |\n|---|---|---|---|---|---|---|---|\n${core.join('\n')}\n\n`;
    md += `## 2. SAR（IMMEDIATE 進場、只在 5m 反向／失效出場）成本後\n\n| 候選 | 期間 ${statCols}\n|---|---${statSep}\n${sar.join('\n')}\n\n`;
    md += `### 2a. SAR 日盤／夜盤（全期，依成交所在盤）\n\n| 候選 | 盤別 ${statCols}\n|---|---${statSep}\n${sarSplit.join('\n')}\n\n`;
    md += `### 2b. SAR 月份型態（全期；效率比、波動各以中位數二分）\n\n| 候選 | 型態 ${statCols}\n|---|---${statSep}\n${regimeMd.join('\n')}\n\n`;
    md += `## 3. 各進場模式＋預設風控（停損 1.5 × 1m ATR／擺動點、+1R 保本、+2R 移動停損、5m 反向／失效出場）成本後\n\n| 候選 | 進場模式 | 期間 ${statCols}\n|---|---|---${statSep}\n${modes.join('\n')}\n\n`;
    md += `### 3b. 1m 參數與提示範圍敏感度（預設風控）\n\n| 設定 | 期間 | 有提示的趨勢段% | 每段提示數 | 第一次提示延遲中位(分) | 第一次提示價差平均(ATR) ${statCols}\n|---|---|---|---|---|---${statSep}\n${sensMd.join('\n')}\n\n`;
    md += `## 4. 1m 提示時機（與風控無關）\n\n| 候選 | 進場模式 | 期間 | 有提示的趨勢段% | 每段提示數 | 第一次提示延遲中位(分) | 第一次提示價差中位(ATR，正＝較 5m 收盤有利) | 價差平均(ATR) |\n|---|---|---|---|---|---|---|---|\n${hintsMd.join('\n')}\n\n`;
    md += `## 5. 可成交性\n\n| 候選 | 進場模式 | 期間 | 有 IMMEDIATE 提示的訊號% | 提示被接受成交% | 跨盤取消 | 成交開盤與參考價差中位(點) | 差 P90(點) |\n|---|---|---|---|---|---|---|---|\n${fills.join('\n')}\n\n`;
    md += `月份型態：${[...regimes!].map(([k, v]) => `${k} ${v.trend ? '趨勢' : '盤整'}/${v.highVol ? '高' : '低'}波動（ER ${v.er.toFixed(3)}，ATR ${v.atr.toFixed(1)}）`).join('；')}\n`;
    writeFileSync(`${OUT}/gate5-comparison.md`, md);
    writeFileSync(`${OUT}/gate5-comparison.json`, JSON.stringify(json, null, 2));
});
