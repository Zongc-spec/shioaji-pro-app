// 一次性研究量測（不在 CI 執行）：在真實 TMF 1m 上量測候選趨勢演算法的
// 訊號特性，以及 5m 趨勢切換後各種 1m 進場時機的差異。只量測指標行為，
// 不含手續費、不模擬策略損益。初版量測於 commit d05e7e9；模組搬移後改用新路徑，結果逐欄相同。
//
//   D=docs/research/trend-signal-algorithms-2026-10
//   TSP_CHAR_CSV=<datetime,open,high,low,close,volume 的 1m CSV> TSP_CHAR_OUT=<輸出目錄> \
//   npx vitest run --config "$PWD/$D/vitest.config.mjs" --root "$D"
//
// CSV 的 datetime 為台灣時間的 1m 收盤 label（與 shioaji kbars 相同）。資料不進 repo。
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { atr, ema, sar, supertrend, wma } from '../../../src/lib/indicators';
import { aggregate, wallClockToUtc } from '../../../src/lib/utils/kbars';
import { tradingSessionOf } from '../../../src/lib/trend-signal/core/session';
import { alignPoints } from '../../../src/lib/trend-signal/core/bars';
import { evalSetup, kdIndicators } from '../../../src/lib/trend-signal/trigger/pullback-kd';
import type { Candle } from '../../../src/lib/types/market';

const CSV = process.env.TSP_CHAR_CSV ?? '';
const OUT = process.env.TSP_CHAR_OUT ?? tmpdir();
const FROM = wallClockToUtc('2025-09-01T00:00:00');
const TO = wallClockToUtc('2026-09-01T23:59:59');
const WARM = 200;

type Dir = number[]; // 1 / -1 / 0（未知）
interface Ev { i: number; d: 1 | -1 }

function load(): Candle[] {
    if (!CSV) throw new Error('請以 TSP_CHAR_CSV 指定 1m CSV 路徑');
    const out: Candle[] = [];
    const lines = readFileSync(CSV, 'utf8').split('\n');
    for (let k = 1; k < lines.length; k++) {
        const line = lines[k];
        if (!line) continue;
        const [dt, o, h, l, c, v] = line.split(',');
        const t = wallClockToUtc(dt!);
        if (t < FROM || t > TO) continue;
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

// ---- 候選趨勢演算法（皆只用當根以前的 K 棒）----

function stDir(b: Candle[], p: number, m: number): Dir {
    const r = supertrend(b, p, m);
    return b.map((_, i) => (r.up[i]!.value !== undefined ? 1 : r.down[i]!.value !== undefined ? -1 : 0));
}

function chandelierDir(b: Candle[], n = 22, k = 3): Dir {
    const a = alignPoints(b, atr(b, n));
    const dir: Dir = [];
    let ls = Number.NaN;
    let ss = Number.NaN;
    let d = 1;
    for (let i = 0; i < b.length; i++) {
        const av = a[i];
        if (av === undefined || i < n - 1) {
            dir.push(0);
            continue;
        }
        let hh = -Infinity;
        let ll = Infinity;
        for (let j = i - n + 1; j <= i; j++) {
            hh = Math.max(hh, b[j]!.high);
            ll = Math.min(ll, b[j]!.low);
        }
        let l = hh - k * av;
        let s = ll + k * av;
        const pc = b[i - 1]!.close;
        if (!Number.isNaN(ls) && pc > ls) l = Math.max(l, ls);
        if (!Number.isNaN(ss) && pc < ss) s = Math.min(s, ss);
        const c = b[i]!.close;
        if (!Number.isNaN(ss) && c > ss) d = 1;
        else if (!Number.isNaN(ls) && c < ls) d = -1;
        dir.push(Number.isNaN(ls) ? 0 : d);
        ls = l;
        ss = s;
    }
    return dir;
}

// LeBeau 原始概念：只有生效的那一側停損棘輪；收盤穿越生效側才翻轉
function chandelierActiveDir(b: Candle[], n = 22, k = 3): Dir {
    const a = alignPoints(b, atr(b, n));
    const dir: Dir = [];
    let d = 0;
    let stop = Number.NaN;
    for (let i = 0; i < b.length; i++) {
        const av = a[i];
        if (av === undefined || i < n - 1) {
            dir.push(0);
            continue;
        }
        let hh = -Infinity;
        let ll = Infinity;
        for (let j = i - n + 1; j <= i; j++) {
            hh = Math.max(hh, b[j]!.high);
            ll = Math.min(ll, b[j]!.low);
        }
        const c = b[i]!.close;
        if (d === 0) {
            d = 1;
            stop = hh - k * av;
        } else if (d === 1) {
            if (c < stop) {
                d = -1;
                stop = ll + k * av;
            } else stop = Math.max(stop, hh - k * av);
        } else if (c > stop) {
            d = 1;
            stop = hh - k * av;
        } else stop = Math.min(stop, ll + k * av);
        dir.push(d);
    }
    return dir;
}

function kamaLine(b: Candle[], n = 10, fast = 2, slow = 30): (number | undefined)[] {
    const fc = 2 / (fast + 1);
    const sc = 2 / (slow + 1);
    const out: (number | undefined)[] = [];
    let k = b[0]?.close ?? 0;
    for (let i = 0; i < b.length; i++) {
        const c = b[i]!.close;
        if (i < n) {
            k = c;
            out.push(undefined);
            continue;
        }
        const change = Math.abs(c - b[i - n]!.close);
        let vol = 0;
        for (let j = i - n + 1; j <= i; j++) vol += Math.abs(b[j]!.close - b[j - 1]!.close);
        const er = vol > 0 ? change / vol : 0;
        const s2 = (er * (fc - sc) + sc) ** 2;
        k = k + s2 * (c - k);
        out.push(k);
    }
    return out;
}

// KAMA 線的擺動遲滯：從線的高（低）點回落（回升）h × ATR 才翻轉
function kamaDir(b: Candle[], h = 0.3): Dir {
    const kl = kamaLine(b);
    const a = alignPoints(b, atr(b, 14));
    const dir: Dir = [];
    let d = 0;
    let hi = 0;
    let lo = 0;
    for (let i = 0; i < b.length; i++) {
        const k = kl[i];
        const av = a[i];
        if (k === undefined || av === undefined) {
            dir.push(0);
            continue;
        }
        if (d === 0) {
            d = 1;
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
        dir.push(d);
    }
    return dir;
}

function donchianDir(b: Candle[], n = 20): Dir {
    const dir: Dir = [];
    let d = 0;
    for (let i = 0; i < b.length; i++) {
        if (i < n) {
            dir.push(0);
            continue;
        }
        let hh = -Infinity;
        let ll = Infinity;
        for (let j = i - n; j < i; j++) {
            hh = Math.max(hh, b[j]!.high);
            ll = Math.min(ll, b[j]!.low);
        }
        const c = b[i]!.close;
        if (c > hh) d = 1;
        else if (c < ll) d = -1;
        dir.push(d);
    }
    return dir;
}

function emaCrossDir(b: Candle[], f = 9, s = 21): Dir {
    const a = alignPoints(b, ema(b, f));
    const c = alignPoints(b, ema(b, s));
    return b.map((_, i) => (a[i] === undefined || c[i] === undefined ? 0 : a[i]! > c[i]! ? 1 : -1));
}

function psarDir(b: Candle[]): Dir {
    const v = alignPoints(b, sar(b, 0.02, 0.2));
    return b.map((x, i) => (v[i] === undefined ? 0 : v[i]! < x.close ? 1 : -1));
}

function hmaDir(b: Candle[], n = 21): Dir {
    const asBars = (vals: (number | undefined)[]) => b.map((x, i) => ({ ...x, close: vals[i] ?? Number.NaN }));
    const half = alignPoints(b, wma(b, Math.floor(n / 2)));
    const full = alignPoints(b, wma(b, n));
    const raw = b.map((_, i) => (half[i] === undefined || full[i] === undefined ? undefined : 2 * half[i]! - full[i]!));
    const firstOk = raw.findIndex((x) => x !== undefined);
    const sq = Math.round(Math.sqrt(n));
    const sub = asBars(raw).slice(firstOk);
    const h = alignPoints(sub, wma(sub, sq));
    const hma: (number | undefined)[] = b.map((_, i) => (i < firstOk ? undefined : h[i - firstOk]));
    return b.map((_, i) => (i < 1 || hma[i] === undefined || hma[i - 1] === undefined ? 0 : hma[i]! > hma[i - 1]! ? 1 : -1));
}

function ensembleDir(dirs: Dir[]): Dir {
    return dirs[0]!.map((_, i) => {
        if (dirs.some((d) => d[i] === 0)) return 0;
        const s = dirs.reduce((acc, d) => acc + d[i]!, 0);
        return s > 0 ? 1 : -1;
    });
}

function eventsOf(dir: Dir): Ev[] {
    const ev: Ev[] = [];
    for (let i = Math.max(1, WARM); i < dir.length; i++) {
        const a = dir[i - 1]!;
        const c = dir[i]!;
        if (a !== 0 && c !== 0 && a !== c) ev.push({ i, d: c as 1 | -1 });
    }
    return ev;
}

// 規格 §1.1 的複合條件（ST + EMA21 + 斜率），三態；轉入 LONG/SHORT 為事件
function compositeEvents(b: Candle[]): Ev[] {
    const st = stDir(b, 10, 3);
    const e = alignPoints(b, ema(b, 21));
    const state = b.map((x, i) => {
        if (st[i] === 0 || e[i] === undefined || i < 2 || e[i - 2] === undefined) return 0;
        if (st[i] === 1 && x.close > e[i]! && e[i]! > e[i - 2]!) return 1;
        if (st[i] === -1 && x.close < e[i]! && e[i]! < e[i - 2]!) return -1;
        return 2; // NEUTRAL
    });
    const ev: Ev[] = [];
    for (let i = Math.max(1, WARM); i < b.length; i++) {
        const a = state[i - 1]!;
        const c = state[i]!;
        if (a !== 0 && (c === 1 || c === -1) && a !== c) ev.push({ i, d: c as 1 | -1 });
    }
    return ev;
}

interface Metrics {
    n: number;
    perDay: number;
    whipsaw3: number;
    whipsaw6: number;
    segBars: number;
    lagBars: number;
    givebackAtr: number;
    mfeAtr: number;
    mfeOver1: number;
    repeatPct: number;
}

// 每筆事件的下一個／上一個反向事件（O(n) 預算）
function oppIndex(ev: Ev[]): { next: number[]; prev: number[] } {
    const next = new Array<number>(ev.length).fill(-1);
    const prev = new Array<number>(ev.length).fill(-1);
    for (let k = ev.length - 2; k >= 0; k--) {
        next[k] = ev[k + 1]!.d !== ev[k]!.d ? k + 1 : next[k + 1]!;
    }
    for (let k = 1; k < ev.length; k++) {
        prev[k] = ev[k - 1]!.d !== ev[k]!.d ? k - 1 : prev[k - 1]!;
    }
    return { next, prev };
}

function metrics(b: Candle[], ev: Ev[], a14: (number | undefined)[], days: number, from = 0, to = Infinity): Metrics {
    const opp = oppIndex(ev);
    let w3 = 0;
    let w6 = 0;
    let n = 0;
    const seg: number[] = [];
    const lag: number[] = [];
    const give: number[] = [];
    const mfe: number[] = [];
    let over1 = 0;
    let mfeN = 0;
    let repeat = 0;
    for (let k = 0; k < ev.length; k++) {
        const e = ev[k]!;
        const t = b[e.i]!.time;
        if (t < from || t > to) continue;
        n++;
        if (k > 0 && ev[k - 1]!.d === e.d) repeat++;
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
            for (let j = prevOpp.i + 1; j <= e.i; j++) {
                if (e.d === 1 ? b[j]!.low < b[ie]!.low : b[j]!.high > b[ie]!.high) ie = j;
            }
            lag.push(e.i - ie);
            give.push((e.d === 1 ? b[e.i]!.close - b[ie]!.low : b[ie]!.high - b[e.i]!.close) / av);
        }
        if (nextOpp) {
            let best = 0;
            for (let j = e.i + 1; j <= end; j++) {
                best = Math.max(best, e.d === 1 ? b[j]!.high - b[e.i]!.close : b[e.i]!.close - b[j]!.low);
            }
            mfe.push(best / av);
            mfeN++;
            if (best / av > 1) over1++;
        }
    }
    return {
        n,
        perDay: n / days,
        whipsaw3: pct(w3, n),
        whipsaw6: pct(w6, n),
        segBars: median(seg),
        lagBars: median(lag),
        givebackAtr: median(give),
        mfeAtr: median(mfe),
        mfeOver1: pct(over1, mfeN),
        repeatPct: pct(repeat, n),
    };
}

test('trend algorithm + trigger timing characterization (TMF, read-only)', () => {
    const m1 = load();
    const b5 = aggregate(m1, 5);
    const a14 = alignPoints(b5, atr(b5, 14));
    const dayKeys = new Set(m1.map((x) => tradingSessionOf('FUT', x.time).key).filter((k) => k.endsWith('D')));
    const days = dayKeys.size;
    const mid = wallClockToUtc('2026-03-01T00:00:00');
    const dayKeysH1 = [...dayKeys].filter((k) => k < '2026-03-01').length;
    const dayKeysH2 = days - dayKeysH1;

    const st3 = stDir(b5, 10, 3);
    const ch = chandelierDir(b5);
    const km = kamaDir(b5);
    const algos: [string, Ev[]][] = [
        ['SuperTrend(10,2)', eventsOf(stDir(b5, 10, 2))],
        ['SuperTrend(10,3)', eventsOf(st3)],
        ['SuperTrend(10,4)', eventsOf(stDir(b5, 10, 4))],
        ['規格複合 ST+EMA21 斜率', compositeEvents(b5)],
        ['Chandelier(22,3) 雙邊棘輪', eventsOf(ch)],
        ['Chandelier(22,3) 生效側棘輪', eventsOf(chandelierActiveDir(b5))],
        ['KAMA(10,2,30)+0.3ATR 遲滯', eventsOf(km)],
        ['Donchian(20) 突破', eventsOf(donchianDir(b5))],
        ['EMA 9/21 交叉', eventsOf(emaCrossDir(b5))],
        ['Parabolic SAR(0.02,0.2)', eventsOf(psarDir(b5))],
        ['HMA(21) 斜率', eventsOf(hmaDir(b5))],
        ['投票 ST+Chandelier+KAMA', eventsOf(ensembleDir([st3, ch, km]))],
    ];
    const rows = algos.map(([name, ev]) => ({
        name,
        all: metrics(b5, ev, a14, days),
        h1: metrics(b5, ev, a14, dayKeysH1, 0, mid - 1),
        h2: metrics(b5, ev, a14, dayKeysH2, mid, Infinity),
    }));

    // ---- 1m 進場時機（以 SuperTrend(10,3) 5m 切換為主訊號）----
    const session1 = m1.map((x) => tradingSessionOf('FUT', x.time).key);
    const ind = kdIndicators(m1, session1);
    const st1 = stDir(m1, 10, 3);
    const r5 = supertrend(b5, 10, 3);
    const line5 = b5.map((_, i) => r5.up[i]!.value ?? r5.down[i]!.value);
    const idx1 = new Map(m1.map((x, i) => [x.time, i]));
    const firstAfter = (t: number) => {
        let lo = 0;
        let hi = m1.length - 1;
        let ans = -1;
        while (lo <= hi) {
            const midI = (lo + hi) >> 1;
            if (m1[midI]!.time > t) {
                ans = midI;
                hi = midI - 1;
            } else lo = midI + 1;
        }
        return ans;
    };
    const ev5 = eventsOf(st3);
    const opp5 = oppIndex(ev5);
    const mfeOf = (k: number) => {
        const e = ev5[k]!;
        const end = opp5.next[k]! >= 0 ? ev5[opp5.next[k]!]!.i : b5.length - 1;
        let best = 0;
        for (let j = e.i + 1; j <= end; j++) best = Math.max(best, e.d === 1 ? b5[j]!.high - b5[e.i]!.close : b5[e.i]!.close - b5[j]!.low);
        return best;
    };
    type TrigName = 'T0 立即' | 'T1 1m 同向' | 'T2 回檔趨勢線' | 'T3 突破訊號 K' | 'T4 EMA9/VWAP/KD'
        | 'T5 限價回檔0.25ATR→逾時市價' | 'T5 限價回檔0.5ATR→逾時市價' | 'T6 限價回檔0.5ATR（不追）';
    const names: TrigName[] = ['T0 立即', 'T1 1m 同向', 'T2 回檔趨勢線', 'T3 突破訊號 K', 'T4 EMA9/VWAP/KD',
        'T5 限價回檔0.25ATR→逾時市價', 'T5 限價回檔0.5ATR→逾時市價', 'T6 限價回檔0.5ATR（不追）'];
    const acc = new Map<TrigName, { fill: number; delay: number[]; impr: number[]; bigImpr: number[]; mae: number[]; bigMissed: number; limitHits: number }>();
    for (const n of names) acc.set(n, { fill: 0, delay: [], impr: [], bigImpr: [], mae: [], bigMissed: 0, limitHits: 0 });
    let total = 0;
    let big = 0;
    for (let k5 = 0; k5 < ev5.length; k5++) {
        const e = ev5[k5]!;
        const L = b5[e.i]!.time;
        const av = a14[e.i];
        if (av === undefined || av <= 0) continue;
        const f = firstAfter(L);
        if (f < 1) continue;
        const lastMin = m1[idx1.get(L) ?? f - 1]!.time;
        const sess = tradingSessionOf('FUT', lastMin);
        const wEnd = Math.min(L + 900, sess.end);
        total++;
        const isBig = mfeOf(k5) > 3 * av;
        if (isBig) big++;
        // 觸發 K 棒 m（收盤確認）→ 下一根開盤進場（須同一盤）
        const entryAfter = (m: number) => {
            const n = m + 1;
            if (n >= m1.length || session1[n] !== session1[m]) return -1;
            return n;
        };
        const at = new Map<TrigName, number>();
        // T0：訊號收盤後第一根 1m 開盤（仍在本盤且在窗口內）
        if (m1[f]!.time <= wEnd) at.set('T0 立即', f);
        const sig = b5[e.i]!;
        const iL = idx1.get(L);
        if (iL !== undefined && st1[iL] === e.d && m1[f]!.time <= wEnd) at.set('T1 1m 同向', f);
        for (let m = f; m < m1.length && m1[m]!.time <= wEnd; m++) {
            const bar = m1[m]!;
            if (!at.has('T1 1m 同向') && st1[m] === e.d) {
                const n = entryAfter(m);
                if (n >= 0) at.set('T1 1m 同向', n);
            }
            const j5 = (() => {
                let j = e.i;
                while (j + 1 < b5.length && b5[j + 1]!.time <= bar.time) j++;
                return j;
            })();
            const ln = line5[j5];
            if (!at.has('T2 回檔趨勢線') && ln !== undefined && st3[j5] === e.d) {
                const near = e.d === 1 ? bar.low <= ln + 0.5 * av : bar.high >= ln - 0.5 * av;
                const resume = e.d === 1 ? bar.close > bar.open : bar.close < bar.open;
                if (near && resume) {
                    const n = entryAfter(m);
                    if (n >= 0) at.set('T2 回檔趨勢線', n);
                }
            }
            if (!at.has('T3 突破訊號 K') && (e.d === 1 ? bar.close > sig.high : bar.close < sig.low)) {
                const n = entryAfter(m);
                if (n >= 0) at.set('T3 突破訊號 K', n);
            }
            if (!at.has('T4 EMA9/VWAP/KD')) {
                const ev = evalSetup(m1, ind, m, e.d === 1 ? 'LONG' : 'SHORT');
                if (ev.stage === 'READY' && !ev.chase) {
                    const n = entryAfter(m);
                    if (n >= 0) at.set('T4 EMA9/VWAP/KD', n);
                }
            }
        }
        // T5/T6：訊號收盤價往有利方向 x × ATR(5m) 掛限價，窗口內觸價即成交（開盤已越過以開盤價）；
        // T5 逾時改下一根開盤市價，T6 逾時放棄
        const limitPx = new Map<TrigName, number>();
        const limitFill = (x: number, fallback: boolean): [number, number, number] | undefined => {
            const limit = sig.close - e.d * x * av;
            for (let m = f; m < m1.length && m1[m]!.time <= wEnd; m++) {
                const bar = m1[m]!;
                if (session1[m] !== session1[f]) break;
                if (e.d === 1 ? bar.low <= limit : bar.high >= limit) {
                    return [m, e.d === 1 ? Math.min(limit, bar.open) : Math.max(limit, bar.open), 1];
                }
            }
            if (!fallback) return undefined;
            const n = firstAfter(wEnd);
            if (n < 0 || session1[n] !== session1[f]) return undefined;
            return [n, m1[n]!.open, 0];
        };
        for (const [name, x, fb] of [['T5 限價回檔0.25ATR→逾時市價', 0.25, true], ['T5 限價回檔0.5ATR→逾時市價', 0.5, true], ['T6 限價回檔0.5ATR（不追）', 0.5, false]] as [TrigName, number, boolean][]) {
            const r = limitFill(x, fb);
            if (r) {
                at.set(name, r[0]);
                limitPx.set(name, r[1]);
                if (r[2]) acc.get(name)!.limitHits++;
            }
        }
        const p0i = at.get('T0 立即');
        for (const n of names) {
            const a = acc.get(n)!;
            const ei = at.get(n);
            if (ei === undefined) {
                if (isBig) a.bigMissed++;
                continue;
            }
            a.fill++;
            const px = limitPx.get(n) ?? m1[ei]!.open;
            a.delay.push((m1[ei]!.time - 60 - L) / 60);
            if (p0i !== undefined) {
                const imp = (e.d * (m1[p0i]!.open - px)) / av;
                a.impr.push(imp);
                if (isBig) a.bigImpr.push(imp);
            }
            let worst = 0;
            for (let j = ei; j < Math.min(m1.length, ei + 30); j++) {
                worst = Math.max(worst, e.d === 1 ? px - m1[j]!.low : m1[j]!.high - px);
            }
            a.mae.push(worst / av);
        }
    }
    const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
    const p10 = (xs: number[]) => {
        if (!xs.length) return NaN;
        const s = [...xs].sort((x, y) => x - y);
        return s[Math.floor(0.1 * (s.length - 1))]!;
    };
    const trig = names.map((n) => {
        const a = acc.get(n)!;
        return {
            name: n,
            fillPct: pct(a.fill, total),
            limitPct: pct(a.limitHits, total),
            delayMin: median(a.delay),
            improveAtr: median(a.impr),
            improveMean: mean(a.impr),
            improveP10: p10(a.impr),
            bigImproveMean: mean(a.bigImpr),
            mae30Atr: median(a.mae),
            bigMissedPct: pct(a.bigMissed, big),
        };
    });

    const atrPts = a14.filter((x): x is number => x !== undefined);
    const atrH1 = a14.filter((x, i) => x !== undefined && b5[i]!.time < mid) as number[];
    const atrH2 = a14.filter((x, i) => x !== undefined && b5[i]!.time >= mid) as number[];
    writeFileSync(`${OUT}/atr.txt`, `ATR14(5m) median points: all ${median(atrPts).toFixed(1)}, H1 ${median(atrH1).toFixed(1)}, H2 ${median(atrH2).toFixed(1)}; price ${b5[0]!.close} -> ${b5[b5.length - 1]!.close}`);
    const report = {
        source: CSV,
        period: '2025-09-01 .. 2026-09-01',
        rows1m: m1.length,
        bars5m: b5.length,
        tradingDays: days,
        algos: rows,
        trigger: { base: 'SuperTrend(10,3) 5m', signals: total, bigMoveSignals: big, rows: trig },
    };
    writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));
    const f1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : '—');
    const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '—');
    let md = `period ${report.period}; 1m=${m1.length}; 5m=${b5.length}; days=${days}\n\n`;
    md += '| 演算法 | 訊號/日 | 3 根內反轉% | 6 根內反轉% | 段長中位(根) | 延遲中位(根) | 回吐中位(ATR) | 順向中位(ATR) | 順向>1ATR% | 同向重複% | H1 訊號/日 | H2 訊號/日 | H1 3根反轉% | H2 3根反轉% |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
    for (const r of rows) {
        md += `| ${r.name} | ${f2(r.all.perDay)} | ${f1(r.all.whipsaw3)} | ${f1(r.all.whipsaw6)} | ${f1(r.all.segBars)} | ${f1(r.all.lagBars)} | ${f2(r.all.givebackAtr)} | ${f2(r.all.mfeAtr)} | ${f1(r.all.mfeOver1)} | ${f1(r.all.repeatPct)} | ${f2(r.h1.perDay)} | ${f2(r.h2.perDay)} | ${f1(r.h1.whipsaw3)} | ${f1(r.h2.whipsaw3)} |\n`;
    }
    md += `\n訊號 ${total}；大行情（順向 > 3 ATR）${big}\n\n| 進場時機 | 成交率% | 限價成交% | 延遲中位(分) | 改善中位(ATR) | 改善平均(ATR) | 改善P10(ATR) | 大行情改善平均(ATR) | 進場後30分逆向中位(ATR) | 大行情錯過% |\n|---|---|---|---|---|---|---|---|---|---|\n`;
    for (const r of trig) {
        md += `| ${r.name} | ${f1(r.fillPct)} | ${f1(r.limitPct)} | ${f1(r.delayMin)} | ${f2(r.improveAtr)} | ${f2(r.improveMean)} | ${f2(r.improveP10)} | ${f2(r.bigImproveMean)} | ${f2(r.mae30Atr)} | ${f1(r.bigMissedPct)} |\n`;
    }
    writeFileSync(`${OUT}/report.md`, md);
    console.log(md);
});
