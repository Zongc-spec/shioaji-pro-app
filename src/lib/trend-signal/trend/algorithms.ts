// src/lib/trend-signal/trend/algorithms.ts — 可切換的趨勢演算法。皆為公開
// 方法、自行實作，不是任何商業指標的原版。每種演算法只用已收 K 棒，回傳
// 趨勢線與方向；方向切換就是趨勢訊號。新增演算法必須通過同一組驗收。

import { atr, supertrend } from '../../indicators';
import type { Candle } from '../../types/market';
import { alignPoints } from '../core/bars';
import type { TrendAlgoId, TrendParams } from '../types';

export interface RawTrend {
    line: (number | undefined)[];
    /** 1 = 多、-1 = 空、0 = 演算法尚無方向 */
    dir: (1 | -1 | 0)[];
}

export interface TrendAlgorithm {
    id: TrendAlgoId;
    label: string;
    /** 線就是翻轉價位，可當趨勢線與停損參考 */
    stopLine: boolean;
    /** 自資料起點須輸出 UNKNOWN 的根數（起點不變性的量測見
     *  docs/research/trend-signal-algorithms-2026-10.md） */
    warmup: (p: TrendParams) => number;
    compute: (bars: Candle[], p: TrendParams) => RawTrend;
}

// (H+L)/2 ± 倍數 × ATR 的棘輪帶，收盤穿越生效帶即翻轉（indicators.supertrend）
const SUPERTREND: TrendAlgorithm = {
    id: 'supertrend',
    label: 'SuperTrend',
    stopLine: true,
    // 實測方向最晚第 111 根一致（ATR 10，倍數 2–4）；15 × stPeriod 保留約 35% 餘裕
    warmup: (p) => 15 * p.stPeriod,
    compute: (bars, p) => {
        const r = supertrend(bars, p.stPeriod, p.stMult);
        const line: (number | undefined)[] = new Array(bars.length);
        const dir: (1 | -1 | 0)[] = new Array(bars.length);
        for (let i = 0; i < bars.length; i++) {
            const u = r.up[i]?.value;
            const d = r.down[i]?.value;
            line[i] = u ?? d;
            dir[i] = u !== undefined ? 1 : d !== undefined ? -1 : 0;
        }
        return { line, dir };
    },
};

// 收盤突破前 n 根最高（最低）價翻轉；線是會讓趨勢翻轉的那一側通道邊
const DONCHIAN: TrendAlgorithm = {
    id: 'donchian',
    label: 'Donchian',
    stopLine: true,
    // 方向只取決於最近一次突破，沒有遞迴狀態；第一次突破前本來就是 0
    warmup: (p) => p.dcLength,
    compute: (bars, p) => {
        const n = Math.max(2, Math.round(p.dcLength));
        const line: (number | undefined)[] = new Array(bars.length);
        const dir: (1 | -1 | 0)[] = new Array(bars.length);
        let d: 1 | -1 | 0 = 0;
        for (let i = 0; i < bars.length; i++) {
            if (i < n) {
                line[i] = undefined;
                dir[i] = 0;
                continue;
            }
            let hh = -Infinity;
            let ll = Infinity;
            for (let j = i - n; j < i; j++) {
                hh = Math.max(hh, bars[j]!.high);
                ll = Math.min(ll, bars[j]!.low);
            }
            const c = bars[i]!.close;
            if (c > hh) d = 1;
            else if (c < ll) d = -1;
            dir[i] = d;
            line[i] = d === 1 ? ll : d === -1 ? hh : undefined;
        }
        return { line, dir };
    },
};

/** Kaufman 自適應均線：效率比高（趨勢）時接近快速 EMA，低（盤整）時接近慢速 */
export function kamaLine(bars: Candle[], n: number, fast: number, slow: number): (number | undefined)[] {
    const fc = 2 / (fast + 1);
    const sc = 2 / (slow + 1);
    const out: (number | undefined)[] = new Array(bars.length);
    let k = bars[0]?.close ?? 0;
    for (let i = 0; i < bars.length; i++) {
        const c = bars[i]!.close;
        if (i < n) {
            k = c;
            out[i] = undefined;
            continue;
        }
        const change = Math.abs(c - bars[i - n]!.close);
        let vol = 0;
        for (let j = i - n + 1; j <= i; j++) vol += Math.abs(bars[j]!.close - bars[j - 1]!.close);
        const er = vol > 0 ? change / vol : 0;
        const s2 = (er * (fc - sc) + sc) ** 2;
        k = k + s2 * (c - k);
        out[i] = k;
    }
    return out;
}

// KAMA 線自身從高點回落（低點回升）kamaHyst × ATR14 才翻轉；線不是停損價位
const KAMA: TrendAlgorithm = {
    id: 'kama',
    label: 'KAMA',
    stopLine: false,
    // 實測方向與線值最晚第 113 根一致（kamaSlow = 30）；5 × kamaSlow 保留約 33% 餘裕
    warmup: (p) => 5 * p.kamaSlow,
    compute: (bars, p) => {
        const kl = kamaLine(bars, p.kamaLength, p.kamaFast, p.kamaSlow);
        const a = alignPoints(bars, atr(bars, 14));
        const dir: (1 | -1 | 0)[] = new Array(bars.length);
        let d: 1 | -1 | 0 = 0;
        let hi = 0;
        let lo = 0;
        for (let i = 0; i < bars.length; i++) {
            const k = kl[i];
            const av = a[i];
            if (k === undefined || av === undefined) {
                dir[i] = 0;
                continue;
            }
            if (d === 0) {
                // 第一個可用點：以線的走向決定初始方向（之後由遲滯翻轉）
                const prev = i > 0 ? kl[i - 1] : undefined;
                d = prev !== undefined && k < prev ? -1 : 1;
                hi = k;
                lo = k;
            } else if (d === 1) {
                hi = Math.max(hi, k);
                if (k < hi - p.kamaHyst * av) {
                    d = -1;
                    lo = k;
                }
            } else {
                lo = Math.min(lo, k);
                if (k > lo + p.kamaHyst * av) {
                    d = 1;
                    hi = k;
                }
            }
            dir[i] = d;
        }
        return { line: kl, dir };
    },
};

export const ALGORITHMS: Record<TrendAlgoId, TrendAlgorithm> = {
    supertrend: SUPERTREND,
    donchian: DONCHIAN,
    kama: KAMA,
};
