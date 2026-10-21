// demo stub of src/lib/chart-history.ts: 任何期間都回同一份回放 1m（vite 中介層提供；沒有就用合成資料）
import { sessionLabels, walkBars } from '../../../src/lib/trend-signal/fixtures.test-harness';
import type { KBars } from '../../../src/lib/types/market';

let revision = 0;
export const nextChartHistoryRevision = () => ++revision;

const pad = (n: number) => String(n).padStart(2, '0');
function synthetic(): KBars {
    const bars = walkBars(sessionLabels('2026-08-03', 24), 7, { start: 24000, regime: 90 });
    const iso = (t: number) => {
        const d = new Date(t * 1000);
        return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
    };
    return { datetime: bars.map((b) => iso(b.time)), Open: bars.map((b) => b.open), High: bars.map((b) => b.high), Low: bars.map((b) => b.low), Close: bars.map((b) => b.close), Volume: bars.map((b) => b.volume), Amount: bars.map(() => 0) };
}

let data: Promise<KBars> | null = null;
export function fetchChartHistory(): Promise<KBars> {
    data ??= fetch('/__tsp_demo_data.json').then((r) => r.json()).then((j: KBars | null) => j ?? synthetic());
    return data;
}
/** 同正式版：資料＋請求時刻（回放時鐘，main.tsx 把 Date.now 固定在 replayAt 附近） */
export function fetchChartHistoryStamped(): Promise<{ kbars: KBars; requestedAt: number }> {
    const requestedAt = Date.now();
    return fetchChartHistory().then((kbars) => ({ kbars, requestedAt }));
}
