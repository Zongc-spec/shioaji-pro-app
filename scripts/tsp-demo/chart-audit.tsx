// 僅供本圖 demo：用和圖表相同的 stub 1m KBars，依目前週期重算共用核心。
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { computeChartCustomTsp } from '../../src/lib/trend-signal/chart-custom';
import { runCustom, type BarsInput } from '../../src/lib/custom-runtime';
import { exitText } from '../../src/lib/trend-signal/risk/virtual';
import { aggregate, kbarsToCandles, nowWallClockUtc } from '../../src/lib/utils/kbars';
import type { Candle } from '../../src/lib/types/market';
import { fetchChartHistory } from './stubs/chart-history';

const OFFSET_SECONDS = 8 * 60 * 60;
const money = (value: number) => `NT$${Math.round(value).toLocaleString('en-US')}`;
const price = (value: number | null | undefined) => value == null || !Number.isFinite(value)
    ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
const wallTime = (value: number | null | undefined) => value == null || !Number.isFinite(value)
    ? '—' : new Date(value * 1000).toISOString().slice(0, 16).replace('T', ' ');

interface Props {
    timeframe: string;
    minutes: number;
    params: Record<string, number>;
    source: string;
    budgetOverride?: number;
}

function asInput(candles: Candle[]): BarsInput {
    return {
        time: candles.map((c) => c.time), open: candles.map((c) => c.open),
        high: candles.map((c) => c.high), low: candles.map((c) => c.low),
        close: candles.map((c) => c.close), volume: candles.map((c) => c.volume),
    };
}

export function ChartAudit({ timeframe, minutes, params, source, budgetOverride }: Props) {
    const [candles, setCandles] = useState<Candle[] | null>(null);
    const [loadError, setLoadError] = useState('');
    useEffect(() => {
        let active = true;
        fetchChartHistory().then((kbars) => {
            if (active) setCandles(kbarsToCandles(kbars));
        }).catch((error: unknown) => {
            if (active) setLoadError(error instanceof Error ? error.message : String(error));
        });
        return () => { active = false; };
    }, []);

    const audit = useMemo(() => {
        if (!candles) return null;
        try {
            const chart = aggregate(candles, minutes);
            const bars = asInput(chart);
            const apiParams = { ...params, chartTf: minutes };
            const now = nowWallClockUtc();
            const direct = computeChartCustomTsp(bars, apiParams, now);
            // runCustom executes the actual self-contained official custom script.
            // Freeze the demo clock only for this synchronous call so both paths share the same asOf.
            const previousNow = Date.now;
            let runtime: ReturnType<typeof runCustom>;
            try {
                Date.now = () => (now - OFFSET_SECONDS) * 1000;
                runtime = runCustom(source, bars, apiParams);
            } finally {
                Date.now = previousNow;
            }
            const sameOrder = !runtime.error && direct.order.length === 19 && runtime.order.length === 19 &&
                direct.order.every((key, index) => runtime.order[index] === key);
            const sameSeries = sameOrder && direct.order.every((key) => {
                const expected = direct.outputs[key];
                const actual = runtime.outputs[key];
                return !!expected && !!actual && expected.length === actual.length &&
                    expected.every((value, index) => Object.is(value, actual[index]));
            });
            const sameHints = sameOrder && direct.order.every((key) => {
                const expected = direct.hints[key];
                const actual = runtime.hints[key];
                return !!expected && !!actual && expected.kind === actual.kind &&
                    expected.color === actual.color && expected.width === actual.width;
            });
            const lastBar = chart.at(-1) ?? null;
            const openTrade = [...direct.result.trades].reverse().find((trade) => trade.status === 'OPEN') ?? null;
            const closed = direct.result.trades.filter((trade) => trade.status === 'CLOSED')
                .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 4);
            return { direct, runtime, sameOrder, sameSeries, sameHints, lastBar, openTrade, closed, chartBars: chart.length };
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }, [candles, minutes, params, source]);

    const open = audit && 'direct' in audit ? audit.openTrade : null;
    const styles: Record<string, CSSProperties> = {
        panel: { width: 350, flex: '0 0 350px', height: '100%', overflow: 'auto', boxSizing: 'border-box', padding: '12px 14px', background: '#0b0e14', color: '#d8dee9', borderLeft: '1px solid #293241', font: '12px/1.5 system-ui, sans-serif' },
        title: { fontSize: 15, fontWeight: 700, color: '#f4f7fb', marginBottom: 4 },
        note: { color: '#f0bd68', marginBottom: 10 },
        section: { borderTop: '1px solid #293241', paddingTop: 9, marginTop: 9 },
        label: { color: '#91a0b4' },
        row: { display: 'flex', justifyContent: 'space-between', gap: 8, margin: '3px 0' },
        card: { padding: 8, marginTop: 6, background: '#121821', border: '1px solid #293241', borderRadius: 5 },
        good: { color: '#4bd6a0', fontWeight: 700 },
        bad: { color: '#ff777e', fontWeight: 700 },
    };

    return <aside style={styles.panel} aria-label='本圖週期審計'>
        <div style={styles.title}>本圖週期審計</div>
        <div style={styles.note}>本圖 {timeframe}／合成回放／非原生 App；不是舊固定 5m 審計。</div>
        <div style={styles.row}><span style={styles.label}>計算核心</span><span>tsp-chart-1.2.0</span></div>
        <div style={styles.row}><span style={styles.label}>週期／資料列</span><span>{timeframe}／{audit && 'chartBars' in audit ? audit.chartBars : '—'}</span></div>
        <div style={styles.row}><span style={styles.label}>資料來源</span><span>stub 合成 1m → 本圖聚合</span></div>
        <div style={styles.row}><span style={styles.label}>本圖末棒</span><span>{audit && 'lastBar' in audit ? wallTime(audit.lastBar?.time) : '—'}</span></div>
        <div style={styles.row}><span style={styles.label}>虛擬風險預算</span><span>{money(budgetOverride ?? params.budget ?? 1000)}{budgetOverride !== undefined ? '（URL 測試值）' : '（預設）'}</span></div>

        <section style={styles.section}>
            <strong>虛擬部位</strong>
            {loadError && <div style={styles.bad}>載入失敗：{loadError}</div>}
            {!loadError && !candles && <div style={styles.label}>載入合成 K 棒…</div>}
            {audit && 'error' in audit && <div style={styles.bad}>計算錯誤：{audit.error}</div>}
            {audit && 'direct' in audit && open && <div style={styles.card}>
                <div style={{ ...styles.row, fontWeight: 700 }}>
                    <span style={open.direction === 'LONG' ? styles.good : styles.bad}>{open.direction === 'LONG' ? '多單' : '空單'} {open.openQty}/{open.qty} 口</span>
                    <span>持有中（虛擬）</span>
                </div>
                <div style={styles.row}><span style={styles.label}>進場</span><span>{wallTime(open.fillAt)} @ {price(open.fillPrice)}</span></div>
                <div style={styles.row}><span style={styles.label}>初始／目前停損</span><span>{price(open.plan.stop)}／{price(open.stop)}</span></div>
                <div style={styles.row}><span style={styles.label}>保本停損</span><span>{price(open.plan.breakevenStop)}</span></div>
                <div style={styles.row}><span style={styles.label}>R1／R2／R3</span><span>{price(open.plan.r1)}／{price(open.plan.r2)}／{price(open.plan.r3)}</span></div>
                <div style={styles.row}><span style={styles.label}>出場費稅／淨損益</span><span>未平倉，尚未結算</span></div>
            </div>}
            {audit && 'direct' in audit && !open && <div style={styles.card}>目前無未平倉虛擬部位；資料暖身或本圖條件不足時會維持空手。</div>}
        </section>

        <section style={styles.section}>
            <strong>近期已平倉（合成虛擬結果）</strong>
            {audit && 'direct' in audit && audit.closed.length === 0 && <div style={styles.label}>尚無已平倉部位。</div>}
            {audit && 'direct' in audit && audit.closed.map((trade) => <div key={trade.id} style={styles.card}>
                <div style={styles.row}>
                    <span>{trade.direction === 'LONG' ? '多' : '空'} {trade.qty}口 · {wallTime(trade.fillAt)}</span>
                    <strong>{trade.exitReason ? exitText(trade.exitReason).replace('5m', '本圖') : '出場'}</strong>
                </div>
                <div style={styles.row}><span style={styles.label}>出場時間／成本</span><span>{wallTime(trade.closedAt)}／{money(trade.costNtd)}</span></div>
                <div style={styles.row}><span style={styles.label}>成本後已實現損益（虛擬）</span><strong style={trade.realizedNtd >= 0 ? styles.good : styles.bad}>{money(trade.realizedNtd)}</strong></div>
            </div>)}
        </section>

        <section style={styles.section}>
            <strong>新版單檔 vs 直接核心</strong>
            {audit && 'direct' in audit && <>
                <div style={styles.row}><span style={styles.label}>輸出數列</span><span>{audit.runtime.order.length}／19</span></div>
                <div style={styles.row}><span style={styles.label}>順序／值逐項一致</span><span style={audit.sameOrder && audit.sameSeries ? styles.good : styles.bad}>{audit.sameOrder && audit.sameSeries ? '一致' : '不一致'}</span></div>
                <div style={styles.row}><span style={styles.label}>plot hints（含 width）</span><span style={audit.sameHints ? styles.good : styles.bad}>{audit.sameHints ? '一致' : '不一致'}</span></div>
                {audit.runtime.error && <div style={styles.bad}>單檔錯誤：{audit.runtime.error}</div>}
            </>}
        </section>
        <div style={{ ...styles.section, ...styles.label }}>僅使用此 demo 的合成資料。風控、費稅及損益均為虛擬計算，不是績效或交易建議。</div>
    </aside>;
}
