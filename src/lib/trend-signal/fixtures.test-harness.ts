// Trend Signal Pro 測試共用：確定性的 TMF 1m K 棒產生器（固定種子）。
// 時段與真實期貨相同：日盤 label 08:46–13:45、夜盤 15:01–次日 05:00，
// 週末沒有日盤／夜盤（週五夜盤延續到週六 05:00）。
import type { Candle } from '../types/market';
import { wallClockToUtc } from '../utils/kbars';

export const T = (s: string) => wallClockToUtc(s);

/** mulberry32 */
export function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const DAY = 86400;

/** 從 startDate（YYYY-MM-DD）起 days 個日曆日的所有 1m label */
export function sessionLabels(startDate: string, days: number, opts: { night?: boolean } = {}): number[] {
    const night = opts.night ?? true;
    const out: number[] = [];
    const d0 = T(`${startDate}T00:00:00`);
    for (let d = 0; d < days; d++) {
        const base = d0 + d * DAY;
        const wd = new Date(base * 1000).getUTCDay();
        if (wd === 0 || wd === 6) continue;
        for (let t = base + 8.75 * 3600 + 60; t <= base + 13.75 * 3600; t += 60) out.push(t);
        if (night) for (let t = base + 15 * 3600 + 60; t <= base + DAY + 5 * 3600; t += 60) out.push(t);
    }
    return out;
}

export interface WalkOpts {
    start?: number;
    /** 每分鐘雜訊（點） */
    vol?: number;
    /** 趨勢段平均長度（分鐘） */
    regime?: number;
    /** 趨勢段每分鐘漂移上限（點） */
    drift?: number;
}

/** 切換趨勢（漲／跌／盤整）的隨機漫步，價格吸附到 1 點 tick */
export function walkBars(labels: number[], seed: number, opts: WalkOpts = {}): Candle[] {
    const r = rng(seed);
    const vol = opts.vol ?? 6;
    const regime = opts.regime ?? 90;
    const driftMax = opts.drift ?? 2.5;
    let price = opts.start ?? 23000;
    let drift = 0;
    let left = 0;
    const out: Candle[] = [];
    let prev = -1;
    for (const t of labels) {
        if (left <= 0) {
            const u = r();
            drift = u < 0.35 ? driftMax * (0.4 + r() * 0.6) : u < 0.7 ? -driftMax * (0.4 + r() * 0.6) : 0;
            left = Math.round(regime * (0.5 + r()));
        }
        left--;
        // 換盤（中間沒有 K 棒）時開盤小跳空
        const gap = prev >= 0 && t - prev > 600 ? (r() - 0.5) * vol * 6 : 0;
        const open = Math.round(price + gap);
        const close = Math.round(open + drift + (r() - 0.5) * 2 * vol);
        const high = Math.max(open, close) + Math.round(r() * vol);
        const low = Math.min(open, close) - Math.round(r() * vol);
        out.push({ time: t, open, high, low, close, volume: 20 + Math.round(r() * 200) });
        price = close;
        prev = t;
    }
    return out;
}

/** 依 label 產生指定收盤路徑的 1m K 棒（高低點 = 開收 ± spread） */
export function pathBars(labels: number[], closes: number[], spread = 1): Candle[] {
    const out: Candle[] = [];
    for (let i = 0; i < labels.length; i++) {
        const close = closes[i]!;
        const open = i > 0 ? closes[i - 1]! : close;
        out.push({
            time: labels[i]!,
            open,
            high: Math.max(open, close) + spread,
            low: Math.min(open, close) - spread,
            close,
            volume: 100,
        });
    }
    return out;
}
