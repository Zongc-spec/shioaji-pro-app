// 起點不變性（研究量測，不在 CI 執行）：從 373 個不同起點各取 3000 根 5m，以
// src/lib/trend-signal/trend/algorithms.ts 的實作計算，量測狀態（LONG／SHORT／NEUTRAL）與
// 線值（差 > 0.5 點）最晚在起點後第幾根才與全量計算永久一致 → 決定各演算法的暖身長度。
// 只比較兩邊都已有狀態（非 null）的 K 棒；另記錄子序列仍無狀態、全量已有狀態的最後一根。
// V1.1：RawDir 的 0 是 NEUTRAL（已知狀態），null 才是資料不足。
// 用法同 characterize.char.ts（TSP_CHAR_CSV / TSP_CHAR_OUT）。
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { aggregate, wallClockToUtc } from '../../../src/lib/utils/kbars';
import { ALGORITHMS } from '../../../src/lib/trend-signal/trend/algorithms';
import { DEFAULT_CONFIG } from '../../../src/lib/trend-signal/config';
import type { TrendParams } from '../../../src/lib/trend-signal/types';
import type { Candle } from '../../../src/lib/types/market';

const CSV = process.env.TSP_CHAR_CSV ?? '';
const OUT = `${process.env.TSP_CHAR_OUT ?? tmpdir()}/start-invariance.txt`;

const pct = (xs: number[], q: number) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(q * (s.length - 1))]! : Number.NaN;
};

test('start invariance', () => {
    if (!CSV) throw new Error('請以 TSP_CHAR_CSV 指定 1m CSV 路徑');
    const lines = readFileSync(CSV, 'utf8').split('\n');
    const m1: Candle[] = [];
    const FROM = wallClockToUtc('2025-09-01T00:00:00');
    for (let k = 1; k < lines.length; k++) {
        const l = lines[k];
        if (!l) continue;
        const [dt, o, h, lo, c, v] = l.split(',');
        const t = wallClockToUtc(dt!);
        if (t < FROM) continue;
        m1.push({ time: t, open: +o!, high: +h!, low: +lo!, close: +c!, volume: +v! });
    }
    const b5 = aggregate(m1, 5);
    const base = DEFAULT_CONFIG.trend;
    const cases: [string, TrendParams][] = [
        ['SuperTrend(10,2)', { ...base, algo: 'supertrend', stMult: 2 }],
        ['SuperTrend(10,3)', { ...base, algo: 'supertrend', stMult: 3 }],
        ['SuperTrend(10,4)', { ...base, algo: 'supertrend', stMult: 4 }],
        ['Donchian(20)+ATR×2', { ...base, algo: 'donchian', dcAtrMult: 2 }],
        ['Donchian(20)+ATR×3', { ...base, algo: 'donchian' }],
        ['Donchian(20)+ATR×4', { ...base, algo: 'donchian', dcAtrMult: 4 }],
        ['Donchian(10)+ATR×3', { ...base, algo: 'donchian', dcLength: 10 }],
        ['Donchian(40)+ATR×3', { ...base, algo: 'donchian', dcLength: 40 }],
        ['KAMA(10,2,30)+0.3', { ...base, algo: 'kama' }],
    ];
    const out: string[] = [];
    for (const [name, p] of cases) {
        const algo = ALGORITHMS[p.algo];
        const full = algo.compute(b5, p);
        const dirLast: number[] = [];
        const lineLast: number[] = [];
        const unknownLast: number[] = [];
        let starts = 0;
        for (let s = 137; s < b5.length - 3000; s += 137) {
            starts++;
            const sub = algo.compute(b5.slice(s, s + 3000), p);
            let dl = -1;
            let ll = -1;
            let ul = -1;
            for (let i = 0; i < 3000; i++) {
                const a = sub.dir[i]!;
                const b = full.dir[s + i]!;
                if (a === null && b !== null) ul = i;
                if (a === null || b === null) continue;
                if (a !== b) dl = i;
                const sv = sub.line[i];
                const fv = full.line[s + i];
                if (sv !== undefined && fv !== undefined && Math.abs(sv - fv) > 0.5) ll = i;
            }
            dirLast.push(dl);
            lineLast.push(ll);
            unknownLast.push(ul);
        }
        out.push(`${name}: starts=${starts} warmup=${algo.warmup(p)}; 方向最後不同 max=${Math.max(...dirLast)} p99=${pct(dirLast, 0.99)}; 線值差>0.5 max=${Math.max(...lineLast)} p99=${pct(lineLast, 0.99)}; 尚無方向 max=${Math.max(...unknownLast)}`);
    }
    writeFileSync(OUT, out.join('\n') + '\n');
});
