// 回放畫面不能顯示回放時刻以後才會取得的 OHLC；圖與審計必須讀同一個切點。
import { afterEach, expect, it, vi } from 'vitest';
import type { KBars } from '../types/market';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules(); });

it('回放02:00:30只提供已收1m，所有欄位對齊且圖表與審計一致；推進時鐘才露出下一棒', async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    const now = Date.parse('2026-08-27T02:00:30+08:00');
    vi.setSystemTime(now);
    const raw: KBars = {
        datetime: ['2026/08/27 01:59:00', '2026/08/27 02:00:00', '2026/08/27 02:01:00'],
        Open: [100, 101, 999], High: [102, 103, 1999], Low: [99, 100, 998],
        Close: [101, 102, 1777], Volume: [10, 20, 9999], Amount: [1000, 2000, 999999],
    };
    const before = structuredClone(raw);
    const fetcher = vi.fn().mockResolvedValue({ json: async () => raw });
    vi.stubGlobal('fetch', fetcher);
    const history = await import('../../../scripts/tsp-demo/stubs/chart-history');
    const chart = await history.fetchChartHistory();
    const audit = await history.fetchChartHistoryFresh();
    expect(chart.datetime).toEqual(raw.datetime.slice(0, 2));
    for (const key of ['Open', 'High', 'Low', 'Close', 'Volume', 'Amount'] as const) expect(chart[key]).toEqual(raw[key].slice(0, 2));
    expect(audit).toEqual({ kbars: chart, requestedAt: now });
    expect(raw).toEqual(before);
    vi.setSystemTime(now + 60000);
    expect(await history.fetchChartHistory()).toEqual(raw);
    expect(fetcher).toHaveBeenCalledTimes(1);
});
