import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { created } from './chart-session.test-harness';

vi.hoisted(() => {
    (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    (globalThis as any).window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, location: { search: '', href: 'http://x/' } });
    (globalThis as any).document = { addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, getContext: () => null }), body: {} };
});
const calls = vi.hoisted(() => ({ attached: [] as unknown[], detached: [] as unknown[], order: vi.fn() }));
vi.mock('../lib/trade', () => ({ notify() {}, placeQuickOrder: calls.order }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: calls.order, updateOrderPrice: calls.order }));
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined }));
vi.mock('lightweight-charts', async () => {
    const lw = (await import('./chart-session.test-harness')).lwMock();
    return { ...lw, createChart: () => {
        const chart = lw.createChart();
        return new Proxy(chart, { get(target, key) {
            if (key !== 'addSeries') return target[key];
            return (type: unknown, options: unknown) => {
                const series = target.addSeries(type);
                series.applyOptions(options);
                series.attachPrimitive = (primitive: unknown) => { if (primitive instanceof ChartTradeMarkers) calls.attached.push(primitive); };
                series.detachPrimitive = (primitive: unknown) => { if (primitive instanceof ChartTradeMarkers) calls.detached.push(primitive); };
                return series;
            };
        } });
    } };
});
const fetchMock = vi.fn();
vi.mock('../lib/chart-history', () => ({
    fetchChartHistory: (...args: unknown[]) => fetchMock(...args),
    fetchChartHistoryStamped: (...args: unknown[]) => fetchMock(...args).then((kbars: unknown) => ({ kbars, requestedAt: Date.now() })),
    fetchChartHistoryFresh: (...args: unknown[]) => fetchMock(...args).then((kbars: unknown) => ({ kbars, requestedAt: Date.now() })),
    nextChartHistoryRevision: () => 1,
}));

import { customType, deleteCustom, saveCustom } from '../lib/custom-indicators';
import { newInstance } from '../lib/indicator-defs';
import { ChartTradeMarkers } from '../lib/chart-trade-markers';
import { CandleChart } from './candle-chart';

const id = 'custom-marker-integration';
const fut = { code: 'TMFR1', security_type: 'FUT', exchange: 'TAIFEX', tick: 1, multiplier: 10, root: 'TMF' } as any;
const mounted: ReactTestRenderer[] = [];
const text = (n: ReactTestInstance | string): string => typeof n === 'string' ? n : n.children.map(text).join('');
const flush = async () => { for (let i = 0; i < 8; i++) await act(async () => {}); };
function mount() {
    let renderer!: ReactTestRenderer;
    act(() => { renderer = create(createElement(CandleChart, { contract: fut }), {
        createNodeMock: () => ({ clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {}, style: {} }),
    }); });
    mounted.push(renderer);
    return renderer;
}

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) });
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));
    vi.stubGlobal('cancelAnimationFrame', clearTimeout);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    calls.attached.length = calls.detached.length = created.length = 0;
    calls.order.mockReset();
    const time = Array.from({ length: 60 }, (_, i) => `2026-09-01 09:${String(i).padStart(2, '0')}:00`);
    const price = time.map((_, i) => 100 + i);
    fetchMock.mockResolvedValue({ datetime: time, Open: price, High: price, Low: price, Close: price, Volume: price, Amount: price });
    saveCustom({ id, name: 'Marker fixture', short: 'M', category: 'overlay', desc: '', params: [],
        outputs: [ { key: 'entry', label: 'entry', kind: 'points', color: '#00e5ff' },
            { key: 'stop', label: 'stop', kind: 'dashed', plot: 'step', color: '#ffad33' } ],
        source: `plot('entry', close, {markers:close.map((v,i)=>i===close.length-2?{side:'Buy',text:'Buy 進場'}:null)}); plot('stop', close, {kind:'dashed',plot:'step'});`,
        updatedAt: 1 });
});
afterEach(() => {
    for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
    deleteCustom(id);
    vi.unstubAllGlobals();
});

it('真自訂執行器的 marker 接到圖表、風控為階梯虛線；切週期與卸載均清除舊 primitive', async () => {
    localStorage.setItem('sj-pro-indicators-v2', JSON.stringify([newInstance(customType(id))]));
    const renderer = mount();
    await flush();
    expect(calls.attached.length).toBeGreaterThan(0);
    expect(calls.attached.every((p) => p instanceof ChartTradeMarkers)).toBe(true);
    expect(created.some((s) => s.kind === 'Line' && s.options.lineStyle === 2 && s.options.lineType === 1)).toBe(true);
    expect(created.some((s) => s.kind === 'Line' && s.options.lineVisible === false && s.options.pointMarkersVisible === false)).toBe(true);
    const before = [...calls.attached];
    act(() => renderer.root.findAll((node) => node.type === 'button' && text(node) === '1m')[0]!.props.onClick());
    await flush();
    for (const primitive of before) expect(calls.detached).toContain(primitive);
    act(() => renderer.unmount());
    mounted.splice(mounted.indexOf(renderer), 1);
    expect(calls.detached.length).toBe(calls.attached.length);
    expect(calls.order).not.toHaveBeenCalled();
});

it('只有自訂指標的虛線在價格軸帶名稱，內建指標的虛線不帶', async () => {
    localStorage.setItem('sj-pro-indicators-v2', JSON.stringify([newInstance(customType(id)), newInstance('donchian')]));
    mount();
    await flush();
    expect(created.filter((s) => s.kind === 'Line' && s.options.lineStyle === 2).length).toBeGreaterThan(1);
    expect(created.some((s) => s.kind === 'Line' && s.options.title === 'stop')).toBe(true);
    expect(created.some((s) => s.kind === 'Line' && s.options.title === '中軌')).toBe(false);
});

it('隱藏指標或單獨關閉交易輸出時，不留下交易標記', async () => {
    const instance = newInstance(customType(id));
    localStorage.setItem('sj-pro-indicators-v2', JSON.stringify([{ ...instance, hidden: true }]));
    const first = mount();
    await flush();
    expect(calls.attached).toEqual([]);
    act(() => first.unmount());
    mounted.splice(mounted.indexOf(first), 1);
    localStorage.setItem('sj-pro-indicators-v2', JSON.stringify([{ ...instance, styles: { entry: { visible: false } } }]));
    mount();
    await flush();
    expect(calls.attached).toEqual([]);
});
