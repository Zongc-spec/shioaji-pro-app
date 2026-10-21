// 僅供 demo：用和圖表相同的 stub 1m KBars，依目前主圖週期跑 App 單檔的同一個分派（app-custom.ts）。
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { APP_TSP_VERSION, computeAppCustomTsp } from '../../src/lib/trend-signal/app-custom';
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
            const direct = computeAppCustomTsp(bars, apiParams, now);
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
            const trades = direct.result?.trades ?? [];
            const openTrade = [...trades].reverse().find((trade) => trade.status === 'OPEN') ?? null;
            const closed = trades.filter((trade) => trade.status === 'CLOSED')
                .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).slice(0, 4);
            return { kind: 'ok' as const, direct, runtime, sameOrder, sameSeries, sameHints, lastBar, openTrade, closed, chartBars: chart.length, mode: direct.mode };
        } catch (error) {
            return { kind: 'error' as const, error: error instanceof Error ? error.message : String(error) };
        }
    }, [candles, minutes, params, source]);

    // 判別欄位收窄：成功與錯誤兩種結果
    const ok = audit?.kind === 'ok' ? audit : null;
    const open = ok ? ok.openTrade : null;
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

    const modeText = { model: '原模型（5m 主趨勢＋1m 精準進出場）', m5: '5m 主趨勢、5m 收棒進出場（停損以 5m 近似）', aux: '高週期輔助：只畫趨勢線' } as const;
    return <aside style={styles.panel} aria-label='App 單檔審計'>
        <div style={styles.title}>App 單檔審計</div>
        <div style={styles.note}>主圖 {timeframe}／合成回放／非原生 App。</div>
        <div style={styles.row}><span style={styles.label}>計算方式</span><span>{ok ? modeText[ok.mode] : '—'}</span></div>
        <div style={styles.row}><span style={styles.label}>版本</span><span>{APP_TSP_VERSION}</span></div>
        <div style={styles.row}><span style={styles.label}>週期／資料列</span><span>{timeframe}／{ok ? ok.chartBars : '—'}</span></div>
        <div style={styles.row}><span style={styles.label}>資料來源</span><span>stub 合成 1m → 本圖聚合</span></div>
        <div style={styles.row}><span style={styles.label}>本圖末棒</span><span>{ok ? wallTime(ok.lastBar?.time) : '—'}</span></div>
        <div style={styles.row}><span style={styles.label}>虛擬風險預算</span><span>{money(budgetOverride ?? params.budget ?? 1000)}{budgetOverride !== undefined ? '（URL 測試值）' : '（預設）'}</span></div>

        <section style={styles.section}>
            <strong>虛擬部位</strong>
            {loadError && <div style={styles.bad}>載入失敗：{loadError}</div>}
            {!loadError && !candles && <div style={styles.label}>載入合成 K 棒…</div>}
            {audit?.kind === 'error' && <div style={styles.bad}>計算錯誤：{audit.error}</div>}
            {ok && open && <div style={styles.card}>
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
            {ok && !open && <div style={styles.card}>{ok.mode === 'aux' ? '高週期只畫趨勢線，不建立虛擬部位；進出場請看 1m 或 5m 主圖。' : '目前無未平倉虛擬部位；資料暖身或條件不足時會維持空手。'}</div>}
        </section>

        <section style={styles.section}>
            <strong>近期已平倉（合成虛擬結果）</strong>
            {ok && ok.closed.length === 0 && <div style={styles.label}>尚無已平倉部位。</div>}
            {ok && ok.closed.map((trade) => <div key={trade.id} style={styles.card}>
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
            {ok && <>
                <div style={styles.row}><span style={styles.label}>輸出數列</span><span>{ok.runtime.order.length}／19</span></div>
                <div style={styles.row}><span style={styles.label}>順序／值逐項一致</span><span style={ok.sameOrder && ok.sameSeries ? styles.good : styles.bad}>{ok.sameOrder && ok.sameSeries ? '一致' : '不一致'}</span></div>
                <div style={styles.row}><span style={styles.label}>plot hints（含 width）</span><span style={ok.sameHints ? styles.good : styles.bad}>{ok.sameHints ? '一致' : '不一致'}</span></div>
                {ok.runtime.error && <div style={styles.bad}>單檔錯誤：{ok.runtime.error}</div>}
            </>}
        </section>
        <div style={{ ...styles.section, ...styles.label }}>僅使用此 demo 的合成資料。風控、費稅及損益均為虛擬計算，不是績效或交易建議。</div>
    </aside>;
}
