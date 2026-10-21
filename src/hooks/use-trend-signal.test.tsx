import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTrendSignal, type TrendSignalFeed } from './use-trend-signal';
import type { ContractBase } from '../lib/types/contract';
import type { Candle } from '../lib/types/market';

const m = vi.hoisted(() => ({
    fetch: vi.fn(),
    /** 補抓（不進共用快取）的呼叫參數；回應與 fetch 共用同一個佇列 */
    fresh: [] as unknown[][],
    nextRevision: vi.fn(() => 900),
    heartbeat: 0,
    epoch: 1,
    tickListeners: new Set<(tick: any) => void>(),
    computes: [] as any[],
}));

vi.mock('../lib/chart-history', () => ({
    fetchChartHistoryStamped: m.fetch,
    fetchChartHistoryFresh: (...a: unknown[]) => { m.fresh.push(a); return m.fetch(...a); },
    nextChartHistoryRevision: m.nextRevision,
}));
vi.mock('../lib/stream', () => ({
    getLastHeartbeat: () => m.heartbeat,
    getStreamStatus: () => 'live',
    onAnyTick: (fn: (tick: any) => void) => {
        m.tickListeners.add(fn);
        return () => m.tickListeners.delete(fn);
    },
    streamConnectionEpoch: () => m.epoch,
    subscribeStatusStore: () => () => undefined,
}));
vi.mock('../lib/trend-signal/engine', () => ({
    runTrendSignal: (input: any) => {
        m.computes.push(input);
        return { snapshot: { pendingEntry: null, trade: { status: 'OPEN' } }, asOf: input.asOf };
    },
}));

const CONTRACT = { code: 'TXFR1', security_type: 'FUT', target_code: null } as ContractBase;
const sec = (hm: string) => Date.UTC(2026, 9, 21, Number(hm.slice(0, 2)), Number(hm.slice(3, 5))) / 1000;
const ms = (hm: string) => sec(hm) * 1000 - 8 * 60 * 60 * 1000;
const candle = (hm: string, close: number): Candle => ({ time: sec(hm), open: close, high: close, low: close, close, volume: 1 });
const kbars = (...bars: Candle[]) => ({
    datetime: bars.map((b) => `2026-10-21 ${new Date(b.time * 1000).toISOString().slice(11, 16)}:00`),
    Open: bars.map((b) => b.open), High: bars.map((b) => b.high), Low: bars.map((b) => b.low),
    Close: bars.map((b) => b.close), Volume: bars.map((b) => b.volume),
});

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function Probe({
    contract = CONTRACT,
    enabled = true,
    historySeq = 4,
    receive,
}: {
    contract?: ContractBase;
    enabled?: boolean;
    historySeq?: number;
    receive: (value: TrendSignalFeed) => void;
}) {
    receive(useTrendSignal(contract, enabled, {}, historySeq));
    return null;
}

const roots: ReactTestRenderer[] = [];
async function mount(props: React.ComponentProps<typeof Probe>) {
    let root!: ReactTestRenderer;
    await act(async () => { root = create(createElement(Probe, props)); });
    roots.push(root);
    return root;
}
async function flush() {
    await act(async () => { await Promise.resolve(); });
}
function emitTick(time: string, close = 100, totalVolume?: number) {
    const [date, clock] = ['2026-10-21', time.length === 5 ? `${time}:00` : time];
    for (const fn of m.tickListeners) fn({ code: 'TXFR1', date, time: clock, close, volume: 1, ...(totalVolume === undefined ? {} : { total_volume: totalVolume }) });
}

beforeEach(() => {
    m.fetch.mockReset();
    m.fresh.length = 0;
    m.nextRevision.mockClear();
    m.heartbeat = 0;
    m.epoch = 1;
    m.tickListeners.clear();
    m.computes.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(ms('09:59'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(async () => {
    await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('useTrendSignal feed regressions', () => {
    it('same-code reactivation waits for fresh history before advancing past a missing minute, retaining frozen bars', async () => {
        vi.setSystemTime(ms('09:58'));
        const initial = deferred<{ kbars: ReturnType<typeof kbars>; requestedAt: number }>();
        const firstPatch = deferred<{ kbars: ReturnType<typeof kbars>; requestedAt: number }>();
        const resumedPatch = deferred<{ kbars: ReturnType<typeof kbars>; requestedAt: number }>();
        const cached = { kbars: kbars(candle('09:58', 98)), requestedAt: ms('09:58') };
        // 第一筆成交 09:59:20 才到：09:59 那一分鐘不能靠逐筆證明完整，另有一次補抓（伺服器：09:59 沒有成交）
        const noTrade0959 = { kbars: kbars(candle('09:58', 98)), requestedAt: ms('09:59') + 31_000 };
        m.fetch.mockReturnValueOnce(initial.promise).mockReturnValueOnce(firstPatch.promise)
            .mockResolvedValueOnce(noTrade0959).mockResolvedValueOnce(cached).mockReturnValueOnce(resumedPatch.promise);
        let feed!: TrendSignalFeed;
        const root = await mount({ receive: (v) => { feed = v; } });
        await act(async () => { initial.resolve(cached); });
        await flush();
        expect(m.fetch).toHaveBeenCalledTimes(1);

        // Resolve the partial first-minute gap through the real hook's history patch path.
        await act(async () => { vi.advanceTimersByTime(10_000); });
        expect(m.fetch).toHaveBeenCalledTimes(2);
        await act(async () => { firstPatch.resolve({ kbars: cached.kbars, requestedAt: ms('09:58') + 10_000 }); });
        await flush();
        m.heartbeat = ms('09:59') + 15_000;
        vi.setSystemTime(ms('09:59') + 30_000);
        emitTick('09:59:20', 99);
        await act(async () => { vi.advanceTimersByTime(2000); });

        await act(async () => { root.update(createElement(Probe, { enabled: false, receive: (v) => { feed = v; } })); });
        vi.setSystemTime(ms('10:01') + 15_000);
        // Local receive time can advance while hidden; the history cache still returns its old request stamp.
        m.heartbeat = ms('10:01') + 15_000;
        await act(async () => { root.update(createElement(Probe, { enabled: true, receive: (v) => { feed = v; } })); });
        await flush();

        expect(m.fetch).toHaveBeenCalledTimes(5);
        expect(m.fetch.mock.calls[0]?.[3]).toMatchObject({ revision: 4 });
        expect(m.fetch.mock.calls[3]?.[3]).toMatchObject({ revision: 4 });
        // 補抓都走不進共用快取的路徑（不帶 revision、不會擠掉主圖與 20 天歷史的快取）
        expect(m.fresh).toEqual([m.fetch.mock.calls[1], m.fetch.mock.calls[2], m.fetch.mock.calls[4]]);
        expect(m.fetch.mock.calls[1]?.[3]).not.toHaveProperty('revision');
        emitTick('10:00:50', 101);
        await act(async () => { vi.advanceTimersByTime(2000); });
        // The stale cached response has not confirmed the uncovered 10:00 minute.
        expect(m.computes.at(-1)?.asOf).toBeLessThan(sec('10:00'));
        expect(m.computes.at(-1)?.bars1m.find((b: Candle) => b.time === sec('09:58'))?.close).toBe(98);

        await act(async () => { resumedPatch.resolve({ kbars: kbars(candle('09:58', 77), candle('09:59', 99), candle('10:00', 101), candle('10:01', 102)), requestedAt: ms('10:01') + 15_000 }); });
        await flush();
        vi.setSystemTime(ms('10:01') + 20_000);
        emitTick('10:01:20', 103);
        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(m.computes.at(-1)?.asOf).toBeGreaterThanOrEqual(sec('10:00'));
        expect(m.computes.at(-1)?.bars1m.find((b: Candle) => b.time === sec('09:58'))?.close).toBe(98);
        expect(feed.error).toBe(false);
    });

    it('does not use a delayed heartbeat receive time to reject an earlier exchange-time tick', async () => {
        vi.setSystemTime(ms('09:58'));
        const initial = deferred<{ kbars: ReturnType<typeof kbars>; requestedAt: number }>();
        const patch = deferred<{ kbars: ReturnType<typeof kbars>; requestedAt: number }>();
        m.fetch.mockReturnValueOnce(initial.promise).mockReturnValueOnce(patch.promise).mockResolvedValue({ kbars: kbars(candle('09:58', 100)), requestedAt: ms('09:58') });
        let feed!: TrendSignalFeed;
        const root = await mount({ receive: (v) => { feed = v; } });
        await act(async () => { initial.resolve({ kbars: kbars(candle('09:58', 100)), requestedAt: ms('09:58') }); });
        await flush();
        expect(m.tickListeners.size).toBe(1);

        await act(async () => { vi.advanceTimersByTime(10_000); });
        await act(async () => { patch.resolve({ kbars: kbars(candle('09:58', 100)), requestedAt: ms('09:58') + 10_000 }); });
        await flush();
        m.heartbeat = ms('09:59') + 15_000;
        vi.setSystemTime(ms('09:59') + 30_000);
        await act(async () => { vi.advanceTimersByTime(1000); });

        // Server heartbeat was stamped 10:00:30 but received locally at 10:01:15.
        vi.setSystemTime(ms('10:01') + 15_000);
        m.heartbeat = ms('10:01') + 15_000;
        await act(async () => { vi.advanceTimersByTime(1000); });
        emitTick('10:00:50', 101);
        await act(async () => { vi.advanceTimersByTime(2000); });

        expect(feed.lateTicks).toBe(0);
        expect(m.computes.at(-1)?.bars1m.some((b: Candle) => b.time === sec('10:01') && b.close === 101)).toBe(true);
    });

    it('does not let a superseded contract history response populate the new contract feed', async () => {
        const old = deferred<{ kbars: ReturnType<typeof kbars>; requestedAt: number }>();
        const next = deferred<{ kbars: ReturnType<typeof kbars>; requestedAt: number }>();
        m.fetch.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
        const root = await mount({ receive: () => undefined });
        await act(async () => { root.update(createElement(Probe, { contract: { ...CONTRACT, code: 'MXFR1' }, receive: () => undefined })); });
        await act(async () => { old.resolve({ kbars: kbars(candle('09:59', 11)), requestedAt: ms('10:00') }); });
        await flush();
        expect(m.computes.some((x) => x.bars1m.some((b: Candle) => b.close === 11))).toBe(false);

        await act(async () => { next.resolve({ kbars: kbars(candle('09:59', 22)), requestedAt: ms('10:00') }); });
        await flush();
        expect(m.computes.at(-1)?.bars1m.some((b: Candle) => b.close === 22)).toBe(true);
    });

    it('switches an initialized feed to another contract without scanning an uninitialized feed', async () => {
        const next = deferred<{ kbars: ReturnType<typeof kbars>; requestedAt: number }>();
        m.fetch.mockResolvedValueOnce({ kbars: kbars(candle('09:59', 11)), requestedAt: ms('09:59') });
        m.fetch.mockReturnValueOnce(next.promise);
        const root = await mount({ receive: () => undefined });
        await flush();
        expect(m.computes.some((x) => x.symbol === 'TXFR1')).toBe(true);

        await act(async () => { root.update(createElement(Probe, { contract: { ...CONTRACT, code: 'MXFR1' }, receive: () => undefined })); });
        await act(async () => { vi.advanceTimersByTime(1000); });
        expect(m.computes.some((x) => x.symbol === 'MXFR1' && x.bars1m.some((b: Candle) => b.close === 11))).toBe(false);
        await act(async () => { next.resolve({ kbars: kbars(candle('09:59', 22)), requestedAt: ms('09:59') }); });
        await flush();
        expect(m.computes.at(-1)?.symbol).toBe('MXFR1');
        expect(m.computes.at(-1)?.bars1m.some((b: Candle) => b.close === 22)).toBe(true);
    });

    it('does not let an old contract patch release the new contract patch single-flight lock', async () => {
        vi.setSystemTime(ms('09:58'));
        const patchA = deferred<{ kbars: ReturnType<typeof kbars>; requestedAt: number }>();
        const historyB = deferred<{ kbars: ReturnType<typeof kbars>; requestedAt: number }>();
        const patchB = deferred<{ kbars: ReturnType<typeof kbars>; requestedAt: number }>();
        m.fetch.mockResolvedValueOnce({ kbars: kbars(candle('09:58', 11)), requestedAt: ms('09:58') })
            .mockReturnValueOnce(patchA.promise)
            .mockReturnValueOnce(historyB.promise)
            .mockReturnValueOnce(patchB.promise)
            .mockResolvedValue({ kbars: kbars(candle('09:58', 22)), requestedAt: ms('09:58') });
        const root = await mount({ receive: () => undefined });
        await flush();
        await act(async () => { vi.advanceTimersByTime(10_000); });
        expect(m.fetch).toHaveBeenCalledTimes(2);

        await act(async () => { root.update(createElement(Probe, { contract: { ...CONTRACT, code: 'MXFR1' }, receive: () => undefined })); });
        await act(async () => { historyB.resolve({ kbars: kbars(candle('09:58', 22)), requestedAt: ms('09:58') }); });
        await flush();
        expect(m.fetch).toHaveBeenCalledTimes(4);

        await act(async () => { patchA.resolve({ kbars: kbars(candle('09:58', 11)), requestedAt: ms('09:58') + 10_000 }); });
        await flush();
        await act(async () => { vi.advanceTimersByTime(20_000); });
        expect(m.fetch).toHaveBeenCalledTimes(4);
        // Leave B's request unresolved; the test owns its cleanup through hook unmount.
        void patchB;
    });

    it('隱藏超過一天再顯示：補抓從第一個待補分鐘的前一天抓起，不只抓昨天到今天', async () => {
        vi.setSystemTime(ms('09:58'));
        m.fetch.mockResolvedValue({ kbars: kbars(candle('09:58', 98)), requestedAt: ms('09:58') });
        const root = await mount({ receive: () => undefined });
        await flush();
        await act(async () => { root.update(createElement(Probe, { enabled: false, receive: () => undefined })); });
        // 兩天後（10-23 10:01）才重新顯示
        vi.setSystemTime(ms('10:01') + 2 * 86_400_000);
        await act(async () => { root.update(createElement(Probe, { enabled: true, receive: () => undefined })); });
        await act(async () => { vi.advanceTimersByTime(2000); });
        // 第一個待補分鐘是 10-21 09:58：從 10-20 起抓（只抓昨天起的 10-22，10-21 到 10-22 之間永遠補不回）
        expect(m.fresh.at(-1)?.slice(1, 3)).toEqual(['2026-10-20', '2026-10-23']);
    });

    it('逐筆帶累計量：對不上時把漏收計入 streamGaps（hook 把 total_volume 交給 feed）', async () => {
        vi.setSystemTime(ms('09:58'));
        m.fetch.mockResolvedValueOnce({ kbars: kbars(candle('09:58', 98)), requestedAt: ms('09:58') + 20_000 })
            .mockReturnValue(new Promise(() => undefined));
        let feed!: TrendSignalFeed;
        await mount({ receive: (v) => { feed = v; } });
        await flush();
        vi.setSystemTime(ms('09:58') + 30_000);
        emitTick('09:58:15', 100, 1);
        emitTick('09:59:10', 101, 2);
        emitTick('10:00:20', 102, 9); // 中間 6 口沒收到
        await act(async () => { vi.advanceTimersByTime(1000); });
        expect(feed.streamGaps).toBe(1);
    });

    it('keeps one history patch in flight while the same missing minute is observed repeatedly', async () => {
        const first = deferred<{ kbars: ReturnType<typeof kbars>; requestedAt: number }>();
        const patch = deferred<{ kbars: ReturnType<typeof kbars>; requestedAt: number }>();
        m.fetch.mockReturnValueOnce(first.promise).mockReturnValueOnce(patch.promise);
        await mount({ receive: () => undefined });
        await act(async () => { first.resolve({ kbars: kbars(candle('09:59', 99)), requestedAt: ms('09:59') - 15_000 }); });
        await flush();
        await act(async () => { vi.advanceTimersByTime(10_000); });
        expect(m.fetch).toHaveBeenCalledTimes(2);
        await act(async () => { vi.advanceTimersByTime(20_000); });
        expect(m.fetch).toHaveBeenCalledTimes(2);
        await act(async () => { patch.resolve({ kbars: kbars(candle('09:59', 99), candle('10:00', 100)), requestedAt: ms('10:01') }); });
        await flush();
    });
});
