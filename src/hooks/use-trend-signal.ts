// src/hooks/use-trend-signal.ts — Trend Signal Pro 的資料來源：固定 20 天的 1m 歷史
// （chart-history 快取，與主圖同一條 kbars 路徑）＋ SSE 逐筆成交組即時 1m。
// 「已收」由 core/feed.ts 依資料涵蓋判定（伺服器歷史的原始請求時刻、連續接收期間的交易所成交時間），
// 不靠牆鐘；斷線重連、累計成交量對不上或缺分鐘時，從第一個待補分鐘的前一天起補抓歷史（不進共用快取），
// 涵蓋後才確認。已確認的分鐘凍結，晚到的成交與「更新歷史」都不改寫。只讀行情，不碰任何下單路徑。

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { fetchChartHistoryFresh, fetchChartHistoryStamped } from '../lib/chart-history';
import { getStreamStatus, onAnyTick, streamConnectionEpoch, subscribeStatusStore, type StreamStatus } from '../lib/stream';
import { configFromParams } from '../lib/trend-signal/config';
import { LiveFeed } from '../lib/trend-signal/core/feed';
import { wallDate } from '../lib/trend-signal/core/session';
import { runTrendSignal } from '../lib/trend-signal/engine';
import type { TrendSignalResult } from '../lib/trend-signal/types';
import type { ContractBase, ContractInfo } from '../lib/types/contract';
import { futuresPointValue, futuresTaxRate } from '../lib/utils/contract-cost';
import { dateStrOffset, kbarsToCandles, msToWallClockUtc, nowWallClockUtc, wallClockToUtc } from '../lib/utils/kbars';
import { tickSizeFor } from '../lib/utils/ticksize';

/** 60m 暖身 150 根約需 8 個交易日 → 固定 20 個日曆日（與 15m 主圖同一個快取鍵） */
export const TSP_HISTORY_DAYS = 20;
/** 有虛擬部位或待成交進場時，盤中 tick 最多每 2 秒重算一次 */
const LIVE_RECOMPUTE_MS = 2000;
/** 補抓近期歷史（等資料補齊）的最短間隔 */
const PATCH_MIN_INTERVAL_MS = 15_000;

export interface TrendSignalFeed {
    result: TrendSignalResult | null;
    stream: StreamStatus;
    loading: boolean;
    error: boolean;
    /** 第一個還無法確認的 1m（等資料補齊）；沒有為 null */
    pendingFrom: number | null;
    /** 確認進度落後牆鐘的秒數 */
    confirmLagSec: number;
    /** 所屬分鐘已確認而忽略的晚到成交筆數 */
    lateTicks: number;
    /** 累計成交量對不上（中間有成交沒收到）而改等歷史補齊的次數 */
    streamGaps: number;
}

interface FeedInfo {
    pendingFrom: number | null;
    confirmLagSec: number;
    lateTicks: number;
    streamGaps: number;
}
const NO_INFO: FeedInfo = { pendingFrom: null, confirmLagSec: 0, lateTicks: 0, streamGaps: 0 };

export function useTrendSignal(
    contract: ContractBase,
    enabled: boolean,
    params: Record<string, number>,
    historySeq: number,
): TrendSignalFeed {
    // 直接讀 stream 狀態 store（主圖的 useQuote 已負責啟動串流）
    const stream = useSyncExternalStore(subscribeStatusStore, getStreamStatus);
    const [historyVer, setHistoryVer] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const [result, setResult] = useState<TrendSignalResult | null>(null);
    const [info, setInfo] = useState<FeedInfo>(NO_INFO);
    const feedRef = useRef<{ code: string; feed: LiveFeed } | null>(null);
    const lastPriceRef = useRef<number | null>(null);
    const tickSeqRef = useRef(0);
    const doneRef = useRef({ minute: -1, tickSeq: -1, at: 0, inputs: '' });
    const resultRef = useRef<TrendSignalResult | null>(null);
    const infoRef = useRef<FeedInfo>(NO_INFO);
    const patchRef = useRef({ inFlight: false, at: 0 });
    const paramsKey = JSON.stringify(params);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    const config = useMemo(() => configFromParams(params), [paramsKey]);
    const code = contract.code;
    const getFeed = () => {
        if (feedRef.current?.code !== code) feedRef.current = { code, feed: new LiveFeed(contract.security_type) };
        return feedRef.current.feed;
    };

    // 換商品：資料、凍結狀態與結果一律重來
    useEffect(() => {
        feedRef.current = null;
        lastPriceRef.current = null;
        resultRef.current = null;
        infoRef.current = NO_INFO;
        patchRef.current = { inFlight: false, at: 0 };
        setResult(null);
        setInfo(NO_INFO);
        setHistoryVer(0);
    }, [code]);

    useEffect(() => {
        if (!enabled) return;
        let cancelled = false;
        setLoading(true);
        setError(false);
        fetchChartHistoryStamped(contract, dateStrOffset(TSP_HISTORY_DAYS), dateStrOffset(0), { revision: historySeq, timeoutMs: 30_000 })
            .then(({ kbars, requestedAt }) => {
                if (cancelled) return;
                getFeed().setHistory(kbarsToCandles(kbars), msToWallClockUtc(requestedAt));
                setHistoryVer((v) => v + 1);
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
        // getFeed 依 code 取得同一個 feed
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contract, enabled, historySeq]);

    useEffect(() => {
        if (!enabled) return;
        const feed = getFeed();
        feed.observe(streamConnectionEpoch(), nowWallClockUtc());
        const unsubscribe = onAnyTick((tick) => {
            if (tick.code !== code || tick.simtrade || tick.intraday_odd) return;
            const time = wallClockToUtc(`${tick.date}T${tick.time}`);
            const price = Number(tick.close);
            if (!Number.isFinite(time) || !Number.isFinite(price) || price <= 0) return;
            feed.onTick({ time, price, volume: tick.volume, totalVolume: tick.total_volume }, streamConnectionEpoch(), nowWallClockUtc());
            lastPriceRef.current = price;
            tickSeqRef.current += 1;
        });
        return () => {
            unsubscribe();
            feed.pause();
            // 接收生命週期結束後，舊補抓不再有寫入或釋放新請求的權限。
            patchRef.current = { inFlight: false, at: 0 };
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [code, enabled]);

    useEffect(() => {
        if (!enabled || historyVer === 0) return;
        const inputs = `${code}|${paramsKey}|${historyVer}`;
        const compute = () => {
            const feed = getFeed();
            const now = nowWallClockUtc();
            feed.observe(streamConnectionEpoch(), now);
            const s = feed.snapshot(now);
            if (!Number.isFinite(s.asOf)) return;
            // 有分鐘等資料補齊：補抓歷史（節流；失敗下一輪再試）
            const patch = patchRef.current;
            if (s.historyWantedAt !== null && now >= s.historyWantedAt && !patch.inFlight && Date.now() - patch.at >= PATCH_MIN_INTERVAL_MS) {
                const request = { inFlight: true, at: Date.now() };
                patchRef.current = request;
                // 從第一個待補分鐘的前一天抓起：隱藏指標或斷線超過一天也補得回來（最多到 20 天歷史的起點）。
                // 每次都是新請求、不進共用快取，安靜時段反覆補抓也不會擠掉主圖與 20 天歷史的快取
                const from = Math.max((s.pendingFrom ?? now) - 86_400, now - TSP_HISTORY_DAYS * 86_400);
                fetchChartHistoryFresh(contract, wallDate(from), dateStrOffset(0), { timeoutMs: 30_000 })
                    .then(({ kbars, requestedAt }) => {
                        // 同商品的 historyVer／參數重算不會取消仍有效的補抓；停用或換商品才撤銷 record。
                        if (patchRef.current === request) feed.setHistory(kbarsToCandles(kbars), msToWallClockUtc(requestedAt), true);
                    })
                    .catch(() => undefined)
                    .finally(() => {
                        if (patchRef.current === request) patchRef.current = { ...request, inFlight: false };
                    });
            }
            const nextInfo: FeedInfo = { pendingFrom: s.pendingFrom, confirmLagSec: Math.max(0, now - s.asOf), lateTicks: s.lateTicks, streamGaps: s.streamGaps };
            const pi = infoRef.current;
            // 落後秒數只在跨過徽章門檻（180 秒）附近才需要更新畫面
            if (pi.pendingFrom !== nextInfo.pendingFrom || pi.lateTicks !== nextInfo.lateTicks || pi.streamGaps !== nextInfo.streamGaps || (pi.confirmLagSec > 180) !== (nextInfo.confirmLagSec > 180) || (nextInfo.confirmLagSec > 180 && Math.abs(pi.confirmLagSec - nextInfo.confirmLagSec) >= 10)) {
                infoRef.current = nextInfo;
                setInfo(nextInfo);
            }
            const minute = Math.floor(s.asOf / 60);
            const done = doneRef.current;
            const prev = resultRef.current;
            // 進行中的 K 棒只會影響虛擬部位（開盤成交、停損觸價）；沒有部位時只在確認新的一分鐘時重算
            const liveMatters = !!prev && (prev.snapshot.pendingEntry !== null || prev.snapshot.trade?.status === 'OPEN');
            const nowMs = Date.now();
            const fresh = done.inputs !== inputs || minute !== done.minute;
            const liveDue = liveMatters && tickSeqRef.current !== done.tickSeq && nowMs - done.at >= LIVE_RECOMPUTE_MS;
            if (!fresh && !liveDue) return;
            if (s.bars.length === 0) return;
            const last = s.bars[s.bars.length - 1]!;
            const c = contract as ContractBase & Partial<ContractInfo>;
            const res = runTrendSignal({
                bars1m: s.bars,
                live: s.live,
                asOf: s.asOf,
                securityType: contract.security_type,
                symbol: contract.code,
                contractMonth: c.delivery_month ?? contract.target_code ?? contract.code,
                tick: tickSizeFor(c, lastPriceRef.current ?? last.close),
                pointValue: futuresPointValue(c),
                taxRate: contract.security_type === 'FUT' ? futuresTaxRate(c.root ?? c.category ?? '') : 0,
                config,
            });
            feed.commit(s.asOf);
            doneRef.current = { minute, tickSeq: tickSeqRef.current, at: nowMs, inputs };
            resultRef.current = res;
            setResult(res);
        };
        compute();
        const id = setInterval(compute, 1000);
        return () => {
            clearInterval(id);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [enabled, historyVer, config, contract, code, paramsKey]);

    return {
        result: enabled ? result : null,
        stream,
        loading,
        error,
        pendingFrom: enabled ? info.pendingFrom : null,
        confirmLagSec: enabled ? info.confirmLagSec : 0,
        lateTicks: enabled ? info.lateTicks : 0,
        streamGaps: enabled ? info.streamGaps : 0,
    };
}
