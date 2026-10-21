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
import { algoParams, auditExport, feedBadge, pendingAlerts } from './trend-signal-panel';

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
        expect(out.version).toBe('tsp-1.1.0');
        expect(out.configKey).toBe(res.configKey);
        expect(out.algorithm).toBe('SuperTrend ATR 10 × 3');
        expect(out.permissions).toEqual({ read_only: true, auto_entry: false, auto_exit: false });
        expect(out.dataSource).toContain('只用已收 K 棒');
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
    const feed = (over: Partial<typeof res>, stream: 'live' | 'down' = 'live') => ({ result: { ...res, ...over }, stream, loading: false, error: false });
    it('LIVE、未連線、休市、延遲與國定假日（盤中時段長時間無資料）', () => {
        expect(feedBadge(feed({ sessionOpen: true, dataLagSec: 30 })).text).toBe('LIVE');
        expect(feedBadge(feed({ sessionOpen: true, dataLagSec: 30 }, 'down')).cls).toBe('down');
        expect(feedBadge(feed({ sessionOpen: false })).text).toBe('休市');
        expect(feedBadge(feed({ sessionOpen: true, dataLagSec: 400 })).text).toBe('資料延遲 400 秒');
        expect(feedBadge(feed({ sessionOpen: true, dataLagSec: 90000 })).text).toBe('無新資料（可能休市）');
    });
});
