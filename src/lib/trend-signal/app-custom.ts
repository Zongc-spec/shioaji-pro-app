// src/lib/trend-signal/app-custom.ts — 官方 App 自訂指標單檔的週期分派。原意：5m 是主趨勢並判斷進出場，
// 1m 是精準進出場。App 只給主圖本身的 OHLCV，所以各主圖週期能做到的範圍不同：
//   1m 主圖    原模型：由 1m 聚合 5m 主趨勢、1m 精準提示與虛擬風控（runTrendSignal，與 Web 逐根相同）
//   5m 主圖    5m 主趨勢＋三種進場模式與虛擬風控，全部以 5m K 棒計算：IMMEDIATE 與 1m 主圖同一根成交、同一個初始停損；
//              MICRO_TREND／PRICE_STRUCTURE 的提示來自 5m K 棒（看不到 5 分鐘內的回檔），停損與觸價以 5m K 棒判定
//   其他週期   拿不到 5m 主趨勢：只畫該週期自己的趨勢線作高週期輔助，不產生訊號、進出場與風控
// 三種主圖輸出同一組 19 條（App 存檔時依輸出名稱保留樣式），算不出的序列為空。

import type { BarsInput } from '../custom-runtime';
import { nowWallClockUtc } from '../utils/kbars';
import { appTspPlotHints } from './app-plot-style';
import { frameFromChart, inferChartMinutes, keepLastChartSegment, runChartSignal } from './chart-custom';
import { CUSTOM_TSP_PLOTS, inputFromCustomBars, normalizeCustomBars, projectCustomTsp } from './custom-adapter';
import { tradingSessionOf } from './core/session';
import { runTrendSignal } from './engine';
import type { TrendSignalResult } from './types';

export const APP_TSP_VERSION = 'tsp-app-1.5.0';
export type AppTspMode = 'model' | 'm5' | 'aux';
export const APP_TSP_PLOTS = CUSTOM_TSP_PLOTS;

type Outputs = Record<string, (number | null)[]>;
const empty = (n: number): Outputs => Object.fromEntries(APP_TSP_PLOTS.map(([k]) => [k, new Array<number | null>(n).fill(null)]));
/** 5m 主圖的微型趨勢與主趨勢算在同一組 5m K 棒上：沿用 1m 主圖的預設會與主趨勢完全相同、MICRO_TREND 永遠不提示。
 *  改用較靈敏的預設（只依提示頻率選定，研究結果 7.3）；使用者在 App 宣告了該參數就照用 */
export const M5_MICRO_DEFAULTS = { microStMult: 1, microDcLength: 5, microKamaHyst: 0.05 } as const;

/** 主圖週期 → 計算方式 */
export function appModeOf(minutes: number): AppTspMode {
    return minutes === 1 ? 'model' : minutes === 5 ? 'm5' : 'aux';
}

/** 1m 主圖的 5m 趨勢線：只畫最後一段連續的 5m 趨勢（同方向、同盤、相鄰 5m），宿主折線才不會跨段連線 */
function keepLastModelSegment(out: Outputs, chartTimes: number[], res: TrendSignalResult) {
    const { bars, session } = res.m5;
    const last = bars.length - 1;
    let start = last;
    while (start > 0 && res.t5.dir[start - 1] === res.t5.dir[last]
        && bars[start]!.time - bars[start - 1]!.time === 300 && session[start] === session[start - 1]) start--;
    const from = bars[start]?.time ?? Number.POSITIVE_INFINITY;
    for (const key of ['多方趨勢線', '空方趨勢線']) {
        out[key] = out[key]!.map((v, i) => {
            const t = chartTimes[i]!;
            if (t < from) return null;
            // 最後一根已收 5m 之後（進行中的桶）只延續到同一盤
            return t > bars[last]!.time && tradingSessionOf('FUT', t).key !== session[last] ? null : v;
        });
    }
}

export function computeAppCustomTsp(bars: BarsInput, params: Record<string, number> = {}, nowWall = nowWallClockUtc()) {
    if (params.riskHistory !== undefined && params.riskHistory !== 0 && params.riskHistory !== 1) throw new Error('riskHistory 只接受 0（目前部位）或 1（含歷史部位）');
    const riskHistory = params.riskHistory === 1;
    const { sorted } = normalizeCustomBars(bars, params);
    const mode = appModeOf(inferChartMinutes(sorted.map((b) => b.time), params.chartTf ?? 0));
    let outputs = empty(bars.time.length);
    let result: TrendSignalResult | ReturnType<typeof runChartSignal> | null = null;
    if (mode === 'model') {
        const input = inputFromCustomBars(bars, params, nowWall);
        const res = input ? runTrendSignal(input) : null;
        if (input && res) {
            outputs = projectCustomTsp(res, bars.time, input.live?.time ?? res.m1.bars.at(-1)?.time ?? -Infinity, riskHistory);
            keepLastModelSegment(outputs, bars.time, res);
        }
        result = res;
    } else {
        const frame = frameFromChart(bars, mode === 'm5' ? { ...M5_MICRO_DEFAULTS, ...params } : params, nowWall);
        // 其他週期拿不到 5m 主趨勢：不建立部位
        const res = runChartSignal(frame, { risk: mode === 'm5' });
        const shown = mode === 'm5' ? res : { ...res, signals: [], invalidations: [], entries: [], trades: [] };
        const mapped = bars.time.map(frame.mapTime);
        outputs = projectCustomTsp(shown, mapped, frame.live?.time ?? frame.confirmed.at(-1)?.time ?? -Infinity, riskHistory);
        keepLastChartSegment(outputs, frame, res.t5.dir, mapped);
        result = res;
    }
    const hints = appTspPlotHints(outputs, bars.time, result, mode, riskHistory);
    return { mode, result, outputs, order: APP_TSP_PLOTS.map(([key]) => key), hints };
}
