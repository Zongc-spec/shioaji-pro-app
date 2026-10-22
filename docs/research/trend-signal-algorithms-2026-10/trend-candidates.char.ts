// 一次性研究量測（不在 CI 執行）：結果 9 第一階段 — 其他 5m 趨勢演算法候選的指標性質，
// 判定是否離開現有三核心的取捨線。只量指標性質，不算損益。事前規則見 ../trend-signal-algorithms-2026-10.md 結果 9.0。
//
//   D=docs/research/trend-signal-algorithms-2026-10
//   TSP_CHAR_CSV=<兩年 1m CSV> TSP_FRESH_CSV=<結果 8 新資料 CSV> TSP_CHAR_OUT=<輸出目錄> \
//   npx vitest run --config "$PWD/$D/vitest.config.mjs" --root "$D" trend-candidates
//
// CSV 的 datetime 為台灣時間的 1m 收盤 label。資料不進 repo。
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { atr, supertrend } from '../../../src/lib/indicators';
import { aggregate, wallClockToUtc } from '../../../src/lib/utils/kbars';
import { tradingSessionOf } from '../../../src/lib/trend-signal/core/session';
import { alignPoints } from '../../../src/lib/trend-signal/core/bars';
import { ALGORITHMS, kamaLine } from '../../../src/lib/trend-signal/trend/algorithms';
import { configFromParams } from '../../../src/lib/trend-signal/config';
import type { TrendParams } from '../../../src/lib/trend-signal/types';
import type { Candle } from '../../../src/lib/types/market';

const CSV = process.env.TSP_CHAR_CSV ?? '';
const FRESH_CSV = process.env.TSP_FRESH_CSV ?? '';
const OUT = process.env.TSP_CHAR_OUT ?? tmpdir();
const T = wallClockToUtc;
const SPLICE = T('2026-08-25T00:00:00');
const PERIODS = {
    IS: [T('2024-09-01T00:00:00'), T('2025-08-31T23:59:59')],
    OOS: [T('2025-09-01T00:00:00'), T('2026-09-01T23:59:59')],
    FRESH: [T('2026-09-02T00:00:00'), T('2026-10-21T23:59:59')],
} as const;
type Period = keyof typeof PERIODS;
const WARMUP = 150; // 新候選一律 150 根 5m（同 A、B 的預設暖身）

type State = 1 | -1 | 0 | null; // LONG／SHORT／NEUTRAL／未知

function loadCsv(path: string, from = -Infinity, to = Infinity): Candle[] {
    const out: Candle[] = [];
    const lines = readFileSync(path, 'utf8').split('\n');
    for (let k = 1; k < lines.length; k++) {
        const line = lines[k];
        if (!line) continue;
        const [dt, o, h, l, c, v] = line.split(',');
        const t = T(dt!);
        if (t < from || t > to) continue;
        out.push({ time: t, open: +o!, high: +h!, low: +l!, close: +c!, volume: +v! });
    }
    return out;
}

const median = (xs: number[]) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (n: number, d: number) => (d ? (100 * n) / d : NaN);

// ---- 結果 1 的指標（逐字沿用 characterize.char.ts，只用於重現性檢查）----

interface Ev { i: number; d: 1 | -1 }
const R1_WARM = 200;
function r1Events(dir: number[]): Ev[] {
    const ev: Ev[] = [];
    for (let i = Math.max(1, R1_WARM); i < dir.length; i++) {
        const a = dir[i - 1]!;
        const c = dir[i]!;
        if (a !== 0 && c !== 0 && a !== c) ev.push({ i, d: c as 1 | -1 });
    }
    return ev;
}
function r1Opp(ev: Ev[]): { next: number[]; prev: number[] } {
    const next = new Array<number>(ev.length).fill(-1);
    const prev = new Array<number>(ev.length).fill(-1);
    for (let k = ev.length - 2; k >= 0; k--) next[k] = ev[k + 1]!.d !== ev[k]!.d ? k + 1 : next[k + 1]!;
    for (let k = 1; k < ev.length; k++) prev[k] = ev[k - 1]!.d !== ev[k]!.d ? k - 1 : prev[k - 1]!;
    return { next, prev };
}
function r1Metrics(b: Candle[], ev: Ev[], a14: (number | undefined)[], days: number) {
    const opp = r1Opp(ev);
    let w3 = 0, w6 = 0, over1 = 0, mfeN = 0;
    const seg: number[] = [], lag: number[] = [], give: number[] = [], mfe: number[] = [];
    for (let k = 0; k < ev.length; k++) {
        const e = ev[k]!;
        const nextOpp = opp.next[k]! >= 0 ? ev[opp.next[k]!] : undefined;
        const end = nextOpp ? nextOpp.i : b.length - 1;
        if (nextOpp) {
            if (nextOpp.i - e.i <= 3) w3++;
            if (nextOpp.i - e.i <= 6) w6++;
            seg.push(nextOpp.i - e.i);
        }
        const av = a14[e.i];
        if (av === undefined || av <= 0) continue;
        const prevOpp = opp.prev[k]! >= 0 ? ev[opp.prev[k]!] : undefined;
        if (prevOpp) {
            let ie = prevOpp.i + 1;
            for (let j = prevOpp.i + 1; j <= e.i; j++) if (e.d === 1 ? b[j]!.low < b[ie]!.low : b[j]!.high > b[ie]!.high) ie = j;
            lag.push(e.i - ie);
            give.push((e.d === 1 ? b[e.i]!.close - b[ie]!.low : b[ie]!.high - b[e.i]!.close) / av);
        }
        if (nextOpp) {
            let best = 0;
            for (let j = e.i + 1; j <= end; j++) best = Math.max(best, e.d === 1 ? b[j]!.high - b[e.i]!.close : b[e.i]!.close - b[j]!.low);
            mfe.push(best / av);
            mfeN++;
            if (best / av > 1) over1++;
        }
    }
    const n = ev.length;
    return [n / days, pct(w3, n), pct(w6, n), median(seg), median(lag), median(give), median(mfe), pct(over1, mfeN)];
}

// ---- 結果 9 的指標（事前規則 9.0）----

interface Props { n: number; perDay: number; fail3: number; fail6: number; lag: number; seg: number }

function props(S: State[], b: Candle[], from: number, to: number, days: number): Props {
    let n = 0, f3 = 0, f6 = 0;
    const lag: number[] = [];
    const seg: number[] = [];
    let lastChange = -1; // 上一次狀態改變（兩側皆已知）的根
    for (let j = 1; j < S.length; j++) {
        const a = S[j - 1];
        const c = S[j];
        if (a === null || c === null || a === c) continue;
        const t = b[j]!.time;
        if ((c === 1 || c === -1) && t >= from && t <= to) {
            n++;
            let leave = -1;
            for (let k = j + 1; k < S.length; k++) {
                if (S[k] !== null && S[k] !== c) {
                    leave = k;
                    break;
                }
            }
            if (leave >= 0) {
                if (leave - j <= 3) f3++;
                if (leave - j <= 6) f6++;
                seg.push(leave - j);
            }
            if (lastChange >= 0) {
                let ie = lastChange + 1;
                for (let k = lastChange + 1; k <= j; k++) if (c === 1 ? b[k]!.low < b[ie]!.low : b[k]!.high > b[ie]!.high) ie = k;
                lag.push(j - ie);
            }
        }
        lastChange = j;
    }
    return { n, perDay: n / days, fail3: pct(f3, n), fail6: pct(f6, n), lag: median(lag), seg: median(seg) };
}

// 下包絡：Pareto 點（沒有其他點延遲不更長、失效不更高），相鄰點線性內插；範圍外為 undefined
function envelope(points: { lag: number; v: number }[]) {
    const sorted = [...points].sort((x, y) => x.lag - y.lag || x.v - y.v);
    const front: { lag: number; v: number }[] = [];
    for (const p of sorted) {
        const last = front.at(-1);
        if (last && last.lag === p.lag) continue;
        if (!last || p.v < last.v) front.push(p);
    }
    const at = (lag: number): number | undefined => {
        if (!front.length || lag < front[0]!.lag || lag > front.at(-1)!.lag) return undefined;
        for (let k = 0; k < front.length; k++) {
            const p = front[k]!;
            if (p.lag === lag) return p.v;
            const q = front[k + 1];
            if (q && lag > p.lag && lag < q.lag) return p.v + ((lag - p.lag) / (q.lag - p.lag)) * (q.v - p.v);
        }
        return undefined;
    };
    return { front, at };
}

// ---- 共用工具 ----

const closes = (b: Candle[]) => b.map((x) => x.close);
function emaArr(xs: (number | undefined)[], n: number): (number | undefined)[] {
    const k = 2 / (n + 1);
    const out: (number | undefined)[] = new Array(xs.length);
    let e: number | undefined;
    for (let i = 0; i < xs.length; i++) {
        const x = xs[i];
        if (x === undefined) {
            out[i] = undefined;
            continue;
        }
        e = e === undefined ? x : e + k * (x - e);
        out[i] = e;
    }
    return out;
}
function rma(xs: number[], n: number): (number | undefined)[] {
    const out: (number | undefined)[] = new Array(xs.length);
    let s = 0;
    let r: number | undefined;
    for (let i = 0; i < xs.length; i++) {
        if (i < n) {
            s += xs[i]!;
            out[i] = i === n - 1 ? (r = s / n) : undefined;
            continue;
        }
        r = r! + (xs[i]! - r!) / n;
        out[i] = r;
    }
    return out;
}
const trueRange = (b: Candle[]) => b.map((x, i) => (i === 0 ? x.high - x.low
    : Math.max(x.high - x.low, Math.abs(x.high - b[i - 1]!.close), Math.abs(x.low - b[i - 1]!.close))));

function withWarmup(dir: State[]): State[] {
    return dir.map((d, i) => (i < WARMUP ? null : d));
}

/** 產品 KAMA 的擺動遲滯：線從高點回落（低點回升）h × ATR14 才翻轉；第一個可用點以線的走向決定初始方向 */
function swingDir(line: (number | undefined)[], a14: (number | undefined)[], h: number): State[] {
    const dir: State[] = new Array(line.length);
    let d: 1 | -1 | 0 = 0;
    let hi = 0;
    let lo = 0;
    for (let i = 0; i < line.length; i++) {
        const k = line[i];
        const av = a14[i];
        if (k === undefined || av === undefined) {
            dir[i] = null;
            continue;
        }
        if (d === 0) {
            const prev = i > 0 ? line[i - 1] : undefined;
            d = prev !== undefined && k < prev ? -1 : 1;
            hi = lo = k;
        } else if (d === 1) {
            hi = Math.max(hi, k);
            if (k < hi - h * av) {
                d = -1;
                lo = k;
            }
        } else {
            lo = Math.min(lo, k);
            if (k > lo + h * av) {
                d = 1;
                hi = k;
            }
        }
        dir[i] = d;
    }
    return dir;
}

/** 通道突破：收盤 > 上軌轉 LONG、< 下軌轉 SHORT，其餘維持；第一次突破前未知 */
function bandBreak(b: Candle[], up: (number | undefined)[], lo: (number | undefined)[]): State[] {
    let d: State = null;
    return b.map((x, i) => {
        if (up[i] === undefined || lo[i] === undefined) return null;
        if (x.close > up[i]!) d = 1;
        else if (x.close < lo[i]!) d = -1;
        return d;
    });
}

/** 兩條線比較：a > b 為 LONG、< 為 SHORT、相等維持 */
function crossDir(a: (number | undefined)[], c: (number | undefined)[]): State[] {
    let d: State = null;
    return a.map((x, i) => {
        const y = c[i];
        if (x === undefined || y === undefined) return null;
        if (x > y) d = 1;
        else if (x < y) d = -1;
        return d;
    });
}

function stDir(b: Candle[], p: number, m: number): State[] {
    const r = supertrend(b, p, m);
    return b.map((_, i) => (r.up[i]?.value !== undefined ? 1 : r.down[i]?.value !== undefined ? -1 : null));
}

function rolling(b: Candle[], n: number, f: (w: Candle[]) => number): (number | undefined)[] {
    return b.map((_, i) => (i < n - 1 ? undefined : f(b.slice(i - n + 1, i + 1))));
}
const hh = (w: Candle[]) => Math.max(...w.map((x) => x.high));
const ll = (w: Candle[]) => Math.min(...w.map((x) => x.low));

// ---- 候選 ----

function keltner(b: Candle[]): State[] {
    const mid = emaArr(closes(b), 20);
    const a10 = alignPoints(b, atr(b, 10));
    return bandBreak(b, mid.map((m, i) => (m === undefined || a10[i] === undefined ? undefined : m + 2 * a10[i]!)),
        mid.map((m, i) => (m === undefined || a10[i] === undefined ? undefined : m - 2 * a10[i]!)));
}

function bollinger(b: Candle[]): State[] {
    const stats = rolling(b, 20, (w) => {
        const m = w.reduce((s, x) => s + x.close, 0) / w.length;
        return Math.sqrt(w.reduce((s, x) => s + (x.close - m) ** 2, 0) / w.length);
    });
    const mean = rolling(b, 20, (w) => w.reduce((s, x) => s + x.close, 0) / w.length);
    return bandBreak(b, mean.map((m, i) => (m === undefined ? undefined : m + 2 * stats[i]!)),
        mean.map((m, i) => (m === undefined ? undefined : m - 2 * stats[i]!)));
}

function ichimokuTk(b: Candle[]): State[] {
    const tenkan = rolling(b, 9, (w) => (hh(w) + ll(w)) / 2);
    const kijun = rolling(b, 26, (w) => (hh(w) + ll(w)) / 2);
    return crossDir(tenkan, kijun);
}

function dmi(b: Candle[], n = 14) {
    const plus = b.map((x, i) => {
        if (i === 0) return 0;
        const up = x.high - b[i - 1]!.high;
        const dn = b[i - 1]!.low - x.low;
        return up > dn && up > 0 ? up : 0;
    });
    const minus = b.map((x, i) => {
        if (i === 0) return 0;
        const up = x.high - b[i - 1]!.high;
        const dn = b[i - 1]!.low - x.low;
        return dn > up && dn > 0 ? dn : 0;
    });
    const tr = rma(trueRange(b), n);
    const sp = rma(plus, n);
    const sm = rma(minus, n);
    const pdi = b.map((_, i) => (tr[i] ? (100 * sp[i]!) / tr[i]! : undefined));
    const mdi = b.map((_, i) => (tr[i] ? (100 * sm[i]!) / tr[i]! : undefined));
    const dx = b.map((_, i) => {
        const p = pdi[i];
        const m = mdi[i];
        return p === undefined || m === undefined || p + m === 0 ? 0 : (100 * Math.abs(p - m)) / (p + m);
    });
    const first = pdi.findIndex((x) => x !== undefined);
    const adxTail = rma(dx.slice(first), n);
    const adx = b.map((_, i) => (i < first ? undefined : adxTail[i - first]));
    return { pdi, mdi, adx };
}

function zlema(b: Candle[], n = 20): (number | undefined)[] {
    const lag = Math.floor((n - 1) / 2);
    const c = closes(b);
    return emaArr(c.map((x, i) => (i < lag ? undefined : 2 * x - c[i - lag]!)), n);
}

function t3(b: Candle[], n = 10, a = 0.7): (number | undefined)[] {
    const e1 = emaArr(closes(b), n);
    const e2 = emaArr(e1, n);
    const e3 = emaArr(e2, n);
    const e4 = emaArr(e3, n);
    const e5 = emaArr(e4, n);
    const e6 = emaArr(e5, n);
    const c1 = -(a ** 3);
    const c2 = 3 * a ** 2 + 3 * a ** 3;
    const c3 = -6 * a ** 2 - 3 * a - 3 * a ** 3;
    const c4 = 1 + 3 * a + a ** 3 + 3 * a ** 2;
    return b.map((_, i) => c1 * e6[i]! + c2 * e5[i]! + c3 * e4[i]! + c4 * e3[i]!);
}

function alma(b: Candle[], n = 21, offset = 0.85, sigma = 6): (number | undefined)[] {
    const m = offset * (n - 1);
    const s = n / sigma;
    const w = Array.from({ length: n }, (_, i) => Math.exp(-((i - m) ** 2) / (2 * s * s)));
    const ws = w.reduce((x, y) => x + y, 0);
    return b.map((_, t) => {
        if (t < n - 1) return undefined;
        let acc = 0;
        for (let i = 0; i < n; i++) acc += w[i]! * b[t - n + 1 + i]!.close;
        return acc / ws;
    });
}

function superSmoother(b: Candle[], n = 20): (number | undefined)[] {
    const a1 = Math.exp((-1.414 * Math.PI) / n);
    const c2 = 2 * a1 * Math.cos((1.414 * Math.PI) / n);
    const c3 = -a1 * a1;
    const c1 = 1 - c2 - c3;
    const x = closes(b);
    const f: number[] = [];
    for (let i = 0; i < x.length; i++) {
        f.push(i < 2 ? x[i]! : (c1 * (x[i]! + x[i - 1]!)) / 2 + c2 * f[i - 1]! + c3 * f[i - 2]!);
    }
    return f;
}

function choppiness(b: Candle[], n = 14): (number | undefined)[] {
    const tr = trueRange(b);
    return b.map((_, i) => {
        if (i < n) return undefined;
        let s = 0;
        for (let j = i - n + 1; j <= i; j++) s += tr[j]!;
        const w = b.slice(i - n + 1, i + 1);
        const range = hh(w) - ll(w);
        return range > 0 ? (100 * Math.log10(s / range)) / Math.log10(n) : undefined;
    });
}

function efficiency(b: Candle[], n = 10): (number | undefined)[] {
    return b.map((x, i) => {
        if (i < n) return undefined;
        let vol = 0;
        for (let j = i - n + 1; j <= i; j++) vol += Math.abs(b[j]!.close - b[j - 1]!.close);
        return vol > 0 ? Math.abs(x.close - b[i - n]!.close) / vol : 0;
    });
}

function gated(dir: State[], open: (boolean | undefined)[]): State[] {
    return dir.map((d, i) => (d === null || open[i] === undefined ? null : open[i] ? d : 0));
}

/** 量能 K 棒：累積到前 20 個日盤交易日平均每根 5m 成交量才收棒；時段結束強制收棒 */
function volumeBars(m1: Candle[], b5: Candle[]): Candle[] {
    const key1 = m1.map((x) => tradingSessionOf('FUT', x.time).key);
    const sessions: { key: string; vol: number; n5: number }[] = [];
    const idx = new Map<string, number>();
    for (let i = 0; i < m1.length; i++) {
        const k = key1[i]!;
        if (!idx.has(k)) {
            idx.set(k, sessions.length);
            sessions.push({ key: k, vol: 0, n5: 0 });
        }
        sessions[idx.get(k)!]!.vol += m1[i]!.volume;
    }
    for (const x of b5) {
        const s = idx.get(tradingSessionOf('FUT', x.time).key);
        if (s !== undefined) sessions[s]!.n5++;
    }
    const target = sessions.map((_, s) => {
        let vol = 0, n5 = 0, days = 0;
        for (let k = s - 1; k >= 0 && days < 20; k--) {
            vol += sessions[k]!.vol;
            n5 += sessions[k]!.n5;
            if (sessions[k]!.key.endsWith('D')) days++;
        }
        return days === 20 && n5 > 0 ? vol / n5 : undefined;
    });
    const out: Candle[] = [];
    let cur: Candle | null = null;
    for (let i = 0; i < m1.length; i++) {
        const x = m1[i]!;
        const v = target[idx.get(key1[i]!)!];
        if (v === undefined) continue;
        cur = cur ? { time: x.time, open: cur.open, high: Math.max(cur.high, x.high), low: Math.min(cur.low, x.low), close: x.close, volume: cur.volume + x.volume }
            : { ...x };
        const sessionEnds = i + 1 >= m1.length || key1[i + 1] !== key1[i];
        if (cur.volume >= v || sessionEnds) {
            out.push(cur);
            cur = null;
        }
    }
    return out;
}

/** 把另一條序列的狀態投影到 5m：該 5m 收盤時最後一根已收的 K 棒 */
function project(src: Candle[], dir: State[], b5: Candle[]): State[] {
    const out: State[] = new Array(b5.length);
    let k = -1;
    for (let j = 0; j < b5.length; j++) {
        while (k + 1 < src.length && src[k + 1]!.time <= b5[j]!.time) k++;
        out[j] = k >= 0 ? dir[k]! : null;
    }
    return out;
}

function sessionSplit(b5: Candle[], m: number): State[] {
    const night = b5.map((x) => tradingSessionOf('FUT', x.time).key.endsWith('N'));
    const out: State[] = new Array(b5.length).fill(null);
    for (const isNight of [false, true]) {
        const ids = b5.flatMap((_, i) => (night[i] === isNight ? [i] : []));
        const sub = ids.map((i) => b5[i]!);
        const d = withWarmup(stDir(sub, 10, m));
        ids.forEach((i, k) => { out[i] = d[k]!; });
    }
    return out;
}

function productDir(b5: Candle[], over: Partial<TrendParams>): State[] {
    const p = { ...configFromParams({}).trend, ...over } as TrendParams;
    const algo = ALGORITHMS[p.algo];
    const warm = algo.warmup(p);
    return algo.compute(b5, p).dir.map((d, i) => (i < warm ? null : d));
}

// ---- 主程式 ----

test('結果 9 第一階段：趨勢演算法候選的指標性質（TMF，唯讀）', () => {
    if (!CSV || !FRESH_CSV) throw new Error('請以 TSP_CHAR_CSV、TSP_FRESH_CSV 指定 1m CSV');
    const log: string[] = [];

    // 重現性檢查 1：結果 1 的期間與定義重算 SuperTrend(10, 2／3／4)
    const r1m1 = loadCsv(CSV, T('2025-09-01T00:00:00'), T('2026-09-01T23:59:59'));
    const r1b5 = aggregate(r1m1, 5);
    const r1a14 = alignPoints(r1b5, atr(r1b5, 14));
    const r1days = new Set(r1m1.map((x) => tradingSessionOf('FUT', x.time).key).filter((k) => k.endsWith('D'))).size;
    const expected: Record<number, string[]> = {
        2: ['10.28', '5.0', '17.3', '17', '6', '3.04', '1.98', '70.1'],
        3: ['5.88', '3.0', '8.2', '29', '10', '4.10', '2.69', '77.3'],
        4: ['3.76', '0.9', '4.0', '47', '16', '5.05', '3.62', '82.0'],
    };
    for (const m of [2, 3, 4]) {
        const r = supertrend(r1b5, 10, m);
        const dir = r1b5.map((_, i) => (r.up[i]!.value !== undefined ? 1 : r.down[i]!.value !== undefined ? -1 : 0));
        const got = r1Metrics(r1b5, r1Events(dir), r1a14, r1days);
        const fmt = [got[0]!.toFixed(2), got[1]!.toFixed(1), got[2]!.toFixed(1), String(got[3]), String(got[4]), got[5]!.toFixed(2), got[6]!.toFixed(2), got[7]!.toFixed(1)];
        log.push(`重現 SuperTrend(10,${m})：${fmt.join(' | ')}`);
        expect(fmt).toEqual(expected[m]);
    }

    // 資料：兩年 CSV（2026-08-25 之前）接新資料；重疊段逐欄相同
    const old = loadCsv(CSV);
    const fresh = loadCsv(FRESH_CSV);
    const freshByTime = new Map(fresh.map((x) => [x.time, x]));
    const overlap = old.filter((x) => x.time >= SPLICE && x.time < T('2026-09-01T16:22:00'));
    for (const x of overlap) expect(freshByTime.get(x.time)).toEqual(x);
    const m1 = [...old.filter((x) => x.time < SPLICE), ...fresh];
    for (let i = 1; i < m1.length; i++) expect(m1[i]!.time).toBeGreaterThan(m1[i - 1]!.time);
    const b5 = aggregate(m1, 5);
    const a14 = alignPoints(b5, atr(b5, 14));
    log.push(`資料：1m ${m1.length} 根（${new Date(m1[0]!.time * 1000).toISOString()} 起），重疊段 ${overlap.length} 根逐欄相同；5m ${b5.length} 根`);

    // 重現性檢查 2：產品 KAMA 的線＋腳本遲滯 = 產品 KAMA 方向
    const kp = { ...configFromParams({}).trend, algo: 'kama' } as TrendParams;
    const prodKama = ALGORITHMS.kama.compute(b5, kp).dir;
    const mine = swingDir(kamaLine(b5, kp.kamaLength, kp.kamaFast, kp.kamaSlow), a14, kp.kamaHyst);
    expect(mine).toEqual(prodKama);
    log.push('重現 KAMA：腳本遲滯與產品 KAMA 方向逐根相同');

    const days = (p: Period) => new Set(m1.filter((x) => x.time >= PERIODS[p][0] && x.time <= PERIODS[p][1])
        .map((x) => tradingSessionOf('FUT', x.time).key).filter((k) => k.endsWith('D'))).size;
    const dayN = { IS: days('IS'), OOS: days('OOS'), FRESH: days('FRESH') };

    const refs: [string, State[]][] = [
        ['A SuperTrend(10,2)', productDir(b5, { algo: 'supertrend', stMult: 2 })],
        ['A SuperTrend(10,3)', productDir(b5, { algo: 'supertrend', stMult: 3 })],
        ['A SuperTrend(10,4)', productDir(b5, { algo: 'supertrend', stMult: 4 })],
        ['B KAMA 遲滯 0.15', productDir(b5, { algo: 'kama', kamaHyst: 0.15 })],
        ['B KAMA 遲滯 0.3', productDir(b5, { algo: 'kama', kamaHyst: 0.3 })],
        ['B KAMA 遲滯 0.6', productDir(b5, { algo: 'kama', kamaHyst: 0.6 })],
        ['C Donchian(10)+ATR×3', productDir(b5, { algo: 'donchian', dcLength: 10, dcAtrMult: 3 })],
        ['C Donchian(20)+ATR×3', productDir(b5, { algo: 'donchian', dcLength: 20, dcAtrMult: 3 })],
        ['C Donchian(40)+ATR×3', productDir(b5, { algo: 'donchian', dcLength: 40, dcAtrMult: 3 })],
        ['C Donchian(20)+ATR×2', productDir(b5, { algo: 'donchian', dcLength: 20, dcAtrMult: 2 })],
        ['C Donchian(20)+ATR×4', productDir(b5, { algo: 'donchian', dcLength: 20, dcAtrMult: 4 })],
    ];

    const st = (m: number) => withWarmup(stDir(b5, 10, m));
    const { pdi, mdi, adx } = dmi(b5);
    const chop = choppiness(b5);
    const er = efficiency(b5);
    const vb = volumeBars(m1, b5);
    const vbDir = (m: number) => project(vb, stDir(vb, 10, m).map((d, i) => (i < WARMUP ? null : d)), b5);
    const gates = {
        adx: adx.map((x) => (x === undefined ? undefined : x >= 20)),
        chop: chop.map((x) => (x === undefined ? undefined : x < 61.8)),
        er: er.map((x) => (x === undefined ? undefined : x >= 0.3)),
    };
    // [名稱, 狀態, 是否參與判定]
    const cands: [string, State[], boolean][] = [
        ['Keltner(20,2) 突破', withWarmup(keltner(b5)), true],
        ['Bollinger(20,2) 突破', withWarmup(bollinger(b5)), true],
        ['一目 轉換(9)／基準(26) 交叉', withWarmup(ichimokuTk(b5)), true],
        ['DMI(14) 交叉', withWarmup(crossDir(pdi, mdi)), true],
        ['ZLEMA(20)+遲滯', withWarmup(swingDir(zlema(b5), a14, 0.3)), true],
        ['T3(10,0.7)+遲滯', withWarmup(swingDir(t3(b5), a14, 0.3)), true],
        ['ALMA(21,0.85,6)+遲滯', withWarmup(swingDir(alma(b5), a14, 0.3)), true],
        ['SuperSmoother(20)+遲滯', withWarmup(swingDir(superSmoother(b5), a14, 0.3)), true],
    ];
    for (const m of [3, 2, 4]) {
        const judged = m === 3;
        const tag = m === 3 ? '' : `（×${m}，只描述）`;
        cands.push([`ST(10,${m})+ADX 閘門${tag}`, gated(st(m), gates.adx), judged]);
        cands.push([`ST(10,${m})+Choppiness 閘門${tag}`, gated(st(m), gates.chop), judged]);
        cands.push([`ST(10,${m})+效率比閘門${tag}`, gated(st(m), gates.er), judged]);
        cands.push([`量能 K 棒 ST(10,${m})${tag}`, vbDir(m), judged]);
        cands.push([`日夜盤分開 ST(10,${m})${tag}`, sessionSplit(b5, m), judged]);
    }

    const periods: Period[] = ['IS', 'OOS', 'FRESH'];
    const refRows = refs.map(([name, S]) => ({ name, p: Object.fromEntries(periods.map((p) => [p, props(S, b5, PERIODS[p][0], PERIODS[p][1], dayN[p])])) as Record<Period, Props> }));
    const env = Object.fromEntries(periods.map((p) => [p, {
        f3: envelope(refRows.map((r) => ({ lag: r.p[p].lag, v: r.p[p].fail3 }))),
        f6: envelope(refRows.map((r) => ({ lag: r.p[p].lag, v: r.p[p].fail6 }))),
    }])) as Record<Period, { f3: ReturnType<typeof envelope>; f6: ReturnType<typeof envelope> }>;

    const candRows = cands.map(([name, S, judged]) => {
        const p = Object.fromEntries(periods.map((q) => [q, props(S, b5, PERIODS[q][0], PERIODS[q][1], dayN[q])])) as Record<Period, Props>;
        const checks = periods.map((q) => {
            const e3 = env[q].f3.at(p[q].lag);
            const e6 = env[q].f6.at(p[q].lag);
            if (e3 === undefined || e6 === undefined) return { q, e3, e6, ok: false, why: '延遲在範圍外' };
            const ok = q === 'FRESH' ? p[q].fail3 < e3 : p[q].fail3 <= 0.8 * e3 && p[q].fail6 <= e6;
            return { q, e3, e6, ok, why: '' };
        });
        return { name, judged, p, checks, pass: judged && checks.every((c) => c.ok) };
    });

    const f = (x: number | undefined, d = 1) => (x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d));
    let md = '# 結果 9 第一階段：趨勢演算法候選\n\n';
    md += `${log.join('\n\n')}\n\n日盤交易日：IS ${dayN.IS}、OOS ${dayN.OOS}、FRESH ${dayN.FRESH}\n\n`;
    for (const q of periods) {
        md += `## ${q}\n\n參照 Pareto 點（延遲, 3 根失效%）：${env[q].f3.front.map((x) => `(${x.lag}, ${f(x.v)})`).join('、')}；`;
        md += `6 根：${env[q].f6.front.map((x) => `(${x.lag}, ${f(x.v)})`).join('、')}\n\n`;
        md += '| 演算法 | 訊號/日 | 3 根內失效% | 6 根內失效% | 延遲中位 | 段長中位 | 包絡 3 根 | 包絡 6 根 | 本段 |\n|---|---|---|---|---|---|---|---|---|\n';
        for (const r of refRows) md += `| ${r.name} | ${f(r.p[q].perDay, 2)} | ${f(r.p[q].fail3)} | ${f(r.p[q].fail6)} | ${r.p[q].lag} | ${r.p[q].seg} | | | 參照 |\n`;
        for (const r of candRows) {
            const c = r.checks.find((x) => x.q === q)!;
            md += `| ${r.name} | ${f(r.p[q].perDay, 2)} | ${f(r.p[q].fail3)} | ${f(r.p[q].fail6)} | ${r.p[q].lag} | ${r.p[q].seg} | ${f(c.e3)} | ${f(c.e6)} | ${r.judged ? (c.ok ? '成立' : c.why || '不成立') : '—'} |\n`;
        }
        md += '\n';
    }
    md += '## 判定\n\n| 候選 | IS | OOS | FRESH | 結果 |\n|---|---|---|---|---|\n';
    for (const r of candRows.filter((x) => x.judged)) {
        md += `| ${r.name} | ${r.checks.map((c) => (c.ok ? '成立' : c.why || '不成立')).join(' | ')} | ${r.pass ? '**通過**' : '不通過'} |\n`;
    }
    // 事後補充（看到判定之後才加，不改判定）：通過的候選落在參照點的空檔時，延伸 B 的遲滯看 KAMA 能否填滿空檔
    const extra: [string, State[]][] = [
        ['B KAMA 遲滯 0.05（事後補充）', productDir(b5, { algo: 'kama', kamaHyst: 0.05 })],
        ['B KAMA 遲滯 0.1（事後補充）', productDir(b5, { algo: 'kama', kamaHyst: 0.1 })],
    ];
    md += '\n## 事後補充（不改判定）\n\n通過的候選延遲落在參照點空檔時，延伸 B 的遲滯描述 KAMA 在同一段的位置。\n\n';
    md += '| 演算法 | 期間 | 訊號/日 | 3 根內失效% | 6 根內失效% | 延遲中位 | 段長中位 |\n|---|---|---|---|---|---|---|\n';
    for (const [name, S] of [...extra, ...cands.filter(([n]) => candRows.find((r) => r.name === n)?.pass).map(([n, S]) => [n, S] as [string, State[]])]) {
        for (const q of periods) {
            const r = props(S, b5, PERIODS[q][0], PERIODS[q][1], dayN[q]);
            md += `| ${name} | ${q} | ${f(r.perDay, 2)} | ${f(r.fail3)} | ${f(r.fail6)} | ${r.lag} | ${r.seg} |\n`;
        }
    }
    writeFileSync(`${OUT}/trend-candidates.md`, md);
    writeFileSync(`${OUT}/trend-candidates.json`, JSON.stringify({ days: dayN, refs: refRows, cands: candRows.map(({ name, judged, p, checks, pass }) => ({ name, judged, p, checks, pass })), envelope: Object.fromEntries(periods.map((q) => [q, { f3: env[q].f3.front, f6: env[q].f6.front }])), volumeBars: vb.length }, null, 2));
});
