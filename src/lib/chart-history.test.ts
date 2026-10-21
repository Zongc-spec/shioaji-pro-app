import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), base: 'fixture' }));
vi.mock('./runtime', () => ({ getApiBase: () => mocks.base }));
vi.mock('./shioaji', () => ({ fetchKbars: mocks.fetch }));
const contract = { code: '2330', exchange: 'TSE', security_type: 'STK', target_code: null } as const;
beforeEach(() => { vi.resetModules(); mocks.fetch.mockReset().mockResolvedValue({ Close: [100] }); mocks.base = 'fixture'; });
describe('chart history request sharing', () => {
    it('shares concurrent and completed requests across presentation rebuilds', async () => {
        const { fetchChartHistory } = await import('./chart-history');
        const a = fetchChartHistory(contract, '2026-09-01', '2026-09-12');
        const b = fetchChartHistory({ ...contract }, '2026-09-01', '2026-09-12', { timeoutMs: 5000 });
        expect(a).toBe(b); await a;
        await fetchChartHistory({ ...contract }, '2026-09-01', '2026-09-12');
        expect(mocks.fetch).toHaveBeenCalledOnce();
    });
    it('gives separate panels fresh revisions instead of reusing local counter 1', async () => {
        const { fetchChartHistory, nextChartHistoryRevision } = await import('./chart-history');
        const first = nextChartHistoryRevision();
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', { revision: first });
        const second = nextChartHistoryRevision();
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', { revision: second });
        expect(first).not.toBe(second);
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', { revision: second });
        expect(mocks.fetch).toHaveBeenCalledTimes(2);
    });
    it('stamped requests share the cache and report the original request time', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000_000);
        const { fetchChartHistory, fetchChartHistoryStamped } = await import('./chart-history');
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12');
        vi.setSystemTime(5_000_000);
        const stamped = await fetchChartHistoryStamped(contract, '2026-09-01', '2026-09-12');
        expect(stamped).toEqual({ kbars: { Close: [100] }, requestedAt: 1_000_000 });
        expect(mocks.fetch).toHaveBeenCalledOnce();
        vi.useRealTimers();
    });
    it('fresh gap-filling requests bypass the shared cache: always refetch, never evict cached histories', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(2_000_000);
        const { fetchChartHistory, fetchChartHistoryFresh } = await import('./chart-history');
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12');
        for (let i = 0; i < 150; i++) await fetchChartHistoryFresh(contract, '2026-09-11', '2026-09-12');
        expect(mocks.fetch).toHaveBeenCalledTimes(151);
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12');
        expect(mocks.fetch).toHaveBeenCalledTimes(151);
        expect(await fetchChartHistoryFresh(contract, '2026-09-11', '2026-09-12')).toEqual({ kbars: { Close: [100] }, requestedAt: 2_000_000 });
        vi.useRealTimers();
    });
    it('caches failures but allows an explicit manual revision, date or server change', async () => {
        const { fetchChartHistory } = await import('./chart-history');
        mocks.fetch.mockRejectedValueOnce(new Error('offline'));
        await expect(fetchChartHistory(contract, '2026-09-01', '2026-09-12')).rejects.toThrow('offline');
        await expect(fetchChartHistory(contract, '2026-09-01', '2026-09-12')).rejects.toThrow('offline');
        expect(mocks.fetch).toHaveBeenCalledOnce();
        await fetchChartHistory(contract, '2026-09-01', '2026-09-12', { revision: 1 });
        await fetchChartHistory(contract, '2026-09-01', '2026-09-13');
        mocks.base = 'other'; await fetchChartHistory(contract, '2026-09-01', '2026-09-13');
        expect(mocks.fetch).toHaveBeenCalledTimes(4);
    });
});
