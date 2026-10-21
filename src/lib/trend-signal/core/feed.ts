// src/lib/trend-signal/core/feed.ts — 即時資料的「已收」判定與凍結（canonical 1m 的資料面）。
// 一根 1m 能否確認，看資料有沒有涵蓋它，不看牆鐘：
//   - 伺服器歷史：原始請求時刻 − 10 秒以前的分鐘以伺服器為準（共用快取時用當初的請求時刻）
//   - 逐筆成交：連續接收期間，從接收起點到最後一筆成交的交易所時間為止都已收到
//     心跳只有本機接收時間，不能證明尚在佇列中的行情已送達；安靜市場改由歷史補抓確認
//   - 斷線重連或暫停接收：逐筆涵蓋重新起算；缺口與兩端只收到部分成交的分鐘
//     都要等重抓的伺服器歷史涵蓋後才能確認，期間 asOf 不前進
// 一旦確認（commit）就凍結：之後晚到的成交、重抓的歷史都不再改寫已確認的分鐘，
// 已出現的訊號因此不會因資料更新而改變。

import type { SecurityType } from '../../types/contract';
import type { Candle } from '../../types/market';
import { composeBars, mergeTick, type TickLike } from './live';
import { isRegularMinute } from './session';

/** 伺服器歷史請求時刻的保守寬限（秒）：送達延遲與時鐘偏差 */
export const FEED_GRACE_SEC = 10;
/** 安靜市場的分鐘結束後等待這麼久仍沒有成交涵蓋，才補抓歷史；
 *  心跳只能證明連線健康，不用它的本機接收時間確認行情。 */
export const HEARTBEAT_WAIT_SEC = 45;

export interface FeedSnapshot {
    /** 凍結的已確認 K 棒＋其後的歷史與逐筆尾段（含尚未確認的） */
    bars: Candle[];
    /** label ≤ asOf 的 1m 已確認（資料完整且不再改變） */
    asOf: number;
    /** 進行中的 1m（之前沒有待確認的分鐘時才有） */
    live: Candle | null;
    /** 第一個還無法確認的正規分鐘（label）；沒有為 null */
    pendingFrom: number | null;
    /** 何時起重抓歷史可以推進確認（牆鐘秒）；不需要為 null */
    historyWantedAt: number | null;
    /** 因所屬分鐘已確認（或比尾段更舊）而忽略的成交筆數 */
    lateTicks: number;
}

export class LiveFeed {
    private history: Candle[] = [];
    private historyAsOf = Number.NEGATIVE_INFINITY;
    private tail: Candle[] = [];
    private frozen: Candle[] = [];
    private frozenThrough = Number.NEGATIVE_INFINITY;
    private late = 0;
    private epoch: number | null = null;
    /** 本次連線的逐筆涵蓋區間 [coverFrom, alive] */
    private coverFrom = Number.POSITIVE_INFINITY;
    private alive = Number.NEGATIVE_INFINITY;

    constructor(private readonly secType: SecurityType) {}

    /** epoch 改變＝曾斷線重連，逐筆涵蓋從 now 重新起算。
     *  heartbeatAt 保留舊呼叫介面，但接收時間不是行情水位，不能推進確認。 */
    observe(epoch: number, _heartbeatAt: number | null, now: number): void {
        if (this.epoch !== epoch) {
            this.epoch = epoch;
            this.coverFrom = now;
            this.alive = now;
        }
    }

    /** 停用指標會移除逐筆 listener；即使底層 SSE 沒重連，重新啟用也不能跨過漏收區間。
     *  已確認的資料保留，未確認尾段等待伺服器補齊。 */
    pause(): void {
        this.epoch = null;
        this.coverFrom = Number.POSITIVE_INFINITY;
        this.alive = Number.NEGATIVE_INFINITY;
    }

    /** 一筆成交。所屬分鐘已確認（或比尾段最後一根更舊）就忽略並計數，不改寫已收 K 棒。 */
    onTick(tick: TickLike, epoch: number, now: number): void {
        this.observe(epoch, null, now);
        const label = Math.floor(tick.time / 60) * 60 + 60;
        if (label <= this.frozenThrough) {
            this.late++;
            return;
        }
        const before = this.tail;
        this.tail = mergeTick(this.tail, this.history[this.history.length - 1], tick);
        if (this.tail === before) {
            this.late++;
            return;
        }
        if (tick.time >= this.coverFrom) this.alive = Math.max(this.alive, tick.time);
    }

    /** 伺服器 1m 歷史。requestedAt：這份資料的原始請求時刻（牆鐘秒）。patch：只涵蓋近期，
     *  取代該範圍起點以後的歷史。已確認的分鐘一律以凍結版本為準。 */
    setHistory(bars: Candle[], requestedAt: number, patch = false): void {
        const coveredThrough = requestedAt - FEED_GRACE_SEC;
        // full refresh 與 patch 可反向完成；舊 payload 不能沿用較新的涵蓋水位。
        if (coveredThrough < this.historyAsOf) return;
        if (patch && this.history.length > 0) {
            const first = bars[0]?.time ?? Number.POSITIVE_INFINITY;
            this.history = this.history.filter((b) => b.time < first).concat(bars);
        } else {
            this.history = bars;
        }
        this.historyAsOf = coveredThrough;
        // 伺服器涵蓋到的分鐘以伺服器為準；之後的分鐘保留逐筆組出的 K 棒
        this.tail = this.tail.filter((b) => b.time > this.historyAsOf);
    }

    private compose(): Candle[] {
        const t = this.frozenThrough;
        return this.frozen.concat(composeBars(this.history.filter((b) => b.time > t), this.tail.filter((b) => b.time > t)));
    }

    /** 逐筆涵蓋：這一分鐘（label − 60 到 label）全在本次連線的涵蓋區間內 */
    private tickCovered(label: number): boolean {
        return label - 60 >= this.coverFrom && label <= this.alive;
    }

    snapshot(now: number): FeedSnapshot {
        const bars = this.compose();
        const horizon = Math.max(this.historyAsOf, this.alive);
        let asOf = Math.max(this.frozenThrough, this.historyAsOf);
        // 商品切換時 React 當輪 effect 可能仍有舊 historyVer；新 feed 尚無歷史不能從 −Infinity 掃描。
        if (!Number.isFinite(asOf)) return { bars, asOf, live: null, pendingFrom: null, historyWantedAt: null, lateTicks: this.late };
        let pendingFrom: number | null = null;
        for (let label = Math.floor(asOf / 60) * 60 + 60; label <= Math.floor(horizon / 60) * 60; label += 60) {
            if (isRegularMinute(this.secType, label) && !this.tickCovered(label)) {
                pendingFrom = label;
                break;
            }
        }
        asOf = pendingFrom === null ? Math.max(asOf, horizon) : Math.max(asOf, pendingFrom - 60);
        // 涵蓋之後的下一個正規分鐘已經結束卻還沒涵蓋：連線起點落在那一分鐘中間（逐筆永遠涵蓋不到，
        // 收完就要重抓），或連續接收中仍沒有下一筆成交涵蓋 — 一樣要等重抓的歷史。
        // 跳過休市找到下一個正規分鐘，只用牆鐘排補抓，不用它確認資料。
        if (pendingFrom === null) {
            for (let next = Math.floor(asOf / 60) * 60 + 60; next + FEED_GRACE_SEC <= now; next += 60) {
                if (!isRegularMinute(this.secType, next)) continue;
                const wait = next - 60 < this.coverFrom ? FEED_GRACE_SEC : HEARTBEAT_WAIT_SEC;
                if (next + wait <= now && !this.tickCovered(next)) pendingFrom = next;
                break;
            }
        }
        const historyWantedAt = pendingFrom !== null ? pendingFrom + FEED_GRACE_SEC : null;
        // 進行中的 1m：必須是當前（或剛結束 10 秒內）的那一分鐘，且之前沒有待確認的分鐘；
        // 斷線時停在過去的殘缺 K 棒不算
        const last = bars[bars.length - 1];
        const current = !!last && last.time >= now - FEED_GRACE_SEC;
        const live = last && current && last.time > asOf && (pendingFrom === null || pendingFrom >= last.time) ? last : null;
        return { bars, asOf, live, pendingFrom, historyWantedAt, lateTicks: this.late };
    }

    /** 計算用過 asOf 之後呼叫：label ≤ asOf 的分鐘凍結，之後不再改變 */
    commit(asOf: number): void {
        if (!(asOf > this.frozenThrough)) return;
        this.frozen = this.compose().filter((b) => b.time <= asOf);
        this.frozenThrough = asOf;
    }
}
