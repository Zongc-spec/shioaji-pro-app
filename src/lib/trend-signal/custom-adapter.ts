// App 自訂指標與 Web 共用 runTrendSignal；這裡只驗輸入、決定可見資料與投影。
// App API 沒有商品/成交資訊：預設是明訂的微台設定，不是自動辨識。
// App 單檔（tsp-chart-1.2.0）走 chart-custom.ts 的本圖模式，只用這裡的 normalizeCustomBars／projectCustomTsp；
// computeCustomTsp 是 1m 主圖跑原 5m 趨勢＋1m 觸發模型的對照路徑（1.1.3 單檔即此模型），供測試對照 Web。
import type { BarsInput, PlotHint } from '../custom-runtime';
import { CLOSE_GRACE } from '../intraday-session';
import type { Candle } from '../types/market';
import { nowWallClockUtc } from '../utils/kbars';
import { configFromParams, TSP_PARAMS } from './config';
import { lastAtOrBefore } from './core/bars';
import { tradingSessionOf } from './core/session';
import { runTrendSignal } from './engine';
import type { TrendSignalInput, TrendSignalResult } from './types';

export const CUSTOM_TSP_PROFILE = { tick: 1, pointValue: 10, taxRate: 0.00002 } as const;
export const CUSTOM_TSP_PLOTS = [
    ['多方趨勢線', '#1fd286'], ['空方趨勢線', '#ff4d6a'],
    ['BUY', '#00e5ff'], ['SELL', '#ff2bd6'], ['失效', '#e0a43c'],
    ['1m 微型提示', '#8fd3ff'], ['1m 結構提示', '#b06fff'],
    ['初始停損', '#ff4d6a'], ['目前停損', '#ffad33'], ['保本價', '#d0d8e8'],
    ['1R', '#7fbf9f'], ['2R', '#4fc9a5'], ['3R', '#1fd286'],
    ['虛擬進場多', '#00e5ff'], ['虛擬進場空', '#ff2bd6'],
    ['虛擬停損出場', '#ff744d'], ['虛擬2R出場', '#4fc9a5'],
    ['虛擬3R出場', '#1fd286'], ['虛擬反轉失效出場', '#e0a43c'],
] as const;

type Outputs = Record<string, (number | null)[]>;
const empty = (n: number): Outputs => Object.fromEntries(CUSTOM_TSP_PLOTS.map(([k]) => [k, new Array<number | null>(n).fill(null)]));

/** 非法輸入必須回報錯誤，不能讓編輯器把全 null 當成有效風控。 */
export function normalizeCustomBars(bars: BarsInput, params: Record<string, number> = {}) {
    const n = bars.time.length;
    if ([bars.open, bars.high, bars.low, bars.close, bars.volume].some((a) => a.length !== n)) throw new Error('K 棒欄位長度不一致');
    for (const def of TSP_PARAMS) {
        if (params[def.key] !== undefined && !Number.isFinite(params[def.key])) throw new Error(`參數 ${def.key} 必須是有限數值`);
    }
    const market = (key: keyof typeof CUSTOM_TSP_PROFILE) => {
        const value = params[key] === undefined ? CUSTOM_TSP_PROFILE[key] : params[key];
        if (!Number.isFinite(value) || (key === 'taxRate' ? value < 0 || value > 1 : value <= 0)) throw new Error(`商品參數 ${key} 無效，請核對契約規格`);
        return value;
    };
    const tick = market('tick'), pointValue = market('pointValue'), taxRate = market('taxRate');
    const byTime = new Map<number, Candle>();
    for (let i = 0; i < n; i++) {
        const b = { time: bars.time[i]!, open: bars.open[i]!, high: bars.high[i]!, low: bars.low[i]!, close: bars.close[i]!, volume: bars.volume[i]! };
        if (!Object.values(b).every(Number.isFinite) || b.time % 60 !== 0 || b.volume < 0 || b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)) {
            throw new Error('1m K 棒時間或 OHLCV 無效');
        }
        byTime.set(b.time, b);
    }
    const sorted = [...byTime.values()].sort((a, b) => a.time - b.time);
    return { sorted, tick, pointValue, taxRate };
}

export function inputFromCustomBars(bars: BarsInput, params: Record<string, number> = {}, nowWall = nowWallClockUtc()): TrendSignalInput | null {
    if (!Number.isFinite(nowWall)) throw new Error('計算時刻無效');
    const { sorted, tick, pointValue, taxRate } = normalizeCustomBars(bars, params);
    if (sorted.length < 2) return null;
    let step = Infinity;
    for (let i = 1; i < sorted.length; i++) step = Math.min(step, sorted[i]!.time - sorted[i - 1]!.time);
    if (step !== 60) throw new Error('TSP 風控自訂版只支援 1m 主圖；請切換至 1m 並載入足夠資料');
    // 只看當下已可能存在的棒；收盤 label 在目前這分鐘末尾的才可作 live。
    const visible = sorted.filter((b) => b.time <= Math.ceil(nowWall / 60) * 60);
    if (visible.length < 2) return null;
    const last = visible[visible.length - 1]!;
    const session = tradingSessionOf('FUT', last.time);
    const closed = nowWall >= session.end + CLOSE_GRACE + 10;
    const confirmed = closed ? visible : visible.slice(0, -1);
    return {
        bars1m: confirmed,
        live: closed ? null : last,
        asOf: closed ? Math.max(last.time, session.end + CLOSE_GRACE) : confirmed[confirmed.length - 1]!.time,
        securityType: 'FUT', symbol: 'TMF', contractMonth: 'CUSTOM', tick, pointValue, taxRate,
        config: configFromParams(params),
    };
}

/** 以原始 chart time 映回索引；成交與停損生效用所屬 1m label，不把開盤時刻提前一根。 */
export type CustomPlotResult = Pick<TrendSignalResult, 'asOf' | 'm1' | 'm5' | 't5' | 'signals' | 'invalidations' | 'entries' | 'trades'> & {
    snapshot: Pick<TrendSignalResult['snapshot'], 'trade'>;
};
export function projectCustomTsp(res: CustomPlotResult, chartTimes: number[], visibleThrough = Infinity, riskHistory = true): Outputs {
    const out = empty(chartTimes.length);
    const indexes = new Map<number, number[]>();
    chartTimes.forEach((t, i) => { if (t <= visibleThrough) indexes.set(t, [...(indexes.get(t) ?? []), i]); });
    const put = (key: string, time: number, value: number) => {
        for (const i of indexes.get(time) ?? []) out[key]![i] = value;
    };
    chartTimes.forEach((t, i) => {
        if (t > visibleThrough) return;
        const j = lastAtOrBefore(res.m5.bars, Math.min(t, res.asOf));
        const dir = res.t5.dir[j];
        const value = res.t5.line[j];
        if (value !== undefined && (dir === 'LONG' || dir === 'SHORT')) out[dir === 'LONG' ? '多方趨勢線' : '空方趨勢線']![i] = value;
    });
    for (const s of res.signals) put(s.kind, s.barTime, s.close);
    for (const x of res.invalidations) put('失效', x.barTime, res.m5.bars[x.index]!.close);
    for (const e of res.entries) {
        if (e.mode === 'MICRO_TREND') put('1m 微型提示', e.barTime, e.refPrice);
        if (e.mode === 'PRICE_STRUCTURE') put('1m 結構提示', e.barTime, e.refPrice);
    }
    const times = [...indexes.keys()].sort((a, b) => a - b);
    for (const trade of res.trades) {
        put(trade.direction === 'LONG' ? '虛擬進場多' : '虛擬進場空', trade.fillTime, trade.fillPrice);
        for (const f of trade.fills) {
            const key = f.reason === 'TP2R' ? '虛擬2R出場' : f.reason === 'TP3R' ? '虛擬3R出場'
                : f.reason === 'REVERSAL' || f.reason === 'TREND_INVALID' ? '虛擬反轉失效出場' : '虛擬停損出場';
            put(key, f.time, f.price);
        }
        if (!riskHistory && (res.snapshot.trade?.status !== 'OPEN' || trade.id !== res.snapshot.trade.id)) continue;
        const plan = trade.plan;
        let stopIndex = 0;
        let stop = plan.stop;
        // 同棒舊單平倉、新單進場時，新單的價位最後覆寫；兩類成交 marker 都保留。
        for (const t of times) {
            if (t < trade.fillTime) continue;
            if (trade.closedAt !== null && t > trade.closedAt) break;
            while (stopIndex < trade.stopHistory.length && trade.stopHistory[stopIndex]!.time <= t) stop = trade.stopHistory[stopIndex++]!.stop;
            for (const [key, value] of [['初始停損', plan.stop], ['目前停損', stop], ['保本價', plan.breakevenStop], ['1R', plan.r1], ['2R', plan.r2], ['3R', plan.r3]] as const) put(key, t, value);
        }
    }
    return out;
}

export function computeCustomTsp(bars: BarsInput, params: Record<string, number> = {}, nowWall = nowWallClockUtc()) {
    if (params.riskHistory !== undefined && params.riskHistory !== 0 && params.riskHistory !== 1) throw new Error('riskHistory 只接受 0（目前部位）或 1（含歷史部位）');
    const input = inputFromCustomBars(bars, params, nowWall);
    const result = input ? runTrendSignal(input) : null;
    const visibleThrough = input?.live?.time ?? result?.m1.bars.at(-1)?.time ?? -Infinity;
    const outputs = result ? projectCustomTsp(result, bars.time, visibleThrough, params.riskHistory === 1) : empty(bars.time.length);
    // 圓點不把空手期間或不同部位的價位接起來；也不把階梯停損畫成斜線。
    const hints = Object.fromEntries(CUSTOM_TSP_PLOTS.map(([key, color]) => [key, { color, kind: 'points', width: key === '目前停損' ? 2 : 1 } satisfies PlotHint]));
    return { input, result, outputs, order: CUSTOM_TSP_PLOTS.map(([key]) => key), hints };
}
