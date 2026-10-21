// trend-signal-panel 的純函式：模擬警示只提醒 3 分鐘內、尚未提醒過的事件（切換週期、
// 重開 App、斷線重連不重播舊訊號）；審計匯出帶計算版本、權限與資料來源。
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    (globalThis as any).localStorage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
    (globalThis as any).window = Object.assign(globalThis, { addEventListener() {}, removeEventListener() {} });
});

import { DEFAULT_CONFIG } from '../lib/trend-signal/config';
import { runTrendSignal } from '../lib/trend-signal/engine';
import { sessionLabels, walkBars } from '../lib/trend-signal/fixtures.test-harness';
import { algoParams, auditExport, feedBadge, pendingAlerts, tradeSummary } from './trend-signal-panel';

const labels = sessionLabels('2026-09-01', 3);
const m1 = walkBars(labels, 5, { regime: 60 });
const res = runTrendSignal({ bars1m: m1, asOf: labels.at(-1)!, securityType: 'FUT', symbol: 'TMFR1', contractMonth: '202609', tick: 1, pointValue: 10, config: DEFAULT_CONFIG });

describe('模擬警示去重', () => {
    it('只提醒 asOf 前 3 分鐘內的訊號／失效／1m 提示／成交／出場', () => {
        const fresh = pendingAlerts(res, new Set());
        expect(fresh.every(({ event }) => event.time >= res.asOf - 180)).toBe(true);
        expect(fresh.every(({ event }) => ['SIGNAL', 'INVALID', 'ENTRY', 'FILL', 'EXIT'].includes(event.kind))).toBe(true);
    });
    it('已提醒過的 key 不再提醒（重開、重算、換週期都一樣）', () => {
        const withRecent = { ...res, asOf: res.events.at(-1)!.time + 60 };
        const first = pendingAlerts(withRecent, new Set());
        expect(first.length).toBeGreaterThan(0);
        expect(pendingAlerts(withRecent, new Set(first.map((x) => x.key)))).toEqual([]);
    });
});

describe('審計匯出', () => {
    it('包含計算版本、演算法與參數、唯讀權限、資料來源與所有紀錄', () => {
        const out = auditExport(res, DEFAULT_CONFIG);
        expect(out.version).toBe('tsp-1.1.3');
        expect(out.configKey).toBe(res.configKey);
        expect(out.algorithm).toBe('SuperTrend ATR 10 × 3');
        expect(out.permissions).toEqual({ read_only: true, auto_entry: false, auto_exit: false });
        expect(out.dataSource).toContain('只用已收且資料完整的 K 棒');
        expect(out.timeConvention).toContain('at=open');
        expect(out.summary.closed).toBe(res.trades.filter((t) => t.status === 'CLOSED').length);
        expect(out.dataGaps).toEqual(res.gaps);
        expect(out.signals).toHaveLength(res.signals.length);
        expect(out.invalidations).toHaveLength(res.invalidations.length);
        expect(out.entries).toHaveLength(res.entries.length);
        expect(out.events[0]).toHaveProperty('at');
    });
    it('三個 TrendCore 的參數說明', () => {
        expect(algoParams({ ...DEFAULT_CONFIG.trend, algo: 'donchian' })).toBe('Donchian 20 根突破＋ATR14 × 3 追蹤帶');
        expect(algoParams({ ...DEFAULT_CONFIG.trend, algo: 'kama' })).toBe('KAMA 10,2,30＋遲滯 0.3 × ATR14');
    });
});

describe('行情狀態徽章', () => {
    const feed = (over: Partial<typeof res>, stream: 'live' | 'down' = 'live') => ({ result: { ...res, ...over }, stream, loading: false, error: false, pendingFrom: null, confirmLagSec: 0, lateTicks: 0 });
    it('LIVE、未連線、休市、延遲與國定假日（盤中時段長時間無資料）', () => {
        expect(feedBadge(feed({ sessionOpen: true, dataLagSec: 30 })).text).toBe('LIVE');
        expect(feedBadge(feed({ sessionOpen: true, dataLagSec: 30 }, 'down')).cls).toBe('down');
        expect(feedBadge(feed({ sessionOpen: false })).text).toBe('休市');
        expect(feedBadge(feed({ sessionOpen: true, dataLagSec: 400 })).text).toBe('資料延遲 400 秒');
        expect(feedBadge(feed({ sessionOpen: true, dataLagSec: 90000 })).text).toBe('無新資料（可能休市）');
    });
    it('資料補齊中（斷線重連、缺分鐘）與確認延遲', () => {
        const base = feed({ sessionOpen: true, dataLagSec: 30 });
        expect(feedBadge({ ...base, pendingFrom: res.asOf - 300 }).text).toMatch(/^資料補齊中：\d\d:\d\d 起尚未確認$/);
        expect(feedBadge({ ...base, pendingFrom: res.asOf - 300 }).cls).toBe('warn');
        expect(feedBadge({ ...base, confirmLagSec: 240 }).text).toBe('確認延遲 240 秒');
    });
});

describe('審計部位合計', () => {
    it('只算已平倉；成本後＝點數 × 每點價值 − 手續費與期交稅', () => {
        const sum = tradeSummary(res.trades);
        const closed = res.trades.filter((t) => t.status === 'CLOSED');
        expect(sum.closed).toBe(closed.length);
        expect(sum.closed).toBeGreaterThan(0);
        expect(sum.net).toBeCloseTo(sum.points * 10 - sum.cost, 6);
        expect(sum.cost).toBe(closed.reduce((a, t) => a + t.costNtd, 0));
        // 每筆成交都標示在 K 棒的哪裡成交；部位的成交時刻＝成交那根 1m 的開盤
        for (const t of res.trades) {
            expect(t.fillAt).toBe(t.fillTime - 60);
            for (const f of t.fills) expect(['open', 'intrabar']).toContain(f.at);
        }
    });
});
