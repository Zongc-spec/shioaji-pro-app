// src/components/trend-signal-mini-chart.tsx — Trend Signal Pro 的 1m 小圖（主圖右側欄）：
// 最近 120 根已收 1m K 棒、1m 微型趨勢線（綠／紅）、5m 訊號與各進場時機、虛擬出場標記。
// 只顯示，不吃任何點擊下單。

import {
    CandlestickSeries,
    ColorType,
    createChart,
    createSeriesMarkers,
    LineSeries,
    LineType,
    type IChartApi,
    type ISeriesApi,
    type ISeriesMarkersPluginApi,
    type SeriesMarker,
    type Time,
    type UTCTimestamp,
} from 'lightweight-charts';
import { useEffect, useRef } from 'react';
import type { TrendSignalResult } from '../lib/trend-signal/types';
import { exitText } from '../lib/trend-signal/risk/virtual';
import type { ChartColors } from '../lib/theme-store';
import * as s from './trend-signal-panel.css';

const BARS = 120;
const TAG = { IMMEDIATE: 'I', MICRO_TREND: 'M', PRICE_STRUCTURE: 'S', PULLBACK_KD: 'K' } as const;

export function TrendSignalMiniChart({ result, colors, onClose }: { result: TrendSignalResult | null; colors: ChartColors; onClose: () => void }) {
    const hostRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<IChartApi | null>(null);
    const candlesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
    const upRef = useRef<ISeriesApi<'Line'> | null>(null);
    const downRef = useRef<ISeriesApi<'Line'> | null>(null);
    const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const chart = createChart(host, {
            layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: colors.text, fontSize: 9, attributionLogo: false },
            grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
            rightPriceScale: { borderColor: colors.border },
            timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false },
            handleScroll: true,
            handleScale: true,
            autoSize: true,
        });
        const candles = chart.addSeries(CandlestickSeries, {
            upColor: colors.up, downColor: colors.down, borderUpColor: colors.up, borderDownColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down,
        });
        const line = { lineWidth: 2 as const, lineType: LineType.WithSteps, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
        upRef.current = chart.addSeries(LineSeries, { ...line, color: '#1fd286' });
        downRef.current = chart.addSeries(LineSeries, { ...line, color: '#ff4d6a' });
        chartRef.current = chart;
        candlesRef.current = candles;
        markersRef.current = createSeriesMarkers(candles, []);
        return () => {
            chart.remove();
            chartRef.current = null;
            candlesRef.current = null;
            upRef.current = null;
            downRef.current = null;
            markersRef.current = null;
        };
        // 主題切換由下方 effect 套用，不重建圖表
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        chartRef.current?.applyOptions({
            layout: { textColor: colors.text },
            grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
        });
        candlesRef.current?.applyOptions({ upColor: colors.up, downColor: colors.down, borderUpColor: colors.up, borderDownColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down });
    }, [colors]);

    useEffect(() => {
        const candles = candlesRef.current;
        if (!candles || !result) return;
        const bars = result.m1.bars;
        const from = Math.max(0, bars.length - BARS);
        const view = bars.slice(from);
        candles.setData(view.map((b) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close })));
        const up = [];
        const down = [];
        for (let i = from; i < bars.length; i++) {
            const t = bars[i]!.time as UTCTimestamp;
            const v = result.t1.line[i];
            const d = result.t1.dir[i];
            up.push(v !== undefined && d === 'UP' ? { time: t, value: v } : { time: t });
            down.push(v !== undefined && d === 'DOWN' ? { time: t, value: v } : { time: t });
        }
        upRef.current?.setData(up);
        downRef.current?.setData(down);
        const first = view[0]?.time ?? Infinity;
        const times = new Set(view.map((b) => b.time));
        const markers: SeriesMarker<Time>[] = [];
        for (const sig of result.signals) {
            if (sig.barTime < first || !times.has(sig.barTime)) continue;
            const long = sig.direction === 'LONG';
            markers.push({ time: sig.barTime as UTCTimestamp, position: long ? 'belowBar' : 'aboveBar', shape: long ? 'arrowUp' : 'arrowDown', color: long ? '#1fd286' : '#ff4d6a', text: `5m ${sig.kind}` });
        }
        for (const e of result.entries) {
            if (e.status !== 'TRIGGERED' || e.barTime === null || e.mode === 'IMMEDIATE' || !times.has(e.barTime)) continue;
            const long = e.direction === 'LONG';
            markers.push({ time: e.barTime as UTCTimestamp, position: long ? 'belowBar' : 'aboveBar', shape: 'circle', color: '#19b6c9', text: TAG[e.mode] });
        }
        for (const t of result.trades) {
            for (const f of t.fills) {
                if (!times.has(f.time)) continue;
                markers.push({ time: f.time as UTCTimestamp, position: t.direction === 'LONG' ? 'aboveBar' : 'belowBar', shape: 'square', color: '#8b94a7', text: exitText(f.reason) });
            }
        }
        markers.sort((a, b) => (a.time as number) - (b.time as number));
        markersRef.current?.setMarkers(markers);
    }, [result]);

    return (
        <div className={s.miniColumn}>
            <div className={s.miniHeader}>
                <span className={s.headerTitle}>1m 微型趨勢（SuperTrend）· M 微型 S 結構（立即＝5m 箭頭）</span>
                <button className={s.btn} onClick={onClose} title='關閉 1m 小圖'>×</button>
            </div>
            <div ref={hostRef} className={s.miniHost} />
        </div>
    );
}
