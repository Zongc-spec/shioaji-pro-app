// src/hooks/use-trend-signal.ts — Trend Signal Pro 的資料來源：固定 20 天的 1m 歷史
// （chart-history 快取，與主圖同一條 kbars 路徑）＋ SSE 逐筆成交組即時 1m。
// asOf = max(最後一筆成交的交易所時間, 本機牆鐘 − 10 秒)：label ≤ asOf 的 1m 才算已收。
// 只讀行情，不碰任何下單路徑。

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { fetchChartHistory } from '../lib/chart-history';
import { getStreamStatus, onAnyTick, subscribeStatusStore, type StreamStatus } from '../lib/stream';
import { configFromParams } from '../lib/trend-signal/config';
import { composeBars, mergeTick, rebaseTail } from '../lib/trend-signal/core/live';
import { runTrendSignal } from '../lib/trend-signal/engine';
import type { TrendSignalResult } from '../lib/trend-signal/types';
import type { ContractBase, ContractInfo } from '../lib/types/contract';
import type { Candle } from '../lib/types/market';
import { futuresPointValue, futuresTaxRate } from '../lib/utils/contract-cost';
import { dateStrOffset, kbarsToCandles, nowWallClockUtc, wallClockToUtc } from '../lib/utils/kbars';
import { tickSizeFor } from '../lib/utils/ticksize';

/** 60m 暖身 150 根約需 8 個交易日 → 固定 20 個日曆日（與 15m 主圖同一個快取鍵） */
export const TSP_HISTORY_DAYS = 20;
/** 沒有新成交時，本機牆鐘過了 label + 10 秒才把那分鐘當已收（容許時鐘偏差與送達延遲） */
const CONFIRM_GRACE_SEC = 10;
/** 有虛擬部位或待成交進場時，盤中 tick 最多每 2 秒重算一次 */
const LIVE_RECOMPUTE_MS = 2000;

export interface TrendSignalFeed {
    result: TrendSignalResult | null;
    stream: StreamStatus;
    loading: boolean;
    error: boolean;
}

export function useTrendSignal(
    contract: ContractBase,
    enabled: boolean,
    params: Record<string, number>,
    historySeq: number,
): TrendSignalFeed {
    // 直接讀 stream 狀態 store（主圖的 useQuote 已負責啟動串流）
    const stream = useSyncExternalStore(subscribeStatusStore, getStreamStatus);
    const [history, setHistory] = useState<Candle[] | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const [result, setResult] = useState<TrendSignalResult | null>(null);
    const historyRef = useRef<Candle[]>([]);
    const tailRef = useRef<Candle[]>([]);
    const lastTickRef = useRef<{ time: number; price: number } | null>(null);
    const tickSeqRef = useRef(0);
    const doneRef = useRef({ minute: -1, tickSeq: -1, at: 0, inputs: '' });
    const resultRef = useRef<TrendSignalResult | null>(null);
    const paramsKey = JSON.stringify(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const config = useMemo(() => configFromParams(params), [paramsKey]);
    const code = contract.code;

    // 換商品：即時尾段與結果一律重來
    useEffect(() => {
        tailRef.current = [];
        lastTickRef.current = null;
        historyRef.current = [];
        resultRef.current = null;
        setHistory(null);
        setResult(null);
    }, [code]);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        setLoading(true);
        setError(false);
        fetchChartHistory(contract, dateStrOffset(TSP_HISTORY_DAYS), dateStrOffset(0), { revision: historySeq, timeoutMs: 30_000 })
            .then((k) => {
                if (cancelled) return;
                const bars = kbarsToCandles(k);
                historyRef.current = bars;
                tailRef.current = rebaseTail(tailRef.current, bars);
                setHistory(bars);
            })
            .catch(() => {
                if (!cancelled) setError(true);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [contract, enabled, historySeq]);

    useEffect(() => {
        if (!enabled) return;
        return onAnyTick((tick) => {
            if (tick.code !== code || tick.simtrade || tick.intraday_odd) return;
            const time = wallClockToUtc(`${tick.date}T${tick.time}`);
            const price = Number(tick.close);
            if (!Number.isFinite(time) || !Number.isFinite(price) || price <= 0) return;
            const hist = historyRef.current;
            tailRef.current = mergeTick(tailRef.current, hist[hist.length - 1], { time, price, volume: tick.volume });
            if (!lastTickRef.current || time >= lastTickRef.current.time) lastTickRef.current = { time, price };
            tickSeqRef.current += 1;
        });
    }, [code, enabled]);

    useEffect(() => {
        if (!enabled || history === null) return;
        const inputs = `${code}|${paramsKey}|${history.length}|${history[history.length - 1]?.time ?? 0}`;
        const compute = () => {
            const lt = lastTickRef.current;
            const asOf = Math.max(lt?.time ?? -Infinity, nowWallClockUtc() - CONFIRM_GRACE_SEC);
            const minute = Math.floor(asOf / 60);
            const done = doneRef.current;
            const prev = resultRef.current;
            // 進行中的 K 棒只會影響虛擬部位（開盤成交、停損觸價）；沒有部位時只在跨分鐘重算
            const liveMatters = !!prev && (prev.snapshot.pendingEntry !== null || prev.snapshot.trade?.status === 'OPEN');
            const now = Date.now();
            const fresh = done.inputs !== inputs || minute !== done.minute;
            const liveDue = liveMatters && tickSeqRef.current !== done.tickSeq && now - done.at >= LIVE_RECOMPUTE_MS;
            if (!fresh && !liveDue) return;
            const bars = composeBars(historyRef.current, tailRef.current);
            if (bars.length === 0) return;
            const last = bars[bars.length - 1]!;
            const c = contract as ContractBase & Partial<ContractInfo>;
            const res = runTrendSignal({
                bars1m: bars,
                live: last.time > asOf ? last : null,
                asOf,
                securityType: contract.security_type,
                symbol: contract.code,
                contractMonth: c.delivery_month ?? contract.target_code ?? contract.code,
                tick: tickSizeFor(c, lt?.price ?? last.close),
                pointValue: futuresPointValue(c),
                taxRate: contract.security_type === 'FUT' ? futuresTaxRate(c.root ?? c.category ?? '') : 0,
                config,
            });
            doneRef.current = { minute, tickSeq: tickSeqRef.current, at: now, inputs };
            resultRef.current = res;
            setResult(res);
        };
        compute();
        const id = setInterval(compute, 1000);
        return () => clearInterval(id);
    }, [enabled, history, config, contract, code, paramsKey]);

    return { result: enabled ? result : null, stream, loading, error };
}
