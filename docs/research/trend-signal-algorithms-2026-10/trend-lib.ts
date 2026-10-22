// 結果 9、10 共用：資料載入、5m 狀態的指標性質、參照包絡與常用指標。不是測試檔（vitest 只收 *.char.ts）。
import { readFileSync } from 'node:fs';
import { atr, supertrend } from '../../../src/lib/indicators';
import { aggregate, wallClockToUtc } from '../../../src/lib/utils/kbars';
import { tradingSessionOf } from '../../../src/lib/trend-signal/core/session';
import { alignPoints } from '../../../src/lib/trend-signal/core/bars';
import { ALGORITHMS } from '../../../src/lib/trend-signal/trend/algorithms';
import { configFromParams } from '../../../src/lib/trend-signal/config';
import type { TrendParams } from '../../../src/lib/trend-signal/types';
import type { Candle } from '../../../src/lib/types/market';

export const T = wallClockToUtc;
export const SPLICE = T('2026-08-25T00:00:00');
export const PERIODS = {
    IS: [T('2024-09-01T00:00:00'), T('2025-08-31T23:59:59')],
    OOS: [T('2025-09-01T00:00:00'), T('2026-09-01T23:59:59')],
    FRESH: [T('2026-09-02T00:00:00'), T('2026-10-21T23:59:59')],
} as const;
export type Period = keyof typeof PERIODS;
export const PERIOD_LIST: Period[] = ['IS', 'OOS', 'FRESH'];
export const WARMUP = 150; // 新候選一律 150 根 5m（同 A、B 的預設暖身）

export type State = 1 | -1 | 0 | null; // LONG／SHORT／NEUTRAL／未知

export function loadCsv(path: string, from = -Infinity, to = Infinity): Candle[] {
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

/** 兩年 CSV（2026-08-25 之前）接新資料；舊 CSV 在重疊段的每一根都須在新資料裡且逐欄相同、時間嚴格遞增（不符就丟錯）。
 *  新資料在重疊段多出的根（舊 CSV 缺每月 31 日）以 freshOnly 回報。 */
export function loadSpliced(csv: string, freshCsv: string) {
    const old = loadCsv(csv);
    const fresh = loadCsv(freshCsv);
    const freshByTime = new Map(fresh.map((x) => [x.time, x]));
    const overlapEnd = T('2026-09-01T16:22:00');
    const overlap = old.filter((x) => x.time >= SPLICE && x.time < overlapEnd);
    const same = (a: Candle, b: Candle | undefined) => !!b && a.open === b.open && a.high === b.high && a.low === b.low
        && a.close === b.close && a.volume === b.volume;
    for (const x of overlap) if (!same(x, freshByTime.get(x.time))) throw new Error(`重疊段 ${x.time} 與新資料不同`);
    const oldTimes = new Set(overlap.map((x) => x.time));
    const freshOnly = fresh.filter((x) => x.time >= SPLICE && x.time < overlapEnd && !oldTimes.has(x.time)).length;
    const m1 = [...old.filter((x) => x.time < SPLICE), ...fresh];
    for (let i = 1; i < m1.length; i++) if (m1[i]!.time <= m1[i - 1]!.time) throw new Error(`時間未遞增：${m1[i]!.time}`);
    const b5 = aggregate(m1, 5);
    const a14 = alignPoints(b5, atr(b5, 14));
    const days = (p: Period) => new Set(m1.filter((x) => x.time >= PERIODS[p][0] && x.time <= PERIODS[p][1])
        .map((x) => tradingSessionOf('FUT', x.time).key).filter((k) => k.endsWith('D'))).size;
    const dayN = { IS: days('IS'), OOS: days('OOS'), FRESH: days('FRESH') } as Record<Period, number>;
    return { m1, b5, a14, overlap: overlap.length, freshOnly, dayN };
}

/** 5m K 棒（收盤 label）的時段：用桶內第一根 1m（label − 4 分）判定 */
export const session5 = (label: number) => tradingSessionOf('FUT', label - 240);

export const median = (xs: number[]) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
export const pct = (n: number, d: number) => (d ? (100 * n) / d : NaN);

// ---- 指標性質（事前規則 9.0）----

/** n＝訊號數；observed＝之後還有 6 根可觀察的訊號（失效率的分母，資料尾端右設限的不算） */
export interface Props { n: number; observed: number; perDay: number; fail3: number; fail6: number; lag: number; seg: number }

export function props(S: State[], b: Candle[], from: number, to: number, days: number): Props {
    let n = 0, observed = 0, f3 = 0, f6 = 0;
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
            if (j + 6 < S.length) observed++;
            let leave = -1;
            for (let k = j + 1; k < S.length; k++) {
                if (S[k] !== null && S[k] !== c) {
                    leave = k;
                    break;
                }
            }
            if (leave >= 0) {
                if (leave - j <= 3 && j + 6 < S.length) f3++;
                if (leave - j <= 6 && j + 6 < S.length) f6++;
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
    return { n, observed, perDay: n / days, fail3: pct(f3, observed), fail6: pct(f6, observed), lag: median(lag), seg: median(seg) };
}

// 下包絡：Pareto 點（沒有其他點延遲不更長、失效不更高），相鄰點線性內插；範圍外為 undefined
export function envelope(points: { lag: number; v: number }[]) {
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
export type Envelope = ReturnType<typeof envelope>;

export function productDir(b5: Candle[], over: Partial<TrendParams>): State[] {
    const p = { ...configFromParams({}).trend, ...over } as TrendParams;
    const algo = ALGORITHMS[p.algo];
    const warm = algo.warmup(p);
    return algo.compute(b5, p).dir.map((d, i) => (i < warm ? null : d));
}

/** 參照線：現有核心與結果 6.1 的敏感度設定，共 11 點 */
export function referenceSet(b5: Candle[]): [string, State[]][] {
    return [
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
}

export function propsByPeriod(S: State[], b5: Candle[], dayN: Record<Period, number>): Record<Period, Props> {
    return Object.fromEntries(PERIOD_LIST.map((p) => [p, props(S, b5, PERIODS[p][0], PERIODS[p][1], dayN[p])])) as Record<Period, Props>;
}

export function envelopes(refRows: { p: Record<Period, Props> }[]): Record<Period, { f3: Envelope; f6: Envelope }> {
    return Object.fromEntries(PERIOD_LIST.map((p) => [p, {
        f3: envelope(refRows.map((r) => ({ lag: r.p[p].lag, v: r.p[p].fail3 }))),
        f6: envelope(refRows.map((r) => ({ lag: r.p[p].lag, v: r.p[p].fail6 }))),
    }])) as Record<Period, { f3: Envelope; f6: Envelope }>;
}

/** 一段期間的判定（9.0）：FRESH 只要求 3 根低於包絡；其他段 3 根至少低 20% 且 6 根不高於包絡 */
export function check(q: Period, p: Props, env: { f3: Envelope; f6: Envelope }) {
    const e3 = env.f3.at(p.lag);
    const e6 = env.f6.at(p.lag);
    if (e3 === undefined || (q !== 'FRESH' && e6 === undefined)) return { q, e3, e6, ok: false, why: '延遲在範圍外' };
    const ok = q === 'FRESH' ? p.fail3 < e3 : p.fail3 <= 0.8 * e3 && p.fail6 <= e6!;
    return { q, e3, e6, ok, why: '' };
}

// ---- 常用指標 ----

export const closes = (b: Candle[]) => b.map((x) => x.close);
export function emaArr(xs: (number | undefined)[], n: number): (number | undefined)[] {
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
export function rma(xs: number[], n: number): (number | undefined)[] {
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
export const trueRange = (b: Candle[]) => b.map((x, i) => (i === 0 ? x.high - x.low
    : Math.max(x.high - x.low, Math.abs(x.high - b[i - 1]!.close), Math.abs(x.low - b[i - 1]!.close))));

export function withWarmup(dir: State[]): State[] {
    return dir.map((d, i) => (i < WARMUP ? null : d));
}

/** 產品 KAMA 的擺動遲滯：線從高點回落（低點回升）h × ATR14 才翻轉；第一個可用點以線的走向決定初始方向 */
export function swingDir(line: (number | undefined)[], a14: (number | undefined)[], h: number): State[] {
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

export function stDir(b: Candle[], p: number, m: number): State[] {
    const r = supertrend(b, p, m);
    return b.map((_, i) => (r.up[i]?.value !== undefined ? 1 : r.down[i]?.value !== undefined ? -1 : null));
}

export function rolling(b: Candle[], n: number, f: (w: Candle[]) => number): (number | undefined)[] {
    return b.map((_, i) => (i < n - 1 ? undefined : f(b.slice(i - n + 1, i + 1))));
}
export const hh = (w: Candle[]) => Math.max(...w.map((x) => x.high));
export const ll = (w: Candle[]) => Math.min(...w.map((x) => x.low));

export function dmi(b: Candle[], n = 14) {
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
    const di = (s: (number | undefined)[], i: number) => (tr[i] === undefined ? undefined : tr[i]! > 0 ? (100 * s[i]!) / tr[i]! : 0);
    const pdi = b.map((_, i) => di(sp, i));
    const mdi = b.map((_, i) => di(sm, i));
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

export function choppiness(b: Candle[], n = 14): (number | undefined)[] {
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

export function efficiency(b: Candle[], n = 10): (number | undefined)[] {
    return b.map((x, i) => {
        if (i < n) return undefined;
        let vol = 0;
        for (let j = i - n + 1; j <= i; j++) vol += Math.abs(b[j]!.close - b[j - 1]!.close);
        return vol > 0 ? Math.abs(x.close - b[i - n]!.close) / vol : 0;
    });
}

/** 判斷打開時輸出核心方向，關閉時 NEUTRAL */
export function gated(dir: State[], open: (boolean | undefined)[]): State[] {
    return dir.map((d, i) => (d === null || open[i] === undefined ? null : open[i] ? d : 0));
}

/** 收盤的滾動平均與母體標準差（Bollinger 用） */
export function closeMeanSd(b: Candle[], n = 20) {
    const mean = rolling(b, n, (w) => w.reduce((s, x) => s + x.close, 0) / w.length);
    const sd = rolling(b, n, (w) => {
        const m = w.reduce((s, x) => s + x.close, 0) / w.length;
        return Math.sqrt(w.reduce((s, x) => s + (x.close - m) ** 2, 0) / w.length);
    });
    return { mean, sd };
}

export const fmt = (x: number | undefined, d = 1) => (x === undefined || Number.isNaN(x) ? '—' : x.toFixed(d));
