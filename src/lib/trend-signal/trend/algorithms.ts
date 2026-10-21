// src/lib/trend-signal/trend/algorithms.ts — 可切換的趨勢核心（TrendCore，V1.1 §3 的
// 候選 A／B／C）。皆為公開方法、自行實作，不是任何商業指標的原版。每種演算法只用
// 已收 K 棒，回傳趨勢線與狀態；狀態切換就是趨勢訊號。新增演算法必須通過同一組驗收。

import { atr, supertrend } from '../../indicators';
import type { Candle } from '../../types/market';
import { alignPoints } from '../core/bars';
import type { TrendAlgoId, TrendParams } from '../types';

/** 1 = LONG、-1 = SHORT、0 = NEUTRAL（已知、沒有趨勢）、null = 資料不足 */
export type RawDir = 1 | -1 | 0 | null;

export interface RawTrend {
    line: (number | undefined)[];
    dir: RawDir[];
}

export interface TrendAlgorithm {
    id: TrendAlgoId;
    label: string;
    /** 線就是翻轉（或失效）價位，可當趨勢線與停損參考 */
    stopLine: boolean;
    /** 自資料起點須輸出 UNKNOWN 的根數（起點不變性的量測見
     *  docs/research/trend-signal-algorithms-2026-10.md） */
    warmup: (p: TrendParams) => number;
    compute: (bars: Candle[], p: TrendParams) => RawTrend;
}

// A：(H+L)/2 ± 倍數 × ATR 的棘輪帶，收盤穿越生效帶即翻轉（indicators.supertrend）
const SUPERTREND: TrendAlgorithm = {
    id: 'supertrend',
    label: 'SuperTrend',
    stopLine: true,
    // 實測方向最晚第 111 根一致（ATR 10，倍數 2–4）；15 × stPeriod 保留約 35% 餘裕
    warmup: (p) => 15 * p.stPeriod,
    compute: (bars, p) => {
        const r = supertrend(bars, p.stPeriod, p.stMult);
        const line: (number | undefined)[] = new Array(bars.length);
        const dir: RawDir[] = new Array(bars.length);
        for (let i = 0; i < bars.length; i++) {
            const u = r.up[i]?.value;
            const d = r.down[i]?.value;
            line[i] = u ?? d;
            dir[i] = u !== undefined ? 1 : d !== undefined ? -1 : null;
        }
        return { line, dir };
    },
};

// C：收盤突破前 n 根最高價轉 LONG（跌破前 n 根最低價轉 SHORT）。LONG 期間以 ATR 追蹤帶
// 保護：帶 = max(前值, 近 n 根最高 − dcAtrMult × ATR14)，只往上；收盤跌破帶 → NEUTRAL
// （趨勢失效），之後要再突破才回到 LONG／SHORT。SHORT 鏡像。線 = 生效中的追蹤帶。
const DONCHIAN: TrendAlgorithm = {
    id: 'donchian',
    label: 'Donchian＋ATR',
    stopLine: true,
    // 實測（dcLength 10／20／40、倍數 2–4）狀態最晚第 86 根、線值最晚第 98 根一致；
    // 通道需 dcLength 根，其後由 ATR14 與追蹤帶收斂 → dcLength + 120 保留 ≥ 35% 餘裕
    warmup: (p) => p.dcLength + 120,
    compute: (bars, p) => {
        const n = Math.max(2, Math.round(p.dcLength));
        const k = p.dcAtrMult;
        const a = alignPoints(bars, atr(bars, 14));
        const line: (number | undefined)[] = new Array(bars.length);
        const dir: RawDir[] = new Array(bars.length);
        let state: RawDir = null;
        let band = 0;
        for (let i = 0; i < bars.length; i++) {
            const av = a[i];
            if (i < n || av === undefined) {
                line[i] = undefined;
                dir[i] = null;
                continue;
            }
            // hh／ll：前 n 根（不含當根）— 突破門檻；top／bottom：近 n 根（含當根）— 追蹤帶基準
            let hh = -Infinity;
            let ll = Infinity;
            let top = -Infinity;
            let bottom = Infinity;
            for (let j = i - n; j <= i; j++) {
                const x = bars[j]!;
                if (j < i) {
                    hh = Math.max(hh, x.high);
                    ll = Math.min(ll, x.low);
                }
                if (j > i - n) {
                    top = Math.max(top, x.high);
                    bottom = Math.min(bottom, x.low);
                }
            }
            const c = bars[i]!.close;
            if (c > hh && state !== 1) {
                state = 1;
                band = top - k * av;
            } else if (c < ll && state !== -1) {
                state = -1;
                band = bottom + k * av;
            } else if (state === 1) {
                band = Math.max(band, top - k * av);
            } else if (state === -1) {
                band = Math.min(band, bottom + k * av);
            } else {
                state = 0;
            }
            // 收盤在追蹤帶錯誤一側（含突破當根長上影）：趨勢失效
            if ((state === 1 && c < band) || (state === -1 && c > band)) state = 0;
            dir[i] = state;
            line[i] = state === 1 || state === -1 ? band : undefined;
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

// B：KAMA 線自身從高點回落（低點回升）kamaHyst × ATR14 才翻轉；線不是停損價位
const KAMA: TrendAlgorithm = {
    id: 'kama',
    label: 'KAMA',
    stopLine: false,
    // 實測方向與線值最晚第 113 根一致（kamaSlow = 30）；5 × kamaSlow 保留約 33% 餘裕
    warmup: (p) => 5 * p.kamaSlow,
    compute: (bars, p) => {
        const kl = kamaLine(bars, p.kamaLength, p.kamaFast, p.kamaSlow);
        const a = alignPoints(bars, atr(bars, 14));
        const dir: RawDir[] = new Array(bars.length);
        let d: 1 | -1 | 0 = 0;
        let hi = 0;
        let lo = 0;
        for (let i = 0; i < bars.length; i++) {
            const k = kl[i];
            const av = a[i];
            if (k === undefined || av === undefined) {
                dir[i] = null;
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
