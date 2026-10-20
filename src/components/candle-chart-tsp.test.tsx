// candle-chart Trend Signal Pro 整合測試：指標選單註冊、canonical 20 天 1m 載入後
// 畫出 5m 趨勢線與 BUY/SELL 標記、四週期 Dashboard 與虛擬風控面板、切換 1m/5m/15m/60m
// 訊號不漂移、隱藏即清除，且全程不呼叫任何下單或改單函式。
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { created } from './chart-session.test-harness';

vi.hoisted(() => {
    const store = new Map<string, string>();
    const ls = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), key: () => null, length: 0 };
    (globalThis as any).localStorage = ls;
    (globalThis as any).window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {}, dispatchEvent() {}, location: { search: '', href: 'http://x/' } });
    (globalThis as any).document = { addEventListener() {}, removeEventListener() {}, createElement: () => ({ style: {}, getContext: () => null }), body: {} };
});
const m = vi.hoisted(() => ({ place: vi.fn(), cancel: vi.fn(), update: vi.fn(), markers: [] as any[][] }));
vi.mock('../lib/trade', () => ({ notify: () => {}, placeQuickOrder: m.place }));
vi.mock('../lib/shioaji', () => ({ cancelOrder: m.cancel, updateOrderPrice: m.update }));
vi.mock('lightweight-charts', async () => {
    const lw = (await import('./chart-session.test-harness')).lwMock();
    return {
        ...lw,
        createSeriesMarkers: () => ({ setMarkers: (x: any[]) => m.markers.push(x), markers: () => [], detach() {} }),
    };
});
vi.mock('../hooks/use-stream', () => ({ useQuote: () => undefined }));
const fetchMock = vi.fn();
vi.mock('../lib/chart-history', () => ({
    fetchChartHistory: (...a: unknown[]) => fetchMock(...a),
    nextChartHistoryRevision: () => Math.random(),
}));

import { DEF_BY_TYPE, INDICATOR_DEFS, instanceLabel, newInstance } from '../lib/indicator-defs';
import { TSP_TYPE } from '../lib/trend-signal/config';
import { sessionLabels, walkBars } from '../lib/trend-signal/fixtures.test-harness';
import { CandleChart } from './candle-chart';

const fut = { code: 'TMFR1', security_type: 'FUT', exchange: 'TAIFEX', target_code: 'TMFJ6', tick: 1, multiplier: 10, root: 'TMF', delivery_month: '202610' } as any;

// 3 個交易日的 TMF 1m（日夜盤），轉成 kbars 欄位陣列
const pad = (n: number) => String(n).padStart(2, '0');
const iso = (t: number) => {
    const d = new Date(t * 1000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`;
};
const bars = walkBars(sessionLabels('2026-09-01', 3), 5, { regime: 60 });
const KBARS = {
    datetime: bars.map((b) => iso(b.time)),
    Open: bars.map((b) => b.open),
    High: bars.map((b) => b.high),
    Low: bars.map((b) => b.low),
    Close: bars.map((b) => b.close),
    Volume: bars.map((b) => b.volume),
    Amount: bars.map((b) => b.close * b.volume),
};

const flush = async () => {
    for (let i = 0; i < 8; i++) await act(async () => {});
};
const mounted: ReactTestRenderer[] = [];
function mount(props: any) {
    let r!: ReactTestRenderer;
    act(() => {
        r = create(createElement(CandleChart, props), {
            createNodeMock: () => ({ clientWidth: 800, clientHeight: 400, getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0 }), addEventListener() {}, removeEventListener() {}, style: {} }),
        });
    });
    mounted.push(r);
    return r;
}
const text = (n: ReactTestInstance | string): string => (typeof n === 'string' ? n : n.children.map(text).join(''));
const hasText = (r: ReactTestRenderer, s: string) => r.root.findAll((n) => typeof n.type === 'string' && text(n).includes(s)).length > 0;
const tfButton = (r: ReactTestRenderer, label: string) => r.root.findAll((n) => n.type === 'button' && text(n) === label)[0]!;
const lastSignalMarkers = () => (m.markers.at(-1) ?? []).filter((x) => x.text === 'BUY' || x.text === 'SELL');

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), removeItem: (k: string) => store.delete(k), key: () => null, length: 0 });
    vi.stubGlobal('requestAnimationFrame', (cb: any) => setTimeout(cb, 0));
    vi.stubGlobal('cancelAnimationFrame', (id: any) => clearTimeout(id));
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-04T10:00:00+08:00'));
    created.length = 0;
    m.markers.length = 0;
    m.place.mockReset();
    m.cancel.mockReset();
    m.update.mockReset();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(KBARS);
});
afterEach(() => {
    for (const x of mounted.splice(0)) act(() => x.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('Trend Signal Pro 原生指標', () => {
    it('註冊在指標選單（主圖疊加），legend 只顯示核心演算法參數', () => {
        const def = DEF_BY_TYPE.get(TSP_TYPE)!;
        expect(INDICATOR_DEFS).toContain(def);
        expect(def.category).toBe('overlay');
        expect(instanceLabel(newInstance(TSP_TYPE))).toBe('TSP(ST 10×3)');
        expect(instanceLabel({ ...newInstance(TSP_TYPE), params: { ...newInstance(TSP_TYPE).params, algo: 1 } })).toBe('TSP(DC 20)');
    });

    it('載入 20 天 canonical 1m：畫趨勢線、BUY/SELL 標記、Dashboard 與虛擬風控面板；不下單', async () => {
        localStorage.setItem('sj-pro-indicators-v2', JSON.stringify([newInstance(TSP_TYPE)]));
        const r = mount({ contract: fut });
        await flush();
        // canonical 歷史固定 20 個日曆日（台灣日期 2026-09-04 往前 20 天），與主圖週期無關
        expect(fetchMock.mock.calls.some((c) => c[1] === '2026-08-15' && c[2] === '2026-09-04')).toBe(true);
        expect(hasText(r, 'TSP · SuperTrend')).toBe(true);
        expect(hasText(r, '5m 主控')).toBe(true);
        expect(hasText(r, '虛擬風控 · TMFR1')).toBe(true);
        expect(hasText(r, '只觀察，不送任何委託')).toBe(true);
        expect(lastSignalMarkers().length).toBeGreaterThan(0);
        const lines = created.filter((c) => c.kind === 'Line' && (c.last as any[]).some((p) => p.value !== undefined));
        expect(lines.length).toBeGreaterThanOrEqual(2);
        expect(m.place).not.toHaveBeenCalled();
        expect(m.cancel).not.toHaveBeenCalled();
        expect(m.update).not.toHaveBeenCalled();
    });

    it('切換 1m／5m／15m／60m：訊號標記數量不變（同一份 canonical 結果）', async () => {
        localStorage.setItem('sj-pro-indicators-v2', JSON.stringify([newInstance(TSP_TYPE)]));
        const r = mount({ contract: fut });
        await flush();
        const base = lastSignalMarkers().length;
        expect(base).toBeGreaterThan(0);
        for (const tf of ['1m', '15m', '60m', '5m']) {
            act(() => tfButton(r, tf).props.onClick());
            await flush();
            expect(lastSignalMarkers().length).toBe(base);
        }
    });

    it('Dashboard 的 1m 按鈕開關右側 1m 小圖（偏好依實例記住）', async () => {
        const inst = newInstance(TSP_TYPE);
        localStorage.setItem('sj-pro-indicators-v2', JSON.stringify([inst]));
        const r = mount({ contract: fut });
        await flush();
        expect(hasText(r, '1m 微型趨勢（SuperTrend）')).toBe(false);
        act(() => r.root.findAll((n) => n.type === 'button' && n.props.title === '1m 小圖')[0]!.props.onClick());
        await flush();
        expect(hasText(r, '1m 微型趨勢（SuperTrend）')).toBe(true);
        expect(JSON.parse(localStorage.getItem('sj-pro-tsp-ui-v1')!)[inst.id]).toMatchObject({ mini: true });
    });

    it('眼睛隱藏 → 不顯示面板、清除標記', async () => {
        localStorage.setItem('sj-pro-indicators-v2', JSON.stringify([{ ...newInstance(TSP_TYPE), hidden: true }]));
        const r = mount({ contract: fut });
        await flush();
        expect(hasText(r, 'TSP · ')).toBe(false);
        expect(lastSignalMarkers()).toEqual([]);
    });

    it('組合商品不支援：只顯示提示，不計算', async () => {
        localStorage.setItem('sj-pro-indicators-v2', JSON.stringify([newInstance(TSP_TYPE)]));
        const r = mount({ contract: { ...fut, combo: { code: 'X', legs: [], combo_type: 'spread' } } });
        await flush();
        expect(hasText(r, '組合商品沒有單一合約的 1m K 棒')).toBe(true);
        expect(lastSignalMarkers()).toEqual([]);
    });
});
