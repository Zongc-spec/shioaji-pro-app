import type { PlotHint } from '../custom-runtime';
import type { IndicatorMarker } from '../indicators';
import type { ExitReason } from './types';
import { CUSTOM_TSP_PLOTS } from './custom-adapter';

const LEVELS = new Set(['初始停損', '目前停損', '保本價', '1R', '2R', '3R']);

type AppPlotResult = {
    trades: readonly {
        direction: 'LONG' | 'SHORT';
        fillTime: number;
        fills: readonly { time: number; reason: ExitReason }[];
    }[];
};

const exitPlot = (reason: ExitReason) => reason === 'TP2R' ? '虛擬2R出場'
    : reason === 'TP3R' ? '虛擬3R出場'
        : reason === 'REVERSAL' || reason === 'TREND_INVALID' ? '虛擬反轉失效出場'
            : '虛擬停損出場';

const exitText = (side: IndicatorMarker['side'], reason: ExitReason) => {
    switch (reason) {
        case 'STOP': return `${side} 停損出場`;
        case 'BREAKEVEN_STOP': return `${side} 保本停損出場`;
        case 'TRAIL_STOP': return `${side} 移動停損出場`;
        case 'TP2R': return `${side} 2R 出場`;
        case 'TP3R': return `${side} 3R 出場`;
        case 'REVERSAL': return `${side} 反轉出場`;
        case 'TREND_INVALID': return `${side} 反轉失效出場`;
    }
};

/** TSP App plot 樣式與 marker metadata；marker 只給虛擬進出場（主趨勢 BUY/SELL 仍是圓點），且只投影到既有且有值的輸出點。 */
export function appTspPlotHints(
    outputs: Record<string, (number | null)[]>,
    chartTimes: number[],
    result: AppPlotResult | null,
    mode: 'model' | 'm5' | 'aux',
    riskHistory: boolean,
): Record<string, PlotHint> {
    const markers = Object.fromEntries(CUSTOM_TSP_PLOTS.map(([key]) => [key, new Array<IndicatorMarker | null>(chartTimes.length).fill(null)])) as Record<string, (IndicatorMarker | null)[]>;
    const indexes = new Map<number, number[]>();
    chartTimes.forEach((time, i) => indexes.set(time, [...(indexes.get(time) ?? []), i]));
    const put = (key: string, time: number, marker: IndicatorMarker) => {
        for (const i of indexes.get(time) ?? []) {
            if (typeof outputs[key]?.[i] === 'number' && Number.isFinite(outputs[key]![i])) {
                markers[key]![i] = { side: marker.side, text: marker.text };
            }
        }
    };

    if (result && mode !== 'aux') {
        for (const trade of result.trades) {
            const side = trade.direction === 'LONG' ? 'Sell' : 'Buy';
            const entrySide = trade.direction === 'LONG' ? 'Buy' : 'Sell';
            put(trade.direction === 'LONG' ? '虛擬進場多' : '虛擬進場空', trade.fillTime,
                { side: entrySide, text: `${entrySide} 進場` });
            for (const fill of trade.fills) put(exitPlot(fill.reason), fill.time, { side, text: exitText(side, fill.reason) });
        }
    }

    return Object.fromEntries(CUSTOM_TSP_PLOTS.map(([key, color]) => [key, {
        color,
        kind: key.endsWith('趨勢線') ? 'line' : LEVELS.has(key) ? riskHistory ? 'points' : 'dashed' : 'points',
        ...(key === '目前停損' && !riskHistory ? { plot: 'step' as const } : {}),
        width: key === '目前停損' || key.endsWith('趨勢線') ? 2 : 1,
        markers: markers[key],
    } satisfies PlotHint]));
}
